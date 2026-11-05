import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { PermissionError } from "../middleware/error";
import { assertHasApplicationRole, assertHasFieldRole, assertHasTableRole, assertHasWorkspaceRole } from "../services/enterprise-permissions";
import { ensureUserTableSystemColumns } from "../services/dynamic-tables";

const search = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

type WorkspaceSearchResult = {
  type: string;
  id: number | string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  created_on?: string;
  updated_on?: string;
  priority: number;
  sort_key: string;
};

function like(value: string) {
  return `%${value}%`;
}

function parseWorkspaceSearchTypes(url: string): Set<string> | null {
  const params = new URL(url).searchParams;
  const values = [
    ...params.getAll("types"),
    ...params.getAll("types[]"),
  ].flatMap((value) => value.split(","));
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? new Set(normalized) : null;
}

function typeAllowed(types: Set<string> | null, type: string): boolean {
  return !types || types.has(type);
}

function applicationSubtitle(type: string): string {
  const labels: Record<string, string> = {
    database: "Base de données",
    builder: "Application",
    automation: "Automatisation",
    dashboard: "Tableau de bord",
    document: "Document",
    whiteboard: "Tableau blanc",
  };
  return labels[type] || type;
}

async function workspaceName(db: D1Database, workspaceId: number): Promise<string> {
  const workspace = await db.prepare("SELECT name FROM core_workspace WHERE id=?")
    .bind(workspaceId)
    .first<{ name: string }>();
  return workspace?.name || `Workspace ${workspaceId}`;
}

async function workspaceRowSearchResults(
  db: D1Database,
  userId: number,
  workspaceId: number,
  query: string,
  perTableLimit: number
): Promise<WorkspaceSearchResult[]> {
  const tables = await db.prepare(
    `SELECT t.id, t.name AS table_name, t.database_id, a.name AS database_name, a.workspace_id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE a.workspace_id=? AND a.type='database' AND a.trashed=0 AND t.trashed=0
     ORDER BY a.[order] ASC, t.[order] ASC, t.id ASC`
  ).bind(workspaceId).all<any>();
  const results: WorkspaceSearchResult[] = [];

  for (const table of tables.results || []) {
    try {
      await assertHasTableRole(db, userId, table, "VIEWER");
    } catch (error) {
      if (error instanceof PermissionError) continue;
      throw error;
    }
    const fields = await db.prepare(
      `SELECT id, name, type, "primary" AS is_primary
       FROM database_field
       WHERE table_id=? AND trashed=0 AND type != 'password'
       ORDER BY [order] ASC, id ASC`
    ).bind(table.id).all<any>();
    const activeFields = [];
    for (const field of fields.results || []) {
      try {
        await assertHasFieldRole(db, userId, Number(field.id), "VIEWER");
        activeFields.push(field);
      } catch (error) {
        if (error instanceof PermissionError) continue;
        throw error;
      }
    }
    if (activeFields.length === 0) continue;

    const primary = activeFields.find((field: any) => Boolean(field.is_primary)) || activeFields[0];
    const clauses = activeFields.map((field: any) => `CAST("field_${field.id}" AS TEXT) LIKE ?`);
    const selectColumns = [
      `"field_${primary.id}" AS primary_value`,
      ...activeFields.map((field: any) => `"field_${field.id}" AS "field_${field.id}"`),
    ];
    await ensureUserTableSystemColumns(db, Number(table.id));
    const rows = await db.prepare(
      `SELECT id, [order] AS row_order, ${selectColumns.join(", ")}
       FROM "database_table_${table.id}"
       WHERE COALESCE(trashed, 0)=0 AND (${clauses.join(" OR ")})
       ORDER BY [order] ASC, id ASC
       LIMIT ?`
    ).bind(...activeFields.map(() => like(query)), perTableLimit).all<any>();

    for (const row of rows.results || []) {
      const matched = activeFields.find((field: any) => String(row[`field_${field.id}`] ?? "").toLowerCase().includes(query.toLowerCase()))
        || primary;
      const title = String(row.primary_value ?? "").trim() || `Row #${row.id}`;
      results.push({
        type: "database_row",
        id: `${table.id}_${row.id}`,
        title,
        subtitle: `Row in ${table.database_name} / ${table.table_name}`,
        metadata: {
          workspace_id: workspaceId,
          database_id: table.database_id,
          table_id: table.id,
          row_id: row.id,
          field_id: matched.id,
          database_name: table.database_name,
          table_name: table.table_name,
          field_name: matched.name,
          primary_field_value: title,
        },
        priority: 7,
        sort_key: `${table.database_id}:${table.id}:${row.id}`,
      });
    }
  }

  return results;
}

