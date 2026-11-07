//! Formula types, ported from `src/services/formula-types.ts`.
//!
//! Two inferences coexist, as in the TS code:
//!
//! - [`validate_formula_type`] walks the syntax tree and rejects ill-typed
//!   formulas (`'a' + 2`, `upper(1)`...). Field settings are saved with its
//!   result, nullability included.
//! - [`infer_formula_type`] answers the formula-builder endpoint: it looks at
//!   the root function and the evaluated value, and never rejects a formula
//!   that evaluated.
//!
//! Types are strings rather than an enum because field settings may carry any
//! type name (`formula_type` and `array_formula_type` come from stored JSON).

use std::collections::HashMap;

use indexmap::IndexMap;
use serde::ser::{Serialize, SerializeStruct, Serializer};

use crate::env::Environment;
use crate::js;
use crate::parser::{BinaryOp, Expr, Literal, UnaryOp, parse};
use crate::regexp::Pattern;
use crate::value::{Object, Value};
use crate::{Error, evaluate_formula};

/// Formula types by lower-cased field name and by `field_<id>`.
pub type FieldTypes = HashMap<String, String>;
/// Whether each field can be null, keyed like [`FieldTypes`].
pub type FieldNullables = HashMap<String, bool>;
/// The decimal places of number fields, keyed like [`FieldTypes`].
pub type FieldDecimalPlaces = HashMap<String, u32>;

const NUMBER_MAX_DECIMAL_PLACES: u32 = 10;

const ZERO_DECIMAL_FUNCTIONS: &[&str] = &[
    "CEIL",
    "COUNT",
    "COUNTA",
    "COUNTALL",
    "DATE_DIFF",
    "DATEDIFF",
    "DAY",
    "EVEN",
    "FIND",
    "FLOOR",
    "GET_FILE_COUNT",
    "GET_FILE_SIZE",
    "GET_IMAGE_HEIGHT",
    "GET_IMAGE_WIDTH",
    "HOUR",
    "INT",
    "IS_EVEN",
    "IS_ODD",
    "LENGTH",
    "LEN",
    "MANY_TO_MANY_COUNT",
    "MINUTE",
    "MONTH",
    "MULTIPLE_SELECT_COUNT",
    "ODD",
    "ROW_ID",
    "SEARCH",
    "SECOND",
    "SIGN",
    "TOSECONDS",
    "TRUNC",
    "WEEKDAY",
    "YEAR",
];

const FIRST_ARGUMENT_DECIMAL_FUNCTIONS: &[&str] = &[
    "ABS",
    "ARRAY_AGG",
    "ARRAY_AGG_NO_NESTING",
    "ARRAY_AGG_UNNESTING",
    "AVG",
    "AVERAGE",
    "ERROR_TO_NAN",
    "ERROR_TO_NULL",
    "EXP",
    "FILTER",
    "LN",
    "MAX",
    "MIN",
    "SQRT",
    "STDDEV_POP",
    "STDDEV_SAMPLE",
    "SUM",
    "VARIANCE_POP",
    "VARIANCE_SAMPLE",
];

const NUMBER_FUNCTIONS: &[&str] = &[
    "ABS",
    "ADD",
    "AVG",
    "AVERAGE",
    "CEIL",
    "COUNT",
    "COUNTA",
    "COUNTALL",
    "DATEDIFF",
    "DATE_DIFF",
    "DIVIDE",
    "EXP",
    "FLOOR",
    "GREATEST",
    "INT",
    "LEAST",
    "LEN",
    "LENGTH",
    "LN",
    "LOG",
    "LOG10",
    "MAX",
    "MIN",
    "MINUS",
    "MOD",
    "MULTIPLY",
    "POWER",
    "POW",
    "ROUND",
    "ROUNDDOWN",
    "ROUNDUP",
    "SEARCH",
    "FIND",
    "SIGN",
    "SQRT",
    "STDDEV_POP",
    "STDDEV_SAMPLE",
    "SUM",
    "TONUMBER",
    "TOSECONDS",
    "TRUNC",
    "VARIANCE_POP",
    "VARIANCE_SAMPLE",
    "YEAR",
    "MONTH",
    "DAY",
    "HOUR",
    "MINUTE",
    "SECOND",
    "WEEKDAY",
    "GET_FILE_COUNT",
    "GET_FILE_SIZE",
    "GET_IMAGE_WIDTH",
    "GET_IMAGE_HEIGHT",
    "ROW_ID",
    "ERROR_TO_NAN",
    "WHEN_NAN",
    "MANY_TO_MANY_COUNT",
    "MULTIPLE_SELECT_COUNT",
];

const BOOLEAN_FUNCTIONS: &[&str] = &[
    "AND",
    "ANY",
    "CONTAINS",
    "EVERY",
    "EVEN",
    "ISBLANK",
    "ISNULL",
    "IS_NULL",
    "IS_NAN",
    "ODD",
    "OR",
    "REGEXMATCH",
    "REGEX_MATCH",
    "IS_IMAGE",
    "EQUAL",
    "GREATER_THAN",
    "GREATER_THAN_OR_EQUAL",
    "HAS_OPTION",
    "LESS_THAN",
    "LESS_THAN_OR_EQUAL",
    "NOT",
    "NOT_EQUAL",
];

const TEXT_FUNCTIONS: &[&str] = &[
    "ARRAYJOIN",
    "CONCAT",
    "CONCATENATE",
    "DATETIME_FORMAT",
    "DATETIME_FORMAT_TZ",
    "ENCODE_URI",
    "ENCODE_URI_COMPONENT",
    "GET_LINK_LABEL",
    "GET_LINK_URL",
    "GET_FILE_VISIBLE_NAME",
    "GET_FILE_MIME_TYPE",
    "JOIN",
    "LEFT",
    "LOWER",
    "MID",
    "REGEXREPLACE",
    "REGEX_REPLACE",
    "REPLACE",
    "REVERSE",
    "RIGHT",
    "SPLIT_PART",
    "SUBSTR",
    "SUBSTRING",
    "T",
    "TOTEXT",
    "TOVARCHAR",
    "TRIM",
    "UPPER",
    "WHEN_EMPTY",
    "GET_SINGLE_SELECT_VALUE",
    "JSONB_EXTRACT_PATH_TEXT",
    "STRING_AGG_MANY_TO_MANY_VALUES",
    "STRING_AGG_MULTIPLE_SELECT_VALUES",
];

