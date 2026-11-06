import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware, optionalAuthMiddleware } from "../../middleware/auth";
import { ApiError, DoesNotExist, PermissionError, ValidationError } from "../../middleware/error";
import { broadcastToWorkspace } from "../../durable-objects/workspace-room";
import { getActiveFields, serializeRowForViewWithComputed, serializeRowsForViewWithComputed } from "../../services/view-helpers";
import { deserializeFieldValue, ensureUserTableSystemColumns, serializeFieldValueForInsert, type FieldMeta, type FieldType } from "../../services/dynamic-tables";
import {
  serializeUserFileForRequest,
  storeUserFile,
  UserFileSizeTooLargeError,
  userFileSizeTooLargeResponse,
} from "../../services/user-files";
import { isTemplateWorkspace } from "../../services/templates";
import { recordTrashEntry } from "../../services/trash";
import { getSelectOptions, isReadOnlyFieldType, serializeDatabaseFieldRow } from "../../services/field-serialization";
import { queryViewRows } from "../../services/view-query";
import { duplicateViewDependencies } from "../../services/view-duplication";
import { triggerTableWebhooks } from "./webhooks";
import { buildRowMetadata } from "../../services/row-metadata";
import { assertHasTableRole, assertHasViewRole } from "../../services/enterprise-permissions";
import { logAuditEntry } from "../../services/audit-log";
import { hashPassword, verifyPassword } from "../../services/user";
import { createUndoableAction } from "../../services/action-history";
import { snapshotViewForUndoRedo } from "../../services/view-snapshots";
import { allocateAutonumberValues } from "../../services/autonumber";
import { missingCreateFieldValues } from "../../services/row-create-values";
import { finalizeRowWrite } from "../../services/row-write-effects";
import { serializeFieldValueForStorage } from "../../services/field-values";
import { createDirectNotificationForUsers } from "../../services/notifications";

