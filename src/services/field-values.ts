import type { D1Database } from "@cloudflare/workers-types";
import { chunkIds, ensureUserTableSystemColumns, serializeFieldValueForInsert, type FieldMeta } from "./dynamic-tables";
import { parseDurationSeconds } from "./duration";
import { ApiError, ValidationError } from "../middleware/error";
import type { Env } from "../types/env";
import { serializeUserFileCell, serializeUserFileCellForRequest, type StoredUserFile } from "./user-files";
import { canonicalNumberText, decimalPlacesInInput, encodeNumericStorageValue } from "./number-format";
import { hashPassword } from "./user";

type SelectOption = { id: number; value: string; color: string };
type LinkRowValue = { id: number; value: string };
type CollaboratorValue = { id: number; name: string };
type FileUrlContext = string | Pick<
  Env,
  | "PUBLIC_URL"
  | "JWT_SIGNING_KEY"
  | "SECRET_KEY"
  | "SUPERTASK_SERVE_FILES_THROUGH_BACKEND"
  | "SUPERTASK_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS"
>;

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function primitiveId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object") {
    const raw = (value as Record<string, unknown>).id;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  }
  return null;
}

function primitiveText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const label = raw.value ?? raw.visible_name ?? raw.original_name ?? raw.name ?? raw.url ?? raw.id;
    return label === null || label === undefined ? "" : String(label);
  }
  return String(value);
}

function normalizeNumber(field: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  const text = canonicalNumberText(field, primitiveText(value));
  if (text === null) {
    throw new ValidationError(`The value for field ${field.id} is not a valid number`);
  }
  if (!text) return null;
  const decimalPlaces = Number(field.settings?.number_decimal_places);
  const inputDecimalPlaces = decimalPlacesInInput(text);
  if (inputDecimalPlaces === null) {
    throw new ValidationError(`The value for field ${field.id} is not a valid number`);
  }
  if (Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && inputDecimalPlaces > decimalPlaces) {
    throw new ValidationError(`The value for field ${field.id} has too many decimal places.`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`The value for field ${field.id} is not a valid number`);
  }
  if (field.settings?.number_negative === false && parsed < 0) {
    throw new ValidationError(`The value for field ${field.id} cannot be negative.`);
  }
  return encodeNumericStorageValue(text);
}

function normalizeRating(field: FieldMeta, value: unknown): number {
  if (!value) return 0;
  const text = primitiveText(value).trim();
  const parsed = Number(text);
  if (!Number.isInteger(parsed)) {
    throw new ValidationError(`The value for field ${field.id} is not a valid number`);
  }
  const max = Number(field.settings?.max_value || 5);
  if (parsed < 0) {
    throw new ValidationError("Ensure this value is greater than or equal to 0.");
  }
  if (parsed > max) {
    throw new ValidationError(`Ensure this value is less than or equal to ${max}.`);
  }
  return parsed;
}

function normalizeBoolean(field: FieldMeta, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === 0.0 || value === "0") return false;
  const text = primitiveText(value);
  if (["t", "T", "y", "Y", "yes", "Yes", "YES", "true", "True", "TRUE", "on", "On", "ON", "checked"].includes(text)) {
    return true;
  }
  if (["f", "F", "n", "N", "no", "No", "NO", "false", "False", "FALSE", "off", "Off", "OFF", "unchecked"].includes(text)) {
    return false;
  }
  if (text === "") return Boolean(field.settings?.boolean_default);
  throw new ValidationError(`Invalid value for boolean field: ${text}`);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function utcDateFromParts(year: number, month: number, day: number, time = "00:00:00.000"): Date | null {
  if (!validCalendarDate(year, month, day)) return null;
  const match = time.trim().match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\.(\d{1,6}))?\s*(AM|PM|am|pm)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number((match[4] || "").padEnd(3, "0").slice(0, 3) || 0);
  const ampm = match[5]?.toUpperCase();
  if (ampm === "AM" && hours === 12) hours = 0;
  if (ampm === "PM" && hours < 12) hours += 12;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  const timezone = match[6];
  const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const isoTime = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  const date = timezone
    ? new Date(`${isoDate}T${isoTime}${timezone}`)
    : new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, millis));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseFormattedDate(text: string, dateFormat: string): Date | null {
  const match = text.trim().match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})(?:[ T]+(.+))?$/);
  if (!match) return null;

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  const firstIsYear = match[1].length === 4;
  const thirdIsYear = match[3].length === 4;
  if (!firstIsYear && !thirdIsYear) return null;

  let year: number;
  let month: number;
  let day: number;
  if (firstIsYear) {
    year = first;
    month = second;
    day = third;
  } else if (dateFormat === "US") {
    year = third;
    month = first;
    day = second;
  } else {
    year = third;
    month = second;
    day = first;
  }

  return utcDateFromParts(year, month, day, match[4] || "00:00:00.000");
}

