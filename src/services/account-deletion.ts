import type { Env } from "../types/env";
import { deleteUnreferencedUserFiles } from "./user-files";

export type DeletedUserSummary = {
  id: number;
  email: string;
  username: string;
  first_name: string;
  last_name: string;
  is_staff: number;
  is_active: number;
};

export async function isLastActiveInstanceAdmin(db: D1Database, userId: number): Promise<boolean> {
  const target = await db.prepare("SELECT is_staff, is_active FROM auth_user WHERE id=?")
    .bind(userId)
    .first<{ is_staff: number; is_active: number }>();
  if (!target?.is_staff || !target.is_active) return false;
  const admins = await db.prepare("SELECT COUNT(*) AS count FROM auth_user WHERE is_staff=1 AND is_active=1")
    .first<{ count: number }>();
  return Number(admins?.count || 0) <= 1;
}

export async function cancelScheduledAccountDeletion(db: D1Database, userId: number): Promise<void> {
  try {
    await db.prepare(
      "UPDATE core_userprofile SET to_be_deleted=0, deletion_requested_at=NULL WHERE user_id=?"
    ).bind(userId).run();
  } catch (error: any) {
    // Keeps older local fixtures and rolling deployments compatible until the
    // additive migration has been applied everywhere.
    if (!String(error?.message || error).includes("deletion_requested_at")) throw error;
    await db.prepare("UPDATE core_userprofile SET to_be_deleted=0 WHERE user_id=?").bind(userId).run();
  }
}

export async function deleteUserAccount(env: Env, userId: number): Promise<DeletedUserSummary | null> {
  const user = await env.DB.prepare(
    "SELECT id, email, username, first_name, last_name, is_staff, is_active FROM auth_user WHERE id=?"
  ).bind(userId).first<DeletedUserSummary>();
  if (!user) return null;

  let uploadedNames: string[] = [];
  try {
    const files = await env.DB.prepare("SELECT name FROM core_userfile WHERE user_id=?")
      .bind(userId)
      .all<{ name: string }>();
    uploadedNames = (files.results || []).map((file) => file.name);
  } catch (error: any) {
    if (!String(error?.message || error).includes("core_userfile")) throw error;
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM enterprise_roleassignment WHERE subject_id=? AND subject_type='auth.User'").bind(userId),
    env.DB.prepare("DELETE FROM enterprise_teamsubject WHERE subject_id=? AND subject_type='auth.User'").bind(userId),
    env.DB.prepare("DELETE FROM auth_user WHERE id=?").bind(userId),
  ]);

  for (let index = 0; index < uploadedNames.length; index += 20) {
    await deleteUnreferencedUserFiles(env, uploadedNames.slice(index, index + 20));
  }
  return user;
}
