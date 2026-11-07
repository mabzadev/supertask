//! The evaluator, ported from `evaluate` and `callFunction` in
//! `formula-engine.ts`.
//!
//! The engine is dynamically typed: every function accepts any value and coerces
//! it the JavaScript way. Each helper below keeps the name of its TS counterpart
//! (`toNum`, `toStr`, `isBlank`...) so the two can be read side by side.

use std::borrow::Cow;

use crate::Error;
use crate::date;
use crate::duration::parse_duration_seconds;
use crate::env::{Environment, random_f64, random_uuid};
use crate::js;
use crate::parser::{BinaryOp, Expr, Literal, UnaryOp, formula_number};
use crate::regexp::{self, Pattern};
use crate::value::{Duration, Interval, Object, Value};

static NULL: Value = Value::Null;

/// The message of the `RangeError` thrown by `toISOString` on an invalid date.
const INVALID_TIME_VALUE: &str = "Invalid time value";

pub(crate) struct Evaluator<'a> {
    pub(crate) fields: &'a Object,
    pub(crate) env: &'a mut dyn Environment,
}

impl Evaluator<'_> {
    /// Evaluates a node. Only the recursive cases stay in this frame: it is
    /// paid once per nesting level, and formulas nest up to 1023 levels.
    pub(crate) fn eval(&mut self, expr: &Expr) -> Result<Value, Error> {
        match expr {
            Expr::Literal { value, .. } => Ok(literal_value(value)),
            Expr::Field(name) => Ok(self.field(name)),
            Expr::Unary { op, operand } => {
                let value = self.eval(operand)?;
                Ok(unary(*op, &value))
            }
            Expr::Binary { .. } => self.eval_binary(expr),
            Expr::Call { name, args } => self.eval_call(name, args),
        }
    }

    /// Binary operators are left-associative, so `1 + 1 + … + 1` is a left
    /// spine as deep as the formula is long. Walking it in a loop (leftmost
    /// operand first, then each right operand in turn) keeps the TS order of
    /// evaluation and of errors without recursing down the spine.
    #[inline(never)]
    fn eval_binary(&mut self, expr: &Expr) -> Result<Value, Error> {
        let mut spine = Vec::new();
        let mut node = expr;
        while let Expr::Binary { op, left, right } = node {
            spine.push((*op, &**right));
            node = left;
        }
        let mut value = self.eval(node)?;
        for (op, right) in spine.into_iter().rev() {
            let right = self.eval(right)?;
            value = binary_value(op, &value, &right)?;
        }
        Ok(value)
    }

    #[inline(never)]
    fn eval_call(&mut self, name: &str, args: &[Expr]) -> Result<Value, Error> {
        if name == "ERROR_TO_NAN" || name == "ERROR_TO_NULL" {
            let result = match args.first() {
                Some(arg) => self.eval(arg),
                None => Ok(Value::Null),
            };
            return Ok(result.unwrap_or(if name == "ERROR_TO_NAN" {
                Value::Number(f64::NAN)
            } else {
                Value::Null
            }));
        }
        // A plain loop: iterator adapters add stack frames per nesting level
        // in debug builds.
        let mut values = Vec::with_capacity(args.len());
        for arg in args {
            values.push(self.eval(arg)?);
        }
        self.call(name, &values)
    }

    #[inline(never)]
    fn field(&self, name: &str) -> Value {
        self.fields.get(name).cloned().unwrap_or_default()
    }
}

#[inline(never)]
fn literal_value(literal: &Literal) -> Value {
    match literal {
        Literal::Null => Value::Null,
        Literal::Bool(value) => Value::Bool(*value),
        Literal::Number(number) => Value::Number(*number),
        Literal::Text(text) => Value::Text(text.clone()),
    }
}

/// `unwrapFormulaValue`: durations become seconds, except inside link and file
/// objects, which are returned untouched.
pub(crate) fn unwrap(value: Value) -> Value {
    match value {
        Value::Duration(duration) => Value::Number(duration.seconds),
        Value::Array(items) => Value::Array(items.into_iter().map(unwrap).collect()),
        Value::Object(object) if is_link_object(&object) || is_file_object(&object) => {
            Value::Object(object)
        }
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, unwrap(value)))
                .collect(),
        ),
        other => other,
    }
}

// ── Coercions ─────────────────────────────────────────────────────────────────

fn finite_or_nan(number: f64) -> f64 {
    if number.is_finite() { number } else { f64::NAN }
}

/// `toNum`: null and `""` are 0, numeric storage text (`"n:1.50"`) is read
/// without its prefix, and anything not finite is `NaN`.
pub(crate) fn to_num(value: &Value) -> f64 {
    match value {
        Value::Duration(duration) => duration.seconds,
        Value::Null => 0.0,
        Value::Text(text) if text.is_empty() => 0.0,
        Value::Text(text) => {
            let decoded = text.strip_prefix("n:").unwrap_or(text);
            if decoded.is_empty() {
                f64::NAN
            } else {
                finite_or_nan(js::string_to_number(decoded))
            }
        }
        other => finite_or_nan(js::to_number(other)),
    }
}

fn is_formula_nan(value: &Value) -> bool {
    matches!(value, Value::Number(number) if !number.is_finite())
}

fn trunc_num(value: &Value) -> f64 {
    let number = to_num(value);
    if number.is_finite() {
        number.trunc()
    } else {
        number
    }
}

/// `toStr`: null is the empty string and a duration is its text.
pub(crate) fn to_str(value: &Value) -> Cow<'_, str> {
    match value {
        Value::Null => Cow::Borrowed(""),
        Value::Text(text) => Cow::Borrowed(text),
        Value::Duration(duration) => Cow::Borrowed(&duration.text),
        other => Cow::Owned(js::to_js_string(other)),
    }
}

/// `toBool`: the text `"false"` is false, and `NaN` is true.
pub(crate) fn to_bool(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::Number(number) => *number != 0.0,
        Value::Text(text) => !text.is_empty() && !text.eq_ignore_ascii_case("false"),
        other => js::truthy(other),
    }
}

/// `parseJsonValue`: text that looks like a JSON array or object is parsed,
/// anything else is returned as is.
fn parse_json_value(value: &Value) -> Cow<'_, Value> {
    if let Value::Text(text) = value {
        let trimmed = js::trim(text);
        if (trimmed.starts_with('[') || trimmed.starts_with('{'))
            && let Some(parsed) = js::json_parse(trimmed)
        {
            return Cow::Owned(parsed);
        }
    }
    Cow::Borrowed(value)
}

/// A non-array object as JavaScript code sees it; durations are objects too.
fn as_record(value: &Value) -> Option<Cow<'_, Object>> {
    match value {
        Value::Object(object) => Some(Cow::Borrowed(object)),
        Value::Duration(duration) => Some(Cow::Owned(duration.as_object())),
        _ => None,
    }
}

fn is_object_like(value: &Value) -> bool {
    matches!(
        value,
        Value::Array(_) | Value::Object(_) | Value::Duration(_)
    )
}

fn is_blank(value: &Value) -> bool {
    match &*parse_json_value(value) {
        Value::Null => true,
        Value::Text(text) => text.is_empty(),
        Value::Number(number) => *number == 0.0,
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn is_runtime_empty(value: &Value) -> bool {
    let parsed = parse_json_value(value);
    match &*parsed {
        Value::Null => true,
        Value::Text(text) => js::trim(text).is_empty(),
        Value::Array(items) => items.is_empty(),
        other => as_record(other).is_some_and(|record| record.is_empty()),
    }
}

fn capitalize(value: &Value) -> String {
    let text = to_str(value);
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => js::to_upper(&first.to_string()) + &js::to_lower(chars.as_str()),
        None => String::new(),
    }
}

// ── Paths, properties and arrays ──────────────────────────────────────────────

fn array_position(part: &str, length: usize) -> Option<usize> {
    let index = js::string_to_number(part);
    if !index.is_finite() || index.fract() != 0.0 {
        return None;
    }
    let resolved = if index < 0.0 {
        length as f64 + index
    } else {
        index
    };
    (resolved >= 0.0 && resolved < length as f64).then_some(resolved as usize)
}

/// `getValueAtPath`: `*` maps over every item; negative indices count from the end.
fn get_value_at_path(value: &Value, parts: &[&str]) -> Value {
    let Some((part, rest)) = parts.split_first() else {
        return value.clone();
    };
    let parsed = parse_json_value(value);
    if *part == "*" {
        return match &*parsed {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| get_value_at_path(item, rest))
                    .collect(),
            ),
            other => match as_record(other) {
                Some(record) => Value::Array(
                    record
                        .values()
                        .map(|item| get_value_at_path(item, rest))
                        .collect(),
                ),
                None => Value::Array(Vec::new()),
            },
        };
    }
    match &*parsed {
        Value::Null => Value::Null,
        Value::Array(items) => match array_position(part, items.len()) {
            Some(index) => get_value_at_path(&items[index], rest),
            None => Value::Null,
        },
        other => match as_record(other) {
            Some(record) => record
                .get(part)
                .map_or(Value::Null, |item| get_value_at_path(item, rest)),
            None => Value::Null,
        },
    }
}

