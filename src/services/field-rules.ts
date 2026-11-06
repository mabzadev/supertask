import { DoesNotExist, ValidationError } from "../middleware/error";
import { ensureUserTableSystemColumns } from "./dynamic-tables";
import { encodeNumericStorageValue, numericStorageValue } from "./number-format";
import { assertHasTableRole } from "./enterprise-permissions";

export interface DateDependencyRule {
  id: number;
  table_id: number;
  type: "date_dependency";
  is_active: number;
  is_valid: number;
  error_text: string | null;
  settings: string;
  created_on: string;
  updated_on: string;
}

export interface RuleSettings {
  start_date_field_id?: number | null;
  end_date_field_id?: number | null;
  duration_field_id?: number | null;
  dependency_linkrow_field_id?: number | null;
  dependency_linkrow_role?: "predecessors" | "successors";
  dependency_connection_type?: "end-to-start" | "end-to-end" | "start-to-end" | "start-to-start";
  dependency_buffer_type?: "fixed" | "flexible" | "none";
  dependency_buffer?: number | null;
  include_weekends?: boolean;
}

const DATE_DEPENDENCY_FIELDS = [
  "start_date_field_id",
  "end_date_field_id",
  "duration_field_id",
  "dependency_linkrow_field_id",
  "dependency_linkrow_role",
  "dependency_connection_type",
  "dependency_buffer_type",
  "dependency_buffer",
  "include_weekends",
] as const;

const LINK_ROW_ROLES = new Set(["predecessors", "successors"]);
const CONNECTION_TYPES = new Set(["end-to-start", "end-to-end", "start-to-end", "start-to-start"]);
const BUFFER_TYPES = new Set(["fixed", "flexible", "none"]);
const DAY_SECONDS = 86400;

