import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { DoesNotExist, ValidationError } from "../middleware/error";
import { hashPassword } from "../services/user";
import { installAdminAuthProviderRoutes } from "./enterprise";
import { logAuditEntry } from "../services/audit-log";

const r = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
installAdminAuthProviderRoutes(r);

function pageParams(c: any) {
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const size = Math.min(100, Math.max(1, Number(c.req.query("size") || 20)));
  return { page, size, offset: (page - 1) * size };
}

function parseSort(value: string | undefined, allowed: Record<string, string>, fallback: string) {
  if (!value) return fallback;
  const first = value.split(",")[0];
  const desc = first.startsWith("-");
  const key = first.replace(/^[-+]/, "");
  return allowed[key] ? `${allowed[key]} ${desc ? "DESC" : "ASC"}` : fallback;
}

async function userPayload(db: D1Database, user: any) {
  const workspaces = await db.prepare(
    `SELECT w.id, w.name, wu.permissions
     FROM core_workspaceuser wu
     JOIN core_workspace w ON w.id=wu.workspace_id
     WHERE wu.user_id=? AND wu.to_be_deleted=0
     ORDER BY w.name`
  ).bind(user.id).all<any>();

  return {
    id: user.id,
    username: user.username,
    name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    is_active: Boolean(user.is_active),
    is_staff: Boolean(user.is_staff),
    last_login: user.last_login,
    date_joined: user.date_joined,
    workspaces: workspaces.results || [],
  };
}

