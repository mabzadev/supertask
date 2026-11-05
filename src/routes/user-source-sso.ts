import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import {
  computedUserSourceUid,
  getOrCreateExternalUserSourceUser,
  resolveUserSourceByUid,
  userSourceAuthResponse,
} from "../services/application-extras";
import {
  decodeSamlResponse,
  parseSamlMetadata,
  samlClaim,
  samlIssuerFromResponse,
  validateSamlResponse,
} from "../services/saml";
import {
  buildSamlRedirectUrl,
  fetchOAuthUserInfo,
  type AuthProvider,
  type OAuthRequestData,
} from "./sso";

type JsonObject = Record<string, any>;

const userSourceSso = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function backendUrl(env: Env, requestUrl: string) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, "");
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}

function defaultFrontendUrl(env: Env) {
  return (env.PUBLIC_WEB_FRONTEND_URL || "https://task.mabza.dev").replace(/\/$/, "");
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

function providerRecord(provider: JsonObject): AuthProvider {
  return {
    id: Number(provider.id),
    type: String(provider.type),
    enabled: provider.enabled === false ? 0 : 1,
    domain: provider.domain ? String(provider.domain) : null,
    metadata: JSON.stringify(provider),
  };
}

function providers(userSource: any, type: string) {
  return parseJson<JsonObject[]>(userSource.auth_providers, []).filter(
    (provider) => provider.type === type && provider.enabled !== false
  );
}

async function allowedFrontendHosts(env: Env, userSource: any) {
  const hosts = new Set<string>();
  for (const value of [defaultFrontendUrl(env), "https://task.mabza.dev"]) {
    try { hosts.add(new URL(value).host); } catch { /* invalid configured URL */ }
  }
  const domains = await env.DB.prepare(
    `SELECT domain_name
     FROM builder_domain
     WHERE builder_id=? AND published=1
     UNION
     SELECT domain.domain_name
     FROM builder_domain domain
     WHERE domain.published_to_id=? AND domain.published=1`
  ).bind(userSource.application_id, userSource.application_id).all<{ domain_name: string }>();
  for (const domain of domains.results || []) hosts.add(domain.domain_name);
  return hosts;
}

async function safeOriginal(env: Env, userSource: any, raw: string | null | undefined) {
  const fallback = defaultFrontendUrl(env);
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return fallback;
    return (await allowedFrontendHosts(env, userSource)).has(url.host) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function withQuery(urlValue: string, key: string, value: string) {
  const url = new URL(urlValue);
  url.searchParams.set(key, value);
  return url.toString();
}

function randomBase64Url(size: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function storeSsoState(db: D1Database, kind: "saml" | "oidc", state: string, payload: JsonObject) {
  const now = new Date();
  await db.prepare("DELETE FROM core_user_source_sso_state WHERE expires_on<=?")
    .bind(now.toISOString())
    .run();
  await db.prepare(
    `INSERT INTO core_user_source_sso_state (state, kind, payload, expires_on, created_on)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(state, kind, JSON.stringify(payload), new Date(now.getTime() + 600_000).toISOString(), now.toISOString()).run();
}

async function consumeSsoState<T>(db: D1Database, kind: "saml" | "oidc", state: string): Promise<T | null> {
  const row = await db.prepare(
    `DELETE FROM core_user_source_sso_state
     WHERE state=? AND kind=? AND expires_on>?
     RETURNING payload`
  ).bind(state, kind, new Date().toISOString()).first<{ payload: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

async function successRedirect(env: Env, userSource: any, user: JsonObject, original: string, kind: "saml" | "oidc") {
  const tokens = await userSourceAuthResponse(env, userSource, user);
  return withQuery(original, `user_source_${kind}_token__${userSource.id}`, tokens.refresh_token);
}

userSourceSso.get("/:userSourceUid/sso/saml/login/", async (c) => {
  const userSource = await resolveUserSourceByUid(c.env.DB, decodeURIComponent(c.req.param("userSourceUid")));
  const configured = providers(userSource, "saml");
  const email = new URL(c.req.url).searchParams.get("email") || "";
  const domain = email.includes("@") ? email.split("@").pop()?.toLowerCase() : "";
  const provider = domain
    ? configured.find((item) => String(item.domain || "").toLowerCase() === domain)
    : configured.length === 1 ? configured[0] : null;
  const original = await safeOriginal(c.env, userSource, new URL(c.req.url).searchParams.get("original"));
  if (!provider) return redirect(withQuery(original, `saml_error__${userSource.id}`, "errorInvalidSamlRequest"));
  const mapped = providerRecord(provider);
  const state = crypto.randomUUID();
  await storeSsoState(c.env.DB, "saml", state, {
    user_source_id: Number(userSource.id),
    provider_id: Number(provider.id),
    original,
  });
  const relayState = new URL(original);
  relayState.searchParams.set("_baserow_saml_state", state);
  const loginUrl = buildSamlRedirectUrl(c.env, c.req.url, mapped, { original }, {
    acsPath: "/api/user-source/sso/saml/acs/",
    relayState: relayState.toString(),
  });
  return redirect(loginUrl || withQuery(original, `saml_error__${userSource.id}`, "errorInvalidSamlRequest"));
});

userSourceSso.post("/sso/saml/acs/", async (c) => {
  const body = await c.req.parseBody();
  const encoded = String(body.SAMLResponse || "");
  const relayState = String(body.RelayState || "");
  let fallback = defaultFrontendUrl(c.env);
  let matchedUserSource: any = null;
  try {
    if (!encoded || !relayState) throw new Error("invalid_saml");
    const issuer = samlIssuerFromResponse(decodeSamlResponse(encoded));
    let match: { userSource: any; provider: JsonObject } | null = null;
    const relayUrl = new URL(relayState);
    const state = relayUrl.searchParams.get("_baserow_saml_state") || "";
    relayUrl.searchParams.delete("_baserow_saml_state");
    if (state) {
      const requestData = await consumeSsoState<{ user_source_id: number; provider_id: number; original: string }>(
        c.env.DB,
        "saml",
        state,
      );
      if (!requestData) throw new Error("invalid_saml");
      const userSource = await c.env.DB.prepare(
        `SELECT us.*
         FROM core_usersource us
         JOIN core_application application ON application.id=us.application_id
         WHERE us.id=? AND application.trashed=0`
      ).bind(Number(requestData.user_source_id)).first<any>();
      const provider = userSource
        ? providers(userSource, "saml").find((candidate) => Number(candidate.id) === Number(requestData.provider_id))
        : null;
      if (
        !userSource ||
        !provider ||
        requestData.original !== relayUrl.toString() ||
        parseSamlMetadata(String(provider.metadata || "")).entityId !== issuer
      ) {
        throw new Error("invalid_saml");
      }
      match = { userSource, provider };
    } else {
      const rows = await c.env.DB.prepare(
        `SELECT us.*
         FROM core_usersource us
         JOIN core_application application ON application.id=us.application_id
         WHERE application.trashed=0`
      ).all<any>();
      for (const userSource of rows.results || []) {
        for (const provider of providers(userSource, "saml")) {
          try {
            if (parseSamlMetadata(String(provider.metadata || "")).entityId === issuer) {
              match = { userSource, provider };
              break;
            }
          } catch { /* invalid provider metadata is ignored */ }
        }
        if (match) break;
      }
    }
    if (!match) throw new Error("invalid_saml");
    matchedUserSource = match.userSource;
    fallback = await safeOriginal(c.env, match.userSource, relayUrl.toString());
    const identity = await validateSamlResponse(
      encoded,
      String(match.provider.metadata || ""),
      `${backendUrl(c.env, c.req.url)}/api/user-source/sso/saml/acs/`,
    );
    const email = samlClaim(identity, [match.provider.email_attr_key || "user.email", "email", "mail"]) || identity.nameId;
    const firstName = samlClaim(identity, [match.provider.first_name_attr_key || "user.first_name", "first_name", "givenName"]);
    const lastName = samlClaim(identity, [match.provider.last_name_attr_key || "user.last_name", "last_name", "sn"]);
    const user = await getOrCreateExternalUserSourceUser(c.env, match.userSource, email, [firstName, lastName].filter(Boolean).join(" ") || email);
    return redirect(await successRedirect(c.env, match.userSource, user, fallback, "saml"));
  } catch (error) {
    console.error(JSON.stringify({
      event: "user_source_saml_callback_failed",
      user_source_id: matchedUserSource ? Number(matchedUserSource.id) : null,
      error: error instanceof Error ? error.message : String(error),
    }));
    const key = matchedUserSource ? `saml_error__${matchedUserSource.id}` : "saml_error";
    return redirect(withQuery(fallback, key, "errorInvalidSamlResponse"));
  }
});

userSourceSso.get("/:userSourceUid/sso/oauth2/openid_connect/login/", async (c) => {
  const uid = decodeURIComponent(c.req.param("userSourceUid"));
  const userSource = await resolveUserSourceByUid(c.env.DB, uid);
  const url = new URL(c.req.url);
  const issuer = url.searchParams.get("iss") || "";
  const provider = providers(userSource, "openid_connect").find(
    (item) => String(item.base_url || "").replace(/\/$/, "") === issuer.replace(/\/$/, "")
  );
  const original = await safeOriginal(c.env, userSource, url.searchParams.get("original"));
  if (!provider?.authorization_url || !provider.client_id) {
    return redirect(withQuery(original, `oidc_error__${userSource.id}`, "errorProviderDoesNotExist"));
  }
  const state = crypto.randomUUID();
  const codeVerifier = randomBase64Url(64);
  const oidcNonce = randomBase64Url(32);
  const domainPrefix = uid.match(/^(domain_\d+__)/)?.[1] || "";
  const callbackUid = `${domainPrefix}${computedUserSourceUid(userSource)}`;
  const callback = `${backendUrl(c.env, c.req.url)}/api/user-source/${encodeURIComponent(callbackUid)}/sso/oauth2/openid_connect/callback/`;
  const requestData: OAuthRequestData & { user_source_id: number; provider_id: number; callback_uid: string } = {
    provider_id: Number(provider.id),
    user_source_id: Number(userSource.id),
    callback_uid: callbackUid,
    original,
    code_verifier: codeVerifier,
    oidc_nonce: oidcNonce,
  };
  await storeSsoState(c.env.DB, "oidc", state, requestData);
  const destination = new URL(String(provider.authorization_url));
  destination.searchParams.set("client_id", String(provider.client_id));
  destination.searchParams.set("redirect_uri", callback);
  destination.searchParams.set("response_type", "code");
  destination.searchParams.set("scope", "openid email profile");
  destination.searchParams.set("state", state);
  destination.searchParams.set("nonce", oidcNonce);
  destination.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
  destination.searchParams.set("code_challenge_method", "S256");
  return redirect(destination.toString());
});

userSourceSso.get("/:userSourceUid/sso/oauth2/openid_connect/callback/", async (c) => {
  const uid = decodeURIComponent(c.req.param("userSourceUid"));
  const url = new URL(c.req.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  let original = defaultFrontendUrl(c.env);
  let userSource: any = null;
  try {
    if (!state || !code) throw new Error("invalid_oidc");
    const requestData = await consumeSsoState<OAuthRequestData & { user_source_id: number; provider_id: number; callback_uid: string }>(
      c.env.DB,
      "oidc",
      state,
    );
    if (!requestData) throw new Error("invalid_oidc");
    userSource = await resolveUserSourceByUid(c.env.DB, uid);
    original = await safeOriginal(c.env, userSource, requestData.original);
    if (Number(userSource.id) !== Number(requestData.user_source_id) || requestData.callback_uid !== uid) throw new Error("invalid_oidc");
    const provider = providers(userSource, "openid_connect").find((item) => Number(item.id) === Number(requestData.provider_id));
    if (!provider) throw new Error("invalid_oidc");
    const callback = `${backendUrl(c.env, c.req.url)}/api/user-source/${encodeURIComponent(uid)}/sso/oauth2/openid_connect/callback/`;
    const info = await fetchOAuthUserInfo(c.env, providerRecord(provider), provider, code, callback, requestData);
    if (!info.email) throw new Error("invalid_oidc");
    const user = await getOrCreateExternalUserSourceUser(c.env, userSource, String(info.email), String(info.name || info.email));
    return redirect(await successRedirect(c.env, userSource, user, original, "oidc"));
  } catch {
    const key = userSource ? `oidc_error__${userSource.id}` : "oidc_error";
    return redirect(withQuery(original, key, "errorAuthFlowError"));
  }
});

export { userSourceSso as userSourceSsoRouter };
