import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware } from "../../middleware/auth";
import { evaluateFormula, type FieldValues } from "../../services/formula-engine";
import {
  extractLookupReferences,
  inferFormulaNumberDecimalPlaces,
  inferFormulaType,
  mapFieldTypeToFormulaType,
  type FormulaTypeLookup,
} from "../../services/formula-types";
import { parseFieldSettings } from "../../services/computed-fields";
import { assertHasTableRoleById } from "../../services/enterprise-permissions";

const formula = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

formula.post("/:tableId/type/", authMiddleware, async (c) => {
  const tableId = Number(c.req.param("tableId"));
  const body = await c.req.json<{ formula?: string; name?: string }>();
  // Baserow grants TypeFormulaOperationType to builders of the table.
  await assertHasTableRoleById(c.env.DB, c.get("user")!.id, tableId, "BUILDER");
  const formulaText = body.formula || "";
  const fields = await c.env.DB.prepare(
    `SELECT id, name, type, field_settings FROM database_field WHERE table_id=? AND trashed=0`
  ).bind(tableId).all<any>();
  const fieldTypes = buildFieldTypeLookup(fields.results || []);
  const lookupArrayFormulaType = await resolveLookupArrayFormulaType(c.env.DB, tableId, formulaText, fields.results || []);
  const result = evaluateFormula(formulaText, {});
  const typeInfo = inferFormulaType(formulaText, result.value, result.error, fieldTypes, lookupArrayFormulaType);
  const numberSettings = typeInfo.formula_type === "number"
    ? { number_decimal_places: inferFormulaNumberDecimalPlaces(formulaText, buildFieldDecimalPlacesLookup(fields.results || [])) }
    : {};
  return c.json({
    ...typeInfo,
    ...numberSettings,
    name: body.name || "",
    formula: formulaText,
  });
});

