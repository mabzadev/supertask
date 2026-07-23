import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { DoesNotExist, PermissionError, ValidationError } from "../middleware/error";
import type { JobType } from "../types/env";
import { logAuditEntry } from "../services/audit-log";
import { assertHasFieldRole, assertHasWorkspaceRole } from "../services/enterprise-permissions";

const jobs = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function serializeJob(j: any): object {
  let result: any = null;
  try {
    result = j.result ? JSON.parse(j.result) : null;
  } catch {
    result = null;
  }
  return {
    id: j.id,
    type: j.type,
    state: j.status,
    status: j.status,
    progress_percentage: j.progress_percentage ?? 0,
    error: j.error || null,
    human_readable_error: j.human_readable_error || null,
    result,
    ...(result && typeof result === "object" ? result : {}),
    user_id: j.user_id,
    created_on: j.created_on,
    updated_on: j.updated_on,
  };
}

function parseCsvQuery(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function requireWorkspaceAccess(db: D1Database, userId: number, workspaceId: number, role = "VIEWER"): Promise<void> {
  await assertHasWorkspaceRole(db, userId, workspaceId, role);
}

async function workspaceName(db: D1Database, workspaceId: number): Promise<string> {
  if (!workspaceId) return "";
  const row = await db.prepare("SELECT name FROM core_workspace WHERE id=?").bind(workspaceId).first<{ name: string }>();
  return row?.name || "";
}

async function tableWorkspaceContext(db: D1Database, tableId: number): Promise<{ workspace_id: number | null; workspace_name: string; table_name: string }> {
  const row = await db.prepare(
    `SELECT a.workspace_id, w.name AS workspace_name, t.name AS table_name
       FROM database_table t
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspace w ON w.id=a.workspace_id
      WHERE t.id=?`
  ).bind(tableId).first<any>();
  return {
    workspace_id: row?.workspace_id ? Number(row.workspace_id) : null,
    workspace_name: row?.workspace_name || "",
    table_name: row?.table_name || "",
  };
}

async function fieldWorkspaceContext(db: D1Database, fieldId: number): Promise<{ workspace_id: number | null; workspace_name: string; table_id: number | null; table_name: string; field_name: string; field_type: string }> {
  const row = await db.prepare(
    `SELECT a.workspace_id, w.name AS workspace_name, t.id AS table_id,
            t.name AS table_name, f.name AS field_name, f.type AS field_type
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspace w ON w.id=a.workspace_id
      WHERE f.id=? AND f.trashed=0 AND t.trashed=0`
  ).bind(fieldId).first<any>();
  return {
    workspace_id: row?.workspace_id ? Number(row.workspace_id) : null,
    workspace_name: row?.workspace_name || "",
    table_id: row?.table_id ? Number(row.table_id) : null,
    table_name: row?.table_name || "",
    field_name: row?.field_name || "",
    field_type: row?.field_type || "",
  };
}

function validateAirtableJob(body: Record<string, unknown>): void {
  const url = String(body.airtable_share_url || "");
  if (!body.workspace_id) throw new ValidationError("workspace_id is required.");
  if (!/^https:\/\/airtable\.com\/(?:shr|app)[A-Za-z0-9]/.test(url)) {
    throw new ValidationError("airtable_share_url must be a public Airtable shared base URL.");
  }
  if (Boolean(body.session) !== Boolean(body.session_signature)) {
    throw new ValidationError("session and session_signature must be provided together.");
  }
}

async function validateGenerateAIValuesJob(db: D1Database, body: Record<string, unknown>, userId: number): Promise<number> {
  const fieldId = Number(body.field_id);
  if (!Number.isInteger(fieldId) || fieldId <= 0) throw new ValidationError("field_id is required.");
  const context = await fieldWorkspaceContext(db, fieldId);
  if (!context.workspace_id || context.field_type !== "ai") throw new DoesNotExist("Field", fieldId);
  await assertHasFieldRole(db, userId, fieldId, "EDITOR");
  if (body.row_ids !== undefined && (!Array.isArray(body.row_ids) || (body.row_ids as unknown[]).some((rowId) => !Number.isInteger(Number(rowId)) || Number(rowId) <= 0))) {
    throw new ValidationError("row_ids must be a list of row ids.");
  }
  if (body.view_id !== undefined && body.view_id !== null && (!Number.isInteger(Number(body.view_id)) || Number(body.view_id) <= 0)) {
    throw new ValidationError("view_id must be a valid view id.");
  }
  return context.workspace_id;
}

// ── GET /api/jobs/ — List jobs for current user ───────────────────────────────
jobs.get("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const status = c.req.query("status");
  const type = c.req.query("type");
  const states = parseCsvQuery(c.req.query("states"));
  const jobIds = parseCsvQuery(c.req.query("job_ids"))
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
  const limit = Math.min(50, parseInt(c.req.query("limit") || "20"));
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0"));

  let where = "user_id = ?";
  const params: any[] = [user.id];
  if (type) {
    where += " AND type = ?";
    params.push(type);
  }
  if (status) {
    where += " AND status = ?";
    params.push(status);
  }
  if (states.length > 0) {
    for (const state of states) {
      if (state.startsWith("!")) {
        where += " AND status != ?";
        params.push(state.slice(1));
      } else {
        where += " AND status = ?";
        params.push(state);
      }
    }
  }
  if (jobIds.length > 0) {
    where += ` AND id IN (${jobIds.map(() => "?").join(",")})`;
    params.push(...jobIds);
  }
  const generateAIValuesFieldId = Number(c.req.query("generate_ai_values_field_id"));
  if (Number.isInteger(generateAIValuesFieldId) && generateAIValuesFieldId > 0) {
    where += " AND json_extract(COALESCE(result, '{}'), '$.field_id') = ?";
    params.push(generateAIValuesFieldId);
  }

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM core_job WHERE ${where}`
  ).bind(...params).first<{ count: number }>();
  const res = await c.env.DB.prepare(
    `SELECT * FROM core_job WHERE ${where} ORDER BY created_on DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all<any>();

  const serialized = (res.results || []).map(serializeJob);
  return c.json({ jobs: serialized, count: count?.count ?? serialized.length, results: serialized });
});

