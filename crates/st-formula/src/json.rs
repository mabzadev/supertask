//! `JSON.parse`.
//!
//! The engine parses JSON text found in cells (`'[1, 2]'` is an array to every
//! function), so parsing must agree with JavaScript: numbers rounded exactly
//! (`serde_json` is only exact with a feature that would change every crate of
//! the workspace), `1e400` read as `Infinity`, `-0` kept, lone surrogate
//! escapes accepted, and nesting handled without recursion.
//!
//! One deliberate difference: nesting deeper than [`MAX_DEPTH`] is refused
//! (the text stays text). V8 accepts more, but values are cloned, compared
//! and dropped recursively, and a cell should not be able to exhaust the stack.

use crate::value::{Object, Value};

/// The deepest nesting of arrays and objects accepted.
pub(crate) const MAX_DEPTH: usize = 512;

/// A container being filled.
enum Frame {
    Array(Vec<Value>),
    Object(Object, String),
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    position: usize,
}

impl Parser<'_> {
    fn skip_whitespace(&mut self) {
        while matches!(
            self.bytes.get(self.position),
            Some(b' ' | b'\t' | b'\n' | b'\r')
        ) {
            self.position += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn keyword(&mut self, word: &str, value: Value) -> Option<Value> {
        if self.text[self.position..].starts_with(word) {
            self.position += word.len();
            Some(value)
        } else {
            None
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.position;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.position += 1;
        }
        self.position - start
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.position;
        self.eat(b'-');
        match self.peek()? {
            b'0' => self.position += 1,
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return None,
        }
        if self.eat(b'.') && self.digits() == 0 {
            return None;
        }
        if self.eat(b'e') || self.eat(b'E') {
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if self.digits() == 0 {
                return None;
            }
        }
        // Rust's parser rounds exactly and overflows to infinity, like V8.
        self.text[start..self.position]
            .parse::<f64>()
            .ok()
            .map(Value::Number)
    }

    fn hex4(&mut self) -> Option<u16> {
        let digits = self.text.get(self.position..self.position + 4)?;
        let unit = u16::from_str_radix(digits, 16)
            .ok()
            .filter(|_| digits.bytes().all(|byte| byte.is_ascii_hexdigit()))?;
        self.position += 4;
        Some(unit)
    }

    fn string(&mut self) -> Option<String> {
        if !self.eat(b'"') {
            return None;
        }
        let mut units: Vec<u16> = Vec::new();
        let mut out = String::new();
        loop {
            let start = self.position;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.position += 1;
            }
            if self.position > start {
                flush_units(&mut units, &mut out);
                out.push_str(&self.text[start..self.position]);
            }
            match self.peek()? {
                b'"' => {
                    self.position += 1;
                    flush_units(&mut units, &mut out);
                    return Some(out);
                }
                b'\\' => {
                    self.position += 1;
                    let escaped = self.peek()?;
                    self.position += 1;
                    let unit = match escaped {
                        b'"' => u16::from(b'"'),
                        b'\\' => u16::from(b'\\'),
                        b'/' => u16::from(b'/'),
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => u16::from(b'\n'),
                        b'r' => u16::from(b'\r'),
                        b't' => u16::from(b'\t'),
                        b'u' => self.hex4()?,
                        _ => return None,
                    };
                    // Escapes may encode surrogate pairs, or lone surrogates.
                    units.push(unit);
                }
                _ => return None,
            }
        }
    }
}

/// Appends pending escaped UTF-16 units; a lone surrogate becomes U+FFFD,
/// where JavaScript keeps it.
fn flush_units(units: &mut Vec<u16>, out: &mut String) {
    if !units.is_empty() {
        out.push_str(&String::from_utf16_lossy(units));
        units.clear();
    }
}

