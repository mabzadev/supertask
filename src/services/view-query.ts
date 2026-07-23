import type { D1Database } from "@cloudflare/workers-types";
import { ensureUserTableSystemColumns, type FieldMeta } from "./dynamic-tables";
import { baserowDateFilterBounds, baserowDateIsWithinBounds, baserowDateKey, baserowLegacyDateFilterBounds } from "./date-filters";
import { numericStorageValue } from "./number-format";
import { getActiveFields, serializeRowForViewWithComputed } from "./view-helpers";

type Row = Record<string, unknown>;

interface FilterSpec {
  field: number;
  type: string;
  value: string;
  group?: number | null;
}

interface FilterSource {
  filterType: "AND" | "OR";
  filters: FilterSpec[];
  groups: FilterSource[];
}

interface SortSpec {
  field: number;
  order: "ASC" | "DESC";
  type: string;
}

interface QueryResult {
  fields: FieldMeta[];
  rows: Row[];
  count: number;
  groupByMetadata: Record<string, Array<Row & { count: number }>>;
}

export async function queryViewRows(
  db: D1Database,
  view: any,
  requestUrl: string
): Promise<QueryResult> {
  const url = new URL(requestUrl);
  const tableId = Number(view.table_id);
  const fields = await getActiveFields(db, tableId);
  const useFieldNames = truthyQueryParam(url.searchParams.get("user_field_names"));
  await ensureUserTableSystemColumns(db, tableId);
  const rawRows = await db.prepare(
    `SELECT * FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC`
  ).all<Row>();

  let rows = await Promise.all((rawRows.results || []).map((row) => serializeRowForViewWithComputed(db, row, fields)));
  rows = applyRowIdFilter(rows, url);
  rows = applySearch(rows, fields, url.searchParams.get("search") || "");
  const filterSources = buildFilterSources(url, await loadPersistentFilters(db, view), fields, useFieldNames);
  rows = rows.filter((row) => matchesAllFilterSources(row, fields, filterSources));

  const sortSpecs = await resolveSorts(db, view, url, fields, useFieldNames);
  const selectOptionOrders = await loadSelectOptionOrders(db, fields, sortSpecs);
  rows = sortRows(rows, fields, sortSpecs, selectOptionOrders);

  const groupBys = await resolveGroupBys(db, view, url, fields, useFieldNames);
  const groupByMetadata = buildGroupByMetadata(rows, groupBys);
  const fieldIdsForResponse = resolveIncludeExcludeFieldIds(url, fields);
  const responseRows = fieldIdsForResponse
    ? rows.map((row) => projectRowFields(row, fields, fieldIdsForResponse))
    : rows;
  const limitedRows = limitLinkedItems(responseRows, fields, url.searchParams.get("limit_linked_items"));
  return {
    fields,
    rows: limitedRows,
    count: rows.length,
    groupByMetadata,
  };
}

function limitLinkedItems(rows: Row[], fields: FieldMeta[], rawLimit: string | null): Row[] {
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) return rows;
  const limitedTypes = new Set(["link_row", "formula", "lookup", "rollup"]);
  return rows.map((row) => {
    let result = row;
    for (const field of fields) {
      if (!limitedTypes.has(field.type)) continue;
      const key = `field_${field.id}`;
      const value = result[key];
      if (!Array.isArray(value) || value.length <= limit) continue;
      if (result === row) result = { ...row };
      result[key] = value.slice(0, limit);
    }
    return result;
  });
}

