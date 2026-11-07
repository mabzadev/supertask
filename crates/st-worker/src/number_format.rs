//! Port of `src/services/number-format.ts` (API side only).
//!
//! Numbers are stored as text (`"n:12.50"`) and returned as fixed-point
//! strings computed digit by digit, never through floats, so the port works
//! on the digit strings exactly like the TS code.

use serde_json::{Map, Value};

use crate::fallback::{Failure, Outcome};
use crate::js;

const NUMERIC_STORAGE_PREFIX: &str = "n:";

/// Exponents and decimal places past this are refused rather than reproduced:
/// the TS code builds strings of that many zeros and fails with a 500.
const MAX_DIGIT_EXPANSION: f64 = 10_000.0;

/// `decodeNumericStorageValue`: strips the `n:` storage prefix from strings.
fn decode_storage(value: &Value) -> Value {
    match value {
        Value::String(s) => match s.strip_prefix(NUMERIC_STORAGE_PREFIX) {
            Some(rest) => Value::String(rest.to_owned()),
            None => value.clone(),
        },
        _ => value.clone(),
    }
}

fn is_empty_like(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    }
}

/// `numericStorageValue`: the stored value as a finite number, else `None`.
pub fn numeric_storage_value(value: Option<&Value>) -> Option<f64> {
    if is_empty_like(value) {
        return None;
    }
    let decoded = decode_storage(value?);
    if decoded.as_str() == Some("") {
        return None;
    }
    let numeric = js::to_number(&decoded);
    numeric.is_finite().then_some(numeric)
}

struct DecimalParts {
    negative: bool,
    digits: Vec<u8>,
    scale: i64,
}

/// Matches `^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$`.
fn match_decimal(text: &str) -> Option<(bool, &str, &str, &str)> {
    let bytes = text.as_bytes();
    let mut i = 0;
    let negative = match bytes.first() {
        Some(b'-') => {
            i += 1;
            true
        }
        Some(b'+') => {
            i += 1;
            false
        }
        _ => false,
    };
    let digits_from = |start: usize| {
        start
            + bytes[start..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count()
    };
    let int_end = digits_from(i);
    let integer = &text[i..int_end];
    let fraction;
    let mut j = int_end;
    if integer.is_empty() {
        if bytes.get(j) != Some(&b'.') {
            return None;
        }
        let frac_end = digits_from(j + 1);
        if frac_end == j + 1 {
            return None;
        }
        fraction = &text[j + 1..frac_end];
        j = frac_end;
    } else if bytes.get(j) == Some(&b'.') {
        let frac_end = digits_from(j + 1);
        fraction = &text[j + 1..frac_end];
        j = frac_end;
    } else {
        fraction = "";
    }
    let mut exponent = "";
    if matches!(bytes.get(j), Some(b'e' | b'E')) {
        let exp_start = j + 1;
        let sign_len = usize::from(matches!(bytes.get(exp_start), Some(b'+' | b'-')));
        let exp_end = digits_from(exp_start + sign_len);
        if exp_end == exp_start + sign_len {
            return None;
        }
        exponent = &text[exp_start..exp_end];
        j = exp_end;
    }
    (j == bytes.len()).then_some((negative, integer, fraction, exponent))
}

/// `/^0+(?=\d)/` replaced by "": leading zeros go, one digit always stays.
fn strip_leading_zeros(digits: &[u8]) -> Vec<u8> {
    let zeros = digits.iter().take_while(|d| **d == b'0').count();
    digits[zeros.min(digits.len().saturating_sub(1))..].to_vec()
}

fn parse_decimal_parts(value: Option<&Value>) -> Outcome<Option<DecimalParts>> {
    let Some(value) = value.filter(|v| !is_empty_like(Some(v))) else {
        return Ok(None);
    };
    let text = js::to_js_string(&decode_storage(value));
    let text = js::trim(&text);
    if text.is_empty() {
        return Ok(None);
    }
    let Some((negative, integer, fraction, exponent)) = match_decimal(text) else {
        return Ok(None);
    };
    let exponent = if exponent.is_empty() {
        0.0
    } else {
        js::string_to_number(exponent)
    };
    if exponent.abs() > MAX_DIGIT_EXPANSION {
        return Err(Failure::unsupported("number exponent too large"));
    }
    #[allow(clippy::cast_possible_truncation)]
    let exponent = exponent as i64;
    let mut digits = strip_leading_zeros(format!("{integer}{fraction}").as_bytes());
    let mut scale = i64::try_from(fraction.len()).unwrap_or(i64::MAX) - exponent;
    if digits.iter().all(|d| *d == b'0') {
        return Ok(Some(DecimalParts {
            negative: false,
            digits: b"0".to_vec(),
            scale: scale.max(0),
        }));
    }
    if scale < 0 {
        digits.extend(std::iter::repeat_n(
            b'0',
            usize::try_from(-scale).unwrap_or(0),
        ));
        scale = 0;
    }
    let len = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    if scale > len {
        let mut padded = vec![b'0'; usize::try_from(scale - len).unwrap_or(0)];
        padded.extend(digits);
        digits = padded;
    }
    Ok(Some(DecimalParts {
        negative,
        digits,
        scale,
    }))
}

fn increment_decimal_digits(digits: &[u8]) -> Vec<u8> {
    let mut chars = digits.to_vec();
    for index in (0..chars.len()).rev() {
        if chars[index] != b'9' {
            chars[index] += 1;
            return chars;
        }
        chars[index] = b'0';
    }
    let mut out = vec![b'1'];
    out.extend(chars);
    out
}

fn fixed_decimal_text(value: Option<&Value>, decimal_places: i64) -> Outcome<Option<String>> {
    let Some(parsed) = parse_decimal_parts(value)? else {
        return Ok(None);
    };
    let DecimalParts {
        negative,
        mut digits,
        mut scale,
    } = parsed;
    let len = |d: &Vec<u8>| i64::try_from(d.len()).unwrap_or(i64::MAX);
    if scale > decimal_places {
        let drop = scale - decimal_places;
        let keep_length = usize::try_from((len(&digits) - drop).max(0)).unwrap_or(0);
        let mut kept = digits[..keep_length].to_vec();
        if kept.is_empty() {
            kept = b"0".to_vec();
        }
        let dropped = &digits[keep_length..];
        let first_dropped = dropped.first().copied().unwrap_or(b'0');
        let has_non_zero_tail = dropped.iter().skip(1).any(|d| (b'1'..=b'9').contains(d));
        let last_kept = kept.last().map_or(0, |d| d - b'0');
        let round_up = first_dropped > b'5'
            || (first_dropped == b'5' && (has_non_zero_tail || last_kept % 2 == 1));
        if round_up {
            kept = increment_decimal_digits(&kept);
        }
        digits = kept;
        scale = decimal_places;
    } else if scale < decimal_places {
        digits.extend(std::iter::repeat_n(
            b'0',
            usize::try_from(decimal_places - scale).unwrap_or(0),
        ));
        scale = decimal_places;
    }
    if scale > 0 && len(&digits) <= scale {
        let mut padded = vec![b'0'; usize::try_from(scale - len(&digits) + 1).unwrap_or(0)];
        padded.extend(digits);
        digits = padded;
    }
    let integer_end = if scale == 0 {
        digits.len()
    } else {
        usize::try_from(len(&digits) - scale).unwrap_or(0)
    };
    let raw_integer: &[u8] = if integer_end == 0 {
        b"0"
    } else {
        &digits[..integer_end]
    };
    let integer_part = strip_leading_zeros(raw_integer);
    let fractional_part: &[u8] = if scale > 0 {
        &digits[integer_end..]
    } else {
        b""
    };
    let is_zero =
        integer_part.iter().all(|d| *d == b'0') && fractional_part.iter().all(|d| *d == b'0');
    let mut out = String::new();
    if negative && !is_zero {
        out.push('-');
    }
    out.push_str(std::str::from_utf8(&integer_part).unwrap_or("0"));
    if scale > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(fractional_part).unwrap_or(""));
    }
    Ok(Some(out))
}

