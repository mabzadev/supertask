import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { FieldMeta } from "./dynamic-tables";
import { chunkIds, ensureUserTableSystemColumns } from "./dynamic-tables";
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

function storedLinkItems(value: unknown): unknown[] {
  if (value === null || value === undefined || value === "") return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => storedLinkItemId(item) !== null);
}

function storedLinkItemId(item: unknown): number | null {
  const id = typeof item === "number" || typeof item === "string"
    ? Number(item)
    : item && typeof item === "object" ? Number((item as Record<string, unknown>).id) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
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

type Row = Record<string, unknown>;

export interface LinkRowChange {
  rowId: number;
  before: Row | null;
  after: Row | null;
  /** Fields written by the change; `null` means every link field may have changed. */
  changedFieldIds: Set<number> | null;
}

/** Stored item for a source row, from its own primary value (what `linkRowById` would read). */
function sourceLinkItem(change: LinkRowChange, primaryFieldId: number | null): unknown {
  if (!change.after) return change.rowId;
  if (primaryFieldId === null) return { id: change.rowId, value: String(change.rowId) };
  return { id: change.rowId, value: String(change.after[`field_${primaryFieldId}`] ?? "") };
}

/**
 * Applies every add/remove/refresh to the reciprocal cells of one link field:
 * one read per 90 target rows and one atomic batch of updates, whatever the
 * number of source rows. `edits` maps target row -> source row -> new item
 * (`null` removes the source).
 */
async function applyReciprocalEdits(
  db: D1Database,
  reciprocal: LinkFieldRow,
  edits: Map<number, Map<number, unknown | null>>
): Promise<void> {
  const targetIds = [...edits.keys()];
  if (targetIds.length === 0) return;
  await ensureUserTableSystemColumns(db, reciprocal.table_id);
  const current = new Map<number, unknown>();
  for (const chunk of chunkIds(targetIds)) {
    const rows = await db.prepare(
      `SELECT id, "field_${reciprocal.id}" AS value
       FROM "database_table_${reciprocal.table_id}"
       WHERE COALESCE(trashed, 0)=0 AND id IN (${chunk.map(() => "?").join(",")})`
    ).bind(...chunk).all<{ id: number; value: unknown }>();
    for (const row of rows.results || []) current.set(Number(row.id), row.value);
  }

  const meta = fieldMeta(reciprocal);
  const statements: D1PreparedStatement[] = [];
  for (const [targetRowId, sourceEdits] of edits) {
    if (!current.has(targetRowId)) continue;
    const items = storedLinkItems(current.get(targetRowId));
    let changed = false;
    for (const [sourceRowId, item] of sourceEdits) {
      const position = items.findIndex((existing) => storedLinkItemId(existing) === sourceRowId);
      if (item === null && position < 0) continue;
      changed = true;
      const others = items.filter((existing) => storedLinkItemId(existing) !== sourceRowId);
      if (item !== null) others.splice(position < 0 ? others.length : position, 0, item);
      items.splice(0, items.length, ...others);
    }
    if (!changed) continue;
    // Other links keep their stored items (reads resolve names live), so
    // serialising does not query once per existing link.
    const serialized = await serializeFieldValueForStorage(db, meta, items);
    statements.push(db.prepare(
      `UPDATE "database_table_${reciprocal.table_id}"
       SET "field_${reciprocal.id}"=?
       WHERE id=? AND COALESCE(trashed, 0)=0`
    ).bind(serialized, targetRowId));
  }
  if (statements.length > 0) await db.batch(statements);
}

/** Keeps the related link field of other tables in sync with these row changes. */
export async function synchronizeLinkRowRelationsBatch(
  db: D1Database,
  tableId: number,
  changes: LinkRowChange[]
): Promise<void> {
  if (changes.length === 0) return;
  const [fields, primaryFieldId] = await Promise.all([
    activeLinkFields(db, tableId),
    activePrimaryFieldId(db, tableId),
  ]);

  for (const field of fields) {
    const edits = new Map<number, Map<number, unknown | null>>();
    for (const change of changes) {
      const primaryChanged = primaryFieldId !== null && change.changedFieldIds?.has(primaryFieldId) === true;
      if (change.changedFieldIds && !change.changedFieldIds.has(field.id) && !primaryChanged) continue;
      const beforeIds = linkedRowIds(change.before?.[`field_${field.id}`]);
      const afterIds = linkedRowIds(change.after?.[`field_${field.id}`]);
      const removed = [...beforeIds].filter((id) => !afterIds.has(id));
      const addedOrRefreshed = [...afterIds].filter((id) => !beforeIds.has(id) || primaryChanged);
      if (removed.length === 0 && addedOrRefreshed.length === 0) continue;
      const item = sourceLinkItem(change, primaryFieldId);
      for (const targetRowId of removed) {
        if (!edits.has(targetRowId)) edits.set(targetRowId, new Map());
        edits.get(targetRowId)!.set(change.rowId, null);
      }
      for (const targetRowId of addedOrRefreshed) {
        if (!edits.has(targetRowId)) edits.set(targetRowId, new Map());
        edits.get(targetRowId)!.set(change.rowId, item);
      }
    }
    if (edits.size === 0) continue;
    const reciprocal = await reciprocalField(db, field);
    if (!reciprocal) continue;
    await applyReciprocalEdits(db, reciprocal, edits);
  }
}

export async function synchronizeLinkRowRelations(
  db: D1Database,
  tableId: number,
  rowId: number,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  changedFieldIds: Set<number> | null = null
): Promise<void> {
  await synchronizeLinkRowRelationsBatch(db, tableId, [{ rowId, before, after, changedFieldIds }]);
}
