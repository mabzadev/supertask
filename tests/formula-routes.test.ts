import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

type TestD1 = {
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
  database.exec(readFileSync(join(process.cwd(), "migrations", "0001_initial.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0051_last_password_change.sql"), "utf8"));
  return {
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

async function setupFormulaApiFixture() {
  const db = createTestD1();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (7, '', 'user@example.com', 'User', 'Example', 'user@example.com', 0, 1, ?)`
  ).bind(now).run();
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
  return { db, env, ctx, token };
}

async function setupFormulaTableFixture() {
  const fixture = await setupFormulaApiFixture();
  const now = new Date().toISOString();
  await fixture.db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Formula Workspace', ?, 0, 1)")
    .bind(now)
    .run();
  await fixture.db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
    .run();
  await fixture.db.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Formula Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  await fixture.db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (20, 10, 'Formula Table', 1, 1, 0, ?, ?, 0, 0, 0)`
  ).bind(now, now).run();
  await fixture.db.prepare(
    `INSERT INTO database_field
     (id, table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
      immutable_type, immutable_properties, field_settings, created_on, updated_on)
     VALUES (30, 20, 'Amount', 'number', 1, 1, 0, 0, NULL, 0, 0, 0, NULL, ?, ?)`
  ).bind(now, now).run();
  return fixture;
}

async function api(env: any, ctx: any, token: string, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://test.local${path}`, {
    ...init,
    headers: {
      authorization: `JWT ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  }), env, ctx);
}

describe("formula API parity", () => {
  it("exposes Supertask error wrapper functions to the frontend registry", async () => {
    const { env, ctx, token } = await setupFormulaApiFixture();
    const response = await api(env, ctx, token, "/api/database/formula/functions/");
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const functionNames = body.functions.map((fn: any) => fn.name);
    expect(functionNames).toContain("ERROR_TO_NAN");
    expect(functionNames).toContain("ERROR_TO_NULL");
    expect(functionNames).toContain("GET_SINGLE_SELECT_VALUE");
    expect(functionNames).toContain("JSONB_EXTRACT_PATH_TEXT");
    expect(functionNames).toContain("BC_TO_NULL");
    expect(functionNames).toContain("ARRAY_AGG");
    expect(functionNames).toContain("ARRAY_AGG_NO_NESTING");
    expect(functionNames).toContain("ARRAY_AGG_UNNESTING");
    expect(functionNames).toContain("MANY_TO_MANY_AGG");
    expect(functionNames).toContain("MULTIPLE_SELECT_OPTIONS_AGG");
    expect(functionNames).toContain("MANY_TO_MANY_COUNT");
    expect(functionNames).toContain("MULTIPLE_SELECT_COUNT");
    expect(functionNames).toContain("STRING_AGG_MANY_TO_MANY_VALUES");
    expect(functionNames).toContain("STRING_AGG_MULTIPLE_SELECT_VALUES");
    expect(functionNames).toContain("INT");
    expect(body.functions.find((fn: any) => fn.name === "INT")).toMatchObject({
      signature: "INT(n)",
      category: "number",
    });
  });

  it("evaluates Supertask error wrappers through the real API route", async () => {
    const { env, ctx, token } = await setupFormulaApiFixture();
    const response = await api(env, ctx, token, "/api/database/formula/evaluate/", {
      method: "POST",
      body: JSON.stringify({ formula: "error_to_null(does_not_exist())" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      formula: "error_to_null(does_not_exist())",
      value: null,
      error: null,
    });
  });

  it("returns Supertask-compatible formula type errors through the real API route", async () => {
    const { env, ctx, token } = await setupFormulaTableFixture();
    const invalidResponse = await api(env, ctx, token, "/api/database/formula/20/type/", {
      method: "POST",
      body: JSON.stringify({ formula: "when_empty(field('Amount'), 'fallback')", name: "Invalid fallback" }),
    });
    expect(invalidResponse.status).toBe(200);
    const invalid = await invalidResponse.json() as any;
    expect(invalid).toMatchObject({
      formula_type: "invalid",
      formula_type_error: "both inputs for when_empty must be the same type",
    });

    const textResponse = await api(env, ctx, token, "/api/database/formula/20/type/", {
      method: "POST",
      body: JSON.stringify({ formula: "if(true, field('Amount'), 'fallback')", name: "Mixed branch" }),
    });
    expect(textResponse.status).toBe(200);
    const text = await textResponse.json() as any;
    expect(text).toMatchObject({
      formula_type: "text",
      formula_type_error: null,
    });

    const numberResponse = await api(env, ctx, token, "/api/database/formula/20/type/", {
      method: "POST",
      body: JSON.stringify({ formula: "log(125.000, 5)", name: "Precise result" }),
    });
    expect(numberResponse.status).toBe(200);
    await expect(numberResponse.json()).resolves.toMatchObject({
      formula_type: "number",
      number_decimal_places: 3,
      formula_type_error: null,
    });
  });
});
