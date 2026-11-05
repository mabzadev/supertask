import type { Env } from "../types/env";
import { triggerDuePeriodicBuilderWorkflows } from "../services/builder";
import { triggerDuePeriodicAutomationWorkflows } from "../services/automation";
import { hasActiveDataSyncJob } from "../services/data-sync";
import { reschedulePendingAIUpdates } from "../services/ai-auto-update";
import { ASSISTANT_KNOWLEDGE_SOURCE_KEY } from "../services/assistant-knowledge";
import { recoverWebhookDeliveryQueue } from "../routes/database/webhooks";
import { permanentlyDeleteItem, type PermanentTrashEntry } from "../routes/trash";
import { cleanupExpiredUserFiles } from "../services/user-files";
import { deleteUserAccount, isLastActiveInstanceAdmin } from "../services/account-deletion";

async function claimCronWindow(cache: KVNamespace, key: string, window: string): Promise<boolean> {
  if (await cache.get(key) === window) return false;
  await cache.put(key, window);
  return true;
}

export async function handleCron(cron: string, env: Env, now = new Date()): Promise<void> {
  console.log(`[CRON] Running cron: ${cron}`);
  if (cron !== "*/5 * * * *") return;

  // One five-minute trigger replaces four independent polling schedules.
  await recoverWebhookDeliveryQueue(env);
  await triggerDuePeriodicBuilderWorkflows(env, now);
  await triggerDuePeriodicAutomationWorkflows(env, now);
  await triggerPeriodicDataSyncs(env);
  await reschedulePendingAIUpdates(env);
  await scheduleAssistantKnowledgeSync(env);

  const hourWindow = now.toISOString().slice(0, 13);
  if (await claimCronWindow(env.CACHE, "cron:last-hourly-window", hourWindow)) {
    await cleanupExpiredJobs(env);
    await cleanupExpiredTrash(env);
    await cleanupExpiredUserFiles(env);
  }

  // Run daily retention after 03:00 UTC, once per calendar day. The KV gate
  // also makes this resilient to a delayed or missed individual cron event.
  const dayWindow = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= 3 && await claimCronWindow(env.CACHE, "cron:last-daily-window", dayWindow)) {
    await cleanupExpiredAccounts(env);
    await cleanupExpiredContentVersions(env);
  }
}

