//! Shared runtime functions of the builder and automation formulas, ported
//! from `src/services/runtime-formulas.ts`.
//!
//! Those formulas have their own evaluators (in the builder and automation
//! services), which hand the common functions to [`call`]. The semantics are
//! deliberately looser than the table formula engine's: plain JavaScript
//! `Number()`, truthiness and `JSON.stringify`, without the `NaN` guards.

use crate::Error;
use crate::env::{Environment, random_f64, random_uuid};
use crate::js;
use crate::value::Value;

/// Evaluates the runtime function `name` (case-insensitive) on already
/// evaluated arguments. `Ok(None)` means the function is not a common one and
/// the caller's own evaluator should handle it.
pub fn call(name: &str, args: &[Value], env: &mut dyn Environment) -> Result<Option<Value>, Error> {
    let arg = |index: usize| args.get(index);
    // `Number(x ?? 0)` and `String(x ?? "")`: a missing or null argument is 0 / "".
    let number = |index: usize| {
        arg(index)
            .filter(|value| !value.is_null())
            .map_or(0.0, js::to_number)
    };
    let text = |index: usize| {
        arg(index)
            .filter(|value| !value.is_null())
            .map_or_else(String::new, js::to_js_string)
    };

    let value = match js::to_lower(name).as_str() {
        "concat" => Value::Text(
            args.iter()
                .map(|arg| match arg {
                    Value::Null => String::new(),
                    Value::Text(text) => text.clone(),
                    other => js::json_stringify(other),
                })
                .collect(),
        ),
        "and" => Value::Bool(args.iter().all(js::truthy)),
        "or" => Value::Bool(args.iter().any(js::truthy)),
        "not" => Value::Bool(!arg(0).is_some_and(js::truthy)),
        "if" => (if arg(0).is_some_and(js::truthy) {
            arg(1)
        } else {
            arg(2)
        })
        .cloned()
        .unwrap_or_default(),
        "tonumber" => Value::Number(number(0)),
        "totext" => Value::Text(text(0)),
        "lower" => Value::Text(js::to_lower(&text(0))),
        "upper" => Value::Text(js::to_upper(&text(0))),
        "capitalize" => Value::Text(capitalize(&text(0))),
        "get_property" => get_property(arg(0), arg(1)),
        "add" => Value::Number(number(0) + number(1)),
        "minus" => Value::Number(number(0) - number(1)),
        "multiply" => Value::Number(number(0) * number(1)),
        "divide" => Value::Number(number(0) / number(1)),
        "round" => Value::Number(round(number(0), arg(1))?),
        "is_even" => Value::Bool(number(0) % 2.0 == 0.0),
        "is_odd" => Value::Bool(number(0) % 2.0 != 0.0),
        "random_int" => Value::Number(random_int(arg(0), arg(1), env)),
        "random_float" => Value::Number(random_float(arg(0), arg(1), env)),
        "random_bool" => Value::Bool(random_f64(env) < 0.5),
        "generate_uuid" => Value::Text(random_uuid(env)),
        "is_empty" => Value::Bool(is_empty(arg(0))),
        "length" => length(arg(0)),
        "contains" => contains(arg(0), arg(1)),
        "replace" => Value::Text(js::replace_all(&text(0), &text(1), &text(2))),
        "join" => join(
            arg(0),
            &if args.len() > 1 {
                text(1)
            } else {
                ",".to_owned()
            },
        ),
        "split" => Value::Array(
            js::split(
                &text(0),
                &if args.len() > 1 {
                    text(1)
                } else {
                    String::new()
                },
            )
            .into_iter()
            .map(Value::Text)
            .collect(),
        ),
        "strip" => Value::from(js::trim(&text(0))),
        "to_array" => to_array(arg(0)),
        "at" => at(arg(0), arg(1)),
        _ => return Ok(None),
    };
    Ok(Some(value))
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => js::to_upper(&first.to_string()) + &js::to_lower(chars.as_str()),
        None => String::new(),
    }
}

/// `Number(value.toFixed(places))`, two places by default. Like `toFixed`,
/// more than 100 places is a `RangeError`.
fn round(number: f64, places: Option<&Value>) -> Result<f64, Error> {
    if !number.is_finite() {
        return Ok(f64::NAN);
    }
    let places = match places {
        None => 2.0,
        Some(places) => {
            let parsed = js::to_number(places);
            (if parsed.is_nan() { 0.0 } else { parsed })
                .trunc()
                .max(0.0)
        }
    };
    if places > 100.0 {
        return Err(Error::Evaluation(
            "toFixed() digits argument must be between 0 and 100".to_owned(),
        ));
    }
    Ok(js::string_to_number(&js::to_fixed(number, places as usize)))
}

