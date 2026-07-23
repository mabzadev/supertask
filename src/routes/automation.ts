import { Hono } from "hono";
import type { Env, JobType, RequestVariables } from "../types/env";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth";
import { ApiError } from "../middleware/error";
import {
  createNode,
  createWorkflow,
  deleteNode,
  deleteWorkflow,
  duplicateNode,
  listNodeHistory,
  listNodes,
  listWorkflowHistory,
  listWorkflows,
  moveNode,
  orderWorkflows,
  replaceNode,
  requireAutomationAccess,
  requireNodeAccess,
  requireWorkflowAccess,
  serializeWorkflow,
  toggleWorkflowTestRun,
  updateNode,
  updateWorkflow,
} from "../services/automation";
import { createUndoableAction } from "../services/action-history";
import { snapshotAutomationWorkflow } from "../services/automation-snapshots";

const automation = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function actionContext(c: any, scope: string) {
  return {
    session: c.get("client_session_id") || c.req.header("ClientSessionId") || "",
    actionGroup: c.req.header("ClientUndoRedoActionGroupId") || null,
    actionScope: scope,
  };
}

async function recordNodeAction(
  c: any,
  actionType: string,
  workflowId: number,
  before: Awaited<ReturnType<typeof snapshotAutomationWorkflow>>,
  after: Awaited<ReturnType<typeof snapshotAutomationWorkflow>>,
) {
  const user = c.get("user")!;
  const snapshot = after || before;
  if (!snapshot) return;
  await createUndoableAction(c.env.DB, {
    user,
    actionType,
    params: {
      workflow_id: workflowId,
      automation_id: Number(snapshot.workflow.automation_id),
      before,
      after,
    },
    ...actionContext(c, `workflow${workflowId}`),
  });
}

async function recordWorkflowAction(
  c: any,
  actionType: string,
  automationId: number,
  before: Awaited<ReturnType<typeof snapshotAutomationWorkflow>>,
  after: Awaited<ReturnType<typeof snapshotAutomationWorkflow>>,
) {
  await createUndoableAction(c.env.DB, {
    user: c.get("user")!,
    actionType,
    params: { automation_id: automationId, before, after },
    ...actionContext(c, `application${automationId}`),
  });
}

async function workflowOrder(db: D1Database, automationId: number) {
  const rows = await db.prepare(
    `SELECT id FROM automation_workflow
     WHERE automation_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=0
     ORDER BY [order] ASC, id ASC`
  ).bind(automationId).all<{ id: number }>();
  return (rows.results || []).map((row) => Number(row.id));
}

function serializeJob(job: any): object {
  let result: Record<string, unknown> | null = null;
  try {
    result = job.result ? JSON.parse(job.result) : null;
  } catch {
    result = null;
  }
  return {
    id: job.id,
    type: job.type,
    state: job.status,
    status: job.status,
    progress_percentage: job.progress_percentage ?? 0,
    error: job.error || null,
    human_readable_error: job.human_readable_error || null,
    result,
    ...(result || {}),
    user_id: job.user_id,
    created_on: job.created_on,
    updated_on: job.updated_on,
  };
}

