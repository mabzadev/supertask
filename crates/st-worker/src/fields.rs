//! Field metadata and cell (de)serialization: the synchronous half of
//! `src/services/dynamic-tables.ts` and `src/services/computed-fields.ts`.
//!
//! A cell value may be JS `undefined` (a column the row does not have, a
//! computed value that resolved to nothing). It is modelled as `None` so the
//! response can omit the key exactly where `JSON.stringify` does.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::fallback::{Failure, Outcome};
use crate::js;
use crate::json::{self, ParseError};
use crate::number_format::{format_number_for_api, numeric_storage_value};

/// A user table row as D1 returns it (`SELECT *`).
pub type Row = Map<String, Value>;

/// `FieldMeta` of the TS code.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldMeta {
    /// `database_field.id`.
    pub id: i64,
    /// Display name, the key under `user_field_names`.
    pub name: String,
    /// Field type (`text`, `link_row`, …).
    pub field_type: String,
    /// Whether this is the table's primary field.
    pub primary: bool,
    /// `database_field.read_only`.
    pub read_only: bool,
    /// Parsed `field_settings` (`{}` when absent or invalid).
    pub settings: Map<String, Value>,
    /// `settings.formula` when it is a string.
    pub formula: Option<String>,
}

impl FieldMeta {
    /// Builds the metadata from a `database_field` row selected as
    /// `id, name, type, "primary" AS is_primary, read_only, field_settings`.
    pub fn from_row(row: &Row) -> Outcome<Self> {
        let id = row
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| Failure::unsupported("field id"))?;
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| Failure::unsupported("field name"))?;
        let field_type = row
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| Failure::unsupported("field type"))?;
        let settings = parse_field_settings(row.get("field_settings"))?;
        let formula = settings
            .get("formula")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(Self {
            id,
            name: name.to_owned(),
            field_type: field_type.to_owned(),
            primary: js::truthy_opt(row.get("is_primary")),
            read_only: js::truthy_opt(row.get("read_only")),
            settings,
            formula,
        })
    }

    /// The column holding this field's value.
    pub fn column(&self) -> String {
        format!("field_{}", self.id)
    }

    /// `Number(field.settings?.[key] || 0)`.
    pub fn numeric_setting(&self, key: &str) -> f64 {
        let value = self.settings.get(key);
        if js::truthy_opt(value) {
            js::to_number_opt(value)
        } else {
            0.0
        }
    }

    /// Whether this formula field would be evaluated (the TS check before `evaluateFormula`).
    pub fn has_formula(&self) -> bool {
        self.field_type == "formula"
            && self
                .formula
                .as_deref()
                .is_some_and(|f| !js::trim(f).is_empty())
    }
}

/// `parseFieldSettings`: a JSON object, or `{}`.
pub fn parse_field_settings(value: Option<&Value>) -> Outcome<Map<String, Value>> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => match json::parse(text) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) | Err(ParseError::Invalid) => Ok(Map::new()),
            Err(ParseError::Unsupported) => Err(Failure::unsupported("field settings JSON")),
        },
        Some(Value::Object(map)) => Ok(map.clone()),
        _ => Ok(Map::new()),
    }
}

/// Field types computed from linked rows (`LINKED_COMPUTED_TYPES`).
pub fn is_linked_computed(field_type: &str) -> bool {
    matches!(field_type, "formula" | "count" | "lookup" | "rollup")
}

fn is_array_cell_type(field_type: &str) -> bool {
    matches!(
        field_type,
        "link_row" | "lookup" | "multiple_select" | "multiple_collaborators" | "file"
    )
}

/// `JSON.parse` for stored cells: `Ok(None)` when JS would throw and take the fallback.
fn parse_cell(text: &str) -> Outcome<Option<Value>> {
    match json::parse(text) {
        Ok(value) => Ok(Some(value)),
        Err(ParseError::Invalid) => Ok(None),
        Err(ParseError::Unsupported) => Err(Failure::unsupported("cell JSON")),
    }
}

fn deserialize_object_or_null(value: &Value) -> Outcome<Value> {
    match value {
        Value::String(text) => {
            let trimmed = js::trim(text);
            if trimmed.is_empty() {
                return Ok(Value::Null);
            }
            Ok(match parse_cell(trimmed)? {
                Some(parsed @ Value::Object(_)) => parsed,
                _ => Value::Null,
            })
        }
        Value::Object(_) => Ok(value.clone()),
        _ => Ok(Value::Null),
    }
}

