import type { Env, JobMessage } from "../types/env";
import { importAirtableBase, processAirtableAttachmentTaskBatch } from "../services/airtable-import";
import { serializeDataSyncById, syncDataSyncTable } from "../services/data-sync";
import { buildTableExport, type TableExportOptions } from "../services/table-export";
import { ensureUserTableSystemColumns, serializeFieldValueForInsert } from "../services/dynamic-tables";
import { isReadOnlyFieldType } from "../services/field-serialization";
import { serializeFieldValueForStorage } from "../services/field-values";
import { getActiveFields, serializeRowForViewWithComputed } from "../services/view-helpers";
import { duplicateDatabaseTable } from "../services/table-duplication";
import { promptGenerativeAI, workspaceGenerativeAISettings } from "../services/generative-ai";
import { queryViewRows } from "../services/view-query";
import { evaluateFormula } from "../services/formula-engine";
import { allocateAutonumberValues } from "../services/autonumber";
import { missingCreateFieldValues } from "../services/row-create-values";
import {
  finalizeRowWrite,
  insertedRowId,
  modifiedFieldValues,
  tableHasRowWriteEffects,
} from "../services/row-write-effects";
import { reschedulePendingAIUpdates } from "../services/ai-auto-update";
import { deleteUnreferencedUserFiles } from "../services/user-files";
import { processWorkspaceExportResource, processWorkspaceImportResource } from "../routes/workspaces";
import { duplicateWorkflow, publishWorkflow } from "../services/automation";
import { createUndoableAction } from "../services/action-history";
import { snapshotAutomationWorkflow } from "../services/automation-snapshots";
import { processAssistantKnowledgeBatch } from "../services/assistant-knowledge";
import { processWebhookTriggerQueueMessage } from "../routes/database/webhooks";

function humanReadableJobError(job: JobMessage, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || "Job failed");
  if (job.job_type === "airtable" || job.job_type === "import_airtable") {
    if (message.includes("requires authentication")) return "The Airtable base requires authentication.";
    if (message.includes("not public") || message.includes("not publicly shared")) return "The Airtable base is not publicly shared.";
    if (message.includes("points to a view") || message.includes("not a base")) {
      return "The shared link is not a base. It's probably a view and the Airtable import tool only supports shared bases.";
    }
    if (message.includes("could not be reached") || message.includes("request failed")) return "The Airtable server could not be reached.";
  }
  return message;
}

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body as JobMessage;
    if (job.job_type === "webhook_trigger") {
      try {
        await processWebhookTriggerQueueMessage(env, job.payload);
        message.ack();
      } catch (err) {
        console.error(`[QUEUE] Webhook trigger failed:`, err);
        message.retry({ delaySeconds: 1 });
      }
      continue;
    }
    try {
      await processJob(job, env);
      message.ack();
    } catch (err) {
      console.error(`[QUEUE] Job ${job.job_id} (${job.job_type}) failed:`, err);
      await markJobFailed(job, env, err);
      message.ack();
    }
  }
}

async function markJobFailed(job: JobMessage, env: Env, err: unknown): Promise<void> {
  const humanReadable = humanReadableJobError(job, err);
  await env.DB.prepare(
    `UPDATE core_job
     SET status='failed', progress_percentage=100, error=?, human_readable_error=?, updated_on=?
     WHERE id=?`
  ).bind("ERROR_JOB_FAILED", humanReadable, new Date().toISOString(), job.job_id).run();
}

async function updateJobProgress(job: JobMessage, env: Env, progress: number, state = "running"): Promise<void> {
  await env.DB.prepare(
    "UPDATE core_job SET status=?, progress_percentage=?, updated_on=? WHERE id=?"
  ).bind(state, progress, new Date().toISOString(), job.job_id).run();
}

