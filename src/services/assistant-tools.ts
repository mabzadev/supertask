import type { Env, RequestUser } from "../types/env";
import { apiRouter } from "../routes/index";
import type { GenerativeAITool } from "./generative-ai";
import { searchAssistantKnowledge } from "./assistant-knowledge";

type JsonObject = Record<string, unknown>;

export type AssistantNavigation = {
  type: "workspace" | "database-table" | "database-view" | "automation-workflow";
  [key: string]: unknown;
};

export type AssistantToolContext = {
  env: Env;
  executionCtx: Parameters<typeof apiRouter.fetch>[2];
  authorization: string;
  user: RequestUser;
  workspaceId: number;
  uiContext: JsonObject;
  navigate: (location: AssistantNavigation) => void | Promise<void>;
  generateText?: (prompt: string) => Promise<string>;
};

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayValue(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((item) => Number.isInteger(item) && item > 0)
    : [];
}

function requiredString(value: unknown, field: string) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

function requiredId(value: unknown, field: string) {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${field} must be a positive integer.`);
  return result;
}

async function internalApi(
  context: AssistantToolContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const headers = new Headers({ Authorization: context.authorization });
  let requestBody: string | undefined;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(body);
  }
  const response = await apiRouter.fetch(new Request(`https://assistant.internal${path}`, {
    method,
    headers,
    body: requestBody,
  }), context.env, context.executionCtx);
  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const detail = data && typeof data === "object" ? data.detail || data.error : data;
    throw new Error(`${method} ${path} failed (${response.status}): ${String(detail || response.statusText)}`);
  }
  return data;
}

function schema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function applicationToolType(type: unknown) {
  const normalized = requiredString(type, "type");
  if (!["database", "application", "automation", "dashboard"].includes(normalized)) {
    throw new Error(`Unsupported builder type: ${normalized}`);
  }
  return normalized === "application" ? "builder" : normalized;
}

function serializedToolType(type: unknown) {
  return String(type) === "builder" ? "application" : String(type);
}

async function workspaceApplications(context: AssistantToolContext) {
  return internalApi(context, "GET", `/applications/workspace/${context.workspaceId}/`);
}

async function tableDetails(context: AssistantToolContext, tableId: number) {
  return internalApi(context, "GET", `/database/tables/${tableId}/`);
}

async function tableFields(context: AssistantToolContext, tableId: number) {
  return internalApi(context, "GET", `/database/fields/table/${tableId}/`);
}

async function navigateToTable(context: AssistantToolContext, table: JsonObject) {
  const location: AssistantNavigation = {
    type: "database-table",
    database_id: Number(table.database_id),
    table_id: Number(table.id),
    table_name: String(table.name || ""),
  };
  await context.navigate(location);
  return location;
}

function fieldCreateBody(field: JsonObject) {
  const body = { ...field };
  if (body.linked_table !== undefined && body.link_row_table_id === undefined) {
    body.link_row_table_id = body.linked_table;
    delete body.linked_table;
  }
  if (body.decimal_places !== undefined && body.number_decimal_places === undefined) {
    body.number_decimal_places = body.decimal_places;
    delete body.decimal_places;
  }
  if (body.suffix !== undefined && body.number_suffix === undefined) {
    body.number_suffix = body.suffix;
    delete body.suffix;
  }
  if (body.include_time !== undefined && body.date_include_time === undefined) {
    body.date_include_time = body.include_time;
    delete body.include_time;
  }
  if (body.rich_text !== undefined && body.long_text_enable_rich_text === undefined) {
    body.long_text_enable_rich_text = body.rich_text;
    delete body.rich_text;
  }
  if (body.options !== undefined && body.select_options === undefined) {
    body.select_options = body.options;
    delete body.options;
  }
  return body;
}

async function fieldCreateBodyForTable(context: AssistantToolContext, tableId: number, field: JsonObject) {
  const body = fieldCreateBody(field);
  if (body.type !== "link_row" || body.link_row_table_id === undefined) return body;
  const numericTarget = Number(body.link_row_table_id);
  if (Number.isInteger(numericTarget) && numericTarget > 0) {
    body.link_row_table_id = numericTarget;
    return body;
  }
  const table = await tableDetails(context, tableId);
  const tables = await internalApi(context, "GET", `/database/tables/database/${table.database_id}/`);
  const target = tables.find((candidate: any) => String(candidate.name) === String(body.link_row_table_id));
  if (!target) throw new Error(`The linked table '${String(body.link_row_table_id)}' does not exist in this database.`);
  body.link_row_table_id = Number(target.id);
  return body;
}

