import type { RequestUser } from "../types/env";

export interface UndoableActionInput {
  user: RequestUser | null;
  actionType: string;
  actionScope: string;
  session?: string;
  actionGroup?: string | null;
  params: Record<string, unknown>;
}

export async function createUndoableAction(db: D1Database, input: UndoableActionInput) {
  const now = new Date().toISOString();
  try {
    return await db.prepare(
      `INSERT INTO core_action
       (user_id, user_name, session, action_group, action_scope, action_timestamp,
        action_type, action_command_type, params)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'DO', ?) RETURNING *`
    ).bind(
      input.user?.id ?? null,
      input.user?.username || input.user?.email || "",
      input.session || "",
      input.actionGroup || null,
      input.actionScope,
      now,
      input.actionType,
      JSON.stringify(input.params)
    ).first<any>();
  } catch (error: any) {
    if (String(error?.message || error).includes("core_action")) return null;
    throw error;
  }
}
