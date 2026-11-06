import { Hono } from "hono";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware } from "../../middleware/auth";
import { DoesNotExist, ValidationError } from "../../middleware/error";
import { assertHasTableRole } from "../../services/enterprise-permissions";
import { createDirectNotificationForUsers } from "../../services/notifications";

const webhooks = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

interface WebhookEventConfig {
  event_type: string;
  fields?: number[];
  views?: number[];
}

interface WebhookFieldMeta {
  id: number;
  name: string;
}

const WEBHOOK_EVENT_TYPES = new Set([
  "rows.created",
  "rows.updated",
  "rows.deleted",
  "field.created",
  "field.updated",
  "field.deleted",
  "view.created",
  "view.updated",
  "view.deleted",
  "view.rows_entered",
]);
const WEBHOOK_REQUEST_METHODS = new Set(["POST", "GET", "PUT", "PATCH", "DELETE"]);
const WEBHOOK_MAX_RETRIES = 8;
const WEBHOOK_MAX_CONSECUTIVE_FAILURES = 8;
const WEBHOOK_BATCH_LIMIT = 5;
const WEBHOOK_MAX_PER_TABLE = 20;
const WEBHOOK_REQUEST_TIMEOUT_MS = 5000;
const WEBHOOK_DELIVERY_LEASE_MS = 8000;

interface WebhookDeliveryRow {
  id: number;
  webhook_id: number;
  event_id: string;
  event_type: string;
  payload: string;
  attempt: number;
}

function privateWebhookHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::" || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function validateWebhookUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 2000) throw new ValidationError("Invalid URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || privateWebhookHostname(parsed.hostname)) {
    throw new ValidationError("Invalid URL");
  }
  return raw;
}

function validateWebhookRequestMethod(value: unknown) {
  const method = String(value || "POST").toUpperCase();
  if (!WEBHOOK_REQUEST_METHODS.has(method)) throw new ValidationError("request_method is invalid.");
  return method;
}

function normalizedWebhookHeaders(value: unknown): Record<string, string> {
  const entries = Array.isArray(value)
    ? value.map((header) => [header?.name, header?.value] as const)
    : Object.entries(value && typeof value === "object" ? value as Record<string, unknown> : {});
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = typeof rawName === "string" ? rawName : "";
    const headerValue = typeof rawValue === "string" ? rawValue : "";
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new ValidationError(`The provided header name ${name} is invalid.`);
    }
    if (/[\r\n]/.test(headerValue)) {
      throw new ValidationError(`The provided header value ${headerValue} is invalid.`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function parseJsonValue(value: string | null | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function headerLines(headers: Record<string, unknown>): string {
  return Object.entries(headers || {})
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join("\r\n");
}

function formatJsonLike(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 4);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? {}, null, 4);
}

function truncateMiddle(value: string, maxLength = 100000): string {
  if (value.length <= maxLength) return value;
  const marker = "\n...(truncated)\n";
  const edge = Math.floor((maxLength - marker.length) / 2);
  return `${value.slice(0, edge)}${marker}${value.slice(value.length - edge)}`;
}

function formatWebhookRequest(method: string, url: string, headers: Record<string, unknown>, body: unknown): string {
  return `${method} ${url}\r\n${headerLines(headers)}\r\n\r\n${formatJsonLike(body)}`;
}

function formatWebhookResponse(headers: Record<string, unknown>, body: string): string {
  return `${headerLines(headers)}\r\n\r\n${formatJsonLike(body)}`;
}

async function getWebhookPayloadFields(db: D1Database, tableId: number): Promise<WebhookFieldMeta[]> {
  const rows = await db.prepare(
    `SELECT id, name FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY [order] ASC, id ASC`
  ).bind(tableId).all<WebhookFieldMeta>();
  return rows.results || [];
}

function remapWebhookRow(row: unknown, fields: WebhookFieldMeta[], useUserFieldNames: boolean): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const byId = new Map(fields.map((field) => [field.id, field]));
  const byName = new Map(fields.map((field) => [field.name, field]));
  const remapped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (key === "id" || key === "order") {
      remapped[key] = value;
      continue;
    }
    const fieldIdMatch = key.match(/^field_(\d+)$/);
    if (fieldIdMatch) {
      const field = byId.get(Number(fieldIdMatch[1]));
      remapped[useUserFieldNames && field ? field.name : key] = value;
      continue;
    }
    const field = byName.get(key);
    if (field) {
      remapped[useUserFieldNames ? key : `field_${field.id}`] = value;
      continue;
    }
    remapped[key] = value;
  }

  return remapped;
}

function remapWebhookFieldsList(values: unknown, fields: WebhookFieldMeta[], useUserFieldNames: boolean): unknown {
  if (!Array.isArray(values)) return values;
  const byId = new Map(fields.map((field) => [field.id, field]));
  const byName = new Map(fields.map((field) => [field.name, field]));

  return values.map((value) => {
    if (value === "id" || value === "order") return value;
    const text = String(value);
    const fieldIdMatch = text.match(/^field_(\d+)$/);
    if (fieldIdMatch) {
      const field = byId.get(Number(fieldIdMatch[1]));
      return useUserFieldNames && field ? field.name : text;
    }
    const field = byName.get(text);
    return field && !useUserFieldNames ? `field_${field.id}` : value;
  });
}

