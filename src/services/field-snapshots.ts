import type { FieldType } from "./dynamic-tables";
import { addFieldColumn, ensureUserTableSystemColumns } from "./dynamic-tables";
import { serializeDatabaseFieldRow } from "./field-serialization";

type SnapshotRecord = Record<string, unknown>;

const CHILD_TABLES = [
  "database_formviewfieldoptions_allowedselectoptions",
  "database_formviewfieldoptionscondition",
  "database_formviewfieldoptionsconditiongroup",
];

async function rows<T extends SnapshotRecord>(
  db: D1Database,
  sql: string,
  bindings: unknown[] = []
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...bindings).all<T>();
  return result.results || [];
}

async function optionalRows<T extends SnapshotRecord>(
  db: D1Database,
  sql: string,
  bindings: unknown[] = []
): Promise<T[]> {
  try {
    return await rows<T>(db, sql, bindings);
  } catch (error: any) {
    const message = String(error?.message || error);
    if (message.includes("no such table") || message.includes("no such column")) return [];
    throw error;
  }
}

function recordColumns(record: SnapshotRecord) {
  return Object.keys(record);
}

async function insertRecord(
  db: D1Database,
  table: string,
  record: SnapshotRecord
) {
  const columns = recordColumns(record);
  if (columns.length === 0) return;
  const bindMarks = columns.map(() => "?").join(", ");
  await db.prepare(
    `INSERT OR IGNORE INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${bindMarks})`
  ).bind(...columns.map((column) => record[column])).run();
}

async function upsertRecord(
  db: D1Database,
  table: string,
  idColumn: string,
  record: SnapshotRecord
) {
  await insertRecord(db, table, record);
  const columns = recordColumns(record).filter((column) => column !== idColumn);
  if (columns.length === 0) return;
  await db.prepare(
    `UPDATE ${table} SET ${columns.map((column) => `"${column}"=?`).join(", ")} WHERE "${idColumn}"=?`
  ).bind(...columns.map((column) => record[column]), record[idColumn]).run();
}

async function fieldCellValues(db: D1Database, tableId: number, fieldId: number) {
  await ensureUserTableSystemColumns(db, tableId);
  return optionalRows(
    db,
    `SELECT id, "field_${fieldId}" AS value
     FROM "database_table_${tableId}"
     WHERE COALESCE(trashed, 0)=0
     ORDER BY id ASC`
  );
}

async function formOptionIds(db: D1Database, fieldId: number) {
  const options = await rows<{ id: number }>(
    db,
    "SELECT id FROM database_formviewfieldoptions WHERE field_id=? ORDER BY id ASC",
    [fieldId]
  );
  return options.map((option) => option.id);
}

function inClause(values: unknown[]) {
  return values.map(() => "?").join(",");
}

async function formChildRows(db: D1Database, fieldId: number) {
  const optionIds = await formOptionIds(db, fieldId);
  if (optionIds.length === 0) {
    return {
      form_allowed_select_options: [],
      form_condition_groups: [],
      form_conditions: [],
    };
  }
  const optionMarks = inClause(optionIds);
  const groups = await optionalRows(
    db,
    `SELECT *
     FROM database_formviewfieldoptionsconditiongroup
     WHERE field_option_id IN (${optionMarks})
     ORDER BY id ASC`,
    optionIds
  );
  const groupIds = groups.map((group) => Number(group.id)).filter((id) => Number.isFinite(id));
  return {
    form_allowed_select_options: await optionalRows(
      db,
      `SELECT *
       FROM database_formviewfieldoptions_allowedselectoptions
       WHERE form_view_field_options_id IN (${optionMarks})
       ORDER BY id ASC`,
      optionIds
    ),
    form_condition_groups: groups,
    form_conditions: await optionalRows(
      db,
      groupIds.length > 0
        ? `SELECT *
           FROM database_formviewfieldoptionscondition
           WHERE field_option_id IN (${optionMarks}) OR group_id IN (${inClause(groupIds)})
           ORDER BY id ASC`
        : `SELECT *
           FROM database_formviewfieldoptionscondition
           WHERE field_option_id IN (${optionMarks})
           ORDER BY id ASC`,
      groupIds.length > 0 ? [...optionIds, ...groupIds] : optionIds
    ),
  };
}