// ── POST /api/jobs/ — Create a queued job ───────────────────────────────────
jobs.post("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ type: JobType; [key: string]: unknown }>();

  if (!body.type) {
    return c.json({ error: "MISSING_JOB_TYPE" }, 400);
  }
  if (body.type === "airtable" || body.type === "import_airtable") {
    validateAirtableJob(body);
    await requireWorkspaceAccess(c.env.DB, user.id, Number(body.workspace_id), "BUILDER");
  }
  if (body.type === "cleanup_user_files") {
    if (!user.is_staff) throw new PermissionError("Only staff users can clean orphan user files.");
    const targetUserId = Number(body.target_user_id || 0);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      throw new ValidationError("target_user_id is required for cleanup_user_files.");
    }
  }
  let workspaceId = Number(body.workspace_id || 0);
  let initialResult: Record<string, unknown> | null = null;
  if (body.type === "generate_ai_values") {
    workspaceId = await validateGenerateAIValuesJob(c.env.DB, body, user.id);
    initialResult = {
      field_id: Number(body.field_id),
      row_ids: Array.isArray(body.row_ids) ? body.row_ids.map(Number) : null,
      view_id: body.view_id === undefined ? null : Number(body.view_id),
      only_empty: Boolean(body.only_empty),
    };
  }

  const now = new Date().toISOString();
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
     VALUES (?, 'pending', 0, ?, ?, ?, ?) RETURNING *`
  ).bind(body.type, user.id, now, now, initialResult ? JSON.stringify(initialResult) : null).first<any>();
  if (!job) throw new Error("Failed to create job");

  await c.env.JOBS_QUEUE.send({
    job_id: job.id,
    job_type: body.type,
      payload: body,
      user_id: user.id,
      workspace_id: workspaceId,
    });
  await logAuditEntry(c.env.DB, "job.create", {
    user,
    workspace_id: workspaceId || null,
    workspace_name: await workspaceName(c.env.DB, workspaceId),
  }, { id: job.id, type: "job" }, {
    job_id: job.id,
    job_type: body.type,
    status: "pending",
    workspace_id: workspaceId || null,
  });

  return c.json(serializeJob(job), 202);
});

// ── GET /api/jobs/:jobId/ — Get job status (polling endpoint) ─────────────────
jobs.get("/:jobId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("jobId"));

  const job = await c.env.DB.prepare(
    "SELECT * FROM core_job WHERE id=?"
  ).bind(id).first<any>();

  if (!job) throw new DoesNotExist("Job", id);

  // Users can only see their own jobs (unless staff)
  if (job.user_id !== user.id && !user.is_staff) {
    throw new PermissionError("Access denied.");
  }

  return c.json(serializeJob(job));
});

// ── DELETE /api/jobs/:jobId/ — Cancel/delete a pending job ────────────────────
jobs.delete("/:jobId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("jobId"));

  const job = await c.env.DB.prepare(
    "SELECT * FROM core_job WHERE id=?"
  ).bind(id).first<any>();

  if (!job) throw new DoesNotExist("Job", id);
  if (job.user_id !== user.id && !user.is_staff) throw new PermissionError("Access denied.");

  // Only pending jobs can be cancelled
  if (job.status === "running") {
    return c.json({ error: "CANNOT_CANCEL_RUNNING_JOB" }, 400);
  }

  await c.env.DB.prepare("DELETE FROM core_job WHERE id=?").bind(id).run();
  await logAuditEntry(c.env.DB, "job.delete", {
    user,
  }, { id, type: "job" }, {
    job_id: id,
    job_type: job.type,
    previous_status: job.status,
  });
  return c.json({});
});

// ── POST /api/jobs/:jobId/cancel/ — Frontend cancel contract ────────────────
jobs.post("/:jobId/cancel/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("jobId"));

  const job = await c.env.DB.prepare(
    "SELECT * FROM core_job WHERE id=?"
  ).bind(id).first<any>();

  if (!job) throw new DoesNotExist("Job", id);
  if (job.user_id !== user.id && !user.is_staff) throw new PermissionError("Access denied.");

  if (job.status === "running") {
    return c.json({ error: "CANNOT_CANCEL_RUNNING_JOB" }, 400);
  }

  await c.env.DB.prepare("UPDATE core_job SET status='cancelled', updated_on=? WHERE id=?")
    .bind(new Date().toISOString(), id)
    .run();
  const updated = await c.env.DB.prepare("SELECT * FROM core_job WHERE id=?").bind(id).first<any>();
  await logAuditEntry(c.env.DB, "job.cancel", {
    user,
  }, { id, type: "job" }, {
    job_id: id,
    job_type: job.type,
    previous_status: job.status,
    status: "cancelled",
  });
  return c.json(serializeJob(updated));
});

// ── POST /api/jobs/export-table/ — Start table export ────────────────────────
jobs.post("/export-table/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ table_id: number; exporter_type?: string; filters?: any; sortings?: any }>();

  if (!body.table_id) return c.json({ error: "MISSING_TABLE_ID" }, 400);

  const now = new Date().toISOString();
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on)
     VALUES ('export_table', 'pending', 0, ?, ?, ?) RETURNING id`
  ).bind(user.id, now, now).first<{ id: number }>();

  if (job) {
    await c.env.JOBS_QUEUE.send({
      job_id: job.id,
      job_type: "export_table",
      payload: {
        table_id: body.table_id,
        exporter_type: body.exporter_type || "csv",
        filters: body.filters || [],
        sortings: body.sortings || [],
      },
      user_id: user.id,
      workspace_id: 0,
    });
    const context = await tableWorkspaceContext(c.env.DB, body.table_id);
    await logAuditEntry(c.env.DB, "job.create", {
      user,
      workspace_id: context.workspace_id,
      workspace_name: context.workspace_name,
    }, { id: job.id, type: "job" }, {
      job_id: job.id,
      job_type: "export_table",
      status: "pending",
      table_id: body.table_id,
      table_name: context.table_name,
      exporter_type: body.exporter_type || "csv",
    });
  }

  return c.json(serializeJob({ id: job?.id, type: "export_table", status: "pending", progress_percentage: 0, user_id: user.id, created_on: now, updated_on: now }), 202);
});

