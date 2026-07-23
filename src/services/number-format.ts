import type { FieldMeta } from "./dynamic-tables";

const NUMBER_FORMATS: Record<string, { thousandSeparator: string; decimalSeparator: string }> = {
  SPACE_COMMA: { thousandSeparator: " ", decimalSeparator: "," },
  SPACE_PERIOD: { thousandSeparator: " ", decimalSeparator: "." },
  COMMA_PERIOD: { thousandSeparator: ",", decimalSeparator: "." },
  PERIOD_COMMA: { thousandSeparator: ".", decimalSeparator: "," },
};

function numberFormat(field: FieldMeta) {
  const settings = field.settings || {};
  return NUMBER_FORMATS[String(settings.number_separator || "")] || { thousandSeparator: "", decimalSeparator: "." };
}

function hasNumberFormatting(field: FieldMeta): boolean {
  const settings = field.settings || {};
  return Boolean(settings.number_prefix || settings.number_suffix || settings.number_separator);
}

export const NUMERIC_STORAGE_PREFIX = "n:";

export function encodeNumericStorageValue(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && value.startsWith(NUMERIC_STORAGE_PREFIX)) return value;
  const text = String(value).trim();
  if (!text) return null;
  return decimalPlacesInInput(text) !== null ? `${NUMERIC_STORAGE_PREFIX}${text}` : value;
}

export function decodeNumericStorageValue(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith(NUMERIC_STORAGE_PREFIX)) {
    return value.slice(NUMERIC_STORAGE_PREFIX.length);
  }
  return value;
}

export function numericStorageValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const decoded = decodeNumericStorageValue(value);
  if (decoded === "") return null;
  const numeric = Number(decoded);
  return Number.isFinite(numeric) ? numeric : null;
}

export function numericStorageSqlExpression(quotedColumn: string): string {
  const textColumn = `CAST(${quotedColumn} AS TEXT)`;
  return `CASE
    WHEN ${quotedColumn} IS NULL OR ${textColumn} = '' THEN NULL
    WHEN ${textColumn} LIKE '${NUMERIC_STORAGE_PREFIX}%' THEN CAST(SUBSTR(${textColumn}, ${NUMERIC_STORAGE_PREFIX.length + 1}) AS REAL)
    ELSE CAST(${quotedColumn} AS REAL)
  END`;
}

export function decimalPlacesInInput(text: string): number | null {
  const normalized = text.trim();
  const match = normalized.match(/^[+-]?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const fraction = match[2] ?? match[3] ?? "";
  const exponent = Number(match[4] || 0);
  return Math.max(0, fraction.length - exponent);
}

interface DecimalParts {
  negative: boolean;
  digits: string;
  scale: number;
}

function parseDecimalParts(value: unknown): DecimalParts | null {
  if (value === null || value === undefined || value === "") return null;
  const decoded = decodeNumericStorageValue(value);
  const text = String(decoded).trim();
  if (!text) return null;

  const match = text.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;

  const integerPart = match[2] ?? "";
  const fractionalPart = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] || 0);
  let digits = `${integerPart}${fractionalPart}`.replace(/^0+(?=\d)/, "");
  let scale = fractionalPart.length - exponent;

  if (digits === "" || /^0+$/.test(digits)) {
    return { negative: false, digits: "0", scale: Math.max(0, scale) };
  }

  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  if (scale > digits.length) {
    digits = `${"0".repeat(scale - digits.length)}${digits}`;
  }

  return {
    negative: match[1] === "-",
    digits,
    scale,
  };
}

function incrementDecimalDigits(digits: string): string {
  const chars = digits.split("");
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (chars[index] !== "9") {
      chars[index] = String(Number(chars[index]) + 1);
      return chars.join("");
    }
    chars[index] = "0";
  }
  return `1${chars.join("")}`;
}

