import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { addFieldColumn, getOrCreateUserTable, type FieldType } from "../src/services/dynamic-tables";
import { verifyPassword } from "../src/services/user";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

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
  for (const file of ["0001_initial.sql", "0003_user_files.sql", "0005_templates.sql", "0006_field_rules_data_sync.sql", "0008_core_job_result.sql", "0009_builder_core.sql", "0019_premium_view_settings.sql", "0020_view_filter_groups.sql", "0022_form_view_field_options_logic.sql", "0025_row_history_undo_redo.sql", "0028_userfile_baserow_name_hash.sql", "0035_autonumber_sequences.sql", "0039_builder_published_applications.sql", "0040_ai_field_scheduled_updates.sql", "0041_ai_file_field_dependencies.sql", "0043_form_view_submit_notifications.sql"]) {
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
    batch(statements) {
      return Promise.all(statements.map((statement) => statement.run ? statement.run() : statement.first ? statement.first() : statement.all?.()));
    },
  };
}

async function createField(db: TestD1, tableId: number, id: number, name: string, type: FieldType, order: number, readOnly = false, settings: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO database_field
     (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on, db_index,
      immutable_type, immutable_properties)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 0)`
  ).bind(id, tableId, name, type, order, order === 1 ? 1 : 0, readOnly ? 1 : 0, JSON.stringify(settings), now, now, order === 1 ? 1 : 0).run();
  await addFieldColumn(db as any, tableId, { id, type, primary: order === 1 });
}

async function createSelectOption(db: TestD1, id: number, fieldId: number, value: string, order: number) {
  await db.prepare(
    "INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (?, ?, ?, 'light-blue', ?)"
  ).bind(id, fieldId, value, order).run();
}

async function setupRowsFixture() {
  const db = createTestD1();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
    .bind(now)
    .run();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (7, '', 'user@example.com', 'User', 'Example', 'user@example.com', 0, 1, ?)`
  ).bind(now).run();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES
       (8, '', 'ada@example.com', 'Ada', 'Lovelace', 'ada@example.com', 0, 1, ?),
       (9, '', 'deleted@example.com', 'Deleted', 'User', 'deleted@example.com', 0, 1, ?)`
  ).bind(now, now).run();
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
    .bind()
    .run();
  await db.prepare(
    `INSERT INTO core_workspaceuser (workspace_id, user_id, permissions, to_be_deleted)
     VALUES (1, 8, 'MEMBER', 0), (1, 9, 'MEMBER', 1)`
  ).run();
  await db.prepare(
    `INSERT INTO core_userprofile (user_id, language, email_notification_frequency, to_be_deleted)
     VALUES (7, 'en', 'instant', 0), (8, 'en', 'instant', 0), (9, 'en', 'instant', 0)`
  ).run();
  await db.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (20, 10, 'Rows', 1, 1, 0, ?, ?, 0, 0, 0)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await createField(db, 20, 101, "Name", "text", 1);
  await createField(db, 20, 102, "Computed", "formula", 2, true, { formula: 'CONCAT({Name}, "!")', formula_type: "text" });
  await createField(db, 20, 103, "Sequence", "autonumber", 3, true);
  await createField(db, 20, 104, "Created", "created_on", 4, true);
  await createField(db, 20, 105, "Touched by", "last_modified_by", 5, true);
  await createField(db, 20, 106, "Status", "single_select", 6, false, { single_select_default: 201 });
  await createSelectOption(db, 201, 106, "Todo", 1);
  await createSelectOption(db, 202, 106, "Done", 2);
  await createField(db, 20, 107, "Tags", "multiple_select", 7, false, { multiple_select_default: [203, 204] });
  await createSelectOption(db, 203, 107, "Red", 1);
  await createSelectOption(db, 204, 107, "Blue", 2);
  await createField(db, 20, 108, "Discount", "number", 8, false, { number_suffix: "%", number_default: 25 });
  await createField(db, 20, 109, "Assignees", "multiple_collaborators", 9);
  const token = await signAccessToken({ user_id: 7, email: "user@example.com", username: "user@example.com" }, "test-secret", 60);
  const broadcasts: any[] = [];
  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    CACHE: { get: async () => null, put: async () => undefined },
    JOBS_QUEUE: { send: async () => undefined },
    WORKSPACE_ROOM: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          broadcasts.push(JSON.parse(String(init.body)));
          return new Response("{}");
        },
      }),
    },
    FILES: { head: async () => null },
    ENVIRONMENT: "test",
  } as any;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => promise.catch(() => undefined),
    passThroughOnException: () => undefined,
  } as any;
  return { db, env, ctx, token, broadcasts };
}

async function api(env: any, ctx: any, token: string, path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `JWT ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
}