function remapWebhookPayload(
  payload: Record<string, unknown>,
  fields: WebhookFieldMeta[],
  useUserFieldNames: boolean
): Record<string, unknown> {
  const remapped: Record<string, unknown> = { ...payload };
  for (const key of ["items", "old_items", "rows"]) {
    if (Array.isArray(remapped[key])) {
      remapped[key] = (remapped[key] as unknown[]).map((row) => remapWebhookRow(row, fields, useUserFieldNames));
    }
  }
  remapped.fields = remapWebhookFieldsList(remapped.fields, fields, useUserFieldNames);
  return remapped;
}

async function requireTableAccess(db: D1Database, userId: number, tableId: number, requiredRole = "VIEWER") {
  const table = await db.prepare(
    `SELECT t.id, t.database_id, a.workspace_id FROM database_table t
     JOIN core_application a ON a.id = t.database_id
     WHERE t.id = ? AND t.trashed = 0`
  ).bind(tableId).first<any>();
  if (!table) throw new DoesNotExist("Table", tableId);
  await assertHasTableRole(db, userId, table, requiredRole);
  return table;
}

function serializeWebhook(w: any): object {
  let headers: Record<string, string> = {};
  try {
    const parsed = w.headers ? JSON.parse(w.headers) : [];
    headers = Array.isArray(parsed)
      ? Object.fromEntries(parsed.filter((header) => header?.name).map((header) => [header.name, String(header.value || "")]))
      : Object.fromEntries(Object.entries(parsed || {}).map(([name, value]) => [name, String(value)]));
  } catch {
    headers = {};
  }

  return {
    id: w.id,
    table_id: w.table_id,
    url: w.url,
    name: w.name,
    include_all_events: Boolean(w.include_all_events),
    active: Boolean(w.active),
    headers,
    events: w.events || [],
    event_config: w.event_config || (w.events || []).map((event_type: string) => ({ event_type })),
    calls: w.calls || [],
    request_method: w.request_method || "POST",
    failed_triggers: w.consecutive_trigger_failures || 0,
    failed_trigger: Boolean(w.failed_trigger),
    use_user_field_names: Boolean(w.use_user_field_names),
    created_on: w.created_on,
    updated_on: w.updated_on,
  };
}

async function getWebhookEvents(db: D1Database, webhookId: number): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT event_type FROM database_tablewebhookevent WHERE webhook_id=? ORDER BY id ASC"
  ).bind(webhookId).all<{ event_type: string }>();
  return (rows.results || []).map((row) => parseStoredEventConfig(row.event_type).event_type);
}

async function getWebhookEventConfig(db: D1Database, webhookId: number): Promise<WebhookEventConfig[]> {
  const rows = await db.prepare(
    "SELECT event_type FROM database_tablewebhookevent WHERE webhook_id=? ORDER BY id ASC"
  ).bind(webhookId).all<{ event_type: string }>();
  return (rows.results || []).map((row) => parseStoredEventConfig(row.event_type));
}

async function getWebhookCalls(db: D1Database, webhookId: number): Promise<object[]> {
  const rows = await db.prepare(
    `SELECT c.*, w.request_method
     FROM database_tablewebhookcall c
     JOIN database_tablewebhook w ON w.id = c.webhook_id
     WHERE c.webhook_id=?
     ORDER BY c.called_time DESC, c.id DESC
     LIMIT 10`
  ).bind(webhookId).all<any>();

  return (rows.results || []).map(serializeWebhookCall);
}

function serializeWebhookCall(call: any): object {
  const requestHeaders = parseJsonValue(call.request_headers, {}) as Record<string, unknown>;
  const requestBody = parseJsonValue(call.request_body, {});
  const responseHeaders = parseJsonValue(call.response_headers, {}) as Record<string, unknown>;
  const responseBody = call.response_body || "";
  const response = call.response_status === null || call.response_status === undefined
    ? ""
    : formatWebhookResponse(responseHeaders, responseBody);
  const storedDeliveryId = String(call.batch_id || "");
  const batchMatch = storedDeliveryId.match(/^(.*)#batch=(\d+)$/);

  return {
    id: call.id,
    event_id: batchMatch ? batchMatch[1] : storedDeliveryId || null,
    event_type: call.event_type,
    called_time: call.called_time,
    called_url: call.called_url,
    request: truncateMiddle(formatWebhookRequest(call.request_method || "POST", call.called_url, requestHeaders, requestBody)),
    response: truncateMiddle(response),
    response_status: call.response_status,
    error: call.error || "",
    duration: call.duration,
    request_headers: requestHeaders,
    request_body: requestBody,
    response_headers: responseHeaders,
    response_body: responseBody,
    success: Boolean(call.success),
    batch_id: batchMatch ? Number(batchMatch[2]) : null,
  };
}

async function getLatestWebhookCall(db: D1Database, webhookId: number): Promise<any | null> {
  return db.prepare(
    `SELECT c.*, w.request_method
     FROM database_tablewebhookcall c
     JOIN database_tablewebhook w ON w.id = c.webhook_id
     WHERE c.webhook_id=?
     ORDER BY c.called_time DESC, c.id DESC
     LIMIT 1`
  ).bind(webhookId).first<any>();
}

async function serializeWebhookFull(db: D1Database, webhook: any): Promise<object> {
  return serializeWebhook({
    ...webhook,
    events: await getWebhookEvents(db, webhook.id),
    event_config: await getWebhookEventConfig(db, webhook.id),
    calls: await getWebhookCalls(db, webhook.id),
  });
}

function webhookHeaders(headers: unknown): Headers {
  const result = new Headers({ "Content-Type": "application/json" });
  const parsed = Array.isArray(headers)
    ? headers
    : Object.entries((headers && typeof headers === "object") ? headers as Record<string, unknown> : {})
      .map(([name, value]) => ({ name, value }));
  for (const header of parsed) {
    if (header && typeof header.name === "string") result.set(header.name, String(header.value || ""));
  }
  return result;
}

function parseStoredEventConfig(value: string): WebhookEventConfig {
  if (value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.event_type === "string") {
        return normalizeEventConfig(parsed);
      }
    } catch {
      // Fall through to legacy string event support.
    }
  }
  return { event_type: value };
}

