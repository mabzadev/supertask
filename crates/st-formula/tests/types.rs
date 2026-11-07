//! Port of `tests/formula-types.test.ts`.

use serde_json::json;
use st_formula::{
    FieldDecimalPlaces, FieldNullables, FieldReference, FieldSettings, FieldTypes,
    FixedEnvironment, InferredFormulaType, LookupReference, Value, extract_field_references,
    extract_lookup_references, infer_formula_type, infer_number_decimal_places,
    map_field_type_to_formula_type, validate_formula_type,
};

fn types(entries: &[(&str, &str)]) -> FieldTypes {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

fn decimal_places(formula: &str, entries: &[(&str, u32)]) -> u32 {
    let lookup: FieldDecimalPlaces = entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), *value))
        .collect();
    infer_number_decimal_places(formula, &lookup).expect("parses")
}

/// `inferFormulaType(formula, value, error, fieldTypes, lookupArrayFormulaType)`.
fn infer(
    formula: &str,
    value: serde_json::Value,
    error: Option<&str>,
    field_types: &[(&str, &str)],
    lookup: Option<&str>,
) -> InferredFormulaType {
    infer_formula_type(
        formula,
        &Value::from(value),
        error,
        &types(field_types),
        lookup,
        &mut FixedEnvironment::default(),
    )
}

#[track_caller]
fn assert_type(
    inferred: &InferredFormulaType,
    formula_type: &str,
    array_formula_type: Option<&str>,
) {
    assert_eq!(inferred.formula_type, formula_type, "{inferred:?}");
    assert_eq!(
        inferred.array_formula_type.as_deref(),
        array_formula_type,
        "{inferred:?}"
    );
}

#[test]
fn infers_number_decimal_places_from_literals_fields_and_functions() {
    assert_eq!(decimal_places("ln(9.0)", &[]), 1);
    assert_eq!(decimal_places("sqrt(2.00)", &[]), 2);
    assert_eq!(decimal_places("log(125.000, 5)", &[]), 3);
    assert_eq!(decimal_places("10 / 3", &[]), 10);
    assert_eq!(decimal_places("round(1.12345, 4)", &[]), 4);
    assert_eq!(decimal_places("round(1234.5678, -2.999)", &[]), 0);
    assert_eq!(decimal_places("field('Amount') + 1", &[("amount", 4)]), 4);
    assert_eq!(decimal_places("field_by_id(8) * 2.0", &[("field_8", 3)]), 3);
}

#[test]
fn returns_registered_types_for_links_buttons_urls_and_durations() {
    assert_type(
        &infer(
            "link('https://example.com')",
            json!({ "url": "https://example.com", "label": null }),
            None,
            &[],
            None,
        ),
        "link",
        None,
    );
    assert_type(
        &infer(
            "button('https://example.com', 'Open')",
            json!({ "url": "https://example.com", "label": "Open" }),
            None,
            &[],
            None,
        ),
        "button",
        None,
    );
    assert_type(
        &infer(
            "tourl('example.com')",
            json!("example.com"),
            None,
            &[],
            None,
        ),
        "url",
        None,
    );
    assert_type(
        &infer("toduration(60)", json!(60), None, &[], None),
        "duration",
        None,
    );
}

#[test]
fn returns_array_subtypes_for_lookup_and_filter_formulas() {
    assert_type(
        &infer(
            "lookup('Customer', 'Score')",
            json!([]),
            None,
            &[],
            Some("number"),
        ),
        "array",
        Some("number"),
    );
    assert_type(
        &infer(
            "filter(lookup('Customer', 'Name'), lookup('Customer', 'Active'))",
            json!([]),
            None,
            &[],
            Some("text"),
        ),
        "array",
        Some("text"),
    );
}

#[test]
fn returns_compatible_types_for_file_helpers() {
    let files = [("files", "file")];
    assert_type(
        &infer(
            "get_file_visible_name(index(field('Files'), 0))",
            json!("Image.png"),
            None,
            &files,
            None,
        ),
        "text",
        None,
    );
    assert_type(
        &infer(
            "get_file_mime_type(index(field('Files'), 0))",
            json!("image/png"),
            None,
            &files,
            None,
        ),
        "text",
        None,
    );
    assert_type(
        &infer(
            "get_file_count(field('Files'))",
            json!(2),
            None,
            &files,
            None,
        ),
        "number",
        None,
    );
    assert_type(
        &infer(
            "get_file_size(index(field('Files'), 0))",
            json!(1234),
            None,
            &files,
            None,
        ),
        "number",
        None,
    );
    assert_type(
        &infer(
            "get_image_width(index(field('Files'), 0))",
            json!(640),
            None,
            &files,
            None,
        ),
        "number",
        None,
    );
    assert_type(
        &infer(
            "get_image_height(index(field('Files'), 0))",
            json!(480),
            None,
            &files,
            None,
        ),
        "number",
        None,
    );
    assert_type(
        &infer(
            "is_image(index(field('Files'), 0))",
            json!(true),
            None,
            &files,
            None,
        ),
        "boolean",
        None,
    );
}

