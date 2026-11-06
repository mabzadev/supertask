import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { DoesNotExist, PermissionError, ValidationError } from "../middleware/error";
import { assertHasWorkspaceRole } from "../services/enterprise-permissions";

const mcp = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const mcpServer = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function generateMcpKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `mcp_${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function requireWorkspaceAccess(db: D1Database, userId: number, workspaceId: number, requiredRole = "VIEWER") {
  await assertHasWorkspaceRole(db, userId, workspaceId, requiredRole);
}

async function requireEndpointAccess(db: D1Database, userId: number, endpointId: number, requiredRole = "VIEWER") {
  const endpoint = await db
    .prepare("SELECT * FROM core_mcpendpoint WHERE id = ? AND user_id = ?")
    .bind(endpointId, userId)
    .first<any>();
  if (!endpoint) throw new DoesNotExist("MCP endpoint", endpointId);
  await requireWorkspaceAccess(db, userId, Number(endpoint.workspace_id), requiredRole);
  return endpoint;
}

function serializeEndpoint(row: any) {
  return {
    id: row.id,
    name: row.name,
    workspace_id: row.workspace_id,
    user_id: row.user_id,
    key: row.key,
    active: Boolean(row.active),
    created_on: row.created_on,
    updated_on: row.updated_on,
  };
}

mcp.get("/endpoints/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const rows = await c.env.DB
    .prepare("SELECT * FROM core_mcpendpoint WHERE user_id = ? ORDER BY created_on DESC, id DESC")
    .bind(user.id)
    .all<any>();
  const visible = [];
  for (const row of rows.results || []) {
    try {
      await requireWorkspaceAccess(c.env.DB, user.id, Number(row.workspace_id), "VIEWER");
      visible.push(serializeEndpoint(row));
    } catch (error) {
      if (!(error instanceof PermissionError)) throw error;
    }
  }
  return c.json(visible);
});

mcp.post("/endpoints/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ name?: string; workspace_id?: number }>();
  const name = (body.name || "").trim();
  const workspaceId = Number(body.workspace_id);
  if (!name) throw new ValidationError("name is required.");
  if (!Number.isFinite(workspaceId)) throw new ValidationError("workspace_id is required.");
  await requireWorkspaceAccess(c.env.DB, user.id, workspaceId, "BUILDER");

  const now = new Date().toISOString();
  const row = await c.env.DB
    .prepare(
      `INSERT INTO core_mcpendpoint (name, workspace_id, user_id, key, active, created_on, updated_on)
       VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING *`
    )
    .bind(name, workspaceId, user.id, generateMcpKey(), now, now)
    .first<any>();
  return c.json(serializeEndpoint(row), 200);
});

mcp.patch("/endpoint/:endpointId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const endpointId = Number(c.req.param("endpointId"));
  await requireEndpointAccess(c.env.DB, user.id, endpointId, "BUILDER");

  const body = await c.req.json<{ name?: string; active?: boolean }>();
  const updates: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new ValidationError("name cannot be empty.");
    updates.push("name = ?");
    values.push(name);
  }
  if (body.active !== undefined) {
    updates.push("active = ?");
    values.push(body.active ? 1 : 0);
  }
  if (updates.length > 0) {
    updates.push("updated_on = ?");
    values.push(new Date().toISOString(), endpointId, user.id);
    await c.env.DB.prepare(`UPDATE core_mcpendpoint SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).bind(...values).run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM core_mcpendpoint WHERE id = ?").bind(endpointId).first<any>();
  return c.json(serializeEndpoint(updated));
});

mcp.delete("/endpoint/:endpointId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const endpointId = Number(c.req.param("endpointId"));
  await requireEndpointAccess(c.env.DB, user.id, endpointId, "BUILDER");
  await c.env.DB.prepare("DELETE FROM core_mcpendpoint WHERE id = ? AND user_id = ?").bind(endpointId, user.id).run();
  return c.json({});
});

async function forwardToMcpSession(c: any) {
  const key = c.req.param("key");
  const url = new URL(c.req.url);
  const sessionId = url.searchParams.get("sessionId") || crypto.randomUUID();
  url.searchParams.set("sessionId", sessionId);
  const id = c.env.MCP_SESSION.idFromName(`${key}:${sessionId}`);
  const session = c.env.MCP_SESSION.get(id);
  return session.fetch(new Request(url.toString(), c.req.raw));
}

mcpServer.get("/:key/sse", forwardToMcpSession);
mcpServer.post("/:key/sse", forwardToMcpSession);
mcpServer.post("/:key/messages", forwardToMcpSession);

export { mcp as mcpRouter, mcpServer as mcpServerRouter };
