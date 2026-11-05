import type { D1Database } from "@cloudflare/workers-types";
import { DoesNotExist, ValidationError } from "../middleware/error";
import {
  contextDataForDataSource,
  contextDataSchemaForDataSource,
  dispatchDataSource,
  schemaForDataSource,
  schemaForTable,
} from "./builder";
import { createIntegration } from "./application-extras";
import { serializeDatabaseFieldRow } from "./field-serialization";
import type { FieldType } from "./dynamic-tables";

type JsonObject = Record<string, unknown>;

type DashboardDataSourceRow = {
  id: number;
  dashboard_id: number;
  type: string;
  name: string;
  order: string | number;
  service: string;
};

type DashboardFieldRow = {
  id: number;
  table_id: number;
  name: string;
  type: FieldType;
  order: number;
  is_primary: number;
  read_only: number;
  description: string | null;
  db_index: number;
  immutable_type: number;
  immutable_properties: number;
  field_settings: string | null;
};

type AggregationSeries = {
  id?: number;
  field_id: number | null;
  aggregation_type: string;
};

type AggregationGroupBy = {
  field_id: number | null;
};

type AggregationSort = {
  sort_on: "SERIES" | "GROUP_BY" | "PRIMARY";
  reference: string;
  direction: "ASC" | "DESC";
};

const DASHBOARD_SERVICE_TYPES = new Set([
  "local_baserow_aggregate_rows",
  "local_baserow_grouped_aggregate_rows",
]);

const DASHBOARD_SERVICE_FIELDS = new Set([
  "type",
  "name",
  "integration_id",
  "table_id",
  "view_id",
  "field_id",
  "aggregation_type",
  "aggregation_series",
  "aggregation_group_bys",
  "aggregation_sorts",
  "filters",
  "filter_type",
  "search_query",
]);

const GROUP_BY_FIELD_TYPES = new Set<FieldType>([
  "text",
  "long_text",
  "number",
  "url",
  "rating",
  "boolean",
  "email",
  "single_select",
  "phone_number",
  "autonumber",
  "auto_number",
]);

const NUMERIC_AGGREGATION_FIELD_TYPES = new Set<FieldType>([
  "number",
  "rating",
  "duration",
  "formula",
  "rollup",
  "count",
  "autonumber",
  "auto_number",
]);

const DATE_AGGREGATION_FIELD_TYPES = new Set<FieldType>([
  "date",
  "created_on",
  "last_modified",
]);

const BOOLEAN_AGGREGATION_FIELD_TYPES = new Set<FieldType>([
  "boolean",
  "formula",
]);

const COMMON_AGGREGATIONS = new Set([
  "count",
  "empty_count",
  "not_empty_count",
  "empty_percentage",
  "not_empty_percentage",
]);

const NUMERIC_AGGREGATIONS = new Set([
  "sum",
  "average",
  "std_dev",
  "variance",
  "median",
]);

const BOOLEAN_AGGREGATIONS = new Set([
  "checked_count",
  "not_checked_count",
  "checked_percentage",
  "not_checked_percentage",
]);

const UNIQUE_COUNT_FIELD_TYPES = new Set<FieldType>([
  "text",
  "long_text",
  "url",
  "number",
  "rating",
  "date",
  "created_on",
  "last_modified",
  "created_by",
  "last_modified_by",
  "email",
  "phone_number",
  "single_select",
  "duration",
  "formula",
  "autonumber",
  "auto_number",
]);

function nowIso() {
  return new Date().toISOString();
}