export async function getTableAccess(
  db: D1Database,
  userId: number,
  tableId: number,
  minPermission = "VIEWER"
) {
  const table = await db.prepare(
    `SELECT t.id, t.database_id, a.workspace_id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
  ).bind(tableId).first<{ id: number; database_id: number; workspace_id: number }>();
  if (!table) throw new DoesNotExist("Table", tableId);

  await assertHasTableRole(db, userId, table, minPermission === "MEMBER" ? "BUILDER" : minPermission);
  return table;
}

function parseSettings(rule: { settings?: string | null }): RuleSettings {
  try {
    return rule.settings ? JSON.parse(rule.settings) : {};
  } catch {
    return {};
  }
}

export function serializeFieldRule(rule: DateDependencyRule) {
  return {
    id: rule.id,
    table_id: rule.table_id,
    type: rule.type,
    is_active: Boolean(rule.is_active),
    is_valid: Boolean(rule.is_valid),
    error_text: rule.error_text,
    ...parseSettings(rule),
  };
}

function normalizeRuleSettings(input: Record<string, unknown>): RuleSettings {
  const settings: RuleSettings = {};
  for (const key of DATE_DEPENDENCY_FIELDS) {
    if (input[key] !== undefined) (settings as any)[key] = input[key];
  }
  settings.dependency_linkrow_role ||= "predecessors";
  settings.dependency_connection_type ||= "end-to-start";
  settings.dependency_buffer_type ||= "fixed";
  settings.dependency_buffer = Number(settings.dependency_buffer || 0);
  settings.include_weekends = input.include_weekends === undefined ? true : Boolean(input.include_weekends);
  if (!LINK_ROW_ROLES.has(String(settings.dependency_linkrow_role))) {
    throw new ValidationError("dependency_linkrow_role is invalid.");
  }
  if (!CONNECTION_TYPES.has(String(settings.dependency_connection_type))) {
    throw new ValidationError("dependency_connection_type is invalid.");
  }
  if (!BUFFER_TYPES.has(String(settings.dependency_buffer_type))) {
    throw new ValidationError("dependency_buffer_type is invalid.");
  }
  if (!Number.isFinite(settings.dependency_buffer) || Number(settings.dependency_buffer) < 0) {
    throw new ValidationError("dependency_buffer must be a positive duration.");
  }
  return settings;
}

async function requireFieldType(
  db: D1Database,
  tableId: number,
  fieldId: number | null | undefined,
  type: string,
  label: string
) {
  if (!fieldId) throw new ValidationError(`${label} is required.`);
  const field = await db.prepare(
    "SELECT id, type, read_only, field_settings FROM database_field WHERE id=? AND table_id=? AND trashed=0"
  ).bind(fieldId, tableId).first<{ id: number; type: string; read_only: number; field_settings: string | null }>();
  if (!field) throw new ValidationError(`${label} field does not exist.`);
  if (field.type !== type) throw new ValidationError(`${label} must be a ${type} field.`);
  if (field.read_only) throw new ValidationError(`${label} cannot be read-only.`);
  const settings = parseSettings({ settings: field.field_settings }) as Record<string, unknown>;
  if (type === "date" && settings.date_include_time === true) {
    throw new ValidationError(`${label} must not include time.`);
  }
  if (type === "duration" && settings.duration_format !== "d h") {
    throw new ValidationError(`${label} duration format must be 'd h'.`);
  }
  if (type === "link_row" && Number(settings.link_row_table_id || 0) !== tableId) {
    throw new ValidationError(`${label} must be self referencing.`);
  }
  return field;
}

async function validateDateDependencySettings(db: D1Database, tableId: number, settings: RuleSettings, active: boolean) {
  if (!active) return { isValid: true, errorText: null as string | null };
  try {
    await requireFieldType(db, tableId, settings.start_date_field_id, "date", "start_date_field_id");
    await requireFieldType(db, tableId, settings.end_date_field_id, "date", "end_date_field_id");
    await requireFieldType(db, tableId, settings.duration_field_id, "duration", "duration_field_id");
    if (settings.start_date_field_id === settings.end_date_field_id) {
      throw new ValidationError("start_date_field_id and end_date_field_id must be different.");
    }
    if (settings.dependency_linkrow_field_id) {
      await requireFieldType(db, tableId, settings.dependency_linkrow_field_id, "link_row", "dependency_linkrow_field_id");
    }
    return { isValid: true, errorText: null };
  } catch (e: any) {
    return { isValid: false, errorText: e.message || String(e) };
  }
}

function parseDate(value: unknown): Date | null {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateLike(original: unknown, date: Date) {
  return typeof original === "string" && !original.includes("T")
    ? date.toISOString().slice(0, 10)
    : date.toISOString();
}

function parseDurationDays(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = numericStorageValue(value);
  if (n === null || !Number.isInteger(n / DAY_SECONDS)) return null;
  return n / DAY_SECONDS;
}

function storedDuration(days: number | null): unknown {
  return days === null ? null : encodeNumericStorageValue(days * DAY_SECONDS);
}

export function calculateDateDependencyPatch(row: Record<string, unknown>, settings: RuleSettings, changed: Set<number>) {
  const startId = settings.start_date_field_id!;
  const endId = settings.end_date_field_id!;
  const durationId = settings.duration_field_id!;
  const startKey = `field_${startId}`;
  const endKey = `field_${endId}`;
  const durationKey = `field_${durationId}`;
  const start = parseDate(row[startKey]);
  const end = parseDate(row[endKey]);
  const durationSeconds = numericStorageValue(row[durationKey]);
  const durationDays = parseDurationDays(row[durationKey]);
  const patch: Record<string, unknown> = {};
  const changedRelevant = [startId, endId, durationId].filter((id) => changed.has(id));
  if (changedRelevant.length === 0) return patch;
  const valueCount = Number(Boolean(start)) + Number(Boolean(end)) + Number(durationDays !== null);
  if (valueCount < 2 || (changedRelevant.length === 3 && valueCount === 3)) return patch;

  if (changed.has(durationId) && durationSeconds !== null && durationSeconds < DAY_SECONDS) {
    patch[durationKey] = storedDuration(0);
    return patch;
  }
  if (changed.has(startId) && !start && end) {
    patch[durationKey] = null;
    return patch;
  }

  const setEnd = () => {
    if (!start || durationDays === null || durationDays < 1) return;
    const calculated = new Date(start);
    calculated.setUTCDate(calculated.getUTCDate() + durationDays - 1);
    patch[endKey] = formatDateLike(row[startKey], calculated);
  };
  const setStart = () => {
    if (!end || durationDays === null || durationDays < 1) return;
    const calculated = new Date(end);
    calculated.setUTCDate(calculated.getUTCDate() - durationDays + 1);
    patch[startKey] = formatDateLike(row[endKey], calculated);
  };
  const setDuration = () => {
    if (!start || !end || start > end) return;
    patch[durationKey] = storedDuration(Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  };

  if (changedRelevant.length === 1) {
    const fieldId = changedRelevant[0];
    if (fieldId === startId && start && durationDays !== null) setEnd();
    else if (fieldId === startId && start && end) setDuration();
    else if (fieldId === endId && end && start) {
      if (end < start) setStart();
      else setDuration();
    } else if (fieldId === durationId && durationDays !== null && start) setEnd();
    else if (fieldId === durationId && durationDays !== null && end) setStart();
  } else if (!changed.has(durationId) && start && end) {
    setDuration();
  } else if (!changed.has(startId) && durationDays !== null && end) {
    setStart();
  } else if (!changed.has(endId) && durationDays !== null && start) {
    setEnd();
  }

  return patch;
}

function rowIsValid(row: Record<string, unknown>, settings: RuleSettings) {
  const start = parseDate(row[`field_${settings.start_date_field_id}`]);
  const end = parseDate(row[`field_${settings.end_date_field_id}`]);
  const durationDays = parseDurationDays(row[`field_${settings.duration_field_id}`]);
  if (!start || !end || !durationDays || durationDays <= 0) return false;
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1 === durationDays;
}

function linkedRowIds(value: unknown): number[] {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map((item) => Number(item && typeof item === "object" ? (item as any).id : item))
    .filter((id) => Number.isInteger(id) && id > 0))];
}

function dependencyBufferDays(settings: RuleSettings): number {
  if (settings.dependency_buffer_type !== "flexible") return 0;
  return Math.max(0, Math.ceil(Number(settings.dependency_buffer || 0) / DAY_SECONDS));
}

function shiftedSchedule(row: Record<string, unknown>, settings: RuleSettings, start: Date): Record<string, unknown> | null {
  const durationDays = parseDurationDays(row[`field_${settings.duration_field_id}`]);
  if (durationDays === null || durationDays < 1) return null;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + durationDays - 1);
  return {
    [`field_${settings.start_date_field_id}`]: formatDateLike(row[`field_${settings.start_date_field_id}`], start),
    [`field_${settings.end_date_field_id}`]: formatDateLike(row[`field_${settings.end_date_field_id}`], end),
  };
}

async function cascadeDateDependencies(
  db: D1Database,
  tableId: number,
  rootRowId: number,
  settings: RuleSettings
): Promise<Map<number, Record<string, unknown>>> {
  const changed = new Map<number, Record<string, unknown>>();
  const linkFieldId = Number(settings.dependency_linkrow_field_id || 0);
  if (!linkFieldId || settings.dependency_buffer_type === "none") return changed;
  const result = await db.prepare(`SELECT * FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0`).all<Record<string, unknown>>();
  const rows = new Map((result.results || []).map((row) => [Number(row.id), { ...row }]));
  const children = new Map<number, number[]>();
  const parents = new Map<number, number[]>();
  for (const row of rows.values()) {
    const relations = linkedRowIds(row[`field_${linkFieldId}`]);
    for (const relatedId of relations) {
      const parentId = settings.dependency_linkrow_role === "successors" ? Number(row.id) : relatedId;
      const childId = settings.dependency_linkrow_role === "successors" ? relatedId : Number(row.id);
      if (!rows.has(parentId) || !rows.has(childId)) continue;
      children.set(parentId, [...(children.get(parentId) || []), childId]);
      parents.set(childId, [...(parents.get(childId) || []), parentId]);
    }
  }
  const bufferDays = dependencyBufferDays(settings);
  const ancestorsVisited = new Set([rootRowId]);
  const ancestorQueue = [rootRowId];
  while (ancestorQueue.length > 0) {
    const childId = ancestorQueue.shift()!;
    const child = rows.get(childId)!;
    const childStart = parseDate(child[`field_${settings.start_date_field_id}`]);
    if (!childStart) continue;
    for (const parentId of parents.get(childId) || []) {
      if (ancestorsVisited.has(parentId)) continue;
      ancestorsVisited.add(parentId);
      const parent = rows.get(parentId)!;
      const parentEnd = parseDate(parent[`field_${settings.end_date_field_id}`]);
      if (!parentEnd || parseDurationDays(parent[`field_${settings.duration_field_id}`]) === null) continue;
      const requiredEnd = new Date(childStart);
      requiredEnd.setUTCDate(requiredEnd.getUTCDate() - bufferDays - 1);
      if (parentEnd <= requiredEnd) continue;
      const durationDays = parseDurationDays(parent[`field_${settings.duration_field_id}`])!;
      const newStart = new Date(requiredEnd);
      newStart.setUTCDate(newStart.getUTCDate() - durationDays + 1);
      const patch = {
        [`field_${settings.start_date_field_id}`]: formatDateLike(parent[`field_${settings.start_date_field_id}`], newStart),
        [`field_${settings.end_date_field_id}`]: formatDateLike(parent[`field_${settings.end_date_field_id}`], requiredEnd),
      };
      Object.assign(parent, patch);
      changed.set(parentId, patch);
      ancestorQueue.push(parentId);
    }
  }
  const descendantsVisited = new Set([rootRowId]);
  const descendantQueue = [rootRowId];
  while (descendantQueue.length > 0) {
    const parentId = descendantQueue.shift()!;
    const parent = rows.get(parentId)!;
    const parentEnd = parseDate(parent[`field_${settings.end_date_field_id}`]);
    if (!parentEnd) continue;
    for (const childId of children.get(parentId) || []) {
      if (descendantsVisited.has(childId)) continue;
      descendantsVisited.add(childId);
      const child = rows.get(childId)!;
      const childStart = parseDate(child[`field_${settings.start_date_field_id}`]);
      if (!childStart || !rowIsValid(child, settings)) continue;
      const requiredStart = new Date(parentEnd);
      requiredStart.setUTCDate(requiredStart.getUTCDate() + bufferDays + 1);
      if (childStart >= requiredStart) continue;
      const patch = shiftedSchedule(child, settings, requiredStart);
      if (!patch) continue;
      Object.assign(child, patch);
      changed.set(childId, patch);
      descendantQueue.push(childId);
    }
  }
  for (const [rowId, patch] of changed) {
    const entries = Object.entries(patch);
    await db.prepare(`UPDATE "database_table_${tableId}" SET ${entries.map(([key]) => `"${key}"=?`).join(", ")} WHERE id=?`)
      .bind(...entries.map(([, value]) => value), rowId)
      .run();
  }
  return changed;
}

// The validity column only needs adding once per table and D1 binding.
const tablesWithValidityColumn = new WeakMap<object, Set<number>>();

async function ensureValidityColumn(db: D1Database, tableId: number) {
  const known = tablesWithValidityColumn.get(db as object);
  if (known?.has(tableId)) return;
  await addValidityColumn(db, tableId);
  if (known) known.add(tableId);
  else tablesWithValidityColumn.set(db as object, new Set([tableId]));
}

async function addValidityColumn(db: D1Database, tableId: number) {
  await ensureUserTableSystemColumns(db, tableId);
  try {
    await db.prepare(`ALTER TABLE "database_table_${tableId}" ADD COLUMN "field_rules_are_valid" INTEGER NOT NULL DEFAULT 1`).run();
  } catch (e: any) {
    if (!String(e.message || e).includes("duplicate column")) throw e;
  }
  await db.prepare("UPDATE database_table SET field_rules_validity_column_added=1 WHERE id=?").bind(tableId).run();
}

export async function hasActiveDateDependencyRules(db: D1Database, tableId: number): Promise<boolean> {
  const rule = await db.prepare(
    "SELECT 1 AS found FROM database_fieldrule WHERE table_id=? AND type='date_dependency' AND is_active=1 AND is_valid=1 LIMIT 1"
  ).bind(tableId).first<{ found: number }>();
  return Boolean(rule);
}

/** Applies the table's date dependency rules after a write; true when it rewrote the row. */
export async function applyDateDependencyRules(
  db: D1Database,
  tableId: number,
  rowId: number,
  changedFieldIds: Set<number>
): Promise<boolean> {
  const rules = await db.prepare(
    "SELECT * FROM database_fieldrule WHERE table_id=? AND type='date_dependency' AND is_active=1 AND is_valid=1"
  ).bind(tableId).all<DateDependencyRule>();
  if (!rules.results?.length) return false;

  await ensureUserTableSystemColumns(db, tableId);
  const row = await db.prepare(`SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`).bind(rowId).first<Record<string, unknown>>();
  if (!row) return false;

  const sets: string[] = [];
  const vals: unknown[] = [];
  const merged = { ...row };
  for (const rule of rules.results) {
    const settings = parseSettings(rule);
    const patch = calculateDateDependencyPatch(merged, settings, changedFieldIds);
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = value;
      sets.push(`"${key}"=?`);
      vals.push(value);
    }
  }
  const valid = rules.results.every((rule) => rowIsValid(merged, parseSettings(rule)));
  sets.push("field_rules_are_valid=?");
  vals.push(valid ? 1 : 0);
  vals.push(rowId);
  await db.prepare(`UPDATE "database_table_${tableId}" SET ${sets.join(", ")} WHERE id=? AND COALESCE(trashed, 0)=0`).bind(...vals).run();
  for (const rule of rules.results) {
    await cascadeDateDependencies(db, tableId, rowId, parseSettings(rule));
  }
  await recomputeFieldRuleValidity(db, tableId);
  return true;
}

/**
 * Recomputes `field_rules_are_valid` for every row: one read of the rule
 * columns and one atomic batch of writes, instead of one UPDATE per row
 * (which pushed any write to a table of ~1,000 rows past D1's query limit).
 */
export async function recomputeFieldRuleValidity(db: D1Database, tableId: number) {
  await ensureValidityColumn(db, tableId);
  const rules = await db.prepare(
    "SELECT * FROM database_fieldrule WHERE table_id=? AND type='date_dependency' AND is_active=1 AND is_valid=1"
  ).bind(tableId).all<DateDependencyRule>();
  const table = `"database_table_${tableId}"`;
  const resetValid = db.prepare(`UPDATE ${table} SET field_rules_are_valid=1 WHERE COALESCE(trashed, 0)=0 AND field_rules_are_valid=0`);
  const activeRules = (rules.results || []).map(parseSettings);
  if (activeRules.length === 0) {
    await resetValid.run();
    return;
  }
  const columns = new Set<string>();
  for (const settings of activeRules) {
    for (const fieldId of [settings.start_date_field_id, settings.end_date_field_id, settings.duration_field_id]) {
      if (Number.isInteger(Number(fieldId)) && Number(fieldId) > 0) columns.add(`"field_${Number(fieldId)}"`);
    }
  }
  const rows = await db.prepare(
    `SELECT id${columns.size > 0 ? `, ${[...columns].join(", ")}` : ""} FROM ${table} WHERE COALESCE(trashed, 0)=0`
  ).all<Record<string, unknown>>();
  const invalidIds = (rows.results || [])
    .filter((row) => !activeRules.every((settings) => rowIsValid(row, settings)))
    .map((row) => Number(row.id));
  const markInvalid = [];
  for (let offset = 0; offset < invalidIds.length; offset += 90) {
    const chunk = invalidIds.slice(offset, offset + 90);
    markInvalid.push(db.prepare(`UPDATE ${table} SET field_rules_are_valid=0 WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk));
  }
  await db.batch([resetValid, ...markInvalid]);
}

