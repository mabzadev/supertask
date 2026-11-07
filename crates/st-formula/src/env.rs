//! The clock and randomness formulas read.
//!
//! `now()`, `today()`, `random_*()` and `generate_uuid()` are the only parts of
//! the engine that depend on the outside world. They go through
//! [`Environment`] because the crate also runs on `wasm32-unknown-unknown`,
//! where `std` has neither a clock nor a random source: the Worker and the app
//! plug in `Date.now()` and `crypto.getRandomValues()` there, and tests pin
//! both to get reproducible results.

/// What the evaluator asks the host for.
pub trait Environment {
    /// The current time in milliseconds since the Unix epoch (`Date.now()`).
    fn now_ms(&mut self) -> f64;

    /// 64 uniformly random bits.
    ///
    /// `generate_uuid()` is built from these, so hosts that need unguessable
    /// identifiers should back this with a cryptographic source.
    fn random_u64(&mut self) -> u64;

    /// The offset from UTC, in milliseconds, of the IANA time zone `zone` at
    /// the instant `utc_ms`, or `None` for a name `Intl.DateTimeFormat`
    /// rejects. Names are case-insensitive; offset names such as `+01:00` are
    /// handled by the engine and never reach this method.
    ///
    /// The default reads the database bundled with the `tzdb` feature (and
    /// knows no zone without it). A host with `Intl` can answer from it
    /// instead: that is V8's own data, and it lets the build drop the feature.
    fn time_zone_offset_ms(&mut self, zone: &str, utc_ms: f64) -> Option<f64> {
        crate::date::bundled_offset_ms(zone, utc_ms)
    }
}

/// `Math.random()`: a double in `[0, 1)` from 53 random bits.
pub(crate) fn random_f64(env: &mut dyn Environment) -> f64 {
    (env.random_u64() >> 11) as f64 / (1u64 << 53) as f64
}

/// `crypto.randomUUID()`: a version 4 UUID in lowercase hex.
pub(crate) fn random_uuid(env: &mut dyn Environment) -> String {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&env.random_u64().to_be_bytes());
    bytes[8..].copy_from_slice(&env.random_u64().to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// A fixed clock and a seeded SplitMix64 generator: reproducible evaluations,
/// for tests and for type inference (whose result never depends on them).
#[derive(Clone, Debug)]
pub struct FixedEnvironment {
    now_ms: f64,
    state: u64,
}

impl FixedEnvironment {
    pub fn new(now_ms: f64, seed: u64) -> Self {
        FixedEnvironment {
            now_ms,
            state: seed,
        }
    }
}

impl Default for FixedEnvironment {
    /// The Unix epoch and seed 0.
    fn default() -> Self {
        FixedEnvironment::new(0.0, 0)
    }
}

impl Environment for FixedEnvironment {
    fn now_ms(&mut self) -> f64 {
        self.now_ms
    }

    fn random_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

/// The system clock, with a generator seeded from it. Not available on
/// `wasm32-unknown-unknown`, which has no clock.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[derive(Clone, Debug)]
pub struct SystemEnvironment {
    random: FixedEnvironment,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
impl SystemEnvironment {
    pub fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos() as u64);
        SystemEnvironment {
            random: FixedEnvironment::new(0.0, seed),
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
impl Default for SystemEnvironment {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
impl Environment for SystemEnvironment {
    fn now_ms(&mut self) -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
    }

    fn random_u64(&mut self) -> u64 {
        self.random.random_u64()
    }
}
