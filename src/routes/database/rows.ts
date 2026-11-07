import { Hono, type Context } from "hono";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware, databaseTokenAllows, databaseTokenAuthMiddleware, optionalAuthMiddleware } from "../../middleware/auth";
import { DoesNotExist, PermissionError, ValidationError } from "../../middleware/error";
import { broadcastToWorkspace } from "../../durable-objects/workspace-room";
import { templateWorkspaceSql } from "../../services/templates";
import {
  chunkIds,
  ensureUserTableSystemColumns,
  selectActiveRowsByIds,
  serializeFieldValueForInsert,
  type FieldMeta,
} from "../../services/dynamic-tables";
import { LinkTargetCache, serializeFieldValueForStorage } from "../../services/field-values";
import { synchronizeLinkRowRelations, synchronizeLinkRowRelationsBatch } from "../../services/link-row-relations";
import { applyFilters, type FilterSpec } from "../../services/row-filters";
import {
  formulaFromSettings,
  linkedRowIds,
  parseFieldSettings,
  RowReadContext,
  serializeRowWithComputedFields,
  serializeRowsWithComputedFields,
} from "../../services/computed-fields";
import { isReadOnlyFieldType } from "../../services/field-serialization";
import { rowsEnteredWebhookViewIds, triggerTableWebhooks } from "./webhooks";
import { queryViewRows } from "../../services/view-query";
import { triggerBuilderTableWorkflows } from "../../services/builder";
import { triggerAutomationTableWorkflows } from "../../services/automation";
import { applyDateDependencyRules, hasActiveDateDependencyRules } from "../../services/field-rules";
import { notifyNewCollaborators } from "../../services/row-write-effects";
import { enqueueAutomaticAIUpdates } from "../../services/ai-auto-update";
import {
  changedRowValues,
  createRowHistoryEntry,
  rowFieldValues,
  serializeRowHistoryEntry,
} from "../../services/row-history";
import { logAuditEntry } from "../../services/audit-log";
import { recordTrashEntry, trashEntryStatements, type RecordTrashEntryOptions } from "../../services/trash";
import { buildRowMetadata } from "../../services/row-metadata";
import { assertCanWriteFieldValues, assertHasTableRole } from "../../services/enterprise-permissions";
import {
  pushPostgresqlTwoWayRowsCreated,
  pushPostgresqlTwoWayRowsDeleted,
  pushPostgresqlTwoWayRowsUpdated,
} from "../../services/data-sync";
import { allocateAutonumberRanges, allocateAutonumberValues } from "../../services/autonumber";
import { fieldDefaultInputValue, missingCreateFieldValues } from "../../services/row-create-values";
import {
  collectUserFileNamesFromRecord,
  scheduleUnreferencedUserFilesForDeletion,
} from "../../services/user-files";

const rows = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

// ── Shared helpers ────────────────────────────────────────────────────────────

function activeRowClause(tableName?: string): string {
  return tableName ? `COALESCE("${tableName}".trashed, 0)=0` : "COALESCE(trashed, 0)=0";
}

async function getTableMeta(db: D1Database, tableId: number) {
  return db.prepare(
    `SELECT t.id, t.database_id, a.workspace_id, ${templateWorkspaceSql("a.workspace_id")} AS is_template
     FROM database_table t JOIN core_application a ON a.id = t.database_id
     WHERE t.id = ? AND t.trashed = 0`
  ).bind(tableId).first<{ id: number; database_id: number; workspace_id: number; is_template: number }>();
}

async function getTableAuditContext(db: D1Database, tableId: number) {
  return db.prepare(
    `SELECT t.name AS table_name, a.workspace_id, w.name AS workspace_name
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     JOIN core_workspace w ON w.id=a.workspace_id
     WHERE t.id=?`
  ).bind(tableId).first<{ table_name: string; workspace_id: number; workspace_name: string }>();
}

function rowTrashEntryOptions(
  tableId: number,
  workspaceId: number,
  applicationId: number,
  userId: number,
  row: Record<string, unknown>,
  fields: FieldMeta[],
  tableName: string
): RecordTrashEntryOptions {
  const primary = fields.find((field) => field.primary) || fields[0];
  const name = primary ? String(row[`field_${primary.id}`] ?? `Row ${row.id}`) : `Row ${row.id}`;
  return {
    userId,
    workspaceId,
    applicationId,
    trashItemType: "row",
    trashItemId: Number(row.id),
    parentTrashItemId: tableId,
    name,
    names: [name],
    parentName: tableName,
    extra: { row },
  };
}

async function recordRowTrash(
  db: D1Database,
  tableId: number,
  workspaceId: number,
  applicationId: number,
  userId: number,
  row: Record<string, unknown>,
  fields: FieldMeta[]
) {
  const table = await db.prepare("SELECT name FROM database_table WHERE id=?")
    .bind(tableId)
    .first<{ name: string }>();
  await recordTrashEntry(db, rowTrashEntryOptions(tableId, workspaceId, applicationId, userId, row, fields, table?.name || ""));
}

function clientIp(c: any) {
  return c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || null;
}

function rowHistoryActionContext(c: any, tableId: number) {
  return {
    session: c.get("client_session_id") || "",
    actionGroup: c.req.header("ClientUndoRedoActionGroupId") || null,
    actionScope: `table${tableId}`,
  };
}

async function triggerRowSideEffects(env: Env, tableId: number, eventType: string, payload: Record<string, unknown>) {
  await Promise.all([
    triggerTableWebhooks(env, tableId, eventType, payload),
    triggerBuilderTableWorkflows(env, tableId, eventType, payload),
    triggerAutomationTableWorkflows(env, tableId, eventType, payload),
  ]);
}

function parseLinkedRowIds(value: unknown): Set<number> {
  if (value === null || value === undefined || value === "") return new Set();
  const parsed = typeof value === "string"
    ? (() => {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    })()
    : value;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return new Set(values
    .map((item) => {
      if (typeof item === "number") return item;
      if (typeof item === "string" && item.trim() !== "") return Number(item);
      if (item && typeof item === "object") return Number((item as Record<string, unknown>).id);
      return NaN;
    })
    .filter((id) => Number.isInteger(id) && id > 0));
}

function changedLinkedRowIds(before: unknown, after: unknown): number[] {
  const beforeIds = parseLinkedRowIds(before);
  const afterIds = parseLinkedRowIds(after);
  const changed = new Set<number>();
  for (const id of beforeIds) {
    if (!afterIds.has(id)) changed.add(id);
  }
  for (const id of afterIds) {
    if (!beforeIds.has(id)) changed.add(id);
  }
  return [...changed];
}

async function sourceLinksForRelatedRow(
  db: D1Database,
  sourceTableId: number,
  sourceFields: FieldMeta[],
  sourceLinkField: FieldMeta,
  relatedRowId: number
): Promise<Array<{ id: number; value: string; order: unknown }>> {
  const primary = sourceFields.find((field) => field.primary) || sourceFields[0];
  if (!primary) return [];
  await ensureUserTableSystemColumns(db, sourceTableId);
  const sourceRows = await db.prepare(
    `SELECT id, [order] AS order_value, "field_${primary.id}" AS value, "field_${sourceLinkField.id}" AS link_value
     FROM "database_table_${sourceTableId}"
     WHERE ${activeRowClause()} AND "field_${sourceLinkField.id}" IS NOT NULL AND "field_${sourceLinkField.id}" != ''`
  ).all<Record<string, unknown>>();

  return (sourceRows.results || [])
    .filter((row) => parseLinkedRowIds(row.link_value).has(relatedRowId))
    .map((row) => ({
      id: Number(row.id),
      value: String(row.value ?? ""),
      order: row.order_value ?? 10000,
    }));
}

async function relatedWebhookRows(
  db: D1Database,
  sourceTableId: number,
  sourceFields: FieldMeta[],
  links: Array<{ sourceLinkField: FieldMeta; relatedFieldId: number }>,
  relatedTableId: number,
  relatedRowIds: number[]
): Promise<Record<string, unknown>[]> {
  if (relatedRowIds.length === 0) return [];
  await ensureUserTableSystemColumns(db, relatedTableId);
  const relatedFields = await getActiveFields(db, relatedTableId);
  const bindMarks = relatedRowIds.map(() => "?").join(", ");
  const rowsResult = await db.prepare(
    `SELECT * FROM "database_table_${relatedTableId}" WHERE ${activeRowClause()} AND id IN (${bindMarks})`
  ).bind(...relatedRowIds).all<Record<string, unknown>>();
  const order = new Map(relatedRowIds.map((id, index) => [id, index]));
  const rows = (rowsResult.results || [])
    .sort((left, right) => (order.get(Number(left.id)) ?? 0) - (order.get(Number(right.id)) ?? 0));

  for (const row of rows) {
    for (const link of links) {
      row[`field_${link.relatedFieldId}`] = await sourceLinksForRelatedRow(
        db,
        sourceTableId,
        sourceFields,
        link.sourceLinkField,
        Number(row.id)
      );
    }
  }

  return serializeRowsWithNames(db, rows, relatedFields, true);
}

function relatedWebhookBatchSize(env: Env): number {
  const value = Number(env.BATCH_ROWS_SIZE_LIMIT || 200);
  if (!Number.isFinite(value) || value < 1) return 200;
  return Math.min(Math.floor(value), 1000);
}

