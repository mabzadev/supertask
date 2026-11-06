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
