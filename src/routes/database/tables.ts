import { Hono } from "hono";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware, optionalAuthMiddleware } from "../../middleware/auth";
import { DoesNotExist, PermissionError, ValidationError } from "../../middleware/error";
import { broadcastToWorkspace } from "../../durable-objects/workspace-room";
import { getOrCreateUserTable, dropUserTable, addFieldColumn, ensureUserTableSystemColumns, serializeFieldValueForInsert, type FieldMeta, type FieldType } from "../../services/dynamic-tables";
import { serializeFieldValueForStorage } from "../../services/field-values";
import { isTemplateWorkspace } from "../../services/templates";
import { serializeDatabaseTable } from "../../services/database-serializers";
import { recordTrashEntry } from "../../services/trash";
import { isReadOnlyFieldType } from "../../services/field-serialization";
import { duplicateViewDependencies } from "../../services/view-duplication";
import { assertHasApplicationRole, assertHasTableRole } from "../../services/enterprise-permissions";
import { logAuditEntry } from "../../services/audit-log";
import { duplicateDatabaseTable } from "../../services/table-duplication";
import { allocateAutonumberValues } from "../../services/autonumber";
import { missingCreateFieldValues } from "../../services/row-create-values";
import {
  finalizeRowWrite,
  insertedRowId,
  modifiedFieldValues,
  tableHasRowWriteEffects,
} from "../../services/row-write-effects";

const tables = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

interface TableRow {
  id: number;
  name: string;
  order: number;
  database_id: number;
  needs_background_update_column_added: number;
  last_modified_by_column_added: number;
  created_by_column_added: number;
  version: number;
  data_sync_id?: number | null;
}

type FieldRow = {
  id: number;
  name: string;
  type: FieldType;
  order: number;
  primary?: number;
  read_only?: number;
  description?: string | null;
  db_index?: number;
  immutable_type?: number;
  immutable_properties?: number;
  field_settings?: string | null;
};

type SelectOptionCopy = { id: number; value: string; color: string; option_order: number };
type SelectOptionValue = { id: number; value: string; color: string };
type PendingLinkValue = { rowId: number; fieldId: number; targetSourceTableId: number; value: unknown };

async function requireDatabaseAccess(
  db: D1Database,
  userId: number | undefined,
  databaseId: number,
  requiredRole = "VIEWER"
): Promise<{ workspace_id: number }> {
  const app = await db
    .prepare("SELECT id, workspace_id FROM core_application WHERE id = ? AND trashed = 0")
    .bind(databaseId)
    .first<{ id: number; workspace_id: number }>();

  if (!app) throw new DoesNotExist("Database", databaseId);
  if (requiredRole === "VIEWER" && await isTemplateWorkspace(db, app.workspace_id)) {
    return { workspace_id: app.workspace_id };
  }
  await assertHasApplicationRole(db, userId, databaseId, requiredRole);

  return { workspace_id: app.workspace_id };
}

async function requireTableAccess(
  db: D1Database,
  userId: number | undefined,
  table: TableRow,
  requiredRole = "VIEWER"
): Promise<{ workspace_id: number }> {
  const app = await db
    .prepare("SELECT id, workspace_id FROM core_application WHERE id = ? AND trashed = 0")
    .bind(table.database_id)
    .first<{ id: number; workspace_id: number }>();
  if (!app) throw new DoesNotExist("Database", table.database_id);
  if (requiredRole === "VIEWER" && await isTemplateWorkspace(db, app.workspace_id)) {
    return { workspace_id: app.workspace_id };
  }
  await assertHasTableRole(db, userId, { id: table.id, database_id: table.database_id, workspace_id: app.workspace_id }, requiredRole);
  return { workspace_id: app.workspace_id };
}

async function serializeTable(table: TableRow, db: D1Database): Promise<object> {
  return serializeDatabaseTable(db, table);
}

async function tableAuditDetails(db: D1Database, tableId: number) {
  return db.prepare(
    `SELECT t.id AS table_id, t.name AS table_name, t.database_id,
            a.name AS application_name, a.workspace_id, w.name AS workspace_name
       FROM database_table t
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspace w ON w.id=a.workspace_id
      WHERE t.id=?`
  ).bind(tableId).first<any>();
}

