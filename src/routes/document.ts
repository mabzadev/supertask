import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { DoesNotExist } from "../middleware/error";
import { assertHasApplicationRole } from "../services/enterprise-permissions";

const document = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

async function requireDocumentAccess(db: D1Database, userId: number, documentId: number, role = "VIEWER") {
  const app = await db.prepare(
    `SELECT a.id, a.workspace_id
     FROM core_application a
     WHERE a.id=? AND a.type='document' AND a.trashed=0`
  ).bind(documentId).first<any>();
  if (!app) throw new DoesNotExist("Document", documentId);
  await assertHasApplicationRole(db, userId, documentId, role);
  return app;
}

async function getPageWithAccess(db: D1Database, userId: number, pageId: number, role = "VIEWER") {
  const row = await db.prepare(
    `SELECT p.* FROM opentabl_document_page p
      JOIN core_application a ON a.id=p.document_id
     WHERE p.id=? AND a.type='document' AND a.trashed=0`
  ).bind(pageId).first<any>();
  if (!row) throw new DoesNotExist("DocumentPage", pageId);
  await assertHasApplicationRole(db, userId, Number(row.document_id), role);
  return row;
}

function parseContent(value: string | null | undefined) {
  if (!value) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseObject(value: string | null | undefined) {
  const parsed = parseContent(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function serializePage(row: any) {
  return {
    id: row.id,
    document_id: row.document_id,
    parent_id: row.parent_id ?? null,
    title: row.title || "",
    content: parseContent(row.content),
    icon: row.icon || "",
    cover: row.cover || "",
    settings: parseObject(row.settings),
    editor_schema_version: Number(row.editor_schema_version || 1),
    collaboration_initialized: Boolean(row.collaboration_initialized),
    order: row.order ?? 0,
    created_on: row.created_on,
    updated_on: row.updated_on,
  };
}

async function ensureDefaultPage(db: D1Database, documentId: number) {
  const existing = await db.prepare(
    "SELECT * FROM opentabl_document_page WHERE document_id=? ORDER BY [order] ASC, id ASC LIMIT 1"
  ).bind(documentId).first<any>();
  if (existing) return existing;

  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO opentabl_document_page
     (document_id, parent_id, title, content, icon, cover, settings, editor_schema_version,
      collaboration_initialized, [order], created_on, updated_on)
     VALUES (?, NULL, 'Untitled', '', '', '', '{}', 1, 0, 1, ?, ?)
     RETURNING *`
  ).bind(documentId, now, now).first<any>();
}

document.get("/:documentId/pages/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const documentId = Number(c.req.param("documentId"));
  await requireDocumentAccess(c.env.DB, user.id, documentId);
  await ensureDefaultPage(c.env.DB, documentId);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM opentabl_document_page WHERE document_id=? ORDER BY [order] ASC, id ASC"
  ).bind(documentId).all<any>();
  return c.json((rows.results || []).map(serializePage));
});

document.post("/:documentId/pages/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const documentId = Number(c.req.param("documentId"));
  const body = await c.req.json<any>().catch(() => ({}));
  await requireDocumentAccess(c.env.DB, user.id, documentId, "BUILDER");

  const maxOrder = await c.env.DB.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM opentabl_document_page WHERE document_id=?"
  ).bind(documentId).first<{ max_order: number }>();
  const now = new Date().toISOString();
  const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content || "");
  const row = await c.env.DB.prepare(
    `INSERT INTO opentabl_document_page
     (document_id, parent_id, title, content, icon, cover, settings, editor_schema_version,
      collaboration_initialized, [order], created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     RETURNING *`
  ).bind(
    documentId,
    body.parent_id ?? null,
    String(body.title ?? ""),
    content,
    String(body.icon ?? ""),
    String(body.cover ?? ""),
    JSON.stringify(body.settings && typeof body.settings === "object" ? body.settings : {}),
    Math.max(1, Number(body.editor_schema_version) || 1),
    (maxOrder?.max_order ?? 0) + 1,
    now,
    now
  ).first<any>();
  return c.json(serializePage(row), 201);
});

document.get("/pages/:pageId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  const row = await getPageWithAccess(c.env.DB, user.id, pageId);
  return c.json(serializePage(row));
});

document.patch("/pages/:pageId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  const body = await c.req.json<any>().catch(() => ({}));
  await getPageWithAccess(c.env.DB, user.id, pageId, "EDITOR");

  const sets: string[] = [];
  const values: unknown[] = [];
  if ("title" in body) { sets.push("title=?"); values.push(String(body.title ?? "")); }
  if ("content" in body) {
    sets.push("content=?");
    values.push(typeof body.content === "string" ? body.content : JSON.stringify(body.content || ""));
  }
  if ("icon" in body) { sets.push("icon=?"); values.push(String(body.icon ?? "")); }
  if ("cover" in body) { sets.push("cover=?"); values.push(String(body.cover ?? "")); }
  if ("settings" in body) {
    sets.push("settings=?");
    values.push(JSON.stringify(body.settings && typeof body.settings === "object" ? body.settings : {}));
  }
  if ("editor_schema_version" in body) {
    sets.push("editor_schema_version=?");
    values.push(Math.max(1, Number(body.editor_schema_version) || 1));
  }
  if ("collaboration_initialized" in body) {
    sets.push("collaboration_initialized=?");
    values.push(body.collaboration_initialized ? 1 : 0);
  }
  if ("parent_id" in body) { sets.push("parent_id=?"); values.push(body.parent_id ?? null); }
  if ("order" in body) { sets.push("[order]=?"); values.push(Number(body.order) || 0); }
  sets.push("updated_on=?"); values.push(new Date().toISOString());

  await c.env.DB.prepare(`UPDATE opentabl_document_page SET ${sets.join(", ")} WHERE id=?`)
    .bind(...values, pageId).run();
  const updated = await c.env.DB.prepare("SELECT * FROM opentabl_document_page WHERE id=?")
    .bind(pageId).first<any>();
  return c.json(serializePage(updated));
});

document.delete("/pages/:pageId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  await getPageWithAccess(c.env.DB, user.id, pageId, "BUILDER");
  await c.env.DB.prepare("DELETE FROM opentabl_document_page WHERE id=?").bind(pageId).run();
  return c.body(null, 204);
});

export { document as documentRouter };