function normalizeIdList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : [];
}

function normalizeEventConfig(raw: Record<string, unknown>): WebhookEventConfig {
  const config: WebhookEventConfig = { event_type: String(raw.event_type || "") };
  const fields = normalizeIdList(raw.fields);
  const views = normalizeIdList(raw.views);
  if (fields.length > 0) config.fields = fields;
  if (Array.isArray(raw.views)) config.views = views;
  return config;
}

function storedEventConfig(config: WebhookEventConfig): string {
  if ((config.fields?.length || 0) === 0 && config.views === undefined) {
    return config.event_type;
  }
  return JSON.stringify(config);
}

function eventConfigForBody(body: Record<string, unknown>): WebhookEventConfig[] {
  const configs = Array.isArray(body.event_config)
    ? body.event_config
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map(normalizeEventConfig)
    : [];
  const byType = new Map(configs.filter((config) => config.event_type).map((config) => [config.event_type, config]));
  const events = Array.isArray(body.events) ? body.events.map(String).filter(Boolean) : [];
  for (const event_type of events) {
    if (!byType.has(event_type)) byType.set(event_type, { event_type });
  }
  return [...byType.values()];
}

async function validateWebhookEventConfig(db: D1Database, tableId: number, configs: WebhookEventConfig[]) {
  const invalidType = configs.find((config) => !WEBHOOK_EVENT_TYPES.has(config.event_type));
  if (invalidType) throw new ValidationError(`The webhook event type ${invalidType.event_type} is invalid.`);
  const fieldIds = [...new Set(configs.flatMap((config) => config.fields || []))];
  if (fieldIds.length > 0) {
    const rows = await db.prepare(
      `SELECT id FROM database_field
       WHERE table_id=? AND trashed=0 AND id IN (${fieldIds.map(() => "?").join(",")})`
    ).bind(tableId, ...fieldIds).all<{ id: number }>();
    const valid = new Set((rows.results || []).map((row) => Number(row.id)));
    const invalid = fieldIds.find((id) => !valid.has(id));
    if (invalid) throw new ValidationError(`Field ${invalid} does not belong to this table.`);
  }

  const viewIds = [...new Set(configs.flatMap((config) => config.views || []))];
  if (viewIds.length > 0) {
    const rows = await db.prepare(
      `SELECT id FROM database_view
       WHERE table_id=? AND trashed=0 AND id IN (${viewIds.map(() => "?").join(",")})`
    ).bind(tableId, ...viewIds).all<{ id: number }>();
    const valid = new Set((rows.results || []).map((row) => Number(row.id)));
    const invalid = viewIds.find((id) => !valid.has(id));
    if (invalid) throw new ValidationError(`View ${invalid} does not belong to this table.`);
  }
}

function webhookConfigMatches(config: WebhookEventConfig, eventType: string, payload: Record<string, unknown>): boolean {
  if (config.event_type !== eventType) return false;
  if (eventType === "rows.updated" && config.fields?.length) {
    const updatedFieldIds = normalizeIdList(payload.updated_field_ids);
    return updatedFieldIds.length === 0 ? false : config.fields.some((id) => updatedFieldIds.includes(id));
  }
  if (eventType === "view.rows_entered" && config.views?.length) {
    const viewId = Number(payload.view_id ?? (payload.view as { id?: unknown } | undefined)?.id);
    return Number.isInteger(viewId) && config.views.includes(viewId);
  }
  if (eventType === "view.rows_entered" && config.views !== undefined) return false;
  return true;
}

