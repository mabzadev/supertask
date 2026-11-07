import type { D1Database } from "@cloudflare/workers-types";
import { ApiError, DoesNotExist, ValidationError } from "../middleware/error";
import type { Env } from "../types/env";
import { dispatchWorkflowAction, serializeWorkflowActionService } from "./builder";
import { listIntegrations } from "./application-extras";
import { assertHasApplicationRole } from "./enterprise-permissions";
import { evaluateCommonRuntimeFormulaCall } from "./runtime-formulas";
import { parseFormulaAst } from "./formula-engine";
import { workspaceGenerativeAISettings } from "./generative-ai";
import { deleteTrashEntry, recordTrashEntry } from "./trash";

type JsonObject = Record<string, unknown>;
type GraphNode = { next?: Record<string, number[]>; children?: number[] };
type Graph = Record<string, GraphNode | number>;
type FormulaContext = {
  eventPayload: JsonObject;
  previousResults: JsonObject;
  currentIterations: Record<number, number>;
};

const TRIGGER_TYPES = new Set([
  "local_supertask_rows_created",
  "local_supertask_rows_updated",
  "local_supertask_rows_deleted",
  "periodic",
  "http_trigger",
]);
const ACTION_TYPES = new Set([
  "local_supertask_create_row",
  "local_supertask_update_row",
  "local_supertask_delete_row",
  "local_supertask_get_row",
  "local_supertask_list_rows",
  "local_supertask_aggregate_rows",
  "http_request",
  "iterator",
  "smtp_email",
  "router",
  "ai_agent",
]);
const AUTOMATION_WORKFLOW_MAX_CONSECUTIVE_ERRORS = 5;
const AUTOMATION_WORKFLOW_HISTORY_MAX_DAYS = 30;
const AUTOMATION_WORKFLOW_HISTORY_MAX_ENTRIES = 50;
const AUTOMATION_WORKFLOW_HISTORY_DELETE_BATCH_SIZE = 90;
const AUTOMATION_WORKFLOW_NAME_MAX_LENGTH = 255;
const AUTOMATION_WORKFLOW_TEST_RUN_MINUTES = 5;
const AUTOMATION_WORKFLOW_STATES = new Set(["draft", "live", "paused", "disabled"]);
const AUTOMATION_NODE_LABEL_MAX_LENGTH = 75;
const AUTOMATION_NODE_POSITIONS = new Set(["south", "child"]);
const AUTOMATION_FORMULA_MODES = new Set(["simple", "advanced", "raw"]);
const AUTOMATION_HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const AUTOMATION_HTTP_BODY_TYPES = new Set(["json", "form", "raw", "none"]);
const AUTOMATION_PERIODIC_INTERVALS = new Set(["MINUTE", "HOUR", "DAY", "WEEK", "MONTH"]);
const AUTOMATION_AI_PROVIDERS = new Set(["openai", "anthropic", "mistral", "ollama", "openrouter"]);
const AUTOMATION_AGGREGATION_TYPES = new Set([
  "count", "empty_count", "not_empty_count", "checked_count", "not_checked_count",
  "empty_percentage", "not_empty_percentage", "checked_percentage", "not_checked_percentage",
  "unique_count", "min", "max", "min_date", "max_date", "sum", "average", "std_dev",
  "variance", "median",
]);
const AUTOMATION_AGGREGATION_EMPTY_FIELD_TYPES = new Set([
  "text", "long_text", "url", "number", "rating", "date", "duration", "last_modified",
  "last_modified_by", "created_on", "created_by", "link_row", "email", "file", "phone_number",
  "single_select", "multiple_select", "password",
]);
const AUTOMATION_AGGREGATION_COUNT_FIELD_TYPES = new Set([...AUTOMATION_AGGREGATION_EMPTY_FIELD_TYPES, "boolean"]);
const AUTOMATION_AGGREGATION_UNIQUE_FIELD_TYPES = new Set([
  "text", "long_text", "url", "number", "rating", "date", "last_modified", "last_modified_by",
  "created_on", "created_by", "email", "phone_number", "single_select", "duration",
]);
const AUTOMATION_AGGREGATION_MIN_MAX_FIELD_TYPES = new Set(["number", "rating", "autonumber", "duration"]);
const AUTOMATION_AGGREGATION_NUMERIC_FIELD_TYPES = new Set(["number", "rating"]);
const AUTOMATION_AGGREGATION_DATE_FIELD_TYPES = new Set(["date", "last_modified", "created_on"]);

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function graphOf(workflow: any): Graph {
  return parseJson<Graph>(workflow.graph, {});
}

function serviceOf(node: any): JsonObject {
  return parseJson<JsonObject>(node.service, {});
}

function isTriggerType(type: string) {
  return TRIGGER_TYPES.has(type);
}

function requestBodyValidationError(detail: string): never {
  throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", detail);
}

function automationNodeType(value: unknown, field = "type") {
  if (typeof value !== "string" || !value || (!TRIGGER_TYPES.has(value) && !ACTION_TYPES.has(value))) {
    requestBodyValidationError(`${field}: \"${String(value ?? "")}\" is not a valid choice.`);
  }
  return value;
}

function automationNodePosition(value: unknown) {
  if (value === undefined || value === "") return "south";
  if (typeof value !== "string" || !AUTOMATION_NODE_POSITIONS.has(value)) {
    requestBodyValidationError(`position: \"${String(value ?? "")}\" is not a valid choice.`);
  }
  return value;
}

function automationNodeOutput(value: unknown) {
  if (value === undefined) return "";
  if (typeof value !== "string") requestBodyValidationError("output: Not a valid string.");
  return value;
}

function automationNodeReferenceId(value: unknown) {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) requestBodyValidationError("reference_node_id: A valid integer is required.");
  return parsed;
}

function automationNodeLabel(value: unknown) {
  if (typeof value !== "string") requestBodyValidationError("label: Not a valid string.");
  if (value.length > AUTOMATION_NODE_LABEL_MAX_LENGTH) {
    requestBodyValidationError(`label: Ensure this field has no more than ${AUTOMATION_NODE_LABEL_MAX_LENGTH} characters.`);
  }
  return value;
}

function automationNodeService(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    requestBodyValidationError("service: Expected an object.");
  }
  return value;
}

function orderValue(maxOrder: number | string | null | undefined) {
  return Number(maxOrder || 0) + 1;
}

export async function ensureAutomationDefaults(
  db: D1Database,
  automationId: number,
  initializeWorkflow = false,
) {
  if (initializeWorkflow) {
    const count = await db.prepare(
      `SELECT COUNT(*) AS count FROM automation_workflow
       WHERE automation_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=0`
    )
      .bind(automationId)
      .first<{ count: number }>()
      .catch(() => ({ count: 0 }));
    if ((count?.count ?? 0) === 0) {
      await createWorkflow(db, automationId, { name: "Workflow" });
    }
  }

  const integrationCount = await db.prepare("SELECT COUNT(*) AS count FROM core_integration WHERE application_id=? AND type='local_supertask'")
    .bind(automationId)
    .first<{ count: number }>()
    .catch(() => ({ count: 0 }));
  if ((integrationCount?.count ?? 0) === 0) {
    const now = nowIso();
    await db.prepare(
      `INSERT INTO core_integration (application_id, type, name, [order], configuration, created_on, updated_on)
       VALUES (?, 'local_supertask', 'Local Supertask', 1, '{}', ?, ?)`
    ).bind(automationId, now, now).run();
  }
}

export async function requireAutomationAccess(db: D1Database, userId: number | undefined, automationId: number, requiredRole = "VIEWER") {
  const app = await db.prepare(
    `SELECT a.*
     FROM core_application a
     WHERE a.id = ? AND a.type = 'automation' AND a.trashed = 0
    `
  ).bind(automationId).first<any>();
  if (!app) throw new DoesNotExist("Automation", automationId);
  await assertHasApplicationRole(db, userId, automationId, requiredRole);
  return app;
}

export async function requireWorkflowAccess(db: D1Database, userId: number | undefined, workflowId: number, requiredRole = "VIEWER") {
  const workflow = await db.prepare(
    `SELECT wf.*, a.workspace_id
     FROM automation_workflow wf
     JOIN core_application a ON a.id = wf.automation_id
     WHERE wf.id = ? AND wf.trashed = 0 AND a.trashed = 0
       AND a.type = 'automation'`
  ).bind(workflowId).first<any>();
  if (!workflow) throw new DoesNotExist("Automation workflow", workflowId);
  await assertHasApplicationRole(db, userId, Number(workflow.automation_id), requiredRole);
  return workflow;
}

export async function requireNodeAccess(db: D1Database, userId: number | undefined, nodeId: number, requiredRole = "VIEWER") {
  const node = await db.prepare(
    `SELECT n.*, wf.automation_id, a.workspace_id, wf.graph, wf.state
     FROM automation_node n
     JOIN automation_workflow wf ON wf.id = n.workflow_id
     JOIN core_application a ON a.id = wf.automation_id
     WHERE n.id = ? AND n.trashed = 0 AND wf.trashed = 0 AND a.trashed = 0
       AND a.type = 'automation'`
  ).bind(nodeId).first<any>();
  if (!node) throw new DoesNotExist("Automation node", nodeId);
  await assertHasApplicationRole(db, userId, Number(node.automation_id), requiredRole);
  return node;
}

export async function serializeAutomationApplication(db: D1Database, app: any) {
  await ensureAutomationDefaults(db, app.id);
  return {
    workflows: await listWorkflows(db, app.id),
    integrations: await listIntegrations(db, app.id),
  };
}

export function serializeWorkflow(row: any, published?: any) {
  return {
    id: row.id,
    name: row.name,
    order: row.order,
    automation_id: row.automation_id,
    allow_test_run_until: row.allow_test_run_until ?? null,
    simulate_until_node_id: row.simulate_until_node_id ?? null,
    published_on: published?.published_on ?? published?.created_on ?? row.published_on ?? null,
    state: published?.state || row.state || "draft",
    graph: graphOf(row),
  };
}

export async function serializeNode(db: D1Database, row: any) {
  return {
    id: row.id,
    label: row.label || "",
    service: await serializeAutomationNodeService(db, row, serviceOf(row)),
    workflow: row.workflow_id,
    workflow_id: row.workflow_id,
    type: row.type,
  };
}

async function serializeAutomationNodeService(db: D1Database, row: any, serviceConfig: JsonObject): Promise<JsonObject> {
  const workflow = await workflowForNode(db, row);
  const normalized = await normalizeService(db, workflow, String(row.type || ""), serviceConfig, {}, false, false);
  const service = await serializeWorkflowActionService(db, row, normalized);
  const coreSchema = automationCoreServiceSchema(String(service.type || row.type), Number(service.id || row.id), service);
  if (coreSchema) service.schema = coreSchema;
  if (service.context_data === undefined) service.context_data = null;
  if (service.context_data_schema === undefined) service.context_data_schema = null;
  return service;
}

export function serializeWorkflowHistory(row: any) {
  return {
    id: row.id,
    started_on: row.started_on,
    completed_on: row.completed_on ?? null,
    is_test_run: Boolean(row.is_test_run),
    message: row.message || "",
    status: row.status,
  };
}

export async function listWorkflows(db: D1Database, automationId: number) {
  await ensureAutomationDefaults(db, automationId);
  const rows = await db.prepare(
    `SELECT * FROM automation_workflow
     WHERE automation_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=0
     ORDER BY [order] ASC, id ASC`
  )
    .bind(automationId)
    .all<any>();
  return Promise.all((rows.results || []).map((row: any) => serializeWorkflowWithPublished(db, row)));
}

export async function createWorkflow(db: D1Database, automationId: number, body: JsonObject) {
  const name = String(body.name ?? "").trim();
  if (!name || name.length > AUTOMATION_WORKFLOW_NAME_MAX_LENGTH) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "The workflow name must contain between 1 and 255 characters.");
  }
  const now = nowIso();
  const max = await db.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM automation_workflow WHERE automation_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=0"
  )
    .bind(automationId)
    .first<{ max_order: number }>();
  const row = await db.prepare(
    `INSERT INTO automation_workflow
     (automation_id, name, [order], state, graph, trashed, created_on, updated_on)
     SELECT ?, ?, ?, 'draft', '{}', 0, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM automation_workflow WHERE automation_id=? AND name=?
      )
     RETURNING *`
  ).bind(automationId, name, orderValue(max?.max_order), now, now, automationId, name).first<any>();
  if (!row) {
    throw new ApiError(
      400,
      "ERROR_AUTOMATION_WORKFLOW_NAME_NOT_UNIQUE",
      `The workflow name ${name} already exists for your automation instance.`,
    );
  }
  return serializeWorkflow(row);
}

export async function updateWorkflow(db: D1Database, workflowId: number, body: JsonObject) {
  const existing = await db.prepare("SELECT * FROM automation_workflow WHERE id=? AND trashed=0").bind(workflowId).first<any>();
  if (!existing) throw new DoesNotExist("Automation workflow", workflowId);
  const name = body.name === undefined ? String(existing.name) : String(body.name).trim();
  if (!name || name.length > AUTOMATION_WORKFLOW_NAME_MAX_LENGTH) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "The workflow name must contain between 1 and 255 characters.");
  }
  if (body.allow_test_run !== undefined && typeof body.allow_test_run !== "boolean") {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "allow_test_run must be a boolean.");
  }
  const requestedState = body.state === undefined ? String(existing.state || "draft") : String(body.state);
  if (!AUTOMATION_WORKFLOW_STATES.has(requestedState)) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "The workflow state is invalid.");
  }
  const now = nowIso();
  const published = await getPublishedWorkflow(db, workflowId);
  const allowTestRunUntil = body.allow_test_run === true
    ? new Date(Date.now() + AUTOMATION_WORKFLOW_TEST_RUN_MINUTES * 60 * 1000).toISOString()
    : body.allow_test_run === false
      ? null
      : existing.allow_test_run_until;
  const updated = await db.prepare(
    `UPDATE automation_workflow
        SET name=?, state=?, allow_test_run_until=?, updated_on=?
      WHERE id=?
        AND NOT EXISTS (
          SELECT 1 FROM automation_workflow duplicate
           WHERE duplicate.automation_id=? AND duplicate.name=? AND duplicate.id<>?
        )
     RETURNING *`
  ).bind(
    name,
    published ? existing.state : requestedState,
    allowTestRunUntil,
    now,
    workflowId,
    existing.automation_id,
    name,
    workflowId,
  ).first<any>();
  if (!updated) {
    throw new ApiError(
      400,
      "ERROR_AUTOMATION_WORKFLOW_NAME_NOT_UNIQUE",
      `The workflow name ${name} already exists for your automation instance.`,
    );
  }
  if (body.state !== undefined && published) {
    await db.prepare("UPDATE automation_workflow SET state=?, updated_on=? WHERE id=?")
      .bind(requestedState, now, published.id)
      .run();
  }
  return serializeWorkflowWithPublished(db, updated);
}

