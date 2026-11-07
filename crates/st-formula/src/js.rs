//! The JavaScript built-in behaviours the TS engine leans on.
//!
//! The TS code calls `String(x)`, `Number(x)`, `==`, `.length`, `.slice()`,
//! `JSON.stringify` and friends on untyped values. Reimplementing exactly those
//! operations here is what lets the evaluator stay a line-by-line port instead of
//! an approximation.

use std::borrow::Cow;
use std::fmt::Write as _;

use crate::value::{Value, duration_json_object};

/// JavaScript's `WhiteSpace` and `LineTerminator` code points: what `trim()`
/// removes and what `\s` matches. Unlike `char::is_whitespace` it includes
/// U+FEFF and excludes U+0085.
pub(crate) fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `Number.prototype.toString()`: the shortest digits that round-trip, written
/// positionally between 1e-7 and 1e21 and in exponent form outside.
pub(crate) fn number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_owned();
    }
    let mut out = String::new();
    if number < 0.0 {
        out.push('-');
    }
    // `{:e}` gives the shortest round-trip digits, the same ones V8 picks.
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        let exponent = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let _ = write!(
            out,
            "e{}{}",
            if exponent >= 0 { '+' } else { '-' },
            exponent.abs()
        );
    }
    out
}

/// `Number(text)`: decimal, `Infinity`, or `0x`/`0o`/`0b` integers, with the
/// surrounding whitespace ignored and the empty string read as 0.
pub(crate) fn string_to_number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let bytes = text.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            return parse_radix(&text[2..], radix);
        }
    }
    let (sign, body) = match bytes[0] {
        b'+' => (1.0, &text[1..]),
        b'-' => (-1.0, &text[1..]),
        _ => (1.0, text),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(body) {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |value| sign * value)
}

/// `StrUnsignedDecimalLiteral`: digits with an optional fraction and exponent,
/// with at least one digit before the exponent.
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    let integer_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let mut digits = index - integer_start;
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        let fraction_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        digits += index - fraction_start;
    }
    if digits == 0 {
        return false;
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        let exponent_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len()
}

fn parse_radix(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut exact: Option<u128> = Some(0);
    let mut approximate = 0.0f64;
    for c in digits.chars() {
        let Some(digit) = c.to_digit(radix) else {
            return f64::NAN;
        };
        exact = exact
            .and_then(|value| value.checked_mul(u128::from(radix)))
            .and_then(|value| value.checked_add(u128::from(digit)));
        approximate = approximate * f64::from(radix) + f64::from(digit);
    }
    exact.map_or(approximate, |value| value as f64)
}

/// `Number(value)`.
pub(crate) fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => f64::from(u8::from(*value)),
        Value::Number(number) => *number,
        Value::Text(text) => string_to_number(text),
        Value::Array(_) | Value::Object(_) => string_to_number(&to_js_string(value)),
        Value::Duration(duration) => duration.seconds,
    }
}

/// `String(value)`. Note that `null` prints as `"null"`: callers that want the
/// empty string use [`crate::eval`]'s `to_str`, like the TS `toStr` helper.
pub(crate) fn to_js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => number_to_string(*number),
        Value::Text(text) => text.clone(),
        Value::Array(items) => array_join(items, ","),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Duration(duration) => duration.text.clone(),
    }
}

/// `Array.prototype.join`: `null` items become empty strings.
pub(crate) fn array_join(items: &[Value], separator: &str) -> String {
    let mut out = String::new();
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push_str(separator);
        }
        if !item.is_null() {
            out.push_str(&to_js_string(item));
        }
    }
    out
}

/// `Boolean(value)`.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::Text(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) | Value::Duration(_) => true,
    }
}

/// `Math.trunc` as used by `ToIntegerOrInfinity`: `NaN` becomes 0.
pub(crate) fn to_integer_or_infinity(number: f64) -> f64 {
    if number.is_nan() {
        0.0
    } else {
        number.trunc() + 0.0
    }
}

enum Primitive<'a> {
    Null,
    Bool(bool),
    Number(f64),
    Text(Cow<'a, str>),
}

