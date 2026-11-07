//! `POST /api/user/token-auth/` (`src/routes/user.ts`): password login.
//!
//! Ported: the whole common path, including the disabled-provider answer,
//! `last_login` and audit writes, and the three session tokens. Forwarded
//! (before any write but the idempotent provider row): accounts with an
//! enabled 2FA device, bodies the TS code would reject with a 500, and hashes
//! the Rust verifier does not reproduce exactly.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use worker::{Context, Env, Request, web_sys};

use super::auth::{now_iso, now_seconds, signing_key};
use super::db::{Db, Param};
use super::http::{json_response, string_binding};
use crate::fallback::{ApiError, Failure, Outcome};
use crate::fields::Row;
use crate::password::verify_password;
use crate::{js, json, jwt};

/// `parseInt(env.VAR || fallback, 10)`.
fn int_var(env: &Env, name: &str, fallback: &str) -> f64 {
    let raw = string_binding(env, name)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.to_owned());
    js::parse_int(&raw)
}

/// jose's `secs(\`${n}${unit}\`)` for the integer `parseInt` produced.
fn ttl_seconds(n: f64, unit_seconds: f64) -> Outcome<f64> {
    // `${NaN}m` and `${1e21}m` do not match jose's duration grammar: it throws.
    if !n.is_finite() || n.abs() >= 1e21 {
        return Err(Failure::Internal("invalid JWT TTL setting".into()));
    }
    Ok(n.signum() * (n.abs() * unit_seconds).round())
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// `serializeUser(user, profile)`.
fn serialize_user(user: &Row, profile: Option<&Row>) -> Outcome<Value> {
    let get = |key: &str| user.get(key).cloned();
    let profile_get = |key: &str| {
        profile
            .and_then(|p| p.get(key))
            .filter(|v| !v.is_null())
            .cloned()
    };
    let names: Vec<String> = [user.get("first_name"), user.get("last_name")]
        .into_iter()
        .flatten()
        .filter(|v| js::truthy(v))
        .map(js::to_js_string)
        .collect();
    let name = if names.join(" ").is_empty() {
        get("email").unwrap_or(Value::Null)
    } else {
        Value::String(names.join(" "))
    };
    let tours = match profile
        .and_then(|p| p.get("completed_guided_tours"))
        .filter(|v| js::truthy(v))
    {
        None => json!(["sidebar", "database", "builder", "automation"]),
        Some(value) => match json::parse(&js::to_js_string(value)) {
            Ok(Value::Array(items)) => {
                Value::Array(items.into_iter().filter(Value::is_string).collect())
            }
            Ok(_) | Err(json::ParseError::Invalid) => json!([]),
            Err(json::ParseError::Unsupported) => {
                return Err(Failure::Internal("completed_guided_tours JSON".into()));
            }
        },
    };
    let flag = |value: Option<&Value>| Value::Bool(js::truthy_opt(value));
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    put("id", get("id"));
    put("username", get("username"));
    put("name", Some(name));
    put("first_name", get("first_name"));
    put("last_name", get("last_name"));
    put("email", get("email"));
    put("is_staff", Some(flag(user.get("is_staff"))));
    put("is_active", Some(flag(user.get("is_active"))));
    put(
        "can_create_accounts",
        Some(Value::Bool(
            js::truthy_opt(user.get("is_staff")) || js::truthy_opt(user.get("can_create_accounts")),
        )),
    );
    put(
        "language",
        Some(profile_get("language").unwrap_or(json!("en"))),
    );
    put(
        "timezone",
        Some(profile_get("timezone").unwrap_or(Value::Null)),
    );
    put(
        "email_notification_frequency",
        Some(profile_get("email_notification_frequency").unwrap_or(json!("instant"))),
    );
    put(
        "completed_onboarding",
        Some(flag(profile.and_then(|p| p.get("completed_onboarding")))),
    );
    put("completed_guided_tours", Some(tours));
    put(
        "to_be_deleted",
        Some(flag(profile.and_then(|p| p.get("to_be_deleted")))),
    );
    put(
        "email_verified",
        Some(flag(profile.and_then(|p| p.get("email_verified")))),
    );
    put(
        "profile_image_url",
        Some(profile_get("profile_image_url").unwrap_or(Value::Null)),
    );
    put("date_joined", get("date_joined"));
    put("last_login", get("last_login"));
    put(
        "active_licenses",
        Some(json!({
            "instance_wide": { "premium": true, "advanced": true, "enterprise_without_support": true, "enterprise": true },
            "per_workspace": {}
        })),
    );
    Ok(Value::Object(out))
}

/// `authResponse(c, userId)`: fresh tokens and the user as stored after the login writes.
async fn auth_response(env: &Env, db: &Db, user_id: &Value) -> Outcome<Value> {
    let id = Param::from_value(Some(user_id));
    let user = db
        .first(
            "SELECT * FROM auth_user WHERE id = ?",
            std::slice::from_ref(&id),
        )
        .await?;
    let profile = db
        .first("SELECT * FROM core_userprofile WHERE user_id = ?", &[id])
        .await?;
    let Some(user) = user.filter(|u| js::truthy_opt(u.get("is_active"))) else {
        return Err(ApiError::authentication("User not found or inactive.").into());
    };
    let email = user
        .get("email")
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::Internal("user without email".into()))?;
    let normalized = email.to_lowercase();
    let key = signing_key(env)?;
    let minutes = ttl_seconds(int_var(env, "JWT_ACCESS_TTL_MINUTES", "10"), 60.0)?;
    let days = ttl_seconds(int_var(env, "JWT_REFRESH_TTL_DAYS", "7"), 86_400.0)?;
    let user_id_value = user.get("id").cloned().unwrap_or(Value::Null);
    let payload = || {
        vec![
            ("user_id", user_id_value.clone()),
            ("email", Value::String(normalized.clone())),
            ("username", Value::String(normalized.clone())),
        ]
    };
    let access = jwt::sign(
        &jwt::session_claims(payload(), "access", now_seconds(), minutes),
        &key,
    );
    let refresh = jwt::sign(
        &jwt::session_claims(payload(), "refresh", now_seconds(), days),
        &key,
    );
    let session_base = vec![
        ("user_id", Value::String(js::to_js_string(&user_id_value))),
        ("token_hash", Value::String(sha256_hex(&refresh))),
    ];
    let user_session = jwt::sign(
        &jwt::session_claims(session_base, "user_session", now_seconds(), days),
        &key,
    );
    let mut out = Map::new();
    out.insert("access_token".into(), Value::String(access));
    out.insert("refresh_token".into(), Value::String(refresh));
    out.insert("user_session".into(), Value::String(user_session));
    out.insert("permissions".into(), json!([]));
    out.insert("user".into(), serialize_user(&user, profile.as_ref())?);
    Ok(Value::Object(out))
}