export async function orderWorkflows(db: D1Database, automationId: number, workflowIds: number[]) {
  const requested = workflowIds.map(Number);
  if (requested.some((id) => !Number.isInteger(id) || id <= 0) || new Set(requested).size !== requested.length) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "workflow_ids must contain unique workflow ids.");
  }
  const rows = await db.prepare(
    `SELECT id FROM automation_workflow
     WHERE automation_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=0
     ORDER BY [order] ASC, id ASC`
  ).bind(automationId).all<{ id: number }>();
  const current = (rows.results || []).map((row) => Number(row.id));
  const available = new Set(current);
  const foreignId = requested.find((id) => !available.has(id));
  if (foreignId !== undefined) {
    throw new ApiError(
      400,
      "ERROR_AUTOMATION_WORKFLOW_NOT_IN_AUTOMATION",
      `The workflow ${foreignId} does not belong to automation ${automationId}.`,
    );
  }
  const fullOrder = [...requested, ...current.filter((id) => !requested.includes(id))];
  const now = nowIso();
  const statements = fullOrder.map((id, index) =>
    db.prepare("UPDATE automation_workflow SET [order]=?, updated_on=? WHERE id=? AND automation_id=?")
      .bind(index + 1, now, id, automationId)
  );
  for (let index = 0; index < statements.length; index += 80) {
    await db.batch(statements.slice(index, index + 80));
  }
}

export async function listNodes(db: D1Database, workflowId: number) {
  const rows = await db.prepare("SELECT * FROM automation_node WHERE workflow_id=? AND trashed=0 ORDER BY id ASC")
    .bind(workflowId)
    .all<any>();
  return Promise.all((rows.results || []).map((row) => serializeNode(db, row)));
}

export async function createNode(db: D1Database, workflow: any, body: JsonObject, cache?: KVNamespace) {
  const type = automationNodeType(body.type);
  const position = automationNodePosition(body.position);
  const output = automationNodeOutput(body.output);
  const label = body.label === undefined ? "" : automationNodeLabel(body.label);
  const serviceInput = body.service === undefined ? undefined : automationNodeService(body.service);
  const existingNodes = await db.prepare("SELECT * FROM automation_node WHERE workflow_id=? AND trashed=0 ORDER BY id ASC")
    .bind(workflow.id)
    .all<any>();
  const trigger = (existingNodes.results || []).find((node: any) => isTriggerType(node.type));
  const referenceNodeId = automationNodeReferenceId(body.reference_node_id);
  if (!trigger && !isTriggerType(type)) {
    throw new ApiError(400, "ERROR_AUTOMATION_FIRST_NODE_MUST_BE_TRIGGER", "This operation is disallowed because an action can't be the first node of the workflow");
  }
  if (trigger && isTriggerType(type)) {
    throw new ApiError(400, "ERROR_AUTOMATION_TRIGGER_ALREADY_EXISTS", "This workflow already has a trigger");
  }
  if (isTriggerType(type) && referenceNodeId !== null) {
    throw new ApiError(400, "ERROR_AUTOMATION_TRIGGER_MUST_BE_FIRST_NODE", "This operation is disallowed because a trigger must be the first node of the workflow");
  }
  if (!isTriggerType(type) && referenceNodeId === null) {
    throw new ApiError(400, "ERROR_AUTOMATION_FIRST_NODE_MUST_BE_TRIGGER", "An action node must reference an existing workflow node.");
  }

  const graph = graphOf(workflow);
  validateGraphPosition(graph, existingNodes.results || [], referenceNodeId, position, output);

  const now = nowIso();
  const service = await normalizeService(db, workflow, type, serviceInput, {}, true, true, cache);
  const row = await db.prepare(
    `INSERT INTO automation_node (workflow_id, type, label, service, trashed, created_on, updated_on)
     VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING *`
  ).bind(workflow.id, type, label, JSON.stringify(service), now, now).first<any>();
  if (!row) throw new Error("Failed to create automation node");

  insertNodeInGraph(graph, row.id, referenceNodeId, position, output, existingNodes.results || []);
  await saveWorkflowGraph(db, workflow.id, graph);
  return serializeNode(db, row);
}

export async function updateNode(db: D1Database, nodeId: number, body: JsonObject, cache?: KVNamespace) {
  const existing = await db.prepare("SELECT * FROM automation_node WHERE id=? AND trashed=0").bind(nodeId).first<any>();
  if (!existing) throw new DoesNotExist("Automation node", nodeId);
  if (body.type !== undefined) automationNodeType(body.type);
  const label = body.label === undefined ? String(existing.label || "") : automationNodeLabel(body.label);
  const serviceInput = body.service === undefined ? undefined : automationNodeService(body.service);
  const workflow = await workflowForNode(db, existing);
  const service = serviceInput !== undefined
    ? await normalizeService(db, workflow, String(existing.type), serviceInput, serviceOf(existing), false, true, cache)
    : serviceOf(existing);
  if (existing.type === "router" && serviceInput !== undefined) {
    validateRouterEdgesUpdate(graphOf(workflow), existing, service);
  }
  await db.prepare("UPDATE automation_node SET label=?, service=?, updated_on=? WHERE id=?")
    .bind(
      label,
      JSON.stringify(service),
      nowIso(),
      nodeId
    )
    .run();
  const updated = await db.prepare("SELECT * FROM automation_node WHERE id=?").bind(nodeId).first<any>();
  return serializeNode(db, updated);
}

export async function deleteNode(db: D1Database, node: any, userId: number) {
  const workflow = await db.prepare(
    `SELECT wf.*, a.workspace_id
     FROM automation_workflow wf
     JOIN core_application a ON a.id=wf.automation_id
     WHERE wf.id=?`,
  ).bind(node.workflow_id).first<any>();
  const graph = graphOf(workflow);
  assertNodeDeletable(graph, node);
  const restorationData = nodeGraphPosition(graph, Number(node.id));
  removeNodeFromGraph(graph, node.id);
  const context = await db.prepare(
    `SELECT wf.name AS workflow_name, wf.automation_id, a.workspace_id
     FROM automation_workflow wf
     JOIN core_application a ON a.id=wf.automation_id
     WHERE wf.id=?`
  ).bind(node.workflow_id).first<any>();
  if (!context) throw new DoesNotExist("Automation workflow", node.workflow_id);

  const now = nowIso();
  await recordTrashEntry(db, {
    userId,
    workspaceId: Number(context.workspace_id),
    applicationId: Number(context.automation_id),
    trashItemType: "automation_node",
    trashItemId: Number(node.id),
    name: `${node.type} (${node.id})`,
    parentName: String(context.workflow_name || ""),
    extra: {
      workflow_id: Number(node.workflow_id),
      reference_node_id: restorationData.referenceNodeId,
      position: restorationData.position,
      output: restorationData.output,
    },
    trashedAt: now,
  });
  try {
    await db.batch([
      db.prepare("UPDATE automation_node SET trashed=1, updated_on=? WHERE id=?").bind(now, node.id),
      db.prepare("UPDATE automation_workflow SET graph=?, updated_on=? WHERE id=?")
        .bind(JSON.stringify(graph), now, node.workflow_id),
    ]);
  } catch (error) {
    await deleteTrashEntry(db, "automation_node", Number(node.id), null).catch(() => undefined);
    throw error;
  }
}

export async function restoreNodeFromTrash(
  db: D1Database,
  nodeId: number,
  restorationData: JsonObject,
) {
  const node = await db.prepare(
    `SELECT n.*, wf.graph, wf.trashed AS workflow_trashed, a.trashed AS app_trashed
     FROM automation_node n
     JOIN automation_workflow wf ON wf.id=n.workflow_id
     JOIN core_application a ON a.id=wf.automation_id
     WHERE n.id=? AND n.trashed=1`
  ).bind(nodeId).first<any>();
  if (!node) throw new DoesNotExist("Automation node", nodeId);
  if (node.workflow_trashed || node.app_trashed) {
    throw new ValidationError("The parent automation workflow must be restored before this node.");
  }

  const graph = graphOf(node);
  const referenceNodeId = restorationData.reference_node_id === null || restorationData.reference_node_id === undefined
    ? null
    : Number(restorationData.reference_node_id);
  const position = String(restorationData.position || "south");
  const output = String(restorationData.output || "");
  const activeNodes = await db.prepare(
    "SELECT * FROM automation_node WHERE workflow_id=? AND trashed=0 ORDER BY id ASC"
  ).bind(node.workflow_id).all<any>();

  if (referenceNodeId !== null) {
    const reference = nodeById(activeNodes.results || [], referenceNodeId);
    if (!reference || !graphNode(graph, referenceNodeId)) {
      throw new ValidationError("This automation node cannot be restored as its reference node has been deleted.");
    }
    if (output) {
      const edgeUids = new Set(
        (Array.isArray(serviceOf(reference).edges) ? serviceOf(reference).edges as JsonObject[] : [])
          .map((edge) => String(edge.uid || ""))
          .filter(Boolean)
      );
      if (!edgeUids.has(output)) {
        throw new ValidationError("This automation node cannot be restored as its branch has been deleted.");
      }
    }
  }
  validateGraphPosition(graph, activeNodes.results || [], referenceNodeId, position, output, nodeId);
  insertNodeInGraph(graph, nodeId, referenceNodeId, position, output, activeNodes.results || []);
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE automation_node SET trashed=0, updated_on=? WHERE id=?").bind(now, nodeId),
    db.prepare("UPDATE automation_workflow SET graph=?, updated_on=? WHERE id=?")
      .bind(JSON.stringify(graph), now, node.workflow_id),
  ]);
}

export async function permanentlyDeleteNode(db: D1Database, nodeId: number) {
  await db.prepare("DELETE FROM automation_node WHERE id=? AND trashed=1").bind(nodeId).run();
}

export async function deleteWorkflow(db: D1Database, workflow: any, userId: number) {
  const originalId = Number(workflow.published_from_workflow_id || workflow.id);
  const original = await db.prepare(
    `SELECT wf.*, a.workspace_id, a.name AS automation_name
     FROM automation_workflow wf
     JOIN core_application a ON a.id=wf.automation_id
     WHERE wf.id=? AND COALESCE(wf.is_published_version, 0)=0`
  ).bind(originalId).first<any>();
  if (!original) return;

  await deletePublishedWorkflowVersions(db, originalId);
  const trashedAt = nowIso();
  await db.prepare("UPDATE automation_workflow SET trashed=1, updated_on=? WHERE id=?")
    .bind(trashedAt, originalId)
    .run();
  await recordTrashEntry(db, {
    userId,
    workspaceId: Number(original.workspace_id),
    applicationId: Number(original.automation_id),
    trashItemType: "automation_workflow",
    trashItemId: originalId,
    name: String(original.name || ""),
    parentName: String(original.automation_name || ""),
    trashedAt,
  });
}

function workflowGraphNodeIds(workflow: any): number[] {
  const ids = new Set<number>();
  const graph = graphOf(workflow);
  for (const [key, value] of Object.entries(graph)) {
    if (/^\d+$/.test(key)) ids.add(Number(key));
    if (typeof value === "number" && Number.isFinite(value)) ids.add(value);
    if (!value || typeof value !== "object") continue;
    for (const child of value.children || []) {
      if (Number.isFinite(Number(child))) ids.add(Number(child));
    }
    for (const outputIds of Object.values(value.next || {})) {
      for (const child of outputIds || []) {
        if (Number.isFinite(Number(child))) ids.add(Number(child));
      }
    }
  }
  return [...ids];
}

export async function restoreWorkflowFromTrash(db: D1Database, workflowId: number) {
  const workflow = await db.prepare(
    `SELECT * FROM automation_workflow
     WHERE id=? AND trashed=1 AND COALESCE(is_published_version, 0)=0`
  ).bind(workflowId).first<any>();
  if (!workflow) throw new DoesNotExist("Automation workflow", workflowId);

  await deletePublishedWorkflowVersions(db, workflowId);
  const graphNodeIds = workflowGraphNodeIds(workflow);
  for (let index = 0; index < graphNodeIds.length; index += 80) {
    const ids = graphNodeIds.slice(index, index + 80);
    await db.prepare(
      `UPDATE automation_node SET trashed=0, updated_on=?
       WHERE workflow_id=? AND id IN (${ids.map(() => "?").join(", ")})`
    ).bind(nowIso(), workflowId, ...ids).run();
  }
  await db.prepare("UPDATE automation_workflow SET trashed=0, updated_on=? WHERE id=?")
    .bind(nowIso(), workflowId)
    .run();
}

export async function permanentlyDeleteWorkflow(db: D1Database, workflowId: number) {
  await deletePublishedWorkflowVersions(db, workflowId);
  await db.prepare(
    `DELETE FROM automation_workflow
     WHERE id=? AND trashed=1 AND COALESCE(is_published_version, 0)=0`
  ).bind(workflowId).run();
}

export async function duplicateNode(db: D1Database, node: any, cache?: KVNamespace) {
  if (isTriggerType(node.type)) {
    throw new ApiError(400, "ERROR_AUTOMATION_TRIGGER_ALREADY_EXISTS", "This workflow already has a trigger");
  }
  const workflow = await db.prepare(
    `SELECT wf.*, a.workspace_id
     FROM automation_workflow wf
     JOIN core_application a ON a.id=wf.automation_id
     WHERE wf.id=?`,
  ).bind(node.workflow_id).first<any>();
  return createNode(db, workflow, {
    type: node.type,
    label: node.label,
    service: serviceOf(node),
    reference_node_id: node.id,
    position: "south",
    output: "",
  }, cache);
}

