import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { hashPassword } from "../src/services/user";

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

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_initial.sql", "0051_last_password_change.sql", "0014_completed_guided_tours.sql"]) {
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

function createKv() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) || null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

function createEnv(db = createTestD1()) {
  const kv = createKv();
  return {
    DB: db,
    CACHE: kv,
    FILES: { head: async () => null },
    JOBS_QUEUE: { send: async () => undefined },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    MCP_SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    JWT_SIGNING_KEY: "test-secret",
    SECRET_KEY: "secret",
    ENVIRONMENT: "test",
    JWT_ACCESS_TTL_MINUTES: "10",
    JWT_REFRESH_TTL_DAYS: "7",
    PUBLIC_URL: "https://api.supertask.test",
    PUBLIC_WEB_FRONTEND_URL: "https://web.supertask.test",
  } as any as { DB: TestD1; CACHE: ReturnType<typeof createKv> } & Record<string, any>;
}

async function createUser(db: TestD1, email = "user@example.com", password = "password") {
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  await db.prepare(
    `INSERT INTO auth_user
     (id, email, username, first_name, last_name, password, is_staff, is_active, is_superuser, date_joined, last_login)
     VALUES (1, ?, ?, 'Test', 'User', ?, 1, 1, 1, ?, NULL)`
  ).bind(email.toLowerCase(), email.toLowerCase(), passwordHash, now).run();
  await db.prepare(
    `INSERT INTO core_userprofile
     (user_id, language, timezone, email_notification_frequency, completed_onboarding, completed_guided_tours, to_be_deleted, profile_image_url, email_verified, user_session_expiry_seconds)
     VALUES (1, 'en', NULL, 'instant', 1, '["sidebar","database","builder","automation"]', 0, NULL, 1, 604800)`
  ).run();
}

async function userJwt(email = "user@example.com") {
  return signAccessToken(
    { user_id: 1, email: email.toLowerCase(), username: email.toLowerCase() },
    "test-secret",
    10
  );
}

async function api(env: Record<string, any>, path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return worker.fetch(new Request(`https://api.supertask.test${path}`, { ...init, headers, body }), env);
}

function base32ToBytes(value: string) {
  let bits = "";
  const clean = value.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  for (const char of clean) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) throw new Error("Invalid TOTP secret.");
    bits += idx.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(out);
}

