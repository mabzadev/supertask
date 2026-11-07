//! D1 access with the TS code's binding semantics: every parameter is a JS
//! value (numbers stay numbers, so D1 picks INTEGER or REAL the same way).

use serde_json::Value;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Env};

use crate::fallback::{Failure, Outcome};
use crate::fields::Row;

/// A bound SQL parameter.
#[derive(Debug, Clone)]
pub enum Param {
    /// SQL NULL.
    Null,
    /// A JS number.
    Num(f64),
    /// A JS string.
    Text(String),
}

impl Param {
    /// The parameter for a JSON value read from D1 (numbers and strings pass through).
    pub fn from_value(value: Option<&Value>) -> Self {
        match value {
            Some(Value::Number(n)) => Self::Num(n.as_f64().unwrap_or(f64::NAN)),
            Some(Value::String(s)) => Self::Text(s.clone()),
            Some(Value::Bool(b)) => Self::Num(f64::from(u8::from(*b))),
            _ => Self::Null,
        }
    }

    fn to_js(&self) -> JsValue {
        match self {
            Self::Null => JsValue::NULL,
            Self::Num(n) => JsValue::from_f64(*n),
            Self::Text(s) => JsValue::from_str(s),
        }
    }
}

impl From<i64> for Param {
    fn from(n: i64) -> Self {
        // Ids and counts stay far below 2^53.
        #[allow(clippy::cast_precision_loss)]
        Self::Num(n as f64)
    }
}

impl From<f64> for Param {
    fn from(n: f64) -> Self {
        Self::Num(n)
    }
}

impl From<&str> for Param {
    fn from(s: &str) -> Self {
        Self::Text(s.to_owned())
    }
}

impl From<String> for Param {
    fn from(s: String) -> Self {
        Self::Text(s)
    }
}

/// D1 error text, including the SQLite cause the TS code matches on.
pub fn describe(error: &worker::Error) -> String {
    match error {
        worker::Error::D1(d1) => {
            let js: &worker::js_sys::Error = d1.as_ref();
            format!("{} {}", String::from(js.message()), d1.cause())
        }
        other => other.to_string(),
    }
}

fn internal(error: &worker::Error) -> Failure {
    Failure::Internal(describe(error))
}

/// The `DB` binding.
pub struct Db(D1Database);

impl Db {
    /// Opens the `DB` binding.
    pub fn new(env: &Env) -> Outcome<Self> {
        env.d1("DB").map(Self).map_err(|e| internal(&e))
    }

    fn statement(&self, sql: &str, params: &[Param]) -> Outcome<D1PreparedStatement> {
        let values: Vec<JsValue> = params.iter().map(Param::to_js).collect();
        self.0.prepare(sql).bind(&values).map_err(|e| internal(&e))
    }

    /// `.all()` rows.
    pub async fn all(&self, sql: &str, params: &[Param]) -> Outcome<Vec<Row>> {
        let result = self
            .statement(sql, params)?
            .all()
            .await
            .map_err(|e| internal(&e))?;
        result.results::<Row>().map_err(|e| internal(&e))
    }

    /// `.first()` row.
    pub async fn first(&self, sql: &str, params: &[Param]) -> Outcome<Option<Row>> {
        self.statement(sql, params)?
            .first::<Row>(None)
            .await
            .map_err(|e| internal(&e))
    }

    /// `.run()`; the error text is kept for callers that branch on it.
    pub async fn run(&self, sql: &str, params: &[Param]) -> Result<(), String> {
        let statement = self.statement(sql, params).map_err(|f| f.to_string())?;
        statement.run().await.map(|_| ()).map_err(|e| describe(&e))
    }
}

thread_local! {
    /// Tables whose `trashed` column is known to exist, per isolate like the TS WeakMap.
    static VERIFIED_SYSTEM_COLUMNS: std::cell::RefCell<std::collections::HashSet<i64>> = Default::default();
}

/// `ensureUserTableSystemColumns`: adds `trashed` to legacy user tables, once per isolate.
pub async fn ensure_user_table_system_columns(db: &Db, table_id: i64) -> Outcome<()> {
    if VERIFIED_SYSTEM_COLUMNS.with(|set| set.borrow().contains(&table_id)) {
        return Ok(());
    }
    let table = format!("database_table_{table_id}");
    let columns = db
        .all(&format!("PRAGMA table_info(\"{table}\")"), &[])
        .await?;
    let has_trashed = columns
        .iter()
        .any(|c| c.get("name").and_then(Value::as_str) == Some("trashed"));
    if !has_trashed {
        let sql = format!("ALTER TABLE \"{table}\" ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0");
        if let Err(message) = db.run(&sql, &[]).await
            && !message.contains("duplicate column")
        {
            return Err(Failure::Internal(message));
        }
    }
    VERIFIED_SYSTEM_COLUMNS.with(|set| set.borrow_mut().insert(table_id));
    Ok(())
}
