import { Hono, type Context } from "hono";
import { decodeJwt } from "jose";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware, issuedBeforePasswordChange, optionalAuthMiddleware, refreshSessionBlacklistKey, sha256Hex, signAccessToken, signRefreshToken, signTwoFactorToken, signUserSession, verifyToken } from "../middleware/auth";
import { ApiError, AuthenticationError, DoesNotExist, ValidationError } from "../middleware/error";
import {
  getUserByEmail,
  getUserById,
  getUserProfile,
  createUser,
  createInitialWorkspace,
  updateUserLastLogin,
  hashPassword,
  verifyPassword,
  serializeUser,
  parseCompletedGuidedTours,
} from "../services/user";
import {
  frontendLinkBaseUrl,
  sendChangeEmailConfirmationEmail,
  sendPasswordResetEmail,
  sendEmailVerificationEmail,
} from "../services/email";
import { logAuditEntry } from "../services/audit-log";
import { redoUserAction, undoUserAction } from "../services/undo-redo";
import { authProviderDisabledBody, ensurePasswordAuthProvider } from "../services/auth-providers";
import { createDirectNotificationForUsers, markInvitationNotificationAsRead } from "../services/notifications";
import type { RequestUser } from "../types/env";
import {
  assertEmailAllowlisted,
  assertInvitedAccountCreationAllowed,
} from "../services/account-access";
import {
  isLastActiveInstanceAdmin,
} from "../services/account-deletion";

const user = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
type AppContext = Context<{ Bindings: Env; Variables: RequestVariables }>;

type RegisterBody = {
  name: string;
  email: string;
  password: string;
  language?: string;
  authenticate?: boolean;
  workspace_invitation_token?: string;
};

type SignupInvitation = {
  id: number;
  workspace_id: number;
  invited_by_id: number;
  email: string;
  permissions: string;
  token: string;
};

function tokenPayload(userId: number, email: string) {
  const normalized = email.toLowerCase();
  return { user_id: userId, email: normalized, username: normalized };
}

async function verifyTokenOrAuthError(token: string, signingKey: string) {
  try {
    return await verifyToken(token, signingKey);
  } catch {
    throw new AuthenticationError("Invalid or expired token.");
  }
}

function ttlMinutes(c: AppContext): number {
  return parseInt(c.env.JWT_ACCESS_TTL_MINUTES || "10", 10);
}

function ttlDays(c: AppContext): number {
  return parseInt(c.env.JWT_REFRESH_TTL_DAYS || "7", 10);
}

/** The user id a token claims, before its signature is checked; null when unreadable. */
function unverifiedUserId(token: string): number | null {
  try {
    const userId = Number(decodeJwt(token).user_id);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}

async function isRefreshTokenBlacklisted(c: AppContext, refreshToken: string): Promise<boolean> {
  return Boolean(await c.env.CACHE.get(`blacklist:${refreshToken.slice(-16)}`));
}

function auditUserFromRow(row: { id: number; email: string; username?: string | null; is_staff?: number | boolean; is_active?: number | boolean; can_create_accounts?: number | boolean }): RequestUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username || row.email,
    is_staff: Boolean(row.is_staff),
    is_active: Boolean(row.is_active),
    can_create_accounts: Boolean(row.is_staff || row.can_create_accounts),
  };
}

async function auditUserById(db: D1Database, userId: number): Promise<RequestUser | null> {
  const row = await getUserById(db, userId);
  return row ? auditUserFromRow(row) : null;
}

/** Session tokens and user data for `userId`, as returned by login (used by admin impersonation). */
export function issueUserSession(c: AppContext, userId: number) {
  return authResponse(c, userId);
}

async function authResponse(c: AppContext, userId: number, refreshToken?: string, refreshIssuedAt?: unknown) {
  const [dbUser, profile] = await Promise.all([getUserById(c.env.DB, userId), getUserProfile(c.env.DB, userId)]);
  return sessionResponse(c, dbUser, profile, refreshToken, refreshIssuedAt);
}

/** authResponse for a user row and profile the caller already read. */
async function sessionResponse(
  c: AppContext,
  dbUser: Awaited<ReturnType<typeof getUserById>>,
  profile: Awaited<ReturnType<typeof getUserProfile>>,
  refreshToken?: string,
  refreshIssuedAt?: unknown
) {
  if (!dbUser || !dbUser.is_active) {
    throw new AuthenticationError("User not found or inactive.");
  }
  if (refreshToken && issuedBeforePasswordChange(refreshIssuedAt, dbUser.last_password_change)) {
    throw new AuthenticationError("Token is invalidated.");
  }

  const payload = tokenPayload(dbUser.id, dbUser.email);
  const access = await signAccessToken(payload, c.env.JWT_SIGNING_KEY, ttlMinutes(c));
  const refresh =
    refreshToken ||
    (await signRefreshToken(payload, c.env.JWT_SIGNING_KEY, ttlDays(c)));
  const userSession = await signUserSession({ user_id: dbUser.id }, refresh, c.env.JWT_SIGNING_KEY, ttlDays(c));

  return {
    access_token: access,
    refresh_token: refresh,
    user_session: userSession,
    permissions: [],
    user: serializeUser(dbUser, profile),
  };
}