const DATE_FUNCTIONS: &[&str] = &[
    "BC_TO_NULL",
    "DATEADD",
    "DATEFORMAT",
    "NOW",
    "TODATE",
    "TODATE_TZ",
    "TODAY",
];

const SPECIAL_FUNCTIONS: &[&str] = &[
    "ARRAY_AGG",
    "ARRAY_AGG_NO_NESTING",
    "ARRAY_AGG_UNNESTING",
    "AT",
    "BUTTON",
    "DATE_INTERVAL",
    "ERROR_TO_NAN",
    "ERROR_TO_NULL",
    "FIELD",
    "FIELD_BY_ID",
    "FILTER",
    "IF",
    "INDEX",
    "LINK",
    "LOOKUP",
    "MANY_TO_MANY_AGG",
    "MULTIPLE_SELECT_OPTIONS_AGG",
    "TODURATION",
    "WHEN_EMPTY",
];

const EXACT_ONE_TEXT_FUNCTIONS: &[&str] = &[
    "CAPITALIZE",
    "ENCODE_URI",
    "ENCODE_URI_COMPONENT",
    "LOWER",
    "REVERSE",
    "STRIP",
    "TOVARCHAR",
    "TOURL",
    "TRIM",
    "UPPER",
];

const EXACT_ONE_NUMBER_FUNCTIONS: &[&str] = &[
    "ABS",
    "CEIL",
    "EVEN",
    "EXP",
    "FLOOR",
    "INT",
    "IS_NAN",
    "LN",
    "ODD",
    "SIGN",
    "SQRT",
    "TODURATION",
    "TRUNC",
];

const EXACT_TWO_NUMBER_FUNCTIONS: &[&str] = &[
    "ADD", "DIVIDE", "LOG", "MINUS", "MOD", "MULTIPLY", "POWER", "POW", "ROUND", "WHEN_NAN",
];

const AGGREGATE_FUNCTIONS: &[&str] = &[
    "SUM",
    "AVG",
    "AVERAGE",
    "MIN",
    "MAX",
    "STDDEV_POP",
    "STDDEV_SAMPLE",
    "VARIANCE_POP",
    "VARIANCE_SAMPLE",
];

const ARRAY_AGGREGATE_FUNCTIONS: &[&str] = &[
    "ARRAY_AGG",
    "ARRAY_AGG_NO_NESTING",
    "ARRAY_AGG_UNNESTING",
    "MANY_TO_MANY_AGG",
    "MULTIPLE_SELECT_OPTIONS_AGG",
];

/// The result of a type inference, serialized with the keys the API returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InferredFormulaType {
    /// `"number"`, `"text"`, `"array"`... or `"invalid"` with an `error`.
    pub formula_type: String,
    /// The item type, only for arrays.
    pub array_formula_type: Option<String>,
    pub error: Option<String>,
    pub nullable: bool,
}

impl InferredFormulaType {
    fn new(
        formula_type: &str,
        array_formula_type: Option<&str>,
        error: Option<String>,
        nullable: bool,
    ) -> Self {
        InferredFormulaType {
            formula_type: formula_type.to_owned(),
            array_formula_type: (formula_type == "array").then(|| {
                array_formula_type
                    .filter(|item| !item.is_empty())
                    .unwrap_or("text")
                    .to_owned()
            }),
            error,
            nullable,
        }
    }

    fn of(formula_type: &str) -> Self {
        Self::new(formula_type, None, None, false)
    }

    fn invalid(error: impl Into<String>) -> Self {
        Self::new("invalid", None, Some(error.into()), false)
    }

    /// The settings a formula field stores once its formula is typed.
    pub fn field_settings(&self) -> FieldSettings {
        FieldSettings {
            formula_type: Some(self.formula_type.clone()),
            array_formula_type: self.array_formula_type.clone(),
            nullable: Some(self.nullable),
        }
    }
}

impl Serialize for InferredFormulaType {
    /// `type`, `result_type` and `formula_type` repeat the same type, and
    /// `formula_type_error` repeats `error`, as the TS API does.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("InferredFormulaType", 7)?;
        state.serialize_field("type", &self.formula_type)?;
        state.serialize_field("result_type", &self.formula_type)?;
        state.serialize_field("formula_type", &self.formula_type)?;
        state.serialize_field("array_formula_type", &self.array_formula_type)?;
        state.serialize_field("error", &self.error)?;
        state.serialize_field("formula_type_error", &self.error)?;
        state.serialize_field("nullable", &self.nullable)?;
        state.end()
    }
}

/// The settings of a formula, lookup or rollup field that type inference reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldSettings {
    pub formula_type: Option<String>,
    pub array_formula_type: Option<String>,
    pub nullable: Option<bool>,
}

/// A field a formula reads, by name or by id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldReference {
    Name(String),
    Id(u64),
}

/// A `lookup('Through field', 'Target field')` call found in a formula.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LookupReference {
    pub through_field_name: String,
    pub target_field_name: String,
}

// ── Decimal places ────────────────────────────────────────────────────────────

fn clamp_decimal_places(value: Option<f64>) -> u32 {
    match value {
        Some(value) if value.is_finite() => value
            .trunc()
            .clamp(0.0, f64::from(NUMBER_MAX_DECIMAL_PLACES))
            as u32,
        _ => 0,
    }
}

fn literal_number(node: Option<&Expr>) -> Option<f64> {
    match node? {
        Expr::Unary {
            op: UnaryOp::Neg,
            operand,
        } => literal_number(Some(operand)).map(|value| -value),
        Expr::Literal {
            value: Literal::Number(number),
            ..
        } => Some(*number),
        _ => None,
    }
}