export async function replaceNode(db: D1Database, node: any, newType: string, cache?: KVNamespace) {
  newType = automationNodeType(newType, "new_type");
  if (isTriggerType(node.type) !== isTriggerType(newType)) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_REPLACEABLE", "A trigger node can only be replaced by another trigger node.");
  }
  const workflow = await workflowForNode(db, node);
  const graph = graphOf(workflow);
  assertNodeReplaceable(graph, node);
  const service = await normalizeService(db, workflow, newType, {}, {}, true, true, cache);
  const now = nowIso();
  const replacement = await db.prepare(
    `INSERT INTO automation_node (workflow_id, type, label, service, trashed, created_on, updated_on)
     VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING *`
  ).bind(node.workflow_id, newType, node.label || "", JSON.stringify(service), now, now).first<any>();
  if (!replacement) throw new Error("Failed to create the replacement automation node.");

  replaceNodeInGraph(graph, Number(node.id), Number(replacement.id));
  try {
    await db.batch([
      db.prepare("UPDATE automation_workflow SET graph=?, simulate_until_node_id=CASE WHEN simulate_until_node_id=? THEN NULL ELSE simulate_until_node_id END, updated_on=? WHERE id=?")
        .bind(JSON.stringify(graph), node.id, now, node.workflow_id),
      db.prepare("UPDATE automation_node SET trashed=1, updated_on=? WHERE id=?")
        .bind(now, node.id),
    ]);
  } catch (error) {
    await db.prepare("DELETE FROM automation_node WHERE id=?").bind(replacement.id).run().catch(() => undefined);
    throw error;
  }
  return serializeNode(db, replacement);
}

export async function moveNode(db: D1Database, node: any, body: JsonObject) {
  if (isTriggerType(node.type)) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_MOVABLE", "Trigger nodes cannot be moved.");
  }
  const workflow = await db.prepare("SELECT * FROM automation_workflow WHERE id=?").bind(node.workflow_id).first<any>();
  const nodes = await db.prepare("SELECT * FROM automation_node WHERE workflow_id=? AND trashed=0 ORDER BY id ASC")
    .bind(node.workflow_id)
    .all<any>();
  const graph = graphOf(workflow);
  const referenceNodeId = automationNodeReferenceId(body.reference_node_id);
  const position = automationNodePosition(body.position);
  const output = automationNodeOutput(body.output);
  if (referenceNodeId === null) {
    throw new ApiError(400, "ERROR_AUTOMATION_FIRST_NODE_MUST_BE_TRIGGER", "An action node must reference an existing workflow node.");
  }
  assertNodeMovable(graph, node, referenceNodeId);
  validateGraphPosition(graph, nodes.results || [], referenceNodeId, position, output, node.id);
  removeNodeFromGraph(graph, node.id);
  insertNodeInGraph(graph, node.id, referenceNodeId, position, output, nodes.results || []);
  await saveWorkflowGraph(db, node.workflow_id, graph);
}

export async function publishWorkflow(db: D1Database, workflow: any) {
  const now = nowIso();
  await deletePublishedWorkflowVersions(db, workflow.id);
  const published = await cloneWorkflowVersion(db, workflow, {
    name: `${workflow.name} [published ${now}]`,
    state: "live",
    publishedOn: now,
    publishedFromWorkflowId: Number(workflow.id),
    isPublishedVersion: true,
  });
  await db.prepare("UPDATE automation_workflow SET state='draft', published_on=?, updated_on=? WHERE id=?")
    .bind(now, now, workflow.id)
    .run();
  return {
    automation_workflow_id: workflow.id,
    published_automation_workflow_id: published.id,
  };
}

export async function duplicateWorkflow(db: D1Database, workflow: any) {
  const copy = await cloneWorkflowVersion(db, workflow, {
    name: await findUnusedWorkflowName(db, workflow.automation_id, workflow.name),
    state: "draft",
  });
  const graph = graphOf(copy);
  const serializedCopy = await serializeWorkflowWithPublished(db, copy);
  return {
    original_automation_workflow: serializeWorkflow(workflow),
    duplicated_automation_workflow: { ...serializedCopy, graph },
    automation_workflow_id: Number(copy.id),
  };
}

export async function duplicateAutomationApplication(db: D1Database, sourceAutomationId: number, duplicatedAutomationId: number) {
  const now = nowIso();
  const integrationMap = new Map<number, number>();
  const httpUidMap = new Map<string, string>();

  const integrations = await db.prepare(
    "SELECT * FROM core_integration WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC"
  ).bind(sourceAutomationId).all<any>();
  for (const integration of integrations.results || []) {
    const inserted = await db.prepare(
      `INSERT INTO core_integration (application_id, type, name, [order], configuration, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      duplicatedAutomationId,
      integration.type,
      integration.name,
      integration.order,
      integration.configuration || "{}",
      now,
      now
    ).first<{ id: number }>();
    if (inserted?.id) integrationMap.set(Number(integration.id), Number(inserted.id));
  }

  const workflows = await db.prepare(
    `SELECT * FROM automation_workflow
     WHERE automation_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=0
     ORDER BY [order] ASC, id ASC`
  ).bind(sourceAutomationId).all<any>();

  for (const workflow of workflows.results || []) {
    const published = await getPublishedWorkflow(db, Number(workflow.id));
    const copiedWorkflow = await cloneWorkflowVersion(db, workflow, {
      targetAutomationId: duplicatedAutomationId,
      name: workflow.name,
      state: workflow.state || "draft",
      publishedOn: published?.published_on || workflow.published_on || null,
      integrationMap,
      regenerateHttpUid: true,
      httpUidMap,
    });

    if (published) {
      await cloneWorkflowVersion(db, published, {
        targetAutomationId: duplicatedAutomationId,
        name: published.name,
        state: published.state || "live",
        publishedOn: published.published_on || published.created_on || now,
        publishedFromWorkflowId: Number(copiedWorkflow.id),
        isPublishedVersion: true,
        integrationMap,
        regenerateHttpUid: true,
        httpUidMap,
      });
    }
  }
}

async function serializeWorkflowWithPublished(db: D1Database, workflow: any) {
  return serializeWorkflow(workflow, await getPublishedWorkflow(db, workflow.id));
}

async function getPublishedWorkflow(db: D1Database, workflowId: number) {
  return db.prepare(
    `SELECT * FROM automation_workflow
     WHERE published_from_workflow_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=1
     ORDER BY id DESC LIMIT 1`
  ).bind(workflowId).first<any>();
}

async function deletePublishedWorkflowVersions(db: D1Database, workflowId: number) {
  const rows = await db.prepare(
    "SELECT id FROM automation_workflow WHERE published_from_workflow_id=? AND COALESCE(is_published_version, 0)=1"
  ).bind(workflowId).all<{ id: number }>();
  const workflowIds = (rows.results || []).map((row) => Number(row.id)).filter(Number.isFinite);
  if (workflowIds.length === 0) return;

  const workflowBindMarks = workflowIds.map(() => "?").join(", ");
  const nodeRows = await db.prepare(
    `SELECT id FROM automation_node
     WHERE workflow_id IN (${workflowBindMarks})`
  ).bind(...workflowIds).all<{ id: number }>();
  const nodeIds = (nodeRows.results || []).map((row) => Number(row.id)).filter(Number.isFinite);
  if (nodeIds.length > 0) {
    const nodeBindMarks = nodeIds.map(() => "?").join(", ");
    await db.prepare(
      `DELETE FROM automation_node_history
       WHERE node_id IN (${nodeBindMarks})`
    ).bind(...nodeIds).run();
  }
  await db.prepare(
    `DELETE FROM automation_workflow_history
     WHERE workflow_id IN (${workflowBindMarks})`
  ).bind(...workflowIds).run();
  await db.prepare(
    `DELETE FROM automation_node
     WHERE workflow_id IN (${workflowBindMarks})`
  ).bind(...workflowIds).run();
  await db.prepare(
    `DELETE FROM automation_workflow
     WHERE id IN (${workflowBindMarks})`
  ).bind(...workflowIds).run();
}

async function cloneWorkflowVersion(
  db: D1Database,
  workflow: any,
  options: {
    name: string;
    state: string;
    publishedOn?: string | null;
    publishedFromWorkflowId?: number | null;
    isPublishedVersion?: boolean;
    targetAutomationId?: number;
    integrationMap?: Map<number, number>;
    regenerateHttpUid?: boolean;
    httpUidMap?: Map<string, string>;
  }
) {
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO automation_workflow
     (automation_id, name, [order], state, allow_test_run_until, simulate_until_node_id, published_on,
      graph, trashed, created_on, updated_on, published_from_workflow_id, is_published_version)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, '{}', 0, ?, ?, ?, ?) RETURNING *`
  ).bind(
    options.targetAutomationId || workflow.automation_id,
    options.name,
    workflow.order,
    options.state,
    options.publishedOn || null,
    now,
    now,
    options.publishedFromWorkflowId || null,
    options.isPublishedVersion ? 1 : 0
  ).first<any>();
  if (!row) throw new Error("Failed to clone automation workflow");
  const copyId = Number(row.id);
  const nodes = await db.prepare("SELECT * FROM automation_node WHERE workflow_id=? AND trashed=0 ORDER BY id ASC")
    .bind(workflow.id)
    .all<any>();
  const idMap = new Map<number, number>();
  const edgeMap = new Map<string, string>();
  const copiedNodes: Array<{ id: number; service: JsonObject }> = [];
  for (const node of nodes.results || []) {
    const now = nowIso();
    const service = prepareDuplicatedNodeService(
      node.type,
      serviceOf(node),
      edgeMap,
      options.regenerateHttpUid ?? !options.isPublishedVersion,
      options.httpUidMap
    );
    const inserted = await db.prepare(
      `INSERT INTO automation_node (workflow_id, type, label, service, trashed, created_on, updated_on)
       VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING id`
    ).bind(copyId, node.type, node.label, JSON.stringify(service), now, now).first<{ id: number }>();
    if (inserted) {
      idMap.set(Number(node.id), inserted.id);
      copiedNodes.push({ id: inserted.id, service });
    }
  }
  for (const node of copiedNodes) {
    const service = remapAutomationServiceReferences(node.service, idMap, options.integrationMap) as JsonObject;
    await db.prepare("UPDATE automation_node SET service=?, updated_on=? WHERE id=?")
      .bind(JSON.stringify(service), nowIso(), node.id)
      .run();
  }
  const graph = remapGraphIds(graphOf(workflow), idMap, edgeMap);
  await saveWorkflowGraph(db, copyId, graph);
  return { ...row, graph: JSON.stringify(graph) };
}

async function findUnusedWorkflowName(db: D1Database, automationId: number, proposedName: string) {
  const rows = await db.prepare("SELECT name FROM automation_workflow WHERE automation_id=?")
    .bind(automationId)
    .all<{ name: string }>();
  const existing = new Set((rows.results || []).map((row) => String(row.name)));
  const base = proposedName.trim() || "Workflow";
  if (!existing.has(base)) return base;
  for (let index = 2; index < 10000; index++) {
    const candidate = `${base} ${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function prepareDuplicatedNodeService(
  type: string,
  service: JsonObject,
  edgeMap: Map<string, string>,
  regenerateHttpUid = true,
  httpUidMap = new Map<string, string>()
): JsonObject {
  const copy = deepClone(service) as JsonObject;
  if (type === "http_trigger" && regenerateHttpUid) {
    const oldUid = String(copy.uid || "");
    if (oldUid) {
      let nextUid = httpUidMap.get(oldUid);
      if (!nextUid) {
        nextUid = crypto.randomUUID();
        httpUidMap.set(oldUid, nextUid);
      }
      copy.uid = nextUid;
    } else {
      copy.uid = crypto.randomUUID();
    }
  }
  if (type === "periodic") {
    delete copy.last_periodic_run;
  }
  if (type === "router" && Array.isArray(copy.edges)) {
    copy.edges = (copy.edges as JsonObject[]).map((edge) => {
      const previousUid = String(edge.uid || edge.id || "");
      if (!previousUid) return edge;
      const nextUid = crypto.randomUUID();
      edgeMap.set(previousUid, nextUid);
      return { ...edge, uid: nextUid };
    });
  }
  return copy;
}

function deepClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, item]) => [key, deepClone(item)]));
}

function remapAutomationServiceReferences(
  value: unknown,
  idMap: Map<number, number>,
  integrationMap?: Map<number, number>
): unknown {
  if (Array.isArray(value)) return value.map((item) => remapAutomationServiceReferences(item, idMap, integrationMap));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, item]) => {
    if (key === "formula" && typeof item === "string") {
      return [key, remapAutomationFormulaReferences(item, idMap)];
    }
    if (key === "integration_id" && integrationMap) {
      const id = Number(item);
      return [key, Number.isFinite(id) && integrationMap.has(id) ? integrationMap.get(id)! : item];
    }
    return [key, remapAutomationServiceReferences(item, idMap, integrationMap)];
  }));
}

function remapAutomationFormulaReferences(formula: string, idMap: Map<number, number>) {
  return formula.replace(/get\(\s*(['"])(.*?)\1\s*\)/g, (_match, quote, path) => {
    return `get(${quote}${remapAutomationDataPath(path, idMap)}${quote})`;
  });
}

function remapAutomationDataPath(path: string, idMap: Map<number, number>) {
  const parts = path.split(".");
  if ((parts[0] === "previous_node" || parts[0] === "current_iteration") && parts[1]) {
    const mapped = idMap.get(Number(parts[1]));
    if (mapped) parts[1] = String(mapped);
  }
  return parts.join(".");
}

export async function listWorkflowHistory(db: D1Database, workflowId: number, page = 1, size = 100) {
  const limit = Math.min(Math.max(size, 1), 200);
  const offset = Math.max(page - 1, 0) * limit;
  const workflowIds = await workflowAndPublishedVersionIds(db, workflowId);
  const bindMarks = workflowIds.map(() => "?").join(", ");
  const total = await db.prepare(
    `SELECT COUNT(*) AS count FROM automation_workflow_history
     WHERE workflow_id IN (${bindMarks}) AND simulate_until_node_id IS NULL`
  )
    .bind(...workflowIds)
    .first<{ count: number }>();
  const rows = await db.prepare(
    `SELECT * FROM automation_workflow_history
     WHERE workflow_id IN (${bindMarks}) AND simulate_until_node_id IS NULL
     ORDER BY started_on DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...workflowIds, limit, offset).all<any>();
  return {
    count: total?.count || 0,
    next: offset + limit < (total?.count || 0) ? page + 1 : null,
    previous: page > 1 ? page - 1 : null,
    results: (rows.results || []).map(serializeWorkflowHistory),
  };
}

async function workflowAndPublishedVersionIds(db: D1Database, workflowId: number) {
  const rows = await db.prepare(
    `SELECT id FROM automation_workflow
     WHERE id=? OR published_from_workflow_id=?
     ORDER BY id ASC`
  ).bind(workflowId, workflowId).all<{ id: number }>();
  const ids = (rows.results || []).map((row) => Number(row.id)).filter(Number.isFinite);
  return ids.length > 0 ? ids : [workflowId];
}

export async function listNodeHistory(db: D1Database, workflowHistoryId: number) {
  const rows = await db.prepare(
    `SELECT nh.*, n.type, n.label
     FROM automation_node_history nh
     JOIN automation_node n ON n.id = nh.node_id
     WHERE nh.workflow_history_id=?
     ORDER BY nh.started_on ASC, nh.id ASC`
  ).bind(workflowHistoryId).all<any>();
  return (rows.results || []).map((row: any) => ({
    id: row.id,
    workflow_history_id: row.workflow_history_id,
    node_id: row.node_id,
    node: { id: row.node_id, type: row.type, label: row.label || "" },
    started_on: row.started_on,
    completed_on: row.completed_on ?? null,
    status: row.status,
    message: row.message || "",
    input: parseJson(row.input, {}),
    output: parseJson(row.output, {}),
  }));
}

export async function dispatchAutomationHttpTrigger(env: Env, uid: string, requestData: JsonObject, simulate = false) {
  const trigger = await automationHttpTriggerByUid(env.DB, uid, simulate);
  if (requestData.method === "GET" && serviceOf(trigger).exclude_get === true) {
    throw new ValidationError("GET requests are disabled for this HTTP trigger.");
  }
  return startWorkflow(env, trigger.workflow_id, requestData, simulate);
}

export async function triggerAutomationTableWorkflows(env: Env, tableId: number, eventType: string, payload: JsonObject = {}) {
  const triggerType =
    eventType === "rows.created" ? "local_supertask_rows_created"
      : eventType === "rows.updated" ? "local_supertask_rows_updated"
        : eventType === "rows.deleted" ? "local_supertask_rows_deleted"
          : "";
  if (!triggerType) return [];

  const rows = await env.DB.prepare(
    `SELECT n.*, wf.state, wf.allow_test_run_until, wf.simulate_until_node_id
     FROM automation_node n
     JOIN automation_workflow wf ON wf.id = n.workflow_id
     JOIN core_application a ON a.id = wf.automation_id
     WHERE n.type=? AND n.trashed=0 AND wf.trashed=0 AND a.trashed=0
       AND wf.published_from_workflow_id IS NOT NULL
       AND COALESCE(wf.is_published_version, 0)=1`
  ).bind(triggerType).all<any>();

  const outputs = [];
  const eventPayload = normalizeRowsSignalPayload(tableId, eventType, payload);
  for (const trigger of rows.results || []) {
    if (!workflowCanRun(trigger)) continue;
    if (Number(serviceOf(trigger).table_id) !== tableId) continue;
    outputs.push(await startWorkflow(env, trigger.workflow_id, eventPayload, false));
  }
  return outputs;
}

function normalizeRowsSignalPayload(tableId: number, eventType: string, payload: JsonObject): JsonObject {
  const items = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.rows)
      ? payload.rows
      : [];
  const rowIds = Array.isArray(payload.row_ids)
    ? payload.row_ids
    : items
      .map((item) => item && typeof item === "object" ? Number((item as JsonObject).id) : NaN)
      .filter(Number.isFinite);

  return {
    ...payload,
    table_id: tableId,
    event_type: eventType,
    results: items,
    has_next_page: false,
    items,
    row_ids: rowIds,
  };
}