async function processJob(job: JobMessage, env: Env): Promise<void> {
  const current = await env.DB.prepare("SELECT status FROM core_job WHERE id=?")
    .bind(job.job_id)
    .first<{ status: string }>();
  if (!current || ["finished", "failed", "cancelled"].includes(String(current.status))) return;
  await env.DB.prepare("UPDATE core_job SET status='running', updated_on=? WHERE id=?")
    .bind(new Date().toISOString(), job.job_id).run();

  let complete = true;
  switch (job.job_type) {
    case "export_table":
      await handleExportTable(job, env);
      break;
    case "import_csv":
      await handleImportCSV(job, env);
      break;
    case "export_applications":
      await updateJobProgress(job, env, 5, "exporting");
      await handleWorkspaceExport(job, env);
      break;
    case "import_applications":
    case "workspace_import":
      await updateJobProgress(job, env, 15, "importing");
      await handleWorkspaceImport(job, env);
      break;
    case "airtable":
    case "import_airtable":
      await updateJobProgress(job, env, 10, "downloading-base");
      complete = await handleAirtableImport(job, env);
      break;
    case "airtable_attachment_retry":
      await env.DB.prepare("UPDATE core_job SET status='downloading-files', updated_on=? WHERE id=?")
        .bind(new Date().toISOString(), job.job_id)
        .run();
      complete = (await processAirtableAttachmentTaskBatch(env, job)).complete;
      break;
    case "duplicate_table":
      await handleDuplicateTable(job, env);
      break;
    case "sync_data_sync_table":
    case "sync_data_source":
      await handleDataSync(job, env);
      break;
    case "duplicate_automation_workflow":
      await handleDuplicateAutomationWorkflow(job, env);
      break;
    case "publish_automation_workflow":
      await handlePublishAutomationWorkflow(job, env);
      break;
    case "sync_assistant_knowledge":
      complete = await handleAssistantKnowledge(job, env);
      break;
    case "generate_ai_values":
      await handleGenerateAIValues(job, env);
      break;
    case "cleanup_trash":
      await handleCleanupTrash(env);
      break;
    case "cleanup_user_files":
      complete = await handleCleanupUserFiles(job, env);
      break;
    default:
      throw new Error(`Unsupported job type: ${job.job_type}`);
  }

  if (!complete) return;
  await env.DB.prepare("UPDATE core_job SET status='finished', progress_percentage=100, updated_on=? WHERE id=?")
    .bind(new Date().toISOString(), job.job_id).run();
}

async function handleAssistantKnowledge(job: JobMessage, env: Env): Promise<boolean> {
  const offset = Math.max(0, Number(job.payload.offset || 0));
  const sourceEtag = String(job.payload.source_etag || "");
  if (!sourceEtag) throw new Error("Assistant knowledge job is missing source_etag.");
  const result = await processAssistantKnowledgeBatch(env, offset, sourceEtag);
  const progress = result.total > 0
    ? Math.min(95, 5 + Math.floor((result.nextOffset / result.total) * 90))
    : 95;
  await updateJobProgress(job, env, progress, "indexing-knowledge");
  await storeJobResult(job, env, {
    source_etag: sourceEtag,
    indexed_chunks: result.nextOffset,
    total_chunks: result.total,
    deleted_vectors: Number(job.payload.deleted_vectors || 0) + result.deleted,
  });
  if (result.complete) return true;
  await env.JOBS_QUEUE.send({
    ...job,
    payload: {
      ...job.payload,
      offset: result.nextOffset,
      deleted_vectors: Number(job.payload.deleted_vectors || 0) + result.deleted,
    },
  });
  return false;
}