export async function orderedRowIdsForAutonumber(
  db: D1Database,
  tableId: number,
  viewId?: number | null
): Promise<number[]> {
  await ensureUserTableSystemColumns(db, tableId);
  const rawResult = await db.prepare(
    `SELECT * FROM "database_table_${tableId}" ORDER BY [order] ASC, id ASC`
  ).all<Row>();
  const rawRows = rawResult.results || [];
  if (!viewId) {
    return [...rawRows]
      .sort((left, right) => Number(left.trashed || 0) - Number(right.trashed || 0) || numeric(left.order) - numeric(right.order) || Number(left.id) - Number(right.id))
      .map((row) => Number(row.id));
  }

  const view = await db.prepare(
    `SELECT id, table_id, filter_type, filters_disabled
     FROM database_view
     WHERE id=? AND trashed=0`
  ).bind(viewId).first<any>();
  if (!view || Number(view.table_id) !== tableId) throw new Error("The autonumber view does not belong to the table.");

  const fields = await getActiveFields(db, tableId);
  const serializedRows = await Promise.all(rawRows.map((row) => serializeRowForViewWithComputed(db, row, fields)));
  const trashedIds = new Set(rawRows.filter((row) => Number(row.trashed || 0) !== 0).map((row) => Number(row.id)));
  const activeRows = serializedRows.filter((row) => !trashedIds.has(Number(row.id)));
  const trashedRows = serializedRows.filter((row) => trashedIds.has(Number(row.id)));
  const persistentFilters = await loadPersistentFilters(db, view);
  const filterSources = hasFilters(persistentFilters) ? [persistentFilters] : [];
  const sortSpecs = await resolveSorts(db, view, new URL(`https://autonumber.local/views/${viewId}/`), fields, false);
  const matching = filterSources.length === 0
    ? activeRows
    : activeRows.filter((row) => matchesAllFilterSources(row, fields, filterSources));
  const matchingIds = new Set(matching.map((row) => Number(row.id)));
  const nonMatching = activeRows.filter((row) => !matchingIds.has(Number(row.id)));
  const ordered = [
    ...sortRows(matching, fields, sortSpecs),
    ...sortRows(nonMatching, fields, sortSpecs),
    ...sortRows(trashedRows, fields, []),
  ];
  return ordered.map((row) => Number(row.id));
}

async function loadPersistentFilters(db: D1Database, view: any): Promise<FilterSource> {
  if (view.filters_disabled) return emptyFilterSource();
  const [filtersResult, groupsResult] = await Promise.all([
    db.prepare(
      `SELECT vf.field_id, vf.type, vf.value, vf.group_id
       FROM database_viewfilter vf
       JOIN database_field f ON f.id=vf.field_id AND f.trashed=0
       WHERE vf.view_id=?
       ORDER BY vf.id ASC`
    )
      .bind(view.id)
      .all<any>(),
    db.prepare("SELECT id, parent_group_id, filter_type FROM database_viewfiltergroup WHERE view_id=? ORDER BY id ASC")
      .bind(view.id)
      .all<any>(),
  ]);
  const root: FilterSource = {
    filterType: String(view.filter_type || "AND").toUpperCase() === "OR" ? "OR" : "AND",
    filters: [],
    groups: [],
  };
  const groupNodes = new Map<number, FilterSource & { parentId: number | null }>();
  for (const row of groupsResult.results || []) {
    groupNodes.set(Number(row.id), {
      filterType: String(row.filter_type || "AND").toUpperCase() === "OR" ? "OR" : "AND",
      filters: [],
      groups: [],
      parentId: row.parent_group_id === null || row.parent_group_id === undefined ? null : Number(row.parent_group_id),
    });
  }
  for (const [id, group] of groupNodes.entries()) {
    const parent = group.parentId ? groupNodes.get(group.parentId) : null;
    (parent || root).groups.push(group);
    groupNodes.set(id, group);
  }
  for (const row of filtersResult.results || []) {
    const filter = {
      field: Number(row.field_id),
      type: String(row.type || ""),
      value: String(row.value ?? ""),
      group: row.group_id ?? null,
    };
    const target = filter.group ? groupNodes.get(Number(filter.group)) : null;
    (target || root).filters.push(filter);
  }
  return root;
}

function buildFilterSources(
  url: URL,
  persistent: FilterSource,
  fields: FieldMeta[],
  useFieldNames: boolean
): FilterSource[] {
  const sources: FilterSource[] = [];
  if (hasFilters(persistent)) sources.push(persistent);

  let hasSerializedFilters = false;
  for (const value of url.searchParams.getAll("filters")) {
    hasSerializedFilters = true;
    const parsed = parseSerializedFilterTree(value, fields, useFieldNames);
    if (hasFilters(parsed)) sources.push(parsed);
  }

  if (hasSerializedFilters) return sources;

  const directFilters: FilterSpec[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    const filter = parseDirectFilterParam(key, value, fields, useFieldNames);
    if (filter) directFilters.push(filter);
  }
  if (directFilters.length > 0) {
    const filterType = String(url.searchParams.get("filter_type") || "AND").toUpperCase() === "OR" ? "OR" : "AND";
    sources.push({ filterType, filters: directFilters, groups: [] });
  }

  return sources;
}