export function parseDashboardService(value: string | null | undefined): JsonObject {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function defaultServiceConfiguration(type: string, integrationId: number): JsonObject {
  const common: JsonObject = {
    integration_id: integrationId,
    table_id: null,
    view_id: null,
    filters: [],
    filter_type: "AND",
    sample_data: null,
  };
  if (type === "local_baserow_grouped_aggregate_rows") return common;
  return {
    ...common,
    field_id: null,
    aggregation_type: "",
    search_query: { formula: "", mode: "simple", version: "0.1" },
  };
}

export function dashboardServiceTypeForWidget(widgetType: string) {
  if (widgetType === "summary") return "local_baserow_aggregate_rows";
  if (widgetType === "chart" || widgetType === "pie_chart") {
    return "local_baserow_grouped_aggregate_rows";
  }
  throw new ValidationError(`The widget type '${widgetType}' does not exist.`);
}

export async function ensureDashboardDefaults(db: D1Database, dashboardId: number) {
  const dashboard = await db.prepare(
    "SELECT id FROM core_application WHERE id=? AND type='dashboard' AND trashed=0"
  ).bind(dashboardId).first<{ id: number }>();
  if (!dashboard) throw new DoesNotExist("Dashboard", dashboardId);

  let integration = await db.prepare(
    "SELECT * FROM core_integration WHERE application_id=? AND type='local_baserow' ORDER BY CAST([order] AS REAL), id LIMIT 1"
  ).bind(dashboardId).first<any>();
  if (!integration) {
    await createIntegration(db, dashboardId, {
      type: "local_baserow",
      name: "Local Baserow",
    });
    integration = await db.prepare(
      "SELECT * FROM core_integration WHERE application_id=? AND type='local_baserow' ORDER BY CAST([order] AS REAL), id LIMIT 1"
    ).bind(dashboardId).first<any>();
  }
  if (!integration) throw new Error("Failed to create the dashboard integration.");
  return integration;
}

async function unusedDataSourceName(db: D1Database, dashboardId: number, proposedName: string) {
  const names = await db.prepare(
    "SELECT name FROM supertask_dashboard_data_source WHERE dashboard_id=?"
  ).bind(dashboardId).all<{ name: string }>();
  const existing = new Set((names.results || []).map((row) => row.name));
  if (!existing.has(proposedName)) return proposedName;
  let suffix = 2;
  while (existing.has(`${proposedName} ${suffix}`)) suffix += 1;
  return `${proposedName} ${suffix}`;
}

export async function createDashboardDataSource(
  db: D1Database,
  dashboardId: number,
  widgetType: string
) {
  const integration = await ensureDashboardDefaults(db, dashboardId);
  const type = dashboardServiceTypeForWidget(widgetType);
  const name = await unusedDataSourceName(db, dashboardId, "WidgetDataSource");
  const maxOrder = await db.prepare(
    "SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM supertask_dashboard_data_source WHERE dashboard_id=?"
  ).bind(dashboardId).first<{ max_order: number }>();
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO supertask_dashboard_data_source
     (dashboard_id, type, name, [order], service, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  ).bind(
    dashboardId,
    type,
    name,
    String(Number(maxOrder?.max_order || 0) + 1),
    JSON.stringify(defaultServiceConfiguration(type, Number(integration.id))),
    now,
    now
  ).first<DashboardDataSourceRow>();
  if (!row) throw new Error("Failed to create the dashboard data source.");
  return row;
}

async function aggregationRelations(db: D1Database, dataSourceId: number) {
  const [series, groupBys, sorts] = await Promise.all([
    db.prepare(
      `SELECT id, field_id, aggregation_type
       FROM supertask_dashboard_aggregation_series
       WHERE data_source_id=? ORDER BY [order], id`
    ).bind(dataSourceId).all<any>(),
    db.prepare(
      `SELECT [order], field_id
       FROM supertask_dashboard_aggregation_group_by
       WHERE data_source_id=? ORDER BY [order], id`
    ).bind(dataSourceId).all<any>(),
    db.prepare(
      `SELECT [order], sort_on, reference, direction
       FROM supertask_dashboard_aggregation_sort
       WHERE data_source_id=? ORDER BY [order], id`
    ).bind(dataSourceId).all<any>(),
  ]);
  return {
    aggregation_series: series.results || [],
    aggregation_group_bys: groupBys.results || [],
    aggregation_sorts: sorts.results || [],
  };
}

async function fieldForDataSource(db: D1Database, fieldId: number) {
  return db.prepare(
    `SELECT id, table_id, name, type, [order], "primary" AS is_primary, read_only,
            description, db_index, immutable_type, immutable_properties, field_settings
     FROM database_field WHERE id=? AND trashed=0`
  ).bind(fieldId).first<DashboardFieldRow>();
}

async function groupedContextData(
  db: D1Database,
  tableId: number,
  groupBys: Array<{ field_id: number | null }>
) {
  const fields: JsonObject = {};
  for (const groupBy of groupBys) {
    const field = groupBy.field_id
      ? await fieldForDataSource(db, Number(groupBy.field_id))
      : await db.prepare(
        `SELECT id, table_id, name, type, [order], "primary" AS is_primary, read_only,
                description, db_index, immutable_type, immutable_properties, field_settings
         FROM database_field
         WHERE table_id=? AND trashed=0
         ORDER BY "primary" DESC, [order], id LIMIT 1`
      ).bind(tableId).first<DashboardFieldRow>();
    if (field) fields[`field_${field.id}`] = await serializeDatabaseFieldRow(db, field);
  }
  return { fields };
}

export async function serializeDashboardDataSource(db: D1Database, row: DashboardDataSourceRow) {
  const service = parseDashboardService(row.service);
  const tableId = Number(service.table_id || 0);
  const base: JsonObject = {
    ...service,
    id: row.id,
    integration_id: service.integration_id ?? null,
    type: row.type,
    schema: null,
    context_data: {},
    context_data_schema: null,
    sample_data: service.sample_data ?? null,
    name: row.name || "",
    dashboard_id: row.dashboard_id,
    order: String(row.order),
  };

  if (row.type === "local_baserow_grouped_aggregate_rows") {
    const relations = await aggregationRelations(db, row.id);
    Object.assign(base, relations);
    if (tableId) {
      const tableSchema = await schemaForTable(db, tableId);
      base.schema = { ...tableSchema, title: `GroupedAggregation${row.id}Schema` };
      base.context_data = await groupedContextData(db, tableId, relations.aggregation_group_bys);
    }
  } else if (tableId) {
    base.schema = await schemaForDataSource(db, tableId, row.type, service);
    base.context_data = await contextDataForDataSource(db, tableId, row.type, service);
    base.context_data_schema = await contextDataSchemaForDataSource(db, tableId, row.type);
  }

  return base;
}

async function dashboardWorkspaceId(db: D1Database, dashboardId: number) {
  const dashboard = await db.prepare(
    "SELECT workspace_id FROM core_application WHERE id=? AND type='dashboard' AND trashed=0"
  ).bind(dashboardId).first<{ workspace_id: number }>();
  if (!dashboard) throw new DoesNotExist("Dashboard", dashboardId);
  return Number(dashboard.workspace_id);
}

async function validateTable(db: D1Database, dashboardId: number, tableId: number) {
  const workspaceId = await dashboardWorkspaceId(db, dashboardId);
  const table = await db.prepare(
    `SELECT t.id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=? AND t.trashed=0 AND a.trashed=0 AND a.type='database' AND a.workspace_id=?`
  ).bind(tableId, workspaceId).first<{ id: number }>();
  if (!table) throw new ValidationError(`The table with ID ${tableId} does not exist.`);
}

async function validateView(db: D1Database, tableId: number, viewId: number) {
  const view = await db.prepare(
    "SELECT id FROM database_view WHERE id=? AND table_id=? AND trashed=0"
  ).bind(viewId, tableId).first<{ id: number }>();
  if (!view) throw new ValidationError(`The view with ID ${viewId} is not related to the given table ${tableId}.`);
}

function isAggregationCompatible(fieldType: FieldType, aggregationType: string, grouped: boolean) {
  if (COMMON_AGGREGATIONS.has(aggregationType)) return true;
  if (BOOLEAN_AGGREGATIONS.has(aggregationType)) return BOOLEAN_AGGREGATION_FIELD_TYPES.has(fieldType);
  if (aggregationType === "unique_count") return UNIQUE_COUNT_FIELD_TYPES.has(fieldType);
  if (aggregationType === "min" || aggregationType === "max") {
    return NUMERIC_AGGREGATION_FIELD_TYPES.has(fieldType) || (!grouped && DATE_AGGREGATION_FIELD_TYPES.has(fieldType));
  }
  if (NUMERIC_AGGREGATIONS.has(aggregationType)) return NUMERIC_AGGREGATION_FIELD_TYPES.has(fieldType);
  return false;
}

async function validateAggregationField(
  db: D1Database,
  tableId: number,
  fieldId: number,
  aggregationType: string,
  grouped: boolean
) {
  const field = await fieldForDataSource(db, fieldId);
  if (!field || Number(field.table_id) !== tableId) {
    throw new ValidationError(`The field with ID ${fieldId} is not related to the given table.`);
  }
  if (aggregationType && !isAggregationCompatible(field.type, aggregationType, grouped)) {
    throw new ValidationError(`The field with ID ${fieldId} is not compatible with aggregation type ${aggregationType}.`);
  }
  return field;
}

function normalizeSeries(value: unknown): AggregationSeries[] {
  if (!Array.isArray(value)) throw new ValidationError("The aggregation_series value must be a list.");
  if (value.length > 3) throw new ValidationError("The number of series exceeds the maximum allowed length of 3.");
  return value.map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : {};
    const fieldId = row.field_id === null || row.field_id === undefined ? null : Number(row.field_id);
    const id = row.id === null || row.id === undefined ? undefined : Number(row.id);
    if (fieldId !== null && (!Number.isInteger(fieldId) || fieldId <= 0)) {
      throw new ValidationError("The aggregation series field_id must be a positive integer or null.");
    }
    if (id !== undefined && (!Number.isInteger(id) || id <= 0)) {
      throw new ValidationError("The aggregation series id must be a positive integer.");
    }
    return { id, field_id: fieldId, aggregation_type: String(row.aggregation_type || "") };
  });
}

