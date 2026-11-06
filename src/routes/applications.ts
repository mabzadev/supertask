import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth";
import { DoesNotExist, ValidationError } from "../middleware/error";
import { ensureTemplatePreviewByVirtualWorkspace, isTemplateWorkspace } from "../services/templates";
import {
  duplicateBuilderApplication,
  ensureBuilderDefaults,
  serializeBuilderApplication,
  updateBuilderApplicationSettings,
  updateBuilderCustomCodeSettings,
} from "../services/builder";
import { duplicateAutomationApplication, ensureAutomationDefaults, serializeAutomationApplication } from "../services/automation";
import { ensureDatabaseHasDefaultTable } from "../services/database-defaults";
import { serializeDatabaseTable } from "../services/database-serializers";
import { addFieldColumn, ensureUserTableSystemColumns, getOrCreateUserTable, serializeFieldValueForInsert, type FieldType } from "../services/dynamic-tables";
import { recordTrashEntry } from "../services/trash";
import { duplicateViewDependencies } from "../services/view-duplication";
import { assertHasApplicationRole, assertHasTableRole, assertHasWorkspaceRole, hasLoadedApplicationRole } from "../services/enterprise-permissions";
import { logAuditEntry } from "../services/audit-log";
import { duplicateFieldDependencies } from "../services/table-duplication";
import { ensureDashboardDefaults } from "../services/dashboard";
import { remapAIFieldSettings } from "../services/ai-field-settings";
import { ensureWhiteboardDefaults } from "./whiteboards";

const applications = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const APPLICATION_TYPES = new Set(["database", "builder", "automation", "dashboard", "document", "whiteboard"]);

function applicationType(value: unknown) {
  const type = String(value || "database");
  if (!APPLICATION_TYPES.has(type)) throw new ValidationError(`Unsupported application type: ${type}`);
  return type;
}

type FieldRow = {
  id: number;
  name: string;
  type: FieldType;
  order: number;
  primary?: number;
  read_only?: number;
  description?: string | null;
  db_index?: number;
  immutable_type?: number;
  immutable_properties?: number;
  field_settings?: string | null;
};

type SelectOptionCopy = { id: number; value: string; color: string; option_order: number };
type SelectOptionValue = { id: number; value: string; color: string };
type PendingLinkValue = { tableId: number; rowId: number; fieldId: number; targetSourceTableId: number; value: unknown };

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function remapId(value: unknown, map: Map<number, number>): unknown {
  if (value === null || value === undefined) return value;
  const id = Number(value);
  return Number.isFinite(id) && map.has(id) ? map.get(id) : value;
}

function remapSelectOptionValue(value: unknown, selectOptionMap: Map<number, SelectOptionValue>): SelectOptionValue | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseMaybeJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const raw = parsed as Record<string, unknown>;
    const id = Number(raw.id);
    if (Number.isFinite(id) && selectOptionMap.has(id)) return selectOptionMap.get(id)!;
    const label = String(raw.value ?? "").trim();
    return label ? [...selectOptionMap.values()].find((option) => option.value === label) || null : null;
  }
  const id = Number(parsed);
  return Number.isFinite(id) ? selectOptionMap.get(id) || null : null;
}

function remapSelectCellValue(type: FieldType, value: unknown, selectOptionMap: Map<number, SelectOptionValue>): string | null {
  if (value === null || value === undefined || value === "") {
    return type === "multiple_select" ? JSON.stringify([]) : null;
  }
  const parsed = parseMaybeJson(value);
  if (type === "multiple_select") {
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return JSON.stringify(items.map((item) => remapSelectOptionValue(item, selectOptionMap)).filter(Boolean));
  }
  const option = remapSelectOptionValue(parsed, selectOptionMap);
  return option ? JSON.stringify(option) : null;
}

function remapLinkRowValue(value: unknown, rowMap: Map<number, number>): unknown[] {
  const parsed = parseMaybeJson(value);
  if (parsed === null || parsed === undefined || parsed === "") return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if (item && typeof item === "object") {
      const raw = item as Record<string, unknown>;
      return { ...raw, id: remapId(raw.id, rowMap) };
    }
    return { id: remapId(item, rowMap), value: String(item ?? "") };
  });
}

