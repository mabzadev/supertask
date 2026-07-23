import type { D1Database } from "@cloudflare/workers-types";
import type { FieldType } from "./dynamic-tables";

export interface SerializableFieldRow {
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

export const COMPUTED_FIELD_TYPES = new Set<FieldType>([
  "formula", "count", "lookup", "rollup",
  "last_modified", "created_on", "last_modified_by", "created_by",
  "autonumber", "auto_number", "uuid",
]);

export function isReadOnlyFieldType(type: FieldType): boolean {
  return COMPUTED_FIELD_TYPES.has(type);
}

export function fieldTypeDefaults(type: FieldType): Record<string, unknown> {
  switch (type) {
    case "long_text":
      return { long_text_enable_rich_text: false, long_text_default: "" };
    case "number":
      return {
        number_decimal_places: 0,
        number_negative: false,
        number_prefix: "",
        number_suffix: "",
        number_separator: "",
        number_default: null,
      };
    case "rating":
      return { max_value: 5, color: "dark-orange", style: "star" };
    case "boolean":
      return { boolean_default: false };
    case "date":
      return {
        date_format: "EU",
        date_include_time: false,
        date_time_format: "24",
        date_show_tzinfo: false,
        date_force_timezone: null,
      };
    case "duration":
      return { duration_format: "h:mm" };
    case "single_select":
      return { select_options: [], single_select_default: null };
    case "multiple_select":
      return { select_options: [], multiple_select_default: [] };
    case "multiple_collaborators":
      return { notify_user_when_added: false, available_collaborators: [] };
    case "link_row":
      return {
        link_row_table_id: null,
        link_row_related_field_id: null,
        link_row_related_field: null,
        link_row_multiple_relationships: true,
        link_row_limit_selection_view_id: null,
        link_row_table: null,
        link_row_table_primary_field: null,
      };
    case "file":
      return { file_default: [] };
    case "formula":
      return {
        formula: "",
        formula_type: "text",
        array_formula_type: null,
        formula_type_error: null,
        nullable: true,
      };
    case "lookup":
      return {
        through_field_id: null,
        target_field_id: null,
        formula_type: "text",
        array_formula_type: null,
        formula_type_error: null,
        nullable: true,
      };
    case "rollup":
      return {
        through_field_id: null,
        target_field_id: null,
        rollup_function: "count",
        formula_type: "number",
        formula_type_error: null,
        nullable: true,
      };
    case "count":
      return {
        through_field_id: null,
        formula_type: "number",
        formula_type_error: null,
        nullable: false,
        number_decimal_places: 0,
      };
    case "ai":
      return {
        ai_generative_ai_type: null,
        ai_generative_ai_model: null,
        ai_output_type: "text",
        ai_temperature: null,
        ai_prompt: { formula: "", mode: "simple", version: "0.1" },
        ai_file_field_id: null,
        ai_auto_update: false,
      };
    case "password":
      return { allow_endpoint_authentication: false };
    default:
      return {};
  }
}

export function normalizeFieldSettings(field: SerializableFieldRow): Record<string, unknown> {
  let settings: Record<string, unknown> = {};
  try {
    settings = field.field_settings ? JSON.parse(field.field_settings) : {};
  } catch {
    settings = {};
  }
  return { ...fieldTypeDefaults(field.type), ...settings };
}

export async function getSelectOptions(db: D1Database, fieldId: number): Promise<object[]> {
  const options = await db.prepare(
    `SELECT id, value, color, [order]
     FROM database_selectoption
     WHERE field_id=?
     ORDER BY [order] ASC, id ASC`
  ).bind(fieldId).all<any>();

  return (options.results || []).map((option) => ({
    id: option.id,
    value: option.value,
    color: option.color || "blue",
    order: option.order ?? 0,
  }));
}

async function hydrateLinkRowSettings(
  db: D1Database,
  settings: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const linkTableId = Number(settings.link_row_table_id || 0);
  if (!linkTableId) return settings;

  const [table, primary] = await Promise.all([
    db.prepare(
      `SELECT id, name, [order], database_id
       FROM database_table
       WHERE id=? AND trashed=0`
    ).bind(linkTableId).first<any>(),
    db.prepare(
      `SELECT id, table_id, name, type, [order], "primary" AS is_primary, read_only,
              description, db_index, immutable_type, immutable_properties, field_settings
       FROM database_field
       WHERE table_id=? AND trashed=0
       ORDER BY "primary" DESC, [order] ASC, id ASC
       LIMIT 1`
    ).bind(linkTableId).first<any>(),
  ]);

  if (table) {
    settings.link_row_table = table.id;
  }

  if (primary) {
    settings.link_row_table_primary_field = {
      id: primary.id,
      table_id: primary.table_id,
      name: primary.name,
      type: primary.type,
      order: primary.order,
      primary: Boolean(primary.is_primary),
      read_only: Boolean(primary.read_only) || isReadOnlyFieldType(primary.type),
      description: primary.description ?? null,
    };
  }

  return settings;
}

function collaboratorName(row: { username?: string; first_name?: string; last_name?: string; email?: string }) {
  return [row.first_name, row.last_name].map((part) => String(part || "").trim()).filter(Boolean).join(" ") ||
    String(row.username || row.email || "");
}

async function getAvailableCollaborators(db: D1Database, tableId: number): Promise<object[]> {
  const rows = await db.prepare(
    `SELECT u.id, u.username, u.first_name, u.last_name, u.email
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     JOIN core_workspaceuser wu ON wu.workspace_id=a.workspace_id AND wu.to_be_deleted=0
     JOIN auth_user u ON u.id=wu.user_id AND u.is_active=1
     LEFT JOIN core_userprofile p ON p.user_id=u.id
     WHERE t.id=? AND t.trashed=0 AND COALESCE(p.to_be_deleted, 0)=0
     ORDER BY u.first_name ASC, u.id ASC`
  ).bind(tableId).all<any>();

  return (rows.results || []).map((row) => ({
    id: row.id,
    name: collaboratorName(row),
  }));
}

export async function serializeDatabaseFieldRow(
  db: D1Database,
  field: SerializableFieldRow
): Promise<object> {
  const settings = normalizeFieldSettings(field);
  if (
    field.type === "single_select" ||
    field.type === "multiple_select" ||
    (field.type === "ai" && settings.ai_output_type === "choice")
  ) {
    settings.select_options = await getSelectOptions(db, field.id);
  }
  if (field.type === "ai") {
    delete settings.ai_auto_update_user_id;
  }
  if (field.type === "link_row") {
    await hydrateLinkRowSettings(db, settings);
    settings.link_row_related_field = settings.link_row_related_field_id ?? null;
  }
  if (field.type === "multiple_collaborators") {
    settings.available_collaborators = await getAvailableCollaborators(db, field.table_id);
  }

  return {
    id: field.id,
    table_id: field.table_id,
    name: field.name,
    type: field.type,
    order: field.order,
    primary: Boolean(field.is_primary ?? field.primary),
    read_only: Boolean(field.read_only) || isReadOnlyFieldType(field.type),
    description: field.field_description ?? field.description ?? null,
    db_index: Boolean(field.db_index),
    immutable_type: Boolean(field.immutable_type),
    immutable_properties: Boolean(field.immutable_properties),
    ...settings,
    related_fields: [],
  };
}
