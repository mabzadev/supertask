import { Hono } from "hono";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware } from "../../middleware/auth";
import { ApiError, ValidationError } from "../../middleware/error";
import {
  createDataSyncTable,
  listPropertiesForRequest,
  requireDataSyncAccess,
  requireDatabaseAccess,
  serializeDataSyncById,
  assertDataSyncTwoWaySupported,
  normalizePeriodicInterval,
  normalizePeriodicIntervalCount,
  nextPeriodicSync,
  hasActiveDataSyncJob,
  updateDataSyncSyncedProperties,
} from "../../services/data-sync";
import { logAuditEntry } from "../../services/audit-log";
import { assertHasTableRole } from "../../services/enterprise-permissions";

const r = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const ENTERPRISE_TO_INTERNAL_INTERVAL: Record<string, string | null> = {
  MANUAL: null,
  HOURLY: "hour",
  DAILY: "day",
};

function internalToEnterpriseInterval(value: unknown) {
  const interval = String(value || "").toLowerCase();
  if (interval === "hour") return "HOURLY";
  if (interval === "day") return "DAILY";
  return "MANUAL";
}

function normalizePeriodicWhen(value: unknown) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,6}))?$/);
  if (!match) throw new ValidationError("when must be a valid time.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new ValidationError("when must be a valid time.");
  }
  const base = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  return match[4] ? `${base}.${match[4].padEnd(6, "0")}` : base;
}

function serializePeriodicWhen(value: unknown, interval: string) {
  if (!value) return interval === "MANUAL" ? null : "00:00:00";
  return normalizePeriodicWhen(value);
}

function nextEnterprisePeriodicSync(interval: string | null, when: string | null, from = new Date()) {
  if (!interval || !when) return null;
  const normalized = normalizePeriodicWhen(when);
  const [hour, minute, secondPart] = normalized.split(":");
  const [second, fraction = ""] = secondPart.split(".");
  const millisecond = Number(fraction.padEnd(3, "0").slice(0, 3) || 0);
  const candidate = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    Number(hour),
    Number(minute),
    Number(second),
    millisecond,
  ));
  if (interval === "hour") {
    while (candidate <= from) candidate.setUTCHours(candidate.getUTCHours() + 1);
    return candidate.toISOString();
  }
  while (candidate <= from) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate.toISOString();
}

function serializePeriodicInterval(dataSync: any) {
  const interval = internalToEnterpriseInterval(dataSync.periodic_interval);
  return {
    interval,
    when: serializePeriodicWhen(dataSync.periodic_when, interval),
    automatically_deactivated: Boolean(dataSync.deactivated),
  };
}

async function assertLocalBaserowSourceTableAccess(db: D1Database, userId: number, body: Record<string, unknown>) {
  if (String(body.type || "") !== "local_baserow_table") return;
  const tableId = Number(body.source_table_id ?? body.local_baserow_table_id ?? body.table_id);
  if (!Number.isInteger(tableId) || tableId <= 0) return;
  const table = await db.prepare(
    `SELECT t.id, t.database_id, a.workspace_id
       FROM database_table t
       JOIN core_application a ON a.id=t.database_id
      WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
  ).bind(tableId).first<{ id: number; database_id: number; workspace_id: number }>();
  if (!table) return;
  await assertHasTableRole(db, userId, table, "VIEWER");
}

async function serializeTableWithDataSync(db: D1Database, table: any) {
  return {
    id: table.id,
    name: table.name,
    order: table.order,
    database_id: table.database_id,
    _generatedTableName: `database_table_${table.id}`,
    data_sync: table.data_sync_id ? await serializeDataSyncById(db, table.data_sync_id) : null,
  };
}

r.post("/properties/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<Record<string, unknown>>();
  await assertLocalBaserowSourceTableAccess(c.env.DB, user.id, body);
  const properties = await listPropertiesForRequest(body, c.env, c.env.DB);
  return c.json(properties);
});

r.get("/:dataSyncId/properties/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dataSync = await requireDataSyncAccess(c.env.DB, user.id, Number(c.req.param("dataSyncId")));
  const settings = dataSync.settings ? JSON.parse(dataSync.settings) : {};
  await assertLocalBaserowSourceTableAccess(c.env.DB, user.id, { ...settings, type: dataSync.type });
  return c.json(await listPropertiesForRequest({ ...settings, type: dataSync.type }, c.env, c.env.DB));
});

r.post("/database/:databaseId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const databaseId = Number(c.req.param("databaseId"));
  await requireDatabaseAccess(c.env.DB, user.id, databaseId, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  await assertLocalBaserowSourceTableAccess(c.env.DB, user.id, body);
  const table = await createDataSyncTable(c.env.DB, databaseId, body, c.env, user.id);
  const full = await c.env.DB.prepare("SELECT * FROM database_table WHERE id=?").bind(table.id).first<any>();
  return c.json(await serializeTableWithDataSync(c.env.DB, full));
});

r.get("/:dataSyncId/periodic-interval/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("dataSyncId"));
  const dataSync = await requireDataSyncAccess(c.env.DB, user.id, id);
  return c.json(serializePeriodicInterval(dataSync));
});

r.patch("/:dataSyncId/periodic-interval/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("dataSyncId"));
  const dataSync = await requireDataSyncAccess(c.env.DB, user.id, id, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  const enterpriseInterval = String(body.interval || "").trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(ENTERPRISE_TO_INTERNAL_INTERVAL, enterpriseInterval)) {
    throw new ValidationError("interval must be MANUAL, HOURLY or DAILY.");
  }
  const periodicWhen = normalizePeriodicWhen(body.when);
  const internalInterval = ENTERPRISE_TO_INTERNAL_INTERVAL[enterpriseInterval];
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE database_datasync
        SET periodic_interval=?,
            periodic_interval_count=1,
            periodic_when=?,
            next_periodic_sync=?,
            deactivated=0,
            deactivation_reason=NULL,
            updated_on=?
      WHERE id=?`
  ).bind(
    internalInterval,
    periodicWhen,
    nextEnterprisePeriodicSync(internalInterval, periodicWhen),
    now,
    id
  ).run();
  await logAuditEntry(c.env.DB, "update_periodic_data_sync_interval", {
    user,
    workspace_id: Number(dataSync.workspace_id || 0),
    workspace_name: dataSync.workspace_name || "",
    ip_address: c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || null,
  }, { id, type: "data_sync" }, {
    interval: enterpriseInterval,
    when: periodicWhen.split(".")[0],
    table_id: Number(dataSync.table_id),
    table_name: dataSync.table_name,
    database_id: Number(dataSync.database_id),
    database_name: dataSync.database_name || "",
    data_sync_id: id,
  });
  const updated = await c.env.DB.prepare("SELECT * FROM database_datasync WHERE id=?").bind(id).first<any>();
  return c.json(serializePeriodicInterval(updated));
});

