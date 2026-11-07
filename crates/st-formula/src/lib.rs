//! The Supertask formula engine: parser, type checker and evaluator, shared by
//! the Worker and the app.
//!
//! This is a port of the TypeScript engine of the Worker
//! (`src/services/formula-engine.ts`, `formula-types.ts` and
//! `runtime-formulas.ts`). Formulas already stored in tables must keep giving
//! the same results, so the port follows the TS code function by function,
//! JavaScript quirks included: values coerce the way JavaScript coerces them,
//! dates are read the way V8's `new Date(text)` reads them, and error messages
//! are the same strings.
//!
//! # Evaluating
//!
//! ```
//! use st_formula::{FixedEnvironment, Object, Value, evaluate_formula};
//!
//! let mut row = Object::new();
//! row.insert("First name", "Ada");
//! row.insert("Last name", "Lovelace");
//! let mut env = FixedEnvironment::default();
//!
//! let result = evaluate_formula("concat({First name}, ' ', field('Last name'))", &row, &mut env);
//! assert_eq!(result.value, Value::from("Ada Lovelace"));
//! assert_eq!(result.error, None);
//! ```
//!
//! [`evaluate_formula`] mirrors `evaluateFormula`: it never fails, and reports
//! problems in [`FormulaResult::error`]. To evaluate one formula over many
//! rows, [`parse`] it once and call [`Expr::evaluate`] per row.
//!
//! The row is an [`Object`] keyed by field name and by `field_<id>`, as built
//! by [`evaluate_formula_rows`]. `row_id()` reads `__row_id`, and
//! `lookup('Through', 'Target')` reads `lookup:Through:Target`, which the
//! caller fills with the linked values. Cells holding JSON text should be
//! read with [`Value::parse_json`], which matches `JSON.parse` exactly.
//!
//! # Typing
//!
//! [`validate_formula_type`] type-checks a formula against the types of the
//! table's fields and says whether it can be null; it is what field settings
//! are saved with. [`infer_formula_type`] is the looser inference behind the
//! formula builder's type endpoint, and [`infer_number_decimal_places`] picks
//! the decimal places of number formulas. [`extract_field_references`] and
//! [`extract_lookup_references`] list the dependencies of a formula.
//!
//! # Semantics worth knowing
//!
//! - Numbers are IEEE doubles. Invalid arithmetic gives `NaN` (`1 / 0`,
//!   `tonumber('x')`), and `NaN` serializes as `null`.
//! - Dates are ISO strings, and any text V8 can read is a date in comparisons
//!   and subtractions. Local time is UTC, as on Workers.
//! - An array (or JSON array text) in an operator or a text function maps over
//!   its items: `field('Names') = 'Bob'` gives one boolean per name.
//! - Durations print as written (`totext(date_interval('1 year'))` is
//!   `"1 year"`), compute in seconds, and come out of a formula as seconds.
//! - The clock and randomness come from an [`Environment`], because
//!   `wasm32-unknown-unknown` has neither.
//! - User regular expressions (`regex_replace`, `regex_match`) run on an
//!   ECMAScript engine, on UTF-16 code units like `new RegExp(p)` does.
//! - The parser does not recurse, and evaluation and typing walk operator
//!   chains in loops: the largest formulas the 2048-token limit allows need
//!   under 200 KiB of stack in release builds.
//!
//! # Features
//!
//! - `tzdb` (default): the IANA time zone database behind `todate_tz` and
//!   `datetime_format_tz`, about 75 KB of gzipped WASM. Without it, named
//!   zones come from [`Environment::time_zone_offset_ms`], which a host with
//!   `Intl` can implement (giving exactly V8's results).
//!
//! # Known differences with the TS engine
//!
//! The port is checked against the TS engine on about 100 000 generated
//! formulas (`tests/differential.rs`). What remains different is out of reach
//! of a JavaScript-free value model, and rare:
//!
//! - JavaScript strings may hold lone surrogates (`left('😀', 1)`); Rust
//!   strings cannot, so those become U+FFFD.
//! - `switch` compares with `==`, which is true for two references to the same
//!   JavaScript array or object (`switch(field('A'), field('A'), …)`). Values
//!   here have no identity, so arrays and objects never match in `switch`.
//! - JSON text nested deeper than 512 levels stays text.
//!
//! The builder and automation runtimes have their own evaluators over the same
//! syntax tree, and share the functions in [`runtime`].

mod date;
mod duration;
mod env;
mod eval;
mod functions;
mod js;
mod json;
mod parser;
mod regexp;
pub mod runtime;
mod types;
mod value;

use std::fmt;

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub use env::SystemEnvironment;
pub use env::{Environment, FixedEnvironment};
pub use functions::{FUNCTIONS, FunctionInfo};
pub use parser::{BinaryOp, Expr, Literal, UnaryOp, parse};
pub use types::{
    FieldDecimalPlaces, FieldNullables, FieldReference, FieldSettings, FieldTypes,
    InferredFormulaType, LookupReference, extract_field_references, extract_lookup_references,
    infer_formula_nullable, infer_formula_type, infer_number_decimal_places,
    map_field_type_to_formula_nullable, map_field_type_to_formula_type, validate_formula_type,
};
pub use value::{Duration, Object, Value};

