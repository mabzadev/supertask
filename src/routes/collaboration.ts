import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { DoesNotExist, PermissionError, ValidationError } from "../middleware/error";
import {
  contentKind,
  createContentVersion,
  getContentAccess,
  materializedContent,
  persistMaterializedContent,
} from "../services/collaboration";
import { createDirectNotificationForUsers } from "../services/notifications";
import { logAuditEntry } from "../services/audit-log";

const collaboration = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function parseRecord(value: unknown, field: string, fallback: Record<string, unknown> = {}) {
  if (value === undefined || value === null) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} doit être un objet JSON.`);
  }
  return value as Record<string, unknown>;
}

function collectMentionIds(value: unknown, ids = new Set<number>()) {
  if (!value || typeof value !== "object") return ids;
  if (Array.isArray(value)) {
    for (const child of value) collectMentionIds(child, ids);
    return ids;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "mention") {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    const id = Number(attrs?.id);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  for (const child of Object.values(record)) collectMentionIds(child, ids);
  return ids;
}

function collectMentionHandles(value: unknown) {
  const chunks: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") chunks.push(record.text);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...new Set(chunks.join(" ").match(/@[\p{L}\p{N}._+-]+(?:@[\p{L}\p{N}.-]+)?/gu)?.map((item) => item.slice(1).toLowerCase()) || [])];
}

async function workspaceMentionIds(db: D1Database, workspaceId: number, candidates: number[], senderId: number) {
  const ids = [...new Set(candidates.filter((id) => Number.isInteger(id) && id > 0 && id !== senderId))];
  if (!ids.length) return [];
  const rows = await db.prepare(
    `SELECT u.id FROM auth_user u
      JOIN core_workspaceuser wu ON wu.user_id=u.id
     WHERE u.id IN (${ids.map(() => "?").join(",")})
       AND u.is_active=1 AND wu.workspace_id=? AND wu.to_be_deleted=0`
  ).bind(...ids, workspaceId).all<{ id: number }>();
  return (rows.results || []).map((row) => Number(row.id));
}

async function workspaceMentionHandleIds(db: D1Database, workspaceId: number, handles: string[], senderId: number) {
  if (!handles.length) return [];
  const rows = await db.prepare(
    `SELECT u.id FROM auth_user u
      JOIN core_workspaceuser wu ON wu.user_id=u.id
     WHERE wu.workspace_id=? AND wu.to_be_deleted=0 AND u.is_active=1 AND u.id<>?
       AND (LOWER(u.email) IN (${handles.map(() => "?").join(",")})
        OR LOWER(u.username) IN (${handles.map(() => "?").join(",")})
        OR LOWER(REPLACE(u.first_name, ' ', '.')) IN (${handles.map(() => "?").join(",")}))`
  ).bind(workspaceId, senderId, ...handles, ...handles, ...handles).all<{ id: number }>();
  return (rows.results || []).map((row) => Number(row.id));
}

function json(value: unknown, fallback: Record<string, unknown> = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

function serializeComment(row: any) {
  return {
    id: Number(row.id),
    content_type: row.content_type,
    content_id: Number(row.content_id),
    parent_id: row.parent_id === null ? null : Number(row.parent_id),
    user: {
      id: Number(row.user_id),
      name: String(row.first_name || row.username || row.email || "Membre"),
      email: String(row.email || ""),
    },
    message: json(row.message),
    anchor: json(row.anchor),
    resolved: Boolean(row.resolved),
    created_on: row.created_on,
    updated_on: row.updated_on,
    edited: row.updated_on > row.created_on,
  };
}

async function commentRow(db: D1Database, kind: string, contentId: number, commentId: number) {
  const row = await db.prepare(
    `SELECT c.*, u.first_name, u.username, u.email
       FROM opentabl_content_comment c
       JOIN auth_user u ON u.id=c.user_id
      WHERE c.id=? AND c.content_type=? AND c.content_id=? AND c.trashed=0`
  ).bind(commentId, kind, contentId).first<any>();
  if (!row) throw new DoesNotExist("Commentaire", commentId);
  return row;
}

collaboration.get("/:kind/:contentId/comments/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("contentId"));
  await getContentAccess(c.env.DB, user.id, kind, contentId, "VIEWER");
  const rows = await c.env.DB.prepare(
    `SELECT c.*, u.first_name, u.username, u.email
       FROM opentabl_content_comment c
       JOIN auth_user u ON u.id=c.user_id
      WHERE c.content_type=? AND c.content_id=? AND c.trashed=0
      ORDER BY c.created_on, c.id`
  ).bind(kind, contentId).all<any>();
  return c.json((rows.results || []).map(serializeComment));
});

collaboration.post("/:kind/:contentId/comments/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("contentId"));
  const access = await getContentAccess(c.env.DB, user.id, kind, contentId, "COMMENTER");
  const body = await c.req.json<any>().catch(() => ({}));
  const message = parseRecord(body.message, "message");
  const anchor = parseRecord(body.anchor, "anchor");
  const parentId = body.parent_id === undefined || body.parent_id === null ? null : Number(body.parent_id);
  if (parentId !== null) await commentRow(c.env.DB, kind, contentId, parentId);
  const now = new Date().toISOString();
  const row = await c.env.DB.prepare(
    `INSERT INTO opentabl_content_comment
     (content_type, content_id, parent_id, user_id, message, anchor, resolved, trashed, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?) RETURNING *`
  ).bind(kind, contentId, parentId, user.id, JSON.stringify(message), JSON.stringify(anchor), now, now).first<any>();
  if (!row) throw new Error("Impossible de créer le commentaire.");

  const explicitMentions = Array.isArray(body.mentions) ? body.mentions.map(Number) : [];
  const mentionedById = await workspaceMentionIds(
    c.env.DB,
    access.workspace_id,
    [...explicitMentions, ...collectMentionIds(message)],
    user.id,
  );
  const mentionedByHandle = await workspaceMentionHandleIds(
    c.env.DB,
    access.workspace_id,
    collectMentionHandles(message),
    user.id,
  );
  const mentioned = [...new Set([...mentionedById, ...mentionedByHandle])];
  for (const mentionedId of mentioned) {
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO opentabl_content_comment_mention (comment_id, user_id) VALUES (?, ?)"
    ).bind(row.id, mentionedId).run();
  }
  const notificationData = {
    content_type: kind,
    content_id: contentId,
    application_id: access.application_id,
    content_name: access.name,
    comment_id: Number(row.id),
    anchor,
  };
  await createDirectNotificationForUsers(c.env.DB, {
    type: "content_comment_mention",
    recipientIds: mentioned,
    senderId: user.id,
    workspaceId: access.workspace_id,
    data: notificationData,
  });
  if (parentId) {
    const parent = await commentRow(c.env.DB, kind, contentId, parentId);
    const parentAuthor = Number(parent.user_id);
    if (parentAuthor !== user.id && !mentioned.includes(parentAuthor)) {
      await createDirectNotificationForUsers(c.env.DB, {
        type: "content_comment",
        recipientIds: [parentAuthor],
        senderId: user.id,
        workspaceId: access.workspace_id,
        data: notificationData,
      });
    }
  }
  const hydrated = await commentRow(c.env.DB, kind, contentId, Number(row.id));
  await logAuditEntry(c.env.DB, "content.comment.create", { user, workspace_id: access.workspace_id },
    { id: Number(row.id), type: "content_comment" }, { content_type: kind, content_id: contentId, parent_id: parentId });
  return c.json(serializeComment(hydrated), 201);
});

collaboration.patch("/:kind/:contentId/comments/:commentId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("contentId"));
  const commentId = Number(c.req.param("commentId"));
  const access = await getContentAccess(c.env.DB, user.id, kind, contentId, "COMMENTER");
  const existing = await commentRow(c.env.DB, kind, contentId, commentId);
  const body = await c.req.json<any>().catch(() => ({}));
  const isAuthor = Number(existing.user_id) === user.id;
  if ("message" in body && !isAuthor) throw new PermissionError("Seul l’auteur peut modifier ce commentaire.");
  if ("resolved" in body) await getContentAccess(c.env.DB, user.id, kind, contentId, "EDITOR");
  const sets: string[] = [];
  const values: unknown[] = [];
  if ("message" in body) { sets.push("message=?"); values.push(JSON.stringify(parseRecord(body.message, "message"))); }
  if ("anchor" in body && isAuthor) { sets.push("anchor=?"); values.push(JSON.stringify(parseRecord(body.anchor, "anchor"))); }
  if ("resolved" in body) { sets.push("resolved=?"); values.push(body.resolved ? 1 : 0); }
  if (sets.length) {
    sets.push("updated_on=?"); values.push(new Date().toISOString());
    await c.env.DB.prepare(`UPDATE opentabl_content_comment SET ${sets.join(", ")} WHERE id=?`)
      .bind(...values, commentId).run();
  }
  const updated = await commentRow(c.env.DB, kind, contentId, commentId);
  await logAuditEntry(c.env.DB, "content.comment.update", { user, workspace_id: access.workspace_id },
    { id: commentId, type: "content_comment" }, { content_type: kind, content_id: contentId });
  return c.json(serializeComment(updated));
});

collaboration.delete("/:kind/:contentId/comments/:commentId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("contentId"));
  await getContentAccess(c.env.DB, user.id, kind, contentId, "COMMENTER");
  const existing = await commentRow(c.env.DB, kind, contentId, Number(c.req.param("commentId")));
  if (Number(existing.user_id) !== user.id) {
    await getContentAccess(c.env.DB, user.id, kind, contentId, "BUILDER");
  }
  await c.env.DB.prepare("UPDATE opentabl_content_comment SET trashed=1, updated_on=? WHERE id=?")
    .bind(new Date().toISOString(), existing.id).run();
  return c.body(null, 204);
});

collaboration.get("/:kind/:contentId/versions/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("contentId"));
  await getContentAccess(c.env.DB, user.id, kind, contentId, "VIEWER");
  const rows = await c.env.DB.prepare(
    `SELECT v.*, u.first_name, u.username, u.email
       FROM opentabl_content_version v LEFT JOIN auth_user u ON u.id=v.created_by_id
      WHERE v.content_type=? AND v.content_id=? ORDER BY v.created_on DESC LIMIT 200`
  ).bind(kind, contentId).all<any>();
  return c.json((rows.results || []).map((row) => ({
    id: Number(row.id), name: row.name, automatic: Boolean(row.automatic),
    editor_schema_version: Number(row.editor_schema_version), created_on: row.created_on,
    created_by: row.created_by_id ? { id: Number(row.created_by_id), name: row.first_name || row.username || row.email } : null,
  })));
});

collaboration.post("/:kind/:contentId/versions/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("contentId"));
  const access = await getContentAccess(c.env.DB, user.id, kind, contentId, "EDITOR");
  const body = await c.req.json<any>().catch(() => ({}));
  const row = await createContentVersion(c.env, access, {
    name: String(body.name || "Version nommée"), automatic: false, createdById: user.id,
  });
  return c.json({ id: Number(row.id), name: row.name, automatic: false, created_on: row.created_on }, 201);
});

collaboration.post("/:kind/:contentId/versions/:versionId/restore/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("contentId"));
  const access = await getContentAccess(c.env.DB, user.id, kind, contentId, "BUILDER");
  const version = await c.env.DB.prepare(
    "SELECT * FROM opentabl_content_version WHERE id=? AND content_type=? AND content_id=?"
  ).bind(Number(c.req.param("versionId")), kind, contentId).first<any>();
  if (!version) throw new DoesNotExist("Version", Number(c.req.param("versionId")));
  const object = await c.env.FILES.get(String(version.object_key));
  if (!object) throw new DoesNotExist("Fichier de version", Number(version.id));
  const payload = JSON.parse(await object.text()) as { content?: Record<string, unknown> };
  if (!payload.content) throw new ValidationError("Cette version est illisible.");
  await createContentVersion(c.env, access, { name: "Avant restauration", automatic: false, createdById: user.id });
  await persistMaterializedContent(c.env.DB, kind, contentId, payload.content);
  await logAuditEntry(c.env.DB, "content.version.restore", { user, workspace_id: access.workspace_id },
    { id: contentId, type: kind }, { version_id: Number(version.id) });
  return c.json({ restored: true, content: payload.content });
});

collaboration.delete("/:kind/:contentId/versions/:versionId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("contentId"));
  await getContentAccess(c.env.DB, user.id, kind, contentId, "BUILDER");
  const row = await c.env.DB.prepare(
    "SELECT id, object_key FROM opentabl_content_version WHERE id=? AND content_type=? AND content_id=?"
  ).bind(Number(c.req.param("versionId")), kind, contentId).first<any>();
  if (!row) throw new DoesNotExist("Version", Number(c.req.param("versionId")));
  await c.env.FILES.delete(String(row.object_key));
  await c.env.DB.prepare("DELETE FROM opentabl_content_version WHERE id=?").bind(row.id).run();
  return c.body(null, 204);
});

collaboration.get("/:kind/:contentId/materialized/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const access = await getContentAccess(c.env.DB, user.id, c.req.param("kind"), Number(c.req.param("contentId")), "VIEWER");
  return c.json({
    content: materializedContent(access),
    editor_schema_version: access.editor_schema_version,
    read_only: access.editor_schema_version > 1,
  });
});

export { collaboration as collaborationRouter };
