//! Differential tests: every case is sent to the TypeScript Worker and to the
//! Rust Worker (both under `wrangler dev`, sharing one local D1), and their
//! answers are compared. A route only moves to Rust once its cases are green
//! (`docs/plan-reecriture-rust.md`, "Stratégie de migration").
//!
//! Read-only cases must match byte for byte. Logins carry fresh tokens and
//! timestamps, so their tokens are decoded and compared by claims (same
//! claims, same TTLs, a `token_hash` that matches the refresh token). Writes
//! hit the shared database twice, so they compare shapes with ids masked.
//!
//! Usage: `cargo run -p st-difftest` (`ST_TS_URL`, `ST_RS_URL` override the
//! default `http://127.0.0.1:8811` and `http://127.0.0.1:8812`). Exits 1 on
//! any difference.

mod ws;

use std::fmt::Write as _;
use std::process::ExitCode;
use std::time::Duration;

use base64::Engine;
use reqwest::{Client, Method};
use serde_json::{Map, Value, json};

const USERS: [&str; 5] = ["alice", "bruno", "chloe", "david", "emma"];
const PASSWORD: &str = "Supertask-test-2026";
/// Pause after each write, so the other `wrangler dev` process can take the D1 lock.
const WRITE_SETTLE: Duration = Duration::from_millis(400);
/// Headers whose value must be identical on both sides when present on either.
const COMPARED_HEADERS: [&str; 7] = [
    "content-type",
    "access-control-allow-origin",
    "access-control-expose-headers",
    "set-cookie",
    "vary",
    "cache-control",
    "content-disposition",
];

/// How two answers are compared.
#[derive(Clone, Copy, PartialEq)]
enum Check {
    /// Status, compared headers and body bytes.
    Exact,
    /// Login: tokens compared by decoded claims, `last_login` masked.
    Login,
    /// Writes: ids, timestamps, uuids and the listed keys (autonumbers) masked.
    Shape(&'static [&'static str]),
}

/// One HTTP exchange.
struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn json(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

struct Case {
    name: String,
    method: Method,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    check: Check,
}

impl Case {
    fn get(name: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            method: Method::GET,
            path: path.into(),
            headers: Vec::new(),
            body: None,
            check: Check::Exact,
        }
    }

    fn post(
        name: impl Into<String>,
        path: impl Into<String>,
        body: impl Into<String>,
        check: Check,
    ) -> Self {
        let mut case = Self::get(name, path);
        case.method = Method::POST;
        case.headers
            .push(("Content-Type".into(), "application/json".into()));
        case.body = Some(body.into());
        case.check = check;
        case
    }

    fn auth(mut self, value: impl Into<String>) -> Self {
        self.headers.push(("Authorization".into(), value.into()));
        self
    }
}

/// The outcome of one case.
struct Outcome {
    name: String,
    differences: Vec<String>,
    /// `rust` when the Rust Worker answered itself, `legacy` when it forwarded.
    served_by: &'static str,
    /// Status of the TS answer, for the report.
    status: Option<u16>,
}

struct Bench {
    client: Client,
    ts: String,
    rs: String,
}

