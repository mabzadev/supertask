import { Hono } from "hono";
import { deflateSync, strToU8 } from "fflate";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { Env, RequestVariables } from "../types/env";
import { signRefreshToken, signUserSession } from "../middleware/auth";
import { createDirectNotificationForUsers, markInvitationNotificationAsRead } from "../services/notifications";
import { decodeSamlResponse, parseSamlMetadata, samlClaim, samlIssuerFromResponse, validateSamlResponse } from "../services/saml";
import { createInitialWorkspace, createUser, getUserByEmail, updateUserLastLogin, type UserRow } from "../services/user";
import { assertInvitedAccountCreationAllowed } from "../services/account-access";

const sso = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const OAUTH_ENDPOINTS: Record<string, { authorize: string; token: string; userInfo: string; scope: string }> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://www.googleapis.com/oauth2/v4/token",
    userInfo: "https://www.googleapis.com/oauth2/v1/userinfo",
    scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    userInfo: "https://api.github.com/user",
    scope: "read:user user:email",
  },
  facebook: {
    authorize: "https://www.facebook.com/dialog/oauth",
    token: "https://graph.facebook.com/oauth/access_token",
    userInfo: "https://graph.facebook.com/me?fields=id,email,name",
    scope: "email",
  },
};

const SSO_ERRORS = {
  feature: "errorSsoFeatureNotActive",
  invalidSamlRequest: "errorInvalidSamlRequest",
  invalidSamlResponse: "errorInvalidSamlResponse",
  deactivated: "errorUserDeactivated",
  providerMissing: "errorProviderDoesNotExist",
  authFlow: "errorAuthFlowError",
  invitationMismatch: "errorWorkspaceInvitationEmailMismatch",
  signupDisabled: "errorSignupDisabled",
  differentProvider: "errorDifferentProvider",
};

export type AuthProvider = {
  id: number;
  type: string;
  enabled: number;
  domain: string | null;
  metadata: string;
};

type LoginRequestData = {
  original?: string;
  workspace_invitation_token?: string;
  language?: string;
};

export type OAuthRequestData = LoginRequestData & {
  provider_id: number;
  code_verifier?: string;
  oidc_nonce?: string;
};

type WorkspaceInvitation = {
  id: number;
  workspace_id: number;
  invited_by_id: number;
  email: string;
  permissions: string;
  token: string;
};

function parseJsonObject(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function backendUrl(env: Env, requestUrl: string): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, "");
  const parsed = new URL(requestUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

function frontendUrl(env: Env): string {
  return (env.PUBLIC_WEB_FRONTEND_URL || "https://supertask-web.pages.dev").replace(/\/$/, "");
}

function validFrontendRedirect(env: Env, original?: string | null, params: Record<string, string> = {}) {
  const base = frontendUrl(env);
  let target = `${base}/dashboard`;
  if (original) {
    try {
      const parsed = new URL(original, base);
      if (parsed.hostname === new URL(base).hostname) {
        target = parsed.toString();
      }
    } catch {
      target = `${base}/dashboard`;
    }
  }
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function errorRedirect(env: Env, code: string) {
  const url = new URL(`${frontendUrl(env)}/login/error`);
  url.searchParams.set("error", code);
  return url.toString();
}

function redirect(url: string) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function b64(bytes: Uint8Array) {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

function claimValue(payload: Record<string, any>, key: unknown): string {
  const value = payload[String(key || "")];
  if (Array.isArray(value)) return value.length > 0 ? String(value[0] ?? "") : "";
  return value === null || value === undefined ? "" : String(value);
}

function oidcUserInfoFromPayload(payload: Record<string, any>, metadata: Record<string, any>) {
  const email = claimValue(payload, metadata.email_attr_key || "email");
  const firstName = claimValue(payload, metadata.first_name_attr_key || "name");
  const lastName = metadata.last_name_attr_key ? claimValue(payload, metadata.last_name_attr_key) : "";
  return {
    email,
    name: [firstName, lastName].filter(Boolean).join(" ") || email,
  };
}

async function verifyOpenIdConnectIdToken(env: Env, metadata: Record<string, any>, idToken: string, expectedNonce?: string) {
  const jwksUrl = String(metadata.jwks_url || metadata.jwksUrl || "");
  const issuer = String(metadata.issuer || "");
  const audience = String(metadata.client_id || metadata.clientId || "");
  if (!jwksUrl || !issuer || !audience) throw new Error(SSO_ERRORS.authFlow);
  const cacheKey = `sso:oidc:jwks:${await sha256Base64Url(jwksUrl)}`;
  const parseJwks = (value: unknown): JSONWebKeySet => {
    if (!value || typeof value !== "object" || !Array.isArray((value as { keys?: unknown }).keys)) {
      throw new Error(SSO_ERRORS.authFlow);
    }
    return value as JSONWebKeySet;
  };
  const verify = async (jwks: JSONWebKeySet) => jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer,
      audience,
      algorithms: ["RS256"],
    });
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    try {
      const { payload } = await verify(parseJwks(JSON.parse(cached)));
      if (expectedNonce && payload.nonce !== expectedNonce) throw new Error(SSO_ERRORS.authFlow);
      return payload as Record<string, any>;
    } catch {
      await env.CACHE.delete(cacheKey);
    }
  }
  const jwksResponse = await fetch(jwksUrl, { headers: { accept: "application/json" } });
  if (!jwksResponse.ok) throw new Error(SSO_ERRORS.authFlow);
  const jwks = parseJwks(await jwksResponse.json());
  const { payload } = await verify(jwks);
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error(SSO_ERRORS.authFlow);
  await env.CACHE.put(cacheKey, JSON.stringify(jwks), { expirationTtl: 3600 });
  return payload as Record<string, any>;
}

