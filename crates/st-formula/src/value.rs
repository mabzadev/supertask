//! Formula values.
//!
//! The TS engine works on untyped JavaScript values, and several results depend on
//! JavaScript details: the order of object keys (it decides `JSON.stringify`
//! equality), or the duration objects that print as `"1 year"` but compare as
//! seconds. [`Value`] is the JSON data model plus those details, so the evaluator
//! can reproduce them without a JavaScript runtime.

use std::fmt;

use indexmap::IndexMap;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};

/// A value read from a row or produced by a formula.
///
/// `Duration` only exists while a formula runs: [`crate::evaluate_formula`] turns
/// durations into their number of seconds before returning, exactly like the TS
/// engine does.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Value {
    /// JavaScript `null` (and `undefined`, which the engine never tells apart
    /// in a way that reaches a result).
    #[default]
    Null,
    Bool(bool),
    /// Every number is an IEEE double, as in JavaScript: `1 / 0` style results
    /// are `NaN`, and very large literals lose precision the same way.
    Number(f64),
    Text(String),
    Array(Vec<Value>),
    Object(Object),
    /// Boxed, like [`Object`]'s entries, to keep `Value` at 32 bytes: values
    /// sit in every frame of the recursive evaluator.
    Duration(Box<Duration>),
}

/// A duration produced by `date_interval`, `toduration` or date arithmetic.
///
/// It keeps the text it was written with (`totext(date_interval('1 year'))` is
/// `"1 year"`) and, for calendar units, the interval itself: adding one month
/// to a date moves the month instead of adding 30 days.
#[derive(Clone, Debug, PartialEq)]
pub struct Duration {
    pub(crate) seconds: f64,
    pub(crate) text: String,
    pub(crate) interval: Option<Interval>,
}

/// The amount and unit of a duration written as text, such as `2 months`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Interval {
    pub(crate) amount: f64,
    pub(crate) unit: String,
}

impl Duration {
    /// The length of the duration in seconds.
    pub fn seconds(&self) -> f64 {
        self.seconds
    }

    /// The text the duration converts to, such as `"1 year"` or `"120"`.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The object JavaScript code sees when it reads properties of a duration.
    pub(crate) fn as_object(&self) -> Object {
        let mut object = Object::new();
        object.insert("__formulaDuration", Value::Bool(true));
        object.insert("seconds", Value::Number(self.seconds));
        object.insert("text", Value::Text(self.text.clone()));
        object.insert(
            "interval",
            match &self.interval {
                Some(interval) => interval.as_object().into(),
                None => Value::Null,
            },
        );
        object
    }
}

impl Interval {
    fn as_object(&self) -> Object {
        let mut object = Object::new();
        object.insert("amount", Value::Number(self.amount));
        object.insert("unit", Value::Text(self.unit.clone()));
        object
    }
}

impl Value {
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Text(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(number) => Some(*number),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    /// Parses JSON text the way `JSON.parse` does: exact numbers, key order
    /// kept. Use it for JSON stored as text (D1 columns), rather than
    /// `serde_json`, whose default number parsing can be off by one bit.
    /// Returns `None` for invalid JSON, and for nesting deeper than 512 levels.
    pub fn parse_json(text: &str) -> Option<Value> {
        crate::json::parse(text)
    }

    /// `JSON.stringify(value)`: the compact JSON text JavaScript produces.
    pub fn to_json_string(&self) -> String {
        crate::js::json_stringify(self)
    }

    /// Converts the value to `serde_json`, the way `JSON.stringify` would
    /// serialize it (`NaN` and infinities become `null`).
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Value::Null => serde_json::Value::Null,
            Value::Bool(value) => serde_json::Value::Bool(*value),
            Value::Number(number) => json_number(*number),
            Value::Text(text) => serde_json::Value::String(text.clone()),
            Value::Array(items) => {
                serde_json::Value::Array(items.iter().map(Value::to_json).collect())
            }
            Value::Object(object) => serde_json::Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key.to_owned(), value.to_json()))
                    .collect(),
            ),
            Value::Duration(duration) => duration_json_object(duration)
                .iter()
                .map(|(key, value)| (key.to_owned(), value.to_json()))
                .collect::<serde_json::Map<_, _>>()
                .into(),
        }
    }
}