impl Bench {
    async fn send(&self, base: &str, case: &Case) -> Result<Answer, String> {
        let mut request = self
            .client
            .request(case.method.clone(), format!("{base}{}", case.path));
        for (name, value) in &case.headers {
            request = request.header(name, value);
        }
        if let Some(body) = &case.body {
            request = request.body(body.clone());
        }
        let response = request.send().await.map_err(|e| format!("{base}: {e}"))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_ascii_lowercase(),
                    v.to_str().unwrap_or("<binary>").to_owned(),
                )
            })
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|e| format!("{base}: {e}"))?
            .to_vec();
        if case.method != Method::GET {
            // Both Workers write one local D1 file from two workerd processes; a
            // write right after the other process's write fails with SQLITE_BUSY.
            tokio::time::sleep(WRITE_SETTLE).await;
        }
        Ok(Answer {
            status,
            headers,
            body,
        })
    }

    /// Sends the case to both Workers (TS first) and compares.
    async fn run(&self, case: &Case) -> (Outcome, Option<(Answer, Answer)>) {
        let (ts, rs) = match (
            self.send(&self.ts, case).await,
            self.send(&self.rs, case).await,
        ) {
            (Ok(ts), Ok(rs)) => (ts, rs),
            (ts, rs) => {
                let errors = [ts.err(), rs.err()].into_iter().flatten().collect();
                return (
                    Outcome {
                        name: case.name.clone(),
                        differences: errors,
                        served_by: "?",
                        status: None,
                    },
                    None,
                );
            }
        };
        let served_by = if rs.header("x-supertask-backend") == Some("rust") {
            "rust"
        } else {
            "legacy"
        };
        let differences = compare(case.check, &ts, &rs);
        (
            Outcome {
                name: case.name.clone(),
                differences,
                served_by,
                status: Some(ts.status),
            },
            Some((ts, rs)),
        )
    }
}

fn compare(check: Check, ts: &Answer, rs: &Answer) -> Vec<String> {
    let mut differences = Vec::new();
    if ts.status != rs.status {
        differences.push(format!("status: ts {} / rs {}", ts.status, rs.status));
    }
    for name in COMPARED_HEADERS {
        if ts.header(name) != rs.header(name) {
            differences.push(format!(
                "header {name}: ts {:?} / rs {:?}",
                ts.header(name),
                rs.header(name)
            ));
        }
    }
    match check {
        Check::Exact => {
            if ts.body != rs.body {
                differences.push(body_difference(&ts.body, &rs.body));
            }
        }
        Check::Login | Check::Shape(_) => match (ts.json(), rs.json()) {
            (Some(a), Some(b)) => {
                let normalize = |value| match check {
                    Check::Shape(extra) => mask_volatile(value, extra),
                    _ => normalize_login(value),
                };
                let (a, b) = (normalize(a), normalize(b));
                if a != b {
                    differences.push(format!(
                        "normalized JSON differs: {}",
                        first_json_difference(&a, &b, "$")
                    ));
                }
            }
            _ if ts.body != rs.body => differences.push(body_difference(&ts.body, &rs.body)),
            _ => {}
        },
    }
    differences
}

fn body_difference(ts: &[u8], rs: &[u8]) -> String {
    let at = ts
        .iter()
        .zip(rs)
        .position(|(a, b)| a != b)
        .unwrap_or(ts.len().min(rs.len()));
    let excerpt = |body: &[u8]| {
        String::from_utf8_lossy(&body[at.saturating_sub(40)..(at + 80).min(body.len())])
            .into_owned()
    };
    format!(
        "body differs at byte {at} (ts {} bytes, rs {} bytes)\n      ts: …{}\n      rs: …{}",
        ts.len(),
        rs.len(),
        excerpt(ts),
        excerpt(rs)
    )
}

fn first_json_difference(a: &Value, b: &Value, path: &str) -> String {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys_a: Vec<&String> = x.keys().collect();
            let keys_b: Vec<&String> = y.keys().collect();
            if keys_a != keys_b {
                return format!("{path}: keys ts {keys_a:?} / rs {keys_b:?}");
            }
            x.iter()
                .find_map(|(k, v)| {
                    (v != &y[k]).then(|| first_json_difference(v, &y[k], &format!("{path}.{k}")))
                })
                .unwrap_or_default()
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (v, w))| {
                (v != w).then(|| first_json_difference(v, w, &format!("{path}[{i}]")))
            })
            .unwrap_or_default(),
        _ => format!("{path}: ts {a} / rs {b}"),
    }
}

/// Decodes a JWT's header and claims.
fn decode_jwt(token: &str) -> Option<(Value, Map<String, Value>)> {
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut parts = token.split('.');
    let header = serde_json::from_slice(&engine.decode(parts.next()?).ok()?).ok()?;
    let claims = serde_json::from_slice::<Value>(&engine.decode(parts.next()?).ok()?).ok()?;
    Some((header, claims.as_object()?.clone()))
}

