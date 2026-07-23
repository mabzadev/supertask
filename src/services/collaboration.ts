import { DoesNotExist, ValidationError } from "../middleware/error";
import { assertHasApplicationRole } from "./enterprise-permissions";

export const CONTENT_KINDS = ["document-page", "whiteboard-canvas"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export interface ContentAccess {
  kind: ContentKind;
  id: number;
  application_id: number;
  workspace_id: number;
  name: string;
  editor_schema_version: number;
  row: Record<string, any>;
}

export function contentKind(value: unknown): ContentKind {
  if (CONTENT_KINDS.includes(value as ContentKind)) return value as ContentKind;
  throw new ValidationError("Type de contenu collaboratif invalide.");
}

export async function getContentAccess(
  db: D1Database,
  userId: number,
  kindValue: unknown,
  id: number,
  role = "VIEWER",
): Promise<ContentAccess> {
  const kind = contentKind(kindValue);
  if (!Number.isInteger(id) || id <= 0) throw new DoesNotExist("Contenu", id);
  const row = kind === "document-page"
    ? await db.prepare(
      `SELECT p.*, a.workspace_id, a.id AS application_id
         FROM opentabl_document_page p
         JOIN core_application a ON a.id=p.document_id
        WHERE p.id=? AND a.type='document' AND a.trashed=0`
    ).bind(id).first<Record<string, any>>()
    : await db.prepare(
      `SELECT c.*, a.workspace_id, a.id AS application_id
         FROM opentabl_whiteboard_canvas c
         JOIN core_application a ON a.id=c.whiteboard_id
        WHERE c.id=? AND c.trashed=0 AND a.type='whiteboard' AND a.trashed=0`
    ).bind(id).first<Record<string, any>>();
  if (!row) throw new DoesNotExist(kind === "document-page" ? "Page" : "Canevas", id);
  await assertHasApplicationRole(db, userId, Number(row.application_id), role);
  return {
    kind,
    id,
    application_id: Number(row.application_id),
    workspace_id: Number(row.workspace_id),
    name: String(kind === "document-page" ? row.title || "Sans titre" : row.name || "Canevas"),
    editor_schema_version: Math.max(1, Number(row.editor_schema_version) || 1),
    row,
  };
}

function parseJson(value: unknown, fallback: unknown) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

export function materializedContent(access: ContentAccess) {
  if (access.kind === "document-page") {
    return {
      title: String(access.row.title || ""),
      content: parseJson(access.row.content, access.row.content || ""),
      icon: String(access.row.icon || ""),
      cover: String(access.row.cover || ""),
      settings: parseJson(access.row.settings, {}),
      editor_schema_version: access.editor_schema_version,
    };
  }
  return {
    name: String(access.row.name || ""),
    icon: String(access.row.icon || "🧠"),
    state: parseJson(access.row.state, { nodes: [], edges: [], strokes: [] }),
    settings: parseJson(access.row.settings, {}),
    editor_schema_version: access.editor_schema_version,
  };
}

export async function persistMaterializedContent(
  db: D1Database,
  kind: ContentKind,
  id: number,
  value: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  if (kind === "document-page") {
    await db.prepare(
      `UPDATE opentabl_document_page
          SET title=?, content=?, icon=?, cover=?, settings=?, editor_schema_version=?,
              collaboration_initialized=1, updated_on=?
        WHERE id=?`
    ).bind(
      String(value.title || ""),
      JSON.stringify(value.content ?? ""),
      String(value.icon || ""),
      String(value.cover || ""),
      JSON.stringify(value.settings || {}),
      Math.max(1, Number(value.editor_schema_version) || 1),
      now,
      id,
    ).run();
    return;
  }
  await db.prepare(
    `UPDATE opentabl_whiteboard_canvas
        SET name=?, icon=?, state=?, settings=?, editor_schema_version=?, updated_on=?
      WHERE id=? AND trashed=0`
  ).bind(
    String(value.name || ""),
    String(value.icon || "🧠"),
    JSON.stringify(value.state || { nodes: [], edges: [], strokes: [] }),
    JSON.stringify(value.settings || {}),
    Math.max(1, Number(value.editor_schema_version) || 1),
    now,
    id,
  ).run();
}

export async function createContentVersion(
  env: { DB: D1Database; FILES: R2Bucket },
  access: ContentAccess,
  options: { name?: string | null; automatic?: boolean; createdById?: number | null } = {},
) {
  const automatic = options.automatic !== false;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const objectKey = `collaboration/versions/${access.kind}/${access.id}/${id}.json`;
  const payload = JSON.stringify({
    version: 1,
    kind: access.kind,
    content_id: access.id,
    created_on: now,
    editor_schema_version: access.editor_schema_version,
    content: materializedContent(access),
  });
  await env.FILES.put(objectKey, payload, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { kind: access.kind, contentId: String(access.id) },
  });
  const row = await env.DB.prepare(
    `INSERT INTO opentabl_content_version
     (content_type, content_id, name, automatic, object_key, editor_schema_version, created_by_id, created_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    access.kind,
    access.id,
    options.name ? String(options.name).slice(0, 160) : null,
    automatic ? 1 : 0,
    objectKey,
    access.editor_schema_version,
    options.createdById ?? null,
    now,
  ).first<any>();
  return row;
}
