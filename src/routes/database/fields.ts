import { Hono } from "hono";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware, databaseTokenAllows, databaseTokenAuthMiddleware, optionalAuthMiddleware } from "../../middleware/auth";
import { ApiError, DoesNotExist, PermissionError, ValidationError } from "../../middleware/error";
import { broadcastToWorkspace } from "../../durable-objects/workspace-room";
import { templateWorkspaceSql } from "../../services/templates";
import {
  addFieldColumn,
  dropFieldColumn,
  ensureUserTableSystemColumns,
  type FieldDefinition,
  type FieldType,
} from "../../services/dynamic-tables";
import {
  isReadOnlyFieldType,
  normalizeFieldSettings,
  serializeDatabaseFieldRow,
} from "../../services/field-serialization";
import {
  FieldConfigurationError,
  validateComputedFieldSettings,
} from "../../services/field-validation";
import {
  inferFormulaNumberDecimalPlaces,
  mapFieldTypeToFormulaNullable,
  mapFieldTypeToFormulaType,
  validateFormulaType,
} from "../../services/formula-types";
import { convertExistingFieldValues } from "../../services/field-conversion";
import { recordTrashEntry } from "../../services/trash";
import { triggerTableWebhooks } from "./webhooks";
import { assertHasTableRole, readAfterAccessCheck } from "../../services/enterprise-permissions";
import { logAuditEntry } from "../../services/audit-log";
import { duplicateFieldDependencies } from "../../services/table-duplication";
import { synchronizeFieldDependencies } from "../../services/field-dependencies";
import { verifyPassword } from "../../services/user";
import { createUndoableAction } from "../../services/action-history";
import { snapshotFieldForUndoRedo, snapshotFieldIds } from "../../services/field-snapshots";
import { enabledGenerativeAIModels, promptGenerativeAI, workspaceGenerativeAISettings } from "../../services/generative-ai";
import { initializeAutonumberField } from "../../services/autonumber";
import { serializeFieldValueForStorage } from "../../services/field-values";
import { revalidateDateDependencyRules } from "../../services/field-rules";

const fields = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

// ── All 30+ field types supported by Baserow ─────────────────────────────────
const VALID_FIELD_TYPES: FieldType[] = [
  "text", "long_text", "url", "email", "phone_number",
  "number", "rating", "boolean", "date", "duration",
  "last_modified", "created_on", "last_modified_by", "created_by",
  "link_row", "file", "single_select", "multiple_select",
  "multiple_collaborators", "formula", "count", "lookup", "rollup",
  "uuid", "autonumber", "password", "ai",
];

const UNIQUE_VALUE_INCOMPATIBLE_FIELD_TYPES = new Set<FieldType>([
  "link_row",
  "file",
  "multiple_select",
  "count",
  "rollup",
  "lookup",
  "multiple_collaborators",
  "password",
]);

const PREMIUM_VIEW_TYPES = new Set(["kanban", "calendar", "timeline"]);

interface FieldRow {
  id: number;
  table_id: number;
  name: string;
  type: FieldType;
  order: number;
  primary: boolean;
  read_only: boolean;
  trashed: boolean;
  description: string | null;
  db_index: boolean;
  immutable_type: boolean;
  immutable_properties: boolean;
  // Type-specific settings stored as JSON blob
  field_settings: string | null;
}

interface SelectOptionRow {
  id: number;
  value: string;
  color: string | null;
  option_order: number;
}

async function backfillCreatedFieldDefault(
  db: D1Database,
  tableId: number,
  fieldId: number,
  type: FieldType,
  settings: Record<string, unknown>
): Promise<void> {
  let defaultValue: unknown = undefined;
  if (type === "text" && settings.text_default) defaultValue = settings.text_default;
  if (type === "number" && settings.number_default !== null && settings.number_default !== undefined && settings.number_default !== "") {
    defaultValue = settings.number_default;
  }
  if (type === "boolean") defaultValue = settings.boolean_default === true;
  if (type === "rating") defaultValue = 0;
  if (type === "single_select" && settings.single_select_default !== null && settings.single_select_default !== undefined) {
    defaultValue = settings.single_select_default;
  }
  if (type === "multiple_select" && Array.isArray(settings.multiple_select_default) && settings.multiple_select_default.length > 0) {
    defaultValue = settings.multiple_select_default;
  }
  if (defaultValue === undefined) return;

  const serialized = await serializeFieldValueForStorage(db, {
    id: fieldId,
    name: "",
    type,
    primary: false,
    settings,
  }, defaultValue);
  await db.prepare(`UPDATE "database_table_${tableId}" SET "field_${fieldId}"=?`).bind(serialized).run();
}

async function shiftDateFieldValues(
  db: D1Database,
  tableId: number,
  fieldId: number,
  offsetMinutes: number
): Promise<void> {
  const rows = await db.prepare(
    `SELECT id, "field_${fieldId}" AS value
     FROM "database_table_${tableId}"
     WHERE "field_${fieldId}" IS NOT NULL AND "field_${fieldId}" != ''`
  ).all<{ id: number; value: string }>();
  const statements = [];
  for (const row of rows.results || []) {
    const date = new Date(row.value);
    if (!Number.isFinite(date.getTime())) continue;
    statements.push(
      db.prepare(`UPDATE "database_table_${tableId}" SET "field_${fieldId}"=? WHERE id=?`)
        .bind(new Date(date.getTime() + offsetMinutes * 60_000).toISOString(), row.id)
    );
  }
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
}

interface DuplicatedSelectOption {
  id: number;
  value: string;
  color: string;
}

/** Points `single_select_default` / `multiple_select_default` at the ids assigned to new options. */
function remapSelectDefaults(settings: Record<string, unknown>, idMap: Map<number, number>): Record<string, unknown> {
  if (idMap.size === 0) return settings;
  const remapped = { ...settings };
  const single = Number(settings.single_select_default || 0);
  if (single && idMap.has(single)) remapped.single_select_default = idMap.get(single);
  if (Array.isArray(settings.multiple_select_default)) {
    remapped.multiple_select_default = settings.multiple_select_default.map((id) => idMap.get(Number(id)) ?? id);
  }
  return remapped;
}

/**
 * Brings the field's options to `options`, like Baserow's
 * `update_field_select_options`: known ids are updated, the others are
 * created with database-assigned ids (the frontend sends temporary negative
 * ids) and defaults referring to those temporary ids follow the new ones.
 * Returns the temporary id -> new id mapping.
 */
async function replaceSelectOptions(
  db: D1Database,
  fieldId: number,
  options: Array<{ id?: number; value?: string; color?: string }>,
  rewriteExistingCells = false
): Promise<Map<number, number>> {
  const existing = await db.prepare("SELECT id FROM database_selectoption WHERE field_id=?")
    .bind(fieldId)
    .all<{ id: number }>();
  const existingIds = new Set((existing.results || []).map((option) => Number(option.id)));
  const retainedIds = new Set(options
    .map((option) => Number(option.id || 0))
    .filter((id) => existingIds.has(id)));
  const removedIds = [...existingIds].filter((id) => !retainedIds.has(id));
  if (removedIds.length > 0) {
    await db.prepare(
      `DELETE FROM database_selectoption WHERE field_id=? AND id IN (${removedIds.map(() => "?").join(",")})`
    ).bind(fieldId, ...removedIds).run();
  }
  const statements = options.map((option, index) => {
    const optionId = Number(option.id || 0);
    if (optionId && existingIds.has(optionId)) {
      return db.prepare(
        "UPDATE database_selectoption SET value=?, color=?, [order]=? WHERE id=? AND field_id=?"
      ).bind(String(option.value ?? ""), option.color || "blue", index + 1, optionId, fieldId);
    }
    // Unknown ids are new options: ids are always assigned by the database,
    // since the select option id sequence is shared by every tenant.
    return db.prepare(
      `INSERT INTO database_selectoption (field_id, value, color, [order])
       VALUES (?, ?, ?, ?)`
    ).bind(fieldId, String(option.value ?? ""), option.color || "blue", index + 1);
  });
  if (statements.length > 0) await db.batch(statements);

  const idMap = new Map<number, number>();
  const temporaryIds = options
    .map((option, index) => ({ index, id: Number(option.id || 0) }))
    .filter(({ id }) => id && !existingIds.has(id));
  if (temporaryIds.length > 0) {
    const created = await db.prepare("SELECT id, [order] AS option_order FROM database_selectoption WHERE field_id=?")
      .bind(fieldId)
      .all<{ id: number; option_order: number }>();
    const idByOrder = new Map((created.results || []).map((option) => [Number(option.option_order), Number(option.id)]));
    for (const { index, id } of temporaryIds) {
      const newId = idByOrder.get(index + 1);
      if (newId) idMap.set(id, newId);
    }
    const field = await db.prepare("SELECT field_settings FROM database_field WHERE id=?")
      .bind(fieldId)
      .first<{ field_settings: string | null }>();
    const settings = parseMaybeJson(field?.field_settings) as Record<string, unknown> | null;
    if (settings && typeof settings === "object") {
      const remapped = remapSelectDefaults(settings, idMap);
      if (remapped !== settings) {
        await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?").bind(JSON.stringify(remapped), fieldId).run();
      }
    }
  }
  if (rewriteExistingCells) await rewriteSelectCellsAfterOptionUpdate(db, fieldId);
  return idMap;
}

async function rewriteSelectCellsAfterOptionUpdate(db: D1Database, fieldId: number): Promise<void> {
  const field = await db.prepare(
    "SELECT table_id, type, field_settings FROM database_field WHERE id=? AND trashed=0"
  ).bind(fieldId).first<{ table_id: number; type: FieldType; field_settings: string | null }>();
  if (!field || (field.type !== "single_select" && field.type !== "multiple_select")) return;
  const options = await db.prepare(
    "SELECT id, value, color FROM database_selectoption WHERE field_id=? ORDER BY [order] ASC, id ASC"
  ).bind(fieldId).all<{ id: number; value: string; color: string }>();
  const byId = new Map((options.results || []).map((option) => [Number(option.id), {
    id: Number(option.id),
    value: option.value,
    color: option.color || "blue",
  }]));
  const byValue = new Map([...byId.values()].map((option) => [option.value, option]));
  const settings = parseMaybeJson(field.field_settings) as Record<string, unknown>;
  if (field.type === "single_select") {
    const defaultId = Number(settings?.single_select_default || 0);
    if (defaultId && !byId.has(defaultId)) settings.single_select_default = null;
  } else if (Array.isArray(settings?.multiple_select_default)) {
    settings.multiple_select_default = settings.multiple_select_default
      .map(Number)
      .filter((id) => byId.has(id));
  }
  await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
    .bind(JSON.stringify(settings || {}), fieldId)
    .run();
  await ensureUserTableSystemColumns(db, field.table_id);
  const rows = await db.prepare(
    `SELECT id, "field_${fieldId}" AS value
     FROM "database_table_${field.table_id}"
     WHERE COALESCE(trashed, 0)=0`
  ).all<{ id: number; value: unknown }>();

  function mappedOption(value: unknown) {
    const parsed = parseMaybeJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      const byExistingId = byId.get(Number(raw.id));
      if (byExistingId) return byExistingId;
      return byValue.get(String(raw.value ?? "")) || null;
    }
    const byExistingId = byId.get(Number(parsed));
    if (byExistingId) return byExistingId;
    return byValue.get(String(parsed ?? "")) || null;
  }

  const updates = (rows.results || []).map((row) => {
    const parsed = parseMaybeJson(row.value);
    let value: unknown;
    if (field.type === "single_select") {
      const source = Array.isArray(parsed) ? parsed[0] : parsed;
      const mapped = mappedOption(source);
      value = mapped ? JSON.stringify(mapped) : null;
    } else {
      const source = Array.isArray(parsed) ? parsed : parsed === null || parsed === undefined ? [] : [parsed];
      const seen = new Set<number>();
      const mapped = source.flatMap((item) => {
        const option = mappedOption(item);
        if (!option || seen.has(option.id)) return [];
        seen.add(option.id);
        return [option];
      });
      value = JSON.stringify(mapped);
    }
    return db.prepare(
      `UPDATE "database_table_${field.table_id}" SET "field_${fieldId}"=? WHERE id=? AND COALESCE(trashed, 0)=0`
    ).bind(value, row.id);
  });
  for (let index = 0; index < updates.length; index += 50) {
    await db.batch(updates.slice(index, index + 50));
  }
}