async function createFinishedJob(
  db: D1Database,
  userId: number,
  type: string,
  values: Record<string, unknown>
): Promise<object> {
  const now = new Date().toISOString();
  const result = {
    report: { failing_rows: {} },
    ...values,
  };
  const job = await db.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
     VALUES (?, 'finished', 100, ?, ?, ?, ?) RETURNING *`
  ).bind(type, userId, now, now, JSON.stringify(result)).first<any>();

  return {
    id: job?.id,
    type,
    state: "finished",
    status: "finished",
    progress_percentage: 100,
    created_on: now,
    updated_on: now,
    ...result,
  };
}

async function getTableFields(db: D1Database, tableId: number): Promise<FieldMeta[]> {
  const fields = await db.prepare(
    `SELECT id, name, type, "primary" AS is_primary, read_only, field_settings, [order] AS field_order
     FROM database_field
     WHERE table_id = ? AND trashed = 0
     ORDER BY [order] ASC, id ASC`
  )
    .bind(tableId)
    .all<any>();
  return (fields.results || []).map((field) => {
    let settings: Record<string, unknown> = {};
    try {
      settings = field.field_settings ? JSON.parse(field.field_settings) : {};
    } catch {
      settings = {};
    }
    return {
      id: field.id,
      name: field.name,
      type: field.type,
      primary: Boolean(field.is_primary),
      order: Number(field.field_order || 0),
      readOnly: Boolean(field.read_only) || isReadOnlyFieldType(field.type),
      settings,
    };
  });
}

function getWritableImportFields(fields: FieldMeta[]): FieldMeta[] {
  return fields
    .filter((field) => !field.readOnly && !isReadOnlyFieldType(field.type))
    .sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      const orderDiff = Number(a.order || 0) - Number(b.order || 0);
      return orderDiff || a.id - b.id;
    });
}

type ImportFailure = Record<string, string[]>;

function importFieldFailure(field: FieldMeta, error: unknown): ImportFailure {
  const message = error instanceof Error ? error.message : String(error || "Invalid value.");
  return { [`field_${field.id}`]: [message] };
}

function storageMatchKey(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return `object:${JSON.stringify(value)}`;
  return `${typeof value}:${String(value)}`;
}

async function normalizeUpsertKey(
  db: D1Database,
  fieldsById: Map<number, FieldMeta>,
  fieldIds: number[],
  values: unknown[],
  fileUrlContext?: unknown,
  workspaceId?: number | null
): Promise<string> {
  const parts = [];
  for (let index = 0; index < fieldIds.length; index += 1) {
    const field = fieldsById.get(fieldIds[index]);
    if (!field) throw new ValidationError("configuration.upsert_fields contains a field that does not belong to this table.");
    const stored = await serializeFieldValueForStorage(db, field, values[index], fileUrlContext as any, workspaceId);
    parts.push(`${field.id}=${storageMatchKey(stored)}`);
  }
  return parts.join("|");
}

function storedRowUpsertKey(upsertFieldIds: number[], row: Record<string, unknown>): string {
  return upsertFieldIds
    .map((fieldId) => `${fieldId}=${storageMatchKey(row[`field_${fieldId}`])}`)
    .join("|");
}

async function tableRowsByUpsertKey(
  db: D1Database,
  tableId: number,
  upsertFieldIds: number[]
): Promise<Map<string, any[]>> {
  const tableName = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(db, tableId);
  const rows = await db.prepare(
    `SELECT *
       FROM "${tableName}"
      WHERE COALESCE(trashed, 0) = 0
      ORDER BY [order] ASC, id ASC`
  ).all<any>();
  const result = new Map<string, any[]>();
  for (const row of rows.results || []) {
    const key = storedRowUpsertKey(upsertFieldIds, row);
    const bucket = result.get(key) || [];
    bucket.push(row);
    result.set(key, bucket);
  }
  return result;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function remapId(value: unknown, map: Map<number, number>): unknown {
  if (value === null || value === undefined) return value;
  const id = Number(value);
  return Number.isFinite(id) && map.has(id) ? map.get(id) : value;
}

function remapSelectOptionValue(value: unknown, selectOptionMap: Map<number, SelectOptionValue>): SelectOptionValue | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseMaybeJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const raw = parsed as Record<string, unknown>;
    const id = Number(raw.id);
    if (Number.isFinite(id) && selectOptionMap.has(id)) return selectOptionMap.get(id)!;
    const label = String(raw.value ?? "").trim();
    return label ? [...selectOptionMap.values()].find((option) => option.value === label) || null : null;
  }
  const id = Number(parsed);
  return Number.isFinite(id) ? selectOptionMap.get(id) || null : null;
}

function remapSelectCellValue(type: FieldType, value: unknown, selectOptionMap: Map<number, SelectOptionValue>): string | null {
  if (value === null || value === undefined || value === "") {
    return type === "multiple_select" ? JSON.stringify([]) : null;
  }
  const parsed = parseMaybeJson(value);
  if (type === "multiple_select") {
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return JSON.stringify(items.map((item) => remapSelectOptionValue(item, selectOptionMap)).filter(Boolean));
  }
  const option = remapSelectOptionValue(parsed, selectOptionMap);
  return option ? JSON.stringify(option) : null;
}

function remapLinkRowValue(value: unknown, rowMap: Map<number, number>): unknown[] {
  const parsed = parseMaybeJson(value);
  if (parsed === null || parsed === undefined || parsed === "") return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if (item && typeof item === "object") {
      const raw = item as Record<string, unknown>;
      return { ...raw, id: remapId(raw.id, rowMap) };
    }
    return { id: remapId(item, rowMap), value: String(item ?? "") };
  });
}

function remapDuplicatedTableFieldSettings(
  field: FieldRow,
  sourceTableId: number,
  duplicatedTableId: number,
  fieldMap: Map<number, number>,
  selectOptionMap: Map<number, SelectOptionValue>
): Record<string, unknown> {
  const parsed = parseMaybeJson(field.field_settings || "{}");
  const settings = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};

  for (const key of ["through_field_id", "target_field_id", "link_row_related_field_id"]) {
    if (settings[key] !== undefined && settings[key] !== null) settings[key] = remapId(settings[key], fieldMap);
  }

  if (Number(settings.link_row_table_id) === sourceTableId) {
    settings.link_row_table_id = duplicatedTableId;
  }

  if (field.type === "single_select" && settings.single_select_default !== undefined && settings.single_select_default !== null) {
    settings.single_select_default = remapSelectOptionValue(settings.single_select_default, selectOptionMap)?.id ?? null;
  }

  if (field.type === "multiple_select" && Array.isArray(settings.multiple_select_default)) {
    settings.multiple_select_default = settings.multiple_select_default
      .map((item) => remapSelectOptionValue(item, selectOptionMap)?.id)
      .filter((id): id is number => typeof id === "number");
  }

  return settings;
}

async function duplicateSelectOptionsForTable(
  db: D1Database,
  sourceFieldId: number,
  duplicatedFieldId: number,
  selectOptionMap: Map<number, SelectOptionValue>
) {
  const options = await db.prepare(
    `SELECT id, value, color, [order] AS option_order
     FROM database_selectoption
     WHERE field_id=?
     ORDER BY [order] ASC, id ASC`
  ).bind(sourceFieldId).all<SelectOptionCopy>();

  for (const option of options.results || []) {
    const duplicated = await db.prepare(
      `INSERT INTO database_selectoption (field_id, value, color, [order])
       VALUES (?, ?, ?, ?)
       RETURNING id, value, color`
    ).bind(
      duplicatedFieldId,
      option.value,
      option.color || "blue",
      option.option_order
    ).first<SelectOptionValue>();
    if (duplicated) {
      selectOptionMap.set(option.id, {
        id: duplicated.id,
        value: duplicated.value,
        color: duplicated.color || "blue",
      });
    }
  }
}

async function copyDuplicatedTableRows(
  db: D1Database,
  sourceTableId: number,
  duplicatedTableId: number,
  fields: FieldRow[],
  fieldMap: Map<number, number>,
  selectOptionMap: Map<number, SelectOptionValue>,
  now: string
): Promise<Map<number, number>> {
  await ensureUserTableSystemColumns(db, sourceTableId);
  const rows = await db.prepare(
    `SELECT * FROM "database_table_${sourceTableId}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC`
  ).all<Record<string, unknown>>();
  const rowMap = new Map<number, number>();
  const pendingLinkValues: PendingLinkValue[] = [];

  for (const row of rows.results || []) {
    const columns = ["[order]", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id"];
    const values: unknown[] = [
      row.order ?? 10000,
      row._created_on ?? now,
      row._updated_on ?? now,
      row._created_by_id ?? null,
      row._last_modified_by_id ?? null,
    ];

    for (const field of fields) {
      const duplicatedFieldId = fieldMap.get(field.id);
      if (!duplicatedFieldId) continue;
      if (field.type === "link_row") continue;
      columns.push(`"field_${duplicatedFieldId}"`);
      const sourceValue = row[`field_${field.id}`];
      if (field.type === "single_select" || field.type === "multiple_select") {
        values.push(remapSelectCellValue(field.type, sourceValue, selectOptionMap));
      } else {
        values.push(sourceValue ?? null);
      }
    }

    const marks = columns.map(() => "?").join(", ");
    const inserted = await db.prepare(
      `INSERT INTO "database_table_${duplicatedTableId}" (${columns.join(", ")})
       VALUES (${marks})
       RETURNING id`
    ).bind(...values).first<{ id: number }>();
    if (inserted?.id) {
      rowMap.set(Number(row.id), Number(inserted.id));
      for (const field of fields.filter((item) => item.type === "link_row")) {
        const duplicatedFieldId = fieldMap.get(field.id);
        if (!duplicatedFieldId) continue;
        const settings = parseMaybeJson(field.field_settings || "{}") as Record<string, unknown>;
        pendingLinkValues.push({
          rowId: Number(inserted.id),
          fieldId: duplicatedFieldId,
          targetSourceTableId: Number(settings?.link_row_table_id || sourceTableId),
          value: row[`field_${field.id}`],
        });
      }
    }
  }

  for (const pending of pendingLinkValues) {
    const targetRowMap = pending.targetSourceTableId === sourceTableId ? rowMap : new Map<number, number>();
    const value = remapLinkRowValue(pending.value, targetRowMap);
    await db.prepare(`UPDATE "database_table_${duplicatedTableId}" SET "field_${pending.fieldId}"=? WHERE id=?`)
      .bind(serializeFieldValueForInsert("link_row", value), pending.rowId)
      .run();
  }

  return rowMap;
}

