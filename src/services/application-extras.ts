import { SignJWT, jwtVerify } from "jose";
import { compareSync } from "bcryptjs";
import type { Env } from "../types/env";
import { ApiError, DoesNotExist, PermissionError, ValidationError } from "../middleware/error";
import { ensureUserTableSystemColumns, serializeFieldValueForInsert, serializeRow, type FieldMeta } from "./dynamic-tables";
import { allocateAutonumberValues } from "./autonumber";
import { assertHasApplicationRole } from "./enterprise-permissions";
import { normalizeFieldValueForStorage } from "./field-values";
import { missingCreateFieldValues } from "./row-create-values";
import { finalizeRowWrite } from "./row-write-effects";
import { verifyPassword } from "./user";
import { normalizeGenerativeAISettings } from "./generative-ai";
import { parseSamlMetadata } from "./saml";

type JsonObject = Record<string, unknown>;

const INTEGRATION_COLUMNS = new Set(["type", "name"]);
const USER_SOURCE_COLUMNS = new Set(["type", "name", "integration_id", "auth_providers"]);
const USER_SOURCE_FIELD_TYPES = {
  email_field_id: new Set(["email", "text", "long_text"]),
  name_field_id: new Set(["email", "text", "long_text", "number", "uuid"]),
  role_field_id: new Set(["text", "single_select", "formula"]),
  password_field_id: new Set(["password"]),
} as const;
const OIDC_DISCOVERY_MAX_BYTES = 64 * 1024;
const OIDC_DISCOVERY_FIELDS = {
  authorization_endpoint: "authorization_url",
  token_endpoint: "access_token_url",
  userinfo_endpoint: "user_info_url",
  jwks_uri: "jwks_url",
  issuer: "issuer",
} as const;

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function splitKnownValues(body: JsonObject, known: Set<string>) {
  const direct: JsonObject = {};
  const extra: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (known.has(key)) direct[key] = value;
    else if (key !== "before_id") extra[key] = value;
  }
  return { direct, extra };
}

function orderValue(beforeId: unknown, beforeOrder: string | number | null | undefined, maxOrder: string | number | null | undefined) {
  if (beforeId !== null && beforeId !== undefined && beforeOrder !== null && beforeOrder !== undefined) {
    return String(Number(beforeOrder) - 1);
  }
  return String(Number(maxOrder || 0) + 10000);
}

export async function requireApplicationAccess(db: D1Database, userId: number | undefined, applicationId: number, requiredRole = "VIEWER") {
  const app = await db.prepare(
    `SELECT a.*
     FROM core_application a
     WHERE a.id = ? AND a.trashed = 0`
  ).bind(applicationId).first<any>();
  if (!app) throw new DoesNotExist("Application", applicationId);
  await assertHasApplicationRole(db, userId, applicationId, requiredRole);
  return app;
}

export async function requireIntegrationAccess(db: D1Database, userId: number | undefined, integrationId: number, requiredRole = "VIEWER") {
  const integration = await db.prepare(
    `SELECT i.*, a.workspace_id
     FROM core_integration i
     JOIN core_application a ON a.id = i.application_id
     WHERE i.id = ? AND a.trashed = 0`
  ).bind(integrationId).first<any>();
  if (!integration) throw new DoesNotExist("Integration", integrationId);
  await assertHasApplicationRole(db, userId, Number(integration.application_id), requiredRole);
  return integration;
}

export async function requireUserSourceAccess(db: D1Database, userId: number | undefined, userSourceId: number, requiredRole = "VIEWER") {
  const userSource = await db.prepare(
    `SELECT us.*, a.workspace_id
     FROM core_usersource us
     JOIN core_application a ON a.id = us.application_id
     WHERE us.id = ? AND a.trashed = 0`
  ).bind(userSourceId).first<any>();
  if (!userSource) throw new DoesNotExist("User source", userSourceId);
  await assertHasApplicationRole(db, userId, Number(userSource.application_id), requiredRole);
  return userSource;
}

export async function serializeIntegration(db: D1Database, row: any) {
  const configuration = parseJson<JsonObject>(row.configuration, {});
  return {
    ...configuration,
    id: row.id,
    application_id: row.application_id,
    type: row.type,
    name: row.name,
    order: row.order,
    context_data: await integrationContextData(db, row),
  };
}

export async function serializeUserSource(_db: D1Database, row: any) {
  return {
    ...parseJson<JsonObject>(row.configuration, {}),
    id: row.id,
    application_id: row.application_id,
    integration_id: row.integration_id,
    type: row.type,
    name: row.name,
    uid: row.uid,
    order: row.order,
    auth_providers: parseJson(row.auth_providers, []),
  };
}

function publicAuthProvider(provider: JsonObject): JsonObject {
  const base: JsonObject = {
    id: provider.id,
    type: provider.type,
    domain: provider.domain ?? null,
  };
  if (provider.type === "local_baserow_password") {
    // The current Baserow frontend uses this value as the configured marker.
    base.password_field_id = provider.password_field_id ?? null;
  } else if (provider.type === "openid_connect") {
    base.name = provider.name;
    base.base_url = provider.base_url;
  }
  return base;
}

export async function serializePublicUserSource(_db: D1Database, row: any) {
  const serialized = await serializeUserSource(_db, row);
  return {
    ...serialized,
    auth_providers: (serialized.auth_providers as JsonObject[]).map(publicAuthProvider),
  };
}

