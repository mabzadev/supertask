import { evaluateFormula, parseFormulaAst, type FormulaASTNode } from "./formula-engine";

export interface InferredFormulaType {
  type: string;
  result_type: string;
  formula_type: string;
  array_formula_type: string | null;
  error: string | null;
  formula_type_error: string | null;
  nullable: boolean;
}

export type FormulaTypeLookup = Record<string, string | undefined>;
export type FormulaNullableLookup = Record<string, boolean | undefined>;
export type FormulaFieldReference =
  | { kind: "name"; value: string }
  | { kind: "id"; value: number };

export type FormulaNumberDecimalPlacesLookup = Record<string, number | undefined>;

const NUMBER_MAX_DECIMAL_PLACES = 10;

const ZERO_DECIMAL_FUNCTIONS = new Set([
  "CEIL", "COUNT", "COUNTA", "COUNTALL", "DATE_DIFF", "DATEDIFF", "DAY", "EVEN", "FIND",
  "FLOOR", "GET_FILE_COUNT", "GET_FILE_SIZE", "GET_IMAGE_HEIGHT", "GET_IMAGE_WIDTH", "HOUR",
  "INT", "IS_EVEN", "IS_ODD", "LENGTH", "LEN", "MANY_TO_MANY_COUNT", "MINUTE", "MONTH",
  "MULTIPLE_SELECT_COUNT", "ODD", "ROW_ID", "SEARCH", "SECOND", "SIGN", "TOSECONDS", "TRUNC",
  "WEEKDAY", "YEAR",
]);

const FIRST_ARGUMENT_DECIMAL_FUNCTIONS = new Set([
  "ABS", "ARRAY_AGG", "ARRAY_AGG_NO_NESTING", "ARRAY_AGG_UNNESTING", "AVG", "AVERAGE",
  "ERROR_TO_NAN", "ERROR_TO_NULL", "EXP", "FILTER", "LN", "MAX", "MIN", "SQRT", "STDDEV_POP",
  "STDDEV_SAMPLE", "SUM", "VARIANCE_POP", "VARIANCE_SAMPLE",
]);

const MAX_ARGUMENT_DECIMAL_FUNCTIONS = new Set([
  "ADD", "GREATEST", "LEAST", "LOG", "MINUS", "MOD", "MULTIPLY", "POWER", "POW", "WHEN_EMPTY",
  "WHEN_NAN",
]);

function clampDecimalPlaces(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(NUMBER_MAX_DECIMAL_PLACES, Math.max(0, Math.trunc(parsed)));
}

function literalDecimalPlaces(node: FormulaASTNode): number | null {
  if (node.kind === "unop" && node.op === "NEG") return literalDecimalPlaces(node.operand);
  if (node.kind !== "literal" || typeof node.value !== "number") return null;
  const raw = String(node.raw ?? node.value);
  const decimal = raw.indexOf(".");
  return decimal === -1 ? 0 : Math.min(NUMBER_MAX_DECIMAL_PLACES, raw.length - decimal - 1);
}

function literalNumber(node: FormulaASTNode | undefined): number | null {
  if (!node) return null;
  if (node.kind === "unop" && node.op === "NEG") {
    const value = literalNumber(node.operand);
    return value === null ? null : -value;
  }
  return node.kind === "literal" && typeof node.value === "number" ? node.value : null;
}

function literalString(node: FormulaASTNode | undefined): string | null {
  return node?.kind === "literal" && typeof node.value === "string" ? node.value : null;
}