const views = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const VALID_VIEW_TYPES = new Set(["grid", "gallery", "form", "survey", "kanban", "calendar", "timeline"]);
const PREMIUM_FIELD_OPTION_VIEW_TYPES = new Set(["kanban", "calendar", "timeline"]);
const PUBLIC_VIEW_AUTHORIZATION_HEADER = "Baserow-View-Authorization";
const MAX_NUMBER_CALENDAR_DAYS = 45;
const TIMELINE_INVALID_DATE_SETTINGS = {
  error: "ERROR_TIMELINE_VIEW_HAS_INVALID_DATE_SETTINGS",
  detail: "The requested timeline view does not have valid date settings. Please choose two valid date fields in the table that use the same settings for 'include_time' and use the same timezone for all collaborators.",
} as const;
const FIELD_NOT_IN_TABLE = {
  error: "ERROR_FIELD_NOT_IN_TABLE",
  detail: "The provided field does not belong in the related table.",
} as const;
const FIELD_DOES_NOT_EXIST = {
  error: "ERROR_FIELD_DOES_NOT_EXIST",
  detail: "The requested field does not exist.",
} as const;
const INCOMPATIBLE_FIELD = {
  error: "ERROR_INCOMPATIBLE_FIELD",
  detail: "The provided field is not compatible.",
} as const;
const KANBAN_FIELD_NOT_IN_TABLE = {
  error: "ERROR_KANBAN_VIEW_FIELD_DOES_NOT_BELONG_TO_SAME_TABLE",
  detail: "The provided single select field does not belong to the same table.",
} as const;
const UNRELATED_FIELD = {
  error: "ERROR_UNRELATED_FIELD",
  detail: "The field is not related to the provided view.",
} as const;
const AGGREGATION_TYPE_DOES_NOT_EXIST = {
  error: "ERROR_AGGREGATION_TYPE_DOES_NOT_EXIST",
  detail: "The specified aggregation type does not exist.",
} as const;
const AGGREGATION_DOES_NOT_SUPPORTED_FIELD = {
  error: "ERROR_AGGREGATION_DOES_NOT_SUPPORTED_FIELD",
  detail: "The aggregation type does not support the given field.",
} as const;
const FORM_VIEW_UNSUPPORTED_FIELD_TYPES = new Set<FieldType>([
  "ai",
  "autonumber",
  "auto_number",
  "count",
  "created_by",
  "created_on",
  "formula",
  "last_modified",
  "last_modified_by",
  "lookup",
  "rollup",
  "uuid",
]);
const GRID_VIEW_ALLOWED_AGGREGATION_RAW_TYPES = new Set([
  "empty_count",
  "not_empty_count",
  "unique_count",
  "min",
  "max",
  "sum",
  "average",
  "std_dev",
  "variance",
  "median",
  "decile",
  "distribution",
]);
const GRID_AGGREGATION_COMPATIBLE_FIELD_TYPES: Record<string, Set<FieldType>> = {
  empty_count: new Set([
    "text", "long_text", "url", "number", "rating", "boolean", "date", "duration",
    "last_modified", "last_modified_by", "created_on", "created_by", "link_row",
    "email", "file", "phone_number", "single_select", "multiple_select", "password",
  ]),
  not_empty_count: new Set([
    "text", "long_text", "url", "number", "rating", "boolean", "date", "duration",
    "last_modified", "last_modified_by", "created_on", "created_by", "link_row",
    "email", "file", "phone_number", "single_select", "multiple_select", "password",
  ]),
  unique_count: new Set([
    "text", "long_text", "url", "number", "rating", "date", "duration",
    "last_modified", "last_modified_by", "created_on", "created_by", "email",
    "phone_number", "single_select",
  ]),
  min: new Set(["date", "number", "rating", "last_modified", "created_on", "autonumber", "auto_number", "duration"]),
  max: new Set(["date", "number", "rating", "last_modified", "created_on", "autonumber", "auto_number", "duration"]),
  sum: new Set(["number", "rating", "duration"]),
  average: new Set(["number", "rating"]),
  std_dev: new Set(["number", "rating"]),
  variance: new Set(["number", "rating"]),
  median: new Set(["number", "rating"]),
  decile: new Set(["number", "rating"]),
  distribution: new Set([
    "text", "long_text", "url", "number", "rating", "date", "duration",
    "last_modified", "last_modified_by", "created_on", "created_by", "email",
    "phone_number", "single_select", "boolean",
  ]),
};
const GRID_AGGREGATION_COMPATIBLE_FORMULA_TYPES: Record<string, Set<string>> = {
  empty_count: new Set(["text", "char", "number", "date", "boolean", "single_file_array"]),
  not_empty_count: new Set(["text", "char", "number", "date", "boolean", "single_file_array"]),
  unique_count: new Set(["text", "char", "number", "date"]),
  min: new Set(["number", "date"]),
  max: new Set(["number", "date"]),
  sum: new Set(["number"]),
  average: new Set(["number"]),
  std_dev: new Set(["number"]),
  variance: new Set(["number"]),
  median: new Set(["number"]),
  decile: new Set(["number"]),
  distribution: new Set(["boolean", "char", "date", "number", "text"]),
};
const TIMELINE_TIMESCALES = new Set(["day", "week", "month", "year"]);
const NON_SORTABLE_FIELD_TYPES = new Set<FieldType>(["file", "password"]);
const DECORATABLE_VIEW_TYPES = new Set(["grid", "gallery", "kanban", "calendar", "timeline"]);
const DECORATION_TYPES = new Set(["left_border_color", "background_color"]);
const DECORATION_VALUE_PROVIDER_TYPES = new Set(["", "single_select_color", "conditional_color"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function viewAuditDetails(db: D1Database, viewId: number) {
  return db.prepare(
    `SELECT v.id AS view_id, v.name AS view_name, v.type AS view_type,
            t.id AS table_id, t.name AS table_name, a.id AS database_id,
            a.workspace_id, w.name AS workspace_name
       FROM database_view v
       JOIN database_table t ON t.id=v.table_id
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspace w ON w.id=a.workspace_id
      WHERE v.id=?`
  ).bind(viewId).first<any>();
}

async function activeViewField(db: D1Database, view: any, fieldId: unknown) {
  const id = Number(fieldId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare(
    `SELECT id, type, field_settings
     FROM database_field
     WHERE id=? AND table_id=? AND trashed=0`
  ).bind(id, view.table_id).first<any>();
}

function sortTypeSupportsField(field: any, type: unknown): boolean {
  const sortType = String(type || "default");
  if (sortType === "order") return field?.type === "single_select";
  return sortType === "default" && field && !NON_SORTABLE_FIELD_TYPES.has(field.type as FieldType);
}

function viewActionContext(c: any, tableId: number) {
  return {
    session: c.get("client_session_id") || "",
    actionGroup: c.req.header("ClientUndoRedoActionGroupId") || null,
    actionScope: `table${tableId}`,
  };
}

async function recordViewUpdateUndoAction(
  c: any,
  user: NonNullable<RequestVariables["user"]>,
  view: any,
  beforeSnapshot: Record<string, unknown> | null
) {
  const viewId = Number(view.id);
  const tableId = Number(view.table_id);
  const afterSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  await createUndoableAction(c.env.DB, {
    user,
    actionType: "update_view",
    params: { view_id: viewId, table_id: tableId, before: beforeSnapshot, after: afterSnapshot },
    ...viewActionContext(c, tableId),
  });
}

async function getViewWithAccess(
  db: D1Database,
  viewId: number,
  userId: number | undefined,
  allowTemplateRead = false,
  requiredRole = "VIEWER"
): Promise<{ view: any; workspace_id: number }> {
  const view = await db
    .prepare(`SELECT v.*, t.database_id, a.workspace_id
              FROM database_view v
              JOIN database_table t ON t.id = v.table_id
              JOIN core_application a ON a.id = t.database_id
              WHERE v.id = ? AND v.trashed = 0`)
    .bind(viewId)
    .first<any>();
  if (!view) throw new DoesNotExist("View", viewId);
  if (view.ownership_type === "personal") {
    if (!userId || Number(view.owned_by_id) !== userId) {
      throw new PermissionError("The user does not own this personal view.");
    }
    await assertHasTableRole(db, userId, {
      id: Number(view.table_id),
      database_id: Number(view.database_id),
      workspace_id: Number(view.workspace_id),
    }, "VIEWER");
    return { view, workspace_id: view.workspace_id };
  }
  if (allowTemplateRead && await isTemplateWorkspace(db, view.workspace_id)) {
    return { view, workspace_id: view.workspace_id };
  }
  await assertHasViewRole(db, userId, viewId, requiredRole);

  return { view, workspace_id: view.workspace_id };
}

async function assertPersonalPublicViewOwnerCanShare(db: D1Database, view: any): Promise<void> {
  if (view.ownership_type !== "personal") return;
  const ownerId = Number(view.owned_by_id);
  if (!Number.isInteger(ownerId) || ownerId <= 0) throw new DoesNotExist("View", view.slug || view.id);
  const related = view.workspace_id && view.database_id ? view : await db.prepare(
    `SELECT t.id, t.database_id, a.workspace_id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
  ).bind(view.table_id).first<any>();
  if (!related) throw new DoesNotExist("View", view.slug || view.id);
  try {
    await assertHasTableRole(db, ownerId, {
      id: Number(view.table_id),
      database_id: Number(related.database_id),
      workspace_id: Number(related.workspace_id),
    }, "BUILDER");
  } catch (error) {
    if (error instanceof PermissionError) throw new DoesNotExist("View", view.slug || view.id);
    throw error;
  }
}

const DEFAULT_PUBLIC_URL = "https://supertask.mbza.workers.dev";

function normalizePublicUrl(publicUrl?: string): string {
  return String(publicUrl || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
}

function calendarIcalFeedUrl(v: any, publicUrl?: string): string | null {
  if (!v.ical_public || !v.ical_slug) return null;
  return `${normalizePublicUrl(publicUrl)}/api/database/views/calendar/${encodeURIComponent(String(v.ical_slug))}.ics`;
}

function publicViewHasPassword(view: any): boolean {
  const password = view?.public_view_password;
  return Boolean(password && password !== "0" && String(password).toLowerCase() !== "false");
}

function publicViewJwtSecret(env: Env, view: any): Uint8Array {
  const secret = `${view.slug}-${view.public_view_password || ""}-${env.SECRET_KEY || env.JWT_SIGNING_KEY}`;
  return new TextEncoder().encode(secret);
}

async function encodePublicViewToken(env: Env, view: any): Promise<string> {
  return new SignJWT({ slug_id: view.slug })
    .setProtectedHeader({ alg: "HS256" })
    .sign(publicViewJwtSecret(env, view));
}

function getPublicViewAuthorizationToken(c: { req: { header(name: string): string | undefined } }): string | null {
  const header = c.req.header(PUBLIC_VIEW_AUTHORIZATION_HEADER) || "";
  if (!header.startsWith("JWT ")) return null;
  return header.slice(4).trim() || null;
}

async function isPublicViewTokenValid(env: Env, view: any, token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, publicViewJwtSecret(env, view));
    return payload.slug_id === view.slug;
  } catch {
    return false;
  }
}

function timingSafeEqualText(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

async function publicViewPasswordMatches(view: any, password: string | undefined): Promise<boolean> {
  if (!publicViewHasPassword(view)) return true;
  const stored = String(view.public_view_password);
  const provided = String(password || "");
  if (stored.includes("$")) return verifyPassword(provided, stored).catch(() => false);
  // Passwords saved before hashing was introduced are still plain text.
  return timingSafeEqualText(provided, stored);
}

async function publicViewAuthorizationResponse(
  c: any,
  view: any,
  formView = false
): Promise<Response | null> {
  await assertPersonalPublicViewOwnerCanShare(c.env.DB, view);
  if (!publicViewHasPassword(view)) return null;

  const user = c.get?.("user");
  if (user?.id) {
    try {
      await assertHasViewRole(c.env.DB, user.id, Number(view.id), "VIEWER");
      return null;
    } catch (error) {
      if (!(error instanceof PermissionError)) throw error;
    }
  }

  const token = getPublicViewAuthorizationToken(c);
  if (await isPublicViewTokenValid(c.env, view, token)) return null;

  return c.json({
    error: formView ? "ERROR_NO_PERMISSION_TO_PUBLICLY_SHARED_FORM" : "ERROR_NO_AUTHORIZATION_TO_PUBLICLY_SHARED_VIEW",
    detail: "The view is password protected.",
  }, 401);
}

function serializeView(v: any, publicUrl?: string): object {
  const serialized: Record<string, unknown> = {
    id: v.id,
    table_id: v.table_id,
    table: v.table || {
      id: v.table_id,
      name: v.table_name || "",
      order: v.table_order ?? 0,
      database_id: v.database_id,
    },
    name: v.name,
    type: v.type,
    order: v.order,
    filter_type: v.filter_type || "AND",
    filters_disabled: Boolean(v.filters_disabled),
    public: Boolean(v.public),
    public_view_has_password: publicViewHasPassword(v),
    show_logo: v.show_logo === null || v.show_logo === undefined ? true : Boolean(v.show_logo),
    allow_public_export: Boolean(v.allow_public_export),
    slug: v.slug,
    row_identifier_type: v.row_identifier_type || "count",
    ownership_type: v.ownership_type || "collaborative",
    owned_by_id: v.owned_by_id ?? null,
    row_height_size: v.row_height_size || "small",
    created_on: v.created_on,
    updated_on: v.updated_on,
    filters: [],
    filter_groups: [],
    sortings: [],
    group_bys: [],
    decorations: [],
  };

  if (v.type === "form") {
    const mode = v.mode === "survey" ? "survey" : "form";
    serialized.title = v.title || v.name || "";
    serialized.description = v.form_description ?? v.description ?? "";
    serialized.submit_text = v.submit_text || "Submit";
    serialized.submit_action = v.submit_action || "MESSAGE";
    serialized.submit_action_message = v.submit_action_message || "";
    serialized.submit_action_redirect_url = v.submit_action_redirect_url || "";
    serialized.receive_notification_on_submit = Boolean(v.receive_notification_on_submit);
    serialized.mode = mode;
    serialized.cover_image = parseJsonObject(v.cover_image);
    serialized.logo_image = parseJsonObject(v.logo_image);
  }

  if (v.type === "gallery") {
    serialized.card_cover_image_field = v.card_cover_image_field ?? null;
  }

  if (v.type === "kanban") {
    serialized.single_select_field = v.single_select_field ?? v.single_select_field_id ?? null;
    serialized.card_cover_image_field = v.card_cover_image_field ?? null;
  }

  if (v.type === "calendar") {
    serialized.date_field = v.date_field ?? v.date_field_id ?? null;
    serialized.ical_public = Boolean(v.ical_public);
    serialized.ical_slug = v.ical_slug ?? null;
    serialized.ical_feed_url = calendarIcalFeedUrl(v, publicUrl);
  }

  if (v.type === "timeline") {
    serialized.start_date_field = v.start_date_field ?? v.start_date_field_id ?? null;
    serialized.end_date_field = v.end_date_field ?? v.end_date_field_id ?? null;
    serialized.timescale = v.timescale || "month";
  }

  return serialized;
}

function parseJsonObject(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeFilter(row: any): object {
  let preloadValues = {};
  if (row.preload_values) {
    try {
      preloadValues = JSON.parse(row.preload_values);
    } catch {
      preloadValues = {};
    }
  }

  return {
    id: row.id,
    view: row.view_id,
    field: row.field_id,
    type: row.type,
    value: row.value ?? "",
    group: row.group_id ?? null,
    preload_values: preloadValues,
  };
}

function serializeFilterGroup(row: any): object {
  return {
    id: row.id,
    view: row.view_id,
    parent_group: row.parent_group_id ?? null,
    filter_type: row.filter_type || "AND",
  };
}

function serializeFormConditionGroup(row: any): object {
  return {
    id: row.id,
    filter_type: row.filter_type || "AND",
    parent_group: row.parent_group_id ?? null,
  };
}

function serializeFormCondition(row: any): object {
  return {
    id: row.id,
    field: row.field_id,
    type: row.type,
    value: row.value ?? "",
    group: row.group_id ?? null,
  };
}

function serializeSort(row: any): object {
  return {
    id: row.id,
    view: row.view_id,
    field: row.field_id,
    order: row.order || "ASC",
    type: row.type || "default",
  };
}

function serializeGroupBy(row: any): object {
  return {
    id: row.id,
    view: row.view_id,
    field: row.field_id,
    order: row.order || "ASC",
    width: row.width ?? 200,
    type: row.type || "default",
  };
}

async function serializeViewWithIncludes(
  db: D1Database,
  view: any,
  includeParam = "",
  publicUrl?: string,
  userId?: number
): Promise<object> {
  const includes = new Set(includeParam.split(",").map((item) => item.trim()).filter(Boolean));
  const rows = (sql: string) => db.prepare(sql).bind(view.id).all<any>().then((result) => result.results || []);
  // The view details and every requested include are independent reads.
  const [enriched, filters, groups, sorts, groupBys, decorations] = await Promise.all([
    hydrateViewDetails(db, view, userId),
    includes.has("filters") ? rows(
      `SELECT vf.* FROM database_viewfilter vf
       JOIN database_field f ON f.id=vf.field_id AND f.trashed=0
       WHERE vf.view_id=? ORDER BY vf.id ASC`
    ) : null,
    includes.has("filters") ? rows("SELECT * FROM database_viewfiltergroup WHERE view_id=? ORDER BY id ASC") : null,
    includes.has("sortings") ? rows(
      `SELECT vs.* FROM database_viewsort vs
       JOIN database_field f ON f.id=vs.field_id AND f.trashed=0
       WHERE vs.view_id=? ORDER BY vs.id ASC`
    ) : null,
    includes.has("group_bys") ? rows(
      `SELECT vg.* FROM database_viewgroupby vg
       JOIN database_field f ON f.id=vg.field_id AND f.trashed=0
       WHERE vg.view_id=? ORDER BY vg.id ASC`
    ) : null,
    includes.has("decorations") ? rows("SELECT * FROM database_viewdecoration WHERE view_id=? ORDER BY [order] ASC, id ASC") : null,
  ]);
  const serialized: Record<string, unknown> = serializeView(enriched, publicUrl) as Record<string, unknown>;
  if (filters && groups) {
    serialized.filters = filters.map(serializeFilter);
    serialized.filter_groups = groups.map(serializeFilterGroup);
  }
  if (sorts) serialized.sortings = sorts.map(serializeSort);
  if (groupBys) serialized.group_bys = groupBys.map(serializeGroupBy);
  if (decorations) serialized.decorations = decorations.map(serializeDecoration);

  return serialized;
}

async function serializePublicViewInfo(
  db: D1Database,
  view: any,
  fields: any[],
  publicUrl?: string
): Promise<{ view: Record<string, unknown>; fields: object[] }> {
  const visibleFieldIds = new Set(fields.map((field) => Number(field.id)));
  const serialized = await serializeViewWithIncludes(db, view, "sortings,group_bys", publicUrl) as Record<string, unknown>;
  serialized.id = String(view.slug);
  serialized.table = { id: 0, database_id: 0 };
  serialized.sortings = ((serialized.sortings as any[]) || []).filter((sorting) => visibleFieldIds.has(Number(sorting.field)));
  serialized.group_bys = ((serialized.group_bys as any[]) || []).filter((groupBy) => visibleFieldIds.has(Number(groupBy.field)));
  delete serialized.table_id;
  delete serialized.created_on;
  delete serialized.updated_on;
  delete serialized.public_view_has_password;
  delete serialized.owned_by_id;

  return {
    view: serialized,
    fields: fields.map(serializePublicField),
  };
}

async function hydrateViewDetails(db: D1Database, view: any, userId?: number): Promise<any> {
  const table = view.table || await db.prepare(
    `SELECT id, name, [order], database_id
     FROM database_table
     WHERE id=?`
  ).bind(view.table_id).first<any>();
  const hydrated = {
    ...view,
    table: table ? {
      id: Number(table.id),
      name: String(table.name || ""),
      order: Number(table.order || 0),
      database_id: Number(table.database_id),
    } : undefined,
  };
  if (view.type === "form") {
    const form = await db.prepare(
      `SELECT title, description AS form_description, submit_text,
              submit_action, submit_action_message, submit_action_redirect_url,
              mode, show_logo AS form_show_logo, cover_image, logo_image
       FROM database_formview
       WHERE view_ptr_id=?`
    ).bind(view.id).first<any>();
    const notification = userId ? await db.prepare(
      `SELECT 1 AS enabled
       FROM database_formview_users_to_notify_on_submit
       WHERE formview_id=? AND user_id=?`
    ).bind(view.id, userId).first<{ enabled: number }>() : null;
    return {
      ...hydrated,
      title: form?.title ?? "",
      form_description: form?.form_description ?? "",
      submit_text: form?.submit_text ?? "Submit",
      submit_action: form?.submit_action ?? "MESSAGE",
      submit_action_message: form?.submit_action_message ?? "",
      submit_action_redirect_url: form?.submit_action_redirect_url ?? "",
      mode: form?.mode === "survey" ? "survey" : "form",
      receive_notification_on_submit: Boolean(notification?.enabled),
      cover_image: form?.cover_image ?? null,
      logo_image: form?.logo_image ?? null,
    };
  }
  return hydrated;
}

async function getGridFieldOptions(db: D1Database, viewId: number): Promise<Record<number, object>> {
  const res = await db.prepare(
    "SELECT field_id, width, hidden, [order], aggregation_type, aggregation_raw_type FROM database_gridviewfieldoptions WHERE grid_view_id=?"
  )
    .bind(viewId)
    .all<any>();

  const map: Record<number, object> = {};
  for (const row of (res.results || [])) {
    map[row.field_id] = {
      width: row.width || 200,
      hidden: Boolean(row.hidden),
      order: row.order || 32767,
      aggregation_type: row.aggregation_type || "",
      aggregation_raw_type: row.aggregation_raw_type || "",
    };
  }
  return map;
}

async function getPremiumFieldOptions(db: D1Database, viewId: number): Promise<Record<number, object>> {
  const res = await db.prepare(
    "SELECT field_id, hidden, [order] FROM database_gridviewfieldoptions WHERE grid_view_id=?"
  )
    .bind(viewId)
    .all<any>();

  const map: Record<number, object> = {};
  for (const row of (res.results || [])) {
    map[row.field_id] = {
      hidden: Boolean(row.hidden),
      order: row.order || 32767,
    };
  }
  return map;
}

async function ensureGridFieldOptionsForView(
  db: D1Database,
  viewId: number,
  fields: Array<{ id: number }>,
  visibleFieldCount: number
): Promise<void> {
  const statements = fields.map((field, index) =>
    db.prepare(
      `INSERT OR IGNORE INTO database_gridviewfieldoptions
       (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (?, ?, 200, ?, ?, '', '')`
    ).bind(viewId, field.id, index < visibleFieldCount ? 0 : 1, (index + 1) * 32768)
  );
  if (statements.length > 0) await db.batch(statements);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function selectOptionIdFromValue(value: unknown): number | null {
  const parsed = deserializeFieldValue("single_select", value);
  if (parsed === null || parsed === undefined || parsed === "") return null;
  if (typeof parsed === "number") return Number.isInteger(parsed) ? parsed : null;
  if (typeof parsed === "string") {
    const numeric = Number(parsed);
    return Number.isInteger(numeric) ? numeric : null;
  }
  if (typeof parsed === "object" && !Array.isArray(parsed) && "id" in parsed) {
    const numeric = Number((parsed as { id: unknown }).id);
    return Number.isInteger(numeric) ? numeric : null;
  }
  return null;
}

function isoDateKey(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "string" ? value : String(value);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 10) || null;
  return date.toISOString().slice(0, 10);
}

function parseDateValue(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function requiredCalendarTimestamp(url: URL, name: "from_timestamp" | "to_timestamp"): Date {
  const raw = url.searchParams.get(name);
  if (!raw) throw new ValidationError(`${name} is required.`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError(`${name} must be a valid datetime.`);
  return parsed;
}

function calendarLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit") || 40);
  if (!Number.isFinite(raw)) return 40;
  return Math.min(100, Math.max(1, Math.floor(raw)));
}

function assertCalendarRange(from: Date, to: Date) {
  if (from.getTime() > to.getTime()) {
    throw new ValidationError("from_timestamp must occur before to_timestamp");
  }
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000);
  if (days > MAX_NUMBER_CALENDAR_DAYS) {
    throw new ValidationError(`the number of days between from_timestamp and to_timestamp must be less than ${MAX_NUMBER_CALENDAR_DAYS} days`);
  }
}

function dateKeyFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateOnlyKey(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : isoDateKey(raw);
}

function assertValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new ValidationError("user_timezone must be a valid timezone.");
  }
}

function dateKeyInTimeZone(date: Date, timeZone: string): string {
  assertValidTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function calendarRowDateKey(value: unknown, dateField: FieldMeta | undefined, userTimeZone: string): string | null {
  if (!dateField?.settings?.date_include_time) return dateOnlyKey(value);
  const parsed = parseDateValue(value);
  if (!parsed) return null;
  const targetTimeZone = String(dateField.settings.date_force_timezone || userTimeZone || "UTC");
  return dateKeyInTimeZone(parsed, targetTimeZone);
}

function canRepresentDate(field: FieldMeta | undefined): field is FieldMeta {
  if (!field) return false;
  if (["date", "created_on", "last_modified"].includes(String(field.type))) return true;
  if (!["formula", "lookup", "rollup"].includes(String(field.type))) return false;
  return String(field.settings?.formula_type || "").toLowerCase() === "date";
}

function canRepresentFiles(field: FieldMeta | undefined): field is FieldMeta {
  if (!field) return false;
  if (field.type === "file") return true;
  if (!["formula", "lookup", "rollup"].includes(String(field.type))) return false;
  const formulaType = String(field.settings?.formula_type || "").toLowerCase();
  const arrayFormulaType = String(field.settings?.array_formula_type || "").toLowerCase();
  return formulaType === "single_file_array" || (formulaType === "array" && arrayFormulaType === "single_file");
}

function canRepresentTimelineDate(field: FieldMeta | undefined): field is FieldMeta {
  return canRepresentDate(field);
}

async function getPatchFieldFromViewTable(db: D1Database, view: any, value: unknown): Promise<FieldMeta | null | undefined> {
  const fieldId = numberOrNull(value);
  if (!fieldId) return null;
  const fields = await getActiveFields(db, Number(view.table_id));
  return fields.find((field) => Number(field.id) === fieldId);
}

async function validateCardCoverImagePatchValue(db: D1Database, view: any, value: unknown): Promise<Response | null> {
  const field = await getPatchFieldFromViewTable(db, view, value);
  if (field === null) return null;
  if (!field) return Response.json(FIELD_NOT_IN_TABLE, { status: 400 });
  if (!canRepresentFiles(field)) return Response.json(INCOMPATIBLE_FIELD, { status: 400 });
  return null;
}

async function validateKanbanPatchValues(db: D1Database, view: any, body: Record<string, unknown>): Promise<Response | null> {
  if (body.single_select_field !== undefined) {
    const field = await getPatchFieldFromViewTable(db, view, body.single_select_field);
    if (field === null) return null;
    if (!field) return Response.json(KANBAN_FIELD_NOT_IN_TABLE, { status: 400 });
    if (field.type !== "single_select") return Response.json(INCOMPATIBLE_FIELD, { status: 400 });
  }
  if (body.card_cover_image_field !== undefined) {
    const invalidCardCover = await validateCardCoverImagePatchValue(db, view, body.card_cover_image_field);
    if (invalidCardCover) return invalidCardCover;
  }
  return null;
}

async function validateCalendarPatchValues(db: D1Database, view: any, body: Record<string, unknown>): Promise<Response | null> {
  if (body.date_field === undefined) return null;
  const field = await getPatchFieldFromViewTable(db, view, body.date_field);
  if (field === null) return null;
  if (!field) return Response.json(FIELD_NOT_IN_TABLE, { status: 400 });
  if (!canRepresentDate(field)) return Response.json(INCOMPATIBLE_FIELD, { status: 400 });
  return null;
}

function timelineDateSettings(field: FieldMeta): { includeTime: boolean; timezone: string | null } {
  if (field.type === "created_on" || field.type === "last_modified") {
    return { includeTime: true, timezone: "UTC" };
  }
  const includeTime = field.settings?.date_include_time === true;
  return {
    includeTime,
    timezone: includeTime ? String(field.settings?.date_force_timezone || "") || null : null,
  };
}

function timelineFieldsAreCompatible(startField: FieldMeta, endField: FieldMeta): boolean {
  const start = timelineDateSettings(startField);
  const end = timelineDateSettings(endField);
  return start.includeTime === end.includeTime && (!start.includeTime || start.timezone === end.timezone);
}

async function validateTimelineDateSettings(db: D1Database, view: any): Promise<Response | null> {
  const startFieldId = numberOrNull(view.start_date_field);
  const endFieldId = numberOrNull(view.end_date_field);
  if (!startFieldId || !endFieldId) {
    return Response.json(TIMELINE_INVALID_DATE_SETTINGS, { status: 400 });
  }
  const fields = await getActiveFields(db, Number(view.table_id));
  const startField = fields.find((field) => Number(field.id) === startFieldId);
  const endField = fields.find((field) => Number(field.id) === endFieldId);
  if (!canRepresentTimelineDate(startField) || !canRepresentTimelineDate(endField)) {
    return Response.json({
      error: "ERROR_INCOMPATIBLE_FIELD",
      detail: "The provided field is not a date field and cannot be used in a timeline view.",
    }, { status: 400 });
  }
  if (!timelineFieldsAreCompatible(startField, endField)) {
    return Response.json(TIMELINE_INVALID_DATE_SETTINGS, { status: 400 });
  }
  return null;
}

async function validateTimelinePatchValues(db: D1Database, view: any, body: Record<string, unknown>): Promise<Response | null> {
  const fields = await getActiveFields(db, Number(view.table_id));
  const fieldById = new Map(fields.map((field) => [Number(field.id), field]));
  const startFieldId = body.start_date_field === undefined ? numberOrNull(view.start_date_field) : numberOrNull(body.start_date_field);
  const endFieldId = body.end_date_field === undefined ? numberOrNull(view.end_date_field) : numberOrNull(body.end_date_field);
  const providedIds = [body.start_date_field, body.end_date_field]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => Number(value));
  for (const fieldId of providedIds) {
    const field = fieldById.get(fieldId);
    if (!field) {
      return Response.json({
        error: "ERROR_FIELD_NOT_IN_TABLE",
        detail: "The provided date field id does not belong to the timeline view's table.",
      }, { status: 400 });
    }
    if (!canRepresentTimelineDate(field)) {
      return Response.json({
        error: "ERROR_INCOMPATIBLE_FIELD",
        detail: "The provided field is not a date field and cannot be used as a timeline date field.",
      }, { status: 400 });
    }
  }
  if (startFieldId && endFieldId) {
    const startField = fieldById.get(startFieldId);
    const endField = fieldById.get(endFieldId);
    if (!canRepresentTimelineDate(startField) || !canRepresentTimelineDate(endField) || !timelineFieldsAreCompatible(startField, endField)) {
      return Response.json(TIMELINE_INVALID_DATE_SETTINGS, { status: 400 });
    }
  }
  if (body.timescale !== undefined && !TIMELINE_TIMESCALES.has(String(body.timescale || "month"))) {
    return Response.json({
      error: "INVALID_REQUEST",
      detail: "The provided timeline timescale is invalid.",
    }, { status: 400 });
  }
  return null;
}

function icsEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function icsDateTime(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function rowTitle(row: Record<string, unknown>, fields: Array<{ id: number; primary?: boolean; name?: string }>): string {
  const primary = fields.find((field) => field.primary) || fields[0];
  if (!primary) return `Row ${row.id}`;
  const value = row[`field_${primary.id}`];
  if (value === null || value === undefined || value === "") return `Row ${row.id}`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isDateTimeField(field: FieldMeta | undefined, value: unknown): boolean {
  if (field?.settings?.date_include_time === true) return true;
  return typeof value === "string" && /T\d{2}:\d{2}/.test(value);
}

function requestedSelectOptionRanges(url: URL): Array<{ id: number | null; limit: number | null; offset: number }> {
  return url.searchParams.getAll("select_option").map((raw) => {
    const [id, limit, offset] = raw.split(",");
    return {
      id: id === "null" ? null : numberOrNull(id),
      limit: limit === undefined ? null : Math.max(0, Number(limit) || 0),
      offset: Math.max(0, Number(offset) || 0),
    };
  });
}

async function getViewFieldOptions(db: D1Database, view: any): Promise<Record<number, object>> {
  if (view.type === "grid") {
    return getGridFieldOptions(db, view.id);
  }

  if (PREMIUM_FIELD_OPTION_VIEW_TYPES.has(view.type)) {
    return getPremiumFieldOptions(db, view.id);
  }

  const fields = await db.prepare(
    `SELECT id, name, description, [order]
     FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY [order] ASC, id ASC`
  ).bind(view.table_id).all<any>();

  if (view.type === "gallery") {
    const rows = await db.prepare(
      "SELECT field_id, hidden, [order] FROM database_galleryviewfieldoptions WHERE gallery_view_id=?"
    ).bind(view.id).all<any>();
    const stored = new Map((rows.results || []).map((row: any) => [Number(row.field_id), row]));
    const options: Record<number, object> = {};
    for (const [index, field] of (fields.results || []).entries()) {
      const row = stored.get(Number(field.id));
      options[field.id] = {
        hidden: row ? Boolean(row.hidden) : true,
        order: row?.order ?? ((index + 1) * 32768),
      };
    }
    return options;
  }

  if (view.type === "form") {
    const rows = await db.prepare(
      `SELECT id, field_id, name, description, enabled, required, [order],
              show_when_matching_conditions, condition_type, include_all_select_options,
              field_component
       FROM database_formviewfieldoptions
       WHERE form_view_id=?`
    ).bind(view.id).all<any>();
    const stored = new Map((rows.results || []).map((row: any) => [Number(row.field_id), row]));
    const optionIds = (rows.results || []).map((row: any) => Number(row.id));
    const groupsByOption = new Map<number, any[]>();
    const conditionsByOption = new Map<number, any[]>();
    const allowedByOption = new Map<number, number[]>();

    if (optionIds.length > 0) {
      const marks = optionIds.map(() => "?").join(",");
      const groups = await db.prepare(
        `SELECT * FROM database_formviewfieldoptionsconditiongroup
         WHERE field_option_id IN (${marks})
         ORDER BY id ASC`
      ).bind(...optionIds).all<any>();
      for (const group of (groups.results || [])) {
        const key = Number(group.field_option_id);
        groupsByOption.set(key, [...(groupsByOption.get(key) || []), serializeFormConditionGroup(group)]);
      }

      const conditions = await db.prepare(
        `SELECT * FROM database_formviewfieldoptionscondition
         WHERE field_option_id IN (${marks})
         ORDER BY id ASC`
      ).bind(...optionIds).all<any>();
      for (const condition of (conditions.results || [])) {
        const key = Number(condition.field_option_id);
        conditionsByOption.set(key, [...(conditionsByOption.get(key) || []), serializeFormCondition(condition)]);
      }

      const allowed = await db.prepare(
        `SELECT form_view_field_options_id, select_option_id
         FROM database_formviewfieldoptions_allowedselectoptions
         WHERE form_view_field_options_id IN (${marks})
         ORDER BY id ASC`
      ).bind(...optionIds).all<any>();
      for (const option of (allowed.results || [])) {
        const key = Number(option.form_view_field_options_id);
        allowedByOption.set(key, [...(allowedByOption.get(key) || []), Number(option.select_option_id)]);
      }
    }

    const options: Record<number, object> = {};
    for (const [index, field] of (fields.results || []).entries()) {
      const row = stored.get(Number(field.id));
      const optionId = Number(row?.id || 0);
      options[field.id] = {
        name: row?.name ?? "",
        description: row?.description ?? "",
        enabled: row ? Boolean(row.enabled) : false,
        required: row ? Boolean(row.required) : true,
        order: row?.order ?? ((index + 1) * 32768),
        show_when_matching_conditions: row ? Boolean(row.show_when_matching_conditions) : false,
        condition_type: row?.condition_type || "AND",
        conditions: optionId ? conditionsByOption.get(optionId) || [] : [],
        condition_groups: optionId ? groupsByOption.get(optionId) || [] : [],
        field_component: row?.field_component || "default",
        include_all_select_options: row ? Boolean(row.include_all_select_options) : true,
        allowed_select_options: optionId ? allowedByOption.get(optionId) || [] : [],
      };
    }
    return options;
  }

  return {};
}

async function validateViewFieldOptionIds(
  db: D1Database,
  view: any,
  fieldOptions: Record<string, any>
): Promise<Response | null> {
  const uniqueIds = [...new Set(Object.keys(fieldOptions).map((fieldId) => Number(fieldId)))];
  if (uniqueIds.some((fieldId) => !Number.isInteger(fieldId) || fieldId <= 0)) {
    return Response.json(UNRELATED_FIELD, { status: 400 });
  }
  if (uniqueIds.length === 0) return null;

  const marks = uniqueIds.map(() => "?").join(",");
  const rows = await db.prepare(
    `SELECT id FROM database_field WHERE table_id=? AND trashed=0 AND id IN (${marks})`
  ).bind(view.table_id, ...uniqueIds).all<any>();
  if ((rows.results || []).length !== uniqueIds.length) {
    return Response.json(UNRELATED_FIELD, { status: 400 });
  }

  return null;
}

function formulaAggregationType(fieldSettings: unknown): string {
  let settings: Record<string, any> = {};
  if (typeof fieldSettings === "string" && fieldSettings.trim() !== "") {
    try {
      settings = JSON.parse(fieldSettings);
    } catch {
      settings = {};
    }
  } else if (fieldSettings && typeof fieldSettings === "object" && !Array.isArray(fieldSettings)) {
    settings = fieldSettings as Record<string, any>;
  }

  const formulaType = String(settings.formula_type || settings.array_formula_type || "").toLowerCase();
  if (formulaType === "array" || formulaType === "single_file_array") {
    const arrayFormulaType = String(settings.array_formula_type || "").toLowerCase();
    if (arrayFormulaType === "single_file") return "single_file_array";
  }
  return formulaType;
}

function gridAggregationSupportsField(aggregationRawType: string, field: any): boolean {
  const fieldType = String(field.type) as FieldType;
  if (fieldType === "formula") {
    const formulaType = formulaAggregationType(field.field_settings);
    return Boolean(formulaType && GRID_AGGREGATION_COMPATIBLE_FORMULA_TYPES[aggregationRawType]?.has(formulaType));
  }

  return Boolean(GRID_AGGREGATION_COMPATIBLE_FIELD_TYPES[aggregationRawType]?.has(fieldType));
}

async function validateGridFieldOptionsPatch(
  db: D1Database,
  view: any,
  fieldOptions: Record<string, any>
): Promise<Response | null> {
  const aggregationPatches = Object.entries(fieldOptions)
    .filter(([, opts]) => opts && typeof opts === "object" && Object.prototype.hasOwnProperty.call(opts, "aggregation_raw_type"))
    .map(([fieldId, opts]) => ({ fieldId: Number(fieldId), rawType: String(opts.aggregation_raw_type || "") }))
    .filter(({ rawType }) => rawType !== "");
  if (aggregationPatches.length === 0) return null;

  for (const { rawType } of aggregationPatches) {
    if (!GRID_VIEW_ALLOWED_AGGREGATION_RAW_TYPES.has(rawType)) {
      return Response.json(AGGREGATION_TYPE_DOES_NOT_EXIST, { status: 400 });
    }
  }

  const fieldIds = [...new Set(aggregationPatches.map(({ fieldId }) => fieldId))];
  const marks = fieldIds.map(() => "?").join(",");
  const rows = await db.prepare(
    `SELECT id, type, field_settings
       FROM database_field
      WHERE table_id=? AND trashed=0 AND id IN (${marks})`
  ).bind(view.table_id, ...fieldIds).all<any>();
  const fieldById = new Map((rows.results || []).map((field: any) => [Number(field.id), field]));

  for (const { fieldId, rawType } of aggregationPatches) {
    const field = fieldById.get(fieldId);
    if (!field) return Response.json(UNRELATED_FIELD, { status: 400 });
    if (!gridAggregationSupportsField(rawType, field)) {
      return Response.json(AGGREGATION_DOES_NOT_SUPPORTED_FIELD, { status: 400 });
    }
  }

  return null;
}

async function validateFormFieldOptionsPatch(
  db: D1Database,
  view: any,
  fieldOptions: Record<string, any>
): Promise<Response | null> {
  const requestedFieldIds = Object.keys(fieldOptions).map(Number);
  if (requestedFieldIds.length === 0) return null;
  const rows = await db.prepare(
    `SELECT id, name, type, read_only
       FROM database_field
      WHERE table_id=? AND trashed=0`
  ).bind(view.table_id).all<any>();
  const fieldById = new Map((rows.results || []).map((field: any) => [Number(field.id), field]));

  for (const fieldId of requestedFieldIds) {
    const field = fieldById.get(fieldId);
    if (!field) return Response.json(UNRELATED_FIELD, { status: 400 });
    const opts = fieldOptions[String(fieldId)];
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      return Response.json({ error: "INVALID_REQUEST", detail: "Field options must be an object." }, { status: 400 });
    }
    for (const booleanKey of ["enabled", "required", "show_when_matching_conditions", "include_all_select_options"]) {
      if (opts[booleanKey] !== undefined && typeof opts[booleanKey] !== "boolean") {
        return Response.json({ error: "INVALID_REQUEST", detail: `${booleanKey} must be a boolean.` }, { status: 400 });
      }
    }
    const fieldType = String(field.type) as FieldType;
    if (opts.enabled === true && (Boolean(field.read_only) || isReadOnlyFieldType(fieldType))) {
      return Response.json({
        error: "ERROR_FORM_VIEW_READ_ONLY_FIELD_IS_NOT_SUPPORTED",
        detail: `The ${field.name} field is read only and not compatible with the form view.`,
      }, { status: 400 });
    }
    if (opts.enabled === true && FORM_VIEW_UNSUPPORTED_FIELD_TYPES.has(fieldType)) {
      return Response.json({
        error: "ERROR_FORM_VIEW_FIELD_TYPE_IS_NOT_SUPPORTED",
        detail: `The ${fieldType} field type is not compatible with the form view.`,
      }, { status: 400 });
    }
    if (opts.allowed_select_options !== undefined) {
      if (!Array.isArray(opts.allowed_select_options) || opts.allowed_select_options.some((id: unknown) => !Number.isInteger(Number(id)))) {
        return Response.json({ error: "INVALID_REQUEST", detail: "allowed_select_options must be an array of integers." }, { status: 400 });
      }
      const ids = [...new Set(opts.allowed_select_options.map(Number))];
      if (!new Set(["single_select", "multiple_select"]).has(fieldType) && ids.length > 0) {
        return Response.json({ error: "INVALID_REQUEST", detail: "Only select fields can have allowed select options." }, { status: 400 });
      }
      if (ids.length > 0) {
        const valid = await db.prepare(
          `SELECT id FROM database_selectoption WHERE field_id=? AND id IN (${ids.map(() => "?").join(",")})`
        ).bind(fieldId, ...ids).all<{ id: number }>();
        if ((valid.results || []).length !== ids.length) {
          return Response.json({ error: "INVALID_REQUEST", detail: "An allowed select option does not belong to the field." }, { status: 400 });
        }
      }
    }
    if (opts.condition_groups !== undefined) {
      if (!Array.isArray(opts.condition_groups)) {
        return Response.json({ error: "INVALID_REQUEST", detail: "condition_groups must be an array." }, { status: 400 });
      }
      const seen = new Set<number>();
      for (const group of opts.condition_groups) {
        const id = Number(group?.id || 0);
        const parent = group?.parent_group === null || group?.parent_group === undefined ? null : Number(group.parent_group);
        if (parent !== null && !seen.has(parent)) {
          return Response.json({ error: "INVALID_REQUEST", detail: "Filter group references a non-existent parent group." }, { status: 400 });
        }
        if (id > 0) seen.add(id);
      }
    }
    if (opts.conditions !== undefined) {
      if (!Array.isArray(opts.conditions)) {
        return Response.json({ error: "INVALID_REQUEST", detail: "conditions must be an array." }, { status: 400 });
      }
      if (opts.conditions.some((condition: any) => !fieldById.has(Number(condition?.field)))) {
        return Response.json(UNRELATED_FIELD, { status: 400 });
      }
    }
  }

  return null;
}

async function filterFieldsAllowedInPublicForms(db: D1Database, rows: any[]): Promise<any[]> {
  if (rows.length === 0) return rows;
  const fieldIds = [...new Set(rows.map((row) => Number(row.id)).filter(Boolean))];
  if (fieldIds.length === 0) return rows;
  try {
    const denied = await db.prepare(
      `SELECT field_id FROM enterprise_fieldpermission
        WHERE allow_in_forms=0 AND field_id IN (${fieldIds.map(() => "?").join(",")})`
    ).bind(...fieldIds).all<{ field_id: number }>();
    const deniedIds = new Set((denied.results || []).map((row) => Number(row.field_id)));
    return rows.filter((row) => !deniedIds.has(Number(row.id)));
  } catch {
    return rows;
  }
}

async function getPublicVisibleFieldRows(db: D1Database, view: any): Promise<any[]> {
  if (view.type === "grid") {
    const rows = await db.prepare(
      `SELECT f.id, f.table_id, f.name, f.type, f.[order], f."primary" AS is_primary
       FROM database_field f
       JOIN database_gridviewfieldoptions o ON o.field_id=f.id AND o.grid_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND o.hidden=0
       ORDER BY f."primary" DESC, o.[order] ASC, f.id ASC`
    ).bind(view.id, view.table_id).all<any>();
    return rows.results || [];
  }

  if (view.type === "kanban") {
    const singleSelectFieldId = numberOrNull(view.single_select_field);
    const coverFieldId = numberOrNull(view.card_cover_image_field);
    const rows = await db.prepare(
      `SELECT f.id, f.table_id, f.name, f.type, f.[order], f."primary" AS is_primary
       FROM database_field f
       LEFT JOIN database_gridviewfieldoptions o ON o.field_id=f.id AND o.grid_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND (o.hidden=0 OR f.id=? OR f.id=?)
       ORDER BY COALESCE(o.[order], f.[order]) ASC, f.id ASC`
    ).bind(view.id, view.table_id, singleSelectFieldId, coverFieldId).all<any>();
    return rows.results || [];
  }

  if (view.type === "calendar") {
    const dateFieldId = numberOrNull(view.date_field);
    const rows = await db.prepare(
      `SELECT f.id, f.table_id, f.name, f.type, f.[order], f."primary" AS is_primary
       FROM database_field f
       LEFT JOIN database_gridviewfieldoptions o ON o.field_id=f.id AND o.grid_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND (o.hidden=0 OR f.id=?)
       ORDER BY COALESCE(o.[order], f.[order]) ASC, f.id ASC`
    ).bind(view.id, view.table_id, dateFieldId).all<any>();
    return rows.results || [];
  }

  if (view.type === "timeline") {
    const startDateFieldId = numberOrNull(view.start_date_field);
    const endDateFieldId = numberOrNull(view.end_date_field);
    const rows = await db.prepare(
      `SELECT f.id, f.table_id, f.name, f.type, f.[order], f."primary" AS is_primary
       FROM database_field f
       LEFT JOIN database_gridviewfieldoptions o ON o.field_id=f.id AND o.grid_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND (o.hidden=0 OR f.id=? OR f.id=?)
       ORDER BY COALESCE(o.[order], f.[order]) ASC, f.id ASC`
    ).bind(view.id, view.table_id, startDateFieldId, endDateFieldId).all<any>();
    return rows.results || [];
  }

  if (view.type === "gallery") {
    const coverFieldId = numberOrNull(view.card_cover_image_field);
    const rows = await db.prepare(
      `SELECT f.id, f.table_id, f.name, f.type, f.[order], f."primary" AS is_primary
       FROM database_field f
       LEFT JOIN database_galleryviewfieldoptions o ON o.field_id=f.id AND o.gallery_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND (o.hidden=0 OR f.id=?)
       ORDER BY COALESCE(o.[order], f.[order]) ASC, f.id ASC`
    ).bind(view.id, view.table_id, coverFieldId).all<any>();
    return rows.results || [];
  }

  if (view.type === "form") {
    const rows = await db.prepare(
      `SELECT f.id, f.table_id, f.name, f.type, f.[order], f."primary" AS is_primary
       FROM database_field f
       JOIN database_formviewfieldoptions o ON o.field_id=f.id AND o.form_view_id=?
       WHERE f.table_id=? AND f.trashed=0 AND o.enabled=1
       ORDER BY f."primary" DESC, o.[order] ASC, f.id ASC`
    ).bind(view.id, view.table_id).all<any>();
    return filterFieldsAllowedInPublicForms(db, rows.results || []);
  }

  return [];
}

async function getPublicVisibleFieldIds(db: D1Database, view: any): Promise<Set<number>> {
  const rows = await getPublicVisibleFieldRows(db, view);
  return new Set(rows.map((field) => Number(field.id)));
}

function serializePublicField(row: any): object {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    primary: Boolean(row.is_primary),
  };
}

function projectRowForFieldIds(row: Record<string, unknown>, fieldIds: Set<number>): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: row.id,
    order: row.order,
  };
  for (const fieldId of fieldIds) {
    const key = `field_${fieldId}`;
    if (key in row) projected[key] = row[key];
  }
  return projected;
}

function filterFieldOptionsByIds(
  fieldOptions: Record<number, object>,
  fieldIds: Set<number>
): Record<number, object> {
  const filtered: Record<number, object> = {};
  for (const [fieldId, options] of Object.entries(fieldOptions)) {
    if (fieldIds.has(Number(fieldId))) filtered[Number(fieldId)] = options;
  }
  return filtered;
}

function filterGroupByMetadataByFieldIds(metadata: Record<string, unknown[]>, fieldIds: Set<number>): Record<string, unknown[]> {
  const filtered: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const match = key.match(/^field_(\d+)$/);
    if (match && fieldIds.has(Number(match[1]))) filtered[key] = value;
  }
  return filtered;
}

function serializeDecoration(row: any): object {
  let valueProviderConf = {};
  try {
    valueProviderConf = row.value_provider_conf ? JSON.parse(row.value_provider_conf) : {};
  } catch {
    valueProviderConf = {};
  }
  return {
    id: row.id,
    view: row.view_id,
    type: row.type,
    value_provider_type: row.value_provider_type || "",
    value_provider_conf: valueProviderConf,
    order: row.order ?? 1,
  };
}

async function validateDecorationValues(
  db: D1Database,
  view: any,
  decorationType: unknown,
  providerType: unknown,
  providerConf: unknown
): Promise<Response | null> {
  const type = String(decorationType || "");
  const provider = String(providerType || "");
  if (!DECORATABLE_VIEW_TYPES.has(view.type)) {
    return Response.json({ error: "ERROR_VIEW_DECORATION_NOT_SUPPORTED", detail: "Decoration is not supported for the view type." }, { status: 400 });
  }
  if (!DECORATION_TYPES.has(type)) {
    return Response.json({ error: "INVALID_REQUEST", detail: "The decorator type does not exist." }, { status: 400 });
  }
  if (!DECORATION_VALUE_PROVIDER_TYPES.has(provider)) {
    return Response.json({ error: "INVALID_REQUEST", detail: "The decorator value provider type does not exist." }, { status: 400 });
  }
  if (!providerConf || typeof providerConf !== "object" || Array.isArray(providerConf)) {
    return Response.json({ error: "INVALID_REQUEST", detail: "value_provider_conf must be an object." }, { status: 400 });
  }
  const conf = providerConf as Record<string, any>;
  if (provider === "" && Object.keys(conf).length > 0) {
    return Response.json({ error: "INVALID_REQUEST", detail: "An empty value provider requires an empty configuration." }, { status: 400 });
  }
  if (provider === "single_select_color" && conf.field_id !== null) {
    if (!Number.isInteger(Number(conf.field_id))) {
      return Response.json({ error: "INVALID_REQUEST", detail: "The color provider field id must be an integer or null." }, { status: 400 });
    }
  }
  if (provider === "conditional_color") {
    if (!Array.isArray(conf.colors)) {
      return Response.json({ error: "INVALID_REQUEST", detail: "The conditional color provider requires a colors array." }, { status: 400 });
    }
    for (const color of conf.colors) {
      if (!color || typeof color !== "object" || typeof color.id !== "string" || typeof color.color !== "string" || !Array.isArray(color.filters)) {
        return Response.json({ error: "INVALID_REQUEST", detail: "A conditional color item is invalid." }, { status: 400 });
      }
      if (!new Set(["AND", "OR"]).has(String(color.operator || "AND").toUpperCase())) {
        return Response.json({ error: "INVALID_REQUEST", detail: "A conditional color operator must be AND or OR." }, { status: 400 });
      }
      const groupIds = new Set<string>();
      for (const group of Array.isArray(color.filter_groups) ? color.filter_groups : []) {
        if (!group || typeof group.id !== "string" || (group.parent_group !== null && group.parent_group !== undefined && !groupIds.has(String(group.parent_group)))) {
          return Response.json({ error: "INVALID_REQUEST", detail: "A conditional color filter group references an invalid parent." }, { status: 400 });
        }
        groupIds.add(group.id);
      }
      for (const filter of color.filters) {
        const field = await activeViewField(db, view, filter?.field);
        if (!filter || typeof filter.id !== "string" || typeof filter.type !== "string" || !field) {
          return Response.json({ error: "INVALID_REQUEST", detail: "A conditional color filter is invalid." }, { status: 400 });
        }
        if (filter.group !== null && filter.group !== undefined && !groupIds.has(String(filter.group))) {
          return Response.json({ error: "INVALID_REQUEST", detail: "A conditional color filter references an invalid group." }, { status: 400 });
        }
      }
    }
  }
  return null;
}

function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : [];
}

async function syncFormAllowedSelectOptions(
  db: D1Database,
  fieldId: number,
  optionId: number,
  values: unknown
): Promise<void> {
  const ids = numberList(values);
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(",");
    const valid = await db.prepare(
      `SELECT id FROM database_selectoption WHERE field_id=? AND id IN (${marks})`
    ).bind(fieldId, ...ids).all<any>();
    const validIds = new Set((valid.results || []).map((row: any) => Number(row.id)));
    for (const id of ids) {
      if (!validIds.has(id)) throw new ValidationError(`Select option ${id} does not belong to field ${fieldId}.`);
    }
  }

  await db.prepare("DELETE FROM database_formviewfieldoptions_allowedselectoptions WHERE form_view_field_options_id=?")
    .bind(optionId)
    .run();
  if (ids.length === 0) return;

  await db.batch(ids.map((id) =>
    db.prepare(
      `INSERT OR IGNORE INTO database_formviewfieldoptions_allowedselectoptions
       (form_view_field_options_id, select_option_id)
       VALUES (?, ?)`
    ).bind(optionId, id)
  ));
}

async function syncFormConditionGroups(
  db: D1Database,
  optionId: number,
  groups: unknown
): Promise<Map<number, number>> {
  const existing = await db.prepare(
    "SELECT * FROM database_formviewfieldoptionsconditiongroup WHERE field_option_id=? ORDER BY id ASC"
  ).bind(optionId).all<any>();
  const existingIds = new Set((existing.results || []).map((row: any) => Number(row.id)));
  const idMap = new Map<number, number>();
  for (const id of existingIds) idMap.set(id, id);

  if (!Array.isArray(groups)) return idMap;

  const keptIds = new Set<number>();
  for (const group of groups) {
    const raw = group as Record<string, unknown>;
    const sourceId = Number(raw.id || 0);
    const parentSourceId = raw.parent_group === null || raw.parent_group === undefined ? null : Number(raw.parent_group);
    const parentId = parentSourceId ? idMap.get(parentSourceId) ?? parentSourceId : null;
    const filterType = String(raw.filter_type || "AND").toUpperCase() === "OR" ? "OR" : "AND";

    if (sourceId > 0 && existingIds.has(sourceId)) {
      await db.prepare(
        `UPDATE database_formviewfieldoptionsconditiongroup
         SET filter_type=?, parent_group_id=?
         WHERE id=? AND field_option_id=?`
      ).bind(filterType, parentId, sourceId, optionId).run();
      keptIds.add(sourceId);
      idMap.set(sourceId, sourceId);
    } else {
      const created = await db.prepare(
        `INSERT INTO database_formviewfieldoptionsconditiongroup
         (field_option_id, filter_type, parent_group_id)
         VALUES (?, ?, ?)
         RETURNING id`
      ).bind(optionId, filterType, parentId).first<any>();
      const createdId = Number(created?.id);
      if (sourceId > 0 && createdId > 0) idMap.set(sourceId, createdId);
      if (createdId > 0) keptIds.add(createdId);
    }
  }

  const deleteIds = [...existingIds].filter((id) => !keptIds.has(id));
  if (deleteIds.length > 0) {
    await db.prepare(
      `DELETE FROM database_formviewfieldoptionsconditiongroup
       WHERE field_option_id=? AND id IN (${deleteIds.map(() => "?").join(",")})`
    ).bind(optionId, ...deleteIds).run();
  }
  return idMap;
}

async function syncFormConditions(
  db: D1Database,
  optionId: number,
  conditions: unknown,
  groupIdMap: Map<number, number>,
  tableFieldIds: Set<number>
): Promise<void> {
  if (!Array.isArray(conditions)) return;
  const existing = await db.prepare(
    "SELECT * FROM database_formviewfieldoptionscondition WHERE field_option_id=? ORDER BY id ASC"
  ).bind(optionId).all<any>();
  const existingIds = new Set((existing.results || []).map((row: any) => Number(row.id)));
  const keptIds = new Set<number>();

  for (const condition of conditions) {
    const raw = condition as Record<string, unknown>;
    const sourceId = Number(raw.id || 0);
    const fieldId = Number(raw.field);
    if (!tableFieldIds.has(fieldId)) throw new ValidationError(`Field ${fieldId} does not belong to this table.`);
    const groupSourceId = raw.group === null || raw.group === undefined ? null : Number(raw.group);
    const groupId = groupSourceId ? groupIdMap.get(groupSourceId) : null;
    if (groupSourceId && !groupId) throw new ValidationError("Invalid form field condition group.");

    if (sourceId > 0 && existingIds.has(sourceId)) {
      await db.prepare(
        `UPDATE database_formviewfieldoptionscondition
         SET field_id=?, type=?, value=?, group_id=?
         WHERE id=? AND field_option_id=?`
      ).bind(fieldId, String(raw.type || "contains"), String(raw.value ?? ""), groupId ?? null, sourceId, optionId).run();
      keptIds.add(sourceId);
    } else {
      const created = await db.prepare(
        `INSERT INTO database_formviewfieldoptionscondition
         (field_option_id, field_id, type, value, group_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id`
      ).bind(optionId, fieldId, String(raw.type || "contains"), String(raw.value ?? ""), groupId ?? null).first<any>();
      if (created?.id) keptIds.add(Number(created.id));
    }
  }

  const deleteIds = [...existingIds].filter((id) => !keptIds.has(id));
  if (deleteIds.length > 0) {
    await db.prepare(
      `DELETE FROM database_formviewfieldoptionscondition
       WHERE field_option_id=? AND id IN (${deleteIds.map(() => "?").join(",")})`
    ).bind(optionId, ...deleteIds).run();
  }
}

async function syncFormFieldOptionLogic(
  db: D1Database,
  view: any,
  fieldOptions: Record<string, any>
): Promise<void> {
  const fields = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND trashed=0")
    .bind(view.table_id)
    .all<any>();
  const tableFieldIds = new Set((fields.results || []).map((field: any) => Number(field.id)));
  const optionRows = await db.prepare("SELECT id, field_id FROM database_formviewfieldoptions WHERE form_view_id=?")
    .bind(view.id)
    .all<any>();
  const optionByField = new Map((optionRows.results || []).map((row: any) => [Number(row.field_id), Number(row.id)]));

  for (const [rawFieldId, opts] of Object.entries(fieldOptions || {})) {
    const fieldId = Number(rawFieldId);
    const optionId = optionByField.get(fieldId);
    if (!optionId) continue;
    if ("allowed_select_options" in opts) {
      await syncFormAllowedSelectOptions(db, fieldId, optionId, opts.allowed_select_options);
    }
    const groupMap = await syncFormConditionGroups(db, optionId, opts.condition_groups);
    await syncFormConditions(db, optionId, opts.conditions, groupMap, tableFieldIds);
  }
}

function rowIdsFromRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
}

async function getViewRowsPayload(
  db: D1Database,
  view: any,
  requestUrl: string,
  userId?: number,
  publicFieldIds?: Set<number>
) {
  const url = new URL(requestUrl);
  const queried = await queryViewRows(db, view, requestUrl, { visibleFieldIds: publicFieldIds });
  const total = queried.count;

  if (url.searchParams.get("count") === "true") {
    return { count: total };
  }

  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const include = new Set((url.searchParams.get("include") || "").split(",").map((item) => item.trim()).filter(Boolean));
  const excludeCount = url.searchParams.has("exclude_count");
  const pagedRows = queried.rows.slice(offset, offset + limit);
  const responseRows = publicFieldIds
    ? pagedRows.map((row) => projectRowForFieldIds(row, publicFieldIds))
    : pagedRows;
  const fieldOptions = include.has("field_options")
    ? publicFieldIds
      ? filterFieldOptionsByIds(await getViewFieldOptions(db, view), publicFieldIds)
      : await getViewFieldOptions(db, view)
    : {};
  const groupByMetadata = publicFieldIds
    ? filterGroupByMetadataByFieldIds(queried.groupByMetadata, publicFieldIds)
    : queried.groupByMetadata;
  const payload: Record<string, unknown> = excludeCount
    ? { results: responseRows }
    : {
      count: total,
      next: offset + limit < total ? `/api/database/views/${view.type}/${view.id}/?limit=${limit}&offset=${offset + limit}` : null,
      previous: offset > 0 ? `/api/database/views/${view.type}/${view.id}/?limit=${limit}&offset=${Math.max(0, offset - limit)}` : null,
      results: responseRows,
      field_options: fieldOptions,
    };
  if (excludeCount && include.has("field_options")) payload.field_options = fieldOptions;
  if (include.has("row_metadata")) payload.row_metadata = await buildRowMetadata(db, Number(view.table_id), rowIdsFromRows(pagedRows), userId);
  if (Object.keys(groupByMetadata).length > 0) payload.group_by_metadata = groupByMetadata;
  return payload;
}

async function getKanbanRowsPayload(
  db: D1Database,
  view: any,
  requestUrl: string,
  userId?: number,
  publicFieldIds?: Set<number>
) {
  const url = new URL(requestUrl);
  const include = new Set((url.searchParams.get("include") || "").split(",").map((item) => item.trim()).filter(Boolean));
  const queried = await queryViewRows(db, view, requestUrl, { visibleFieldIds: publicFieldIds });
  const singleSelectFieldId = numberOrNull(view.single_select_field);
  const fieldOptions = include.has("field_options")
    ? publicFieldIds
      ? filterFieldOptionsByIds(await getViewFieldOptions(db, view), publicFieldIds)
      : await getViewFieldOptions(db, view)
    : {};
  const groupByMetadata = publicFieldIds
    ? filterGroupByMetadataByFieldIds(queried.groupByMetadata, publicFieldIds)
    : queried.groupByMetadata;
  if (!singleSelectFieldId) {
    return {
      rows: {},
      field_options: fieldOptions,
      row_metadata: include.has("row_metadata") ? {} : undefined,
    };
  }

  const options = await getSelectOptions(db, singleSelectFieldId);
  const stackIds = [null, ...options.map((option: any) => Number(option.id))];
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const requestedRanges = requestedSelectOptionRanges(url);
  const ranges = requestedRanges.length > 0
    ? requestedRanges
    : stackIds.map((id) => ({ id, limit, offset: Math.max(0, Number(url.searchParams.get("offset") || 0)) }));

  const byStack = new Map<number | null, Array<Record<string, unknown>>>();
  for (const id of stackIds) byStack.set(id, []);
  for (const row of queried.rows) {
    const optionId = selectOptionIdFromValue(row[`field_${singleSelectFieldId}`]);
    const stackId = stackIds.includes(optionId) ? optionId : null;
    byStack.get(stackId)?.push(row);
  }

  const rows: Record<string, object> = {};
  for (const range of ranges) {
    if (!stackIds.includes(range.id)) continue;
    const all = byStack.get(range.id) || [];
    const sliceLimit = range.limit ?? limit;
    rows[String(range.id)] = {
      count: all.length,
      results: publicFieldIds
        ? all.slice(range.offset, range.offset + sliceLimit).map((row) => projectRowForFieldIds(row, publicFieldIds))
        : all.slice(range.offset, range.offset + sliceLimit),
    };
  }

  const returnedRows = Object.values(rows).flatMap((stack: any) => Array.isArray(stack.results) ? stack.results : []);
  const payload: Record<string, unknown> = { rows };
  if (include.has("field_options")) payload.field_options = fieldOptions;
  if (include.has("row_metadata")) payload.row_metadata = await buildRowMetadata(db, Number(view.table_id), rowIdsFromRows(returnedRows), userId);
  if (Object.keys(groupByMetadata).length > 0) payload.group_by_metadata = groupByMetadata;
  return payload;
}

async function getCalendarRowsPayload(
  db: D1Database,
  view: any,
  requestUrl: string,
  userId?: number,
  publicFieldIds?: Set<number>
) {
  const url = new URL(requestUrl);
  const include = new Set((url.searchParams.get("include") || "").split(",").map((item) => item.trim()).filter(Boolean));
  const queried = await queryViewRows(db, view, requestUrl, { visibleFieldIds: publicFieldIds });
  const dateFieldId = numberOrNull(view.date_field);
  if (!dateFieldId) {
    return {
      error: "ERROR_CALENDAR_VIEW_HAS_NO_DATE_FIELD",
      detail: "The calendar view has no date field configured.",
      status: 400,
    };
  }

  const limit = calendarLimit(url);
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const from = requiredCalendarTimestamp(url, "from_timestamp");
  const to = requiredCalendarTimestamp(url, "to_timestamp");
  assertCalendarRange(from, to);
  const userTimeZone = url.searchParams.get("user_timezone") || "UTC";
  assertValidTimeZone(userTimeZone);
  const dateField = queried.fields.find((field) => Number(field.id) === dateFieldId);
  const dateFieldIncludesTime = dateField?.settings?.date_include_time === true;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const fromDateKey = dateKeyFromDate(from);
  const toDateKey = dateKeyFromDate(to);

  const rows: Record<string, { count: number; results: Array<Record<string, unknown>> }> = {};
  for (const row of queried.rows) {
    const value = row[`field_${dateFieldId}`];
    const key = calendarRowDateKey(value, dateField, userTimeZone);
    if (!key) continue;
    if (dateFieldIncludesTime) {
      const parsedDate = parseDateValue(value);
      if (!parsedDate) continue;
      const dateMs = parsedDate.getTime();
      if (dateMs < fromMs || dateMs >= toMs) continue;
    } else if (key < fromDateKey || key > toDateKey) {
      continue;
    }
    if (!rows[key]) rows[key] = { count: 0, results: [] };
    rows[key].count += 1;
    if (rows[key].results.length < offset + limit) rows[key].results.push(row);
  }
  for (const stack of Object.values(rows)) {
    stack.results = stack.results.slice(offset, offset + limit);
    if (publicFieldIds) {
      stack.results = stack.results.map((row) => projectRowForFieldIds(row, publicFieldIds));
    }
  }

  const returnedRows = Object.values(rows).flatMap((stack) => stack.results);
  const fieldOptions = include.has("field_options")
    ? publicFieldIds
      ? filterFieldOptionsByIds(await getViewFieldOptions(db, view), publicFieldIds)
      : await getViewFieldOptions(db, view)
    : {};
  const groupByMetadata = publicFieldIds
    ? filterGroupByMetadataByFieldIds(queried.groupByMetadata, publicFieldIds)
    : queried.groupByMetadata;
  const payload: Record<string, unknown> = { rows };
  if (include.has("field_options")) payload.field_options = fieldOptions;
  if (include.has("row_metadata")) payload.row_metadata = await buildRowMetadata(db, Number(view.table_id), rowIdsFromRows(returnedRows), userId);
  if (Object.keys(groupByMetadata).length > 0) payload.group_by_metadata = groupByMetadata;
  return payload;
}

async function buildCalendarIcalFeed(db: D1Database, view: any, publicUrl?: string): Promise<string> {
  const dateFieldId = numberOrNull(view.date_field);
  if (!dateFieldId) throw new ValidationError("The calendar view has no date field configured.");

  const queried = await queryViewRows(db, view, `${normalizePublicUrl(publicUrl)}/api/database/views/calendar/${view.id}/`);
  const fields = queried.fields;
  const dateField = fields.find((field) => field.id === dateFieldId);
  const now = icsDateTime(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Supertask//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(view.name || "Calendar")}`,
  ];

  for (const row of queried.rows) {
    const rawDate = row[`field_${dateFieldId}`];
    const start = parseDateValue(rawDate);
    if (!start) continue;
    const hasTime = isDateTimeField(dateField, rawDate);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:supertask-view-${view.id}-row-${row.id}@supertask`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`SUMMARY:${icsEscape(rowTitle(row, fields))}`);
    lines.push(`URL:${normalizePublicUrl(publicUrl)}/database/${view.database_id}/table/${view.table_id}/${view.id}?row_id=${row.id}`);
    if (hasTime) {
      lines.push(`DTSTART:${icsDateTime(start)}`);
      lines.push(`DTEND:${icsDateTime(addDays(start, 1))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(start)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(addDays(start, 1))}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/** Member-only lookup by numeric id, for the non-public row and aggregation routes. */
async function getTypedViewForRows(db: D1Database, type: string, viewId: string, userId?: number) {
  const byId = Number(viewId);
  if (!Number.isInteger(byId) || byId <= 0) throw new DoesNotExist(`${type} view`, viewId);
  const view = (await getViewWithAccess(db, byId, userId, true)).view;
  if (view.type !== type) throw new DoesNotExist(`${type} view`, viewId);
  return view;
}

/**
 * Lookup by id or public slug. Only for `/public/` routes, which must then call
 * `publicViewAuthorizationResponse` and restrict output to the public fields.
 */
async function getPublicTypedView(db: D1Database, type: string, idOrSlug: string, userId?: number) {
  const byId = Number(idOrSlug);
  if (Number.isInteger(byId) && byId > 0) return getTypedViewForRows(db, type, idOrSlug, userId);
  const view = await db.prepare("SELECT * FROM database_view WHERE slug=? AND type=? AND public=1 AND trashed=0")
    .bind(idOrSlug, type)
    .first<any>();
  if (!view) throw new DoesNotExist(`${type} view`, idOrSlug);
  return view;
}

function scalarAggregationNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function aggregationValueKey(value: unknown): string {
  if (value === null || value === undefined) return "__empty__";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formulaResultType(field: any): string {
  return formulaAggregationType(field.field_settings);
}

function isAggregationEmpty(field: any, value: unknown): boolean {
  const fieldType = String(field.type);
  if (fieldType === "boolean" || (fieldType === "formula" && formulaResultType(field) === "boolean")) {
    return value !== true;
  }
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function sortedNumericValues(rows: Array<Record<string, unknown>>, fieldId: number): number[] {
  return rows
    .map((row) => scalarAggregationNumber(row[`field_${fieldId}`]))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
}

function percentile(sortedValues: number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function aggregateConfiguredField(rows: Array<Record<string, unknown>>, field: any, rawType: string): unknown {
  const fieldId = Number(field.id);
  const values = rows.map((row) => row[`field_${fieldId}`]);
  const emptyCount = values.filter((value) => isAggregationEmpty(field, value)).length;

  if (rawType === "count") return rows.length;
  if (rawType === "empty_count") return emptyCount;
  if (rawType === "not_empty_count") return rows.length - emptyCount;
  if (rawType === "unique_count") {
    return new Set(values.filter((value) => value !== null && value !== undefined).map(aggregationValueKey)).size;
  }
  if (rawType === "distribution") {
    const distribution = new Map<string, { value: unknown; count: number }>();
    for (const value of values) {
      const key = aggregationValueKey(value);
      const current = distribution.get(key);
      if (current) current.count += 1;
      else distribution.set(key, { value: isAggregationEmpty(field, value) ? "" : value, count: 1 });
    }
    return [...distribution.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, 10)
      .map((entry) => [entry.value, entry.count]);
  }

  const numericValues = sortedNumericValues(rows, fieldId);
  if (["sum", "average", "std_dev", "variance", "median", "decile"].includes(rawType)) {
    if (numericValues.length === 0) return rawType === "sum" ? 0 : null;
    const sum = numericValues.reduce((total, value) => total + value, 0);
    if (rawType === "sum") return sum;
    if (rawType === "average") return sum / numericValues.length;
    const mean = sum / numericValues.length;
    const variance = numericValues.reduce((total, value) => total + ((value - mean) ** 2), 0) / numericValues.length;
    if (rawType === "variance") return variance;
    if (rawType === "std_dev") return Math.sqrt(variance);
    if (rawType === "median") return percentile(numericValues, 0.5);
    return Array.from({ length: 9 }, (_, index) => percentile(numericValues, (index + 1) / 10));
  }

  if (rawType === "min" || rawType === "max") {
    if (numericValues.length > 0) return rawType === "min" ? numericValues[0] : numericValues[numericValues.length - 1];
    const comparable = values
      .filter((value): value is string => typeof value === "string" && value !== "")
      .sort();
    if (comparable.length === 0) return null;
    return rawType === "min" ? comparable[0] : comparable[comparable.length - 1];
  }

  return null;
}

async function getFieldAggregations(db: D1Database, view: any, requestUrl: string, publicFieldIds?: Set<number>) {
  const optionRows = await db.prepare(
    `SELECT f.id, f.type, f.field_settings, o.aggregation_raw_type
       FROM database_gridviewfieldoptions o
       JOIN database_field f ON f.id=o.field_id
      WHERE o.grid_view_id=? AND f.table_id=? AND f.trashed=0 AND o.hidden=0
        AND COALESCE(o.aggregation_raw_type, '') != ''
      ORDER BY o.[order] ASC, f.id ASC`
  ).bind(view.id, view.table_id).all<any>();

  const configuredFields = (optionRows.results || [])
    .filter((field: any) => !publicFieldIds || publicFieldIds.has(Number(field.id)))
    .filter((field: any) => GRID_VIEW_ALLOWED_AGGREGATION_RAW_TYPES.has(String(field.aggregation_raw_type)));
  const queried = await queryViewRows(db, view, requestUrl, { visibleFieldIds: publicFieldIds });
  const result: Record<string, unknown> = {};

  for (const field of configuredFields) {
    const rawType = String(field.aggregation_raw_type);
    if (!gridAggregationSupportsField(rawType, field)) continue;
    result[`field_${field.id}`] = aggregateConfiguredField(queried.rows, field, rawType);
  }

  const include = new Set((new URL(requestUrl).searchParams.get("include") || "").split(",").map((item) => item.trim()).filter(Boolean));
  if (include.has("total")) {
    result.total = queried.count;
  }

  return result;
}

async function getSingleFieldAggregation(db: D1Database, view: any, fieldId: number, rawType: string, requestUrl: string) {
  if (!Number.isInteger(fieldId) || fieldId <= 0) {
    return { status: 404, ...FIELD_DOES_NOT_EXIST };
  }
  if (!rawType || !GRID_VIEW_ALLOWED_AGGREGATION_RAW_TYPES.has(rawType)) {
    return { status: 400, ...AGGREGATION_TYPE_DOES_NOT_EXIST };
  }

  const field = await db.prepare(
    `SELECT id, table_id, type, field_settings
       FROM database_field
      WHERE id=? AND trashed=0`
  ).bind(fieldId).first<any>();
  if (!field) return { status: 404, ...FIELD_DOES_NOT_EXIST };
  if (Number(field.table_id) !== Number(view.table_id)) {
    return { status: 400, ...FIELD_NOT_IN_TABLE };
  }
  if (!gridAggregationSupportsField(rawType, field)) {
    return { status: 400, ...AGGREGATION_DOES_NOT_SUPPORTED_FIELD };
  }

  const queried = await queryViewRows(db, view, requestUrl);
  const result: Record<string, unknown> = {
    value: aggregateConfiguredField(queried.rows, field, rawType),
  };
  const include = new Set((new URL(requestUrl).searchParams.get("include") || "").split(",").map((item) => item.trim()).filter(Boolean));
  if (include.has("total")) {
    result.total = queried.count;
  }
  return result;
}

// ── GET /api/database/views/table/:tableId/ ───────────────────────────────────
views.get("/table/:tableId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const tableId = parseInt(c.req.param("tableId"));

  // Verify access
  const table = await c.env.DB.prepare(
    `SELECT t.id, t.database_id, a.workspace_id FROM database_table t
     JOIN core_application a ON a.id = t.database_id
     WHERE t.id = ? AND t.trashed = 0`
  ).bind(tableId).first<any>();
  if (!table) throw new DoesNotExist("Table", tableId);

  const templateRead = await isTemplateWorkspace(c.env.DB, table.workspace_id);
  if (!templateRead) {
    await assertHasTableRole(c.env.DB, user?.id, table, "VIEWER");
  }

  const requestedType = c.req.query("type");
  if (requestedType && !VALID_VIEW_TYPES.has(requestedType)) {
    throw new ValidationError(`Invalid view type: ${requestedType}`);
  }
  const normalizedType = requestedType === "survey" ? "form" : requestedType;
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? null : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    throw new ValidationError("limit must be a non-negative integer.");
  }
  const res = await c.env.DB.prepare(
    `SELECT * FROM database_view
     WHERE table_id=? AND trashed=0${normalizedType ? " AND type=?" : ""}
     ORDER BY [order] ASC${limit !== null ? " LIMIT ?" : ""}`
  ).bind(
    tableId,
    ...(normalizedType ? [normalizedType] : []),
    ...(limit !== null ? [limit] : [])
  ).all<any>();

  const include = c.req.query("include") || "";
  const candidates = (res.results || [])
    .filter((view) => view.ownership_type !== "personal" || Number(view.owned_by_id) === user?.id);
  const visible = await Promise.all(candidates.map(async (view) => {
    if (templateRead) return true;
    try {
      await assertHasViewRole(c.env.DB, user?.id, Number(view.id), "VIEWER");
      return true;
    } catch (error) {
      if (error instanceof PermissionError) return false;
      throw error;
    }
  }));
  const visibleViews = candidates.filter((_, index) => visible[index]);
  const serialized = await Promise.all(visibleViews.map((view) => serializeViewWithIncludes(c.env.DB, view, include, c.env.PUBLIC_URL, user?.id)));
  return c.json(serialized);
});

// ── POST /api/database/views/table/:tableId/ — Create view ────────────────────
views.post("/table/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  const body = await c.req.json<{ name: string; type?: string; ownership_type?: string }>();

  const table = await c.env.DB.prepare(
    `SELECT t.id, t.database_id, a.workspace_id FROM database_table t
     JOIN core_application a ON a.id = t.database_id
     WHERE t.id = ? AND t.trashed = 0`
  ).bind(tableId).first<any>();
  if (!table) throw new DoesNotExist("Table", tableId);

  if (!body.name?.trim()) throw new ValidationError("name is required.");

  const ownershipType = body.ownership_type || "collaborative";
  if (ownershipType !== "collaborative" && ownershipType !== "personal") {
    throw new ValidationError(`Invalid view ownership type: ${ownershipType}`);
  }
  await assertHasTableRole(c.env.DB, user.id, table, ownershipType === "personal" ? "VIEWER" : "BUILDER");

  const now = new Date().toISOString();
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const requestedViewType = body.type || "grid";
  if (!VALID_VIEW_TYPES.has(requestedViewType)) {
    throw new ValidationError(`Invalid view type: ${requestedViewType}`);
  }
  const viewType = requestedViewType === "survey" ? "form" : requestedViewType;
  const formMode = requestedViewType === "survey" ? "survey" : "form";

  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX([order]), 0) as mo FROM database_view WHERE table_id=?`
  ).bind(tableId).first<{ mo: number }>();

  const res = await c.env.DB.prepare(
    `INSERT INTO database_view (table_id, name, type, [order], filter_type, public,
     public_view_password, slug, trashed, created_on, updated_on,
     row_identifier_type, ownership_type, owned_by_id, row_height_size, filters_disabled)
     VALUES (?,?,?,?,'AND',0,0,?,0,?,?,'count',?,?,'small',0) RETURNING *`
  ).bind(tableId, body.name.trim(), viewType, (maxOrder?.mo ?? 0) + 1, slug, now, now, ownershipType, user.id)
    .first<any>();

  if (!res) throw new Error("Failed to create view");

  const fields = await c.env.DB.prepare(
    `SELECT id, type FROM database_field WHERE table_id=? AND trashed=0 ORDER BY "primary" DESC, id ASC`
  ).bind(tableId).all<any>();

  if (viewType === "grid") {
    const stmts = (fields.results || []).map((f: any, i: number) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order])
         VALUES (?,?,200,0,?)`
      ).bind(res.id, f.id, (i + 1) * 32768)
    );
    if (stmts.length > 0) await c.env.DB.batch(stmts);
  }

  if (viewType === "gallery") {
    const stmts = (fields.results || []).map((f: any, i: number) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO database_galleryviewfieldoptions (gallery_view_id, field_id, hidden, [order])
         VALUES (?,?,?,?)`
      ).bind(res.id, f.id, i < 3 ? 0 : 1, (i + 1) * 32768)
    );
    if (stmts.length > 0) await c.env.DB.batch(stmts);
  }

  if (viewType === "form") {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO database_formview
       (view_ptr_id, title, description, submit_text, submit_action,
        submit_action_message, submit_action_redirect_url, mode, show_logo)
       VALUES (?, '', '', 'Submit', 'MESSAGE', '', '', 'form', 1)`
    ).bind(res.id).run();
    if (formMode === "survey") {
      await c.env.DB.prepare("UPDATE database_formview SET mode='survey' WHERE view_ptr_id=?").bind(res.id).run();
    }

    const stmts = (fields.results || []).map((f: any, i: number) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO database_formviewfieldoptions
         (form_view_id, field_id, name, description, enabled, required, [order],
          show_when_matching_conditions, condition_type, include_all_select_options, field_component)
         VALUES (?, ?, '', '', 0, 1, ?, 0, 'AND', 1, 'default')`
      ).bind(res.id, f.id, (i + 1) * 32768)
    );
    if (stmts.length > 0) await c.env.DB.batch(stmts);
  }

  if (PREMIUM_FIELD_OPTION_VIEW_TYPES.has(viewType)) {
    await ensureGridFieldOptionsForView(
      c.env.DB,
      res.id,
      fields.results || [],
      viewType === "kanban" ? 3 : 1
    );
  }

  const created = await c.env.DB.prepare("SELECT * FROM database_view WHERE id=?").bind(res.id).first<any>();
  const createdSnapshot = await snapshotViewForUndoRedo(c.env.DB, res.id);
  await createUndoableAction(c.env.DB, {
    user,
    actionType: "create_view",
    params: { view_id: res.id, table_id: tableId, before: null, after: createdSnapshot },
    ...viewActionContext(c, tableId),
  });
  const serialized = await serializeViewWithIncludes(c.env.DB, created || res, "", c.env.PUBLIC_URL, user.id);
  await broadcastToWorkspace(c.env, table.workspace_id, {
    type: "view_created",
    view: serialized,
    table_id: tableId,
  });
  const audit = await viewAuditDetails(c.env.DB, res.id);
  await logAuditEntry(c.env.DB, "database.view.create", {
    user,
    workspace_id: table.workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: res.id, type: "view" }, {
    database_id: table.database_id,
    table_id: tableId,
    table_name: audit?.table_name,
    view_id: res.id,
    view_name: audit?.view_name || body.name.trim(),
    view_type: audit?.view_type || viewType,
  });
  c.executionCtx.waitUntil(triggerTableWebhooks(c.env, tableId, "view.created", { view: serialized }));

  return c.json(serialized, 200);
});

// ── GET /api/database/views/grid/:viewId/ — Grid rows ────────────────────────
views.get("/grid/:viewId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewId = Number(c.req.param("viewId"));
  const { view } = await getViewWithAccess(c.env.DB, viewId, user?.id, true);
  if (view.type !== "grid") throw new DoesNotExist("Grid view", viewId);
  return c.json(await getViewRowsPayload(c.env.DB, view, c.req.url, user?.id));
});

views.get("/grid/:viewId/public/rows/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const view = await getPublicTypedView(c.env.DB, "grid", c.req.param("viewId"), user?.id);
  const authError = await publicViewAuthorizationResponse(c, view);
  if (authError) return authError;
  const publicFieldIds = await getPublicVisibleFieldIds(c.env.DB, view);
  return c.json(await getViewRowsPayload(c.env.DB, view, c.req.url, user?.id, publicFieldIds));
});

views.get("/gallery/:viewId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const view = await getTypedViewForRows(c.env.DB, "gallery", c.req.param("viewId"), user?.id);
  return c.json(await getViewRowsPayload(c.env.DB, view, c.req.url, user?.id));
});

views.get("/gallery/:viewId/public/rows/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const view = await getPublicTypedView(c.env.DB, "gallery", c.req.param("viewId"), user?.id);
  const authError = await publicViewAuthorizationResponse(c, view);
  if (authError) return authError;
  const publicFieldIds = await getPublicVisibleFieldIds(c.env.DB, view);
  return c.json(await getViewRowsPayload(c.env.DB, view, c.req.url, user?.id, publicFieldIds));
});

for (const premiumType of ["kanban", "calendar", "timeline"] as const) {
  views.get(`/${premiumType}/:viewId/`, optionalAuthMiddleware, async (c) => {
    const user = c.get("user");
    const view = await getTypedViewForRows(c.env.DB, premiumType, c.req.param("viewId"), user?.id);
    if (premiumType === "kanban") return c.json(await getKanbanRowsPayload(c.env.DB, view, c.req.url, user?.id));
    if (premiumType === "calendar") {
      const payload = await getCalendarRowsPayload(c.env.DB, view, c.req.url, user?.id);
      if ("status" in payload) return c.json({ error: payload.error, detail: payload.detail }, payload.status as 400);
      return c.json(payload);
    }
    if (premiumType === "timeline") {
      const invalidTimeline = await validateTimelineDateSettings(c.env.DB, view);
      if (invalidTimeline) return invalidTimeline;
    }
    return c.json(await getViewRowsPayload(c.env.DB, view, c.req.url, user?.id));
  });

  views.get(`/${premiumType}/:viewId/public/rows/`, optionalAuthMiddleware, async (c) => {
    const user = c.get("user");
    const view = await getPublicTypedView(c.env.DB, premiumType, c.req.param("viewId"), user?.id);
    const authError = await publicViewAuthorizationResponse(c, view);
    if (authError) return authError;
    const publicFieldIds = await getPublicVisibleFieldIds(c.env.DB, view);
    if (premiumType === "kanban") return c.json(await getKanbanRowsPayload(c.env.DB, view, c.req.url, user?.id, publicFieldIds));
    if (premiumType === "calendar") {
      const payload = await getCalendarRowsPayload(c.env.DB, view, c.req.url, user?.id, publicFieldIds);
      if ("status" in payload) return c.json({ error: payload.error, detail: payload.detail }, payload.status as 400);
      return c.json(payload);
    }
    if (premiumType === "timeline") {
      const invalidTimeline = await validateTimelineDateSettings(c.env.DB, view);
      if (invalidTimeline) return invalidTimeline;
    }
    return c.json(await getViewRowsPayload(c.env.DB, view, c.req.url, user?.id, publicFieldIds));
  });
}

views.post("/grid/:viewId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const view = await getTypedViewForRows(c.env.DB, "grid", c.req.param("viewId"), user?.id);
  const body = await c.req.json<{ row_ids?: number[]; field_ids?: number[] }>();
  if (!Array.isArray(body.row_ids) || body.row_ids.length === 0 || body.row_ids.some((id) => !Number.isInteger(Number(id)))) {
    throw new ValidationError("row_ids must be a non-empty array of integers.");
  }
  if (body.field_ids !== undefined && (!Array.isArray(body.field_ids) || body.field_ids.length === 0 || body.field_ids.some((id) => !Number.isInteger(Number(id))))) {
    throw new ValidationError("field_ids must be a non-empty array of integers.");
  }
  const fields = (await getActiveFields(c.env.DB, Number(view.table_id)))
    .filter((field) => !body.field_ids?.length || body.field_ids.includes(Number(field.id)));
  const rowIds = (body.row_ids || []).map(Number).filter(Boolean);
  await ensureUserTableSystemColumns(c.env.DB, Number(view.table_id));
  const bindMarks = rowIds.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT * FROM "database_table_${view.table_id}" WHERE COALESCE(trashed, 0)=0 AND id IN (${bindMarks}) ORDER BY [order] ASC, id ASC`
  ).bind(...rowIds).all<Record<string, unknown>>();
  return c.json(await serializeRowsForViewWithComputed(c.env.DB, rows.results || [], fields));
});

views.get("/grid/:viewId/aggregations/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const view = await getTypedViewForRows(c.env.DB, "grid", c.req.param("viewId"), user?.id);
  return c.json(await getFieldAggregations(c.env.DB, view, c.req.url));
});

views.get("/grid/:viewId/aggregation/:fieldId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const view = await getTypedViewForRows(c.env.DB, "grid", c.req.param("viewId"), user?.id);
  const payload = await getSingleFieldAggregation(
    c.env.DB,
    view,
    Number(c.req.param("fieldId")),
    c.req.query("type") || "",
    c.req.url
  );
  if ("status" in payload) {
    return c.json({ error: payload.error, detail: payload.detail }, payload.status as any);
  }
  return c.json(payload);
});

views.get("/grid/:viewId/public/aggregations/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const view = await getPublicTypedView(c.env.DB, "grid", c.req.param("viewId"), user?.id);
  const authError = await publicViewAuthorizationResponse(c, view);
  if (authError) return authError;
  const publicFieldIds = await getPublicVisibleFieldIds(c.env.DB, view);
  return c.json(await getFieldAggregations(c.env.DB, view, c.req.url, publicFieldIds));
});

views.post("/calendar/:viewId/ical_slug_rotate/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = Number(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  await assertHasTableRole(c.env.DB, user.id, {
    id: Number(view.table_id), database_id: Number(view.database_id), workspace_id: Number(view.workspace_id),
  }, "BUILDER");
  if (view.type !== "calendar") throw new DoesNotExist("Calendar view", viewId);
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  await c.env.DB.prepare("UPDATE database_view SET ical_slug=?, updated_on=? WHERE id=?")
    .bind(slug, new Date().toISOString(), viewId)
    .run();
  const updated = await c.env.DB.prepare("SELECT * FROM database_view WHERE id=?").bind(viewId).first<any>();
  const serialized = await serializeViewWithIncludes(c.env.DB, updated!, "", c.env.PUBLIC_URL, user.id);
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  await broadcastToWorkspace(c.env, workspace_id, { type: "view_updated", view: serialized });
  return c.json(serialized);
});

