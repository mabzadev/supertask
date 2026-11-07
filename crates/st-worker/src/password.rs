//! `verifyPassword` of `src/services/user.ts`, including its quirks.
//!
//! The TS code checks `pbkdf2_sha256$iter$salt$hash` with a *hex* salt and a
//! hex hash, whatever wrote the hash (so a Django `pbkdf2_sha256` hash with a
//! text salt never matches there), and sends other `pbkdf2_*` hashes to a
//! Django-style verifier that uses SHA-1 and base64 parts. Inputs the TS code
//! would turn into a 500 (WebCrypto refusing more than 100 000 iterations, an
//! empty salt, invalid base64) are reported as unsupported so the request is
//! replayed against the TS Worker instead of being guessed.

use pbkdf2::pbkdf2_hmac;
use sha1::Sha1;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::fallback::{Failure, Outcome};
use crate::js;
use crate::jwt::forgiving_base64_decode;

/// Workers' WebCrypto rejects PBKDF2 above this iteration count.
const MAX_WEBCRYPTO_ITERATIONS: f64 = 100_000.0;

fn iterations(text: &str) -> Outcome<u32> {
    let n = js::parse_int(text);
    if !(1.0..=MAX_WEBCRYPTO_ITERATIONS).contains(&n) {
        return Err(Failure::unsupported(
            "PBKDF2 iteration count WebCrypto rejects",
        ));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(n as u32)
}

/// `verifyPassword(password, stored)`.
pub fn verify_password(password: &str, stored: &str) -> Outcome<bool> {
    if stored.starts_with("pbkdf2_sha256$") {
        let parts: Vec<&str> = stored.split('$').collect();
        let [_, iter_text, salt_hex, stored_hash] = parts[..] else {
            return Ok(false);
        };
        let rounds = iterations(iter_text)?;
        // Only clean hex is decoded here; the TS regex/parseInt path on other
        // salts (NaN bytes become 0, odd lengths drop a char) is left to TS.
        if salt_hex.is_empty()
            || salt_hex.len() % 2 != 0
            || !salt_hex.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(Failure::unsupported("non-hex PBKDF2 salt"));
        }
        let salt =
            hex::decode(salt_hex).map_err(|_| Failure::unsupported("non-hex PBKDF2 salt"))?;
        let mut derived = [0u8; 32];
        pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, rounds, &mut derived);
        let hash_hex = hex::encode(derived);
        return Ok(hash_hex.len() == stored_hash.len()
            && bool::from(hash_hex.as_bytes().ct_eq(stored_hash.as_bytes())));
    }
    if stored.contains('$') {
        return verify_django(password, stored);
    }
    Ok(false)
}

/// `verifyDjangoPBKDF2`: reached only for algorithms other than `pbkdf2_sha256`, hence SHA-1.
fn verify_django(password: &str, encoded: &str) -> Outcome<bool> {
    let parts: Vec<&str> = encoded.split('$').collect();
    let [algo, iter_text, b64_salt, b64_hash] = parts[..] else {
        return Ok(false);
    };
    if !algo.starts_with("pbkdf2_") {
        return Ok(false);
    }
    let rounds = iterations(iter_text)?;
    let salt = forgiving_base64_decode(b64_salt)
        .ok_or_else(|| Failure::unsupported("invalid base64 salt"))?;
    let stored = forgiving_base64_decode(b64_hash)
        .ok_or_else(|| Failure::unsupported("invalid base64 hash"))?;
    if stored.is_empty() {
        return Err(Failure::unsupported("empty PBKDF2 hash"));
    }
    let mut derived = vec![0u8; stored.len()];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), &salt, rounds, &mut derived);
    Ok(bool::from(derived.ct_eq(&stored)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_supertask_hashes() {
        // pbkdf2_sha256, 1000 rounds, salt 00ff, password "secret".
        let mut derived = [0u8; 32];
        pbkdf2_hmac::<Sha256>(b"secret", &[0x00, 0xff], 1000, &mut derived);
        let stored = format!("pbkdf2_sha256$1000$00ff${}", hex::encode(derived));
        assert!(verify_password("secret", &stored).unwrap());
        assert!(!verify_password("Secret", &stored).unwrap());
        assert!(
            !verify_password(
                "secret",
                &stored
                    .to_uppercase()
                    .replace("PBKDF2_SHA256", "pbkdf2_sha256")
            )
            .unwrap()
        );
    }

    #[test]
    fn odd_inputs_are_left_to_the_ts_worker() {
        assert!(matches!(
            verify_password("x", "pbkdf2_sha256$260000$00$aa"),
            Err(Failure::Unsupported(_))
        ));
        assert!(matches!(
            verify_password("x", "pbkdf2_sha256$1000$saltsalt$aa"),
            Err(Failure::Unsupported(_))
        ));
        assert!(!verify_password("x", "pbkdf2_sha256$1000$00").unwrap());
        assert!(!verify_password("x", "plain").unwrap());
        assert!(!verify_password("x", "bcrypt$a$b$c").unwrap());
    }

    #[test]
    fn verifies_django_sha1_hashes() {
        let salt = b"pepper";
        let mut derived = [0u8; 20];
        pbkdf2_hmac::<Sha1>(b"pw", salt, 10, &mut derived);
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let stored = format!(
            "pbkdf2_sha1$10${}${}",
            b64.encode(salt),
            b64.encode(derived)
        );
        assert!(verify_password("pw", &stored).unwrap());
        assert!(!verify_password("pX", &stored).unwrap());
    }
}
