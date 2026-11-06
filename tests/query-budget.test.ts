import { describe, expect, it, vi } from "vitest";
import { duplicateDatabaseTable } from "../src/services/table-duplication";
import { accessToken, apiClient, createCtx, createEnv, createTestD1, insertUser, type QueryCounter } from "./helpers/worker-harness";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

// D1 allows 1,000 queries per Worker invocation (a batch counts as one).
// These budgets keep list and write paths independent of the row count.
const D1_QUERY_LIMIT = 1000;
const ROWS = 200;

async function linkedTableFixture() {
  const counter: QueryCounter = { queries: 0 };
  const db = createTestD1(counter);
  (counter as any).db = db;
  const ctx = createCtx();
  const env = createEnv(db);
  const call = apiClient(env, ctx);
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
  return { counter, ctx, env, call, headers, json, post, table, primary, number, link, rows: created.items, viewId: views[0].id, createQueries };
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

describe("D1 round trips", () => {
  // Each D1 call is a network round trip (~10 ms from the Worker), so the page
  // feels as slow as the longest chain of dependent calls. These budgets cap
  // that chain for the requests that open a table.
  async function measuredRoundTrips(counter: QueryCounter, ctx: { settle(): Promise<void> }, run: () => Promise<Response>) {
    await ctx.settle();
    counter.roundTrips = 0;
    const response = await run();
    const roundTrips = counter.roundTrips;
    counter.roundTrips = undefined;
    expect(response.status, await response.clone().text()).toBe(200);
    await ctx.settle();
    return roundTrips;
  }

  it("opens a table page in a bounded number of sequential round trips", async () => {
    const { counter, ctx, call, headers, post, table, number, viewId } = await linkedTableFixture();
    await post(`/api/database/views/${viewId}/filters/`, { field: number.id, type: "higher_than", value: "3" });
    await post(`/api/database/views/${viewId}/sortings/`, { field: number.id, order: "DESC" });
    await post(`/api/database/views/table/${table.id}/`, { name: "Second", type: "grid" });
    const get = (path: string) => () => call(path, { headers });

    // Before the round-trip work: views 9, fields 6, grid 11, field rules 4.
    const budgets: Array<[string, number]> = [
      [`/api/database/views/table/${table.id}/?include=filters,sortings,decorations,group_bys`, 5],
      [`/api/database/fields/table/${table.id}/`, 4],
      [`/api/database/views/grid/${viewId}/?limit=80&offset=0&include=field_options,row_metadata`, 6],
      [`/api/database/field-rules/${table.id}/`, 3],
    ];
    for (const [path, budget] of budgets) {
      expect(await measuredRoundTrips(counter, ctx, get(path)), path).toBeLessThanOrEqual(budget);
    }
  });

  it("answers a cell edit without waiting for the realtime fan-out", async () => {
    const { counter, ctx, env, call, headers, table, number, rows } = await linkedTableFixture();
    // The realtime room answers only once released: a response that waited
    // for it would never arrive.
    const broadcasts: string[] = [];
    let releaseRoom!: () => void;
    const roomReleased = new Promise<void>((resolve) => { releaseRoom = resolve; });
    env.WORKSPACE_ROOM = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          broadcasts.push(JSON.parse(String(init.body)).message.type);
          await roomReleased;
          return new Response("{}");
        },
      }),
    };
    await ctx.settle();
    counter.roundTrips = 0;
    const response = await call(`/api/database/rows/table/${table.id}/${rows[0].id}/`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ [`field_${number.id}`]: 7 }),
    });
    const roundTrips = counter.roundTrips;
    counter.roundTrips = undefined;
    expect(response.status).toBe(200);
    // Before: 22 round trips, then the two broadcasts awaited in sequence.
    expect(roundTrips).toBeLessThanOrEqual(11);

    releaseRoom();
    await ctx.settle();
    expect(broadcasts).toEqual(["rows_updated", "row_history_updated"]);
  });
});