async function recordWebhookCall(
  env: Env,
  webhook: any,
  eventType: string,
  requestHeaders: Record<string, string>,
  requestBody: object,
  startedAt: number,
  response: Response | null,
  responseBody: string,
  error: string,
  eventId: string
) {
  const responseHeaders: Record<string, string> = {};
  response?.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const success = response ? response.status >= 200 && response.status <= 299 : false;

  const values = [
    new Date().toISOString(),
    Date.now() - startedAt,
    webhook.url,
    JSON.stringify(requestHeaders),
    JSON.stringify(requestBody),
    response?.status ?? null,
    JSON.stringify(responseHeaders),
    responseBody.slice(0, 10000),
    success ? 1 : 0,
    error,
  ];
  const existing = await env.DB.prepare(
    "SELECT id FROM database_tablewebhookcall WHERE webhook_id=? AND event_type=? AND batch_id=? LIMIT 1"
  ).bind(webhook.id, eventType, eventId).first<{ id: number }>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE database_tablewebhookcall
          SET called_time=?, duration=?, called_url=?, request_headers=?, request_body=?,
              response_status=?, response_headers=?, response_body=?, success=?, error=?
        WHERE id=?`
    ).bind(...values, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO database_tablewebhookcall
       (webhook_id, event_type, called_time, duration, called_url, request_headers,
        request_body, response_status, response_headers, response_body, success, error, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(webhook.id, eventType, ...values, eventId).run();
  }
  await env.DB.prepare(
    `DELETE FROM database_tablewebhookcall
      WHERE webhook_id=?
        AND id NOT IN (
          SELECT id FROM database_tablewebhookcall
           WHERE webhook_id=?
           ORDER BY called_time DESC, id DESC
           LIMIT 10
        )`
  ).bind(webhook.id, webhook.id).run();
}

async function resetWebhookFailures(env: Env, webhookId: number) {
  await env.DB.prepare(
    "UPDATE database_tablewebhook SET consecutive_trigger_failures=0, failed_trigger=0, updated_on=? WHERE id=?"
  ).bind(new Date().toISOString(), webhookId).run();
}

async function workspaceAdminsForWebhook(env: Env, webhookId: number) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT wu.user_id, a.workspace_id, t.database_id, w.table_id, w.name
       FROM database_tablewebhook w
       JOIN database_table t ON t.id=w.table_id
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspaceuser wu ON wu.workspace_id=a.workspace_id
      WHERE w.id=? AND wu.to_be_deleted=0 AND wu.permissions='ADMIN'`
  ).bind(webhookId).all<{ user_id: number; workspace_id: number; database_id: number; table_id: number; name: string }>();
  return rows.results || [];
}

async function finalizeWebhookFailure(env: Env, webhookId: number) {
  const webhook = await env.DB.prepare(
    "SELECT id, consecutive_trigger_failures FROM database_tablewebhook WHERE id=? AND active=1"
  ).bind(webhookId).first<{ id: number; consecutive_trigger_failures: number }>();
  if (!webhook) return;
  const failures = Number(webhook.consecutive_trigger_failures || 0);
  if (failures < WEBHOOK_MAX_CONSECUTIVE_FAILURES) {
    await env.DB.prepare(
      "UPDATE database_tablewebhook SET consecutive_trigger_failures=?, failed_trigger=1, updated_on=? WHERE id=?"
    ).bind(failures + 1, new Date().toISOString(), webhookId).run();
    return;
  }

  await env.DB.prepare(
    "UPDATE database_tablewebhook SET active=0, failed_trigger=1, updated_on=? WHERE id=?"
  ).bind(new Date().toISOString(), webhookId).run();
  const admins = await workspaceAdminsForWebhook(env, webhookId);
  const context = admins[0];
  if (!context) return;
  await createDirectNotificationForUsers(env.DB, {
    type: "webhook_deactivated",
    recipientIds: admins.map((admin) => Number(admin.user_id)),
    workspaceId: Number(context.workspace_id),
    data: {
      webhook_id: webhookId,
      table_id: Number(context.table_id),
      database_id: Number(context.database_id),
      webhook_name: context.name,
    },
  });
}

async function notifyWebhookPayloadTooLarge(env: Env, webhook: any, eventId: string) {
  const admins = await workspaceAdminsForWebhook(env, webhook.id);
  const context = admins[0];
  if (!context) return;
  await createDirectNotificationForUsers(env.DB, {
    type: "webhook_payload_too_large",
    recipientIds: admins.map((admin) => Number(admin.user_id)),
    workspaceId: Number(context.workspace_id),
    data: {
      webhook_id: webhook.id,
      table_id: Number(context.table_id),
      database_id: Number(context.database_id),
      webhook_name: context.name,
      event_id: eventId,
      batch_limit: WEBHOOK_BATCH_LIMIT,
    },
  });
}

async function callWebhook(env: Env, webhook: any, eventType: string, payload: object, fixedEventId?: string) {
  let headerRows: Array<{ name: string; value: string }> = [];
  try {
    headerRows = webhook.headers ? JSON.parse(webhook.headers) : [];
  } catch {
    headerRows = [];
  }

  const payloadRecord = payload as Record<string, unknown>;
  const payloadEventId = typeof payloadRecord.event_id === "string" ? payloadRecord.event_id : "";
  const eventId = fixedEventId || payloadEventId || crypto.randomUUID();
  const batchId = Number(payloadRecord.batch_id || 0);
  const callLogId = Number.isInteger(batchId) && batchId > 0 ? `${eventId}#batch=${batchId}` : eventId;
  const headers = webhookHeaders(headerRows);
  headers.set("X-Baserow-Event", eventType);
  headers.set("X-Baserow-Delivery", eventId);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  const body = {
    event_type: eventType,
    table_id: webhook.table_id,
    webhook_id: webhook.id,
    event_id: eventId,
    timestamp: new Date().toISOString(),
    ...payload,
  };

  const startedAt = Date.now();
  let response: Response | null = null;
  let responseBody = "";
  let error = "";
  const method = String(webhook.request_method || "POST").toUpperCase();
  const sentBody = method === "GET" ? undefined : JSON.stringify(body);
  try {
    response = await fetch(webhook.url, {
      method,
      headers,
      body: sentBody,
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
    });
    responseBody = await response.text();
  } catch (e: any) {
    error = e?.message || String(e);
  }

  await recordWebhookCall(env, webhook, eventType, requestHeaders, sentBody ? body : {}, startedAt, response, responseBody, error, callLogId);
  const success = Boolean(response && response.status >= 200 && response.status <= 299);
  if (success) await resetWebhookFailures(env, webhook.id);
  return { success, eventId };
}