export async function listIntegrations(db: D1Database, applicationId: number) {
  const rows = await db.prepare("SELECT * FROM core_integration WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(applicationId)
    .all<any>();
  return Promise.all((rows.results || []).map((row) => serializeIntegration(db, row)));
}

export async function listUserSources(db: D1Database, applicationId: number, options: { public?: boolean } = {}) {
  const rows = await db.prepare("SELECT * FROM core_usersource WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(applicationId)
    .all<any>();
  const serializer = options.public ? serializePublicUserSource : serializeUserSource;
  return Promise.all((rows.results || []).map((row) => serializer(db, row)));
}

export async function createIntegration(db: D1Database, applicationId: number, body: JsonObject) {
  if (!body.type) throw new ValidationError("The integration type is required.");
  const before = body.before_id
    ? await db.prepare("SELECT [order] FROM core_integration WHERE id=? AND application_id=?").bind(Number(body.before_id), applicationId).first<any>()
    : null;
  const max = await db.prepare("SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM core_integration WHERE application_id=?")
    .bind(applicationId)
    .first<{ max_order: number }>();
  const { direct, extra } = splitKnownValues(body, INTEGRATION_COLUMNS);
  const configuration = normalizeIntegrationConfig(String(body.type), extra);
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO core_integration (application_id, type, name, [order], configuration, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    applicationId,
    String(body.type),
    String(direct.name || "Integration"),
    orderValue(body.before_id, before?.order, max?.max_order),
    JSON.stringify(configuration),
    now,
    now
  ).first<any>();
  if (!row) throw new Error("Failed to create integration");
  return serializeIntegration(db, row);
}

export async function updateIntegration(db: D1Database, integrationId: number, body: JsonObject) {
  const existing = await db.prepare("SELECT * FROM core_integration WHERE id=?").bind(integrationId).first<any>();
  if (!existing) throw new DoesNotExist("Integration", integrationId);
  const { direct, extra } = splitKnownValues(body, INTEGRATION_COLUMNS);
  const type = direct.type !== undefined ? String(direct.type) : String(existing.type);
  const configuration = normalizeIntegrationConfig(type, { ...parseJson<JsonObject>(existing.configuration, {}), ...extra });
  await db.prepare("UPDATE core_integration SET type=?, name=?, configuration=?, updated_on=? WHERE id=?")
    .bind(
      type,
      direct.name !== undefined ? String(direct.name) : existing.name,
      JSON.stringify(configuration),
      nowIso(),
      integrationId
    )
    .run();
  const updated = await db.prepare("SELECT * FROM core_integration WHERE id=?").bind(integrationId).first<any>();
  return serializeIntegration(db, updated);
}

function normalizeIntegrationConfig(type: string, config: JsonObject): JsonObject {
  if (type === "local_baserow") return config;
  if (type === "smtp") {
    const host = String(config.host || "").trim();
    const port = Number(config.port ?? 587);
    if (!host) throw new ValidationError("SMTP host is required.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("SMTP port must be between 1 and 65535.");
    return {
      ...config,
      host,
      port,
      use_tls: config.use_tls !== false,
      username: String(config.username || ""),
      password: String(config.password || ""),
    };
  }
  if (type === "ai") {
    const aiSettings = config.ai_settings;
    if (aiSettings !== undefined && (!aiSettings || typeof aiSettings !== "object" || Array.isArray(aiSettings))) {
      throw new ValidationError("AI settings must be an object.");
    }
    return { ...config, ai_settings: normalizeGenerativeAISettings(aiSettings || {}) };
  }
  throw new ValidationError(`Unsupported integration type: ${type}`);
}

export async function moveIntegration(db: D1Database, integrationId: number, beforeId: number | null) {
  const existing = await db.prepare("SELECT * FROM core_integration WHERE id=?").bind(integrationId).first<any>();
  if (!existing) throw new DoesNotExist("Integration", integrationId);
  const before = beforeId
    ? await db.prepare("SELECT [order] FROM core_integration WHERE id=? AND application_id=?").bind(beforeId, existing.application_id).first<any>()
    : null;
  const max = await db.prepare("SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM core_integration WHERE application_id=?")
    .bind(existing.application_id)
    .first<{ max_order: number }>();
  await db.prepare("UPDATE core_integration SET [order]=?, updated_on=? WHERE id=?")
    .bind(orderValue(beforeId, before?.order, max?.max_order), nowIso(), integrationId)
    .run();
}

function userSourceValidationError(field: string, detail: string, code: string): never {
  throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", {
    [field]: [{ detail, code }],
  });
}

function authProviderValidationError(
  index: number,
  providerCount: number,
  field: string,
  detail: string,
  code: string,
): never {
  const providers = Array.from({ length: providerCount }, () => ({} as JsonObject));
  providers[index] = { [field]: [{ detail, error: detail, code }] };
  throw new ApiError(400, "ERROR_REQUEST_BODY_VALIDATION", {
    auth_providers: providers,
  });
}

function requiredProviderString(
  provider: JsonObject,
  field: string,
  index: number,
  providerCount: number,
) {
  const value = String(provider[field] ?? "").trim();
  if (!value) {
    authProviderValidationError(index, providerCount, field, "This field may not be blank.", "blank");
  }
  return value;
}

function normalizedHttpUrl(
  value: unknown,
  index: number,
  providerCount: number,
  field = "base_url",
) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("invalid_url");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    authProviderValidationError(
      index,
      providerCount,
      field,
      "The specified URL doesn't point to a valid provider of the provider type.",
      "invalid_url",
    );
  }
}

