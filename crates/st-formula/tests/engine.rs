//! Port of `tests/formula-engine.test.ts`.

use serde_json::json;
use st_formula::{
    Environment, FixedEnvironment, Object, Value, evaluate_formula, evaluate_formula_rows,
};

/// 2026-11-07T12:00:00Z.
const NOW_MS: f64 = 1_794_052_800_000.0;

fn row(fields: serde_json::Value) -> Object {
    match Value::from(fields) {
        Value::Object(object) => object,
        _ => Object::new(),
    }
}

fn error(formula: &str) -> String {
    evaluate_formula(
        formula,
        &Object::new(),
        &mut FixedEnvironment::new(NOW_MS, 1),
    )
    .error
    .unwrap_or_default()
}

fn value_with(formula: &str, fields: serde_json::Value) -> Value {
    let result = evaluate_formula(formula, &row(fields), &mut FixedEnvironment::new(NOW_MS, 1));
    assert_eq!(result.error, None, "{formula}");
    result.value
}

fn value(formula: &str) -> Value {
    value_with(formula, json!({}))
}

fn number(formula: &str) -> f64 {
    value(formula)
        .as_f64()
        .unwrap_or_else(|| panic!("{formula} is not a number"))
}

#[track_caller]
fn assert_value(formula: &str, expected: impl Into<Value>) {
    assert_eq!(value(formula), expected.into(), "{formula}");
}

#[track_caller]
fn assert_json(formula: &str, fields: &serde_json::Value, expected: serde_json::Value) {
    assert_eq!(
        value_with(formula, fields.clone()),
        Value::from(expected),
        "{formula}"
    );
}

#[test]
fn rejects_malformed_tokens_instead_of_silently_changing_the_formula() {
    assert!(error("1 @ 1").contains("Unexpected character"));
    assert!(error("'unterminated").contains("Unterminated string literal"));
    assert!(error("{unterminated").contains("Unterminated field reference"));
}

#[test]
fn enforces_formula_literal_limits() {
    assert_eq!(
        evaluate_formula(
            &format!("'{}'", "x".repeat(10_000)),
            &Object::new(),
            &mut FixedEnvironment::default()
        )
        .error,
        None
    );
    assert!(error(&format!("'{}'", "x".repeat(10_001))).contains("10000"));
}

#[test]
fn resolves_field_and_field_by_id_references() {
    assert_eq!(
        value_with(
            "concat(field('First name'), ' ', field_by_id(2))",
            json!({ "First name": "Ada", "field_2": "Lovelace" })
        ),
        Value::from("Ada Lovelace"),
    );
    // What `serializeRowWithComputedFields` does for a formula field.
    let rows = [row(
        json!({ "id": 10, "order": 10000, "field_1": "Grace", "field_2": "Hopper" }),
    )];
    let fields = [(1, "First name".to_owned()), (2, "Last name".to_owned())];
    let results = evaluate_formula_rows(
        "concat(field('First name'), ' ', field('Last name'))",
        &rows,
        &fields,
        &mut FixedEnvironment::default(),
    );
    assert_eq!(results[0].value, Value::from("Grace Hopper"));
}

