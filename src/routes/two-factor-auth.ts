import { Hono } from "hono";
import QRCode from "qrcode";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware, signAccessToken, signRefreshToken, signUserSession, verifyToken } from "../middleware/auth";
import { AuthenticationError, ValidationError } from "../middleware/error";
import { getUserById, getUserProfile, serializeUser, updateUserLastLogin, verifyPassword } from "../services/user";

const r = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BACKUP_CODE_ALPHABET = "abcdefghjklmnpqrstuvwxyz23456789";
const USED_TOTP_TTL_SECONDS = 3600;

function twoFactorError(error: string, detail: string, status = 400) {
  return { body: { error, detail }, status };
}

function provisioningUrl(email: string, secret: string) {
  const issuer = "Supertask";
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function randomBase32(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => BASE32[byte % BASE32.length]).join("");
}

function base32ToBytes(value: string) {
  let bits = "";
  const clean = value.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  for (const char of clean) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) throw new ValidationError("Invalid TOTP secret.");
    bits += idx.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(out);
}

async function hotp(secret: string, counter: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    base32ToBytes(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(4, counter);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

async function verifyTotp(secret: string, code: string) {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const drift of [-1, 0, 1]) {
    if (await hotp(secret, counter + drift) === code) return true;
  }
  return false;
}

function backupCodes() {
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    const code = Array.from(bytes).map((b) => BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length]).join("");
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

async function qrCodeDataUri(value: string) {
  return QRCode.toDataURL(value, { type: "image/png", margin: 1, width: 220 });
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashBackupCodes(codes: string[]) {
  return Promise.all(codes.map((code) => sha256Hex(code)));
}

function parseBackupCodes(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((code): code is string => typeof code === "string") : [];
  } catch {
    return [];
  }
}

async function backupCodeMatches(stored: string, supplied: string) {
  if (/^[a-f0-9]{64}$/i.test(stored)) {
    return stored.toLowerCase() === (await sha256Hex(supplied)).toLowerCase();
  }
  return stored === supplied;
}

async function isTotpCodeReused(env: Env, userId: number, code: string) {
  const hash = await sha256Hex(code);
  return (await env.CACHE.get(`2fa:used:${userId}:${hash}`)) !== null;
}

async function markTotpCodeUsed(env: Env, userId: number, code: string) {
  const hash = await sha256Hex(code);
  await env.CACHE.put(`2fa:used:${userId}:${hash}`, "1", { expirationTtl: USED_TOTP_TTL_SECONDS });
}

async function authResponse(env: Env, userId: number) {
  const dbUser = await getUserById(env.DB, userId);
  if (!dbUser || !dbUser.is_active) throw new AuthenticationError("User not found or inactive.");
  const normalized = dbUser.email.toLowerCase();
  const payload = { user_id: dbUser.id, email: normalized, username: normalized };
  const access = await signAccessToken(payload, env.JWT_SIGNING_KEY, parseInt(env.JWT_ACCESS_TTL_MINUTES || "10", 10));
  const refreshTtlDays = parseInt(env.JWT_REFRESH_TTL_DAYS || "7", 10);
  const refresh = await signRefreshToken(payload, env.JWT_SIGNING_KEY, refreshTtlDays);
  const userSession = await signUserSession({ user_id: dbUser.id }, refresh, env.JWT_SIGNING_KEY, refreshTtlDays);
  const profile = await getUserProfile(env.DB, dbUser.id);
  await updateUserLastLogin(env.DB, dbUser.id);
  return {
    access_token: access,
    refresh_token: refresh,
    user_session: userSession,
    permissions: [],
    user: serializeUser(dbUser, profile),
  };
}

r.get("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const device = await c.env.DB.prepare("SELECT enabled FROM core_twofactorauthenticationdevice WHERE user_id=?")
    .bind(user.id)
    .first<{ enabled: number }>();
  if (!device) {
    const dbUser = await getUserById(c.env.DB, user.id);
    return c.json({ allowed: Boolean(dbUser?.password) });
  }
  return c.json({ allowed: true, is_enabled: Boolean(device.enabled), type: "totp" });
});

r.get("/configuration/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const device = await c.env.DB.prepare("SELECT secret, enabled FROM core_twofactorauthenticationdevice WHERE user_id=?")
    .bind(user.id)
    .first<{ secret: string; enabled: number }>();
  if (!device) {
    const dbUser = await getUserById(c.env.DB, user.id);
    return c.json({ allowed: Boolean(dbUser?.password) });
  }
  const isEnabled = Boolean(device.enabled);
  const url = isEnabled ? "" : provisioningUrl(user.email, device.secret);
  return c.json({
    allowed: true,
    type: "totp",
    is_enabled: isEnabled,
    provisioning_url: url,
    provisioning_qr_code: url ? await qrCodeDataUri(url) : "",
    backup_codes: [],
  });
});