function remapDuplicatedFieldSettings(
  field: FieldRow,
  tableMap: Map<number, number>,
  fieldMap: Map<number, number>,
  selectOptionMap: Map<number, SelectOptionValue>
): Record<string, unknown> {
  const parsed = parseMaybeJson(field.field_settings || "{}");
  const settings = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
  const remappedSettings = field.type === "ai" ? remapAIFieldSettings(settings, fieldMap) : settings;

  if (remappedSettings.link_row_table_id !== undefined && remappedSettings.link_row_table_id !== null) {
    remappedSettings.link_row_table_id = remapId(remappedSettings.link_row_table_id, tableMap);
  }
  for (const key of ["through_field_id", "target_field_id", "link_row_related_field_id"]) {
    if (remappedSettings[key] !== undefined && remappedSettings[key] !== null) remappedSettings[key] = remapId(remappedSettings[key], fieldMap);
  }

  if (field.type === "single_select" && remappedSettings.single_select_default !== undefined && remappedSettings.single_select_default !== null) {
    remappedSettings.single_select_default = remapSelectOptionValue(remappedSettings.single_select_default, selectOptionMap)?.id ?? null;
  }
  if (field.type === "multiple_select" && Array.isArray(remappedSettings.multiple_select_default)) {
    remappedSettings.multiple_select_default = remappedSettings.multiple_select_default
      .map((item) => remapSelectOptionValue(item, selectOptionMap)?.id)
      .filter((id): id is number => typeof id === "number");
  }

  return remappedSettings;
}

async function duplicateSelectOptions(
  db: D1Database,
  sourceFieldId: number,
  duplicatedFieldId: number,
  selectOptionMap: Map<number, SelectOptionValue>
) {
  const options = await db.prepare(
    `SELECT id, value, color, [order] AS option_order
     FROM database_selectoption
     WHERE field_id=?
     ORDER BY [order] ASC, id ASC`
  ).bind(sourceFieldId).all<SelectOptionCopy>();

  for (const option of options.results || []) {
    const duplicated = await db.prepare(
      `INSERT INTO database_selectoption (field_id, value, color, [order])
       VALUES (?, ?, ?, ?)
       RETURNING id, value, color`
    ).bind(
      duplicatedFieldId,
      option.value,
      option.color || "blue",
      option.option_order
    ).first<SelectOptionValue>();
    if (duplicated) {
      selectOptionMap.set(option.id, {
        id: duplicated.id,
        value: duplicated.value,
        color: duplicated.color || "blue",
      });
    }
  }
}