function numberDecimalPlacesForNode(
  node: FormulaASTNode,
  fieldDecimalPlaces: FormulaNumberDecimalPlacesLookup
): number {
  if (node.kind === "literal") return literalDecimalPlaces(node) ?? 0;
  if (node.kind === "field") return clampDecimalPlaces(fieldDecimalPlaces[node.name.toLowerCase()]);
  if (node.kind === "unop") return numberDecimalPlacesForNode(node.operand, fieldDecimalPlaces);
  if (node.kind === "binop") {
    if (node.op === "/") return NUMBER_MAX_DECIMAL_PLACES;
    if (["+", "-", "*", "%"].includes(node.op)) {
      return Math.max(
        numberDecimalPlacesForNode(node.left, fieldDecimalPlaces),
        numberDecimalPlacesForNode(node.right, fieldDecimalPlaces)
      );
    }
    return 0;
  }

  const fn = node.fn.toUpperCase();
  if (fn === "FIELD") {
    const name = literalString(node.args[0]);
    return name === null ? 0 : clampDecimalPlaces(fieldDecimalPlaces[name.toLowerCase()]);
  }
  if (fn === "FIELD_BY_ID") {
    const id = literalNumber(node.args[0]);
    return id === null ? 0 : clampDecimalPlaces(fieldDecimalPlaces[`field_${Math.trunc(id)}`]);
  }
  if (fn === "ROUND") {
    const places = literalNumber(node.args[1]);
    return places === null ? NUMBER_MAX_DECIMAL_PLACES : clampDecimalPlaces(places);
  }
  if (fn === "TONUMBER" || fn === "DIVIDE") return NUMBER_MAX_DECIMAL_PLACES;
  if (ZERO_DECIMAL_FUNCTIONS.has(fn)) return 0;
  if (fn === "IF") {
    return Math.max(...node.args.slice(1).map((arg) => numberDecimalPlacesForNode(arg, fieldDecimalPlaces)), 0);
  }
  if (FIRST_ARGUMENT_DECIMAL_FUNCTIONS.has(fn)) {
    return node.args[0] ? numberDecimalPlacesForNode(node.args[0], fieldDecimalPlaces) : 0;
  }
  if (MAX_ARGUMENT_DECIMAL_FUNCTIONS.has(fn)) {
    return Math.max(...node.args.map((arg) => numberDecimalPlacesForNode(arg, fieldDecimalPlaces)), 0);
  }
  return Math.max(...node.args.map((arg) => numberDecimalPlacesForNode(arg, fieldDecimalPlaces)), 0);
}

export function inferFormulaNumberDecimalPlaces(
  formula: string,
  fieldDecimalPlaces: FormulaNumberDecimalPlacesLookup = {}
): number {
  return clampDecimalPlaces(numberDecimalPlacesForNode(parseFormulaAst(formula), fieldDecimalPlaces));
}

const NUMBER_FUNCTIONS = new Set([
  "ABS", "ADD", "AVG", "AVERAGE", "CEIL", "COUNT", "COUNTA", "COUNTALL", "DATEDIFF", "DATE_DIFF",
  "DIVIDE", "EXP", "FLOOR", "GREATEST", "INT", "LEAST", "LEN", "LENGTH", "LN", "LOG", "LOG10",
  "MAX", "MIN", "MINUS", "MOD", "MULTIPLY", "POWER", "POW", "ROUND", "ROUNDDOWN", "ROUNDUP",
  "SEARCH", "FIND", "SIGN", "SQRT", "STDDEV_POP", "STDDEV_SAMPLE", "SUM", "TONUMBER",
  "TOSECONDS", "TRUNC", "VARIANCE_POP", "VARIANCE_SAMPLE", "YEAR", "MONTH", "DAY", "HOUR",
  "MINUTE", "SECOND", "WEEKDAY", "GET_FILE_COUNT", "GET_FILE_SIZE", "GET_IMAGE_WIDTH",
  "GET_IMAGE_HEIGHT", "ROW_ID", "ERROR_TO_NAN", "WHEN_NAN", "MANY_TO_MANY_COUNT", "MULTIPLE_SELECT_COUNT",
]);

const BOOLEAN_FUNCTIONS = new Set([
  "AND", "ANY", "CONTAINS", "EVERY", "EVEN", "ISBLANK", "ISNULL", "IS_NULL", "IS_NAN", "ODD", "OR",
  "REGEXMATCH", "REGEX_MATCH", "IS_IMAGE", "EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL",
  "HAS_OPTION", "LESS_THAN", "LESS_THAN_OR_EQUAL", "NOT", "NOT_EQUAL",
]);

const TEXT_FUNCTIONS = new Set([
  "ARRAYJOIN", "CONCAT", "CONCATENATE", "DATETIME_FORMAT", "DATETIME_FORMAT_TZ", "ENCODE_URI",
  "ENCODE_URI_COMPONENT", "GET_LINK_LABEL", "GET_LINK_URL", "GET_FILE_VISIBLE_NAME",
  "GET_FILE_MIME_TYPE", "JOIN", "LEFT", "LOWER", "MID", "REGEXREPLACE", "REGEX_REPLACE", "REPLACE",
  "REVERSE", "RIGHT", "SPLIT_PART", "SUBSTR", "SUBSTRING", "T", "TOTEXT", "TOVARCHAR", "TRIM",
  "UPPER", "WHEN_EMPTY", "GET_SINGLE_SELECT_VALUE", "JSONB_EXTRACT_PATH_TEXT",
  "STRING_AGG_MANY_TO_MANY_VALUES", "STRING_AGG_MULTIPLE_SELECT_VALUES",
]);

