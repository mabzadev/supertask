import type { D1Database } from "@cloudflare/workers-types";
import type { FieldMeta, FieldType } from "./dynamic-tables";
import { deserializeFieldValue, ensureUserTableSystemColumns, replaceFieldColumnDefinition } from "./dynamic-tables";
import { parseDurationSeconds } from "./duration";
import {
  normalizeDateFieldValue,
  normalizeSpecialTextFieldValue,
  serializeFieldValueForStorage,
} from "./field-values";
import { decodeNumericStorageValue } from "./number-format";
import { initializeAutonumberField } from "./autonumber";

type RowForConversion = {
  id: number;
  value: unknown;
  _created_on?: string | null;
  _updated_on?: string | null;
  _created_by_id?: number | null;
  _last_modified_by_id?: number | null;
};

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!["{", "["].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function flatten(value: unknown): unknown[] {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function valueLabel(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(valueLabel).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const label = raw.value ?? raw.visible_name ?? raw.original_name ?? raw.name ?? raw.url ?? raw.id;
    return label === undefined || label === null ? "" : String(label);
  }
  return String(value);
}

export function parseMultipleSelectText(value: unknown): string[] {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) {
    return [...new Set(parsed.map((item) => valueLabel(item).trim().slice(0, 255)).filter(Boolean))];
  }

  const text = valueLabel(parsed);
  if (!text) return [];

  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      const normalized = current.trim().slice(0, 255);
      if (normalized) values.push(normalized);
      current = "";
      continue;
    }
    current += char;
  }
  const normalized = current.trim().slice(0, 255);
  if (normalized) values.push(normalized);
  return [...new Set(values)];
}

export function multipleSelectTextValue(value: unknown): string {
  const parsed = parseMaybeJson(value);
  const values = Array.isArray(parsed) ? parsed : parseMultipleSelectText(parsed);
  return values
    .map((item) => valueLabel(item).trim())
    .filter(Boolean)
    .map((label) => label.includes(",") ? `"${label.replace(/"/g, '""')}"` : label)
    .join(", ");
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = valueLabel(value).replace(/\s/g, "").replace(",", ".");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundedNumberText(field: FieldMeta, value: unknown): string | null {
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = valueLabel(value).replace(/\s/g, "").replace(",", ".");
  const match = text.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;

  const negative = match[1] === "-";
  const integer = match[2] || "";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] || 0);
  let digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  let scale = fraction.length - exponent;
  const places = Math.max(0, Math.trunc(Number(field.settings?.number_decimal_places || 0)));

  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  if (scale > digits.length) digits = `${"0".repeat(scale - digits.length)}${digits}`;

  if (scale > places) {
    const droppedCount = scale - places;
    const keepLength = Math.max(0, digits.length - droppedCount);
    const kept = digits.slice(0, keepLength) || "0";
    const dropped = digits.slice(keepLength).padStart(droppedCount, "0");
    let rounded = BigInt(kept);
    if ((dropped[0] || "0") >= "5") rounded += 1n;
    digits = rounded.toString();
    scale = places;
  } else if (scale < places) {
    digits += "0".repeat(places - scale);
    scale = places;
  }

  if (scale > 0 && digits.length <= scale) {
    digits = `${"0".repeat(scale - digits.length + 1)}${digits}`;
  }
  const integerEnd = scale === 0 ? digits.length : digits.length - scale;
  const integerPart = (digits.slice(0, integerEnd) || "0").replace(/^0+(?=\d)/, "") || "0";
  const fractionalPart = scale > 0 ? digits.slice(integerEnd).padStart(scale, "0") : "";
  const isZero = /^0+$/.test(integerPart) && (!fractionalPart || /^0+$/.test(fractionalPart));
  if (negative && !isZero && field.settings?.number_negative === false) {
    return places > 0 ? `0.${"0".repeat(places)}` : "0";
  }
  return `${negative && !isZero ? "-" : ""}${integerPart}${scale > 0 ? `.${fractionalPart}` : ""}`;
}

