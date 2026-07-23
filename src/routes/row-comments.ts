import { Hono } from "hono";
import type { Env, RequestUser, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { DoesNotExist, PermissionError, ValidationError } from "../middleware/error";
import { broadcastToWorkspace } from "../durable-objects/workspace-room";
import { logAuditEntry } from "../services/audit-log";
import { recordTrashEntry } from "../services/trash";
import { ensureUserTableSystemColumns } from "../services/dynamic-tables";
import { assertHasTableRole } from "../services/enterprise-permissions";

const rowComments = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const VALID_NOTIFICATION_MODES = new Set(["all", "mentions"]);

interface TableContext {
  table_id: number;
  table_name: string;
  database_id: number;
  database_name: string;
  workspace_id: number;
  workspace_name: string;
}

function pageParams(c: any) {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 50)));
  const offset = Math.max(0, Number(c.req.query("offset") || 0));
  return { limit, offset };
}

function clientIp(c: any) {
  return c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || null;
}

function parseMessage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("The message must be a valid ProseMirror JSON document.");
  }
  const message = value as Record<string, unknown>;
  if (message.type !== "doc" || !Array.isArray(message.content)) {
    throw new ValidationError("The message must be a valid ProseMirror JSON document.");
  }
  return message;
}

function jsonParse(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value !== "string") return value as Record<string, unknown>;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function textFromMessage(node: unknown, chunks: string[] = []): string {
  if (!node || typeof node !== "object") return chunks.join(" ").trim();
  const record = node as Record<string, unknown>;
  if (typeof record.text === "string") chunks.push(record.text);
  const content = record.content;
  if (Array.isArray(content)) {
    for (const child of content) textFromMessage(child, chunks);
  }
  return chunks.join(" ").trim();
}

