import { describe, expect, it, vi } from "vitest";
import { accessToken, apiClient, createEnv, createTestD1, insertUser } from "./helpers/worker-harness";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

/** Two tenants: Alice owns workspace A, Mallory owns workspace B and attacks A. */
async function twoTenants() {
  const db = createTestD1();
  const env = createEnv(db);
  const call = apiClient(env);
  insertUser(db, 1, "alice@supertask.test");
  insertUser(db, 2, "mallory@supertask.test");
  const alice = { Authorization: `JWT ${await accessToken(1, "alice@supertask.test")}` };
  const mallory = { Authorization: `JWT ${await accessToken(2, "mallory@supertask.test")}` };
  const json = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json() as Promise<any>;
  };
  const setup = async (headers: Record<string, string>, name: string) => {
    const workspace = await json(await call("/api/workspaces/", { method: "POST", headers, body: JSON.stringify({ name }) }));
    const database = await json(await call(`/api/applications/workspace/${workspace.id}/`, {
      method: "POST", headers, body: JSON.stringify({ name: `${name} base`, type: "database" }),
    }));
    const table = await json(await call(`/api/database/tables/database/${database.id}/`, {
      method: "POST", headers, body: JSON.stringify({ name: `${name} table` }),
    }));
    const fields = await json(await call(`/api/database/fields/table/${table.id}/`, { headers }));
    const primary = fields.find((field: any) => field.primary);
    return { workspace, database, table, fields, primary };
  };
  const a = await setup(alice, "A");
  const b = await setup(mallory, "B");
  return { db, env, call, json, alice, mallory, a, b };
}

describe("security regressions", () => {
  it("never interpolates filter_type into SQL", async () => {
    const { call, json, alice, a } = await twoTenants();
    const field = `filter__field_${a.primary.id}__contains`;
    const injected = encodeURIComponent("OR (SELECT COUNT(*) FROM auth_user) > 0 OR");
    const base = `/api/database/rows/table/${a.table.id}/?${field}=zzz-no-match&${field.replace("contains", "contains_not")}=zzz`;
    await json(await call(`/api/database/rows/table/${a.table.id}/`, {
      method: "POST", headers: alice, body: JSON.stringify({ [`field_${a.primary.id}`]: "visible" }),
    }));
    const plain = await json(await call(base, { headers: alice }));
    const attacked = await json(await call(`${base}&filter_type=${injected}`, { headers: alice }));
    expect(attacked.count).toBe(plain.count);
    expect(attacked.count).toBe(0);
  });

  it("keeps the public slug off the member-only view routes", async () => {
    const { db, call, a } = await twoTenants();
    const view = db.database.prepare("SELECT id, slug FROM database_view WHERE table_id=?").get(a.table.id) as any;
    db.database.prepare("UPDATE database_view SET public=1, public_view_password='secret' WHERE id=?").run(view.id);
    const byRows = await call(`/api/database/views/grid/${view.slug}/`, { method: "POST", body: JSON.stringify({ row_ids: [1] }) });
    expect(byRows.status).toBe(404);
    expect((await call(`/api/database/views/grid/${view.slug}/aggregations/`)).status).toBe(404);
    expect((await call(`/api/database/views/grid/${view.slug}/public/rows/`)).status).toBe(401);
  });

  it("checks table access on formula endpoints and rejects non-integer ids", async () => {
    const { call, mallory, a } = await twoTenants();
    const evaluate = await call("/api/database/formula/evaluate/", {
      method: "POST", headers: mallory, body: JSON.stringify({ formula: "field('Name')", table_id: a.table.id, row_id: 1 }),
    });
    expect(evaluate.status).toBe(403);
    const injected = await call("/api/database/formula/evaluate/", {
      method: "POST", headers: mallory, body: JSON.stringify({ formula: "1", table_id: `${a.table.id}" WHERE 1=1 --`, row_id: 1 }),
    });
    expect(injected.status).toBe(404);
    const type = await call(`/api/database/formula/${a.table.id}/type/`, {
      method: "POST", headers: mallory, body: JSON.stringify({ formula: "field('Name')" }),
    });
    expect(type.status).toBe(403);
  });

  it("does not expose auth provider secrets", async () => {
    const { call } = await twoTenants();
    expect((await call("/api/auth-provider/")).status).toBe(404);
    expect((await call("/api/auth-provider/login-options/")).status).toBe(200);
  });

  it("only queues permission-checked jobs", async () => {
    const { call, mallory, a } = await twoTenants();
    const raw = await call("/api/jobs/", {
      method: "POST", headers: mallory, body: JSON.stringify({ type: "export_applications", workspace_id: a.workspace.id }),
    });
    expect(raw.status).toBe(400);
    expect(await raw.json()).toMatchObject({ error: "ERROR_JOB_TYPE_DOES_NOT_EXIST" });
    const exportForeign = await call("/api/jobs/export-table/", {
      method: "POST", headers: mallory, body: JSON.stringify({ table_id: a.table.id }),
    });
    expect(exportForeign.status).toBe(403);
  });

  it("rejects field ids from another table when ordering fields", async () => {
    const { call, mallory, a, b } = await twoTenants();
    const response = await call(`/api/database/fields/table/${b.table.id}/order/`, {
      method: "POST", headers: mallory, body: JSON.stringify({ field_ids: [a.primary.id, b.primary.id] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "ERROR_FIELD_NOT_IN_TABLE" });
  });

  it("skips undo once the user lost access to the table", async () => {
    const { db, call, json, alice, a } = await twoTenants();
    insertUser(db, 3, "bob@supertask.test");
    db.database.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted) VALUES (?, 3, 2, 'MEMBER', 0)")
      .run(a.workspace.id);
    const bob = { Authorization: `JWT ${await accessToken(3, "bob@supertask.test")}`, ClientSessionId: "bob-session" };
    const created = await json(await call(`/api/database/rows/table/${a.table.id}/`, {
      method: "POST", headers: bob, body: JSON.stringify({ [`field_${a.primary.id}`]: "kept" }),
    }));

    db.database.prepare("UPDATE core_workspaceuser SET to_be_deleted=1 WHERE user_id=3").run();
    const undo = await json(await call("/api/user/undo/", {
      method: "PATCH", headers: bob, body: JSON.stringify({ scopes: { table: a.table.id } }),
    }));
    expect(undo.result_code).toBe("SKIPPED_DUE_TO_ERROR");
    const rows = await json(await call(`/api/database/rows/table/${a.table.id}/`, { headers: alice }));
    expect(rows.results.map((row: any) => row.id)).toContain(created.id);
  });
});
