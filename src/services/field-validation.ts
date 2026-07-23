import type { D1Database } from "@cloudflare/workers-types";
import type { FieldType } from "./dynamic-tables";
import { parseFieldSettings } from "./computed-fields";
import {
  extractFormulaFieldReferences,
  inferFormulaNumberDecimalPlaces,
  mapFieldTypeToFormulaNullable,
  mapFieldTypeToFormulaType,
  validateFormulaType,
} from "./formula-types";
import { evaluateFormula } from "./formula-engine";

export class FieldConfigurationError extends Error {
  constructor(public readonly code: string, detail: string) {
    super(detail);
  }
}

const ERROR_DETAILS: Record<string, string> = {
  ERROR_GENERATIVE_AI_DOES_NOT_EXIST: "The selected generative AI type does not exist or is not enabled for this workspace.",
  ERROR_MODEL_DOES_NOT_BELONG_TO_TYPE: "The selected model does not belong to the generative AI type.",
  ERROR_GENERATIVE_AI_DOES_NOT_SUPPORT_FILE_FIELD: "The selected generative AI type does not support a file field.",
  ERROR_FIELD_DOES_NOT_EXIST: "The selected field does not exist.",
  ERROR_INVALID_COUNT_THROUGH_FIELD: "The provided through field does not exist, is in a different table or is not a link row field.",
  ERROR_INVALID_LOOKUP_THROUGH_FIELD: "The provided through field does not exist, is in a different table or is not a link row field.",
  ERROR_INVALID_LOOKUP_TARGET_FIELD: "The provided target field does not exist or is in a different table to the table linked to by the through field.",
  ERROR_INVALID_ROLLUP_THROUGH_FIELD: "The provided through field does not exist, is in a different table or is not a link row field.",
  ERROR_INVALID_ROLLUP_TARGET_FIELD: "The provided target field does not exist or is in a different table to the table linked to by the through field.",
  ERROR_INVALID_ROLLUP_FORMULA_FUNCTION: "The provided rollup formula function does not exist.",
  ERROR_LINK_ROW_TABLE_NOT_PROVIDED: "The link_row_table argument must be provided when creating a link_row field.",
  ERROR_LINK_ROW_TABLE_NOT_IN_SAME_DATABASE: "The link row table is not in the same database as the source table.",
  ERROR_SELF_REFERENCING_LINK_ROW_CANNOT_HAVE_RELATED_FIELD: "A self referencing link row cannot have a related field.",
  ERROR_VIEW_DOES_NOT_EXIST: "The provided view does not exist.",
  ERROR_VIEW_NOT_IN_TABLE: "The provided view does not belong to the linked table.",
};

const ROLLUP_FUNCTIONS = new Set([
  "any",
  "every",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "stddev_pop",
  "stddev_sample",
  "variance_pop",
  "variance_sample",
]);

const NUMBER_SEPARATORS = new Set(["", "SPACE_COMMA", "SPACE_PERIOD", "COMMA_PERIOD", "PERIOD_COMMA"]);
const RATING_STYLES = new Set(["star", "heart", "thumbs-up", "flag", "smile"]);
const DURATION_FORMATS = new Set([
  "h:mm", "h:mm:ss", "h:mm:ss.s", "h:mm:ss.ss", "h:mm:ss.sss",
  "d h", "d h:mm", "d h:mm:ss", "d h mm", "d h mm ss",
]);
const DATE_FORMATS = new Set(["EU", "US", "ISO"]);
const DATE_TIME_FORMATS = new Set(["12", "24"]);
const AI_OUTPUT_TYPES = new Set(["text", "choice"]);
const AI_TYPES_WITH_FILES = new Set(["openai"]);

type FieldValidationContext = {
  enabledGenerativeAIModels?: Record<string, string[]>;
  actorUserId?: number | null;
};

function invalidFieldSetting(field: string, detail: string): never {
  throw new FieldConfigurationError("ERROR_REQUEST_BODY_VALIDATION", `${field}: ${detail}`);
}

