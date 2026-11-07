//! `JSON.stringify` and `JSON.parse` as V8 does them.
//!
//! serde_json gets three things wrong for byte-identical output: it prints
//! floats in Rust notation (`1e21` instead of `1e+21`), it keeps integers
//! above 2^53 exact where JS rounds them, and it keeps object keys in
//! insertion order where JS lists integer-like keys first. This writer fixes
//! all three; everything else (escapes, separators) already matches.

use serde_json::Value;

use crate::js;

/// `JSON.stringify(value)` for a JSON value.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(n, out),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut first = true;
            for (key, item) in js_key_order(map) {
                if !first {
                    out.push(',');
                }
                first = false;
                write_string(key, out);
                out.push(':');
                write_value(item, out);
            }
            out.push('}');
        }
    }
}

fn write_number(n: &serde_json::Number, out: &mut String) {
    #[allow(clippy::cast_precision_loss)]
    if let Some(i) = n
        .as_i64()
        .filter(|i| i.unsigned_abs() as f64 <= js::MAX_SAFE_INTEGER)
    {
        out.push_str(&i.to_string());
        return;
    }
    // Beyond 2^53 (or a float): JS only ever held the nearest double.
    match n.as_f64() {
        Some(f) if f.is_finite() => out.push_str(&js::number_to_string(f)),
        _ => out.push_str("null"),
    }
}

/// JSON string escaping as `JSON.stringify` does it (lowercase `\u00xx`, `/` unescaped).
fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Whether JS treats `key` as an array index (`"0"`, `"42"`, not `"01"` or `"-1"`).
fn is_array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// Own-property order of a JS object: integer-like keys ascending, then the rest in insertion order.
fn js_key_order(map: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named: Vec<(&String, &Value)> = Vec::new();
    for (key, value) in map {
        match is_array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    if indexed.is_empty() {
        return named;
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}

/// Why a string that `JSON.parse` might accept could not be read here.
#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    /// Not JSON for JS either: the TS code takes its fallback branch.
    Invalid,
    /// Valid for JS but not representable here (lone surrogates, numbers out of
    /// range, nesting deeper than serde_json allows): the caller must not guess.
    Unsupported,
}

/// Whether the text has a `\uD800`–`\uDFFF` escape, which JS accepts unpaired and serde_json does not.
fn has_surrogate_escape(text: &str) -> bool {
    text.as_bytes().windows(4).any(|w| {
        w[0] == b'\\'
            && w[1] == b'u'
            && matches!(w[2], b'd' | b'D')
            && matches!(w[3], b'8'..=b'9' | b'a'..=b'f' | b'A'..=b'F')
    })
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Value, ParseError> {
    serde_json::from_str(text).map_err(|error| {
        let message = error.to_string();
        if has_surrogate_escape(text)
            || message.contains("out of range")
            || message.contains("recursion limit")
        {
            ParseError::Unsupported
        } else {
            ParseError::Invalid
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stringify_matches_v8() {
        let value = parse(r#"{"b":1,"2":true,"a":[1.0,1e21,0.5,null],"1":"\u0001\"/é"}"#).unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"1":"\u0001\"/é","2":true,"b":1,"a":[1,1e+21,0.5,null]}"#
        );
    }

    #[test]
    fn large_integers_round_like_js() {
        let value = parse("[12345678901234567890, 9007199254740993]").unwrap();
        assert_eq!(stringify(&value), "[12345678901234567000,9007199254740992]");
    }

    #[test]
    fn parse_errors_are_classified() {
        assert_eq!(parse("{"), Err(ParseError::Invalid));
        assert_eq!(parse(r#""\ud800""#), Err(ParseError::Unsupported));
        assert_eq!(parse("1e400"), Err(ParseError::Unsupported));
        assert_eq!(stringify(&json!("tab\there")), r#""tab\there""#);
    }
}
