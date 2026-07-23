import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addFieldColumn, getOrCreateUserTable, serializeFieldValueForInsert, type FieldType } from "../src/services/dynamic-tables";
import { queryViewRows } from "../src/services/view-query";

type TestD1 = {
  database: DatabaseSync;
  prepare(sql: string): {
    bind(...args: unknown[]): { all(): Promise<{ results: any[] }>; first<T = any>(): Promise<T | null>; run(): Promise<object> };
    all(): Promise<{ results: any[] }>;
    first<T = any>(): Promise<T | null>;
    run(): Promise<object>;
  };
};

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_initial.sql", "0020_view_filter_groups.sql"]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
  return {
    database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const executeAll = (args: unknown[]) => Promise.resolve({ results: statement.all(...args.map(d1Value)) });
      const executeFirst = <T = any>(args: unknown[]) => Promise.resolve((statement.get(...args.map(d1Value)) || null) as T | null);
      const executeRun = (args: unknown[]) => Promise.resolve(statement.run(...args.map(d1Value)));
      return {
        bind(...args: unknown[]) {
          return {
            all: () => executeAll(args),
            first: <T = any>() => executeFirst<T>(args),
            run: () => executeRun(args),
          };
        },
        all: () => executeAll([]),
        first: <T = any>() => executeFirst<T>([]),
        run: () => executeRun([]),
      };
    },
  };
}

async function setupDateViewFixture(filterType: string, value: string, rowDates = ["2025-01-14", "2025-01-15", "2025-01-16"]) {
  const db = createTestD1();
  const now = "2026-05-28T10:00:00.000Z";
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)").bind(now).run();
  await db.prepare("INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on) VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)").bind(now, now).run();
  await db.prepare(`INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
    needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
    VALUES (20, 10, 'Rows', 1, 1, 0, ?, ?, 0, 0, 0)`).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await db.prepare(`INSERT INTO database_field
    (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on, db_index,
     immutable_type, immutable_properties)
    VALUES (101, 20, 'Due', 'date', 1, 1, 0, 0, '{}', ?, ?, 1, 0, 0)`).bind(now, now).run();
  await addFieldColumn(db as any, 20, { id: 101, type: "date", primary: true });
  await db.prepare(`INSERT INTO database_view
    (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug, trashed, created_on, updated_on)
    VALUES (301, 20, 'Filtered', 'grid', 1, 'AND', 0, 0, 'filtered', 0, ?, ?)`).bind(now, now).run();
  await db.prepare("INSERT INTO database_viewfilter (view_id, field_id, type, value) VALUES (301, 101, ?, ?)").bind(filterType, value).run();
  for (let index = 0; index < rowDates.length; index++) {
    await db.prepare('INSERT INTO "database_table_20" ([order], _created_on, _updated_on, "field_101") VALUES (?, ?, ?, ?)')
      .bind((index + 1) * 10000, now, now, rowDates[index])
      .run();
  }
  return { db, view: { id: 301, table_id: 20, filter_type: "AND", filters_disabled: 0 } };
}