function parseSerializedFilterTree(value: string, fields: FieldMeta[], useFieldNames: boolean): FilterSource {
  try {
    const tree = JSON.parse(value);
    const walk = (node: any): FilterSource => ({
      filterType: String(node?.filter_type || "AND").toUpperCase() === "OR" ? "OR" : "AND",
      filters: (node?.filters || [])
        .map((filter: any) => ({
          field: resolveFieldReference(filter.field, fields, useFieldNames)?.id ?? NaN,
          type: String(filter.type || ""),
          value: String(filter.value ?? ""),
        }))
        .filter((filter: FilterSpec) => Number.isInteger(filter.field) && filter.field > 0),
      groups: (node?.groups || []).map(walk),
    });
    return walk(tree);
  } catch {
    return emptyFilterSource();
  }
}

const DIRECT_FILTER_TYPES = [
  "date_after_or_equal",
  "date_before_or_equal",
  "date_equals_day_of_month",
  "date_equals_months_ago",
  "date_equals_years_ago",
  "has_any_select_option_equal",
  "has_none_select_option_equal",
  "higher_than_or_equal",
  "lower_than_or_equal",
  "multiple_collaborators_has_not",
  "multiple_select_is_any_of",
  "single_select_is_none_of",
  "single_select_is_any_of",
  "date_equals_today",
  "date_before_today",
  "date_after_today",
  "date_equals_week",
  "date_equals_month",
  "date_equals_year",
  "date_within_days",
  "date_within_weeks",
  "date_within_months",
  "date_equals_days_ago",
  "date_after_days_ago",
  "doesnt_contain_word",
  "length_is_lower_than",
  "is_even_and_whole",
  "multiple_select_has_not",
  "multiple_collaborators_has",
  "single_select_not_equal",
  "link_row_not_contains",
  "filename_contains",
  "files_lower_than",
  "date_not_equal",
  "date_before",
  "date_after",
  "date_is_not",
  "date_is_before",
  "date_is_on_or_before",
  "date_is_after",
  "date_is_on_or_after",
  "date_is_within",
  "contains_not",
  "doesnt_contain",
  "contains_word",
  "multiple_select_has",
  "link_row_contains",
  "link_row_has_not",
  "has_file_type",
  "not_empty",
  "not_equal",
  "date_equal",
  "date_is",
  "boolean",
  "higher_than",
  "lower_than",
  "single_select_equal",
  "multiple_select_is_any_of",
  "link_row_has",
  "user_is_not",
  "contains",
  "empty",
  "equal",
  "user_is",
].sort((left, right) => right.length - left.length);

function parseDirectFilterParam(
  key: string,
  value: string,
  fields: FieldMeta[],
  useFieldNames: boolean
): FilterSpec | null {
  if (!key.startsWith("filter__")) return null;
  const rest = key.slice("filter__".length);
  for (const type of DIRECT_FILTER_TYPES) {
    const suffix = `__${type}`;
    if (!rest.endsWith(suffix)) continue;
    const field = resolveFieldReference(rest.slice(0, -suffix.length), fields, useFieldNames);
    return field ? { field: field.id, type, value } : null;
  }
  const lastSeparator = rest.lastIndexOf("__");
  if (lastSeparator === -1) return null;
  const field = resolveFieldReference(rest.slice(0, lastSeparator), fields, useFieldNames);
  return field ? { field: field.id, type: rest.slice(lastSeparator + 2), value } : null;
}

function matchesAllFilterSources(
  row: Row,
  fields: FieldMeta[],
  sources: FilterSource[]
): boolean {
  return sources.every((source) => matchesFilterSource(row, fields, source));
}

function matchesFilterSource(row: Row, fields: FieldMeta[], source: FilterSource): boolean {
  const checks = [
    ...source.filters
    .map((filter) => {
      const field = fields.find((item) => item.id === filter.field);
      return field ? matchesFilter(row[`field_${field.id}`], filter, field) : null;
    }),
    ...source.groups.map((group) => matchesFilterSource(row, fields, group)),
  ].filter((value): value is boolean => value !== null);
  if (checks.length === 0) return true;
  return source.filterType === "OR" ? checks.some(Boolean) : checks.every(Boolean);
}

function emptyFilterSource(): FilterSource {
  return { filterType: "AND", filters: [], groups: [] };
}

function hasFilters(source: FilterSource): boolean {
  return source.filters.length > 0 || source.groups.some(hasFilters);
}

