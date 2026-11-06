import { Hono } from "hono";
import { strToU8, Unzip, UnzipInflate, Zip, ZipDeflate } from "fflate";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { ApiError, DoesNotExist, PermissionError, ValidationError } from "../middleware/error";
import { sendWorkspaceInvitationEmail } from "../services/email";
import { recordTrashEntry } from "../services/trash";
import {
  buildApplicationSnapshot,
  createSnapshotRestoreContext,
  iterateSnapshotTableRows,
  referencedSnapshotFileNames,
  restoreApplicationSnapshot,
  restoreSnapshotUserFiles,
  snapshotUserFilesForNames,
  type SnapshotFileBody,
  type SnapshotFileEntries,
} from "./snapshots";
import { logAuditEntry } from "../services/audit-log";
import { createDirectNotificationForUsers, markInvitationNotificationAsRead } from "../services/notifications";
import { enabledGenerativeAIModels, normalizeGenerativeAISettings, workspaceGenerativeAISettings } from "../services/generative-ai";
import { buildFileUrl, publicMediaUrl } from "../services/secure-file-serve";
import { assertHasApplicationRole, assertHasWorkspaceRole, hasLoadedApplicationRole } from "../services/enterprise-permissions";
import { userFileUploadSizeLimitBytes } from "../services/user-files";
import {
  accountCreationDecision,
  throwAccountCreationDecision,
} from "../services/account-access";

const workspaces = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

// ── Permission levels ─────────────────────────────────────────────────────────
// ADMIN = 1, BUILDER = 2, EDITOR = 3, COMMENTER = 4, VIEWER = 5, NO_ROLE = 6
const ADMIN = "ADMIN";
const MEMBER = "MEMBER";
const VIEWER = "VIEWER";
const WORKSPACE_EXPORT_FORMAT_VERSION = "1.0.0";
const MANIFEST_NAME = "manifest.json";
const SIGNATURE_NAME = "manifest_signature.json";

interface WorkspaceRow {
  id: number;
  name: string;
  created_on: string;
  trashed?: number;
}

interface WorkspaceUserRow {
  id: number;
  workspace_id: number;
  user_id: number;
  order: number;
  permissions: string;
  to_be_deleted: number;
}

interface WorkspaceInvitationRow {
  id: number;
  workspace_id: number;
  invited_by_id: number;
  email: string;
  permissions: string;
  message: string;
  token: string;
  created_on: string;
}

type WorkspaceMemberAnnotations = {
  roleUidByUserId: Map<number, string>;
  highestRoleUidByUserId: Map<number, string>;
  teamsByUserId: Map<number, Array<{ id: number; name: string }>>;
};

type WorkspaceExportPayload = {
  format: "supertask_workspace_export";
  version: 1;
  exported_at: string;
  workspace: {
    id: number;
    name: string;
    created_on: string;
  };
  options: Record<string, unknown>;
  applications: any[];
  file_entries?: SnapshotFileEntries;
};

const ENTERPRISE_ROLE_RANK: Record<string, number> = {
  ADMIN: 1,
  BUILDER: 2,
  EDITOR: 3,
  COMMENTER: 4,
  VIEWER: 5,
  NO_ROLE_LOW_PRIORITY: 6,
  NO_ROLE: 6,
  NO_ACCESS: 99,
  NOBODY: 99,
};

function normalizeWorkspaceMemberRoleUid(value: unknown): string {
  const raw = String(value || "NO_ACCESS").trim();
  const uid = raw === raw.toUpperCase()
    ? raw
    : raw.includes("_")
      ? raw.toUpperCase()
      : raw.replace(/[A-Z]/g, (match) => `_${match}`).toUpperCase().replace(/^_/, "");
  if (uid === "MEMBER") return "BUILDER";
  if (uid === "NO_ROLE") return "NO_ROLE_LOW_PRIORITY";
  return ENTERPRISE_ROLE_RANK[uid] === undefined ? "NO_ACCESS" : uid;
}

function strongestWorkspaceRole(left: string | undefined, right: string | undefined): string {
  const normalizedLeft = normalizeWorkspaceMemberRoleUid(left);
  const normalizedRight = normalizeWorkspaceMemberRoleUid(right);
  return (ENTERPRISE_ROLE_RANK[normalizedLeft] ?? 99) <= (ENTERPRISE_ROLE_RANK[normalizedRight] ?? 99)
    ? normalizedLeft
    : normalizedRight;
}

async function annotateWorkspaceMembers(
  db: D1Database,
  workspaceId: number,
  members: any[]
): Promise<WorkspaceMemberAnnotations> {
  const userIds = [...new Set(members.map((member) => Number(member.user_id)).filter(Boolean))];
  const roleUidByUserId = new Map<number, string>();
  const highestRoleUidByUserId = new Map<number, string>();
  const teamsByUserId = new Map<number, Array<{ id: number; name: string }>>();
  for (const member of members) {
    const userId = Number(member.user_id);
    const roleUid = normalizeWorkspaceMemberRoleUid(member.permissions);
    roleUidByUserId.set(userId, roleUid);
    highestRoleUidByUserId.set(userId, roleUid);
    teamsByUserId.set(userId, []);
  }

  if (userIds.length === 0) return { roleUidByUserId, highestRoleUidByUserId, teamsByUserId };

  const userPlaceholders = userIds.map(() => "?").join(",");
  const teamToUserIds = new Map<number, number[]>();
  const teamRows = await db.prepare(
    `SELECT ts.subject_id AS user_id, t.id, t.name, t.default_role_uid
       FROM enterprise_teamsubject ts
       JOIN enterprise_team t ON t.id=ts.team_id
      WHERE t.workspace_id=? AND t.trashed=0
        AND ts.subject_type='auth.User'
        AND ts.subject_id IN (${userPlaceholders})
      ORDER BY t.id ASC`
  ).bind(workspaceId, ...userIds).all<any>();

  for (const team of teamRows.results || []) {
    const userId = Number(team.user_id);
    const teamId = Number(team.id);
    teamsByUserId.get(userId)?.push({ id: teamId, name: team.name });
    teamToUserIds.set(teamId, [...(teamToUserIds.get(teamId) || []), userId]);
    if (team.default_role_uid) {
      highestRoleUidByUserId.set(
        userId,
        strongestWorkspaceRole(highestRoleUidByUserId.get(userId), team.default_role_uid)
      );
    }
  }

  const teamIds = [...teamToUserIds.keys()];
  const subjectClauses = [`(ra.subject_type='auth.User' AND ra.subject_id IN (${userPlaceholders}))`];
  const binds: unknown[] = [workspaceId, ...userIds];
  if (teamIds.length > 0) {
    subjectClauses.push(`(ra.subject_type='baserow_enterprise.Team' AND ra.subject_id IN (${teamIds.map(() => "?").join(",")}))`);
    binds.push(...teamIds);
  }
  const assignments = await db.prepare(
    `SELECT ra.subject_id, ra.subject_type, r.uid AS role_uid
       FROM enterprise_roleassignment ra
       JOIN enterprise_role r ON r.id=ra.role_id
      WHERE ra.scope_type='workspace' AND ra.scope_id=?
        AND (${subjectClauses.join(" OR ")})
      ORDER BY ra.id ASC`
  ).bind(...binds).all<any>();

  for (const assignment of assignments.results || []) {
    const roleUid = normalizeWorkspaceMemberRoleUid(assignment.role_uid);
    if (assignment.subject_type === "auth.User") {
      const userId = Number(assignment.subject_id);
      roleUidByUserId.set(userId, roleUid);
      highestRoleUidByUserId.set(userId, strongestWorkspaceRole(highestRoleUidByUserId.get(userId), roleUid));
    } else if (assignment.subject_type === "baserow_enterprise.Team") {
      for (const userId of teamToUserIds.get(Number(assignment.subject_id)) || []) {
        highestRoleUidByUserId.set(userId, strongestWorkspaceRole(highestRoleUidByUserId.get(userId), roleUid));
      }
    }
  }

  return { roleUidByUserId, highestRoleUidByUserId, teamsByUserId };
}