/// `ToPrimitive` with the default hint: arrays join, plain objects print as
/// `[object Object]`, durations use `valueOf()` (their seconds).
fn to_primitive(value: &Value) -> Primitive<'_> {
    match value {
        Value::Null => Primitive::Null,
        Value::Bool(value) => Primitive::Bool(*value),
        Value::Number(number) => Primitive::Number(*number),
        Value::Text(text) => Primitive::Text(Cow::Borrowed(text)),
        Value::Array(_) | Value::Object(_) => Primitive::Text(Cow::Owned(to_js_string(value))),
        Value::Duration(duration) => Primitive::Number(duration.seconds),
    }
}

/// The `==` operator (`IsLooselyEqual`).
///
/// Two distinct objects are never `==` in JavaScript. The engine only reaches
/// this after a `JSON.stringify` comparison, so treating every pair of objects
/// as distinct loses nothing.
pub(crate) fn loose_equals(left: &Value, right: &Value) -> bool {
    let left_is_object = matches!(
        left,
        Value::Array(_) | Value::Object(_) | Value::Duration(_)
    );
    let right_is_object = matches!(
        right,
        Value::Array(_) | Value::Object(_) | Value::Duration(_)
    );
    match (left_is_object, right_is_object) {
        (true, true) => false,
        (true, false) if right.is_null() => false,
        (false, true) if left.is_null() => false,
        _ => primitive_loose_equals(&to_primitive(left), &to_primitive(right)),
    }
}

fn primitive_loose_equals(left: &Primitive<'_>, right: &Primitive<'_>) -> bool {
    match (left, right) {
        (Primitive::Null, Primitive::Null) => true,
        (Primitive::Null, _) | (_, Primitive::Null) => false,
        (Primitive::Number(left), Primitive::Number(right)) => left == right,
        (Primitive::Text(left), Primitive::Text(right)) => left == right,
        (Primitive::Bool(left), Primitive::Bool(right)) => left == right,
        (Primitive::Number(number), Primitive::Text(text))
        | (Primitive::Text(text), Primitive::Number(number)) => *number == string_to_number(text),
        (Primitive::Bool(value), other) | (other, Primitive::Bool(value)) => {
            primitive_loose_equals(&Primitive::Number(f64::from(u8::from(*value))), other)
        }
    }
}

/// `SameValueZero`, the comparison behind `Array.prototype.includes`.
///
/// Objects compare structurally here, where JavaScript compares references:
/// values handed in by a caller have no identity to compare.
pub(crate) fn same_value_zero(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            left == right || (left.is_nan() && right.is_nan())
        }
        _ => left == right,
    }
}

/// `JSON.stringify(value)` for the values formulas handle.
pub(crate) fn json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) if number.is_finite() => out.push_str(&number_to_string(*number)),
        Value::Number(_) => out.push_str("null"),
        Value::Text(text) => write_json_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            out.push('{');
            for (index, (key, value)) in object.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_json(value, out);
            }
            out.push('}');
        }
        Value::Duration(duration) => {
            write_json(&Value::Object(duration_json_object(duration)), out)
        }
    }
}

