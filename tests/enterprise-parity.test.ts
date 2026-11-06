import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildLoginOptions } from "../src/routes/auth-provider";
import { listAdminAuthProviders, validateAuthProviderPayload } from "../src/routes/enterprise";
import { buildApplicationSnapshot } from "../src/routes/snapshots";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { handleQueue } from "../src/queue/handler";
import { activeLicenses, serializePersonalLicense } from "../src/services/licenses";
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
  database.exec(readFileSync(join(process.cwd(), "migrations", "0002_auth_sessions.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0004_core_settings_2fa.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0005_templates.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0006_field_rules_data_sync.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0007_data_sync_schema_upgrade.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0008_core_job_result.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0009_builder_core.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0039_builder_published_applications.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0029_builder_custom_code.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0010_application_integrations_user_sources.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0011_automation_core.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0012_automation_published_versions.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0013_automation_history_event_payload_simulation.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0014_completed_guided_tours.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0015_documents_dashboards.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0034_dashboard_data_sources.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0017_mcp_endpoints.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0018_enterprise_parity.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0019_premium_view_settings.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0020_view_filter_groups.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0021_workspace_trash.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0022_form_view_field_options_logic.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0043_form_view_submit_notifications.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0024_data_sync_periodic.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0027_postgresql_two_way_sync.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0038_data_sync_authorized_user.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0046_data_sync_select_option_mapping.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0032_data_sync_periodic_when.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0031_auth_provider_users.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0048_account_creation_allowlist.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations", "0049_deletion_lifecycle.sql"), "utf8"));
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