function serializeWorkspaceMember(member: any, annotations?: WorkspaceMemberAnnotations): object {
  const permissions = member.permissions || MEMBER;
  const userId = Number(member.user_id);
  const roleUid = annotations?.roleUidByUserId.get(userId) || normalizeWorkspaceMemberRoleUid(permissions);
  return {
    id: member.id,
    workspace: member.workspace_id,
    user_id: userId,
    permissions,
    role_uid: roleUid,
    highest_role_uid: annotations?.highestRoleUidByUserId.get(userId) || roleUid,
    order: member.order,
    name: [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email,
    email: member.email,
    profile_image_url: member.profile_image_url || null,
    two_factor_auth: false,
    teams: annotations?.teamsByUserId.get(userId) || [],
  };
}

async function getWorkspaceUser(
  db: D1Database,
  userId: number,
  workspaceId: number
): Promise<WorkspaceUserRow | null> {
  return db
    .prepare("SELECT * FROM core_workspaceuser WHERE user_id = ? AND workspace_id = ?")
    .bind(userId, workspaceId)
    .first<WorkspaceUserRow>();
}

async function requireWorkspaceAccess(
  db: D1Database,
  userId: number,
  workspaceId: number,
  minPermission = "VIEWER"
): Promise<WorkspaceUserRow> {
  const wu = await getWorkspaceUser(db, userId, workspaceId);
  if (!wu) throw new PermissionError("You do not have access to this workspace.");
  await assertHasWorkspaceRole(db, userId, workspaceId, minPermission === MEMBER ? "BUILDER" : minPermission);
  return wu;
}

async function serializeWorkspace(
  db: D1Database,
  cache: KVNamespace,
  workspace: WorkspaceRow,
  userId: number
): Promise<object> {
  const [wu, members, applications, generativeAISettings] = await Promise.all([
    getWorkspaceUser(db, userId, workspace.id),
    db
      .prepare(
        `SELECT wu.id, wu.workspace_id, wu.user_id, wu.permissions, wu.[order],
                u.first_name, u.last_name, u.email, u.username,
                p.profile_image_url
         FROM core_workspaceuser wu
         JOIN auth_user u ON u.id = wu.user_id
         LEFT JOIN core_userprofile p ON p.user_id = wu.user_id
         WHERE wu.workspace_id = ? AND wu.to_be_deleted = 0`
      )
      .bind(workspace.id)
      .all<any>(),
    db
      .prepare(
        `SELECT a.id, a.name, a.type, a.[order], a.workspace_id
         FROM core_application a
         WHERE a.workspace_id=? AND a.trashed=0
           AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
      )
      .bind(workspace.id)
      .all<any>(),
    workspaceGenerativeAISettings(cache, workspace.id),
  ]);

  const canSeeMembers = assertHasWorkspaceRole(db, userId, workspace.id, "EDITOR").then(
    () => true,
    (error) => {
      if (error instanceof PermissionError) return false;
      throw error;
    }
  );
  const [memberAnnotations, applicationVisibility, membersVisible] = await Promise.all([
    annotateWorkspaceMembers(db, workspace.id, members.results || []),
    Promise.all((applications.results || []).map((application: any) =>
      hasLoadedApplicationRole(db, userId, application, "VIEWER")
    )),
    canSeeMembers,
  ]);
  const visibleApplications = (applications.results || []).filter((_: any, index: number) => applicationVisibility[index]);
  const visibleMembers: object[] = membersVisible
    ? (members.results || []).map((member) => serializeWorkspaceMember(member, memberAnnotations))
    : [];

  return {
    id: workspace.id,
    name: workspace.name,
    created_on: workspace.created_on,
    order: wu?.order ?? 0,
    permissions: wu?.permissions ?? "VIEWER",
    licenses: ["premium", "advanced", "enterprise_without_support", "enterprise"],
    generative_ai_models_enabled: enabledGenerativeAIModels(generativeAISettings),
    users: visibleMembers,
    applications: visibleApplications.map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      order: a.order,
      workspace: a.workspace_id,
    })),
  };
}

async function serializeWorkspaceUserById(db: D1Database, workspaceUserId: number): Promise<object> {
  const member = await db.prepare(
    `SELECT wu.id, wu.workspace_id, wu.user_id, wu.permissions, wu.[order],
            u.first_name, u.last_name, u.email,
            p.profile_image_url
     FROM core_workspaceuser wu
     JOIN auth_user u ON u.id = wu.user_id
     LEFT JOIN core_userprofile p ON p.user_id = wu.user_id
     WHERE wu.id = ? AND wu.to_be_deleted = 0`
  )
    .bind(workspaceUserId)
    .first<any>();

  if (!member) throw new DoesNotExist("WorkspaceUser", workspaceUserId);

  const annotations = await annotateWorkspaceMembers(db, member.workspace_id, [member]);
  return serializeWorkspaceMember(member, annotations);
}

function serializeWorkspacePermissions(user: RequestVariables["user"], workspaceUser: WorkspaceUserRow): object[] {
  return [
    {
      name: "core",
      permissions: ["list_workspaces"],
    },
    {
      name: "setting_operation",
      permissions: {
        staff_only_operations: [],
        always_allowed_operations: ["create_workspace"],
      },
    },
    {
      name: "staff",
      permissions: {
        staff_only_operations: ["settings.update"],
        is_staff: Boolean(user?.is_staff),
      },
    },
    {
      name: "allow_if_template",
      permissions: {
        allowed_operations_on_templates: [
          "workspace.read",
          "workspace.list_applications",
          "application.list_integrations",
          "application.list_user_sources",
          "user_source.login",
          "field_rules.read",
        ],
        workspace_template_ids: [],
      },
    },
    {
      name: "basic",
      permissions: {
        admin_only_operations: [
          "workspace.create_invitation",
          "workspace.list_invitations",
          "invitation.read",
          "invitation.update",
          "invitation.delete",
          "workspace.list_workspace_users",
          "workspace.update",
          "workspace.delete",
          "workspace_user.update",
          "workspace_user.delete",
        ],
        is_admin: workspaceUser.permissions === ADMIN,
      },
    },
  ];
}

function serializeInvitation(i: any): object {
  return {
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
      email: i.invited_by_email,
      name: [i.invited_by_first_name, i.invited_by_last_name].filter(Boolean).join(" ") || i.invited_by_email,
    },
  };
}

const INVITATION_SORT_ERROR_DETAILS = {
  ERROR_INVALID_SORT_DIRECTION: "Attributes to sort by must be prefixed with one of '-' or '+'.",
  ERROR_INVALID_SORT_ATTRIBUTE: "Invalid attribute name provided to sort by.",
} as const;

function invitationSortError(error: keyof typeof INVITATION_SORT_ERROR_DETAILS) {
  return {
    error,
    detail: INVITATION_SORT_ERROR_DETAILS[error],
  };
}

function parseInvitationSorts(sorts: string | null) {
  if (sorts === null) return { orderBy: "i.id ASC" };
  const mapping = new Map([
    ["email", "i.email"],
    ["message", "i.message"],
  ]);
  const seen = new Set<string>();
  const orderBy: string[] = [];
  for (const raw of sorts.split(",")) {
    if (raw.length <= 2) return { error: "ERROR_INVALID_SORT_ATTRIBUTE" as const };
    const prefix = raw[0];
    const key = raw.slice(1);
    if (prefix !== "+" && prefix !== "-") return { error: "ERROR_INVALID_SORT_DIRECTION" as const };
    const column = mapping.get(key);
    if (!column || seen.has(column)) return { error: "ERROR_INVALID_SORT_ATTRIBUTE" as const };
    seen.add(column);
    orderBy.push(`${column} ${prefix === "-" ? "DESC" : "ASC"}`);
  }
  return { orderBy: orderBy.join(", ") };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function invitationSearchClause(search: string | null) {
  if (!search) return { sql: "", binds: [] as string[] };
  const value = `%${escapeLike(search.toLowerCase())}%`;
  return {
    sql: " AND (LOWER(i.email) LIKE ? ESCAPE '\\' OR LOWER(i.message) LIKE ? ESCAPE '\\')",
    binds: [value, value],
  };
}

const WORKSPACE_MEMBER_SORT_ERROR_DETAILS = {
  ERROR_INVALID_SORT_DIRECTION: "Attributes to sort by must be prefixed with one of '-' or '+'.",
  ERROR_INVALID_SORT_ATTRIBUTE: "Invalid attribute name provided to sort by.",
} as const;

function workspaceMemberSortError(error: keyof typeof WORKSPACE_MEMBER_SORT_ERROR_DETAILS) {
  return {
    error,
    detail: WORKSPACE_MEMBER_SORT_ERROR_DETAILS[error],
  };
}

function parseWorkspaceMemberSorts(sorts: string | null) {
  if (sorts === null) return { orderBy: "wu.id ASC" };
  const mapping = new Map([
    ["name", "u.username"],
    ["email", "u.email"],
    ["role_uid", "wu.permissions"],
  ]);
  const seen = new Set<string>();
  const orderBy: string[] = [];
  for (const raw of sorts.split(",")) {
    if (raw.length <= 2) return { error: "ERROR_INVALID_SORT_ATTRIBUTE" as const };
    const prefix = raw[0];
    const key = raw.slice(1);
    if (prefix !== "+" && prefix !== "-") return { error: "ERROR_INVALID_SORT_DIRECTION" as const };
    const column = mapping.get(key);
    if (!column || seen.has(column)) return { error: "ERROR_INVALID_SORT_ATTRIBUTE" as const };
    seen.add(column);
    orderBy.push(`${column} ${prefix === "-" ? "DESC" : "ASC"}`);
  }
  return { orderBy: orderBy.join(", ") };
}

function workspaceMemberSearchClause(search: string | null) {
  if (!search) return { sql: "", binds: [] as string[] };
  const value = `%${escapeLike(search.toLowerCase())}%`;
  return {
    sql: " AND (LOWER(u.username) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\')",
    binds: [value, value],
  };
}

async function listWorkspaceMembers(
  db: D1Database,
  workspaceId: number,
  search: ReturnType<typeof workspaceMemberSearchClause>,
  orderBy: string
) {
  const { results } = await db
    .prepare(`SELECT wu.id, wu.user_id, wu.workspace_id, wu.permissions, wu.[order],
                     u.first_name, u.last_name, u.email, u.username,
                     p.profile_image_url
              FROM core_workspaceuser wu
              JOIN auth_user u ON u.id = wu.user_id
              LEFT JOIN core_userprofile p ON p.user_id = wu.user_id
              WHERE wu.workspace_id = ? AND wu.to_be_deleted = 0${search.sql}
              ORDER BY ${orderBy}`)
    .bind(workspaceId, ...search.binds).all<any>();
  const members = results || [];
  const annotations = await annotateWorkspaceMembers(db, workspaceId, members);
  return members.map((member) => serializeWorkspaceMember(member, annotations));
}

function mediaUrl(env: Env, key: string): string {
  return publicMediaUrl(env, key);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pemFromDer(bytes: Uint8Array): string {
  const lines = base64FromBytes(bytes).match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

function derFromPem(pem: string): Uint8Array {
  return bytesFromBase64(pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, ""));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function applyWorkspaceExportOptions(snapshot: any, options: Record<string, unknown>) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  if (options.only_structure === true) {
    for (const table of copy.tables || []) table.rows = [];
    const referencedFiles = referencedSnapshotFileNames(copy);
    copy.user_files = (copy.user_files || []).filter((file: any) => referencedFiles.has(String(file.name || "")));
  }
  return copy;
}

async function createWorkspaceManifestSignature(manifest: Record<string, unknown>) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const signedPayload = strToU8(canonicalJson(manifest));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    keyPair.privateKey,
    signedPayload
  ));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey) as ArrayBuffer);
  return {
    algorithm: "RSASSA-PSS-SHA256",
    signature: base64FromBytes(signature),
    public_key_pem: base64FromBytes(strToU8(pemFromDer(publicKey))),
    timestamp: new Date().toISOString(),
  };
}

async function verifyWorkspaceManifestSignatureData(
  signatureEntry: Uint8Array,
  manifest: Record<string, unknown>
) {
  let signatureData: any;
  try {
    signatureData = JSON.parse(decodeUtf8(signatureEntry));
  } catch {
    throw new ValidationError("The uploaded workspace export signature is corrupted.");
  }
  if (signatureData?.algorithm !== "RSASSA-PSS-SHA256") return;
  const publicKeyPem = decodeUtf8(bytesFromBase64(String(signatureData.public_key_pem || "")));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    derFromPem(publicKeyPem),
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: 32 },
    publicKey,
    bytesFromBase64(String(signatureData.signature || "")),
    strToU8(canonicalJson(manifest))
  );
  if (!valid) throw new ValidationError("The uploaded workspace export signature is invalid.");
}

async function workspaceExportApplicationRows(
  db: D1Database,
  workspaceId: number,
  options: Record<string, unknown>
): Promise<any[]> {
  const workspace = await db.prepare("SELECT * FROM core_workspace WHERE id=? AND COALESCE(trashed, 0)=0")
    .bind(workspaceId)
    .first<any>();
  if (!workspace) throw new DoesNotExist("Workspace", workspaceId);

  const resolvedSelection = options.application_ids_resolved === true;
  const requestedValues = Array.isArray(options.application_ids) ? options.application_ids as unknown[] : [];
  const requestedIds = requestedValues.length > 0
    ? requestedValues.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  if (requestedIds.length !== requestedValues.length || new Set(requestedIds).size !== requestedIds.length) {
    throw new ValidationError("application_ids must contain unique application ids.");
  }
  const applications = await db.prepare(
    `SELECT a.id FROM core_application a
     WHERE a.workspace_id=? AND a.trashed=0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)
     ORDER BY a.[order] ASC`
  ).bind(workspaceId).all<any>();
  const rows = applications.results || [];
  if (requestedIds.length === 0) return resolvedSelection ? [] : rows;
  const requested = new Set(requestedIds);
  const selected = rows.filter((application) => requested.has(Number(application.id)));
  if (selected.length !== requestedIds.length) {
    throw new PermissionError("Some of the selected applications do not exist or cannot be exported.");
  }
  return selected;
}

type WorkspaceExportProgress = (
  exportedApplications: number,
  totalApplications: number,
  state: "exporting" | "create-archive"
) => void | Promise<void>;

function workspaceRowChunkBytes(rows: any[], maxBytes = 4 * 1024 * 1024): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let serializedRows: string[] = [];
  let size = 2;
  const flush = () => {
    if (serializedRows.length === 0) return;
    chunks.push(strToU8(`[${serializedRows.join(",")}]`));
    serializedRows = [];
    size = 2;
  };
  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const rowSize = strToU8(serialized).length + (serializedRows.length > 0 ? 1 : 0);
    if (serializedRows.length > 0 && size + rowSize > maxBytes) flush();
    serializedRows.push(serialized);
    size += rowSize;
  }
  flush();
  return chunks;
}

function hexFromBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function streamWorkspaceExportPackage(
  env: Env,
  workspaceId: number,
  key: string,
  exportedFileName: string,
  options: Record<string, unknown>,
  onProgress?: WorkspaceExportProgress
): Promise<{ applicationCount: number }> {
  const applications = await workspaceExportApplicationRows(env.DB, workspaceId, options);
  const multipart = await env.FILES.createMultipartUpload(key, {
    httpMetadata: {
      contentType: "application/zip",
      contentDisposition: "attachment; filename=\"" + exportedFileName.replace(/["\\\r\n]/g, "_") + "\"",
    },
  });
  const partSize = 8 * 1024 * 1024;
  const uploadedParts: R2UploadedPart[] = [];
  let bufferedChunks: Uint8Array[] = [];
  let bufferedSize = 0;
  let partNumber = 1;
  const takeBufferedBytes = (size: number): Uint8Array => {
    const all = joinByteChunks(bufferedChunks);
    const part = all.slice(0, size);
    const remainder = all.slice(size);
    bufferedChunks = remainder.length > 0 ? [remainder] : [];
    bufferedSize = remainder.length;
    return part;
  };
  const uploadBufferedPart = async (final: boolean) => {
    while (bufferedSize >= partSize) {
      uploadedParts.push(await multipart.uploadPart(partNumber, takeBufferedBytes(partSize)));
      partNumber += 1;
    }
    if (final && bufferedSize > 0) {
      uploadedParts.push(await multipart.uploadPart(partNumber, takeBufferedBytes(bufferedSize)));
      partNumber += 1;
    }
  };
  let outputWrites: Promise<void> = Promise.resolve();
  const archive = new Zip((error, chunk, final) => {
    outputWrites = outputWrites.then(async () => {
      if (error) throw error;
      if (chunk.length > 0) {
        bufferedChunks.push(chunk.slice());
        bufferedSize += chunk.length;
      }
      await uploadBufferedPart(final);
      if (final) await multipart.complete(uploadedParts);
    });
  });

  const addBytes = async (name: string, bytes: Uint8Array) => {
    const entry = new ZipDeflate(name, { level: 6 });
    archive.add(entry);
    entry.push(bytes, true);
    await outputWrites;
  };
  const consumeR2Object = async (
    object: R2ObjectBody,
    consume?: (chunk: Uint8Array) => void | Promise<void>
  ): Promise<string> => {
    const body = object.body;
    if (!body || typeof body.getReader !== "function") {
      const bytes = await readR2ObjectBytes(object);
      await consume?.(bytes);
      return sha256Hex(bytes);
    }
    const digestStream = typeof DigestStream === "function" ? new DigestStream("SHA-256") : null;
    const digestWriter = digestStream?.getWriter();
    const fallbackChunks: Uint8Array[] = [];
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          if (digestWriter) await digestWriter.write(value);
          else fallbackChunks.push(value.slice());
          await consume?.(value);
        }
      }
      if (digestWriter && digestStream) {
        await digestWriter.close();
        return hexFromBytes(new Uint8Array(await digestStream.digest));
      }
      const size = fallbackChunks.reduce((total, chunk) => total + chunk.length, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of fallbackChunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return sha256Hex(bytes);
    } finally {
      reader.releaseLock();
    }
  };
  const addR2Object = async (name: string, object: R2ObjectBody): Promise<string> => {
    const entry = new ZipDeflate(name, { level: 6 });
    archive.add(entry);
    const checksum = await consumeR2Object(object, async (chunk) => {
      entry.push(chunk, false);
      await outputWrites;
    });
    entry.push(new Uint8Array(0), true);
    await outputWrites;
    return checksum;
  };

  const checksums: Record<string, string> = {};
  const groupedApplications: Record<string, { version: string; configuration: Record<string, unknown>; items: any[] }> = {};
  const archivedFiles = new Map<string, string>();
  try {
    for (let index = 0; index < applications.length; index += 1) {
      const applicationData = applyWorkspaceExportOptions(
        await buildApplicationSnapshot(env.DB, Number(applications[index].id), {
          includeBuilderDomains: false,
          includeAutomationHistory: false,
          includeRows: false,
        }),
        options
      );
      const application = applicationData.application || {};
      const type = String(application.type || "database");
      const appUuid = crypto.randomUUID().replace(/-/g, "");
      const rowChunkFiles: Array<{ table_id: number; name: string; row_count: number }> = [];
      const referencedFileNames = referencedSnapshotFileNames(applicationData);
      for (const tableBundle of applicationData.tables || []) {
        tableBundle.rows = [];
        if (options.only_structure === true) continue;
        const tableId = Number(tableBundle.table?.id || 0);
        let chunkIndex = 0;
        for await (const page of iterateSnapshotTableRows(env.DB, tableId)) {
          for (const fileName of referencedSnapshotFileNames(page)) referencedFileNames.add(fileName);
          const chunks = workspaceRowChunkBytes(page);
          let pageRowCount = 0;
          for (const rowBytes of chunks) {
            chunkIndex += 1;
            const rowChecksum = await sha256Hex(rowBytes);
            const rowName = `rows__${appUuid}_${tableId}_${chunkIndex}_${rowChecksum}.json`;
            await addBytes(rowName, rowBytes);
            checksums[rowName] = rowChecksum;
            const rowCount = JSON.parse(decodeUtf8(rowBytes)).length;
            rowChunkFiles.push({ table_id: tableId, name: rowName, row_count: rowCount });
            pageRowCount += rowCount;
          }
          if (pageRowCount !== page.length) throw new Error("Workspace row chunk export count mismatch.");
        }
      }
      const knownFiles = new Set((applicationData.user_files || []).map((file: any) => String(file?.name || "")).filter(Boolean));
      for (const file of await snapshotUserFilesForNames(env.DB, referencedFileNames)) {
        if (!knownFiles.has(file.name)) {
          applicationData.user_files ||= [];
          applicationData.user_files.push(file);
          knownFiles.add(file.name);
        }
      }
      const schemaBytes = strToU8(JSON.stringify(applicationData, null, 2));
      const checksum = await sha256Hex(schemaBytes);
      const schemaName = `${type}__${appUuid}_${checksum}.json`;
      await addBytes(schemaName, schemaBytes);
      checksums[schemaName] = checksum;

      for (const file of applicationData.user_files || []) {
        const fileName = String(file.name || "");
        if (!fileName) continue;
        const object = await env.FILES.get(String(file.r2_key || `user_files/${fileName}`));
        if (!object) throw new DoesNotExist("User file", fileName);
        const existing = archivedFiles.get(fileName);
        const fileChecksum = existing
          ? await consumeR2Object(object)
          : await addR2Object(fileName, object);
        if (existing && existing !== fileChecksum) {
          throw new ValidationError(`The exported applications contain conflicting user files named ${fileName}.`);
        }
        archivedFiles.set(fileName, fileChecksum);
        checksums[fileName] = fileChecksum;
      }

      groupedApplications[type] ||= {
        version: WORKSPACE_EXPORT_FORMAT_VERSION,
        configuration: {},
        items: [],
      };
      groupedApplications[type].items.push({
        id: Number(application.id),
        type,
        name: String(application.name || type),
        uuid: appUuid,
        total_files: 1 + rowChunkFiles.length,
        files: { schema: schemaName, row_chunks: rowChunkFiles },
      });
      await onProgress?.(index + 1, applications.length, "exporting");
    }

    await onProgress?.(applications.length, applications.length, "create-archive");
    const manifest = {
      version: WORKSPACE_EXPORT_FORMAT_VERSION,
      baserow_version: "1.0.0",
      total_files: Object.keys(checksums).length + 2,
      configuration: { only_structure: options.only_structure === true },
      applications: groupedApplications,
      checksums,
    };
    await addBytes(MANIFEST_NAME, strToU8(JSON.stringify(manifest, null, 2)));
    await addBytes(SIGNATURE_NAME, strToU8(JSON.stringify(await createWorkspaceManifestSignature(manifest), null, 2)));
    archive.end();
    await outputWrites;
  } catch (error) {
    archive.terminate();
    await multipart.abort().catch(() => undefined);
    await env.FILES.delete(key).catch(() => undefined);
    throw error;
  }
  return { applicationCount: applications.length };
}

export async function processWorkspaceExportResource(
  env: Env,
  workspaceId: number,
  key: string,
  exportedFileName: string,
  options: Record<string, unknown>,
  onProgress?: WorkspaceExportProgress
): Promise<Record<string, unknown>> {
  const archive = await streamWorkspaceExportPackage(
    env,
    workspaceId,
    key,
    exportedFileName,
    options,
    onProgress
  );
  return {
    workspace_id: workspaceId,
    exported_file_name: exportedFileName,
    exported_file_key: key,
    url: await buildFileUrl(env, key, workspaceId),
    application_count: archive.applicationCount,
  };
}

async function findWorkspaceImportObject(
  env: Env,
  workspaceId: number,
  resourceId: string
): Promise<{ key: string; object: R2ObjectBody }> {
  const prefix = `workspace-imports/${workspaceId}/${resourceId}-`;
  const listed = await env.FILES.list({ prefix, limit: 1 });
  const key = listed.objects[0]?.key;
  if (!key) throw new DoesNotExist("Workspace import resource", resourceId);
  const object = await env.FILES.get(key);
  if (!object) throw new DoesNotExist("Workspace import resource", resourceId);
  return { key, object };
}

async function readR2ObjectBytes(object: R2ObjectBody): Promise<Uint8Array> {
  const candidate = object as R2ObjectBody & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof candidate.arrayBuffer === "function") {
    return new Uint8Array(await candidate.arrayBuffer());
  }
  return strToU8(await object.text());
}

function joinByteChunks(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function validateWorkspaceExportPackageStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const entryChecksums = new Map<string, string>();
  const retainedEntries = new Map<string, Uint8Array>();
  const discoveredEntries = new Set<string>();
  let entryCount = 0;
  let processing: Promise<void> = Promise.resolve();
  const unzip = new Unzip((file) => {
    const name = file.name.replace(/^(?:\.\/)+/, "");
    if (!name || discoveredEntries.has(name)) {
      processing = processing.then(() => {
        throw new ValidationError(`The uploaded workspace export contains a duplicate or invalid entry named ${name || file.name}.`);
      });
      return;
    }
    discoveredEntries.add(name);
    entryCount += 1;
    const retained = name === MANIFEST_NAME || name === SIGNATURE_NAME;
    const retainedChunks: Uint8Array[] = [];
    let retainedSize = 0;
    const digestStream = typeof DigestStream === "function" ? new DigestStream("SHA-256") : null;
    const digestWriter = digestStream?.getWriter();
    const fallbackChunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      processing = processing.then(async () => {
        if (error) throw error;
        if (chunk.length > 0) {
          if (digestWriter) await digestWriter.write(chunk);
          else fallbackChunks.push(chunk.slice());
          if (retained) {
            retainedSize += chunk.length;
            if (retainedSize > 2 * 1024 * 1024) {
              throw new ValidationError(`The uploaded workspace export ${name} entry is too large.`);
            }
            retainedChunks.push(chunk.slice());
          }
        }
        if (!final) return;
        let checksum: string;
        if (digestWriter && digestStream) {
          await digestWriter.close();
          checksum = hexFromBytes(new Uint8Array(await digestStream.digest));
        } else {
          checksum = await sha256Hex(joinByteChunks(fallbackChunks));
        }
        entryChecksums.set(name, checksum);
        if (retained) retainedEntries.set(name, joinByteChunks(retainedChunks));
      });
    };
    try {
      file.start();
    } catch (error) {
      processing = processing.then(() => { throw error; });
    }
  });
  unzip.register(UnzipInflate);
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        unzip.push(value, false);
        await processing;
      }
    }
    unzip.push(new Uint8Array(0), true);
    await processing;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const manifestBytes = retainedEntries.get(MANIFEST_NAME);
  const signatureBytes = retainedEntries.get(SIGNATURE_NAME);
  if (!manifestBytes) throw new ValidationError(`The uploaded workspace export is missing ${MANIFEST_NAME}.`);
  if (!signatureBytes) throw new ValidationError(`The uploaded workspace export is missing ${SIGNATURE_NAME}.`);
  let manifest: any;
  try {
    manifest = JSON.parse(decodeUtf8(manifestBytes));
  } catch {
    throw new ValidationError("The uploaded workspace export manifest is corrupted.");
  }
  if (
    typeof manifest.version !== "string" ||
    !manifest.applications ||
    typeof manifest.applications !== "object" ||
    !manifest.checksums ||
    typeof manifest.checksums !== "object"
  ) {
    throw new ValidationError("The uploaded workspace export manifest is invalid.");
  }
  if (!Number.isInteger(manifest.total_files) || manifest.total_files !== entryCount) {
    throw new ValidationError("The uploaded workspace export file count does not match the manifest.");
  }
  const checksums = manifest.checksums as Record<string, string>;
  for (const name of discoveredEntries) {
    if (name === MANIFEST_NAME || name === SIGNATURE_NAME) continue;
    if (!(name in checksums)) {
      throw new ValidationError(`The uploaded workspace export checksum is missing for ${name}.`);
    }
  }
  for (const [rawName, checksum] of Object.entries(checksums)) {
    const name = rawName.replace(/^(?:\.\/)+/, "");
    if (!entryChecksums.has(name)) {
      throw new ValidationError(`The uploaded workspace export is missing ${name}.`);
    }
    if (String(checksum) !== entryChecksums.get(name)) {
      throw new ValidationError(`The uploaded workspace export checksum failed for ${name}.`);
    }
  }
  await verifyWorkspaceManifestSignatureData(signatureBytes, manifest);
}

type ExtractedWorkspaceEntry = {
  key: string;
  checksum: string;
  size: number;
};

async function r2ObjectStream(object: R2ObjectBody): Promise<ReadableStream<Uint8Array>> {
  if (object.body && typeof object.body.getReader === "function") return object.body;
  const bytes = await readR2ObjectBytes(object);
  return new Blob([bytes]).stream() as ReadableStream<Uint8Array>;
}

async function extractWorkspaceExportPackageToR2(
  env: Env,
  object: R2ObjectBody,
  temporaryPrefix: string
): Promise<{ manifest: any; entries: Map<string, ExtractedWorkspaceEntry>; temporaryKeys: string[] }> {
  const entries = new Map<string, ExtractedWorkspaceEntry>();
  const temporaryKeys: string[] = [];
  const retainedEntries = new Map<string, Uint8Array>();
  const discoveredEntries = new Set<string>();
  let entryCount = 0;
  let processing: Promise<void> = Promise.resolve();
  const partSize = 8 * 1024 * 1024;
  const unzip = new Unzip((file) => {
    const name = file.name.replace(/^(?:\.\/)+/, "");
    if (!name || discoveredEntries.has(name)) {
      processing = processing.then(() => {
        throw new ValidationError(`The uploaded workspace export contains a duplicate or invalid entry named ${name || file.name}.`);
      });
      return;
    }
    discoveredEntries.add(name);
    entryCount += 1;
    const temporaryKey = `${temporaryPrefix}${String(entryCount).padStart(6, "0")}`;
    temporaryKeys.push(temporaryKey);
    const multipartPromise = env.FILES.createMultipartUpload(temporaryKey, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const retained = name === MANIFEST_NAME || name === SIGNATURE_NAME;
    const retainedChunks: Uint8Array[] = [];
    let retainedSize = 0;
    const digestStream = typeof DigestStream === "function" ? new DigestStream("SHA-256") : null;
    const digestWriter = digestStream?.getWriter();
    const fallbackDigestChunks: Uint8Array[] = [];
    let bufferedChunks: Uint8Array[] = [];
    let bufferedSize = 0;
    let totalSize = 0;
    let partNumber = 1;
    const uploadedParts: R2UploadedPart[] = [];
    const takeBytes = (size: number) => {
      const all = joinByteChunks(bufferedChunks);
      const part = all.slice(0, size);
      const remainder = all.slice(size);
      bufferedChunks = remainder.length > 0 ? [remainder] : [];
      bufferedSize = remainder.length;
      return part;
    };
    file.ondata = (error, chunk, final) => {
      const ownedChunk = chunk.slice();
      processing = processing.then(async () => {
        if (error) throw error;
        if (ownedChunk.length > 0) {
          totalSize += ownedChunk.length;
          bufferedChunks.push(ownedChunk);
          bufferedSize += ownedChunk.length;
          if (digestWriter) await digestWriter.write(ownedChunk);
          else fallbackDigestChunks.push(ownedChunk);
          if (retained) {
            retainedSize += ownedChunk.length;
            if (retainedSize > 2 * 1024 * 1024) {
              throw new ValidationError(`The uploaded workspace export ${name} entry is too large.`);
            }
            retainedChunks.push(ownedChunk);
          }
        }
        const multipart = await multipartPromise;
        while (bufferedSize >= partSize) {
          uploadedParts.push(await multipart.uploadPart(partNumber, takeBytes(partSize)));
          partNumber += 1;
        }
        if (!final) return;
        if (bufferedSize > 0) {
          uploadedParts.push(await multipart.uploadPart(partNumber, takeBytes(bufferedSize)));
        }
        if (uploadedParts.length > 0) await multipart.complete(uploadedParts);
        else {
          await multipart.abort().catch(() => undefined);
          await env.FILES.put(temporaryKey, new Uint8Array(0));
        }
        let checksum: string;
        if (digestWriter && digestStream) {
          await digestWriter.close();
          checksum = hexFromBytes(new Uint8Array(await digestStream.digest));
        } else {
          checksum = await sha256Hex(joinByteChunks(fallbackDigestChunks));
        }
        entries.set(name, { key: temporaryKey, checksum, size: totalSize });
        if (retained) retainedEntries.set(name, joinByteChunks(retainedChunks));
      }).catch(async (failure) => {
        const multipart = await multipartPromise.catch(() => null);
        await multipart?.abort().catch(() => undefined);
        throw failure;
      });
    };
    try {
      file.start();
    } catch (error) {
      processing = processing.then(() => { throw error; });
    }
  });
  unzip.register(UnzipInflate);
  const stream = await r2ObjectStream(object);
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        unzip.push(value, false);
        await processing;
      }
    }
    unzip.push(new Uint8Array(0), true);
    await processing;

    const manifestBytes = retainedEntries.get(MANIFEST_NAME);
    const signatureBytes = retainedEntries.get(SIGNATURE_NAME);
    if (!manifestBytes) throw new ValidationError(`The uploaded workspace export is missing ${MANIFEST_NAME}.`);
    if (!signatureBytes) throw new ValidationError(`The uploaded workspace export is missing ${SIGNATURE_NAME}.`);
    let manifest: any;
    try {
      manifest = JSON.parse(decodeUtf8(manifestBytes));
    } catch {
      throw new ValidationError("The uploaded workspace export manifest is corrupted.");
    }
    if (
      typeof manifest.version !== "string" ||
      !manifest.applications ||
      typeof manifest.applications !== "object" ||
      !manifest.checksums ||
      typeof manifest.checksums !== "object"
    ) {
      throw new ValidationError("The uploaded workspace export manifest is invalid.");
    }
    if (!Number.isInteger(manifest.total_files) || manifest.total_files !== entryCount) {
      throw new ValidationError("The uploaded workspace export file count does not match the manifest.");
    }
    for (const name of discoveredEntries) {
      if (name === MANIFEST_NAME || name === SIGNATURE_NAME) continue;
      if (!(name in manifest.checksums)) {
        throw new ValidationError(`The uploaded workspace export checksum is missing for ${name}.`);
      }
    }
    for (const [rawName, expectedChecksum] of Object.entries(manifest.checksums as Record<string, string>)) {
      const name = rawName.replace(/^(?:\.\/)+/, "");
      const entry = entries.get(name);
      if (!entry) throw new ValidationError(`The uploaded workspace export is missing ${name}.`);
      if (entry.checksum !== String(expectedChecksum)) {
        throw new ValidationError(`The uploaded workspace export checksum failed for ${name}.`);
      }
    }
    await verifyWorkspaceManifestSignatureData(signatureBytes, manifest);
    return { manifest, entries, temporaryKeys };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await env.FILES.delete(temporaryKeys).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function selectedApplicationIds(ids?: number[]): Set<number> | null {
  const values = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
  return values.length > 0 ? new Set(values) : null;
}

async function parseExtractedWorkspaceExportPackage(
  env: Env,
  extracted: { manifest: any; entries: Map<string, ExtractedWorkspaceEntry> },
  applicationIds?: number[]
): Promise<{
  data: WorkspaceExportPayload;
  applicationSource: {
    total: number;
    load: (index: number) => Promise<{
      data: any;
      loadTableRows?: (oldTableId: number) => AsyncIterable<any[]>;
    }>;
  };
  loadFileBody: (name: string) => Promise<SnapshotFileBody | null>;
}> {
  const { manifest, entries } = extracted;
  const ids = selectedApplicationIds(applicationIds);
  const availableIds = new Set<number>();
  const schemaEntries: Array<{
    entry: ExtractedWorkspaceEntry;
    rowChunks: Array<{ table_id: number; name: string; entry: ExtractedWorkspaceEntry }>;
  }> = [];
  const groups = Object.entries(manifest.applications as Record<string, any>)
    .sort(([left], [right]) => (left === "database" ? -1 : right === "database" ? 1 : left.localeCompare(right)));
  for (const [, group] of groups) {
    for (const item of group?.items || []) {
      const applicationId = Number(item.id);
      availableIds.add(applicationId);
      if (ids && !ids.has(applicationId)) continue;
      const schemaName = String(item.files?.schema || "");
      const schemaEntry = entries.get(schemaName);
      if (!schemaName || !schemaEntry) {
        throw new ValidationError("The uploaded workspace export application schema is invalid.");
      }
      const rowChunks = Array.isArray(item.files?.row_chunks) ? item.files.row_chunks : [];
      const resolvedRowChunks = rowChunks.map((rowChunk: any) => {
        const name = String(rowChunk?.name || "");
        const entry = entries.get(name);
        const tableId = Number(rowChunk?.table_id);
        if (!name || !entry || !Number.isInteger(tableId) || tableId <= 0) {
          throw new ValidationError("The uploaded workspace export row chunk is invalid.");
        }
        return { table_id: tableId, name, entry };
      });
      schemaEntries.push({ entry: schemaEntry, rowChunks: resolvedRowChunks });
    }
  }
  if (ids) {
    for (const id of ids) {
      if (!availableIds.has(id)) {
        throw new ValidationError("The selected applications were not found in the uploaded workspace export.");
      }
    }
  }
  return {
    data: {
      format: "supertask_workspace_export",
      version: 1,
      exported_at: new Date().toISOString(),
      workspace: { id: 0, name: "", created_on: "" },
      options: { only_structure: manifest.configuration?.only_structure === true },
      applications: [],
    },
    applicationSource: {
      total: schemaEntries.length,
      load: async (index: number) => {
        const schemaBundle = schemaEntries[index];
        if (!schemaBundle) throw new ValidationError("The uploaded workspace export application schema is invalid.");
        const schemaObject = await env.FILES.get(schemaBundle.entry.key);
        if (!schemaObject) throw new ValidationError("The uploaded workspace export application schema is missing.");
        const applicationData = JSON.parse(decodeUtf8(await readR2ObjectBytes(schemaObject)));
        for (const file of applicationData.user_files || []) {
          const fileName = String(file.name || "");
          if (fileName && !entries.has(fileName)) {
            throw new ValidationError(`The uploaded workspace export is missing ${fileName}.`);
          }
        }
        const chunksByTable = new Map<number, Array<{ name: string; entry: ExtractedWorkspaceEntry }>>();
        for (const rowChunk of schemaBundle.rowChunks) {
          const chunks = chunksByTable.get(rowChunk.table_id) || [];
          chunks.push({ name: rowChunk.name, entry: rowChunk.entry });
          chunksByTable.set(rowChunk.table_id, chunks);
        }
        return {
          data: applicationData,
          loadTableRows: schemaBundle.rowChunks.length === 0
            ? undefined
            : async function* (oldTableId: number) {
              for (const chunk of chunksByTable.get(oldTableId) || []) {
                const rowObject = await env.FILES.get(chunk.entry.key);
                if (!rowObject) throw new ValidationError(`The uploaded workspace export is missing ${chunk.name}.`);
                const rows = JSON.parse(decodeUtf8(await readR2ObjectBytes(rowObject)));
                if (!Array.isArray(rows)) throw new ValidationError(`The uploaded workspace export row chunk ${chunk.name} is invalid.`);
                yield rows;
              }
            },
        };
      },
    },
    loadFileBody: async (name: string) => {
      const entry = entries.get(name);
      if (!entry) return null;
      const fileObject = await env.FILES.get(entry.key);
      if (!fileObject) return null;
      if (fileObject.body && typeof fileObject.body.getReader === "function") return fileObject.body;
      return readR2ObjectBytes(fileObject);
    },
  };
}

async function restoreWorkspaceExport(
  env: Env,
  targetWorkspaceId: number,
  data: WorkspaceExportPayload,
  onApplicationRestored?: (restored: number, total: number) => void | Promise<void>,
  loadFileBody?: (name: string) => Promise<SnapshotFileBody | null>,
  applicationSource?: {
    total: number;
    load: (index: number) => Promise<{ data: any; loadTableRows?: (oldTableId: number) => AsyncIterable<any[]> }>;
  }
) {
  if (
    data?.format !== "supertask_workspace_export" ||
    data.version !== 1 ||
    (!applicationSource && !Array.isArray(data.applications))
  ) {
    throw new ValidationError("The uploaded workspace export is not a valid Supertask workspace export.");
  }

  const restoredApplications = [];
  const createdApplicationIds: number[] = [];
  const createdFileNames = new Set<string>();
  const context = createSnapshotRestoreContext();
  const applicationCount = applicationSource?.total ?? data.applications.length;
  try {
    for (let applicationIndex = 0; applicationIndex < applicationCount; applicationIndex += 1) {
      const loadedApplication = applicationSource
        ? await applicationSource.load(applicationIndex)
        : { data: data.applications[applicationIndex] };
      const applicationData = loadedApplication.data;
      const application = applicationData?.application;
      if (!application?.name) {
        throw new ValidationError("The uploaded workspace export contains an invalid application.");
      }
      const importedFileNames = new Set<string>([
        ...referencedSnapshotFileNames(applicationData),
        ...(applicationData.user_files || []).map((file: any) => String(file?.name || "")).filter(Boolean),
      ]);
      for (const name of importedFileNames) {
        const existing = await env.DB.prepare("SELECT id FROM core_userfile WHERE name=?").bind(name).first<{ id: number }>();
        if (!existing) createdFileNames.add(name);
      }
      await restoreSnapshotUserFiles(env, applicationData, data.file_entries || {}, { loadBody: loadFileBody });
      const restored = await restoreApplicationSnapshot(
        env.DB,
        { id: 0, name: application.name },
        applicationData,
        {
          targetWorkspaceId,
          name: application.name,
          context,
          onApplicationCreated: (created) => {
            createdApplicationIds.push(Number(created.id));
          },
          loadTableRows: loadedApplication.loadTableRows,
        }
      );
      restoredApplications.push({
        id: restored.id,
        name: restored.name,
        type: restored.type,
        order: restored.order,
        workspace_id: restored.workspace_id,
      });
      await onApplicationRestored?.(restoredApplications.length, applicationCount);
    }
    return restoredApplications;
  } catch (error) {
    for (const applicationId of createdApplicationIds.reverse()) {
      const tables = await env.DB.prepare("SELECT id FROM database_table WHERE database_id=?")
        .bind(applicationId)
        .all<{ id: number }>();
      await env.DB.prepare(
        `DELETE FROM enterprise_fieldpermission
          WHERE field_id IN (
            SELECT f.id FROM database_field f
            JOIN database_table t ON t.id=f.table_id
            WHERE t.database_id=?
          )`
      ).bind(applicationId).run();
      await env.DB.prepare(
        `DELETE FROM enterprise_roleassignment
          WHERE (scope_type IN ('database_field', 'field') AND scope_id IN (
                   SELECT f.id FROM database_field f JOIN database_table t ON t.id=f.table_id WHERE t.database_id=?
                ))
             OR (scope_type IN ('database_view', 'view') AND scope_id IN (
                   SELECT v.id FROM database_view v JOIN database_table t ON t.id=v.table_id WHERE t.database_id=?
                ))
             OR (scope_type IN ('database_table', 'table') AND scope_id IN (
                   SELECT id FROM database_table WHERE database_id=?
                ))
             OR (scope_type IN ('application', 'database') AND scope_id=?)`
      ).bind(applicationId, applicationId, applicationId, applicationId).run();
      for (const table of tables.results || []) {
        await env.DB.prepare(`DROP TABLE IF EXISTS "database_table_${Number(table.id)}"`).run();
      }
      await env.DB.prepare("DELETE FROM core_application WHERE id=?").bind(applicationId).run();
    }
    const createdFiles = [];
    const names = [...createdFileNames];
    for (let offset = 0; offset < names.length; offset += 90) {
      const chunk = names.slice(offset, offset + 90);
      if (chunk.length === 0) continue;
      const result = await env.DB.prepare(
        `SELECT id, r2_key FROM core_userfile WHERE name IN (${chunk.map(() => "?").join(",")})`
      ).bind(...chunk).all<{ id: number; r2_key: string }>();
      createdFiles.push(...(result.results || []));
    }
    if (createdFiles.length > 0) {
      await env.FILES.delete(createdFiles.map((file) => file.r2_key));
      await env.DB.batch(createdFiles.map((file) => (
        env.DB.prepare("DELETE FROM core_userfile WHERE id=?").bind(file.id)
      )));
    }
    throw error;
  }
}

export async function processWorkspaceImportResource(
  env: Env,
  workspaceId: number,
  resourceId: string,
  applicationIds?: number[],
  onApplicationRestored?: (restored: number, total: number) => void | Promise<void>
) {
  const { object } = await findWorkspaceImportObject(env, workspaceId, resourceId);
  const temporaryPrefix = `workspace-import-extracted/${workspaceId}/${resourceId}-${crypto.randomUUID()}/`;
  const extracted = await extractWorkspaceExportPackageToR2(env, object, temporaryPrefix);
  try {
    const parsed = await parseExtractedWorkspaceExportPackage(env, extracted, applicationIds);
    return await restoreWorkspaceExport(
      env,
      workspaceId,
      parsed.data,
      onApplicationRestored,
      parsed.loadFileBody,
      parsed.applicationSource
    );
  } finally {
    await env.FILES.delete(extracted.temporaryKeys).catch(() => undefined);
  }
}

function serializeWorkspaceImportJob(job: any): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  try {
    const parsed = job?.result ? JSON.parse(job.result) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
  } catch {
  }
  return {
    id: job.id,
    job_id: job.id,
    type: job.type,
    state: job.status,
    status: job.status,
    progress_percentage: job.progress_percentage ?? 0,
    error: job.error || null,
    human_readable_error: job.human_readable_error || null,
    result,
    ...result,
    user_id: job.user_id,
    created_on: job.created_on,
    updated_on: job.updated_on,
  };
}

async function getInvitationById(db: D1Database, invitationId: number): Promise<WorkspaceInvitationRow> {
  const invitation = await db.prepare("SELECT * FROM core_workspaceinvitation WHERE id = ?")
    .bind(invitationId)
    .first<WorkspaceInvitationRow>();
  if (!invitation) throw new DoesNotExist("WorkspaceInvitation", invitationId);
  return invitation;
}

async function getWorkspaceName(db: D1Database, workspaceId: number) {
  const row = await db.prepare("SELECT name FROM core_workspace WHERE id=?").bind(workspaceId).first<{ name: string }>();
  return row?.name || "";
}

async function getUserEmail(db: D1Database, userId: number) {
  const row = await db.prepare("SELECT email FROM auth_user WHERE id=?").bind(userId).first<{ email: string }>();
  return row?.email || "";
}

async function getUserIdByEmail(db: D1Database, email: string) {
  const row = await db.prepare("SELECT id FROM auth_user WHERE email=? COLLATE NOCASE AND is_active=1")
    .bind(email)
    .first<{ id: number }>();
  return row?.id ?? null;
}

function invitationNotificationData(invitationId: number, workspace: WorkspaceRow) {
  return {
    invitation_id: invitationId,
    invited_to_workspace_id: workspace.id,
    invited_to_workspace_name: workspace.name,
  };
}

function parseJsonOrNull(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ── GET /api/workspaces/ — List all workspaces for current user ──────────────
workspaces.get("/", authMiddleware, async (c) => {
  const user = c.get("user")!;

  const result = await c.env.DB.prepare(
    `SELECT w.* FROM core_workspace w
     JOIN core_workspaceuser wu ON wu.workspace_id = w.id
     WHERE wu.user_id = ? AND wu.to_be_deleted = 0 AND COALESCE(w.trashed, 0) = 0
     ORDER BY wu."order" ASC`
  )
    .bind(user.id)
    .all<WorkspaceRow>();

  const workspaceVisibility = await Promise.all((result.results || []).map((workspace) =>
    assertHasWorkspaceRole(c.env.DB, user.id, workspace.id, "VIEWER").then(
      () => true,
      (error) => {
        if (error instanceof PermissionError) return false;
        throw error;
      }
    )
  ));
  const visibleWorkspaces = (result.results || []).filter((_, index) => workspaceVisibility[index]);
  const workspaceList = await Promise.all(
    visibleWorkspaces.map((workspace) => serializeWorkspace(c.env.DB, c.env.CACHE, workspace, user.id))
  );

  return c.json(workspaceList);
});

// ── GET /api/workspaces/:id/applications/ — List apps in workspace ────────────
workspaces.get("/:id/applications/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));

  await requireWorkspaceAccess(c.env.DB, user.id, id, VIEWER);

  const apps = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.type, a.[order] FROM core_application a
     WHERE a.workspace_id=? AND a.trashed=0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)
     ORDER BY a.[order] ASC`
  ).bind(id).all<any>();

  const applicationVisibility = await Promise.all((apps.results || []).map((app: any) =>
    hasLoadedApplicationRole(c.env.DB, user.id, { id: Number(app.id), workspace_id: id }, "VIEWER")
  ));
  const visibleApplications = (apps.results || []).filter((_: any, index: number) => applicationVisibility[index]);

  return c.json(visibleApplications.map((a: any) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    order: a.order,
    workspace_id: id,
  })));
});