function toBoolean(value: unknown, oldType?: FieldType): boolean {
  if (typeof value === "boolean") return value;
  if (oldType === "rating") {
    const numeric = toNumber(value);
    return numeric !== null && numeric > 0;
  }
  if (typeof value === "number") return value === 1;
  const text = valueLabel(value).trim().toLowerCase();
  return ["1", "t", "true", "yes", "y", "on", "checked", "oui"].includes(text);
}

function toSystemDate(field: FieldMeta, value: unknown): string | null {
  try {
    return normalizeDateFieldValue({
      ...field,
      type: "date",
      settings: { ...field.settings, date_include_time: true },
    }, value);
  } catch {
    return null;
  }
}

async function generatedUserCell(db: D1Database, userId: number | null | undefined): Promise<object | null> {
  if (!userId) return null;
  const user = await db.prepare(
    `SELECT id, username, first_name, last_name, email
     FROM auth_user
     WHERE id=?`
  ).bind(userId).first<{
    id: number;
    username: string;
    first_name: string;
    last_name: string;
    email: string;
  }>();
  if (!user) return null;
  const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  return {
    id: user.id,
    name: fullName || user.username || user.email,
    email: user.email,
  };
}

function generatedUuid(): string {
  const cryptoApi = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  return cryptoApi?.randomUUID?.() || `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
}

const RECREATE_FIELD_TYPES = new Set<FieldType>([
  "file",
  "link_row",
  "multiple_collaborators",
  "password",
]);

function losesDataDuringConversion(oldType: FieldType, newType: FieldType): boolean {
  return oldType !== newType && (RECREATE_FIELD_TYPES.has(oldType) || RECREATE_FIELD_TYPES.has(newType));
}

function recreatedFieldValue(type: FieldType): unknown {
  return ["file", "link_row", "multiple_collaborators"].includes(type) ? [] : null;
}

export function valueForFieldConversion(oldType: FieldType, storedValue: unknown): unknown {
  const parsed = parseMaybeJson(storedValue);
  if (oldType === "number") {
    return decodeNumericStorageValue(parsed);
  }
  if (oldType === "single_select" && typeof parsed === "string") {
    return parsed;
  }
  try {
    return deserializeFieldValue(oldType, parsed);
  } catch {
    return parsed;
  }
}

export async function coerceValueForFieldType(
  db: D1Database,
  field: FieldMeta,
  value: unknown,
  row?: RowForConversion,
  now = new Date().toISOString(),
  oldType?: FieldType
): Promise<unknown> {
  const parsed = parseMaybeJson(value);

  switch (field.type) {
    case "text":
    case "long_text":
    case "password":
    case "ai": {
      if (parsed === null || parsed === undefined) return null;
      if (oldType === "multiple_select") {
        const text = multipleSelectTextValue(parsed);
        return text || null;
      }
      return valueLabel(parsed);
    }
    case "url":
    case "email":
    case "phone_number":
      try {
        return normalizeSpecialTextFieldValue(field, parsed);
      } catch {
        return "";
      }
    case "number":
      return roundedNumberText(field, parsed);
    case "duration":
      return parseDurationSeconds(parsed, field.settings?.duration_format);
    case "rating": {
      const number = toNumber(parsed);
      if (number === null) return 0;
      const max = Number(field.settings?.max_value || 5);
      return Math.max(0, Math.min(max, Math.round(number)));
    }
    case "boolean":
      return toBoolean(parsed, oldType);
    case "date":
      try {
        return normalizeDateFieldValue(field, parsed);
      } catch {
        return null;
      }
    case "single_select":
      return valueLabel(Array.isArray(parsed) ? parsed[0] : parsed) || null;
    case "multiple_select":
      if (oldType === "single_select") {
        // One option becomes one option: its label may itself contain commas.
        const label = valueLabel(Array.isArray(parsed) ? parsed[0] : parsed).trim().slice(0, 255);
        return label ? [label] : [];
      }
      return parseMultipleSelectText(parsed);
    case "link_row":
      return parseMultipleSelectText(parsed);
    case "file":
      return flatten(parsed);
    case "multiple_collaborators":
      return parseMultipleSelectText(parsed);
    case "uuid":
      return generatedUuid();
    case "autonumber":
    case "auto_number":
      return row?.id ?? toNumber(parsed);
    case "created_on":
      return row?._created_on || toSystemDate(field, parsed) || now;
    case "last_modified":
      return row?._updated_on || toSystemDate(field, parsed) || now;
    case "created_by":
      return generatedUserCell(db, row?._created_by_id);
    case "last_modified_by":
      return generatedUserCell(db, row?._last_modified_by_id);
    case "formula":
    case "lookup":
    case "rollup":
    case "count":
      return null;
    default:
      return parsed;
  }
}

/**
 * A view of `db` whose SELECTs are memoised by SQL and arguments. Converting a
 * column looks up the same select options, users or linked rows for many
 * cells; without this every cell cost its own queries and a conversion of
 * ~950 rows hit D1's query limit half-way. Only use it for reads that the
 * conversion itself does not change (it only writes the converted column).
 */
function memoizedReads(db: D1Database): D1Database {
  const cache = new Map<string, Promise<unknown>>();
  const remember = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let pending = cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load();
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  };
  const wrap = (statement: D1PreparedStatement, sql: string, args: unknown[]): D1PreparedStatement => {
    const key = `${sql}\u0000${JSON.stringify(args)}`;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        if (property === "first") return (column?: string) => remember(`first:${column ?? ""}:${key}`, () => column === undefined ? target.first() : target.first(column));
        if (property === "all") return () => remember(`all:${key}`, () => target.all());
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return /^\s*(SELECT|PRAGMA)\b/i.test(sql) ? wrap(statement, sql, []) : statement;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function convertExistingFieldValues(
  db: D1Database,
  tableId: number,
  field: FieldMeta,
  oldType: FieldType,
  forceRecreate = false
): Promise<number> {
  await ensureUserTableSystemColumns(db, tableId);
  if ((field.type === "autonumber" || field.type === "auto_number") && oldType !== field.type) {
    await replaceFieldColumnDefinition(db, tableId, field.id, oldType, field.type);
    return initializeAutonumberField(
      db,
      tableId,
      field.id,
      field.settings?.view_id === null || field.settings?.view_id === undefined
        ? null
        : Number(field.settings.view_id)
    );
  }
  const rows = await db.prepare(
    `SELECT id, "field_${field.id}" AS value, _created_on, _updated_on, _created_by_id, _last_modified_by_id
     FROM "database_table_${tableId}"`
  ).all<RowForConversion>();
  const results = rows.results || [];
  let converted = 0;
  const sources = results.map((row) => valueForFieldConversion(oldType, row.value));
  // Sources are read above, so the column can take the new type's affinity and
  // default before the converted values are written into it.
  if (oldType !== field.type) await replaceFieldColumnDefinition(db, tableId, field.id, oldType, field.type);
  const lookups = memoizedReads(db);

  for (let index = 0; index < results.length; index += 50) {
    const batch = [];
    const slice = results.slice(index, index + 50);
    for (let offset = 0; offset < slice.length; offset += 1) {
      const row = slice[offset];
      const source = sources[index + offset];
      const coerced = forceRecreate || losesDataDuringConversion(oldType, field.type)
        ? recreatedFieldValue(field.type)
        : await coerceValueForFieldType(lookups, field, source, row, undefined, oldType);
      const serialized = await serializeFieldValueForStorage(lookups, field, coerced);
      batch.push(
        db.prepare(`UPDATE "database_table_${tableId}" SET "field_${field.id}"=? WHERE id=?`)
          .bind(serialized, row.id)
      );
      converted += 1;
    }
    if (batch.length > 0) await db.batch(batch);
  }

  return converted;
}
