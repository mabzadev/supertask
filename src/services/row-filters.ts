import type { FieldMeta } from "./dynamic-tables";
import { baserowDateFilterBounds, baserowDateIsWithinBounds, baserowLegacyDateFilterBounds } from "./date-filters";
import { numericStorageSqlExpression } from "./number-format";

export interface FilterSpec {
  field_id: number;
  type: string;
  value: string;
}

// ── 40+ filter types matching Baserow's filter registry ──────────────────────
export function applyFilters(
  tableName: string,
  filters: FilterSpec[],
  fields: FieldMeta[],
  filterType: "AND" | "OR" = "AND"
): { clause: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];

  for (const filter of filters) {
    const field = fields.find(f => f.id === filter.field_id);
    if (!field) continue;

    const col = `"${tableName}"."field_${field.id}"`;
    const result = buildFilterClause(col, filter.type, filter.value, field);
    if (result) {
      clauses.push(result.clause);
      values.push(...result.values);
    }
  }

  if (clauses.length === 0) return { clause: "", values: [] };
  return {
    clause: `(${clauses.join(` ${filterType} `)})`,
    values,
  };
}

function buildFilterClause(
  col: string,
  filterType: string,
  value: string,
  field: FieldMeta
): { clause: string; values: unknown[] } | null {
  switch (filterType) {
    // ── Equality ──────────────────────────────────────────────────────────────
    case "equal":
      return { clause: `${col} = ?`, values: [coerce(field, value)] };
    case "not_equal":
      return { clause: `(${col} != ? OR ${col} IS NULL)`, values: [coerce(field, value)] };

    // ── Text ──────────────────────────────────────────────────────────────────
    case "contains":
      return { clause: `${col} LIKE ?`, values: [`%${value}%`] };
    case "contains_not":
      return { clause: `(${col} NOT LIKE ? OR ${col} IS NULL)`, values: [`%${value}%`] };
    case "contains_word":
      return { clause: `${col} LIKE ?`, values: [`% ${value} %`] };
    case "doesnt_contain_word":
      return { clause: `(${col} NOT LIKE ? OR ${col} IS NULL)`, values: [`% ${value} %`] };
    case "filename_contains":
      return { clause: `${col} LIKE ?`, values: [`%"${value}"%`] };
    case "length_is_lower_than":
      return { clause: `LENGTH(${col}) < ?`, values: [parseInt(value)] };

    // ── Numeric ───────────────────────────────────────────────────────────────
    case "higher_than": {
      const numericCol = numericStorageSqlExpression(col);
      return { clause: `${numericCol} > ?`, values: [parseFloat(value)] };
    }
    case "higher_than_or_equal": {
      const numericCol = numericStorageSqlExpression(col);
      return { clause: `${numericCol} >= ?`, values: [parseFloat(value)] };
    }
    case "lower_than": {
      const numericCol = numericStorageSqlExpression(col);
      return { clause: `${numericCol} < ?`, values: [parseFloat(value)] };
    }
    case "lower_than_or_equal": {
      const numericCol = numericStorageSqlExpression(col);
      return { clause: `${numericCol} <= ?`, values: [parseFloat(value)] };
    }
    case "is_even_and_whole": {
      const numericCol = numericStorageSqlExpression(col);
      return { clause: `(CAST(${numericCol} AS INTEGER) % 2 = 0 AND ${numericCol} = CAST(${numericCol} AS INTEGER))`, values: [] };
    }

    // ── Empty / Not empty ─────────────────────────────────────────────────────
    case "empty":
      return { clause: `(${col} IS NULL OR ${col} = '' OR ${col} = '[]')`, values: [] };
    case "not_empty":
      return { clause: `(${col} IS NOT NULL AND ${col} != '' AND ${col} != '[]')`, values: [] };

    // ── Boolean ───────────────────────────────────────────────────────────────
    case "boolean":
      return { clause: `${col} = ?`, values: [value === "true" || value === "1" ? 1 : 0] };

    // ── Date ──────────────────────────────────────────────────────────────────
    case "date_is": {
      const bounds = baserowDateFilterBounds(value);
      return bounds ? { clause: `(${col} >= ? AND ${col} < ?)`, values: [bounds.start, bounds.end] } : null;
    }
    case "date_is_not": {
      const bounds = baserowDateFilterBounds(value);
      return bounds ? { clause: `(${col} IS NULL OR ${col} < ? OR ${col} >= ?)`, values: [bounds.start, bounds.end] } : null;
    }
    case "date_is_before": {
      const bounds = baserowDateFilterBounds(value);
      return bounds ? { clause: `${col} < ?`, values: [bounds.start] } : null;
    }
    case "date_is_on_or_before": {
      const bounds = baserowDateFilterBounds(value);
      return bounds ? { clause: `${col} < ?`, values: [bounds.end] } : null;
    }
    case "date_is_after": {
      const bounds = baserowDateFilterBounds(value);
      return bounds ? { clause: `${col} >= ?`, values: [bounds.end] } : null;
    }
    case "date_is_on_or_after": {
      const bounds = baserowDateFilterBounds(value);
      return bounds ? { clause: `${col} >= ?`, values: [bounds.start] } : null;
    }
    case "date_is_within": {
      const bounds = baserowDateIsWithinBounds(value);
      return bounds ? { clause: `(${col} >= ? AND ${col} < ?)`, values: [bounds.start, bounds.end] } : null;
    }
    case "date_equal":
      return { clause: `DATE(${col}) = DATE(?)`, values: [value] };
    case "date_not_equal":
      return { clause: `(DATE(${col}) != DATE(?) OR ${col} IS NULL)`, values: [value] };
    case "date_before":
      return { clause: `DATE(${col}) < DATE(?)`, values: [value] };
    case "date_before_or_equal":
      return { clause: `DATE(${col}) <= DATE(?)`, values: [value] };
    case "date_after":
      return { clause: `DATE(${col}) > DATE(?)`, values: [value] };
    case "date_after_or_equal":
      return { clause: `DATE(${col}) >= DATE(?)`, values: [value] };
    case "date_equals_today":
      return { clause: `DATE(${col}) = DATE('now')`, values: [] };
    case "date_before_today":
      return { clause: `DATE(${col}) < DATE('now')`, values: [] };
    case "date_after_today":
      return { clause: `DATE(${col}) > DATE('now')`, values: [] };
    case "date_equals_week":
      return {
        clause: `strftime('%Y-%W', ${col}) = strftime('%Y-%W', 'now')`,
        values: [],
      };
    case "date_equals_month":
      return {
        clause: `strftime('%Y-%m', ${col}) = strftime('%Y-%m', 'now')`,
        values: [],
      };
    case "date_equals_year":
      return {
        clause: `strftime('%Y', ${col}) = strftime('%Y', 'now')`,
        values: [],
      };
    case "date_equals_days_ago":
    case "date_equals_months_ago":
    case "date_equals_years_ago": {
      const bounds = baserowLegacyDateFilterBounds(filterType, value);
      return bounds ? { clause: `(${col} >= ? AND ${col} < ?)`, values: [bounds.start, bounds.end] } : null;
    }
    case "date_after_days_ago": {
      const bounds = baserowLegacyDateFilterBounds(filterType, value);
      return bounds ? { clause: `${col} >= ?`, values: [bounds.start] } : null;
    }
    case "date_equals_day_of_month":
      return {
        clause: `CAST(strftime('%d', ${col}) AS INTEGER) = ?`,
        values: [parseInt(value)],
      };
    case "date_within_days":
    case "date_within_weeks":
    case "date_within_months": {
      const bounds = baserowLegacyDateFilterBounds(filterType, value);
      return bounds ? { clause: `(${col} >= ? AND ${col} < ?)`, values: [bounds.start, bounds.end] } : null;
    }

    // ── Select fields ─────────────────────────────────────────────────────────
    case "single_select_equal":
      return { clause: `${col} = ?`, values: [value] };
    case "single_select_not_equal":
      return { clause: `(${col} != ? OR ${col} IS NULL)`, values: [value] };
    case "single_select_is_any_of":
      return {
        clause: `${col} IN (${value.split(",").map(() => "?").join(",")})`,
        values: value.split(",").map(v => v.trim()),
      };
    case "single_select_is_none_of":
      return {
        clause: `(${col} NOT IN (${value.split(",").map(() => "?").join(",")}) OR ${col} IS NULL)`,
        values: value.split(",").map(v => v.trim()),
      };

    case "multiple_select_has":
      return { clause: `${col} LIKE ?`, values: [`%"${value}"%`] };
    case "multiple_select_has_not":
      return { clause: `(${col} NOT LIKE ? OR ${col} IS NULL)`, values: [`%"${value}"%`] };
    case "multiple_select_is_any_of": {
      const opts = value.split(",").map(v => v.trim());
      const clauses = opts.map(() => `${col} LIKE ?`);
      return { clause: `(${clauses.join(" OR ")})`, values: opts.map(o => `%"${o}"%`) };
    }

    // ── Link row ──────────────────────────────────────────────────────────────
    case "link_row_has":
      return { clause: `${col} LIKE ?`, values: [`%"id":${parseInt(value)}%`] };
    case "link_row_has_not":
      return { clause: `(${col} NOT LIKE ? OR ${col} IS NULL)`, values: [`%"id":${parseInt(value)}%`] };
    case "link_row_contains":
      return { clause: `${col} LIKE ?`, values: [`%${value}%`] };
    case "link_row_not_contains":
      return value === "" ? null : { clause: `(${col} NOT LIKE ? OR ${col} IS NULL)`, values: [`%${value}%`] };

    case "multiple_collaborators_has": {
      const ids = parseIdList(value);
      if (ids.length === 0) return null;
      return {
        clause: `(${ids.map(() => `${col} LIKE ?`).join(" OR ")})`,
        values: ids.map((id) => `%"id":${id}%`),
      };
    }
    case "multiple_collaborators_has_not": {
      const ids = parseIdList(value);
      if (ids.length === 0) return null;
      return {
        clause: `(${ids.map(() => `${col} NOT LIKE ?`).join(" AND ")} OR ${col} IS NULL)`,
        values: ids.map((id) => `%"id":${id}%`),
      };
    }

    // ── File ──────────────────────────────────────────────────────────────────
    case "has_file_type": {
      const type = value.trim();
      if (type === "image") {
        return {
          clause: `(${col} LIKE ? OR ${col} LIKE ?)`,
          values: [`%"is_image":true%`, `%"mime_type":"image/%`],
        };
      }
      if (type === "document") {
        return {
          clause: `${col} LIKE ?`,
          values: [`%"is_image":false%`],
        };
      }
      return null;
    }
    case "files_lower_than":
      return {
        clause: `(LENGTH(${col}) - LENGTH(REPLACE(${col}, '\"name\"', ''))) / 6 < ?`,
        values: [parseInt(value)],
      };

    // ── User/Collaborator ─────────────────────────────────────────────────────
    case "user_is":
      return { clause: `${col} LIKE ?`, values: [`%"id":${parseInt(value)}%`] };
    case "user_is_not":
      return { clause: `(${col} NOT LIKE ? OR ${col} IS NULL)`, values: [`%"id":${parseInt(value)}%`] };

    default:
      console.warn(`Unknown filter type: ${filterType}`);
      return null;
  }
}

function parseIdList(value: string): number[] {
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isFinite(id));
}

function coerce(field: FieldMeta, value: string): unknown {
  switch (field.type) {
    case "number":
    case "rating":
    case "count":
    case "rollup":
      return parseFloat(value);
    case "boolean":
      return value === "true" || value === "1" ? 1 : 0;
    default:
      return value;
  }
}