// ── GET /api/workspaces/:id/users/ — List workspace members ──────────────────
workspaces.get("/:id/users/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));

  await requireWorkspaceAccess(c.env.DB, user.id, id, "EDITOR");

  const url = new URL(c.req.url);
  const sorts = parseWorkspaceMemberSorts(url.searchParams.get("sorts"));
  if (sorts.error) return c.json(workspaceMemberSortError(sorts.error), 400);
  const search = workspaceMemberSearchClause(url.searchParams.get("search"));

  return c.json(await listWorkspaceMembers(c.env.DB, id, search, sorts.orderBy));
});

// ── GET /api/workspaces/:id/permissions/ — Frontend permission object ────────
workspaces.get("/:id/permissions/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));

  const workspace = await c.env.DB.prepare("SELECT id FROM core_workspace WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  if (!workspace) throw new DoesNotExist("Workspace", id);

  const workspaceUser = await requireWorkspaceAccess(c.env.DB, user.id, id, VIEWER);

  return c.json(serializeWorkspacePermissions(user, workspaceUser));
});

// ── GET /api/workspaces/users/workspace/:id/ — Frontend members alias ───────
workspaces.get("/users/workspace/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));

  await requireWorkspaceAccess(c.env.DB, user.id, id, "EDITOR");

  const url = new URL(c.req.url);
  const sorts = parseWorkspaceMemberSorts(url.searchParams.get("sorts"));
  if (sorts.error) return c.json(workspaceMemberSortError(sorts.error), 400);
  const search = workspaceMemberSearchClause(url.searchParams.get("search"));

  return c.json(await listWorkspaceMembers(c.env.DB, id, search, sorts.orderBy));
});

