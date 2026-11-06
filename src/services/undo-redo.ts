import type { Env, RequestUser } from "../types/env";
import { ensureUserTableSystemColumns, type FieldMeta } from "./dynamic-tables";
import { broadcastToWorkspace } from "../durable-objects/workspace-room";
import { applyDateDependencyRules } from "./field-rules";
import { serializeFieldValueForStorage } from "./field-values";
import { serializeRowWithComputedFields } from "./computed-fields";
import { getActiveFields } from "./view-helpers";
import { deleteTrashEntry, recordTrashEntry } from "./trash";
import { synchronizeLinkRowRelations } from "./link-row-relations";
import { restoreViewStateForUndoRedo, serializeViewForUndoRedo } from "./view-snapshots";
import {
  restoreFieldStateForUndoRedo,
  serializeFieldForUndoRedo,
  serializeRelatedFieldsForUndoRedo,
} from "./field-snapshots";
import {
  restoreAutomationWorkflowSnapshot,
  snapshotAutomationWorkflow,
  type AutomationWorkflowSnapshot,
} from "./automation-snapshots";
import { serializeNode, serializeWorkflow } from "./automation";
import { assertHasApplicationRole, assertHasTableRole } from "./enterprise-permissions";

type Direction = "undo" | "redo";
type ResultCode = "NOTHING_TO_DO" | "SUCCESS" | "SKIPPED_DUE_TO_ERROR";
type ActionSource = "row" | "core";

type HistoryAction = {
  source: ActionSource;
  id: number;
  user_id: number | null;
  table_id?: number;
  row_id?: number;
  action_timestamp: string;
  action_type: string;
  before_values: string;
  after_values: string;
  undone_at: string | null;
  session: string;
  action_group: string | null;
  action_scope: string | null;
  error: string | null;
  metadata: string | null;
  params?: string | null;
};

type TableMeta = {
  id: number;
  database_id: number;
  workspace_id: number;
};

export type UndoRedoResponse = {
  actions: Array<{ action_type: string | null; action_scope: string | null }>;
  result_code: ResultCode;
};

const NOTHING_TO_DO: UndoRedoResponse = {
  actions: [],
  result_code: "NOTHING_TO_DO",
};

function hasOwn(value: Record<string, unknown> | null | undefined, key: string) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function scopeTokens(scopes: unknown): string[] {
  if (!scopes) return [];
  if (Array.isArray(scopes)) {
    return scopes.map((scope) => String(scope)).filter(Boolean);
  }
  if (typeof scopes !== "object") return [];
  const tokens: string[] = [];
  for (const [key, value] of Object.entries(scopes as Record<string, unknown>)) {
    if (value === null || value === undefined || value === false || value === "") continue;
    if (key === "root") tokens.push("root");
    else tokens.push(`${key}${value}`);
  }
  return tokens;
}

function orderValue(row: Record<string, unknown> | null | undefined): unknown {
  if (!row) return undefined;
  if (hasOwn(row, "order")) return row.order;
  if (hasOwn(row, "[order]")) return row["[order]"];
  return undefined;
}

function actionPayload(action: HistoryAction) {
  return {
    action_type: action.action_type || null,
    action_scope: action.action_scope || null,
  };
}

function metadataRow(action: HistoryAction, key: "before_row" | "after_row") {
  const metadata = parseObject(action.metadata);
  const row = metadata[key];
  return row && typeof row === "object" && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
}

async function tableMeta(db: D1Database, tableId: number): Promise<TableMeta | null> {
  return db.prepare(
    `SELECT t.id, t.database_id, a.workspace_id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=?`
  ).bind(tableId).first<TableMeta>();
}

async function latestAction(
  db: D1Database,
  user: RequestUser,
  session: string,
  scopes: string[],
  direction: Direction
): Promise<HistoryAction | null> {
  const [rowAction, coreAction] = await Promise.all([
    latestRowAction(db, user, session, scopes, direction),
    latestCoreAction(db, user, session, scopes, direction),
  ]);
  if (!rowAction) return coreAction;
  if (!coreAction) return rowAction;
  return compareActionOrder(rowAction, coreAction, direction) >= 0 ? rowAction : coreAction;
}

async function latestRowAction(
  db: D1Database,
  user: RequestUser,
  session: string,
  scopes: string[],
  direction: Direction
): Promise<HistoryAction | null> {
  const undoneClause = direction === "undo" ? "undone_at IS NULL" : "undone_at IS NOT NULL";
  const bindings: unknown[] = [user.id, session];
  let scopeClause = "";
  if (scopes.length > 0) {
    scopeClause = ` AND action_scope IN (${scopes.map(() => "?").join(",")})`;
    bindings.push(...scopes);
  }
  const order = direction === "undo"
    ? "action_timestamp DESC, id DESC"
    : "undone_at DESC, action_timestamp DESC, id DESC";
  const row = await db.prepare(
    `SELECT *
     FROM database_rowhistory
     WHERE user_id=? AND session=? AND ${undoneClause}${scopeClause}
     ORDER BY ${order}
     LIMIT 1`
  ).bind(...bindings).first<any>();
  return row ? { ...row, source: "row" } : null;
}

