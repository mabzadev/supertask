import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { PermissionError } from "../middleware/error";
import { buildAuditCsv, serializeAuditEntry } from "../services/audit-log";
import { assertHasWorkspaceRole } from "../services/enterprise-permissions";
import { buildFileUrl } from "../services/secure-file-serve";

const auditLog = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function pagination(c: any) {
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const size = Math.min(200, Number(c.req.query("size") || c.req.query("limit") || 50));
  return { page, size, offset: (page - 1) * size };
}

const AUDIT_SORT_ERROR_DETAILS = {
  ERROR_INVALID_SORT_DIRECTION: "Attributes to sort by must be prefixed with one of '-' or '+'.",
  ERROR_INVALID_SORT_ATTRIBUTE: "Invalid attribute name provided to sort by.",
} as const;

function auditSortError(error: keyof typeof AUDIT_SORT_ERROR_DETAILS) {
  return {
    error,
    detail: AUDIT_SORT_ERROR_DETAILS[error],
  };
}

function parseAuditSorts(sorts: string | null | undefined) {
  if (!sorts) return { orderBy: "timestamp DESC, id DESC" };
  const mapping = new Map([
    ["user", "COALESCE(NULLIF(user_name, ''), user_email)"],
    ["workspace", "workspace_name"],
    ["type", "type"],
    ["timestamp", "timestamp"],
    ["ip_address", "ip_address"],
  ]);
  const seen = new Set<string>();
  const orderBy: string[] = [];
  for (const raw of sorts.split(",")) {
    if (raw.length <= 2) return { error: "ERROR_INVALID_SORT_ATTRIBUTE" as const };
    const prefix = raw[0];
    const key = raw.slice(1);
    if (prefix !== "+" && prefix !== "-") return { error: "ERROR_INVALID_SORT_DIRECTION" as const };
    const column = mapping.get(key);
    if (!column || seen.has(key)) return { error: "ERROR_INVALID_SORT_ATTRIBUTE" as const };
    seen.add(key);
    orderBy.push(`${column} ${prefix === "-" ? "DESC" : "ASC"}`);
  }
  orderBy.push("id DESC");
  return { orderBy: orderBy.join(", ") };
}

function paginatedResponse(page: number, size: number, offset: number, count: number, results: unknown[]) {
  return {
    count,
    next: offset + size < count ? `?page=${page + 1}` : null,
    previous: page > 1 ? `?page=${page - 1}` : null,
    results,
  };
}

async function assertAuditAccess(db: D1Database, user: any, workspaceId?: number | null) {
  if (!workspaceId) {
    if (!user.is_staff) throw new PermissionError("Only staff users can list instance audit logs.");
    return;
  }
  await assertHasWorkspaceRole(db, user.id, workspaceId, "ADMIN");
}

function auditWhere(c: any, user: any) {
  const workspaceId = c.req.query("workspace_id") || c.req.query("filter_workspace_id");
  const userId = c.req.query("user_id") || c.req.query("filter_user_id");
  const actionType = c.req.query("action_type") || c.req.query("filter_action_type");
  const from = c.req.query("from_timestamp") || c.req.query("filter_from_timestamp");
  const to = c.req.query("to_timestamp") || c.req.query("filter_to_timestamp");
  const search = c.req.query("search") || "";
  const where: string[] = [];
  const params: unknown[] = [];
  if (!user.is_staff && !workspaceId) where.push("1=0");
  if (workspaceId) {
    where.push("workspace_id=?");
    params.push(Number(workspaceId));
  }
  if (userId) {
    where.push("user_id=?");
    params.push(Number(userId));
  }
  if (actionType) {
    where.push("type=?");
    params.push(String(actionType));
  }
  if (from) {
    where.push("timestamp>=?");
    params.push(String(from));
  }
  if (to) {
    where.push("timestamp<=?");
    params.push(String(to));
  }
  if (search.trim()) {
    where.push("(user_email LIKE ? OR user_name LIKE ? OR workspace_name LIKE ? OR type LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  return {
    clause: where.length ? where.join(" AND ") : "1=1",
    params,
    workspaceId: workspaceId ? Number(workspaceId) : null,
  };
}

auditLog.get("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const { page, size, offset } = pagination(c);
  const { clause, params, workspaceId } = auditWhere(c, user);
  await assertAuditAccess(c.env.DB, user, workspaceId);
  const sorts = parseAuditSorts(c.req.query("sorts"));
  if (sorts.error) return c.json(auditSortError(sorts.error), 400);

  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM enterprise_auditlogentry WHERE ${clause}`)
    .bind(...params)
    .first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM enterprise_auditlogentry WHERE ${clause} ORDER BY ${sorts.orderBy} LIMIT ? OFFSET ?`
  ).bind(...params, size, offset).all<any>();
  const total = count?.count || 0;
  return c.json(paginatedResponse(page, size, offset, total, (rows.results || []).map(serializeAuditEntry)));
});