function normalizedSamlDomain(value: unknown, index: number, providerCount: number) {
  const domain = requiredProviderString({ domain: value }, "domain", index, providerCount).toLowerCase();
  if (
    domain.length > 253 ||
    !domain.includes(".") ||
    !domain.split(".").every((label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    authProviderValidationError(
      index,
      providerCount,
      "domain",
      "The domain value is not a valid domain name.",
      "invalid",
    );
  }
  return domain;
}

async function readOidcDiscovery(response: Response) {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > OIDC_DISCOVERY_MAX_BYTES || !response.body) throw new Error("invalid_discovery");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OIDC_DISCOVERY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("invalid_discovery");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_discovery");
  return parsed as JsonObject;
}

async function discoverOidcProvider(baseUrl: string, index: number, providerCount: number) {
  try {
    const response = await fetch(`${baseUrl}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("invalid_discovery");
    const payload = await readOidcDiscovery(response);
    const discovered: JsonObject = {};
    for (const [source, target] of Object.entries(OIDC_DISCOVERY_FIELDS)) {
      const value = typeof payload[source] === "string" ? String(payload[source]).trim() : "";
      if (!value) throw new Error("invalid_discovery");
      discovered[target] = target === "issuer"
        ? value
        : normalizedHttpUrl(value, index, providerCount, "base_url");
    }
    return discovered;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    authProviderValidationError(
      index,
      providerCount,
      "base_url",
      "The specified URL doesn't point to a valid provider of the provider type.",
      "invalid_url",
    );
  }
}

function hasOidcEndpoints(provider: JsonObject) {
  return ["authorization_url", "access_token_url", "user_info_url", "jwks_url", "issuer"]
    .every((field) => typeof provider[field] === "string" && String(provider[field]).trim().length > 0);
}

function normalizeUserSourceName(value: unknown) {
  const name = String(value ?? "").trim();
  if (!name) userSourceValidationError("name", "This field may not be blank.", "blank");
  if (name.length > 255) {
    userSourceValidationError(
      "name",
      "Ensure this field has no more than 255 characters.",
      "max_length",
    );
  }
  return name;
}

async function normalizeUserSourceValues(
  db: D1Database,
  applicationId: number,
  type: string,
  rawIntegrationId: unknown,
  configuration: JsonObject,
  rawAuthProviders: unknown,
  previousAuthProviders: JsonObject[] = [],
) {
  if (type !== "local_baserow") throw new ValidationError(`Unsupported user source type: ${type}`);

  const application = await db.prepare("SELECT workspace_id FROM core_application WHERE id=? AND trashed=0")
    .bind(applicationId)
    .first<{ workspace_id: number }>();
  if (!application) throw new DoesNotExist("Application", applicationId);

  let integrationId: number | null = null;
  if (rawIntegrationId !== null && rawIntegrationId !== undefined && rawIntegrationId !== "") {
    integrationId = Number(rawIntegrationId);
    if (!Number.isInteger(integrationId)) {
      userSourceValidationError("integration_id", "A valid integer is required.", "invalid");
    }
    const integration = await db.prepare(
      "SELECT application_id, type FROM core_integration WHERE id=?"
    ).bind(integrationId).first<{ application_id: number; type: string }>();
    if (!integration || Number(integration.application_id) !== applicationId || integration.type !== "local_baserow") {
      userSourceValidationError(
        "integration_id",
        "The provided integration is not compatible with this user source.",
        "invalid_integration",
      );
    }
  }

  const normalizedConfiguration: JsonObject = { ...configuration };
  let tableId: number | null = null;
  const rawTableId = normalizedConfiguration.table_id;
  if (rawTableId !== null && rawTableId !== undefined && rawTableId !== "") {
    tableId = Number(rawTableId);
    const table = Number.isInteger(tableId)
      ? await db.prepare(
        `SELECT t.id, database.workspace_id
         FROM database_table t
         JOIN core_application database ON database.id=t.database_id
         WHERE t.id=? AND t.trashed=0 AND database.trashed=0`
      ).bind(tableId).first<{ id: number; workspace_id: number }>()
      : null;
    if (!table) {
      userSourceValidationError(
        "table_id",
        `The table with ID ${String(rawTableId)} doesn't exist`,
        "invalid_table",
      );
    }
    if (!integrationId || Number(table.workspace_id) !== Number(application.workspace_id)) {
      userSourceValidationError(
        "table_id",
        `The table with ID ${table.id} is not related to the given workspace.`,
        "invalid_table",
      );
    }
    normalizedConfiguration.table_id = tableId;
  } else {
    normalizedConfiguration.table_id = null;
  }

  for (const fieldName of ["email_field_id", "name_field_id", "role_field_id"] as const) {
    const rawFieldId = normalizedConfiguration[fieldName];
    if (rawFieldId === null || rawFieldId === undefined || rawFieldId === "") {
      if (rawFieldId !== undefined) normalizedConfiguration[fieldName] = null;
      continue;
    }
    if (!tableId) {
      userSourceValidationError(
        fieldName,
        "Please select a table before selecting this field.",
        "missing_table",
      );
    }
    const fieldId = Number(rawFieldId);
    const field = Number.isInteger(fieldId)
      ? await db.prepare(
        "SELECT table_id, type FROM database_field WHERE id=? AND trashed=0"
      ).bind(fieldId).first<{ table_id: number; type: string }>()
      : null;
    if (!field) {
      userSourceValidationError(fieldName, "The provided Id doesn't exist.", "invalid_field");
    }
    if (Number(field.table_id) !== tableId) {
      userSourceValidationError(
        fieldName,
        `The field with ID ${fieldId} is not related to the given table.`,
        "invalid_field",
      );
    }
    if (!USER_SOURCE_FIELD_TYPES[fieldName].has(field.type as never)) {
      const label = fieldName === "email_field_id" ? "email" : fieldName === "name_field_id" ? "name" : "a role";
      userSourceValidationError(
        fieldName,
        `This field type can't be used as ${label}.`,
        "invalid_field",
      );
    }
    normalizedConfiguration[fieldName] = fieldId;
  }

  if (!Array.isArray(rawAuthProviders)) {
    userSourceValidationError("auth_providers", "Expected a list of items.", "not_a_list");
  }
  const localPasswordProviders = rawAuthProviders.filter(
    (provider) => provider && typeof provider === "object" && (provider as JsonObject).type === "local_baserow_password"
  );
  if (localPasswordProviders.length > 1) {
    userSourceValidationError(
      "auth_providers",
      "Only one local Baserow password provider can be configured.",
      "duplicate_provider",
    );
  }

  const authProviders: JsonObject[] = [];
  const providerIds = new Set<number>();
  const samlDomains = new Set<string>();
  const oidcBaseUrls = new Set<string>();
  for (let index = 0; index < rawAuthProviders.length; index += 1) {
    const rawProvider = rawAuthProviders[index];
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) {
      userSourceValidationError("auth_providers", "Expected a dictionary of items.", "invalid");
    }
    const provider = { ...(rawProvider as JsonObject) };
    const providerType = String(provider.type || "");
    if (!["local_baserow_password", "saml", "openid_connect"].includes(providerType)) {
      userSourceValidationError(
        "auth_providers",
        `The app auth provider type ${providerType || "undefined"} is not registered.`,
        "invalid_choice",
      );
    }
    const providerId = Number.isInteger(Number(provider.id)) ? Number(provider.id) : index + 1;
    if (providerIds.has(providerId)) {
      authProviderValidationError(
        index,
        rawAuthProviders.length,
        "id",
        "Each authentication provider must have a unique id.",
        "unique",
      );
    }
    providerIds.add(providerId);
    const previousProvider = previousAuthProviders.find((candidate) =>
      Number(candidate.id) === providerId && String(candidate.type) === providerType
    );

    if (providerType === "local_baserow_password") {
      const rawPasswordFieldId = provider.password_field_id;
      let passwordFieldId: number | null = null;
      if (rawPasswordFieldId !== null && rawPasswordFieldId !== undefined && rawPasswordFieldId !== "") {
        if (!tableId) {
          authProviderValidationError(
            index,
            rawAuthProviders.length,
            "password_field_id",
            "Please select a table before selecting this field.",
            "missing_table",
          );
        }
        passwordFieldId = Number(rawPasswordFieldId);
        const passwordField = Number.isInteger(passwordFieldId)
          ? await db.prepare(
            "SELECT table_id, type FROM database_field WHERE id=? AND trashed=0"
          ).bind(passwordFieldId).first<{ table_id: number; type: string }>()
          : null;
        if (
          !passwordField ||
          Number(passwordField.table_id) !== tableId ||
          !USER_SOURCE_FIELD_TYPES.password_field_id.has(passwordField.type as never)
        ) {
          authProviderValidationError(
            index,
            rawAuthProviders.length,
            "password_field_id",
            passwordField && Number(passwordField.table_id) !== tableId
              ? `The field with ID ${passwordFieldId} is not related to the given table.`
              : passwordField
                ? "This field type can't be used as password."
                : "The provided Id doesn't exist.",
            "invalid_field",
          );
        }
      }
      authProviders.push({
        id: providerId,
        type: providerType,
        domain: null,
        password_field_id: passwordFieldId,
      });
      continue;
    }

    if (providerType === "saml") {
      const domain = normalizedSamlDomain(provider.domain, index, rawAuthProviders.length);
      if (samlDomains.has(domain)) {
        authProviderValidationError(
          index,
          rawAuthProviders.length,
          "domain",
          "There is already a provider for this domain.",
          "duplicate_domain",
        );
      }
      samlDomains.add(domain);
      const metadata = requiredProviderString(provider, "metadata", index, rawAuthProviders.length);
      try {
        parseSamlMetadata(metadata);
      } catch {
        authProviderValidationError(
          index,
          rawAuthProviders.length,
          "metadata",
          "The metadata is not valid according to the XML schema.",
          "invalid",
        );
      }
      authProviders.push({
        id: providerId,
        type: providerType,
        domain,
        metadata,
        is_verified: Boolean(previousProvider?.is_verified),
        email_attr_key: String(provider.email_attr_key || "user.email").trim(),
        first_name_attr_key: String(provider.first_name_attr_key || "user.first_name").trim(),
        last_name_attr_key: String(provider.last_name_attr_key ?? "user.last_name").trim(),
      });
      continue;
    }

    const baseUrl = normalizedHttpUrl(
      requiredProviderString(provider, "base_url", index, rawAuthProviders.length),
      index,
      rawAuthProviders.length,
    );
    if (oidcBaseUrls.has(baseUrl)) {
      authProviderValidationError(
        index,
        rawAuthProviders.length,
        "base_url",
        "You cannot have two OIDC providers with the same base_url, please choose a unique URL for each OIDC provider.",
        "duplicate_url",
      );
    }
    oidcBaseUrls.add(baseUrl);
    const normalizedOidc: JsonObject = {
      id: providerId,
      type: providerType,
      domain: null,
      name: requiredProviderString(provider, "name", index, rawAuthProviders.length),
      base_url: baseUrl,
      client_id: requiredProviderString(provider, "client_id", index, rawAuthProviders.length),
      secret: requiredProviderString(provider, "secret", index, rawAuthProviders.length),
      use_id_token: Boolean(provider.use_id_token),
      email_attr_key: String(provider.email_attr_key || "email").trim(),
      first_name_attr_key: String(provider.first_name_attr_key || "name").trim(),
      last_name_attr_key: String(provider.last_name_attr_key ?? "").trim(),
    };
    const baseUrlChanged = !previousProvider || String(previousProvider.base_url || "").replace(/\/$/, "") !== baseUrl;
    if (!baseUrlChanged && hasOidcEndpoints(previousProvider)) {
      for (const field of ["authorization_url", "access_token_url", "user_info_url", "jwks_url", "issuer"]) {
        normalizedOidc[field] = previousProvider[field];
      }
    } else {
      Object.assign(normalizedOidc, await discoverOidcProvider(baseUrl, index, rawAuthProviders.length));
    }
    authProviders.push(normalizedOidc);
  }

  return { integrationId, configuration: normalizedConfiguration, authProviders };
}