function matchesFilter(value: unknown, filter: FilterSpec, field: FieldMeta): boolean {
  const text = scalarText(value).toLowerCase();
  const filterValue = String(filter.value ?? "");
  const filterText = filterValue.toLowerCase();
  switch (filter.type) {
    case "equal":
      return comparable(value, field) === comparable(filterValue, field);
    case "not_equal":
      return comparable(value, field) !== comparable(filterValue, field);
    case "contains":
      return text.includes(filterText);
    case "contains_word":
      return containsWholeWord(text, filterText);
    case "contains_not":
    case "doesnt_contain":
      return !text.includes(filterText);
    case "doesnt_contain_word":
      return !containsWholeWord(text, filterText);
    case "length_is_lower_than": {
      const limit = Number(filterValue);
      return limit === 0 || !Number.isFinite(limit) ? true : scalarText(value).length < limit;
    }
    case "empty":
      return isEmptyValue(value);
    case "not_empty":
      return !isEmptyValue(value);
    case "boolean":
      return Boolean(value) === (filterValue === "true" || filterValue === "1");
    case "higher_than":
      return numeric(value) > numeric(filterValue);
    case "higher_than_or_equal":
      return numeric(value) >= numeric(filterValue);
    case "lower_than":
      return numeric(value) < numeric(filterValue);
    case "lower_than_or_equal":
      return numeric(value) <= numeric(filterValue);
    case "is_even_and_whole": {
      const candidate = Number(value);
      return !isEmptyValue(value) && Number.isInteger(candidate) && candidate % 2 === 0;
    }
    case "date_equal":
      return dateKey(value) === dateKey(filterValue);
    case "date_not_equal":
      return dateKey(value) !== dateKey(filterValue);
    case "date_before":
      return dateMs(value) < dateMs(filterValue);
    case "date_before_or_equal":
      return dateMs(value) <= dateMs(filterValue);
    case "date_after":
      return dateMs(value) > dateMs(filterValue);
    case "date_after_or_equal":
      return dateMs(value) >= dateMs(filterValue);
    case "date_equals_today":
      return !isEmptyValue(value) && dateKey(value) === currentDateKey();
    case "date_before_today":
      return !isEmptyValue(value) && dateKey(value) < currentDateKey();
    case "date_after_today":
      return !isEmptyValue(value) && dateKey(value) > currentDateKey();
    case "date_equals_week":
      return !isEmptyValue(value) && yearWeekKey(dateKey(value)) === yearWeekKey(currentDateKey());
    case "date_equals_month":
      return !isEmptyValue(value) && dateKey(value).slice(0, 7) === currentDateKey().slice(0, 7);
    case "date_equals_year":
      return !isEmptyValue(value) && dateKey(value).slice(0, 4) === currentDateKey().slice(0, 4);
    case "date_equals_day_of_month":
      return !isEmptyValue(value) && Number(dateKey(value).slice(8, 10)) === Number(filterValue);
    case "date_within_days":
    case "date_within_weeks":
    case "date_within_months":
    case "date_equals_days_ago":
    case "date_equals_months_ago":
    case "date_equals_years_ago": {
      const bounds = baserowLegacyDateFilterBounds(filter.type, filterValue);
      if (!bounds || isEmptyValue(value)) return false;
      return dateKey(value) >= bounds.start && dateKey(value) < bounds.end;
    }
    case "date_after_days_ago": {
      const bounds = baserowLegacyDateFilterBounds(filter.type, filterValue);
      if (!bounds) return true;
      return !isEmptyValue(value) && dateKey(value) >= bounds.start;
    }
    case "date_is": {
      const bounds = baserowDateFilterBounds(filterValue);
      if (!bounds || isEmptyValue(value)) return false;
      return dateKey(value) >= bounds.start && dateKey(value) < bounds.end;
    }
    case "date_is_not": {
      const bounds = baserowDateFilterBounds(filterValue);
      return bounds ? isEmptyValue(value) || dateKey(value) < bounds.start || dateKey(value) >= bounds.end : false;
    }
    case "date_is_before": {
      const bounds = baserowDateFilterBounds(filterValue);
      return bounds && !isEmptyValue(value) ? dateKey(value) < bounds.start : false;
    }
    case "date_is_on_or_before": {
      const bounds = baserowDateFilterBounds(filterValue);
      return bounds && !isEmptyValue(value) ? dateKey(value) < bounds.end : false;
    }
    case "date_is_after": {
      const bounds = baserowDateFilterBounds(filterValue);
      return bounds && !isEmptyValue(value) ? dateKey(value) >= bounds.end : false;
    }
    case "date_is_on_or_after": {
      const bounds = baserowDateFilterBounds(filterValue);
      return bounds && !isEmptyValue(value) ? dateKey(value) >= bounds.start : false;
    }
    case "date_is_within": {
      const bounds = baserowDateIsWithinBounds(filterValue);
      if (!bounds || isEmptyValue(value)) return false;
      return dateKey(value) >= bounds.start && dateKey(value) < bounds.end;
    }
    case "single_select_equal":
      return optionIds(value).includes(Number(filterValue));
    case "single_select_not_equal":
      return !optionIds(value).includes(Number(filterValue));
    case "single_select_is_any_of": {
      const wanted = idList(filterValue);
      return optionIds(value).some((id) => wanted.includes(id));
    }
    case "single_select_is_none_of": {
      const wanted = idList(filterValue);
      return !optionIds(value).some((id) => wanted.includes(id));
    }
    case "multiple_select_has":
    case "has_any_select_option_equal":
      return optionIds(value).includes(Number(filterValue));
    case "multiple_select_has_not":
    case "has_none_select_option_equal":
      return !optionIds(value).includes(Number(filterValue));
    case "multiple_select_is_any_of": {
      const wanted = idList(filterValue);
      return optionIds(value).some((id) => wanted.includes(id));
    }
    case "link_row_has":
      return optionIds(value).includes(Number(filterValue));
    case "link_row_has_not":
      return !optionIds(value).includes(Number(filterValue));
    case "link_row_contains":
      return text.includes(filterText);
    case "link_row_not_contains":
      return filterText === "" || !text.includes(filterText);
    case "multiple_collaborators_has": {
      const wanted = idList(filterValue);
      return optionIds(value).some((id) => wanted.includes(id));
    }
    case "multiple_collaborators_has_not": {
      const wanted = idList(filterValue);
      return !optionIds(value).some((id) => wanted.includes(id));
    }
    case "filename_contains":
      return fileNames(value).some((name) => name.toLowerCase().includes(filterText));
    case "has_file_type":
      return filesHaveType(value, filterText);
    case "files_lower_than":
      return Array.isArray(value) && value.length < Number(filterValue);
    case "user_is":
      return optionIds(value).includes(Number(filterValue));
    case "user_is_not":
      return !optionIds(value).includes(Number(filterValue));
    default:
      return text.includes(filterText);
  }
}

