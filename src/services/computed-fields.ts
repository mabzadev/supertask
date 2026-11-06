import type { D1Database } from "@cloudflare/workers-types";
import type { FieldMeta, FieldType } from "./dynamic-tables";
import { chunkIds, deserializeFieldValue, selectActiveRowsByIds, serializeFieldValueForResponse } from "./dynamic-tables";
import { evaluateFormula } from "./formula-engine";
import { extractFormulaFieldReferences } from "./formula-types";
import { formatNumberForApi } from "./number-format";

type Row = Record<string, unknown>;

export function parseFieldSettings(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== "string") return typeof value === "object" ? value as Record<string, unknown> : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function formulaFromSettings(settings: Record<string, unknown>): string | undefined {
  return typeof settings.formula === "string" ? settings.formula : undefined;
}

export function buildFieldContext(row: Row, fields: FieldMeta[]): Record<string, unknown> {
  const context: Record<string, unknown> = {
    __row_id: row.id,
    row_id: row.id,
  };
  for (const field of fields) {
    const value = row[`field_${field.id}`];
    const normalized = deserializeFieldValue(field.type, value);
    const formulaValue = formulaInputValue(field, normalized);
    context[field.name] = formulaValue;
    context[`field_${field.id}`] = formulaValue;
  }
  return context;
}

function formulaInputValue(field: FieldMeta, value: unknown): unknown {
  if ((field.type === "lookup" || field.type === "link_row") && Array.isArray(value)) {
    return value.map((item) => {
      if (!item || typeof item !== "object") return item;
      const record = item as Record<string, unknown>;
      return Object.prototype.hasOwnProperty.call(record, "value") ? record.value : item;
    });
  }
  return value;
}

export function normalizeFieldValue(type: FieldType, value: unknown): unknown {
  return deserializeFieldValue(type, value);
}

export function linkedRowIds(value: unknown): number[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  const ids = parsed
    .map((item) => {
      if (typeof item === "number") return item;
      if (typeof item === "string" && item.trim() !== "") return Number(item);
      if (item && typeof item === "object" && "id" in item) return Number((item as { id: unknown }).id);
      return NaN;
    })
    .filter((id) => Number.isInteger(id) && id > 0);
  return Array.from(new Set(ids));
}

export function computeLocalFieldValue(row: Row, fields: FieldMeta[], field: FieldMeta): unknown {
  const stored = row[`field_${field.id}`];
  if (field.type === "formula" && typeof field.formula === "string" && field.formula.trim()) {
    const evaluated = evaluateFormula(field.formula, buildFieldContext(row, fields));
    return evaluated.error ? null : evaluated.value;
  }
  if (field.type === "count") {
    const throughFieldId = Number(field.settings?.through_field_id || 0);
    if (!throughFieldId) return stored;
    return linkedRowIds(row[`field_${throughFieldId}`]).length;
  }
  return stored;
}

const LINKED_COMPUTED_TYPES = new Set<FieldType>(["formula", "count", "lookup", "rollup"]);

/**
 * Per-serialization read cache. Linked rows and field lists are loaded once per
 * target table instead of once per source row, which keeps list endpoints far
 * below D1's per-invocation query limit. Scope it to a single read pass only:
 * it never sees writes made after a row was loaded.
 */
export class RowReadContext {
  private readonly fieldsByTable = new Map<number, Promise<FieldMeta[]>>();
  private readonly rowsByTable = new Map<number, Map<number, Promise<Row | null>>>();

  constructor(readonly db: D1Database) {}

  fields(tableId: number): Promise<FieldMeta[]> {
    let pending = this.fieldsByTable.get(tableId);
    if (!pending) {
      pending = loadActiveFields(this.db, tableId);
      this.fieldsByTable.set(tableId, pending);
      pending.catch(() => this.fieldsByTable.delete(tableId));
    }
    return pending;
  }