function userSourceRuntimeConfig(userSource: any): JsonObject {
  const configuration = parseJson<JsonObject>(userSource.configuration, {});
  const authProviders = parseJson<JsonObject[]>(userSource.auth_providers, []);
  const passwordProvider = authProviders.find((provider) =>
    ["local_baserow_password", "password"].includes(String(provider.type || ""))
  );
  return {
    ...configuration,
    password_field_id: passwordProvider?.password_field_id ?? configuration.password_field_id ?? null,
  };
}

export function computedUserSourceUid(userSource: any) {
  const config = parseJson<JsonObject>(userSource.configuration, {});
  return `${userSource.id}_${Number(config.table_id || 0)}_${Number(config.email_field_id || 0)}_${Number(config.role_field_id || 0)}`;
}

export async function resolveUserSourceByUid(db: D1Database, uid: string) {
  const direct = await db.prepare(
    `SELECT us.*
     FROM core_usersource us
     JOIN core_application application ON application.id=us.application_id
     WHERE us.uid=? AND application.trashed=0`
  ).bind(uid).first<any>();
  if (direct) return direct;

  let applicationId: number | null = null;
  let candidateUid = uid;
  const published = uid.match(/^domain_(\d+)__(.+)$/);
  if (published) {
    const domain = await db.prepare(
      "SELECT published_to_id FROM builder_domain WHERE id=? AND published=1"
    ).bind(Number(published[1])).first<{ published_to_id: number | null }>();
    if (!domain?.published_to_id) throw new DoesNotExist("User source", uid);
    applicationId = Number(domain.published_to_id);
    candidateUid = published[2];
  }

  const rows = applicationId
    ? await db.prepare("SELECT * FROM core_usersource WHERE application_id=?").bind(applicationId).all<any>()
    : await db.prepare(
      `SELECT us.*
       FROM core_usersource us
       JOIN core_application application ON application.id=us.application_id
       WHERE application.trashed=0`
    ).all<any>();
  const match = (rows.results || []).find((row) =>
    row.uid === candidateUid || computedUserSourceUid(row) === candidateUid
  );
  if (!match) throw new DoesNotExist("User source", uid);
  return match;
}

