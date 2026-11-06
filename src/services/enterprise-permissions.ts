import { DoesNotExist, PermissionError } from "../middleware/error";

type TableScope = {
  id: number;
  database_id: number;
  workspace_id: number;
};

type FieldScope = {
  id: number;
};

type EffectiveRoleScope = {
  workspace_id: number;
  database_id?: number | null;
  table_id?: number | null;
  view_id?: number | null;
  field_id?: number | null;
};

const ROLE_RANK: Record<string, number> = {
  ADMIN: 1,
  BUILDER: 2,
  EDITOR: 3,
  COMMENTER: 4,
  VIEWER: 5,
  READ_ONLY: 5,
  NO_ROLE_LOW_PRIORITY: 6,
  NO_ROLE: 6,
  NO_ACCESS: 99,
  NOBODY: 99,
};

const CORE_PERMISSION_ROLE: Record<string, string> = {
  ADMIN: "ADMIN",
  MEMBER: "BUILDER",
  BUILDER: "BUILDER",
  EDITOR: "EDITOR",
  COMMENTER: "COMMENTER",
  VIEWER: "VIEWER",
  NO_ROLE_LOW_PRIORITY: "NO_ROLE_LOW_PRIORITY",
  NO_ROLE: "NO_ROLE_LOW_PRIORITY",
  NO_ACCESS: "NO_ACCESS",
};

/** Values accepted for `core_workspaceuser.permissions` (Baserow core and enterprise role uids). */
export function isWorkspacePermission(value: unknown): boolean {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CORE_PERMISSION_ROLE, value);
}

function normalizeRole(value: unknown): string {
  const raw = String(value || "NO_ROLE_LOW_PRIORITY").trim();
  if (!raw) return "NO_ROLE_LOW_PRIORITY";
  if (raw === raw.toUpperCase()) return raw;
  return raw.replace(/[A-Z]/g, (match) => `_${match}`).toUpperCase().replace(/^_/, "");
}

function strongerRole(left: string, right: string): string {
  return (ROLE_RANK[normalizeRole(left)] ?? 99) <= (ROLE_RANK[normalizeRole(right)] ?? 99)
    ? normalizeRole(left)
    : normalizeRole(right);
}

function roleAllows(requiredRole: string, effectiveRole: string): boolean {
  const required = normalizeRole(requiredRole);
  const effective = normalizeRole(effectiveRole);
  if (required === "NOBODY" || effective === "NO_ACCESS") return false;
  return (ROLE_RANK[effective] ?? 99) <= (ROLE_RANK[required] ?? 99);
}

function scopeHierarchy(scope: EffectiveRoleScope): Array<Array<{ type: string; id: number }>> {
  const levels: Array<Array<{ type: string; id: number }>> = [];
  if (scope.field_id) {
    levels.push([
      { type: "database_field", id: scope.field_id },
      { type: "field", id: scope.field_id },
    ]);
  }
  if (scope.view_id) {
    levels.push([
      { type: "database_view", id: scope.view_id },
      { type: "view", id: scope.view_id },
    ]);
  }
  if (scope.table_id) {
    levels.push([
      { type: "database_table", id: scope.table_id },
      { type: "table", id: scope.table_id },
    ]);
  }
  if (scope.database_id) {
    levels.push([
      { type: "application", id: scope.database_id },
      { type: "database", id: scope.database_id },
    ]);
  }
  levels.push([{ type: "workspace", id: scope.workspace_id }]);
  return levels;
}

function scopeMatches(level: Array<{ type: string; id: number }>, row: { scope_type: string; scope_id: number }): boolean {
  return level.some((scope) => scope.type === row.scope_type && scope.id === Number(row.scope_id));
}

function canonicalScopeType(value: string): string {
  if (value === "database") return "application";
  if (value === "table") return "database_table";
  if (value === "view") return "database_view";
  if (value === "field") return "database_field";
  return value;
}