function collectMentionIds(node: unknown, ids = new Set<number>()) {
  if (!node || typeof node !== "object") return ids;
  const record = node as Record<string, unknown>;
  if (record.type === "mention") {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    const id = Number(attrs?.id);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  const content = record.content;
  if (Array.isArray(content)) {
    for (const child of content) collectMentionIds(child, ids);
  }
  return ids;
}

async function getTableContext(db: D1Database, tableId: number): Promise<TableContext> {
  const table = await db.prepare(
    `SELECT t.id AS table_id, t.name AS table_name, a.id AS database_id, a.name AS database_name,
            a.workspace_id, w.name AS workspace_name
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     JOIN core_workspace w ON w.id=a.workspace_id
     WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
  ).bind(tableId).first<TableContext>();
  if (!table) throw new DoesNotExist("Table", tableId);
  return table;
}

async function requireTableAccess(db: D1Database, userId: number, tableId: number) {
  const table = await getTableContext(db, tableId);
  await assertHasTableRole(db, userId, {
    id: table.table_id,
    database_id: table.database_id,
    workspace_id: table.workspace_id,
  }, "COMMENTER");
  return table;
}

async function assertRowExists(db: D1Database, tableId: number, rowId: number) {
  await ensureUserTableSystemColumns(db, tableId);
  const row = await db.prepare(`SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`).bind(rowId).first<Record<string, unknown>>();
  if (!row) throw new DoesNotExist("Row", rowId);
  return row;
}

async function rowName(db: D1Database, tableId: number, row: Record<string, unknown>) {
  const primary = await db.prepare(
    `SELECT id FROM database_field WHERE table_id=? AND "primary"=1 AND trashed=0 ORDER BY "order" ASC LIMIT 1`
  ).bind(tableId).first<{ id: number }>();
  const fieldId = primary?.id;
  if (!fieldId) return String(row.id);
  const value = row[`field_${fieldId}`];
  return value === null || value === undefined || value === "" ? String(row.id) : String(value);
}

function serializeComment(row: any) {
  const message = row.trashed ? null : jsonParse(row.message);
  return {
    id: row.id,
    user_id: row.user_id,
    first_name: row.first_name || row.username || row.email || "",
    table_id: row.table_id,
    row_id: row.row_id,
    message,
    created_on: row.created_on,
    updated_on: row.updated_on,
    edited: row.updated_on > row.created_on,
    trashed: Boolean(row.trashed),
  };
}

async function getComment(db: D1Database, tableId: number, commentId: number, includeTrash = true) {
  const trashFilter = includeTrash ? "" : "AND c.trashed=0";
  const comment = await db.prepare(
    `SELECT c.*, u.first_name, u.username, u.email
     FROM database_rowcomment c
     LEFT JOIN auth_user u ON u.id=c.user_id
     WHERE c.id=? AND c.table_id=? ${trashFilter}`
  ).bind(commentId, tableId).first<any>();
  if (!comment) throw new DoesNotExist("Row comment", commentId);
  return comment;
}

async function usersInWorkspace(db: D1Database, workspaceId: number, userIds: Iterable<number>, exclude = new Set<number>()) {
  const ids = Array.from(new Set(Array.from(userIds).filter((id) => Number.isInteger(id) && id > 0 && !exclude.has(id))));
  if (ids.length === 0) return [];
  const bindMarks = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT u.id
     FROM auth_user u
     JOIN core_workspaceuser wu ON wu.user_id=u.id
     WHERE u.id IN (${bindMarks}) AND u.is_active=1 AND wu.workspace_id=? AND wu.to_be_deleted=0`
  ).bind(...ids, workspaceId).all<{ id: number }>();
  return (result.results || []).map((row) => row.id);
}

async function createNotification(
  db: D1Database,
  type: "row_comment" | "row_comment_mention",
  recipients: number[],
  sender: RequestUser,
  table: TableContext,
  data: Record<string, unknown>
) {
  if (recipients.length === 0) return;
  const now = new Date().toISOString();
  const notification = await db.prepare(
    `INSERT INTO core_notification (created_on, updated_on, type, data, workspace_id, sender_id, broadcast)
     VALUES (?, ?, ?, ?, ?, ?, 0) RETURNING id`
  ).bind(now, now, type, JSON.stringify(data), table.workspace_id, sender.id).first<{ id: number }>();
  if (!notification) return;
  for (const recipientId of recipients) {
    await db.prepare(
      `INSERT OR IGNORE INTO core_notificationrecipient
       (notification_id, recipient_id, read, cleared, created_on)
       VALUES (?, ?, 0, 0, ?)`
    ).bind(notification.id, recipientId, now).run();
  }
}

async function subscribedUsers(db: D1Database, table: TableContext, rowId: number, exclude: Set<number>) {
  const result = await db.prepare(
    `SELECT m.user_id
     FROM database_rowcommentsnotificationmode m
     JOIN auth_user u ON u.id=m.user_id
     JOIN core_workspaceuser wu ON wu.user_id=m.user_id AND wu.workspace_id=?
     WHERE m.table_id=? AND m.row_id=? AND m.mode='all' AND u.is_active=1 AND wu.to_be_deleted=0`
  ).bind(table.workspace_id, table.table_id, rowId).all<{ user_id: number }>();
  return (result.results || [])
    .map((row) => row.user_id)
    .filter((userId) => !exclude.has(userId));
}

async function upsertNotificationMode(db: D1Database, userId: number, tableId: number, rowId: number, mode: string) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO database_rowcommentsnotificationmode (table_id, row_id, user_id, mode, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(table_id, row_id, user_id)
     DO UPDATE SET mode=excluded.mode, updated_on=excluded.updated_on`
  ).bind(tableId, rowId, userId, mode, now, now).run();
}

async function replaceMentions(db: D1Database, commentId: number, mentionIds: number[]) {
  await db.prepare("DELETE FROM database_rowcommentmention WHERE row_comment_id=?").bind(commentId).run();
  for (const id of mentionIds) {
    await db.prepare(
      "INSERT OR IGNORE INTO database_rowcommentmention (row_comment_id, user_id) VALUES (?, ?)"
    ).bind(commentId, id).run();
  }
}

async function notifyForCreatedComment(
  env: Env,
  user: RequestUser,
  table: TableContext,
  row: Record<string, unknown>,
  comment: any,
  message: Record<string, unknown>,
  mentionIds: number[]
) {
  const name = await rowName(env.DB, table.table_id, row);
  const data = {
    database_id: table.database_id,
    database_name: table.database_name,
    table_id: table.table_id,
    table_name: table.table_name,
    row_id: Number(row.id),
    row_name: name,
    comment_id: comment.id,
    message,
  };
  const mentioned = await usersInWorkspace(env.DB, table.workspace_id, mentionIds, new Set([user.id]));
  await createNotification(env.DB, "row_comment_mention", mentioned, user, table, data);

  const exclude = new Set<number>([user.id, ...mentioned]);
  const subscribers = await subscribedUsers(env.DB, table, Number(row.id), exclude);
  await createNotification(env.DB, "row_comment", subscribers, user, table, data);

  const existing = await env.DB.prepare(
    "SELECT id FROM database_rowcommentsnotificationmode WHERE table_id=? AND row_id=? AND user_id=?"
  ).bind(table.table_id, row.id, user.id).first<{ id: number }>();
  if (!existing) {
    await upsertNotificationMode(env.DB, user.id, table.table_id, Number(row.id), "all");
    await broadcastToWorkspace(env, table.workspace_id, {
      type: "row_comments_notification_mode_updated",
      table_id: table.table_id,
      row_id: Number(row.id),
      mode: "all",
    }, { pageFilter: `table-${table.table_id}` });
  }
}

async function notifyForNewMentions(
  env: Env,
  user: RequestUser,
  table: TableContext,
  row: Record<string, unknown>,
  comment: any,
  message: Record<string, unknown>,
  oldMentionIds: Set<number>,
  newMentionIds: number[]
) {
  const mentionIds = newMentionIds.filter((id) => !oldMentionIds.has(id));
  const mentioned = await usersInWorkspace(env.DB, table.workspace_id, mentionIds, new Set([user.id]));
  const name = await rowName(env.DB, table.table_id, row);
  await createNotification(env.DB, "row_comment_mention", mentioned, user, table, {
    database_id: table.database_id,
    database_name: table.database_name,
    table_id: table.table_id,
    table_name: table.table_name,
    row_id: Number(row.id),
    row_name: name,
    comment_id: comment.id,
    message,
  });
}

rowComments.get("/:tableId/:rowId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const rowId = Number(c.req.param("rowId"));
  await requireTableAccess(c.env.DB, user.id, tableId);
  await assertRowExists(c.env.DB, tableId, rowId);
  const { limit, offset } = pageParams(c);

  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM database_rowcomment WHERE table_id=? AND row_id=? AND trashed=0"
  ).bind(tableId, rowId).first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT c.*, u.first_name, u.username, u.email
     FROM database_rowcomment c
     LEFT JOIN auth_user u ON u.id=c.user_id
     WHERE c.table_id=? AND c.row_id=? AND c.trashed=0
     ORDER BY c.created_on DESC, c.id DESC
     LIMIT ? OFFSET ?`
  ).bind(tableId, rowId, limit, offset).all<any>();
  const total = count?.count || 0;
  return c.json({
    count: total,
    next: offset + limit < total ? `?offset=${offset + limit}&limit=${limit}` : null,
    previous: offset > 0 ? `?offset=${Math.max(0, offset - limit)}&limit=${limit}` : null,
    results: (rows.results || []).map(serializeComment),
  });
});