// ── PATCH /api/workspaces/users/:workspaceUserId/ ───────────────────────────
workspaces.patch("/users/:workspaceUserId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceUserId = Number(c.req.param("workspaceUserId"));
  const body = await c.req.json<{ permissions?: string }>();

  const target = await c.env.DB.prepare("SELECT * FROM core_workspaceuser WHERE id = ?")
    .bind(workspaceUserId)
    .first<WorkspaceUserRow>();
  if (!target) throw new DoesNotExist("WorkspaceUser", workspaceUserId);

  await requireWorkspaceAccess(c.env.DB, user.id, target.workspace_id, ADMIN);

  if (body.permissions) {
    await c.env.DB.prepare("UPDATE core_workspaceuser SET permissions = ? WHERE id = ?")
      .bind(body.permissions, workspaceUserId)
      .run();
  }

  return c.json(await serializeWorkspaceUserById(c.env.DB, workspaceUserId));
});

// ── DELETE /api/workspaces/users/:workspaceUserId/ ──────────────────────────
workspaces.delete("/users/:workspaceUserId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceUserId = Number(c.req.param("workspaceUserId"));

  const target = await c.env.DB.prepare("SELECT * FROM core_workspaceuser WHERE id = ?")
    .bind(workspaceUserId)
    .first<WorkspaceUserRow>();
  if (!target) throw new DoesNotExist("WorkspaceUser", workspaceUserId);

  await requireWorkspaceAccess(c.env.DB, user.id, target.workspace_id, ADMIN);

  await c.env.DB.prepare("UPDATE core_workspaceuser SET to_be_deleted = 1 WHERE id = ?")
    .bind(workspaceUserId)
    .run();

  return c.json({});
});

