import type { D1Database } from "@cloudflare/workers-types";
import { connect } from "cloudflare:sockets";
import { ApiError, DoesNotExist, ValidationError } from "../middleware/error";
import type { Env } from "../types/env";
import {
  ensureUserTableSystemColumns,
  serializeFieldValueForInsert,
  serializeRow,
  type FieldMeta,
  type FieldType,
} from "./dynamic-tables";
import { listIntegrations, listUserSources } from "./application-extras";
import { assertHasApplicationRole } from "./enterprise-permissions";
import { dispatchPublicHttpRequest } from "./outbound-http";
import { numericStorageSqlExpression } from "./number-format";
import { applyFilters, type FilterSpec } from "./row-filters";
import { evaluateCommonRuntimeFormulaCall } from "./runtime-formulas";
import { getSelectOptions, serializeDatabaseFieldRow } from "./field-serialization";
import { serializeUserFile, serializeUserFileForRequest, type StoredUserFile } from "./user-files";
import { allocateAutonumberValues } from "./autonumber";
import { missingCreateFieldValues } from "./row-create-values";
import { finalizeRowWrite, modifiedFieldValues } from "./row-write-effects";
import { synchronizeLinkRowRelations } from "./link-row-relations";
import { workspaceGenerativeAISettings } from "./generative-ai";
import { parseFormulaAst } from "./formula-engine";

type JsonObject = Record<string, unknown>;
type DispatchQuery = Record<string, string | undefined> | URLSearchParams;
type BuilderFormulaContext = JsonObject | undefined;

const PAGE_COLUMNS = new Set([
  "name",
  "path",
  "path_params",
  "query_params",
  "shared",
  "visibility",
  "role_type",
  "roles",
]);

const ELEMENT_COLUMNS = new Set(["type", "parent_element_id", "place_in_container"]);
const DATA_SOURCE_COLUMNS = new Set(["type", "name", "page_id"]);
const WORKFLOW_COLUMNS = new Set(["type", "event", "element_id"]);
const DOMAIN_COLUMNS = new Set(["type", "domain_name"]);
const TRIGGER_TYPES = new Set([
  "http_trigger",
  "periodic",
  "local_supertask_rows_created",
  "local_supertask_rows_updated",
  "local_supertask_rows_deleted",
]);

const ELEMENT_TYPES = new Set([
  "column",
  "form_container",
  "simple_container",
  "table",
  "repeat",
  "record_selector",
  "heading",
  "text",
  "link",
  "image",
  "rating",
  "rating_input",
  "input_text",
  "button",
  "checkbox",
  "choice",
  "iframe",
  "datetime_picker",
  "header",
  "footer",
  "menu",
  "auth_form",
  "input_file",
]);

const MULTI_PAGE_ELEMENT_TYPES = new Set(["header", "footer"]);
const INPUT_HINT_PROPERTY = ["place", "holder"].join("");
const CONTAINER_ELEMENT_TYPES = new Set([
  "column",
  "form_container",
  "simple_container",
  "repeat",
  "header",
  "footer",
]);
const BUILDER_FORMULA_MODES = new Set(["simple", "advanced", "raw"]);
const ELEMENT_FORMULA_FIELDS: Record<string, string[]> = {
  column: [],
  form_container: ["submit_button_label"],
  simple_container: [],
  table: ["button_load_more_label"],
  repeat: ["button_load_more_label"],
  record_selector: [
    "button_load_more_label",
    "label",
    "default_value",
    INPUT_HINT_PROPERTY,
    "option_name_suffix",
  ],
  heading: ["value"],
  text: ["value"],
  link: ["navigate_to_url", "value"],
  image: ["image_url", "alt_text"],
  rating: ["value"],
  rating_input: ["value", "label"],
  input_text: ["label", "default_value", INPUT_HINT_PROPERTY],
  button: ["value"],
  checkbox: ["label", "default_value"],
  choice: ["label", "default_value", INPUT_HINT_PROPERTY, "formula_value", "formula_name"],
  iframe: ["url", "embed"],
  datetime_picker: ["label", "default_value"],
  header: [],
  footer: [],
  menu: [],
  auth_form: ["login_button_label"],
  input_file: ["label", "default_name", "default_url", "help_text"],
};
const COLLECTION_FIELD_FORMULA_FIELDS: Record<string, string[]> = {
  boolean: ["value"],
  rating: ["value"],
  text: ["value"],
  link: ["navigate_to_url", "link_name"],
  tags: ["values", "colors"],
  button: ["label"],
  image: ["src", "alt"],
};

function simpleFormula(formula = "") {
  return { formula, mode: "simple", version: "0.1" };
}

type ValidationPath = Array<string | number>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validationDetail(path: ValidationPath, error: string, code = "invalid"): unknown {
  let detail: unknown = [{ error, code }];
  for (let index = path.length - 1; index >= 0; index--) {
    const part = path[index];
    if (typeof part === "number") {
      const items = Array.from({ length: part + 1 }, () => null as unknown);
      items[part] = detail;
      detail = items;
    } else {
      detail = { [part]: detail };
    }
  }
  return detail;
}

function builderRequestValidationError(path: ValidationPath, error: string, code = "invalid"): never {
  throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", validationDetail(path, error, code));
}

function normalizeBuilderFormula(value: unknown, path: ValidationPath, forceRaw = false): JsonObject {
  if (
    value === undefined
    || value === null
    || value === ""
    || value === false
    || value === 0
    || (Array.isArray(value) && value.length === 0)
    || (isJsonObject(value) && Object.keys(value).length === 0)
  ) {
    return { ...simpleFormula(), ...(forceRaw ? { mode: "raw" } : {}) };
  }

  let formula: string;
  let mode = "simple";
  let version = "0.1";
  if (isJsonObject(value)) {
    if (typeof value.formula !== "string") {
      builderRequestValidationError([...path, "formula"], "This field is required.", "required");
    }
    formula = value.formula;
    if (value.mode !== undefined) {
      if (typeof value.mode !== "string" || !BUILDER_FORMULA_MODES.has(value.mode)) {
        builderRequestValidationError([...path, "mode"], `\"${String(value.mode)}\" is not a valid choice.`);
      }
      mode = value.mode;
    }
    if (value.version !== undefined) {
      if (typeof value.version !== "string") {
        builderRequestValidationError([...path, "version"], "Not a valid string.");
      }
      version = value.version;
    }
  } else if (Array.isArray(value)) {
    builderRequestValidationError(path, "Not a valid formula object.");
  } else {
    formula = String(value);
  }

  if (forceRaw) mode = "raw";
  if (formula && mode !== "raw") {
    try {
      parseFormulaAst(formula);
    } catch (error: any) {
      builderRequestValidationError(path, `The formula is invalid: ${error?.message || String(error)}`);
    }
  }
  return { formula, version, mode };
}

function normalizeFormulaProperty(target: JsonObject, field: string, path: ValidationPath, forceRaw = false) {
  if (!Object.prototype.hasOwnProperty.call(target, field)) return;
  target[field] = normalizeBuilderFormula(target[field], [...path, field], forceRaw);
}

function normalizeNavigationParameters(target: JsonObject, field: "page_parameters" | "query_parameters", path: ValidationPath) {
  if (!Object.prototype.hasOwnProperty.call(target, field)) return;
  const parameters = target[field];
  if (!Array.isArray(parameters)) builderRequestValidationError([...path, field], "Expected a list of items.");
  target[field] = parameters.map((parameter, index) => {
    if (!isJsonObject(parameter)) builderRequestValidationError([...path, field, index], "Expected an object.");
    const normalized = { ...parameter };
    normalizeFormulaProperty(normalized, "value", [...path, field, index]);
    return normalized;
  });
}

function normalizeCollectionFields(configuration: JsonObject) {
  if (!Object.prototype.hasOwnProperty.call(configuration, "fields")) return;
  const fields = configuration.fields;
  if (!Array.isArray(fields)) builderRequestValidationError(["fields"], "Expected a list of items.");
  configuration.fields = fields.map((field, index) => {
    if (!isJsonObject(field)) builderRequestValidationError(["fields", index], "Expected an object.");
    const normalized = { ...field };
    const type = String(normalized.type || "");
    const formulaFields = COLLECTION_FIELD_FORMULA_FIELDS[type];
    if (!formulaFields) builderRequestValidationError(["fields", index, "type"], "The given field type doesn't exist.", "INVALID_FIELD_TYPE");
    for (const formulaField of formulaFields) {
      normalizeFormulaProperty(
        normalized,
        formulaField,
        ["fields", index],
        type === "tags" && formulaField === "colors" && normalized.colors_is_formula !== true,
      );
    }
    if (type === "link") {
      normalizeNavigationParameters(normalized, "page_parameters", ["fields", index]);
      normalizeNavigationParameters(normalized, "query_parameters", ["fields", index]);
    }
    return normalized;
  });
}

function normalizeMenuItems(configuration: JsonObject) {
  if (!Object.prototype.hasOwnProperty.call(configuration, "menu_items")) return;
  const items = configuration.menu_items;
  if (!Array.isArray(items)) builderRequestValidationError(["menu_items"], "Expected a list of items.");
  configuration.menu_items = items.map((item, index) => {
    if (!isJsonObject(item)) builderRequestValidationError(["menu_items", index], "Expected an object.");
    const normalized = { ...item };
    normalizeFormulaProperty(normalized, "navigate_to_url", ["menu_items", index]);
    normalizeNavigationParameters(normalized, "page_parameters", ["menu_items", index]);
    normalizeNavigationParameters(normalized, "query_parameters", ["menu_items", index]);
    return normalized;
  });
}

function normalizeElementFormulas(type: string, configuration: JsonObject) {
  normalizeFormulaProperty(configuration, "visibility_condition", []);
  for (const field of ELEMENT_FORMULA_FIELDS[type] || []) normalizeFormulaProperty(configuration, field, []);
  if (type === "link") {
    normalizeNavigationParameters(configuration, "page_parameters", []);
    normalizeNavigationParameters(configuration, "query_parameters", []);
  }
  if (type === "table") normalizeCollectionFields(configuration);
  if (type === "menu") normalizeMenuItems(configuration);
}

function baseElementDefaults(): JsonObject {
  return {
    css_classes: "",
    visibility: "all",
    visibility_condition: simpleFormula(),
    styles: {},
    style_border_top_color: "border",
    style_border_top_size: 0,
    style_padding_top: 10,
    style_margin_top: 0,
    style_border_bottom_color: "border",
    style_border_bottom_size: 0,
    style_padding_bottom: 10,
    style_margin_bottom: 0,
    style_border_left_color: "border",
    style_border_left_size: 0,
    style_padding_left: 20,
    style_margin_left: 0,
    style_border_right_color: "border",
    style_border_right_size: 0,
    style_padding_right: 20,
    style_margin_right: 0,
    style_background_radius: 0,
    style_border_radius: 0,
    style_background: "none",
    style_background_color: "#ffffffff",
    style_background_file: null,
    style_background_mode: "fill",
    style_width: "normal",
    style_width_child: "normal",
    role_type: "allow_all",
    roles: [],
  };
}

function collectionDefaults(): JsonObject {
  return {
    data_source_id: null,
    schema_property: null,
    items_per_page: 20,
    button_load_more_label: simpleFormula(),
    property_options: [],
  };
}

function navigationDefaults(): JsonObject {
  return {
    navigation_type: "page",
    navigate_to_page_id: null,
    navigate_to_url: simpleFormula(),
    page_parameters: [],
    query_parameters: [],
    target: "self",
  };
}

function elementTypeDefaults(type: string): JsonObject {
  const formula = () => simpleFormula();
  const defaults: Record<string, JsonObject> = {
    column: { column_amount: 3, column_gap: 20, alignment: "top" },
    form_container: { submit_button_label: formula(), reset_initial_values_post_submission: false },
    simple_container: {},
    table: {
      ...collectionDefaults(),
      orientation: { smartphone: "horizontal", tablet: "horizontal", desktop: "horizontal" },
      fields: [],
    },
    repeat: {
      ...collectionDefaults(),
      orientation: "vertical",
      items_per_row: {},
      horizontal_gap: 0,
      vertical_gap: 0,
    },
    record_selector: {
      ...collectionDefaults(),
      required: false,
      label: formula(),
      default_value: formula(),
      [INPUT_HINT_PROPERTY]: formula(),
      multiple: false,
      option_name_suffix: formula(),
    },
    heading: { value: formula(), level: 1 },
    text: { value: formula(), format: "plain" },
    link: { ...navigationDefaults(), value: formula(), variant: "link" },
    image: { image_source_type: "upload", image_file: null, image_url: formula(), alt_text: formula() },
    rating: { value: formula(), max_value: 5, color: "primary", rating_style: "star" },
    rating_input: { value: formula(), max_value: 5, color: "primary", rating_style: "star", required: false, label: formula() },
    input_text: {
      label: formula(),
      default_value: formula(),
      required: false,
      validation_type: "any",
      [INPUT_HINT_PROPERTY]: formula(),
      is_multiline: false,
      rows: 3,
      input_type: "text",
    },
    button: { value: formula() },
    checkbox: { label: formula(), default_value: formula(), required: false },
    choice: {
      label: formula(),
      default_value: formula(),
      required: false,
      [INPUT_HINT_PROPERTY]: formula(),
      options: [],
      multiple: false,
      show_as_dropdown: true,
      option_type: "manual",
      formula_value: formula(),
      formula_name: formula(),
    },
    iframe: { source_type: "url", url: formula(), embed: formula(), height: 300 },
    datetime_picker: {
      label: formula(),
      required: false,
      default_value: formula(),
      date_format: "EU",
      include_time: false,
      time_format: "24",
    },
    header: { share_type: "all", pages: [] },
    footer: { share_type: "all", pages: [] },
    menu: { orientation: "horizontal", alignment: "left", menu_items: [] },
    auth_form: { user_source_id: null, login_button_label: formula() },
    input_file: {
      label: formula(),
      multiple: false,
      required: false,
      default_name: formula(),
      default_url: formula(),
      help_text: formula(),
      max_filesize: 5,
      allowed_filetypes: [],
      preview: false,
    },
  };
  return defaults[type] || {};
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function boolInt(value: unknown): number {
  return value === true || value === 1 ? 1 : 0;
}

function splitKnownValues(body: JsonObject, known: Set<string>) {
  const direct: JsonObject = {};
  const extra: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (known.has(key)) direct[key] = value;
    else if (!["before_id", "domain_id", "metadata"].includes(key)) extra[key] = value;
  }
  return { direct, extra };
}

function orderValue(beforeId: unknown, beforeOrder: string | number | null | undefined, maxOrder: string | number | null | undefined) {
  if (beforeId !== null && beforeId !== undefined && beforeOrder !== null && beforeOrder !== undefined) {
    return String(Number(beforeOrder) - 1);
  }
  return String(Number(maxOrder || 0) + 10000);
}

export async function requireBuilderAccess(db: D1Database, userId: number | undefined, builderId: number, requiredRole = "VIEWER") {
  const app = await db.prepare(
    `SELECT a.*, w.name AS workspace_name
     FROM core_application a
     JOIN core_workspace w ON w.id = a.workspace_id
     WHERE a.id = ? AND a.type = 'builder' AND a.trashed = 0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  ).bind(builderId).first<any>();
  if (!app) throw new DoesNotExist("Builder", builderId);
  await assertHasApplicationRole(db, userId, builderId, requiredRole);
  return app;
}

export async function requirePageAccess(db: D1Database, userId: number | undefined, pageId: number, requiredRole = "VIEWER") {
  const page = await db.prepare(
    `SELECT p.*, a.workspace_id, a.name AS builder_name
     FROM builder_page p
     JOIN core_application a ON a.id = p.builder_id
     WHERE p.id = ? AND a.type = 'builder' AND a.trashed = 0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  ).bind(pageId).first<any>();
  if (!page) throw new DoesNotExist("Builder page", pageId);
  await assertHasApplicationRole(db, userId, Number(page.builder_id), requiredRole);
  return page;
}

export async function requireElementAccess(db: D1Database, userId: number | undefined, elementId: number, requiredRole = "VIEWER") {
  const element = await db.prepare(
    `SELECT e.*, p.builder_id, a.workspace_id
     FROM builder_element e
     JOIN builder_page p ON p.id = e.page_id
     JOIN core_application a ON a.id = p.builder_id
     WHERE e.id = ? AND a.type = 'builder' AND a.trashed = 0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  ).bind(elementId).first<any>();
  if (!element) throw new DoesNotExist("Builder element", elementId);
  await assertHasApplicationRole(db, userId, Number(element.builder_id), requiredRole);
  return element;
}

export async function requireDataSourceAccess(db: D1Database, userId: number | undefined, dataSourceId: number, requiredRole = "VIEWER") {
  const dataSource = await db.prepare(
    `SELECT ds.*, p.builder_id, a.workspace_id
     FROM builder_datasource ds
     JOIN builder_page p ON p.id = ds.page_id
     JOIN core_application a ON a.id = p.builder_id
     WHERE ds.id = ? AND a.type = 'builder' AND a.trashed = 0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  ).bind(dataSourceId).first<any>();
  if (!dataSource) throw new DoesNotExist("Builder data source", dataSourceId);
  await assertHasApplicationRole(db, userId, Number(dataSource.builder_id), requiredRole);
  return dataSource;
}