/// The keys `JSON.stringify` writes for a duration: `interval` is left out when
/// it is `undefined`.
pub(crate) fn duration_json_object(duration: &Duration) -> Object {
    let mut object = duration.as_object();
    if duration.interval.is_none() {
        object.inner.map.shift_remove("interval");
    }
    object
}

fn json_number(number: f64) -> serde_json::Value {
    if let Some(integer) = exact_integer(number) {
        return serde_json::Value::from(integer);
    }
    serde_json::Number::from_f64(number).map_or(serde_json::Value::Null, serde_json::Value::Number)
}

/// Integral doubles are written without a fraction, as JavaScript prints them.
fn exact_integer(number: f64) -> Option<i64> {
    const SAFE: f64 = 9_007_199_254_740_992.0;
    (number.fract() == 0.0 && number.abs() <= SAFE).then_some(number as i64)
}

/// A JSON object whose keys keep JavaScript's order.
///
/// JavaScript lists integer-like keys first, in numeric order, then the other
/// keys in insertion order. The engine compares values through
/// `JSON.stringify`, so two objects are equal only when their keys come out in
/// the same order: keeping that order is what keeps equality faithful.
#[derive(Clone, Debug, Default)]
pub struct Object {
    /// Boxed so that an object, and therefore a [`Value`], stays small.
    inner: Box<Entries>,
}

#[derive(Clone, Debug, Default)]
struct Entries {
    map: IndexMap<String, Value>,
    /// How many leading entries are array indices (see [`array_index`]).
    index_keys: usize,
}

impl PartialEq for Object {
    /// Compares keys and values, ignoring order, like a deep equality test.
    fn eq(&self, other: &Self) -> bool {
        self.inner.map == other.inner.map
    }
}

impl Object {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.inner.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.map.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.inner.map.get(key)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.inner.map.contains_key(key)
    }

    /// Sets `key`, placing a new key where JavaScript would list it. An existing
    /// key keeps its position.
    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<Value>) {
        let key = key.into();
        let value = value.into();
        let entries = &mut *self.inner;
        if let Some(slot) = entries.map.get_mut(&key) {
            *slot = value;
            return;
        }
        match array_index(&key) {
            Some(index) => {
                let position = entries.map.as_slice()[..entries.index_keys]
                    .binary_search_by_key(&index, |key, _| array_index(key).unwrap_or(u32::MAX))
                    .unwrap_or_else(|position| position);
                entries.map.shift_insert(position, key, value);
                entries.index_keys += 1;
            }
            None => {
                entries.map.insert(key, value);
            }
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.inner
            .map
            .iter()
            .map(|(key, value)| (key.as_str(), value))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.inner.map.keys().map(String::as_str)
    }

    pub fn values(&self) -> impl Iterator<Item = &Value> {
        self.inner.map.values()
    }
}

/// The value of `key` if JavaScript treats it as an array index: a canonical
/// decimal integer below 2³² − 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    u32::try_from(value).ok().filter(|value| *value != u32::MAX)
}

impl<K: Into<String>, V: Into<Value>> FromIterator<(K, V)> for Object {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let mut object = Object::new();
        for (key, value) in iter {
            object.insert(key, value);
        }
        object
    }
}

impl IntoIterator for Object {
    type Item = (String, Value);
    type IntoIter = indexmap::map::IntoIter<String, Value>;