fn literal_string(node: Option<&Expr>) -> Option<&str> {
    match node? {
        Expr::Literal {
            value: Literal::Text(text),
            ..
        } => Some(text),
        _ => None,
    }
}

fn field_decimal_places(lookup: &FieldDecimalPlaces, key: &str) -> u32 {
    clamp_decimal_places(lookup.get(key).map(|places| f64::from(*places)))
}

fn decimal_places_for_node(node: &Expr, lookup: &FieldDecimalPlaces) -> u32 {
    let max_of = |nodes: &[Expr]| {
        let mut places = 0;
        for node in nodes {
            places = places.max(decimal_places_for_node(node, lookup));
        }
        places
    };
    match node {
        Expr::Literal {
            value: Literal::Number(_),
            raw,
        } => raw.find('.').map_or(0, |decimal| {
            (raw.len() - decimal - 1).min(NUMBER_MAX_DECIMAL_PLACES as usize) as u32
        }),
        Expr::Literal { .. } => 0,
        Expr::Field(name) => field_decimal_places(lookup, &js::to_lower(name)),
        Expr::Unary { operand, .. } => decimal_places_for_node(operand, lookup),
        Expr::Binary { .. } => {
            // Arithmetic takes the most decimals of its operands. The left
            // spine of a long chain is walked in a loop, not recursively.
            let mut places = 0;
            let mut node = node;
            loop {
                match node {
                    Expr::Binary {
                        op: BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Mod,
                        left,
                        right,
                    } => {
                        places = places.max(decimal_places_for_node(right, lookup));
                        node = left;
                    }
                    Expr::Binary {
                        op: BinaryOp::Div, ..
                    } => return NUMBER_MAX_DECIMAL_PLACES.max(places),
                    Expr::Binary { .. } => return places,
                    leaf => return places.max(decimal_places_for_node(leaf, lookup)),
                }
            }
        }
        Expr::Call { name, args } => match name.as_str() {
            "FIELD" => literal_string(args.first())
                .map_or(0, |name| field_decimal_places(lookup, &js::to_lower(name))),
            "FIELD_BY_ID" => literal_number(args.first()).map_or(0, |id| {
                field_decimal_places(
                    lookup,
                    &format!("field_{}", js::number_to_string(id.trunc())),
                )
            }),
            "ROUND" => literal_number(args.get(1)).map_or(NUMBER_MAX_DECIMAL_PLACES, |places| {
                clamp_decimal_places(Some(places))
            }),
            "TONUMBER" | "DIVIDE" => NUMBER_MAX_DECIMAL_PLACES,
            name if ZERO_DECIMAL_FUNCTIONS.contains(&name) => 0,
            "IF" => max_of(args.get(1..).unwrap_or_default()),
            name if FIRST_ARGUMENT_DECIMAL_FUNCTIONS.contains(&name) => args
                .first()
                .map_or(0, |arg| decimal_places_for_node(arg, lookup)),
            _ => max_of(args),
        },
    }
}

/// The number of decimal places a number formula's results get, from its
/// literals, the fields it reads and its functions (division gives 10).
pub fn infer_number_decimal_places(
    formula: &str,
    field_decimal_places: &FieldDecimalPlaces,
) -> Result<u32, Error> {
    Ok(
        decimal_places_for_node(&parse(formula)?, field_decimal_places)
            .min(NUMBER_MAX_DECIMAL_PLACES),
    )
}

// ── Static types ──────────────────────────────────────────────────────────────

/// A type during static inference. Type names are static strings or borrowed
/// from the field types, so inference allocates nothing.
#[derive(Clone, Copy, Debug)]
struct StaticType<'a> {
    kind: &'a str,
    array_type: Option<&'a str>,
    date_has_time: Option<bool>,
}

fn static_type(kind: &str) -> StaticType<'_> {
    StaticType {
        kind,
        array_type: None,
        date_has_time: None,
    }
}

fn static_array(item: &str) -> StaticType<'_> {
    StaticType {
        kind: "array",
        array_type: Some(item),
        date_has_time: None,
    }
}

fn static_date(has_time: Option<bool>) -> StaticType<'static> {
    StaticType {
        kind: "date",
        array_type: None,
        date_has_time: has_time,
    }
}

fn type_error(message: impl Into<String>) -> Error {
    Error::Type(message.into())
}

fn expect_arity(name: &str, args: &[Expr], min: usize, max: usize) -> Result<(), Error> {
    if args.len() < min || args.len() > max {
        Err(arity_error(name, min, max))
    } else {
        Ok(())
    }
}

#[cold]
#[inline(never)]
fn arity_error(name: &str, min: usize, max: usize) -> Error {
    let expected = if min == max {
        format!("exactly {min}")
    } else {
        format!("{min} to {max}")
    };
    let plural = if max == 1 { "" } else { "s" };
    type_error(format!(
        "{} must receive {expected} argument{plural}.",
        js::to_lower(name)
    ))
}

fn is_text_type(kind: &StaticType<'_>) -> bool {
    matches!(kind.kind, "text" | "url")
}

fn is_number_type(kind: &StaticType<'_>) -> bool {
    kind.kind == "number"
}

fn is_date_type(kind: &str) -> bool {
    kind == "date"
}

fn is_duration_type(kind: &str) -> bool {
    matches!(kind, "duration" | "date_interval")
}

fn is_array_type(kind: &StaticType<'_>) -> bool {
    matches!(
        kind.kind,
        "array" | "file" | "multiple_select" | "multiple_collaborators"
    )
}

fn require_type(
    name: &str,
    actual: &StaticType<'_>,
    allowed: &str,
    valid: bool,
) -> Result<(), Error> {
    if valid {
        Ok(())
    } else {
        Err(type_mismatch(name, actual, allowed))
    }
}

#[cold]
#[inline(never)]
fn type_mismatch(name: &str, actual: &StaticType<'_>, allowed: &str) -> Error {
    type_error(format!(
        "{} received {}, but requires {allowed}.",
        js::to_lower(name),
        actual.kind
    ))
}