async function duplicateSelectOptions(
  db: D1Database,
  sourceFieldId: number,
  duplicatedFieldId: number
): Promise<Map<number, DuplicatedSelectOption>> {
  const sourceOptions = await db.prepare(
    `SELECT id, value, color, [order] AS option_order
     FROM database_selectoption
     WHERE field_id=?
     ORDER BY [order] ASC, id ASC`
  ).bind(sourceFieldId).all<SelectOptionRow>();

  const optionMap = new Map<number, DuplicatedSelectOption>();
  for (const option of sourceOptions.results || []) {
    const duplicated = await db.prepare(
      `INSERT INTO database_selectoption (field_id, value, color, [order])
       VALUES (?, ?, ?, ?)
       RETURNING id, value, color`
    ).bind(
      duplicatedFieldId,
      option.value,
      option.color || "blue",
      option.option_order
    ).first<DuplicatedSelectOption>();
    if (duplicated) {
      optionMap.set(option.id, {
        id: duplicated.id,
        value: duplicated.value,
        color: duplicated.color || "blue",
      });
    }
  }

  return optionMap;
}

function remapSelectOptionValue(
  value: unknown,
  optionMap: Map<number, DuplicatedSelectOption>
): DuplicatedSelectOption | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseMaybeJson(value);
  if (parsed === null || parsed === undefined || Array.isArray(parsed) || typeof parsed !== "object") {
    const id = Number(parsed);
    return Number.isFinite(id) ? optionMap.get(id) || null : null;
  }

  const raw = parsed as Record<string, unknown>;
  const id = Number(raw.id);
  if (Number.isFinite(id) && optionMap.has(id)) return optionMap.get(id)!;

  const label = String(raw.value ?? "").trim();
  if (!label) return null;
  return [...optionMap.values()].find((option) => option.value === label) || null;
}

function remapSelectCellForDuplicatedField(
  fieldType: FieldType,
  value: unknown,
  optionMap: Map<number, DuplicatedSelectOption>
): string | null {
  if (value === null || value === undefined || value === "") {
    return fieldType === "multiple_select" ? JSON.stringify([]) : null;
  }

  const parsed = parseMaybeJson(value);
  if (fieldType === "multiple_select") {
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const remapped = items
      .map((item) => remapSelectOptionValue(item, optionMap))
      .filter(Boolean);
    return JSON.stringify(remapped);
  }

  const remapped = remapSelectOptionValue(parsed, optionMap);
  return remapped ? JSON.stringify(remapped) : null;
}

function remapDuplicatedSelectFieldSettings(
  fieldType: FieldType,
  rawSettings: string | null,
  optionMap: Map<number, DuplicatedSelectOption>
): Record<string, unknown> {
  const settings = parseMaybeJson(rawSettings || "{}");
  const normalized = settings && typeof settings === "object" && !Array.isArray(settings)
    ? { ...(settings as Record<string, unknown>) }
    : {};

  if (fieldType === "single_select" && normalized.single_select_default !== undefined && normalized.single_select_default !== null) {
    normalized.single_select_default = remapSelectOptionValue(normalized.single_select_default, optionMap)?.id ?? null;
  }

  if (fieldType === "multiple_select" && Array.isArray(normalized.multiple_select_default)) {
    normalized.multiple_select_default = normalized.multiple_select_default
      .map((item) => remapSelectOptionValue(item, optionMap)?.id)
      .filter((id): id is number => typeof id === "number");
  }

  return normalized;
}

async function copyDuplicatedSelectFieldData(
  db: D1Database,
  tableId: number,
  sourceFieldId: number,
  duplicatedFieldId: number,
  fieldType: FieldType,
  optionMap: Map<number, DuplicatedSelectOption>
): Promise<void> {
  await ensureUserTableSystemColumns(db, tableId);
  const rows = await db.prepare(
    `SELECT id, "field_${sourceFieldId}" AS value
     FROM "database_table_${tableId}"
     WHERE COALESCE(trashed, 0)=0`
  ).all<{ id: number; value: unknown }>();

  const statements = (rows.results || []).map((row) => db.prepare(
    `UPDATE "database_table_${tableId}"
     SET "field_${duplicatedFieldId}"=?
     WHERE id=? AND COALESCE(trashed, 0)=0`
  ).bind(
    remapSelectCellForDuplicatedField(fieldType, row.value, optionMap),
    row.id
  ));

  if (statements.length > 0) await db.batch(statements);
}

async function createFieldOptionsForExistingViews(
  db: D1Database,
  tableId: number,
  fieldId: number,
  fieldOrder: number
): Promise<void> {
  const views = await db.prepare(
    "SELECT id, type, public FROM database_view WHERE table_id=? AND trashed=0 ORDER BY [order] ASC, id ASC"
  ).bind(tableId).all<{ id: number; type: string; public: number }>();
  const optionOrder = fieldOrder * 32768;

  for (const view of views.results || []) {
    if (view.type === "gallery") {
      await db.prepare(
        `INSERT OR IGNORE INTO database_galleryviewfieldoptions
         (gallery_view_id, field_id, hidden, [order])
         VALUES (?, ?, 1, ?)`
      ).bind(view.id, fieldId, optionOrder).run();
      continue;
    }

    if (view.type === "form") {
      await db.prepare(
        `INSERT OR IGNORE INTO database_formviewfieldoptions
         (form_view_id, field_id, name, description, enabled, required, [order],
          show_when_matching_conditions, condition_type, include_all_select_options, field_component)
         VALUES (?, ?, '', '', 0, 1, ?, 0, 'AND', 1, 'default')`
      ).bind(view.id, fieldId, optionOrder).run();
      continue;
    }

    if (PREMIUM_VIEW_TYPES.has(view.type)) {
      await db.prepare(
        `INSERT OR IGNORE INTO database_gridviewfieldoptions
         (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
         VALUES (?, ?, 200, 1, ?, '', '')`
      ).bind(view.id, fieldId, optionOrder).run();
      continue;
    }

    const hiddenCount = await db.prepare(
      `SELECT COUNT(*) AS count
       FROM database_gridviewfieldoptions
       WHERE grid_view_id=? AND hidden=1`
    ).bind(view.id).first<{ count: number }>();
    const hidden = Boolean(view.public) || Number(hiddenCount?.count || 0) > 0;
    await db.prepare(
      `INSERT OR IGNORE INTO database_gridviewfieldoptions
       (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (?, ?, 200, ?, ?, '', '')`
    ).bind(view.id, fieldId, hidden ? 1 : 0, optionOrder).run();
  }
}

function fieldCanRepresentFiles(field: FieldRow): boolean {
  if (field.type === "file") return true;
  if (!["formula", "lookup", "rollup"].includes(field.type)) return false;
  const settings = normalizeFieldSettings(field);
  const formulaType = String(settings.formula_type || "").toLowerCase();
  const arrayFormulaType = String(settings.array_formula_type || "").toLowerCase();
  return formulaType === "single_file_array" || (formulaType === "array" && arrayFormulaType === "single_file");
}

function fieldCanRepresentDate(field: FieldRow): boolean {
  if (["date", "created_on", "last_modified"].includes(field.type)) return true;
  if (!["formula", "lookup", "rollup"].includes(field.type)) return false;
  return String(normalizeFieldSettings(field).formula_type || "").toLowerCase() === "date";
}

function fieldSupportsViewOrdering(field: FieldRow, sortType: string): boolean {
  if (sortType === "order") return field.type === "single_select";
  if (sortType !== "default" || field.type === "file" || field.type === "password") return false;
  if (!["formula", "lookup", "rollup"].includes(field.type)) return true;
  const settings = normalizeFieldSettings(field);
  const formulaType = String(settings.formula_type || "").toLowerCase();
  return formulaType !== "array" && formulaType !== "single_file_array";
}

function fieldSupportsViewGrouping(field: FieldRow, sortType: string): boolean {
  if (!fieldSupportsViewOrdering(field, sortType)) return false;
  return !new Set(["file", "password", "ai"]).has(field.type);
}

function fieldSupportsViewFilter(field: FieldRow, filterType: string): boolean {
  const type = field.type;
  if (filterType.startsWith("single_select_")) return type === "single_select";
  if (filterType.startsWith("multiple_select_")) return type === "multiple_select";
  if (filterType.startsWith("link_row_")) return type === "link_row";
  if (["filename_contains", "has_file_type", "files_lower_than"].includes(filterType)) return type === "file";
  if (filterType.startsWith("multiple_collaborators_") || filterType === "user_is" || filterType === "user_is_not") {
    return ["multiple_collaborators", "created_by", "last_modified_by"].includes(type);
  }
  if (filterType.startsWith("date_") || filterType.includes("date_equals") || filterType.includes("date_before") || filterType.includes("date_after")) {
    return fieldCanRepresentDate(field);
  }
  if (["higher_than", "higher_than_or_equal", "lower_than", "lower_than_or_equal", "is_even_and_whole"].includes(filterType)) {
    return ["number", "rating", "duration", "autonumber", "auto_number", "count", "rollup", "formula", "lookup"].includes(type);
  }
  if (filterType.startsWith("has_")) return ["formula", "lookup", "rollup", "multiple_select", "link_row"].includes(type);
  return true;
}

async function cleanViewConfigurationForField(db: D1Database, field: FieldRow, deleted: boolean): Promise<void> {
  if (!deleted) {
    const sorts = await db.prepare("SELECT id, type FROM database_viewsort WHERE field_id=?").bind(field.id).all<any>();
    const invalidSortIds = (sorts.results || []).filter((sort) => !fieldSupportsViewOrdering(field, String(sort.type || "default"))).map((sort) => Number(sort.id));
    if (invalidSortIds.length > 0) {
      await db.prepare(`DELETE FROM database_viewsort WHERE id IN (${invalidSortIds.map(() => "?").join(",")})`).bind(...invalidSortIds).run();
    }

    const groups = await db.prepare("SELECT id, type FROM database_viewgroupby WHERE field_id=?").bind(field.id).all<any>();
    const invalidGroupIds = (groups.results || []).filter((group) => !fieldSupportsViewGrouping(field, String(group.type || "default"))).map((group) => Number(group.id));
    if (invalidGroupIds.length > 0) {
      await db.prepare(`DELETE FROM database_viewgroupby WHERE id IN (${invalidGroupIds.map(() => "?").join(",")})`).bind(...invalidGroupIds).run();
    }

    const filters = await db.prepare("SELECT id, type FROM database_viewfilter WHERE field_id=?").bind(field.id).all<any>();
    const invalidFilterIds = (filters.results || []).filter((filter) => !fieldSupportsViewFilter(field, String(filter.type || ""))).map((filter) => Number(filter.id));
    if (invalidFilterIds.length > 0) {
      await db.prepare(`DELETE FROM database_viewfilter WHERE id IN (${invalidFilterIds.map(() => "?").join(",")})`).bind(...invalidFilterIds).run();
    }
  }

  const decorations = await db.prepare(
    `SELECT vd.id, vd.value_provider_type, vd.value_provider_conf
     FROM database_viewdecoration vd
     JOIN database_view v ON v.id=vd.view_id
     WHERE v.table_id=? AND vd.value_provider_type IN ('single_select_color', 'conditional_color')`
  ).bind(field.table_id).all<any>();
  for (const decoration of decorations.results || []) {
    let conf: any;
    try {
      conf = JSON.parse(decoration.value_provider_conf || "{}");
    } catch {
      conf = {};
    }
    let changed = false;
    if (decoration.value_provider_type === "single_select_color" && Number(conf.field_id) === Number(field.id) && (deleted || field.type !== "single_select")) {
      conf.field_id = null;
      changed = true;
    }
    if (decoration.value_provider_type === "conditional_color" && Array.isArray(conf.colors)) {
      for (const color of conf.colors) {
        if (!Array.isArray(color?.filters)) continue;
        const filtered = color.filters.filter((filter: any) => Number(filter?.field) !== Number(field.id) || (!deleted && fieldSupportsViewFilter(field, String(filter?.type || ""))));
        if (filtered.length !== color.filters.length) {
          color.filters = filtered;
          changed = true;
        }
      }
    }
    if (changed) {
      await db.prepare("UPDATE database_viewdecoration SET value_provider_conf=? WHERE id=?")
        .bind(JSON.stringify(conf), decoration.id)
        .run();
    }
  }
}