async function resetPasswordAllowed(db: D1Database): Promise<boolean> {
  const settings = await db.prepare("SELECT allow_reset_password FROM core_settings WHERE id=1")
    .first<{ allow_reset_password: number | null }>();
  return settings ? Boolean(settings.allow_reset_password) : true;
}

function resetPasswordDisabled(c: AppContext) {
  return c.json({ error: "ERROR_DISABLED_RESET_PASSWORD", detail: "Reset password is disabled." }, 400);
}

function passwordProviderDisabled(c: AppContext) {
  return c.json(authProviderDisabledBody(), 401);
}

async function signupInvitation(db: D1Database, token?: string): Promise<SignupInvitation | null> {
  if (!token) return null;
  return db.prepare("SELECT * FROM core_workspaceinvitation WHERE token=?")
    .bind(token)
    .first<SignupInvitation>();
}

async function acceptSignupInvitation(c: AppContext, userId: number, invitation: SignupInvitation) {
  const maxOrder = await c.env.DB.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM core_workspaceuser WHERE user_id=?"
  ).bind(userId).first<{ max_order: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted)
       VALUES (?, ?, ?, ?, 0)`
    ).bind(invitation.workspace_id, userId, (maxOrder?.max_order ?? 0) + 1, invitation.permissions),
    c.env.DB.prepare("DELETE FROM core_workspaceinvitation WHERE id=?").bind(invitation.id),
    c.env.DB.prepare("UPDATE core_userprofile SET email_verified=1 WHERE user_id=?").bind(userId),
  ]);
  await markInvitationNotificationAsRead(c.env.DB, userId, invitation.id);
  const workspace = await c.env.DB.prepare("SELECT name FROM core_workspace WHERE id=?")
    .bind(invitation.workspace_id)
    .first<{ name: string }>();
  await createDirectNotificationForUsers(c.env.DB, {
    type: "workspace_invitation_accepted",
    recipientIds: [invitation.invited_by_id],
    senderId: userId,
    workspaceId: invitation.workspace_id,
    data: {
      invitation_id: invitation.id,
      invited_to_workspace_id: invitation.workspace_id,
      invited_to_workspace_name: workspace?.name || "",
    },
  });
}

async function createRegisteredUser(
  c: AppContext,
  body: RegisterBody
) {
  if (!body.name || !body.email || !body.password) {
    throw new ValidationError("name, email and password are required.");
  }

  if (body.password.length < 8) {
    throw new ValidationError("Password must be at least 8 characters.");
  }

  if (body.password.length > 256) {
    throw new ValidationError("Password must not exceed 256 characters.");
  }

  const normalizedEmail = body.email.toLowerCase();
  const passwordProvider = await ensurePasswordAuthProvider(c.env.DB);
  if (!passwordProvider.enabled) return passwordProviderDisabled(c);
  const invitation = await signupInvitation(c.env.DB, body.workspace_invitation_token);
  if (body.workspace_invitation_token && !invitation) {
    return c.json({
      error: "ERROR_GROUP_INVITATION_DOES_NOT_EXIST",
      detail: "The requested group invitation does not exist.",
    }, 404);
  }
  if (invitation && invitation.email.toLowerCase() !== normalizedEmail) {
    return c.json({
      error: "ERROR_GROUP_INVITATION_EMAIL_MISMATCH",
      detail: "Your email address does not match with the invitation.",
    }, 400);
  }
  const existing = await getUserByEmail(c.env.DB, normalizedEmail);
  if (existing) {
    return c.json(
      {
        error: "ERROR_EMAIL_ALREADY_EXISTS",
        detail: "A user with this email address already exists.",
      },
      400
    );
  }

  const passwordHash = await hashPassword(body.password);
  const parts = body.name.trim().split(/\s+/).filter(Boolean);
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || body.name.trim();
  const lastName = parts.length > 1 ? parts[parts.length - 1] : "";
  const settings = await c.env.DB.prepare(
    "SELECT show_admin_signup_page FROM core_settings WHERE id=1"
  ).first<{ show_admin_signup_page: number }>();
  const userCount = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM auth_user")
    .first<{ count: number }>();
  const isInitialAdmin = Boolean(settings?.show_admin_signup_page) && (userCount?.count ?? 0) === 0;
  if (!isInitialAdmin && !invitation) {
    return c.json({ error: "ERROR_DISABLED_SIGNUP", detail: "An invitation is required to create an account." }, 400);
  }
  if (!isInitialAdmin && invitation) {
    await assertInvitedAccountCreationAllowed(c.env.DB, normalizedEmail, invitation.invited_by_id);
  }
  const userId = await createUser(c.env.DB, {
    email: normalizedEmail,
    username: normalizedEmail,
    first_name: firstName,
    password_hash: passwordHash,
    is_staff: isInitialAdmin,
    is_superuser: isInitialAdmin,
  });

  const updates = [
    c.env.DB.prepare("UPDATE auth_user SET last_name = ? WHERE id = ?").bind(lastName, userId),
    c.env.DB.prepare("UPDATE core_userprofile SET language = ? WHERE user_id = ?").bind(body.language || "en", userId),
    c.env.DB.prepare("INSERT OR IGNORE INTO core_authprovideruser (auth_provider_id, user_id) VALUES (?, ?)").bind(passwordProvider.id, userId),
  ];
  if (isInitialAdmin) {
    updates.push(c.env.DB.prepare("UPDATE core_settings SET show_admin_signup_page=0, updated_at=? WHERE id=1")
      .bind(new Date().toISOString()));
  }
  await c.env.DB.batch(updates);
  if (invitation) await acceptSignupInvitation(c, userId, invitation);
  else await createInitialWorkspace(c.env.DB, userId, firstName);

  const dbUser = await getUserById(c.env.DB, userId);
  const profile = await getUserProfile(c.env.DB, userId);
  await logAuditEntry(c.env.DB, "user.create", {
    user: null,
  }, { id: userId, type: "user" }, {
    user_id: userId,
    email: dbUser?.email || normalizedEmail,
    initial_admin: isInitialAdmin,
    authenticated: body.authenticate !== false,
  });
  const response: Record<string, unknown> = {
    user: serializeUser(dbUser!, profile),
  };

  if (body.authenticate !== false) {
    Object.assign(response, await authResponse(c, userId));
  }

  return c.json(response, 201);
}

// ── POST /api/user/token-auth/ — Login ──────────────────────────────────────
user.post("/token-auth/", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();

  if (!body.email || !body.password) {
    return c.json(
      { error: "INVALID_CREDENTIALS", detail: "Email and password are required." },
      400
    );
  }

  const dbUser = await getUserByEmail(c.env.DB, body.email);
  if (!dbUser) {
    throw new AuthenticationError("Invalid credentials.");
  }

  const valid = await verifyPassword(body.password, dbUser.password);
  if (!valid) {
    throw new AuthenticationError("Invalid credentials.");
  }

  if (!dbUser.is_active) {
    throw new AuthenticationError("Account is disabled.");
  }
  const passwordProvider = await ensurePasswordAuthProvider(c.env.DB);
  if (!passwordProvider.enabled && !dbUser.is_staff) return passwordProviderDisabled(c);

  const twoFactorDevice = await c.env.DB.prepare(
    "SELECT id, enabled FROM core_twofactorauthenticationdevice WHERE user_id=? AND enabled=1"
  ).bind(dbUser.id).first<{ id: number; enabled: number }>();

  if (twoFactorDevice) {
    const payload = tokenPayload(dbUser.id, dbUser.email);
    await logAuditEntry(c.env.DB, "auth.two_factor_challenge", {
      user: auditUserFromRow(dbUser),
    }, { id: dbUser.id, type: "user" }, {
      user_id: dbUser.id,
      email: dbUser.email,
      method: "totp",
    });
    return c.json({
      two_factor_auth: "totp",
      token: await signTwoFactorToken(payload, c.env.JWT_SIGNING_KEY),
    });
  }

  await updateUserLastLogin(c.env.DB, dbUser.id);
  await logAuditEntry(c.env.DB, "auth.login", {
    user: auditUserFromRow(dbUser),
  }, { id: dbUser.id, type: "user" }, {
    user_id: dbUser.id,
    email: dbUser.email,
  });
  return c.json(await authResponse(c, dbUser.id));
});

// ── POST /api/user/token-refresh/ — Refresh access token ────────────────────
user.post("/token-refresh/", async (c) => {
  const body = await c.req.json<{ refresh_token?: string; token?: string }>();
  const refreshToken = body.refresh_token || body.token;

  if (!refreshToken) {
    return c.json({ error: "INVALID_REQUEST", detail: "refresh_token is required." }, 400);
  }

  // The blacklist entry, the token's signature and the user it names are read
  // at once; the user is only used once the token checks out.
  const claimedUserId = unverifiedUserId(refreshToken);
  const [blacklisted, payload, dbUser, profile] = await Promise.all([
    isRefreshTokenBlacklisted(c, refreshToken),
    verifyToken(refreshToken, c.env.JWT_SIGNING_KEY).catch((): null => null),
    claimedUserId ? getUserById(c.env.DB, claimedUserId) : null,
    claimedUserId ? getUserProfile(c.env.DB, claimedUserId) : null,
  ]);
  if (blacklisted) {
    throw new AuthenticationError("Refresh token has been invalidated.");
  }
  if (!payload) {
    throw new AuthenticationError("Invalid or expired refresh token.");
  }
  if (payload.token_type !== "refresh") {
    throw new AuthenticationError("Invalid token type.");
  }
  if (Number(payload.user_id) !== claimedUserId) {
    throw new AuthenticationError("Invalid or expired refresh token.");
  }

  const auditUser = dbUser ? auditUserFromRow(dbUser) : null;
  await logAuditEntry(c.env.DB, "auth.token_refresh", {
    user: auditUser,
  }, { id: payload.user_id, type: "user" }, {
    user_id: payload.user_id,
    email: auditUser?.email || payload.email,
  });
  return c.json(await sessionResponse(c, dbUser, profile, refreshToken, payload.iat));
});

// ── POST /api/user/token-verify/ — Verify refresh token ─────────────────────
user.post("/token-verify/", async (c) => {
  const body = await c.req.json<{ refresh_token?: string; token?: string }>();
  const refreshToken = body.refresh_token || body.token;

  if (!refreshToken || (await isRefreshTokenBlacklisted(c, refreshToken))) {
    throw new AuthenticationError("Invalid refresh token.");
  }

  const payload = await verifyTokenOrAuthError(refreshToken, c.env.JWT_SIGNING_KEY);
  if (payload.token_type !== "refresh") {
    throw new AuthenticationError("Invalid token type.");
  }

  const dbUser = await getUserById(c.env.DB, payload.user_id);
  if (!dbUser || !dbUser.is_active || issuedBeforePasswordChange(payload.iat, dbUser.last_password_change)) {
    throw new AuthenticationError("User not found or inactive.");
  }

  return c.json({ user_id: dbUser.id, email: dbUser.email });
});

// ── POST /api/user/register/ — Register new user ────────────────────────────
user.post("/register/", async (c) => {
  const body = await c.req.json<RegisterBody>();

  return createRegisteredUser(c, body);
});

// ── POST /api/user/ — Register (Baserow frontend calls this path) ─────────────
user.post("/", async (c) => {
  const body = await c.req.json<RegisterBody>();
  return createRegisteredUser(c, body);
});

user.get("/", authMiddleware, async (c) => {
  const currentUser = c.get("user")!;
  const [dbUser, profile] = await Promise.all([
    getUserById(c.env.DB, currentUser.id),
    getUserProfile(c.env.DB, currentUser.id),
  ]);

  if (!dbUser) throw new DoesNotExist("User", currentUser.id);

  return c.json(serializeUser(dbUser, profile));
});

async function updateAccount(c: AppContext) {
  const currentUser = c.get("user")!;
  const body = await c.req.json<Partial<{
    name: string;
    first_name: string;
    last_name: string;
    language: string;
    timezone: string;
    email_notification_frequency: string;
    completed_onboarding: boolean;
    completed_guided_tours: string[];
  }>>();
  const beforeUser = await getUserById(c.env.DB, currentUser.id);
  const beforeProfile = await getUserProfile(c.env.DB, currentUser.id);

  // Support composite "name" field → split into first/last
  if (body.name && !body.first_name && !body.last_name) {
    const parts = body.name.trim().split(" ");
    body.first_name = parts.slice(0, -1).join(" ") || body.name.trim();
    body.last_name = parts.length > 1 ? parts[parts.length - 1] : "";
  }

  // Update auth_user fields
  if (body.first_name !== undefined || body.last_name !== undefined) {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.first_name !== undefined) { updates.push("first_name = ?"); values.push(body.first_name); }
    if (body.last_name !== undefined) { updates.push("last_name = ?"); values.push(body.last_name); }
    values.push(currentUser.id);
    await c.env.DB.prepare(`UPDATE auth_user SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  // Update profile fields
  const profileUpdates: string[] = [];
  const profileValues: unknown[] = [];
  if (body.language !== undefined) { profileUpdates.push("language = ?"); profileValues.push(body.language); }
  if (body.timezone !== undefined) { profileUpdates.push("timezone = ?"); profileValues.push(body.timezone); }
  if (body.email_notification_frequency !== undefined) {
    profileUpdates.push("email_notification_frequency = ?");
    profileValues.push(body.email_notification_frequency);
  }
  if (body.completed_onboarding !== undefined) {
    profileUpdates.push("completed_onboarding = ?");
    profileValues.push(body.completed_onboarding ? 1 : 0);
  }
  if (body.completed_guided_tours !== undefined) {
    const profile = await getUserProfile(c.env.DB, currentUser.id);
    const tours = new Set(parseCompletedGuidedTours(profile?.completed_guided_tours));
    for (const tour of body.completed_guided_tours) {
      if (typeof tour === "string" && tour.trim()) tours.add(tour);
    }
    profileUpdates.push("completed_guided_tours = ?");
    profileValues.push(JSON.stringify([...tours]));
  }

  if (profileUpdates.length > 0) {
    profileValues.push(currentUser.id);
    await c.env.DB.prepare(`UPDATE core_userprofile SET ${profileUpdates.join(", ")} WHERE user_id = ?`)
      .bind(...profileValues)
      .run();
  }

  const [dbUser, profile] = await Promise.all([
    getUserById(c.env.DB, currentUser.id),
    getUserProfile(c.env.DB, currentUser.id),
  ]);

  await logAuditEntry(c.env.DB, "user.update", {
    user: currentUser,
  }, { id: currentUser.id, type: "user" }, {
    user_id: currentUser.id,
    email: dbUser?.email || currentUser.email,
    before: {
      first_name: beforeUser?.first_name,
      last_name: beforeUser?.last_name,
      language: beforeProfile?.language,
      timezone: beforeProfile?.timezone,
      email_notification_frequency: beforeProfile?.email_notification_frequency,
      completed_onboarding: Boolean(beforeProfile?.completed_onboarding),
      completed_guided_tours: parseCompletedGuidedTours(beforeProfile?.completed_guided_tours),
    },
    after: {
      first_name: dbUser?.first_name,
      last_name: dbUser?.last_name,
      language: profile?.language,
      timezone: profile?.timezone,
      email_notification_frequency: profile?.email_notification_frequency,
      completed_onboarding: Boolean(profile?.completed_onboarding),
      completed_guided_tours: parseCompletedGuidedTours(profile?.completed_guided_tours),
    },
  });
  return c.json(serializeUser(dbUser!, profile));
}

