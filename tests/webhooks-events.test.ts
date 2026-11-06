import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { addFieldColumn, getOrCreateUserTable, type FieldType } from "../src/services/dynamic-tables";
import { processWebhookTriggerQueueMessage, recoverWebhookDeliveryQueue, triggerTableWebhooks } from "../src/routes/database/webhooks";

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
  for (const file of [
    "0001_initial.sql", "0051_last_password_change.sql",
    "0005_templates.sql",
    "0006_field_rules_data_sync.sql",
    "0019_premium_view_settings.sql",
    "0020_view_filter_groups.sql",
    "0022_form_view_field_options_logic.sql",
    "0025_row_history_undo_redo.sql",
    "0026_core_action_undo_redo.sql",
    "0043_form_view_submit_notifications.sql",
    "0045_webhook_delivery_queue.sql",
  ]) {
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

async function createField(
  db: TestD1,
  tableId: number,
  id: number,
  name: string,
  type: FieldType,
  order: number,
  settings: Record<string, unknown> | null = null
) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO database_field
     (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on, db_index,
      immutable_type, immutable_properties)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 0, 0)`
  ).bind(
    id,
    tableId,
    name,
    type,
    order,
    order === 1 ? 1 : 0,
    settings ? JSON.stringify(settings) : null,
    now,
    now,
    order === 1 ? 1 : 0
  ).run();
  await addFieldColumn(db as any, tableId, { id, type, primary: order === 1 });
}

async function setupFixture() {
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
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
    .run();
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

  const token = await signAccessToken({ user_id: 7, email: "user@example.com", username: "user@example.com" }, "test-secret", 60);
  const waitUntilPromises: Promise<unknown>[] = [];
  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    CACHE: { get: async () => null, put: async () => undefined },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    FILES: { head: async () => null },
    ENVIRONMENT: "test",
  } as any;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise.catch(() => undefined));
    },
    passThroughOnException: () => undefined,
  } as any;

  return { db, env, ctx, token, waitUntilPromises };
}

async function setupLinkedTablesFixture() {
  const fixture = await setupFixture();
  const now = new Date().toISOString();
  await fixture.db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (21, 10, 'Targets', 2, 1, 0, ?, ?, 0, 0, 0)`
  ).bind(now, now).run();
  await getOrCreateUserTable(fixture.db as any, 21);
  await createField(fixture.db, 21, 201, "Target name", "text", 1);
  await createField(fixture.db, 21, 202, "Rows", "link_row", 2, {
    link_row_table_id: 20,
    link_row_related_field_id: 102,
  });
  await createField(fixture.db, 20, 102, "Targets", "link_row", 2, {
    link_row_table_id: 21,
    link_row_related_field_id: 202,
  });
  return fixture;
}