async function automationWorkflowForJob(job: JobMessage, env: Env): Promise<any> {
  const workflowId = Number(job.payload.workflow_id);
  if (!Number.isInteger(workflowId) || workflowId <= 0) {
    throw new Error("Automation workflow job is missing workflow_id.");
  }
  const workflow = await env.DB.prepare(
    `SELECT wf.*, a.workspace_id
       FROM automation_workflow wf
       JOIN core_application a ON a.id=wf.automation_id
      WHERE wf.id=? AND wf.trashed=0 AND a.trashed=0 AND a.type='automation'
        AND COALESCE(wf.is_published_version, 0)=0`
  ).bind(workflowId).first<any>();
  if (!workflow) {
    throw new Error(`Automation workflow ${workflowId} was deleted before the job started.`);
  }
  return workflow;
}

async function storeJobResult(job: JobMessage, env: Env, result: Record<string, unknown>): Promise<void> {
  await env.DB.prepare("UPDATE core_job SET result=?, updated_on=? WHERE id=?")
    .bind(JSON.stringify(result), new Date().toISOString(), job.job_id)
    .run();
}

async function handleDuplicateAutomationWorkflow(job: JobMessage, env: Env): Promise<void> {
  const workflow = await automationWorkflowForJob(job, env);
  await updateJobProgress(job, env, 25);
  const result = await duplicateWorkflow(env.DB, workflow);
  const duplicatedWorkflowId = Number(result.automation_workflow_id);
  const user = await env.DB.prepare("SELECT * FROM auth_user WHERE id=?").bind(job.user_id).first<any>();
  if (user) {
    await createUndoableAction(env.DB, {
      user,
      actionType: "duplicate_automation_workflow",
      actionScope: `application${workflow.automation_id}`,
      session: String(job.payload.action_session || ""),
      actionGroup: job.payload.action_group === null || job.payload.action_group === undefined
        ? null
        : String(job.payload.action_group),
      params: {
        automation_id: Number(workflow.automation_id),
        before: null,
        after: await snapshotAutomationWorkflow(env.DB, duplicatedWorkflowId),
      },
    });
  }
  await storeJobResult(job, env, result);
}

async function handlePublishAutomationWorkflow(job: JobMessage, env: Env): Promise<void> {
  const workflow = await automationWorkflowForJob(job, env);
  await updateJobProgress(job, env, 25);
  await storeJobResult(job, env, await publishWorkflow(env.DB, workflow));
}

async function handleWorkspaceImport(job: JobMessage, env: Env): Promise<void> {
  const workspaceId = Number(job.payload.workspace_id || job.workspace_id || 0);
  const resourceId = String(job.payload.resource_id || "");
  if (!workspaceId || !resourceId) throw new Error("Workspace import job is missing workspace_id or resource_id.");
  const applicationIds = Array.isArray(job.payload.application_ids)
    ? job.payload.application_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  await updateJobProgress(job, env, 35, "importing");
  const importedApplications = await processWorkspaceImportResource(
    env,
    workspaceId,
    resourceId,
    applicationIds,
    async (restored, total) => {
      const progress = total > 0 ? 35 + Math.floor((restored / total) * 55) : 90;
      await updateJobProgress(job, env, progress, "importing");
    }
  );
  await updateJobProgress(job, env, 90, "importing");
  await env.DB.prepare("UPDATE core_job SET result=? WHERE id=?").bind(JSON.stringify({
    workspace_id: workspaceId,
    resource_id: resourceId,
    imported_applications: importedApplications,
    installed_applications: importedApplications,
    application_ids: importedApplications.map((application) => Number(application.id)),
  }), job.job_id).run();
}

async function handleWorkspaceExport(job: JobMessage, env: Env): Promise<void> {
  const workspaceId = Number(job.payload.workspace_id || job.workspace_id || 0);
  const key = String(job.payload.key || "");
  const exportedFileName = String(job.payload.exported_file_name || "");
  if (!workspaceId || !key || !exportedFileName) {
    throw new Error("Workspace export job is missing workspace_id, key or exported_file_name.");
  }
  const applicationIds = Array.isArray(job.payload.application_ids)
    ? job.payload.application_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const result = await processWorkspaceExportResource(
    env,
    workspaceId,
    key,
    exportedFileName,
    {
      application_ids: applicationIds,
      application_ids_resolved: true,
      only_structure: job.payload.only_structure === true,
    },
    async (exported, total, state) => {
      const progress = state === "create-archive"
        ? 92
        : total > 0
          ? 5 + Math.floor((exported / total) * 85)
          : 90;
      await updateJobProgress(job, env, progress, state);
    }
  );
  await storeJobResult(job, env, result);
}