function viewCreateSettings(view: JsonObject) {
  const settings = { ...view };
  delete settings.name;
  delete settings.type;
  const fieldOptions = Array.isArray(settings.field_options) ? settings.field_options.map(objectValue) : [];
  delete settings.field_options;
  if (settings.row_height !== undefined) {
    settings.row_height_size = settings.row_height;
    delete settings.row_height;
  }
  if (settings.column_field_id !== undefined) {
    settings.single_select_field = settings.column_field_id;
    delete settings.column_field_id;
  }
  if (settings.date_field_id !== undefined) {
    settings.date_field = settings.date_field_id;
    delete settings.date_field_id;
  }
  if (settings.cover_field_id !== undefined) {
    settings.card_cover_image_field = settings.cover_field_id;
    delete settings.cover_field_id;
  }
  if (settings.start_date_field_id !== undefined) {
    settings.start_date_field = settings.start_date_field_id;
    delete settings.start_date_field_id;
  }
  if (settings.end_date_field_id !== undefined) {
    settings.end_date_field = settings.end_date_field_id;
    delete settings.end_date_field_id;
  }
  if (settings.submit_button_label !== undefined) {
    settings.submit_text = settings.submit_button_label;
    delete settings.submit_button_label;
  }
  return { settings, fieldOptions };
}

function sourceDateValue(value: unknown) {
  const date = objectValue(value);
  if (Number.isInteger(Number(date.year)) && Number.isInteger(Number(date.month)) && Number.isInteger(Number(date.day))) {
    return [date.year, date.month, date.day].map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("-");
  }
  return value === null || value === undefined ? "" : String(value);
}

async function sourceViewFilterBody(context: AssistantToolContext, viewId: number, filter: JsonObject) {
  const view = await internalApi(context, "GET", `/database/views/${viewId}/`);
  const fields = await tableFields(context, Number(view.table_id));
  const fieldId = requiredId(filter.field_id ?? filter.field, "filter.field_id");
  const field = fields.find((candidate: any) => Number(candidate.id) === fieldId);
  if (!field) throw new Error(`Field ${fieldId} does not belong to view ${viewId}.`);
  const operator = requiredString(filter.operator ?? filter.type, "filter.operator");
  let type = operator;
  if (operator === "higher_than" && filter.or_equal === true) type = "higher_than_or_equal";
  if (operator === "lower_than" && filter.or_equal === true) type = "lower_than_or_equal";
  if (String(filter.type) === "date") {
    if (operator === "equal") type = "date_is";
    if (operator === "not_equal") type = "date_is_not";
    if (operator === "after") type = filter.or_equal === true ? "date_is_on_or_after" : "date_is_after";
    if (operator === "before") type = filter.or_equal === true ? "date_is_on_or_before" : "date_is_before";
  }
  if (String(filter.type) === "single_select") {
    type = operator === "is_none_of" ? "single_select_is_none_of" : "single_select_is_any_of";
  }
  if (String(filter.type) === "multiple_select") {
    type = operator === "is_none_of" ? "multiple_select_has_not" : "multiple_select_has";
  }
  if (String(filter.type) === "link_row") type = operator === "has_not" ? "link_row_has_not" : "link_row_has";
  if (String(filter.type) === "boolean") type = "boolean";

  let value: unknown = filter.value ?? "";
  if (String(filter.type) === "date") {
    const timezone = String(context.uiContext.timezone || "UTC");
    value = `${timezone}?${sourceDateValue(value)}?${String(filter.mode || "exact_date")}`;
  } else if (String(filter.type) === "single_select" || String(filter.type) === "multiple_select") {
    const requested = new Set(stringArray(value).map((item) => item.toLowerCase()));
    value = (Array.isArray(field.select_options) ? field.select_options : [])
      .filter((option: any) => requested.has(String(option.value || "").toLowerCase()))
      .map((option: any) => Number(option.id))
      .join(",");
  } else if (String(filter.type) === "boolean") {
    value = value ? "1" : "0";
  } else if (Array.isArray(value)) {
    value = value.map(String).join(",");
  } else {
    value = String(value ?? "");
  }
  return { field: fieldId, type, value };
}

function nodeType(type: unknown) {
  const source = requiredString(type, "node.type");
  const aliases: Record<string, string> = {
    rows_created: "local_supertask_rows_created",
    rows_updated: "local_supertask_rows_updated",
    rows_deleted: "local_supertask_rows_deleted",
    create_row: "local_supertask_create_row",
    update_row: "local_supertask_update_row",
    delete_row: "local_supertask_delete_row",
    get_row: "local_supertask_get_row",
    list_rows: "local_supertask_list_rows",
    aggregate_rows: "local_supertask_aggregate_rows",
  };
  return aliases[source] || source;
}