async function copyTableRows(
  db: D1Database,
  sourceTableId: number,
  duplicatedTableId: number,
  fields: FieldRow[],
  fieldMap: Map<number, number>,
  selectOptionMap: Map<number, SelectOptionValue>,
  now: string
): Promise<{ rowMap: Map<number, number>; pendingLinkValues: PendingLinkValue[] }> {
  await ensureUserTableSystemColumns(db, sourceTableId);
  const rows = await db.prepare(
    `SELECT * FROM "database_table_${sourceTableId}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC`
  ).all<Record<string, unknown>>();
  const rowMap = new Map<number, number>();
  const pendingLinkValues: PendingLinkValue[] = [];

  for (const row of rows.results || []) {
    const columns = ["[order]", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id"];
    const values: unknown[] = [
      row.order ?? 10000,
      row._created_on ?? now,
      row._updated_on ?? now,
      row._created_by_id ?? null,
      row._last_modified_by_id ?? null,
    ];

    for (const field of fields) {
      const duplicatedFieldId = fieldMap.get(field.id);
      if (!duplicatedFieldId) continue;
      if (field.type === "link_row") continue;
      columns.push(`"field_${duplicatedFieldId}"`);
      const sourceValue = row[`field_${field.id}`];
      if (field.type === "single_select" || field.type === "multiple_select") {
        values.push(remapSelectCellValue(field.type, sourceValue, selectOptionMap));
      } else {
        values.push(sourceValue ?? null);
      }
    }

    const marks = columns.map(() => "?").join(", ");
    const inserted = await db.prepare(
      `INSERT INTO "database_table_${duplicatedTableId}" (${columns.join(", ")})
       VALUES (${marks})
       RETURNING id`
    ).bind(...values).first<{ id: number }>();
    if (inserted?.id) {
      rowMap.set(Number(row.id), Number(inserted.id));
      for (const field of fields.filter((item) => item.type === "link_row")) {
        const duplicatedFieldId = fieldMap.get(field.id);
        if (!duplicatedFieldId) continue;
        const settings = parseMaybeJson(field.field_settings || "{}") as Record<string, unknown>;
        pendingLinkValues.push({
          tableId: duplicatedTableId,
          rowId: Number(inserted.id),
          fieldId: duplicatedFieldId,
          targetSourceTableId: Number(settings?.link_row_table_id || sourceTableId),
          value: row[`field_${field.id}`],
        });
      }
    }
  }

  return { rowMap, pendingLinkValues };
}

async function serializeApplication(db: D1Database, app: any, userId?: number, env?: Env): Promise<object> {
  const base: Record<string, unknown> = {
    id: app.id,
    name: app.name,
    type: app.type,
    order: app.order,
    workspace: { id: app.workspace_id },
    workspace_id: app.workspace_id,
  };
  if (app.type === "database") {
    // A database without tables is valid (Baserow shows "create a table"):
    // reading it must not create one, the default table is made on creation.
    const tables = await db.prepare(
      "SELECT id, name, [order], database_id, data_sync_id FROM database_table WHERE database_id=? AND trashed=0 ORDER BY [order] ASC"
    ).bind(app.id).all<any>();
    const tableVisibility = await Promise.all((tables.results || []).map(async (table: any) => {
      if (!userId) return true;
      try {
        await assertHasTableRole(db, userId, { id: table.id, database_id: table.database_id, workspace_id: app.workspace_id }, "VIEWER");
        return true;
      } catch {
        return false;
      }
    }));
    const visibleTables = (tables.results || []).filter((_: any, index: number) => tableVisibility[index]);
    base.tables = await Promise.all(visibleTables.map((table: any) => serializeDatabaseTable(db, table)));
  } else {
    if (app.type === "builder") {
      Object.assign(base, await serializeBuilderApplication(db, app, env));
      return base;
    }
    if (app.type === "automation") {
      Object.assign(base, await serializeAutomationApplication(db, app));
      return base;
    }

    const extra = await db.prepare("SELECT data FROM core_applicationtemplatedata WHERE application_id=?")
      .bind(app.id)
      .first<{ data: string }>()
      .catch(() => null);
    if (extra?.data) {
      try {
        Object.assign(base, JSON.parse(extra.data));
        base.id = app.id;
        base.workspace = app.workspace_id;
        base.workspace_id = app.workspace_id;
      } catch {
        // Keep base serialization if optional template data cannot be parsed.
      }
    }
  }
  return base;
}

async function workspaceName(db: D1Database, workspaceId: number) {
  const row = await db.prepare("SELECT name FROM core_workspace WHERE id=?").bind(workspaceId).first<{ name: string }>();
  return row?.name || "";
}

async function requireApplicationAccess(
  db: D1Database,
  userId: number,
  applicationId: number,
  requiredRole: string = "VIEWER"
): Promise<any> {
  await assertHasApplicationRole(db, userId, applicationId, requiredRole);
  const app = await db.prepare(
    `SELECT * FROM core_application a
     WHERE a.id=? AND a.trashed=0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  )
    .bind(applicationId)
    .first<any>();
  if (!app) throw new DoesNotExist("Application", applicationId);
  return app;
}

async function requireWorkspaceAccess(
  db: D1Database,
  userId: number,
  workspaceId: number,
  requiredRole: string = "VIEWER"
): Promise<void> {
  await assertHasWorkspaceRole(db, userId, workspaceId, requiredRole);
}

async function filterVisibleApplications(db: D1Database, userId: number, apps: any[]): Promise<any[]> {
  // Rows come from list queries that already exclude trashed applications and
  // published builder copies, so the role can be checked on them directly.
  // Child scope denial must not leak the application in list responses.
  const allowed = await Promise.all(
    apps.map((app) => hasLoadedApplicationRole(db, userId, app, "VIEWER").catch(() => false))
  );
  return apps.filter((_, index) => allowed[index]);
}

// ── GET /api/applications/ — List all applications for the user ──────────────
applications.get("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.type, a.[order], a.workspace_id
     FROM core_application a
     JOIN core_workspaceuser wu ON wu.workspace_id = a.workspace_id
     WHERE wu.user_id = ? AND a.trashed = 0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)
     ORDER BY a.[order]`
  ).bind(user.id).all<any>();
  const visible = await filterVisibleApplications(c.env.DB, user.id, rows.results || []);
  return c.json(await Promise.all(visible.map((app) => serializeApplication(c.env.DB, app, user.id, c.env))));
});