/// Parses JSON text the way `JSON.parse` does, or `None` where it throws.
pub(crate) fn parse(text: &str) -> Option<Value> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        text,
        position: 0,
    };
    let mut stack: Vec<Frame> = Vec::new();
    loop {
        parser.skip_whitespace();
        // Read a value, or open a container.
        if matches!(parser.peek(), Some(b'[' | b'{')) && stack.len() >= MAX_DEPTH {
            return None;
        }
        let mut value = match parser.peek()? {
            b'[' => {
                parser.position += 1;
                parser.skip_whitespace();
                if parser.eat(b']') {
                    Value::Array(Vec::new())
                } else {
                    stack.push(Frame::Array(Vec::new()));
                    continue;
                }
            }
            b'{' => {
                parser.position += 1;
                parser.skip_whitespace();
                if parser.eat(b'}') {
                    Value::Object(Object::new())
                } else {
                    let key = parser.string()?;
                    parser.skip_whitespace();
                    if !parser.eat(b':') {
                        return None;
                    }
                    stack.push(Frame::Object(Object::new(), key));
                    continue;
                }
            }
            b'"' => Value::Text(parser.string()?),
            b't' => parser.keyword("true", Value::Bool(true))?,
            b'f' => parser.keyword("false", Value::Bool(false))?,
            b'n' => parser.keyword("null", Value::Null)?,
            _ => parser.number()?,
        };
        // Store it, closing every container it completes.
        loop {
            let Some(frame) = stack.last_mut() else {
                parser.skip_whitespace();
                return (parser.position == text.len()).then_some(value);
            };
            parser.skip_whitespace();
            match frame {
                Frame::Array(items) => {
                    items.push(value);
                    if parser.eat(b',') {
                        break;
                    }
                    if !parser.eat(b']') {
                        return None;
                    }
                    let Some(Frame::Array(items)) = stack.pop() else {
                        return None;
                    };
                    value = Value::Array(items);
                }
                Frame::Object(object, key) => {
                    object.insert(std::mem::take(key), value);
                    if parser.eat(b',') {
                        parser.skip_whitespace();
                        *key = parser.string()?;
                        parser.skip_whitespace();
                        if !parser.eat(b':') {
                            return None;
                        }
                        break;
                    }
                    if !parser.eat(b'}') {
                        return None;
                    }
                    let Some(Frame::Object(object, _)) = stack.pop() else {
                        return None;
                    };
                    value = Value::Object(object);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_json_parse() {
        assert_eq!(
            parse(r#" {"b": [1, -0.5e1, true, null], "a": "xé\n"} "#)
                .map(|value| crate::js::json_stringify(&value)),
            Some(r#"{"b":[1,-5,true,null],"a":"xé\n"}"#.to_owned())
        );
        assert_eq!(
            parse("12.182493960703473"),
            Some(Value::Number(12.182493960703473))
        );
        assert_eq!(parse("1e400"), Some(Value::Number(f64::INFINITY)));
        assert!(
            parse("-0")
                .and_then(|value| value.as_f64())
                .is_some_and(|number| number.is_sign_negative())
        );
        assert_eq!(parse(r#""😀""#), Some(Value::from("😀")));
        assert_eq!(parse(r#""\ud83d""#), Some(Value::from("\u{fffd}")));
        assert_eq!(
            parse(r#"{"a":1,"a":2}"#).map(|value| crate::js::json_stringify(&value)),
            Some(r#"{"a":2}"#.to_owned())
        );
        for invalid in [
            "", "[1,]", "{\"a\"}", "01", "1.", ".5", "[1] x", "'a'", "\"\t\"", "nul", "{,}", "[",
            "-",
        ] {
            assert_eq!(parse(invalid), None, "{invalid:?}");
        }
    }

    #[test]
    fn nesting_is_capped() {
        let nested = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert!(parse(&nested(MAX_DEPTH)).is_some());
        assert!(parse(&nested(MAX_DEPTH + 1)).is_none());
        assert!(parse(&nested(1_000_000)).is_none());
    }
}