// ── POST /api/workspaces/ — Create workspace ──────────────────────────────────
workspaces.post("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    throw new ValidationError("name is required.");
  }

  const now = new Date().toISOString();
  const wsResult = await c.env.DB.prepare(
    "INSERT INTO core_workspace (name, created_on) VALUES (?, ?) RETURNING id"
  )
    .bind(body.name.trim(), now)
    .first<{ id: number }>();

  if (!wsResult) throw new Error("Failed to create workspace");

  // Get max order for user
  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(wu.[order]), 0) as max_order FROM core_workspaceuser wu WHERE wu.user_id = ?`
  )
    .bind(user.id)
    .first<{ max_order: number }>();

  await c.env.DB.prepare(
    `INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted) VALUES (?, ?, ?, ?, 0)`
  )
    .bind(wsResult.id, user.id, (maxOrder?.max_order ?? 0) + 1, "ADMIN")
    .run();

  const workspace = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ? AND COALESCE(trashed, 0) = 0")
    .bind(wsResult.id)
    .first<WorkspaceRow>();

  await logAuditEntry(c.env.DB, "workspace.create", {
    user,
    workspace_id: wsResult.id,
    workspace_name: workspace?.name || body.name.trim(),
  }, { id: wsResult.id, type: "workspace" }, {
    workspace_id: wsResult.id,
    workspace_name: workspace?.name || body.name.trim(),
  });

  return c.json(await serializeWorkspace(c.env.DB, c.env.CACHE, workspace!, user.id), 200);
});

// ── POST /api/workspaces/order/ — Reorder workspaces for current user ───────
workspaces.post("/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ workspaces?: number[] }>();
  const ids = body.workspaces || [];

  const statements = ids.map((id, index) =>
    c.env.DB.prepare(
      `UPDATE core_workspaceuser SET [order] = ? WHERE user_id = ? AND workspace_id = ?`
    ).bind(index + 1, user.id, id)
  );

  if (statements.length > 0) await c.env.DB.batch(statements);

  return c.json({});
});

// ── POST /api/workspaces/create-initial-workspace/ ──────────────────────────
workspaces.post("/create-initial-workspace/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const now = new Date().toISOString();
  const workspace = await c.env.DB.prepare(
    "INSERT INTO core_workspace (name, created_on, storage_usage, seats_taken) VALUES (?, ?, 0, 1) RETURNING id"
  )
    .bind("My workspace", now)
    .first<{ id: number }>();

  if (!workspace) throw new Error("Failed to create initial workspace");

  const maxOrder = await c.env.DB.prepare(
    `SELECT COALESCE(MAX([order]), 0) AS max_order FROM core_workspaceuser WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{ max_order: number }>();

  await c.env.DB.prepare(
    `INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted)
     VALUES (?, ?, ?, 'ADMIN', 0)`
  )
    .bind(workspace.id, user.id, (maxOrder?.max_order || 0) + 1)
    .run();

  const created = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ?")
    .bind(workspace.id)
    .first<WorkspaceRow>();

  await logAuditEntry(c.env.DB, "workspace.create", {
    user,
    workspace_id: workspace.id,
    workspace_name: created?.name || "My workspace",
  }, { id: workspace.id, type: "workspace" }, {
    workspace_id: workspace.id,
    workspace_name: created?.name || "My workspace",
    initial: true,
  });

  return c.json(await serializeWorkspace(c.env.DB, c.env.CACHE, created!, user.id));
});