function parseNamedMonthDate(text: string): Date | null {
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const slashMatch = text.trim().match(
    /^(\d{1,2})\/([A-Za-z]{3,9})\/(\d{4})(?::|\s+)(.+)$/
  );
  if (!slashMatch) return null;
  const month = months[slashMatch[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return utcDateFromParts(
    Number(slashMatch[3]),
    month,
    Number(slashMatch[1]),
    slashMatch[4]
  );
}

function parseNativeDateAsUtc(text: string): Date | null {
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})\s*$/i.test(text)) return parsed;
  return new Date(Date.UTC(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    parsed.getHours(),
    parsed.getMinutes(),
    parsed.getSeconds(),
    parsed.getMilliseconds()
  ));
}

function parseDateLikeSupertask(text: string, dateFormat: string): Date | null {
  const formatted = parseFormattedDate(text, dateFormat);
  if (formatted) return formatted;

  const namedMonth = parseNamedMonthDate(text);
  if (namedMonth) return namedMonth;

  return parseNativeDateAsUtc(text);
}

export function normalizeDateFieldValue(field: FieldMeta, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError("The provided string could not converted to a date.");
    }
    const iso = value.toISOString();
    return field.settings?.date_include_time === true ? iso : iso.slice(0, 10);
  }
  const text = primitiveText(value).trim();
  if (!text) return null;
  const date = parseDateLikeSupertask(text, String(field.settings?.date_format || "EU").toUpperCase());
  if (!date) {
    throw new ValidationError("The provided string could not converted to a date.");
  }
  const iso = date.toISOString();
  return field.settings?.date_include_time === true ? iso : iso.slice(0, 10);
}