#[test]
fn supports_logic_and_text_function_aliases_used_by_the_frontend() {
    for (formula, expected) in [
        ("and(true, true, not(false))", true),
        ("equal('A', 'A')", true),
        ("not_equal('A', 'B')", true),
        ("greater_than(3, 2)", true),
        ("greater_than_or_equal(3, 3)", true),
        ("less_than(2, 3)", true),
        ("less_than_or_equal(3, 3)", true),
        ("true && false || true", true),
        ("isblank(0)", true),
        ("isblank(1)", false),
        ("isblank('')", true),
        ("isblank(' ')", false),
        ("is_null(0)", false),
        ("is_null(1)", false),
        ("is_null('')", false),
        ("is_null(' ')", false),
        ("is_null(date_interval('invalid'))", true),
        ("is_null(left('aaaaaa', 1 / 0))", true),
        ("is_null(todate('aaaa', 'DDMMYYYY'))", true),
        ("regex_match('abc', '^a')", true),
    ] {
        assert_value(formula, expected);
    }
    assert_value("when_empty('', 'fallback')", "");
    assert_value("when_empty(null, 'fallback')", "fallback");
    assert_value("when_empty(0, 2)", 0);
    assert_value("replace('test test', 'test', 'a')", "a a");
    assert_value("search('test test', 'test')", 1);
    assert_value("search('a', 'test')", 0);
    assert_value("reverse('abc')", "cba");
    assert_value("split_part('John, Jane, Matthew', ', ', 2)", "Jane");
    assert_value("left('abcde', 2)", "ab");
    assert_value("left('abcde', -2)", "abc");
    assert_value("when_empty(left('abcd', 1 / 0), 'error')", "error");
    assert_value("right('abcde', 2)", "de");
    assert_value("right('abcde', -2)", "cde");
    assert_value("when_empty(right('abcd', 1 / 0), 'error')", "error");
    assert_value("t('text')", "text");
    assert_value("t(10)", "");
    assert_value("tovarchar('AB')", "AB");
    for (formula, expected) in [
        ("tourl(lower('EXAMPLE.com'))", "example.com"),
        ("tourl('example.com')", "example.com"),
        ("tourl('example.com/subpage')", "example.com/subpage"),
        (
            "tourl('example.com/subpage/?query=true')",
            "example.com/subpage/?query=true",
        ),
        (
            "tourl(concat('example.com', '/subpage/?query=true'))",
            "example.com/subpage/?query=true",
        ),
        ("tourl(replace('exa-ple.com', '-', 'm'))", "example.com"),
        ("tourl('localhost')", "localhost"),
        ("tourl('skype://call-me')", "skype://call-me"),
        (
            "tourl('https://example.com:3000')",
            "https://example.com:3000",
        ),
        (
            "tourl('ftp://example.com/some/path')",
            "ftp://example.com/some/path",
        ),
        ("tourl('https://example.com:3000invalid')", ""),
        ("tourl('https://example.comhttps://example.com')", ""),
        (
            "tourl('https://user:password@www.example.com:8080/path/to/resource?search=query&filter=active#section2')",
            "https://user:password@www.example.com:8080/path/to/resource?search=query&filter=active#section2",
        ),
        (
            "encode_uri('http://example.com/wiki/Señor')",
            "http://example.com/wiki/Se%c3%b1or",
        ),
        ("encode_uri_component('Hello World')", "Hello%20World"),
        ("regex_replace('abc', 'a', '1')", "1bc"),
    ] {
        assert_value(formula, expected);
    }
}

