export async function buildRowMetadata(
  db: D1Database,
  tableId: number,
  rowIds: number[],
  userId?: number | null
): Promise<Record<string, Record<string, unknown>>> {
  const ids = Array.from(new Set(rowIds.filter((id) => Number.isInteger(id) && id > 0)));
  const metadata: Record<string, Record<string, unknown>> = {};
  if (ids.length === 0) return metadata;

  const bindMarks = ids.map(() => "?").join(",");
  try {
    const counts = await db.prepare(
      `SELECT row_id, COUNT(*) AS count
       FROM database_rowcomment
       WHERE table_id=? AND trashed=0 AND row_id IN (${bindMarks})
       GROUP BY row_id`
    ).bind(tableId, ...ids).all<{ row_id: number; count: number }>();
    for (const row of counts.results || []) {
      const key = String(row.row_id);
      metadata[key] = { ...(metadata[key] || {}), row_comment_count: row.count };
    }
  } catch (error: any) {
    if (!String(error?.message || "").includes("database_rowcomment")) throw error;
    return metadata;
  }

  if (userId) {
    try {
      const modes = await db.prepare(
        `SELECT row_id, mode
         FROM database_rowcommentsnotificationmode
         WHERE table_id=? AND user_id=? AND mode!='mentions' AND row_id IN (${bindMarks})`
      ).bind(tableId, userId, ...ids).all<{ row_id: number; mode: string }>();
      for (const row of modes.results || []) {
        const key = String(row.row_id);
        metadata[key] = { ...(metadata[key] || {}), row_comments_notification_mode: row.mode };
      }
    } catch (error: any) {
      if (!String(error?.message || "").includes("database_rowcommentsnotificationmode")) throw error;
    }
  }

  return metadata;
}
