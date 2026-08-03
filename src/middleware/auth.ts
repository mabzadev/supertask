import { createMiddleware } from "hono/factory";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Env, RequestVariables, RequestUser } from "../types/env";
import { AuthenticationError } from "./error";

// ── JWT helpers ───────────────────────────────────────────────────────────────

export async function signAccessToken(
  payload: { user_id: number; email: string; username?: string },
  signingKey: string,
  ttlMinutes: number
): Promise<string> {
  const secret = new TextEncoder().encode(signingKey);
  return new SignJWT({ ...payload, token_type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlMinutes}m`)
    .sign(secret);
}

export async function signRefreshToken(
  payload: { user_id: number; email: string; username?: string },
  signingKey: string,
  ttlDays: number
): Promise<string> {
  const secret = new TextEncoder().encode(signingKey);
  return new SignJWT({ ...payload, token_type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlDays}d`)
    .sign(secret);
}

export async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function refreshSessionBlacklistKey(tokenHash: string): string {
  return `session-blacklist:${tokenHash}`;
}

export async function signUserSession(
  payload: { user_id: number },
  refreshToken: string,
  signingKey: string,
  ttlDays: number
): Promise<string> {
  const secret = new TextEncoder().encode(signingKey);
  return new SignJWT({
    user_id: String(payload.user_id),
    token_hash: await sha256Hex(refreshToken),
    token_type: "user_session",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlDays}d`)
    .sign(secret);
}

export async function signTwoFactorToken(
  payload: { user_id: number; email: string; username?: string },
  signingKey: string
): Promise<string> {
  const secret = new TextEncoder().encode(signingKey);
  return new SignJWT({ ...payload, token_type: "2fa" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

export async function verifyToken(
  token: string,
  signingKey: string
): Promise<JWTPayload & { user_id: number; email: string; username?: string; token_type: string }> {
  const secret = new TextEncoder().encode(signingKey);
  const { payload } = await jwtVerify(token, secret);
  return payload as JWTPayload & {
    user_id: number;
    email: string;
    username?: string;
    token_type: string;
  };
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return null;
}

async function userById(db: D1Database, userId: number): Promise<RequestUser | null> {
  return db.prepare(
    `SELECT id, email, username, is_staff, is_active,
            is_staff AS can_create_accounts
     FROM auth_user WHERE id = ?`
  )
    .bind(userId)
    .first<RequestUser>();
}

export async function authenticateUserSessionRequest(env: Env, request: Request): Promise<RequestUser | null> {
  const cookie = cookieValue(request, "user_session");
  if (cookie) {
    try {
      const payload = await verifyToken(decodeURIComponent(cookie), env.JWT_SIGNING_KEY);
      if (payload.token_type === "user_session" && typeof payload.token_hash === "string") {
        const blacklisted = await env.CACHE.get(refreshSessionBlacklistKey(payload.token_hash));
        if (!blacklisted) {
          const user = await userById(env.DB, Number(payload.user_id));
          if (user && user.is_active) return user;
        }
      }
    } catch {
      return null;
    }
  }

  const authHeader = request.headers.get("Authorization") || "";
  const queryToken = new URL(request.url).searchParams.get("jwt_token") || new URL(request.url).searchParams.get("token");
  const accessToken = authHeader.startsWith("JWT ") ? authHeader.slice(4) : queryToken;
  if (!accessToken) return null;
  try {
    const payload = await verifyToken(accessToken, env.JWT_SIGNING_KEY);
    if (payload.token_type !== "access") return null;
    const user = await userById(env.DB, Number(payload.user_id));
    return user && user.is_active ? user : null;
  } catch {
    return null;
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: RequestVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization") || "";
  let token: string | null = null;

  if (authHeader.startsWith("JWT ")) {
    token = authHeader.slice(4);
  } else if (authHeader.startsWith("Bearer ")) {
    // Database API token (handled separately)
    const rawToken = authHeader.slice(7);
    const dbToken = await c.env.DB.prepare(
      `SELECT id, user_id, workspace_id
       FROM database_token
       WHERE key = ? AND active = 1`
    )
      .bind(rawToken)
      .first<{ id: number; user_id: number; workspace_id: number }>();

    if (!dbToken) {
      return c.json(
        { error: "TOKEN_DOES_NOT_EXIST", detail: "The provided token does not exist." },
        401
      );
    }

    // Load user for db token
    const user = await c.env.DB.prepare(
      `SELECT id, email, username, is_staff, is_active,
              is_staff AS can_create_accounts
       FROM auth_user WHERE id = ?`
    )
      .bind(dbToken.user_id)
      .first<RequestUser>();

    if (!user || !user.is_active) {
      throw new AuthenticationError("User inactive or not found.");
    }

    const permissions = await c.env.DB.prepare(
      `SELECT type, table_id, database_id
       FROM database_tokenpermission
       WHERE token_id = ?`
    )
      .bind(dbToken.id)
      .all<{ type: string; table_id: number | null; database_id: number | null }>();

    c.set("user", user);
    c.set("db_token_permissions", {
      token_id: dbToken.id,
      workspace_id: dbToken.workspace_id,
      permissions: permissions.results || [],
    });
    return next();
  }

  if (!token) {
    throw new AuthenticationError();
  }

  try {
    const payload = await verifyToken(token, c.env.JWT_SIGNING_KEY);

    if (payload.token_type !== "access") {
      throw new AuthenticationError("Invalid token type.");
    }

    // Check blacklist in KV (fast path)
    const blacklisted = await c.env.CACHE.get(`blacklist:${token.slice(-16)}`);
    if (blacklisted) {
      throw new AuthenticationError("Token has been invalidated.");
    }

    // Load user from D1
    const user = await c.env.DB.prepare(
      `SELECT id, email, username, is_staff, is_active,
              is_staff AS can_create_accounts
       FROM auth_user WHERE id = ?`
    )
      .bind(payload.user_id)
      .first<RequestUser>();

    if (!user) {
      throw new AuthenticationError("User not found.");
    }
    if (!user.is_active) {
      throw new AuthenticationError("User account is disabled.");
    }

    c.set("user", user);
    c.set("client_session_id", c.req.header("ClientSessionId") || "");
    c.set("websocket_id", c.req.header("WebsocketId") || "");
  } catch (e: any) {
    if (e.name === "AuthenticationError") throw e;
    if (e.code === "ERR_JWT_EXPIRED") {
      throw new AuthenticationError("Token has expired.");
    }
    throw new AuthenticationError("Invalid token.");
  }

  return next();
});

// ── Optional auth (for public views) ─────────────────────────────────────────
export const optionalAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: RequestVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization") || "";
  if (authHeader.startsWith("JWT ")) {
    const token = authHeader.slice(4);
    try {
      const payload = await verifyToken(token, c.env.JWT_SIGNING_KEY);
      if (payload.token_type === "access") {
        const user = await c.env.DB.prepare(
          `SELECT id, email, username, is_staff, is_active,
                  is_staff AS can_create_accounts
           FROM auth_user WHERE id = ? AND is_active = 1`
        )
          .bind(payload.user_id)
          .first<RequestUser>();
        if (user) c.set("user", user);
      }
    } catch {
      // Ignore auth errors for optional auth
    }
  }
  return next();
});

// ── Admin-only middleware ─────────────────────────────────────────────────────
export const adminMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: RequestVariables;
}>(async (c, next) => {
  const user = c.get("user");
  if (!user) throw new AuthenticationError();
  if (!user.is_staff) {
    return c.json(
      { error: "ADMIN_ONLY", detail: "Only admin users can perform this action." },
      403
    );
  }
  return next();
});