async function applyViewFieldLifecycleHooks(
  db: D1Database,
  field: FieldRow,
  deleted = false
): Promise<void> {
  const statements = [];
  if (deleted || !fieldCanRepresentFiles(field)) {
    statements.push(
      db.prepare("UPDATE database_view SET card_cover_image_field=NULL WHERE card_cover_image_field=?").bind(field.id)
    );
  }
  if (deleted || field.type !== "single_select") {
    statements.push(
      db.prepare("UPDATE database_view SET single_select_field=NULL WHERE single_select_field=?").bind(field.id)
    );
  }
  if (deleted || !fieldCanRepresentDate(field)) {
    statements.push(
      db.prepare("UPDATE database_view SET date_field=NULL WHERE date_field=?").bind(field.id),
      db.prepare("UPDATE database_view SET start_date_field=NULL WHERE start_date_field=?").bind(field.id),
      db.prepare("UPDATE database_view SET end_date_field=NULL WHERE end_date_field=?").bind(field.id)
    );
  }
  if (!deleted && (Boolean(field.read_only) || isReadOnlyFieldType(field.type) || field.type === "ai")) {
    statements.push(
      db.prepare("UPDATE database_formviewfieldoptions SET enabled=0 WHERE field_id=? AND enabled=1").bind(field.id)
    );
  }
  if (statements.length > 0) await db.batch(statements);
  await cleanViewConfigurationForField(db, field, deleted);
}

async function saveFieldSettings(
  db: D1Database,
  fieldId: number,
  settings: Record<string, unknown>,
  updatedOn: string
): Promise<void> {
  await db.prepare("UPDATE database_field SET field_settings=?, updated_on=? WHERE id=?")
    .bind(JSON.stringify(settings), updatedOn, fieldId)
    .run();
}

async function unusedRelatedFieldName(
  db: D1Database,
  sourceTableId: number,
  sourceFieldName: string,
  targetTableId: number,
  ignoredFieldId?: number
): Promise<string> {
  const sourceTable = await db.prepare("SELECT name FROM database_table WHERE id=? AND trashed=0")
    .bind(sourceTableId)
    .first<{ name: string }>();
  const existing = await db.prepare(
    `SELECT name FROM database_field
     WHERE table_id=? AND trashed=0${ignoredFieldId ? " AND id!=?" : ""}`
  ).bind(...(ignoredFieldId ? [targetTableId, ignoredFieldId] : [targetTableId])).all<{ name: string }>();
  const names = new Set((existing.results || []).map((field) => field.name));
  const candidates = [String(sourceTable?.name || "Link"), `${String(sourceTable?.name || "Link")} - ${sourceFieldName}`];
  for (const candidate of candidates) {
    if (!names.has(candidate)) return candidate.slice(0, 255);
  }
  const base = candidates[candidates.length - 1];
  for (let suffix = 2; ; suffix += 1) {
    const tail = ` ${suffix}`;
    const candidate = `${base.slice(0, 255 - tail.length)}${tail}`;
    if (!names.has(candidate)) return candidate;
  }
}

async function createRelatedLinkField(
  db: D1Database,
  source: FieldRow,
  updatedOn: string
): Promise<FieldRow> {
  const sourceSettings = normalizeFieldSettings(source);
  const targetTableId = Number(sourceSettings.link_row_table_id || 0);
  const maxOrder = await db.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM database_field WHERE table_id=? AND trashed=0"
  ).bind(targetTableId).first<{ max_order: number }>();
  const name = await unusedRelatedFieldName(db, source.table_id, source.name, targetTableId);
  const settings = {
    link_row_table_id: source.table_id,
    link_row_related_field_id: source.id,
    link_row_multiple_relationships: true,
    link_row_limit_selection_view_id: null,
  };
  const related = await db.prepare(
    `INSERT INTO database_field
     (table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
      immutable_type, immutable_properties, field_settings, created_on, updated_on)
     VALUES (?, ?, 'link_row', ?, 0, 0, 0, NULL, 0, 0, 0, ?, ?, ?)
     RETURNING *`
  ).bind(targetTableId, name, Number(maxOrder?.max_order || 0) + 1, JSON.stringify(settings), updatedOn, updatedOn)
    .first<FieldRow>();
  if (!related) throw new Error("Failed to create the related link row field.");
  await addFieldColumn(db, targetTableId, { id: related.id, type: "link_row" });
  await createFieldOptionsForExistingViews(db, targetTableId, related.id, Number(maxOrder?.max_order || 0) + 1);
  sourceSettings.link_row_related_field_id = related.id;
  await saveFieldSettings(db, source.id, sourceSettings, updatedOn);
  return related;
}

async function deleteRelatedLinkField(
  db: D1Database,
  source: FieldRow,
  relatedFieldId: number,
  updatedOn: string,
  clearSource = true
): Promise<void> {
  const related = await db.prepare("SELECT * FROM database_field WHERE id=?")
    .bind(relatedFieldId)
    .first<FieldRow>();
  if (related) {
    await applyViewFieldLifecycleHooks(db, related, true);
    await dropFieldColumn(db, related.table_id, related.id);
    await db.prepare("DELETE FROM database_field WHERE id=?").bind(related.id).run();
  }
  if (clearSource) {
    const settings = normalizeFieldSettings(source);
    settings.link_row_related_field_id = null;
    await saveFieldSettings(db, source.id, settings, updatedOn);
  }
}

async function moveRelatedLinkField(
  db: D1Database,
  source: FieldRow,
  related: FieldRow,
  targetTableId: number,
  updatedOn: string
): Promise<FieldRow> {
  const oldTableId = related.table_id;
  await applyViewFieldLifecycleHooks(db, related, true);
  const maxOrder = await db.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM database_field WHERE table_id=? AND trashed=0"
  ).bind(targetTableId).first<{ max_order: number }>();
  const name = await unusedRelatedFieldName(db, source.table_id, source.name, targetTableId, related.id);
  const relatedSettings = normalizeFieldSettings(related);
  relatedSettings.link_row_table_id = source.table_id;
  relatedSettings.link_row_related_field_id = source.id;
  relatedSettings.link_row_limit_selection_view_id = null;

  await db.prepare("DELETE FROM database_gridviewfieldoptions WHERE field_id=?").bind(related.id).run();
  await db.prepare("DELETE FROM database_galleryviewfieldoptions WHERE field_id=?").bind(related.id).run();
  await db.prepare("DELETE FROM database_formviewfieldoptions WHERE field_id=?").bind(related.id).run();
  if (oldTableId !== targetTableId) await dropFieldColumn(db, oldTableId, related.id);
  await db.prepare(
    "UPDATE database_field SET table_id=?, name=?, [order]=?, field_settings=?, updated_on=? WHERE id=?"
  ).bind(
    targetTableId,
    name,
    Number(maxOrder?.max_order || 0) + 1,
    JSON.stringify(relatedSettings),
    updatedOn,
    related.id
  ).run();
  await addFieldColumn(db, targetTableId, { id: related.id, type: "link_row" });
  await createFieldOptionsForExistingViews(db, targetTableId, related.id, Number(maxOrder?.max_order || 0) + 1);
  return (await db.prepare("SELECT * FROM database_field WHERE id=?").bind(related.id).first<FieldRow>())!;
}

async function reconcileRelatedLinkField(
  db: D1Database,
  before: FieldRow,
  after: FieldRow,
  requestedHasRelatedField: boolean | undefined,
  updatedOn: string
): Promise<FieldRow[]> {
  const oldSettings = normalizeFieldSettings(before);
  const newSettings = normalizeFieldSettings(after);
  const oldRelatedId = before.type === "link_row" ? Number(oldSettings.link_row_related_field_id || 0) : 0;

  if (after.type !== "link_row") {
    if (oldRelatedId) await deleteRelatedLinkField(db, before, oldRelatedId, updatedOn, false);
    return [];
  }

  const targetTableId = Number(newSettings.link_row_table_id || 0);
  const selfReferencing = targetTableId === after.table_id;
  const desired = selfReferencing
    ? false
    : requestedHasRelatedField ?? (before.type === "link_row" ? Boolean(oldRelatedId) : true);
  let related = oldRelatedId
    ? await db.prepare("SELECT * FROM database_field WHERE id=? AND type='link_row'").bind(oldRelatedId).first<FieldRow>()
    : null;

  if (!desired) {
    if (related) await deleteRelatedLinkField(db, after, related.id, updatedOn);
    return [];
  }
  if (!related) {
    related = await createRelatedLinkField(db, after, updatedOn);
  } else if (related.table_id !== targetTableId) {
    related = await moveRelatedLinkField(db, after, related, targetTableId, updatedOn);
  }
  return related ? [related] : [];
}

function remapMaybeSourceFieldId(value: unknown, sourceFieldId: number, duplicatedFieldId: number): unknown {
  return Number(value) === sourceFieldId ? duplicatedFieldId : value;
}

function remapDuplicatedFieldSelectConditionValue(
  value: unknown,
  shouldRemap: boolean,
  optionMap: Map<number, DuplicatedSelectOption>
): string {
  if (!shouldRemap || optionMap.size === 0) return String(value ?? "");
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) {
    return JSON.stringify(parsed.map((item) => remapSelectOptionValue(item, optionMap)?.id ?? item));
  }
  const remapped = remapSelectOptionValue(parsed, optionMap);
  if (remapped) return typeof parsed === "object" ? JSON.stringify(remapped) : String(remapped.id);
  return String(value ?? "");
}