function normalizeGroupBys(value: unknown): AggregationGroupBy[] {
  if (!Array.isArray(value)) throw new ValidationError("The aggregation_group_bys value must be a list.");
  if (value.length > 1) throw new ValidationError("The number of group by fields exceeds the maximum allowed length of 1.");
  return value.map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : {};
    const fieldId = row.field_id === null || row.field_id === undefined ? null : Number(row.field_id);
    if (fieldId !== null && (!Number.isInteger(fieldId) || fieldId <= 0)) {
      throw new ValidationError("The aggregation group by field_id must be a positive integer or null.");
    }
    return { field_id: fieldId };
  });
}

function normalizeSorts(value: unknown): AggregationSort[] {
  if (!Array.isArray(value)) throw new ValidationError("The aggregation_sorts value must be a list.");
  return value.map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : {};
    const sortOn = String(row.sort_on || "").toUpperCase();
    const direction = String(row.direction || "").toUpperCase();
    const reference = String(row.reference || "");
    if (!["SERIES", "GROUP_BY", "PRIMARY"].includes(sortOn)) {
      throw new ValidationError(`The sort_on value '${sortOn}' is invalid.`);
    }
    if (!["ASC", "DESC"].includes(direction)) {
      throw new ValidationError(`The sort direction '${direction}' is invalid.`);
    }
    if (!/^field_\d+(?:_[a-z_]+)?$/.test(reference)) {
      throw new ValidationError(`The sort reference '${reference}' is invalid.`);
    }
    return {
      sort_on: sortOn as AggregationSort["sort_on"],
      reference,
      direction: direction as AggregationSort["direction"],
    };
  });
}

