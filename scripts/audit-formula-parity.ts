import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { evaluateFormula } from "../src/services/formula-engine";
import { inferFormulaNumberDecimalPlaces, validateFormulaType } from "../src/services/formula-types";

// Formulas with their expected results (valid) or expected rejection (invalid).
const fixtures = JSON.parse(readFileSync(path.join(process.cwd(), "tests/cases/formula_results.json"), "utf8")) as {
  valid: Array<[string, unknown]>;
  invalid: Array<[string, string, string | null]>;
};

const numericText = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const failures: Array<Record<string, unknown>> = [];

for (const [formula, expected] of fixtures.valid) {
  const result = evaluateFormula(formula, {});
  let normalized = result.value;
  if (
    typeof result.value === "number" &&
    Number.isFinite(result.value) &&
    typeof expected === "string" &&
    numericText.test(expected)
  ) {
    normalized = result.value.toFixed(inferFormulaNumberDecimalPlaces(formula));
  }
  const matches = expected === "NaN"
    ? Number.isNaN(result.value)
    : result.error === null && isDeepStrictEqual(normalized, expected);
  if (!matches) failures.push({ formula, expected, actual: result.value, normalized, error: result.error });
}

for (const [formula] of fixtures.invalid) {
  const result = validateFormulaType(formula);
  if (result.formula_type !== "invalid") {
    failures.push({ formula, expected: "invalid", actual: result.formula_type, error: result.formula_type_error });
  }
}

const fixtureCount = fixtures.valid.length + fixtures.invalid.length;

if (failures.length > 0) {
  console.error(`Formula audit failed: ${failures.length}/${fixtureCount} cases differ.`);
  for (const failure of failures.slice(0, 20)) console.error(JSON.stringify(failure));
  process.exit(1);
}

console.log("Formula parity audit passed.");
console.log(`- valid source fixtures: ${fixtures.valid.length}`);
console.log(`- invalid source fixtures: ${fixtures.invalid.length}`);
console.log(`- matched: ${fixtureCount}`);
