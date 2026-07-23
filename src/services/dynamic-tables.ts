import type { D1Database } from "@cloudflare/workers-types";
import { evaluateFormula } from "./formula-engine";
import { encodeNumericStorageValue, formatNumberForApi, numericStorageValue } from "./number-format";

// ── Dynamic user table management ────────────────────────────────────────────
// Each Baserow table becomes a real D1 table named `database_table_<id>`
// Fields become columns with names `field_<id>`

export type FieldType =
  | "text" | "long_text" | "url" | "email" | "phone_number"
  | "number" | "rating" | "boolean" | "date" | "duration"
  | "last_modified" | "created_on" | "last_modified_by" | "created_by"
  | "link_row" | "file" | "single_select" | "multiple_select"
  | "multiple_collaborators" | "formula" | "count" | "lookup" | "rollup"
  | "uuid" | "autonumber" | "password" | "ai"
  | "auto_number";

export interface FieldDefinition {
  id: number;
  type: FieldType;
  primary?: boolean;
}

// ── SQLite column type mapping ────────────────────────────────────────────────
export function getSQLiteColumnType(fieldType: FieldType): string {
  switch (fieldType) {
    case "number":
    case "rating":
    case "count":
    case "rollup":
    case "autonumber":
    case "auto_number":
      return "TEXT";
    case "boolean":
      return "INTEGER"; // 0 or 1
    case "date":
    case "last_modified":
    case "created_on":
      return "TEXT"; // ISO 8601
    case "duration":
      return "TEXT"; // encoded seconds
    case "link_row":
    case "lookup":
    case "multiple_select":
    case "multiple_collaborators":
    case "file":
      return "TEXT"; // JSON array
    case "uuid":
      return "TEXT";
    default:
      return "TEXT";
  }
}

export function getDefaultValue(fieldType: FieldType): string | null {
  switch (fieldType) {
    case "boolean":
      return "DEFAULT 0";
    case "rating":
      return "DEFAULT 'n:0'";
    case "uuid":
      return null; // generated at insert time via trigger or app logic
    default:
      return null;
  }
}

// ── Create user table (if not exists) ────────────────────────────────────────
export async function getOrCreateUserTable(db: D1Database, tableId: number): Promise<void> {
  const tableName = `database_table_${tableId}`;

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      [order] REAL NOT NULL DEFAULT 10000,
      trashed INTEGER NOT NULL DEFAULT 0,
      _created_on TEXT,
      _updated_on TEXT,
      _created_by_id INTEGER,
      _last_modified_by_id INTEGER
    )
  `).run();
  await ensureUserTableSystemColumns(db, tableId);
}

export async function ensureUserTableSystemColumns(db: D1Database, tableId: number): Promise<void> {
  const tableName = `database_table_${tableId}`;
  const columnStatement = db.prepare(`PRAGMA table_info("${tableName}")`) as any;
  let columns: { results?: Array<{ name: string }> };
  if (typeof columnStatement.all === "function") {
    columns = await columnStatement.all();
  } else if (typeof columnStatement.bind === "function" && typeof columnStatement.bind().all === "function") {
    columns = await columnStatement.bind().all();
  } else {
    return;
  }
  const names = new Set((columns.results || []).map((column: { name: string }) => column.name));
  if (!names.has("trashed")) {
    try {
      const alterStatement = db.prepare(`ALTER TABLE "${tableName}" ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0`) as any;
      if (typeof alterStatement.run === "function") {
        await alterStatement.run();
      } else if (typeof alterStatement.bind === "function" && typeof alterStatement.bind().run === "function") {
        await alterStatement.bind().run();
      }
    } catch (error: any) {
      if (!String(error?.message || error).includes("duplicate column")) throw error;
    }
  }
}

// ── Add field column to user table ───────────────────────────────────────────
export async function addFieldColumn(
  db: D1Database,
  tableId: number,
  field: FieldDefinition
): Promise<void> {
  const tableName = `database_table_${tableId}`;
  const columnName = `field_${field.id}`;
  const colType = getSQLiteColumnType(field.type);
  const defaultVal = getDefaultValue(field.type);

  let sql = `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${colType}`;
  if (defaultVal) sql += ` ${defaultVal}`;

  try {
    await db.prepare(sql).run();
  } catch (e: any) {
    // Column already exists — ignore
    if (!e.message?.includes("duplicate column")) throw e;
  }
}

// ── Rename field column ───────────────────────────────────────────────────────
// D1 (SQLite) does not support RENAME COLUMN in older versions
// We handle this at the application layer by always using field_<id> as column names
// The "name" is stored in the database_field table, not the column name
// So renames are free — no column rename needed.

// ── Drop field column ─────────────────────────────────────────────────────────
// SQLite doesn't support DROP COLUMN easily in older versions
// We mark fields as trashed and exclude them from queries
export async function dropFieldColumn(
  db: D1Database,
  tableId: number,
  fieldId: number
): Promise<void> {
  // In D1 (SQLite 3.35+), DROP COLUMN is supported
  const tableName = `database_table_${tableId}`;
  const columnName = `field_${fieldId}`;

  try {
    await db.prepare(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`).run();
  } catch (e: any) {
    // If not supported, just leave the column (field is marked trashed in field table)
    console.warn(`Could not drop column ${columnName}: ${e.message}`);
  }
}