export async function triggerDuePeriodicAutomationWorkflows(env: Env, now = new Date()) {
  const rows = await env.DB.prepare(
    `SELECT n.*, wf.state, wf.allow_test_run_until, wf.simulate_until_node_id
     FROM automation_node n
     JOIN automation_workflow wf ON wf.id = n.workflow_id
     JOIN core_application a ON a.id = wf.automation_id
     WHERE n.type='periodic' AND n.trashed=0 AND wf.trashed=0 AND a.trashed=0
       AND wf.published_from_workflow_id IS NOT NULL
       AND COALESCE(wf.is_published_version, 0)=1`
  ).all<any>();
  const outputs = [];
  for (const trigger of rows.results || []) {
    if (!workflowCanRun(trigger) || !isPeriodicDue(trigger, now)) continue;
    const claim = await claimPeriodicRun(env.DB, trigger, now);
    if (!claim) continue;
    try {
      outputs.push(await startWorkflow(env, trigger.workflow_id, { triggered_at: now.toISOString() }, false));
    } catch (error) {
      // Release the claim so the next tick retries this workflow, without
      // stopping the other due workflows.
      await env.DB.prepare("UPDATE automation_node SET service=?, updated_on=? WHERE id=? AND service=?")
        .bind(trigger.service, now.toISOString(), trigger.id, claim)
        .run();
      console.error(`[CRON] Automation periodic workflow ${trigger.workflow_id} failed`, error);
    }
  }
  return outputs;
}

export async function startWorkflow(env: Env, workflowId: number, eventPayload: JsonObject = {}, isTestRun = false, simulateUntilNodeId?: number) {
  const workflow = await env.DB.prepare("SELECT * FROM automation_workflow WHERE id=? AND trashed=0").bind(workflowId).first<any>();
  if (!workflow) throw new DoesNotExist("Automation workflow", workflowId);
  if (!isTestRun && !workflowCanRun(workflow)) {
    return { status: "disabled", workflow_id: workflowId };
  }
  const historyWorkflowId = Number(workflow.published_from_workflow_id || workflow.id);
  const effectiveSimulateUntilNodeId = simulateUntilNodeId || Number(workflow.simulate_until_node_id) || null;
  const historyIsTestRun = isTestRun || isWorkflowTemporaryRun(workflow);

  const started = nowIso();
  const history = await env.DB.prepare(
    `INSERT INTO automation_workflow_history
     (workflow_id, started_on, is_test_run, message, status, event_payload, simulate_until_node_id)
     VALUES (?, ?, ?, '', 'started', ?, ?) RETURNING id`
  ).bind(
    historyWorkflowId,
    started,
    historyIsTestRun ? 1 : 0,
    JSON.stringify(eventPayload || {}),
    effectiveSimulateUntilNodeId
  ).first<{ id: number }>();
  if (!history) throw new Error("Failed to create automation workflow history");

  try {
    await clearOldWorkflowHistory(env.DB, historyWorkflowId);
    if (!isTestRun && await hasTooManyConsecutiveErrors(env.DB, historyWorkflowId, history.id)) {
      const message = `The workflow ${historyWorkflowId} was disabled due to too many consecutive errors.`;
      await disableWorkflowAndPublishedVersions(env.DB, workflow);
      await env.DB.prepare("UPDATE automation_workflow_history SET completed_on=?, status='disabled', message=? WHERE id=?")
        .bind(nowIso(), message, history.id)
        .run();
      return { history_id: history.id, status: "disabled", message, workflow_id: historyWorkflowId };
    }
    const output = await executeWorkflowGraph(env, workflow, eventPayload, history.id, effectiveSimulateUntilNodeId || undefined);
    await env.DB.prepare("UPDATE automation_workflow_history SET completed_on=?, status='success', message='' WHERE id=?")
      .bind(nowIso(), history.id)
      .run();
    if (effectiveSimulateUntilNodeId) await deleteWorkflowHistoryRows(env.DB, [history.id]);
    return { history_id: history.id, status: "success", output };
  } catch (error: any) {
    await env.DB.prepare("UPDATE automation_workflow_history SET completed_on=?, status='error', message=? WHERE id=?")
      .bind(nowIso(), error?.message || String(error), history.id)
      .run();
    if (effectiveSimulateUntilNodeId) await deleteWorkflowHistoryRows(env.DB, [history.id]);
    throw error;
  } finally {
    if (isWorkflowTemporaryRun(workflow)) {
      await resetWorkflowTemporaryStates(env.DB, workflow.id);
    }
  }
}

export async function toggleWorkflowTestRun(db: D1Database, workflowId: number, simulateUntilNodeId?: number) {
  const workflow = await db.prepare("SELECT * FROM automation_workflow WHERE id=? AND trashed=0")
    .bind(workflowId)
    .first<any>();
  if (!workflow) throw new DoesNotExist("Automation workflow", workflowId);

  if (workflow.allow_test_run_until || workflow.simulate_until_node_id) {
    await resetWorkflowTemporaryStates(db, workflow.id);
    return serializeWorkflow(await db.prepare("SELECT * FROM automation_workflow WHERE id=?").bind(workflow.id).first<any>());
  }

  const now = nowIso();
  if (simulateUntilNodeId) {
    await db.prepare(
      `UPDATE automation_workflow
       SET simulate_until_node_id=?, allow_test_run_until=NULL, updated_on=?
       WHERE id=?`
    ).bind(simulateUntilNodeId, now, workflow.id).run();
  } else {
    await db.prepare(
      `UPDATE automation_workflow
       SET allow_test_run_until=?, simulate_until_node_id=NULL, updated_on=?
       WHERE id=?`
    ).bind(new Date(Date.now() + AUTOMATION_WORKFLOW_TEST_RUN_MINUTES * 60 * 1000).toISOString(), now, workflow.id).run();
  }

  const updated = await db.prepare("SELECT * FROM automation_workflow WHERE id=?").bind(workflow.id).first<any>();
  return serializeWorkflow(updated || workflow);
}

async function resetWorkflowTemporaryStates(db: D1Database, workflowId: number) {
  await db.prepare(
    `UPDATE automation_workflow
     SET allow_test_run_until=NULL, simulate_until_node_id=NULL, updated_on=?
     WHERE id=?`
  ).bind(nowIso(), workflowId).run();
}

function isWorkflowTemporaryRun(workflow: any) {
  return Boolean(workflow.allow_test_run_until || workflow.simulate_until_node_id);
}

