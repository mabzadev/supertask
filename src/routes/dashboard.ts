import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { DoesNotExist, ValidationError } from "../middleware/error";
import { assertHasApplicationRole } from "../services/enterprise-permissions";
import {
  createDashboardDataSource,
  dispatchDashboardDataSource,
  parseDashboardService,
  serializeDashboardDataSource,
  updateDashboardDataSource,
  validateWidgetSeriesConfiguration,
} from "../services/dashboard";

const dashboard = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

async function requireDashboardAccess(db: D1Database, userId: number, dashboardId: number, requiredRole = "VIEWER") {
  const app = await db.prepare(
    `SELECT a.id, a.workspace_id
     FROM core_application a
     WHERE a.id=? AND a.type='dashboard' AND a.trashed=0`
  ).bind(dashboardId).first<any>();
  if (!app) throw new DoesNotExist("Dashboard", dashboardId);
  await assertHasApplicationRole(db, userId, dashboardId, requiredRole);
  return app;
}

async function requireWidgetAccess(db: D1Database, userId: number, widgetId: number, requiredRole = "VIEWER") {
  const widget = await db.prepare(
    `SELECT w.* FROM supertask_dashboard_widget w
     JOIN core_application a ON a.id=w.dashboard_id
     WHERE w.id=? AND a.type='dashboard' AND a.trashed=0`
  ).bind(widgetId).first<any>();
  if (!widget) throw new DoesNotExist("DashboardWidget", widgetId);
  await assertHasApplicationRole(db, userId, Number(widget.dashboard_id), requiredRole);
  return widget;
}

async function requireDataSourceAccess(db: D1Database, userId: number, dataSourceId: number, requiredRole = "VIEWER") {
  const dataSource = await db.prepare(
    `SELECT ds.* FROM supertask_dashboard_data_source ds
     JOIN core_application a ON a.id=ds.dashboard_id
     WHERE ds.id=? AND a.type='dashboard' AND a.trashed=0`
  ).bind(dataSourceId).first<any>();
  if (!dataSource) throw new DoesNotExist("DashboardDataSource", dataSourceId);
  await assertHasApplicationRole(db, userId, Number(dataSource.dashboard_id), requiredRole);
  return dataSource;
}

function serializeWidget(row: any) {
  const config = parseDashboardService(row.config);
  const serialized: Record<string, unknown> = {
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    dashboard_id: row.dashboard_id,
    type: row.type,
    order: row.order ?? 0,
    data_source_id: row.data_source_id ?? null,
  };
  if (row.type === "chart" || row.type === "pie_chart") {
    serialized.series_config = Array.isArray(config.series_config) ? config.series_config : [];
    serialized.default_series_chart_type = config.default_series_chart_type ?? (row.type === "pie_chart" ? "PIE" : "BAR");
  }
  return serialized;
}

dashboard.get("/:dashboardId/widgets/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dashboardId = Number(c.req.param("dashboardId"));
  await requireDashboardAccess(c.env.DB, user.id, dashboardId, "VIEWER");
  const rows = await c.env.DB.prepare(
    "SELECT * FROM supertask_dashboard_widget WHERE dashboard_id=? ORDER BY [order] ASC, id ASC"
  ).bind(dashboardId).all<any>();
  return c.json((rows.results || []).map(serializeWidget));
});

dashboard.post("/:dashboardId/widgets/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dashboardId = Number(c.req.param("dashboardId"));
  const body = await c.req.json<any>().catch(() => ({}));
  await requireDashboardAccess(c.env.DB, user.id, dashboardId, "BUILDER");
  const maxOrder = await c.env.DB.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM supertask_dashboard_widget WHERE dashboard_id=?"
  ).bind(dashboardId).first<{ max_order: number }>();
  const now = new Date().toISOString();
  const type = String(body.type || "");
  const title = String(body.title || "").trim();
  const description = String(body.description || "");
  if (!type) throw new ValidationError("The widget type is required.");
  if (!title) throw new ValidationError("The widget title is required.");
  if (title.length > 255 || description.length > 255) {
    throw new ValidationError("Widget titles and descriptions cannot exceed 255 characters.");
  }

  const config: Record<string, unknown> = {};
  if (type === "chart" || type === "pie_chart") {
    const defaultChartType = String(body.default_series_chart_type || (type === "pie_chart" ? "PIE" : "BAR"));
    const allowed = type === "pie_chart" ? ["PIE", "DOUGHNUT"] : ["BAR", "LINE"];
    if (!allowed.includes(defaultChartType)) throw new ValidationError(`The chart type '${defaultChartType}' is invalid.`);
    if (!Array.isArray(body.series_config ?? [])) throw new ValidationError("The series_config value must be a list.");
    if ((body.series_config ?? []).length > 0) {
      throw new ValidationError("A new chart cannot reference aggregation series before its data source is configured.");
    }
    config.default_series_chart_type = defaultChartType;
    config.series_config = [];
  }

  const dataSource = await createDashboardDataSource(c.env.DB, dashboardId, type);
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO supertask_dashboard_widget (dashboard_id, type, title, description, [order], data_source_id, config, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).bind(
      dashboardId,
      type,
      title,
      description,
      (maxOrder?.max_order ?? 0) + 1,
      dataSource.id,
      JSON.stringify(config),
      now,
      now
    ).first<any>();
    return c.json(serializeWidget(row), 200);
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM supertask_dashboard_data_source WHERE id=?").bind(dataSource.id).run();
    throw error;
  }
});

