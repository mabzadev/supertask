import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { addFieldColumn, getOrCreateUserTable, type FieldType } from "../src/services/dynamic-tables";
import { buildApplicationSnapshot, restoreApplicationSnapshot } from "../src/routes/snapshots";
import { duplicateDatabaseTable } from "../src/services/table-duplication";
import {
  applyDateDependencyRules,
  calculateDateDependencyPatch,
  createDateDependencyRule,
  revalidateDateDependencyRules,
  type RuleSettings,
} from "../src/services/field-rules";

function createD1() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0001_initial.sql", "0051_last_password_change.sql", "0006_field_rules_data_sync.sql"]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", migration), "utf8"));
  }
  const db = {
    database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const values = (args: unknown[]) => args.map((value) => value === undefined ? null : value);
      return {
        bind(...args: unknown[]) {
          return {
            all: async () => ({ results: statement.all(...values(args)) }),
            first: async <T = any>() => (statement.get(...values(args)) || null) as T | null,
            run: async () => statement.run(...values(args)),
          };
        },
        all: async () => ({ results: statement.all() }),
        first: async <T = any>() => (statement.get() || null) as T | null,
        run: async () => statement.run(),
      };
    },
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
  };
  return db;
}

const settings: RuleSettings = {
  start_date_field_id: 31,
  end_date_field_id: 32,
  duration_field_id: 33,
  dependency_linkrow_field_id: 34,
  dependency_linkrow_role: "predecessors",
  dependency_connection_type: "end-to-start",
  dependency_buffer_type: "flexible",
  dependency_buffer: 0,
  include_weekends: true,
};

