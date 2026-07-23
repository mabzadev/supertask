import type { D1Database } from "@cloudflare/workers-types";
import type { FieldMeta } from "./dynamic-tables";
import { ensureUserTableSystemColumns } from "./dynamic-tables";
import { parseFieldSettings } from "./computed-fields";
import { serializeFieldValueForStorage } from "./field-values";

type LinkFieldRow = {
  id: number;
  table_id: number;
  name: string;
  field_settings: string | null;
};

function linkedRowIds(value: unknown): Set<number> {
  if (value === null || value === undefined || value === "") return new Set();
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [];
    }
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return new Set(values.map((item) => {
    if (typeof item === "number") return item;
    if (typeof item === "string") return Number(item);
    if (item && typeof item === "object") return Number((item as Record<string, unknown>).id);
    return NaN;
  }).filter((id) => Number.isInteger(id) && id > 0));
}

function fieldMeta(field: LinkFieldRow): FieldMeta {
  return {
    id: field.id,
    name: field.name,
    type: "link_row",
    primary: false,
    settings: parseFieldSettings(field.field_settings),
  };
}

async function activeLinkFields(db: D1Database, tableId: number): Promise<LinkFieldRow[]> {
  const result = await db.prepare(
    `SELECT id, table_id, name, field_settings
     FROM database_field
     WHERE table_id=? AND type='link_row' AND trashed=0
     ORDER BY [order] ASC, id ASC`
  ).bind(tableId).all<LinkFieldRow>();
  return result.results || [];
}

async function activePrimaryFieldId(db: D1Database, tableId: number): Promise<number | null> {
  const field = await db.prepare(
    `SELECT id
     FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY "primary" DESC, [order] ASC, id ASC
     LIMIT 1`
  ).bind(tableId).first<{ id: number }>();
  return field?.id || null;
}

async function reciprocalField(
  db: D1Database,
  field: LinkFieldRow
): Promise<LinkFieldRow | null> {
  const settings = parseFieldSettings(field.field_settings);
  const relatedFieldId = Number(settings.link_row_related_field_id || 0);
  const targetTableId = Number(settings.link_row_table_id || 0);
  if (!relatedFieldId || !targetTableId || targetTableId === field.table_id) return null;
  return db.prepare(
    `SELECT id, table_id, name, field_settings
     FROM database_field
     WHERE id=? AND table_id=? AND type='link_row' AND trashed=0`
  ).bind(relatedFieldId, targetTableId).first<LinkFieldRow>();
}

async function updateReciprocalCell(
  db: D1Database,
  reciprocal: LinkFieldRow,
  targetRowId: number,
  sourceRowId: number,
  includeSource: boolean
): Promise<void> {
  await ensureUserTableSystemColumns(db, reciprocal.table_id);
  const row = await db.prepare(
    `SELECT "field_${reciprocal.id}" AS value
     FROM "database_table_${reciprocal.table_id}"
     WHERE id=? AND COALESCE(trashed, 0)=0`
  ).bind(targetRowId).first<{ value: unknown }>();
  if (!row) return;

  const ids = linkedRowIds(row.value);
  if (includeSource) ids.add(sourceRowId);
  else ids.delete(sourceRowId);
  const serialized = await serializeFieldValueForStorage(db, fieldMeta(reciprocal), [...ids]);
  await db.prepare(
    `UPDATE "database_table_${reciprocal.table_id}"
     SET "field_${reciprocal.id}"=?
     WHERE id=? AND COALESCE(trashed, 0)=0`
  ).bind(serialized, targetRowId).run();
}

export async function synchronizeLinkRowRelations(
  db: D1Database,
  tableId: number,
  rowId: number,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  changedFieldIds: Set<number> | null = null
): Promise<void> {
  const fields = await activeLinkFields(db, tableId);
  const primaryFieldId = await activePrimaryFieldId(db, tableId);
  const primaryChanged = primaryFieldId !== null && changedFieldIds?.has(primaryFieldId) === true;

  for (const field of fields) {
    if (changedFieldIds && !changedFieldIds.has(field.id) && !primaryChanged) continue;
    const reciprocal = await reciprocalField(db, field);
    if (!reciprocal) continue;

    const beforeIds = linkedRowIds(before?.[`field_${field.id}`]);
    const afterIds = linkedRowIds(after?.[`field_${field.id}`]);
    const removed = [...beforeIds].filter((id) => !afterIds.has(id));
    const addedOrRefreshed = [...afterIds].filter((id) => !beforeIds.has(id) || primaryChanged);

    for (const targetRowId of removed) {
      await updateReciprocalCell(db, reciprocal, targetRowId, rowId, false);
    }
    for (const targetRowId of addedOrRefreshed) {
      await updateReciprocalCell(db, reciprocal, targetRowId, rowId, true);
    }
  }
}