views.get("/calendar/:icalSlugFile", async (c) => {
  const fileName = c.req.param("icalSlugFile");
  if (!fileName.endsWith(".ics")) throw new DoesNotExist("Calendar iCal feed", fileName);
  const slug = fileName.slice(0, -4);
  const view = await c.env.DB.prepare(
    `SELECT v.*, t.database_id, a.workspace_id
     FROM database_view v
     JOIN database_table t ON t.id = v.table_id
     JOIN core_application a ON a.id = t.database_id
     WHERE v.ical_slug=? AND v.type='calendar' AND v.ical_public=1 AND v.trashed=0`
  ).bind(slug).first<any>();
  if (!view) throw new DoesNotExist("Calendar iCal feed", slug);
  await assertPersonalPublicViewOwnerCanShare(c.env.DB, view);
  const content = await buildCalendarIcalFeed(c.env.DB, view, c.env.PUBLIC_URL);
  return c.body(content, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "max-age=1800",
  });
});

// ── GET /api/database/views/:viewId/ ─────────────────────────────────────────
views.get("/:viewId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewId = parseInt(c.req.param("viewId"));
  const { view } = await getViewWithAccess(c.env.DB, viewId, user?.id, true);
  return c.json(await serializeViewWithIncludes(c.env.DB, view, c.req.query("include") || "", c.env.PUBLIC_URL, user?.id));
});

