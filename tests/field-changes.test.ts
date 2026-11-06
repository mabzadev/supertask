import { describe, expect, it, vi } from "vitest";
import { accessToken, apiClient, createEnv, createTestD1, insertUser } from "./helpers/worker-harness";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

async function tableWithFormula(formula: (name: string) => string) {
  const db = createTestD1();
  const call = apiClient(createEnv(db));
  insertUser(db, 1, "owner@supertask.test");
  const headers = { Authorization: `JWT ${await accessToken(1, "owner@supertask.test")}` };
  const json = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json() as Promise<any>;
  };
  const send = (path: string, body: unknown, method = "POST") => call(path, { method, headers, body: JSON.stringify(body) }).then(json);
  const workspace = await send("/api/workspaces/", { name: "W" });
  const database = await send(`/api/applications/workspace/${workspace.id}/`, { name: "D", type: "database" });
  const table = await send(`/api/database/tables/database/${database.id}/`, { name: "T" });
  const owner = await send(`/api/database/fields/table/${table.id}/`, { name: "Owner", type: "text" });
  const computed = await send(`/api/database/fields/table/${table.id}/`, { name: "Shout", type: "formula", formula: formula("Owner") });
  await send(`/api/database/rows/table/${table.id}/`, { [`field_${owner.id}`]: "ada" });
  return { db, call, headers, json, send, table, owner, computed };
}

describe("renaming a field referenced by formulas", () => {
  it.each([
    ["Owner's", "upper(field('Owner\\'s'))"],
    ["Price $& total", "upper(field('Price $& total'))"],
    ['Back\\slash "quoted"', "upper(field('Back\\\\slash \"quoted\"'))"],
  ])("keeps the formula valid after renaming to %s", async (newName, expectedFormula) => {
    const { db, call, headers, json, send, table, owner, computed } = await tableWithFormula((name) => `upper(field('${name}'))`);
    await send(`/api/database/fields/${owner.id}/`, { name: newName }, "PATCH");

    const stored = db.database.prepare("SELECT field_settings FROM database_field WHERE id=?").get(computed.id) as any;
    expect(JSON.parse(stored.field_settings).formula).toBe(expectedFormula);
    const rows = await json(await call(`/api/database/rows/table/${table.id}/`, { headers }));
    expect(rows.results[0][`field_${computed.id}`]).toBe("ADA");
  });

  it("serves rows even when a stored formula cannot be parsed", async () => {
    const { db, call, headers, json, table, computed } = await tableWithFormula((name) => `upper(field('${name}'))`);
    const settings = JSON.parse((db.database.prepare("SELECT field_settings FROM database_field WHERE id=?").get(computed.id) as any).field_settings);
    db.database.prepare("UPDATE database_field SET field_settings=? WHERE id=?").run(JSON.stringify({ ...settings, formula: "upper(field('Owner's'))" }), computed.id);
    const rows = await json(await call(`/api/database/rows/table/${table.id}/`, { headers }));
    expect(rows.results[0][`field_${computed.id}`]).toBeNull();
  });
});

describe("changing a field type", () => {
  it("gives the column the new type's storage so text keeps leading zeros and has no stale default", async () => {
    const { db, call, headers, json, send, table } = await tableWithFormula((name) => `field('${name}')`);
    const flag = await send(`/api/database/fields/table/${table.id}/`, { name: "Flag", type: "boolean" });
    const score = await send(`/api/database/fields/table/${table.id}/`, { name: "Score", type: "rating", max_value: 5 });
    await send(`/api/database/fields/${flag.id}/`, { type: "text" }, "PATCH");
    await send(`/api/database/fields/${score.id}/`, { type: "text" }, "PATCH");

    const created = await send(`/api/database/rows/table/${table.id}/`, { [`field_${flag.id}`]: "0612345678" });
    expect(created[`field_${flag.id}`]).toBe("0612345678");
    expect(created[`field_${score.id}`]).toBeNull();
    const stored = db.database.prepare(`SELECT typeof("field_${flag.id}") AS kind FROM "database_table_${table.id}" WHERE id=?`).get(created.id) as any;
    expect(stored.kind).toBe("text");
    const rows = await json(await call(`/api/database/rows/table/${table.id}/`, { headers }));
    expect(rows.results.every((row: any) => row[`field_${score.id}`] !== "n:0")).toBe(true);
  });

  it("keeps single select labels that contain commas when converting to multiple select", async () => {
    const { call, headers, json, send, table } = await tableWithFormula((name) => `field('${name}')`);
    const city = await send(`/api/database/fields/table/${table.id}/`, {
      name: "City", type: "single_select", select_options: [{ id: -1, value: "Paris, France", color: "blue" }, { id: -2, value: "Rome", color: "red" }],
    });
    const [paris, rome] = city.select_options;
    await send(`/api/database/rows/table/${table.id}/batch/`, { items: [{ [`field_${city.id}`]: paris.id }, { [`field_${city.id}`]: rome.id }] });
    await send(`/api/database/fields/${city.id}/`, { type: "multiple_select" }, "PATCH");
    const rows = await json(await call(`/api/database/rows/table/${table.id}/?user_field_names=true`, { headers }));
    const labels = rows.results.map((row: any) => (row.City || []).map((option: any) => option.value)).filter((values: string[]) => values.length > 0);
    expect(labels).toEqual([["Paris, France"], ["Rome"]]);
  });
});