export async function validateComputedFieldSettings(
  db: D1Database,
  tableId: number,
  type: FieldType,
  existingSettings: Record<string, unknown>,
  inputSettings: Record<string, unknown>,
  currentFieldId?: number,
  context: FieldValidationContext = {}
): Promise<Record<string, unknown>> {
  const settings = { ...existingSettings, ...inputSettings };
  if (type === "number") {
    const decimalPlaces = Number(settings.number_decimal_places ?? 0);
    if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 10) {
      invalidFieldSetting("number_decimal_places", "Ensure this value is between 0 and 10.");
    }
    const prefix = String(settings.number_prefix ?? "");
    const suffix = String(settings.number_suffix ?? "");
    const separator = String(settings.number_separator ?? "");
    if (prefix.length > 10) invalidFieldSetting("number_prefix", "Ensure this field has no more than 10 characters.");
    if (suffix.length > 100) invalidFieldSetting("number_suffix", "Ensure this field has no more than 100 characters.");
    if (!NUMBER_SEPARATORS.has(separator)) invalidFieldSetting("number_separator", "Invalid number separator.");
    const defaultValue = settings.number_default;
    if (defaultValue !== null && defaultValue !== undefined && defaultValue !== "") {
      const numericDefault = Number(defaultValue);
      if (!Number.isFinite(numericDefault)) invalidFieldSetting("number_default", "A valid number is required.");
      if (settings.number_negative !== true && numericDefault < 0) {
        invalidFieldSetting("number_default", "The default value cannot be negative.");
      }
    }
    return {
      ...settings,
      number_decimal_places: decimalPlaces,
      number_negative: settings.number_negative === true,
      number_prefix: prefix,
      number_suffix: suffix,
      number_separator: separator,
      number_default: defaultValue === "" || defaultValue === undefined ? null : defaultValue,
    };
  }
  if (type === "rating") {
    const maxValue = Number(settings.max_value ?? 5);
    const color = String(settings.color ?? "dark-orange");
    const style = String(settings.style ?? "star");
    if (!Number.isInteger(maxValue) || maxValue < 1 || maxValue > 10) {
      invalidFieldSetting("max_value", "Ensure this value is between 1 and 10.");
    }
    if (!color) invalidFieldSetting("color", "This field may not be blank.");
    if (!RATING_STYLES.has(style)) invalidFieldSetting("style", "Invalid rating style.");
    return { ...settings, max_value: maxValue, color, style };
  }
  if (type === "duration") {
    const durationFormat = String(settings.duration_format ?? "h:mm");
    if (!DURATION_FORMATS.has(durationFormat)) invalidFieldSetting("duration_format", "Invalid duration format.");
    return { ...settings, duration_format: durationFormat };
  }
  if (type === "date") {
    const dateFormat = String(settings.date_format ?? "EU").toUpperCase();
    const timeFormat = String(settings.date_time_format ?? "24");
    if (!DATE_FORMATS.has(dateFormat)) invalidFieldSetting("date_format", "Invalid date format.");
    if (!DATE_TIME_FORMATS.has(timeFormat)) invalidFieldSetting("date_time_format", "Invalid time format.");
    const timezoneOffset = settings.date_force_timezone_offset;
    if (timezoneOffset !== null && timezoneOffset !== undefined) {
      if (currentFieldId === undefined) {
        invalidFieldSetting("date_force_timezone_offset", "This value is not allowed when creating a date field.");
      }
      if (!Number.isInteger(Number(timezoneOffset))) {
        invalidFieldSetting("date_force_timezone_offset", "A valid integer is required.");
      }
      if (settings.date_include_time !== true) {
        invalidFieldSetting("date_force_timezone_offset", "date_include_time must be set to true.");
      }
    }
    const { date_force_timezone_offset: _dateForceTimezoneOffset, ...storedSettings } = settings;
    return {
      ...storedSettings,
      date_format: dateFormat,
      date_include_time: settings.date_include_time === true,
      date_time_format: timeFormat,
      date_show_tzinfo: settings.date_show_tzinfo === true,
      date_force_timezone: settings.date_force_timezone ?? null,
    };
  }
  if (type === "long_text") {
    return { ...settings, long_text_enable_rich_text: settings.long_text_enable_rich_text === true };
  }
  if (type === "boolean") {
    return { ...settings, boolean_default: settings.boolean_default === true };
  }
  if (type === "autonumber" || type === "auto_number") {
    const viewId = settings.view_id === null || settings.view_id === undefined
      ? null
      : Number(settings.view_id);
    if (viewId) {
      const view = await db.prepare("SELECT table_id FROM database_view WHERE id=? AND trashed=0")
        .bind(viewId)
        .first<{ table_id: number }>();
      if (!view) throw fieldConfigError("ERROR_VIEW_DOES_NOT_EXIST");
      if (Number(view.table_id) !== tableId) throw fieldConfigError("ERROR_VIEW_NOT_IN_TABLE");
    }
    return { ...settings, view_id: viewId };
  }
  if (type === "link_row") {
    const sourceTable = await db.prepare(
      "SELECT id, database_id FROM database_table WHERE id=? AND trashed=0"
    ).bind(tableId).first<{ id: number; database_id: number }>();
    const targetTableId = Number(settings.link_row_table_id ?? settings.link_row_table ?? 0);
    if (!targetTableId) throw fieldConfigError("ERROR_LINK_ROW_TABLE_NOT_PROVIDED");
    const targetTable = await db.prepare(
      "SELECT id, database_id FROM database_table WHERE id=? AND trashed=0"
    ).bind(targetTableId).first<{ id: number; database_id: number }>();
    if (!targetTable || !sourceTable || targetTable.database_id !== sourceTable.database_id) {
      throw fieldConfigError("ERROR_LINK_ROW_TABLE_NOT_IN_SAME_DATABASE");
    }
    if (targetTableId === tableId && settings.has_related_field === true) {
      throw fieldConfigError("ERROR_SELF_REFERENCING_LINK_ROW_CANNOT_HAVE_RELATED_FIELD");
    }
    const viewId = settings.link_row_limit_selection_view_id === null || settings.link_row_limit_selection_view_id === undefined
      ? null
      : Number(settings.link_row_limit_selection_view_id);
    if (viewId) {
      const view = await db.prepare("SELECT table_id FROM database_view WHERE id=? AND trashed=0")
        .bind(viewId)
        .first<{ table_id: number }>();
      if (!view) throw fieldConfigError("ERROR_VIEW_DOES_NOT_EXIST");
      if (view.table_id !== targetTableId) throw fieldConfigError("ERROR_VIEW_NOT_IN_TABLE");
    }
    const { has_related_field, link_row_table, ...normalized } = settings;
    return {
      ...normalized,
      link_row_table_id: targetTableId,
      link_row_multiple_relationships: settings.link_row_multiple_relationships !== false,
      link_row_limit_selection_view_id: viewId,
    };
  }
  if (type === "ai") {
    const provider = settings.ai_generative_ai_type === null || settings.ai_generative_ai_type === undefined
      ? ""
      : String(settings.ai_generative_ai_type).trim();
    const model = settings.ai_generative_ai_model === null || settings.ai_generative_ai_model === undefined
      ? ""
      : String(settings.ai_generative_ai_model).trim();
    const outputType = String(settings.ai_output_type || "text");
    const enabledModels = context.enabledGenerativeAIModels || {};
    if (!provider || !Object.prototype.hasOwnProperty.call(enabledModels, provider)) {
      throw fieldConfigError("ERROR_GENERATIVE_AI_DOES_NOT_EXIST");
    }
    if (!model || !(enabledModels[provider] || []).includes(model)) {
      throw fieldConfigError("ERROR_MODEL_DOES_NOT_BELONG_TO_TYPE");
    }
    if (!AI_OUTPUT_TYPES.has(outputType)) {
      invalidFieldSetting("ai_output_type", "Invalid choice.");
    }
    const temperature = settings.ai_temperature === null || settings.ai_temperature === undefined
      ? null
      : Number(settings.ai_temperature);
    if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      invalidFieldSetting("ai_temperature", "Ensure this value is between 0 and 2.");
    }
    const rawPrompt = settings.ai_prompt;
    const prompt = rawPrompt && typeof rawPrompt === "object" && !Array.isArray(rawPrompt)
      ? String((rawPrompt as Record<string, unknown>).formula || "")
      : String(rawPrompt || "");
    if (prompt) {
      const evaluated = evaluateFormula(prompt, {});
      if (evaluated.error) {
        invalidFieldSetting("ai_prompt", evaluated.error);
      }
    }
    const fileFieldId = settings.ai_file_field_id === null || settings.ai_file_field_id === undefined
      ? null
      : Number(settings.ai_file_field_id);
    if (fileFieldId !== null) {
      const fileField = Number.isInteger(fileFieldId) && fileFieldId > 0
        ? await db.prepare(
          "SELECT id FROM database_field WHERE id=? AND table_id=? AND type='file' AND trashed=0"
        ).bind(fileFieldId, tableId).first<{ id: number }>()
        : null;
      if (!fileField) throw fieldConfigError("ERROR_FIELD_DOES_NOT_EXIST");
      if (!AI_TYPES_WITH_FILES.has(provider)) {
        throw fieldConfigError("ERROR_GENERATIVE_AI_DOES_NOT_SUPPORT_FILE_FIELD");
      }
    }
    const autoUpdate = settings.ai_auto_update === true;
    const autoUpdateWasEnabled = existingSettings.ai_auto_update === true;
    return {
      ...settings,
      ai_generative_ai_type: provider,
      ai_generative_ai_model: model,
      ai_output_type: outputType,
      ai_temperature: temperature,
      ai_prompt: { formula: prompt, mode: "simple", version: "0.1" },
      ai_file_field_id: fileFieldId,
      ai_auto_update: autoUpdate,
      ai_auto_update_user_id: autoUpdate && !autoUpdateWasEnabled
        ? context.actorUserId ?? null
        : autoUpdate
          ? settings.ai_auto_update_user_id ?? null
          : null,
    };
  }
  if (type === "count") {
    const through = await resolveThroughField(db, tableId, settings, "ERROR_INVALID_COUNT_THROUGH_FIELD");
    return {
      ...settings,
      through_field_id: through.id,
      formula_type: "number",
      array_formula_type: null,
      formula_type_error: null,
      nullable: false,
      number_decimal_places: 0,
    };
  }
  if (type === "lookup") {
    const through = await resolveThroughField(db, tableId, settings, "ERROR_INVALID_LOOKUP_THROUGH_FIELD");
    const target = await resolveTargetField(db, through.link_row_table_id, settings, "ERROR_INVALID_LOOKUP_TARGET_FIELD");
    const targetSettings = parseFieldSettings(target.field_settings);
    const targetFormulaType = mapFieldTypeToFormulaType(target.type, targetSettings);
    const subtypeSettings: Record<string, unknown> = {};
    for (const key of [
      "number_decimal_places", "number_prefix", "number_suffix", "number_separator",
      "date_format", "date_include_time", "date_time_format", "date_show_tzinfo", "date_force_timezone",
      "duration_format",
    ]) {
      const value = settings[key] ?? targetSettings[key];
      if (value !== undefined) subtypeSettings[key] = value;
    }
    if (targetFormulaType === "number") {
      const decimalPlaces = Number(subtypeSettings.number_decimal_places ?? 0);
      if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 10) {
        invalidFieldSetting("number_decimal_places", "Ensure this value is between 0 and 10.");
      }
      subtypeSettings.number_decimal_places = decimalPlaces;
    }
    return {
      ...settings,
      ...subtypeSettings,
      through_field_id: through.id,
      through_field_name: through.name,
      target_field_id: target.id,
      target_field_name: target.name,
      formula_type: "array",
      array_formula_type: targetFormulaType,
      formula_type_error: null,
      nullable: true,
    };
  }
  if (type === "rollup") {
    const rollupFunction = String(settings.rollup_function || "count").toLowerCase();
    if (!ROLLUP_FUNCTIONS.has(rollupFunction)) {
      throw fieldConfigError("ERROR_INVALID_ROLLUP_FORMULA_FUNCTION");
    }
    const through = await resolveThroughField(db, tableId, settings, "ERROR_INVALID_ROLLUP_THROUGH_FIELD");
    const target = await resolveTargetField(db, through.link_row_table_id, settings, "ERROR_INVALID_ROLLUP_TARGET_FIELD");
    const targetSettings = parseFieldSettings(target.field_settings);
    const targetFormulaType = mapFieldTypeToFormulaType(target.type, targetSettings);
    const numericOrDuration = targetFormulaType === "number" || targetFormulaType === "duration";
    const orderable = numericOrDuration || ["text", "url", "date"].includes(targetFormulaType);
    const compatible = rollupFunction === "count" ||
      (["sum", "avg", "stddev_pop", "stddev_sample", "variance_pop", "variance_sample"].includes(rollupFunction) && numericOrDuration) ||
      (["min", "max"].includes(rollupFunction) && orderable) ||
      (["any", "every"].includes(rollupFunction) && targetFormulaType === "boolean");
    if (!compatible) {
      throw fieldConfigError("ERROR_INVALID_ROLLUP_FORMULA_FUNCTION");
    }
    const formulaType = rollupFunction === "any" || rollupFunction === "every"
      ? "boolean"
      : rollupFunction === "count"
        ? "number"
        : rollupFunction === "min" || rollupFunction === "max"
          ? targetFormulaType
          : targetFormulaType === "duration" ? "duration" : "number";
    const normalized: Record<string, unknown> = {
      ...settings,
      through_field_id: through.id,
      target_field_id: target.id,
      rollup_function: rollupFunction,
      formula_type: formulaType,
      array_formula_type: null,
      formula_type_error: null,
      nullable: !["count", "sum"].includes(rollupFunction),
    };
    if (formulaType === "number") {
      const decimalPlaces = Number(settings.number_decimal_places ?? targetSettings.number_decimal_places ?? 0);
      if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 10) {
        invalidFieldSetting("number_decimal_places", "Ensure this value is between 0 and 10.");
      }
      normalized.number_decimal_places = decimalPlaces;
      normalized.number_prefix = String(settings.number_prefix ?? targetSettings.number_prefix ?? "");
      normalized.number_suffix = String(settings.number_suffix ?? targetSettings.number_suffix ?? "");
      normalized.number_separator = String(settings.number_separator ?? targetSettings.number_separator ?? "");
    }
    if (formulaType === "duration") {
      normalized.duration_format = settings.duration_format ?? targetSettings.duration_format ?? "h:mm";
    }
    if (formulaType === "date") {
      normalized.date_format = settings.date_format ?? targetSettings.date_format ?? "EU";
      normalized.date_include_time = settings.date_include_time ?? targetSettings.date_include_time ?? false;
      normalized.date_time_format = settings.date_time_format ?? targetSettings.date_time_format ?? "24";
    }
    const rollupFunctionChanged = Object.prototype.hasOwnProperty.call(inputSettings, "rollup_function") &&
      String(inputSettings.rollup_function || "count").toLowerCase() !== String(existingSettings.rollup_function || "count").toLowerCase();
    if (rollupFunctionChanged) {
      delete normalized.airtable_rollup_function;
      delete normalized.airtable_rollup_formula;
      delete normalized.airtable_rollup_separator;
      delete normalized.airtable_rollup_slice_start;
      delete normalized.airtable_rollup_slice_end;
      delete normalized.airtable_rollup_compact;
      delete normalized.airtable_rollup_flatten;
      delete normalized.airtable_rollup_unique;
    }
    return normalized;
  }
  if (type === "formula") {
    const formula = String(settings.formula || "");
    const fields = await db.prepare(
      `SELECT id, name, type, field_settings
       FROM database_field
       WHERE table_id=? AND trashed=0
       ORDER BY [order] ASC, id ASC`
    ).bind(tableId).all<{
      id: number;
      name: string;
      type: FieldType;
      field_settings: string | null;
    }>();
    const fieldTypes: Record<string, string> = {};
    const fieldNullables: Record<string, boolean> = {};
    const fieldDecimalPlaces: Record<string, number> = {};
    for (const field of fields.results || []) {
      if (field.id === currentFieldId) continue;
      const fieldSettings = parseFieldSettings(field.field_settings);
      const formulaType = mapFieldTypeToFormulaType(field.type, fieldSettings);
      const nullable = mapFieldTypeToFormulaNullable(field.type, fieldSettings);
      fieldTypes[field.name.toLowerCase()] = formulaType;
      fieldTypes[`field_${field.id}`] = formulaType;
      fieldNullables[field.name.toLowerCase()] = nullable;
      fieldNullables[`field_${field.id}`] = nullable;
      const decimalPlaces = Number(fieldSettings.number_decimal_places ?? 0);
      const normalizedDecimalPlaces = Number.isFinite(decimalPlaces)
        ? Math.min(10, Math.max(0, Math.trunc(decimalPlaces)))
        : 0;
      fieldDecimalPlaces[field.name.toLowerCase()] = normalizedDecimalPlaces;
      fieldDecimalPlaces[`field_${field.id}`] = normalizedDecimalPlaces;
    }
    const inferred = validateFormulaType(formula, fieldTypes, null, fieldNullables);
    if (inferred.formula_type === "invalid") {
      throw new FieldConfigurationError(
        "ERROR_WITH_FORMULA",
        `Error with formula: ${inferred.formula_type_error || "Invalid formula."}`
      );
    }
    if (currentFieldId && formulaCreatesCircularDependency(formula, currentFieldId, fields.results || [])) {
      throw new FieldConfigurationError(
        "ERROR_WITH_FORMULA",
        "Error with formula: Circular field dependency detected."
      );
    }
    const numberSettings: Record<string, unknown> = {};
    if (inferred.formula_type === "number") {
      const inferredDecimalPlaces = inferFormulaNumberDecimalPlaces(formula, fieldDecimalPlaces);
      const decimalPlaces = Object.prototype.hasOwnProperty.call(inputSettings, "number_decimal_places")
        ? Number(inputSettings.number_decimal_places)
        : inferredDecimalPlaces;
      if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 10) {
        invalidFieldSetting("number_decimal_places", "Ensure this value is between 0 and 10.");
      }
      const prefix = String(settings.number_prefix ?? "");
      const suffix = String(settings.number_suffix ?? "");
      const separator = String(settings.number_separator ?? "");
      if (prefix.length > 10) invalidFieldSetting("number_prefix", "Ensure this field has no more than 10 characters.");
      if (suffix.length > 100) invalidFieldSetting("number_suffix", "Ensure this field has no more than 100 characters.");
      if (!NUMBER_SEPARATORS.has(separator)) invalidFieldSetting("number_separator", "Invalid number separator.");
      numberSettings.number_decimal_places = decimalPlaces;
      numberSettings.number_prefix = prefix;
      numberSettings.number_suffix = suffix;
      numberSettings.number_separator = separator;
    }
    return {
      ...settings,
      formula,
      formula_type: inferred.formula_type,
      array_formula_type: inferred.array_formula_type,
      formula_type_error: null,
      nullable: inferred.nullable,
      ...numberSettings,
    };
  }
  return settings;
}

