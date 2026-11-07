//! JavaScript value semantics over [`serde_json::Value`].
//!
//! The TypeScript Worker leans on implicit conversions (`Number(x)`,
//! `String(x)`, truthiness, `parseInt`). Byte-identical responses need the
//! exact same conversions, so they live here once, with tests, instead of
//! being approximated at every call site.

use serde_json::{Map, Value};

/// Largest integer a JS number holds exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// JS `WhiteSpace` and `LineTerminator` code points, as stripped by `String.prototype.trim`.
///
/// Differs from [`char::is_whitespace`]: JS counts U+FEFF and not U+0085.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `Number.prototype.toString()` (and `String(n)`): shortest round-trip digits, JS exponent rules.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(n).to_owned()
}

/// JS `StringToNumber`, i.e. `Number(string)`.
pub fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let (sign, unsigned) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(unsigned) {
        return f64::NAN;
    }
    // Rust's float parser is correctly rounded, like JS, on the same grammar.
    unsigned
        .parse::<f64>()
        .map(|n| sign * n)
        .unwrap_or(f64::NAN)
}

/// `StrUnsignedDecimalLiteral` without `Infinity`: `1`, `1.`, `.5`, `1e3`, `1.5E-2`.
fn is_decimal_literal(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - frac_start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == bytes.len()
}

/// `parseInt(s, 10)`: leading whitespace, optional sign, then as many decimal digits as present.
pub fn parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_whitespace);
    let (sign, rest) = match t.as_bytes().first() {
        Some(b'+') => (1.0, &t[1..]),
        Some(b'-') => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    let digits: &str = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)` for a JSON value (`undefined` is the caller's `None`).
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        Value::Array(_) => string_to_number(&to_js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// `Number(value)` where the value may be `undefined` (`None`).
pub fn to_number_opt(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// `String(value)` for a JSON value.
pub fn to_js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        // Array.prototype.toString joins with "," and prints null/undefined as "".
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    to_js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JS truthiness (`Boolean(value)`).
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Truthiness of a value that may be `undefined`.
pub fn truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// `a || b` on optional values: the first truthy operand, else the last one.
pub fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy_opt(a) { a } else { b }
}

/// A JS number as a JSON value; `None` for NaN and infinities, which JSON cannot hold.
///
/// Safe integers become JSON integers so they print without a fraction, like JS.
pub fn number_value(n: f64) -> Option<Value> {
    if !n.is_finite() {
        return None;
    }
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER {
        // Lossless: |n| <= 2^53. -0 prints as "0" in JS too.
        #[allow(clippy::cast_possible_truncation)]
        return Some(Value::from(n as i64));
    }
    serde_json::Number::from_f64(n).map(Value::Number)
}

/// `Number.isInteger(n) && n > 0`, the id check the TS code applies everywhere.
pub fn is_positive_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n > 0.0
}

/// `object[key]` on a value that may not be an object.
pub fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(key))
}

/// `settings?.[key]` on a settings map.
pub fn setting<'a>(settings: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    settings.get(key)
}

/// `String(a || b || "").toLowerCase()`, used to read optional string settings.
pub fn lower_setting(settings: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| settings.get(*key))
        .find(|value| truthy_opt(*value))
        .flatten()
        .map(to_js_string)
        .unwrap_or_default()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_to_string_follows_js() {
        assert_eq!(number_to_string(10000.0), "10000");
        assert_eq!(number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(
            number_to_string(123456789012345680000.0),
            "123456789012345680000"
        );
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(f64::NAN), "NaN");
    }

    #[test]
    fn string_to_number_follows_js() {
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("  12 "), 12.0);
        assert_eq!(string_to_number("5.0"), 5.0);
        assert_eq!(string_to_number("1e2"), 100.0);
        assert_eq!(string_to_number("0x10"), 16.0);
        assert_eq!(string_to_number(".5"), 0.5);
        assert_eq!(string_to_number("5."), 5.0);
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(string_to_number("12abc").is_nan());
        assert!(string_to_number("-0x10").is_nan());
        assert!(string_to_number("1_000").is_nan());
        assert!(string_to_number("inf").is_nan());
    }

    #[test]
    fn parse_int_follows_js() {
        assert_eq!(parse_int("12abc"), 12.0);
        assert_eq!(parse_int("  -7"), -7.0);
        assert!(parse_int("abc").is_nan());
        assert!(parse_int("").is_nan());
    }

    #[test]
    fn conversions_follow_js() {
        assert_eq!(to_js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(to_number(&json!([])), 0.0);
        assert_eq!(to_number(&json!(["7"])), 7.0);
        assert!(!truthy(&json!("")));
        assert!(truthy(&json!([])));
        assert!(!truthy(&json!(0)));
        assert_eq!(number_value(3.0), Some(json!(3)));
        assert_eq!(number_value(f64::INFINITY), None);
    }
}
