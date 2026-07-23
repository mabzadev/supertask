import type { D1Database } from "@cloudflare/workers-types";
import { serializeFieldValueForInsert, type FieldMeta } from "./dynamic-tables";
import { applyDateDependencyRules } from "./field-rules";
import { synchronizeLinkRowRelations } from "./link-row-relations";
import {
  createUserCell,
  resolveCreateUser,
  type CreateUser,
} from "./row-create-values";
import { createDirectNotificationForUsers } from "./notifications";
import type { Env } from "../types/env";
import { enqueueAutomaticAIUpdates } from "./ai-auto-update";
import { broadcastToWorkspace } from "../durable-objects/workspace-room";

type RowWriteEffectEnv = Pick<Env, "DB" | "JOBS_QUEUE"> & Partial<Pick<Env, "WORKSPACE_ROOM">>;

function parseCollaboratorIds(value: unknown): number[] {
  if (typeof value === "string") {
    try {
      return parseCollaboratorIds(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => Number(item && typeof item === "object" ? (item as Record<string, unknown>).id : item))
    .filter((id) => Number.isInteger(id) && id > 0))];
}

function rowLabel(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    try {
      return rowLabel(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(rowLabel).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return String(item.value ?? item.name ?? item.visible_name ?? item.id ?? "");
  }
  return String(value);
}

export async function notifyNewCollaborators(
  db: D1Database,
  tableId: number,
  rowId: number,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  changedFieldIds: Set<number> | null,
  senderId: number | null = null,
  env?: Partial<Pick<Env, "WORKSPACE_ROOM">>
): Promise<void> {
  const fields = await db.prepare(
    `SELECT id, name, field_settings
     FROM database_field
     WHERE table_id=? AND type='multiple_collaborators' AND trashed=0
     ORDER BY [order] ASC, id ASC`
  ).bind(tableId).all<{ id: number; name: string; field_settings: string | null }>();
  const enabledFields = (fields.results || []).filter((field) => {
    if (changedFieldIds && !changedFieldIds.has(Number(field.id))) return false;
    try {
      return JSON.parse(field.field_settings || "{}").notify_user_when_added === true;
    } catch {
      return false;
    }
  });
  if (enabledFields.length === 0) return;

  const metadata = await db.prepare(
    `SELECT t.name AS table_name, a.id AS database_id, a.name AS database_name, a.workspace_id,
            pf.id AS primary_field_id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     LEFT JOIN database_field pf ON pf.table_id=t.id AND pf."primary"=1 AND pf.trashed=0
     WHERE t.id=? AND t.trashed=0
     ORDER BY pf.[order] ASC, pf.id ASC
     LIMIT 1`
  ).bind(tableId).first<{
    table_name: string;
    database_id: number;
    database_name: string;
    workspace_id: number;
    primary_field_id: number | null;
  }>();
  if (!metadata) return;
  const rowName = metadata.primary_field_id
    ? rowLabel(after[`field_${metadata.primary_field_id}`])
    : String(rowId);

  for (const field of enabledFields) {
    const previousIds = new Set(parseCollaboratorIds(before?.[`field_${field.id}`]));
    const addedIds = parseCollaboratorIds(after[`field_${field.id}`]).filter((id) => !previousIds.has(id));
    if (addedIds.length === 0) continue;
    const data = {
      row_id: rowId,
      row_name: rowName,
      field_id: Number(field.id),
      field_name: field.name,
      table_id: tableId,
      table_name: metadata.table_name,
      database_id: Number(metadata.database_id),
      database_name: metadata.database_name,
    };
    const notification = await createDirectNotificationForUsers(db, {
      type: "collaborator_added_to_row",
      recipientIds: addedIds,
      senderId,
      workspaceId: Number(metadata.workspace_id),
      data,
    });
    if (!notification || !env?.WORKSPACE_ROOM) continue;
    const sender = senderId
      ? await db.prepare("SELECT id, username, email, first_name FROM auth_user WHERE id=?")
        .bind(senderId)
        .first<{ id: number; username: string | null; email: string | null; first_name: string | null }>()
      : null;
    await broadcastToWorkspace(env as Env, Number(metadata.workspace_id), {
      type: "notifications_created",
      notifications: [{
        id: notification.id,
        type: "collaborator_added_to_row",
        sender: sender ? {
          id: sender.id,
          username: sender.username || sender.email,
          first_name: sender.first_name || "",
        } : null,
        created_on: notification.created_on,
        data,
        workspace: { id: Number(metadata.workspace_id) },
        read: false,
      }],
    }, { userIds: addedIds });
  }
}

export async function modifiedFieldValues(
  db: D1Database,
  fields: FieldMeta[],
  now: string,
  user?: CreateUser | number | null
): Promise<Map<number, unknown>> {
  const values = new Map<number, unknown>();
  const resolvedUser = await resolveCreateUser(db, user);
  for (const field of fields) {
    if (field.type === "last_modified") {
      values.set(field.id, serializeFieldValueForInsert(field.type, now));
    } else if (field.type === "last_modified_by") {
      values.set(field.id, serializeFieldValueForInsert(field.type, createUserCell(resolvedUser)));
    }
  }
  return values;
}

export async function finalizeRowWrite(
  db: D1Database,
  tableId: number,
  rowId: number,
  before: Record<string, unknown> | null,
  changedFieldIds: Set<number>,
  senderId: number | null = null,
  env?: RowWriteEffectEnv
): Promise<Record<string, unknown> | null> {
  await applyDateDependencyRules(db, tableId, rowId, changedFieldIds);
  const after = await db.prepare(
    `SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`
  ).bind(rowId).first<Record<string, unknown>>();
  if (!after) return null;
  await synchronizeLinkRowRelations(db, tableId, rowId, before, after, changedFieldIds);
  const finalRow = await db.prepare(
    `SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`
  ).bind(rowId).first<Record<string, unknown>>();
  if (finalRow) await notifyNewCollaborators(db, tableId, rowId, before, finalRow, changedFieldIds, senderId, env);
  if (env) await enqueueAutomaticAIUpdates(env, tableId, [rowId], changedFieldIds);
  return finalRow;
}

export async function tableHasRowWriteEffects(db: D1Database, tableId: number): Promise<boolean> {
  const result = await db.prepare(
    `SELECT CASE WHEN
       EXISTS(
         SELECT 1 FROM database_fieldrule
         WHERE table_id=? AND type='date_dependency' AND is_active=1 AND is_valid=1
       ) OR EXISTS(
         SELECT 1 FROM database_field
         WHERE table_id=? AND type='link_row' AND trashed=0
       ) OR EXISTS(
         SELECT 1 FROM database_field
         WHERE table_id=? AND type='multiple_collaborators' AND trashed=0
           AND json_extract(COALESCE(field_settings, '{}'), '$.notify_user_when_added')=1
       )
     THEN 1 ELSE 0 END AS required`
  ).bind(tableId, tableId, tableId).first<{ required: number }>();
  return Boolean(result?.required);
}

export function insertedRowId(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, any>;
  const value = record.meta?.last_row_id ?? record.lastInsertRowid ?? record.last_insert_rowid;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
