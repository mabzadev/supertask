import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { McpSessionDO } from "../src/durable-objects/mcp-session";
import { addFieldColumn, getOrCreateUserTable, type FieldType } from "../src/services/dynamic-tables";

function createD1() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0001_initial.sql", "0006_field_rules_data_sync.sql", "0017_mcp_endpoints.sql", "0035_autonumber_sequences.sql"]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", migration), "utf8"));
  }
  return {
    database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const normalize = (values: unknown[]) => values.map((value) => value === undefined ? null : value);
      return {
        bind(...values: unknown[]) {
          const args = normalize(values);
          return {
            all: async () => ({ results: statement.all(...args) }),
            first: async <T = any>() => (statement.get(...args) || null) as T | null,
            run: async () => statement.run(...args),
          };
        },
        all: async () => ({ results: statement.all() }),
        first: async <T = any>() => (statement.get() || null) as T | null,
        run: async () => statement.run(),
      };
    },
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
  };
}

describe("MCP row creation", () => {
  it("applies defaults and generated fields while protecting read-only values", async () => {
    const db = createD1();
    const now = "2026-07-10T20:00:00.000Z";
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (7, '', 'owner@example.com', 'Owner', 'User', 'owner@example.com', 1, 1, ?)`
    ).bind(now).run();
    await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
      .bind(now).run();
    await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')").run();
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
       VALUES (20, 10, 'Contacts', 1, 1, 0, ?, ?)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 20);

    const fields: Array<[number, string, FieldType, number, number, Record<string, unknown>]> = [
      [30, "Name", "text", 1, 0, { text_default: "Ready" }],
      [31, "Amount", "number", 2, 0, { number_decimal_places: 2 }],
      [32, "Rating", "rating", 3, 0, { max_value: 5 }],
      [33, "UUID", "uuid", 4, 1, {}],
      [34, "Created by", "created_by", 5, 1, {}],
      [35, "Sequence", "autonumber", 6, 1, {}],
      [36, "Last modified", "last_modified", 7, 1, {}],
      [37, "Last modified by", "last_modified_by", 8, 1, {}],
      [38, "Start", "date", 9, 0, { date_include_time: false }],
      [39, "End", "date", 10, 0, { date_include_time: false }],
      [40, "Duration", "duration", 11, 0, { duration_format: "d h" }],
    ];
    for (const [id, name, type, order, readOnly, settings] of fields) {
      await db.prepare(
        `INSERT INTO database_field
         (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on,
          db_index, immutable_type, immutable_properties)
         VALUES (?, 20, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 0)`
      ).bind(id, name, type, order, order === 1 ? 1 : 0, readOnly, JSON.stringify(settings), now, now, order === 1 ? 1 : 0).run();
      await addFieldColumn(db as any, 20, { id, type, primary: order === 1 });
    }
    await db.prepare('ALTER TABLE "database_table_20" ADD COLUMN "field_rules_are_valid" INTEGER NOT NULL DEFAULT 1').run();
    await db.prepare(
      `INSERT INTO database_fieldrule
       (id, table_id, type, is_active, is_valid, error_text, settings, created_on, updated_on)
       VALUES (1, 20, 'date_dependency', 1, 1, NULL, ?, ?, ?)`
    ).bind(JSON.stringify({
      start_date_field_id: 38,
      end_date_field_id: 39,
      duration_field_id: 40,
      include_weekends: true,
    }), now, now).run();
    await db.prepare(
      `INSERT INTO core_mcpendpoint (id, name, workspace_id, user_id, key, active, created_on, updated_on)
       VALUES (1, 'Test MCP', 1, 7, 'test-key', 1, ?, ?)`
    ).bind(now, now).run();

    const durableObject = new McpSessionDO({} as any, { DB: db } as any);
    const response = await durableObject.fetch(new Request("https://api.opentabl.test/mcp/test-key/sse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_row",
          arguments: {
            table_id: 20,
            values: {
              Amount: "12.50",
              UUID: "forced-value",
              Start: "2026-07-01",
              Duration: 259200,
            },
          },
        },
      }),
    }));

    expect(response.status).toBe(200);
    const rpc = await response.json() as any;
    expect(rpc.error).toBeUndefined();
    const created = JSON.parse(rpc.result.content[0].text);
    expect(created).toMatchObject({
      Name: "Ready",
      Amount: 12.5,
      Rating: 0,
      "Created by": { id: 7, name: "Owner User", email: "owner@example.com" },
      "Last modified by": { id: 7, name: "Owner User", email: "owner@example.com" },
      Start: "2026-07-01",
      End: "2026-07-03",
      Duration: 259200,
      Sequence: 1,
    });
    expect(created.UUID).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.UUID).not.toBe("forced-value");

    const stored = await db.prepare('SELECT * FROM "database_table_20" WHERE id=?').bind(created.id).first<any>();
    expect(stored).toMatchObject({ _created_by_id: 7, _last_modified_by_id: 7, field_30: "Ready", field_31: "n:12.50" });
    expect(stored.field_36).toBe(stored._updated_on);

    const updateResponse = await durableObject.fetch(new Request("https://api.opentabl.test/mcp/test-key/sse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "update_row",
          arguments: {
            table_id: 20,
            row_id: created.id,
            values: {
              Amount: "13.75",
              Start: "2026-07-10",
              "Last modified": "forced-value",
            },
          },
        },
      }),
    }));
    const updateRpc = await updateResponse.json() as any;
    expect(updateRpc.error).toBeUndefined();
    const updated = JSON.parse(updateRpc.result.content[0].text);
    expect(updated.Amount).toBe(13.75);
    expect(updated.Start).toBe("2026-07-10");
    expect(updated.End).toBe("2026-07-12");
    expect(updated["Last modified"]).not.toBe("forced-value");
    expect(updated["Last modified by"]).toEqual({ id: 7, name: "Owner User", email: "owner@example.com" });
    const updatedStored = await db.prepare('SELECT * FROM "database_table_20" WHERE id=?').bind(created.id).first<any>();
    expect(updatedStored.field_36).toBe(updatedStored._updated_on);
    expect(JSON.parse(updatedStored.field_37)).toEqual(updated["Last modified by"]);
  });
});