export async function getOrCreateExternalUserSourceUser(
  env: Env,
  userSource: any,
  emailValue: string,
  nameValue: string,
) {
  const email = emailValue.trim().toLowerCase();
  if (!email) throw new ValidationError("The identity provider did not return an email address.");
  const users = await listUsersForSource(env.DB, userSource, "");
  const existing = users.find((candidate) => String(candidate.email || "").toLowerCase() === email);
  if (existing) return existing;

  const config = userSourceRuntimeConfig(userSource);
  const tableId = Number(config.table_id || 0);
  const emailFieldId = Number(config.email_field_id || 0);
  const nameFieldId = Number(config.name_field_id || 0);
  if (!tableId || !emailFieldId || !nameFieldId) {
    throw new ValidationError("The user source is not configured.");
  }
  const fields = await activeFields(env.DB, tableId);
  const emailField = fields.find((field) => field.id === emailFieldId);
  const nameField = fields.find((field) => field.id === nameFieldId);
  if (!emailField || !nameField) throw new ValidationError("The user source fields do not exist.");

  await ensureUserTableSystemColumns(env.DB, tableId);
  const now = nowIso();
  const values: Record<string, unknown> = {
    [`field_${nameFieldId}`]: serializeFieldValueForInsert(
      nameField.type,
      await normalizeFieldValueForStorage(env.DB, nameField, nameValue || email),
    ),
    // Baserow applies the email after the name, so email wins if both use one field.
    [`field_${emailFieldId}`]: serializeFieldValueForInsert(
      emailField.type,
      await normalizeFieldValueForStorage(env.DB, emailField, email),
    ),
  };
  const existingFieldIds = new Set([emailFieldId, nameFieldId]);
  for (const [fieldId, value] of await missingCreateFieldValues(env.DB, fields, existingFieldIds, { now, user: null })) {
    values[`field_${fieldId}`] = value;
  }
  for (const [fieldId, value] of await allocateAutonumberValues(env.DB, tableId)) {
    values[`field_${fieldId}`] = serializeFieldValueForInsert("autonumber", value);
  }
  const columns = Object.keys(values);
  const maxOrder = await env.DB.prepare(
    `SELECT COALESCE(MAX([order]), 0) AS max_order FROM "database_table_${tableId}"`
  ).first<{ max_order: number }>();
  const inserted = await env.DB.prepare(
    `INSERT INTO "database_table_${tableId}"
     (${columns.map((column) => `"${column}"`).join(", ")}, [order], _created_on, _updated_on, _created_by_id, _last_modified_by_id)
     VALUES (${columns.map(() => "?").join(", ")}, ?, ?, ?, NULL, NULL)
     RETURNING id`
  ).bind(...Object.values(values), Number(maxOrder?.max_order || 0) + 1, now, now).first<{ id: number }>();
  if (!inserted) throw new Error("Failed to create the user source user.");
  await finalizeRowWrite(env.DB, tableId, inserted.id, null, new Set([emailFieldId, nameFieldId]), null, env);
  const refreshed = await listUsersForSource(env.DB, userSource, "");
  const created = refreshed.find((candidate) => Number(candidate.id) === Number(inserted.id));
  if (!created) throw new Error("Failed to read the created user source user.");
  return created;
}