async function tableWebhookContext(db: D1Database, tableId: number): Promise<{ database_id: number | null; workspace_id: number | null }> {
  const table = await db.prepare(
    `SELECT t.database_id, a.workspace_id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=?`
  ).bind(tableId).first<{ database_id: number; workspace_id: number }>();
  return {
    database_id: table?.database_id ?? null,
    workspace_id: table?.workspace_id ?? null,
  };
}

function webhookDeliveryKey(eventId: string, payload: Record<string, unknown>) {
  const batchId = Number(payload.batch_id || 0);
  return Number.isInteger(batchId) && batchId > 0 ? `${eventId}#batch=${batchId}` : eventId;
}

async function sendWebhookDispatchSignal(env: Env, webhook: any, delaySeconds = 0) {
  if (!env.JOBS_QUEUE) return;
  const context = await tableWebhookContext(env.DB, webhook.table_id);
  await env.JOBS_QUEUE.send({
    job_id: 0,
    job_type: "webhook_trigger",
    payload: { webhook_id: webhook.id, dispatch: true },
    user_id: Number(webhook.user_id || 0),
    workspace_id: Number(context.workspace_id || 0),
  }, delaySeconds > 0 ? { delaySeconds } : undefined);
}

async function enqueueWebhookDelivery(
  env: Env,
  webhook: any,
  eventType: string,
  payload: Record<string, unknown>,
  eventId: string
) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO database_tablewebhookdelivery
     (webhook_id, delivery_key, event_id, event_type, payload, attempt, status, queued_on, available_at)
     VALUES (?, ?, ?, ?, ?, 0, 'queued', ?, ?)`
  ).bind(
    webhook.id,
    webhookDeliveryKey(eventId, payload),
    eventId,
    eventType,
    JSON.stringify(payload),
    now,
    now
  ).run();
  try {
    await sendWebhookDispatchSignal(env, webhook);
  } catch (error) {
    console.error(`[WEBHOOK] Delivery ${eventId} was persisted but its Queue signal failed.`, error);
  }
}

async function claimNextWebhookDelivery(env: Env, webhookId: number): Promise<WebhookDeliveryRow | null> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE database_tablewebhookdelivery
        SET status='queued', lease_token=NULL, lease_expires_at=NULL, queued_on=?
      WHERE webhook_id=? AND status='processing' AND COALESCE(lease_expires_at, 0)<=?`
  ).bind(now, webhookId, now).run();
  const leaseToken = crypto.randomUUID();
  return env.DB.prepare(
    `UPDATE database_tablewebhookdelivery
        SET status='processing', lease_token=?, lease_expires_at=?
      WHERE id=(
        SELECT id FROM database_tablewebhookdelivery
         WHERE webhook_id=? AND status='queued' AND available_at<=?
           AND NOT EXISTS (
             SELECT 1 FROM database_tablewebhookdelivery
              WHERE webhook_id=? AND status='processing' AND COALESCE(lease_expires_at, 0)>?
           )
         ORDER BY queued_on ASC, id ASC
         LIMIT 1
      )
      RETURNING id, webhook_id, event_id, event_type, payload, attempt`
  ).bind(leaseToken, now + WEBHOOK_DELIVERY_LEASE_MS, webhookId, now, webhookId, now)
    .first<WebhookDeliveryRow>();
}

async function processNextWebhookDelivery(env: Env, webhookId: number) {
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    throw new ValidationError("The queued webhook trigger is invalid.");
  }
  const webhook = await env.DB.prepare(
    "SELECT * FROM database_tablewebhook WHERE id=? AND active=1"
  ).bind(webhookId).first<any>();
  if (!webhook) {
    await env.DB.prepare("DELETE FROM database_tablewebhookdelivery WHERE webhook_id=?").bind(webhookId).run();
    return { complete: true, skipped: true };
  }
  const delivery = await claimNextWebhookDelivery(env, webhookId);
  if (!delivery) return { complete: true, skipped: true };
  const eventPayload = parseJsonValue(delivery.payload, {}) as Record<string, unknown>;

  let result: { success: boolean; eventId: string };
  try {
    result = await callWebhook(env, webhook, delivery.event_type, eventPayload, delivery.event_id);
  } catch (error) {
    const retryAt = Date.now() + 1000;
    await env.DB.prepare(
      `UPDATE database_tablewebhookdelivery
          SET status='queued', available_at=?, queued_on=?, lease_token=NULL, lease_expires_at=NULL
        WHERE id=?`
    ).bind(retryAt, Date.now(), delivery.id).run();
    await sendWebhookDispatchSignal(env, webhook, 1);
    throw error;
  }

  if (result.success) {
    await env.DB.prepare("DELETE FROM database_tablewebhookdelivery WHERE id=?").bind(delivery.id).run();
  } else if (delivery.attempt < WEBHOOK_MAX_RETRIES) {
    const nextAttempt = delivery.attempt + 1;
    const delaySeconds = Math.min(2 ** delivery.attempt, 300);
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE database_tablewebhookdelivery
          SET attempt=?, status='queued', queued_on=?, available_at=?, lease_token=NULL, lease_expires_at=NULL
        WHERE id=?`
    ).bind(nextAttempt, now, now + delaySeconds * 1000, delivery.id).run();
    await sendWebhookDispatchSignal(env, webhook, delaySeconds);
  } else {
    await env.DB.prepare("DELETE FROM database_tablewebhookdelivery WHERE id=?").bind(delivery.id).run();
    await finalizeWebhookFailure(env, webhook.id);
  }

  await sendWebhookDispatchSignal(env, webhook);
  return { complete: result.success || delivery.attempt >= WEBHOOK_MAX_RETRIES, skipped: false };
}

export async function recoverWebhookDeliveryQueue(env: Env) {
  if (!env.JOBS_QUEUE) return 0;
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE database_tablewebhookdelivery
        SET status='queued', lease_token=NULL, lease_expires_at=NULL, queued_on=?
      WHERE status='processing' AND COALESCE(lease_expires_at, 0)<=?`
  ).bind(now, now).run();
  const rows = await env.DB.prepare(
    `SELECT DISTINCT w.id, w.table_id, w.user_id
       FROM database_tablewebhookdelivery d
       JOIN database_tablewebhook w ON w.id=d.webhook_id
      WHERE d.status='queued' AND d.available_at<=? AND w.active=1
      LIMIT 100`
  ).bind(now).all<any>();
  for (const webhook of rows.results || []) await sendWebhookDispatchSignal(env, webhook);
  return rows.results?.length || 0;
}

