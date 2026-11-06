import type { Context } from "hono";
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

type RequestUserRow = RequestUser & { last_password_change?: string | null };

async function userById(db: D1Database, userId: number): Promise<RequestUserRow | null> {
  return db.prepare(
    `SELECT id, email, username, is_staff, is_active,
            is_staff AS can_create_accounts, last_password_change
     FROM auth_user WHERE id = ?`
  )
    .bind(userId)
    .first<RequestUserRow>();
}

function toRequestUser(row: RequestUserRow): RequestUser {
  const { last_password_change: _lastPasswordChange, ...user } = row;
  return user;
}

/**
 * Like Baserow's `UserProfile.is_jwt_token_valid`: a password change or reset
 * invalidates every token issued before it (compared at second precision).
 */
export function issuedBeforePasswordChange(issuedAt: unknown, lastPasswordChange: unknown): boolean {
  if (!lastPasswordChange) return false;
  const changedAt = Math.floor(Date.parse(String(lastPasswordChange)) / 1000);
  if (!Number.isFinite(changedAt)) return false;
  return typeof issuedAt !== "number" || changedAt > issuedAt;
}

function activeUserForToken(row: RequestUserRow | null, issuedAt: unknown): RequestUser | null {
  if (!row || !row.is_active || issuedBeforePasswordChange(issuedAt, row.last_password_change)) return null;
  return toRequestUser(row);
}

export type DatabaseTokenOperation = "create" | "read" | "update" | "delete";

/** Whether the token grants any of `operations` on the table (Baserow's TokenHandler semantics). */
export function databaseTokenAllows(
  token: RequestVariables["db_token_permissions"],
  table: { id: number; database_id: number; workspace_id: number },
  operations: DatabaseTokenOperation[]
): boolean {
  if (!token || Number(token.workspace_id) !== Number(table.workspace_id)) return false;
  return token.permissions.some((permission) => {
    if (!operations.includes(permission.type as DatabaseTokenOperation)) return false;
    if (permission.table_id === null && permission.database_id === null) return true;
    if (permission.table_id === table.id) return true;
    return permission.database_id === table.database_id;
  });
}

/** Database API token from `Authorization: Token <key>` (Baserow) or `Bearer <key>`. */
export function databaseTokenKey(authHeader: string): string | null {
  const match = /^(?:Token|Bearer) (\S+)$/.exec(authHeader.trim());
  return match ? match[1] : null;
}

