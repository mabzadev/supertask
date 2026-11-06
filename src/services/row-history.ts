import type { FieldMeta, FieldType } from "./dynamic-tables";
import { deserializeFieldValue } from "./dynamic-tables";
import type { RequestUser } from "../types/env";

export interface RowHistoryInput {
  user: RequestUser | null;
  tableId: number;
  rowId: number;
  actionType: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  fields: FieldMeta[];
  session?: string;
  actionGroup?: string | null;
  actionScope?: string | null;
  beforeRow?: Record<string, unknown> | null;
  afterRow?: Record<string, unknown> | null;
}

function normalizeHistoryValue(type: FieldType, value: unknown) {
  return deserializeFieldValue(type, value);
}

export function fieldMetadata(fields: FieldMeta[]) {
  const metadata: Record<string, { id: number; name: string; type: FieldType; primary: boolean }> = {};
  for (const field of fields) {
    metadata[`field_${field.id}`] = {
      id: field.id,
      name: field.name,
      type: field.type,
      primary: Boolean(field.primary),
    };
  }
  return metadata;
}

export function rowFieldValues(row: Record<string, unknown> | null | undefined, fields: FieldMeta[]) {
  const values: Record<string, unknown> = {};
  if (!row) return values;
  for (const field of fields) {
    const key = `field_${field.id}`;
    if (key in row) values[key] = normalizeHistoryValue(field.type, row[key]);
  }
  return values;
}

export function changedRowValues(
  beforeRow: Record<string, unknown> | null | undefined,
  afterRow: Record<string, unknown> | null | undefined,
  fields: FieldMeta[]
) {
  const beforeAll = rowFieldValues(beforeRow, fields);
  const afterAll = rowFieldValues(afterRow, fields);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of fields) {
    const key = `field_${field.id}`;
    const beforeValue = beforeAll[key] ?? null;
    const afterValue = afterAll[key] ?? null;
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      before[key] = beforeValue;
      after[key] = afterValue;
    }
  }
  return { before, after };
}

export function serializeRowHistoryEntry(entry: any, fields: FieldMeta[]) {
  const before = typeof entry.before_values === "string" ? JSON.parse(entry.before_values || "{}") : entry.before_values || {};
  const after = typeof entry.after_values === "string" ? JSON.parse(entry.after_values || "{}") : entry.after_values || {};
  return {
    id: entry.id,
    row_id: entry.row_id,
    table_id: entry.table_id,
    action_type: entry.action_type,
    action_command_type: entry.action_command_type || null,
    action_scope: entry.action_scope || null,
    timestamp: entry.action_timestamp,
    before,
    after,
    fields_metadata: fieldMetadata(fields),
    user: {
      id: entry.user_id,
      username: entry.user_name,
      email: entry.user_email || "",
      name: entry.user_name || entry.user_email || "Unknown user",
    },
  };
}

export async function createRowHistoryEntry(db: D1Database, input: RowHistoryInput) {
  const now = new Date().toISOString();
  const actionScope = input.actionScope || `table${input.tableId}`;
  const metadata = {
    before_row: input.beforeRow || null,
    after_row: input.afterRow || null,
  };
  const values = [
    input.user?.id ?? null,
    input.user?.username || input.user?.email || "",
    input.tableId,
    input.rowId,
    now,
    input.actionType,
    JSON.stringify(input.before),
    JSON.stringify(input.after),
  ];
  let row: any;
  try {
    row = await db.prepare(
      `INSERT INTO database_rowhistory
       (user_id, user_name, table_id, row_id, action_timestamp, action_type, before_values, after_values,
        action_command_type, session, action_group, action_scope, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DO', ?, ?, ?, ?) RETURNING *`
    ).bind(
      ...values,
      input.session || "",
      input.actionGroup || null,
      actionScope,
      JSON.stringify(metadata)
    ).first<any>();
  } catch (error: any) {
    if (!String(error?.message || error).includes("database_rowhistory")) throw error;
    row = await db.prepare(
      `INSERT INTO database_rowhistory
       (user_id, user_name, table_id, row_id, action_timestamp, action_type, before_values, after_values)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(...values).first<any>();
  }
  return serializeRowHistoryEntry({
    ...row,
    user_email: input.user?.email || "",
  }, input.fields);
}