// ── GET /api/applications/workspace/:id/ — List workspace applications ──────
applications.get("/workspace/:workspaceId/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  let workspaceId = Number(c.req.param("workspaceId"));

  workspaceId = await ensureTemplatePreviewByVirtualWorkspace(c.env, workspaceId);
  if (!(await isTemplateWorkspace(c.env.DB, workspaceId))) {
    if (!user) throw new DoesNotExist("Workspace", workspaceId);
    await requireWorkspaceAccess(c.env.DB, user.id, workspaceId, "VIEWER");
  }

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.type, a.[order], a.workspace_id
     FROM core_application a
     WHERE a.workspace_id = ? AND a.trashed = 0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)
     ORDER BY [order] ASC`
  )
    .bind(workspaceId)
    .all<any>();

  const visible = user ? await filterVisibleApplications(c.env.DB, user.id, rows.results || []) : rows.results || [];
  return c.json(await Promise.all(visible.map((app) => serializeApplication(c.env.DB, app, user?.id, c.env))));
});

// ── POST /api/applications/workspace/:id/ — Create application ──────────────
applications.post("/workspace/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const body = await c.req.json<Record<string, unknown> & { name: string; type?: string; init_with_data?: boolean }>();

  await requireWorkspaceAccess(c.env.DB, user.id, workspaceId, "BUILDER");

  const now = new Date().toISOString();
  const type = applicationType(body.type);
  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX([order]), 0) AS max_order
     FROM core_application a
     WHERE a.workspace_id = ? AND a.trashed = 0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  )
    .bind(workspaceId)
    .first<{ max_order: number }>();

  const app = await c.env.DB.prepare(
    `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     RETURNING id, name, type, [order], workspace_id`
  )
    .bind(
      workspaceId,
      body.name || "Untitled",
      type,
      (maxOrder?.max_order || 0) + 1,
      now,
      now
    )
    .first<any>();

  if (!app) throw new Error("Failed to create application");
  if (app.type === "database" && body.init_with_data !== false) await ensureDatabaseHasDefaultTable(c.env.DB, app.id);
  if (app.type === "builder") {
    await ensureBuilderDefaults(c.env.DB, app.id);
    await updateBuilderCustomCodeSettings(c.env.DB, app.id, body);
    await updateBuilderApplicationSettings(c.env.DB, app.id, body, c.env, workspaceId);
  }
  if (app.type === "automation") await ensureAutomationDefaults(c.env.DB, app.id, true);
  if (app.type === "dashboard") await ensureDashboardDefaults(c.env.DB, app.id);
  if (app.type === "whiteboard") await ensureWhiteboardDefaults(c.env.DB, app.id, user.id);
  await logAuditEntry(c.env.DB, "application.create", {
    user,
    workspace_id: workspaceId,
    workspace_name: await workspaceName(c.env.DB, workspaceId),
  }, { id: app.id, type: "application" }, {
    application_id: app.id,
    application_name: app.name,
    application_type: app.type,
    workspace_id: workspaceId,
  });

  return c.json(await serializeApplication(c.env.DB, app, user.id, c.env), 200);
});

// ── POST /api/applications/workspace/:id/order/ ─────────────────────────────
applications.post("/workspace/:workspaceId/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const body = await c.req.json<{ application_ids?: number[] }>();
  const ids = body.application_ids || [];

  await requireWorkspaceAccess(c.env.DB, user.id, workspaceId, "BUILDER");

  const statements = ids.map((id, index) =>
    c.env.DB.prepare(
      `UPDATE core_application SET [order] = ?, updated_on = ? WHERE id = ? AND workspace_id = ?`
    ).bind(index + 1, new Date().toISOString(), id, workspaceId)
  );

  if (statements.length > 0) await c.env.DB.batch(statements);

  return c.json({});
});

applications.post("/:id/duplicate/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const source = await requireApplicationAccess(c.env.DB, user.id, id, "BUILDER");
  const now = new Date().toISOString();
  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(a.[order]), 0) AS max_order FROM core_application a
     WHERE a.workspace_id=? AND a.trashed=0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  ).bind(source.workspace_id).first<{ max_order: number }>();

  const duplicated = await c.env.DB.prepare(
    `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING *`
  )
    .bind(source.workspace_id, `${source.name} copy`, source.type, (maxOrder?.max_order || 0) + 1, now, now)
    .first<any>();
  if (!duplicated) throw new Error("Failed to duplicate application");

  if (source.type === "database") {
    const tables = await c.env.DB.prepare(
      "SELECT * FROM database_table WHERE database_id=? AND trashed=0 ORDER BY [order] ASC"
    ).bind(source.id).all<any>();
    const tableMap = new Map<number, number>();
    const applicationFieldMap = new Map<number, number>();
    const tableBundles: Array<{ sourceTable: any; duplicatedTable: any; fields: FieldRow[]; fieldMap: Map<number, number>; selectOptionMap: Map<number, SelectOptionValue> }> = [];
    for (const table of tables.results || []) {
      const newTable = await c.env.DB.prepare(
        `INSERT INTO database_table (database_id, name, [order], trashed, created_on, updated_on, data_sync_id)
         VALUES (?, ?, ?, 0, ?, ?, NULL) RETURNING *`
      ).bind(duplicated.id, table.name, table.order, now, now).first<any>();
      if (!newTable) continue;
      tableMap.set(table.id, newTable.id);
      const fieldMap = new Map<number, number>();
      const selectOptionMap = new Map<number, SelectOptionValue>();
      await getOrCreateUserTable(c.env.DB, newTable.id);

      const fields = await c.env.DB.prepare(
        "SELECT * FROM database_field WHERE table_id=? AND trashed=0 ORDER BY [order] ASC"
      ).bind(table.id).all<FieldRow>();
      for (const field of fields.results || []) {
        const insertedField = await c.env.DB.prepare(
          `INSERT INTO database_field
           (table_id, name, type, [order], "primary", read_only, description, db_index,
            immutable_type, immutable_properties, field_settings, trashed, created_on, updated_on)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id`
        ).bind(
          newTable.id,
          field.name,
          field.type,
          field.order,
          field.primary || 0,
          field.read_only || 0,
          field.description || "",
          field.db_index || 0,
          field.immutable_type || 0,
          field.immutable_properties || 0,
          field.field_settings || "{}",
          now,
          now
        ).first<{ id: number }>();
        if (insertedField) {
          fieldMap.set(field.id, insertedField.id);
          applicationFieldMap.set(field.id, insertedField.id);
          await addFieldColumn(c.env.DB, newTable.id, { id: insertedField.id, type: field.type as FieldType });
          if (field.type === "single_select" || field.type === "multiple_select") {
            await duplicateSelectOptions(c.env.DB, field.id, insertedField.id, selectOptionMap);
          }
        }
      }

      tableBundles.push({
        sourceTable: table,
        duplicatedTable: newTable,
        fields: fields.results || [],
        fieldMap,
        selectOptionMap,
      });

      const views = await c.env.DB.prepare("SELECT * FROM database_view WHERE table_id=? AND trashed=0 ORDER BY [order] ASC")
        .bind(table.id).all<any>();
      for (const view of views.results || []) {
        const duplicatedView = await c.env.DB.prepare(
          `INSERT INTO database_view (table_id, name, type, [order], filter_type, filters_disabled, public, allow_public_export,
           public_view_password, slug, trashed, created_on, updated_on, row_identifier_type, ownership_type, owned_by_id, show_logo, row_height_size,
           card_cover_image_field, single_select_field, date_field, ical_public, ical_slug, start_date_field, end_date_field, timescale)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id`
        ).bind(
          newTable.id,
          view.name,
          view.type,
          view.order,
          view.filter_type || "AND",
          view.filters_disabled || 0,
          view.public ? 1 : 0,
          view.allow_public_export ? 1 : 0,
          view.public_view_password || null,
          view.slug ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : null,
          now,
          now,
          view.row_identifier_type || "count",
          view.ownership_type || "collaborative",
          view.owned_by_id ?? null,
          view.show_logo === 0 ? 0 : 1,
          view.row_height_size || "small",
          remapId(view.card_cover_image_field, fieldMap) ?? null,
          remapId(view.single_select_field, fieldMap) ?? null,
          remapId(view.date_field, fieldMap) ?? null,
          view.ical_public ? 1 : 0,
          view.ical_slug ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : null,
          remapId(view.start_date_field, fieldMap) ?? null,
          remapId(view.end_date_field, fieldMap) ?? null,
          view.timescale || "month"
        ).first<{ id: number }>();
        if (duplicatedView) {
          await duplicateViewDependencies(c.env.DB, view.id, duplicatedView.id, view.type, {
            fieldMap,
            selectOptionMap: new Map([...selectOptionMap].map(([sourceOptionId, option]) => [sourceOptionId, option.id])),
          });
        }
      }
    }

    const rowMapBySourceTable = new Map<number, Map<number, number>>();
    const pendingLinkValues: PendingLinkValue[] = [];
    for (const bundle of tableBundles) {
      await duplicateFieldDependencies(c.env.DB, bundle.sourceTable.id, applicationFieldMap);
      for (const field of bundle.fields) {
        const duplicatedFieldId = bundle.fieldMap.get(field.id);
        if (!duplicatedFieldId) continue;
        const settings = remapDuplicatedFieldSettings(field, tableMap, applicationFieldMap, bundle.selectOptionMap);
        await c.env.DB.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
          .bind(JSON.stringify(settings), duplicatedFieldId)
          .run();
      }
      const copied = await copyTableRows(
        c.env.DB,
        bundle.sourceTable.id,
        bundle.duplicatedTable.id,
        bundle.fields,
        bundle.fieldMap,
        bundle.selectOptionMap,
        now
      );
      rowMapBySourceTable.set(bundle.sourceTable.id, copied.rowMap);
      pendingLinkValues.push(...copied.pendingLinkValues);
    }

    for (const pending of pendingLinkValues) {
      const targetRowMap = rowMapBySourceTable.get(pending.targetSourceTableId) || new Map<number, number>();
      const value = remapLinkRowValue(pending.value, targetRowMap);
      await c.env.DB.prepare(`UPDATE "database_table_${pending.tableId}" SET "field_${pending.fieldId}"=? WHERE id=?`)
        .bind(serializeFieldValueForInsert("link_row", value), pending.rowId)
        .run();
    }
  } else if (source.type === "builder") {
    await duplicateBuilderApplication(c.env.DB, source.id, duplicated.id);
  } else if (source.type === "automation") {
    await duplicateAutomationApplication(c.env.DB, source.id, duplicated.id);
  } else if (source.type === "document") {
    const pages = await c.env.DB.prepare(
      "SELECT * FROM supertask_document_page WHERE document_id=? ORDER BY [order], id"
    ).bind(source.id).all<any>();
    const pageIds = new Map<number, number>();
    for (const page of pages.results || []) {
      const inserted = await c.env.DB.prepare(
        `INSERT INTO supertask_document_page
         (document_id, parent_id, title, content, icon, cover, settings, editor_schema_version,
          collaboration_initialized, [order], created_on, updated_on)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) RETURNING id`
      ).bind(
        duplicated.id, page.title, page.content, page.icon || "", page.cover || "",
        page.settings || "{}", page.editor_schema_version || 1, page.order || 0, now, now
      ).first<{ id: number }>();
      if (inserted) pageIds.set(Number(page.id), Number(inserted.id));
    }
    for (const page of pages.results || []) {
      if (!page.parent_id) continue;
      const newId = pageIds.get(Number(page.id));
      const newParentId = pageIds.get(Number(page.parent_id));
      if (newId && newParentId) {
        await c.env.DB.prepare("UPDATE supertask_document_page SET parent_id=? WHERE id=?")
          .bind(newParentId, newId).run();
      }
    }
  } else if (source.type === "whiteboard") {
    const canvases = await c.env.DB.prepare(
      "SELECT * FROM supertask_whiteboard_canvas WHERE whiteboard_id=? AND trashed=0 ORDER BY [order], id"
    ).bind(source.id).all<any>();
    for (const canvas of canvases.results || []) {
      await c.env.DB.prepare(
        `INSERT INTO supertask_whiteboard_canvas
         (whiteboard_id, name, icon, [order], state, settings, thumbnail_key, editor_schema_version,
          trashed, created_by_id, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      ).bind(
        duplicated.id, canvas.name, canvas.icon || "🧠", canvas.order || 0, canvas.state || "{}",
        canvas.settings || "{}", canvas.thumbnail_key || "", canvas.editor_schema_version || 1,
        user.id, now, now
      ).run();
    }
  }
  await logAuditEntry(c.env.DB, "application.create", {
    user,
    workspace_id: source.workspace_id,
    workspace_name: await workspaceName(c.env.DB, source.workspace_id),
  }, { id: duplicated.id, type: "application" }, {
    application_id: duplicated.id,
    application_name: duplicated.name,
    application_type: duplicated.type,
    duplicated_from_application_id: source.id,
  });

  return c.json({
    id: Date.now(),
    type: "duplicate_application",
    state: "finished",
    original_application: await serializeApplication(c.env.DB, source, user.id, c.env),
    duplicated_application: await serializeApplication(c.env.DB, duplicated, user.id, c.env),
    application_id: duplicated.id,
  }, 202);
});

