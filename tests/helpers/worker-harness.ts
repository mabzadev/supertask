import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import worker from "../../src/index";

export const TEST_SECRET = "test-secret";

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

export interface QueryCounter {
  /** Calls counted like D1's per-invocation limit: each statement run, and each batch, is one. */
  queries: number;
  /** When set, collects how often each statement ran (whitespace-normalised SQL). */
  statements?: Map<string, number>;
}

/** In-memory D1 stand-in with every migration applied, in order. */
export function createTestD1(counter?: QueryCounter) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
  const count = (sql = "batch") => {
    if (!counter) return;
    counter.queries += 1;
    if (counter.statements) {
      const key = sql.replace(/\s+/g, " ").trim().slice(0, 140);
      counter.statements.set(key, (counter.statements.get(key) || 0) + 1);
    }
  };
  const bound = (statement: ReturnType<DatabaseSync["prepare"]>, args: unknown[], sql: string) => ({
    all: () => { count(sql); return Promise.resolve({ results: statement.all(...(args.map(d1Value) as any[])) }); },
    first: () => { count(sql); return Promise.resolve(statement.get(...(args.map(d1Value) as any[])) || null); },
    run: () => {
      count(sql);
      const result = statement.run(...(args.map(d1Value) as any[]));
      return Promise.resolve({ ...result, meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } });
    },
    rawRun: () => statement.run(...(args.map(d1Value) as any[])),
  });
  return {
    database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      return { bind: (...args: unknown[]) => bound(statement, args, sql), ...bound(statement, [], sql) };
    },
    async batch(statements: Array<{ rawRun: () => unknown }>) {
      count();
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.rawRun());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export type TestD1 = ReturnType<typeof createTestD1>;

export function createKv() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  };
}

export function createEnv(db: TestD1) {
  const stub = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) };
  return {
    DB: db,
    CACHE: createKv(),
    FILES: { head: async () => null },
    JOBS_QUEUE: { send: async () => undefined },
    WORKSPACE_ROOM: stub,
    CONTENT_ROOM: stub,
    MCP_SESSION: stub,
    JWT_SIGNING_KEY: TEST_SECRET,
    SECRET_KEY: TEST_SECRET,
    ENVIRONMENT: "test",
    PUBLIC_URL: "https://api.supertask.test",
    PUBLIC_WEB_FRONTEND_URL: "https://web.supertask.test",
  } as any;
}

/** Execution context that keeps `waitUntil` work so tests can await it (it shares the request's D1 budget). */
export function createCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise.catch(() => undefined)); },
    passThroughOnException: () => undefined,
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  } as any;
}

export async function signTestToken(payload: Record<string, unknown>, issuedAt = Math.floor(Date.now() / 1000), expiresIn = "10m") {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

export function accessToken(userId: number, email: string, issuedAt?: number) {
  return signTestToken({ user_id: userId, email, username: email, token_type: "access" }, issuedAt);
}

export function apiClient(env: any, ctx = createCtx()) {
  return (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://api.supertask.test${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  }), env, ctx);
}

export function insertUser(db: TestD1, id: number, email: string, options: { staff?: boolean; password?: string } = {}) {
  db.database.prepare(
    `INSERT INTO auth_user (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (?, ?, ?, ?, '', ?, ?, 1, ?)`
  ).run(id, options.password ?? "!", email, `User ${id}`, email, options.staff ? 1 : 0, new Date().toISOString());
  db.database.prepare("INSERT INTO core_userprofile (user_id, language) VALUES (?, 'fr')").run(id);
}