export async function revalidateDateDependencyRules(db: D1Database, tableId: number) {
  const rules = await db.prepare(
    "SELECT * FROM database_fieldrule WHERE table_id=? AND type='date_dependency'"
  ).bind(tableId).all<DateDependencyRule>();
  // Nothing to revalidate: deleting the last rule already reset the row flags.
  if (!rules.results?.length) return;
  for (const rule of rules.results || []) {
    const validity = await validateDateDependencySettings(db, tableId, parseSettings(rule), Boolean(rule.is_active));
    await db.prepare(
      "UPDATE database_fieldrule SET is_valid=?, error_text=?, updated_on=? WHERE id=?"
    ).bind(validity.isValid ? 1 : 0, validity.errorText, new Date().toISOString(), rule.id).run();
  }
  await recomputeFieldRuleValidity(db, tableId);
}

export async function createDateDependencyRule(db: D1Database, tableId: number, body: Record<string, unknown>) {
  if (body.type !== "date_dependency") throw new ValidationError("Unsupported field rule type.");
  const existing = await db.prepare("SELECT id FROM database_fieldrule WHERE table_id=? AND type='date_dependency'")
    .bind(tableId)
    .first<{ id: number }>();
  if (existing) return { error: "ERROR_RULE_ALREADY_EXISTS" as const };
  const settings = normalizeRuleSettings(body);
  const isActive = body.is_active === undefined ? true : Boolean(body.is_active);
  const validity = await validateDateDependencySettings(db, tableId, settings, isActive);
  if (isActive && !validity.isValid) throw new ValidationError(validity.errorText || "Invalid date dependency rule.");
  const now = new Date().toISOString();
  await ensureValidityColumn(db, tableId);
  const rule = await db.prepare(
    `INSERT INTO database_fieldrule (table_id, type, is_active, is_valid, error_text, settings, created_on, updated_on)
     VALUES (?, 'date_dependency', ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(tableId, isActive ? 1 : 0, validity.isValid ? 1 : 0, validity.errorText, JSON.stringify(settings), now, now)
    .first<DateDependencyRule>();
  await recomputeFieldRuleValidity(db, tableId);
  return { rule: rule! };
}

export async function updateDateDependencyRule(db: D1Database, tableId: number, ruleId: number, body: Record<string, unknown>) {
  const existing = await db.prepare("SELECT * FROM database_fieldrule WHERE id=? AND table_id=?")
    .bind(ruleId, tableId)
    .first<DateDependencyRule>();
  if (!existing) throw new DoesNotExist("Rule", ruleId);
  if (body.type && body.type !== existing.type) throw new ValidationError("Cannot change field rule type.");
  const settings = { ...parseSettings(existing), ...normalizeRuleSettings(body) };
  const isActive = body.is_active === undefined ? Boolean(existing.is_active) : Boolean(body.is_active);
  const validity = await validateDateDependencySettings(db, tableId, settings, isActive);
  if (isActive && !validity.isValid) throw new ValidationError(validity.errorText || "Invalid date dependency rule.");
  await db.prepare(
    `UPDATE database_fieldrule SET is_active=?, is_valid=?, error_text=?, settings=?, updated_on=? WHERE id=?`
  ).bind(isActive ? 1 : 0, validity.isValid ? 1 : 0, validity.errorText, JSON.stringify(settings), new Date().toISOString(), ruleId).run();
  await recomputeFieldRuleValidity(db, tableId);
  return (await db.prepare("SELECT * FROM database_fieldrule WHERE id=?").bind(ruleId).first<DateDependencyRule>())!;
}
