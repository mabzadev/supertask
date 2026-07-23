import type { D1Database } from "@cloudflare/workers-types";
import { DoesNotExist } from "../middleware/error";
import { assertHasApplicationRole } from "./enterprise-permissions";
import { deleteWorkflow } from "./automation";

export type AutomationWorkflowSnapshot = {
  workflow: Record<string, any>;
  published_workflows: Array<Record<string, any>>;
  nodes: Array<Record<string, any>>;
  trash_entries: Array<Record<string, any>>;
};

const WORKFLOW_COLUMNS = [
  "id",
  "automation_id",
  "name",
  "order",
  "state",
  "allow_test_run_until",
  "simulate_until_node_id",
  "published_on",
  "graph",
  "trashed",
  "created_on",
  "updated_on",
  "published_from_workflow_id",
  "is_published_version",
] as const;

const NODE_COLUMNS = [
  "id",
  "workflow_id",
  "type",
  "label",
  "service",
  "trashed",
  "created_on",
  "updated_on",
] as const;

function columnValue(row: Record<string, any>, column: string) {
  if (column === "order") return row.order ?? row["order"] ?? row["[order]"];
  return row[column] ?? null;
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += 80) {
    await db.batch(statements.slice(index, index + 80));
  }
}

function workflowUpsertStatement(db: D1Database, workflow: Record<string, any>) {
  const insertColumns = WORKFLOW_COLUMNS.map((column) => column === "order" ? "[order]" : column);
  const updateColumns = WORKFLOW_COLUMNS
    .filter((column) => column !== "id")
    .map((column) => `${column === "order" ? "[order]" : column}=excluded.${column === "order" ? "[order]" : column}`);
  return db.prepare(
    `INSERT INTO automation_workflow (${insertColumns.join(",")})
     VALUES (${WORKFLOW_COLUMNS.map(() => "?").join(",")})
     ON CONFLICT(id) DO UPDATE SET ${updateColumns.join(",")}`
  ).bind(...WORKFLOW_COLUMNS.map((column) => columnValue(workflow, column)));
}

export async function snapshotAutomationWorkflow(
  db: D1Database,
  workflowId: number,
): Promise<AutomationWorkflowSnapshot | null> {
  const workflow = await db.prepare(
    `SELECT * FROM automation_workflow
     WHERE id=? AND COALESCE(is_published_version, 0)=0`
  ).bind(workflowId).first<Record<string, any>>();
  if (!workflow) return null;

  const nodes = await db.prepare(
    "SELECT * FROM automation_node WHERE workflow_id=? ORDER BY id ASC"
  ).bind(workflowId).all<Record<string, any>>();
  const publishedWorkflows = await db.prepare(
    `SELECT * FROM automation_workflow
     WHERE published_from_workflow_id=? AND COALESCE(is_published_version, 0)=1
     ORDER BY id ASC`
  ).bind(workflowId).all<Record<string, any>>();
  const nodeIds = (nodes.results || []).map((node) => Number(node.id));
  const workflowTrashEntries = await db.prepare(
    `SELECT user_id, trash_item_type, trash_item_id, parent_trash_item_id,
            trashed_at, should_be_permanently_deleted, extra_description,
            application_id, workspace_id
       FROM core_trasheditem
      WHERE trash_item_type='automation_workflow' AND trash_item_id=?
      ORDER BY id ASC`
  ).bind(workflowId).all<Record<string, any>>();
  const nodeTrashEntries: Array<Record<string, any>> = [];
  for (let index = 0; index < nodeIds.length; index += 80) {
    const ids = nodeIds.slice(index, index + 80);
    const rows = await db.prepare(
      `SELECT user_id, trash_item_type, trash_item_id, parent_trash_item_id,
              trashed_at, should_be_permanently_deleted, extra_description,
              application_id, workspace_id
         FROM core_trasheditem
        WHERE trash_item_type='automation_node' AND trash_item_id IN (${ids.map(() => "?").join(",")})
        ORDER BY id ASC`
    ).bind(...ids).all<Record<string, any>>();
    nodeTrashEntries.push(...(rows.results || []));
  }

  return {
    workflow,
    published_workflows: publishedWorkflows.results || [],
    nodes: nodes.results || [],
    trash_entries: [...(workflowTrashEntries.results || []), ...nodeTrashEntries],
  };
}