const URL_RE = /^[^\s]{0,255}(?:\.|\/\/)[^\s]{1,}$/u;
const EMAIL_RE = /^(?=.{3,254}$)[-.\[\]!#$&*+/=?^_`{|}~\p{L}\p{N}]+@[-.\[\]!#$&*+/=?^_`{|}~\p{L}\p{N}]+$/iu;
const PHONE_RE = /^[0-9NnXx,+._*()#=;/ -]{1,100}$/u;

export function normalizeSpecialTextFieldValue(field: Pick<FieldMeta, "id" | "type">, value: unknown): string {
  const text = primitiveText(value);
  if (text === "") return "";

  let valid = true;
  if (field.type === "url") valid = URL_RE.test(text);
  if (field.type === "email") valid = EMAIL_RE.test(text);
  if (field.type === "phone_number") valid = PHONE_RE.test(text);

  if (!valid) {
    throw new ValidationError(`The value for field ${field.id} is not a valid ${field.type}.`);
  }
  return text;
}

async function normalizePassword(value: unknown): Promise<string | null | undefined> {
  if (value === true) return undefined;
  if (value === null || value === undefined || value === "") return null;
  return hashPassword(primitiveText(value));
}

async function selectOptionByIdOrValue(
  db: D1Database,
  field: FieldMeta,
  value: unknown
): Promise<SelectOption | null> {
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if (raw.id !== undefined) {
      const option = await selectOptionByIdOrValue(db, field, raw.id);
      if (option) return option;
    }
    if (raw.value !== undefined) {
      const option = await selectOptionByIdOrValue(db, field, raw.value);
      if (option) return option;
    }
    if (typeof raw.value === "string" && raw.color) {
      return { id: Number(raw.id || 0), value: raw.value, color: String(raw.color) };
    }
  }

  const id = primitiveId(value);
  if (id !== null) {
    const byId = await db.prepare(
      "SELECT id, value, color FROM database_selectoption WHERE field_id=? AND id=?"
    ).bind(field.id, id).first<SelectOption>();
    if (byId) return { id: byId.id, value: byId.value, color: byId.color || "blue" };
  }

  const text = String(value ?? "").trim();
  if (!text) return null;
  const byValue = await db.prepare(
    field.type === "single_select"
      ? "SELECT id, value, color FROM database_selectoption WHERE field_id=? AND LOWER(value)=LOWER(?) ORDER BY [order] ASC, id ASC LIMIT 1"
      : "SELECT id, value, color FROM database_selectoption WHERE field_id=? AND value=? ORDER BY [order] ASC, id ASC LIMIT 1"
  ).bind(field.id, text).first<SelectOption>();
  return byValue ? { id: byValue.id, value: byValue.value, color: byValue.color || "blue" } : null;
}

async function primaryFieldForLinkedTable(db: D1Database, tableId: number): Promise<{ id: number; type: string } | null> {
  return db.prepare(
    `SELECT id, type
     FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY "primary" DESC, [order] ASC, id ASC
     LIMIT 1`
  ).bind(tableId).first<{ id: number; type: string }>();
}

/**
 * Request-scoped lookup of linked rows' primary values. Pass one instance to
 * every `serializeFieldValueForStorage` call of a batch write so each target
 * table's primary field and each linked row are read once, in bulk.
 */
export class LinkTargetCache {
  private readonly primaries = new Map<number, Promise<{ id: number; type: string } | null>>();
  private readonly values = new Map<string, Promise<string | null>>();

  constructor(private readonly db: D1Database) {}

  primaryField(tableId: number) {
    let pending = this.primaries.get(tableId);
    if (!pending) {
      pending = primaryFieldForLinkedTable(this.db, tableId);
      this.primaries.set(tableId, pending);
    }
    return pending;
  }

  /** Loads the primary values of these rows that are not cached yet. */
  async prefetch(tableId: number, ids: number[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.values.has(`${tableId}:${id}`));
    if (missing.length === 0) return;
    const primary = await this.primaryField(tableId);
    if (!primary) return;
    await ensureUserTableSystemColumns(this.db, tableId);
    for (const chunk of chunkIds(missing)) {
      const loaded = this.db.prepare(
        `SELECT id, "field_${primary.id}" AS value FROM "database_table_${tableId}"
         WHERE COALESCE(trashed, 0)=0 AND id IN (${chunk.map(() => "?").join(",")})`
      ).bind(...chunk).all<{ id: number; value: unknown }>()
        .then((result) => new Map((result.results || []).map((row) => [Number(row.id), String(row.value ?? "")])));
      for (const id of chunk) this.values.set(`${tableId}:${id}`, loaded.then((byId) => byId.get(id) ?? null));
    }
    await Promise.all(missing.map((id) => this.values.get(`${tableId}:${id}`)));
  }

  /** Primary value of a live row, `null` when it is missing or trashed. */
  async primaryValue(tableId: number, id: number): Promise<string | null> {
    await this.prefetch(tableId, [id]);
    return this.values.get(`${tableId}:${id}`) ?? null;
  }
}

async function linkRowById(db: D1Database, field: FieldMeta, value: unknown, cache: LinkTargetCache): Promise<LinkRowValue | null> {
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const id = primitiveId(raw.id);
    if (id !== null && raw.value !== undefined) {
      return { id, value: String(raw.value ?? "") };
    }
    if (id !== null) return linkRowById(db, field, id, cache);
  }

  const id = primitiveId(value);
  const tableId = Number(field.settings?.link_row_table_id || 0);
  if (id === null || !tableId) return null;
  const primary = await cache.primaryField(tableId);
  if (!primary) return { id, value: String(id) };
  const primaryValue = await cache.primaryValue(tableId, id);
  return primaryValue === null ? null : { id, value: primaryValue };
}

function userDisplayName(row: { username?: string; first_name?: string; last_name?: string; email?: string }) {
  const fullName = [row.first_name, row.last_name].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  return fullName || String(row.username || row.email || "");
}

function collaboratorFromUser(row: { id: number; username?: string; first_name?: string; last_name?: string; email?: string }): CollaboratorValue {
  return {
    id: Number(row.id),
    name: userDisplayName(row),
  };
}