// Cell values are skipped beyond this size: core_action rows are limited to
// 2 MB by D1, and the undo of a huge conversion is not worth failing the edit.
const MAX_SNAPSHOT_CELLS_JSON = 900_000;

/** The field, its related link field and the fields that depend on it. */
async function relatedFieldRows(db: D1Database, field: SnapshotRecord, extraFieldIds: number[]) {
  const settings = parseSnapshotSettings(field.field_settings);
  const ids = new Set<number>([Number(field.id), ...extraFieldIds]);
  const relatedId = Number(settings.link_row_related_field_id || 0);
  if (relatedId) ids.add(relatedId);
  const dependants = await rows<{ dependant_id: number }>(
    db,
    "SELECT dependant_id FROM database_fielddependency WHERE dependency_id=?",
    [Number(field.id)]
  );
  for (const dependant of dependants) ids.add(Number(dependant.dependant_id));
  const list = [...ids].filter((id) => Number.isInteger(id) && id > 0);
  const result: SnapshotRecord[] = [];
  for (let offset = 0; offset < list.length; offset += 90) {
    const chunk = list.slice(offset, offset + 90);
    result.push(...await rows(db, `SELECT * FROM database_field WHERE id IN (${chunk.map(() => "?").join(",")}) ORDER BY id ASC`, chunk));
  }
  return result;
}

function parseSnapshotSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Undo/redo snapshot of one field. It only covers the field, its related link
 * field and its dependants (restoring every field of the database reverted
 * other people's changes), and only holds cell values when `includeCells` is
 * set, i.e. for edits that convert data: a rename must not rewrite cells.
 */
export async function snapshotFieldForUndoRedo(
  db: D1Database,
  fieldId: number,
  options: { includeCells?: boolean; extraFieldIds?: number[] } = {}
) {
  const field = await db.prepare("SELECT * FROM database_field WHERE id=?")
    .bind(fieldId)
    .first<SnapshotRecord>();
  if (!field) return null;
  const tableId = Number(field.table_id);
  const [children, databaseFields, selectOptions, gridOptions, galleryOptions, formOptions, cells] = await Promise.all([
    formChildRows(db, fieldId),
    relatedFieldRows(db, field, options.extraFieldIds || []),
    rows(db, "SELECT * FROM database_selectoption WHERE field_id=? ORDER BY [order] ASC, id ASC", [fieldId]),
    rows(db, "SELECT * FROM database_gridviewfieldoptions WHERE field_id=? ORDER BY [order] ASC, id ASC", [fieldId]),
    rows(db, "SELECT * FROM database_galleryviewfieldoptions WHERE field_id=? ORDER BY [order] ASC, id ASC", [fieldId]),
    rows(db, "SELECT * FROM database_formviewfieldoptions WHERE field_id=? ORDER BY [order] ASC, id ASC", [fieldId]),
    options.includeCells ? fieldCellValues(db, tableId, fieldId) : Promise.resolve(null),
  ]);
  const keepCells = cells !== null && JSON.stringify(cells).length <= MAX_SNAPSHOT_CELLS_JSON;
  return {
    field,
    database_fields: databaseFields,
    select_options: selectOptions,
    grid_view_field_options: gridOptions,
    gallery_view_field_options: galleryOptions,
    form_view_field_options: formOptions,
    ...children,
    ...(keepCells ? { data_values: cells } : {}),
  };
}

/** Ids of the fields a snapshot covers, so the matching after-snapshot covers them too. */
export function snapshotFieldIds(snapshot: { database_fields?: SnapshotRecord[] } | null): number[] {
  return (snapshot?.database_fields || []).map((field) => Number(field.id)).filter((id) => Number.isInteger(id) && id > 0);
}

function snapshotArray(snapshot: SnapshotRecord, key: string): SnapshotRecord[] {
  const value = snapshot[key];
  return Array.isArray(value)
    ? value.filter((item): item is SnapshotRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

async function deleteCurrentFormChildren(db: D1Database, fieldId: number) {
  const optionIds = await formOptionIds(db, fieldId);
  if (optionIds.length === 0) return;
  const optionMarks = inClause(optionIds);
  for (const table of CHILD_TABLES) {
    const foreignKey = table === "database_formviewfieldoptionsconditiongroup"
      ? "field_option_id"
      : table === "database_formviewfieldoptionscondition"
        ? "field_option_id"
        : "form_view_field_options_id";
    await db.prepare(`DELETE FROM ${table} WHERE ${foreignKey} IN (${optionMarks})`)
      .bind(...optionIds)
      .run();
  }
}

async function restoreFieldMetadata(db: D1Database, snapshot: SnapshotRecord) {
  const fields = snapshotArray(snapshot, "database_fields");
  if (fields.length === 0 && snapshot.field && typeof snapshot.field === "object" && !Array.isArray(snapshot.field)) {
    fields.push(snapshot.field as SnapshotRecord);
  }
  for (const field of fields) {
    await upsertRecord(db, "database_field", "id", field);
  }
}

async function restoreFieldArtifacts(db: D1Database, snapshot: SnapshotRecord, field: SnapshotRecord) {
  const fieldId = Number(field.id);
  const tableId = Number(field.table_id);
  await addFieldColumn(db, tableId, { id: fieldId, type: String(field.type) as FieldType });
  await ensureUserTableSystemColumns(db, tableId);

  await deleteCurrentFormChildren(db, fieldId);
  await db.prepare("DELETE FROM database_selectoption WHERE field_id=?").bind(fieldId).run();
  await db.prepare("DELETE FROM database_gridviewfieldoptions WHERE field_id=?").bind(fieldId).run();
  await db.prepare("DELETE FROM database_galleryviewfieldoptions WHERE field_id=?").bind(fieldId).run();
  await db.prepare("DELETE FROM database_formviewfieldoptions WHERE field_id=?").bind(fieldId).run();

  for (const option of snapshotArray(snapshot, "select_options")) {
    await insertRecord(db, "database_selectoption", option);
  }
  for (const option of snapshotArray(snapshot, "grid_view_field_options")) {
    await insertRecord(db, "database_gridviewfieldoptions", option);
  }
  for (const option of snapshotArray(snapshot, "gallery_view_field_options")) {
    await insertRecord(db, "database_galleryviewfieldoptions", option);
  }
  for (const option of snapshotArray(snapshot, "form_view_field_options")) {
    await insertRecord(db, "database_formviewfieldoptions", option);
  }
  for (const option of snapshotArray(snapshot, "form_allowed_select_options")) {
    await insertRecord(db, "database_formviewfieldoptions_allowedselectoptions", option);
  }
  for (const group of snapshotArray(snapshot, "form_condition_groups")) {
    await insertRecord(db, "database_formviewfieldoptionsconditiongroup", group);
  }
  for (const condition of snapshotArray(snapshot, "form_conditions")) {
    await insertRecord(db, "database_formviewfieldoptionscondition", condition);
  }

  for (const cell of snapshotArray(snapshot, "data_values")) {
    await db.prepare(`UPDATE "database_table_${tableId}" SET "field_${fieldId}"=? WHERE id=? AND COALESCE(trashed, 0)=0`)
      .bind(cell.value ?? null, cell.id)
      .run();
  }
}

export async function restoreFieldStateForUndoRedo(db: D1Database, snapshot: SnapshotRecord) {
  const field = snapshot.field;
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error("Field snapshot is missing.");
  }
  await restoreFieldMetadata(db, snapshot);
  await restoreFieldArtifacts(db, snapshot, field as SnapshotRecord);
}

export async function serializeFieldForUndoRedo(db: D1Database, fieldId: number) {
  const field = await db.prepare("SELECT * FROM database_field WHERE id=?")
    .bind(fieldId)
    .first<any>();
  return field ? serializeDatabaseFieldRow(db, field) : null;
}

export async function serializeRelatedFieldsForUndoRedo(
  db: D1Database,
  snapshot: SnapshotRecord,
  fieldId: number
) {
  const fields = snapshotArray(snapshot, "database_fields")
    .filter((field) => Number(field.id) !== fieldId);
  return Promise.all(fields.map((field) => serializeDatabaseFieldRow(db, field as any)));
}