/// `getFormulaPath`: an exact key first, then a dotted path into the fields.
fn get_formula_path(fields: &Object, path: &Value) -> Value {
    let key = to_str(path);
    if let Some(value) = fields.get(&key) {
        return value.clone();
    }
    let parts: Vec<&str> = key.split('.').filter(|part| !part.is_empty()).collect();
    let Some((part, rest)) = parts.split_first() else {
        return Value::Object(fields.clone());
    };
    if *part == "*" {
        return Value::Array(
            fields
                .values()
                .map(|item| get_value_at_path(item, rest))
                .collect(),
        );
    }
    fields
        .get(part)
        .map_or(Value::Null, |item| get_value_at_path(item, rest))
}

fn get_property_value(value: &Value, property: &Value) -> Value {
    let parsed = parse_json_value(value);
    let Some(record) = as_record(&parsed) else {
        return Value::Null;
    };
    record.get(&to_str(property)).cloned().unwrap_or_default()
}

fn ensure_runtime_array(value: &Value) -> Value {
    let parsed = parse_json_value(value);
    Value::Array(match &*parsed {
        Value::Null => Vec::new(),
        Value::Text(text) if text.is_empty() => Vec::new(),
        Value::Array(items) => items.clone(),
        Value::Text(text) => text
            .split(',')
            .map(|item| Value::from(js::trim(item)))
            .collect(),
        other => vec![other.clone()],
    })
}

fn runtime_at(value: &Value, index: &Value) -> Value {
    let parsed = parse_json_value(value);
    let index = to_num(index).trunc();
    if !index.is_finite() {
        return Value::Null;
    }
    let resolve = |length: usize| {
        let resolved = if index < 0.0 {
            length as f64 + index
        } else {
            index
        };
        (resolved >= 0.0 && resolved < length as f64).then_some(resolved as usize)
    };
    match &*parsed {
        Value::Array(items) => {
            resolve(items.len()).map_or(Value::Null, |index| items[index].clone())
        }
        Value::Text(text) => {
            let chars: Vec<char> = text.chars().collect();
            resolve(chars.len()).map_or(Value::Null, |index| Value::Text(chars[index].to_string()))
        }
        _ => Value::Null,
    }
}

fn is_link_object(object: &Object) -> bool {
    matches!(object.get("url"), Some(Value::Text(_)))
}

/// `isFormulaLinkValue`: any object with a text `url`.
fn is_link(value: &Value) -> bool {
    as_record(value).is_some_and(|record| is_link_object(&record))
}

/// `functionValues`: a single array argument stands for its items.
fn function_values(args: &[Value]) -> &[Value] {
    match args {
        [Value::Array(items)] => items,
        _ => args,
    }
}

fn as_array_value(value: &Value) -> Vec<Value> {
    match parse_json_value(value).into_owned() {
        Value::Array(items) => items,
        other => vec![other],
    }
}

fn as_many_array_value(value: &Value) -> Vec<Value> {
    match parse_json_value(value).into_owned() {
        Value::Null => Vec::new(),
        Value::Text(text) if text.is_empty() => Vec::new(),
        Value::Array(items) => items,
        other => vec![other],
    }
}

fn aggregate_item_id(item: &Value, index: usize) -> f64 {
    if let Some(record) = as_record(item) {
        let id = match record.get("id") {
            Some(Value::Number(number)) => *number,
            Some(Value::Text(text)) if !js::trim(text).is_empty() => js::string_to_number(text),
            _ => f64::NAN,
        };
        if id.is_finite() && id.fract() == 0.0 && id > 0.0 {
            return id;
        }
    }
    (index + 1) as f64
}

fn is_aggregate_value_object(value: &Value) -> bool {
    let Some(record) = as_record(value) else {
        return false;
    };
    record.contains_key("value")
        && (record.contains_key("id") || record.contains_key("ids"))
        && !record.contains_key("color")
        && !record.contains_key("first_name")
        && !record.contains_key("last_name")
}

fn id_value_object(id: f64, value: Value) -> Value {
    let mut object = Object::new();
    object.insert("id", id);
    object.insert("value", value);
    Value::Object(object)
}

fn array_agg(value: &Value, nest_in_value: bool) -> Value {
    let values = as_many_array_value(value);
    if nest_in_value && values.iter().all(is_aggregate_value_object) {
        return Value::Array(values);
    }
    Value::Array(if nest_in_value {
        values
            .into_iter()
            .enumerate()
            .map(|(index, item)| id_value_object(aggregate_item_id(&item, index), item))
            .collect()
    } else {
        values
    })
}

fn array_agg_unnesting(value: &Value) -> Value {
    Value::Array(
        as_many_array_value(value)
            .iter()
            .flat_map(as_many_array_value)
            .collect(),
    )
}

/// An aggregate item whose `value` holds an array of related items.
fn is_nested_aggregate(item: &Value) -> bool {
    is_aggregate_value_object(item)
        && as_record(item).and_then(|record| {
            record
                .get("value")
                .map(|value| matches!(&*parse_json_value(value), Value::Array(_)))
        }) == Some(true)
}

fn nested_aggregate_value(item: &Value) -> Vec<Value> {
    as_record(item)
        .and_then(|record| record.get("value").map(as_many_array_value))
        .unwrap_or_default()
}

fn many_to_many_groups(value: &Value) -> Value {
    let values = as_many_array_value(value);
    if values.is_empty() {
        return Value::Array(Vec::new());
    }
    if values.iter().all(is_nested_aggregate) {
        return Value::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    id_value_object(
                        aggregate_item_id(item, index),
                        Value::Array(nested_aggregate_value(item)),
                    )
                })
                .collect(),
        );
    }
    if values.iter().all(|item| matches!(item, Value::Array(_))) {
        return Value::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    id_value_object(
                        aggregate_item_id(item, index),
                        Value::Array(as_many_array_value(item)),
                    )
                })
                .collect(),
        );
    }
    Value::Array(vec![id_value_object(1.0, Value::Array(values))])
}

fn many_to_many_leaf_values(value: &Value) -> Vec<Value> {
    let parsed = parse_json_value(value);
    if let Value::Array(items) = &*parsed
        && items.iter().all(is_nested_aggregate)
    {
        return items.iter().flat_map(nested_aggregate_value).collect();
    }
    as_many_array_value(&parsed)
}

