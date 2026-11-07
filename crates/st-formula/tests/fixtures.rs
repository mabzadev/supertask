//! The JSON formula fixtures of `tests/cases/`, shared with the TS test suite.
//!
//! `supertask_formula_source_cases.json` runs exactly like
//! `tests/formula-source-fixtures.test.ts`: same trials, same expectations,
//! one trial per case so the counts line up with vitest's. The two other files
//! have no backend TS test; they run with the same checks, adapted to their
//! shape (see each section).

use std::collections::HashMap;
use std::path::PathBuf;

use libtest_mimic::{Arguments, Failed, Trial};
use serde_json::Value as Json;
use st_formula::{
    FieldNullables, FieldSettings, FieldTypes, FixedEnvironment, Object, Value, evaluate_formula,
    map_field_type_to_formula_nullable, map_field_type_to_formula_type, validate_formula_type,
};

/// 2026-11-07T12:00:00Z: fixtures compare `now()` with dates around 2020.
const NOW_MS: f64 = 1_794_052_800_000.0;

fn env() -> FixedEnvironment {
    FixedEnvironment::new(NOW_MS, 42)
}

fn load(name: &str) -> Json {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/cases")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn check(condition: bool, message: impl FnOnce() -> String) -> Result<(), Failed> {
    if condition {
        Ok(())
    } else {
        Err(message().into())
    }
}

/// Jest's `toBeCloseTo(expected, digits)`.
fn close_to(actual: f64, expected: f64, digits: usize) -> bool {
    if actual == expected {
        return true;
    }
    (expected - actual).abs() < 10f64.powi(-(digits as i32)) / 2.0
}

/// Jest's `toEqual` between a formula value and a JSON expectation.
fn deep_equal(actual: &Value, expected: &Json) -> bool {
    match (actual, expected) {
        (Value::Null, Json::Null) => true,
        (Value::Bool(actual), Json::Bool(expected)) => actual == expected,
        (Value::Number(actual), Json::Number(expected)) => Some(*actual) == expected.as_f64(),
        (Value::Text(actual), Json::String(expected)) => actual == expected,
        (Value::Array(actual), Json::Array(expected)) => {
            actual.len() == expected.len()
                && actual
                    .iter()
                    .zip(expected)
                    .all(|(actual, expected)| deep_equal(actual, expected))
        }
        (Value::Object(actual), Json::Object(expected)) => {
            actual.len() == expected.len()
                && expected.iter().all(|(key, expected)| {
                    actual
                        .get(key)
                        .is_some_and(|actual| deep_equal(actual, expected))
                })
        }
        _ => false,
    }
}

/// `expectSourceValue` from `formula-source-fixtures.test.ts`.
fn expect_source_value(actual: &Value, expected: &Json) -> Result<(), Failed> {
    if expected == "NaN" {
        return check(
            matches!(actual, Value::Number(number) if number.is_nan()),
            || format!("expected NaN, got {actual:?}"),
        );
    }
    if let Json::String(expected_text) = expected
        && is_decimal_text(expected_text)
    {
        if let Value::Text(actual) = actual {
            return check(actual == expected_text, || {
                format!("expected {expected_text:?}, got {actual:?}")
            });
        }
        let Value::Number(number) = actual else {
            return Err(
                format!("expected a number close to {expected_text}, got {actual:?}").into(),
            );
        };
        let digits = expected_text
            .split_once('.')
            .map_or(0, |(_, fraction)| fraction.len());
        let expected_number: f64 = expected_text.parse().unwrap_or(f64::NAN);
        return check(close_to(*number, expected_number, digits), || {
            format!("expected {expected_text}, got {number}")
        });
    }
    check(deep_equal(actual, expected), || {
        format!("expected {expected}, got {actual:?}")
    })
}

/// `/^-?\d+(?:\.\d+)?$/`.
fn is_decimal_text(text: &str) -> bool {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (integer, fraction) = unsigned
        .split_once('.')
        .map_or((unsigned, None), |(integer, fraction)| {
            (integer, Some(fraction))
        });
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    digits(integer) && fraction.is_none_or(digits)
}

fn evaluates(
    formula: String,
    expected: Json,
) -> impl FnOnce() -> Result<(), Failed> + Send + 'static {
    move || {
        let result = evaluate_formula(&formula, &Object::new(), &mut env());
        check(result.error.is_none(), || {
            format!("unexpected error: {:?}", result.error)
        })?;
        expect_source_value(&result.value, &expected)
    }
}

