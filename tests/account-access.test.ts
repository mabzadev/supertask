import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import {
  isEmailAllowlisted,
  normalizeAccountDomain,
  normalizeUniqueRules,
} from "../src/services/account-access";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

type TestD1 = ReturnType<typeof createTestD1>;

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(join(process.cwd(), "migrations")).filter((file) => file.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
  return {
    database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const all = (args: unknown[]) => Promise.resolve({ results: statement.all(...args.map(d1Value)) });
      const first = <T = any>(args: unknown[]) => Promise.resolve((statement.get(...args.map(d1Value)) || null) as T | null);
      const run = (args: unknown[]) => Promise.resolve(statement.run(...args.map(d1Value)));
      return {
        bind(...args: unknown[]) {
          return { all: () => all(args), first: <T = any>() => first<T>(args), run: () => run(args) };
        },
        all: () => all([]),
        first: <T = any>() => first<T>([]),
        run: () => run([]),
      };
    },
    batch(statements: Array<{ all?: () => Promise<any>; first?: () => Promise<any>; run?: () => Promise<any> }>) {
      database.exec("BEGIN");
      return Promise.all(statements.map((statement) => statement.run ? statement.run() : statement.first ? statement.first() : statement.all?.()))
        .then((results) => {
          database.exec("COMMIT");
          return results;
        })
        .catch((error) => {
          database.exec("ROLLBACK");
          throw error;
        });
    },
  };
}

function createKv() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) || null,
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  };
}

function createEnv(db: TestD1) {
  return {
    DB: db,
    CACHE: createKv(),
    FILES: { head: async () => null },
    JOBS_QUEUE: { send: async () => undefined },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    CONTENT_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    MCP_SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    JWT_SIGNING_KEY: "test-secret",
    SECRET_KEY: "test-secret",
    ENVIRONMENT: "test",
    JWT_ACCESS_TTL_MINUTES: "10",
    JWT_REFRESH_TTL_DAYS: "7",
    PUBLIC_URL: "https://api.supertask.test",
    PUBLIC_WEB_FRONTEND_URL: "https://web.supertask.test",
  } as any;
}