    fn into_iter(self) -> Self::IntoIter {
        self.inner.map.into_iter()
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Value::Bool(value)
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Self {
        Value::Number(value)
    }
}

impl From<i32> for Value {
    fn from(value: i32) -> Self {
        Value::Number(value.into())
    }
}

impl From<u32> for Value {
    fn from(value: u32) -> Self {
        Value::Number(value.into())
    }
}

impl From<i64> for Value {
    fn from(value: i64) -> Self {
        // Precision loss above 2^53 is what JavaScript numbers do too.
        Value::Number(value as f64)
    }
}

impl From<u64> for Value {
    fn from(value: u64) -> Self {
        Value::Number(value as f64)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Value::Text(value.to_owned())
    }
}

impl From<String> for Value {
    fn from(value: String) -> Self {
        Value::Text(value)
    }
}

impl From<Vec<Value>> for Value {
    fn from(value: Vec<Value>) -> Self {
        Value::Array(value)
    }
}

impl From<Object> for Value {
    fn from(value: Object) -> Self {
        Value::Object(value)
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(value: Option<T>) -> Self {
        value.map_or(Value::Null, Into::into)
    }
}

impl From<serde_json::Value> for Value {
    fn from(value: serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(value) => Value::Bool(value),
            serde_json::Value::Number(number) => Value::Number(number.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(text) => Value::Text(text),
            serde_json::Value::Array(items) => {
                Value::Array(items.into_iter().map(Value::from).collect())
            }
            serde_json::Value::Object(map) => Value::Object(map.into_iter().collect()),
        }
    }
}

impl From<&serde_json::Value> for Value {
    fn from(value: &serde_json::Value) -> Self {
        Value::from(value.clone())
    }
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => serializer.serialize_unit(),
            Value::Bool(value) => serializer.serialize_bool(*value),
            Value::Number(number) => match exact_integer(*number) {
                Some(integer) => serializer.serialize_i64(integer),
                None if number.is_finite() => serializer.serialize_f64(*number),
                None => serializer.serialize_unit(),
            },
            Value::Text(text) => serializer.serialize_str(text),
            Value::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Value::Object(object) => object.serialize(serializer),
            Value::Duration(duration) => duration_json_object(duration).serialize(serializer),
        }
    }
}

impl Serialize for Object {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.len()))?;
        for (key, value) in self.iter() {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Value {
    /// Deserializes any self-describing format. Objects keep their input order
    /// (adjusted to JavaScript's), whatever `serde_json` features are enabled.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ValueVisitor)
    }
}

impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::Object(object) => Ok(object),
            _ => Err(de::Error::custom("expected a JSON object")),
        }
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(value.into())
    }

    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(value.into())
    }

    fn visit_f64<E>(self, value: f64) -> Result<Value, E> {
        Ok(Value::Number(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(value.into())
    }

    fn visit_string<E>(self, value: String) -> Result<Value, E> {
        Ok(Value::Text(value))
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        Value::deserialize(deserializer)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut object = Object::new();
        while let Some((key, value)) = map.next_entry::<String, Value>()? {
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_keys_follow_javascript_order() {
        let object: Object = [
            ("b", 1),
            ("2", 1),
            ("a", 1),
            ("1", 1),
            ("4294967295", 1),
            ("4294967294", 1),
            ("-1", 1),
            ("01", 1),
        ]
        .into_iter()
        .collect();
        let keys: Vec<_> = object.keys().collect();
        assert_eq!(
            keys,
            ["1", "2", "4294967294", "b", "a", "4294967295", "-1", "01"]
        );
    }

    #[test]
    fn values_stay_small() {
        assert_eq!(std::mem::size_of::<Value>(), 32);
    }

    #[test]
    fn deserializing_keeps_input_order() {
        let value: Value = serde_json::from_str(r#"{"z": 1, "a": [true, null, 1.5]}"#).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.keys().collect::<Vec<_>>(), ["z", "a"]);
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"z":1,"a":[true,null,1.5]}"#
        );
    }

    #[test]
    fn non_finite_numbers_serialize_as_null() {
        assert_eq!(
            serde_json::to_string(&Value::Number(f64::NAN)).unwrap(),
            "null"
        );
        assert_eq!(
            Value::Number(f64::INFINITY).to_json(),
            serde_json::Value::Null
        );
        assert_eq!(serde_json::to_string(&Value::Number(-0.0)).unwrap(), "0");
    }
}