// ── GET /api/workspaces/:id/ ──────────────────────────────────────────────────
workspaces.get("/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));

  await requireWorkspaceAccess(c.env.DB, user.id, id, "VIEWER");

  const workspace = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ? AND COALESCE(trashed, 0) = 0")
    .bind(id)
    .first<WorkspaceRow>();

  if (!workspace) throw new DoesNotExist("Workspace", id);

  return c.json(await serializeWorkspace(c.env.DB, c.env.CACHE, workspace, user.id));
});

// ── PATCH /api/workspaces/:id/ — Update workspace ────────────────────────────
workspaces.patch("/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<{ name?: string }>();

  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  const before = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ?")
    .bind(id)
    .first<WorkspaceRow>();

  if (body.name !== undefined) {
    await c.env.DB.prepare("UPDATE core_workspace SET name = ? WHERE id = ?")
      .bind(body.name.trim(), id)
      .run();
  }

  const workspace = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ?")
    .bind(id)
    .first<WorkspaceRow>();

  await logAuditEntry(c.env.DB, "workspace.update", {
    user,
    workspace_id: id,
    workspace_name: workspace?.name || body.name || "",
  }, { id, type: "workspace" }, {
    workspace_id: id,
    workspace_name: workspace?.name || body.name || "",
    before: body.name !== undefined ? { name: before?.name } : {},
    after: body.name !== undefined ? { name: workspace?.name } : {},
  });

  return c.json(await serializeWorkspace(c.env.DB, c.env.CACHE, workspace!, user.id));
});

// ── DELETE /api/workspaces/:id/ ──────────────────────────────────────────────
workspaces.delete("/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));

  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  const workspace = await c.env.DB.prepare("SELECT id, name FROM core_workspace WHERE id=? AND COALESCE(trashed, 0)=0")
    .bind(id)
    .first<{ id: number; name: string }>();
  if (!workspace) throw new DoesNotExist("Workspace", id);

  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE core_workspace SET trashed = 1 WHERE id = ?").bind(id),
    c.env.DB.prepare(
      `UPDATE core_application SET trashed=1, updated_on=?
       WHERE workspace_id=?
         AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=core_application.id)`
    ).bind(now, id),
  ]);
  await recordTrashEntry(c.env.DB, {
    userId: user.id,
    workspaceId: id,
    applicationId: null,
    trashItemType: "workspace",
    trashItemId: id,
    name: workspace.name,
    trashedAt: now,
  });
  await logAuditEntry(c.env.DB, "workspace.delete", {
    user,
    workspace_id: id,
    workspace_name: workspace.name,
  }, { id, type: "workspace" }, {
    workspace_id: id,
    workspace_name: workspace.name,
  });

  return c.json({});
});

workspaces.post("/:id/export/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  await requireWorkspaceAccess(c.env.DB, user.id, id, VIEWER);
  const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  if (body.only_structure !== undefined && typeof body.only_structure !== "boolean") {
    throw new ValidationError("only_structure must be a boolean.");
  }
  if (body.application_ids !== undefined && body.application_ids !== null && !Array.isArray(body.application_ids)) {
    throw new ValidationError("application_ids must be a list of application ids.");
  }
  const applications = await workspaceExportApplicationRows(c.env.DB, id, body);
  const requestedApplicationIds = Array.isArray(body.application_ids)
    ? body.application_ids.map(Number)
    : [];
  const resolvedApplicationIds: number[] = [];
  for (const application of applications) {
    try {
      await assertHasApplicationRole(c.env.DB, user.id, Number(application.id), VIEWER);
      resolvedApplicationIds.push(Number(application.id));
    } catch (error) {
      if (requestedApplicationIds.length > 0 || !(error instanceof PermissionError)) throw error;
    }
  }
  const running = await c.env.DB.prepare(
    `SELECT id FROM core_job
      WHERE user_id=? AND type='export_applications'
        AND status NOT IN ('finished', 'failed', 'cancelled')
      LIMIT 1`
  ).bind(user.id).first<{ id: number }>();
  if (running) {
    throw new ApiError(400, "ERROR_MAX_JOB_COUNT_EXCEEDED", "A workspace export job is already running.");
  }
  const resourceId = crypto.randomUUID();
  const exportedFileName = `export_${resourceId}.zip`;
  const key = `workspace-exports/${id}/${resourceId}.zip`;
  const now = new Date().toISOString();
  const url = await buildFileUrl(c.env, key, id);
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (user_id, type, status, progress_percentage, created_on, updated_on, expires_at, result)
     VALUES (?, 'export_applications', 'pending', 0, ?, ?, ?, ?) RETURNING *`
  ).bind(
    user.id,
    now,
    now,
    new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    JSON.stringify({
      workspace_id: id,
      application_ids: requestedApplicationIds,
      only_structure: body.only_structure === true,
      exported_file_name: exportedFileName,
      exported_file_key: key,
      url,
    })
  ).first<any>();
  if (!job) throw new Error("Failed to create workspace export job");
  await c.env.JOBS_QUEUE.send({
    job_id: Number(job.id),
    job_type: "export_applications",
    payload: {
      workspace_id: id,
      application_ids: resolvedApplicationIds,
      application_ids_resolved: true,
      only_structure: body.only_structure === true,
      key,
      exported_file_name: exportedFileName,
    },
    user_id: user.id,
    workspace_id: id,
  });
  const current = await c.env.DB.prepare("SELECT * FROM core_job WHERE id=?").bind(job.id).first<any>();
  return c.json(serializeWorkspaceImportJob(current || job), 202);
});

workspaces.get("/:id/export/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  await requireWorkspaceAccess(c.env.DB, user.id, id, VIEWER);
  const jobs = await c.env.DB.prepare(
    `SELECT * FROM core_job
     WHERE user_id=? AND status='finished'
       AND type IN ('export_applications', 'workspace_export')
       AND CAST(json_extract(COALESCE(result, '{}'), '$.workspace_id') AS INTEGER)=?
       AND (expires_at IS NULL OR expires_at>?)
     ORDER BY updated_on DESC, id DESC LIMIT 5`
  ).bind(user.id, id, new Date().toISOString()).all<any>();
  const results = (jobs.results || []).map((job) => {
    const result = job.result ? JSON.parse(job.result) : {};
    return {
      id: job.id,
      job_id: job.id,
      type: "export_applications",
      state: job.status,
      status: job.status,
      progress_percentage: job.progress_percentage,
      created_on: job.created_on,
      updated_on: job.updated_on,
      ...result,
    };
  });
  return c.json({ results });
});

workspaces.post("/:id/import/upload-file/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) throw new ValidationError("file is required.");
  const maxSize = userFileUploadSizeLimitBytes(c.env);
  if (file.size > maxSize) {
    throw new ApiError(400, "ERROR_FILE_SIZE_TOO_LARGE", `The provided file is too large. The maximum size is ${Math.floor(maxSize / (1024 * 1024))} MB.`);
  }
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZipBytes(header)) {
    throw new ValidationError("The provided file is not a valid ZIP workspace export.");
  }
  const resourceId = crypto.randomUUID();
  const key = `workspace-imports/${id}/${resourceId}-${file.name}`;
  const [storageStream, validationStream] = file.stream().tee();
  const upload = c.env.FILES.put(key, storageStream, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { resource_id: resourceId, user_id: String(user.id), workspace_id: String(id) },
  });
  try {
    await validateWorkspaceExportPackageStream(validationStream);
    await upload;
  } catch (error) {
    await upload.catch(() => undefined);
    await c.env.FILES.delete(key).catch(() => undefined);
    throw error;
  }
  return c.json({
    id: resourceId,
    resource_id: resourceId,
    name: file.name,
    size: file.size,
    mime_type: file.type || "application/octet-stream",
    key,
  });
});

workspaces.post("/:id/import/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  const body = await c.req.json<{ resource_id?: string; application_ids?: number[] }>();
  if (!body.resource_id) throw new ValidationError("resource_id is required.");
  await findWorkspaceImportObject(c.env, id, body.resource_id);
  const running = await c.env.DB.prepare(
    `SELECT id FROM core_job
      WHERE user_id=? AND type IN ('import_applications', 'workspace_import')
        AND status NOT IN ('finished', 'failed', 'cancelled')
      LIMIT 1`
  ).bind(user.id).first<{ id: number }>();
  if (running) {
    throw new ApiError(400, "ERROR_MAX_JOB_COUNT_EXCEEDED", "A workspace import job is already running.");
  }
  const now = new Date().toISOString();
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (user_id, type, status, progress_percentage, created_on, updated_on, result)
     VALUES (?, 'import_applications', 'pending', 0, ?, ?, ?) RETURNING *`
  ).bind(user.id, now, now, JSON.stringify({
    workspace_id: id,
    resource_id: body.resource_id,
    application_ids: body.application_ids || [],
  })).first<any>();
  if (!job) throw new Error("Failed to create workspace import job");
  await c.env.JOBS_QUEUE.send({
    job_id: Number(job.id),
    job_type: "import_applications",
    payload: {
      workspace_id: id,
      resource_id: body.resource_id,
      application_ids: body.application_ids || [],
    },
    user_id: user.id,
    workspace_id: id,
  });
  const current = await c.env.DB.prepare("SELECT * FROM core_job WHERE id=?").bind(job.id).first<any>();
  return c.json(serializeWorkspaceImportJob(current || job), 202);
});