async function duplicateFieldViewOptions(
  db: D1Database,
  tableId: number,
  sourceFieldId: number,
  duplicatedFieldId: number,
  optionMap: Map<number, DuplicatedSelectOption>
): Promise<void> {
  const views = await db.prepare(
    "SELECT id, type FROM database_view WHERE table_id=? AND trashed=0 ORDER BY [order] ASC, id ASC"
  ).bind(tableId).all<{ id: number; type: string }>();

  for (const view of views.results || []) {
    if (view.type === "gallery") {
      const option = await db.prepare(
        "SELECT hidden, [order] FROM database_galleryviewfieldoptions WHERE gallery_view_id=? AND field_id=?"
      ).bind(view.id, sourceFieldId).first<any>();
      if (!option) continue;
      await db.prepare(
        `INSERT OR IGNORE INTO database_galleryviewfieldoptions (gallery_view_id, field_id, hidden, [order])
         VALUES (?, ?, ?, ?)`
      ).bind(view.id, duplicatedFieldId, option?.hidden ? 1 : 0, (option?.order ?? 32767) + 1).run();
      continue;
    }

    if (view.type === "form") {
      const option = await db.prepare(
        `SELECT * FROM database_formviewfieldoptions
         WHERE form_view_id=? AND field_id=?`
      ).bind(view.id, sourceFieldId).first<any>();
      if (!option) continue;
      const inserted = await db.prepare(
        `INSERT OR IGNORE INTO database_formviewfieldoptions
         (form_view_id, field_id, name, description, enabled, required, [order],
          show_when_matching_conditions, condition_type, include_all_select_options, field_component)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      ).bind(
        view.id,
        duplicatedFieldId,
        option?.name || "",
        option?.description || "",
        option?.enabled ? 1 : 0,
        option?.required ? 1 : 0,
        (option?.order ?? 32767) + 1,
        option?.show_when_matching_conditions ? 1 : 0,
        option?.condition_type || "AND",
        option?.include_all_select_options === 0 ? 0 : 1,
        option?.field_component || "default"
      ).first<{ id: number }>();
      if (!option?.id || !inserted?.id) continue;

      const allowed = await db.prepare(
        `SELECT select_option_id
         FROM database_formviewfieldoptions_allowedselectoptions
         WHERE form_view_field_options_id=?
         ORDER BY id ASC`
      ).bind(option.id).all<any>();
      const allowedStatements = (allowed.results || []).flatMap((row) => {
        const remapped = optionMap.get(Number(row.select_option_id))?.id || row.select_option_id;
        return [db.prepare(
          `INSERT OR IGNORE INTO database_formviewfieldoptions_allowedselectoptions
           (form_view_field_options_id, select_option_id)
           VALUES (?, ?)`
        ).bind(inserted.id, remapped)];
      });
      if (allowedStatements.length > 0) await db.batch(allowedStatements);

      const groupMap = new Map<number, number>();
      const groups = await db.prepare(
        `SELECT * FROM database_formviewfieldoptionsconditiongroup
         WHERE field_option_id=?
         ORDER BY id ASC`
      ).bind(option.id).all<any>();
      for (const group of groups.results || []) {
        const parent = group.parent_group_id ? groupMap.get(Number(group.parent_group_id)) || null : null;
        const copied = await db.prepare(
          `INSERT INTO database_formviewfieldoptionsconditiongroup
           (field_option_id, filter_type, parent_group_id)
           VALUES (?, ?, ?)
           RETURNING id`
        ).bind(inserted.id, group.filter_type || "AND", parent).first<{ id: number }>();
        if (copied) groupMap.set(Number(group.id), copied.id);
      }

      const conditions = await db.prepare(
        `SELECT * FROM database_formviewfieldoptionscondition
         WHERE field_option_id=?
         ORDER BY id ASC`
      ).bind(option.id).all<any>();
      const conditionStatements = (conditions.results || []).map((condition) => db.prepare(
        `INSERT INTO database_formviewfieldoptionscondition
         (field_option_id, field_id, type, value, group_id)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        inserted.id,
        remapMaybeSourceFieldId(condition.field_id, sourceFieldId, duplicatedFieldId),
        condition.type,
        remapDuplicatedFieldSelectConditionValue(
          condition.value,
          Number(condition.field_id) === sourceFieldId,
          optionMap
        ),
        condition.group_id ? groupMap.get(Number(condition.group_id)) || null : null
      ));
      if (conditionStatements.length > 0) await db.batch(conditionStatements);
      continue;
    }

    const option = await db.prepare(
      `SELECT width, hidden, [order], aggregation_type, aggregation_raw_type
       FROM database_gridviewfieldoptions
       WHERE grid_view_id=? AND field_id=?`
    ).bind(view.id, sourceFieldId).first<any>();
    if (!option) continue;
    await db.prepare(
      `INSERT OR IGNORE INTO database_gridviewfieldoptions
       (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      view.id,
      duplicatedFieldId,
      option?.width ?? 200,
      option?.hidden ? 1 : 0,
      (option?.order ?? 32767) + 1,
      option?.aggregation_type || "",
      option?.aggregation_raw_type || ""
    ).run();
  }
}

async function getTableWorkspace(
  db: D1Database,
  tableId: number
): Promise<{ database_id: number; workspace_id: number; is_template: number } | null> {
  return db
    .prepare(
      `SELECT t.database_id, a.workspace_id, ${templateWorkspaceSql("a.workspace_id")} AS is_template
       FROM database_table t
       JOIN core_application a ON a.id = t.database_id
       WHERE t.id = ? AND t.trashed = 0`
    )
    .bind(tableId)
    .first<{ database_id: number; workspace_id: number; is_template: number }>();
}

async function requireTableAccess(
  db: D1Database,
  userId: number | undefined,
  tableId: number,
  requiredRole = "VIEWER"
): Promise<{ database_id: number; workspace_id: number }> {
  const row = await getTableWorkspace(db, tableId);
  if (!row) throw new DoesNotExist("Table", tableId);
  const meta = { database_id: row.database_id, workspace_id: row.workspace_id };
  if (requiredRole === "VIEWER" && row.is_template) return meta;
  await assertHasTableRole(db, userId, { id: tableId, database_id: meta.database_id, workspace_id: meta.workspace_id }, requiredRole);

  return meta;
}

function fieldActionContext(c: any, tableId: number) {
  return {
    session: c.req.header("ClientSessionId") || "",
    actionGroup: c.req.header("ClientUndoRedoActionGroupId") || null,
    actionScope: `table${tableId}`,
  };
}

async function serializeField(db: D1Database, field: FieldRow): Promise<object> {
  return serializeDatabaseFieldRow(db, field);
}

async function fieldAuditDetails(db: D1Database, fieldId: number) {
  return db.prepare(
    `SELECT f.id AS field_id, f.name AS field_name, f.type AS field_type,
            t.id AS table_id, t.name AS table_name, a.id AS database_id,
            a.workspace_id, w.name AS workspace_name
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspace w ON w.id=a.workspace_id
      WHERE f.id=?`
  ).bind(fieldId).first<any>();
}

function fieldConfigurationResponse(c: any, error: unknown) {
  if (error instanceof FieldConfigurationError) {
    const status = error.code === "ERROR_FIELD_DOES_NOT_EXIST" ? 404 : 400;
    return c.json({ error: error.code, detail: error.message }, status);
  }
  throw error;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !["[", "{"].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function canBePrimaryField(field: FieldRow): boolean {
  if (field.type === "link_row" || field.type === "password") return false;
  if (field.type === "long_text") {
    return normalizeFieldSettings(field).long_text_enable_rich_text !== true;
  }
  return true;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numericSetting(settings: Record<string, unknown>, key: string): number | null {
  const value = settings[key];
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formulaReferencesDeletedFieldById(formula: string, deletedFieldId: number): boolean {
  const id = escapeRegex(String(deletedFieldId));
  return new RegExp(`\\bfield_by_id\\s*\\(\\s*${id}\\s*\\)`, "i").test(formula) ||
    new RegExp(`\\bfield_${id}\\b`, "i").test(formula) ||
    new RegExp(`\\bget\\s*\\(\\s*(['"])fields\\.field_${id}\\1\\s*\\)`, "i").test(formula);
}

function formulaReferencesDeletedFieldByName(formula: string, deletedFieldName: string): boolean {
  const name = escapeRegex(deletedFieldName);
  const braceReference = new RegExp(`\\{\\s*${name}\\s*\\}`, "i");
  const fieldCallReference = new RegExp(`\\bfield\\s*\\(\\s*(['"])${name}\\1\\s*\\)`, "i");
  return braceReference.test(formula) || fieldCallReference.test(formula);
}

function formulaLookupReferences(formula: string): Array<{ throughFieldName: string; targetFieldName: string }> {
  const references: Array<{ throughFieldName: string; targetFieldName: string }> = [];
  const pattern = /\blookup\s*\(\s*(["'])(.*?)\1\s*,\s*(["'])(.*?)\3\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(formula))) {
    references.push({ throughFieldName: match[2], targetFieldName: match[4] });
  }
  return references;
}

function formulaLookupReferencesDeletedField(
  candidate: FieldRow,
  formula: string,
  deletedField: FieldRow,
  activeFields: FieldRow[]
): boolean {
  for (const reference of formulaLookupReferences(formula)) {
    if (
      candidate.table_id === deletedField.table_id &&
      reference.throughFieldName.toLowerCase() === deletedField.name.toLowerCase()
    ) {
      return true;
    }

    const throughField = activeFields.find((field) =>
      field.table_id === candidate.table_id &&
      field.type === "link_row" &&
      field.name.toLowerCase() === reference.throughFieldName.toLowerCase()
    );
    const throughSettings = throughField ? normalizeFieldSettings(throughField) : null;
    if (
      Number(throughSettings?.link_row_table_id || 0) === deletedField.table_id &&
      reference.targetFieldName.toLowerCase() === deletedField.name.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

function fieldDependsOnDeletedField(candidate: FieldRow, deletedField: FieldRow, activeFields: FieldRow[]): boolean {
  const settings = normalizeFieldSettings(candidate);
  if (
    numericSetting(settings, "through_field_id") === deletedField.id ||
    numericSetting(settings, "target_field_id") === deletedField.id ||
    numericSetting(settings, "link_row_related_field_id") === deletedField.id ||
    numericSetting(settings, "ai_file_field_id") === deletedField.id
  ) {
    return true;
  }

  if (candidate.type !== "formula" && candidate.type !== "ai") return false;

  const prompt = settings.ai_prompt && typeof settings.ai_prompt === "object" && !Array.isArray(settings.ai_prompt)
    ? (settings.ai_prompt as Record<string, unknown>).formula
    : settings.ai_prompt;
  const formula = candidate.type === "ai"
    ? String(prompt || "")
    : typeof settings.formula === "string" ? settings.formula : "";
  if (!formula.trim()) return false;
  if (formulaReferencesDeletedFieldById(formula, deletedField.id)) return true;
  if (candidate.table_id === deletedField.table_id && formulaReferencesDeletedFieldByName(formula, deletedField.name)) return true;
  return formulaLookupReferencesDeletedField(candidate, formula, deletedField, activeFields);
}

/** A formula string literal: backslashes and the quote are escaped like the formula tokenizer expects. */
// Settings whose change rewrites the stored cells (see storageSettingsChanged).
const CELL_STORAGE_SETTING_KEYS = [
  "number_decimal_places", "number_negative", "max_value", "duration_format", "date_include_time", "link_row_table_id",
];

function quoteFormulaString(value: string, quote: string): string {
  return `${quote}${value.replace(/\\/g, "\\\\").split(quote).join(`\\${quote}`)}${quote}`;
}

function replaceFormulaFieldNameReferences(formula: string, oldName: string, newName: string): string {
  const matchesOld = (name: string) => name.toLowerCase() === oldName.toLowerCase();
  // Replacements are functions so `$&`, `$1`… in a field name stay literal.
  return formula
    .replace(/\{([^{}]*)\}/g, (match, name: string) => {
      if (!matchesOld(name.trim())) return match;
      return /[{}]/.test(newName) ? `field(${quoteFormulaString(newName, "'")})` : `{${newName}}`;
    })
    .replace(
      /\bfield\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/gi,
      (match, quote: string, raw: string) => matchesOld(raw.replace(/\\(.)/g, "$1"))
        ? `field(${quoteFormulaString(newName, quote)})`
        : match
    );
}

function replaceFormulaLookupNameReferences(
  candidate: FieldRow,
  formula: string,
  oldField: FieldRow,
  newField: FieldRow,
  activeFields: FieldRow[]
): string {
  return formula.replace(
    /\blookup\s*\(\s*(["'])(.*?)\1\s*,\s*(["'])(.*?)\3\s*\)/gi,
    (match, throughQuote: string, throughName: string, targetQuote: string, targetName: string) => {
      let nextThroughName = throughName;
      let nextTargetName = targetName;

      if (candidate.table_id === oldField.table_id && throughName.toLowerCase() === oldField.name.toLowerCase()) {
        nextThroughName = newField.name;
      }

      const throughField = activeFields.find((field) =>
        field.table_id === candidate.table_id &&
        field.type === "link_row" &&
        field.name.toLowerCase() === nextThroughName.toLowerCase()
      );
      const throughSettings = throughField ? normalizeFieldSettings(throughField) : null;
      if (
        Number(throughSettings?.link_row_table_id || 0) === oldField.table_id &&
        targetName.toLowerCase() === oldField.name.toLowerCase()
      ) {
        nextTargetName = newField.name;
      }

      if (nextThroughName === throughName && nextTargetName === targetName) return match;
      const through = nextThroughName === throughName ? `${throughQuote}${throughName}${throughQuote}` : quoteFormulaString(nextThroughName, throughQuote);
      const target = nextTargetName === targetName ? `${targetQuote}${targetName}${targetQuote}` : quoteFormulaString(nextTargetName, targetQuote);
      return `lookup(${through}, ${target})`;
    }
  );
}

function updateSettingsForRenamedField(
  field: FieldRow,
  oldField: FieldRow,
  newField: FieldRow,
  activeFields: FieldRow[]
): Record<string, unknown> | null {
  const settings = normalizeFieldSettings(field);
  let changed = false;

  if (numericSetting(settings, "through_field_id") === oldField.id) {
    settings.through_field_name = newField.name;
    changed = true;
  }
  if (numericSetting(settings, "target_field_id") === oldField.id) {
    settings.target_field_name = newField.name;
    changed = true;
  }

  if (field.type === "formula" && typeof settings.formula === "string") {
    let formula = settings.formula;
    if (field.table_id === oldField.table_id) {
      formula = replaceFormulaFieldNameReferences(formula, oldField.name, newField.name);
    }
    formula = replaceFormulaLookupNameReferences(field, formula, oldField, newField, activeFields);
    if (formula !== settings.formula) {
      settings.formula = formula;
      settings.formula_type_error = null;
      changed = true;
    }
  }
  if (field.type === "ai") {
    const promptObject = settings.ai_prompt && typeof settings.ai_prompt === "object" && !Array.isArray(settings.ai_prompt)
      ? settings.ai_prompt as Record<string, unknown>
      : { formula: String(settings.ai_prompt || ""), mode: "simple", version: "0.1" };
    const currentFormula = String(promptObject.formula || "");
    const formula = field.table_id === oldField.table_id
      ? replaceFormulaFieldNameReferences(currentFormula, oldField.name, newField.name)
      : currentFormula;
    if (formula !== currentFormula) {
      settings.ai_prompt = { ...promptObject, formula };
      changed = true;
    }
  }

  return changed ? settings : null;
}

function fieldTypesForFormula(fields: FieldRow[]): Record<string, string> {
  const fieldTypes: Record<string, string> = {};
  for (const field of fields) {
    const formulaType = mapFieldTypeToFormulaType(field.type, normalizeFieldSettings(field));
    fieldTypes[field.name.toLowerCase()] = formulaType;
    fieldTypes[`field_${field.id}`] = formulaType;
  }
  return fieldTypes;
}

function fieldNullablesForFormula(fields: FieldRow[]): Record<string, boolean> {
  const fieldNullables: Record<string, boolean> = {};
  for (const field of fields) {
    const nullable = mapFieldTypeToFormulaNullable(field.type, normalizeFieldSettings(field));
    fieldNullables[field.name.toLowerCase()] = nullable;
    fieldNullables[`field_${field.id}`] = nullable;
  }
  return fieldNullables;
}

function fieldDecimalPlacesForFormula(fields: FieldRow[]): Record<string, number> {
  const decimalPlaces: Record<string, number> = {};
  for (const field of fields) {
    const value = Number(normalizeFieldSettings(field).number_decimal_places ?? 0);
    const normalized = Number.isFinite(value) ? Math.min(10, Math.max(0, Math.trunc(value))) : 0;
    decimalPlaces[field.name.toLowerCase()] = normalized;
    decimalPlaces[`field_${field.id}`] = normalized;
  }
  return decimalPlaces;
}

function formulaTypeForField(field: FieldRow): { formula_type: string; array_formula_type: string | null } {
  const settings = normalizeFieldSettings(field);
  const formulaType = mapFieldTypeToFormulaType(field.type, settings);
  if (field.type === "lookup") {
    return { formula_type: "array", array_formula_type: formulaType };
  }
  return { formula_type: formulaType, array_formula_type: null };
}

function inferFormulaSettings(formula: string, activeFields: FieldRow[]): Record<string, unknown> {
  const inferred = validateFormulaType(
    formula,
    fieldTypesForFormula(activeFields),
    null,
    fieldNullablesForFormula(activeFields)
  );
  const numberSettings = inferred.formula_type === "number"
    ? { number_decimal_places: inferFormulaNumberDecimalPlaces(formula, fieldDecimalPlacesForFormula(activeFields)) }
    : {};
  return {
    formula_type: inferred.formula_type,
    array_formula_type: inferred.array_formula_type,
    formula_type_error: inferred.formula_type_error,
    nullable: inferred.nullable,
    ...numberSettings,
  };
}

function updatedSettingsForFieldTypeChange(
  field: FieldRow,
  changedField: FieldRow,
  activeFields: FieldRow[]
): Record<string, unknown> | null {
  if (!fieldDependsOnDeletedField(field, changedField, activeFields)) return null;

  const settings = normalizeFieldSettings(field);
  if (field.type === "formula" && typeof settings.formula === "string") {
    return {
      ...settings,
      ...inferFormulaSettings(settings.formula, activeFields),
    };
  }

  if (field.type === "count") {
    const throughField = activeFields.find((item) => item.id === numericSetting(settings, "through_field_id"));
    if (!throughField || throughField.type !== "link_row") {
      return {
        ...settings,
        formula_type: "invalid",
        array_formula_type: null,
        formula_type_error: `references incompatible field "${changedField.name}"`,
      };
    }
    return {
      ...settings,
      formula_type: "number",
      array_formula_type: null,
      formula_type_error: null,
    };
  }

  if (field.type === "lookup" || field.type === "rollup") {
    const throughField = activeFields.find((item) => item.id === numericSetting(settings, "through_field_id"));
    const targetField = activeFields.find((item) => item.id === numericSetting(settings, "target_field_id"));
    if (!throughField || throughField.type !== "link_row" || !targetField) {
      return {
        ...settings,
        formula_type: "invalid",
        array_formula_type: null,
        formula_type_error: `references incompatible field "${changedField.name}"`,
      };
    }

    const targetFormulaType = formulaTypeForField(targetField);
    return {
      ...settings,
      ...(
        field.type === "lookup"
          ? { formula_type: "array", array_formula_type: targetFormulaType.formula_type }
          : { formula_type: targetFormulaType.formula_type, array_formula_type: targetFormulaType.array_formula_type }
      ),
      formula_type_error: null,
    };
  }

  return null;
}

async function updateFieldsImpactedByTypeChange(
  db: D1Database,
  changedField: FieldRow,
  now: string
): Promise<FieldRow[]> {
  const table = await db.prepare("SELECT database_id FROM database_table WHERE id=?")
    .bind(changedField.table_id)
    .first<{ database_id: number }>();
  if (!table) return [];

  const activeFields = await db.prepare(
    `SELECT f.*
     FROM database_field f
     JOIN database_table t ON t.id=f.table_id
     WHERE t.database_id=? AND f.trashed=0
     ORDER BY f.table_id ASC, f.[order] ASC, f.id ASC`
  ).bind(table.database_id).all<FieldRow>();

  const impactedIds: number[] = [];
  for (const field of activeFields.results || []) {
    if (field.id === changedField.id) continue;
    const nextSettings = updatedSettingsForFieldTypeChange(field, changedField, activeFields.results || []);
    if (!nextSettings) continue;
    await db.prepare("UPDATE database_field SET field_settings=?, updated_on=? WHERE id=?")
      .bind(JSON.stringify(nextSettings), now, field.id)
      .run();
    impactedIds.push(field.id);
  }

  if (impactedIds.length === 0) return [];
  const bindMarks = impactedIds.map(() => "?").join(",");
  const refreshed = await db.prepare(
    `SELECT * FROM database_field WHERE id IN (${bindMarks}) ORDER BY table_id ASC, [order] ASC, id ASC`
  ).bind(...impactedIds).all<FieldRow>();
  return refreshed.results || [];
}

async function updateFieldsImpactedByRenamedField(
  db: D1Database,
  oldField: FieldRow,
  newField: FieldRow,
  now: string
): Promise<FieldRow[]> {
  const table = await db.prepare("SELECT database_id FROM database_table WHERE id=?")
    .bind(oldField.table_id)
    .first<{ database_id: number }>();
  if (!table) return [];

  const activeFields = await db.prepare(
    `SELECT f.*
     FROM database_field f
     JOIN database_table t ON t.id=f.table_id
     WHERE t.database_id=? AND f.trashed=0
     ORDER BY f.table_id ASC, f.[order] ASC, f.id ASC`
  ).bind(table.database_id).all<FieldRow>();

  const impactedIds: number[] = [];
  for (const field of activeFields.results || []) {
    if (field.id === oldField.id) continue;
    const nextSettings = updateSettingsForRenamedField(field, oldField, newField, activeFields.results || []);
    if (!nextSettings) continue;
    await db.prepare("UPDATE database_field SET field_settings=?, updated_on=? WHERE id=?")
      .bind(JSON.stringify(nextSettings), now, field.id)
      .run();
    impactedIds.push(field.id);
  }

  if (impactedIds.length === 0) return [];
  const bindMarks = impactedIds.map(() => "?").join(",");
  const refreshed = await db.prepare(
    `SELECT * FROM database_field WHERE id IN (${bindMarks}) ORDER BY table_id ASC, [order] ASC, id ASC`
  ).bind(...impactedIds).all<FieldRow>();
  return refreshed.results || [];
}

function brokenFieldSettings(field: FieldRow, deletedField: FieldRow): Record<string, unknown> {
  const settings = normalizeFieldSettings(field);
  const error = `references deleted field "${deletedField.name}"`;
  if (field.type === "formula" || field.type === "lookup" || field.type === "rollup" || field.type === "count") {
    return {
      ...settings,
      formula_type: "invalid",
      array_formula_type: null,
      formula_type_error: error,
    };
  }
  if (field.type === "link_row") {
    return {
      ...settings,
      link_row_related_field_id: null,
    };
  }
  if (field.type === "ai" && numericSetting(settings, "ai_file_field_id") === deletedField.id) {
    return { ...settings, ai_file_field_id: null };
  }
  return settings;
}

async function markFieldsImpactedByDeletedField(
  db: D1Database,
  deletedField: FieldRow,
  now: string
): Promise<FieldRow[]> {
  const table = await db.prepare("SELECT database_id FROM database_table WHERE id=?")
    .bind(deletedField.table_id)
    .first<{ database_id: number }>();
  if (!table) return [];

  const activeFields = await db.prepare(
    `SELECT f.*
     FROM database_field f
     JOIN database_table t ON t.id=f.table_id
     WHERE t.database_id=? AND f.trashed=0 AND f.id != ?
     ORDER BY f.table_id ASC, f.[order] ASC, f.id ASC`
  ).bind(table.database_id, deletedField.id).all<FieldRow>();

  const impacted = (activeFields.results || [])
    .filter((field) => fieldDependsOnDeletedField(field, deletedField, activeFields.results || []));
  for (const field of impacted) {
    await db.prepare(
      "UPDATE database_field SET field_settings=?, updated_on=? WHERE id=?"
    ).bind(JSON.stringify(brokenFieldSettings(field, deletedField)), now, field.id).run();
    await synchronizeFieldDependencies(db, field.id);
  }

  if (impacted.length === 0) return [];
  const bindMarks = impacted.map(() => "?").join(",");
  const refreshed = await db.prepare(
    `SELECT * FROM database_field WHERE id IN (${bindMarks}) ORDER BY table_id ASC, [order] ASC, id ASC`
  ).bind(...impacted.map((field) => field.id)).all<FieldRow>();
  return refreshed.results || [];
}

function scalarLabel(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(scalarLabel).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const label = raw.value ?? raw.visible_name ?? raw.original_name ?? raw.name ?? raw.email ?? raw.url ?? raw.id;
    return label === null || label === undefined ? "" : String(label);
  }
  return String(value);
}

function splitCommaValues(value: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      const trimmed = current.trim();
      if (trimmed) values.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }
  const trimmed = current.trim();
  if (trimmed) values.push(trimmed);
  return values;
}

function uniqueValueLabels(fieldType: FieldType, value: unknown, splitCommaSeparated: boolean): string[] {
  const parsed = parseMaybeJson(value);
  if (parsed === null || parsed === undefined || parsed === "") return [];

  if (["multiple_select", "link_row", "file", "multiple_collaborators"].includes(fieldType)) {
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map(scalarLabel).map((item) => item.trim()).filter(Boolean);
  }

  const label = scalarLabel(parsed).trim();
  if (!label) return [];
  return splitCommaSeparated ? splitCommaValues(label) : [label];
}

// ── GET /api/database/fields/table/:tableId/ — List fields ──────────────────
fields.get("/table/:tableId/", databaseTokenAuthMiddleware({ optional: true }), async (c) => {
  const user = c.get("user");
  const tableId = parseInt(c.req.param("tableId"));
  const dbToken = c.get("db_token_permissions");

  const checkAccess = async () => {
    if (!dbToken) {
      await requireTableAccess(c.env.DB, user?.id, tableId);
      return;
    }
    const row = await getTableWorkspace(c.env.DB, tableId);
    if (!row) throw new DoesNotExist("Table", tableId);
    const table = { id: tableId, database_id: row.database_id, workspace_id: row.workspace_id };
    if (!databaseTokenAllows(dbToken, table, ["read", "create", "update"])) {
      throw new PermissionError("The database token does not have permissions to the table.");
    }
    await assertHasTableRole(c.env.DB, user!.id, table, "VIEWER");
  };
  const result = await readAfterAccessCheck(checkAccess(), c.env.DB.prepare(
    `SELECT * FROM database_field WHERE table_id = ? AND trashed = 0 ORDER BY [order] ASC`
  )
    .bind(tableId)
    .all<FieldRow>());

  return c.json(await Promise.all((result.results || []).map((field) => serializeField(c.env.DB, field))));
});

// ── POST /api/database/fields/table/:tableId/generate-ai-formula/ ──────────────
fields.post("/table/:tableId/generate-ai-formula/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const body = await c.req.json<{
    ai_type?: string;
    ai_model?: string;
    ai_temperature?: number | null;
    ai_prompt?: string;
  }>();
  const meta = await requireTableAccess(c.env.DB, user.id, tableId, "VIEWER");
  const provider = String(body.ai_type || "").trim();
  const model = String(body.ai_model || "").trim();
  const prompt = String(body.ai_prompt || "").trim();
  const temperature = body.ai_temperature === null || body.ai_temperature === undefined
    ? null
    : Number(body.ai_temperature);

  if (!provider) throw new ValidationError("ai_type is required.");
  if (!model) throw new ValidationError("ai_model is required.");
  if (!prompt) throw new ValidationError("ai_prompt is required.");
  if (prompt.length > 1000) throw new ValidationError("Ensure this field has no more than 1000 characters.");
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new ValidationError("ai_temperature must be between 0 and 2.");
  }

  const settings = await workspaceGenerativeAISettings(c.env.CACHE, meta.workspace_id);
  const output = await promptGenerativeAI(settings, provider, model, prompt, temperature);
  return c.json({ formula: output.trim() });
});

// ── POST /api/database/fields/password-authentication/ ──────────────────────
fields.post("/password-authentication/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ field_id?: number; row_id?: number; password?: string }>();
  const fieldId = Number(body.field_id);
  const rowId = Number(body.row_id);
  if (!Number.isInteger(fieldId) || !Number.isInteger(rowId)) {
    throw new ValidationError("field_id and row_id are required.");
  }

  const field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id=? AND type='password' AND trashed=0")
    .bind(fieldId)
    .first<FieldRow>();
  if (!field) throw new DoesNotExist("Field", fieldId);

  const settings = normalizeFieldSettings(field);
  if (settings.allow_endpoint_authentication !== true) {
    throw new DoesNotExist("Field", fieldId);
  }

  await requireTableAccess(c.env.DB, user.id, field.table_id, "VIEWER");
  await ensureUserTableSystemColumns(c.env.DB, field.table_id);
  const row = await c.env.DB.prepare(`SELECT "field_${field.id}" AS password_hash FROM "database_table_${field.table_id}" WHERE id=? AND COALESCE(trashed, 0)=0`)
    .bind(rowId)
    .first<{ password_hash: string | null }>();
  if (!row) throw new DoesNotExist("Row", rowId);

  const stored = String(row.password_hash || "");
  const password = String(body.password || "");
  const matches = Boolean(stored) && (
    await verifyPassword(password, stored).catch(() => false) ||
    password === stored
  );
  if (!matches) {
    return c.json({ error: "ERROR_INVALID_PASSWORD_FIELD_PASSWORD", detail: "The provided password is incorrect." }, 401);
  }
  return c.json({ is_correct: true });
});

// ── POST /api/database/fields/:fieldId/generate-ai-field-values/ ───────────────
fields.post("/:fieldId/generate-ai-field-values/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const fieldId = Number(c.req.param("fieldId"));
  const body = await c.req.json<{ row_ids?: unknown[] }>();
  const rowIds = Array.isArray(body.row_ids) ? body.row_ids.map((rowId) => Number(rowId)) : [];
  const limit = Number(c.env.BATCH_ROWS_SIZE_LIMIT || 200);

  if (!Number.isInteger(fieldId) || fieldId <= 0) throw new DoesNotExist("Field", fieldId);
  if (rowIds.length === 0) throw new ValidationError("row_ids is required.");
  if (rowIds.length > limit) throw new ValidationError(`Ensure this field has no more than ${limit} elements.`);
  if (rowIds.some((rowId) => !Number.isInteger(rowId) || rowId <= 0)) {
    throw new ValidationError("row_ids must be a list of row ids.");
  }

  const field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id=? AND trashed=0")
    .bind(fieldId)
    .first<FieldRow>();
  if (!field || field.type !== "ai") throw new DoesNotExist("Field", fieldId);
  const meta = await requireTableAccess(c.env.DB, user.id, field.table_id, "VIEWER");

  const ph = rowIds.map(() => "?").join(",");
  await ensureUserTableSystemColumns(c.env.DB, field.table_id);
  const existing = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM "database_table_${field.table_id}" WHERE COALESCE(trashed, 0)=0 AND id IN (${ph})`)
    .bind(...rowIds)
    .first<{ count: number }>();
  if ((existing?.count ?? 0) !== rowIds.length) throw new DoesNotExist("Row");

  const now = new Date().toISOString();
  const initialResult = {
    field_id: fieldId,
    row_ids: rowIds,
    view_id: null,
    only_empty: false,
  };
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
     VALUES ('generate_ai_values', 'pending', 0, ?, ?, ?, ?) RETURNING *`
  ).bind(user.id, now, now, JSON.stringify(initialResult)).first<any>();
  if (!job) throw new Error("Failed to create job");

  await c.env.JOBS_QUEUE.send({
    job_id: job.id,
    job_type: "generate_ai_values",
    payload: initialResult,
    user_id: user.id,
    workspace_id: meta.workspace_id,
  });

  const auditCtx = await fieldAuditDetails(c.env.DB, fieldId);
  await logAuditEntry(c.env.DB, "job.create", {
    user,
    workspace_id: meta.workspace_id,
    workspace_name: auditCtx?.workspace_name || "",
  }, { id: job.id, type: "job" }, {
    job_id: job.id,
    job_type: "generate_ai_values",
    field_id: fieldId,
    field_name: field.name,
    table_id: field.table_id,
    row_ids: rowIds,
    status: "pending",
  });

  return c.json({
    id: job.id,
    type: "generate_ai_values",
    state: "pending",
    status: "pending",
    progress_percentage: 0,
    error: null,
    human_readable_error: null,
    result: initialResult,
    ...initialResult,
    user_id: user.id,
    created_on: now,
    updated_on: now,
  }, 202);
});

// ── POST /api/database/fields/table/:tableId/ — Create field ─────────────────
fields.post("/table/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const body = await c.req.json<{
    name: string;
    type: FieldType;
    [key: string]: unknown;
  }>();

  const meta = await requireTableAccess(c.env.DB, user.id, tableId, "BUILDER");

  if (!body.name?.trim()) throw new ValidationError("name is required.");
  if (!VALID_FIELD_TYPES.includes(body.type)) {
    throw new ValidationError(`Invalid field type: ${body.type}`);
  }

  // Check name uniqueness in table
  const existing = await c.env.DB.prepare(
    "SELECT id FROM database_field WHERE table_id = ? AND name = ? AND trashed = 0"
  )
    .bind(tableId, body.name.trim())
    .first<{ id: number }>();
  if (existing) {
    return c.json(
      { error: "ERROR_FIELD_WITH_SAME_NAME_ALREADY_EXISTS", detail: "A field with this name already exists." },
      400
    );
  }

  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX([order]), 0) as max_order FROM database_field WHERE table_id = ? AND trashed = 0`
  )
    .bind(tableId)
    .first<{ max_order: number }>();

  // Extract type-specific settings
  const { name, type, ...typeSettings } = body;
  const {
    select_options: selectOptions,
    has_related_field: hasRelatedFieldValue,
    ...settingsWithoutSelectOptions
  } = typeSettings as Record<string, unknown>;
  const hasRelatedField = hasRelatedFieldValue === undefined ? undefined : Boolean(hasRelatedFieldValue);
  let normalizedSettings: Record<string, unknown>;
  try {
    const aiModels = type === "ai"
      ? enabledGenerativeAIModels(await workspaceGenerativeAISettings(c.env.CACHE, meta.workspace_id))
      : undefined;
    normalizedSettings = await validateComputedFieldSettings(
      c.env.DB,
      tableId,
      type,
      {},
      hasRelatedField === undefined
        ? settingsWithoutSelectOptions
        : { ...settingsWithoutSelectOptions, has_related_field: hasRelatedField },
      undefined,
      { enabledGenerativeAIModels: aiModels, actorUserId: user.id }
    );
  } catch (error) {
    return fieldConfigurationResponse(c, error);
  }
  const fieldSettings = Object.keys(normalizedSettings).length > 0
    ? JSON.stringify(normalizedSettings)
    : null;

  const now = new Date().toISOString();
  const fieldResult = await c.env.DB.prepare(
    `INSERT INTO database_field
     (table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
      immutable_type, immutable_properties, field_settings, created_on, updated_on)
     VALUES (?, ?, ?, ?, 0, ?, 0, NULL, 0, 0, 0, ?, ?, ?) RETURNING id`
  )
    .bind(tableId, name.trim(), type, (maxOrder?.max_order ?? 0) + 1, isReadOnlyFieldType(type) ? 1 : 0, fieldSettings, now, now)
    .first<{ id: number }>();

  if (!fieldResult) throw new Error("Failed to create field");

  // Add column to the user table
  const fieldDef: FieldDefinition = { id: fieldResult.id, type };
  await addFieldColumn(c.env.DB, tableId, fieldDef);
  if (type === "autonumber" || type === "auto_number") {
    await initializeAutonumberField(
      c.env.DB,
      tableId,
      fieldResult.id,
      normalizedSettings.view_id === null || normalizedSettings.view_id === undefined
        ? null
        : Number(normalizedSettings.view_id)
    );
  } else if (["uuid", "created_on", "last_modified", "created_by", "last_modified_by"].includes(type)) {
    await convertExistingFieldValues(c.env.DB, tableId, {
      id: fieldResult.id,
      name: name.trim(),
      type,
      primary: false,
      readOnly: true,
      settings: normalizedSettings,
    }, "text");
  }

  // For single_select / multiple_select — create options if provided
  let createdSettings = normalizedSettings;
  if ((type === "single_select" || type === "multiple_select" || (type === "ai" && normalizedSettings.ai_output_type === "choice")) && Array.isArray(selectOptions)) {
    const optionIds = await replaceSelectOptions(c.env.DB, fieldResult.id, selectOptions as Array<{ id?: number; value?: string; color?: string }>);
    createdSettings = remapSelectDefaults(normalizedSettings, optionIds);
  }
  await backfillCreatedFieldDefault(c.env.DB, tableId, fieldResult.id, type, createdSettings);

  await createFieldOptionsForExistingViews(
    c.env.DB,
    tableId,
    fieldResult.id,
    (maxOrder?.max_order ?? 0) + 1
  );

  let field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ?")
    .bind(fieldResult.id)
    .first<FieldRow>();
  let relatedFields: FieldRow[] = [];
  if (field?.type === "link_row") {
    const settings = normalizeFieldSettings(field);
    const shouldCreateRelated = Number(settings.link_row_table_id || 0) !== tableId && hasRelatedField !== false;
    if (shouldCreateRelated) {
      relatedFields = [await createRelatedLinkField(c.env.DB, field, now)];
      field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ?")
        .bind(fieldResult.id)
        .first<FieldRow>();
    }
  }
  await synchronizeFieldDependencies(c.env.DB, fieldResult.id);

  const createdSnapshot = await snapshotFieldForUndoRedo(c.env.DB, fieldResult.id);
  if (createdSnapshot) {
    await createUndoableAction(c.env.DB, {
      user,
      actionType: "create_field",
      params: {
        field_id: fieldResult.id,
        table_id: tableId,
        before: null,
        after: createdSnapshot,
      },
      ...fieldActionContext(c, tableId),
    });
  }

  const serializedRelatedFields = await Promise.all(relatedFields.map((related) => serializeField(c.env.DB, related)));
  const serializedField = {
    ...(await serializeField(c.env.DB, field!)),
    related_fields: serializedRelatedFields,
  };
  await broadcastToWorkspace(c.env, meta.workspace_id, {
    type: "field_created",
    field: serializedField,
    table_id: tableId,
    related_fields: serializedRelatedFields,
  });
  const audit = await fieldAuditDetails(c.env.DB, fieldResult.id);
  await logAuditEntry(c.env.DB, "database.field.create", {
    user,
    workspace_id: meta.workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: fieldResult.id, type: "field" }, {
    database_id: meta.database_id,
    table_id: tableId,
    table_name: audit?.table_name,
    field_id: fieldResult.id,
    field_name: audit?.field_name || name.trim(),
    field_type: type,
  });
  c.executionCtx.waitUntil(triggerTableWebhooks(c.env, tableId, "field.created", { field: serializedField }));

  return c.json(serializedField, 200);
});

// ── GET /api/database/fields/:fieldId/ ──────────────────────────────────────
fields.get("/:fieldId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const fieldId = parseInt(c.req.param("fieldId"));

  const field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ? AND trashed = 0")
    .bind(fieldId)
    .first<FieldRow>();
  if (!field) throw new DoesNotExist("Field", fieldId);

  await requireTableAccess(c.env.DB, user?.id, field.table_id);

  return c.json(await serializeField(c.env.DB, field));
});

// ── GET /api/database/fields/:fieldId/unique_row_values/ ────────────────────
fields.get("/:fieldId/unique_row_values/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const fieldId = Number(c.req.param("fieldId"));
  const limit = Math.min(100, Number(c.req.query("limit") || 10));
  const splitCommaSeparated = c.req.query("split_comma_separated") === "true";

  const field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ? AND trashed = 0")
    .bind(fieldId)
    .first<FieldRow>();
  if (!field) throw new DoesNotExist("Field", fieldId);

  await requireTableAccess(c.env.DB, user?.id, field.table_id);

  if (UNIQUE_VALUE_INCOMPATIBLE_FIELD_TYPES.has(field.type)) {
    return c.json({
      error: "ERROR_INCOMPATIBLE_FIELD_TYPE_FOR_UNIQUE_VALUES",
      detail: "The requested field type is not compatible with generating unique values.",
    }, 400);
  }

  await ensureUserTableSystemColumns(c.env.DB, field.table_id);
  const rows = await c.env.DB.prepare(
    `SELECT "field_${fieldId}" AS value
     FROM "database_table_${field.table_id}"
     WHERE COALESCE(trashed, 0)=0 AND "field_${fieldId}" IS NOT NULL AND "field_${fieldId}" != ''`
  )
    .all<{ value: string }>();

  const frequencies = new Map<string, number>();
  for (const row of rows.results || []) {
    for (const label of uniqueValueLabels(field.type, row.value, splitCommaSeparated)) {
      frequencies.set(label, (frequencies.get(label) || 0) + 1);
    }
  }

  return c.json({
    values: [...frequencies.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([value]) => value),
  });
});

// ── PATCH /api/database/fields/:fieldId/ — Update field ─────────────────────
fields.patch("/:fieldId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const fieldId = parseInt(c.req.param("fieldId"));
  const body = await c.req.json<Partial<{
    name: string;
    type: FieldType;
    description: string;
    db_index: boolean;
    [key: string]: unknown;
  }>>();

  const field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ? AND trashed = 0")
    .bind(fieldId)
    .first<FieldRow>();
  if (!field) throw new DoesNotExist("Field", fieldId);

  const meta = await requireTableAccess(c.env.DB, user.id, field.table_id, "BUILDER");
  // Cells are only kept for undo when the edit converts stored data.
  const convertsCells = (body.type !== undefined && body.type !== field.type) ||
    CELL_STORAGE_SETTING_KEYS.some((key) => key in (body as Record<string, unknown>));
  const beforeSnapshot = await snapshotFieldForUndoRedo(c.env.DB, fieldId, { includeCells: convertsCells });

  // Cannot change type of immutable fields
  if (body.type && body.type !== field.type && Boolean(field.immutable_type)) {
    return c.json(
      { error: "CANNOT_CHANGE_FIELD_TYPE", detail: "This field type cannot be changed." },
      400
    );
  }
  if (body.type !== undefined && !VALID_FIELD_TYPES.includes(body.type)) {
    throw new ValidationError(`Invalid field type: ${body.type}`);
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    // Check name uniqueness
    const nameConflict = await c.env.DB.prepare(
      "SELECT id FROM database_field WHERE table_id = ? AND name = ? AND trashed = 0 AND id != ?"
    )
      .bind(field.table_id, body.name.trim(), fieldId)
      .first();
    if (nameConflict) {
      return c.json({ error: "ERROR_FIELD_WITH_SAME_NAME_ALREADY_EXISTS", detail: "Field name already exists." }, 400);
    }
    updates.push("name = ?");
    values.push(body.name.trim());
  }

  if (body.type !== undefined && body.type !== field.type) {
    updates.push("type = ?");
    values.push(body.type);
    updates.push("read_only = ?");
    values.push(isReadOnlyFieldType(body.type) ? 1 : 0);
  }

  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(body.description);
  }

  if (body.db_index !== undefined) {
    updates.push("db_index = ?");
    values.push(body.db_index ? 1 : 0);
  }

  // Update type-specific settings
  const { name, type, description, db_index, ...typeSettings } = body;
  const {
    select_options: selectOptions,
    has_related_field: hasRelatedFieldValue,
    ...settingsWithoutSelectOptions
  } = typeSettings as Record<string, unknown>;
  const hasRelatedField = hasRelatedFieldValue === undefined ? undefined : Boolean(hasRelatedFieldValue);
  const targetType = body.type || field.type;
  const dateForceTimezoneOffset = targetType === "date" && settingsWithoutSelectOptions.date_force_timezone_offset !== null && settingsWithoutSelectOptions.date_force_timezone_offset !== undefined
    ? Number(settingsWithoutSelectOptions.date_force_timezone_offset)
    : null;
  if (Object.keys(typeSettings).length > 0 || body.type !== undefined) {
    const existingSettings = targetType === field.type ? normalizeFieldSettings(field) : {};
    delete existingSettings.select_options;
    let merged: Record<string, unknown>;
    try {
      const aiModels = targetType === "ai"
        ? enabledGenerativeAIModels(await workspaceGenerativeAISettings(c.env.CACHE, meta.workspace_id))
        : undefined;
      merged = await validateComputedFieldSettings(
        c.env.DB,
        field.table_id,
        targetType,
        existingSettings,
        hasRelatedField === undefined
          ? settingsWithoutSelectOptions
          : { ...settingsWithoutSelectOptions, has_related_field: hasRelatedField },
        fieldId,
        { enabledGenerativeAIModels: aiModels, actorUserId: user.id }
      );
    } catch (error) {
      return fieldConfigurationResponse(c, error);
    }
    updates.push("field_settings = ?");
    values.push(JSON.stringify(merged));
  }

  const updatedOn = new Date().toISOString();
  if (updates.length > 0) {
    updates.push("updated_on = ?");
    values.push(updatedOn);
    values.push(fieldId);
    await c.env.DB.prepare(`UPDATE database_field SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  let updated = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ?")
    .bind(fieldId)
    .first<FieldRow>();

  if (Array.isArray(selectOptions) && (
    targetType === "single_select" ||
    targetType === "multiple_select" ||
    (targetType === "ai" && (updated ? normalizeFieldSettings(updated).ai_output_type : undefined) === "choice")
  )) {
    await replaceSelectOptions(
      c.env.DB,
      fieldId,
      selectOptions as Array<{ id?: number; value?: string; color?: string }>,
      targetType === field.type
    );
    updated = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ?")
      .bind(fieldId)
      .first<FieldRow>();
  }

  const oldSettings = normalizeFieldSettings(field);
  const newSettings = updated ? normalizeFieldSettings(updated) : {};
  const typeChanged = Boolean(updated && body.type !== undefined && body.type !== field.type);
  const linkTargetChanged = Boolean(
    updated &&
    updated.type === "link_row" &&
    field.type === "link_row" &&
    oldSettings.link_row_table_id !== newSettings.link_row_table_id
  );
  const storageSettingsChanged = Boolean(updated && !typeChanged && (
    updated.type === "number" && (
      oldSettings.number_decimal_places !== newSettings.number_decimal_places ||
      oldSettings.number_negative !== newSettings.number_negative
    ) ||
    updated.type === "rating" && oldSettings.max_value !== newSettings.max_value ||
    updated.type === "duration" && oldSettings.duration_format !== newSettings.duration_format ||
    updated.type === "date" && oldSettings.date_include_time !== newSettings.date_include_time
    || linkTargetChanged
  ));

  if (updated && (typeChanged || storageSettingsChanged)) {
    const settings = normalizeFieldSettings(updated);
    await convertExistingFieldValues(c.env.DB, field.table_id, {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      primary: Boolean(updated.primary),
      readOnly: Boolean(updated.read_only),
      settings,
    }, field.type, linkTargetChanged);
  }
  if (updated && updated.type === "date" && dateForceTimezoneOffset !== null) {
    await shiftDateFieldValues(c.env.DB, field.table_id, updated.id, dateForceTimezoneOffset);
  }
  if (updated) {
    await applyViewFieldLifecycleHooks(c.env.DB, updated);
  }

  if (
    updated &&
    typeChanged &&
    (field.type === "single_select" || field.type === "multiple_select") &&
    updated.type !== "single_select" &&
    updated.type !== "multiple_select"
  ) {
    await c.env.DB.prepare("DELETE FROM database_selectoption WHERE field_id=?").bind(fieldId).run();
  }

  const linkRelatedFields = updated
    ? await reconcileRelatedLinkField(c.env.DB, field, updated, hasRelatedField, updatedOn)
    : [];
  if (updated && (updated.type === "link_row" || field.type === "link_row")) {
    updated = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ?")
      .bind(fieldId)
      .first<FieldRow>();
  }
  await synchronizeFieldDependencies(c.env.DB, fieldId);

  const relatedFieldIds = new Set<number>();
  linkRelatedFields.forEach((relatedField) => relatedFieldIds.add(relatedField.id));
  if (updated && body.name !== undefined && body.name.trim() !== field.name) {
    const renamedRelatedFields = await updateFieldsImpactedByRenamedField(c.env.DB, field, updated, updatedOn);
    renamedRelatedFields.forEach((relatedField) => relatedFieldIds.add(relatedField.id));
  }
  if (updated && typeChanged) {
    const typeChangedRelatedFields = await updateFieldsImpactedByTypeChange(c.env.DB, updated, updatedOn);
    typeChangedRelatedFields.forEach((relatedField) => relatedFieldIds.add(relatedField.id));
  }

  let relatedFields: FieldRow[] = [];
  if (relatedFieldIds.size > 0) {
    const bindMarks = [...relatedFieldIds].map(() => "?").join(",");
    const refreshedRelatedFields = await c.env.DB.prepare(
      `SELECT * FROM database_field WHERE id IN (${bindMarks}) ORDER BY table_id ASC, [order] ASC, id ASC`
    ).bind(...relatedFieldIds).all<FieldRow>();
    relatedFields = refreshedRelatedFields.results || [];
  }
  const serializedRelatedFields = await Promise.all(
    relatedFields.map((relatedField) => serializeField(c.env.DB, relatedField))
  );
  const serializedUpdated = {
    ...(await serializeField(c.env.DB, updated!)),
    related_fields: serializedRelatedFields,
  };
  await revalidateDateDependencyRules(c.env.DB, field.table_id);
  for (const relatedField of relatedFields) {
    if (relatedField.table_id !== field.table_id) {
      await revalidateDateDependencyRules(c.env.DB, relatedField.table_id);
    }
  }
  const afterSnapshot = await snapshotFieldForUndoRedo(c.env.DB, fieldId, {
    includeCells: convertsCells,
    extraFieldIds: snapshotFieldIds(beforeSnapshot),
  });
  if (beforeSnapshot && afterSnapshot) {
    await createUndoableAction(c.env.DB, {
      user,
      actionType: "update_field",
      params: {
        field_id: fieldId,
        table_id: field.table_id,
        before: beforeSnapshot,
        after: afterSnapshot,
      },
      ...fieldActionContext(c, field.table_id),
    });
  }

  await broadcastToWorkspace(c.env, meta.workspace_id, {
    type: "field_updated",
    field: serializedUpdated,
    table_id: field.table_id,
    related_fields: serializedRelatedFields,
  });
  const audit = await fieldAuditDetails(c.env.DB, fieldId);
  await logAuditEntry(c.env.DB, "database.field.update", {
    user,
    workspace_id: meta.workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: fieldId, type: "field" }, {
    database_id: meta.database_id,
    table_id: field.table_id,
    table_name: audit?.table_name,
    field_id: fieldId,
    field_name: audit?.field_name || updated?.name,
    field_type: audit?.field_type || updated?.type,
    before: {
      name: body.name !== undefined ? field.name : undefined,
      type: body.type !== undefined ? field.type : undefined,
    },
    after: {
      name: body.name !== undefined ? updated?.name : undefined,
      type: body.type !== undefined ? updated?.type : undefined,
    },
  });
  c.executionCtx.waitUntil(triggerTableWebhooks(c.env, field.table_id, "field.updated", {
    field: serializedUpdated,
    related_fields: serializedRelatedFields,
  }));

  return c.json(serializedUpdated);
});

// ── DELETE /api/database/fields/:fieldId/ ─────────────────────────────────────
fields.delete("/:fieldId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const fieldId = parseInt(c.req.param("fieldId"));

  const field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ? AND trashed = 0")
    .bind(fieldId)
    .first<FieldRow>();
  if (!field) throw new DoesNotExist("Field", fieldId);

  if (Boolean(field.primary)) {
    return c.json({ error: "CANNOT_DELETE_PRIMARY_FIELD", detail: "The primary field cannot be deleted." }, 400);
  }

  const meta = await requireTableAccess(c.env.DB, user.id, field.table_id, "BUILDER");
  const table = await c.env.DB.prepare("SELECT id, name, database_id FROM database_table WHERE id=?")
    .bind(field.table_id)
    .first<{ id: number; name: string; database_id: number }>();
  if (!table) throw new DoesNotExist("Table", field.table_id);
  const now = new Date().toISOString();
  const beforeSnapshot = await snapshotFieldForUndoRedo(c.env.DB, fieldId);
  const fieldSettings = normalizeFieldSettings(field);
  const relatedLinkFieldId = field.type === "link_row"
    ? Number(fieldSettings.link_row_related_field_id || 0)
    : 0;
  const relatedLinkField = relatedLinkFieldId
    ? await c.env.DB.prepare("SELECT * FROM database_field WHERE id=? AND type='link_row' AND trashed=0")
      .bind(relatedLinkFieldId)
      .first<FieldRow>()
    : null;

  await recordTrashEntry(c.env.DB, {
    userId: user.id,
    workspaceId: meta.workspace_id,
    applicationId: meta.database_id,
    trashItemType: "field",
    trashItemId: fieldId,
    name: field.name,
    parentName: table.name,
    trashedAt: now,
  });
  await c.env.DB.prepare("UPDATE database_field SET trashed = 1, updated_on = ? WHERE id = ?")
    .bind(now, fieldId)
    .run();
  await applyViewFieldLifecycleHooks(c.env.DB, field, true);
  if (relatedLinkField) {
    await c.env.DB.prepare("UPDATE database_field SET trashed=1, updated_on=? WHERE id=?")
      .bind(now, relatedLinkField.id)
      .run();
    await applyViewFieldLifecycleHooks(c.env.DB, relatedLinkField, true);
  }

  await synchronizeFieldDependencies(c.env.DB, field.id);
  if (relatedLinkField) await synchronizeFieldDependencies(c.env.DB, relatedLinkField.id);

  const relatedFields = await markFieldsImpactedByDeletedField(c.env.DB, field, now);
  if (relatedLinkField) {
    const impactedByRelated = await markFieldsImpactedByDeletedField(c.env.DB, relatedLinkField, now);
    const seen = new Set(relatedFields.map((relatedField) => relatedField.id));
    for (const impacted of impactedByRelated) {
      if (!seen.has(impacted.id)) relatedFields.push(impacted);
    }
  }
  const serializedRelatedFields = await Promise.all(
    relatedFields.map((relatedField) => serializeField(c.env.DB, relatedField))
  );
  await revalidateDateDependencyRules(c.env.DB, field.table_id);
  if (relatedLinkField && relatedLinkField.table_id !== field.table_id) {
    await revalidateDateDependencyRules(c.env.DB, relatedLinkField.table_id);
  }
  const afterSnapshot = await snapshotFieldForUndoRedo(c.env.DB, fieldId, { extraFieldIds: snapshotFieldIds(beforeSnapshot) });
  if (beforeSnapshot && afterSnapshot) {
    await createUndoableAction(c.env.DB, {
      user,
      actionType: "delete_field",
      params: {
        field_id: fieldId,
        table_id: field.table_id,
        before: beforeSnapshot,
        after: afterSnapshot,
      },
      ...fieldActionContext(c, field.table_id),
    });
  }

  await broadcastToWorkspace(c.env, meta.workspace_id, {
    type: "field_deleted",
    field_id: fieldId,
    table_id: field.table_id,
    related_fields: serializedRelatedFields,
  });
  const audit = await fieldAuditDetails(c.env.DB, fieldId);
  await logAuditEntry(c.env.DB, "database.field.delete", {
    user,
    workspace_id: meta.workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: fieldId, type: "field" }, {
    database_id: meta.database_id,
    table_id: field.table_id,
    table_name: table.name,
    field_id: fieldId,
    field_name: field.name,
    field_type: field.type,
  });
  c.executionCtx.waitUntil(triggerTableWebhooks(c.env, field.table_id, "field.deleted", {
    field_id: fieldId,
    related_fields: serializedRelatedFields,
  }));

  return c.json({ related_fields: serializedRelatedFields });
});