/// Before the login writes, a storage failure is replayed against the TS
/// Worker rather than answered: nothing has been written that a replay would
/// duplicate (the provider row is `INSERT OR IGNORE`).
fn before_commit(failure: Failure) -> Failure {
    match failure {
        Failure::Internal(message) => {
            Failure::unsupported(format!("storage error before the login writes: {message}"))
        }
        other => other,
    }
}

fn write_error(message: String) -> Failure {
    Failure::Internal(message)
}

/// `updateUserLastLogin`, with its fallback for databases without `deletion_requested_at`.
async fn update_last_login(db: &Db, user_id: &Value) -> Outcome<()> {
    let id = Param::from_value(Some(user_id));
    db.run(
        "UPDATE auth_user SET last_login = ? WHERE id = ?",
        &[Param::from(now_iso()), id.clone()],
    )
    .await
    .map_err(write_error)?;
    let cleared = db
        .run("UPDATE core_userprofile SET to_be_deleted=0, deletion_requested_at=NULL WHERE user_id=?", std::slice::from_ref(&id))
        .await;
    match cleared {
        Err(message) if message.contains("deletion_requested_at") => db
            .run(
                "UPDATE core_userprofile SET to_be_deleted=0 WHERE user_id=?",
                &[id],
            )
            .await
            .map_err(write_error),
        other => other.map_err(write_error),
    }
}

/// `logAuditEntry(db, "auth.login", { user: auditUserFromRow(row) }, …)`.
async fn log_login(db: &Db, user: &Row) -> Outcome<()> {
    let id = user.get("id").cloned().unwrap_or(Value::Null);
    let email = user.get("email").cloned().unwrap_or(Value::Null);
    let username = if js::truthy_opt(user.get("username")) {
        user.get("username")
    } else {
        user.get("email")
    };
    let user_name = [username, user.get("email")]
        .into_iter()
        .flatten()
        .find(|v| js::truthy(v))
        .map(js::to_js_string)
        .unwrap_or_default();
    let params = json!({ "user_id": id, "email": email });
    db.run(
        "INSERT INTO enterprise_auditlogentry
     (user_id, user_email, user_name, workspace_id, workspace_name, type, timestamp,
      ip_address, action_object_id, action_object_type, action_params)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Param::from_value(Some(&id)),
            if email.is_null() {
                Param::from("")
            } else {
                Param::from_value(Some(&email))
            },
            Param::from(user_name),
            Param::Null,
            Param::from(""),
            Param::from("auth.login"),
            Param::from(now_iso()),
            Param::Null,
            Param::from_value(Some(&id)),
            Param::from("user"),
            Param::from(json::stringify(&params)),
        ],
    )
    .await
    .map_err(write_error)
}