function metadataString(provider: AuthProvider) {
  const metadata = parseJsonObject(provider.metadata);
  return String(metadata.metadata || provider.metadata || "");
}

function singleSignOnUrl(metadata: string) {
  try {
    return parseSamlMetadata(metadata).singleSignOnUrl;
  } catch {
    return "";
  }
}

function randomBase64Url(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return b64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalizeLoginQuery(url: URL): LoginRequestData {
  const original = url.searchParams.get("original");
  return {
    original: original && new URL(original, "https://local").hostname === "local" ? original : undefined,
    workspace_invitation_token: url.searchParams.get("workspace_invitation_token") || undefined,
    language: url.searchParams.get("language") || undefined,
  };
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function loginDataFromRelayState(env: Env, relayState: string): LoginRequestData {
  if (!relayState) return {};
  try {
    const frontend = new URL(frontendUrl(env));
    const parsed = new URL(relayState, frontend);
    if (parsed.hostname !== frontend.hostname) return {};
    return {
      original: `${parsed.pathname}${parsed.search}`,
      workspace_invitation_token: parsed.searchParams.get("workspace_invitation_token") || undefined,
      language: parsed.searchParams.get("language") || undefined,
    };
  } catch {
    return {};
  }
}

function redirectFromRelayState(env: Env, relayState: string): string | undefined {
  if (!relayState) return undefined;
  try {
    const frontend = new URL(frontendUrl(env));
    const parsed = new URL(relayState, frontend);
    if (parsed.hostname !== frontend.hostname) return undefined;
    parsed.search = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function recordAuthProviderUser(db: D1Database, providerId: number, userId: number) {
  await db.prepare(
    "INSERT OR IGNORE INTO core_authprovideruser (auth_provider_id, user_id) VALUES (?, ?)"
  ).bind(providerId, userId).run();
}

async function assertUserBelongsToAuthProvider(db: D1Database, providerId: number, userId: number) {
  const row = await db.prepare(
    "SELECT 1 AS ok FROM core_authprovideruser WHERE auth_provider_id=? AND user_id=?"
  ).bind(providerId, userId).first<{ ok: number }>();
  if (!row) throw new Error(SSO_ERRORS.differentProvider);
}

async function enabledProviderById(db: D1Database, id: number) {
  return db.prepare("SELECT * FROM core_authprovider WHERE id=? AND enabled=1").bind(id).first<AuthProvider>();
}

async function getWorkspaceInvitationByToken(db: D1Database, token?: string | null) {
  if (!token) return null;
  return db.prepare("SELECT * FROM core_workspaceinvitation WHERE token=?")
    .bind(token)
    .first<WorkspaceInvitation>();
}

function invitationNotificationData(invitation: WorkspaceInvitation, workspaceName: string) {
  return {
    invitation_id: invitation.id,
    invited_to_workspace_id: invitation.workspace_id,
    invited_to_workspace_name: workspaceName,
  };
}

async function acceptWorkspaceInvitationForSso(
  env: Env,
  user: Pick<UserRow, "id" | "email">,
  invitation: WorkspaceInvitation | null
) {
  if (!invitation) return false;
  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new Error(SSO_ERRORS.invitationMismatch);
  }

  const existing = await env.DB.prepare("SELECT id FROM core_workspaceuser WHERE workspace_id=? AND user_id=?")
    .bind(invitation.workspace_id, user.id)
    .first<{ id: number }>();
  if (existing) {
    await env.DB.prepare("UPDATE core_workspaceuser SET permissions=?, to_be_deleted=0 WHERE id=?")
      .bind(invitation.permissions, existing.id)
      .run();
  } else {
    const maxOrder = await env.DB.prepare("SELECT COALESCE(MAX([order]), 0) AS max_order FROM core_workspaceuser WHERE user_id=?")
      .bind(user.id)
      .first<{ max_order: number }>();
    await env.DB.prepare(
      `INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted)
       VALUES (?, ?, ?, ?, 0)`
    ).bind(invitation.workspace_id, user.id, (maxOrder?.max_order ?? 0) + 1, invitation.permissions).run();
  }

  await markInvitationNotificationAsRead(env.DB, user.id, invitation.id);
  await env.DB.prepare("DELETE FROM core_workspaceinvitation WHERE id=?").bind(invitation.id).run();
  await env.DB.prepare("UPDATE core_userprofile SET email_verified=1 WHERE user_id=?").bind(user.id).run();

  const workspace = await env.DB.prepare("SELECT name FROM core_workspace WHERE id=?")
    .bind(invitation.workspace_id)
    .first<{ name: string }>();
  await createDirectNotificationForUsers(env.DB, {
    type: "workspace_invitation_accepted",
    recipientIds: [Number(invitation.invited_by_id)],
    senderId: user.id,
    workspaceId: invitation.workspace_id,
    data: invitationNotificationData(invitation, workspace?.name || ""),
  });
  return true;
}

export async function getSamlProviderForEmail(db: D1Database, email?: string | null) {
  let rows;
  if (email) {
    const domain = String(email).split("@").pop()?.toLowerCase() || "";
    rows = await db.prepare("SELECT * FROM core_authprovider WHERE type='saml' AND enabled=1 AND lower(domain)=?").bind(domain).all<AuthProvider>();
  } else {
    rows = await db.prepare("SELECT * FROM core_authprovider WHERE type='saml' AND enabled=1 ORDER BY id ASC").all<AuthProvider>();
  }
  const providers = rows.results || [];
  return providers.length === 1 ? providers[0] : null;
}

export function buildSamlRedirectUrl(
  env: Env,
  requestUrl: string,
  provider: AuthProvider,
  data: LoginRequestData,
  options: { acsPath?: string; relayState?: string } = {},
) {
  const base = backendUrl(env, requestUrl);
  const metadata = metadataString(provider);
  const destination = singleSignOnUrl(metadata);
  if (!destination) return null;
  const id = `_${crypto.randomUUID().replace(/-/g, "")}`;
  const issueInstant = new Date().toISOString();
  const acsUrl = `${base}${options.acsPath || "/api/sso/saml/acs/"}`;
  const entityId = acsUrl;
  const requestXml =
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id}" Version="2.0" IssueInstant="${issueInstant}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${escapeXml(acsUrl)}">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${escapeXml(entityId)}</saml:Issuer>` +
    `</samlp:AuthnRequest>`;
  const url = new URL(destination);
  url.searchParams.set("SAMLRequest", b64(deflateSync(strToU8(requestXml), { level: 6 })));
  url.searchParams.set("RelayState", options.relayState || validFrontendRedirect(env, data.original, {
    workspace_invitation_token: data.workspace_invitation_token || "",
    language: data.language || "",
  }));
  return url.toString();
}

async function createOrGetExternalUser(env: Env, provider: AuthProvider, email: string, name: string, loginData: LoginRequestData = {}) {
  const normalizedEmail = email.toLowerCase();
  const invitation = await getWorkspaceInvitationByToken(env.DB, loginData.workspace_invitation_token);
  if (loginData.workspace_invitation_token && !invitation) throw new Error(SSO_ERRORS.authFlow);
  if (invitation && invitation.email.toLowerCase() !== normalizedEmail) throw new Error(SSO_ERRORS.invitationMismatch);

  const existing = await getUserByEmail(env.DB, normalizedEmail);
  if (existing) {
    if (!existing.is_active) throw new Error(SSO_ERRORS.deactivated);
    await assertUserBelongsToAuthProvider(env.DB, provider.id, existing.id);
    await acceptWorkspaceInvitationForSso(env, existing, invitation);
    await updateUserLastLogin(env.DB, existing.id);
    return existing;
  }

  if (!invitation) throw new Error(SSO_ERRORS.signupDisabled);
  try {
    await assertInvitedAccountCreationAllowed(env.DB, normalizedEmail, invitation.invited_by_id);
  } catch {
    throw new Error(SSO_ERRORS.signupDisabled);
  }

  const cleanName = name.trim() || normalizedEmail;
  const firstName = cleanName.split(/\s+/).slice(0, -1).join(" ") || cleanName.split(/\s+/)[0] || normalizedEmail;
  const userId = await createUser(env.DB, {
    email: normalizedEmail,
    username: normalizedEmail,
    first_name: firstName,
    password_hash: "!",
  });
  if (loginData.language) {
    await env.DB.prepare("UPDATE core_userprofile SET language=? WHERE user_id=?").bind(loginData.language, userId).run();
  }
  await recordAuthProviderUser(env.DB, provider.id, userId);
  if (invitation) {
    await acceptWorkspaceInvitationForSso(env, { id: userId, email: normalizedEmail }, invitation);
  } else {
    await createInitialWorkspace(env.DB, userId, firstName);
  }
  await updateUserLastLogin(env.DB, userId);
  const user = await getUserByEmail(env.DB, normalizedEmail);
  if (!user) throw new Error(SSO_ERRORS.authFlow);
  return user;
}

async function successRedirect(env: Env, userId: number, email: string, original?: string) {
  const normalized = email.toLowerCase();
  const refreshToken = await signRefreshToken(
    { user_id: userId, email: normalized, username: normalized },
    env.JWT_SIGNING_KEY,
    parseInt(env.JWT_REFRESH_TTL_DAYS || "7", 10)
  );
  const userSession = await signUserSession(
    { user_id: userId },
    refreshToken,
    env.JWT_SIGNING_KEY,
    parseInt(env.JWT_REFRESH_TTL_DAYS || "7", 10)
  );
  const url = new URL(validFrontendRedirect(env, original));
  url.searchParams.set("token", refreshToken);
  url.searchParams.set("user_session", userSession);
  return url.toString();
}

function oauthConfig(provider: AuthProvider) {
  const metadata = parseJsonObject(provider.metadata);
  if (provider.type === "gitlab") {
    const base = String(metadata.base_url || "").replace(/\/$/, "");
    return { authorize: `${base}/oauth/authorize`, token: `${base}/oauth/token`, userInfo: `${base}/api/v4/user`, scope: "read_user" };
  }
  if (provider.type === "openid_connect") {
    return {
      authorize: String(metadata.authorization_url || metadata.authorizationUrl || ""),
      token: String(metadata.access_token_url || metadata.accessTokenUrl || ""),
      userInfo: String(metadata.user_info_url || metadata.userInfoUrl || ""),
      scope: "openid email profile",
    };
  }
  return OAUTH_ENDPOINTS[provider.type];
}

async function stateKey(state: string) {
  return `sso:oauth2:${state}`;
}

sso.get("/saml/login-url/", async (c) => {
  const url = new URL(c.req.url);
  const email = url.searchParams.get("email");
  if (email && !isValidEmail(email)) {
    return c.json({
      error: "ERROR_QUERY_PARAMETER_VALIDATION",
      detail: { email: [{ code: "invalid", error: "Enter a valid email address." }] },
    }, 400);
  }
  const provider = await getSamlProviderForEmail(c.env.DB, email);
  if (!provider) {
    return c.json({ error: "ERROR_SAML_INVALID_LOGIN_REQUEST", detail: "No valid SAML identity provider found." }, 400);
  }
  const loginData = normalizeLoginQuery(url);
  const redirectUrl = new URL(`${backendUrl(c.env, c.req.url)}/api/sso/saml/login/`);
  if (email) redirectUrl.searchParams.set("email", email);
  for (const [key, value] of Object.entries(loginData)) {
    if (value) {
      redirectUrl.searchParams.set(key, value);
    }
  }
  return c.json({ redirect_url: redirectUrl.toString() });
});

sso.get("/saml/login/", async (c) => {
  const url = new URL(c.req.url);
  const provider = await getSamlProviderForEmail(c.env.DB, url.searchParams.get("email"));
  if (!provider) return redirect(errorRedirect(c.env, SSO_ERRORS.invalidSamlRequest));
  const redirectUrl = buildSamlRedirectUrl(c.env, c.req.url, provider, normalizeLoginQuery(url));
  return redirect(redirectUrl || errorRedirect(c.env, SSO_ERRORS.invalidSamlRequest));
});

sso.post("/saml/acs/", async (c) => {
  try {
    const body = await c.req.parseBody();
    const encoded = String(body.SAMLResponse || "");
    const relayState = String(body.RelayState || "");
    if (!encoded || !relayState) return redirect(errorRedirect(c.env, SSO_ERRORS.invalidSamlResponse));
    const xml = decodeSamlResponse(encoded);
    const issuer = samlIssuerFromResponse(xml);
    const rows = await c.env.DB.prepare("SELECT * FROM core_authprovider WHERE type='saml' AND enabled=1").all<AuthProvider>();
    const provider = (rows.results || []).find((item) => {
      try {
        return parseSamlMetadata(metadataString(item)).entityId === issuer;
      } catch {
        return false;
      }
    });
    if (!provider) return redirect(errorRedirect(c.env, SSO_ERRORS.invalidSamlResponse));
    const metadata = parseJsonObject(provider.metadata);
    const acsUrl = `${backendUrl(c.env, c.req.url)}/api/sso/saml/acs/`;
    const identity = await validateSamlResponse(encoded, metadataString(provider), acsUrl);
    const email = samlClaim(identity, [metadata.email_attr_key || "email", "email", "mail", "user.email"]) || identity.nameId;
    if (!email || !email.includes("@")) return redirect(errorRedirect(c.env, SSO_ERRORS.invalidSamlResponse));
    const first = samlClaim(identity, [metadata.first_name_attr_key || "first_name", "first_name", "givenName"]);
    const last = samlClaim(identity, [metadata.last_name_attr_key || "last_name", "last_name", "sn", "surname"]);
    const name = [first, last].filter(Boolean).join(" ") || email;
    const loginData = loginDataFromRelayState(c.env, relayState);
    const user = await createOrGetExternalUser(c.env, provider, email, name, loginData);
    await c.env.DB.prepare("UPDATE core_authprovider SET metadata=? WHERE id=?")
      .bind(JSON.stringify({ ...metadata, is_verified: true }), provider.id)
      .run();
    return redirect(await successRedirect(c.env, user.id, user.email, redirectFromRelayState(c.env, relayState)));
  } catch (error: any) {
    return redirect(errorRedirect(c.env, Object.values(SSO_ERRORS).includes(error?.message) ? error.message : SSO_ERRORS.invalidSamlResponse));
  }
});

sso.get("/oauth2/login/:providerId/", async (c) => {
  const provider = await enabledProviderById(c.env.DB, Number(c.req.param("providerId")));
  if (!provider) return redirect(errorRedirect(c.env, SSO_ERRORS.providerMissing));
  const metadata = parseJsonObject(provider.metadata);
  const config = oauthConfig(provider);
  if (!config?.authorize || !metadata.client_id) return redirect(errorRedirect(c.env, SSO_ERRORS.authFlow));
  const state = crypto.randomUUID();
  const query = normalizeLoginQuery(new URL(c.req.url));
  const codeVerifier = provider.type === "facebook" ? undefined : randomBase64Url(64);
  const oidcNonce = provider.type === "openid_connect" ? randomBase64Url(32) : undefined;
  await c.env.CACHE.put(await stateKey(state), JSON.stringify({
    provider_id: provider.id,
    ...query,
    code_verifier: codeVerifier,
    oidc_nonce: oidcNonce,
  }), { expirationTtl: 600 });
  const callback = `${backendUrl(c.env, c.req.url)}/api/sso/oauth2/callback/${provider.id}/`;
  const redirectUrl = new URL(config.authorize);
  redirectUrl.searchParams.set("client_id", String(metadata.client_id));
  redirectUrl.searchParams.set("redirect_uri", callback);
  redirectUrl.searchParams.set("response_type", "code");
  redirectUrl.searchParams.set("scope", config.scope);
  redirectUrl.searchParams.set("state", state);
  if (codeVerifier) {
    redirectUrl.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
    redirectUrl.searchParams.set("code_challenge_method", "S256");
  }
  if (oidcNonce) redirectUrl.searchParams.set("nonce", oidcNonce);
  return redirect(redirectUrl.toString());
});

export async function fetchOAuthUserInfo(env: Env, provider: AuthProvider, metadata: Record<string, any>, code: string, callback: string, requestData: OAuthRequestData) {
  const config = oauthConfig(provider);
  if (!config?.token || !config.userInfo) throw new Error(SSO_ERRORS.authFlow);
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callback,
    client_id: String(metadata.client_id || ""),
    client_secret: String(metadata.secret || ""),
  });
  if (requestData.code_verifier) tokenBody.set("code_verifier", requestData.code_verifier);
  const tokenResponse = await fetch(config.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: tokenBody,
  });
  if (!tokenResponse.ok) throw new Error(SSO_ERRORS.authFlow);
  const token = await tokenResponse.json<any>();
  const accessToken = token.access_token;
  if (!accessToken) throw new Error(SSO_ERRORS.authFlow);
  const userResponse = await fetch(config.userInfo, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  if (!userResponse.ok) throw new Error(SSO_ERRORS.authFlow);
  const info = await userResponse.json<any>();
  if (provider.type === "github" && !info.email) {
    const emailsResponse = await fetch("https://api.github.com/user/emails", { headers: { authorization: `token ${accessToken}`, accept: "application/json" } });
    if (emailsResponse.ok) {
      const emails = await emailsResponse.json<any[]>();
      const primary = emails.find((item) => item.primary) || emails[0];
      info.email = typeof primary === "string" ? primary : primary?.email;
    }
  }
  if (provider.type === "openid_connect" && metadata.use_id_token && token.id_token) {
    return oidcUserInfoFromPayload(await verifyOpenIdConnectIdToken(env, metadata, token.id_token, requestData.oidc_nonce), metadata);
  }
  if (provider.type === "openid_connect") {
    return oidcUserInfoFromPayload(info, metadata);
  }
  return {
    email: info[metadata.email_attr_key || "email"],
    name: info.name || [info[metadata.first_name_attr_key || "first_name"], info[metadata.last_name_attr_key || "last_name"]].filter(Boolean).join(" "),
  };
}

