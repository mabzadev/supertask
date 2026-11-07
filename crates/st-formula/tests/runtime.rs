//! Port of `tests/runtime-formulas.test.ts`.

use serde_json::json;
use st_formula::{FixedEnvironment, Value, runtime};

fn call(name: &str, args: serde_json::Value) -> Value {
    let args = match Value::from(args) {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    runtime::call(name, &args, &mut FixedEnvironment::new(0.0, 3))
        .expect("no error")
        .unwrap_or_else(|| panic!("{name} is not a runtime function"))
}

#[test]
fn supports_object_array_random_and_uuid_helpers_used_by_builder_and_automation() {
    assert_eq!(
        call(
            "get_property",
            json!([{ "email": "ada@example.com" }, "email"])
        ),
        Value::from("ada@example.com")
    );
    assert_eq!(
        call(
            "get_property",
            json!(["{\"email\":\"ada@example.com\"}", "email"])
        ),
        Value::from("ada@example.com")
    );
    assert_eq!(call("strip", json!(["  123  "])), Value::from("123"));
    assert_eq!(
        call("to_array", json!(["a, b, c"])),
        Value::from(json!(["a", "b", "c"]))
    );
    assert_eq!(call("at", json!([["a", "b", "c"], -1])), Value::from("c"));

    let random_int = call("random_int", json!([2, 4]))
        .as_f64()
        .unwrap_or(f64::NAN);
    assert!(random_int.fract() == 0.0 && (2.0..=4.0).contains(&random_int));
    let random_float = call("random_float", json!([2, 4]))
        .as_f64()
        .unwrap_or(f64::NAN);
    assert!((2.0..4.0).contains(&random_float));
    assert!(matches!(call("random_bool", json!([])), Value::Bool(_)));
    let uuid = call("generate_uuid", json!([]));
    assert_eq!(uuid.as_str().map(str::len), Some(36));
}

#[test]
fn follows_plain_javascript_coercions() {
    assert_eq!(
        call("CONCAT", json!(["a", 1, null, [1, "b"], { "k": true }])),
        Value::from("a1[1,\"b\"]{\"k\":true}")
    );
    assert_eq!(call("round", json!([2.345])), Value::from(2.35));
    assert_eq!(call("round", json!([2.5, 0])), Value::from(3));
    assert_eq!(call("tonumber", json!(["0x10"])), Value::from(16));
    assert_eq!(call("join", json!(["abc"])), Value::from("a,b,c"));
    assert_eq!(
        call("replace", json!(["a-b-c", "-", "$&$&"])),
        Value::from("a--b--c")
    );
    assert_eq!(call("length", json!([{ "a": 1, "b": 2 }])), Value::from(2));
    assert_eq!(
        call("contains", json!([{ "a": 1 }, "a"])),
        Value::Bool(true)
    );
    assert_eq!(call("is_odd", json!(["x"])), Value::Bool(true));
    assert!(
        runtime::call("unknown", &[], &mut FixedEnvironment::default())
            .unwrap()
            .is_none()
    );
    assert!(
        runtime::call(
            "round",
            &[Value::from(1), Value::from(101)],
            &mut FixedEnvironment::default()
        )
        .is_err()
    );
}