function applyRowIdFilter(rows: Row[], url: URL): Row[] {
  const rowIds = url.searchParams.get("filter__field_id__in");
  if (!rowIds) return rows;
  const allowed = idList(rowIds);
  return rows.filter((row) => allowed.includes(Number(row.id)));
}

function applySearch(rows: Row[], fields: FieldMeta[], search: string): Row[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    fields.some((field) => scalarText(row[`field_${field.id}`]).toLowerCase().includes(needle))
  );
}

async function resolveSorts(db: D1Database, view: any, url: URL, fields: FieldMeta[], useFieldNames: boolean): Promise<SortSpec[]> {
  if (url.searchParams.has("order_by")) {
    return parseSortParam(url.searchParams.get("order_by") || "", fields, useFieldNames);
  }
  const [groupBys, sorts] = await Promise.all([
    resolveGroupBys(db, view, url, fields, useFieldNames),
    db.prepare(
      `SELECT vs.field_id, vs.[order], vs.type
       FROM database_viewsort vs
       JOIN database_field f ON f.id=vs.field_id AND f.trashed=0
       WHERE vs.view_id=?
       ORDER BY vs.id ASC`
    )
      .bind(view.id)
      .all<any>(),
  ]);
  return [
    ...groupBys,
    ...(sorts.results || []).map((row) => ({
      field: Number(row.field_id),
      order: String(row.order || "ASC").toUpperCase() === "DESC" ? "DESC" as const : "ASC" as const,
      type: String(row.type || "default"),
    })),
  ];
}