export async function requireWorkflowActionAccess(db: D1Database, userId: number | undefined, workflowActionId: number, requiredRole = "VIEWER") {
  const workflowAction = await db.prepare(
    `SELECT wa.*, p.builder_id, a.workspace_id
     FROM builder_workflowaction wa
     JOIN builder_page p ON p.id = wa.page_id
     JOIN core_application a ON a.id = p.builder_id
     WHERE wa.id = ? AND a.type = 'builder' AND a.trashed = 0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  ).bind(workflowActionId).first<any>();
  if (!workflowAction) throw new DoesNotExist("Builder workflow action", workflowActionId);
  await assertHasApplicationRole(db, userId, Number(workflowAction.builder_id), requiredRole);
  return workflowAction;
}

export async function requireDomainAccess(db: D1Database, userId: number | undefined, domainId: number, requiredRole = "VIEWER") {
  const domain = await db.prepare(
    `SELECT d.*, a.workspace_id
     FROM builder_domain d
     JOIN core_application a ON a.id = d.builder_id
     WHERE d.id = ? AND a.type = 'builder' AND a.trashed = 0`
  ).bind(domainId).first<any>();
  if (!domain) throw new DoesNotExist("Builder domain", domainId);
  await assertHasApplicationRole(db, userId, Number(domain.builder_id), requiredRole);
  return domain;
}

export async function ensureBuilderDefaults(db: D1Database, builderId: number) {
  const now = nowIso();
  // The page count and the idempotent default rows are independent, so they
  // share one D1 round trip instead of four sequential ones.
  const [pageCount] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM builder_page WHERE builder_id=?")
      .bind(builderId)
      .first<{ count: number }>(),
    db.prepare(
      "INSERT OR IGNORE INTO builder_theme (builder_id, theme, updated_on) VALUES (?, '{}', ?)"
    ).bind(builderId, now).run(),
    db.prepare(
      "INSERT OR IGNORE INTO builder_custom_code (builder_id, css, js, created_on, updated_on) VALUES (?, '', '', ?, ?)"
    ).bind(builderId, now, now).run(),
    runOptional(() =>
      db.prepare(
        "INSERT OR IGNORE INTO builder_settings (builder_id, favicon_file, login_page_id, created_on, updated_on) VALUES (?, NULL, NULL, ?, ?)"
      ).bind(builderId, now, now)
    ),
  ]);
  if ((pageCount?.count ?? 0) === 0) {
    await db.batch([
      db.prepare(
        `INSERT INTO builder_page
         (builder_id, name, path, path_params, query_params, shared, visibility, role_type, roles, settings, [order], created_on, updated_on)
         VALUES (?, 'Shared', '', '[]', '[]', 1, 'all', 'allow_all', '[]', '{}', 0, ?, ?)`
      ).bind(builderId, now, now),
      db.prepare(
        `INSERT INTO builder_page
         (builder_id, name, path, path_params, query_params, shared, visibility, role_type, roles, settings, [order], created_on, updated_on)
         VALUES (?, 'Home', '/', '[]', '[]', 0, 'all', 'allow_all', '[]', '{}', 1, ?, ?)`
      ).bind(builderId, now, now),
    ]);
  }
}

async function runOptional(statement: () => { run: () => Promise<unknown> }) {
  try {
    await statement().run();
  } catch (error) {
    if (!String((error as Error)?.message || error).toLowerCase().includes("no such")) throw error;
  }
}

async function firstOptional<T>(statement: () => { first: <R = T>() => Promise<R | null> }): Promise<T | null> {
  try {
    return await statement().first<T>();
  } catch (error) {
    if (String((error as Error)?.message || error).toLowerCase().includes("no such")) return null;
    throw error;
  }
}

async function getBuilderSettings(db: D1Database, builderId: number): Promise<{ favicon_file: string | null; login_page_id: number | null }> {
  const row = await firstOptional<{ favicon_file: string | null; login_page_id: number | null }>(() =>
    db.prepare("SELECT favicon_file, login_page_id FROM builder_settings WHERE builder_id=?").bind(builderId)
  );
  return {
    favicon_file: row?.favicon_file || null,
    login_page_id: row?.login_page_id === null || row?.login_page_id === undefined ? null : Number(row.login_page_id),
  };
}

function fileNameFromValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return typeof object.name === "string" && object.name.trim() ? object.name : null;
  }
  return null;
}

async function normalizeBuilderFaviconFile(db: D1Database, env: Env, workspaceId: number | null, value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === "") return null;
  const fileName = fileNameFromValue(value);
  if (fileName) {
    const stored = await db.prepare("SELECT * FROM core_userfile WHERE name=?").bind(fileName).first<StoredUserFile>();
    if (stored) {
      return JSON.stringify(await serializeUserFileForRequest(env, stored, workspaceId));
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
  throw new ValidationError("The provided favicon file does not exist.");
}

export async function updateBuilderApplicationSettings(
  db: D1Database,
  builderId: number,
  values: JsonObject,
  env: Env,
  workspaceId?: number | null
) {
  if (!Object.prototype.hasOwnProperty.call(values, "favicon_file") &&
      !Object.prototype.hasOwnProperty.call(values, "login_page_id")) {
    return;
  }

  await ensureBuilderDefaults(db, builderId);
  const existing = await getBuilderSettings(db, builderId);
  let faviconFile = existing.favicon_file;
  let loginPageId = existing.login_page_id;

  if (Object.prototype.hasOwnProperty.call(values, "favicon_file")) {
    const applicationWorkspace = await db.prepare("SELECT workspace_id FROM core_application WHERE id=?")
      .bind(builderId)
      .first<{ workspace_id: number }>();
    const resolvedWorkspaceId: number | null = workspaceId ?? applicationWorkspace?.workspace_id ?? null;
    faviconFile = await normalizeBuilderFaviconFile(db, env, resolvedWorkspaceId, values.favicon_file);
  }

  if (Object.prototype.hasOwnProperty.call(values, "login_page_id")) {
    const rawLoginPageId = values.login_page_id;
    if (rawLoginPageId === null || rawLoginPageId === undefined || rawLoginPageId === "") {
      loginPageId = null;
    } else {
      const nextLoginPageId = Number(rawLoginPageId);
      if (!Number.isFinite(nextLoginPageId)) throw new ValidationError("The provided login page does not exist.");
      const page = await db.prepare("SELECT id FROM builder_page WHERE id=? AND builder_id=?")
        .bind(nextLoginPageId, builderId)
        .first<{ id: number }>();
      if (!page) throw new ValidationError("The provided login page does not exist.");
      loginPageId = Number(page.id);
    }
  }

  const now = nowIso();
  await runOptional(() =>
    db.prepare(
      `INSERT INTO builder_settings (builder_id, favicon_file, login_page_id, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(builder_id) DO UPDATE SET
         favicon_file=excluded.favicon_file,
         login_page_id=excluded.login_page_id,
         updated_on=excluded.updated_on`
    ).bind(builderId, faviconFile, loginPageId, now, now)
  );
}

export function serializePage(row: any): JsonObject {
  return {
    ...parseJson<JsonObject>(row.settings, {}),
    id: row.id,
    builder_id: row.builder_id,
    name: row.name,
    path: row.path,
    path_params: parseJson(row.path_params, []),
    query_params: parseJson(row.query_params, []),
    shared: Boolean(row.shared),
    visibility: row.visibility,
    role_type: row.role_type,
    roles: parseJson(row.roles, []),
    order: row.order,
  };
}

export function serializeElement(row: any): JsonObject {
  return {
    ...baseElementDefaults(),
    ...elementTypeDefaults(String(row.type)),
    ...parseJson<JsonObject>(row.configuration, {}),
    id: row.id,
    page_id: row.page_id,
    type: row.type,
    order: row.order,
    parent_element_id: row.parent_element_id ?? null,
    place_in_container: row.place_in_container ?? null,
  };
}

async function validateAuthFormUserSource(
  db: D1Database,
  pageId: number,
  userSourceId: unknown,
) {
  if (userSourceId === null) return;

  const normalizedId = Number(userSourceId);
  if (!Number.isInteger(normalizedId)) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", {
      user_source_id: [
        {
          detail: "A valid integer is required.",
          code: "invalid",
        },
      ],
    });
  }

  const userSource = await db.prepare("SELECT id, application_id FROM core_usersource WHERE id=?")
    .bind(normalizedId)
    .first<{ id: number; application_id: number }>();
  if (!userSource) {
    throw new ApiError(
      404,
      "ERROR_USER_SOURCE_DOES_NOT_EXIST",
      "The requested user_source does not exist.",
    );
  }

  const page = await db.prepare("SELECT builder_id FROM builder_page WHERE id=?")
    .bind(pageId)
    .first<{ builder_id: number }>();
  if (!page) throw new DoesNotExist("Builder page", pageId);
  if (Number(page.builder_id) !== Number(userSource.application_id)) {
    throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", {
      user_source_id: [
        {
          detail: "The provided user source doesn't belong to the same application.",
          code: "invalid_user_source",
        },
      ],
    });
  }
}

export async function serializeDataSource(db: D1Database, row: any): Promise<JsonObject> {
  const config = parseJson<JsonObject>(row.configuration, {});
  const dataSource: JsonObject = {
    ...config,
    id: row.id,
    page_id: row.page_id,
    type: row.type,
    name: row.name,
    order: row.order,
  };
  if (Number(config.table_id)) {
    dataSource.schema = await schemaForDataSource(db, Number(config.table_id), row.type, config);
    dataSource.context_data = await contextDataForDataSource(db, Number(config.table_id), row.type, config);
    dataSource.context_data_schema = await contextDataSchemaForDataSource(db, Number(config.table_id), row.type);
  }
  return dataSource;
}

export function serializeDomain(row: any): JsonObject {
  return {
    ...parseJson<JsonObject>(row.settings, {}),
    id: row.id,
    builder_id: row.builder_id,
    type: row.type,
    domain_name: row.domain_name,
    published: Boolean(row.published_to_id || row.published),
    last_published: row.last_published ?? null,
  };
}

export async function serializeWorkflowAction(db: D1Database, row: any): Promise<JsonObject> {
  const config = parseJson<JsonObject>(row.configuration, {});
  const workflowAction: JsonObject = {
    ...config,
    id: row.id,
    page_id: row.page_id,
    element_id: row.element_id ?? null,
    type: row.type,
    event: row.event,
    order: row.order,
  };
  if (config.service && typeof config.service === "object" && !Array.isArray(config.service)) {
    workflowAction.service = await serializeWorkflowActionService(
      db,
      row,
      config.service as JsonObject
    );
  }
  return workflowAction;
}

export async function serializeBuilderApplication(
  db: D1Database,
  app: any,
  env?: Env,
  options: { public?: boolean } = {},
): Promise<JsonObject> {
  await ensureBuilderDefaults(db, app.id);
  const [pages, theme, settings, integrations, userSources, customCode, scripts] = await Promise.all([
    db.prepare("SELECT * FROM builder_page WHERE builder_id=? ORDER BY [order] ASC, id ASC")
      .bind(app.id)
      .all<any>(),
    db.prepare("SELECT theme FROM builder_theme WHERE builder_id=?")
      .bind(app.id)
      .first<{ theme: string }>(),
    getBuilderSettings(db, app.id),
    listIntegrations(db, app.id),
    listUserSources(db, app.id, options),
    readBuilderCustomCode(db, app.id),
    readBuilderCustomScripts(db, app.id),
  ]);
  const faviconFileName = fileNameFromValue(parseJson(settings.favicon_file, null));
  const storedFavicon = faviconFileName
    ? await db.prepare("SELECT * FROM core_userfile WHERE name=?").bind(faviconFileName).first<StoredUserFile>()
    : null;
  const faviconFile = storedFavicon
    ? env
      ? await serializeUserFileForRequest(env, storedFavicon, Number(app.workspace_id || 0) || null)
      : serializeUserFile({ PUBLIC_URL: undefined } as unknown as Env, storedFavicon)
    : parseJson(settings.favicon_file, null);

  return {
    favicon_file: faviconFile,
    login_page_id: settings.login_page_id,
    pages: (pages.results || []).map(serializePage),
    theme: parseJson(theme?.theme, {}),
    integrations,
    user_sources: userSources,
    custom_code: customCode,
    scripts,
  };
}

export async function getBuilderCustomCode(db: D1Database, builderId: number): Promise<JsonObject> {
  await ensureBuilderDefaults(db, builderId);
  return readBuilderCustomCode(db, builderId);
}

async function readBuilderCustomCode(db: D1Database, builderId: number): Promise<JsonObject> {
  const row = await db.prepare("SELECT css, js FROM builder_custom_code WHERE builder_id=?")
    .bind(builderId)
    .first<{ css: string; js: string }>();
  return {
    css: row?.css || "",
    js: row?.js || "",
  };
}

export async function listBuilderCustomScripts(db: D1Database, builderId: number): Promise<JsonObject[]> {
  await ensureBuilderDefaults(db, builderId);
  return readBuilderCustomScripts(db, builderId);
}

async function readBuilderCustomScripts(db: D1Database, builderId: number): Promise<JsonObject[]> {
  const rows = await db.prepare(
    `SELECT id, type, url, load_type, crossorigin
     FROM builder_custom_script
     WHERE builder_id=?
     ORDER BY [order] ASC, id ASC`
  ).bind(builderId).all<any>();
  return (rows.results || []).map((row) => ({
    id: row.id,
    type: row.type || "javascript",
    url: row.url || "",
    load_type: row.load_type || "",
    crossorigin: row.crossorigin || "",
  }));
}

export async function updateBuilderCustomCodeSettings(db: D1Database, builderId: number, values: JsonObject) {
  await ensureBuilderDefaults(db, builderId);
  const now = nowIso();
  const customCode = objectValue(values.custom_code);
  if (customCode) {
    await db.prepare("UPDATE builder_custom_code SET css=?, js=?, updated_on=? WHERE builder_id=?")
      .bind(String(customCode.css || ""), String(customCode.js || ""), now, builderId)
      .run();
  }

  if (Array.isArray(values.scripts)) {
    await db.prepare("DELETE FROM builder_custom_script WHERE builder_id=?").bind(builderId).run();
    const statements = values.scripts.map((script, index) => {
      const item = objectValue(script) || {};
      return db.prepare(
        `INSERT INTO builder_custom_script
         (builder_id, [order], type, url, load_type, crossorigin, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        builderId,
        index,
        String(item.type || "javascript"),
        String(item.url || ""),
        String(item.load_type || ""),
        String(item.crossorigin || ""),
        now,
        now
      );
    });
    if (statements.length > 0) await db.batch(statements);
  }
}

export async function listPages(db: D1Database, builderId: number) {
  await ensureBuilderDefaults(db, builderId);
  const result = await db.prepare("SELECT * FROM builder_page WHERE builder_id=? ORDER BY [order] ASC, id ASC")
    .bind(builderId)
    .all<any>();
  return (result.results || []).map(serializePage);
}