rowComments.post("/:tableId/:rowId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const rowId = Number(c.req.param("rowId"));
  const table = await requireTableAccess(c.env.DB, user.id, tableId);
  const row = await assertRowExists(c.env.DB, tableId, rowId);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const message = parseMessage(body.message);
  const mentionIds = await usersInWorkspace(c.env.DB, table.workspace_id, collectMentionIds(message), new Set());
  const now = new Date().toISOString();
  const inserted = await c.env.DB.prepare(
    `INSERT INTO database_rowcomment (table_id, row_id, user_id, message, created_on, updated_on, trashed)
     VALUES (?, ?, ?, ?, ?, ?, 0) RETURNING *`
  ).bind(tableId, rowId, user.id, JSON.stringify(message), now, now).first<any>();
  if (!inserted) throw new ValidationError("The row comment could not be created.");
  await replaceMentions(c.env.DB, inserted.id, mentionIds);
  await notifyForCreatedComment(c.env, user, table, row, inserted, message, mentionIds);
  await logAuditEntry(c.env.DB, "create_row_comment", {
    user,
    workspace_id: table.workspace_id,
    workspace_name: table.workspace_name,
    ip_address: clientIp(c),
  }, { id: inserted.id, type: "row_comment" }, {
    comment_id: inserted.id,
    message,
    row_id: rowId,
    table_id: table.table_id,
    table_name: table.table_name,
    database_id: table.database_id,
    database_name: table.database_name,
    workspace_id: table.workspace_id,
    workspace_name: table.workspace_name,
  });
  const comment = await getComment(c.env.DB, tableId, inserted.id);
  const serialized = serializeComment(comment);
  await broadcastToWorkspace(c.env, table.workspace_id, {
    type: "row_comment_created",
    row_comment: serialized,
  }, { excludeWebsocketId: c.get("websocket_id") || "", pageFilter: `table-${tableId}` });
  return c.json(serialized);
});