fn write_json_string(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.parse`, or `None` when the text is not valid JSON.
pub(crate) fn json_parse(text: &str) -> Option<Value> {
    crate::json::parse(text)
}

/// The length JavaScript reports for a string: UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    if text.is_ascii() {
        text.len()
    } else {
        text.chars().map(char::len_utf16).sum()
    }
}

/// Resolves a `slice()` bound against a length, as `String.prototype.slice` does.
fn relative_index(bound: f64, length: usize) -> usize {
    let bound = to_integer_or_infinity(bound);
    let length_f = length as f64;
    if bound < 0.0 {
        (length_f + bound).max(0.0) as usize
    } else {
        bound.min(length_f) as usize
    }
}

/// `String.prototype.slice(start, end)` on UTF-16 code units. A cut through a
/// surrogate pair yields U+FFFD, where JavaScript keeps a lone surrogate.
pub(crate) fn slice(text: &str, start: f64, end: Option<f64>) -> String {
    let length = utf16_len(text);
    let from = relative_index(start, length);
    let to = end.map_or(length, |end| relative_index(end, length));
    if from >= to {
        return String::new();
    }
    if text.is_ascii() {
        return text[from..to].to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&units[from..to])
}

/// `String.prototype.indexOf`, as a UTF-16 index (`None` when absent).
pub(crate) fn index_of(text: &str, needle: &str) -> Option<usize> {
    text.find(needle)
        .map(|byte_index| utf16_len(&text[..byte_index]))
}

/// `String.prototype.split(separator)` with a string separator. Splitting on
/// the empty string cuts between UTF-16 code units, like JavaScript.
pub(crate) fn split(text: &str, separator: &str) -> Vec<String> {
    if separator.is_empty() {
        if text.chars().all(|c| c.len_utf16() == 1) {
            return text.chars().map(String::from).collect();
        }
        return text
            .encode_utf16()
            .map(|unit| String::from_utf16_lossy(&[unit]))
            .collect();
    }
    text.split(separator).map(str::to_owned).collect()
}

/// `text.split("").join(separator)`, joined on UTF-16 code units so that
/// surrogate pairs come back together when nothing separates them.
pub(crate) fn join_code_units(text: &str, separator: &str) -> String {
    let separator: Vec<u16> = separator.encode_utf16().collect();
    let mut out = Vec::with_capacity(text.len());
    for (index, unit) in text.encode_utf16().enumerate() {
        if index > 0 {
            out.extend_from_slice(&separator);
        }
        out.push(unit);
    }
    String::from_utf16_lossy(&out)
}

/// `String.prototype.replaceAll(search, replacement)` with a string pattern,
/// including the `$&`, `` $` ``, `$'` and `$$` replacement patterns.
pub(crate) fn replace_all(text: &str, search: &str, replacement: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let search: Vec<u16> = search.encode_utf16().collect();
    let replacement: Vec<u16> = replacement.encode_utf16().collect();
    let mut positions = Vec::new();
    let advance = search.len().max(1);
    let mut position = 0;
    while position <= units.len() {
        if units[position..].starts_with(&search) {
            positions.push(position);
            position += advance;
        } else {
            position += 1;
        }
    }
    let mut out = Vec::with_capacity(units.len());
    let mut end_of_last_match = 0;
    for position in positions {
        out.extend_from_slice(&units[end_of_last_match..position]);
        let matched = position..position + search.len();
        expand_replacement(&mut out, &replacement, &units, matched.clone(), &[], None);
        end_of_last_match = matched.end;
    }
    out.extend_from_slice(&units[end_of_last_match.min(units.len())..]);
    String::from_utf16_lossy(&out)
}

/// Looks up a named group of a match: `None` for an unknown name or a group
/// that did not take part (both expand to nothing). Only given when the
/// pattern has named groups; otherwise `$<` stays literal.
pub(crate) type NamedGroups<'a> = &'a dyn Fn(&[u16]) -> Option<std::ops::Range<usize>>;

/// `GetSubstitution`: expands `$$`, `$&`, `` $` ``, `$'`, `$n`, `$nn` and
/// `$<name>` in a replacement string, on UTF-16 code units.
pub(crate) fn expand_replacement(
    out: &mut Vec<u16>,
    replacement: &[u16],
    text: &[u16],
    matched: std::ops::Range<usize>,
    captures: &[Option<std::ops::Range<usize>>],
    named: Option<NamedGroups<'_>>,
) {
    const DOLLAR: u16 = b'$' as u16;
    let digit = |unit: u16| {
        (b'0' as u16..=b'9' as u16)
            .contains(&unit)
            .then(|| usize::from(unit - b'0' as u16))
    };
    let mut index = 0;
    while index < replacement.len() {
        let unit = replacement[index];
        if unit != DOLLAR || index + 1 >= replacement.len() {
            out.push(unit);
            index += 1;
            continue;
        }
        let next = replacement[index + 1];
        match next {
            DOLLAR => {
                out.push(DOLLAR);
                index += 2;
            }
            0x26 /* & */ => {
                out.extend_from_slice(&text[matched.clone()]);
                index += 2;
            }
            0x60 /* ` */ => {
                out.extend_from_slice(&text[..matched.start]);
                index += 2;
            }
            0x27 /* ' */ => {
                out.extend_from_slice(&text[matched.end.min(text.len())..]);
                index += 2;
            }
            0x3c /* < */ if named.is_some() => {
                let rest = &replacement[index + 2..];
                match rest.iter().position(|unit| *unit == b'>' as u16) {
                    Some(close) => {
                        if let Some(range) = named.and_then(|lookup| lookup(&rest[..close])) {
                            out.extend_from_slice(&text[range]);
                        }
                        index += 2 + close + 1;
                    }
                    None => {
                        out.push(DOLLAR);
                        index += 1;
                    }
                }
            }
            _ => {
                let Some(first) = digit(next) else {
                    out.push(DOLLAR);
                    index += 1;
                    continue;
                };
                let two_digit = replacement.get(index + 2).and_then(|unit| digit(*unit)).map(|second| first * 10 + second);
                let (group, consumed) = match two_digit {
                    Some(group) if (1..=captures.len()).contains(&group) => (group, 3),
                    _ => (first, 2),
                };
                if (1..=captures.len()).contains(&group) {
                    if let Some(range) = &captures[group - 1] {
                        out.extend_from_slice(&text[range.clone()]);
                    }
                    index += consumed;
                } else {
                    out.push(DOLLAR);
                    index += 1;
                }
            }
        }
    }
}

/// `encodeURIComponent`, or `encodeURI` when `keep_reserved` is set, with the
/// escapes in lowercase hex.
pub(crate) fn encode_uri(text: &str, keep_reserved: bool, keep_marks: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut buffer = [0u8; 4];
    for c in text.chars() {
        let keep = c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '~')
            || (keep_marks && matches!(c, '!' | '*' | '\'' | '(' | ')'))
            || (keep_reserved
                && matches!(
                    c,
                    ';' | ',' | '/' | '?' | ':' | '@' | '&' | '=' | '+' | '$' | '#'
                ));
        if keep {
            out.push(c);
        } else {
            for byte in c.encode_utf8(&mut buffer).bytes() {
                let _ = write!(out, "%{byte:02x}");
            }
        }
    }
    out
}