#[cold]
#[inline(never)]
fn unknown_field(name: &str, quoted: bool, invalid: bool) -> Error {
    let name = if quoted {
        format!("\"{name}\"")
    } else {
        name.to_owned()
    };
    if invalid {
        type_error(format!("The field {name} has an invalid formula type."))
    } else {
        type_error(format!("The field {name} does not exist."))
    }
}

/// `String(literal.value)`, used to key field lookups.
fn literal_key(value: &Literal) -> String {
    match value {
        Literal::Null => "null".to_owned(),
        Literal::Bool(value) => value.to_string(),
        Literal::Number(number) => js::number_to_string(*number),
        Literal::Text(text) => text.clone(),
    }
}

fn field_call_key(name: &str, literal: &Literal) -> String {
    if name == "FIELD_BY_ID" {
        format!("field_{}", literal_key(literal))
    } else {
        js::to_lower(&literal_key(literal))
    }
}

#[inline(never)]
fn infer_unary(op: UnaryOp, operand: StaticType<'_>) -> Result<StaticType<'_>, Error> {
    match op {
        UnaryOp::Not => {
            require_type("not", &operand, "boolean", operand.kind == "boolean")?;
            Ok(static_type("boolean"))
        }
        UnaryOp::Neg => {
            let valid = is_number_type(&operand) || is_duration_type(operand.kind);
            require_type("minus", &operand, "number or duration", valid)?;
            Ok(operand)
        }
    }
}

#[inline(never)]
fn infer_binary<'a>(
    op: BinaryOp,
    left: StaticType<'a>,
    right: StaticType<'a>,
) -> Result<StaticType<'a>, Error> {
    let (l, r) = (left.kind, right.kind);
    let incompatible = || {
        type_error(format!(
            "Operator {} is not compatible with {l} and {r}.",
            op.as_str()
        ))
    };
    let both_numbers = is_number_type(&left) && is_number_type(&right);
    match op {
        BinaryOp::And | BinaryOp::Or => {
            require_type(op.as_str(), &left, "boolean", l == "boolean")?;
            require_type(op.as_str(), &right, "boolean", r == "boolean")?;
            Ok(static_type("boolean"))
        }
        BinaryOp::Eq | BinaryOp::NotEq => Ok(static_type("boolean")),
        BinaryOp::Lt | BinaryOp::LtEq | BinaryOp::Gt | BinaryOp::GtEq => {
            let compatible = l == r
                && (is_number_type(&left)
                    || is_text_type(&left)
                    || is_date_type(l)
                    || is_duration_type(l));
            require_type(op.as_str(), &right, l, compatible)?;
            Ok(static_type("boolean"))
        }
        BinaryOp::Add if both_numbers => Ok(static_type("number")),
        BinaryOp::Add if is_text_type(&left) && is_text_type(&right) => Ok(static_type("text")),
        BinaryOp::Add | BinaryOp::Sub if is_date_type(l) && is_duration_type(r) => {
            Ok(static_date(left.date_has_time))
        }
        BinaryOp::Add if is_date_type(r) && is_duration_type(l) => {
            Ok(static_date(right.date_has_time))
        }
        BinaryOp::Add | BinaryOp::Sub if is_duration_type(l) && is_duration_type(r) => {
            Ok(static_type("duration"))
        }
        BinaryOp::Sub if both_numbers => Ok(static_type("number")),
        BinaryOp::Sub if is_date_type(l) && is_date_type(r) => Ok(static_type("duration")),
        BinaryOp::Mul if both_numbers => Ok(static_type("number")),
        BinaryOp::Mul
            if (is_duration_type(l) && is_number_type(&right))
                || (is_number_type(&left) && is_duration_type(r)) =>
        {
            Ok(static_type("duration"))
        }
        BinaryOp::Div if both_numbers => Ok(static_type("number")),
        BinaryOp::Div if is_duration_type(l) && is_number_type(&right) => {
            Ok(static_type("duration"))
        }
        BinaryOp::Mod if both_numbers => Ok(static_type("number")),
        BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => {
            Err(incompatible())
        }
    }
}

struct StaticContext<'a> {
    field_types: &'a FieldTypes,
    lookup_array_type: Option<&'a str>,
}

