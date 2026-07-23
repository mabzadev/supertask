import { serializeDataSyncById } from "./data-sync";
import type { FieldType } from "./dynamic-tables";
import { serializeDatabaseFieldRow } from "./field-serialization";

interface TableRow {
  id: number;
  name: string;
  order: number;
  database_id: number;
  data_sync_id?: number | null;
}

interface FieldRow {
  id: number;
  table_id: number;
  name: string;
  type: FieldType;
  order: number;
  primary?: boolean | number;
  is_primary?: boolean | number;
  read_only?: boolean | number;
  description?: string | null;
  field_description?: string | null;
  db_index?: boolean | number;
  immutable_type?: boolean | number;
  immutable_properties?: boolean | number;
  field_settings?: string | null;
}

export function serializeDatabaseView(view: any): object {
  return {
    id: view.id,
    table_id: view.table_id,
    name: view.name,
    type: view.type,
    order: view.order,
    filter_type: view.filter_type || "AND",
    filters_disabled: Boolean(view.filters_disabled),
    public: Boolean(view.public),
    public_view_password: Boolean(view.public_view_password),
    allow_public_export: Boolean(view.allow_public_export),
    slug: view.slug,
    row_identifier_type: view.row_identifier_type || "count",
    ownership_type: view.ownership_type || "collaborative",
    row_height_size: view.row_height_size || "small",
    created_on: view.created_on,
    updated_on: view.updated_on,
    filters: [],
    filter_groups: [],
    sortings: [],
    group_bys: [],
    decorations: [],
  };
}

export async function serializeDatabaseField(db: D1Database, field: FieldRow): Promise<object> {
  return serializeDatabaseFieldRow(db, field);
}

export async function serializeDatabaseTable(db: D1Database, table: TableRow): Promise<object> {
  const [views, fields] = await Promise.all([
    db.prepare(
      `SELECT * FROM database_view
       WHERE table_id = ? AND trashed = 0
       ORDER BY [order] ASC, id ASC`
    ).bind(table.id).all<any>(),
    db.prepare(
      `SELECT id, table_id, name, type, [order], "primary" as is_primary, read_only,
              description, db_index, immutable_type, immutable_properties, field_settings
       FROM database_field
       WHERE table_id = ? AND trashed = 0
       ORDER BY [order] ASC, id ASC`
    ).bind(table.id).all<FieldRow>(),
  ]);

  return {
    id: table.id,
    name: table.name,
    order: table.order,
    database_id: table.database_id,
    _generatedTableName: `database_table_${table.id}`,
    data_sync: table.data_sync_id ? await serializeDataSyncById(db, table.data_sync_id) : null,
    views: (views.results || []).map(serializeDatabaseView),
    fields: await Promise.all((fields.results || []).map((field) => serializeDatabaseField(db, field))),
  };
}
