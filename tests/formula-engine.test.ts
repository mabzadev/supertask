import { describe, expect, it } from "vitest";
import { evaluateFormula } from "../src/services/formula-engine";
import { serializeRowWithComputedFields } from "../src/services/computed-fields";
import type { FieldMeta } from "../src/services/dynamic-tables";

function value(formula: string, fields: Record<string, unknown> = {}) {
  const result = evaluateFormula(formula, fields);
  expect(result.error).toBeNull();
  return result.value;
}

describe("Baserow formula runtime parity", () => {
  it("rejects malformed tokens instead of silently changing the formula", () => {
    expect(evaluateFormula("1 @ 1", {}).error).toContain("Unexpected character");
    expect(evaluateFormula("'unterminated", {}).error).toContain("Unterminated string literal");
    expect(evaluateFormula("{unterminated", {}).error).toContain("Unterminated field reference");
  });

  it("enforces Baserow formula literal limits", () => {
    expect(evaluateFormula(`'${"x".repeat(10000)}'`, {}).error).toBeNull();
    expect(evaluateFormula(`'${"x".repeat(10001)}'`, {}).error).toContain("10000");
  });

  it("resolves Baserow field() and field_by_id() references", async () => {
    expect(value("concat(field('First name'), ' ', field_by_id(2))", {
      "First name": "Ada",
      field_2: "Lovelace",
    })).toBe("Ada Lovelace");

    const fields: FieldMeta[] = [
      { id: 1, name: "First name", type: "text", primary: false },
      { id: 2, name: "Last name", type: "text", primary: false },
      {
        id: 3,
        name: "Full name",
        type: "formula",
        primary: false,
        readOnly: true,
        formula: "concat(field('First name'), ' ', field('Last name'))",
      },
    ];
    const row = { id: 10, order: 10000, field_1: "Grace", field_2: "Hopper" };
    const serialized = await serializeRowWithComputedFields({} as any, row, fields);
    expect(serialized.field_3).toBe("Grace Hopper");
  });

  it("supports Baserow logic and text function aliases used by the frontend", () => {
    expect(value("and(true, true, not(false))")).toBe(true);
    expect(value("equal('A', 'A')")).toBe(true);
    expect(value("not_equal('A', 'B')")).toBe(true);
    expect(value("greater_than(3, 2)")).toBe(true);
    expect(value("greater_than_or_equal(3, 3)")).toBe(true);
    expect(value("less_than(2, 3)")).toBe(true);
    expect(value("less_than_or_equal(3, 3)")).toBe(true);
    expect(value("true && false || true")).toBe(true);
    expect(value("isblank(0)")).toBe(true);
    expect(value("isblank(1)")).toBe(false);
    expect(value("isblank('')")).toBe(true);
    expect(value("isblank(' ')")).toBe(false);
    expect(value("is_null(0)")).toBe(false);
    expect(value("is_null(1)")).toBe(false);
    expect(value("is_null('')")).toBe(false);
    expect(value("is_null(' ')")).toBe(false);
    expect(value("is_null(date_interval('invalid'))")).toBe(true);
    expect(value("is_null(left('aaaaaa', 1 / 0))")).toBe(true);
    expect(value("is_null(todate('aaaa', 'DDMMYYYY'))")).toBe(true);
    expect(value("when_empty('', 'fallback')")).toBe("");
    expect(value("when_empty(null, 'fallback')")).toBe("fallback");
    expect(value("when_empty(0, 2)")).toBe(0);
    expect(value("replace('test test', 'test', 'a')")).toBe("a a");
    expect(value("search('test test', 'test')")).toBe(1);
    expect(value("search('a', 'test')")).toBe(0);
    expect(value("reverse('abc')")).toBe("cba");
    expect(value("split_part('John, Jane, Matthew', ', ', 2)")).toBe("Jane");
    expect(value("left('abcde', 2)")).toBe("ab");
    expect(value("left('abcde', -2)")).toBe("abc");
    expect(value("when_empty(left('abcd', 1 / 0), 'error')")).toBe("error");
    expect(value("right('abcde', 2)")).toBe("de");
    expect(value("right('abcde', -2)")).toBe("cde");
    expect(value("when_empty(right('abcd', 1 / 0), 'error')")).toBe("error");
    expect(value("t('text')")).toBe("text");
    expect(value("t(10)")).toBe("");
    expect(value("tovarchar('AB')")).toBe("AB");
    expect(value("tourl(lower('BASEROW.io'))")).toBe("baserow.io");
    expect(value("tourl('baserow.io')")).toBe("baserow.io");
    expect(value("tourl('baserow.io/subpage')")).toBe("baserow.io/subpage");
    expect(value("tourl('baserow.io/subpage/?query=true')")).toBe("baserow.io/subpage/?query=true");
    expect(value("tourl(concat('baserow.io', '/subpage/?query=true'))")).toBe("baserow.io/subpage/?query=true");
    expect(value("tourl(replace('base-ow.io', '-', 'r'))")).toBe("baserow.io");
    expect(value("tourl('localhost')")).toBe("localhost");
    expect(value("tourl('skype://call-me')")).toBe("skype://call-me");
    expect(value("tourl('https://baserow.io:3000')")).toBe("https://baserow.io:3000");
    expect(value("tourl('ftp://baserow.io/some/path')")).toBe("ftp://baserow.io/some/path");
    expect(value("tourl('https://baserow.io:3000invalid')")).toBe("");
    expect(value("tourl('https://baserow.iohttps://baserow.io')")).toBe("");
    expect(value("tourl('https://user:password@www.baserow.io:8080/path/to/resource?search=query&filter=active#section2')")).toBe("https://user:password@www.baserow.io:8080/path/to/resource?search=query&filter=active#section2");
    expect(value("encode_uri('http://example.com/wiki/Señor')")).toBe("http://example.com/wiki/Se%c3%b1or");
    expect(value("encode_uri_component('Hello World')")).toBe("Hello%20World");
    expect(value("regex_replace('abc', 'a', '1')")).toBe("1bc");
    expect(value("regex_match('abc', '^a')")).toBe(true);
  });

  it("supports Baserow runtime helpers used by builder and automation formulas", () => {
    expect(value("get('data_source.rows.0.name')", {
      data_source: { rows: [{ name: "Ada" }] },
    })).toBe("Ada");
    expect(value("get('exact.key')", { "exact.key": "exact value" })).toBe("exact value");
    expect(value("get_property(field('Payload'), 'email')", {
      Payload: { email: "ada@example.com" },
    })).toBe("ada@example.com");
    expect(value("is_empty(field('EmptyObject'))", { EmptyObject: {} })).toBe(true);
    expect(value("is_empty('   ')")).toBe(true);
    expect(value("strip('  123  ')")).toBe("123");
    expect(value("capitalize('aDA LOVELACE')")).toBe("Ada lovelace");
    expect(value("is_even(4)")).toBe(true);
    expect(value("is_odd(5)")).toBe(true);
    expect(value("to_array('a, b, c')")).toEqual(["a", "b", "c"]);
    expect(value("at(to_array('a, b, c'), -1)")).toBe("c");
    expect(value("generate_uuid()")).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));

    const randomInt = value("random_int(2, 4)");
    expect(Number.isInteger(randomInt)).toBe(true);
    expect(Number(randomInt)).toBeGreaterThanOrEqual(2);
    expect(Number(randomInt)).toBeLessThanOrEqual(4);

    const randomFloat = value("random_float(2, 4)");
    expect(typeof randomFloat).toBe("number");
    expect(Number(randomFloat)).toBeGreaterThanOrEqual(2);
    expect(Number(randomFloat)).toBeLessThan(4);
    expect(typeof value("random_bool()")).toBe("boolean");
  });

  it("supports Baserow numeric and date helper functions", () => {
    expect(value("1-1")).toBe(0);
    expect(value("1--1")).toBe(2);
    expect(value("-1.5 * 2")).toBe(-3);
    expect(value("greatest(1, 3, 2)")).toBe(3);
    expect(value("least(1, 3, 2)")).toBe(1);
    expect(value("round(1.12345, 2)")).toBe(1.12);
    expect(value("round(1234.5678, -2)")).toBe(1200);
    expect(value("round(1234.11111, 2.999)")).toBe(1234.11);
    expect(value("round(-1.5, 0)")).toBe(-2);
    expect(value("round(-125, -1)")).toBe(-130);
    expect(value("log(3, 9)")).toBeCloseTo(2);
    expect(value("trunc(-1.56)")).toBe(-1);
    expect(value("int(-1.56)")).toBe(-1);
    expect(value("even(2)")).toBe(true);
    expect(value("odd(5)")).toBe(true);
    expect(value("date_interval('1 minute')")).toBe(60);
    expect(value("toseconds(toduration(60))")).toBe(60);
    expect(value("toseconds(date_interval('1 minute'))")).toBe(60);
    expect(value("date_interval('1 year')")).toBe(365 * 24 * 3600);
    expect(value("totext(date_interval('1 year'))")).toBe("1 year");
    expect(value("totext(date_interval('2 seconds'))")).toBe("2 seconds");
    expect(value("totext(date_interval('1 minute') * 2)")).toBe("120");
    expect(value("date_interval('1 invalid')")).toBeNull();
    expect(value("toduration(1 / 0)")).toBeNull();
    expect(value("todate('20200101', 'YYYYMMDD') + date_interval('1 year')")).toBe("2021-01-01");
    expect(value("date_interval('1 year') + todate('20200101', 'YYYYMMDD')")).toBe("2021-01-01");
    expect(value("todate('20200101', 'YYYYMMDD') + date_interval('1 second')")).toBe("2020-01-01");
    expect(value("todate('20200101', 'YYYYMMDD') - date_interval('1 year')")).toBe("2019-01-01");
    expect(value("month(todate('20200601', 'YYYYMMDD') - date_interval('1 year'))")).toBe(6);
    expect(value("month(todate('20200601', 'YYYYMMDD') + (todate('20200601', 'YYYYMMDD') - todate('20100601', 'YYYYMMDD')))")).toBe(6);
    expect(value("todate('20200101', 'YYYYMMDD') - todate('20210101', 'YYYYMMDD')")).toBe(-366 * 24 * 3600);
    expect(value("date_interval('1 year') - date_interval('1 day')")).toBe(364 * 24 * 3600);
    expect(value("date_interval('1 minute') * 2")).toBe(120);
    expect(value("3 * date_interval('1 minute')")).toBe(180);
    expect(value("date_interval('1 minute') / 2")).toBe(30);
    expect(value("date_interval('1 minute') / 0")).toBeNull();
    expect(value("now() > todate('20200101', 'YYYYMMDD')")).toBe(true);
    expect(value("todate('01123456', 'DDMMYYYY') < now()")).toBe(false);
    expect(value("todate('01123456', 'DDMMYYYY') < today()")).toBe(false);
    expect(value("today() > todate('20200101', 'YYYYMMDD')")).toBe(true);
    expect(value("todate_tz('20200101', 'YYYYMMDD', 'CET')")).toBe("2019-12-31T23:00:00Z");
    expect(value("todate_tz('20200101', 'YYYYMMDD', 'NONSENSE')")).toBeNull();
    expect(value("todate_tz('20200101', 'NONSENSE', 'NONSENSE')")).toBeNull();
    expect(value("todate_tz('NONSENSE', 'NONSENSE', 'NONSENSE')")).toBeNull();
    expect(value("todate_tz('', '', '')")).toBeNull();
    expect(value("datetime_format_tz(todate_tz('20200101 0000', 'YYYYMMDD HH24MI', 'Europe/Rome'), 'YYYYMMDD HH24MI', 'Europe/Rome')")).toBe("20200101 0000");
    expect(value("datetime_format(todate_tz('20200101 0000', 'YYYYMMDD HH24MI', 'Europe/Rome'), 'YYYYMMDD HH24MI')")).toBe("20191231 2300");
    expect(value("datetime_format(todate_tz('20200101 0000', 'YYYYMMDD HH24MI', 'Europe/Rome'), 'day')")).toBe("tuesday");
    expect(value("datetime_format_tz(todate_tz('20200103 0000', 'YYYYMMDD HH24MI', 'Europe/Rome'), 'day', 'Europe/Rome')")).toBe("friday");
    expect(value("todate('20170103','YYYYMMDD')")).toBe("2017-01-03");
    expect(value("day(todate('20170103','YYYYMMDD'))")).toBe(3);
    expect(value("date_diff('yy', todate('20200101', 'YYYYMMDD'), todate('20100101', 'YYYYMMDD'))")).toBe(-10);
    expect(Number.isNaN(value("date_diff('incorrect thingy', todate('20200101', 'YYYYMMDD'), todate('20100101', 'YYYYMMDD'))"))).toBe(true);
    expect(value("date_diff('yy', todate('2000-01-01', 'YYYY-MM-DD'), todate('2020-01-01', 'YYYY-MM-DD'))")).toBe(20);
    expect(value("date_diff('day', todate('2020-01-01', 'YYYY-MM-DD'), todate('2020-01-03', 'YYYY-MM-DD'))")).toBe(2);
    expect(value("datetime_format('2025-01-02T03:04:05Z', 'YYYY-MM-DD HH24:MI:SS')")).toBe("2025-01-02 03:04:05");
    expect(value("datetime_format_tz('2025-01-02T03:04:05Z', 'YYYY-MM-DD HH24:MI', 'Europe/Amsterdam')")).toBe("2025-01-02 04:04");
  });

  it("matches Baserow NaN semantics for invalid numeric formulas", () => {
    expect(Number.isNaN(value("1 / 0"))).toBe(true);
    expect(Number.isNaN(value("divide(1, 0)"))).toBe(true);
    expect(Number.isNaN(value("mod(1, 0)"))).toBe(true);
    expect(Number.isNaN(value("tonumber('invalid number')"))).toBe(true);
    expect(Number.isNaN(value("round(1234.11111, tonumber('invalid number'))"))).toBe(true);
    expect(Number.isNaN(value("power(1234.11111, 1 / 0)"))).toBe(true);
    expect(Number.isNaN(value("ln(0)"))).toBe(true);
    expect(Number.isNaN(value("ln(-1)"))).toBe(true);
    expect(Number.isNaN(value("log(0, 5)"))).toBe(true);
    expect(Number.isNaN(value("log(5, 0)"))).toBe(true);
    expect(Number.isNaN(value("log(-10, 2)"))).toBe(true);
    expect(Number.isNaN(value("sqrt(-4)"))).toBe(true);
    expect(value("is_nan(1 / 0)")).toBe(true);
    expect(value("is_nan(1)")).toBe(false);
    expect(value("when_nan(1 / 0, 4)")).toBe(4);
    expect(value("when_nan(1, 4)")).toBe(1);
    expect(Number.isNaN(value("error_to_nan(does_not_exist())"))).toBe(true);
    expect(value("error_to_null(does_not_exist())")).toBeNull();
    expect(value("error_to_null(1 + 2)")).toBe(3);
    expect(Number.isNaN(value("error_to_nan(1 / 0)"))).toBe(true);
  });

  it("returns Baserow formula link and button values with URL and label accessors", () => {
    expect(value("link('https://www.google.com')")).toEqual({
      url: "https://www.google.com",
      label: null,
    });
    expect(value("link('https://www.google.com', 'Google')")).toEqual({
      url: "https://www.google.com",
      label: "Google",
    });
    expect(value("button('https://www.google.com', 'Open')")).toEqual({
      url: "https://www.google.com",
      label: "Open",
    });
    expect(value("get_link_url(button('a' + 'b', 'l' + 'a'))")).toBe("ab");
    expect(value("get_link_label(button('1', 'l'))")).toBe("l");
    expect(value("get_link_label(link('1'))")).toBeNull();
    expect(value("link('https://www.google.com') = link('https://www.google.com')")).toBe(true);
    expect(value("button('https://www.google.com', 'Google') = button('https://www.google.com', 'Google2')")).toBe(false);
  });

  it("supports Baserow internal select and JSON extraction helpers used by formula casts", () => {
    const fields = {
      Status: { id: 1, value: "Todo", color: "blue" },
      SerializedStatus: JSON.stringify({ id: 2, value: "Done", color: "green" }),
      Nested: JSON.stringify({ value: { name: "Nested Todo" }, items: [{ label: "First" }] }),
    };

    expect(value("get_single_select_value(field('Status'))", fields)).toBe("Todo");
    expect(value("get_single_select_value(field('SerializedStatus'))", fields)).toBe("Done");
    expect(value("get_single_select_value(null)", fields)).toBeNull();
    expect(value("jsonb_extract_path_text(field('Nested'), 'value', 'name')", fields)).toBe("Nested Todo");
    expect(value("jsonb_extract_path_text(field('Nested'), 'items', '0', 'label')", fields)).toBe("First");
    expect(value("jsonb_extract_path_text(field('Nested'), 'missing')", fields)).toBeNull();
    expect(value("bc_to_null('-0001-01-01')")).toBeNull();
    expect(value("bc_to_null('2026-01-01')")).toBe("2026-01-01");
  });

  it("supports Baserow internal array and many-to-many aggregate helpers", () => {
    const tags = [
      { id: 11, value: "Urgent", color: "red" },
      { id: 12, value: "External", color: "blue" },
    ];
    const collaborators = [
      { id: 21, first_name: "Ada", email: "ada@example.com" },
      { id: 22, first_name: "Grace", email: "grace@example.com" },
    ];
    const fields = {
      Names: ["Tesla", "Apple"],
      SerializedNames: JSON.stringify(["One", "Two"]),
      NestedNames: [["A", "B"], ["C"]],
      Tags: tags,
      SerializedTags: JSON.stringify(tags),
      TagLookups: [tags, [{ id: 13, value: "Internal", color: "green" }]],
      Collaborators: collaborators,
    };

    expect(value("array_agg(field('Names'))", fields)).toEqual([
      { id: 1, value: "Tesla" },
      { id: 2, value: "Apple" },
    ]);
    expect(value("array_agg(field('SerializedNames'))", fields)).toEqual([
      { id: 1, value: "One" },
      { id: 2, value: "Two" },
    ]);
    expect(value("array_agg_no_nesting(field('Names'))", fields)).toEqual(["Tesla", "Apple"]);
    expect(value("array_agg_unnesting(field('NestedNames'))", fields)).toEqual(["A", "B", "C"]);
    expect(value("many_to_many_agg(field('TagLookups'))", fields)).toEqual([
      { id: 1, value: tags },
      { id: 2, value: [{ id: 13, value: "Internal", color: "green" }] },
    ]);
    expect(value("many_to_many_count(field('Tags'))", fields)).toBe(2);
    expect(value("multiple_select_count(field('SerializedTags'))", fields)).toBe(2);
    expect(value("string_agg_many_to_many_values(field('Tags'))", fields)).toBe("Urgent, External");
    expect(value("string_agg_many_to_many_values(field('Collaborators'))", fields)).toBe("Ada, Grace");
    expect(value("string_agg_multiple_select_values(field('SerializedTags'))", fields)).toBe("Urgent, External");
    expect(value("multiple_select_options_agg(field('TagLookups'))", fields)).toEqual([
      { id: 1, value: tags },
      { id: 2, value: [{ id: 13, value: "Internal", color: "green" }] },
    ]);
  });

  it("aggregates and filters array values like Baserow lookup formulas", () => {
    const fields = {
      Numbers: [5, null, 7, 3],
      Names: ["Alice", "Bob", "Carol"],
      Checks: [true, false, true],
      Tags: [
        { id: 1, value: "Urgent", color: "red" },
        { id: 2, value: "External", color: "blue" },
      ],
      SerializedTags: JSON.stringify([{ id: 3, value: "Serialized", color: "green" }]),
      Links: [
        { url: "https://example.com/a", label: "A" },
        { url: "https://example.com/b", label: null },
      ],
    };

    expect(value("sum(field('Numbers'))", fields)).toBe(15);
    expect(value("avg(field('Numbers'))", fields)).toBe(5);
    expect(value("max(filter(field('Numbers'), field('Checks')))", fields)).toBe(7);
    expect(value("count(filter(field('Names'), field('Checks')))", fields)).toBe(2);
    expect(value("join(filter(field('Names'), field('Checks')), ',')", fields)).toBe("Alice,Carol");
    expect(value("join(field('Links'), ';')", fields)).toBe("A (https://example.com/a);https://example.com/b");
    expect(value("any(field('Checks'))", fields)).toBe(true);
    expect(value("every(field('Checks'))", fields)).toBe(false);
    expect(value("any(field('Names') = 'Bob')", fields)).toBe(true);
    expect(value("every(field('Names') != 'Missing')", fields)).toBe(true);
    expect(value("join(filter(field('Names'), field('Names') != 'Bob'), ',')", fields)).toBe("Alice,Carol");
    expect(value("join(filter(field('Names') + '!', contains(field('Names'), 'B')), ',')", fields)).toBe("Bob!");
    expect(value("join(filter(field('Names'), length(field('Names')) > 3), ',')", fields)).toBe("Alice,Carol");
    expect(value("sum(filter(field('Numbers'), field('Numbers') > 4))", fields)).toBe(12);
    expect(value("any(not(field('Checks')))", fields)).toBe(true);
    expect(value("has_option(field('Tags'), 'Urgent')", fields)).toBe(true);
    expect(value("has_option(field('SerializedTags'), 'Serialized')", fields)).toBe(true);
    expect(value("has_option(field('Tags'), 'Missing')", fields)).toBe(false);
    expect(value("stddev_pop(field('Numbers'))", fields)).toBeCloseTo(1.63299, 5);
  });

  it("resolves Baserow row_id() formulas from the current row context", async () => {
    expect(value("row_id()", { __row_id: 42 })).toBe(42);

    const fields: FieldMeta[] = [
      { id: 1, name: "Name", type: "text", primary: true },
      {
        id: 2,
        name: "Identifier",
        type: "formula",
        primary: false,
        readOnly: true,
        formula: "concat('Row ', row_id())",
      },
    ];
    const row = { id: 99, order: 10000, field_1: "Alpha" };
    const serialized = await serializeRowWithComputedFields({} as any, row, fields);
    expect(serialized.field_2).toBe("Row 99");
  });

  it("extracts Baserow file metadata with index and get_file helpers", () => {
    const fields = {
      Files: [
        {
          visible_name: "Contract.pdf",
          original_name: "stored-contract.pdf",
          name: "stored-contract.pdf",
          size: 1234,
          mime_type: "application/pdf",
          is_image: false,
        },
        {
          visible_name: "Photo.png",
          name: "photo.png",
          size: "68",
          mime_type: "image/png",
          image_width: 640,
          image_height: "480",
        },
      ],
    };

    expect(value("get_file_count(field('Files'))", fields)).toBe(2);
    expect(value("get_file_visible_name(index(field('Files'), 0))", fields)).toBe("Contract.pdf");
    expect(value("get_file_mime_type(index(field('Files'), 1))", fields)).toBe("image/png");
    expect(value("get_file_size(index(field('Files'), 0))", fields)).toBe(1234);
    expect(value("get_image_width(index(field('Files'), 1))", fields)).toBe(640);
    expect(value("get_image_height(index(field('Files'), 1))", fields)).toBe(480);
    expect(value("is_image(index(field('Files'), 1))", fields)).toBe(true);
    expect(value("is_image(index(field('Files'), 0))", fields)).toBe(false);
  });

  it("reads file helpers when file cells are stored as JSON strings", () => {
    const fields = {
      Files: JSON.stringify([
        {
          visible_name: "Image.jpg",
          size: 2048,
          mime_type: "image/jpeg",
          image_width: 1200,
          image_height: 800,
        },
      ]),
    };

    expect(value("get_file_count(field('Files'))", fields)).toBe(1);
    expect(value("get_file_visible_name(index(field('Files'), 0))", fields)).toBe("Image.jpg");
    expect(value("is_image(index(field('Files'), 0))", fields)).toBe(true);
  });
});