function formulaCreatesCircularDependency(
  formula: string,
  currentFieldId: number,
  fields: Array<{ id: number; name: string; type: FieldType; field_settings: string | null }>
): boolean {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const byName = new Map(fields.map((field) => [field.name.toLowerCase(), field]));
  const dependencies = (value: string) => extractFormulaFieldReferences(value)
    .map((reference) => reference.kind === "id"
      ? byId.get(reference.value)
      : byName.get(reference.value.toLowerCase()))
    .filter((field): field is (typeof fields)[number] => Boolean(field));

  const visiting = new Set<number>();
  const reachesCurrentField = (field: (typeof fields)[number]): boolean => {
    if (field.id === currentFieldId) return true;
    if (field.type !== "formula" || visiting.has(field.id)) return false;
    visiting.add(field.id);
    const settings = parseFieldSettings(field.field_settings);
    const reaches = typeof settings.formula === "string" && dependencies(settings.formula).some(reachesCurrentField);
    visiting.delete(field.id);
    return reaches;
  };

  return dependencies(formula).some(reachesCurrentField);
}

export function fieldConfigError(code: string): FieldConfigurationError {
  return new FieldConfigurationError(code, ERROR_DETAILS[code] || "Invalid field configuration.");
}

export async function revalidateComputedFieldSettings(db: D1Database, fieldId: number): Promise<boolean> {
  const field = await db.prepare(
    `SELECT id, table_id, type, field_settings
     FROM database_field
     WHERE id=? AND trashed=0`
  ).bind(fieldId).first<{
    id: number;
    table_id: number;
    type: FieldType;
    field_settings: string | null;
  }>();
  if (!field || !["formula", "count", "lookup", "rollup"].includes(field.type)) return false;
  const existingSettings = parseFieldSettings(field.field_settings);
  try {
    const settings = await validateComputedFieldSettings(
      db,
      field.table_id,
      field.type,
      existingSettings,
      {},
      field.id
    );
    await db.prepare("UPDATE database_field SET field_settings=?, updated_on=? WHERE id=?")
      .bind(JSON.stringify(settings), new Date().toISOString(), field.id)
      .run();
    return true;
  } catch (error) {
    if (error instanceof FieldConfigurationError) return false;
    throw error;
  }
}

