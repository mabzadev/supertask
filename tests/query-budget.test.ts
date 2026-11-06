import { describe, expect, it, vi } from "vitest";
import { accessToken, apiClient, createCtx, createEnv, createTestD1, insertUser, type QueryCounter } from "./helpers/worker-harness";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

// D1 allows 1,000 queries per Worker invocation (a batch counts as one).
// These budgets keep list and write paths independent of the row count.
const D1_QUERY_LIMIT = 1000;
const ROWS = 200;

async function linkedTableFixture() {
  const counter: QueryCounter = { queries: 0 };
  const db = createTestD1(counter);
  const ctx = createCtx();
  const call = apiClient(createEnv(db), ctx);
  insertUser(db, 1, "owner@supertask.test");
  const headers = { Authorization: `JWT ${await accessToken(1, "owner@supertask.test")}` };
  const json = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json() as Promise<any>;
  };
  const post = (path: string, body: unknown, method = "POST") => call(path, { method, headers, body: JSON.stringify(body) }).then(json);
  const workspace = await post("/api/workspaces/", { name: "Budget" });
  const database = await post(`/api/applications/workspace/${workspace.id}/`, { name: "Base", type: "database" });
  const table = await post(`/api/database/tables/database/${database.id}/`, { name: "Tasks" });
  const target = await post(`/api/database/tables/database/${database.id}/`, { name: "People" });
  const fields = await json(await call(`/api/database/fields/table/${table.id}/`, { headers }));
  const primary = fields.find((field: any) => field.primary);
  const number = await post(`/api/database/fields/table/${table.id}/`, { name: "Points", type: "number" });
  const link = await post(`/api/database/fields/table/${table.id}/`, { name: "Owner", type: "link_row", link_row_table_id: target.id });
  const people = await post(`/api/database/rows/table/${target.id}/batch/`, { items: [{}, {}, {}] });
  await ctx.settle();
  counter.queries = 0;
  const created = await post(`/api/database/rows/table/${table.id}/batch/`, {
    items: Array.from({ length: ROWS }, (_, index) => ({
      [`field_${primary.id}`]: `Task ${index}`,
      [`field_${number.id}`]: index,
      [`field_${link.id}`]: [people.items[index % 3].id],
    })),
  });
  await ctx.settle();
  const createQueries = counter.queries;
  const views = await json(await call(`/api/database/views/table/${table.id}/`, { headers }));
  return { counter, ctx, call, headers, json, post, table, primary, number, link, rows: created.items, viewId: views[0].id, createQueries };
}

/** Queries of one request, including the `waitUntil` work it started. */
async function measured<T>(counter: QueryCounter, ctx: { settle(): Promise<void> }, run: () => Promise<T>) {
  await ctx.settle();
  counter.queries = 0;
  const result = await run();
  await ctx.settle();
  return { result, queries: counter.queries };
}

describe("D1 query budgets", () => {
  it("keeps list endpoints independent of the number of linked rows", async () => {
    const { counter, ctx, call, headers, json, table, viewId } = await linkedTableFixture();
    const grid = await measured(counter, ctx, async () => json(await call(`/api/database/views/grid/${viewId}/?limit=120&include=field_options`, { headers })));
    expect(grid.result.results).toHaveLength(120);
    expect(grid.queries).toBeLessThan(40);

    const list = await measured(counter, ctx, async () => json(await call(`/api/database/rows/table/${table.id}/?size=200`, { headers })));
    expect(list.result.results).toHaveLength(ROWS);
    expect(list.queries).toBeLessThan(40);
  });

  it("creates, updates and deletes a full batch within the per-invocation limit", async () => {
    const { counter, ctx, post, table, number, rows, createQueries } = await linkedTableFixture();
    expect(createQueries).toBeLessThan(D1_QUERY_LIMIT / 2);

    const update = await measured(counter, ctx, () => post(`/api/database/rows/table/${table.id}/batch/`, {
      items: rows.map((row: any) => ({ id: row.id, [`field_${number.id}`]: 1 })),
    }, "PATCH"));
    expect(update.result.items).toHaveLength(ROWS);
    expect(update.queries).toBeLessThan(D1_QUERY_LIMIT / 2);

    const remove = await measured(counter, ctx, () => post(`/api/database/rows/table/${table.id}/batch-delete/`, {
      items: rows.slice(0, 150).map((row: any) => row.id),
    }));
    expect(remove.result).toEqual({ items_deleted: 150 });
    expect(remove.queries).toBeLessThan(D1_QUERY_LIMIT / 2);
  });

  it("edits one cell with a bounded number of queries", async () => {
    const { counter, ctx, post, table, number, rows } = await linkedTableFixture();
    const patch = await measured(counter, ctx, () => post(`/api/database/rows/table/${table.id}/${rows[0].id}/`, {
      [`field_${number.id}`]: 42,
    }, "PATCH"));
    expect(patch.result[`field_${number.id}`]).toBe("42");
    expect(patch.queries).toBeLessThan(60);
  });
});

describe("D1 bound-parameter limit", () => {
  it("lists a workspace with more than 100 members", async () => {
    const db = createTestD1();
    const call = apiClient(createEnv(db));
    insertUser(db, 1, "owner@supertask.test");
    const headers = { Authorization: `JWT ${await accessToken(1, "owner@supertask.test")}` };
    const workspace = await (await call("/api/workspaces/", { method: "POST", headers, body: JSON.stringify({ name: "Large" }) })).json() as any;
    for (let id = 2; id <= 130; id += 1) {
      insertUser(db, id, `member${id}@supertask.test`);
      db.database.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted) VALUES (?, ?, ?, 'MEMBER', 0)")
        .run(workspace.id, id, id);
    }
    const list = await call("/api/workspaces/", { headers });
    expect(list.status).toBe(200);
    const [listed] = await list.json() as any[];
    expect(listed.users).toHaveLength(130);
  });
});