// ── PATCH /api/user/ — Update current user ──────────────────────────────────
user.patch("/", authMiddleware, updateAccount);

// ── PATCH /api/user/account/ — Baserow account settings endpoint ─────────────
user.patch("/account/", authMiddleware, updateAccount);

// ── POST /api/user/change-password/ ─────────────────────────────────────────
user.post("/change-password/", authMiddleware, async (c) => {
  const currentUser = c.get("user")!;
  const body = await c.req.json<{ old_password: string; new_password: string }>();

  if (!body.old_password || !body.new_password) {
    throw new ValidationError("old_password and new_password are required.");
  }

  const dbUser = await getUserById(c.env.DB, currentUser.id);
  if (!dbUser) throw new DoesNotExist("User");
  const passwordProvider = await ensurePasswordAuthProvider(c.env.DB);
  if (!passwordProvider.enabled && !dbUser.is_staff) return passwordProviderDisabled(c);

  const valid = await verifyPassword(body.old_password, dbUser.password);
  if (!valid) {
    return c.json(
      { error: "INVALID_PASSWORD", detail: "The provided password is incorrect." },
      400
    );
  }

  if (body.new_password.length < 8) {
    throw new ValidationError("Password must be at least 8 characters.");
  }

  const newHash = await hashPassword(body.new_password);
  // Invalidates every existing session; the frontend logs in again right after.
  await c.env.DB.prepare("UPDATE auth_user SET password = ?, last_password_change = ? WHERE id = ?")
    .bind(newHash, new Date().toISOString(), currentUser.id)
    .run();
  await logAuditEntry(c.env.DB, "user.password.change", {
    user: currentUser,
  }, { id: currentUser.id, type: "user" }, {
    user_id: currentUser.id,
    email: currentUser.email,
  });

  return c.body(null, 204);
});

