import type { D1Database } from "@cloudflare/workers-types";
import {
  addFieldColumn,
  ensureUserTableSystemColumns,
  getOrCreateUserTable,
  serializeFieldValueForInsert,
  type FieldType,
} from "./dynamic-tables";
import { serializeDatabaseTable } from "./database-serializers";
import { duplicateViewDependencies } from "./view-duplication";
import { disableInvalidAIAutoUpdateUser, remapAIFieldSettings } from "./ai-field-settings";
import { revalidateDateDependencyRules } from "./field-rules";

type TableRow = {
  id: number;
  name: string;
  order: number;
  database_id: number;
  version?: number;
  trashed?: number;
};

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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type SelectOptionCopy = { id: number; value: string; color: string; option_order: number };
type SelectOptionValue = { id: number; value: string; color: string };
type PendingLinkValue = { rowId: number; fieldId: number; targetSourceTableId: number; value: unknown };
type FieldDependencyRow = {
  id: number;
  dependant_id: number;
  dependency_id?: number | null;
  via_id?: number | null;
  broken_reference_field_name?: string | null;
};

export type DuplicateTableResult = {
  sourceTable: TableRow;
  duplicatedTable: TableRow;
  original_table: object;
  duplicated_table: object;
};

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

  const remappedSettings = field.type === "ai" ? remapAIFieldSettings(settings, fieldMap) : settings;

  for (const key of ["through_field_id", "target_field_id", "link_row_related_field_id"]) {
    if (remappedSettings[key] !== undefined && remappedSettings[key] !== null) remappedSettings[key] = remapId(remappedSettings[key], fieldMap);
  }

  if (Number(remappedSettings.link_row_table_id) === sourceTableId) {
    remappedSettings.link_row_table_id = duplicatedTableId;
  }

  if (field.type === "single_select" && remappedSettings.single_select_default !== undefined && remappedSettings.single_select_default !== null) {
    remappedSettings.single_select_default = remapSelectOptionValue(remappedSettings.single_select_default, selectOptionMap)?.id ?? null;
  }

  if (field.type === "multiple_select" && Array.isArray(remappedSettings.multiple_select_default)) {
    remappedSettings.multiple_select_default = remappedSettings.multiple_select_default
      .map((item) => remapSelectOptionValue(item, selectOptionMap)?.id)
      .filter((id): id is number => typeof id === "number");
  }

  return remappedSettings;
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

export async function duplicateFieldDependencies(
  db: D1Database,
  sourceTableId: number,
  fieldMap: Map<number, number>
): Promise<void> {
  const dependencies = await db.prepare(
    `SELECT fd.id, fd.dependant_id, fd.dependency_id, fd.via_id, fd.broken_reference_field_name
     FROM database_fielddependency fd
     JOIN database_field dependant ON dependant.id = fd.dependant_id
     WHERE dependant.table_id = ?
     ORDER BY fd.id ASC`
  ).bind(sourceTableId).all<FieldDependencyRow>();

  const statements = (dependencies.results || []).flatMap((dependency) => {
    const duplicatedDependantId = fieldMap.get(Number(dependency.dependant_id));
    if (!duplicatedDependantId) return [];
    const duplicatedDependencyId = dependency.dependency_id === null || dependency.dependency_id === undefined
      ? null
      : fieldMap.get(Number(dependency.dependency_id)) ?? dependency.dependency_id;
    const duplicatedViaId = dependency.via_id === null || dependency.via_id === undefined
      ? null
      : fieldMap.get(Number(dependency.via_id)) ?? dependency.via_id;
    return [db.prepare(
      `INSERT INTO database_fielddependency
       (dependant_id, via_id, dependency_id, broken_reference_field_name)
       VALUES (?, ?, ?, ?)`
    ).bind(
      duplicatedDependantId,
      duplicatedViaId,
      duplicatedDependencyId,
      dependency.broken_reference_field_name ?? null
    )];
  });

  if (statements.length > 0) await db.batch(statements);
}