async function validateGroupedConfiguration(
  db: D1Database,
  dataSourceId: number,
  tableId: number,
  series: AggregationSeries[],
  groupBys: AggregationGroupBy[],
  sorts: AggregationSort[]
) {
  const existing = await db.prepare(
    "SELECT id FROM supertask_dashboard_aggregation_series WHERE data_source_id=?"
  ).bind(dataSourceId).all<{ id: number }>();
  const existingIds = new Set((existing.results || []).map((row) => Number(row.id)));
  const usedIds = new Set<number>();
  const usedSeries = new Set<string>();
  for (const item of series) {
    if (item.id !== undefined) {
      if (!existingIds.has(item.id)) throw new ValidationError(`The series with id ${item.id} does not exist.`);
      if (usedIds.has(item.id)) throw new ValidationError(`The series with id ${item.id} can only be defined once.`);
      usedIds.add(item.id);
    }
    if (item.field_id !== null) {
      await validateAggregationField(db, tableId, item.field_id, item.aggregation_type, true);
    } else if (item.aggregation_type) {
      throw new ValidationError("The aggregation series field has to be set.");
    }
    if (item.field_id !== null && item.aggregation_type) {
      const reference = `field_${item.field_id}_${item.aggregation_type}`;
      if (usedSeries.has(reference)) {
        throw new ValidationError(
          `The series with the field ID ${item.field_id} and aggregation type ${item.aggregation_type} can only be defined once.`
        );
      }
      usedSeries.add(reference);
    }
  }

  let groupReference: string | null = null;
  for (const groupBy of groupBys) {
    const field = groupBy.field_id === null
      ? await db.prepare(
        `SELECT id, table_id, name, type, [order], "primary" AS is_primary, read_only,
                description, db_index, immutable_type, immutable_properties, field_settings
         FROM database_field WHERE table_id=? AND trashed=0
         ORDER BY "primary" DESC, [order], id LIMIT 1`
      ).bind(tableId).first<DashboardFieldRow>()
      : await fieldForDataSource(db, groupBy.field_id);
    if (!field || Number(field.table_id) !== tableId) {
      throw new ValidationError(`The field with ID ${groupBy.field_id} is not related to the given table.`);
    }
    if (!GROUP_BY_FIELD_TYPES.has(field.type)) {
      throw new ValidationError(`The field with ID ${field.id} cannot be used as a group by field.`);
    }
    groupReference = `field_${field.id}`;
  }

  const allowedReferences = new Set([...usedSeries, ...(groupReference ? [groupReference] : [])]);
  for (const sort of sorts) {
    if (!allowedReferences.has(sort.reference)) {
      throw new ValidationError(`The reference sort '${sort.reference}' cannot be used for sorting.`);
    }
  }
}