// ── PATCH /api/database/views/:viewId/ ───────────────────────────────────────
views.patch("/:viewId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = parseInt(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  const body = await c.req.json<any>();
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);

  if (body.ownership_type !== undefined && body.ownership_type !== "collaborative" && body.ownership_type !== "personal") {
    throw new ValidationError(`Invalid view ownership type: ${String(body.ownership_type)}`);
  }
  if (
    view.ownership_type === "personal" &&
    (body.ownership_type === "collaborative" || body.public !== undefined || body.public_view_password !== undefined || body.allow_public_export !== undefined)
  ) {
    await assertHasTableRole(c.env.DB, user.id, {
      id: Number(view.table_id), database_id: Number(view.database_id), workspace_id: Number(view.workspace_id),
    }, "BUILDER");
  }

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.name !== undefined) { sets.push("name=?"); vals.push(body.name); }
  if (body.filter_type !== undefined) { sets.push("filter_type=?"); vals.push(body.filter_type); }
  if (body.filters_disabled !== undefined) { sets.push("filters_disabled=?"); vals.push(body.filters_disabled ? 1 : 0); }
  if (body.public !== undefined) { sets.push("public=?"); vals.push(body.public ? 1 : 0); }
  if (body.show_logo !== undefined) { sets.push("show_logo=?"); vals.push(body.show_logo ? 1 : 0); }
  if (body.allow_public_export !== undefined) { sets.push("allow_public_export=?"); vals.push(body.allow_public_export ? 1 : 0); }
  if (body.public_view_password !== undefined) {
    // Stored hashed like Baserow (make_password); an empty value removes it.
    sets.push("public_view_password=?");
    vals.push(body.public_view_password ? await hashPassword(String(body.public_view_password)) : null);
  }
  if (body.row_height_size !== undefined) { sets.push("row_height_size=?"); vals.push(body.row_height_size); }
  if (body.ownership_type !== undefined && body.ownership_type !== view.ownership_type) {
    sets.push("ownership_type=?", "owned_by_id=?");
    vals.push(body.ownership_type, user.id);
  }
  if (view.type === "gallery" && body.card_cover_image_field !== undefined) {
    const invalidCardCover = await validateCardCoverImagePatchValue(c.env.DB, view, body.card_cover_image_field);
    if (invalidCardCover) return invalidCardCover;
    sets.push("card_cover_image_field=?");
    vals.push(numberOrNull(body.card_cover_image_field));
  }
  if (view.type === "kanban") {
    const invalidKanban = await validateKanbanPatchValues(c.env.DB, view, body);
    if (invalidKanban) return invalidKanban;
    if (body.single_select_field !== undefined) {
      sets.push("single_select_field=?");
      vals.push(numberOrNull(body.single_select_field));
    }
    if (body.card_cover_image_field !== undefined) {
      sets.push("card_cover_image_field=?");
      vals.push(numberOrNull(body.card_cover_image_field));
    }
  }
  if (view.type === "calendar") {
    const invalidCalendar = await validateCalendarPatchValues(c.env.DB, view, body);
    if (invalidCalendar) return invalidCalendar;
    if (body.date_field !== undefined) { sets.push("date_field=?"); vals.push(numberOrNull(body.date_field)); }
    if (body.ical_public !== undefined) {
      sets.push("ical_public=?");
      vals.push(body.ical_public ? 1 : 0);
      if (body.ical_public && !view.ical_slug) {
        sets.push("ical_slug=?");
        vals.push(crypto.randomUUID().replace(/-/g, "").slice(0, 20));
      }
    }
  }
  if (view.type === "timeline") {
    const invalidTimeline = await validateTimelinePatchValues(c.env.DB, view, body);
    if (invalidTimeline) return invalidTimeline;
    if (body.start_date_field !== undefined) { sets.push("start_date_field=?"); vals.push(numberOrNull(body.start_date_field)); }
    if (body.end_date_field !== undefined) { sets.push("end_date_field=?"); vals.push(numberOrNull(body.end_date_field)); }
    if (body.timescale !== undefined) { sets.push("timescale=?"); vals.push(String(body.timescale || "month")); }
  }

  if (sets.length > 0) {
    sets.push("updated_on=?");
    vals.push(new Date().toISOString());
    vals.push(viewId);
    await c.env.DB.prepare(`UPDATE database_view SET ${sets.join(",")} WHERE id=?`)
      .bind(...vals).run();
  }

  if (view.type === "form") {
    const formUpdates: string[] = [];
    const formVals: unknown[] = [];
    if (body.title !== undefined) { formUpdates.push("title=?"); formVals.push(String(body.title || "")); }
    if (body.description !== undefined) { formUpdates.push("description=?"); formVals.push(String(body.description || "")); }
    if (body.submit_text !== undefined) { formUpdates.push("submit_text=?"); formVals.push(String(body.submit_text || "Submit")); }
    if (body.submit_action !== undefined) { formUpdates.push("submit_action=?"); formVals.push(String(body.submit_action || "MESSAGE")); }
    if (body.submit_action_message !== undefined) { formUpdates.push("submit_action_message=?"); formVals.push(String(body.submit_action_message || "")); }
    if (body.submit_action_redirect_url !== undefined) { formUpdates.push("submit_action_redirect_url=?"); formVals.push(String(body.submit_action_redirect_url || "")); }
    if (body.mode !== undefined) {
      if (body.mode !== "form" && body.mode !== "survey") {
        throw new ValidationError(`Invalid form view mode: ${String(body.mode)}`);
      }
      formUpdates.push("mode=?");
      formVals.push(body.mode);
    }
    if (body.show_logo !== undefined) { formUpdates.push("show_logo=?"); formVals.push(body.show_logo ? 1 : 0); }
    if (body.cover_image !== undefined) { formUpdates.push("cover_image=?"); formVals.push(body.cover_image === null ? null : JSON.stringify(body.cover_image)); }
    if (body.logo_image !== undefined) { formUpdates.push("logo_image=?"); formVals.push(body.logo_image === null ? null : JSON.stringify(body.logo_image)); }
    if (body.receive_notification_on_submit !== undefined && typeof body.receive_notification_on_submit !== "boolean") {
      throw new ValidationError("receive_notification_on_submit must be a boolean.");
    }

    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO database_formview
       (view_ptr_id, title, description, submit_text, submit_action,
        submit_action_message, submit_action_redirect_url, mode, show_logo)
       VALUES (?, '', '', 'Submit', 'MESSAGE', '', '', 'form', 1)`
    ).bind(viewId).run();
    if (formUpdates.length > 0) {
      formVals.push(viewId);
      await c.env.DB.prepare(`UPDATE database_formview SET ${formUpdates.join(", ")} WHERE view_ptr_id=?`)
        .bind(...formVals)
        .run();
    }
    if (body.receive_notification_on_submit !== undefined) {
      if (body.receive_notification_on_submit) {
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO database_formview_users_to_notify_on_submit (formview_id, user_id)
           VALUES (?, ?)`
        ).bind(viewId, user.id).run();
      } else {
        await c.env.DB.prepare(
          `DELETE FROM database_formview_users_to_notify_on_submit
           WHERE formview_id=? AND user_id=?`
        ).bind(viewId, user.id).run();
      }
    }
  }

  const updated = await c.env.DB.prepare("SELECT * FROM database_view WHERE id=?")
    .bind(viewId).first<any>();
  const afterSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  await createUndoableAction(c.env.DB, {
    user,
    actionType: "update_view",
    params: { view_id: viewId, table_id: view.table_id, before: beforeSnapshot, after: afterSnapshot },
    ...viewActionContext(c, view.table_id),
  });
  const serialized = await serializeViewWithIncludes(c.env.DB, updated!, "", c.env.PUBLIC_URL, user.id);

  await broadcastToWorkspace(c.env, workspace_id, {
    type: "view_updated",
    view: serialized,
  });
  const audit = await viewAuditDetails(c.env.DB, viewId);
  await logAuditEntry(c.env.DB, "database.view.update", {
    user,
    workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: viewId, type: "view" }, {
    database_id: view.database_id,
    table_id: view.table_id,
    table_name: audit?.table_name,
    view_id: viewId,
    view_name: audit?.view_name || updated?.name,
    view_type: audit?.view_type || updated?.type,
    before: body.name !== undefined ? { name: view.name } : {},
    after: body.name !== undefined ? { name: updated?.name } : {},
  });
  c.executionCtx.waitUntil(triggerTableWebhooks(c.env, view.table_id, "view.updated", { view: serialized }));

  return c.json(serialized);
});