async function replaceSnapshotTrashEntries(
  db: D1Database,
  target: AutomationWorkflowSnapshot,
  alternate: AutomationWorkflowSnapshot,
) {
  const workflowId = Number(target.workflow.id);
  const nodeIds = [...new Set([
    ...target.nodes.map((node) => Number(node.id)),
    ...alternate.nodes.map((node) => Number(node.id)),
  ])];
  await db.prepare(
    "DELETE FROM core_trasheditem WHERE trash_item_type='automation_workflow' AND trash_item_id=?"
  ).bind(workflowId).run();
  for (let index = 0; index < nodeIds.length; index += 80) {
    const ids = nodeIds.slice(index, index + 80);
    await db.prepare(
      `DELETE FROM core_trasheditem
       WHERE trash_item_type='automation_node' AND trash_item_id IN (${ids.map(() => "?").join(",")})`
    ).bind(...ids).run();
  }

  await runBatches(db, target.trash_entries.map((entry) => db.prepare(
    `INSERT INTO core_trasheditem
     (user_id, trash_item_type, trash_item_id, parent_trash_item_id,
      trashed_at, should_be_permanently_deleted, extra_description,
      application_id, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    entry.user_id ?? null,
    entry.trash_item_type,
    entry.trash_item_id,
    entry.parent_trash_item_id ?? null,
    entry.trashed_at,
    entry.should_be_permanently_deleted ?? 0,
    entry.extra_description ?? null,
    entry.application_id ?? null,
    entry.workspace_id ?? null,
  )));
}

export async function restoreAutomationWorkflowSnapshot(
  db: D1Database,
  target: AutomationWorkflowSnapshot | null,
  alternate: AutomationWorkflowSnapshot,
  userId: number,
  options: { restorePublishedVersions?: boolean } = {},
) {
  const workflow = (target || alternate).workflow;
  const workflowId = Number(workflow.id);
  const automationId = Number(workflow.automation_id);
  const application = await db.prepare(
    "SELECT workspace_id FROM core_application WHERE id=? AND type='automation' AND trashed=0"
  ).bind(automationId).first<{ workspace_id: number }>();
  if (!application) throw new DoesNotExist("Automation", automationId);
  await assertHasApplicationRole(db, userId, automationId, "BUILDER");

  if (!target) {
    const active = await db.prepare(
      `SELECT wf.*, a.workspace_id
       FROM automation_workflow wf
       JOIN core_application a ON a.id=wf.automation_id
       WHERE wf.id=? AND wf.trashed=0 AND COALESCE(wf.is_published_version, 0)=0`
    ).bind(workflowId).first<Record<string, any>>();
    if (active) await deleteWorkflow(db, active, userId);
    return {
      workflowId,
      automationId,
      workspaceId: Number(application.workspace_id),
    };
  }

  await workflowUpsertStatement(db, workflow).run();

  if (options.restorePublishedVersions) {
    const targetPublished = target.published_workflows || [];
    const targetPublishedIds = new Set(targetPublished.map((item) => Number(item.id)));
    const alternateOnlyIds = (alternate.published_workflows || [])
      .map((item) => Number(item.id))
      .filter((id) => !targetPublishedIds.has(id));
    await runBatches(db, targetPublished.map((item) => workflowUpsertStatement(db, item)));
    for (let index = 0; index < alternateOnlyIds.length; index += 80) {
      const ids = alternateOnlyIds.slice(index, index + 80);
      await db.prepare(
        `DELETE FROM automation_workflow
         WHERE id IN (${ids.map(() => "?").join(",")})
           AND published_from_workflow_id=? AND COALESCE(is_published_version, 0)=1`
      ).bind(...ids, workflowId).run();
    }
  }

  const targetNodeIds = new Set(target.nodes.map((node) => Number(node.id)));
  const alternateNodeIds = alternate.nodes.map((node) => Number(node.id));
  const nodeUpdates = NODE_COLUMNS
    .filter((column) => column !== "id")
    .map((column) => `${column}=excluded.${column}`);
  const statements = target.nodes.map((node) => db.prepare(
    `INSERT INTO automation_node (${NODE_COLUMNS.join(",")})
     VALUES (${NODE_COLUMNS.map(() => "?").join(",")})
     ON CONFLICT(id) DO UPDATE SET ${nodeUpdates.join(",")}`
  ).bind(...NODE_COLUMNS.map((column) => columnValue(node, column))));
  for (const nodeId of alternateNodeIds) {
    if (!targetNodeIds.has(nodeId)) {
      statements.push(db.prepare(
        "UPDATE automation_node SET trashed=1, updated_on=? WHERE id=? AND workflow_id=?"
      ).bind(new Date().toISOString(), nodeId, workflowId));
    }
  }
  await runBatches(db, statements);
  await replaceSnapshotTrashEntries(db, target, alternate);

  return {
    workflowId,
    automationId,
    workspaceId: Number(application.workspace_id),
  };
}