r.post("/configuration/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ type?: string; code?: string }>();
  if ((body.type || "totp") !== "totp") {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_TYPE_DOES_NOT_EXIST", "The requested two-factor authentication provider does not exist.", 404);
    return c.json(err.body, err.status as any);
  }

  const dbUser = await getUserById(c.env.DB, user.id);
  if (!dbUser?.password) {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_CANNOT_BE_CONFIGURED", "Two-factor authentication cannot be configured for this user.");
    return c.json(err.body, err.status as any);
  }

  const device = await c.env.DB.prepare("SELECT * FROM core_twofactorauthenticationdevice WHERE user_id=?")
    .bind(user.id)
    .first<any>();

  if (device?.enabled) {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_ALREADY_CONFIGURED", "Two-factor authentication is already configured for this user.");
    return c.json(err.body, err.status as any);
  }

  if (!device || !body.code) {
    const secret = randomBase32();
    await c.env.DB.prepare(
      `INSERT INTO core_twofactorauthenticationdevice (user_id, secret, enabled, backup_codes)
       VALUES (?, ?, 0, '[]')
       ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret, enabled=0, backup_codes='[]'`
    ).bind(user.id, secret).run();
    const url = provisioningUrl(user.email, secret);
    return c.json({
      type: "totp",
      is_enabled: false,
      provisioning_url: url,
      provisioning_qr_code: await qrCodeDataUri(url),
      backup_codes: [],
    });
  }

  if (!(await verifyTotp(device.secret, body.code))) {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_VERIFICATION_FAILED", "Two-factor authentication verification failed.", 401);
    return c.json(err.body, err.status as any);
  }
  const codes = backupCodes();
  await c.env.DB.prepare("UPDATE core_twofactorauthenticationdevice SET enabled=1, backup_codes=? WHERE user_id=?")
    .bind(JSON.stringify(await hashBackupCodes(codes)), user.id)
    .run();
  return c.json({
    type: "totp",
    is_enabled: true,
    provisioning_url: "",
    provisioning_qr_code: "",
    backup_codes: codes,
  });
});

r.post("/disable/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ password?: string }>();
  if (!body.password) {
    return c.json({ error: "ERROR_REQUEST_BODY_VALIDATION", detail: "The password field is required." }, 400);
  }
  const device = await c.env.DB.prepare("SELECT id FROM core_twofactorauthenticationdevice WHERE user_id=? AND enabled=1")
    .bind(user.id)
    .first<{ id: number }>();
  if (!device) {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_NOT_CONFIGURED", "Two-factor authentication is not configured for this user.");
    return c.json(err.body, err.status as any);
  }
  const dbUser = await getUserById(c.env.DB, user.id);
  if (!dbUser || !(await verifyPassword(body.password, dbUser.password))) {
    return c.json({ error: "ERROR_WRONG_PASSWORD", detail: "The provided password is incorrect." }, 403);
  }
  await c.env.DB.prepare("DELETE FROM core_twofactorauthenticationdevice WHERE user_id=?").bind(user.id).run();
  return new Response(null, { status: 204 });
});

r.post("/verify/", async (c) => {
  const authHeader = c.req.header("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) throw new AuthenticationError();
  const token = authHeader.slice(7);
  const payload = await verifyToken(token, c.env.JWT_SIGNING_KEY);
  if (payload.token_type !== "2fa" && payload.token_type !== "two_factor") throw new AuthenticationError("Invalid token type.");

  const body = await c.req.json<{ type?: string; email?: string; code?: string; backup_code?: string }>();
  if ((body.type || "totp") !== "totp") {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_TYPE_DOES_NOT_EXIST", "The requested two-factor authentication provider does not exist.", 404);
    return c.json(err.body, err.status as any);
  }
  if (!body.email || body.email.toLowerCase() !== String(payload.email || "").toLowerCase()) {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_VERIFICATION_FAILED", "Two-factor authentication verification failed.", 401);
    return c.json(err.body, err.status as any);
  }

  const dbUser = await c.env.DB.prepare("SELECT id FROM auth_user WHERE email = ? COLLATE NOCASE AND id = ?")
    .bind(body.email, payload.user_id)
    .first<{ id: number }>();
  let device: any = null;
  if (dbUser) {
    device = await c.env.DB.prepare("SELECT * FROM core_twofactorauthenticationdevice WHERE user_id=? AND enabled=1")
      .bind(dbUser.id)
      .first<any>();
  }
  if (!device || !dbUser) {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_VERIFICATION_FAILED", "Two-factor authentication verification failed.", 401);
    return c.json(err.body, err.status as any);
  }

  let valid = false;
  if (body.code && !(await isTotpCodeReused(c.env, dbUser.id, body.code))) {
    valid = await verifyTotp(device.secret, body.code);
    if (valid) {
      await markTotpCodeUsed(c.env, dbUser.id, body.code);
    }
  }
  if (!valid && body.backup_code) {
    const codes = parseBackupCodes(device.backup_codes);
    const remaining: string[] = [];
    for (const code of codes) {
      if (!valid && await backupCodeMatches(code, body.backup_code)) {
        valid = true;
      } else {
        remaining.push(code);
      }
    }
    if (valid) {
      await c.env.DB.prepare("UPDATE core_twofactorauthenticationdevice SET backup_codes=? WHERE user_id=?")
        .bind(JSON.stringify(remaining), dbUser.id)
        .run();
    }
  }
  if (!valid) {
    const err = twoFactorError("ERROR_TWO_FACTOR_AUTH_VERIFICATION_FAILED", "Two-factor authentication verification failed.", 401);
    return c.json(err.body, err.status as any);
  }
  return c.json(await authResponse(c.env, dbUser.id));
});

export { r as twoFactorRouter };
