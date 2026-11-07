import { Hono } from "hono";
import type { Env, JobMessage, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { ApiError, DoesNotExist, ValidationError } from "../middleware/error";
import { broadcastToWorkspace } from "../durable-objects/workspace-room";
import { addFieldColumn, dropFieldColumn, ensureUserTableSystemColumns, type FieldType } from "../services/dynamic-tables";
import {
  deleteTrashEntry,
  parseTrashDescription,
  recordTrashEntry,
  type TrashItemType,
} from "../services/trash";
import {
  collectUserFileNamesFromApplication,
  collectUserFileNamesFromRecord,
  collectUserFileNamesFromTable,
  collectUserFileNamesFromWorkspace,
  deleteUnreferencedUserFiles,
} from "../services/user-files";
import { parseFieldSettings } from "../services/computed-fields";
import { synchronizeLinkRowRelations } from "../services/link-row-relations";
import { synchronizeFieldDependencies } from "../services/field-dependencies";
import { revalidateComputedFieldSettings } from "../services/field-validation";
import { revalidateDateDependencyRules } from "../services/field-rules";
import {
  assertHasApplicationRole,
  assertHasFieldRole,
  assertHasTableRole,
  assertHasViewRole,
  assertHasWorkspaceRole,
} from "../services/enterprise-permissions";
import { associatedSubjectUserIds, broadcastPermissionsUpdated } from "../services/enterprise-realtime";
import {
  permanentlyDeleteNode,
  permanentlyDeleteWorkflow,
  restoreNodeFromTrash,
  restoreWorkflowFromTrash,
} from "../services/automation";

const trash = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

type TrashEntry = {
  id: string | number;
  user_who_trashed: string | null;
  trash_item_type: TrashItemType;
  trash_item_id: number;
  parent_trash_item_id: number | null;
  trashed_at: string;
  application: number | null;
  workspace: number | null;
  name: string;
  names: string[];
  parent_name: string | null;
};

export type PermanentTrashEntry = Pick<
  TrashEntry,
  "trash_item_type" | "trash_item_id" | "parent_trash_item_id" | "application" | "workspace"
>;

async function requireWorkspaceAccess(db: D1Database, userId: number, workspaceId: number, role = "VIEWER") {
  await assertHasWorkspaceRole(db, userId, workspaceId, role);
}

async function assertCanManageTrashItem(
  db: D1Database,
  userId: number,
  itemType: TrashItemType,
  itemId: number,
  parentId: number | null,
  permanent = false,
) {
  if (itemType === "workspace") {
    await assertHasWorkspaceRole(db, userId, itemId, "ADMIN");
    return;
  }
  if (itemType === "application") {
    await assertHasApplicationRole(db, userId, itemId, permanent ? "ADMIN" : "BUILDER", true);
    return;
  }
  if (itemType === "automation_workflow") {
    const workflow = await db.prepare(
      `SELECT automation_id FROM automation_workflow WHERE id=?
       UNION ALL
       SELECT application_id AS automation_id FROM core_trasheditem
       WHERE trash_item_type='automation_workflow' AND trash_item_id=?
       LIMIT 1`
    ).bind(itemId, itemId).first<{ automation_id: number }>();
    if (!workflow?.automation_id) throw new DoesNotExist("Automation workflow", itemId);
    await assertHasApplicationRole(db, userId, workflow.automation_id, permanent ? "ADMIN" : "BUILDER", true);
    return;
  }
  if (itemType === "automation_node") {
    const node = await db.prepare(
      `SELECT wf.automation_id
       FROM automation_node n
       JOIN automation_workflow wf ON wf.id=n.workflow_id
       WHERE n.id=?
       UNION ALL
       SELECT application_id AS automation_id FROM core_trasheditem
       WHERE trash_item_type='automation_node' AND trash_item_id=?
       LIMIT 1`
    ).bind(itemId, itemId).first<{ automation_id: number }>();
    if (!node?.automation_id) throw new DoesNotExist("Automation node", itemId);
    await assertHasApplicationRole(db, userId, node.automation_id, permanent ? "ADMIN" : "BUILDER", true);
    return;
  }
  if (itemType === "field") {
    await assertHasFieldRole(db, userId, itemId, permanent ? "ADMIN" : "BUILDER", true);
    return;
  }
  if (itemType === "view") {
    await assertHasViewRole(db, userId, itemId, permanent ? "ADMIN" : "BUILDER", true);
    return;
  }
  if (itemType === "team") {
    const team = await db.prepare("SELECT workspace_id FROM enterprise_team WHERE id=?").bind(itemId).first<{ workspace_id: number }>();
    if (!team) throw new DoesNotExist("Team", itemId);
    await assertHasWorkspaceRole(db, userId, team.workspace_id, "ADMIN");
    return;
  }

  let tableId = parentId;
  if (itemType === "table") tableId = itemId;
  if (itemType === "row_comment") {
    const comment = await db.prepare("SELECT table_id FROM database_rowcomment WHERE id=?").bind(itemId).first<{ table_id: number }>();
    tableId = comment?.table_id ?? null;
  }
  if (!tableId) throw new DoesNotExist("Trash item", itemId);
  const table = await db.prepare(
    `SELECT t.id, t.database_id, a.workspace_id
       FROM database_table t JOIN core_application a ON a.id=t.database_id
      WHERE t.id=?`
  ).bind(tableId).first<{ id: number; database_id: number; workspace_id: number }>();
  if (!table) throw new DoesNotExist("Table", tableId);
  const requiredRole = permanent ? "ADMIN" : itemType === "table" ? "BUILDER" : itemType === "row_comment" ? "COMMENTER" : "EDITOR";
  await assertHasTableRole(db, userId, table, requiredRole);
}

function normaliseNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function userName(row: any): string | null {
  return row.first_name || row.email || null;
}

function fromTrashRow(row: any): TrashEntry {
  const extra = parseTrashDescription(row.extra_description);
  const names = normaliseNames(extra.names);
  const name = typeof extra.name === "string" ? extra.name : "";
  const parentName = typeof extra.parent_name === "string" ? extra.parent_name : "";
  return {
    id: row.id,
    user_who_trashed: userName(row),
    trash_item_type: row.trash_item_type,
    trash_item_id: Number(row.trash_item_id),
    parent_trash_item_id: row.parent_trash_item_id === null ? null : Number(row.parent_trash_item_id),
    trashed_at: row.trashed_at,
    application: row.effective_application_id === null ? null : Number(row.effective_application_id),
    workspace: row.workspace_id === null ? null : Number(row.workspace_id),
    name,
    names,
    parent_name: parentName || null,
  };
}

function fallbackEntry(
  type: TrashItemType,
  id: number,
  name: string,
  trashedAt: string,
  workspaceId: number,
  applicationId: number | null,
  parentId: number | null = null,
  parentName: string | null = null
): TrashEntry {
  return {
    id: `fallback-${type}-${id}-${parentId ?? "none"}`,
    user_who_trashed: null,
    trash_item_type: type,
    trash_item_id: id,
    parent_trash_item_id: parentId,
    trashed_at: trashedAt,
    application: applicationId,
    workspace: workspaceId,
    name: name || "",
    names: [],
    parent_name: parentName || null,
  };
}

function serializeRowComment(row: any) {
  return {
    id: row.id,
    user_id: row.user_id,
    first_name: row.first_name || row.username || row.email || "",
    table_id: row.table_id,
    row_id: row.row_id,
    message: row.trashed ? null : JSON.parse(row.message || "null"),
    created_on: row.created_on,
    updated_on: row.updated_on,
    edited: row.updated_on > row.created_on,
    trashed: Boolean(row.trashed),
  };
}

async function listCanonicalTrashEntries(
  db: D1Database,
  workspaceId: number,
  applicationId: number | null
): Promise<TrashEntry[]> {
  const rows = await db.prepare(
    // The listing only needs the names from extra_description, which for rows
    // holds the whole row: keep the result small (D1 caps results at 50 MB).
    `SELECT ti.id, ti.user_id, ti.trash_item_type, ti.trash_item_id, ti.parent_trash_item_id,
            ti.trashed_at, ti.should_be_permanently_deleted, ti.application_id, ti.workspace_id,
            CASE WHEN json_valid(ti.extra_description) THEN json_object(
              'name', json_extract(ti.extra_description, '$.name'),
              'names', json(CASE WHEN json_type(ti.extra_description, '$.names')='array'
                THEN json_extract(ti.extra_description, '$.names') ELSE '[]' END),
              'parent_name', json_extract(ti.extra_description, '$.parent_name')
            ) ELSE '{}' END AS extra_description,
            u.first_name,
            u.email,
            COALESCE(
              ti.application_id,
              CASE WHEN ti.trash_item_type='application' THEN ti.trash_item_id END,
              CASE WHEN ti.trash_item_type='table' THEN ti.parent_trash_item_id END,
              pt.database_id
            ) AS effective_application_id
     FROM core_trasheditem ti
     LEFT JOIN auth_user u ON u.id=ti.user_id
     LEFT JOIN database_table pt ON pt.id=ti.parent_trash_item_id
     WHERE ti.workspace_id=?
       AND ti.should_be_permanently_deleted=0
       AND (
         ? IS NULL
         OR COALESCE(
              ti.application_id,
              CASE WHEN ti.trash_item_type='application' THEN ti.trash_item_id END,
              CASE WHEN ti.trash_item_type='table' THEN ti.parent_trash_item_id END,
              pt.database_id
            )=?
       )
     ORDER BY ti.trashed_at DESC`
  ).bind(workspaceId, applicationId, applicationId).all<any>();

  return (rows.results || []).map(fromTrashRow);
}

async function listFallbackTrashEntries(
  db: D1Database,
  workspaceId: number,
  applicationId: number | null
): Promise<TrashEntry[]> {
  const appFilter = applicationId ? "AND a.id=?" : "";
  const appParams = applicationId ? [workspaceId, applicationId] : [workspaceId];

  const [workspaces, apps, tables, fields, views, teams, automationWorkflows] = await Promise.all([
    applicationId ? Promise.resolve({ results: [] as any[] }) : db.prepare(
      `SELECT w.id, w.name, w.created_on AS trashed_at
       FROM core_workspace w
       WHERE w.id=? AND COALESCE(w.trashed, 0)=1
         AND NOT EXISTS (
           SELECT 1 FROM core_trasheditem ti
           WHERE ti.trash_item_type='workspace' AND ti.trash_item_id=w.id
         )`
    ).bind(workspaceId).all<any>(),
    applicationId ? Promise.resolve({ results: [] as any[] }) : db.prepare(
      `SELECT a.id, a.name, a.updated_on AS trashed_at, a.workspace_id
       FROM core_application a
       WHERE a.workspace_id=? AND a.trashed=1
         AND NOT EXISTS (
           SELECT 1 FROM core_trasheditem ti
           WHERE ti.trash_item_type='application' AND ti.trash_item_id=a.id
         )`
    ).bind(workspaceId).all<any>(),
    db.prepare(
      `SELECT t.id, t.name, t.updated_on AS trashed_at, t.database_id, a.workspace_id, a.name AS parent_name
       FROM database_table t
       JOIN core_application a ON a.id=t.database_id
       WHERE a.workspace_id=? ${appFilter} AND t.trashed=1
         AND NOT EXISTS (
           SELECT 1 FROM core_trasheditem ti
           WHERE ti.trash_item_type='table' AND ti.trash_item_id=t.id
         )`
    ).bind(...appParams).all<any>(),
    db.prepare(
      `SELECT f.id, f.name, f.updated_on AS trashed_at, f.table_id, t.name AS parent_name, t.database_id, a.workspace_id
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
       WHERE a.workspace_id=? ${appFilter} AND f.trashed=1
         AND NOT EXISTS (
           SELECT 1 FROM core_trasheditem ti
           WHERE ti.trash_item_type='field' AND ti.trash_item_id=f.id
         )`
    ).bind(...appParams).all<any>(),
    db.prepare(
      `SELECT v.id, v.name, v.updated_on AS trashed_at, v.table_id, t.name AS parent_name, t.database_id, a.workspace_id
       FROM database_view v
       JOIN database_table t ON t.id=v.table_id
       JOIN core_application a ON a.id=t.database_id
       WHERE a.workspace_id=? ${appFilter} AND v.trashed=1
         AND NOT EXISTS (
           SELECT 1 FROM core_trasheditem ti
           WHERE ti.trash_item_type='view' AND ti.trash_item_id=v.id
         )`
    ).bind(...appParams).all<any>(),
    applicationId ? Promise.resolve({ results: [] as any[] }) : db.prepare(
      `SELECT et.id, et.name, et.created_on AS trashed_at, et.workspace_id
       FROM enterprise_team et
       WHERE et.workspace_id=? AND et.trashed=1
         AND NOT EXISTS (
           SELECT 1 FROM core_trasheditem ti
           WHERE ti.trash_item_type='team' AND ti.trash_item_id=et.id
         )`
    ).bind(workspaceId).all<any>(),
    db.prepare(
      `SELECT wf.id, wf.name, wf.updated_on AS trashed_at, wf.automation_id,
              a.workspace_id, a.name AS parent_name
       FROM automation_workflow wf
       JOIN core_application a ON a.id=wf.automation_id
       WHERE a.workspace_id=? ${appFilter}
         AND wf.trashed=1 AND COALESCE(wf.is_published_version, 0)=0
         AND NOT EXISTS (
           SELECT 1 FROM core_trasheditem ti
           WHERE ti.trash_item_type='automation_workflow' AND ti.trash_item_id=wf.id
         )`
    ).bind(...appParams).all<any>(),
  ]);

  return [
    ...(workspaces.results || []).map((row: any) => fallbackEntry("workspace", row.id, row.name, row.trashed_at, row.id, null)),
    ...(apps.results || []).map((row: any) => fallbackEntry("application", row.id, row.name, row.trashed_at, row.workspace_id, row.id)),
    ...(tables.results || []).map((row: any) => fallbackEntry("table", row.id, row.name, row.trashed_at, row.workspace_id, row.database_id, null, row.parent_name)),
    ...(fields.results || []).map((row: any) => fallbackEntry("field", row.id, row.name, row.trashed_at, row.workspace_id, row.database_id, null, row.parent_name)),
    ...(views.results || []).map((row: any) => fallbackEntry("view", row.id, row.name, row.trashed_at, row.workspace_id, row.database_id, null, row.parent_name)),
    ...(teams.results || []).map((row: any) => fallbackEntry("team", row.id, row.name, row.trashed_at, row.workspace_id, null)),
    ...(automationWorkflows.results || []).map((row: any) => fallbackEntry(
      "automation_workflow", row.id, row.name, row.trashed_at, row.workspace_id,
      row.automation_id, null, row.parent_name
    )),
  ];
}

async function listTrashEntries(db: D1Database, workspaceId: number, applicationId: number | null): Promise<TrashEntry[]> {
  const [canonical, fallback] = await Promise.all([
    listCanonicalTrashEntries(db, workspaceId, applicationId),
    listFallbackTrashEntries(db, workspaceId, applicationId),
  ]);
  return [...canonical, ...fallback]
    .sort((a, b) => new Date(b.trashed_at).getTime() - new Date(a.trashed_at).getTime());
}

async function getTrashEntry(
  db: D1Database,
  itemType: TrashItemType,
  itemId: number,
  parentId: number | null
) {
  return db.prepare(
    `SELECT * FROM core_trasheditem
     WHERE trash_item_type=?
       AND trash_item_id=?
       AND (
         (parent_trash_item_id IS NULL AND ? IS NULL)
         OR parent_trash_item_id=?
       )
     ORDER BY id DESC LIMIT 1`
  ).bind(itemType, itemId, parentId, parentId).first<any>();
}

async function ensureFallbackEntryForRestore(
  db: D1Database,
  userId: number,
  itemType: TrashItemType,
  itemId: number,
  parentId: number | null
) {
  const existing = await getTrashEntry(db, itemType, itemId, parentId);
  if (existing) return existing;

  if (itemType === "application") {
    const app = await db.prepare("SELECT id, name, workspace_id, updated_on FROM core_application WHERE id=? AND trashed=1")
      .bind(itemId).first<any>();
    if (!app) return null;
    await recordTrashEntry(db, {
      userId,
      workspaceId: app.workspace_id,
      applicationId: app.id,
      trashItemType: "application",
      trashItemId: app.id,
      name: app.name,
      trashedAt: app.updated_on,
    });
  } else if (itemType === "table") {
    const table = await db.prepare(
      `SELECT t.id, t.name, t.database_id, t.updated_on, a.workspace_id, a.name AS parent_name
       FROM database_table t JOIN core_application a ON a.id=t.database_id
       WHERE t.id=? AND t.trashed=1`
    ).bind(itemId).first<any>();
    if (!table) return null;
    await recordTrashEntry(db, {
      userId,
      workspaceId: table.workspace_id,
      applicationId: table.database_id,
      trashItemType: "table",
      trashItemId: table.id,
      name: table.name,
      parentName: table.parent_name,
      trashedAt: table.updated_on,
    });
  } else if (itemType === "field" || itemType === "view") {
    const tableName = itemType === "field" ? "database_field" : "database_view";
    const item = await db.prepare(
      `SELECT i.id, i.name, i.table_id, i.updated_on, t.name AS parent_name, t.database_id, a.workspace_id
       FROM ${tableName} i
       JOIN database_table t ON t.id=i.table_id
       JOIN core_application a ON a.id=t.database_id
       WHERE i.id=? AND i.trashed=1`
    ).bind(itemId).first<any>();
    if (!item) return null;
    await recordTrashEntry(db, {
      userId,
      workspaceId: item.workspace_id,
      applicationId: item.database_id,
      trashItemType: itemType,
      trashItemId: item.id,
      name: item.name,
      parentName: item.parent_name,
      trashedAt: item.updated_on,
    });
  } else if (itemType === "workspace") {
    const workspace = await db.prepare("SELECT id, name, created_on FROM core_workspace WHERE id=? AND COALESCE(trashed, 0)=1")
      .bind(itemId).first<any>();
    if (!workspace) return null;
    await recordTrashEntry(db, {
      userId,
      workspaceId: workspace.id,
      applicationId: null,
      trashItemType: "workspace",
      trashItemId: workspace.id,
      name: workspace.name,
      trashedAt: workspace.created_on,
    });
  } else if (itemType === "team") {
    const team = await db.prepare("SELECT id, name, workspace_id, created_on FROM enterprise_team WHERE id=? AND trashed=1")
      .bind(itemId).first<any>();
    if (!team) return null;
    await recordTrashEntry(db, {
      userId,
      workspaceId: team.workspace_id,
      applicationId: null,
      trashItemType: "team",
      trashItemId: team.id,
      name: team.name,
      trashedAt: team.created_on,
    });
  } else if (itemType === "automation_workflow") {
    const workflow = await db.prepare(
      `SELECT wf.id, wf.name, wf.automation_id, wf.updated_on, a.workspace_id, a.name AS parent_name
       FROM automation_workflow wf
       JOIN core_application a ON a.id=wf.automation_id
       WHERE wf.id=? AND wf.trashed=1 AND COALESCE(wf.is_published_version, 0)=0`
    ).bind(itemId).first<any>();
    if (!workflow) return null;
    await recordTrashEntry(db, {
      userId,
      workspaceId: workflow.workspace_id,
      applicationId: workflow.automation_id,
      trashItemType: "automation_workflow",
      trashItemId: workflow.id,
      name: workflow.name,
      parentName: workflow.parent_name,
      trashedAt: workflow.updated_on,
    });
  } else if (itemType === "row_comment") {
    const comment = await db.prepare(
      `SELECT c.id, c.row_id, c.table_id, c.updated_on, t.name AS parent_name, t.database_id, a.workspace_id
       FROM database_rowcomment c
       JOIN database_table t ON t.id=c.table_id
       JOIN core_application a ON a.id=t.database_id
       WHERE c.id=? AND c.trashed=1`
    ).bind(itemId).first<any>();
    if (!comment) return null;
    await recordTrashEntry(db, {
      userId,
      workspaceId: comment.workspace_id,
      applicationId: comment.database_id,
      trashItemType: "row_comment",
      trashItemId: comment.id,
      name: `Row comment ${comment.id}`,
      parentName: comment.parent_name,
      extra: {
        row_id: Number(comment.row_id),
        table_id: Number(comment.table_id),
        database_id: Number(comment.database_id),
      },
      trashedAt: comment.updated_on,
    });
  }

  return getTrashEntry(db, itemType, itemId, parentId);
}

trash.get("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaces = await c.env.DB.prepare(
    `SELECT w.id, w.name, COALESCE(w.trashed, 0) AS trashed
     FROM core_workspace w
     JOIN core_workspaceuser wu ON wu.workspace_id=w.id
     WHERE wu.user_id=?
       AND (wu.to_be_deleted=0 OR COALESCE(w.trashed, 0)=1)
     ORDER BY wu.[order] ASC, w.name ASC`
  ).bind(user.id).all<any>();

  const workspaceRows = [];
  for (const workspace of workspaces.results || []) {
    try {
      await assertHasWorkspaceRole(c.env.DB, user.id, Number(workspace.id), "BUILDER");
      workspaceRows.push(workspace);
    } catch {
      // Workspaces where trash cannot be read are omitted from the selector.
    }
  }
  const workspaceIds = workspaceRows.map((workspace: any) => workspace.id);
  let applicationsByWorkspace: Record<number, any[]> = {};

  if (workspaceIds.length > 0) {
    const apps = await c.env.DB.prepare(
      `SELECT id, workspace_id, name, type, [order], trashed
       FROM core_application
       WHERE workspace_id IN (${workspaceIds.map(() => "?").join(",")})
       ORDER BY [order] ASC`
    ).bind(...workspaceIds).all<any>();

    const visibleApplications = [];
    for (const app of apps.results || []) {
      try {
        await assertHasApplicationRole(c.env.DB, user.id, Number(app.id), "BUILDER", true);
        visibleApplications.push(app);
      } catch {
        // Application trash follows the application's effective role.
      }
    }
    applicationsByWorkspace = visibleApplications.reduce((acc: Record<number, any[]>, app: any) => {
      if (!acc[app.workspace_id]) acc[app.workspace_id] = [];
      acc[app.workspace_id].push({
        id: app.id,
        name: app.name,
        type: app.type,
        order: app.order,
        trash_item_type: "application",
        trash_item_id: app.id,
        trashed: Boolean(app.trashed),
      });
      return acc;
    }, {});
  }

  return c.json({
    workspaces: workspaceRows.map((workspace: any) => ({
      id: workspace.id,
      name: workspace.name,
      type: "workspace",
      trash_item_type: "workspace",
      trash_item_id: workspace.id,
      trashed: Boolean(workspace.trashed),
      applications: applicationsByWorkspace[workspace.id] || [],
    })),
  });
});