async function api(env: any, ctx: any, token: string, path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `JWT ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
}

async function drain(waitUntilPromises: Promise<unknown>[]) {
  const pending = waitUntilPromises.splice(0);
  await Promise.all(pending);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Baserow webhook event parity", () => {
  it("undoes and redoes view create, update and delete actions by client session and table scope", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const headers = { ClientSessionId: "session-undo-views" };

    const createResponse = await api(env, ctx, token, "/api/database/views/table/20/", "POST", {
      name: "Contact form",
      type: "form",
    }, headers);
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as any;

    const undoCreateResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoCreateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "create_view", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT trashed FROM database_view WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ trashed: 1 });

    const redoCreateResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoCreateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "create_view", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT trashed FROM database_view WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ trashed: 0 });

    const updateResponse = await api(env, ctx, token, `/api/database/views/${created.id}/`, "PATCH", {
      name: "Survey form",
      public: true,
      title: "Survey title",
      mode: "survey",
      submit_text: "Send",
    }, headers);
    expect(updateResponse.status).toBe(200);

    const undoUpdateResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoUpdateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "update_view", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT name, public FROM database_view WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ name: "Contact form", public: 0 });
    expect(await db.prepare("SELECT title, mode, submit_text FROM database_formview WHERE view_ptr_id=?").bind(created.id).first<any>())
      .toMatchObject({ title: "", mode: "form", submit_text: "Submit" });

    const redoUpdateResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoUpdateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "update_view", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT name, public FROM database_view WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ name: "Survey form", public: 1 });
    expect(await db.prepare("SELECT title, mode, submit_text FROM database_formview WHERE view_ptr_id=?").bind(created.id).first<any>())
      .toMatchObject({ title: "Survey title", mode: "survey", submit_text: "Send" });

    const deleteResponse = await api(env, ctx, token, `/api/database/views/${created.id}/`, "DELETE", undefined, headers);
    expect(deleteResponse.status).toBe(200);

    const undoDeleteResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoDeleteResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "delete_view", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT trashed, name FROM database_view WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ trashed: 0, name: "Survey form" });

    const redoDeleteResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoDeleteResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "delete_view", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT trashed FROM database_view WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ trashed: 1 });
  });

  it("undoes and redoes grouped view configuration actions with full dependent state", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const headers = {
      ClientSessionId: "session-undo-view-config",
      ClientUndoRedoActionGroupId: "view-config-group-1",
    };

    const createResponse = await api(env, ctx, token, "/api/database/views/table/20/", "POST", {
      name: "Grid",
      type: "grid",
    }, { ClientSessionId: "session-undo-view-config" });
    expect(createResponse.status).toBe(200);
    const view = await createResponse.json() as any;

    const groupResponse = await api(env, ctx, token, `/api/database/views/${view.id}/filter-groups/`, "POST", {
      filter_type: "OR",
    }, headers);
    expect(groupResponse.status).toBe(200);
    const filterGroup = await groupResponse.json() as any;

    expect((await api(env, ctx, token, `/api/database/views/${view.id}/filters/`, "POST", {
      field: 101,
      type: "contains",
      value: "Acme",
      group: filterGroup.id,
    }, headers)).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${view.id}/sortings/`, "POST", {
      field: 101,
      order: "DESC",
    }, headers)).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${view.id}/group_bys/`, "POST", {
      field: 101,
      order: "ASC",
      width: 255,
    }, headers)).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${view.id}/decorations/`, "POST", {
      type: "left_border_color",
      value_provider_type: "single_select_color",
      value_provider_conf: { field_id: 101 },
      order: 3,
    }, headers)).status).toBe(200);
    expect((await api(env, ctx, token, `/api/database/views/${view.id}/field-options/`, "PATCH", {
      field_options: {
        "101": {
          width: 333,
          hidden: true,
          order: 65536,
          aggregation_type: "count",
          aggregation_raw_type: "empty_count",
        },
      },
    }, headers)).status).toBe(200);

    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewfilter WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewfiltergroup WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewsort WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewgroupby WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewdecoration WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 1 });
    expect(await db.prepare("SELECT width, hidden, aggregation_type FROM database_gridviewfieldoptions WHERE grid_view_id=? AND field_id=101").bind(view.id).first<any>())
      .toMatchObject({ width: 333, hidden: 1, aggregation_type: "count" });

    const undoResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    const undoPayload = await undoResponse.json() as any;
    expect(undoPayload.result_code).toBe("SUCCESS");
    expect(undoPayload.actions).toHaveLength(6);
    expect(undoPayload.actions.every((action: any) => action.action_type === "update_view" && action.action_scope === "table20"))
      .toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewfilter WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewfiltergroup WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewsort WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewgroupby WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_viewdecoration WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ count: 0 });
    expect(await db.prepare("SELECT width, hidden, aggregation_type FROM database_gridviewfieldoptions WHERE grid_view_id=? AND field_id=101").bind(view.id).first<any>())
      .toMatchObject({ width: 200, hidden: 0, aggregation_type: "" });

    const redoResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    const redoPayload = await redoResponse.json() as any;
    expect(redoPayload.result_code).toBe("SUCCESS");
    expect(redoPayload.actions).toHaveLength(6);
    expect(await db.prepare("SELECT type, value, group_id FROM database_viewfilter WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ type: "contains", value: "Acme", group_id: filterGroup.id });
    expect(await db.prepare("SELECT filter_type FROM database_viewfiltergroup WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ filter_type: "OR" });
    expect(await db.prepare("SELECT [order] FROM database_viewsort WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ order: "DESC" });
    expect(await db.prepare("SELECT width FROM database_viewgroupby WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ width: 255 });
    expect(await db.prepare("SELECT [order], value_provider_conf FROM database_viewdecoration WHERE view_id=?").bind(view.id).first<any>())
      .toMatchObject({ order: 3, value_provider_conf: "{\"field_id\":101}" });
    expect(await db.prepare("SELECT width, hidden, aggregation_type FROM database_gridviewfieldoptions WHERE grid_view_id=? AND field_id=101").bind(view.id).first<any>())
      .toMatchObject({ width: 333, hidden: 1, aggregation_type: "count" });
  });

  it("undoes and redoes field create, update and delete actions by client session and table scope", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const headers = { ClientSessionId: "session-undo-fields" };

    const createResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Status",
      type: "text",
    }, headers);
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as any;

    const undoCreateResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoCreateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "create_field", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT trashed FROM database_field WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ trashed: 1 });

    const redoCreateResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoCreateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "create_field", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT trashed FROM database_field WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ trashed: 0 });

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      [`field_${created.id}`]: "123",
    });
    expect(rowResponse.status).toBe(200);

    const updateResponse = await api(env, ctx, token, `/api/database/fields/${created.id}/`, "PATCH", {
      name: "Amount",
      type: "number",
      number_decimal_places: 0,
    }, headers);
    expect(updateResponse.status).toBe(200);
    expect(await db.prepare("SELECT name, type FROM database_field WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ name: "Amount", type: "number" });

    const undoUpdateResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoUpdateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "update_field", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT name, type FROM database_field WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ name: "Status", type: "text" });
    expect(await db.prepare(`SELECT "field_${created.id}" AS value FROM "database_table_20" WHERE id=1`).first<any>())
      .toMatchObject({ value: "123" });

    const redoUpdateResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoUpdateResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "update_field", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT name, type FROM database_field WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ name: "Amount", type: "number" });

    const deleteResponse = await api(env, ctx, token, `/api/database/fields/${created.id}/`, "DELETE", undefined, headers);
    expect(deleteResponse.status).toBe(200);

    const undoDeleteResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoDeleteResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "delete_field", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT trashed, name, type FROM database_field WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ trashed: 0, name: "Amount", type: "number" });

    const redoDeleteResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoDeleteResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "delete_field", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT trashed FROM database_field WHERE id=?").bind(created.id).first<any>())
      .toMatchObject({ trashed: 1 });
    expect(await db.prepare("SELECT trash_item_type, trash_item_id FROM core_trasheditem WHERE trash_item_type='field' AND trash_item_id=?").bind(created.id).first<any>())
      .toMatchObject({ trash_item_type: "field", trash_item_id: created.id });
  });

  it("undoes and redoes field primary and order actions by client session and table scope", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const headers = { ClientSessionId: "session-undo-field-order" };

    const secondResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Secondary",
      type: "text",
    });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as any;

    const thirdResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Third",
      type: "text",
    });
    expect(thirdResponse.status).toBe(200);
    const third = await thirdResponse.json() as any;

    const changePrimaryResponse = await api(env, ctx, token, "/api/database/fields/table/20/change-primary-field/", "POST", {
      new_primary_field_id: second.id,
    }, headers);
    expect(changePrimaryResponse.status).toBe(200);
    expect(await db.prepare("SELECT [primary] AS primary_value FROM database_field WHERE id=?").bind(second.id).first<any>())
      .toMatchObject({ primary_value: 1 });

    const undoPrimaryResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoPrimaryResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "change_primary_field", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT [primary] AS primary_value FROM database_field WHERE id=101").first<any>())
      .toMatchObject({ primary_value: 1 });
    expect(await db.prepare("SELECT [primary] AS primary_value FROM database_field WHERE id=?").bind(second.id).first<any>())
      .toMatchObject({ primary_value: 0 });

    const redoPrimaryResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoPrimaryResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "change_primary_field", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT [primary] AS primary_value FROM database_field WHERE id=?").bind(second.id).first<any>())
      .toMatchObject({ primary_value: 1 });

    const orderResponse = await api(env, ctx, token, "/api/database/fields/table/20/order/", "POST", {
      field_ids: [third.id, second.id, 101],
    }, headers);
    expect(orderResponse.status).toBe(200);
    expect(await db.prepare("SELECT [order] AS field_order FROM database_field WHERE id=?").bind(third.id).first<any>())
      .toMatchObject({ field_order: 1 });

    const undoOrderResponse = await api(env, ctx, token, "/api/user/undo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await undoOrderResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "order_fields", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT [order] AS field_order FROM database_field WHERE id=101").first<any>())
      .toMatchObject({ field_order: 1 });
    expect(await db.prepare("SELECT [order] AS field_order FROM database_field WHERE id=?").bind(second.id).first<any>())
      .toMatchObject({ field_order: 2 });
    expect(await db.prepare("SELECT [order] AS field_order FROM database_field WHERE id=?").bind(third.id).first<any>())
      .toMatchObject({ field_order: 3 });

    const redoOrderResponse = await api(env, ctx, token, "/api/user/redo/", "PATCH", {
      scopes: { table: 20 },
    }, headers);
    expect(await redoOrderResponse.json()).toMatchObject({
      result_code: "SUCCESS",
      actions: [{ action_type: "order_fields", action_scope: "table20" }],
    });
    expect(await db.prepare("SELECT [order] AS field_order FROM database_field WHERE id=?").bind(third.id).first<any>())
      .toMatchObject({ field_order: 1 });
    expect(await db.prepare("SELECT [order] AS field_order FROM database_field WHERE id=101").first<any>())
      .toMatchObject({ field_order: 3 });
  });

  it("triggers rows.updated with old_items for single row updates", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const createdRowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Before",
    });
    expect(createdRowResponse.status).toBe(200);
    const createdRow = await createdRowResponse.json() as any;
    await drain(waitUntilPromises);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Rows hook",
      url: "https://collector.test/rows",
      include_all_events: false,
      events: ["rows.updated"],
    });
    expect(webhookResponse.status).toBe(200);
    const webhook = await webhookResponse.json() as any;

    const updatedRowResponse = await api(env, ctx, token, `/api/database/rows/table/20/${createdRow.id}/`, "PATCH", {
      field_101: "After",
    });
    expect(updatedRowResponse.status).toBe(200);
    await drain(waitUntilPromises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      event_type: "rows.updated",
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
      items: [{ id: createdRow.id, Name: "After" }],
      old_items: [{ id: createdRow.id, Name: "Before" }],
    });
  });

  it("triggers rows.updated with old_items for batch row updates", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const createdRowsResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "POST", {
      items: [
        { field_101: "One before" },
        { field_101: "Two before" },
      ],
    });
    expect(createdRowsResponse.status).toBe(200);
    const createdRows = await createdRowsResponse.json() as any;
    await drain(waitUntilPromises);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Batch rows hook",
      url: "https://collector.test/batch-rows",
      include_all_events: false,
      events: ["rows.updated"],
    });
    expect(webhookResponse.status).toBe(200);

    const updatedRowsResponse = await api(env, ctx, token, "/api/database/rows/table/20/batch/", "PATCH", {
      items: [
        { id: createdRows.items[0].id, field_101: "One after" },
        { id: createdRows.items[1].id, field_101: "Two after" },
      ],
    });
    expect(updatedRowsResponse.status).toBe(200);
    await drain(waitUntilPromises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.event_type).toBe("rows.updated");
    expect(body.items.map((row: any) => row.Name)).toEqual(["One after", "Two after"]);
    expect(body.old_items.map((row: any) => row.Name)).toEqual(["One before", "Two before"]);
    expect(body).toMatchObject({
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
    });
  });

  it("respects rows.updated field-specific webhook event_config", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const otherFieldResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Other",
      type: "text",
    });
    expect(otherFieldResponse.status).toBe(200);
    const otherField = await otherFieldResponse.json() as any;
    await drain(waitUntilPromises);

    const createdRowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Name before",
      [`field_${otherField.id}`]: "Other before",
    });
    expect(createdRowResponse.status).toBe(200);
    const createdRow = await createdRowResponse.json() as any;
    await drain(waitUntilPromises);
    fetchMock.mockClear();

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Specific field hook",
      url: "https://collector.test/specific-field",
      include_all_events: false,
      events: ["rows.updated"],
      event_config: [{ event_type: "rows.updated", fields: [otherField.id] }],
    });
    expect(webhookResponse.status).toBe(200);
    const webhook = await webhookResponse.json() as any;
    expect(webhook.event_config).toEqual([{ event_type: "rows.updated", fields: [otherField.id] }]);

    const nameUpdateResponse = await api(env, ctx, token, `/api/database/rows/table/20/${createdRow.id}/`, "PATCH", {
      field_101: "Name after",
    });
    expect(nameUpdateResponse.status).toBe(200);
    await drain(waitUntilPromises);
    expect(fetchMock).not.toHaveBeenCalled();

    const otherUpdateResponse = await api(env, ctx, token, `/api/database/rows/table/20/${createdRow.id}/`, "PATCH", {
      [`field_${otherField.id}`]: "Other after",
    });
    expect(otherUpdateResponse.status).toBe(200);
    await drain(waitUntilPromises);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      event_type: "rows.updated",
      updated_field_ids: [otherField.id],
      items: [{ id: createdRow.id, Other: "Other after" }],
      old_items: [{ id: createdRow.id, Other: "Other before" }],
    });
  });

  it("triggers view.rows_entered only when rows enter the configured filtered view", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const viewResponse = await api(env, ctx, token, "/api/database/views/table/20/", "POST", {
      name: "Ready rows",
      type: "grid",
    });
    expect(viewResponse.status).toBe(200);
    const view = await viewResponse.json() as any;

    const filterResponse = await api(env, ctx, token, `/api/database/views/${view.id}/filters/`, "POST", {
      field: 101,
      type: "contains",
      value: "ready",
    });
    expect(filterResponse.status).toBe(200);
    await drain(waitUntilPromises);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Rows enter view hook",
      url: "https://collector.test/view-entered",
      include_all_events: false,
      events: ["view.rows_entered"],
      event_config: [{ event_type: "view.rows_entered", views: [view.id] }],
    });
    expect(webhookResponse.status).toBe(200);
    const webhook = await webhookResponse.json() as any;
    expect(webhook.event_config).toEqual([{ event_type: "view.rows_entered", views: [view.id] }]);

    const createdOutsideResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "not yet",
    });
    expect(createdOutsideResponse.status).toBe(200);
    const createdOutside = await createdOutsideResponse.json() as any;
    await drain(waitUntilPromises);
    expect(fetchMock).not.toHaveBeenCalled();

    const updateIntoViewResponse = await api(env, ctx, token, `/api/database/rows/table/20/${createdOutside.id}/`, "PATCH", {
      field_101: "ready now",
    });
    expect(updateIntoViewResponse.status).toBe(200);
    await drain(waitUntilPromises);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const updateBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(updateBody).toMatchObject({
      event_type: "view.rows_entered",
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
      view_id: view.id,
      total_count: 1,
      view: { id: view.id, table_id: 20, name: "Ready rows", type: "grid" },
      row_ids: [createdOutside.id],
      rows: [{ id: createdOutside.id, Name: "ready now" }],
    });
    expect(updateBody.fields).toContain("Name");

    fetchMock.mockClear();
    const createdInsideResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "already ready",
    });
    expect(createdInsideResponse.status).toBe(200);
    const createdInside = await createdInsideResponse.json() as any;
    await drain(waitUntilPromises);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const createBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(createBody).toMatchObject({
      event_type: "view.rows_entered",
      view_id: view.id,
      row_ids: [createdInside.id],
      rows: [{ id: createdInside.id, Name: "already ready" }],
    });
  });

  it("does not trigger view.rows_entered when its configured view list is empty", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "No subscribed views",
      url: "https://collector.test/no-view",
      include_all_events: false,
      events: ["view.rows_entered"],
      event_config: [{ event_type: "view.rows_entered", views: [] }],
    });
    expect(webhookResponse.status).toBe(200);
    expect((await webhookResponse.json() as any).event_config).toEqual([
      { event_type: "view.rows_entered", views: [] },
    ]);

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Would enter the default grid",
    });
    expect(rowResponse.status).toBe(200);
    await drain(waitUntilPromises);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects use_user_field_names false in row and view webhook payloads", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const viewResponse = await api(env, ctx, token, "/api/database/views/table/20/", "POST", {
      name: "Ready ids",
      type: "grid",
    });
    expect(viewResponse.status).toBe(200);
    const view = await viewResponse.json() as any;

    const filterResponse = await api(env, ctx, token, `/api/database/views/${view.id}/filters/`, "POST", {
      field: 101,
      type: "contains",
      value: "ready",
    });
    expect(filterResponse.status).toBe(200);
    await drain(waitUntilPromises);

    const createdWebhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Field id rows hook",
      url: "https://collector.test/field-id-rows",
      include_all_events: false,
      use_user_field_names: false,
      events: ["rows.created", "view.rows_entered"],
      event_config: [{ event_type: "view.rows_entered", views: [view.id] }],
    });
    expect(createdWebhookResponse.status).toBe(200);
    const webhook = await createdWebhookResponse.json() as any;
    expect(webhook.use_user_field_names).toBe(false);

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "ready with ids",
    });
    expect(rowResponse.status).toBe(200);
    await drain(waitUntilPromises);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    const rowsCreatedBody = bodies.find((body) => body.event_type === "rows.created");
    const viewEnteredBody = bodies.find((body) => body.event_type === "view.rows_entered");
    expect(rowsCreatedBody).toMatchObject({
      webhook_id: webhook.id,
      items: [{ field_101: "ready with ids" }],
    });
    expect(rowsCreatedBody.items[0]).not.toHaveProperty("Name");
    expect(viewEnteredBody).toMatchObject({
      webhook_id: webhook.id,
      fields: ["id", "order", "field_101"],
      rows: [{ field_101: "ready with ids" }],
    });
    expect(viewEnteredBody.rows[0]).not.toHaveProperty("Name");
  });

  it("triggers rows.updated webhooks in linked tables when link_row values change", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupLinkedTablesFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const targetOneResponse = await api(env, ctx, token, "/api/database/rows/table/21/", "POST", {
      field_201: "Target one",
    });
    expect(targetOneResponse.status).toBe(200);
    const targetOne = await targetOneResponse.json() as any;
    const targetTwoResponse = await api(env, ctx, token, "/api/database/rows/table/21/", "POST", {
      field_201: "Target two",
    });
    expect(targetTwoResponse.status).toBe(200);
    const targetTwo = await targetTwoResponse.json() as any;
    await drain(waitUntilPromises);
    fetchMock.mockClear();

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/21/", "POST", {
      name: "Related table hook",
      url: "https://collector.test/related",
      include_all_events: false,
      use_user_field_names: false,
      events: ["rows.updated"],
      event_config: [{ event_type: "rows.updated", fields: [202] }],
    });
    expect(webhookResponse.status).toBe(200);
    const webhook = await webhookResponse.json() as any;

    const sourceResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Source row",
      field_102: [targetOne.id, targetTwo.id],
    });
    expect(sourceResponse.status).toBe(200);
    const source = await sourceResponse.json() as any;
    await drain(waitUntilPromises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      event_type: "rows.updated",
      table_id: 21,
      database_id: 10,
      workspace_id: 1,
      updated_field_ids: [202],
      total_count: 2,
    });
    expect(body.items.map((row: any) => row.id)).toEqual([targetOne.id, targetTwo.id]);
    expect(body.items[0].field_202).toEqual([{ id: source.id, value: "Source row", order: "10000" }]);
    expect(body.items[1].field_202).toEqual([{ id: source.id, value: "Source row", order: "10000" }]);

    fetchMock.mockClear();
    const unrelatedUpdateResponse = await api(env, ctx, token, `/api/database/rows/table/20/${source.id}/`, "PATCH", {
      field_101: "Source row renamed",
    });
    expect(unrelatedUpdateResponse.status).toBe(200);
    await drain(waitUntilPromises);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("batches related table rows.updated webhook payloads like Baserow", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupLinkedTablesFixture();
    env.BATCH_ROWS_SIZE_LIMIT = "2";
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const targetResponses = await Promise.all(["One", "Two", "Three"].map((name) =>
      api(env, ctx, token, "/api/database/rows/table/21/", "POST", { field_201: name })
    ));
    for (const response of targetResponses) expect(response.status).toBe(200);
    const targets = await Promise.all(targetResponses.map((response) => response.json() as Promise<any>));
    await drain(waitUntilPromises);
    fetchMock.mockClear();

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/21/", "POST", {
      name: "Related table batched hook",
      url: "https://collector.test/related-batched",
      include_all_events: false,
      use_user_field_names: false,
      events: ["rows.updated"],
      event_config: [{ event_type: "rows.updated", fields: [202] }],
    });
    expect(webhookResponse.status).toBe(200);
    const webhook = await webhookResponse.json() as any;

    const sourceResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Source row",
      field_102: targets.map((target) => target.id),
    });
    expect(sourceResponse.status).toBe(200);
    await drain(waitUntilPromises);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies.map((body) => body.event_id)).toEqual([bodies[0].event_id, bodies[0].event_id]);
    expect(bodies[0]).toMatchObject({
      event_type: "rows.updated",
      table_id: 21,
      updated_field_ids: [202],
      total_count: 3,
      offset: 0,
      batch_size: 2,
      batch_id: 1,
    });
    expect(bodies[0].items.map((row: any) => row.id)).toEqual([targets[0].id, targets[1].id]);
    expect(bodies[1]).toMatchObject({
      event_type: "rows.updated",
      table_id: 21,
      updated_field_ids: [202],
      total_count: 3,
      offset: 2,
      batch_size: 1,
      batch_id: 2,
    });
    expect(bodies[1].items.map((row: any) => row.id)).toEqual([targets[2].id]);
    const storedResponse = await api(env, ctx, token, `/api/database/webhooks/${webhook.id}/`, "GET", undefined);
    expect(storedResponse.status).toBe(200);
    const stored = await storedResponse.json() as any;
    expect(stored.calls).toHaveLength(2);
    expect(stored.calls.map((call: any) => call.event_id)).toEqual([bodies[0].event_id, bodies[0].event_id]);
    expect(stored.calls.map((call: any) => call.batch_id).sort()).toEqual([1, 2]);
  });

  it("stops webhook payloads after five batches and notifies workspace admins", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Batch limited hook",
      url: "https://collector.test/batch-limit",
      include_all_events: false,
      events: ["rows.updated"],
    });
    const webhook = await webhookResponse.json() as any;

    await triggerTableWebhooks(env, 20, "rows.updated", {
      event_id: "large-event",
      batch_id: 6,
      offset: 1000,
      batch_size: 200,
      total_count: 1200,
      items: [{ id: 1, field_101: "discarded" }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const notification = await db.prepare(
      "SELECT workspace_id, data FROM core_notification WHERE type='webhook_payload_too_large'"
    ).first<any>();
    expect(notification?.workspace_id).toBe(1);
    expect(JSON.parse(notification.data)).toMatchObject({
      webhook_id: webhook.id,
      table_id: 20,
      database_id: 10,
      webhook_name: "Batch limited hook",
      event_id: "large-event",
      batch_limit: 5,
    });
  });

  it("serializes webhook call request and response like Baserow", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { "content-type": "application/json", "x-collector": "accepted" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Call log hook",
      url: "https://collector.test/calls",
      include_all_events: false,
      events: ["rows.created"],
      headers: [{ name: "X-Custom", value: "value" }],
    });
    expect(webhookResponse.status).toBe(200);
    const webhook = await webhookResponse.json() as any;

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", "POST", {
      field_101: "Logged",
    });
    expect(rowResponse.status).toBe(200);
    await drain(waitUntilPromises);

    const refreshedResponse = await api(env, ctx, token, `/api/database/webhooks/${webhook.id}/`, "GET", undefined);
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json() as any;
    expect(refreshed.calls).toHaveLength(1);
    expect(refreshed.calls[0]).toMatchObject({
      event_type: "rows.created",
      called_url: "https://collector.test/calls",
      response_status: 202,
      error: "",
    });
    expect(refreshed.calls[0].request).toContain("POST https://collector.test/calls");
    expect(refreshed.calls[0].request).toContain("x-baserow-event: rows.created");
    expect(refreshed.calls[0].request).toContain("\"event_type\": \"rows.created\"");
    expect(refreshed.calls[0].request).toContain("\"Name\": \"Logged\"");
    expect(refreshed.calls[0].response).toContain("x-collector: accepted");
    expect(refreshed.calls[0].response).toContain("\"ok\": true");
  });

  it("retries failed webhook deliveries with one event log then deactivates and notifies admins", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const deliveries: Array<{ message: any; options: any }> = [];
    env.JOBS_QUEUE = {
      send: async (message: any, options: any) => { deliveries.push({ message, options }); },
    };
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Retry hook",
      url: "https://collector.test/retry",
      include_all_events: false,
      events: ["rows.created"],
    });
    expect(webhookResponse.status).toBe(200);
    const webhook = await webhookResponse.json() as any;
    await db.prepare(
      "UPDATE database_tablewebhook SET consecutive_trigger_failures=8 WHERE id=?"
    ).bind(webhook.id).run();

    await triggerTableWebhooks(env, 20, "rows.created", { items: [{ id: 1, field_101: "Retry" }] });
    expect(deliveries.map((delivery) => delivery.message.payload.dispatch)).toEqual([true]);
    expect(fetchMock).not.toHaveBeenCalled();
    while (deliveries.length > 0) {
      const delivery = deliveries.shift()!;
      await db.prepare(
        "UPDATE database_tablewebhookdelivery SET available_at=0 WHERE webhook_id=? AND status='queued'"
      ).bind(webhook.id).run();
      await processWebhookTriggerQueueMessage(env, delivery.message.payload);
    }

    expect(fetchMock).toHaveBeenCalledTimes(9);
    const storedWebhook = await db.prepare(
      "SELECT active, failed_trigger, consecutive_trigger_failures FROM database_tablewebhook WHERE id=?"
    ).bind(webhook.id).first<any>();
    expect(storedWebhook).toMatchObject({ active: 0, failed_trigger: 1, consecutive_trigger_failures: 8 });
    const calls = await db.prepare(
      "SELECT COUNT(*) AS count, MIN(batch_id) AS event_id, MAX(batch_id) AS last_event_id FROM database_tablewebhookcall WHERE webhook_id=?"
    ).bind(webhook.id).first<any>();
    expect(calls.count).toBe(1);
    expect(calls.event_id).toBe(calls.last_event_id);
    const notification = await db.prepare(
      "SELECT type, workspace_id, data FROM core_notification WHERE type='webhook_deactivated'"
    ).first<any>();
    expect(notification).toMatchObject({ type: "webhook_deactivated", workspace_id: 1 });
    expect(JSON.parse(notification.data)).toMatchObject({
      webhook_id: webhook.id,
      table_id: 20,
      database_id: 10,
      webhook_name: "Retry hook",
    });
    const recipient = await db.prepare(
      "SELECT recipient_id FROM core_notificationrecipient WHERE notification_id=(SELECT id FROM core_notification WHERE type='webhook_deactivated')"
    ).first<any>();
    expect(recipient?.recipient_id).toBe(7);
  });

  it("serializes concurrent production deliveries in persistent FIFO order per webhook", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const deliveries: Array<{ message: any; options: any }> = [];
    env.JOBS_QUEUE = {
      send: async (message: any, options: any) => { deliveries.push({ message, options }); },
    };
    let active = 0;
    let maxActive = 0;
    const received: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      received.push(JSON.parse(String(init.body)).sequence);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Ordered hook",
      url: "https://collector.test/ordered",
      include_all_events: false,
      events: ["rows.created"],
    });
    const webhook = await webhookResponse.json() as any;
    await Promise.all([1, 2, 3].map((sequence) =>
      triggerTableWebhooks(env, 20, "rows.created", { sequence, items: [{ id: sequence }] })
    ));
    expect(fetchMock).not.toHaveBeenCalled();

    let rounds = 0;
    while (deliveries.length > 0 && rounds < 20) {
      const batch = deliveries.splice(0);
      await Promise.all(batch.map((delivery) => processWebhookTriggerQueueMessage(env, delivery.message.payload)));
      rounds += 1;
    }

    expect(received).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM database_tablewebhookdelivery WHERE webhook_id=?"
    ).bind(webhook.id).first<{ count: number }>()).toMatchObject({ count: 0 });
  });

  it("recovers persisted webhook deliveries when the initial Queue signal fails", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const deliveries: any[] = [];
    let queueAvailable = false;
    env.JOBS_QUEUE = {
      send: async (message: any) => {
        if (!queueAvailable) throw new Error("queue unavailable");
        deliveries.push(message);
      },
    };
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Recoverable hook",
      url: "https://collector.test/recover",
      include_all_events: false,
      events: ["rows.created"],
    });
    const webhook = await webhookResponse.json() as any;

    await triggerTableWebhooks(env, 20, "rows.created", { items: [{ id: 1 }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM database_tablewebhookdelivery WHERE webhook_id=?"
    ).bind(webhook.id).first<{ count: number }>()).toMatchObject({ count: 1 });

    queueAvailable = true;
    expect(await recoverWebhookDeliveryQueue(env)).toBe(1);
    await processWebhookTriggerQueueMessage(env, deliveries.shift().payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM database_tablewebhookdelivery WHERE webhook_id=?"
    ).bind(webhook.id).first<{ count: number }>()).toMatchObject({ count: 0 });
  });

  it("keeps the ten newest call logs and rejects a twenty-first webhook", async () => {
    const { db, env, ctx, token } = await setupFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const firstResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Retention hook",
      url: "https://collector.test/retention",
      include_all_events: false,
      events: ["rows.created"],
    });
    const first = await firstResponse.json() as any;
    for (let index = 1; index <= 11; index += 1) {
      await triggerTableWebhooks(env, 20, "rows.created", { event_id: `event-${index}`, items: [{ id: index }] });
    }
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM database_tablewebhookcall WHERE webhook_id=?"
    ).bind(first.id).first<{ count: number }>()).toMatchObject({ count: 10 });

    for (let index = 2; index <= 20; index += 1) {
      const response = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
        name: `Hook ${index}`,
        url: `https://collector.test/hook-${index}`,
        include_all_events: true,
      });
      expect(response.status).toBe(200);
    }
    const rejected = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Hook 21",
      url: "https://collector.test/hook-21",
      include_all_events: true,
    });
    expect(rejected.status).toBe(400);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_tablewebhook WHERE table_id=20").first<{ count: number }>())
      .toMatchObject({ count: 20 });
  });

  it("returns the Baserow test-call modal contract", async () => {
    const { env, ctx, token } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("created", {
      status: 201,
      headers: { "x-test-call": "yes" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await api(env, ctx, token, "/api/database/webhooks/table/20/test-call/", "POST", {
      name: "Test call hook",
      url: "https://collector.test/test-call",
      request_method: "POST",
      event_type: "rows.created",
      headers: [{ name: "X-Custom", value: "value" }],
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;

    expect(body.status_code).toBe(201);
    expect(body.is_unreachable).toBe(false);
    expect(body.request).toContain("POST https://collector.test/test-call");
    expect(body.request).toContain("x-baserow-event: rows.created");
    expect(body.request).toContain("\"event_type\": \"rows.created\"");
    expect(body.response).toContain("x-test-call: yes");
    expect(body.response).toContain("created");
  });

  it("executes GET webhooks without a forbidden Fetch API request body", async () => {
    const { env, ctx, token } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await api(env, ctx, token, "/api/database/webhooks/table/20/test-call/", "POST", {
      name: "GET hook",
      url: "https://collector.test/get",
      request_method: "GET",
      event_type: "rows.created",
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", body: undefined });
    expect((await response.json() as any).request).toContain("GET https://collector.test/get");
  });

  it("rejects invalid webhook URLs, methods, events and headers before D1 mutation", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const invalidBodies = [
      { name: "Private", url: "http://127.0.0.1/hook", events: ["rows.created"] },
      { name: "Method", url: "https://collector.test/hook", request_method: "TRACE", events: ["rows.created"] },
      { name: "Event", url: "https://collector.test/hook", events: ["rows.unknown"] },
      { name: "Header", url: "https://collector.test/hook", events: ["rows.created"], headers: { "Bad Header": "value" } },
      { name: "Value", url: "https://collector.test/hook", events: ["rows.created"], headers: { "X-Test": "ok\r\ninjected" } },
    ];
    for (const body of invalidBodies) {
      const response = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", body);
      expect(response.status).toBe(400);
    }
    const count = await db.prepare("SELECT COUNT(*) AS count FROM database_tablewebhook").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("triggers field.created, field.updated and field.deleted payloads", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "Field hook",
      url: "https://collector.test/field",
      include_all_events: false,
      events: ["field.created", "field.updated", "field.deleted"],
    });
    expect(webhookResponse.status).toBe(200);

    const createdResponse = await api(env, ctx, token, "/api/database/fields/table/20/", "POST", {
      name: "Status",
      type: "text",
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as any;
    await drain(waitUntilPromises);

    const updatedResponse = await api(env, ctx, token, `/api/database/fields/${created.id}/`, "PATCH", {
      name: "State",
    });
    expect(updatedResponse.status).toBe(200);
    await drain(waitUntilPromises);

    const deletedResponse = await api(env, ctx, token, `/api/database/fields/${created.id}/`, "DELETE", undefined);
    expect(deletedResponse.status).toBe(200);
    await drain(waitUntilPromises);

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies.map((body) => body.event_type)).toEqual(["field.created", "field.updated", "field.deleted"]);
    expect(bodies[0]).toMatchObject({
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
      field: { id: created.id, name: "Status", type: "text" },
    });
    expect(bodies[1]).toMatchObject({
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
      field: { id: created.id, name: "State", type: "text" },
    });
    expect(bodies[2]).toMatchObject({
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
      field_id: created.id,
    });
  });

  it("triggers view.created, view.updated and view.deleted payloads", async () => {
    const { env, ctx, token, waitUntilPromises } = await setupFixture();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const webhookResponse = await api(env, ctx, token, "/api/database/webhooks/table/20/", "POST", {
      name: "View hook",
      url: "https://collector.test/view",
      include_all_events: false,
      events: ["view.created", "view.updated", "view.deleted"],
    });
    expect(webhookResponse.status).toBe(200);

    const createdResponse = await api(env, ctx, token, "/api/database/views/table/20/", "POST", {
      name: "Grid",
      type: "grid",
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as any;
    await drain(waitUntilPromises);

    const updatedResponse = await api(env, ctx, token, `/api/database/views/${created.id}/`, "PATCH", {
      name: "Renamed grid",
    });
    expect(updatedResponse.status).toBe(200);
    await drain(waitUntilPromises);

    const deletedResponse = await api(env, ctx, token, `/api/database/views/${created.id}/`, "DELETE", undefined);
    expect(deletedResponse.status).toBe(200);
    await drain(waitUntilPromises);

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies.map((body) => body.event_type)).toEqual(["view.created", "view.updated", "view.deleted"]);
    expect(bodies[0]).toMatchObject({
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
      view: { id: created.id, name: "Grid", type: "grid" },
    });
    expect(bodies[1]).toMatchObject({
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
      view: { id: created.id, name: "Renamed grid", type: "grid" },
    });
    expect(bodies[2]).toMatchObject({
      table_id: 20,
      database_id: 10,
      workspace_id: 1,
      view_id: created.id,
    });
  });
});