  /** Active rows among `ids`, ordered like `ORDER BY [order] ASC, id ASC`. */
  async linkedRows(tableId: number, ids: number[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    this.load(tableId, ids);
    const cache = this.rowsByTable.get(tableId)!;
    const rows = await Promise.all(ids.map((id) => cache.get(id)!));
    return rows
      .filter((row): row is Row => row !== null)
      .sort((left, right) => rowOrder(left) - rowOrder(right) || Number(left.id) - Number(right.id));
  }

  /** Starts loading the rows that are not cached or in flight yet. */
  load(tableId: number, ids: Iterable<number>): void {
    let cache = this.rowsByTable.get(tableId);
    if (!cache) {
      cache = new Map();
      this.rowsByTable.set(tableId, cache);
    }
    const missing = [...new Set(ids)].filter((id) => !cache!.has(id));
    for (const chunk of chunkIds(missing)) {
      const loaded = selectActiveRowsByIds(this.db, tableId, chunk);
      for (const id of chunk) {
        cache.set(id, loaded.then((byId) => byId.get(id) ?? null));
      }
      loaded.catch(() => chunk.forEach((id) => cache!.delete(id)));
    }
  }

  /** Loads every row referenced by the link fields of `rows` in one query per target table. */
  async prefetchLinks(rows: Row[], fields: FieldMeta[]): Promise<void> {
    const idsByTable = new Map<number, Set<number>>();
    for (const field of fields) {
      if (field.type !== "link_row") continue;
      const targetTableId = Number(field.settings?.link_row_table_id || 0);
      if (!targetTableId) continue;
      const ids = idsByTable.get(targetTableId) || new Set<number>();
      for (const row of rows) linkedRowIds(row[`field_${field.id}`]).forEach((id) => ids.add(id));
      if (ids.size > 0) idsByTable.set(targetTableId, ids);
    }
    for (const [tableId, ids] of idsByTable) this.load(tableId, ids);
    await Promise.all([...idsByTable].map(([tableId, ids]) => this.linkedRows(tableId, [...ids])));
  }
}

class ComputedFieldResolver {
  private readonly memo = new Map<number, unknown>();

  constructor(
    private readonly ctx: RowReadContext,
    private readonly row: Row,
    private readonly fields: FieldMeta[],
    private readonly lineage: Set<string> = new Set()
  ) {}

  async resolve(field: FieldMeta): Promise<unknown> {
    if (this.memo.has(field.id)) return this.memo.get(field.id);
    const key = `${field.id}:${String(this.row.id ?? "")}`;
    if (this.lineage.has(key)) return null;
    this.lineage.add(key);

    let value: unknown;
    try {
      if (field.type === "formula" && typeof field.formula === "string" && field.formula.trim()) {
        value = await this.resolveFormula(field, field.formula);
      } else if (field.type === "lookup") {
        value = await lookupValues(this.ctx, this.row, this.fields, field, this.lineage);
      } else if (field.type === "rollup") {
        value = await rollupValue(this.ctx, this.row, this.fields, field, this.lineage);
      } else if (field.type === "count") {
        const throughFieldId = Number(field.settings?.through_field_id || 0);
        const throughField = this.fields.find((candidate) => candidate.id === throughFieldId);
        const targetTableId = Number(throughField?.settings?.link_row_table_id || 0);
        const ids = linkedRowIds(this.row[`field_${throughFieldId}`]);
        value = throughFieldId && targetTableId
          ? (await this.ctx.linkedRows(targetTableId, ids)).length
          : this.row[`field_${field.id}`];
      } else if (field.type === "link_row") {
        value = await hydrateLinkRowValues(this.ctx, this.row, field, this.lineage);
      } else {
        value = this.row[`field_${field.id}`];
      }
    } finally {
      this.lineage.delete(key);
    }

    this.memo.set(field.id, value);
    return value;
  }