async function handleCleanupUserFiles(job: JobMessage, env: Env): Promise<boolean> {
  const explicitNames = Array.isArray(job.payload.names)
    ? job.payload.names.map(String).filter(Boolean).slice(0, 100)
    : [];
  if (explicitNames.length > 0) {
    await deleteUnreferencedUserFiles(env, explicitNames);
    return true;
  }

  const targetUserId = Number(job.payload.target_user_id || 0);
  const afterId = Number(job.payload.after_id || 0);
  if (!targetUserId) throw new Error("cleanup_user_files requires names or target_user_id.");
  const files = await env.DB.prepare(
    "SELECT id, name FROM core_userfile WHERE user_id=? AND id>? ORDER BY id LIMIT 100"
  ).bind(targetUserId, afterId).all<{ id: number; name: string }>();
  await deleteUnreferencedUserFiles(env, (files.results || []).map((file) => file.name));
  if ((files.results || []).length < 100) return true;
  await env.JOBS_QUEUE.send({
    ...job,
    payload: {
      ...job.payload,
      after_id: Number(files.results?.[files.results.length - 1]?.id || afterId),
    },
  });
  return false;
}

async function handleDataSync(job: JobMessage, env: Env): Promise<void> {
  const dataSyncId = Number(job.payload.datasync_id || job.payload.data_sync_id);
  if (!Number.isInteger(dataSyncId) || dataSyncId <= 0) {
    throw new Error("Data sync job is missing datasync_id.");
  }
  await updateJobProgress(job, env, 25, "syncing");
  const currentJob = await env.DB.prepare("SELECT result FROM core_job WHERE id=?").bind(job.job_id).first<{ result: string | null }>();
  const baseResult = parseJsonObject(currentJob?.result);
  const result = await syncDataSyncTable(env.DB, dataSyncId, env, {
    periodic: Boolean(job.payload.periodic),
    userId: Number(job.user_id || 0) || null,
  });
  if (job.job_type === "sync_data_sync_table") {
    baseResult.data_sync_id = dataSyncId;
    baseResult.data_sync = await serializeDataSyncById(env.DB, dataSyncId);
  }
  const storedResult = job.job_type === "sync_data_sync_table"
    ? { ...baseResult, ...result }
    : result;
  await env.DB.prepare("UPDATE core_job SET result=? WHERE id=?")
    .bind(JSON.stringify(storedResult), job.job_id)
    .run();
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function aiPromptFormula(value: unknown): string {
  const object = parseJsonObject(value);
  if (typeof object.formula === "string") return object.formula;
  return typeof value === "string" ? value : "";
}

function promptFromRow(formula: string, row: Record<string, unknown>): string {
  if (!formula.trim()) return "";
  const evaluated = evaluateFormula(formula, row as any);
  if (!evaluated.error && evaluated.value !== null && evaluated.value !== undefined) {
    return String(evaluated.value);
  }
  return formula;
}

function uniquePositiveIds(values: unknown[]): number[] {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
}

async function rowIdsForAIJob(env: Env, tableId: number, fieldId: number, payload: Record<string, unknown>): Promise<number[]> {
  await ensureUserTableSystemColumns(env.DB, tableId);
  if (payload.is_auto_update === true) {
    const rows = await env.DB.prepare(
      `SELECT r.id
       FROM "database_table_${tableId}" r
       JOIN premium_aifieldscheduledupdate s ON s.row_id=r.id AND s.field_id=?
       WHERE COALESCE(r.trashed, 0)=0
       ORDER BY r.id ASC`
    ).bind(fieldId).all<{ id: number }>();
    return (rows.results || []).map((row) => Number(row.id));
  }
  if (Array.isArray(payload.row_ids)) {
    const ids = uniquePositiveIds(payload.row_ids);
    if (ids.length === 0) return [];
    const rows = await env.DB.prepare(
      `SELECT id FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 AND id IN (${ids.map(() => "?").join(",")}) ORDER BY [order] ASC, id ASC`
    ).bind(...ids).all<{ id: number }>();
    return (rows.results || []).map((row) => Number(row.id));
  }
  const viewId = Number(payload.view_id);
  if (Number.isInteger(viewId) && viewId > 0) {
    const view = await env.DB.prepare("SELECT * FROM database_view WHERE id=? AND table_id=? AND trashed=0")
      .bind(viewId, tableId)
      .first<any>();
    if (!view) return [];
    const queried = await queryViewRows(env.DB, view, `https://internal/api/database/views/${view.type}/${view.id}/`);
    return uniquePositiveIds(queried.rows.map((row) => row.id));
  }
  const rows = await env.DB.prepare(`SELECT id FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC`).all<{ id: number }>();
  return (rows.results || []).map((row) => Number(row.id));
}

function hasExistingAIValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "null" || trimmed === "[]") return false;
  }
  return true;
}

