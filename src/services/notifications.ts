export type NotificationSender = {
  id: number;
  email?: string | null;
  username?: string | null;
  first_name?: string | null;
};

type DirectNotificationOptions = {
  type: string;
  recipientIds: number[];
  senderId?: number | null;
  workspaceId?: number | null;
  data?: Record<string, unknown>;
};

type BroadcastNotificationOptions = {
  type: string;
  senderId?: number | null;
  data?: Record<string, unknown>;
};

export async function createDirectNotificationForUsers(
  db: D1Database,
  options: DirectNotificationOptions
) {
  const recipients = [...new Set(options.recipientIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (recipients.length === 0) return null;

  const now = new Date().toISOString();
  const notification = await db.prepare(
    `INSERT INTO core_notification (created_on, updated_on, type, data, workspace_id, sender_id, broadcast)
     VALUES (?, ?, ?, ?, ?, ?, 0) RETURNING id, created_on`
  ).bind(
    now,
    now,
    options.type,
    JSON.stringify(options.data || {}),
    options.workspaceId ?? null,
    options.senderId ?? null
  ).first<{ id: number; created_on: string }>();

  if (!notification) return null;

  for (const recipientId of recipients) {
    await db.prepare(
      `INSERT OR IGNORE INTO core_notificationrecipient
       (notification_id, recipient_id, read, cleared, created_on)
       VALUES (?, ?, 0, 0, ?)`
    ).bind(notification.id, recipientId, now).run();
  }

  return notification;
}

export async function createBroadcastNotification(
  db: D1Database,
  options: BroadcastNotificationOptions
) {
  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO core_notification (created_on, updated_on, type, data, workspace_id, sender_id, broadcast)
     VALUES (?, ?, ?, ?, NULL, ?, 1) RETURNING id`
  ).bind(
    now,
    now,
    options.type,
    JSON.stringify(options.data || {}),
    options.senderId ?? null
  ).first<{ id: number }>();
}

export async function markInvitationNotificationAsRead(
  db: D1Database,
  userId: number,
  invitationId: number
) {
  const rows = await db.prepare(
    `SELECT nr.id
       FROM core_notificationrecipient nr
       JOIN core_notification n ON n.id=nr.notification_id
      WHERE nr.recipient_id=?
        AND nr.read=0
        AND json_extract(n.data, '$.invitation_id')=?`
  ).bind(userId, invitationId).all<{ id: number }>();

  for (const row of rows.results || []) {
    await db.prepare("UPDATE core_notificationrecipient SET read=1 WHERE id=?").bind(row.id).run();
  }
}