async function readableDescendantRole(
  db: D1Database,
  userId: number,
  teamIds: number[],
  scope: EffectiveRoleScope,
): Promise<boolean> {
  const descendantIds = new Map<string, Set<number>>();
  const add = (type: string, rows: Array<{ id: number }>) => {
    descendantIds.set(type, new Set(rows.map((row) => Number(row.id))));
  };

  if (!scope.database_id) {
    const applications = await db.prepare(
      `SELECT a.id FROM core_application a
       WHERE a.workspace_id=? AND a.trashed=0
         AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
    ).bind(scope.workspace_id).all<{ id: number }>();
    add("application", applications.results || []);
  }

  if (!scope.table_id) {
    const tableQuery = scope.database_id
      ? db.prepare("SELECT id FROM database_table WHERE database_id=? AND trashed=0").bind(scope.database_id)
      : db.prepare(
        `SELECT t.id FROM database_table t
          JOIN core_application a ON a.id=t.database_id
         WHERE a.workspace_id=? AND a.trashed=0 AND t.trashed=0`
      ).bind(scope.workspace_id);
    const tables = await tableQuery.all<{ id: number }>();
    add("database_table", tables.results || []);
  }

  if (!scope.view_id && !scope.field_id) {
    let views: D1Result<{ id: number }>;
    let fields: D1Result<{ id: number }>;
    if (scope.table_id) {
      [views, fields] = await Promise.all([
        db.prepare("SELECT id FROM database_view WHERE table_id=? AND trashed=0").bind(scope.table_id).all<{ id: number }>(),
        db.prepare("SELECT id FROM database_field WHERE table_id=? AND trashed=0").bind(scope.table_id).all<{ id: number }>(),
      ]);
    } else if (scope.database_id) {
      [views, fields] = await Promise.all([
        db.prepare(
          `SELECT v.id FROM database_view v JOIN database_table t ON t.id=v.table_id
           WHERE t.database_id=? AND t.trashed=0 AND v.trashed=0`
        ).bind(scope.database_id).all<{ id: number }>(),
        db.prepare(
          `SELECT f.id FROM database_field f JOIN database_table t ON t.id=f.table_id
           WHERE t.database_id=? AND t.trashed=0 AND f.trashed=0`
        ).bind(scope.database_id).all<{ id: number }>(),
      ]);
    } else {
      [views, fields] = await Promise.all([
        db.prepare(
          `SELECT v.id FROM database_view v
            JOIN database_table t ON t.id=v.table_id
            JOIN core_application a ON a.id=t.database_id
           WHERE a.workspace_id=? AND a.trashed=0 AND t.trashed=0 AND v.trashed=0`
        ).bind(scope.workspace_id).all<{ id: number }>(),
        db.prepare(
          `SELECT f.id FROM database_field f
            JOIN database_table t ON t.id=f.table_id
            JOIN core_application a ON a.id=t.database_id
           WHERE a.workspace_id=? AND a.trashed=0 AND t.trashed=0 AND f.trashed=0`
        ).bind(scope.workspace_id).all<{ id: number }>(),
      ]);
    }
    add("database_view", views.results || []);
    add("database_field", fields.results || []);
  }

  if ([...descendantIds.values()].every((ids) => ids.size === 0)) return false;

  const subjectClauses = ["(ra.subject_type='auth.User' AND ra.subject_id=?)"];
  const params: unknown[] = [userId];
  if (teamIds.length > 0) {
    subjectClauses.push(`(ra.subject_type='baserow_enterprise.Team' AND ra.subject_id IN (${teamIds.map(() => "?").join(",")}))`);
    params.push(...teamIds);
  }
  const assignments = await db.prepare(
    `SELECT r.uid, ra.subject_type, ra.scope_type, ra.scope_id
       FROM enterprise_roleassignment ra
       JOIN enterprise_role r ON r.id=ra.role_id
      WHERE ${subjectClauses.join(" OR ")}`
  ).bind(...params).all<{ uid: string; subject_type: string; scope_type: string; scope_id: number }>();

  const byScope = new Map<string, typeof assignments.results>();
  for (const row of assignments.results || []) {
    const type = canonicalScopeType(row.scope_type);
    if (!descendantIds.get(type)?.has(Number(row.scope_id))) continue;
    const key = `${type}:${row.scope_id}`;
    byScope.set(key, [...(byScope.get(key) || []), row]);
  }

  for (const rows of byScope.values()) {
    const actorRoles = rows.filter((row) => row.subject_type === "auth.User").map((row) => normalizeRole(row.uid));
    const actorRole = actorRoles.reduce<string | null>((role, next) => role ? strongerRole(role, next) : next, null);
    if (actorRole && actorRole !== "NO_ROLE_LOW_PRIORITY") {
      if (roleAllows("VIEWER", actorRole)) return true;
      continue;
    }
    const teamRoles = rows.filter((row) => row.subject_type === "baserow_enterprise.Team").map((row) => normalizeRole(row.uid));
    const teamRole = teamRoles.reduce<string | null>((role, next) => role ? strongerRole(role, next) : next, null);
    if (teamRole && roleAllows("VIEWER", teamRole)) return true;
  }
  return false;
}

/**
 * The role a user holds on a scope. When nothing grants access to the scope
 * itself, a readable descendant (e.g. a view of a table) still yields READ_ONLY
 * unless `descendantFallback` is off.
 */
async function effectiveRole(
  db: D1Database,
  userId: number,
  scope: EffectiveRoleScope,
  descendantFallback = true,
): Promise<string> {
  const hierarchy = scopeHierarchy(scope);
  const flatScopes = hierarchy.flat();

  // Team assignments are matched through a sub-select on the user's teams in this
  // workspace, so the membership, team and assignment reads are independent and
  // can share a single D1 round trip instead of three sequential ones.
  const params: unknown[] = [userId, scope.workspace_id, userId];
  const scopeClauses = flatScopes.map(() => "(ra.scope_type=? AND ra.scope_id=?)").join(" OR ");
  for (const item of flatScopes) params.push(item.type, item.id);

  const [membership, teamRows, assignments] = await Promise.all([
    db.prepare(
      "SELECT permissions FROM core_workspaceuser WHERE user_id=? AND workspace_id=? AND to_be_deleted=0"
    ).bind(userId, scope.workspace_id).first<{ permissions: string }>(),
    db.prepare(
      `SELECT t.id, t.default_role_uid
         FROM enterprise_team t
         JOIN enterprise_teamsubject ts ON ts.team_id=t.id
        WHERE t.workspace_id=? AND t.trashed=0 AND ts.subject_id=? AND ts.subject_type='auth.User'`
    ).bind(scope.workspace_id, userId).all<{ id: number; default_role_uid: string | null }>(),
    db.prepare(
      `SELECT r.uid, ra.subject_type, ra.subject_id, ra.scope_type, ra.scope_id
         FROM enterprise_roleassignment ra
         JOIN enterprise_role r ON r.id=ra.role_id
        WHERE ((ra.subject_type='auth.User' AND ra.subject_id=?)
           OR (ra.subject_type='baserow_enterprise.Team' AND ra.subject_id IN (
                SELECT ts.team_id
                  FROM enterprise_teamsubject ts
                  JOIN enterprise_team t ON t.id=ts.team_id
                 WHERE t.workspace_id=? AND t.trashed=0 AND ts.subject_id=? AND ts.subject_type='auth.User'
              )))
          AND (${scopeClauses})`
    ).bind(...params).all<{ uid: string; subject_type: string; subject_id: number; scope_type: string; scope_id: number }>(),
  ]);
  if (!membership) throw new PermissionError("Access denied.");

  const coreWorkspaceRole = CORE_PERMISSION_ROLE[membership.permissions] || "NO_ROLE_LOW_PRIORITY";
  const teamIds = (teamRows.results || []).map((team) => Number(team.id));

  const rows = assignments.results || [];

  let resolvedRole: string | null = null;
  for (const level of hierarchy) {
    let actorRole: string | null = null;
    for (const row of rows) {
      if (row.subject_type === "auth.User" && scopeMatches(level, row)) {
        actorRole = actorRole ? strongerRole(actorRole, row.uid) : normalizeRole(row.uid);
      }
    }
    if (level.some((item) => item.type === "workspace" && item.id === scope.workspace_id) && !actorRole) {
      actorRole = coreWorkspaceRole;
    }
    if (actorRole && normalizeRole(actorRole) !== "NO_ROLE_LOW_PRIORITY") {
      resolvedRole = normalizeRole(actorRole);
      break;
    }

    let teamRole: string | null = null;
    for (const row of rows) {
      if (row.subject_type === "baserow_enterprise.Team" && scopeMatches(level, row)) {
        teamRole = teamRole ? strongerRole(teamRole, row.uid) : normalizeRole(row.uid);
      }
    }
    if (level.some((item) => item.type === "workspace" && item.id === scope.workspace_id)) {
      for (const team of teamRows.results || []) {
        if (team.default_role_uid) teamRole = teamRole ? strongerRole(teamRole, team.default_role_uid) : normalizeRole(team.default_role_uid);
      }
    }
    if (teamRole) {
      resolvedRole = normalizeRole(teamRole);
      break;
    }
    if (actorRole) {
      resolvedRole = normalizeRole(actorRole);
      break;
    }
  }

  resolvedRole ||= normalizeRole(coreWorkspaceRole);
  if (descendantFallback && !roleAllows("VIEWER", resolvedRole) && await readableDescendantRole(db, userId, teamIds, scope)) {
    return "READ_ONLY";
  }
  return resolvedRole;
}

/**
 * Resolves to `read` once `check` passed. Both run concurrently so a cheap,
 * side-effect-free read doesn't wait for the permission round trips; its
 * result (or failure) is only exposed when access is granted.
 */
export async function readAfterAccessCheck<T>(check: Promise<unknown>, read: Promise<T>): Promise<T> {
  read.catch(() => undefined);
  await check;
  return read;
}

export async function assertHasWorkspaceRole(
  db: D1Database,
  userId: number | undefined,
  workspaceId: number,
  requiredRole: string,
): Promise<void> {
  if (!userId) throw new PermissionError("Access denied.");
  const effective = await effectiveRole(db, userId, { workspace_id: workspaceId });
  if (!roleAllows(requiredRole, effective)) throw new PermissionError("Insufficient permissions.");
}

export async function assertHasApplicationRole(
  db: D1Database,
  userId: number | undefined,
  applicationId: number,
  requiredRole: string,
  includeTrashed = false,
): Promise<{ id: number; workspace_id: number }> {
  if (!userId) throw new PermissionError("Access denied.");
  const application = await db.prepare(
    `SELECT a.id, a.workspace_id FROM core_application a
     WHERE a.id=?${includeTrashed ? "" : " AND a.trashed=0"}
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  ).bind(applicationId).first<{ id: number; workspace_id: number }>();
  if (!application) throw new PermissionError("Access denied.");
  if (!(await hasLoadedApplicationRole(db, userId, application, requiredRole))) {
    throw new PermissionError("Insufficient permissions.");
  }
  return application;
}

/**
 * Checks a role on an application row the caller already loaded with the same
 * visibility filters as assertHasApplicationRole (not trashed, not a published
 * builder copy). List endpoints use it to avoid re-reading each application.
 */
export async function hasLoadedApplicationRole(
  db: D1Database,
  userId: number,
  application: { id: number; workspace_id: number },
  requiredRole: string,
): Promise<boolean> {
  try {
    const effective = await effectiveRole(db, userId, {
      workspace_id: Number(application.workspace_id),
      database_id: Number(application.id),
    });
    return roleAllows(requiredRole, effective);
  } catch (error) {
    if (error instanceof PermissionError) return false;
    throw error;
  }
}

export async function assertHasFieldRole(
  db: D1Database,
  userId: number | undefined,
  fieldId: number,
  requiredRole: string,
  includeTrashed = false,
): Promise<{ id: number; table_id: number; database_id: number; workspace_id: number }> {
  if (!userId) throw new PermissionError("Access denied.");
  const field = await db.prepare(
    `SELECT f.id, f.table_id, t.database_id, a.workspace_id
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
      WHERE f.id=?${includeTrashed ? "" : " AND f.trashed=0"} AND t.trashed=0 AND a.trashed=0`
  ).bind(fieldId).first<{ id: number; table_id: number; database_id: number; workspace_id: number }>();
  if (!field) throw new PermissionError("Access denied.");
  const effective = await effectiveRole(db, userId, {
    workspace_id: field.workspace_id,
    database_id: field.database_id,
    table_id: field.table_id,
    field_id: field.id,
  });
  if (!roleAllows(requiredRole, effective)) throw new PermissionError("Insufficient permissions.");
  return field;
}

export async function assertHasTableRole(
  db: D1Database,
  userId: number | undefined,
  table: TableScope,
  requiredRole: string,
): Promise<void> {
  if (!userId) throw new PermissionError("Access denied.");
  const effective = await effectiveRole(db, userId, {
    workspace_id: table.workspace_id,
    database_id: table.database_id,
    table_id: table.id,
  });
  if (!roleAllows(requiredRole, effective)) throw new PermissionError("Insufficient permissions.");
}

/** Loads a live table's scope and asserts the role; unknown or trashed tables are 404. */
export async function assertHasTableRoleById(
  db: D1Database,
  userId: number | undefined,
  tableId: number,
  requiredRole: string,
): Promise<TableScope> {
  const table = Number.isInteger(tableId) && tableId > 0
    ? await db.prepare(
      `SELECT t.id, t.database_id, a.workspace_id
       FROM database_table t
       JOIN core_application a ON a.id = t.database_id
       WHERE t.id = ? AND t.trashed = 0 AND a.trashed = 0`
    ).bind(tableId).first<TableScope>()
    : null;
  if (!table) throw new DoesNotExist("Table", tableId);
  await assertHasTableRole(db, userId, table, requiredRole);
  return table;
}

/** Ids among `ids` that have a role assignment on their own scope. */
async function idsWithOwnRoleAssignment(
  db: D1Database,
  scopeTypes: [string, string],
  ids: number[],
): Promise<Set<number>> {
  const unique = [...new Set(ids)];
  const chunks: number[][] = [];
  for (let offset = 0; offset < unique.length; offset += 90) chunks.push(unique.slice(offset, offset + 90));
  const results = await Promise.all(chunks.map((chunk) => db.prepare(
    `SELECT DISTINCT scope_id FROM enterprise_roleassignment
      WHERE scope_type IN (?, ?) AND scope_id IN (${chunk.map(() => "?").join(",")})`
  ).bind(...scopeTypes, ...chunk).all<{ scope_id: number }>()));
  return new Set(results.flatMap((rows) => (rows.results || []).map((row) => Number(row.scope_id))));
}

function noAccessOnPermissionError(error: unknown): string {
  if (error instanceof PermissionError) return "NO_ACCESS";
  throw error;
}

/**
 * Fields of a table the user may see, for a caller that already checked the
 * table role. A field only differs from its table when a field-scope role is
 * assigned to it, so one query finds those and only they get a full check.
 */
export async function fieldsWithRole<T extends { id: number }>(
  db: D1Database,
  userId: number,
  table: TableScope,
  fields: T[],
  requiredRole: string,
): Promise<T[]> {
  const restricted = await idsWithOwnRoleAssignment(db, ["database_field", "field"], fields.map((field) => Number(field.id)));
  const allowed = await Promise.all(fields.map(async (field) => {
    if (!restricted.has(Number(field.id))) return true;
    const role = await effectiveRole(db, userId, {
      workspace_id: table.workspace_id,
      database_id: table.database_id,
      table_id: table.id,
      field_id: Number(field.id),
    }).catch(noAccessOnPermissionError);
    return roleAllows(requiredRole, role);
  }));
  return fields.filter((_, index) => allowed[index]);
}

/**
 * Collaborative or own personal views of a live table that the user may see,
 * resolved in one round trip. A view only resolves differently from its table
 * when a view-scope role is assigned to it, so only those get a full check;
 * the others take the table's role without the descendant fallback, exactly as
 * a per-view check would.
 */
export async function viewsWithRole<T extends { id: number; ownership_type?: string | null; owned_by_id?: number | null }>(
  db: D1Database,
  userId: number | undefined,
  table: TableScope,
  views: T[],
  requiredRole: string,
): Promise<T[]> {
  if (!userId) return [];
  const candidates = views.filter((view) => view.ownership_type !== "personal" || Number(view.owned_by_id) === userId);
  if (candidates.length === 0) return [];
  const tableScope = { workspace_id: table.workspace_id, database_id: table.database_id, table_id: table.id };
  const [restricted, tableRole] = await Promise.all([
    idsWithOwnRoleAssignment(db, ["database_view", "view"], candidates.map((view) => Number(view.id))),
    effectiveRole(db, userId, tableScope, false).catch(noAccessOnPermissionError),
  ]);
  const allowed = await Promise.all(candidates.map(async (view) => {
    if (!restricted.has(Number(view.id))) return roleAllows(requiredRole, tableRole);
    const role = await effectiveRole(db, userId, { ...tableScope, view_id: Number(view.id) })
      .catch(noAccessOnPermissionError);
    return roleAllows(requiredRole, role);
  }));
  return candidates.filter((_, index) => allowed[index]);
}

export async function assertHasViewRole(
  db: D1Database,
  userId: number | undefined,
  viewId: number,
  requiredRole: string,
  includeTrashed = false,
): Promise<{ id: number; table_id: number; database_id: number; workspace_id: number }> {
  if (!userId) throw new PermissionError("Access denied.");
  const view = await db.prepare(
    `SELECT v.id, v.table_id, v.ownership_type, v.owned_by_id, t.database_id, a.workspace_id
       FROM database_view v
       JOIN database_table t ON t.id=v.table_id
       JOIN core_application a ON a.id=t.database_id
      WHERE v.id=?${includeTrashed ? "" : " AND v.trashed=0"} AND t.trashed=0 AND a.trashed=0`
  ).bind(viewId).first<{ id: number; table_id: number; ownership_type: string; owned_by_id: number | null; database_id: number; workspace_id: number }>();
  if (!view) throw new PermissionError("Access denied.");
  await assertHasLoadedViewRole(db, userId, view, requiredRole);
  return view;
}

/**
 * assertHasViewRole for a view the caller already loaded, with its table and
 * application known to be live.
 */
export async function assertHasLoadedViewRole(
  db: D1Database,
  userId: number | undefined,
  view: { id: number; table_id: number; ownership_type?: string | null; owned_by_id?: number | null; database_id: number; workspace_id: number },
  requiredRole: string,
): Promise<void> {
  if (!userId) throw new PermissionError("Access denied.");
  if (view.ownership_type === "personal" && Number(view.owned_by_id) !== userId) {
    throw new PermissionError("The user does not own this personal view.");
  }
  const effective = await effectiveRole(db, userId, {
    workspace_id: Number(view.workspace_id),
    database_id: Number(view.database_id),
    table_id: Number(view.table_id),
    view_id: Number(view.id),
  });
  if (!roleAllows(requiredRole, effective)) throw new PermissionError("Insufficient permissions.");
}

export async function assertCanWriteFieldValues(
  db: D1Database,
  userId: number | undefined,
  table: TableScope,
  fields: FieldScope[],
): Promise<void> {
  if (fields.length === 0) return;
  if (!userId) throw new PermissionError("Access denied.");

  // One query finds the latest permission of every written field; the
  // effective role is only computed for the (rare) restricted fields.
  const fieldIds = [...new Set(fields.map((field) => Number(field.id)))];
  const restricted: Array<{ field_id: number; role_uid: string; allow_write: number }> = [];
  for (let offset = 0; offset < fieldIds.length; offset += 90) {
    const chunk = fieldIds.slice(offset, offset + 90);
    const rows = await db.prepare(
      `SELECT p.field_id, p.role_uid, p.allow_write
         FROM enterprise_fieldpermission p
        WHERE p.field_id IN (${chunk.map(() => "?").join(",")})
          AND p.id = (SELECT MAX(latest.id) FROM enterprise_fieldpermission latest WHERE latest.field_id = p.field_id)`
    ).bind(...chunk).all<{ field_id: number; role_uid: string; allow_write: number }>();
    restricted.push(...(rows.results || []));
  }
  for (const permission of restricted) {
    const allowed = permission.allow_write && normalizeRole(permission.role_uid) !== "NOBODY" && roleAllows(
      permission.role_uid,
      await effectiveRole(db, userId, {
        workspace_id: table.workspace_id,
        database_id: table.database_id,
        table_id: table.id,
        field_id: Number(permission.field_id),
      }),
    );
    if (!allowed) throw new PermissionError("You do not have permission to write values for this field.");
  }
}

export async function canWriteFieldValue(
  db: D1Database,
  userId: number,
  table: TableScope,
  fieldId: number,
): Promise<boolean> {
  const permission = await db.prepare(
    `SELECT role_uid, allow_write
       FROM enterprise_fieldpermission
      WHERE field_id=?
      ORDER BY id DESC
      LIMIT 1`
  ).bind(fieldId).first<{ role_uid: string; allow_write: number }>();
  if (!permission) return true;
  if (!permission.allow_write || normalizeRole(permission.role_uid) === "NOBODY") return false;
  const userRole = await effectiveRole(db, userId, {
    workspace_id: table.workspace_id,
    database_id: table.database_id,
    table_id: table.id,
    field_id: fieldId,
  });
  return roleAllows(permission.role_uid, userRole);
}
