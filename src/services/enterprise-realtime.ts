import type { Env } from "../types/env";
import { broadcastToWorkspace } from "../durable-objects/workspace-room";

export async function associatedSubjectUserIds(
  db: D1Database,
  subjectId: number,
  subjectType: string,
): Promise<number[]> {
  if (subjectType === "auth.User") return subjectId > 0 ? [subjectId] : [];
  if (subjectType !== "baserow_enterprise.Team") return [];
  const rows = await db.prepare(
    `SELECT DISTINCT ts.subject_id
       FROM enterprise_teamsubject ts
       JOIN auth_user u ON u.id=ts.subject_id AND u.is_active=1
      WHERE ts.team_id=? AND ts.subject_type='auth.User'`
  ).bind(subjectId).all<{ subject_id: number }>();
  return (rows.results || []).map((row) => Number(row.subject_id));
}

export async function broadcastPermissionsUpdated(
  env: Env,
  workspaceId: number,
  userIds: Iterable<number>,
): Promise<void> {
  const uniqueUserIds = [...new Set([...userIds].map(Number).filter((id) => id > 0))];
  if (uniqueUserIds.length === 0) return;
  await broadcastToWorkspace(env, workspaceId, {
    type: "permissions_updated",
    workspace_id: workspaceId,
  }, { userIds: uniqueUserIds });
}
