import { describe, expect, it } from "vitest";
import { applyFilters } from "../src/services/row-filters";
import type { FieldMeta } from "../src/services/dynamic-tables";

describe("row filters", () => {
  it("builds SQL for Baserow multiple collaborator filters", () => {
    const fields: FieldMeta[] = [
      { id: 10, name: "Owner", type: "multiple_collaborators", primary: false },
    ];

    expect(applyFilters("database_table_20", [
      { field_id: 10, type: "multiple_collaborators_has", value: "101,202" },
    ], fields)).toEqual({
      clause: `(("database_table_20"."field_10" LIKE ? OR "database_table_20"."field_10" LIKE ?))`,
      values: [`%"id":101%`, `%"id":202%`],
    });

    expect(applyFilters("database_table_20", [
      { field_id: 10, type: "multiple_collaborators_has_not", value: "101" },
    ], fields)).toEqual({
      clause: `(("database_table_20"."field_10" NOT LIKE ? OR "database_table_20"."field_10" IS NULL))`,
      values: [`%"id":101%`],
    });
  });

  it("builds SQL for Baserow multi-step date filters used by Airtable imports", () => {
    const fields: FieldMeta[] = [
      { id: 11, name: "Due", type: "date", primary: false },
    ];

    expect(applyFilters("database_table_20", [
      { field_id: 11, type: "date_is", value: "Europe/Zurich?2025-01-15?exact_date" },
    ], fields)).toEqual({
      clause: `(("database_table_20"."field_11" >= ? AND "database_table_20"."field_11" < ?))`,
      values: ["2025-01-15", "2025-01-16"],
    });

    expect(applyFilters("database_table_20", [
      { field_id: 11, type: "date_is_after", value: "Europe/Zurich?2025-01-15?exact_date" },
    ], fields)).toEqual({
      clause: `("database_table_20"."field_11" >= ?)`,
      values: ["2025-01-16"],
    });
  });

  it("builds SQL for legacy Baserow date filters", () => {
    const fields: FieldMeta[] = [
      { id: 11, name: "Due", type: "date", primary: false },
    ];
    const currentYear = new Date().getUTCFullYear();

    expect(applyFilters("database_table_20", [
      { field_id: 11, type: "date_equals_years_ago", value: "Europe/Zurich?1" },
    ], fields)).toEqual({
      clause: `(("database_table_20"."field_11" >= ? AND "database_table_20"."field_11" < ?))`,
      values: [`${currentYear - 1}-01-01`, `${currentYear}-01-01`],
    });

    expect(applyFilters("database_table_20", [
      { field_id: 11, type: "date_after_days_ago", value: "Europe/Zurich?7" },
    ], fields).clause).toBe(`("database_table_20"."field_11" >= ?)`);
  });

  it("builds SQL for Baserow link-row contains and file type filters", () => {
    const fields: FieldMeta[] = [
      { id: 12, name: "Related", type: "link_row", primary: false },
      { id: 13, name: "Attachments", type: "file", primary: false },
    ];

    expect(applyFilters("database_table_20", [
      { field_id: 12, type: "link_row_contains", value: "Acme" },
    ], fields)).toEqual({
      clause: `("database_table_20"."field_12" LIKE ?)`,
      values: ["%Acme%"],
    });

    expect(applyFilters("database_table_20", [
      { field_id: 12, type: "link_row_not_contains", value: "Acme" },
    ], fields)).toEqual({
      clause: `(("database_table_20"."field_12" NOT LIKE ? OR "database_table_20"."field_12" IS NULL))`,
      values: ["%Acme%"],
    });

    expect(applyFilters("database_table_20", [
      { field_id: 13, type: "has_file_type", value: "image" },
    ], fields)).toEqual({
      clause: `(("database_table_20"."field_13" LIKE ? OR "database_table_20"."field_13" LIKE ?))`,
      values: [`%"is_image":true%`, `%"mime_type":"image/%`],
    });
  });
});