/// `Number.prototype.toFixed(digits)`, for `digits` in `0..=100`.
///
/// JavaScript rounds the exact binary value half away from zero, where Rust's
/// formatter rounds ties to even, so the rounding is done here on the exact
/// decimal expansion.
pub(crate) fn to_fixed(number: f64, digits: usize) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.abs() >= 1e21 {
        return number_to_string(number);
    }
    // Every double has an exact decimal expansion of at most 1074 fractional digits.
    let exact = format!("{:.1100}", number.abs());
    let (integer, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = integer
        .bytes()
        .chain(fraction.bytes().take(digits))
        .collect();
    if fraction
        .as_bytes()
        .get(digits)
        .is_some_and(|digit| *digit >= b'5')
    {
        let mut index = kept.len();
        loop {
            if index == 0 {
                kept.insert(0, b'1');
                break;
            }
            index -= 1;
            if kept[index] == b'9' {
                kept[index] = b'0';
            } else {
                kept[index] += 1;
                break;
            }
        }
    }
    let integer_length = kept.len() - digits;
    let mut out = String::new();
    let is_zero = kept.iter().all(|digit| *digit == b'0');
    if number < 0.0 && !is_zero {
        out.push('-');
    }
    let integer_part = std::str::from_utf8(&kept[..integer_length]).unwrap_or("0");
    let integer_part = integer_part.trim_start_matches('0');
    out.push_str(if integer_part.is_empty() {
        "0"
    } else {
        integer_part
    });
    if digits > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(&kept[integer_length..]).unwrap_or(""));
    }
    out
}

/// `Math.max` / `Math.min`: `NaN` wins, and +0 beats -0 for `max`.
pub(crate) fn math_max(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut result = f64::NEG_INFINITY;
    for value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if value > result || (value == 0.0 && result == 0.0 && result.is_sign_negative()) {
            result = value;
        }
    }
    result
}

pub(crate) fn math_min(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut result = f64::INFINITY;
    for value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if value < result || (value == 0.0 && result == 0.0 && value.is_sign_negative()) {
            result = value;
        }
    }
    result
}

