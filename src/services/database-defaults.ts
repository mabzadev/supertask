import type { D1Database } from "@cloudflare/workers-types";
import { addFieldColumn, getOrCreateUserTable } from "./dynamic-tables";

export async function createDefaultTableForDatabase(
  db: D1Database,
  databaseId: number,
  name = "Table 1"
): Promise<number> {
  const maxOrder = await db.prepare(
    `SELECT COALESCE(MAX([order]), 0) AS max_order FROM database_table WHERE database_id = ?`
  )
    .bind(databaseId)
    .first<{ max_order: number }>();

  const now = new Date().toISOString();
  const table = await db.prepare(
    `INSERT INTO database_table (name, [order], database_id, version, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0) RETURNING id`
  )
    .bind(name, (maxOrder?.max_order ?? 0) + 1, databaseId, now, now)
    .first<{ id: number }>();

  if (!table) throw new Error("Failed to create default table");

  const primaryField = await db.prepare(
    `INSERT INTO database_field (table_id, name, type, [order], "primary", read_only, trashed, created_on, updated_on, db_index)
     VALUES (?, 'Name', 'text', 1, 1, 0, 0, ?, ?, 0) RETURNING id`
  )
    .bind(table.id, now, now)
    .first<{ id: number }>();

  await getOrCreateUserTable(db, table.id);
  if (primaryField) {
    await addFieldColumn(db, table.id, { id: primaryField.id, type: "text", primary: true });
  }

  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const gridView = await db.prepare(
    `INSERT INTO database_view (table_id, name, type, [order], filter_type, public,
     public_view_password, slug, trashed, created_on, updated_on,
     row_identifier_type, ownership_type, row_height_size, filters_disabled)
     VALUES (?, 'Grid', 'grid', 1, 'AND', 0, NULL, ?, 0, ?, ?, 'count', 'collaborative', 'small', 0)
     RETURNING id`
  )
    .bind(table.id, slug, now, now)
    .first<{ id: number }>();

  if (gridView && primaryField) {
    await db.prepare(
      `INSERT OR IGNORE INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order])
       VALUES (?, ?, 200, 0, 32768)`
    )
      .bind(gridView.id, primaryField.id)
      .run();
  }

  return table.id;
}

export async function ensureDatabaseHasDefaultTable(db: D1Database, databaseId: number): Promise<void> {
  const existing = await db.prepare(
    "SELECT id FROM database_table WHERE database_id = ? AND trashed = 0 LIMIT 1"
  )
    .bind(databaseId)
    .first<{ id: number }>();

  if (!existing) {
    await createDefaultTableForDatabase(db, databaseId);
  }
}