async function triggerRelatedTableRowUpdateWebhooks(
  env: Env,
  sourceTableId: number,
  sourceFields: FieldMeta[],
  changes: Array<{
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    updatedFieldIds?: Set<number> | null;
  }>
) {
  const impacted = new Map<number, {
    links: Map<number, FieldMeta>;
    relatedFieldIds: Set<number>;
    rowIds: Set<number>;
  }>();

  for (const field of sourceFields) {
    if (field.type !== "link_row") continue;
    const relatedTableId = Number(field.settings?.link_row_table_id || 0);
    const relatedFieldId = Number(field.settings?.link_row_related_field_id || 0);
    if (!relatedTableId || !relatedFieldId || relatedTableId === sourceTableId) continue;

    for (const change of changes) {
      if (change.updatedFieldIds && !change.updatedFieldIds.has(field.id)) continue;
      const changedIds = changedLinkedRowIds(
        change.before?.[`field_${field.id}`],
        change.after?.[`field_${field.id}`]
      );
      if (changedIds.length === 0) continue;
      const entry = impacted.get(relatedTableId) || {
        links: new Map<number, FieldMeta>(),
        relatedFieldIds: new Set<number>(),
        rowIds: new Set<number>(),
      };
      entry.links.set(relatedFieldId, field);
      entry.relatedFieldIds.add(relatedFieldId);
      changedIds.forEach((id) => entry.rowIds.add(id));
      impacted.set(relatedTableId, entry);
    }
  }

  await Promise.all([...impacted.entries()].map(async ([relatedTableId, entry]) => {
    const rowIds = [...entry.rowIds];
    if (rowIds.length === 0) return;
    const batchSize = relatedWebhookBatchSize(env);
    const eventId = crypto.randomUUID();
    for (let offset = 0, batchId = 1; offset < rowIds.length; offset += batchSize, batchId += 1) {
      const batchRowIds = rowIds.slice(offset, offset + batchSize);
      const items = await relatedWebhookRows(
        env.DB,
        sourceTableId,
        sourceFields,
        [...entry.links.entries()].map(([relatedFieldId, sourceLinkField]) => ({ relatedFieldId, sourceLinkField })),
        relatedTableId,
        batchRowIds
      );
      if (items.length === 0) continue;
      const paginated = rowIds.length > batchSize;
      await triggerTableWebhooks(env, relatedTableId, "rows.updated", {
        event_id: eventId,
        items,
        updated_field_ids: [...entry.relatedFieldIds],
        total_count: rowIds.length,
        ...(paginated ? { offset, batch_size: items.length, batch_id: batchId } : {}),
      });
    }
  }));
}

function serializeWebhookView(view: any): Record<string, unknown> {
  return {
    id: view.id,
    table_id: view.table_id,
    order: view.order ?? 0,
    type: view.type || "grid",
    name: view.name || "",
    table: {
      id: view.table_id,
      order: view.table_order ?? 0,
      name: view.table_name || "",
      database_id: view.database_id,
    },
    filters_disabled: Boolean(view.filters_disabled),
    show_logo: true,
    allow_public_export: Boolean(view.allow_public_export),
    public_view_has_password: Boolean(view.public_view_password),
    filter_type: view.filter_type || "AND",
    ownership_type: view.ownership_type || "collaborative",
    owned_by_id: view.owned_by_id ?? null,
  };
}

async function tableViews(db: D1Database, tableId: number): Promise<any[]> {
  const rows = await db.prepare(
    `SELECT v.*, t.name AS table_name, t.[order] AS table_order, t.database_id
     FROM database_view v
     JOIN database_table t ON t.id=v.table_id
     WHERE v.table_id=? AND v.trashed=0
     ORDER BY v.[order] ASC, v.id ASC`
  ).bind(tableId).all<any>();
  return rows.results || [];
}

async function watchedTableViews(db: D1Database, tableId: number): Promise<any[]> {
  const watched = await rowsEnteredWebhookViewIds(db, tableId);
  if (!watched) return [];
  const views = await tableViews(db, tableId);
  return watched === "all" ? views : views.filter((view) => watched.has(Number(view.id)));
}

/** Rows currently in each view watched by a `view.rows_entered` webhook (none when unwatched). */
async function rowIdsByView(db: D1Database, tableId: number): Promise<Map<number, Set<number>>> {
  const result = new Map<number, Set<number>>();
  for (const view of await watchedTableViews(db, tableId)) {
    const queried = await queryViewRows(db, view, `https://internal/api/database/views/${view.type}/${view.id}/`);
    result.set(Number(view.id), new Set(queried.rows.map((row) => Number(row.id))));
  }
  return result;
}

async function triggerRowsEnteredViewWebhooks(
  env: Env,
  tableId: number,
  previousRowIdsByView: Map<number, Set<number>>,
  candidateRowIds: number[]
) {
  if (candidateRowIds.length === 0) return;
  const candidates = new Set(candidateRowIds.map(Number));
  for (const view of await watchedTableViews(env.DB, tableId)) {
    const queried = await queryViewRows(env.DB, view, `https://internal/api/database/views/${view.type}/${view.id}/`);
    const previous = previousRowIdsByView.get(Number(view.id)) || new Set<number>();
    const enteredRows = queried.rows.filter((row) => candidates.has(Number(row.id)) && !previous.has(Number(row.id)));
    if (enteredRows.length === 0) continue;
    const fields = ["id", "order", ...queried.fields.map((field) => `field_${field.id}`)];
    await triggerTableWebhooks(env, tableId, "view.rows_entered", {
      view_id: Number(view.id),
      view: serializeWebhookView(view),
      row_ids: enteredRows.map((row) => Number(row.id)),
      total_count: enteredRows.length,
      fields,
      rows: enteredRows,
    });
  }
}

async function requireAccess(
  db: D1Database,
  userId: number | undefined,
  tableId: number,
  perm = "VIEWER",
  dbToken?: RequestVariables["db_token_permissions"],
  operation: "create" | "read" | "update" | "delete" = perm === "VIEWER" ? "read" : "update"
) {
  const row = await getTableMeta(db, tableId);
  if (!row) throw new DoesNotExist("Table", tableId);
  const meta = { id: row.id, database_id: row.database_id, workspace_id: row.workspace_id };
  if (!dbToken && perm === "VIEWER" && operation === "read" && row.is_template) {
    return meta;
  }
  if (dbToken && !databaseTokenAllows(dbToken, meta, [operation])) {
    throw new PermissionError("The database token does not have permissions to the table.");
  }
  if (!userId) throw new PermissionError("Access denied.");
  // Like Supertask, a token never grants more than its owner's own role on the table.
  const requiredRole = perm === "VIEWER" ? "VIEWER" : "EDITOR";
  await assertHasTableRole(db, userId, meta, requiredRole);
  return meta;
}

async function getActiveFields(db: D1Database, tableId: number): Promise<FieldMeta[]> {
  const res = await db.prepare(
    `SELECT id, name, type, "primary" as is_primary, read_only, field_settings
     FROM database_field WHERE table_id=? AND trashed=0 ORDER BY [order] ASC`
  ).bind(tableId).all<any>();
  return (res.results || []).map(f => {
    const settings = parseFieldSettings(f.field_settings);
    return {
      id: f.id, name: f.name, type: f.type, primary: Boolean(f.is_primary),
      readOnly: Boolean(f.read_only),
      settings,
      formula: formulaFromSettings(settings),
    };
  });
}

function userCell(user: { id: number; email: string; username: string }) {
  return {
    id: user.id,
    name: user.username || user.email,
    email: user.email,
  };
}

function generatedCreateValue(
  field: FieldMeta,
  rowId: number | null,
  now: string,
  user: { id: number; email: string; username: string }
): unknown {
  switch (field.type) {
    case "uuid":
      return crypto.randomUUID();
    case "autonumber":
    case "auto_number":
      return rowId;
    case "created_on":
    case "last_modified":
      return now;
    case "created_by":
    case "last_modified_by":
      return userCell(user);
    default:
      return undefined;
  }
}

function isGeneratedField(field: FieldMeta) {
  return [
    "uuid",
    "autonumber",
    "auto_number",
    "created_on",
    "last_modified",
    "created_by",
    "last_modified_by",
  ].includes(field.type);
}

function isWritableInputField(field: FieldMeta) {
  return !isGeneratedField(field) && !field.readOnly && !isReadOnlyFieldType(field.type);
}

function requestedWritableFields(fields: FieldMeta[], input: Record<string, unknown>, useFieldNames = true) {
  return fields.filter((field) => {
    if (!isWritableInputField(field)) return false;
    const idKey = `field_${field.id}`;
    return idKey in input || (useFieldNames && field.name in input);
  });
}

async function serializeCreateValue(
  db: D1Database,
  field: FieldMeta,
  input: Record<string, unknown>,
  inputKey: string,
  changedFieldIds: Set<number>,
  fileUrlContext?: unknown,
  workspaceId?: number | null,
  linkTargets?: LinkTargetCache
): Promise<unknown | undefined> {
  if (inputKey in input) {
    const serialized = await serializeFieldValueForStorage(db, field, input[inputKey], fileUrlContext as any, workspaceId, linkTargets);
    if (serialized !== undefined) changedFieldIds.add(field.id);
    return serialized;
  }
  const defaultValue = fieldDefaultInputValue(field);
  if (defaultValue === undefined) return undefined;
  return serializeFieldValueForStorage(db, field, defaultValue, fileUrlContext as any, workspaceId);
}

// ── Serialize row with optional field name mapping + formula evaluation ─────
async function serializeRowWithNames(
  db: D1Database,
  row: Record<string, unknown>,
  fields: FieldMeta[],
  useFieldNames: boolean,
  ctx?: RowReadContext
): Promise<Record<string, unknown>> {
  return serializeRowWithComputedFields(db, row, fields, useFieldNames, ctx);
}