// ── GET /api/database/tables/database/:databaseId/ ─────────────────────────
tables.get("/database/:databaseId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const databaseId = parseInt(c.req.param("databaseId"));

  await requireDatabaseAccess(c.env.DB, user?.id, databaseId);

  const result = await c.env.DB.prepare(
    `SELECT * FROM database_table WHERE database_id = ? AND trashed = 0 ORDER BY [order] ASC`
  )
    .bind(databaseId)
    .all<TableRow>();

  const tablesInDatabase = result.results || [];
  const visible = await Promise.all(tablesInDatabase.map(async (table) => {
    if (!user?.id) return true;
    try {
      await requireTableAccess(c.env.DB, user.id, table);
      return true;
    } catch (error) {
      if (error instanceof PermissionError) return false;
      throw error;
    }
  }));
  const visibleTables = tablesInDatabase.filter((_, index) => visible[index]);
  const serialized = await Promise.all(visibleTables.map(t => serializeTable(t, c.env.DB)));
  return c.json(serialized);
});

// ── POST /api/database/tables/database/:databaseId/ — Create table ──────────
tables.post("/database/:databaseId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const databaseId = parseInt(c.req.param("databaseId"));
  const body = await c.req.json<{ name: string; data?: any[][] }>();

  const { workspace_id } = await requireDatabaseAccess(c.env.DB, user.id, databaseId, "BUILDER");

  if (!body.name?.trim()) throw new ValidationError("name is required.");

  // Get max order
  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX([order]), 0) as max_order FROM database_table WHERE database_id = ?`
  )
    .bind(databaseId)
    .first<{ max_order: number }>();

  const now = new Date().toISOString();
  const tableResult = await c.env.DB.prepare(
    `INSERT INTO database_table (name, [order], database_id, version, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0) RETURNING id`
  )
    .bind(body.name.trim(), (maxOrder?.max_order ?? 0) + 1, databaseId, now, now)
    .first<{ id: number }>();

  if (!tableResult) throw new Error("Failed to create table");
  const tableId = tableResult.id;

  // Create primary field (Name/text field)
  const primaryFieldResult = await c.env.DB.prepare(
    `INSERT INTO database_field (table_id, name, type, [order], "primary", read_only, trashed, created_on, updated_on, db_index)
     VALUES (?, 'Name', 'text', 1, 1, 0, 0, ?, ?, 0) RETURNING id`
  )
    .bind(tableId, now, now)
    .first<{ id: number }>();

  // Create the actual user table in D1
  await getOrCreateUserTable(c.env.DB, tableId);

  // Add the primary text column to the user table
  if (primaryFieldResult) {
    await addFieldColumn(c.env.DB, tableId, { id: primaryFieldResult.id, type: "text", primary: true });
  }

  // Create default Grid view
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const gridView = await c.env.DB.prepare(
    `INSERT INTO database_view (table_id, name, type, [order], filter_type, public,
     public_view_password, slug, trashed, created_on, updated_on,
     row_identifier_type, ownership_type, row_height_size, filters_disabled)
     VALUES (?,'Grid','grid',1,'AND',0,0,?,0,?,?,'count','collaborative','small',0) RETURNING id`
  ).bind(tableId, slug, now, now).first<{ id: number }>();

  // Initialize grid field options for primary field
  if (gridView && primaryFieldResult) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order])
       VALUES (?,?,200,0,32768)`
    ).bind(gridView.id, primaryFieldResult.id).run();
  }

  const table = await c.env.DB.prepare("SELECT * FROM database_table WHERE id = ?")
    .bind(tableId)
    .first<TableRow>();

  // Broadcast to workspace
  await broadcastToWorkspace(c.env, workspace_id, {
    type: "table_created",
    table: await serializeTable(table!, c.env.DB),
  });
  const audit = await tableAuditDetails(c.env.DB, tableId);
  await logAuditEntry(c.env.DB, "database.table.create", {
    user,
    workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: tableId, type: "table" }, {
    database_id: databaseId,
    application_name: audit?.application_name,
    table_id: tableId,
    table_name: audit?.table_name || table?.name,
  });

  return c.json(await serializeTable(table!, c.env.DB), 200);
});