async function collaboratorWorkspaceId(
  db: D1Database,
  field: FieldMeta,
  workspaceId?: number | null
): Promise<number | null> {
  if (workspaceId && Number.isInteger(workspaceId)) return workspaceId;
  const row = await db.prepare(
    `SELECT a.workspace_id
     FROM database_field f
     JOIN database_table t ON t.id=f.table_id
     JOIN core_application a ON a.id=t.database_id
     WHERE f.id=? AND f.trashed=0 AND t.trashed=0`
  ).bind(field.id).first<{ workspace_id: number }>();
  return row ? Number(row.workspace_id) : null;
}

async function normalizeCollaborators(
  db: D1Database,
  field: FieldMeta,
  value: unknown,
  workspaceId?: number | null
): Promise<CollaboratorValue[]> {
  if (!Array.isArray(value)) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", `The value for field ${field.id} is not a valid list of dictionaries`);
  }
  if (value.length === 0) return [];
  const resolvedWorkspaceId = await collaboratorWorkspaceId(db, field, workspaceId);
  if (!resolvedWorkspaceId) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "The provided user ids are not valid collaborators.");
  }
  const collaborators: CollaboratorValue[] = [];
  const seen = new Set<number>();
  const invalidIds: number[] = [];
  for (const item of value) {
    const id = primitiveId(item);
    if (id === null || !Number.isInteger(id) || id <= 0) {
      throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "Expected an integer or an object with an 'id' field");
    }
    if (seen.has(id)) {
      invalidIds.push(id);
      continue;
    }
    seen.add(id);
    const user = await db.prepare(
      `SELECT u.id, u.username, u.first_name, u.last_name, u.email
       FROM core_workspaceuser wu
       JOIN auth_user u ON u.id=wu.user_id
       LEFT JOIN core_userprofile p ON p.user_id=u.id
       WHERE wu.workspace_id=? AND wu.user_id=? AND wu.to_be_deleted=0
         AND u.is_active=1 AND COALESCE(p.to_be_deleted, 0)=0
       LIMIT 1`
    ).bind(resolvedWorkspaceId, id).first<any>();
    if (!user) {
      invalidIds.push(id);
      continue;
    }
    collaborators.push(collaboratorFromUser(user));
  }
  if (invalidIds.length > 0) {
    const label = invalidIds.length === 1 ? "id" : "ids";
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", `The provided user ${label} [${invalidIds.join(", ")}] ${invalidIds.length === 1 ? "is" : "are"} not valid collaborators.`);
  }
  return collaborators;
}

async function storedUserFileByName(db: D1Database, name: string): Promise<StoredUserFile | null> {
  if (!name) return null;
  return db.prepare("SELECT * FROM core_userfile WHERE name=?").bind(name).first<StoredUserFile>();
}

function splitCommaSeparatedFileNames(value: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  values.push(current);
  return values;
}

function fileInputObjects(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return splitCommaSeparatedFileNames(value).map((name) => ({ name }));
  }
  if (!Array.isArray(value)) {
    throw new ValidationError("This value must be a list or a string.");
  }
  if (value.length === 0) return [];
  const firstIsString = typeof value[0] === "string";
  const firstIsObject = Boolean(value[0] && typeof value[0] === "object" && !Array.isArray(value[0]));
  if (!firstIsString && !firstIsObject) {
    throw new ValidationError("The provided value must contain valid file names or objects.");
  }
  if (value.some((item) => firstIsString
    ? typeof item !== "string"
    : !item || typeof item !== "object" || Array.isArray(item))) {
    throw new ValidationError("All file values must have the same type.");
  }
  return firstIsString
    ? (value as string[]).map((name) => ({ name }))
    : value as Array<Record<string, unknown>>;
}

function assertValidUserFileName(name: string): void {
  if (/^[a-zA-Z0-9]+_[a-zA-Z0-9]+\..*$/.test(name)) return;
  throw new ApiError(400, "ERROR_INVALID_USER_FILE_NAME_ERROR", `The user file name ${name} is invalid.`);
}

async function serializeStoredFileForContext(
  stored: StoredUserFile,
  context?: FileUrlContext,
  workspaceId?: number | null
): Promise<Record<string, unknown>> {
  if (context && typeof context === "object") {
    return await serializeUserFileCellForRequest(context as Env, stored, workspaceId) as Record<string, unknown>;
  }
  return serializeUserFileCell({ PUBLIC_URL: context } as Env, stored) as Record<string, unknown>;
}