#[test]
fn supports_runtime_helpers_used_by_builder_and_automation_formulas() {
    assert_eq!(
        value_with(
            "get('data_source.rows.0.name')",
            json!({ "data_source": { "rows": [{ "name": "Ada" }] } })
        ),
        Value::from("Ada")
    );
    assert_eq!(
        value_with("get('exact.key')", json!({ "exact.key": "exact value" })),
        Value::from("exact value")
    );
    assert_eq!(
        value_with(
            "get_property(field('Payload'), 'email')",
            json!({ "Payload": { "email": "ada@example.com" } })
        ),
        Value::from("ada@example.com"),
    );
    assert_eq!(
        value_with(
            "is_empty(field('EmptyObject'))",
            json!({ "EmptyObject": {} })
        ),
        Value::Bool(true)
    );
    assert_value("is_empty('   ')", true);
    assert_value("strip('  123  ')", "123");
    assert_value("capitalize('aDA LOVELACE')", "Ada lovelace");
    assert_value("is_even(4)", true);
    assert_value("is_odd(5)", true);
    assert_eq!(
        value("to_array('a, b, c')"),
        Value::from(json!(["a", "b", "c"]))
    );
    assert_value("at(to_array('a, b, c'), -1)", "c");

    let uuid = value("generate_uuid()");
    let uuid = uuid.as_str().expect("text");
    let groups: Vec<&str> = uuid.split('-').collect();
    assert_eq!(
        groups.iter().map(|group| group.len()).collect::<Vec<_>>(),
        [8, 4, 4, 4, 12],
        "{uuid}"
    );
    assert!(
        uuid.chars()
            .all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "{uuid}"
    );
    assert!(
        groups[2].starts_with('4') && matches!(groups[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'),
        "{uuid}"
    );

    let random_int = number("random_int(2, 4)");
    assert!(random_int.fract() == 0.0 && (2.0..=4.0).contains(&random_int));
    let random_float = number("random_float(2, 4)");
    assert!((2.0..4.0).contains(&random_float));
    assert!(matches!(value("random_bool()"), Value::Bool(_)));
}

#[test]
fn supports_numeric_and_date_helper_functions() {
    for (formula, expected) in [
        ("1-1", 0.0),
        ("1--1", 2.0),
        ("-1.5 * 2", -3.0),
        ("greatest(1, 3, 2)", 3.0),
        ("least(1, 3, 2)", 1.0),
        ("round(1.12345, 2)", 1.12),
        ("round(1234.5678, -2)", 1200.0),
        ("round(1234.11111, 2.999)", 1234.11),
        ("round(-1.5, 0)", -2.0),
        ("round(-125, -1)", -130.0),
        ("trunc(-1.56)", -1.0),
        ("int(-1.56)", -1.0),
        ("date_interval('1 minute')", 60.0),
        ("toseconds(toduration(60))", 60.0),
        ("toseconds(date_interval('1 minute'))", 60.0),
        ("date_interval('1 year')", 365.0 * 24.0 * 3600.0),
        (
            "todate('20200101', 'YYYYMMDD') - todate('20210101', 'YYYYMMDD')",
            -366.0 * 24.0 * 3600.0,
        ),
        (
            "date_interval('1 year') - date_interval('1 day')",
            364.0 * 24.0 * 3600.0,
        ),
        ("date_interval('1 minute') * 2", 120.0),
        ("3 * date_interval('1 minute')", 180.0),
        ("date_interval('1 minute') / 2", 30.0),
        (
            "month(todate('20200601', 'YYYYMMDD') - date_interval('1 year'))",
            6.0,
        ),
        (
            "month(todate('20200601', 'YYYYMMDD') + (todate('20200601', 'YYYYMMDD') - todate('20100601', 'YYYYMMDD')))",
            6.0,
        ),
        ("day(todate('20170103','YYYYMMDD'))", 3.0),
        (
            "date_diff('yy', todate('20200101', 'YYYYMMDD'), todate('20100101', 'YYYYMMDD'))",
            -10.0,
        ),
        (
            "date_diff('yy', todate('2000-01-01', 'YYYY-MM-DD'), todate('2020-01-01', 'YYYY-MM-DD'))",
            20.0,
        ),
        (
            "date_diff('day', todate('2020-01-01', 'YYYY-MM-DD'), todate('2020-01-03', 'YYYY-MM-DD'))",
            2.0,
        ),
    ] {
        assert_value(formula, expected);
    }
    assert!((number("log(3, 9)") - 2.0).abs() < 0.005);
    for formula in [
        "even(2)",
        "odd(5)",
        "now() > todate('20200101', 'YYYYMMDD')",
        "today() > todate('20200101', 'YYYYMMDD')",
    ] {
        assert_value(formula, true);
    }
    for formula in [
        "todate('01123456', 'DDMMYYYY') < now()",
        "todate('01123456', 'DDMMYYYY') < today()",
    ] {
        assert_value(formula, false);
    }
    for formula in [
        "date_interval('1 invalid')",
        "toduration(1 / 0)",
        "date_interval('1 minute') / 0",
        "todate_tz('20200101', 'YYYYMMDD', 'NONSENSE')",
        "todate_tz('20200101', 'NONSENSE', 'NONSENSE')",
        "todate_tz('NONSENSE', 'NONSENSE', 'NONSENSE')",
        "todate_tz('', '', '')",
    ] {
        assert_value(formula, Value::Null);
    }
    assert!(number("date_diff('incorrect thingy', todate('20200101', 'YYYYMMDD'), todate('20100101', 'YYYYMMDD'))").is_nan());
    for (formula, expected) in [
        ("totext(date_interval('1 year'))", "1 year"),
        ("totext(date_interval('2 seconds'))", "2 seconds"),
        ("totext(date_interval('1 minute') * 2)", "120"),
        (
            "todate('20200101', 'YYYYMMDD') + date_interval('1 year')",
            "2021-01-01",
        ),
        (
            "date_interval('1 year') + todate('20200101', 'YYYYMMDD')",
            "2021-01-01",
        ),
        (
            "todate('20200101', 'YYYYMMDD') + date_interval('1 second')",
            "2020-01-01",
        ),
        (
            "todate('20200101', 'YYYYMMDD') - date_interval('1 year')",
            "2019-01-01",
        ),
        ("todate('20170103','YYYYMMDD')", "2017-01-03"),
        (
            "datetime_format('2025-01-02T03:04:05Z', 'YYYY-MM-DD HH24:MI:SS')",
            "2025-01-02 03:04:05",
        ),
    ] {
        assert_value(formula, expected);
    }
}

/// The named-zone cases of the TS test, which need the bundled database.
#[cfg(feature = "tzdb")]
#[test]
fn supports_named_time_zones() {
    for (formula, expected) in [
        (
            "todate_tz('20200101', 'YYYYMMDD', 'CET')",
            "2019-12-31T23:00:00Z",
        ),
        (
            "datetime_format_tz(todate_tz('20200101 0000', 'YYYYMMDD HH24MI', 'Europe/Rome'), 'YYYYMMDD HH24MI', 'Europe/Rome')",
            "20200101 0000",
        ),
        (
            "datetime_format(todate_tz('20200101 0000', 'YYYYMMDD HH24MI', 'Europe/Rome'), 'YYYYMMDD HH24MI')",
            "20191231 2300",
        ),
        (
            "datetime_format(todate_tz('20200101 0000', 'YYYYMMDD HH24MI', 'Europe/Rome'), 'day')",
            "tuesday",
        ),
        (
            "datetime_format_tz(todate_tz('20200103 0000', 'YYYYMMDD HH24MI', 'Europe/Rome'), 'day', 'Europe/Rome')",
            "friday",
        ),
        (
            "datetime_format_tz('2025-01-02T03:04:05Z', 'YYYY-MM-DD HH24:MI', 'Europe/Amsterdam')",
            "2025-01-02 04:04",
        ),
    ] {
        assert_value(formula, expected);
    }
}

#[test]
fn matches_nan_semantics_for_invalid_numeric_formulas() {
    for formula in [
        "1 / 0",
        "divide(1, 0)",
        "mod(1, 0)",
        "tonumber('invalid number')",
        "round(1234.11111, tonumber('invalid number'))",
        "power(1234.11111, 1 / 0)",
        "ln(0)",
        "ln(-1)",
        "log(0, 5)",
        "log(5, 0)",
        "log(-10, 2)",
        "sqrt(-4)",
        "error_to_nan(does_not_exist())",
        "error_to_nan(1 / 0)",
    ] {
        assert!(number(formula).is_nan(), "{formula}");
    }
    assert_value("is_nan(1 / 0)", true);
    assert_value("is_nan(1)", false);
    assert_value("when_nan(1 / 0, 4)", 4);
    assert_value("when_nan(1, 4)", 1);
    assert_value("error_to_null(does_not_exist())", Value::Null);
    assert_value("error_to_null(1 + 2)", 3);
}

#[test]
fn returns_link_and_button_values_with_url_and_label_accessors() {
    let empty = json!({});
    assert_json(
        "link('https://www.google.com')",
        &empty,
        json!({ "url": "https://www.google.com", "label": null }),
    );
    assert_json(
        "link('https://www.google.com', 'Google')",
        &empty,
        json!({ "url": "https://www.google.com", "label": "Google" }),
    );
    assert_json(
        "button('https://www.google.com', 'Open')",
        &empty,
        json!({ "url": "https://www.google.com", "label": "Open" }),
    );
    assert_value("get_link_url(button('a' + 'b', 'l' + 'a'))", "ab");
    assert_value("get_link_label(button('1', 'l'))", "l");
    assert_value("get_link_label(link('1'))", Value::Null);
    assert_value(
        "link('https://www.google.com') = link('https://www.google.com')",
        true,
    );
    assert_value(
        "button('https://www.google.com', 'Google') = button('https://www.google.com', 'Google2')",
        false,
    );
}

#[test]
fn supports_internal_select_and_json_extraction_helpers_used_by_formula_casts() {
    let fields = json!({
        "Status": { "id": 1, "value": "Todo", "color": "blue" },
        "SerializedStatus": json!({ "id": 2, "value": "Done", "color": "green" }).to_string(),
        "Nested": json!({ "value": { "name": "Nested Todo" }, "items": [{ "label": "First" }] }).to_string(),
    });
    assert_json(
        "get_single_select_value(field('Status'))",
        &fields,
        json!("Todo"),
    );
    assert_json(
        "get_single_select_value(field('SerializedStatus'))",
        &fields,
        json!("Done"),
    );
    assert_json("get_single_select_value(null)", &fields, json!(null));
    assert_json(
        "jsonb_extract_path_text(field('Nested'), 'value', 'name')",
        &fields,
        json!("Nested Todo"),
    );
    assert_json(
        "jsonb_extract_path_text(field('Nested'), 'items', '0', 'label')",
        &fields,
        json!("First"),
    );
    assert_json(
        "jsonb_extract_path_text(field('Nested'), 'missing')",
        &fields,
        json!(null),
    );
    assert_value("bc_to_null('-0001-01-01')", Value::Null);
    assert_value("bc_to_null('2026-01-01')", "2026-01-01");
}

#[test]
fn supports_internal_array_and_many_to_many_aggregate_helpers() {
    let tags = json!([{ "id": 11, "value": "Urgent", "color": "red" }, { "id": 12, "value": "External", "color": "blue" }]);
    let internal = json!([{ "id": 13, "value": "Internal", "color": "green" }]);
    let fields = json!({
        "Names": ["Tesla", "Apple"],
        "SerializedNames": json!(["One", "Two"]).to_string(),
        "NestedNames": [["A", "B"], ["C"]],
        "Tags": tags,
        "SerializedTags": tags.to_string(),
        "TagLookups": [tags, internal],
        "Collaborators": [
            { "id": 21, "first_name": "Ada", "email": "ada@example.com" },
            { "id": 22, "first_name": "Grace", "email": "grace@example.com" },
        ],
    });
    assert_json(
        "array_agg(field('Names'))",
        &fields,
        json!([{ "id": 1, "value": "Tesla" }, { "id": 2, "value": "Apple" }]),
    );
    assert_json(
        "array_agg(field('SerializedNames'))",
        &fields,
        json!([{ "id": 1, "value": "One" }, { "id": 2, "value": "Two" }]),
    );
    assert_json(
        "array_agg_no_nesting(field('Names'))",
        &fields,
        json!(["Tesla", "Apple"]),
    );
    assert_json(
        "array_agg_unnesting(field('NestedNames'))",
        &fields,
        json!(["A", "B", "C"]),
    );
    let groups = json!([{ "id": 1, "value": tags }, { "id": 2, "value": internal }]);
    assert_json(
        "many_to_many_agg(field('TagLookups'))",
        &fields,
        groups.clone(),
    );
    assert_json(
        "multiple_select_options_agg(field('TagLookups'))",
        &fields,
        groups,
    );
    assert_json("many_to_many_count(field('Tags'))", &fields, json!(2));
    assert_json(
        "multiple_select_count(field('SerializedTags'))",
        &fields,
        json!(2),
    );
    assert_json(
        "string_agg_many_to_many_values(field('Tags'))",
        &fields,
        json!("Urgent, External"),
    );
    assert_json(
        "string_agg_many_to_many_values(field('Collaborators'))",
        &fields,
        json!("Ada, Grace"),
    );
    assert_json(
        "string_agg_multiple_select_values(field('SerializedTags'))",
        &fields,
        json!("Urgent, External"),
    );
}

#[test]
fn aggregates_and_filters_array_values_like_lookup_formulas() {
    let fields = json!({
        "Numbers": [5, null, 7, 3],
        "Names": ["Alice", "Bob", "Carol"],
        "Checks": [true, false, true],
        "Tags": [{ "id": 1, "value": "Urgent", "color": "red" }, { "id": 2, "value": "External", "color": "blue" }],
        "SerializedTags": json!([{ "id": 3, "value": "Serialized", "color": "green" }]).to_string(),
        "Links": [{ "url": "https://example.com/a", "label": "A" }, { "url": "https://example.com/b", "label": null }],
    });
    for (formula, expected) in [
        ("sum(field('Numbers'))", json!(15)),
        ("avg(field('Numbers'))", json!(5)),
        ("max(filter(field('Numbers'), field('Checks')))", json!(7)),
        ("count(filter(field('Names'), field('Checks')))", json!(2)),
        (
            "join(filter(field('Names'), field('Checks')), ',')",
            json!("Alice,Carol"),
        ),
        (
            "join(field('Links'), ';')",
            json!("A (https://example.com/a);https://example.com/b"),
        ),
        ("any(field('Checks'))", json!(true)),
        ("every(field('Checks'))", json!(false)),
        ("any(field('Names') = 'Bob')", json!(true)),
        ("every(field('Names') != 'Missing')", json!(true)),
        (
            "join(filter(field('Names'), field('Names') != 'Bob'), ',')",
            json!("Alice,Carol"),
        ),
        (
            "join(filter(field('Names') + '!', contains(field('Names'), 'B')), ',')",
            json!("Bob!"),
        ),
        (
            "join(filter(field('Names'), length(field('Names')) > 3), ',')",
            json!("Alice,Carol"),
        ),
        (
            "sum(filter(field('Numbers'), field('Numbers') > 4))",
            json!(12),
        ),
        ("any(not(field('Checks')))", json!(true)),
        ("has_option(field('Tags'), 'Urgent')", json!(true)),
        (
            "has_option(field('SerializedTags'), 'Serialized')",
            json!(true),
        ),
        ("has_option(field('Tags'), 'Missing')", json!(false)),
    ] {
        assert_json(formula, &fields, expected);
    }
    let deviation = value_with("stddev_pop(field('Numbers'))", fields)
        .as_f64()
        .unwrap_or(f64::NAN);
    assert!((deviation - 1.63299).abs() < 0.000005, "{deviation}");
}

#[test]
fn resolves_row_id_from_the_current_row_context() {
    assert_eq!(
        value_with("row_id()", json!({ "__row_id": 42 })),
        Value::from(42)
    );
    let rows = [row(json!({ "id": 99, "order": 10000, "field_1": "Alpha" }))];
    let results = evaluate_formula_rows(
        "concat('Row ', row_id())",
        &rows,
        &[(1, "Name".to_owned())],
        &mut FixedEnvironment::default(),
    );
    assert_eq!(results[0].value, Value::from("Row 99"));
}

#[test]
fn extracts_file_metadata_with_index_and_get_file_helpers() {
    let fields = json!({
        "Files": [
            {
                "visible_name": "Contract.pdf",
                "original_name": "stored-contract.pdf",
                "name": "stored-contract.pdf",
                "size": 1234,
                "mime_type": "application/pdf",
                "is_image": false,
            },
            { "visible_name": "Photo.png", "name": "photo.png", "size": "68", "mime_type": "image/png", "image_width": 640, "image_height": "480" },
        ],
    });
    assert_json("get_file_count(field('Files'))", &fields, json!(2));
    assert_json(
        "get_file_visible_name(index(field('Files'), 0))",
        &fields,
        json!("Contract.pdf"),
    );
    assert_json(
        "get_file_mime_type(index(field('Files'), 1))",
        &fields,
        json!("image/png"),
    );
    assert_json(
        "get_file_size(index(field('Files'), 0))",
        &fields,
        json!(1234),
    );
    assert_json(
        "get_image_width(index(field('Files'), 1))",
        &fields,
        json!(640),
    );
    assert_json(
        "get_image_height(index(field('Files'), 1))",
        &fields,
        json!(480),
    );
    assert_json("is_image(index(field('Files'), 1))", &fields, json!(true));
    assert_json("is_image(index(field('Files'), 0))", &fields, json!(false));
}

#[test]
fn reads_file_helpers_when_file_cells_are_stored_as_json_strings() {
    let fields = json!({
        "Files": json!([{ "visible_name": "Image.jpg", "size": 2048, "mime_type": "image/jpeg", "image_width": 1200, "image_height": 800 }])
            .to_string(),
    });
    assert_json("get_file_count(field('Files'))", &fields, json!(1));
    assert_json(
        "get_file_visible_name(index(field('Files'), 0))",
        &fields,
        json!("Image.jpg"),
    );
    assert_json("is_image(index(field('Files'), 0))", &fields, json!(true));
}

#[test]
fn durations_come_out_as_seconds_and_errors_as_null() {
    assert_eq!(error("[1]"), "Unexpected character: \"[\"");
    assert_eq!(
        error("does_not_exist()"),
        "Unknown function: DOES_NOT_EXIST"
    );
    assert_eq!(
        error("dateadd('2020-01-01', 99999999999, 'days')"),
        "Invalid time value"
    );
    let results = evaluate_formula_rows(
        "concat(",
        &[Object::new()],
        &[],
        &mut FixedEnvironment::default(),
    );
    assert_eq!(
        results[0].error.as_deref(),
        Some("Expected RPAREN, got EOF (\"\")")
    );
    assert_eq!(
        value("array_agg(date_interval('1 day'))"),
        Value::from(json!([{ "id": 1, "value": 86400 }]))
    );
}

/// A host that knows its own zones, as the Worker can through `Intl`.
struct HostZones;

impl Environment for HostZones {
    fn now_ms(&mut self) -> f64 {
        NOW_MS
    }

    fn random_u64(&mut self) -> u64 {
        4
    }

    fn time_zone_offset_ms(&mut self, zone: &str, _utc_ms: f64) -> Option<f64> {
        zone.eq_ignore_ascii_case("Mars/Base")
            .then_some(3.0 * 3_600_000.0)
    }
}

#[test]
fn named_time_zones_come_from_the_environment() {
    let mut env = HostZones;
    let evaluate =
        |formula: &str, env: &mut HostZones| evaluate_formula(formula, &Object::new(), env).value;
    assert_eq!(
        evaluate(
            "todate_tz('20200101 0000', 'YYYYMMDD HH24MI', 'mars/base')",
            &mut env
        ),
        Value::from("2019-12-31T21:00:00Z")
    );
    assert_eq!(
        evaluate(
            "datetime_format_tz('2020-01-01T23:00:00Z', 'YYYY-MM-DD HH24:MI day', 'Mars/Base')",
            &mut env
        ),
        Value::from("2020-01-02 02:00 day")
    );
    // Offset names never reach the host; unknown names behave like invalid ones.
    assert_eq!(
        evaluate(
            "todate_tz('20200101 0000', 'YYYYMMDD HH24MI', '+01:00')",
            &mut env
        ),
        Value::from("2019-12-31T23:00:00Z")
    );
    assert_eq!(
        evaluate("todate_tz('20200101', 'YYYYMMDD', 'Europe/Rome')", &mut env),
        Value::Null
    );
}
