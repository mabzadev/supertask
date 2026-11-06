import type { Env } from "../types/env";
import { deserializeFieldValue, ensureUserTableSystemColumns, serializeFieldValueForInsert, type FieldMeta, type FieldType } from "../services/dynamic-tables";
import { serializeFieldValueForStorage } from "../services/field-values";
import { assertCanWriteFieldValues, assertHasTableRole, hasLoadedApplicationRole } from "../services/enterprise-permissions";
import { allocateAutonumberValues } from "../services/autonumber";
import { getActiveFields } from "../services/view-helpers";
import { missingCreateFieldValues } from "../services/row-create-values";
import { isReadOnlyFieldType } from "../services/field-serialization";
import { finalizeRowWrite, modifiedFieldValues } from "../services/row-write-effects";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

type McpEndpoint = {
  id: number;
  name: string;
  key: string;
  workspace_id: number;
  user_id: number;
};

type Field = {
  id: number;
  name: string;
  type: FieldType;
  readOnly: boolean;
};

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function sseMessage(event: string, data: unknown) {
  return `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function publicBaseUrl(request: Request, env: Env) {
  const configured = env.PUBLIC_URL || "";
  if (configured.startsWith("http")) return configured.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function endpointFromKey(db: D1Database, key: string): Promise<McpEndpoint | null> {
  return db
    .prepare(
      `SELECT e.id, e.name, e.key, e.workspace_id, e.user_id
       FROM core_mcpendpoint e
       JOIN auth_user u ON u.id = e.user_id
       JOIN core_workspaceuser wu ON wu.workspace_id = e.workspace_id AND wu.user_id = e.user_id
       WHERE e.key = ? AND e.active = 1 AND u.is_active = 1 AND wu.to_be_deleted = 0`
    )
    .bind(key)
    .first<McpEndpoint>();
}

async function getFields(db: D1Database, tableId: number): Promise<Field[]> {
  const res = await db
    .prepare("SELECT id, name, type, read_only FROM database_field WHERE table_id = ? AND trashed = 0 ORDER BY [order] ASC")
    .bind(tableId)
    .all<any>();
  return (res.results || []).map((field) => ({
    id: Number(field.id),
    name: String(field.name),
    type: field.type as FieldType,
    readOnly: Boolean(field.read_only) || isReadOnlyFieldType(field.type),
  }));
}

async function requireDatabaseInWorkspace(db: D1Database, workspaceId: number, databaseId: number) {
  const database = await db
    .prepare("SELECT id, name, type, workspace_id FROM core_application WHERE id = ? AND workspace_id = ? AND trashed = 0")
    .bind(databaseId, workspaceId)
    .first<any>();
  if (!database) throw new Error("Database not found in this workspace.");
  return database;
}

async function requireTableInWorkspace(db: D1Database, workspaceId: number, tableId: number) {
  const table = await db
    .prepare(
      `SELECT t.id, t.name, t.database_id, a.workspace_id
       FROM database_table t
       JOIN core_application a ON a.id = t.database_id
       WHERE t.id = ? AND t.trashed = 0 AND a.trashed = 0 AND a.workspace_id = ?`
    )
    .bind(tableId, workspaceId)
    .first<any>();
  if (!table) throw new Error("Table not found in this workspace.");
  return table;
}

function rowToNamedObject(row: Record<string, unknown>, fields: Field[]) {
  const item: Record<string, unknown> = {
    id: row.id,
    order: row.order ?? row["order"] ?? row["[order]"],
  };
  for (const field of fields) {
    const value = row[`field_${field.id}`];
    item[field.name] = deserializeFieldValue(field.type, value);
  }
  return item;
}

/** Values go through the same storage normalisation as the API (passwords hashed, links resolved…). */
async function bindValuesToFields(env: Env, fields: FieldMeta[], values: Record<string, unknown>, workspaceId: number) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const written: FieldMeta[] = [];
  for (const field of fields) {
    if (field.readOnly || isReadOnlyFieldType(field.type)) continue;
    const fieldKey = `field_${field.id}`;
    const bodyKey = fieldKey in values ? fieldKey : field.name;
    if (!(bodyKey in values)) continue;
    const serialized = await serializeFieldValueForStorage(env.DB, field, values[bodyKey], env, workspaceId);
    if (serialized === undefined) continue;
    cols.push(fieldKey);
    vals.push(serialized);
    written.push(field);
  }
  return { cols, vals, written };
}

/** The endpoint acts as its user: it needs that user's own role on the table. */
async function requireTableAccess(db: D1Database, endpoint: McpEndpoint, tableId: number, role: "VIEWER" | "EDITOR") {
  const table = await requireTableInWorkspace(db, endpoint.workspace_id, tableId);
  const scope = { id: Number(table.id), database_id: Number(table.database_id), workspace_id: Number(table.workspace_id) };
  await assertHasTableRole(db, endpoint.user_id, scope, role);
  return scope;
}

const toolDefinitions = [
  {
    name: "list_workspaces",
    description: "List the workspace connected to this MCP endpoint.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_databases",
    description: "List databases in the endpoint workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_tables",
    description: "List tables in a database.",
    inputSchema: {
      type: "object",
      properties: { database_id: { type: "number" } },
      required: ["database_id"],
    },
  },
  {
    name: "list_fields",
    description: "List fields in a table.",
    inputSchema: {
      type: "object",
      properties: { table_id: { type: "number" } },
      required: ["table_id"],
    },
  },
  {
    name: "list_rows",
    description: "List rows in a table using field names as keys.",
    inputSchema: {
      type: "object",
      properties: {
        table_id: { type: "number" },
        limit: { type: "number", default: 50 },
        offset: { type: "number", default: 0 },
      },
      required: ["table_id"],
    },
  },
  {
    name: "create_row",
    description: "Create a row in a table. Values can be keyed by field name or field_<id>.",
    inputSchema: {
      type: "object",
      properties: {
        table_id: { type: "number" },
        values: { type: "object" },
      },
      required: ["table_id", "values"],
    },
  },
  {
    name: "update_row",
    description: "Update a row in a table. Values can be keyed by field name or field_<id>.",
    inputSchema: {
      type: "object",
      properties: {
        table_id: { type: "number" },
        row_id: { type: "number" },
        values: { type: "object" },
      },
      required: ["table_id", "row_id", "values"],
    },
  },
];

export class McpSessionDO {
  private env: Env;
  private sessions = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.split("/")[2];
    const sessionId = url.searchParams.get("sessionId") || crypto.randomUUID();

    if (request.method === "GET" && url.pathname.endsWith("/sse")) {
      return this.openSse(request, key, sessionId);
    }

    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      return this.handlePost(request, key, sessionId);
    }

    if (request.method === "POST" && url.pathname.endsWith("/sse")) {
      const payload = await request.json() as JsonRpcRequest | JsonRpcRequest[];
      const response = await this.handleJsonRpc(key, payload);
      return Response.json(response);
    }

    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  private async openSse(request: Request, key: string, sessionId: string): Promise<Response> {
    const endpoint = await endpointFromKey(this.env.DB, key);
    if (!endpoint) return Response.json({ error: "INVALID_MCP_ENDPOINT" }, { status: 404 });

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    this.sessions.set(sessionId, writer);

    const encoder = new TextEncoder();
    const messagePath = `/mcp/${key}/messages?sessionId=${encodeURIComponent(sessionId)}`;
    void writer.write(encoder.encode(sseMessage("endpoint", `${publicBaseUrl(request, this.env)}${messagePath}`)));
    void writer.write(encoder.encode(sseMessage("ready", { endpoint: endpoint.name })));

    const keepAlive = setInterval(() => {
      writer.write(encoder.encode(": keep-alive\n\n")).catch(() => {
        clearInterval(keepAlive);
        this.sessions.delete(sessionId);
      });
    }, 25000);

    request.signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      this.sessions.delete(sessionId);
      writer.close().catch(() => undefined);
    });

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  private async handlePost(request: Request, key: string, sessionId: string): Promise<Response> {
    const payload = await request.json() as JsonRpcRequest | JsonRpcRequest[];
    const response = await this.handleJsonRpc(key, payload);
    const writer = this.sessions.get(sessionId);

    if (writer && response !== undefined) {
      await writer.write(new TextEncoder().encode(sseMessage("message", response)));
      return new Response(null, { status: 202 });
    }

    return Response.json(response ?? {});
  }

  private async handleJsonRpc(key: string, payload: JsonRpcRequest | JsonRpcRequest[]) {
    if (Array.isArray(payload)) {
      const responses = await Promise.all(payload.map((item) => this.handleOne(key, item)));
      return responses.filter(Boolean);
    }
    return this.handleOne(key, payload);
  }

  private async handleOne(key: string, request: JsonRpcRequest) {
    if (!request.id && request.method?.startsWith("notifications/")) return undefined;
    try {
      const endpoint = await endpointFromKey(this.env.DB, key);
      if (!endpoint) return jsonRpcError(request.id, -32001, "Invalid or disabled MCP endpoint.");

      switch (request.method) {
        case "initialize":
          return jsonRpcResult(request.id, {
            protocolVersion: request.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "Supertask MCP", version: "0.1.0" },
          });
        case "ping":
          return jsonRpcResult(request.id, {});
        case "tools/list":
          return jsonRpcResult(request.id, { tools: toolDefinitions });
        case "tools/call":
          return jsonRpcResult(request.id, await this.callTool(endpoint, request.params?.name, request.params?.arguments || {}));
        case "resources/list":
          return jsonRpcResult(request.id, { resources: [] });
        case "prompts/list":
          return jsonRpcResult(request.id, { prompts: [] });
        default:
          return jsonRpcError(request.id, -32601, `Unknown MCP method: ${request.method}`);
      }
    } catch (error: any) {
      return jsonRpcError(request.id, -32000, error?.message || String(error));
    }
  }

  private async callTool(endpoint: McpEndpoint, name: string, args: Record<string, unknown>) {
    const db = this.env.DB;
    switch (name) {
      case "list_workspaces": {
        const workspace = await db.prepare("SELECT id, name FROM core_workspace WHERE id = ?").bind(endpoint.workspace_id).first();
        return textResult(workspace ? [workspace] : []);
      }
      case "list_databases": {
        const rows = await db
          .prepare("SELECT id, name, type, [order] FROM core_application WHERE workspace_id = ? AND trashed = 0 ORDER BY [order] ASC")
          .bind(endpoint.workspace_id)
          .all<any>();
        const applications = rows.results || [];
        const visible = await Promise.all(applications.map((application) => hasLoadedApplicationRole(
          db, endpoint.user_id, { id: Number(application.id), workspace_id: endpoint.workspace_id }, "VIEWER"
        )));
        return textResult(applications.filter((_, index) => visible[index]));
      }
      case "list_tables": {
        const databaseId = Number(args.database_id);
        await requireDatabaseInWorkspace(db, endpoint.workspace_id, databaseId);
        const rows = await db
          .prepare("SELECT id, name, [order], database_id FROM database_table WHERE database_id = ? AND trashed = 0 ORDER BY [order] ASC")
          .bind(databaseId)
          .all<any>();
        const tables = rows.results || [];
        const visible = await Promise.all(tables.map((table) => assertHasTableRole(
          db, endpoint.user_id, { id: Number(table.id), database_id: databaseId, workspace_id: endpoint.workspace_id }, "VIEWER"
        ).then(() => true, () => false)));
        return textResult(tables.filter((_, index) => visible[index]));
      }
      case "list_fields": {
        const tableId = Number(args.table_id);
        await requireTableAccess(db, endpoint, tableId, "VIEWER");
        return textResult(await getFields(db, tableId));
      }
      case "list_rows": {
        const tableId = Number(args.table_id);
        await requireTableAccess(db, endpoint, tableId, "VIEWER");
        await ensureUserTableSystemColumns(db, tableId);
        const fields = await getFields(db, tableId);
        const limit = Math.max(1, Math.min(100, Number(args.limit || 50)));
        const offset = Math.max(0, Number(args.offset || 0));
        const rows = await db.prepare(`SELECT * FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC LIMIT ? OFFSET ?`).bind(limit, offset).all<any>();
        return textResult((rows.results || []).map((row) => rowToNamedObject(row, fields)));
      }
      case "create_row": {
        const tableId = Number(args.table_id);
        const table = await requireTableAccess(db, endpoint, tableId, "EDITOR");
        await ensureUserTableSystemColumns(db, tableId);
        const values = typeof args.values === "object" && args.values ? args.values as Record<string, unknown> : {};
        const fields = await getFields(db, tableId);
        const fieldMetadata = await getActiveFields(db, tableId);
        const { cols, vals, written } = await bindValuesToFields(this.env, fieldMetadata, values, endpoint.workspace_id);
        await assertCanWriteFieldValues(db, endpoint.user_id, table, written);
        const changedFieldIds = new Set(cols.map((column) => Number(column.slice("field_".length))));
        const now = new Date().toISOString();
        const maxOrder = await db.prepare(`SELECT COALESCE(MAX([order]), 0) AS max_order FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0`).first<{ max_order: number }>();
        const existingFieldIds = new Set(cols.flatMap((column) => {
          const match = column.match(/^field_(\d+)$/);
          return match ? [Number(match[1])] : [];
        }));
        const missingValues = await missingCreateFieldValues(db, fieldMetadata, existingFieldIds, {
          now,
          user: endpoint.user_id,
          workspaceId: endpoint.workspace_id,
        });
        for (const [fieldId, value] of missingValues) {
          cols.push(`field_${fieldId}`);
          vals.push(value);
        }
        const columnSql = ["[order]", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id", ...cols.map((col) => `"${col}"`)];
        const autonumberValues = await allocateAutonumberValues(db, tableId);
        for (const [fieldId, value] of autonumberValues) {
          columnSql.push(`"field_${fieldId}"`);
          vals.push(serializeFieldValueForInsert("autonumber", value));
        }
        const bindMarks = columnSql.map(() => "?").join(", ");
        const row = await db
          .prepare(`INSERT INTO "database_table_${tableId}" (${columnSql.join(", ")}) VALUES (${bindMarks}) RETURNING *`)
          .bind((maxOrder?.max_order || 0) + 10000, now, now, endpoint.user_id, endpoint.user_id, ...vals)
          .first<any>();
        const finalized = row
          ? await finalizeRowWrite(db, tableId, Number(row.id), null, changedFieldIds, endpoint.user_id, this.env)
          : null;
        return textResult(rowToNamedObject(finalized || row || {}, fields));
      }
      case "update_row": {
        const tableId = Number(args.table_id);
        const rowId = Number(args.row_id);
        const table = await requireTableAccess(db, endpoint, tableId, "EDITOR");
        await ensureUserTableSystemColumns(db, tableId);
        const values = typeof args.values === "object" && args.values ? args.values as Record<string, unknown> : {};
        const fields = await getFields(db, tableId);
        const fieldMetadata = await getActiveFields(db, tableId);
        const { cols, vals, written } = await bindValuesToFields(this.env, fieldMetadata, values, endpoint.workspace_id);
        if (cols.length === 0) throw new Error("No valid field values provided.");
        await assertCanWriteFieldValues(db, endpoint.user_id, table, written);
        const changedFieldIds = new Set(cols.map((column) => Number(column.slice("field_".length))));
        const now = new Date().toISOString();
        const before = await db.prepare(`SELECT * FROM "database_table_${tableId}" WHERE id = ? AND COALESCE(trashed, 0)=0`)
          .bind(rowId)
          .first<any>();
        if (!before) throw new Error("Row not found.");
        const modifiedValues = await modifiedFieldValues(db, fieldMetadata, now, endpoint.user_id);
        for (const [fieldId, value] of modifiedValues) {
          cols.push(`field_${fieldId}`);
          vals.push(value);
        }
        const sets = ["_updated_on = ?", "_last_modified_by_id = ?", ...cols.map((col) => `"${col}" = ?`)];
        await db.prepare(`UPDATE "database_table_${tableId}" SET ${sets.join(", ")} WHERE id = ? AND COALESCE(trashed, 0)=0`).bind(now, endpoint.user_id, ...vals, rowId).run();
        const row = await finalizeRowWrite(db, tableId, rowId, before, changedFieldIds, endpoint.user_id, this.env);
        if (!row) throw new Error("Row not found.");
        return textResult(rowToNamedObject(row, fields));
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
