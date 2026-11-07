import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyFilters } from "../src/services/row-filters";
import type { FieldMeta } from "../src/services/dynamic-tables";

const TABLE = "database_table_20";

/** Runs generated clauses against real SQLite, so tests check matches rather than SQL text. */
function rowsTable(columns: Record<string, string>, rows: Array<Record<string, unknown>>) {
  const database = new DatabaseSync(":memory:");
  const names = Object.keys(columns);
  database.exec(`CREATE TABLE "${TABLE}" (id INTEGER PRIMARY KEY, ${names.map((name) => `"${name}" ${columns[name]}`).join(", ")})`);
  const insert = database.prepare(`INSERT INTO "${TABLE}" (id, ${names.map((name) => `"${name}"`).join(", ")}) VALUES (?, ${names.map(() => "?").join(", ")})`);
  for (const row of rows) insert.run(row.id as number, ...names.map((name) => (row[name] ?? null) as any));
  return {
    ids(filter: { clause: string; values: unknown[] }) {
      const where = filter.clause || "1=1";
      return database.prepare(`SELECT id FROM "${TABLE}" WHERE ${where} ORDER BY id`).all(...(filter.values as any[]))
        .map((row: any) => Number(row.id));
    },
  };
}

describe("row filters", () => {
  it("matches multiple collaborator cells by user id", () => {
    const fields: FieldMeta[] = [
      { id: 10, name: "Owner", type: "multiple_collaborators", primary: false },
    ];
    const table = rowsTable({ field_10: "TEXT" }, [
      { id: 1, field_10: JSON.stringify([{ id: 101, name: "Ada" }]) },
      { id: 2, field_10: JSON.stringify([{ id: 202, name: "Bob" }, { id: 5, name: "Eve" }]) },
      { id: 3, field_10: JSON.stringify([{ id: 1010, name: "Prefix" }]) },
      { id: 4, field_10: null },
    ]);
    expect(table.ids(applyFilters(TABLE, [{ field_id: 10, type: "multiple_collaborators_has", value: "101,202" }], fields))).toEqual([1, 2]);
    expect(table.ids(applyFilters(TABLE, [{ field_id: 10, type: "multiple_collaborators_has_not", value: "101" }], fields))).toEqual([2, 3, 4]);
  });

  it("matches select, link and user cells by id instead of text", () => {
    const fields: FieldMeta[] = [
      { id: 20, name: "Status", type: "single_select", primary: false },
      { id: 21, name: "Tags", type: "multiple_select", primary: false },
      { id: 22, name: "Related", type: "link_row", primary: false },
      { id: 23, name: "Created by", type: "created_by", primary: false },
    ];
    const table = rowsTable({ field_20: "TEXT", field_21: "TEXT", field_22: "TEXT", field_23: "TEXT" }, [
      { id: 1, field_20: JSON.stringify({ id: 330, value: "Todo", color: "blue" }), field_21: JSON.stringify([{ id: 330, value: "A" }]), field_22: JSON.stringify([{ id: 5, value: "Five" }]), field_23: JSON.stringify({ id: 5, name: "Ada" }) },
      { id: 2, field_20: JSON.stringify({ id: 331, value: "Done", color: "red" }), field_21: JSON.stringify([{ id: 331, value: "B" }]), field_22: JSON.stringify([{ id: 50, value: "Fifty" }, { id: 512, value: "Big" }]), field_23: JSON.stringify({ id: 50, name: "Bob" }) },
    ]);
    const ids = (type: string, value: string, fieldId: number) => table.ids(applyFilters(TABLE, [{ field_id: fieldId, type, value }], fields));
    expect(ids("single_select_equal", "330", 20)).toEqual([1]);
    expect(ids("single_select_is_any_of", "330,331", 20)).toEqual([1, 2]);
    expect(ids("single_select_is_none_of", "330", 20)).toEqual([2]);
    expect(ids("multiple_select_has", "330", 21)).toEqual([1]);
    expect(ids("multiple_select_has_not", "330", 21)).toEqual([2]);
    expect(ids("link_row_has", "5", 22)).toEqual([1]);
    expect(ids("link_row_has_not", "5", 22)).toEqual([2]);
    expect(ids("user_is", "5", 23)).toEqual([1]);
    expect(ids("user_is_not", "5", 23)).toEqual([2]);
  });

  it("matches text without LIKE so long values and wildcard characters work", () => {
    const fields: FieldMeta[] = [{ id: 30, name: "Notes", type: "long_text", primary: false }];
    const long = "x".repeat(80);
    const table = rowsTable({ field_30: "TEXT" }, [
      { id: 1, field_30: `Visible row ${long}` },
      { id: 2, field_30: "100% done_now" },
      { id: 3, field_30: "invisible" },
    ]);
    const ids = (type: string, value: string) => table.ids(applyFilters(TABLE, [{ field_id: 30, type, value }], fields));
    expect(ids("contains", long)).toEqual([1]);
    expect(ids("contains", "VISIBLE")).toEqual([1, 3]);
    expect(ids("contains", "%")).toEqual([2]);
    expect(ids("contains", "_")).toEqual([2]);
    expect(ids("contains_word", "Visible")).toEqual([1]);
    expect(ids("contains_word", "row")).toEqual([1]);
    expect(ids("doesnt_contain_word", "row")).toEqual([2, 3]);
  });

  it("builds SQL for Supertask multi-step date filters used by Airtable imports", () => {
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

  it("builds SQL for legacy Supertask date filters", () => {
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

  it("matches link-row contains and file type filters", () => {
    const fields: FieldMeta[] = [
      { id: 12, name: "Related", type: "link_row", primary: false },
      { id: 13, name: "Attachments", type: "file", primary: false },
    ];
    const table = rowsTable({ field_12: "TEXT", field_13: "TEXT" }, [
      { id: 1, field_12: JSON.stringify([{ id: 1, value: "Acme Corp" }]), field_13: JSON.stringify([{ name: "a.png", is_image: true, mime_type: "image/png" }]) },
      { id: 2, field_12: JSON.stringify([{ id: 2, value: "Globex" }]), field_13: JSON.stringify([{ name: "b.pdf", is_image: false, mime_type: "application/pdf" }]) },
      { id: 3, field_12: null, field_13: null },
    ]);
    expect(table.ids(applyFilters(TABLE, [{ field_id: 12, type: "link_row_contains", value: "acme" }], fields))).toEqual([1]);
    expect(table.ids(applyFilters(TABLE, [{ field_id: 12, type: "link_row_not_contains", value: "Acme" }], fields))).toEqual([2, 3]);
    expect(table.ids(applyFilters(TABLE, [{ field_id: 13, type: "has_file_type", value: "image" }], fields))).toEqual([1]);
  });
});