workspaces.delete("/:id/import/:resourceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const resourceId = c.req.param("resourceId");
  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  const { key } = await findWorkspaceImportObject(c.env, id, resourceId);
  await c.env.FILES.delete(key);
  return c.json({});
});

workspaces.get("/:id/settings/generative-ai/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  return c.json(await workspaceGenerativeAISettings(c.env.CACHE, id));
});

workspaces.patch("/:id/settings/generative-ai/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  const body = normalizeGenerativeAISettings(await c.req.json<Record<string, unknown>>());
  const before = await c.env.CACHE.get(`workspace:${id}:generative-ai`);
  await c.env.CACHE.put(`workspace:${id}:generative-ai`, JSON.stringify(body));
  await logAuditEntry(c.env.DB, "workspace.generative_ai_settings.update", {
    user,
    workspace_id: id,
    workspace_name: await getWorkspaceName(c.env.DB, id),
  }, { id, type: "workspace" }, {
    workspace_id: id,
    before: parseJsonOrNull(before),
    after: body,
  });
  const workspace = await c.env.DB.prepare("SELECT id, name, created_on, trashed FROM core_workspace WHERE id=?")
    .bind(id)
    .first<WorkspaceRow>();
  if (!workspace) throw new DoesNotExist("Workspace", id);
  return c.json(await serializeWorkspace(c.env.DB, c.env.CACHE, workspace, user.id));
});

// ── POST /api/workspaces/:id/leave/ ──────────────────────────────────────────
workspaces.post("/:id/leave/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));

  const wu = await getWorkspaceUser(c.env.DB, user.id, id);
  if (!wu) throw new DoesNotExist("WorkspaceUser");

  // Cannot leave if you're the last admin
  if (wu.permissions === "ADMIN") {
    const adminCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM core_workspaceuser WHERE workspace_id = ? AND permissions = 'ADMIN' AND to_be_deleted = 0"
    )
      .bind(id)
      .first<{ cnt: number }>();
    if ((adminCount?.cnt ?? 0) <= 1) {
      return c.json(
        { error: "CANNOT_LEAVE_WORKSPACE", detail: "You cannot leave as the only admin." },
        400
      );
    }
  }

  await c.env.DB.prepare("DELETE FROM core_workspaceuser WHERE user_id = ? AND workspace_id = ?")
    .bind(user.id, id)
    .run();
  await logAuditEntry(c.env.DB, "workspace.user.leave", {
    user,
    workspace_id: id,
    workspace_name: await getWorkspaceName(c.env.DB, id),
  }, { id: user.id, type: "workspace_user" }, {
    workspace_id: id,
    user_id: user.id,
    permissions: wu.permissions,
  });

  return c.json({});
});

// ── GET /api/workspaces/:id/invitations/ ─────────────────────────────────────
workspaces.get("/:id/invitations/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));

  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  const url = new URL(c.req.url);
  const sorts = parseInvitationSorts(url.searchParams.get("sorts"));
  if (sorts.error) return c.json(invitationSortError(sorts.error), 400);
  const search = invitationSearchClause(url.searchParams.get("search"));

  const invitations = await c.env.DB.prepare(
    `SELECT i.*, u.email as invited_by_email, u.first_name as invited_by_first_name
     FROM core_workspaceinvitation i
     JOIN auth_user u ON u.id = i.invited_by_id
     WHERE i.workspace_id = ?${search.sql}
     ORDER BY ${sorts.orderBy}`
  )
    .bind(id, ...search.binds)
    .all<any>();

  return c.json(
    (invitations.results || []).map((i: any) => ({
      id: i.id,
      email: i.email,
      permissions: i.permissions,
      message: i.message,
      created_on: i.created_on,
      invited_by: {
        id: i.invited_by_id,
        email: i.invited_by_email,
        name: i.invited_by_first_name,
      },
      workspace: id,
    }))
  );
});

// ── GET /api/workspaces/invitations/workspace/:id/ — Frontend alias ─────────
workspaces.get("/invitations/workspace/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));

  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);
  const url = new URL(c.req.url);
  const sorts = parseInvitationSorts(url.searchParams.get("sorts"));
  if (sorts.error) return c.json(invitationSortError(sorts.error), 400);
  const search = invitationSearchClause(url.searchParams.get("search"));

  const invitations = await c.env.DB.prepare(
    `SELECT i.*, w.name AS workspace_name,
            u.email AS invited_by_email,
            u.first_name AS invited_by_first_name,
            u.last_name AS invited_by_last_name
     FROM core_workspaceinvitation i
     JOIN core_workspace w ON w.id = i.workspace_id
     JOIN auth_user u ON u.id = i.invited_by_id
     WHERE i.workspace_id = ?${search.sql}
     ORDER BY ${sorts.orderBy}`
  )
    .bind(id, ...search.binds)
    .all<any>();

  return c.json((invitations.results || []).map(serializeInvitation));
});

// ── POST /api/workspaces/:id/invitations/ — Invite user ──────────────────────
workspaces.post("/:id/invitations/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<{ email: string; permissions: string; message?: string }>();

  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);

  if (!body.email) throw new ValidationError("email is required.");
  const email = body.email.trim().toLowerCase();
  throwAccountCreationDecision(await accountCreationDecision(c.env.DB, email, user.id));

  const workspace = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ?")
    .bind(id)
    .first<WorkspaceRow>();
  if (!workspace) throw new DoesNotExist("Workspace", id);

  // Generate invitation token
  const token = await generateToken();
  const now = new Date().toISOString();

  // Check for existing invitation
  const existing = await c.env.DB.prepare(
    "SELECT id FROM core_workspaceinvitation WHERE workspace_id = ? AND email = ?"
  )
    .bind(id, email)
    .first<{ id: number }>();

  if (existing) {
    await c.env.DB.prepare(
      "UPDATE core_workspaceinvitation SET invited_by_id = ?, token = ?, permissions = ?, message = ?, created_on = ? WHERE id = ?"
    )
      .bind(user.id, token, body.permissions || "MEMBER", body.message || "", now, existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO core_workspaceinvitation (workspace_id, invited_by_id, email, permissions, message, token, created_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, user.id, email, body.permissions || "MEMBER", body.message || "", token, now)
      .run();
  }
  const loggedInvitation = await c.env.DB.prepare(
    "SELECT id FROM core_workspaceinvitation WHERE workspace_id = ? AND email = ?"
  ).bind(id, email).first<{ id: number }>();
  await logAuditEntry(c.env.DB, existing ? "workspace.invitation.update" : "workspace.invitation.create", {
    user,
    workspace_id: id,
    workspace_name: workspace.name,
  }, { id: loggedInvitation?.id ?? existing?.id ?? null, type: "workspace_invitation" }, {
    workspace_id: id,
    email,
    permissions: body.permissions || "MEMBER",
  });
  const invitedUserId = await getUserIdByEmail(c.env.DB, email);
  if (invitedUserId && loggedInvitation?.id) {
    await createDirectNotificationForUsers(c.env.DB, {
      type: "workspace_invitation_created",
      recipientIds: [invitedUserId],
      senderId: user.id,
      data: invitationNotificationData(loggedInvitation.id, workspace),
    });
  }

  const inviterUser = await c.env.DB.prepare("SELECT first_name, last_name FROM auth_user WHERE id = ?")
    .bind(user.id)
    .first<{ first_name: string; last_name: string }>();

  const inviterName = `${inviterUser?.first_name ?? ""} ${inviterUser?.last_name ?? ""}`.trim() || user.email;
  await sendWorkspaceInvitationEmail(c.env, email, inviterName, workspace.name, token, c.env.PUBLIC_URL || "");

  return c.json({ message: "Invitation sent.", email });
});

// ── POST /api/workspaces/invitations/workspace/:id/ — Frontend alias ────────
workspaces.post("/invitations/workspace/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ email: string; permissions?: string; message?: string; base_url?: string }>();

  await requireWorkspaceAccess(c.env.DB, user.id, id, ADMIN);

  if (!body.email) throw new ValidationError("email is required.");
  const email = body.email.trim().toLowerCase();
  throwAccountCreationDecision(await accountCreationDecision(c.env.DB, email, user.id));

  const workspace = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ?")
    .bind(id)
    .first<WorkspaceRow>();
  if (!workspace) throw new DoesNotExist("Workspace", id);

  const token = await generateToken();
  const now = new Date().toISOString();
  const permissions = body.permissions || MEMBER;

  const existing = await c.env.DB.prepare(
    "SELECT id FROM core_workspaceinvitation WHERE workspace_id = ? AND email = ?"
  )
    .bind(id, email)
    .first<{ id: number }>();

  if (existing) {
    await c.env.DB.prepare(
      "UPDATE core_workspaceinvitation SET invited_by_id = ?, token = ?, permissions = ?, message = ?, created_on = ? WHERE id = ?"
    )
      .bind(user.id, token, permissions, body.message || "", now, existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO core_workspaceinvitation (workspace_id, invited_by_id, email, permissions, message, token, created_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, user.id, email, permissions, body.message || "", token, now)
      .run();
  }

  const invitation = await c.env.DB.prepare(
    `SELECT i.*, w.name AS workspace_name,
            u.email AS invited_by_email,
            u.first_name AS invited_by_first_name,
            u.last_name AS invited_by_last_name
     FROM core_workspaceinvitation i
     JOIN core_workspace w ON w.id = i.workspace_id
     JOIN auth_user u ON u.id = i.invited_by_id
     WHERE i.workspace_id = ? AND i.email = ?`
  )
    .bind(id, email)
    .first<any>();

  const inviter = await c.env.DB.prepare("SELECT first_name, last_name, email FROM auth_user WHERE id = ?")
    .bind(user.id)
    .first<{ first_name: string; last_name: string; email: string }>();
  const inviterName =
    [inviter?.first_name, inviter?.last_name].filter(Boolean).join(" ") ||
    inviter?.email ||
    user.email;
  await sendWorkspaceInvitationEmail(c.env, email, inviterName, workspace.name, token, body.base_url || c.env.PUBLIC_WEB_FRONTEND_URL || c.env.PUBLIC_URL || "");
  await logAuditEntry(c.env.DB, existing ? "workspace.invitation.update" : "workspace.invitation.create", {
    user,
    workspace_id: id,
    workspace_name: workspace.name,
  }, { id: invitation?.id ?? existing?.id ?? null, type: "workspace_invitation" }, {
    workspace_id: id,
    email,
    permissions,
  });
  const invitedUserId = await getUserIdByEmail(c.env.DB, email);
  if (invitedUserId && invitation?.id) {
    await createDirectNotificationForUsers(c.env.DB, {
      type: "workspace_invitation_created",
      recipientIds: [invitedUserId],
      senderId: user.id,
      data: invitationNotificationData(invitation.id, workspace),
    });
  }

  return c.json(serializeInvitation(invitation), existing ? 200 : 201);
});