async function normalizeFileList(
  db: D1Database,
  value: unknown,
  context?: FileUrlContext,
  workspaceId?: number | null
): Promise<unknown[]> {
  const files: unknown[] = [];
  for (const raw of fileInputObjects(value)) {
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!name) {
      throw new ValidationError("A name property is required for all file values.");
    }
    if (raw.external !== true) {
      assertValidUserFileName(name);
      const stored = await storedUserFileByName(db, name);
      if (!stored) {
        throw new ApiError(400, "ERROR_USER_FILE_DOES_NOT_EXIST", `The user files ${name} do not exist.`);
      }
      files.push({
        ...(await serializeStoredFileForContext(stored, context, workspaceId)),
        visible_name: String(raw.visible_name || stored.original_name),
      });
      continue;
    }
    const visibleName = String(raw.visible_name || raw.original_name || name);
    files.push({
      ...raw,
      visible_name: visibleName,
      original_name: String(raw.original_name ?? visibleName),
      name: name || visibleName,
      size: Number(raw.size || 0),
      mime_type: String(raw.mime_type ?? raw.type ?? "application/octet-stream"),
      is_image: Boolean(raw.is_image),
      image_width: raw.image_width ?? null,
      image_height: raw.image_height ?? null,
      uploaded_at: raw.uploaded_at ?? new Date().toISOString(),
    });
  }
  return files;
}

export async function normalizeFieldValueForStorage(
  db: D1Database,
  field: FieldMeta,
  value: unknown,
  context?: FileUrlContext,
  workspaceId?: number | null,
  linkTargets?: LinkTargetCache
): Promise<unknown> {
  if (value === null || value === undefined) {
    if (field.type === "multiple_collaborators") {
      throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", "This field may not be null.");
    }
    if (["multiple_select", "link_row", "file"].includes(field.type)) return [];
    if (["url", "email", "phone_number"].includes(field.type)) return "";
    return null;
  }

  switch (field.type) {
    case "url":
    case "email":
    case "phone_number":
      return normalizeSpecialTextFieldValue(field, value);
    case "number":
      return normalizeNumber(field, value);
    case "rating":
      return encodeNumericStorageValue(normalizeRating(field, value));
    case "boolean":
      return normalizeBoolean(field, value);
    case "date":
      return normalizeDateFieldValue(field, value);
    case "duration":
      return encodeNumericStorageValue(parseDurationSeconds(value, field.settings?.duration_format));
    case "password":
      return normalizePassword(value);
    case "single_select":
      return selectOptionByIdOrValue(db, field, value);
    case "multiple_select": {
      const options: SelectOption[] = [];
      for (const item of asArray(value)) {
        const option = await selectOptionByIdOrValue(db, field, item);
        if (option) options.push(option);
      }
      return options;
    }
    case "link_row": {
      const input = asArray(value);
      if (field.settings?.link_row_multiple_relationships === false && input.length > 1) {
        throw new ValidationError(`This link row field only accepts one relationship.`);
      }
      const links: LinkRowValue[] = [];
      const seen = new Set<number>();
      const cache = linkTargets || new LinkTargetCache(db);
      const tableId = Number(field.settings?.link_row_table_id || 0);
      if (tableId) {
        const ids = input
          .filter((item) => !(item && typeof item === "object" && (item as Record<string, unknown>).value !== undefined))
          .map(primitiveId)
          .filter((id): id is number => id !== null);
        await cache.prefetch(tableId, ids);
      }
      for (const item of input) {
        const link = await linkRowById(db, field, item, cache);
        if (link && !seen.has(link.id)) {
          seen.add(link.id);
          links.push(link);
        }
      }
      return links;
    }
    case "file":
      return normalizeFileList(db, value, context, workspaceId);
    case "multiple_collaborators":
      return normalizeCollaborators(db, field, value, workspaceId);
    default:
      return value;
  }
}

export async function serializeFieldValueForStorage(
  db: D1Database,
  field: FieldMeta,
  value: unknown,
  context?: FileUrlContext,
  workspaceId?: number | null,
  linkTargets?: LinkTargetCache
): Promise<unknown> {
  const normalized = await normalizeFieldValueForStorage(db, field, value, context, workspaceId, linkTargets);
  if (normalized === undefined) return undefined;
  return serializeFieldValueForInsert(field.type, normalized);
}