auditLog.get("/users/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const { page, size, offset } = pagination(c);
  const workspaceId = c.req.query("workspace_id") ? Number(c.req.query("workspace_id")) : null;
  await assertAuditAccess(c.env.DB, user, workspaceId);
  const search = c.req.query("search") || "";
  const where = ["user_id IS NOT NULL"];
  const params: unknown[] = [];
  if (workspaceId) { where.push("workspace_id=?"); params.push(workspaceId); }
  if (search.trim()) { where.push("(user_email LIKE ? OR user_name LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT user_id, user_name, user_email
       FROM enterprise_auditlogentry WHERE ${where.join(" AND ")}
       GROUP BY user_id, user_name, user_email
     )`
  ).bind(...params).first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT user_id AS id, COALESCE(NULLIF(user_name,''), user_email) AS name, user_email AS email
     FROM enterprise_auditlogentry WHERE ${where.join(" AND ")}
     GROUP BY user_id, user_name, user_email ORDER BY name ASC LIMIT ? OFFSET ?`
  ).bind(...params, size, offset).all<any>();
  return c.json(paginatedResponse(page, size, offset, count?.count || 0, rows.results || []));
});

auditLog.get("/workspaces/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  await assertAuditAccess(c.env.DB, user, null);
  const { page, size, offset } = pagination(c);
  const search = c.req.query("search") || "";
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT workspace_id, workspace_name
       FROM enterprise_auditlogentry
       WHERE workspace_id IS NOT NULL AND workspace_name LIKE ?
       GROUP BY workspace_id, workspace_name
     )`
  ).bind(`%${search}%`).first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT workspace_id AS id, COALESCE(NULLIF(workspace_name,''), 'Workspace ' || workspace_id) AS name
     FROM enterprise_auditlogentry
     WHERE workspace_id IS NOT NULL AND workspace_name LIKE ?
     GROUP BY workspace_id, workspace_name ORDER BY name ASC LIMIT ? OFFSET ?`
  ).bind(`%${search}%`, size, offset).all<any>();
  return c.json(paginatedResponse(page, size, offset, count?.count || 0, rows.results || []));
});

auditLog.get("/action-types/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = c.req.query("workspace_id") ? Number(c.req.query("workspace_id")) : null;
  await assertAuditAccess(c.env.DB, user, workspaceId);
  const { page, size, offset } = pagination(c);
  const search = c.req.query("search") || "";
  const where = ["type LIKE ?"];
  const params: unknown[] = [`%${search}%`];
  if (workspaceId) { where.push("workspace_id=?"); params.push(workspaceId); }
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT type FROM enterprise_auditlogentry
       WHERE ${where.join(" AND ")}
       GROUP BY type
     )`
  ).bind(...params).first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT type AS id, type AS name FROM enterprise_auditlogentry
     WHERE ${where.join(" AND ")} GROUP BY type ORDER BY type ASC LIMIT ? OFFSET ?`
  ).bind(...params, size, offset).all<any>();
  return c.json(paginatedResponse(page, size, offset, count?.count || 0, rows.results || []));
});

auditLog.post("/export/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<Record<string, unknown>>();
  const workspaceId = body.filter_workspace_id ? Number(body.filter_workspace_id) : null;
  await assertAuditAccess(c.env.DB, user, workspaceId);
  const where: string[] = [];
  const params: unknown[] = [];
  for (const [bodyKey, column] of [
    ["filter_workspace_id", "workspace_id"],
    ["filter_user_id", "user_id"],
    ["filter_action_type", "type"],
  ] as const) {
    if (body[bodyKey] !== undefined && body[bodyKey] !== null && body[bodyKey] !== "") {
      where.push(`${column}=?`);
      params.push(body[bodyKey]);
    }
  }
  if (body.filter_from_timestamp) { where.push("timestamp>=?"); params.push(String(body.filter_from_timestamp)); }
  if (body.filter_to_timestamp) { where.push("timestamp<=?"); params.push(String(body.filter_to_timestamp)); }
  const clause = where.length ? where.join(" AND ") : "1=1";
  const rows = await c.env.DB.prepare(
    `SELECT * FROM enterprise_auditlogentry WHERE ${clause} ORDER BY timestamp DESC, id DESC LIMIT 10000`
  ).bind(...params).all<any>();
  const now = new Date().toISOString();
  const key = `exports/audit-log-${Date.now()}.csv`;
  await c.env.FILES.put(key, buildAuditCsv(rows.results || []), {
    httpMetadata: {
      contentType: "text/csv",
      contentDisposition: `attachment; filename="audit_log_${now}.csv"`,
    },
  });
  const url = await buildFileUrl(c.env, key, workspaceId);
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (user_id, type, status, progress_percentage, created_on, updated_on, result)
     VALUES (?, 'audit_log_export', 'finished', 100, ?, ?, ?) RETURNING *`
  ).bind(user.id, now, now, JSON.stringify({ url, key, filter_workspace_id: workspaceId })).first<any>();
  return c.json({
    id: job?.id,
    type: "audit_log_export",
    state: "finished",
    status: "finished",
    progress_percentage: 100,
    url,
    filter_workspace_id: workspaceId,
    created_on: now,
    updated_on: now,
  }, 202);
});

export { auditLog as auditLogRouter };
