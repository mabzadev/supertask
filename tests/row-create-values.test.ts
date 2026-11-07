import { describe, expect, it } from "vitest";
import type { FieldMeta } from "../src/services/dynamic-tables";
import { missingCreateFieldValues } from "../src/services/row-create-values";

function field(id: number, type: FieldMeta["type"], settings: Record<string, unknown> = {}): FieldMeta {
  return { id, name: `${type} ${id}`, type, primary: false, settings };
}

function userDatabase() {
  return {
    prepare() {
      return {
        bind() {
          return {
            first: async () => ({
              id: 7,
              email: "owner@example.com",
              username: "owner@example.com",
              first_name: "Owner",
              last_name: "User",
            }),
          };
        },
      };
    },
  } as any;
}

describe("row creation values", () => {
  it("adds Supertask defaults and generated metadata without overwriting supplied fields", async () => {
    const now = "2026-07-10T20:00:00.000Z";
    const values = await missingCreateFieldValues(userDatabase(), [
      field(1, "text", { text_default: "Ready" }),
      field(2, "number", { number_default: "7.50", number_decimal_places: 2 }),
      field(3, "boolean"),
      field(4, "boolean", { boolean_default: true }),
      field(5, "rating", { max_value: 5 }),
      field(6, "uuid"),
      field(7, "created_on"),
      field(8, "last_modified"),
      field(9, "created_by"),
      field(10, "last_modified_by"),
      field(11, "autonumber"),
    ], new Set([1]), { now, user: 7 });

    expect(values.has(1)).toBe(false);
    expect(values.get(2)).toBe("n:7.50");
    expect(values.get(3)).toBe(0);
    expect(values.get(4)).toBe(1);
    expect(values.get(5)).toBe("n:0");
    expect(values.get(6)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(values.get(7)).toBe(now);
    expect(values.get(8)).toBe(now);
    expect(JSON.parse(String(values.get(9)))).toEqual({
      id: 7,
      name: "Owner User",
      email: "owner@example.com",
    });
    expect(values.get(10)).toBe(values.get(9));
    expect(values.has(11)).toBe(false);
  });

  it("stores anonymous creator fields as null", async () => {
    const values = await missingCreateFieldValues(userDatabase(), [
      field(1, "created_by"),
      field(2, "last_modified_by"),
    ], new Set(), { now: "2026-07-10T20:00:00.000Z" });

    expect(values.get(1)).toBeNull();
    expect(values.get(2)).toBeNull();
  });
});