async function latestCoreAction(
  db: D1Database,
  user: RequestUser,
  session: string,
  scopes: string[],
  direction: Direction
): Promise<HistoryAction | null> {
  const undoneClause = direction === "undo" ? "undone_at IS NULL" : "undone_at IS NOT NULL";
  const bindings: unknown[] = [user.id, session];
  let scopeClause = "";
  if (scopes.length > 0) {
    scopeClause = ` AND action_scope IN (${scopes.map(() => "?").join(",")})`;
    bindings.push(...scopes);
  }
  const order = direction === "undo"
    ? "action_timestamp DESC, id DESC"
    : "undone_at DESC, action_timestamp DESC, id DESC";
  try {
    const row = await db.prepare(
      `SELECT id, user_id, user_name, NULL AS table_id, NULL AS row_id,
              action_timestamp, action_type, '{}' AS before_values, '{}' AS after_values,
              undone_at, session, action_group, action_scope, error, NULL AS metadata, params
       FROM core_action
       WHERE user_id=? AND session=? AND ${undoneClause}${scopeClause}
       ORDER BY ${order}
       LIMIT 1`
    ).bind(...bindings).first<any>();
    return row ? { ...row, source: "core" } : null;
  } catch (error: any) {
    if (String(error?.message || error).includes("core_action")) return null;
    throw error;
  }
}

function actionOrderValue(action: HistoryAction, direction: Direction) {
  const primary = direction === "redo" ? action.undone_at || action.action_timestamp : action.action_timestamp;
  return `${primary || ""}:${String(action.id).padStart(12, "0")}`;
}

function compareActionOrder(a: HistoryAction, b: HistoryAction, direction: Direction) {
  return actionOrderValue(a, direction).localeCompare(actionOrderValue(b, direction));
}

async function groupedActions(
  db: D1Database,
  action: HistoryAction,
  scopes: string[],
  direction: Direction
): Promise<HistoryAction[]> {
  if (!action.action_group) return [action];
  if (action.source === "core") return groupedCoreActions(db, action, scopes, direction);
  const undoneClause = direction === "undo" ? "undone_at IS NULL" : "undone_at IS NOT NULL";
  const bindings: unknown[] = [action.user_id, action.session, action.action_group];
  let scopeClause = "";
  if (scopes.length > 0) {
    scopeClause = ` AND action_scope IN (${scopes.map(() => "?").join(",")})`;
    bindings.push(...scopes);
  }
  const order = direction === "undo" ? "id DESC" : "id ASC";
  const result = await db.prepare(
    `SELECT *
     FROM database_rowhistory
     WHERE user_id=? AND session=? AND action_group=? AND ${undoneClause}${scopeClause}
     ORDER BY ${order}`
  ).bind(...bindings).all<HistoryAction>();
  return (result.results || []).map((row: any) => ({ ...row, source: "row" as const }));
}

async function groupedCoreActions(
  db: D1Database,
  action: HistoryAction,
  scopes: string[],
  direction: Direction
): Promise<HistoryAction[]> {
  const undoneClause = direction === "undo" ? "undone_at IS NULL" : "undone_at IS NOT NULL";
  const bindings: unknown[] = [action.user_id, action.session, action.action_group];
  let scopeClause = "";
  if (scopes.length > 0) {
    scopeClause = ` AND action_scope IN (${scopes.map(() => "?").join(",")})`;
    bindings.push(...scopes);
  }
  const order = direction === "undo" ? "id DESC" : "id ASC";
  const result = await db.prepare(
    `SELECT id, user_id, user_name, NULL AS table_id, NULL AS row_id,
            action_timestamp, action_type, '{}' AS before_values, '{}' AS after_values,
            undone_at, session, action_group, action_scope, error, NULL AS metadata, params
     FROM core_action
     WHERE user_id=? AND session=? AND action_group=? AND ${undoneClause}${scopeClause}
     ORDER BY ${order}`
  ).bind(...bindings).all<any>();
  return (result.results || []).map((row: any) => ({ ...row, source: "core" as const }));
}

async function normalActionHappenedAfterUndo(
  db: D1Database,
  user: RequestUser,
  session: string,
  undoneAt: string
) {
  const row = await db.prepare(
    `SELECT id
     FROM database_rowhistory
     WHERE user_id=? AND session=? AND undone_at IS NULL AND action_timestamp > ?
     LIMIT 1`
  ).bind(user.id, session, undoneAt).first<{ id: number }>();
  if (row) return true;
  try {
    const core = await db.prepare(
      `SELECT id
       FROM core_action
       WHERE user_id=? AND session=? AND undone_at IS NULL AND action_timestamp > ?
       LIMIT 1`
    ).bind(user.id, session, undoneAt).first<{ id: number }>();
    return Boolean(core);
  } catch (error: any) {
    if (String(error?.message || error).includes("core_action")) return false;
    throw error;
  }
}

async function storageValue(
  env: Env,
  field: FieldMeta,
  values: Record<string, unknown>,
  snapshot: Record<string, unknown> | null
) {
  const column = `field_${field.id}`;
  if (hasOwn(snapshot, column)) return snapshot![column] ?? null;
  if (!hasOwn(values, column)) return undefined;
  return await serializeFieldValueForStorage(env.DB, field, values[column], env);
}

async function rowForBroadcast(
  env: Env,
  tableId: number,
  rowId: number,
  fields: FieldMeta[],
  fallback: Record<string, unknown> | null
) {
  await ensureUserTableSystemColumns(env.DB, tableId);
  const row = await env.DB.prepare(`SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`)
    .bind(rowId)
    .first<Record<string, unknown>>();
  const source = row || fallback;
  if (!source) return null;
  return serializeRowWithComputedFields(env.DB, source, fields, false);
}