export async function createPage(db: D1Database, builderId: number, body: JsonObject) {
  const maxOrder = await db.prepare("SELECT COALESCE(MAX([order]), 0) AS max_order FROM builder_page WHERE builder_id=? AND shared=0")
    .bind(builderId)
    .first<{ max_order: number }>();
  const now = nowIso();
  const { direct, extra } = splitKnownValues(body, PAGE_COLUMNS);
  const row = await db.prepare(
    `INSERT INTO builder_page
     (builder_id, name, path, path_params, query_params, shared, visibility, role_type, roles, settings, [order], created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  ).bind(
    builderId,
    String(direct.name || "Untitled"),
    String(direct.path || "/"),
    JSON.stringify(direct.path_params || []),
    JSON.stringify(direct.query_params || []),
    boolInt(direct.shared),
    String(direct.visibility || "all"),
    String(direct.role_type || "allow_all"),
    JSON.stringify(direct.roles || []),
    JSON.stringify(extra),
    (maxOrder?.max_order || 0) + 1,
    now,
    now
  ).first<any>();
  if (!row) throw new Error("Failed to create builder page");
  return serializePage(row);
}

export async function updatePage(db: D1Database, pageId: number, body: JsonObject) {
  const existing = await db.prepare("SELECT * FROM builder_page WHERE id=?").bind(pageId).first<any>();
  if (!existing) throw new DoesNotExist("Builder page", pageId);
  const { direct, extra } = splitKnownValues(body, PAGE_COLUMNS);
  const settings = { ...parseJson<JsonObject>(existing.settings, {}), ...extra };
  await db.prepare(
    `UPDATE builder_page SET
       name=?, path=?, path_params=?, query_params=?, visibility=?, role_type=?, roles=?, settings=?, updated_on=?
     WHERE id=?`
  ).bind(
    direct.name !== undefined ? String(direct.name) : existing.name,
    direct.path !== undefined ? String(direct.path) : existing.path,
    direct.path_params !== undefined ? JSON.stringify(direct.path_params) : existing.path_params,
    direct.query_params !== undefined ? JSON.stringify(direct.query_params) : existing.query_params,
    direct.visibility !== undefined ? String(direct.visibility) : existing.visibility,
    direct.role_type !== undefined ? String(direct.role_type) : existing.role_type,
    direct.roles !== undefined ? JSON.stringify(direct.roles) : existing.roles,
    JSON.stringify(settings),
    nowIso(),
    pageId
  ).run();
  const updated = await db.prepare("SELECT * FROM builder_page WHERE id=?").bind(pageId).first<any>();
  return serializePage(updated);
}

function remapBuilderPageReferences(value: unknown, maps: {
  pageId?: number;
  dataSources?: Map<number, number>;
  elements?: Map<number, number>;
  workflowActions?: Map<number, number>;
  integrations?: Map<number, number>;
  userSources?: Map<number, number>;
}): unknown {
  if (Array.isArray(value)) return value.map((item) => remapBuilderPageReferences(item, maps));
  if (typeof value === "string") {
    let result = value;
    if (maps.dataSources) {
      result = result.replace(/\bdata_source\.(\d+)\b/g, (match, rawId) => {
        const id = Number(rawId);
        return maps.dataSources!.has(id) ? `data_source.${maps.dataSources!.get(id)}` : match;
      });
    }
    if (maps.workflowActions) {
      result = result.replace(/\bprevious_action\.(\d+)\b/g, (match, rawId) => {
        const id = Number(rawId);
        return maps.workflowActions!.has(id) ? `previous_action.${maps.workflowActions!.get(id)}` : match;
      });
    }
    return result;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, item]) => {
    if (key === "page_id" && maps.pageId) return [key, maps.pageId];
    if (key === "integration_id" && maps.integrations) {
      const id = Number(item);
      return [key, Number.isFinite(id) && maps.integrations.has(id) ? maps.integrations.get(id)! : item];
    }
    if (["user_source_id", "user_source"].includes(key) && maps.userSources) {
      const id = Number(item);
      return [key, Number.isFinite(id) && maps.userSources.has(id) ? maps.userSources.get(id)! : item];
    }
    if (["data_source_id", "datasource_id", "builder_datasource_id"].includes(key) && maps.dataSources) {
      const id = Number(item);
      return [key, Number.isFinite(id) && maps.dataSources.has(id) ? maps.dataSources.get(id)! : item];
    }
    if (["element_id", "parent_element_id", "builder_element_id"].includes(key) && maps.elements) {
      const id = Number(item);
      return [key, Number.isFinite(id) && maps.elements.has(id) ? maps.elements.get(id)! : item];
    }
    if (["workflow_action_id", "builder_workflow_action_id"].includes(key) && maps.workflowActions) {
      const id = Number(item);
      return [key, Number.isFinite(id) && maps.workflowActions.has(id) ? maps.workflowActions.get(id)! : item];
    }
    return [key, remapBuilderPageReferences(item, maps)];
  }));
}

function remapBuilderPageJson(value: string | null | undefined, maps: {
  pageId?: number;
  dataSources?: Map<number, number>;
  elements?: Map<number, number>;
  workflowActions?: Map<number, number>;
  integrations?: Map<number, number>;
  userSources?: Map<number, number>;
}) {
  return JSON.stringify(remapBuilderPageReferences(parseJson<JsonObject>(value, {}), maps));
}

function remapBuilderStoredJson<T>(value: string | null | undefined, fallback: T, maps: {
  pageId?: number;
  dataSources?: Map<number, number>;
  elements?: Map<number, number>;
  workflowActions?: Map<number, number>;
  integrations?: Map<number, number>;
  userSources?: Map<number, number>;
}) {
  return JSON.stringify(remapBuilderPageReferences(parseJson<T>(value, fallback), maps));
}

export async function duplicateBuilderApplication(
  db: D1Database,
  sourceBuilderId: number,
  duplicatedBuilderId: number,
  publicationDomainId?: number,
) {
  const now = nowIso();
  const integrationMap = new Map<number, number>();
  const userSourceMap = new Map<number, number>();
  const pageMap = new Map<number, number>();
  const dataSourceMap = new Map<number, number>();
  const elementMap = new Map<number, number>();
  const workflowActionMap = new Map<number, number>();

  const integrations = await db.prepare(
    "SELECT * FROM core_integration WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC"
  ).bind(sourceBuilderId).all<any>();
  for (const integration of integrations.results || []) {
    const inserted = await db.prepare(
      `INSERT INTO core_integration (application_id, type, name, [order], configuration, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      duplicatedBuilderId,
      integration.type,
      integration.name,
      integration.order,
      remapBuilderStoredJson(integration.configuration, {}, { integrations: integrationMap }),
      now,
      now
    ).first<{ id: number }>();
    if (inserted?.id) integrationMap.set(Number(integration.id), Number(inserted.id));
  }

  const userSources = await db.prepare(
    "SELECT * FROM core_usersource WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC"
  ).bind(sourceBuilderId).all<any>();
  for (const userSource of userSources.results || []) {
    const integrationId = userSource.integration_id && integrationMap.has(Number(userSource.integration_id))
      ? integrationMap.get(Number(userSource.integration_id))!
      : userSource.integration_id ?? null;
    const inserted = await db.prepare(
      `INSERT INTO core_usersource
       (application_id, integration_id, type, name, uid, [order], configuration, auth_providers, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET updated_on=excluded.updated_on
       WHERE core_usersource.application_id=excluded.application_id
       RETURNING id`
    ).bind(
      duplicatedBuilderId,
      integrationId,
      userSource.type,
      userSource.name,
      publicationDomainId
        ? `domain_${publicationDomainId}__${userSource.uid}`
        : crypto.randomUUID(),
      userSource.order,
      remapBuilderStoredJson(userSource.configuration, {}, { integrations: integrationMap, userSources: userSourceMap }),
      remapBuilderStoredJson(userSource.auth_providers, [], { integrations: integrationMap, userSources: userSourceMap }),
      now,
      now
    ).first<{ id: number }>();
    if (!inserted?.id) {
      throw new ValidationError("The duplicated user source UID is already in use.");
    }
    userSourceMap.set(Number(userSource.id), Number(inserted.id));
    if (!publicationDomainId) {
      await db.prepare("UPDATE core_usersource SET uid=? WHERE id=?")
        .bind(`__user_source_${inserted.id}`, inserted.id)
        .run();
    }
  }

  const theme = await db.prepare("SELECT theme FROM builder_theme WHERE builder_id=?")
    .bind(sourceBuilderId)
    .first<{ theme: string }>();
  await db.prepare("INSERT OR REPLACE INTO builder_theme (builder_id, theme, updated_on) VALUES (?, ?, ?)")
    .bind(duplicatedBuilderId, remapBuilderStoredJson(theme?.theme, {}, { integrations: integrationMap, userSources: userSourceMap }), now)
    .run();

  const customCode = await db.prepare("SELECT css, js FROM builder_custom_code WHERE builder_id=?")
    .bind(sourceBuilderId)
    .first<{ css: string; js: string }>();
  await db.prepare(
    "INSERT OR REPLACE INTO builder_custom_code (builder_id, css, js, created_on, updated_on) VALUES (?, ?, ?, ?, ?)"
  ).bind(duplicatedBuilderId, customCode?.css || "", customCode?.js || "", now, now).run();

  const scripts = await db.prepare(
    "SELECT * FROM builder_custom_script WHERE builder_id=? ORDER BY [order] ASC, id ASC"
  ).bind(sourceBuilderId).all<any>();
  for (const script of scripts.results || []) {
    await db.prepare(
      `INSERT INTO builder_custom_script
       (builder_id, [order], type, url, load_type, crossorigin, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      duplicatedBuilderId,
      script.order,
      script.type || "javascript",
      script.url || "",
      script.load_type || "",
      script.crossorigin || "",
      now,
      now
    ).run();
  }

  const pages = await db.prepare("SELECT * FROM builder_page WHERE builder_id=? ORDER BY [order] ASC, id ASC")
    .bind(sourceBuilderId)
    .all<any>();
  for (const page of pages.results || []) {
    const inserted = await db.prepare(
      `INSERT INTO builder_page
       (builder_id, name, path, path_params, query_params, shared, visibility, role_type, roles, settings, [order], created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      duplicatedBuilderId,
      page.name,
      page.path,
      remapBuilderStoredJson(page.path_params, [], { integrations: integrationMap, userSources: userSourceMap }),
      remapBuilderStoredJson(page.query_params, [], { integrations: integrationMap, userSources: userSourceMap }),
      page.shared ? 1 : 0,
      page.visibility || "all",
      page.role_type || "allow_all",
      remapBuilderStoredJson(page.roles, [], { integrations: integrationMap, userSources: userSourceMap }),
      remapBuilderStoredJson(page.settings, {}, { integrations: integrationMap, userSources: userSourceMap }),
      page.order,
      now,
      now
    ).first<{ id: number }>();
    if (inserted?.id) pageMap.set(Number(page.id), Number(inserted.id));
  }

  const settings = await getBuilderSettings(db, sourceBuilderId);
  await runOptional(() =>
    db.prepare(
      `INSERT INTO builder_settings (builder_id, favicon_file, login_page_id, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(builder_id) DO UPDATE SET
         favicon_file=excluded.favicon_file,
         login_page_id=excluded.login_page_id,
         updated_on=excluded.updated_on`
    ).bind(
      duplicatedBuilderId,
      settings.favicon_file,
      settings.login_page_id ? pageMap.get(Number(settings.login_page_id)) ?? null : null,
      now,
      now
    )
  );

  for (const page of pages.results || []) {
    const newPageId = pageMap.get(Number(page.id));
    if (!newPageId) continue;
    const dataSources = await db.prepare("SELECT * FROM builder_datasource WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
      .bind(page.id)
      .all<any>();
    for (const dataSource of dataSources.results || []) {
      const inserted = await db.prepare(
        `INSERT INTO builder_datasource (page_id, type, name, [order], configuration, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        newPageId,
        dataSource.type,
        dataSource.name,
        dataSource.order,
        remapBuilderPageJson(dataSource.configuration, {
          pageId: newPageId,
          integrations: integrationMap,
          userSources: userSourceMap,
        }),
        now,
        now
      ).first<{ id: number }>();
      if (inserted?.id) dataSourceMap.set(Number(dataSource.id), Number(inserted.id));
    }
  }

  const pendingParents: Array<{ id: number; parentId: number | null }> = [];
  for (const page of pages.results || []) {
    const newPageId = pageMap.get(Number(page.id));
    if (!newPageId) continue;
    const elements = await db.prepare("SELECT * FROM builder_element WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
      .bind(page.id)
      .all<any>();
    for (const element of elements.results || []) {
      const inserted = await db.prepare(
        `INSERT INTO builder_element
         (page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?) RETURNING id`
      ).bind(
        newPageId,
        element.type,
        element.order,
        element.place_in_container ?? null,
        remapBuilderPageJson(element.configuration, {
          pageId: newPageId,
          dataSources: dataSourceMap,
          integrations: integrationMap,
          userSources: userSourceMap,
        }),
        now,
        now
      ).first<{ id: number }>();
      if (inserted?.id) {
        elementMap.set(Number(element.id), Number(inserted.id));
        pendingParents.push({
          id: Number(inserted.id),
          parentId: element.parent_element_id ? Number(element.parent_element_id) : null,
        });
      }
    }
  }

  for (const pending of pendingParents) {
    if (!pending.parentId) continue;
    const parentId = elementMap.get(pending.parentId);
    if (parentId) {
      await db.prepare("UPDATE builder_element SET parent_element_id=?, updated_on=? WHERE id=?")
        .bind(parentId, now, pending.id)
        .run();
    }
  }

  const pendingActionConfigs: Array<{ id: number; oldPageId: number; configuration: string | null }> = [];
  for (const page of pages.results || []) {
    const newPageId = pageMap.get(Number(page.id));
    if (!newPageId) continue;
    const workflowActions = await db.prepare("SELECT * FROM builder_workflowaction WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
      .bind(page.id)
      .all<any>();
    for (const action of workflowActions.results || []) {
      const inserted = await db.prepare(
        `INSERT INTO builder_workflowaction
         (page_id, element_id, type, event, [order], configuration, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        newPageId,
        action.element_id ? elementMap.get(Number(action.element_id)) ?? null : null,
        action.type,
        action.event,
        action.order,
        remapBuilderPageJson(action.configuration, {
          pageId: newPageId,
          dataSources: dataSourceMap,
          elements: elementMap,
          integrations: integrationMap,
          userSources: userSourceMap,
        }),
        now,
        now
      ).first<{ id: number }>();
      if (inserted?.id) {
        workflowActionMap.set(Number(action.id), Number(inserted.id));
        pendingActionConfigs.push({
          id: Number(inserted.id),
          oldPageId: Number(page.id),
          configuration: action.configuration,
        });
      }
    }
  }

  for (const pending of pendingActionConfigs) {
    const newPageId = pageMap.get(pending.oldPageId);
    if (!newPageId) continue;
    await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=?")
      .bind(
        remapBuilderPageJson(pending.configuration, {
          pageId: newPageId,
          dataSources: dataSourceMap,
          elements: elementMap,
          workflowActions: workflowActionMap,
          integrations: integrationMap,
          userSources: userSourceMap,
        }),
        now,
        pending.id
      )
      .run();
  }

  return {
    integrations: integrationMap,
    userSources: userSourceMap,
    pages: pageMap,
    dataSources: dataSourceMap,
    elements: elementMap,
    workflowActions: workflowActionMap,
  };
}

export async function publishBuilderDomain(db: D1Database, domainId: number) {
  const domain = await db.prepare(
    `SELECT d.*, a.workspace_id, a.name AS builder_name, a.[order] AS builder_order
     FROM builder_domain d
     JOIN core_application a ON a.id=d.builder_id
     WHERE d.id=? AND a.type='builder' AND a.trashed=0`
  ).bind(domainId).first<any>();
  if (!domain) throw new DoesNotExist("Builder domain", domainId);

  const now = nowIso();
  const previousPublicationId = Number(domain.published_to_id || 0);
  const previousUserSourceUids = previousPublicationId
    ? (await db.prepare("SELECT id, uid FROM core_usersource WHERE application_id=?")
      .bind(previousPublicationId)
      .all<{ id: number; uid: string }>()).results || []
    : [];
  const publication = await db.prepare(
    `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (?, ?, 'builder', ?, 0, ?, ?) RETURNING id`
  ).bind(
    domain.workspace_id,
    `${domain.builder_name} (${domain.domain_name})`,
    domain.builder_order,
    now,
    now
  ).first<{ id: number }>();
  if (!publication?.id) throw new Error("Failed to create the published builder application.");

  try {
    for (const previousUserSource of previousUserSourceUids) {
      await db.prepare("UPDATE core_usersource SET uid=?, updated_on=? WHERE id=?")
        .bind(
          `retired_${previousPublicationId}_${previousUserSource.id}__${previousUserSource.uid}`,
          now,
          previousUserSource.id,
        )
        .run();
    }
    await duplicateBuilderApplication(
      db,
      Number(domain.builder_id),
      Number(publication.id),
      domainId,
    );

    const updated = await db.prepare(
      `UPDATE builder_domain
       SET published_to_id=?, published=1, last_published=?, updated_on=?
       WHERE id=? AND COALESCE(published_to_id, 0)=?`
    ).bind(publication.id, now, now, domainId, previousPublicationId).run();
    const changedRows = Number((updated as any).meta?.changes ?? (updated as any).changes ?? 0);
    if (changedRows !== 1) {
      throw new ValidationError("This domain was published concurrently. Please publish it again.");
    }

    if (previousPublicationId) {
      await db.prepare("DELETE FROM core_application WHERE id=?").bind(previousPublicationId).run();
    }

    return {
      domainId,
      builderId: Number(domain.builder_id),
      publishedBuilderId: Number(publication.id),
      publishedAt: now,
    };
  } catch (error) {
    await db.prepare("DELETE FROM core_application WHERE id=?").bind(publication.id).run();
    for (const previousUserSource of previousUserSourceUids) {
      await db.prepare("UPDATE core_usersource SET uid=?, updated_on=? WHERE id=?")
        .bind(previousUserSource.uid, nowIso(), previousUserSource.id)
        .run();
    }
    throw error;
  }
}

export async function duplicatePage(db: D1Database, pageId: number) {
  const existing = await db.prepare("SELECT * FROM builder_page WHERE id=?").bind(pageId).first<any>();
  if (!existing) throw new DoesNotExist("Builder page", pageId);
  const now = nowIso();
  const maxOrder = await db.prepare("SELECT COALESCE(MAX([order]), 0) AS max_order FROM builder_page WHERE builder_id=? AND shared=0")
    .bind(existing.builder_id)
    .first<{ max_order: number }>();
  const duplicated = await db.prepare(
    `INSERT INTO builder_page
     (builder_id, name, path, path_params, query_params, shared, visibility, role_type, roles, settings, [order], created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    existing.builder_id,
    `${existing.name} copy`,
    `${existing.path || "/"}-copy`,
    existing.path_params || "[]",
    existing.query_params || "[]",
    existing.visibility || "all",
    existing.role_type || "allow_all",
    existing.roles || "[]",
    existing.settings || "{}",
    (maxOrder?.max_order || 0) + 1,
    now,
    now
  ).first<any>();
  if (!duplicated) throw new Error("Failed to duplicate builder page");

  const dataSourceMap = new Map<number, number>();
  const dataSources = await db.prepare("SELECT * FROM builder_datasource WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  for (const dataSource of dataSources.results || []) {
    const inserted = await db.prepare(
      `INSERT INTO builder_datasource (page_id, type, name, [order], configuration, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      duplicated.id,
      dataSource.type,
      dataSource.name,
      dataSource.order,
      remapBuilderPageJson(dataSource.configuration, { pageId: Number(duplicated.id) }),
      now,
      now
    ).first<any>();
    if (inserted?.id) dataSourceMap.set(Number(dataSource.id), Number(inserted.id));
  }

  const elementMap = new Map<number, number>();
  const pendingParents: Array<{ id: number; parentId: number | null }> = [];
  const elements = await db.prepare("SELECT * FROM builder_element WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  for (const element of elements.results || []) {
    const inserted = await db.prepare(
      `INSERT INTO builder_element
       (page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?) RETURNING id`
    ).bind(
      duplicated.id,
      element.type,
      element.order,
      element.place_in_container ?? null,
      remapBuilderPageJson(element.configuration, { pageId: Number(duplicated.id), dataSources: dataSourceMap }),
      now,
      now
    ).first<any>();
    if (inserted?.id) {
      elementMap.set(Number(element.id), Number(inserted.id));
      pendingParents.push({
        id: Number(inserted.id),
        parentId: element.parent_element_id ? Number(element.parent_element_id) : null,
      });
    }
  }
  for (const pending of pendingParents) {
    if (!pending.parentId) continue;
    const parentId = elementMap.get(pending.parentId);
    if (parentId) {
      await db.prepare("UPDATE builder_element SET parent_element_id=?, updated_on=? WHERE id=?")
        .bind(parentId, now, pending.id)
        .run();
    }
  }

  const workflowActions = await db.prepare("SELECT * FROM builder_workflowaction WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  const workflowActionMap = new Map<number, number>();
  const pendingActionConfigs: Array<{ id: number; configuration: string | null }> = [];
  for (const action of workflowActions.results || []) {
    const inserted = await db.prepare(
      `INSERT INTO builder_workflowaction
       (page_id, element_id, type, event, [order], configuration, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      duplicated.id,
      action.element_id ? elementMap.get(Number(action.element_id)) ?? null : null,
      action.type,
      action.event,
      action.order,
      remapBuilderPageJson(action.configuration, {
        pageId: Number(duplicated.id),
        dataSources: dataSourceMap,
        elements: elementMap,
      }),
      now,
      now
    ).first<{ id: number }>();
    if (inserted?.id) {
      workflowActionMap.set(Number(action.id), Number(inserted.id));
      pendingActionConfigs.push({ id: Number(inserted.id), configuration: action.configuration });
    }
  }

  for (const pending of pendingActionConfigs) {
    await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=?")
      .bind(
        remapBuilderPageJson(pending.configuration, {
          pageId: Number(duplicated.id),
          dataSources: dataSourceMap,
          elements: elementMap,
          workflowActions: workflowActionMap,
        }),
        now,
        pending.id
      )
      .run();
  }

  return {
    original: serializePage(existing),
    duplicate: serializePage(duplicated),
  };
}

function elementPlacementError(field: string, error: string): never {
  builderRequestValidationError([field], error);
}

async function getElementReference(db: D1Database, elementId: unknown) {
  const normalizedId = Number(elementId);
  if (!Number.isInteger(normalizedId)) elementPlacementError("parent_element_id", "A valid integer is required.");
  const element = await db.prepare("SELECT * FROM builder_element WHERE id=?")
    .bind(normalizedId)
    .first<any>();
  if (!element) {
    throw new ApiError(404, "ERROR_ELEMENT_DOES_NOT_EXIST", "The requested element does not exist.");
  }
  return element;
}

async function validateElementPlacement(
  db: D1Database,
  pageId: number,
  type: string,
  parentElementId: unknown,
  placeInContainer: unknown,
) {
  const page = await db.prepare("SELECT id, shared FROM builder_page WHERE id=?")
    .bind(pageId)
    .first<{ id: number; shared: number }>();
  if (!page) throw new DoesNotExist("Builder page", pageId);

  const normalizedParentId = parentElementId === undefined || parentElementId === null
    ? null
    : Number(parentElementId);
  const normalizedPlace = placeInContainer === undefined || placeInContainer === null
    ? null
    : String(placeInContainer);
  const parent = normalizedParentId === null ? null : await getElementReference(db, normalizedParentId);

  // LinkElementType delegates placement to NavigationElementManager, whose
  // validate_place hook is intentionally empty in Supertask.
  if (type === "link") return { parentElementId: normalizedParentId, placeInContainer: normalizedPlace };

  if (!parent) {
    const isMultiPage = MULTI_PAGE_ELEMENT_TYPES.has(type);
    if (isMultiPage !== Boolean(page.shared)) {
      const pageKind = isMultiPage ? "an unshared" : "the shared";
      elementPlacementError("parent_element_id", `This element type can't be added as root of ${pageKind} page.`);
    }
    return { parentElementId: null, placeInContainer: normalizedPlace };
  }

  const parentType = String(parent.type);
  const childAllowed = CONTAINER_ELEMENT_TYPES.has(parentType)
    && !MULTI_PAGE_ELEMENT_TYPES.has(type)
    && !(parentType === "column" && type === "column")
    && !(parentType === "form_container" && type === "form_container");
  if (!childAllowed) {
    elementPlacementError(
      "parent_element_id",
      `Container of type ${parentType} can't have child of type ${type}`,
    );
  }

  if (parentType === "column") {
    const numericPlace = Number(normalizedPlace);
    if (normalizedPlace === null || !Number.isInteger(numericPlace)) {
      elementPlacementError("place_in_container", "A valid integer is required.");
    }
    const columnAmount = Number(serializeElement(parent).column_amount);
    const maxPlace = columnAmount - 1;
    if (numericPlace > maxPlace) {
      elementPlacementError(
        "place_in_container",
        `place_in_container can at most be ${maxPlace}, (${normalizedPlace}, was given)`,
      );
    }
  }

  return { parentElementId: normalizedParentId, placeInContainer: normalizedPlace };
}

async function getBeforeElement(db: D1Database, pageId: number, beforeId: unknown) {
  if (beforeId === undefined || beforeId === null) return null;
  const normalizedId = Number(beforeId);
  if (!Number.isInteger(normalizedId)) builderRequestValidationError(["before_id"], "A valid integer is required.");
  const before = await db.prepare("SELECT * FROM builder_element WHERE id=?").bind(normalizedId).first<any>();
  if (!before) throw new ApiError(404, "ERROR_ELEMENT_DOES_NOT_EXIST", "The requested element does not exist.");
  if (Number(before.page_id) !== pageId) {
    throw new ApiError(400, "ERROR_ELEMENT_NOT_IN_SAME_PAGE", "The element is not in the same page.");
  }
  return before;
}

async function nextElementOrder(
  db: D1Database,
  pageId: number,
  parentElementId: number | null,
  placeInContainer: string | null,
  before: any | null,
  excludeElementId?: number,
) {
  const scope = parentElementId === null
    ? "page_id=? AND parent_element_id IS NULL"
    : "page_id=? AND parent_element_id=? AND place_in_container IS ?";
  const scopeBindings: unknown[] = parentElementId === null
    ? [pageId]
    : [pageId, parentElementId, placeInContainer];
  const exclusion = excludeElementId === undefined ? "" : " AND id<>?";
  if (excludeElementId !== undefined) scopeBindings.push(excludeElementId);

  if (before) {
    const previous = await db.prepare(
      `SELECT MAX(CAST([order] AS REAL)) AS previous_order
       FROM builder_element
       WHERE ${scope}${exclusion} AND CAST([order] AS REAL) < ?`,
    ).bind(...scopeBindings, Number(before.order)).first<{ previous_order: number | null }>();
    const beforeOrder = Number(before.order);
    return String(previous?.previous_order === null || previous?.previous_order === undefined
      ? beforeOrder - 10000
      : (Number(previous.previous_order) + beforeOrder) / 2);
  }

  const last = await db.prepare(
    `SELECT MAX(CAST([order] AS REAL)) AS max_order FROM builder_element WHERE ${scope}${exclusion}`,
  ).bind(...scopeBindings).first<{ max_order: number | null }>();
  return String(Number(last?.max_order || 0) + 10000);
}

function normalizedColumnAmount(value: unknown, path: ValidationPath) {
  const amount = Number(value);
  if (!Number.isInteger(amount)) builderRequestValidationError(path, "A valid integer is required.");
  if (amount < 1) builderRequestValidationError(path, "Value cannot be less than 0.", "min_value");
  if (amount > 6) builderRequestValidationError(path, "Value cannot be greater than 6.", "max_value");
  return amount;
}

export async function createElement(db: D1Database, pageId: number, body: JsonObject) {
  if (!body.type) throw new ValidationError("The element type is required.");
  const type = String(body.type);
  if (!ELEMENT_TYPES.has(type)) throw new ValidationError(`The element type ${type} is not registered.`);
  const { direct, extra } = splitKnownValues(body, ELEMENT_COLUMNS);
  normalizeElementFormulas(type, extra);
  if (type === "column" && Object.prototype.hasOwnProperty.call(extra, "column_amount")) {
    extra.column_amount = normalizedColumnAmount(extra.column_amount, ["column_amount"]);
  }
  if (type === "auth_form" && Object.prototype.hasOwnProperty.call(body, "user_source_id")) {
    await validateAuthFormUserSource(db, pageId, body.user_source_id);
  }
  const placement = await validateElementPlacement(
    db,
    pageId,
    type,
    direct.parent_element_id,
    direct.place_in_container,
  );
  const before = await getBeforeElement(db, pageId, body.before_id);
  const order = await nextElementOrder(
    db,
    pageId,
    placement.parentElementId,
    placement.placeInContainer,
    before,
  );
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO builder_element
     (page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    pageId,
    type,
    order,
    placement.parentElementId,
    placement.placeInContainer,
    JSON.stringify(extra),
    now,
    now
  ).first<any>();
  if (!row) throw new Error("Failed to create builder element");
  return serializeElement(row);
}

export async function updateElement(db: D1Database, elementId: number, body: JsonObject) {
  const existing = await db.prepare("SELECT * FROM builder_element WHERE id=?").bind(elementId).first<any>();
  if (!existing) throw new DoesNotExist("Builder element", elementId);
  if (body.type !== undefined) throw new ValidationError("The element type cannot be changed.");
  const { direct, extra } = splitKnownValues(body, ELEMENT_COLUMNS);
  normalizeElementFormulas(String(existing.type), extra);
  if (existing.type === "column" && Object.prototype.hasOwnProperty.call(extra, "column_amount")) {
    extra.column_amount = normalizedColumnAmount(extra.column_amount, ["column_amount"]);
  }
  if (existing.type === "auth_form" && Object.prototype.hasOwnProperty.call(body, "user_source_id")) {
    await validateAuthFormUserSource(db, Number(existing.page_id), body.user_source_id);
  }
  const configuration = { ...parseJson<JsonObject>(existing.configuration, {}), ...extra };
  const placement = await validateElementPlacement(
    db,
    Number(existing.page_id),
    String(existing.type),
    direct.parent_element_id !== undefined ? direct.parent_element_id : existing.parent_element_id,
    direct.place_in_container !== undefined ? direct.place_in_container : existing.place_in_container,
  );
  const now = nowIso();
  const statements = [db.prepare(
    `UPDATE builder_element SET type=?, parent_element_id=?, place_in_container=?, configuration=?, updated_on=? WHERE id=?`
  ).bind(
    existing.type,
    placement.parentElementId,
    placement.placeInContainer,
    JSON.stringify(configuration),
    now,
    elementId
  )];

  if (existing.type === "column" && Object.prototype.hasOwnProperty.call(extra, "column_amount")) {
    const oldAmount = Number(serializeElement(existing).column_amount);
    const newAmount = Number(extra.column_amount);
    if (newAmount < oldAmount) {
      const newPlace = String(newAmount - 1);
      const affected = await db.prepare(
        `SELECT id FROM builder_element
         WHERE parent_element_id=? AND CAST(place_in_container AS INTEGER)>=?
         ORDER BY CAST(place_in_container AS INTEGER) ASC, CAST([order] AS REAL) ASC, id ASC`,
      ).bind(elementId, newAmount).all<{ id: number }>();
      const targetLast = await db.prepare(
        `SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order
         FROM builder_element WHERE parent_element_id=? AND place_in_container=?`,
      ).bind(elementId, newPlace).first<{ max_order: number }>();
      let childOrder = Number(targetLast?.max_order || 0);
      for (const child of affected.results || []) {
        childOrder += 10000;
        statements.push(db.prepare(
          "UPDATE builder_element SET place_in_container=?, [order]=?, updated_on=? WHERE id=?",
        ).bind(newPlace, String(childOrder), now, child.id));
      }
    }
  }

  await db.batch(statements);
  const updated = await db.prepare("SELECT * FROM builder_element WHERE id=?").bind(elementId).first<any>();
  return serializeElement(updated);
}

export async function moveElement(db: D1Database, elementId: number, body: JsonObject) {
  const existing = await db.prepare("SELECT * FROM builder_element WHERE id=?").bind(elementId).first<any>();
  if (!existing) throw new DoesNotExist("Builder element", elementId);
  const parentElementId = body.parent_element_id === undefined || body.parent_element_id === null
    ? null
    : Number(body.parent_element_id);
  const placeInContainer = body.place_in_container === undefined || body.place_in_container === null
    ? null
    : String(body.place_in_container);
  const parent = parentElementId === null ? null : await getElementReference(db, parentElementId);
  if (parent && placeInContainer !== null) {
    if (!CONTAINER_ELEMENT_TYPES.has(String(parent.type))) {
      elementPlacementError("parent_element_id", `Element of type ${String(parent.type)} is not a container.`);
    }
    if (parent.type === "column") {
      const numericPlace = Number(placeInContainer);
      if (!Number.isInteger(numericPlace)) elementPlacementError("place_in_container", "A valid integer is required.");
      const maxPlace = Number(serializeElement(parent).column_amount) - 1;
      if (numericPlace > maxPlace) {
        elementPlacementError(
          "place_in_container",
          `place_in_container can at most be ${maxPlace}, (${placeInContainer}, was given)`,
        );
      }
    }
  }
  const before = await getBeforeElement(db, Number(existing.page_id), body.before_id);
  const order = await nextElementOrder(
    db,
    Number(existing.page_id),
    parentElementId,
    placeInContainer,
    before,
    elementId,
  );
  await db.prepare(
    `UPDATE builder_element SET [order]=?, parent_element_id=?, place_in_container=?, updated_on=? WHERE id=?`
  ).bind(
    order,
    parentElementId,
    placeInContainer,
    nowIso(),
    elementId
  ).run();
  const updated = await db.prepare("SELECT * FROM builder_element WHERE id=?").bind(elementId).first<any>();
  return serializeElement(updated);
}

export async function duplicateElement(db: D1Database, elementId: number) {
  const root = await db.prepare("SELECT * FROM builder_element WHERE id=?").bind(elementId).first<any>();
  if (!root) throw new DoesNotExist("Builder element", elementId);

  const pageElements = await db.prepare(
    "SELECT * FROM builder_element WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC"
  ).bind(root.page_id).all<any>();
  const byParent = new Map<number, any[]>();
  for (const element of pageElements.results || []) {
    const parentId = Number(element.parent_element_id || 0);
    byParent.set(parentId, [...(byParent.get(parentId) || []), element]);
  }
  const subtree: any[] = [];
  const collect = (element: any) => {
    subtree.push(element);
    for (const child of byParent.get(Number(element.id)) || []) collect(child);
  };
  collect(root);

  const now = nowIso();
  const maxOrder = await db.prepare(
    "SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM builder_element WHERE page_id=?"
  ).bind(root.page_id).first<{ max_order: number }>();
  const elementMap = new Map<number, number>();
  const insertedElementIds: number[] = [];
  const insertedActionIds: number[] = [];
  const actionMap = new Map<number, number>();

  try {
    for (const source of subtree) {
      const isRoot = Number(source.id) === Number(root.id);
      const parentId = isRoot
        ? source.parent_element_id ?? null
        : elementMap.get(Number(source.parent_element_id)) ?? null;
      const inserted = await db.prepare(
        `INSERT INTO builder_element
         (page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        source.page_id,
        source.type,
        isRoot ? String(Number(maxOrder?.max_order || 0) + 10000) : source.order,
        parentId,
        source.place_in_container ?? null,
        source.configuration || "{}",
        now,
        now,
      ).first<{ id: number }>();
      if (!inserted?.id) throw new Error("Failed to duplicate builder element.");
      elementMap.set(Number(source.id), Number(inserted.id));
      insertedElementIds.push(Number(inserted.id));
    }

    for (const source of subtree) {
      const duplicatedId = elementMap.get(Number(source.id));
      if (!duplicatedId) continue;
      await db.prepare("UPDATE builder_element SET configuration=?, updated_on=? WHERE id=?")
        .bind(
          remapBuilderPageJson(source.configuration, {
            pageId: Number(root.page_id),
            elements: elementMap,
          }),
          now,
          duplicatedId,
        )
        .run();
    }

    const sourceIds = subtree.map((element) => Number(element.id));
    const actions = sourceIds.length === 0
      ? { results: [] as any[] }
      : await db.prepare(
        `SELECT * FROM builder_workflowaction
          WHERE element_id IN (${sourceIds.map(() => "?").join(",")})
          ORDER BY CAST([order] AS REAL) ASC, id ASC`
      ).bind(...sourceIds).all<any>();
    for (const action of actions.results || []) {
      const inserted = await db.prepare(
        `INSERT INTO builder_workflowaction
         (page_id, element_id, type, event, [order], configuration, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        action.page_id,
        elementMap.get(Number(action.element_id)) ?? null,
        action.type,
        action.event,
        action.order,
        action.configuration || "{}",
        now,
        now,
      ).first<{ id: number }>();
      if (!inserted?.id) throw new Error("Failed to duplicate builder workflow action.");
      actionMap.set(Number(action.id), Number(inserted.id));
      insertedActionIds.push(Number(inserted.id));
    }
    for (const action of actions.results || []) {
      const duplicatedId = actionMap.get(Number(action.id));
      if (!duplicatedId) continue;
      await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=?")
        .bind(
          remapBuilderPageJson(action.configuration, {
            pageId: Number(root.page_id),
            elements: elementMap,
            workflowActions: actionMap,
          }),
          now,
          duplicatedId,
        )
        .run();
    }

    const duplicatedElements = [];
    for (const id of insertedElementIds) {
      const row = await db.prepare("SELECT * FROM builder_element WHERE id=?").bind(id).first<any>();
      if (row) duplicatedElements.push(serializeElement(row));
    }
    const duplicatedActions = [];
    for (const id of insertedActionIds) {
      const row = await db.prepare("SELECT * FROM builder_workflowaction WHERE id=?").bind(id).first<any>();
      if (row) duplicatedActions.push(await serializeWorkflowAction(db, row));
    }
    return { elements: duplicatedElements, workflow_actions: duplicatedActions };
  } catch (error) {
    for (const id of [...insertedElementIds].reverse()) {
      await db.prepare("DELETE FROM builder_element WHERE id=?").bind(id).run();
    }
    throw error;
  }
}

export async function createDataSource(db: D1Database, pageId: number, body: JsonObject) {
  if (!body.type) throw new ValidationError("The data source type is required.");
  const before = body.before_id
    ? await db.prepare("SELECT [order] FROM builder_datasource WHERE id=? AND page_id=?").bind(Number(body.before_id), pageId).first<any>()
    : null;
  const max = await db.prepare("SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM builder_datasource WHERE page_id=?")
    .bind(pageId)
    .first<{ max_order: number }>();
  const { direct, extra } = splitKnownValues(body, DATA_SOURCE_COLUMNS);
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO builder_datasource (page_id, type, name, [order], configuration, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    Number(direct.page_id || pageId),
    String(body.type),
    String(direct.name || "Data source"),
    orderValue(body.before_id, before?.order, max?.max_order),
    JSON.stringify(extra),
    now,
    now
  ).first<any>();
  if (!row) throw new Error("Failed to create builder data source");
  return serializeDataSource(db, row);
}

export async function updateDataSource(db: D1Database, dataSourceId: number, body: JsonObject) {
  const existing = await db.prepare("SELECT * FROM builder_datasource WHERE id=?").bind(dataSourceId).first<any>();
  if (!existing) throw new DoesNotExist("Builder data source", dataSourceId);
  const { direct, extra } = splitKnownValues(body, DATA_SOURCE_COLUMNS);
  const configuration = { ...parseJson<JsonObject>(existing.configuration, {}), ...extra };
  await db.prepare(
    `UPDATE builder_datasource SET page_id=?, type=?, name=?, configuration=?, updated_on=? WHERE id=?`
  ).bind(
    direct.page_id !== undefined ? direct.page_id : existing.page_id,
    direct.type !== undefined ? String(direct.type) : existing.type,
    direct.name !== undefined ? String(direct.name) : existing.name,
    JSON.stringify(configuration),
    nowIso(),
    dataSourceId
  ).run();
  const updated = await db.prepare("SELECT * FROM builder_datasource WHERE id=?").bind(dataSourceId).first<any>();
  return serializeDataSource(db, updated);
}

export async function moveDataSource(db: D1Database, dataSourceId: number, beforeId: number | null) {
  const existing = await db.prepare("SELECT * FROM builder_datasource WHERE id=?").bind(dataSourceId).first<any>();
  if (!existing) throw new DoesNotExist("Builder data source", dataSourceId);
  const before = beforeId
    ? await db.prepare("SELECT [order] FROM builder_datasource WHERE id=? AND page_id=?").bind(beforeId, existing.page_id).first<any>()
    : null;
  const max = await db.prepare("SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM builder_datasource WHERE page_id=?")
    .bind(existing.page_id)
    .first<{ max_order: number }>();
  await db.prepare("UPDATE builder_datasource SET [order]=?, updated_on=? WHERE id=?")
    .bind(orderValue(beforeId, before?.order, max?.max_order), nowIso(), dataSourceId)
    .run();
}

export async function createWorkflowAction(db: D1Database, pageId: number, body: JsonObject) {
  if (!body.type || !body.event) throw new ValidationError("The workflow action type and event are required.");
  if (body.type === "slack_write_message") throw new ValidationError("The Slack workflow action is not available.");
  const max = await db.prepare(
    "SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM builder_workflowaction WHERE page_id=? AND COALESCE(element_id, 0)=COALESCE(?, 0)"
  ).bind(pageId, body.element_id ?? null).first<{ max_order: number }>();
  const { direct, extra } = splitKnownValues(body, WORKFLOW_COLUMNS);
  const actionType = String(body.type);
  const configuration = workflowActionConfiguration(actionType, {}, extra, true);
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO builder_workflowaction
     (page_id, element_id, type, event, [order], configuration, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    pageId,
    direct.element_id === undefined ? null : direct.element_id,
    actionType,
    String(body.event),
    String((max?.max_order || 0) + 10000),
    JSON.stringify(configuration),
    now,
    now
  ).first<any>();
  if (!row) throw new Error("Failed to create builder workflow action");
  return serializeWorkflowAction(db, row);
}

export async function updateWorkflowAction(db: D1Database, workflowActionId: number, body: JsonObject) {
  const existing = await db.prepare("SELECT * FROM builder_workflowaction WHERE id=?").bind(workflowActionId).first<any>();
  if (!existing) throw new DoesNotExist("Builder workflow action", workflowActionId);
  const { direct, extra } = splitKnownValues(body, WORKFLOW_COLUMNS);
  const nextType = direct.type !== undefined ? String(direct.type) : existing.type;
  if (nextType === "slack_write_message") throw new ValidationError("The Slack workflow action is not available.");
  const typeChanged = direct.type !== undefined && nextType !== existing.type;
  const configuration = workflowActionConfiguration(
    nextType,
    parseJson<JsonObject>(existing.configuration, {}),
    extra,
    typeChanged
  );
  await db.prepare(
    `UPDATE builder_workflowaction SET element_id=?, type=?, event=?, configuration=?, updated_on=? WHERE id=?`
  ).bind(
    direct.element_id !== undefined ? direct.element_id : existing.element_id,
    nextType,
    direct.event !== undefined ? String(direct.event) : existing.event,
    JSON.stringify(configuration),
    nowIso(),
    workflowActionId
  ).run();
  const updated = await db.prepare("SELECT * FROM builder_workflowaction WHERE id=?").bind(workflowActionId).first<any>();
  return serializeWorkflowAction(db, updated);
}

export async function createDomain(db: D1Database, builderId: number, body: JsonObject) {
  const { direct, extra } = splitKnownValues(body, DOMAIN_COLUMNS);
  const domainName = String(direct.domain_name || direct.type || "").trim();
  if (!domainName) throw new ValidationError("The domain_name field is required.");
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO builder_domain (builder_id, type, domain_name, published, settings, created_on, updated_on)
     VALUES (?, ?, ?, 0, ?, ?, ?) RETURNING *`
  ).bind(
    builderId,
    String(direct.type || "custom"),
    domainName,
    JSON.stringify(extra),
    now,
    now
  ).first<any>();
  if (!row) throw new Error("Failed to create builder domain");
  return serializeDomain(row);
}

export async function updateTheme(db: D1Database, builderId: number, values: JsonObject) {
  await ensureBuilderDefaults(db, builderId);
  const existing = await db.prepare("SELECT theme FROM builder_theme WHERE builder_id=?").bind(builderId).first<{ theme: string }>();
  const theme = { ...parseJson<JsonObject>(existing?.theme, {}), ...values };
  await db.prepare("UPDATE builder_theme SET theme=?, updated_on=? WHERE builder_id=?")
    .bind(JSON.stringify(theme), nowIso(), builderId)
    .run();
  return theme;
}

export async function schemaForTable(db: D1Database, tableId: number, sourceType?: string): Promise<JsonObject> {
  const fields = await getActiveFields(db, tableId);
  const properties: JsonObject = {
    id: { type: "number", title: "id", metadata: { primary: false, read_only: true } },
  };
  for (const field of fields) {
    properties[`field_${field.id}`] = {
      type: schemaType(field.type),
      title: field.name,
      original_type: field.type,
      metadata: {
        id: field.id,
        name: field.name,
        type: field.type,
        primary: Boolean(field.primary),
        read_only: isReadOnlyField(field.type),
      },
    };
  }
  if (sourceType === "local_supertask_list_rows") {
    return { type: "array", items: { type: "object", properties } };
  }
  if (sourceType === "local_supertask_aggregate_rows") {
    return { type: "object", properties: { result: { type: "number", title: "Result" } } };
  }
  return { type: "object", properties };
}

export async function schemaForDataSource(db: D1Database, tableId: number, sourceType: string, config: JsonObject): Promise<JsonObject | null> {
  if (sourceType === "local_supertask_aggregate_rows") {
    const fieldId = Number(config.field_id);
    if (!fieldId || !config.aggregation_type) return null;
    const field = await fieldForContextData(db, fieldId);
    if (!field) return null;
    return {
      title: `Table${tableId}Schema`,
      type: "object",
      properties: {
        result: {
          title: `${field.name} result`,
          type: "number",
        },
      },
    };
  }
  return schemaForTable(db, tableId, sourceType);
}

export async function contextDataForDataSource(db: D1Database, tableId: number, sourceType: string, config: JsonObject): Promise<JsonObject> {
  if (sourceType === "local_supertask_aggregate_rows") {
    const field = await fieldForContextData(db, Number(config.field_id));
    return field ? { field: await serializeDatabaseFieldRow(db, field as any) } : {};
  }
  const fields = await getActiveFields(db, tableId);
  const entries = await Promise.all(fields
    .filter((field) => field.type === "single_select" || field.type === "multiple_select")
    .map(async (field) => [`field_${field.id}`, await getSelectOptions(db, field.id)] as const));
  return Object.fromEntries(entries);
}

export async function contextDataSchemaForDataSource(db: D1Database, tableId: number, sourceType: string): Promise<JsonObject | null> {
  if (sourceType === "local_supertask_aggregate_rows") return null;
  const fields = await getActiveFields(db, tableId);
  const properties = Object.fromEntries(fields
    .filter((field) => field.type === "single_select" || field.type === "multiple_select")
    .map((field) => [`field_${field.id}`, {
      type: "array",
      title: field.name,
      default: null,
      items: {
        type: "object",
        properties: {
          value: { type: "string" },
          id: { type: "number" },
          color: { type: "string" },
        },
      },
    }]));
  if (Object.keys(properties).length === 0) return null;
  return { type: "object", title: `Table${tableId}Schema`, properties };
}

export async function serializeWorkflowActionService(db: D1Database, row: any, serviceConfig: JsonObject): Promise<JsonObject> {
  const serviceType = workflowActionServiceType(row.type, serviceConfig);
  const service: JsonObject = {
    ...serviceConfig,
    id: serviceConfig.id ?? row.id,
    type: serviceType,
    integration_id: serviceConfig.integration_id ?? null,
    sample_data: serviceConfig.sample_data ?? null,
  };
  if (Array.isArray(service.field_mappings)) {
    service.field_mappings = service.field_mappings.map((mapping) => {
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return mapping;
      return {
        enabled: true,
        ...mapping as JsonObject,
      };
    });
  }
  const coreSchema = workflowActionCoreServiceSchema(serviceType, Number(service.id), service);
  if (coreSchema) {
    service.schema = coreSchema;
    service.context_data = null;
    service.context_data_schema = null;
    return service;
  }
  const tableId = Number(serviceConfig.table_id);
  if (!Number.isFinite(tableId) || tableId <= 0) {
    service.schema = null;
    service.context_data = null;
    service.context_data_schema = null;
    return service;
  }
  service.schema = await schemaForDataSource(db, tableId, serviceType, serviceConfig);
  service.context_data = await contextDataForDataSource(db, tableId, serviceType, serviceConfig);
  service.context_data_schema = await contextDataSchemaForDataSource(db, tableId, serviceType);
  return service;
}

function workflowActionConfiguration(actionType: string, existingConfig: JsonObject, extra: JsonObject, reset = false): JsonObject {
  const defaults = defaultWorkflowActionConfiguration(actionType);
  const base = reset ? {} : existingConfig;
  const configuration: JsonObject = {
    ...defaults,
    ...base,
    ...extra,
  };
  const defaultService = objectValue(defaults.service);
  const existingService = objectValue(base.service);
  const extraService = objectValue(extra.service);
  if (defaultService || existingService || extraService) {
    configuration.service = {
      ...(defaultService || {}),
      ...(reset ? {} : existingService || {}),
      ...(extraService || {}),
    };
  }
  return configuration;
}

function defaultWorkflowActionConfiguration(actionType: string): JsonObject {
  const serviceType = workflowActionServiceType(actionType, {});
  if (serviceType === "local_supertask_upsert_row") {
    return {
      service: {
        type: serviceType,
        integration_id: null,
        table_id: null,
        row_id: formulaObject(),
        field_mappings: [],
      },
    };
  }
  if (serviceType === "local_supertask_delete_row") {
    return {
      service: {
        type: serviceType,
        integration_id: null,
        table_id: null,
        row_id: formulaObject(),
      },
    };
  }
  if (serviceType === "http_request") {
    return {
      service: {
        type: serviceType,
        http_method: "GET",
        url: formulaObject(),
        headers: [],
        query_params: [],
        form_data: [],
        body_type: "none",
        body_content: formulaObject(),
        timeout: 30,
      },
    };
  }
  if (serviceType === "smtp_email") {
    return {
      service: {
        type: serviceType,
        integration_id: null,
        from_email: formulaObject(),
        from_name: formulaObject(),
        to_emails: formulaObject(),
        cc_emails: formulaObject(),
        bcc_emails: formulaObject(),
        subject: formulaObject(),
        body_type: "plain",
        body: formulaObject(),
      },
    };
  }
  if (serviceType === "ai_agent") {
    return {
      service: {
        type: serviceType,
        integration_id: null,
        ai_generative_ai_type: null,
        ai_generative_ai_model: null,
        ai_output_type: "text",
        ai_temperature: null,
        ai_prompt: formulaObject(),
        ai_choices: [],
      },
    };
  }
  return {};
}

function formulaObject(formula = ""): JsonObject {
  return { formula, mode: "simple", version: "0.1" };
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function workflowActionCoreServiceSchema(serviceType: string, serviceId: number, service: JsonObject): JsonObject | null {
  if (serviceType === "http_request") return httpRequestServiceSchema(serviceId, service);
  if (serviceType === "smtp_email") return {
    title: `SMTPEmail${serviceId}Schema`,
    type: "object",
    properties: {
      success: {
        type: "boolean",
        title: "Success",
        description: "Whether the email was sent successfully",
      },
    },
  };
  if (serviceType === "ai_agent") return {
    type: "object",
    title: `AIAgent${serviceId}Schema`,
    properties: {
      result: {
        type: "string",
        title: "AI Response",
      },
    },
  };
  return null;
}

function httpRequestServiceSchema(serviceId: number, service: JsonObject): JsonObject {
  const sampleData = service.sample_data && typeof service.sample_data === "object" && !Array.isArray(service.sample_data)
    ? service.sample_data as JsonObject
    : null;
  const samplePayload = sampleData?.data && typeof sampleData.data === "object" && !Array.isArray(sampleData.data)
    ? sampleData.data as JsonObject
    : {};
  const properties: JsonObject = {};
  if (sampleData) {
    properties.body = {
      ...jsonSchemaForSample(samplePayload.body ?? {}),
      title: "Body",
    };
  }
  properties.raw_body = {
    type: "string",
    title: "Raw body",
  };
  const defaultHeadersSchema: JsonObject = {
    type: "object",
    properties: {
      "Content-Type": {
        type: "string",
        description: "The MIME type of the response body",
      },
      "Content-Length": {
        type: "number",
        description: "The length of the response body in octets (8-bit bytes)",
      },
      ETag: {
        type: "string",
        description: "An identifier for a specific version of a resource",
      },
    },
    title: "Headers",
  };
  properties.headers = sampleData
    ? { ...defaultHeadersSchema, ...jsonSchemaForSample(samplePayload.headers ?? {}) }
    : defaultHeadersSchema;
  properties.status_code = {
    type: "number",
    title: "Status code",
  };
  return {
    title: `HTTPRequest${serviceId}Schema`,
    type: "object",
    properties,
  };
}

function jsonSchemaForSample(value: unknown): JsonObject {
  return {
    "$schema": "http://json-schema.org/schema#",
    ...jsonSchemaForValue(value, true),
  };
}

function jsonSchemaForValue(value: unknown, topLevelObject = false): JsonObject {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const schema: JsonObject = { type: "array" };
    if (value.length > 0) schema.items = mergeJsonSchemas(value.map((item) => jsonSchemaForValue(item)));
    return schema;
  }
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonObject);
    const schema: JsonObject = { type: "object" };
    if (entries.length > 0) {
      schema.properties = Object.fromEntries(entries.map(([key, item]) => [key, jsonSchemaForValue(item)]));
      schema.required = entries.map(([key]) => key);
    }
    return topLevelObject ? schema : schema;
  }
  return {};
}

function mergeJsonSchemas(schemas: JsonObject[]): JsonObject {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0];
  const types = uniqueSchemaTypes(schemas.flatMap((schema) => Array.isArray(schema.type) ? schema.type : [schema.type]).filter(Boolean));
  if (types.length !== 1) return { type: types.length === 1 ? types[0] : types };
  const type = types[0];
  if (type !== "object") return { type };
  const allPropertyNames = new Set<string>();
  for (const schema of schemas) {
    for (const key of Object.keys((schema.properties as JsonObject | undefined) || {})) {
      allPropertyNames.add(key);
    }
  }
  const properties: JsonObject = {};
  for (const key of allPropertyNames) {
    const propertySchemas = schemas
      .map((schema) => (schema.properties as JsonObject | undefined)?.[key])
      .filter((schema): schema is JsonObject => Boolean(schema));
    properties[key] = mergeJsonSchemas(propertySchemas);
  }
  const required = schemas
    .map((schema) => new Set(Array.isArray(schema.required) ? schema.required.map(String) : []))
    .reduce<string[] | null>((intersection, requiredSet) => {
      if (intersection === null) return Array.from(requiredSet);
      return intersection.filter((key) => requiredSet.has(key));
    }, null) || [];
  return {
    type: "object",
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(required.length > 0 ? { required } : {}),
  };
}

function uniqueSchemaTypes(types: unknown[]): string[] {
  return types.reduce<string[]>((acc, item) => {
    const value = String(item);
    if (!acc.includes(value)) acc.push(value);
    return acc;
  }, []);
}

function workflowActionServiceType(actionType: string, serviceConfig: JsonObject): string {
  if (typeof serviceConfig.type === "string" && serviceConfig.type) return serviceConfig.type;
  if (actionType === "create_row" || actionType === "update_row") return "local_supertask_upsert_row";
  if (actionType === "delete_row") return "local_supertask_delete_row";
  if (actionType === "local_supertask_create_row" || actionType === "local_supertask_update_row") return "local_supertask_upsert_row";
  if (actionType === "local_supertask_delete_row") return "local_supertask_delete_row";
  return actionType;
}

async function fieldForContextData(db: D1Database, fieldId: number) {
  if (!Number.isFinite(fieldId) || fieldId <= 0) return null;
  return db.prepare(
    `SELECT id, table_id, name, type, [order], "primary" AS is_primary, read_only,
            description, db_index, immutable_type, immutable_properties, field_settings
     FROM database_field
     WHERE id=? AND trashed=0`
  ).bind(fieldId).first<any>();
}

export async function dispatchDataSource(db: D1Database, row: any, query: DispatchQuery = {}, metadata: JsonObject = {}) {
  const config = parseJson<JsonObject>(row.configuration, {});
  const tableId = Number(config.table_id);
  if (!tableId) throw new ValidationError("The data source is missing a table_id.");
  const refinements = await localSupertaskRefinements(db, tableId, config, query, metadata);

  if (row.type === "local_supertask_get_row") {
    const rowId = resolveFormulaNumber(config.row_id, metadata) || Number(queryValue(query, "row_id"));
    return getUserTableRow(db, tableId, rowId || null, refinements);
  }

  if (row.type === "local_supertask_aggregate_rows") {
    return aggregateUserTableRows(db, tableId, Number(config.field_id), String(config.aggregation_type || "count"), refinements);
  }

  if (row.type === "local_supertask_grouped_aggregate_rows") {
    return groupedAggregateUserTableRows(db, tableId, config, refinements);
  }

  return listUserTableRows(db, tableId, dispatchLimit(config, query), refinements, dispatchOffset(query));
}

export async function dispatchWorkflowAction(
  env: Env,
  row: any,
  metadata: JsonObject = {},
  actorUserId: number | null = null
) {
  const db = env.DB;
  const config = parseJson<JsonObject>(row.configuration, {});
  const service = parseJson<JsonObject>(JSON.stringify(config.service || {}), {});

  if (TRIGGER_TYPES.has(row.type)) {
    return dispatchTriggerPayload(row, service, metadata);
  }
  if (row.type === "logout") {
    return { logged_out: true };
  }
  if (row.type === "notification") {
    return { title: config.title || "", description: config.description || "" };
  }
  if (row.type === "open_page") {
    return {
      navigation_type: config.navigation_type || "page",
      navigate_to_page_id: config.navigate_to_page_id || null,
      navigate_to_url: config.navigate_to_url || null,
      target: config.target || "self",
    };
  }
  if (row.type === "refresh_data_source") {
    return { data_source_id: config.data_source_id || null, refreshed: true };
  }
  if (row.type === "http_request") return dispatchHttpRequest(service, metadata);
  if (row.type === "smtp_email") return dispatchSmtpEmail(env, db, service, metadata);
  if (row.type === "ai_agent") return dispatchAiAgent(env, db, service, metadata);
  if (row.type === "router") return dispatchRouter(service, metadata);
  if (row.type === "iterator") return dispatchIterator(service, metadata);

  const tableId = Number(service.table_id);
  if (!tableId) throw new ValidationError("The workflow action is missing a table_id.");

  if (row.type === "local_supertask_get_row") {
    const rowId = resolveFormulaNumber(service.row_id, metadata);
    return getUserTableRow(db, tableId, rowId, await localSupertaskRefinements(db, tableId, service, {}, metadata));
  }
  if (row.type === "local_supertask_list_rows") {
    return listUserTableRows(db, tableId, Math.min(Number(service.default_result_count || 100), 1000), await localSupertaskRefinements(db, tableId, service, {}, metadata));
  }
  if (row.type === "local_supertask_aggregate_rows") {
    return aggregateUserTableRows(db, tableId, Number(service.field_id), String(service.aggregation_type || "count"), await localSupertaskRefinements(db, tableId, service, {}, metadata));
  }
  if (row.type === "local_supertask_grouped_aggregate_rows") {
    return groupedAggregateUserTableRows(db, tableId, service, await localSupertaskRefinements(db, tableId, service, {}, metadata));
  }
  if (row.type === "create_row" || row.type === "local_supertask_create_row") {
    return upsertUserTableRow(env, tableId, service, undefined, metadata, actorUserId);
  }
  if (row.type === "update_row" || row.type === "local_supertask_update_row") {
    const rowId = resolveFormulaNumber(service.row_id, metadata);
    if (!rowId) throw new ValidationError("The workflow action is missing a row_id.");
    return upsertUserTableRow(env, tableId, service, rowId, metadata, actorUserId);
  }
  if (row.type === "delete_row" || row.type === "local_supertask_delete_row") {
    const rowId = resolveFormulaNumber(service.row_id, metadata);
    if (!rowId) throw new ValidationError("The workflow action is missing a row_id.");
    await ensureUserTableSystemColumns(db, tableId);
    const fields = await getActiveFields(db, tableId);
    const before = await db.prepare(`SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`)
      .bind(rowId)
      .first<Record<string, unknown>>();
    if (!before) return { deleted: rowId };
    const now = nowIso();
    const sets = ["trashed=1", "_updated_on=?", "_last_modified_by_id=?"];
    const values: unknown[] = [now, actorUserId];
    const modifiedValues = await modifiedFieldValues(db, fields, now, actorUserId);
    for (const [fieldId, value] of modifiedValues) {
      sets.push(`"field_${fieldId}"=?`);
      values.push(value);
    }
    values.push(rowId);
    await db.prepare(`UPDATE "database_table_${tableId}" SET ${sets.join(", ")} WHERE id=? AND COALESCE(trashed, 0)=0`)
      .bind(...values)
      .run();
    await synchronizeLinkRowRelations(db, tableId, rowId, before, null, null);
    return { deleted: rowId };
  }
  throw new ValidationError(`Unsupported workflow action type: ${row.type}`);
}

export async function dispatchWorkflowTrigger(env: Env, trigger: any, metadata: JsonObject = {}) {
  const triggerResult = await dispatchWorkflowAction(env, trigger, metadata);
  const actions = await workflowActionsForTrigger(env.DB, trigger);
  const results: JsonObject = {};
  for (const action of actions) {
    results[String(action.id)] = await dispatchWorkflowAction(env, action, {
      ...metadata,
      trigger: triggerResult,
      previousActionResults: results,
    });
  }
  return {
    trigger: await serializeWorkflowAction(env.DB, trigger),
    data: triggerResult,
    results,
  };
}

export async function dispatchHttpWorkflowTrigger(env: Env, uid: string, requestData: JsonObject, simulate = false) {
  const trigger = await httpWorkflowTriggerByUid(env.DB, uid, simulate);
  const config = parseJson<JsonObject>(trigger.configuration, {});
  const service = parseJson<JsonObject>(JSON.stringify(config.service || config), {});
  if (requestData.method === "GET" && service.exclude_get === true) {
    throw new ValidationError("GET requests are disabled for this HTTP trigger.");
  }
  return dispatchWorkflowTrigger(env, trigger, requestData);
}

export async function triggerBuilderTableWorkflows(env: Env, tableId: number, eventType: string, payload: JsonObject = {}) {
  const triggerType =
    eventType === "rows.created" ? "local_supertask_rows_created"
      : eventType === "rows.updated" ? "local_supertask_rows_updated"
        : eventType === "rows.deleted" ? "local_supertask_rows_deleted"
          : "";
  if (!triggerType) return [];

  const result = await env.DB.prepare(
    `SELECT wa.*, p.builder_id, a.workspace_id
     FROM builder_workflowaction wa
     JOIN builder_page p ON p.id = wa.page_id
     JOIN core_application a ON a.id = p.builder_id
     WHERE wa.type = ? AND a.type = 'builder' AND a.trashed = 0
     ORDER BY wa.id ASC`
  ).bind(triggerType).all<any>();

  const matching = (result.results || []).filter((trigger) => {
    const config = parseJson<JsonObject>(trigger.configuration, {});
    const service = parseJson<JsonObject>(JSON.stringify(config.service || config), {});
    return Number(service.table_id) === tableId;
  });

  const outputs = [];
  for (const trigger of matching) {
    outputs.push(await dispatchWorkflowTrigger(env, trigger, {
      ...payload,
      table_id: tableId,
      event_type: eventType,
    }));
  }
  return outputs;
}

export async function triggerDuePeriodicBuilderWorkflows(env: Env, now = new Date()) {
  const result = await env.DB.prepare(
    `SELECT wa.*, p.builder_id, a.workspace_id
     FROM builder_workflowaction wa
     JOIN builder_page p ON p.id = wa.page_id
     JOIN core_application a ON a.id = p.builder_id
     WHERE wa.type = 'periodic' AND a.type = 'builder' AND a.trashed = 0
     ORDER BY wa.id ASC`
  ).all<any>();

  const outputs = [];
  for (const trigger of result.results || []) {
    if (!isPeriodicTriggerDue(trigger, now)) continue;
    // Mark the run first: a failing action must not be retried on every
    // cron tick nor stop the other workflows.
    await markPeriodicTriggerRun(env.DB, trigger, now);
    try {
      outputs.push(await dispatchWorkflowTrigger(env, trigger, {
        triggered_at: now.toISOString(),
      }));
    } catch (error) {
      console.error(`[CRON] Builder periodic workflow ${trigger.id} failed`, error);
    }
  }
  return outputs;
}

export async function recordNames(db: D1Database, dataSource: any, recordIds: number[]) {
  const config = parseJson<JsonObject>(dataSource.configuration, {});
  const tableId = Number(config.table_id);
  if (!tableId || recordIds.length === 0) return {};
  const fields = await getActiveFields(db, tableId);
  const primary = fields.find((field) => field.primary) || fields[0];
  if (!primary) return Object.fromEntries(recordIds.map((id) => [String(id), String(id)]));
  const bindMarks = recordIds.map(() => "?").join(", ");
  await ensureUserTableSystemColumns(db, tableId);
  const rows = await db.prepare(`SELECT id, "field_${primary.id}" AS name FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 AND id IN (${bindMarks})`)
    .bind(...recordIds)
    .all<any>();
  return Object.fromEntries((rows.results || []).map((row: any) => [String(row.id), String(row.name ?? row.id)]));
}

async function getActiveFields(db: D1Database, tableId: number): Promise<FieldMeta[]> {
  const result = await db.prepare(
    `SELECT id, name, type, "primary" AS is_primary, read_only, field_settings
     FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY [order] ASC`
  ).bind(tableId).all<any>();
  return (result.results || []).map((field: any) => ({
    id: field.id,
    name: field.name,
    type: field.type,
    primary: Boolean(field.is_primary),
    readOnly: Boolean(field.read_only),
    settings: parseJson<Record<string, unknown>>(field.field_settings, {}),
  }));
}

type LocalSupertaskRefinements = {
  search?: string;
  filters?: FilterSpec[];
  filterType?: "AND" | "OR";
  viewFilters?: FilterSpec[];
  viewFilterType?: "AND" | "OR";
  sortings?: Array<{ field_id: number; order_by: string }>;
};

async function localSupertaskRefinements(
  db: D1Database,
  tableId: number,
  service: JsonObject,
  query: DispatchQuery = {},
  context?: BuilderFormulaContext
): Promise<LocalSupertaskRefinements> {
  const querySortings = normalizeQuerySortings(queryValue(query, "order_by"));
  const viewId = Number(service.view_id || 0);
  let viewFilters: FilterSpec[] = [];
  let viewFilterType: "AND" | "OR" = "AND";
  let viewSortings: Array<{ field_id: number; order_by: string }> = [];
  if (viewId) {
    const view = await db.prepare(
      "SELECT id, table_id, filter_type, filters_disabled FROM database_view WHERE id=? AND trashed=0"
    ).bind(viewId).first<any>();
    if (!view || Number(view.table_id) !== tableId) {
      throw new ValidationError(`The view with ID ${viewId} is not related to the given table ${tableId}.`);
    }
    if (!view.filters_disabled) {
      const filters = await db.prepare(
        `SELECT field_id, type, value
         FROM database_viewfilter WHERE view_id=? AND group_id IS NULL ORDER BY id`
      ).bind(viewId).all<any>();
      viewFilters = (filters.results || []).map((filter: any) => ({
        field_id: Number(filter.field_id),
        type: String(filter.type),
        value: String(filter.value ?? ""),
      }));
      viewFilterType = String(view.filter_type || "AND").toUpperCase() === "OR" ? "OR" : "AND";
    }
    const sorts = await db.prepare(
      "SELECT field_id, [order] AS order_by FROM database_viewsort WHERE view_id=? ORDER BY id"
    ).bind(viewId).all<any>();
    viewSortings = (sorts.results || []).map((sorting: any) => ({
      field_id: Number(sorting.field_id),
      order_by: String(sorting.order_by || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC",
    }));
  }
  return {
    search: String(resolveFormulaValue(service.search_query, context) || queryValue(query, "search_query") || queryValue(query, "search") || "").trim(),
    filters: [
      ...normalizeLocalSupertaskFilters(service.filters, context),
      ...normalizeQueryFilters(query),
    ],
    filterType: String(queryValue(query, "filter_type") || service.filter_type || "AND").toUpperCase() === "OR" ? "OR" : "AND",
    viewFilters,
    viewFilterType,
    sortings: querySortings.length > 0
      ? querySortings
      : normalizeLocalSupertaskSortings(service.sortings).length > 0
        ? normalizeLocalSupertaskSortings(service.sortings)
        : viewSortings,
  };
}

function queryValue(query: DispatchQuery, key: string): string | undefined {
  if (query instanceof URLSearchParams) return query.get(key) ?? undefined;
  return query[key];
}

function queryEntries(query: DispatchQuery): Array<[string, string]> {
  if (query instanceof URLSearchParams) return Array.from(query.entries());
  return Object.entries(query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined);
}

function dispatchLimit(service: JsonObject, query: DispatchQuery) {
  const raw = queryValue(query, "count") || queryValue(query, "size") || service.default_result_count || 100;
  const limit = Number(raw);
  return Number.isFinite(limit) ? Math.min(Math.max(limit, 0), 1000) : 100;
}

function dispatchOffset(query: DispatchQuery) {
  const offset = Number(queryValue(query, "offset") || 0);
  return Number.isFinite(offset) ? Math.max(offset, 0) : 0;
}

function normalizeLocalSupertaskFilters(value: unknown, context?: BuilderFormulaContext): FilterSpec[] {
  if (!Array.isArray(value)) return [];
  return value.map((filter) => {
    const item = filter && typeof filter === "object" ? filter as JsonObject : {};
    const fieldId = Number(item.field_id ?? item.field);
    return {
      field_id: fieldId,
      type: String(item.type || "equal"),
      value: String(resolveFormulaValue(item.value, context) ?? ""),
    };
  }).filter((filter) => Number.isFinite(filter.field_id) && filter.field_id > 0);
}

function normalizeLocalSupertaskSortings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((sorting) => {
    const item = sorting && typeof sorting === "object" ? sorting as JsonObject : {};
    return {
      field_id: Number(item.field_id ?? item.field),
      order_by: String(item.order_by || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC",
    };
  }).filter((sorting) => Number.isFinite(sorting.field_id) && sorting.field_id > 0);
}

function normalizeQuerySortings(value: string | undefined) {
  if (value === undefined) return [];
  return value.split(",").map((part) => {
    const raw = part.trim();
    const desc = raw.startsWith("-");
    const fieldKey = desc ? raw.slice(1) : raw;
    const match = fieldKey.match(/^field_(\d+)$/) || fieldKey.match(/^(\d+)$/);
    return {
      field_id: match ? Number(match[1]) : 0,
      order_by: desc ? "DESC" : "ASC",
    };
  }).filter((sorting) => Number.isFinite(sorting.field_id) && sorting.field_id > 0);
}

function normalizeQueryFilters(query: DispatchQuery): FilterSpec[] {
  return queryEntries(query).flatMap(([key, value]) => {
    const match = key.match(/^filter__field_(\d+)__(\w+)$/);
    if (!match) return [];
    return [{
      field_id: Number(match[1]),
      type: match[2],
      value,
    }];
  });
}

async function buildLocalSupertaskRowQuery(db: D1Database, tableId: number, refinements: LocalSupertaskRefinements = {}) {
  const fields = await getActiveFields(db, tableId);
  const tableName = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(db, tableId);
  let where = `COALESCE("${tableName}".trashed, 0)=0`;
  const params: unknown[] = [];

  if (refinements.search && fields.length > 0) {
    const searchable = fields.filter((field) => ["text", "long_text", "url", "email", "phone_number"].includes(field.type));
    if (searchable.length > 0) {
      where += ` AND (${searchable.map((field) => `"${tableName}"."field_${field.id}" LIKE ?`).join(" OR ")})`;
      params.push(...searchable.map(() => `%${refinements.search}%`));
    }
  }

  if (refinements.filters?.length) {
    const { clause, values } = applyFilters(tableName, refinements.filters, fields, refinements.filterType || "AND");
    if (clause) {
      where += ` AND ${clause}`;
      params.push(...values);
    }
  }

  if (refinements.viewFilters?.length) {
    const { clause, values } = applyFilters(tableName, refinements.viewFilters, fields, refinements.viewFilterType || "AND");
    if (clause) {
      where += ` AND ${clause}`;
      params.push(...values);
    }
  }

  const sortings = (refinements.sortings || []).filter((sorting) => fields.some((field) => field.id === sorting.field_id));
  const orderClause = sortings.length > 0
    ? [
      ...sortings.map((sorting) => `"${tableName}"."field_${sorting.field_id}" ${sorting.order_by}`),
      `"${tableName}".id ASC`,
    ].join(", ")
    : `"${tableName}".[order] ASC, "${tableName}".id ASC`;

  return { fields, tableName, where, params, orderClause };
}

async function listUserTableRows(db: D1Database, tableId: number, limit: number, refinements: LocalSupertaskRefinements = {}, offset = 0) {
  const query = await buildLocalSupertaskRowQuery(db, tableId, refinements);
  const pageSize = Math.max(0, Math.min(limit, 1000));
  const rows = await db.prepare(`SELECT * FROM "${query.tableName}" WHERE ${query.where} ORDER BY ${query.orderClause} LIMIT ? OFFSET ?`)
    .bind(...query.params, pageSize + 1, offset)
    .all<Record<string, unknown>>();
  const results = rows.results || [];
  return {
    results: results.slice(0, pageSize).map((row) => serializeRow(row, query.fields)),
    has_next_page: results.length > pageSize,
  };
}

async function getUserTableRow(db: D1Database, tableId: number, rowId?: number | null, refinements: LocalSupertaskRefinements = {}) {
  const query = await buildLocalSupertaskRowQuery(db, tableId, refinements);
  const rowWhere = rowId ? `${query.where} AND "${query.tableName}".id=?` : query.where;
  const rowParams = rowId ? [...query.params, rowId] : query.params;
  const row = await db.prepare(`SELECT * FROM "${query.tableName}" WHERE ${rowWhere} ORDER BY ${query.orderClause} LIMIT 1`)
    .bind(...rowParams)
    .first<Record<string, unknown>>();
  if (!row) throw new ValidationError(rowId ? `Row ${rowId} does not exist.` : "No rows found.");
  return serializeRow(row, query.fields);
}

type LocalSupertaskRowQuery = Awaited<ReturnType<typeof buildLocalSupertaskRowQuery>>;

type GroupedAggregationSeries = {
  id: number;
  field_id: number;
  aggregation_type: string;
};

type GroupedAggregationSort = {
  sort_on: string;
  reference: string;
  direction: string;
};

const AGGREGATION_TYPES = new Set([
  "count",
  "empty_count",
  "not_empty_count",
  "checked_count",
  "not_checked_count",
  "empty_percentage",
  "not_empty_percentage",
  "checked_percentage",
  "not_checked_percentage",
  "unique_count",
  "min",
  "max",
  "min_date",
  "max_date",
  "sum",
  "average",
  "std_dev",
  "variance",
  "median",
]);

function emptyValueSql(field: FieldMeta, column: string) {
  if (field.type === "boolean") return `COALESCE(${column}, 0)=0`;
  if (["link_row", "file", "multiple_select", "multiple_collaborators", "lookup"].includes(field.type)) {
    return `(${column} IS NULL OR ${column}='' OR ${column}='[]' OR ${column}='{}')`;
  }
  return `(${column} IS NULL OR ${column}='')`;
}

function aggregationSql(field: FieldMeta, aggregationType: string, tableAlias = "filtered") {
  if (!AGGREGATION_TYPES.has(aggregationType)) {
    throw new ValidationError(`The aggregation type '${aggregationType}' does not exist.`);
  }
  const column = `"${tableAlias}"."field_${field.id}"`;
  const numeric = numericStorageSqlExpression(column);
  const empty = emptyValueSql(field, column);
  const notEmpty = `NOT ${empty}`;
  switch (aggregationType) {
    case "count":
      return `COUNT(DISTINCT "${tableAlias}".id)`;
    case "empty_count":
    case "not_checked_count":
      return `COALESCE(SUM(CASE WHEN ${empty} THEN 1 ELSE 0 END), 0)`;
    case "not_empty_count":
    case "checked_count":
      return `COALESCE(SUM(CASE WHEN ${notEmpty} THEN 1 ELSE 0 END), 0)`;
    case "empty_percentage":
    case "not_checked_percentage":
      return `COALESCE(100.0 * SUM(CASE WHEN ${empty} THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 0)`;
    case "not_empty_percentage":
    case "checked_percentage":
      return `COALESCE(100.0 * SUM(CASE WHEN ${notEmpty} THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 0)`;
    case "unique_count":
      return `COUNT(DISTINCT ${column})`;
    case "min":
    case "min_date":
      return `MIN(${["date", "created_on", "last_modified"].includes(field.type) ? column : numeric})`;
    case "max":
    case "max_date":
      return `MAX(${["date", "created_on", "last_modified"].includes(field.type) ? column : numeric})`;
    case "sum":
      return `SUM(${numeric})`;
    case "average":
      return `AVG(${numeric})`;
    case "variance":
      return `MAX(AVG(${numeric} * ${numeric}) - AVG(${numeric}) * AVG(${numeric}), 0)`;
    case "std_dev":
      return `SQRT(MAX(AVG(${numeric} * ${numeric}) - AVG(${numeric}) * AVG(${numeric}), 0))`;
    case "median":
      return "NULL";
    default:
      throw new ValidationError(`The aggregation type '${aggregationType}' does not exist.`);
  }
}

function filteredRowsCte(query: LocalSupertaskRowQuery) {
  return `WITH filtered AS (SELECT * FROM "${query.tableName}" WHERE ${query.where})`;
}

async function medianForRows(
  db: D1Database,
  query: LocalSupertaskRowQuery,
  field: FieldMeta,
  additionalClause = "",
  additionalParams: unknown[] = []
) {
  const numeric = numericStorageSqlExpression(`"filtered"."field_${field.id}"`);
  const ranked = await db.prepare(
    `${filteredRowsCte(query)}, ranked AS (
       SELECT ${numeric} AS value,
              ROW_NUMBER() OVER (ORDER BY ${numeric}) AS row_number,
              COUNT(*) OVER () AS value_count
       FROM filtered
       WHERE ${numeric} IS NOT NULL ${additionalClause}
     )
     SELECT AVG(value) AS result
     FROM ranked
     WHERE row_number IN ((value_count + 1) / 2, (value_count + 2) / 2)`
  ).bind(...query.params, ...additionalParams).first<{ result: number | null }>();
  return ranked?.result ?? null;
}

async function aggregateSeriesWithoutGrouping(
  db: D1Database,
  query: LocalSupertaskRowQuery,
  series: GroupedAggregationSeries[],
  extraWhere = "",
  extraParams: unknown[] = []
) {
  const fieldsById = new Map(query.fields.map((field) => [field.id, field]));
  const expressions = series.map((item) => {
    const field = fieldsById.get(item.field_id);
    if (!field) throw new ValidationError(`The field with ID ${item.field_id} does not exist.`);
    return `${aggregationSql(field, item.aggregation_type)} AS "field_${item.field_id}_${item.aggregation_type}"`;
  });
  const row = await db.prepare(
    `${filteredRowsCte(query)}
     SELECT ${expressions.join(", ")}
     FROM filtered
     ${extraWhere ? `WHERE ${extraWhere}` : ""}`
  ).bind(...query.params, ...extraParams).first<Record<string, unknown>>() || {};
  for (const item of series) {
    if (item.aggregation_type !== "median") continue;
    const field = fieldsById.get(item.field_id)!;
    row[`field_${item.field_id}_median`] = await medianForRows(
      db,
      query,
      field,
      extraWhere ? `AND ${extraWhere}` : "",
      extraParams
    );
  }
  return row;
}

async function aggregateUserTableRows(db: D1Database, tableId: number, fieldId: number, aggregationType: string, refinements: LocalSupertaskRefinements = {}) {
  const query = await buildLocalSupertaskRowQuery(db, tableId, refinements);
  const field = query.fields.find((candidate) => candidate.id === fieldId);
  if (!field) throw new ValidationError("The field property is missing.");
  if (aggregationType === "median") {
    return { result: await medianForRows(db, query, field) };
  }
  const row = await db.prepare(
    `${filteredRowsCte(query)}
     SELECT ${aggregationSql(field, aggregationType)} AS result FROM filtered`
  ).bind(...query.params).first<{ result: unknown }>();
  return { result: row?.result ?? null };
}

function normalizedGroupedSeries(value: unknown): GroupedAggregationSeries[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("There are no aggregation series defined.");
  }
  if (value.length > 3) throw new ValidationError("The number of series exceeds the maximum allowed length of 3.");
  const used = new Set<string>();
  return value.map((item) => {
    const raw = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : {};
    const id = Number(raw.id);
    const fieldId = Number(raw.field_id);
    const aggregationType = String(raw.aggregation_type || "");
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError("The aggregation series id is missing.");
    if (!Number.isInteger(fieldId) || fieldId <= 0) throw new ValidationError("The aggregation series field has to be set.");
    if (!AGGREGATION_TYPES.has(aggregationType)) throw new ValidationError(`The aggregation type '${aggregationType}' does not exist.`);
    const reference = `field_${fieldId}_${aggregationType}`;
    if (used.has(reference)) {
      throw new ValidationError(`The series with field ID ${fieldId} and aggregation type ${aggregationType} can only be defined once.`);
    }
    used.add(reference);
    return { id, field_id: fieldId, aggregation_type: aggregationType };
  });
}

function normalizedGroupedSorts(value: unknown): GroupedAggregationSort[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : {};
    return {
      sort_on: String(raw.sort_on || ""),
      reference: String(raw.reference || ""),
      direction: String(raw.direction || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC",
    };
  });
}

function compareNullableValues(left: unknown, right: unknown, direction: string) {
  if (left === right) return 0;
  if (left === null || left === undefined) return direction === "DESC" ? 1 : -1;
  if (right === null || right === undefined) return direction === "DESC" ? -1 : 1;
  const result = typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right));
  return direction === "DESC" ? -result : result;
}

async function groupedAggregateUserTableRows(
  db: D1Database,
  tableId: number,
  config: JsonObject,
  refinements: LocalSupertaskRefinements = {}
) {
  const query = await buildLocalSupertaskRowQuery(db, tableId, refinements);
  const fieldsById = new Map(query.fields.map((field) => [field.id, field]));
  const series = normalizedGroupedSeries(config.aggregation_series);
  for (const item of series) {
    if (!fieldsById.has(item.field_id)) throw new ValidationError(`The field with ID ${item.field_id} does not exist.`);
  }

  const groupBys = Array.isArray(config.aggregation_group_bys) ? config.aggregation_group_bys : [];
  if (groupBys.length > 1) throw new ValidationError("The number of group by fields exceeds the maximum allowed length of 1.");
  const groupKeys: Array<{ alias: string; expression: string; field?: FieldMeta }> = [];
  if (groupBys.length === 1) {
    const raw = groupBys[0] && typeof groupBys[0] === "object" ? groupBys[0] as JsonObject : {};
    if (raw.field_id === null || raw.field_id === undefined) {
      const primary = query.fields.find((field) => field.primary);
      if (!primary) throw new ValidationError("The table has no primary field.");
      groupKeys.push({ alias: "id", expression: '"filtered".id' });
      groupKeys.push({ alias: `field_${primary.id}`, expression: `"filtered"."field_${primary.id}"`, field: primary });
    } else {
      const fieldId = Number(raw.field_id);
      const field = fieldsById.get(fieldId);
      if (!field) throw new ValidationError(`The field with ID ${fieldId} does not exist.`);
      groupKeys.push({ alias: `field_${field.id}`, expression: `"filtered"."field_${field.id}"`, field });
    }
  }

  if (groupKeys.length === 0) {
    return { result: await aggregateSeriesWithoutGrouping(db, query, series) };
  }

  const selectGroupKeys = groupKeys.map((key) => `${key.expression} AS "${key.alias}"`);
  const selectSeries = series.map((item) => {
    const field = fieldsById.get(item.field_id)!;
    return `${aggregationSql(field, item.aggregation_type)} AS "field_${item.field_id}_${item.aggregation_type}"`;
  });
  const allowedSortReferences = new Set([
    ...series.map((item) => `field_${item.field_id}_${item.aggregation_type}`),
    ...groupKeys.map((key) => key.alias),
  ]);
  const sorts = normalizedGroupedSorts(config.aggregation_sorts);
  for (const sort of sorts) {
    if (!allowedSortReferences.has(sort.reference)) {
      throw new ValidationError(`The sort reference '${sort.reference}' cannot be used for sorting.`);
    }
  }
  const orderBy = sorts.length > 0
    ? sorts.map((sort) => `"${sort.reference}" ${sort.direction}`).join(", ")
    : groupKeys.map((key) => `"${key.alias}" ASC`).join(", ");
  const grouped = await db.prepare(
    `${filteredRowsCte(query)}
     SELECT ${[...selectGroupKeys, ...selectSeries].join(", ")}
     FROM filtered
     GROUP BY ${groupKeys.map((key) => key.expression).join(", ")}
     ORDER BY ${orderBy}
     LIMIT 11`
  ).bind(...query.params).all<Record<string, unknown>>();
  let rows = grouped.results || [];

  for (const row of rows) {
    const discriminator = groupKeys[0];
    const rawValue = row[discriminator.alias];
    const condition = rawValue === null
      ? `${discriminator.expression} IS NULL`
      : `${discriminator.expression}=?`;
    const values = rawValue === null ? [] : [rawValue];
    for (const item of series) {
      if (item.aggregation_type !== "median") continue;
      row[`field_${item.field_id}_median`] = await medianForRows(
        db,
        query,
        fieldsById.get(item.field_id)!,
        `AND ${condition}`,
        values
      );
    }
  }

  if (rows.length > 10) {
    const kept = rows.slice(0, 9);
    const discriminator = groupKeys[0];
    const selected = kept.map((row) => row[discriminator.alias]);
    const selectedNonNull = selected.filter((value) => value !== null && value !== undefined);
    const selectedNull = selected.some((value) => value === null || value === undefined);
    let otherWhere = "";
    const otherParams: unknown[] = [];
    if (selectedNull && selectedNonNull.length > 0) {
      otherWhere = `${discriminator.expression} IS NOT NULL AND ${discriminator.expression} NOT IN (${selectedNonNull.map(() => "?").join(",")})`;
      otherParams.push(...selectedNonNull);
    } else if (selectedNull) {
      otherWhere = `${discriminator.expression} IS NOT NULL`;
    } else {
      otherWhere = `(${discriminator.expression} IS NULL OR ${discriminator.expression} NOT IN (${selectedNonNull.map(() => "?").join(",")}))`;
      otherParams.push(...selectedNonNull);
    }
    const other = await aggregateSeriesWithoutGrouping(db, query, series, otherWhere, otherParams);
    for (const key of groupKeys) other[key.alias] = "OTHER_VALUES";
    rows = [...kept, other];
    if (sorts[0]?.sort_on === "SERIES") {
      rows.sort((left, right) => compareNullableValues(left[sorts[0].reference], right[sorts[0].reference], sorts[0].direction));
    }
  }

  const serialized = rows.map((row) => {
    const result = { ...row };
    for (const key of groupKeys) {
      if (!key.field || result[key.alias] === "OTHER_VALUES") continue;
      const serializedValue = serializeRow({ id: result.id, [key.alias]: result[key.alias] }, [key.field]) as Record<string, unknown>;
      result[key.alias] = serializedValue[key.alias];
    }
    return result;
  });
  return { result: serialized };
}

async function upsertUserTableRow(
  env: Env,
  tableId: number,
  service: JsonObject,
  rowId?: number,
  context?: BuilderFormulaContext,
  actorUserId: number | null = null
) {
  const db = env.DB;
  const fields = await getActiveFields(db, tableId);
  const mappings = Array.isArray(service.field_mappings) ? service.field_mappings as JsonObject[] : [];
  const values: Record<string, unknown> = {};
  const changedFieldIds = new Set<number>();
  for (const mapping of mappings) {
    const fieldId = Number(mapping.field_id);
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field || isReadOnlyField(field.type)) continue;
    values[`field_${fieldId}`] = serializeFieldValueForInsert(field.type, resolveFormulaValue(mapping.value, context));
    changedFieldIds.add(fieldId);
  }
  if (Object.keys(values).length === 0) throw new ValidationError("The workflow action has no writable field mappings.");
  const now = nowIso();
  await ensureUserTableSystemColumns(db, tableId);
  if (rowId) {
    const before = await db.prepare(
      `SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`
    ).bind(rowId).first<Record<string, unknown>>();
    if (!before) return null;
    const modifiedValues = await modifiedFieldValues(db, fields, now, actorUserId);
    for (const [fieldId, value] of modifiedValues) values[`field_${fieldId}`] = value;
    const assignments = Object.keys(values).map((key) => `"${key}"=?`);
    await db.prepare(
      `UPDATE "database_table_${tableId}" SET ${assignments.join(", ")}, _updated_on=?, _last_modified_by_id=? WHERE id=? AND COALESCE(trashed, 0)=0`
    ).bind(...Object.values(values), now, actorUserId, rowId).run();
    await finalizeRowWrite(db, tableId, rowId, before, changedFieldIds, actorUserId, env);
    return getUserTableRow(db, tableId, rowId);
  }
  const columns = Object.keys(values);
  const existingFieldIds = new Set(columns.flatMap((column) => {
    const match = column.match(/^field_(\d+)$/);
    return match ? [Number(match[1])] : [];
  }));
  const missingValues = await missingCreateFieldValues(db, fields, existingFieldIds, { now, user: actorUserId });
  for (const [fieldId, value] of missingValues) {
    const key = `field_${fieldId}`;
    columns.push(key);
    values[key] = value;
  }
  const autonumberValues = await allocateAutonumberValues(db, tableId);
  for (const [fieldId, value] of autonumberValues) {
    const key = `field_${fieldId}`;
    columns.push(key);
    values[key] = serializeFieldValueForInsert("autonumber", value);
  }
  const bindMarks = columns.map(() => "?").join(", ");
  const inserted = await db.prepare(
    `INSERT INTO "database_table_${tableId}" (${columns.map((key) => `"${key}"`).join(", ")}, _created_on, _updated_on, _created_by_id, _last_modified_by_id)
     VALUES (${bindMarks}, ?, ?, ?, ?) RETURNING id`
  ).bind(...Object.values(values), now, now, actorUserId, actorUserId).first<{ id: number }>();
  if (inserted) await finalizeRowWrite(db, tableId, inserted.id, null, changedFieldIds, actorUserId, env);
  return inserted ? getUserTableRow(db, tableId, inserted.id) : null;
}

function schemaType(type: FieldType): string {
  if (["number", "rating", "duration", "count", "rollup", "autonumber", "auto_number"].includes(type)) return "number";
  if (type === "boolean") return "boolean";
  if (["link_row", "multiple_select", "multiple_collaborators", "file"].includes(type)) return "array";
  return "string";
}

function isReadOnlyField(type: FieldType): boolean {
  return ["formula", "count", "lookup", "rollup", "created_on", "last_modified", "created_by", "last_modified_by", "autonumber", "auto_number"].includes(type);
}

function resolveFormulaValue(value: unknown, context?: BuilderFormulaContext): unknown {
  if (value && typeof value === "object" && "formula" in value) {
    return evaluateBuilderFormula((value as JsonObject).formula, context);
  }
  return value;
}

function resolveFormulaNumber(value: unknown, context?: BuilderFormulaContext): number | null {
  const raw = resolveFormulaValue(value, context);
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const match = String(raw ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function resolveText(value: unknown, context?: BuilderFormulaContext): string {
  const resolved = resolveFormulaValue(value, context);
  if (resolved === null || resolved === undefined) return "";
  if (typeof resolved === "string") return resolved;
  return JSON.stringify(resolved);
}

function resolveList(value: unknown, context?: BuilderFormulaContext): string[] {
  const resolved = resolveFormulaValue(value, context);
  if (Array.isArray(resolved)) return resolved.map((item) => String(item).trim()).filter(Boolean);
  const text = resolveText(resolved, context);
  if (!text.trim()) return [];
  return text.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function evaluateBuilderFormula(value: unknown, context?: BuilderFormulaContext): unknown {
  if (typeof value !== "string") return value;
  const formula = value.trim();
  if (!context || !formula) return value;

  for (const op of ["!=", "==", ">=", "<=", "=", ">", "<"]) {
    const parts = splitFormulaComparison(formula, op);
    if (parts) {
      const left = evaluateBuilderFormula(parts[0], context);
      const right = evaluateBuilderFormula(parts[1], context);
      return compareFormulaValues(left, right, op);
    }
  }

  const exactGet = formula.match(/^get\(\s*(['"])(.*?)\1\s*\)$/);
  if (exactGet) return getBuilderDataPath(context, exactGet[2]);

  const call = parseFormulaCall(formula);
  if (call) {
    const args = splitFormulaArguments(call.args).map((arg) => evaluateBuilderFormula(arg, context));
    const name = call.name.toLowerCase();
    const common = evaluateCommonRuntimeFormulaCall(name, args);
    if (common.handled) return common.value;
    if (name === "concat") return args.map((arg) => arg === null || arg === undefined ? "" : typeof arg === "string" ? arg : JSON.stringify(arg)).join("");
    if (name === "and") return args.every(Boolean);
    if (name === "or") return args.some(Boolean);
    if (name === "not") return !args[0];
    if (name === "tonumber") return Number(args[0] ?? 0);
    if (name === "totext") return args[0] === null || args[0] === undefined ? "" : String(args[0]);
    if (name === "lower") return String(args[0] ?? "").toLowerCase();
    if (name === "upper") return String(args[0] ?? "").toUpperCase();
  }

  if ((formula.startsWith("'") && formula.endsWith("'")) || (formula.startsWith("\"") && formula.endsWith("\""))) {
    return formula.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(formula)) return Number(formula);
  if (/^(true|false)$/i.test(formula)) return formula.toLowerCase() === "true";
  if (/^null$/i.test(formula)) return null;

  return formula.replace(/get\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, path) => {
    const resolved = getBuilderDataPath(context, path);
    if (resolved === null || resolved === undefined) return "";
    if (typeof resolved === "string") return resolved;
    return JSON.stringify(resolved);
  });
}

function parseFormulaCall(formula: string): { name: string; args: string } | null {
  const match = formula.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(([\s\S]*)\)$/);
  if (!match) return null;
  let quote = "";
  let depth = 0;
  for (let i = 0; i < match[2].length; i++) {
    const char = match[2][i];
    if (quote) {
      if (char === quote && match[2][i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return null;
  }
  return depth === 0 ? { name: match[1], args: match[2] } : null;
}

function splitFormulaArguments(args: string): string[] {
  const result: string[] = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    if (quote) {
      if (char === quote && args[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      result.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = args.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function splitFormulaComparison(formula: string, op: string): [string, string] | null {
  let quote = "";
  let depth = 0;
  for (let i = 0; i <= formula.length - op.length; i++) {
    const char = formula[i];
    if (quote) {
      if (char === quote && formula[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && formula.slice(i, i + op.length) === op) {
      return [formula.slice(0, i).trim(), formula.slice(i + op.length).trim()];
    }
  }
  return null;
}

function compareFormulaValues(left: unknown, right: unknown, op: string) {
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  const numeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  const a = numeric ? leftNumber : String(left ?? "");
  const b = numeric ? rightNumber : String(right ?? "");
  if (op === "=" || op === "==") return a === b;
  if (op === "!=") return a !== b;
  if (op === ">") return a > b;
  if (op === ">=") return a >= b;
  if (op === "<") return a < b;
  return a <= b;
}

function getBuilderDataPath(context: BuilderFormulaContext, path: string) {
  if (!context) return null;
  const parts = path.split(".").filter(Boolean);
  const provider = parts.shift();
  if (!provider) return null;

  if (provider === "metadata") return getValueAtPath(context, parts);
  if (provider === "form_data") return getValueAtPath(context.form_data ?? context.formData, parts);
  if (provider === "page_parameter") return getValueAtPath(context.page_parameter ?? context.pageParameter ?? context.path_params ?? context.query_params, parts);
  if (provider === "current_record") return getValueAtPath(context.current_record ?? context.currentRecord, parts);
  if (provider === "data_source" || provider === "data_source_context") {
    return getValueAtPath(context[provider] ?? context.data_sources ?? context.dataSources ?? context.dataSourceContext, parts);
  }
  if (provider === "previous_action") {
    return getValueAtPath(context.previous_action ?? context.previousAction ?? context.previousActionResults, parts);
  }
  if (provider === "user") return getValueAtPath(context.user, parts);
  if (provider === "trigger" || provider === "event_payload") return getValueAtPath(context.trigger ?? context.event_payload ?? context.eventPayload, parts);

  return getValueAtPath(context[provider], parts);
}

function getValueAtPath(value: unknown, parts: string[]): unknown {
  if (parts.length === 0) return value ?? null;
  const [part, ...rest] = parts;
  if (part === "*") {
    if (Array.isArray(value)) return value.map((item) => getValueAtPath(item, rest));
    if (value && typeof value === "object") return Object.values(value as JsonObject).map((item) => getValueAtPath(item, rest));
    return [];
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return getValueAtPath(value[isNumericPathPart(part) ? Number(part) : 0], rest);
  if (typeof value === "object") return getValueAtPath((value as JsonObject)[part], rest);
  return null;
}

function isNumericPathPart(part: string | undefined) {
  return part !== undefined && /^\d+$/.test(part);
}

async function dispatchHttpRequest(service: JsonObject, metadata: JsonObject) {
  const urlRaw = resolveText(service.url, metadata);
  if (!urlRaw) throw new ValidationError("The HTTP request service is missing a URL.");
  const url = new URL(urlRaw);
  for (const param of Array.isArray(service.query_params) ? service.query_params as JsonObject[] : []) {
    if (param.key) url.searchParams.set(String(param.key), resolveText(param.value, metadata));
  }

  const headers = new Headers();
  headers.set("user-agent", "Supertask/2.1.4/HTTPRequestService");
  for (const header of Array.isArray(service.headers) ? service.headers as JsonObject[] : []) {
    if (header.key) headers.set(String(header.key), resolveText(header.value, metadata));
  }

  const method = String(service.http_method || "GET").toUpperCase();
  let body: BodyInit | undefined;
  const bodyType = String(service.body_type || "none");
  if (!["GET", "HEAD"].includes(method) && bodyType !== "none") {
    if (bodyType === "json") {
      headers.set("Content-Type", headers.get("Content-Type") || "application/json");
      const bodyText = resolveText(service.body_content, metadata);
      try {
        body = JSON.stringify(bodyText ? JSON.parse(bodyText) : null);
      } catch {
        throw new ValidationError("The HTTP request body is not valid JSON.");
      }
    } else if (bodyType === "form") {
      const formData = new URLSearchParams();
      for (const entry of Array.isArray(service.form_data) ? service.form_data as JsonObject[] : []) {
        if (entry.key) formData.set(String(entry.key), resolveText(entry.value, metadata));
      }
      headers.set("Content-Type", headers.get("Content-Type") || "application/x-www-form-urlencoded");
      body = formData;
    } else {
      body = resolveText(service.body_content, metadata);
    }
  }

  const timeout = Math.min(Math.max(Number(service.timeout || 60), 1), 120);
  return dispatchPublicHttpRequest({ url, method, headers, body, timeoutSeconds: timeout });
}

async function dispatchSmtpEmail(env: Env, db: D1Database, service: JsonObject, metadata: JsonObject) {
  const integration = await integrationById(db, Number(service.integration_id), "smtp");
  const to = resolveList(service.to_emails, metadata);
  if (to.length === 0) throw new ValidationError("The SMTP email service is missing recipients.");
  const from = resolveText(service.from_email, metadata) || String(integration.from_email || integration.username || env.SMTP_FROM || "");
  if (!from) throw new ValidationError("The SMTP email service is missing a sender.");
  const subject = resolveText(service.subject, metadata);
  const body = resolveText(service.body, metadata);
  const bodyType = String(service.body_type || "plain");
  const host = String(integration.host || env.SMTP_HOST || "");
  const port = Number(integration.port || env.SMTP_PORT || 587);
  if (!host) throw new ValidationError("The SMTP integration is missing a host.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("The SMTP integration has an invalid port.");
  const cc = resolveList(service.cc_emails, metadata);
  const bcc = resolveList(service.bcc_emails, metadata);
  const fromName = resolveText(service.from_name, metadata);
  const username = String(integration.username || env.SMTP_USER || "");
  const password = String(integration.password || env.SMTP_PASS || "");
  const message = buildSmtpMessage({
    from: fromName ? `${fromName} <${from}>` : from,
    fromEmail: emailAddress(from),
    to,
    cc,
    bcc,
    subject,
    body,
    bodyType,
  });
  return sendSmtpMessage({
    host,
    port,
    useTls: integration.use_tls !== false,
    username,
    password,
    from: emailAddress(from),
    recipients: [...to, ...cc, ...bcc].map(emailAddress),
    message,
  });
}

async function dispatchAiAgent(env: Env, db: D1Database, service: JsonObject, metadata: JsonObject) {
  const integration = await integrationById(db, Number(service.integration_id), "ai");
  const settings = parseJson<JsonObject>(JSON.stringify(integration.ai_settings || {}), {});
  const provider = String(service.ai_generative_ai_type || "");
  const model = String(service.ai_generative_ai_model || "");
  const prompt = resolveText(service.ai_prompt, metadata);
  if (!provider || !model || !prompt) throw new ValidationError("The AI agent service is missing provider, model or prompt.");
  let providerSettings = parseJson<JsonObject>(JSON.stringify(settings[provider] || {}), {});
  if (!Object.prototype.hasOwnProperty.call(settings, provider)) {
    const application = await db.prepare("SELECT workspace_id FROM core_application WHERE id=? AND trashed=0")
      .bind(Number(integration.application_id))
      .first<{ workspace_id: number }>();
    if (application?.workspace_id) {
      const workspaceSettings = await workspaceGenerativeAISettings(env.CACHE, Number(application.workspace_id));
      providerSettings = parseJson<JsonObject>(JSON.stringify(workspaceSettings[provider] || {}), {});
    }
  }
  const availableModels = Array.isArray(providerSettings.models)
    ? (providerSettings.models as unknown[]).map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (availableModels.length > 0 && !availableModels.includes(model)) {
    throw new ValidationError(`Model '${model}' is not available for provider '${provider}'.`);
  }
  if (service.ai_output_type === "choice") {
    const choices = Array.isArray(service.ai_choices) ? service.ai_choices.map(String) : [];
    if (choices.length === 0) throw new ValidationError("At least one choice is required when output type is 'choice'.");
    if (!choices.some((choice) => choice.trim())) {
      throw new ValidationError("At least one non-empty choice is required when output type is 'choice'.");
    }
  }
  const temperature = service.ai_temperature === null || service.ai_temperature === undefined ? undefined : Number(service.ai_temperature);
  let output = "";

  if (provider === "openai" || provider === "openrouter") {
    assertProviderApiKey(providerSettings, provider);
    const baseUrl = provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : String(providerSettings.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerSettings.api_key}`,
        "Content-Type": "application/json",
        ...(providerSettings.organization ? { "OpenAI-Organization": String(providerSettings.organization) } : {}),
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature }),
    });
    const data = await response.json<any>();
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    output = data.choices?.[0]?.message?.content || "";
  } else if (provider === "anthropic") {
    assertProviderApiKey(providerSettings, provider);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": String(providerSettings.api_key || ""),
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }], temperature }),
    });
    const data = await response.json<any>();
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    output = data.content?.map((part: any) => part.text || "").join("") || "";
  } else if (provider === "mistral") {
    assertProviderApiKey(providerSettings, provider);
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${providerSettings.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature }),
    });
    const data = await response.json<any>();
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    output = data.choices?.[0]?.message?.content || "";
  } else if (provider === "ollama") {
    const host = String(providerSettings.host || "").replace(/\/$/, "");
    if (!host) throw new ValidationError("The Ollama integration is missing a host.");
    const response = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: temperature === undefined ? undefined : { temperature } }),
    });
    const data = await response.json<any>();
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    output = data.response || "";
  } else {
    throw new ValidationError(`Unsupported AI provider: ${provider}`);
  }

  if (service.ai_output_type === "choice") {
    const choices = Array.isArray(service.ai_choices) ? service.ai_choices.map(String).filter(Boolean) : [];
    const exact = choices.find((choice) => output.trim().toLowerCase() === choice.toLowerCase());
    const included = choices.find((choice) => output.toLowerCase().includes(choice.toLowerCase()));
    return { result: exact || included || output.trim(), raw: output };
  }
  return { result: output };
}