user.patch("/undo/", authMiddleware, async (c) => {
  const currentUser = c.get("user")!;
  const body = await c.req.json<{ scopes?: unknown }>().catch((): { scopes?: unknown } => ({}));
  return c.json(await undoUserAction(
    c.env,
    currentUser,
    body.scopes || {},
    c.get("client_session_id") || "",
    c.get("websocket_id") || ""
  ));
});

user.patch("/redo/", authMiddleware, async (c) => {
  const currentUser = c.get("user")!;
  const body = await c.req.json<{ scopes?: unknown }>().catch((): { scopes?: unknown } => ({}));
  return c.json(await redoUserAction(
    c.env,
    currentUser,
    body.scopes || {},
    c.get("client_session_id") || "",
    c.get("websocket_id") || ""
  ));
});

// ── POST /api/user/send-reset-password-email/ ────────────────────────────────
user.post("/send-reset-password-email/", async (c) => {
  const body = await c.req.json<{ email: string; base_url?: string }>();

  if (!body.email) {
    throw new ValidationError("email is required.");
  }
  const resetBaseUrl = frontendLinkBaseUrl(c.env, body.base_url, "/reset-password");
  if (!(await resetPasswordAllowed(c.env.DB))) return resetPasswordDisabled(c);

  const dbUser = await getUserByEmail(c.env.DB, body.email);
  // Always return 200 to prevent email enumeration
  if (!dbUser) {
    return c.body(null, 204);
  }
  const passwordProvider = await ensurePasswordAuthProvider(c.env.DB);
  if (!passwordProvider.enabled && !dbUser.is_staff) return passwordProviderDisabled(c);

  // Generate reset token (24h expiry)
  const resetToken = await generateSecureToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO core_passwordreset (email, token, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(dbUser.email, resetToken, new Date().toISOString(), expiresAt)
    .run();

  await sendPasswordResetEmail(c.env, dbUser.email, dbUser.first_name, resetToken, resetBaseUrl);
  await logAuditEntry(c.env.DB, "user.password.reset_request", {
    user: auditUserFromRow(dbUser),
  }, { id: dbUser.id, type: "user" }, {
    user_id: dbUser.id,
    email: dbUser.email,
  });

  return c.body(null, 204);
});

// ── POST /api/user/reset-password/ ──────────────────────────────────────────
user.post("/reset-password/", async (c) => {
  const body = await c.req.json<{ token: string; password: string }>();

  if (!body.token || !body.password) {
    throw new ValidationError("token and password are required.");
  }
  if (!(await resetPasswordAllowed(c.env.DB))) return resetPasswordDisabled(c);

  const reset = await c.env.DB.prepare(
    "SELECT * FROM core_passwordreset WHERE token = ? AND expires_at > ?"
  )
    .bind(body.token, new Date().toISOString())
    .first<{ email: string; token: string; expires_at: string }>();

  if (!reset) {
    return c.json(
      { error: "BAD_TOKEN_SIGNATURE", detail: "The reset token is invalid or has expired." },
      400
    );
  }

  if (body.password.length < 8) {
    throw new ValidationError("Password must be at least 8 characters.");
  }

  const newHash = await hashPassword(body.password);
  const dbUser = await getUserByEmail(c.env.DB, reset.email);
  if (!dbUser) throw new DoesNotExist("User");

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE auth_user SET password = ?, last_password_change = ? WHERE id = ?")
      .bind(newHash, new Date().toISOString(), dbUser.id),
    c.env.DB.prepare("DELETE FROM core_passwordreset WHERE token = ?").bind(body.token),
  ]);
  await logAuditEntry(c.env.DB, "user.password.reset", {
    user: auditUserFromRow(dbUser),
  }, { id: dbUser.id, type: "user" }, {
    user_id: dbUser.id,
    email: dbUser.email,
  });

  return c.body(null, 204);
});