// ── GET /api/workspaces/invitations/token/:token/ ───────────────────────────
workspaces.get("/invitations/token/:token/", async (c) => {
  const token = c.req.param("token");
  const invitation = await c.env.DB.prepare(
    `SELECT i.*, w.name AS workspace_name,
            u.email AS invited_by_email,
            u.first_name AS invited_by_first_name,
            u.last_name AS invited_by_last_name,
            invited.id AS invited_user_id
     FROM core_workspaceinvitation i
     JOIN core_workspace w ON w.id = i.workspace_id
     JOIN auth_user u ON u.id = i.invited_by_id
     LEFT JOIN auth_user invited ON invited.email = i.email COLLATE NOCASE
     WHERE i.token = ?`
  )
    .bind(token)
    .first<any>();

  if (!invitation) throw new DoesNotExist("WorkspaceInvitation");

  // Baserow's public invitation serializer exposes the inviter and workspace as
  // display names, which the login and signup banners render directly.
  const inviterName = [invitation.invited_by_first_name, invitation.invited_by_last_name]
    .filter(Boolean)
    .join(" ") || invitation.invited_by_email;
  return c.json({
    ...serializeInvitation(invitation),
    invited_by: inviterName,
    workspace: invitation.workspace_name,
    email_exists: Boolean(invitation.invited_user_id),
  });
});

// ── POST /api/workspaces/invitations/:token/accept/ ──────────────────────────
workspaces.post("/invitations/:token/accept/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const token = c.req.param("token");

  const inv = await c.env.DB.prepare(
    "SELECT * FROM core_workspaceinvitation WHERE token = ? OR id = ?"
  )
    .bind(token, Number(token) || -1)
    .first<any>();

  if (!inv) {
    return c.json({
      error: "ERROR_GROUP_INVITATION_DOES_NOT_EXIST",
      detail: "The requested group invitation does not exist.",
    }, 404);
  }

  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    return c.json({
      error: "ERROR_GROUP_INVITATION_EMAIL_MISMATCH",
      detail: "Your email address does not match with the invitation.",
    }, 400);
  }

  // Check if already a member
  const existing = await getWorkspaceUser(c.env.DB, user.id, inv.workspace_id);
  if (existing) {
    await c.env.DB.prepare("UPDATE core_workspaceuser SET permissions = ?, to_be_deleted = 0 WHERE id = ?")
      .bind(inv.permissions, existing.id)
      .run();
  } else {
    const maxOrder = await c.env.DB.prepare(
      `SELECT COALESCE(MAX(wu.[order]), 0) as max_order FROM core_workspaceuser wu WHERE wu.user_id = ?`
    )
      .bind(user.id)
      .first<{ max_order: number }>();

    await c.env.DB.prepare(
      `INSERT INTO core_workspaceuser (workspace_id, user_id, [order], permissions, to_be_deleted) VALUES (?, ?, ?, ?, 0)`
    )
      .bind(inv.workspace_id, user.id, (maxOrder?.max_order ?? 0) + 1, inv.permissions)
      .run();
  }

  await markInvitationNotificationAsRead(c.env.DB, user.id, inv.id);
  await c.env.DB.prepare("DELETE FROM core_workspaceinvitation WHERE id = ?")
    .bind(inv.id)
    .run();

  const workspace = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ?")
    .bind(inv.workspace_id)
    .first<WorkspaceRow>();
  await logAuditEntry(c.env.DB, "workspace.invitation.accept", {
    user,
    workspace_id: inv.workspace_id,
    workspace_name: workspace?.name || "",
  }, { id: inv.id, type: "workspace_invitation" }, {
    workspace_id: inv.workspace_id,
    email: inv.email,
    permissions: inv.permissions,
    user_id: user.id,
  });
  if (workspace) {
    await createDirectNotificationForUsers(c.env.DB, {
      type: "workspace_invitation_accepted",
      recipientIds: [Number(inv.invited_by_id)],
      senderId: user.id,
      workspaceId: inv.workspace_id,
      data: invitationNotificationData(inv.id, workspace),
    });
  }

  return c.json(await serializeWorkspace(c.env.DB, c.env.CACHE, workspace!, user.id));
});

// ── PATCH /api/workspaces/invitations/:id/ ──────────────────────────────────
workspaces.patch("/invitations/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ permissions?: string; message?: string }>();
  const invitation = await getInvitationById(c.env.DB, id);

  await requireWorkspaceAccess(c.env.DB, user.id, invitation.workspace_id, ADMIN);

  const updates: string[] = [];
  const values: unknown[] = [];
  if (body.permissions !== undefined) {
    updates.push("permissions = ?");
    values.push(body.permissions);
  }
  if (body.message !== undefined) {
    updates.push("message = ?");
    values.push(body.message);
  }

  if (updates.length > 0) {
    values.push(id);
    await c.env.DB.prepare(`UPDATE core_workspaceinvitation SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  const updated = await c.env.DB.prepare(
    `SELECT i.*, w.name AS workspace_name,
            u.email AS invited_by_email,
            u.first_name AS invited_by_first_name,
            u.last_name AS invited_by_last_name
     FROM core_workspaceinvitation i
     JOIN core_workspace w ON w.id = i.workspace_id
     JOIN auth_user u ON u.id = i.invited_by_id
     WHERE i.id = ?`
  )
    .bind(id)
    .first<any>();
  await logAuditEntry(c.env.DB, "workspace.invitation.update", {
    user,
    workspace_id: invitation.workspace_id,
    workspace_name: updated?.workspace_name || await getWorkspaceName(c.env.DB, invitation.workspace_id),
  }, { id, type: "workspace_invitation" }, {
    workspace_id: invitation.workspace_id,
    email: invitation.email,
    before: { permissions: invitation.permissions, message: invitation.message },
    after: { permissions: updated?.permissions, message: updated?.message },
  });

  return c.json(serializeInvitation(updated));
});

// ── DELETE /api/workspaces/invitations/:id/ ─────────────────────────────────
workspaces.delete("/invitations/:id/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const invitation = await getInvitationById(c.env.DB, id);

  await requireWorkspaceAccess(c.env.DB, user.id, invitation.workspace_id, ADMIN);

  await c.env.DB.prepare("DELETE FROM core_workspaceinvitation WHERE id = ?")
    .bind(id)
    .run();
  await logAuditEntry(c.env.DB, "workspace.invitation.delete", {
    user,
    workspace_id: invitation.workspace_id,
    workspace_name: await getWorkspaceName(c.env.DB, invitation.workspace_id),
  }, { id, type: "workspace_invitation" }, {
    workspace_id: invitation.workspace_id,
    email: invitation.email,
    permissions: invitation.permissions,
  });

  return c.json({});
});

// ── POST /api/workspaces/invitations/:id/reject/ ────────────────────────────
workspaces.post("/invitations/:id/reject/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const invitation = await getInvitationById(c.env.DB, id);

  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new PermissionError("You cannot reject an invitation for another user.");
  }

  const workspace = await c.env.DB.prepare("SELECT * FROM core_workspace WHERE id = ?")
    .bind(invitation.workspace_id)
    .first<WorkspaceRow>();
  await markInvitationNotificationAsRead(c.env.DB, user.id, invitation.id);
  await c.env.DB.prepare("DELETE FROM core_workspaceinvitation WHERE id = ?")
    .bind(id)
    .run();
  await logAuditEntry(c.env.DB, "workspace.invitation.reject", {
    user,
    workspace_id: invitation.workspace_id,
    workspace_name: await getWorkspaceName(c.env.DB, invitation.workspace_id),
  }, { id, type: "workspace_invitation" }, {
    workspace_id: invitation.workspace_id,
    email: invitation.email,
    permissions: invitation.permissions,
  });
  if (workspace) {
    await createDirectNotificationForUsers(c.env.DB, {
      type: "workspace_invitation_rejected",
      recipientIds: [Number(invitation.invited_by_id)],
      senderId: user.id,
      workspaceId: invitation.workspace_id,
      data: invitationNotificationData(invitation.id, workspace),
    });
  }

  return c.json({});
});

// ── PATCH /api/workspaces/:id/users/:userId/ — Change user permissions ───────
workspaces.patch("/:id/users/:userId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = parseInt(c.req.param("id"));
  const targetUserId = parseInt(c.req.param("userId"));
  const body = await c.req.json<{ permissions: string }>();

  await requireWorkspaceAccess(c.env.DB, user.id, workspaceId, ADMIN);
  const before = await getWorkspaceUser(c.env.DB, targetUserId, workspaceId);

  await c.env.DB.prepare(
    "UPDATE core_workspaceuser SET permissions = ? WHERE workspace_id = ? AND user_id = ?"
  )
    .bind(body.permissions, workspaceId, targetUserId)
    .run();
  await logAuditEntry(c.env.DB, "workspace.user.update", {
    user,
    workspace_id: workspaceId,
    workspace_name: await getWorkspaceName(c.env.DB, workspaceId),
  }, { id: targetUserId, type: "workspace_user" }, {
    workspace_id: workspaceId,
    user_id: targetUserId,
    user_email: await getUserEmail(c.env.DB, targetUserId),
    before: { permissions: before?.permissions },
    after: { permissions: body.permissions },
  });

  return c.json({ message: "Permissions updated." });
});

// ── DELETE /api/workspaces/:id/users/:userId/ — Remove user from workspace ───
workspaces.delete("/:id/users/:userId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = parseInt(c.req.param("id"));
  const targetUserId = parseInt(c.req.param("userId"));

  await requireWorkspaceAccess(c.env.DB, user.id, workspaceId, ADMIN);
  const target = await getWorkspaceUser(c.env.DB, targetUserId, workspaceId);

  await c.env.DB.prepare(
    "DELETE FROM core_workspaceuser WHERE workspace_id = ? AND user_id = ?"
  )
    .bind(workspaceId, targetUserId)
    .run();
  await logAuditEntry(c.env.DB, "workspace.user.delete", {
    user,
    workspace_id: workspaceId,
    workspace_name: await getWorkspaceName(c.env.DB, workspaceId),
  }, { id: targetUserId, type: "workspace_user" }, {
    workspace_id: workspaceId,
    user_id: targetUserId,
    user_email: await getUserEmail(c.env.DB, targetUserId),
    permissions: target?.permissions,
  });

  return c.json({}, 200);
});

async function generateToken(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export { workspaces as workspaceRouter };
