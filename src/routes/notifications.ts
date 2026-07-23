import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { assertHasWorkspaceRole } from "../services/enterprise-permissions";
import { DoesNotExist } from "../middleware/error";

const notifications = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
type AppContext = Context<{ Bindings: Env; Variables: RequestVariables }>;

// Schema:
//   core_notification:         id, created_on, updated_on, type, data (JSON), workspace_id, sender_id, broadcast
//   core_notificationrecipient: id, notification_id, recipient_id, read, cleared, created_on

function serializeNotification(n: any, r: any): object {
  let data: unknown = {};
  if (n.data) {
    try {
      data = JSON.parse(n.data);
    } catch {
      data = {};
    }
  }

  return {
    id: n.id,
    type: n.type || "info",
    data,
    read: Boolean(r.read),
    workspace: n.workspace_id ? { id: n.workspace_id } : null,
    sender: n.sender_user_id ? {
      id: n.sender_user_id,
      username: n.sender_username || n.sender_email,
      first_name: n.sender_first_name || "",
    } : null,
    created_on: n.created_on,
  };
}

async function assertNotificationWorkspaceAccess(c: AppContext, workspaceId?: number | null) {
  if (!workspaceId) return;
  const user = c.get("user")!;
  await assertHasWorkspaceRole(c.env.DB, user.id, workspaceId, "VIEWER");
}

async function visibleNotification(c: AppContext, notificationId: number) {
  const user = c.get("user")!;
  const row = await c.env.DB.prepare(
    `SELECT n.*, nr.id AS recipient_row_id, COALESCE(nr.read, 0) AS read, COALESCE(nr.cleared, 0) AS cleared,
            s.id AS sender_user_id, s.username AS sender_username, s.email AS sender_email, s.first_name AS sender_first_name
       FROM core_notification n
       LEFT JOIN core_notificationrecipient nr ON nr.notification_id=n.id AND nr.recipient_id=?
       LEFT JOIN auth_user s ON s.id=n.sender_id
      WHERE n.id=?
        AND (
          (n.broadcast=0 AND nr.id IS NOT NULL AND nr.cleared=0)
          OR
          (n.broadcast=1 AND COALESCE(nr.cleared, 0)=0)
        )`
  ).bind(user.id, notificationId).first<any>();
  if (!row) throw new DoesNotExist("Notification", notificationId);
  await assertNotificationWorkspaceAccess(c, row.workspace_id ?? null);
  return row;
}