export async function authenticateUserSessionRequest(env: Env, request: Request): Promise<RequestUser | null> {
  const cookie = cookieValue(request, "user_session");
  if (cookie) {
    try {
      const payload = await verifyToken(decodeURIComponent(cookie), env.JWT_SIGNING_KEY);
      if (payload.token_type === "user_session" && typeof payload.token_hash === "string") {
        const blacklisted = await env.CACHE.get(refreshSessionBlacklistKey(payload.token_hash));
        if (!blacklisted) {
          const user = activeUserForToken(await userById(env.DB, Number(payload.user_id)), payload.iat);
          if (user) return user;
        }
      }
    } catch {
      // A stale session cookie must not hide a valid access token below.
    }
  }

  const authHeader = request.headers.get("Authorization") || "";
  const queryToken = new URL(request.url).searchParams.get("jwt_token") || new URL(request.url).searchParams.get("token");
  const accessToken = authHeader.startsWith("JWT ") ? authHeader.slice(4) : queryToken;
  if (!accessToken) return null;
  try {
    const payload = await verifyToken(accessToken, env.JWT_SIGNING_KEY);
    if (payload.token_type !== "access") return null;
    return activeUserForToken(await userById(env.DB, Number(payload.user_id)), payload.iat);
  } catch {
    return null;
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────

type AuthContext = Context<{ Bindings: Env; Variables: RequestVariables }>;

/** JWT-only authentication. Database tokens are only accepted by `databaseTokenAuthMiddleware`. */
async function authenticateJwt(c: AuthContext, token: string): Promise<void> {
  try {
    const payload = await verifyToken(token, c.env.JWT_SIGNING_KEY);

    if (payload.token_type !== "access") {
      throw new AuthenticationError("Invalid token type.");
    }

    const user = await userById(c.env.DB, Number(payload.user_id));
    if (!user) {
      throw new AuthenticationError("User not found.");
    }
    if (!user.is_active) {
      throw new AuthenticationError("User account is disabled.");
    }
    if (issuedBeforePasswordChange(payload.iat, user.last_password_change)) {
      throw new AuthenticationError("Token has been invalidated.");
    }

    c.set("user", toRequestUser(user));
    c.set("client_session_id", c.req.header("ClientSessionId") || "");
    c.set("websocket_id", c.req.header("WebsocketId") || "");
  } catch (e: any) {
    if (e.name === "AuthenticationError") throw e;
    if (e.code === "ERR_JWT_EXPIRED") {
      throw new AuthenticationError("Token has expired.");
    }
    throw new AuthenticationError("Invalid token.");
  }
}

/**
 * Database API token authentication, like Baserow's `TokenAuthentication`: the
 * token must be active, its user active and still a member of the token's
 * workspace. Token and permissions are read in parallel.
 */
async function authenticateDatabaseToken(c: AuthContext, key: string): Promise<Response | null> {
  const [token, permissions] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.id AS token_id, t.workspace_id, u.id, u.email, u.username, u.is_staff, u.is_active,
              u.is_staff AS can_create_accounts,
              EXISTS (
                SELECT 1 FROM core_workspaceuser wu
                WHERE wu.workspace_id = t.workspace_id AND wu.user_id = t.user_id AND wu.to_be_deleted = 0
              ) AS is_member
       FROM database_token t
       JOIN auth_user u ON u.id = t.user_id
       WHERE t.key = ? AND t.active = 1`
    ).bind(key).first<RequestUser & { token_id: number; workspace_id: number; is_member: number }>(),
    c.env.DB.prepare(
      `SELECT p.type, p.table_id, p.database_id
       FROM database_tokenpermission p
       JOIN database_token t ON t.id = p.token_id
       WHERE t.key = ? AND t.active = 1`
    ).bind(key).all<{ type: string; table_id: number | null; database_id: number | null }>(),
  ]);

  if (!token) {
    return c.json({ error: "ERROR_TOKEN_DOES_NOT_EXIST", detail: "The provided token does not exist." }, 401);
  }
  if (!token.is_member) {
    return c.json({ error: "ERROR_TOKEN_GROUP_MISMATCH", detail: "The token's user does not belong to the group anymore." }, 401);
  }
  if (!token.is_active) {
    return c.json({ error: "ERROR_USER_NOT_ACTIVE", detail: "The user related to the token is disabled." }, 401);
  }

  const { token_id: tokenId, workspace_id: workspaceId, is_member: _isMember, ...user } = token;
  c.set("user", user);
  c.set("db_token_permissions", {
    token_id: tokenId,
    workspace_id: workspaceId,
    permissions: permissions.results || [],
  });
  c.set("client_session_id", c.req.header("ClientSessionId") || "");
  c.set("websocket_id", c.req.header("WebsocketId") || "");
  return null;
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: RequestVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization") || "";
  if (!authHeader.startsWith("JWT ")) {
    throw new AuthenticationError();
  }
  await authenticateJwt(c, authHeader.slice(4));
  return next();
});

/**
 * For the endpoints Baserow opens to database tokens (rows, field list, file
 * uploads, token check). Falls back to JWT, or to anonymous access when
 * `optional` is set (template and public reads).
 */
export function databaseTokenAuthMiddleware(options: { optional?: boolean } = {}) {
  return createMiddleware<{ Bindings: Env; Variables: RequestVariables }>(async (c, next) => {
    const authHeader = c.req.header("Authorization") || "";
    const tokenKey = databaseTokenKey(authHeader);
    if (tokenKey) {
      const failure = await authenticateDatabaseToken(c, tokenKey);
      if (failure) return failure;
      return next();
    }
    if (authHeader.startsWith("JWT ")) {
      if (options.optional) {
        await setOptionalJwtUser(c, authHeader.slice(4));
      } else {
        await authenticateJwt(c, authHeader.slice(4));
      }
      return next();
    }
    if (!options.optional) throw new AuthenticationError();
    return next();
  });
}

async function setOptionalJwtUser(c: AuthContext, token: string): Promise<void> {
  try {
    const payload = await verifyToken(token, c.env.JWT_SIGNING_KEY);
    if (payload.token_type !== "access") return;
    const user = activeUserForToken(await userById(c.env.DB, Number(payload.user_id)), payload.iat);
    if (user) c.set("user", user);
  } catch {
    // Ignore auth errors for optional auth
  }
}

// ── Optional auth (for public views) ─────────────────────────────────────────
export const optionalAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: RequestVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization") || "";
  if (authHeader.startsWith("JWT ")) await setOptionalJwtUser(c, authHeader.slice(4));
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