// ── POST /api/database/tables/database/:databaseId/async/ ───────────────────
tables.post("/database/:databaseId/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const databaseId = parseInt(c.req.param("databaseId"));
  const body = await c.req.json<{ name: string; data?: any[][] }>();

  const { workspace_id } = await requireDatabaseAccess(c.env.DB, user.id, databaseId, "BUILDER");
  if (!body.name?.trim()) throw new ValidationError("name is required.");

  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX([order]), 0) as max_order FROM database_table WHERE database_id = ?`
  )
    .bind(databaseId)
    .first<{ max_order: number }>();

  const now = new Date().toISOString();
  const tableResult = await c.env.DB.prepare(
    `INSERT INTO database_table (name, [order], database_id, version, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0) RETURNING id`
  )
    .bind(body.name.trim(), (maxOrder?.max_order ?? 0) + 1, databaseId, now, now)
    .first<{ id: number }>();
  if (!tableResult) throw new Error("Failed to create table");

  const primaryFieldResult = await c.env.DB.prepare(
    `INSERT INTO database_field (table_id, name, type, [order], "primary", read_only, trashed, created_on, updated_on, db_index)
     VALUES (?, 'Name', 'text', 1, 1, 0, 0, ?, ?, 0) RETURNING id`
  )
    .bind(tableResult.id, now, now)
    .first<{ id: number }>();
  await getOrCreateUserTable(c.env.DB, tableResult.id);
  if (primaryFieldResult) {
    await addFieldColumn(c.env.DB, tableResult.id, { id: primaryFieldResult.id, type: "text", primary: true });
  }

  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const view = await c.env.DB.prepare(
    `INSERT INTO database_view (table_id, name, type, [order], filter_type, public,
     public_view_password, slug, trashed, created_on, updated_on,
     row_identifier_type, ownership_type, row_height_size, filters_disabled)
     VALUES (?,'Grid','grid',1,'AND',0,0,?,0,?,?,'count','collaborative','small',0) RETURNING id`
  ).bind(tableResult.id, slug, now, now).first<{ id: number }>();
  if (view && primaryFieldResult) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order])
       VALUES (?,?,200,0,32768)`
    ).bind(view.id, primaryFieldResult.id).run();
  }

  const table = await c.env.DB.prepare("SELECT * FROM database_table WHERE id = ?")
    .bind(tableResult.id)
    .first<TableRow>();
  const serialized = await serializeTable(table!, c.env.DB);

  await broadcastToWorkspace(c.env, workspace_id, { type: "table_created", table: serialized });
  const audit = await tableAuditDetails(c.env.DB, tableResult.id);
  await logAuditEntry(c.env.DB, "database.table.create", {
    user,
    workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: tableResult.id, type: "table" }, {
    database_id: databaseId,
    application_name: audit?.application_name,
    table_id: tableResult.id,
    table_name: audit?.table_name || table?.name,
    async: true,
  });

  return c.json(await createFinishedJob(c.env.DB, user.id, "create_table", {
    table_id: tableResult.id,
    table: serialized,
  }), 202);
});