dashboard.patch("/widgets/:widgetId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const widgetId = Number(c.req.param("widgetId"));
  const body = await c.req.json<any>().catch(() => ({}));
  const existing = await requireWidgetAccess(c.env.DB, user.id, widgetId, "BUILDER");

  if ("type" in body && String(body.type) !== existing.type) {
    throw new ValidationError("The widget type cannot be changed.");
  }
  if ("data_source_id" in body && Number(body.data_source_id) !== Number(existing.data_source_id)) {
    throw new ValidationError("The widget data source cannot be changed.");
  }
  if ("order" in body) throw new ValidationError("The widget order cannot be changed with this endpoint.");

  const config = { ...parseDashboardService(existing.config) };
  const title = "title" in body ? String(body.title ?? "").trim() : existing.title;
  const description = "description" in body ? String(body.description ?? "") : existing.description;
  if (!title) throw new ValidationError("The widget title cannot be blank.");
  if (title.length > 255 || description.length > 255) {
    throw new ValidationError("Widget titles and descriptions cannot exceed 255 characters.");
  }
  if (existing.type === "chart" || existing.type === "pie_chart") {
    if ("default_series_chart_type" in body) {
      const chartType = String(body.default_series_chart_type || "");
      const allowed = existing.type === "pie_chart" ? ["PIE", "DOUGHNUT"] : ["BAR", "LINE"];
      if (!allowed.includes(chartType)) throw new ValidationError(`The chart type '${chartType}' is invalid.`);
      config.default_series_chart_type = chartType;
    }
    if ("series_config" in body) {
      config.series_config = await validateWidgetSeriesConfiguration(
        c.env.DB,
        existing.type,
        Number(existing.data_source_id),
        body.series_config
      );
    }
  }

  await c.env.DB.prepare(
    `UPDATE supertask_dashboard_widget
     SET title=?, description=?, config=?, updated_on=?
     WHERE id=?`
  ).bind(title, description, JSON.stringify(config), new Date().toISOString(), widgetId).run();
  const updated = await c.env.DB.prepare("SELECT * FROM supertask_dashboard_widget WHERE id=?").bind(widgetId).first<any>();
  return c.json(serializeWidget(updated));
});

dashboard.delete("/widgets/:widgetId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const widgetId = Number(c.req.param("widgetId"));
  const widget = await requireWidgetAccess(c.env.DB, user.id, widgetId, "BUILDER");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM supertask_dashboard_widget WHERE id=?").bind(widgetId),
    c.env.DB.prepare("DELETE FROM supertask_dashboard_data_source WHERE id=? AND dashboard_id=?")
      .bind(widget.data_source_id, widget.dashboard_id),
  ]);
  return c.body(null, 204);
});

dashboard.get("/:dashboardId/data-sources/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dashboardId = Number(c.req.param("dashboardId"));
  await requireDashboardAccess(c.env.DB, user.id, dashboardId);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM supertask_dashboard_data_source WHERE dashboard_id=? ORDER BY CAST([order] AS REAL), id"
  ).bind(dashboardId).all<any>();
  return c.json(await Promise.all((rows.results || []).map((row) => serializeDashboardDataSource(c.env.DB, row))));
});

dashboard.patch("/data-sources/:dataSourceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dataSourceId = Number(c.req.param("dataSourceId"));
  const body = await c.req.json<any>().catch(() => ({}));
  const existing = await requireDataSourceAccess(c.env.DB, user.id, dataSourceId, "BUILDER");
  return c.json(await updateDashboardDataSource(c.env.DB, existing, body));
});

dashboard.post("/data-sources/:dataSourceId/dispatch/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dataSourceId = Number(c.req.param("dataSourceId"));
  const dataSource = await requireDataSourceAccess(c.env.DB, user.id, dataSourceId, "VIEWER");
  return c.json(await dispatchDashboardDataSource(c.env.DB, dataSource));
});

export { dashboard as dashboardRouter };