  /**
   * A formula that cannot be parsed (e.g. after a bad rename) yields `null`
   * instead of failing the whole request; storage errors still propagate.
   */
  private async resolveFormula(field: FieldMeta, formula: string): Promise<unknown> {
    let references: ReturnType<typeof extractFormulaFieldReferences>;
    try {
      references = extractFormulaFieldReferences(formula);
    } catch {
      return null;
    }
    const context: Record<string, unknown> = {
      __row_id: this.row.id,
      row_id: this.row.id,
    };
    for (const contextField of this.fields) {
      const contextValue = deserializeFieldValue(contextField.type, this.row[`field_${contextField.id}`]);
      context[contextField.name] = contextValue;
      context[`field_${contextField.id}`] = contextValue;
    }
    for (const reference of references) {
      const referencedField = reference.kind === "id"
        ? this.fields.find((candidate) => candidate.id === reference.value)
        : this.fields.find((candidate) => candidate.name.toLowerCase() === reference.value.toLowerCase());
      if (!referencedField || referencedField.id === field.id) continue;
      const referencedValue = LINKED_COMPUTED_TYPES.has(referencedField.type)
        ? await this.resolve(referencedField)
        : deserializeFieldValue(referencedField.type, this.row[`field_${referencedField.id}`]);
      const formulaValue = formulaInputValue(referencedField, referencedValue);
      context[referencedField.name] = formulaValue;
      context[`field_${referencedField.id}`] = formulaValue;
    }
    for (const reference of lookupReferences(formula)) {
      const lookupValue = await linkedTargetValuesByNames(
        this.ctx,
        this.row,
        this.fields,
        reference.throughFieldName,
        reference.targetFieldName,
        this.lineage
      );
      context[`lookup:${reference.throughFieldName}:${reference.targetFieldName}`] = lookupValue;
      context[`lookup:${reference.throughFieldName.toLowerCase()}:${reference.targetFieldName.toLowerCase()}`] = lookupValue;
    }
    try {
      const evaluated = evaluateFormula(formula, context);
      return evaluated.error ? null : evaluated.value;
    } catch {
      return null;
    }
  }
}

export async function computeLinkedFieldValue(
  db: D1Database,
  row: Row,
  fields: FieldMeta[],
  field: FieldMeta,
  ctx: RowReadContext = new RowReadContext(db)
): Promise<unknown> {
  return new ComputedFieldResolver(ctx, row, fields).resolve(field);
}

export async function serializeRowWithComputedFields(
  db: D1Database,
  row: Row,
  fields: FieldMeta[],
  useFieldNames = false,
  ctx: RowReadContext = new RowReadContext(db)
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    id: row.id,
    order: row["[order]"] ?? row.order ?? 10000,
  };
  const resolver = new ComputedFieldResolver(ctx, row, fields);

  for (const field of fields) {
    const key = useFieldNames ? field.name : `field_${field.id}`;
    const value = await resolver.resolve(field);
    result[key] = normalizeResolvedFieldValue(field, value);
  }

  return result;
}

/** Serializes several rows of one table, loading their linked rows in bulk. */
export async function serializeRowsWithComputedFields(
  db: D1Database,
  rows: Row[],
  fields: FieldMeta[],
  useFieldNames = false,
  ctx: RowReadContext = new RowReadContext(db)
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  await ctx.prefetchLinks(rows, fields);
  return Promise.all(rows.map((row) => serializeRowWithComputedFields(db, row, fields, useFieldNames, ctx)));
}

function normalizeResolvedFieldValue(field: FieldMeta, value: unknown): unknown {
  if (!LINKED_COMPUTED_TYPES.has(field.type)) return serializeFieldValueForResponse(field, value);
  const rollupFunction = String(field.settings?.airtable_rollup_function || field.settings?.rollup_function || "").toLowerCase();
  const formulaType = String(field.settings?.formula_type || "").toLowerCase();
  if (formulaType === "boolean" || rollupFunction === "any" || rollupFunction === "every") {
    return value === null || value === undefined ? null : Boolean(value);
  }
  if (formulaType === "number") return serializeFieldValueForResponse(field, value);
  if (formulaType === "duration") return deserializeFieldValue("number", value);
  if (field.type === "lookup" || formulaType === "array") return Array.isArray(value) ? value : [];
  return value;
}