async function webhookShouldTrigger(db: D1Database, webhook: any, eventType: string, payload: Record<string, unknown>): Promise<boolean> {
  if (Boolean(webhook.include_all_events) && eventType !== "view.rows_entered") return true;
  const configs = await getWebhookEventConfig(db, webhook.id);
  return configs.some((config) => webhookConfigMatches(config, eventType, payload));
}

async function enqueueWebhookRetry(
  env: Env,
  webhook: any,
  eventType: string,
  payload: Record<string, unknown>,
  eventId: string,
  attempt: number
) {
  await env.JOBS_QUEUE.send({
    job_id: 0,
    job_type: "webhook_trigger",
    payload: {
      webhook_id: webhook.id,
      event_type: eventType,
      event_payload: payload,
      event_id: eventId,
      attempt,
    },
    user_id: Number(webhook.user_id || 0),
    workspace_id: Number((await tableWebhookContext(env.DB, webhook.table_id)).workspace_id || 0),
  }, { delaySeconds: Math.min(2 ** Math.max(0, attempt - 1), 300) });
}

export async function processWebhookTriggerQueueMessage(env: Env, payload: Record<string, unknown>) {
  const webhookId = Number(payload.webhook_id);
  if (payload.dispatch === true) return processNextWebhookDelivery(env, webhookId);
  const eventType = String(payload.event_type || "");
  const eventId = String(payload.event_id || "");
  const attempt = Math.max(1, Number(payload.attempt || 1));
  const eventPayload = payload.event_payload && typeof payload.event_payload === "object" && !Array.isArray(payload.event_payload)
    ? payload.event_payload as Record<string, unknown>
    : {};
  if (!Number.isInteger(webhookId) || webhookId <= 0 || !WEBHOOK_EVENT_TYPES.has(eventType) || !eventId) {
    throw new ValidationError("The queued webhook trigger is invalid.");
  }
  const webhook = await env.DB.prepare(
    "SELECT * FROM database_tablewebhook WHERE id=? AND active=1"
  ).bind(webhookId).first<any>();
  if (!webhook) return { complete: true, skipped: true };

  const result = await callWebhook(env, webhook, eventType, eventPayload, eventId);
  if (result.success) return { complete: true, skipped: false };
  if (attempt < WEBHOOK_MAX_RETRIES) {
    await enqueueWebhookRetry(env, webhook, eventType, eventPayload, eventId, attempt + 1);
    return { complete: false, skipped: false };
  }
  await finalizeWebhookFailure(env, webhook.id);
  return { complete: true, skipped: false };
}

/**
 * Views of the table that an active webhook watches for `view.rows_entered`:
 * `"all"` when a subscription has no view list, `null` when none does. Lets row
 * writes skip computing view membership, which reads the whole table per view.
 */
export async function rowsEnteredWebhookViewIds(db: D1Database, tableId: number): Promise<Set<number> | "all" | null> {
  const rows = await db.prepare(
    `SELECT e.event_type
     FROM database_tablewebhookevent e
     JOIN database_tablewebhook w ON w.id = e.webhook_id
     WHERE w.table_id = ? AND w.active = 1`
  ).bind(tableId).all<{ event_type: string }>();
  const viewIds = new Set<number>();
  for (const row of rows.results || []) {
    const config = parseStoredEventConfig(row.event_type);
    if (config.event_type !== "view.rows_entered") continue;
    if (config.views === undefined) return "all";
    config.views.forEach((id) => viewIds.add(Number(id)));
  }
  return viewIds.size > 0 ? viewIds : null;
}