async function setupEnterpriseApiFixture() {
  const db = createTestD1();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 2)")
    .bind(now)
    .run();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (7, '', 'owner@example.com', 'Owner', 'User', 'owner@example.com', 1, 1, ?),
            (8, '', 'member@example.com', 'Member', 'User', 'member@example.com', 0, 1, ?)`
  ).bind(now, now).run();
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN'), (1, 8, 'EDITOR')")
    .run();
  await db.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
     VALUES (20, 10, 'Table', 1, 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_field (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
     VALUES (30, 20, 'Name', 'text', 1, 1, 0, 0, '{}', ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_view
     (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
      public_view_password, trashed, ownership_type, row_height_size, row_identifier_type, created_on, updated_on)
     VALUES (40, 20, 'Grid', 'grid', 1, 'AND', 0, 0, 'enterprise-view-grid',
      NULL, 0, 'collaborative', 'small', 'count', ?, ?)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await addFieldColumn(db as any, 20, { id: 30, type: "text", primary: true });

  const broadcasts: any[] = [];
  const queueMessages: any[] = [];
  const files = new Map<string, Uint8Array>();
  const bodyBytes = async (value: any): Promise<Uint8Array> => {
    if (value instanceof Uint8Array) return value;
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(await new Response(value).arrayBuffer());
  };
  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    CACHE: { get: async () => null, put: async () => undefined },
    FILES: {
      head: async (key: string) => files.has(key) ? { key } : null,
      put: async (key: string, value: any) => { files.set(key, await bodyBytes(value)); },
      get: async (key: string) => {
        const value = files.get(key);
        if (!value) return null;
        return {
          body: new Blob([value]).stream(),
          text: async () => new TextDecoder().decode(value),
          arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
        };
      },
      delete: async (key: string | string[]) => {
        for (const item of Array.isArray(key) ? key : [key]) files.delete(item);
      },
      createMultipartUpload: async (key: string) => {
        const parts = new Map<number, Uint8Array>();
        return {
          uploadPart: async (partNumber: number, value: any) => {
            parts.set(partNumber, await bodyBytes(value));
            return { partNumber, etag: `etag-${partNumber}` };
          },
          abort: async () => { parts.clear(); files.delete(key); },
          complete: async (uploadedParts: Array<{ partNumber: number }>) => {
            const chunks = uploadedParts
              .slice()
              .sort((left, right) => left.partNumber - right.partNumber)
              .map((part) => parts.get(part.partNumber) || new Uint8Array(0));
            const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
            const value = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              value.set(chunk, offset);
              offset += chunk.length;
            }
            files.set(key, value);
            return { key };
          },
        };
      },
    },
    JOBS_QUEUE: { send: async (message: any) => { queueMessages.push(message); } },
    WORKSPACE_ROOM: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init?: RequestInit) => {
          broadcasts.push(JSON.parse(String(init?.body || "{}")));
          return new Response(JSON.stringify({ ok: true }));
        },
      }),
    },
    ENVIRONMENT: "test",
    PUBLIC_URL: "https://api.supertask.test",
  } as any;
  const token = await signAccessToken({ user_id: 7, email: "owner@example.com", username: "owner@example.com" }, "test-secret", 60);
  const memberToken = await signAccessToken({ user_id: 8, email: "member@example.com", username: "member@example.com" }, "test-secret", 60);
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  return { db, env, token, memberToken, ctx, broadcasts, queueMessages };
}

async function api(env: any, ctx: any, token: string, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://api.supertask.test${path}`, {
    ...init,
    headers: {
      authorization: `JWT ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }), env, ctx);
}

async function runNextQueuedJob(env: any, queueMessages: any[]) {
  const body = queueMessages.shift();
  expect(body).toBeTruthy();
  const ack = vi.fn();
  await handleQueue({ messages: [{ body, ack }] } as any, env);
  expect(ack).toHaveBeenCalledOnce();
  return body;
}

describe("enterprise parity policy", () => {
  it("keeps the single hardcoded personal enterprise license active", () => {
    const license = serializePersonalLicense(new Date("2026-05-27T00:00:00.000Z"));
    expect(license.license_id).toBe("supertask-personal-enterprise");
    expect(license.product_code).toBe("enterprise");
    expect(license.is_active).toBe(true);
    expect(activeLicenses().instance_wide).toEqual({
      premium: true,
      advanced: true,
      enterprise_without_support: true,
      enterprise: true,
    });
  });

  it("tracks all active Baserow frontend feature domains", () => {
    const status = JSON.parse(fs.readFileSync(path.join(process.cwd(), "parity-status.json"), "utf8"));
    expect(status.policy.license).toBe("single hardcoded personal enterprise license");
    expect(status.active_frontend_features.field_types).toContain("single_select");
    expect(status.active_frontend_features.field_types).toContain("file");
    expect(status.active_frontend_features.field_types).toContain("lookup");
    expect(status.active_frontend_features.view_types).toEqual(expect.arrayContaining(["grid", "gallery", "form", "survey", "kanban", "calendar", "timeline"]));
    expect(status.active_frontend_features.enterprise).toEqual(expect.arrayContaining(["teams", "role_assignments", "field_permissions", "auth_provider_admin"]));
  });

  it("returns Baserow-compatible admin auth provider lists and login options", async () => {
    const db = createTestD1();
    await db.prepare(
      "INSERT INTO core_authprovider (id, type, enabled, domain, metadata) VALUES (?, ?, ?, ?, ?)"
    ).bind(1, "saml", 1, "zeta.com", JSON.stringify({ metadata: "<xml>zeta</xml>" })).run();
    await db.prepare(
      "INSERT INTO core_authprovider (id, type, enabled, domain, metadata) VALUES (?, ?, ?, ?, ?)"
    ).bind(2, "saml", 1, "acme.com", JSON.stringify({ metadata: "<xml>acme</xml>" })).run();
    await db.prepare(
      "INSERT INTO core_authprovider (id, type, enabled, domain, metadata) VALUES (?, ?, ?, ?, ?)"
    ).bind(3, "google", 1, null, JSON.stringify({ name: "Google Workspace", client_id: "client", secret: "secret" })).run();

    const admin = await listAdminAuthProviders(db as any, "https://supertask.test");
    const samlType = admin.auth_provider_types.find((item: any) => item.type === "saml") as any;
    expect(samlType.can_create_new).toBe(true);
    expect(samlType.auth_providers.map((provider: any) => provider.domain)).toEqual(["acme.com", "zeta.com"]);
    expect(samlType.auth_providers[0]).toMatchObject({
      type: "saml",
      metadata: "<xml>acme</xml>",
      is_verified: false,
      enabled: true,
    });

    const options = await buildLoginOptions(db as any, "https://supertask.test");
    expect(options.password).toMatchObject({ type: "password", allow_new_signups: false, allow_reset_password: true });
    expect((options.saml as any).domain_required).toBe(true);
    expect((options.saml as any).default_redirect_url).toBe("https://supertask.test/login/saml");
    expect((options.saml as any).items).toBeUndefined();
    expect((options.google as any).items[0]).toMatchObject({
      type: "google",
      name: "Google Workspace",
      redirect_url: "https://supertask.test/api/sso/oauth2/login/3/",
    });
    expect((options.google as any).default_redirect_url).toBe("https://supertask.test/api/sso/oauth2/login/3/");
  });

  it("validates auth provider payloads using Baserow-compatible required fields", () => {
    expect(validateAuthProviderPayload("google", {})).toMatchObject({
      name: [{ code: "required" }],
      client_id: [{ code: "required" }],
      secret: [{ code: "required" }],
    });
    expect(validateAuthProviderPayload("gitlab", { name: "GitLab", client_id: "id", secret: "secret" })).toMatchObject({
      base_url: [{ code: "required" }],
    });
    expect(validateAuthProviderPayload("saml", { domain: "invalid_domain_name", metadata: "not xml" })).toMatchObject({
      domain: [{ code: "invalid" }],
      metadata: [{ code: "invalid" }],
    });
    expect(validateAuthProviderPayload("openid_connect", {
      name: "OIDC",
      client_id: "id",
      secret: "secret",
      base_url: "https://idp.example.com",
    })).toBeNull();
  });

  it("discovers OpenID Connect endpoints from the well-known configuration", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://idp.example.com/.well-known/openid-configuration") {
        return new Response(JSON.stringify({
          authorization_endpoint: "https://idp.example.com/oauth/authorize",
          token_endpoint: "https://idp.example.com/oauth/token",
          userinfo_endpoint: "https://idp.example.com/oauth/userinfo",
          jwks_uri: "https://idp.example.com/oauth/jwks",
          issuer: "https://idp.example.com",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://idp2.example.com/.well-known/openid-configuration") {
        return new Response(JSON.stringify({
          authorization_endpoint: "https://idp2.example.com/oauth/authorize",
          token_endpoint: "https://idp2.example.com/oauth/token",
          userinfo_endpoint: "https://idp2.example.com/oauth/userinfo",
          jwks_uri: "https://idp2.example.com/oauth/jwks",
          issuer: "https://idp2.example.com",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const create = await api(env, ctx, token, "/api/admin/auth-provider/", {
        method: "POST",
        body: JSON.stringify({
          type: "openid_connect",
          name: "OIDC",
          base_url: "https://idp.example.com",
          client_id: "client",
          secret: "secret",
          use_id_token: true,
        }),
      });
      expect(create.status).toBe(200);
      const provider = await create.json() as any;
      expect(provider).toMatchObject({
        type: "openid_connect",
        base_url: "https://idp.example.com",
        authorization_url: "https://idp.example.com/oauth/authorize",
        access_token_url: "https://idp.example.com/oauth/token",
        user_info_url: "https://idp.example.com/oauth/userinfo",
        jwks_url: "https://idp.example.com/oauth/jwks",
        issuer: "https://idp.example.com",
        use_id_token: true,
        email_attr_key: "email",
        first_name_attr_key: "name",
        last_name_attr_key: "",
      });

      const update = await api(env, ctx, token, `/api/admin/auth-provider/${provider.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ base_url: "https://idp2.example.com" }),
      });
      expect(update.status).toBe(200);
      const updated = await update.json() as any;
      expect(updated).toMatchObject({
        base_url: "https://idp2.example.com",
        authorization_url: "https://idp2.example.com/oauth/authorize",
        access_token_url: "https://idp2.example.com/oauth/token",
        user_info_url: "https://idp2.example.com/oauth/userinfo",
        jwks_url: "https://idp2.example.com/oauth/jwks",
        issuer: "https://idp2.example.com",
      });
      const stored = await db.prepare("SELECT metadata FROM core_authprovider WHERE id=?").bind(provider.id).first<any>();
      expect(JSON.parse(stored.metadata)).toMatchObject({
        authorization_url: "https://idp2.example.com/oauth/authorize",
        access_token_url: "https://idp2.example.com/oauth/token",
        user_info_url: "https://idp2.example.com/oauth/userinfo",
        jwks_url: "https://idp2.example.com/oauth/jwks",
        issuer: "https://idp2.example.com",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns Baserow errors for invalid OpenID providers and the last active provider", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));

    try {
      const invalidProvider = await api(env, ctx, token, "/api/admin/auth-provider/", {
        method: "POST",
        body: JSON.stringify({
          type: "openid_connect",
          name: "Bad OIDC",
          base_url: "https://bad-idp.example.com",
          client_id: "client",
          secret: "secret",
        }),
      });
      expect(invalidProvider.status).toBe(400);
      expect(await invalidProvider.json()).toMatchObject({
        error: "ERROR_INVALID_PROVIDER_URL",
        detail: { code: "invalid_url" },
      });
    } finally {
      fetchSpy.mockRestore();
    }

    await db.prepare("INSERT INTO core_authprovider (id, type, enabled, domain, metadata) VALUES (?, ?, ?, ?, ?)")
      .bind(50, "password", 0, null, "{}")
      .run();
    await db.prepare("INSERT INTO core_authprovider (id, type, enabled, domain, metadata) VALUES (?, ?, ?, ?, ?)")
      .bind(51, "google", 1, null, JSON.stringify({ name: "Google", client_id: "client", secret: "secret" }))
      .run();

    const disableLast = await api(env, ctx, token, "/api/admin/auth-provider/51/", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableLast.status).toBe(400);
    expect(await disableLast.json()).toMatchObject({ error: "ERROR_CANNOT_DISABLE_ALL_AUTH_PROVIDERS" });

    const deleteLast = await api(env, ctx, token, "/api/admin/auth-provider/51/", { method: "DELETE" });
    expect(deleteLast.status).toBe(400);
    expect(await deleteLast.json()).toMatchObject({ error: "ERROR_CANNOT_DISABLE_ALL_AUTH_PROVIDERS" });

    await db.prepare("UPDATE core_authprovider SET enabled=1 WHERE id=50").run();
    const deleteWithPasswordEnabled = await api(env, ctx, token, "/api/admin/auth-provider/51/", { method: "DELETE" });
    expect(deleteWithPasswordEnabled.status).toBe(204);
  });

  it("enforces the password provider lifecycle across admin, login and account endpoints", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const providerList = await api(env, ctx, token, "/api/admin/auth-provider/");
    expect(providerList.status).toBe(200);
    const providers = await providerList.json() as any;
    const passwordProvider = providers.auth_provider_types
      .find((type: any) => type.type === "password")
      .auth_providers[0];
    expect(passwordProvider).toMatchObject({ type: "password", enabled: true });

    const createPassword = await api(env, ctx, token, "/api/admin/auth-provider/", {
      method: "POST",
      body: JSON.stringify({ type: "password", enabled: true }),
    });
    expect(createPassword.status).toBe(400);
    expect(await createPassword.json()).toMatchObject({ error: "ERROR_AUTH_PROVIDER_CANNOT_BE_CREATED" });

    await db.prepare(
      `INSERT INTO core_account_email_allowlist (kind, normalized_value, created_by_id, created_on)
       VALUES ('domain', 'example.com', 7, ?)`
    ).bind(new Date().toISOString()).run();
    await db.prepare(
      `INSERT INTO core_workspaceinvitation
       (workspace_id, invited_by_id, email, permissions, message, token, created_on)
       VALUES (1, 7, 'password@example.com', 'VIEWER', '', 'password-invite', ?)`
    ).bind(new Date().toISOString()).run();

    const registration = await worker.fetch(new Request("https://api.supertask.test/api/user/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Password User", email: "password@example.com", password: "Password123!", authenticate: true, workspace_invitation_token: "password-invite" }),
    }), env, ctx);
    expect(registration.status).toBe(201);
    const registered = await registration.json() as any;
    const linked = await db.prepare(
      "SELECT auth_provider_id FROM core_authprovideruser WHERE user_id=?"
    ).bind(registered.user.id).first<any>();
    expect(linked).toMatchObject({ auth_provider_id: passwordProvider.id });

    const google = await api(env, ctx, token, "/api/admin/auth-provider/", {
      method: "POST",
      body: JSON.stringify({ type: "google", name: "Google", client_id: "client", secret: "secret" }),
    });
    expect(google.status).toBe(200);

    const disable = await api(env, ctx, token, `/api/admin/auth-provider/${passwordProvider.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({ type: "password", enabled: false });

    const loginOptions = await worker.fetch(new Request("https://api.supertask.test/api/auth-provider/login-options/"), env, ctx);
    expect((await loginOptions.json() as any).password).toBeUndefined();

    const login = await worker.fetch(new Request("https://api.supertask.test/api/user/token-auth/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "password@example.com", password: "Password123!" }),
    }), env, ctx);
    expect(login.status).toBe(401);
    expect(await login.json()).toMatchObject({ error: "ERROR_AUTH_PROVIDER_DISABLED" });

    const signup = await worker.fetch(new Request("https://api.supertask.test/api/user/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Blocked", email: "blocked@example.com", password: "Password123!" }),
    }), env, ctx);
    expect(signup.status).toBe(401);
    expect(await signup.json()).toMatchObject({ error: "ERROR_AUTH_PROVIDER_DISABLED" });

    const passwordChange = await api(env, ctx, registered.access_token, "/api/user/change-password/", {
      method: "POST",
      body: JSON.stringify({ old_password: "Password123!", new_password: "Password456!" }),
    });
    expect(passwordChange.status).toBe(401);
    expect(await passwordChange.json()).toMatchObject({ error: "ERROR_AUTH_PROVIDER_DISABLED" });

    const deletePassword = await api(env, ctx, token, `/api/admin/auth-provider/${passwordProvider.id}/`, { method: "DELETE" });
    expect(deletePassword.status).toBe(400);
    expect(await deletePassword.json()).toMatchObject({ error: "ERROR_AUTH_PROVIDER_CANNOT_BE_DELETED" });

    const mutateType = await api(env, ctx, token, `/api/admin/auth-provider/${passwordProvider.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ type: "google" }),
    });
    expect(mutateType.status).toBe(400);
    expect(await mutateType.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });

    const enable = await api(env, ctx, token, `/api/admin/auth-provider/${passwordProvider.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(enable.status).toBe(200);
    const loginAfterEnable = await worker.fetch(new Request("https://api.supertask.test/api/user/token-auth/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "password@example.com", password: "Password123!" }),
    }), env, ctx);
    expect(loginAfterEnable.status).toBe(200);
  });

  it("allows password signup through a matching invitation when global signup is disabled", async () => {
    const { db, env, ctx } = await setupEnterpriseApiFixture();
    await db.prepare(
      "UPDATE core_settings SET allow_new_signups=0, allow_signups_via_workspace_invitations=1, show_admin_signup_page=0 WHERE id=1"
    ).run();
    await db.prepare(
      `INSERT INTO core_workspaceinvitation
       (id, workspace_id, invited_by_id, email, permissions, message, token, created_on)
       VALUES (701, 1, 7, 'invited-signup@example.com', 'VIEWER', '', 'signup-invite', ?)`
    ).bind(new Date().toISOString()).run();
    await db.prepare(
      `INSERT INTO core_account_email_allowlist (kind, normalized_value, created_by_id, created_on)
       VALUES ('domain', 'example.com', 7, ?)`
    ).bind(new Date().toISOString()).run();

    const blocked = await worker.fetch(new Request("https://api.supertask.test/api/user/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Blocked User", email: "blocked-signup@example.com", password: "Password123!" }),
    }), env, ctx);
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ error: "ERROR_DISABLED_SIGNUP" });

    const accepted = await worker.fetch(new Request("https://api.supertask.test/api/user/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Invited Signup",
        email: "invited-signup@example.com",
        password: "Password123!",
        workspace_invitation_token: "signup-invite",
      }),
    }), env, ctx);
    expect(accepted.status).toBe(201);
    const body = await accepted.json() as any;
    expect(await db.prepare(
      "SELECT workspace_id, permissions FROM core_workspaceuser WHERE user_id=?"
    ).bind(body.user.id).all()).toMatchObject({ results: [{ workspace_id: 1, permissions: "VIEWER" }] });
    expect(await db.prepare("SELECT id FROM core_workspaceinvitation WHERE id=701").first()).toBeNull();
    expect(await db.prepare(
      `SELECT provider.type FROM core_authprovideruser link
       JOIN core_authprovider provider ON provider.id=link.auth_provider_id
       WHERE link.user_id=?`
    ).bind(body.user.id).first()).toMatchObject({ type: "password" });
  });

  it("accepts workspace invitations by id with Baserow email and membership update semantics", async () => {
    const { db, env, memberToken, ctx } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_workspaceinvitation
       (id, workspace_id, invited_by_id, email, permissions, message, token, created_on)
       VALUES (501, 1, 7, 'member@example.com', 'VIEWER', '', 'member-invite', ?)`
    ).bind(now).run();

    const accepted = await api(env, ctx, memberToken, "/api/workspaces/invitations/501/accept/", { method: "POST" });
    expect(accepted.status).toBe(200);
    const membership = await db.prepare(
      "SELECT permissions, to_be_deleted FROM core_workspaceuser WHERE workspace_id=1 AND user_id=8"
    ).first<any>();
    expect(membership).toMatchObject({ permissions: "VIEWER", to_be_deleted: 0 });
    expect(await db.prepare("SELECT id FROM core_workspaceinvitation WHERE id=501").first()).toBeNull();

    await db.prepare(
      `INSERT INTO core_workspaceinvitation
       (id, workspace_id, invited_by_id, email, permissions, message, token, created_on)
       VALUES (502, 1, 7, 'other@example.com', 'MEMBER', '', 'wrong-user-invite', ?)`
    ).bind(now).run();

    const mismatch = await api(env, ctx, memberToken, "/api/workspaces/invitations/502/accept/", { method: "POST" });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      error: "ERROR_GROUP_INVITATION_EMAIL_MISMATCH",
      detail: "Your email address does not match with the invitation.",
    });
    expect(await db.prepare("SELECT id FROM core_workspaceinvitation WHERE id=502").first()).toMatchObject({ id: 502 });
  });

  it("lists workspace invitations with Baserow search and sortable table contracts", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    const rows = [
      [601, "zeta@example.com", "Second invite"],
      [602, "alpha@example.com", "Urgent access"],
      [603, "middle@example.com", "Final invite"],
    ];
    for (const [id, email, message] of rows) {
      await db.prepare(
        `INSERT INTO core_workspaceinvitation
         (id, workspace_id, invited_by_id, email, permissions, message, token, created_on)
         VALUES (?, 1, 7, ?, 'MEMBER', ?, ?, ?)`
      ).bind(id, email, message, `invite-${id}`, now).run();
    }

    const defaultList = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/");
    expect(defaultList.status).toBe(200);
    expect((await defaultList.json() as any[]).map((item) => item.id)).toEqual([601, 602, 603]);

    const searchByMessage = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/?search=urgent");
    expect(searchByMessage.status).toBe(200);
    expect((await searchByMessage.json() as any[]).map((item) => item.email)).toEqual(["alpha@example.com"]);

    const searchByEmailLegacy = await api(env, ctx, token, "/api/workspaces/1/invitations/?search=MIDDLE");
    expect(searchByEmailLegacy.status).toBe(200);
    const legacyPayload = await searchByEmailLegacy.json() as any[];
    expect(legacyPayload).toEqual([expect.objectContaining({ id: 603, email: "middle@example.com", workspace: 1 })]);

    const emailAsc = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/?sorts=%2Bemail");
    expect((await emailAsc.json() as any[]).map((item) => item.email)).toEqual([
      "alpha@example.com",
      "middle@example.com",
      "zeta@example.com",
    ]);

    const messageDesc = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/?sorts=-message");
    expect((await messageDesc.json() as any[]).map((item) => item.message)).toEqual([
      "Urgent access",
      "Second invite",
      "Final invite",
    ]);

    const invalidDirection = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/?sorts=email");
    expect(invalidDirection.status).toBe(400);
    expect(await invalidDirection.json()).toMatchObject({ error: "ERROR_INVALID_SORT_DIRECTION" });

    const invalidAttribute = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/?sorts=%2Bpermissions");
    expect(invalidAttribute.status).toBe(400);
    expect(await invalidAttribute.json()).toMatchObject({ error: "ERROR_INVALID_SORT_ATTRIBUTE" });

    const duplicateAttribute = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/?sorts=%2Bemail,-email");
    expect(duplicateAttribute.status).toBe(400);
    expect(await duplicateAttribute.json()).toMatchObject({ error: "ERROR_INVALID_SORT_ATTRIBUTE" });
  });

  it("lists workspace users with Baserow search, role annotations and sortable table contracts", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (9, '', 'zeta@example.com', 'Zeta', 'User', 'zeta@example.com', 0, 1, ?),
              (10, '', 'alpha@example.com', 'Alpha', 'User', 'alpha@example.com', 0, 1, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO core_workspaceuser (id, workspace_id, user_id, permissions, [order])
       VALUES (901, 1, 9, 'VIEWER', 10),
              (902, 1, 10, 'EDITOR', 20)`
    ).run();
    await db.prepare(
      `INSERT INTO enterprise_team (id, workspace_id, name, default_role_uid, created_on, trashed)
       VALUES (301, 1, 'Ops', 'BUILDER', ?, 0)`
    ).bind(now).run();
    await db.prepare(
      "INSERT INTO enterprise_teamsubject (team_id, subject_id, subject_type) VALUES (301, 9, 'auth.User')"
    ).run();

    const defaultList = await api(env, ctx, token, "/api/workspaces/users/workspace/1/");
    expect(defaultList.status).toBe(200);
    const defaultPayload = await defaultList.json() as any[];
    expect(defaultPayload.map((item) => item.id)).toEqual([1, 2, 901, 902]);
    expect(defaultPayload.find((item) => item.user_id === 8)).toMatchObject({
      permissions: "EDITOR",
      role_uid: "EDITOR",
      highest_role_uid: "EDITOR",
    });
    expect(defaultPayload.find((item) => item.user_id === 9)).toMatchObject({
      permissions: "VIEWER",
      role_uid: "VIEWER",
      highest_role_uid: "BUILDER",
      teams: [{ id: 301, name: "Ops" }],
    });

    const searchByEmail = await api(env, ctx, token, "/api/workspaces/users/workspace/1/?search=ALPHA");
    expect(searchByEmail.status).toBe(200);
    expect((await searchByEmail.json() as any[]).map((item) => item.email)).toEqual(["alpha@example.com"]);

    const searchLegacy = await api(env, ctx, token, "/api/workspaces/1/users/?search=member");
    expect(searchLegacy.status).toBe(200);
    expect((await searchLegacy.json() as any[]).map((item) => item.email)).toEqual(["member@example.com"]);

    const emailAsc = await api(env, ctx, token, "/api/workspaces/users/workspace/1/?sorts=%2Bemail");
    expect(emailAsc.status).toBe(200);
    expect((await emailAsc.json() as any[]).map((item) => item.email)).toEqual([
      "alpha@example.com",
      "member@example.com",
      "owner@example.com",
      "zeta@example.com",
    ]);

    const roleDesc = await api(env, ctx, token, "/api/workspaces/users/workspace/1/?sorts=-role_uid");
    expect(roleDesc.status).toBe(200);
    expect((await roleDesc.json() as any[]).map((item) => item.permissions)).toEqual([
      "VIEWER",
      "EDITOR",
      "EDITOR",
      "ADMIN",
    ]);

    const invalidDirection = await api(env, ctx, token, "/api/workspaces/users/workspace/1/?sorts=email");
    expect(invalidDirection.status).toBe(400);
    expect(await invalidDirection.json()).toMatchObject({ error: "ERROR_INVALID_SORT_DIRECTION" });

    const invalidAttribute = await api(env, ctx, token, "/api/workspaces/users/workspace/1/?sorts=%2Bhighest_role_uid");
    expect(invalidAttribute.status).toBe(400);
    expect(await invalidAttribute.json()).toMatchObject({ error: "ERROR_INVALID_SORT_ATTRIBUTE" });

    const duplicateAttribute = await api(env, ctx, token, "/api/workspaces/users/workspace/1/?sorts=%2Bemail,-email");
    expect(duplicateAttribute.status).toBe(400);
    expect(await duplicateAttribute.json()).toMatchObject({ error: "ERROR_INVALID_SORT_ATTRIBUTE" });

    const assignViewer = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "VIEWER",
      }),
    });
    expect(assignViewer.status).toBe(200);
    expect(await assignViewer.json()).toMatchObject({ role: "VIEWER", subject_id: 8, scope_id: 1, scope_type: "workspace" });
    expect(await db.prepare("SELECT permissions FROM core_workspaceuser WHERE workspace_id=1 AND user_id=8").first<any>())
      .toMatchObject({ permissions: "VIEWER" });
    expect(await db.prepare(
      "SELECT id FROM enterprise_roleassignment WHERE subject_id=8 AND subject_type='auth.User' AND scope_id=1 AND scope_type='workspace'"
    ).first()).toBeNull();

    const afterAssign = await api(env, ctx, token, "/api/workspaces/users/workspace/1/?search=member");
    expect((await afterAssign.json() as any[])[0]).toMatchObject({ user_id: 8, permissions: "VIEWER", role_uid: "VIEWER" });

    const removeRole = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: null,
      }),
    });
    expect(removeRole.status).toBe(204);
    expect(await db.prepare("SELECT permissions FROM core_workspaceuser WHERE workspace_id=1 AND user_id=8").first<any>())
      .toMatchObject({ permissions: "NO_ACCESS" });
  });

  it("returns Baserow-compatible team, role assignment and field permission contracts", async () => {
    const { db, env, ctx, token, broadcasts } = await setupEnterpriseApiFixture();

    const teamCreate = await api(env, ctx, token, "/api/teams/workspace/1/", {
      method: "POST",
      body: JSON.stringify({
        name: "Ops",
        default_role: "VIEWER",
        subjects: [{ subject_id: 8, subject_type: "auth.User" }],
      }),
    });
    expect(teamCreate.status).toBe(200);
    const team = await teamCreate.json() as any;
    expect(team).toMatchObject({
      name: "Ops",
      workspace: 1,
      default_role: "VIEWER",
      subject_count: 1,
      subject_sample: [
        expect.objectContaining({
          subject_id: 8,
          subject_type: "auth.User",
          subject_label: "Member User",
          team_subject_id: expect.any(Number),
        }),
      ],
    });
    expect(await db.prepare(
      `SELECT r.uid AS role_uid FROM enterprise_roleassignment ra
        JOIN enterprise_role r ON r.id=ra.role_id
       WHERE ra.subject_id=? AND ra.subject_type='baserow_enterprise.Team'
         AND ra.scope_id=1 AND ra.scope_type='workspace'`
    ).bind(team.id).first<any>()).toMatchObject({ role_uid: "VIEWER" });

    const subjects = await api(env, ctx, token, `/api/teams/${team.id}/subjects/`);
    expect(subjects.status).toBe(200);
    expect(await subjects.json()).toEqual([
      expect.objectContaining({ id: team.subject_sample[0].team_subject_id, team: team.id, subject_id: 8, subject_type: "auth.User" }),
    ]);
    const teamDetail = await api(env, ctx, token, `/api/teams/${team.id}/`);
    expect(teamDetail.status).toBe(200);
    expect(await teamDetail.json()).toMatchObject({ id: team.id, name: "Ops", subject_count: 1 });
    const subjectDetail = await api(env, ctx, token, `/api/teams/${team.id}/subjects/${team.subject_sample[0].team_subject_id}/`);
    expect(subjectDetail.status).toBe(200);
    expect(await subjectDetail.json()).toMatchObject({ team: team.id, subject_id: 8, subject_type: "auth.User" });

    const emptyTeam = await api(env, ctx, token, "/api/teams/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Empty", default_role: "VIEWER" }),
    });
    expect(emptyTeam.status).toBe(200);
    const empty = await emptyTeam.json() as any;

    const searchedTeams = await api(env, ctx, token, "/api/teams/workspace/1/?search=op");
    expect(await searchedTeams.json()).toEqual([expect.objectContaining({ id: team.id, name: "Ops" })]);

    const defaultTeams = await api(env, ctx, token, "/api/teams/workspace/1/");
    expect((await defaultTeams.json() as any[]).map((item) => item.name)).toEqual(["Ops", "Empty"]);

    const ascendingTeams = await api(env, ctx, token, "/api/teams/workspace/1/?sorts=%2Bsubject_sample");
    const ascending = await ascendingTeams.json() as any[];
    expect(ascending.map((item) => item.name)).toEqual(["Empty", "Ops"]);

    const descendingTeams = await api(env, ctx, token, "/api/teams/workspace/1/?sorts=-subject_sample");
    const descending = await descendingTeams.json() as any[];
    expect(descending.map((item) => item.name)).toEqual(["Ops", "Empty"]);

    const invalidSortDirection = await api(env, ctx, token, "/api/teams/workspace/1/?sorts=subject_sample");
    expect(invalidSortDirection.status).toBe(400);
    expect(await invalidSortDirection.json()).toMatchObject({ error: "ERROR_INVALID_SORT_DIRECTION" });

    const invalidSortAttribute = await api(env, ctx, token, "/api/teams/workspace/1/?sorts=-missing");
    expect(invalidSortAttribute.status).toBe(400);
    expect(await invalidSortAttribute.json()).toMatchObject({ error: "ERROR_INVALID_SORT_ATTRIBUTE" });

    const subjectByEmail = await api(env, ctx, token, `/api/teams/${empty.id}/subjects/`, {
      method: "POST",
      body: JSON.stringify({ subject_user_email: "member@example.com", subject_type: "auth.User" }),
    });
    expect(subjectByEmail.status).toBe(200);
    expect(await subjectByEmail.json()).toMatchObject({ team: empty.id, subject_id: 8, subject_type: "auth.User" });

    const roleAssign = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: team.id,
        subject_type: "baserow_enterprise.Team",
        scope_id: 1,
        scope_type: "workspace",
        role: "BUILDER",
      }),
    });
    expect(roleAssign.status).toBe(200);
    const assignment = await roleAssign.json() as any;
    expect(assignment).toMatchObject({
      role: "BUILDER",
      subject_id: team.id,
      subject_type: "baserow_enterprise.Team",
      subject: expect.objectContaining({ id: team.id, name: "Ops", default_role: "BUILDER" }),
      scope_id: 1,
      scope_type: "workspace",
    });
    expect(broadcasts.at(-1)).toMatchObject({
      workspace_id: 1,
      user_ids: [8],
      message: { type: "permissions_updated", workspace_id: 1 },
    });

    const roleList = await api(env, ctx, token, "/api/role/1/?scope_id=1&scope_type=workspace");
    expect(roleList.status).toBe(200);
    expect(await roleList.json()).toEqual([
      expect.objectContaining({ id: null, role: "ADMIN", subject_id: 7, subject: expect.objectContaining({ first_name: "Owner" }) }),
      expect.objectContaining({ id: null, role: "EDITOR", subject_id: 8, subject: expect.objectContaining({ first_name: "Member" }) }),
    ]);

    const roleRemove = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: team.id,
        subject_type: "baserow_enterprise.Team",
        scope_id: 1,
        scope_type: "workspace",
        role: null,
      }),
    });
    expect(roleRemove.status).toBe(204);
    expect(broadcasts.at(-1)).toMatchObject({
      workspace_id: 1,
      user_ids: [8],
      message: { type: "permissions_updated", workspace_id: 1 },
    });

    const fieldDefault = await api(env, ctx, token, "/api/field-permissions/30/");
    expect(await fieldDefault.json()).toMatchObject({
      field_id: 30,
      role: "EDITOR",
      allow_in_forms: true,
      can_write_values: true,
    });

    const fieldUpdate = await api(env, ctx, token, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "NOBODY", allow_in_forms: false }),
    });
    expect(fieldUpdate.status).toBe(200);
    expect(await fieldUpdate.json()).toMatchObject({
      field_id: 30,
      role: "NOBODY",
      allow_in_forms: false,
      can_write_values: false,
    });
    expect(broadcasts.at(-1).message).toMatchObject({
      type: "field_permissions_updated",
      field_id: 30,
      role: "NOBODY",
      allow_in_forms: false,
      can_write_values: false,
    });

    const stored = await db.prepare("SELECT role_uid, allow_write, allow_in_forms FROM enterprise_fieldpermission WHERE field_id=30").first<any>();
    expect(stored).toMatchObject({ role_uid: "NOBODY", allow_write: 0, allow_in_forms: 0 });
  });

  it("applies Baserow role inheritance, team priority and parent read projection", async () => {
    const { db, env, ctx, token, memberToken, queueMessages } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (9, '', 'basic-member@example.com', 'Basic', 'Member', 'basic-member@example.com', 0, 1, ?)`
    ).bind(now).run();
    await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 9, 'MEMBER')").run();

    const workspaceRoles = await api(env, ctx, token, "/api/role/1/?scope_id=1&scope_type=workspace");
    expect(workspaceRoles.status).toBe(200);
    expect(await workspaceRoles.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject_id: 9, role: "BUILDER", scope_type: "workspace" }),
    ]));

    const lowPriority = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "NO_ROLE_LOW_PRIORITY",
      }),
    });
    expect(lowPriority.status).toBe(200);
    const teamCreate = await api(env, ctx, token, "/api/teams/workspace/1/", {
      method: "POST",
      body: JSON.stringify({
        name: "Readers",
        default_role: "VIEWER",
        subjects: [{ subject_id: 8, subject_type: "auth.User" }],
      }),
    });
    const team = await teamCreate.json() as any;

    const teamViewerRead = await api(env, ctx, memberToken, "/api/database/tables/20/");
    expect(teamViewerRead.status).toBe(200);
    const teamViewerWrite = await api(env, ctx, memberToken, "/api/database/rows/table/20/", {
      method: "POST",
      body: JSON.stringify({ field_30: "blocked" }),
    });
    expect(teamViewerWrite.status).toBe(403);

    const denyTeamTable = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: team.id,
        subject_type: "baserow_enterprise.Team",
        scope_id: 20,
        scope_type: "database_table",
        role: "NO_ACCESS",
      }),
    });
    expect(denyTeamTable.status).toBe(200);
    expect((await denyTeamTable.json() as any).scope_type).toBe("database_table");
    expect((await api(env, ctx, memberToken, "/api/database/tables/20/")).status).toBe(403);

    const directUserBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "database_table",
        role: "BUILDER",
      }),
    });
    expect(directUserBuilder.status).toBe(200);
    const userWrite = await api(env, ctx, memberToken, "/api/database/rows/table/20/", {
      method: "POST",
      body: JSON.stringify({ field_30: "user wins over team" }),
    });
    expect(userWrite.status).toBe(200);

    await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "NO_ACCESS",
      }),
    });
    const parentApplicationRead = await api(env, ctx, memberToken, "/api/applications/10/");
    expect(parentApplicationRead.status).toBe(200);
    const parentWorkspaceRead = await api(env, ctx, memberToken, "/api/workspaces/1/permissions/");
    expect(parentWorkspaceRead.status).toBe(200);
    const parentApplicationWrite = await api(env, ctx, memberToken, "/api/applications/10/", {
      method: "PATCH",
      body: JSON.stringify({ name: "must remain blocked" }),
    });
    expect(parentApplicationWrite.status).toBe(403);
  });

  it("validates role scopes and subjects before mutating assignments", async () => {
    const { db, env, ctx, token } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (2, 'Other', ?, 0, 0)")
      .bind(now).run();
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (11, 2, 'Other database', 'database', 1, 0, ?, ?)`
    ).bind(now, now).run();

    const lastAdmin = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({ subject_id: 7, subject_type: "auth.User", scope_id: 1, scope_type: "workspace", role: "VIEWER" }),
    });
    expect(lastAdmin.status).toBe(400);
    expect(await lastAdmin.json()).toMatchObject({ error: "ERROR_LAST_ADMIN_OF_GROUP" });
    expect(await db.prepare("SELECT permissions FROM core_workspaceuser WHERE workspace_id=1 AND user_id=7").first<any>())
      .toMatchObject({ permissions: "ADMIN" });

    const foreignScope = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({ subject_id: 8, subject_type: "auth.User", scope_id: 11, scope_type: "application", role: "VIEWER" }),
    });
    expect(foreignScope.status).toBe(404);
    expect(await foreignScope.json()).toMatchObject({ error: "ERROR_SCOPE_DOES_NOT_EXIST" });
    const unknownSubject = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({ subject_id: 999, subject_type: "auth.User", scope_id: 10, scope_type: "application", role: "VIEWER" }),
    });
    expect(unknownSubject.status).toBe(404);
    expect(await unknownSubject.json()).toMatchObject({ error: "ERROR_SUBJECT_DOES_NOT_EXIST" });

    const unknownScopeType = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({ subject_id: 8, subject_type: "auth.User", scope_id: 10, scope_type: "unknown", role: "VIEWER" }),
    });
    expect(unknownScopeType.status).toBe(404);
    expect(await unknownScopeType.json()).toMatchObject({ error: "ERROR_OBJECT_SCOPE_TYPE_DOES_NOT_EXIST" });

    const unknownRole = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({ subject_id: 8, subject_type: "auth.User", scope_id: 10, scope_type: "application", role: "UNKNOWN" }),
    });
    expect(unknownRole.status).toBe(404);
    expect(await unknownRole.json()).toMatchObject({ error: "ERROR_ROLE_DOES_NOT_EXIST" });

    const duplicateBatch = await api(env, ctx, token, "/api/role/1/batch/", {
      method: "POST",
      body: JSON.stringify({ items: [
        { subject_id: 8, subject_type: "auth.User", scope_id: 20, scope_type: "database_table", role: "VIEWER" },
        { subject_id: 8, subject_type: "auth.User", scope_id: 20, scope_type: "table", role: "BUILDER" },
      ] }),
    });
    expect(duplicateBatch.status).toBe(400);
    expect(await duplicateBatch.json()).toMatchObject({ error: "ERROR_DUPLICATE_ROLE_ASSIGNMENTS" });
    expect(await db.prepare(
      "SELECT id FROM enterprise_roleassignment WHERE subject_id=8 AND scope_id=20"
    ).first()).toBeNull();

    const invalidBatch = await api(env, ctx, token, "/api/role/1/batch/", {
      method: "POST",
      body: JSON.stringify({ items: [
        { subject_id: 8, subject_type: "auth.User", scope_id: 20, scope_type: "database_table", role: "VIEWER" },
        { subject_id: 8, subject_type: "auth.User", scope_id: 11, scope_type: "application", role: "BUILDER" },
      ] }),
    });
    expect(invalidBatch.status).toBe(404);
    expect(await db.prepare(
      "SELECT id FROM enterprise_roleassignment WHERE subject_id=8 AND scope_id=20"
    ).first()).toBeNull();
  });

  it("allows scope administrators to manage only their assigned role scope", async () => {
    const { env, ctx, token, memberToken } = await setupEnterpriseApiFixture();
    const teamCreate = await api(env, ctx, token, "/api/teams/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Scoped team", default_role: "NO_ACCESS" }),
    });
    const team = await teamCreate.json() as any;
    const grantTableAdmin = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "database_table",
        role: "ADMIN",
      }),
    });
    expect(grantTableAdmin.status).toBe(200);

    const tableRoles = await api(env, ctx, memberToken, "/api/role/1/?scope_id=20&scope_type=database_table");
    expect(tableRoles.status).toBe(200);
    const assignTeamOnTable = await api(env, ctx, memberToken, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: team.id,
        subject_type: "baserow_enterprise.Team",
        scope_id: 20,
        scope_type: "database_table",
        role: "VIEWER",
      }),
    });
    expect(assignTeamOnTable.status).toBe(200);
    expect(await assignTeamOnTable.json()).toMatchObject({ scope_type: "database_table", role: "VIEWER" });

    const workspaceRoles = await api(env, ctx, memberToken, "/api/role/1/?scope_id=1&scope_type=workspace");
    expect(workspaceRoles.status).toBe(403);
    const applicationRoles = await api(env, ctx, memberToken, "/api/role/1/?scope_id=10&scope_type=application");
    expect(applicationRoles.status).toBe(403);
  });

  it("enforces field permissions in public forms and restores the editor default", async () => {
    const { db, env, ctx, token } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
        public_view_password, trashed, ownership_type, row_height_size, row_identifier_type, created_on, updated_on)
       VALUES (41, 20, 'Public form', 'form', 2, 'AND', 0, 1, 'rbac-public-form',
        NULL, 0, 'collaborative', 'small', 'count', ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_formview
       (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
        submit_action_redirect_url, mode, show_logo)
       VALUES (41, 'Public form', '', 'Submit', 'MESSAGE', '', '', 'form', 1)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptions
       (form_view_id, field_id, name, description, enabled, required, [order])
       VALUES (41, 30, 'Name', '', 1, 0, 1)`
    ).run();

    const restrict = await api(env, ctx, token, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "NOBODY", allow_in_forms: false }),
    });
    expect(restrict.status).toBe(200);
    const formRestricted = await api(env, ctx, token, "/api/database/views/form/rbac-public-form/submit/");
    expect(formRestricted.status).toBe(200);
    expect((await formRestricted.json() as any).fields).toEqual([]);

    const submitRestricted = await api(env, ctx, token, "/api/database/views/form/rbac-public-form/submit/", {
      method: "POST",
      body: JSON.stringify({ field_30: "must not be submitted" }),
    });
    expect(submitRestricted.status).toBe(200);
    const inserted = await db.prepare(
      `SELECT field_30 FROM database_table_20 ORDER BY id DESC LIMIT 1`
    ).first<any>();
    expect(inserted?.field_30).toBeNull();

    const reset = await api(env, ctx, token, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "EDITOR", allow_in_forms: false }),
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ role: "EDITOR", allow_in_forms: true, can_write_values: true });
    expect(await db.prepare("SELECT id FROM enterprise_fieldpermission WHERE field_id=30").first()).toBeNull();
    const formDefault = await api(env, ctx, token, "/api/database/views/form/rbac-public-form/submit/");
    expect((await formDefault.json() as any).fields).toEqual([
      expect.objectContaining({ field: expect.objectContaining({ id: 30, name: "Name" }) }),
    ]);
  });

  it("enforces Baserow restore and permanent-delete roles in trash", async () => {
    const { db, env, ctx, token, memberToken } = await setupEnterpriseApiFixture();
    const created = await api(env, ctx, token, "/api/database/rows/table/20/", {
      method: "POST",
      body: JSON.stringify({ field_30: "trash permissions" }),
    });
    const row = await created.json() as any;
    expect((await api(env, ctx, token, `/api/database/rows/table/20/${row.id}/`, { method: "DELETE" })).status).toBe(200);

    const editorTrashList = await api(env, ctx, memberToken, "/api/trash/workspace/1/");
    expect(editorTrashList.status).toBe(403);
    const editorRestore = await api(
      env,
      ctx,
      memberToken,
      `/api/trash/row/${row.id}/restore/?parent_trash_item_id=20`,
      { method: "PATCH" },
    );
    expect(editorRestore.status).toBe(200);
    expect((await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`, { method: "DELETE" })).status).toBe(200);

    const editorPermanentDelete = await api(
      env,
      ctx,
      memberToken,
      `/api/trash/row/${row.id}/?parent_trash_item_id=20&workspace_id=1`,
      { method: "DELETE" },
    );
    expect(editorPermanentDelete.status).toBe(403);
    const adminPermanentDelete = await api(
      env,
      ctx,
      token,
      `/api/trash/row/${row.id}/?parent_trash_item_id=20&workspace_id=1`,
      { method: "DELETE" },
    );
    expect(adminPermanentDelete.status).toBe(200);
    expect(await db.prepare(`SELECT id FROM database_table_20 WHERE id=?`).bind(row.id).first()).toBeNull();
  });

  it("enforces enterprise admin and builder permissions on RBAC administration routes", async () => {
    const { env, ctx, token, memberToken } = await setupEnterpriseApiFixture();

    const memberTeamCreate = await api(env, ctx, memberToken, "/api/teams/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Member Team", default_role: "VIEWER" }),
    });
    expect(memberTeamCreate.status).toBe(403);

    const ownerTeamCreate = await api(env, ctx, token, "/api/teams/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Admins", default_role: "VIEWER" }),
    });
    expect(ownerTeamCreate.status).toBe(200);
    const team = await ownerTeamCreate.json() as any;

    const memberSubjectCreate = await api(env, ctx, memberToken, `/api/teams/${team.id}/subjects/`, {
      method: "POST",
      body: JSON.stringify({ subject_user_email: "member@example.com", subject_type: "auth.User" }),
    });
    expect(memberSubjectCreate.status).toBe(403);

    const memberRoleList = await api(env, ctx, memberToken, "/api/role/1/?scope_id=1&scope_type=workspace");
    expect(memberRoleList.status).toBe(403);

    const memberRoleAssign = await api(env, ctx, memberToken, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "ADMIN",
      }),
    });
    expect(memberRoleAssign.status).toBe(403);

    const memberFieldReadDenied = await api(env, ctx, memberToken, "/api/field-permissions/30/");
    expect(memberFieldReadDenied.status).toBe(403);
    const memberFieldPatchDenied = await api(env, ctx, memberToken, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "ADMIN", allow_in_forms: true }),
    });
    expect(memberFieldPatchDenied.status).toBe(403);

    const ownerGrantsBuilderOnField = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "database_table",
        role: "BUILDER",
      }),
    });
    expect(ownerGrantsBuilderOnField.status).toBe(200);

    const memberFieldReadAllowed = await api(env, ctx, memberToken, "/api/field-permissions/30/");
    expect(memberFieldReadAllowed.status).toBe(200);
    const memberFieldPatchAllowed = await api(env, ctx, memberToken, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "ADMIN", allow_in_forms: false }),
    });
    expect(memberFieldPatchAllowed.status).toBe(200);
    expect(await memberFieldPatchAllowed.json()).toMatchObject({
      field_id: 30,
      role: "ADMIN",
      allow_in_forms: false,
      can_write_values: false,
    });
  });

  it("enforces enterprise table role assignments on row access", async () => {
    const { env, ctx, token, memberToken } = await setupEnterpriseApiFixture();

    const ownerCreate = await api(env, ctx, token, "/api/database/rows/table/20/", {
      method: "POST",
      body: JSON.stringify({ field_30: "owner row" }),
    });
    expect(ownerCreate.status).toBe(200);
    const row = await ownerCreate.json() as any;

    const restrictToViewer = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "VIEWER",
      }),
    });
    expect(restrictToViewer.status).toBe(200);

    const memberReadAllowed = await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`);
    expect(memberReadAllowed.status).toBe(200);
    const memberCreateDenied = await api(env, ctx, memberToken, "/api/database/rows/table/20/", {
      method: "POST",
      body: JSON.stringify({ field_30: "blocked" }),
    });
    expect(memberCreateDenied.status).toBe(403);
    const memberPatchDenied = await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ field_30: "blocked" }),
    });
    expect(memberPatchDenied.status).toBe(403);
    const memberDeleteDenied = await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`, {
      method: "DELETE",
    });
    expect(memberDeleteDenied.status).toBe(403);

    const allowEditor = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "EDITOR",
      }),
    });
    expect(allowEditor.status).toBe(200);
    const memberPatchAllowed = await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ field_30: "member editor" }),
    });
    expect(memberPatchAllowed.status).toBe(200);
    expect(await memberPatchAllowed.json()).toMatchObject({ field_30: "member editor" });

    const denyAccess = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "NO_ACCESS",
      }),
    });
    expect(denyAccess.status).toBe(200);
    const memberReadDenied = await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`);
    expect(memberReadDenied.status).toBe(403);
  });

  it("enforces enterprise builder roles on table and field schema operations", async () => {
    const { env, ctx, token, memberToken } = await setupEnterpriseApiFixture();

    const memberReadTable = await api(env, ctx, memberToken, "/api/database/tables/20/");
    expect(memberReadTable.status).toBe(200);

    const memberRenameDenied = await api(env, ctx, memberToken, "/api/database/tables/20/", {
      method: "PATCH",
      body: JSON.stringify({ name: "Member rename blocked" }),
    });
    expect(memberRenameDenied.status).toBe(403);

    const memberFieldCreateDenied = await api(env, ctx, memberToken, "/api/database/fields/table/20/", {
      method: "POST",
      body: JSON.stringify({ name: "Blocked field", type: "text" }),
    });
    expect(memberFieldCreateDenied.status).toBe(403);

    const grantBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "BUILDER",
      }),
    });
    expect(grantBuilder.status).toBe(200);

    const memberRenameAllowed = await api(env, ctx, memberToken, "/api/database/tables/20/", {
      method: "PATCH",
      body: JSON.stringify({ name: "Builder rename allowed" }),
    });
    expect(memberRenameAllowed.status).toBe(200);
    expect(await memberRenameAllowed.json()).toMatchObject({ name: "Builder rename allowed" });

    const memberFieldCreateAllowed = await api(env, ctx, memberToken, "/api/database/fields/table/20/", {
      method: "POST",
      body: JSON.stringify({ name: "Builder field", type: "text" }),
    });
    expect(memberFieldCreateAllowed.status).toBe(200);
    expect(await memberFieldCreateAllowed.json()).toMatchObject({ name: "Builder field", type: "text" });

    const restrictToEditor = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "EDITOR",
      }),
    });
    expect(restrictToEditor.status).toBe(200);

    const editorImportAllowed = await api(env, ctx, memberToken, "/api/database/tables/20/import/async/", {
      method: "POST",
      body: JSON.stringify({ data: [["row from editor"]] }),
    });
    expect(editorImportAllowed.status).toBe(202);

    const editorFieldPatchDenied = await api(env, ctx, memberToken, "/api/database/fields/30/", {
      method: "PATCH",
      body: JSON.stringify({ name: "Editor field rename blocked" }),
    });
    expect(editorFieldPatchDenied.status).toBe(403);

    const denyAccess = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "NO_ACCESS",
      }),
    });
    expect(denyAccess.status).toBe(200);

    const memberReadDenied = await api(env, ctx, memberToken, "/api/database/tables/20/");
    expect(memberReadDenied.status).toBe(403);

    const memberFieldsDenied = await api(env, ctx, memberToken, "/api/database/fields/table/20/");
    expect(memberFieldsDenied.status).toBe(403);

    const memberDatabaseTables = await api(env, ctx, memberToken, "/api/database/tables/database/10/");
    expect(memberDatabaseTables.status).toBe(200);
    expect(await memberDatabaseTables.json()).toEqual([]);
  });

  it("upserts table import rows using Baserow import configuration", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const now = "2026-07-10T12:00:00.000Z";
    await db.prepare(
      `INSERT INTO database_field (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES (31, 20, 'Notes', 'text', 2, 0, 0, 0, '{}', ?, ?),
              (32, 20, 'Last modified', 'last_modified', 3, 0, 1, 0, '{}', ?, ?),
              (33, 20, 'Last modified by', 'last_modified_by', 4, 0, 1, 0, '{}', ?, ?)`
    ).bind(now, now, now, now, now, now).run();
    await addFieldColumn(db as any, 20, { id: 31, type: "text", primary: false });
    await addFieldColumn(db as any, 20, { id: 32, type: "last_modified", primary: false });
    await addFieldColumn(db as any, 20, { id: 33, type: "last_modified_by", primary: false });
    await db.prepare(
      `INSERT INTO "database_table_20"
       ([order], _created_on, _updated_on, _created_by_id, _last_modified_by_id, "field_30", "field_31")
       VALUES (10000, ?, ?, 7, 7, 'key-1', 'keep me')`
    ).bind(now, now).run();

    const invalid = await api(env, ctx, token, "/api/database/tables/20/import/async/", {
      method: "POST",
      body: JSON.stringify({
        data: [["key-1", "blocked"]],
        configuration: { upsert_fields: [30] },
      }),
    });
    expect(invalid.status).toBe(400);

    const response = await api(env, ctx, token, "/api/database/tables/20/import/async/", {
      method: "POST",
      body: JSON.stringify({
        data: [
          ["key-1", "should not overwrite"],
          ["key-2", "created value"],
        ],
        configuration: {
          upsert_fields: [30],
          upsert_values: [["key-1"], ["key-2"]],
          skipped_fields: [31],
        },
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      type: "file_import",
      state: "finished",
      rows_created: 1,
      rows_updated: 1,
    });

    const rows = await db.prepare(
      `SELECT id, [order], _updated_on, _last_modified_by_id, "field_30", "field_31", "field_32", "field_33"
         FROM "database_table_20"
        ORDER BY [order] ASC, id ASC`
    ).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({
      field_30: "key-1",
      field_31: "keep me",
      _last_modified_by_id: 7,
    });
    expect(rows.results[0].field_32).toBe(rows.results[0]._updated_on);
    expect(JSON.parse(String(rows.results[0].field_33))).toMatchObject({ id: 7, email: "owner@example.com" });
    expect(rows.results[1]).toMatchObject({
      field_30: "key-2",
      field_31: "created value",
      _last_modified_by_id: 7,
    });
    expect(rows.results[1].field_32).toBe(rows.results[1]._updated_on);
    expect(JSON.parse(String(rows.results[1].field_33))).toMatchObject({ id: 7, email: "owner@example.com" });
    expect(Number(rows.results[1].order)).toBeGreaterThan(Number(rows.results[0].order));

    const nullingResponse = await api(env, ctx, token, "/api/database/tables/20/import/async/", {
      method: "POST",
      body: JSON.stringify({
        data: [["key-1"]],
        configuration: {
          upsert_fields: [30],
          upsert_values: [["key-1"]],
        },
      }),
    });
    expect(nullingResponse.status).toBe(202);
    expect(await nullingResponse.json()).toMatchObject({
      rows_created: 0,
      rows_updated: 1,
      report: { failing_rows: {} },
    });
    const nulled = await db.prepare(
      `SELECT "field_30", "field_31" FROM "database_table_20" WHERE "field_30" = 'key-1'`
    ).first<any>();
    expect(nulled).toMatchObject({ field_30: "key-1", field_31: null });

    await db.prepare(
      `INSERT INTO "database_table_20"
       ([order], trashed, _created_on, _updated_on, _created_by_id, _last_modified_by_id, "field_30", "field_31")
       VALUES (30000, 1, ?, ?, 7, 7, 'trashed-key', 'old trashed')`
    ).bind(now, now).run();

    const trashedUpsertResponse = await api(env, ctx, token, "/api/database/tables/20/import/async/", {
      method: "POST",
      body: JSON.stringify({
        data: [["trashed-key", "new active"]],
        configuration: {
          upsert_fields: [30],
          upsert_values: [["trashed-key"]],
        },
      }),
    });
    expect(trashedUpsertResponse.status).toBe(202);
    expect(await trashedUpsertResponse.json()).toMatchObject({
      rows_created: 1,
      rows_updated: 0,
      report: { failing_rows: {} },
    });
    const trashedKeyRows = await db.prepare(
      `SELECT trashed, "field_30", "field_31"
         FROM "database_table_20"
        WHERE "field_30" = 'trashed-key'
        ORDER BY trashed DESC, id ASC`
    ).all();
    expect(trashedKeyRows.results).toEqual([
      { trashed: 1, field_30: "trashed-key", field_31: "old trashed" },
      { trashed: 0, field_30: "trashed-key", field_31: "new active" },
    ]);
  });

  it("imports table rows using Baserow row length semantics", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const now = "2026-07-10T12:00:00.000Z";
    await db.prepare(
      `INSERT INTO database_field (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES (31, 20, 'Notes', 'text', 2, 0, 0, 0, '{}', ?, ?)`
    ).bind(now, now).run();
    await addFieldColumn(db as any, 20, { id: 31, type: "text", primary: false });

    const response = await api(env, ctx, token, "/api/database/tables/20/import/async/", {
      method: "POST",
      body: JSON.stringify({
        data: [
          ["short row"],
          ["too", "many", "values"],
        ],
      }),
    });
    expect(response.status).toBe(202);
    const job = await response.json() as any;
    expect(job).toMatchObject({
      type: "file_import",
      state: "finished",
      rows_created: 1,
      rows_updated: 0,
    });
    expect(job.report.failing_rows["1"]).toEqual({
      non_field_errors: ["Too many values in this line."],
    });

    const fields = await db.prepare("SELECT id, name FROM database_field WHERE table_id = 20 ORDER BY [order] ASC").all();
    expect(fields.results.map((field) => field.name)).toEqual(["Name", "Notes"]);
    const rows = await db.prepare(
      `SELECT "field_30", "field_31" FROM "database_table_20" ORDER BY [order] ASC, id ASC`
    ).all();
    expect(rows.results).toEqual([{ field_30: "short row", field_31: null }]);
  });

  it("reports invalid table import row values without aborting valid rows", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const now = "2026-07-10T12:00:00.000Z";
    await db.prepare(
      `INSERT INTO database_field (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES (31, 20, 'Amount', 'number', 2, 0, 0, 0, ?, ?, ?)`
    ).bind(JSON.stringify({ number_decimal_places: 0, number_negative: false }), now, now).run();
    await addFieldColumn(db as any, 20, { id: 31, type: "number", primary: false });

    const response = await api(env, ctx, token, "/api/database/tables/20/import/async/", {
      method: "POST",
      body: JSON.stringify({
        data: [
          ["valid row", "12"],
          ["invalid row", "not a number"],
        ],
      }),
    });
    expect(response.status).toBe(202);
    const job = await response.json() as any;
    expect(job).toMatchObject({
      type: "file_import",
      state: "finished",
      rows_created: 1,
      rows_updated: 0,
    });
    expect(job.report.failing_rows["1"][`field_31`][0]).toContain("not a valid number");

    const rows = await db.prepare(
      `SELECT "field_30" FROM "database_table_20" ORDER BY [order] ASC, id ASC`
    ).all();
    expect(rows.results).toEqual([{ field_30: "valid row" }]);
  });

  it("enforces enterprise view role assignments on view schema operations", async () => {
    const { env, ctx, token, memberToken } = await setupEnterpriseApiFixture();

    const memberCreateDenied = await api(env, ctx, memberToken, "/api/database/views/table/20/", {
      method: "POST",
      body: JSON.stringify({ name: "Member view blocked", type: "grid" }),
    });
    expect(memberCreateDenied.status).toBe(403);

    const grantTableBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "BUILDER",
      }),
    });
    expect(grantTableBuilder.status).toBe(200);

    const memberCreateAllowed = await api(env, ctx, memberToken, "/api/database/views/table/20/", {
      method: "POST",
      body: JSON.stringify({ name: "Builder view", type: "grid" }),
    });
    expect(memberCreateAllowed.status).toBe(200);
    const createdView = await memberCreateAllowed.json() as any;
    expect(createdView).toMatchObject({ name: "Builder view", type: "grid", table_id: 20 });

    const restrictViewToViewer = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 40,
        scope_type: "view",
        role: "VIEWER",
      }),
    });
    expect(restrictViewToViewer.status).toBe(200);

    const memberReadAllowed = await api(env, ctx, memberToken, "/api/database/views/40/");
    expect(memberReadAllowed.status).toBe(200);

    const memberPatchDenied = await api(env, ctx, memberToken, "/api/database/views/40/", {
      method: "PATCH",
      body: JSON.stringify({ name: "Viewer rename blocked" }),
    });
    expect(memberPatchDenied.status).toBe(403);

    const memberFilterDenied = await api(env, ctx, memberToken, "/api/database/views/40/filters/", {
      method: "POST",
      body: JSON.stringify({ field: 30, type: "equal", value: "A" }),
    });
    expect(memberFilterDenied.status).toBe(403);

    const grantViewBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 40,
        scope_type: "view",
        role: "BUILDER",
      }),
    });
    expect(grantViewBuilder.status).toBe(200);

    const memberPatchAllowed = await api(env, ctx, memberToken, "/api/database/views/40/", {
      method: "PATCH",
      body: JSON.stringify({ name: "View builder rename" }),
    });
    expect(memberPatchAllowed.status).toBe(200);
    expect(await memberPatchAllowed.json()).toMatchObject({ id: 40, name: "View builder rename" });

    const memberFilterAllowed = await api(env, ctx, memberToken, "/api/database/views/40/filters/", {
      method: "POST",
      body: JSON.stringify({ field: 30, type: "equal", value: "A" }),
    });
    expect(memberFilterAllowed.status).toBe(200);
    expect(await memberFilterAllowed.json()).toMatchObject({ view: 40, field: 30, type: "equal", value: "A" });

    const denyViewAccess = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 40,
        scope_type: "view",
        role: "NO_ACCESS",
      }),
    });
    expect(denyViewAccess.status).toBe(200);

    const memberReadDenied = await api(env, ctx, memberToken, "/api/database/views/40/");
    expect(memberReadDenied.status).toBe(403);

    const memberTableViews = await api(env, ctx, memberToken, "/api/database/views/table/20/");
    expect(memberTableViews.status).toBe(200);
    const listedViews = await memberTableViews.json() as any[];
    expect(listedViews.map((view) => view.id)).not.toContain(40);
    expect(listedViews.map((view) => view.id)).toContain(createdView.id);
  });

  it("enforces enterprise application roles on application schema operations and listings", async () => {
    const { env, ctx, token, memberToken } = await setupEnterpriseApiFixture();

    const memberCreateDenied = await api(env, ctx, memberToken, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Member app blocked", type: "database" }),
    });
    expect(memberCreateDenied.status).toBe(403);

    const grantWorkspaceBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "BUILDER",
      }),
    });
    expect(grantWorkspaceBuilder.status).toBe(200);

    const memberCreateAllowed = await api(env, ctx, memberToken, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Builder app", type: "database", init_with_data: false }),
    });
    expect(memberCreateAllowed.status).toBe(200);
    const createdApp = await memberCreateAllowed.json() as any;
    expect(createdApp).toMatchObject({ name: "Builder app", type: "database", workspace_id: 1 });

    const memberPatchAllowed = await api(env, ctx, memberToken, "/api/applications/10/", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed by builder" }),
    });
    expect(memberPatchAllowed.status).toBe(200);
    expect(await memberPatchAllowed.json()).toMatchObject({ id: 10, name: "Renamed by builder" });

    const denyApplication = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 10,
        scope_type: "application",
        role: "NO_ACCESS",
      }),
    });
    expect(denyApplication.status).toBe(200);

    const memberGetDenied = await api(env, ctx, memberToken, "/api/applications/10/");
    expect(memberGetDenied.status).toBe(403);

    const memberList = await api(env, ctx, memberToken, "/api/applications/workspace/1/");
    expect(memberList.status).toBe(200);
    const listed = await memberList.json() as any[];
    expect(listed.map((app) => app.id)).not.toContain(10);
    expect(listed.map((app) => app.id)).toContain(createdApp.id);
  });

  it("enforces enterprise roles on table export, workspace export, webhooks and database tokens", async () => {
    const { env, ctx, token, memberToken } = await setupEnterpriseApiFixture();

    const tableExportAllowed = await api(env, ctx, memberToken, "/api/database/export/table/20/", {
      method: "POST",
      body: JSON.stringify({ exporter_type: "csv" }),
    });
    expect(tableExportAllowed.status).toBe(200);

    const workspaceExportDenied = await api(env, ctx, memberToken, "/api/database/export/workspace/1/async/", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(workspaceExportDenied.status).toBe(403);

    const webhookListAllowed = await api(env, ctx, memberToken, "/api/database/webhooks/table/20/");
    expect(webhookListAllowed.status).toBe(200);

    const webhookCreateDenied = await api(env, ctx, memberToken, "/api/database/webhooks/table/20/", {
      method: "POST",
      body: JSON.stringify({ name: "Blocked", url: "https://example.com/webhook", include_all_events: true }),
    });
    expect(webhookCreateDenied.status).toBe(403);

    const tokenCreateDenied = await api(env, ctx, memberToken, "/api/database/tokens/", {
      method: "POST",
      body: JSON.stringify({ name: "Blocked token", workspace: 1 }),
    });
    expect(tokenCreateDenied.status).toBe(403);

    const grantTableBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "BUILDER",
      }),
    });
    expect(grantTableBuilder.status).toBe(200);

    const webhookCreateAllowed = await api(env, ctx, memberToken, "/api/database/webhooks/table/20/", {
      method: "POST",
      body: JSON.stringify({ name: "Allowed", url: "https://example.com/webhook", include_all_events: true }),
    });
    expect(webhookCreateAllowed.status).toBe(200);
    const webhook = await webhookCreateAllowed.json() as any;
    expect(webhook).toMatchObject({ table_id: 20, name: "Allowed" });

    const restrictTableToViewer = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "VIEWER",
      }),
    });
    expect(restrictTableToViewer.status).toBe(200);

    const webhookPatchDenied = await api(env, ctx, memberToken, `/api/database/webhooks/${webhook.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Still blocked" }),
    });
    expect(webhookPatchDenied.status).toBe(403);

    const grantWorkspaceBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "BUILDER",
      }),
    });
    expect(grantWorkspaceBuilder.status).toBe(200);

    const tokenCreateTableViewerDenied = await api(env, ctx, memberToken, "/api/database/tokens/", {
      method: "POST",
      body: JSON.stringify({
        name: "Denied scoped token",
        workspace: 1,
        permissions: { create: false, read: [["table", 20]], update: false, delete: false },
      }),
    });
    expect(tokenCreateTableViewerDenied.status).toBe(403);

    const grantTableBuilderAgain = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "BUILDER",
      }),
    });
    expect(grantTableBuilderAgain.status).toBe(200);

    const tokenCreateAllowed = await api(env, ctx, memberToken, "/api/database/tokens/", {
      method: "POST",
      body: JSON.stringify({
        name: "Allowed scoped token",
        workspace: 1,
        permissions: { create: false, read: [["table", 20]], update: false, delete: false },
      }),
    });
    expect(tokenCreateAllowed.status).toBe(200);
    const tokenBody = await tokenCreateAllowed.json() as any;
    expect(tokenBody.permissions.read).toEqual([["table", 20]]);

    const workspaceExportAllowed = await api(env, ctx, memberToken, "/api/database/export/workspace/1/async/", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(workspaceExportAllowed.status).toBe(200);

    const denyViewAccess = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 40,
        scope_type: "view",
        role: "NO_ACCESS",
      }),
    });
    expect(denyViewAccess.status).toBe(200);

    const exportHiddenViewDenied = await api(env, ctx, memberToken, "/api/database/export/table/20/", {
      method: "POST",
      body: JSON.stringify({ exporter_type: "csv", view_id: 40 }),
    });
    expect(exportHiddenViewDenied.status).toBe(403);
  });

  it("enforces enterprise roles on search result visibility", async () => {
    const { db, env, ctx, token, memberToken, queueMessages } = await setupEnterpriseApiFixture();

    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO "database_table_20" ([order], _created_on, _updated_on, _created_by_id, _last_modified_by_id, "field_30")
       VALUES (10000, ?, ?, 7, 7, 'Needle private value')`
    ).bind(now, now).run();

    const memberRowSearchAllowed = await api(env, ctx, memberToken, "/api/search/workspace/1/?query=Needle&types=database_row");
    expect(memberRowSearchAllowed.status).toBe(200);
    expect((await memberRowSearchAllowed.json() as any).results).toEqual([
      expect.objectContaining({
        type: "database_row",
        metadata: expect.objectContaining({ table_id: 20, field_id: 30 }),
      }),
    ]);

    const denyField = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 30,
        scope_type: "field",
        role: "NO_ACCESS",
      }),
    });
    expect(denyField.status).toBe(200);

    const memberRowSearchDenied = await api(env, ctx, memberToken, "/api/search/workspace/1/?query=Needle&types=database_row");
    expect(memberRowSearchDenied.status).toBe(200);
    expect((await memberRowSearchDenied.json() as any).results).toEqual([]);

    const denyTable = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "NO_ACCESS",
      }),
    });
    expect(denyTable.status).toBe(200);

    const memberTableSearchDenied = await api(env, ctx, memberToken, "/api/search/workspace/1/?query=Table&types=database_table,database_field");
    expect(memberTableSearchDenied.status).toBe(200);
    expect((await memberTableSearchDenied.json() as any).results).toEqual([]);

    const denyApplication = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 10,
        scope_type: "application",
        role: "NO_ACCESS",
      }),
    });
    expect(denyApplication.status).toBe(200);

    const memberApplicationSearchDenied = await api(env, ctx, memberToken, "/api/search/all/?query=Database&workspace_id=1");
    expect(memberApplicationSearchDenied.status).toBe(200);
    expect((await memberApplicationSearchDenied.json() as any).results).toEqual([]);
  });

  it("enforces enterprise builder roles on data sync creation, update and sync", async () => {
    const { db, env, ctx, token, memberToken, queueMessages } = await setupEnterpriseApiFixture();

	  const now = new Date().toISOString();
	  await db.prepare(
	    `INSERT INTO database_field (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
	     VALUES (31, 20, 'Notes', 'text', 2, 0, 0, 0, '{}', ?, ?)`
	  ).bind(now, now).run();
	  await addFieldColumn(db as any, 20, { id: 31, type: "text" });
	  await db.prepare(
	    `INSERT INTO "database_table_20" ([order], _created_on, _updated_on, _created_by_id, _last_modified_by_id, "field_30", "field_31")
	     VALUES (10000, ?, ?, 7, 7, 'Source row', 'Source notes')`
	  ).bind(now, now).run();

    const body = {
      type: "local_baserow_table",
      table_name: "Synced source",
      source_table_id: 20,
      synced_properties: ["field_30"],
    };

    const memberCreateDenied = await api(env, ctx, memberToken, "/api/database/data-sync/database/10/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(memberCreateDenied.status).toBe(403);

    const grantApplicationBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 10,
        scope_type: "application",
        role: "BUILDER",
      }),
    });
    expect(grantApplicationBuilder.status).toBe(200);

    const denySourceTable = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "NO_ACCESS",
      }),
    });
    expect(denySourceTable.status).toBe(200);

    const memberCreateSourceDenied = await api(env, ctx, memberToken, "/api/database/data-sync/database/10/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(memberCreateSourceDenied.status).toBe(403);

    const allowSourceTableViewer = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 20,
        scope_type: "table",
        role: "VIEWER",
      }),
    });
    expect(allowSourceTableViewer.status).toBe(200);

    const memberCreateAllowed = await api(env, ctx, memberToken, "/api/database/data-sync/database/10/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(memberCreateAllowed.status).toBe(200);
    const syncedTable = await memberCreateAllowed.json() as any;
    expect(syncedTable).toMatchObject({ name: "Synced source", database_id: 10 });
    expect(syncedTable.data_sync).toMatchObject({ type: "local_baserow_table" });

    const dataSyncId = syncedTable.data_sync.id;
    const storedAuthorizedUser = await db.prepare(
      "SELECT authorized_user_id FROM database_datasync WHERE id=?"
    ).bind(dataSyncId).first<{ authorized_user_id: number }>();
    expect(storedAuthorizedUser?.authorized_user_id).toBe(8);
    const restrictSyncedTableToViewer = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: syncedTable.id,
        scope_type: "table",
        role: "VIEWER",
      }),
    });
    expect(restrictSyncedTableToViewer.status).toBe(200);

    const memberReadAllowed = await api(env, ctx, memberToken, `/api/database/data-sync/${dataSyncId}/`);
    expect(memberReadAllowed.status).toBe(200);
    expect(await memberReadAllowed.json()).toMatchObject({
      id: dataSyncId,
      type: "local_baserow_table",
      source_table_id: 20,
      source_table_view_id: null,
    });

    const memberPeriodicReadAllowed = await api(env, ctx, memberToken, `/api/database/data-sync/${dataSyncId}/periodic-interval/`);
    expect(memberPeriodicReadAllowed.status).toBe(200);
    expect(await memberPeriodicReadAllowed.json()).toEqual({
      interval: "MANUAL",
      when: null,
      automatically_deactivated: false,
    });

    const memberPeriodicPatchDenied = await api(env, ctx, memberToken, `/api/database/data-sync/${dataSyncId}/periodic-interval/`, {
      method: "PATCH",
      body: JSON.stringify({ interval: "DAILY", when: "12:10:01.000001" }),
    });
    expect(memberPeriodicPatchDenied.status).toBe(403);

    const ownerPeriodicPatchAllowed = await api(env, ctx, token, `/api/database/data-sync/${dataSyncId}/periodic-interval/`, {
      method: "PATCH",
      body: JSON.stringify({ interval: "DAILY", when: "12:10:01.000001" }),
    });
    expect(ownerPeriodicPatchAllowed.status).toBe(200);
    expect(await ownerPeriodicPatchAllowed.json()).toEqual({
      interval: "DAILY",
      when: "12:10:01.000001",
      automatically_deactivated: false,
    });
    const storedPeriodic = await db.prepare(
      "SELECT periodic_interval, periodic_interval_count, periodic_when, next_periodic_sync, deactivated, deactivation_reason FROM database_datasync WHERE id=?"
    ).bind(dataSyncId).first<any>();
    expect(storedPeriodic).toMatchObject({
      periodic_interval: "day",
      periodic_interval_count: 1,
      periodic_when: "12:10:01.000001",
      deactivated: 0,
      deactivation_reason: null,
    });
    expect(storedPeriodic.next_periodic_sync).toEqual(expect.any(String));

    await db.prepare(
      "UPDATE database_datasync SET deactivated=1, deactivation_reason='consecutive_failures' WHERE id=?"
    ).bind(dataSyncId).run();
    const ownerPeriodicReactivation = await api(env, ctx, token, `/api/database/data-sync/${dataSyncId}/periodic-interval/`, {
      method: "PATCH",
      body: JSON.stringify({ interval: "HOURLY", when: "00:15:30" }),
    });
    expect(ownerPeriodicReactivation.status).toBe(200);
    expect(await ownerPeriodicReactivation.json()).toEqual({
      interval: "HOURLY",
      when: "00:15:30",
      automatically_deactivated: false,
    });
    const audit = await db.prepare(
      "SELECT type, action_params FROM enterprise_auditlogentry WHERE type='update_periodic_data_sync_interval' ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(audit?.type).toBe("update_periodic_data_sync_interval");
    expect(JSON.parse(audit.action_params)).toMatchObject({
      interval: "HOURLY",
      when: "00:15:30",
      table_id: syncedTable.id,
      table_name: "Synced source",
      database_id: 10,
      database_name: "Database",
      data_sync_id: dataSyncId,
    });

	  const memberPatchDenied = await api(env, ctx, memberToken, `/api/database/data-sync/${dataSyncId}/`, {
	    method: "PATCH",
	    body: JSON.stringify({ auto_add_new_properties: false }),
	  });
	  expect(memberPatchDenied.status).toBe(403);

	  const ownerPatchInvalid = await api(env, ctx, token, `/api/database/data-sync/${dataSyncId}/`, {
	    method: "PATCH",
	    body: JSON.stringify({ synced_properties: ["field_31", "field_31", "field_999999"] }),
	  });
	  expect(ownerPatchInvalid.status).toBe(400);
	  expect(await ownerPatchInvalid.json()).toMatchObject({ error: "ERROR_PROPERTY_NOT_FOUND" });

	  const ownerPatchAllowed = await api(env, ctx, token, `/api/database/data-sync/${dataSyncId}/`, {
	    method: "PATCH",
	    body: JSON.stringify({ synced_properties: ["field_31", "field_31"] }),
	  });
	  expect(ownerPatchAllowed.status).toBe(200);
	  const patchedDataSync = await ownerPatchAllowed.json() as any;
	  expect(patchedDataSync.synced_properties.map((property: any) => property.key)).toEqual(["id", "field_31"]);
	  const activeSyncedFields = (await db.prepare(
	    "SELECT name FROM database_field WHERE table_id=? AND trashed=0 ORDER BY [order] ASC"
	  ).bind(syncedTable.id).all()).results.map((field: any) => field.name);
	  expect(activeSyncedFields).toEqual(["Row ID", "Notes"]);

	  const memberSyncDenied = await api(env, ctx, memberToken, `/api/database/data-sync/${dataSyncId}/sync/async/`, {
	    method: "POST",
	    body: JSON.stringify({}),
    });
    expect(memberSyncDenied.status).toBe(403);

    const ownerSyncAllowed = await api(env, ctx, token, `/api/database/data-sync/${dataSyncId}/sync/async/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(ownerSyncAllowed.status).toBe(202);
    const syncJob = await ownerSyncAllowed.json() as any;
    expect(syncJob).toMatchObject({
      type: "sync_data_sync_table",
      state: "pending",
      progress_percentage: 0,
      data_sync_id: dataSyncId,
      data_sync: { id: dataSyncId, type: "local_baserow_table" },
    });
    expect(queueMessages.at(-1)).toMatchObject({
      job_type: "sync_data_sync_table",
      payload: { data_sync_id: dataSyncId, datasync_id: dataSyncId },
      user_id: 7,
      workspace_id: 1,
    });
    const duplicateSync = await api(env, ctx, token, `/api/database/data-sync/${dataSyncId}/sync/async/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(duplicateSync.status).toBe(400);
    expect(await duplicateSync.json()).toEqual({
      error: "ERROR_MAX_JOB_COUNT_EXCEEDED",
      detail: "The sync data sync job is already running.",
    });
    const storedJob = await db.prepare("SELECT type, status, progress_percentage, result FROM core_job WHERE id=?")
      .bind(syncJob.id)
      .first<any>();
    expect(storedJob).toMatchObject({ type: "sync_data_sync_table", status: "pending", progress_percentage: 0 });
    expect(JSON.parse(storedJob.result)).toMatchObject({ data_sync_id: dataSyncId });
  });

  it("serializes local Baserow data sync table capabilities in integration context", async () => {
    const { db, env, ctx, token } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (11, 1, 'Builder app', 'builder', 2, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on, data_sync_id)
       VALUES (21, 10, 'Synced read only', 2, 1, 0, ?, ?, 701),
              (22, 10, 'Synced two way', 3, 1, 0, ?, ?, 702)`
    ).bind(now, now, now, now).run();
    await db.prepare(
      `INSERT INTO database_datasync
       (id, table_id, type, settings, auto_add_new_properties, two_way_sync, authorized, created_on, updated_on)
       VALUES (701, 21, 'ical_calendar', '{}', 0, 0, 1, ?, ?),
              (702, 22, 'postgresql', '{}', 0, 1, 1, ?, ?)`
    ).bind(now, now, now, now).run();

    const createIntegration = await api(env, ctx, token, "/api/application/11/integrations/", {
      method: "POST",
      body: JSON.stringify({ type: "local_baserow", name: "Local Baserow" }),
    });
    expect(createIntegration.status).toBe(200);

    const listIntegrations = await api(env, ctx, token, "/api/application/11/integrations/");
    expect(listIntegrations.status).toBe(200);
    const [integration] = await listIntegrations.json() as any[];
    const tables = integration.context_data.databases[0].tables;
    expect(tables.map((table: any) => ({
      id: table.id,
      is_data_sync: table.is_data_sync,
      is_two_way_data_sync: table.is_two_way_data_sync,
    }))).toEqual([
      { id: 20, is_data_sync: false, is_two_way_data_sync: false },
      { id: 21, is_data_sync: true, is_two_way_data_sync: false },
      { id: 22, is_data_sync: true, is_two_way_data_sync: true },
    ]);
  });

  it("enforces enterprise builder roles on builder, automation and integration routes", async () => {
    const { db, env, ctx, token, memberToken, queueMessages } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (11, 1, 'Builder app', 'builder', 2, 0, ?, ?),
              (12, 1, 'Automation app', 'automation', 3, 0, ?, ?),
              (13, 1, 'Integration app', 'builder', 4, 0, ?, ?)`
    ).bind(now, now, now, now, now, now).run();

    const memberBuilderRead = await api(env, ctx, memberToken, "/api/builder/11/pages/");
    expect(memberBuilderRead.status).toBe(200);

    const memberBuilderWriteDenied = await api(env, ctx, memberToken, "/api/builder/11/pages/", {
      method: "POST",
      body: JSON.stringify({ name: "Blocked page", path: "/blocked" }),
    });
    expect(memberBuilderWriteDenied.status).toBe(403);

    const memberAutomationRead = await api(env, ctx, memberToken, "/api/automation/12/workflows/");
    expect(memberAutomationRead.status).toBe(200);

    const memberAutomationWriteDenied = await api(env, ctx, memberToken, "/api/automation/12/workflows/", {
      method: "POST",
      body: JSON.stringify({ name: "Blocked workflow" }),
    });
    expect(memberAutomationWriteDenied.status).toBe(403);

    const memberIntegrationRead = await api(env, ctx, memberToken, "/api/application/13/integrations/");
    expect(memberIntegrationRead.status).toBe(200);

    const memberIntegrationWriteDenied = await api(env, ctx, memberToken, "/api/application/13/integrations/", {
      method: "POST",
      body: JSON.stringify({ type: "local_baserow", name: "Blocked integration" }),
    });
    expect(memberIntegrationWriteDenied.status).toBe(403);

    const grantWorkspaceBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "BUILDER",
      }),
    });
    expect(grantWorkspaceBuilder.status).toBe(200);

    const memberBuilderWriteAllowed = await api(env, ctx, memberToken, "/api/builder/11/pages/", {
      method: "POST",
      body: JSON.stringify({ name: "Allowed page", path: "/allowed" }),
    });
    expect(memberBuilderWriteAllowed.status).toBe(200);
    const page = await memberBuilderWriteAllowed.json() as any;
    expect(page).toMatchObject({ builder_id: 11, name: "Allowed page" });

    const memberElementWriteAllowed = await api(env, ctx, memberToken, `/api/builder/page/${page.id}/elements/`, {
      method: "POST",
      body: JSON.stringify({ type: "simple_container" }),
    });
    expect(memberElementWriteAllowed.status).toBe(200);
    const parentElement = await memberElementWriteAllowed.json() as any;

    const memberDataSourceWriteAllowed = await api(env, ctx, memberToken, `/api/builder/page/${page.id}/data-sources/`, {
      method: "POST",
      body: JSON.stringify({ type: "local_baserow_list_rows", name: "Allowed data source", table_id: 20 }),
    });
    expect(memberDataSourceWriteAllowed.status).toBe(200);
    const dataSource = await memberDataSourceWriteAllowed.json() as any;

    const memberChildElementWriteAllowed = await api(env, ctx, memberToken, `/api/builder/page/${page.id}/elements/`, {
      method: "POST",
      body: JSON.stringify({
        type: "button",
        value: "Refresh",
        parent_element_id: parentElement.id,
        place_in_container: "children",
        data_source_id: dataSource.id,
      }),
    });
    expect(memberChildElementWriteAllowed.status).toBe(200);
    const childElement = await memberChildElementWriteAllowed.json() as any;

    const memberWorkflowActionWriteAllowed = await api(env, ctx, memberToken, `/api/builder/page/${page.id}/workflow_actions/`, {
      method: "POST",
      body: JSON.stringify({
        type: "notification",
        event: "click",
        element_id: childElement.id,
        data_source_id: dataSource.id,
      }),
    });
    expect(memberWorkflowActionWriteAllowed.status).toBe(200);

    const memberPageDuplicateAllowed = await api(env, ctx, memberToken, `/api/builder/pages/${page.id}/duplicate/async/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(memberPageDuplicateAllowed.status).toBe(200);
    const duplicateJob = await memberPageDuplicateAllowed.json() as any;
    expect(duplicateJob).toMatchObject({ state: "finished", type: "duplicate_builder_page" });
    const duplicatedPageId = duplicateJob.duplicated_page.id;
    const duplicatedDataSources = await api(env, ctx, memberToken, `/api/builder/page/${duplicatedPageId}/data-sources/`);
    expect(duplicatedDataSources.status).toBe(200);
    const duplicatedDataSourceRows = await duplicatedDataSources.json() as any[];
    expect(duplicatedDataSourceRows).toHaveLength(1);
    expect(duplicatedDataSourceRows[0]).toMatchObject({ name: "Allowed data source", table_id: 20 });
    expect(duplicatedDataSourceRows[0].id).not.toBe(dataSource.id);

    const duplicatedElements = await api(env, ctx, memberToken, `/api/builder/page/${duplicatedPageId}/elements/`);
    expect(duplicatedElements.status).toBe(200);
    const duplicatedElementRows = await duplicatedElements.json() as any[];
    expect(duplicatedElementRows).toHaveLength(2);
    const duplicatedParent = duplicatedElementRows.find((element: any) => element.type === "simple_container");
    const duplicatedChild = duplicatedElementRows.find((element: any) => element.type === "button");
    expect(duplicatedChild.parent_element_id).toBe(duplicatedParent.id);
    expect(duplicatedChild.data_source_id).toBe(duplicatedDataSourceRows[0].id);

    const duplicatedWorkflowActions = await api(env, ctx, memberToken, `/api/builder/page/${duplicatedPageId}/workflow_actions/`);
    expect(duplicatedWorkflowActions.status).toBe(200);
    const duplicatedWorkflowActionRows = await duplicatedWorkflowActions.json() as any[];
    expect(duplicatedWorkflowActionRows).toHaveLength(1);
    expect(duplicatedWorkflowActionRows[0].element_id).toBe(duplicatedChild.id);
    expect(duplicatedWorkflowActionRows[0].data_source_id).toBe(duplicatedDataSourceRows[0].id);

    const memberAutomationWriteAllowed = await api(env, ctx, memberToken, "/api/automation/12/workflows/", {
      method: "POST",
      body: JSON.stringify({ name: "Allowed workflow" }),
    });
    expect(memberAutomationWriteAllowed.status).toBe(200);
    const workflow = await memberAutomationWriteAllowed.json() as any;
    expect(workflow).toMatchObject({ automation_id: 12, name: "Allowed workflow" });

    const memberNodeWriteAllowed = await api(env, ctx, memberToken, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger", label: "Trigger" }),
    });
    expect(memberNodeWriteAllowed.status).toBe(200);
    const triggerNode = await memberNodeWriteAllowed.json() as any;

    const publishWorkflowAllowed = await api(env, ctx, memberToken, `/api/automation/workflows/${workflow.id}/publish/async/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(publishWorkflowAllowed.status).toBe(202);
    const startedPublishJob = await publishWorkflowAllowed.json() as any;
    expect(startedPublishJob.state).toBe("pending");
    await runNextQueuedJob(env, queueMessages);
    const publishJobResponse = await api(env, ctx, memberToken, `/api/jobs/${startedPublishJob.id}/`);
    const publishJob = await publishJobResponse.json() as any;
    expect(publishJob.state).toBe("finished");
    expect(publishJob.published_automation_workflow_id).toBeTruthy();
    const firstPublishedWorkflowId = publishJob.published_automation_workflow_id;
    const firstPublishedNode = await db.prepare(
      "SELECT id FROM automation_node WHERE workflow_id=? ORDER BY id ASC LIMIT 1"
    ).bind(firstPublishedWorkflowId).first<any>();
    expect(firstPublishedNode?.id).toBeTruthy();

    const liveWebhook = await worker.fetch(new Request(`https://api.supertask.test/api/webhooks/${triggerNode.service.uid}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }), env, ctx);
    expect(liveWebhook.status).toBe(204);

    const firstPublishedNodeHistory = await db.prepare(
      "SELECT COUNT(*) AS count FROM automation_node_history WHERE node_id=?"
    ).bind(firstPublishedNode.id).first<any>();
    expect(firstPublishedNodeHistory.count).toBeGreaterThan(0);

    const republishWorkflowAllowed = await api(env, ctx, memberToken, `/api/automation/workflows/${workflow.id}/publish/async/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(republishWorkflowAllowed.status).toBe(202);
    const startedRepublishJob = await republishWorkflowAllowed.json() as any;
    await runNextQueuedJob(env, queueMessages);
    const republishJobResponse = await api(env, ctx, memberToken, `/api/jobs/${startedRepublishJob.id}/`);
    const republishJob = await republishJobResponse.json() as any;
    expect(republishJob.state).toBe("finished");
    expect(republishJob.published_automation_workflow_id).toBeTruthy();
    expect(republishJob.published_automation_workflow_id).not.toBe(firstPublishedWorkflowId);

    const oldPublishedWorkflow = await db.prepare(
      "SELECT id FROM automation_workflow WHERE id=?"
    ).bind(firstPublishedWorkflowId).first<any>();
    expect(oldPublishedWorkflow).toBeNull();
    const oldPublishedNodeCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM automation_node WHERE workflow_id=?"
    ).bind(firstPublishedWorkflowId).first<any>();
    expect(oldPublishedNodeCount.count).toBe(0);
    const oldPublishedNodeHistoryCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM automation_node_history WHERE node_id=?"
    ).bind(firstPublishedNode.id).first<any>();
    expect(oldPublishedNodeHistoryCount.count).toBe(0);

    const republishedWebhook = await worker.fetch(new Request(`https://api.supertask.test/api/webhooks/${triggerNode.service.uid}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }), env, ctx);
    expect(republishedWebhook.status).toBe(204);

    const deleteWorkflowAllowed = await api(env, ctx, memberToken, `/api/automation/workflows/${workflow.id}/`, {
      method: "DELETE",
    });
    expect(deleteWorkflowAllowed.status).toBe(204);

    const workflowFamily = await db.prepare(
      `SELECT id, trashed, state, allow_test_run_until, simulate_until_node_id
       FROM automation_workflow
       WHERE id=? OR published_from_workflow_id=?
       ORDER BY id ASC`
    ).bind(workflow.id, workflow.id).all<any>();
    expect(workflowFamily.results).toHaveLength(1);
    expect(workflowFamily.results[0]).toMatchObject({
      id: workflow.id,
      trashed: 1,
      state: "draft",
    });

    const workflowFamilyNodes = await db.prepare(
      `SELECT id, trashed FROM automation_node
       WHERE workflow_id=?
       ORDER BY id ASC`
    ).bind(workflow.id).all<any>();
    expect(workflowFamilyNodes.results.length).toBeGreaterThanOrEqual(1);
    expect(workflowFamilyNodes.results.every((row) => row.trashed === 0)).toBe(true);

    expect(await db.prepare(
      "SELECT id FROM core_trasheditem WHERE trash_item_type='automation_workflow' AND trash_item_id=?"
    ).bind(workflow.id).first<any>()).toBeTruthy();

    const deletedWebhook = await worker.fetch(new Request(`https://api.supertask.test/api/webhooks/${triggerNode.service.uid}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }), env, ctx);
    expect(deletedWebhook.status).toBe(404);

    const memberIntegrationWriteAllowed = await api(env, ctx, memberToken, "/api/application/13/integrations/", {
      method: "POST",
      body: JSON.stringify({ type: "local_baserow", name: "Allowed integration" }),
    });
    expect(memberIntegrationWriteAllowed.status).toBe(200);
    const integration = await memberIntegrationWriteAllowed.json() as any;
    expect(integration).toMatchObject({ application_id: 13, name: "Allowed integration" });

    for (const applicationId of [11, 12, 13]) {
      const denyApplication = await api(env, ctx, token, "/api/role/1/", {
        method: "POST",
        body: JSON.stringify({
          subject_id: 8,
          subject_type: "auth.User",
          scope_id: applicationId,
          scope_type: "application",
          role: "NO_ACCESS",
        }),
      });
      expect(denyApplication.status).toBe(200);
    }

    const memberBuilderReadDenied = await api(env, ctx, memberToken, "/api/builder/11/pages/");
    expect(memberBuilderReadDenied.status).toBe(403);

    const memberAutomationReadDenied = await api(env, ctx, memberToken, "/api/automation/12/workflows/");
    expect(memberAutomationReadDenied.status).toBe(403);

    const memberIntegrationReadDenied = await api(env, ctx, memberToken, "/api/application/13/integrations/");
    expect(memberIntegrationReadDenied.status).toBe(403);
  });

  it("enforces enterprise roles on audit logs, notifications, snapshots, MCP and dashboards", async () => {
    const { db, env, ctx, token, memberToken } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (14, 1, 'Dashboard app', 'dashboard', 2, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO enterprise_auditlogentry
       (user_id, user_email, user_name, workspace_id, workspace_name, type, timestamp, action_params)
       VALUES (7, 'owner@example.com', 'Owner User', 1, 'Workspace', 'database.rows.created', ?, '{}')`
    ).bind(now).run();
    const notification = await db.prepare(
      `INSERT INTO core_notification (created_on, updated_on, type, data, workspace_id, sender_id, broadcast)
       VALUES (?, ?, 'row_comment', '{"message":"Private"}', 1, 7, 0) RETURNING id`
    ).bind(now, now).first<any>();
    await db.prepare(
      `INSERT INTO core_notificationrecipient (notification_id, recipient_id, read, cleared, created_on)
       VALUES (?, 8, 0, 0, ?)`
    ).bind(notification.id, now).run();
    const snapshot = await db.prepare(
      `INSERT INTO core_snapshot (snapshot_from_application_id, snapshot_to_application_id, name, created_at, created_by_id)
       VALUES (10, NULL, 'Manual snapshot', ?, 7) RETURNING id`
    ).bind(now).first<any>();
    await env.FILES.put(`snapshots/${snapshot.id}.json`, JSON.stringify(await buildApplicationSnapshot(db as any, 10)));

    const auditDenied = await api(env, ctx, memberToken, "/api/audit-log/?workspace_id=1");
    expect(auditDenied.status).toBe(403);

    const mcpCreateDenied = await api(env, ctx, memberToken, "/api/mcp/endpoints/", {
      method: "POST",
      body: JSON.stringify({ name: "Blocked MCP", workspace_id: 1 }),
    });
    expect(mcpCreateDenied.status).toBe(403);

    const grantDashboardViewer = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 14,
        scope_type: "application",
        role: "VIEWER",
      }),
    });
    expect(grantDashboardViewer.status).toBe(200);

    const dashboardReadAllowed = await api(env, ctx, memberToken, "/api/dashboard/14/widgets/");
    expect(dashboardReadAllowed.status).toBe(200);

    const dashboardWriteDenied = await api(env, ctx, memberToken, "/api/dashboard/14/widgets/", {
      method: "POST",
      body: JSON.stringify({ type: "summary", title: "Blocked" }),
    });
    expect(dashboardWriteDenied.status).toBe(403);

    const snapshotListAllowed = await api(env, ctx, memberToken, "/api/snapshots/application/10/");
    expect(snapshotListAllowed.status).toBe(200);

    const snapshotCreateDenied = await api(env, ctx, memberToken, "/api/snapshots/application/10/", {
      method: "POST",
      body: JSON.stringify({ name: "Blocked snapshot" }),
    });
    expect(snapshotCreateDenied.status).toBe(403);

    const notificationListAllowed = await api(env, ctx, memberToken, "/api/notifications/1/");
    expect(notificationListAllowed.status).toBe(200);
    expect((await notificationListAllowed.json() as any).count).toBe(1);

    const grantWorkspaceAdmin = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "ADMIN",
      }),
    });
    expect(grantWorkspaceAdmin.status).toBe(200);

    const auditAllowed = await api(env, ctx, memberToken, "/api/audit-log/?workspace_id=1");
    expect(auditAllowed.status).toBe(200);
    const auditResults = (await auditAllowed.json() as any).results;
    expect(auditResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "database.rows.created" }),
    ]));

    const downgradeWorkspaceBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "BUILDER",
      }),
    });
    expect(downgradeWorkspaceBuilder.status).toBe(200);

    const mcpCreateAllowed = await api(env, ctx, memberToken, "/api/mcp/endpoints/", {
      method: "POST",
      body: JSON.stringify({ name: "Allowed MCP", workspace_id: 1 }),
    });
    expect(mcpCreateAllowed.status).toBe(200);
    const endpoint = await mcpCreateAllowed.json() as any;
    expect(endpoint).toMatchObject({ name: "Allowed MCP", workspace_id: 1 });

    const grantDashboardBuilder = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 14,
        scope_type: "application",
        role: "BUILDER",
      }),
    });
    expect(grantDashboardBuilder.status).toBe(200);

    const dashboardWriteAllowed = await api(env, ctx, memberToken, "/api/dashboard/14/widgets/", {
      method: "POST",
      body: JSON.stringify({ type: "summary", title: "Allowed" }),
    });
    expect(dashboardWriteAllowed.status).toBe(200);
    const widget = await dashboardWriteAllowed.json() as any;
    expect(widget).toMatchObject({
      dashboard_id: 14,
      type: "summary",
      title: "Allowed",
      description: "",
      data_source_id: expect.any(Number),
    });

    const dashboardIntegrations = await api(env, ctx, memberToken, "/api/application/14/integrations/");
    expect(dashboardIntegrations.status).toBe(200);
    const integrationRows = await dashboardIntegrations.json() as any[];
    expect(integrationRows).toHaveLength(1);
    expect(integrationRows[0]).toMatchObject({
      application_id: 14,
      type: "local_baserow",
      name: "Local Supertask",
      context_data: {
        databases: [expect.objectContaining({ id: 10, name: "Database" })],
      },
    });

    const summarySourcesResponse = await api(env, ctx, memberToken, "/api/dashboard/14/data-sources/");
    expect(summarySourcesResponse.status).toBe(200);
    const summarySources = await summarySourcesResponse.json() as any[];
    expect(summarySources).toHaveLength(1);
    expect(summarySources[0]).toMatchObject({
      id: widget.data_source_id,
      dashboard_id: 14,
      type: "local_baserow_aggregate_rows",
      name: "WidgetDataSource",
      order: "1",
      integration_id: integrationRows[0].id,
      table_id: null,
      view_id: null,
      field_id: null,
      aggregation_type: "",
      schema: null,
      context_data: {},
      context_data_schema: null,
      sample_data: null,
    });
    expect(summarySources[0]).not.toHaveProperty("service");

    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES (31, 20, 'Amount', 'number', 2, 0, 0, 0, '{"number_decimal_places":2}', ?, ?)`
    ).bind(now, now).run();
    await addFieldColumn(db as any, 20, { id: 31, type: "number" });
    await db.prepare(
      `INSERT INTO database_table_20 ([order], field_30, field_31, trashed)
       VALUES (1, 'Alpha', 'n:10', 0),
              (2, 'Beta', 'n:20', 0),
              (3, 'Alpha', 'n:5', 0)`
    ).run();

    const summaryUpdate = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${widget.data_source_id}/`, {
      method: "PATCH",
      body: JSON.stringify({
        table_id: 20,
        view_id: 40,
        field_id: 30,
        aggregation_type: "count",
      }),
    });
    expect(summaryUpdate.status).toBe(200);
    expect(await summaryUpdate.json()).toMatchObject({
      id: widget.data_source_id,
      table_id: 20,
      view_id: 40,
      field_id: 30,
      aggregation_type: "count",
      schema: {
        properties: {
          result: { title: "Name result", type: "number" },
        },
      },
      context_data: {
        field: expect.objectContaining({ id: 30, name: "Name", type: "text" }),
      },
      context_data_schema: null,
    });

    const summaryDispatch = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${widget.data_source_id}/dispatch/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(summaryDispatch.status).toBe(200);
    expect(await summaryDispatch.json()).toEqual({ result: 3 });

    const numericAggregations: Array<[string, number]> = [
      ["count", 3],
      ["empty_count", 0],
      ["not_empty_count", 3],
      ["empty_percentage", 0],
      ["not_empty_percentage", 100],
      ["unique_count", 3],
      ["min", 5],
      ["max", 20],
      ["sum", 35],
      ["average", 35 / 3],
      ["median", 10],
      ["variance", 350 / 9],
      ["std_dev", Math.sqrt(350 / 9)],
    ];
    for (const [aggregationType, expectedResult] of numericAggregations) {
      const update = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${widget.data_source_id}/`, {
        method: "PATCH",
        body: JSON.stringify({ field_id: 31, aggregation_type: aggregationType }),
      });
      expect(update.status, aggregationType).toBe(200);
      const dispatch = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${widget.data_source_id}/dispatch/`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(dispatch.status, aggregationType).toBe(200);
      const result = (await dispatch.json() as any).result;
      expect(result, aggregationType).toBeCloseTo(expectedResult, 8);
    }

    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES (32, 20, 'Enabled', 'boolean', 3, 0, 0, 0, '{}', ?, ?)`
    ).bind(now, now).run();
    await addFieldColumn(db as any, 20, { id: 32, type: "boolean" });
    await db.prepare(
      `UPDATE database_table_20
       SET field_32=CASE WHEN field_30='Beta' THEN 0 ELSE 1 END`
    ).run();
    for (const [aggregationType, expectedResult] of [
      ["checked_count", 2],
      ["not_checked_count", 1],
      ["checked_percentage", 200 / 3],
      ["not_checked_percentage", 100 / 3],
    ] as Array<[string, number]>) {
      const update = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${widget.data_source_id}/`, {
        method: "PATCH",
        body: JSON.stringify({ field_id: 32, aggregation_type: aggregationType }),
      });
      expect(update.status, aggregationType).toBe(200);
      const dispatch = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${widget.data_source_id}/dispatch/`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(dispatch.status, aggregationType).toBe(200);
      expect((await dispatch.json() as any).result, aggregationType).toBeCloseTo(expectedResult, 8);
    }

    const forbiddenIntegrationUpdate = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${widget.data_source_id}/`, {
      method: "PATCH",
      body: JSON.stringify({ integration_id: integrationRows[0].id }),
    });
    expect(forbiddenIntegrationUpdate.status).toBe(400);

    const chartCreate = await api(env, ctx, memberToken, "/api/dashboard/14/widgets/", {
      method: "POST",
      body: JSON.stringify({ type: "chart", title: "Amounts", default_series_chart_type: "BAR" }),
    });
    expect(chartCreate.status).toBe(200);
    const chartWidget = await chartCreate.json() as any;
    expect(chartWidget).toMatchObject({
      dashboard_id: 14,
      type: "chart",
      title: "Amounts",
      default_series_chart_type: "BAR",
      series_config: [],
      data_source_id: expect.any(Number),
    });

    const chartUpdate = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${chartWidget.data_source_id}/`, {
      method: "PATCH",
      body: JSON.stringify({
        table_id: 20,
        view_id: 40,
        aggregation_series: [{ field_id: 31, aggregation_type: "sum" }],
        aggregation_group_bys: [{ field_id: 30 }],
        aggregation_sorts: [{
          sort_on: "SERIES",
          reference: "field_31_sum",
          direction: "DESC",
        }],
      }),
    });
    expect(chartUpdate.status).toBe(200);
    const chartSource = await chartUpdate.json() as any;
    expect(chartSource).toMatchObject({
      id: chartWidget.data_source_id,
      type: "local_baserow_grouped_aggregate_rows",
      table_id: 20,
      view_id: 40,
      aggregation_series: [{
        id: expect.any(Number),
        field_id: 31,
        aggregation_type: "sum",
      }],
      aggregation_group_bys: [{ order: 1, field_id: 30 }],
      aggregation_sorts: [{
        order: 1,
        sort_on: "SERIES",
        reference: "field_31_sum",
        direction: "DESC",
      }],
      schema: {
        title: `GroupedAggregation${chartWidget.data_source_id}Schema`,
        properties: {
          field_30: expect.objectContaining({ title: "Name" }),
          field_31: expect.objectContaining({ title: "Amount" }),
        },
      },
      context_data: {
        fields: {
          field_30: expect.objectContaining({ id: 30, name: "Name", type: "text" }),
        },
      },
      context_data_schema: null,
    });

    const seriesId = chartSource.aggregation_series[0].id;
    const chartWidgetUpdate = await api(env, ctx, memberToken, `/api/dashboard/widgets/${chartWidget.id}/`, {
      method: "PATCH",
      body: JSON.stringify({
        series_config: [{ series_id: seriesId, series_chart_type: "BAR" }],
      }),
    });
    expect(chartWidgetUpdate.status).toBe(200);
    expect(await chartWidgetUpdate.json()).toMatchObject({
      id: chartWidget.id,
      series_config: [{ series_id: seriesId, series_chart_type: "BAR" }],
    });

    const chartDispatch = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${chartWidget.data_source_id}/dispatch/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(chartDispatch.status).toBe(200);
    expect(await chartDispatch.json()).toEqual({
      result: [
        { field_30: "Beta", field_31_sum: 20 },
        { field_30: "Alpha", field_31_sum: 15 },
      ],
    });

    const addMedianSeries = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${chartWidget.data_source_id}/`, {
      method: "PATCH",
      body: JSON.stringify({
        aggregation_series: [
          { id: seriesId, field_id: 31, aggregation_type: "sum" },
          { field_id: 31, aggregation_type: "median" },
        ],
      }),
    });
    expect(addMedianSeries.status).toBe(200);
    const sourceWithMedian = await addMedianSeries.json() as any;
    expect(sourceWithMedian.aggregation_series).toEqual([
      { id: seriesId, field_id: 31, aggregation_type: "sum" },
      { id: expect.any(Number), field_id: 31, aggregation_type: "median" },
    ]);
    const chartDispatchWithMedian = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${chartWidget.data_source_id}/dispatch/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(chartDispatchWithMedian.status).toBe(200);
    expect(await chartDispatchWithMedian.json()).toEqual({
      result: [
        { field_30: "Beta", field_31_sum: 20, field_31_median: 20 },
        { field_30: "Alpha", field_31_sum: 15, field_31_median: 7.5 },
      ],
    });

    const duplicateSeriesUpdate = await api(env, ctx, memberToken, `/api/dashboard/data-sources/${chartWidget.data_source_id}/`, {
      method: "PATCH",
      body: JSON.stringify({
        aggregation_series: [
          { id: seriesId, field_id: 31, aggregation_type: "sum" },
          { field_id: 31, aggregation_type: "sum" },
        ],
      }),
    });
    expect(duplicateSeriesUpdate.status).toBe(400);

    const pieCreate = await api(env, ctx, memberToken, "/api/dashboard/14/widgets/", {
      method: "POST",
      body: JSON.stringify({ type: "pie_chart", title: "Distribution", default_series_chart_type: "DOUGHNUT" }),
    });
    expect(pieCreate.status).toBe(200);
    const pieWidget = await pieCreate.json() as any;
    expect(pieWidget).toMatchObject({
      type: "pie_chart",
      default_series_chart_type: "DOUGHNUT",
      series_config: [],
      data_source_id: expect.any(Number),
    });
    const deletePieWidget = await api(env, ctx, memberToken, `/api/dashboard/widgets/${pieWidget.id}/`, {
      method: "DELETE",
    });
    expect(deletePieWidget.status).toBe(204);

    const deleteChartWidget = await api(env, ctx, memberToken, `/api/dashboard/widgets/${chartWidget.id}/`, {
      method: "DELETE",
    });
    expect(deleteChartWidget.status).toBe(204);
    const sourcesAfterDelete = await api(env, ctx, memberToken, "/api/dashboard/14/data-sources/");
    expect((await sourcesAfterDelete.json() as any[]).map((item) => item.id)).not.toContain(chartWidget.data_source_id);

    const createdDashboardResponse = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ type: "dashboard", name: "Created dashboard" }),
    });
    expect(createdDashboardResponse.status).toBe(200);
    const createdDashboard = await createdDashboardResponse.json() as any;
    const createdDashboardIntegrations = await api(env, ctx, token, `/api/application/${createdDashboard.id}/integrations/`);
    expect(createdDashboardIntegrations.status).toBe(200);
    expect(await createdDashboardIntegrations.json()).toEqual([
      expect.objectContaining({ application_id: createdDashboard.id, type: "local_baserow", name: "Local Supertask" }),
    ]);

    const snapshotCreateAllowed = await api(env, ctx, memberToken, "/api/snapshots/application/10/", {
      method: "POST",
      body: JSON.stringify({ name: "Allowed snapshot" }),
    });
    expect(snapshotCreateAllowed.status).toBe(202);

    const snapshotRestoreAllowed = await api(env, ctx, memberToken, `/api/snapshots/${snapshot.id}/restore/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(snapshotRestoreAllowed.status).toBe(200);

    const denyWorkspace = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 1,
        scope_type: "workspace",
        role: "NO_ACCESS",
      }),
    });
    expect(denyWorkspace.status).toBe(200);

    const denyDashboardApplication = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 14,
        scope_type: "application",
        role: "NO_ACCESS",
      }),
    });
    expect(denyDashboardApplication.status).toBe(200);

    const notificationDenied = await api(env, ctx, memberToken, "/api/notifications/1/");
    expect(notificationDenied.status).toBe(403);

    const mcpListDeniedByFilter = await api(env, ctx, memberToken, "/api/mcp/endpoints/");
    expect(mcpListDeniedByFilter.status).toBe(200);
    expect(await mcpListDeniedByFilter.json()).toEqual([]);

    const dashboardReadDenied = await api(env, ctx, memberToken, "/api/dashboard/14/widgets/");
    expect(dashboardReadDenied.status).toBe(403);
  });

  it("paginates audit log filter dropdowns and applies Baserow sort contracts", async () => {
    const { db, env, ctx, token } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (2, 'Other workspace', ?, 0, 1)")
      .bind(now)
      .run();
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (9, '', 'zed@example.com', 'Zed', 'User', 'zed@example.com', 0, 1, ?)`
    ).bind(now).run();
    await db.prepare(
      `INSERT INTO enterprise_auditlogentry
       (user_id, user_email, user_name, workspace_id, workspace_name, type, timestamp, ip_address, action_params)
       VALUES
       (8, 'member@example.com', 'Member User', 1, 'Workspace', 'database.rows.update', '2026-01-02T10:00:00.000Z', '203.0.113.8', '{}'),
       (9, 'zed@example.com', 'Zed User', 1, 'Workspace', 'database.view.delete', '2026-01-03T10:00:00.000Z', '203.0.113.9', '{}'),
       (7, 'owner@example.com', 'Owner User', 2, 'Other workspace', 'workspace.create', '2026-01-04T10:00:00.000Z', '203.0.113.7', '{}')`
    ).run();

    const usersPage1 = await api(env, ctx, token, "/api/audit-log/users/?workspace_id=1&size=1&page=1");
    expect(usersPage1.status).toBe(200);
    const usersPayload = await usersPage1.json() as any;
    expect(usersPayload.count).toBe(2);
    expect(usersPayload.next).toBe("?page=2");
    expect(usersPayload.results).toHaveLength(1);

    const actionTypesPage1 = await api(env, ctx, token, "/api/audit-log/action-types/?workspace_id=1&size=1&page=1");
    expect(actionTypesPage1.status).toBe(200);
    const actionTypesPayload = await actionTypesPage1.json() as any;
    expect(actionTypesPayload.count).toBe(2);
    expect(actionTypesPayload.next).toBe("?page=2");

    const workspacesPage1 = await api(env, ctx, token, "/api/audit-log/workspaces/?size=1&page=1");
    expect(workspacesPage1.status).toBe(200);
    const workspacesPayload = await workspacesPage1.json() as any;
    expect(workspacesPayload.count).toBe(2);
    expect(workspacesPayload.next).toBe("?page=2");

    const sortedByUser = await api(env, ctx, token, "/api/audit-log/?workspace_id=1&sorts=%2Buser&size=10");
    expect(sortedByUser.status).toBe(200);
    expect((await sortedByUser.json() as any).results.map((entry: any) => entry.user_name)).toEqual([
      "Member User",
      "Zed User",
    ]);

    const invalidDirection = await api(env, ctx, token, "/api/audit-log/?workspace_id=1&sorts=user");
    expect(invalidDirection.status).toBe(400);
    expect(await invalidDirection.json()).toMatchObject({ error: "ERROR_INVALID_SORT_DIRECTION" });

    const invalidAttribute = await api(env, ctx, token, "/api/audit-log/?workspace_id=1&sorts=%2Bmissing");
    expect(invalidAttribute.status).toBe(400);
    expect(await invalidAttribute.json()).toMatchObject({ error: "ERROR_INVALID_SORT_ATTRIBUTE" });
  });

  it("delivers Baserow-compatible workspace invitation and broadcast notifications", async () => {
    const { db, env, ctx, token, memberToken } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (9, '', 'invitee@example.com', 'Invitee', 'User', 'invitee@example.com', 0, 1, ?),
              (10, '', 'rejector@example.com', 'Rejector', 'User', 'rejector@example.com', 0, 1, ?)`
    ).bind(now, now).run();
    const inviteeToken = await signAccessToken({ user_id: 9, email: "invitee@example.com", username: "invitee@example.com" }, "test-secret", 60);
    const rejectorToken = await signAccessToken({ user_id: 10, email: "rejector@example.com", username: "rejector@example.com" }, "test-secret", 60);

    const broadcast = await db.prepare(
      `INSERT INTO core_notification (created_on, updated_on, type, data, workspace_id, sender_id, broadcast)
       VALUES (?, ?, 'baserow_version_upgrade', '{"version":"1.0","release_notes_url":"https://example.com"}', NULL, NULL, 1)
       RETURNING id`
    ).bind(now, now).first<any>();

    const memberNotifications = await api(env, ctx, memberToken, "/api/notifications/1/");
    expect(memberNotifications.status).toBe(200);
    const memberNotificationPayload = await memberNotifications.json() as any;
    const broadcastNotification = memberNotificationPayload.results.find((item: any) => item.id === broadcast.id);
    expect(broadcastNotification).toMatchObject({
      id: broadcast.id,
      type: "baserow_version_upgrade",
      read: false,
      workspace: null,
    });
    expect(Object.keys(broadcastNotification).sort()).toEqual([
      "created_on",
      "data",
      "id",
      "read",
      "sender",
      "type",
      "workspace",
    ]);

    const invalidBroadcastRead = await api(env, ctx, memberToken, `/api/notifications/1/${broadcast.id}/`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(invalidBroadcastRead.status).toBe(400);
    expect(await invalidBroadcastRead.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });

    const markBroadcastRead = await api(env, ctx, memberToken, `/api/notifications/1/${broadcast.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ read: true }),
    });
    expect(markBroadcastRead.status).toBe(200);
    expect(await markBroadcastRead.json()).toMatchObject({ id: broadcast.id, read: true });
    const markAllWorkspaceNotificationsRead = await api(env, ctx, memberToken, "/api/notifications/1/mark-all-as-read/", { method: "POST" });
    expect(markAllWorkspaceNotificationsRead.status).toBe(204);

    const inviteResponse = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "invitee@example.com", permissions: "MEMBER" }),
    });
    expect(inviteResponse.status).toBe(201);
    const invitation = await inviteResponse.json() as any;
    const inviteeNotifications = await api(env, ctx, inviteeToken, "/api/notifications/");
    expect(inviteeNotifications.status).toBe(200);
    const inviteePayload = await inviteeNotifications.json() as any;
    const createdInvitationNotification = inviteePayload.results.find((item: any) => item.type === "workspace_invitation_created");
    expect(createdInvitationNotification).toMatchObject({
      data: {
        invitation_id: invitation.id,
        invited_to_workspace_id: 1,
        invited_to_workspace_name: "Workspace",
      },
      sender: {
        id: 7,
        username: "owner@example.com",
        first_name: "Owner",
      },
      read: false,
    });

    const markInvitationRead = await api(env, ctx, inviteeToken, `/api/notifications/${createdInvitationNotification.id}/mark-as-read/`, { method: "PATCH" });
    expect(markInvitationRead.status).toBe(200);
    expect(await markInvitationRead.json()).toMatchObject({ id: createdInvitationNotification.id, read: true });

    const acceptResponse = await api(env, ctx, inviteeToken, `/api/workspaces/invitations/${invitation.token}/accept/`, { method: "POST" });
    expect(acceptResponse.status).toBe(200);
    const ownerAfterAccept = await api(env, ctx, token, "/api/notifications/1/");
    expect(ownerAfterAccept.status).toBe(200);
    const ownerAcceptPayload = await ownerAfterAccept.json() as any;
    expect(ownerAcceptPayload.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "workspace_invitation_accepted",
        data: expect.objectContaining({ invitation_id: invitation.id, invited_to_workspace_id: 1 }),
        sender: expect.objectContaining({ id: 9, first_name: "Invitee" }),
      }),
    ]));

    const rejectInviteResponse = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "rejector@example.com", permissions: "MEMBER" }),
    });
    expect(rejectInviteResponse.status).toBe(201);
    const rejectInvitation = await rejectInviteResponse.json() as any;
    const rejectResponse = await api(env, ctx, rejectorToken, `/api/workspaces/invitations/${rejectInvitation.id}/reject/`, { method: "POST" });
    expect(rejectResponse.status).toBe(200);
    const ownerAfterReject = await api(env, ctx, token, "/api/notifications/1/");
    expect(ownerAfterReject.status).toBe(200);
    const ownerRejectPayload = await ownerAfterReject.json() as any;
    expect(ownerRejectPayload.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "workspace_invitation_rejected",
        data: expect.objectContaining({ invitation_id: rejectInvitation.id, invited_to_workspace_id: 1 }),
        sender: expect.objectContaining({ id: 10, first_name: "Rejector" }),
      }),
    ]));

    const clearWorkspaceNotifications = await api(env, ctx, memberToken, "/api/notifications/1/", { method: "DELETE" });
    expect(clearWorkspaceNotifications.status).toBe(204);
    const memberAfterClear = await api(env, ctx, memberToken, "/api/notifications/1/");
    expect(memberAfterClear.status).toBe(200);
    expect((await memberAfterClear.json() as any).results.some((item: any) => item.id === broadcast.id)).toBe(false);
  });

  it("records enterprise audit events for structural workspace, application, table, field and view changes", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();

    const workspaceCreate = await api(env, ctx, token, "/api/workspaces/", {
      method: "POST",
      body: JSON.stringify({ name: "Audit workspace" }),
    });
    expect(workspaceCreate.status).toBe(200);
    const workspace = await workspaceCreate.json() as any;
    const workspaceUpdate = await api(env, ctx, token, `/api/workspaces/${workspace.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Audit workspace renamed" }),
    });
    expect(workspaceUpdate.status).toBe(200);
    const workspaceDelete = await api(env, ctx, token, `/api/workspaces/${workspace.id}/`, { method: "DELETE" });
    expect(workspaceDelete.status).toBe(200);

    const appCreate = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Audit database", type: "database", init_with_data: false }),
    });
    expect(appCreate.status).toBe(200);
    const app = await appCreate.json() as any;
    const appUpdate = await api(env, ctx, token, `/api/applications/${app.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Audit database renamed" }),
    });
    expect(appUpdate.status).toBe(200);

    const tableCreate = await api(env, ctx, token, `/api/database/tables/database/${app.id}/`, {
      method: "POST",
      body: JSON.stringify({ name: "Audit table" }),
    });
    expect(tableCreate.status).toBe(200);
    const table = await tableCreate.json() as any;
    const tableUpdate = await api(env, ctx, token, `/api/database/tables/${table.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Audit table renamed" }),
    });
    expect(tableUpdate.status).toBe(200);

    const fieldCreate = await api(env, ctx, token, `/api/database/fields/table/${table.id}/`, {
      method: "POST",
      body: JSON.stringify({ name: "Audit field", type: "text" }),
    });
    expect(fieldCreate.status).toBe(200);
    const field = await fieldCreate.json() as any;
    const fieldUpdate = await api(env, ctx, token, `/api/database/fields/${field.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Audit field renamed", type: "long_text" }),
    });
    expect(fieldUpdate.status).toBe(200);

    const viewCreate = await api(env, ctx, token, `/api/database/views/table/${table.id}/`, {
      method: "POST",
      body: JSON.stringify({ name: "Audit gallery", type: "gallery" }),
    });
    expect(viewCreate.status).toBe(200);
    const view = await viewCreate.json() as any;
    const viewUpdate = await api(env, ctx, token, `/api/database/views/${view.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Audit gallery renamed" }),
    });
    expect(viewUpdate.status).toBe(200);
    const viewDelete = await api(env, ctx, token, `/api/database/views/${view.id}/`, { method: "DELETE" });
    expect(viewDelete.status).toBe(200);

    const fieldDelete = await api(env, ctx, token, `/api/database/fields/${field.id}/`, { method: "DELETE" });
    expect(fieldDelete.status).toBe(200);
    const tableDelete = await api(env, ctx, token, `/api/database/tables/${table.id}/`, { method: "DELETE" });
    expect(tableDelete.status).toBe(200);
    const appDelete = await api(env, ctx, token, `/api/applications/${app.id}/`, { method: "DELETE" });
    expect(appDelete.status).toBe(200);

    const auditRows = await db.prepare(
      `SELECT type, action_object_type, action_object_id, action_params
         FROM enterprise_auditlogentry
        WHERE user_id=7
        ORDER BY id ASC`
    ).all<any>();
    const events = auditRows.results || [];
    expect(events.map((entry) => entry.type)).toEqual([
      "workspace.create",
      "workspace.update",
      "workspace.delete",
      "application.create",
      "application.update",
      "database.table.create",
      "database.table.update",
      "database.field.create",
      "database.field.update",
      "database.view.create",
      "database.view.update",
      "database.view.delete",
      "database.field.delete",
      "database.table.delete",
      "application.delete",
    ]);

    const fieldUpdateAudit = events.find((entry) => entry.type === "database.field.update");
    expect(fieldUpdateAudit).toMatchObject({ action_object_type: "field", action_object_id: field.id });
    expect(JSON.parse(fieldUpdateAudit.action_params)).toMatchObject({
      table_id: table.id,
      field_id: field.id,
      field_name: "Audit field renamed",
      field_type: "long_text",
      before: { name: "Audit field", type: "text" },
      after: { name: "Audit field renamed", type: "long_text" },
    });

    const auditEndpoint = await api(env, ctx, token, "/api/audit-log/?workspace_id=1&size=50");
    expect(auditEndpoint.status).toBe(200);
    const payload = await auditEndpoint.json() as any;
    expect(payload.results.map((entry: any) => entry.type)).toContain("database.view.delete");
    expect(payload.results.find((entry: any) => entry.type === "database.table.create")?.description).toContain("Created table");
  });

  it("records enterprise audit events for teams, role assignments, field permissions, invitations and workspace users", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_account_email_allowlist (kind, normalized_value, created_by_id, created_on)
       VALUES ('domain', 'example.com', 7, ?)`
    ).bind(now).run();
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (9, '', 'invitee@example.com', 'Invitee', 'User', 'invitee@example.com', 0, 1, ?),
              (10, '', 'reject@example.com', 'Reject', 'User', 'reject@example.com', 0, 1, ?)`
    ).bind(now, now).run();
    const inviteeToken = await signAccessToken({ user_id: 9, email: "invitee@example.com", username: "invitee@example.com" }, "test-secret", 60);
    const rejectToken = await signAccessToken({ user_id: 10, email: "reject@example.com", username: "reject@example.com" }, "test-secret", 60);

    const teamCreate = await api(env, ctx, token, "/api/teams/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Audit team", default_role: "VIEWER" }),
    });
    expect(teamCreate.status).toBe(200);
    const team = await teamCreate.json() as any;
    const teamUpdate = await api(env, ctx, token, `/api/teams/${team.id}/`, {
      method: "PUT",
      body: JSON.stringify({ name: "Audit team renamed", default_role: "EDITOR" }),
    });
    expect(teamUpdate.status).toBe(200);
    const subjectCreate = await api(env, ctx, token, `/api/teams/${team.id}/subjects/`, {
      method: "POST",
      body: JSON.stringify({ subject_id: 8, subject_type: "auth.User" }),
    });
    expect(subjectCreate.status).toBe(200);
    const subject = await subjectCreate.json() as any;
    const subjectDelete = await api(env, ctx, token, `/api/teams/${team.id}/subjects/${subject.id}/`, { method: "DELETE" });
    expect(subjectDelete.status).toBe(204);

    const roleAssign = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({ subject_id: 8, subject_type: "auth.User", scope_id: 20, scope_type: "table", role: "BUILDER" }),
    });
    expect(roleAssign.status).toBe(200);
    const roleRemove = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({ subject_id: 8, subject_type: "auth.User", scope_id: 20, scope_type: "table", role: null }),
    });
    expect(roleRemove.status).toBe(204);

    const fieldPermission = await api(env, ctx, token, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "NOBODY", allow_in_forms: false }),
    });
    expect(fieldPermission.status).toBe(200);

    const generativeSettings = await api(env, ctx, token, "/api/workspaces/1/settings/generative-ai/", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true, models: { test: true }, default_model: "test" }),
    });
    expect(generativeSettings.status).toBe(200);

    const invitationCreate = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "invitee@example.com", permissions: "MEMBER", message: "Join" }),
    });
    expect(invitationCreate.status).toBe(201);
    const invitation = await invitationCreate.json() as any;
    const invitationAccept = await api(env, ctx, inviteeToken, `/api/workspaces/invitations/${invitation.token}/accept/`, { method: "POST" });
    expect(invitationAccept.status).toBe(200);

    const workspaceUserUpdate = await api(env, ctx, token, "/api/workspaces/1/users/9/", {
      method: "PATCH",
      body: JSON.stringify({ permissions: "VIEWER" }),
    });
    expect(workspaceUserUpdate.status).toBe(200);
    const workspaceUserDelete = await api(env, ctx, token, "/api/workspaces/1/users/9/", { method: "DELETE" });
    expect(workspaceUserDelete.status).toBe(200);

    const rejectInvitationCreate = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "reject@example.com", permissions: "VIEWER", message: "Reject" }),
    });
    expect(rejectInvitationCreate.status).toBe(201);
    const rejectInvitation = await rejectInvitationCreate.json() as any;
    const invitationPatch = await api(env, ctx, token, `/api/workspaces/invitations/${rejectInvitation.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ permissions: "MEMBER", message: "Updated reject" }),
    });
    expect(invitationPatch.status).toBe(200);
    const invitationReject = await api(env, ctx, rejectToken, `/api/workspaces/invitations/${rejectInvitation.id}/reject/`, { method: "POST" });
    expect(invitationReject.status).toBe(200);

    const deleteInvitationCreate = await api(env, ctx, token, "/api/workspaces/invitations/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ email: "delete@example.com", permissions: "VIEWER", message: "Delete" }),
    });
    expect(deleteInvitationCreate.status).toBe(201);
    const deleteInvitation = await deleteInvitationCreate.json() as any;
    const invitationDelete = await api(env, ctx, token, `/api/workspaces/invitations/${deleteInvitation.id}/`, { method: "DELETE" });
    expect(invitationDelete.status).toBe(200);

    const teamDelete = await api(env, ctx, token, `/api/teams/${team.id}/`, { method: "DELETE" });
    expect(teamDelete.status).toBe(204);

    const auditRows = await db.prepare(
      `SELECT type, action_object_type, action_object_id, action_params
         FROM enterprise_auditlogentry
        WHERE user_id IN (7, 9, 10)
        ORDER BY id ASC`
    ).all<any>();
    const events = auditRows.results || [];
    expect(events.map((entry) => entry.type)).toEqual([
      "enterprise.team.create",
      "enterprise.team.update",
      "enterprise.team_subject.create",
      "enterprise.team_subject.delete",
      "enterprise.role_assignment.create",
      "enterprise.role_assignment.delete",
      "enterprise.field_permission.update",
      "workspace.generative_ai_settings.update",
      "workspace.invitation.create",
      "workspace.invitation.accept",
      "workspace.user.update",
      "workspace.user.delete",
      "workspace.invitation.create",
      "workspace.invitation.update",
      "workspace.invitation.reject",
      "workspace.invitation.create",
      "workspace.invitation.delete",
      "enterprise.team.delete",
    ]);

    const roleAudit = events.find((entry) => entry.type === "enterprise.role_assignment.create");
    expect(JSON.parse(roleAudit.action_params)).toMatchObject({
      subject_id: 8,
      scope_id: 20,
      scope_type: "table",
      role: "BUILDER",
    });
    const fieldPermissionAudit = events.find((entry) => entry.type === "enterprise.field_permission.update");
    expect(fieldPermissionAudit).toMatchObject({ action_object_type: "field_permission", action_object_id: 30 });
    expect(JSON.parse(fieldPermissionAudit.action_params)).toMatchObject({
      field_id: 30,
      field_name: "Name",
      after: { role: "NOBODY", allow_in_forms: false, can_write_values: false },
    });
    const inviteAcceptAudit = events.find((entry) => entry.type === "workspace.invitation.accept");
    expect(inviteAcceptAudit).toMatchObject({ action_object_type: "workspace_invitation", action_object_id: invitation.id });
    expect(JSON.parse(inviteAcceptAudit.action_params)).toMatchObject({ email: "invitee@example.com", user_id: 9 });
  });

  it("records audit events for auth, user, admin settings, auth providers and jobs", async () => {
    const { db, env, token, ctx } = await setupEnterpriseApiFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (11, '', 'admin-target@example.com', 'Admin', 'Target', 'admin-target@example.com', 0, 1, ?)`
    ).bind(now).run();
    await db.prepare(
      `INSERT INTO core_account_email_allowlist (kind, normalized_value, created_by_id, created_on)
       VALUES ('domain', 'example.com', 7, ?)`
    ).bind(now).run();
    await db.prepare(
      `INSERT INTO core_workspaceinvitation
       (workspace_id, invited_by_id, email, permissions, message, token, created_on)
       VALUES (1, 7, 'audit-user@example.com', 'VIEWER', '', 'audit-user-invite', ?)`
    ).bind(now).run();

    const register = await worker.fetch(new Request("https://api.supertask.test/api/user/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Audit User",
        email: "audit-user@example.com",
        password: "Password123!",
        language: "en",
        workspace_invitation_token: "audit-user-invite",
      }),
    }), env, ctx);
    expect(register.status).toBe(201);
    const registered = await register.json() as any;
    const registeredToken = registered.access_token;
    const refreshToken = registered.refresh_token;
    expect(registered.user.email).toBe("audit-user@example.com");

    const login = await worker.fetch(new Request("https://api.supertask.test/api/user/token-auth/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "audit-user@example.com", password: "Password123!" }),
    }), env, ctx);
    expect(login.status).toBe(200);

    const account = await api(env, ctx, registeredToken, "/api/user/account/", {
      method: "PATCH",
      body: JSON.stringify({ first_name: "Audit", last_name: "Renamed", timezone: "Europe/Zurich" }),
    });
    expect(account.status).toBe(200);

    const passwordChange = await api(env, ctx, registeredToken, "/api/user/change-password/", {
      method: "POST",
      body: JSON.stringify({ old_password: "Password123!", new_password: "Password1234!" }),
    });
    expect(passwordChange.status).toBe(204);

    const resetRequest = await worker.fetch(new Request("https://api.supertask.test/api/user/send-reset-password-email/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "audit-user@example.com" }),
    }), env, ctx);
    expect(resetRequest.status).toBe(204);
    const resetToken = await db.prepare("SELECT token FROM core_passwordreset WHERE email=?").bind("audit-user@example.com").first<{ token: string }>();
    const reset = await worker.fetch(new Request("https://api.supertask.test/api/user/reset-password/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: resetToken?.token, password: "Password12345!" }),
    }), env, ctx);
    expect(reset.status).toBe(204);

    const emailChangeRequest = await api(env, ctx, registeredToken, "/api/user/send-change-email-confirmation/", {
      method: "POST",
      body: JSON.stringify({ new_email: "audit-user-renamed@example.com", password: "Password12345!" }),
    });
    expect(emailChangeRequest.status).toBe(204);
    const emailChangeToken = await db.prepare("SELECT token FROM core_emailchange WHERE user_id=?").bind(registered.user.id).first<{ token: string }>();
    const emailChange = await worker.fetch(new Request("https://api.supertask.test/api/user/change-email/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: emailChangeToken?.token }),
    }), env, ctx);
    expect(emailChange.status).toBe(204);

    await db.prepare("UPDATE core_userprofile SET email_verified=0 WHERE user_id=?").bind(registered.user.id).run();
    const verifyRequest = await worker.fetch(new Request("https://api.supertask.test/api/user/send-verify-email/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "audit-user-renamed@example.com" }),
    }), env, ctx);
    expect(verifyRequest.status).toBe(204);
    const verifyToken = await db.prepare("SELECT token FROM core_emailverification WHERE user_id=?").bind(registered.user.id).first<{ token: string }>();
    const verify = await worker.fetch(new Request("https://api.supertask.test/api/user/verify-email/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: verifyToken?.token }),
    }), env, ctx);
    expect(verify.status).toBe(200);

    const tokenRefresh = await worker.fetch(new Request("https://api.supertask.test/api/user/token-refresh/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }), env, ctx);
    expect(tokenRefresh.status).toBe(200);
    const logout = await worker.fetch(new Request("https://api.supertask.test/api/user/token-blacklist/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }), env, ctx);
    expect(logout.status).toBe(204);

    const scheduleDeletion = await api(env, ctx, registeredToken, "/api/user/schedule-account-deletion/", { method: "POST" });
    expect(scheduleDeletion.status).toBe(204);
    const onboarding = await api(env, ctx, registeredToken, "/api/user/share-onboarding-details-with-baserow/", {
      method: "POST",
      body: JSON.stringify({ team: "Product", role: "Builder", size: "1-10", country: "CH", how: "Search" }),
    });
    expect(onboarding.status).toBe(204);

    const settingsUpdate = await api(env, ctx, token, "/api/settings/update/", {
      method: "PATCH",
      body: JSON.stringify({ allow_new_signups: false, email_verification: "recommended" }),
    });
    expect(settingsUpdate.status).toBe(200);

    const authProviderCreate = await api(env, ctx, token, "/api/admin/auth-provider/", {
      method: "POST",
      body: JSON.stringify({ type: "google", name: "Audit Google", client_id: "client", secret: "secret", enabled: true }),
    });
    expect(authProviderCreate.status).toBe(200);
    const provider = await authProviderCreate.json() as any;
    const authProviderUpdate = await api(env, ctx, token, `/api/admin/auth-provider/${provider.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Audit Google Renamed", enabled: false }),
    });
    expect(authProviderUpdate.status).toBe(200);
    const authProviderDelete = await api(env, ctx, token, `/api/admin/auth-provider/${provider.id}/`, { method: "DELETE" });
    expect(authProviderDelete.status).toBe(204);

    const adminUserUpdate = await api(env, ctx, token, "/api/admin/users/11/", {
      method: "PATCH",
      body: JSON.stringify({ first_name: "Admin", last_name: "Updated", is_active: false }),
    });
    expect(adminUserUpdate.status).toBe(200);
    const adminImpersonate = await api(env, ctx, token, "/api/admin/users/impersonate/", {
      method: "POST",
      body: JSON.stringify({ user: 11 }),
    });
    expect(adminImpersonate.status).toBe(200);
    const adminUserDelete = await api(env, ctx, token, "/api/admin/users/11/", { method: "DELETE" });
    expect(adminUserDelete.status).toBe(200);

    const jobCreate = await api(env, ctx, token, "/api/jobs/", {
      method: "POST",
      body: JSON.stringify({
        type: "airtable",
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/shrAuditBase",
        session: "session",
        session_signature: "signature",
      }),
    });
    expect(jobCreate.status).toBe(202);
    const job = await jobCreate.json() as any;
    const jobCancel = await api(env, ctx, token, `/api/jobs/${job.id}/cancel/`, { method: "POST" });
    expect(jobCancel.status).toBe(200);

    const workspace = await db.prepare(
      "INSERT INTO core_workspace (name, created_on, storage_usage, seats_taken) VALUES ('Admin audit workspace', ?, 0, 0) RETURNING id"
    ).bind(now).first<{ id: number }>();
    const adminWorkspaceDelete = await api(env, ctx, token, `/api/admin/workspaces/${workspace?.id}/`, { method: "DELETE" });
    expect(adminWorkspaceDelete.status).toBe(200);

    const auditRows = await db.prepare(
      `SELECT type, action_object_type, action_object_id, action_params
         FROM enterprise_auditlogentry
        ORDER BY id ASC`
    ).all<any>();
    const events = auditRows.results || [];
    expect(events.map((entry) => entry.type)).toEqual(expect.arrayContaining([
      "user.create",
      "auth.login",
      "user.update",
      "user.password.change",
      "user.password.reset_request",
      "user.password.reset",
      "user.email_change.request",
      "user.email_change.confirm",
      "user.email_verification.request",
      "user.email_verification.confirm",
      "auth.token_refresh",
      "auth.logout",
      "user.account_deletion.schedule",
      "user.onboarding.update",
      "admin.settings.update",
      "admin.auth_provider.create",
      "admin.auth_provider.update",
      "admin.auth_provider.delete",
      "admin.user.update",
      "admin.user.impersonate",
      "admin.user.delete",
      "job.create",
      "job.cancel",
      "admin.workspace.delete",
    ]));
    const settingsAudit = events.find((entry) => entry.type === "admin.settings.update");
    expect(JSON.parse(settingsAudit.action_params)).toMatchObject({
      changed_fields: ["email_verification"],
    });
    const jobAudit = events.find((entry) => entry.type === "job.create");
    expect(jobAudit).toMatchObject({ action_object_type: "job", action_object_id: job.id });
    expect(JSON.parse(jobAudit.action_params)).toMatchObject({ job_type: "airtable", workspace_id: 1 });
    const providerAudit = events.find((entry) => entry.type === "admin.auth_provider.create");
    expect(JSON.parse(providerAudit.action_params)).toMatchObject({ provider_type: "google", enabled: true });
  });

  it("enforces enterprise field permissions on row writes", async () => {
    const { env, ctx, token, memberToken } = await setupEnterpriseApiFixture();

    const adminOnly = await api(env, ctx, token, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "ADMIN", allow_in_forms: true }),
    });
    expect(adminOnly.status).toBe(200);

    const memberCreateDenied = await api(env, ctx, memberToken, "/api/database/rows/table/20/", {
      method: "POST",
      body: JSON.stringify({ field_30: "member blocked" }),
    });
    expect(memberCreateDenied.status).toBe(403);

    const ownerCreate = await api(env, ctx, token, "/api/database/rows/table/20/", {
      method: "POST",
      body: JSON.stringify({ field_30: "owner allowed" }),
    });
    expect(ownerCreate.status).toBe(200);
    const row = await ownerCreate.json() as any;

    const memberPatchDenied = await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ field_30: "member blocked again" }),
    });
    expect(memberPatchDenied.status).toBe(403);

    const fieldScopedRole = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 30,
        scope_type: "field",
        role: "ADMIN",
      }),
    });
    expect(fieldScopedRole.status).toBe(200);
    const memberPatchWithFieldRole = await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ field_30: "member allowed by field role" }),
    });
    expect(memberPatchWithFieldRole.status).toBe(200);
    expect(await memberPatchWithFieldRole.json()).toMatchObject({ field_30: "member allowed by field role" });

    const fieldScopedRoleRemove = await api(env, ctx, token, "/api/role/1/", {
      method: "POST",
      body: JSON.stringify({
        subject_id: 8,
        subject_type: "auth.User",
        scope_id: 30,
        scope_type: "field",
        role: null,
      }),
    });
    expect(fieldScopedRoleRemove.status).toBe(204);

    const editorAllowed = await api(env, ctx, token, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "EDITOR", allow_in_forms: true }),
    });
    expect(editorAllowed.status).toBe(200);
    const memberPatchAllowed = await api(env, ctx, memberToken, `/api/database/rows/table/20/${row.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ field_30: "member allowed" }),
    });
    expect(memberPatchAllowed.status).toBe(200);
    expect(await memberPatchAllowed.json()).toMatchObject({ field_30: "member allowed" });

    const nobody = await api(env, ctx, token, "/api/field-permissions/30/", {
      method: "PATCH",
      body: JSON.stringify({ role: "NOBODY", allow_in_forms: true }),
    });
    expect(nobody.status).toBe(200);
    const ownerPatchDenied = await api(env, ctx, token, `/api/database/rows/table/20/${row.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ field_30: "owner blocked by nobody" }),
    });
    expect(ownerPatchDenied.status).toBe(403);
  });
});