function relationSyncStatements(
  db: D1Database,
  dataSourceId: number,
  series: AggregationSeries[] | null,
  groupBys: AggregationGroupBy[] | null,
  sorts: AggregationSort[] | null
) {
  const statements: any[] = [];
  if (series !== null) {
    const ids = series.flatMap((item) => item.id === undefined ? [] : [item.id]);
    if (ids.length === 0) {
      statements.push(db.prepare("DELETE FROM supertask_dashboard_aggregation_series WHERE data_source_id=?").bind(dataSourceId));
    } else {
      statements.push(db.prepare(
        `DELETE FROM supertask_dashboard_aggregation_series
         WHERE data_source_id=? AND id NOT IN (${ids.map(() => "?").join(",")})`
      ).bind(dataSourceId, ...ids));
    }
    series.forEach((item, index) => {
      if (item.id !== undefined) {
        statements.push(db.prepare(
          `UPDATE supertask_dashboard_aggregation_series
           SET field_id=?, aggregation_type=?, [order]=?
           WHERE id=? AND data_source_id=?`
        ).bind(item.field_id, item.aggregation_type, index + 1, item.id, dataSourceId));
      } else {
        statements.push(db.prepare(
          `INSERT INTO supertask_dashboard_aggregation_series
           (data_source_id, field_id, aggregation_type, [order]) VALUES (?, ?, ?, ?)`
        ).bind(dataSourceId, item.field_id, item.aggregation_type, index + 1));
      }
    });
  }
  if (groupBys !== null) {
    statements.push(db.prepare("DELETE FROM supertask_dashboard_aggregation_group_by WHERE data_source_id=?").bind(dataSourceId));
    groupBys.forEach((item, index) => {
      statements.push(db.prepare(
        `INSERT INTO supertask_dashboard_aggregation_group_by
         (data_source_id, field_id, [order]) VALUES (?, ?, ?)`
      ).bind(dataSourceId, item.field_id, index + 1));
    });
  }
  if (sorts !== null) {
    statements.push(db.prepare("DELETE FROM supertask_dashboard_aggregation_sort WHERE data_source_id=?").bind(dataSourceId));
    sorts.forEach((item, index) => {
      statements.push(db.prepare(
        `INSERT INTO supertask_dashboard_aggregation_sort
         (data_source_id, sort_on, reference, direction, [order]) VALUES (?, ?, ?, ?, ?)`
      ).bind(dataSourceId, item.sort_on, item.reference, item.direction, index + 1));
    });
  }
  return statements;
}