fn type_checks(formula: String) -> impl FnOnce() -> Result<(), Failed> + Send + 'static {
    move || {
        let inferred =
            validate_formula_type(&formula, &FieldTypes::new(), None, &FieldNullables::new());
        check(inferred.error.is_none(), || {
            format!("unexpected type error: {:?}", inferred.error)
        })
    }
}

fn is_rejected(formula: String) -> impl FnOnce() -> Result<(), Failed> + Send + 'static {
    move || {
        let inferred =
            validate_formula_type(&formula, &FieldTypes::new(), None, &FieldNullables::new());
        check(inferred.formula_type == "invalid", || {
            format!("expected invalid, got {}", inferred.formula_type)
        })
    }
}

/// A trial name on one line: formulas may contain newlines.
fn trial_name(prefix: &str, label: &str, formula: &str) -> String {
    let shown: String = formula
        .chars()
        .take(80)
        .flat_map(|c| {
            if c.is_control() {
                c.escape_debug().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect();
    format!("{prefix}::{label}: {shown}")
}

fn str_field<'a>(value: &'a Json, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn array<'a>(value: &'a Json, key: &str) -> &'a [Json] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}

fn source_case_trials(trials: &mut Vec<Trial>) {
    let fixture = load("supertask_formula_source_cases.json");
    let prefix = "supertask_formula_source_cases";

    let (source, cases, skipped) = (
        str_field(&fixture, "source").to_owned(),
        array(&fixture, "cases").len(),
        array(&fixture, "skipped_non_literal_cases").len(),
    );
    trials.push(Trial::test(
        format!("{prefix}::tracks the complete literal source fixture set"),
        move || {
            check(source.contains("test_supertask_formula_results.py"), || {
                format!("unexpected source {source}")
            })?;
            check(cases == 283, || {
                format!("expected 283 cases, found {cases}")
            })?;
            check(skipped == 0, || {
                format!("expected no skipped case, found {skipped}")
            })
        },
    ));

    for (index, case) in array(&fixture, "cases").iter().enumerate() {
        let formula = str_field(case, "formula").to_owned();
        trials.push(Trial::test(
            trial_name(prefix, &format!("evaluates {index}"), &formula),
            evaluates(formula, case["expected"].clone()),
        ));
    }
    for (index, case) in array(&fixture, "cases").iter().enumerate() {
        let formula = str_field(case, "formula").to_owned();
        trials.push(Trial::test(
            format!("{prefix}::accepts valid formula type {index}"),
            type_checks(formula),
        ));
    }

    let (invalid, skipped_invalid) = (
        array(&fixture, "invalid_cases").len(),
        array(&fixture, "skipped_invalid_cases").len(),
    );
    trials.push(Trial::test(
        format!("{prefix}::tracks the complete invalid source fixture set"),
        move || {
            check(invalid == 48, || {
                format!("expected 48 invalid cases, found {invalid}")
            })?;
            check(skipped_invalid == 0, || {
                format!("expected no skipped case, found {skipped_invalid}")
            })
        },
    ));
    for (index, case) in array(&fixture, "invalid_cases").iter().enumerate() {
        let formula = str_field(case, "formula").to_owned();
        trials.push(Trial::test(
            format!("{prefix}::rejects invalid formula {index}"),
            is_rejected(formula),
        ));
    }

    let (nullable, skipped_nullable) = (
        array(&fixture, "nullable_cases").len(),
        array(&fixture, "skipped_nullable_cases").len(),
    );
    trials.push(Trial::test(
        format!("{prefix}::tracks the complete nullable source fixture set"),
        move || {
            check(nullable == 55, || {
                format!("expected 55 nullable cases, found {nullable}")
            })?;
            check(skipped_nullable == 0, || {
                format!("expected no skipped case, found {skipped_nullable}")
            })
        },
    ));
    for (index, case) in array(&fixture, "nullable_cases").iter().enumerate() {
        let case = case.clone();
        trials.push(Trial::test(
            format!("{prefix}::infers nullable for source formula {index}"),
            move || nullable_case(&case),
        ));
    }
}

/// The nullable trial of the TS test: fields are typed in order, formula
/// fields through `validate_formula_type` on the fields before them.
fn nullable_case(case: &Json) -> Result<(), Failed> {
    let mut field_types: FieldTypes = HashMap::new();
    let mut field_nullables: FieldNullables = HashMap::new();
    for field in array(case, "fields") {
        let (field_type, name) = (
            str_field(field, "type"),
            str_field(field, "name").to_lowercase(),
        );
        let settings = match field["formula"].as_str() {
            Some(formula) if field_type == "formula" => {
                validate_formula_type(formula, &field_types, None, &field_nullables)
                    .field_settings()
            }
            _ => FieldSettings::default(),
        };
        let nullable = if field_type == "formula" {
            settings.nullable.unwrap_or(false)
        } else {
            map_field_type_to_formula_nullable(field_type, &settings)
        };
        field_types.insert(
            name.clone(),
            map_field_type_to_formula_type(field_type, &settings),
        );
        field_nullables.insert(name, nullable);
    }
    let inferred = validate_formula_type(
        str_field(case, "formula"),
        &field_types,
        None,
        &field_nullables,
    );
    check(inferred.error.is_none(), || {
        format!("unexpected type error: {:?}", inferred.error)
    })?;
    let expected = case["nullable"].as_bool().unwrap_or_default();
    check(inferred.nullable == expected, || {
        format!("expected nullable {expected}, got {}", inferred.nullable)
    })
}

/// `formula_results.json` holds the same valid cases as `[formula, expected]`
/// pairs and the invalid ones as `[formula, code, detail]`: they get the same
/// trials as the source cases.
fn formula_results_trials(trials: &mut Vec<Trial>) {
    let fixture = load("formula_results.json");
    let prefix = "formula_results";
    for (index, case) in array(&fixture, "valid").iter().enumerate() {
        let formula = case[0].as_str().unwrap_or_default().to_owned();
        let name = trial_name(prefix, &format!("evaluates {index}"), &formula);
        trials.push(Trial::test(
            name,
            evaluates(formula.clone(), case[1].clone()),
        ));
        trials.push(Trial::test(
            format!("{prefix}::accepts valid formula type {index}"),
            type_checks(formula),
        ));
    }
    for (index, case) in array(&fixture, "invalid").iter().enumerate() {
        let formula = case[0].as_str().unwrap_or_default().to_owned();
        trials.push(Trial::test(
            format!("{prefix}::rejects invalid formula {index}"),
            is_rejected(formula),
        ));
    }
}

/// `formula_runtime_cases.json` drives the frontend's JavaScript executor:
/// valid formulas evaluate against their context, invalid ones must fail. The
/// backend engine evaluates leniently (`1 + 'hello'` is `"1hello"`), so here
/// "fails" means an evaluation error or a type error.
fn runtime_case_trials(trials: &mut Vec<Trial>) {
    let fixture = load("formula_runtime_cases.json");
    let prefix = "formula_runtime_cases";
    for (index, case) in array(&fixture, "VALID_FORMULA_TESTS").iter().enumerate() {
        let formula = str_field(case, "formula").to_owned();
        let (context, expected) = (context_object(&case["context"]), case["result"].clone());
        trials.push(Trial::test(
            trial_name(prefix, &format!("resolves {index}"), &formula),
            move || {
                let result = evaluate_formula(&formula, &context, &mut env());
                check(result.error.is_none(), || {
                    format!("unexpected error: {:?}", result.error)
                })?;
                check(deep_equal(&result.value, &expected), || {
                    format!("expected {expected}, got {:?}", result.value)
                })
            },
        ));
    }
    for (index, case) in array(&fixture, "INVALID_FORMULA_TESTS").iter().enumerate() {
        let formula = str_field(case, "formula").to_owned();
        let context = context_object(&case["context"]);
        trials.push(Trial::test(
            trial_name(prefix, &format!("raises an error {index}"), &formula),
            move || {
                let result = evaluate_formula(&formula, &context, &mut env());
                let typed = validate_formula_type(
                    &formula,
                    &FieldTypes::new(),
                    None,
                    &FieldNullables::new(),
                );
                check(
                    result.error.is_some() || typed.formula_type == "invalid",
                    || "the formula was accepted".to_owned(),
                )
            },
        ));
    }
}

fn context_object(context: &Json) -> Object {
    match Value::from(context.clone()) {
        Value::Object(object) => object,
        _ => Object::new(),
    }
}

fn main() {
    let arguments = Arguments::from_args();
    let mut trials = Vec::new();
    source_case_trials(&mut trials);
    formula_results_trials(&mut trials);
    runtime_case_trials(&mut trials);
    libtest_mimic::run(&arguments, trials).exit();
}