async function resolveThroughField(
  db: D1Database,
  tableId: number,
  settings: Record<string, unknown>,
  errorCode: string
): Promise<{ id: number; name: string; link_row_table_id: number }> {
  const throughFieldId = settings.through_field_id === null || settings.through_field_id === undefined
    ? null
    : Number(settings.through_field_id);
  const throughFieldName = typeof settings.through_field_name === "string" ? settings.through_field_name : null;
  if (!throughFieldId && !throughFieldName) throw fieldConfigError(errorCode);

  const where = throughFieldId ? "id=?" : "name=?";
  const value = throughFieldId || throughFieldName;
  const row = await db.prepare(
    `SELECT id, name, field_settings
     FROM database_field
     WHERE table_id=? AND type='link_row' AND trashed=0 AND ${where}`
  ).bind(tableId, value).first<{ id: number; name: string; field_settings: string | null }>();
  if (!row) throw fieldConfigError(errorCode);

  const linkRowTableId = Number(parseFieldSettings(row.field_settings).link_row_table_id || 0);
  if (!linkRowTableId) throw fieldConfigError(errorCode);
  return { id: row.id, name: row.name, link_row_table_id: linkRowTableId };
}

async function resolveTargetField(
  db: D1Database,
  targetTableId: number,
  settings: Record<string, unknown>,
  errorCode: string
): Promise<{ id: number; name: string; type: FieldType; field_settings: string | null }> {
  const targetFieldId = settings.target_field_id === null || settings.target_field_id === undefined
    ? null
    : Number(settings.target_field_id);
  const targetFieldName = typeof settings.target_field_name === "string" ? settings.target_field_name : null;
  if (!targetFieldId && !targetFieldName) throw fieldConfigError(errorCode);

  const where = targetFieldId ? "id=?" : "name=?";
  const value = targetFieldId || targetFieldName;
  const row = await db.prepare(
    `SELECT id, name, type, field_settings
     FROM database_field
     WHERE table_id=? AND trashed=0 AND ${where}`
  ).bind(targetTableId, value).first<{ id: number; name: string; type: FieldType; field_settings: string | null }>();
  if (!row) throw fieldConfigError(errorCode);
  return row;
}