export async function duplicateDatabaseTable(
  db: D1Database,
  sourceTableId: number,
  options: { targetDatabaseId?: number | null; name?: string | null; order?: number | null } = {}
): Promise<DuplicateTableResult> {
  const source = await db.prepare("SELECT * FROM database_table WHERE id = ? AND trashed = 0")
    .bind(sourceTableId)
    .first<TableRow>();
  if (!source) throw new Error("Source table not found");
  const targetWorkspace = await db.prepare(
    "SELECT workspace_id FROM core_application WHERE id=? AND trashed=0"
  ).bind(options.targetDatabaseId || source.database_id).first<{ workspace_id: number }>();
  if (!targetWorkspace) throw new Error("Target database not found");

  const now = new Date().toISOString();
  const duplicated = await db.prepare(
    `INSERT INTO database_table (name, [order], database_id, version, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0) RETURNING *`
  ).bind(
    options.name || `${source.name} (copy)`,
    options.order ?? Number(source.order || 0) + 1,
    options.targetDatabaseId || source.database_id,
    now,
    now
  ).first<TableRow>();
  if (!duplicated) throw new Error("Failed to duplicate table");

  await getOrCreateUserTable(db, duplicated.id);

  const fields = await db.prepare(
    "SELECT * FROM database_field WHERE table_id = ? AND trashed = 0 ORDER BY [order] ASC"
  ).bind(source.id).all<FieldRow>();

  const fieldMap = new Map<number, number>();
  const selectOptionMap = new Map<number, SelectOptionValue>();
  for (const field of fields.results || []) {
    const newField = await db.prepare(
      `INSERT INTO database_field
       (table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
        immutable_type, immutable_properties, field_settings, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    ).bind(
      duplicated.id,
      field.name,
      field.type,
      field.order,
      field.primary ? 1 : 0,
      field.read_only ? 1 : 0,
      field.description,
      field.db_index ? 1 : 0,
      field.immutable_type ? 1 : 0,
      field.immutable_properties ? 1 : 0,
      field.field_settings,
      now,
      now
    ).first<{ id: number }>();
    if (newField) {
      fieldMap.set(field.id, newField.id);
      await addFieldColumn(db, duplicated.id, { id: newField.id, type: field.type, primary: Boolean(field.primary) });
      if (field.type === "single_select" || field.type === "multiple_select") {
        await duplicateSelectOptionsForTable(db, field.id, newField.id, selectOptionMap);
      }
    }
  }

  await duplicateFieldDependencies(db, source.id, fieldMap);

  for (const field of fields.results || []) {
    const duplicatedFieldId = fieldMap.get(field.id);
    if (!duplicatedFieldId) continue;
    let remappedSettings = remapDuplicatedTableFieldSettings(
      field,
      source.id,
      duplicated.id,
      fieldMap,
      selectOptionMap
    );
    if (field.type === "ai") {
      remappedSettings = await disableInvalidAIAutoUpdateUser(db, targetWorkspace.workspace_id, remappedSettings);
    }
    await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
      .bind(JSON.stringify(remappedSettings), duplicatedFieldId)
      .run();
  }

  await copyDuplicatedTableRows(
    db,
    source.id,
    duplicated.id,
    fields.results || [],
    fieldMap,
    selectOptionMap,
    now
  );

  const fieldRules = await db.prepare(
    "SELECT * FROM database_fieldrule WHERE table_id=? ORDER BY id ASC"
  ).bind(source.id).all<any>();
  for (const rule of fieldRules.results || []) {
    const settings = parseJsonObject(rule.settings);
    for (const key of ["start_date_field_id", "end_date_field_id", "duration_field_id", "dependency_linkrow_field_id"]) {
      const sourceFieldId = Number(settings[key] || 0);
      if (sourceFieldId) settings[key] = fieldMap.get(sourceFieldId) ?? null;
    }
    await db.prepare(
      `INSERT INTO database_fieldrule
       (table_id, type, is_active, is_valid, error_text, settings, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      duplicated.id,
      rule.type,
      rule.is_active ? 1 : 0,
      rule.is_valid ? 1 : 0,
      rule.error_text || null,
      JSON.stringify(settings),
      rule.created_on || now,
      now
    ).run();
  }
  if ((fieldRules.results || []).length > 0) {
    await revalidateDateDependencyRules(db, duplicated.id);
  }

  const sourceViews = await db.prepare(
    "SELECT * FROM database_view WHERE table_id=? AND trashed=0 ORDER BY [order] ASC, id ASC"
  ).bind(source.id).all<any>();
  if ((sourceViews.results || []).length === 0) {
    const viewSlug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await db.prepare(
      `INSERT INTO database_view (table_id, name, type, [order], filter_type, public,
       public_view_password, slug, trashed, created_on, updated_on,
       row_identifier_type, ownership_type, row_height_size, filters_disabled)
       VALUES (?,'Grid','grid',1,'AND',0,0,?,0,?,?,'count','collaborative','small',0)`
    ).bind(duplicated.id, viewSlug, now, now).run();
  } else {
    const numericSelectOptionMap = new Map([...selectOptionMap].map(([sourceOptionId, option]) => [sourceOptionId, option.id]));
    for (const view of sourceViews.results || []) {
      const duplicatedView = await db.prepare(
        `INSERT INTO database_view (table_id, name, type, [order], filter_type, filters_disabled, public, allow_public_export,
         public_view_password, slug, trashed, created_on, updated_on, row_identifier_type, ownership_type, owned_by_id, show_logo, row_height_size,
         card_cover_image_field, single_select_field, date_field, ical_public, ical_slug, start_date_field, end_date_field, timescale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      ).bind(
        duplicated.id,
        view.name,
        view.type,
        view.order,
        view.filter_type || "AND",
        view.filters_disabled || 0,
        view.public ? 1 : 0,
        view.allow_public_export ? 1 : 0,
        view.public_view_password || null,
        view.slug ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : null,
        now,
        now,
        view.row_identifier_type || "count",
        view.ownership_type || "collaborative",
        view.owned_by_id ?? null,
        view.show_logo === 0 ? 0 : 1,
        view.row_height_size || "small",
        remapId(view.card_cover_image_field, fieldMap) ?? null,
        remapId(view.single_select_field, fieldMap) ?? null,
        remapId(view.date_field, fieldMap) ?? null,
        view.ical_public ? 1 : 0,
        view.ical_slug ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : null,
        remapId(view.start_date_field, fieldMap) ?? null,
        remapId(view.end_date_field, fieldMap) ?? null,
        view.timescale || "month"
      ).first<{ id: number }>();
      if (duplicatedView) {
        await duplicateViewDependencies(db, view.id, duplicatedView.id, view.type, {
          fieldMap,
          selectOptionMap: numericSelectOptionMap,
        });
      }
    }
  }

  return {
    sourceTable: source,
    duplicatedTable: duplicated,
    original_table: await serializeDatabaseTable(db, source),
    duplicated_table: await serializeDatabaseTable(db, duplicated),
  };
}