// ── GET /api/applications/:id/ ───────────────────────────────
applications.get("/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));

  const app = await requireApplicationAccess(c.env.DB, user.id, id, "VIEWER");
  return c.json(await serializeApplication(c.env.DB, app, user.id, c.env));
});

// ── PATCH /api/applications/:id/ ────────────────────────────
applications.patch("/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown> & { name?: string }>();

  const before = await requireApplicationAccess(c.env.DB, user.id, id, "BUILDER");

  if (body.name) {
    await c.env.DB.prepare("UPDATE core_application SET name=?, updated_on=? WHERE id=?")
      .bind(body.name, new Date().toISOString(), id).run();
  }
  if (before.type === "builder") {
    await updateBuilderCustomCodeSettings(c.env.DB, id, body);
    await updateBuilderApplicationSettings(c.env.DB, id, body, c.env, before.workspace_id);
  }

  const updated = await c.env.DB.prepare("SELECT * FROM core_application WHERE id = ?").bind(id).first<any>();
  await logAuditEntry(c.env.DB, "application.update", {
    user,
    workspace_id: updated.workspace_id,
    workspace_name: await workspaceName(c.env.DB, updated.workspace_id),
  }, { id, type: "application" }, {
    application_id: id,
    application_name: updated.name,
    application_type: updated.type,
    before: body.name ? { name: before.name } : {},
    after: body.name ? { name: updated.name } : {},
  });
  return c.json(await serializeApplication(c.env.DB, updated, user.id, c.env));
});

