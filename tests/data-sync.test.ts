import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const pgMock = vi.hoisted(() => {
  const state = {
    clients: [] as any[],
    queries: [] as Array<{ sql: string; params?: unknown[] }>,
    selectRows: [] as any[],
    primaryColumns: ["id"] as string[],
    connectError: null as Error | null,
    reset() {
      state.clients = [];
      state.queries = [];
      state.selectRows = [];
      state.primaryColumns = ["id"];
      state.connectError = null;
    },
  };
  return state;
});

vi.mock("pg", () => ({
  Client: class MockPostgresClient {
    config: any;

    constructor(config: any) {
      this.config = config;
      pgMock.clients.push(this);
    }

    async connect() {
      if (pgMock.connectError) throw pgMock.connectError;
    }

    async end() {}

    async query(sql: string, params?: unknown[]) {
      pgMock.queries.push({ sql, params });
      if (sql.includes("information_schema.tables")) return { rows: [{ exists: true }] };
      if (sql.includes("information_schema.table_constraints")) {
        return { rows: pgMock.primaryColumns.map((column_name) => ({ column_name })) };
      }
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [
            { column_name: "id", data_type: "integer", numeric_scale: 0 },
            { column_name: "name", data_type: "character varying", numeric_scale: null },
            { column_name: "notes", data_type: "text", numeric_scale: null },
            { column_name: "active", data_type: "boolean", numeric_scale: null },
            { column_name: "amount", data_type: "numeric", numeric_scale: 2 },
            { column_name: "created_at", data_type: "timestamp with time zone", numeric_scale: null },
            { column_name: "due_on", data_type: "date", numeric_scale: null },
            { column_name: "payload", data_type: "jsonb", numeric_scale: null },
          ],
        };
      }
      return { rows: pgMock.selectRows };
    }
  },
}));

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

import {
  createDataSyncTable,
  listPropertiesForRequest,
  pushPostgresqlTwoWayRowsCreated,
  pushPostgresqlTwoWayRowsDeleted,
  pushPostgresqlTwoWayRowsUpdated,
  serializeDataSync,
  syncDataSyncTable,
  updateDataSyncSyncedProperties,
} from "../src/services/data-sync";
import { addFieldColumn, getOrCreateUserTable, serializeFieldValueForInsert, type FieldType } from "../src/services/dynamic-tables";
import { buildApplicationSnapshot, restoreApplicationSnapshot } from "../src/routes/snapshots";
import { triggerPeriodicDataSyncs } from "../src/cron/handler";
import { handleQueue } from "../src/queue/handler";