const DATE_FUNCTIONS = new Set(["BC_TO_NULL", "DATEADD", "DATEFORMAT", "NOW", "TODATE", "TODATE_TZ", "TODAY"]);

type StaticFormulaType = {
  type: string;
  arrayType?: string | null;
  dateHasTime?: boolean;
};

const TEXT_TYPES = new Set(["text", "url"]);
const DATE_TYPES = new Set(["date"]);
const DURATION_TYPES = new Set(["duration", "date_interval"]);

const SPECIAL_FUNCTIONS = new Set([
  "ARRAY_AGG", "ARRAY_AGG_NO_NESTING", "ARRAY_AGG_UNNESTING", "AT", "BUTTON", "DATE_INTERVAL",
  "ERROR_TO_NAN", "ERROR_TO_NULL", "FIELD", "FIELD_BY_ID", "FILTER", "IF", "INDEX", "LINK",
  "LOOKUP", "MANY_TO_MANY_AGG", "MULTIPLE_SELECT_OPTIONS_AGG", "TODURATION", "WHEN_EMPTY",
]);

const EXACT_ONE_TEXT_FUNCTIONS = new Set([
  "CAPITALIZE", "ENCODE_URI", "ENCODE_URI_COMPONENT", "LOWER", "REVERSE", "STRIP", "TOVARCHAR",
  "TOURL", "TRIM", "UPPER",
]);

const EXACT_ONE_NUMBER_FUNCTIONS = new Set([
  "ABS", "CEIL", "EVEN", "EXP", "FLOOR", "INT", "IS_NAN", "LN", "ODD", "SIGN", "SQRT",
  "TODURATION", "TRUNC",
]);

const EXACT_TWO_NUMBER_FUNCTIONS = new Set([
  "ADD", "DIVIDE", "LOG", "MINUS", "MOD", "MULTIPLY", "POWER", "POW", "ROUND", "WHEN_NAN",
]);

function staticType(type: string, arrayType: string | null = null, dateHasTime?: boolean): StaticFormulaType {
  return { type, arrayType, dateHasTime };
}

function staticError(message: string): never {
  throw new Error(message);
}

function expectArity(fn: string, args: FormulaASTNode[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    const expected = min === max ? `exactly ${min}` : `${min} to ${max}`;
    staticError(`${fn.toLowerCase()} must receive ${expected} argument${max === 1 ? "" : "s"}.`);
  }
}

function isTextType(type: StaticFormulaType): boolean {
  return TEXT_TYPES.has(type.type);
}

function isNumberType(type: StaticFormulaType): boolean {
  return type.type === "number";
}

function isArrayType(type: StaticFormulaType): boolean {
  return type.type === "array" || ["file", "multiple_select", "multiple_collaborators"].includes(type.type);
}

function requireType(fn: string, actual: StaticFormulaType, allowed: string, valid: boolean): void {
  if (!valid) staticError(`${fn.toLowerCase()} received ${actual.type}, but requires ${allowed}.`);
}

