//! HS256 JWTs exactly as `jose` 5 signs and verifies them in the TS Worker.
//!
//! Both Workers share `JWT_SIGNING_KEY`, so a token from one must be accepted
//! by the other: same header (`{"alg":"HS256"}`), same claim order, same
//! verification rules (`exp <= now` is expired, `iat`/`nbf`/`exp` must be
//! numbers, the header may name any HMAC algorithm since the key is a secret).

use hmac::{Hmac, Mac};
use serde_json::{Map, Value};
use sha2::{Sha256, Sha384, Sha512};

use crate::{js, json};

/// Why a token was refused (`ERR_JWT_EXPIRED` vs everything else).
#[derive(Debug, PartialEq, Eq)]
pub enum JwtError {
    /// The `exp` claim is in the past.
    Expired,
    /// Malformed, badly signed or with invalid claims.
    Invalid,
}

const URL_SAFE: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn encode(bytes: &[u8]) -> String {
    use base64::Engine;
    URL_SAFE.encode(bytes)
}

/// jose's base64url decoding: `-_` mapped to `+/`, whitespace dropped, then
/// the forgiving `atob` rules (optional padding, trailing bits ignored).
pub fn decode_base64url(input: &str) -> Option<Vec<u8>> {
    let mapped: String = input
        .chars()
        .filter(|c| !js::is_js_whitespace(*c))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    forgiving_base64_decode(&mapped)
}

