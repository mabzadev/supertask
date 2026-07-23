import { strToU8, zipSync } from "fflate";
import { ensureUserTableSystemColumns, type FieldMeta } from "./dynamic-tables";
import { getActiveFields, serializeRowForViewWithComputed } from "./view-helpers";
import { queryViewRows } from "./view-query";
import { formatNumberForExport, numericStorageValue } from "./number-format";

export interface TableExportFile {
  contentType: string;
  extension: string;
  body: string | Uint8Array;
}

export interface TableExportOptions {
  exporter_type?: string;
  view_id?: number | null;
  fields?: number[] | null;
  csv_include_header?: boolean;
  csv_column_separator?: string;
  excel_include_header?: boolean;
  organize_files?: boolean;
  export_charset?: string;
  filters?: unknown;
  order_by?: string | null;
  group_by?: string | null;
  search?: string | null;
}

export interface TableExportRuntime {
  files?: R2Bucket;
}

function csvDelimiter(value: unknown): string {
  if (value === "tab") return "\t";
  if (value === "record_separator") return "\x1e";
  if (value === "unit_separator") return "\x1f";
  const raw = typeof value === "string" && value.length > 0 ? value : ",";
  return [",", ";", "|", "\t", "\x1e", "\x1f"].includes(raw) ? raw : ",";
}

function csvCell(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  const escaped = str.replace(/"/g, '""');
  const pattern = new RegExp(`["\\n\\r${escapeRegExp(delimiter)}]`);
  return pattern.test(escaped) ? `"${escaped}"` : escaped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function fileReferences(value: unknown): Record<string, unknown>[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function scalarLabel(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(scalarLabel).filter(Boolean).join(",");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return String(object.value ?? object.visible_name ?? object.original_name ?? object.name ?? object.url ?? object.id ?? "");
  }
  return String(value);
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlElement(name: string, value: unknown): string {
  return `<${name}>${xmlValue(value)}</${name}>`;
}

function xmlValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.map((item) => xmlElement("item", item)).join("");
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>)
      .map(([key, entryValue]) => xmlElement(key, entryValue))
      .join("");
  }
  return escapeXml(parsed);
}

function formatDate(value: unknown, field: FieldMeta): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const settings = field.settings || {};
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const format = String(settings.date_format || "EU").toUpperCase();
  let result = format === "US" ? `${month}/${day}/${year}` : format === "ISO" ? `${year}-${month}-${day}` : `${day}/${month}/${year}`;
  if (settings.date_include_time) {
    const hours24 = date.getUTCHours();
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    if (String(settings.date_time_format || "24") === "12") {
      const suffix = hours24 >= 12 ? "PM" : "AM";
      const hours12 = hours24 % 12 || 12;
      result += ` ${hours12}:${minutes} ${suffix}`;
    } else {
      result += ` ${String(hours24).padStart(2, "0")}:${minutes}`;
    }
  }
  return result;
}

