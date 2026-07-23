import { describe, expect, it } from "vitest";
import {
  extractLookupReferences,
  inferFormulaNumberDecimalPlaces,
  inferFormulaType,
  mapFieldTypeToFormulaType,
} from "../src/services/formula-types";

describe("Baserow formula type inference", () => {
  it("infers Baserow number decimal places from literals, fields and functions", () => {
    expect(inferFormulaNumberDecimalPlaces("ln(9.0)")).toBe(1);
    expect(inferFormulaNumberDecimalPlaces("sqrt(2.00)")).toBe(2);
    expect(inferFormulaNumberDecimalPlaces("log(125.000, 5)")).toBe(3);
    expect(inferFormulaNumberDecimalPlaces("10 / 3")).toBe(10);
    expect(inferFormulaNumberDecimalPlaces("round(1.12345, 4)")).toBe(4);
    expect(inferFormulaNumberDecimalPlaces("round(1234.5678, -2.999)")).toBe(0);
    expect(inferFormulaNumberDecimalPlaces("field('Amount') + 1", { amount: 4 })).toBe(4);
    expect(inferFormulaNumberDecimalPlaces("field_by_id(8) * 2.0", { field_8: 3 })).toBe(3);
  });

  it("returns registered Baserow formula types for links, buttons, urls and durations", () => {
    expect(inferFormulaType("link('https://example.com')", { url: "https://example.com", label: null }, null))
      .toMatchObject({ formula_type: "link", array_formula_type: null });
    expect(inferFormulaType("button('https://example.com', 'Open')", { url: "https://example.com", label: "Open" }, null))
      .toMatchObject({ formula_type: "button", array_formula_type: null });
    expect(inferFormulaType("tourl('example.com')", "example.com", null))
      .toMatchObject({ formula_type: "url" });
    expect(inferFormulaType("toduration(60)", 60, null))
      .toMatchObject({ formula_type: "duration" });
  });

  it("returns array subtypes for lookup and filter formulas", () => {
    expect(inferFormulaType("lookup('Customer', 'Score')", [], null, {}, "number"))
      .toMatchObject({ formula_type: "array", array_formula_type: "number" });
    expect(inferFormulaType("filter(lookup('Customer', 'Name'), lookup('Customer', 'Active'))", [], null, {}, "text"))
      .toMatchObject({ formula_type: "array", array_formula_type: "text" });
  });

  it("returns Baserow-compatible formula types for file helpers", () => {
    expect(inferFormulaType("get_file_visible_name(index(field('Files'), 0))", "Image.png", null, { files: "file" }))
      .toMatchObject({ formula_type: "text", array_formula_type: null });
    expect(inferFormulaType("get_file_mime_type(index(field('Files'), 0))", "image/png", null, { files: "file" }))
      .toMatchObject({ formula_type: "text", array_formula_type: null });
    expect(inferFormulaType("get_file_count(field('Files'))", 2, null, { files: "file" }))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("get_file_size(index(field('Files'), 0))", 1234, null, { files: "file" }))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("get_image_width(index(field('Files'), 0))", 640, null, { files: "file" }))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("get_image_height(index(field('Files'), 0))", 480, null, { files: "file" }))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("is_image(index(field('Files'), 0))", true, null, { files: "file" }))
      .toMatchObject({ formula_type: "boolean", array_formula_type: null });
  });

  it("returns Baserow-compatible formula types for backend registered helper functions", () => {
    expect(inferFormulaType("row_id()", 1, null))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("has_option(field('Tags'), 'Urgent')", true, null, { tags: "multiple_select" }))
      .toMatchObject({ formula_type: "boolean", array_formula_type: null });
    expect(inferFormulaType("datetime_format(field('Date'), 'YYYY')", "2026", null, { date: "date" }))
      .toMatchObject({ formula_type: "text", array_formula_type: null });
    expect(inferFormulaType("datetime_format_tz(field('Date'), 'YYYY', 'Europe/Amsterdam')", "2026", null, { date: "date" }))
      .toMatchObject({ formula_type: "text", array_formula_type: null });
    expect(inferFormulaType("greater_than(field('Amount'), 2)", true, null, { amount: "number" }))
      .toMatchObject({ formula_type: "boolean", array_formula_type: null });
    expect(inferFormulaType("error_to_nan(does_not_exist())", Number.NaN, null))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("error_to_null(field('Amount'))", null, null, { amount: "number" }))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("error_to_null(field('Closed'))", null, null, { closed: "boolean" }))
      .toMatchObject({ formula_type: "boolean", array_formula_type: null });
  });

  it("matches Baserow type coercion rules for if and when_empty", () => {
    expect(inferFormulaType("if(true, field('Amount'), 0)", 1, null, { amount: "number" }))
      .toMatchObject({ formula_type: "number", formula_type_error: null });
    expect(inferFormulaType("if(true, field('Amount'), 'fallback')", 1, null, { amount: "number" }))
      .toMatchObject({ formula_type: "text", formula_type_error: null });
    expect(inferFormulaType("when_empty(field('Amount'), 0)", 1, null, { amount: "number" }))
      .toMatchObject({ formula_type: "number", formula_type_error: null });
    expect(inferFormulaType("when_empty(field('Amount'), 'fallback')", "fallback", null, { amount: "number" }))
      .toMatchObject({
        formula_type: "invalid",
        formula_type_error: "both inputs for when_empty must be the same type",
      });
  });

  it("returns Baserow-compatible types for internal select and JSON helpers", () => {
    expect(inferFormulaType("get_single_select_value(field('Status'))", "Todo", null, { status: "single_select" }))
      .toMatchObject({ formula_type: "text", array_formula_type: null });
    expect(inferFormulaType("jsonb_extract_path_text(field('Meta'), 'value')", "Todo", null, { meta: "text" }))
      .toMatchObject({ formula_type: "text", array_formula_type: null });
    expect(inferFormulaType("bc_to_null(field('Date'))", "2026-01-01", null, { date: "date" }))
      .toMatchObject({ formula_type: "date", array_formula_type: null });
  });

  it("returns Baserow-compatible types for internal aggregate helpers", () => {
    expect(inferFormulaType("array_agg(field('Name'))", [], null, { name: "text" }))
      .toMatchObject({ formula_type: "array", array_formula_type: "text" });
    expect(inferFormulaType("array_agg_no_nesting(field('Amount'))", [], null, { amount: "number" }))
      .toMatchObject({ formula_type: "array", array_formula_type: "number" });
    expect(inferFormulaType("array_agg_unnesting(lookup('Customer', 'Tags'))", [], null, {}, "multiple_select"))
      .toMatchObject({ formula_type: "array", array_formula_type: "multiple_select" });
    expect(inferFormulaType("many_to_many_agg(field('Tags'))", [], null, { tags: "multiple_select" }))
      .toMatchObject({ formula_type: "array", array_formula_type: "multiple_select" });
    expect(inferFormulaType("multiple_select_options_agg(field('Tags'))", [], null, { tags: "multiple_select" }))
      .toMatchObject({ formula_type: "array", array_formula_type: "multiple_select" });
    expect(inferFormulaType("many_to_many_count(field('Tags'))", 2, null, { tags: "multiple_select" }))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("multiple_select_count(field('Tags'))", 2, null, { tags: "multiple_select" }))
      .toMatchObject({ formula_type: "number", array_formula_type: null });
    expect(inferFormulaType("string_agg_many_to_many_values(field('Tags'))", "Todo", null, { tags: "multiple_select" }))
      .toMatchObject({ formula_type: "text", array_formula_type: null });
    expect(inferFormulaType("string_agg_multiple_select_values(field('Tags'))", "Todo", null, { tags: "multiple_select" }))
      .toMatchObject({ formula_type: "text", array_formula_type: null });
  });

  it("maps field references and formula errors to Baserow-compatible response types", () => {
    expect(inferFormulaType("field('Closed')", true, null, { closed: "boolean" }))
      .toMatchObject({ formula_type: "boolean" });
    expect(inferFormulaType("{Amount}", null, null, { amount: "number" }))
      .toMatchObject({ formula_type: "number", formula_type_error: null });
    expect(inferFormulaType("field_by_id(8)", 10, null, { field_8: "number" }))
      .toMatchObject({ formula_type: "number" });
    expect(inferFormulaType("does_not_exist()", null, "Unknown function: DOES_NOT_EXIST"))
      .toMatchObject({ formula_type: "invalid", formula_type_error: "Unknown function: DOES_NOT_EXIST" });
  });

  it("maps Baserow field types and extracts lookup references", () => {
    expect(mapFieldTypeToFormulaType("url")).toBe("url");
    expect(mapFieldTypeToFormulaType("multiple_select")).toBe("multiple_select");
    expect(mapFieldTypeToFormulaType("formula", { formula_type: "array", array_formula_type: "date" })).toBe("date");
    expect(extractLookupReferences("sum(lookup('Links', 'Amount'))")).toEqual([
      { throughFieldName: "Links", targetFieldName: "Amount" },
    ]);
  });
});