async function handleGenerateAIValues(job: JobMessage, env: Env): Promise<void> {
  const fieldId = Number(job.payload.field_id);
  if (!Number.isInteger(fieldId) || fieldId <= 0) throw new Error("AI generation job is missing field_id.");
  const field = await env.DB.prepare(
    `SELECT f.*, a.workspace_id
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
      WHERE f.id=? AND f.type='ai' AND f.trashed=0 AND t.trashed=0`
  ).bind(fieldId).first<any>();
  if (!field) throw new Error(`AI field ${fieldId} does not exist.`);

  const settings = parseJsonObject(field.field_settings);
  const provider = String(settings.ai_generative_ai_type || "");
  const model = String(settings.ai_generative_ai_model || "");
  const outputType = String(settings.ai_output_type || "text");
  const promptFormula = aiPromptFormula(settings.ai_prompt);
  const workspaceSettings = await workspaceGenerativeAISettings(env.CACHE, Number(field.workspace_id));
  const tableId = Number(field.table_id);
  const isAutoUpdate = job.payload.is_auto_update === true;
  const scheduledVersions = new Map<number, string>();
  if (isAutoUpdate) {
    const scheduled = await env.DB.prepare(
      "SELECT row_id, updated_on FROM premium_aifieldscheduledupdate WHERE field_id=?"
    ).bind(fieldId).all<{ row_id: number; updated_on: string }>();
    for (const item of scheduled.results || []) scheduledVersions.set(Number(item.row_id), item.updated_on);
  }
  const rowIds = await rowIdsForAIJob(env, tableId, fieldId, job.payload);
  const onlyEmpty = Boolean(job.payload.only_empty);
  const fields = await getActiveFields(env.DB, tableId);
  const aiFieldForStorage = {
    id: fieldId,
    name: String(field.name || ""),
    type: outputType === "choice" ? "single_select" as const : "long_text" as const,
    primary: false,
    readOnly: false,
    settings,
  };
  const generatedRowIds: number[] = [];
  const skippedRowIds: number[] = [];
  const failedRows: Array<{ id: number; error: string }> = [];

  for (let index = 0; index < rowIds.length; index += 1) {
    const rowId = rowIds[index];
    const rawRow = await env.DB.prepare(`SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`).bind(rowId).first<Record<string, unknown>>();
    if (!rawRow) {
      failedRows.push({ id: rowId, error: "Row does not exist." });
      continue;
    }
    const currentValue = rawRow[`field_${fieldId}`];
    if (onlyEmpty && hasExistingAIValue(currentValue)) {
      skippedRowIds.push(rowId);
      continue;
    }

    try {
      const rowForPrompt = await serializeRowForViewWithComputed(env.DB, rawRow, fields, true);
      const prompt = promptFromRow(promptFormula, rowForPrompt);
      const temperature = settings.ai_temperature === null || settings.ai_temperature === undefined
        ? null
        : Number(settings.ai_temperature);
      const output = await promptGenerativeAI(workspaceSettings, provider, model, prompt, temperature);
      const stored = await serializeFieldValueForStorage(env.DB, aiFieldForStorage, output, env, Number(field.workspace_id || job.workspace_id || 0) || null);
      if (isAutoUpdate) {
        const scheduledVersion = scheduledVersions.get(rowId);
        const deleted = scheduledVersion
          ? await env.DB.prepare(
            `DELETE FROM premium_aifieldscheduledupdate
             WHERE field_id=? AND row_id=? AND updated_on=? RETURNING row_id`
          ).bind(fieldId, rowId, scheduledVersion).first<{ row_id: number }>()
          : null;
        if (!deleted) continue;
      }
      const now = new Date().toISOString();
      const sets = [`"field_${fieldId}"=?`, "_updated_on=?", "_last_modified_by_id=?"];
      const bindValues: unknown[] = [stored, now, job.user_id || null];
      const modifiedValues = await modifiedFieldValues(env.DB, fields, now, job.user_id || null);
      for (const [modifiedFieldId, value] of modifiedValues) {
        sets.push(`"field_${modifiedFieldId}"=?`);
        bindValues.push(value);
      }
      bindValues.push(rowId);
      await env.DB.prepare(`UPDATE "database_table_${tableId}" SET ${sets.join(", ")} WHERE id=? AND COALESCE(trashed, 0)=0`)
        .bind(...bindValues)
        .run();
      await finalizeRowWrite(env.DB, tableId, rowId, rawRow, new Set([fieldId]), Number(job.user_id || 0) || null, env);
      generatedRowIds.push(rowId);
    } catch (error) {
      failedRows.push({ id: rowId, error: error instanceof Error ? error.message : String(error) });
    }

    if (rowIds.length > 0) {
      await updateJobProgress(job, env, Math.min(99, Math.floor(((index + 1) / rowIds.length) * 100)), "running");
    }
  }

  await env.DB.prepare("UPDATE core_job SET result=? WHERE id=?")
    .bind(JSON.stringify({
      field_id: fieldId,
      row_ids: rowIds,
      view_id: job.payload.view_id ?? null,
      only_empty: onlyEmpty,
      is_auto_update: isAutoUpdate,
      generated_row_ids: generatedRowIds,
      skipped_row_ids: skippedRowIds,
      failed_rows: failedRows,
    }), job.job_id)
    .run();

  if (isAutoUpdate) {
    const remaining = await env.DB.prepare(
      "SELECT row_id, updated_on FROM premium_aifieldscheduledupdate WHERE field_id=?"
    ).bind(fieldId).all<{ row_id: number; updated_on: string }>();
    const changedWhileRunning = (remaining.results || []).some((item) => (
      !scheduledVersions.has(Number(item.row_id)) || scheduledVersions.get(Number(item.row_id)) !== item.updated_on
    ));
    if (changedWhileRunning) await reschedulePendingAIUpdates(env, job.job_id);
  }

  if (failedRows.length > 0 && generatedRowIds.length === 0 && skippedRowIds.length === 0) {
    throw new Error(failedRows[0].error);
  }
}