async function createWorkflowJob(
  env: Env,
  userId: number,
  workflow: any,
  type: Extract<JobType, "duplicate_automation_workflow" | "publish_automation_workflow">,
  action?: { session: string; action_group: string | null },
): Promise<object> {
  const maxCount = type === "duplicate_automation_workflow" ? 1 : 2;
  const initialResult = type === "duplicate_automation_workflow"
    ? {
      original_automation_workflow: serializeWorkflow(workflow),
      automation_workflow_id: Number(workflow.id),
    }
    : { automation_workflow_id: Number(workflow.id) };
  const now = new Date().toISOString();
  const job = await env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
     SELECT ?, 'pending', 0, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM core_job
             WHERE user_id=? AND type=? AND status IN ('pending', 'running')) < ?
     RETURNING *`
  ).bind(
    type,
    userId,
    now,
    now,
    JSON.stringify(initialResult),
    userId,
    type,
    maxCount,
  ).first<any>();
  if (!job) {
    throw new ApiError(
      400,
      "ERROR_MAX_JOB_COUNT_EXCEEDED",
      `You can only launch ${maxCount} ${type} job(s) at the same time.`,
    );
  }

  try {
    await env.JOBS_QUEUE.send({
      job_id: Number(job.id),
      job_type: type,
      payload: {
        workflow_id: Number(workflow.id),
        ...(action ? { action_session: action.session, action_group: action.action_group } : {}),
      },
      user_id: userId,
      workspace_id: Number(workflow.workspace_id || 0),
    });
  } catch (error) {
    await env.DB.prepare("DELETE FROM core_job WHERE id=?").bind(job.id).run();
    throw error;
  }
  return serializeJob(job);
}

automation.get("/:automationId/workflows/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const automationId = Number(c.req.param("automationId"));
  await requireAutomationAccess(c.env.DB, user.id, automationId);
  return c.json(await listWorkflows(c.env.DB, automationId));
});

automation.post("/:automationId/workflows/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const automationId = Number(c.req.param("automationId"));
  await requireAutomationAccess(c.env.DB, user.id, automationId, "BUILDER");
  const result = await createWorkflow(c.env.DB, automationId, await c.req.json<Record<string, unknown>>());
  await recordWorkflowAction(
    c,
    "create_automation_workflow",
    automationId,
    null,
    await snapshotAutomationWorkflow(c.env.DB, Number(result.id)),
  );
  return c.json(result);
});

automation.post("/:automationId/workflows/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const automationId = Number(c.req.param("automationId"));
  await requireAutomationAccess(c.env.DB, user.id, automationId, "BUILDER");
  const body = await c.req.json<{ workflow_ids?: unknown }>();
  if (!Array.isArray(body.workflow_ids)) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "workflow_ids must be a list of workflow ids.");
  }
  const beforeOrder = await workflowOrder(c.env.DB, automationId);
  await orderWorkflows(c.env.DB, automationId, body.workflow_ids.map(Number));
  await createUndoableAction(c.env.DB, {
    user,
    actionType: "order_automation_workflows",
    params: {
      automation_id: automationId,
      before_order: beforeOrder,
      after_order: await workflowOrder(c.env.DB, automationId),
    },
    ...actionContext(c, `application${automationId}`),
  });
  return c.body(null, 204);
});

automation.get("/workflows/:workflowId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  const workflow = await requireWorkflowAccess(c.env.DB, user.id, workflowId);
  const published = await c.env.DB.prepare(
    `SELECT * FROM automation_workflow
     WHERE published_from_workflow_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=1
     ORDER BY id DESC LIMIT 1`
  ).bind(workflowId).first<any>();
  return c.json(serializeWorkflow(workflow, published));
});

automation.patch("/workflows/:workflowId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  const workflow = await requireWorkflowAccess(c.env.DB, user.id, workflowId, "BUILDER");
  const before = await snapshotAutomationWorkflow(c.env.DB, workflowId);
  const result = await updateWorkflow(c.env.DB, workflowId, await c.req.json<Record<string, unknown>>());
  await recordWorkflowAction(
    c,
    "update_automation_workflow",
    Number(workflow.automation_id),
    before,
    await snapshotAutomationWorkflow(c.env.DB, workflowId),
  );
  return c.json(result);
});

automation.delete("/workflows/:workflowId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  const workflow = await requireWorkflowAccess(c.env.DB, user.id, workflowId, "BUILDER");
  const before = await snapshotAutomationWorkflow(c.env.DB, workflowId);
  await deleteWorkflow(c.env.DB, workflow, user.id);
  await recordWorkflowAction(
    c,
    "delete_automation_workflow",
    Number(workflow.automation_id),
    before,
    await snapshotAutomationWorkflow(c.env.DB, workflowId),
  );
  return c.body(null, 204);
});

automation.post("/workflows/:workflowId/duplicate/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  const workflow = await requireWorkflowAccess(c.env.DB, user.id, workflowId, "BUILDER");
  return c.json(await createWorkflowJob(c.env, user.id, workflow, "duplicate_automation_workflow", {
    session: c.get("client_session_id") || c.req.header("ClientSessionId") || "",
    action_group: c.req.header("ClientUndoRedoActionGroupId") || null,
  }), 202);
});

automation.post("/workflows/:workflowId/publish/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  const workflow = await requireWorkflowAccess(c.env.DB, user.id, workflowId, "BUILDER");
  return c.json(await createWorkflowJob(c.env, user.id, workflow, "publish_automation_workflow"), 202);
});

automation.post("/workflows/:workflowId/test/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  await requireWorkflowAccess(c.env.DB, user.id, workflowId, "BUILDER");
  return c.json(await toggleWorkflowTestRun(c.env.DB, workflowId), 202);
});

automation.get("/workflows/:workflowId/history/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  await requireWorkflowAccess(c.env.DB, user.id, workflowId);
  return c.json(await listWorkflowHistory(
    c.env.DB,
    workflowId,
    Number(c.req.query("page") || 1),
    Number(c.req.query("size") || 100)
  ));
});

automation.get("/workflows/:workflowId/history/:historyId/nodes/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  const historyId = Number(c.req.param("historyId"));
  await requireWorkflowAccess(c.env.DB, user.id, workflowId);
  return c.json(await listNodeHistory(c.env.DB, historyId));
});

automation.get("/workflow/:workflowId/nodes/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const workflowId = Number(c.req.param("workflowId"));
  await requireWorkflowAccess(c.env.DB, user?.id, workflowId);
  return c.json(await listNodes(c.env.DB, workflowId));
});

automation.post("/workflow/:workflowId/nodes/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowId = Number(c.req.param("workflowId"));
  const workflow = await requireWorkflowAccess(c.env.DB, user.id, workflowId, "BUILDER");
  const before = await snapshotAutomationWorkflow(c.env.DB, workflowId);
  const result = await createNode(c.env.DB, workflow, await c.req.json<Record<string, unknown>>(), c.env.CACHE);
  await recordNodeAction(c, "create_automation_node", workflowId, before, await snapshotAutomationWorkflow(c.env.DB, workflowId));
  return c.json(result);
});

automation.patch("/node/:nodeId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const nodeId = Number(c.req.param("nodeId"));
  const node = await requireNodeAccess(c.env.DB, user.id, nodeId, "BUILDER");
  const before = await snapshotAutomationWorkflow(c.env.DB, node.workflow_id);
  const result = await updateNode(c.env.DB, nodeId, await c.req.json<Record<string, unknown>>(), c.env.CACHE);
  await recordNodeAction(c, "update_automation_node", node.workflow_id, before, await snapshotAutomationWorkflow(c.env.DB, node.workflow_id));
  return c.json(result);
});

automation.delete("/node/:nodeId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const nodeId = Number(c.req.param("nodeId"));
  const node = await requireNodeAccess(c.env.DB, user.id, nodeId, "BUILDER");
  const before = await snapshotAutomationWorkflow(c.env.DB, node.workflow_id);
  await deleteNode(c.env.DB, node, user.id);
  await recordNodeAction(c, "delete_automation_node", node.workflow_id, before, await snapshotAutomationWorkflow(c.env.DB, node.workflow_id));
  return c.body(null, 204);
});

automation.post("/node/:nodeId/duplicate/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const nodeId = Number(c.req.param("nodeId"));
  const node = await requireNodeAccess(c.env.DB, user.id, nodeId, "BUILDER");
  const before = await snapshotAutomationWorkflow(c.env.DB, node.workflow_id);
  const result = await duplicateNode(c.env.DB, node, c.env.CACHE);
  await recordNodeAction(c, "duplicate_automation_node", node.workflow_id, before, await snapshotAutomationWorkflow(c.env.DB, node.workflow_id));
  return c.json(result);
});

automation.post("/node/:nodeId/replace/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const nodeId = Number(c.req.param("nodeId"));
  const node = await requireNodeAccess(c.env.DB, user.id, nodeId, "BUILDER");
  const body = await c.req.json<{ new_type?: string }>();
  const before = await snapshotAutomationWorkflow(c.env.DB, node.workflow_id);
  const result = await replaceNode(c.env.DB, node, String(body.new_type || ""), c.env.CACHE);
  await recordNodeAction(c, "replace_automation_node", node.workflow_id, before, await snapshotAutomationWorkflow(c.env.DB, node.workflow_id));
  return c.json(result);
});

automation.post("/node/:nodeId/move/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const nodeId = Number(c.req.param("nodeId"));
  const node = await requireNodeAccess(c.env.DB, user.id, nodeId, "BUILDER");
  const before = await snapshotAutomationWorkflow(c.env.DB, node.workflow_id);
  await moveNode(c.env.DB, node, await c.req.json<Record<string, unknown>>());
  await recordNodeAction(c, "move_automation_node", node.workflow_id, before, await snapshotAutomationWorkflow(c.env.DB, node.workflow_id));
  return c.body(null, 202);
});

automation.post("/node/:nodeId/simulate-dispatch/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const nodeId = Number(c.req.param("nodeId"));
  const node = await requireNodeAccess(c.env.DB, user.id, nodeId, "BUILDER");
  return c.json(await toggleWorkflowTestRun(c.env.DB, node.workflow_id, nodeId), 202);
});

export { automation as automationRouter };