fn sha256_hex(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .fold(String::new(), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// Replaces a token by its header and claims, with `iat`/`exp` turned into a TTL.
fn token_shape(token: &str, refresh: Option<&str>) -> Value {
    let Some((header, mut claims)) = decode_jwt(token) else {
        return json!("<not a JWT>");
    };
    let iat = claims.get("iat").and_then(Value::as_i64);
    let exp = claims.get("exp").and_then(Value::as_i64);
    if let (Some(iat), Some(exp)) = (iat, exp) {
        claims.insert("iat".into(), json!("<now>"));
        claims.insert("exp".into(), json!(format!("<now + {}s>", exp - iat)));
    }
    if let Some(hash) = claims.get("token_hash").and_then(Value::as_str) {
        let matches = refresh.is_some_and(|r| sha256_hex(r) == hash);
        claims.insert(
            "token_hash".into(),
            json!(if matches {
                "<sha256 of refresh_token>"
            } else {
                "<WRONG HASH>"
            }),
        );
    }
    json!({ "header": header, "claims": claims })
}

fn normalize_login(mut value: Value) -> Value {
    let refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(object) = value.as_object_mut() {
        for key in ["access_token", "refresh_token", "user_session", "token"] {
            if let Some(Value::String(token)) = object.get(key).cloned() {
                object.insert(key.into(), token_shape(&token, refresh.as_deref()));
            }
        }
        if let Some(user) = object.get_mut("user").and_then(Value::as_object_mut)
            && user.get("last_login").is_some_and(Value::is_string)
        {
            user.insert("last_login".into(), json!("<timestamp>"));
        }
    }
    value
}

fn looks_like_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 20 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && s.ends_with('Z')
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Masks what differs between two writes of the same thing.
fn mask_volatile(value: Value, extra: &[&str]) -> Value {
    fn mask(key: Option<&str>, value: Value, extra: &[&str]) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(k, v)| {
                        let masked = mask(Some(&k), v, extra);
                        (k, masked)
                    })
                    .collect(),
            ),
            Value::Array(items) => {
                Value::Array(items.into_iter().map(|v| mask(None, v, extra)).collect())
            }
            Value::String(s) if looks_like_timestamp(&s) => json!("<timestamp>"),
            Value::String(s) if looks_like_uuid(&s) => json!("<uuid>"),
            Value::String(s) if s.starts_with("eyJ") && s.matches('.').count() == 2 => {
                json!("<jwt>")
            }
            Value::Number(_) if matches!(key, Some("id" | "order" | "row_id")) => json!("<n>"),
            Value::Number(_) if key.is_some_and(|k| extra.contains(&k)) => json!("<n>"),
            Value::String(_) if key == Some("order") => json!("<n>"),
            other => other,
        }
    }
    mask(None, value, extra)
}

struct Report {
    outcomes: Vec<Outcome>,
}

impl Report {
    fn add(&mut self, outcome: Outcome) {
        let mark = if outcome.differences.is_empty() {
            "ok  "
        } else {
            "DIFF"
        };
        let status = outcome
            .status
            .map_or_else(|| "   ".to_owned(), |s| s.to_string());
        println!(
            "  {mark} [{:<6}] {status} {}",
            outcome.served_by, outcome.name
        );
        for difference in &outcome.differences {
            println!("         {difference}");
        }
        self.outcomes.push(outcome);
    }

    fn failed(&self) -> usize {
        self.outcomes
            .iter()
            .filter(|o| !o.differences.is_empty())
            .count()
    }
}