function dispatchRouter(service: JsonObject, metadata: JsonObject) {
  const edges = Array.isArray(service.edges) ? service.edges as JsonObject[] : [];
  const selected = edges.find((edge) => ["true", "1", "yes"].includes(resolveText(edge.condition, metadata).toLowerCase()));
  return { edge: selected?.label || null };
}

function dispatchIterator(service: JsonObject, metadata: JsonObject) {
  const source = resolveFormulaValue(service.source, metadata);
  if (Array.isArray(source)) return { items: source };
  const text = resolveText(service.source, metadata);
  try {
    const parsed = JSON.parse(text);
    return { items: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { items: text ? [text] : [] };
  }
}

function emailAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

function buildSmtpMessage(options: {
  from: string;
  fromEmail: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyType: string;
}) {
  const headers = [
    `From: ${options.from}`,
    `To: ${options.to.join(", ")}`,
    ...(options.cc.length ? [`Cc: ${options.cc.join(", ")}`] : []),
    `Subject: ${sanitizeHeader(options.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: ${options.bodyType === "html" ? "text/html" : "text/plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: 8bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${escapeSmtpBody(options.body)}`;
}

function sanitizeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeSmtpBody(value: string) {
  return value.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

async function sendSmtpMessage(options: {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
  from: string;
  recipients: string[];
  message: string;
}) {
  let socket = connect({ hostname: options.host, port: options.port }, {
    allowHalfOpen: false,
    secureTransport: options.port === 465 ? "on" : "off",
  });
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  let buffer = "";
  const read = () => readSmtpResponse(reader, (chunk) => { buffer += chunk; }, () => buffer, (next) => { buffer = next; });
  const write = async (line: string) => {
    await writer.write(new TextEncoder().encode(`${line}\r\n`));
  };

  try {
    await expectSmtp(read, [220], `The host ${options.host}:${options.port} could not be reached`);
    await write(`EHLO ${options.host}`);
    await expectSmtp(read, [250], "The SMTP server rejected EHLO.");
    if (options.useTls && options.port !== 465) {
      await write("STARTTLS");
      await expectSmtp(read, [220], "TLS not supported by server");
      writer.releaseLock();
      reader.releaseLock();
      socket = socket.startTls({ expectedServerHostname: options.host });
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      buffer = "";
      await write(`EHLO ${options.host}`);
      await expectSmtp(read, [250], "The SMTP server rejected EHLO after STARTTLS.");
    }
    if (options.username || options.password) {
      await write("AUTH LOGIN");
      await expectSmtp(read, [334], "The SMTP server rejected authentication.");
      await write(btoa(options.username));
      await expectSmtp(read, [334], "The SMTP username is invalid.");
      await write(btoa(options.password));
      await expectSmtp(read, [235], "The username or password is incorrect.");
    }
    await write(`MAIL FROM:<${options.from}>`);
    await expectSmtp(read, [250], "The SMTP server rejected the sender.");
    for (const recipient of options.recipients) {
      await write(`RCPT TO:<${recipient}>`);
      await expectSmtp(read, [250, 251], `The SMTP server rejected recipient ${recipient}.`);
    }
    await write("DATA");
    await expectSmtp(read, [354], "The SMTP server rejected the message body.");
    await writer.write(new TextEncoder().encode(`${options.message}\r\n.\r\n`));
    await expectSmtp(read, [250], "The SMTP server rejected the message.");
    await write("QUIT").catch(() => undefined);
    return { success: true, sent: true };
  } catch (error: any) {
    throw new ValidationError(error?.message || String(error));
  } finally {
    await writer.releaseLock();
    reader.releaseLock();
    await socket.close().catch(() => undefined);
  }
}

async function readSmtpResponse(
  reader: ReadableStreamDefaultReader,
  append: (chunk: string) => void,
  getBuffer: () => string,
  setBuffer: (value: string) => void
) {
  const decoder = new TextDecoder();
  while (true) {
    const lines = getBuffer().split(/\r?\n/);
    const completeLines = lines.slice(0, -1);
    for (let index = completeLines.length - 1; index >= 0; index -= 1) {
      const line = completeLines[index];
      if (/^\d{3} /.test(line)) {
        const consumed = completeLines.slice(0, index + 1).join("\r\n").length + 2;
        setBuffer(getBuffer().slice(consumed));
        return { code: Number(line.slice(0, 3)), message: completeLines.join("\n") };
      }
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("The SMTP connection closed unexpectedly.");
    append(decoder.decode(chunk.value, { stream: true }));
  }
}

async function expectSmtp(read: () => Promise<{ code: number; message: string }>, codes: number[], message: string) {
  const response = await read();
  if (!codes.includes(response.code)) {
    throw new Error(`${message} SMTP response: ${response.message}`);
  }
  return response;
}

function assertProviderApiKey(settings: JsonObject, provider: string) {
  if (!settings.api_key) {
    throw new ValidationError(`The ${provider} integration is missing an API key.`);
  }
}

function dispatchTriggerPayload(row: any, service: JsonObject, metadata: JsonObject) {
  if (row.type === "periodic") {
    return {
      triggered_at: metadata.triggered_at || new Date().toISOString(),
    };
  }
  if (row.type === "http_trigger") {
    return metadata;
  }
  if (row.type === "local_supertask_rows_created" || row.type === "local_supertask_rows_updated") {
    return {
      table_id: Number(service.table_id) || metadata.table_id || null,
      event_type: metadata.event_type || row.type,
      items: Array.isArray(metadata.items) ? metadata.items : [],
    };
  }
  if (row.type === "local_supertask_rows_deleted") {
    return {
      table_id: Number(service.table_id) || metadata.table_id || null,
      event_type: metadata.event_type || row.type,
      row_ids: Array.isArray(metadata.row_ids) ? metadata.row_ids : [],
    };
  }
  return metadata;
}

async function workflowActionsForTrigger(db: D1Database, trigger: any) {
  const config = parseJson<JsonObject>(trigger.configuration, {});
  const nextIds = Array.isArray(config.next_workflow_action_ids)
    ? config.next_workflow_action_ids.map(Number).filter(Boolean)
    : [];
  if (nextIds.length > 0) {
    const bindMarks = nextIds.map(() => "?").join(", ");
    const result = await db.prepare(
      `SELECT * FROM builder_workflowaction WHERE id IN (${bindMarks})`
    ).bind(...nextIds).all<any>();
    const byId = new Map((result.results || []).map((row: any) => [Number(row.id), row]));
    return nextIds.map((id) => byId.get(id)).filter(Boolean);
  }

  const result = await db.prepare(
    `SELECT *
     FROM builder_workflowaction
     WHERE page_id = ?
       AND event = ?
       AND CAST([order] AS REAL) > CAST(? AS REAL)
     ORDER BY CAST([order] AS REAL) ASC, id ASC`
  ).bind(trigger.page_id, trigger.event, trigger.order).all<any>();

  return (result.results || []).filter((row: any) => !TRIGGER_TYPES.has(row.type));
}

async function httpWorkflowTriggerByUid(db: D1Database, uid: string, simulate: boolean) {
  const result = await db.prepare(
    `SELECT wa.*, p.builder_id, a.workspace_id
     FROM builder_workflowaction wa
     JOIN builder_page p ON p.id = wa.page_id
     JOIN core_application a ON a.id = p.builder_id
     WHERE wa.type = 'http_trigger' AND a.type = 'builder' AND a.trashed = 0
       AND (
         json_extract(wa.configuration, '$.service.uid') = ?
         OR json_extract(wa.configuration, '$.uid') = ?
       )
     ORDER BY wa.id DESC`
  ).bind(uid, uid).all<any>();

  const trigger = (result.results || []).find((candidate: any) => {
    if (simulate) return true;
    const config = parseJson<JsonObject>(candidate.configuration, {});
    const service = parseJson<JsonObject>(JSON.stringify(config.service || config), {});
    return service.is_public !== false;
  });
  if (!trigger) throw new DoesNotExist("HTTP trigger", uid);
  return trigger;
}

function isPeriodicTriggerDue(trigger: any, now: Date) {
  const config = parseJson<JsonObject>(trigger.configuration, {});
  const service = parseJson<JsonObject>(JSON.stringify(config.service || config), {});
  const interval = String(service.interval || "hour");
  const lastRunRaw = service.last_periodic_run || config.last_periodic_run;
  if (!lastRunRaw) return true;
  const lastRun = new Date(String(lastRunRaw));
  if (Number.isNaN(lastRun.getTime())) return true;

  const elapsed = now.getTime() - lastRun.getTime();
  if (interval === "minute") {
    const minutes = Math.max(Number(service.minute || 1), 1);
    return elapsed >= minutes * 60 * 1000;
  }
  if (interval === "hour") {
    return elapsed >= 60 * 60 * 1000 && now.getUTCMinutes() >= Number(service.minute || 0);
  }
  if (interval === "day") {
    return elapsed >= 24 * 60 * 60 * 1000
      && now.getUTCHours() >= Number(service.hour || 0)
      && now.getUTCMinutes() >= Number(service.minute || 0);
  }
  if (interval === "week") {
    const mondayBasedDay = (now.getUTCDay() + 6) % 7;
    return elapsed >= 7 * 24 * 60 * 60 * 1000
      && mondayBasedDay === Number(service.day_of_week || 0)
      && now.getUTCHours() >= Number(service.hour || 0)
      && now.getUTCMinutes() >= Number(service.minute || 0);
  }
  if (interval === "month") {
    return elapsed >= 28 * 24 * 60 * 60 * 1000
      && now.getUTCDate() === Number(service.day_of_month || 1)
      && now.getUTCHours() >= Number(service.hour || 0)
      && now.getUTCMinutes() >= Number(service.minute || 0);
  }
  return false;
}

async function markPeriodicTriggerRun(db: D1Database, trigger: any, now: Date) {
  const config = parseJson<JsonObject>(trigger.configuration, {});
  const service = parseJson<JsonObject>(JSON.stringify(config.service || {}), {});
  const nextConfig = {
    ...config,
    last_periodic_run: now.toISOString(),
    service: {
      ...service,
      last_periodic_run: now.toISOString(),
    },
  };
  await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=?")
    .bind(JSON.stringify(nextConfig), now.toISOString(), trigger.id)
    .run();
}

async function integrationById(db: D1Database, integrationId: number, expectedType?: string) {
  if (!integrationId) throw new ValidationError("The service is missing an integration.");
  const integration = await db.prepare("SELECT * FROM core_integration WHERE id=?")
    .bind(integrationId)
    .first<any>();
  if (!integration) throw new DoesNotExist("Integration", integrationId);
  if (expectedType && integration.type !== expectedType) {
    throw new ValidationError(`Expected a ${expectedType} integration.`);
  }
  const serialized: JsonObject = {
    ...parseJson<JsonObject>(integration.configuration, {}),
    id: integration.id,
    application_id: integration.application_id,
    type: integration.type,
    name: integration.name,
  };
  return serialized;
}

