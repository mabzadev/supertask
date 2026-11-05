/**
 * formula-engine.ts — Supertask Formula Engine (TypeScript)
 *
 * Implements the Cloudflare formula runtime used by the active Baserow frontend:
 *   - Literals: "text", 123, true, false
 *   - Field references: field('Name') or {Name}
 *   - Arithmetic: +, -, *, /
 *   - Comparison: =, !=, <, <=, >, >=
 *   - Boolean: AND, OR, NOT
 *   - Functions: IF, CONCAT, UPPER, LOWER, TRIM, LEN, LEFT, RIGHT, MID,
 *                ADD, MINUS, MULTIPLY, DIVIDE, MOD, ROUND, CEIL, FLOOR,
 *                ABS, POWER, SQRT, LOG,
 *                YEAR, MONTH, DAY, NOW, TODAY, DATEADD, DATEDIFF,
 *                ISBLANK, ISNULL, TONUMBER, TOTEXT, TODATE,
 *                LINK, BUTTON, GET_LINK_URL, GET_LINK_LABEL,
 *                JOIN, FILTER, ANY, EVERY, INDEX,
 *                GET_FILE_VISIBLE_NAME, GET_FILE_MIME_TYPE, GET_FILE_COUNT,
 *                GET_FILE_SIZE, GET_IMAGE_WIDTH, GET_IMAGE_HEIGHT, IS_IMAGE,
 *                ROW_ID, HAS_OPTION, DATETIME_FORMAT, DATETIME_FORMAT_TZ
 */
import { parseDurationSeconds } from "./duration";
import { numericStorageValue } from "./number-format";

// ── Tokenizer ──────────────────────────────────────────────────────────────────

type TokenType =
  | "NUMBER" | "STRING" | "BOOLEAN" | "NULL"
  | "IDENT" | "LPAREN" | "RPAREN" | "COMMA"
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "MOD"
  | "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE"
  | "AND" | "OR" | "NOT" | "LBRACE" | "RBRACE"
  | "EOF";

interface Token {
  type: TokenType;
  value: string | number | boolean | null;
  raw: string;
}

const BASEROW_FORMULA_MAX_DIGITS = 50;
const BASEROW_MAX_FORMULA_STRING_LENGTH = 10000;

function formulaNumber(value: unknown): number {
  const text = String(value ?? "").trim();
  const digits = text.match(/\d/g)?.length || 0;
  if (digits > BASEROW_FORMULA_MAX_DIGITS) return Number.NaN;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) { i++; continue; }

    // Numbers
    if (/\d/.test(input[i]) || (input[i] === "." && /\d/.test(input[i + 1]))) {
      let num = "";
      let seenDecimalPoint = false;
      while (i < input.length) {
        if (/\d/.test(input[i])) {
          num += input[i++];
          continue;
        }
        if (input[i] === "." && !seenDecimalPoint) {
          seenDecimalPoint = true;
          num += input[i++];
          continue;
        }
        break;
      }
      tokens.push({ type: "NUMBER", value: formulaNumber(num), raw: num });
      continue;
    }

    // Strings
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i++];
      let str = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\') {
          i++;
          if (i >= input.length) throw new Error("Unterminated string literal.");
          str += input[i++];
        }
        else str += input[i++];
      }
      if (i >= input.length) throw new Error("Unterminated string literal.");
      i++; // closing quote
      if (str.length > BASEROW_MAX_FORMULA_STRING_LENGTH) {
        throw new Error(`String literals cannot exceed ${BASEROW_MAX_FORMULA_STRING_LENGTH} characters.`);
      }
      tokens.push({ type: "STRING", value: str, raw: `"${str}"` });
      continue;
    }

    // Field references {Name}
    if (input[i] === '{') {
      i++;
      let field = "";
      while (i < input.length && input[i] !== '}') field += input[i++];
      if (i >= input.length) throw new Error("Unterminated field reference.");
      i++;
      tokens.push({ type: "IDENT", value: `__field__${field}`, raw: `{${field}}` });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(input[i])) {
      let ident = "";
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) ident += input[i++];
      const upper = ident.toUpperCase();
      if (upper === "TRUE") tokens.push({ type: "BOOLEAN", value: true, raw: ident });
      else if (upper === "FALSE") tokens.push({ type: "BOOLEAN", value: false, raw: ident });
      else if (upper === "NULL" || upper === "BLANK") tokens.push({ type: "NULL", value: null, raw: ident });
      else if (upper === "AND") tokens.push({ type: "AND", value: "AND", raw: ident });
      else if (upper === "OR") tokens.push({ type: "OR", value: "OR", raw: ident });
      else if (upper === "NOT") tokens.push({ type: "NOT", value: "NOT", raw: ident });
      else tokens.push({ type: "IDENT", value: ident, raw: ident });
      continue;
    }

    // Operators
    if (input[i] === '<' && input[i + 1] === '=') { tokens.push({ type: "LTE", value: "<=", raw: "<=" }); i += 2; continue; }
    if (input[i] === '>' && input[i + 1] === '=') { tokens.push({ type: "GTE", value: ">=", raw: ">=" }); i += 2; continue; }
    if (input[i] === '!' && input[i + 1] === '=') { tokens.push({ type: "NEQ", value: "!=", raw: "!=" }); i += 2; continue; }
    if (input[i] === '<' && input[i + 1] === '>') { tokens.push({ type: "NEQ", value: "!=", raw: "<>" }); i += 2; continue; }
    if (input[i] === '&' && input[i + 1] === '&') { tokens.push({ type: "AND", value: "AND", raw: "&&" }); i += 2; continue; }
    if (input[i] === '|' && input[i + 1] === '|') { tokens.push({ type: "OR", value: "OR", raw: "||" }); i += 2; continue; }
    if (input[i] === '<') { tokens.push({ type: "LT", value: "<", raw: "<" }); i++; continue; }
    if (input[i] === '>') { tokens.push({ type: "GT", value: ">", raw: ">" }); i++; continue; }
    if (input[i] === '=') { tokens.push({ type: "EQ", value: "=", raw: "=" }); i++; continue; }
    if (input[i] === '+') { tokens.push({ type: "PLUS", value: "+", raw: "+" }); i++; continue; }
    if (input[i] === '-') { tokens.push({ type: "MINUS", value: "-", raw: "-" }); i++; continue; }
    if (input[i] === '*') { tokens.push({ type: "STAR", value: "*", raw: "*" }); i++; continue; }
    if (input[i] === '/') { tokens.push({ type: "SLASH", value: "/", raw: "/" }); i++; continue; }
    if (input[i] === '%') { tokens.push({ type: "MOD", value: "%", raw: "%" }); i++; continue; }
    if (input[i] === '(') { tokens.push({ type: "LPAREN", value: "(", raw: "(" }); i++; continue; }
    if (input[i] === ')') { tokens.push({ type: "RPAREN", value: ")", raw: ")" }); i++; continue; }
    if (input[i] === ',') { tokens.push({ type: "COMMA", value: ",", raw: "," }); i++; continue; }
    if (input[i] === '{') { tokens.push({ type: "LBRACE", value: "{", raw: "{" }); i++; continue; }
    if (input[i] === '}') { tokens.push({ type: "RBRACE", value: "}", raw: "}" }); i++; continue; }

    throw new Error(`Unexpected character: "${input[i]}"`);
  }

  tokens.push({ type: "EOF", value: null, raw: "" });
  return tokens;
}