impl<'a> StaticContext<'a> {
    fn field_type(&self, key: &str) -> Option<&'a str> {
        self.field_types
            .get(key)
            .map(String::as_str)
            .filter(|kind| !kind.is_empty())
    }

    fn lookup_item_type(&self) -> &'a str {
        self.lookup_array_type
            .filter(|kind| !kind.is_empty())
            .unwrap_or("text")
    }

    #[inline(never)]
    fn field_reference(&self, name: &str) -> Result<StaticType<'a>, Error> {
        match self.field_type(&js::to_lower(name)) {
            None => Err(unknown_field(name, true, false)),
            Some("invalid") => Err(unknown_field(name, true, true)),
            Some(kind) => Ok(static_type(kind)),
        }
    }

    /// `inferStaticNode`. Like the evaluator, only the recursive cases stay in
    /// this frame, and binary spines are walked in a loop.
    fn infer(&self, node: &Expr) -> Result<StaticType<'a>, Error> {
        match node {
            Expr::Literal { value, .. } => Ok(static_type(match value {
                Literal::Null => "null",
                Literal::Number(_) => "number",
                Literal::Bool(_) => "boolean",
                Literal::Text(_) => "text",
            })),
            Expr::Field(name) => self.field_reference(name),
            Expr::Unary { op, operand } => infer_unary(*op, self.infer(operand)?),
            Expr::Binary { .. } => self.infer_binary_spine(node),
            Expr::Call { name, args } => self.infer_call(name, args),
        }
    }

    #[inline(never)]
    fn infer_binary_spine(&self, node: &Expr) -> Result<StaticType<'a>, Error> {
        let mut spine = Vec::new();
        let mut node = node;
        while let Expr::Binary { op, left, right } = node {
            spine.push((*op, &**right));
            node = left;
        }
        let mut kind = self.infer(node)?;
        for (op, right) in spine.into_iter().rev() {
            kind = infer_binary(op, kind, self.infer(right)?)?;
        }
        Ok(kind)
    }

    /// Infers the arguments, then checks the call. The checks live in
    /// [`Self::check_call`], out of line, so that this recursive frame stays small.
    #[inline(never)]
    fn infer_call(&self, name: &str, nodes: &[Expr]) -> Result<StaticType<'a>, Error> {
        if let Some(result) = self.special_call(name, nodes) {
            return result;
        }
        if name == "ERROR_TO_NULL" {
            return self.infer(&nodes[0]);
        }
        let mut args = Vec::with_capacity(nodes.len());
        for node in nodes {
            args.push(self.infer(node)?);
        }
        self.check_call(name, nodes, &args)
    }

    /// `error_to_nan`, `error_to_null` (arity only) and `field`/`field_by_id`,
    /// which the TS code handles before inferring arguments.
    #[inline(never)]
    fn special_call(&self, name: &str, nodes: &[Expr]) -> Option<Result<StaticType<'a>, Error>> {
        if name == "ERROR_TO_NAN" {
            return Some(expect_arity(name, nodes, 1, 1).map(|()| static_type("number")));
        }
        if name == "ERROR_TO_NULL" {
            return expect_arity(name, nodes, 1, 1).err().map(Err);
        }
        if name == "FIELD" || name == "FIELD_BY_ID" {
            return Some(self.field_call(name, nodes));
        }
        None
    }

    fn field_call(&self, name: &str, nodes: &[Expr]) -> Result<StaticType<'a>, Error> {
        expect_arity(name, nodes, 1, 1)?;
        let Expr::Literal { value, .. } = &nodes[0] else {
            return Err(type_error(format!(
                "{} requires a literal field identifier.",
                js::to_lower(name)
            )));
        };
        match self.field_type(&field_call_key(name, value)) {
            None => Err(unknown_field(&literal_key(value), false, false)),
            Some("invalid") => Err(unknown_field(&literal_key(value), false, true)),
            Some(kind) => Ok(static_type(kind)),
        }
    }

    #[inline(never)]
    fn check_call(
        &self,
        name: &str,
        nodes: &[Expr],
        args: &[StaticType<'a>],
    ) -> Result<StaticType<'a>, Error> {
        let name_is = |names: &[&str]| names.contains(&name);
        let all_text = |args: &[StaticType<'_>]| {
            args.iter()
                .try_for_each(|arg| require_type(name, arg, "text", is_text_type(arg)))
        };
        if name_is(&["CONCAT", "CONCATENATE"]) {
            if args.len() < 2 {
                return Err(type_error("concat must receive more than one argument."));
            }
            return Ok(static_type("text"));
        }
        if name == "IF" {
            expect_arity(name, nodes, 3, 3)?;
            require_type(name, &args[0], "boolean", args[0].kind == "boolean")?;
            return Ok(if args[1].kind == args[2].kind {
                args[1]
            } else {
                static_type("text")
            });
        }
        if name == "WHEN_EMPTY" {
            expect_arity(name, nodes, 2, 2)?;
            if args[0].kind != args[1].kind {
                return Err(type_error(
                    "both inputs for when_empty must be the same type",
                ));
            }
            return Ok(args[0]);
        }
        if name_is(EXACT_ONE_TEXT_FUNCTIONS) {
            expect_arity(name, nodes, 1, 1)?;
            require_type(name, &args[0], "text", is_text_type(&args[0]))?;
            return Ok(static_type(if name == "TOURL" { "url" } else { "text" }));
        }
        if name_is(&["REGEX_REPLACE", "REGEXREPLACE"]) {
            expect_arity(name, nodes, 3, 3)?;
            all_text(args)?;
            return Ok(static_type("text"));
        }
        if name == "LINK" {
            expect_arity(name, nodes, 1, 2)?;
            all_text(args)?;
            return Ok(static_type("link"));
        }
        if name == "BUTTON" {
            expect_arity(name, nodes, 2, 2)?;
            all_text(args)?;
            return Ok(static_type("button"));
        }
        if name_is(&["GET_LINK_LABEL", "GET_LINK_URL"]) {
            expect_arity(name, nodes, 1, 1)?;
            require_type(
                name,
                &args[0],
                "link",
                matches!(args[0].kind, "link" | "button"),
            )?;
            return Ok(static_type("text"));
        }
        if name_is(&["TODATE", "TODATE_TZ"]) {
            let arity = if name == "TODATE" { 2 } else { 3 };
            expect_arity(name, nodes, arity, arity)?;
            all_text(args)?;
            return Ok(static_date(Some(name == "TODATE_TZ")));
        }
        if name == "NOW" {
            expect_arity(name, nodes, 0, 0)?;
            return Ok(static_date(Some(true)));
        }
        if name == "TODAY" {
            expect_arity(name, nodes, 0, 0)?;
            return Ok(static_date(Some(false)));
        }
        if name == "SECOND" {
            expect_arity(name, nodes, 1, 1)?;
            let valid = args[0].kind == "date" && args[0].date_has_time != Some(false);
            require_type(name, &args[0], "date with time", valid)?;
            return Ok(static_type("number"));
        }
        if name == "DATE_INTERVAL" {
            expect_arity(name, nodes, 1, 1)?;
            require_type(name, &args[0], "text", is_text_type(&args[0]))?;
            return Ok(static_type("date_interval"));
        }
        if name_is(EXACT_ONE_NUMBER_FUNCTIONS) {
            expect_arity(name, nodes, 1, 1)?;
            require_type(name, &args[0], "number", is_number_type(&args[0]))?;
            return Ok(static_type(if name == "TODURATION" {
                "duration"
            } else {
                "number"
            }));
        }
        if name_is(EXACT_TWO_NUMBER_FUNCTIONS) {
            expect_arity(name, nodes, 2, 2)?;
            args.iter()
                .try_for_each(|arg| require_type(name, arg, "number", is_number_type(arg)))?;
            return Ok(static_type("number"));
        }
        if name_is(AGGREGATE_FUNCTIONS) {
            expect_arity(name, nodes, 1, 1)?;
            require_type(name, &args[0], "an array", is_array_type(&args[0]))?;
            return Ok(static_type("number"));
        }
        if name_is(&["LOOKUP", "FILTER"]) {
            return Ok(static_array(self.lookup_item_type()));
        }
        if name_is(ARRAY_AGGREGATE_FUNCTIONS) {
            expect_arity(name, nodes, 1, 1)?;
            let item = if args[0].kind == "array" {
                args[0]
                    .array_type
                    .filter(|item| !item.is_empty())
                    .unwrap_or("text")
            } else {
                args[0].kind
            };
            return Ok(static_array(item));
        }

        if name_is(NUMBER_FUNCTIONS) {
            Ok(static_type("number"))
        } else if name_is(BOOLEAN_FUNCTIONS) {
            Ok(static_type("boolean"))
        } else if name_is(TEXT_FUNCTIONS) {
            Ok(static_type("text"))
        } else if name_is(DATE_FUNCTIONS) {
            Ok(static_type("date"))
        } else if name_is(SPECIAL_FUNCTIONS) {
            Ok(static_type("text"))
        } else {
            Err(type_error(format!("Unknown function: {name}")))
        }
    }

    /// `inferStaticNullable`. Only called on a tree [`Self::infer`] accepted.
    fn nullable(&self, node: &Expr, field_nullables: &FieldNullables) -> Result<bool, Error> {
        let is_temporal =
            |kind: StaticType<'_>| is_date_type(kind.kind) || is_duration_type(kind.kind);
        match node {
            Expr::Literal { value, .. } => Ok(matches!(value, Literal::Null)),
            Expr::Field(name) => Ok(field_nullables
                .get(&js::to_lower(name))
                .copied()
                .unwrap_or(true)),
            Expr::Unary { .. } => Ok(is_temporal(self.infer(node)?)),
            Expr::Binary { op, .. } => match op {
                BinaryOp::And
                | BinaryOp::Or
                | BinaryOp::Eq
                | BinaryOp::NotEq
                | BinaryOp::Lt
                | BinaryOp::LtEq
                | BinaryOp::Gt
                | BinaryOp::GtEq => Ok(false),
                _ => Ok(is_temporal(self.infer(node)?)),
            },
            Expr::Call { name, args } => self.call_nullable(node, name, args, field_nullables),
        }
    }

    #[inline(never)]
    fn call_nullable(
        &self,
        node: &Expr,
        name: &str,
        args: &[Expr],
        field_nullables: &FieldNullables,
    ) -> Result<bool, Error> {
        if name == "FIELD" || name == "FIELD_BY_ID" {
            return Ok(match args.first() {
                Some(Expr::Literal { value, .. }) => field_nullables
                    .get(&field_call_key(name, value))
                    .copied()
                    .unwrap_or(true),
                _ => true,
            });
        }
        if name == "IF" && args.len() == 3 {
            return Ok(self.nullable(&args[1], field_nullables)?
                || self.nullable(&args[2], field_nullables)?);
        }
        if name == "WHEN_EMPTY" && args.len() == 2 {
            return Ok(self.nullable(&args[0], field_nullables)?
                && self.nullable(&args[1], field_nullables)?);
        }
        match name {
            "ERROR_TO_NULL" => return Ok(true),
            "ERROR_TO_NAN" => return Ok(false),
            "ISBLANK" | "ISNULL" | "IS_NULL" | "IS_NAN" | "TOTEXT" | "TOVARCHAR" | "TONUMBER" => {
                return Ok(false);
            }
            "TODATE" | "TODATE_TZ" | "DATE_INTERVAL" | "TODURATION" | "BC_TO_NULL" | "DATEADD"
            | "DATEFORMAT" | "DAY" | "MONTH" | "YEAR" | "HOUR" | "MINUTE" | "SECOND"
            | "WEEKDAY" => return Ok(true),
            _ => {}
        }
        let result = self.infer(node)?;
        Ok(is_date_type(result.kind) || is_duration_type(result.kind) || result.kind == "array")
    }
}

