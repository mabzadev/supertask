import type { Env } from "../types/env";

type AIFieldRow = {
  id: number;
  workspace_id: number;
  field_settings: string | null;
};

async function activeAutoUpdateUser(env: Pick<Env, "DB">, field: AIFieldRow): Promise<number | null> {
  const settings = parseSettings(field.field_settings);
  if (settings.ai_auto_update !== true) return null;
  const userId = Number(settings.ai_auto_update_user_id || 0);
  const membership = userId > 0
    ? await env.DB.prepare(
      `SELECT 1 AS allowed
       FROM core_workspaceuser wu
       JOIN auth_user u ON u.id=wu.user_id
       LEFT JOIN core_userprofile p ON p.user_id=u.id
       WHERE wu.workspace_id=? AND wu.user_id=? AND wu.to_be_deleted=0
         AND u.is_active=1 AND COALESCE(p.to_be_deleted, 0)=0`
    ).bind(field.workspace_id, userId).first<{ allowed: number }>()
    : null;
  if (membership) return userId;
  settings.ai_auto_update = false;
  settings.ai_auto_update_user_id = null;
  await env.DB.prepare("UPDATE database_field SET field_settings=?, updated_on=? WHERE id=?")
    .bind(JSON.stringify(settings), new Date().toISOString(), field.id)
    .run();
  await env.DB.prepare("DELETE FROM premium_aifieldscheduledupdate WHERE field_id=?").bind(field.id).run();
  return null;
}

export async function queueScheduledAIFieldUpdate(
  env: Pick<Env, "DB" | "JOBS_QUEUE">,
  field: AIFieldRow,
  excludeJobId?: number
): Promise<boolean> {
  const userId = await activeAutoUpdateUser(env, field);
  if (!userId) return false;
  const active = await env.DB.prepare(
    `SELECT id FROM core_job
     WHERE type='generate_ai_values' AND status IN ('pending', 'running')
       AND json_extract(COALESCE(result, '{}'), '$.field_id')=?
       AND json_extract(COALESCE(result, '{}'), '$.is_auto_update')=1
       ${excludeJobId ? "AND id<>?" : ""}
     LIMIT 1`
  ).bind(...(excludeJobId ? [field.id, excludeJobId] : [field.id])).first<{ id: number }>();
  if (active) return false;

  const now = new Date().toISOString();
  const result = {
    field_id: Number(field.id),
    row_ids: null,
    view_id: null,
    only_empty: false,
    is_auto_update: true,
  };
  const job = await env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
     VALUES ('generate_ai_values', 'pending', 0, ?, ?, ?, ?) RETURNING id`
  ).bind(userId, now, now, JSON.stringify(result)).first<{ id: number }>();
  if (!job) return false;
  await env.JOBS_QUEUE.send({
    job_id: job.id,
    job_type: "generate_ai_values",
    payload: result,
    user_id: userId,
    workspace_id: Number(field.workspace_id),
  });
  return true;
}

function parseSettings(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function enqueueAutomaticAIUpdates(
  env: Pick<Env, "DB" | "JOBS_QUEUE">,
  tableId: number,
  rowIds: number[],
  changedFieldIds: Set<number>
): Promise<number> {
  const ids = [...changedFieldIds].filter((id) => Number.isInteger(id) && id > 0);
  const rows = [...new Set(rowIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0 || rows.length === 0) return 0;

  const fields = await env.DB.prepare(
    `SELECT DISTINCT ai.id, ai.field_settings, a.workspace_id
     FROM database_fielddependency d
     JOIN database_field ai ON ai.id=d.dependant_id
     JOIN database_table t ON t.id=ai.table_id
     JOIN core_application a ON a.id=t.database_id
     WHERE d.dependency_id IN (${ids.map(() => "?").join(",")})
       AND ai.table_id=? AND ai.type='ai' AND ai.trashed=0 AND t.trashed=0`
  ).bind(...ids, tableId).all<AIFieldRow>();
  let enqueued = 0;

  for (const field of fields.results || []) {
    const now = new Date().toISOString();
    for (const rowId of rows) {
      await env.DB.prepare(
        `INSERT INTO premium_aifieldscheduledupdate (field_id, row_id, updated_on)
         VALUES (?, ?, ?)
         ON CONFLICT(field_id, row_id) DO UPDATE SET updated_on=excluded.updated_on`
      ).bind(field.id, rowId, now).run();
    }
    if (await queueScheduledAIFieldUpdate(env, field)) enqueued += 1;
  }
  return enqueued;
}

export async function reschedulePendingAIUpdates(
  env: Pick<Env, "DB" | "JOBS_QUEUE">,
  excludeJobId?: number
): Promise<number> {
  const fields = await env.DB.prepare(
    `SELECT DISTINCT f.id, f.field_settings, a.workspace_id
     FROM premium_aifieldscheduledupdate s
     JOIN database_field f ON f.id=s.field_id
     JOIN database_table t ON t.id=f.table_id
     JOIN core_application a ON a.id=t.database_id
     WHERE f.type='ai' AND f.trashed=0 AND t.trashed=0 AND a.trashed=0`
  ).all<AIFieldRow>();
  let queued = 0;
  for (const field of fields.results || []) {
    if (await queueScheduledAIFieldUpdate(env, field, excludeJobId)) queued += 1;
  }
  return queued;
}