// ── DELETE /api/applications/:id/ ───────────────────────────
applications.delete("/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));
  const app = await requireApplicationAccess(c.env.DB, user.id, id, "BUILDER");
  const now = new Date().toISOString();
  await recordTrashEntry(c.env.DB, {
    userId: user.id,
    workspaceId: app.workspace_id,
    applicationId: app.id,
    trashItemType: "application",
    trashItemId: app.id,
    name: app.name,
    trashedAt: now,
  });
  await c.env.DB.prepare("UPDATE core_application SET trashed=1, updated_on=? WHERE id=?")
    .bind(now, id).run();
  await logAuditEntry(c.env.DB, "application.delete", {
    user,
    workspace_id: app.workspace_id,
    workspace_name: await workspaceName(c.env.DB, app.workspace_id),
  }, { id: app.id, type: "application" }, {
    application_id: app.id,
    application_name: app.name,
    application_type: app.type,
  });
  return c.json({});
});

// ── POST /api/applications/ — Create application ─────────────
applications.post("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<Record<string, unknown> & { workspace_id: number; name: string; type?: string }>();
  const now = new Date().toISOString();
  const type = applicationType(body.type);

  await requireWorkspaceAccess(c.env.DB, user.id, body.workspace_id, "BUILDER");

  const result = await c.env.DB.prepare(
    `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on) VALUES (?,?,?,1,0,?,?) RETURNING id`
  ).bind(body.workspace_id, body.name, type, now, now).first<{ id: number }>();

  if (!result) throw new Error("Failed to create application");
  if (type === "builder") {
    await ensureBuilderDefaults(c.env.DB, result.id);
    await updateBuilderCustomCodeSettings(c.env.DB, result.id, body);
    await updateBuilderApplicationSettings(c.env.DB, result.id, body, c.env, body.workspace_id);
  }
  if (type === "automation") await ensureAutomationDefaults(c.env.DB, result.id, true);
  if (type === "dashboard") await ensureDashboardDefaults(c.env.DB, result.id);
  if (type === "whiteboard") await ensureWhiteboardDefaults(c.env.DB, result.id, user.id);
  return c.json(await serializeApplication(c.env.DB, {
    id: result.id,
    name: body.name,
    type,
    order: 1,
    workspace_id: body.workspace_id,
  }, user.id, c.env));
});

export { applications as applicationRouter };