function inferStaticNode(
  node: FormulaASTNode,
  fieldTypes: FormulaTypeLookup,
  lookupArrayFormulaType?: string | null
): StaticFormulaType {
  if (node.kind === "literal") {
    if (node.value === null) return staticType("null");
    if (typeof node.value === "number") return staticType("number");
    if (typeof node.value === "boolean") return staticType("boolean");
    return staticType("text");
  }
  if (node.kind === "field") {
    const type = fieldTypes[node.name.toLowerCase()];
    if (!type) staticError(`The field "${node.name}" does not exist.`);
    if (type === "invalid") staticError(`The field "${node.name}" has an invalid formula type.`);
    return staticType(type);
  }
  if (node.kind === "unop") {
    const operand = inferStaticNode(node.operand, fieldTypes, lookupArrayFormulaType);
    if (node.op === "NOT") {
      requireType("not", operand, "boolean", operand.type === "boolean");
      return staticType("boolean");
    }
    requireType("minus", operand, "number or duration", isNumberType(operand) || DURATION_TYPES.has(operand.type));
    return operand;
  }
  if (node.kind === "binop") {
    const left = inferStaticNode(node.left, fieldTypes, lookupArrayFormulaType);
    const right = inferStaticNode(node.right, fieldTypes, lookupArrayFormulaType);
    if (node.op === "AND" || node.op === "OR") {
      requireType(node.op, left, "boolean", left.type === "boolean");
      requireType(node.op, right, "boolean", right.type === "boolean");
      return staticType("boolean");
    }
    if (node.op === "=" || node.op === "!=") return staticType("boolean");
    if (["<", "<=", ">", ">="].includes(node.op)) {
      const compatible = left.type === right.type && (
        isNumberType(left) || isTextType(left) || DATE_TYPES.has(left.type) || DURATION_TYPES.has(left.type)
      );
      requireType(node.op, right, left.type, compatible);
      return staticType("boolean");
    }
    if (node.op === "+") {
      if (isNumberType(left) && isNumberType(right)) return staticType("number");
      if (isTextType(left) && isTextType(right)) return staticType("text");
      if (left.type === "date" && DURATION_TYPES.has(right.type)) return staticType("date", null, left.dateHasTime);
      if (right.type === "date" && DURATION_TYPES.has(left.type)) return staticType("date", null, right.dateHasTime);
      if (DURATION_TYPES.has(left.type) && DURATION_TYPES.has(right.type)) return staticType("duration");
      staticError(`Operator + is not compatible with ${left.type} and ${right.type}.`);
    }
    if (node.op === "-") {
      if (isNumberType(left) && isNumberType(right)) return staticType("number");
      if (left.type === "date" && right.type === "date") return staticType("duration");
      if (left.type === "date" && DURATION_TYPES.has(right.type)) return staticType("date", null, left.dateHasTime);
      if (DURATION_TYPES.has(left.type) && DURATION_TYPES.has(right.type)) return staticType("duration");
      staticError(`Operator - is not compatible with ${left.type} and ${right.type}.`);
    }
    if (node.op === "*") {
      if (isNumberType(left) && isNumberType(right)) return staticType("number");
      if (DURATION_TYPES.has(left.type) && isNumberType(right)) return staticType("duration");
      if (isNumberType(left) && DURATION_TYPES.has(right.type)) return staticType("duration");
      staticError(`Operator * is not compatible with ${left.type} and ${right.type}.`);
    }
    if (node.op === "/") {
      if (isNumberType(left) && isNumberType(right)) return staticType("number");
      if (DURATION_TYPES.has(left.type) && isNumberType(right)) return staticType("duration");
      staticError(`Operator / is not compatible with ${left.type} and ${right.type}.`);
    }
    if (node.op === "%") {
      if (isNumberType(left) && isNumberType(right)) return staticType("number");
      staticError(`Operator % is not compatible with ${left.type} and ${right.type}.`);
    }
    staticError(`Unknown operator ${node.op}.`);
  }

  const fn = node.fn.toUpperCase();
  if (fn === "ERROR_TO_NAN") {
    expectArity(fn, node.args, 1);
    return staticType("number");
  }
  if (fn === "ERROR_TO_NULL") {
    expectArity(fn, node.args, 1);
    return inferStaticNode(node.args[0], fieldTypes, lookupArrayFormulaType);
  }
  if (fn === "FIELD" || fn === "FIELD_BY_ID") {
    expectArity(fn, node.args, 1);
    const argument = node.args[0];
    if (argument.kind !== "literal") staticError(`${fn.toLowerCase()} requires a literal field identifier.`);
    const key = fn === "FIELD_BY_ID" ? `field_${String(argument.value)}` : String(argument.value).toLowerCase();
    const type = fieldTypes[key];
    if (!type) staticError(`The field ${String(argument.value)} does not exist.`);
    if (type === "invalid") staticError(`The field ${String(argument.value)} has an invalid formula type.`);
    return staticType(type);
  }

  const args = node.args.map((arg) => inferStaticNode(arg, fieldTypes, lookupArrayFormulaType));
  if (fn === "CONCAT" || fn === "CONCATENATE") {
    if (args.length < 2) staticError("concat must receive more than one argument.");
    return staticType("text");
  }
  if (fn === "IF") {
    expectArity(fn, node.args, 3);
    requireType(fn, args[0], "boolean", args[0].type === "boolean");
    if (args[1].type === args[2].type) return args[1];
    if ((isTextType(args[1]) && isNumberType(args[2])) || (isNumberType(args[1]) && isTextType(args[2]))) {
      return staticType("text");
    }
    return staticType("text");
  }
  if (fn === "WHEN_EMPTY") {
    expectArity(fn, node.args, 2);
    if (args[0].type !== args[1].type) staticError("both inputs for when_empty must be the same type");
    return args[0];
  }
  if (EXACT_ONE_TEXT_FUNCTIONS.has(fn)) {
    expectArity(fn, node.args, 1);
    requireType(fn, args[0], "text", isTextType(args[0]));
    return fn === "TOURL" ? staticType("url") : staticType("text");
  }
  if (fn === "REGEX_REPLACE" || fn === "REGEXREPLACE") {
    expectArity(fn, node.args, 3);
    args.forEach((arg) => requireType(fn, arg, "text", isTextType(arg)));
    return staticType("text");
  }
  if (fn === "LINK") {
    expectArity(fn, node.args, 1, 2);
    args.forEach((arg) => requireType(fn, arg, "text", isTextType(arg)));
    return staticType("link");
  }
  if (fn === "BUTTON") {
    expectArity(fn, node.args, 2);
    args.forEach((arg) => requireType(fn, arg, "text", isTextType(arg)));
    return staticType("button");
  }
  if (fn === "GET_LINK_LABEL" || fn === "GET_LINK_URL") {
    expectArity(fn, node.args, 1);
    requireType(fn, args[0], "link", args[0].type === "link" || args[0].type === "button");
    return staticType("text");
  }
  if (fn === "TODATE" || fn === "TODATE_TZ") {
    expectArity(fn, node.args, fn === "TODATE" ? 2 : 3);
    args.forEach((arg) => requireType(fn, arg, "text", isTextType(arg)));
    return staticType("date", null, fn === "TODATE_TZ");
  }
  if (fn === "NOW") {
    expectArity(fn, node.args, 0);
    return staticType("date", null, true);
  }
  if (fn === "TODAY") {
    expectArity(fn, node.args, 0);
    return staticType("date", null, false);
  }
  if (fn === "SECOND") {
    expectArity(fn, node.args, 1);
    requireType(fn, args[0], "date with time", args[0].type === "date" && args[0].dateHasTime !== false);
    return staticType("number");
  }
  if (fn === "DATE_INTERVAL") {
    expectArity(fn, node.args, 1);
    requireType(fn, args[0], "text", isTextType(args[0]));
    return staticType("date_interval");
  }
  if (EXACT_ONE_NUMBER_FUNCTIONS.has(fn)) {
    expectArity(fn, node.args, 1);
    requireType(fn, args[0], "number", isNumberType(args[0]));
    return fn === "TODURATION" ? staticType("duration") : staticType("number");
  }
  if (EXACT_TWO_NUMBER_FUNCTIONS.has(fn)) {
    expectArity(fn, node.args, 2);
    args.forEach((arg) => requireType(fn, arg, "number", isNumberType(arg)));
    return staticType("number");
  }
  if (["SUM", "AVG", "AVERAGE", "MIN", "MAX", "STDDEV_POP", "STDDEV_SAMPLE", "VARIANCE_POP", "VARIANCE_SAMPLE"].includes(fn)) {
    expectArity(fn, node.args, 1);
    requireType(fn, args[0], "an array", isArrayType(args[0]));
    return staticType("number");
  }
  if (fn === "LOOKUP" || fn === "FILTER") return staticType("array", lookupArrayFormulaType || "text");
  if (["ARRAY_AGG", "ARRAY_AGG_NO_NESTING", "ARRAY_AGG_UNNESTING", "MANY_TO_MANY_AGG", "MULTIPLE_SELECT_OPTIONS_AGG"].includes(fn)) {
    expectArity(fn, node.args, 1);
    const itemType = args[0].type === "array" ? args[0].arrayType || "text" : args[0].type;
    return staticType("array", itemType);
  }

  const known = NUMBER_FUNCTIONS.has(fn) || BOOLEAN_FUNCTIONS.has(fn) || TEXT_FUNCTIONS.has(fn) ||
    DATE_FUNCTIONS.has(fn) || SPECIAL_FUNCTIONS.has(fn);
  if (!known) staticError(`Unknown function: ${fn}`);
  if (NUMBER_FUNCTIONS.has(fn)) return staticType("number");
  if (BOOLEAN_FUNCTIONS.has(fn)) return staticType("boolean");
  if (TEXT_FUNCTIONS.has(fn)) return staticType("text");
  if (DATE_FUNCTIONS.has(fn)) return staticType("date");
  return staticType("text");
}