// ── POST /api/jobs/import-csv/ — Start CSV import ────────────────────────────
jobs.post("/import-csv/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const tableIdRaw = formData.get("table_id");

  if (!file || !tableIdRaw) {
    return c.json({ error: "MISSING_FIELDS", detail: "file and table_id required" }, 400);
  }

  const tableId = parseInt(String(tableIdRaw));
  const key = `imports/${user.id}/${Date.now()}-${file.name}`;
  await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

  const now = new Date().toISOString();
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on)
     VALUES ('import_csv', 'pending', 0, ?, ?, ?) RETURNING id`
  ).bind(user.id, now, now).first<{ id: number }>();

  if (job) {
    await c.env.JOBS_QUEUE.send({
      job_id: job.id,
      job_type: "import_csv",
      payload: { table_id: tableId, file_key: key },
      user_id: user.id,
      workspace_id: 0,
    });
    const context = await tableWorkspaceContext(c.env.DB, tableId);
    await logAuditEntry(c.env.DB, "job.create", {
      user,
      workspace_id: context.workspace_id,
      workspace_name: context.workspace_name,
    }, { id: job.id, type: "job" }, {
      job_id: job.id,
      job_type: "import_csv",
      status: "pending",
      table_id: tableId,
      table_name: context.table_name,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type || "application/octet-stream",
    });
  }

  return c.json(serializeJob({ id: job?.id, type: "import_csv", status: "pending", progress_percentage: 0, user_id: user.id, created_on: now, updated_on: now }), 202);
});

export { jobs as jobsRouter };