fn many_to_many_text(value: &Value) -> String {
    many_to_many_leaf_values(value)
        .iter()
        .map(|item| {
            let parsed = parse_json_value(item);
            if let Some(record) = as_record(&parsed) {
                for key in ["value", "first_name", "name", "username", "email", "id"] {
                    match record.get(key) {
                        None | Some(Value::Null) => {}
                        Some(Value::Text(text)) if text.is_empty() => {}
                        Some(found) => return js::to_js_string(found),
                    }
                }
                return String::new();
            }
            if parsed.is_null() {
                String::new()
            } else {
                js::to_js_string(&parsed)
            }
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

// ── Files ─────────────────────────────────────────────────────────────────────

const FILE_KEYS: [&str; 6] = [
    "visible_name",
    "original_name",
    "name",
    "mime_type",
    "type",
    "url",
];

fn is_file_object(object: &Object) -> bool {
    FILE_KEYS
        .iter()
        .any(|key| matches!(object.get(key), Some(Value::Text(_))))
}

fn is_file(value: &Value) -> bool {
    as_record(value).is_some_and(|record| is_file_object(&record))
}

fn file_values(value: &Value) -> Vec<Value> {
    as_array_value(value).into_iter().filter(is_file).collect()
}

fn single_file_value(value: &Value) -> Option<Value> {
    let parsed = parse_json_value(value);
    if is_file(&parsed) {
        return Some(parsed.into_owned());
    }
    file_values(&parsed).into_iter().next()
}

fn file_string(file: Option<&Value>, keys: &[&str]) -> String {
    let Some(record) = file.and_then(as_record) else {
        return String::new();
    };
    keys.iter()
        .find_map(|key| match record.get(key) {
            Some(Value::Text(text)) if !text.is_empty() => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn file_number(file: Option<&Value>, keys: &[&str]) -> Value {
    let Some(record) = file.and_then(as_record) else {
        return Value::Null;
    };
    keys.iter()
        .find_map(|key| {
            let number = match record.get(key) {
                Some(Value::Number(number)) => *number,
                Some(Value::Text(text)) if !text.is_empty() => js::string_to_number(text),
                _ => f64::NAN,
            };
            number.is_finite().then_some(Value::Number(number))
        })
        .unwrap_or_default()
}

// ── Text helpers ──────────────────────────────────────────────────────────────

fn numeric_function_values(args: &[Value]) -> Vec<f64> {
    function_values(args)
        .iter()
        .filter(|value| {
            !matches!(value, Value::Null) && !matches!(value, Value::Text(text) if text.is_empty())
        })
        .map(to_num)
        .collect()
}

/// `displayText`: links print as `label (url)`, arrays join with commas.
fn display_text(value: &Value) -> String {
    if is_link(value)
        && let Some(record) = as_record(value)
    {
        let url = to_str(record.get("url").unwrap_or(&NULL)).into_owned();
        return match record.get("label") {
            Some(label) if js::truthy(label) => format!("{} ({url})", js::to_js_string(label)),
            _ => url,
        };
    }
    if let Value::Array(items) = value {
        return items.iter().map(display_text).collect::<Vec<_>>().join(",");
    }
    to_str(value).into_owned()
}

fn option_text(value: &Value) -> String {
    let parsed = parse_json_value(value);
    if let Some(record) = as_record(&parsed) {
        for key in ["value", "name", "id"] {
            if let Some(found) = record.get(key) {
                return js::to_js_string(found);
            }
        }
    }
    to_str(&parsed).into_owned()
}

fn single_select_value(value: &Value) -> Value {
    let parsed = parse_json_value(value);
    match &*parsed {
        Value::Null => return Value::Null,
        Value::Text(text) if text.is_empty() => return Value::Null,
        _ => {}
    }
    if let Some(record) = as_record(&parsed) {
        for key in ["value", "name"] {
            match record.get(key) {
                None | Some(Value::Null) => {}
                Some(found) => return Value::Text(js::to_js_string(found)),
            }
        }
    }
    let text = to_str(&parsed);
    if text.is_empty() {
        Value::Null
    } else {
        Value::Text(text.into_owned())
    }
}

fn jsonb_extract_path_text(value: &Value, path: &[Value]) -> Value {
    let mut current = parse_json_value(value).into_owned();
    for key in path {
        let key = to_str(key);
        current = parse_json_value(&current).into_owned();
        let next = match &current {
            Value::Null => return Value::Null,
            Value::Array(items) => {
                let index = js::string_to_number(&key);
                if !(index.is_finite()
                    && index.fract() == 0.0
                    && index >= 0.0
                    && index < items.len() as f64)
                {
                    return Value::Null;
                }
                items[index as usize].clone()
            }
            other => match as_record(other) {
                Some(record) => match record.get(&key) {
                    Some(found) => found.clone(),
                    None => return Value::Null,
                },
                None => return Value::Null,
            },
        };
        current = next;
    }
    match &current {
        Value::Null => Value::Null,
        other if is_object_like(other) => Value::Text(js::json_stringify(other)),
        other => Value::Text(js::to_js_string(other)),
    }
}

fn bc_to_null(value: &Value) -> Value {
    let text = to_str(value);
    let text = js::trim(&text);
    if text.is_empty() {
        return value.clone();
    }
    let bytes = text.as_bytes();
    let leading_digits = |start: usize| {
        bytes[start..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
    };
    // `/^-\d{4,}/`: a negative year of four or more digits is a BC date.
    if bytes[0] == b'-' && leading_digits(1) >= 4 {
        return Value::Null;
    }
    value.clone()
}

fn variance(values: &[f64], sample: bool) -> Value {
    let divisor = if sample {
        values.len() as f64 - 1.0
    } else {
        values.len() as f64
    };
    if divisor <= 0.0 {
        return Value::Null;
    }
    let average = values.iter().fold(0.0, |sum, value| sum + value) / values.len() as f64;
    Value::Number(
        values.iter().fold(0.0, |sum, value| {
            sum + (value - average) * (value - average)
        }) / divisor,
    )
}

fn variance_number(values: &[f64], sample: bool) -> Option<f64> {
    match variance(values, sample) {
        Value::Number(number) => Some(number),
        _ => None,
    }
}

/// `equalValues(a, b) || a == b`, the engine's `=`.
fn formula_equals(left: &Value, right: &Value) -> bool {
    js::json_stringify(left) == js::json_stringify(right) || js::loose_equals(left, right)
}

/// `equal(a, b)` where an argument may be missing. A missing argument is
/// `undefined`: `JSON.stringify` gives no text for it, so it only equals
/// another missing argument, or `null` through `==`.
fn equal_arguments(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => formula_equals(left, right),
        (None, None) => true,
        (Some(value), None) | (None, Some(value)) => value.is_null(),
    }
}

// ── Vectorization ─────────────────────────────────────────────────────────────

fn is_vector(value: &Value) -> bool {
    matches!(&*parse_json_value(value), Value::Array(_))
}

fn vector_values(value: &Value) -> Vec<Value> {
    as_array_value(value)
}

#[inline(never)]
fn unary(op: UnaryOp, value: &Value) -> Value {
    let apply = |item: &Value| match op {
        UnaryOp::Neg => Value::Number(-to_num(item)),
        UnaryOp::Not => Value::Bool(!to_bool(item)),
    };
    if is_vector(value) {
        return Value::Array(vector_values(value).iter().map(apply).collect());
    }
    apply(value)
}

/// `binaryValue`: an operator applied to an array (or JSON array text) maps over
/// its items, so `field('Names') = 'Bob'` gives one boolean per name.
#[inline(never)]
fn binary_value(op: BinaryOp, left: &Value, right: &Value) -> Result<Value, Error> {
    let left_is_vector = is_vector(left);
    let right_is_vector = is_vector(right);
    if !left_is_vector && !right_is_vector {
        return binary_scalar(op, left, right);
    }
    let left_values = vector_values(left);
    let right_values = vector_values(right);
    let length = left_values.len().max(right_values.len());
    (0..length)
        .map(|index| {
            let left_item = if left_is_vector {
                left_values.get(index).unwrap_or(&NULL)
            } else {
                left
            };
            let right_item = if right_is_vector {
                right_values.get(index).unwrap_or(&NULL)
            } else {
                right
            };
            binary_scalar(op, left_item, right_item)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn binary_scalar(op: BinaryOp, left: &Value, right: &Value) -> Result<Value, Error> {
    Ok(match op {
        BinaryOp::Add => return add_values(left, right),
        BinaryOp::Sub => return minus_values(left, right),
        BinaryOp::Mul => multiply_values(left, right),
        BinaryOp::Div => divide_values(left, right),
        BinaryOp::Mod => Value::Number(if to_num(right) == 0.0 {
            f64::NAN
        } else {
            to_num(left) % to_num(right)
        }),
        BinaryOp::Eq => Value::Bool(formula_equals(left, right)),
        BinaryOp::NotEq => Value::Bool(!formula_equals(left, right)),
        BinaryOp::Lt | BinaryOp::LtEq | BinaryOp::Gt | BinaryOp::GtEq => {
            Value::Bool(compare_values(op, left, right))
        }
        BinaryOp::And => Value::Bool(to_bool(left) && to_bool(right)),
        BinaryOp::Or => Value::Bool(to_bool(left) || to_bool(right)),
    })
}

/// `vectorizedFunction`: when any argument is an array, the function maps over
/// the items, scalar arguments being repeated.
fn vectorized(args: &[Value], scalar: impl Fn(&[Value]) -> Value) -> Value {
    let flags: Vec<bool> = args.iter().map(is_vector).collect();
    if !flags.iter().any(|flag| *flag) {
        return scalar(args);
    }
    let vectors: Vec<Vec<Value>> = args.iter().map(vector_values).collect();
    let length = vectors
        .iter()
        .zip(&flags)
        .map(|(items, flag)| if *flag { items.len() } else { 1 })
        .max()
        .unwrap_or(0);
    Value::Array(
        (0..length)
            .map(|index| {
                let items: Vec<Value> = args
                    .iter()
                    .zip(&flags)
                    .zip(&vectors)
                    .map(|((arg, flag), items)| {
                        if *flag {
                            items.get(index).cloned().unwrap_or_default()
                        } else {
                            arg.clone()
                        }
                    })
                    .collect();
                scalar(&items)
            })
            .collect(),
    )
}

// ── Dates and durations ───────────────────────────────────────────────────────

struct DateFields {
    year: f64,
    month: f64,
    day: f64,
    hour: f64,
    minute: f64,
    second: f64,
}

impl DateFields {
    fn to_time(&self) -> f64 {
        date::date_utc(
            self.year,
            self.month - 1.0,
            self.day,
            self.hour,
            self.minute,
            self.second,
        )
    }
}

const FORMAT_TOKENS: [&str; 6] = ["YYYY", "HH24", "MM", "DD", "MI", "SS"];

/// `parseFormattedDateParts`: reads `text` with a format such as `YYYYMMDD` or
/// `DD/MM/YYYY HH24:MI`, rejecting dates that do not exist.
fn parse_formatted_date_parts(value: &Value, format: Option<&Value>) -> Option<DateFields> {
    let text = to_str(value);
    let text = js::trim(&text);
    if text.is_empty() {
        return None;
    }
    let format = js::to_upper(&to_str(format.unwrap_or(&NULL)));
    if format.is_empty() {
        return None;
    }
    let mut values: [Option<f64>; 6] = [None; 6];
    let mut remaining = text;
    let mut rest = format.as_str();
    while !rest.is_empty() {
        if let Some(token) = FORMAT_TOKENS
            .iter()
            .position(|token| rest.starts_with(token))
        {
            let width = if token == 0 { 4 } else { 2 };
            let digits = remaining
                .get(..width)
                .filter(|digits| digits.bytes().all(|byte| byte.is_ascii_digit()))?;
            values[token] = Some(js::string_to_number(digits));
            remaining = &remaining[width..];
            rest = &rest[FORMAT_TOKENS[token].len()..];
        } else {
            let c = rest.chars().next()?;
            remaining = remaining.strip_prefix(c)?;
            rest = &rest[c.len_utf8()..];
        }
    }
    if !remaining.is_empty() {
        return None;
    }
    let [year, hour, month, day, minute, second] = values;
    let fields = DateFields {
        year: year?,
        month: month.unwrap_or(1.0),
        day: day.unwrap_or(1.0),
        hour: hour.unwrap_or(0.0),
        minute: minute.unwrap_or(0.0),
        second: second.unwrap_or(0.0),
    };
    let in_range = (1.0..=12.0).contains(&fields.month)
        && (1.0..=31.0).contains(&fields.day)
        && (0.0..=23.0).contains(&fields.hour)
        && (0.0..=59.0).contains(&fields.minute)
        && (0.0..=59.0).contains(&fields.second);
    if !in_range {
        return None;
    }
    let time = fields.to_time();
    if time.is_nan() {
        return None;
    }
    let p = date::parts(time);
    let round_trips = p.year as f64 == fields.year
        && (p.month + 1) as f64 == fields.month
        && p.day as f64 == fields.day
        && p.hour as f64 == fields.hour
        && p.minute as f64 == fields.minute
        && p.second as f64 == fields.second;
    round_trips.then_some(fields)
}

/// `dateFromInput`: a formatted date when a format is given and matches, else
/// whatever `new Date(text)` makes of the text.
fn date_from_input(value: &Value, format: Option<&Value>) -> Option<f64> {
    if let Some(fields) = parse_formatted_date_parts(value, format) {
        return Some(fields.to_time());
    }
    let text = to_str(value);
    let text = js::trim(&text);
    if text.is_empty() {
        return None;
    }
    let time = date::parse(text);
    (!time.is_nan()).then_some(time)
}

/// `timezoneOffsetMs`: the zone's offset at `time`, read back through the
/// formatted parts like the TS code does.
fn timezone_offset_ms(time: f64, zone_name: &str, env: &mut dyn Environment) -> Option<f64> {
    let zone = date::time_zone(zone_name, env)?;
    let parts = date::intl_parts(time, &zone, env);
    let number = |text: &str| js::string_to_number(text);
    let as_utc = date::date_utc(
        number(&parts.year),
        number(&parts.month) - 1.0,
        number(&parts.day),
        number(&parts.hour),
        number(&parts.minute),
        number(&parts.second),
    );
    Some(as_utc - time)
}

fn date_from_input_timezone(
    value: &Value,
    format: Option<&Value>,
    zone: Option<&Value>,
    env: &mut dyn Environment,
) -> Option<f64> {
    let zone = to_str(zone.unwrap_or(&NULL));
    let zone = js::trim(&zone);
    if zone.is_empty() {
        return None;
    }
    let utc_guess = parse_formatted_date_parts(value, format)?.to_time();
    let offset = timezone_offset_ms(utc_guess, zone, env)?;
    let corrected_offset = timezone_offset_ms(utc_guess - offset, zone, env)?;
    Some(date::time_clip(utc_guess - corrected_offset))
}

struct DateReplacements {
    year: String,
    month: String,
    day: String,
    hour: String,
    minute: String,
    second: String,
}

fn last_two(text: &str) -> &str {
    let units = js::utf16_len(text);
    if units <= 2 {
        text
    } else {
        &text[text.len() - 2..]
    }
}

/// `dateParts`: UTC fields, or the fields `Intl` gives in `zone` (UTC again
/// when the zone is invalid).
fn date_parts(time: f64, zone: Option<&str>, env: &mut dyn Environment) -> DateReplacements {
    if let Some(zone) = zone.filter(|zone| !zone.is_empty())
        && let Some(zone) = date::time_zone(zone, env)
    {
        let parts = date::intl_parts(time, &zone, env);
        return DateReplacements {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour: parts.hour,
            minute: parts.minute,
            second: parts.second,
        };
    }
    let p = date::parts(time);
    DateReplacements {
        year: p.year.to_string(),
        month: format!("{:02}", p.month + 1),
        day: format!("{:02}", p.day),
        hour: format!("{:02}", p.hour),
        minute: format!("{:02}", p.minute),
        second: format!("{:02}", p.second),
    }
}

/// `datetimeFormat`: `YYYY`, `YY`, `MM`, `DD`, `HH24`/`HH`, `MI` and `SS` are
/// replaced; the single word `day` gives the weekday name.
fn datetime_format(
    value: &Value,
    format: &Value,
    zone: Option<&Value>,
    env: &mut dyn Environment,
) -> String {
    let Some(time) = date_from_input(value, None) else {
        return String::new();
    };
    let zone_name = zone.map(|zone| to_str(zone).into_owned());
    let pattern = to_str(format);
    let pattern = if pattern.is_empty() {
        "YYYY-MM-DD"
    } else {
        &pattern
    };
    if pattern == "day" {
        let zone = date::time_zone(zone_name.as_deref().unwrap_or("UTC"), env)
            .unwrap_or(date::TimeZone::Fixed(0.0));
        return date::WEEKDAYS[zone.local_parts(time, env).weekday as usize].to_owned();
    }
    let r = date_parts(time, zone_name.as_deref(), env);
    // The order of `/HH24|YYYY|YY|MM|DD|HH|MI|SS/`: the first alternative wins.
    let tokens: [(&str, &str); 8] = [
        ("HH24", &r.hour),
        ("YYYY", &r.year),
        ("YY", last_two(&r.year)),
        ("MM", &r.month),
        ("DD", &r.day),
        ("HH", &r.hour),
        ("MI", &r.minute),
        ("SS", &r.second),
    ];
    let mut out = String::with_capacity(pattern.len());
    let mut rest = pattern;
    'scan: while !rest.is_empty() {
        for (token, replacement) in tokens {
            if let Some(after) = rest.strip_prefix(token) {
                out.push_str(replacement);
                rest = after;
                continue 'scan;
            }
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

fn iso_string(time: f64) -> Result<String, Error> {
    date::to_iso_string(time).ok_or_else(|| Error::Evaluation(INVALID_TIME_VALUE.to_owned()))
}

fn date_only(time: f64) -> Result<String, Error> {
    Ok(js::slice(&iso_string(time)?, 0.0, Some(10.0)))
}

fn date_diff(unit: &Value, start: &Value, end: &Value) -> Value {
    let (Some(start), Some(end)) = (date_from_input(start, None), date_from_input(end, None))
    else {
        return Value::Null;
    };
    let unit = js::to_lower(&to_str(unit));
    let diff = end - start;
    let (start_parts, end_parts) = (date::parts(start), date::parts(end));
    let floor = |divisor: f64| Value::Number((diff / divisor).floor());
    match unit.as_str() {
        "yy" | "yyyy" | "year" | "years" | "y" => {
            Value::Number((end_parts.year - start_parts.year) as f64)
        }
        "mm" | "month" | "months" | "mon" => Value::Number(
            ((end_parts.year - start_parts.year) * 12 + (end_parts.month - start_parts.month))
                as f64,
        ),
        "wk" | "week" | "weeks" | "w" => floor(604_800_000.0),
        "dd" | "day" | "days" | "d" => floor(86_400_000.0),
        "hh" | "hour" | "hours" | "h" => floor(3_600_000.0),
        "mi" | "minute" | "minutes" | "m" => floor(60_000.0),
        "ss" | "second" | "seconds" | "s" => floor(1000.0),
        _ => Value::Number(f64::NAN),
    }
}

static INTERVAL: Pattern = Pattern::new(
    r"^(-?\d+(?:\.\d+)?)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years|s|m|h|d|w|mo|y)$",
    "",
);

/// `intervalSpec`: the amount and unit of an interval such as `2 months`.
fn interval_spec(value: &Value) -> Option<Interval> {
    let text = js::to_lower(js::trim(&to_str(value)));
    let groups = INTERVAL.captures(&text)?;
    Some(Interval {
        amount: js::string_to_number(groups.get(1).copied().flatten()?),
        unit: groups.get(2).copied().flatten()?.to_owned(),
    })
}

fn interval_seconds(interval: &Interval) -> f64 {
    let multiplier = match interval.unit.as_str() {
        "second" | "seconds" | "s" => 1.0,
        "minute" | "minutes" | "m" => 60.0,
        "hour" | "hours" | "h" => 3600.0,
        "day" | "days" | "d" => 86_400.0,
        "week" | "weeks" | "w" => 604_800.0,
        "month" | "months" | "mo" => 2_592_000.0,
        _ => 31_536_000.0,
    };
    interval.amount * multiplier
}

/// `durationIntervalText`: `1 year`, `2 seconds`...
fn duration_interval_text(interval: &Interval) -> String {
    let unit = match interval.unit.as_str() {
        "s" | "second" | "seconds" => "second",
        "m" | "minute" | "minutes" => "minute",
        "h" | "hour" | "hours" => "hour",
        "d" | "day" | "days" => "day",
        "w" | "week" | "weeks" => "week",
        "mo" | "month" | "months" => "month",
        "y" | "year" | "years" => "year",
        other => other,
    };
    let suffix = if interval.amount.abs() == 1.0 {
        unit.to_owned()
    } else {
        format!("{unit}s")
    };
    format!("{} {suffix}", js::number_to_string(interval.amount))
}

/// `formulaDuration`: `None` for a non-finite number of seconds.
fn formula_duration(seconds: f64, interval: Option<Interval>) -> Option<Duration> {
    if !seconds.is_finite() {
        return None;
    }
    let text = interval
        .as_ref()
        .map_or_else(|| js::number_to_string(seconds), duration_interval_text);
    Some(Duration {
        seconds,
        text,
        interval,
    })
}

fn duration_value(duration: Option<Duration>) -> Value {
    duration.map_or(Value::Null, |duration| Value::Duration(Box::new(duration)))
}

fn date_interval_value(value: &Value) -> Value {
    let spec = interval_spec(value);
    let seconds = match &spec {
        Some(interval) => Some(interval_seconds(interval)),
        None => parse_duration_seconds(value),
    };
    duration_value(seconds.and_then(|seconds| formula_duration(seconds, spec)))
}

fn to_duration(value: &Value) -> Option<Duration> {
    match value {
        Value::Duration(duration) => Some(Duration::clone(duration)),
        Value::Number(_) | Value::Text(_) => formula_duration(parse_duration_seconds(value)?, None),
        _ => None,
    }
}

fn arithmetic_duration(value: &Value) -> Option<&Duration> {
    match value {
        Value::Duration(duration) => Some(duration.as_ref()),
        _ => None,
    }
}

/// `dateTimeMs`: only text can be a date in arithmetic and comparisons.
fn date_time_ms(value: &Value) -> Option<f64> {
    match value {
        Value::Text(_) => date_from_input(value, None),
        _ => None,
    }
}

fn is_date_only_value(value: &Value) -> bool {
    let Value::Text(text) = value else {
        return false;
    };
    let bytes = js::trim(text).as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

/// `addDurationToDate`: calendar units move the calendar (a month is a month),
/// other durations add their seconds. Date-only inputs give a date-only result.
fn add_duration_to_date(
    date_value: &Value,
    duration: &Duration,
    sign: f64,
) -> Result<Value, Error> {
    let Some(mut time) = date_from_input(date_value, None) else {
        return Ok(Value::Null);
    };
    let date_only_result = is_date_only_value(date_value);
    let add_seconds = |time: f64| date::time_clip(time + duration.seconds * sign * 1000.0);
    match &duration.interval {
        Some(interval) if interval.amount.fract() == 0.0 && interval.amount.is_finite() => {
            let amount = interval.amount * sign;
            let p = date::parts(time);
            time = match interval.unit.as_str() {
                "year" | "years" | "y" => date::set_full_year(time, p.year as f64 + amount),
                "month" | "months" | "mo" => date::set_month(time, p.month as f64 + amount),
                "week" | "weeks" | "w" => date::set_date(time, p.day as f64 + amount * 7.0),
                "day" | "days" | "d" => date::set_date(time, p.day as f64 + amount),
                _ => add_seconds(time),
            };
        }
        _ => time = add_seconds(time),
    }
    Ok(Value::Text(if date_only_result {
        date_only(time)?
    } else {
        iso_string(time)?
    }))
}

fn add_values(left: &Value, right: &Value) -> Result<Value, Error> {
    let left_duration = arithmetic_duration(left);
    let right_duration = arithmetic_duration(right);
    if let Some(duration) = right_duration
        && date_time_ms(left).is_some()
    {
        return add_duration_to_date(left, duration, 1.0);
    }
    if let Some(duration) = left_duration
        && date_time_ms(right).is_some()
    {
        return add_duration_to_date(right, duration, 1.0);
    }
    if let (Some(left), Some(right)) = (left_duration, right_duration) {
        return Ok(duration_value(formula_duration(
            left.seconds + right.seconds,
            None,
        )));
    }
    if matches!(left, Value::Text(_)) || matches!(right, Value::Text(_)) {
        return Ok(Value::Text(to_str(left).into_owned() + &to_str(right)));
    }
    Ok(Value::Number(to_num(left) + to_num(right)))
}

fn minus_values(left: &Value, right: &Value) -> Result<Value, Error> {
    let left_duration = arithmetic_duration(left);
    let right_duration = arithmetic_duration(right);
    if let Some(duration) = right_duration
        && date_time_ms(left).is_some()
    {
        return add_duration_to_date(left, duration, -1.0);
    }
    if let (Some(left_ms), Some(right_ms)) = (date_time_ms(left), date_time_ms(right)) {
        return Ok(duration_value(formula_duration(
            (left_ms - right_ms) / 1000.0,
            None,
        )));
    }
    if let (Some(left), Some(right)) = (left_duration, right_duration) {
        return Ok(duration_value(formula_duration(
            left.seconds - right.seconds,
            None,
        )));
    }
    Ok(Value::Number(to_num(left) - to_num(right)))
}

fn multiply_values(left: &Value, right: &Value) -> Value {
    match (arithmetic_duration(left), arithmetic_duration(right)) {
        (Some(duration), None) => {
            duration_value(formula_duration(duration.seconds * to_num(right), None))
        }
        (None, Some(duration)) => {
            duration_value(formula_duration(to_num(left) * duration.seconds, None))
        }
        _ => Value::Number(to_num(left) * to_num(right)),
    }
}

fn divide_values(left: &Value, right: &Value) -> Value {
    let denominator = to_num(right);
    let left_duration = arithmetic_duration(left);
    if denominator == 0.0 {
        return if left_duration.is_some() {
            Value::Null
        } else {
            Value::Number(f64::NAN)
        };
    }
    match left_duration {
        Some(duration) => duration_value(formula_duration(duration.seconds / denominator, None)),
        None => Value::Number(to_num(left) / denominator),
    }
}

/// `compareValues`: dates compare as dates (a date never compares with a
/// non-date), everything else as numbers.
fn compare_values(op: BinaryOp, left: &Value, right: &Value) -> bool {
    let left_date = date_time_ms(left);
    let right_date = date_time_ms(right);
    let (left, right) = match (left_date, right_date) {
        (None, None) => (to_num(left), to_num(right)),
        (Some(left), Some(right)) => (left, right),
        _ => return false,
    };
    match op {
        BinaryOp::Lt => left < right,
        BinaryOp::LtEq => left <= right,
        BinaryOp::Gt => left > right,
        BinaryOp::GtEq => left >= right,
        _ => false,
    }
}

// ── Numbers ───────────────────────────────────────────────────────────────────

fn round_half_away_from_zero(value: f64, decimal_places: f64) -> f64 {
    if !value.is_finite() || !decimal_places.is_finite() {
        return f64::NAN;
    }
    let factor = js::math_pow(10.0, decimal_places);
    if !factor.is_finite() || factor == 0.0 {
        return value;
    }
    let scaled = value * factor;
    let rounded = js::math_sign(scaled) * (scaled.abs() + 0.5 + f64::EPSILON).floor();
    rounded / factor
}

fn positive_log(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        finite_or_nan(value.ln())
    } else {
        f64::NAN
    }
}

static URL: Pattern = Pattern::new(
    r"^(?:([a-zA-Z]+):\/\/)?(?:([a-zA-Z0-9._%+-]+)(:[a-zA-Z0-9._%+-]+)?@)?([a-zA-Z0-9.-]+)(?::(\d+))?(\/[^?]*)?(\?.*)?(#.*)?$",
    "u",
);

/// Positional access to evaluated arguments, `null` past the end (the TS code
/// reads `undefined` there, which it treats as `null` almost everywhere).
struct Args<'a>(&'a [Value]);

impl<'a> Args<'a> {
    fn get(&self, index: usize) -> &'a Value {
        self.0.get(index).unwrap_or(&NULL)
    }

    fn num(&self, index: usize) -> f64 {
        to_num(self.get(index))
    }

    fn text(&self, index: usize) -> Cow<'a, str> {
        to_str(self.get(index))
    }

    fn len(&self) -> usize {
        self.0.len()
    }

    /// The argument was given and is `null` (as opposed to missing).
    fn is_explicit_null(&self, index: usize) -> bool {
        self.0.get(index).is_some_and(Value::is_null)
    }
}

fn number(value: f64) -> Result<Value, Error> {
    Ok(Value::Number(value))
}

fn text(value: impl Into<String>) -> Result<Value, Error> {
    Ok(Value::Text(value.into()))
}

fn boolean(value: bool) -> Result<Value, Error> {
    Ok(Value::Bool(value))
}

fn link(url: String, label: Value) -> Value {
    let mut object = Object::new();
    object.insert("url", url);
    object.insert("label", label);
    Value::Object(object)
}

impl Evaluator<'_> {
    fn random(&mut self) -> f64 {
        random_f64(self.env)
    }

    /// `callFunction`. Kept out of line: inlined into the recursive `eval`, its
    /// large frame would be paid at every nesting level of the formula.
    #[inline(never)]
    fn call(&mut self, name: &str, values: &[Value]) -> Result<Value, Error> {
        let args = Args(values);
        let a = |index: usize| args.get(index);
        let n = |index: usize| args.num(index);
        let s = |index: usize| args.text(index);

        match name {
            // ── Logic ──
            "AND" => boolean(values.iter().all(to_bool)),
            "OR" => boolean(values.iter().any(to_bool)),
            "FIELD" => Ok(self.fields.get(&s(0)).cloned().unwrap_or_default()),
            "GET" => Ok(get_formula_path(self.fields, a(0))),
            "FIELD_BY_ID" => {
                let key = format!("field_{}", js::number_to_string(n(0).trunc()));
                Ok(self.fields.get(&key).cloned().unwrap_or_default())
            }
            "ROW_ID" => {
                let row_id = ["__row_id", "row_id", "id"]
                    .iter()
                    .find_map(|key| self.fields.get(key).filter(|value| !value.is_null()));
                let id = match row_id {
                    Some(value) => js::to_number(value),
                    // `a ?? b ?? c` yields `c` itself: `Number(null)` is 0, `Number(undefined)` NaN.
                    None if self.fields.contains_key("id") => 0.0,
                    None => f64::NAN,
                };
                Ok(if id.is_finite() {
                    Value::Number(id)
                } else {
                    Value::Null
                })
            }
            "LOOKUP" => {
                let (through, target) = (s(0), s(1));
                let exact = format!("lookup:{through}:{target}");
                let lower = format!(
                    "lookup:{}:{}",
                    js::to_lower(&through),
                    js::to_lower(&target)
                );
                Ok([exact, lower]
                    .iter()
                    .find_map(|key| {
                        self.fields
                            .get(key)
                            .filter(|value| !value.is_null())
                            .cloned()
                    })
                    .unwrap_or_else(|| Value::Array(Vec::new())))
            }
            "IF" => Ok(if to_bool(a(0)) {
                a(1).clone()
            } else if args.len() > 2 {
                a(2).clone()
            } else {
                Value::Null
            }),
            "ISBLANK" => boolean(is_blank(a(0))),
            "IS_EMPTY" => boolean(is_runtime_empty(a(0))),
            "ISNULL" | "IS_NULL" => boolean(a(0).is_null()),
            "NOT" => boolean(!to_bool(a(0))),
            // The argument is already evaluated: an error would have stopped
            // the formula before reaching here, as in the TS engine.
            "IFERROR" => Ok(a(0).clone()),
            "SWITCH" => {
                let value = a(0);
                let mut index = 1;
                while index + 1 < args.len() {
                    if js::loose_equals(value, a(index)) {
                        return Ok(a(index + 1).clone());
                    }
                    index += 2;
                }
                // An even count ends with a default; `switch()` reads `args[-1]`.
                Ok(match args.len().checked_sub(1) {
                    Some(last) if args.len() % 2 == 0 => a(last).clone(),
                    _ => Value::Null,
                })
            }
            "WHEN_EMPTY" => Ok(if a(0).is_null() {
                a(1).clone()
            } else {
                a(0).clone()
            }),

            // ── Text ──
            "CONCAT" | "CONCATENATE" => text(
                values
                    .iter()
                    .map(|value| to_str(value).into_owned())
                    .collect::<String>(),
            ),
            "UPPER" => Ok(vectorized(values, |items| {
                Value::Text(js::to_upper(&to_str(Args(items).get(0))))
            })),
            "LOWER" => Ok(vectorized(values, |items| {
                Value::Text(js::to_lower(&to_str(Args(items).get(0))))
            })),
            "CAPITALIZE" => Ok(vectorized(values, |items| {
                Value::Text(capitalize(Args(items).get(0)))
            })),
            "STRIP" | "TRIM" => Ok(vectorized(values, |items| {
                Value::from(js::trim(&to_str(Args(items).get(0))))
            })),
            "LEN" | "LENGTH" => Ok(vectorized(values, |items| {
                Value::Number(js::utf16_len(&to_str(Args(items).get(0))) as f64)
            })),
            "LEFT" => {
                if a(1).is_null() || !n(1).is_finite() {
                    return Ok(Value::Null);
                }
                text(js::slice(&s(0), 0.0, Some(trunc_num(a(1)))))
            }
            "RIGHT" => {
                if a(1).is_null() || !n(1).is_finite() {
                    return Ok(Value::Null);
                }
                let count = trunc_num(a(1));
                text(if count == 0.0 {
                    String::new()
                } else {
                    js::slice(&s(0), -count, None)
                })
            }
            "MID" | "SUBSTR" | "SUBSTRING" => {
                if args.is_explicit_null(1) || args.is_explicit_null(2) {
                    return Ok(Value::Null);
                }
                let start = n(1) - 1.0;
                text(js::slice(&s(0), start, Some(start + n(2))))
            }
            "REPLACE" => {
                let (source, search, replacement) = (s(0), s(1), s(2));
                text(if search.is_empty() {
                    js::join_code_units(&source, &replacement)
                } else {
                    source.replace(&*search, &replacement)
                })
            }
            "REGEXREPLACE" | "REGEX_REPLACE" => {
                text(regexp::replace_all(&s(0), &s(1), &s(2)).unwrap_or_else(|| s(0).into_owned()))
            }
            "REGEXMATCH" | "REGEX_MATCH" => boolean(regexp::test(&s(0), &s(1)).unwrap_or(false)),
            "CONTAINS" => Ok(vectorized(values, |items| {
                let items = Args(items);
                Value::Bool(items.text(0).contains(&*items.text(1)))
            })),
            "HAS_OPTION" => {
                let expected = s(1);
                boolean(
                    as_array_value(a(0))
                        .iter()
                        .any(|item| option_text(item) == *expected),
                )
            }
            "GET_SINGLE_SELECT_VALUE" => Ok(single_select_value(a(0))),
            "GET_PROPERTY" => Ok(get_property_value(a(0), a(1))),
            "JSONB_EXTRACT_PATH_TEXT" => Ok(jsonb_extract_path_text(
                a(0),
                values.get(1..).unwrap_or_default(),
            )),
            "FIND" | "SEARCH" => {
                number(js::index_of(&s(0), &s(1)).map_or(0.0, |index| index as f64 + 1.0))
            }
            "REVERSE" => Ok(vectorized(values, |items| {
                Value::Text(to_str(Args(items).get(0)).chars().rev().collect())
            })),
            "SPLIT" => Ok(Value::Array(
                js::split(&s(0), &s(1))
                    .into_iter()
                    .map(Value::Text)
                    .collect(),
            )),
            "SPLIT_PART" => {
                let index = n(2).floor();
                if index < 1.0 {
                    return text("");
                }
                let parts = js::split(&s(0), &s(1));
                text(if index.is_finite() {
                    parts.get(index as usize - 1).cloned().unwrap_or_default()
                } else {
                    String::new()
                })
            }
            "ARRAYJOIN" | "JOIN" => text(match a(0) {
                Value::Array(items) => items
                    .iter()
                    .map(display_text)
                    .collect::<Vec<_>>()
                    .join(&s(1)),
                other => display_text(other),
            }),
            "T" => Ok(match a(0) {
                Value::Text(value) => Value::Text(value.clone()),
                _ => Value::Text(String::new()),
            }),
            "TOVARCHAR" | "TOTEXT" => text(s(0)),
            "TOURL" => {
                let url = s(0);
                text(if URL.is_match(&url) {
                    url.into_owned()
                } else {
                    String::new()
                })
            }
            "ENCODE_URI" => text(js::encode_uri(&s(0), true, false)),
            "ENCODE_URI_COMPONENT" => text(js::encode_uri(&s(0), false, true)),
            "BLANK" => Ok(Value::Null),

            // ── Link / Button ──
            "LINK" => Ok(link(
                s(0).into_owned(),
                if args.len() > 1 && !a(1).is_null() {
                    Value::Text(s(1).into_owned())
                } else {
                    Value::Null
                },
            )),
            "BUTTON" => Ok(link(
                s(0).into_owned(),
                Value::Text(if args.len() > 1 && !a(1).is_null() {
                    s(1).into_owned()
                } else {
                    String::new()
                }),
            )),
            "GET_LINK_URL" => Ok(if is_link(a(0)) {
                as_record(a(0))
                    .and_then(|record| record.get("url").cloned())
                    .unwrap_or_default()
            } else {
                Value::Null
            }),
            "GET_LINK_LABEL" => Ok(if is_link(a(0)) {
                as_record(a(0))
                    .and_then(|record| record.get("label").cloned())
                    .unwrap_or_default()
            } else {
                Value::Null
            }),

            // ── Numbers ──
            "EQUAL" => boolean(equal_arguments(values.first(), values.get(1))),
            "NOT_EQUAL" => boolean(!equal_arguments(values.first(), values.get(1))),
            "GREATER_THAN" => boolean(compare_values(BinaryOp::Gt, a(0), a(1))),
            "GREATER_THAN_OR_EQUAL" => boolean(compare_values(BinaryOp::GtEq, a(0), a(1))),
            "LESS_THAN" => boolean(compare_values(BinaryOp::Lt, a(0), a(1))),
            "LESS_THAN_OR_EQUAL" => boolean(compare_values(BinaryOp::LtEq, a(0), a(1))),
            "ADD" => add_values(a(0), a(1)),
            "MINUS" => minus_values(a(0), a(1)),
            "MULTIPLY" => Ok(multiply_values(a(0), a(1))),
            "DIVIDE" => Ok(divide_values(a(0), a(1))),
            "MOD" => number(if n(1) == 0.0 { f64::NAN } else { n(0) % n(1) }),
            "ABS" => number(n(0).abs()),
            "ROUND" => {
                let decimal_places = trunc_num(a(1));
                if !decimal_places.is_finite() {
                    return number(f64::NAN);
                }
                number(round_half_away_from_zero(n(0), decimal_places))
            }
            "ROUNDUP" | "CEIL" => number(n(0).ceil()),
            "ROUNDDOWN" | "FLOOR" => number(n(0).floor()),
            "POWER" | "POW" => number(js::math_pow(n(0), n(1))),
            "SQRT" => number(n(0).sqrt()),
            "EXP" => number(n(0).exp()),
            "LN" => number(positive_log(n(0))),
            "LOG" => {
                if args.len() <= 1 {
                    return number(positive_log(n(0)));
                }
                let (base, value) = (n(0), n(1));
                number(
                    if base.is_finite()
                        && value.is_finite()
                        && base > 0.0
                        && base != 1.0
                        && value > 0.0
                    {
                        finite_or_nan(value.ln() / base.ln())
                    } else {
                        f64::NAN
                    },
                )
            }
            "LOG10" => {
                let value = n(0);
                number(if value.is_finite() && value > 0.0 {
                    finite_or_nan(value.log10())
                } else {
                    f64::NAN
                })
            }
            "GREATEST" | "MAX" => {
                let values = numeric_function_values(values);
                Ok(if values.is_empty() {
                    Value::Null
                } else {
                    Value::Number(js::math_max(values))
                })
            }
            "LEAST" | "MIN" => {
                let values = numeric_function_values(values);
                Ok(if values.is_empty() {
                    Value::Null
                } else {
                    Value::Number(js::math_min(values))
                })
            }
            "SUM" => number(
                numeric_function_values(values)
                    .iter()
                    .fold(0.0, |total, value| total + value),
            ),
            "AVERAGE" | "AVG" => {
                let values = numeric_function_values(values);
                number(if values.is_empty() {
                    0.0
                } else {
                    values.iter().fold(0.0, |total, value| total + value) / values.len() as f64
                })
            }
            "VARIANCE_POP" => Ok(variance(&numeric_function_values(values), false)),
            "VARIANCE_SAMPLE" => Ok(variance(&numeric_function_values(values), true)),
            "STDDEV_POP" => Ok(variance_number(&numeric_function_values(values), false)
                .map_or(Value::Null, |v| Value::Number(v.sqrt()))),
            "STDDEV_SAMPLE" => Ok(variance_number(&numeric_function_values(values), true)
                .map_or(Value::Null, |v| Value::Number(v.sqrt()))),
            "INT" | "TRUNC" => number(n(0).trunc()),
            "IS_EVEN" | "EVEN" => {
                boolean(n(0).is_finite() && n(0).fract() == 0.0 && n(0) % 2.0 == 0.0)
            }
            "IS_ODD" | "ODD" => {
                boolean(n(0).is_finite() && n(0).fract() == 0.0 && (n(0) % 2.0).abs() == 1.0)
            }
            "SIGN" => number(js::math_sign(n(0))),
            "IS_NAN" => boolean(is_formula_nan(a(0))),
            "WHEN_NAN" => Ok(if is_formula_nan(a(0)) {
                a(1).clone()
            } else {
                a(0).clone()
            }),
            "RANDOM_INT" => {
                let (min, max) = (n(0).ceil(), n(1).floor());
                if !min.is_finite() || !max.is_finite() {
                    return number(f64::NAN);
                }
                let (low, high) = (min.min(max), min.max(max));
                number((self.random() * (high - low + 1.0)).floor() + low)
            }
            "RANDOM_FLOAT" => {
                let (min, max) = (n(0), n(1));
                if !min.is_finite() || !max.is_finite() {
                    return number(f64::NAN);
                }
                let (low, high) = (min.min(max), min.max(max));
                number(self.random() * (high - low) + low)
            }
            "RANDOM_BOOL" => boolean(self.random() < 0.5),
            "GENERATE_UUID" => text(random_uuid(self.env)),
            "PI" => number(std::f64::consts::PI),
            "E" => number(std::f64::consts::E),
            "TONUMBER" | "NUMBER" => number(if a(0).is_null() {
                formula_number("")
            } else {
                formula_number(&js::to_js_string(a(0)))
            }),

            // ── Dates ──
            "NOW" => text(iso_string(date::time_clip(self.env.now_ms()))?),
            "TODAY" => text(js::slice(
                &iso_string(date::time_clip(self.env.now_ms()))?,
                0.0,
                Some(10.0),
            )),
            "YEAR" | "MONTH" | "DAY" | "HOUR" | "MINUTE" | "SECOND" | "WEEKDAY" => {
                let time = date::parse(&s(0));
                if time.is_nan() {
                    return Ok(Value::Null);
                }
                let p = date::parts(time);
                number(match name {
                    "YEAR" => p.year,
                    "MONTH" => p.month + 1,
                    "DAY" => p.day,
                    "HOUR" => p.hour,
                    "MINUTE" => p.minute,
                    "SECOND" => p.second,
                    _ => p.weekday + 1,
                } as f64)
            }
            "DATEADD" => {
                let base = date::parse(&s(0));
                if base.is_nan() {
                    return Ok(Value::Null);
                }
                let amount = n(1);
                let p = date::parts(base);
                let time = match js::to_lower(&s(2)).as_str() {
                    "days" | "day" => date::set_date(base, p.day as f64 + amount),
                    "months" | "month" => date::set_month(base, p.month as f64 + amount),
                    "years" | "year" => date::set_full_year(base, p.year as f64 + amount),
                    "hours" | "hour" => date::set_hours(base, p.hour as f64 + amount),
                    "minutes" | "minute" => date::set_minutes(base, p.minute as f64 + amount),
                    _ => base,
                };
                text(iso_string(time)?)
            }
            "DATEDIFF" | "DATE_DIFF" => Ok(if args.len() >= 3 && matches!(a(0), Value::Text(_)) {
                date_diff(a(0), a(1), a(2))
            } else {
                date_diff(a(2), a(0), a(1))
            }),
            "DATE_INTERVAL" => Ok(date_interval_value(a(0))),
            "BC_TO_NULL" => Ok(bc_to_null(a(0))),
            "TODURATION" => Ok(if n(0).is_finite() {
                duration_value(formula_duration(n(0), None))
            } else {
                Value::Null
            }),
            "TOSECONDS" => {
                Ok(to_duration(a(0))
                    .map_or(Value::Null, |duration| Value::Number(duration.seconds)))
            }
            "TODATE" | "DATEFORMAT" => match date_from_input(a(0), Some(a(1))) {
                Some(time) => text(date_only(time)?),
                None => Ok(Value::Null),
            },
            "TODATE_TZ" => match date_from_input_timezone(a(0), Some(a(1)), Some(a(2)), self.env) {
                Some(time) => text(iso_string(time)?.replacen(".000Z", "Z", 1)),
                None => Ok(Value::Null),
            },
            "DATETIME_FORMAT" => text(datetime_format(a(0), a(1), None, self.env)),
            "DATETIME_FORMAT_TZ" => text(datetime_format(a(0), a(1), values.get(2), self.env)),

            // ── Arrays ──
            "COUNT" => number(match a(0) {
                Value::Array(items) => items
                    .iter()
                    .filter(|item| {
                        !item.is_null() && !matches!(item, Value::Text(text) if text.is_empty())
                    })
                    .count() as f64,
                // `count()` reads `undefined`, which is neither null nor "".
                _ if args.len() == 0 => 1.0,
                Value::Null => 0.0,
                Value::Text(text) if text.is_empty() => 0.0,
                _ => 1.0,
            }),
            "COUNTA" => number(match a(0) {
                Value::Array(items) => items.iter().filter(|item| js::truthy(item)).count() as f64,
                other => f64::from(u8::from(js::truthy(other))),
            }),
            "COUNTALL" => number(match a(0) {
                Value::Array(items) => items.len() as f64,
                _ => 1.0,
            }),
            "ARRAY_AGG" => Ok(array_agg(a(0), true)),
            "ARRAY_AGG_NO_NESTING" => Ok(array_agg(a(0), false)),
            "ARRAY_AGG_UNNESTING" => Ok(array_agg_unnesting(a(0))),
            "MANY_TO_MANY_AGG" | "MULTIPLE_SELECT_OPTIONS_AGG" => Ok(many_to_many_groups(a(0))),
            "MANY_TO_MANY_COUNT" | "MULTIPLE_SELECT_COUNT" => {
                number(many_to_many_leaf_values(a(0)).len() as f64)
            }
            "STRING_AGG_MANY_TO_MANY_VALUES" | "STRING_AGG_MULTIPLE_SELECT_VALUES" => {
                text(many_to_many_text(a(0)))
            }
            "FILTER" => {
                let items = match a(0) {
                    Value::Array(items) => items.clone(),
                    other => vec![other.clone()],
                };
                Ok(Value::Array(match a(1) {
                    Value::Array(mask) => items
                        .into_iter()
                        .enumerate()
                        .filter(|(index, _)| mask.get(*index).is_some_and(to_bool))
                        .map(|(_, item)| item)
                        .collect(),
                    mask if to_bool(mask) => items,
                    _ => Vec::new(),
                }))
            }
            "INDEX" => {
                let items = as_array_value(a(0));
                let index = n(1).trunc();
                Ok(if index >= 0.0 && index < items.len() as f64 {
                    items[index as usize].clone()
                } else {
                    Value::Null
                })
            }
            "AT" => Ok(runtime_at(a(0), a(1))),
            "TO_ARRAY" => Ok(ensure_runtime_array(a(0))),
            "ANY" => boolean(function_values(values).iter().any(to_bool)),
            "EVERY" => boolean(function_values(values).iter().all(to_bool)),

            // ── Files ──
            "GET_FILE_VISIBLE_NAME" => text(file_string(
                single_file_value(a(0)).as_ref(),
                &["visible_name", "original_name", "name"],
            )),
            "GET_FILE_MIME_TYPE" => text(file_string(
                single_file_value(a(0)).as_ref(),
                &["mime_type", "type"],
            )),
            "GET_FILE_COUNT" => number(file_values(a(0)).len() as f64),
            "GET_FILE_SIZE" => Ok(file_number(single_file_value(a(0)).as_ref(), &["size"])),
            "GET_IMAGE_WIDTH" => Ok(file_number(
                single_file_value(a(0)).as_ref(),
                &["image_width", "width"],
            )),
            "GET_IMAGE_HEIGHT" => Ok(file_number(
                single_file_value(a(0)).as_ref(),
                &["image_height", "height"],
            )),
            "IS_IMAGE" => {
                let Some(file) = single_file_value(a(0)) else {
                    return boolean(false);
                };
                if let Some(Value::Bool(is_image)) =
                    as_record(&file).and_then(|record| record.get("is_image").cloned())
                {
                    return boolean(is_image);
                }
                boolean(
                    js::to_lower(&file_string(Some(&file), &["mime_type", "type"]))
                        .starts_with("image/"),
                )
            }

            _ => Err(Error::Evaluation(format!("Unknown function: {name}"))),
        }
    }
}
