//! Query strings as Hono's `c.req.query()` reads them: first value wins, a
//! key without `=` is `""`, `+` is a space, percent escapes are decoded.

use crate::fallback::{Failure, Outcome};
use crate::js;

/// Decoded query parameters, in order of first appearance.
#[derive(Debug, Default)]
pub struct Query {
    params: Vec<(String, String)>,
}

/// Hono's `_decodeURI` for well-formed input; malformed escapes are not reproduced.
fn decode(raw: &str) -> Outcome<String> {
    if !raw.contains(['%', '+']) {
        return Ok(raw.to_owned());
    }
    let spaced = raw.replace('+', " ");
    let bytes = spaced.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = spaced
                .get(i + 1..i + 3)
                .filter(|p| p.bytes().all(|b| b.is_ascii_hexdigit()));
            let byte = pair.and_then(|p| u8::from_str_radix(p, 16).ok());
            let Some(byte) = byte else {
                return Err(Failure::unsupported("malformed percent escape in query"));
            };
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| Failure::unsupported("percent escape that is not UTF-8"))
}

impl Query {
    /// Parses the part of a URL after `?` (without the `?`).
    pub fn parse(search: &str) -> Outcome<Self> {
        let mut params: Vec<(String, String)> = Vec::new();
        for pair in search.split('&') {
            let (raw_name, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
            let name = decode(raw_name)?;
            if name.is_empty() {
                continue;
            }
            let value = if pair.contains('=') {
                decode(raw_value)?
            } else {
                String::new()
            };
            if !params.iter().any(|(existing, _)| *existing == name) {
                params.push((name, value));
            }
        }
        Ok(Self { params })
    }

    /// `c.req.query(key)`.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    /// Parameter names, in order.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.params.iter().map(|(name, _)| name.as_str())
    }
}

/// `positiveIntQueryParam(value, fallback)` as a JS number.
pub fn positive_int_param(value: Option<&str>, fallback: f64) -> f64 {
    let parsed = value.map_or(f64::NAN, js::string_to_number);
    if js::is_positive_integer(parsed) {
        parsed
    } else {
        fallback
    }
}

/// Whether a key is a row filter (`/^filter__field_(\d+)__(\w+)$/`).
pub fn is_filter_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("filter__field_") else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let Some(kind) = rest[digits..].strip_prefix("__") else {
        return false;
    };
    digits > 0 && !kind.is_empty() && kind.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_value_wins_and_escapes_decode() {
        let query =
            Query::parse("size=2&page=3&size=9&user_field_names&search=a+b%C3%A9&=x").unwrap();
        assert_eq!(query.get("size"), Some("2"));
        assert_eq!(query.get("user_field_names"), Some(""));
        assert_eq!(query.get("search"), Some("a bé"));
        assert_eq!(query.keys().count(), 4);
        assert!(Query::parse("a=%zz").is_err());
    }

    #[test]
    fn numbers_and_filters() {
        assert_eq!(positive_int_param(Some("5.0"), 1.0), 5.0);
        assert_eq!(positive_int_param(Some("0"), 1.0), 1.0);
        assert_eq!(positive_int_param(Some("-2"), 1.0), 1.0);
        assert_eq!(positive_int_param(None, 100.0), 100.0);
        assert!(is_filter_key("filter__field_12__contains"));
        assert!(is_filter_key("filter__field_12__link_row_has"));
        assert!(!is_filter_key("filter__field___equal"));
        assert!(!is_filter_key("filter_type"));
    }
}