// ── Drop user table ────────────────────────────────────────────────────────────
export async function dropUserTable(db: D1Database, tableId: number): Promise<void> {
  const tableName = `database_table_${tableId}`;
  await db.prepare(`DROP TABLE IF EXISTS "${tableName}"`).run();
}

// ── Build SELECT query for rows ───────────────────────────────────────────────
export interface FieldMeta {
  id: number;
  name: string;
  type: FieldType;
  primary: boolean;
  order?: number;
  readOnly?: boolean;
  formula?: string;     // For type === "formula", the formula string to evaluate
  settings?: Record<string, unknown>;
}

export function buildRowSelectSQL(tableId: number, fields: FieldMeta[]): string {
  const tableName = `database_table_${tableId}`;
  const fieldCols = fields.map(f => `"field_${f.id}" AS "field_${f.id}"`).join(", ");
  const columns = ["id", "[order]", ...(fieldCols ? [fieldCols] : []), "_created_on", "_updated_on"];
  return `SELECT ${columns.join(", ")} FROM "${tableName}" WHERE COALESCE(trashed, 0)=0`;
}

// ── Serialize row to Baserow API format ───────────────────────────────────────
export function serializeRow(row: Record<string, unknown>, fields: FieldMeta[]): object {
  const result: Record<string, unknown> = {
    id: row.id,
    order: row.order,
  };
  const fieldContext: Record<string, unknown> = {
    __row_id: row.id,
    row_id: row.id,
  };
  for (const field of fields) {
    const rawValue = row[`field_${field.id}`];
    const contextValue = deserializeFieldValue(field.type, rawValue);
    fieldContext[field.name] = contextValue;
    fieldContext[`field_${field.id}`] = contextValue;
  }

  for (const field of fields) {
    const colName = `field_${field.id}`;
    let rawValue = row[colName];
    if (field.type === "formula" && typeof field.formula === "string" && field.formula.trim()) {
      const evaluated = evaluateFormula(field.formula, fieldContext);
      rawValue = evaluated.error ? null : evaluated.value;
    }
    result[colName] = serializeFieldValueForResponse(field, rawValue);
  }

  return result;
}

function deserializeObjectOrNull(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function deserializeNumberOrNull(value: unknown): number | null {
  return numericStorageValue(value);
}

function deserializeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["", "false", "f", "0", "off", "no", "unchecked"].includes(normalized)) return false;
    if (["true", "t", "1", "on", "yes", "checked"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function deserializePassword(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "" || value === false) return null;
  return true;
}

function deserializeArrayOrEmpty(value: unknown): unknown[] {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function isArrayCellFieldType(type: FieldType): boolean {
  return type === "link_row" ||
    type === "lookup" ||
    type === "multiple_select" ||
    type === "multiple_collaborators" ||
    type === "file";
}

export function deserializeFieldValue(type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined) {
    return isArrayCellFieldType(type) ? [] : null;
  }

  switch (type) {
    case "boolean":
      return deserializeBoolean(value);
    case "password":
      return deserializePassword(value);
    case "number":
    case "rating":
    case "count":
    case "duration":
    case "autonumber":
    case "auto_number":
      return deserializeNumberOrNull(value);
    case "rollup": {
      const numeric = numericStorageValue(value);
      return numeric !== null ? numeric : value;
    }
    case "single_select":
    case "created_by":
    case "last_modified_by":
      return deserializeObjectOrNull(value);
    case "link_row":
    case "lookup":
    case "multiple_select":
    case "multiple_collaborators":
    case "file":
      return deserializeArrayOrEmpty(value);
    default:
      return value;
  }
}

export function serializeFieldValueForResponse(field: FieldMeta, value: unknown): unknown {
  const formulaType = String(field.settings?.formula_type || "").toLowerCase();
  if (
    field.type === "number" ||
    field.type === "count" ||
    (["formula", "rollup"].includes(field.type) && formulaType === "number")
  ) {
    return formatNumberForApi(field, value);
  }
  return deserializeFieldValue(field.type, value);
}

export function serializeFieldValueForInsert(type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined) return null;

  switch (type) {
    case "number":
    case "rating":
    case "count":
    case "rollup":
    case "duration":
    case "autonumber":
    case "auto_number":
      return encodeNumericStorageValue(value);
    case "boolean":
      return value ? 1 : 0;
    case "link_row":
    case "lookup":
    case "single_select":
    case "multiple_select":
    case "multiple_collaborators":
    case "created_by":
    case "last_modified_by":
    case "file":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "password":
      return value;
    default:
      return value;
  }
}