export async function updateDashboardDataSource(
  db: D1Database,
  existing: DashboardDataSourceRow,
  body: JsonObject
) {
  for (const key of Object.keys(body)) {
    if (!DASHBOARD_SERVICE_FIELDS.has(key)) throw new ValidationError(`The property '${key}' is not allowed.`);
  }
  if ("integration_id" in body) throw new ValidationError("The integration_id property cannot be changed.");
  if ("type" in body && String(body.type) !== existing.type) {
    throw new ValidationError("The service type cannot be changed.");
  }
  if (!DASHBOARD_SERVICE_TYPES.has(existing.type)) {
    throw new ValidationError(`The service type '${existing.type}' cannot be used by a dashboard.`);
  }

  const current = parseDashboardService(existing.service);
  const next: JsonObject = { ...current };
  const tableChanged = "table_id" in body && Number(body.table_id || 0) !== Number(current.table_id || 0);
  if (tableChanged) {
    next.view_id = null;
    next.field_id = null;
    next.aggregation_type = "";
    next.filters = [];
  }
  for (const [key, value] of Object.entries(body)) {
    if (!["type", "name", "aggregation_series", "aggregation_group_bys", "aggregation_sorts"].includes(key)) {
      next[key] = value;
    }
  }

  const tableId = Number(next.table_id || 0);
  if (tableId) await validateTable(db, existing.dashboard_id, tableId);
  if (Number(next.view_id || 0)) {
    if (!tableId) throw new ValidationError("A table ID is required alongside the view ID.");
    await validateView(db, tableId, Number(next.view_id));
  }

  let series: AggregationSeries[] | null = null;
  let groupBys: AggregationGroupBy[] | null = null;
  let sorts: AggregationSort[] | null = null;

  if (existing.type === "local_baserow_aggregate_rows") {
    const fieldId = Number(next.field_id || 0);
    const aggregationType = String(next.aggregation_type || "");
    if (fieldId) {
      if (!tableId) throw new ValidationError("A table ID is required alongside the field ID.");
      await validateAggregationField(db, tableId, fieldId, aggregationType, false);
    } else if (aggregationType) {
      throw new ValidationError("The field property is missing.");
    }
  } else {
    const currentRelations = await aggregationRelations(db, existing.id);
    series = "aggregation_series" in body
      ? normalizeSeries(body.aggregation_series)
      : tableChanged ? [] : currentRelations.aggregation_series as AggregationSeries[];
    groupBys = "aggregation_group_bys" in body
      ? normalizeGroupBys(body.aggregation_group_bys)
      : tableChanged ? [] : currentRelations.aggregation_group_bys as AggregationGroupBy[];
    sorts = "aggregation_sorts" in body
      ? normalizeSorts(body.aggregation_sorts)
      : tableChanged ? [] : currentRelations.aggregation_sorts as AggregationSort[];
    if (tableId) await validateGroupedConfiguration(db, existing.id, tableId, series, groupBys, sorts);
    else if (series.length || groupBys.length || sorts.length) {
      throw new ValidationError("A table ID is required for grouped aggregations.");
    }
    delete next.aggregation_series;
    delete next.aggregation_group_bys;
    delete next.aggregation_sorts;
  }

  const statements: any[] = [
    db.prepare(
      "UPDATE supertask_dashboard_data_source SET name=?, service=?, updated_on=? WHERE id=?"
    ).bind(String(body.name ?? existing.name ?? ""), JSON.stringify(next), nowIso(), existing.id),
    ...relationSyncStatements(db, existing.id, series, groupBys, sorts),
  ];
  await db.batch(statements);
  const updated = await db.prepare("SELECT * FROM supertask_dashboard_data_source WHERE id=?")
    .bind(existing.id).first<DashboardDataSourceRow>();
  if (!updated) throw new DoesNotExist("DashboardDataSource", existing.id);
  return serializeDashboardDataSource(db, updated);
}

export async function dispatchDashboardDataSource(db: D1Database, row: DashboardDataSourceRow) {
  const service = parseDashboardService(row.service);
  if (row.type === "local_baserow_grouped_aggregate_rows") {
    Object.assign(service, await aggregationRelations(db, row.id));
  }
  return dispatchDataSource(db, {
    type: row.type,
    configuration: JSON.stringify(service),
  });
}

export async function validateWidgetSeriesConfiguration(
  db: D1Database,
  widgetType: string,
  dataSourceId: number,
  value: unknown
) {
  if (!Array.isArray(value)) throw new ValidationError("The series_config value must be a list.");
  if (widgetType === "summary" && value.length > 0) {
    throw new ValidationError("Summary widgets cannot define chart series.");
  }
  const allowedChartTypes = widgetType === "pie_chart"
    ? new Set(["PIE", "DOUGHNUT"])
    : new Set(["BAR", "LINE"]);
  const available = await db.prepare(
    "SELECT id FROM supertask_dashboard_aggregation_series WHERE data_source_id=?"
  ).bind(dataSourceId).all<{ id: number }>();
  const availableIds = new Set((available.results || []).map((row) => Number(row.id)));
  const usedIds = new Set<number>();
  return value.map((item) => {
    const config = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : {};
    const seriesId = Number(config.series_id);
    const chartType = String(config.series_chart_type || "");
    if (!availableIds.has(seriesId)) throw new ValidationError("The series id cannot be used with the widget.");
    if (usedIds.has(seriesId)) throw new ValidationError("The series id cannot be repeated in the configuration.");
    if (!allowedChartTypes.has(chartType)) throw new ValidationError(`The chart type '${chartType}' is invalid.`);
    usedIds.add(seriesId);
    return { series_id: seriesId, series_chart_type: chartType };
  });
}