async function ensureBroadcastRecipient(db: D1Database, userId: number, notification: any, read: boolean, cleared: boolean) {
  if (!notification.broadcast) return;
  await db.prepare(
    `INSERT OR IGNORE INTO core_notificationrecipient
     (notification_id, recipient_id, read, cleared, created_on)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(notification.id, userId, read ? 1 : 0, cleared ? 1 : 0, notification.created_on || new Date().toISOString()).run();
}

function workspacePredicate(workspaceId?: number) {
  return workspaceId ? "(n.workspace_id=? OR n.workspace_id IS NULL)" : "1=1";
}

async function listNotifications(c: AppContext, workspaceId?: number) {
  const user = c.get("user")!;
  await assertNotificationWorkspaceAccess(c, workspaceId);
  const limitParam = c.req.query("limit") || c.req.query("size") || "20";
  const offsetParam = c.req.query("offset");
  const page = Math.max(1, parseInt(c.req.query("page") || "1"));
  const size = Math.min(100, Math.max(1, parseInt(limitParam)));
  const offset = offsetParam !== undefined ? Math.max(0, parseInt(offsetParam)) : (page - 1) * size;
  const unreadOnly = c.req.query("read") === "false";

  const params: any[] = [user.id];
  if (workspaceId) params.push(workspaceId);
  const readPredicate = unreadOnly ? "AND COALESCE(nr.read, 0)=0" : "";
  const res = await c.env.DB.prepare(
    `SELECT n.*, nr.id AS recipient_row_id, COALESCE(nr.read, 0) AS read, COALESCE(nr.cleared, 0) AS cleared,
            s.id AS sender_user_id, s.username AS sender_username, s.email AS sender_email, s.first_name AS sender_first_name
       FROM core_notification n
       LEFT JOIN core_notificationrecipient nr ON nr.notification_id=n.id AND nr.recipient_id=?
       LEFT JOIN auth_user s ON s.id=n.sender_id
      WHERE ${workspacePredicate(workspaceId)}
        AND COALESCE(nr.cleared, 0)=0
        AND (
          (n.broadcast=0 AND nr.id IS NOT NULL)
          OR n.broadcast=1
        )
        ${readPredicate}
      ORDER BY n.created_on DESC, n.id DESC`
  ).bind(...params).all<any>();

  const allRows = res.results || [];
  const pageRows = allRows.slice(offset, offset + size);
  const results = pageRows.map((row: any) => serializeNotification(row, {
    id: row.recipient_row_id,
    read: row.read,
    cleared: row.cleared,
  }));

  const count = allRows.length;
  const unreadCount = allRows.filter((row) => !Boolean(row.read)).length;
  return c.json({
    count,
    unread_count: unreadCount,
    next: offset + size < count ? `?offset=${offset + size}&limit=${size}` : null,
    previous: offset > 0 ? `?offset=${Math.max(0, offset - size)}&limit=${size}` : null,
    results,
  });
}

// ── GET /api/notifications/ — List notifications ──────────────────────────────
notifications.get("/", authMiddleware, async (c) => listNotifications(c));

// ── GET /api/notifications/:workspaceId/ — Baserow-compatible workspace list ──
notifications.get("/:workspaceId/", authMiddleware, async (c) => {
  const workspaceId = parseInt(c.req.param("workspaceId"));
  return listNotifications(c, Number.isFinite(workspaceId) ? workspaceId : undefined);
});

notifications.post("/:workspaceId/mark-all-as-read/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = parseInt(c.req.param("workspaceId"));
  if (Number.isFinite(workspaceId)) {
    await assertNotificationWorkspaceAccess(c, workspaceId);
    const broadcasts = await c.env.DB.prepare(
      `SELECT n.*
         FROM core_notification n
         LEFT JOIN core_notificationrecipient nr ON nr.notification_id=n.id AND nr.recipient_id=?
        WHERE n.broadcast=1
          AND (n.workspace_id=? OR n.workspace_id IS NULL)
          AND COALESCE(nr.cleared, 0)=0`
    ).bind(user.id, workspaceId).all<any>();
    for (const notification of broadcasts.results || []) {
      await ensureBroadcastRecipient(c.env.DB, user.id, notification, true, false);
    }
    await c.env.DB.prepare(
      `UPDATE core_notificationrecipient
       SET read=1
       WHERE recipient_id=? AND read=0 AND notification_id IN (
         SELECT id FROM core_notification WHERE workspace_id=? OR workspace_id IS NULL
       )`
    ).bind(user.id, workspaceId).run();
  }
  return new Response(null, { status: 204 });
});

// ── PATCH /api/notifications/:id/mark-as-read/ ────────────────────────────────
notifications.patch("/:notifId/mark-as-read/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("notifId"));
  const notification = await visibleNotification(c, id);
  await ensureBroadcastRecipient(c.env.DB, user.id, notification, true, false);
  await c.env.DB.prepare(
    "UPDATE core_notificationrecipient SET read=1 WHERE notification_id=? AND recipient_id=?"
  ).bind(id, user.id).run();
  const updated = await visibleNotification(c, id);
  return c.json(serializeNotification(updated, updated));
});

notifications.patch("/:workspaceId/:notifId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = parseInt(c.req.param("workspaceId"));
  const id = parseInt(c.req.param("notifId"));
  if (Number.isFinite(workspaceId)) await assertNotificationWorkspaceAccess(c, workspaceId);
  const notification = await visibleNotification(c, id);
  const body = await c.req.json<any>().catch(() => ({}));
  if (typeof body.read !== "boolean") {
    return c.json({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: {
        read: [{ error: "This field is required.", code: "required" }],
      },
    }, 400);
  }
  await ensureBroadcastRecipient(c.env.DB, user.id, notification, Boolean(body.read), false);
  await c.env.DB.prepare(
    "UPDATE core_notificationrecipient SET read=? WHERE notification_id=? AND recipient_id=?"
  ).bind(body.read ? 1 : 0, id, user.id).run();
  const updated = await visibleNotification(c, id);
  return c.json(serializeNotification(updated, updated));
});

notifications.delete("/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = parseInt(c.req.param("workspaceId"));
  if (Number.isFinite(workspaceId)) {
    await assertNotificationWorkspaceAccess(c, workspaceId);
    const broadcasts = await c.env.DB.prepare(
      `SELECT n.*
         FROM core_notification n
         LEFT JOIN core_notificationrecipient nr ON nr.notification_id=n.id AND nr.recipient_id=?
        WHERE n.broadcast=1
          AND (n.workspace_id=? OR n.workspace_id IS NULL)
          AND COALESCE(nr.cleared, 0)=0`
    ).bind(user.id, workspaceId).all<any>();
    for (const notification of broadcasts.results || []) {
      await ensureBroadcastRecipient(c.env.DB, user.id, notification, false, true);
    }
    await c.env.DB.prepare(
      `UPDATE core_notificationrecipient
       SET cleared=1
       WHERE recipient_id=? AND notification_id IN (
         SELECT id FROM core_notification WHERE workspace_id=? OR workspace_id IS NULL
       )`
    ).bind(user.id, workspaceId).run();
  }
  return new Response(null, { status: 204 });
});

// ── PATCH /api/notifications/mark-as-read/ — Mark all as read ─────────────────
notifications.patch("/mark-as-read/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const broadcasts = await c.env.DB.prepare(
    `SELECT n.*
       FROM core_notification n
       LEFT JOIN core_notificationrecipient nr ON nr.notification_id=n.id AND nr.recipient_id=?
      WHERE n.broadcast=1 AND COALESCE(nr.cleared, 0)=0`
  ).bind(user.id).all<any>();
  for (const notification of broadcasts.results || []) {
    await ensureBroadcastRecipient(c.env.DB, user.id, notification, true, false);
  }
  await c.env.DB.prepare(
    "UPDATE core_notificationrecipient SET read=1 WHERE recipient_id=? AND read=0"
  ).bind(user.id).run();
  return c.json({ marked: true });
});

// ── DELETE /api/notifications/:id/ — Clear one notification ──────────────────
notifications.delete("/:notifId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("notifId"));
  const notification = await visibleNotification(c, id);
  await ensureBroadcastRecipient(c.env.DB, user.id, notification, false, true);
  await c.env.DB.prepare(
    "UPDATE core_notificationrecipient SET cleared=1 WHERE notification_id=? AND recipient_id=?"
  ).bind(id, user.id).run();
  return c.json({});
});

// ── DELETE /api/notifications/ — Clear all notifications ─────────────────────
notifications.delete("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const broadcasts = await c.env.DB.prepare(
    `SELECT n.*
       FROM core_notification n
       LEFT JOIN core_notificationrecipient nr ON nr.notification_id=n.id AND nr.recipient_id=?
      WHERE n.broadcast=1 AND COALESCE(nr.cleared, 0)=0`
  ).bind(user.id).all<any>();
  for (const notification of broadcasts.results || []) {
    await ensureBroadcastRecipient(c.env.DB, user.id, notification, false, true);
  }
  await c.env.DB.prepare(
    "UPDATE core_notificationrecipient SET cleared=1 WHERE recipient_id=?"
  ).bind(user.id).run();
  return c.json({});
});

export { notifications as notificationsRouter };
