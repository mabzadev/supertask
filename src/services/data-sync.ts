import { ApiError, DoesNotExist, PermissionError, ValidationError } from "../middleware/error";
import { addFieldColumn, deserializeFieldValue, dropFieldColumn, ensureUserTableSystemColumns, getOrCreateUserTable, serializeFieldValueForInsert, type FieldType } from "./dynamic-tables";
import type { Env } from "../types/env";
import { assertHasApplicationRole, assertHasTableRole } from "./enterprise-permissions";
import { createDirectNotificationForUsers } from "./notifications";
import { queryViewRows } from "./view-query";
import { dispatchPublicHttpRequest } from "./outbound-http";

export interface DataSyncRow {
  id: number;
  table_id: number;
  type: string;
  settings: string;
  last_sync: string | null;
  last_error: string | null;
  auto_add_new_properties: number;
  two_way_sync: number;
  authorized: number;
  authorized_user_id?: number | null;
  periodic_interval?: string | null;
  periodic_interval_count?: number | null;
  last_periodic_sync?: string | null;
  next_periodic_sync?: string | null;
  consecutive_failures?: number | null;
  two_way_sync_consecutive_failures?: number | null;
  deactivated?: number | null;
  deactivation_reason?: string | null;
  created_on: string;
  updated_on: string;
}

interface SyncProperty {
  key: string;
  name: string;
  field_type: FieldType;
  unique_primary: boolean;
  initially_selected: boolean;
  immutable_properties?: boolean;
  source_field_type?: FieldType;
  field_settings?: Record<string, unknown>;
  select_options?: Array<{ id: string; value: string; color: string; order: number }>;
}

type DataSyncSyncedPropertyRow = {
  id: number;
  field_id: number | null;
  key: string;
  unique_primary: number;
  field_type: FieldType | null;
  field_name: string | null;
  field_settings: string | null;
  field_primary: number | null;
  read_only: number | null;
};

type DataSyncEnv = Pick<Env, "HYPERDRIVE">;
type DataSyncRuntimeEnv = Pick<Env, "HYPERDRIVE" | "DB">;

const PERIODIC_FAILURE_LIMIT = 3;
const TWO_WAY_SYNC_FAILURE_LIMIT = 8;
const DATA_SYNC_REQUEST_TIMEOUT_MS = 60_000;
const PERIODIC_DEACTIVATION_REASON_FAILURES = "consecutive_failures";
const DATA_SYNC_DATETIME_SETTINGS = { date_format: "ISO", date_include_time: true, date_time_format: "24", date_show_tzinfo: true };
const DATA_SYNC_INTEGER_SETTINGS = { number_decimal_places: 0, number_negative: false };
const DATA_SYNC_RICH_LONG_TEXT_SETTINGS = { long_text_enable_rich_text: true };

type LocalSupertaskFieldRow = {
  id: number;
  name: string;
  type: FieldType;
  primary: number;
  field_settings: string | null;
};

const ICAL_PROPERTIES: SyncProperty[] = [
  { key: "uid", name: "Unique ID", field_type: "text", unique_primary: true, initially_selected: true },
  { key: "dtstart", name: "Start date", field_type: "date", unique_primary: false, initially_selected: true, immutable_properties: false, field_settings: { date_format: "ISO", date_include_time: true, date_time_format: "24", date_show_tzinfo: true } },
  { key: "dtend", name: "End date", field_type: "date", unique_primary: false, initially_selected: true, immutable_properties: false, field_settings: { date_format: "ISO", date_include_time: true, date_time_format: "24", date_show_tzinfo: true } },
  { key: "summary", name: "Summary", field_type: "text", unique_primary: false, initially_selected: true },
];

const LOCAL_SUPERTASK_SUPPORTED_FIELD_TYPES = new Set<FieldType>([
  "text", "long_text", "url", "email", "number", "rating", "boolean", "date",
  "duration", "file", "phone_number", "created_on", "last_modified", "uuid",
  "autonumber", "ai", "single_select",
]);

const DATA_SYNC_PROPERTIES: Record<string, SyncProperty[]> = {
  ical_calendar: ICAL_PROPERTIES,
  postgresql: [
    { key: "id", name: "ID", field_type: "text", unique_primary: true, initially_selected: true },
    { key: "data", name: "Data", field_type: "long_text", unique_primary: false, initially_selected: true },
  ],
  local_supertask_table: [
    { key: "id", name: "ID", field_type: "number", unique_primary: true, initially_selected: true },
    { key: "name", name: "Name", field_type: "text", unique_primary: false, initially_selected: true },
  ],
  github_issues: [
    { key: "id", name: "GitHub Issue ID", field_type: "number", unique_primary: true, initially_selected: true, field_settings: DATA_SYNC_INTEGER_SETTINGS },
    { key: "title", name: "Title", field_type: "text", unique_primary: false, initially_selected: true },
    { key: "body", name: "Body", field_type: "long_text", unique_primary: false, initially_selected: true, field_settings: DATA_SYNC_RICH_LONG_TEXT_SETTINGS },
    { key: "user", name: "User", field_type: "text", unique_primary: false, initially_selected: true },
    { key: "assignee", name: "Assignee", field_type: "text", unique_primary: false, initially_selected: true },
    { key: "assignees", name: "Assignees", field_type: "text", unique_primary: false, initially_selected: true },
    { key: "labels", name: "Labels", field_type: "text", unique_primary: false, initially_selected: true },
    { key: "state", name: "State", field_type: "text", unique_primary: false, initially_selected: true },
    { key: "created_at", name: "Created At", field_type: "date", unique_primary: false, initially_selected: true, field_settings: DATA_SYNC_DATETIME_SETTINGS },
    { key: "updated_at", name: "Updated At", field_type: "date", unique_primary: false, initially_selected: true, field_settings: DATA_SYNC_DATETIME_SETTINGS },
    { key: "closed_at", name: "Closed At", field_type: "date", unique_primary: false, initially_selected: true, field_settings: DATA_SYNC_DATETIME_SETTINGS },
    { key: "closed_by", name: "Closed By", field_type: "text", unique_primary: false, initially_selected: true },
    { key: "milestone", name: "Milestone", field_type: "text", unique_primary: false, initially_selected: true },
    { key: "url", name: "URL to Issue", field_type: "url", unique_primary: false, initially_selected: true },
  ],
};

const DATA_SYNC_SERIALIZER_SETTING_NAMES: Record<string, string[]> = {
  ical_calendar: ["ical_url"],
  postgresql: [
    "postgresql_host",
    "postgresql_username",
    "postgresql_port",
    "postgresql_database",
    "postgresql_schema",
    "postgresql_table",
    "postgresql_sslmode",
  ],
  local_supertask_table: ["source_table_id", "source_table_view_id"],
  github_issues: ["github_issues_owner", "github_issues_repo"],
};

const DATA_SYNC_SERIALIZER_SETTING_DEFAULTS: Record<string, Record<string, unknown>> = {
  ical_calendar: { ical_url: "" },
  postgresql: {
    postgresql_host: "",
    postgresql_username: "",
    postgresql_port: 5432,
    postgresql_database: "",
    postgresql_schema: "public",
    postgresql_table: "",
    postgresql_sslmode: "prefer",
  },
  local_supertask_table: { source_table_id: null, source_table_view_id: null },
  github_issues: { github_issues_owner: "", github_issues_repo: "" },
};

function serializedDataSyncSettings(dataSync: DataSyncRow) {
  const settings = parseSettings(dataSync);
  const names = DATA_SYNC_SERIALIZER_SETTING_NAMES[dataSync.type] || [];
  const defaults = DATA_SYNC_SERIALIZER_SETTING_DEFAULTS[dataSync.type] || {};
  return Object.fromEntries(
    names.map((name) => [
      name,
      Object.prototype.hasOwnProperty.call(settings, name) ? settings[name] : defaults[name],
    ])
  );
}

export async function requireDatabaseAccess(db: D1Database, userId: number, databaseId: number, requiredRole = "VIEWER") {
  const app = await db.prepare("SELECT id, workspace_id FROM core_application WHERE id=? AND trashed=0")
    .bind(databaseId)
    .first<{ id: number; workspace_id: number }>();
  if (!app) throw new DoesNotExist("Database", databaseId);
  await assertHasApplicationRole(db, userId, databaseId, requiredRole);
  return app;
}

export async function requireDataSyncAccess(db: D1Database, userId: number, dataSyncId: number, requiredRole = "VIEWER") {
  const dataSync = await db.prepare(
    `SELECT ds.*, a.workspace_id, w.name AS workspace_name,
            t.database_id, a.name AS database_name,
            t.id AS table_id, t.name AS table_name
     FROM database_datasync ds
     JOIN database_table t ON t.id=ds.table_id
     JOIN core_application a ON a.id=t.database_id
     JOIN core_workspace w ON w.id=a.workspace_id
     WHERE ds.id=? AND t.trashed=0 AND a.trashed=0`
  ).bind(dataSyncId).first<any>();
  if (!dataSync) throw new DoesNotExist("Data sync", dataSyncId);
  await assertHasTableRole(db, userId, {
    id: dataSync.table_id,
    database_id: dataSync.database_id,
    workspace_id: dataSync.workspace_id,
  }, requiredRole);
  return dataSync;
}

