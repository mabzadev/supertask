import type { D1Database } from "@cloudflare/workers-types";
import type { RequestUser } from "../types/env";
import { ensureDatabaseHasDefaultTable } from "./database-defaults";
import { activeLicenses } from "./licenses";

// NOTE: Cloudflare Workers limits PBKDF2 iterations to 100,000 max.
// OWASP recommends 210,000 for SHA-256 in 2023, but 100,000 is still
// acceptable for production. Passwords migrated from Django (260,000)
// will use the Django PBKDF2 verifier (verifyDjangoPBKDF2) which handles
// the base64-encoded salt format. New passwords use 100,000 iterations.
const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  const hashHex = Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("pbkdf2_sha256$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const [, iterStr, saltHex, storedHash] = parts;
    const iterations = parseInt(iterStr, 10);

    const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      256
    );

    const hashHex = Array.from(new Uint8Array(derivedBits))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison
    if (hashHex.length !== storedHash.length) return false;
    let diff = 0;
    for (let i = 0; i < hashHex.length; i++) {
      diff |= hashHex.charCodeAt(i) ^ storedHash.charCodeAt(i);
    }
    return diff === 0;
  }

  // Django's default PBKDF2 format: pbkdf2_sha256$iterations$base64salt$base64hash
  if (stored.startsWith("pbkdf2_sha256$") === false && stored.includes("$")) {
    // Might be Django's format with base64
    return await verifyDjangoPBKDF2(password, stored);
  }

  return false;
}

async function verifyDjangoPBKDF2(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4) return false;
  const [algo, iterStr, b64salt, b64hash] = parts;
  if (!algo.startsWith("pbkdf2_")) return false;

  const iterations = parseInt(iterStr, 10);
  const hashAlgo = algo === "pbkdf2_sha256" ? "SHA-256" : "SHA-1";

  const saltBytes = base64ToBytes(b64salt);
  const storedHashBytes = base64ToBytes(b64hash);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: hashAlgo },
    keyMaterial,
    storedHashBytes.length * 8
  );

  const derived = new Uint8Array(bits);
  if (derived.length !== storedHashBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < derived.length; i++) {
    diff |= derived[i] ^ storedHashBytes[i];
  }
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
}

// ── User queries ──────────────────────────────────────────────────────────────

export interface UserRow {
  id: number;
  email: string;
  username: string;
  first_name: string;
  last_name: string;
  password: string;
  is_staff: number;
  is_active: number;
  is_superuser: number;
  can_create_accounts: number;
  date_joined: string;
  last_login: string | null;
}

export interface UserProfileRow {
  user_id: number;
  language: string;
  timezone: string | null;
  email_notification_frequency: string;
  completed_onboarding: number;
  to_be_deleted: number;
  profile_image_url: string | null;
  email_verified: number;
  user_session_expiry_seconds: number;
  completed_guided_tours?: string | null;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM auth_user WHERE email = ? COLLATE NOCASE")
    .bind(email)
    .first<UserRow>();
}

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM auth_user WHERE id = ?").bind(id).first<UserRow>();
}

export async function getUserProfile(db: D1Database, userId: number): Promise<UserProfileRow | null> {
  return db
    .prepare("SELECT * FROM core_userprofile WHERE user_id = ?")
    .bind(userId)
    .first<UserProfileRow>();
}

export async function createUser(
  db: D1Database,
  data: {
    email: string;
    username: string;
    first_name: string;
    password_hash: string;
    is_staff?: boolean;
    is_superuser?: boolean;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const isStaff = data.is_staff ? 1 : 0;
  const isSuperuser = data.is_superuser ? 1 : 0;
  const result = await db
    .prepare(
      `INSERT INTO auth_user
       (email, username, first_name, last_name, password, is_staff, is_active, is_superuser, date_joined, last_login)
       VALUES (?, ?, ?, '', ?, ?, 1, ?, ?, NULL)
       RETURNING id`
    )
    .bind(data.email.toLowerCase(), data.username, data.first_name, data.password_hash, isStaff, isSuperuser, now)
    .first<{ id: number }>();

  if (!result) throw new Error("Failed to create user");
  const userId = result.id;

  // Create default profile
  await db
    .prepare(
      `INSERT INTO core_userprofile
       (user_id, language, timezone, email_notification_frequency, completed_onboarding, completed_guided_tours, to_be_deleted, profile_image_url, user_session_expiry_seconds)
       VALUES (?, 'en', NULL, 'instant', 0, '["sidebar","database","builder","automation"]', 0, NULL, 604800)`
    )
    .bind(userId)
    .run();

  return userId;
}

export async function createInitialWorkspace(db: D1Database, userId: number, name: string): Promise<number> {
  const now = new Date().toISOString();
  const workspaceName = `${name || "My"}'s workspace`;
  const workspace = await db
    .prepare(
      `INSERT INTO core_workspace (name, created_on, storage_usage, seats_taken)
       VALUES (?, ?, 0, 1)
       RETURNING id`
    )
    .bind(workspaceName, now)
    .first<{ id: number }>();

  if (!workspace) throw new Error("Failed to create initial workspace");

  await db.batch([
    db
      .prepare(
        `INSERT INTO core_workspaceuser (workspace_id, user_id, "order", permissions, to_be_deleted)
         VALUES (?, ?, 1, 'ADMIN', 0)`
      )
      .bind(workspace.id, userId),
    db
      .prepare(
        `INSERT INTO core_application (workspace_id, name, type, "order", trashed, created_on, updated_on)
         VALUES (?, 'Untitled database', 'database', 1, 0, ?, ?)`
      )
      .bind(workspace.id, now, now),
  ]);

  const app = await db.prepare(
    "SELECT id FROM core_application WHERE workspace_id = ? AND type = 'database' AND trashed = 0 ORDER BY [order] ASC LIMIT 1"
  )
    .bind(workspace.id)
    .first<{ id: number }>();
  if (app) await ensureDatabaseHasDefaultTable(db, app.id);

  return workspace.id;
}

export async function updateUserLastLogin(db: D1Database, userId: number): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare("UPDATE auth_user SET last_login = ? WHERE id = ?").bind(now, userId).run();
  try {
    await db.prepare(
      "UPDATE core_userprofile SET to_be_deleted=0, deletion_requested_at=NULL WHERE user_id=?"
    ).bind(userId).run();
  } catch (error: any) {
    if (!String(error?.message || error).includes("deletion_requested_at")) throw error;
    await db.prepare("UPDATE core_userprofile SET to_be_deleted=0 WHERE user_id=?").bind(userId).run();
  }
}

export function parseCompletedGuidedTours(value: string | null | undefined): string[] {
  if (!value) return ["sidebar", "database", "builder", "automation"];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function serializeUser(user: UserRow, profile: UserProfileRow | null): object {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
  return {
    id: user.id,
    username: user.username,
    name,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    is_staff: Boolean(user.is_staff),
    is_active: Boolean(user.is_active),
    can_create_accounts: Boolean(user.is_staff || user.can_create_accounts),
    language: profile?.language ?? "en",
    timezone: profile?.timezone ?? null,
    email_notification_frequency: profile?.email_notification_frequency ?? "instant",
    completed_onboarding: Boolean(profile?.completed_onboarding),
    completed_guided_tours: parseCompletedGuidedTours(profile?.completed_guided_tours),
    to_be_deleted: Boolean(profile?.to_be_deleted),
    email_verified: Boolean(profile?.email_verified),
    profile_image_url: profile?.profile_image_url ?? null,
    date_joined: user.date_joined,
    last_login: user.last_login,
    active_licenses: activeLicenses(),
  };
}