async function handleAirtableImport(job: JobMessage, env: Env): Promise<boolean> {
  const result = await importAirtableBase(env, { ...job.payload, _job_id: job.job_id } as any, job.user_id ?? null, async (progress, state) => {
    await updateJobProgress(job, env, Math.max(progress, 10), state);
  });
  await updateJobProgress(job, env, result.pendingAttachmentCount > 0 ? 80 : 99, result.pendingAttachmentCount > 0 ? "downloading-files" : "converting");
  await env.DB.prepare("UPDATE core_job SET result=? WHERE id=?")
    .bind(JSON.stringify({ database: result.database }), job.job_id)
    .run();
  return result.pendingAttachmentCount === 0;
}

async function handleExportTable(job: JobMessage, env: Env): Promise<void> {
  const { table_id: rawTableId, exporter_type: rawExporterType, ...payloadOptions } = job.payload;
  const tableId = Number(rawTableId);
  if (!Number.isInteger(tableId) || tableId <= 0) {
    throw new Error("Table export job is missing table_id.");
  }
  const exporterType = typeof rawExporterType === "string" && rawExporterType.trim() ? rawExporterType : "csv";
  const options: TableExportOptions = { ...payloadOptions, exporter_type: exporterType };
  const file = await buildTableExport(env.DB, tableId, options, { files: env.FILES });
  const table = await env.DB.prepare("SELECT name FROM database_table WHERE id=?").bind(tableId).first<{ name: string }>();
  const safeName = String(table?.name || `table-${tableId}`).replace(/[^a-zA-Z0-9._-]/g, "_") || `table-${tableId}`;
  const key = `exports/table-${tableId}-${Date.now()}-${safeName}.${file.extension}`;
  await env.FILES.put(key, file.body, {
    httpMetadata: {
      contentType: file.contentType,
      contentDisposition: `attachment; filename="${safeName}.${file.extension}"`,
    },
  });

  await env.DB.prepare(
    `INSERT INTO database_exportjob
     (job_ptr_id, table_id, exporter_type, export_options, exported_file_name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_ptr_id) DO UPDATE SET
       table_id=excluded.table_id,
       exporter_type=excluded.exporter_type,
       export_options=excluded.export_options,
       exported_file_name=excluded.exported_file_name,
       expires_at=excluded.expires_at`
  ).bind(
    job.job_id,
    tableId,
    exporterType,
    JSON.stringify(options),
    key,
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  ).run();
}