trash.get("/workspace/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  await requireWorkspaceAccess(c.env.DB, user.id, workspaceId, "BUILDER");

  const page = Math.max(1, Number(c.req.query("page") || 1));
  const size = Math.min(100, Math.max(1, Number(c.req.query("size") || 20)));
  const applicationId = c.req.query("application_id") ? Number(c.req.query("application_id")) : null;
  const all = await listTrashEntries(c.env.DB, workspaceId, applicationId);
  const offset = (page - 1) * size;
  const results = all.slice(offset, offset + size);

  return c.json({
    count: all.length,
    next: offset + size < all.length ? page + 1 : null,
    previous: page > 1 ? page - 1 : null,
    results,
  });
});

async function restoreRow(db: D1Database, userId: number, itemId: number, parentId: number | null) {
  const item = await getTrashEntry(db, "row", itemId, parentId);
  if (!item) throw new DoesNotExist("Row", itemId);
  await assertCanManageTrashItem(db, userId, "row", itemId, item.parent_trash_item_id, false);

  const table = await db.prepare(
    `SELECT t.id, t.trashed, a.trashed AS app_trashed
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=?`
  ).bind(item.parent_trash_item_id).first<any>();
  if (!table || table.trashed || table.app_trashed) {
    throw new ValidationError("The parent table must be restored before this row.");
  }

  const extra = parseTrashDescription(item.extra_description);
  const row = extra.row || {};
  const tableId = Number(item.parent_trash_item_id);
  const tableName = `database_table_${tableId}`;
  await ensureUserTableSystemColumns(db, tableId);
  const existing = await db.prepare(`SELECT * FROM "${tableName}" WHERE id=?`)
    .bind(itemId)
    .first<Record<string, unknown>>();
  if (existing) {
    await db.prepare(`UPDATE "${tableName}" SET trashed=0 WHERE id=?`).bind(itemId).run();
    const restored = await db.prepare(`SELECT * FROM "${tableName}" WHERE id=?`).bind(itemId).first<Record<string, unknown>>();
    if (restored) await synchronizeLinkRowRelations(db, tableId, itemId, null, restored, null);
    await db.prepare("DELETE FROM core_trasheditem WHERE id=?").bind(item.id).run();
    return;
  }
  const allowed = Object.keys(row).filter((key) => (
    key === "id" ||
    key === "order" ||
    key === "_created_on" ||
    key === "_updated_on" ||
    key === "_created_by_id" ||
    key === "_last_modified_by_id" ||
    /^field_\d+$/.test(key)
  ));
  if (allowed.length === 0) throw new DoesNotExist("Row", itemId);
  const columns = [...allowed.map((key) => key === "order" ? "[order]" : `"${key}"`), "trashed"];
  const values = [...allowed.map((key) => row[key]), 0];
  await db.prepare(
    `INSERT OR REPLACE INTO "${tableName}" (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
  ).bind(...values).run();
  const restored = await db.prepare(`SELECT * FROM "${tableName}" WHERE id=?`).bind(itemId).first<Record<string, unknown>>();
  if (restored) await synchronizeLinkRowRelations(db, tableId, itemId, null, restored, null);
  await db.prepare("DELETE FROM core_trasheditem WHERE id=?").bind(item.id).run();
}

async function restoreItem(env: Env, userId: number, itemType: TrashItemType, itemId: number, parentId: number | null) {
  const db = env.DB;
  // Permissions first: the fallback entry below must never be written for a
  // user who cannot restore the item (the cleanup job would purge it).
  await assertCanManageTrashItem(db, userId, itemType, itemId, parentId, false);
  const canonicalEntry = await ensureFallbackEntryForRestore(db, userId, itemType, itemId, parentId);

  switch (itemType) {
    case "workspace": {
      const workspace = await db.prepare("SELECT id FROM core_workspace WHERE id=? AND COALESCE(trashed, 0)=1")
        .bind(itemId).first<any>();
      if (!workspace) throw new DoesNotExist("Workspace", itemId);
      // Applications trashed together with the workspace come back with it.
      // Those trashed on their own before have their own trash entry and stay.
      await db.batch([
        db.prepare("UPDATE core_workspace SET trashed=0 WHERE id=?").bind(itemId),
        db.prepare(
          `UPDATE core_application SET trashed=0, updated_on=?
           WHERE workspace_id=? AND trashed=1
             AND NOT EXISTS (
               SELECT 1 FROM core_trasheditem ti
               WHERE ti.trash_item_type='application' AND ti.trash_item_id=core_application.id
             )`
        ).bind(new Date().toISOString(), itemId),
      ]);
      await deleteTrashEntry(db, "workspace", itemId, null);
      break;
    }
    case "application": {
      const app = await db.prepare(
        `SELECT a.id, a.workspace_id, COALESCE(w.trashed, 0) AS workspace_trashed
         FROM core_application a JOIN core_workspace w ON w.id=a.workspace_id
         WHERE a.id=? AND a.trashed=1`
      ).bind(itemId).first<any>();
      if (!app) throw new DoesNotExist("Application", itemId);
      if (app.workspace_trashed) throw new ValidationError("The parent workspace must be restored before this application.");
      await db.prepare("UPDATE core_application SET trashed=0, updated_on=? WHERE id=?")
        .bind(new Date().toISOString(), itemId).run();
      await deleteTrashEntry(db, "application", itemId, null);
      break;
    }
    case "table": {
      const table = await db.prepare(
        `SELECT t.id, t.database_id, a.workspace_id, a.trashed AS app_trashed
         FROM database_table t
         JOIN core_application a ON a.id=t.database_id
         WHERE t.id=? AND t.trashed=1`
      ).bind(itemId).first<any>();
      if (!table) throw new DoesNotExist("Table", itemId);
      if (table.app_trashed) throw new ValidationError("The parent application must be restored before this table.");
      await db.prepare("UPDATE database_table SET trashed=0, updated_on=? WHERE id=?")
        .bind(new Date().toISOString(), itemId).run();
      await deleteTrashEntry(db, "table", itemId, null);
      break;
    }
    case "field": {
      const field = await db.prepare(
        `SELECT f.id, f.name, f.type, f.table_id, f.field_settings, t.trashed AS table_trashed, a.workspace_id, a.trashed AS app_trashed
         FROM database_field f
         JOIN database_table t ON t.id=f.table_id
         JOIN core_application a ON a.id=t.database_id
         WHERE f.id=? AND f.trashed=1`
      ).bind(itemId).first<any>();
      if (!field) throw new DoesNotExist("Field", itemId);
      if (field.table_trashed || field.app_trashed) throw new ValidationError("The parent table must be restored before this field.");
      const relatedFieldId = field.type === "link_row"
        ? Number(parseFieldSettings(field.field_settings).link_row_related_field_id || 0)
        : 0;
      const relatedField = relatedFieldId
        ? await db.prepare(
          `SELECT f.id, f.name, f.type, f.table_id, f.field_settings, t.trashed AS table_trashed, a.trashed AS app_trashed
           FROM database_field f
           JOIN database_table t ON t.id=f.table_id
           JOIN core_application a ON a.id=t.database_id
           WHERE f.id=? AND f.trashed=1`
        ).bind(relatedFieldId).first<any>()
        : null;
      if (relatedField?.table_trashed || relatedField?.app_trashed) {
        throw new ValidationError("The related table must be restored before this field.");
      }
      await addFieldColumn(db, field.table_id, { id: field.id, type: field.type as FieldType });
      await db.prepare("UPDATE database_field SET trashed=0, updated_on=? WHERE id=?")
        .bind(new Date().toISOString(), itemId).run();
      if (relatedField) {
        await addFieldColumn(db, relatedField.table_id, { id: relatedField.id, type: relatedField.type as FieldType });
        await db.prepare("UPDATE database_field SET trashed=0, updated_on=? WHERE id=?")
          .bind(new Date().toISOString(), relatedField.id).run();
      }
      const restoredFields = [field, relatedField].filter(Boolean) as Array<{ id: number; name: string }>;
      for (const restoredField of restoredFields) {
        await synchronizeFieldDependencies(db, restoredField.id);
        const dependants = await db.prepare(
          `SELECT DISTINCT dependant_id
           FROM database_fielddependency
           WHERE broken_reference_field_name=?`
        ).bind(restoredField.name).all<{ dependant_id: number }>();
        for (const dependency of dependants.results || []) {
          if (await revalidateComputedFieldSettings(db, dependency.dependant_id)) {
            await synchronizeFieldDependencies(db, dependency.dependant_id);
          }
        }
      }
      await revalidateDateDependencyRules(db, field.table_id);
      if (relatedField && relatedField.table_id !== field.table_id) {
        await revalidateDateDependencyRules(db, relatedField.table_id);
      }
      await deleteTrashEntry(db, "field", itemId, null);
      break;
    }
    case "view": {
      const view = await db.prepare(
        `SELECT v.id, v.table_id, t.trashed AS table_trashed, a.workspace_id, a.trashed AS app_trashed
         FROM database_view v
         JOIN database_table t ON t.id=v.table_id
         JOIN core_application a ON a.id=t.database_id
         WHERE v.id=? AND v.trashed=1`
      ).bind(itemId).first<any>();
      if (!view) throw new DoesNotExist("View", itemId);
      if (view.table_trashed || view.app_trashed) throw new ValidationError("The parent table must be restored before this view.");
      await db.prepare("UPDATE database_view SET trashed=0, updated_on=? WHERE id=?")
        .bind(new Date().toISOString(), itemId).run();
      await deleteTrashEntry(db, "view", itemId, null);
      break;
    }
    case "automation_workflow": {
      const workflow = await db.prepare(
        `SELECT wf.id, wf.automation_id, a.workspace_id, a.trashed AS app_trashed
         FROM automation_workflow wf
         JOIN core_application a ON a.id=wf.automation_id
         WHERE wf.id=? AND wf.trashed=1 AND COALESCE(wf.is_published_version, 0)=0`
      ).bind(itemId).first<any>();
      if (!workflow) throw new DoesNotExist("Automation workflow", itemId);
      if (workflow.app_trashed) {
        throw new ValidationError("The parent automation must be restored before this workflow.");
      }
      await restoreWorkflowFromTrash(db, itemId);
      await deleteTrashEntry(db, "automation_workflow", itemId, null);
      break;
    }
    case "automation_node": {
      if (!canonicalEntry) throw new DoesNotExist("Automation node", itemId);
      const extra = parseTrashDescription(canonicalEntry.extra_description);
      await restoreNodeFromTrash(db, itemId, extra);
      await deleteTrashEntry(db, "automation_node", itemId, null);
      break;
    }
    case "row":
      await restoreRow(db, userId, itemId, parentId);
      break;
    case "row_comment": {
      const comment = await db.prepare(
        `SELECT c.*, u.first_name, u.username, u.email, t.trashed AS table_trashed,
                a.workspace_id, a.trashed AS app_trashed
         FROM database_rowcomment c
         JOIN database_table t ON t.id=c.table_id
         JOIN core_application a ON a.id=t.database_id
         LEFT JOIN auth_user u ON u.id=c.user_id
         WHERE c.id=? AND c.trashed=1`
      ).bind(itemId).first<any>();
      if (!comment) throw new DoesNotExist("Row comment", itemId);
      if (comment.table_trashed || comment.app_trashed) {
        throw new ValidationError("The parent table must be restored before this row comment.");
      }
      await ensureUserTableSystemColumns(db, comment.table_id);
      const row = await db.prepare(`SELECT id FROM "database_table_${comment.table_id}" WHERE id=? AND COALESCE(trashed, 0)=0`)
        .bind(comment.row_id)
        .first<{ id: number }>();
      if (!row) throw new ValidationError("The parent row must be restored before this row comment.");
      await db.prepare("UPDATE database_rowcomment SET trashed=0, updated_on=? WHERE id=?")
        .bind(new Date().toISOString(), itemId).run();
      await deleteTrashEntry(db, "row_comment", itemId, null);
      const restored = await db.prepare(
        `SELECT c.*, u.first_name, u.username, u.email
         FROM database_rowcomment c
         LEFT JOIN auth_user u ON u.id=c.user_id
         WHERE c.id=?`
      ).bind(itemId).first<any>();
      await broadcastToWorkspace(env, comment.workspace_id, {
        type: "row_comment_restored",
        row_comment: serializeRowComment(restored || { ...comment, trashed: 0 }),
      }, { pageFilter: `table-${comment.table_id}` });
      break;
    }
    case "team": {
      const team = await db.prepare("SELECT id, workspace_id FROM enterprise_team WHERE id=? AND trashed=1")
        .bind(itemId).first<any>();
      if (!team) throw new DoesNotExist("Team", itemId);
      await db.prepare("UPDATE enterprise_team SET trashed=0 WHERE id=?")
        .bind(itemId).run();
      await deleteTrashEntry(db, "team", itemId, null);
      await broadcastPermissionsUpdated(
        env,
        team.workspace_id,
        await associatedSubjectUserIds(db, itemId, "supertask_enterprise.Team"),
      );
      break;
    }
    default:
      throw new DoesNotExist("Trash item", itemType);
  }
}

async function dropWorkspaceUserTables(db: D1Database, workspaceId: number): Promise<void> {
  const tables = await db.prepare(
    `SELECT t.id
       FROM database_table t
       JOIN core_application a ON a.id=t.database_id
      WHERE a.workspace_id=?`
  ).bind(workspaceId).all<{ id: number }>();
  for (const table of tables.results || []) {
    await db.prepare(`DROP TABLE IF EXISTS "database_table_${table.id}"`).run();
  }
}

async function dropApplicationUserTables(db: D1Database, applicationId: number): Promise<void> {
  const tables = await db.prepare("SELECT id FROM database_table WHERE database_id=?")
    .bind(applicationId)
    .all<{ id: number }>();
  for (const table of tables.results || []) {
    await db.prepare(`DROP TABLE IF EXISTS "database_table_${Number(table.id)}"`).run();
  }
}

async function deleteTableRoleAssignments(db: D1Database, tableId: number) {
  await db.prepare(
    `DELETE FROM enterprise_roleassignment
      WHERE (scope_type IN ('database_field', 'field') AND scope_id IN (SELECT id FROM database_field WHERE table_id=?))
         OR (scope_type IN ('database_view', 'view') AND scope_id IN (SELECT id FROM database_view WHERE table_id=?))
         OR (scope_type IN ('database_table', 'table') AND scope_id=?)`
  ).bind(tableId, tableId, tableId).run();
}

async function deleteApplicationRoleAssignments(db: D1Database, applicationId: number) {
  await db.prepare(
    `DELETE FROM enterprise_roleassignment
      WHERE (scope_type IN ('database_field', 'field') AND scope_id IN (
               SELECT f.id FROM database_field f JOIN database_table t ON t.id=f.table_id WHERE t.database_id=?
            ))
         OR (scope_type IN ('database_view', 'view') AND scope_id IN (
               SELECT v.id FROM database_view v JOIN database_table t ON t.id=v.table_id WHERE t.database_id=?
            ))
         OR (scope_type IN ('database_table', 'table') AND scope_id IN (SELECT id FROM database_table WHERE database_id=?))
         OR (scope_type IN ('application', 'database') AND scope_id=?)`
  ).bind(applicationId, applicationId, applicationId, applicationId).run();
}

async function deleteWorkspaceRoleAssignments(db: D1Database, workspaceId: number) {
  const applications = await db.prepare(
    `SELECT a.id FROM core_application a
     WHERE a.workspace_id=?
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  )
    .bind(workspaceId).all<{ id: number }>();
  for (const application of applications.results || []) {
    await deleteApplicationRoleAssignments(db, Number(application.id));
  }
  await db.prepare(
    `DELETE FROM enterprise_roleassignment
      WHERE (scope_type='workspace' AND scope_id=?)
         OR (subject_type='supertask_enterprise.Team' AND subject_id IN (
               SELECT id FROM enterprise_team WHERE workspace_id=?
            ))`
  ).bind(workspaceId, workspaceId).run();
}