#[test]
fn returns_compatible_types_for_backend_registered_helper_functions() {
    assert_type(
        &infer("row_id()", json!(1), None, &[], None),
        "number",
        None,
    );
    assert_type(
        &infer(
            "has_option(field('Tags'), 'Urgent')",
            json!(true),
            None,
            &[("tags", "multiple_select")],
            None,
        ),
        "boolean",
        None,
    );
    assert_type(
        &infer(
            "datetime_format(field('Date'), 'YYYY')",
            json!("2026"),
            None,
            &[("date", "date")],
            None,
        ),
        "text",
        None,
    );
    assert_type(
        &infer(
            "datetime_format_tz(field('Date'), 'YYYY', 'Europe/Amsterdam')",
            json!("2026"),
            None,
            &[("date", "date")],
            None,
        ),
        "text",
        None,
    );
    assert_type(
        &infer(
            "greater_than(field('Amount'), 2)",
            json!(true),
            None,
            &[("amount", "number")],
            None,
        ),
        "boolean",
        None,
    );
    assert_type(
        &infer(
            "error_to_nan(does_not_exist())",
            json!(null),
            None,
            &[],
            None,
        ),
        "number",
        None,
    );
    assert_type(
        &infer(
            "error_to_null(field('Amount'))",
            json!(null),
            None,
            &[("amount", "number")],
            None,
        ),
        "number",
        None,
    );
    assert_type(
        &infer(
            "error_to_null(field('Closed'))",
            json!(null),
            None,
            &[("closed", "boolean")],
            None,
        ),
        "boolean",
        None,
    );
}

#[test]
fn matches_type_coercion_rules_for_if_and_when_empty() {
    let amount = [("amount", "number")];
    let inferred = infer(
        "if(true, field('Amount'), 0)",
        json!(1),
        None,
        &amount,
        None,
    );
    assert_type(&inferred, "number", None);
    assert_eq!(inferred.error, None);
    assert_type(
        &infer(
            "if(true, field('Amount'), 'fallback')",
            json!(1),
            None,
            &amount,
            None,
        ),
        "text",
        None,
    );
    assert_type(
        &infer(
            "when_empty(field('Amount'), 0)",
            json!(1),
            None,
            &amount,
            None,
        ),
        "number",
        None,
    );
    let inferred = infer(
        "when_empty(field('Amount'), 'fallback')",
        json!("fallback"),
        None,
        &amount,
        None,
    );
    assert_type(&inferred, "invalid", None);
    assert_eq!(
        inferred.error.as_deref(),
        Some("both inputs for when_empty must be the same type")
    );
}

#[test]
fn returns_compatible_types_for_internal_select_and_json_helpers() {
    assert_type(
        &infer(
            "get_single_select_value(field('Status'))",
            json!("Todo"),
            None,
            &[("status", "single_select")],
            None,
        ),
        "text",
        None,
    );
    assert_type(
        &infer(
            "jsonb_extract_path_text(field('Meta'), 'value')",
            json!("Todo"),
            None,
            &[("meta", "text")],
            None,
        ),
        "text",
        None,
    );
    assert_type(
        &infer(
            "bc_to_null(field('Date'))",
            json!("2026-01-01"),
            None,
            &[("date", "date")],
            None,
        ),
        "date",
        None,
    );
}

#[test]
fn returns_compatible_types_for_internal_aggregate_helpers() {
    let tags = [("tags", "multiple_select")];
    assert_type(
        &infer(
            "array_agg(field('Name'))",
            json!([]),
            None,
            &[("name", "text")],
            None,
        ),
        "array",
        Some("text"),
    );
    assert_type(
        &infer(
            "array_agg_no_nesting(field('Amount'))",
            json!([]),
            None,
            &[("amount", "number")],
            None,
        ),
        "array",
        Some("number"),
    );
    assert_type(
        &infer(
            "array_agg_unnesting(lookup('Customer', 'Tags'))",
            json!([]),
            None,
            &[],
            Some("multiple_select"),
        ),
        "array",
        Some("multiple_select"),
    );
    assert_type(
        &infer(
            "many_to_many_agg(field('Tags'))",
            json!([]),
            None,
            &tags,
            None,
        ),
        "array",
        Some("multiple_select"),
    );
    assert_type(
        &infer(
            "multiple_select_options_agg(field('Tags'))",
            json!([]),
            None,
            &tags,
            None,
        ),
        "array",
        Some("multiple_select"),
    );
    assert_type(
        &infer(
            "many_to_many_count(field('Tags'))",
            json!(2),
            None,
            &tags,
            None,
        ),
        "number",
        None,
    );
    assert_type(
        &infer(
            "multiple_select_count(field('Tags'))",
            json!(2),
            None,
            &tags,
            None,
        ),
        "number",
        None,
    );
    assert_type(
        &infer(
            "string_agg_many_to_many_values(field('Tags'))",
            json!("Todo"),
            None,
            &tags,
            None,
        ),
        "text",
        None,
    );
    assert_type(
        &infer(
            "string_agg_multiple_select_values(field('Tags'))",
            json!("Todo"),
            None,
            &tags,
            None,
        ),
        "text",
        None,
    );
}