function serializeRowsWithNames(
  db: D1Database,
  rows: Record<string, unknown>[],
  fields: FieldMeta[],
  useFieldNames: boolean,
  ctx?: RowReadContext
): Promise<Record<string, unknown>[]> {
  return serializeRowsWithComputedFields(db, rows, fields, useFieldNames, ctx);
}

function truthyQueryParam(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || ["1", "true", "t", "yes", "y", "on"].includes(normalized);
}

// Supertask's BATCH_ROWS_SIZE_LIMIT.
const BATCH_ROWS_SIZE_LIMIT = 200;

/** Which per-row write side effects a set of changed fields can trigger. */
function rowWriteEffectFields(fields: FieldMeta[]) {
  const linkFields = fields.filter((field) => field.type === "link_row");
  const linkFieldIds = new Set(linkFields.map((field) => field.id));
  const collaboratorFieldIds = new Set(fields.filter((field) => field.type === "multiple_collaborators").map((field) => field.id));
  const primaryFieldId = (fields.find((field) => field.primary) || fields[0])?.id;
  return {
    // A primary change refreshes the names shown in linked rows.
    touchesLinks: (changed: Set<number>) => linkFieldIds.size > 0 &&
      ([...changed].some((id) => linkFieldIds.has(id)) || (primaryFieldId !== undefined && changed.has(primaryFieldId))),
    touchesCollaborators: (changed: Set<number>) => [...changed].some((id) => collaboratorFieldIds.has(id)),
    hasSelfLinks: (tableId: number) => linkFields.some((field) => Number(field.settings?.link_row_table_id) === tableId),
  };
}

function positiveIntQueryParam(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalRowId(value: string | undefined, name: string): number | null {
  if (value === undefined || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError(`${name} must be a valid row id.`);
  }
  return id;
}

async function allocateInsertionOrders(db: D1Database, tableId: number, count: number, beforeId: number | null): Promise<number[]> {
  if (count <= 0) return [];
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(db, tableId);
  if (beforeId !== null) {
    const before = await db.prepare(`SELECT id, [order] AS order_value FROM "${tn}" WHERE id=? AND ${activeRowClause()}`)
      .bind(beforeId)
      .first<{ id: number; order_value: number }>();
    if (!before) throw new DoesNotExist("Row", beforeId);
    const previous = await db.prepare(
      `SELECT [order] AS order_value
       FROM "${tn}"
       WHERE id != ? AND ${activeRowClause()} AND [order] < ?
       ORDER BY [order] DESC, id DESC
       LIMIT 1`
    ).bind(beforeId, before.order_value).first<{ order_value: number }>();
    const end = Number(before.order_value);
    const start = previous ? Number(previous.order_value) : end - 10000 * (count + 1);
    const step = (end - start) / (count + 1);
    return Array.from({ length: count }, (_, index) => start + step * (index + 1));
  }

  const max = await db.prepare(`SELECT COALESCE(MAX([order]), 0) AS max_order FROM "${tn}" WHERE ${activeRowClause()}`)
    .first<{ max_order: number }>();
  const start = Number(max?.max_order || 0);
  return Array.from({ length: count }, (_, index) => start + 10000 * (index + 1));
}

function operationMetadata(fields: FieldMeta[], updatedFieldIds?: Iterable<number>, cascadeRows: unknown[] = []) {
  const metadata: Record<string, unknown> = {
    updated_field_ids: updatedFieldIds ? Array.from(updatedFieldIds) : fields.map((field) => field.id),
  };
  if (cascadeRows.length > 0) {
    metadata.cascade_update = {
      rows: cascadeRows,
      field_ids: [],
    };
  }
  return metadata;
}

function splitOrderBy(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function findOrderByField(raw: string, fields: FieldMeta[], useFieldNames: boolean): FieldMeta | null {
  const fieldIdMatch = raw.match(/^field_(\d+)$/);
  if (fieldIdMatch) {
    const id = Number(fieldIdMatch[1]);
    return fields.find((field) => field.id === id) || null;
  }
  if (!useFieldNames && /^\d+$/.test(raw)) {
    const id = Number(raw);
    return fields.find((field) => field.id === id) || null;
  }
  if (useFieldNames) {
    return fields.find((field) => field.name === raw) || null;
  }
  return null;
}

function buildOrderClause(tableName: string, fields: FieldMeta[], orderBy: string, useFieldNames: boolean): string {
  const sortClauses: string[] = [];
  for (const part of splitOrderBy(orderBy)) {
    const desc = part.startsWith("-");
    const asc = part.startsWith("+");
    const raw = desc || asc ? part.slice(1) : part;
    const field = findOrderByField(raw, fields, useFieldNames);
    if (!field) continue;
    sortClauses.push(`"${tableName}"."field_${field.id}" ${desc ? "DESC" : "ASC"}`);
  }
  sortClauses.push(`"${tableName}".[order] ASC`, `"${tableName}".id ASC`);
  return sortClauses.join(", ");
}

// ── GET /api/database/rows/table/:tableId/ — List rows ──────────────────────
rows.get("/table/:tableId/", databaseTokenAuthMiddleware({ optional: true }), async (c) => {
  const user = c.get("user");
  const tableId = parseInt(c.req.param("tableId"));
  await requireAccess(c.env.DB, user?.id, tableId, "VIEWER", c.get("db_token_permissions"), "read");

  const fields = await getActiveFields(c.env.DB, tableId);
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);

  // Pagination
  const page = positiveIntQueryParam(c.req.query("page"), 1);
  // Like DRF's PageNumberPagination, an invalid size falls back to the default.
  const pageSize = Math.min(1000, positiveIntQueryParam(c.req.query("size"), 100));
  const offset = (page - 1) * pageSize;

  // Order
  const orderBy = c.req.query("order_by") || "";
  const useFieldNames = truthyQueryParam(c.req.query("user_field_names"));
  const orderClause = buildOrderClause(tn, fields, orderBy, useFieldNames);

  // Search
  const search = c.req.query("search") || "";

  // Build WHERE clause from filter params
  const filters: FilterSpec[] = [];
  const filterType = (c.req.query("filter_type") || "").toUpperCase() === "OR" ? "OR" : "AND";
  for (const [key, val] of Object.entries(c.req.query())) {
    const m = key.match(/^filter__field_(\d+)__(\w+)$/);
    if (m) filters.push({ field_id: parseInt(m[1]), type: m[2], value: val });
  }

  let where = activeRowClause(tn);
  const params: unknown[] = [];

  if (search && fields.length > 0) {
    const searchClauses = fields
      .filter(f => ["text", "long_text", "url", "email", "phone_number"].includes(f.type))
      // instr(): D1 rejects LIKE patterns over 50 bytes, and % or _ typed by the
      // user must not act as wildcards.
      .map(f => `instr(LOWER("${tn}"."field_${f.id}"), LOWER(?)) > 0`);
    if (searchClauses.length > 0) {
      searchClauses.forEach(() => params.push(search));
      where += ` AND (${searchClauses.join(" OR ")})`;
    }
  }

  if (filters.length > 0) {
    const { clause, values } = applyFilters(tn, filters, fields, filterType);
    if (clause) { where += ` AND ${clause}`; params.push(...values); }
  }

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM "${tn}" WHERE ${where}`
  ).bind(...params).first<{ cnt: number }>();

  const result = await c.env.DB.prepare(
    `SELECT * FROM "${tn}" WHERE ${where} ORDER BY ${orderClause} LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all<Record<string, unknown>>();

  const serialized = await serializeRowsWithNames(c.env.DB, result.results || [], fields, useFieldNames);
  const include = new Set((c.req.query("include") || "").split(",").map((item) => item.trim()).filter(Boolean));
  const rowIds = (result.results || []).map((row) => Number(row.id));

  const payload: Record<string, unknown> = {
    count: countResult?.cnt ?? 0,
    next: offset + pageSize < (countResult?.cnt ?? 0)
      ? `/api/database/rows/table/${tableId}/?page=${page + 1}&size=${pageSize}` : null,
    previous: page > 1
      ? `/api/database/rows/table/${tableId}/?page=${page - 1}&size=${pageSize}` : null,
    results: serialized,
  };
  if (include.has("row_metadata")) {
    payload.row_metadata = await buildRowMetadata(c.env.DB, tableId, rowIds, user?.id);
  }
  return c.json(payload);
});

// ── GET /api/database/rows/names/ — Batch row names ─────────────────────────
rows.get("/names/", databaseTokenAuthMiddleware({ optional: true }), async (c) => {
  const user = c.get("user");
  const response: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(c.req.query())) {
    const match = key.match(/^table__(\d+)$/);
    if (!match || !value) continue;

    const tableId = Number(match[1]);
    await requireAccess(c.env.DB, user?.id, tableId, "VIEWER", c.get("db_token_permissions"), "read");
    await ensureUserTableSystemColumns(c.env.DB, tableId);
    const fields = await getActiveFields(c.env.DB, tableId);
    const primary = fields.find((field) => field.primary) || fields[0];
    if (!primary) {
      response[tableId] = {};
      continue;
    }

    const ids = String(value)
      .split(",")
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (ids.length === 0) {
      response[tableId] = {};
      continue;
    }

    const bindMarks = ids.map(() => "?").join(",");
    const rowsResult = await c.env.DB.prepare(
      `SELECT id, "field_${primary.id}" AS name FROM "database_table_${tableId}" WHERE ${activeRowClause()} AND id IN (${bindMarks})`
    )
      .bind(...ids)
      .all<any>();

    response[tableId] = {};
    for (const row of rowsResult.results || []) {
      response[tableId][row.id] = row.name ?? "";
    }
  }

  return c.json(response);
});