function formatDuration(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const seconds = numericStorageValue(value);
  if (seconds === null) return String(value);
  const sign = seconds < 0 ? "-" : "";
  const total = Math.abs(Math.trunc(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return rest > 0
    ? `${sign}${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

export function humanExportValue(field: FieldMeta, value: unknown): string {
  const parsed = parseJson(value);
  if (parsed === null || parsed === undefined) return "";
  switch (field.type) {
    case "boolean":
      return parsed ? "true" : "false";
    case "password":
      return parsed ? "true" : "false";
    case "number":
      return formatNumberForExport(field, parsed);
    case "date":
    case "created_on":
    case "last_modified":
      return formatDate(parsed, field);
    case "duration":
      return formatDuration(parsed);
    case "single_select":
      return scalarLabel(parsed);
    case "multiple_select":
    case "link_row":
    case "multiple_collaborators":
    case "lookup":
    case "file":
      return Array.isArray(parsed) ? parsed.map(scalarLabel).filter(Boolean).join(",") : scalarLabel(parsed);
    case "created_by":
    case "last_modified_by":
      return scalarLabel(parsed);
    default:
      return typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
  }
}

function exportFields(fields: FieldMeta[], options: TableExportOptions): FieldMeta[] {
  if (!Array.isArray(options.fields) || options.fields.length === 0) return fields;
  const order = new Map(options.fields.map((id, index) => [Number(id), index]));
  return fields
    .filter((field) => order.has(field.id))
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
}

function uniqueJsonExportName(data: Record<string, unknown>, baseName: string, count?: number): string {
  const name = count ? `${baseName} ${count}` : baseName;
  return Object.prototype.hasOwnProperty.call(data, name)
    ? uniqueJsonExportName(data, baseName, count ? count + 1 : 2)
    : name;
}

function safeXmlTagName(name: string, numericPrefix: string, emptyFallback: string): string {
  let safe = "";
  for (const char of name) safe += /^[a-zA-Z0-9]$/.test(char) ? char : "-";
  while (safe.includes("--")) safe = safe.replace(/--/g, "-");
  if (safe.startsWith("-")) safe = safe.slice(1);
  if (safe.endsWith("-")) safe = safe.slice(0, -1);
  if (safe && /^[0-9]/.test(safe)) safe = `${numericPrefix}${safe}`;
  return safe || emptyFallback;
}

function uniqueXmlExportName(data: Record<string, unknown>, baseName: string, count?: number): string {
  const name = count ? `${baseName}-${count}` : baseName;
  return Object.prototype.hasOwnProperty.call(data, name)
    ? uniqueXmlExportName(data, baseName, count ? count + 1 : 2)
    : name;
}

function excelColumnName(index: number): string {
  let column = "";
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    current = Math.floor((current - 1) / 26);
  }
  return column;
}

function excelCellValue(value: unknown): string {
  return escapeXml(String(value ?? ""));
}

function worksheetXml(rows: unknown[][]): string {
  const xmlRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) => {
      const ref = `${excelColumnName(columnIndex)}${rowNumber}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${excelCellValue(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${xmlRows}</sheetData>` +
    `</worksheet>`;
}

function buildXlsx(rows: unknown[][]): Uint8Array {
  const created = new Date().toISOString();
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`
    ),
    "docProps/app.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>Opentabl</Application>` +
      `</Properties>`
    ),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:creator>Opentabl</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>` +
      `</cp:coreProperties>`
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets>` +
      `</workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`
    ),
    "xl/worksheets/sheet1.xml": strToU8(worksheetXml(rows)),
  };
  return zipSync(files);
}

async function buildFileZip(
  db: D1Database,
  rows: Record<string, unknown>[],
  fields: FieldMeta[],
  options: TableExportOptions,
  runtime?: TableExportRuntime
): Promise<Uint8Array> {
  if (!runtime?.files) throw new Error("EXPORT_FILE_STORAGE_NOT_CONFIGURED");

  const fileFields = fields.filter((field) => field.type === "file");
  const archive: Record<string, Uint8Array> = {};
  const organizeFiles = options.organize_files !== false;
  const exported = new Set<string>();

  for (const row of rows) {
    const rowFolder = organizeFiles ? `row_${row.id}/` : "";
    for (const field of fileFields) {
      for (const file of fileReferences(row[`field_${field.id}`])) {
        if (file.external === true) continue;
        const name = typeof file.name === "string" ? file.name : "";
        if (!name) continue;
        const archivePath = `${rowFolder}${name}`;
        if (exported.has(archivePath)) continue;
        const metadata = await db.prepare("SELECT r2_key FROM core_userfile WHERE name=?")
          .bind(name)
          .first<{ r2_key: string }>();
        const key = metadata?.r2_key || (name.startsWith("user_files/") ? name : `user_files/${name}`);
        const object = await runtime.files.get(key);
        if (!object) continue;
        archive[archivePath] = new Uint8Array(await object.arrayBuffer());
        exported.add(archivePath);
      }
    }
  }

  return zipSync(archive);
}

function exportRequestUrl(options: TableExportOptions): string {
  const url = new URL("https://opentabl.local/export");
  if (options.order_by) url.searchParams.set("order_by", options.order_by);
  if (options.group_by) url.searchParams.set("group_by", options.group_by);
  if (options.search) url.searchParams.set("search", options.search);
  if (options.filters) {
    url.searchParams.append("filters", typeof options.filters === "string" ? options.filters : JSON.stringify(options.filters));
  }
  return url.toString();
}