// ── AST Nodes ─────────────────────────────────────────────────────────────────

export type FormulaASTNode =
  | { kind: "literal"; value: string | number | boolean | null; raw?: string }
  | { kind: "field"; name: string }
  | { kind: "binop"; op: string; left: FormulaASTNode; right: FormulaASTNode }
  | { kind: "unop"; op: string; operand: FormulaASTNode }
  | { kind: "call"; fn: string; args: FormulaASTNode[] };

type ASTNode = FormulaASTNode;

// ── Parser ────────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]; }
  private consume(): Token { return this.tokens[this.pos++]; }
  private expect(type: TokenType): Token {
    const t = this.consume();
    if (t.type !== type) throw new Error(`Expected ${type}, got ${t.type} ("${t.raw}")`);
    return t;
  }

  parse(): ASTNode {
    const node = this.parseOr();
    if (this.peek().type !== "EOF") {
      throw new Error(`Unexpected token: "${this.peek().raw}"`);
    }
    return node;
  }

  private parseOr(): ASTNode {
    let left = this.parseAnd();
    while (this.peek().type === "OR") {
      this.consume();
      const right = this.parseAnd();
      left = { kind: "binop", op: "OR", left, right };
    }
    return left;
  }

  private parseAnd(): ASTNode {
    let left = this.parseComparison();
    while (this.peek().type === "AND") {
      this.consume();
      const right = this.parseComparison();
      left = { kind: "binop", op: "AND", left, right };
    }
    return left;
  }

  private parseComparison(): ASTNode {
    let left = this.parseAddSub();
    const cmpOps: TokenType[] = ["EQ", "NEQ", "LT", "LTE", "GT", "GTE"];
    while (cmpOps.includes(this.peek().type as TokenType)) {
      const op = String(this.consume().value);
      const right = this.parseAddSub();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  private parseAddSub(): ASTNode {
    let left = this.parseMulDiv();
    while (this.peek().type === "PLUS" || this.peek().type === "MINUS") {
      const op = String(this.consume().value);
      const right = this.parseMulDiv();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parseUnary();
    while (["STAR", "SLASH", "MOD"].includes(this.peek().type)) {
      const op = String(this.consume().value);
      const right = this.parseUnary();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  private parseUnary(): ASTNode {
    if (this.peek().type === "NOT") {
      this.consume();
      return { kind: "unop", op: "NOT", operand: this.parsePrimary() };
    }
    if (this.peek().type === "MINUS") {
      this.consume();
      return { kind: "unop", op: "NEG", operand: this.parsePrimary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ASTNode {
    const t = this.peek();

    if (t.type === "NUMBER" || t.type === "STRING" || t.type === "BOOLEAN" || t.type === "NULL") {
      this.consume();
      return { kind: "literal", value: t.value, raw: t.raw };
    }

    if (t.type === "IDENT" || ((t.type === "AND" || t.type === "OR") && this.tokens[this.pos + 1]?.type === "LPAREN")) {
      const name = String(t.value);
      // Field reference via __field__ prefix
      if (name.startsWith("__field__")) {
        this.consume();
        return { kind: "field", name: name.slice("__field__".length) };
      }

      // Check if it's a function call
      if (this.tokens[this.pos + 1]?.type === "LPAREN") {
        this.consume(); // fn name
        this.expect("LPAREN");
        const args: ASTNode[] = [];
        while (this.peek().type !== "RPAREN" && this.peek().type !== "EOF") {
          args.push(this.parseOr());
          if (this.peek().type === "COMMA") this.consume();
        }
        this.expect("RPAREN");
        return { kind: "call", fn: name.toUpperCase(), args };
      }

      // Field reference by name (bare identifier)
      this.consume();
      return { kind: "field", name };
    }

    if (t.type === "LPAREN") {
      this.consume();
      const node = this.parseOr();
      this.expect("RPAREN");
      return node;
    }

    throw new Error(`Unexpected token: "${t.raw}" (${t.type})`);
  }
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

export type FieldValues = Record<string, unknown>;

interface FormulaLinkValue {
  url: string;
  label: string | null;
}

type FormulaFileValue = Record<string, unknown>;

interface FormulaDurationValue {
  __formulaDuration: true;
  seconds: number;
  text: string;
  interval?: {
    amount: number;
    unit: string;
  };
  valueOf: () => number;
  toString: () => string;
}

function isFormulaDurationValue(value: unknown): value is FormulaDurationValue {
  return value !== null &&
    typeof value === "object" &&
    (value as { __formulaDuration?: unknown }).__formulaDuration === true &&
    Number.isFinite((value as { seconds?: unknown }).seconds);
}

function formulaDuration(seconds: number, interval?: FormulaDurationValue["interval"]): FormulaDurationValue | null {
  if (!Number.isFinite(seconds)) return null;
  const text = interval ? durationIntervalText(interval) : String(seconds);
  return {
    __formulaDuration: true,
    seconds,
    text,
    interval,
    valueOf: () => seconds,
    toString: () => text,
  };
}

function durationIntervalText(interval: FormulaDurationValue["interval"]): string {
  if (!interval) return "";
  const canonicalUnits: Record<string, string> = {
    s: "second", second: "second", seconds: "second",
    m: "minute", minute: "minute", minutes: "minute",
    h: "hour", hour: "hour", hours: "hour",
    d: "day", day: "day", days: "day",
    w: "week", week: "week", weeks: "week",
    mo: "month", month: "month", months: "month",
    y: "year", year: "year", years: "year",
  };
  const unit = canonicalUnits[interval.unit] || interval.unit;
  const suffix = Math.abs(interval.amount) === 1 ? unit : `${unit}s`;
  return `${interval.amount} ${suffix}`;
}

function unwrapFormulaValue(value: unknown): unknown {
  if (isFormulaDurationValue(value)) return value.seconds;
  if (Array.isArray(value)) return value.map(unwrapFormulaValue);
  if (value && typeof value === "object") {
    if (isFormulaLinkValue(value) || isFormulaFileValue(value)) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, unwrapFormulaValue(item)]));
  }
  return value;
}

function toNum(v: unknown): number {
  if (isFormulaDurationValue(v)) return v.seconds;
  if (v === null || v === undefined || v === "") return 0;
  const n = numericStorageValue(v);
  return n === null ? Number.NaN : n;
}

function isFormulaNaN(value: unknown): boolean {
  return typeof value === "number" && !Number.isFinite(value);
}

function truncNum(v: unknown): number {
  const number = toNum(v);
  return Number.isFinite(number) ? Math.trunc(number) : number;
}

function finiteOrNaN(value: number): number {
  return Number.isFinite(value) ? value : Number.NaN;
}

function roundHalfAwayFromZero(value: number, decimalPlaces: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(decimalPlaces)) return Number.NaN;
  const factor = Math.pow(10, decimalPlaces);
  if (!Number.isFinite(factor) || factor === 0) return value;
  const scaled = value * factor;
  const rounded = Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5 + Number.EPSILON);
  return rounded / factor;
}

function lowercasePercentEscapes(value: string): string {
  return value.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase());
}

const BASEROW_FORMULA_URL_RE = /^(?:([a-zA-Z]+):\/\/)?(?:([a-zA-Z0-9._%+-]+)(:[a-zA-Z0-9._%+-]+)?@)?([a-zA-Z0-9.-]+)(?::(\d+))?(\/[^?]*)?(\?.*)?(#.*)?$/u;

function toStr(v: unknown): string {
  if (isFormulaDurationValue(v)) return v.text;
  if (v === null || v === undefined) return "";
  return String(v);
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v.toLowerCase() !== "false";
  return Boolean(v);
}

function isBlank(value: unknown): boolean {
  const parsed = parseJsonValue(value);
  if (parsed === null || parsed === undefined || parsed === "") return true;
  if (typeof parsed === "number") return parsed === 0;
  if (Array.isArray(parsed)) return parsed.length === 0;
  return false;
}

function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

function isRuntimeEmpty(value: unknown): boolean {
  const parsed = parseJsonValue(value);
  if (parsed === null || parsed === undefined) return true;
  if (typeof parsed === "string") return parsed.trim().length === 0;
  if (Array.isArray(parsed)) return parsed.length === 0;
  if (typeof parsed === "object") return Object.keys(parsed as Record<string, unknown>).length === 0;
  return false;
}

function capitalizeRuntime(value: unknown): string {
  const text = toStr(value);
  if (!text) return "";
  const [first, ...rest] = Array.from(text);
  return first.toUpperCase() + rest.join("").toLowerCase();
}

function getValueAtPath(value: unknown, parts: string[]): unknown {
  if (parts.length === 0) return value ?? null;
  const [part, ...rest] = parts;
  const parsed = parseJsonValue(value);
  if (part === "*") {
    if (Array.isArray(parsed)) return parsed.map((item) => getValueAtPath(item, rest));
    if (parsed && typeof parsed === "object") {
      return Object.values(parsed as Record<string, unknown>).map((item) => getValueAtPath(item, rest));
    }
    return [];
  }
  if (parsed === null || parsed === undefined) return null;
  if (Array.isArray(parsed)) {
    const index = Number(part);
    if (!Number.isInteger(index)) return null;
    return getValueAtPath(parsed[index < 0 ? parsed.length + index : index], rest);
  }
  if (typeof parsed === "object") return getValueAtPath((parsed as Record<string, unknown>)[part], rest);
  return null;
}

function getFormulaPath(fields: FieldValues, path: unknown): unknown {
  const key = toStr(path);
  if (Object.prototype.hasOwnProperty.call(fields, key)) return fields[key];
  return getValueAtPath(fields, key.split(".").filter(Boolean));
}

function getPropertyValue(value: unknown, property: unknown): unknown {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const key = toStr(property);
  return Object.prototype.hasOwnProperty.call(parsed, key)
    ? (parsed as Record<string, unknown>)[key]
    : null;
}

function ensureRuntimeArray(value: unknown): unknown[] {
  const parsed = parseJsonValue(value);
  if (parsed === null || parsed === undefined || parsed === "") return [];
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "string") return parsed.split(",").map((item) => item.trim());
  return [parsed];
}

function runtimeAt(value: unknown, indexRaw: unknown): unknown {
  const parsed = parseJsonValue(value);
  const index = Math.trunc(toNum(indexRaw));
  if (!Number.isFinite(index)) return null;
  if (Array.isArray(parsed)) {
    const resolvedIndex = index < 0 ? parsed.length + index : index;
    return resolvedIndex >= 0 && resolvedIndex < parsed.length ? parsed[resolvedIndex] : null;
  }
  if (typeof parsed === "string") {
    const chars = Array.from(parsed);
    const resolvedIndex = index < 0 ? chars.length + index : index;
    return resolvedIndex >= 0 && resolvedIndex < chars.length ? chars[resolvedIndex] : null;
  }
  return null;
}

function randomInt(minRaw: unknown, maxRaw: unknown): number {
  const min = Math.ceil(toNum(minRaw));
  const max = Math.floor(toNum(maxRaw));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return Number.NaN;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function randomFloat(minRaw: unknown, maxRaw: unknown): number {
  const min = toNum(minRaw);
  const max = toNum(maxRaw);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return Number.NaN;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.random() * (high - low) + low;
}

function generateUuid(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const randomUuid = cryptoApi?.randomUUID;
  if (typeof randomUuid === "function") return randomUuid.call(cryptoApi);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function isFormulaLinkValue(value: unknown): value is FormulaLinkValue {
  return (
    value !== null &&
    typeof value === "object" &&
    "url" in value &&
    typeof (value as { url?: unknown }).url === "string"
  );
}

function functionValues(args: unknown[]): unknown[] {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] as unknown[] : args;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || !["[", "{"].includes(text[0])) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function asArrayValue(value: unknown): unknown[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function asManyArrayValue(value: unknown): unknown[] {
  const parsed = parseJsonValue(value);
  if (parsed === null || parsed === undefined || parsed === "") return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function aggregateItemId(item: unknown, index: number): number {
  if (isRecordValue(item)) {
    const raw = item.id;
    const id = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (Number.isInteger(id) && id > 0) return id;
  }
  return index + 1;
}

function isAggregateValueObject(value: unknown): value is Record<string, unknown> {
  if (!isRecordValue(value)) return false;
  if (!("value" in value) || (!("id" in value) && !("ids" in value))) return false;
  return !("color" in value) && !("first_name" in value) && !("last_name" in value);
}

function arrayAgg(value: unknown, nestInValue: boolean): unknown[] {
  const values = asManyArrayValue(value);
  if (nestInValue && values.every(isAggregateValueObject)) return values;
  return values.map((item, index) => (
    nestInValue ? { id: aggregateItemId(item, index), value: item } : item
  ));
}

function arrayAggUnnesting(value: unknown): unknown[] {
  return asManyArrayValue(value).flatMap((item) => asManyArrayValue(item));
}

function manyToManyGroups(value: unknown): Array<{ id: number; value: unknown[] }> {
  const values = asManyArrayValue(value);
  if (values.length === 0) return [];
  if (values.every((item) => isAggregateValueObject(item) && Array.isArray(parseJsonValue(item.value)))) {
    return values.map((item, index) => ({
      id: aggregateItemId(item, index),
      value: asManyArrayValue((item as Record<string, unknown>).value),
    }));
  }
  if (values.every(Array.isArray)) {
    return values.map((item, index) => ({ id: aggregateItemId(item, index), value: asManyArrayValue(item) }));
  }
  return [{ id: 1, value: values }];
}

function manyToManyLeafValues(value: unknown): unknown[] {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed) && parsed.every((item) => isAggregateValueObject(item) && Array.isArray(parseJsonValue(item.value)))) {
    return parsed.flatMap((item) => asManyArrayValue((item as Record<string, unknown>).value));
  }
  return asManyArrayValue(parsed);
}

function manyToManyText(value: unknown): string {
  return manyToManyLeafValues(value)
    .map((item) => {
      const parsed = parseJsonValue(item);
      if (isRecordValue(parsed)) {
        for (const key of ["value", "first_name", "name", "username", "email", "id"]) {
          if (parsed[key] !== null && parsed[key] !== undefined && parsed[key] !== "") return String(parsed[key]);
        }
        return "";
      }
      return parsed === null || parsed === undefined ? "" : String(parsed);
    })
    .filter((item) => item !== "")
    .join(", ");
}

function isFormulaFileValue(value: unknown): value is FormulaFileValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as FormulaFileValue;
  return (
    typeof file.visible_name === "string" ||
    typeof file.original_name === "string" ||
    typeof file.name === "string" ||
    typeof file.mime_type === "string" ||
    typeof file.type === "string" ||
    typeof file.url === "string"
  );
}

function fileValues(value: unknown): FormulaFileValue[] {
  return asArrayValue(value).filter(isFormulaFileValue);
}

function singleFileValue(value: unknown): FormulaFileValue | null {
  const parsed = parseJsonValue(value);
  if (isFormulaFileValue(parsed)) return parsed;
  return fileValues(parsed)[0] || null;
}

function fileString(file: FormulaFileValue | null, keys: string[]): string {
  if (!file) return "";
  for (const key of keys) {
    const value = file[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function fileNumber(file: FormulaFileValue | null, keys: string[]): number | null {
  if (!file) return null;
  for (const key of keys) {
    const value = file[key];
    const number = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function numericFunctionValues(args: unknown[]): number[] {
  return functionValues(args)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(toNum);
}

function displayText(value: unknown): string {
  if (isFormulaLinkValue(value)) {
    return value.label ? `${value.label} (${value.url})` : value.url;
  }
  if (Array.isArray(value)) return value.map(displayText).join(",");
  return toStr(value);
}

function optionText(value: unknown): string {
  const parsed = parseJsonValue(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const raw = parsed as Record<string, unknown>;
    if (raw.value !== undefined) return String(raw.value);
    if (raw.name !== undefined) return String(raw.name);
    if (raw.id !== undefined) return String(raw.id);
  }
  return toStr(parsed);
}

function singleSelectValue(value: unknown): string | null {
  const parsed = parseJsonValue(value);
  if (parsed === null || parsed === undefined || parsed === "") return null;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const raw = parsed as Record<string, unknown>;
    if (raw.value !== undefined && raw.value !== null) return String(raw.value);
    if (raw.name !== undefined && raw.name !== null) return String(raw.name);
  }
  const text = toStr(parsed);
  return text === "" ? null : text;
}

function jsonbExtractPathText(value: unknown, path: unknown[]): string | null {
  let current = parseJsonValue(value);
  for (const key of path.map(toStr)) {
    current = parseJsonValue(current);
    if (current === null || current === undefined) return null;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return null;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
    current = record[key];
  }
  if (current === null || current === undefined) return null;
  if (typeof current === "object") return JSON.stringify(current);
  return String(current);
}

function bcToNull(value: unknown): unknown {
  const text = toStr(value).trim();
  if (!text) return value;
  if (/^-\d{4,}/.test(text)) return null;
  const year = Number(text.match(/^([+-]?\d{4,})/)?.[1]);
  return Number.isFinite(year) && year < 0 ? null : value;
}

function variance(values: number[], sample: boolean): number | null {
  const divisor = sample ? values.length - 1 : values.length;
  if (divisor <= 0) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / divisor;
}

function equalValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isVectorValue(value: unknown): value is unknown[] {
  return Array.isArray(parseJsonValue(value));
}

function vectorValues(value: unknown): unknown[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function binaryScalar(op: string, left: unknown, right: unknown): unknown {
  switch (op) {
    case "+": return addValues(left, right);
    case "-": return minusValues(left, right);
    case "*": return multiplyValues(left, right);
    case "/": return divideValues(left, right);
    case "%": return toNum(right) === 0 ? Number.NaN : toNum(left) % toNum(right);
    case "=": return equalValues(left, right) || left == right;
    case "!=": return !(equalValues(left, right) || left == right);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compareValues(op, left, right);
    case "AND": return toBool(left) && toBool(right);
    case "OR": return toBool(left) || toBool(right);
  }
  return null;
}

function binaryValue(op: string, left: unknown, right: unknown): unknown {
  const leftIsVector = isVectorValue(left);
  const rightIsVector = isVectorValue(right);
  if (!leftIsVector && !rightIsVector) return binaryScalar(op, left, right);

  const leftValues = vectorValues(left);
  const rightValues = vectorValues(right);
  const length = Math.max(leftValues.length, rightValues.length);
  return Array.from({ length }, (_value, index) => binaryScalar(
    op,
    leftIsVector ? leftValues[index] ?? null : left,
    rightIsVector ? rightValues[index] ?? null : right,
  ));
}

function vectorizedFunction(args: unknown[], scalar: (items: unknown[]) => unknown): unknown {
  const vectorFlags = args.map(isVectorValue);
  if (!vectorFlags.some(Boolean)) return scalar(args);
  const vectors = args.map(vectorValues);
  const length = Math.max(...vectors.map((items, index) => vectorFlags[index] ? items.length : 1));
  return Array.from({ length }, (_value, index) => scalar(args.map((arg, argIndex) => (
    vectorFlags[argIndex] ? vectors[argIndex][index] ?? null : arg
  ))));
}

function evaluate(node: ASTNode, fields: FieldValues): unknown {
  switch (node.kind) {
    case "literal": return node.value;

    case "field": {
      // Look up by field name or field_<id>
      const v = fields[node.name];
      return v !== undefined ? v : null;
    }

    case "unop": {
      const val = evaluate(node.operand, fields);
      if (isVectorValue(val)) {
        return vectorValues(val).map((item) => node.op === "NEG" ? -toNum(item) : !toBool(item));
      }
      if (node.op === "NEG") return -toNum(val);
      if (node.op === "NOT") return !toBool(val);
      return null;
    }

    case "binop": {
      const l = evaluate(node.left, fields);
      const r = evaluate(node.right, fields);
      return binaryValue(node.op, l, r);
    }

    case "call": {
      const wrapper = node.fn.toUpperCase();
      if (wrapper === "ERROR_TO_NAN" || wrapper === "ERROR_TO_NULL") {
        try {
          return node.args.length > 0 ? evaluate(node.args[0], fields) : null;
        } catch {
          return wrapper === "ERROR_TO_NAN" ? Number.NaN : null;
        }
      }
      const args = node.args.map(a => evaluate(a, fields));
      return callFunction(node.fn, args, fields);
    }
  }
}

interface ParsedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFormattedDateParts(value: unknown, format?: unknown): ParsedDateParts | null {
  const text = toStr(value).trim();
  if (!text) return null;
  const fmt = toStr(format).toUpperCase();
  if (!fmt) return null;

  const tokens = ["YYYY", "HH24", "MM", "DD", "MI", "SS"];
  const groups: string[] = [];
  let pattern = "";
  for (let i = 0; i < fmt.length;) {
    const token = tokens.find((candidate) => fmt.startsWith(candidate, i));
    if (token) {
      groups.push(token);
      pattern += token === "YYYY" ? "(\\d{4})" : "(\\d{2})";
      i += token.length;
    } else {
      pattern += escapeRegex(fmt[i]);
      i += 1;
    }
  }
  const match = new RegExp(`^${pattern}$`).exec(text);
  if (!match) return null;

  const values: Record<string, number> = {};
  groups.forEach((token, index) => {
    values[token] = Number(match[index + 1]);
  });

  const parts = {
    year: values.YYYY,
    month: values.MM ?? 1,
    day: values.DD ?? 1,
    hour: values.HH24 ?? 0,
    minute: values.MI ?? 0,
    second: values.SS ?? 0,
  };
  if (!Number.isInteger(parts.year) || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 ||
    parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59 || parts.second < 0 || parts.second > 59) {
    return null;
  }

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  if (date.getUTCFullYear() !== parts.year || date.getUTCMonth() !== parts.month - 1 || date.getUTCDate() !== parts.day ||
    date.getUTCHours() !== parts.hour || date.getUTCMinutes() !== parts.minute || date.getUTCSeconds() !== parts.second) {
    return null;
  }
  return parts;
}

function dateFromParts(parts: ParsedDateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

function dateFromInput(value: unknown, format?: unknown): Date | null {
  const formatted = parseFormattedDateParts(value, format);
  if (formatted) return dateFromParts(formatted);
  const text = toStr(value).trim();
  if (!text) return null;
  const date = new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

function timezoneOffsetMs(date: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(
      Number(byType.year),
      Number(byType.month) - 1,
      Number(byType.day),
      Number(byType.hour),
      Number(byType.minute),
      Number(byType.second),
    );
    return asUtc - date.getTime();
  } catch {
    return null;
  }
}

function dateFromInputTimezone(value: unknown, format: unknown, timezoneRaw: unknown): Date | null {
  const timezone = toStr(timezoneRaw).trim();
  if (!timezone) return null;
  const parts = parseFormattedDateParts(value, format);
  if (!parts) return null;
  const utcGuess = dateFromParts(parts);
  const offset = timezoneOffsetMs(utcGuess, timezone);
  if (offset === null) return null;
  const corrected = new Date(utcGuess.getTime() - offset);
  const correctedOffset = timezoneOffsetMs(corrected, timezone);
  return correctedOffset === null ? null : new Date(utcGuess.getTime() - correctedOffset);
}

function padNumber(value: number): string {
  return String(value).padStart(2, "0");
}

function dateParts(date: Date, timezone?: string): Record<string, string> {
  if (!timezone) {
    return {
      YYYY: String(date.getUTCFullYear()),
      YY: String(date.getUTCFullYear()).slice(-2),
      MM: padNumber(date.getUTCMonth() + 1),
      DD: padNumber(date.getUTCDate()),
      HH24: padNumber(date.getUTCHours()),
      HH: padNumber(date.getUTCHours()),
      MI: padNumber(date.getUTCMinutes()),
      SS: padNumber(date.getUTCSeconds()),
    };
  }

  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      YYYY: byType.year || "",
      YY: String(byType.year || "").slice(-2),
      MM: byType.month || "",
      DD: byType.day || "",
      HH24: byType.hour || "",
      HH: byType.hour || "",
      MI: byType.minute || "",
      SS: byType.second || "",
    };
  } catch {
    return dateParts(date);
  }
}

function datetimeFormat(value: unknown, format: unknown, timezone?: unknown): string {
  const date = dateFromInput(value);
  if (!date) return "";
  const replacements = dateParts(date, timezone === undefined ? undefined : toStr(timezone));
  const pattern = toStr(format) || "YYYY-MM-DD";
  if (pattern === "day") {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone === undefined ? "UTC" : toStr(timezone),
        weekday: "long",
      }).format(date).toLowerCase();
    } catch {
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(date).toLowerCase();
    }
  }
  return pattern.replace(/HH24|YYYY|YY|MM|DD|HH|MI|SS/g, (token) => replacements[token] ?? token);
}

function isoWithoutMilliseconds(date: Date): string {
  return date.toISOString().replace(".000Z", "Z");
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateDiff(unitValue: unknown, startValue: unknown, endValue: unknown): number | null {
  const start = dateFromInput(startValue);
  const end = dateFromInput(endValue);
  if (!start || !end) return null;

  const unit = toStr(unitValue).toLowerCase();
  const diffMs = end.getTime() - start.getTime();
  if (["yy", "yyyy", "year", "years", "y"].includes(unit)) return end.getUTCFullYear() - start.getUTCFullYear();
  if (["mm", "month", "months", "mon"].includes(unit)) {
    return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  }
  if (["wk", "week", "weeks", "w"].includes(unit)) return Math.floor(diffMs / 604800000);
  if (["dd", "day", "days", "d"].includes(unit)) return Math.floor(diffMs / 86400000);
  if (["hh", "hour", "hours", "h"].includes(unit)) return Math.floor(diffMs / 3600000);
  if (["mi", "minute", "minutes", "m"].includes(unit)) return Math.floor(diffMs / 60000);
  if (["ss", "second", "seconds", "s"].includes(unit)) return Math.floor(diffMs / 1000);
  return Number.NaN;
}

function intervalSeconds(value: unknown): number | null {
  const text = toStr(value).trim().toLowerCase();
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years|s|m|h|d|w|mo|y)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    second: 1, seconds: 1, s: 1,
    minute: 60, minutes: 60, m: 60,
    hour: 3600, hours: 3600, h: 3600,
    day: 86400, days: 86400, d: 86400,
    week: 604800, weeks: 604800, w: 604800,
    month: 2592000, months: 2592000, mo: 2592000,
    year: 31536000, years: 31536000, y: 31536000,
  };
  return amount * multipliers[unit];
}

function intervalSpec(value: unknown): FormulaDurationValue["interval"] | undefined {
  const text = toStr(value).trim().toLowerCase();
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years|s|m|h|d|w|mo|y)$/);
  if (!match) return undefined;
  return { amount: Number(match[1]), unit: match[2] };
}