// ── POST /api/database/formula/evaluate/ — Dry-run evaluate a formula ─────────
// Used by the frontend formula builder to preview results in real time.
formula.post("/evaluate/", authMiddleware, async (c) => {
  const body = await c.req.json<{
    formula: string;
    table_id?: number;           // Optional — used to resolve field names
    row_id?: number;             // Optional — test against a specific row
    context?: FieldValues;       // Optional — manual field values to test with
  }>();

  if (!body.formula?.trim()) {
    return c.json({ error: "MISSING_FORMULA", detail: "formula is required." }, 400);
  }

  let context: FieldValues = body.context || {};

  // If table_id + row_id provided, fetch the actual row values
  if (body.table_id !== undefined || body.row_id !== undefined) {
    const tableId = Number(body.table_id);
    const rowId = Number(body.row_id);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      return c.json({ error: "INVALID_REQUEST", detail: "table_id and row_id must be positive integers." }, 400);
    }
    await assertHasTableRoleById(c.env.DB, c.get("user")!.id, tableId, "VIEWER");
    const [fields, row] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, name, type FROM database_field
         WHERE table_id=? AND trashed=0 ORDER BY [order] ASC`
      ).bind(tableId).all<any>(),
      c.env.DB.prepare(
        `SELECT * FROM "database_table_${tableId}" WHERE id=? AND COALESCE(trashed, 0)=0`
      ).bind(rowId).first<any>(),
    ]);

    if (row) {
      for (const f of (fields.results || [])) {
        context[f.name] = row[`field_${f.id}`];
        context[`field_${f.id}`] = row[`field_${f.id}`];
      }
    }
  }

  const result = evaluateFormula(body.formula, context);

  return c.json({
    formula: body.formula,
    value: result.value,
    error: result.error,
    type: result.error ? "error" : typeof result.value,
  });
});

// ── GET /api/database/formula/functions/ — List all supported functions ────────
formula.get("/functions/", authMiddleware, async (c) => {
  return c.json({
    functions: [
      // Logic
      { name: "FIELD", signature: "FIELD(name)", category: "logic" },
      { name: "FIELD_BY_ID", signature: "FIELD_BY_ID(id)", category: "logic" },
      { name: "ROW_ID", signature: "ROW_ID()", category: "logic" },
      { name: "AND", signature: "AND(a, b, ...)", category: "logic" },
      { name: "OR", signature: "OR(a, b, ...)", category: "logic" },
      { name: "NOT", signature: "NOT(value)", category: "logic" },
      { name: "IF", signature: "IF(condition, then, else?)", category: "logic" },
      { name: "EQUAL", signature: "EQUAL(a, b)", category: "logic" },
      { name: "NOT_EQUAL", signature: "NOT_EQUAL(a, b)", category: "logic" },
      { name: "GREATER_THAN", signature: "GREATER_THAN(a, b)", category: "logic" },
      { name: "GREATER_THAN_OR_EQUAL", signature: "GREATER_THAN_OR_EQUAL(a, b)", category: "logic" },
      { name: "LESS_THAN", signature: "LESS_THAN(a, b)", category: "logic" },
      { name: "LESS_THAN_OR_EQUAL", signature: "LESS_THAN_OR_EQUAL(a, b)", category: "logic" },
      { name: "ISBLANK", signature: "ISBLANK(value)", category: "logic" },
      { name: "ISNULL", signature: "ISNULL(value)", category: "logic" },
      { name: "IS_NULL", signature: "IS_NULL(value)", category: "logic" },
      { name: "IFERROR", signature: "IFERROR(value, fallback)", category: "logic" },
      { name: "SWITCH", signature: "SWITCH(value, case1, result1, ...)", category: "logic" },
      { name: "WHEN_EMPTY", signature: "WHEN_EMPTY(value, fallback)", category: "logic" },
      // Text
      { name: "CONCAT", signature: "CONCAT(a, b, ...)", category: "text" },
      { name: "UPPER", signature: "UPPER(text)", category: "text" },
      { name: "LOWER", signature: "LOWER(text)", category: "text" },
      { name: "TRIM", signature: "TRIM(text)", category: "text" },
      { name: "LEN", signature: "LEN(text)", category: "text" },
      { name: "LENGTH", signature: "LENGTH(text)", category: "text" },
      { name: "LEFT", signature: "LEFT(text, n)", category: "text" },
      { name: "RIGHT", signature: "RIGHT(text, n)", category: "text" },
      { name: "MID", signature: "MID(text, start, length)", category: "text" },
      { name: "REPLACE", signature: "REPLACE(text, search, replacement)", category: "text" },
      { name: "REGEX_REPLACE", signature: "REGEX_REPLACE(text, regex, replacement)", category: "text" },
      { name: "CONTAINS", signature: "CONTAINS(text, search)", category: "text" },
      { name: "HAS_OPTION", signature: "HAS_OPTION(selects, option)", category: "text" },
      { name: "FIND", signature: "FIND(text, search)", category: "text" },
      { name: "SEARCH", signature: "SEARCH(text, search)", category: "text" },
      { name: "REVERSE", signature: "REVERSE(text)", category: "text" },
      { name: "SPLIT", signature: "SPLIT(text, delimiter)", category: "text" },
      { name: "SPLIT_PART", signature: "SPLIT_PART(text, delimiter, index)", category: "text" },
      { name: "T", signature: "T(value)", category: "text" },
      { name: "TOVARCHAR", signature: "TOVARCHAR(value)", category: "text" },
      { name: "TOTEXT", signature: "TOTEXT(value)", category: "text" },
      { name: "TOURL", signature: "TOURL(value)", category: "text" },
      { name: "GET_SINGLE_SELECT_VALUE", signature: "GET_SINGLE_SELECT_VALUE(select)", category: "text" },
      { name: "JSONB_EXTRACT_PATH_TEXT", signature: "JSONB_EXTRACT_PATH_TEXT(value, path, ...)", category: "text" },
      { name: "ENCODE_URI", signature: "ENCODE_URI(text)", category: "text" },
      { name: "ENCODE_URI_COMPONENT", signature: "ENCODE_URI_COMPONENT(text)", category: "text" },
      // Numbers
      { name: "ADD", signature: "ADD(a, b)", category: "number" },
      { name: "MINUS", signature: "MINUS(a, b)", category: "number" },
      { name: "MULTIPLY", signature: "MULTIPLY(a, b)", category: "number" },
      { name: "DIVIDE", signature: "DIVIDE(a, b)", category: "number" },
      { name: "MOD", signature: "MOD(a, b)", category: "number" },
      { name: "ABS", signature: "ABS(n)", category: "number" },
      { name: "ROUND", signature: "ROUND(n, decimals?)", category: "number" },
      { name: "CEIL", signature: "CEIL(n)", category: "number" },
      { name: "FLOOR", signature: "FLOOR(n)", category: "number" },
      { name: "POWER", signature: "POWER(base, exp)", category: "number" },
      { name: "SQRT", signature: "SQRT(n)", category: "number" },
      { name: "EXP", signature: "EXP(n)", category: "number" },
      { name: "LN", signature: "LN(n)", category: "number" },
      { name: "LOG", signature: "LOG(n, base?)", category: "number" },
      { name: "SIGN", signature: "SIGN(n)", category: "number" },
      { name: "GREATEST", signature: "GREATEST(a, b, ...)", category: "number" },
      { name: "LEAST", signature: "LEAST(a, b, ...)", category: "number" },
      { name: "MAX", signature: "MAX(a, b, ...)", category: "number" },
      { name: "MIN", signature: "MIN(a, b, ...)", category: "number" },
      { name: "SUM", signature: "SUM(a, b, ...)", category: "number" },
      { name: "AVG", signature: "AVG(a, b, ...)", category: "number" },
      { name: "AVERAGE", signature: "AVERAGE(a, b, ...)", category: "number" },
      { name: "STDDEV_POP", signature: "STDDEV_POP(array)", category: "number" },
      { name: "STDDEV_SAMPLE", signature: "STDDEV_SAMPLE(array)", category: "number" },
      { name: "VARIANCE_POP", signature: "VARIANCE_POP(array)", category: "number" },
      { name: "VARIANCE_SAMPLE", signature: "VARIANCE_SAMPLE(array)", category: "number" },
      { name: "TONUMBER", signature: "TONUMBER(value)", category: "number" },
      { name: "INT", signature: "INT(n)", category: "number" },
      { name: "TRUNC", signature: "TRUNC(n)", category: "number" },
      { name: "EVEN", signature: "EVEN(n)", category: "number" },
      { name: "ODD", signature: "ODD(n)", category: "number" },
      { name: "IS_NAN", signature: "IS_NAN(n)", category: "number" },
      { name: "WHEN_NAN", signature: "WHEN_NAN(n, fallback)", category: "number" },
      { name: "ERROR_TO_NAN", signature: "ERROR_TO_NAN(value)", category: "number" },
      { name: "ERROR_TO_NULL", signature: "ERROR_TO_NULL(value)", category: "number" },
      // Date
      { name: "NOW", signature: "NOW()", category: "date" },
      { name: "TODAY", signature: "TODAY()", category: "date" },
      { name: "DATETIME_FORMAT", signature: "DATETIME_FORMAT(date, format)", category: "date" },
      { name: "DATETIME_FORMAT_TZ", signature: "DATETIME_FORMAT_TZ(date, format, timezone)", category: "date" },
      { name: "YEAR", signature: "YEAR(date)", category: "date" },
      { name: "MONTH", signature: "MONTH(date)", category: "date" },
      { name: "DAY", signature: "DAY(date)", category: "date" },
      { name: "HOUR", signature: "HOUR(date)", category: "date" },
      { name: "MINUTE", signature: "MINUTE(date)", category: "date" },
      { name: "SECOND", signature: "SECOND(date)", category: "date" },
      { name: "DATEADD", signature: "DATEADD(date, amount, unit)", category: "date" },
      { name: "DATEDIFF", signature: "DATEDIFF(date1, date2, unit)", category: "date" },
      { name: "DATE_DIFF", signature: "DATE_DIFF(unit, date1, date2)", category: "date" },
      { name: "TODATE", signature: "TODATE(text)", category: "date" },
      { name: "TODATE_TZ", signature: "TODATE_TZ(text, format, timezone)", category: "date" },
      { name: "DATE_INTERVAL", signature: "DATE_INTERVAL(text)", category: "date" },
      { name: "BC_TO_NULL", signature: "BC_TO_NULL(date)", category: "date" },
      { name: "TODURATION", signature: "TODURATION(seconds)", category: "date" },
      { name: "TOSECONDS", signature: "TOSECONDS(duration)", category: "date" },
      // Array
      { name: "COUNT", signature: "COUNT(array)", category: "array" },
      { name: "ARRAY_AGG", signature: "ARRAY_AGG(value)", category: "array" },
      { name: "ARRAY_AGG_NO_NESTING", signature: "ARRAY_AGG_NO_NESTING(value)", category: "array" },
      { name: "ARRAY_AGG_UNNESTING", signature: "ARRAY_AGG_UNNESTING(array)", category: "array" },
      { name: "MANY_TO_MANY_AGG", signature: "MANY_TO_MANY_AGG(value)", category: "array" },
      { name: "MULTIPLE_SELECT_OPTIONS_AGG", signature: "MULTIPLE_SELECT_OPTIONS_AGG(value)", category: "array" },
      { name: "MANY_TO_MANY_COUNT", signature: "MANY_TO_MANY_COUNT(value)", category: "array" },
      { name: "MULTIPLE_SELECT_COUNT", signature: "MULTIPLE_SELECT_COUNT(value)", category: "array" },
      { name: "STRING_AGG_MANY_TO_MANY_VALUES", signature: "STRING_AGG_MANY_TO_MANY_VALUES(value)", category: "array" },
      { name: "STRING_AGG_MULTIPLE_SELECT_VALUES", signature: "STRING_AGG_MULTIPLE_SELECT_VALUES(value)", category: "array" },
      { name: "ARRAYJOIN", signature: "ARRAYJOIN(array, separator)", category: "array" },
      { name: "JOIN", signature: "JOIN(array, separator)", category: "array" },
      { name: "FILTER", signature: "FILTER(array, booleans)", category: "array" },
      { name: "INDEX", signature: "INDEX(array, index)", category: "array" },
      { name: "ANY", signature: "ANY(array)", category: "array" },
      { name: "EVERY", signature: "EVERY(array)", category: "array" },
      // Link
      { name: "LINK", signature: "LINK(url, label?)", category: "link" },
      { name: "BUTTON", signature: "BUTTON(url, label)", category: "link" },
      { name: "GET_LINK_URL", signature: "GET_LINK_URL(link)", category: "link" },
      { name: "GET_LINK_LABEL", signature: "GET_LINK_LABEL(link)", category: "link" },
      // Files
      { name: "GET_FILE_VISIBLE_NAME", signature: "GET_FILE_VISIBLE_NAME(file)", category: "file" },
      { name: "GET_FILE_MIME_TYPE", signature: "GET_FILE_MIME_TYPE(file)", category: "file" },
      { name: "GET_FILE_COUNT", signature: "GET_FILE_COUNT(files)", category: "file" },
      { name: "GET_FILE_SIZE", signature: "GET_FILE_SIZE(file)", category: "file" },
      { name: "GET_IMAGE_WIDTH", signature: "GET_IMAGE_WIDTH(file)", category: "file" },
      { name: "GET_IMAGE_HEIGHT", signature: "GET_IMAGE_HEIGHT(file)", category: "file" },
      { name: "IS_IMAGE", signature: "IS_IMAGE(file)", category: "file" },
    ],
  });
});

function buildFieldTypeLookup(fields: any[]): FormulaTypeLookup {
  const lookup: FormulaTypeLookup = {};
  for (const field of fields) {
    const settings = parseFieldSettings(field.field_settings);
    const formulaType = mapFieldTypeToFormulaType(String(field.type), settings);
    lookup[String(field.name).toLowerCase()] = formulaType;
    lookup[`field_${field.id}`] = formulaType;
  }
  return lookup;
}

function buildFieldDecimalPlacesLookup(fields: any[]): Record<string, number> {
  const lookup: Record<string, number> = {};
  for (const field of fields) {
    const value = Number(parseFieldSettings(field.field_settings).number_decimal_places ?? 0);
    const decimalPlaces = Number.isFinite(value) ? Math.min(10, Math.max(0, Math.trunc(value))) : 0;
    lookup[String(field.name).toLowerCase()] = decimalPlaces;
    lookup[`field_${field.id}`] = decimalPlaces;
  }
  return lookup;
}

async function resolveLookupArrayFormulaType(db: D1Database, tableId: number, formulaText: string, fields: any[]): Promise<string | null> {
  const reference = extractLookupReferences(formulaText)[0];
  if (!reference) return null;

  const throughField = fields.find((field) => String(field.name).toLowerCase() === reference.throughFieldName.toLowerCase());
  const throughSettings = parseFieldSettings(throughField?.field_settings);
  const targetTableId = Number(throughSettings.link_row_table_id || 0);
  if (!throughField || String(throughField.type) !== "link_row" || !targetTableId) return null;

  const targetField = await db.prepare(
    `SELECT type, field_settings FROM database_field
     WHERE table_id=? AND LOWER(name)=LOWER(?) AND trashed=0`
  ).bind(targetTableId, reference.targetFieldName).first<any>();
  if (!targetField) return null;
  return mapFieldTypeToFormulaType(String(targetField.type), parseFieldSettings(targetField.field_settings));
}

export { formula as formulaRouter };