/// WHATWG forgiving-base64 decode, as `atob` implements it.
pub fn forgiving_base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = input
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        .collect();
    if data.len().is_multiple_of(4) {
        if data.ends_with(b"==") {
            data.truncate(data.len() - 2);
        } else if data.ends_with(b"=") {
            data.truncate(data.len() - 1);
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let sextet = |b: u8| -> Option<u32> {
        Some(match b {
            b'A'..=b'Z' => u32::from(b - b'A'),
            b'a'..=b'z' => u32::from(b - b'a') + 26,
            b'0'..=b'9' => u32::from(b - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for b in data {
        buffer = (buffer << 6) | sextet(b)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            // Truncation keeps the next whole byte; leftover bits are discarded at the end.
            #[allow(clippy::cast_possible_truncation)]
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn hmac_sign(alg: &str, key: &[u8], input: &[u8]) -> Option<Vec<u8>> {
    macro_rules! sign {
        ($hash:ty) => {{
            let mut mac = Hmac::<$hash>::new_from_slice(key).ok()?;
            mac.update(input);
            Some(mac.finalize().into_bytes().to_vec())
        }};
    }
    match alg {
        "HS256" => sign!(Sha256),
        "HS384" => sign!(Sha384),
        "HS512" => sign!(Sha512),
        _ => None,
    }
}

/// `new SignJWT(claims).setProtectedHeader({ alg: "HS256" })…sign(key)`.
///
/// `claims` must already hold `iat` and `exp` in jose's order (payload, then `iat`, then `exp`).
pub fn sign(claims: &Map<String, Value>, key: &str) -> String {
    let header = encode(br#"{"alg":"HS256"}"#);
    let payload = encode(json::stringify(&Value::Object(claims.clone())).as_bytes());
    let input = format!("{header}.{payload}");
    let signature = hmac_sign("HS256", key.as_bytes(), input.as_bytes()).unwrap_or_default();
    format!("{input}.{}", encode(&signature))
}

/// `jwtVerify(token, key)` with jose's defaults; `now` is `Math.floor(Date.now() / 1000)`.
pub fn verify(token: &str, key: &str, now: f64) -> Result<Map<String, Value>, JwtError> {
    let parts: Vec<&str> = token.split('.').collect();
    let [header_b64, payload_b64, signature_b64] = parts[..] else {
        return Err(JwtError::Invalid);
    };
    let header = parse_object(&decode_base64url(header_b64).ok_or(JwtError::Invalid)?)?;
    // A `crit` header would need jose's extension handling; our tokens never carry one.
    if header.contains_key("crit") {
        return Err(JwtError::Invalid);
    }
    let alg = header
        .get("alg")
        .and_then(Value::as_str)
        .ok_or(JwtError::Invalid)?;
    let signature = decode_base64url(signature_b64).ok_or(JwtError::Invalid)?;
    let expected = hmac_sign(
        alg,
        key.as_bytes(),
        format!("{header_b64}.{payload_b64}").as_bytes(),
    )
    .ok_or(JwtError::Invalid)?;
    if !bool::from(subtle::ConstantTimeEq::ct_eq(
        expected.as_slice(),
        signature.as_slice(),
    )) {
        return Err(JwtError::Invalid);
    }
    let claims = parse_object(&decode_base64url(payload_b64).ok_or(JwtError::Invalid)?)?;
    let numeric = |name: &str| match claims.get(name) {
        None => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(_) => Err(JwtError::Invalid),
    };
    numeric("iat")?;
    if numeric("nbf")?.is_some_and(|nbf| nbf > now) {
        return Err(JwtError::Invalid);
    }
    if numeric("exp")?.is_some_and(|exp| exp <= now) {
        return Err(JwtError::Expired);
    }
    Ok(claims)
}

/// `JSON.parse(new TextDecoder().decode(bytes))`, which must be an object.
fn parse_object(bytes: &[u8]) -> Result<Map<String, Value>, JwtError> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    match json::parse(text) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(JwtError::Invalid),
    }
}

/// `tokenPayload(userId, email)` with jose's `iat`/`exp` appended.
pub fn session_claims(
    base: Vec<(&str, Value)>,
    token_type: &str,
    iat: f64,
    ttl_seconds: f64,
) -> Map<String, Value> {
    let mut claims: Map<String, Value> = base.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
    claims.insert("token_type".into(), Value::String(token_type.to_owned()));
    claims.insert("iat".into(), js::number_value(iat).unwrap_or(Value::Null));
    claims.insert(
        "exp".into(),
        js::number_value(iat + ttl_seconds).unwrap_or(Value::Null),
    );
    claims
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A token issued by the TS Worker (jose 5.10) with the key "test-key".
    const TS_TOKEN: &str = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoyLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwidXNlcm5hbWUiOiJhbGljZUBleGFtcGxlLmNvbSIsInRva2VuX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTQwNzc4MDgsImV4cCI6MTc5NDA3ODQwOH0";

    #[test]
    fn sign_then_verify_round_trips() {
        let claims = session_claims(
            vec![("user_id", json!(2)), ("email", json!("a@b.c"))],
            "access",
            1000.0,
            600.0,
        );
        let token = sign(&claims, "k");
        assert!(token.starts_with("eyJhbGciOiJIUzI1NiJ9."));
        assert_eq!(verify(&token, "k", 1500.0).unwrap(), claims);
        assert_eq!(verify(&token, "k", 1600.0), Err(JwtError::Expired));
        assert_eq!(verify(&token, "other", 1500.0), Err(JwtError::Invalid));
    }

    #[test]
    fn claims_print_in_jose_order() {
        let claims = session_claims(
            vec![
                ("user_id", json!(2)),
                ("email", json!("alice@example.com")),
                ("username", json!("alice@example.com")),
            ],
            "access",
            1_794_077_808.0,
            600.0,
        );
        let payload = TS_TOKEN.split('.').nth(1).unwrap();
        assert_eq!(
            encode(json::stringify(&Value::Object(claims)).as_bytes()),
            payload
        );
    }

    #[test]
    fn decoding_is_forgiving_like_atob() {
        assert_eq!(decode_base64url("eyJhIjoxfQ").unwrap(), br#"{"a":1}"#);
        assert_eq!(decode_base64url("eyJhIjoxfQ==").unwrap(), br#"{"a":1}"#);
        assert!(decode_base64url("e").is_none());
        assert!(decode_base64url("e$").is_none());
    }
}