/// Why a formula could not be parsed, typed or evaluated. The message is the
/// one the TS engine produces, ready to show to users.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// The tokenizer or the parser rejected the formula.
    Syntax(String),
    /// [`validate_formula_type`] rejected the formula.
    Type(String),
    /// Evaluation failed: an unknown function, or a date out of range.
    Evaluation(String),
}

impl Error {
    pub fn message(&self) -> &str {
        match self {
            Error::Syntax(message) | Error::Type(message) | Error::Evaluation(message) => message,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for Error {}

/// The outcome of [`evaluate_formula`]: a value, or `null` with an error.
#[derive(Clone, Debug, PartialEq)]
pub struct FormulaResult {
    pub value: Value,
    pub error: Option<String>,
}

impl Expr {
    /// Evaluates the formula against one row. Durations in the result are
    /// converted to seconds.
    pub fn evaluate(&self, fields: &Object, env: &mut dyn Environment) -> Result<Value, Error> {
        let mut evaluator = eval::Evaluator { fields, env };
        evaluator.eval(self).map(eval::unwrap)
    }
}

/// Parses and evaluates a formula against one row, like `evaluateFormula`.
pub fn evaluate_formula(
    formula: &str,
    fields: &Object,
    env: &mut dyn Environment,
) -> FormulaResult {
    match parse(formula).and_then(|expr| expr.evaluate(fields, env)) {
        Ok(value) => FormulaResult { value, error: None },
        Err(error) => FormulaResult {
            value: Value::Null,
            error: Some(error.to_string()),
        },
    }
}

/// Evaluates a formula for rows read from a table (`id` and `field_<id>`
/// keys), like `evaluateFormulaRows`. Each field is reachable by name, by
/// lower-cased name and by `field_<id>`; `fields_by_id` gives the names.
pub fn evaluate_formula_rows(
    formula: &str,
    rows: &[Object],
    fields_by_id: &[(u64, String)],
    env: &mut dyn Environment,
) -> Vec<FormulaResult> {
    let expr = parse(formula);
    rows.iter()
        .map(|row| {
            let row_id = row.get("id").cloned().unwrap_or_default();
            let mut fields = Object::new();
            fields.insert("__row_id", row_id.clone());
            fields.insert("row_id", row_id);
            for (id, name) in fields_by_id {
                let key = format!("field_{id}");
                let value = row.get(&key).cloned().unwrap_or_default();
                fields.insert(name.clone(), value.clone());
                fields.insert(key, value.clone());
                fields.insert(js::to_lower(name), value);
            }
            match expr
                .as_ref()
                .map_err(Clone::clone)
                .and_then(|expr| expr.evaluate(&fields, env))
            {
                Ok(value) => FormulaResult { value, error: None },
                Err(error) => FormulaResult {
                    value: Value::Null,
                    error: Some(error.to_string()),
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod stack_tests {
    use super::*;

    /// Runs `formula` at the deepest nesting the 2048-token limit allows, on a
    /// thread with `stack` bytes, and returns its result.
    fn on_stack(stack: usize, formula: String) -> FormulaResult {
        std::thread::Builder::new()
            .stack_size(stack)
            .spawn(move || {
                let result =
                    evaluate_formula(&formula, &Object::new(), &mut FixedEnvironment::default());
                let _ = validate_formula_type(
                    &formula,
                    &FieldTypes::new(),
                    None,
                    &FieldNullables::new(),
                );
                let _ = infer_number_decimal_places(&formula, &FieldDecimalPlaces::new());
                let _ = extract_field_references(&formula);
                result
            })
            .and_then(|thread| thread.join().map_err(|_| std::io::Error::other("panicked")))
            .unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn the_deepest_formulas_fit_on_a_small_stack() {
        // Debug frames are several times larger than release ones; the
        // release build fits in a quarter of this.
        let stack = if cfg!(debug_assertions) {
            2 << 20
        } else {
            512 << 10
        };
        let parens = format!("{}1{}", "(".repeat(1023), ")".repeat(1023));
        assert_eq!(on_stack(stack, parens).value, Value::Number(1.0));
        let calls = format!("{}'a'{}", "upper(".repeat(682), ")".repeat(682));
        assert_eq!(on_stack(stack, calls).value, Value::from("A"));
        let negations = format!("{}1{}", "-(".repeat(682), ")".repeat(682));
        assert_eq!(on_stack(stack, negations).value, Value::Number(1.0));
        let chain = ["1"; 1024].join("+");
        assert_eq!(on_stack(stack, chain).value, Value::Number(1024.0));
        let right_nested = format!("{}1{}", "1+(".repeat(511), ")".repeat(511));
        assert_eq!(on_stack(stack, right_nested).value, Value::Number(512.0));
    }
}