function quotedFormulaLiteral(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function sourceFormula(value: unknown, references: Map<string, any>): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value ?? "");
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text.trim()) || /^(?:true|false)$/i.test(text.trim())) {
    return text.trim().toLowerCase();
  }
  const exact = text.match(/^\{\{\s*([\w-]+)(?:\.([^}]+))?\s*\}\}$/);
  if (exact) {
    const node = references.get(exact[1]);
    if (!node) throw new Error(`Unknown workflow formula reference: ${exact[1]}`);
    const path = exact[2] ? `.${exact[2].trim()}` : "";
    return `get('previous_node.${node.id}${path}')`;
  }
  const parts: string[] = [];
  let offset = 0;
  const pattern = /\{\{\s*([\w-]+)(?:\.([^}]+))?\s*\}\}/g;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset) parts.push(quotedFormulaLiteral(text.slice(offset, match.index)));
    const node = references.get(match[1]);
    if (!node) throw new Error(`Unknown workflow formula reference: ${match[1]}`);
    const path = match[2] ? `.${match[2].trim()}` : "";
    parts.push(`get('previous_node.${node.id}${path}')`);
    offset = match.index! + match[0].length;
  }
  if (parts.length > 0) {
    if (offset < text.length) parts.push(quotedFormulaLiteral(text.slice(offset)));
    return parts.length === 1 ? parts[0] : `concat(${parts.join(", ")})`;
  }
  return quotedFormulaLiteral(text);
}

function nodeService(node: JsonObject, references = new Map<string, any>()): JsonObject {
  if (node.service && typeof node.service === "object" && !Array.isArray(node.service)) {
    return objectValue(node.service);
  }
  if (node.periodic_interval && typeof node.periodic_interval === "object") return objectValue(node.periodic_interval);
  if (node.rows_triggers_settings && typeof node.rows_triggers_settings === "object") return objectValue(node.rows_triggers_settings);
  const type = String(node.type || "");
  if (type === "create_row" || type === "update_row") {
    const values = objectValue(node.values);
    return {
      table_id: Number(node.table_id),
      ...(type === "update_row" ? { row_id: sourceFormula(node.row_id, references) } : {}),
      field_mappings: Object.entries(values).map(([fieldId, value]) => ({
        field_id: Number(fieldId),
        enabled: true,
        value: sourceFormula(value, references),
      })),
    };
  }
  if (type === "delete_row") {
    return { table_id: Number(node.table_id), row_id: sourceFormula(node.row_id, references) };
  }
  if (type === "smtp_email") {
    return {
      to_emails: sourceFormula(node.to_emails, references),
      cc_emails: sourceFormula(node.cc_emails || "", references),
      bcc_emails: sourceFormula(node.bcc_emails || "", references),
      subject: sourceFormula(node.subject, references),
      body: sourceFormula(node.body, references),
      body_type: String(node.body_type || "plain"),
    };
  }
  if (type === "ai_agent") {
    return {
      ai_output_type: String(node.output_type || "text"),
      ai_choices: Array.isArray(node.choices) ? node.choices.map(String) : [],
      ai_prompt: sourceFormula(node.prompt, references),
    };
  }
  if (type === "router") {
    return {
      edges: arrayValue(node.edges).map((edge, index) => ({
        uid: crypto.randomUUID(),
        order: index,
        label: requiredString(edge.label, "router.edges.label"),
        condition: String(edge.condition || ""),
      })),
    };
  }
  const excluded = new Set(["ref", "label", "type", "previous_node_ref", "router_edge_label", "position", "output"]);
  return Object.fromEntries(Object.entries(node).filter(([key]) => !excluded.has(key)));
}

function generatedFormulaPayload(value: string): JsonObject {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return objectValue(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return objectValue(JSON.parse(trimmed.slice(start, end + 1)));
      } catch {
        return {};
      }
    }
    return {};
  }
}