async function hotp(secret: string, counter: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    base32ToBytes(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(4, counter);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

async function currentTotp(secret: string) {
  return hotp(secret, Math.floor(Date.now() / 1000 / 30));
}

async function enableTwoFactor(env: ReturnType<typeof createEnv>, db: TestD1) {
  const token = await userJwt();
  await api(env, "/api/two-factor-auth/configuration/", {
    method: "POST",
    headers: { Authorization: `JWT ${token}` },
    json: { type: "totp" },
  });
  const device = await db.prepare("SELECT secret FROM core_twofactorauthenticationdevice WHERE user_id=1").first<{ secret: string }>();
  const code = await currentTotp(device!.secret);
  const response = await api(env, "/api/two-factor-auth/configuration/", {
    method: "POST",
    headers: { Authorization: `JWT ${token}` },
    json: { type: "totp", code },
  });
  return response.json<any>();
}

describe("two-factor authentication parity", () => {
  it("uses the Baserow configuration contract for TOTP setup", async () => {
    const db = createTestD1();
    await createUser(db);
    const env = createEnv(db);
    const token = await userJwt();

    const initial = await api(env, "/api/two-factor-auth/configuration/", {
      headers: { Authorization: `JWT ${token}` },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ allowed: true });

    const configure = await api(env, "/api/two-factor-auth/configuration/", {
      method: "POST",
      headers: { Authorization: `JWT ${token}` },
      json: { type: "totp" },
    });
    expect(configure.status).toBe(200);
    const setup = await configure.json<any>();
    expect(setup).toMatchObject({
      type: "totp",
      is_enabled: false,
      backup_codes: [],
    });
    expect(setup.provisioning_url).toContain("otpauth://totp/");
    expect(setup.provisioning_qr_code).toMatch(/^data:image\/png;base64,/);

    const wrong = await api(env, "/api/two-factor-auth/configuration/", {
      method: "POST",
      headers: { Authorization: `JWT ${token}` },
      json: { type: "totp", code: "000000" },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: "ERROR_TWO_FACTOR_AUTH_VERIFICATION_FAILED" });

    const device = await db.prepare("SELECT secret FROM core_twofactorauthenticationdevice WHERE user_id=1").first<{ secret: string }>();
    const enable = await api(env, "/api/two-factor-auth/configuration/", {
      method: "POST",
      headers: { Authorization: `JWT ${token}` },
      json: { type: "totp", code: await currentTotp(device!.secret) },
    });
    expect(enable.status).toBe(200);
    const enabled = await enable.json<any>();
    expect(enabled).toMatchObject({
      type: "totp",
      is_enabled: true,
      provisioning_url: "",
      provisioning_qr_code: "",
    });
    expect(enabled.backup_codes).toHaveLength(8);
    for (const code of enabled.backup_codes) {
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(code).not.toMatch(/[01io]/);
    }

    const after = await api(env, "/api/two-factor-auth/configuration/", {
      headers: { Authorization: `JWT ${token}` },
    });
    expect(await after.json()).toMatchObject({ allowed: true, type: "totp", is_enabled: true });

    const duplicate = await api(env, "/api/two-factor-auth/configuration/", {
      method: "POST",
      headers: { Authorization: `JWT ${token}` },
      json: { type: "totp" },
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: "ERROR_TWO_FACTOR_AUTH_ALREADY_CONFIGURED" });
  });

  it("returns the frontend-expected login challenge and verifies a TOTP code once", async () => {
    const db = createTestD1();
    await createUser(db);
    const env = createEnv(db);
    await enableTwoFactor(env, db);

    const login = await api(env, "/api/user/token-auth/", {
      method: "POST",
      json: { email: "user@example.com", password: "password" },
    });
    expect(login.status).toBe(200);
    const challenge = await login.json<any>();
    expect(challenge.two_factor_auth).toBe("totp");
    expect(challenge.token).toEqual(expect.any(String));
    expect(challenge.user).toBeUndefined();

    const invalid = await api(env, "/api/two-factor-auth/verify/", {
      method: "POST",
      headers: { Authorization: `Bearer ${challenge.token}` },
      json: { type: "totp", email: "other@example.com", code: "000000" },
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ error: "ERROR_TWO_FACTOR_AUTH_VERIFICATION_FAILED" });

    const device = await db.prepare("SELECT secret FROM core_twofactorauthenticationdevice WHERE user_id=1").first<{ secret: string }>();
    const code = await currentTotp(device!.secret);
    const verified = await api(env, "/api/two-factor-auth/verify/", {
      method: "POST",
      headers: { Authorization: `Bearer ${challenge.token}` },
      json: { type: "totp", email: "user@example.com", code },
    });
    expect(verified.status).toBe(200);
    const session = await verified.json<any>();
    expect(session.access_token).toEqual(expect.any(String));
    expect(session.refresh_token).toEqual(expect.any(String));
    expect(session.user).toMatchObject({ id: 1, email: "user@example.com" });

    const secondLogin = await api(env, "/api/user/token-auth/", {
      method: "POST",
      json: { email: "user@example.com", password: "password" },
    });
    const secondChallenge = await secondLogin.json<any>();
    const reused = await api(env, "/api/two-factor-auth/verify/", {
      method: "POST",
      headers: { Authorization: `Bearer ${secondChallenge.token}` },
      json: { type: "totp", email: "user@example.com", code },
    });
    expect(reused.status).toBe(401);
    expect(await reused.json()).toMatchObject({ error: "ERROR_TWO_FACTOR_AUTH_VERIFICATION_FAILED" });
  });

  it("consumes backup codes once and disables TOTP with Baserow status codes", async () => {
    const db = createTestD1();
    await createUser(db);
    const env = createEnv(db);
    const enabled = await enableTwoFactor(env, db);
    const backupCode = enabled.backup_codes[0];

    const login = await api(env, "/api/user/token-auth/", {
      method: "POST",
      json: { email: "user@example.com", password: "password" },
    });
    const challenge = await login.json<any>();
    const backup = await api(env, "/api/two-factor-auth/verify/", {
      method: "POST",
      headers: { Authorization: `Bearer ${challenge.token}` },
      json: { type: "totp", email: "user@example.com", backup_code: backupCode },
    });
    expect(backup.status).toBe(200);

    const secondLogin = await api(env, "/api/user/token-auth/", {
      method: "POST",
      json: { email: "user@example.com", password: "password" },
    });
    const secondChallenge = await secondLogin.json<any>();
    const reusedBackup = await api(env, "/api/two-factor-auth/verify/", {
      method: "POST",
      headers: { Authorization: `Bearer ${secondChallenge.token}` },
      json: { type: "totp", email: "user@example.com", backup_code: backupCode },
    });
    expect(reusedBackup.status).toBe(401);

    const token = await userJwt();
    const missingPassword = await api(env, "/api/two-factor-auth/disable/", {
      method: "POST",
      headers: { Authorization: `JWT ${token}` },
      json: {},
    });
    expect(missingPassword.status).toBe(400);
    expect(await missingPassword.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });

    const wrongPassword = await api(env, "/api/two-factor-auth/disable/", {
      method: "POST",
      headers: { Authorization: `JWT ${token}` },
      json: { password: "wrong" },
    });
    expect(wrongPassword.status).toBe(403);
    expect(await wrongPassword.json()).toMatchObject({ error: "ERROR_WRONG_PASSWORD" });

    const disabled = await api(env, "/api/two-factor-auth/disable/", {
      method: "POST",
      headers: { Authorization: `JWT ${token}` },
      json: { password: "password" },
    });
    expect(disabled.status).toBe(204);

    const after = await api(env, "/api/two-factor-auth/configuration/", {
      headers: { Authorization: `JWT ${token}` },
    });
    expect(await after.json()).toEqual({ allowed: true });

    const duplicateDisable = await api(env, "/api/two-factor-auth/disable/", {
      method: "POST",
      headers: { Authorization: `JWT ${token}` },
      json: { password: "password" },
    });
    expect(duplicateDisable.status).toBe(400);
    expect(await duplicateDisable.json()).toMatchObject({ error: "ERROR_TWO_FACTOR_AUTH_NOT_CONFIGURED" });
  });

  it("rate-limits verification attempts per email like Baserow", async () => {
    const db = createTestD1();
    await createUser(db);
    const env = createEnv(db);
    await enableTwoFactor(env, db);
    const login = await api(env, "/api/user/token-auth/", {
      method: "POST",
      json: { email: "user@example.com", password: "password" },
    });
    const challenge = await login.json<any>();
    const attempt = () => api(env, "/api/two-factor-auth/verify/", {
      method: "POST",
      headers: { Authorization: `Bearer ${challenge.token}` },
      json: { type: "totp", email: "user@example.com", code: "000000" },
    });
    for (let index = 0; index < 10; index += 1) expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "ERROR_RATE_LIMIT_EXCEEDED" });
  });
});