function inferStaticNullable(
  node: FormulaASTNode,
  fieldTypes: FormulaTypeLookup,
  fieldNullables: FormulaNullableLookup,
  lookupArrayFormulaType?: string | null
): boolean {
  if (node.kind === "literal") return node.value === null;
  if (node.kind === "field") return fieldNullables[node.name.toLowerCase()] ?? true;
  if (node.kind === "unop") {
    const resultType = inferStaticNode(node, fieldTypes, lookupArrayFormulaType);
    return DATE_TYPES.has(resultType.type) || DURATION_TYPES.has(resultType.type);
  }
  if (node.kind === "binop") {
    if (["AND", "OR", "=", "!=", "<", "<=", ">", ">="].includes(node.op)) return false;
    const resultType = inferStaticNode(node, fieldTypes, lookupArrayFormulaType);
    return DATE_TYPES.has(resultType.type) || DURATION_TYPES.has(resultType.type);
  }

  const fn = node.fn.toUpperCase();
  if (fn === "FIELD" || fn === "FIELD_BY_ID") {
    const argument = node.args[0];
    if (!argument || argument.kind !== "literal") return true;
    const key = fn === "FIELD_BY_ID" ? `field_${String(argument.value)}` : String(argument.value).toLowerCase();
    return fieldNullables[key] ?? true;
  }
  if (fn === "IF" && node.args.length === 3) {
    return inferStaticNullable(node.args[1], fieldTypes, fieldNullables, lookupArrayFormulaType) ||
      inferStaticNullable(node.args[2], fieldTypes, fieldNullables, lookupArrayFormulaType);
  }
  if (fn === "WHEN_EMPTY" && node.args.length === 2) {
    return inferStaticNullable(node.args[0], fieldTypes, fieldNullables, lookupArrayFormulaType) &&
      inferStaticNullable(node.args[1], fieldTypes, fieldNullables, lookupArrayFormulaType);
  }
  if (fn === "ERROR_TO_NULL") return true;
  if (fn === "ERROR_TO_NAN") return false;
  if ([
    "ISBLANK", "ISNULL", "IS_NULL", "IS_NAN", "TOTEXT", "TOVARCHAR", "TONUMBER",
  ].includes(fn)) return false;
  if ([
    "TODATE", "TODATE_TZ", "DATE_INTERVAL", "TODURATION", "BC_TO_NULL", "DATEADD", "DATEFORMAT",
    "DAY", "MONTH", "YEAR", "HOUR", "MINUTE", "SECOND", "WEEKDAY",
  ].includes(fn)) return true;

  const resultType = inferStaticNode(node, fieldTypes, lookupArrayFormulaType);
  return DATE_TYPES.has(resultType.type) || DURATION_TYPES.has(resultType.type) || resultType.type === "array";
}

