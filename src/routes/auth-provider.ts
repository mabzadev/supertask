import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { ensurePasswordAuthProvider } from "../services/auth-providers";
const r = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const OAUTH_PROVIDER_TYPES = new Set(["google", "facebook", "github", "gitlab", "openid_connect"]);

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function baseUrl(publicUrl: string | undefined, requestUrl?: string): string {
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  if (requestUrl) {
    const parsed = new URL(requestUrl);
    return `${parsed.protocol}//${parsed.host}`;
  }
  return "https://supertask.mbza.workers.dev";
}

function authProviderRedirectUrl(publicUrl: string, provider: { id: number; type: string }): string {
  const base = baseUrl(publicUrl);
  if (provider.type === "saml") return `${base}/api/sso/saml/login/`;
  if (OAUTH_PROVIDER_TYPES.has(provider.type)) return `${base}/api/sso/oauth2/login/${provider.id}/`;
  return "";
}

function serializeLoginProvider(publicUrl: string, provider: any) {
  const metadata = parseJsonObject(provider.metadata);
  const type = String(provider.type);
  return {
    id: Number(provider.id),
    type,
    name: metadata.name || provider.domain || type,
    domain: provider.domain || "",
    redirect_url: String(metadata.redirect_url || metadata.redirectUrl || authProviderRedirectUrl(publicUrl, { id: Number(provider.id), type })),
    ...metadata,
  };
}

export async function buildLoginOptions(db: D1Database, publicUrl?: string, requestUrl?: string, frontendUrl?: string): Promise<Record<string, unknown>> {
  const settings = await db.prepare("SELECT allow_new_signups, allow_reset_password FROM core_settings WHERE id=1").first<any>();
  const passwordProvider = await ensurePasswordAuthProvider(db);
  const providers = await db.prepare("SELECT id, type, domain, metadata FROM core_authprovider WHERE enabled=1 ORDER BY domain ASC, id ASC").all<any>();
  const base = baseUrl(publicUrl, requestUrl);
  const options: Record<string, any> = {};
  if (passwordProvider.enabled) {
    options.password = {
      type: "password",
      allow_new_signups: settings ? Boolean(settings.allow_new_signups) : true,
      allow_reset_password: settings ? Boolean(settings.allow_reset_password) : true,
    };
  }
  const byType = new Map<string, any[]>();
  for (const provider of providers.results || []) {
    const type = String(provider.type);
    if (type === "password") continue;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(serializeLoginProvider(base, provider));
  }
  for (const [type, items] of byType) {
    if (type === "saml") {
      options[type] = {
        type,
        domain_required: items.length > 1,
        default_redirect_url: items.length === 1 ? items[0].redirect_url : `${baseUrl(frontendUrl || base)}/login/saml`,
      };
    } else {
      options[type] = {
        type,
        items: items.map(({ redirect_url, name, type: itemType }) => ({ redirect_url, name, type: itemType })),
        default_redirect_url: items.length === 1 ? items[0].redirect_url : null,
      };
    }
  }
  return options;
}

// Required by the frontend to render login/signup forms
r.get("/login-options/", async (c) => {
  return c.json(await buildLoginOptions(c.env.DB, c.env.PUBLIC_URL, c.req.url, c.env.PUBLIC_WEB_FRONTEND_URL));
});

r.get("/", async (c) => {
  const res = await c.env.DB.prepare("SELECT * FROM core_authprovider WHERE enabled=1").all<any>();
  return c.json(res.results || []);
});

export { r as authProviderRouter };