async function setupSingleFieldViewFixture(
  fieldType: FieldType,
  filterType: string,
  filterValue: string,
  rowValues: unknown[],
  fieldSettings: Record<string, unknown> = {}
) {
  const db = createTestD1();
  const now = "2026-05-28T10:00:00.000Z";
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)").bind(now).run();
  await db.prepare("INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on) VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)").bind(now, now).run();
  await db.prepare(`INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
    needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
    VALUES (20, 10, 'Rows', 1, 1, 0, ?, ?, 0, 0, 0)`).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await db.prepare(`INSERT INTO database_field
    (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on, db_index,
     immutable_type, immutable_properties)
    VALUES (101, 20, 'Value', ?, 1, 1, 0, 0, ?, ?, ?, 1, 0, 0)`)
    .bind(fieldType, JSON.stringify(fieldSettings), now, now)
    .run();
  await addFieldColumn(db as any, 20, { id: 101, type: fieldType, primary: true });
  await db.prepare(`INSERT INTO database_view
    (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug, trashed, created_on, updated_on)
    VALUES (301, 20, 'Filtered', 'grid', 1, 'AND', 0, 0, 'filtered', 0, ?, ?)`).bind(now, now).run();
  await db.prepare("INSERT INTO database_viewfilter (view_id, field_id, type, value) VALUES (301, 101, ?, ?)").bind(filterType, filterValue).run();
  for (let index = 0; index < rowValues.length; index++) {
    await db.prepare('INSERT INTO "database_table_20" ([order], _created_on, _updated_on, "field_101") VALUES (?, ?, ?, ?)')
      .bind((index + 1) * 10000, now, now, serializeFieldValueForInsert(fieldType, rowValues[index]))
      .run();
  }
  return { db, view: { id: 301, table_id: 20, filter_type: "AND", filters_disabled: 0 } };
}

async function setupNamedFieldViewFixture() {
  const db = createTestD1();
  const now = "2026-05-28T10:00:00.000Z";
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)").bind(now).run();
  await db.prepare("INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on) VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)").bind(now, now).run();
  await db.prepare(`INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
    needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
    VALUES (20, 10, 'Rows', 1, 1, 0, ?, ?, 0, 0, 0)`).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await db.prepare(`INSERT INTO database_field
    (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on, db_index,
     immutable_type, immutable_properties)
    VALUES
    (101, 20, 'Name, Label', 'text', 1, 1, 0, 0, '{}', ?, ?, 1, 0, 0),
    (102, 20, '-Rank', 'number', 2, 0, 0, 0, '{}', ?, ?, 1, 0, 0),
    (103, 20, 'Status__Choice', 'single_select', 3, 0, 0, 0, '{}', ?, ?, 1, 0, 0)`)
    .bind(now, now, now, now, now, now)
    .run();
  await addFieldColumn(db as any, 20, { id: 101, type: "text", primary: true });
  await addFieldColumn(db as any, 20, { id: 102, type: "number", primary: false });
  await addFieldColumn(db as any, 20, { id: 103, type: "single_select", primary: false });
  await db.prepare(
    `INSERT INTO database_selectoption (id, field_id, value, color, [order])
     VALUES (11, 103, 'Todo', 'blue', 1), (12, 103, 'Done', 'green', 2)`
  ).run();
  await db.prepare(`INSERT INTO database_view
    (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug, trashed, created_on, updated_on)
    VALUES (301, 20, 'Filtered', 'grid', 1, 'AND', 0, 0, 'filtered', 0, ?, ?)`).bind(now, now).run();
  const rows = [
    ["Beta", 2, { id: 11, value: "Todo", color: "blue" }],
    ["Alpha", 1, { id: 12, value: "Done", color: "green" }],
    ["Alpha", 3, { id: 12, value: "Done", color: "green" }],
  ];
  for (let index = 0; index < rows.length; index++) {
    await db.prepare('INSERT INTO "database_table_20" ([order], _created_on, _updated_on, "field_101", "field_102", "field_103") VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        (index + 1) * 10000,
        now,
        now,
        rows[index][0],
        serializeFieldValueForInsert("number", rows[index][1]),
        serializeFieldValueForInsert("single_select", rows[index][2])
      )
      .run();
  }
  return { db, view: { id: 301, table_id: 20, filter_type: "AND", filters_disabled: 0 } };
}

