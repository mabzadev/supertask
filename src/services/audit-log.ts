import type { Env, RequestUser } from "../types/env";

export interface AuditContext {
  user?: RequestUser | null;
  workspace_id?: number | null;
  workspace_name?: string | null;
  ip_address?: string | null;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  const escaped = str.replace(/"/g, '""');
  return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

export function mediaUrl(env: Env, key: string) {
  return `${env.PUBLIC_URL || "https://opentabl.mbza.workers.dev"}/media/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function userName(user?: RequestUser | null) {
  return user?.username || user?.email || "";
}

export async function logAuditEntry(
  db: D1Database,
  type: string,
  ctx: AuditContext,
  actionObject: { id?: number | null; type?: string | null } = {},
  actionParams: Record<string, unknown> = {}
) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO enterprise_auditlogentry
     (user_id, user_email, user_name, workspace_id, workspace_name, type, timestamp,
      ip_address, action_object_id, action_object_type, action_params)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    ctx.user?.id ?? null,
    ctx.user?.email ?? "",
    userName(ctx.user),
    ctx.workspace_id ?? null,
    ctx.workspace_name ?? "",
    type,
    now,
    ctx.ip_address ?? null,
    actionObject.id ?? null,
    actionObject.type ?? null,
    JSON.stringify(actionParams)
  ).run();
}

export function serializeAuditEntry(row: any) {
  const params = (() => {
    try {
      return row.action_params ? JSON.parse(row.action_params) : {};
    } catch {
      return {};
    }
  })();
  const user = row.user_id
    ? { id: row.user_id, name: row.user_name || row.user_email, email: row.user_email }
    : null;
  const workspace = row.workspace_id
    ? { id: row.workspace_id, name: row.workspace_name || `Workspace ${row.workspace_id}` }
    : null;
  return {
    id: row.id,
    user,
    user_id: row.user_id,
    user_email: row.user_email,
    user_name: row.user_name,
    workspace,
    workspace_id: row.workspace_id,
    workspace_name: row.workspace_name,
    type: row.type,
    description: describeAudit(row.type, params),
    timestamp: row.timestamp,
    ip_address: row.ip_address,
    action_object_id: row.action_object_id,
    action_object_type: row.action_object_type,
    action_params: params,
  };
}

export function describeAudit(type: string, params: Record<string, unknown>) {
  const tableName = params.table_name ? ` in ${params.table_name}` : "";
  const count = Number(params.count || 1);
  switch (type) {
    case "database.rows.create":
      return count === 1 ? `Created row${tableName}` : `Created ${count} rows${tableName}`;
    case "database.rows.update":
      return count === 1 ? `Updated row${tableName}` : `Updated ${count} rows${tableName}`;
    case "database.rows.move":
      return `Moved row${tableName}`;
    case "database.rows.delete":
      return count === 1 ? `Deleted row${tableName}` : `Deleted ${count} rows${tableName}`;
    case "workspace.create":
      return `Created workspace ${params.workspace_name || ""}`.trim();
    case "workspace.update":
      return `Updated workspace ${params.workspace_name || ""}`.trim();
    case "workspace.delete":
      return `Deleted workspace ${params.workspace_name || ""}`.trim();
    case "application.create":
      return `Created application ${params.application_name || ""}`.trim();
    case "application.update":
      return `Updated application ${params.application_name || ""}`.trim();
    case "application.delete":
      return `Deleted application ${params.application_name || ""}`.trim();
    case "database.table.create":
      return `Created table${tableName}`;
    case "database.table.update":
      return `Updated table${tableName}`;
    case "database.table.delete":
      return `Deleted table${tableName}`;
    case "database.field.create":
      return `Created field ${params.field_name || ""}${tableName}`.trim();
    case "database.field.update":
      return `Updated field ${params.field_name || ""}${tableName}`.trim();
    case "database.field.delete":
      return `Deleted field ${params.field_name || ""}${tableName}`.trim();
    case "database.view.create":
      return `Created view ${params.view_name || ""}${tableName}`.trim();
    case "database.view.update":
      return `Updated view ${params.view_name || ""}${tableName}`.trim();
    case "database.view.delete":
      return `Deleted view ${params.view_name || ""}${tableName}`.trim();
    case "enterprise.team.create":
      return `Created team ${params.team_name || ""}`.trim();
    case "enterprise.team.update":
      return `Updated team ${params.team_name || ""}`.trim();
    case "enterprise.team.delete":
      return `Deleted team ${params.team_name || ""}`.trim();
    case "enterprise.team_subject.create":
      return `Added team subject to ${params.team_name || "team"}`;
    case "enterprise.team_subject.delete":
      return `Removed team subject from ${params.team_name || "team"}`;
    case "enterprise.role_assignment.create":
      return `Assigned role ${params.role || ""}`.trim();
    case "enterprise.role_assignment.delete":
      return `Removed role assignment`;
    case "enterprise.field_permission.update":
      return `Updated field permission ${params.field_name || ""}`.trim();
    case "workspace.invitation.create":
      return `Created invitation for ${params.email || ""}`.trim();
    case "workspace.invitation.update":
      return `Updated invitation for ${params.email || ""}`.trim();
    case "workspace.invitation.delete":
      return `Deleted invitation for ${params.email || ""}`.trim();
    case "workspace.invitation.accept":
      return `Accepted invitation for ${params.email || ""}`.trim();
    case "workspace.invitation.reject":
      return `Rejected invitation for ${params.email || ""}`.trim();
    case "workspace.user.update":
      return `Updated workspace user permissions`;
    case "workspace.user.delete":
      return `Removed workspace user`;
    case "workspace.user.leave":
      return `Left workspace`;
    case "workspace.generative_ai_settings.update":
      return `Updated generative AI settings`;
    case "update_periodic_data_sync_interval":
      return `Updated periodic data sync interval`;
    case "auth.login":
      return `Logged in`;
    case "auth.two_factor_challenge":
      return `Started two factor authentication`;
    case "auth.token_refresh":
      return `Refreshed auth token`;
    case "auth.logout":
      return `Logged out`;
    case "user.create":
      return `Created user ${params.email || ""}`.trim();
    case "user.update":
      return `Updated user ${params.email || ""}`.trim();
    case "user.password.change":
      return `Changed user password`;
    case "user.password.reset_request":
      return `Requested password reset`;
    case "user.password.reset":
      return `Reset user password`;
    case "user.email_change.request":
      return `Requested email change`;
    case "user.email_change.confirm":
      return `Changed user email`;
    case "user.email_verification.request":
      return `Requested email verification`;
    case "user.email_verification.confirm":
      return `Verified user email`;
    case "user.account_deletion.schedule":
      return `Scheduled account deletion`;
    case "user.onboarding.update":
      return `Updated onboarding details`;
    case "admin.user.update":
      return `Admin updated user ${params.email || ""}`.trim();
    case "admin.user.delete":
      return `Admin deleted user ${params.email || ""}`.trim();
    case "admin.user.impersonate":
      return `Admin impersonated user ${params.target_user_id || ""}`.trim();
    case "admin.workspace.delete":
      return `Admin deleted workspace ${params.workspace_name || ""}`.trim();
    case "admin.settings.update":
      return `Updated instance settings`;
    case "admin.auth_provider.create":
      return `Created auth provider ${params.provider_type || ""}`.trim();
    case "admin.auth_provider.update":
      return `Updated auth provider ${params.provider_type || ""}`.trim();
    case "admin.auth_provider.delete":
      return `Deleted auth provider ${params.provider_type || ""}`.trim();
    case "job.create":
      return `Created job ${params.job_type || ""}`.trim();
    case "job.cancel":
      return `Cancelled job ${params.job_type || ""}`.trim();
    case "job.delete":
      return `Deleted job ${params.job_type || ""}`.trim();
    case "create_row_comment":
      return `Created row comment${tableName}`;
    case "update_row_comment":
      return `Updated row comment${tableName}`;
    case "delete_row_comment":
      return `Deleted row comment${tableName}`;
    default:
      return String(params.description || type);
  }
}

export function buildAuditCsv(rows: any[]) {
  const headers = ["id", "timestamp", "user_email", "workspace_name", "type", "description", "ip_address"];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    const serialized = serializeAuditEntry(row) as any;
    lines.push(headers.map((header) => csvCell(serialized[header])).join(","));
  }
  return lines.join("\n");
}
