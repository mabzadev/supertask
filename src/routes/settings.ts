import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { ValidationError } from "../middleware/error";
import { activeLicenses } from "../services/licenses";
import { logAuditEntry } from "../services/audit-log";
const r = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const BOOL_FIELDS = [
  "allow_new_signups",
  "allow_signups_via_workspace_invitations",
  "allow_reset_password",
  "allow_global_workspace_creation",
  "show_admin_signup_page",
  "track_workspace_usage",
  "show_baserow_help_request",
  "email_verified",
  "verify_import_signature",
  "allow_accessing_externally_hosted_files_in_rich_text_editors",
] as const;

const INT_FIELDS = ["account_deletion_grace_delay"] as const;
const TEXT_FIELDS = ["email_verification", "co_branding_logo"] as const;
const EMAIL_VERIFICATION = new Set(["no_verification", "recommended", "enforced"]);

async function ensureSettings(db: D1Database) {
  const existing = await db.prepare("SELECT * FROM core_settings WHERE id=1").first<any>();
  if (existing) {
    if (existing.show_admin_signup_page) {
      const userCount = await db.prepare("SELECT COUNT(*) AS count FROM auth_user").first<{ count: number }>();
      if ((userCount?.count ?? 0) > 0) {
        await db.prepare("UPDATE core_settings SET show_admin_signup_page=0, updated_at=? WHERE id=1")
          .bind(new Date().toISOString())
          .run();
        return db.prepare("SELECT * FROM core_settings WHERE id=1").first<any>();
      }
    }
    if (!existing.instance_id) {
      await db.prepare("UPDATE core_settings SET instance_id=?, updated_at=? WHERE id=1")
        .bind(crypto.randomUUID().replace(/-/g, ""), new Date().toISOString())
        .run();
      return db.prepare("SELECT * FROM core_settings WHERE id=1").first<any>();
    }
    return existing;
  }

  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO core_settings (
      id, allow_new_signups, allow_signups_via_workspace_invitations, allow_reset_password,
      allow_global_workspace_creation, account_deletion_grace_delay, show_admin_signup_page,
      track_workspace_usage, show_baserow_help_request, email_verified, verify_import_signature,
      allow_accessing_externally_hosted_files_in_rich_text_editors, email_verification,
      instance_id, updated_at
    ) VALUES (1, 1, 1, 1, 1, 30, 1, 0, 1, 0, 1, 0, 'no_verification', ?, ?)`
  ).bind(crypto.randomUUID().replace(/-/g, ""), now).run();
  return db.prepare("SELECT * FROM core_settings WHERE id=1").first<any>();
}

function serializeSettings(row: any) {
  const settings: Record<string, unknown> = {
    id: row.id,
    account_deletion_grace_delay: row.account_deletion_grace_delay ?? 30,
    email_verification: row.email_verification || "no_verification",
    co_branding_logo: row.co_branding_logo || null,
    updated_at: row.updated_at || null,
    instance_wide_licenses: activeLicenses().instance_wide,
  };
  for (const field of BOOL_FIELDS) settings[field] = Boolean(row[field]);
  return settings;
}

r.get("/", async (c) => {
  const s = await ensureSettings(c.env.DB);
  return c.json(serializeSettings(s));
});

r.get("/instance-id/", async (c) => {
  const s = await ensureSettings(c.env.DB);
  return c.json({ instance_id: s.instance_id || "" });
});

r.patch("/update/", authMiddleware, adminMiddleware, async (c) => {
  const user = c.get("user")!;
  const before = await ensureSettings(c.env.DB);
  const body = await c.req.json<Record<string, unknown>>();
  const updates: string[] = [];
  const values: unknown[] = [];

  for (const field of BOOL_FIELDS) {
    if (field in body) {
      updates.push(`${field}=?`);
      values.push(body[field] ? 1 : 0);
    }
  }
  for (const field of INT_FIELDS) {
    if (field in body) {
      const value = Number(body[field]);
      if (!Number.isInteger(value) || value < 0 || value > 32000) {
        throw new ValidationError(`${field} must be an integer between 0 and 32000.`);
      }
      updates.push(`${field}=?`);
      values.push(value);
    }
  }
  for (const field of TEXT_FIELDS) {
    if (field in body) {
      const value = body[field] === null || body[field] === undefined ? null : String(body[field]);
      if (field === "email_verification" && (!value || !EMAIL_VERIFICATION.has(value))) {
        throw new ValidationError("Invalid email_verification value.");
      }
      updates.push(`${field}=?`);
      values.push(value);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at=?");
    values.push(new Date().toISOString());
    await c.env.DB.prepare(`UPDATE core_settings SET ${updates.join(", ")} WHERE id=1`)
      .bind(...values)
      .run();
  }

  const updated = await ensureSettings(c.env.DB);
  if (updates.length > 0) {
    const changedFields = [...BOOL_FIELDS, ...INT_FIELDS, ...TEXT_FIELDS].filter((field) => field in body);
    await logAuditEntry(c.env.DB, "admin.settings.update", {
      user,
    }, { id: 1, type: "settings" }, {
      changed_fields: changedFields,
      before: Object.fromEntries(changedFields.map((field) => [field, before[field]])),
      after: Object.fromEntries(changedFields.map((field) => [field, updated[field]])),
    });
  }
  return c.json(serializeSettings(updated));
});

export { r as settingsRouter };