async function loadRows(db: D1Database, tableId: number, options: TableExportOptions): Promise<{ fields: FieldMeta[]; rows: Record<string, unknown>[] }> {
  if (options.view_id) {
    const view = await db.prepare("SELECT * FROM database_view WHERE id=? AND table_id=? AND trashed=0")
      .bind(options.view_id, tableId)
      .first<any>();
    if (!view) throw new Error("EXPORT_VIEW_DOES_NOT_EXIST");
    const result = await queryViewRows(db, view, exportRequestUrl(options));
    return { fields: result.fields, rows: result.rows };
  }

  const fields = await getActiveFields(db, tableId);
  await ensureUserTableSystemColumns(db, tableId);
  const rawRows = await db.prepare(`SELECT * FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC`).all<Record<string, unknown>>();
  const rows = await Promise.all((rawRows.results || []).map((row) => serializeRowForViewWithComputed(db, row, fields)));
  return { fields, rows };
}

export async function buildTableExport(
  db: D1Database,
  tableId: number,
  options: TableExportOptions,
  runtime?: TableExportRuntime
): Promise<TableExportFile> {
  const exporterType = options.exporter_type || "csv";
  const loaded = await loadRows(db, tableId, options);
  const fields = exportFields(loaded.fields, options);

  if (exporterType === "json") {
    return {
      contentType: "application/json",
      extension: "json",
      body: JSON.stringify(loaded.rows.map((row) => {
        const item: Record<string, unknown> = { id: row.id };
        for (const field of fields) {
          const name = uniqueJsonExportName(item, field.name);
          item[name] = row[`field_${field.id}`] ?? "";
        }
        return item;
      }), null, 2),
    };
  }

  if (exporterType === "xml") {
    const charset = options.export_charset || "utf-8";
    const lines = [`<?xml version="1.0" encoding="${charset}" ?>`, "<rows>"];
    for (const row of loaded.rows) {
      const item: Record<string, unknown> = { id: row.id };
      for (const field of fields) {
        const fallback = `field-${field.id}`;
        const baseName = safeXmlTagName(field.name, "field-", fallback);
        const name = uniqueXmlExportName(item, baseName);
        item[name] = row[`field_${field.id}`] ?? "";
      }
      lines.push(xmlElement("row", item));
    }
    lines.push("</rows>");
    return {
      contentType: `application/xml;charset=${charset}`,
      extension: "xml",
      body: `${lines.join("\n")}\n`,
    };
  }

  if (exporterType === "excel") {
    const rows: unknown[][] = [];
    if (options.excel_include_header === true) rows.push(["id", ...fields.map((field) => field.name)]);
    for (const row of loaded.rows) {
      rows.push([
        row.id,
        ...fields.map((field) => humanExportValue(field, row[`field_${field.id}`])),
      ]);
    }
    return {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
      body: buildXlsx(rows),
    };
  }

  if (exporterType === "file") {
    return {
      contentType: "application/zip",
      extension: "zip",
      body: await buildFileZip(db, loaded.rows, fields, options, runtime),
    };
  }

  if (exporterType !== "csv") throw new Error("EXPORTER_TYPE_DOES_NOT_EXIST");

  const delimiter = csvDelimiter(options.csv_column_separator);
  const lines: string[] = [];
  if (options.csv_include_header !== false) {
    lines.push(["id", ...fields.map((field) => field.name)].map((value) => csvCell(value, delimiter)).join(delimiter));
  }
  for (const row of loaded.rows) {
    lines.push([
      csvCell(row.id, delimiter),
      ...fields.map((field) => csvCell(humanExportValue(field, row[`field_${field.id}`]), delimiter)),
    ].join(delimiter));
  }
  const charset = options.export_charset || "utf-8";
  return {
    contentType: `text/csv;charset=${charset}`,
    extension: "csv",
    body: `${charset === "utf-8" ? "\ufeff" : ""}${lines.join("\r\n")}${lines.length ? "\r\n" : ""}`,
  };
}