/// The handler. Returns [`Failure::Unsupported`] only before the login writes.
pub async fn handle(mut req: Request, env: &Env, _ctx: &Context) -> Outcome<web_sys::Response> {
    let bytes = req
        .bytes()
        .await
        .map_err(|e| Failure::unsupported(format!("unreadable body: {e}")))?;
    let text = String::from_utf8(bytes).map_err(|_| Failure::unsupported("body is not UTF-8"))?;
    let body = json::parse(&text).map_err(|_| Failure::unsupported("body is not JSON"))?;
    if body.is_null() {
        return Err(Failure::unsupported("null body"));
    }
    let (email, password) = (js::get(&body, "email"), js::get(&body, "password"));
    if !js::truthy_opt(email) || !js::truthy_opt(password) {
        let error = ApiError::new(
            400,
            "INVALID_CREDENTIALS",
            "Email and password are required.",
        );
        return json_response(env, error.status, &error.body())
            .map_err(|e| Failure::Internal(e.to_string()));
    }
    let (Some(Value::String(email)), Some(Value::String(password))) = (email, password) else {
        return Err(Failure::unsupported("non-string credentials"));
    };

    let db = Db::new(env)?;
    let user = db
        .first(
            "SELECT * FROM auth_user WHERE email = ? COLLATE NOCASE",
            &[Param::from(email.as_str())],
        )
        .await
        .map_err(before_commit)?;
    let Some(user) = user else {
        return Err(ApiError::authentication("Invalid credentials.").into());
    };
    let Some(Value::String(stored)) = user.get("password") else {
        return Err(Failure::unsupported("password hash is not a string"));
    };
    if !verify_password(password, stored)? {
        return Err(ApiError::authentication("Invalid credentials.").into());
    }
    if !js::truthy_opt(user.get("is_active")) {
        return Err(ApiError::authentication("Account is disabled.").into());
    }

    db.run(
        "INSERT OR IGNORE INTO core_authprovider (type, enabled, domain, metadata)
     SELECT 'password', 1, NULL, '{}'
      WHERE NOT EXISTS (SELECT 1 FROM core_authprovider WHERE type='password')",
        &[],
    )
    .await
    .map_err(Failure::Internal)
    .map_err(before_commit)?;
    let provider = db
        .first(
            "SELECT * FROM core_authprovider WHERE type='password' ORDER BY id ASC LIMIT 1",
            &[],
        )
        .await
        .map_err(before_commit)?;
    let Some(provider) = provider else {
        return Err(Failure::Internal(
            "The password authentication provider could not be initialized.".into(),
        ));
    };
    if !js::truthy_opt(provider.get("enabled")) && !js::truthy_opt(user.get("is_staff")) {
        let error = ApiError::new(
            401,
            "ERROR_AUTH_PROVIDER_DISABLED",
            "Authentication provider is disabled.",
        );
        return Err(error.into());
    }

    let user_id = user.get("id").cloned().unwrap_or(Value::Null);
    let two_factor = db
        .first(
            "SELECT id, enabled FROM core_twofactorauthenticationdevice WHERE user_id=? AND enabled=1",
            &[Param::from_value(Some(&user_id))],
        )
        .await
        .map_err(before_commit)?;
    if two_factor.is_some() {
        return Err(Failure::unsupported("two-factor challenge"));
    }

    // From here on the login is committed: failures are 500s, never replays.
    let committed = async {
        update_last_login(&db, &user_id).await?;
        log_login(&db, &user).await?;
        auth_response(env, &db, &user_id).await
    };
    match committed.await {
        Ok(payload) => {
            json_response(env, 200, &payload).map_err(|e| Failure::Internal(e.to_string()))
        }
        Err(Failure::Unsupported(reason)) => Err(Failure::Internal(reason.into_owned())),
        Err(other) => Err(other),
    }
}