export function inferFormulaNullable(
  formula: string,
  fieldTypes: FormulaTypeLookup = {},
  fieldNullables: FormulaNullableLookup = {},
  lookupArrayFormulaType?: string | null
): boolean {
  const ast = parseFormulaAst(formula);
  inferStaticNode(ast, fieldTypes, lookupArrayFormulaType);
  return inferStaticNullable(ast, fieldTypes, fieldNullables, lookupArrayFormulaType);
}

export function extractFormulaFieldReferences(formula: string): FormulaFieldReference[] {
  const references = new Map<string, FormulaFieldReference>();
  const visit = (node: FormulaASTNode): void => {
    if (node.kind === "field") {
      const value = node.name.trim();
      references.set(`name:${value.toLowerCase()}`, { kind: "name", value });
      return;
    }
    if (node.kind === "binop") {
      visit(node.left);
      visit(node.right);
      return;
    }
    if (node.kind === "unop") {
      visit(node.operand);
      return;
    }
    if (node.kind !== "call") return;
    const fn = node.fn.toUpperCase();
    const argument = node.args[0];
    if ((fn === "FIELD" || fn === "FIELD_BY_ID") && argument?.kind === "literal") {
      if (fn === "FIELD_BY_ID") {
        const value = Number(argument.value);
        if (Number.isInteger(value) && value > 0) references.set(`id:${value}`, { kind: "id", value });
      } else {
        const value = String(argument.value).trim();
        references.set(`name:${value.toLowerCase()}`, { kind: "name", value });
      }
    }
    node.args.forEach(visit);
  };
  visit(parseFormulaAst(formula));
  return [...references.values()];
}

