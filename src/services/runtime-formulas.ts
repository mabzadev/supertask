export type RuntimeFormulaCallResult = {
  handled: boolean;
  value: unknown;
};

export function evaluateCommonRuntimeFormulaCall(name: string, args: unknown[]): RuntimeFormulaCallResult {
  const normalized = name.toLowerCase();
  switch (normalized) {
    case "concat":
      return handled(args.map((arg) => arg === null || arg === undefined ? "" : typeof arg === "string" ? arg : JSON.stringify(arg)).join(""));
    case "and":
      return handled(args.every(Boolean));
    case "or":
      return handled(args.some(Boolean));
    case "not":
      return handled(!args[0]);
    case "if":
      return handled(args[0] ? args[1] : args[2]);
    case "tonumber":
      return handled(Number(args[0] ?? 0));
    case "totext":
      return handled(args[0] === null || args[0] === undefined ? "" : String(args[0]));
    case "lower":
      return handled(String(args[0] ?? "").toLowerCase());
    case "upper":
      return handled(String(args[0] ?? "").toUpperCase());
    case "capitalize":
      return handled(capitalize(String(args[0] ?? "")));
    case "get_property":
      return handled(getRuntimeProperty(args[0], args[1]));
    case "add":
      return handled(Number(args[0] ?? 0) + Number(args[1] ?? 0));
    case "minus":
      return handled(Number(args[0] ?? 0) - Number(args[1] ?? 0));
    case "multiply":
      return handled(Number(args[0] ?? 0) * Number(args[1] ?? 0));
    case "divide":
      return handled(Number(args[0] ?? 0) / Number(args[1] ?? 0));
    case "round":
      return handled(roundValue(args[0], args[1]));
    case "is_even":
      return handled(Number(args[0] ?? 0) % 2 === 0);
    case "is_odd":
      return handled(Number(args[0] ?? 0) % 2 !== 0);
    case "random_int":
      return handled(randomInt(args[0], args[1]));
    case "random_float":
      return handled(randomFloat(args[0], args[1]));
    case "random_bool":
      return handled(Math.random() < 0.5);
    case "generate_uuid":
      return handled(generateUuid());
    case "is_empty":
      return handled(isRuntimeEmpty(args[0]));
    case "length":
      return handled(runtimeLength(args[0]));
    case "contains":
      return handled(runtimeContains(args[0], args[1]));
    case "replace":
      return handled(String(args[0] ?? "").replaceAll(String(args[1] ?? ""), String(args[2] ?? "")));
    case "join":
      return handled(runtimeJoin(args[0], args.length > 1 ? String(args[1] ?? "") : ","));
    case "split":
      return handled(String(args[0] ?? "").split(args.length > 1 ? String(args[1] ?? "") : ""));
    case "strip":
      return handled(String(args[0] ?? "").trim());
    case "to_array":
      return handled(ensureRuntimeArray(args[0]));
    case "at":
      return handled(runtimeAt(args[0], args[1]));
    default:
      return { handled: false, value: null };
  }
}

function handled(value: unknown): RuntimeFormulaCallResult {
  return { handled: true, value };
}

function capitalize(value: string) {
  if (!value) return "";
  const [firstChar, ...remainingChars] = [...value];
  return firstChar.toUpperCase() + remainingChars.join("").toLowerCase();
}

function roundValue(value: unknown, decimalPlacesRaw: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return Number.NaN;
  const decimalPlaces = decimalPlacesRaw === undefined
    ? 2
    : Math.max(Math.trunc(Number(decimalPlacesRaw) || 0), 0);
  return Number(number.toFixed(decimalPlaces));
}

function isRuntimeEmpty(value: unknown) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

function runtimeLength(value: unknown) {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return null;
}

function runtimeContains(value: unknown, needle: unknown) {
  if (Array.isArray(value)) return value.includes(needle);
  if (value !== null && typeof value === "object") return Object.keys(value as Record<string, unknown>).includes(String(needle));
  if (typeof value === "string") return value.includes(String(needle ?? ""));
  return null;
}

function getRuntimeProperty(value: unknown, property: unknown) {
  const parsed = parseJsonRuntimeValue(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const key = String(property ?? "");
  return Object.prototype.hasOwnProperty.call(parsed, key)
    ? (parsed as Record<string, unknown>)[key]
    : null;
}

function runtimeJoin(value: unknown, separator: string) {
  if (Array.isArray(value)) return value.join(separator);
  if (typeof value === "string") return value.split("").join(separator);
  return null;
}

function ensureRuntimeArray(value: unknown) {
  const parsed = parseJsonRuntimeValue(value);
  if (parsed === null || parsed === undefined || parsed === "") return [];
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "string") return parsed.split(",").map((item) => item.trim());
  return [parsed];
}

function runtimeAt(value: unknown, indexRaw: unknown) {
  const index = Math.trunc(Number(indexRaw) || 0);
  const parsed = parseJsonRuntimeValue(value);
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

function parseJsonRuntimeValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || !["[", "{"].includes(text[0])) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function randomInt(minRaw: unknown, maxRaw: unknown) {
  const min = Math.ceil(Number(minRaw));
  const max = Math.floor(Number(maxRaw));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return Number.NaN;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function randomFloat(minRaw: unknown, maxRaw: unknown) {
  const min = Number(minRaw);
  const max = Number(maxRaw);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return Number.NaN;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.random() * (high - low) + low;
}

function generateUuid() {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const randomUuid = cryptoApi?.randomUUID;
  if (typeof randomUuid === "function") return randomUuid.call(cryptoApi);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}
