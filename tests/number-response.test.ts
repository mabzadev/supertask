import { describe, expect, it } from "vitest";
import type { FieldMeta } from "../src/services/dynamic-tables";
import { serializeFieldValueForResponse, serializeRow } from "../src/services/dynamic-tables";

function numberField(settings: Record<string, unknown> = {}): FieldMeta {
  return {
    id: 1,
    name: "Amount",
    type: "number",
    primary: false,
    settings: { number_decimal_places: 2, ...settings },
  };
}

describe("Baserow numeric response serialization", () => {
  it("preserves exact stored decimals beyond JavaScript safe integer precision", () => {
    expect(serializeFieldValueForResponse(numberField({ number_decimal_places: 5 }), "n:9007199254740993.125"))
      .toBe("9007199254740993.12500");
  });

  it("returns fixed decimal strings for number, formula, rollup, and count fields", () => {
    expect(serializeFieldValueForResponse(numberField(), "n:10.2")).toBe("10.20");
    expect(serializeFieldValueForResponse({
      ...numberField({ formula_type: "number", number_decimal_places: 5 }),
      type: "formula",
    }, 0.25)).toBe("0.25000");
    expect(serializeFieldValueForResponse({
      ...numberField({ formula_type: "number", number_decimal_places: 1 }),
      type: "rollup",
    }, "n:12.34")).toBe("12.3");
    expect(serializeFieldValueForResponse({
      ...numberField({ formula_type: "number", number_decimal_places: 0 }),
      type: "count",
    }, 3)).toBe("3");
  });

  it("keeps integer and seconds response types for rating, autonumber, and duration", () => {
    expect(serializeFieldValueForResponse({ ...numberField(), type: "rating" }, "n:4")).toBe(4);
    expect(serializeFieldValueForResponse({ ...numberField(), type: "autonumber" }, "n:7")).toBe(7);
    expect(serializeFieldValueForResponse({ ...numberField(), type: "duration" }, "n:90.5")).toBe(90.5);
  });

  it("uses the same contract in synchronous builder row serialization", () => {
    expect(serializeRow({ id: 10, order: 10000, field_1: "n:10.2" }, [numberField()]))
      .toMatchObject({ id: 10, field_1: "10.20" });
  });
});