// ── GET /api/database/tables/:tableId/ ──────────────────────────────────────
tables.get("/:tableId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const tableId = parseInt(c.req.param("tableId"));

  const table = await c.env.DB.prepare("SELECT * FROM database_table WHERE id = ?")
    .bind(tableId)
    .first<TableRow>();

  if (!table) throw new DoesNotExist("Table", tableId);

  await requireTableAccess(c.env.DB, user?.id, table);

  return c.json(await serializeTable(table, c.env.DB));
});

// ── POST /api/database/tables/:tableId/import/async/ ────────────────────────
tables.post("/:tableId/import/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const body = await c.req.json<{ data: unknown[][]; configuration?: Record<string, unknown> }>();

  const table = await c.env.DB.prepare("SELECT * FROM database_table WHERE id = ? AND trashed = 0")
    .bind(tableId)
    .first<TableRow>();
  if (!table) throw new DoesNotExist("Table", tableId);

  const access = await requireTableAccess(c.env.DB, user.id, table, "EDITOR");
  if (!Array.isArray(body.data)) throw new ValidationError("data must be an array.");

  const rows = body.data;
  let fields = await getTableFields(c.env.DB, tableId);
  const writableFields = getWritableImportFields(fields);
  const now = new Date().toISOString();

  const fieldsById = new Map(fields.map((field) => [Number(field.id), field]));
  const configuration = body.configuration && typeof body.configuration === "object" && !Array.isArray(body.configuration)
    ? body.configuration
    : {};
  const upsertFieldIds = Array.isArray(configuration.upsert_fields)
    ? configuration.upsert_fields.map(Number).filter((fieldId) => Number.isInteger(fieldId) && fieldId > 0)
    : [];
  const upsertValues = Array.isArray(configuration.upsert_values) ? configuration.upsert_values : null;
  if (upsertFieldIds.length > 0 && (!upsertValues || upsertValues.length === 0)) {
    throw new ValidationError("configuration.upsert_values must not be empty when upsert_fields are provided.");
  }
  if (upsertValues && upsertValues.length !== rows.length) {
    throw new ValidationError("data and configuration.upsert_values should have the same length.");
  }
  if (upsertValues) {
    for (const values of upsertValues) {
      if (!Array.isArray(values) || values.length !== upsertFieldIds.length) {
        throw new ValidationError("configuration.upsert_values contains a row with an invalid length.");
      }
    }
  }
  for (const fieldId of upsertFieldIds) {
    const field = fieldsById.get(fieldId);
    if (!field || field.readOnly || isReadOnlyFieldType(field.type)) {
      throw new ValidationError("configuration.upsert_fields contains a field that cannot be used for upsert.");
    }
  }
  const skippedFieldIds = new Set<number>();
  if (Array.isArray(configuration.skipped_fields)) {
    for (const rawFieldId of configuration.skipped_fields) {
      const fieldId = Number(rawFieldId);
      if (!Number.isInteger(fieldId) || fieldId <= 0 || !fieldsById.has(fieldId)) {
        throw new ValidationError("configuration.skipped_fields contains a field that does not belong to this table.");
      }
      skippedFieldIds.add(fieldId);
    }
  }
  const existingRowsByUpsertKey = upsertFieldIds.length > 0
    ? await tableRowsByUpsertKey(c.env.DB, tableId, upsertFieldIds)
    : new Map<string, any[]>();
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  const maxOrderRow = await c.env.DB.prepare(`SELECT COALESCE(MAX([order]), 0) AS max_order FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0`).first<{ max_order: number }>();
  const baseOrder = Number(maxOrderRow?.max_order || 0);
  const tn = `database_table_${tableId}`;
  const needsRowWriteEffects = await tableHasRowWriteEffects(c.env.DB, tableId);
  let rowsCreated = 0;
  let rowsUpdated = 0;
  const failingRows: Record<string, ImportFailure> = {};
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    if (row.length > writableFields.length) {
      failingRows[String(rowIndex)] = { non_field_errors: ["Too many values in this line."] };
      continue;
    }
    const importValues = row.slice();
    while (importValues.length < writableFields.length) {
      importValues.push(null);
    }
    let matchedRow: any | null = null;
    if (upsertFieldIds.length > 0 && upsertValues) {
      const upsertRowValues = Array.isArray(upsertValues[rowIndex]) ? upsertValues[rowIndex] as unknown[] : [];
      const key = await normalizeUpsertKey(c.env.DB, fieldsById, upsertFieldIds, upsertRowValues, c.env, access.workspace_id);
      const bucket = existingRowsByUpsertKey.get(key) || [];
      matchedRow = bucket.shift() || null;
    }

    if (matchedRow) {
      const assignments = ["_updated_on = ?", "_last_modified_by_id = ?"];
      const vals: unknown[] = [now, user.id];
      const changedFieldIds = new Set<number>();
      for (let i = 0; i < writableFields.length; i++) {
        const field = writableFields[i];
        if (skippedFieldIds.has(field.id)) continue;
        assignments.push(`"field_${field.id}" = ?`);
        try {
          vals.push(await serializeFieldValueForStorage(c.env.DB, field, importValues[i], c.env, access.workspace_id));
          changedFieldIds.add(field.id);
        } catch (error) {
          failingRows[String(rowIndex)] = importFieldFailure(field, error);
          break;
        }
      }
      if (failingRows[String(rowIndex)]) continue;
      const modifiedValues = await modifiedFieldValues(c.env.DB, fields, now, user);
      for (const [fieldId, value] of modifiedValues) {
        assignments.push(`"field_${fieldId}" = ?`);
        vals.push(value);
      }
      vals.push(matchedRow.id);
      await c.env.DB.prepare(`UPDATE "${tn}" SET ${assignments.join(", ")} WHERE id = ?`).bind(...vals).run();
      if (needsRowWriteEffects) {
        await finalizeRowWrite(c.env.DB, tableId, Number(matchedRow.id), matchedRow, changedFieldIds, user.id, c.env);
      }
      rowsUpdated += 1;
      continue;
    }

    const cols = ["[order]", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id"];
    const vals: unknown[] = [baseOrder + ((rowsCreated + 1) * 10000), now, now, user.id, user.id];
    const changedFieldIds = new Set<number>();
    for (let i = 0; i < writableFields.length; i++) {
      const field = writableFields[i];
      cols.push(`"field_${field.id}"`);
      try {
        vals.push(await serializeFieldValueForStorage(c.env.DB, field, importValues[i], c.env, access.workspace_id));
        changedFieldIds.add(field.id);
      } catch (error) {
        failingRows[String(rowIndex)] = importFieldFailure(field, error);
        break;
      }
    }
    if (failingRows[String(rowIndex)]) continue;
    const existingFieldIds = new Set(cols.flatMap((column) => {
      const match = column.match(/^"field_(\d+)"$/);
      return match ? [Number(match[1])] : [];
    }));
    const missingValues = await missingCreateFieldValues(c.env.DB, fields, existingFieldIds, {
      now,
      user,
      fileContext: c.env,
      workspaceId: access.workspace_id,
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
    const insertResult = await c.env.DB.prepare(`INSERT INTO "${tn}" (${cols.join(", ")}) VALUES (${bindMarks})`)
      .bind(...vals)
      .run();
    const rowId = insertedRowId(insertResult);
    if (rowId && needsRowWriteEffects) {
      await finalizeRowWrite(c.env.DB, tableId, rowId, null, changedFieldIds, user.id, c.env);
    }
    rowsCreated += 1;
  }

  return c.json(await createFinishedJob(c.env.DB, user.id, "file_import", {
    table_id: tableId,
    rows_created: rowsCreated,
    rows_updated: rowsUpdated,
    report: { failing_rows: failingRows },
  }), 202);
});

// ── PATCH /api/database/tables/:tableId/ — Rename table ─────────────────────
tables.patch("/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const body = await c.req.json<{ name?: string }>();

  const table = await c.env.DB.prepare("SELECT * FROM database_table WHERE id = ?")
    .bind(tableId)
    .first<TableRow>();
  if (!table) throw new DoesNotExist("Table", tableId);

  const { workspace_id } = await requireTableAccess(c.env.DB, user.id, table, "BUILDER");

  if (body.name !== undefined) {
    await c.env.DB.prepare("UPDATE database_table SET name = ?, updated_on = ? WHERE id = ?")
      .bind(body.name.trim(), new Date().toISOString(), tableId)
      .run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM database_table WHERE id = ?")
    .bind(tableId)
    .first<TableRow>();

  await broadcastToWorkspace(c.env, workspace_id, {
    type: "table_updated",
    table_id: tableId,
    table: await serializeTable(updated!, c.env.DB),
  });
  const audit = await tableAuditDetails(c.env.DB, tableId);
  await logAuditEntry(c.env.DB, "database.table.update", {
    user,
    workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: tableId, type: "table" }, {
    database_id: table.database_id,
    table_id: tableId,
    table_name: updated?.name,
    before: body.name !== undefined ? { name: table.name } : {},
    after: body.name !== undefined ? { name: updated?.name } : {},
  });

  return c.json(await serializeTable(updated!, c.env.DB));
});

// ── DELETE /api/database/tables/:tableId/ ────────────────────────────────────
tables.delete("/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));

  const table = await c.env.DB.prepare("SELECT * FROM database_table WHERE id = ?")
    .bind(tableId)
    .first<TableRow>();
  if (!table) throw new DoesNotExist("Table", tableId);

  const { workspace_id } = await requireTableAccess(c.env.DB, user.id, table, "BUILDER");
  const app = await c.env.DB.prepare("SELECT id, name FROM core_application WHERE id=?")
    .bind(table.database_id)
    .first<{ id: number; name: string }>();

  const now = new Date().toISOString();
  await recordTrashEntry(c.env.DB, {
    userId: user.id,
    workspaceId: workspace_id,
    applicationId: table.database_id,
    trashItemType: "table",
    trashItemId: tableId,
    name: table.name,
    parentName: app?.name || "",
    trashedAt: now,
  });
  await c.env.DB.prepare("UPDATE database_table SET trashed = 1, updated_on = ? WHERE id = ?")
    .bind(now, tableId)
    .run();

  await broadcastToWorkspace(c.env, workspace_id, {
    type: "table_deleted",
    table_id: tableId,
    database_id: table.database_id,
  });
  const audit = await tableAuditDetails(c.env.DB, tableId);
  await logAuditEntry(c.env.DB, "database.table.delete", {
    user,
    workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: tableId, type: "table" }, {
    database_id: table.database_id,
    application_name: audit?.application_name || app?.name,
    table_id: tableId,
    table_name: table.name,
  });

  return c.json({});
});