async function lookupValues(
  ctx: RowReadContext,
  row: Row,
  fields: FieldMeta[],
  field: FieldMeta,
  lineage: Set<string>
): Promise<unknown[]> {
  const values = await linkedTargetValues(ctx, row, fields, field, lineage);
  const throughFieldId = Number(field.settings?.through_field_id || 0);
  const throughField = fields.find((candidate) => candidate.id === throughFieldId);
  const targetTableId = Number(throughField?.settings?.link_row_table_id || 0);
  const rows = targetTableId
    ? await ctx.linkedRows(targetTableId, linkedRowIds(row[`field_${throughFieldId}`]))
    : [];
  return values.flatMap((value, index) => {
    const rowId = Number(rows[index]?.id);
    const flattened = Array.isArray(value) ? value : [value];
    return flattened.map((item) => ({
      id: Number.isInteger(rowId) && rowId > 0 ? rowId : index + 1,
      value: serializeLookupSubValue(field, item),
    }));
  });
}

function serializeLookupSubValue(field: FieldMeta, value: unknown): unknown {
  const subtype = String(field.settings?.array_formula_type || "").toLowerCase();
  if (subtype === "number") return formatNumberForApi(field, value);
  if (subtype === "boolean") return value === null || value === undefined ? null : Boolean(value);
  return value;
}

async function rollupValue(
  ctx: RowReadContext,
  row: Row,
  fields: FieldMeta[],
  field: FieldMeta,
  lineage: Set<string>
): Promise<unknown> {
  const allValues = (await linkedTargetValues(ctx, row, fields, field, lineage))
    .flatMap((value) => Array.isArray(value) ? value : [value]);
  return aggregateRollupValues(allValues, field.settings || {});
}

function uniqueValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function airtableArraySlice(values: unknown[], start: number, end: number | null): unknown[] {
  const startIndex = start > 0 ? start - 1 : start;
  const endIndex = end === null ? undefined : end;
  return values.slice(startIndex, endIndex);
}

export function aggregateRollupValues(allValues: unknown[], settings: Record<string, unknown>): unknown {
  const values = allValues.filter((value) => value !== null && value !== undefined && value !== "");
  const fn = String(settings.airtable_rollup_function || settings.rollup_function || "count").toLowerCase();

  if (fn === "count" || fn === "count_all") return allValues.length;
  if (fn === "empty_count") return allValues.length - values.length;
  if (fn === "not_empty_count") return values.length;
  if (fn === "unique_count") return uniqueValues(values).length;
  if (fn === "array_compact") return values;
  if (fn === "array_flatten") return allValues.flat(Infinity).filter((value) => value !== null && value !== undefined && value !== "");
  if (fn === "array_unique") return uniqueValues(values);
  if (fn === "array_slice") {
    return airtableArraySlice(
      allValues,
      Number(settings.airtable_rollup_slice_start || 1),
      settings.airtable_rollup_slice_end === null || settings.airtable_rollup_slice_end === undefined
        ? null
        : Number(settings.airtable_rollup_slice_end)
    );
  }
  if (fn === "array_join" || fn === "join" || fn === "string_agg") {
    const separator = String(settings.airtable_rollup_separator ?? ", ");
    let joinValues = settings.airtable_rollup_flatten === true ? allValues.flat(Infinity) : [...allValues];
    if (settings.airtable_rollup_compact === true) {
      joinValues = joinValues.filter((value) => value !== null && value !== undefined && value !== "");
    }
    if (settings.airtable_rollup_unique === true) joinValues = uniqueValues(joinValues);
    return joinValues.map((value) => value === null || value === undefined ? "" : String(value)).join(separator);
  }
  if (fn === "concatenate") return allValues.map((value) => value === null || value === undefined ? "" : String(value)).join("");
  if (fn === "and") return allValues.every(Boolean);
  if (fn === "or") return allValues.some(Boolean);
  if (fn === "xor") return allValues.filter(Boolean).length % 2 === 1;
  if (fn === "any") return values.length === 0 ? null : values.some(Boolean);
  if (fn === "every") return values.length === 0 ? null : values.every(Boolean);

  const numbers = values
    .map((value) => deserializeFieldValue("number", value))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (fn === "numeric_count") return numbers.length;
  if (fn === "sum") return numbers.reduce((sum, value) => sum + value, 0);
  if (fn === "avg" || fn === "average") return numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (fn === "min") return aggregateMinimumOrMaximum(values, numbers, "min");
  if (fn === "max") return aggregateMinimumOrMaximum(values, numbers, "max");
  if (["variance_pop", "variance_sample", "stddev_pop", "stddev_sample"].includes(fn)) {
    const sample = fn.endsWith("_sample");
    if (numbers.length === 0 || (sample && numbers.length < 2)) return null;
    const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    const divisor = sample ? numbers.length - 1 : numbers.length;
    const variance = numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / divisor;
    return fn.startsWith("stddev") ? Math.sqrt(variance) : variance;
  }

  return values.length;
}