rowComments.patch("/:tableId/comment/:commentId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const commentId = Number(c.req.param("commentId"));
  const table = await requireTableAccess(c.env.DB, user.id, tableId);
  const existing = await getComment(c.env.DB, tableId, commentId, false);
  if (existing.user_id !== user.id) throw new PermissionError("Only the comment author can update this comment.");
  const row = await assertRowExists(c.env.DB, tableId, existing.row_id);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const message = parseMessage(body.message);
  const previousMentions = await c.env.DB.prepare(
    "SELECT user_id FROM database_rowcommentmention WHERE row_comment_id=?"
  ).bind(commentId).all<{ user_id: number }>();
  const oldMentionIds = new Set((previousMentions.results || []).map((mention) => mention.user_id));
  const originalMessage = jsonParse(existing.message) || {};
  const mentionIds = await usersInWorkspace(c.env.DB, table.workspace_id, collectMentionIds(message), new Set());
  const now = new Date().toISOString();
  const updated = await c.env.DB.prepare(
    "UPDATE database_rowcomment SET message=?, updated_on=? WHERE id=? AND table_id=? RETURNING *"
  ).bind(JSON.stringify(message), now, commentId, tableId).first<any>();
  if (!updated) throw new DoesNotExist("Row comment", commentId);
  await replaceMentions(c.env.DB, commentId, mentionIds);
  await notifyForNewMentions(c.env, user, table, row, updated, message, oldMentionIds, mentionIds);
  await logAuditEntry(c.env.DB, "update_row_comment", {
    user,
    workspace_id: table.workspace_id,
    workspace_name: table.workspace_name,
    ip_address: clientIp(c),
  }, { id: commentId, type: "row_comment" }, {
    comment_id: commentId,
    message,
    original_message: originalMessage,
    row_id: Number(existing.row_id),
    table_id: table.table_id,
    table_name: table.table_name,
    database_id: table.database_id,
    database_name: table.database_name,
    workspace_id: table.workspace_id,
    workspace_name: table.workspace_name,
  });
  const comment = await getComment(c.env.DB, tableId, commentId);
  const serialized = serializeComment(comment);
  await broadcastToWorkspace(c.env, table.workspace_id, {
    type: "row_comment_updated",
    row_comment: serialized,
  }, { excludeWebsocketId: c.get("websocket_id") || "", pageFilter: `table-${tableId}` });
  return c.json(serialized);
});

rowComments.delete("/:tableId/comment/:commentId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const commentId = Number(c.req.param("commentId"));
  const table = await requireTableAccess(c.env.DB, user.id, tableId);
  const existing = await getComment(c.env.DB, tableId, commentId, false);
  if (existing.user_id !== user.id) throw new PermissionError("Only the comment author can delete this comment.");
  const originalMessage = jsonParse(existing.message) || {};
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE database_rowcomment SET trashed=1, updated_on=? WHERE id=? AND table_id=?"
  ).bind(now, commentId, tableId).run();
  await recordTrashEntry(c.env.DB, {
    userId: user.id,
    workspaceId: table.workspace_id,
    applicationId: table.database_id,
    trashItemType: "row_comment",
    trashItemId: commentId,
    name: textFromMessage(originalMessage) || "Row comment",
    parentName: table.table_name,
    extra: {
      row_id: Number(existing.row_id),
      table_id: table.table_id,
      database_id: table.database_id,
    },
    trashedAt: now,
  });
  await logAuditEntry(c.env.DB, "delete_row_comment", {
    user,
    workspace_id: table.workspace_id,
    workspace_name: table.workspace_name,
    ip_address: clientIp(c),
  }, { id: commentId, type: "row_comment" }, {
    comment_id: commentId,
    message: originalMessage,
    row_id: Number(existing.row_id),
    table_id: table.table_id,
    table_name: table.table_name,
    database_id: table.database_id,
    database_name: table.database_name,
    workspace_id: table.workspace_id,
    workspace_name: table.workspace_name,
  });
  const comment = await getComment(c.env.DB, tableId, commentId);
  const serialized = serializeComment(comment);
  await broadcastToWorkspace(c.env, table.workspace_id, {
    type: "row_comment_deleted",
    row_comment: serialized,
  }, { excludeWebsocketId: c.get("websocket_id") || "", pageFilter: `table-${tableId}` });
  return c.json(serialized);
});

rowComments.put("/:tableId/:rowId/notification-mode/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const rowId = Number(c.req.param("rowId"));
  const table = await requireTableAccess(c.env.DB, user.id, tableId);
  await assertRowExists(c.env.DB, tableId, rowId);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const mode = String(body.mode || "");
  if (!VALID_NOTIFICATION_MODES.has(mode)) {
    throw new ValidationError("Invalid row comment notification mode.");
  }
  await upsertNotificationMode(c.env.DB, user.id, tableId, rowId, mode);
  await broadcastToWorkspace(c.env, table.workspace_id, {
    type: "row_comments_notification_mode_updated",
    table_id: tableId,
    row_id: rowId,
    mode,
  }, { excludeWebsocketId: c.get("websocket_id") || "", pageFilter: `table-${tableId}` });
  return c.body(null, 204);
});

export { rowComments as rowCommentsRouter };