describe("D1 bound-parameter limit", () => {
  it("returns the row metadata of a page larger than 100 rows", async () => {
    const { call, headers, json, viewId } = await linkedTableFixture();
    const grid = await json(await call(`/api/database/views/grid/${viewId}/?limit=150&offset=0&include=row_metadata`, { headers }));
    expect(grid.results).toHaveLength(150);
    expect(grid.row_metadata).toEqual({});
  });

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

describe("workspace search budget", () => {
  it("searches many tables without one query per field", async () => {
    const counter: QueryCounter = { queries: 0 };
    const db = createTestD1(counter);
    const call = apiClient(createEnv(db));
    insertUser(db, 1, "owner@supertask.test");
    const headers = { Authorization: `JWT ${await accessToken(1, "owner@supertask.test")}` };
    const post = async (path: string, body: unknown) => {
      const response = await call(path, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      return response.json() as Promise<any>;
    };
    const workspace = await post("/api/workspaces/", { name: "Search" });
    const database = await post(`/api/applications/workspace/${workspace.id}/`, { name: "Base", type: "database" });
    for (let tableIndex = 0; tableIndex < 10; tableIndex += 1) {
      const table = await post(`/api/database/tables/database/${database.id}/`, { name: `Table ${tableIndex}` });
      for (let fieldIndex = 0; fieldIndex < 15; fieldIndex += 1) {
        await post(`/api/database/fields/table/${table.id}/`, { name: `Field ${fieldIndex}`, type: "text" });
      }
    }
    counter.queries = 0;
    const response = await call(`/api/search/workspace/${workspace.id}/?search=needle`, { headers });
    expect(response.status).toBe(200);
    expect(counter.queries).toBeLessThan(150);
  });
});

describe("table duplication budget", () => {
  it("copies 1,200 linked rows with their ids and links in a bounded number of queries", async () => {
    const { counter, post, table, primary, link } = await linkedTableFixture();
    const extra = Array.from({ length: 1000 }, (_, index) => ({ [`field_${primary.id}`]: `Extra ${index}` }));
    for (let offset = 0; offset < extra.length; offset += 200) {
      await post(`/api/database/rows/table/${table.id}/batch/`, { items: extra.slice(offset, offset + 200) });
    }
    counter.queries = 0;
    const duplicated = await duplicateDatabaseTable((counter as any).db, table.id);
    expect(counter.queries).toBeLessThan(D1_QUERY_LIMIT / 2);
    const db = (counter as any).db;
    const copyId = duplicated.duplicatedTable.id;
    const copied = await db.prepare(`SELECT COUNT(*) AS count FROM "database_table_${copyId}"`).first();
    expect(copied.count).toBe(1200);
    const sourceLinks = await db.prepare(`SELECT id, "field_${link.id}" AS links FROM "database_table_${table.id}" ORDER BY id LIMIT 1`).first();
    const copiedLinkField = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND type='link_row'").bind(copyId).first();
    const copiedLinks = await db.prepare(`SELECT "field_${copiedLinkField.id}" AS links FROM "database_table_${copyId}" WHERE id=?`).bind(sourceLinks.id).first();
    expect(JSON.parse(copiedLinks.links).map((item: any) => item.id)).toEqual(JSON.parse(sourceLinks.links).map((item: any) => item.id));
  });
});

describe("field conversion budget", () => {
  it("converts a 1,200-row text field to a single select in a bounded number of queries", async () => {
    const { counter, post, table, primary } = await linkedTableFixture();
    const labels = ["Todo", "Doing", "Done"];
    const status = await post(`/api/database/fields/table/${table.id}/`, { name: "Status", type: "text" });
    const extra = Array.from({ length: 1000 }, (_, index) => ({ [`field_${primary.id}`]: `Extra ${index}` }));
    for (let offset = 0; offset < extra.length; offset += 200) {
      await post(`/api/database/rows/table/${table.id}/batch/`, { items: extra.slice(offset, offset + 200) });
    }
    const db = (counter as any).db;
    db.database.prepare(`UPDATE "database_table_${table.id}" SET "field_${status.id}" = CASE id % 3 WHEN 0 THEN 'Todo' WHEN 1 THEN 'Doing' ELSE 'Done' END`).run();

    counter.queries = 0;
    await post(`/api/database/fields/${status.id}/`, {
      type: "single_select",
      select_options: labels.map((value, index) => ({ id: -1 - index, value, color: "blue" })),
    }, "PATCH");
    expect(counter.queries).toBeLessThan(D1_QUERY_LIMIT / 2);
    const converted = db.database.prepare(`SELECT "field_${status.id}" AS value FROM "database_table_${table.id}" WHERE id % 3 = 0 LIMIT 1`).get() as any;
    expect(JSON.parse(converted.value)).toMatchObject({ value: "Todo" });
  });
});