r.get("/:dataSyncId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("dataSyncId"));
  await requireDataSyncAccess(c.env.DB, user.id, id);
  return c.json(await serializeDataSyncById(c.env.DB, id));
});

r.patch("/:dataSyncId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("dataSyncId"));
  await requireDataSyncAccess(c.env.DB, user.id, id, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  const current = await c.env.DB.prepare("SELECT * FROM database_datasync WHERE id=?").bind(id).first<any>();
  assertDataSyncTwoWaySupported(current.type, body.two_way_sync);
  const updates = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  const settings = { ...(current?.settings ? JSON.parse(current.settings) : {}), ...updates };
  await assertLocalBaserowSourceTableAccess(c.env.DB, user.id, { ...settings, type: current.type });
  const periodicInterval = body.periodic_interval === undefined
    ? current.periodic_interval
    : normalizePeriodicInterval(body.periodic_interval);
  const periodicIntervalCount = body.periodic_interval_count === undefined
    ? Number(current.periodic_interval_count || 1)
    : normalizePeriodicIntervalCount(body.periodic_interval_count);
  const twoWaySync = body.two_way_sync === undefined ? current.two_way_sync : body.two_way_sync ? 1 : 0;
  const resetTwoWayFailures = body.two_way_sync !== undefined && body.two_way_sync && !current.two_way_sync ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE database_datasync
        SET settings=?,
            auto_add_new_properties=?,
            two_way_sync=?,
            two_way_sync_consecutive_failures=CASE WHEN ? THEN 0 ELSE two_way_sync_consecutive_failures END,
            periodic_interval=?,
            periodic_interval_count=?,
            next_periodic_sync=?,
            deactivated=CASE WHEN ? IS NULL THEN 0 ELSE deactivated END,
            deactivation_reason=CASE WHEN ? IS NULL THEN NULL ELSE deactivation_reason END,
            updated_on=?
      WHERE id=?`
  ).bind(
    JSON.stringify(settings),
    body.auto_add_new_properties === undefined ? current.auto_add_new_properties : body.auto_add_new_properties ? 1 : 0,
    twoWaySync,
    resetTwoWayFailures,
    periodicInterval,
    periodicIntervalCount,
    nextPeriodicSync(periodicInterval, periodicIntervalCount),
    periodicInterval,
    periodicInterval,
    new Date().toISOString(),
    id
  ).run();
  await updateDataSyncSyncedProperties(c.env.DB, id, body.synced_properties, c.env);
  return c.json(await serializeDataSyncById(c.env.DB, id));
});

r.post("/:dataSyncId/sync/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("dataSyncId"));
  const dataSync = await requireDataSyncAccess(c.env.DB, user.id, id, "BUILDER");
  if (await hasActiveDataSyncJob(c.env.DB, id)) {
    throw new ApiError(400, "ERROR_MAX_JOB_COUNT_EXCEEDED", "The sync data sync job is already running.");
  }
  const now = new Date().toISOString();
  const serializedDataSync = await serializeDataSyncById(c.env.DB, id);
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on, result)
     VALUES ('sync_data_sync_table', 'pending', 0, ?, ?, ?, ?) RETURNING *`
  ).bind(user.id, now, now, JSON.stringify({ data_sync_id: id, data_sync: serializedDataSync })).first<any>();
  if (!job) throw new Error("Failed to create data sync job");
  await c.env.JOBS_QUEUE.send({
    job_id: job.id,
    job_type: "sync_data_sync_table",
    payload: { data_sync_id: id, datasync_id: id },
    user_id: user.id,
    workspace_id: Number(dataSync.workspace_id || 0),
  });
  return c.json({
    id: job.id,
    type: "sync_data_sync_table",
    state: "pending",
    status: "pending",
    progress_percentage: 0,
    human_readable_error: null,
    error: null,
    result: { data_sync_id: id, data_sync: serializedDataSync },
    data_sync_id: id,
    data_sync: serializedDataSync,
    user_id: user.id,
    created_on: now,
    updated_on: now,
  }, 202);
});

export { r as dataSyncRouter };
