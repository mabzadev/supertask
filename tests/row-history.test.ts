import { describe, expect, it } from "vitest";
import type { FieldMeta } from "../src/services/dynamic-tables";
import { changedRowValues, rowFieldValues } from "../src/services/row-history";

describe("row history value serialization", () => {
  it("normalizes history values with the same Baserow cell contract as row responses", () => {
    const fields: FieldMeta[] = [
      { id: 1, name: "Done", type: "boolean", primary: false },
      { id: 2, name: "Amount", type: "number", primary: false },
      { id: 3, name: "Duration", type: "duration", primary: false },
      { id: 4, name: "Links", type: "link_row", primary: false },
      { id: 5, name: "Tags", type: "multiple_select", primary: false },
      { id: 6, name: "Status", type: "single_select", primary: false },
      { id: 7, name: "Created by", type: "created_by", primary: false },
    ];

    expect(rowFieldValues({
      field_1: "false",
      field_2: "",
      field_3: "not-a-duration",
      field_4: JSON.stringify({ id: 1, value: "Wrong shape" }),
      field_5: JSON.stringify([{ id: 10, value: "Ready", color: "light-green" }]),
      field_6: JSON.stringify([{ id: 11, value: "Wrong array" }]),
      field_7: "legacy@example.com",
    }, fields)).toEqual({
      field_1: false,
      field_2: null,
      field_3: null,
      field_4: [],
      field_5: [{ id: 10, value: "Ready", color: "light-green" }],
      field_6: null,
      field_7: null,
    });
  });

  it("compares normalized history values instead of raw legacy storage strings", () => {
    const fields: FieldMeta[] = [
      { id: 1, name: "Done", type: "boolean", primary: false },
      { id: 2, name: "Tags", type: "multiple_select", primary: false },
    ];

    const unchanged = changedRowValues(
      { field_1: "false", field_2: JSON.stringify([{ id: 10, value: "Ready" }]) },
      { field_1: false, field_2: [{ id: 10, value: "Ready" }] },
      fields
    );

    expect(unchanged).toEqual({ before: {}, after: {} });

    const changed = changedRowValues(
      { field_1: "false", field_2: JSON.stringify([{ id: 10, value: "Ready" }]) },
      { field_1: "true", field_2: "not-json" },
      fields
    );

    expect(changed).toEqual({
      before: {
        field_1: false,
        field_2: [{ id: 10, value: "Ready" }],
      },
      after: {
        field_1: true,
        field_2: [],
      },
    });
  });
});