type TestD1 = {
  database: DatabaseSync;
  prepare(sql: string): {
    bind(...args: unknown[]): { all(): Promise<{ results: any[] }>; first<T = any>(): Promise<T | null>; run(): Promise<object> };
    all(): Promise<{ results: any[] }>;
    first<T = any>(): Promise<T | null>;
    run(): Promise<object>;
  };
  batch(statements: Array<{ all?: () => Promise<any>; first?: () => Promise<any>; run?: () => Promise<any> }>): Promise<any[]>;
};

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_initial.sql", "0006_field_rules_data_sync.sql", "0007_data_sync_schema_upgrade.sql", "0008_core_job_result.sql", "0009_builder_core.sql", "0019_premium_view_settings.sql", "0020_view_filter_groups.sql", "0022_form_view_field_options_logic.sql", "0023_row_comments.sql", "0024_data_sync_periodic.sql", "0027_postgresql_two_way_sync.sql", "0038_data_sync_authorized_user.sql", "0039_builder_published_applications.sql", "0043_form_view_submit_notifications.sql", "0046_data_sync_select_option_mapping.sql"]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
  const api: TestD1 = {
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
    batch(statements) {
      return Promise.all(statements.map((statement) => statement.run ? statement.run() : statement.first ? statement.first() : statement.all?.()));
    },
  };
  const now = new Date().toISOString();
  api.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
    .bind(now)
    .run();
  api.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (7, '', 'admin@example.com', 'Admin', 'User', 'admin@example.com', 1, 1, ?)`
  ).bind(now).run();
  api.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
    .run();
  api.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  return api;
}

function githubResponse(body: unknown, status = 200, link = "") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (link) headers.link = link;
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
  pgMock.reset();
});

describe("data sync", () => {
  async function createSourceField(db: TestD1, tableId: number, name: string, type: FieldType, order: number, primary = false, settings: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    const field = await db.prepare(
      `INSERT INTO database_field (table_id, name, type, [order], "primary", read_only, trashed,
       field_settings, created_on, updated_on, db_index, immutable_type, immutable_properties)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 0, 0) RETURNING id`
    ).bind(tableId, name, type, order, primary ? 1 : 0, JSON.stringify(settings), now, now, primary ? 1 : 0).first<{ id: number }>();
    await addFieldColumn(db as any, tableId, { id: field!.id, type, primary });
    return field!.id;
  }

  async function createPostgresqlTwoWayTable(db: TestD1, syncedProperties = ["id", "name", "active"]) {
    pgMock.selectRows = [];
    const table = await createDataSyncTable(db as any, 10, {
      type: "postgresql",
      table_name: "PostgreSQL contacts",
      postgresql_host: "db.example.com",
      postgresql_username: "writer",
      postgresql_password: "secret",
      postgresql_port: 5432,
      postgresql_database: "crm",
      postgresql_schema: "public",
      postgresql_table: "contacts",
      postgresql_sslmode: "require",
      two_way_sync: true,
      synced_properties: syncedProperties,
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    const fields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(table.id).all()).results;
    const byName = new Map(fields.map((field: any) => [field.name, field]));
    return { table, dataSync, fields, byName };
  }

  it("serializes every provider setting Baserow exposes and never returns secrets", () => {
    const common = {
      id: 1,
      table_id: 1,
      last_sync: null,
      last_error: null,
      auto_add_new_properties: 0,
      two_way_sync: 0,
      authorized: 1,
      created_on: "2026-07-12T00:00:00.000Z",
      updated_on: "2026-07-12T00:00:00.000Z",
    };
    const cases = [
      ["ical_calendar", { ical_url: "https://example.com/calendar.ics" }],
      ["postgresql", {
        postgresql_host: "db.example.com",
        postgresql_username: "reader",
        postgresql_password: "secret",
        postgresql_port: 5432,
        postgresql_database: "crm",
        postgresql_schema: "public",
        postgresql_table: "contacts",
        postgresql_sslmode: "require",
      }],
      ["local_baserow_table", { source_table_id: 20, source_table_view_id: 30, authorized_user_id: 7 }],
      ["github_issues", { github_issues_owner: "acme", github_issues_repo: "app", github_issues_api_token: "secret" }],
    ] as const;
    const expectedKeys: Record<string, string[]> = {
      ical_calendar: ["ical_url"],
      postgresql: ["postgresql_host", "postgresql_username", "postgresql_port", "postgresql_database", "postgresql_schema", "postgresql_table", "postgresql_sslmode"],
      local_baserow_table: ["source_table_id", "source_table_view_id"],
      github_issues: ["github_issues_owner", "github_issues_repo"],
    };

    for (const [type, settings] of cases) {
      const serialized = serializeDataSync({ ...common, type, settings: JSON.stringify(settings) } as any);
      for (const key of expectedKeys[type]) expect(serialized).toHaveProperty(key, (settings as any)[key]);
      for (const secret of ["postgresql_password", "github_issues_api_token", "authorized_user_id"]) {
        expect(serialized).not.toHaveProperty(secret);
      }
    }
  });

  it("rejects unsupported two-way data sync requests like Baserow", async () => {
    const db = createTestD1();

    await expect(createDataSyncTable(db as any, 10, {
      type: "github_issues",
      table_name: "GitHub issues",
      github_issues_owner: "acme",
      github_issues_repo: "project",
      github_issues_api_token: "ghp_token",
      two_way_sync: true,
      synced_properties: ["title"],
    })).rejects.toThrow("Two-way sync is not supported for this data sync type.");
  });

  it("roundtrips data sync metadata through application snapshots", async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (20, 10, 'Source table', 1, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 20);
    const textFieldId = await createSourceField(db, 20, "Source text", "text", 1, true);
    const singleFieldId = await createSourceField(db, 20, "Source status", "single_select", 2);
    await db.prepare(
      "INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (40, ?, 'Ready', 'green', 1)"
    ).bind(singleFieldId).run();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        public_view_password, trashed, ownership_type, row_height_size, row_identifier_type, created_on, updated_on)
       VALUES (80, 20, 'Grid', 'grid', 1, 'AND', 0, 0, 'source-grid',
        NULL, 0, 'collaborative', 'small', 'count', ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO "database_table_20" (id, [order], "field_${textFieldId}", "field_${singleFieldId}", _created_on, _updated_on)
       VALUES (1, 10000, ?, ?, ?, ?)`
    ).bind(
      "Alice",
      serializeFieldValueForInsert("single_select", { id: 40, value: "Ready", color: "green" }),
      now,
      now
    ).run();

    const syncedTable = await createDataSyncTable(db as any, 10, {
      type: "local_baserow_table",
      table_name: "Source mirror",
      source_table_id: 20,
      synced_properties: [`field_${textFieldId}`, `field_${singleFieldId}`],
      auto_add_new_properties: false,
      periodic_interval: "day",
      periodic_interval_count: 2,
    });
    const sourceSnapshot = await buildApplicationSnapshot(db as any, 10);
    const syncBundle = sourceSnapshot.tables.find((bundle: any) => bundle.table.id === syncedTable.id)?.data_sync;
    expect(syncBundle?.data_sync?.type).toBe("local_baserow_table");
    expect(syncBundle?.synced_properties.map((property: any) => property.key)).toEqual([
      "id",
      `field_${textFieldId}`,
      `field_${singleFieldId}`,
    ]);

    const restoredApp = await restoreApplicationSnapshot(db as any, { id: 999, name: "Data sync snapshot" }, sourceSnapshot);
    const restoredTables = (await db.prepare(
      "SELECT * FROM database_table WHERE database_id=? ORDER BY [order] ASC, id ASC"
    ).bind(restoredApp.id).all<any>()).results;
    const restoredSource = restoredTables.find((table: any) => table.name === "Source table");
    const restoredSyncTable = restoredTables.find((table: any) => table.name === "Source mirror");
    expect(restoredSource?.id).toBeTruthy();
    expect(restoredSyncTable?.data_sync_id).toBeTruthy();

    const restoredSourceFields = (await db.prepare(
      "SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC"
    ).bind(restoredSource.id).all<any>()).results;
    const restoredSourceText = restoredSourceFields.find((field: any) => field.name === "Source text");
    const restoredSourceStatus = restoredSourceFields.find((field: any) => field.name === "Source status");
    expect(restoredSourceText?.id).toBeTruthy();
    expect(restoredSourceStatus?.id).toBeTruthy();

    const restoredDataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?")
      .bind(restoredSyncTable.id)
      .first<any>();
    expect(restoredDataSync).toMatchObject({
      type: "local_baserow_table",
      auto_add_new_properties: 0,
      two_way_sync: 0,
      periodic_interval: "day",
      periodic_interval_count: 2,
    });
    const settings = JSON.parse(restoredDataSync.settings);
    expect(settings.source_table_id).toBe(restoredSource.id);
    expect(settings.synced_properties).toEqual([
      `field_${restoredSourceText.id}`,
      `field_${restoredSourceStatus.id}`,
    ]);

    const restoredProperties = (await db.prepare(
      `SELECT dsp.key, dsp.unique_primary, f.name AS field_name
       FROM database_datasyncsyncedproperty dsp
       LEFT JOIN database_field f ON f.id=dsp.field_id
       WHERE dsp.data_sync_id=?
       ORDER BY dsp.id ASC`
    ).bind(restoredDataSync.id).all<any>()).results;
    expect(restoredProperties).toEqual([
      expect.objectContaining({ key: "id", unique_primary: 1, field_name: "Row ID" }),
      expect.objectContaining({ key: `field_${restoredSourceText.id}`, unique_primary: 0, field_name: "Source text" }),
      expect.objectContaining({ key: `field_${restoredSourceStatus.id}`, unique_primary: 0, field_name: "Source status" }),
    ]);
  });

  it("syncs iCal calendar events with Baserow date field metadata", async () => {
    const db = createTestD1();
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:event-1",
      "DTSTART:20260527T120000Z",
      "DTEND:20260527T130000Z",
      "SUMMARY:Board\\, review",
      "DESCRIPTION:Line one\\nLine two",
      "LOCATION:Room 1",
      "ORGANIZER;CN=Alice:mailto:alice@example.com",
      "CREATED:20260501T100000Z",
      "LAST-MODIFIED:20260502T110000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:event-2",
      "DTSTART;TZID=Europe/Amsterdam:20260528T090000",
      "DTEND;VALUE=DATE:20260529",
      "SUMMARY:Local timezone",
      "CREATED;TZID=Europe/Amsterdam:20260501T120000",
      "LAST-MODIFIED:20260502T110000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ics, {
      status: 200,
      headers: { "content-type": "text/calendar" },
    }));

    const properties = await listPropertiesForRequest({
      type: "ical_calendar",
      ical_url: "https://calendar.test/team.ics",
    }, undefined, db as any) as any[];
    expect(properties.map((property) => [property.key, property.name, property.field_type, property.immutable_properties !== false])).toEqual([
      ["uid", "Unique ID", "text", true],
      ["dtstart", "Start date", "date", false],
      ["dtend", "End date", "date", false],
      ["summary", "Summary", "text", true],
    ]);

    const table = await createDataSyncTable(db as any, 10, {
      type: "ical_calendar",
      table_name: "Calendar sync",
      ical_url: "https://calendar.test/team.ics",
      synced_properties: ["dtstart", "dtend", "summary"],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    const result = await syncDataSyncTable(db as any, dataSync.id);

    expect(result.imported_count).toBe(2);
    const fields = await db.prepare(
      `SELECT f.name, f.type, f.field_settings, f.immutable_properties, dsp.key, dsp.field_id, f."primary" AS primary_field
       FROM database_datasyncsyncedproperty dsp
       JOIN database_field f ON f.id=dsp.field_id
       WHERE dsp.data_sync_id=?
       ORDER BY dsp.id ASC`
    ).bind(dataSync.id).all<any>();
    const byKey = new Map((fields.results || []).map((field) => [field.key, field]));
    expect(byKey.get("uid")).toMatchObject({ name: "Unique ID", type: "text", primary_field: 1 });
    expect(byKey.get("uid").immutable_properties).toBe(1);
    expect(byKey.get("dtstart").immutable_properties).toBe(0);
    expect(byKey.get("dtend").immutable_properties).toBe(0);
    expect(JSON.parse(byKey.get("dtstart").field_settings)).toMatchObject({
      date_format: "ISO",
      date_include_time: true,
      date_time_format: "24",
      date_show_tzinfo: true,
    });
    const rows = await db.prepare(`SELECT * FROM "database_table_${table.id}" ORDER BY id ASC`).all<any>();
    const row = rows.results[0];
    expect(row[`field_${byKey.get("uid").field_id}`]).toBe("event-1");
    expect(row[`field_${byKey.get("dtstart").field_id}`]).toBe("2026-05-27T12:00:00.000Z");
    expect(row[`field_${byKey.get("dtend").field_id}`]).toBe("2026-05-27T13:00:00.000Z");
    expect(row[`field_${byKey.get("summary").field_id}`]).toBe("Board, review");
    const localRow = rows.results[1];
    expect(localRow[`field_${byKey.get("uid").field_id}`]).toBe("event-2");
    expect(localRow[`field_${byKey.get("dtstart").field_id}`]).toBe("2026-05-28T07:00:00.000Z");
    expect(localRow[`field_${byKey.get("dtend").field_id}`]).toBe("2026-05-29");
  });

  it("queues due periodic data syncs and records a finished sync job", async () => {
    const db = createTestD1();
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:event-periodic",
      "DTSTART:20260601T120000Z",
      "SUMMARY:Periodic sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ics, {
      status: 200,
      headers: { "content-type": "text/calendar" },
    }));

    const table = await createDataSyncTable(db as any, 10, {
      type: "ical_calendar",
      table_name: "Periodic calendar",
      ical_url: "https://calendar.test/periodic.ics",
      synced_properties: ["summary"],
      periodic_interval: "hour",
      periodic_interval_count: 1,
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    await db.prepare("UPDATE database_datasync SET next_periodic_sync=? WHERE id=?")
      .bind("2026-06-01T00:00:00.000Z", dataSync.id)
      .run();

    const messages: any[] = [];
    const env = {
      DB: db,
      HYPERDRIVE: undefined,
      JOBS_QUEUE: { send: async (message: any) => { messages.push(message); } },
    } as any;

    await triggerPeriodicDataSyncs(env);
    await triggerPeriodicDataSyncs(env);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      job_type: "sync_data_source",
      payload: { datasync_id: dataSync.id, table_id: table.id, periodic: true },
      workspace_id: 1,
    });

    const acknowledged: number[] = [];
    await handleQueue({
      messages: [{
        body: messages[0],
        ack: () => acknowledged.push(messages[0].job_id),
      }],
    } as any, env);

    expect(acknowledged).toEqual([messages[0].job_id]);
    const job = await db.prepare("SELECT * FROM core_job WHERE id=?").bind(messages[0].job_id).first<any>();
    expect(job).toMatchObject({ type: "sync_data_source", status: "finished", progress_percentage: 100 });
    expect(JSON.parse(job.result)).toEqual({ imported_count: 1 });
    const updated = await db.prepare("SELECT * FROM database_datasync WHERE id=?").bind(dataSync.id).first<any>();
    expect(updated.last_periodic_sync).toBeTruthy();
    expect(updated.next_periodic_sync).toBeTruthy();
    expect(updated.consecutive_failures).toBe(0);
    expect(updated.deactivated).toBe(0);
  });

  it("removes periodic jobs when Queue delivery fails so the next cron can retry", async () => {
    const db = createTestD1();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-retry",
      "SUMMARY:Retry",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"), { status: 200 }));
    const table = await createDataSyncTable(db as any, 10, {
      type: "ical_calendar",
      table_name: "Retry calendar",
      ical_url: "https://calendar.test/retry.ics",
      synced_properties: ["summary"],
      periodic_interval: "hour",
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    await db.prepare("UPDATE database_datasync SET next_periodic_sync=? WHERE id=?")
      .bind("2026-06-01T00:00:00.000Z", dataSync.id)
      .run();

    const env = {
      DB: db,
      JOBS_QUEUE: { send: async () => { throw new Error("queue unavailable"); } },
    } as any;
    await expect(triggerPeriodicDataSyncs(env)).rejects.toThrow("queue unavailable");
    const afterFailure = await db.prepare(
      "SELECT COUNT(*) AS count FROM core_job WHERE type='sync_data_source'"
    ).first<{ count: number }>();
    expect(afterFailure?.count).toBe(0);

    const messages: any[] = [];
    env.JOBS_QUEUE.send = async (message: any) => { messages.push(message); };
    await triggerPeriodicDataSyncs(env);
    expect(messages).toHaveLength(1);
    const retriedJob = await db.prepare("SELECT status FROM core_job WHERE id=?")
      .bind(messages[0].job_id)
      .first<{ status: string }>();
    expect(retriedJob?.status).toBe("pending");
  });

  it("processes Baserow sync_data_sync_table queue jobs and preserves the pollable job payload", async () => {
    const db = createTestD1();
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:event-manual",
      "DTSTART:20260602T120000Z",
      "SUMMARY:Manual sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ics, {
      status: 200,
      headers: { "content-type": "text/calendar" },
    }));

    const table = await createDataSyncTable(db as any, 10, {
      type: "ical_calendar",
      table_name: "Manual calendar",
      ical_url: "https://calendar.test/manual.ics",
      synced_properties: ["summary"],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    const now = new Date().toISOString();
    const job = await db.prepare(
      `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
       VALUES ('sync_data_sync_table', 'pending', 0, 7, ?, ?, ?) RETURNING id`
    ).bind(now, now, JSON.stringify({ data_sync_id: dataSync.id, data_sync: { id: dataSync.id, type: dataSync.type } })).first<any>();
    const acknowledged: number[] = [];

    await handleQueue({
      messages: [{
        body: {
          job_id: job.id,
          job_type: "sync_data_sync_table",
          payload: { data_sync_id: dataSync.id },
          user_id: 7,
          workspace_id: 1,
        },
        ack: () => acknowledged.push(job.id),
      }],
    } as any, { DB: db, HYPERDRIVE: undefined } as any);

    expect(acknowledged).toEqual([job.id]);
    const storedJob = await db.prepare("SELECT * FROM core_job WHERE id=?").bind(job.id).first<any>();
    expect(storedJob).toMatchObject({ type: "sync_data_sync_table", status: "finished", progress_percentage: 100 });
    const result = JSON.parse(storedJob.result);
    expect(result).toMatchObject({
      imported_count: 1,
      data_sync_id: dataSync.id,
      data_sync: { id: dataSync.id, type: "ical_calendar", last_error: null },
    });
    expect(result.data_sync.last_sync).toBeTruthy();
  });

  it("deactivates failing periodic data syncs and notifies workspace admins", async () => {
    const db = createTestD1();
    const okIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:event-ok",
      "DTSTART:20260601T120000Z",
      "SUMMARY:Initial sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    let fail = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (fail) return new Response("forbidden", { status: 403 });
      return new Response(okIcs, { status: 200, headers: { "content-type": "text/calendar" } });
    });

    const table = await createDataSyncTable(db as any, 10, {
      type: "ical_calendar",
      table_name: "Failing periodic calendar",
      ical_url: "https://calendar.test/failing.ics",
      synced_properties: ["summary"],
      periodic_interval: "hour",
      periodic_interval_count: 1,
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    await db.prepare(
      "UPDATE database_datasync SET consecutive_failures=2, next_periodic_sync=? WHERE id=?"
    ).bind("2026-06-01T00:00:00.000Z", dataSync.id).run();
    fail = true;

    const now = new Date().toISOString();
    const job = await db.prepare(
      `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on)
       VALUES ('sync_data_source', 'pending', 0, NULL, ?, ?) RETURNING id`
    ).bind(now, now).first<any>();
    const env = { DB: db, HYPERDRIVE: undefined } as any;
    await handleQueue({
      messages: [{
        body: {
          job_id: job.id,
          job_type: "sync_data_source",
          payload: { datasync_id: dataSync.id, table_id: table.id, periodic: true },
          user_id: 0,
          workspace_id: 1,
        },
        ack: () => undefined,
      }],
    } as any, env);

    const updated = await db.prepare("SELECT * FROM database_datasync WHERE id=?").bind(dataSync.id).first<any>();
    expect(updated.consecutive_failures).toBe(3);
    expect(updated.deactivated).toBe(1);
    expect(updated.deactivation_reason).toBe("consecutive_failures");
    expect(updated.next_periodic_sync).toBeNull();

    const notification = await db.prepare(
      `SELECT n.type, n.data, nr.recipient_id
         FROM core_notification n
         JOIN core_notificationrecipient nr ON nr.notification_id=n.id
        WHERE n.type='periodic_data_sync_deactivated'`
    ).first<any>();
    expect(notification).toMatchObject({ recipient_id: 7 });
    expect(JSON.parse(notification.data)).toMatchObject({
      data_sync_id: dataSync.id,
      table_name: "Failing periodic calendar",
      table_id: table.id,
      database_id: 10,
      deactivation_reason: "consecutive_failures",
    });
  });

	  it("syncs local Baserow table fields, select options and rows from D1", async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    const source = await db.prepare(
      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (10, 'Source table', 1, 1, 0, ?, ?, 0, 0, 0) RETURNING id`
    ).bind(now, now).first<{ id: number }>();
    await getOrCreateUserTable(db as any, source!.id);
    const nameFieldId = await createSourceField(db, source!.id, "Name", "text", 1, true);
    const statusFieldId = await createSourceField(db, source!.id, "Status", "single_select", 2);
    const tagsFieldId = await createSourceField(db, source!.id, "Tags", "multiple_select", 3);
    const activeFieldId = await createSourceField(db, source!.id, "Active", "boolean", 4);
    await db.prepare("INSERT INTO database_selectoption (field_id, value, color, [order]) VALUES (?, 'Todo', 'blue', 1), (?, 'Todo', 'red', 2)")
      .bind(statusFieldId, statusFieldId)
      .run();
    await db.prepare("INSERT INTO database_selectoption (field_id, value, color, [order]) VALUES (?, 'Urgent', 'red', 1), (?, 'External', 'orange', 2)")
      .bind(tagsFieldId, tagsFieldId)
      .run();
    await db.prepare(
      `INSERT INTO "database_table_${source!.id}" ([order], _created_on, _updated_on, "field_${nameFieldId}", "field_${statusFieldId}", "field_${tagsFieldId}", "field_${activeFieldId}")
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      10000,
      now,
      now,
      "Task one",
      serializeFieldValueForInsert("single_select", { id: 2, value: "Todo", color: "red" }),
      serializeFieldValueForInsert("multiple_select", [{ id: 3, value: "Urgent", color: "red" }]),
      1
    ).run();

    const properties = await listPropertiesForRequest({
      type: "local_baserow_table",
      source_table_id: source!.id,
    }, undefined, db as any) as any[];
    expect(properties.map((property) => [property.key, property.name, property.field_type, property.unique_primary])).toEqual([
      ["id", "Row ID", "number", true],
      [`field_${nameFieldId}`, "Name", "text", false],
      [`field_${statusFieldId}`, "Status", "single_select", false],
      [`field_${activeFieldId}`, "Active", "boolean", false],
    ]);
    expect(properties.find((property) => property.key === `field_${statusFieldId}`).select_options).toEqual([
      { id: "1", value: "Todo", color: "blue", order: 1 },
      { id: "2", value: "Todo", color: "red", order: 2 },
    ]);

    const table = await createDataSyncTable(db as any, 10, {
      type: "local_baserow_table",
      table_name: "Synced local source",
      source_table_id: source!.id,
      synced_properties: ["id", `field_${nameFieldId}`, `field_${statusFieldId}`, `field_${activeFieldId}`],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    const result = await syncDataSyncTable(db as any, dataSync.id);
    expect(result.imported_count).toBe(1);

    const fields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(table.id).all()).results;
    const byName = new Map(fields.map((field: any) => [field.name, field]));
    const rows = (await db.prepare(`SELECT * FROM "database_table_${table.id}"`).all()).results;
    expect(rows[0][`field_${(byName.get("Row ID") as any).id}`]).toBe("n:1");
    expect(rows[0][`field_${(byName.get("Name") as any).id}`]).toBe("Task one");
    expect(JSON.parse(rows[0][`field_${(byName.get("Status") as any).id}`] as string)).toMatchObject({ value: "Todo", color: "red" });
	    expect(rows[0][`field_${(byName.get("Active") as any).id}`]).toBe(1);
	  });

  it("maps supported local virtual fields to Baserow destination types and excludes unsupported fields", async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    const updated = new Date(Date.now() + 60_000).toISOString();
    const source = await db.prepare(
      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (10, 'Virtual source', 1, 1, 0, ?, ?, 0, 0, 0) RETURNING id`
    ).bind(now, now).first<{ id: number }>();
    await getOrCreateUserTable(db as any, source!.id);
    const createdFieldId = await createSourceField(db, source!.id, "Created", "created_on", 1, false, {
      date_format: "ISO", date_include_time: true, date_time_format: "24",
    });
    const modifiedFieldId = await createSourceField(db, source!.id, "Modified", "last_modified", 2, false, {
      date_format: "ISO", date_include_time: true, date_time_format: "24",
    });
    const uuidFieldId = await createSourceField(db, source!.id, "UUID", "uuid", 3);
    const autonumberFieldId = await createSourceField(db, source!.id, "Sequence", "autonumber", 4);
    const formulaFieldId = await createSourceField(db, source!.id, "Formula", "formula", 5);
    await db.prepare(
      `INSERT INTO "database_table_${source!.id}"
       ([order], _created_on, _updated_on, "field_${uuidFieldId}", "field_${autonumberFieldId}", "field_${formulaFieldId}")
       VALUES (10000, ?, ?, 'uuid-value', 'n:42', 'excluded')`
    ).bind(now, updated).run();

    const settings = { type: "local_baserow_table", source_table_id: source!.id };
    const properties = await listPropertiesForRequest(settings, undefined, db as any) as any[];
    expect(properties.map((property) => [property.key, property.field_type])).toEqual([
      ["id", "number"],
      [`field_${createdFieldId}`, "date"],
      [`field_${modifiedFieldId}`, "date"],
      [`field_${uuidFieldId}`, "text"],
      [`field_${autonumberFieldId}`, "number"],
    ]);
    expect(properties.some((property) => property.key === `field_${formulaFieldId}`)).toBe(false);

    const table = await createDataSyncTable(db as any, 10, {
      ...settings,
      table_name: "Virtual destination",
      synced_properties: properties.map((property) => property.key),
    });
    const dataSync = await db.prepare("SELECT id FROM database_datasync WHERE table_id=?").bind(table.id).first<{ id: number }>();
    await syncDataSyncTable(db as any, dataSync!.id);
    const fields = (await db.prepare("SELECT * FROM database_field WHERE table_id=?").bind(table.id).all<any>()).results;
    const byName = new Map(fields.map((field: any) => [field.name, field]));
    const row = await db.prepare(`SELECT * FROM "database_table_${table.id}"`).first<any>();
    expect(row[`field_${byName.get("Created").id}`]).toBe(now);
    expect(row[`field_${byName.get("Modified").id}`]).toBe(updated);
    expect(row[`field_${byName.get("UUID").id}`]).toBe("uuid-value");
    expect(row[`field_${byName.get("Sequence").id}`]).toBe("n:42");
  });

  it("preserves synced row identity and applies source updates and deletes by unique primary", async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    const source = await db.prepare(
      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (10, 'Identity source', 1, 1, 0, ?, ?, 0, 0, 0) RETURNING id`
    ).bind(now, now).first<{ id: number }>();
    await getOrCreateUserTable(db as any, source!.id);
    const nameFieldId = await createSourceField(db, source!.id, "Name", "text", 1, true);
    const sourceRow = await db.prepare(
      `INSERT INTO "database_table_${source!.id}" ([order], _created_on, _updated_on, "field_${nameFieldId}")
       VALUES (10000, ?, ?, 'First') RETURNING id`
    ).bind(now, now).first<{ id: number }>();

    const table = await createDataSyncTable(db as any, 10, {
      type: "local_baserow_table",
      table_name: "Identity destination",
      source_table_id: source!.id,
      synced_properties: ["id", `field_${nameFieldId}`],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    await syncDataSyncTable(db as any, dataSync.id);

    const mapping = await db.prepare(
      `SELECT dsp.key, dsp.field_id
         FROM database_datasyncsyncedproperty dsp
        WHERE dsp.data_sync_id=?`
    ).bind(dataSync.id).all<any>();
    const fieldByKey = new Map(mapping.results.map((property: any) => [property.key, property.field_id]));
    const firstDestination = await db.prepare(`SELECT * FROM "database_table_${table.id}"`).first<any>();
    await db.prepare(
      `INSERT INTO database_rowcomment (table_id, row_id, user_id, message, created_on, updated_on, trashed)
       VALUES (?, ?, 7, '{"text":"keep identity"}', ?, ?, 0)`
    ).bind(table.id, firstDestination.id, now, now).run();

    await db.prepare(`UPDATE "database_table_${source!.id}" SET "field_${nameFieldId}"='Second' WHERE id=?`)
      .bind(sourceRow!.id)
      .run();
    await syncDataSyncTable(db as any, dataSync.id);
    const updatedDestination = await db.prepare(`SELECT * FROM "database_table_${table.id}"`).first<any>();
    expect(updatedDestination.id).toBe(firstDestination.id);
    expect(updatedDestination._created_on).toBe(firstDestination._created_on);
    expect(updatedDestination[`field_${fieldByKey.get(`field_${nameFieldId}`)}`]).toBe("Second");
    const preservedComment = await db.prepare(
      "SELECT COUNT(*) AS count FROM database_rowcomment WHERE table_id=? AND row_id=?"
    ).bind(table.id, firstDestination.id).first<{ count: number }>();
    expect(preservedComment?.count).toBe(1);

    await db.prepare(`DELETE FROM "database_table_${source!.id}" WHERE id=?`).bind(sourceRow!.id).run();
    await syncDataSyncTable(db as any, dataSync.id);
    const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM "database_table_${table.id}"`).first<{ count: number }>();
    expect(remaining?.count).toBe(0);
    const removedComments = await db.prepare(
      "SELECT COUNT(*) AS count FROM database_rowcomment WHERE table_id=? AND row_id=?"
    ).bind(table.id, firstDestination.id).first<{ count: number }>();
    expect(removedComments?.count).toBe(0);
  });

  it("adds newly available fields during sync when auto_add_new_properties is enabled", async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    const source = await db.prepare(
      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (10, 'Expanding source', 1, 1, 0, ?, ?, 0, 0, 0) RETURNING id`
    ).bind(now, now).first<{ id: number }>();
    await getOrCreateUserTable(db as any, source!.id);
    const nameFieldId = await createSourceField(db, source!.id, "Name", "text", 1, true);
    const sourceRow = await db.prepare(
      `INSERT INTO "database_table_${source!.id}" ([order], _created_on, _updated_on, "field_${nameFieldId}")
       VALUES (10000, ?, ?, 'Task') RETURNING id`
    ).bind(now, now).first<{ id: number }>();

    const table = await createDataSyncTable(db as any, 10, {
      type: "local_baserow_table",
      table_name: "Expanding destination",
      source_table_id: source!.id,
      auto_add_new_properties: true,
      synced_properties: ["id", `field_${nameFieldId}`],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    await syncDataSyncTable(db as any, dataSync.id);

    const notesFieldId = await createSourceField(db, source!.id, "Notes", "long_text", 2);
    await db.prepare(`UPDATE "database_table_${source!.id}" SET "field_${notesFieldId}"='Added later' WHERE id=?`)
      .bind(sourceRow!.id)
      .run();
    await syncDataSyncTable(db as any, dataSync.id);

    const added = await db.prepare(
      `SELECT dsp.field_id
         FROM database_datasyncsyncedproperty dsp
        WHERE dsp.data_sync_id=? AND dsp.key=?`
    ).bind(dataSync.id, `field_${notesFieldId}`).first<{ field_id: number }>();
    expect(added?.field_id).toBeTruthy();
    const destination = await db.prepare(`SELECT * FROM "database_table_${table.id}"`).first<any>();
    expect(destination[`field_${added!.field_id}`]).toBe("Added later");
  });

  it("applies local source view visibility filters and sorting", async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    const source = await db.prepare(
      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (10, 'View source', 1, 1, 0, ?, ?, 0, 0, 0) RETURNING id`
    ).bind(now, now).first<{ id: number }>();
    await getOrCreateUserTable(db as any, source!.id);
    const nameFieldId = await createSourceField(db, source!.id, "Name", "text", 1, true);
    const hiddenFieldId = await createSourceField(db, source!.id, "Hidden", "text", 2);
    const view = await db.prepare(
      `INSERT INTO database_view (table_id, name, type, [order], filter_type, slug, created_on, updated_on)
       VALUES (?, 'Filtered source', 'grid', 1, 'AND', ?, ?, ?) RETURNING id`
    ).bind(source!.id, crypto.randomUUID(), now, now).first<{ id: number }>();
    await db.prepare(
      `INSERT INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order])
       VALUES (?, ?, 200, 0, 1), (?, ?, 200, 1, 2)`
    ).bind(view!.id, nameFieldId, view!.id, hiddenFieldId).run();
    await db.prepare(
      "INSERT INTO database_viewfilter (view_id, field_id, type, value) VALUES (?, ?, 'contains', 'Keep')"
    ).bind(view!.id, nameFieldId).run();
    await db.prepare(
      "INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (?, ?, 'DESC', 'default')"
    ).bind(view!.id, nameFieldId).run();
    for (const [order, name] of [[10000, "Keep A"], [20000, "Drop"], [30000, "Keep Z"]] as const) {
      await db.prepare(
        `INSERT INTO "database_table_${source!.id}" ([order], _created_on, _updated_on, "field_${nameFieldId}", "field_${hiddenFieldId}")
         VALUES (?, ?, ?, ?, 'private')`
      ).bind(order, now, now, name).run();
    }

    const settings = {
      type: "local_baserow_table",
      source_table_id: source!.id,
      source_table_view_id: view!.id,
    };
    const properties = await listPropertiesForRequest(settings, undefined, db as any) as any[];
    expect(properties.map((property) => property.key)).toEqual(["id", `field_${nameFieldId}`]);

    const table = await createDataSyncTable(db as any, 10, {
      ...settings,
      table_name: "Filtered destination",
      synced_properties: ["id", `field_${nameFieldId}`],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    await syncDataSyncTable(db as any, dataSync.id);
    const nameMapping = await db.prepare(
      "SELECT field_id FROM database_datasyncsyncedproperty WHERE data_sync_id=? AND key=?"
    ).bind(dataSync.id, `field_${nameFieldId}`).first<{ field_id: number }>();
    const rows = await db.prepare(
      `SELECT "field_${nameMapping!.field_id}" AS name FROM "database_table_${table.id}" ORDER BY [order] ASC`
    ).all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual(["Keep Z", "Keep A"]);
  });

  it("deauthorizes a local sync when its stored user loses source access", async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    const source = await db.prepare(
      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (10, 'Authorized source', 1, 1, 0, ?, ?, 0, 0, 0) RETURNING id`
    ).bind(now, now).first<{ id: number }>();
    await getOrCreateUserTable(db as any, source!.id);
    const nameFieldId = await createSourceField(db, source!.id, "Name", "text", 1, true);
    await db.prepare(
      `INSERT INTO "database_table_${source!.id}" ([order], _created_on, _updated_on, "field_${nameFieldId}")
       VALUES (10000, ?, ?, 'Authorized row')`
    ).bind(now, now).run();

    const table = await createDataSyncTable(db as any, 10, {
      type: "local_baserow_table",
      table_name: "Authorized destination",
      source_table_id: source!.id,
      synced_properties: ["id", `field_${nameFieldId}`],
    }, undefined, 7);
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    expect(dataSync.authorized_user_id).toBe(7);
    await syncDataSyncTable(db as any, dataSync.id);

    await db.prepare("DELETE FROM core_workspaceuser WHERE workspace_id=1 AND user_id=7").run();
    await expect(syncDataSyncTable(db as any, dataSync.id)).rejects.toThrow("Access denied.");
    const deauthorized = await db.prepare(
      "SELECT authorized, last_error FROM database_datasync WHERE id=?"
    ).bind(dataSync.id).first<any>();
    expect(deauthorized.authorized).toBe(0);
    expect(deauthorized.last_error).toBe("Access denied.");
  });

	  it("updates visible data sync properties and keeps the unique primary property", async () => {
	    const db = createTestD1();
	    const now = new Date().toISOString();
	    const source = await db.prepare(
	      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
	       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
	       VALUES (10, 'Source table', 1, 1, 0, ?, ?, 0, 0, 0) RETURNING id`
	    ).bind(now, now).first<{ id: number }>();
	    await getOrCreateUserTable(db as any, source!.id);
	    const nameFieldId = await createSourceField(db, source!.id, "Name", "text", 1, true);
	    const statusFieldId = await createSourceField(db, source!.id, "Status", "single_select", 2);
	    const tagsFieldId = await createSourceField(db, source!.id, "Tags", "multiple_select", 3);
	    const activeFieldId = await createSourceField(db, source!.id, "Active", "boolean", 4);
	    await db.prepare("INSERT INTO database_selectoption (field_id, value, color, [order]) VALUES (?, 'Todo', 'blue', 1), (?, 'Done', 'green', 2)")
	      .bind(statusFieldId, statusFieldId)
	      .run();
	    await db.prepare("INSERT INTO database_selectoption (field_id, value, color, [order]) VALUES (?, 'Urgent', 'red', 1), (?, 'External', 'orange', 2)")
	      .bind(tagsFieldId, tagsFieldId)
	      .run();
	    await db.prepare(
	      `INSERT INTO "database_table_${source!.id}" ([order], _created_on, _updated_on, "field_${nameFieldId}", "field_${statusFieldId}", "field_${tagsFieldId}", "field_${activeFieldId}")
	       VALUES (?, ?, ?, ?, ?, ?, ?)`
	    ).bind(
	      10000,
	      now,
	      now,
	      "Task one",
	      serializeFieldValueForInsert("single_select", { id: 1, value: "Todo", color: "blue" }),
	      serializeFieldValueForInsert("multiple_select", [{ id: 3, value: "Urgent", color: "red" }]),
	      1
	    ).run();

	    const table = await createDataSyncTable(db as any, 10, {
	      type: "local_baserow_table",
	      table_name: "Synced local source",
	      source_table_id: source!.id,
	      synced_properties: ["id", `field_${nameFieldId}`, `field_${statusFieldId}`],
	    });
	    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();

	    await expect(updateDataSyncSyncedProperties(db as any, dataSync.id, ["field_999999"]))
	      .rejects.toMatchObject({ code: "ERROR_PROPERTY_NOT_FOUND" });
	    await expect(updateDataSyncSyncedProperties(db as any, dataSync.id, [`field_${tagsFieldId}`]))
	      .rejects.toMatchObject({ code: "ERROR_PROPERTY_NOT_FOUND" });
	    await updateDataSyncSyncedProperties(db as any, dataSync.id, [`field_${activeFieldId}`, `field_${activeFieldId}`]);

	    const mappings = (await db.prepare(
	      `SELECT dsp.key, dsp.unique_primary, f.id AS field_id, f.name, f.type, f."primary" AS field_primary, f.read_only
	         FROM database_datasyncsyncedproperty dsp
	         JOIN database_field f ON f.id=dsp.field_id
	        WHERE dsp.data_sync_id=?
	        ORDER BY dsp.id ASC`
	    ).bind(dataSync.id).all()).results;
	    expect(mappings.map((row: any) => [row.key, row.name, row.type, row.unique_primary, row.field_primary, row.read_only])).toEqual([
      ["id", "Row ID", "number", 1, 1, 1],
	      [`field_${activeFieldId}`, "Active", "boolean", 0, 0, 1],
	    ]);

	    const activeFieldNames = (await db.prepare(
	      "SELECT name FROM database_field WHERE table_id=? AND trashed=0 ORDER BY [order] ASC"
	    ).bind(table.id).all()).results.map((row: any) => row.name);
    expect(activeFieldNames).toEqual(["Row ID", "Active"]);

	    const result = await syncDataSyncTable(db as any, dataSync.id);
	    expect(result.imported_count).toBe(1);
	    const rows = (await db.prepare(`SELECT * FROM "database_table_${table.id}"`).all()).results;
	    expect(rows[0][`field_${(mappings[0] as any).field_id}`]).toBe("n:1");
	    expect(rows[0][`field_${(mappings[1] as any).field_id}`]).toBe(1);
	  });

	  it("lists PostgreSQL columns with Baserow compatible field types", async () => {
    const properties = await listPropertiesForRequest({
      type: "postgresql",
      postgresql_host: "db.example.com",
      postgresql_username: "reader",
      postgresql_password: "secret",
      postgresql_port: 5432,
      postgresql_database: "crm",
      postgresql_schema: "public",
      postgresql_table: "contacts",
      postgresql_sslmode: "require",
    }) as any[];

    expect(pgMock.clients[0].config).toMatchObject({
      host: "db.example.com",
      user: "reader",
      database: "crm",
      application_name: "Supertask Data Sync",
    });
    expect(properties.map((property) => [property.key, property.field_type, property.unique_primary, property.initially_selected])).toEqual([
      ["id", "number", true, true],
      ["name", "text", false, true],
      ["notes", "long_text", false, true],
      ["active", "boolean", false, true],
      ["amount", "number", false, true],
      ["created_at", "date", false, true],
      ["due_on", "date", false, true],
    ]);
    expect(properties.find((property) => property.key === "amount").field_settings.number_decimal_places).toBe(2);
    expect(properties.find((property) => property.key === "created_at").field_settings.date_include_time).toBe(true);
    expect(properties.find((property) => property.key === "created_at").field_settings.date_show_tzinfo).toBe(true);
    expect(properties.find((property) => property.key === "due_on").field_settings.date_include_time).toBe(false);
    expect(properties.find((property) => property.key === "due_on").field_settings.date_show_tzinfo).toBe(true);
  });

  it("rejects PostgreSQL sources without a unique primary property before creating a table", async () => {
    const db = createTestD1();
    pgMock.primaryColumns = [];
    await expect(createDataSyncTable(db as any, 10, {
      type: "postgresql",
      table_name: "Invalid source",
      postgresql_host: "db.example.com",
      postgresql_username: "reader",
      postgresql_password: "secret",
      postgresql_database: "crm",
      postgresql_table: "contacts",
      synced_properties: ["id"],
    })).rejects.toMatchObject({ code: "ERROR_UNIQUE_PRIMARY_PROPERTY_NOT_FOUND" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_table").first<{ count: number }>())
      .toMatchObject({ count: 0 });
  });

  it("creates and syncs PostgreSQL rows with editable non-primary fields when two-way sync is enabled", async () => {
    const db = createTestD1();
    pgMock.selectRows = [
      {
        id: 7,
        name: "Alice",
        notes: "Imported from Postgres",
        active: true,
        amount: "125.50",
        created_at: new Date("2026-05-27T10:20:30Z"),
        due_on: "2026-06-01",
      },
    ];

    const table = await createDataSyncTable(db as any, 10, {
      type: "postgresql",
      table_name: "PostgreSQL contacts",
      postgresql_host: "db.example.com",
      postgresql_username: "reader",
      postgresql_password: "secret",
      postgresql_port: 5432,
      postgresql_database: "crm",
      postgresql_schema: "public",
      postgresql_table: "contacts",
      postgresql_sslmode: "require",
      two_way_sync: true,
      synced_properties: ["id", "name", "notes", "active", "amount", "created_at", "due_on"],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    expect(dataSync.two_way_sync).toBe(1);

    const result = await syncDataSyncTable(db as any, dataSync.id);
    expect(result.imported_count).toBe(1);
    expect(pgMock.queries.some((query) => query.sql.includes('ORDER BY "id"'))).toBe(true);

    const fields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(table.id).all()).results;
    expect(fields.map((field: any) => [field.name, field.type, field.read_only, field.immutable_type, field.immutable_properties])).toEqual([
      ["id", "number", 1, 1, 0],
      ["name", "text", 0, 1, 1],
      ["notes", "long_text", 0, 1, 1],
      ["active", "boolean", 0, 1, 1],
      ["amount", "number", 0, 1, 0],
      ["created_at", "date", 0, 1, 0],
      ["due_on", "date", 0, 1, 0],
    ]);
    const byName = new Map(fields.map((field: any) => [field.name, field]));
    expect(JSON.parse((byName.get("created_at") as any).field_settings)).toMatchObject({
      date_include_time: true,
      date_show_tzinfo: true,
    });
    expect(JSON.parse((byName.get("due_on") as any).field_settings)).toMatchObject({
      date_include_time: false,
      date_show_tzinfo: true,
    });
    const rows = (await db.prepare(`SELECT * FROM "database_table_${table.id}"`).all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0][`field_${(byName.get("id") as any).id}`]).toBe("n:7");
    expect(rows[0][`field_${(byName.get("name") as any).id}`]).toBe("Alice");
    expect(rows[0][`field_${(byName.get("active") as any).id}`]).toBe(1);
    expect(rows[0][`field_${(byName.get("amount") as any).id}`]).toBe("n:125.5");
    expect(rows[0][`field_${(byName.get("created_at") as any).id}`]).toBe("2026-05-27T10:20:30.000Z");
    expect(rows[0][`field_${(byName.get("due_on") as any).id}`]).toBe("2026-06-01T00:00:00.000Z");
  });

  it("pushes created PostgreSQL two-way rows and stores generated primary values locally", async () => {
    const db = createTestD1();
    const { table, dataSync, byName } = await createPostgresqlTwoWayTable(db, ["id", "name"]);
    expect(dataSync.two_way_sync).toBe(1);

    const idField = byName.get("id") as any;
    const nameField = byName.get("name") as any;
    await db.prepare(
      `INSERT INTO "database_table_${table.id}" ([order], _created_on, _updated_on, "field_${idField.id}", "field_${nameField.id}")
       VALUES (10000, ?, ?, NULL, ?)`
    ).bind(new Date().toISOString(), new Date().toISOString(), "Created locally").run();
    const row = await db.prepare(`SELECT * FROM "database_table_${table.id}"`).first<any>();

    pgMock.queries = [];
    pgMock.selectRows = [{ id: 900 }];
    await pushPostgresqlTwoWayRowsCreated({ DB: db } as any, table.id, [row]);

    const insert = pgMock.queries.find((query) => query.sql.startsWith("INSERT INTO"));
    expect(insert).toEqual({
      sql: `INSERT INTO "public"."contacts" ("name") VALUES ($1) RETURNING "id"`,
      params: ["Created locally"],
    });
    const stored = await db.prepare(`SELECT "field_${idField.id}" AS id_value FROM "database_table_${table.id}" WHERE id=?`)
      .bind(row.id)
      .first<any>();
    expect(stored.id_value).toBe("n:900");
    const updatedDataSync = await db.prepare("SELECT last_error, two_way_sync_consecutive_failures FROM database_datasync WHERE id=?")
      .bind(dataSync.id)
      .first<any>();
    expect(updatedDataSync).toMatchObject({ last_error: null, two_way_sync_consecutive_failures: 0 });
  });

  it("pushes updated and deleted PostgreSQL two-way rows by unique primary values", async () => {
    const db = createTestD1();
    const { table, byName } = await createPostgresqlTwoWayTable(db, ["id", "name", "active"]);
    const idField = byName.get("id") as any;
    const nameField = byName.get("name") as any;
    const activeField = byName.get("active") as any;
    await db.prepare(
      `INSERT INTO "database_table_${table.id}" ([order], _created_on, _updated_on, "field_${idField.id}", "field_${nameField.id}", "field_${activeField.id}")
       VALUES (10000, ?, ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(),
      new Date().toISOString(),
      serializeFieldValueForInsert("number", 7),
      "After",
      1
    ).run();
    const row = await db.prepare(`SELECT * FROM "database_table_${table.id}"`).first<any>();

    pgMock.queries = [];
    await pushPostgresqlTwoWayRowsUpdated({ DB: db } as any, table.id, [row], new Set([nameField.id, activeField.id]));
    expect(pgMock.queries.find((query) => query.sql.startsWith("UPDATE "))).toEqual({
      sql: `UPDATE "public"."contacts" SET "name" = $1, "active" = $2 WHERE "id" = $3`,
      params: ["After", true, 7],
    });

    pgMock.queries = [];
    await pushPostgresqlTwoWayRowsDeleted({ DB: db } as any, table.id, [row]);
    expect(pgMock.queries.find((query) => query.sql.startsWith("DELETE "))).toEqual({
      sql: `DELETE FROM "public"."contacts" WHERE "id" = $1`,
      params: [7],
    });
  });

  it("records PostgreSQL two-way failures, notifies admins and locks fields after repeated failures", async () => {
    const db = createTestD1();
    const { table, dataSync, byName } = await createPostgresqlTwoWayTable(db, ["id", "name"]);
    const idField = byName.get("id") as any;
    const nameField = byName.get("name") as any;
    await db.prepare(
      `INSERT INTO "database_table_${table.id}" ([order], _created_on, _updated_on, "field_${idField.id}", "field_${nameField.id}")
       VALUES (10000, ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(),
      new Date().toISOString(),
      serializeFieldValueForInsert("number", 7),
      "Will fail"
    ).run();
    await db.prepare("UPDATE database_datasync SET two_way_sync_consecutive_failures=7 WHERE id=?")
      .bind(dataSync.id)
      .run();
    const row = await db.prepare(`SELECT * FROM "database_table_${table.id}"`).first<any>();

    pgMock.connectError = new Error("connection refused");
    await pushPostgresqlTwoWayRowsUpdated({ DB: db } as any, table.id, [row], new Set([nameField.id]));

    const updatedDataSync = await db.prepare(
      "SELECT two_way_sync, two_way_sync_consecutive_failures, last_error FROM database_datasync WHERE id=?"
    ).bind(dataSync.id).first<any>();
    expect(updatedDataSync.two_way_sync).toBe(0);
    expect(updatedDataSync.two_way_sync_consecutive_failures).toBe(8);
    expect(updatedDataSync.last_error).toContain("connection refused");
    const field = await db.prepare("SELECT read_only FROM database_field WHERE id=?").bind(nameField.id).first<any>();
    expect(field.read_only).toBe(1);
    const notifications = (await db.prepare("SELECT type, data FROM core_notification ORDER BY id ASC").all()).results;
    expect(notifications.map((notification: any) => notification.type)).toEqual([
      "two_way_sync_update_failed",
      "two_way_sync_deactivated",
    ]);
    expect(JSON.parse(notifications[0].data)).toMatchObject({
      data_sync_id: dataSync.id,
      table_name: "PostgreSQL contacts",
      table_id: table.id,
      database_id: 10,
      error: expect.stringContaining("connection refused"),
    });
  });

  it("uses Hyperdrive connection strings when the binding is configured", async () => {
    await listPropertiesForRequest({
      type: "postgresql",
      postgresql_host: "db.example.com",
      postgresql_username: "reader",
      postgresql_password: "secret",
      postgresql_database: "crm",
      postgresql_schema: "public",
      postgresql_table: "contacts",
    }, { HYPERDRIVE: { connectionString: "postgres://hyperdrive" } as any });

    expect(pgMock.clients[0].config).toEqual({ connectionString: "postgres://hyperdrive" });
  });

  it("rejects unsafe PostgreSQL hosts without a 500", async () => {
    await expect(listPropertiesForRequest({
      type: "postgresql",
      postgresql_host: "127.0.0.1",
      postgresql_username: "reader",
      postgresql_password: "secret",
      postgresql_database: "crm",
      postgresql_schema: "public",
      postgresql_table: "contacts",
    })).rejects.toThrow("not allowed");
  });

  it("rejects private iCal provider URLs before outbound fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(listPropertiesForRequest({
      type: "ical_calendar",
      ical_url: "http://127.0.0.1/calendar.ics",
    })).rejects.toThrow("public HTTP URL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects Data Sync providers removed from the product scope", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const type of ["jira_issues", "gitlab_issues", "hubspot_contacts"]) {
      await expect(listPropertiesForRequest({ type })).rejects.toThrow(
        `Data sync type ${type} is not registered.`
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists GitHub issue properties with the Baserow enterprise contract", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("GitHub property listing must not fetch rows.");
    });

    const properties = await listPropertiesForRequest({ type: "github_issues" }) as any[];

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(properties.map((property) => [property.key, property.name, property.field_type, property.initially_selected])).toEqual([
      ["id", "GitHub Issue ID", "number", true],
      ["title", "Title", "text", true],
      ["body", "Body", "long_text", true],
      ["user", "User", "text", true],
      ["assignee", "Assignee", "text", true],
      ["assignees", "Assignees", "text", true],
      ["labels", "Labels", "text", true],
      ["state", "State", "text", true],
      ["created_at", "Created At", "date", true],
      ["updated_at", "Updated At", "date", true],
      ["closed_at", "Closed At", "date", true],
      ["closed_by", "Closed By", "text", true],
      ["milestone", "Milestone", "text", true],
      ["url", "URL to Issue", "url", true],
    ]);
    expect(properties.find((property) => property.key === "id").field_settings).toEqual({ number_decimal_places: 0, number_negative: false });
    expect(properties.find((property) => property.key === "body").field_settings).toEqual({ long_text_enable_rich_text: true });
    expect(properties.find((property) => property.key === "created_at").field_settings).toMatchObject({ date_include_time: true, date_show_tzinfo: true });
  });

  it("creates and syncs GitHub issues with typed fields and GitHub values", async () => {
    const db = createTestD1();
    const calls: Array<{ url: string; authorization: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        authorization: String(new Headers(init?.headers).get("authorization") || ""),
      });
      if (new URL(url).searchParams.get("page") !== "1") return githubResponse([]);
      return githubResponse([
        {
          id: 123,
          number: 7,
          title: "Real issue",
          state: "open",
          html_url: "https://github.com/acme/project/issues/7",
          body: "Body text",
          created_at: "2026-05-01T10:00:00Z",
          updated_at: "2026-05-02T10:00:00Z",
          closed_at: null,
          labels: [{ name: "bug" }, { name: "urgent" }],
          assignee: { login: "alice" },
          assignees: [{ login: "alice" }, { login: "bob" }],
          user: { login: "reporter" },
          closed_by: { login: "closer" },
          milestone: { title: "v1" },
        },
        {
          id: 456,
          number: 8,
          title: "Pull request",
          state: "open",
          pull_request: { url: "https://api.github.com/repos/acme/project/pulls/8" },
        },
      ]);
    });

    const table = await createDataSyncTable(db as any, 10, {
      type: "github_issues",
      table_name: "GitHub issues",
      github_issues_owner: "acme",
      github_issues_repo: "project",
      github_issues_api_token: "ghp_token",
      two_way_sync: false,
      synced_properties: ["title", "body", "user", "assignee", "assignees", "labels", "state", "created_at", "updated_at", "closed_at", "closed_by", "milestone", "url"],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    expect(dataSync.two_way_sync).toBe(0);

    const result = await syncDataSyncTable(db as any, dataSync.id);
    expect(result.imported_count).toBe(1);
    expect(calls.map((call) => call.url).slice(-2)).toEqual([
      "https://api.github.com/repos/acme/project/issues?page=1&per_page=50&state=all",
      "https://api.github.com/repos/acme/project/issues?page=2&per_page=50&state=all",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer ghp_token")).toBe(true);

    const fields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(table.id).all()).results;
    expect(fields.map((field: any) => [field.name, field.type, field.primary])).toEqual([
      ["GitHub Issue ID", "number", 1],
      ["Title", "text", 0],
      ["Body", "long_text", 0],
      ["User", "text", 0],
      ["Assignee", "text", 0],
      ["Assignees", "text", 0],
      ["Labels", "text", 0],
      ["State", "text", 0],
      ["Created At", "date", 0],
      ["Updated At", "date", 0],
      ["Closed At", "date", 0],
      ["Closed By", "text", 0],
      ["Milestone", "text", 0],
      ["URL to Issue", "url", 0],
    ]);
    const byKey = new Map((await db.prepare(
      `SELECT dsp.key, f.id, f.name, f.type, f.field_settings FROM database_datasyncsyncedproperty dsp
       JOIN database_field f ON f.id=dsp.field_id
       WHERE dsp.data_sync_id=?`
    ).bind(dataSync.id).all()).results.map((row: any) => [row.key, row]));
    expect(JSON.parse((byKey.get("body") as any).field_settings).long_text_enable_rich_text).toBe(true);
    expect(JSON.parse((byKey.get("created_at") as any).field_settings).date_show_tzinfo).toBe(true);
    const byName = new Map(fields.map((field: any) => [field.name, field]));
    const rows = (await db.prepare(`SELECT * FROM "database_table_${table.id}"`).all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0][`field_${byName.get("GitHub Issue ID").id}`]).toBe("n:7");
    expect(rows[0][`field_${byName.get("Title").id}`]).toBe("Real issue");
    expect(rows[0][`field_${byName.get("Body").id}`]).toBe("Body text");
    expect(rows[0][`field_${byName.get("User").id}`]).toBe("reporter");
    expect(rows[0][`field_${byName.get("Assignee").id}`]).toBe("alice");
    expect(rows[0][`field_${byName.get("Labels").id}`]).toBe("bug, urgent");
    expect(rows[0][`field_${byName.get("Assignees").id}`]).toBe("alice, bob");
    expect(rows[0][`field_${byName.get("Closed By").id}`]).toBe("closer");
    expect(rows[0][`field_${byName.get("URL to Issue").id}`]).toBe("https://github.com/acme/project/issues/7");
  });

  it("keeps existing rows and records authorization errors when GitHub rejects credentials", async () => {
    const db = createTestD1();
    let fail = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      if (fail) return githubResponse({ message: "Bad credentials" }, 403);
      if (new URL(String(input)).searchParams.get("page") !== "1") return githubResponse([]);
      return githubResponse([{ id: 1, number: 1, title: "Persisted", state: "open", html_url: "https://github.com/acme/project/issues/1" }]);
    });

    const table = await createDataSyncTable(db as any, 10, {
      type: "github_issues",
      table_name: "GitHub issues",
      github_issues_owner: "acme",
      github_issues_repo: "project",
      github_issues_api_token: "good",
      synced_properties: ["title"],
    });
    const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?").bind(table.id).first<any>();
    await syncDataSyncTable(db as any, dataSync.id);

    fail = true;
    await db.prepare("UPDATE database_datasync SET settings=? WHERE id=?")
      .bind(JSON.stringify({
        type: "github_issues",
        github_issues_owner: "acme",
        github_issues_repo: "project",
        github_issues_api_token: "bad",
      }), dataSync.id)
      .run();
    await expect(syncDataSyncTable(db as any, dataSync.id)).rejects.toThrow("GitHub rejected the provided credentials.");

    const updated = await db.prepare("SELECT * FROM database_datasync WHERE id=?").bind(dataSync.id).first<any>();
    expect(updated.authorized).toBe(0);
    expect(updated.last_error).toContain("GitHub rejected");
    const count = await db.prepare(`SELECT COUNT(*) AS count FROM "database_table_${table.id}"`).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

});
