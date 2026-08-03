import { ApiError, ValidationError } from "../middleware/error";

export const ACCOUNT_CREATION_POLICY = "invitation_allowlist" as const;
export const ACCOUNT_CREATION_NOT_ALLOWED = "ERROR_ACCOUNT_CREATION_NOT_ALLOWED";
export const EMAIL_NOT_ALLOWED = "ERROR_EMAIL_NOT_ALLOWED";

export type AccountAccessRuleKind = "email" | "domain";

export type AccountCreationDecision =
  | { allowed: true; existingUser: boolean }
  | { allowed: false; existingUser: false; reason: "creator" | "email" };

export function normalizeAccountEmail(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function normalizeAccountDomain(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/^@+/, "");
}

export function validateAccountEmail(value: string): string {
  const normalized = normalizeAccountEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
    throw new ValidationError(`Invalid allowlisted email address: ${value}`);
  }
  return normalized;
}

export function validateAccountDomain(value: string): string {
  const normalized = normalizeAccountDomain(value);
  if (
    normalized.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)
  ) {
    throw new ValidationError(`Invalid allowlisted email domain: ${value}`);
  }
  return normalized;
}

export function normalizeUniqueRules(values: unknown, kind: AccountAccessRuleKind): string[] {
  if (!Array.isArray(values)) throw new ValidationError(`${kind} rules must be an array.`);
  const normalize = kind === "email" ? validateAccountEmail : validateAccountDomain;
  return [...new Set(values.map((value) => normalize(String(value))))].sort();
}

export async function isEmailAllowlisted(db: D1Database, email: string): Promise<boolean> {
  const normalized = normalizeAccountEmail(email);
  const domain = normalized.split("@")[1] || "";
  if (!domain) return false;
  const row = await db.prepare(
    `SELECT 1 AS allowed
     FROM core_account_email_allowlist
     WHERE (kind='email' AND normalized_value=?)
        OR (kind='domain' AND normalized_value=?)
     LIMIT 1`
  ).bind(normalized, domain).first<{ allowed: number }>();
  return Boolean(row);
}

export async function isEffectiveAccountCreator(db: D1Database, userId: number): Promise<boolean> {
  const row = await db.prepare(
    "SELECT is_staff, can_create_accounts, is_active FROM auth_user WHERE id=?"
  ).bind(userId).first<{ is_staff: number; can_create_accounts: number; is_active: number }>();
  return Boolean(row?.is_active && (row.is_staff || row.can_create_accounts));
}

export async function accountCreationDecision(
  db: D1Database,
  email: string,
  inviterId: number,
): Promise<AccountCreationDecision> {
  const normalized = normalizeAccountEmail(email);
  const existing = await db.prepare("SELECT id FROM auth_user WHERE email=? COLLATE NOCASE")
    .bind(normalized)
    .first<{ id: number }>();
  if (existing) return { allowed: true, existingUser: true };
  if (!(await isEffectiveAccountCreator(db, inviterId))) {
    return { allowed: false, existingUser: false, reason: "creator" };
  }
  if (!(await isEmailAllowlisted(db, normalized))) {
    return { allowed: false, existingUser: false, reason: "email" };
  }
  return { allowed: true, existingUser: false };
}

export function throwAccountCreationDecision(decision: AccountCreationDecision): void {
  if (decision.allowed) return;
  if (decision.reason === "creator") {
    throw new ApiError(
      403,
      ACCOUNT_CREATION_NOT_ALLOWED,
      "You are not authorised to create new user accounts."
    );
  }
  throw new ApiError(
    400,
    EMAIL_NOT_ALLOWED,
    "This email address is not included in the account allowlist."
  );
}

export async function assertInvitedAccountCreationAllowed(
  db: D1Database,
  email: string,
  inviterId: number,
): Promise<void> {
  throwAccountCreationDecision(await accountCreationDecision(db, email, inviterId));
}

export async function assertEmailAllowlisted(db: D1Database, email: string): Promise<void> {
  if (!(await isEmailAllowlisted(db, email))) {
    throw new ApiError(
      400,
      EMAIL_NOT_ALLOWED,
      "This email address is not included in the account allowlist."
    );
  }
}