trash.patch("/:itemType/:itemId/restore/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const itemType = c.req.param("itemType") as TrashItemType;
  const itemId = Number(c.req.param("itemId"));
  await restoreItem(c.env, user.id, itemType, itemId, c.req.query("parent_trash_item_id") ? Number(c.req.query("parent_trash_item_id")) : null);
  return c.json({ id: itemId, type: itemType, restored: true });
});

trash.patch("/restore/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    trash_item_type?: TrashItemType;
    trash_item_id?: number;
    parent_trash_item_id?: number | null;
  }>();
  const itemType = body.trash_item_type;
  const itemId = Number(body.trash_item_id);
  if (!itemType || !itemId) {
    return c.json({ error: "INVALID_RESTORE_REQUEST", detail: "trash_item_type and trash_item_id are required." }, 400);
  }
  await restoreItem(c.env, user.id, itemType, itemId, body.parent_trash_item_id ?? null);
  return c.json({ id: itemId, type: itemType, restored: true });
});

export async function permanentlyDeleteItem(env: Env, item: PermanentTrashEntry): Promise<void> {
  const db = env.DB;
  let userFileNames = new Set<string>();
  if (item.trash_item_type === "row") {
    const trashRow = await getTrashEntry(db, "row", item.trash_item_id, item.parent_trash_item_id);
    const extra = parseTrashDescription(trashRow?.extra_description);
    if (item.parent_trash_item_id !== null) {
      await ensureUserTableSystemColumns(db, item.parent_trash_item_id);
      const row = await db.prepare(`SELECT * FROM "database_table_${item.parent_trash_item_id}" WHERE id=?`)
        .bind(item.trash_item_id)
        .first<Record<string, unknown>>();
      if (row) userFileNames = collectUserFileNamesFromRecord(row);
      await db.prepare(`DELETE FROM "database_table_${item.parent_trash_item_id}" WHERE id=? AND COALESCE(trashed, 0)=1`)
        .bind(item.trash_item_id)
        .run();
    }
    if (userFileNames.size === 0 && extra.row && typeof extra.row === "object") {
      userFileNames = collectUserFileNamesFromRecord(extra.row);
    }
    await deleteTrashEntry(db, "row", item.trash_item_id, item.parent_trash_item_id);
  } else if (item.trash_item_type === "view") {
    await db.prepare("DELETE FROM enterprise_roleassignment WHERE scope_id=? AND scope_type IN ('database_view', 'view')")
      .bind(item.trash_item_id).run();
    await db.prepare("DELETE FROM database_view WHERE id=? AND trashed=1").bind(item.trash_item_id).run();
    await deleteTrashEntry(db, "view", item.trash_item_id, null);
  } else if (item.trash_item_type === "field") {
    let tableId = item.parent_trash_item_id;
    if (tableId === null) {
      const field = await db.prepare("SELECT table_id FROM database_field WHERE id=?")
        .bind(item.trash_item_id)
        .first<{ table_id: number }>();
      tableId = field?.table_id ?? null;
    }
    const field = await db.prepare("SELECT type, field_settings FROM database_field WHERE id=?")
      .bind(item.trash_item_id)
      .first<{ type: FieldType; field_settings: string | null }>();
    const relatedFieldId = field?.type === "link_row"
      ? Number(parseFieldSettings(field.field_settings).link_row_related_field_id || 0)
      : 0;
    const relatedField = relatedFieldId
      ? await db.prepare("SELECT id, table_id FROM database_field WHERE id=? AND trashed=1")
        .bind(relatedFieldId)
        .first<{ id: number; table_id: number }>()
      : null;
    if (tableId !== null) {
      userFileNames = await collectUserFileNamesFromTable(db, tableId, item.trash_item_id);
      await dropFieldColumn(db, tableId, item.trash_item_id);
    }
    if (relatedField) {
      await dropFieldColumn(db, relatedField.table_id, relatedField.id);
      await db.prepare("DELETE FROM enterprise_roleassignment WHERE scope_id=? AND scope_type IN ('database_field', 'field')")
        .bind(relatedField.id).run();
      await db.prepare("DELETE FROM database_field WHERE id=? AND trashed=1").bind(relatedField.id).run();
    }
    await db.prepare("DELETE FROM enterprise_roleassignment WHERE scope_id=? AND scope_type IN ('database_field', 'field')")
      .bind(item.trash_item_id).run();
    await db.prepare("DELETE FROM database_field WHERE id=? AND trashed=1").bind(item.trash_item_id).run();
    await deleteTrashEntry(db, "field", item.trash_item_id, null);
  } else if (item.trash_item_type === "table") {
    userFileNames = await collectUserFileNamesFromTable(db, item.trash_item_id);
    await deleteTableRoleAssignments(db, item.trash_item_id);
    await db.prepare(`DROP TABLE IF EXISTS "database_table_${item.trash_item_id}"`).run();
    await db.prepare("DELETE FROM database_table WHERE id=? AND trashed=1").bind(item.trash_item_id).run();
    await deleteTrashEntry(db, "table", item.trash_item_id, null);
  } else if (item.trash_item_type === "application") {
    userFileNames = await collectUserFileNamesFromApplication(db, item.trash_item_id);
    await deleteApplicationRoleAssignments(db, item.trash_item_id);
    await dropApplicationUserTables(db, item.trash_item_id);
    await db.prepare("DELETE FROM core_application WHERE id=? AND trashed=1").bind(item.trash_item_id).run();
    await deleteTrashEntry(db, "application", item.trash_item_id, null);
  } else if (item.trash_item_type === "automation_workflow") {
    await permanentlyDeleteWorkflow(db, item.trash_item_id);
    await deleteTrashEntry(db, "automation_workflow", item.trash_item_id, null);
  } else if (item.trash_item_type === "automation_node") {
    await permanentlyDeleteNode(db, item.trash_item_id);
    await deleteTrashEntry(db, "automation_node", item.trash_item_id, null);
  } else if (item.trash_item_type === "workspace") {
    userFileNames = await collectUserFileNamesFromWorkspace(db, item.trash_item_id);
    await deleteWorkspaceRoleAssignments(db, item.trash_item_id);
    await dropWorkspaceUserTables(db, item.trash_item_id);
    await db.prepare("DELETE FROM core_workspace WHERE id=? AND COALESCE(trashed, 0)=1").bind(item.trash_item_id).run();
    await deleteTrashEntry(db, "workspace", item.trash_item_id, null);
  } else if (item.trash_item_type === "team") {
    await db.prepare("DELETE FROM enterprise_roleassignment WHERE subject_id=? AND subject_type='supertask_enterprise.Team'")
      .bind(item.trash_item_id).run();
    await db.prepare("DELETE FROM enterprise_team WHERE id=? AND trashed=1").bind(item.trash_item_id).run();
    await deleteTrashEntry(db, "team", item.trash_item_id, null);
  } else if (item.trash_item_type === "row_comment") {
    await db.prepare("DELETE FROM database_rowcommentmention WHERE row_comment_id=?")
      .bind(item.trash_item_id).run();
    await db.prepare("DELETE FROM database_rowcomment WHERE id=? AND trashed=1")
      .bind(item.trash_item_id).run();
    await deleteTrashEntry(db, "row_comment", item.trash_item_id, null);
  }
  const fileNames = [...userFileNames];
  if (fileNames.length <= 20) {
    await deleteUnreferencedUserFiles(env, fileNames);
  } else {
    const messages: Array<{ body: JobMessage }> = [];
    for (let index = 0; index < fileNames.length; index += 20) {
      messages.push({
        body: {
          job_id: 0,
          job_type: "cleanup_user_files",
          payload: { names: fileNames.slice(index, index + 20) },
          user_id: 0,
          workspace_id: Number(item.workspace || 0),
        },
      });
    }
    for (let index = 0; index < messages.length; index += 100) {
      await env.JOBS_QUEUE.sendBatch(messages.slice(index, index + 100));
    }
  }
}

