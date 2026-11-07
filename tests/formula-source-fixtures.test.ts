import { describe, expect, it } from "vitest";
import sourceFixture from "./cases/supertask_formula_source_cases.json";
import { evaluateFormula } from "../src/services/formula-engine";
import {
  mapFieldTypeToFormulaNullable,
  mapFieldTypeToFormulaType,
  validateFormulaType,
} from "../src/services/formula-types";

type SourceCase = {
  formula: string;
  expected: unknown;
};

type InvalidSourceCase = {
  formula: string;
  error: string;
  detail: string | null;
};

type NullableSourceCase = {
  fields: Array<{ type: string; name: string; formula?: string }>;
  formula: string;
  nullable: boolean;
};

function expectSourceValue(actual: unknown, expected: SourceCase["expected"]): void {
  if (expected === "NaN") {
    expect(typeof actual).toBe("number");
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }

  if (typeof expected === "string" && /^-?\d+(?:\.\d+)?$/.test(expected)) {
    if (typeof actual === "string") {
      expect(actual).toBe(expected);
      return;
    }
    expect(typeof actual).toBe("number");
    const decimalPlaces = expected.includes(".") ? expected.split(".")[1].length : 0;
    expect(Number(actual)).toBeCloseTo(Number(expected), decimalPlaces);
    return;
  }

  expect(actual).toEqual(expected);
}

describe("Supertask source formula fixtures", () => {
  it("tracks the complete literal source fixture set", () => {
    expect(sourceFixture.source).toContain("test_supertask_formula_results.py");
    expect(sourceFixture.cases).toHaveLength(283);
    expect(sourceFixture.skipped_non_literal_cases).toHaveLength(0);
  });

  it.each(sourceFixture.cases as SourceCase[])("evaluates $formula", ({ formula, expected }) => {
    const result = evaluateFormula(formula, {});
    expect(result.error).toBeNull();
    expectSourceValue(result.value, expected);
  });

  it.each(sourceFixture.cases as SourceCase[])("accepts valid formula type %#", ({ formula }) => {
    expect(validateFormulaType(formula)).toMatchObject({
      formula_type_error: null,
    });
  });

  it("tracks the complete invalid source fixture set", () => {
    expect(sourceFixture.invalid_cases).toHaveLength(48);
    expect(sourceFixture.skipped_invalid_cases).toHaveLength(0);
  });

  it.each(sourceFixture.invalid_cases as InvalidSourceCase[])("rejects invalid formula %#", ({ formula }) => {
    expect(validateFormulaType(formula)).toMatchObject({
      formula_type: "invalid",
    });
  });

  it("tracks the complete nullable source fixture set", () => {
    expect(sourceFixture.nullable_cases).toHaveLength(55);
    expect(sourceFixture.skipped_nullable_cases).toHaveLength(0);
  });

  it.each(sourceFixture.nullable_cases as NullableSourceCase[])("infers nullable for source formula %#", ({ fields, formula, nullable }) => {
    const fieldTypes: Record<string, string> = {};
    const fieldNullables: Record<string, boolean> = {};
    for (const field of fields) {
      const settings = field.type === "formula" && field.formula
        ? validateFormulaType(field.formula, fieldTypes, null, fieldNullables)
        : {};
      fieldTypes[field.name.toLowerCase()] = mapFieldTypeToFormulaType(field.type, settings);
      fieldNullables[field.name.toLowerCase()] = field.type === "formula"
        ? Boolean((settings as { nullable?: boolean }).nullable)
        : mapFieldTypeToFormulaNullable(field.type, settings);
    }

    expect(validateFormulaType(formula, fieldTypes, null, fieldNullables)).toMatchObject({
      formula_type_error: null,
      nullable,
    });
  });
});
