import { describe, expect, it } from "vitest";
import { aggregateRollupValues } from "../src/services/computed-fields";
import { airtableRollupSettings } from "../src/services/airtable-import";

describe("Supertask and Airtable rollup contracts", () => {
  it("counts every linked row for the native Supertask count rollup", () => {
    expect(aggregateRollupValues([null, "", 0, false, "value"], { rollup_function: "count" })).toBe(5);
  });

  it("maps every documented Airtable rollup function to a valid Supertask editor value", () => {
    const cases = [
      ["AND(values)", "every", "and"],
      ["ARRAYCOMPACT(values)", "max", "array_compact"],
      ["ARRAYFLATTEN(values)", "max", "array_flatten"],
      ['ARRAYJOIN(values, "; ")', "max", "array_join"],
      ["ARRAYSLICE(values, -2)", "max", "array_slice"],
      ["ARRAYUNIQUE(values)", "max", "array_unique"],
      ["AVERAGE(values)", "avg", undefined],
      ["CONCATENATE(values)", "max", "concatenate"],
      ["COUNT(values)", "count", "numeric_count"],
      ["COUNTA(values)", "count", "not_empty_count"],
      ["COUNTALL(values)", "count", "count_all"],
      ["MAX(values)", "max", undefined],
      ["MIN(values)", "min", undefined],
      ["OR(values)", "any", "or"],
      ["SUM(values)", "sum", undefined],
      ["XOR(values)", "any", "xor"],
    ] as const;
    const supertaskFunctions = new Set(["any", "every", "count", "sum", "avg", "min", "max"]);

    for (const [formula, rollupFunction, airtableMode] of cases) {
      const settings = airtableRollupSettings(formula, "number");
      expect(settings.rollup_function, formula).toBe(rollupFunction);
      expect(supertaskFunctions.has(String(settings.rollup_function)), formula).toBe(true);
      expect(settings.airtable_rollup_function, formula).toBe(airtableMode);
    }
  });

  it("executes Airtable-specific count and boolean rollups without losing empty values", () => {
    const mixed = [null, "", 1, "n:2", "3.5", "text"];
    expect(aggregateRollupValues(mixed, { airtable_rollup_function: "count_all" })).toBe(6);
    expect(aggregateRollupValues(mixed, { airtable_rollup_function: "not_empty_count" })).toBe(4);
    expect(aggregateRollupValues(mixed, { airtable_rollup_function: "numeric_count" })).toBe(3);
    expect(aggregateRollupValues([1, 1, "1", 2], { airtable_rollup_function: "unique_count" })).toBe(3);
    expect(aggregateRollupValues([], { airtable_rollup_function: "and" })).toBe(true);
    expect(aggregateRollupValues([], { airtable_rollup_function: "or" })).toBe(false);
    expect(aggregateRollupValues([true, false, true], { airtable_rollup_function: "xor" })).toBe(false);
    expect(aggregateRollupValues([true, false, false], { airtable_rollup_function: "xor" })).toBe(true);
  });

  it("executes Airtable array rollups including nested compact/join and slices", () => {
    expect(aggregateRollupValues([1, "", null, 2], { airtable_rollup_function: "array_compact" })).toEqual([1, 2]);
    expect(aggregateRollupValues([[1, 2], [3, [4]]], { airtable_rollup_function: "array_flatten" })).toEqual([1, 2, 3, 4]);
    expect(aggregateRollupValues(["a", "", null, "b"], {
      airtable_rollup_function: "array_join",
      airtable_rollup_separator: "; ",
      airtable_rollup_compact: true,
    })).toBe("a; b");
    expect(aggregateRollupValues(["a", "b", "a"], { airtable_rollup_function: "array_unique" })).toEqual(["a", "b"]);
    expect(aggregateRollupValues(["a", "b", "c", "d"], {
      airtable_rollup_function: "array_slice",
      airtable_rollup_slice_start: 2,
      airtable_rollup_slice_end: 3,
    })).toEqual(["b", "c"]);
    expect(aggregateRollupValues(["a", "b", "c", "d"], {
      airtable_rollup_function: "array_slice",
      airtable_rollup_slice_start: -2,
      airtable_rollup_slice_end: null,
    })).toEqual(["c", "d"]);
    expect(aggregateRollupValues(["a", null, "b"], { airtable_rollup_function: "concatenate" })).toBe("ab");
  });

  it("extracts Airtable join and slice arguments into stable field settings", () => {
    expect(airtableRollupSettings('ARRAYJOIN(ARRAYCOMPACT(values), "\\n")', "text")).toMatchObject({
      rollup_function: "max",
      airtable_rollup_function: "array_join",
      airtable_rollup_separator: "\n",
      airtable_rollup_compact: true,
      formula_type: "text",
    });
    expect(airtableRollupSettings("ARRAYSLICE(values, -3, -1)", "text")).toMatchObject({
      rollup_function: "max",
      airtable_rollup_function: "array_slice",
      airtable_rollup_slice_start: -3,
      airtable_rollup_slice_end: -1,
      formula_type: "array",
      array_formula_type: "text",
    });
  });
});