async function broadcastRowsUpdated(
  env: Env,
  meta: TableMeta,
  tableId: number,
  rows: Record<string, unknown>[],
  updatedFieldIds: number[],
  websocketId: string
) {
  if (rows.length === 0) return;
  await broadcastToWorkspace(env, meta.workspace_id, {
    type: "rows_updated",
    table_id: tableId,
    rows,
    metadata: {
      updated_field_ids: updatedFieldIds,
      cascade_update: { rows: [], field_ids: [] },
    },
  }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
}

async function broadcastRowsCreated(
  env: Env,
  meta: TableMeta,
  tableId: number,
  rows: Record<string, unknown>[],
  websocketId: string
) {
  if (rows.length === 0) return;
  await broadcastToWorkspace(env, meta.workspace_id, {
    type: "rows_created",
    table_id: tableId,
    rows,
    metadata: {},
  }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
}

async function broadcastRowsDeleted(
  env: Env,
  meta: TableMeta,
  tableId: number,
  rows: Record<string, unknown>[],
  rowIds: number[],
  websocketId: string
) {
  if (rowIds.length === 0) return;
  await broadcastToWorkspace(env, meta.workspace_id, {
    type: "rows_deleted",
    table_id: tableId,
    row_ids: rowIds,
    rows,
  }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
}

async function restoreRow(
  env: Env,
  user: RequestUser,
  tableId: number,
  rowId: number,
  fields: FieldMeta[],
  values: Record<string, unknown>,
  snapshot: Record<string, unknown> | null
) {
  await ensureUserTableSystemColumns(env.DB, tableId);
  const existing = await env.DB.prepare(`SELECT id FROM "database_table_${tableId}" WHERE id=?`)
    .bind(rowId)
    .first<{ id: number }>();
  if (existing) {
    await env.DB.prepare(`UPDATE "database_table_${tableId}" SET trashed=0 WHERE id=?`)
      .bind(rowId)
      .run();
    await deleteTrashEntry(env.DB, "row", rowId, tableId);
    await updateRowValues(env, user, tableId, rowId, fields, values, snapshot, true);
    return;
  }

  const now = new Date().toISOString();
  const columns = ["id", "[order]", "trashed", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id"];
  const rowOrder = orderValue(snapshot);
  const vals: unknown[] = [
    rowId,
    rowOrder === undefined ? 10000 : rowOrder,
    0,
    snapshot?._created_on || now,
    snapshot?._updated_on || now,
    snapshot?._created_by_id ?? user.id,
    snapshot?._last_modified_by_id ?? user.id,
  ];
  for (const field of fields) {
    columns.push(`"field_${field.id}"`);
    const value = await storageValue(env, field, values, snapshot);
    vals.push(value === undefined ? null : value);
  }
  const bindMarks = columns.map(() => "?").join(", ");
  await env.DB.prepare(
    `INSERT INTO "database_table_${tableId}" (${columns.join(", ")}) VALUES (${bindMarks})`
  ).bind(...vals).run();
}

async function updateRowValues(
  env: Env,
  user: RequestUser,
  tableId: number,
  rowId: number,
  fields: FieldMeta[],
  values: Record<string, unknown>,
  snapshot: Record<string, unknown> | null,
  includeOrder: boolean
) {
  const assignments: string[] = [];
  const vals: unknown[] = [];
  const changedFieldIds = new Set<number>();
  if (includeOrder) {
    const value = orderValue(snapshot) ?? values.order;
    if (value !== undefined) {
      assignments.push("[order]=?");
      vals.push(value);
    }
  }
  for (const field of fields) {
    const value = await storageValue(env, field, values, snapshot);
    if (value === undefined) continue;
    assignments.push(`"field_${field.id}"=?`);
    vals.push(value);
    changedFieldIds.add(field.id);
  }
  assignments.push("_updated_on=?", "_last_modified_by_id=?");
  vals.push(new Date().toISOString(), user.id, rowId);
  await ensureUserTableSystemColumns(env.DB, tableId);
  await env.DB.prepare(
    `UPDATE "database_table_${tableId}" SET ${assignments.join(", ")} WHERE id=? AND COALESCE(trashed, 0)=0`
  ).bind(...vals).run();
  await applyDateDependencyRules(env.DB, tableId, rowId, changedFieldIds);
  return Array.from(changedFieldIds);
}

/**
 * Undoing a row creation (or redoing a deletion) trashes the row like a
 * normal delete, as Baserow does: it stays restorable from the trash and the
 * rows it linked to drop it from their reciprocal cells.
 */
async function deleteRow(env: Env, user: RequestUser, meta: TableMeta, tableId: number, rowId: number, fields: FieldMeta[]) {
  await ensureUserTableSystemColumns(env.DB, tableId);
  const [row, table] = await Promise.all([
    env.DB.prepare(`SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`).bind(rowId).first<Record<string, unknown>>(),
    env.DB.prepare("SELECT name FROM database_table WHERE id=?").bind(tableId).first<{ name: string }>(),
  ]);
  if (!row) return;
  await env.DB.prepare(`UPDATE "database_table_${tableId}" SET trashed=1, _updated_on=?, _last_modified_by_id=? WHERE id=?`)
    .bind(new Date().toISOString(), user.id, rowId)
    .run();
  const primary = fields.find((field) => field.primary) || fields[0];
  const name = primary ? String(row[`field_${primary.id}`] ?? `Row ${rowId}`) : `Row ${rowId}`;
  await recordTrashEntry(env.DB, {
    userId: user.id,
    workspaceId: meta.workspace_id,
    applicationId: meta.database_id,
    trashItemType: "row",
    trashItemId: rowId,
    parentTrashItemId: tableId,
    name,
    names: [name],
    parentName: table?.name || "",
    extra: { row },
  });
  await synchronizeLinkRowRelations(env.DB, tableId, rowId, row, null, null);
}

function parseActionParams(action: HistoryAction): Record<string, unknown> {
  return parseObject(action.params);
}

function snapshotRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const item = record[key];
  return item && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown>
    : null;
}

async function tableMetaForView(db: D1Database, viewSnapshot: Record<string, unknown> | null) {
  const tableId = Number(viewSnapshot?.table_id || 0);
  if (!tableId) return null;
  return tableMeta(db, tableId);
}

async function tableMetaForField(db: D1Database, fieldSnapshot: Record<string, unknown> | null) {
  const tableId = Number(fieldSnapshot?.table_id || 0);
  if (!tableId) return null;
  return tableMeta(db, tableId);
}

async function serializedView(env: Env, viewId: number) {
  const view = await env.DB.prepare("SELECT * FROM database_view WHERE id=?")
    .bind(viewId)
    .first<Record<string, unknown>>();
  if (!view) return null;
  return serializeViewForUndoRedo(env.DB, view, env.PUBLIC_URL);
}

async function restoreViewState(env: Env, snapshot: Record<string, unknown>) {
  const view = snapshotRecord(snapshot, "view");
  if (!view) throw new Error("View snapshot is missing.");
  await restoreViewStateForUndoRedo(env.DB, snapshot);
}

async function trashViewFromSnapshot(env: Env, user: RequestUser, snapshot: Record<string, unknown>) {
  const view = snapshotRecord(snapshot, "view");
  if (!view) throw new Error("View snapshot is missing.");
  const meta = await tableMetaForView(env.DB, view);
  if (!meta) throw new Error("View parent table is missing.");
  const viewId = Number(view.id);
  const tableId = Number(view.table_id);
  const table = await env.DB.prepare("SELECT name FROM database_table WHERE id=?")
    .bind(tableId)
    .first<{ name: string }>();
  await recordTrashEntry(env.DB, {
    userId: user.id,
    workspaceId: meta.workspace_id,
    applicationId: meta.database_id,
    trashItemType: "view",
    trashItemId: viewId,
    name: String(view.name || ""),
    parentName: table?.name || "",
  });
  await env.DB.prepare("UPDATE database_view SET trashed=1, updated_on=? WHERE id=?")
    .bind(new Date().toISOString(), viewId)
    .run();
  return { meta, viewId, tableId };
}

async function untrashViewFromSnapshot(env: Env, snapshot: Record<string, unknown>) {
  const view = snapshotRecord(snapshot, "view");
  if (!view) throw new Error("View snapshot is missing.");
  const meta = await tableMetaForView(env.DB, view);
  if (!meta) throw new Error("View parent table is missing.");
  const viewId = Number(view.id);
  const tableId = Number(view.table_id);
  await restoreViewState(env, snapshot);
  await env.DB.prepare("UPDATE database_view SET trashed=0, updated_on=? WHERE id=?")
    .bind(new Date().toISOString(), viewId)
    .run();
  await deleteTrashEntry(env.DB, "view", viewId, null);
  return { meta, viewId, tableId };
}

async function trashFieldFromSnapshot(
  env: Env,
  user: RequestUser,
  snapshot: Record<string, unknown>,
  applySnapshot: boolean
) {
  const field = snapshotRecord(snapshot, "field");
  if (!field) throw new Error("Field snapshot is missing.");
  const meta = await tableMetaForField(env.DB, field);
  if (!meta) throw new Error("Field parent table is missing.");
  if (applySnapshot) await restoreFieldStateForUndoRedo(env.DB, snapshot);
  const fieldId = Number(field.id);
  const tableId = Number(field.table_id);
  const table = await env.DB.prepare("SELECT name FROM database_table WHERE id=?")
    .bind(tableId)
    .first<{ name: string }>();
  await recordTrashEntry(env.DB, {
    userId: user.id,
    workspaceId: meta.workspace_id,
    applicationId: meta.database_id,
    trashItemType: "field",
    trashItemId: fieldId,
    name: String(field.name || ""),
    parentName: table?.name || "",
  });
  await env.DB.prepare("UPDATE database_field SET trashed=1, updated_on=? WHERE id=?")
    .bind(new Date().toISOString(), fieldId)
    .run();
  return { meta, fieldId, tableId };
}

async function untrashFieldFromSnapshot(env: Env, snapshot: Record<string, unknown>) {
  const field = snapshotRecord(snapshot, "field");
  if (!field) throw new Error("Field snapshot is missing.");
  const meta = await tableMetaForField(env.DB, field);
  if (!meta) throw new Error("Field parent table is missing.");
  const fieldId = Number(field.id);
  const tableId = Number(field.table_id);
  await restoreFieldStateForUndoRedo(env.DB, snapshot);
  await env.DB.prepare("UPDATE database_field SET trashed=0, updated_on=? WHERE id=?")
    .bind(new Date().toISOString(), fieldId)
    .run();
  await deleteTrashEntry(env.DB, "field", fieldId, null);
  return { meta, fieldId, tableId };
}

async function broadcastFieldCreated(
  env: Env,
  meta: TableMeta,
  fieldId: number,
  tableId: number,
  websocketId: string
) {
  const field = await serializeFieldForUndoRedo(env.DB, fieldId);
  await broadcastToWorkspace(env, meta.workspace_id, {
    type: "field_created",
    field,
    table_id: tableId,
  }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
}

async function broadcastFieldDeleted(
  env: Env,
  meta: TableMeta,
  fieldId: number,
  tableId: number,
  relatedFields: unknown[],
  websocketId: string
) {
  await broadcastToWorkspace(env, meta.workspace_id, {
    type: "field_deleted",
    field_id: fieldId,
    table_id: tableId,
    related_fields: relatedFields,
  }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
}

async function restoreUpdatedFieldState(
  env: Env,
  snapshot: Record<string, unknown>,
  websocketId: string
) {
  const fieldSnapshot = snapshotRecord(snapshot, "field");
  if (!fieldSnapshot) throw new Error("Field snapshot is missing.");
  const meta = await tableMetaForField(env.DB, fieldSnapshot);
  if (!meta) throw new Error("Field parent table is missing.");
  await restoreFieldStateForUndoRedo(env.DB, snapshot);
  const fieldId = Number(fieldSnapshot.id);
  const tableId = Number(fieldSnapshot.table_id);
  const field = await serializeFieldForUndoRedo(env.DB, fieldId);
  const relatedFields = await serializeRelatedFieldsForUndoRedo(env.DB, snapshot, fieldId);
  const payload = field && typeof field === "object"
    ? { ...field as Record<string, unknown>, related_fields: relatedFields }
    : field;
  await broadcastToWorkspace(env, meta.workspace_id, {
    type: "field_updated",
    field: payload,
    table_id: tableId,
    related_fields: relatedFields,
  }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
}

type FieldOrder = { id: number; order: number };

function fieldOrdersFromParams(params: Record<string, unknown>, direction: Direction): FieldOrder[] {
  const tableId = Number(params.table_id);
  const orders = params[direction === "undo" ? "before_orders" : "after_orders"];
  if (Array.isArray(orders)) {
    return orders
      .map((item) => ({ id: Number((item as FieldOrder)?.id), order: Number((item as FieldOrder)?.order) }))
      .filter((item) => Number.isInteger(item.id) && item.id > 0 && Number.isFinite(item.order));
  }
  // Actions recorded before orders were stored keep a full field snapshot.
  const snapshot = snapshotRecord(params, direction === "undo" ? "before" : "after");
  const fields = Array.isArray(snapshot?.database_fields) ? snapshot!.database_fields as Array<Record<string, unknown>> : [];
  return fields
    .filter((field) => Number(field.table_id) === tableId)
    .map((field) => ({ id: Number(field.id), order: Number(field.order) }))
    .filter((item) => Number.isInteger(item.id) && item.id > 0 && Number.isFinite(item.order));
}

async function replayFieldOrder(env: Env, params: Record<string, unknown>, direction: Direction, websocketId: string) {
  const tableId = Number(params.table_id);
  const orders = fieldOrdersFromParams(params, direction);
  if (!tableId || orders.length === 0) throw new Error("Order fields action is missing its field orders.");
  const meta = await tableMeta(env.DB, tableId);
  if (!meta) throw new Error(`Table ${tableId} does not exist.`);
  const statements = orders.map((item) => env.DB.prepare(
    "UPDATE database_field SET [order]=? WHERE id=? AND table_id=?"
  ).bind(item.order, item.id, tableId));
  for (let index = 0; index < statements.length; index += 80) {
    await env.DB.batch(statements.slice(index, index + 80));
  }
  for (const item of orders) {
    const field = await serializeFieldForUndoRedo(env.DB, item.id);
    if (!field) continue;
    await broadcastToWorkspace(env, meta.workspace_id, {
      type: "field_updated",
      field,
      table_id: tableId,
      related_fields: [],
    }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
  }
}

const FIELD_ACTIONS = new Set(["create_field", "duplicate_field", "delete_field", "update_field", "change_primary_field", "order_fields"]);
const VIEW_ACTIONS = new Set(["create_view", "delete_view", "update_view"]);
const AUTOMATION_ACTIONS = new Set([
  "create_automation_node",
  "update_automation_node",
  "delete_automation_node",
  "duplicate_automation_node",
  "replace_automation_node",
  "move_automation_node",
  "create_automation_workflow",
  "update_automation_workflow",
  "delete_automation_workflow",
  "duplicate_automation_workflow",
  "order_automation_workflows",
]);

function scopeId(action: HistoryAction, prefix: string): number | null {
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(action.action_scope || "");
  return match ? Number(match[1]) : null;
}

/**
 * Undo/redo replays a past action as the current user, so the user needs the
 * role that action requires today on every table it touches, like Baserow
 * re-running the action type's permission checks.
 */
async function assertCanReplayCoreAction(
  env: Env,
  user: RequestUser,
  action: HistoryAction,
  params: Record<string, unknown>,
  snapshots: Array<Record<string, unknown> | null>
) {
  const type = action.action_type;
  if (FIELD_ACTIONS.has(type) || VIEW_ACTIONS.has(type)) {
    const recordKey = FIELD_ACTIONS.has(type) ? "field" : "view";
    const records = snapshots.map((snapshot) => snapshotRecord(snapshot, recordKey)).filter((record) => record !== null);
    const tableIds = new Set<number>();
    const scopedTableId = scopeId(action, "table");
    if (scopedTableId) tableIds.add(scopedTableId);
    if (Number(params.table_id) > 0) tableIds.add(Number(params.table_id));
    for (const record of records) {
      if (Number(record.table_id) > 0) tableIds.add(Number(record.table_id));
    }
    if (tableIds.size === 0) throw new Error(`Action ${type} has no table scope.`);

    let role = "BUILDER";
    const personalView = VIEW_ACTIONS.has(type) ? records.find((record) => record.ownership_type === "personal") : undefined;
    if (personalView) {
      if (Number(personalView.owned_by_id) !== user.id) throw new Error("The user does not own this personal view.");
      role = "VIEWER";
    }
    for (const tableId of tableIds) {
      const meta = await tableMeta(env.DB, tableId);
      if (!meta) throw new Error(`Table ${tableId} does not exist.`);
      await assertHasTableRole(env.DB, user.id, meta, role);
    }
    return;
  }
  if (AUTOMATION_ACTIONS.has(type)) {
    const applicationIds = new Set<number>();
    const scopedApplicationId = scopeId(action, "application");
    if (scopedApplicationId) applicationIds.add(scopedApplicationId);
    if (Number(params.automation_id) > 0) applicationIds.add(Number(params.automation_id));
    for (const snapshot of snapshots) {
      const workflow = snapshotRecord(snapshot, "workflow");
      if (Number(workflow?.automation_id) > 0) applicationIds.add(Number(workflow!.automation_id));
    }
    if (applicationIds.size === 0) throw new Error(`Action ${type} has no application scope.`);
    for (const applicationId of applicationIds) {
      await assertHasApplicationRole(env.DB, user.id, applicationId, "BUILDER");
    }
  }
}

async function applyCoreAction(
  env: Env,
  user: RequestUser,
  action: HistoryAction,
  direction: Direction,
  websocketId: string
) {
  const params = parseActionParams(action);
  const before = snapshotRecord(params, "before");
  const after = snapshotRecord(params, "after");
  await assertCanReplayCoreAction(env, user, action, params, [before, after]);
  if (action.action_type === "order_fields") {
    await replayFieldOrder(env, params, direction, websocketId);
    return;
  }
  if (new Set([
    "create_automation_node",
    "update_automation_node",
    "delete_automation_node",
    "duplicate_automation_node",
    "replace_automation_node",
    "move_automation_node",
    "create_automation_workflow",
    "update_automation_workflow",
    "delete_automation_workflow",
    "duplicate_automation_workflow",
  ]).has(action.action_type)) {
    const target = (direction === "undo" ? before : after) as AutomationWorkflowSnapshot | null;
    const alternate = (direction === "undo" ? after : before) as AutomationWorkflowSnapshot | null;
    if (!target && !alternate) throw new Error("Automation action is missing its workflow snapshot.");
    const reference = target || alternate!;
    const current = await snapshotAutomationWorkflow(env.DB, Number(reference.workflow.id));
    const meta = await restoreAutomationWorkflowSnapshot(env.DB, target, alternate || target!, user.id, {
      restorePublishedVersions: action.action_type === "update_automation_workflow",
    });
    const restored = await snapshotAutomationWorkflow(env.DB, meta.workflowId);
    if (!restored) throw new Error("Automation workflow could not be restored.");
    const previousActive = new Set((current?.nodes || []).filter((node) => !node.trashed).map((node) => Number(node.id)));
    const restoredActive = new Set(restored.nodes.filter((node) => !node.trashed).map((node) => Number(node.id)));
    for (const nodeId of previousActive) {
      if (!restoredActive.has(nodeId)) {
        await broadcastToWorkspace(env, meta.workspaceId, {
          type: "automation_node_deleted",
          workflow_id: meta.workflowId,
          node_id: nodeId,
        });
      }
    }
    for (const node of restored.nodes.filter((item) => !item.trashed)) {
      await broadcastToWorkspace(env, meta.workspaceId, {
        type: previousActive.has(Number(node.id)) ? "automation_node_updated" : "automation_node_created",
        node: await serializeNode(env.DB, node),
      });
    }
    const wasWorkflowActive = Boolean(current && !current.workflow.trashed);
    const isWorkflowActive = !restored.workflow.trashed;
    if (wasWorkflowActive && !isWorkflowActive) {
      await broadcastToWorkspace(env, meta.workspaceId, {
        type: "automation_workflow_deleted",
        automation_id: meta.automationId,
        workflow_id: meta.workflowId,
      });
    } else if (!wasWorkflowActive && isWorkflowActive) {
      await broadcastToWorkspace(env, meta.workspaceId, {
        type: "automation_workflow_created",
        workflow: serializeWorkflow(restored.workflow, restored.published_workflows.at(-1)),
      });
    } else if (isWorkflowActive) {
      await broadcastToWorkspace(env, meta.workspaceId, {
        type: "automation_workflow_updated",
        workflow: serializeWorkflow(restored.workflow, restored.published_workflows.at(-1)),
      });
    }
    return;
  }
  if (action.action_type === "order_automation_workflows") {
    const automationId = Number(params.automation_id);
    const order = direction === "undo" ? params.before_order : params.after_order;
    if (!Array.isArray(order)) throw new Error("Automation workflow order action is missing its order.");
    const application = await env.DB.prepare(
      "SELECT workspace_id FROM core_application WHERE id=? AND type='automation' AND trashed=0"
    ).bind(automationId).first<{ workspace_id: number }>();
    if (!application) throw new Error(`Automation ${automationId} does not exist.`);
    await assertHasApplicationRole(env.DB, user.id, automationId, "BUILDER");
    const statements = order.map((workflowId, index) => env.DB.prepare(
      "UPDATE automation_workflow SET [order]=?, updated_on=? WHERE id=? AND automation_id=? AND trashed=0"
    ).bind(index + 1, new Date().toISOString(), Number(workflowId), automationId));
    for (let index = 0; index < statements.length; index += 80) {
      await env.DB.batch(statements.slice(index, index + 80));
    }
    for (const workflowId of order) {
      const workflow = await env.DB.prepare("SELECT * FROM automation_workflow WHERE id=? AND trashed=0")
        .bind(Number(workflowId)).first<any>();
      if (workflow) await broadcastToWorkspace(env, application.workspace_id, {
        type: "automation_workflow_updated",
        workflow: serializeWorkflow(workflow),
      });
    }
    return;
  }
  if (action.action_type === "create_view") {
    if (!after) throw new Error("Create view action is missing its snapshot.");
    if (direction === "undo") {
      const { meta, viewId, tableId } = await trashViewFromSnapshot(env, user, after);
      await broadcastToWorkspace(env, meta.workspace_id, {
        type: "view_deleted",
        view_id: viewId,
        table_id: tableId,
      }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
    } else {
      const { meta, viewId, tableId } = await untrashViewFromSnapshot(env, after);
      const view = await serializedView(env, viewId);
      await broadcastToWorkspace(env, meta.workspace_id, {
        type: "view_created",
        view,
        table_id: tableId,
      }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
    }
    return;
  }

  if (action.action_type === "delete_view") {
    if (!before) throw new Error("Delete view action is missing its snapshot.");
    if (direction === "undo") {
      const { meta, viewId, tableId } = await untrashViewFromSnapshot(env, before);
      const view = await serializedView(env, viewId);
      await broadcastToWorkspace(env, meta.workspace_id, {
        type: "view_created",
        view,
        table_id: tableId,
      }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
    } else {
      const { meta, viewId, tableId } = await trashViewFromSnapshot(env, user, before);
      await broadcastToWorkspace(env, meta.workspace_id, {
        type: "view_deleted",
        view_id: viewId,
        table_id: tableId,
      }, { excludeWebsocketId: websocketId, pageFilter: `table-${tableId}` });
    }
    return;
  }

  if (action.action_type === "update_view") {
    const snapshot = direction === "undo" ? before : after;
    if (!snapshot) throw new Error("Update view action is missing its snapshot.");
    await restoreViewState(env, snapshot);
    const viewSnapshot = snapshotRecord(snapshot, "view");
    const meta = await tableMetaForView(env.DB, viewSnapshot);
    if (!meta || !viewSnapshot) throw new Error("View parent table is missing.");
    const view = await serializedView(env, Number(viewSnapshot.id));
    await broadcastToWorkspace(env, meta.workspace_id, {
      type: "view_updated",
      view,
    }, { excludeWebsocketId: websocketId, pageFilter: `table-${Number(viewSnapshot.table_id)}` });
    return;
  }

  if (action.action_type === "create_field" || action.action_type === "duplicate_field") {
    if (!after) throw new Error("Create field action is missing its snapshot.");
    if (direction === "undo") {
      const { meta, fieldId, tableId } = await trashFieldFromSnapshot(env, user, after, false);
      await broadcastFieldDeleted(env, meta, fieldId, tableId, [], websocketId);
    } else {
      const { meta, fieldId, tableId } = await untrashFieldFromSnapshot(env, after);
      await broadcastFieldCreated(env, meta, fieldId, tableId, websocketId);
    }
    return;
  }

  if (action.action_type === "delete_field") {
    if (!before) throw new Error("Delete field action is missing its snapshot.");
    if (direction === "undo") {
      const { meta, fieldId, tableId } = await untrashFieldFromSnapshot(env, before);
      await broadcastFieldCreated(env, meta, fieldId, tableId, websocketId);
    } else {
      const snapshot = after || before;
      const { meta, fieldId, tableId } = await trashFieldFromSnapshot(env, user, snapshot, Boolean(after));
      const relatedFields = after ? await serializeRelatedFieldsForUndoRedo(env.DB, after, fieldId) : [];
      await broadcastFieldDeleted(env, meta, fieldId, tableId, relatedFields, websocketId);
    }
    return;
  }

  if (
    action.action_type === "update_field" ||
    action.action_type === "change_primary_field"
  ) {
    const snapshot = direction === "undo" ? before : after;
    if (!snapshot) throw new Error("Update field action is missing its snapshot.");
    await restoreUpdatedFieldState(env, snapshot, websocketId);
    return;
  }

  throw new Error(`Action ${action.action_type} cannot be replayed.`);
}

async function applyHistoryAction(
  env: Env,
  user: RequestUser,
  action: HistoryAction,
  direction: Direction,
  websocketId: string
) {
  if (action.source === "core") {
    await applyCoreAction(env, user, action, direction, websocketId);
    return;
  }
  const tableId = Number(action.table_id);
  const rowId = Number(action.row_id);
  const meta = await tableMeta(env.DB, tableId);
  if (!meta) throw new Error(`Table ${action.table_id} does not exist.`);
  await assertHasTableRole(env.DB, user.id, meta, "EDITOR");
  const fields = await getActiveFields(env.DB, tableId);
  const before = parseObject(action.before_values);
  const after = parseObject(action.after_values);
  const beforeRow = metadataRow(action, "before_row");
  const afterRow = metadataRow(action, "after_row");
  const type = action.action_type;

  if (type === "create_row" || type === "create_rows") {
    if (direction === "undo") {
      const row = await rowForBroadcast(env, tableId, rowId, fields, afterRow);
      await deleteRow(env, user, meta, tableId, rowId, fields);
      await broadcastRowsDeleted(env, meta, tableId, row ? [row] : [], [rowId], websocketId);
    } else {
      await restoreRow(env, user, tableId, rowId, fields, after, afterRow);
      const row = await rowForBroadcast(env, tableId, rowId, fields, afterRow);
      await broadcastRowsCreated(env, meta, tableId, row ? [row] : [], websocketId);
    }
    return;
  }

  if (type === "delete_row" || type === "delete_rows") {
    if (direction === "undo") {
      await restoreRow(env, user, tableId, rowId, fields, before, beforeRow);
      const row = await rowForBroadcast(env, tableId, rowId, fields, beforeRow);
      await broadcastRowsCreated(env, meta, tableId, row ? [row] : [], websocketId);
    } else {
      const row = await rowForBroadcast(env, tableId, rowId, fields, beforeRow);
      await deleteRow(env, user, meta, tableId, rowId, fields);
      await broadcastRowsDeleted(env, meta, tableId, row ? [row] : [], [rowId], websocketId);
    }
    return;
  }

  if (type === "move_row") {
    const values = direction === "undo" ? before : after;
    const snapshot = direction === "undo" ? beforeRow : afterRow;
    const updatedFieldIds = await updateRowValues(env, user, tableId, rowId, fields, values, snapshot, true);
    const row = await rowForBroadcast(env, tableId, rowId, fields, snapshot);
    await broadcastRowsUpdated(env, meta, tableId, row ? [row] : [], updatedFieldIds, websocketId);
    return;
  }

  if (type === "update_row" || type === "update_rows") {
    const values = direction === "undo" ? before : after;
    const snapshot = direction === "undo" ? beforeRow : afterRow;
    const updatedFieldIds = await updateRowValues(env, user, tableId, rowId, fields, values, snapshot, false);
    const row = await rowForBroadcast(env, tableId, rowId, fields, snapshot);
    await broadcastRowsUpdated(env, meta, tableId, row ? [row] : [], updatedFieldIds, websocketId);
    return;
  }

  throw new Error(`Action ${type} cannot be replayed.`);
}

async function markActions(
  db: D1Database,
  actions: HistoryAction[],
  direction: Direction,
  error: string | null
) {
  if (actions.length === 0) return;
  const ids = actions.map((action) => action.id);
  const bindMarks = ids.map(() => "?").join(",");
  const table = actions[0]?.source === "core" ? "core_action" : "database_rowhistory";
  if (direction === "undo") {
    await db.prepare(
      `UPDATE ${table}
       SET undone_at=?, action_command_type='UNDO', error=?
       WHERE id IN (${bindMarks})`
    ).bind(new Date().toISOString(), error, ...ids).run();
  } else {
    await db.prepare(
      `UPDATE ${table}
       SET undone_at=NULL, action_command_type='REDO', error=?
       WHERE id IN (${bindMarks})`
    ).bind(error, ...ids).run();
  }
}

async function executeUndoRedo(
  env: Env,
  user: RequestUser,
  direction: Direction,
  scopesInput: unknown,
  session: string,
  websocketId: string
): Promise<UndoRedoResponse> {
  if (!session) return NOTHING_TO_DO;
  const scopes = scopeTokens(scopesInput);
  let latest: HistoryAction | null = null;
  try {
    latest = await latestAction(env.DB, user, session, scopes, direction);
  } catch (error: any) {
    if (String(error?.message || error).includes("database_rowhistory")) return NOTHING_TO_DO;
    throw error;
  }
  if (!latest) return NOTHING_TO_DO;
  if (direction === "redo" && latest.undone_at && await normalActionHappenedAfterUndo(env.DB, user, session, latest.undone_at)) {
    return NOTHING_TO_DO;
  }

  const actions = await groupedActions(env.DB, latest, scopes, direction);
  if (actions.length === 0) return NOTHING_TO_DO;
  try {
    for (const action of actions) {
      await applyHistoryAction(env, user, action, direction, websocketId);
    }
    await markActions(env.DB, actions, direction, null);
    return {
      actions: actions.map(actionPayload),
      result_code: "SUCCESS",
    };
  } catch (error: any) {
    await markActions(env.DB, actions, direction, String(error?.message || error));
    return {
      actions: actions.map(actionPayload),
      result_code: "SKIPPED_DUE_TO_ERROR",
    };
  }
}

export function undoUserAction(
  env: Env,
  user: RequestUser,
  scopes: unknown,
  session: string,
  websocketId = ""
) {
  return executeUndoRedo(env, user, "undo", scopes, session, websocketId);
}

export function redoUserAction(
  env: Env,
  user: RequestUser,
  scopes: unknown,
  session: string,
  websocketId = ""
) {
  return executeUndoRedo(env, user, "redo", scopes, session, websocketId);
}