/// `formatNumberForApi(field, value)`: a fixed-point string with the field's decimal places.
pub fn format_number_for_api(
    settings: &Map<String, Value>,
    value: Option<&Value>,
) -> Outcome<Option<String>> {
    if is_empty_like(value) {
        return Ok(None);
    }
    let places = settings.get("number_decimal_places");
    let raw = if js::truthy_opt(places) {
        js::to_number_opt(places)
    } else {
        0.0
    };
    let decimal_places = if raw.is_finite() {
        raw.trunc().max(0.0)
    } else {
        0.0
    };
    if decimal_places > MAX_DIGIT_EXPANSION {
        return Err(Failure::unsupported("too many decimal places"));
    }
    #[allow(clippy::cast_possible_truncation)]
    fixed_decimal_text(value, decimal_places as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn format(places: i64, value: Value) -> Option<String> {
        let settings = json!({ "number_decimal_places": places });
        format_number_for_api(settings.as_object().unwrap(), Some(&value)).unwrap()
    }

    #[test]
    fn formats_like_the_ts_code() {
        assert_eq!(format(2, json!("n:68400")), Some("68400.00".into()));
        assert_eq!(format(0, json!(3)), Some("3".into()));
        assert_eq!(format(2, json!("0.005")), Some("0.00".into()));
        assert_eq!(format(2, json!("0.015")), Some("0.02".into()));
        assert_eq!(format(2, json!("0.0251")), Some("0.03".into()));
        assert_eq!(format(0, json!("-0.4")), Some("0".into()));
        assert_eq!(format(1, json!("9.96")), Some("10.0".into()));
        assert_eq!(format(2, json!("1.5e3")), Some("1500.00".into()));
        assert_eq!(format(2, json!(0.1 + 0.2)), Some("0.30".into()));
        assert_eq!(format(2, json!("abc")), None);
        assert_eq!(format(2, json!("")), None);
        assert_eq!(format(0, json!("007")), Some("7".into()));
    }

    #[test]
    fn storage_values_decode_like_number() {
        assert_eq!(numeric_storage_value(Some(&json!("n:5"))), Some(5.0));
        assert_eq!(numeric_storage_value(Some(&json!("n:"))), None);
        assert_eq!(numeric_storage_value(Some(&json!(true))), Some(1.0));
        assert_eq!(numeric_storage_value(Some(&json!("x"))), None);
        assert_eq!(numeric_storage_value(None), None);
    }
}