async function handleImportCSV(job: JobMessage, env: Env): Promise<void> {
  const { table_id, file_key } = job.payload as { table_id: number; file_key: string };
  const tableId = Number(table_id);
  if (!Number.isInteger(tableId) || tableId <= 0) {
    throw new Error("CSV import job is missing table_id.");
  }
  const obj = await env.FILES.get(file_key);
  if (!obj) throw new Error(`File not found: ${file_key}`);

  const text = await obj.text();
  const parsedRows = parseCsv(text).filter((row) => row.some((value) => value.trim() !== ""));
  if (parsedRows.length < 2) return;

  const headers = parsedRows[0].map((header, index) => (index === 0 ? stripBom(header) : header).trim());
  const now = new Date().toISOString();
  const tn = `database_table_${tableId}`;
  const fields = await getActiveFields(env.DB, tableId);
  const fieldMap = new Map(fields.map((field) => [field.name.trim().toLowerCase(), field]));
  const headerFields = headers.map((header) => {
    const field = fieldMap.get(header.toLowerCase());
    return field && !field.readOnly && !isReadOnlyFieldType(field.type) ? field : null;
  });
  const needsRowWriteEffects = await tableHasRowWriteEffects(env.DB, tableId);

  const statements = [];
  const changedFieldIdsByStatement: Set<number>[] = [];
  for (let rowIndex = 1; rowIndex < parsedRows.length; rowIndex += 1) {
    const row = parsedRows[rowIndex];
    const cols = ["[order]", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id"];
    const bindVals: unknown[] = [rowIndex * 10000, now, now, job.user_id || null, job.user_id || null];
    const changedFieldIds = new Set<number>();
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const field = headerFields[columnIndex];
      if (!field) continue;
      const raw = row[columnIndex] ?? "";
      cols.push(`"field_${field.id}"`);
      bindVals.push(await serializeFieldValueForStorage(env.DB, field, csvCellValueForField(field.type, raw), env, job.workspace_id || null));
      changedFieldIds.add(field.id);
    }
    const existingFieldIds = new Set(cols.flatMap((column) => {
      const match = column.match(/^"field_(\d+)"$/);
      return match ? [Number(match[1])] : [];
    }));
    const missingValues = await missingCreateFieldValues(env.DB, fields, existingFieldIds, {
      now,
      user: job.user_id,
      fileContext: env,
      workspaceId: job.workspace_id || null,
    });
    for (const [fieldId, value] of missingValues) {
      cols.push(`"field_${fieldId}"`);
      bindVals.push(value);
    }
    const autonumberValues = await allocateAutonumberValues(env.DB, tableId);
    for (const [fieldId, value] of autonumberValues) {
      cols.push(`"field_${fieldId}"`);
      bindVals.push(serializeFieldValueForInsert("autonumber", value));
    }
    const ph = cols.map(() => "?").join(",");
    statements.push(env.DB.prepare(`INSERT INTO "${tn}" (${cols.join(",")}) VALUES (${ph})`).bind(...bindVals));
    changedFieldIdsByStatement.push(changedFieldIds);
  }

  const chunkSize = 100;
  for (let index = 0; index < statements.length; index += chunkSize) {
    const results = await env.DB.batch(statements.slice(index, index + chunkSize));
    if (!needsRowWriteEffects) continue;
    for (let offset = 0; offset < results.length; offset += 1) {
      const rowId = insertedRowId(results[offset]);
      if (!rowId) continue;
      await finalizeRowWrite(env.DB, tableId, rowId, null, changedFieldIdsByStatement[index + offset], Number(job.user_id || 0) || null, env);
    }
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "" || text.endsWith(",")) rows.push(row);
  return rows;
}