function aggregateMinimumOrMaximum(
  values: unknown[],
  numbers: number[],
  mode: "min" | "max"
): unknown {
  if (values.length === 0) return null;
  if (numbers.length === values.length) return mode === "min" ? Math.min(...numbers) : Math.max(...numbers);
  return values.reduce((selected, value) => {
    const comparison = String(value).localeCompare(String(selected));
    return mode === "min" ? (comparison < 0 ? value : selected) : (comparison > 0 ? value : selected);
  });
}

async function linkedTargetValues(
  ctx: RowReadContext,
  row: Row,
  fields: FieldMeta[],
  field: FieldMeta,
  lineage: Set<string>
): Promise<unknown[]> {
  const throughFieldId = Number(field.settings?.through_field_id || 0);
  const targetFieldId = Number(field.settings?.target_field_id || 0);
  if (!throughFieldId || !targetFieldId) return [];

  const throughField = fields.find((item) => item.id === throughFieldId);
  const targetTableId = Number(throughField?.settings?.link_row_table_id || 0);
  if (!throughField || throughField.type !== "link_row" || !targetTableId) return [];

  const ids = linkedRowIds(row[`field_${throughFieldId}`]);
  if (ids.length === 0) return [];

  const targetFields = await ctx.fields(targetTableId);
  const targetField = targetFields.find((item) => item.id === targetFieldId);
  if (!targetField) return [];

  const targetRows = await ctx.linkedRows(targetTableId, ids);
  if (LINKED_COMPUTED_TYPES.has(targetField.type)) {
    const values: unknown[] = [];
    for (const targetRow of targetRows) {
      values.push(await new ComputedFieldResolver(ctx, targetRow, targetFields, lineage).resolve(targetField));
    }
    return values;
  }
  return targetRows.map((targetRow) => deserializeFieldValue(
    targetField.type,
    targetRow[`field_${targetFieldId}`] ?? targetRow.value
  ));
}

function rowOrder(row: Row): number {
  const value = Number(row["[order]"] ?? row.order ?? 10000);
  return Number.isFinite(value) ? value : 10000;
}

function linkedPrimaryDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(linkedPrimaryDisplayValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.value !== undefined) return String(record.value ?? "");
    if (record.name !== undefined) return String(record.name ?? "");
  }
  return String(value);
}