export async function triggerTableWebhooks(env: Env, tableId: number, eventType: string, payload: Record<string, unknown> = {}) {
  const rows = await env.DB.prepare(
    `SELECT w.*
     FROM database_tablewebhook w
     WHERE w.table_id=? AND w.active=1`
  ).bind(tableId).all<any>();

  if (!rows.results?.length) return;
  const context = await tableWebhookContext(env.DB, tableId);
  const body = {
    database_id: context.database_id,
    workspace_id: context.workspace_id,
    ...payload,
  };
  const matching: any[] = [];
  for (const webhook of rows.results || []) {
    if (await webhookShouldTrigger(env.DB, webhook, eventType, body)) matching.push(webhook);
  }
  const batchId = Number(payload.batch_id || 0);
  if (Number.isInteger(batchId) && batchId > WEBHOOK_BATCH_LIMIT) {
    if (batchId === WEBHOOK_BATCH_LIMIT + 1) {
      const eventId = typeof payload.event_id === "string" ? payload.event_id : crypto.randomUUID();
      await Promise.all(matching.map((webhook) => notifyWebhookPayloadTooLarge(env, webhook, eventId)));
    }
    return;
  }
  const fields = matching.length > 0 ? await getWebhookPayloadFields(env.DB, tableId) : [];
  const eventId = typeof payload.event_id === "string" ? payload.event_id : crypto.randomUUID();
  await Promise.all(matching.map(async (webhook) => {
    const eventPayload = remapWebhookPayload(body, fields, Boolean(webhook.use_user_field_names));
    if (env.JOBS_QUEUE) {
      await enqueueWebhookDelivery(env, webhook, eventType, eventPayload, eventId);
      return;
    }
    const result = await callWebhook(env, webhook, eventType, eventPayload, eventId);
    if (result.success) return;
    if (!env.JOBS_QUEUE) {
      await finalizeWebhookFailure(env, webhook.id);
      return;
    }
    await enqueueWebhookRetry(env, webhook, eventType, eventPayload, result.eventId, 1);
  }));
}

// ── GET /api/database/webhooks/table/:tableId/ ────────────────────────────────
webhooks.get("/table/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  await requireTableAccess(c.env.DB, user.id, tableId, "VIEWER");

  const res = await c.env.DB.prepare(
    "SELECT * FROM database_tablewebhook WHERE table_id=?"
  ).bind(tableId).all<any>();

  const serialized = await Promise.all((res.results || []).map((webhook) => serializeWebhookFull(c.env.DB, webhook)));
  return c.json(serialized);
});

// ── POST /api/database/webhooks/table/:tableId/ ───────────────────────────────
webhooks.post("/table/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  await requireTableAccess(c.env.DB, user.id, tableId, "BUILDER");
  const body = await c.req.json<any>();

  const url = validateWebhookUrl(body.url);
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 255) {
    throw new ValidationError("name is required and must not exceed 255 characters.");
  }
  const requestMethod = validateWebhookRequestMethod(body.request_method);
  const headers = normalizedWebhookHeaders(body.headers);
  const eventConfig = eventConfigForBody(body);
  await validateWebhookEventConfig(c.env.DB, tableId, eventConfig);
  const webhookCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM database_tablewebhook WHERE table_id=?"
  ).bind(tableId).first<{ count: number }>();
  if (Number(webhookCount?.count || 0) >= WEBHOOK_MAX_PER_TABLE) {
    throw new ValidationError(`A table cannot have more than ${WEBHOOK_MAX_PER_TABLE} webhooks.`);
  }

  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    `INSERT INTO database_tablewebhook
     (table_id, user_id, url, name, include_all_events, active, headers,
      request_method, use_user_field_names, consecutive_trigger_failures, failed_trigger, created_on, updated_on)
     VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?) RETURNING *`
  ).bind(
    tableId,
    user.id,
    url,
    body.name,
    body.include_all_events ? 1 : 0,
    body.active === false ? 0 : 1,
    JSON.stringify(headers),
    requestMethod,
    body.use_user_field_names === false ? 0 : 1,
    now, now
  ).first<any>();

  if (!body.include_all_events && eventConfig.length > 0) {
    await c.env.DB.batch(eventConfig.map((config) =>
      c.env.DB.prepare("INSERT INTO database_tablewebhookevent (webhook_id, event_type) VALUES (?, ?)")
        .bind(res!.id, storedEventConfig(config))
    ));
  }

  return c.json(await serializeWebhookFull(c.env.DB, res!), 200);
});

// ── GET /api/database/webhooks/:webhookId/ ────────────────────────────────────
webhooks.get("/:webhookId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("webhookId"));
  const w = await c.env.DB.prepare("SELECT * FROM database_tablewebhook WHERE id=?")
    .bind(id).first<any>();
  if (!w) throw new DoesNotExist("Webhook", id);
  await requireTableAccess(c.env.DB, user.id, w.table_id, "VIEWER");
  return c.json(await serializeWebhookFull(c.env.DB, w));
});