export function validateFormulaType(
  formula: string,
  fieldTypes: FormulaTypeLookup = {},
  lookupArrayFormulaType?: string | null,
  fieldNullables: FormulaNullableLookup = {}
): InferredFormulaType {
  try {
    const ast = parseFormulaAst(formula);
    const inferred = inferStaticNode(ast, fieldTypes, lookupArrayFormulaType);
    const nullable = inferStaticNullable(ast, fieldTypes, fieldNullables, lookupArrayFormulaType);
    return formulaType(inferred.type, inferred.arrayType || null, null, nullable);
  } catch (error: any) {
    return formulaType("invalid", null, String(error?.message || error));
  }
}

export function inferFormulaType(
  formula: string,
  value: unknown,
  error: string | null,
  fieldTypes: FormulaTypeLookup = {},
  lookupArrayFormulaType?: string | null
): InferredFormulaType {
  if (error) return formulaType("invalid", null, error);

  const root = rootFunctionName(formula);
  const rootFieldType = root === "FIELD" ? fieldTypes[firstStringArgument(formula).toLowerCase()] : undefined;
  const fieldByIdType = root === "FIELD_BY_ID" ? fieldTypes[`field_${firstNumericArgument(formula)}`] : undefined;
  const directFieldType = directFieldReference(formula);

  if (root === "BUTTON") return formulaType("button");
  if (root === "LINK") return formulaType("link");
  if (root === "TOURL") return formulaType("url");
  if (root === "TODURATION") return formulaType("duration");
  if (root === "DATE_INTERVAL") return formulaType("date_interval");
  if (root === "ERROR_TO_NULL") {
    const inner = firstFunctionArgumentExpression(formula);
    if (inner) return inferFormulaType(inner, value, null, fieldTypes, lookupArrayFormulaType);
  }
  if (root === "IF") {
    const args = functionArgumentExpressions(formula);
    if (args.length >= 3) {
      const thenType = inferFormulaArgumentType(args[1], fieldTypes, lookupArrayFormulaType);
      const elseType = inferFormulaArgumentType(args[2], fieldTypes, lookupArrayFormulaType);
      if (thenType.formula_type_error) return thenType;
      if (elseType.formula_type_error) return elseType;
      if (sameFormulaType(thenType, elseType)) {
        return formulaType(thenType.formula_type, thenType.array_formula_type);
      }
      return formulaType("text");
    }
  }
  if (root === "WHEN_EMPTY") {
    const args = functionArgumentExpressions(formula);
    if (args.length >= 2) {
      const firstType = inferFormulaArgumentType(args[0], fieldTypes, lookupArrayFormulaType);
      const fallbackType = inferFormulaArgumentType(args[1], fieldTypes, lookupArrayFormulaType);
      if (firstType.formula_type_error) return firstType;
      if (fallbackType.formula_type_error) return fallbackType;
      if (!sameFormulaType(firstType, fallbackType)) {
        return formulaType("invalid", null, "both inputs for when_empty must be the same type");
      }
      return formulaType(firstType.formula_type, firstType.array_formula_type);
    }
  }
  if (["ARRAY_AGG", "ARRAY_AGG_NO_NESTING", "MANY_TO_MANY_AGG", "MULTIPLE_SELECT_OPTIONS_AGG"].includes(root)) {
    const argType = inferFormulaArgumentType(firstFunctionArgumentExpression(formula), fieldTypes, lookupArrayFormulaType);
    if (argType.formula_type_error) return argType;
    return formulaType("array", argType.formula_type === "array" ? argType.array_formula_type : argType.formula_type);
  }
  if (root === "ARRAY_AGG_UNNESTING") {
    const argType = inferFormulaArgumentType(firstFunctionArgumentExpression(formula), fieldTypes, lookupArrayFormulaType);
    if (argType.formula_type_error) return argType;
    return argType.formula_type === "array"
      ? formulaType("array", argType.array_formula_type || "text")
      : formulaType("array", argType.formula_type);
  }
  if (root === "LOOKUP" || root === "FILTER") return formulaType("array", lookupArrayFormulaType || "text");
  if (rootFieldType) return formulaType(rootFieldType);
  if (fieldByIdType) return formulaType(fieldByIdType);
  if (directFieldType && fieldTypes[directFieldType.toLowerCase()]) {
    return formulaType(fieldTypes[directFieldType.toLowerCase()]!);
  }
  if (NUMBER_FUNCTIONS.has(root)) return formulaType("number");
  if (BOOLEAN_FUNCTIONS.has(root)) return formulaType("boolean");
  if (TEXT_FUNCTIONS.has(root)) return formulaType("text");
  if (DATE_FUNCTIONS.has(root)) return formulaType("date");

  if (Array.isArray(value)) return formulaType("array", inferArrayFormulaType(value, lookupArrayFormulaType));
  if (isLinkValue(value)) return formulaType("link");
  if (typeof value === "number") return formulaType("number");
  if (typeof value === "boolean") return formulaType("boolean");
  return formulaType("text");
}