async function clearOldWorkflowHistory(db: D1Database, workflowId: number) {
  const workflowIds = await workflowAndPublishedVersionIds(db, workflowId);
  const bindMarks = workflowIds.map(() => "?").join(", ");
  const oldestStartedOn = new Date(Date.now() - AUTOMATION_WORKFLOW_HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const oldRows = await db.prepare(
    `SELECT id FROM automation_workflow_history
     WHERE workflow_id IN (${bindMarks}) AND started_on < ?`
  ).bind(...workflowIds, oldestStartedOn).all<{ id: number }>();
  await deleteWorkflowHistoryRows(db, (oldRows.results || []).map((row) => row.id));

  const overflowRows = await db.prepare(
    `SELECT id FROM automation_workflow_history
     WHERE workflow_id IN (${bindMarks})
     ORDER BY started_on DESC, id DESC
     LIMIT -1 OFFSET ?`
  ).bind(...workflowIds, AUTOMATION_WORKFLOW_HISTORY_MAX_ENTRIES).all<{ id: number }>();
  await deleteWorkflowHistoryRows(db, (overflowRows.results || []).map((row) => row.id));
}

async function deleteWorkflowHistoryRows(db: D1Database, historyIds: number[]) {
  const uniqueHistoryIds = Array.from(new Set(historyIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  for (let offset = 0; offset < uniqueHistoryIds.length; offset += AUTOMATION_WORKFLOW_HISTORY_DELETE_BATCH_SIZE) {
    const batch = uniqueHistoryIds.slice(offset, offset + AUTOMATION_WORKFLOW_HISTORY_DELETE_BATCH_SIZE);
    const bindMarks = batch.map(() => "?").join(", ");
    await db.prepare(
      `DELETE FROM automation_node_history
       WHERE workflow_history_id IN (${bindMarks})`
    ).bind(...batch).run();
    await db.prepare(
      `DELETE FROM automation_workflow_history
       WHERE id IN (${bindMarks})`
    ).bind(...batch).run();
  }
}

async function hasTooManyConsecutiveErrors(db: D1Database, workflowId: number, currentHistoryId: number) {
  const workflowIds = await workflowAndPublishedVersionIds(db, workflowId);
  const bindMarks = workflowIds.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT id, status FROM automation_workflow_history
     WHERE workflow_id IN (${bindMarks})
     ORDER BY started_on DESC, id DESC
     LIMIT ?`
  ).bind(...workflowIds, AUTOMATION_WORKFLOW_MAX_CONSECUTIVE_ERRORS + 1).all<{ id: number; status: string }>();
  let statuses = (rows.results || []).map((row) => ({ id: Number(row.id), status: String(row.status || "") }));
  if (statuses[0]?.id === currentHistoryId && statuses[0].status === "started") statuses = statuses.slice(1);
  if (statuses.length < AUTOMATION_WORKFLOW_MAX_CONSECUTIVE_ERRORS) return false;
  return statuses.slice(0, AUTOMATION_WORKFLOW_MAX_CONSECUTIVE_ERRORS).every((row) => row.status === "error");
}

async function disableWorkflowAndPublishedVersions(db: D1Database, workflow: any) {
  const originalId = Number(workflow.published_from_workflow_id || workflow.id);
  const now = nowIso();
  await db.prepare(
    `UPDATE automation_workflow
     SET state='disabled', updated_on=?
     WHERE id=? OR published_from_workflow_id=?`
  ).bind(now, originalId, originalId).run();
}

async function executeWorkflowGraph(env: Env, workflow: any, eventPayload: JsonObject, historyId: number, simulateUntilNodeId?: number) {
  const graph = graphOf(workflow);
  const firstId = Number(graph["0"]);
  if (!firstId) throw new ValidationError("The automation workflow has no trigger node.");
  const outputs: JsonObject = {};
  const path = simulateUntilNodeId ? nodesOnPathTo(graph, firstId, simulateUntilNodeId) : undefined;
  await executeNodeAndChildren(env, workflow, firstId, eventPayload, historyId, outputs, { simulateUntilNodeId, path, eventPayload });
  return outputs;
}

async function executeNodeAndChildren(
  env: Env,
  workflow: any,
  nodeId: number,
  input: JsonObject,
  historyId: number,
  outputs: JsonObject,
  options: {
    simulateUntilNodeId?: number;
    path?: Set<number>;
    iteration?: number;
    eventPayload?: JsonObject;
    currentIterations?: Record<number, number>;
  } = {}
) {
  if (options.path && !options.path.has(nodeId)) return;
  const node = await env.DB.prepare("SELECT * FROM automation_node WHERE id=? AND workflow_id=? AND trashed=0")
    .bind(nodeId, workflow.id)
    .first<any>();
  if (!node) return;
  const nodeHistory = await startNodeHistory(env.DB, historyId, node.id, input, options.iteration || 0);
  const context = {
    eventPayload: options.eventPayload || input,
    previousResults: outputs,
    currentIterations: options.currentIterations || {},
  };
  try {
    const output = await dispatchAutomationNode(env, node, input, context);
    outputs[String(node.id)] = output;
    await finishNodeHistory(env.DB, nodeHistory.id, "success", "", output);
    await updateNodeSampleData(env.DB, node, output);
    if (options.simulateUntilNodeId === nodeId) return;

    if (node.type === "iterator") {
      const items = iteratorItems(output);
      const childIds = childNodeIds(graphOf(workflow), node.id);
      for (const [index, item] of items.entries()) {
        const currentIterations = { ...(options.currentIterations || {}), [node.id]: index };
        for (const childId of childIds) {
          await executeNodeAndChildren(env, workflow, childId, {
            ...input,
            item,
            iteration: index,
            previous: output,
          }, historyId, outputs, { ...options, iteration: index, currentIterations });
        }
      }
    }

    const nextOutput = output && typeof output === "object" && "output_uid" in output
      ? String((output as JsonObject).output_uid || "")
      : output && typeof output === "object" && "edge" in output
        ? String((output as JsonObject).edge || "")
        : "";
    const nextIds = nextNodeIds(graphOf(workflow), node.id, nextOutput);
    for (const nextId of nextIds) {
      await executeNodeAndChildren(env, workflow, nextId, { ...input, previous: output }, historyId, outputs, options);
    }
  } catch (error: any) {
    await finishNodeHistory(env.DB, nodeHistory.id, "error", error?.message || String(error), {});
    await updateNodeSampleData(env.DB, node, { _error: error?.message || String(error) });
    throw error;
  }
}

async function dispatchAutomationNode(env: Env, node: any, input: JsonObject, context: FormulaContext) {
  if (isTriggerType(node.type)) {
    return input;
  }
  const service = resolveServiceFormulas(serviceOf(node), context) as JsonObject;
  if (node.type === "router") {
    return dispatchAutomationRouter(service, context);
  }
  if (node.type === "iterator") {
    return dispatchAutomationIterator(service, context);
  }
  const workflowActionPayload = {
    id: node.id,
    type: node.type,
    configuration: JSON.stringify({ service }),
  };
  return dispatchWorkflowAction(env, workflowActionPayload, {
    ...input,
    previousActionResults: context.previousResults,
  });
}

function dispatchAutomationRouter(service: JsonObject, context: FormulaContext) {
  const edges = Array.isArray(service.edges) ? service.edges as JsonObject[] : [];
  const selected = edges.find((edge) => truthyFormula(edge.condition, context));
  if (selected) {
    const uid = String(selected.uid || selected.id || selected.label || "");
    return {
      output_uid: uid,
      edge: uid,
      edge_label: selected.label || "",
    };
  }
  return {
    output_uid: "",
    edge: "",
    edge_label: service.default_edge_label || "",
  };
}

function dispatchAutomationIterator(service: JsonObject, context: FormulaContext) {
  const source = resolveFormulaValue(service.source, context);
  let results: unknown[];
  if (Array.isArray(source)) {
    results = source;
  } else {
    const text = resolveText(service.source, context);
    try {
      const parsed = JSON.parse(text);
      results = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      results = text ? [text] : [];
    }
  }
  return { results, items: results };
}

function iteratorItems(output: unknown) {
  if (!output || typeof output !== "object") return [];
  const data = output as JsonObject;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function truthyFormula(value: unknown, context: FormulaContext) {
  const resolved = resolveFormulaValue(value, context);
  if (typeof resolved === "boolean") return resolved;
  if (typeof resolved === "number") return resolved !== 0;
  const text = resolveText(resolved, context).trim().toLowerCase();
  return ["true", "1", "yes", "y", "on"].includes(text);
}

function resolveFormulaValue(value: unknown, context?: FormulaContext): unknown {
  if (value && typeof value === "object" && "formula" in value) {
    return evaluateAutomationFormula((value as any).formula, context);
  }
  return value;
}

function resolveText(value: unknown, context?: FormulaContext): string {
  const resolved = resolveFormulaValue(value, context);
  if (resolved === null || resolved === undefined) return "";
  if (typeof resolved === "string") return resolved;
  return JSON.stringify(resolved);
}

function resolveServiceFormulas(value: unknown, context: FormulaContext): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveServiceFormulas(item, context));
  if (!value || typeof value !== "object") return value;
  if ("formula" in (value as JsonObject)) return resolveFormulaValue(value, context);
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, item]) => [key, resolveServiceFormulas(item, context)]));
}

function evaluateAutomationFormula(value: unknown, context?: FormulaContext): unknown {
  if (typeof value !== "string") return value;
  const formula = value.trim();
  if (!context || !formula) return value;

  for (const op of ["!=", "==", ">=", "<=", "=", ">", "<"]) {
    const parts = splitFormulaComparison(formula, op);
    if (parts) {
      const left = evaluateAutomationFormula(parts[0], context);
      const right = evaluateAutomationFormula(parts[1], context);
      return compareFormulaValues(left, right, op);
    }
  }

  const exactGet = formula.match(/^get\(\s*(['"])(.*?)\1\s*\)$/);
  if (exactGet) return getAutomationDataPath(context, exactGet[2]);

  const call = parseFormulaCall(formula);
  if (call) {
    const args = splitFormulaArguments(call.args).map((arg) => evaluateAutomationFormula(arg, context));
    const name = call.name.toLowerCase();
    const common = evaluateCommonRuntimeFormulaCall(name, args);
    if (common.handled) return common.value;
    if (name === "concat") return args.map((arg) => arg === null || arg === undefined ? "" : typeof arg === "string" ? arg : JSON.stringify(arg)).join("");
    if (name === "and") return args.every(Boolean);
    if (name === "or") return args.some(Boolean);
    if (name === "not") return !args[0];
    if (name === "tonumber") return Number(args[0] ?? 0);
    if (name === "totext") return args[0] === null || args[0] === undefined ? "" : String(args[0]);
    if (name === "lower") return String(args[0] ?? "").toLowerCase();
    if (name === "upper") return String(args[0] ?? "").toUpperCase();
  }

  if ((formula.startsWith("'") && formula.endsWith("'")) || (formula.startsWith("\"") && formula.endsWith("\""))) {
    return formula.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(formula)) return Number(formula);
  if (/^(true|false)$/i.test(formula)) return formula.toLowerCase() === "true";
  if (/^null$/i.test(formula)) return null;

  return formula.replace(/get\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, path) => {
    const resolved = getAutomationDataPath(context, path);
    if (resolved === null || resolved === undefined) return "";
    if (typeof resolved === "string") return resolved;
    return JSON.stringify(resolved);
  });
}

function parseFormulaCall(formula: string): { name: string; args: string } | null {
  const match = formula.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(([\s\S]*)\)$/);
  if (!match) return null;
  let quote = "";
  let depth = 0;
  for (let i = 0; i < match[2].length; i++) {
    const char = match[2][i];
    if (quote) {
      if (char === quote && match[2][i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return null;
  }
  return depth === 0 ? { name: match[1], args: match[2] } : null;
}

function splitFormulaArguments(args: string): string[] {
  const result: string[] = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    if (quote) {
      if (char === quote && args[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      result.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = args.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function splitFormulaComparison(formula: string, op: string): [string, string] | null {
  let quote = "";
  let depth = 0;
  for (let i = 0; i <= formula.length - op.length; i++) {
    const char = formula[i];
    if (quote) {
      if (char === quote && formula[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && formula.slice(i, i + op.length) === op) {
      return [formula.slice(0, i).trim(), formula.slice(i + op.length).trim()];
    }
  }
  return null;
}

function compareFormulaValues(left: unknown, right: unknown, op: string) {
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  const numeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  const a = numeric ? leftNumber : String(left ?? "");
  const b = numeric ? rightNumber : String(right ?? "");
  if (op === "=" || op === "==") return a === b;
  if (op === "!=") return a !== b;
  if (op === ">") return a > b;
  if (op === ">=") return a >= b;
  if (op === "<") return a < b;
  return a <= b;
}

function getAutomationDataPath(context: FormulaContext, path: string) {
  const parts = path.split(".").filter(Boolean);
  const provider = parts.shift();
  if (!provider) return null;
  if (provider === "previous_node") {
    const nodeId = String(parts.shift() || "");
    const source = context.previousResults[nodeId];
    if (source && typeof source === "object" && Array.isArray((source as JsonObject).results) && isCollectionPathPart(parts[0])) {
      return getValueAtPath((source as JsonObject).results, parts);
    }
    return getValueAtPath(source, parts);
  }
  if (provider === "current_iteration") {
    const nodeId = Number(parts.shift() || 0);
    const index = context.currentIterations[nodeId];
    const parentResults = context.previousResults[String(nodeId)] as JsonObject | undefined;
    const items = iteratorItems(parentResults);
    return getValueAtPath({ index, item: items[index] }, parts);
  }
  if (provider === "trigger" || provider === "event_payload") {
    return getValueAtPath(context.eventPayload, parts);
  }
  return null;
}

function isNumericPathPart(part: string | undefined) {
  return part !== undefined && /^\d+$/.test(part);
}

function isCollectionPathPart(part: string | undefined) {
  return isNumericPathPart(part) || part === "*";
}

function getValueAtPath(value: unknown, parts: string[]): unknown {
  if (parts.length === 0) return value ?? null;
  const [part, ...rest] = parts;
  if (part === "*") {
    if (Array.isArray(value)) return value.map((item) => getValueAtPath(item, rest));
    if (value && typeof value === "object") {
      return Object.values(value as JsonObject).map((item) => getValueAtPath(item, rest));
    }
    return [];
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return getValueAtPath(value[isNumericPathPart(part) ? Number(part) : 0], rest);
  }
  if (typeof value === "object") {
    return getValueAtPath((value as JsonObject)[part], rest);
  }
  return null;
}

async function updateNodeSampleData(db: D1Database, node: any, output: unknown) {
  const service = {
    ...serviceOf(node),
    sample_data: output && typeof output === "object" && "_error" in (output as JsonObject)
      ? { _error: (output as JsonObject)._error }
      : { data: output },
  };
  await db.prepare("UPDATE automation_node SET service=?, updated_on=? WHERE id=?")
    .bind(JSON.stringify(service), nowIso(), node.id)
    .run();
}

async function startNodeHistory(db: D1Database, historyId: number, nodeId: number, input: JsonObject, iteration: number) {
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO automation_node_history
     (workflow_history_id, node_id, started_on, status, input, output)
     VALUES (?, ?, ?, 'started', ?, '{}') RETURNING id`
  ).bind(historyId, nodeId, now, JSON.stringify({ ...input, iteration })).first<{ id: number }>();
  if (!row) throw new Error("Failed to create automation node history");
  return row;
}

async function finishNodeHistory(db: D1Database, nodeHistoryId: number, status: string, message: string, output: unknown) {
  await db.prepare("UPDATE automation_node_history SET completed_on=?, status=?, message=?, output=? WHERE id=?")
    .bind(nowIso(), status, message, JSON.stringify(output ?? {}), nodeHistoryId)
    .run();
}

function serviceValidationError(field: string, detail: string): never {
  requestBodyValidationError(`service.${field}: ${detail}`);
}

function serviceString(value: unknown, field: string, options: { nullable: true; maxLength?: number }): string | null;
function serviceString(value: unknown, field: string, options?: { nullable?: false; maxLength?: number }): string;
function serviceString(value: unknown, field: string, options: { nullable?: boolean; maxLength?: number } = {}): string | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== "string") serviceValidationError(field, "Not a valid string.");
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    serviceValidationError(field, `Ensure this field has no more than ${options.maxLength} characters.`);
  }
  return value;
}

function serviceBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") serviceValidationError(field, "Must be a valid boolean.");
  return value;
}

function serviceNumber(
  value: unknown,
  field: string,
  options: { nullable?: boolean; integer?: boolean; min?: number; max?: number } = {},
) {
  if (value === null && options.nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || (options.integer && !Number.isInteger(value))) {
    serviceValidationError(field, options.integer ? "A valid integer is required." : "A valid number is required.");
  }
  if (options.min !== undefined && value < options.min) serviceValidationError(field, `Ensure this value is greater than or equal to ${options.min}.`);
  if (options.max !== undefined && value > options.max) serviceValidationError(field, `Ensure this value is less than or equal to ${options.max}.`);
  return value;
}

function serviceOptionalId(value: unknown, field: string) {
  if (value === null || value === undefined) return null;
  return serviceNumber(value, field, { integer: true, min: 1 });
}

function serviceArray(value: unknown, field: string) {
  if (!Array.isArray(value)) serviceValidationError(field, "Expected a list of items.");
  return value;
}

function normalizeAutomationFormula(value: unknown, field: string, validateSyntax = false): JsonObject {
  if (value === undefined || value === null || value === "") return formulaObject();
  const normalized = typeof value !== "object" || Array.isArray(value)
    ? formulaObject(String(value))
    : null;
  if (normalized) {
    if (validateSyntax && normalized.formula) validateAutomationFormulaSyntax(normalized, field);
    return normalized;
  }
  const formula = value as JsonObject;
  if (Object.keys(formula).length === 0) return formulaObject();
  if (typeof formula.formula !== "string") serviceValidationError(field, "formula must be a string.");
  const mode = formula.mode === undefined ? "simple" : serviceString(formula.mode, `${field}.mode`);
  if (!AUTOMATION_FORMULA_MODES.has(mode)) serviceValidationError(`${field}.mode`, `\"${mode}\" is not a valid choice.`);
  const version = formula.version === undefined ? "0.1" : serviceString(formula.version, `${field}.version`);
  const result = { formula: formula.formula, mode, version };
  if (validateSyntax && result.formula && result.mode !== "raw") validateAutomationFormulaSyntax(result, field);
  return result;
}