#[test]
fn maps_field_references_and_formula_errors_to_response_types() {
    assert_type(
        &infer(
            "field('Closed')",
            json!(true),
            None,
            &[("closed", "boolean")],
            None,
        ),
        "boolean",
        None,
    );
    let inferred = infer("{Amount}", json!(null), None, &[("amount", "number")], None);
    assert_type(&inferred, "number", None);
    assert_eq!(inferred.error, None);
    assert_type(
        &infer(
            "field_by_id(8)",
            json!(10),
            None,
            &[("field_8", "number")],
            None,
        ),
        "number",
        None,
    );
    let inferred = infer(
        "does_not_exist()",
        json!(null),
        Some("Unknown function: DOES_NOT_EXIST"),
        &[],
        None,
    );
    assert_type(&inferred, "invalid", None);
    assert_eq!(
        inferred.error.as_deref(),
        Some("Unknown function: DOES_NOT_EXIST")
    );
}

#[test]
fn maps_field_types_and_extracts_lookup_references() {
    assert_eq!(
        map_field_type_to_formula_type("url", &FieldSettings::default()),
        "url"
    );
    assert_eq!(
        map_field_type_to_formula_type("multiple_select", &FieldSettings::default()),
        "multiple_select"
    );
    let settings = FieldSettings {
        formula_type: Some("array".to_owned()),
        array_formula_type: Some("date".to_owned()),
        nullable: None,
    };
    assert_eq!(map_field_type_to_formula_type("formula", &settings), "date");
    assert_eq!(
        extract_lookup_references("sum(lookup('Links', 'Amount'))"),
        [LookupReference {
            through_field_name: "Links".to_owned(),
            target_field_name: "Amount".to_owned()
        }],
    );
}

#[test]
fn validates_formulas_against_field_types() {
    let field_types = types(&[
        ("amount", "number"),
        ("name", "text"),
        ("due", "date"),
        ("broken", "invalid"),
    ]);
    let nullables = FieldNullables::new();
    let validate = |formula: &str| validate_formula_type(formula, &field_types, None, &nullables);
    assert_eq!(validate("field('Amount') + 1").formula_type, "number");
    assert_eq!(
        validate("{Due} + date_interval('1 day')").formula_type,
        "date"
    );
    assert_eq!(validate("{Due} - {Due}").formula_type, "duration");
    for (formula, error) in [
        (
            "'a' + 2",
            "Operator + is not compatible with text and number.",
        ),
        ("upper(1)", "upper received number, but requires text."),
        ("field('Missing')", "The field Missing does not exist."),
        ("{Missing}", "The field \"Missing\" does not exist."),
        (
            "{Broken}",
            "The field \"Broken\" has an invalid formula type.",
        ),
        ("concat('a')", "concat must receive more than one argument."),
        ("if(true, 1)", "if must receive exactly 3 arguments."),
        ("link()", "link must receive 1 to 2 arguments."),
        (
            "second(today())",
            "second received date, but requires date with time.",
        ),
        ("1 < 'a'", "< received text, but requires number."),
        (
            "field({Name})",
            "field requires a literal field identifier.",
        ),
        ("nope()", "Unknown function: NOPE"),
    ] {
        let inferred = validate(formula);
        assert_eq!(inferred.formula_type, "invalid", "{formula}");
        assert_eq!(inferred.error.as_deref(), Some(error), "{formula}");
    }
    // The API shape: `type`, `result_type` and `formula_type` agree.
    assert_eq!(
        serde_json::to_value(validate("sum(lookup('A', 'B'))")).unwrap(),
        json!({
            "type": "number", "result_type": "number", "formula_type": "number", "array_formula_type": null,
            "error": null, "formula_type_error": null, "nullable": false,
        }),
    );
}

#[test]
fn extracts_field_references_in_order_without_duplicates() {
    assert_eq!(
        extract_field_references("concat({Name}, field(' name '), field_by_id(3), field_by_id('4'), field_by_id(0), {Other})").unwrap(),
        [FieldReference::Name("name".to_owned()), FieldReference::Id(3), FieldReference::Id(4), FieldReference::Name("Other".to_owned())],
    );
    assert!(extract_field_references("concat(").is_err());
}