// ── PATCH /api/database/webhooks/:webhookId/ ──────────────────────────────────
webhooks.patch("/:webhookId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("webhookId"));
  const w = await c.env.DB.prepare("SELECT * FROM database_tablewebhook WHERE id=?")
    .bind(id).first<any>();
  if (!w) throw new DoesNotExist("Webhook", id);
  await requireTableAccess(c.env.DB, user.id, w.table_id, "BUILDER");

  const body = await c.req.json<any>();
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.url !== undefined) { sets.push("url=?"); vals.push(validateWebhookUrl(body.url)); }
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 255) {
      throw new ValidationError("name must not be blank or exceed 255 characters.");
    }
    sets.push("name=?"); vals.push(body.name);
  }
  if (body.active !== undefined) { sets.push("active=?"); vals.push(body.active ? 1 : 0); }
  if (body.include_all_events !== undefined) { sets.push("include_all_events=?"); vals.push(body.include_all_events ? 1 : 0); }
  if (body.headers !== undefined) { sets.push("headers=?"); vals.push(JSON.stringify(normalizedWebhookHeaders(body.headers))); }
  if (body.use_user_field_names !== undefined) { sets.push("use_user_field_names=?"); vals.push(body.use_user_field_names ? 1 : 0); }
  if (body.request_method !== undefined) { sets.push("request_method=?"); vals.push(validateWebhookRequestMethod(body.request_method)); }

  if (sets.length > 0) {
    sets.push("updated_on=?");
    vals.push(new Date().toISOString());
    vals.push(id);
    await c.env.DB.prepare(`UPDATE database_tablewebhook SET ${sets.join(",")} WHERE id=?`)
      .bind(...vals).run();
  }

  if (body.events !== undefined || body.event_config !== undefined || body.include_all_events !== undefined) {
    const eventConfig = eventConfigForBody({
      events: body.events ?? await getWebhookEvents(c.env.DB, id),
      event_config: body.event_config ?? await getWebhookEventConfig(c.env.DB, id),
    });
    await validateWebhookEventConfig(c.env.DB, w.table_id, eventConfig);
    await c.env.DB.prepare("DELETE FROM database_tablewebhookevent WHERE webhook_id=?").bind(id).run();
    const includeAll = body.include_all_events !== undefined ? Boolean(body.include_all_events) : Boolean(w.include_all_events);
    if (!includeAll && eventConfig.length > 0) {
      await c.env.DB.batch(eventConfig.map((config) =>
        c.env.DB.prepare("INSERT INTO database_tablewebhookevent (webhook_id, event_type) VALUES (?, ?)")
          .bind(id, storedEventConfig(config))
      ));
    }
  }

  const updated = await c.env.DB.prepare("SELECT * FROM database_tablewebhook WHERE id=?")
    .bind(id).first<any>();
  return c.json(await serializeWebhookFull(c.env.DB, updated!));
});

// ── DELETE /api/database/webhooks/:webhookId/ ─────────────────────────────────
webhooks.delete("/:webhookId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("webhookId"));
  const w = await c.env.DB.prepare("SELECT * FROM database_tablewebhook WHERE id=?")
    .bind(id).first<any>();
  if (!w) throw new DoesNotExist("Webhook", id);
  await requireTableAccess(c.env.DB, user.id, w.table_id, "BUILDER");
  await c.env.DB.prepare("DELETE FROM database_tablewebhook WHERE id=?").bind(id).run();
  return c.json({});
});

// ── POST /api/database/webhooks/:webhookId/test/ ─────────────────────────────
webhooks.post("/:webhookId/test/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = parseInt(c.req.param("webhookId"));
  const w = await c.env.DB.prepare("SELECT * FROM database_tablewebhook WHERE id=?")
    .bind(id).first<any>();
  if (!w) throw new DoesNotExist("Webhook", id);
  await requireTableAccess(c.env.DB, user.id, w.table_id, "BUILDER");

  await callWebhook(c.env, w, "test", { webhook_id: id, rows: [] });

  return c.json(await serializeWebhookFull(c.env.DB, w), 200);
});

// ── POST /api/database/webhooks/table/:tableId/test-call/ ───────────────────
webhooks.post("/table/:tableId/test-call/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = parseInt(c.req.param("tableId"));
  await requireTableAccess(c.env.DB, user.id, tableId, "BUILDER");
  const body = await c.req.json<any>();

  const url = validateWebhookUrl(body.url);
  const eventType = String(body.event_type || "");
  if (!WEBHOOK_EVENT_TYPES.has(eventType)) throw new ValidationError("event_type is required and must be valid.");
  const requestMethod = validateWebhookRequestMethod(body.request_method);
  const headers = normalizedWebhookHeaders(body.headers);
  const now = new Date().toISOString();
  const webhook = {
    id: 0,
    table_id: tableId,
    user_id: user.id,
    url,
    name: body.name || "Test webhook",
    include_all_events: body.include_all_events ? 1 : 0,
    active: 1,
    headers: JSON.stringify(headers),
    request_method: requestMethod,
    use_user_field_names: body.use_user_field_names === false ? 0 : 1,
    consecutive_trigger_failures: 0,
    failed_trigger: 0,
    created_on: now,
    updated_on: now,
  };

  const saved = await c.env.DB.prepare(
    `INSERT INTO database_tablewebhook
     (table_id, user_id, url, name, include_all_events, active, headers,
      request_method, use_user_field_names, consecutive_trigger_failures, failed_trigger, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 0, ?, ?) RETURNING *`
  ).bind(
    tableId,
    user.id,
    webhook.url,
    webhook.name,
    webhook.include_all_events,
    webhook.headers,
    webhook.request_method,
    webhook.use_user_field_names,
    now,
    now
  ).first<any>();
  if (!saved) throw new Error("Failed to create temporary webhook");

  await callWebhook(c.env, saved, eventType, { rows: [] });
  const latestCall = await getLatestWebhookCall(c.env.DB, saved.id);
  await c.env.DB.prepare("DELETE FROM database_tablewebhook WHERE id=?").bind(saved.id).run();
  const serializedCall = latestCall ? serializeWebhookCall(latestCall) as any : null;
  return c.json({
    request: serializedCall?.request || "",
    response: serializedCall?.response || "",
    status_code: latestCall?.response_status ?? null,
    is_unreachable: latestCall?.response_status === null || latestCall?.response_status === undefined,
  }, 200);
});

export { webhooks as webhookRouter };