// ── GET /api/database/rows/table/:tableId/:rowId/history/ ───────────────────
rows.get("/table/:tableId/:rowId/history/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const rowId = Number(c.req.param("rowId"));
  await requireAccess(c.env.DB, user.id, tableId, "VIEWER", c.get("db_token_permissions"), "read");
  const fields = await getActiveFields(c.env.DB, tableId);
  const limit = Math.min(100, Number(c.req.query("limit") || 30));
  const offset = Math.max(0, Number(c.req.query("offset") || 0));
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM database_rowhistory WHERE table_id=? AND row_id=?"
  ).bind(tableId, rowId).first<{ count: number }>();
  const entries = await c.env.DB.prepare(
    `SELECT rh.*, u.email AS user_email
     FROM database_rowhistory rh
     LEFT JOIN auth_user u ON u.id=rh.user_id
     WHERE rh.table_id=? AND rh.row_id=?
     ORDER BY rh.action_timestamp DESC, rh.id DESC
     LIMIT ? OFFSET ?`
  ).bind(tableId, rowId, limit, offset).all<any>();

  const total = count?.count || 0;
  return c.json({
    count: total,
    next: offset + limit < total ? `?limit=${limit}&offset=${offset + limit}` : null,
    previous: offset > 0 ? `?limit=${limit}&offset=${Math.max(0, offset - limit)}` : null,
    results: (entries.results || []).map((entry) => serializeRowHistoryEntry(entry, fields)),
  });
});