async function setupTable() {
  const db = createD1();
  const now = "2026-07-11T00:00:00.000Z";
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)").bind(now).run();
  await db.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
     VALUES (20, 10, 'Plan', 1, 1, 0, ?, ?)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  const fields: Array<[number, string, FieldType, Record<string, unknown>]> = [
    [30, "Name", "text", {}],
    [31, "Start", "date", { date_include_time: false }],
    [32, "End", "date", { date_include_time: false }],
    [33, "Duration", "duration", { duration_format: "d h" }],
    [34, "Predecessors", "link_row", { link_row_table_id: 20, link_row_multiple_relationships: true }],
  ];
  for (const [index, [id, name, type, fieldSettings]] of fields.entries()) {
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on,
        db_index, immutable_type, immutable_properties)
       VALUES (?, 20, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 0, 0)`
    ).bind(id, name, type, index + 1, index === 0 ? 1 : 0, JSON.stringify(fieldSettings), now, now, index === 0 ? 1 : 0).run();
    await addFieldColumn(db as any, 20, { id, type, primary: index === 0 });
  }
  await createDateDependencyRule(db as any, 20, { type: "date_dependency", is_active: true, ...settings });
  return db;
}

describe("date dependency parity", () => {
  it("matches Baserow date calculator decisions and duration storage", () => {
    expect(calculateDateDependencyPatch({
      field_31: "2026-07-01",
      field_32: null,
      field_33: "n:259200",
    }, settings, new Set([31, 33]))).toEqual({ field_32: "2026-07-03" });

    expect(calculateDateDependencyPatch({
      field_31: "2026-07-10",
      field_32: "2026-07-03",
      field_33: "n:259200",
    }, settings, new Set([32]))).toEqual({ field_31: "2026-07-01" });

    expect(calculateDateDependencyPatch({
      field_31: "2026-07-01",
      field_32: "2026-07-10",
      field_33: null,
    }, settings, new Set([31, 32]))).toEqual({ field_33: "n:864000" });

    expect(calculateDateDependencyPatch({
      field_31: null,
      field_32: "2026-07-10",
      field_33: "n:259200",
    }, settings, new Set([31]))).toEqual({ field_33: null });

    expect(calculateDateDependencyPatch({
      field_31: "2026-07-01",
      field_32: "2026-07-03",
      field_33: "n:3600",
    }, settings, new Set([33]))).toEqual({ field_33: "n:0" });

    expect(calculateDateDependencyPatch({
      field_31: "2026-07-01",
      field_32: "2026-07-03",
      field_33: "n:259200",
    }, settings, new Set([31, 32, 33]))).toEqual({});
  });

  it("cascades overlapping predecessor schedules through the complete dependency chain", async () => {
    const db = await setupTable();
    const insert = async (id: number, start: string, end: string, duration: number, predecessors: number[]) => {
      await db.prepare(
        `INSERT INTO "database_table_20"
         (id, [order], "field_30", "field_31", "field_32", "field_33", "field_34")
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, id * 1000, `Task ${id}`, start, end, `n:${duration * 86400}`, JSON.stringify(predecessors.map((parent) => ({ id: parent, value: `Task ${parent}` })))).run();
    };
    await insert(1, "2026-07-01", "2026-07-04", 3, []);
    await insert(2, "2026-07-03", "2026-07-05", 3, [1]);
    await insert(3, "2026-07-04", "2026-07-06", 3, [2]);

    await applyDateDependencyRules(db as any, 20, 1, new Set([32]));
    const rows = await db.prepare(
      `SELECT id, "field_31" start, "field_32" end, "field_33" duration, field_rules_are_valid valid
       FROM "database_table_20" ORDER BY id`
    ).all();

    expect(rows.results).toEqual([
      { id: 1, start: "2026-07-01", end: "2026-07-04", duration: "n:345600", valid: 1 },
      { id: 2, start: "2026-07-05", end: "2026-07-07", duration: "n:259200", valid: 1 },
      { id: 3, start: "2026-07-08", end: "2026-07-10", duration: "n:259200", valid: 1 },
    ]);
  });

  it("rejects date dependency fields that violate the source field constraints", async () => {
    const db = await setupTable();
    await db.prepare("DELETE FROM database_fieldrule WHERE table_id=20").run();
    await db.prepare("UPDATE database_field SET field_settings=? WHERE id=31")
      .bind(JSON.stringify({ date_include_time: true }))
      .run();

    await expect(createDateDependencyRule(db as any, 20, {
      type: "date_dependency",
      is_active: true,
      ...settings,
    })).rejects.toThrow("start_date_field_id must not include time");
  });

  it("marks an existing rule invalid when a referenced field becomes incompatible", async () => {
    const db = await setupTable();
    await db.prepare("UPDATE database_field SET field_settings=? WHERE id=33")
      .bind(JSON.stringify({ duration_format: "h:mm" }))
      .run();

    await revalidateDateDependencyRules(db as any, 20);
    const rule = await db.prepare("SELECT is_valid, error_text FROM database_fieldrule WHERE table_id=20").first<any>();
    expect(rule.is_valid).toBe(0);
    expect(rule.error_text).toContain("duration format must be 'd h'");
  });

  it("roundtrips remapped rules through snapshots and direct table duplication", async () => {
    const db = await setupTable();
    const sourceFieldIds = new Set([31, 32, 33, 34]);
    const assertRemappedRule = async (tableId: number) => {
      const rule = await db.prepare("SELECT is_valid, settings FROM database_fieldrule WHERE table_id=?").bind(tableId).first<any>();
      expect(rule.is_valid).toBe(1);
      const restoredSettings = JSON.parse(rule.settings);
      const ids = [
        restoredSettings.start_date_field_id,
        restoredSettings.end_date_field_id,
        restoredSettings.duration_field_id,
        restoredSettings.dependency_linkrow_field_id,
      ];
      expect(ids.every((id) => Number.isInteger(id) && !sourceFieldIds.has(id))).toBe(true);
      const fields = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND trashed=0").bind(tableId).all<any>();
      const fieldIds = new Set(fields.results.map((field) => field.id));
      expect(ids.every((id) => fieldIds.has(id))).toBe(true);
    };

    const snapshot = await buildApplicationSnapshot(db as any, 10);
    expect(snapshot.tables[0].field_rules).toHaveLength(1);
    const restoredApp = await restoreApplicationSnapshot(db as any, { id: 999, name: "Restored" }, snapshot, {
      targetWorkspaceId: 1,
      name: "Restored",
    });
    const restoredTable = await db.prepare("SELECT id FROM database_table WHERE database_id=?").bind(restoredApp.id).first<any>();
    await assertRemappedRule(restoredTable.id);

    const duplicated = await duplicateDatabaseTable(db as any, 20, { name: "Plan copy" });
    await assertRemappedRule(duplicated.duplicatedTable.id);
  });
});
