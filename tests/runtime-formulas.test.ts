import { describe, expect, it } from "vitest";
import { evaluateCommonRuntimeFormulaCall } from "../src/services/runtime-formulas";

function runtime(name: string, args: unknown[]) {
  const result = evaluateCommonRuntimeFormulaCall(name, args);
  expect(result.handled).toBe(true);
  return result.value;
}

describe("Baserow common runtime formula helpers", () => {
  it("supports object, array, random and uuid helpers used by Builder and Automation", () => {
    expect(runtime("get_property", [{ email: "ada@example.com" }, "email"])).toBe("ada@example.com");
    expect(runtime("get_property", ['{"email":"ada@example.com"}', "email"])).toBe("ada@example.com");
    expect(runtime("strip", ["  123  "])).toBe("123");
    expect(runtime("to_array", ["a, b, c"])).toEqual(["a", "b", "c"]);
    expect(runtime("at", [["a", "b", "c"], -1])).toBe("c");

    const randomInt = runtime("random_int", [2, 4]);
    expect(Number.isInteger(randomInt)).toBe(true);
    expect(Number(randomInt)).toBeGreaterThanOrEqual(2);
    expect(Number(randomInt)).toBeLessThanOrEqual(4);

    const randomFloat = runtime("random_float", [2, 4]);
    expect(typeof randomFloat).toBe("number");
    expect(Number(randomFloat)).toBeGreaterThanOrEqual(2);
    expect(Number(randomFloat)).toBeLessThan(4);
    expect(typeof runtime("random_bool", [])).toBe("boolean");
    expect(runtime("generate_uuid", [])).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
  });
});
