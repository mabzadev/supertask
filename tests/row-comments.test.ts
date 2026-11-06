import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { addFieldColumn, getOrCreateUserTable } from "../src/services/dynamic-tables";

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
  for (const file of ["0001_initial.sql", "0051_last_password_change.sql", "0005_templates.sql", "0020_view_filter_groups.sql", "0023_row_comments.sql"]) {
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

function commentMessage(text: string, mentionUserId?: number) {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  if (mentionUserId) content.push({ type: "mention", attrs: { id: mentionUserId, label: `User ${mentionUserId}` } });
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

async function setupFixture() {
  const db = createTestD1();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 3)")
    .bind(now)
    .run();
  for (const user of [
    { id: 7, email: "author@example.com", first_name: "Author" },
    { id: 8, email: "subscriber@example.com", first_name: "Subscriber" },
    { id: 9, email: "mentioned@example.com", first_name: "Mentioned" },
  ]) {
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (?, '', ?, ?, '', ?, 0, 1, ?)`
    ).bind(user.id, user.email, user.first_name, user.email, now).run();
    await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, ?, 'COMMENTER')")
      .bind(user.id)
      .run();
  }
  await db.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (20, 10, 'Customers', 1, 1, 0, ?, ?, 0, 0, 0)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await db.prepare(
    `INSERT INTO database_field
     (id, table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
      immutable_type, immutable_properties, field_settings, created_on, updated_on)
     VALUES (101, 20, 'Name', 'text', 1, 1, 0, 0, NULL, 0, 0, 0, NULL, ?, ?)`
  ).bind(now, now).run();
  await addFieldColumn(db as any, 20, { id: 101, type: "text", primary: true });
  await db.prepare(
    `INSERT INTO "database_table_20" ([order], _created_on, _updated_on, _created_by_id, _last_modified_by_id, "field_101")
     VALUES (10000, ?, ?, 7, 7, 'Acme')`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_rowcommentsnotificationmode (table_id, row_id, user_id, mode, created_on, updated_on)
     VALUES (20, 1, 8, 'all', ?, ?)`
  ).bind(now, now).run();

  const token = await signAccessToken({ user_id: 7, email: "author@example.com", username: "author@example.com" }, "test-secret", 60);
  const broadcasts: any[] = [];
  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    CACHE: { get: async () => null, put: async () => undefined },
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
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  return { db, env, ctx, token, broadcasts };
}

async function api(env: any, ctx: any, token: string, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://test.local${path}`, {
    ...init,
    headers: {
      authorization: `JWT ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }), env, ctx);
}

describe("row comments parity", () => {
  it("creates, lists, updates and deletes Baserow-compatible row comments", async () => {
    const { env, ctx, token, broadcasts } = await setupFixture();

    const createResponse = await api(env, ctx, token, "/api/row_comments/20/1/", {
      method: "POST",
      body: JSON.stringify({ message: commentMessage("hello", 9) }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as any;
    expect(created).toMatchObject({
      id: 1,
      user_id: 7,
      first_name: "Author",
      table_id: 20,
      row_id: 1,
      edited: false,
      trashed: false,
    });
    expect(created.message.content[0].content[1]).toMatchObject({ type: "mention", attrs: { id: 9 } });

    const listResponse = await api(env, ctx, token, "/api/row_comments/20/1/?limit=10&offset=0");
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as any;
    expect(list.count).toBe(1);
    expect(list.results[0].id).toBe(created.id);

    const updateResponse = await api(env, ctx, token, "/api/row_comments/20/comment/1/", {
      method: "PATCH",
      body: JSON.stringify({ message: commentMessage("updated") }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json() as any;
    expect(updated.message.content[0].content[0].text).toBe("updated");
    expect(updated.edited).toBe(true);

    const deleteResponse = await api(env, ctx, token, "/api/row_comments/20/comment/1/", { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
    const deleted = await deleteResponse.json() as any;
    expect(deleted.trashed).toBe(true);
    expect(deleted.message).toBeNull();

    const eventTypes = broadcasts.map((entry) => entry.message.type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      "row_comment_created",
      "row_comment_updated",
      "row_comment_deleted",
      "row_comments_notification_mode_updated",
    ]));

    const auditEntries = await env.DB.prepare(
      "SELECT type, action_object_id, action_object_type, action_params FROM enterprise_auditlogentry ORDER BY id ASC"
    ).all<any>();
    expect((auditEntries.results || []).map((entry: any) => entry.type)).toEqual([
      "create_row_comment",
      "update_row_comment",
      "delete_row_comment",
    ]);
    expect((auditEntries.results || [])[0]).toMatchObject({
      action_object_id: 1,
      action_object_type: "row_comment",
    });
    expect(JSON.parse((auditEntries.results || [])[1].action_params)).toMatchObject({
      comment_id: 1,
      row_id: 1,
      table_id: 20,
      table_name: "Customers",
      database_id: 10,
      workspace_id: 1,
    });
  });

  it("creates row comment notifications and stores notification mode", async () => {
    const { db, env, ctx, token } = await setupFixture();

    const createResponse = await api(env, ctx, token, "/api/row_comments/20/1/", {
      method: "POST",
      body: JSON.stringify({ message: commentMessage("hello", 9) }),
    });
    expect(createResponse.status).toBe(200);

    const notifications = await db.prepare(
      `SELECT n.type, nr.recipient_id, n.data
       FROM core_notification n
       JOIN core_notificationrecipient nr ON nr.notification_id=n.id
       ORDER BY n.type, nr.recipient_id`
    ).all<any>();
    expect((notifications.results || []).map((row) => [row.type, row.recipient_id])).toEqual([
      ["row_comment", 8],
      ["row_comment_mention", 9],
    ]);
    const notificationData = JSON.parse((notifications.results || [])[0].data);
    expect(notificationData).toMatchObject({
      database_id: 10,
      database_name: "Database",
      table_id: 20,
      table_name: "Customers",
      row_id: 1,
      row_name: "Acme",
      comment_id: 1,
    });

    const mode = await db.prepare(
      "SELECT mode FROM database_rowcommentsnotificationmode WHERE table_id=20 AND row_id=1 AND user_id=7"
    ).first<{ mode: string }>();
    expect(mode?.mode).toBe("all");

    const modeResponse = await api(env, ctx, token, "/api/row_comments/20/1/notification-mode/", {
      method: "PUT",
      body: JSON.stringify({ mode: "mentions" }),
    });
    expect(modeResponse.status).toBe(204);
    const updatedMode = await db.prepare(
      "SELECT mode FROM database_rowcommentsnotificationmode WHERE table_id=20 AND row_id=1 AND user_id=7"
    ).first<{ mode: string }>();
    expect(updatedMode?.mode).toBe("mentions");
  });

  it("returns Baserow row comment metadata for rows and view payloads", async () => {
    const { db, env, ctx, token } = await setupFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug, trashed,
        show_logo, allow_public_export, ownership_type, row_height_size, row_identifier_type, created_on, updated_on)
       VALUES (30, 20, 'Grid', 'grid', 1, 'AND', 0, 0, 'grid-slug', 0, 1, 0, 'collaborative', 'small', 'count', ?, ?)`
    ).bind(now, now).run();

    const createResponse = await api(env, ctx, token, "/api/row_comments/20/1/", {
      method: "POST",
      body: JSON.stringify({ message: commentMessage("visible metadata") }),
    });
    expect(createResponse.status).toBe(200);

    const viewResponse = await api(env, ctx, token, "/api/database/views/grid/30/?include=row_metadata&limit=10");
    expect(viewResponse.status).toBe(200);
    const viewPayload = await viewResponse.json() as any;
    expect(viewPayload.results.map((row: any) => row.id)).toEqual([1]);
    expect(viewPayload.row_metadata["1"]).toMatchObject({
      row_comment_count: 1,
      row_comments_notification_mode: "all",
    });

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/1/?include=metadata");
    expect(rowResponse.status).toBe(200);
    const rowPayload = await rowResponse.json() as any;
    expect(rowPayload.metadata).toMatchObject({
      row_comment_count: 1,
      row_comments_notification_mode: "all",
    });

    const modeResponse = await api(env, ctx, token, "/api/row_comments/20/1/notification-mode/", {
      method: "PUT",
      body: JSON.stringify({ mode: "mentions" }),
    });
    expect(modeResponse.status).toBe(204);

    const defaultModeResponse = await api(env, ctx, token, "/api/database/views/grid/30/?include=row_metadata&limit=10");
    expect(defaultModeResponse.status).toBe(200);
    const defaultModePayload = await defaultModeResponse.json() as any;
    expect(defaultModePayload.row_metadata["1"]).toMatchObject({ row_comment_count: 1 });
    expect(defaultModePayload.row_metadata["1"].row_comments_notification_mode).toBeUndefined();
  });

  it("restores trashed row comments through the Baserow trash flow", async () => {
    const { db, env, ctx, token, broadcasts } = await setupFixture();

    const createResponse = await api(env, ctx, token, "/api/row_comments/20/1/", {
      method: "POST",
      body: JSON.stringify({ message: commentMessage("restore me") }),
    });
    expect(createResponse.status).toBe(200);

    const deleteResponse = await api(env, ctx, token, "/api/row_comments/20/comment/1/", { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);

    const trashEntry = await db.prepare(
      "SELECT trash_item_type, trash_item_id, workspace_id, application_id FROM core_trasheditem WHERE trash_item_type='row_comment'"
    ).first<any>();
    expect(trashEntry).toMatchObject({
      trash_item_type: "row_comment",
      trash_item_id: 1,
      workspace_id: 1,
      application_id: 10,
    });

    const emptyListResponse = await api(env, ctx, token, "/api/row_comments/20/1/?limit=10&offset=0");
    expect(emptyListResponse.status).toBe(200);
    expect((await emptyListResponse.json() as any).count).toBe(0);

    const restoreResponse = await api(env, ctx, token, "/api/trash/restore/", {
      method: "PATCH",
      body: JSON.stringify({ trash_item_type: "row_comment", trash_item_id: 1 }),
    });
    expect(restoreResponse.status).toBe(200);

    const restoredListResponse = await api(env, ctx, token, "/api/row_comments/20/1/?limit=10&offset=0");
    expect(restoredListResponse.status).toBe(200);
    const restoredList = await restoredListResponse.json() as any;
    expect(restoredList.count).toBe(1);
    expect(restoredList.results[0].message.content[0].content[0].text).toBe("restore me");

    const restoredTrashEntry = await db.prepare(
      "SELECT id FROM core_trasheditem WHERE trash_item_type='row_comment'"
    ).first<any>();
    expect(restoredTrashEntry).toBeNull();
    expect(broadcasts.map((entry) => entry.message.type)).toEqual(expect.arrayContaining([
      "row_comment_deleted",
      "row_comment_restored",
    ]));
  });
});