export async function createUserSource(db: D1Database, applicationId: number, body: JsonObject) {
  if (!body.type) throw new ValidationError("The user source type is required.");
  const type = String(body.type);
  if (type !== "local_baserow") throw new ValidationError(`Unsupported user source type: ${type}`);
  const before = body.before_id
    ? await db.prepare("SELECT [order] FROM core_usersource WHERE id=? AND application_id=?").bind(Number(body.before_id), applicationId).first<any>()
    : null;
  const max = await db.prepare("SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM core_usersource WHERE application_id=?")
    .bind(applicationId)
    .first<{ max_order: number }>();
  const { direct, extra } = splitKnownValues(body, USER_SOURCE_COLUMNS);
  const normalized = await normalizeUserSourceValues(
    db,
    applicationId,
    type,
    direct.integration_id ?? null,
    extra,
    direct.auth_providers ?? [],
  );
  const now = nowIso();
  const row = await db.prepare(
    `INSERT INTO core_usersource
     (application_id, integration_id, type, name, uid, [order], configuration, auth_providers, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    applicationId,
    normalized.integrationId,
    type,
    normalizeUserSourceName(direct.name),
    crypto.randomUUID(),
    orderValue(body.before_id, before?.order, max?.max_order),
    JSON.stringify(normalized.configuration),
    JSON.stringify(normalized.authProviders),
    now,
    now
  ).first<any>();
  if (!row) throw new Error("Failed to create user source");
  const uid = `__user_source_${row.id}`;
  await db.prepare("UPDATE core_usersource SET uid=? WHERE id=?").bind(uid, row.id).run();
  return serializeUserSource(db, { ...row, uid });
}

export async function updateUserSource(db: D1Database, userSourceId: number, body: JsonObject) {
  const existing = await db.prepare("SELECT * FROM core_usersource WHERE id=?").bind(userSourceId).first<any>();
  if (!existing) throw new DoesNotExist("User source", userSourceId);
  const { direct, extra } = splitKnownValues(body, USER_SOURCE_COLUMNS);
  if (direct.type !== undefined && String(direct.type) !== String(existing.type)) {
    throw new ValidationError("The user source type cannot be changed.");
  }
  const previousConfiguration = parseJson<JsonObject>(existing.configuration, {});
  const configuration = { ...previousConfiguration, ...extra };
  const integrationId = direct.integration_id !== undefined ? direct.integration_id : existing.integration_id;
  const tableChanged =
    Object.prototype.hasOwnProperty.call(extra, "table_id") &&
    Number(extra.table_id || 0) !== Number(previousConfiguration.table_id || 0);
  if (
    tableChanged
  ) {
    for (const fieldName of ["email_field_id", "name_field_id", "role_field_id"]) {
      if (!Object.prototype.hasOwnProperty.call(extra, fieldName)) configuration[fieldName] = null;
    }
  }
  let authProviders = direct.auth_providers !== undefined
    ? direct.auth_providers
    : parseJson<JsonObject[]>(existing.auth_providers, []);
  if (tableChanged && direct.auth_providers === undefined && Array.isArray(authProviders)) {
    authProviders = authProviders.map((provider) =>
      provider.type === "local_baserow_password"
        ? { ...provider, password_field_id: null }
        : provider
    );
  }
  const normalized = await normalizeUserSourceValues(
    db,
    Number(existing.application_id),
    String(existing.type),
    integrationId,
    configuration,
    authProviders,
    parseJson<JsonObject[]>(existing.auth_providers, []),
  );
  await db.prepare(
    `UPDATE core_usersource SET integration_id=?, type=?, name=?, configuration=?, auth_providers=?, updated_on=? WHERE id=?`
  ).bind(
    normalized.integrationId,
    existing.type,
    direct.name !== undefined ? normalizeUserSourceName(direct.name) : existing.name,
    JSON.stringify(normalized.configuration),
    JSON.stringify(normalized.authProviders),
    nowIso(),
    userSourceId
  ).run();
  const updated = await db.prepare("SELECT * FROM core_usersource WHERE id=?").bind(userSourceId).first<any>();
  return serializeUserSource(db, updated);
}

export async function moveUserSource(db: D1Database, userSourceId: number, beforeId: number | null) {
  const existing = await db.prepare("SELECT * FROM core_usersource WHERE id=?").bind(userSourceId).first<any>();
  if (!existing) throw new DoesNotExist("User source", userSourceId);
  const before = beforeId
    ? await db.prepare("SELECT [order] FROM core_usersource WHERE id=? AND application_id=?").bind(beforeId, existing.application_id).first<any>()
    : null;
  const max = await db.prepare("SELECT COALESCE(MAX(CAST([order] AS REAL)), 0) AS max_order FROM core_usersource WHERE application_id=?")
    .bind(existing.application_id)
    .first<{ max_order: number }>();
  await db.prepare("UPDATE core_usersource SET [order]=?, updated_on=? WHERE id=?")
    .bind(orderValue(beforeId, before?.order, max?.max_order), nowIso(), userSourceId)
    .run();
}

export async function userSourceRoles(db: D1Database, applicationId: number) {
  const userSources = await db.prepare("SELECT * FROM core_usersource WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(applicationId)
    .all<any>();
  return Promise.all((userSources.results || []).map(async (userSource: any) => {
    const users = await listUsersForSource(db, userSource, "");
    return {
      user_source_id: userSource.id,
      uid: userSource.uid,
      roles: Array.from(new Set([`__user_source_${userSource.id}`, ...users.map((user) => user.role || "")])),
    };
  }));
}

export async function listUsersPerSource(db: D1Database, applicationId: number, search = "") {
  const userSources = await db.prepare("SELECT * FROM core_usersource WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(applicationId)
    .all<any>();
  const entries = await Promise.all((userSources.results || []).map(async (userSource: any) => [
    String(userSource.id),
    await listUsersForSource(db, userSource, search),
  ]));
  return { users_per_user_sources: Object.fromEntries(entries) };
}

export async function userSourceAuthResponse(env: Env, userSource: any, user: JsonObject) {
  const payload = {
    user_id: Number(user.id),
    email: String(user.email || ""),
    username: String(user.username || user.email || user.id),
    role: String(user.role || ""),
    user_source_id: Number(userSource.id),
    user_source_uid: String(userSource.uid),
    application_id: Number(userSource.application_id),
  };
  return {
    access_token: await signUserSourceToken(payload, env.JWT_SIGNING_KEY, "access", Number(env.JWT_ACCESS_TTL_MINUTES || "10")),
    refresh_token: await signUserSourceToken(payload, env.JWT_SIGNING_KEY, "refresh", Number(env.JWT_REFRESH_TTL_DAYS || "7")),
  };
}

export async function authenticateUserSource(env: Env, userSource: any, credentials: JsonObject) {
  const users = await listUsersForSource(env.DB, userSource, "");
  const login = String(credentials.email || credentials.username || "").toLowerCase();
  const password = String(credentials.password || "");
  const user = users.find((candidate) =>
    [candidate.email, candidate.username].map((value) => String(value || "").toLowerCase()).includes(login)
  );
  if (!user) throw new PermissionError("Invalid user source credentials.");
  const config = userSourceRuntimeConfig(userSource);
  const storedPassword = String((user as any)._password || "");
  if (config.password_field_id || storedPassword) {
    if (!(await passwordMatches(password, storedPassword))) throw new PermissionError("Invalid user source credentials.");
  } else {
    throw new ValidationError("The user source has no password field configured.");
  }
  return userSourceAuthResponse(env, userSource, user);
}

export async function refreshUserSourceAuth(env: Env, refreshToken: string) {
  if (await env.CACHE.get(`user-source-blacklist:${refreshToken.slice(-16)}`)) {
    throw new PermissionError("Refresh token has been invalidated.");
  }
  const payload = await verifyUserSourceToken(refreshToken, env.JWT_SIGNING_KEY);
  if (payload.token_type !== "user_source_refresh") throw new PermissionError("Invalid token type.");
  const userSource = await env.DB.prepare("SELECT * FROM core_usersource WHERE id=?").bind(payload.user_source_id).first<any>();
  if (!userSource) throw new DoesNotExist("User source", payload.user_source_id);
  const users = await listUsersForSource(env.DB, userSource, "");
  const user = users.find((candidate) => Number(candidate.id) === Number(payload.user_id));
  if (!user) throw new PermissionError("The user source user no longer exists.");
  return userSourceAuthResponse(env, userSource, user);
}

export async function blacklistUserSourceToken(env: Env, refreshToken: string) {
  const payload = await verifyUserSourceToken(refreshToken, env.JWT_SIGNING_KEY);
  if (payload.token_type !== "user_source_refresh") throw new PermissionError("Invalid token type.");
  await env.CACHE.put(`user-source-blacklist:${refreshToken.slice(-16)}`, "1", { expirationTtl: 60 * 60 * 24 * 30 });
}

async function integrationContextData(db: D1Database, integration: any) {
  if (integration.type !== "local_baserow") return {};
  const app = await db.prepare("SELECT workspace_id FROM core_application WHERE id=?").bind(integration.application_id).first<any>();
  if (!app) return { databases: [] };
  const databases = await db.prepare(
    `SELECT id, name
     FROM core_application
     WHERE workspace_id=? AND type='database' AND trashed=0
     ORDER BY [order] ASC`
  ).bind(app.workspace_id).all<any>();
  return {
    databases: await Promise.all((databases.results || []).map(async (database: any) => {
      const tables = await db.prepare(
        `SELECT t.id, t.name, t.database_id, t.data_sync_id, ds.two_way_sync
         FROM database_table t
         LEFT JOIN database_datasync ds ON ds.id = t.data_sync_id
         WHERE t.database_id=? AND t.trashed=0
         ORDER BY t.[order] ASC`
      ).bind(database.id).all<any>();
      const tableIds = (tables.results || []).map((table: any) => table.id);
      const views = tableIds.length > 0
        ? await db.prepare(
          `SELECT id, table_id, name, type
           FROM database_view
           WHERE table_id IN (${tableIds.map(() => "?").join(",")}) AND trashed=0
           ORDER BY [order] ASC`
        ).bind(...tableIds).all<any>()
        : { results: [] };
      return {
        id: database.id,
        name: database.name,
        tables: (tables.results || []).map((table: any) => ({
          id: table.id,
          name: table.name,
          database_id: table.database_id,
          is_data_sync: Boolean(table.data_sync_id),
          is_two_way_data_sync: Boolean(table.two_way_sync),
        })),
        views: views.results || [],
      };
    })),
  };
}

async function listUsersForSource(db: D1Database, userSource: any, search: string) {
  const config = userSourceRuntimeConfig(userSource);
  const configuredUsers = Array.isArray(config.users) ? config.users as JsonObject[] : null;
  if (configuredUsers) {
    return configuredUsers
      .map((user, index) => normalizeUser(userSource, { ...user, id: user.id || index + 1 }, config))
      .filter((user) => matchesSearch(user, search));
  }
  const tableId = Number(config.table_id);
  if (!tableId) return [];
  const fields = await activeFields(db, tableId);
  await ensureUserTableSystemColumns(db, tableId);
  const rows = await db.prepare(`SELECT * FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC LIMIT 1000`).all<Record<string, unknown>>();
  return (rows.results || [])
    .map((row) => normalizeUser(userSource, rowToNamedValues(row, fields), config))
    .filter((user) => matchesSearch(user, search));
}

async function activeFields(db: D1Database, tableId: number): Promise<FieldMeta[]> {
  const result = await db.prepare(
    `SELECT id, name, type, "primary" AS is_primary
     FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY [order] ASC`
  ).bind(tableId).all<any>();
  return (result.results || []).map((field: any) => ({
    id: field.id,
    name: field.name,
    type: field.type,
    primary: Boolean(field.is_primary),
  }));
}

function rowToNamedValues(row: Record<string, unknown>, fields: FieldMeta[]) {
  const serialized = serializeRow(row, fields) as JsonObject;
  const named: JsonObject = {};
  for (const field of fields) {
    const value = field.type === "password" ? row[`field_${field.id}`] : serialized[`field_${field.id}`];
    named[`field_${field.id}`] = value;
    named[field.name] = value;
  }
  // A user field can be named "id"; the system row id must remain authoritative.
  named.id = serialized.id;
  return named;
}

function normalizeUser(userSource: any, source: JsonObject, config: JsonObject) {
  const id = Number(source.id);
  const email = String(valueByField(source, config.email_field_id, ["email", "Email"]) || "");
  const username = String(valueByField(source, config.name_field_id, ["username", "Username", "name", "Name"]) || email || id);
  const roleValue = valueByField(source, config.role_field_id, ["role", "Role"]);
  const role = String(
    roleValue && typeof roleValue === "object" && !Array.isArray(roleValue)
      ? (roleValue as JsonObject).value || ""
      : roleValue || `__user_source_${userSource.id}`
  );
  const password = valueByField(source, config.password_field_id, ["password", "Password"]);
  return {
    id,
    user_source_id: userSource.id,
    user_source_uid: userSource.uid,
    email,
    username,
    role,
    _password: password,
  };
}

function valueByField(source: JsonObject, fieldId: unknown, fallbacks: string[]) {
  if (fieldId) return source[`field_${fieldId}`];
  for (const key of fallbacks) {
    if (source[key] !== undefined) return source[key];
  }
  return null;
}

function matchesSearch(user: JsonObject, search: string) {
  if (!search.trim()) return true;
  const needle = search.toLowerCase();
  return [user.email, user.username, user.role].some((value) => String(value || "").toLowerCase().includes(needle));
}

async function passwordMatches(password: string, storedPassword: string) {
  if (!storedPassword) return false;
  if (storedPassword.startsWith("$2a$") || storedPassword.startsWith("$2b$") || storedPassword.startsWith("$2y$")) {
    return compareSync(password, storedPassword);
  }
  if (await verifyPassword(password, storedPassword).catch(() => false)) return true;
  return password === storedPassword;
}

async function signUserSourceToken(payload: JsonObject, signingKey: string, type: "access" | "refresh", ttl: number) {
  const secret = new TextEncoder().encode(signingKey);
  return new SignJWT({ ...payload, token_type: `user_source_${type}` })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(type === "access" ? `${ttl}m` : `${ttl}d`)
    .sign(secret);
}

async function verifyUserSourceToken(token: string, signingKey: string) {
  try {
    const secret = new TextEncoder().encode(signingKey);
    const { payload } = await jwtVerify(token, secret);
    return payload as JsonObject & { token_type: string; user_source_id: number; user_id: number };
  } catch {
    throw new PermissionError("Invalid user source token.");
  }
}