function validateAutomationFormulaSyntax(formula: JsonObject, field: string) {
  try {
    parseFormulaAst(String(formula.formula));
  } catch (error: any) {
    serviceValidationError(field, `The formula is invalid: ${error?.message || String(error)}`);
  }
}

function normalizeAutomationFormulaFields(
  service: JsonObject,
  fields: string[],
  provided: JsonObject,
  creating: boolean,
) {
  for (const field of fields) {
    service[field] = normalizeAutomationFormula(
      service[field],
      field,
      creating || Object.prototype.hasOwnProperty.call(provided, field),
    );
  }
}

function validateAutomationServiceInputShape(type: string, data: JsonObject) {
  const listFields = ["field_mappings", "filters", "sortings", "headers", "query_params", "form_data", "ai_choices", "edges"];
  for (const field of listFields) {
    if (data[field] !== undefined && !Array.isArray(data[field])) serviceValidationError(field, "Expected a list of items.");
  }
  if (type === "router" && data.edges !== undefined) {
    for (const [index, edge] of (data.edges as unknown[]).entries()) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) serviceValidationError(`edges.${index}`, "Expected an object.");
    }
  }
}

async function validateAutomationIntegration(
  db: D1Database,
  automationId: number,
  value: unknown,
  expectedType: string | null,
) {
  const integrationId = serviceOptionalId(value, "integration_id");
  if (integrationId === null || !expectedType) return integrationId;
  const integration = await db.prepare(
    "SELECT id FROM core_integration WHERE id=? AND application_id=? AND type=?"
  ).bind(integrationId, automationId, expectedType).first<{ id: number }>();
  if (!integration) serviceValidationError("integration_id", `The ${expectedType} integration does not exist in this automation.`);
  return integrationId;
}

async function automationIntegrationProviderModels(
  db: D1Database,
  cache: KVNamespace | undefined,
  workflow: any,
  integrationId: number,
  provider: string,
) {
  const integration = await db.prepare("SELECT configuration FROM core_integration WHERE id=? AND type='ai'")
    .bind(integrationId)
    .first<{ configuration: string }>();
  if (!integration) return [];
  const configuration = parseJson<JsonObject>(integration.configuration, {});
  const aiSettings = objectValue(configuration.ai_settings) || {};
  let providerSettings: JsonObject | null = null;
  if (Object.prototype.hasOwnProperty.call(aiSettings, provider)) {
    providerSettings = objectValue(aiSettings[provider]);
  } else if (cache && Number(workflow.workspace_id) > 0) {
    const workspaceSettings = await workspaceGenerativeAISettings(cache, Number(workflow.workspace_id));
    providerSettings = objectValue(workspaceSettings[provider]);
  }
  return Array.isArray(providerSettings?.models)
    ? (providerSettings.models as unknown[]).map((model) => String(model).trim()).filter(Boolean)
    : [];
}

async function activeAutomationTable(db: D1Database, value: unknown) {
  const tableId = serviceOptionalId(value, "table_id");
  if (tableId === null) return null;
  const table = await db.prepare(
    `SELECT t.id FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=? AND t.trashed=0 AND a.trashed=0 AND a.type='database'`
  ).bind(tableId).first<{ id: number }>();
  if (!table) serviceValidationError("table_id", `The table with ID ${tableId} does not exist.`);
  return tableId;
}

async function activeAutomationField(db: D1Database, tableId: number, value: unknown, field: string) {
  const fieldId = serviceOptionalId(value, field);
  if (fieldId === null) return null;
  const row = await db.prepare(
    "SELECT id FROM database_field WHERE id=? AND table_id=? AND trashed=0"
  ).bind(fieldId, tableId).first<{ id: number }>();
  if (!row) serviceValidationError(field, `The field with ID ${fieldId} is not related to the selected table.`);
  return fieldId;
}

async function automationAggregationField(db: D1Database, tableId: number, fieldId: number) {
  const row = await db.prepare(
    "SELECT type, field_settings FROM database_field WHERE id=? AND table_id=? AND trashed=0"
  ).bind(fieldId, tableId).first<{ type: string; field_settings: string }>();
  if (!row) return null;
  return {
    type: String(row.type || ""),
    settings: parseJson<JsonObject>(row.field_settings, {}),
  };
}

function automationAggregationSupportsField(
  aggregationType: string,
  field: { type: string; settings: JsonObject },
) {
  const computedType = ["formula", "lookup", "rollup", "count"].includes(field.type)
    ? String(field.settings.formula_type || "").toLowerCase()
    : null;
  const compatible = (types: Set<string>, formulaTypes: string[] = []) => (
    types.has(field.type) || (computedType !== null && formulaTypes.includes(computedType))
  );

  if (["count", "empty_count", "not_empty_count"].includes(aggregationType)) {
    if (compatible(AUTOMATION_AGGREGATION_COUNT_FIELD_TYPES, ["text", "char", "number", "date", "boolean"])) return true;
    return computedType === "array" && String(field.settings.array_formula_type || "").toLowerCase() === "file";
  }
  if (["empty_percentage", "not_empty_percentage"].includes(aggregationType)) {
    if (compatible(AUTOMATION_AGGREGATION_EMPTY_FIELD_TYPES, ["text", "char", "number", "date"])) return true;
    return computedType === "array" && String(field.settings.array_formula_type || "").toLowerCase() === "file";
  }
  if (["checked_count", "not_checked_count", "checked_percentage", "not_checked_percentage"].includes(aggregationType)) {
    return compatible(new Set(["boolean"]), ["boolean"]);
  }
  if (aggregationType === "unique_count") {
    return compatible(AUTOMATION_AGGREGATION_UNIQUE_FIELD_TYPES, ["text", "char", "number", "date"]);
  }
  if (aggregationType === "min" || aggregationType === "max") {
    return compatible(AUTOMATION_AGGREGATION_MIN_MAX_FIELD_TYPES, ["number"]);
  }
  if (aggregationType === "min_date" || aggregationType === "max_date") {
    return compatible(AUTOMATION_AGGREGATION_DATE_FIELD_TYPES, ["date"]);
  }
  if (aggregationType === "sum") {
    return compatible(new Set([...AUTOMATION_AGGREGATION_NUMERIC_FIELD_TYPES, "duration"]), ["number"]);
  }
  if (["average", "std_dev", "variance", "median"].includes(aggregationType)) {
    return compatible(AUTOMATION_AGGREGATION_NUMERIC_FIELD_TYPES, ["number"]);
  }
  return false;
}

async function validateLocalSupertaskService(
  db: D1Database,
  serviceType: string,
  service: JsonObject,
  provided: JsonObject,
  creating: boolean,
) {
  const tableId = await activeAutomationTable(db, service.table_id);
  service.table_id = tableId;
  if (service.view_id !== undefined) {
    const viewId = serviceOptionalId(service.view_id, "view_id");
    if (viewId !== null) {
      if (tableId === null) serviceValidationError("view_id", "A table ID is required alongside the view ID.");
      const view = await db.prepare("SELECT id FROM database_view WHERE id=? AND table_id=? AND trashed=0")
        .bind(viewId, tableId).first<{ id: number }>();
      if (!view) serviceValidationError("view_id", `The view with ID ${viewId} is not related to the selected table.`);
    }
    service.view_id = viewId;
  }
  if (service.filter_type !== undefined) {
    const filterType = serviceString(service.filter_type, "filter_type").toUpperCase();
    if (filterType !== "AND" && filterType !== "OR") serviceValidationError("filter_type", `\"${filterType}\" is not a valid choice.`);
    service.filter_type = filterType;
  }
  if (service.search_query !== undefined) {
    service.search_query = normalizeAutomationFormula(
      service.search_query,
      "search_query",
      creating || Object.prototype.hasOwnProperty.call(provided, "search_query"),
    );
  }
  if (service.row_id !== undefined) {
    service.row_id = normalizeAutomationFormula(
      service.row_id,
      "row_id",
      creating || Object.prototype.hasOwnProperty.call(provided, "row_id"),
    );
  }

  for (const [listName, orderField] of [["filters", null], ["sortings", "order_by"]] as const) {
    if (service[listName] === undefined) continue;
    const items = serviceArray(service[listName], listName) as unknown[];
    for (const [index, raw] of items.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) serviceValidationError(`${listName}.${index}`, "Expected an object.");
      const item = raw as JsonObject;
      if (tableId === null) serviceValidationError(`${listName}.${index}`, "A table must be selected.");
      const fieldKey = item.field_id === undefined ? item.field : item.field_id;
      const fieldId = await activeAutomationField(db, tableId, fieldKey, `${listName}.${index}.field_id`);
      item.field = fieldId;
      delete item.field_id;
      if (orderField) {
        const orderBy = serviceString(item[orderField] ?? "ASC", `${listName}.${index}.${orderField}`).toUpperCase();
        if (orderBy !== "ASC" && orderBy !== "DESC") serviceValidationError(`${listName}.${index}.${orderField}`, `\"${orderBy}\" is not a valid choice.`);
        item[orderField] = orderBy;
      } else {
        item.type = serviceString(item.type, `${listName}.${index}.type`, { maxLength: 48 });
        item.value = normalizeAutomationFormula(
          item.value,
          `${listName}.${index}.value`,
          creating || Object.prototype.hasOwnProperty.call(provided, listName),
        );
        item.value_is_formula = item.value_is_formula === undefined ? false : serviceBoolean(item.value_is_formula, `${listName}.${index}.value_is_formula`);
      }
    }
  }

  if (serviceType === "local_supertask_list_rows") {
    service.default_result_count = serviceNumber(service.default_result_count, "default_result_count", { integer: true, min: 0, max: 2147483647 });
  }
  if (serviceType === "local_supertask_aggregate_rows") {
    if (tableId === null && service.field_id !== null) serviceValidationError("field_id", "A table must be selected.");
    service.field_id = tableId === null ? null : await activeAutomationField(db, tableId, service.field_id, "field_id");
    const aggregationType = serviceString(service.aggregation_type ?? "", "aggregation_type", { maxLength: 48 });
    if (service.field_id !== null && aggregationType) {
      if (!AUTOMATION_AGGREGATION_TYPES.has(aggregationType)) {
        serviceValidationError("aggregation_type", `\"${aggregationType}\" is not a valid or supported aggregation type.`);
      }
      const field = await automationAggregationField(db, tableId!, Number(service.field_id));
      if (!field || !automationAggregationSupportsField(aggregationType, field)) {
        serviceValidationError(
          "aggregation_type",
          `The field with ID ${service.field_id} is not compatible with aggregation type ${aggregationType}.`,
        );
      }
    }
    service.aggregation_type = service.field_id === null ? "" : aggregationType;
  }
  if (serviceType === "local_supertask_upsert_row") {
    const mappings = serviceArray(service.field_mappings, "field_mappings") as unknown[];
    for (const [index, raw] of mappings.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) serviceValidationError(`field_mappings.${index}`, "Expected an object.");
      const mapping = raw as JsonObject;
      if (tableId === null) serviceValidationError(`field_mappings.${index}`, "A table must be selected.");
      mapping.field_id = await activeAutomationField(db, tableId, mapping.field_id, `field_mappings.${index}.field_id`);
      mapping.enabled = mapping.enabled === undefined ? true : serviceBoolean(mapping.enabled, `field_mappings.${index}.enabled`);
      mapping.value = normalizeAutomationFormula(
        mapping.value,
        `field_mappings.${index}.value`,
        creating || Object.prototype.hasOwnProperty.call(provided, "field_mappings"),
      );
    }
  }
}