fn deserialize_boolean(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::String(text) => {
            let normalized = js::trim(text).to_lowercase();
            if ["", "false", "f", "0", "off", "no", "unchecked"].contains(&normalized.as_str()) {
                false
            } else {
                // Every other string is truthy, listed or not.
                true
            }
        }
        other => js::truthy(other),
    }
}

fn deserialize_array_or_empty(value: &Value) -> Outcome<Value> {
    match value {
        Value::String(text) if text.is_empty() => Ok(json!([])),
        Value::String(text) => Ok(match parse_cell(text)? {
            Some(parsed @ Value::Array(_)) => parsed,
            _ => json!([]),
        }),
        Value::Array(_) => Ok(value.clone()),
        _ => Ok(json!([])),
    }
}

fn number_or_null(n: Option<f64>) -> Value {
    n.and_then(js::number_value).unwrap_or(Value::Null)
}

/// `deserializeFieldValue(type, value)`.
pub fn deserialize_field_value(field_type: &str, value: Option<&Value>) -> Outcome<Value> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(if is_array_cell_type(field_type) {
            json!([])
        } else {
            Value::Null
        });
    };
    Ok(match field_type {
        "boolean" => Value::Bool(deserialize_boolean(value)),
        "password" => match value {
            Value::Bool(false) => Value::Null,
            Value::String(s) if s.is_empty() => Value::Null,
            _ => Value::Bool(true),
        },
        "number" | "rating" | "count" | "duration" | "autonumber" | "auto_number" => {
            number_or_null(numeric_storage_value(Some(value)))
        }
        "rollup" => match numeric_storage_value(Some(value)) {
            Some(n) => number_or_null(Some(n)),
            None => value.clone(),
        },
        "single_select" | "created_by" | "last_modified_by" => deserialize_object_or_null(value)?,
        "link_row" | "lookup" | "multiple_select" | "multiple_collaborators" | "file" => {
            deserialize_array_or_empty(value)?
        }
        _ => value.clone(),
    })
}

fn formula_type(settings: &Map<String, Value>) -> String {
    js::lower_setting(settings, &["formula_type"])
}

fn string_or_null(text: Option<String>) -> Value {
    text.map_or(Value::Null, Value::String)
}

/// `serializeFieldValueForResponse(field, value)`.
pub fn serialize_field_value_for_response(
    field: &FieldMeta,
    value: Option<&Value>,
) -> Outcome<Value> {
    let numeric = field.field_type == "number"
        || field.field_type == "count"
        || (matches!(field.field_type.as_str(), "formula" | "rollup")
            && formula_type(&field.settings) == "number");
    if numeric {
        return Ok(string_or_null(format_number_for_api(
            &field.settings,
            value,
        )?));
    }
    deserialize_field_value(&field.field_type, value)
}

/// `normalizeResolvedFieldValue(field, value)`; `None` is `undefined` (key omitted).
pub fn normalize_resolved_field_value(
    field: &FieldMeta,
    value: Option<Value>,
) -> Outcome<Option<Value>> {
    if !is_linked_computed(&field.field_type) {
        return serialize_field_value_for_response(field, value.as_ref()).map(Some);
    }
    let rollup_function = js::lower_setting(
        &field.settings,
        &["airtable_rollup_function", "rollup_function"],
    );
    let formula_type = formula_type(&field.settings);
    if formula_type == "boolean" || rollup_function == "any" || rollup_function == "every" {
        return Ok(Some(match value {
            None | Some(Value::Null) => Value::Null,
            Some(v) => Value::Bool(js::truthy(&v)),
        }));
    }
    if formula_type == "number" {
        return serialize_field_value_for_response(field, value.as_ref()).map(Some);
    }
    if formula_type == "duration" {
        return deserialize_field_value("number", value.as_ref()).map(Some);
    }
    if field.field_type == "lookup" || formula_type == "array" {
        return Ok(Some(match value {
            Some(array @ Value::Array(_)) => array,
            _ => json!([]),
        }));
    }
    Ok(value)
}