function fixedDecimalText(value: unknown, decimalPlaces: number): string | null {
  const parsed = parseDecimalParts(value);
  if (!parsed) return null;

  let { digits, scale } = parsed;
  if (scale > decimalPlaces) {
    const drop = scale - decimalPlaces;
    const keepLength = Math.max(0, digits.length - drop);
    let kept = digits.slice(0, keepLength) || "0";
    const dropped = digits.slice(keepLength);
    const firstDropped = dropped[0] || "0";
    const hasNonZeroTail = /[1-9]/.test(dropped.slice(1));
    const lastKept = Number(kept[kept.length - 1] || "0");
    const roundUp = firstDropped > "5" || (firstDropped === "5" && (hasNonZeroTail || lastKept % 2 === 1));
    if (roundUp) kept = incrementDecimalDigits(kept);
    digits = kept;
    scale = decimalPlaces;
  } else if (scale < decimalPlaces) {
    digits += "0".repeat(decimalPlaces - scale);
    scale = decimalPlaces;
  }

  if (scale > 0 && digits.length <= scale) {
    digits = `${"0".repeat(scale - digits.length + 1)}${digits}`;
  }

  const integerEnd = scale === 0 ? digits.length : digits.length - scale;
  const rawInteger = digits.slice(0, integerEnd) || "0";
  const integerPart = rawInteger.replace(/^0+(?=\d)/, "") || "0";
  const fractionalPart = scale > 0 ? digits.slice(integerEnd).padStart(scale, "0") : "";
  const isZero = /^0+$/.test(integerPart) && (!fractionalPart || /^0+$/.test(fractionalPart));
  return `${parsed.negative && !isZero ? "-" : ""}${integerPart}${scale > 0 ? `.${fractionalPart}` : ""}`;
}

export function formatNumberForApi(field: FieldMeta, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const rawDecimalPlaces = Number(field.settings?.number_decimal_places || 0);
  const decimalPlaces = Number.isFinite(rawDecimalPlaces) ? Math.max(0, Math.trunc(rawDecimalPlaces)) : 0;
  return fixedDecimalText(value, decimalPlaces);
}

function canonicalFormattedNumberText(field: FieldMeta, text: string): string | null {
  if (!hasNumberFormatting(field)) return null;

  const settings = field.settings || {};
  const { decimalSeparator } = numberFormat(field);
  let result = text.trim();
  let isNegative = false;

  if (result.startsWith("-")) {
    isNegative = true;
    result = result.slice(1);
  }

  const prefix = String(settings.number_prefix || "");
  if (prefix && result.startsWith(prefix)) {
    result = result.slice(prefix.length);
  }

  const suffix = String(settings.number_suffix || "");
  if (suffix && result.endsWith(suffix)) {
    result = result.slice(0, -suffix.length);
  }

  result = result.trim();
  const firstDecimal = result.indexOf(decimalSeparator);
  if (firstDecimal === -1) {
    result = result.replace(/[^0-9]/g, "");
  } else {
    const integerPart = result.slice(0, firstDecimal).replace(/[^0-9]/g, "");
    const decimalPart = result.slice(firstDecimal + decimalSeparator.length).replace(/[^0-9]/g, "");
    result = `${integerPart}.${decimalPart || "0"}`;
  }

  if (!/[0-9]/.test(result)) return null;
  return `${isNegative ? "-" : ""}${result}`;
}

export function canonicalNumberText(field: FieldMeta, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (decimalPlacesInInput(text) !== null) return text;
  return canonicalFormattedNumberText(field, text);
}

export function formatNumberForExport(field: FieldMeta, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";

  const settings = field.settings || {};
  const rawDecimalPlaces = Number(settings.number_decimal_places || 0);
  const decimalPlaces = Number.isFinite(rawDecimalPlaces) ? Math.max(0, Math.trunc(rawDecimalPlaces)) : 0;
  const fixed = formatNumberForApi(field, value);
  if (fixed === null) return String(value);

  if (!hasNumberFormatting(field)) return fixed;

  const { thousandSeparator, decimalSeparator } = numberFormat(field);
  const negative = fixed.startsWith("-");
  const [integerPart, fractionalPart = ""] = (negative ? fixed.slice(1) : fixed).split(".");
  const grouped = thousandSeparator
    ? integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousandSeparator)
    : integerPart;
  const fraction = decimalPlaces > 0 ? `${decimalSeparator}${fractionalPart}` : "";
  return `${negative ? "-" : ""}${String(settings.number_prefix || "")}${grouped}${fraction}${String(settings.number_suffix || "")}`.trim();
}