// ── POST /api/database/fields/:fieldId/duplicate/async/ ─────────────────────
fields.post("/:fieldId/duplicate/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const fieldId = Number(c.req.param("fieldId"));
  const body = await c.req.json<{ duplicate_data?: boolean }>().catch(() => ({ duplicate_data: false }));

  const field = await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ? AND trashed = 0")
    .bind(fieldId)
    .first<FieldRow>();
  if (!field) throw new DoesNotExist("Field", fieldId);

  await requireTableAccess(c.env.DB, user.id, field.table_id, "BUILDER");

  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX([order]), 0) AS max_order FROM database_field WHERE table_id = ? AND trashed = 0`
  )
    .bind(field.table_id)
    .first<{ max_order: number }>();
  const now = new Date().toISOString();
  let duplicated = await c.env.DB.prepare(
    `INSERT INTO database_field
     (table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
      immutable_type, immutable_properties, field_settings, created_on, updated_on)
     VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  )
    .bind(
      field.table_id,
      `${field.name} (copy)`,
      field.type,
      (maxOrder?.max_order || 0) + 1,
      field.read_only ? 1 : 0,
      field.description,
      field.db_index ? 1 : 0,
      field.immutable_type ? 1 : 0,
      field.immutable_properties ? 1 : 0,
      field.field_settings,
      now,
      now
    )
    .first<FieldRow>();
  if (!duplicated) throw new Error("Failed to duplicate field");

  await addFieldColumn(c.env.DB, field.table_id, { id: duplicated.id, type: duplicated.type });

  let duplicatedSelectOptionMap = new Map<number, DuplicatedSelectOption>();
  if (field.type === "single_select" || field.type === "multiple_select") {
    duplicatedSelectOptionMap = await duplicateSelectOptions(c.env.DB, field.id, duplicated.id);
    const remappedSettings = remapDuplicatedSelectFieldSettings(field.type, field.field_settings, duplicatedSelectOptionMap);
    await c.env.DB.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
      .bind(JSON.stringify(remappedSettings), duplicated.id)
      .run();
    duplicated = (await c.env.DB.prepare("SELECT * FROM database_field WHERE id = ?")
      .bind(duplicated.id)
      .first<FieldRow>())!;
  }

  if (body.duplicate_data && (field.type === "single_select" || field.type === "multiple_select")) {
    await copyDuplicatedSelectFieldData(
      c.env.DB,
      field.table_id,
      field.id,
      duplicated.id,
      field.type,
      duplicatedSelectOptionMap
    );
  } else if (body.duplicate_data) {
    await ensureUserTableSystemColumns(c.env.DB, field.table_id);
    await c.env.DB.prepare(
      `UPDATE "database_table_${field.table_id}"
       SET "field_${duplicated.id}" = "field_${field.id}"
       WHERE COALESCE(trashed, 0)=0`
    ).run();
  }

  await duplicateFieldDependencies(c.env.DB, field.table_id, new Map([[field.id, duplicated.id]]));

  await duplicateFieldViewOptions(
    c.env.DB,
    field.table_id,
    field.id,
    duplicated.id,
    duplicatedSelectOptionMap
  );

  const job = {
    id: duplicated.id,
    type: "duplicate_field",
    state: "finished",
    status: "finished",
    progress_percentage: 100,
    original_field: await serializeField(c.env.DB, field),
    duplicated_field: await serializeField(c.env.DB, duplicated),
  };
  const duplicatedSnapshot = await snapshotFieldForUndoRedo(c.env.DB, duplicated.id);
  if (duplicatedSnapshot) {
    await createUndoableAction(c.env.DB, {
      user,
      actionType: "duplicate_field",
      params: {
        field_id: duplicated.id,
        source_field_id: field.id,
        table_id: field.table_id,
        before: null,
        after: duplicatedSnapshot,
      },
      ...fieldActionContext(c, field.table_id),
    });
  }

  return c.json(job, 202);
});