/// `Math.pow`, which differs from `powf` on a base of ±1 with an infinite or
/// NaN exponent.
pub(crate) fn math_pow(base: f64, exponent: f64) -> f64 {
    if exponent.is_nan() || (base.abs() == 1.0 && exponent.is_infinite()) {
        return f64::NAN;
    }
    base.powf(exponent)
}

/// `Math.sign`, which keeps `NaN` and the sign of zero where `signum` would not.
pub(crate) fn math_sign(number: f64) -> f64 {
    if number.is_nan() || number == 0.0 {
        number
    } else {
        number.signum()
    }
}

/// `String.prototype.toUpperCase` / `toLowerCase`: full Unicode mappings, as
/// Rust's are.
pub(crate) fn to_upper(text: &str) -> String {
    text.to_uppercase()
}

pub(crate) fn to_lower(text: &str) -> String {
    text.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        let cases = [
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (123e-20, "1.23e-18"),
            (0.000001, "0.000001"),
            (1.5e300, "1.5e+300"),
            (-0.0, "0"),
            (9007199254740992.0, "9007199254740992"),
            (0.1 + 0.2, "0.30000000000000004"),
            (100.0, "100"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (-2.5, "-2.5"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for (number, expected) in cases {
            assert_eq!(number_to_string(number), expected, "{number:?}");
        }
    }

    #[test]
    fn strings_parse_like_number() {
        let cases = [
            ("", 0.0),
            (" ", 0.0),
            ("0x1F", 31.0),
            ("0b11", 3.0),
            ("0o7", 7.0),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("1.", 1.0),
            (".5", 0.5),
            ("+.5", 0.5),
            ("\u{a0}1\u{feff}", 1.0),
            ("1e400", f64::INFINITY),
            ("00012", 12.0),
            ("-12.5e1", -125.0),
        ];
        for (text, expected) in cases {
            assert_eq!(string_to_number(text), expected, "{text:?}");
        }
        for text in [
            "-0x1", "infinity", "1e", "1_0", "\u{85} 1", "-", ".", "1e+", "0x",
        ] {
            assert!(string_to_number(text).is_nan(), "{text:?}");
        }
    }

    #[test]
    fn loose_equality_follows_javascript() {
        assert!(loose_equals(&Value::Number(1.0), &Value::from("1")));
        assert!(loose_equals(&Value::Bool(true), &Value::from("1")));
        assert!(loose_equals(
            &Value::Array(vec!["A".into(), "B".into()]),
            &Value::from("A,B")
        ));
        assert!(loose_equals(
            &Value::Object(Default::default()),
            &Value::from("[object Object]")
        ));
        assert!(!loose_equals(&Value::Null, &Value::Number(0.0)));
        assert!(!loose_equals(
            &Value::Number(f64::NAN),
            &Value::Number(f64::NAN)
        ));
    }

    #[test]
    fn to_fixed_rounds_ties_away_from_zero() {
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(-0.0001, 2), "0.00");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(99.5, 0), "100");
    }

    #[test]
    fn utf16_operations() {
        assert_eq!(utf16_len("😀a"), 3);
        assert_eq!(slice("abcde", 0.0, Some(-2.0)), "abc");
        assert_eq!(slice("abcde", -2.0, None), "de");
        assert_eq!(slice("abcdef", 1.5, Some(3.5)), "bc");
        assert_eq!(index_of("é test", "test"), Some(2));
        assert_eq!(split("", ""), Vec::<String>::new());
        assert_eq!(split("", ","), vec![String::new()]);
        assert_eq!(split("abc", ""), vec!["a", "b", "c"]);
        assert_eq!(replace_all("abc", "", "-"), "-a-b-c-");
        assert_eq!(replace_all("aXa", "a", "[$&$$]"), "[a$]X[a$]");
    }

    #[test]
    fn uri_encoding() {
        assert_eq!(
            encode_uri("http://example.com/wiki/Señor", true, false),
            "http://example.com/wiki/Se%c3%b1or"
        );
        assert_eq!(encode_uri("Hello World!", false, true), "Hello%20World!");
        assert_eq!(encode_uri("a(b)", true, false), "a%28b%29");
    }
}
