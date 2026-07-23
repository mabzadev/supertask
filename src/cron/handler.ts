import type { Env } from "../types/env";
import { triggerDuePeriodicBuilderWorkflows } from "../services/builder";
import { triggerDuePeriodicAutomationWorkflows } from "../services/automation";
import { hasActiveDataSyncJob } from "../services/data-sync";
import { reschedulePendingAIUpdates } from "../services/ai-auto-update";
import { ASSISTANT_KNOWLEDGE_SOURCE_KEY } from "../services/assistant-knowledge";
import { recoverWebhookDeliveryQueue } from "../routes/database/webhooks";

export async function handleCron(cron: string, env: Env): Promise<void> {
  console.log(`[CRON] Running cron: ${cron}`);

  switch (cron) {
    case "0 3 * * *":
      // Permanently delete items that have been in trash > 48h
      await cleanupExpiredTrash(env);
      await cleanupExpiredContentVersions(env);
      break;

    case "0 * * * *":
      // Update `created_on` / `last_modified` virtual fields & expire old jobs
      await cleanupExpiredJobs(env);
      break;

    case "*/5 * * * *":
      // Check periodic data syncs
      await triggerPeriodicDataSyncs(env);
      await reschedulePendingAIUpdates(env);
      await scheduleAssistantKnowledgeSync(env);
      break;

    case "* * * * *":
      // Check Builder periodic trigger workflows
      await recoverWebhookDeliveryQueue(env);
      await triggerDuePeriodicBuilderWorkflows(env);
      await triggerDuePeriodicAutomationWorkflows(env);
      break;
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

async function cleanupExpiredTrash(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM core_trasheditem WHERE trashed_at < ? AND should_be_permanently_deleted=1")
    .bind(cutoff).run();
}

async function cleanupExpiredContentVersions(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, object_key FROM opentabl_content_version WHERE automatic=1 AND created_on < ? LIMIT 500"
  ).bind(cutoff).all<{ id: number; object_key: string }>();
  for (const row of rows.results || []) {
    await env.FILES.delete(row.object_key);
    await env.DB.prepare("DELETE FROM opentabl_content_version WHERE id=?").bind(row.id).run();
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