fn is_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::Object(object)) => object.is_empty(),
        Some(Value::Text(text)) => js::trim(text).is_empty(),
        Some(_) => false,
    }
}

fn length(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Array(items)) => Value::Number(items.len() as f64),
        Some(Value::Text(text)) => Value::Number(js::utf16_len(text) as f64),
        Some(Value::Object(object)) => Value::Number(object.len() as f64),
        Some(Value::Duration(duration)) => Value::Number(duration.as_object().len() as f64),
        _ => Value::Null,
    }
}

fn contains(value: Option<&Value>, needle: Option<&Value>) -> Value {
    let needle_value = needle.unwrap_or(&Value::Null);
    match value {
        // A missing needle is `undefined`, which no JSON array holds.
        Some(Value::Array(items)) => Value::Bool(
            needle.is_some()
                && items
                    .iter()
                    .any(|item| js::same_value_zero(item, needle_value)),
        ),
        // `String(needle)`: a missing needle is `undefined`, not `null`.
        Some(Value::Object(object)) => Value::Bool(
            object.contains_key(&needle.map_or_else(|| "undefined".to_owned(), js::to_js_string)),
        ),
        Some(Value::Text(text)) => {
            let needle = if needle_value.is_null() {
                String::new()
            } else {
                js::to_js_string(needle_value)
            };
            Value::Bool(text.contains(&needle))
        }
        _ => Value::Null,
    }
}

fn parse_json(value: &Value) -> Option<Value> {
    let Value::Text(text) = value else {
        return None;
    };
    let trimmed = js::trim(text);
    if !(trimmed.starts_with('[') || trimmed.starts_with('{')) {
        return None;
    }
    js::json_parse(trimmed)
}

fn get_property(value: Option<&Value>, property: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    let parsed = parse_json(value);
    let object = match parsed.as_ref().unwrap_or(value) {
        Value::Object(object) => object.clone(),
        Value::Duration(duration) => duration.as_object(),
        _ => return Value::Null,
    };
    let key = property
        .filter(|value| !value.is_null())
        .map_or_else(String::new, js::to_js_string);
    object.get(&key).cloned().unwrap_or_default()
}

fn join(value: Option<&Value>, separator: &str) -> Value {
    match value {
        Some(Value::Array(items)) => Value::Text(js::array_join(items, separator)),
        Some(Value::Text(text)) => Value::Text(js::join_code_units(text, separator)),
        _ => Value::Null,
    }
}

fn to_array(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Array(Vec::new());
    };
    let parsed = parse_json(value);
    Value::Array(match parsed.as_ref().unwrap_or(value) {
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

fn at(value: Option<&Value>, index: Option<&Value>) -> Value {
    // `Math.trunc(Number(index) || 0)`.
    let index = index.map_or(f64::NAN, js::to_number);
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    let Some(value) = value else {
        return Value::Null;
    };
    let parsed = parse_json(value);
    let resolve = |length: usize| {
        let resolved = if index < 0.0 {
            length as f64 + index
        } else {
            index
        };
        (resolved >= 0.0 && resolved < length as f64).then_some(resolved as usize)
    };
    match parsed.as_ref().unwrap_or(value) {
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

/// `Number(undefined)` is `NaN` where `Number(null)` is 0: a missing bound
/// makes the range invalid.
fn bound(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, js::to_number)
}

fn random_int(min: Option<&Value>, max: Option<&Value>, env: &mut dyn Environment) -> f64 {
    let (min, max) = (bound(min).ceil(), bound(max).floor());
    if !min.is_finite() || !max.is_finite() {
        return f64::NAN;
    }
    let (low, high) = (min.min(max), min.max(max));
    (random_f64(env) * (high - low + 1.0)).floor() + low
}

fn random_float(min: Option<&Value>, max: Option<&Value>, env: &mut dyn Environment) -> f64 {
    let (min, max) = (bound(min), bound(max));
    if !min.is_finite() || !max.is_finite() {
        return f64::NAN;
    }
    let (low, high) = (min.min(max), min.max(max));
    random_f64(env) * (high - low) + low
}