/// Whether a formula can produce null, with the fields' own nullability.
/// Fails like [`validate_formula_type`] on an ill-typed formula.
pub fn infer_formula_nullable(
    formula: &str,
    field_types: &FieldTypes,
    field_nullables: &FieldNullables,
    lookup_array_formula_type: Option<&str>,
) -> Result<bool, Error> {
    let ast = parse(formula)?;
    let context = StaticContext {
        field_types,
        lookup_array_type: lookup_array_formula_type,
    };
    context.infer(&ast)?;
    context.nullable(&ast, field_nullables)
}

/// Type-checks a formula against the types of the table's fields.
///
/// The result is `"invalid"` with an error message for formulas that do not
/// parse, read unknown fields, or mix incompatible types.
pub fn validate_formula_type(
    formula: &str,
    field_types: &FieldTypes,
    lookup_array_formula_type: Option<&str>,
    field_nullables: &FieldNullables,
) -> InferredFormulaType {
    let context = StaticContext {
        field_types,
        lookup_array_type: lookup_array_formula_type,
    };
    let inferred = parse(formula).and_then(|ast| {
        let kind = context.infer(&ast)?;
        let nullable = context.nullable(&ast, field_nullables)?;
        Ok((kind, nullable))
    });
    match inferred {
        Ok((kind, nullable)) => {
            InferredFormulaType::new(kind.kind, kind.array_type, None, nullable)
        }
        Err(error) => InferredFormulaType::invalid(error.to_string()),
    }
}