export function serializeDataSync(dataSync: DataSyncRow, properties: Array<{ field_id: number | null; key: string; unique_primary: number }> = []) {
  return {
    id: dataSync.id,
    type: dataSync.type,
    synced_properties: properties.map((property) => ({
      field_id: property.field_id,
      key: property.key,
      unique_primary: Boolean(property.unique_primary),
    })),
    last_sync: dataSync.last_sync,
    last_error: dataSync.last_error,
    authorized: Boolean(dataSync.authorized),
    auto_add_new_properties: Boolean(dataSync.auto_add_new_properties),
    two_way_sync: Boolean(dataSync.two_way_sync),
    periodic_interval: dataSync.periodic_interval || null,
    periodic_interval_count: Number(dataSync.periodic_interval_count || 1),
    last_periodic_sync: dataSync.last_periodic_sync || null,
    next_periodic_sync: dataSync.next_periodic_sync || null,
    consecutive_failures: Number(dataSync.consecutive_failures || 0),
    deactivated: Boolean(dataSync.deactivated),
    deactivation_reason: dataSync.deactivation_reason || null,
    ...serializedDataSyncSettings(dataSync),
  };
}

export async function serializeDataSyncById(db: D1Database, id: number) {
  const ds = await db.prepare("SELECT * FROM database_datasync WHERE id=?").bind(id).first<DataSyncRow>();
  if (!ds) throw new DoesNotExist("Data sync", id);
  const props = await db.prepare(
    "SELECT field_id, key, unique_primary FROM database_datasyncsyncedproperty WHERE data_sync_id=? ORDER BY id ASC"
  ).bind(id).all<any>();
  return serializeDataSync(ds, props.results || []);
}

export async function hasActiveDataSyncJob(db: D1Database, dataSyncId: number) {
  const job = await db.prepare(
    `SELECT id
       FROM core_job
      WHERE type IN ('sync_data_sync_table', 'sync_data_source')
        AND status NOT IN ('finished', 'failed', 'cancelled', 'expired')
        AND CAST(json_extract(result, '$.data_sync_id') AS INTEGER)=?
      LIMIT 1`
  ).bind(dataSyncId).first<{ id: number }>();
  return Boolean(job);
}

export function getDataSyncProperties(type: string) {
  const properties = DATA_SYNC_PROPERTIES[type];
  if (!properties) throw new ValidationError(`Data sync type ${type} is not registered.`);
  return properties;
}

function parseSettings(dataSync: { settings: string }) {
  try {
    return JSON.parse(dataSync.settings);
  } catch {
    return {};
  }
}

function unfoldIcs(text: string) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function unescapeIcs(value: string) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function icsParams(left: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of left.split(";").slice(1)) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim().toUpperCase();
    if (key) params[key] = rawValue.join("=").trim();
  }
  return params;
}

function timeZoneOffsetMs(timeZone: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second),
  );
  return asUtc - date.getTime();
}

function zonedIcsDateTimeToUtc(match: RegExpMatchArray, timeZone: string) {
  const guess = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ));
  return new Date(guess.getTime() - timeZoneOffsetMs(timeZone, guess)).toISOString();
}