// ── DELETE /api/database/views/:viewId/ ──────────────────────────────────────
views.delete("/:viewId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = parseInt(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  const table = await c.env.DB.prepare("SELECT id, name, database_id FROM database_table WHERE id=?")
    .bind(view.table_id)
    .first<{ id: number; name: string; database_id: number }>();
  if (!table) throw new DoesNotExist("Table", view.table_id);
  const now = new Date().toISOString();

  await recordTrashEntry(c.env.DB, {
    userId: user.id,
    workspaceId: workspace_id,
    applicationId: table.database_id,
    trashItemType: "view",
    trashItemId: viewId,
    name: view.name,
    parentName: table.name,
    trashedAt: now,
  });
  await c.env.DB.prepare("UPDATE database_view SET trashed=1, updated_on=? WHERE id=?")
    .bind(now, viewId).run();
  const afterSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  await createUndoableAction(c.env.DB, {
    user,
    actionType: "delete_view",
    params: { view_id: viewId, table_id: view.table_id, before: beforeSnapshot, after: afterSnapshot },
    ...viewActionContext(c, view.table_id),
  });

  await broadcastToWorkspace(c.env, workspace_id, {
    type: "view_deleted",
    view_id: viewId,
    table_id: view.table_id,
  });
  const audit = await viewAuditDetails(c.env.DB, viewId);
  await logAuditEntry(c.env.DB, "database.view.delete", {
    user,
    workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: viewId, type: "view" }, {
    database_id: table.database_id,
    table_id: view.table_id,
    table_name: table.name,
    view_id: viewId,
    view_name: view.name,
    view_type: view.type,
  });
  c.executionCtx.waitUntil(triggerTableWebhooks(c.env, view.table_id, "view.deleted", { view_id: viewId }));

  return c.json({});
});