/// The fields a formula reads, in order of first appearance and without
/// duplicates (names compare case-insensitively).
pub fn extract_field_references(formula: &str) -> Result<Vec<FieldReference>, Error> {
    fn visit(node: &Expr, references: &mut IndexMap<String, FieldReference>) {
        match node {
            Expr::Literal { .. } => {}
            Expr::Field(name) => {
                let name = js::trim(name);
                references.insert(
                    format!("name:{}", js::to_lower(name)),
                    FieldReference::Name(name.to_owned()),
                );
            }
            Expr::Unary { operand, .. } => visit(operand, references),
            Expr::Binary { .. } => {
                // Left subtree first, as the TS visitor; the spine in a loop.
                let mut spine = Vec::new();
                let mut node = node;
                while let Expr::Binary { left, right, .. } = node {
                    spine.push(&**right);
                    node = left;
                }
                visit(node, references);
                for right in spine.into_iter().rev() {
                    visit(right, references);
                }
            }
            Expr::Call { name, args } => {
                if let Some(Expr::Literal { value, .. }) = args.first() {
                    if name == "FIELD_BY_ID" {
                        let id = match value {
                            Literal::Null => 0.0,
                            Literal::Bool(value) => f64::from(u8::from(*value)),
                            Literal::Number(number) => *number,
                            Literal::Text(text) => js::string_to_number(text),
                        };
                        if id.is_finite() && id.fract() == 0.0 && id > 0.0 {
                            references.insert(
                                format!("id:{}", js::number_to_string(id)),
                                FieldReference::Id(id as u64),
                            );
                        }
                    } else if name == "FIELD" {
                        let key = literal_key(value);
                        let name = js::trim(&key);
                        references.insert(
                            format!("name:{}", js::to_lower(name)),
                            FieldReference::Name(name.to_owned()),
                        );
                    }
                }
                for arg in args {
                    visit(arg, references);
                }
            }
        }
    }
    let mut references = IndexMap::new();
    visit(&parse(formula)?, &mut references);
    Ok(references.into_values().collect())
}

// ── Value-based inference (the formula type endpoint) ─────────────────────────