r.get("/dashboard/", authMiddleware, adminMiddleware, async (c) => {
  const now = Date.now();
  const iso = (daysAgo: number) => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const count = async (sql: string, ...params: unknown[]) => {
    const row = await c.env.DB.prepare(sql).bind(...params).first<{ count: number }>();
    return row?.count || 0;
  };
  const newUsersPerDay = [];
  const activeUsersPerDay = [];
  for (let i = 29; i >= 0; i--) {
    const start = iso(i + 1);
    const end = iso(i);
    newUsersPerDay.push({
      date: end.slice(0, 10),
      count: await count("SELECT COUNT(*) AS count FROM auth_user WHERE date_joined >= ? AND date_joined < ?", start, end),
    });
    activeUsersPerDay.push({
      date: end.slice(0, 10),
      count: await count("SELECT COUNT(*) AS count FROM auth_user WHERE last_login >= ? AND last_login < ?", start, end),
    });
  }

  return c.json({
    total_users: await count("SELECT COUNT(*) AS count FROM auth_user"),
    total_workspaces: await count("SELECT COUNT(*) AS count FROM core_workspace"),
    total_applications: await count(
      `SELECT COUNT(*) AS count FROM core_application a
       WHERE a.trashed=0
         AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
    ),
    new_users_last_24_hours: await count("SELECT COUNT(*) AS count FROM auth_user WHERE date_joined >= ?", iso(1)),
    new_users_last_7_days: await count("SELECT COUNT(*) AS count FROM auth_user WHERE date_joined >= ?", iso(7)),
    new_users_last_30_days: await count("SELECT COUNT(*) AS count FROM auth_user WHERE date_joined >= ?", iso(30)),
    active_users_last_24_hours: await count("SELECT COUNT(*) AS count FROM auth_user WHERE last_login >= ?", iso(1)),
    active_users_last_7_days: await count("SELECT COUNT(*) AS count FROM auth_user WHERE last_login >= ?", iso(7)),
    active_users_last_30_days: await count("SELECT COUNT(*) AS count FROM auth_user WHERE last_login >= ?", iso(30)),
    previous_new_users_last_24_hours: await count("SELECT COUNT(*) AS count FROM auth_user WHERE date_joined >= ? AND date_joined < ?", iso(2), iso(1)),
    previous_new_users_last_7_days: await count("SELECT COUNT(*) AS count FROM auth_user WHERE date_joined >= ? AND date_joined < ?", iso(14), iso(7)),
    previous_new_users_last_30_days: await count("SELECT COUNT(*) AS count FROM auth_user WHERE date_joined >= ? AND date_joined < ?", iso(60), iso(30)),
    previous_active_users_last_24_hours: await count("SELECT COUNT(*) AS count FROM auth_user WHERE last_login >= ? AND last_login < ?", iso(2), iso(1)),
    previous_active_users_last_7_days: await count("SELECT COUNT(*) AS count FROM auth_user WHERE last_login >= ? AND last_login < ?", iso(14), iso(7)),
    previous_active_users_last_30_days: await count("SELECT COUNT(*) AS count FROM auth_user WHERE last_login >= ? AND last_login < ?", iso(60), iso(30)),
    new_users_per_day: newUsersPerDay,
    active_users_per_day: activeUsersPerDay,
  });
});

r.get("/users/", authMiddleware, adminMiddleware, async (c) => {
  const { size, offset } = pageParams(c);
  const search = c.req.query("search") || "";
  const order = parseSort(c.req.query("sorts"), {
    username: "username",
    name: "first_name",
    last_login: "last_login",
    date_joined: "date_joined",
    is_active: "is_active",
  }, "date_joined DESC");
  const where = search ? "WHERE email LIKE ? OR username LIKE ? OR first_name LIKE ? OR last_name LIKE ?" : "";
  const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : [];
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM auth_user ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const res = await c.env.DB.prepare(
    `SELECT * FROM auth_user ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(...params, size, offset).all<any>();
  return c.json({
    count: total?.count || 0,
    results: await Promise.all((res.results || []).map((user) => userPayload(c.env.DB, user))),
  });
});

r.patch("/users/:userId/", authMiddleware, adminMiddleware, async (c) => {
  const user = c.get("user")!;
  const userId = Number(c.req.param("userId"));
  const body = await c.req.json<Record<string, unknown>>();
  const existing = await c.env.DB.prepare("SELECT * FROM auth_user WHERE id=?").bind(userId).first<any>();
  if (!existing) throw new DoesNotExist("User", userId);

  const updates: string[] = [];
  const values: unknown[] = [];
  for (const field of ["first_name", "last_name", "email", "username"] as const) {
    if (field in body) {
      updates.push(`${field}=?`);
      values.push(String(body[field] || ""));
    }
  }
  for (const field of ["is_active", "is_staff"] as const) {
    if (field in body) {
      updates.push(`${field}=?`);
      values.push(body[field] ? 1 : 0);
    }
  }
  if ("password" in body && body.password) {
    if (String(body.password).length < 8) throw new ValidationError("Password must be at least 8 characters.");
    updates.push("password=?");
    values.push(await hashPassword(String(body.password)));
  }
  if (updates.length > 0) {
    values.push(userId);
    await c.env.DB.prepare(`UPDATE auth_user SET ${updates.join(", ")} WHERE id=?`).bind(...values).run();
  }
  const updated = await c.env.DB.prepare("SELECT * FROM auth_user WHERE id=?").bind(userId).first<any>();
  await logAuditEntry(c.env.DB, "admin.user.update", {
    user,
  }, { id: userId, type: "user" }, {
    user_id: userId,
    email: updated?.email || existing.email,
    changed_fields: Object.keys(body).filter((field) => field !== "password"),
    password_changed: Boolean(body.password),
    before: {
      first_name: existing.first_name,
      last_name: existing.last_name,
      email: existing.email,
      username: existing.username,
      is_active: Boolean(existing.is_active),
      is_staff: Boolean(existing.is_staff),
    },
    after: {
      first_name: updated?.first_name,
      last_name: updated?.last_name,
      email: updated?.email,
      username: updated?.username,
      is_active: Boolean(updated?.is_active),
      is_staff: Boolean(updated?.is_staff),
    },
  });
  return c.json(await userPayload(c.env.DB, updated));
});

r.delete("/users/:userId/", authMiddleware, adminMiddleware, async (c) => {
  const user = c.get("user")!;
  const userId = Number(c.req.param("userId"));
  const existing = await c.env.DB.prepare("SELECT id, email, username, first_name, last_name, is_staff, is_active FROM auth_user WHERE id=?").bind(userId).first<any>();
  if (!existing) throw new DoesNotExist("User", userId);
  await c.env.DB.prepare("DELETE FROM auth_user WHERE id=?").bind(userId).run();
  await logAuditEntry(c.env.DB, "admin.user.delete", {
    user,
  }, { id: userId, type: "user" }, {
    user_id: userId,
    email: existing.email,
    username: existing.username,
    first_name: existing.first_name,
    last_name: existing.last_name,
    is_staff: Boolean(existing.is_staff),
    is_active: Boolean(existing.is_active),
  });
  return c.json({});
});

r.post("/users/impersonate/", authMiddleware, adminMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ user: number }>();
  await logAuditEntry(c.env.DB, "admin.user.impersonate", {
    user,
  }, { id: Number(body.user), type: "user" }, {
    target_user_id: Number(body.user),
  });
  return c.json({ user: body.user });
});

r.get("/workspaces/", authMiddleware, adminMiddleware, async (c) => {
  const { size, offset } = pageParams(c);
  const search = c.req.query("search") || "";
  const order = parseSort(c.req.query("sorts"), {
    name: "w.name",
    application_count: "application_count",
    row_count: "row_count",
    storage_usage: "w.storage_usage",
    created_on: "w.created_on",
  }, "w.created_on DESC");
  const where = search ? "WHERE w.name LIKE ?" : "";
  const params = search ? [`%${search}%`] : [];
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM core_workspace w ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT w.*,
            (SELECT COUNT(*) FROM core_application a
             WHERE a.workspace_id=w.id AND a.trashed=0
               AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)) AS application_count,
            (SELECT COALESCE(SUM((SELECT COUNT(*) FROM database_field f WHERE f.table_id=t.id)), 0)
             FROM database_table t JOIN core_application a2 ON a2.id=t.database_id
             WHERE a2.workspace_id=w.id AND t.trashed=0) AS row_count
     FROM core_workspace w
     ${where}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`
  ).bind(...params, size, offset).all<any>();

  const results = [];
  for (const workspace of rows.results || []) {
    const users = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.first_name, u.last_name, wu.permissions
       FROM core_workspaceuser wu
       JOIN auth_user u ON u.id=wu.user_id
       WHERE wu.workspace_id=? AND wu.to_be_deleted=0
       ORDER BY u.email`
    ).bind(workspace.id).all<any>();
    results.push({
      id: workspace.id,
      name: workspace.name,
      users: users.results || [],
      application_count: workspace.application_count || 0,
      free_users: Math.max(0, (users.results || []).length - (workspace.seats_taken || 0)),
      seats_taken: workspace.seats_taken || (users.results || []).length,
      row_count: workspace.row_count || 0,
      storage_usage: workspace.storage_usage || 0,
      created_on: workspace.created_on,
    });
  }
  return c.json({ count: total?.count || 0, results });
});

r.delete("/workspaces/:workspaceId/", authMiddleware, adminMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const existing = await c.env.DB.prepare("SELECT id, name FROM core_workspace WHERE id=?").bind(workspaceId).first<any>();
  if (!existing) throw new DoesNotExist("Workspace", workspaceId);
  await logAuditEntry(c.env.DB, "admin.workspace.delete", {
    user,
    workspace_id: workspaceId,
    workspace_name: existing.name,
  }, { id: workspaceId, type: "workspace" }, {
    workspace_id: workspaceId,
    workspace_name: existing.name,
  });
  await c.env.DB.prepare("DELETE FROM core_workspace WHERE id=?").bind(workspaceId).run();
  return c.json({});
});

export { r as adminRouter };
