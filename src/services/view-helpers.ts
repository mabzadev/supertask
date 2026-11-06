import type { D1Database } from "@cloudflare/workers-types";
import type { FieldMeta, FieldType } from "./dynamic-tables";
import {
  computeLocalFieldValue,
  formulaFromSettings,
  normalizeFieldValue,
  parseFieldSettings,
  serializeRowWithComputedFields,
  serializeRowsWithComputedFields,
} from "./computed-fields";

// ── Get active fields for a table ─────────────────────────────────────────────
export async function getActiveFields(db: D1Database, tableId: number): Promise<FieldMeta[]> {
  const res = await db
    .prepare(
      `SELECT id, name, type, "primary" as is_primary, read_only, field_settings FROM database_field
       WHERE table_id=? AND trashed=0 ORDER BY [order] ASC`
    )
    .bind(tableId)
    .all<any>();
  return (res.results || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    primary: Boolean(f.is_primary),
    readOnly: Boolean(f.read_only),
    settings: parseFieldSettings(f.field_settings),
    formula: formulaFromSettings(parseFieldSettings(f.field_settings)),
  }));
}

export async function serializeRowForViewWithComputed(
  db: D1Database,
  row: Record<string, unknown>,
  fields: FieldMeta[],
  useFieldNames = false
): Promise<Record<string, unknown>> {
  return serializeRowWithComputedFields(db, row, fields, useFieldNames);
}

export function serializeRowsForViewWithComputed(
  db: D1Database,
  rows: Record<string, unknown>[],
  fields: FieldMeta[],
  useFieldNames = false
): Promise<Record<string, unknown>[]> {
  return serializeRowsWithComputedFields(db, rows, fields, useFieldNames);
}

// ── Serialize a DB row to API format with optional field name mapping ──────────
export function serializeRowForView(
  row: Record<string, unknown>,
  fields: FieldMeta[],
  useFieldNames = false
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: row.id,
    order: row["[order]"] ?? row.order ?? 10000,
  };
  for (const field of fields) {
    const colName = `field_${field.id}`;
    const key = useFieldNames ? field.name : colName;
    result[key] = normalizeViewFieldValue(field.type, computeLocalFieldValue(row, fields, field));
  }

  return result;
}

function normalizeViewFieldValue(type: FieldType, value: unknown): unknown {
  return normalizeFieldValue(type, value);
}