describe("row write parity for read-only fields", () => {
  it("undoes and redoes row create, update, and delete actions by client session and table scope", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const headers = { ClientSessionId: "session-undo-rows" };
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Undo source",
      field_108: 11,
    }, headers);
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as any;

    const undoCreateResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoCreateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "create_row", action_scope: "table20" }],
    });
    expect(await db.prepare('SELECT id FROM "database_table_20" WHERE id=?').bind(created.id).first()).toBeNull();

    const redoCreateResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoCreateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "create_row", action_scope: "table20" }],
    });
    expect(await db.prepare('SELECT field_101 FROM "database_table_20" WHERE id=?').bind(created.id).first<any>())
      .toMatchObject({ field_101: "Undo source" });

    const patchResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "PATCH", {
      field_101: "Undo target",
      field_108: 42,
    }, headers);
    expect(patchResponse.status).toBe(200);

    const undoUpdateResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoUpdateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "update_row", action_scope: "table20" }],
    });
    expect(await db.prepare('SELECT field_101, field_108 FROM "database_table_20" WHERE id=?').bind(created.id).first<any>())
      .toMatchObject({ field_101: "Undo source", field_108: "n:11" });

    const redoUpdateResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoUpdateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "update_row", action_scope: "table20" }],
    });
    expect(await db.prepare('SELECT field_101, field_108 FROM "database_table_20" WHERE id=?').bind(created.id).first<any>())
      .toMatchObject({ field_101: "Undo target", field_108: "n:42" });

    const deleteResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "DELETE", undefined, headers);
    expect(deleteResponse.status).toBe(200);

    const undoDeleteResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoDeleteResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "delete_row", action_scope: "table20" }],
    });
    expect(await db.prepare('SELECT field_101, field_108 FROM "database_table_20" WHERE id=?').bind(created.id).first<any>())
      .toMatchObject({ field_101: "Undo target", field_108: "n:42" });

    const redoDeleteResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoDeleteResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "delete_row", action_scope: "table20" }],
    });
    expect(await db.prepare('SELECT id FROM "database_table_20" WHERE id=?').bind(created.id).first()).toBeNull();
  });

  it("soft deletes rows, hides them from active endpoints, restores them, and permanently deletes them from trash", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const createResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Trash contract",
      field_108: 13,
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as any;

    const deleteResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "DELETE", undefined);
    expect(deleteResponse.status).toBe(200);
    expect(await db.prepare('SELECT id, trashed, field_101 FROM "database_table_20" WHERE id=?').bind(created.id).first<any>())
      .toMatchObject({ id: created.id, trashed: 1, field_101: "Trash contract" });

    const getDeletedResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "GET", undefined);
    expect(getDeletedResponse.status).toBe(404);
    const listResponse = await api(env, ctx, token, "/api/database/rows/table/20/?search=Trash%20contract", "GET", undefined);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({ count: 0, results: [] });

    const trashEntry = await db.prepare(
      "SELECT id, trash_item_type, trash_item_id, parent_trash_item_id FROM core_trasheditem WHERE trash_item_type='row' AND trash_item_id=?"
    ).bind(created.id).first<any>();
    expect(trashEntry).toMatchObject({ trash_item_type: "row", trash_item_id: created.id, parent_trash_item_id: 20 });

    const restoreResponse = await api(
      env,
      ctx,
      token,
      `/api/trash/row/${created.id}/restore/?parent_trash_item_id=20`,
      "PATCH",
      undefined
    );
    expect(restoreResponse.status).toBe(200);
    expect(await db.prepare('SELECT trashed FROM "database_table_20" WHERE id=?').bind(created.id).first<any>())
      .toEqual({ trashed: 0 });
    expect(await db.prepare("SELECT id FROM core_trasheditem WHERE trash_item_type='row' AND trash_item_id=?").bind(created.id).first())
      .toBeNull();

    const restoredGetResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "GET", undefined);
    expect(restoredGetResponse.status).toBe(200);
    expect(await restoredGetResponse.json()).toMatchObject({ id: created.id, field_101: "Trash contract" });

    const secondDeleteResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "DELETE", undefined);
    expect(secondDeleteResponse.status).toBe(200);
    const permanentDeleteResponse = await api(
      env,
      ctx,
      token,
      `/api/trash/row/${created.id}/?parent_trash_item_id=20&workspace_id=1`,
      "DELETE",
      undefined
    );
    expect(permanentDeleteResponse.status).toBe(200);
    expect(await db.prepare('SELECT id FROM "database_table_20" WHERE id=?').bind(created.id).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM core_trasheditem WHERE trash_item_type='row' AND trash_item_id=?").bind(created.id).first())
      .toBeNull();
  });

  it("generates metadata fields and ignores client values for computed fields", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Alpha",
      field_102: "client formula value",
      field_103: 999,
      field_104: "1900-01-01T00:00:00.000Z",
      field_105: [{ id: 999, name: "wrong" }],
      field_109: [7],
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as any;
    expect(created.field_101).toBe("Alpha");
    expect(created.field_102).toBe("Alpha!");
    expect(created.field_103).toBe(1);
    expect(created.field_104).not.toBe("1900-01-01T00:00:00.000Z");
    expect(created.field_105).toMatchObject({ id: 7, email: "user@example.com" });
    expect(created.field_106).toMatchObject({ id: 201, value: "Todo" });
    expect(created.field_107.map((option: any) => option.value)).toEqual(["Red", "Blue"]);
    expect(created.field_108).toBe("25");
    expect(created.field_109).toEqual([{ id: 7, name: "User Example" }]);

    const storedAfterCreate = await db.prepare('SELECT field_102, field_103, field_106, field_107, field_108, field_109, _last_modified_by_id FROM "database_table_20" WHERE id=1').first<any>();
    expect(storedAfterCreate).toMatchObject({ field_102: null, field_103: "n:1", field_108: "n:25", _last_modified_by_id: 7 });
    expect(JSON.parse(storedAfterCreate.field_106)).toMatchObject({ id: 201, value: "Todo" });
    expect(JSON.parse(storedAfterCreate.field_107).map((option: any) => option.value)).toEqual(["Red", "Blue"]);
    expect(JSON.parse(storedAfterCreate.field_109)).toEqual([{ id: 7, name: "User Example" }]);

    const patchedResponse = await api(env, ctx, token, "/api/database/rows/table/20/1/", "PATCH", {
      field_101: "Beta",
      field_102: "patched formula value",
      field_103: 1234,
      field_109: [{ id: "7" }],
    });
    expect(patchedResponse.status).toBe(200);
    const patched = await patchedResponse.json() as any;
    expect(patched.field_101).toBe("Beta");
    expect(patched.field_102).toBe("Beta!");
    expect(patched.field_103).toBe(1);
    expect(patched.field_109).toEqual([{ id: 7, name: "User Example" }]);

    const storedAfterPatch = await db.prepare('SELECT field_102, field_103, _last_modified_by_id FROM "database_table_20" WHERE id=1').first<any>();
    expect(storedAfterPatch).toMatchObject({ field_102: null, field_103: "n:1", _last_modified_by_id: 7 });
  });

  it("applies the same rules to batch row creation", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const response = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "One", field_102: "wrong", field_103: 99, field_109: [7] },
        { field_101: "Two", field_102: "wrong", field_103: 99, field_109: [{ id: "7" }] },
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.items.map((row: any) => [row.field_102, row.field_103, row.field_105.id])).toEqual([
      ["One!", 1, 7],
      ["Two!", 2, 7],
    ]);
    expect(body.items.map((row: any) => [row.field_106.value, row.field_107.map((option: any) => option.value).join(",")])).toEqual([
      ["Todo", "Red,Blue"],
      ["Todo", "Red,Blue"],
    ]);
    expect(body.items.map((row: any) => row.field_109[0])).toEqual([
      { id: 7, name: "User Example" },
      { id: 7, name: "User Example" },
    ]);
    expect(body.items.map((row: any) => row.field_108)).toEqual(["25", "25"]);
    const stored = await db.prepare('SELECT id, field_102, field_103, field_106, field_107, field_108, field_109, _last_modified_by_id FROM "database_table_20" ORDER BY id').all<any>();
    expect(stored.results).toEqual([
      expect.objectContaining({ id: 1, field_102: null, field_103: "n:1", field_108: "n:25", _last_modified_by_id: 7 }),
      expect.objectContaining({ id: 2, field_102: null, field_103: "n:2", field_108: "n:25", _last_modified_by_id: 7 }),
    ]);
    expect(stored.results.map((row: any) => JSON.parse(row.field_106).value)).toEqual(["Todo", "Todo"]);
    expect(stored.results.map((row: any) => JSON.parse(row.field_107).map((option: any) => option.value).join(","))).toEqual(["Red,Blue", "Red,Blue"]);
    expect(stored.results.map((row: any) => JSON.parse(row.field_109)[0].name)).toEqual(["User Example", "User Example"]);
  });

  it("initializes and advances autonumber fields with Baserow view and trash semantics", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "ab" },
        { field_101: "aa" },
        { field_101: "bb" },
        { field_101: "bc" },
      ],
    });
    expect(createdResponse.status).toBe(200);
    const createdRows = (await createdResponse.json() as any).items;
    await db.prepare('UPDATE "database_table_20" SET trashed=1 WHERE id=?').bind(createdRows[2].id).run();

    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug, trashed, created_on, updated_on)
       VALUES (900, 20, 'Autonumber order', 'grid', 1, 'AND', 0, 0, 'autonumber-order', 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      "INSERT INTO database_viewfilter (view_id, field_id, type, value) VALUES (900, 101, 'contains', 'b')"
    ).run();
    await db.prepare(
      "INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (900, 101, 'ASC', 'default')"
    ).run();

    const invalidView = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Invalid sequence",
      type: "autonumber",
      view_id: 999999,
    });
    expect(invalidView.status).toBe(400);
    expect(await invalidView.json()).toMatchObject({ error: "ERROR_VIEW_DOES_NOT_EXIST" });

    const fieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "View sequence",
      type: "autonumber",
      view_id: 900,
    });
    expect(fieldResponse.status).toBe(200);
    const field = await fieldResponse.json() as any;
    const stored = await db.prepare(
      `SELECT id, field_101 AS name, "field_${field.id}" AS sequence, trashed
       FROM "database_table_20"
       ORDER BY id ASC`
    ).all<any>();
    expect(stored.results.map((row) => [row.name, row.sequence, row.trashed])).toEqual([
      ["ab", "n:1", 0],
      ["aa", "n:3", 0],
      ["bb", "n:4", 1],
      ["bc", "n:2", 0],
    ]);

    const fifthResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", { field_101: "e" });
    const fifth = await fifthResponse.json() as any;
    expect(fifth[`field_${field.id}`]).toBe(5);
    await api(env, ctx, token, `/api/database/rows/table/20/${fifth.id}/`, "DELETE", undefined);
    await api(env, ctx, token, `/api/trash/row/${fifth.id}/?parent_trash_item_id=20&workspace_id=1`, "DELETE", undefined);

    const sixthResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", { field_101: "f" });
    const sixth = await sixthResponse.json() as any;
    expect(sixth[`field_${field.id}`]).toBe(6);

    expect((await api(env, ctx, token, `/api/database/fields/${field.id}/`, "DELETE", undefined)).status).toBe(200);
    const hiddenResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", { field_101: "g" });
    const hidden = await hiddenResponse.json() as any;
    expect(hidden[`field_${field.id}`]).toBeUndefined();
    expect(await db.prepare(`SELECT "field_${field.id}" AS value FROM "database_table_20" WHERE id=?`).bind(hidden.id).first<any>())
      .toEqual({ value: "n:7" });
    expect((await api(env, ctx, token, `/api/trash/field/${field.id}/restore/`, "PATCH", undefined)).status).toBe(200);
    const restored = await api(env, ctx, token, `/api/database/rows/table/20/${hidden.id}/`, "GET", undefined);
    expect((await restored.json() as any)[`field_${field.id}`]).toBe(7);
  });

  it("follows Baserow row batch ordering, operation metadata and user field name contracts", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "One" },
        { field_101: "Two" },
        { field_101: "Three" },
      ],
    });
    expect(createdResponse.status).toBe(200);

    const insertedResponse = await api(env, ctx, token, "/api/database/rows/table/20/?before=2", "POST", {
      field_101: "Inserted single",
    });
    expect(insertedResponse.status).toBe(200);

    const namedBatchResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/?before=3&user_field_names=true&include_metadata=true", "POST", {
      items: [
        { Name: "Batch A", Discount: 5 },
        { Name: "Batch B", Discount: 6 },
      ],
    });
    expect(namedBatchResponse.status).toBe(200);
    const namedBatch = await namedBatchResponse.json() as any;
    expect(namedBatch.items.map((row: any) => row.Name)).toEqual(["Batch A", "Batch B"]);
    expect(namedBatch.items[0].field_101).toBeUndefined();
    expect(namedBatch.metadata.updated_field_ids).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109]);

    const ordered = await db.prepare('SELECT field_101 FROM "database_table_20" ORDER BY [order] ASC, id ASC').all<any>();
    expect(ordered.results.map((row: any) => row.field_101)).toEqual([
      "One",
      "Inserted single",
      "Two",
      "Batch A",
      "Batch B",
      "Three",
    ]);

    const getNamedResponse = await api(env, ctx, token, "/api/database/rows/table/20/1/?user_field_names=true", "GET", undefined);
    expect(getNamedResponse.status).toBe(200);
    const getNamed = await getNamedResponse.json() as any;
    expect(getNamed.Name).toBe("One");
    expect(getNamed.field_101).toBeUndefined();

    const patchNamedResponse = await api(env, ctx, token, "/api/database/rows/table/20/1/?user_field_names=true", "PATCH", {
      Name: "One patched",
    });
    expect(patchNamedResponse.status).toBe(200);
    const patchNamed = await patchNamedResponse.json() as any;
    expect(patchNamed.Name).toBe("One patched");
    expect(patchNamed.field_101).toBeUndefined();

    const batchPatchNamedResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/?user_field_names=true&include_metadata=true", "PATCH", {
      items: [
        { id: 1, Name: "One batch patched", Discount: 12 },
      ],
    });
    expect(batchPatchNamedResponse.status).toBe(200);
    const batchPatchNamed = await batchPatchNamedResponse.json() as any;
    expect(batchPatchNamed.items[0].Name).toBe("One batch patched");
    expect(batchPatchNamed.items[0].Discount).toBe("12");
    expect(batchPatchNamed.items[0].field_101).toBeUndefined();
    expect(batchPatchNamed.metadata.updated_field_ids.sort((a: number, b: number) => a - b)).toEqual([101, 108]);
  });

  it("lists rows with Baserow multi-field order_by and user field names", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "Zed", field_108: 1 },
        { field_101: "Alpha", field_108: 2 },
        { field_101: "Beta", field_108: 2 },
      ],
    });
    expect(createdResponse.status).toBe(200);

    const byIdsResponse = await api(env, ctx, token, "/api/database/rows/table/20/?order_by=field_108,-field_101&size=10", "GET", undefined);
    expect(byIdsResponse.status).toBe(200);
    const byIds = await byIdsResponse.json() as any;
    expect(byIds.results.map((row: any) => row.field_101)).toEqual(["Zed", "Beta", "Alpha"]);

    const byNamesResponse = await api(env, ctx, token, "/api/database/rows/table/20/?user_field_names=true&order_by=Discount,-Name&size=10", "GET", undefined);
    expect(byNamesResponse.status).toBe(200);
    const byNames = await byNamesResponse.json() as any;
    expect(byNames.results.map((row: any) => row.Name)).toEqual(["Zed", "Beta", "Alpha"]);
    expect(Object.keys(byNames.results[0])).toEqual(expect.arrayContaining(["Name", "Discount"]));
    expect(byNames.results[0].field_101).toBeUndefined();
  });

  it("converts text values to select options without dropping row values", async () => {
    const { env, ctx, token } = await setupRowsFixture();
    const fieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Stage Convert",
      type: "text",
    });
    expect(fieldResponse.status).toBe(200);
    const field = await fieldResponse.json() as any;

    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "One", [`field_${field.id}`]: "Ready" },
        { field_101: "Two", [`field_${field.id}`]: "Blocked" },
      ],
    });
    expect(createdResponse.status).toBe(200);

    const uniqueResponse = await api(
      env,
      ctx,
      token,
      `/api/database/fields/${field.id}/unique_row_values/?limit=100`,
      "GET",
      undefined
    );
    expect(uniqueResponse.status).toBe(200);
    const unique = await uniqueResponse.json() as { values: string[] };

    const convertedResponse = await api(env, ctx, token, `/api/database/fields/${field.id}/`, "PATCH", {
      type: "single_select",
      select_options: unique.values.map((value) => ({ value, color: "blue" })),
    });
    expect(convertedResponse.status).toBe(200);
    const converted = await convertedResponse.json() as any;
    expect(converted.select_options.map((option: any) => option.value)).toEqual(["Blocked", "Ready"]);

    const rowsResponse = await api(env, ctx, token, `/api/database/rows/table/20/?order_by=field_101&size=10`, "GET", undefined);
    expect(rowsResponse.status).toBe(200);
    const rows = await rowsResponse.json() as any;
    const convertedValues = rows.results
      .filter((row: any) => ["One", "Two"].includes(row.field_101))
      .map((row: any) => row[`field_${field.id}`]?.value);
    expect(convertedValues).toEqual(["Ready", "Blocked"]);
  });

  it("propagates select option renames and removals into existing cells", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const rowsResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "First", field_106: 201, field_107: [203, 204] },
        { field_101: "Second", field_106: 202, field_107: [203] },
      ],
    });
    expect(rowsResponse.status).toBe(200);
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], created_on, updated_on)
       VALUES (501, 20, 'Select form', 'form', 1, ?, ?)`
    ).bind(now, now).run();
    const formOption = await db.prepare(
      `INSERT INTO database_formviewfieldoptions
       (form_view_id, field_id, name, description, enabled, required, [order],
        show_when_matching_conditions, condition_type, include_all_select_options, field_component)
       VALUES (501, 106, '', '', 1, 0, 1, 0, 'AND', 0, 'default')
       RETURNING id`
    ).first<{ id: number }>();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptions_allowedselectoptions
       (form_view_field_options_id, select_option_id) VALUES (?, 201), (?, 202)`
    ).bind(formOption!.id, formOption!.id).run();

    const singleUpdate = await api(env, ctx, token, "/api/database/fields/106/", "PATCH", {
      select_options: [{ id: 202, value: "Backlog", color: "green" }],
    });
    expect(singleUpdate.status).toBe(200);
    const updatedSingle = await singleUpdate.json() as any;
    expect(updatedSingle.single_select_default).toBeNull();
    expect(updatedSingle.select_options).toEqual([
      expect.objectContaining({ id: 202, value: "Backlog", color: "green" }),
    ]);
    expect((await db.prepare(
      "SELECT select_option_id FROM database_formviewfieldoptions_allowedselectoptions WHERE form_view_field_options_id=?"
    ).bind(formOption!.id).all()).results).toEqual([{ select_option_id: 202 }]);

    const multipleUpdate = await api(env, ctx, token, "/api/database/fields/107/", "PATCH", {
      select_options: [{ id: 204, value: "Indigo", color: "purple" }],
    });
    expect(multipleUpdate.status).toBe(200);
    expect((await multipleUpdate.json() as any).multiple_select_default).toEqual([204]);

    const listed = await api(env, ctx, token, "/api/database/rows/table/20/?order_by=field_101&size=10", "GET", undefined);
    const rows = (await listed.json() as any).results.filter((row: any) => ["First", "Second"].includes(row.field_101));
    expect(rows[0].field_106).toBeNull();
    expect(rows[0].field_107).toEqual([{ id: 204, value: "Indigo", color: "purple" }]);
    expect(rows[1].field_106).toEqual({ id: 202, value: "Backlog", color: "green" });
    expect(rows[1].field_107).toEqual([]);
  });

  it("converts source-proven text cells and reapplies storage-affecting field settings", async () => {
    const { env, ctx, token } = await setupRowsFixture();
    const numberField = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Converted number",
      type: "text",
    })).json() as any;
    const dateField = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Converted date",
      type: "text",
    })).json() as any;
    const uuidField = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Converted UUID",
      type: "text",
    })).json() as any;
    const precisionField = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Precision",
      type: "number",
      number_decimal_places: 3,
      number_negative: true,
    })).json() as any;
    const ratingField = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Rating clamp",
      type: "rating",
      max_value: 5,
    })).json() as any;

    const created = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        {
          field_101: "Conversion A",
          [`field_${numberField.id}`]: "100.59999",
          [`field_${dateField.id}`]: "22/07/2021",
          [`field_${uuidField.id}`]: "Row 1",
          [`field_${precisionField.id}`]: "4.555",
          [`field_${ratingField.id}`]: 5,
        },
        {
          field_101: "Conversion B",
          [`field_${numberField.id}`]: "-100",
          [`field_${dateField.id}`]: "INVALID",
          [`field_${uuidField.id}`]: "Row 2",
          [`field_${precisionField.id}`]: "-2.000",
          [`field_${ratingField.id}`]: 2,
        },
      ],
    });
    expect(created.status).toBe(200);

    const numberConversion = await api(env, ctx, token, `/api/database/fields/${numberField.id}/`, "PATCH", {
      type: "number",
      number_decimal_places: 0,
      number_negative: false,
    });
    expect(numberConversion.status).toBe(200);
    const dateConversion = await api(env, ctx, token, `/api/database/fields/${dateField.id}/`, "PATCH", {
      type: "date",
      date_format: "EU",
      date_include_time: false,
      date_time_format: "24",
    });
    expect(dateConversion.status).toBe(200);
    const uuidConversion = await api(env, ctx, token, `/api/database/fields/${uuidField.id}/`, "PATCH", {
      type: "uuid",
    });
    expect(uuidConversion.status).toBe(200);

    const precisionUpdate = await api(env, ctx, token, `/api/database/fields/${precisionField.id}/`, "PATCH", {
      number_decimal_places: 1,
      number_negative: false,
    });
    expect(precisionUpdate.status).toBe(200);
    const ratingUpdate = await api(env, ctx, token, `/api/database/fields/${ratingField.id}/`, "PATCH", {
      max_value: 3,
    });
    expect(ratingUpdate.status).toBe(200);

    const rowsResponse = await api(env, ctx, token, "/api/database/rows/table/20/?order_by=field_101&size=100", "GET", undefined);
    expect(rowsResponse.status).toBe(200);
    const rows = (await rowsResponse.json() as any).results.filter((row: any) => row.field_101.startsWith("Conversion "));
    expect(rows).toHaveLength(2);
    expect(rows.map((row: any) => row[`field_${numberField.id}`])).toEqual(["101", "0"]);
    expect(rows.map((row: any) => row[`field_${dateField.id}`])).toEqual(["2021-07-22", null]);
    expect(rows.map((row: any) => row[`field_${precisionField.id}`])).toEqual(["4.6", "0.0"]);
    expect(rows.map((row: any) => row[`field_${ratingField.id}`])).toEqual([3, 2]);
    const uuids = rows.map((row: any) => row[`field_${uuidField.id}`]);
    expect(uuids[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(uuids[1]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(uuids[1]).not.toBe(uuids[0]);
  });

  it("reconverts existing duration values when duration_format changes", async () => {
    const { env, ctx, token } = await setupRowsFixture();
    const fieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Elapsed",
      type: "duration",
      duration_format: "h:mm:ss.sss",
    });
    expect(fieldResponse.status).toBe(200);
    const field = await fieldResponse.json() as any;

    const rowsResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "Duration A", [`field_${field.id}`]: 1.199 },
        { field_101: "Duration B", [`field_${field.id}`]: 50.6789 },
        { field_101: "Duration C", [`field_${field.id}`]: 86461 },
      ],
    });
    expect(rowsResponse.status).toBe(200);

    const updateResponse = await api(env, ctx, token, `/api/database/fields/${field.id}/`, "PATCH", {
      duration_format: "h:mm",
    });
    expect(updateResponse.status).toBe(200);

    const listedResponse = await api(env, ctx, token, "/api/database/rows/table/20/?order_by=field_101&size=100", "GET", undefined);
    const rows = (await listedResponse.json() as any).results.filter((row: any) => row.field_101.startsWith("Duration "));
    expect(rows.map((row: any) => row[`field_${field.id}`])).toEqual([0, 60, 86460]);
  });

  it("shifts datetime cells with the write-only Baserow timezone offset", async () => {
    const { env, ctx, token } = await setupRowsFixture();
    const invalidCreate = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Invalid offset",
      type: "date",
      date_include_time: true,
      date_force_timezone_offset: 60,
    });
    expect(invalidCreate.status).toBe(400);

    const fieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Timestamp",
      type: "date",
      date_include_time: true,
      date_format: "ISO",
      date_time_format: "24",
    });
    const field = await fieldResponse.json() as any;
    const rowsResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "Offset A", [`field_${field.id}`]: "2022-01-01T00:00:00.000Z" },
        { field_101: "Offset B", [`field_${field.id}`]: "2022-01-01T23:30:00.000Z" },
      ],
    });
    expect(rowsResponse.status).toBe(200);

    const positive = await api(env, ctx, token, `/api/database/fields/${field.id}/`, "PATCH", {
      date_force_timezone: "Europe/Rome",
      date_force_timezone_offset: 60,
    });
    expect(positive.status).toBe(200);
    expect((await positive.json() as any).date_force_timezone_offset).toBeUndefined();

    const negative = await api(env, ctx, token, `/api/database/fields/${field.id}/`, "PATCH", {
      date_force_timezone: "Etc/GMT-2",
      date_force_timezone_offset: -180,
    });
    expect(negative.status).toBe(200);
    const listedResponse = await api(env, ctx, token, "/api/database/rows/table/20/?order_by=field_101&size=100", "GET", undefined);
    const rows = (await listedResponse.json() as any).results.filter((row: any) => row.field_101.startsWith("Offset "));
    expect(rows.map((row: any) => row[`field_${field.id}`])).toEqual([
      "2021-12-31T22:00:00.000Z",
      "2022-01-01T21:30:00.000Z",
    ]);
  });

  it("initializes generated metadata fields for active and trashed existing rows", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [{ field_101: "Generated active" }, { field_101: "Generated trashed" }],
    });
    const created = (await createdResponse.json() as any).items;
    expect((await api(env, ctx, token, `/api/database/rows/table/20/${created[1].id}/`, "DELETE", undefined)).status).toBe(200);

    const generatedTypes = ["uuid", "created_on", "last_modified", "created_by", "last_modified_by"] as const;
    const generatedFields: Record<string, any> = {};
    for (const type of generatedTypes) {
      const response = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
        name: `Generated ${type}`,
        type,
      });
      expect(response.status).toBe(200);
      generatedFields[type] = await response.json();
    }

    const stored = await db.prepare(
      `SELECT *, field_101 AS name FROM "database_table_20" WHERE id IN (?, ?) ORDER BY id ASC`
    ).bind(created[0].id, created[1].id).all<any>();
    expect(stored.results).toHaveLength(2);
    for (const row of stored.results) {
      expect(row[`field_${generatedFields.uuid.id}`]).toMatch(/^[0-9a-f-]{36}$/i);
      expect(row[`field_${generatedFields.created_on.id}`]).toBe(row._created_on);
      expect(row[`field_${generatedFields.last_modified.id}`]).toBe(row._updated_on);
      expect(JSON.parse(row[`field_${generatedFields.created_by.id}`])).toEqual({
        id: 7,
        name: "User Example",
        email: "user@example.com",
      });
      expect(JSON.parse(row[`field_${generatedFields.last_modified_by.id}`])).toEqual({
        id: 7,
        name: "User Example",
        email: "user@example.com",
      });
    }

    expect((await api(env, ctx, token, `/api/trash/row/${created[1].id}/restore/?parent_trash_item_id=20`, "PATCH", undefined)).status).toBe(200);
    const restoredResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created[1].id}/`, "GET", undefined);
    const restored = await restoredResponse.json() as any;
    expect(restored[`field_${generatedFields.uuid.id}`]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(restored[`field_${generatedFields.created_by.id}`]).toEqual({ id: 7, name: "User Example", email: "user@example.com" });
  });

  it("backfills field defaults on creation and only applies later default changes to new rows", async () => {
    const { env, ctx, token } = await setupRowsFixture();
    const existingResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", { field_101: "Existing defaults" });
    const existing = await existingResponse.json() as any;
    const definitions = [
      { name: "Default text", type: "text", text_default: "Ready" },
      { name: "Default number", type: "number", number_default: "7.5", number_decimal_places: 1, number_negative: true },
      { name: "Default boolean", type: "boolean", boolean_default: true },
      { name: "Default rating", type: "rating", max_value: 5 },
      {
        name: "Default single",
        type: "single_select",
        single_select_default: 501,
        select_options: [{ id: 501, value: "Chosen", color: "green" }],
      },
      {
        name: "Default multiple",
        type: "multiple_select",
        multiple_select_default: [502, 503],
        select_options: [
          { id: 502, value: "Red", color: "red" },
          { id: 503, value: "Blue", color: "blue" },
        ],
      },
    ];
    const createdFields: Record<string, any> = {};
    for (const definition of definitions) {
      const response = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", definition);
      expect(response.status).toBe(200);
      createdFields[definition.name] = await response.json();
    }

    const readExisting = await api(env, ctx, token, `/api/database/rows/table/20/${existing.id}/`, "GET", undefined);
    const existingWithDefaults = await readExisting.json() as any;
    expect(existingWithDefaults[`field_${createdFields["Default text"].id}`]).toBe("Ready");
    expect(existingWithDefaults[`field_${createdFields["Default number"].id}`]).toBe("7.5");
    expect(existingWithDefaults[`field_${createdFields["Default boolean"].id}`]).toBe(true);
    expect(existingWithDefaults[`field_${createdFields["Default rating"].id}`]).toBe(0);
    expect(existingWithDefaults[`field_${createdFields["Default single"].id}`]).toMatchObject({ id: 501, value: "Chosen" });
    expect(existingWithDefaults[`field_${createdFields["Default multiple"].id}`].map((option: any) => option.id)).toEqual([502, 503]);

    const newResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", { field_101: "New defaults" });
    const newRow = await newResponse.json() as any;
    expect(newRow[`field_${createdFields["Default text"].id}`]).toBe("Ready");
    expect(newRow[`field_${createdFields["Default number"].id}`]).toBe("7.5");
    expect(newRow[`field_${createdFields["Default boolean"].id}`]).toBe(true);
    expect(newRow[`field_${createdFields["Default rating"].id}`]).toBe(0);
    expect(newRow[`field_${createdFields["Default single"].id}`].id).toBe(501);
    expect(newRow[`field_${createdFields["Default multiple"].id}`].map((option: any) => option.id)).toEqual([502, 503]);

    const numberField = createdFields["Default number"];
    expect((await api(env, ctx, token, `/api/database/fields/${numberField.id}/`, "PATCH", { number_default: "9.0" })).status).toBe(200);
    const laterResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", { field_101: "Later default" });
    const later = await laterResponse.json() as any;
    expect(later[`field_${numberField.id}`]).toBe("9.0");
    const existingAgain = await api(env, ctx, token, `/api/database/rows/table/20/${existing.id}/`, "GET", undefined);
    expect((await existingAgain.json() as any)[`field_${numberField.id}`]).toBe("7.5");
  });

  it("returns typed unique row values as labels sorted by frequency", async () => {
    const { env, ctx, token } = await setupRowsFixture();
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "One", field_106: 201, field_107: [203, 204], field_109: [7] },
        { field_101: "Two", field_106: 201, field_107: [203], field_109: [7] },
        { field_101: "Three", field_106: 202, field_107: [204], field_109: [7] },
      ],
    });
    expect(createdResponse.status).toBe(200);

    const singleResponse = await api(env, ctx, token, "/api/database/fields/106/unique_row_values/?limit=10", "GET", undefined);
    expect(singleResponse.status).toBe(200);
    await expect(singleResponse.json()).resolves.toEqual({ values: ["Todo", "Done"] });

    const multipleResponse = await api(env, ctx, token, "/api/database/fields/107/unique_row_values/?limit=10", "GET", undefined);
    expect(multipleResponse.status).toBe(400);
    await expect(multipleResponse.json()).resolves.toMatchObject({
      error: "ERROR_INCOMPATIBLE_FIELD_TYPE_FOR_UNIQUE_VALUES",
    });

    const collaboratorResponse = await api(env, ctx, token, "/api/database/fields/109/unique_row_values/?limit=10", "GET", undefined);
    expect(collaboratorResponse.status).toBe(400);
    await expect(collaboratorResponse.json()).resolves.toMatchObject({
      error: "ERROR_INCOMPATIBLE_FIELD_TYPE_FOR_UNIQUE_VALUES",
    });

    const textFieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Comma values",
      type: "text",
    });
    const textField = await textFieldResponse.json() as any;
    await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "A", [`field_${textField.id}`]: "Alpha, Beta" },
        { field_101: "B", [`field_${textField.id}`]: "Alpha" },
      ],
    });
    const splitResponse = await api(env, ctx, token, `/api/database/fields/${textField.id}/unique_row_values/?split_comma_separated=true&limit=10`, "GET", undefined);
    expect(splitResponse.status).toBe(200);
    await expect(splitResponse.json()).resolves.toEqual({ values: ["Alpha", "Beta"] });
  });

  it("creates and synchronizes reciprocal link-row fields like Baserow", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_table
       (id, database_id, name, [order], version, trashed, created_on, updated_on,
        needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (21, 10, 'Customers', 2, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 21);
    await createField(db, 21, 210, "Customer name", "text", 1);

    const targetResponse = await api(env, ctx, token, "/api/database/rows/table/21/", "POST", {
      field_210: "Target A",
    });
    const target = await targetResponse.json() as any;
    const sourceResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Source A",
    });
    const source = await sourceResponse.json() as any;

    const fieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Customer",
      type: "link_row",
      link_row_table_id: 21,
      link_row_table: 21,
      has_related_field: true,
      link_row_multiple_relationships: true,
    });
    expect(fieldResponse.status).toBe(200);
    const link = await fieldResponse.json() as any;
    expect(link).toMatchObject({
      type: "link_row",
      link_row_table_id: 21,
      link_row_related_field: expect.any(Number),
      link_row_related_field_id: expect.any(Number),
    });
    expect(link.link_row_related_field).toBe(link.link_row_related_field_id);
    expect(link.related_fields).toHaveLength(1);
    const related = link.related_fields[0];
    expect(related).toMatchObject({
      id: link.link_row_related_field_id,
      table_id: 21,
      name: "Rows",
      type: "link_row",
      link_row_table_id: 20,
      link_row_related_field_id: link.id,
      link_row_related_field: link.id,
    });

    const linkResponse = await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "PATCH", {
      [`field_${link.id}`]: [target.id],
    });
    expect(linkResponse.status).toBe(200);
    expect((await linkResponse.json() as any)[`field_${link.id}`]).toEqual([
      { id: target.id, value: "Target A", order: "10000" },
    ]);

    const targetLinked = await api(env, ctx, token, `/api/database/rows/table/21/${target.id}/`, "GET", undefined);
    expect((await targetLinked.json() as any)[`field_${related.id}`]).toEqual([
      { id: source.id, value: "Source A", order: "10000" },
    ]);

    const renameResponse = await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "PATCH", {
      field_101: "Source renamed",
    });
    expect(renameResponse.status).toBe(200);
    const targetRenamed = await api(env, ctx, token, `/api/database/rows/table/21/${target.id}/`, "GET", undefined);
    expect((await targetRenamed.json() as any)[`field_${related.id}`]).toEqual([
      { id: source.id, value: "Source renamed", order: "10000" },
    ]);

    const reverseUnlink = await api(env, ctx, token, `/api/database/rows/table/21/${target.id}/`, "PATCH", {
      [`field_${related.id}`]: [],
    });
    expect(reverseUnlink.status).toBe(200);
    const sourceUnlinked = await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "GET", undefined);
    expect((await sourceUnlinked.json() as any)[`field_${link.id}`]).toEqual([]);

    const restricted = await api(env, ctx, token, `/api/database/fields/${link.id}/`, "PATCH", {
      link_row_multiple_relationships: false,
    });
    expect(restricted.status).toBe(200);
    const secondTarget = await (await api(env, ctx, token, "/api/database/rows/table/21/", "POST", {
      field_210: "Target B",
    })).json() as any;
    const tooMany = await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "PATCH", {
      [`field_${link.id}`]: [target.id, secondTarget.id],
    });
    expect(tooMany.status).toBe(400);

    const selfRelated = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Invalid self relation",
      type: "link_row",
      link_row_table_id: 20,
      has_related_field: true,
    });
    expect(selfRelated.status).toBe(400);
    await expect(selfRelated.json()).resolves.toMatchObject({
      error: "ERROR_SELF_REFERENCING_LINK_ROW_CANNOT_HAVE_RELATED_FIELD",
    });

    const missingTarget = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Missing target",
      type: "link_row",
    });
    expect(missingTarget.status).toBe(400);
    await expect(missingTarget.json()).resolves.toMatchObject({ error: "ERROR_LINK_ROW_TABLE_NOT_PROVIDED" });

    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (11, 1, 'Other database', 'database', 2, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_table
       (id, database_id, name, [order], version, trashed, created_on, updated_on,
        needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (30, 11, 'Other table', 1, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    const crossDatabase = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Cross database",
      type: "link_row",
      link_row_table_id: 30,
    });
    expect(crossDatabase.status).toBe(400);
    await expect(crossDatabase.json()).resolves.toMatchObject({ error: "ERROR_LINK_ROW_TABLE_NOT_IN_SAME_DATABASE" });
  });

  it("moves, removes and recreates reciprocal link-row fields when settings change", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const now = new Date().toISOString();
    for (const [id, name, order] of [[21, "Customers", 2], [22, "Companies", 3]] as const) {
      await db.prepare(
        `INSERT INTO database_table
         (id, database_id, name, [order], version, trashed, created_on, updated_on,
          needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
         VALUES (?, 10, ?, ?, 1, 0, ?, ?, 0, 0, 0)`
      ).bind(id, name, order, now, now).run();
      await getOrCreateUserTable(db as any, id);
    }
    await createField(db, 21, 210, "Customer name", "text", 1);
    await createField(db, 22, 220, "Company name", "text", 1);
    const customer = await (await api(env, ctx, token, "/api/database/rows/table/21/", "POST", {
      field_210: "Same numeric id in customers",
    })).json() as any;
    const company = await (await api(env, ctx, token, "/api/database/rows/table/22/", "POST", {
      field_220: "Same numeric id in companies",
    })).json() as any;
    expect(company.id).toBe(customer.id);
    const source = await (await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Source",
    })).json() as any;

    const link = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Target",
      type: "link_row",
      link_row_table_id: 21,
      has_related_field: true,
    })).json() as any;
    const originalRelatedId = link.link_row_related_field_id;
    await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "PATCH", {
      [`field_${link.id}`]: [customer.id],
    });

    const movedResponse = await api(env, ctx, token, `/api/database/fields/${link.id}/`, "PATCH", {
      link_row_table_id: 22,
      has_related_field: true,
    });
    expect(movedResponse.status).toBe(200);
    const moved = await movedResponse.json() as any;
    expect(moved.link_row_related_field_id).toBe(originalRelatedId);
    expect(moved.related_fields).toEqual([
      expect.objectContaining({ id: originalRelatedId, table_id: 22, link_row_table_id: 20 }),
    ]);
    const clearedSource = await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "GET", undefined);
    expect((await clearedSource.json() as any)[`field_${link.id}`]).toEqual([]);
    expect((await db.prepare("PRAGMA table_info(\"database_table_21\")").all()).results.map((column: any) => column.name))
      .not.toContain(`field_${originalRelatedId}`);
    expect((await db.prepare("PRAGMA table_info(\"database_table_22\")").all()).results.map((column: any) => column.name))
      .toContain(`field_${originalRelatedId}`);

    const withoutRelatedResponse = await api(env, ctx, token, `/api/database/fields/${link.id}/`, "PATCH", {
      has_related_field: false,
    });
    expect(withoutRelatedResponse.status).toBe(200);
    const withoutRelated = await withoutRelatedResponse.json() as any;
    expect(withoutRelated.link_row_related_field_id).toBeNull();
    expect(await db.prepare("SELECT id FROM database_field WHERE id=?").bind(originalRelatedId).first()).toBeNull();

    const recreatedResponse = await api(env, ctx, token, `/api/database/fields/${link.id}/`, "PATCH", {
      has_related_field: true,
    });
    expect(recreatedResponse.status).toBe(200);
    const recreated = await recreatedResponse.json() as any;
    expect(recreated.link_row_related_field_id).toEqual(expect.any(Number));
    expect(recreated.link_row_related_field_id).not.toBe(originalRelatedId);

    await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "PATCH", {
      [`field_${link.id}`]: [company.id],
    });
    const asTextResponse = await api(env, ctx, token, `/api/database/fields/${link.id}/`, "PATCH", {
      type: "text",
    });
    expect(asTextResponse.status).toBe(200);
    const asText = await asTextResponse.json() as any;
    expect(asText.type).toBe("text");
    expect(await db.prepare("SELECT id FROM database_field WHERE id=?").bind(recreated.link_row_related_field_id).first())
      .toBeNull();
    const convertedRow = await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "GET", undefined);
    expect((await convertedRow.json() as any)[`field_${link.id}`]).toBeNull();
  });

  it("trashes, restores and permanently deletes both sides of a link-row field", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_table
       (id, database_id, name, [order], version, trashed, created_on, updated_on,
        needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (21, 10, 'Targets', 2, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 21);
    await createField(db, 21, 210, "Target name", "text", 1);
    const link = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Target",
      type: "link_row",
      link_row_table_id: 21,
    })).json() as any;
    const relatedId = link.link_row_related_field_id;

    const deleteResponse = await api(env, ctx, token, `/api/database/fields/${link.id}/`, "DELETE", undefined);
    expect(deleteResponse.status).toBe(200);
    expect(await db.prepare("SELECT id, trashed FROM database_field WHERE id IN (?, ?) ORDER BY id")
      .bind(link.id, relatedId).all()).toEqual({
      results: [
        expect.objectContaining({ id: link.id, trashed: 1 }),
        expect.objectContaining({ id: relatedId, trashed: 1 }),
      ],
    });

    const restoreResponse = await api(env, ctx, token, `/api/trash/field/${link.id}/restore/`, "PATCH", undefined);
    expect(restoreResponse.status).toBe(200);
    expect((await db.prepare("SELECT trashed FROM database_field WHERE id IN (?, ?) ORDER BY id")
      .bind(link.id, relatedId).all()).results).toEqual([{ trashed: 0 }, { trashed: 0 }]);

    await api(env, ctx, token, `/api/database/fields/${link.id}/`, "DELETE", undefined);
    const permanentResponse = await api(
      env,
      ctx,
      token,
      `/api/trash/field/${link.id}/?workspace_id=1`,
      "DELETE",
      undefined
    );
    expect(permanentResponse.status).toBe(200);
    expect((await db.prepare("SELECT id FROM database_field WHERE id IN (?, ?)").bind(link.id, relatedId).all()).results)
      .toEqual([]);
    expect((await db.prepare("PRAGMA table_info(\"database_table_20\")").all()).results.map((column: any) => column.name))
      .not.toContain(`field_${link.id}`);
    expect((await db.prepare("PRAGMA table_info(\"database_table_21\")").all()).results.map((column: any) => column.name))
      .not.toContain(`field_${relatedId}`);
  });

  it("computes count, lookup and Baserow rollups across linked tables", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_table
       (id, database_id, name, [order], version, trashed, created_on, updated_on,
        needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (21, 10, 'Rollup targets', 2, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 21);
    await createField(db, 21, 210, "Target name", "text", 1);
    await createField(db, 21, 211, "Amount", "number", 2);
    await createField(db, 21, 212, "Active", "boolean", 3);

    const firstTarget = await (await api(env, ctx, token, "/api/database/rows/table/21/", "POST", {
      field_210: "Alpha",
      field_211: 10,
      field_212: false,
    })).json() as any;
    const secondTarget = await (await api(env, ctx, token, "/api/database/rows/table/21/", "POST", {
      field_210: "Beta",
      field_211: 20,
      field_212: true,
    })).json() as any;
    const sourceRow = await (await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Computed source",
    })).json() as any;

    const link = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Targets",
      type: "link_row",
      link_row_table_id: 21,
    })).json() as any;
    const count = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Target count",
      type: "count",
      through_field_id: link.id,
    })).json() as any;
    const lookup = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Amounts",
      type: "lookup",
      through_field_id: link.id,
      target_field_id: 211,
    })).json() as any;
    const sum = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Amount sum",
      type: "rollup",
      through_field_id: link.id,
      target_field_id: 211,
      rollup_function: "sum",
    })).json() as any;
    const maximum = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Maximum name",
      type: "rollup",
      through_field_id: link.id,
      target_field_id: 210,
      rollup_function: "max",
    })).json() as any;
    const anyActive = await (await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Any active",
      type: "rollup",
      through_field_id: link.id,
      target_field_id: 212,
      rollup_function: "any",
    })).json() as any;

    expect(count).toMatchObject({ formula_type: "number", nullable: false });
    expect(lookup).toMatchObject({ formula_type: "array", array_formula_type: "number" });
    expect(sum).toMatchObject({ formula_type: "number", nullable: false });
    expect(maximum).toMatchObject({ formula_type: "text", nullable: true });
    expect(anyActive).toMatchObject({ formula_type: "boolean", nullable: true });

    for (const invalidRollup of [
      { name: "Invalid text sum", target_field_id: 210, rollup_function: "sum" },
      { name: "Invalid number any", target_field_id: 211, rollup_function: "any" },
      { name: "Invalid boolean max", target_field_id: 212, rollup_function: "max" },
    ]) {
      const response = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
        ...invalidRollup,
        type: "rollup",
        through_field_id: link.id,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "ERROR_INVALID_ROLLUP_FORMULA_FUNCTION" });
    }

    await api(env, ctx, token, `/api/database/rows/table/20/${sourceRow.id}/`, "PATCH", {
      [`field_${link.id}`]: [firstTarget.id, secondTarget.id],
    });
    const readSource = async () => {
      const response = await api(env, ctx, token, `/api/database/rows/table/20/${sourceRow.id}/`, "GET", undefined);
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    await expect(readSource()).resolves.toMatchObject({
      [`field_${count.id}`]: "2",
      [`field_${lookup.id}`]: [{ id: firstTarget.id, value: "10" }, { id: secondTarget.id, value: "20" }],
      [`field_${sum.id}`]: "30",
      [`field_${maximum.id}`]: "Beta",
      [`field_${anyActive.id}`]: true,
    });

    const dependencyRows = await db.prepare(
      `SELECT dependant_id, dependency_id, via_id
       FROM database_fielddependency
       WHERE dependant_id IN (?, ?, ?, ?, ?)
       ORDER BY dependant_id ASC`
    ).bind(count.id, lookup.id, sum.id, maximum.id, anyActive.id).all<any>();
    expect(dependencyRows.results).toEqual([
      { dependant_id: count.id, dependency_id: 210, via_id: link.id },
      { dependant_id: lookup.id, dependency_id: 211, via_id: link.id },
      { dependant_id: sum.id, dependency_id: 211, via_id: link.id },
      { dependant_id: maximum.id, dependency_id: 210, via_id: link.id },
      { dependant_id: anyActive.id, dependency_id: 212, via_id: link.id },
    ]);

    await api(env, ctx, token, `/api/database/rows/table/21/${secondTarget.id}/`, "PATCH", { field_211: 30 });
    await expect(readSource()).resolves.toMatchObject({
      [`field_${lookup.id}`]: [{ id: firstTarget.id, value: "10" }, { id: secondTarget.id, value: "30" }],
      [`field_${sum.id}`]: "40",
    });

    await api(env, ctx, token, `/api/database/rows/table/21/${secondTarget.id}/`, "DELETE", undefined);
    await expect(readSource()).resolves.toMatchObject({
      [`field_${count.id}`]: "1",
      [`field_${lookup.id}`]: [{ id: firstTarget.id, value: "10" }],
      [`field_${sum.id}`]: "10",
      [`field_${anyActive.id}`]: false,
    });
    const restoreResponse = await api(
      env,
      ctx,
      token,
      `/api/trash/row/${secondTarget.id}/restore/?parent_trash_item_id=21`,
      "PATCH",
      undefined
    );
    expect(restoreResponse.status).toBe(200);
    await expect(readSource()).resolves.toMatchObject({
      [`field_${count.id}`]: "2",
      [`field_${lookup.id}`]: [{ id: firstTarget.id, value: "10" }, { id: secondTarget.id, value: "30" }],
      [`field_${sum.id}`]: "40",
      [`field_${anyActive.id}`]: true,
    });

    const renameTargetResponse = await api(env, ctx, token, `/api/database/rows/table/21/${secondTarget.id}/`, "PATCH", {
      field_210: "Beta updated",
    });
    expect(renameTargetResponse.status).toBe(200);
    const renamedLinks = await readSource();
    expect(renamedLinks[`field_${link.id}`].map((item: any) => ({ id: item.id, value: item.value }))).toEqual([
      { id: firstTarget.id, value: "Alpha" },
      { id: secondTarget.id, value: "Beta updated" },
    ]);

    const moveTargetResponse = await api(
      env,
      ctx,
      token,
      `/api/database/rows/table/21/${firstTarget.id}/move/`,
      "PATCH",
      null
    );
    expect(moveTargetResponse.status).toBe(200);
    const reordered = await readSource();
    expect(reordered[`field_${link.id}`].map((item: any) => item.id)).toEqual([secondTarget.id, firstTarget.id]);
    expect(reordered[`field_${lookup.id}`]).toEqual([
      { id: secondTarget.id, value: "30" },
      { id: firstTarget.id, value: "10" },
    ]);
    expect(reordered[`field_${sum.id}`]).toBe("40");
  });

  it("serializes available workspace collaborators for collaborator fields", async () => {
    const { env, ctx, token } = await setupRowsFixture();

    const response = await api(env, ctx, token, "/api/database/fields/table/20/", "GET", undefined);
    expect(response.status).toBe(200);
    const fields = await response.json() as any[];
    const collaboratorsField = fields.find((field) => field.id === 109);

    expect(collaboratorsField).toMatchObject({
      id: 109,
      type: "multiple_collaborators",
      notify_user_when_added: false,
    });
    expect(collaboratorsField.available_collaborators).toEqual([
      { id: 8, name: "Ada Lovelace" },
      { id: 7, name: "User Example" },
    ]);
  });

  it("enforces the Baserow collaborator request and workspace membership contract", async () => {
    const { env, ctx, token } = await setupRowsFixture();

    const valid = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Assigned",
      field_109: [8, { id: "7" }],
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({
      field_109: [
        { id: 8, name: "Ada Lovelace" },
        { id: 7, name: "User Example" },
      ],
    });

    for (const invalidValue of [
      [9],
      [999],
      [8, 8],
      ["ada@example.com"],
      null,
    ]) {
      const response = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
        field_101: "Invalid assignee",
        field_109: invalidValue,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });
    }
  });

  it("notifies only newly added collaborators when the field setting is enabled", async () => {
    const { db, env, ctx, token, broadcasts } = await setupRowsFixture();
    const fieldResponse = await api(env, ctx, token, "/api/database/fields/109/", "PATCH", {
      notify_user_when_added: true,
    });
    expect(fieldResponse.status).toBe(200);

    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Notification row",
      field_109: [8],
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as any;

    const notificationsAfterCreate = await db.prepare(
      `SELECT n.id, n.type, n.sender_id, n.workspace_id, n.data, nr.recipient_id
       FROM core_notification n
       JOIN core_notificationrecipient nr ON nr.notification_id=n.id
       WHERE n.type='collaborator_added_to_row'
       ORDER BY n.id ASC`
    ).all<any>();
    expect(notificationsAfterCreate.results).toHaveLength(1);
    expect(notificationsAfterCreate.results[0]).toMatchObject({
      type: "collaborator_added_to_row",
      sender_id: 7,
      workspace_id: 1,
      recipient_id: 8,
    });
    expect(JSON.parse(notificationsAfterCreate.results[0].data)).toMatchObject({
      row_id: created.id,
      row_name: "Notification row",
      field_id: 109,
      field_name: "Assignees",
      table_id: 20,
      table_name: "Rows",
      database_id: 10,
      database_name: "Database",
    });
    const realtime = broadcasts.find((item) => item.message?.type === "notifications_created");
    expect(realtime).toMatchObject({
      user_ids: [8],
      message: {
        type: "notifications_created",
        notifications: [{
          id: notificationsAfterCreate.results[0].id,
          type: "collaborator_added_to_row",
          sender: { id: 7, username: "user@example.com", first_name: "User" },
          workspace: { id: 1 },
          read: false,
          data: {
            row_id: created.id,
            row_name: "Notification row",
            field_id: 109,
          },
        }],
      },
    });

    const unchanged = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "PATCH", {
      field_109: [{ id: 8 }],
    });
    expect(unchanged.status).toBe(200);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM core_notification WHERE type='collaborator_added_to_row'").first<any>())?.count).toBe(1);

    const added = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "PATCH", {
      field_109: [8, 7],
    });
    expect(added.status).toBe(200);
    const recipients = await db.prepare(
      `SELECT nr.recipient_id
       FROM core_notification n
       JOIN core_notificationrecipient nr ON nr.notification_id=n.id
       WHERE n.type='collaborator_added_to_row'
       ORDER BY n.id ASC`
    ).all<{ recipient_id: number }>();
    expect(recipients.results.map((row) => row.recipient_id)).toEqual([8, 7]);

    const removed = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "PATCH", {
      field_109: [7],
    });
    expect(removed.status).toBe(200);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM core_notification WHERE type='collaborator_added_to_row'").first<any>())?.count).toBe(2);
  });

  it("validates and serializes AI field settings and choice options like Baserow", async () => {
    const { env, ctx, token } = await setupRowsFixture();
    env.CACHE.get = async (key: string) => key === "workspace:1:generative-ai"
      ? JSON.stringify({
        openai: { models: ["gpt-test"] },
        anthropic: { models: ["claude-test"] },
      })
      : null;

    const fileResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Knowledge files",
      type: "file",
    });
    expect(fileResponse.status).toBe(200);
    const fileField = await fileResponse.json() as any;

    const choiceResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "AI choice",
      type: "ai",
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "choice",
      ai_temperature: 0.7,
      ai_prompt: "'Pick one'",
      ai_file_field_id: fileField.id,
      ai_auto_update: true,
      select_options: [
        { value: "Accepted", color: "light-green" },
        { value: "Rejected", color: "light-red" },
      ],
    });
    expect(choiceResponse.status).toBe(200);
    const choice = await choiceResponse.json() as any;
    expect(choice).toMatchObject({
      type: "ai",
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "choice",
      ai_temperature: 0.7,
      ai_prompt: { formula: "'Pick one'", mode: "simple", version: "0.1" },
      ai_file_field_id: fileField.id,
      ai_auto_update: true,
    });
    expect(choice.select_options.map((option: any) => option.value)).toEqual(["Accepted", "Rejected"]);
    expect(choice.ai_auto_update_user_id).toBeUndefined();

    const promptUpdate = await api(env, ctx, token, `/api/database/fields/${choice.id}/`, "PATCH", {
      ai_prompt: "CONCAT('Pick ', get('fields.field_101'))",
    });
    expect(promptUpdate.status).toBe(200);
    const dependency = await env.DB.prepare(
      "SELECT dependency_id FROM database_fielddependency WHERE dependant_id=?"
    ).bind(choice.id).first<{ dependency_id: number }>();
    expect(dependency?.dependency_id).toBe(101);

    const invalidCases = [
      { name: "Unknown provider", ai_generative_ai_type: "unknown", ai_generative_ai_model: "gpt-test", error: "ERROR_GENERATIVE_AI_DOES_NOT_EXIST" },
      { name: "Unknown model", ai_generative_ai_type: "openai", ai_generative_ai_model: "missing", error: "ERROR_MODEL_DOES_NOT_BELONG_TO_TYPE" },
      { name: "Unknown output", ai_generative_ai_type: "openai", ai_generative_ai_model: "gpt-test", ai_output_type: "number", error: "ERROR_REQUEST_BODY_VALIDATION" },
      { name: "Invalid temperature", ai_generative_ai_type: "openai", ai_generative_ai_model: "gpt-test", ai_temperature: 3, error: "ERROR_REQUEST_BODY_VALIDATION" },
      { name: "Invalid prompt", ai_generative_ai_type: "openai", ai_generative_ai_model: "gpt-test", ai_prompt: "ffff;;s9(", error: "ERROR_REQUEST_BODY_VALIDATION" },
      { name: "Wrong file field", ai_generative_ai_type: "openai", ai_generative_ai_model: "gpt-test", ai_file_field_id: 101, error: "ERROR_FIELD_DOES_NOT_EXIST", status: 404 },
      { name: "Unsupported files", ai_generative_ai_type: "anthropic", ai_generative_ai_model: "claude-test", ai_file_field_id: fileField.id, error: "ERROR_GENERATIVE_AI_DOES_NOT_SUPPORT_FILE_FIELD" },
    ];
    for (const invalid of invalidCases) {
      const { error, status = 400, ...payload } = invalid;
      const response = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
        type: "ai",
        ai_output_type: "text",
        ai_prompt: "'Valid'",
        ...payload,
      });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error });
    }

    const invalidUpdate = await api(env, ctx, token, `/api/database/fields/${choice.id}/`, "PATCH", {
      ai_generative_ai_model: "missing",
    });
    expect(invalidUpdate.status).toBe(400);
    await expect(invalidUpdate.json()).resolves.toMatchObject({ error: "ERROR_MODEL_DOES_NOT_BELONG_TO_TYPE" });
  });

  it("queues AI auto updates for dependent row changes and disables stale users", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const queueSend = vi.fn(async () => undefined);
    env.JOBS_QUEUE = { send: queueSend };
    env.CACHE.get = async (key: string) => key === "workspace:1:generative-ai"
      ? JSON.stringify({ openai: { models: ["gpt-test"] } })
      : null;

    const aiResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "AI auto summary",
      type: "ai",
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "text",
      ai_prompt: "CONCAT('Summary ', get('fields.field_101'))",
      ai_file_field_id: 999999,
      ai_auto_update: true,
    });
    expect(aiResponse.status).toBe(404);

    const fileResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "AI auto files",
      type: "file",
    });
    expect(fileResponse.status).toBe(200);
    const fileField = await fileResponse.json() as any;
    const validAIResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "AI auto summary",
      type: "ai",
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "text",
      ai_prompt: "CONCAT('Summary ', get('fields.field_101'))",
      ai_file_field_id: fileField.id,
      ai_auto_update: true,
    });
    expect(validAIResponse.status).toBe(200);
    const aiField = await validAIResponse.json() as any;
    const dependencies = await db.prepare(
      "SELECT dependency_id FROM database_fielddependency WHERE dependant_id=? ORDER BY dependency_id ASC"
    ).bind(aiField.id).all<any>();
    expect(dependencies.results.map((item: any) => item.dependency_id)).toEqual([
      101,
      fileField.id,
    ].sort((left, right) => left - right));
    await db.prepare(
      "DELETE FROM database_fielddependency WHERE dependant_id=? AND dependency_id=?"
    ).bind(aiField.id, fileField.id).run();
    const backfill = readFileSync(join(process.cwd(), "migrations", "0041_ai_file_field_dependencies.sql"), "utf8");
    db.database.exec(backfill);
    db.database.exec(backfill);
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM database_fielddependency WHERE dependant_id=? AND dependency_id=?"
    ).bind(aiField.id, fileField.id).first<any>())?.count).toBe(1);

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Trigger auto update",
    });
    expect(rowResponse.status).toBe(200);
    const row = await rowResponse.json() as any;
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend.mock.calls[0][0]).toMatchObject({
      job_type: "generate_ai_values",
      user_id: 7,
      workspace_id: 1,
      payload: {
        field_id: aiField.id,
        row_ids: null,
        is_auto_update: true,
      },
    });
    const job = await db.prepare("SELECT user_id, result FROM core_job WHERE type='generate_ai_values'").first<any>();
    expect(job?.user_id).toBe(7);
    expect(JSON.parse(job.result)).toMatchObject({ field_id: aiField.id, row_ids: null, is_auto_update: true });
    expect(await db.prepare(
      "SELECT field_id, row_id FROM premium_aifieldscheduledupdate WHERE field_id=? AND row_id=?"
    ).bind(aiField.id, row.id).first()).toEqual({ field_id: aiField.id, row_id: row.id });

    const deduplicatedUpdate = await api(env, ctx, token, `/api/database/rows/table/20/${row.id}/`, "PATCH", {
      field_101: "Queue the latest value only",
    });
    expect(deduplicatedUpdate.status).toBe(200);
    expect(queueSend).toHaveBeenCalledTimes(1);

    const stored = await db.prepare("SELECT field_settings FROM database_field WHERE id=?").bind(aiField.id).first<any>();
    const staleSettings = { ...JSON.parse(stored.field_settings), ai_auto_update_user_id: 999 };
    await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?").bind(JSON.stringify(staleSettings), aiField.id).run();
    const secondUpdate = await api(env, ctx, token, `/api/database/rows/table/20/${row.id}/`, "PATCH", {
      field_101: "Disable stale auto update",
    });
    expect(secondUpdate.status).toBe(200);
    expect(queueSend).toHaveBeenCalledTimes(1);
    const disabled = await db.prepare("SELECT field_settings FROM database_field WHERE id=?").bind(aiField.id).first<any>();
    expect(JSON.parse(disabled.field_settings)).toMatchObject({ ai_auto_update: false, ai_auto_update_user_id: null });
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM premium_aifieldscheduledupdate WHERE field_id=?"
    ).bind(aiField.id).first<any>())?.count).toBe(0);
  });

  it("changes the primary field with Baserow related field side effects and errors", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();

    const response = await api(env, ctx, token, "/api/database/fields/table/20/change-primary-field/", "POST", {
      new_primary_field_id: 108,
    });
    expect(response.status).toBe(200);
    const changed = await response.json() as any;
    expect(changed.id).toBe(108);
    expect(changed.primary).toBe(true);
    expect(changed.related_fields).toHaveLength(1);
    expect(changed.related_fields[0]).toMatchObject({ id: 101, primary: false });

    const fields = await db.prepare(
      `SELECT id, "primary" AS is_primary
       FROM database_field
       WHERE table_id=20 AND trashed=0
       ORDER BY id ASC`
    ).all<any>();
    expect(fields.results.filter((field: any) => field.is_primary === 1).map((field: any) => field.id)).toEqual([108]);

    const alreadyPrimary = await api(env, ctx, token, "/api/database/fields/table/20/change-primary-field/", "POST", {
      new_primary_field_id: 108,
    });
    expect(alreadyPrimary.status).toBe(400);
    await expect(alreadyPrimary.json()).resolves.toMatchObject({ error: "ERROR_FIELD_IS_ALREADY_PRIMARY" });

    await createField(db, 20, 110, "Secret", "password", 10);
    const incompatible = await api(env, ctx, token, "/api/database/fields/table/20/change-primary-field/", "POST", {
      new_primary_field_id: 110,
    });
    expect(incompatible.status).toBe(400);
    await expect(incompatible.json()).resolves.toMatchObject({ error: "ERROR_INCOMPATIBLE_PRIMARY_FIELD_TYPE" });
  });

  it("handles password fields as write-only Baserow cells and supports endpoint authentication", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    await createField(db, 20, 110, "Secret", "password", 10, false, { allow_endpoint_authentication: true });

    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Password row",
      field_110: "secret-value",
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as any;
    expect(created.field_110).toBe(true);

    const storedAfterCreate = await db.prepare('SELECT field_110 FROM "database_table_20" WHERE id=?')
      .bind(created.id)
      .first<any>();
    expect(storedAfterCreate.field_110).not.toBe("secret-value");
    await expect(verifyPassword("secret-value", storedAfterCreate.field_110)).resolves.toBe(true);

    const listResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "GET", undefined);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as any;
    expect(listed.results[0].field_110).toBe(true);

    const ignoredResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "PATCH", {
      field_110: true,
    });
    expect(ignoredResponse.status).toBe(200);
    expect((await ignoredResponse.json() as any).field_110).toBe(true);
    const storedAfterTrue = await db.prepare('SELECT field_110 FROM "database_table_20" WHERE id=?')
      .bind(created.id)
      .first<any>();
    expect(storedAfterTrue.field_110).toBe(storedAfterCreate.field_110);

    const authResponse = await api(env, ctx, token, "/api/database/fields/password-authentication/", "POST", {
      field_id: 110,
      row_id: created.id,
      password: "secret-value",
    });
    expect(authResponse.status).toBe(200);
    await expect(authResponse.json()).resolves.toEqual({ is_correct: true });

    const wrongAuthResponse = await api(env, ctx, token, "/api/database/fields/password-authentication/", "POST", {
      field_id: 110,
      row_id: created.id,
      password: "wrong",
    });
    expect(wrongAuthResponse.status).toBe(401);
    await expect(wrongAuthResponse.json()).resolves.toMatchObject({ error: "ERROR_INVALID_PASSWORD_FIELD_PASSWORD" });

    const clearedResponse = await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "PATCH", {
      field_110: "",
    });
    expect(clearedResponse.status).toBe(200);
    expect((await clearedResponse.json() as any).field_110).toBeNull();
    await expect(db.prepare('SELECT field_110 FROM "database_table_20" WHERE id=?').bind(created.id).first<any>())
      .resolves.toMatchObject({ field_110: null });
  });

  it("recreates password field storage when converting to or from password", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();

    const passwordFieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Secret",
      type: "password",
    });
    expect(passwordFieldResponse.status).toBe(200);
    const passwordField = await passwordFieldResponse.json() as any;

    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Converting",
      [`field_${passwordField.id}`]: "secret-value",
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as any;
    expect(created[`field_${passwordField.id}`]).toBe(true);

    const passwordToText = await api(env, ctx, token, `/api/database/fields/${passwordField.id}/`, "PATCH", {
      type: "text",
    });
    expect(passwordToText.status).toBe(200);
    await expect(db.prepare(`SELECT "field_${passwordField.id}" AS value FROM "database_table_20" WHERE id=?`).bind(created.id).first<any>())
      .resolves.toMatchObject({ value: null });

    const textFieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Plain secret",
      type: "text",
    });
    expect(textFieldResponse.status).toBe(200);
    const textField = await textFieldResponse.json() as any;
    await api(env, ctx, token, `/api/database/rows/table/20/${created.id}/`, "PATCH", {
      [`field_${textField.id}`]: "should not become a password",
    });

    const textToPassword = await api(env, ctx, token, `/api/database/fields/${textField.id}/`, "PATCH", {
      type: "password",
    });
    expect(textToPassword.status).toBe(200);
    await expect(db.prepare(`SELECT "field_${textField.id}" AS value FROM "database_table_20" WHERE id=?`).bind(created.id).first<any>())
      .resolves.toMatchObject({ value: null });
  });

  it("validates formula field types server-side and rejects invalid or circular formulas", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();

    const invalidResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Invalid formula",
      type: "formula",
      formula: "upper(1)",
    });
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({ error: "ERROR_WITH_FORMULA" });

    const validResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Calculated discount",
      type: "formula",
      formula: "field('Discount') + 1",
      formula_type: "text",
    });
    expect(validResponse.status).toBe(200);
    const validField = await validResponse.json() as any;
    expect(validField).toMatchObject({
      formula_type: "number",
      array_formula_type: null,
      formula_type_error: null,
      nullable: false,
    });

    const circularResponse = await api(env, ctx, token, `/api/database/fields/${validField.id}/`, "PATCH", {
      formula: "field('Calculated discount')",
    });
    expect(circularResponse.status).toBe(400);
    await expect(circularResponse.json()).resolves.toMatchObject({ error: "ERROR_WITH_FORMULA" });

    const dependentResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Dependent calculation",
      type: "formula",
      formula: "field('Calculated discount') + 1",
    });
    expect(dependentResponse.status).toBe(200);
    const dependentField = await dependentResponse.json() as any;
    const dependencies = await db.prepare(
      `SELECT dependant_id, dependency_id, via_id, broken_reference_field_name
       FROM database_fielddependency
       WHERE dependant_id IN (?, ?)
       ORDER BY dependant_id ASC, dependency_id ASC`
    ).bind(validField.id, dependentField.id).all<any>();
    expect(dependencies.results).toEqual([
      { dependant_id: validField.id, dependency_id: 108, via_id: null, broken_reference_field_name: null },
      { dependant_id: dependentField.id, dependency_id: validField.id, via_id: null, broken_reference_field_name: null },
    ]);
    const indirectCircularResponse = await api(env, ctx, token, `/api/database/fields/${validField.id}/`, "PATCH", {
      formula: "field('Dependent calculation')",
    });
    expect(indirectCircularResponse.status).toBe(400);
    await expect(indirectCircularResponse.json()).resolves.toMatchObject({ error: "ERROR_WITH_FORMULA" });

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Formula dependency",
      field_108: 4,
    });
    expect(rowResponse.status).toBe(200);
    await expect(rowResponse.json()).resolves.toMatchObject({
      [`field_${validField.id}`]: "5",
      [`field_${dependentField.id}`]: "6",
    });
  });

  it("preserves Baserow formula decimal precision in field settings and row responses", async () => {
    const { env, ctx, token } = await setupRowsFixture();
    const definitions = [
      { name: "Natural logarithm", formula: "ln(9.0)", places: 1, value: "2.2" },
      { name: "Square root", formula: "sqrt(2.00)", places: 2, value: "1.41" },
      { name: "Logarithm", formula: "log(125.000, 5)", places: 3, value: "0.333" },
      { name: "Exponential", formula: "exp(-1.00)", places: 2, value: "0.37" },
      { name: "Division", formula: "10 / 3", places: 10, value: "3.3333333333" },
    ];
    const fields: any[] = [];
    for (const definition of definitions) {
      const response = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
        name: definition.name,
        type: "formula",
        formula: definition.formula,
      });
      expect(response.status).toBe(200);
      const field = await response.json() as any;
      expect(field).toMatchObject({
        formula_type: "number",
        number_decimal_places: definition.places,
      });
      fields.push(field);
    }

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Formula precision",
    });
    expect(rowResponse.status).toBe(200);
    const row = await rowResponse.json() as any;
    definitions.forEach((definition, index) => {
      expect(row[`field_${fields[index].id}`]).toBe(definition.value);
    });

    const overrideResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Overridden precision",
      type: "formula",
      formula: "ln(9.0)",
      number_decimal_places: 4,
    });
    expect(overrideResponse.status).toBe(200);
    await expect(overrideResponse.json()).resolves.toMatchObject({ number_decimal_places: 4 });

    const invalidResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Invalid precision",
      type: "formula",
      formula: "ln(9.0)",
      number_decimal_places: 11,
    });
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });
  });

  it("returns dependent related fields when a field is deleted", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();

    const dependentResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Discount label",
      type: "formula",
      formula: 'CONCAT({Discount}, "%")',
      formula_type: "text",
    });
    expect(dependentResponse.status).toBe(200);
    const dependentField = await dependentResponse.json() as any;

    const deleteResponse = await api(env, ctx, token, "/api/database/fields/108/", "DELETE", undefined);
    expect(deleteResponse.status).toBe(200);
    const deleted = await deleteResponse.json() as any;
    expect(deleted.related_fields).toHaveLength(1);
    expect(deleted.related_fields[0]).toMatchObject({
      id: dependentField.id,
      type: "formula",
      formula_type: "invalid",
      formula_type_error: 'references deleted field "Discount"',
    });

    const storedDependent = await db.prepare("SELECT field_settings FROM database_field WHERE id=?")
      .bind(dependentField.id)
      .first<any>();
    expect(JSON.parse(storedDependent.field_settings)).toMatchObject({
      formula_type: "invalid",
      formula_type_error: 'references deleted field "Discount"',
    });

    const brokenDependency = await db.prepare(
      `SELECT dependency_id, via_id, broken_reference_field_name
       FROM database_fielddependency
       WHERE dependant_id=?`
    ).bind(dependentField.id).first<any>();
    expect(brokenDependency).toEqual({
      dependency_id: null,
      via_id: null,
      broken_reference_field_name: "Discount",
    });

    const restoreResponse = await api(env, ctx, token, "/api/trash/field/108/restore/", "PATCH", undefined);
    expect(restoreResponse.status).toBe(200);
    const restoredDependentResponse = await api(env, ctx, token, `/api/database/fields/${dependentField.id}/`, "GET", undefined);
    expect(restoredDependentResponse.status).toBe(200);
    await expect(restoredDependentResponse.json()).resolves.toMatchObject({
      formula_type: "text",
      formula_type_error: null,
      nullable: false,
    });
    const restoredDependency = await db.prepare(
      `SELECT dependency_id, via_id, broken_reference_field_name
       FROM database_fielddependency
       WHERE dependant_id=?`
    ).bind(dependentField.id).first<any>();
    expect(restoredDependency).toEqual({
      dependency_id: 108,
      via_id: null,
      broken_reference_field_name: null,
    });
  });

  it("renames formula references and returns dependent related fields", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();

    const dependentResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Discount formula",
      type: "formula",
      formula: 'CONCAT({Discount}, field("Discount"))',
      formula_type: "text",
    });
    expect(dependentResponse.status).toBe(200);
    const dependentField = await dependentResponse.json() as any;

    const renameResponse = await api(env, ctx, token, "/api/database/fields/108/", "PATCH", {
      name: "Rebate",
    });
    expect(renameResponse.status).toBe(200);
    const renamed = await renameResponse.json() as any;
    expect(renamed.name).toBe("Rebate");
    expect(renamed.related_fields).toHaveLength(1);
    expect(renamed.related_fields[0]).toMatchObject({
      id: dependentField.id,
      formula: 'CONCAT({Rebate}, field("Rebate"))',
      formula_type_error: null,
    });

    const storedDependent = await db.prepare("SELECT field_settings FROM database_field WHERE id=?")
      .bind(dependentField.id)
      .first<any>();
    expect(JSON.parse(storedDependent.field_settings)).toMatchObject({
      formula: 'CONCAT({Rebate}, field("Rebate"))',
      formula_type_error: null,
    });
  });

  it("recalculates dependent formula types when a referenced field type changes", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();

    const dependentResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Discount passthrough",
      type: "formula",
      formula: "{Discount}",
      formula_type: "number",
    });
    expect(dependentResponse.status).toBe(200);
    const dependentField = await dependentResponse.json() as any;

    const typeChangeResponse = await api(env, ctx, token, "/api/database/fields/108/", "PATCH", {
      type: "boolean",
    });
    expect(typeChangeResponse.status).toBe(200);
    const changed = await typeChangeResponse.json() as any;
    expect(changed.type).toBe("boolean");
    expect(changed.related_fields).toHaveLength(1);
    expect(changed.related_fields[0]).toMatchObject({
      id: dependentField.id,
      formula: "{Discount}",
      formula_type: "boolean",
      formula_type_error: null,
    });

    const storedDependent = await db.prepare("SELECT field_settings FROM database_field WHERE id=?")
      .bind(dependentField.id)
      .first<any>();
    expect(JSON.parse(storedDependent.field_settings)).toMatchObject({
      formula_type: "boolean",
      formula_type_error: null,
    });
  });

  it("creates persistent field options for every existing view when a field is added", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (711, 20, 'Public grid', 'grid', 1, 'AND', 0, 1, 'publicgrid',
        0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_gridviewfieldoptions
       (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (711, 101, 200, 0, 32768, '', '')`
    ).run();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (712, 20, 'Gallery', 'gallery', 2, 'AND', 0, 0, 'gallery',
        0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (713, 20, 'Form', 'form', 3, 'AND', 0, 0, 'form',
        0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_formview
       (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
        submit_action_redirect_url, mode, show_logo, cover_image, logo_image)
       VALUES (713, '', '', 'Submit', 'MESSAGE', '', '', 'form', 1, NULL, NULL)`
    ).run();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (714, 20, 'Kanban', 'kanban', 4, 'AND', 0, 0, 'kanban',
        0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();

    const response = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Optioned",
      type: "number",
    });
    expect(response.status).toBe(200);
    const field = await response.json() as any;

    const gridOption = await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=711 AND field_id=?")
      .bind(field.id)
      .first<any>();
    expect(gridOption).toMatchObject({ hidden: 1, order: 10 * 32768 });
    const galleryOption = await db.prepare("SELECT * FROM database_galleryviewfieldoptions WHERE gallery_view_id=712 AND field_id=?")
      .bind(field.id)
      .first<any>();
    expect(galleryOption).toMatchObject({ hidden: 1, order: 10 * 32768 });
    const formOption = await db.prepare("SELECT * FROM database_formviewfieldoptions WHERE form_view_id=713 AND field_id=?")
      .bind(field.id)
      .first<any>();
    expect(formOption).toMatchObject({ enabled: 0, required: 1, include_all_select_options: 1, order: 10 * 32768 });
    const kanbanOption = await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=714 AND field_id=?")
      .bind(field.id)
      .first<any>();
    expect(kanbanOption).toMatchObject({ hidden: 1, order: 10 * 32768 });
  });

  it("validates and hydrates file field names on real row API writes", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const fileResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Documents",
      type: "file",
    });
    expect(fileResponse.status).toBe(200);
    const fileField = await fileResponse.json() as any;
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_userfile
       (user_id, name, original_name, original_extension, sha256_hash, r2_key, size,
        mime_type, is_image, image_width, image_height, uploaded_at, deleted_at)
       VALUES (7, 'stored_hash.txt', 'Stored document.txt', 'txt', 'hash',
               'user_files/stored_hash.txt', 12, 'text/plain', 0, NULL, NULL, ?, NULL)`
    ).bind(now).run();

    const invalidName = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Invalid file name",
      [`field_${fileField.id}`]: [{ name: "invalid.txt" }],
    });
    expect(invalidName.status).toBe(400);
    expect(await invalidName.json()).toMatchObject({ error: "ERROR_INVALID_USER_FILE_NAME_ERROR" });

    const missingFile = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Missing file",
      [`field_${fileField.id}`]: [{ name: "missing_hash.txt" }],
    });
    expect(missingFile.status).toBe(400);
    expect(await missingFile.json()).toMatchObject({ error: "ERROR_USER_FILE_DOES_NOT_EXIST" });

    const created = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Stored file",
      [`field_${fileField.id}`]: "stored_hash.txt",
    });
    expect(created.status).toBe(200);
    expect((await created.json() as any)[`field_${fileField.id}`]).toEqual([
      expect.objectContaining({
        name: "stored_hash.txt",
        visible_name: "Stored document.txt",
        size: 12,
        mime_type: "text/plain",
      }),
    ]);
  });

  it("creates only registered view types with Baserow field-option defaults", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const created = new Map<string, any>();

    for (const type of ["grid", "gallery", "form", "survey", "kanban", "calendar", "timeline"]) {
      const response = await api(env, ctx, token, "/api/database/views/table/20/", "POST", {
        name: `${type} view`,
        type,
      });
      expect(response.status).toBe(200);
      created.set(type, await response.json());
    }

    expect(created.get("survey")).toMatchObject({ type: "form", mode: "survey" });
    expect(created.get("form")).toMatchObject({ type: "form", mode: "form" });
    expect(created.get("kanban")).toMatchObject({ single_select_field: null, card_cover_image_field: null });
    expect(created.get("calendar")).toMatchObject({ date_field: null });
    expect(created.get("timeline")).toMatchObject({ start_date_field: null, end_date_field: null });

    const galleryOptions = await db.prepare(
      "SELECT field_id, hidden FROM database_galleryviewfieldoptions WHERE gallery_view_id=? ORDER BY [order] ASC"
    ).bind(created.get("gallery").id).all<any>();
    expect(galleryOptions.results.map((option: any) => option.hidden)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1]);

    const kanbanOptions = await db.prepare(
      "SELECT field_id, hidden FROM database_gridviewfieldoptions WHERE grid_view_id=? ORDER BY [order] ASC"
    ).bind(created.get("kanban").id).all<any>();
    expect(kanbanOptions.results.map((option: any) => option.hidden)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1]);

    for (const type of ["calendar", "timeline"]) {
      const options = await db.prepare(
        "SELECT field_id, hidden FROM database_gridviewfieldoptions WHERE grid_view_id=? ORDER BY [order] ASC"
      ).bind(created.get(type).id).all<any>();
      expect(options.results.map((option: any) => option.hidden)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1]);
    }

    const formOptions = await db.prepare(
      "SELECT enabled, required FROM database_formviewfieldoptions WHERE form_view_id=? ORDER BY [order] ASC"
    ).bind(created.get("form").id).all<any>();
    expect(formOptions.results).toHaveLength(9);
    expect(formOptions.results.every((option: any) => option.enabled === 0 && option.required === 1)).toBe(true);

    const invalidType = await api(env, ctx, token, "/api/database/views/table/20/", "POST", {
      name: "Broken registry view",
      type: "undefined",
    });
    expect(invalidType.status).toBe(400);
    expect(await invalidType.json()).toMatchObject({ error: "INVALID_REQUEST" });
    expect(await db.prepare("SELECT id FROM database_view WHERE name='Broken registry view'").first()).toBeNull();

    const invalidMode = await api(env, ctx, token, `/api/database/views/${created.get("form").id}/`, "PATCH", {
      mode: "undefined",
    });
    expect(invalidMode.status).toBe(400);
    expect(await invalidMode.json()).toMatchObject({ error: "INVALID_REQUEST" });
    expect(await db.prepare("SELECT mode FROM database_formview WHERE view_ptr_id=?")
      .bind(created.get("form").id).first<any>()).toMatchObject({ mode: "form" });
  });

  it("runs Baserow view lifecycle hooks when referenced fields change or are deleted", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const fileResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Cover",
      type: "file",
    });
    const dateResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Event date",
      type: "date",
    });
    expect(fileResponse.status).toBe(200);
    expect(dateResponse.status).toBe(200);
    const fileField = await fileResponse.json() as any;
    const dateField = await dateResponse.json() as any;

    const viewIds = new Map<string, number>();
    for (const type of ["grid", "gallery", "form", "kanban", "calendar", "timeline"]) {
      const response = await api(env, ctx, token, "/api/database/views/table/20/", "POST", {
        name: `${type} lifecycle`,
        type,
      });
      expect(response.status).toBe(200);
      viewIds.set(type, Number((await response.json() as any).id));
    }

    expect((await api(env, ctx, token, `/api/database/views/${viewIds.get("gallery")}/`, "PATCH", {
      card_cover_image_field: fileField.id,
    })).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${viewIds.get("kanban")}/`, "PATCH", {
      single_select_field: 106,
      card_cover_image_field: fileField.id,
    })).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${viewIds.get("calendar")}/`, "PATCH", {
      date_field: dateField.id,
    })).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${viewIds.get("timeline")}/`, "PATCH", {
      start_date_field: dateField.id,
      end_date_field: dateField.id,
    })).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${viewIds.get("form")}/field-options/`, "PATCH", {
      field_options: { 108: { enabled: true } },
    })).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${viewIds.get("grid")}/sortings/`, "POST", {
      field: 106,
      order: "ASC",
      type: "order",
    })).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${viewIds.get("grid")}/group_bys/`, "POST", {
      field: 106,
      order: "ASC",
      type: "order",
    })).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${viewIds.get("grid")}/filters/`, "POST", {
      field: 106,
      type: "single_select_equal",
      value: "1001",
    })).status).toBe(200);
    const decorationResponse = await api(env, ctx, token, `/api/database/views/${viewIds.get("grid")}/decorations/`, "POST", {
      type: "background_color",
      value_provider_type: "single_select_color",
      value_provider_conf: { field_id: 106 },
    });
    expect(decorationResponse.status).toBe(200);
    const decoration = await decorationResponse.json() as any;

    expect((await api(env, ctx, token, `/api/database/fields/${fileField.id}/`, "DELETE", undefined)).status).toBe(200);
    expect((await api(env, ctx, token, "/api/database/fields/106/", "PATCH", { type: "text" })).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/fields/${dateField.id}/`, "PATCH", { type: "text" })).status).toBe(200);
    expect((await api(env, ctx, token, "/api/database/fields/108/", "PATCH", {
      type: "formula",
      formula: "1",
    })).status).toBe(200);

    expect(await db.prepare("SELECT card_cover_image_field FROM database_view WHERE id=?")
      .bind(viewIds.get("gallery")).first<any>()).toMatchObject({ card_cover_image_field: null });
    expect(await db.prepare("SELECT single_select_field, card_cover_image_field FROM database_view WHERE id=?")
      .bind(viewIds.get("kanban")).first<any>()).toMatchObject({ single_select_field: null, card_cover_image_field: null });
    expect(await db.prepare("SELECT date_field FROM database_view WHERE id=?")
      .bind(viewIds.get("calendar")).first<any>()).toMatchObject({ date_field: null });
    expect(await db.prepare("SELECT start_date_field, end_date_field FROM database_view WHERE id=?")
      .bind(viewIds.get("timeline")).first<any>()).toMatchObject({ start_date_field: null, end_date_field: null });
    expect(await db.prepare("SELECT enabled FROM database_formviewfieldoptions WHERE form_view_id=? AND field_id=108")
      .bind(viewIds.get("form")).first<any>()).toMatchObject({ enabled: 0 });
    expect(await db.prepare("SELECT id FROM database_viewsort WHERE view_id=? AND field_id=106")
      .bind(viewIds.get("grid")).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM database_viewgroupby WHERE view_id=? AND field_id=106")
      .bind(viewIds.get("grid")).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM database_viewfilter WHERE view_id=? AND field_id=106")
      .bind(viewIds.get("grid")).first()).toBeNull();
    const decorationAfterTypeChange = await db.prepare("SELECT value_provider_conf FROM database_viewdecoration WHERE id=?")
      .bind(decoration.id).first<any>();
    expect(JSON.parse(decorationAfterTypeChange.value_provider_conf)).toEqual({ field_id: null });
  });

  it("duplicates select fields with remapped option ids when data is copied", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const now = new Date().toISOString();
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "One", field_106: 201, field_107: [203, 204] },
        { field_101: "Two", field_106: 202, field_107: [204] },
      ],
    });
    expect(createdResponse.status).toBe(200);

    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (701, 20, 'Dup grid', 'grid', 1, 'AND', 0, 0, 'dupgrid',
        0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_gridviewfieldoptions
       (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (701, 106, 333, 1, 50000, 'count', 'empty')`
    ).run();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (702, 20, 'Dup gallery', 'gallery', 2, 'AND', 0, 0, 'dupgallery',
        0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_galleryviewfieldoptions
       (gallery_view_id, field_id, hidden, [order])
       VALUES (702, 106, 0, 60000)`
    ).run();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (703, 20, 'Dup form', 'form', 3, 'AND', 0, 0, 'dupform',
        0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_formview
       (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
        submit_action_redirect_url, mode, show_logo, cover_image, logo_image)
       VALUES (703, 'Dup form', '', 'Submit', 'MESSAGE', '', '', 'survey', 1, NULL, NULL)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptions
       (id, form_view_id, field_id, name, description, enabled, required, [order],
        show_when_matching_conditions, condition_type, include_all_select_options, field_component)
       VALUES (801, 703, 106, 'Status label', 'Pick one', 1, 1, 70000, 1, 'AND', 0, 'default')`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptions_allowedselectoptions
       (form_view_field_options_id, select_option_id)
       VALUES (801, 201)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptionsconditiongroup
       (id, field_option_id, filter_type, parent_group_id)
       VALUES (901, 801, 'AND', NULL)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptionscondition
       (field_option_id, field_id, type, value, group_id)
       VALUES (801, 106, 'single_select_equal', '201', 901)`
    ).run();

    const singleDuplicateResponse = await api(env, ctx, token, "/api/database/fields/106/duplicate/async/", "POST", {
      duplicate_data: true,
    });
    expect(singleDuplicateResponse.status).toBe(202);
    const singleJob = await singleDuplicateResponse.json() as any;
    const singleField = singleJob.duplicated_field;
    expect(singleField.select_options.map((option: any) => option.value)).toEqual(["Todo", "Done"]);
    expect(singleField.select_options.map((option: any) => option.id)).not.toContain(201);
    expect(singleField.select_options.map((option: any) => option.id)).not.toContain(202);
    expect(singleField.single_select_default).toBe(singleField.select_options.find((option: any) => option.value === "Todo").id);
    const copiedTodoOptionId = singleField.select_options.find((option: any) => option.value === "Todo").id;

    const gridOption = await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=701 AND field_id=?")
      .bind(singleField.id)
      .first<any>();
    expect(gridOption).toMatchObject({ width: 333, hidden: 1, order: 50001, aggregation_type: "count", aggregation_raw_type: "empty" });
    const galleryOption = await db.prepare("SELECT * FROM database_galleryviewfieldoptions WHERE gallery_view_id=702 AND field_id=?")
      .bind(singleField.id)
      .first<any>();
    expect(galleryOption).toMatchObject({ hidden: 0, order: 60001 });
    const formOption = await db.prepare("SELECT * FROM database_formviewfieldoptions WHERE form_view_id=703 AND field_id=?")
      .bind(singleField.id)
      .first<any>();
    expect(formOption).toMatchObject({
      name: "Status label",
      description: "Pick one",
      enabled: 1,
      required: 1,
      order: 70001,
      include_all_select_options: 0,
    });
    const allowed = await db.prepare("SELECT * FROM database_formviewfieldoptions_allowedselectoptions WHERE form_view_field_options_id=?")
      .bind(formOption.id)
      .first<any>();
    expect(allowed.select_option_id).toBe(copiedTodoOptionId);
    const conditionGroup = await db.prepare("SELECT * FROM database_formviewfieldoptionsconditiongroup WHERE field_option_id=?")
      .bind(formOption.id)
      .first<any>();
    expect(conditionGroup.id).not.toBe(901);
    const condition = await db.prepare("SELECT * FROM database_formviewfieldoptionscondition WHERE field_option_id=?")
      .bind(formOption.id)
      .first<any>();
    expect(condition).toMatchObject({ field_id: singleField.id, value: String(copiedTodoOptionId), group_id: conditionGroup.id });

    const multipleDuplicateResponse = await api(env, ctx, token, "/api/database/fields/107/duplicate/async/", "POST", {
      duplicate_data: true,
    });
    expect(multipleDuplicateResponse.status).toBe(202);
    const multipleJob = await multipleDuplicateResponse.json() as any;
    const multipleField = multipleJob.duplicated_field;
    expect(multipleField.select_options.map((option: any) => option.value)).toEqual(["Red", "Blue"]);
    expect(multipleField.select_options.map((option: any) => option.id)).not.toContain(203);
    expect(multipleField.select_options.map((option: any) => option.id)).not.toContain(204);
    expect(multipleField.multiple_select_default).toEqual([
      multipleField.select_options.find((option: any) => option.value === "Red").id,
      multipleField.select_options.find((option: any) => option.value === "Blue").id,
    ]);

    const row = await db.prepare(
      `SELECT "field_${singleField.id}" AS single_value, "field_${multipleField.id}" AS multiple_value
       FROM "database_table_20"
       WHERE id=1`
    ).first<any>();
    const duplicatedSingle = JSON.parse(row.single_value);
    const duplicatedMultiple = JSON.parse(row.multiple_value);

    expect(duplicatedSingle).toEqual(expect.objectContaining({
      id: singleField.select_options.find((option: any) => option.value === "Todo").id,
      value: "Todo",
    }));
    expect(duplicatedSingle.id).not.toBe(201);
    expect(duplicatedMultiple.map((option: any) => option.value)).toEqual(["Red", "Blue"]);
    expect(duplicatedMultiple.map((option: any) => option.id)).toEqual([
      multipleField.select_options.find((option: any) => option.value === "Red").id,
      multipleField.select_options.find((option: any) => option.value === "Blue").id,
    ]);
    expect(duplicatedMultiple.map((option: any) => option.id)).not.toEqual([203, 204]);

    const defaultedResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Defaulted after duplicate",
    });
    expect(defaultedResponse.status).toBe(200);
    const defaulted = await defaultedResponse.json() as any;
    expect(defaulted[`field_${singleField.id}`]).toEqual(expect.objectContaining({
      id: singleField.single_select_default,
      value: "Todo",
    }));
    expect(defaulted[`field_${multipleField.id}`].map((option: any) => option.id)).toEqual(multipleField.multiple_select_default);
    expect(defaulted[`field_${multipleField.id}`].map((option: any) => option.value)).toEqual(["Red", "Blue"]);
  });

  it("duplicates non-select field data for active rows only", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO "database_table_20"
       (id, [order], trashed, _created_on, _updated_on, _created_by_id, _last_modified_by_id, "field_101")
       VALUES
       (1, 10000, 0, ?, ?, 7, 7, 'Active source'),
       (2, 20000, 1, ?, ?, 7, 7, 'Trashed source')`
    ).bind(now, now, now, now).run();

    const duplicateResponse = await api(env, ctx, token, "/api/database/fields/101/duplicate/async/", "POST", {
      duplicate_data: true,
    });
    expect(duplicateResponse.status).toBe(202);
    const job = await duplicateResponse.json() as any;
    const duplicatedFieldId = job.duplicated_field.id;

    const rows = await db.prepare(
      `SELECT id, "field_${duplicatedFieldId}" AS copied
       FROM "database_table_20"
       ORDER BY id ASC`
    ).all<any>();
    expect(rows.results).toEqual([
      { id: 1, copied: "Active source" },
      { id: 2, copied: null },
    ]);
  });

  it("duplicates field dependency graph rows for computed fields", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (30, 10, 'Customers', 2, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 30);
    await createField(db, 30, 301, "Customer name", "text", 1);
    await createField(db, 20, 120, "Customer", "link_row", 10, false, { link_row_table_id: 30 });
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (701, 102, 101, NULL, NULL)"
    ).run();
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (702, 102, 301, 120, NULL)"
    ).run();
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (703, 102, NULL, NULL, 'Missing formula field')"
    ).run();

    const duplicateResponse = await api(env, ctx, token, "/api/database/fields/102/duplicate/async/", "POST", {
      duplicate_data: false,
    });
    expect(duplicateResponse.status).toBe(202);
    const job = await duplicateResponse.json() as any;
    const duplicatedField = job.duplicated_field;
    expect(duplicatedField).toMatchObject({
      name: "Computed (copy)",
      type: "formula",
      read_only: true,
    });

    const dependencies = await db.prepare(
      `SELECT dependant_id, dependency_id, via_id, broken_reference_field_name
       FROM database_fielddependency
       WHERE dependant_id=?
       ORDER BY id ASC`
    ).bind(duplicatedField.id).all<any>();
    expect(dependencies.results).toEqual([
      {
        dependant_id: duplicatedField.id,
        dependency_id: 101,
        via_id: null,
        broken_reference_field_name: null,
      },
      {
        dependant_id: duplicatedField.id,
        dependency_id: 301,
        via_id: 120,
        broken_reference_field_name: null,
      },
      {
        dependant_id: duplicatedField.id,
        dependency_id: null,
        via_id: null,
        broken_reference_field_name: "Missing formula field",
      },
    ]);
  });

  it("duplicates tables with select options, remapped defaults and copied rows", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    env.CACHE.get = async (key: string) => key === "workspace:1:generative-ai"
      ? JSON.stringify({ openai: { models: ["gpt-test"] } })
      : null;
    const knowledgeResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "AI knowledge",
      type: "file",
    });
    const knowledge = await knowledgeResponse.json() as any;
    const aiResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "AI duplicate",
      type: "ai",
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "text",
      ai_prompt: "CONCAT('Summary ', get('fields.field_101'))",
      ai_file_field_id: knowledge.id,
      ai_auto_update: true,
    });
    expect(aiResponse.status).toBe(200);
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "One", field_106: 201, field_107: [203, 204], field_108: 11 },
        { field_101: "Two", field_106: 202, field_107: [204], field_108: 22 },
      ],
    });
    expect(createdResponse.status).toBe(200);

    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, allow_public_export, public_view_password, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size, card_cover_image_field)
       VALUES (251, 20, 'Configured table grid', 'grid', 1, 'OR', 0, 1, 1, 'secret', 'tablegrid',
        0, ?, ?, 'count', 'collaborative', 'small', 101)`
    ).bind(now, now).run();
    await db.prepare("INSERT INTO database_viewfiltergroup (id, view_id, parent_group_id, filter_type) VALUES (351, 251, NULL, 'OR')").run();
    await db.prepare(
      `INSERT INTO database_viewfilter (view_id, field_id, type, value, preload_values, group_id)
       VALUES (251, 106, 'single_select_equal', '201', '{"field_id":106,"select_option_id":201}', 351)`
    ).run();
    await db.prepare("INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (251, 101, 'DESC', 'default')").run();
    await db.prepare("INSERT INTO database_viewgroupby (view_id, field_id, [order], width, type) VALUES (251, 106, 'ASC', 255, 'default')").run();
    await db.prepare(
      `INSERT INTO database_viewdecoration (view_id, type, value_provider_type, value_provider_conf, [order])
       VALUES (251, 'left_border_color', 'single_select_color', '{"field_id":106,"select_option_id":201}', 2)`
    ).run();

    const duplicateResponse = await api(env, ctx, token, "/api/database/tables/20/duplicate/async/", "POST", {});
    expect(duplicateResponse.status).toBe(202);
    const job = await duplicateResponse.json() as any;
    const duplicatedTable = job.duplicated_table;
    const nameField = duplicatedTable.fields.find((field: any) => field.name === "Name");
    const statusField = duplicatedTable.fields.find((field: any) => field.name === "Status");
    const tagsField = duplicatedTable.fields.find((field: any) => field.name === "Tags");
    const discountField = duplicatedTable.fields.find((field: any) => field.name === "Discount");
    const duplicatedKnowledge = duplicatedTable.fields.find((field: any) => field.name === "AI knowledge");
    const duplicatedAI = duplicatedTable.fields.find((field: any) => field.name === "AI duplicate");

    expect(duplicatedAI).toMatchObject({
      ai_file_field_id: duplicatedKnowledge.id,
      ai_auto_update: true,
      ai_prompt: { formula: `CONCAT('Summary ', get('fields.field_${nameField.id}'))` },
    });
    const duplicatedAISettings = await db.prepare("SELECT field_settings FROM database_field WHERE id=?")
      .bind(duplicatedAI.id)
      .first<any>();
    expect(JSON.parse(duplicatedAISettings.field_settings)).toMatchObject({
      ai_auto_update: true,
      ai_auto_update_user_id: 7,
      ai_file_field_id: duplicatedKnowledge.id,
    });

    expect(statusField.select_options.map((option: any) => option.value)).toEqual(["Todo", "Done"]);
    expect(statusField.select_options.map((option: any) => option.id)).not.toContain(201);
    expect(statusField.select_options.map((option: any) => option.id)).not.toContain(202);
    expect(statusField.single_select_default).toBe(statusField.select_options.find((option: any) => option.value === "Todo").id);

    expect(tagsField.select_options.map((option: any) => option.value)).toEqual(["Red", "Blue"]);
    expect(tagsField.select_options.map((option: any) => option.id)).not.toContain(203);
    expect(tagsField.select_options.map((option: any) => option.id)).not.toContain(204);
    expect(tagsField.multiple_select_default).toEqual([
      tagsField.select_options.find((option: any) => option.value === "Red").id,
      tagsField.select_options.find((option: any) => option.value === "Blue").id,
    ]);

    const rowsResponse = await api(env, ctx, token, `/api/database/rows/table/${duplicatedTable.id}/?order_by=field_${nameField.id}&size=10`, "GET", undefined);
    expect(rowsResponse.status).toBe(200);
    const rows = await rowsResponse.json() as any;
    expect(rows.results.map((row: any) => row[`field_${nameField.id}`])).toEqual(["One", "Two"]);
    expect(rows.results.map((row: any) => row[`field_${statusField.id}`].id)).toEqual([
      statusField.select_options.find((option: any) => option.value === "Todo").id,
      statusField.select_options.find((option: any) => option.value === "Done").id,
    ]);
    expect(rows.results[0][`field_${tagsField.id}`].map((option: any) => option.id)).toEqual([
      tagsField.select_options.find((option: any) => option.value === "Red").id,
      tagsField.select_options.find((option: any) => option.value === "Blue").id,
    ]);
    expect(rows.results.map((row: any) => row[`field_${discountField.id}`])).toEqual(["11", "22"]);

    const defaultedResponse = await api(env, ctx, token, `/api/database/rows/table/${duplicatedTable.id}/`, "POST", {
      [`field_${nameField.id}`]: "Defaulted duplicate table",
    });
    expect(defaultedResponse.status).toBe(200);
    const defaulted = await defaultedResponse.json() as any;
    expect(defaulted[`field_${statusField.id}`].id).toBe(statusField.single_select_default);
    expect(defaulted[`field_${tagsField.id}`].map((option: any) => option.id)).toEqual(tagsField.multiple_select_default);

    const duplicatedViews = await db.prepare("SELECT * FROM database_view WHERE table_id=? ORDER BY [order] ASC, id ASC")
      .bind(duplicatedTable.id)
      .all<any>();
    const grid = duplicatedViews.results.find((view: any) => view.name === "Configured table grid");
    const todoOptionId = statusField.select_options.find((option: any) => option.value === "Todo").id;
    expect(grid).toMatchObject({
      type: "grid",
      filter_type: "OR",
      public: 1,
      allow_public_export: 1,
      public_view_password: "secret",
      card_cover_image_field: nameField.id,
    });
    expect(grid.slug).not.toBe("tablegrid");
    const filter = await db.prepare("SELECT * FROM database_viewfilter WHERE view_id=?").bind(grid.id).first<any>();
    expect(filter).toMatchObject({ field_id: statusField.id, value: String(todoOptionId) });
    expect(JSON.parse(filter.preload_values)).toMatchObject({ field_id: statusField.id, select_option_id: todoOptionId });
    const sort = await db.prepare("SELECT * FROM database_viewsort WHERE view_id=?").bind(grid.id).first<any>();
    expect(sort).toMatchObject({ field_id: nameField.id, order: "DESC" });
    const groupBy = await db.prepare("SELECT * FROM database_viewgroupby WHERE view_id=?").bind(grid.id).first<any>();
    expect(groupBy).toMatchObject({ field_id: statusField.id, width: 255 });
    const decoration = await db.prepare("SELECT * FROM database_viewdecoration WHERE view_id=?").bind(grid.id).first<any>();
    expect(JSON.parse(decoration.value_provider_conf)).toMatchObject({ field_id: statusField.id, select_option_id: todoOptionId });
  });

  it("duplicates database applications with table rows and remapped select options", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    env.CACHE.get = async (key: string) => key === "workspace:1:generative-ai"
      ? JSON.stringify({ openai: { models: ["gpt-test"] } })
      : null;
    const applicationKnowledgeResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Application AI knowledge",
      type: "file",
    });
    const applicationKnowledge = await applicationKnowledgeResponse.json() as any;
    const applicationAIResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Application AI duplicate",
      type: "ai",
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "text",
      ai_prompt: "CONCAT('Summary ', get('fields.field_101'))",
      ai_file_field_id: applicationKnowledge.id,
      ai_auto_update: true,
    });
    expect(applicationAIResponse.status).toBe(200);
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (30, 10, 'Customers', 2, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 30);
    await createField(db, 30, 301, "Customer name", "text", 1);
    await db.prepare(
      `INSERT INTO "database_table_30" (id, [order], _created_on, _updated_on, "field_301")
       VALUES (10, 10000, ?, ?, 'Customer A'), (20, 20000, ?, ?, 'Customer B')`
    ).bind(now, now, now, now).run();
    await createField(db, 20, 120, "Customer", "link_row", 10, false, { link_row_table_id: 30 });
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (701, 102, 101, NULL, NULL)"
    ).run();
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (702, 102, 301, 120, NULL)"
    ).run();
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (703, 102, NULL, NULL, 'Missing formula field')"
    ).run();

    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "App One", field_106: 201, field_107: [203, 204], field_108: 31, field_120: [10] },
        { field_101: "App Two", field_106: 202, field_107: [204], field_108: 32, field_120: [20] },
      ],
    });
    expect(createdResponse.status).toBe(200);

    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, allow_public_export, public_view_password, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size, card_cover_image_field)
       VALUES (301, 20, 'Configured grid', 'grid', 1, 'OR', 0, 1, 1, 'secret', 'sourcegrid',
        0, ?, ?, 'count', 'collaborative', 'small', 101)`
    ).bind(now, now).run();
    await db.prepare("INSERT INTO database_viewfiltergroup (id, view_id, parent_group_id, filter_type) VALUES (401, 301, NULL, 'OR')").run();
    await db.prepare(
      `INSERT INTO database_viewfilter (view_id, field_id, type, value, preload_values, group_id)
       VALUES (301, 106, 'single_select_equal', '201', '{"field_id":106,"select_option_id":201}', 401)`
    ).run();
    await db.prepare("INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (301, 101, 'DESC', 'default')").run();
    await db.prepare("INSERT INTO database_viewgroupby (view_id, field_id, [order], width, type) VALUES (301, 106, 'ASC', 260, 'default')").run();
    await db.prepare(
      `INSERT INTO database_viewdecoration (view_id, type, value_provider_type, value_provider_conf, [order])
       VALUES (301, 'left_border_color', 'single_select_color', '{"field_id":106,"select_option_id":201}', 2)`
    ).run();
    await db.prepare(
      `INSERT INTO database_gridviewfieldoptions
       (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (301, 106, 360, 1, 32768, 'count', 'empty')`
    ).run();

    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (302, 20, 'Configured form', 'form', 2, 'AND', 0, 1, 'sourceform',
        0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_formview
       (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
        submit_action_redirect_url, mode, show_logo, cover_image, logo_image)
       VALUES (302, 'Lead form', 'Description', 'Send', 'MESSAGE', 'Thanks', '', 'survey', 0, NULL, NULL)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptions
       (id, form_view_id, field_id, name, description, enabled, required, [order],
        show_when_matching_conditions, condition_type, include_all_select_options, field_component)
       VALUES (501, 302, 106, 'Status label', 'Pick status', 1, 1, 32768, 1, 'AND', 0, 'default')`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptions_allowedselectoptions
       (form_view_field_options_id, select_option_id)
       VALUES (501, 201)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptionsconditiongroup
       (id, field_option_id, filter_type, parent_group_id)
       VALUES (601, 501, 'AND', NULL)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptionscondition
       (field_option_id, field_id, type, value, group_id)
       VALUES (501, 106, 'single_select_equal', '201', 601)`
    ).run();

    const duplicateResponse = await api(env, ctx, token, "/api/applications/10/duplicate/async/", "POST", {});
    expect(duplicateResponse.status).toBe(202);
    const job = await duplicateResponse.json() as any;
    const duplicatedApp = job.duplicated_application;
    const duplicatedTable = duplicatedApp.tables.find((item: any) => item.name === "Rows");
    const nameField = duplicatedTable.fields.find((field: any) => field.name === "Name");
    const computedField = duplicatedTable.fields.find((field: any) => field.name === "Computed");
    const statusField = duplicatedTable.fields.find((field: any) => field.name === "Status");
    const tagsField = duplicatedTable.fields.find((field: any) => field.name === "Tags");
    const discountField = duplicatedTable.fields.find((field: any) => field.name === "Discount");
    const customerField = duplicatedTable.fields.find((field: any) => field.name === "Customer");
    const duplicatedAIKnowledge = duplicatedTable.fields.find((field: any) => field.name === "Application AI knowledge");
    const duplicatedAI = duplicatedTable.fields.find((field: any) => field.name === "Application AI duplicate");
    const duplicatedCustomersTable = duplicatedApp.tables.find((item: any) => item.name === "Customers");
    const duplicatedCustomerNameField = duplicatedCustomersTable.fields.find((field: any) => field.name === "Customer name");

    expect(duplicatedAI).toMatchObject({
      ai_file_field_id: duplicatedAIKnowledge.id,
      ai_auto_update: true,
      ai_prompt: { formula: `CONCAT('Summary ', get('fields.field_${nameField.id}'))` },
    });

    expect(statusField.select_options.map((option: any) => option.value)).toEqual(["Todo", "Done"]);
    expect(statusField.select_options.map((option: any) => option.id)).not.toContain(201);
    expect(statusField.single_select_default).toBe(statusField.select_options.find((option: any) => option.value === "Todo").id);
    expect(tagsField.select_options.map((option: any) => option.value)).toEqual(["Red", "Blue"]);
    expect(tagsField.select_options.map((option: any) => option.id)).not.toContain(203);
    expect(tagsField.multiple_select_default).toEqual([
      tagsField.select_options.find((option: any) => option.value === "Red").id,
      tagsField.select_options.find((option: any) => option.value === "Blue").id,
    ]);
    expect(customerField.link_row_table_id).toBe(duplicatedCustomersTable.id);
    const dependencies = await db.prepare(
      `SELECT dependant_id, dependency_id, via_id, broken_reference_field_name
       FROM database_fielddependency
       WHERE dependant_id=?
       ORDER BY id ASC`
    ).bind(computedField.id).all<any>();
    expect(dependencies.results).toEqual([
      {
        dependant_id: computedField.id,
        dependency_id: nameField.id,
        via_id: null,
        broken_reference_field_name: null,
      },
      {
        dependant_id: computedField.id,
        dependency_id: duplicatedCustomerNameField.id,
        via_id: customerField.id,
        broken_reference_field_name: null,
      },
      {
        dependant_id: computedField.id,
        dependency_id: null,
        via_id: null,
        broken_reference_field_name: "Missing formula field",
      },
    ]);

    const rowsResponse = await api(env, ctx, token, `/api/database/rows/table/${duplicatedTable.id}/?order_by=field_${nameField.id}&size=10`, "GET", undefined);
    expect(rowsResponse.status).toBe(200);
    const rows = await rowsResponse.json() as any;
    expect(rows.results.map((row: any) => row[`field_${nameField.id}`])).toEqual(["App One", "App Two"]);
    expect(rows.results.map((row: any) => row[`field_${statusField.id}`].value)).toEqual(["Todo", "Done"]);
    expect(rows.results[0][`field_${statusField.id}`].id).toBe(statusField.select_options.find((option: any) => option.value === "Todo").id);
    expect(rows.results[0][`field_${tagsField.id}`].map((option: any) => option.id)).toEqual([
      tagsField.select_options.find((option: any) => option.value === "Red").id,
      tagsField.select_options.find((option: any) => option.value === "Blue").id,
    ]);
    expect(rows.results.map((row: any) => row[`field_${discountField.id}`])).toEqual(["31", "32"]);
    const duplicatedCustomersResponse = await api(env, ctx, token, `/api/database/rows/table/${duplicatedCustomersTable.id}/?order_by=field_${duplicatedCustomerNameField.id}&size=10`, "GET", undefined);
    expect(duplicatedCustomersResponse.status).toBe(200);
    const duplicatedCustomers = await duplicatedCustomersResponse.json() as any;
    const customerA = duplicatedCustomers.results.find((row: any) => row[`field_${duplicatedCustomerNameField.id}`] === "Customer A");
    const customerB = duplicatedCustomers.results.find((row: any) => row[`field_${duplicatedCustomerNameField.id}`] === "Customer B");
    expect(customerA.id).not.toBe(10);
    expect(customerB.id).not.toBe(20);
    expect(rows.results[0][`field_${customerField.id}`]).toEqual([{ id: customerA.id, value: "Customer A", order: "10000" }]);
    expect(rows.results[1][`field_${customerField.id}`]).toEqual([{ id: customerB.id, value: "Customer B", order: "20000" }]);

    const defaultedResponse = await api(env, ctx, token, `/api/database/rows/table/${duplicatedTable.id}/`, "POST", {
      [`field_${nameField.id}`]: "Defaulted duplicate app",
    });
    expect(defaultedResponse.status).toBe(200);
    const defaulted = await defaultedResponse.json() as any;
    expect(defaulted[`field_${statusField.id}`].id).toBe(statusField.single_select_default);
    expect(defaulted[`field_${tagsField.id}`].map((option: any) => option.id)).toEqual(tagsField.multiple_select_default);

    const duplicatedViews = await db.prepare("SELECT * FROM database_view WHERE table_id=? ORDER BY [order] ASC, id ASC")
      .bind(duplicatedTable.id)
      .all<any>();
    const grid = duplicatedViews.results.find((view: any) => view.name === "Configured grid");
    const formView = duplicatedViews.results.find((view: any) => view.name === "Configured form");
    const todoOptionId = statusField.select_options.find((option: any) => option.value === "Todo").id;
    expect(grid).toMatchObject({
      type: "grid",
      filter_type: "OR",
      public: 1,
      allow_public_export: 1,
      public_view_password: "secret",
      card_cover_image_field: nameField.id,
    });
    expect(grid.slug).not.toBe("sourcegrid");

    const filter = await db.prepare("SELECT * FROM database_viewfilter WHERE view_id=?").bind(grid.id).first<any>();
    expect(filter).toMatchObject({ field_id: statusField.id, type: "single_select_equal", value: String(todoOptionId) });
    expect(JSON.parse(filter.preload_values)).toMatchObject({ field_id: statusField.id, select_option_id: todoOptionId });
    const sort = await db.prepare("SELECT * FROM database_viewsort WHERE view_id=?").bind(grid.id).first<any>();
    expect(sort).toMatchObject({ field_id: nameField.id, order: "DESC" });
    const groupBy = await db.prepare("SELECT * FROM database_viewgroupby WHERE view_id=?").bind(grid.id).first<any>();
    expect(groupBy).toMatchObject({ field_id: statusField.id, width: 260 });
    const decoration = await db.prepare("SELECT * FROM database_viewdecoration WHERE view_id=?").bind(grid.id).first<any>();
    expect(JSON.parse(decoration.value_provider_conf)).toMatchObject({ field_id: statusField.id, select_option_id: todoOptionId });
    const gridOption = await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=?").bind(grid.id).first<any>();
    expect(gridOption).toMatchObject({ field_id: statusField.id, width: 360, hidden: 1, aggregation_type: "count" });

    expect(formView.slug).not.toBe("sourceform");
    const formDetails = await db.prepare("SELECT * FROM database_formview WHERE view_ptr_id=?").bind(formView.id).first<any>();
    expect(formDetails).toMatchObject({ title: "Lead form", submit_text: "Send", mode: "survey", show_logo: 0 });
    const formOption = await db.prepare("SELECT * FROM database_formviewfieldoptions WHERE form_view_id=?").bind(formView.id).first<any>();
    expect(formOption).toMatchObject({ field_id: statusField.id, name: "Status label", include_all_select_options: 0 });
    const allowed = await db.prepare("SELECT * FROM database_formviewfieldoptions_allowedselectoptions WHERE form_view_field_options_id=?").bind(formOption.id).first<any>();
    expect(allowed.select_option_id).toBe(todoOptionId);
    const condition = await db.prepare("SELECT * FROM database_formviewfieldoptionscondition WHERE field_option_id=?").bind(formOption.id).first<any>();
    expect(condition).toMatchObject({ field_id: statusField.id, value: String(todoOptionId) });
  });

  it("moves rows with a stable order and records Baserow side effects", async () => {
    const { db, env, ctx, token } = await setupRowsFixture();
    const createdResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "One" },
        { field_101: "Two" },
        { field_101: "Three" },
      ],
    });
    expect(createdResponse.status).toBe(200);
    await db.prepare('UPDATE "database_table_20" SET [order]=10000 WHERE id=1').run();
    await db.prepare('UPDATE "database_table_20" SET [order]=20000 WHERE id=2').run();
    await db.prepare('UPDATE "database_table_20" SET [order]=30000 WHERE id=3').run();

    const movedResponse = await api(env, ctx, token, "/api/database/rows/table/20/3/move/?before_id=2", "PATCH", null);
    expect(movedResponse.status).toBe(200);
    const moved = await movedResponse.json() as any;
    expect(moved.id).toBe(3);
    expect(moved.order).toBe(15000);
    expect(moved.field_105).toMatchObject({ id: 7, email: "user@example.com" });

    const ordered = await db.prepare('SELECT id, [order], _last_modified_by_id FROM "database_table_20" ORDER BY [order] ASC, id ASC').all<any>();
    expect(ordered.results.map((row: any) => [row.id, row.order, row._last_modified_by_id])).toEqual([
      [1, 10000, 7],
      [3, 15000, 7],
      [2, 20000, 7],
    ]);

    const history = await db.prepare("SELECT action_type, before_values, after_values FROM database_rowhistory WHERE table_id=20 AND row_id=3 ORDER BY id DESC LIMIT 1").first<any>();
    expect(history.action_type).toBe("move_row");
    expect(JSON.parse(history.before_values)).toEqual({ order: 30000 });
    expect(JSON.parse(history.after_values)).toEqual({ order: 15000 });

    const audit = await db.prepare("SELECT type, action_object_id, action_params FROM enterprise_auditlogentry WHERE type='database.rows.move' ORDER BY id DESC LIMIT 1").first<any>();
    expect(audit).toMatchObject({ type: "database.rows.move", action_object_id: 3 });
    expect(JSON.parse(audit.action_params)).toMatchObject({ table_id: 20, row_id: 3, before_id: 2 });
  });
});
