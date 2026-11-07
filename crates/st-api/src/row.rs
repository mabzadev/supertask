//! Rows of a table.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// A row as the API sends it: `id`, `order` and one `field_<id>` per field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub id: u64,
    /// The decimal sort key of the row. Sent as a number by some endpoints and
    /// as a string by others, so it is kept as text.
    #[serde(default, deserialize_with = "string_or_number")]
    pub order: String,
    #[serde(flatten)]
    pub values: Map<String, Value>,
}

impl Row {
    /// The value under `key` (`field_42`), `null` when the row lacks it.
    pub fn value(&self, key: &str) -> &Value {
        self.values.get(key).unwrap_or(&Value::Null)
    }
}

fn string_or_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => text,
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

/// A page of `GET /api/database/rows/table/{id}/`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RowPage {
    /// Rows matching the query over all pages.
    pub count: u64,
    pub next: Option<String>,
    pub previous: Option<String>,
    pub results: Vec<Row>,
}

/// The query parameters of the row listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowsQuery {
    /// 1-based page number.
    pub page: u32,
    /// Rows per page; the server caps it at 1000.
    pub size: u32,
    pub search: Option<String>,
    /// `field_12,-field_3`: comma-separated sort, `-` for descending.
    pub order_by: Option<String>,
}

impl Default for RowsQuery {
    fn default() -> Self {
        Self {
            page: 1,
            size: 100,
            search: None,
            order_by: None,
        }
    }
}

/// The body of `POST /api/database/rows/table/{id}/batch/`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BatchRows {
    /// At most 200 rows, keyed by `field_<id>`.
    pub items: Vec<Map<String, Value>>,
}

/// The answer of the batch endpoints.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BatchRowsResponse {
    pub items: Vec<Row>,
}

/// The largest batch the API accepts.
pub const BATCH_LIMIT: usize = 200;

#[cfg(test)]
mod tests {
    use super::*;

    const ROWS: &str = include_str!("../tests/data/rows.json");

    #[test]
    fn reads_the_captured_page() {
        let page: RowPage = serde_json::from_str(ROWS).unwrap();
        assert_eq!(page.count, 45);
        assert_eq!(page.results.len(), 6);
        let first = &page.results[0];
        assert_eq!(first.id, 1);
        assert_eq!(first.order, "10000");
        assert_eq!(first.value("field_14"), "Refonte du site");
        assert_eq!(first.value("field_999"), &Value::Null);
        assert_eq!(first.values.len(), 24);
    }

    #[test]
    fn accepts_string_orders() {
        let row: Row =
            serde_json::from_str(r#"{"id":3,"order":"1.50000000000000000000","field_1":"a"}"#)
                .unwrap();
        assert_eq!(row.order, "1.50000000000000000000");
    }
}