function parseIcsDate(value: string, params: Record<string, string> = {}) {
  const raw = value.trim();
  const dateOnly = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const dateTime = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (dateTime) {
    if (!raw.endsWith("Z") && params.TZID) {
      try {
        return zonedIcsDateTimeToUtc(dateTime, params.TZID);
      } catch {
        // If the runtime cannot resolve the TZID, keep the previous UTC fallback.
      }
    }
    return `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}:${dateTime[6]}.000Z`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

export function parseIcalEvents(text: string) {
  const unfolded = unfoldIcs(text);
  const events: Record<string, unknown>[] = [];
  const matches = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  for (const block of matches) {
    const event: Record<string, unknown> = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const left = line.slice(0, idx);
      const value = unescapeIcs(line.slice(idx + 1));
      const params = icsParams(left);
      const key = left.split(";")[0].toUpperCase();
      switch (key) {
        case "UID": event.uid = value; break;
        case "SUMMARY": event.summary = value; break;
        case "DESCRIPTION": event.description = value; break;
        case "LOCATION": event.location = value; break;
        case "DTSTART": event.dtstart = parseIcsDate(value, params); break;
        case "DTEND": event.dtend = parseIcsDate(value, params); break;
        case "URL": event.url = value; break;
        case "STATUS": event.status = value; break;
        case "ORGANIZER": event.organizer = value.replace(/^mailto:/i, ""); break;
        case "CREATED": event.created = parseIcsDate(value, params); break;
        case "LAST-MODIFIED": event.last_modified = parseIcsDate(value, params); break;
      }
    }
    if (event.uid || event.summary) events.push(event);
  }
  return events;
}

async function fetchIcal(settings: Record<string, unknown>) {
  const url = normalizeHttpBaseUrl(String(settings.ical_url || ""), "ical_url");
  const response = await dataSyncFetch(url, { headers: { Accept: "text/calendar,text/plain,*/*" } });
  if (!response.ok) throw new ValidationError(`Unable to fetch iCal calendar (${response.status}).`);
  return parseIcalEvents(await response.text());
}

function requiredSetting(settings: Record<string, unknown>, key: string) {
  const value = String(settings[key] || "").trim();
  if (!value) throw new ValidationError(`${key} is required.`);
  return value;
}

function commaNames(values: unknown, key: string) {
  if (!Array.isArray(values)) return "";
  return values
    .map((value) => {
      if (typeof value === "string") return value;
      return value && typeof value === "object" ? String((value as Record<string, unknown>)[key] || "") : "";
    })
    .filter(Boolean)
    .join(", ");
}

function normalizeHttpBaseUrl(value: string, key: string) {
  const raw = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(`${key} must be a valid HTTP URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || privateDataSyncHostname(parsed.hostname)) {
    throw new ValidationError(`${key} must be a valid public HTTP URL.`);
  }
  return raw;
}

function privateDataSyncHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::" || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/**
 * Fetches a user-configured source (iCal feed, API base URL) through the
 * outbound guard: redirects are re-checked against private addresses and the
 * response size is capped, like Builder and automation HTTP requests.
 */
async function dataSyncFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const result = await dispatchPublicHttpRequest({
    url: new URL(String(input)),
    method: String(init.method || "GET").toUpperCase(),
    headers: new Headers(init.headers),
    body: init.body ?? undefined,
    timeoutSeconds: DATA_SYNC_REQUEST_TIMEOUT_MS / 1000,
  });
  const nullBody = result.status_code === 204 || result.status_code === 205 || result.status_code === 304;
  return new Response(nullBody ? null : result.raw_body, { status: result.status_code, headers: result.headers });
}

function localSupertaskSourceTableId(settings: Record<string, unknown>) {
  const raw = settings.source_table_id ?? settings.local_supertask_table_id ?? settings.table_id;
  const tableId = Number(raw);
  if (!Number.isInteger(tableId) || tableId <= 0) throw new ValidationError("source_table_id is required.");
  return tableId;
}

function parseFieldSettings(value: string | null) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

async function localSupertaskSourceTable(db: D1Database, settings: Record<string, unknown>) {
  const tableId = localSupertaskSourceTableId(settings);
  const row = await db.prepare(
    `SELECT t.id, t.name, t.database_id, a.workspace_id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
  ).bind(tableId).first<any>();
  if (!row) throw new DoesNotExist("Source table", tableId);
  return row;
}

async function localSupertaskSourceView(db: D1Database, tableId: number, settings: Record<string, unknown>) {
  const rawViewId = settings.source_table_view_id;
  if (rawViewId === null || rawViewId === undefined || rawViewId === "") return null;
  const viewId = Number(rawViewId);
  if (!Number.isInteger(viewId) || viewId <= 0) throw new ValidationError("source_table_view_id must be a valid view ID.");
  const view = await db.prepare(
    "SELECT * FROM database_view WHERE id=? AND table_id=? AND trashed=0"
  ).bind(viewId, tableId).first<any>();
  if (!view) throw new ValidationError(`The view with id ${viewId} does not exist.`);
  return view;
}

async function localSupertaskVisibleFieldIds(db: D1Database, view: any) {
  let sql: string | null = null;
  if (view.type === "grid") {
    sql = "SELECT field_id FROM database_gridviewfieldoptions WHERE grid_view_id=? AND hidden=0 ORDER BY [order] ASC, id ASC";
  } else if (view.type === "gallery") {
    sql = "SELECT field_id FROM database_galleryviewfieldoptions WHERE gallery_view_id=? AND hidden=0 ORDER BY [order] ASC, id ASC";
  } else if (view.type === "form" || view.type === "survey") {
    sql = "SELECT field_id FROM database_formviewfieldoptions WHERE form_view_id=? AND enabled=1 ORDER BY [order] ASC, id ASC";
  }
  if (!sql) return null;
  const result = await db.prepare(sql).bind(view.id).all<{ field_id: number }>();
  return new Set((result.results || []).map((row) => Number(row.field_id)));
}

async function localSupertaskSelectOptions(db: D1Database, fieldId: number) {
  const rows = await db.prepare(
    `SELECT id, value, color, [order]
     FROM database_selectoption
     WHERE field_id=?
     ORDER BY [order] ASC, id ASC`
  ).bind(fieldId).all<any>();
  return (rows.results || []).map((option: any, index: number) => ({
    id: String(option.id),
    value: String(option.value || ""),
    color: String(option.color || "light-blue"),
    order: Number.isFinite(Number(option.order)) ? Number(option.order) : index,
  }));
}

async function fetchLocalSupertaskProperties(db: D1Database, settings: Record<string, unknown>) {
  const source = await localSupertaskSourceTable(db, settings);
  const view = await localSupertaskSourceView(db, source.id, settings);
  const visibleFieldIds = view ? await localSupertaskVisibleFieldIds(db, view) : null;
  const fields = await db.prepare(
    `SELECT id, name, type, "primary", field_settings
     FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY [order] ASC, id ASC`
  ).bind(source.id).all<LocalSupertaskFieldRow>();
  const properties: SyncProperty[] = [
    { key: "id", name: "Row ID", field_type: "number", unique_primary: true, initially_selected: true, field_settings: DATA_SYNC_INTEGER_SETTINGS },
  ];
  for (const field of fields.results || []) {
    if (visibleFieldIds && !visibleFieldIds.has(Number(field.id))) continue;
    if (!LOCAL_SUPERTASK_SUPPORTED_FIELD_TYPES.has(field.type)) continue;
    const sourceSettings = parseFieldSettings(field.field_settings);
    const fieldType: FieldType = field.type === "created_on" || field.type === "last_modified"
      ? "date"
      : field.type === "uuid"
        ? "text"
        : field.type === "autonumber"
          ? "number"
          : field.type === "ai"
            ? (sourceSettings.ai_output_type === "choice" ? "single_select" : "text")
            : field.type;
    const property: SyncProperty = {
      key: `field_${field.id}`,
      name: field.name,
      field_type: fieldType,
      source_field_type: field.type,
      unique_primary: false,
      initially_selected: true,
      field_settings: sourceSettings,
    };
    if (fieldType === "single_select") {
      property.select_options = await localSupertaskSelectOptions(db, field.id);
    }
    properties.push(property);
  }
  return properties;
}

async function fetchLocalSupertaskRows(db: D1Database, settings: Record<string, unknown>, selectedKeys: string[]) {
  const source = await localSupertaskSourceTable(db, settings);
  const view = await localSupertaskSourceView(db, source.id, settings);
  const properties = await fetchLocalSupertaskProperties(db, settings);
  const selected = new Set(selectedKeys.length > 0 ? selectedKeys : properties.map((property) => property.key));
  selected.add("id");
  const selectedProperties = properties.filter((property) => selected.has(property.key));
  const sourceFieldIds = selectedProperties
    .map((property) => property.key.match(/^field_(\d+)$/)?.[1])
    .filter((value): value is string => Boolean(value));
  const typeByKey = new Map(selectedProperties.map((property) => [property.key, property.field_type]));
  const sourceTypeByKey = new Map(selectedProperties.map((property) => [property.key, property.source_field_type || property.field_type]));
  let sourceRows: Record<string, unknown>[];
  if (view) {
    const queried = await queryViewRows(db, view, `https://internal/api/database/views/${view.type}/${view.id}/`);
    sourceRows = queried.rows;
  } else {
    const columns = ["id", "[order]", "_created_on", "_updated_on", ...sourceFieldIds.map((id) => `"field_${id}"`)];
    await ensureUserTableSystemColumns(db, source.id);
    const rows = await db.prepare(
      `SELECT ${columns.join(", ")}
       FROM "database_table_${source.id}"
       WHERE COALESCE(trashed, 0)=0
       ORDER BY [order] ASC, id ASC`
    ).all<Record<string, unknown>>();
    sourceRows = rows.results || [];
  }
  return sourceRows.map((row) => {
    const result: Record<string, unknown> = { id: row.id };
    for (const fieldId of sourceFieldIds) {
      const key = `field_${fieldId}`;
      const sourceType = sourceTypeByKey.get(key);
      const rawValue = !view && sourceType === "created_on"
        ? row._created_on
        : !view && sourceType === "last_modified"
          ? row._updated_on
          : row[key];
      result[key] = view ? rawValue : deserializeFieldValue(typeByKey.get(key) || "text", rawValue);
    }
    return result;
  });
}

function quotePgIdentifier(value: string) {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function blockedPostgresHost(host: string) {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "::1") return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1, 3).map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function postgresqlSslMode(mode: unknown) {
  const sslMode = String(mode || "prefer");
  if (sslMode === "disable") return false;
  if (sslMode === "allow" || sslMode === "prefer") return undefined;
  return { rejectUnauthorized: sslMode === "verify-full" };
}

function postgresqlFieldType(columnType: string): FieldType | null {
  const type = columnType.toLowerCase();
  if (type.includes("int") || type.includes("serial") || type.includes("real") || type.includes("double") || type.includes("numeric")) return "number";
  if (type.includes("boolean")) return "boolean";
  if (type.includes("timestamp") || type.includes("date")) return "date";
  if (type.includes("char") || type.includes("uuid")) return "text";
  if (type.includes("text")) return "long_text";
  return null;
}

function postgresqlFieldSettings(columnType: string, decimalPlaces: unknown) {
  const type = columnType.toLowerCase();
  if (type.includes("timestamp")) {
    return { date_format: "ISO", date_include_time: true, date_time_format: "24", date_show_tzinfo: true };
  }
  if (type.includes("date")) {
    return { date_format: "ISO", date_include_time: false, date_time_format: "24", date_show_tzinfo: true };
  }
  if (type.includes("int") || type.includes("serial") || type.includes("real") || type.includes("double") || type.includes("numeric")) {
    const places = Number(decimalPlaces || 0);
    return { number_decimal_places: Number.isFinite(places) ? Math.max(0, Math.min(10, places)) : 0, number_negative: true };
  }
  return undefined;
}

async function withPostgresqlClient<T>(settings: Record<string, unknown>, env: DataSyncEnv | undefined, fn: (client: any) => Promise<T>) {
  const { Client } = await import("pg");
  const host = requiredSetting(settings, "postgresql_host");
  if (blockedPostgresHost(host)) throw new ValidationError("It's not allowed to connect to this PostgreSQL hostname.");
  const port = Number(settings.postgresql_port || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("postgresql_port must be a valid TCP port.");
  const client = env?.HYPERDRIVE?.connectionString
    ? new Client({ connectionString: env.HYPERDRIVE.connectionString })
    : new Client({
      host,
      user: requiredSetting(settings, "postgresql_username"),
      password: requiredSetting(settings, "postgresql_password"),
      port,
      database: requiredSetting(settings, "postgresql_database"),
      ssl: postgresqlSslMode(settings.postgresql_sslmode),
      application_name: "Supertask Data Sync",
    });
  try {
    await client.connect();
    return await fn(client);
  } catch (error: any) {
    throw new ValidationError(error?.message ? String(error.message) : "Unable to connect to PostgreSQL.");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function fetchPostgresqlMetadata(settings: Record<string, unknown>, env?: DataSyncEnv) {
  const schema = String(settings.postgresql_schema || "public");
  const table = requiredSetting(settings, "postgresql_table");
  return withPostgresqlClient(settings, env, async (client) => {
    const exists = await client.query(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2
       ) AS exists`,
      [schema, table]
    );
    if (!exists.rows?.[0]?.exists) throw new ValidationError(`The table ${table} does not exist.`);

    const primary = await client.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position ASC`,
      [schema, table]
    );
    const primaryColumns = new Set((primary.rows || []).map((row: any) => String(row.column_name)));
    const columns = await client.query(
      `SELECT column_name, data_type, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position ASC`,
      [schema, table]
    );
    return { schema, table, primaryColumns, columns: columns.rows || [] };
  });
}

async function fetchPostgresqlProperties(settings: Record<string, unknown>, env?: DataSyncEnv): Promise<SyncProperty[]> {
  const metadata = await fetchPostgresqlMetadata(settings, env);
  const properties: Array<SyncProperty | null> = metadata.columns
    .map((column: any) => {
      const fieldType = postgresqlFieldType(String(column.data_type || ""));
      if (!fieldType) return null;
      const key = String(column.column_name);
      return {
        key,
        name: key,
        field_type: fieldType,
        unique_primary: metadata.primaryColumns.has(key),
        initially_selected: true,
        immutable_properties: fieldType !== "number" && fieldType !== "date",
        field_settings: postgresqlFieldSettings(String(column.data_type || ""), column.numeric_scale),
      } as SyncProperty;
    });
  return properties.filter((property: SyncProperty | null): property is SyncProperty => Boolean(property));
}

function normalizePostgresqlRowValue(value: unknown, property: SyncProperty) {
  if (value === null || value === undefined) return null;
  if (property.field_type === "boolean") return Boolean(value);
  if (property.field_type === "number") return Number(value);
  if (property.field_type === "date") {
    const parsed = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toISOString();
  }
  return String(value);
}

async function fetchPostgresqlRows(settings: Record<string, unknown>, selectedKeys: string[], env?: DataSyncEnv) {
  const properties = await fetchPostgresqlProperties(settings, env);
  const selected = new Set(selectedKeys.length > 0 ? selectedKeys : properties.map((property: SyncProperty) => property.key));
  const selectedProperties = properties.filter((property: SyncProperty) => selected.has(property.key));
  const orderProperties = selectedProperties.filter((property: SyncProperty) => property.unique_primary);
  if (selectedProperties.length === 0) return [];
  const metadata = await fetchPostgresqlMetadata(settings, env);
  const columns = selectedProperties.map((property: SyncProperty) => quotePgIdentifier(property.key)).join(", ");
  const order = orderProperties.length > 0
    ? ` ORDER BY ${orderProperties.map((property: SyncProperty) => quotePgIdentifier(property.key)).join(", ")}`
    : "";
  const sql = `SELECT ${columns} FROM ${quotePgIdentifier(metadata.schema)}.${quotePgIdentifier(metadata.table)}${order}`;
  return withPostgresqlClient(settings, env, async (client) => {
    const result = await client.query(sql);
    return (result.rows || []).map((row: Record<string, unknown>) => Object.fromEntries(
      selectedProperties.map((property: SyncProperty) => [property.key, normalizePostgresqlRowValue(row[property.key], property)])
    ));
  });
}

type PostgresqlTwoWayProperty = {
  key: string;
  field_id: number;
  type: FieldType;
  unique_primary: boolean;
};

type PostgresqlTwoWayContext = {
  dataSync: DataSyncRow;
  settings: Record<string, unknown>;
  schema: string;
  table: string;
  properties: PostgresqlTwoWayProperty[];
  primaryProperties: PostgresqlTwoWayProperty[];
};

function pgParam(index: number) {
  return `$${index}`;
}

function hasPrimaryValue(value: unknown) {
  return value !== null && value !== undefined && value !== "";
}

function postgresqlValueForType(type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (type === "number" || type === "rating" || type === "count" || type === "duration" || type === "autonumber" || type === "auto_number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (type === "boolean") return Boolean(value);
  if (type === "date") {
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function postgresqlValueForRow(row: Record<string, unknown>, property: PostgresqlTwoWayProperty) {
  return postgresqlValueForType(
    property.type,
    deserializeFieldValue(property.type, row[`field_${property.field_id}`])
  );
}

function primaryValuesForRow(row: Record<string, unknown>, properties: PostgresqlTwoWayProperty[]) {
  const values = properties.map((property) => postgresqlValueForRow(row, property));
  return values.every(hasPrimaryValue) ? values : null;
}

async function postgresqlTwoWayContext(env: DataSyncRuntimeEnv, tableId: number): Promise<PostgresqlTwoWayContext | null> {
  const dataSync = await env.DB.prepare(
    `SELECT *
       FROM database_datasync
      WHERE table_id=?
        AND type='postgresql'
        AND two_way_sync=1
        AND authorized=1
        AND COALESCE(deactivated, 0)=0
      LIMIT 1`
  ).bind(tableId).first<DataSyncRow>();
  if (!dataSync) return null;

  const settings = parseSettings(dataSync);
  const rows = await env.DB.prepare(
    `SELECT dsp.key, dsp.field_id, dsp.unique_primary, f.type
       FROM database_datasyncsyncedproperty dsp
       JOIN database_field f ON f.id=dsp.field_id
      WHERE dsp.data_sync_id=?
      ORDER BY dsp.id ASC`
  ).bind(dataSync.id).all<{ key: string; field_id: number; unique_primary: number; type: FieldType }>();
  const properties = (rows.results || [])
    .filter((property) => Number.isInteger(Number(property.field_id)) && property.field_id > 0)
    .map((property) => ({
      key: String(property.key),
      field_id: Number(property.field_id),
      type: property.type,
      unique_primary: Boolean(property.unique_primary),
    }));
  const primaryProperties = properties.filter((property) => property.unique_primary);
  if (primaryProperties.length === 0 || properties.length === 0) return null;

  return {
    dataSync,
    settings,
    schema: String(settings.postgresql_schema || "public"),
    table: requiredSetting(settings, "postgresql_table"),
    properties,
    primaryProperties,
  };
}

async function notifyTwoWaySyncUpdateFailed(env: DataSyncRuntimeEnv, dataSyncId: number, error: string) {
  const context = await dataSyncNotificationContext(env.DB, dataSyncId);
  if (!context) return;
  const adminIds = await workspaceAdminIdsForDataSync(env.DB, dataSyncId);
  await createDirectNotificationForUsers(env.DB, {
    type: "two_way_sync_update_failed",
    recipientIds: adminIds,
    workspaceId: context.workspace_id,
    data: {
      data_sync_id: context.data_sync_id,
      table_name: context.table_name,
      table_id: context.table_id,
      database_id: context.database_id,
      error,
    },
  });
}

async function notifyTwoWaySyncDeactivated(env: DataSyncRuntimeEnv, dataSyncId: number) {
  const context = await dataSyncNotificationContext(env.DB, dataSyncId);
  if (!context) return;
  const adminIds = await workspaceAdminIdsForDataSync(env.DB, dataSyncId);
  await createDirectNotificationForUsers(env.DB, {
    type: "two_way_sync_deactivated",
    recipientIds: adminIds,
    workspaceId: context.workspace_id,
    data: {
      data_sync_id: context.data_sync_id,
      table_name: context.table_name,
      table_id: context.table_id,
      database_id: context.database_id,
    },
  });
}

async function markPostgresqlTwoWaySuccess(env: DataSyncRuntimeEnv, dataSyncId: number) {
  await env.DB.prepare(
    `UPDATE database_datasync
        SET last_error=NULL,
            two_way_sync_consecutive_failures=0,
            updated_on=?
      WHERE id=?`
  ).bind(new Date().toISOString(), dataSyncId).run();
}

async function markPostgresqlTwoWayFailure(env: DataSyncRuntimeEnv, dataSync: DataSyncRow, error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "PostgreSQL two-way sync failed.");
  const failures = Number(dataSync.two_way_sync_consecutive_failures || 0) + 1;
  const deactivate = failures >= TWO_WAY_SYNC_FAILURE_LIMIT;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE database_datasync
        SET last_error=?,
            two_way_sync_consecutive_failures=?,
            two_way_sync=CASE WHEN ? THEN 0 ELSE two_way_sync END,
            updated_on=?
      WHERE id=?`
  ).bind(message, failures, deactivate ? 1 : 0, now, dataSync.id).run();
  await notifyTwoWaySyncUpdateFailed(env, dataSync.id, message);
  if (deactivate) {
    await env.DB.prepare(
      `UPDATE database_field
          SET read_only=1,
              updated_on=?
        WHERE id IN (
          SELECT field_id
            FROM database_datasyncsyncedproperty
           WHERE data_sync_id=?
             AND unique_primary=0
             AND field_id IS NOT NULL
        )`
    ).bind(now, dataSync.id).run();
    await notifyTwoWaySyncDeactivated(env, dataSync.id);
  }
}

async function runPostgresqlTwoWay(
  env: DataSyncRuntimeEnv,
  tableId: number,
  fn: (context: PostgresqlTwoWayContext) => Promise<void>
) {
  const context = await postgresqlTwoWayContext(env, tableId);
  if (!context) return;
  try {
    await fn(context);
    await markPostgresqlTwoWaySuccess(env, context.dataSync.id);
  } catch (error) {
    await markPostgresqlTwoWayFailure(env, context.dataSync, error);
  }
}

async function updateLocalPrimaryValues(
  env: DataSyncRuntimeEnv,
  context: PostgresqlTwoWayContext,
  localRow: Record<string, unknown>,
  returned: Record<string, unknown>
) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const property of context.primaryProperties) {
    if (!Object.prototype.hasOwnProperty.call(returned, property.key)) continue;
    sets.push(`"field_${property.field_id}"=?`);
    values.push(serializeFieldValueForInsert(
      property.type,
      postgresqlValueForType(property.type, returned[property.key])
    ));
  }
  if (sets.length === 0) return;
  values.push(localRow.id);
  await ensureUserTableSystemColumns(env.DB, Number(context.dataSync.table_id));
  await env.DB.prepare(`UPDATE "database_table_${context.dataSync.table_id}" SET ${sets.join(", ")} WHERE id=? AND COALESCE(trashed, 0)=0`)
    .bind(...values)
    .run();
}

export async function pushPostgresqlTwoWayRowsCreated(
  env: DataSyncRuntimeEnv,
  tableId: number,
  rows: Record<string, unknown>[]
) {
  if (rows.length === 0) return;
  await runPostgresqlTwoWay(env, tableId, async (context) => {
    const writableProperties = context.properties.filter((property) => !property.unique_primary);
    const returning = context.primaryProperties.map((property) => quotePgIdentifier(property.key)).join(", ");
    await withPostgresqlClient(context.settings, env, async (client) => {
      for (const row of rows) {
        let query: string;
        let params: unknown[] = [];
        if (writableProperties.length === 0) {
          query = `INSERT INTO ${quotePgIdentifier(context.schema)}.${quotePgIdentifier(context.table)} DEFAULT VALUES RETURNING ${returning}`;
        } else {
          params = writableProperties.map((property) => postgresqlValueForRow(row, property));
          query = `INSERT INTO ${quotePgIdentifier(context.schema)}.${quotePgIdentifier(context.table)} ` +
            `(${writableProperties.map((property) => quotePgIdentifier(property.key)).join(", ")}) ` +
            `VALUES (${params.map((_, index) => pgParam(index + 1)).join(", ")}) RETURNING ${returning}`;
        }
        const result = await client.query(query, params);
        const returned = result.rows?.[0];
        if (returned) await updateLocalPrimaryValues(env, context, row, returned);
      }
    });
  });
}

export async function pushPostgresqlTwoWayRowsUpdated(
  env: DataSyncRuntimeEnv,
  tableId: number,
  rows: Record<string, unknown>[],
  updatedFieldIds: Iterable<number>
) {
  const updated = new Set([...updatedFieldIds].map(Number));
  if (rows.length === 0 || updated.size === 0) return;
  await runPostgresqlTwoWay(env, tableId, async (context) => {
    const updateProperties = context.properties.filter((property) => !property.unique_primary && updated.has(property.field_id));
    if (updateProperties.length === 0) return;
    await withPostgresqlClient(context.settings, env, async (client) => {
      for (const row of rows) {
        const primaryValues = primaryValuesForRow(row, context.primaryProperties);
        if (!primaryValues) continue;
        const params = updateProperties.map((property) => postgresqlValueForRow(row, property));
        const whereStart = params.length + 1;
        params.push(...primaryValues);
        const setClause = updateProperties
          .map((property, index) => `${quotePgIdentifier(property.key)} = ${pgParam(index + 1)}`)
          .join(", ");
        const whereClause = context.primaryProperties
          .map((property, index) => `${quotePgIdentifier(property.key)} = ${pgParam(whereStart + index)}`)
          .join(" AND ");
        await client.query(
          `UPDATE ${quotePgIdentifier(context.schema)}.${quotePgIdentifier(context.table)} SET ${setClause} WHERE ${whereClause}`,
          params
        );
      }
    });
  });
}

export async function pushPostgresqlTwoWayRowsDeleted(
  env: DataSyncRuntimeEnv,
  tableId: number,
  rows: Record<string, unknown>[]
) {
  if (rows.length === 0) return;
  await runPostgresqlTwoWay(env, tableId, async (context) => {
    await withPostgresqlClient(context.settings, env, async (client) => {
      for (const row of rows) {
        const primaryValues = primaryValuesForRow(row, context.primaryProperties);
        if (!primaryValues) continue;
        const whereClause = context.primaryProperties
          .map((property, index) => `${quotePgIdentifier(property.key)} = ${pgParam(index + 1)}`)
          .join(" AND ");
        await client.query(
          `DELETE FROM ${quotePgIdentifier(context.schema)}.${quotePgIdentifier(context.table)} WHERE ${whereClause}`,
          primaryValues
        );
      }
    });
  });
}

function dataSyncNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapGithubIssue(issue: Record<string, any>, owner: string, repo: string) {
  const issueNumber = dataSyncNumber(issue.number);
  return {
    id: issueNumber,
    title: String(issue.title || ""),
    body: issue.body === null || issue.body === undefined ? "" : String(issue.body),
    user: issue.user?.login ? String(issue.user.login) : "",
    assignee: issue.assignee?.login ? String(issue.assignee.login) : "",
    assignees: commaNames(issue.assignees, "login"),
    labels: commaNames(issue.labels, "name"),
    state: String(issue.state || ""),
    created_at: issue.created_at || null,
    updated_at: issue.updated_at || null,
    closed_at: issue.closed_at || null,
    closed_by: issue.closed_by?.login ? String(issue.closed_by.login) : "",
    milestone: issue.milestone?.title ? String(issue.milestone.title) : "",
    url: issueNumber !== null ? `https://github.com/${owner}/${repo}/issues/${issueNumber}` : String(issue.html_url || ""),
  };
}

async function fetchGithubIssues(settings: Record<string, unknown>) {
  const owner = requiredSetting(settings, "github_issues_owner");
  const repo = requiredSetting(settings, "github_issues_repo");
  const token = String(settings.github_issues_api_token || "").trim();
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const rows: Record<string, unknown>[] = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({ page: String(page), per_page: "50", state: "all" });
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Supertask-DataSync",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await dataSyncFetch(`${url}?${params.toString()}`, { headers });
    if (response.status === 401 || response.status === 403) {
      throw new PermissionError("GitHub rejected the provided credentials.");
    }
    if (!response.ok) throw new ValidationError(`Unable to fetch GitHub issues (${response.status}).`);
    const data = await response.json<any[]>();
    if (!Array.isArray(data)) throw new ValidationError("GitHub issues response must be an array.");
    if (data.length === 0) break;
    for (const issue of data) {
      if (!issue || typeof issue !== "object" || issue.pull_request) continue;
      rows.push(mapGithubIssue(issue, owner, repo));
    }
    page += 1;
  }
  return rows;
}

async function fetchRowsForDataSync(db: D1Database, type: string, settings: Record<string, unknown>, selectedKeys: string[] = [], env?: DataSyncEnv) {
  if (type === "ical_calendar") return fetchIcal(settings);
  if (type === "postgresql") return fetchPostgresqlRows(settings, selectedKeys, env);
  if (type === "local_supertask_table") return fetchLocalSupertaskRows(db, settings, selectedKeys);
  if (type === "github_issues") return fetchGithubIssues(settings);
  throw new ValidationError(`Unsupported data sync type: ${type}`);
}

export function dataSyncSupportsTwoWay(type: string) {
  return type === "postgresql";
}

export function assertDataSyncTwoWaySupported(type: string, requested: unknown) {
  if (requested && !dataSyncSupportsTwoWay(type)) {
    throw new ValidationError("Two-way sync is not supported for this data sync type.");
  }
}

export function normalizePeriodicInterval(value: unknown): string | null {
  const interval = String(value || "").trim();
  return ["hour", "day", "week", "month"].includes(interval) ? interval : null;
}

export function normalizePeriodicIntervalCount(value: unknown): number {
  const count = Number(value || 1);
  return Number.isInteger(count) && count > 0 ? Math.min(count, 365) : 1;
}

export function nextPeriodicSync(interval: string | null, count: number, from = new Date()) {
  if (!interval) return null;
  const ms =
    interval === "hour" ? count * 60 * 60 * 1000 :
      interval === "week" ? count * 7 * 24 * 60 * 60 * 1000 :
        interval === "month" ? count * 30 * 24 * 60 * 60 * 1000 :
          count * 24 * 60 * 60 * 1000;
  return new Date(from.getTime() + ms).toISOString();
}

async function workspaceAdminIdsForDataSync(db: D1Database, dataSyncId: number) {
  const rows = await db.prepare(
    `SELECT DISTINCT wu.user_id
       FROM database_datasync ds
       JOIN database_table t ON t.id=ds.table_id
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspaceuser wu ON wu.workspace_id=a.workspace_id
      WHERE ds.id=?
        AND wu.to_be_deleted=0
        AND wu.permissions='ADMIN'`
  ).bind(dataSyncId).all<{ user_id: number }>();
  return (rows.results || []).map((row) => Number(row.user_id)).filter((id) => Number.isInteger(id) && id > 0);
}

async function dataSyncNotificationContext(db: D1Database, dataSyncId: number) {
  return db.prepare(
    `SELECT ds.id AS data_sync_id, ds.table_id, t.name AS table_name, t.database_id, a.workspace_id
       FROM database_datasync ds
       JOIN database_table t ON t.id=ds.table_id
       JOIN core_application a ON a.id=t.database_id
      WHERE ds.id=?`
  ).bind(dataSyncId).first<{
    data_sync_id: number;
    table_id: number;
    table_name: string;
    database_id: number;
    workspace_id: number;
  }>();
}

async function notifyPeriodicDataSyncDeactivated(db: D1Database, dataSyncId: number, reason: string) {
  const context = await dataSyncNotificationContext(db, dataSyncId);
  if (!context) return;
  const adminIds = await workspaceAdminIdsForDataSync(db, dataSyncId);
  await createDirectNotificationForUsers(db, {
    type: "periodic_data_sync_deactivated",
    recipientIds: adminIds,
    workspaceId: context.workspace_id,
    data: {
      data_sync_id: context.data_sync_id,
      table_name: context.table_name,
      table_id: context.table_id,
      database_id: context.database_id,
      deactivation_reason: reason,
    },
  });
}

async function insertDataSyncSelectOptions(
  db: D1Database,
  dataSyncId: number,
  fieldId: number,
  options: Array<{ id?: string; value: string; color: string; order: number }>
) {
  if (options.length === 0) return;
  for (const [index, option] of options.entries()) {
    const inserted = await db.prepare(
      `INSERT INTO database_selectoption (field_id, value, color, [order])
       VALUES (?, ?, ?, ?) RETURNING id`
    ).bind(
      fieldId,
      option.value,
      option.color || "light-blue",
      Number.isFinite(option.order) ? option.order : index + 1
    ).first<{ id: number }>();
    if (inserted && option.id !== undefined) {
      await db.prepare(
        `INSERT INTO database_datasyncselectoptionmapping
         (data_sync_id, field_id, source_option_id, destination_option_id)
         VALUES (?, ?, ?, ?)`
      ).bind(dataSyncId, fieldId, String(option.id), inserted.id).run();
    }
  }
}

function uniqueDataSyncPropertyKeys(keys: unknown[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    const normalized = String(key);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function existingDataSyncPropertyKeys(db: D1Database, dataSyncId: number) {
  const rows = await db.prepare(
    "SELECT key FROM database_datasyncsyncedproperty WHERE data_sync_id=? ORDER BY id ASC"
  ).bind(dataSyncId).all<{ key: string }>();
  return (rows.results || []).map((row) => row.key);
}

async function dataSyncAvailableProperties(db: D1Database, dataSync: DataSyncRow, env?: DataSyncEnv) {
  const settings = parseSettings(dataSync);
  if (dataSync.type === "postgresql") return fetchPostgresqlProperties(settings, env);
  if (dataSync.type === "local_supertask_table") return fetchLocalSupertaskProperties(db, settings);
  return getDataSyncProperties(dataSync.type);
}

async function nextUnusedDataSyncFieldName(db: D1Database, tableId: number, name: string) {
  const rows = await db.prepare(
    "SELECT name FROM database_field WHERE table_id=? AND trashed=0"
  ).bind(tableId).all<{ name: string }>();
  const existing = new Set((rows.results || []).map((row) => row.name));
  if (!existing.has(name)) return name;
  let suffix = 2;
  while (existing.has(`${name} ${suffix}`)) suffix += 1;
  return `${name} ${suffix}`;
}

async function replaceDataSyncSelectOptions(db: D1Database, dataSyncId: number, fieldId: number, property: SyncProperty) {
  await db.prepare("DELETE FROM database_datasyncselectoptionmapping WHERE field_id=?").bind(fieldId).run();
  await db.prepare("DELETE FROM database_selectoption WHERE field_id=?").bind(fieldId).run();
  if ((property.field_type === "single_select" || property.field_type === "multiple_select") && property.select_options) {
    await insertDataSyncSelectOptions(db, dataSyncId, fieldId, property.select_options);
  }
}

async function createDataSyncField(
  db: D1Database,
  dataSync: DataSyncRow,
  property: SyncProperty,
  order: number,
  hasPrimary: boolean
) {
  const now = new Date().toISOString();
  const name = await nextUnusedDataSyncFieldName(db, dataSync.table_id, property.name);
  const primary = property.unique_primary && !hasPrimary;
  const readOnly = property.unique_primary || !Boolean(dataSync.two_way_sync);
  const field = await db.prepare(
    `INSERT INTO database_field (table_id, name, type, [order], "primary", read_only, trashed,
     field_settings, created_on, updated_on, db_index, immutable_type, immutable_properties)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?) RETURNING id`
  ).bind(
    dataSync.table_id,
    name,
    property.field_type,
    order,
    primary ? 1 : 0,
    readOnly ? 1 : 0,
    property.field_settings ? JSON.stringify(property.field_settings) : "{}",
    now,
    now,
    property.unique_primary ? 1 : 0,
    property.immutable_properties === false ? 0 : 1
  ).first<{ id: number }>();
  if (!field) throw new Error("Failed to create data sync field");
  await addFieldColumn(db, dataSync.table_id, { id: field.id, type: property.field_type, primary });
  await replaceDataSyncSelectOptions(db, dataSync.id, field.id, property);
  return field.id;
}

async function updateDataSyncField(
  db: D1Database,
  dataSync: DataSyncRow,
  row: DataSyncSyncedPropertyRow,
  property: SyncProperty,
  hasPrimary: boolean
) {
  if (!row.field_id) return createDataSyncField(db, dataSync, property, Number(row.id || 1), hasPrimary);
  const now = new Date().toISOString();
  const primary = property.unique_primary ? (Boolean(row.field_primary) || !hasPrimary) : false;
  const readOnly = property.unique_primary || !Boolean(dataSync.two_way_sync);
  await db.prepare(
    `UPDATE database_field
        SET name=?,
            type=?,
            read_only=?,
            "primary"=?,
            field_settings=?,
            db_index=?,
            immutable_type=1,
            immutable_properties=?,
            updated_on=?
      WHERE id=?`
  ).bind(
    property.name,
    property.field_type,
    readOnly ? 1 : 0,
    primary ? 1 : 0,
    property.field_settings ? JSON.stringify(property.field_settings) : "{}",
    property.unique_primary ? 1 : 0,
    property.immutable_properties === false ? 0 : 1,
    now,
    row.field_id
  ).run();
  await replaceDataSyncSelectOptions(db, dataSync.id, row.field_id, property);
  return row.field_id;
}

export async function updateDataSyncSyncedProperties(
  db: D1Database,
  dataSyncId: number,
  requestedProperties?: unknown,
  env?: DataSyncEnv,
  availablePropertiesOverride?: SyncProperty[]
) {
  const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE id=?").bind(dataSyncId).first<DataSyncRow>();
  if (!dataSync) throw new DoesNotExist("Data sync", dataSyncId);
  if (requestedProperties !== undefined && !Array.isArray(requestedProperties)) {
    throw new ValidationError("synced_properties must be a list.");
  }

  const availableProperties = availablePropertiesOverride || await dataSyncAvailableProperties(db, dataSync, env);
  const availableByKey = new Map(availableProperties.map((property) => [property.key, property]));
  const rawKeys = requestedProperties === undefined
    ? await existingDataSyncPropertyKeys(db, dataSyncId)
    : requestedProperties;
  const selectedKeys = uniqueDataSyncPropertyKeys(rawKeys);
  const invalidKey = selectedKeys.find((key) => !availableByKey.has(key));
  if (invalidKey) {
    throw new ApiError(400, "ERROR_PROPERTY_NOT_FOUND", `The property ${invalidKey} is not found for the data sync type.`);
  }
  if (!availableProperties.some((property) => property.unique_primary)) {
    throw new ApiError(
      400,
      "ERROR_UNIQUE_PRIMARY_PROPERTY_NOT_FOUND",
      "The configured data sync does not have a unique primary column to identify the row."
    );
  }
  for (const property of availableProperties) {
    if (property.unique_primary && !selectedKeys.includes(property.key)) selectedKeys.unshift(property.key);
  }

  const rows = await db.prepare(
    `SELECT dsp.id, dsp.field_id, dsp.key, dsp.unique_primary,
            f.type AS field_type, f.name AS field_name, f.field_settings,
            f."primary" AS field_primary, f.read_only
       FROM database_datasyncsyncedproperty dsp
       LEFT JOIN database_field f ON f.id=dsp.field_id
      WHERE dsp.data_sync_id=?
      ORDER BY dsp.id ASC`
  ).bind(dataSyncId).all<DataSyncSyncedPropertyRow>();
  const existing = rows.results || [];
  const existingByKey = new Map(existing.map((row) => [row.key, row]));
  const selected = new Set(selectedKeys);

  for (const row of existing) {
    if (selected.has(row.key)) continue;
    await db.prepare("DELETE FROM database_datasyncsyncedproperty WHERE id=?").bind(row.id).run();
    if (row.field_id) {
      await db.prepare("DELETE FROM database_selectoption WHERE field_id=?").bind(row.field_id).run();
      await dropFieldColumn(db, dataSync.table_id, row.field_id);
      await db.prepare("DELETE FROM database_field WHERE id=?").bind(row.field_id).run();
    }
  }

  let maxOrder = await db.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM database_field WHERE table_id=?"
  ).bind(dataSync.table_id).first<{ max_order: number }>();
  let order = Number(maxOrder?.max_order || 0) + 1;
  let primaryRow = await db.prepare(
    "SELECT id FROM database_field WHERE table_id=? AND trashed=0 AND \"primary\"=1 LIMIT 1"
  ).bind(dataSync.table_id).first<{ id: number }>();
  let hasPrimary = Boolean(primaryRow);

  for (const key of selectedKeys) {
    const property = availableByKey.get(key);
    if (!property) continue;
    const existingRow = existingByKey.get(key);
    if (existingRow) {
      const fieldId = await updateDataSyncField(db, dataSync, existingRow, property, hasPrimary);
      hasPrimary = hasPrimary || property.unique_primary;
      await db.prepare(
        `UPDATE database_datasyncsyncedproperty
            SET field_id=?, unique_primary=?
          WHERE id=?`
      ).bind(fieldId, property.unique_primary ? 1 : 0, existingRow.id).run();
      continue;
    }

    const fieldId = await createDataSyncField(db, dataSync, property, order, hasPrimary);
    hasPrimary = hasPrimary || property.unique_primary;
    await db.prepare(
      "INSERT INTO database_datasyncsyncedproperty (data_sync_id, field_id, key, unique_primary) VALUES (?, ?, ?, ?)"
    ).bind(dataSync.id, fieldId, property.key, property.unique_primary ? 1 : 0).run();
    order += 1;
  }
}

type ActiveDataSyncProperty = {
  key: string;
  field_id: number;
  unique_primary: number;
  type: FieldType;
};

function hasDataSyncPrimaryValue(value: unknown) {
  return value !== null && value !== undefined && value !== "";
}

function dataSyncPrimaryKey(row: Record<string, unknown>, properties: ActiveDataSyncProperty[]) {
  const values = properties.map((property) => row[`field_${property.field_id}`]);
  return values.every(hasDataSyncPrimaryValue) ? JSON.stringify(values) : null;
}

function storedDataSyncValuesEqual(left: unknown, right: unknown) {
  if (left === right) return true;
  if ((left === null || left === undefined) && (right === null || right === undefined)) return true;
  return false;
}

async function removeDataSyncRow(db: D1Database, tableId: number, rowId: number) {
  await db.prepare("DELETE FROM database_rowcomment WHERE table_id=? AND row_id=?").bind(tableId, rowId).run().catch(() => undefined);
  await db.prepare("DELETE FROM database_rowcommentsnotificationmode WHERE table_id=? AND row_id=?").bind(tableId, rowId).run().catch(() => undefined);
  await db.prepare("DELETE FROM database_rowhistory WHERE table_id=? AND row_id=?").bind(tableId, rowId).run();
  await db.prepare(`DELETE FROM "database_table_${tableId}" WHERE id=?`).bind(rowId).run();
}

async function applyDataSyncRows(
  db: D1Database,
  dataSync: DataSyncRow,
  properties: ActiveDataSyncProperty[],
  rows: Record<string, unknown>[],
  now: string
) {
  const tableName = `database_table_${dataSync.table_id}`;
  const primaryProperties = properties.filter((property) => Boolean(property.unique_primary));
  if (primaryProperties.length === 0) {
    throw new ValidationError("The configured data sync does not have a unique primary column to identify the row.");
  }

  const incomingByPrimary = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const stored: Record<string, unknown> = {};
    for (const property of properties) {
      const value = await normalizeDataSyncValueForInsert(db, property, row[property.key] ?? null);
      stored[`field_${property.field_id}`] = serializeFieldValueForInsert(property.type, value);
    }
    const primaryValues = primaryProperties.map((property) => stored[`field_${property.field_id}`]);
    incomingByPrimary.set(JSON.stringify(primaryValues), stored);
  }

  const existingResult = await db.prepare(
    `SELECT * FROM "${tableName}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC`
  ).all<Record<string, unknown>>();
  const existingByPrimary = new Map<string, Record<string, unknown>>();
  const danglingRows: Record<string, unknown>[] = [];
  for (const row of existingResult.results || []) {
    const key = dataSyncPrimaryKey(row, primaryProperties);
    if (key === null) danglingRows.push(row);
    else existingByPrimary.set(key, row);
  }

  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;
  const maxOrder = (existingResult.results || []).reduce(
    (maximum, row) => Math.max(maximum, Number(row.order || 0)),
    0
  );
  let nextOrder = maxOrder + 10000;

  for (const [key, stored] of incomingByPrimary.entries()) {
    const existing = existingByPrimary.get(key);
    if (!existing) {
      const columns = ["[order]", "_created_on", "_updated_on", ...properties.map((property) => `"field_${property.field_id}"`)];
      const values = [nextOrder, now, now, ...properties.map((property) => stored[`field_${property.field_id}`])];
      await db.prepare(
        `INSERT INTO "${tableName}" (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
      ).bind(...values).run();
      nextOrder += 10000;
      createdCount += 1;
      continue;
    }

    const changedProperties = properties.filter((property) => {
      const column = `field_${property.field_id}`;
      return !storedDataSyncValuesEqual(existing[column], stored[column]);
    });
    if (changedProperties.length > 0) {
      const sets = [...changedProperties.map((property) => `"field_${property.field_id}"=?`), "_updated_on=?"];
      const values = [...changedProperties.map((property) => stored[`field_${property.field_id}`]), now, existing.id];
      await db.prepare(`UPDATE "${tableName}" SET ${sets.join(", ")} WHERE id=?`).bind(...values).run();
      updatedCount += 1;
    }
    existingByPrimary.delete(key);
  }

  for (const row of [...existingByPrimary.values(), ...danglingRows]) {
    await removeDataSyncRow(db, Number(dataSync.table_id), Number(row.id));
    deletedCount += 1;
  }

  return { created_count: createdCount, updated_count: updatedCount, deleted_count: deletedCount };
}

async function normalizeDataSyncValueForInsert(
  db: D1Database,
  property: { field_id: number; type: FieldType },
  value: unknown
) {
  if (value === null || value === undefined) return value;
  if (property.type !== "single_select" && property.type !== "multiple_select") return value;
  const normalizeOption = async (candidate: unknown) => {
    const sourceOptionId = candidate && typeof candidate === "object"
      ? String((candidate as Record<string, unknown>).id ?? "")
      : "";
    const optionValue = candidate && typeof candidate === "object"
      ? String((candidate as Record<string, unknown>).value ?? "")
      : String(candidate);
    const mapped = sourceOptionId ? await db.prepare(
      `SELECT so.id, so.value, so.color
         FROM database_datasyncselectoptionmapping m
         JOIN database_selectoption so ON so.id=m.destination_option_id
        WHERE m.field_id=? AND m.source_option_id=?`
    ).bind(property.field_id, sourceOptionId).first<{ id: number; value: string; color: string }>() : null;
    const option = mapped || await db.prepare(
      "SELECT id, value, color FROM database_selectoption WHERE field_id=? AND value=? ORDER BY [order] ASC, id ASC LIMIT 1"
    ).bind(property.field_id, optionValue).first<{ id: number; value: string; color: string }>();
    return option ? { id: option.id, value: option.value, color: option.color || "light-blue" } : null;
  };
  if (property.type === "multiple_select") {
    const values = Array.isArray(value) ? value : [];
    const normalized = await Promise.all(values.map(normalizeOption));
    return normalized.filter(Boolean);
  }
  return normalizeOption(value);
}

export async function listPropertiesForRequest(body: Record<string, unknown>, env?: DataSyncEnv, db?: D1Database) {
  const type = String(body.type || "");
  if (type === "ical_calendar") await fetchRowsForDataSync(db as D1Database, type, body, [], env);
  if (type === "postgresql") return fetchPostgresqlProperties(body, env);
  if (type === "local_supertask_table") {
    if (!db) throw new ValidationError("A database binding is required to inspect a local Supertask table.");
    return fetchLocalSupertaskProperties(db, body);
  }
  return getDataSyncProperties(type);
}

export async function createDataSyncTable(
  db: D1Database,
  databaseId: number,
  body: Record<string, unknown>,
  env?: DataSyncEnv,
  authorizedUserId?: number | null
) {
  const type = String(body.type || "");
  assertDataSyncTwoWaySupported(type, body.two_way_sync);
  const available: SyncProperty[] = type === "postgresql"
      ? await fetchPostgresqlProperties(body, env)
      : type === "local_supertask_table"
        ? await fetchLocalSupertaskProperties(db, body)
      : getDataSyncProperties(type);
  const requestedKeys = uniqueDataSyncPropertyKeys(Array.isArray(body.synced_properties) ? body.synced_properties : []);
  const availableByKey = new Map(available.map((property) => [property.key, property]));
  const invalidKey = requestedKeys.find((key) => !availableByKey.has(key));
  if (invalidKey) {
    throw new ApiError(400, "ERROR_PROPERTY_NOT_FOUND", `The property ${invalidKey} is not found for the data sync type.`);
  }
  if (!available.some((property) => property.unique_primary)) {
    throw new ApiError(
      400,
      "ERROR_UNIQUE_PRIMARY_PROPERTY_NOT_FOUND",
      "The configured data sync does not have a unique primary column to identify the row."
    );
  }
  const selectedKeys = new Set(requestedKeys);
  for (const property of available.filter((p: SyncProperty) => p.unique_primary)) selectedKeys.add(property.key);
  if (selectedKeys.size === 0) throw new ValidationError("synced_properties is required.");
  if (type === "ical_calendar" || type === "github_issues" || type === "postgresql" || type === "local_supertask_table") {
    await fetchRowsForDataSync(db, type, body, Array.from(selectedKeys), env);
  }
  const twoWaySync = Boolean(body.two_way_sync);

  const now = new Date().toISOString();
  const periodicInterval = normalizePeriodicInterval(body.periodic_interval);
  const periodicIntervalCount = normalizePeriodicIntervalCount(body.periodic_interval_count);
  const maxOrder = await db.prepare("SELECT COALESCE(MAX([order]), 0) AS max_order FROM database_table WHERE database_id=?")
    .bind(databaseId)
    .first<{ max_order: number }>();
  const table = await db.prepare(
    `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (?, ?, ?, 1, 0, ?, ?, 0, 0, 0) RETURNING *`
  ).bind(databaseId, String(body.table_name || "Synced table"), (maxOrder?.max_order || 0) + 1, now, now).first<any>();
  if (!table) throw new Error("Failed to create data sync table");
  await getOrCreateUserTable(db, table.id);

  const dataSync = await db.prepare(
    `INSERT INTO database_datasync
     (table_id, type, settings, auto_add_new_properties, two_way_sync, authorized,
      authorized_user_id, periodic_interval, periodic_interval_count, next_periodic_sync, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    table.id,
    type,
    JSON.stringify(body),
    body.auto_add_new_properties ? 1 : 0,
    twoWaySync ? 1 : 0,
    Number.isInteger(Number(authorizedUserId)) && Number(authorizedUserId) > 0 ? Number(authorizedUserId) : null,
    periodicInterval,
    periodicIntervalCount,
    nextPeriodicSync(periodicInterval, periodicIntervalCount),
    now,
    now
  ).first<DataSyncRow>();
  await db.prepare("UPDATE database_table SET data_sync_id=? WHERE id=?").bind(dataSync!.id, table.id).run();

  let order = 1;
  for (const property of available.filter((p: SyncProperty) => selectedKeys.has(p.key))) {
    const readOnly = property.unique_primary || !twoWaySync;
    const field = await db.prepare(
      `INSERT INTO database_field (table_id, name, type, [order], "primary", read_only, trashed,
       field_settings, created_on, updated_on, db_index, immutable_type, immutable_properties)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?) RETURNING id`
    ).bind(
      table.id,
      property.name,
      property.field_type,
      order,
      property.unique_primary ? 1 : 0,
      readOnly ? 1 : 0,
      property.field_settings ? JSON.stringify(property.field_settings) : "{}",
      now,
      now,
      property.unique_primary ? 1 : 0,
      property.immutable_properties === false ? 0 : 1
    )
      .first<{ id: number }>();
    if (!field) continue;
    await addFieldColumn(db, table.id, { id: field.id, type: property.field_type, primary: property.unique_primary });
    if ((property.field_type === "single_select" || property.field_type === "multiple_select") && property.select_options) {
      await insertDataSyncSelectOptions(db, dataSync!.id, field.id, property.select_options);
    }
    await db.prepare(
      "INSERT INTO database_datasyncsyncedproperty (data_sync_id, field_id, key, unique_primary) VALUES (?, ?, ?, ?)"
    ).bind(dataSync!.id, field.id, property.key, property.unique_primary ? 1 : 0).run();
    order += 1;
  }

  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  await db.prepare(
    `INSERT INTO database_view (table_id, name, type, [order], filter_type, public, public_view_password, slug,
     trashed, created_on, updated_on, row_identifier_type, ownership_type, row_height_size, filters_disabled)
     VALUES (?,'Grid','grid',1,'AND',0,0,?,0,?,?,'count','collaborative','small',0)`
  ).bind(table.id, slug, now, now).run();

  return table;
}

export async function syncDataSyncTable(
  db: D1Database,
  dataSyncId: number,
  env?: DataSyncRuntimeEnv,
  options: { periodic?: boolean; userId?: number | null } = {}
) {
  const dataSync = await db.prepare("SELECT * FROM database_datasync WHERE id=?").bind(dataSyncId).first<DataSyncRow>();
  if (!dataSync) throw new DoesNotExist("Data sync", dataSyncId);
  const now = new Date().toISOString();
  try {
    const settings = parseSettings(dataSync);
    if (dataSync.type === "local_supertask_table") {
      let authorizedUserId = Number(dataSync.authorized_user_id || 0);
      if (authorizedUserId <= 0 && Number(options.userId || 0) > 0) {
        authorizedUserId = Number(options.userId);
        await db.prepare("UPDATE database_datasync SET authorized_user_id=?, updated_on=? WHERE id=?")
          .bind(authorizedUserId, now, dataSyncId)
          .run();
      }
      if (authorizedUserId > 0) {
        const source = await localSupertaskSourceTable(db, settings);
        await assertHasTableRole(db, authorizedUserId, source, "VIEWER");
      }
    }
    const availableProperties = await dataSyncAvailableProperties(db, dataSync, env);
    const requestedProperties = dataSync.auto_add_new_properties
      ? availableProperties.map((property) => property.key)
      : await existingDataSyncPropertyKeys(db, dataSyncId);
    await updateDataSyncSyncedProperties(
      db,
      dataSyncId,
      requestedProperties,
      env,
      availableProperties
    );
    const properties = await db.prepare(
      `SELECT dsp.key, dsp.field_id, dsp.unique_primary, f.type
       FROM database_datasyncsyncedproperty dsp
       JOIN database_field f ON f.id=dsp.field_id
       WHERE dsp.data_sync_id=?
       ORDER BY dsp.id ASC`
    ).bind(dataSyncId).all<any>();
    const syncedProperties = (properties.results || []) as ActiveDataSyncProperty[];
    const rows = await fetchRowsForDataSync(db, dataSync.type, settings, syncedProperties.map((property: any) => String(property.key)), env);
    await ensureUserTableSystemColumns(db, Number(dataSync.table_id));
    await applyDataSyncRows(db, dataSync, syncedProperties, rows, now);
    const periodicInterval = normalizePeriodicInterval(dataSync.periodic_interval);
    const periodicIntervalCount = normalizePeriodicIntervalCount(dataSync.periodic_interval_count);
    await db.prepare(
      `UPDATE database_datasync
          SET last_sync=?,
              last_error=NULL,
              authorized=1,
              consecutive_failures=0,
              deactivated=0,
              deactivation_reason=NULL,
              last_periodic_sync=CASE WHEN ? THEN ? ELSE last_periodic_sync END,
              next_periodic_sync=CASE WHEN ? THEN ? ELSE next_periodic_sync END,
              updated_on=?
        WHERE id=?`
    )
      .bind(
        now,
        options.periodic ? 1 : 0,
        now,
        options.periodic ? 1 : 0,
        nextPeriodicSync(periodicInterval, periodicIntervalCount),
        now,
        dataSyncId
      )
      .run();
    return { imported_count: rows.length };
  } catch (error: any) {
    const message = error?.message ? String(error.message) : "Data sync failed.";
    const failures = Number(dataSync.consecutive_failures || 0) + 1;
    const shouldDeactivate = Boolean(options.periodic && failures >= PERIODIC_FAILURE_LIMIT);
    const periodicInterval = normalizePeriodicInterval(dataSync.periodic_interval);
    const periodicIntervalCount = normalizePeriodicIntervalCount(dataSync.periodic_interval_count);
    await db.prepare(
      `UPDATE database_datasync
          SET last_error=?,
              authorized=?,
              consecutive_failures=?,
              deactivated=?,
              deactivation_reason=?,
              last_periodic_sync=CASE WHEN ? THEN ? ELSE last_periodic_sync END,
              next_periodic_sync=CASE WHEN ? THEN ? ELSE next_periodic_sync END,
              updated_on=?
        WHERE id=?`
    )
      .bind(
        message,
        error instanceof PermissionError ? 0 : dataSync.authorized,
        failures,
        shouldDeactivate ? 1 : Number(dataSync.deactivated || 0),
        shouldDeactivate ? PERIODIC_DEACTIVATION_REASON_FAILURES : dataSync.deactivation_reason || null,
        options.periodic ? 1 : 0,
        now,
        options.periodic ? 1 : 0,
        shouldDeactivate ? null : nextPeriodicSync(periodicInterval, periodicIntervalCount),
        now,
        dataSyncId
      )
      .run();
    if (shouldDeactivate) {
      await notifyPeriodicDataSyncDeactivated(db, dataSyncId, PERIODIC_DEACTIVATION_REASON_FAILURES);
    }
    throw error;
  }
}