// ── POST /api/database/views/:viewId/duplicate/ ─────────────────────────────
views.post("/:viewId/duplicate/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = Number(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");

  const now = new Date().toISOString();
  const maxOrder = await c.env.DB.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM database_view WHERE table_id=? AND trashed=0"
  )
    .bind(view.table_id)
    .first<{ max_order: number }>();
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const duplicated = await c.env.DB.prepare(
    `INSERT INTO database_view (table_id, name, type, [order], filter_type, filters_disabled, public, allow_public_export,
     public_view_password, slug, trashed, created_on, updated_on, row_identifier_type,
     ownership_type, owned_by_id, show_logo, row_height_size, card_cover_image_field, single_select_field, date_field,
     ical_public, ical_slug, start_date_field, end_date_field, timescale)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(
      view.table_id,
      `${view.name} (copy)`,
      view.type,
      (maxOrder?.max_order || 0) + 1,
      view.filter_type || "AND",
      view.filters_disabled ? 1 : 0,
      view.allow_public_export ? 1 : 0,
      slug,
      now,
      now,
      view.row_identifier_type || "count",
      view.ownership_type || "collaborative",
      user.id,
      view.show_logo === 0 ? 0 : 1,
      view.row_height_size || "small",
      view.card_cover_image_field ?? null,
      view.single_select_field ?? null,
      view.date_field ?? null,
      view.ical_public ? 1 : 0,
      null,
      view.start_date_field ?? null,
      view.end_date_field ?? null,
      view.timescale || "month"
    )
    .first<any>();
  if (!duplicated) throw new Error("Failed to duplicate view");

  await duplicateViewDependencies(c.env.DB, viewId, duplicated.id, view.type);

  const duplicatedSnapshot = await snapshotViewForUndoRedo(c.env.DB, duplicated.id);
  await createUndoableAction(c.env.DB, {
    user,
    actionType: "create_view",
    params: { view_id: duplicated.id, table_id: view.table_id, before: null, after: duplicatedSnapshot },
    ...viewActionContext(c, view.table_id),
  });
  const serialized = await serializeViewWithIncludes(c.env.DB, duplicated, "filters,sortings,group_bys,decorations", c.env.PUBLIC_URL, user.id);
  await broadcastToWorkspace(c.env, workspace_id, { type: "view_created", view: serialized });
  return c.json(serialized, 200);
});

// ── POST /api/database/views/table/:tableId/order/ ──────────────────────────
views.post("/table/:tableId/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const body = await c.req.json<{ view_ids: number[] }>();

  const table = await c.env.DB.prepare(
    `SELECT t.id, t.database_id, a.workspace_id FROM database_table t
     JOIN core_application a ON a.id = t.database_id
     WHERE t.id = ? AND t.trashed = 0`
  ).bind(tableId).first<any>();
  if (!table) throw new DoesNotExist("Table", tableId);

  if (!Array.isArray(body.view_ids)) throw new ValidationError("view_ids must be an array.");

  const viewIds = [...new Set(body.view_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (viewIds.length !== body.view_ids.length) {
    throw new ValidationError("view_ids must contain unique valid view identifiers.");
  }
  const beforeSnapshots: Array<{ view: any; snapshot: Record<string, unknown> | null }> = [];
  for (const viewId of viewIds) {
    const view = await c.env.DB.prepare("SELECT * FROM database_view WHERE id=? AND table_id=?")
      .bind(viewId, tableId)
      .first<any>();
    if (!view) throw new ValidationError("A view does not belong to the provided table.");
    beforeSnapshots.push({ view, snapshot: await snapshotViewForUndoRedo(c.env.DB, viewId) });
  }
  const ownershipTypes = new Set(beforeSnapshots.map(({ view }) => view.ownership_type || "collaborative"));
  if (ownershipTypes.size > 1) {
    throw new ValidationError("Only views with the same ownership type can be ordered together.");
  }
  if (ownershipTypes.has("personal")) {
    if (beforeSnapshots.some(({ view }) => Number(view.owned_by_id) !== user.id)) {
      throw new PermissionError("The user does not own this personal view.");
    }
    await assertHasTableRole(c.env.DB, user.id, table, "VIEWER");
  } else {
    await assertHasTableRole(c.env.DB, user.id, table, "BUILDER");
  }

  const statements = viewIds.map((id, index) =>
    c.env.DB.prepare("UPDATE database_view SET [order]=?, updated_on=? WHERE id=? AND table_id=?")
      .bind(index + 1, new Date().toISOString(), id, tableId)
  );
  if (statements.length > 0) await c.env.DB.batch(statements);

  const actionContext = viewActionContext(c, tableId);
  const actionGroup = actionContext.actionGroup || `order_views:${crypto.randomUUID()}`;
  for (const entry of beforeSnapshots) {
    const afterSnapshot = await snapshotViewForUndoRedo(c.env.DB, Number(entry.view.id));
    await createUndoableAction(c.env.DB, {
      user,
      actionType: "update_view",
      params: { view_id: entry.view.id, table_id: tableId, before: entry.snapshot, after: afterSnapshot },
      session: actionContext.session,
      actionGroup,
      actionScope: actionContext.actionScope,
    });
  }
  return c.json({});
});

// ── GET /api/database/views/:viewId/filters/ ─────────────────────────────────
views.get("/:viewId/filters/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewId = parseInt(c.req.param("viewId"));
  await getViewWithAccess(c.env.DB, viewId, user?.id, true);
  const res = await c.env.DB.prepare(
    `SELECT vf.* FROM database_viewfilter vf
     JOIN database_field f ON f.id=vf.field_id AND f.trashed=0
     WHERE vf.view_id=?`
  ).bind(viewId).all<any>();
  return c.json((res.results || []).map(serializeFilter));
});

views.get("/:viewId/filter/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewId = parseInt(c.req.param("viewId"));
  await getViewWithAccess(c.env.DB, viewId, user?.id, true);
  const res = await c.env.DB.prepare(
    `SELECT vf.* FROM database_viewfilter vf
     JOIN database_field f ON f.id=vf.field_id AND f.trashed=0
     WHERE vf.view_id=? ORDER BY vf.id ASC`
  ).bind(viewId).all<any>();
  return c.json((res.results || []).map(serializeFilter));
});

// ── POST /api/database/views/:viewId/filters/ ────────────────────────────────
views.post("/:viewId/filters/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = parseInt(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  const body = await c.req.json<{ field: number; type: string; value?: string; group?: number | null }>();
  if (view.type === "form") {
    return c.json({ error: "ERROR_VIEW_FILTER_NOT_SUPPORTED", detail: "Filtering is not supported for the view type." }, 400);
  }
  if (!(await activeViewField(c.env.DB, view, body.field))) {
    return c.json({ error: "ERROR_VIEW_FILTER_TYPE_UNSUPPORTED_FIELD", detail: "The filter is not compatible with the provided field." }, 400);
  }
  if (body.group !== undefined && body.group !== null) {
    const group = await c.env.DB.prepare(
      "SELECT id FROM database_viewfiltergroup WHERE id=? AND view_id=?"
    ).bind(body.group, viewId).first<any>();
    if (!group) {
      return c.json({ error: "ERROR_VIEW_FILTER_GROUP_DOES_NOT_EXIST", detail: "The view filter group does not exist." }, 404);
    }
  }
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);

  const res = await c.env.DB.prepare(
    "INSERT INTO database_viewfilter (view_id, field_id, type, value, group_id) VALUES (?,?,?,?,?) RETURNING *"
  ).bind(viewId, body.field, body.type, body.value || "", body.group ?? null).first<any>();

  const serialized = serializeFilter(res);
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  await broadcastToWorkspace(c.env, workspace_id, { type: "view_filter_created", filter: serialized });
  return c.json(serialized, 200);
});

views.post("/:viewId/filter-groups/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = Number(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  const body = await c.req.json<{ parent_group?: number | null; filter_type?: string }>();
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  const group = await c.env.DB.prepare(
    "INSERT INTO database_viewfiltergroup (view_id, parent_group_id, filter_type) VALUES (?, ?, ?) RETURNING *"
  )
    .bind(viewId, body.parent_group ?? null, body.filter_type || "AND")
    .first<any>();
  const serialized = serializeFilterGroup(group);
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  await broadcastToWorkspace(c.env, workspace_id, { type: "view_filter_group_created", filter_group: serialized });
  return c.json(serialized, 200);
});

views.get("/filter/:filterId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const filterId = Number(c.req.param("filterId"));
  const filter = await c.env.DB.prepare("SELECT * FROM database_viewfilter WHERE id=?")
    .bind(filterId).first<any>();
  if (!filter) throw new DoesNotExist("Filter", filterId);
  await getViewWithAccess(c.env.DB, filter.view_id, user?.id, true);
  return c.json(serializeFilter(filter));
});

// ── PATCH /api/database/views/filters/:filterId/ ─────────────────────────────
views.patch("/filters/:filterId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const filterId = parseInt(c.req.param("filterId"));
  const body = await c.req.json<any>();

  const filter = await c.env.DB.prepare("SELECT * FROM database_viewfilter WHERE id=?")
    .bind(filterId).first<any>();
  if (!filter) throw new DoesNotExist("Filter", filterId);

  const { view } = await getViewWithAccess(c.env.DB, filter.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, filter.view_id);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.type !== undefined) { sets.push("type=?"); vals.push(body.type); }
  if (body.value !== undefined) { sets.push("value=?"); vals.push(body.value); }
  if (body.field !== undefined) { sets.push("field_id=?"); vals.push(body.field); }
  if (body.group !== undefined) { sets.push("group_id=?"); vals.push(body.group); }

  if (sets.length > 0) {
    vals.push(filterId);
    await c.env.DB.prepare(`UPDATE database_viewfilter SET ${sets.join(",")} WHERE id=?`)
      .bind(...vals).run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM database_viewfilter WHERE id=?")
    .bind(filterId).first<any>();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json(serializeFilter(updated));
});

views.patch("/filter/:filterId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const filterId = parseInt(c.req.param("filterId"));
  const body = await c.req.json<any>();

  const filter = await c.env.DB.prepare("SELECT * FROM database_viewfilter WHERE id=?")
    .bind(filterId).first<any>();
  if (!filter) throw new DoesNotExist("Filter", filterId);

  const { view } = await getViewWithAccess(c.env.DB, filter.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, filter.view_id);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.type !== undefined) { sets.push("type=?"); vals.push(body.type); }
  if (body.value !== undefined) { sets.push("value=?"); vals.push(body.value); }
  if (body.field !== undefined) { sets.push("field_id=?"); vals.push(body.field); }
  if (body.group !== undefined) { sets.push("group_id=?"); vals.push(body.group); }

  if (sets.length > 0) {
    vals.push(filterId);
    await c.env.DB.prepare(`UPDATE database_viewfilter SET ${sets.join(",")} WHERE id=?`)
      .bind(...vals).run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM database_viewfilter WHERE id=?")
    .bind(filterId).first<any>();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json(serializeFilter(updated));
});

// ── DELETE /api/database/views/filters/:filterId/ ────────────────────────────
views.delete("/filters/:filterId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const filterId = parseInt(c.req.param("filterId"));
  const filter = await c.env.DB.prepare("SELECT * FROM database_viewfilter WHERE id=?")
    .bind(filterId).first<any>();
  if (!filter) throw new DoesNotExist("Filter", filterId);
  const { view } = await getViewWithAccess(c.env.DB, filter.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, filter.view_id);
  await c.env.DB.prepare("DELETE FROM database_viewfilter WHERE id=?").bind(filterId).run();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json({});
});

views.delete("/filter/:filterId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const filterId = parseInt(c.req.param("filterId"));
  const filter = await c.env.DB.prepare("SELECT * FROM database_viewfilter WHERE id=?")
    .bind(filterId).first<any>();
  if (!filter) throw new DoesNotExist("Filter", filterId);
  const { view } = await getViewWithAccess(c.env.DB, filter.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, filter.view_id);
  await c.env.DB.prepare("DELETE FROM database_viewfilter WHERE id=?").bind(filterId).run();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json({});
});

views.patch("/filter-group/:groupId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const groupId = Number(c.req.param("groupId"));
  const body = await c.req.json<{ parent_group?: number | null; filter_type?: string }>();
  const group = await c.env.DB.prepare("SELECT * FROM database_viewfiltergroup WHERE id=?")
    .bind(groupId).first<any>();
  if (!group) throw new DoesNotExist("Filter group", groupId);
  const { view } = await getViewWithAccess(c.env.DB, group.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, group.view_id);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.parent_group !== undefined) { sets.push("parent_group_id=?"); vals.push(body.parent_group); }
  if (body.filter_type !== undefined) { sets.push("filter_type=?"); vals.push(body.filter_type); }
  if (sets.length > 0) {
    vals.push(groupId);
    await c.env.DB.prepare(`UPDATE database_viewfiltergroup SET ${sets.join(",")} WHERE id=?`)
      .bind(...vals)
      .run();
  }
  const updated = await c.env.DB.prepare("SELECT * FROM database_viewfiltergroup WHERE id=?")
    .bind(groupId).first<any>();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json(serializeFilterGroup(updated));
});

views.delete("/filter-group/:groupId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const groupId = Number(c.req.param("groupId"));
  const group = await c.env.DB.prepare("SELECT * FROM database_viewfiltergroup WHERE id=?")
    .bind(groupId).first<any>();
  if (!group) throw new DoesNotExist("Filter group", groupId);
  const { view } = await getViewWithAccess(c.env.DB, group.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, group.view_id);
  await c.env.DB.prepare("DELETE FROM database_viewfiltergroup WHERE id=?").bind(groupId).run();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json({});
});

// ── GET /api/database/views/:viewId/sortings/ ────────────────────────────────
views.get("/:viewId/sortings/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewId = parseInt(c.req.param("viewId"));
  await getViewWithAccess(c.env.DB, viewId, user?.id, true);
  const res = await c.env.DB.prepare(
    `SELECT vs.* FROM database_viewsort vs
     JOIN database_field f ON f.id=vs.field_id AND f.trashed=0
     WHERE vs.view_id=?`
  )
    .bind(viewId).all<any>();
  return c.json((res.results || []).map(serializeSort));
});

// ── POST /api/database/views/:viewId/sortings/ ───────────────────────────────
views.post("/:viewId/sortings/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = parseInt(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  const body = await c.req.json<{ field: number; order?: string; type?: string }>();
  if (view.type === "form") {
    return c.json({ error: "ERROR_VIEW_SORT_NOT_SUPPORTED", detail: "Sorting is not supported for the view type." }, 400);
  }
  const field = await activeViewField(c.env.DB, view, body.field);
  if (!field || !sortTypeSupportsField(field, body.type)) {
    return c.json({ error: "ERROR_VIEW_SORT_FIELD_NOT_SUPPORTED", detail: "The field does not support view sorting on the given type." }, 400);
  }
  if (!new Set(["ASC", "DESC"]).has(String(body.order || "ASC").toUpperCase())) {
    throw new ValidationError("The sort order must be ASC or DESC.");
  }
  const duplicate = await c.env.DB.prepare(
    "SELECT id FROM database_viewsort WHERE view_id=? AND field_id=?"
  ).bind(viewId, body.field).first<any>();
  if (duplicate) {
    return c.json({ error: "ERROR_VIEW_SORT_FIELD_ALREADY_EXISTS", detail: "A sort with the field already exists in the view." }, 400);
  }
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  const res = await c.env.DB.prepare(
    "INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (?,?,?,?) RETURNING *"
  ).bind(viewId, body.field, String(body.order || "ASC").toUpperCase(), body.type || "default").first<any>();
  const serialized = serializeSort(res);
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  await broadcastToWorkspace(c.env, workspace_id, { type: "view_sort_created", sort: serialized });
  return c.json(serialized, 200);
});

views.get("/sort/:sortId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const sortId = Number(c.req.param("sortId"));
  const sort = await c.env.DB.prepare("SELECT * FROM database_viewsort WHERE id=?")
    .bind(sortId).first<any>();
  if (!sort) throw new DoesNotExist("Sorting", sortId);
  await getViewWithAccess(c.env.DB, sort.view_id, user?.id, true);
  return c.json(serializeSort(sort));
});

views.patch("/sort/:sortId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const sortId = Number(c.req.param("sortId"));
  const body = await c.req.json<any>();
  const sort = await c.env.DB.prepare("SELECT * FROM database_viewsort WHERE id=?")
    .bind(sortId).first<any>();
  if (!sort) throw new DoesNotExist("Sorting", sortId);
  const { view } = await getViewWithAccess(c.env.DB, sort.view_id, user.id, false, "BUILDER");
  const nextFieldId = body.field ?? sort.field_id;
  const nextType = body.type ?? sort.type;
  const field = await activeViewField(c.env.DB, view, nextFieldId);
  if (!field || !sortTypeSupportsField(field, nextType)) {
    return c.json({ error: "ERROR_VIEW_SORT_FIELD_NOT_SUPPORTED", detail: "The field does not support view sorting on the given type." }, 400);
  }
  if (body.order !== undefined && !new Set(["ASC", "DESC"]).has(String(body.order).toUpperCase())) {
    throw new ValidationError("The sort order must be ASC or DESC.");
  }
  if (body.field !== undefined && Number(body.field) !== Number(sort.field_id)) {
    const duplicate = await c.env.DB.prepare(
      "SELECT id FROM database_viewsort WHERE view_id=? AND field_id=? AND id<>?"
    ).bind(sort.view_id, body.field, sortId).first<any>();
    if (duplicate) {
      return c.json({ error: "ERROR_VIEW_SORT_FIELD_ALREADY_EXISTS", detail: "A sort with the field already exists in the view." }, 400);
    }
  }
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, sort.view_id);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.field !== undefined) { sets.push("field_id=?"); vals.push(body.field); }
  if (body.order !== undefined) { sets.push("[order]=?"); vals.push(String(body.order).toUpperCase()); }
  if (body.type !== undefined) { sets.push("type=?"); vals.push(body.type); }
  if (sets.length > 0) {
    vals.push(sortId);
    await c.env.DB.prepare(`UPDATE database_viewsort SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
  }
  const updated = await c.env.DB.prepare("SELECT * FROM database_viewsort WHERE id=?").bind(sortId).first<any>();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json(serializeSort(updated));
});

views.delete("/sort/:sortId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const sortId = parseInt(c.req.param("sortId"));
  const sort = await c.env.DB.prepare("SELECT * FROM database_viewsort WHERE id=?")
    .bind(sortId).first<any>();
  if (!sort) throw new DoesNotExist("Sorting", sortId);
  const { view } = await getViewWithAccess(c.env.DB, sort.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, sort.view_id);
  await c.env.DB.prepare("DELETE FROM database_viewsort WHERE id=?").bind(sortId).run();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json({});
});

// ── DELETE /api/database/views/sortings/:sortId/ ─────────────────────────────
views.delete("/sortings/:sortId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const sortId = parseInt(c.req.param("sortId"));
  const sort = await c.env.DB.prepare("SELECT * FROM database_viewsort WHERE id=?")
    .bind(sortId).first<any>();
  if (!sort) throw new DoesNotExist("Sorting", sortId);
  const { view } = await getViewWithAccess(c.env.DB, sort.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, sort.view_id);
  await c.env.DB.prepare("DELETE FROM database_viewsort WHERE id=?").bind(sortId).run();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json({});
});

// ── View group bys ──────────────────────────────────────────────────────────
views.get("/:viewId/group_bys/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewId = Number(c.req.param("viewId"));
  await getViewWithAccess(c.env.DB, viewId, user?.id, true);
  const rows = await c.env.DB.prepare(
    `SELECT vg.* FROM database_viewgroupby vg
     JOIN database_field f ON f.id=vg.field_id AND f.trashed=0
     WHERE vg.view_id=? ORDER BY vg.id ASC`
  )
    .bind(viewId)
    .all<any>();
  return c.json((rows.results || []).map(serializeGroupBy));
});