export function mapFieldTypeToFormulaType(type: string, settings: Record<string, unknown> = {}): string {
  if (type === "formula" || type === "lookup" || type === "rollup") {
    return String(settings.array_formula_type || settings.formula_type || "text");
  }
  if (["number", "rating", "count", "autonumber"].includes(type)) return "number";
  if (["date", "created_on", "last_modified"].includes(type)) return "date";
  if (type === "boolean") return "boolean";
  if (type === "duration") return "duration";
  if (type === "url") return "url";
  if (type === "file") return "file";
  if (type === "single_select") return "single_select";
  if (type === "multiple_select") return "multiple_select";
  if (type === "multiple_collaborators") return "multiple_collaborators";
  if (type === "link_row") return "text";
  return "text";
}

export function mapFieldTypeToFormulaNullable(type: string, settings: Record<string, unknown> = {}): boolean {
  if (["count", "autonumber", "auto_number", "uuid", "created_on", "last_modified"].includes(type)) return false;
  if (["formula", "lookup", "rollup"].includes(type)) return settings.nullable !== false;
  return true;
}

export function extractLookupReferences(formula: string): Array<{ throughFieldName: string; targetFieldName: string }> {
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

function formulaType(
  formulaType: string,
  arrayFormulaType: string | null = null,
  error: string | null = null,
  nullable = false
): InferredFormulaType {
  return {
    type: formulaType,
    result_type: formulaType,
    formula_type: formulaType,
    array_formula_type: formulaType === "array" ? arrayFormulaType || "text" : null,
    error,
    formula_type_error: error,
    nullable,
  };
}

function rootFunctionName(formula: string): string {
  return formula.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/)?.[1]?.toUpperCase() || "";
}

function firstStringArgument(formula: string): string {
  return formula.match(/\(\s*(["'])(.*?)\1/)?.[2] || "";
}

function firstNumericArgument(formula: string): string {
  return formula.match(/\(\s*(\d+)/)?.[1] || "";
}

function firstFunctionArgumentExpression(formula: string): string {
  return functionArgumentExpressions(formula)[0] || "";
}

function functionArgumentExpressions(formula: string): string[] {
  const open = formula.indexOf("(");
  if (open === -1) return [];
  const args: string[] = [];
  let start = open + 1;
  let depth = 0;
  let quote = "";
  for (let i = open + 1; i < formula.length; i += 1) {
    const char = formula[i];
    if (quote) {
      if (char === "\\" && i + 1 < formula.length) {
        i += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) {
        const value = formula.slice(start, i).trim();
        if (value) args.push(value);
        return args;
      }
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(formula.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

function directFieldReference(formula: string): string | null {
  return formula.trim().match(/^\{\s*(.*?)\s*\}$/)?.[1] || null;
}

function inferFormulaArgumentType(
  formula: string,
  fieldTypes: FormulaTypeLookup,
  lookupArrayFormulaType?: string | null
): InferredFormulaType {
  const result = evaluateFormula(formula, {});
  return inferFormulaType(formula, result.value, result.error, fieldTypes, lookupArrayFormulaType);
}

function sameFormulaType(left: InferredFormulaType, right: InferredFormulaType): boolean {
  return left.formula_type === right.formula_type && left.array_formula_type === right.array_formula_type;
}

function inferArrayFormulaType(value: unknown[], fallback?: string | null): string {
  const firstValue = value.find((item) => item !== null && item !== undefined);
  if (firstValue === undefined) return fallback || "text";
  if (isLinkValue(firstValue)) return "link";
  if (typeof firstValue === "number") return "number";
  if (typeof firstValue === "boolean") return "boolean";
  return fallback || "text";
}

function isLinkValue(value: unknown): boolean {
  return value !== null && typeof value === "object" && typeof (value as { url?: unknown }).url === "string";
}