/// `linkedRowIds(value)`: positive integer ids, deduplicated in first-seen order.
pub fn linked_row_ids(value: Option<&Value>) -> Outcome<Vec<i64>> {
    let parsed = match value {
        Some(Value::String(text)) => parse_cell(text)?,
        Some(other) => Some(other.clone()),
        None => None,
    };
    let Some(Value::Array(items)) = parsed else {
        return Ok(Vec::new());
    };
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for item in &items {
        let id = match item {
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            Value::String(s) if !js::trim(s).is_empty() => js::string_to_number(s),
            Value::Object(map) if map.contains_key("id") => js::to_number_opt(map.get("id")),
            _ => f64::NAN,
        };
        if !js::is_positive_integer(id) {
            continue;
        }
        if id > js::MAX_SAFE_INTEGER {
            return Err(Failure::unsupported("linked row id beyond 2^53"));
        }
        #[allow(clippy::cast_possible_truncation)]
        let id = id as i64;
        if seen.insert(id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// `rowOrder(row)`: the row's `order` as a number, 10000 when missing or invalid.
pub fn row_order(row: &Row) -> f64 {
    let raw = match row.get("order") {
        None | Some(Value::Null) => 10000.0,
        Some(value) => js::to_number(value),
    };
    if raw.is_finite() { raw } else { 10000.0 }
}

/// `linkedPrimaryDisplayValue(value)`: the text shown for a linked row.
pub fn linked_primary_display_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| linked_primary_display_value(Some(item)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        Some(Value::Object(record)) => {
            let shown = |member: &Value| {
                if member.is_null() {
                    String::new()
                } else {
                    js::to_js_string(member)
                }
            };
            if let Some(member) = record.get("value") {
                shown(member)
            } else if let Some(member) = record.get("name") {
                shown(member)
            } else {
                "[object Object]".to_owned()
            }
        }
        Some(other) => js::to_js_string(other),
    }
}

/// The `storedFallback` of `hydrateLinkRowValues`: links as stored, when they cannot be resolved.
pub fn stored_link_fallback(stored: &Value) -> Value {
    let Value::Array(items) = stored else {
        return json!([]);
    };
    let links = items
        .iter()
        .filter_map(|item| {
            let record = item.as_object()?;
            let id = js::to_number_opt(record.get("id"));
            if !js::is_positive_integer(id) {
                return None;
            }
            let id_value = js::number_value(id)?;
            let shown = [record.get("value"), record.get("name")]
                .into_iter()
                .flatten()
                .find(|member| !member.is_null())
                .map_or_else(|| js::number_to_string(id), js::to_js_string);
            let mut link = Map::new();
            link.insert("id".into(), id_value);
            link.insert("value".into(), Value::String(shown));
            if let Some(order) = record.get("order").filter(|o| !o.is_null()) {
                link.insert("order".into(), Value::String(js::to_js_string(order)));
            }
            Some(Value::Object(link))
        })
        .collect();
    Value::Array(links)
}

/// `serializeLookupSubValue(field, item)`.
pub fn serialize_lookup_sub_value(
    field: &FieldMeta,
    item: Option<Value>,
) -> Outcome<Option<Value>> {
    let subtype = js::lower_setting(&field.settings, &["array_formula_type"]);
    if subtype == "number" {
        return Ok(Some(string_or_null(format_number_for_api(
            &field.settings,
            item.as_ref(),
        )?)));
    }
    if subtype == "boolean" {
        return Ok(Some(match item {
            None | Some(Value::Null) => Value::Null,
            Some(v) => Value::Bool(js::truthy(&v)),
        }));
    }
    Ok(item)
}

fn is_blank(value: &Option<Value>) -> bool {
    matches!(value, None | Some(Value::Null))
        || matches!(value, Some(Value::String(s)) if s.is_empty())
}

/// `undefined` inside an array prints as `null`.
fn into_array(values: Vec<Option<Value>>) -> Value {
    Value::Array(
        values
            .into_iter()
            .map(|v| v.unwrap_or(Value::Null))
            .collect(),
    )
}

/// `uniqueValues`: first occurrence of each distinct `JSON.stringify` key.
fn unique_values(values: Vec<Option<Value>>) -> Vec<Option<Value>> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.as_ref().map(json::stringify)))
        .collect()
}

/// `Array.prototype.flat(Infinity)`.
fn flatten_deep(values: Vec<Option<Value>>) -> Vec<Option<Value>> {
    fn push(value: Option<Value>, out: &mut Vec<Option<Value>>) {
        match value {
            Some(Value::Array(items)) => items.into_iter().for_each(|item| push(Some(item), out)),
            other => out.push(other),
        }
    }
    let mut out = Vec::new();
    values.into_iter().for_each(|value| push(value, &mut out));
    out
}

/// `Array.prototype.slice(start, end)` index clamping.
fn js_slice_bounds(len: usize, start: f64, end: Option<f64>) -> (usize, usize) {
    #[allow(clippy::cast_precision_loss)]
    let length = len as f64;
    let clamp = |relative: f64| {
        let relative = if relative.is_nan() {
            0.0
        } else {
            relative.trunc()
        };
        let index = if relative < 0.0 {
            (length + relative).max(0.0)
        } else {
            relative.min(length)
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let index = index as usize;
        index
    };
    let from = clamp(start);
    let to = end.map_or(len, clamp);
    (from, to.max(from))
}

fn shown_or_empty(value: &Option<Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::to_js_string(v),
    }
}