// ── POST /api/database/fields/table/:tableId/change-primary-field/ ──────────
fields.post("/table/:tableId/change-primary-field/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const body = await c.req.json<{ new_primary_field_id: number }>();

  const meta = await requireTableAccess(c.env.DB, user.id, tableId, "BUILDER");

  const field = await c.env.DB.prepare(
    "SELECT * FROM database_field WHERE id = ? AND table_id = ? AND trashed = 0"
  )
    .bind(body.new_primary_field_id, tableId)
    .first<FieldRow>();
  if (!field) throw new DoesNotExist("Field", body.new_primary_field_id);
  if (Boolean(field.primary)) {
    return c.json(
      { error: "ERROR_FIELD_IS_ALREADY_PRIMARY", detail: "The provided field is already primary." },
      400
    );
  }
  if (!canBePrimaryField(field)) {
    return c.json(
      { error: "ERROR_INCOMPATIBLE_PRIMARY_FIELD_TYPE", detail: `The field type ${field.type} cannot be primary.` },
      400
    );
  }

  const oldPrimary = await c.env.DB.prepare(
    `SELECT * FROM database_field
     WHERE table_id = ? AND "primary" = 1 AND trashed = 0
     ORDER BY [order] ASC, id ASC
     LIMIT 1`
  ).bind(tableId).first<FieldRow>();
  if (!oldPrimary) {
    return c.json(
      { error: "ERROR_TABLE_HAS_NO_PRIMARY_FIELD", detail: "The provided table has no primary field." },
      400
    );
  }
  // Both snapshots cover both fields, so undo and redo move the primary flag back and forth.
  const primaryFieldIds = [Number(oldPrimary.id), Number(body.new_primary_field_id)];
  const beforeSnapshot = await snapshotFieldForUndoRedo(c.env.DB, oldPrimary.id, { extraFieldIds: primaryFieldIds });

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE database_field SET "primary" = 0 WHERE table_id = ?`).bind(tableId),
    c.env.DB.prepare(`UPDATE database_field SET "primary" = 1 WHERE id = ?`).bind(body.new_primary_field_id),
  ]);
  const afterSnapshot = await snapshotFieldForUndoRedo(c.env.DB, body.new_primary_field_id, { extraFieldIds: primaryFieldIds });

  const updatedField = { ...field, primary: true };
  const updatedOldPrimary = { ...oldPrimary, primary: false };
  const payload = {
    ...await serializeField(c.env.DB, updatedField),
    related_fields: [await serializeField(c.env.DB, updatedOldPrimary)],
  };

  if (beforeSnapshot && afterSnapshot) {
    await createUndoableAction(c.env.DB, {
      user,
      actionType: "change_primary_field",
      params: {
        field_id: body.new_primary_field_id,
        old_primary_field_id: oldPrimary.id,
        table_id: tableId,
        before: beforeSnapshot,
        after: afterSnapshot,
      },
      ...fieldActionContext(c, tableId),
    });
  }

  await broadcastToWorkspace(c.env, meta.workspace_id, {
    type: "field_updated",
    field: payload,
    related_fields: payload.related_fields,
    table_id: tableId,
  });

  return c.json(payload);
});

// ── POST /api/database/fields/table/:tableId/order/ — Reorder fields ─────────
fields.post("/table/:tableId/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const body = await c.req.json<{ field_ids: number[] }>();

  await requireTableAccess(c.env.DB, user.id, tableId, "BUILDER");
  const fieldIds = Array.isArray(body.field_ids) ? body.field_ids.map(Number) : [];
  if (fieldIds.length === 0 || fieldIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new ValidationError("field_ids must be a non-empty array of field ids.");
  }
  const tableFields = await c.env.DB.prepare(
    "SELECT id, [order] AS field_order FROM database_field WHERE table_id = ? AND trashed = 0"
  ).bind(tableId).all<{ id: number; field_order: number }>();
  const beforeOrders = (tableFields.results || []).map((field) => ({ id: Number(field.id), order: Number(field.field_order) }));
  const tableFieldIds = new Set(beforeOrders.map((field) => field.id));
  const foreignField = fieldIds.find((id) => !tableFieldIds.has(id));
  if (foreignField !== undefined) {
    throw new ApiError(400, "ERROR_FIELD_NOT_IN_TABLE", `The field ${foreignField} does not belong to the table.`);
  }

  const newOrders = new Map(fieldIds.map((id, index) => [id, index + 1]));
  const statements = fieldIds.map((id, index) =>
    c.env.DB.prepare(`UPDATE database_field SET [order] = ? WHERE id = ? AND table_id = ?`).bind(
      index + 1,
      id,
      tableId
    )
  );
  await c.env.DB.batch(statements);

  // Undo only needs the orders: never snapshot field data for a reorder.
  await createUndoableAction(c.env.DB, {
    user,
    actionType: "order_fields",
    params: {
      table_id: tableId,
      field_ids: fieldIds,
      before_orders: beforeOrders,
      after_orders: beforeOrders.map((field) => ({ id: field.id, order: newOrders.get(field.id) ?? field.order })),
    },
    ...fieldActionContext(c, tableId),
  });
  return c.json({});
});

export { fields as fieldRouter };