async fn login(bench: &Bench, base: &str, user: &str) -> Result<String, String> {
    let case = Case::post(
        "login",
        "/api/user/token-auth/",
        format!(r#"{{"email":"{user}@example.com","password":"{PASSWORD}"}}"#),
        Check::Login,
    );
    let answer = bench.send(base, &case).await?;
    answer
        .json()
        .and_then(|v| {
            v.get("access_token")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| format!("login of {user} on {base} failed with {}", answer.status))
}

#[tokio::main]
async fn main() -> ExitCode {
    let bench = Bench {
        client: Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .expect("HTTP client"),
        ts: std::env::var("ST_TS_URL").unwrap_or_else(|_| "http://127.0.0.1:8811".into()),
        rs: std::env::var("ST_RS_URL").unwrap_or_else(|_| "http://127.0.0.1:8812".into()),
    };
    println!("Differential tests: TS {} vs Rust {}\n", bench.ts, bench.rs);
    let mut report = Report {
        outcomes: Vec::new(),
    };
    match run_all(&bench, &mut report).await {
        Ok(()) => {}
        Err(error) => {
            println!("\nABORTED: {error}");
            return ExitCode::FAILURE;
        }
    }
    let rust = report
        .outcomes
        .iter()
        .filter(|o| o.served_by == "rust")
        .count();
    let mut summary = String::new();
    let _ = write!(
        summary,
        "\n{} cases, {} identical, {} different ({} answered by Rust, {} forwarded to the TS Worker)",
        report.outcomes.len(),
        report.outcomes.len() - report.failed(),
        report.failed(),
        rust,
        report.outcomes.len() - rust
    );
    println!("{summary}");
    if report.failed() == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

async fn run_all(bench: &Bench, report: &mut Report) -> Result<(), String> {
    println!("Login (POST /api/user/token-auth/)");
    for user in USERS {
        let case = Case::post(
            format!("login {user}"),
            "/api/user/token-auth/",
            format!(r#"{{"email":"{user}@example.com","password":"{PASSWORD}"}}"#),
            Check::Login,
        );
        report.add(bench.run(&case).await.0);
    }
    let odd_logins = [
        (
            "wrong password",
            r#"{"email":"alice@example.com","password":"nope"}"#,
        ),
        (
            "unknown email",
            r#"{"email":"nobody@example.com","password":"x"}"#,
        ),
        (
            "email in capitals",
            r#"{"email":"ALICE@Example.com","password":"Supertask-test-2026"}"#,
        ),
        ("missing password", r#"{"email":"alice@example.com"}"#),
        (
            "empty password",
            r#"{"email":"alice@example.com","password":""}"#,
        ),
        ("empty object", "{}"),
        ("array body", "[]"),
        ("invalid JSON (forwarded)", "{not json"),
        (
            "numeric password (forwarded)",
            r#"{"email":"alice@example.com","password":12}"#,
        ),
    ];
    for (name, body) in odd_logins {
        report.add(
            bench
                .run(&Case::post(
                    format!("login: {name}"),
                    "/api/user/token-auth/",
                    body,
                    Check::Login,
                ))
                .await
                .0,
        );
    }

    let mut ts_tokens = Vec::new();
    let mut rs_tokens = Vec::new();
    for user in USERS {
        ts_tokens.push(login(bench, &bench.ts, user).await?);
        rs_tokens.push(login(bench, &bench.rs, user).await?);
    }

    println!("\nTokens issued by one Worker, used on the other");
    for (index, user) in USERS.iter().enumerate() {
        // Rust token on a TS-only route, TS token on a Rust-ported route.
        let on_ts = Case::get(
            format!("Rust token of {user} accepted by TS (GET /api/workspaces/)"),
            "/api/workspaces/",
        )
        .auth(format!("JWT {}", rs_tokens[index]));
        let answer = bench.send(&bench.ts, &on_ts).await?;
        let differences = if answer.status == 200 {
            vec![]
        } else {
            vec![format!("TS answered {}", answer.status)]
        };
        report.add(Outcome {
            name: on_ts.name,
            differences,
            served_by: "legacy",
            status: Some(answer.status),
        });
        let on_rs = Case::get(
            format!("TS token of {user} on both Workers (rows of table 1)"),
            "/api/database/rows/table/1/?size=3",
        )
        .auth(format!("JWT {}", ts_tokens[index]));
        report.add(bench.run(&on_rs).await.0);
    }

    println!("\nRow listing (GET /api/database/rows/table/:id/)");
    let variants = [
        "",
        "?size=2",
        "?size=3&page=2",
        "?size=7&page=3",
        "?size=1000",
        "?page=99",
        "?size=0",
        "?size=abc&page=-1",
        "?size=2.0&page=1e0",
        "?user_field_names=true&size=5",
        "?user_field_names&order_by=-field_1",
        "?order_by=Nom,-Ville&user_field_names=1",
        "?search=a&size=4",
        "?search=%25&size=4",
        "?filter__field_1__contains=a (forwarded)",
        "?include=row_metadata (forwarded)",
    ];
    let users = [(0, "alice"), (3, "david"), (4, "emma"), (1, "bruno")];
    for table in 1..=8 {
        for variant in variants {
            let query = variant.split(' ').next().unwrap_or_default();
            let (index, user) = users[(table + variant.len()) % users.len()];
            let case = Case::get(
                format!("table {table}{variant} as {user}"),
                format!("/api/database/rows/table/{table}/{query}"),
            )
            .auth(format!("JWT {}", ts_tokens[index]));
            report.add(bench.run(&case).await.0);
        }
    }
    for (path, name) in [
        ("/api/database/rows/table/999/", "unknown table"),
        ("/api/database/rows/table/0/", "table 0"),
        (
            "/api/database/rows/table/007/?size=2",
            "table id with leading zeros",
        ),
        (
            "/api/database/rows/table/abc/",
            "non-numeric table (forwarded)",
        ),
    ] {
        report.add(
            bench
                .run(&Case::get(name, path).auth(format!("JWT {}", ts_tokens[0])))
                .await
                .0,
        );
    }
    report.add(
        bench
            .run(&Case::get("anonymous", "/api/database/rows/table/1/"))
            .await
            .0,
    );
    report.add(
        bench
            .run(&Case::get("invalid JWT", "/api/database/rows/table/1/").auth("JWT abc.def.ghi"))
            .await
            .0,
    );
    report.add(
        bench
            .run(
                &Case::get(
                    "refresh token instead of access",
                    "/api/database/rows/table/1/",
                )
                .auth(format!("JWT {}", refresh_of(bench, "alice").await?)),
            )
            .await
            .0,
    );
    report.add(
        bench
            .run(
                &Case::get("unknown database token", "/api/database/rows/table/1/")
                    .auth("Token nope"),
            )
            .await
            .0,
    );

    println!("\nDatabase tokens");
    let tokens = create_database_tokens(bench, &ts_tokens[0]).await?;
    for (key, label) in [
        (&tokens.0.1, "token read:[table 1]"),
        (&tokens.1.1, "token read:all"),
    ] {
        for table in [1, 2, 4] {
            let case = Case::get(
                format!("{label} on table {table}"),
                format!("/api/database/rows/table/{table}/?size=2"),
            )
            .auth(format!("Token {key}"));
            report.add(bench.run(&case).await.0);
        }
        let bearer = Case::get(
            format!("{label} as Bearer"),
            "/api/database/rows/table/1/?size=1",
        )
        .auth(format!("Bearer {key}"));
        report.add(bench.run(&bearer).await.0);
    }
    for (id, _) in [&tokens.0, &tokens.1] {
        let delete = Case {
            method: Method::DELETE,
            ..Case::get("delete token", format!("/api/database/tokens/{id}/"))
                .auth(format!("JWT {}", ts_tokens[0]))
        };
        bench.send(&bench.ts, &delete).await?;
    }

    println!("\nForwarded routes");
    let forwarded = [
        Case::get("GET /api/workspaces/", "/api/workspaces/").auth(format!("JWT {}", ts_tokens[0])),
        Case::get("GET /api/applications/", "/api/applications/")
            .auth(format!("JWT {}", ts_tokens[2])),
        Case::get(
            "GET /api/database/fields/table/1/",
            "/api/database/fields/table/1/",
        )
        .auth(format!("JWT {}", ts_tokens[0])),
        Case::get("GET unknown route", "/api/does-not-exist/"),
        Case::get(
            "GET rows without trailing slash",
            "/api/database/rows/table/1",
        )
        .auth(format!("JWT {}", ts_tokens[0])),
        Case {
            method: Method::OPTIONS,
            ..Case::get("OPTIONS preflight", "/api/user/token-auth/")
        }
        .header("Origin", "https://example.test")
        .header("Access-Control-Request-Method", "POST"),
    ];
    for case in &forwarded {
        report.add(bench.run(case).await.0);
    }

    println!("\nWrites (forwarded, compared by shape)");
    let writes = [
        (
            6,
            &[][..],
            "?user_field_names=true",
            r#"{"Titre":"difftest","Reproductible":true,"Signalé par":"qa@example.com"}"#,
        ),
        (
            1,
            // N° (autonumber): each insert takes the next value.
            &["field_13"][..],
            "",
            r#"{"field_1":"difftest","field_9":true,"field_16":[1]}"#,
        ),
    ];
    for (table, masked, query, body) in writes {
        let create = Case::post(
            format!("POST create row in table {table}{query}"),
            format!("/api/database/rows/table/{table}/{query}"),
            body,
            Check::Shape(masked),
        )
        .auth(format!("JWT {}", ts_tokens[0]));
        let (mut outcome, answers) = bench.run(&create).await;
        if let Some((ts, rs)) = answers {
            // A write both sides refuse would compare equal without testing anything.
            if ts.status != 200 {
                outcome.differences.push(format!(
                    "the write itself failed: TS answered {}",
                    ts.status
                ));
            }
            for answer in [ts, rs] {
                if let Some(id) = answer
                    .json()
                    .and_then(|v| v.get("id").and_then(Value::as_i64))
                {
                    let delete = Case {
                        method: Method::DELETE,
                        ..Case::get(
                            "delete row",
                            format!("/api/database/rows/table/{table}/{id}/"),
                        )
                        .auth(format!("JWT {}", ts_tokens[0]))
                    };
                    bench.send(&bench.ts, &delete).await?;
                }
            }
        }
        report.add(outcome);
    }

    println!("\nWebSockets through the Rust Worker");
    for outcome in ws::run(&bench.ts, &bench.rs, &ts_tokens[0]).await {
        report.add(outcome);
    }
    Ok(())
}

impl Case {
    fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

async fn refresh_of(bench: &Bench, user: &str) -> Result<String, String> {
    let case = Case::post(
        "login",
        "/api/user/token-auth/",
        format!(r#"{{"email":"{user}@example.com","password":"{PASSWORD}"}}"#),
        Check::Login,
    );
    let answer = bench.send(&bench.ts, &case).await?;
    answer
        .json()
        .and_then(|v| {
            v.get("refresh_token")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| "no refresh token".into())
}

type Token = (i64, String);

/// Two database tokens of alice in workspace 1: read on table 1 only, and read on everything.
async fn create_database_tokens(bench: &Bench, jwt: &str) -> Result<(Token, Token), String> {
    let mut created = Vec::new();
    for permissions in [json!({ "read": [["table", 1]] }), json!({ "read": true })] {
        let body = json!({ "name": "st-difftest", "workspace": 1, "permissions": permissions })
            .to_string();
        let case = Case::post("create token", "/api/database/tokens/", body, Check::Exact)
            .auth(format!("JWT {jwt}"));
        let answer = bench.send(&bench.ts, &case).await?;
        let value = answer.json().ok_or("token creation returned no JSON")?;
        let id = value
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("token creation failed: {value}"))?;
        let key = value
            .get("key")
            .and_then(Value::as_str)
            .ok_or("token without key")?
            .to_owned();
        created.push((id, key));
    }
    let second = created.pop().ok_or("missing token")?;
    let first = created.pop().ok_or("missing token")?;
    Ok((first, second))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn masks_volatile_values() {
        let value = json!({ "id": 4, "order": "40000", "a": "2026-11-07T08:31:07.231Z", "b": "95d0d598-83d5-4e57-8b9f-7a2624704388" });
        assert_eq!(
            mask_volatile(value, &[]),
            json!({ "id": "<n>", "order": "<n>", "a": "<timestamp>", "b": "<uuid>" })
        );
    }
}