views.post("/:viewId/group_bys/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = Number(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  const body = await c.req.json<{ field: number; order?: string; width?: number; type?: string }>();
  if (view.type !== "grid") {
    return c.json({ error: "ERROR_VIEW_GROUP_BY_NOT_SUPPORTED", detail: "Grouping is not supported for the view type." }, 400);
  }
  const field = await activeViewField(c.env.DB, view, body.field);
  if (!field || NON_SORTABLE_FIELD_TYPES.has(field.type as FieldType) || !sortTypeSupportsField(field, body.type)) {
    return c.json({ error: "ERROR_VIEW_GROUP_BY_FIELD_NOT_SUPPORTED", detail: "The field does not support view grouping." }, 400);
  }
  if (!new Set(["ASC", "DESC"]).has(String(body.order || "ASC").toUpperCase())) {
    throw new ValidationError("The group by order must be ASC or DESC.");
  }
  const duplicate = await c.env.DB.prepare(
    "SELECT id FROM database_viewgroupby WHERE view_id=? AND field_id=?"
  ).bind(viewId, body.field).first<any>();
  if (duplicate) {
    return c.json({ error: "ERROR_VIEW_GROUP_BY_FIELD_ALREADY_EXISTS", detail: "A group by for the field already exists in the view." }, 400);
  }
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  const groupBy = await c.env.DB.prepare(
    "INSERT INTO database_viewgroupby (view_id, field_id, [order], width, type) VALUES (?, ?, ?, ?, ?) RETURNING *"
  )
    .bind(viewId, body.field, String(body.order || "ASC").toUpperCase(), body.width ?? 200, body.type || "default")
    .first<any>();
  const serialized = serializeGroupBy(groupBy);
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  await broadcastToWorkspace(c.env, workspace_id, { type: "view_group_by_created", group_by: serialized });
  return c.json(serialized, 200);
});

views.get("/group_by/:groupById/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const groupById = Number(c.req.param("groupById"));
  const groupBy = await c.env.DB.prepare("SELECT * FROM database_viewgroupby WHERE id=?")
    .bind(groupById).first<any>();
  if (!groupBy) throw new DoesNotExist("Group by", groupById);
  await getViewWithAccess(c.env.DB, groupBy.view_id, user?.id, true);
  return c.json(serializeGroupBy(groupBy));
});

views.patch("/group_by/:groupById/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const groupById = Number(c.req.param("groupById"));
  const body = await c.req.json<any>();
  const groupBy = await c.env.DB.prepare("SELECT * FROM database_viewgroupby WHERE id=?")
    .bind(groupById).first<any>();
  if (!groupBy) throw new DoesNotExist("Group by", groupById);
  const { view } = await getViewWithAccess(c.env.DB, groupBy.view_id, user.id, false, "BUILDER");
  const nextFieldId = body.field ?? groupBy.field_id;
  const nextType = body.type ?? groupBy.type;
  const field = await activeViewField(c.env.DB, view, nextFieldId);
  if (!field || NON_SORTABLE_FIELD_TYPES.has(field.type as FieldType) || !sortTypeSupportsField(field, nextType)) {
    return c.json({ error: "ERROR_VIEW_GROUP_BY_FIELD_NOT_SUPPORTED", detail: "The field does not support view grouping." }, 400);
  }
  if (body.order !== undefined && !new Set(["ASC", "DESC"]).has(String(body.order).toUpperCase())) {
    throw new ValidationError("The group by order must be ASC or DESC.");
  }
  if (body.field !== undefined && Number(body.field) !== Number(groupBy.field_id)) {
    const duplicate = await c.env.DB.prepare(
      "SELECT id FROM database_viewgroupby WHERE view_id=? AND field_id=? AND id<>?"
    ).bind(groupBy.view_id, body.field, groupById).first<any>();
    if (duplicate) {
      return c.json({ error: "ERROR_VIEW_GROUP_BY_FIELD_ALREADY_EXISTS", detail: "A group by for the field already exists in the view." }, 400);
    }
  }
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, groupBy.view_id);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.field !== undefined) { sets.push("field_id=?"); vals.push(body.field); }
  if (body.order !== undefined) { sets.push("[order]=?"); vals.push(String(body.order).toUpperCase()); }
  if (body.width !== undefined) { sets.push("width=?"); vals.push(body.width); }
  if (body.type !== undefined) { sets.push("type=?"); vals.push(body.type); }
  if (sets.length > 0) {
    vals.push(groupById);
    await c.env.DB.prepare(`UPDATE database_viewgroupby SET ${sets.join(",")} WHERE id=?`)
      .bind(...vals)
      .run();
  }
  const updated = await c.env.DB.prepare("SELECT * FROM database_viewgroupby WHERE id=?")
    .bind(groupById).first<any>();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json(serializeGroupBy(updated));
});

views.delete("/group_by/:groupById/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const groupById = Number(c.req.param("groupById"));
  const groupBy = await c.env.DB.prepare("SELECT * FROM database_viewgroupby WHERE id=?")
    .bind(groupById).first<any>();
  if (!groupBy) throw new DoesNotExist("Group by", groupById);
  const { view } = await getViewWithAccess(c.env.DB, groupBy.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, groupBy.view_id);
  await c.env.DB.prepare("DELETE FROM database_viewgroupby WHERE id=?").bind(groupById).run();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json({});
});

// ── GET /api/database/views/:viewId/field-options/ ───────────────────────────
views.get("/:viewId/field-options/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewId = parseInt(c.req.param("viewId"));
  if (!Number.isInteger(viewId) || viewId <= 0) throw new DoesNotExist("View", viewId);
  const { view } = await getViewWithAccess(c.env.DB, viewId, user?.id, true);
  return c.json({ field_options: await getViewFieldOptions(c.env.DB, view) });
});

// ── PATCH /api/database/views/:viewId/field-options/ ─────────────────────────
views.patch("/:viewId/field-options/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = parseInt(c.req.param("viewId"));
  if (!Number.isInteger(viewId) || viewId <= 0) throw new DoesNotExist("View", viewId);
  const { view } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  const body = await c.req.json<{ field_options: Record<string, any> }>();
  const fieldOptions = body.field_options || {};
  const invalidFieldOptions = await validateViewFieldOptionIds(c.env.DB, view, fieldOptions);
  if (invalidFieldOptions) return invalidFieldOptions;
  if (view.type === "grid") {
    const invalidGridFieldOptions = await validateGridFieldOptionsPatch(c.env.DB, view, fieldOptions);
    if (invalidGridFieldOptions) return invalidGridFieldOptions;
  }
  if (view.type === "form") {
    const invalidFormFieldOptions = await validateFormFieldOptionsPatch(c.env.DB, view, fieldOptions);
    if (invalidFormFieldOptions) return invalidFormFieldOptions;
  }
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);

  const statements = Object.entries(fieldOptions).map(([fieldId, opts]) => {
    const id = parseInt(fieldId);
    const hasHidden = Object.prototype.hasOwnProperty.call(opts, "hidden");
    const hasOrder = Object.prototype.hasOwnProperty.call(opts, "order");
    if (view.type === "gallery") {
      return c.env.DB.prepare(
        `INSERT INTO database_galleryviewfieldoptions (gallery_view_id, field_id, hidden, [order])
         VALUES (?, ?, ?, ?)
         ON CONFLICT(gallery_view_id, field_id) DO UPDATE SET
           hidden=CASE WHEN ? THEN excluded.hidden ELSE hidden END,
           [order]=CASE WHEN ? THEN excluded.[order] ELSE [order] END`
      ).bind(viewId, id, hasHidden ? (opts.hidden ? 1 : 0) : 1, hasOrder ? opts.order : 32767, hasHidden ? 1 : 0, hasOrder ? 1 : 0);
    }
    if (view.type === "form") {
      const hasName = Object.prototype.hasOwnProperty.call(opts, "name");
      const hasDescription = Object.prototype.hasOwnProperty.call(opts, "description");
      const hasEnabled = Object.prototype.hasOwnProperty.call(opts, "enabled");
      const hasRequired = Object.prototype.hasOwnProperty.call(opts, "required");
      const hasShowWhenMatchingConditions = Object.prototype.hasOwnProperty.call(opts, "show_when_matching_conditions");
      const hasConditionType = Object.prototype.hasOwnProperty.call(opts, "condition_type");
      const hasIncludeAllSelectOptions = Object.prototype.hasOwnProperty.call(opts, "include_all_select_options");
      const hasFieldComponent = Object.prototype.hasOwnProperty.call(opts, "field_component");
      return c.env.DB.prepare(
        `INSERT INTO database_formviewfieldoptions
         (form_view_id, field_id, name, description, enabled, required, [order],
          show_when_matching_conditions, condition_type, include_all_select_options, field_component)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(form_view_id, field_id) DO UPDATE SET
           name=CASE WHEN ? THEN excluded.name ELSE name END,
           description=CASE WHEN ? THEN excluded.description ELSE description END,
           enabled=CASE WHEN ? THEN excluded.enabled ELSE enabled END,
           required=CASE WHEN ? THEN excluded.required ELSE required END,
           [order]=CASE WHEN ? THEN excluded.[order] ELSE [order] END,
           show_when_matching_conditions=CASE WHEN ? THEN excluded.show_when_matching_conditions ELSE show_when_matching_conditions END,
           condition_type=CASE WHEN ? THEN excluded.condition_type ELSE condition_type END,
           include_all_select_options=CASE WHEN ? THEN excluded.include_all_select_options ELSE include_all_select_options END,
           field_component=CASE WHEN ? THEN excluded.field_component ELSE field_component END`
      ).bind(
        viewId,
        id,
        hasName ? opts.name : "",
        hasDescription ? opts.description : "",
        hasEnabled ? (opts.enabled ? 1 : 0) : 0,
        hasRequired ? (opts.required ? 1 : 0) : 1,
        hasOrder ? opts.order : 32767,
        hasShowWhenMatchingConditions ? (opts.show_when_matching_conditions ? 1 : 0) : 0,
        hasConditionType ? (opts.condition_type || "AND") : "AND",
        hasIncludeAllSelectOptions ? (opts.include_all_select_options === false ? 0 : 1) : 1,
        hasFieldComponent ? (opts.field_component || "default") : "default",
        hasName ? 1 : 0,
        hasDescription ? 1 : 0,
        hasEnabled ? 1 : 0,
        hasRequired ? 1 : 0,
        hasOrder ? 1 : 0,
        hasShowWhenMatchingConditions ? 1 : 0,
        hasConditionType ? 1 : 0,
        hasIncludeAllSelectOptions ? 1 : 0,
        hasFieldComponent ? 1 : 0
      );
    }
    if (PREMIUM_FIELD_OPTION_VIEW_TYPES.has(view.type)) {
      return c.env.DB.prepare(
        `INSERT INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
         VALUES (?, ?, 200, ?, ?, '', '')
         ON CONFLICT(grid_view_id, field_id) DO UPDATE SET
           hidden=CASE WHEN ? THEN excluded.hidden ELSE hidden END,
           [order]=CASE WHEN ? THEN excluded.[order] ELSE [order] END`
      ).bind(viewId, id, hasHidden ? (opts.hidden ? 1 : 0) : 1, hasOrder ? opts.order : 32767, hasHidden ? 1 : 0, hasOrder ? 1 : 0);
    }
    const hasWidth = Object.prototype.hasOwnProperty.call(opts, "width");
    const hasAggregationType = Object.prototype.hasOwnProperty.call(opts, "aggregation_type");
    const hasAggregationRawType = Object.prototype.hasOwnProperty.call(opts, "aggregation_raw_type");
    return c.env.DB.prepare(
      `INSERT INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(grid_view_id, field_id) DO UPDATE SET
         width=CASE WHEN ? THEN excluded.width ELSE width END,
         hidden=CASE WHEN ? THEN excluded.hidden ELSE hidden END,
         [order]=CASE WHEN ? THEN excluded.[order] ELSE [order] END,
         aggregation_type=CASE WHEN ? THEN excluded.aggregation_type ELSE aggregation_type END,
         aggregation_raw_type=CASE WHEN ? THEN excluded.aggregation_raw_type ELSE aggregation_raw_type END`
    ).bind(
      viewId,
      id,
      hasWidth ? opts.width : 200,
      hasHidden ? (opts.hidden ? 1 : 0) : 0,
      hasOrder ? opts.order : 32767,
      hasAggregationType ? (opts.aggregation_type || "") : "",
      hasAggregationRawType ? (opts.aggregation_raw_type || "") : "",
      hasWidth ? 1 : 0,
      hasHidden ? 1 : 0,
      hasOrder ? 1 : 0,
      hasAggregationType ? 1 : 0,
      hasAggregationRawType ? 1 : 0
    );
  });
  if (statements.length > 0) await c.env.DB.batch(statements);
  if (view.type === "form") {
    await syncFormFieldOptionLogic(c.env.DB, view, fieldOptions);
  }
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json({ field_options: await getViewFieldOptions(c.env.DB, view) });
});

// ── POST /api/database/views/:viewId/rotate-slug/ ────────────────────────────
views.post("/:viewId/rotate-slug/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = parseInt(c.req.param("viewId"));
  const { view } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  await assertHasTableRole(c.env.DB, user.id, {
    id: Number(view.table_id), database_id: Number(view.database_id), workspace_id: Number(view.workspace_id),
  }, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  await c.env.DB.prepare("UPDATE database_view SET slug=? WHERE id=?").bind(slug, viewId).run();
  const v = await c.env.DB.prepare("SELECT * FROM database_view WHERE id=?").bind(viewId).first<any>();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  return c.json(serializeView(v!, c.env.PUBLIC_URL));
});

views.get("/:viewId/decoration/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewId = Number(c.req.param("viewId"));
  await getViewWithAccess(c.env.DB, viewId, user?.id, true);
  const rows = await c.env.DB.prepare("SELECT * FROM database_viewdecoration WHERE view_id=? ORDER BY [order] ASC, id ASC")
    .bind(viewId)
    .all<any>();
  return c.json((rows.results || []).map(serializeDecoration));
});

views.post("/:viewId/decorations/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const viewId = Number(c.req.param("viewId"));
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, viewId, user.id, false, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  const decorationType = String(body.type || "");
  const providerType = String(body.value_provider_type || "");
  const providerConf = body.value_provider_conf ?? {};
  const invalid = await validateDecorationValues(c.env.DB, view, decorationType, providerType, providerConf);
  if (invalid) return invalid;
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, viewId);
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX([order]), 0) AS max_order FROM database_viewdecoration WHERE view_id=?")
    .bind(viewId)
    .first<{ max_order: number }>();
  const row = await c.env.DB.prepare(
    `INSERT INTO database_viewdecoration (view_id, type, value_provider_type, value_provider_conf, [order])
     VALUES (?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    viewId,
    decorationType,
    providerType,
    JSON.stringify(providerConf),
    body.order ?? ((max?.max_order || 0) + 1)
  ).first<any>();
  const serialized = serializeDecoration(row);
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  await broadcastToWorkspace(c.env, workspace_id, { type: "view_decoration_created", view_decoration: serialized });
  return c.json(serialized, 200);
});

views.get("/decoration/:decorationId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const decorationId = Number(c.req.param("decorationId"));
  const row = await c.env.DB.prepare("SELECT * FROM database_viewdecoration WHERE id=?")
    .bind(decorationId)
    .first<any>();
  if (!row) throw new DoesNotExist("View decoration", decorationId);
  await getViewWithAccess(c.env.DB, row.view_id, user?.id, true);
  return c.json(serializeDecoration(row));
});

views.patch("/decoration/:decorationId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const decorationId = Number(c.req.param("decorationId"));
  const body = await c.req.json<Record<string, unknown>>();
  const row = await c.env.DB.prepare("SELECT * FROM database_viewdecoration WHERE id=?")
    .bind(decorationId)
    .first<any>();
  if (!row) throw new DoesNotExist("View decoration", decorationId);
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, row.view_id, user.id, false, "BUILDER");
  const decorationType = body.type !== undefined ? String(body.type) : String(row.type);
  const providerType = body.value_provider_type !== undefined ? String(body.value_provider_type) : String(row.value_provider_type || "");
  const providerConf = body.value_provider_conf !== undefined ? body.value_provider_conf : parseJsonObject(row.value_provider_conf);
  const invalid = await validateDecorationValues(c.env.DB, view, decorationType, providerType, providerConf);
  if (invalid) return invalid;
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, row.view_id);
  await c.env.DB.prepare(
    `UPDATE database_viewdecoration
     SET type=?, value_provider_type=?, value_provider_conf=?, [order]=?
     WHERE id=?`
  ).bind(
    decorationType,
    providerType,
    JSON.stringify(providerConf),
    body.order !== undefined ? body.order : row.order,
    decorationId
  ).run();
  const updated = await c.env.DB.prepare("SELECT * FROM database_viewdecoration WHERE id=?").bind(decorationId).first<any>();
  const serialized = serializeDecoration(updated);
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  await broadcastToWorkspace(c.env, workspace_id, {
    type: "view_decoration_updated",
    view_decoration_id: decorationId,
    view_decoration: serialized,
  });
  return c.json(serialized);
});

views.delete("/decoration/:decorationId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const decorationId = Number(c.req.param("decorationId"));
  const row = await c.env.DB.prepare("SELECT * FROM database_viewdecoration WHERE id=?")
    .bind(decorationId)
    .first<any>();
  if (!row) throw new DoesNotExist("View decoration", decorationId);
  const { view, workspace_id } = await getViewWithAccess(c.env.DB, row.view_id, user.id, false, "BUILDER");
  const beforeSnapshot = await snapshotViewForUndoRedo(c.env.DB, row.view_id);
  await c.env.DB.prepare("DELETE FROM database_viewdecoration WHERE id=?").bind(decorationId).run();
  await recordViewUpdateUndoAction(c, user, view, beforeSnapshot);
  await broadcastToWorkspace(c.env, workspace_id, {
    type: "view_decoration_deleted",
    view_decoration_id: decorationId,
    view_id: row.view_id,
  });
  return c.json({});
});

views.get("/:slug/link-row-field-lookup/:fieldId/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const fieldId = Number(c.req.param("fieldId"));
  const view = await c.env.DB.prepare("SELECT * FROM database_view WHERE slug=? AND trashed=0")
    .bind(slug)
    .first<any>();
  if (!view) throw new DoesNotExist("View", slug);
  if (!view.public) {
    const user = c.get("user");
    if (!user?.id) throw new DoesNotExist("View", slug);
    await assertHasViewRole(c.env.DB, user.id, Number(view.id), "VIEWER");
  } else {
    const authError = await publicViewAuthorizationResponse(c, view);
    if (authError) return authError;
  }
  const visibleFieldIds = await getPublicVisibleFieldIds(c.env.DB, view);
  const field = await c.env.DB.prepare(
    "SELECT * FROM database_field WHERE id=? AND table_id=? AND type='link_row' AND trashed=0"
  ).bind(fieldId, view.table_id)
    .first<any>();
  if (!field || !visibleFieldIds.has(fieldId)) throw new DoesNotExist("Field", fieldId);
  const settings = (parseJsonObject(field.field_settings) || {}) as Record<string, unknown>;
  const targetTableId = Number(settings.link_row_table_id || 0);
  const targetTable = await c.env.DB.prepare(
    `SELECT t.id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
  ).bind(targetTableId).first<{ id: number }>();
  if (!targetTable) throw new DoesNotExist("Field", fieldId);

  let allowedRowIds: Set<number> | null = null;
  if (view.type !== "form") {
    const visibleRows = await queryViewRows(c.env.DB, view, c.req.url);
    allowedRowIds = new Set<number>();
    for (const row of visibleRows.rows) {
      const links = deserializeFieldValue("link_row", row[`field_${fieldId}`]);
      if (!Array.isArray(links)) continue;
      for (const link of links) {
        const id = Number(link && typeof link === "object" ? (link as Record<string, unknown>).id : link);
        if (Number.isInteger(id) && id > 0) allowedRowIds.add(id);
      }
    }
  }
  const selectionViewId = Number(settings.link_row_limit_selection_view_id || 0);
  if (selectionViewId > 0) {
    const selectionView = await c.env.DB.prepare(
      "SELECT * FROM database_view WHERE id=? AND table_id=? AND trashed=0"
    ).bind(selectionViewId, targetTableId).first<any>();
    if (!selectionView) throw new DoesNotExist("Field", fieldId);
    const selectionRows = await queryViewRows(c.env.DB, selectionView, c.req.url);
    const selectionIds = new Set(selectionRows.rows.map((row) => Number(row.id)));
    allowedRowIds = allowedRowIds === null
      ? selectionIds
      : new Set([...allowedRowIds].filter((id) => selectionIds.has(id)));
  }

  const page = Math.max(1, Number(c.req.query("page") || 1));
  const size = Math.min(200, Math.max(1, Number(c.req.query("size") || 100)));
  const offset = (page - 1) * size;
  const fields = await getActiveFields(c.env.DB, targetTableId);
  const primary = fields.find((item) => item.primary) || fields[0];
  const tableName = `database_table_${targetTableId}`;
  await ensureUserTableSystemColumns(c.env.DB, targetTableId);
  const allRows = await c.env.DB.prepare(
    `SELECT * FROM "${tableName}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC`
  ).all<Record<string, unknown>>();
  const search = String(c.req.query("search") || "").trim().toLocaleLowerCase();
  const searchMode = String(c.req.query("search_mode") || "");
  const matchedRows = (allRows.results || []).filter((row) => {
    if (allowedRowIds !== null && !allowedRowIds.has(Number(row.id))) return false;
    if (!search) return true;
    const display = humanReadableFormNotificationValue(primary ? deserializeFieldValue(primary.type, row[`field_${primary.id}`]) : row.id)
      .toLocaleLowerCase();
    return searchMode === "exact" ? display === search : display.includes(search);
  });
  const results = matchedRows.slice(offset, offset + size).map((row) => ({
    id: Number(row.id),
    value: humanReadableFormNotificationValue(primary ? deserializeFieldValue(primary.type, row[`field_${primary.id}`]) : row.id),
    order: row.order ?? 0,
  }));
  return c.json({
    count: matchedRows.length,
    next: offset + size < matchedRows.length ? page + 1 : null,
    previous: page > 1 ? page - 1 : null,
    results,
  });
});

