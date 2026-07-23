import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { FieldMeta } from "../src/services/dynamic-tables";
import { linkedRowIds, serializeRowWithComputedFields } from "../src/services/computed-fields";

function fakeDb(targetField: { id: number; table_id: number; type: string; name?: string }, targetRows: Record<number, unknown>): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM database_field")) {
                const matchesById = Number(args[0]) === targetField.id && Number(args[1]) === targetField.table_id;
                const matchesByName = String(args[0]).toLowerCase() === String(targetField.name || "").toLowerCase() && Number(args[1]) === targetField.table_id;
                return matchesById || matchesByName
                  ? { id: targetField.id, table_id: targetField.table_id, type: targetField.type, name: targetField.name }
                  : null;
              }
              return null;
            },
            async all() {
              if (sql.includes(`"database_table_${targetField.table_id}"`)) {
                return {
                  results: args.map((id) => ({ id: Number(id), value: targetRows[Number(id)] })),
                };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function fakeComputedTargetDb(): D1Database {
  const targetFields = [
    { id: 7, name: "Base", type: "number", is_primary: 1, read_only: 0, field_settings: null },
    {
      id: 8,
      name: "Doubled",
      type: "formula",
      is_primary: 0,
      read_only: 1,
      field_settings: JSON.stringify({ formula: "field('Base') * 2", formula_type: "number" }),
    },
  ];
  const targetRows: Record<number, Record<string, unknown>> = {
    101: { id: 101, trashed: 0, field_7: 10, field_8: null },
    102: { id: 102, trashed: 0, field_7: 15, field_8: null },
  };
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM database_field")) {
                const id = Number(args[0]);
                const name = String(args[0]).toLowerCase();
                return targetFields.find((field) => field.id === id || field.name.toLowerCase() === name) || null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM database_field")) return { results: targetFields };
              if (sql.includes('FROM "database_table_20"')) {
                return { results: args.map((id) => targetRows[Number(id)]).filter(Boolean) };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("computed Baserow fields", () => {
  const fields: FieldMeta[] = [
    { id: 1, name: "Links", type: "link_row", primary: false, settings: { link_row_table_id: 20 } },
    { id: 2, name: "Linked count", type: "count", primary: false, readOnly: true, settings: { through_field_id: 1, formula_type: "number", number_decimal_places: 0 } },
    { id: 3, name: "Linked names", type: "lookup", primary: false, readOnly: true, settings: { through_field_id: 1, target_field_id: 7 } },
    { id: 4, name: "Total", type: "rollup", primary: false, readOnly: true, settings: { through_field_id: 1, target_field_id: 8, rollup_function: "sum", formula_type: "number", number_decimal_places: 0 } },
  ];

  it("extracts linked row ids from Baserow and API input shapes", () => {
    expect(linkedRowIds(JSON.stringify([{ id: 3, value: "A" }, { id: 4, value: "B" }]))).toEqual([3, 4]);
    expect(linkedRowIds([5, "6", { id: 7 }])).toEqual([5, 6, 7]);
  });

  it("computes count, lookup, and rollup from link_row settings", async () => {
    const row = {
      id: 10,
      order: 10000,
      field_1: JSON.stringify([{ id: 101, value: "A" }, { id: 102, value: "B" }]),
    };

    const lookupResult = await serializeRowWithComputedFields(
      fakeDb({ id: 7, table_id: 20, type: "text" }, { 101: "Alice", 102: "Bob" }),
      row,
      fields.filter((field) => field.id !== 4)
    );
    expect(lookupResult.field_2).toBe("2");
    expect(lookupResult.field_3).toEqual([
      { id: 101, value: "Alice" },
      { id: 102, value: "Bob" },
    ]);

    const rollupResult = await serializeRowWithComputedFields(
      fakeDb({ id: 8, table_id: 20, type: "number" }, { 101: 10, 102: 15 }),
      row,
      fields.filter((field) => field.id !== 3)
    );
    expect(rollupResult.field_4).toBe("25");
  });

  it("resolves Baserow lookup() calls inside formula fields before aggregating", async () => {
    const fieldsWithFormula: FieldMeta[] = [
      ...fields,
      {
        id: 5,
        name: "Lookup sum formula",
        type: "formula",
        primary: false,
        readOnly: true,
        formula: "sum(lookup('Links', 'Amount'))",
      },
      {
        id: 6,
        name: "Lookup join formula",
        type: "formula",
        primary: false,
        readOnly: true,
        formula: "join(lookup('Links', 'Name'), ',')",
      },
    ];
    const row = {
      id: 10,
      order: 10000,
      field_1: JSON.stringify([{ id: 101, value: "A" }, { id: 102, value: "B" }]),
    };

    const sumResult = await serializeRowWithComputedFields(
      fakeDb({ id: 8, table_id: 20, type: "number", name: "Amount" }, { 101: 10, 102: 15 }),
      row,
      fieldsWithFormula.filter((field) => field.id !== 6)
    );
    expect(sumResult.field_5).toBe(25);

    const joinResult = await serializeRowWithComputedFields(
      fakeDb({ id: 7, table_id: 20, type: "text", name: "Name" }, { 101: "Alice", 102: "Bob" }),
      row,
      fieldsWithFormula.filter((field) => field.id !== 5)
    );
    expect(joinResult.field_6).toBe("Alice,Bob");
  });

  it("resolves dependent formulas in dependency order and contains corrupt cycles", async () => {
    const dependentFields: FieldMeta[] = [
      { id: 10, name: "Base", type: "number", primary: true },
      { id: 11, name: "First", type: "formula", primary: false, formula: "field('Base') + 1" },
      { id: 12, name: "Second", type: "formula", primary: false, formula: "field('First') * 2" },
    ];
    const dependent = await serializeRowWithComputedFields({} as D1Database, {
      id: 1,
      field_10: 4,
      field_11: null,
      field_12: null,
    }, dependentFields);
    expect(dependent).toMatchObject({ field_11: 5, field_12: 10 });

    const cyclicFields: FieldMeta[] = [
      { id: 21, name: "Left", type: "formula", primary: false, formula: "field('Right')" },
      { id: 22, name: "Right", type: "formula", primary: false, formula: "field('Left')" },
    ];
    const cyclic = await serializeRowWithComputedFields({} as D1Database, { id: 1 }, cyclicFields);
    expect(cyclic).toMatchObject({ field_21: null, field_22: null });
  });

  it("computes lookup and rollup values when the linked target is a formula", async () => {
    const sourceFields: FieldMeta[] = [
      { id: 1, name: "Links", type: "link_row", primary: true, settings: { link_row_table_id: 20 } },
      { id: 2, name: "Calculated values", type: "lookup", primary: false, settings: { through_field_id: 1, target_field_id: 8 } },
      { id: 3, name: "Calculated total", type: "rollup", primary: false, settings: { through_field_id: 1, target_field_id: 8, rollup_function: "sum" } },
    ];
    const sourceRow = {
      id: 5,
      field_1: JSON.stringify([{ id: 101 }, { id: 102 }]),
    };
    const result = await serializeRowWithComputedFields(fakeComputedTargetDb(), sourceRow, sourceFields);
    expect(result).toMatchObject({
      field_2: [{ id: 101, value: 20 }, { id: 102, value: 30 }],
      field_3: 50,
    });
  });

  it("computes every Baserow rollup aggregate", async () => {
    const row = { id: 10, field_1: JSON.stringify([{ id: 101 }, { id: 102 }, { id: 103 }]) };
    const numericFunctions = ["count", "sum", "avg", "min", "max", "variance_pop", "variance_sample", "stddev_pop", "stddev_sample"];
    const numericFields: FieldMeta[] = [
      { id: 1, name: "Links", type: "link_row", primary: true, settings: { link_row_table_id: 20 } },
      ...numericFunctions.map((rollupFunction, index) => ({
        id: index + 10,
        name: rollupFunction,
        type: "rollup" as const,
        primary: false,
        settings: { through_field_id: 1, target_field_id: 8, rollup_function: rollupFunction },
      })),
    ];
    const numeric = await serializeRowWithComputedFields(
      fakeDb({ id: 8, table_id: 20, type: "number" }, { 101: 10, 102: 20, 103: 30 }),
      row,
      numericFields
    );
    expect(numeric).toMatchObject({ field_10: 3, field_11: 60, field_12: 20, field_13: 10, field_14: 30 });
    expect(numeric.field_15).toBeCloseTo(200 / 3);
    expect(numeric.field_16).toBeCloseTo(100);
    expect(numeric.field_17).toBeCloseTo(Math.sqrt(200 / 3));
    expect(numeric.field_18).toBeCloseTo(10);

    const booleanFields: FieldMeta[] = [
      numericFields[0],
      { id: 20, name: "Any", type: "rollup", primary: false, settings: { through_field_id: 1, target_field_id: 9, rollup_function: "any" } },
      { id: 21, name: "Every", type: "rollup", primary: false, settings: { through_field_id: 1, target_field_id: 9, rollup_function: "every" } },
    ];
    const booleans = await serializeRowWithComputedFields(
      fakeDb({ id: 9, table_id: 20, type: "boolean" }, { 101: 0, 102: 1, 103: 1 }),
      row,
      booleanFields
    );
    expect(booleans).toMatchObject({ field_20: true, field_21: false });
  });
});
