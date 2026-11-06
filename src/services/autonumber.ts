import type { D1Database } from "@cloudflare/workers-types";
import { ensureUserTableSystemColumns, serializeFieldValueForInsert } from "./dynamic-tables";
import { numericStorageSqlExpression } from "./number-format";
import { orderedRowIdsForAutonumber } from "./view-query";

interface AutonumberFieldRow {
  id: number;
}

function assertIdentifier(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${label}.`);
  return value;
}

async function autonumberFields(db: D1Database, tableId: number): Promise<AutonumberFieldRow[]> {
  const result = await db.prepare(
    `SELECT id
     FROM database_field
     WHERE table_id=? AND type IN ('autonumber', 'auto_number')
     ORDER BY id ASC`
  ).bind(tableId).all<AutonumberFieldRow>();
  return result.results || [];
}

export async function initializeAutonumberField(
  db: D1Database,
  tableIdInput: number,
  fieldIdInput: number,
  viewId?: number | null
): Promise<number> {
  const tableId = assertIdentifier(tableIdInput, "table id");
  const fieldId = assertIdentifier(fieldIdInput, "field id");
  await ensureUserTableSystemColumns(db, tableId);
  const rowIds = await orderedRowIdsForAutonumber(db, tableId, viewId);

  for (let index = 0; index < rowIds.length; index += 50) {
    const statements = rowIds.slice(index, index + 50).map((rowId, offset) =>
      db.prepare(`UPDATE "database_table_${tableId}" SET "field_${fieldId}"=? WHERE id=?`)
        .bind(serializeFieldValueForInsert("autonumber", index + offset + 1), rowId)
    );
    if (statements.length > 0) await db.batch(statements);
  }

  await db.prepare(
    `INSERT INTO database_autonumbersequence (field_id, next_value)
     VALUES (?, ?)
     ON CONFLICT(field_id) DO UPDATE SET next_value=excluded.next_value`
  ).bind(fieldId, rowIds.length + 1).run();
  return rowIds.length;
}

export async function allocateAutonumberValues(
  db: D1Database,
  tableIdInput: number
): Promise<Map<number, number>> {
  const ranges = await allocateAutonumberRanges(db, tableIdInput, 1);
  return new Map([...ranges].map(([fieldId, values]) => [fieldId, values[0]]));
}

/**
 * Reserves `count` consecutive values per autonumber field of the table with
 * one atomic UPDATE per field, so a batch of rows costs the same as one row.
 */
export async function allocateAutonumberRanges(
  db: D1Database,
  tableIdInput: number,
  count: number
): Promise<Map<number, number[]>> {
  const tableId = assertIdentifier(tableIdInput, "table id");
  const size = assertIdentifier(count, "row count");
  await ensureUserTableSystemColumns(db, tableId);
  const fields = await autonumberFields(db, tableId);
  const allocated = new Map<number, number[]>();

  for (const field of fields) {
    const fieldId = assertIdentifier(Number(field.id), "field id");
    const numericColumn = numericStorageSqlExpression(`"field_${fieldId}"`);
    await db.prepare(
      `INSERT OR IGNORE INTO database_autonumbersequence (field_id, next_value)
       SELECT ?, CAST(COALESCE(MAX(${numericColumn}), 0) AS INTEGER) + 1
       FROM "database_table_${tableId}"`
    ).bind(fieldId).run();
    const sequence = await db.prepare(
      `UPDATE database_autonumbersequence
       SET next_value=next_value + ?
       WHERE field_id=?
       RETURNING next_value - ? AS value`
    ).bind(size, fieldId, size).first<{ value: number }>();
    if (!sequence) throw new Error(`Failed to allocate autonumber value for field ${fieldId}.`);
    const first = Number(sequence.value);
    allocated.set(fieldId, Array.from({ length: size }, (_, index) => first + index));
  }

  return allocated;
}
