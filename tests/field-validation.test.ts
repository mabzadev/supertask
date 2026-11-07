import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FieldConfigurationError, validateComputedFieldSettings } from "../src/services/field-validation";
import { fieldTypeDefaults, normalizeFieldSettings } from "../src/services/field-serialization";

function fakeFieldDb(fields: Array<{ id: number; table_id: number; name: string; type: string; field_settings?: string | null }>): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              if (sql.includes("FROM database_field") && sql.includes("table_id=?")) {
                return { results: fields.filter((field) => field.table_id === Number(args[0])) };
              }
              return { results: [] };
            },
            async first() {
              const tableId = Number(args[0]);
              const value = args[1];
              const lookupById = /AND id=\?/.test(sql);
              if (sql.includes("type='link_row'")) {
                return fields.find((field) =>
                  field.table_id === tableId &&
                  field.type === "link_row" &&
                  (lookupById ? field.id === Number(value) : field.name === value)
                ) || null;
              }
              return fields.find((field) =>
                field.table_id === tableId &&
                (lookupById ? field.id === Number(value) : field.name === value)
              ) || null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("computed field setting validation", () => {
  const db = fakeFieldDb([
    { id: 1, table_id: 10, name: "Customer", type: "link_row", field_settings: JSON.stringify({ link_row_table_id: 20 }) },
    { id: 2, table_id: 20, name: "Amount", type: "number" },
    { id: 6, table_id: 20, name: "Active", type: "boolean" },
    { id: 7, table_id: 20, name: "Label", type: "text" },
    { id: 3, table_id: 10, name: "Discount", type: "number" },
    { id: 4, table_id: 10, name: "Self", type: "formula", field_settings: JSON.stringify({ formula: "1", formula_type: "number" }) },
    { id: 5, table_id: 10, name: "Other", type: "formula", field_settings: JSON.stringify({ formula: "field('Self')", formula_type: "number" }) },
  ]);

  it("normalizes count, lookup, and rollup references like Supertask", async () => {
    await expect(validateComputedFieldSettings(db, 10, "count", {}, { through_field_name: "Customer" }))
      .resolves.toMatchObject({ through_field_id: 1, number_decimal_places: 0 });
    await expect(validateComputedFieldSettings(db, 10, "lookup", {}, { through_field_id: 1, target_field_name: "Amount" }))
      .resolves.toMatchObject({
        through_field_id: 1,
        through_field_name: "Customer",
        target_field_id: 2,
        target_field_name: "Amount",
        formula_type: "array",
        array_formula_type: "number",
      });
    await expect(validateComputedFieldSettings(db, 10, "rollup", {}, { through_field_id: 1, target_field_id: 2, rollup_function: "SUM" }))
      .resolves.toMatchObject({ through_field_id: 1, target_field_id: 2, rollup_function: "sum", formula_type: "number", nullable: false });
    await expect(validateComputedFieldSettings(db, 10, "rollup", {}, { through_field_id: 1, target_field_id: 6, rollup_function: "any" }))
      .resolves.toMatchObject({ formula_type: "boolean", nullable: true });
    await expect(validateComputedFieldSettings(db, 10, "rollup", {}, { through_field_id: 1, target_field_id: 7, rollup_function: "max" }))
      .resolves.toMatchObject({ formula_type: "text", nullable: true });
  });

  it("returns Supertask-compatible error codes for invalid computed references", async () => {
    await expect(validateComputedFieldSettings(db, 10, "count", {}, { through_field_id: 999 }))
      .rejects.toMatchObject({ code: "ERROR_INVALID_COUNT_THROUGH_FIELD" } satisfies Partial<FieldConfigurationError>);
    await expect(validateComputedFieldSettings(db, 10, "lookup", {}, { through_field_id: 1, target_field_id: 999 }))
      .rejects.toMatchObject({ code: "ERROR_INVALID_LOOKUP_TARGET_FIELD" } satisfies Partial<FieldConfigurationError>);
    await expect(validateComputedFieldSettings(db, 10, "rollup", {}, { through_field_id: 1, target_field_id: 2, rollup_function: "DOES_NOT_EXIST" }))
      .rejects.toMatchObject({ code: "ERROR_INVALID_ROLLUP_FORMULA_FUNCTION" } satisfies Partial<FieldConfigurationError>);
    await expect(validateComputedFieldSettings(db, 10, "rollup", {}, { through_field_id: 1, target_field_id: 2, rollup_function: "empty_count" }))
      .rejects.toMatchObject({ code: "ERROR_INVALID_ROLLUP_FORMULA_FUNCTION" } satisfies Partial<FieldConfigurationError>);
  });

  it("validates and normalizes simple field settings before they reach the frontend", async () => {
    await expect(validateComputedFieldSettings(db, 10, "number", {}, {
      number_decimal_places: 2,
      number_negative: true,
      number_prefix: "EUR ",
      number_suffix: " paid",
      number_separator: "SPACE_COMMA",
      number_default: "12.50",
    })).resolves.toMatchObject({
      number_decimal_places: 2,
      number_negative: true,
      number_separator: "SPACE_COMMA",
      number_default: "12.50",
    });
    await expect(validateComputedFieldSettings(db, 10, "number", {}, { number_decimal_places: 11 }))
      .rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    await expect(validateComputedFieldSettings(db, 10, "number", {}, { number_separator: "INVALID" }))
      .rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    await expect(validateComputedFieldSettings(db, 10, "rating", {}, { max_value: 0 }))
      .rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    await expect(validateComputedFieldSettings(db, 10, "rating", {}, { style: "triangle" }))
      .rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    await expect(validateComputedFieldSettings(db, 10, "duration", {}, { duration_format: "minutes" }))
      .rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    await expect(validateComputedFieldSettings(db, 10, "date", {}, { date_format: "UK" }))
      .rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    await expect(validateComputedFieldSettings(db, 10, "date", {}, { date_time_format: "13" }))
      .rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    await expect(validateComputedFieldSettings(db, 10, "date", {}, {
      date_include_time: true,
      date_force_timezone_offset: 60,
    })).rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    await expect(validateComputedFieldSettings(db, 10, "date", {}, {
      date_include_time: false,
      date_force_timezone_offset: 60,
    }, 99)).rejects.toMatchObject({ code: "ERROR_REQUEST_BODY_VALIDATION" });
    const shiftedDateSettings = await validateComputedFieldSettings(db, 10, "date", {}, {
      date_include_time: true,
      date_force_timezone: "Europe/Rome",
      date_force_timezone_offset: 60,
    }, 99);
    expect(shiftedDateSettings).toMatchObject({ date_include_time: true, date_force_timezone: "Europe/Rome" });
    expect(shiftedDateSettings.date_force_timezone_offset).toBeUndefined();
    expect(fieldTypeDefaults("number" as any).number_default).toBeNull();
  });

  it("removes Airtable-only rollup state when the user selects a Supertask rollup function", async () => {
    const result = await validateComputedFieldSettings(db, 10, "rollup", {
      through_field_id: 1,
      target_field_id: 2,
      rollup_function: "count",
      airtable_rollup_function: "not_empty_count",
      airtable_rollup_formula: "COUNTA(values)",
      airtable_rollup_separator: "; ",
      airtable_rollup_slice_start: 1,
      airtable_rollup_slice_end: 2,
      airtable_rollup_compact: true,
      airtable_rollup_flatten: true,
      airtable_rollup_unique: true,
    }, {
      rollup_function: "sum",
    });

    expect(result).toMatchObject({ rollup_function: "sum", formula_type: "number" });
    expect(result.airtable_rollup_function).toBeUndefined();
    expect(result.airtable_rollup_formula).toBeUndefined();
    expect(result.airtable_rollup_separator).toBeUndefined();
    expect(result.airtable_rollup_slice_start).toBeUndefined();
    expect(result.airtable_rollup_slice_end).toBeUndefined();
    expect(result.airtable_rollup_compact).toBeUndefined();
    expect(result.airtable_rollup_flatten).toBeUndefined();
    expect(result.airtable_rollup_unique).toBeUndefined();
  });

  it("preserves Airtable rollup state when a full frontend payload keeps the same editor function", async () => {
    const result = await validateComputedFieldSettings(db, 10, "rollup", {
      through_field_id: 1,
      target_field_id: 2,
      rollup_function: "count",
      airtable_rollup_function: "not_empty_count",
      airtable_rollup_formula: "COUNTA(values)",
    }, {
      through_field_id: 1,
      target_field_id: 2,
      rollup_function: "COUNT",
    });

    expect(result).toMatchObject({
      rollup_function: "count",
      airtable_rollup_function: "not_empty_count",
      airtable_rollup_formula: "COUNTA(values)",
    });
  });

  it("validates formula syntax and derives the result type from table fields", async () => {
    await expect(validateComputedFieldSettings(db, 10, "formula", {}, {
      formula: "field('Discount') + 1",
      formula_type: "text",
    })).resolves.toMatchObject({
      formula: "field('Discount') + 1",
      formula_type: "number",
      array_formula_type: null,
      formula_type_error: null,
    });

    await expect(validateComputedFieldSettings(db, 10, "formula", {}, { formula: "upper(1)" }))
      .rejects.toMatchObject({ code: "ERROR_WITH_FORMULA" } satisfies Partial<FieldConfigurationError>);
  });

  it("rejects a formula field referencing itself during update", async () => {
    await expect(validateComputedFieldSettings(
      db,
      10,
      "formula",
      { formula: "1" },
      { formula: "field('Self')" },
      4
    )).rejects.toMatchObject({ code: "ERROR_WITH_FORMULA" } satisfies Partial<FieldConfigurationError>);

    await expect(validateComputedFieldSettings(
      db,
      10,
      "formula",
      { formula: "1" },
      { formula: "field('Other')" },
      4
    )).rejects.toMatchObject({ code: "ERROR_WITH_FORMULA" } satisfies Partial<FieldConfigurationError>);
  });

  it("keeps Supertask formula serializer defaults for computed field types", () => {
    expect(fieldTypeDefaults("count" as any)).toMatchObject({
      through_field_id: null,
      formula_type: "number",
      formula_type_error: null,
      nullable: false,
      number_decimal_places: 0,
    });
    expect(fieldTypeDefaults("lookup" as any)).toMatchObject({
      through_field_id: null,
      target_field_id: null,
      formula_type: "text",
      array_formula_type: null,
      formula_type_error: null,
      nullable: true,
    });
    expect(fieldTypeDefaults("rollup" as any)).toMatchObject({
      through_field_id: null,
      target_field_id: null,
      rollup_function: "count",
      formula_type: "number",
      formula_type_error: null,
      nullable: true,
    });
    expect(normalizeFieldSettings({
      id: 30,
      table_id: 10,
      name: "Count",
      type: "count",
      order: 1,
      field_settings: JSON.stringify({ through_field_id: 1 }),
    })).toMatchObject({
      through_field_id: 1,
      formula_type: "number",
      formula_type_error: null,
      nullable: false,
      number_decimal_places: 0,
    });
  });
});