fn count_value(n: usize) -> Value {
    Value::from(n)
}

/// `aggregateRollupValues(allValues, settings)`; `None` is `undefined`.
pub fn aggregate_rollup_values(
    all_values: Vec<Option<Value>>,
    settings: &Map<String, Value>,
) -> Outcome<Option<Value>> {
    let values: Vec<Option<Value>> = all_values
        .iter()
        .filter(|v| !is_blank(v))
        .cloned()
        .collect();
    let function = {
        let name = js::lower_setting(settings, &["airtable_rollup_function", "rollup_function"]);
        if name.is_empty() {
            "count".to_owned()
        } else {
            name
        }
    };
    let truthy = |value: &Option<Value>| js::truthy_opt(value.as_ref());
    let result = match function.as_str() {
        "count" | "count_all" => count_value(all_values.len()),
        "empty_count" => count_value(all_values.len() - values.len()),
        "not_empty_count" => count_value(values.len()),
        "unique_count" => count_value(unique_values(values).len()),
        "array_compact" => into_array(values),
        "array_flatten" => into_array(
            flatten_deep(all_values)
                .into_iter()
                .filter(|v| !is_blank(v))
                .collect(),
        ),
        "array_unique" => into_array(unique_values(values)),
        "array_slice" => {
            let start = settings.get("airtable_rollup_slice_start");
            let start = if js::truthy_opt(start) {
                js::to_number_opt(start)
            } else {
                1.0
            };
            let end = match settings.get("airtable_rollup_slice_end") {
                None | Some(Value::Null) => None,
                Some(end) => Some(js::to_number(end)),
            };
            let start_index = if start > 0.0 { start - 1.0 } else { start };
            let (from, to) = js_slice_bounds(all_values.len(), start_index, end);
            into_array(all_values[from..to].to_vec())
        }
        "array_join" | "join" | "string_agg" => {
            let separator = match settings.get("airtable_rollup_separator") {
                None | Some(Value::Null) => ", ".to_owned(),
                Some(separator) => js::to_js_string(separator),
            };
            let flag = |key: &str| settings.get(key) == Some(&Value::Bool(true));
            let mut join_values = if flag("airtable_rollup_flatten") {
                flatten_deep(all_values)
            } else {
                all_values
            };
            if flag("airtable_rollup_compact") {
                join_values.retain(|v| !is_blank(v));
            }
            if flag("airtable_rollup_unique") {
                join_values = unique_values(join_values);
            }
            Value::String(
                join_values
                    .iter()
                    .map(shown_or_empty)
                    .collect::<Vec<_>>()
                    .join(&separator),
            )
        }
        "concatenate" => Value::String(all_values.iter().map(shown_or_empty).collect::<String>()),
        "and" => Value::Bool(all_values.iter().all(truthy)),
        "or" => Value::Bool(all_values.iter().any(truthy)),
        "xor" => Value::Bool(all_values.iter().filter(|v| truthy(v)).count() % 2 == 1),
        "any" if values.is_empty() => Value::Null,
        "any" => Value::Bool(values.iter().any(truthy)),
        "every" if values.is_empty() => Value::Null,
        "every" => Value::Bool(values.iter().all(truthy)),
        _ => {
            let numbers: Vec<f64> = values
                .iter()
                .filter_map(|v| numeric_storage_value(v.as_ref()))
                .collect();
            let sum = || numbers.iter().fold(0.0, |total, n| total + n);
            #[allow(clippy::cast_precision_loss)]
            let count = numbers.len() as f64;
            match function.as_str() {
                "numeric_count" => count_value(numbers.len()),
                "sum" => finite(sum())?,
                "avg" | "average" if numbers.is_empty() => Value::Null,
                "avg" | "average" => finite(sum() / count)?,
                "min" | "max" if values.is_empty() => Value::Null,
                "min" | "max" if numbers.len() == values.len() => {
                    let pick = if function == "min" {
                        f64::min
                    } else {
                        f64::max
                    };
                    finite(numbers.iter().copied().fold(numbers[0], pick))?
                }
                // localeCompare on mixed values, and `**` in the variances: not reproduced.
                "min" | "max" | "variance_pop" | "variance_sample" | "stddev_pop"
                | "stddev_sample" => {
                    return Err(Failure::unsupported(format!("rollup function {function}")));
                }
                _ => count_value(values.len()),
            }
        }
    };
    Ok(Some(result))
}