async function validateAutomationService(
  db: D1Database,
  cache: KVNamespace | undefined,
  workflow: any,
  nodeType: string,
  service: JsonObject,
  provided: JsonObject,
  creating: boolean,
) {
  const serviceType = automationServiceType(nodeType);
  if (service.type !== serviceType) serviceValidationError("type", `Expected \"${serviceType}\".`);
  service.integration_id = await validateAutomationIntegration(
    db,
    Number(workflow.automation_id),
    service.integration_id,
    integrationTypeForService(serviceType),
  );

  if (serviceType.startsWith("local_supertask_")) {
    await validateLocalSupertaskService(db, serviceType, service, provided, creating);
    return service;
  }
  if (serviceType === "http_request") {
    const method = serviceString(service.http_method, "http_method").toUpperCase();
    if (!AUTOMATION_HTTP_METHODS.has(method)) serviceValidationError("http_method", `\"${method}\" is not a valid choice.`);
    service.http_method = method;
    const bodyType = serviceString(service.body_type, "body_type").toLowerCase();
    if (!AUTOMATION_HTTP_BODY_TYPES.has(bodyType)) serviceValidationError("body_type", `\"${bodyType}\" is not a valid choice.`);
    service.body_type = bodyType;
    service.timeout = serviceNumber(service.timeout, "timeout", { integer: true, min: 1, max: 120 });
    normalizeAutomationFormulaFields(service, ["url", "body_content"], provided, creating);
    for (const [listName, allowDot] of [["headers", false], ["query_params", false], ["form_data", true]] as const) {
      const items = serviceArray(service[listName], listName) as unknown[];
      for (const [index, raw] of items.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) serviceValidationError(`${listName}.${index}`, "Expected an object.");
        const item = raw as JsonObject;
        const key = serviceString(item.key, `${listName}.${index}.key`, { maxLength: 255 });
        const valid = key === "" || (allowDot ? /^[a-zA-Z0-9_.-]+$/ : /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).test(key);
        if (!valid) serviceValidationError(`${listName}.${index}.key`, "Contains invalid characters or starts with a dash/underscore.");
        item.key = key;
        item.value = normalizeAutomationFormula(
          item.value,
          `${listName}.${index}.value`,
          creating || Object.prototype.hasOwnProperty.call(provided, listName),
        );
      }
    }
    return service;
  }
  if (serviceType === "smtp_email") {
    const bodyType = serviceString(service.body_type, "body_type");
    if (bodyType !== "plain" && bodyType !== "html") serviceValidationError("body_type", `\"${bodyType}\" is not a valid choice.`);
    normalizeAutomationFormulaFields(
      service,
      ["from_email", "from_name", "to_emails", "cc_emails", "bcc_emails", "subject", "body"],
      provided,
      creating,
    );
    return service;
  }
  if (serviceType === "ai_agent") {
    const provider = serviceString(service.ai_generative_ai_type, "ai_generative_ai_type", { nullable: true, maxLength: 32 });
    if (provider && !AUTOMATION_AI_PROVIDERS.has(provider)) serviceValidationError("ai_generative_ai_type", `AI type '${provider}' does not exist.`);
    service.ai_generative_ai_type = provider;
    service.ai_generative_ai_model = serviceString(service.ai_generative_ai_model, "ai_generative_ai_model", { nullable: true, maxLength: 128 });
    if (provider && service.ai_generative_ai_model && service.integration_id) {
      const models = await automationIntegrationProviderModels(
        db,
        cache,
        workflow,
        Number(service.integration_id),
        provider,
      );
      if (models.length > 0 && !models.includes(String(service.ai_generative_ai_model))) {
        serviceValidationError(
          "ai_generative_ai_model",
          `Model '${service.ai_generative_ai_model}' is not available for provider '${provider}'.`,
        );
      }
    }
    const outputType = serviceString(service.ai_output_type, "ai_output_type");
    if (outputType !== "text" && outputType !== "choice") serviceValidationError("ai_output_type", `\"${outputType}\" is not a valid choice.`);
    service.ai_output_type = outputType;
    service.ai_temperature = serviceNumber(service.ai_temperature, "ai_temperature", { nullable: true, min: 0, max: 2 });
    service.ai_prompt = normalizeAutomationFormula(
      service.ai_prompt,
      "ai_prompt",
      creating || Object.prototype.hasOwnProperty.call(provided, "ai_prompt"),
    );
    service.ai_choices = (serviceArray(service.ai_choices, "ai_choices") as unknown[]).map((choice, index) =>
      serviceString(choice, `ai_choices.${index}`)
    );
    return service;
  }
  if (serviceType === "router") {
    service.default_edge_label = serviceString(service.default_edge_label, "default_edge_label", { maxLength: 75 });
    const validateEdgeIdentifiers = creating || Object.prototype.hasOwnProperty.call(provided, "edges");
    const seen = new Set<string>();
    for (const [index, raw] of (serviceArray(service.edges, "edges") as unknown[]).entries()) {
      const edge = raw as JsonObject;
      const uid = serviceString(edge.uid, `edges.${index}.uid`);
      if (validateEdgeIdentifiers && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid)) {
        serviceValidationError(`edges.${index}.uid`, "Must be a valid UUID.");
      }
      if (validateEdgeIdentifiers && seen.has(uid)) serviceValidationError(`edges.${index}.uid`, "Router edge identifiers must be unique.");
      seen.add(uid);
      edge.uid = uid;
      edge.label = serviceString(edge.label, `edges.${index}.label`, { maxLength: 75 });
      edge.condition = normalizeAutomationFormula(
        edge.condition,
        `edges.${index}.condition`,
        creating || Object.prototype.hasOwnProperty.call(provided, "edges"),
      );
    }
    return service;
  }
  if (serviceType === "periodic") {
    const interval = serviceString(service.interval, "interval").toUpperCase();
    if (!AUTOMATION_PERIODIC_INTERVALS.has(interval)) serviceValidationError("interval", `\"${interval}\" is not a valid choice.`);
    service.interval = interval;
    const minute = serviceNumber(service.minute, "minute", { nullable: true, integer: true, min: 0, max: 59 });
    service.minute = minute;
    if (interval === "MINUTE" && minute !== null && minute < 1) {
      throw new ApiError(
        400,
        "ERROR_AUTOMATION_NODE_MISCONFIGURED_SERVICE",
        "The `minute` value must be greater or equal to 1.",
      );
    }
    service.hour = serviceNumber(service.hour, "hour", { nullable: true, integer: true, min: 0, max: 23 });
    service.day_of_week = serviceNumber(service.day_of_week, "day_of_week", { nullable: true, integer: true, min: 0, max: 6 });
    service.day_of_month = serviceNumber(service.day_of_month, "day_of_month", { nullable: true, integer: true, min: 1, max: 31 });
    return service;
  }
  if (serviceType === "http_trigger") {
    const uid = serviceString(service.uid, "uid");
    if (
      (creating || Object.prototype.hasOwnProperty.call(provided, "uid"))
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid)
    ) {
      serviceValidationError("uid", "Must be a valid UUID.");
    }
    service.uid = uid;
    service.exclude_get = serviceBoolean(service.exclude_get, "exclude_get");
    service.is_public = serviceBoolean(service.is_public, "is_public");
    return service;
  }
  if (serviceType === "iterator") {
    service.source = normalizeAutomationFormula(
      service.source,
      "source",
      creating || Object.prototype.hasOwnProperty.call(provided, "source"),
    );
    return service;
  }
  return service;
}

async function normalizeService(
  db: D1Database,
  workflow: any,
  type: string,
  service: unknown,
  existing: JsonObject = {},
  reset = false,
  validateProvidedIdentifiers = true,
  cache?: KVNamespace,
) {
  const defaults = await defaultAutomationService(db, workflow, type);
  const base = reset ? {} : existing;
  const data = objectValue(service) || {};
  validateAutomationServiceInputShape(type, data);
  const normalized = {
    ...defaults,
    ...base,
    ...data,
  };
  if (type === "http_trigger" && !normalized.uid) normalized.uid = crypto.randomUUID();
  if (type === "router") {
    normalized.edges = normalizeRouterEdges(normalized.edges);
  }
  if (type === "periodic") {
    normalized.interval = String(normalized.interval || "HOUR").toUpperCase();
  }
  if (Array.isArray(normalized.field_mappings)) {
    normalized.field_mappings = normalized.field_mappings.map((mapping) => (
      mapping && typeof mapping === "object" && !Array.isArray(mapping)
        ? { enabled: true, ...(mapping as JsonObject) }
        : mapping
    ));
  }
  return validateAutomationService(
    db,
    cache,
    workflow,
    type,
    normalized,
    validateProvidedIdentifiers ? data : {},
    reset,
  );
}

async function defaultAutomationService(db: D1Database, workflow: any, type: string): Promise<JsonObject> {
  const serviceType = automationServiceType(type);
  const integrationId = await defaultIntegrationId(db, Number(workflow?.automation_id), integrationTypeForService(serviceType));
  const base: JsonObject = {
    type: serviceType,
    integration_id: integrationId,
    sample_data: null,
  };
  if (serviceType === "local_supertask_upsert_row") {
    return { ...base, table_id: null, row_id: formulaObject(), field_mappings: [] };
  }
  if (serviceType === "local_supertask_delete_row") {
    return { ...base, table_id: null, row_id: formulaObject() };
  }
  if (serviceType === "local_supertask_get_row") {
    return {
      ...base,
      table_id: null,
      view_id: null,
      row_id: formulaObject(),
      search_query: formulaObject(),
      filters: [],
      sortings: [],
      filter_type: "AND",
    };
  }
  if (serviceType === "local_supertask_list_rows") {
    return {
      ...base,
      table_id: null,
      view_id: null,
      search_query: formulaObject(),
      filters: [],
      sortings: [],
      filter_type: "AND",
      default_result_count: 20,
    };
  }
  if (serviceType === "local_supertask_aggregate_rows") {
    return {
      ...base,
      table_id: null,
      view_id: null,
      field_id: null,
      aggregation_type: "",
      search_query: formulaObject(),
      filters: [],
      filter_type: "AND",
    };
  }
  if (serviceType === "local_supertask_rows_created" || serviceType === "local_supertask_rows_updated" || serviceType === "local_supertask_rows_deleted") {
    return { ...base, table_id: null };
  }
  if (serviceType === "http_request") {
    return {
      ...base,
      http_method: "GET",
      url: formulaObject(),
      headers: [],
      query_params: [],
      form_data: [],
      body_type: "none",
      body_content: formulaObject(),
      timeout: 30,
    };
  }
  if (serviceType === "smtp_email") {
    return {
      ...base,
      from_email: formulaObject(),
      from_name: formulaObject(),
      to_emails: formulaObject(),
      cc_emails: formulaObject(),
      bcc_emails: formulaObject(),
      subject: formulaObject(),
      body_type: "plain",
      body: formulaObject(),
    };
  }
  if (serviceType === "ai_agent") {
    return {
      ...base,
      ai_generative_ai_type: null,
      ai_generative_ai_model: null,
      ai_output_type: "text",
      ai_temperature: null,
      ai_prompt: formulaObject(),
      ai_choices: [],
    };
  }
  if (serviceType === "router") {
    return {
      ...base,
      default_edge_label: "",
      edges: [{ uid: crypto.randomUUID(), order: 0, label: "Branch", condition: formulaObject() }],
    };
  }
  if (serviceType === "iterator") {
    return { ...base, source: formulaObject() };
  }
  if (serviceType === "periodic") {
    return { ...base, interval: "HOUR", minute: 0, hour: 0, day_of_week: 0, day_of_month: 1, last_periodic_run: null };
  }
  if (serviceType === "http_trigger") {
    return { ...base, uid: crypto.randomUUID(), exclude_get: false, is_public: true };
  }
  return base;
}

function automationServiceType(type: string) {
  if (type === "local_supertask_create_row" || type === "local_supertask_update_row") return "local_supertask_upsert_row";
  return type;
}

function integrationTypeForService(serviceType: string): string | null {
  if (serviceType.startsWith("local_supertask_")) return "local_supertask";
  if (serviceType === "smtp_email") return "smtp";
  if (serviceType === "ai_agent") return "ai";
  return null;
}

async function defaultIntegrationId(db: D1Database, automationId: number, integrationType: string | null): Promise<number | null> {
  if (!integrationType || !Number.isFinite(automationId) || automationId <= 0) return null;
  const rows = await db.prepare(
    "SELECT id FROM core_integration WHERE application_id=? AND type=? ORDER BY CAST([order] AS REAL) ASC, id ASC LIMIT 2"
  ).bind(automationId, integrationType).all<{ id: number }>();
  return rows.results?.length === 1 ? Number(rows.results[0].id) : null;
}

function normalizeRouterEdges(value: unknown) {
  const edges = Array.isArray(value)
    ? value
    : [{ uid: crypto.randomUUID(), order: 0, label: "Branch", condition: formulaObject() }];
  return edges.map((edge, index) => {
    const item = objectValue(edge) || {};
    return {
      uid: item.uid || crypto.randomUUID(),
      order: item.order ?? index,
      label: String(item.label ?? "Branch"),
      condition: objectValue(item.condition) || formulaObject(String(item.condition || "")),
    };
  });
}

function automationCoreServiceSchema(serviceType: string, serviceId: number, service: JsonObject): JsonObject | null {
  if (serviceType === "router") {
    return {
      title: `CoreRouter${serviceId}Schema`,
      type: "object",
      properties: {
        edge: {
          title: "Branch taken",
          type: "object",
          properties: {
            label: {
              type: "string",
              title: "Label",
              description: "The label of the branch that matched the condition.",
            },
          },
        },
      },
    };
  }
  if (serviceType === "periodic") {
    return {
      title: `Periodic${serviceId}Schema`,
      type: "object",
      properties: {
        triggered_at: {
          type: "string",
          title: "Triggered at",
        },
      },
    };
  }
  if (serviceType === "http_trigger") {
    return httpTriggerServiceSchema(serviceId, service);
  }
  if (serviceType === "iterator") {
    return iteratorServiceSchema(serviceId, service);
  }
  return null;
}

function httpTriggerServiceSchema(serviceId: number, service: JsonObject): JsonObject {
  const sampleData = objectValue(service.sample_data);
  const samplePayload = objectValue(sampleData?.data) || {};
  const properties: JsonObject = {};
  if (sampleData) {
    properties.body = { ...jsonSchemaForValue(samplePayload.body ?? {}, true), title: "Body" };
  }
  properties.raw_body = { type: "string", title: "Raw body" };
  if (sampleData) {
    properties.query_params = { ...jsonSchemaForValue(samplePayload.query_params ?? {}, true), title: "Query parameters" };
  }
  properties.headers = {
    type: "object",
    properties: {
      "Content-Type": { type: "string", description: "The MIME type of the request body" },
      "Content-Length": { type: "number", description: "The length of the request body in octets (8-bit bytes)" },
      ETag: { type: "string", description: "An identifier for a specific version of a resource" },
    },
    ...(sampleData ? jsonSchemaForValue(samplePayload.headers ?? {}, true) : {}),
    title: "Headers",
  };
  return { title: `HTTPTrigger${serviceId}Schema`, type: "object", properties };
}

function iteratorServiceSchema(serviceId: number, service: JsonObject): JsonObject | null {
  const sampleData = objectValue(service.sample_data);
  const data = objectValue(sampleData?.data);
  if (!Array.isArray(data?.results)) return null;
  const schema = jsonSchemaForValue(data.results, true);
  return schema.items ? { ...schema, title: `Iterator${serviceId}Schema` } : null;
}

function jsonSchemaForValue(value: unknown, topLevelObject = false): JsonObject {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const schema: JsonObject = { type: "array" };
    if (value.length > 0) schema.items = mergeJsonSchemas(value.map((item) => jsonSchemaForValue(item)));
    return schema;
  }
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonObject);
    const schema: JsonObject = { type: "object" };
    if (entries.length > 0) {
      schema.properties = Object.fromEntries(entries.map(([key, item]) => [key, jsonSchemaForValue(item)]));
      schema.required = entries.map(([key]) => key);
    }
    return topLevelObject ? schema : schema;
  }
  return {};
}

function mergeJsonSchemas(schemas: JsonObject[]): JsonObject {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0];
  const types = Array.from(new Set(schemas.flatMap((schema) => Array.isArray(schema.type) ? schema.type : [schema.type]).filter(Boolean).map(String)));
  if (types.length !== 1) return { type: types };
  const type = types[0];
  if (type !== "object") return { type };
  const propertyNames = new Set<string>();
  for (const schema of schemas) {
    for (const key of Object.keys((schema.properties as JsonObject | undefined) || {})) propertyNames.add(key);
  }
  const properties = Object.fromEntries(Array.from(propertyNames).map((key) => [
    key,
    mergeJsonSchemas(schemas.map((schema) => (schema.properties as JsonObject | undefined)?.[key]).filter(Boolean) as JsonObject[]),
  ]));
  return { type: "object", ...(Object.keys(properties).length > 0 ? { properties } : {}) };
}

