import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { ApiError, DoesNotExist, ValidationError } from "../middleware/error";
import { recordTrashEntry } from "../services/trash";
import { broadcastToWorkspace } from "../durable-objects/workspace-room";
import {
  assertHasApplicationRole,
  assertHasFieldRole,
  assertHasTableRole,
  assertHasViewRole,
  assertHasWorkspaceRole,
  canWriteFieldValue,
} from "../services/enterprise-permissions";
import { logAuditEntry } from "../services/audit-log";
import { ensurePasswordAuthProvider } from "../services/auth-providers";
import { parseSamlMetadata } from "../services/saml";
import { associatedSubjectUserIds, broadcastPermissionsUpdated } from "../services/enterprise-realtime";

const enterprise = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const role = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const fieldPermissions = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const ROLE_UIDS = new Set(["ADMIN", "BUILDER", "EDITOR", "COMMENTER", "VIEWER", "NO_ACCESS", "NO_ROLE_LOW_PRIORITY", "NO_ROLE", "NOBODY"]);
const AUTH_PROVIDER_TYPES = new Set(["password", "saml", "google", "facebook", "github", "gitlab", "openid_connect"]);
const OAUTH_PROVIDER_TYPES = new Set(["google", "facebook", "github", "gitlab", "openid_connect"]);
const OIDC_WELL_KNOWN_FIELDS = {
  authorization_endpoint: "authorization_url",
  token_endpoint: "access_token_url",
  userinfo_endpoint: "user_info_url",
  jwks_uri: "jwks_url",
  issuer: "issuer",
} as const;
const SORT_ERROR_DETAILS = {
  ERROR_INVALID_SORT_DIRECTION: "Attributes to sort by must be prefixed with one of '-' or '+'.",
  ERROR_INVALID_SORT_ATTRIBUTE: "Invalid attribute name provided to sort by.",
} as const;

function nowIso() {
  return new Date().toISOString();
}

function normalizeRoleUid(value: unknown) {
  const raw = String(value || "VIEWER").trim();
  const uid = raw === raw.toUpperCase()
    ? raw
    : raw.includes("_")
      ? raw.toUpperCase()
      : raw.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase().replace(/^_/, "");
  if (uid === "NO_ROLE") return "NO_ROLE_LOW_PRIORITY";
  if (!ROLE_UIDS.has(uid)) {
    throw new ApiError(404, "ERROR_ROLE_DOES_NOT_EXIST", `The role ${raw} does not exist.`);
  }
  return uid;
}

function normalizeFieldPermissionRole(value: unknown) {
  const uid = normalizeRoleUid(value || "EDITOR");
  if (!["ADMIN", "BUILDER", "EDITOR", "NOBODY"].includes(uid)) {
    throw new ValidationError(`Field permission role ${uid} is not supported.`);
  }
  return uid;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base", numeric: true });
}

function invalidSortResponse(error: keyof typeof SORT_ERROR_DETAILS) {
  return { error, detail: SORT_ERROR_DETAILS[error] };
}