export function createAssistantTools(context: AssistantToolContext): GenerativeAITool[] {
  const navigation: GenerativeAITool = {
    name: "navigation",
    description: "Navigate to the workspace home page or a table in the current workspace.",
    parameters: schema({
      type: { type: "string", enum: ["workspace", "database-table"] },
      table_id: { type: "integer" },
    }, ["type"]),
    execute: async (input) => {
      const type = requiredString(input.type, "type");
      if (type === "workspace") {
        const location: AssistantNavigation = { type: "workspace" };
        await context.navigate(location);
        return { location };
      }
      if (type !== "database-table") throw new Error(`Unsupported navigation type: ${type}`);
      const table = await tableDetails(context, requiredId(input.table_id, "table_id"));
      return { location: await navigateToTable(context, table) };
    },
  };

  const listBuilders: GenerativeAITool = {
    name: "list_builders",
    description: "List databases, application builders, automations and dashboards in the current workspace.",
    parameters: schema({
      builder_types: {
        type: "array",
        items: { type: "string", enum: ["database", "application", "automation", "dashboard"] },
      },
    }),
    execute: async (input) => {
      const requested = new Set(stringArray(input.builder_types));
      const applications = await workspaceApplications(context);
      const grouped: Record<string, JsonObject[]> = {};
      for (const application of applications) {
        const type = serializedToolType(application.type);
        if (requested.size > 0 && !requested.has(type)) continue;
        grouped[type] ||= [];
        grouped[type].push({ id: Number(application.id), name: String(application.name), type });
      }
      return Object.keys(grouped).length > 0 ? grouped : "no builders found";
    },
  };

  const createBuilders: GenerativeAITool = {
    name: "create_builders",
    description: "Create one or more databases, application builders, automations or dashboards in the current workspace.",
    parameters: schema({
      builders: {
        type: "array",
        minItems: 1,
        items: schema({
          name: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["database", "application", "automation", "dashboard"] },
        }, ["name", "type"]),
      },
    }, ["builders"]),
    execute: async (input) => {
      const builders = arrayValue(input.builders);
      if (builders.length === 0) throw new Error("builders must not be empty.");
      const created = [];
      for (const builder of builders) {
        const type = applicationToolType(builder.type);
        const application = await internalApi(context, "POST", `/applications/workspace/${context.workspaceId}/`, {
          name: requiredString(builder.name, "builder.name"),
          type,
        });
        created.push({ id: Number(application.id), name: String(application.name), type: serializedToolType(application.type) });
      }
      return { created_builders: created };
    },
  };

  const listTables: GenerativeAITool = {
    name: "list_tables",
    description: "List accessible tables. Call this before creating tables or linking existing tables.",
    parameters: schema({
      database_ids: { type: "array", items: { type: "integer" } },
      database_names: { type: "array", items: { type: "string" } },
      table_ids: { type: "array", items: { type: "integer" } },
      table_names: { type: "array", items: { type: "string" } },
    }),
    execute: async (input) => {
      const databaseIds = new Set(numberArray(input.database_ids));
      const databaseNames = new Set(stringArray(input.database_names));
      const tableIds = new Set(numberArray(input.table_ids));
      const tableNames = new Set(stringArray(input.table_names));
      const applications = (await workspaceApplications(context)).filter((application: any) => application.type === "database");
      const databases = [];
      for (const application of applications) {
        if (databaseIds.size > 0 && !databaseIds.has(Number(application.id))) continue;
        if (databaseNames.size > 0 && !databaseNames.has(String(application.name))) continue;
        const tables = (await internalApi(context, "GET", `/database/tables/database/${application.id}/`))
          .filter((table: any) => tableIds.size === 0 || tableIds.has(Number(table.id)))
          .filter((table: any) => tableNames.size === 0 || tableNames.has(String(table.name)))
          .map((table: any) => ({ id: Number(table.id), name: String(table.name), database_id: Number(application.id) }));
        if (tables.length > 0) databases.push({ id: Number(application.id), name: String(application.name), tables });
      }
      if (databases.length === 0) return "No tables found";
      return databases.length === 1 ? databases[0].tables : databases;
    },
  };

  const getTablesSchema: GenerativeAITool = {
    name: "get_tables_schema",
    description: "Inspect table names, primary fields, relationships and optionally every field.",
    parameters: schema({
      table_ids: { type: "array", minItems: 1, items: { type: "integer" } },
      full_schema: { type: "boolean" },
    }, ["table_ids", "full_schema"]),
    execute: async (input) => {
      const tablesSchema = [];
      for (const tableId of numberArray(input.table_ids)) {
        const table = await tableDetails(context, tableId);
        const fields = await tableFields(context, tableId);
        const selectedFields = input.full_schema === true
          ? fields
          : fields.filter((field: any) => field.primary || field.type === "link_row");
        tablesSchema.push({
          id: Number(table.id),
          name: String(table.name),
          database_id: Number(table.database_id),
          fields: selectedFields.map((field: any) => ({
            id: Number(field.id),
            name: String(field.name),
            type: String(field.type),
            primary: Boolean(field.primary),
            ...(field.link_row_table_id ? { linked_table: Number(field.link_row_table_id) } : {}),
          })),
        });
      }
      return { tables_schema: tablesSchema };
    },
  };

  const createFields: GenerativeAITool = {
    name: "create_fields",
    description: "Add fields to an existing table after inspecting its schema.",
    parameters: schema({
      table_id: { type: "integer" },
      fields: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } },
    }, ["table_id", "fields"]),
    execute: async (input) => {
      const tableId = requiredId(input.table_id, "table_id");
      const created = [];
      for (const field of arrayValue(input.fields)) {
        created.push(await internalApi(
          context,
          "POST",
          `/database/fields/table/${tableId}/`,
          await fieldCreateBodyForTable(context, tableId, field),
        ));
      }
      return { created_fields: created };
    },
  };

  const createTables: GenerativeAITool = {
    name: "create_tables",
    description: "Create tables with a primary field, additional fields and optional realistic sample rows.",
    parameters: schema({
      database_id: { type: "integer" },
      tables: {
        type: "array",
        minItems: 1,
        items: schema({
          name: { type: "string" },
          primary_field: { type: "object", additionalProperties: true },
          fields: { type: "array", items: { type: "object", additionalProperties: true } },
          sample_rows: { type: "array", items: { type: "object", additionalProperties: true } },
        }, ["name", "primary_field", "fields"]),
      },
      add_sample_rows: { type: "boolean" },
    }, ["database_id", "tables"]),
    execute: async (input) => {
      const databaseId = requiredId(input.database_id, "database_id");
      const createdTables = [];
      let lastTable: JsonObject | null = null;
      for (const requestedTable of arrayValue(input.tables)) {
        let table = await internalApi(context, "POST", `/database/tables/database/${databaseId}/`, {
          name: requiredString(requestedTable.name, "table.name"),
        });
        const fields = await tableFields(context, Number(table.id));
        const primary = fields.find((field: any) => field.primary);
        const requestedPrimary = objectValue(requestedTable.primary_field);
        if (primary && Object.keys(requestedPrimary).length > 0) {
          await internalApi(context, "PATCH", `/database/fields/${primary.id}/`, fieldCreateBody(requestedPrimary));
        }
        for (const field of arrayValue(requestedTable.fields)) {
          await internalApi(
            context,
            "POST",
            `/database/fields/table/${table.id}/`,
            await fieldCreateBodyForTable(context, Number(table.id), field),
          );
        }
        if (input.add_sample_rows !== false) {
          for (const row of arrayValue(requestedTable.sample_rows)) {
            await internalApi(context, "POST", `/database/rows/table/${table.id}/?user_field_names=true`, row);
          }
        }
        table = await tableDetails(context, Number(table.id));
        createdTables.push({ id: Number(table.id), name: String(table.name) });
        lastTable = table;
      }
      if (lastTable) await navigateToTable(context, lastTable);
      return { created_tables: createdTables };
    },
  };

  const listRows: GenerativeAITool = {
    name: "list_rows",
    description: "List rows in a table with field names and bounded pagination.",
    parameters: schema({
      table_id: { type: "integer" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      field_ids: { type: "array", items: { type: "integer" } },
    }, ["table_id"]),
    execute: async (input) => {
      const tableId = requiredId(input.table_id, "table_id");
      const offset = Math.max(0, Number(input.offset || 0));
      const limit = Math.min(200, Math.max(1, Number(input.limit || 20)));
      const response = await internalApi(context, "GET", `/database/rows/table/${tableId}/?user_field_names=true&size=${Math.min(1000, offset + limit)}`);
      let rows = response.results.slice(offset, offset + limit);
      const fieldIds = numberArray(input.field_ids);
      if (fieldIds.length > 0) {
        const fields = await tableFields(context, tableId);
        const names = new Set(fields.filter((field: any) => fieldIds.includes(Number(field.id))).map((field: any) => String(field.name)));
        rows = rows.map((row: JsonObject) => Object.fromEntries(Object.entries(row).filter(([key]) => key === "id" || names.has(key))));
      }
      return { rows, total: Number(response.count || 0) };
    },
  };

  const createRows: GenerativeAITool = {
    name: "create_rows",
    description: "Create rows in a table using field names as keys.",
    parameters: schema({
      table_id: { type: "integer" },
      rows: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } },
    }, ["table_id", "rows"]),
    execute: async (input) => {
      const tableId = requiredId(input.table_id, "table_id");
      const created = [];
      for (const row of arrayValue(input.rows)) {
        created.push(await internalApi(context, "POST", `/database/rows/table/${tableId}/?user_field_names=true`, row));
      }
      return { created_rows: created };
    },
  };

  const updateRows: GenerativeAITool = {
    name: "update_rows",
    description: "Update rows by ID using field names as keys.",
    parameters: schema({
      table_id: { type: "integer" },
      rows: { type: "array", minItems: 1, items: { type: "object", required: ["id"], additionalProperties: true } },
    }, ["table_id", "rows"]),
    execute: async (input) => {
      const tableId = requiredId(input.table_id, "table_id");
      const updated = [];
      for (const row of arrayValue(input.rows)) {
        const rowId = requiredId(row.id, "row.id");
        const values = { ...row };
        delete values.id;
        updated.push(await internalApi(context, "PATCH", `/database/rows/table/${tableId}/${rowId}/?user_field_names=true`, values));
      }
      return { updated_rows: updated };
    },
  };

  const deleteRows: GenerativeAITool = {
    name: "delete_rows",
    description: "Move rows to trash by their IDs.",
    parameters: schema({
      table_id: { type: "integer" },
      row_ids: { type: "array", minItems: 1, items: { type: "integer" } },
    }, ["table_id", "row_ids"]),
    execute: async (input) => {
      const tableId = requiredId(input.table_id, "table_id");
      const deleted = [];
      for (const rowId of numberArray(input.row_ids)) {
        await internalApi(context, "DELETE", `/database/rows/table/${tableId}/${rowId}/`);
        deleted.push(rowId);
      }
      return { deleted_row_ids: deleted };
    },
  };

  const listViews: GenerativeAITool = {
    name: "list_views",
    description: "List views in a table before creating new views.",
    parameters: schema({ table_id: { type: "integer" } }, ["table_id"]),
    execute: async (input) => ({
      views: await internalApi(context, "GET", `/database/views/table/${requiredId(input.table_id, "table_id")}/`),
    }),
  };

  const createViews: GenerativeAITool = {
    name: "create_views",
    description: "Create grid, gallery, form, survey, kanban, calendar or timeline views in a table.",
    parameters: schema({
      table_id: { type: "integer" },
      views: { type: "array", minItems: 1, items: { type: "object", required: ["name", "type"], additionalProperties: true } },
    }, ["table_id", "views"]),
    execute: async (input) => {
      const tableId = requiredId(input.table_id, "table_id");
      const table = await tableDetails(context, tableId);
      const created = [];
      for (const viewInput of arrayValue(input.views)) {
        const view = await internalApi(context, "POST", `/database/views/table/${tableId}/`, {
          name: requiredString(viewInput.name, "view.name"),
          type: requiredString(viewInput.type, "view.type"),
        });
        const { settings, fieldOptions } = viewCreateSettings(viewInput);
        let updated = view;
        if (Object.keys(settings).length > 0) {
          updated = await internalApi(context, "PATCH", `/database/views/${view.id}/`, settings);
        }
        if (fieldOptions.length > 0) {
          const options = Object.fromEntries(fieldOptions.map((option) => [
            requiredId(option.field_id, "field_options.field_id"),
            {
              name: String(option.name || ""),
              description: String(option.description || ""),
              enabled: true,
              required: option.required !== false,
              order: Number(option.order || 0),
            },
          ]));
          await internalApi(context, "PATCH", `/database/views/${view.id}/field-options/`, { field_options: options });
          const [viewDetails, viewFieldOptions] = await Promise.all([
            internalApi(context, "GET", `/database/views/${view.id}/`),
            internalApi(context, "GET", `/database/views/${view.id}/field-options/`),
          ]);
          updated = { ...viewDetails, field_options: viewFieldOptions.field_options };
        }
        created.push(updated);
      }
      const first = created[0];
      if (first) {
        await context.navigate({
          type: "database-view",
          database_id: Number(table.database_id),
          table_id: tableId,
          view_id: Number(first.id),
          view_name: String(first.name),
          view_type: String(first.type),
        });
      }
      return { created_views: created };
    },
  };

  const createViewFilters: GenerativeAITool = {
    name: "create_view_filters",
    description: "Create field filters in one or more existing views.",
    parameters: schema({
      view_filters: {
        type: "array",
        minItems: 1,
        items: schema({
          view_id: { type: "integer" },
          filters: { type: "array", items: { type: "object", additionalProperties: true } },
        }, ["view_id", "filters"]),
      },
    }, ["view_filters"]),
    execute: async (input) => {
      const created = [];
      for (const viewFilter of arrayValue(input.view_filters)) {
        const viewId = requiredId(viewFilter.view_id, "view_id");
        const filters = [];
        for (const filter of arrayValue(viewFilter.filters)) {
          filters.push(await internalApi(
            context,
            "POST",
            `/database/views/${viewId}/filters/`,
            await sourceViewFilterBody(context, viewId, filter),
          ));
        }
        created.push({ view_id: viewId, filters });
      }
      return { created_view_filters: created };
    },
  };

  const generateFormula: GenerativeAITool = {
    name: "generate_database_formula",
    description: "Generate and validate a Supertask formula from a description, then optionally create or update its formula field.",
    parameters: schema({
      database_id: { type: "integer" },
      description: { type: "string" },
      save_to_field: { type: "boolean" },
      table_id: { type: "integer" },
      field_name: { type: "string" },
      formula: { type: "string" },
    }, ["database_id", "description"]),
    execute: async (input) => {
      const databaseId = requiredId(input.database_id, "database_id");
      const description = requiredString(input.description, "description");
      let tableId = Number(input.table_id || 0);
      let fieldName = String(input.field_name || "").trim();
      let formula = String(input.formula || "").trim();
      let typeResult: any = null;
      if (!formula || !tableId || !fieldName) {
        if (!context.generateText) throw new Error("Formula generation is unavailable for this assistant provider.");
        const tables = await internalApi(context, "GET", `/database/tables/database/${databaseId}/`);
        const schemas = [];
        for (const table of tables) {
          schemas.push({
            table: { id: Number(table.id), name: String(table.name) },
            fields: (await tableFields(context, Number(table.id))).map((field: any) => ({
              id: Number(field.id),
              name: String(field.name),
              type: String(field.type),
              primary: Boolean(field.primary),
            })),
          });
        }
        let validationError = "";
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const generated = generatedFormulaPayload(await context.generateText([
            "Generate one valid Supertask formula for the requested behavior.",
            "Return only JSON with integer table_id, string field_name and string formula.",
            "Reference fields by name using field('Field name') and use only Supertask formula syntax.",
            `Description: ${description}`,
            `Database schema: ${JSON.stringify(schemas)}`,
            validationError ? `Previous validation error: ${validationError}` : "",
          ].filter(Boolean).join("\n\n")));
          tableId = Number(generated.table_id || 0);
          fieldName = String(generated.field_name || "").trim();
          formula = String(generated.formula || "").trim();
          if (!Number.isInteger(tableId) || !schemas.some((schema) => schema.table.id === tableId) || !fieldName || !formula) {
            validationError = "The response must select a table from the provided database and include field_name and formula.";
            continue;
          }
          typeResult = await internalApi(context, "POST", `/database/formula/${tableId}/type/`, {
            name: fieldName,
            formula,
          });
          if (!typeResult.formula_type_error && typeResult.formula_type !== "invalid") break;
          validationError = String(typeResult.formula_type_error || "unknown formula error");
          typeResult = null;
        }
        if (!typeResult) throw new Error(`Unable to generate a valid formula: ${validationError}`);
      } else {
        const table = await tableDetails(context, tableId);
        if (Number(table.database_id) !== databaseId) throw new Error(`Table ${tableId} does not belong to database ${databaseId}.`);
        typeResult = await internalApi(context, "POST", `/database/formula/${tableId}/type/`, {
          name: fieldName,
          formula,
        });
        if (typeResult.formula_type_error || typeResult.formula_type === "invalid") {
          throw new Error(`Invalid formula: ${typeResult.formula_type_error || "unknown formula error"}`);
        }
      }
      const result: JsonObject = { formula, formula_type: typeResult.formula_type };
      if (input.save_to_field !== false) {
        const fields = await tableFields(context, tableId);
        const existing = fields.find((field: any) => field.name === fieldName);
        let field;
        if (existing?.type === "formula") {
          field = await internalApi(context, "PATCH", `/database/fields/${existing.id}/`, { formula });
          result.operation = "field updated";
        } else {
          if (existing) await internalApi(context, "DELETE", `/database/fields/${existing.id}/`);
          field = await internalApi(context, "POST", `/database/fields/table/${tableId}/`, {
            name: fieldName,
            type: "formula",
            formula,
          });
          result.operation = "field created";
        }
        const table = await tableDetails(context, tableId);
        await navigateToTable(context, table);
        result.table_id = tableId;
        result.table_name = table.name;
        result.field_name = field.name;
      }
      return result;
    },
  };

  const listWorkflows: GenerativeAITool = {
    name: "list_workflows",
    description: "List workflows in an automation application.",
    parameters: schema({ automation_id: { type: "integer" } }, ["automation_id"]),
    execute: async (input) => ({
      workflows: await internalApi(context, "GET", `/automation/${requiredId(input.automation_id, "automation_id")}/workflows/`),
    }),
  };

  const createWorkflows: GenerativeAITool = {
    name: "create_workflows",
    description: "Create automation workflows with one trigger and connected action nodes. Node service objects use the same contracts as the automation editor.",
    parameters: schema({
      automation_id: { type: "integer" },
      workflows: {
        type: "array",
        minItems: 1,
        items: schema({
          name: { type: "string" },
          trigger: { type: "object", additionalProperties: true },
          nodes: { type: "array", items: { type: "object", additionalProperties: true } },
        }, ["name", "trigger", "nodes"]),
      },
    }, ["automation_id", "workflows"]),
    execute: async (input) => {
      const automationId = requiredId(input.automation_id, "automation_id");
      const created = [];
      for (const workflowInput of arrayValue(input.workflows)) {
        const workflow = await internalApi(context, "POST", `/automation/${automationId}/workflows/`, {
          name: requiredString(workflowInput.name, "workflow.name"),
        });
        try {
          const references = new Map<string, any>();
          const trigger = objectValue(workflowInput.trigger);
          const createdTrigger = await internalApi(context, "POST", `/automation/workflow/${workflow.id}/nodes/`, {
            type: nodeType(trigger.type),
            label: requiredString(trigger.label, "trigger.label"),
            service: nodeService(trigger, references),
          });
          references.set(String(trigger.ref || "trigger"), createdTrigger);
          let previousNode = createdTrigger;
          for (const node of arrayValue(workflowInput.nodes)) {
            const reference = String(node.previous_node_ref || "");
            const referenceNode = reference ? references.get(reference) : previousNode;
            if (!referenceNode) throw new Error(`Unknown previous_node_ref: ${reference}`);
            let output = String(node.output || "");
            if (String(referenceNode.type) === "router" && node.router_edge_label) {
              const edge = arrayValue(objectValue(referenceNode.service).edges)
                .find((candidate) => String(candidate.label) === String(node.router_edge_label));
              if (!edge) throw new Error(`Router branch '${String(node.router_edge_label)}' does not exist on ${reference}.`);
              output = String(edge.uid);
            }
            const createdNode = await internalApi(context, "POST", `/automation/workflow/${workflow.id}/nodes/`, {
              type: nodeType(node.type),
              label: requiredString(node.label, "node.label"),
              service: nodeService(node, references),
              reference_node_id: Number(referenceNode.id),
              position: String(node.position || "south"),
              output,
            });
            references.set(String(node.ref || createdNode.id), createdNode);
            previousNode = createdNode;
          }
        } catch (error) {
          await internalApi(context, "DELETE", `/automation/workflows/${workflow.id}/`).catch(() => undefined);
          throw error;
        }
        created.push({ id: Number(workflow.id), name: String(workflow.name), state: String(workflow.state) });
        await context.navigate({
          type: "automation-workflow",
          automation_id: automationId,
          workflow_id: Number(workflow.id),
          workflow_name: String(workflow.name),
        });
      }
      return { created_workflows: created };
    },
  };

  const tableAndFieldsFactory: GenerativeAITool = {
    name: "table_and_fields_tool_factory",
    description: "Load table and field creation capabilities for a database.",
    parameters: schema({}),
    execute: async () => ({
      available_tools: ["create_tables", "create_fields"],
      detail: "Table and field creation tools are available.",
    }),
  };

  const rowsFactory: GenerativeAITool = {
    name: "rows_tool_factory",
    description: "Load create, update and delete row capabilities for specified tables.",
    parameters: schema({
      table_ids: { type: "array", minItems: 1, items: { type: "integer" } },
      operations: {
        type: "array",
        minItems: 1,
        items: { type: "string", enum: ["create", "update", "delete"] },
      },
    }, ["table_ids", "operations"]),
    execute: async (input) => {
      const tables = [];
      for (const tableId of numberArray(input.table_ids)) {
        const table = await tableDetails(context, tableId);
        tables.push({ id: Number(table.id), name: String(table.name) });
      }
      const operations = stringArray(input.operations);
      return {
        tables,
        available_tools: operations.map((operation) => `${operation}_rows`),
      };
    },
  };

  const viewsFactory: GenerativeAITool = {
    name: "views_tool_factory",
    description: "Load view and view-filter creation capabilities.",
    parameters: schema({}),
    execute: async () => ({
      available_tools: ["create_views", "create_view_filters"],
      detail: "View and filter creation tools are available.",
    }),
  };

  const workflowFactory: GenerativeAITool = {
    name: "workflow_tool_factory",
    description: "Load workflow creation capabilities for automation applications.",
    parameters: schema({}),
    execute: async () => ({
      available_tools: ["create_workflows"],
      detail: "Workflow creation tools are available.",
    }),
  };

  const tools = [
    navigation,
    listBuilders,
    createBuilders,
    listTables,
    getTablesSchema,
    tableAndFieldsFactory,
    createTables,
    createFields,
    listRows,
    rowsFactory,
    createRows,
    updateRows,
    deleteRows,
    listViews,
    viewsFactory,
    createViews,
    createViewFilters,
    generateFormula,
    listWorkflows,
    workflowFactory,
    createWorkflows,
  ];
  if (context.env.AI && context.env.KNOWLEDGE_BASE) {
    tools.unshift({
      name: "search_user_docs",
      description: "Search the official Supertask user documentation for feature explanations and user guides.",
      parameters: schema({
        question: {
          type: "string",
          minLength: 3,
          description: "A precise English question using Supertask terminology.",
        },
      }, ["question"]),
      execute: async (input) => {
        const result = await searchAssistantKnowledge(context.env, requiredString(input.question, "question"), 15);
        const reliabilityNote = result.reliability >= 0.7
          ? "HIGH CONFIDENCE: The answer is well supported by the documentation."
          : result.reliability >= 0.4
            ? "PARTIAL MATCH: The documentation may not fully cover this topic."
            : "LOW CONFIDENCE: Explain that the official documentation did not provide a reliable answer.";
        return { ...result, reliability_note: reliabilityNote };
      },
    });
  }
  return tools;
}
