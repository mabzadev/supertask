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
  database.exec(readFileSync(join(process.cwd(), "migrations", "0001_initial.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0051_last_password_change.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0009_builder_core.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0039_builder_published_applications.sql"), "utf8"));
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

async function setupSearchFixture() {
  const db = createTestD1();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Needle Workspace', ?, 0, 1)")
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
     VALUES (10, 1, 'Needle Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (20, 10, 'Needle Customers', 1, 1, 0, ?, ?, 0, 0, 0)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  for (const field of [
    { id: 101, name: "Name", order: 1, primary: 1 },
    { id: 102, name: "Needle Notes", order: 2, primary: 0 },
  ]) {
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
        immutable_type, immutable_properties, field_settings, created_on, updated_on)
       VALUES (?, 20, ?, 'text', ?, ?, 0, 0, ?, 0, 0, 0, NULL, ?, ?)`
    ).bind(field.id, field.name, field.order, field.primary, field.id === 102 ? "Needle description" : null, now, now).run();
    await addFieldColumn(db as any, 20, { id: field.id, type: "text", primary: Boolean(field.primary) });
  }
  await db.prepare(
    `INSERT INTO "database_table_20" ([order], _created_on, _updated_on, _created_by_id, _last_modified_by_id, "field_101", "field_102")
     VALUES (10000, ?, ?, 7, 7, 'Acme primary', 'Needle row content')`
  ).bind(now, now).run();

  const token = await signAccessToken({ user_id: 7, email: "user@example.com", username: "user@example.com" }, "test-secret", 60);
  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    CACHE: { get: async () => null, put: async () => undefined },
    FILES: { head: async () => null },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    ENVIRONMENT: "test",
  } as any;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  return { env, ctx, token };
}

async function api(env: any, ctx: any, token: string, path: string) {
  return worker.fetch(new Request(`https://test.local${path}`, {
    headers: { authorization: `JWT ${token}` },
  }), env, ctx);
}

describe("workspace search parity", () => {
  it("returns Supertask workspace search types with offset pagination", async () => {
    const { env, ctx, token } = await setupSearchFixture();

    const firstResponse = await api(env, ctx, token, "/api/search/workspace/1/?query=Needle&limit=2&offset=0");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as any;
    expect(first.has_more).toBe(true);
    expect(first.results.map((result: any) => result.type)).toEqual(["database", "database_table"]);
    expect(first.results[0]).toMatchObject({
      id: 10,
      title: "Needle Database",
      metadata: { workspace_id: 1, database_id: 10 },
    });

    const secondResponse = await api(env, ctx, token, "/api/search/workspace/1/?query=Needle&limit=10&offset=2");
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as any;
    expect(second.has_more).toBe(false);
    expect(second.results.map((result: any) => result.type)).toEqual(["database_field", "database_row"]);
    expect(second.results[1]).toMatchObject({
      type: "database_row",
      title: "Acme primary",
      metadata: {
        workspace_id: 1,
        database_id: 10,
        table_id: 20,
        row_id: 1,
        field_id: 102,
      },
    });
  });

  it("respects Supertask workspace search type filtering", async () => {
    const { env, ctx, token } = await setupSearchFixture();

    const response = await api(env, ctx, token, "/api/search/workspace/1/?query=Needle&types=database_row&limit=10");
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.has_more).toBe(false);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      type: "database_row",
      id: "20_1",
      metadata: { table_id: 20, row_id: 1 },
    });
  });
});