async function hydrateLinkRowValues(
  ctx: RowReadContext,
  row: Row,
  field: FieldMeta,
  lineage: Set<string>
): Promise<Array<{ id: number; value: string; order?: string }>> {
  const targetTableId = Number(field.settings?.link_row_table_id || 0);
  const stored = deserializeFieldValue("link_row", row[`field_${field.id}`]) as unknown[];
  const storedFallback = stored.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = Number(record.id);
    if (!Number.isInteger(id) || id <= 0) return [];
    return [{
      id,
      value: String(record.value ?? record.name ?? id),
      ...(record.order === null || record.order === undefined ? {} : { order: String(record.order) }),
    }];
  });
  const ids = linkedRowIds(row[`field_${field.id}`]);
  if (!targetTableId || ids.length === 0) return storedFallback;
  const targetFields = await ctx.fields(targetTableId);
  const primaryField = targetFields.find((candidate) => candidate.primary) || targetFields[0];
  if (!primaryField) return storedFallback;
  const targetRows = await ctx.linkedRows(targetTableId, ids);
  const values: Array<{ id: number; value: string; order?: string }> = [];
  for (const targetRow of targetRows) {
    const primaryValue = LINKED_COMPUTED_TYPES.has(primaryField.type)
      ? await new ComputedFieldResolver(ctx, targetRow, targetFields, lineage).resolve(primaryField)
      : deserializeFieldValue(primaryField.type, targetRow[`field_${primaryField.id}`]);
    values.push({
      id: Number(targetRow.id),
      value: linkedPrimaryDisplayValue(primaryValue),
      order: String(rowOrder(targetRow)),
    });
  }
  return values;
}

async function linkedTargetValuesByNames(
  ctx: RowReadContext,
  row: Row,
  fields: FieldMeta[],
  throughFieldName: string,
  targetFieldName: string,
  lineage: Set<string>
): Promise<unknown[]> {
  const throughField = fields.find((field) => field.name.toLowerCase() === throughFieldName.toLowerCase());
  const targetTableId = Number(throughField?.settings?.link_row_table_id || 0);
  if (!throughField || throughField.type !== "link_row" || !targetTableId) return [];

  const targetField = await ctx.db.prepare(
    `SELECT id, name, type, "primary" AS is_primary, read_only, field_settings
     FROM database_field
     WHERE LOWER(name)=LOWER(?) AND table_id=? AND trashed=0`
  ).bind(targetFieldName, targetTableId).first<any>();
  if (!targetField) return [];

  return linkedTargetValues(ctx, row, fields, {
    id: 0,
    name: "__formula_lookup__",
    type: "lookup",
    primary: false,
    settings: {
      through_field_id: throughField.id,
      target_field_id: targetField.id,
    },
  }, lineage);
}

async function loadActiveFields(db: D1Database, tableId: number): Promise<FieldMeta[]> {
  const fields = await db.prepare(
    `SELECT id, name, type, "primary" AS is_primary, read_only, field_settings
     FROM database_field
     WHERE table_id=? AND trashed=0
     ORDER BY [order] ASC, id ASC`
  ).bind(tableId).all<any>();
  return (fields.results || []).map((field) => {
    const settings = parseFieldSettings(field.field_settings);
    return {
      id: field.id,
      name: field.name,
      type: field.type,
      primary: Boolean(field.is_primary),
      readOnly: Boolean(field.read_only),
      settings,
      formula: formulaFromSettings(settings),
    };
  });
}

function lookupReferences(formula: string): Array<{ throughFieldName: string; targetFieldName: string }> {
  const references = new Map<string, { throughFieldName: string; targetFieldName: string }>();
  const pattern = /\blookup\s*\(\s*(["'])(.*?)\1\s*,\s*(["'])(.*?)\3\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(formula))) {
    const throughFieldName = match[2];
    const targetFieldName = match[4];
    references.set(`${throughFieldName.toLowerCase()}:${targetFieldName.toLowerCase()}`, { throughFieldName, targetFieldName });
  }
  return [...references.values()];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