fn finite(n: f64) -> Outcome<Value> {
    js::number_value(n).ok_or_else(|| Failure::unsupported("non-finite rollup result"))
}

/// `truthyQueryParam(value)`.
pub fn truthy_query_param(value: Option<&str>) -> bool {
    value.is_some_and(|v| {
        let normalized = js::trim(v).to_lowercase();
        ["", "1", "true", "t", "yes", "y", "on"].contains(&normalized.as_str())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(field_type: &str, settings: Value) -> FieldMeta {
        FieldMeta {
            id: 1,
            name: "F".into(),
            field_type: field_type.into(),
            primary: false,
            read_only: false,
            settings: settings.as_object().cloned().unwrap_or_default(),
            formula: None,
        }
    }

    #[test]
    fn deserializes_like_the_ts_code() {
        assert_eq!(
            deserialize_field_value("rating", Some(&json!("n:5"))).unwrap(),
            json!(5)
        );
        assert_eq!(
            deserialize_field_value("boolean", Some(&json!(1))).unwrap(),
            json!(true)
        );
        assert_eq!(
            deserialize_field_value("boolean", Some(&json!(" Off "))).unwrap(),
            json!(false)
        );
        assert_eq!(deserialize_field_value("file", None).unwrap(), json!([]));
        assert_eq!(
            deserialize_field_value("file", Some(&json!("{bad"))).unwrap(),
            json!([])
        );
        assert_eq!(
            deserialize_field_value("single_select", Some(&json!("[1]"))).unwrap(),
            Value::Null
        );
        assert_eq!(
            deserialize_field_value("password", Some(&json!(0))).unwrap(),
            json!(true)
        );
        assert_eq!(
            deserialize_field_value("rollup", Some(&json!("abc"))).unwrap(),
            json!("abc")
        );
        assert_eq!(
            deserialize_field_value("text", Some(&json!(12))).unwrap(),
            json!(12)
        );
    }

    #[test]
    fn serializes_numbers_as_fixed_strings() {
        let count = field("count", json!({ "formula_type": "number" }));
        assert_eq!(
            normalize_resolved_field_value(&count, Some(json!(3))).unwrap(),
            Some(json!("3"))
        );
        let bare = field("count", json!({}));
        assert_eq!(
            normalize_resolved_field_value(&bare, Some(json!(3))).unwrap(),
            Some(json!(3))
        );
        assert_eq!(normalize_resolved_field_value(&bare, None).unwrap(), None);
        let lookup = field("lookup", json!({ "formula_type": "array" }));
        assert_eq!(
            normalize_resolved_field_value(&lookup, Some(json!("x"))).unwrap(),
            Some(json!([]))
        );
    }

    #[test]
    fn linked_ids_follow_ts_rules() {
        let ids = linked_row_ids(Some(&json!(r#"[{"id":3},"4",3,{"id":"x"},0,1.5,[7]]"#))).unwrap();
        assert_eq!(ids, vec![3, 4]);
        assert!(linked_row_ids(Some(&json!("not json"))).unwrap().is_empty());
    }

    #[test]
    fn display_values_follow_ts_rules() {
        let value = json!([{ "value": "a" }, { "name": "b" }, null, { "x": 1 }, 2]);
        assert_eq!(
            linked_primary_display_value(Some(&value)),
            "a, b, [object Object], 2"
        );
        let fallback =
            stored_link_fallback(&json!([{ "id": 2, "name": null, "order": 5 }, { "id": -1 }]));
        assert_eq!(fallback, json!([{ "id": 2, "value": "2", "order": "5" }]));
    }

    #[test]
    fn rollups_follow_ts_rules() {
        let settings = json!({ "rollup_function": "sum" });
        let values = vec![Some(json!(1.5)), Some(json!("n:2")), None, Some(json!(""))];
        let sum = aggregate_rollup_values(values.clone(), settings.as_object().unwrap()).unwrap();
        assert_eq!(sum, Some(json!(3.5)));
        let count = aggregate_rollup_values(values.clone(), &Map::new()).unwrap();
        assert_eq!(count, Some(json!(4)));
        let join = json!({ "rollup_function": "array_join", "airtable_rollup_compact": true });
        assert_eq!(
            aggregate_rollup_values(values, join.as_object().unwrap()).unwrap(),
            Some(json!("1.5, n:2"))
        );
    }
}