// ── POST /api/user/send-change-email-confirmation/ ──────────────────────────
user.post("/send-change-email-confirmation/", authMiddleware, async (c) => {
  const currentUser = c.get("user")!;
  const body = await c.req.json<{ new_email: string; password: string; base_url?: string }>();

  if (!body.new_email || !body.password) {
    throw new ValidationError("new_email and password are required.");
  }

  const normalizedEmail = body.new_email.toLowerCase();
  const [dbUser, existing] = await Promise.all([
    getUserById(c.env.DB, currentUser.id),
    getUserByEmail(c.env.DB, normalizedEmail),
  ]);

  if (!dbUser) throw new DoesNotExist("User");
  const passwordProvider = await ensurePasswordAuthProvider(c.env.DB);
  if (!passwordProvider.enabled) return passwordProviderDisabled(c);
  if (existing && existing.id !== dbUser.id) {
    return c.json(
      { error: "ERROR_EMAIL_ALREADY_EXISTS", detail: "A user with this email address already exists." },
      400
    );
  }

  const valid = await verifyPassword(body.password, dbUser.password);
  if (!valid) {
    return c.json(
      { error: "ERROR_INVALID_OLD_PASSWORD", detail: "The provided password is incorrect." },
      400
    );
  }

  if (normalizedEmail === dbUser.email.toLowerCase()) {
    return c.body(null, 204);
  }

  await assertEmailAllowlisted(c.env.DB, normalizedEmail);

  const token = await generateSecureToken();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO core_emailchange (user_id, new_email, token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(dbUser.id, normalizedEmail, token, now, expiresAt)
    .run();

  const baseUrl = frontendLinkBaseUrl(c.env, body.base_url, "/change-email");
  await sendChangeEmailConfirmationEmail(c.env, normalizedEmail, dbUser.first_name, token, baseUrl);
  await logAuditEntry(c.env.DB, "user.email_change.request", {
    user: currentUser,
  }, { id: currentUser.id, type: "user" }, {
    user_id: currentUser.id,
    old_email: dbUser.email,
    new_email: normalizedEmail,
  });

  return c.body(null, 204);
});

// ── POST /api/user/change-email/ ────────────────────────────────────────────
user.post("/change-email/", async (c) => {
  const body = await c.req.json<{ token: string }>();
  if (!body.token) {
    throw new ValidationError("token is required.");
  }

  const change = await c.env.DB.prepare(
    "SELECT * FROM core_emailchange WHERE token = ? AND expires_at > ?"
  )
    .bind(body.token, new Date().toISOString())
    .first<{ user_id: number; new_email: string }>();

  if (!change) {
    return c.json(
      { error: "BAD_TOKEN_SIGNATURE", detail: "The change email token is invalid or has expired." },
      400
    );
  }

  const existing = await getUserByEmail(c.env.DB, change.new_email);
  if (existing && existing.id !== change.user_id) {
    return c.json(
      { error: "ERROR_EMAIL_ALREADY_EXISTS", detail: "A user with this email address already exists." },
      400
    );
  }

  await assertEmailAllowlisted(c.env.DB, change.new_email);

  await c.env.DB.batch([
    c.env.DB
      .prepare("UPDATE auth_user SET email = ?, username = ? WHERE id = ?")
      .bind(change.new_email, change.new_email, change.user_id),
    c.env.DB.prepare("UPDATE core_userprofile SET email_verified = 1 WHERE user_id = ?").bind(change.user_id),
    c.env.DB.prepare("DELETE FROM core_emailchange WHERE token = ?").bind(body.token),
  ]);
  await logAuditEntry(c.env.DB, "user.email_change.confirm", {
    user: await auditUserById(c.env.DB, change.user_id),
  }, { id: change.user_id, type: "user" }, {
    user_id: change.user_id,
    new_email: change.new_email,
  });

  return c.body(null, 204);
});

// ── POST /api/user/send-verify-email/ ───────────────────────────────────────
user.post("/send-verify-email/", async (c) => {
  const body = await c.req.json<{ email: string; base_url?: string }>();
  if (!body.email) {
    throw new ValidationError("email is required.");
  }
  const verifyBaseUrl = frontendLinkBaseUrl(c.env, body.base_url, "/verify-email-address");

  const dbUser = await getUserByEmail(c.env.DB, body.email);
  const profile = dbUser ? await getUserProfile(c.env.DB, dbUser.id) : null;
  if (!dbUser || profile?.email_verified) {
    return c.body(null, 204);
  }

  const token = await generateSecureToken();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO core_emailverification (user_id, token, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(dbUser.id, token, now, expiresAt)
    .run();

  await sendEmailVerificationEmail(c.env, dbUser.email, dbUser.first_name, token, verifyBaseUrl);
  await logAuditEntry(c.env.DB, "user.email_verification.request", {
    user: auditUserFromRow(dbUser),
  }, { id: dbUser.id, type: "user" }, {
    user_id: dbUser.id,
    email: dbUser.email,
  });

  return c.body(null, 204);
});

// ── POST /api/user/verify-email/ ─────────────────────────────────────────────
user.post("/verify-email/", optionalAuthMiddleware, async (c) => {
  const body = await c.req.json<{ token: string }>();

  if (!body.token) {
    throw new ValidationError("token is required.");
  }

  const verif = await c.env.DB.prepare(
    "SELECT * FROM core_emailverification WHERE token = ? AND expires_at > ?"
  )
    .bind(body.token, new Date().toISOString())
    .first<{ user_id: number }>();

  if (!verif) {
    return c.json(
      { error: "ERROR_INVALID_VERIFICATION_TOKEN", detail: "Invalid or expired verification token." },
      400
    );
  }

  const dbUser = await getUserById(c.env.DB, verif.user_id);
  if (!dbUser || !dbUser.is_active) {
    throw new AuthenticationError("User not found or inactive.");
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE core_userprofile SET email_verified = 1 WHERE user_id = ?").bind(verif.user_id),
    c.env.DB.prepare("DELETE FROM core_emailverification WHERE user_id = ?").bind(verif.user_id),
  ]);
  await logAuditEntry(c.env.DB, "user.email_verification.confirm", {
    user: auditUserFromRow(dbUser),
  }, { id: dbUser.id, type: "user" }, {
    user_id: dbUser.id,
    email: dbUser.email,
  });

  const currentUser = c.get("user");
  if (currentUser) {
    return c.json({ email: dbUser.email });
  }

  return c.json(await authResponse(c, dbUser.id));
});

// ── POST /api/user/token-blacklist/ — Logout ─────────────────────────────────
user.post("/token-blacklist/", async (c) => {
  const body = await c.req.json<{ refresh_token?: string }>();
  if (!body.refresh_token) {
    throw new ValidationError("refresh_token is required.");
  }

  const payload = await verifyTokenOrAuthError(body.refresh_token, c.env.JWT_SIGNING_KEY);
  if (payload.token_type !== "refresh") {
    throw new AuthenticationError("Invalid token type.");
  }

  const exp = typeof payload.exp === "number" ? payload.exp : Math.floor(Date.now() / 1000) + 604800;
  const expirationTtl = Math.max(60, exp - Math.floor(Date.now() / 1000));
  await c.env.CACHE.put(`blacklist:${body.refresh_token.slice(-16)}`, "1", { expirationTtl });
  await c.env.CACHE.put(refreshSessionBlacklistKey(await sha256Hex(body.refresh_token)), "1", { expirationTtl });
  const auditUser = await auditUserById(c.env.DB, payload.user_id);
  await logAuditEntry(c.env.DB, "auth.logout", {
    user: auditUser,
  }, { id: payload.user_id, type: "user" }, {
    user_id: payload.user_id,
    email: auditUser?.email || payload.email,
  });

  return c.body(null, 204);
});

// ── GET /api/user/dashboard/ ─────────────────────────────────────────────────
user.get("/dashboard/", authMiddleware, async (c) => {
  const currentUser = c.get("user")!;
  const invitations = await c.env.DB.prepare(
    `SELECT i.id, i.email, i.permissions, i.message, i.created_on, i.token,
            w.id AS workspace_id, w.name AS workspace_name,
            u.id AS invited_by_id, u.first_name, u.last_name, u.email AS invited_by_email
     FROM core_workspaceinvitation i
     JOIN core_workspace w ON w.id = i.workspace_id
     JOIN auth_user u ON u.id = i.invited_by_id
     WHERE i.email = ?
     ORDER BY i.created_on DESC`
  )
    .bind(currentUser.email)
    .all<any>();

  return c.json({
    workspace_invitations: (invitations.results || []).map((i: any) => ({
      id: i.id,
      email: i.email,
      permissions: i.permissions,
      message: i.message,
      created_on: i.created_on,
      token: i.token,
      workspace: {
        id: i.workspace_id,
        name: i.workspace_name,
      },
      invited_by: {
        id: i.invited_by_id,
        name: [i.first_name, i.last_name].filter(Boolean).join(" ") || i.invited_by_email,
        email: i.invited_by_email,
      },
    })),
  });
});

// ── POST /api/user/schedule-account-deletion/ ───────────────────────────────
user.post("/schedule-account-deletion/", authMiddleware, async (c) => {
  const currentUser = c.get("user")!;
  if (await isLastActiveInstanceAdmin(c.env.DB, currentUser.id)) {
    throw new ApiError(
      400,
      "ERROR_USER_IS_LAST_ADMIN",
      "The last active instance administrator cannot schedule their account for deletion."
    );
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE core_userprofile SET to_be_deleted=1, deletion_requested_at=? WHERE user_id=?"
  ).bind(now, currentUser.id).run();
  await logAuditEntry(c.env.DB, "user.account_deletion.schedule", {
    user: currentUser,
  }, { id: currentUser.id, type: "user" }, {
    user_id: currentUser.id,
    email: currentUser.email,
    deletion_requested_at: now,
  });
  return c.body(null, 204);
});

// ── POST /api/user/share-onboarding-details-with-baserow/ ───────────────────
user.post("/share-onboarding-details-with-baserow/", authMiddleware, async (c) => {
  const currentUser = c.get("user")!;
  const body = await c.req.json<{
    team?: string;
    role?: string;
    size?: string;
    country?: string;
    how?: string;
  }>();

  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO core_onboardingdetails
     (user_id, team, role, size, country, how, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      currentUser.id,
      body.team || "",
      body.role || "",
      body.size || "",
      body.country || "",
      body.how || "",
      new Date().toISOString()
    )
    .run();

  await c.env.DB.prepare("UPDATE core_userprofile SET completed_onboarding = 1 WHERE user_id = ?")
    .bind(currentUser.id)
    .run();
  await logAuditEntry(c.env.DB, "user.onboarding.update", {
    user: currentUser,
  }, { id: currentUser.id, type: "user" }, {
    user_id: currentUser.id,
    team: body.team || "",
    role: body.role || "",
    size: body.size || "",
    country: body.country || "",
    how: body.how || "",
  });

  return c.body(null, 204);
});

// ── Helper ─────────────────────────────────────────────────────────────────────
async function generateSecureToken(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export { user as userRouter };
