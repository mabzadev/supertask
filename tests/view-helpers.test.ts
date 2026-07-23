import { describe, expect, it } from "vitest";
import { serializeRowForView } from "../src/services/view-helpers";
import type { FieldMeta } from "../src/services/dynamic-tables";

describe("view row serialization", () => {
  it("evaluates formula fields consistently for view payloads", () => {
    const fields: FieldMeta[] = [
      { id: 1, name: "First", type: "text", primary: true },
      { id: 2, name: "Second", type: "text", primary: false },
      { id: 3, name: "Full", type: "formula", primary: false, readOnly: true, formula: "CONCAT({First}, \" \", {Second})" },
    ];
    const row = { id: 10, order: 10000, field_1: "Ada", field_2: "Lovelace", field_3: null };
    expect(serializeRowForView(row, fields).field_3).toBe("Ada Lovelace");
  });

  it("preserves collaborator-style generated user objects", () => {
    const fields: FieldMeta[] = [
      { id: 4, name: "Created by", type: "created_by", primary: false, readOnly: true },
    ];
    const value = { id: 7, name: "admin@example.com", email: "admin@example.com" };
    expect(serializeRowForView({ id: 11, order: 10000, field_4: JSON.stringify(value) }, fields).field_4).toEqual(value);
  });
});