function formulaObject(formula = ""): JsonObject {
  return { formula, mode: "simple", version: "0.1" };
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

async function workflowForNode(db: D1Database, row: any) {
  if (row?.automation_id) return row;
  const workflow = await db.prepare(
    `SELECT wf.id, wf.automation_id, wf.graph, a.workspace_id
     FROM automation_workflow wf
     JOIN core_application a ON a.id=wf.automation_id
     WHERE wf.id=?`,
  )
    .bind(Number(row?.workflow_id))
    .first<any>();
  return workflow || { id: row?.workflow_id, automation_id: null };
}

function workflowCanRun(row: any) {
  if (row.state === "live") return true;
  if (row.allow_test_run_until && new Date(String(row.allow_test_run_until)).getTime() >= Date.now()) return true;
  if (row.simulate_until_node_id) return true;
  return false;
}

function graphNode(graph: Graph, nodeId: number): GraphNode | undefined {
  const entry = graph[String(nodeId)];
  return entry && typeof entry !== "number" ? entry : undefined;
}

function nodeById(nodes: any[], nodeId: number) {
  return nodes.find((node) => Number(node.id) === nodeId);
}

function validateGraphPosition(
  graph: Graph,
  nodes: any[],
  referenceNodeId: number | null,
  position: string,
  output: string,
  movingNodeId?: number
) {
  if (referenceNodeId === null) return;
  if (!Number.isInteger(referenceNodeId) || referenceNodeId <= 0 || referenceNodeId === movingNodeId) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_REFERENCE_NODE_INVALID", "The reference node is invalid.");
  }
  const reference = nodeById(nodes, referenceNodeId);
  if (!reference || !graphNode(graph, referenceNodeId)) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_REFERENCE_NODE_INVALID", "The reference node does not exist in the workflow graph.");
  }
  if (!new Set(["south", "child"]).has(position)) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_REFERENCE_NODE_INVALID", `The node position '${position}' is invalid.`);
  }
  if (position === "child" && reference.type !== "iterator") {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_REFERENCE_NODE_INVALID", "Only iterator nodes can contain child nodes.");
  }
  if (output) {
    if (position === "child" || reference.type !== "router") {
      throw new ApiError(400, "ERROR_AUTOMATION_NODE_REFERENCE_NODE_INVALID", "Only router nodes can reference a named output branch.");
    }
    const edgeUids = new Set(
      (Array.isArray(serviceOf(reference).edges) ? serviceOf(reference).edges as JsonObject[] : [])
        .map((edge) => String(edge.uid || ""))
        .filter(Boolean)
    );
    if (!edgeUids.has(output)) {
      throw new ApiError(400, "ERROR_AUTOMATION_NODE_REFERENCE_NODE_INVALID", `The router output '${output}' does not exist.`);
    }
  }
}

function nodeGraphPosition(graph: Graph, nodeId: number) {
  if (Number(graph["0"]) === nodeId) {
    return { referenceNodeId: null, position: "south", output: "" };
  }
  for (const [entryKey, entry] of Object.entries(graph)) {
    if (entryKey === "0" || entryKey === String(nodeId) || typeof entry === "number") continue;
    for (const [output, nodeIds] of Object.entries(entry.next || {})) {
      if (nodeIds.includes(nodeId)) {
        return { referenceNodeId: Number(entryKey), position: "south", output };
      }
    }
    if ((entry.children || []).includes(nodeId)) {
      return { referenceNodeId: Number(entryKey), position: "child", output: "" };
    }
  }
  throw new ApiError(
    400,
    "ERROR_AUTOMATION_NODE_NOT_IN_WORKFLOW",
    `The node id ${nodeId} does not belong to the workflow graph.`,
  );
}

function directNextNodeIds(graph: Graph, nodeId: number, includeDefault = true) {
  return Object.entries(graphNode(graph, nodeId)?.next || {})
    .filter(([output]) => includeDefault || output !== "")
    .flatMap(([, ids]) => ids);
}

function graphDescendants(graph: Graph, nodeId: number) {
  const descendants = new Set<number>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entry = graphNode(graph, current);
    for (const child of [...Object.values(entry?.next || {}).flat(), ...(entry?.children || [])]) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      pending.push(child);
    }
  }
  return descendants;
}

function assertNodeDeletable(graph: Graph, node: any) {
  if (isTriggerType(node.type) && directNextNodeIds(graph, Number(node.id)).length > 0) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_DELETABLE", "Trigger nodes cannot be deleted if they are followed by nodes.");
  }
  if (node.type === "iterator" && (graphNode(graph, Number(node.id))?.children || []).length > 0) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_DELETABLE", "Container nodes cannot be deleted if they have one or more children nodes associated with them.");
  }
  if (node.type === "router" && directNextNodeIds(graph, Number(node.id), false).length > 0) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_DELETABLE", "Router nodes cannot be deleted if they have one or more output nodes associated with them.");
  }
}

function assertNodeReplaceable(graph: Graph, node: any) {
  if (node.type === "iterator" && (graphNode(graph, Number(node.id))?.children || []).length > 0) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_REPLACEABLE", "Container nodes cannot be replaced if they have one or more children nodes associated with them.");
  }
  if (node.type === "router" && directNextNodeIds(graph, Number(node.id), false).length > 0) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_REPLACEABLE", "Router nodes cannot be replaced if they have one or more output nodes associated with them.");
  }
}

function assertNodeMovable(graph: Graph, node: any, referenceNodeId: number) {
  if (node.type === "router" && directNextNodeIds(graph, Number(node.id), false).length > 0) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_MOVABLE", "Router nodes cannot be moved if they have one or more output nodes associated with them.");
  }
  if (node.type === "iterator" && graphDescendants(graph, Number(node.id)).has(referenceNodeId)) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_MOVABLE", "A container node cannot be moved inside itself.");
  }
}

function validateRouterEdgesUpdate(graph: Graph, node: any, service: JsonObject) {
  const edgeUids = new Set(
    (Array.isArray(service.edges) ? service.edges as JsonObject[] : [])
      .map((edge) => String(edge.uid || ""))
      .filter(Boolean)
  );
  const branches = graphNode(graph, Number(node.id))?.next || {};
  for (const [output, nodeIds] of Object.entries(branches)) {
    if (output && nodeIds.length > 0 && !edgeUids.has(output)) {
      throw new ApiError(
        400,
        "ERROR_AUTOMATION_NODE_MISCONFIGURED_SERVICE",
        "One or more branches have been removed from the router node, but they still point to output nodes. These nodes must be trashed before the router can be updated."
      );
    }
  }
}

function insertNodeInGraph(graph: Graph, nodeId: number, referenceNodeId: number | null, position: string, output: string, existingNodes: any[]) {
  if (!referenceNodeId) {
    const oldRoot = Number(graph["0"] || 0);
    graph["0"] = nodeId;
    graph[String(nodeId)] = oldRoot ? { next: { "": [oldRoot] } } : {};
    return;
  }
  if (!graph[String(referenceNodeId)]) throw new ValidationError("The reference node does not exist in the workflow graph.");
  if (position === "child") {
    output = output || "";
  }
  const reference = graph[String(referenceNodeId)] as GraphNode;
  let oldNext: number[] = [];
  if (position === "child") {
    oldNext = reference.children || [];
    reference.children = [nodeId];
  } else {
    const next = reference.next || {};
    oldNext = next[output] || [];
    next[output] = [nodeId];
    reference.next = next;
  }
  graph[String(referenceNodeId)] = reference;
  graph[String(nodeId)] = { next: oldNext.length > 0 ? { "": oldNext } : {} };

  for (const candidate of existingNodes) {
    if (!graph[String(candidate.id)]) graph[String(candidate.id)] = { next: {} };
  }
}

function removeNodeFromGraph(graph: Graph, nodeId: number) {
  const key = String(nodeId);
  const own = graph[key] as GraphNode | undefined;
  const replacement = own?.next?.[""] || [];
  if (Number(graph["0"]) === nodeId) {
    graph["0"] = replacement[0] || 0;
  }
  for (const [entryKey, entry] of Object.entries(graph)) {
    if (entryKey === "0" || typeof entry === "number") continue;
    const next = entry.next || {};
    for (const [output, ids] of Object.entries(next)) {
      next[output] = ids.flatMap((id) => id === nodeId ? replacement : [id]);
    }
    entry.next = next;
    if (entry.children) {
      entry.children = entry.children.flatMap((id) => id === nodeId ? replacement : [id]);
    }
  }
  delete graph[key];
}

function replaceNodeInGraph(graph: Graph, oldNodeId: number, newNodeId: number) {
  const oldKey = String(oldNodeId);
  const newKey = String(newNodeId);
  const oldEntry = graphNode(graph, oldNodeId);
  if (!oldEntry) {
    throw new ApiError(400, "ERROR_AUTOMATION_NODE_NOT_IN_WORKFLOW", `The node id ${oldNodeId} does not belong to the workflow.`);
  }
  if (Number(graph["0"]) === oldNodeId) graph["0"] = newNodeId;
  for (const [entryKey, entry] of Object.entries(graph)) {
    if (entryKey === "0" || typeof entry === "number") continue;
    for (const [output, ids] of Object.entries(entry.next || {})) {
      entry.next![output] = ids.map((id) => id === oldNodeId ? newNodeId : id);
    }
    if (entry.children) {
      entry.children = entry.children.map((id) => id === oldNodeId ? newNodeId : id);
    }
  }
  graph[newKey] = oldEntry;
  delete graph[oldKey];
}

function nextNodeIds(graph: Graph, nodeId: number, output: string) {
  const entry = graph[String(nodeId)] as GraphNode | undefined;
  const next = entry?.next || {};
  return next[output] || next[""] || [];
}

function childNodeIds(graph: Graph, nodeId: number) {
  const entry = graph[String(nodeId)] as GraphNode | undefined;
  return entry?.children || [];
}

function nodesOnPathTo(graph: Graph, startId: number, targetId: number) {
  const path = new Set<number>();
  const visit = (nodeId: number, current: number[]): boolean => {
    if (nodeId === targetId) {
      for (const id of [...current, nodeId]) path.add(id);
      return true;
    }
    const entry = graph[String(nodeId)] as GraphNode | undefined;
    const nextIds = [
      ...Object.values(entry?.next || {}).flat(),
      ...(entry?.children || []),
    ];
    for (const nextId of nextIds) {
      if (visit(nextId, [...current, nodeId])) return true;
    }
    return false;
  };
  visit(startId, []);
  return path.size > 0 ? path : undefined;
}

async function saveWorkflowGraph(db: D1Database, workflowId: number, graph: Graph) {
  await db.prepare("UPDATE automation_workflow SET graph=?, updated_on=? WHERE id=?")
    .bind(JSON.stringify(graph), nowIso(), workflowId)
    .run();
}

function remapGraphIds(graph: Graph, idMap: Map<number, number>, edgeMap = new Map<string, string>()) {
  const nextGraph: Graph = {};
  for (const [key, entry] of Object.entries(graph)) {
    if (key === "0") {
      nextGraph["0"] = idMap.get(Number(entry)) || 0;
      continue;
    }
    const mappedKey = idMap.get(Number(key));
    if (!mappedKey || typeof entry === "number") continue;
    const next: Record<string, number[]> = {};
    for (const [output, ids] of Object.entries(entry.next || {})) {
      const mappedOutput = output === "" ? "" : edgeMap.get(output) || output;
      next[mappedOutput] = ids.map((id) => idMap.get(id)).filter(Boolean) as number[];
    }
    const children = (entry.children || []).map((id) => idMap.get(id)).filter(Boolean) as number[];
    nextGraph[String(mappedKey)] = { next, ...(children.length ? { children } : {}) };
  }
  return nextGraph;
}

async function automationHttpTriggerByUid(db: D1Database, uid: string, simulate: boolean) {
  const rows = await db.prepare(
    `SELECT n.*, wf.state, wf.allow_test_run_until
     FROM automation_node n
     JOIN automation_workflow wf ON wf.id = n.workflow_id
     JOIN core_application a ON a.id = wf.automation_id
     WHERE n.type='http_trigger' AND n.trashed=0 AND wf.trashed=0 AND a.trashed=0
       AND json_extract(n.service, '$.uid') = ?
     ORDER BY n.id DESC`
  ).bind(uid).all<any>();
  const trigger = (rows.results || []).find((candidate: any) => {
    if (simulate) return true;
    return workflowCanRun(candidate) && serviceOf(candidate).is_public !== false;
  });
  if (!trigger) throw new DoesNotExist("HTTP trigger", uid);
  return trigger;
}

function isPeriodicDue(node: any, now: Date) {
  const service = serviceOf(node);
  const interval = String(service.interval || "HOUR").toUpperCase();
  const lastRunRaw = service.last_periodic_run;
  if (!lastRunRaw) return true;
  const lastRun = new Date(String(lastRunRaw));
  if (Number.isNaN(lastRun.getTime())) return true;
  const elapsed = now.getTime() - lastRun.getTime();
  if (interval === "MINUTE") return elapsed >= Math.max(Number(service.minute || 1), 1) * 60 * 1000;
  if (interval === "HOUR") return elapsed >= 60 * 60 * 1000 && now.getUTCMinutes() >= Number(service.minute || 0);
  if (interval === "DAY") return elapsed >= 24 * 60 * 60 * 1000 && now.getUTCHours() >= Number(service.hour || 0) && now.getUTCMinutes() >= Number(service.minute || 0);
  if (interval === "WEEK") return elapsed >= 7 * 24 * 60 * 60 * 1000 && ((now.getUTCDay() + 6) % 7) === Number(service.day_of_week || 0);
  if (interval === "MONTH") return elapsed >= 28 * 24 * 60 * 60 * 1000 && now.getUTCDate() === Number(service.day_of_month || 1);
  return false;
}

async function claimPeriodicRun(db: D1Database, node: any, now: Date) {
  const service = { ...serviceOf(node), last_periodic_run: now.toISOString() };
  const claimedService = JSON.stringify(service);
  const result = await db.prepare("UPDATE automation_node SET service=?, updated_on=? WHERE id=? AND service=?")
    .bind(claimedService, now.toISOString(), node.id, node.service)
    .run();
  const changes = Number((result as any).meta?.changes ?? (result as any).changes ?? 0);
  return changes === 1 ? claimedService : null;
}
