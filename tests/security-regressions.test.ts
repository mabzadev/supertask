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

  it("keeps hidden fields out of public view search, filters and ordering", async () => {
    const { db, call, json, alice, a } = await twoTenants();
    const secret = await json(await call(`/api/database/fields/table/${a.table.id}/`, {
      method: "POST", headers: alice, body: JSON.stringify({ name: "Secret", type: "text" }),
    }));
    await json(await call(`/api/database/rows/table/${a.table.id}/`, {
      method: "POST", headers: alice, body: JSON.stringify({ [`field_${a.primary.id}`]: "Public row", [`field_${secret.id}`]: "s3cr3t" }),
    }));
    const view = db.database.prepare("SELECT id, slug FROM database_view WHERE table_id=?").get(a.table.id) as any;
    db.database.prepare("UPDATE database_view SET public=1 WHERE id=?").run(view.id);
    db.database.prepare("DELETE FROM database_gridviewfieldoptions WHERE grid_view_id=?").run(view.id);
    db.database.prepare("INSERT INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order]) VALUES (?, ?, 200, 0, 1), (?, ?, 200, 1, 2)")
      .run(view.id, a.primary.id, view.id, secret.id);

    const base = `/api/database/views/grid/${view.slug}/public/rows/`;
    const all = await json(await call(base));
    expect(all.count).toBeGreaterThan(0);
    expect(all.results[0][`field_${secret.id}`]).toBeUndefined();
    expect((await json(await call(`${base}?search=s3cr3t`))).count).toBe(0);
    const guessed = await json(await call(`${base}?filter__field_${secret.id}__equal=wrong-guess`));
    expect(guessed.count).toBe(all.count);
  });

  it("only sends email links to the web frontend host", async () => {
    const { db, call } = await twoTenants();
    const evil = await call("/api/user/send-reset-password-email/", {
      method: "POST", body: JSON.stringify({ email: "alice@supertask.test", base_url: "https://evil.example/reset-password" }),
    });
    expect(evil.status).toBe(400);
    expect(await evil.json()).toMatchObject({ error: "ERROR_HOSTNAME_IS_NOT_ALLOWED" });
    const own = await call("/api/user/send-reset-password-email/", {
      method: "POST", body: JSON.stringify({ email: "alice@supertask.test", base_url: "https://web.supertask.test/reset-password" }),
    });
    expect(own.status).toBe(204);
    const verify = await call("/api/user/send-verify-email/", {
      method: "POST", body: JSON.stringify({ email: "alice@supertask.test", base_url: "https://evil.example/verify" }),
    });
    expect(verify.status).toBe(400);

    db.database.prepare("UPDATE core_settings SET allow_reset_password=0 WHERE id=1").run();
    const disabled = await call("/api/user/send-reset-password-email/", {
      method: "POST", body: JSON.stringify({ email: "alice@supertask.test" }),
    });
    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toMatchObject({ error: "ERROR_DISABLED_RESET_PASSWORD" });
  });

  it("keeps removed members out after a workspace restore and guards the last admin", async () => {
    const { db, call, json, alice, a } = await twoTenants();
    insertUser(db, 3, "bob@supertask.test");
    db.database.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted) VALUES (?, 3, 2, 'MEMBER', 0)")
      .run(a.workspace.id);
    const bob = { Authorization: `JWT ${await accessToken(3, "bob@supertask.test")}` };
    const aliceMembership = db.database.prepare("SELECT id FROM core_workspaceuser WHERE user_id=1 AND workspace_id=?").get(a.workspace.id) as any;
    const bobMembership = db.database.prepare("SELECT id FROM core_workspaceuser WHERE user_id=3").get() as any;

    const selfRemoval = await call(`/api/workspaces/users/${aliceMembership.id}/`, { method: "DELETE", headers: alice });
    expect(await selfRemoval.json()).toMatchObject({ error: "ERROR_CANNOT_DELETE_YOURSELF_FROM_GROUP" });
    const demoteLastAdmin = await call(`/api/workspaces/users/${aliceMembership.id}/`, {
      method: "PATCH", headers: alice, body: JSON.stringify({ permissions: "VIEWER" }),
    });
    expect(await demoteLastAdmin.json()).toMatchObject({ error: "ERROR_LAST_ADMIN_OF_GROUP" });
    const invalidRole = await call(`/api/workspaces/users/${bobMembership.id}/`, {
      method: "PATCH", headers: alice, body: JSON.stringify({ permissions: "SUPERUSER" }),
    });
    expect(invalidRole.status).toBe(400);

    expect((await call(`/api/workspaces/users/${bobMembership.id}/`, { method: "DELETE", headers: alice })).status).toBe(200);
    expect((await call(`/api/workspaces/${a.workspace.id}/`, { method: "DELETE", headers: alice })).status).toBeLessThan(300);
    await json(await call("/api/trash/restore/", {
      method: "PATCH", headers: alice, body: JSON.stringify({ trash_item_type: "workspace", trash_item_id: a.workspace.id }),
    }));
    expect((await call(`/api/database/rows/table/${a.table.id}/`, { headers: alice })).status).toBe(200);
    expect((await call(`/api/database/rows/table/${a.table.id}/`, { headers: bob })).status).toBe(403);
  });

  it("checks trash permissions before touching trash entries and never destroys live items", async () => {
    const { db, call, mallory, alice, a } = await twoTenants();
    db.database.prepare("UPDATE core_application SET trashed=1 WHERE id=?").run(a.database.id);
    const restore = await call("/api/trash/restore/", {
      method: "PATCH", headers: mallory, body: JSON.stringify({ trash_item_type: "application", trash_item_id: a.database.id }),
    });
    expect(restore.status).toBe(403);
    expect(db.database.prepare("SELECT COUNT(*) AS count FROM core_trasheditem WHERE trash_item_id=?").get(a.database.id)).toMatchObject({ count: 0 });
    db.database.prepare("UPDATE core_application SET trashed=0 WHERE id=?").run(a.database.id);

    const destroyLive = await call(`/api/trash/table/${a.table.id}/`, { method: "DELETE", headers: alice });
    expect(destroyLive.status).toBe(404);
    expect((await call(`/api/database/rows/table/${a.table.id}/`, { headers: alice })).status).toBe(200);
  });

  it("stores public view passwords hashed and still accepts the right one", async () => {
    const { db, call, json, alice, a } = await twoTenants();
    const view = db.database.prepare("SELECT id, slug FROM database_view WHERE table_id=?").get(a.table.id) as any;
    await json(await call(`/api/database/views/${view.id}/`, {
      method: "PATCH", headers: alice, body: JSON.stringify({ public: true, public_view_password: "s3cret-pass" }),
    }));
    const stored = db.database.prepare("SELECT public_view_password FROM database_view WHERE id=?").get(view.id) as any;
    expect(stored.public_view_password).not.toContain("s3cret-pass");
    expect(stored.public_view_password).toMatch(/^pbkdf2_sha256\$/);

    const wrong = await call(`/api/database/views/${view.slug}/public/auth/`, { method: "POST", body: JSON.stringify({ password: "nope" }) });
    expect(wrong.status).toBe(401);
    const right = await call(`/api/database/views/${view.slug}/public/auth/`, { method: "POST", body: JSON.stringify({ password: "s3cret-pass" }) });
    expect(right.status).toBe(200);
    const { access_token: viewToken } = await right.json() as any;
    const rows = await call(`/api/database/views/grid/${view.slug}/public/rows/`, { headers: { "Baserow-View-Authorization": `JWT ${viewToken}` } });
    expect(rows.status).toBe(200);
  });
});