function csvCellValueForField(type: string, raw: string): unknown {
  const value = raw.trim() === "" ? null : raw;
  if (value === null) return null;
  if (["multiple_select", "link_row", "multiple_collaborators"].includes(type)) {
    const parsed = parseJsonCell(value);
    if (parsed !== value) return parsed;
    return value.split(",").map((part) => part.trim()).filter(Boolean);
  }
  if (type === "file") {
    return parseJsonCell(value);
  }
  return parseJsonCell(value);
}

function parseJsonCell(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || !["[", "{"].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

async function handleDuplicateTable(job: JobMessage, env: Env): Promise<void> {
  const payload = job.payload as { source_table_id?: unknown; table_id?: unknown; database_id?: unknown };
  const sourceTableId = Number(payload.source_table_id ?? payload.table_id);
  if (!Number.isInteger(sourceTableId) || sourceTableId <= 0) {
    throw new Error("Duplicate table job is missing source_table_id.");
  }
  const rawTargetDatabaseId = payload.database_id === undefined || payload.database_id === null
    ? null
    : Number(payload.database_id);
  const targetDatabaseId = rawTargetDatabaseId !== null &&
    Number.isInteger(rawTargetDatabaseId) &&
    rawTargetDatabaseId > 0
    ? rawTargetDatabaseId
    : null;
  const duplicated = await duplicateDatabaseTable(env.DB, sourceTableId, {
    targetDatabaseId,
  });

  await env.DB.prepare("UPDATE core_job SET result=? WHERE id=?")
    .bind(JSON.stringify({
      report: { failing_rows: {} },
      table_id: duplicated.duplicatedTable.id,
      original_table: duplicated.original_table,
      duplicated_table: duplicated.duplicated_table,
    }), job.job_id)
    .run();
}

async function handleCleanupTrash(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE core_trasheditem SET should_be_permanently_deleted=1 WHERE trashed_at < ? AND should_be_permanently_deleted=0"
  ).bind(cutoff).run();
}