static ROOT_FUNCTION: Pattern = Pattern::new(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(", "");
static FIRST_STRING_ARGUMENT: Pattern = Pattern::new(r#"\(\s*(["'])(.*?)\1"#, "");
static FIRST_NUMERIC_ARGUMENT: Pattern = Pattern::new(r"\(\s*(\d+)", "");
static DIRECT_FIELD_REFERENCE: Pattern = Pattern::new(r"^\{\s*(.*?)\s*\}$", "");
static LOOKUP_CALL: Pattern = Pattern::new(
    r#"\blookup\s*\(\s*(["'])(.*?)\1\s*,\s*(["'])(.*?)\3\s*\)"#,
    "i",
);

fn capture<'t>(pattern: &Pattern, text: &'t str, group: usize) -> &'t str {
    pattern
        .captures(text)
        .and_then(|groups| groups.get(group).copied().flatten())
        .unwrap_or("")
}

fn root_function_name(formula: &str) -> String {
    js::to_upper(capture(&ROOT_FUNCTION, js::trim(formula), 1))
}

/// `functionArgumentExpressions`: the top-level arguments of the first call,
/// split on commas outside quotes and parentheses.
fn function_argument_expressions(formula: &str) -> Vec<&str> {
    let Some(open) = formula.find('(') else {
        return Vec::new();
    };
    let mut args = Vec::new();
    let mut start = open + 1;
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut chars = formula[open + 1..]
        .char_indices()
        .map(|(index, c)| (index + open + 1, c));
    while let Some((index, c)) = chars.next() {
        if let Some(open_quote) = quote {
            if c == '\\' {
                chars.next();
            } else if c == open_quote {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' => depth += 1,
            ')' if depth == 0 => {
                let value = js::trim(&formula[start..index]);
                if !value.is_empty() {
                    args.push(value);
                }
                return args;
            }
            ')' => depth -= 1,
            ',' if depth == 0 => {
                args.push(js::trim(&formula[start..index]));
                start = index + 1;
            }
            _ => {}
        }
    }
    args
}

fn same_formula_type(left: &InferredFormulaType, right: &InferredFormulaType) -> bool {
    left.formula_type == right.formula_type && left.array_formula_type == right.array_formula_type
}

fn infer_array_formula_type(items: &[Value], fallback: Option<&str>) -> String {
    let fallback = fallback.filter(|kind| !kind.is_empty()).unwrap_or("text");
    match items.iter().find(|item| !item.is_null()) {
        Some(item) if is_link_value(item) => "link".to_owned(),
        Some(Value::Number(_)) => "number".to_owned(),
        Some(Value::Bool(_)) => "boolean".to_owned(),
        _ => fallback.to_owned(),
    }
}

fn is_link_value(value: &Value) -> bool {
    match value {
        Value::Object(object) => matches!(object.get("url"), Some(Value::Text(_))),
        _ => false,
    }
}

/// The type the formula builder shows for a formula, from its root function
/// and its evaluated `value` (or `error`).
///
/// This mirrors the `/formula/<table>/type/` endpoint: unlike
/// [`validate_formula_type`] it does not type-check arguments. Sub-expressions
/// of `if` and `when_empty` are evaluated against an empty row with `env`.
pub fn infer_formula_type(
    formula: &str,
    value: &Value,
    error: Option<&str>,
    field_types: &FieldTypes,
    lookup_array_formula_type: Option<&str>,
    env: &mut dyn Environment,
) -> InferredFormulaType {
    if let Some(error) = error.filter(|error| !error.is_empty()) {
        return InferredFormulaType::invalid(error);
    }
    let field_type = |key: &str| {
        field_types
            .get(key)
            .map(String::as_str)
            .filter(|kind| !kind.is_empty())
    };
    let argument_type = |formula: &str, env: &mut dyn Environment| {
        let result = evaluate_formula(formula, &Object::new(), env);
        infer_formula_type(
            formula,
            &result.value,
            result.error.as_deref(),
            field_types,
            lookup_array_formula_type,
            env,
        )
    };

    let root = root_function_name(formula);
    match root.as_str() {
        "BUTTON" => return InferredFormulaType::of("button"),
        "LINK" => return InferredFormulaType::of("link"),
        "TOURL" => return InferredFormulaType::of("url"),
        "TODURATION" => return InferredFormulaType::of("duration"),
        "DATE_INTERVAL" => return InferredFormulaType::of("date_interval"),
        "ERROR_TO_NULL" => {
            if let Some(inner) = function_argument_expressions(formula)
                .first()
                .filter(|inner| !inner.is_empty())
            {
                return infer_formula_type(
                    inner,
                    value,
                    None,
                    field_types,
                    lookup_array_formula_type,
                    env,
                );
            }
        }
        "IF" => {
            let args = function_argument_expressions(formula);
            if args.len() >= 3 {
                let then_type = argument_type(args[1], env);
                let else_type = argument_type(args[2], env);
                if then_type.error.is_some() {
                    return then_type;
                }
                if else_type.error.is_some() {
                    return else_type;
                }
                if same_formula_type(&then_type, &else_type) {
                    return InferredFormulaType::new(
                        &then_type.formula_type,
                        then_type.array_formula_type.as_deref(),
                        None,
                        false,
                    );
                }
                return InferredFormulaType::of("text");
            }
        }
        "WHEN_EMPTY" => {
            let args = function_argument_expressions(formula);
            if args.len() >= 2 {
                let first_type = argument_type(args[0], env);
                let fallback_type = argument_type(args[1], env);
                if first_type.error.is_some() {
                    return first_type;
                }
                if fallback_type.error.is_some() {
                    return fallback_type;
                }
                if !same_formula_type(&first_type, &fallback_type) {
                    return InferredFormulaType::invalid(
                        "both inputs for when_empty must be the same type",
                    );
                }
                return InferredFormulaType::new(
                    &first_type.formula_type,
                    first_type.array_formula_type.as_deref(),
                    None,
                    false,
                );
            }
        }
        "ARRAY_AGG"
        | "ARRAY_AGG_NO_NESTING"
        | "MANY_TO_MANY_AGG"
        | "MULTIPLE_SELECT_OPTIONS_AGG"
        | "ARRAY_AGG_UNNESTING" => {
            let first = function_argument_expressions(formula)
                .first()
                .copied()
                .unwrap_or_default();
            let arg_type = argument_type(first, env);
            if arg_type.error.is_some() {
                return arg_type;
            }
            let item = if arg_type.formula_type == "array" {
                arg_type.array_formula_type.as_deref()
            } else {
                Some(arg_type.formula_type.as_str())
            };
            return InferredFormulaType::new("array", item, None, false);
        }
        "LOOKUP" | "FILTER" => {
            return InferredFormulaType::new("array", lookup_array_formula_type, None, false);
        }
        _ => {}
    }

    if root == "FIELD"
        && let Some(kind) = field_type(&js::to_lower(capture(&FIRST_STRING_ARGUMENT, formula, 2)))
    {
        return InferredFormulaType::of(kind);
    }
    if root == "FIELD_BY_ID"
        && let Some(kind) = field_type(&format!(
            "field_{}",
            capture(&FIRST_NUMERIC_ARGUMENT, formula, 1)
        ))
    {
        return InferredFormulaType::of(kind);
    }
    let direct = capture(&DIRECT_FIELD_REFERENCE, js::trim(formula), 1);
    if !direct.is_empty()
        && let Some(kind) = field_type(&js::to_lower(direct))
    {
        return InferredFormulaType::of(kind);
    }
    let root = root.as_str();
    if NUMBER_FUNCTIONS.contains(&root) {
        return InferredFormulaType::of("number");
    }
    if BOOLEAN_FUNCTIONS.contains(&root) {
        return InferredFormulaType::of("boolean");
    }
    if TEXT_FUNCTIONS.contains(&root) {
        return InferredFormulaType::of("text");
    }
    if DATE_FUNCTIONS.contains(&root) {
        return InferredFormulaType::of("date");
    }
    match value {
        Value::Array(items) => InferredFormulaType::new(
            "array",
            Some(&infer_array_formula_type(items, lookup_array_formula_type)),
            None,
            false,
        ),
        value if is_link_value(value) => InferredFormulaType::of("link"),
        Value::Number(_) => InferredFormulaType::of("number"),
        Value::Bool(_) => InferredFormulaType::of("boolean"),
        _ => InferredFormulaType::of("text"),
    }
}

/// The formula type a field of `field_type` has when a formula reads it.
pub fn map_field_type_to_formula_type(field_type: &str, settings: &FieldSettings) -> String {
    let non_empty = |value: &Option<String>| value.clone().filter(|value| !value.is_empty());
    match field_type {
        "formula" | "lookup" | "rollup" => non_empty(&settings.array_formula_type)
            .or_else(|| non_empty(&settings.formula_type))
            .unwrap_or_else(|| "text".to_owned()),
        "number" | "rating" | "count" | "autonumber" => "number".to_owned(),
        "date" | "created_on" | "last_modified" => "date".to_owned(),
        "boolean"
        | "duration"
        | "url"
        | "file"
        | "single_select"
        | "multiple_select"
        | "multiple_collaborators" => field_type.to_owned(),
        _ => "text".to_owned(),
    }
}

/// Whether a field of `field_type` can be null when a formula reads it.
pub fn map_field_type_to_formula_nullable(field_type: &str, settings: &FieldSettings) -> bool {
    match field_type {
        "count" | "autonumber" | "auto_number" | "uuid" | "created_on" | "last_modified" => false,
        "formula" | "lookup" | "rollup" => settings.nullable != Some(false),
        _ => true,
    }
}

/// The `lookup('Through', 'Target')` calls written in a formula, found by
/// pattern (like the TS code) so that it also works on formulas that do not
/// parse. Duplicates, compared case-insensitively, are dropped.
pub fn extract_lookup_references(formula: &str) -> Vec<LookupReference> {
    let mut references: IndexMap<String, LookupReference> = IndexMap::new();
    for groups in LOOKUP_CALL.captures_iter(formula) {
        let through = groups.get(2).copied().flatten().unwrap_or_default();
        let target = groups.get(4).copied().flatten().unwrap_or_default();
        references.insert(
            format!("{}:{}", js::to_lower(through), js::to_lower(target)),
            LookupReference {
                through_field_name: through.to_owned(),
                target_field_name: target.to_owned(),
            },
        );
    }
    references.into_values().collect()
}