async function resolveGroupBys(db: D1Database, view: any, url: URL, fields: FieldMeta[], useFieldNames: boolean): Promise<SortSpec[]> {
  if (url.searchParams.has("group_by")) {
    return parseSortParam(url.searchParams.get("group_by") || "", fields, useFieldNames);
  }
  const rows = await db.prepare(
    `SELECT vg.field_id, vg.[order], vg.type
     FROM database_viewgroupby vg
     JOIN database_field f ON f.id=vg.field_id AND f.trashed=0
     WHERE vg.view_id=?
     ORDER BY vg.id ASC`
  )
    .bind(view.id)
    .all<any>();
  return (rows.results || []).map((row) => ({
    field: Number(row.field_id),
    order: String(row.order || "ASC").toUpperCase() === "DESC" ? "DESC" as const : "ASC" as const,
    type: String(row.type || "default"),
  }));
}

function parseSortParam(value: string, fields: FieldMeta[], useFieldNames: boolean): SortSpec[] {
  return splitCommaSeparated(value).map((part) => {
    const desc = part.startsWith("-");
    const asc = part.startsWith("+");
    const clean = desc || asc ? part.slice(1) : part;
    const typedFieldMatch = clean.match(/^(field_\d+)(?:\[(.+)])?$/);
    const fieldRef = typedFieldMatch ? typedFieldMatch[1] : clean;
    const field = resolveFieldReference(fieldRef, fields, useFieldNames);
    if (!field) return null;
    return {
      field: field.id,
      order: desc ? "DESC" as const : "ASC" as const,
      type: typedFieldMatch?.[2] || "default",
    };
  }).filter((item): item is SortSpec => item !== null);
}

function splitCommaSeparated(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function resolveFieldReference(value: unknown, fields: FieldMeta[], useFieldNames: boolean): FieldMeta | null {
  if (typeof value === "number") {
    return fields.find((field) => field.id === value) || null;
  }
  const raw = String(value ?? "");
  const fieldIdMatch = raw.match(/^field_(\d+)$/);
  if (fieldIdMatch) {
    const id = Number(fieldIdMatch[1]);
    return fields.find((field) => field.id === id) || null;
  }
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    const field = fields.find((item) => item.id === id);
    if (field) return field;
  }
  if (useFieldNames) {
    return fields.find((field) => field.name === raw) || null;
  }
  return null;
}

function resolveIncludeExcludeFieldIds(url: URL, fields: FieldMeta[]): Set<number> | null {
  const includes = resolveFieldIdList(url.searchParams.get("include_fields"), fields);
  const excludes = resolveFieldIdList(url.searchParams.get("exclude_fields"), fields);
  if (includes.size === 0 && excludes.size === 0) return null;

  const allowed = includes.size > 0
    ? new Set(includes)
    : new Set(fields.map((field) => field.id));
  for (const id of excludes) allowed.delete(id);
  return allowed;
}

function resolveFieldIdList(value: string | null, fields: FieldMeta[]): Set<number> {
  const ids = new Set<number>();
  if (!value) return ids;
  for (const part of splitCommaSeparated(value)) {
    const field = resolveFieldReference(part, fields, false);
    if (field) ids.add(field.id);
  }
  return ids;
}

function projectRowFields(row: Row, fields: FieldMeta[], allowedFieldIds: Set<number>): Row {
  const projected: Row = {
    id: row.id,
    order: row.order,
  };
  for (const field of fields) {
    if (allowedFieldIds.has(field.id)) {
      projected[`field_${field.id}`] = row[`field_${field.id}`];
    }
  }
  return projected;
}

function truthyQueryParam(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || ["1", "true", "t", "yes", "y", "on"].includes(normalized);
}

async function loadSelectOptionOrders(
  db: D1Database,
  fields: FieldMeta[],
  sorts: SortSpec[]
): Promise<Map<number, Map<number, number>>> {
  const fieldIds = [...new Set(sorts
    .filter((sort) => sort.type === "order" && fields.some((field) => field.id === sort.field && field.type === "single_select"))
    .map((sort) => sort.field))];
  const result = new Map<number, Map<number, number>>();
  if (fieldIds.length === 0) return result;
  const rows = await db.prepare(
    `SELECT id, field_id, [order]
     FROM database_selectoption
     WHERE field_id IN (${fieldIds.map(() => "?").join(",")})`
  ).bind(...fieldIds).all<any>();
  for (const option of rows.results || []) {
    const fieldId = Number(option.field_id);
    const orders = result.get(fieldId) || new Map<number, number>();
    orders.set(Number(option.id), Number(option.order));
    result.set(fieldId, orders);
  }
  return result;
}