function dateKey(offsetDays: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

describe("view query filters", () => {
  it("applies Baserow multi-step date filters stored on views", async () => {
    const { db, view } = await setupDateViewFixture("date_is", "Europe/Zurich?2025-01-15?exact_date");
    const result = await queryViewRows(db as any, view, "https://test.local/api/database/views/grid/301/");
    expect(result.rows.map((row) => row.field_101)).toEqual(["2025-01-15"]);
  });

  it("applies Baserow date_is_after using the end bound like Baserow", async () => {
    const { db, view } = await setupDateViewFixture("date_is_after", "Europe/Zurich?2025-01-15?exact_date");
    const result = await queryViewRows(db as any, view, "https://test.local/api/database/views/grid/301/");
    expect(result.rows.map((row) => row.field_101)).toEqual(["2025-01-16"]);
  });

  it("applies legacy relative Baserow date filters stored on views", async () => {
    const { db, view } = await setupDateViewFixture(
      "date_within_days",
      "Europe/Zurich?1",
      [dateKey(-1), dateKey(0), dateKey(1), dateKey(2)]
    );
    const result = await queryViewRows(db as any, view, "https://test.local/api/database/views/grid/301/");
    expect(result.rows.map((row) => row.field_101)).toEqual([dateKey(0), dateKey(1)]);
  });

  it("applies the remaining Baserow registry filters in view row queries", async () => {
    const word = await setupSingleFieldViewFixture("text", "contains_word", "car", ["cart", "red car"]);
    expect((await queryViewRows(word.db as any, word.view, "https://test.local/api/database/views/grid/301/")).rows.map((row) => row.field_101))
      .toEqual(["red car"]);

    const length = await setupSingleFieldViewFixture("text", "length_is_lower_than", "4", ["abcd", "abc"]);
    expect((await queryViewRows(length.db as any, length.view, "https://test.local/api/database/views/grid/301/")).rows.map((row) => row.field_101))
      .toEqual(["abc"]);

    const even = await setupSingleFieldViewFixture(
      "number",
      "is_even_and_whole",
      "",
      [2, 3, 4.5],
      { number_decimal_places: 2, number_negative: true }
    );
    expect((await queryViewRows(even.db as any, even.view, "https://test.local/api/database/views/grid/301/")).rows.map((row) => row.field_101))
      .toEqual(["2.00"]);

    const file = await setupSingleFieldViewFixture("file", "has_file_type", "image", [
      [{ name: "doc.pdf", visible_name: "doc.pdf", mime_type: "application/pdf", is_image: false }],
      [{ name: "photo.png", visible_name: "photo.png", mime_type: "image/png", is_image: true }],
    ]);
    expect((await queryViewRows(file.db as any, file.view, "https://test.local/api/database/views/grid/301/")).rows.map((row) => (row.field_101 as any[])[0].visible_name))
      .toEqual(["photo.png"]);

    const link = await setupSingleFieldViewFixture("link_row", "link_row_contains", "alpha", [
      [{ id: 1, value: "Alpha task" }],
      [{ id: 2, value: "Beta task" }],
    ]);
    expect((await queryViewRows(link.db as any, link.view, "https://test.local/api/database/views/grid/301/")).rows.map((row) => (row.field_101 as any[])[0].id))
      .toEqual([1]);

    const none = await setupSingleFieldViewFixture("multiple_select", "has_none_select_option_equal", "2", [
      [{ id: 1, value: "Alpha" }],
      [{ id: 2, value: "Beta" }],
      [{ id: 3, value: "Gamma" }],
    ]);
    expect((await queryViewRows(none.db as any, none.view, "https://test.local/api/database/views/grid/301/")).rows.map((row) => (row.field_101 as any[])[0].id))
      .toEqual([1, 3]);
  });

  it("applies current-date Baserow filters in view row queries", async () => {
    const { db, view } = await setupDateViewFixture("date_equals_today", "", [dateKey(-1), dateKey(0), dateKey(1)]);
    const result = await queryViewRows(db as any, view, "https://test.local/api/database/views/grid/301/");
    expect(result.rows.map((row) => row.field_101)).toEqual([dateKey(0)]);
  });

  it("limits linked row response items without changing filtering or row counts", async () => {
    const { db, view } = await setupSingleFieldViewFixture("link_row", "link_row_contains", "task", [
      [
        { id: 1, value: "Alpha task" },
        { id: 2, value: "Beta task" },
        { id: 3, value: "Gamma task" },
      ],
    ]);
    const result = await queryViewRows(
      db as any,
      view,
      "https://test.local/api/database/views/grid/301/?limit_linked_items=2"
    );
    expect(result.count).toBe(1);
    expect((result.rows[0].field_101 as any[]).map((item) => item.id)).toEqual([1, 2]);
  });

  it("supports Baserow user_field_names order_by with quoted and signed field names", async () => {
    const { db, view } = await setupNamedFieldViewFixture();
    const result = await queryViewRows(
      db as any,
      view,
      'https://test.local/api/database/views/grid/301/?user_field_names=true&order_by="Name, Label",--Rank'
    );

    expect(result.rows.map((row) => [row.field_101, row.field_102])).toEqual([
      ["Alpha", "3"],
      ["Alpha", "1"],
      ["Beta", "2"],
    ]);
  });

  it("sorts single-select values by configured option order when requested", async () => {
    const { db, view } = await setupNamedFieldViewFixture();
    const result = await queryViewRows(
      db as any,
      view,
      "https://test.local/api/database/views/grid/301/?order_by=field_103[order]"
    );
    expect(result.rows.map((row) => (row.field_103 as any)?.id)).toEqual([11, 12, 12]);
  });

  it("supports Baserow user_field_names direct and serialized filters on view row queries", async () => {
    const { db, view } = await setupNamedFieldViewFixture();
    const direct = await queryViewRows(
      db as any,
      view,
      "https://test.local/api/database/views/grid/301/?user_field_names=true&filter__Name,%20Label__equal=Alpha"
    );
    expect(direct.rows.map((row) => row.field_102)).toEqual(["1", "3"]);

    const filterTree = encodeURIComponent(JSON.stringify({
      filter_type: "AND",
      filters: [{ field: "-Rank", type: "higher_than", value: "1" }],
    }));
    const serialized = await queryViewRows(
      db as any,
      view,
      `https://test.local/api/database/views/grid/301/?user_field_names=true&filters=${filterTree}&filter__Name,%20Label__equal=Alpha`
    );
    expect(serialized.rows.map((row) => row.field_101)).toEqual(["Beta", "Alpha"]);
    expect(serialized.rows.map((row) => row.field_102)).toEqual(["2", "3"]);
  });

  it("applies Baserow include_fields and exclude_fields after filtering, sorting and grouping", async () => {
    const { db, view } = await setupNamedFieldViewFixture();
    const included = await queryViewRows(
      db as any,
      view,
      "https://test.local/api/database/views/grid/301/?include_fields=field_101,field_102"
    );
    expect(Object.keys(included.rows[0]).sort()).toEqual(["field_101", "field_102", "id", "order"]);

    const excludedSorted = await queryViewRows(
      db as any,
      view,
      "https://test.local/api/database/views/grid/301/?order_by=field_102&exclude_fields=field_102"
    );
    expect(excludedSorted.rows.map((row) => row.field_101)).toEqual(["Alpha", "Beta", "Alpha"]);
    expect(excludedSorted.rows.every((row) => !("field_102" in row))).toBe(true);

    const grouped = await queryViewRows(
      db as any,
      view,
      "https://test.local/api/database/views/grid/301/?group_by=field_102&exclude_fields=field_102"
    );
    expect(grouped.rows.every((row) => !("field_102" in row))).toBe(true);
    expect(grouped.groupByMetadata.field_102.map((entry) => entry.field_102)).toEqual(["1", "2", "3"]);

    const includedThenExcluded = await queryViewRows(
      db as any,
      view,
      "https://test.local/api/database/views/grid/301/?include_fields=field_101,field_102&exclude_fields=field_102"
    );
    expect(Object.keys(includedThenExcluded.rows[0]).sort()).toEqual(["field_101", "id", "order"]);
  });
});