sso.get("/oauth2/callback/:providerId/", async (c) => {
  try {
    const providerId = Number(c.req.param("providerId"));
    const provider = await enabledProviderById(c.env.DB, providerId);
    if (!provider) return redirect(errorRedirect(c.env, SSO_ERRORS.providerMissing));
    const url = new URL(c.req.url);
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const stored = state ? await c.env.CACHE.get(await stateKey(state)) : null;
    if (!stored || !code) return redirect(errorRedirect(c.env, SSO_ERRORS.authFlow));
    const requestData = JSON.parse(stored) as OAuthRequestData;
    if (requestData.provider_id !== providerId) return redirect(errorRedirect(c.env, SSO_ERRORS.authFlow));
    await c.env.CACHE.delete(await stateKey(state));
    const metadata = parseJsonObject(provider.metadata);
    const callback = `${backendUrl(c.env, c.req.url)}/api/sso/oauth2/callback/${provider.id}/`;
    const userInfo = await fetchOAuthUserInfo(c.env, provider, metadata, code, callback, requestData);
    if (!userInfo.email) return redirect(errorRedirect(c.env, SSO_ERRORS.authFlow));
    const user = await createOrGetExternalUser(c.env, provider, userInfo.email, userInfo.name || userInfo.email, requestData);
    return redirect(await successRedirect(c.env, user.id, user.email, requestData.original));
  } catch (error: any) {
    return redirect(errorRedirect(c.env, Object.values(SSO_ERRORS).includes(error?.message) ? error.message : SSO_ERRORS.authFlow));
  }
});

export { sso as ssoRouter };
