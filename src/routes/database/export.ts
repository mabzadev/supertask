import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware, optionalAuthMiddleware } from "../../middleware/auth";
import { DoesNotExist, PermissionError, ValidationError } from "../../middleware/error";
import { buildTableExport, type TableExportOptions } from "../../services/table-export";
import { assertHasApplicationRole, assertHasTableRole, assertHasViewRole, assertHasWorkspaceRole } from "../../services/enterprise-permissions";
import { buildFileUrl } from "../../services/secure-file-serve";
import { viewRouter } from "./views";
const r = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const publicViewExport = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const PUBLIC_VIEW_AUTHORIZATION_HEADER = "Baserow-View-Authorization";

publicViewExport.patch("/:viewId/premium", authMiddleware, async (c) => {
  const viewId = Number(c.req.param("viewId"));
  if (!Number.isInteger(viewId) || viewId <= 0) throw new ValidationError("A valid view id is required.");
  const body = await c.req.json<Record<string, unknown>>();
  const values: Record<string, boolean> = {};
  for (const key of ["show_logo", "allow_public_export"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") throw new ValidationError(`${key} must be a boolean.`);
    values[key] = body[key];
  }

  const url = new URL(c.req.url);
  url.pathname = `/${viewId}/`;
  const headers = new Headers(c.req.raw.headers);
  headers.set("Content-Type", "application/json");
  return viewRouter.fetch(new Request(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(values),
  }), c.env, c.executionCtx);
});

async function mediaUrl(env: Env, key: string, workspaceId?: number | null) {
  return buildFileUrl(env, key, workspaceId);
}

async function requireTableAccess(db: D1Database, userId: number, tableId: number) {
  const table = await db.prepare(
    `SELECT t.id, t.name, t.database_id, a.workspace_id
     FROM database_table t
     JOIN core_application a ON a.id = t.database_id
     WHERE t.id=? AND t.trashed=0`
  ).bind(tableId).first<any>();
  if (!table) throw new DoesNotExist("Table", tableId);
  await assertHasTableRole(db, userId, table, "VIEWER");
  return table;
}

async function requireWorkspaceAccess(db: D1Database, userId: number, workspaceId: number) {
  await assertHasWorkspaceRole(db, userId, workspaceId, "BUILDER");
}

