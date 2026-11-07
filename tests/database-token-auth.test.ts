import { describe, expect, it, vi } from "vitest";
import { getOrCreateUserTable } from "../src/services/dynamic-tables";
import { hashPassword } from "../src/services/user";
import { apiClient, createEnv, createTestD1, insertUser, signTestToken } from "./helpers/worker-harness";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

async function fixture() {
  const db = createTestD1();
  const env = createEnv(db);
  const now = new Date().toISOString();
  insertUser(db, 1, "owner@supertask.test", { staff: true, password: await hashPassword("old-password") });
  db.database.prepare("INSERT INTO core_workspace (id, name, created_on) VALUES (1, 'Équipe', ?)").run(now);
  db.database.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted) VALUES (1, 1, 1, 'ADMIN', 0)").run();
  db.database.prepare(
    "INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on) VALUES (10, 1, 'Base', 'database', 1, 0, ?, ?)"
  ).run(now, now);
  db.database.prepare(
    "INSERT INTO database_table (id, database_id, name, [order], trashed, created_on, updated_on) VALUES (20, 10, 'Tâches', 1, 0, ?, ?)"
  ).run(now, now);
  await getOrCreateUserTable(db as any, 20);
  db.database.prepare("INSERT INTO database_token (id, workspace_id, user_id, name, key, active, created_on) VALUES (5, 1, 1, 'Lecture', 'read-key', 1, ?)").run(now);
  db.database.prepare("INSERT INTO database_tokenpermission (token_id, type, table_id, database_id) VALUES (5, 'read', 20, NULL)").run();

  return { db, env, call: apiClient(env) };
}

describe("database token authentication", () => {
  it("only authenticates the endpoints Supertask opens to database tokens", async () => {
    const { call } = await fixture();
    for (const scheme of ["Token", "Bearer"]) {
      const headers = { Authorization: `${scheme} read-key` };
      expect((await call("/api/database/rows/table/20/", { headers })).status).toBe(200);
      expect((await call("/api/database/fields/table/20/", { headers })).status).toBe(200);
      expect(await (await call("/api/database/tokens/check/", { headers })).json()).toEqual({ token: "OK" });

      expect((await call("/api/user/", { headers })).status).toBe(401);
      expect((await call("/api/database/tokens/", { method: "POST", headers, body: JSON.stringify({ name: "x", workspace: 1 }) })).status).toBe(401);
      expect((await call("/api/workspaces/1/", { method: "DELETE", headers })).status).toBe(401);
    }
  });

  it("enforces token permissions and rejects tokens whose owner left the workspace", async () => {
    const { db, call } = await fixture();
    const headers = { Authorization: "Token read-key" };
    const create = await call("/api/database/rows/table/20/", { method: "POST", headers, body: JSON.stringify({}) });
    expect(create.status).toBe(403);

    expect((await call("/api/database/rows/table/20/", { headers: { Authorization: "Token missing" } })).status).toBe(401);

    db.database.prepare("UPDATE core_workspaceuser SET to_be_deleted=1 WHERE user_id=1").run();
    const removed = await call("/api/database/rows/table/20/", { headers });
    expect(removed.status).toBe(401);
    expect(await removed.json()).toMatchObject({ error: "ERROR_TOKEN_GROUP_MISMATCH" });
  });

  it("rejects the token check with a JWT", async () => {
    const { call } = await fixture();
    const access = await signTestToken({ user_id: 1, email: "owner@supertask.test", token_type: "access" }, Math.floor(Date.now() / 1000));
    expect((await call("/api/database/tokens/check/", { headers: { Authorization: `JWT ${access}` } })).status).toBe(401);
  });
});

describe("password change invalidates earlier tokens", () => {
  it("rejects access and refresh tokens issued before the change", async () => {
    const { call } = await fixture();
    const earlier = Math.floor(Date.now() / 1000) - 60;
    const access = await signTestToken({ user_id: 1, email: "owner@supertask.test", token_type: "access" }, earlier);
    const refresh = await signTestToken({ user_id: 1, email: "owner@supertask.test", token_type: "refresh" }, earlier, "7d");

    expect((await call("/api/user/", { headers: { Authorization: `JWT ${access}` } })).status).toBe(200);
    const change = await call("/api/user/change-password/", {
      method: "POST",
      headers: { Authorization: `JWT ${access}` },
      body: JSON.stringify({ old_password: "old-password", new_password: "new-password" }),
    });
    expect(change.status).toBe(204);

    expect((await call("/api/user/", { headers: { Authorization: `JWT ${access}` } })).status).toBe(401);
    expect((await call("/api/user/token-refresh/", { method: "POST", body: JSON.stringify({ refresh_token: refresh }) })).status).toBe(401);
    expect((await call("/api/user/token-verify/", { method: "POST", body: JSON.stringify({ refresh_token: refresh }) })).status).toBe(401);

    const login = await call("/api/user/token-auth/", {
      method: "POST",
      body: JSON.stringify({ email: "owner@supertask.test", password: "new-password" }),
    });
    expect(login.status).toBe(200);
    const { access_token: fresh } = await login.json() as { access_token: string };
    expect((await call("/api/user/", { headers: { Authorization: `JWT ${fresh}` } })).status).toBe(200);
  });

  it("answers malformed tokens with 401 instead of 500", async () => {
    const { call } = await fixture();
    expect((await call("/api/user/token-verify/", { method: "POST", body: JSON.stringify({ refresh_token: "nope" }) })).status).toBe(401);
    expect((await call("/api/user/token-blacklist/", { method: "POST", body: JSON.stringify({ refresh_token: "nope" }) })).status).toBe(401);
    expect((await call("/api/two-factor-auth/verify/", {
      method: "POST",
      headers: { Authorization: "Bearer nope" },
      body: JSON.stringify({ email: "owner@supertask.test", code: "000000" }),
    })).status).toBe(401);
  });
});
