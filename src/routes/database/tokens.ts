import { Hono } from "hono";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware } from "../../middleware/auth";
import { DoesNotExist, ValidationError } from "../../middleware/error";
import { assertHasApplicationRole, assertHasTableRole, assertHasWorkspaceRole } from "../../services/enterprise-permissions";

const tokens = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireWorkspaceAccess(db: D1Database, userId: number, workspaceId: number, requiredRole = "VIEWER") {
  await assertHasWorkspaceRole(db, userId, workspaceId, requiredRole);
}

async function getWorkspaceForApp(db: D1Database, appId: number) {
  const app = await db.prepare(
    "SELECT id, workspace_id FROM core_application WHERE id=? AND trashed=0"
  ).bind(appId).first<any>();
  if (!app) throw new DoesNotExist("Application", appId);
  return app;
}

async function getTableScope(db: D1Database, tableId: number) {
  const table = await db.prepare(
    `SELECT t.id, t.database_id, a.workspace_id
       FROM database_table t
       JOIN core_application a ON a.id=t.database_id
      WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
  ).bind(tableId).first<{ id: number; database_id: number; workspace_id: number }>();
  if (!table) throw new DoesNotExist("Table", tableId);
  return table;
}

async function validateTokenPermissions(
  db: D1Database,
  userId: number,
  workspaceId: number,
  permissions: Record<string, boolean | Array<[string, number]>>
) {
  for (const operation of ["create", "read", "update", "delete"]) {
    const value = permissions[operation];
    if (value === true) {
      await requireWorkspaceAccess(db, userId, workspaceId, "BUILDER");
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const permission of value) {
      const [scopeType, id] = permission;
      if (scopeType === "database") {
        const app = await getWorkspaceForApp(db, Number(id));
        if (Number(app.workspace_id) !== workspaceId) throw new ValidationError("Token permission database must belong to this workspace.");
        await assertHasApplicationRole(db, userId, Number(id), "BUILDER");
      } else if (scopeType === "table") {
        const table = await getTableScope(db, Number(id));
        if (Number(table.workspace_id) !== workspaceId) throw new ValidationError("Token permission table must belong to this workspace.");
        await assertHasTableRole(db, userId, table, "BUILDER");
      } else {
        throw new ValidationError("Token permission scope must be table or database.");
      }
    }
  }
}

function serializeToken(t: any): object {
  const permissions = t.permissions || {
    create: false,
    read: false,
    update: false,
    delete: false,
  };

  return {
    id: t.id,
    name: t.name,
    workspace: t.workspace_id,
    key: t.key,
    active: Boolean(t.active),
    created: t.created_on,
    permissions,
  };
}

async function getTokenPermissions(db: D1Database, tokenId: number) {
  const rows = await db.prepare(
    "SELECT type, table_id, database_id FROM database_tokenpermission WHERE token_id=? ORDER BY id ASC"
  )
    .bind(tokenId)
    .all<any>();

  const permissions: Record<string, boolean | Array<[string, number]>> = {
    create: false,
    read: false,
    update: false,
    delete: false,
  };

  for (const operation of Object.keys(permissions)) {
    const matches = (rows.results || []).filter((row: any) => row.type === operation);
    if (matches.some((row: any) => row.table_id === null && row.database_id === null)) {
      permissions[operation] = true;
      continue;
    }
    permissions[operation] = matches.map((row: any) => {
      if (row.table_id !== null && row.table_id !== undefined) return ["table", row.table_id] as [string, number];
      return ["database", row.database_id] as [string, number];
    });
  }

  return permissions;
}

async function serializeTokenWithPermissions(db: D1Database, token: any) {
  return serializeToken({
    ...token,
    permissions: await getTokenPermissions(db, token.id),
  });
}

async function replaceTokenPermissions(
  db: D1Database,
  tokenId: number,
  permissions: Record<string, boolean | Array<[string, number]>>
) {
  await db.prepare("DELETE FROM database_tokenpermission WHERE token_id=?").bind(tokenId).run();

  const statements: D1PreparedStatement[] = [];
  for (const operation of ["create", "read", "update", "delete"]) {
    const value = permissions[operation];
    if (value === true) {
      statements.push(
        db.prepare(
          "INSERT INTO database_tokenpermission (token_id, type, table_id, database_id) VALUES (?, ?, NULL, NULL)"
        ).bind(tokenId, operation)
      );
    } else if (Array.isArray(value)) {
      for (const permission of value) {
        const [scopeType, id] = permission;
        statements.push(
          db.prepare(
            "INSERT INTO database_tokenpermission (token_id, type, table_id, database_id) VALUES (?, ?, ?, ?)"
          ).bind(tokenId, operation, scopeType === "table" ? id : null, scopeType === "database" ? id : null)
        );
      }
    }
  }

  if (statements.length > 0) await db.batch(statements);
}

// ── GET /api/database/tokens/ — List tokens for user ─────────────────────────
tokens.get("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const res = await c.env.DB.prepare("SELECT * FROM database_token WHERE user_id=?")
    .bind(user.id).all<any>();
  const visible = [];
  for (const token of res.results || []) {
    try {
      await requireWorkspaceAccess(c.env.DB, user.id, token.workspace_id, "VIEWER");
      visible.push(token);
    } catch {
      // Do not leak tokens from workspaces that are no longer visible.
    }
  }
  const serialized = await Promise.all(visible.map((token) => serializeTokenWithPermissions(c.env.DB, token)));
  return c.json(serialized);
});

// ── POST /api/database/tokens/ — Create token ────────────────────────────────
tokens.post("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    name: string;
    database?: number;
    workspace?: number;
    permissions?: Record<string, boolean | Array<[string, number]>>;
  }>();

  if (!body.name) throw new ValidationError("name is required.");

  let workspaceId: number;
  if (body.database) {
    const app = await getWorkspaceForApp(c.env.DB, body.database);
    workspaceId = app.workspace_id;
  } else if (body.workspace) {
    workspaceId = body.workspace;
  } else {
    throw new ValidationError("database or workspace is required.");
  }

  await requireWorkspaceAccess(c.env.DB, user.id, workspaceId, "BUILDER");
  const requestedPermissions = body.permissions || {
    create: false,
    read: false,
    update: false,
    delete: false,
  };
  await validateTokenPermissions(c.env.DB, user.id, workspaceId, requestedPermissions);

  const key = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();

  const res = await c.env.DB.prepare(
    `INSERT INTO database_token (name, workspace_id, user_id, key, active, created_on)
     VALUES (?,?,?,?,1,?) RETURNING *`
  ).bind(body.name, workspaceId, user.id, key, now)
    .first<any>();

  await replaceTokenPermissions(c.env.DB, res!.id, requestedPermissions);

  return c.json(await serializeTokenWithPermissions(c.env.DB, res!), 200);
});

// ── GET /api/database/tokens/:tokenId/ ───────────────────────────────────────
tokens.get("/:tokenId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("tokenId"));
  const t = await c.env.DB.prepare("SELECT * FROM database_token WHERE id=? AND user_id=?")
    .bind(id, user.id).first<any>();
  if (!t) throw new DoesNotExist("Token", id);
  await requireWorkspaceAccess(c.env.DB, user.id, t.workspace_id, "VIEWER");
  return c.json(await serializeTokenWithPermissions(c.env.DB, t));
});

// ── PATCH /api/database/tokens/:tokenId/ — Rename ────────────────────────────
tokens.patch("/:tokenId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("tokenId"));
  const t = await c.env.DB.prepare("SELECT * FROM database_token WHERE id=? AND user_id=?")
    .bind(id, user.id).first<any>();
  if (!t) throw new DoesNotExist("Token", id);
  await requireWorkspaceAccess(c.env.DB, user.id, t.workspace_id, "BUILDER");

  const body = await c.req.json<any>();
  if (body.name !== undefined) {
    await c.env.DB.prepare("UPDATE database_token SET name=? WHERE id=?")
      .bind(body.name, id).run();
  }
  if (body.rotate_key === true) {
    const newKey = crypto.randomUUID().replace(/-/g, "");
    await c.env.DB.prepare("UPDATE database_token SET key=? WHERE id=?")
      .bind(newKey, id).run();
  }
  if (body.permissions !== undefined) {
    await validateTokenPermissions(c.env.DB, user.id, t.workspace_id, body.permissions);
    await replaceTokenPermissions(c.env.DB, id, body.permissions);
  }

  const updated = await c.env.DB.prepare("SELECT * FROM database_token WHERE id=?")
    .bind(id).first<any>();
  return c.json(await serializeTokenWithPermissions(c.env.DB, updated!));
});

// ── DELETE /api/database/tokens/:tokenId/ ────────────────────────────────────
tokens.delete("/:tokenId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("tokenId"));
  const t = await c.env.DB.prepare("SELECT * FROM database_token WHERE id=? AND user_id=?")
    .bind(id, user.id).first<any>();
  if (!t) throw new DoesNotExist("Token", id);
  await requireWorkspaceAccess(c.env.DB, user.id, t.workspace_id, "BUILDER");
  await c.env.DB.prepare("DELETE FROM database_token WHERE id=?").bind(id).run();
  return c.json({});
});

// ── POST /api/database/tokens/:tokenId/regenerate/ ───────────────────────────
tokens.post("/:tokenId/regenerate/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("tokenId"));
  const t = await c.env.DB.prepare("SELECT * FROM database_token WHERE id=? AND user_id=?")
    .bind(id, user.id).first<any>();
  if (!t) throw new DoesNotExist("Token", id);
  await requireWorkspaceAccess(c.env.DB, user.id, t.workspace_id, "BUILDER");

  const newKey = crypto.randomUUID().replace(/-/g, "");
  await c.env.DB.prepare("UPDATE database_token SET key=? WHERE id=?")
    .bind(newKey, id).run();

  const updated = await c.env.DB.prepare("SELECT * FROM database_token WHERE id=?")
    .bind(id).first<any>();
  return c.json(await serializeTokenWithPermissions(c.env.DB, updated!));
});

export { tokens as tokenRouter };