function dateIntervalValue(value: unknown): FormulaDurationValue | null {
  const seconds = intervalSeconds(value) ?? parseDurationSeconds(value, "h:mm:ss.sss");
  return seconds === null ? null : formulaDuration(seconds, intervalSpec(value));
}

function durationValue(value: unknown): FormulaDurationValue | null {
  if (isFormulaDurationValue(value)) return value;
  const seconds = typeof value === "number" || typeof value === "string"
    ? parseDurationSeconds(value, "h:mm:ss.sss")
    : null;
  return seconds === null ? null : formulaDuration(seconds);
}

function arithmeticDurationValue(value: unknown): FormulaDurationValue | null {
  return isFormulaDurationValue(value) ? value : null;
}

function dateTimeMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const date = dateFromInput(value);
  return date ? date.getTime() : null;
}

function isDateOnlyValue(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function addDurationToDate(dateValue: unknown, duration: FormulaDurationValue, sign: 1 | -1): string | null {
  const date = dateFromInput(dateValue);
  if (!date) return null;
  const dateOnlyResult = isDateOnlyValue(dateValue);
  const interval = duration.interval;

  if (interval && Number.isInteger(interval.amount)) {
    const amount = interval.amount * sign;
    const unit = interval.unit;
    if (["year", "years", "y"].includes(unit)) date.setUTCFullYear(date.getUTCFullYear() + amount);
    else if (["month", "months", "mo"].includes(unit)) date.setUTCMonth(date.getUTCMonth() + amount);
    else if (["week", "weeks", "w"].includes(unit)) date.setUTCDate(date.getUTCDate() + amount * 7);
    else if (["day", "days", "d"].includes(unit)) date.setUTCDate(date.getUTCDate() + amount);
    else date.setTime(date.getTime() + duration.seconds * sign * 1000);
  } else {
    date.setTime(date.getTime() + duration.seconds * sign * 1000);
  }

  return dateOnlyResult ? dateOnly(date) : date.toISOString();
}

function addValues(left: unknown, right: unknown): unknown {
  const leftDuration = arithmeticDurationValue(left);
  const rightDuration = arithmeticDurationValue(right);
  if (typeof left === "string" && dateTimeMs(left) !== null && rightDuration) return addDurationToDate(left, rightDuration, 1);
  if (typeof right === "string" && dateTimeMs(right) !== null && leftDuration) return addDurationToDate(right, leftDuration, 1);
  if (leftDuration && rightDuration) return formulaDuration(leftDuration.seconds + rightDuration.seconds);
  if (typeof left === "string" || typeof right === "string") return toStr(left) + toStr(right);
  return toNum(left) + toNum(right);
}

function minusValues(left: unknown, right: unknown): unknown {
  const leftDuration = arithmeticDurationValue(left);
  const rightDuration = arithmeticDurationValue(right);
  if (typeof left === "string" && dateTimeMs(left) !== null && rightDuration) return addDurationToDate(left, rightDuration, -1);
  if (typeof left === "string" && typeof right === "string") {
    const leftMs = dateTimeMs(left);
    const rightMs = dateTimeMs(right);
    if (leftMs !== null && rightMs !== null) return formulaDuration((leftMs - rightMs) / 1000);
  }
  if (leftDuration && rightDuration) return formulaDuration(leftDuration.seconds - rightDuration.seconds);
  return toNum(left) - toNum(right);
}

function multiplyValues(left: unknown, right: unknown): unknown {
  const leftDuration = arithmeticDurationValue(left);
  const rightDuration = arithmeticDurationValue(right);
  if (leftDuration && !rightDuration) return formulaDuration(leftDuration.seconds * toNum(right));
  if (rightDuration && !leftDuration) return formulaDuration(toNum(left) * rightDuration.seconds);
  return toNum(left) * toNum(right);
}

function divideValues(left: unknown, right: unknown): unknown {
  const denominator = toNum(right);
  const leftDuration = arithmeticDurationValue(left);
  if (denominator === 0) return leftDuration ? null : Number.NaN;
  return leftDuration ? formulaDuration(leftDuration.seconds / denominator) : toNum(left) / denominator;
}

function compareValues(op: string, left: unknown, right: unknown): boolean {
  const leftDate = dateTimeMs(left);
  const rightDate = dateTimeMs(right);
  if (leftDate !== null || rightDate !== null) {
    if (leftDate === null || rightDate === null) return false;
    switch (op) {
      case "<": return leftDate < rightDate;
      case "<=": return leftDate <= rightDate;
      case ">": return leftDate > rightDate;
      case ">=": return leftDate >= rightDate;
    }
  }
  const leftComparable = leftDate ?? toNum(left);
  const rightComparable = rightDate ?? toNum(right);
  switch (op) {
    case "<": return leftComparable < rightComparable;
    case "<=": return leftComparable <= rightComparable;
    case ">": return leftComparable > rightComparable;
    case ">=": return leftComparable >= rightComparable;
  }
  return false;
}

function callFunction(fn: string, args: unknown[], fields: FieldValues): unknown {
  const a = (i: number) => args[i];
  const n = (i: number) => toNum(a(i));
  const s = (i: number) => toStr(a(i));

  switch (fn) {
    // ── Logic ────────────────────────────────────────────────────────────────
    case "AND":
      return args.every(toBool);
    case "OR":
      return args.some(toBool);
    case "FIELD":
      return fields[s(0)] !== undefined ? fields[s(0)] : null;
    case "GET":
      return getFormulaPath(fields, a(0));
    case "FIELD_BY_ID": {
      const id = Math.trunc(n(0));
      return fields[`field_${id}`] !== undefined ? fields[`field_${id}`] : null;
    }
    case "ROW_ID": {
      const rowId = fields.__row_id ?? fields.row_id ?? fields.id;
      const id = Number(rowId);
      return Number.isFinite(id) ? id : null;
    }
    case "LOOKUP": {
      const through = s(0);
      const target = s(1);
      return fields[`lookup:${through}:${target}`] ??
        fields[`lookup:${through.toLowerCase()}:${target.toLowerCase()}`] ??
        [];
    }
    case "IF":
      return toBool(a(0)) ? a(1) : (args.length > 2 ? a(2) : null);
    case "ISBLANK":
      return isBlank(a(0));
    case "IS_EMPTY":
      return isRuntimeEmpty(a(0));
    case "ISNULL":
    case "IS_NULL":
      return isNull(a(0));
    case "NOT":
      return !toBool(a(0));
    case "IFERROR":
      try { return a(0); } catch { return a(1); }
    case "SWITCH": {
      // SWITCH(val, case1, result1, case2, result2, ..., default?)
      const val = a(0);
      for (let i = 1; i < args.length - 1; i += 2) {
        if (val == a(i)) return a(i + 1);
      }
      return args.length % 2 === 0 ? a(args.length - 1) : null;
    }
    case "WHEN_EMPTY":
      return isNull(a(0)) ? a(1) : a(0);

    // ── Text ────────────────────────────────────────────────────────────────
    case "CONCAT":
    case "CONCATENATE":
      return args.map(toStr).join("");
    case "UPPER": return vectorizedFunction(args, ([value]) => toStr(value).toUpperCase());
    case "LOWER": return vectorizedFunction(args, ([value]) => toStr(value).toLowerCase());
    case "CAPITALIZE": return vectorizedFunction(args, ([value]) => capitalizeRuntime(value));
    case "STRIP":
    case "TRIM": return vectorizedFunction(args, ([value]) => toStr(value).trim());
    case "LEN":
    case "LENGTH": return vectorizedFunction(args, ([value]) => toStr(value).length);
    case "LEFT":
      if (a(1) === null || a(1) === undefined) return null;
      if (!Number.isFinite(n(1))) return null;
      return s(0).slice(0, truncNum(a(1)));
    case "RIGHT":
      if (a(1) === null || a(1) === undefined) return null;
      if (!Number.isFinite(n(1))) return null;
      return truncNum(a(1)) === 0 ? "" : s(0).slice(-truncNum(a(1)));
    case "MID":
    case "SUBSTR":
    case "SUBSTRING": return a(1) === null || a(2) === null ? null : s(0).slice(n(1) - 1, n(1) - 1 + n(2));
    case "REPLACE": return s(0).split(s(1)).join(s(2));
    case "REGEXREPLACE": {
      try { return s(0).replace(new RegExp(s(1), "g"), s(2)); }
      catch { return s(0); }
    }
    case "REGEX_REPLACE": {
      try { return s(0).replace(new RegExp(s(1), "g"), s(2)); }
      catch { return s(0); }
    }
    case "REGEXMATCH": {
      try { return new RegExp(s(1)).test(s(0)); }
      catch { return false; }
    }
    case "REGEX_MATCH": {
      try { return new RegExp(s(1)).test(s(0)); }
      catch { return false; }
    }
    case "CONTAINS": return vectorizedFunction(args, ([value, search]) => toStr(value).includes(toStr(search)));
    case "HAS_OPTION": {
      const expected = s(1);
      return asArrayValue(a(0)).some((item) => optionText(item) === expected);
    }
    case "GET_SINGLE_SELECT_VALUE":
      return singleSelectValue(a(0));
    case "GET_PROPERTY":
      return getPropertyValue(a(0), a(1));
    case "JSONB_EXTRACT_PATH_TEXT":
      return jsonbExtractPathText(a(0), args.slice(1));
    case "FIND":
    case "SEARCH": return s(0).indexOf(s(1)) + 1; // 1-indexed, 0 when absent
    case "REVERSE": return vectorizedFunction(args, ([value]) => Array.from(toStr(value)).reverse().join(""));
    case "SPLIT": return s(0).split(s(1));
    case "SPLIT_PART": {
      const index = Math.floor(n(2));
      if (index < 1) return "";
      return s(0).split(s(1))[index - 1] || "";
    }
    case "ARRAYJOIN":
    case "JOIN":
      return Array.isArray(a(0)) ? (a(0) as unknown[]).map(displayText).join(s(1)) : displayText(a(0));
    case "T": return typeof a(0) === "string" ? a(0) : "";
    case "TOVARCHAR":
    case "TOTEXT": return toStr(a(0));
    case "TOURL": {
      const url = s(0);
      return BASEROW_FORMULA_URL_RE.test(url) ? url : "";
    }
    case "ENCODE_URI": return lowercasePercentEscapes(encodeURI(s(0)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`));
    case "ENCODE_URI_COMPONENT": return lowercasePercentEscapes(encodeURIComponent(s(0)));
    case "BLANK": return null;

    // ── Link / Button ───────────────────────────────────────────────────────
    case "LINK":
      return {
        url: s(0),
        label: args.length > 1 && a(1) !== null && a(1) !== undefined ? s(1) : null,
      };
    case "BUTTON":
      return {
        url: s(0),
        label: args.length > 1 && a(1) !== null && a(1) !== undefined ? s(1) : "",
      };
    case "GET_LINK_URL": {
      const linkValue = a(0);
      return isFormulaLinkValue(linkValue) ? linkValue.url : null;
    }
    case "GET_LINK_LABEL": {
      const linkValue = a(0);
      return isFormulaLinkValue(linkValue) ? linkValue.label : null;
    }

    // ── Numbers ─────────────────────────────────────────────────────────────
    case "EQUAL": return equalValues(a(0), a(1)) || a(0) == a(1);
    case "NOT_EQUAL": return !(equalValues(a(0), a(1)) || a(0) == a(1));
    case "GREATER_THAN": return compareValues(">", a(0), a(1));
    case "GREATER_THAN_OR_EQUAL": return compareValues(">=", a(0), a(1));
    case "LESS_THAN": return compareValues("<", a(0), a(1));
    case "LESS_THAN_OR_EQUAL": return compareValues("<=", a(0), a(1));
    case "ADD": return addValues(a(0), a(1));
    case "MINUS": return minusValues(a(0), a(1));
    case "MULTIPLY": return multiplyValues(a(0), a(1));
    case "DIVIDE": return divideValues(a(0), a(1));
    case "MOD": return n(1) === 0 ? Number.NaN : n(0) % n(1);
    case "ABS": return Math.abs(n(0));
    case "ROUND": {
      const decimalPlaces = truncNum(a(1));
      if (!Number.isFinite(decimalPlaces)) return Number.NaN;
      return roundHalfAwayFromZero(n(0), decimalPlaces);
    }
    case "ROUNDUP":
    case "CEIL": return Math.ceil(n(0));
    case "ROUNDDOWN":
    case "FLOOR": return Math.floor(n(0));
    case "POWER":
    case "POW": return Math.pow(n(0), n(1));
    case "SQRT": return Math.sqrt(n(0));
    case "EXP": return Math.exp(n(0));
    case "LN": {
      const value = n(0);
      return Number.isFinite(value) && value > 0 ? finiteOrNaN(Math.log(value)) : Number.NaN;
    }
    case "LOG": {
      if (args.length <= 1) {
        const value = n(0);
        return Number.isFinite(value) && value > 0 ? finiteOrNaN(Math.log(value)) : Number.NaN;
      }
      const base = n(0);
      const value = n(1);
      return Number.isFinite(base) && Number.isFinite(value) && base > 0 && base !== 1 && value > 0
        ? finiteOrNaN(Math.log(value) / Math.log(base))
        : Number.NaN;
    }
    case "LOG10": {
      const value = n(0);
      return Number.isFinite(value) && value > 0 ? finiteOrNaN(Math.log10(value)) : Number.NaN;
    }
    case "GREATEST":
    case "MAX": {
      const values = numericFunctionValues(args);
      return values.length ? Math.max(...values) : null;
    }
    case "LEAST":
    case "MIN": {
      const values = numericFunctionValues(args);
      return values.length ? Math.min(...values) : null;
    }
    case "SUM":
      return numericFunctionValues(args).reduce((total, value) => total + value, 0);
    case "AVERAGE":
    case "AVG": {
      const values = numericFunctionValues(args);
      return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
    }
    case "VARIANCE_POP": {
      const values = numericFunctionValues(args);
      return variance(values, false);
    }
    case "VARIANCE_SAMPLE": {
      const values = numericFunctionValues(args);
      return variance(values, true);
    }
    case "STDDEV_POP": {
      const value = variance(numericFunctionValues(args), false);
      return value === null ? null : Math.sqrt(value);
    }
    case "STDDEV_SAMPLE": {
      const value = variance(numericFunctionValues(args), true);
      return value === null ? null : Math.sqrt(value);
    }
    case "INT":
    case "TRUNC": return Math.trunc(n(0));
    case "IS_EVEN":
    case "EVEN": return Number.isFinite(n(0)) && Number.isInteger(n(0)) && n(0) % 2 === 0;
    case "IS_ODD":
    case "ODD": return Number.isFinite(n(0)) && Number.isInteger(n(0)) && Math.abs(n(0) % 2) === 1;
    case "SIGN": return Math.sign(n(0));
    case "IS_NAN": return isFormulaNaN(a(0));
    case "WHEN_NAN": return isFormulaNaN(a(0)) ? a(1) : a(0);
    case "RANDOM_INT": return randomInt(a(0), a(1));
    case "RANDOM_FLOAT": return randomFloat(a(0), a(1));
    case "RANDOM_BOOL": return Math.random() < 0.5;
    case "GENERATE_UUID": return generateUuid();
    case "PI": return Math.PI;
    case "E": return Math.E;
    case "TONUMBER":
    case "NUMBER": return formulaNumber(a(0));

    // ── Date ────────────────────────────────────────────────────────────────
    case "NOW": return new Date().toISOString();
    case "TODAY": return new Date().toISOString().slice(0, 10);
    case "YEAR": { const d = new Date(s(0)); return isNaN(d.getTime()) ? null : d.getFullYear(); }
    case "MONTH": { const d = new Date(s(0)); return isNaN(d.getTime()) ? null : d.getMonth() + 1; }
    case "DAY": { const d = new Date(s(0)); return isNaN(d.getTime()) ? null : d.getDate(); }
    case "HOUR": { const d = new Date(s(0)); return isNaN(d.getTime()) ? null : d.getHours(); }
    case "MINUTE": { const d = new Date(s(0)); return isNaN(d.getTime()) ? null : d.getMinutes(); }
    case "SECOND": { const d = new Date(s(0)); return isNaN(d.getTime()) ? null : d.getSeconds(); }
    case "WEEKDAY": { const d = new Date(s(0)); return isNaN(d.getTime()) ? null : d.getDay() + 1; }
    case "DATEADD": {
      const base = new Date(s(0));
      if (isNaN(base.getTime())) return null;
      const unit = s(2).toLowerCase();
      const amt = n(1);
      if (unit === "days" || unit === "day") base.setDate(base.getDate() + amt);
      else if (unit === "months" || unit === "month") base.setMonth(base.getMonth() + amt);
      else if (unit === "years" || unit === "year") base.setFullYear(base.getFullYear() + amt);
      else if (unit === "hours" || unit === "hour") base.setHours(base.getHours() + amt);
      else if (unit === "minutes" || unit === "minute") base.setMinutes(base.getMinutes() + amt);
      return base.toISOString();
    }
    case "DATEDIFF":
    case "DATE_DIFF": {
      return args.length >= 3 && typeof a(0) === "string"
        ? dateDiff(a(0), a(1), a(2))
        : dateDiff(a(2), a(0), a(1));
    }
    case "DATE_INTERVAL":
      return dateIntervalValue(a(0));
    case "BC_TO_NULL":
      return bcToNull(a(0));
    case "TODURATION":
      return Number.isFinite(n(0)) ? formulaDuration(n(0)) : null;
    case "TOSECONDS":
      return durationValue(a(0))?.seconds ?? null;
    case "TODATE":
    case "DATEFORMAT": {
      const d = dateFromInput(a(0), a(1));
      return d ? dateOnly(d) : null;
    }
    case "TODATE_TZ": {
      const d = dateFromInputTimezone(a(0), a(1), a(2));
      return d ? isoWithoutMilliseconds(d) : null;
    }
    case "DATETIME_FORMAT":
      return datetimeFormat(a(0), a(1));
    case "DATETIME_FORMAT_TZ":
      return datetimeFormat(a(0), a(1), a(2));

    // ── Array / Count ────────────────────────────────────────────────────────
    case "COUNT": return Array.isArray(a(0)) ? (a(0) as unknown[]).filter(x => x !== null && x !== undefined && x !== "").length : (a(0) !== null && a(0) !== "" ? 1 : 0);
    case "COUNTA": return Array.isArray(a(0)) ? (a(0) as unknown[]).filter(Boolean).length : (a(0) ? 1 : 0);
    case "COUNTALL": return Array.isArray(a(0)) ? (a(0) as unknown[]).length : 1;
    case "ARRAY_AGG":
      return arrayAgg(a(0), true);
    case "ARRAY_AGG_NO_NESTING":
      return arrayAgg(a(0), false);
    case "ARRAY_AGG_UNNESTING":
      return arrayAggUnnesting(a(0));
    case "MANY_TO_MANY_AGG":
    case "MULTIPLE_SELECT_OPTIONS_AGG":
      return manyToManyGroups(a(0));
    case "MANY_TO_MANY_COUNT":
    case "MULTIPLE_SELECT_COUNT":
      return manyToManyLeafValues(a(0)).length;
    case "STRING_AGG_MANY_TO_MANY_VALUES":
    case "STRING_AGG_MULTIPLE_SELECT_VALUES":
      return manyToManyText(a(0));
    case "FILTER": {
      const values = Array.isArray(a(0)) ? a(0) as unknown[] : [a(0)];
      const mask = a(1);
      if (Array.isArray(mask)) {
        return values.filter((_value, index) => toBool(mask[index]));
      }
      return toBool(mask) ? values : [];
    }
    case "INDEX": {
      const values = asArrayValue(a(0));
      const index = Math.trunc(n(1));
      return index >= 0 && index < values.length ? values[index] : null;
    }
    case "AT":
      return runtimeAt(a(0), a(1));
    case "TO_ARRAY":
      return ensureRuntimeArray(a(0));
    case "ANY":
      return functionValues(args).some(toBool);
    case "EVERY":
      return functionValues(args).every(toBool);

    // ── Files ───────────────────────────────────────────────────────────────
    case "GET_FILE_VISIBLE_NAME":
      return fileString(singleFileValue(a(0)), ["visible_name", "original_name", "name"]);
    case "GET_FILE_MIME_TYPE":
      return fileString(singleFileValue(a(0)), ["mime_type", "type"]);
    case "GET_FILE_COUNT":
      return fileValues(a(0)).length;
    case "GET_FILE_SIZE":
      return fileNumber(singleFileValue(a(0)), ["size"]);
    case "GET_IMAGE_WIDTH":
      return fileNumber(singleFileValue(a(0)), ["image_width", "width"]);
    case "GET_IMAGE_HEIGHT":
      return fileNumber(singleFileValue(a(0)), ["image_height", "height"]);
    case "IS_IMAGE": {
      const file = singleFileValue(a(0));
      if (!file) return false;
      if (typeof file.is_image === "boolean") return file.is_image;
      return fileString(file, ["mime_type", "type"]).toLowerCase().startsWith("image/");
    }

    default:
      throw new Error(`Unknown function: ${fn}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FormulaResult {
  value: unknown;
  error: string | null;
}

export function parseFormulaAst(formula: string): FormulaASTNode {
  const tokens = tokenize(formula);
  if (tokens.length > 2048) throw new Error("The formula exceeded the maximum formula size.");
  return new Parser(tokens).parse();
}

/**
 * Evaluate a formula string against a row's field values.
 *
 * @param formula  The formula string, e.g. `CONCAT({First Name}, " ", {Last Name})`
 * @param fields   Map of field name (or field_<id>) to current cell value
 * @returns        { value, error }
 */
export function evaluateFormula(formula: string, fields: FieldValues): FormulaResult {
  try {
    const ast = parseFormulaAst(formula);
    const value = unwrapFormulaValue(evaluate(ast, fields));
    return { value, error: null };
  } catch (e: any) {
    return { value: null, error: e.message || "Formula error" };
  }
}

/**
 * Evaluate a formula for all rows, resolving field references to their
 * actual values via the provided field mapping.
 *
 * @param formula      The formula string
 * @param rows         Array of raw row objects from D1 (field_<id> keys)
 * @param fieldById    Map of field id → field name
 */
export function evaluateFormulaRows(
  formula: string,
  rows: Record<string, unknown>[],
  fieldById: Map<number, string>
): FormulaResult[] {
  // Build field-name → id mapping for reverse lookup
  const nameToId = new Map<string, number>();
  for (const [id, name] of fieldById) {
    nameToId.set(name.toLowerCase(), id);
  }

  return rows.map(row => {
    // Build a fields lookup with both name-keyed and field_<id>-keyed access
    const fields: FieldValues = {
      __row_id: row.id,
      row_id: row.id,
    };
    for (const [id, name] of fieldById) {
      const rawVal = row[`field_${id}`];
      fields[name] = rawVal;
      fields[`field_${id}`] = rawVal;
      fields[name.toLowerCase()] = rawVal;
    }
    return evaluateFormula(formula, fields);
  });
}