views.post("/:slug/public/auth/", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
  const view = await c.env.DB.prepare("SELECT * FROM database_view WHERE slug=? AND public=1 AND trashed=0")
    .bind(slug)
    .first<any>();
  if (!view) throw new DoesNotExist("View", slug);
  await assertPersonalPublicViewOwnerCanShare(c.env.DB, view);
  if (!(await publicViewPasswordMatches(view, body.password))) {
    return c.json({ detail: "Incorrect password.", error: "AUTHORIZATION_ERROR" }, 401);
  }
  return c.json({ access_token: await encodePublicViewToken(c.env, view) });
});

// ── GET /api/database/views/public/:slug/ — Public view (no auth) ────────────
views.get("/public/:slug/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const view = await c.env.DB.prepare(
    "SELECT * FROM database_view WHERE slug=? AND public=1 AND trashed=0"
  ).bind(slug).first<any>();
  if (!view) throw new DoesNotExist("View", slug);
  const authError = await publicViewAuthorizationResponse(c, view);
  if (authError) return authError;

  const fields = await getPublicVisibleFieldRows(c.env.DB, view);

  return c.json(await serializePublicViewInfo(c.env.DB, view, fields, c.env.PUBLIC_URL));
});

views.get("/:slug/public/info/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const view = await c.env.DB.prepare(
    "SELECT * FROM database_view WHERE slug=? AND public=1 AND trashed=0"
  ).bind(slug).first<any>();
  if (!view) throw new DoesNotExist("View", slug);
  const authError = await publicViewAuthorizationResponse(c, view);
  if (authError) return authError;

  const fields = await getPublicVisibleFieldRows(c.env.DB, view);

  return c.json(await serializePublicViewInfo(c.env.DB, view, fields, c.env.PUBLIC_URL));
});

views.get("/:slug/row/:rowId/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const rowId = Number(c.req.param("rowId"));
  const view = await c.env.DB.prepare(
    "SELECT * FROM database_view WHERE slug=? AND public=1 AND trashed=0"
  ).bind(slug).first<any>();
  if (!view) throw new DoesNotExist("View", slug);
  const authError = await publicViewAuthorizationResponse(c, view);
  if (authError) return authError;

  const publicFieldIds = await getPublicVisibleFieldIds(c.env.DB, view);
  const fields = (await getActiveFields(c.env.DB, view.table_id))
    .filter((field) => publicFieldIds.has(Number(field.id)));
  await ensureUserTableSystemColumns(c.env.DB, Number(view.table_id));
  const row = await c.env.DB.prepare(`SELECT * FROM "database_table_${view.table_id}" WHERE id=? AND COALESCE(trashed, 0)=0`)
    .bind(rowId)
    .first<Record<string, unknown>>();
  if (!row) throw new DoesNotExist("Row", rowId);
  const serialized = await serializeRowForViewWithComputed(c.env.DB, row, fields);
  return c.json(projectRowForFieldIds(serialized, publicFieldIds));
});

async function getPublicFormView(db: D1Database, slug: string) {
  const view = await db.prepare(
    `SELECT v.*, fv.title, fv.description AS form_description, fv.submit_text,
            fv.submit_action, fv.submit_action_message, fv.submit_action_redirect_url,
            fv.mode, fv.show_logo AS form_show_logo, fv.cover_image, fv.logo_image,
            t.database_id, a.workspace_id
     FROM database_view v
     LEFT JOIN database_formview fv ON fv.view_ptr_id = v.id
     JOIN database_table t ON t.id=v.table_id
     JOIN core_application a ON a.id=t.database_id
     WHERE v.slug=? AND v.type='form' AND v.public=1 AND v.trashed=0`
  ).bind(slug).first<any>();
  if (!view) throw new DoesNotExist("View", slug);
  return view;
}

async function getPublicFormFields(db: D1Database, view: any) {
  const rows = await db.prepare(
    `SELECT f.*, f."primary" AS is_primary, f.description AS field_description,
            fo.id AS option_id, fo.name AS option_name, fo.description AS option_description,
            fo.enabled, fo.required, fo.[order] AS option_order,
            fo.show_when_matching_conditions, fo.condition_type,
            fo.include_all_select_options, fo.field_component
     FROM database_field f
     JOIN database_formviewfieldoptions fo ON fo.field_id = f.id AND fo.form_view_id = ?
     WHERE f.table_id=? AND f.trashed=0 AND fo.enabled=1
     ORDER BY f."primary" DESC, fo.[order] ASC, f.id ASC`
  ).bind(view.id, view.table_id).all<any>();

  const visibleRows = await filterFieldsAllowedInPublicForms(db, rows.results || []);

  const optionIds = visibleRows.map((row: any) => Number(row.option_id)).filter((id: number) => id > 0);
  const groupsByOption = new Map<number, any[]>();
  const conditionsByOption = new Map<number, any[]>();
  const allowedByOption = new Map<number, number[]>();
  if (optionIds.length > 0) {
    const marks = optionIds.map(() => "?").join(",");
    const groups = await db.prepare(
      `SELECT * FROM database_formviewfieldoptionsconditiongroup
       WHERE field_option_id IN (${marks})
       ORDER BY id ASC`
    ).bind(...optionIds).all<any>();
    for (const group of (groups.results || [])) {
      const key = Number(group.field_option_id);
      groupsByOption.set(key, [...(groupsByOption.get(key) || []), serializeFormConditionGroup(group)]);
    }
    const conditions = await db.prepare(
      `SELECT * FROM database_formviewfieldoptionscondition
       WHERE field_option_id IN (${marks})
       ORDER BY id ASC`
    ).bind(...optionIds).all<any>();
    for (const condition of (conditions.results || [])) {
      const key = Number(condition.field_option_id);
      conditionsByOption.set(key, [...(conditionsByOption.get(key) || []), serializeFormCondition(condition)]);
    }
    const allowed = await db.prepare(
      `SELECT form_view_field_options_id, select_option_id
       FROM database_formviewfieldoptions_allowedselectoptions
       WHERE form_view_field_options_id IN (${marks})
       ORDER BY id ASC`
    ).bind(...optionIds).all<any>();
    for (const option of (allowed.results || [])) {
      const key = Number(option.form_view_field_options_id);
      allowedByOption.set(key, [...(allowedByOption.get(key) || []), Number(option.select_option_id)]);
    }
  }

  return Promise.all(visibleRows.map(async (row: any) => {
    const includeAllSelectOptions = row.include_all_select_options === null || row.include_all_select_options === undefined
      ? true
      : Boolean(row.include_all_select_options);
    const allowedSelectOptions = row.option_id ? allowedByOption.get(Number(row.option_id)) || [] : [];
    const field = await serializeDatabaseFieldRow(db, row) as Record<string, unknown>;
    if (!includeAllSelectOptions && Array.isArray(field.select_options)) {
      const allowed = new Set(allowedSelectOptions.map(Number));
      field.select_options = field.select_options.filter((option: any) => allowed.has(Number(option.id)));
      if (field.type === "single_select" && field.single_select_default && !allowed.has(Number(field.single_select_default))) {
        field.single_select_default = null;
      }
      if (field.type === "multiple_select" && Array.isArray(field.multiple_select_default)) {
        field.multiple_select_default = field.multiple_select_default.filter((id: unknown) => allowed.has(Number(id)));
      }
    }
    return {
      id: row.option_id ?? row.id,
      name: row.option_name || row.name,
      description: row.option_description || row.field_description || "",
      enabled: row.enabled === null || row.enabled === undefined ? true : Boolean(row.enabled),
      required: Boolean(row.required),
      order: row.option_order ?? row.order,
      show_when_matching_conditions: Boolean(row.show_when_matching_conditions),
      condition_type: row.condition_type || "AND",
      conditions: row.option_id ? conditionsByOption.get(Number(row.option_id)) || [] : [],
      condition_groups: row.option_id ? groupsByOption.get(Number(row.option_id)) || [] : [],
      groups: row.option_id ? groupsByOption.get(Number(row.option_id)) || [] : [],
      field_component: row.field_component || "default",
      include_all_select_options: includeAllSelectOptions,
      allowed_select_options: allowedSelectOptions,
      field,
    };
  }));
}

async function submitPublicFormRow(
  env: Env,
  view: any,
  body: Record<string, unknown>,
  acceptFieldNames = false,
  senderId: number | null = null
) {
  const db = env.DB;
  const publicFields = await getPublicFormFields(db, view);
  const enabledFieldIds = new Set(publicFields.map((option: any) => Number(option.field?.id)).filter(Boolean));
  const fieldNamesById = new Map(publicFields.map((option: any) => [Number(option.field?.id), String(option.field?.name || "")]));
  const allFields = await getActiveFields(db, view.table_id);
  const fields = allFields.filter((field) => enabledFieldIds.has(Number(field.id)));
  const table = await db.prepare(
    `SELECT t.name AS table_name, t.database_id, a.workspace_id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=?`
  ).bind(view.table_id).first<{ table_name: string; database_id: number; workspace_id: number }>();

  const tn = `database_table_${view.table_id}`;
  const now = new Date().toISOString();
  await ensureUserTableSystemColumns(db, Number(view.table_id));
  const maxOrder = await db.prepare(`SELECT COALESCE(MAX([order]), 0) AS max_order FROM "${tn}" WHERE COALESCE(trashed, 0)=0`)
    .first<{ max_order: number }>();
  const cols = ["[order]", "_created_on", "_updated_on"];
  const vals: unknown[] = [(maxOrder?.max_order || 0) + 10000, now, now];
  const changedFieldIds = new Set<number>();

  const validationErrors: Record<string, unknown> = {};
  for (const option of publicFields as any[]) {
    const fieldId = Number(option.field?.id);
    const fieldKey = `field_${fieldId}`;
    const nameKey = String(option.field?.name || "");
    const hasFieldKey = Object.prototype.hasOwnProperty.call(body, fieldKey);
    const hasNameKey = acceptFieldNames && nameKey && Object.prototype.hasOwnProperty.call(body, nameKey);
    const value = hasFieldKey ? body[fieldKey] : hasNameKey ? body[nameKey] : undefined;
    const required = Boolean(option.required) && !(option.show_when_matching_conditions && option.conditions?.length > 0);
    if (required && isEmptyRequiredFormValue(value)) {
      validationErrors[fieldKey] = [{ error: "This field is required.", code: "required" }];
      continue;
    }
    if (option.include_all_select_options === false && value !== undefined && value !== null && value !== "") {
      const allowedIds = new Set((option.allowed_select_options || []).map(Number));
      const selectedIds = formSelectOptionIds(value);
      const invalidIndexes = selectedIds
        .map((id, index) => ({ id, index }))
        .filter(({ id }) => !allowedIds.has(id));
      if (invalidIndexes.length > 0) {
        if (option.field?.type === "multiple_select") {
          validationErrors[fieldKey] = Object.fromEntries(invalidIndexes.map(({ id, index }) => [
            String(index),
            [{ error: `The provided select option ${id} is not allowed.`, code: "invalid" }],
          ]));
        } else {
          const id = invalidIndexes[0].id;
          validationErrors[fieldKey] = [{ error: `The provided select option ${id} is not allowed.`, code: "invalid" }];
        }
      }
    }
  }
  if (Object.keys(validationErrors).length > 0) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", validationErrors);
  }

  for (const field of fields) {
    const fieldKey = `field_${field.id}`;
    const nameKey = fieldNamesById.get(Number(field.id)) || "";
    const hasFieldKey = Object.prototype.hasOwnProperty.call(body, fieldKey);
    const hasNameKey = acceptFieldNames && nameKey && Object.prototype.hasOwnProperty.call(body, nameKey);
    if (!hasFieldKey && !hasNameKey) continue;
    const value = hasFieldKey ? body[fieldKey] : body[nameKey];
    cols.push(`"${fieldKey}"`);
    vals.push(await serializeFieldValueForStorage(db, field, value, env, table?.workspace_id || null));
    changedFieldIds.add(Number(field.id));
  }
  const existingFieldIds = new Set(cols.flatMap((column) => {
    const match = column.match(/^"field_(\d+)"$/);
    return match ? [Number(match[1])] : [];
  }));
  const missingValues = await missingCreateFieldValues(db, allFields, existingFieldIds, { now });
  for (const [fieldId, value] of missingValues) {
    cols.push(`"field_${fieldId}"`);
    vals.push(value);
  }
  const autonumberValues = await allocateAutonumberValues(db, Number(view.table_id));
  for (const [fieldId, value] of autonumberValues) {
    cols.push(`"field_${fieldId}"`);
    vals.push(serializeFieldValueForInsert("autonumber", value));
  }

  const bindMarks = cols.map(() => "?").join(", ");
  const row = await db.prepare(`INSERT INTO "${tn}" (${cols.join(", ")}) VALUES (${bindMarks}) RETURNING id`)
    .bind(...vals)
    .first<{ id: number }>();
  if (!row) throw new Error("Failed to submit form row");
  await finalizeRowWrite(db, Number(view.table_id), row.id, null, changedFieldIds, null, env);

  const subscriberRows = await db.prepare(
    `SELECT user_id
     FROM database_formview_users_to_notify_on_submit
     WHERE formview_id=?
     ORDER BY user_id ASC`
  ).bind(view.id).all<{ user_id: number }>();
  const recipientIds: number[] = [];
  for (const subscriber of subscriberRows.results || []) {
    try {
      await assertHasViewRole(db, subscriber.user_id, Number(view.id), "VIEWER");
      recipientIds.push(Number(subscriber.user_id));
    } catch (error) {
      if (!(error instanceof PermissionError)) throw error;
    }
  }
  if (recipientIds.length > 0 && table) {
    const inserted = await db.prepare(`SELECT * FROM "${tn}" WHERE id=?`).bind(row.id).first<Record<string, unknown>>();
    const fieldById = new Map(fields.map((field) => [Number(field.id), field]));
    const values = publicFields.flatMap((option: any) => {
      const fieldId = Number(option.field?.id);
      const field = fieldById.get(fieldId);
      if (!field || !changedFieldIds.has(fieldId)) return [];
      const value = deserializeFieldValue(field.type, inserted?.[`field_${fieldId}`]);
      return [[String(field.name || option.name || ""), humanReadableFormNotificationValue(value)]];
    });
    await createDirectNotificationForUsers(db, {
      type: "form_submitted",
      recipientIds,
      senderId,
      workspaceId: table.workspace_id,
      data: {
        form_id: Number(view.id),
        form_name: String(view.name || ""),
        table_id: Number(view.table_id),
        table_name: String(table.table_name || ""),
        database_id: Number(table.database_id),
        row_id: Number(row.id),
        values,
      },
    });
  }
  return row;
}

function isEmptyRequiredFormValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0;
}

function formSelectOptionIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => Number(
    item && typeof item === "object" ? (item as Record<string, unknown>).id : item
  )).filter((id) => Number.isInteger(id));
}

function humanReadableFormNotificationValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(humanReadableFormNotificationValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    for (const key of ["value", "name", "visible_name", "original_name", "email", "url"]) {
      if (item[key] !== null && item[key] !== undefined && item[key] !== "") return String(item[key]);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

views.get("/form/:slug/submit/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const view = await getPublicFormView(c.env.DB, slug);
  const authError = await publicViewAuthorizationResponse(c, view, true);
  if (authError) return authError;
  const fields = await getPublicFormFields(c.env.DB, view);

  return c.json({
    title: view.title || view.name,
    description: view.form_description || "",
    cover_image: parseJsonObject(view.cover_image),
    logo_image: parseJsonObject(view.logo_image),
    submit_text: view.submit_text || "Submit",
    submit_action: view.submit_action || "MESSAGE",
    submit_action_message: view.submit_action_message || "",
    submit_action_redirect_url: view.submit_action_redirect_url || "",
    mode: view.mode || "form",
    show_logo: view.show_logo === null || view.show_logo === undefined ? true : Boolean(view.show_logo),
    allow_public_export: Boolean(view.allow_public_export),
    fields,
  });
});

views.post("/form/:slug/submit/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const view = await getPublicFormView(c.env.DB, slug);
  const authError = await publicViewAuthorizationResponse(c, view, true);
  if (authError) return authError;
  const body = await c.req.json<Record<string, unknown>>();
  const row = await submitPublicFormRow(c.env, view, body, false, c.get("user")?.id || null);

  return c.json({
    row_id: row.id,
    submit_action: view.submit_action || "MESSAGE",
    submit_action_message: view.submit_action_message || "",
    submit_action_redirect_url: view.submit_action_redirect_url || "",
  });
});

views.post("/form/:slug/upload-file/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const view = await getPublicFormView(c.env.DB, slug);
  const authError = await publicViewAuthorizationResponse(c, view, true);
  if (authError) return authError;
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return c.json({
      error: "ERROR_INVALID_FILE",
      detail: "No file has been provided or the file is invalid.",
    }, 400);
  }

  try {
    const stored = await storeUserFile(c.env, {
      userId: null,
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      body: file.stream(),
    });
    return c.json(await serializeUserFileForRequest(c.env, stored, Number(view.workspace_id || 0) || null), 200);
  } catch (error) {
    if (error instanceof UserFileSizeTooLargeError) {
      return c.json(userFileSizeTooLargeResponse(error), 413);
    }
    throw error;
  }
});

// ── POST /api/database/views/public/:slug/submit/ — Form submission (no auth)
views.post("/public/:slug/submit/", optionalAuthMiddleware, async (c) => {
  const slug = c.req.param("slug");
  const view = await getPublicFormView(c.env.DB, slug);
  const authError = await publicViewAuthorizationResponse(c, view, true);
  if (authError) return authError;

  const body = await c.req.json<Record<string, unknown>>();
  const row = await submitPublicFormRow(c.env, view, body, true, c.get("user")?.id || null);

  return c.json({
    row_id: row.id,
    submit_action: view.submit_action || "MESSAGE",
    submit_action_message: view.submit_action_message || "",
    submit_action_redirect_url: view.submit_action_redirect_url || "",
  }, 200);
});

views.get("/:viewType/:viewId/:suffix{.+}", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const viewType = c.req.param("viewType");
  const suffix = c.req.param("suffix");
  if (suffix !== "public/rows/" && suffix !== "public/rows") {
    throw new DoesNotExist("View route", suffix);
  }
  const view = await getPublicTypedView(c.env.DB, viewType, c.req.param("viewId"), user?.id);
  const authError = await publicViewAuthorizationResponse(c, view);
  if (authError) return authError;
  const publicFieldIds = await getPublicVisibleFieldIds(c.env.DB, view);
  if (viewType === "kanban") return c.json(await getKanbanRowsPayload(c.env.DB, view, c.req.url, user?.id, publicFieldIds));
  if (viewType === "calendar") {
    const payload = await getCalendarRowsPayload(c.env.DB, view, c.req.url, user?.id, publicFieldIds);
    if ("status" in payload) return c.json({ error: payload.error, detail: payload.detail }, payload.status as 400);
    return c.json(payload);
  }
  if (viewType === "timeline") {
    const invalidTimeline = await validateTimelineDateSettings(c.env.DB, view);
    if (invalidTimeline) return invalidTimeline;
  }
  return c.json(await getViewRowsPayload(c.env.DB, view, c.req.url, user?.id, publicFieldIds));
});

export { views as viewRouter };