async function insertUser(
  db: TestD1,
  id: number,
  email: string,
  options: { staff?: boolean; creator?: boolean } = {},
) {
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, is_superuser,
      can_create_accounts, date_joined)
     VALUES (?, '!', ?, ?, '', ?, ?, 1, ?, ?, ?)`
  ).bind(id, email, `User ${id}`, email, options.staff ? 1 : 0, options.staff ? 1 : 0, options.creator ? 1 : 0, new Date().toISOString()).run();
  await db.prepare("INSERT INTO core_userprofile (user_id, language) VALUES (?, 'fr')").bind(id).run();
}

async function tokenFor(id: number, email: string) {
  return signAccessToken({ user_id: id, email, username: email }, "test-secret", 60);
}

async function api(env: any, token: string | null, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://api.supertask.test${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `JWT ${token}` } : {}),
      ...(init.headers || {}),
    },
  }), env);
}

async function fixture() {
  const db = createTestD1();
  const env = createEnv(db);
  await insertUser(db, 1, "admin@supertask.test", { staff: true });
  await insertUser(db, 2, "manager@supertask.test");
  await insertUser(db, 3, "workspace-admin@supertask.test");
  await insertUser(db, 4, "existing@outside.test");
  await db.prepare("UPDATE core_settings SET show_admin_signup_page=0 WHERE id=1").run();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on) VALUES (1, 'Équipe', ?)")
    .bind(new Date().toISOString()).run();
  await db.prepare(
    `INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted)
     VALUES (1, 1, 1, 'ADMIN', 0), (1, 2, 2, 'ADMIN', 0), (1, 3, 3, 'ADMIN', 0)`
  ).run();
  return {
    db,
    env,
    adminToken: await tokenFor(1, "admin@supertask.test"),
    managerToken: await tokenFor(2, "manager@supertask.test"),
    workspaceAdminToken: await tokenFor(3, "workspace-admin@supertask.test"),
  };
}

describe("controlled account creation", () => {
  it("normalizes rules and matches only exact email domains", async () => {
    const db = createTestD1();
    expect(normalizeAccountDomain("@@Example.COM ")).toBe("example.com");
    expect(normalizeUniqueRules([" Person@Example.com ", "person@example.com"], "email"))
      .toEqual(["person@example.com"]);
    await db.prepare(
      `INSERT INTO core_account_email_allowlist (kind, normalized_value, created_on)
       VALUES ('email', 'one@exact.test', ?), ('domain', 'example.com', ?)`
    ).bind(new Date().toISOString(), new Date().toISOString()).run();
    await expect(isEmailAllowlisted(db as any, "ONE@EXACT.TEST")).resolves.toBe(true);
    await expect(isEmailAllowlisted(db as any, "person@example.com")).resolves.toBe(true);
    await expect(isEmailAllowlisted(db as any, "person@sub.example.com")).resolves.toBe(false);
  });

  it("lets only instance admins read and atomically replace the private policy", async () => {
    const { db, env, adminToken, managerToken } = await fixture();
    const forbidden = await api(env, managerToken, "/api/admin/account-access/");
    expect(forbidden.status).toBe(403);

    const update = await api(env, adminToken, "/api/admin/account-access/", {
      method: "PATCH",
      body: JSON.stringify({
        allowed_emails: [" Special@Example.com "],
        allowed_domains: ["@Example.com", "example.com"],
        creator_user_ids: [2],
      }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      policy: "invitation_allowlist",
      allowed_emails: ["special@example.com"],
      allowed_domains: ["example.com"],
    });
    expect(await db.prepare("SELECT can_create_accounts FROM auth_user WHERE id=2").first<any>())
      .toMatchObject({ can_create_accounts: 1 });

    const publicSettings = await api(env, null, "/api/settings/");
    const publicBody = await publicSettings.json<any>();
    expect(publicBody.account_creation_policy).toBe("invitation_allowlist");
    expect(publicBody.allowed_emails).toBeUndefined();
    expect(publicBody.allowed_domains).toBeUndefined();
  });

  it("allows managers to invite allowlisted new accounts and workspace admins to invite existing accounts", async () => {
    const { env, adminToken, managerToken, workspaceAdminToken } = await fixture();
    await api(env, adminToken, "/api/admin/account-access/", {
      method: "PATCH",
      body: JSON.stringify({ allowed_emails: [], allowed_domains: ["example.com"], creator_user_ids: [2] }),
    });

    const newAccount = await api(env, managerToken, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "new@example.com", permissions: "VIEWER" }),
    });
    expect(newAccount.status).toBe(201);

    const existingAccount = await api(env, workspaceAdminToken, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "existing@outside.test", permissions: "VIEWER" }),
    });
    expect(existingAccount.status).toBe(201);

    const unauthorizedCreator = await api(env, workspaceAdminToken, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "another@example.com", permissions: "VIEWER" }),
    });
    expect(unauthorizedCreator.status).toBe(403);
    expect(await unauthorizedCreator.json()).toMatchObject({ error: "ERROR_ACCOUNT_CREATION_NOT_ALLOWED" });

    const disallowedEmail = await api(env, managerToken, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "person@outside.test", permissions: "VIEWER" }),
    });
    expect(disallowedEmail.status).toBe(400);
    expect(await disallowedEmail.json()).toMatchObject({ error: "ERROR_EMAIL_NOT_ALLOWED" });
  });

  it("blocks direct signup and revalidates stale invitations and email changes", async () => {
    const { db, env, adminToken, managerToken } = await fixture();
    await api(env, adminToken, "/api/admin/account-access/", {
      method: "PATCH",
      body: JSON.stringify({ allowed_emails: [], allowed_domains: ["example.com"], creator_user_ids: [2] }),
    });
    await api(env, managerToken, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "pending@example.com", permissions: "VIEWER" }),
    });
    const invitation = await db.prepare("SELECT token FROM core_workspaceinvitation WHERE email='pending@example.com'")
      .first<{ token: string }>();

    const publicInvitation = await api(env, null, `/api/workspaces/invitations/token/${invitation?.token}/`);
    expect(publicInvitation.status).toBe(200);
    expect(await publicInvitation.json()).toMatchObject({
      email: "pending@example.com",
      invited_by: "User 2",
      workspace: "Équipe",
      email_exists: false,
    });

    const direct = await api(env, null, "/api/user/", {
      method: "POST",
      body: JSON.stringify({ name: "Direct User", email: "direct@example.com", password: "password123" }),
    });
    expect(direct.status).toBe(400);
    expect(await direct.json()).toMatchObject({ error: "ERROR_DISABLED_SIGNUP" });

    await api(env, adminToken, "/api/admin/account-access/", {
      method: "PATCH",
      body: JSON.stringify({ allowed_emails: [], allowed_domains: ["example.com"], creator_user_ids: [] }),
    });
    const stale = await api(env, null, "/api/user/", {
      method: "POST",
      body: JSON.stringify({
        name: "Pending User",
        email: "pending@example.com",
        password: "password123",
        workspace_invitation_token: invitation?.token,
      }),
    });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: "ERROR_ACCOUNT_CREATION_NOT_ALLOWED" });

    const emailEdit = await api(env, adminToken, "/api/admin/users/4/", {
      method: "PATCH",
      body: JSON.stringify({ username: "changed@outside.test" }),
    });
    expect(emailEdit.status).toBe(400);
    expect(await emailEdit.json()).toMatchObject({ error: "ERROR_EMAIL_NOT_ALLOWED" });
  });
});