export async function scheduleAssistantKnowledgeSync(env: Env): Promise<number | null> {
  if (!env.AI || !env.KNOWLEDGE_BASE) return null;
  const source = await env.FILES.head(ASSISTANT_KNOWLEDGE_SOURCE_KEY);
  if (!source) return null;
  const indexedEtag = await env.CACHE.get("assistant:knowledge:source-etag");
  if (indexedEtag === source.etag) return null;
  const retryCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const active = await env.DB.prepare(
    `SELECT id FROM core_job
      WHERE type='sync_assistant_knowledge'
        AND (
          status NOT IN ('finished', 'failed', 'cancelled', 'expired')
          OR (status='failed' AND updated_on>=?)
        )
      LIMIT 1`
  ).bind(retryCutoff).first<{ id: number }>();
  if (active) return active.id;
  const now = new Date().toISOString();
  const job = await env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
     VALUES ('sync_assistant_knowledge', 'pending', 0, NULL, ?, ?, ?) RETURNING id`
  ).bind(now, now, JSON.stringify({ source_etag: source.etag, indexed_chunks: 0 })).first<{ id: number }>();
  if (!job) throw new Error("Failed to create assistant knowledge sync job.");
  try {
    await env.JOBS_QUEUE.send({
      job_id: job.id,
      job_type: "sync_assistant_knowledge",
      payload: { source_etag: source.etag, offset: 0, deleted_vectors: 0 },
      user_id: 0,
      workspace_id: 0,
    });
  } catch (error) {
    await env.DB.prepare("DELETE FROM core_job WHERE id=?").bind(job.id).run();
    throw error;
  }
  return job.id;
}

export async function cleanupExpiredTrash(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  // Rows, comments and teams are cheap to remove. Schema/container removals can
  // cascade through many metadata tables or rewrite a user table, so process at
  // most one of those per run. This keeps D1 row reads bounded even if a large
  // trash backlog is imported or an index is accidentally removed later.
  const lightweightRows = await env.DB.prepare(
    `SELECT trash_item_type, trash_item_id, parent_trash_item_id,
            application_id AS application, workspace_id AS workspace
       FROM core_trasheditem
      WHERE (should_be_permanently_deleted=1 OR trashed_at<?)
        AND trash_item_type NOT IN ('workspace', 'application', 'table', 'field')
      ORDER BY should_be_permanently_deleted DESC, trashed_at ASC
      LIMIT 100`
  ).bind(cutoff).all<PermanentTrashEntry>();
  const structuralRows = await env.DB.prepare(
    `SELECT trash_item_type, trash_item_id, parent_trash_item_id,
            application_id AS application, workspace_id AS workspace
       FROM core_trasheditem
      WHERE (should_be_permanently_deleted=1 OR trashed_at<?)
        AND trash_item_type IN ('workspace', 'application', 'table', 'field')
      ORDER BY should_be_permanently_deleted DESC, trashed_at ASC
      LIMIT 1`
  ).bind(cutoff).all<PermanentTrashEntry>();
  let deleted = 0;
  for (const row of [...(lightweightRows.results || []), ...(structuralRows.results || [])]) {
    await permanentlyDeleteItem(env, row);
    deleted += 1;
  }
  return deleted;
}

export async function cleanupExpiredAccounts(env: Env): Promise<number> {
  let settings;
  try {
    settings = await env.DB.prepare("SELECT account_deletion_grace_delay FROM core_settings WHERE id=1")
      .first<{ account_deletion_grace_delay: number }>();
  } catch {
    return 0;
  }
  const graceDays = Math.max(0, Number(settings?.account_deletion_grace_delay ?? 30));
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000).toISOString();
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT user_id
         FROM core_userprofile
        WHERE to_be_deleted=1
          AND deletion_requested_at IS NOT NULL
          AND deletion_requested_at<=?
        ORDER BY deletion_requested_at ASC
        LIMIT 20`
    ).bind(cutoff).all<{ user_id: number }>();
  } catch (error: any) {
    if (String(error?.message || error).includes("deletion_requested_at")) return 0;
    throw error;
  }
  let deleted = 0;
  for (const row of rows.results || []) {
    if (await isLastActiveInstanceAdmin(env.DB, Number(row.user_id))) continue;
    if (await deleteUserAccount(env, Number(row.user_id))) deleted += 1;
  }
  return deleted;
}

async function cleanupExpiredContentVersions(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, object_key FROM supertask_content_version WHERE automatic=1 AND created_on < ? LIMIT 500"
  ).bind(cutoff).all<{ id: number; object_key: string }>();
  for (const row of rows.results || []) {
    await env.FILES.delete(row.object_key);
    await env.DB.prepare("DELETE FROM supertask_content_version WHERE id=?").bind(row.id).run();
  }
}

async function cleanupExpiredJobs(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE core_job SET status='expired' WHERE expires_at < ? AND status='finished'"
  ).bind(cutoff).run();
}

export async function triggerPeriodicDataSyncs(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const syncs = await env.DB.prepare(
    `SELECT ds.id, ds.table_id, a.workspace_id
       FROM database_datasync ds
       JOIN database_table t ON t.id=ds.table_id
       JOIN core_application a ON a.id=t.database_id
      WHERE ds.authorized=1
        AND COALESCE(ds.deactivated, 0)=0
        AND ds.periodic_interval IS NOT NULL
        AND ds.next_periodic_sync IS NOT NULL
        AND ds.next_periodic_sync <= ?
        AND t.trashed=0
        AND a.trashed=0`
  ).bind(now).all<{ id: number; table_id: number; workspace_id: number }>();

  for (const sync of (syncs.results || [])) {
    if (await hasActiveDataSyncJob(env.DB, sync.id)) continue;
    const job = await env.DB.prepare(
      `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
       VALUES ('sync_data_source', 'pending', 0, NULL, ?, ?, ?) RETURNING id`
    ).bind(now, now, JSON.stringify({ data_sync_id: sync.id, periodic: true })).first<{ id: number }>();
    if (!job) continue;
    try {
      await env.JOBS_QUEUE.send({
        job_id: job.id,
        job_type: "sync_data_source",
        payload: { datasync_id: sync.id, table_id: sync.table_id, periodic: true },
        user_id: 0,
        workspace_id: sync.workspace_id,
      });
    } catch (error) {
      await env.DB.prepare("DELETE FROM core_job WHERE id=?").bind(job.id).run();
      throw error;
    }
  }
}