// ── POST /api/database/rows/table/:tableId/ — Create row ─────────────────────
rows.post("/table/:tableId/", databaseTokenAuthMiddleware(), async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const meta = await requireAccess(c.env.DB, user.id, tableId, "MEMBER", c.get("db_token_permissions"), "create");
  const body = await c.req.json<Record<string, unknown>>();
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  const now = new Date().toISOString();
  const useFieldNames = truthyQueryParam(c.req.query("user_field_names"));
  const beforeId = optionalRowId(c.req.query("before"), "before");
  const [fields, [insertOrder]] = await Promise.all([
    getActiveFields(c.env.DB, tableId),
    allocateInsertionOrders(c.env.DB, tableId, 1, beforeId),
  ]);
  await assertCanWriteFieldValues(c.env.DB, user.id, meta, requestedWritableFields(fields, body, useFieldNames));

  const cols = ["[order]", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id"];
  const vals: unknown[] = [insertOrder, now, now, user.id, user.id];
  const changedFieldIds = new Set<number>();

  for (const field of fields) {
    const colKey = useFieldNames ? field.name : `field_${field.id}`;
    if (isGeneratedField(field)) {
      const generated = generatedCreateValue(field, null, now, user);
      if (generated !== undefined && field.type !== "autonumber" && field.type !== "auto_number") {
        cols.push(`"field_${field.id}"`);
        vals.push(serializeFieldValueForInsert(field.type, generated));
      }
    } else if (isWritableInputField(field)) {
      const value = await serializeCreateValue(c.env.DB, field, body, colKey, changedFieldIds, c.env, meta.workspace_id);
      if (value !== undefined) {
        cols.push(`"field_${field.id}"`);
        vals.push(value);
      }
    }
  }

  const existingFieldIds = new Set(cols.flatMap((column) => {
    const match = column.match(/^"field_(\d+)"$/);
    return match ? [Number(match[1])] : [];
  }));
  const missingValues = await missingCreateFieldValues(c.env.DB, fields, existingFieldIds, {
    now,
    user,
    fileContext: c.env,
    workspaceId: meta.workspace_id,
  });
  for (const [fieldId, value] of missingValues) {
    cols.push(`"field_${fieldId}"`);
    vals.push(value);
  }

  const autonumberValues = await allocateAutonumberValues(c.env.DB, tableId);
  for (const [fieldId, value] of autonumberValues) {
    cols.push(`"field_${fieldId}"`);
    vals.push(serializeFieldValueForInsert("autonumber", value));
  }

  const bindMarks = cols.map(() => "?").join(", ");
  const result = await c.env.DB.prepare(
    `INSERT INTO "${tn}" (${cols.join(", ")}) VALUES (${bindMarks}) RETURNING *`
  ).bind(...vals).first<Record<string, unknown>>();

  // The INSERT returned the row; it only needs reading again when a date
  // dependency rule changed it afterwards.
  const updatedResult = await applyDateDependencyRules(c.env.DB, tableId, Number(result!.id), changedFieldIds)
    ? await c.env.DB.prepare(`SELECT * FROM "${tn}" WHERE id=?`).bind(result!.id).first<Record<string, unknown>>()
    : result;
  // These follow-ups touch different tables and don't depend on each other.
  const [, , , auditCtx] = await Promise.all([
    synchronizeLinkRowRelations(c.env.DB, tableId, Number(result!.id), null, updatedResult || result!, changedFieldIds),
    notifyNewCollaborators(c.env.DB, tableId, Number(result!.id), null, updatedResult || result!, changedFieldIds, user.id, c.env),
    enqueueAutomaticAIUpdates(c.env, tableId, [Number(result!.id)], changedFieldIds),
    getTableAuditContext(c.env.DB, tableId),
  ]);
  const row = await serializeRowWithNames(c.env.DB, updatedResult || result!, fields, useFieldNames);
  const [historyEntry] = await Promise.all([
    createRowHistoryEntry(c.env.DB, {
      user,
      tableId,
      rowId: Number(result!.id),
      actionType: "create_row",
      before: {},
      after: rowFieldValues(updatedResult || result!, fields),
      fields,
      ...rowHistoryActionContext(c, tableId),
      beforeRow: null,
      afterRow: updatedResult || result!,
    }),
    logAuditEntry(c.env.DB, "database.rows.create", {
      user,
      workspace_id: meta.workspace_id,
      workspace_name: auditCtx?.workspace_name,
      ip_address: clientIp(c),
    }, { id: Number(result!.id), type: "row" }, {
      table_id: tableId,
      table_name: auditCtx?.table_name || "",
      row_id: Number(result!.id),
      count: 1,
    }),
  ]);
  const wsId = c.get("websocket_id") || "";

  // The other clients are told after the response, in order: the writer
  // doesn't wait for the realtime fan-out.
  c.executionCtx.waitUntil((async () => {
    await broadcastToWorkspace(c.env, meta.workspace_id, {
      type: "rows_created",
      table_id: tableId,
      rows: [row],
      metadata: {},
    }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
    await broadcastToWorkspace(c.env, meta.workspace_id, {
      type: "row_history_updated",
      table_id: tableId,
      row_id: Number(result!.id),
      row_history_entry: historyEntry,
    }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
  })());
  c.executionCtx.waitUntil((async () => {
    const automationRow = await serializeRowWithNames(c.env.DB, updatedResult || result!, fields, true);
    await triggerRowSideEffects(c.env, tableId, "rows.created", { items: [automationRow] });
  })());
  c.executionCtx.waitUntil(pushPostgresqlTwoWayRowsCreated(c.env, tableId, [updatedResult || result!]));
  c.executionCtx.waitUntil(triggerRelatedTableRowUpdateWebhooks(c.env, tableId, fields, [{
    before: null,
    after: updatedResult || result!,
    updatedFieldIds: changedFieldIds,
  }]));
  c.executionCtx.waitUntil(triggerRowsEnteredViewWebhooks(c.env, tableId, new Map(), [Number(result!.id)]));

  return c.json(row, 200);
});

// ── PATCH /api/database/rows/table/:tableId/batch/ — Batch update ─────────────
rows.patch("/table/:tableId/batch/", databaseTokenAuthMiddleware(), async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const meta = await requireAccess(c.env.DB, user.id, tableId, "MEMBER", c.get("db_token_permissions"), "update");
  const body = await c.req.json<{ items: Array<{ id: number } & Record<string, unknown>> }>();

  if (!Array.isArray(body.items)) throw new ValidationError("items must be an array.");
  if (body.items.length > BATCH_ROWS_SIZE_LIMIT) {
    throw new ValidationError(`Cannot batch update more than ${BATCH_ROWS_SIZE_LIMIT} rows at once.`);
  }

  const fields = await getActiveFields(c.env.DB, tableId);
  const useFieldNames = truthyQueryParam(c.req.query("user_field_names"));
  const includeMetadata = truthyQueryParam(c.req.query("include_metadata"));
  const requestedFields = new Map<number, FieldMeta>();
  for (const item of body.items) {
    for (const field of requestedWritableFields(fields, item, useFieldNames)) requestedFields.set(field.id, field);
  }
  await assertCanWriteFieldValues(c.env.DB, user.id, meta, Array.from(requestedFields.values()));
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  const now = new Date().toISOString();
  const beforeRows = await selectActiveRowsByIds(c.env.DB, tableId, body.items.map((item) => Number(item.id)));
  const previousRowsByView = await rowIdsByView(c.env.DB, tableId);

  const changedByRow = new Map<number, Set<number>>();
  const statements = [];
  const linkTargets = new LinkTargetCache(c.env.DB);
  for (const item of body.items) {
    const { id, ...rest } = item;
    const sets = ["_updated_on = ?", "_last_modified_by_id = ?"];
    const vals: unknown[] = [now, user.id];
    const changedFieldIds = new Set<number>();
    for (const field of fields) {
      if (!isWritableInputField(field)) continue;
      const key = `field_${field.id}`;
      const bodyKey = key in rest ? key : useFieldNames ? field.name : key;
      if (bodyKey in rest) {
      sets.push(`"${key}" = ?`);
      const serializedValue = await serializeFieldValueForStorage(c.env.DB, field, rest[bodyKey], c.env, meta.workspace_id, linkTargets);
      if (serializedValue !== undefined) {
        vals.push(serializedValue);
        changedFieldIds.add(field.id);
      } else {
        sets.pop();
      }
      }
    }
    for (const field of fields) {
      if (field.type === "last_modified") {
        sets.push(`"field_${field.id}" = ?`);
        vals.push(now);
      } else if (field.type === "last_modified_by") {
        sets.push(`"field_${field.id}" = ?`);
        vals.push(serializeFieldValueForInsert(field.type, userCell(user)));
      }
    }
    changedByRow.set(id, changedFieldIds);
    vals.push(id);
    statements.push(c.env.DB.prepare(`UPDATE "${tn}" SET ${sets.join(", ")} WHERE id=? AND ${activeRowClause()}`).bind(...vals));
  }

  if (statements.length > 0) await c.env.DB.batch(statements);
  const wsId = c.get("websocket_id") || "";
  const auditCtx = await getTableAuditContext(c.env.DB, tableId);
  let updatedCount = 0;
  const updatedRows: Record<string, unknown>[] = [];
  const responseRows: Record<string, unknown>[] = [];
  const allChangedFieldIds = new Set<number>();
  const removedUserFileNames = new Set<string>();
  // Table-level lookups happen once per batch: per-row work only runs when the
  // row changed a field it concerns, which keeps 200-row batches far below
  // D1's per-invocation query limit.
  if (await hasActiveDateDependencyRules(c.env.DB, tableId)) {
    for (const [id, changedFieldIds] of changedByRow) await applyDateDependencyRules(c.env.DB, tableId, id, changedFieldIds);
  }
  const afterRows = await selectActiveRowsByIds(c.env.DB, tableId, [...changedByRow.keys()]);
  const writeEffects = rowWriteEffectFields(fields);
  const aiUpdateGroups = new Map<string, { rowIds: number[]; changedFieldIds: Set<number> }>();
  await synchronizeLinkRowRelationsBatch(c.env.DB, tableId, [...changedByRow].flatMap(([id, changedFieldIds]) => {
    const after = afterRows.get(id);
    return after && writeEffects.touchesLinks(changedFieldIds)
      ? [{ rowId: id, before: beforeRows.get(id) || null, after, changedFieldIds }]
      : [];
  }));
  for (const [id, changedFieldIds] of changedByRow) {
    const before = beforeRows.get(id);
    const after = afterRows.get(id);
    if (after) {
      if (writeEffects.touchesCollaborators(changedFieldIds)) {
        await notifyNewCollaborators(c.env.DB, tableId, id, before || null, after, changedFieldIds, user.id, c.env);
      }
      const groupKey = [...changedFieldIds].sort((left, right) => left - right).join(",");
      const group = aiUpdateGroups.get(groupKey) || { rowIds: [], changedFieldIds };
      group.rowIds.push(id);
      aiUpdateGroups.set(groupKey, group);
    }
    if (after) responseRows.push(after);
    if (before && after) {
      const afterNames = collectUserFileNamesFromRecord(after);
      for (const name of collectUserFileNamesFromRecord(before)) {
        if (!afterNames.has(name)) removedUserFileNames.add(name);
      }
    }
    for (const fieldId of changedFieldIds) allChangedFieldIds.add(fieldId);
    if (!before || !after) continue;
    const diff = changedRowValues(before, after, fields);
    if (Object.keys(diff.before).length === 0 && Object.keys(diff.after).length === 0) continue;
    updatedCount += 1;
    updatedRows.push(after);
    const historyEntry = await createRowHistoryEntry(c.env.DB, {
      user,
      tableId,
      rowId: id,
      actionType: "update_rows",
      before: diff.before,
      after: diff.after,
      fields,
      ...rowHistoryActionContext(c, tableId),
      beforeRow: before,
      afterRow: after,
    });
    await broadcastToWorkspace(c.env, meta.workspace_id, {
      type: "row_history_updated",
      table_id: tableId,
      row_id: id,
      row_history_entry: historyEntry,
    }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
  }
  for (const group of aiUpdateGroups.values()) {
    await enqueueAutomaticAIUpdates(c.env, tableId, group.rowIds, group.changedFieldIds);
  }
  if (writeEffects.hasSelfLinks(tableId) && responseRows.length > 0) {
    // Link sync above may have changed reciprocal cells of rows in this batch.
    const refreshed = await selectActiveRowsByIds(c.env.DB, tableId, responseRows.map((row) => Number(row.id)));
    responseRows.splice(0, responseRows.length, ...responseRows.map((row) => refreshed.get(Number(row.id)) || row));
  }
  const serializedItems = await serializeRowsWithNames(c.env.DB, responseRows, fields, useFieldNames);
  if (serializedItems.length > 0) {
    await broadcastToWorkspace(c.env, meta.workspace_id, {
      type: "rows_updated",
      table_id: tableId,
      rows: serializedItems,
      metadata: {
        updated_field_ids: Array.from(allChangedFieldIds),
        cascade_update: { rows: [], field_ids: [] },
      },
    }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
  }
  if (updatedCount > 0) {
    await logAuditEntry(c.env.DB, "database.rows.update", {
      user,
      workspace_id: meta.workspace_id,
      workspace_name: auditCtx?.workspace_name,
      ip_address: clientIp(c),
    }, { id: tableId, type: "table" }, {
      table_id: tableId,
      table_name: auditCtx?.table_name || "",
      count: updatedCount,
    });
  }
  if (updatedRows.length > 0) {
    const readCtx = new RowReadContext(c.env.DB);
    const automationItems = await serializeRowsWithNames(c.env.DB, updatedRows, fields, true, readCtx);
    const previousRows = updatedRows.map((row) => beforeRows.get(Number(row.id)) || null);
    await readCtx.prefetchLinks(previousRows.filter((row): row is Record<string, unknown> => row !== null), fields);
    const oldItems = await Promise.all(previousRows.map((before) => (
      before ? serializeRowWithNames(c.env.DB, before, fields, true, readCtx) : null
    )));
    c.executionCtx.waitUntil(triggerRowSideEffects(c.env, tableId, "rows.updated", {
      items: automationItems,
      old_items: oldItems.filter(Boolean),
      updated_field_ids: Array.from(allChangedFieldIds),
    }));
    c.executionCtx.waitUntil(pushPostgresqlTwoWayRowsUpdated(c.env, tableId, updatedRows, allChangedFieldIds));
    c.executionCtx.waitUntil(triggerRelatedTableRowUpdateWebhooks(c.env, tableId, fields, updatedRows.map((row) => ({
      before: beforeRows.get(Number(row.id)) || null,
      after: row,
      updatedFieldIds: changedByRow.get(Number(row.id)) || null,
    }))));
    c.executionCtx.waitUntil(triggerRowsEnteredViewWebhooks(c.env, tableId, previousRowsByView, updatedRows.map((row) => Number(row.id))));
  }
  if (removedUserFileNames.size > 0) {
    c.executionCtx.waitUntil(scheduleUnreferencedUserFilesForDeletion(c.env, removedUserFileNames));
  }
  const payload: Record<string, unknown> = {
    items: serializedItems,
    items_updated: serializedItems.length,
  };
  if (includeMetadata) {
    payload.metadata = operationMetadata(fields, allChangedFieldIds);
  }
  return c.json(payload);
});

// ── DELETE /api/database/rows/table/:tableId/batch/ — Batch delete ───────────
// ── Batch delete (DELETE …/batch/ and the POST …/batch-delete/ alias) ──────────
async function batchDeleteRows(c: Context<{ Bindings: Env; Variables: RequestVariables }>) {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId") || "");
  const meta = await requireAccess(c.env.DB, user.id, tableId, "MEMBER", c.get("db_token_permissions"), "delete");
  const body = await c.req.json<{ items: number[] }>();

  if (!Array.isArray(body.items)) throw new ValidationError("items must be an array of row ids.");
  if (body.items.length === 0) return c.json({ items_deleted: 0 });
  if (body.items.length > BATCH_ROWS_SIZE_LIMIT) {
    throw new ValidationError(`Cannot batch delete more than ${BATCH_ROWS_SIZE_LIMIT} rows at once.`);
  }

  const tn = `database_table_${tableId}`;
  const requestedIds = [...new Set(body.items.map(Number))];
  const [fields, beforeById, table] = await Promise.all([
    getActiveFields(c.env.DB, tableId),
    selectActiveRowsByIds(c.env.DB, tableId, requestedIds),
    c.env.DB.prepare("SELECT name FROM database_table WHERE id=?").bind(tableId).first<{ name: string }>(),
  ]);
  const beforeRows = requestedIds.flatMap((id): Record<string, unknown>[] => {
    const row = beforeById.get(id);
    return row ? [row] : [];
  });
  const now = new Date().toISOString();
  // Trash entries and the trashing update commit together, so a failure can
  // never leave restorable entries for rows that were not deleted.
  await c.env.DB.batch([
    ...beforeRows.flatMap((before) => trashEntryStatements(
      c.env.DB,
      rowTrashEntryOptions(tableId, meta.workspace_id, meta.database_id, user.id, before, fields, table?.name || "")
    )),
    ...chunkIds(beforeRows.map((before) => Number(before.id))).map((chunk) => c.env.DB.prepare(
      `UPDATE "${tn}"
          SET trashed=1, _updated_on=?, _last_modified_by_id=?
        WHERE ${activeRowClause()} AND id IN (${chunk.map(() => "?").join(", ")})`
    ).bind(now, user.id, ...chunk)),
  ]);
  const linkFields = fields.filter((field) => field.type === "link_row");
  // Only rows that linked to something have reciprocal cells to clean up.
  await synchronizeLinkRowRelationsBatch(c.env.DB, tableId, beforeRows
    .filter((before) => linkFields.some((field) => linkedRowIds(before[`field_${field.id}`]).length > 0))
    .map((before) => ({ rowId: Number(before.id), before, after: null, changedFieldIds: null })));
  const wsId = c.get("websocket_id") || "";
  for (const before of beforeRows) {
    const historyEntry = await createRowHistoryEntry(c.env.DB, {
      user,
      tableId,
      rowId: Number(before.id),
      actionType: "delete_rows",
      before: rowFieldValues(before, fields),
      after: {},
      fields,
      ...rowHistoryActionContext(c, tableId),
      beforeRow: before,
      afterRow: null,
    });
    await broadcastToWorkspace(c.env, meta.workspace_id, {
      type: "row_history_updated",
      table_id: tableId,
      row_id: Number(before.id),
      row_history_entry: historyEntry,
    }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
  }
  const auditCtx = await getTableAuditContext(c.env.DB, tableId);
  await logAuditEntry(c.env.DB, "database.rows.delete", {
    user,
    workspace_id: meta.workspace_id,
    workspace_name: auditCtx?.workspace_name,
    ip_address: clientIp(c),
  }, { id: tableId, type: "table" }, {
    table_id: tableId,
    table_name: auditCtx?.table_name || "",
    count: beforeRows.length,
  });

  const automationItems = await serializeRowsWithNames(c.env.DB, beforeRows, fields, true);
  c.executionCtx.waitUntil(triggerRowSideEffects(c.env, tableId, "rows.deleted", { items: automationItems, row_ids: body.items }));
  c.executionCtx.waitUntil(pushPostgresqlTwoWayRowsDeleted(c.env, tableId, beforeRows));
  c.executionCtx.waitUntil(triggerRelatedTableRowUpdateWebhooks(c.env, tableId, fields, beforeRows.map((row) => ({
    before: row,
    after: null,
    updatedFieldIds: null,
  }))));
  return c.json({ items_deleted: beforeRows.length });
}

rows.delete("/table/:tableId/batch/", databaseTokenAuthMiddleware(), batchDeleteRows);

// ── GET /api/database/rows/table/:tableId/:rowId/ ─────────────────────────────
rows.get("/table/:tableId/:rowId/", databaseTokenAuthMiddleware({ optional: true }), async (c) => {
  const user = c.get("user");
  const tableId = parseInt(c.req.param("tableId"));
  const rowId = parseInt(c.req.param("rowId"));
  await requireAccess(c.env.DB, user?.id, tableId, "VIEWER", c.get("db_token_permissions"), "read");
  const fields = await getActiveFields(c.env.DB, tableId);
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);

  const row = await c.env.DB.prepare(`SELECT * FROM "${tn}" WHERE id=? AND ${activeRowClause()}`).bind(rowId).first<Record<string, unknown>>();
  if (!row) throw new DoesNotExist("Row", rowId);

  const useFieldNames = truthyQueryParam(c.req.query("user_field_names"));
  const serialized = await serializeRowWithNames(c.env.DB, row, fields, useFieldNames);
  const include = new Set((c.req.query("include") || "").split(",").map((item) => item.trim()).filter(Boolean));
  if (include.has("metadata") || c.req.query("include_metadata") === "true") {
    const metadata = await buildRowMetadata(c.env.DB, tableId, [rowId], user?.id);
    (serialized as Record<string, unknown>).metadata = metadata[String(rowId)] || {};
  }
  return c.json(serialized);
});

// ── PATCH /api/database/rows/table/:tableId/:rowId/ — Update row ──────────────
rows.patch("/table/:tableId/:rowId/", databaseTokenAuthMiddleware(), async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const rowId = parseInt(c.req.param("rowId"));
  const meta = await requireAccess(c.env.DB, user.id, tableId, "MEMBER", c.get("db_token_permissions"), "update");
  const body = await c.req.json<Record<string, unknown>>();
  const useFieldNames = truthyQueryParam(c.req.query("user_field_names"));
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  // Independent reads: the fields, the row as it is now and the rows each
  // watched view shows before the change.
  const [fields, beforeRow, previousRowsByView] = await Promise.all([
    getActiveFields(c.env.DB, tableId),
    c.env.DB.prepare(`SELECT * FROM "${tn}" WHERE id=? AND ${activeRowClause()}`).bind(rowId).first<Record<string, unknown>>(),
    rowIdsByView(c.env.DB, tableId),
  ]);
  await assertCanWriteFieldValues(c.env.DB, user.id, meta, requestedWritableFields(fields, body, useFieldNames));
  if (!beforeRow) throw new DoesNotExist("Row", rowId);

  const sets: string[] = ["_updated_on = ?", "_last_modified_by_id = ?"];
  const vals: unknown[] = [new Date().toISOString(), user.id];
  const changedFieldIds = new Set<number>();

  for (const field of fields) {
    if (!isWritableInputField(field)) continue;
    const key = `field_${field.id}`;
    const bodyKey = key in body ? key : useFieldNames ? field.name : key;
    if (bodyKey in body) {
      sets.push(`"${key}" = ?`);
      const serializedValue = await serializeFieldValueForStorage(c.env.DB, field, body[bodyKey], c.env, meta.workspace_id);
      if (serializedValue !== undefined) {
        vals.push(serializedValue);
        changedFieldIds.add(field.id);
      } else {
        sets.pop();
      }
    }
  }
  for (const field of fields) {
    if (field.type === "last_modified") {
      sets.push(`"field_${field.id}" = ?`);
      vals.push(vals[0]);
    } else if (field.type === "last_modified_by") {
      sets.push(`"field_${field.id}" = ?`);
      vals.push(serializeFieldValueForInsert(field.type, userCell(user)));
    }
  }
  vals.push(rowId);

  const result = await c.env.DB.prepare(
    `UPDATE "${tn}" SET ${sets.join(", ")} WHERE id=? AND ${activeRowClause()} RETURNING *`
  ).bind(...vals).first<Record<string, unknown>>();

  if (!result) throw new DoesNotExist("Row", rowId);
  // The UPDATE returned the row; it only needs reading again when a date
  // dependency rule changed it afterwards.
  const updatedResult = await applyDateDependencyRules(c.env.DB, tableId, rowId, changedFieldIds)
    ? await c.env.DB.prepare(`SELECT * FROM "${tn}" WHERE id=? AND ${activeRowClause()}`).bind(rowId).first<Record<string, unknown>>()
    : result;
  const finalRow = updatedResult || result;
  const finalUserFileNames = collectUserFileNamesFromRecord(finalRow);
  const removedUserFileNames = Array.from(collectUserFileNamesFromRecord(beforeRow))
    .filter((name) => !finalUserFileNames.has(name));
  if (removedUserFileNames.length > 0) {
    c.executionCtx.waitUntil(scheduleUnreferencedUserFilesForDeletion(c.env, removedUserFileNames));
  }
  // These follow-ups touch different tables and don't depend on each other.
  const [, , , auditCtx] = await Promise.all([
    synchronizeLinkRowRelations(c.env.DB, tableId, rowId, beforeRow, finalRow, changedFieldIds),
    notifyNewCollaborators(c.env.DB, tableId, rowId, beforeRow, finalRow, changedFieldIds, user.id, c.env),
    enqueueAutomaticAIUpdates(c.env, tableId, [rowId], changedFieldIds),
    getTableAuditContext(c.env.DB, tableId),
  ]);
  const row = await serializeRowWithNames(c.env.DB, finalRow, fields, useFieldNames);
  const diff = changedRowValues(beforeRow, finalRow, fields);
  const [historyEntry] = await Promise.all([
    createRowHistoryEntry(c.env.DB, {
      user,
      tableId,
      rowId,
      actionType: "update_row",
      before: diff.before,
      after: diff.after,
      fields,
      ...rowHistoryActionContext(c, tableId),
      beforeRow,
      afterRow: finalRow,
    }),
    logAuditEntry(c.env.DB, "database.rows.update", {
      user,
      workspace_id: meta.workspace_id,
      workspace_name: auditCtx?.workspace_name,
      ip_address: clientIp(c),
    }, { id: rowId, type: "row" }, {
      table_id: tableId,
      table_name: auditCtx?.table_name || "",
      row_id: rowId,
      count: 1,
    }),
  ]);
  const wsId = c.get("websocket_id") || "";

  // The other clients are told after the response, in order: the writer
  // doesn't wait for the realtime fan-out.
  c.executionCtx.waitUntil((async () => {
    await broadcastToWorkspace(c.env, meta.workspace_id, {
      type: "rows_updated",
      table_id: tableId,
      rows: [row],
      metadata: {},
    }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
    await broadcastToWorkspace(c.env, meta.workspace_id, {
      type: "row_history_updated",
      table_id: tableId,
      row_id: rowId,
      row_history_entry: historyEntry,
    }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
  })());
  c.executionCtx.waitUntil((async () => {
    const [automationRow, oldAutomationRow] = await Promise.all([
      serializeRowWithNames(c.env.DB, updatedResult || result, fields, true),
      serializeRowWithNames(c.env.DB, beforeRow, fields, true),
    ]);
    await triggerRowSideEffects(c.env, tableId, "rows.updated", {
      items: [automationRow],
      old_items: [oldAutomationRow],
      updated_field_ids: Array.from(changedFieldIds),
    });
  })());
  c.executionCtx.waitUntil(pushPostgresqlTwoWayRowsUpdated(c.env, tableId, [updatedResult || result], changedFieldIds));
  c.executionCtx.waitUntil(triggerRelatedTableRowUpdateWebhooks(c.env, tableId, fields, [{
    before: beforeRow,
    after: updatedResult || result,
    updatedFieldIds: changedFieldIds,
  }]));
  c.executionCtx.waitUntil(triggerRowsEnteredViewWebhooks(c.env, tableId, previousRowsByView, [rowId]));

  return c.json(row);
});

// ── PATCH /api/database/rows/table/:tableId/:rowId/move/ ────────────────────
rows.patch("/table/:tableId/:rowId/move/", databaseTokenAuthMiddleware(), async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const rowId = Number(c.req.param("rowId"));
  const meta = await requireAccess(c.env.DB, user.id, tableId, "MEMBER", c.get("db_token_permissions"), "update");
  const beforeId = c.req.query("before_id") ? Number(c.req.query("before_id")) : null;
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  const fields = await getActiveFields(c.env.DB, tableId);
  const beforeRow = await c.env.DB.prepare(`SELECT * FROM "${tn}" WHERE id = ? AND ${activeRowClause()}`)
    .bind(rowId)
    .first<Record<string, unknown>>();
  if (!beforeRow) throw new DoesNotExist("Row", rowId);

  if (beforeId === rowId) {
    return c.json(await serializeRowWithNames(c.env.DB, beforeRow, fields, false));
  }

  let newOrder: number;
  if (beforeId) {
    const before = await c.env.DB.prepare(`SELECT id, [order] AS order_value FROM "${tn}" WHERE id = ? AND ${activeRowClause()}`)
      .bind(beforeId)
      .first<{ id: number; order_value: number }>();
    if (!before) throw new DoesNotExist("Row", beforeId);
    const previous = await c.env.DB.prepare(
      `SELECT [order] AS order_value
       FROM "${tn}"
       WHERE id != ? AND id != ? AND ${activeRowClause()} AND [order] < ?
       ORDER BY [order] DESC, id DESC
       LIMIT 1`
    )
      .bind(rowId, beforeId, before.order_value)
      .first<{ order_value: number }>();
    newOrder = previous
      ? (Number(previous.order_value) + Number(before.order_value)) / 2
      : Number(before.order_value) - 10000;
  } else {
    const maxOrder = await c.env.DB.prepare(`SELECT COALESCE(MAX([order]), 0) AS max_order FROM "${tn}" WHERE id != ? AND ${activeRowClause()}`)
      .bind(rowId)
      .first<{ max_order: number }>();
    newOrder = (maxOrder?.max_order || 0) + 10000;
  }

  const now = new Date().toISOString();
  const sets = ["[order] = ?", "_updated_on = ?", "_last_modified_by_id = ?"];
  const vals: unknown[] = [newOrder, now, user.id];
  for (const field of fields) {
    if (field.type === "last_modified") {
      sets.push(`"field_${field.id}" = ?`);
      vals.push(now);
    } else if (field.type === "last_modified_by") {
      sets.push(`"field_${field.id}" = ?`);
      vals.push(serializeFieldValueForInsert(field.type, userCell(user)));
    }
  }
  vals.push(rowId);

  await c.env.DB.prepare(`UPDATE "${tn}" SET ${sets.join(", ")} WHERE id = ? AND ${activeRowClause()}`)
    .bind(...vals)
    .run();

  const row = await c.env.DB.prepare(`SELECT * FROM "${tn}" WHERE id = ? AND ${activeRowClause()}`).bind(rowId).first<Record<string, unknown>>();
  if (!row) throw new DoesNotExist("Row", rowId);
  const serialized = await serializeRowWithNames(c.env.DB, row, fields, false);
  const historyEntry = await createRowHistoryEntry(c.env.DB, {
    user,
    tableId,
    rowId,
    actionType: "move_row",
    before: { order: beforeRow.order ?? null },
    after: { order: row.order ?? null },
    fields,
    ...rowHistoryActionContext(c, tableId),
    beforeRow,
    afterRow: row,
  });
  const auditCtx = await getTableAuditContext(c.env.DB, tableId);
  await logAuditEntry(c.env.DB, "database.rows.move", {
    user,
    workspace_id: meta.workspace_id,
    workspace_name: auditCtx?.workspace_name,
    ip_address: clientIp(c),
  }, { id: rowId, type: "row" }, {
    table_id: tableId,
    table_name: auditCtx?.table_name || "",
    row_id: rowId,
    before_id: beforeId,
  });
  const wsId = c.get("websocket_id") || "";
  await broadcastToWorkspace(c.env, meta.workspace_id, {
    type: "rows_updated",
    table_id: tableId,
    rows: [serialized],
    metadata: {
      updated_field_ids: [],
      cascade_update: { rows: [], field_ids: [] },
    },
  }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
  await broadcastToWorkspace(c.env, meta.workspace_id, {
    type: "row_history_updated",
    table_id: tableId,
    row_id: rowId,
    row_history_entry: historyEntry,
  }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
  const automationRow = await serializeRowWithNames(c.env.DB, row, fields, true);
  const oldAutomationRow = await serializeRowWithNames(c.env.DB, beforeRow, fields, true);
  c.executionCtx.waitUntil(triggerRowSideEffects(c.env, tableId, "rows.updated", {
    items: [automationRow],
    old_items: [oldAutomationRow],
    updated_field_ids: [],
  }));

  return c.json(serialized);
});

// ── GET /api/database/rows/table/:tableId/:rowId/adjacent/ ──────────────────
rows.get("/table/:tableId/:rowId/adjacent/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const tableId = Number(c.req.param("tableId"));
  const rowId = Number(c.req.param("rowId"));
  await requireAccess(c.env.DB, user?.id, tableId, "VIEWER", c.get("db_token_permissions"), "read");
  const previous = c.req.query("previous") === "true";
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  const current = await c.env.DB.prepare(`SELECT [order] AS order_value FROM "${tn}" WHERE id = ? AND ${activeRowClause()}`)
    .bind(rowId)
    .first<{ order_value: number }>();
  if (!current) throw new DoesNotExist("Row", rowId);

  const row = await c.env.DB.prepare(
    `SELECT * FROM "${tn}" WHERE ${activeRowClause()} AND [order] ${previous ? "<" : ">"} ? ORDER BY [order] ${previous ? "DESC" : "ASC"} LIMIT 1`
  )
    .bind(current.order_value)
    .first<Record<string, unknown>>();

  if (!row) return c.json(null);

  const fields = await getActiveFields(c.env.DB, tableId);
  return c.json(await serializeRowWithNames(c.env.DB, row, fields, false));
});

// ── DELETE /api/database/rows/table/:tableId/:rowId/ ─────────────────────────
rows.delete("/table/:tableId/:rowId/", databaseTokenAuthMiddleware(), async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const rowId = parseInt(c.req.param("rowId"));
  const meta = await requireAccess(c.env.DB, user.id, tableId, "MEMBER", c.get("db_token_permissions"), "delete");
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  const fields = await getActiveFields(c.env.DB, tableId);
  const beforeRow = await c.env.DB.prepare(`SELECT * FROM "${tn}" WHERE id=? AND ${activeRowClause()}`).bind(rowId).first<Record<string, unknown>>();
  if (!beforeRow) throw new DoesNotExist("Row", rowId);

  await recordRowTrash(c.env.DB, tableId, meta.workspace_id, meta.database_id, user.id, beforeRow, fields);
  await c.env.DB.prepare(
    `UPDATE "${tn}"
        SET trashed=1, _updated_on=?, _last_modified_by_id=?
      WHERE id=? AND ${activeRowClause()}`
  ).bind(new Date().toISOString(), user.id, rowId).run();
  await synchronizeLinkRowRelations(c.env.DB, tableId, rowId, beforeRow, null, null);
  const historyEntry = await createRowHistoryEntry(c.env.DB, {
    user,
    tableId,
    rowId,
    actionType: "delete_row",
    before: rowFieldValues(beforeRow, fields),
    after: {},
    fields,
    ...rowHistoryActionContext(c, tableId),
    beforeRow,
    afterRow: null,
  });
  const auditCtx = await getTableAuditContext(c.env.DB, tableId);
  await logAuditEntry(c.env.DB, "database.rows.delete", {
    user,
    workspace_id: meta.workspace_id,
    workspace_name: auditCtx?.workspace_name,
    ip_address: clientIp(c),
  }, { id: rowId, type: "row" }, {
    table_id: tableId,
    table_name: auditCtx?.table_name || "",
    row_id: rowId,
    count: 1,
  });

  await broadcastToWorkspace(c.env, meta.workspace_id, {
    type: "rows_deleted",
    table_id: tableId,
    row_ids: [rowId],
    rows: [await serializeRowWithNames(c.env.DB, beforeRow, fields, false)],
  }, { pageFilter: `table-${tableId}` });
  await broadcastToWorkspace(c.env, meta.workspace_id, {
    type: "row_history_updated",
    table_id: tableId,
    row_id: rowId,
    row_history_entry: historyEntry,
  }, { pageFilter: `table-${tableId}` });
  const automationRow = await serializeRowWithNames(c.env.DB, beforeRow, fields, true);
  c.executionCtx.waitUntil(triggerRowSideEffects(c.env, tableId, "rows.deleted", { items: [automationRow], row_ids: [rowId] }));
  c.executionCtx.waitUntil(pushPostgresqlTwoWayRowsDeleted(c.env, tableId, [beforeRow]));
  c.executionCtx.waitUntil(triggerRelatedTableRowUpdateWebhooks(c.env, tableId, fields, [{
    before: beforeRow,
    after: null,
    updatedFieldIds: null,
  }]));

  return c.json({});
});

// ── POST /api/database/rows/table/:tableId/batch/ — Batch create ──────────────
rows.post("/table/:tableId/batch/", databaseTokenAuthMiddleware(), async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const meta = await requireAccess(c.env.DB, user.id, tableId, "MEMBER", c.get("db_token_permissions"), "create");
  const body = await c.req.json<{ items: Record<string, unknown>[] }>();

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new ValidationError("items must be a non-empty array.");
  }
  if (body.items.length > BATCH_ROWS_SIZE_LIMIT) {
    throw new ValidationError(`Cannot batch create more than ${BATCH_ROWS_SIZE_LIMIT} rows at once.`);
  }

  const fields = await getActiveFields(c.env.DB, tableId);
  const useFieldNames = truthyQueryParam(c.req.query("user_field_names"));
  const includeMetadata = truthyQueryParam(c.req.query("include_metadata"));
  const beforeId = optionalRowId(c.req.query("before"), "before");
  const insertionOrders = await allocateInsertionOrders(c.env.DB, tableId, body.items.length, beforeId);
  const requestedFields = new Map<number, FieldMeta>();
  for (const item of body.items) {
    for (const field of requestedWritableFields(fields, item, useFieldNames)) requestedFields.set(field.id, field);
  }
  await assertCanWriteFieldValues(c.env.DB, user.id, meta, Array.from(requestedFields.values()));
  const tn = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  const now = new Date().toISOString();
  const insertedRows: Array<{ row: Record<string, unknown>; changedFieldIds: Set<number> }> = [];
  const autonumberRanges = await allocateAutonumberRanges(c.env.DB, tableId, body.items.length);
  const linkTargets = new LinkTargetCache(c.env.DB);
  for (const field of fields) {
    const targetTableId = Number(field.settings?.link_row_table_id || 0);
    if (field.type !== "link_row" || !targetTableId) continue;
    const ids = body.items.flatMap((item) => {
      const value = item[`field_${field.id}`] ?? (useFieldNames ? item[field.name] : undefined);
      return (Array.isArray(value) ? value : [value]).map((entry) => Number(
        entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : entry
      )).filter((id) => Number.isInteger(id) && id > 0);
    });
    await linkTargets.prefetch(targetTableId, ids);
  }

  for (const [index, item] of body.items.entries()) {
    const cols = ["[order]", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id"];
    const vals: unknown[] = [insertionOrders[index], now, now, user.id, user.id];
    const changedFieldIds = new Set<number>();
    for (const field of fields) {
      const key = `field_${field.id}`;
      const bodyKey = key in item ? key : useFieldNames ? field.name : key;
      if (isGeneratedField(field)) {
        const generated = generatedCreateValue(field, null, now, user);
        if (generated !== undefined && field.type !== "autonumber" && field.type !== "auto_number") {
          cols.push(`"${key}"`);
          vals.push(serializeFieldValueForInsert(field.type, generated));
        }
      } else if (isWritableInputField(field)) {
        const value = await serializeCreateValue(c.env.DB, field, item, bodyKey, changedFieldIds, c.env, meta.workspace_id, linkTargets);
        if (value !== undefined) {
          cols.push(`"${key}"`);
          vals.push(value);
        }
      }
    }
    const existingFieldIds = new Set(cols.flatMap((column) => {
      const match = column.match(/^"field_(\d+)"$/);
      return match ? [Number(match[1])] : [];
    }));
    const missingValues = await missingCreateFieldValues(c.env.DB, fields, existingFieldIds, {
      now,
      user,
      fileContext: c.env,
      workspaceId: meta.workspace_id,
    });
    for (const [fieldId, value] of missingValues) {
      cols.push(`"field_${fieldId}"`);
      vals.push(value);
    }
    for (const [fieldId, values] of autonumberRanges) {
      cols.push(`"field_${fieldId}"`);
      vals.push(serializeFieldValueForInsert("autonumber", values[index]));
    }
    const ph = cols.map(() => "?").join(", ");
    const row = await c.env.DB.prepare(
      `INSERT INTO "${tn}" (${cols.join(", ")}) VALUES (${ph}) RETURNING *`
    )
      .bind(...vals)
      .first<Record<string, unknown>>();
    if (row) insertedRows.push({ row, changedFieldIds });
  }

  // Side effects run once per batch rather than once per row, so a full
  // 200-row batch stays well within D1's per-invocation query limit.
  if (await hasActiveDateDependencyRules(c.env.DB, tableId)) {
    for (const { row, changedFieldIds } of insertedRows) {
      await applyDateDependencyRules(c.env.DB, tableId, Number(row.id), changedFieldIds);
    }
  }
  const finalRows = await selectActiveRowsByIds(c.env.DB, tableId, insertedRows.map(({ row }) => Number(row.id)));
  const created = insertedRows.map(({ row, changedFieldIds }) => ({ row: finalRows.get(Number(row.id)) || row, changedFieldIds }));
  const writeEffects = rowWriteEffectFields(fields);
  await synchronizeLinkRowRelationsBatch(c.env.DB, tableId, created
    .filter(({ changedFieldIds }) => writeEffects.touchesLinks(changedFieldIds))
    .map(({ row, changedFieldIds }) => ({ rowId: Number(row.id), before: null, after: row, changedFieldIds })));
  const aiUpdateGroups = new Map<string, { rowIds: number[]; changedFieldIds: Set<number> }>();
  for (const { row, changedFieldIds } of created) {
    if (writeEffects.touchesCollaborators(changedFieldIds)) {
      await notifyNewCollaborators(c.env.DB, tableId, Number(row.id), null, row, changedFieldIds, user.id, c.env);
    }
    const groupKey = [...changedFieldIds].sort((left, right) => left - right).join(",");
    const group = aiUpdateGroups.get(groupKey) || { rowIds: [], changedFieldIds };
    group.rowIds.push(Number(row.id));
    aiUpdateGroups.set(groupKey, group);
  }
  for (const group of aiUpdateGroups.values()) {
    await enqueueAutomaticAIUpdates(c.env, tableId, group.rowIds, group.changedFieldIds);
  }
  const createdRows = writeEffects.hasSelfLinks(tableId)
    ? await (async () => {
      const refreshed = await selectActiveRowsByIds(c.env.DB, tableId, created.map(({ row }) => Number(row.id)));
      return created.map(({ row }) => refreshed.get(Number(row.id)) || row);
    })()
    : created.map(({ row }) => row);
  const historyEntries: Array<{ rowId: number; entry: unknown }> = [];
  for (const { row: finalRow } of created) {
    historyEntries.push({
      rowId: Number(finalRow.id),
      entry: await createRowHistoryEntry(c.env.DB, {
        user,
        tableId,
        rowId: Number(finalRow.id),
        actionType: "create_rows",
        before: {},
        after: rowFieldValues(finalRow, fields),
        fields,
        ...rowHistoryActionContext(c, tableId),
        beforeRow: null,
        afterRow: finalRow,
      }),
    });
  }

  const items = await serializeRowsWithNames(c.env.DB, createdRows, fields, useFieldNames);
  const wsId = c.get("websocket_id") || "";
  for (const history of historyEntries) {
    await broadcastToWorkspace(c.env, meta.workspace_id, {
      type: "row_history_updated",
      table_id: tableId,
      row_id: history.rowId,
      row_history_entry: history.entry,
    }, { excludeWebsocketId: wsId, pageFilter: `table-${tableId}` });
  }
  if (createdRows.length > 0) {
    const auditCtx = await getTableAuditContext(c.env.DB, tableId);
    await logAuditEntry(c.env.DB, "database.rows.create", {
      user,
      workspace_id: meta.workspace_id,
      workspace_name: auditCtx?.workspace_name,
      ip_address: clientIp(c),
    }, { id: tableId, type: "table" }, {
      table_id: tableId,
      table_name: auditCtx?.table_name || "",
      count: createdRows.length,
    });
  }
  const automationItems = await serializeRowsWithNames(c.env.DB, createdRows, fields, true);
  c.executionCtx.waitUntil(triggerRowSideEffects(c.env, tableId, "rows.created", { items: automationItems }));
  c.executionCtx.waitUntil(pushPostgresqlTwoWayRowsCreated(c.env, tableId, createdRows));
  c.executionCtx.waitUntil(triggerRelatedTableRowUpdateWebhooks(c.env, tableId, fields, createdRows.map((row) => ({
    before: null,
    after: row,
    updatedFieldIds: null,
  }))));
  c.executionCtx.waitUntil(triggerRowsEnteredViewWebhooks(c.env, tableId, new Map(), createdRows.map((row) => Number(row.id))));
  const payload: Record<string, unknown> = { items, count: items.length };
  if (includeMetadata) {
    payload.metadata = operationMetadata(fields);
  }
  return c.json(payload);
});

// ── POST /api/database/rows/table/:tableId/batch-delete/ ────────────────────
rows.post("/table/:tableId/batch-delete/", databaseTokenAuthMiddleware(), batchDeleteRows);

export { rows as rowRouter };