// ── POST /api/database/tables/order/ — Reorder tables ───────────────────────
tables.post("/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ table_ids: number[] }>();

  if (!Array.isArray(body.table_ids)) throw new ValidationError("table_ids must be an array.");

  // Verify access on first table
  if (body.table_ids.length > 0) {
    const first = await c.env.DB.prepare("SELECT database_id FROM database_table WHERE id = ?")
      .bind(body.table_ids[0])
      .first<{ database_id: number }>();
    if (first) {
      await requireDatabaseAccess(c.env.DB, user.id, first.database_id, "BUILDER");
    }
  }

  const statements = body.table_ids.map((id, index) =>
    c.env.DB.prepare(`UPDATE database_table SET [order] = ? WHERE id = ?`).bind(index + 1, id)
  );

  await c.env.DB.batch(statements);

  return c.json({});
});

// ── POST /api/database/tables/database/:databaseId/order/ ───────────────────
tables.post("/database/:databaseId/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const databaseId = Number(c.req.param("databaseId"));
  const body = await c.req.json<{ table_ids: number[] }>();

  await requireDatabaseAccess(c.env.DB, user.id, databaseId, "BUILDER");
  if (!Array.isArray(body.table_ids)) throw new ValidationError("table_ids must be an array.");

  const statements = body.table_ids.map((id, index) =>
    c.env.DB.prepare(`UPDATE database_table SET [order] = ?, updated_on = ? WHERE id = ? AND database_id = ?`)
      .bind(index + 1, new Date().toISOString(), id, databaseId)
  );
  if (statements.length > 0) await c.env.DB.batch(statements);

  return c.json({});
});

// ── POST /api/database/tables/:tableId/duplicate/async/ ─────────────────────
tables.post("/:tableId/duplicate/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const source = await c.env.DB.prepare("SELECT * FROM database_table WHERE id = ? AND trashed = 0")
    .bind(tableId)
    .first<TableRow>();
  if (!source) throw new DoesNotExist("Table", tableId);

  await requireTableAccess(c.env.DB, user.id, source, "BUILDER");

  const duplicated = await duplicateDatabaseTable(c.env.DB, source.id);
  return c.json(await createFinishedJob(c.env.DB, user.id, "duplicate_table", {
    table_id: duplicated.duplicatedTable.id,
    original_table: duplicated.original_table,
    duplicated_table: duplicated.duplicated_table,
  }), 202);
});

export { tables as tableRouter };