async function createFinishedExportJob(
  env: Env,
  userId: number | null,
  tableId: number | null,
  exporterType: string,
  key: string,
  options: object = {},
  jobType = "export_table",
  viewId: number | null = null,
  workspaceId: number | null = null
) {
  const now = new Date().toISOString();
  const job = await env.DB.prepare(
    `INSERT INTO core_job (user_id, type, status, progress_percentage, created_on, updated_on)
     VALUES (?, ?, 'finished', 100, ?, ?) RETURNING *`
  ).bind(userId, jobType, now, now).first<any>();
  if (!job) throw new Error("Failed to create export job");

  await env.DB.prepare(
    `INSERT INTO database_exportjob (job_ptr_id, table_id, view_id, exporter_type, export_options, exported_file_name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    job.id,
    tableId,
    viewId,
    exporterType,
    JSON.stringify(options),
    key,
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  ).run();

  const url = await mediaUrl(env, key, workspaceId);
  return {
    id: job.id,
    job_id: job.id,
    type: job.type,
    state: "finished",
    status: "finished",
    progress_percentage: 100,
    url,
    exported_file_url: url,
    exporter_type: exporterType,
    created_on: now,
    updated_on: now,
  };
}

function jwtSecret(env: Env, value: string): Uint8Array {
  return new TextEncoder().encode(value || env.JWT_SIGNING_KEY || env.SECRET_KEY);
}

function publicViewHasPassword(view: any): boolean {
  const password = view?.public_view_password;
  return password !== null && password !== undefined && String(password) !== "";
}

function publicViewJwtSecret(env: Env, view: any): Uint8Array {
  return jwtSecret(env, `${view.slug}-${view.public_view_password || ""}-${env.SECRET_KEY || env.JWT_SIGNING_KEY}`);
}

function getPublicViewAuthorizationToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ", 2);
  if (scheme !== "JWT" || !token) return null;
  return token;
}

async function isPublicViewTokenValid(env: Env, view: any, token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, publicViewJwtSecret(env, view));
    return payload.slug_id === view.slug;
  } catch {
    return false;
  }
}

async function requirePublicViewAccess(env: Env, view: any, authorizationHeader: string | undefined, userId?: number): Promise<void> {
  if (!publicViewHasPassword(view)) return;
  if (userId) {
    try {
      await assertHasViewRole(env.DB, userId, Number(view.id), "VIEWER");
      return;
    } catch (error) {
      if (!(error instanceof PermissionError)) throw error;
    }
  }
  const token = getPublicViewAuthorizationToken(authorizationHeader);
  if (await isPublicViewTokenValid(env, view, token)) return;
  throw new PermissionError("The view is password protected.");
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getPublicVisibleFieldIds(db: D1Database, view: any): Promise<number[]> {
  if (view.type === "grid") {
    const rows = await db.prepare(
      `SELECT f.id
       FROM database_field f
       JOIN database_gridviewfieldoptions o ON o.field_id=f.id AND o.grid_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND o.hidden=0
       ORDER BY f."primary" DESC, o.[order] ASC, f.id ASC`
    ).bind(view.id, view.table_id).all<any>();
    return (rows.results || []).map((row: any) => Number(row.id));
  }

  if (view.type === "gallery") {
    const coverFieldId = numberOrNull(view.card_cover_image_field);
    const rows = await db.prepare(
      `SELECT f.id
       FROM database_field f
       LEFT JOIN database_galleryviewfieldoptions o ON o.field_id=f.id AND o.gallery_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND (o.hidden=0 OR f.id=?)
       ORDER BY COALESCE(o.[order], f.[order]) ASC, f.id ASC`
    ).bind(view.id, view.table_id, coverFieldId).all<any>();
    return (rows.results || []).map((row: any) => Number(row.id));
  }

  if (view.type === "form") {
    const rows = await db.prepare(
      `SELECT f.id
       FROM database_field f
       JOIN database_formviewfieldoptions o ON o.field_id=f.id AND o.form_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND o.enabled=1
       ORDER BY f."primary" DESC, o.[order] ASC, f.id ASC`
    ).bind(view.id, view.table_id).all<any>();
    return (rows.results || []).map((row: any) => Number(row.id));
  }

  if (view.type === "kanban") {
    const singleSelectFieldId = numberOrNull(view.single_select_field);
    const coverFieldId = numberOrNull(view.card_cover_image_field);
    const rows = await db.prepare(
      `SELECT f.id
       FROM database_field f
       LEFT JOIN database_gridviewfieldoptions o ON o.field_id=f.id AND o.grid_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND (o.hidden=0 OR f.id=? OR f.id=?)
       ORDER BY COALESCE(o.[order], f.[order]) ASC, f.id ASC`
    ).bind(view.id, view.table_id, singleSelectFieldId, coverFieldId).all<any>();
    return (rows.results || []).map((row: any) => Number(row.id));
  }

  if (view.type === "calendar") {
    const dateFieldId = numberOrNull(view.date_field);
    const rows = await db.prepare(
      `SELECT f.id
       FROM database_field f
       LEFT JOIN database_gridviewfieldoptions o ON o.field_id=f.id AND o.grid_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND (o.hidden=0 OR f.id=?)
       ORDER BY COALESCE(o.[order], f.[order]) ASC, f.id ASC`
    ).bind(view.id, view.table_id, dateFieldId).all<any>();
    return (rows.results || []).map((row: any) => Number(row.id));
  }

  if (view.type === "timeline") {
    const startDateFieldId = numberOrNull(view.start_date_field);
    const endDateFieldId = numberOrNull(view.end_date_field);
    const rows = await db.prepare(
      `SELECT f.id
       FROM database_field f
       LEFT JOIN database_gridviewfieldoptions o ON o.field_id=f.id AND o.grid_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND (o.hidden=0 OR f.id=? OR f.id=?)
       ORDER BY COALESCE(o.[order], f.[order]) ASC, f.id ASC`
    ).bind(view.id, view.table_id, startDateFieldId, endDateFieldId).all<any>();
    return (rows.results || []).map((row: any) => Number(row.id));
  }

  return [];
}

function publicExportJobSecret(env: Env): Uint8Array {
  return jwtSecret(env, `public-view-export-${env.SECRET_KEY || env.JWT_SIGNING_KEY}`);
}

async function signPublicExportJobId(env: Env, jobId: number): Promise<string> {
  return new SignJWT({ job_id: jobId })
    .setProtectedHeader({ alg: "HS256" })
    .sign(publicExportJobSecret(env));
}

async function verifyPublicExportJobId(env: Env, signedJobId: string): Promise<number> {
  try {
    const { payload } = await jwtVerify(signedJobId, publicExportJobSecret(env));
    const jobId = Number(payload.job_id);
    if (Number.isInteger(jobId) && jobId > 0) return jobId;
  } catch {
    // Fall through to the Baserow-compatible not-found response below.
  }
  throw new DoesNotExist("Export job", signedJobId);
}

async function getPublicExportView(db: D1Database, slug: string) {
  const view = await db.prepare(
    `SELECT v.*, t.name AS table_name, t.database_id, a.workspace_id
     FROM database_view v
     JOIN database_table t ON t.id=v.table_id
     JOIN core_application a ON a.id=t.database_id
     WHERE v.slug=? AND v.public=1 AND v.trashed=0 AND t.trashed=0 AND a.trashed=0`
  ).bind(slug).first<any>();
  if (!view) throw new DoesNotExist("View", slug);
  if (!Boolean(view.allow_public_export)) {
    throw new ValidationError("Public export is not enabled for this view.");
  }
  return view;
}

function restrictPublicExportOptions(body: TableExportOptions, view: any, visibleFieldIds: number[]): TableExportOptions {
  const visible = new Set(visibleFieldIds);
  const requested = Array.isArray(body.fields)
    ? body.fields.map((id) => Number(id)).filter((id) => visible.has(id))
    : visibleFieldIds;
  return {
    ...body,
    view_id: Number(view.id),
    fields: requested,
  };
}

r.post("/table/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const body = await c.req.json<TableExportOptions>();
  const table = await requireTableAccess(c.env.DB, user.id, tableId);
  if (body.view_id !== undefined && body.view_id !== null) {
    await assertHasViewRole(c.env.DB, user.id, Number(body.view_id), "VIEWER");
  }
  const exporterType = body.exporter_type || "csv";
  let file;
  try {
    file = await buildTableExport(c.env.DB, tableId, { ...body, exporter_type: exporterType }, { files: c.env.FILES });
  } catch (error: any) {
    if (error?.message === "EXPORT_VIEW_DOES_NOT_EXIST") throw new DoesNotExist("View", body.view_id || 0);
    if (error?.message === "EXPORTER_TYPE_DOES_NOT_EXIST") throw new ValidationError("The requested exporter type does not exist.");
    throw error;
  }
  const safeName = table.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "table";
  const key = `exports/table-${tableId}-${Date.now()}-${safeName}.${file.extension}`;
  await c.env.FILES.put(key, file.body, {
    httpMetadata: {
      contentType: file.contentType,
      contentDisposition: `attachment; filename="${safeName}.${file.extension}"`,
    },
  });

  return c.json(await createFinishedExportJob(c.env, user.id, tableId, exporterType, key, body, "export_table", null, table.workspace_id), 200);
});

r.post("/workspace/:workspaceId/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  await requireWorkspaceAccess(c.env.DB, user.id, workspaceId);

  const apps = await c.env.DB.prepare(
    `SELECT a.* FROM core_application a
     WHERE a.workspace_id=? AND a.trashed=0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)
     ORDER BY a.[order] ASC`
  ).bind(workspaceId).all<any>();
  const visibleApps = [];
  for (const app of apps.results || []) {
    try {
      await assertHasApplicationRole(c.env.DB, user.id, Number(app.id), "VIEWER");
      visibleApps.push(app);
    } catch {
      // A closer NO_ACCESS role on an application must not leak through workspace export metadata.
    }
  }
  const payload = {
    workspace_id: workspaceId,
    exported_at: new Date().toISOString(),
    applications: visibleApps,
  };
  const key = `exports/workspace-${workspaceId}-${Date.now()}.json`;
  await c.env.FILES.put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: {
      contentType: "application/json",
      contentDisposition: `attachment; filename="workspace-${workspaceId}.json"`,
    },
  });
  const job = await createFinishedExportJob(
    c.env,
    user.id,
    null,
    "json",
    key,
    { workspace_id: workspaceId },
    "export_applications",
    null,
    workspaceId
  );
  return c.json(job, 200);
});

r.get("/:jobId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const jobId = Number(c.req.param("jobId"));
  const row = await c.env.DB.prepare(
    `SELECT j.*, e.exported_file_name, e.exporter_type
     FROM core_job j
     JOIN database_exportjob e ON e.job_ptr_id = j.id
     WHERE j.id=?`
  ).bind(jobId).first<any>();
  if (!row) throw new DoesNotExist("Export job", jobId);
  if (row.user_id !== user.id && !user.is_staff) throw new PermissionError("Access denied.");
  let workspaceId: number | null = null;
  if (row.exported_file_name) {
    const workspace = await c.env.DB.prepare(
      `SELECT COALESCE(
          json_extract(e.export_options, '$.workspace_id'),
          a.workspace_id
        ) AS workspace_id
       FROM database_exportjob e
       LEFT JOIN database_table t ON t.id=e.table_id
       LEFT JOIN core_application a ON a.id=t.database_id
       WHERE e.job_ptr_id=?`
    ).bind(row.id).first<{ workspace_id: number | null }>();
    workspaceId = workspace?.workspace_id === null || workspace?.workspace_id === undefined ? null : Number(workspace.workspace_id);
  }
  const url = row.exported_file_name ? await mediaUrl(c.env, row.exported_file_name, workspaceId) : null;
  return c.json({
    id: row.id,
    job_id: row.id,
    type: row.type,
    state: row.status,
    status: row.status,
    progress_percentage: row.progress_percentage,
    url,
    exported_file_url: url,
    exporter_type: row.exporter_type,
    created_on: row.created_on,
    updated_on: row.updated_on,
  });
});

publicViewExport.post("/:slug/export-public-view/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user");
  const view = await getPublicExportView(c.env.DB, slug);
  try {
    await requirePublicViewAccess(c.env, view, c.req.header(PUBLIC_VIEW_AUTHORIZATION_HEADER), user?.id);
  } catch (error) {
    if (error instanceof PermissionError) {
      return c.json({
        error: "ERROR_NO_AUTHORIZATION_TO_PUBLICLY_SHARED_VIEW",
        detail: "The view is password protected.",
      }, 401);
    }
    throw error;
  }

  const body = await c.req.json<TableExportOptions>().catch((): TableExportOptions => ({}));
  const exporterType = body.exporter_type || "csv";
  const visibleFieldIds = await getPublicVisibleFieldIds(c.env.DB, view);
  const options = restrictPublicExportOptions({ ...body, exporter_type: exporterType }, view, visibleFieldIds);
  let file;
  try {
    file = await buildTableExport(c.env.DB, Number(view.table_id), options, { files: c.env.FILES });
  } catch (error: any) {
    if (error?.message === "EXPORT_VIEW_DOES_NOT_EXIST") throw new DoesNotExist("View", view.id);
    if (error?.message === "EXPORTER_TYPE_DOES_NOT_EXIST") throw new ValidationError("The requested exporter type does not exist.");
    throw error;
  }

  const safeName = String(view.table_name || view.name || "view").replace(/[^a-zA-Z0-9._-]/g, "_") || "view";
  const key = `exports/public-view-${view.id}-${Date.now()}-${safeName}.${file.extension}`;
  await c.env.FILES.put(key, file.body, {
    httpMetadata: {
      contentType: file.contentType,
      contentDisposition: `attachment; filename="${safeName}.${file.extension}"`,
    },
  });
  const job = await createFinishedExportJob(c.env, null, Number(view.table_id), exporterType, key, options, "export_table", Number(view.id), Number(view.workspace_id));
  const signedId = await signPublicExportJobId(c.env, Number(job.id));
  return c.json({ ...job, id: signedId, job_id: signedId }, 200);
});

publicViewExport.get("/get-public-view-export/:jobId/", async (c) => {
  const signedJobId = c.req.param("jobId");
  const jobId = await verifyPublicExportJobId(c.env, signedJobId);
  const row = await c.env.DB.prepare(
    `SELECT j.*, e.exported_file_name, e.exporter_type
     FROM core_job j
     JOIN database_exportjob e ON e.job_ptr_id=j.id
     WHERE j.id=? AND j.user_id IS NULL`
  ).bind(jobId).first<any>();
  if (!row) throw new DoesNotExist("Export job", signedJobId);
  const workspace = row.exported_file_name ? await c.env.DB.prepare(
    `SELECT a.workspace_id
     FROM database_exportjob e
     JOIN database_table t ON t.id=e.table_id
     JOIN core_application a ON a.id=t.database_id
     WHERE e.job_ptr_id=?`
  ).bind(row.id).first<{ workspace_id: number }>() : null;
  const url = row.exported_file_name ? await mediaUrl(c.env, row.exported_file_name, workspace?.workspace_id ?? null) : null;
  const nextSignedId = await signPublicExportJobId(c.env, Number(row.id));
  return c.json({
    id: nextSignedId,
    job_id: nextSignedId,
    type: row.type,
    state: row.status,
    status: row.status,
    progress_percentage: row.progress_percentage,
    url,
    exported_file_url: url,
    exporter_type: row.exporter_type,
    created_on: row.created_on,
    updated_on: row.updated_on,
  });
});
export { r as exportRouter, publicViewExport as publicViewExportRouter };