// ── GET /api/search/all/ — Full-text search across all accessible tables ──────
search.get("/all/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const query = c.req.query("query") || c.req.query("search") || "";
  const workspaceId = c.req.query("workspace_id");
  const limit = Math.min(50, parseInt(c.req.query("limit") || "10"));

  if (!query.trim()) return c.json({ results: [] });

  // Get all tables accessible by user
  let tableQuery = `
    SELECT t.id, t.name as table_name, a.id as app_id, a.name as app_name, a.workspace_id
    FROM database_table t
    JOIN core_application a ON a.id = t.database_id
    JOIN core_workspaceuser wu ON wu.workspace_id = a.workspace_id
    WHERE wu.user_id = ? AND t.trashed = 0 AND a.trashed = 0`;

  const params: any[] = [user.id];
  if (workspaceId) {
    tableQuery += " AND a.workspace_id = ?";
    params.push(parseInt(workspaceId));
  }
  tableQuery += " LIMIT 30";

  const tables = await c.env.DB.prepare(tableQuery).bind(...params).all<any>();
  const results: any[] = [];

  for (const table of (tables.results || [])) {
    try {
      await assertHasTableRole(c.env.DB, user.id, {
        id: table.id,
        database_id: table.app_id,
        workspace_id: table.workspace_id,
      }, "VIEWER");
    } catch (error) {
      if (error instanceof PermissionError) continue;
      throw error;
    }
    // Get text fields for this table
    const fields = await c.env.DB.prepare(
      `SELECT id, name FROM database_field
       WHERE table_id=? AND trashed=0 AND type IN ('text','long_text','email','url','phone_number')
       ORDER BY [order] ASC LIMIT 5`
    ).bind(table.id).all<any>();

    const visibleFields = [];
    for (const field of fields.results || []) {
      try {
        await assertHasFieldRole(c.env.DB, user.id, Number(field.id), "VIEWER");
        visibleFields.push(field);
      } catch (error) {
        if (error instanceof PermissionError) continue;
        throw error;
      }
    }
    if (!visibleFields.length) continue;

    const tn = `database_table_${table.id}`;
    const searchCols = visibleFields.map((f: any) => `"field_${f.id}"`);
    const whereClauses = searchCols.map(col => `${col} LIKE ?`).join(" OR ");
    const likeParams = searchCols.map(() => `%${query}%`);

    try {
      const rows = await c.env.DB.prepare(
        `SELECT id, ${searchCols.join(", ")} FROM "${tn}" WHERE ${whereClauses} LIMIT ${limit}`
      ).bind(...likeParams).all<any>();

      for (const row of (rows.results || [])) {
        // Find the primary field value for display
        const primaryField = visibleFields[0];
        const displayValue = row[`field_${primaryField.id}`] || `Row #${row.id}`;
        results.push({
          id: row.id,
          table_id: table.id,
          table_name: table.table_name,
          application_id: table.app_id,
          application_name: table.app_name,
          workspace_id: table.workspace_id,
          primary_value: displayValue,
          result_type: "row",
          url: `/database/${table.app_id}/table/${table.id}/${row.id}`,
        });
      }
    } catch {
      // Skip tables that don't exist yet
    }

    if (results.length >= limit) break;
  }

  // Also search table/app names
  const appResults = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.type, a.workspace_id FROM core_application a
     JOIN core_workspaceuser wu ON wu.workspace_id = a.workspace_id
     WHERE wu.user_id=? AND a.name LIKE ? AND a.trashed=0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)
     LIMIT 5`
  ).bind(user.id, `%${query}%`).all<any>();

  for (const app of (appResults.results || [])) {
    try {
      await assertHasApplicationRole(c.env.DB, user.id, Number(app.id), "VIEWER");
    } catch (error) {
      if (error instanceof PermissionError) continue;
      throw error;
    }
    results.unshift({
      id: app.id,
      result_type: "application",
      name: app.name,
      type: app.type,
      workspace_id: app.workspace_id,
      url: `/database/${app.id}`,
    });
  }

  return c.json({ results: results.slice(0, limit) });
});

search.get("/workspace/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const query = c.req.query("query") || c.req.query("search") || "";
  const limit = Math.min(50, Number(c.req.query("limit") || 20));
  const offset = Math.max(0, Number(c.req.query("offset") || 0));
  const types = parseWorkspaceSearchTypes(c.req.url);

  await assertHasWorkspaceRole(c.env.DB, user.id, workspaceId, "VIEWER");

  if (!query.trim()) return c.json({ results: [], has_more: false });

  const workspace = await workspaceName(c.env.DB, workspaceId);
  const results: WorkspaceSearchResult[] = [];
  const applications = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.type, a.created_on, a.updated_on
     FROM core_application a
     WHERE a.workspace_id=? AND a.trashed=0 AND a.name LIKE ?
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)
     ORDER BY [order] ASC, id ASC`
  ).bind(workspaceId, like(query)).all<any>();
  for (const app of applications.results || []) {
    if (!typeAllowed(types, app.type)) continue;
    try {
      await assertHasApplicationRole(c.env.DB, user.id, Number(app.id), "VIEWER");
    } catch (error) {
      if (error instanceof PermissionError) continue;
      throw error;
    }
    results.push({
      type: app.type,
      id: app.id,
      title: app.name,
      subtitle: applicationSubtitle(app.type),
      created_on: app.created_on,
      updated_on: app.updated_on,
      metadata: {
        workspace_id: workspaceId,
        workspace_name: workspace,
        application_id: app.id,
        ...(app.type === "database" ? { database_id: app.id } : {}),
      },
      priority: app.type === "database" ? 1 : app.type === "builder" ? 2 : app.type === "dashboard" ? 3 : app.type === "automation" ? 4 : 5,
      sort_key: `app:${app.id}`,
    });
  }

  if (typeAllowed(types, "document_page")) {
    let pageRows: any[] = [];
    try { const pages = await c.env.DB.prepare(
      `SELECT p.id, p.document_id, p.title, p.content, p.created_on, p.updated_on, a.name AS application_name
         FROM supertask_document_page p JOIN core_application a ON a.id=p.document_id
        WHERE a.workspace_id=? AND a.trashed=0 AND a.type='document'
          AND (p.title LIKE ? OR p.content LIKE ?)
        ORDER BY a.[order], p.[order], p.id`
    ).bind(workspaceId, like(query), like(query)).all<any>(); pageRows = pages.results || []; } catch { pageRows = []; }
    for (const page of pageRows) {
      try { await assertHasApplicationRole(c.env.DB, user.id, Number(page.document_id), "VIEWER"); }
      catch (error) { if (error instanceof PermissionError) continue; throw error; }
      results.push({
        type: "document_page", id: page.id, title: page.title || "Sans titre", subtitle: page.application_name,
        created_on: page.created_on, updated_on: page.updated_on,
        metadata: { workspace_id: workspaceId, application_id: page.document_id, document_id: page.document_id, page_id: page.id },
        priority: 3, sort_key: `document:${page.document_id}:${page.id}`,
      });
    }
  }

  if (typeAllowed(types, "whiteboard_canvas")) {
    let canvasRows: any[] = [];
    try { const canvases = await c.env.DB.prepare(
      `SELECT c.id, c.whiteboard_id, c.name, c.created_on, c.updated_on, a.name AS application_name
         FROM supertask_whiteboard_canvas c JOIN core_application a ON a.id=c.whiteboard_id
        WHERE a.workspace_id=? AND a.trashed=0 AND a.type='whiteboard' AND c.trashed=0 AND c.name LIKE ?
        ORDER BY a.[order], c.[order], c.id`
    ).bind(workspaceId, like(query)).all<any>(); canvasRows = canvases.results || []; } catch { canvasRows = []; }
    for (const canvas of canvasRows) {
      try { await assertHasApplicationRole(c.env.DB, user.id, Number(canvas.whiteboard_id), "VIEWER"); }
      catch (error) { if (error instanceof PermissionError) continue; throw error; }
      results.push({
        type: "whiteboard_canvas", id: canvas.id, title: canvas.name || "Canevas", subtitle: canvas.application_name,
        created_on: canvas.created_on, updated_on: canvas.updated_on,
        metadata: { workspace_id: workspaceId, application_id: canvas.whiteboard_id, whiteboard_id: canvas.whiteboard_id, canvas_id: canvas.id },
        priority: 3, sort_key: `whiteboard:${canvas.whiteboard_id}:${canvas.id}`,
      });
    }
  }

  const tables = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.database_id, a.name AS application_name, t.created_on, t.updated_on
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE a.workspace_id=? AND a.trashed=0 AND t.trashed=0 AND t.name LIKE ?
     ORDER BY a.[order] ASC, t.[order] ASC, t.id ASC`
    ).bind(workspaceId, like(query)).all<any>();
    if (typeAllowed(types, "database_table")) {
    for (const table of tables.results || []) {
      try {
        await assertHasTableRole(c.env.DB, user.id, {
          id: table.id,
          database_id: table.database_id,
          workspace_id: workspaceId,
        }, "VIEWER");
      } catch (error) {
        if (error instanceof PermissionError) continue;
        throw error;
      }
      results.push({
        type: "database_table",
        id: table.id,
        title: table.name,
        subtitle: table.application_name,
        created_on: table.created_on,
        updated_on: table.updated_on,
        metadata: {
          workspace_id: workspaceId,
          database_id: table.database_id,
          table_id: table.id,
          table_name: table.name,
          database_name: table.application_name,
        },
        priority: 2,
        sort_key: `table:${table.database_id}:${table.id}`,
      });
    }
  }

  if (typeAllowed(types, "database_field")) {
    const fields = await c.env.DB.prepare(
      `SELECT f.id, f.name, f.description, f.table_id, t.name AS table_name, t.database_id, a.name AS database_name,
              f.created_on, f.updated_on
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
       WHERE a.workspace_id=? AND a.trashed=0 AND t.trashed=0 AND f.trashed=0
         AND (f.name LIKE ? OR COALESCE(f.description, '') LIKE ?)
       ORDER BY a.[order] ASC, t.[order] ASC, f.[order] ASC, f.id ASC`
    ).bind(workspaceId, like(query), like(query)).all<any>();
    for (const field of fields.results || []) {
      try {
        await assertHasFieldRole(c.env.DB, user.id, Number(field.id), "VIEWER");
      } catch (error) {
        if (error instanceof PermissionError) continue;
        throw error;
      }
      results.push({
        type: "database_field",
        id: field.id,
        title: field.name,
        subtitle: `${field.database_name} / ${field.table_name}`,
        description: field.description || undefined,
        created_on: field.created_on,
        updated_on: field.updated_on,
        metadata: {
          workspace_id: workspaceId,
          database_id: field.database_id,
          table_id: field.table_id,
          field_id: field.id,
        },
        priority: 6,
        sort_key: `field:${field.database_id}:${field.table_id}:${field.id}`,
      });
    }
  }

  if (typeAllowed(types, "database_row")) {
    results.push(...await workspaceRowSearchResults(c.env.DB, user.id, workspaceId, query, offset + limit + 1));
  }

  results.sort((left, right) =>
    left.priority - right.priority ||
    String(left.sort_key).localeCompare(String(right.sort_key))
  );
  const page = results.slice(offset, offset + limit);

  return c.json({
    results: page.map(({ priority, sort_key, ...result }) => result),
    has_more: offset + limit < results.length,
  });
});

export { search as searchRouter };