trash.delete("/workspace/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const applicationId = c.req.query("application_id") ? Number(c.req.query("application_id")) : null;
  if (applicationId) {
    await assertHasApplicationRole(c.env.DB, user.id, applicationId, "ADMIN", true);
  } else {
    await assertHasWorkspaceRole(c.env.DB, user.id, workspaceId, "ADMIN");
  }
  const items = await listTrashEntries(c.env.DB, workspaceId, applicationId);

  for (const item of items) {
    await permanentlyDeleteItem(c.env, item);
  }

  return c.json({});
});

trash.delete("/:itemType/:itemId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const itemType = c.req.param("itemType") as TrashItemType;
  const itemId = Number(c.req.param("itemId"));
  const parentId = c.req.query("parent_trash_item_id") ? Number(c.req.query("parent_trash_item_id")) : null;
  const workspaceId = c.req.query("workspace_id") ? Number(c.req.query("workspace_id")) : null;
  await assertCanManageTrashItem(c.env.DB, user.id, itemType, itemId, parentId, true);
  // Only items that are actually in the trash can be destroyed: a live table
  // or field must never be dropped through this route.
  const entry = await getTrashEntry(c.env.DB, itemType, itemId, parentId);
  if (!entry) throw new ApiError(404, "ERROR_TRASH_ITEM_DOES_NOT_EXIST", "The requested trash item does not exist.");
  await permanentlyDeleteItem(c.env, fallbackEntry(itemType, itemId, "", new Date().toISOString(), workspaceId || Number(entry.workspace_id || 0), null, parentId));
  return c.json({});
});

export { trash as trashRouter };
