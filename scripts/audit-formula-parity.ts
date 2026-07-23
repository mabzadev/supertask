import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { evaluateFormula } from "../src/services/formula-engine";
import { inferFormulaNumberDecimalPlaces, validateFormulaType } from "../src/services/formula-types";

const sourceRoot = process.env.BASEROW_SOURCE_ROOT || "/Users/appmonster/Workspace/baserow";
const fixturePath = path.join(
  sourceRoot,
  "backend/tests/baserow/contrib/database/formula/test_baserow_formula_results.py"
);

const extractor = String.raw`
import ast, json, sys
from types import SimpleNamespace
path = sys.argv[1]
tree = ast.parse(open(path, encoding="utf-8").read())
def assignment(name):
    return next(
        node for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)
    )
scope = {
    "settings": SimpleNamespace(MAX_FORMULA_STRING_LENGTH=10000),
    "sys": sys,
}
def value(name):
    node = assignment(name)
    return eval(compile(ast.Expression(node.value), path, "eval"), scope)
print(json.dumps({
    "valid": value("VALID_FORMULA_TESTS"),
    "invalid": value("INVALID_FORMULA_TESTS"),
}, ensure_ascii=False))
`;

const fixtures = JSON.parse(execFileSync("python3", ["-c", `import sys\n${extractor}`, fixturePath], {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
})) as {
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
  console.error(`Formula parity audit failed: ${failures.length}/${fixtureCount} source fixtures differ.`);
  for (const failure of failures.slice(0, 20)) console.error(JSON.stringify(failure));
  process.exit(1);
}

console.log("Formula parity audit passed.");
console.log(`- valid source fixtures: ${fixtures.valid.length}`);
console.log(`- invalid source fixtures: ${fixtures.invalid.length}`);
console.log(`- matched: ${fixtureCount}`);