function sortRows(
  rows: Row[],
  fields: FieldMeta[],
  sorts: SortSpec[],
  selectOptionOrders: Map<number, Map<number, number>> = new Map()
): Row[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    for (const sort of sorts) {
      const field = fields.find((item) => item.id === sort.field);
      if (!field) continue;
      const direction = sort.order === "DESC" ? -1 : 1;
      const compared = sort.type === "order" && field.type === "single_select"
        ? compareSingleSelectOrder(a[`field_${field.id}`], b[`field_${field.id}`], selectOptionOrders.get(field.id))
        : compareValues(a[`field_${field.id}`], b[`field_${field.id}`], field);
      if (compared !== 0) return compared * direction;
    }
    return numeric(a.order) - numeric(b.order) || Number(a.id) - Number(b.id);
  });
  return copy;
}

function compareSingleSelectOrder(left: unknown, right: unknown, orders?: Map<number, number>): number {
  const leftId = optionIds(left)[0];
  const rightId = optionIds(right)[0];
  if (leftId === undefined && rightId === undefined) return 0;
  if (leftId === undefined) return -1;
  if (rightId === undefined) return 1;
  return (orders?.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (orders?.get(rightId) ?? Number.MAX_SAFE_INTEGER);
}

function buildGroupByMetadata(rows: Row[], groupBys: SortSpec[]): Record<string, Array<Row & { count: number }>> {
  const metadata: Record<string, Array<Row & { count: number }>> = {};
  for (let index = 0; index < groupBys.length; index += 1) {
    const active = groupBys.slice(0, index + 1);
    const key = `field_${groupBys[index].field}`;
    const groups = new Map<string, Row & { count: number }>();
    for (const row of rows) {
      const entry: Row & { count: number } = { count: 0 };
      for (const groupBy of active) {
        entry[`field_${groupBy.field}`] = row[`field_${groupBy.field}`];
      }
      const hash = JSON.stringify(entry);
      const existing = groups.get(hash) || entry;
      existing.count += 1;
      groups.set(hash, existing);
    }
    metadata[key] = Array.from(groups.values());
  }
  return metadata;
}

function compareValues(left: unknown, right: unknown, field: FieldMeta): number {
  const leftValue = comparable(left, field);
  const rightValue = comparable(right, field);
  if (typeof leftValue === "number" && typeof rightValue === "number") return leftValue - rightValue;
  return String(leftValue).localeCompare(String(rightValue));
}

function comparable(value: unknown, field: FieldMeta): string | number {
  if (["number", "rating", "duration", "count", "rollup", "autonumber", "auto_number"].includes(field.type)) {
    return numeric(value);
  }
  if (["date", "created_on", "last_modified"].includes(field.type)) return dateMs(value);
  return scalarText(value).toLowerCase();
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(scalarText).join(" ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return String(object.value ?? object.name ?? object.id ?? JSON.stringify(object));
  }
  return String(value);
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function numeric(value: unknown): number {
  return numericStorageValue(value) ?? 0;
}

function dateMs(value: unknown): number {
  const parsed = new Date(String(value || "")).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(value: unknown): string {
  return baserowDateKey(value);
}

function currentDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearWeekKey(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return "";
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const dayOffset = Math.floor((date.getTime() - start.getTime()) / 86400000);
  return `${date.getUTCFullYear()}-${String(Math.floor((dayOffset + start.getUTCDay()) / 7)).padStart(2, "0")}`;
}

function containsWholeWord(text: string, word: string): boolean {
  if (word === "") return true;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function idList(value: string): number[] {
  return value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item));
}

function optionIds(value: unknown): number[] {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => {
      if (typeof item === "number") return item;
      if (typeof item === "string") return Number(item);
      if (item && typeof item === "object" && "id" in item) return Number((item as { id: unknown }).id);
      return NaN;
    })
    .filter((item) => Number.isInteger(item));
}

function fileNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => scalarText(item));
}

function filesHaveType(value: unknown, type: string): boolean {
  if (!Array.isArray(value)) return false;
  if (type !== "image" && type !== "document") return true;
  return value.some((item) => {
    if (!item || typeof item !== "object") return false;
    const file = item as Record<string, unknown>;
    const isImage = file.is_image === true || file.is_image === 1 || String(file.mime_type || "").startsWith("image/");
    return type === "image" ? isImage : !isImage;
  });
}
