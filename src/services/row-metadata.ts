import { chunkIds } from "./dynamic-tables";

/**
 * Rows read by `reads`, or null when `table` doesn't exist yet (databases
 * migrated before row comments).
 */
async function rowsUnlessTableMissing<T>(table: string, reads: () => Array<Promise<D1Result<T>>>): Promise<T[] | null> {
  try {
    return (await Promise.all(reads())).flatMap((result) => result.results || []);
  } catch (error: any) {
    if (!String(error?.message || "").includes(table)) throw error;
    return null;
  }
}

export async function buildRowMetadata(
  db: D1Database,
  tableId: number,
  rowIds: number[],
  userId?: number | null
): Promise<Record<string, Record<string, unknown>>> {
  const ids = Array.from(new Set(rowIds.filter((id) => Number.isInteger(id) && id > 0)));
  const metadata: Record<string, Record<string, unknown>> = {};
  if (ids.length === 0) return metadata;

  // Chunked to stay under D1's 100 bound parameters; both reads run at once.
  const chunks = chunkIds(ids);
  const marks = (chunk: number[]) => chunk.map(() => "?").join(",");
  const [counts, modes] = await Promise.all([
    rowsUnlessTableMissing("database_rowcomment", () => chunks.map((chunk) => db.prepare(
      `SELECT row_id, COUNT(*) AS count
       FROM database_rowcomment
       WHERE table_id=? AND trashed=0 AND row_id IN (${marks(chunk)})
       GROUP BY row_id`
    ).bind(tableId, ...chunk).all<{ row_id: number; count: number }>())),
    userId
      ? rowsUnlessTableMissing("database_rowcommentsnotificationmode", () => chunks.map((chunk) => db.prepare(
        `SELECT row_id, mode
         FROM database_rowcommentsnotificationmode
         WHERE table_id=? AND user_id=? AND mode!='mentions' AND row_id IN (${marks(chunk)})`
      ).bind(tableId, userId, ...chunk).all<{ row_id: number; mode: string }>()))
      : null,
  ]);
  if (counts === null) return metadata;

  const set = (rowId: number, key: string, value: unknown) => {
    metadata[String(rowId)] = { ...(metadata[String(rowId)] || {}), [key]: value };
  };
  for (const row of counts) set(row.row_id, "row_comment_count", row.count);
  for (const row of modes || []) set(row.row_id, "row_comments_notification_mode", row.mode);
  return metadata;
}