function parseTeamSorts(value: string | undefined): { sorts?: Array<{ key: "id" | "name" | "default_role" | "subject_sample"; direction: 1 | -1 }>; error?: keyof typeof SORT_ERROR_DETAILS } {
  if (value === undefined) return { sorts: [{ key: "id", direction: 1 }] };
  const sortMapping = new Set(["name", "default_role", "subject_sample"]);
  const seen = new Set<string>();
  const sorts: Array<{ key: "id" | "name" | "default_role" | "subject_sample"; direction: 1 | -1 }> = [];
  for (const raw of value.split(",")) {
    if (raw.length <= 2) return { error: "ERROR_INVALID_SORT_ATTRIBUTE" };
    const prefix = raw[0];
    if (prefix !== "+" && prefix !== "-") return { error: "ERROR_INVALID_SORT_DIRECTION" };
    const key = raw.slice(1);
    if (!sortMapping.has(key) || seen.has(key)) return { error: "ERROR_INVALID_SORT_ATTRIBUTE" };
    seen.add(key);
    sorts.push({ key: key as "name" | "default_role" | "subject_sample", direction: prefix === "+" ? 1 : -1 });
  }
  return { sorts };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requestBodyValidation(detail: Record<string, Array<{ error: string; code: string }>>) {
  return { error: "ERROR_REQUEST_BODY_VALIDATION", detail };
}

function invalidProviderUrlResponse() {
  return {
    error: "ERROR_INVALID_PROVIDER_URL",
    detail: {
      code: "invalid_url",
      error: "The specified URL doesn't point to a valid provider of the provider type.",
    },
  };
}

function cannotDisableLastAuthProviderResponse() {
  return {
    error: "ERROR_CANNOT_DISABLE_ALL_AUTH_PROVIDERS",
    detail: "The last enabled provider cannot be disabled.",
  };
}

function normalizeHttpUrl(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid url");
  return parsed.toString().replace(/\/$/, "");
}

function hasOpenIdConnectEndpoints(metadata: Record<string, unknown>) {
  return ["authorization_url", "access_token_url", "user_info_url", "jwks_url", "issuer"].every((field) => {
    const value = metadata[field];
    return typeof value === "string" && value.trim().length > 0;
  });
}

async function discoverOpenIdConnectMetadata(baseUrl: string) {
  const normalizedBaseUrl = normalizeHttpUrl(baseUrl);
  const wellKnownUrl = `${normalizedBaseUrl}/.well-known/openid-configuration`;
  const response = await fetch(wellKnownUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("invalid provider url");
  const payload = await response.json<Record<string, unknown>>();
  const discovered: Record<string, unknown> = {};
  for (const [source, target] of Object.entries(OIDC_WELL_KNOWN_FIELDS)) {
    const value = payload[source];
    if (typeof value !== "string" || value.trim() === "") throw new Error("invalid provider url");
    discovered[target] = target === "issuer" ? value.trim() : normalizeHttpUrl(value);
  }
  return discovered;
}

async function normalizeAuthProviderMetadata(type: string, metadata: Record<string, unknown>, baseUrlChanged = false) {
  if (type !== "openid_connect") return metadata;
  const baseUrl = normalizeHttpUrl(metadata.base_url);
  const normalized: Record<string, unknown> = {
    ...metadata,
    base_url: baseUrl,
    use_id_token: Boolean(metadata.use_id_token),
    email_attr_key: String(metadata.email_attr_key || "email"),
    first_name_attr_key: String(metadata.first_name_attr_key || "name"),
    last_name_attr_key: String(metadata.last_name_attr_key ?? ""),
  };
  if (baseUrlChanged || !hasOpenIdConnectEndpoints(normalized)) {
    Object.assign(normalized, await discoverOpenIdConnectMetadata(baseUrl));
  }
  return normalized;
}

async function workspaceName(db: D1Database, workspaceId: number) {
  const row = await db.prepare("SELECT name FROM core_workspace WHERE id=?").bind(workspaceId).first<{ name: string }>();
  return row?.name || "";
}

async function fieldPermissionAuditContext(db: D1Database, fieldId: number) {
  return db.prepare(
    `SELECT f.id AS field_id, f.name AS field_name, t.id AS table_id, t.name AS table_name,
            a.id AS application_id, a.workspace_id, w.name AS workspace_name
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspace w ON w.id=a.workspace_id
      WHERE f.id=?`
  ).bind(fieldId).first<any>();
}

function isValidDomain(domain: string): boolean {
  return /^(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/.test(domain);
}

function requiredAuthProviderFields(type: string): string[] {
  if (type === "saml") return ["domain", "metadata"];
  if (type === "gitlab" || type === "openid_connect") return ["name", "client_id", "secret", "base_url"];
  if (OAUTH_PROVIDER_TYPES.has(type)) return ["name", "client_id", "secret"];
  return [];
}

export function validateAuthProviderPayload(type: string, body: Record<string, unknown>, partial = false) {
  if (!AUTH_PROVIDER_TYPES.has(type)) {
    return { type: [{ error: "The auth provider type is not supported.", code: "invalid" }] };
  }
  const detail: Record<string, Array<{ error: string; code: string }>> = {};
  for (const field of requiredAuthProviderFields(type)) {
    if (!partial && (body[field] === undefined || body[field] === null || String(body[field]).trim() === "")) {
      detail[field] = [{ error: "This field is required.", code: "required" }];
    }
  }
  if (body.domain !== undefined && String(body.domain || "").trim() && !isValidDomain(String(body.domain))) {
    detail.domain = [{ error: "The domain value is not a valid domain name.", code: "invalid" }];
  }
  if (body.metadata !== undefined && type === "saml") {
    const metadata = String(body.metadata || "").trim();
    try {
      parseSamlMetadata(metadata);
    } catch {
      detail.metadata = [{ error: "The metadata is not valid according to the XML schema.", code: "invalid" }];
    }
  }
  if (body.base_url !== undefined && String(body.base_url || "").trim()) {
    try {
      const parsed = new URL(String(body.base_url));
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      detail.base_url = [{ error: "Enter a valid URL.", code: "invalid" }];
    }
  }
  return Object.keys(detail).length > 0 ? detail : null;
}

async function authProviderDomainExists(db: D1Database, type: string, domain: string, ignoreId?: number): Promise<boolean> {
  if (type !== "saml" || !domain) return false;
  const row = ignoreId
    ? await db.prepare("SELECT id FROM core_authprovider WHERE type=? AND domain=? AND id!=? LIMIT 1").bind(type, domain, ignoreId).first<{ id: number }>()
    : await db.prepare("SELECT id FROM core_authprovider WHERE type=? AND domain=? LIMIT 1").bind(type, domain).first<{ id: number }>();
  return Boolean(row);
}

async function enabledAuthProviderCountExcluding(db: D1Database, ignoredProviderId?: number): Promise<number> {
  await ensurePasswordAuthProvider(db);
  const row = ignoredProviderId
    ? await db.prepare("SELECT COUNT(*) AS count FROM core_authprovider WHERE enabled=1 AND id!=?")
      .bind(ignoredProviderId)
      .first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM core_authprovider WHERE enabled=1")
      .first<{ count: number }>();
  return row?.count ?? 0;
}

async function ensureRole(db: D1Database, uid: string) {
  await db.prepare("INSERT OR IGNORE INTO enterprise_role (uid, description) VALUES (?, ?)").bind(uid, uid).run();
  const row = await db.prepare("SELECT id, uid FROM enterprise_role WHERE uid=?").bind(uid).first<{ id: number; uid: string }>();
  if (!row) throw new Error("Failed to ensure role.");
  return row;
}

function serializeTeam(team: any, subjects: any[] = []) {
  const subjectSample = subjects.slice(0, 10).map((subject) => ({
    subject_id: subject.subject_id,
    subject_type: subject.subject_type,
    subject_label: subject.name || subject.email || String(subject.subject_id),
    team_subject_id: subject.id,
  }));
  return {
    id: team.id,
    workspace: team.workspace_id,
    workspace_id: team.workspace_id,
    name: team.name,
    default_role: team.default_role_uid ?? null,
    default_role_uid: team.default_role_uid ?? null,
    created_on: team.created_on,
    updated_on: team.updated_on || team.created_on,
    trashed: Boolean(team.trashed),
    subject_count: subjects.length,
    subject_sample: subjectSample,
    subjects,
  };
}

async function listTeamSubjects(db: D1Database, teamId: number) {
  const rows = await db.prepare(
    `SELECT ts.id, ts.team_id, ts.subject_id, ts.subject_type,
            u.email, u.first_name, u.last_name, u.username
       FROM enterprise_teamsubject ts
       LEFT JOIN auth_user u ON u.id=ts.subject_id AND ts.subject_type='auth.User'
      WHERE ts.team_id=?
      ORDER BY ts.id ASC`
  ).bind(teamId).all<any>();
  return (rows.results || []).map((row) => ({
    id: row.id,
    team_id: row.team_id,
    team: row.team_id,
    subject_id: row.subject_id,
    subject_type: row.subject_type,
    name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || row.username || String(row.subject_id),
    email: row.email || "",
  }));
}

async function resolveTeamSubject(db: D1Database, data: Record<string, unknown>, workspaceId: number) {
  const subjectType = String(data.subject_type || "auth.User");
  if (subjectType !== "auth.User") {
    const subjectId = Number(data.subject_id || data.user_id || data.id);
    if (!subjectId) throw new ValidationError("subject_id is required.");
    return { subjectId, subjectType };
  }

  const email = String(data.subject_user_email || data.email || "").trim().toLowerCase();
  let subjectId = Number(data.subject_id || data.user_id || data.id);
  if (email) {
    const user = await db.prepare(
      `SELECT u.id
         FROM auth_user u
         JOIN core_workspaceuser wu ON wu.user_id=u.id AND wu.workspace_id=? AND wu.to_be_deleted=0
        WHERE lower(u.email)=?
        LIMIT 1`
    ).bind(workspaceId, email).first<{ id: number }>();
    if (!user) throw new DoesNotExist("Subject", email);
    subjectId = user.id;
  }

  if (!subjectId) throw new ValidationError("subject_id is required.");
  const member = await db.prepare(
    "SELECT id FROM core_workspaceuser WHERE workspace_id=? AND user_id=? AND to_be_deleted=0"
  ).bind(workspaceId, subjectId).first<{ id: number }>();
  if (!member) throw new ValidationError("Subject is not in the workspace.");
  return { subjectId, subjectType };
}

async function replaceTeamSubjects(db: D1Database, teamId: number, workspaceId: number, subjects: unknown): Promise<void> {
  if (!Array.isArray(subjects)) return;
  await db.prepare("DELETE FROM enterprise_teamsubject WHERE team_id=?").bind(teamId).run();
  const seen = new Set<string>();
  for (const subject of subjects) {
    const data = typeof subject === "object" && subject !== null ? subject as Record<string, unknown> : {};
    const { subjectId, subjectType } = await resolveTeamSubject(db, data, workspaceId);
    const key = `${subjectType}:${subjectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await db.prepare(
      "INSERT INTO enterprise_teamsubject (team_id, subject_id, subject_type) VALUES (?, ?, ?)"
    ).bind(teamId, subjectId, subjectType).run();
  }
}

async function setTeamDefaultRole(db: D1Database, teamId: number, workspaceId: number, roleUid: string | null) {
  await db.prepare(
    `DELETE FROM enterprise_roleassignment
      WHERE subject_id=? AND subject_type='baserow_enterprise.Team'
        AND scope_id=? AND scope_type='workspace'`
  ).bind(teamId, workspaceId).run();
  if (!roleUid) return;
  const roleRow = await ensureRole(db, roleUid);
  await db.prepare(
    `INSERT INTO enterprise_roleassignment (role_id, subject_id, subject_type, scope_id, scope_type)
     VALUES (?, ?, 'baserow_enterprise.Team', ?, 'workspace')`
  ).bind(roleRow.id, teamId, workspaceId).run();
}

enterprise.get("/workspace/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  await assertHasWorkspaceRole(c.env.DB, user.id, workspaceId, "VIEWER");
  const search = String(c.req.query("search") || "").trim().toLowerCase();
  const parsedSorts = parseTeamSorts(c.req.query("sorts"));
  if (parsedSorts.error) {
    return c.json(invalidSortResponse(parsedSorts.error), 400);
  }
  const teams = await c.env.DB.prepare(
    "SELECT * FROM enterprise_team WHERE workspace_id=? AND trashed=0 ORDER BY name ASC, id ASC"
  ).bind(workspaceId).all<any>();
  const results = [];
  for (const team of teams.results || []) {
    results.push(serializeTeam(team, await listTeamSubjects(c.env.DB, team.id)));
  }
  const filtered = search
    ? results.filter((team) => String(team.name || "").toLowerCase().includes(search))
    : results;
  const sortMapping: Record<string, (team: any) => unknown> = {
    name: (team) => team.name,
    default_role: (team) => team.default_role,
    subject_sample: (team) => team.subject_count,
    id: (team) => team.id,
  };
  filtered.sort((left, right) => {
    for (const sort of parsedSorts.sorts || []) {
      const direction = sort.direction;
      const key = sort.key;
      const getter = sortMapping[key];
      const result = compareValues(getter(left), getter(right));
      if (result !== 0) return result * direction;
    }
    return compareValues(left.id, right.id);
  });
  return c.json(filtered);
});

enterprise.post("/workspace/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  await assertHasWorkspaceRole(c.env.DB, user.id, workspaceId, "ADMIN");
  const body = await c.req.json<Record<string, unknown>>();
  const name = String(body.name || "").trim();
  if (!name) throw new ValidationError("Team name is required.");
  const roleUid = normalizeRoleUid(body.default_role_uid || body.default_role || body.role || "NO_ACCESS");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM enterprise_team WHERE workspace_id=? AND name=? AND trashed=0"
  ).bind(workspaceId, name).first();
  if (existing) {
    return c.json({ error: "ERROR_TEAM_NAME_NOT_UNIQUE", detail: "A team with this name already exists." }, 400);
  }
  const inserted = await c.env.DB.prepare(
    "INSERT INTO enterprise_team (workspace_id, name, default_role_uid, created_on, trashed) VALUES (?, ?, ?, ?, 0) RETURNING *"
  ).bind(workspaceId, name, roleUid, nowIso()).first<any>();
  await setTeamDefaultRole(c.env.DB, inserted.id, workspaceId, roleUid);
  await replaceTeamSubjects(c.env.DB, inserted.id, workspaceId, body.subjects);
  await broadcastPermissionsUpdated(
    c.env,
    workspaceId,
    await associatedSubjectUserIds(c.env.DB, inserted.id, "baserow_enterprise.Team"),
  );
  await logAuditEntry(c.env.DB, "enterprise.team.create", {
    user,
    workspace_id: workspaceId,
    workspace_name: await workspaceName(c.env.DB, workspaceId),
  }, { id: inserted.id, type: "team" }, {
    team_id: inserted.id,
    team_name: inserted.name,
    default_role_uid: roleUid,
  });
  return c.json(serializeTeam(inserted, await listTeamSubjects(c.env.DB, inserted.id)));
});

enterprise.put("/:teamId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const teamId = Number(c.req.param("teamId"));
  const team = await c.env.DB.prepare("SELECT * FROM enterprise_team WHERE id=? AND trashed=0").bind(teamId).first<any>();
  if (!team) throw new DoesNotExist("Team", teamId);
  await assertHasWorkspaceRole(c.env.DB, user.id, team.workspace_id, "ADMIN");
  const body = await c.req.json<Record<string, unknown>>();
  const name = body.name === undefined ? team.name : String(body.name || "").trim();
  if (!name) throw new ValidationError("Team name is required.");
  const roleUid = body.default_role_uid === undefined && body.default_role === undefined && body.role === undefined
    ? team.default_role_uid
    : normalizeRoleUid(body.default_role_uid || body.default_role || body.role);
  const duplicate = await c.env.DB.prepare(
    "SELECT id FROM enterprise_team WHERE workspace_id=? AND name=? AND trashed=0 AND id<>?"
  ).bind(team.workspace_id, name, teamId).first();
  if (duplicate) {
    return c.json({ error: "ERROR_TEAM_NAME_NOT_UNIQUE", detail: "A team with this name already exists." }, 400);
  }
  const affectedUserIds = new Set(await associatedSubjectUserIds(c.env.DB, teamId, "baserow_enterprise.Team"));
  await c.env.DB.prepare("UPDATE enterprise_team SET name=?, default_role_uid=? WHERE id=?").bind(name, roleUid, teamId).run();
  await setTeamDefaultRole(c.env.DB, teamId, team.workspace_id, roleUid);
  await replaceTeamSubjects(c.env.DB, teamId, team.workspace_id, body.subjects);
  for (const userId of await associatedSubjectUserIds(c.env.DB, teamId, "baserow_enterprise.Team")) affectedUserIds.add(userId);
  await broadcastPermissionsUpdated(c.env, team.workspace_id, affectedUserIds);
  const updated = await c.env.DB.prepare("SELECT * FROM enterprise_team WHERE id=?").bind(teamId).first<any>();
  await logAuditEntry(c.env.DB, "enterprise.team.update", {
    user,
    workspace_id: team.workspace_id,
    workspace_name: await workspaceName(c.env.DB, team.workspace_id),
  }, { id: teamId, type: "team" }, {
    team_id: teamId,
    team_name: updated?.name || name,
    before: { name: team.name, default_role_uid: team.default_role_uid },
    after: { name, default_role_uid: roleUid },
  });
  return c.json(serializeTeam(updated, await listTeamSubjects(c.env.DB, teamId)));
});

enterprise.get("/:teamId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const teamId = Number(c.req.param("teamId"));
  const team = await c.env.DB.prepare("SELECT * FROM enterprise_team WHERE id=? AND trashed=0")
    .bind(teamId)
    .first<any>();
  if (!team) throw new DoesNotExist("Team", teamId);
  await assertHasWorkspaceRole(c.env.DB, user.id, team.workspace_id, "VIEWER");
  return c.json(serializeTeam(team, await listTeamSubjects(c.env.DB, teamId)));
});

enterprise.delete("/:teamId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const teamId = Number(c.req.param("teamId"));
  const team = await c.env.DB.prepare("SELECT * FROM enterprise_team WHERE id=? AND trashed=0").bind(teamId).first<any>();
  if (!team) throw new DoesNotExist("Team", teamId);
  await assertHasWorkspaceRole(c.env.DB, user.id, team.workspace_id, "ADMIN");
  const affectedUserIds = await associatedSubjectUserIds(c.env.DB, teamId, "baserow_enterprise.Team");
  const trashedAt = nowIso();
  await c.env.DB.prepare("UPDATE enterprise_team SET trashed=1 WHERE id=?").bind(teamId).run();
  await recordTrashEntry(c.env.DB, {
    userId: user.id,
    workspaceId: team.workspace_id,
    applicationId: null,
    trashItemType: "team",
    trashItemId: team.id,
    name: team.name,
    trashedAt,
  });
  await logAuditEntry(c.env.DB, "enterprise.team.delete", {
    user,
    workspace_id: team.workspace_id,
    workspace_name: await workspaceName(c.env.DB, team.workspace_id),
  }, { id: team.id, type: "team" }, {
    team_id: team.id,
    team_name: team.name,
    default_role_uid: team.default_role_uid,
  });
  await broadcastPermissionsUpdated(c.env, team.workspace_id, affectedUserIds);
  return c.body(null, 204);
});

enterprise.get("/:teamId/subjects/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const teamId = Number(c.req.param("teamId"));
  const team = await c.env.DB.prepare("SELECT * FROM enterprise_team WHERE id=? AND trashed=0").bind(teamId).first<any>();
  if (!team) throw new DoesNotExist("Team", teamId);
  await assertHasWorkspaceRole(c.env.DB, user.id, team.workspace_id, "EDITOR");
  return c.json(await listTeamSubjects(c.env.DB, teamId));
});

enterprise.post("/:teamId/subjects/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const teamId = Number(c.req.param("teamId"));
  const team = await c.env.DB.prepare("SELECT * FROM enterprise_team WHERE id=? AND trashed=0").bind(teamId).first<any>();
  if (!team) throw new DoesNotExist("Team", teamId);
  await assertHasWorkspaceRole(c.env.DB, user.id, team.workspace_id, "ADMIN");
  const body = await c.req.json<Record<string, unknown>>();
  const { subjectId, subjectType } = await resolveTeamSubject(c.env.DB, body, team.workspace_id);
  const existing = await c.env.DB.prepare(
    "SELECT id FROM enterprise_teamsubject WHERE team_id=? AND subject_id=? AND subject_type=?"
  ).bind(teamId, subjectId, subjectType).first<{ id: number }>();
  if (existing) {
    return c.json((await listTeamSubjects(c.env.DB, teamId)).find((subject) => subject.id === existing.id));
  }
  await c.env.DB.prepare(
    "INSERT INTO enterprise_teamsubject (team_id, subject_id, subject_type) VALUES (?, ?, ?)"
  ).bind(teamId, subjectId, subjectType).run();
  await broadcastPermissionsUpdated(
    c.env,
    team.workspace_id,
    await associatedSubjectUserIds(c.env.DB, subjectId, subjectType),
  );
  await logAuditEntry(c.env.DB, "enterprise.team_subject.create", {
    user,
    workspace_id: team.workspace_id,
    workspace_name: await workspaceName(c.env.DB, team.workspace_id),
  }, { id: teamId, type: "team" }, {
    team_id: teamId,
    team_name: team.name,
    subject_id: subjectId,
    subject_type: subjectType,
  });
  return c.json((await listTeamSubjects(c.env.DB, teamId)).at(-1));
});

enterprise.get("/:teamId/subjects/:subjectId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const teamId = Number(c.req.param("teamId"));
  const subjectRowId = Number(c.req.param("subjectId"));
  const team = await c.env.DB.prepare("SELECT * FROM enterprise_team WHERE id=? AND trashed=0")
    .bind(teamId)
    .first<any>();
  if (!team) throw new DoesNotExist("Team", teamId);
  await assertHasWorkspaceRole(c.env.DB, user.id, team.workspace_id, "EDITOR");
  const subject = (await listTeamSubjects(c.env.DB, teamId)).find((item) => Number(item.id) === subjectRowId);
  if (!subject) throw new DoesNotExist("TeamSubject", subjectRowId);
  return c.json(subject);
});

enterprise.delete("/:teamId/subjects/:subjectId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const teamId = Number(c.req.param("teamId"));
  const subjectRowId = Number(c.req.param("subjectId"));
  const team = await c.env.DB.prepare("SELECT * FROM enterprise_team WHERE id=? AND trashed=0").bind(teamId).first<any>();
  if (!team) throw new DoesNotExist("Team", teamId);
  await assertHasWorkspaceRole(c.env.DB, user.id, team.workspace_id, "ADMIN");
  const subject = await c.env.DB.prepare(
    "SELECT subject_id, subject_type FROM enterprise_teamsubject WHERE id=? AND team_id=?"
  ).bind(subjectRowId, teamId).first<any>();
  await c.env.DB.prepare("DELETE FROM enterprise_teamsubject WHERE id=? AND team_id=?").bind(subjectRowId, teamId).run();
  await logAuditEntry(c.env.DB, "enterprise.team_subject.delete", {
    user,
    workspace_id: team.workspace_id,
    workspace_name: await workspaceName(c.env.DB, team.workspace_id),
  }, { id: teamId, type: "team" }, {
    team_id: teamId,
    team_name: team.name,
    subject_row_id: subjectRowId,
    subject_id: subject?.subject_id,
    subject_type: subject?.subject_type,
  });
  if (subject) {
    await broadcastPermissionsUpdated(
      c.env,
      team.workspace_id,
      await associatedSubjectUserIds(c.env.DB, Number(subject.subject_id), String(subject.subject_type)),
    );
  }
  return c.body(null, 204);
});

async function serializeRoleAssignment(db: D1Database, row: any) {
  let subject: Record<string, unknown> = { id: row.subject_id };
  if (row.subject_type === "auth.User") {
    const user = await db.prepare(
      "SELECT id, email, username, first_name, last_name FROM auth_user WHERE id=?"
    ).bind(row.subject_id).first<any>();
    if (user) {
      subject = {
        id: user.id,
        email: user.email || "",
        username: user.username || user.email || "",
        first_name: user.first_name || "",
      };
    }
  } else if (row.subject_type === "baserow_enterprise.Team") {
    const team = await db.prepare(
      "SELECT id, name, workspace_id, default_role_uid, created_on FROM enterprise_team WHERE id=?"
    ).bind(row.subject_id).first<any>();
    if (team) subject = serializeTeam(team, await listTeamSubjects(db, team.id));
  }
  return {
    id: row.id,
    subject,
    subject_id: row.subject_id,
    subject_type: row.subject_type,
    scope_id: row.scope_id,
    scope_type: row.scope_type,
    role: row.role_uid,
    role_uid: row.role_uid,
  };
}

type RoleScope = {
  id: number;
  type: "workspace" | "application" | "database_table" | "database_view" | "database_field";
};

function normalizeRoleScopeType(value: unknown): RoleScope["type"] {
  const raw = String(value || "workspace");
  const aliases: Record<string, RoleScope["type"]> = {
    workspace: "workspace",
    application: "application",
    database: "application",
    database_table: "database_table",
    table: "database_table",
    database_view: "database_view",
    view: "database_view",
    database_field: "database_field",
    field: "database_field",
  };
  const normalized = aliases[raw];
  if (!normalized) {
    throw new ApiError(404, "ERROR_OBJECT_SCOPE_TYPE_DOES_NOT_EXIST", `The object scope type ${raw} does not exist.`);
  }
  return normalized;
}

async function resolveRoleScope(db: D1Database, workspaceId: number, scopeId: number, value: unknown): Promise<RoleScope> {
  const type = normalizeRoleScopeType(value);
  let exists: unknown = null;
  if (type === "workspace") {
    exists = scopeId === workspaceId
      ? await db.prepare("SELECT id FROM core_workspace WHERE id=? AND trashed=0").bind(scopeId).first()
      : null;
  } else if (type === "application") {
    exists = await db.prepare("SELECT id FROM core_application WHERE id=? AND workspace_id=? AND trashed=0")
      .bind(scopeId, workspaceId).first();
  } else if (type === "database_table") {
    exists = await db.prepare(
      `SELECT t.id FROM database_table t
        JOIN core_application a ON a.id=t.database_id
       WHERE t.id=? AND t.trashed=0 AND a.workspace_id=? AND a.trashed=0`
    ).bind(scopeId, workspaceId).first();
  } else if (type === "database_view") {
    exists = await db.prepare(
      `SELECT v.id FROM database_view v
        JOIN database_table t ON t.id=v.table_id
        JOIN core_application a ON a.id=t.database_id
       WHERE v.id=? AND v.trashed=0 AND t.trashed=0 AND a.workspace_id=? AND a.trashed=0`
    ).bind(scopeId, workspaceId).first();
  } else {
    exists = await db.prepare(
      `SELECT f.id FROM database_field f
        JOIN database_table t ON t.id=f.table_id
        JOIN core_application a ON a.id=t.database_id
       WHERE f.id=? AND f.trashed=0 AND t.trashed=0 AND a.workspace_id=? AND a.trashed=0`
    ).bind(scopeId, workspaceId).first();
  }
  if (!exists) throw new ApiError(404, "ERROR_SCOPE_DOES_NOT_EXIST", `The scope ${scopeId} does not exist in this workspace.`);
  return { id: scopeId, type };
}

async function assertCanManageRoleScope(db: D1Database, userId: number, workspaceId: number, scope: RoleScope) {
  if (scope.type === "workspace") {
    await assertHasWorkspaceRole(db, userId, workspaceId, "ADMIN");
  } else if (scope.type === "application") {
    await assertHasApplicationRole(db, userId, scope.id, "ADMIN");
  } else if (scope.type === "database_table") {
    const table = await db.prepare(
      `SELECT t.id, t.database_id, a.workspace_id
         FROM database_table t JOIN core_application a ON a.id=t.database_id
        WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
    ).bind(scope.id).first<{ id: number; database_id: number; workspace_id: number }>();
    if (!table || table.workspace_id !== workspaceId) throw new DoesNotExist("Scope", scope.id);
    await assertHasTableRole(db, userId, table, "ADMIN");
  } else if (scope.type === "database_view") {
    await assertHasViewRole(db, userId, scope.id, "ADMIN");
  } else {
    await assertHasFieldRole(db, userId, scope.id, "ADMIN");
  }
}

async function validateRoleSubject(db: D1Database, workspaceId: number, subjectId: number, subjectType: string): Promise<void> {
  if (subjectType === "auth.User") {
    const member = await db.prepare(
      "SELECT id FROM core_workspaceuser WHERE workspace_id=? AND user_id=? AND to_be_deleted=0"
    ).bind(workspaceId, subjectId).first();
    if (!member) throw new ApiError(404, "ERROR_SUBJECT_DOES_NOT_EXIST", `The subject ${subjectId} does not exist in this workspace.`);
    return;
  }
  if (subjectType === "baserow_enterprise.Team") {
    const team = await db.prepare(
      "SELECT id FROM enterprise_team WHERE id=? AND workspace_id=? AND trashed=0"
    ).bind(subjectId, workspaceId).first();
    if (!team) throw new ApiError(404, "ERROR_SUBJECT_DOES_NOT_EXIST", `The subject ${subjectId} does not exist in this workspace.`);
    return;
  }
  throw new ApiError(404, "ERROR_SUBJECT_TYPE_DOES_NOT_EXIST", `The subject type ${subjectType} does not exist.`);
}

async function assertNotRemovingLastWorkspaceAdmin(
  db: D1Database,
  workspaceId: number,
  subjectId: number,
  subjectType: string,
  scopeType: string,
  roleUid: string | null,
): Promise<void> {
  if (subjectType !== "auth.User" || scopeType !== "workspace" || roleUid === "ADMIN") return;
  const current = await db.prepare(
    "SELECT permissions FROM core_workspaceuser WHERE workspace_id=? AND user_id=? AND to_be_deleted=0"
  ).bind(workspaceId, subjectId).first<{ permissions: string }>();
  if (normalizeRoleUid(current?.permissions || "NO_ACCESS") !== "ADMIN") return;
  const others = await db.prepare(
    "SELECT COUNT(*) AS total FROM core_workspaceuser WHERE workspace_id=? AND user_id<>? AND permissions='ADMIN' AND to_be_deleted=0"
  ).bind(workspaceId, subjectId).first<{ total: number }>();
  if (Number(others?.total || 0) === 0) {
    throw new ApiError(400, "ERROR_LAST_ADMIN_OF_GROUP", "The last workspace admin cannot be demoted or removed.");
  }
}

async function validateRoleAssignment(db: D1Database, workspaceId: number, body: Record<string, unknown>) {
  const subjectId = Number(body.subject_id);
  const scopeId = Number(body.scope_id);
  const subjectType = String(body.subject_type || "auth.User");
  if (!subjectId || !scopeId) throw new ValidationError("subject_id and scope_id are required.");
  const scope = await resolveRoleScope(db, workspaceId, scopeId, body.scope_type);
  await validateRoleSubject(db, workspaceId, subjectId, subjectType);
  const hasRole = body.role !== null && !(body.role === undefined && body.role_uid === undefined);
  const roleUid = hasRole ? normalizeRoleUid(body.role || body.role_uid) : null;
  await assertNotRemovingLastWorkspaceAdmin(db, workspaceId, subjectId, subjectType, scope.type, roleUid);
  return { subjectId, subjectType, scopeId, scopeType: scope.type, roleUid };
}

async function assignRole(db: D1Database, workspaceId: number, body: Record<string, unknown>) {
  const { subjectId, subjectType, scopeId, scopeType, roleUid } = await validateRoleAssignment(db, workspaceId, body);
  await db.prepare(
    "DELETE FROM enterprise_roleassignment WHERE subject_id=? AND subject_type=? AND scope_id=? AND scope_type=?"
  ).bind(subjectId, subjectType, scopeId, scopeType).run();
  if (subjectType === "auth.User" && scopeType === "workspace") {
    const workspaceUser = await db.prepare(
      "SELECT id FROM core_workspaceuser WHERE workspace_id=? AND user_id=? AND to_be_deleted=0"
    ).bind(scopeId, subjectId).first<{ id: number }>();
    if (!workspaceUser) throw new DoesNotExist("WorkspaceUser", subjectId);
    if (roleUid === null) {
      await db.prepare("UPDATE core_workspaceuser SET permissions=? WHERE id=?")
        .bind("NO_ACCESS", workspaceUser.id)
        .run();
      return null;
    }
    await db.prepare("UPDATE core_workspaceuser SET permissions=? WHERE id=?")
      .bind(roleUid, workspaceUser.id)
      .run();
    return { id: null, subject_id: subjectId, subject_type: subjectType, scope_id: scopeId, scope_type: scopeType, role: roleUid, role_uid: roleUid };
  }
  if (subjectType === "baserow_enterprise.Team" && scopeType === "workspace") {
    await db.prepare("UPDATE enterprise_team SET default_role_uid=? WHERE id=? AND workspace_id=?")
      .bind(roleUid, subjectId, workspaceId)
      .run();
  }
  if (roleUid === null) {
    return null;
  }
  const roleRow = await ensureRole(db, roleUid);
  const row = await db.prepare(
    `INSERT INTO enterprise_roleassignment (role_id, subject_id, subject_type, scope_id, scope_type)
     VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).bind(roleRow.id, subjectId, subjectType, scopeId, scopeType).first<{ id: number }>();
  return { id: row?.id, subject_id: subjectId, subject_type: subjectType, scope_id: scopeId, scope_type: scopeType, role: roleUid, role_uid: roleUid };
}

role.get("/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const scopeId = Number(c.req.query("scope_id") || workspaceId);
  const scope = await resolveRoleScope(c.env.DB, workspaceId, scopeId, c.req.query("scope_type") || "workspace");
  await assertCanManageRoleScope(c.env.DB, user.id, workspaceId, scope);
  if (scope.type === "workspace") {
    const members = await c.env.DB.prepare(
      `SELECT NULL AS id, wu.user_id AS subject_id, 'auth.User' AS subject_type,
              wu.workspace_id AS scope_id, 'workspace' AS scope_type,
              CASE WHEN wu.permissions='MEMBER' THEN 'BUILDER' ELSE wu.permissions END AS role_uid
         FROM core_workspaceuser wu
        WHERE wu.workspace_id=? AND wu.to_be_deleted=0
        ORDER BY wu.id ASC`
    ).bind(workspaceId).all<any>();
    const serialized = [];
    for (const row of members.results || []) serialized.push(await serializeRoleAssignment(c.env.DB, row));
    return c.json(serialized);
  }
  const rows = await c.env.DB.prepare(
    `SELECT ra.*, r.uid AS role_uid
       FROM enterprise_roleassignment ra
       JOIN enterprise_role r ON r.id=ra.role_id
      WHERE ra.scope_id=? AND ra.scope_type=?
      ORDER BY ra.id ASC`
  ).bind(scopeId, scope.type).all<any>();
  const serialized = [];
  for (const row of rows.results || []) serialized.push(await serializeRoleAssignment(c.env.DB, row));
  return c.json(serialized);
});

role.post("/:workspaceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const body = await c.req.json<Record<string, unknown>>();
  const scope = await resolveRoleScope(c.env.DB, workspaceId, Number(body.scope_id), body.scope_type);
  await assertCanManageRoleScope(c.env.DB, user.id, workspaceId, scope);
  const assigned = await assignRole(c.env.DB, workspaceId, body);
  await logAuditEntry(c.env.DB, assigned ? "enterprise.role_assignment.create" : "enterprise.role_assignment.delete", {
    user,
    workspace_id: workspaceId,
    workspace_name: await workspaceName(c.env.DB, workspaceId),
  }, { id: assigned?.id ? Number(assigned.id) : Number(body.scope_id), type: "role_assignment" }, {
    subject_id: Number(body.subject_id),
    subject_type: String(body.subject_type || "auth.User"),
    scope_id: Number(body.scope_id),
    scope_type: String(body.scope_type || "workspace"),
    role: assigned?.role_uid || null,
  });
  await broadcastPermissionsUpdated(
    c.env,
    workspaceId,
    await associatedSubjectUserIds(c.env.DB, Number(body.subject_id), String(body.subject_type || "auth.User")),
  );
  if (!assigned) return c.body(null, 204);
  return c.json(await serializeRoleAssignment(c.env.DB, assigned));
});

role.post("/:workspaceId/batch/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const body = await c.req.json<{ items?: Record<string, unknown>[] }>();
  const assignmentKeys = new Set<string>();
  for (const item of body.items || []) {
    const scope = await resolveRoleScope(c.env.DB, workspaceId, Number(item.scope_id), item.scope_type);
    await assertCanManageRoleScope(c.env.DB, user.id, workspaceId, scope);
    const validated = await validateRoleAssignment(c.env.DB, workspaceId, item);
    const key = `${validated.subjectType}:${validated.subjectId}:${validated.scopeType}:${validated.scopeId}`;
    if (assignmentKeys.has(key)) {
      return c.json({ error: "ERROR_DUPLICATE_ROLE_ASSIGNMENTS", detail: "The batch contains duplicate role assignments." }, 400);
    }
    assignmentKeys.add(key);
  }
  const items = [];
  const affectedUserIds = new Set<number>();
  for (const item of body.items || []) {
    const assigned = await assignRole(c.env.DB, workspaceId, item);
    await logAuditEntry(c.env.DB, assigned ? "enterprise.role_assignment.create" : "enterprise.role_assignment.delete", {
      user,
      workspace_id: workspaceId,
      workspace_name: await workspaceName(c.env.DB, workspaceId),
    }, { id: assigned?.id ? Number(assigned.id) : Number(item.scope_id), type: "role_assignment" }, {
      subject_id: Number(item.subject_id),
      subject_type: String(item.subject_type || "auth.User"),
      scope_id: Number(item.scope_id),
      scope_type: String(item.scope_type || "workspace"),
      role: assigned?.role_uid || null,
      batch: true,
    });
    items.push(assigned ? await serializeRoleAssignment(c.env.DB, assigned) : null);
    for (const userId of await associatedSubjectUserIds(
      c.env.DB,
      Number(item.subject_id),
      String(item.subject_type || "auth.User"),
    )) affectedUserIds.add(userId);
  }
  await broadcastPermissionsUpdated(c.env, workspaceId, affectedUserIds);
  return c.json(items);
});

fieldPermissions.get("/:fieldId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const fieldId = Number(c.req.param("fieldId"));
  await assertHasFieldRole(c.env.DB, user.id, fieldId, "BUILDER");
  const row = await c.env.DB.prepare(
    "SELECT field_id, role_uid, allow_write, allow_in_forms FROM enterprise_fieldpermission WHERE field_id=? ORDER BY id DESC LIMIT 1"
  ).bind(fieldId).first<any>();
  const canWrite = row ? Boolean(row.allow_write) : true;
  return c.json({
    field_id: fieldId,
    role: row?.role_uid || "EDITOR",
    allow_in_forms: row ? Boolean(row.allow_in_forms ?? 1) : true,
    allow_write: canWrite,
    can_write_values: canWrite,
  });
});

fieldPermissions.patch("/:fieldId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const fieldId = Number(c.req.param("fieldId"));
  const fieldScope = await assertHasFieldRole(c.env.DB, user.id, fieldId, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  const roleUid = normalizeFieldPermissionRole(body.role || "EDITOR");
  const allowInForms = roleUid === "EDITOR"
    ? true
    : body.allow_in_forms === undefined ? false : Boolean(body.allow_in_forms);
  const before = await c.env.DB.prepare(
    "SELECT field_id, role_uid, allow_write, allow_in_forms FROM enterprise_fieldpermission WHERE field_id=? ORDER BY id DESC LIMIT 1"
  ).bind(fieldId).first<any>();
  await c.env.DB.prepare("DELETE FROM enterprise_fieldpermission WHERE field_id=?").bind(fieldId).run();
  if (roleUid !== "EDITOR") {
    await c.env.DB.prepare(
      "INSERT INTO enterprise_fieldpermission (field_id, role_uid, allow_read, allow_write, allow_in_forms) VALUES (?, ?, 1, ?, ?)"
    ).bind(fieldId, roleUid, roleUid === "NOBODY" ? 0 : 1, allowInForms ? 1 : 0).run();
  }
  const canWrite = await canWriteFieldValue(c.env.DB, user.id, {
    id: fieldScope.table_id,
    database_id: fieldScope.database_id,
    workspace_id: fieldScope.workspace_id,
  }, fieldId);
  await broadcastToWorkspace(c.env, fieldScope.workspace_id, {
    type: "field_permissions_updated",
    field_id: fieldId,
    role: roleUid,
    allow_in_forms: allowInForms,
    can_write_values: canWrite,
  });
  const audit = await fieldPermissionAuditContext(c.env.DB, fieldId);
  await logAuditEntry(c.env.DB, "enterprise.field_permission.update", {
    user,
    workspace_id: fieldScope.workspace_id,
    workspace_name: audit?.workspace_name,
  }, { id: fieldId, type: "field_permission" }, {
    field_id: fieldId,
    field_name: audit?.field_name,
    table_id: audit?.table_id,
    table_name: audit?.table_name,
    before: before ? {
      role: before.role_uid,
      allow_in_forms: Boolean(before.allow_in_forms ?? 1),
      can_write_values: Boolean(before.allow_write),
    } : null,
    after: { role: roleUid, allow_in_forms: allowInForms, can_write_values: canWrite },
  });
  return c.json({ field_id: fieldId, role: roleUid, allow_in_forms: allowInForms, allow_write: canWrite, can_write_values: canWrite });
});

function authProviderTypes(publicUrl: string, frontendUrl?: string) {
  const base = publicUrl.replace(/\/$/, "");
  const frontend = (frontendUrl || publicUrl).replace(/\/$/, "");
  return ["password", "saml", "google", "facebook", "github", "gitlab", "openid_connect"].map((type) => {
    const item: Record<string, unknown> = {
      type,
      can_create_new: type !== "password",
      can_delete_existing: type !== "password",
      auth_providers: [],
    };
    if (type === "saml") {
      item.acs_url = `${base}/api/sso/saml/acs/`;
      item.relay_state_url = `${frontend}/dashboard`;
    }
    return item;
  });
}

function serializeAuthProvider(row: any) {
  const metadata = parseJsonObject(row.metadata);
  const serialized: Record<string, unknown> = {
    id: row.id,
    type: row.type,
    enabled: Boolean(row.enabled),
    domain: row.domain || "",
    name: metadata.name || row.domain || row.type,
    metadata: metadata.metadata ?? metadata,
    ...metadata,
  };
  serialized.is_verified = Boolean(metadata.is_verified);
  return serialized;
}

export async function listAdminAuthProviders(db: D1Database, publicUrl: string, frontendUrl?: string) {
  await ensurePasswordAuthProvider(db);
  const rows = await db.prepare("SELECT * FROM core_authprovider ORDER BY domain ASC, id ASC").all<any>();
  const providers = (rows.results || []).map(serializeAuthProvider);
  return {
    auth_provider_types: authProviderTypes(publicUrl, frontendUrl).map((type) => ({
      ...type,
      auth_providers: providers.filter((provider) => provider.type === type.type),
    })),
  };
}

export async function getNextAuthProviderId(db: D1Database) {
  const row = await db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM core_authprovider").first<{ id: number }>();
  return row?.id || 1;
}

export function installAdminAuthProviderRoutes(adminRouter: Hono<{ Bindings: Env; Variables: RequestVariables }>) {
  adminRouter.get("/auth-provider/", authMiddleware, adminMiddleware, async (c) => {
    return c.json(await listAdminAuthProviders(c.env.DB, c.env.PUBLIC_URL || c.req.url, c.env.PUBLIC_WEB_FRONTEND_URL));
  });

  adminRouter.get("/auth-provider/next-id/", authMiddleware, adminMiddleware, async (c) => {
    return c.json({ next_provider_id: await getNextAuthProviderId(c.env.DB) });
  });

  adminRouter.get("/auth-provider/:id/", authMiddleware, adminMiddleware, async (c) => {
    const id = Number(c.req.param("id"));
    const row = await c.env.DB.prepare("SELECT * FROM core_authprovider WHERE id=?").bind(id).first<any>();
    if (!row) throw new DoesNotExist("Auth provider", id);
    return c.json(serializeAuthProvider(row));
  });

  adminRouter.post("/auth-provider/", authMiddleware, adminMiddleware, async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<Record<string, unknown>>();
    const type = String(body.type || "").trim();
    if (!type) throw new ValidationError("type is required.");
    if (type === "password") {
      return c.json({ error: "ERROR_AUTH_PROVIDER_CANNOT_BE_CREATED", detail: "The provider type cannot be created." }, 400);
    }
    const validation = validateAuthProviderPayload(type, body);
    if (validation) return c.json(requestBodyValidation(validation), 400);
    const domainValue = body.domain ? String(body.domain).toLowerCase() : "";
    if (await authProviderDomainExists(c.env.DB, type, domainValue)) {
      return c.json({ error: "ERROR_SAML_PROVIDER_FOR_DOMAIN_ALREADY_EXISTS", detail: "A SAML provider already exists for this domain." }, 400);
    }
    const { enabled, domain, type: _type, ...metadata } = body;
    let normalizedMetadata: Record<string, unknown>;
    try {
      normalizedMetadata = await normalizeAuthProviderMetadata(type, metadata, true);
    } catch {
      return c.json(invalidProviderUrlResponse(), 400);
    }
    const row = await c.env.DB.prepare(
      "INSERT INTO core_authprovider (type, enabled, domain, metadata) VALUES (?, ?, ?, ?) RETURNING *"
    ).bind(type, enabled === false ? 0 : 1, domain ? String(domain).toLowerCase() : null, JSON.stringify(normalizedMetadata)).first<any>();
    await logAuditEntry(c.env.DB, "admin.auth_provider.create", {
      user,
    }, { id: row?.id ?? null, type: "auth_provider" }, {
      provider_id: row?.id,
      provider_type: type,
      domain: domain ? String(domain).toLowerCase() : "",
      enabled: enabled !== false,
    });
    return c.json(serializeAuthProvider(row));
  });

  adminRouter.patch("/auth-provider/:id/", authMiddleware, adminMiddleware, async (c) => {
    const user = c.get("user")!;
    const id = Number(c.req.param("id"));
    const existing = await c.env.DB.prepare("SELECT * FROM core_authprovider WHERE id=?").bind(id).first<any>();
    if (!existing) throw new DoesNotExist("Auth provider", id);
    const body = await c.req.json<Record<string, unknown>>();
    const type = String(existing.type || "").trim();
    if (body.type !== undefined && String(body.type) !== type) {
      return c.json(requestBodyValidation({ type: [{ error: "The authentication provider type cannot be changed.", code: "invalid" }] }), 400);
    }
    const validation = validateAuthProviderPayload(type, body, true);
    if (validation) return c.json(requestBodyValidation(validation), 400);
    const nextDomain = body.domain === undefined ? String(existing.domain || "") : String(body.domain || "").toLowerCase();
    if (await authProviderDomainExists(c.env.DB, type, nextDomain, id)) {
      return c.json({ error: "ERROR_SAML_PROVIDER_FOR_DOMAIN_ALREADY_EXISTS", detail: "A SAML provider already exists for this domain." }, 400);
    }
    const nextEnabled = body.enabled === undefined ? Boolean(existing.enabled) : Boolean(body.enabled);
    if (!nextEnabled && await enabledAuthProviderCountExcluding(c.env.DB, id) === 0) {
      return c.json(cannotDisableLastAuthProviderResponse(), 400);
    }
    const metadata = { ...parseJsonObject(existing.metadata), ...body };
    delete metadata.enabled;
    delete metadata.domain;
    delete metadata.type;
    delete metadata.is_verified;
    let normalizedMetadata: Record<string, unknown>;
    try {
      normalizedMetadata = await normalizeAuthProviderMetadata(type, metadata, body.base_url !== undefined);
    } catch {
      return c.json(invalidProviderUrlResponse(), 400);
    }
    await c.env.DB.prepare("UPDATE core_authprovider SET enabled=?, domain=?, metadata=? WHERE id=?")
      .bind(nextEnabled ? 1 : 0, body.domain === undefined ? existing.domain : String(body.domain || "").toLowerCase(), JSON.stringify(normalizedMetadata), id)
      .run();
    const row = await c.env.DB.prepare("SELECT * FROM core_authprovider WHERE id=?").bind(id).first<any>();
    await logAuditEntry(c.env.DB, "admin.auth_provider.update", {
      user,
    }, { id, type: "auth_provider" }, {
      provider_id: id,
      provider_type: type,
      before: {
        enabled: Boolean(existing.enabled),
        domain: existing.domain || "",
        metadata: parseJsonObject(existing.metadata),
      },
      after: {
        enabled: Boolean(row?.enabled),
        domain: row?.domain || "",
        metadata: parseJsonObject(row?.metadata),
      },
    });
    return c.json(serializeAuthProvider(row));
  });

  adminRouter.delete("/auth-provider/:id/", authMiddleware, adminMiddleware, async (c) => {
    const user = c.get("user")!;
    const id = Number(c.req.param("id"));
    const existing = await c.env.DB.prepare("SELECT * FROM core_authprovider WHERE id=?").bind(id).first<any>();
    if (!existing) throw new DoesNotExist("Auth provider", id);
    if (existing.type === "password") {
      return c.json({ error: "ERROR_AUTH_PROVIDER_CANNOT_BE_DELETED", detail: "The provider type cannot be deleted." }, 400);
    }
    if (existing.enabled && await enabledAuthProviderCountExcluding(c.env.DB, id) === 0) {
      return c.json(cannotDisableLastAuthProviderResponse(), 400);
    }
    await c.env.DB.prepare("DELETE FROM core_authprovider WHERE id=?").bind(id).run();
    await logAuditEntry(c.env.DB, "admin.auth_provider.delete", {
      user,
    }, { id, type: "auth_provider" }, {
      provider_id: id,
      provider_type: existing.type,
      domain: existing.domain || "",
      enabled: Boolean(existing.enabled),
    });
    return c.body(null, 204);
  });
}

export { enterprise as teamsRouter, role as roleRouter, fieldPermissions as fieldPermissionsRouter };
