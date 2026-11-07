import type { D1Database } from "@cloudflare/workers-types";
import puppeteer from "@cloudflare/puppeteer";
import { serializeDatabaseTable } from "./database-serializers";
import {
  addFieldColumn,
  getOrCreateUserTable,
  serializeFieldValueForInsert,
  type FieldMeta,
  type FieldType,
} from "./dynamic-tables";
import { fieldTypeDefaults, isReadOnlyFieldType } from "./field-serialization";
import type { Env, JobMessage } from "../types/env";
import {
  deleteUnreferencedUserFiles,
  serializeUserFileCellForRequest,
  storeUserFile,
  type StoredUserFile,
} from "./user-files";
import { evaluateFormula } from "./formula-engine";
import { computeLinkedFieldValue } from "./computed-fields";

const AIRTABLE_BASE_URL = "https://airtable.com";
const AIRTABLE_API_BASE_URL = `${AIRTABLE_BASE_URL}/v0.3`;
const SYNTHETIC_PRIMARY_COLUMN_ID = "__supertask_airtable_primary";
const AIRTABLE_MAX_DURATION_VALUE = 86_399_999_913_600;
const AIRTABLE_ATTACHMENT_DOWNLOAD_ATTEMPTS = 3;
const AIRTABLE_ATTACHMENT_RANGE_CHUNK_SIZE = 1024 * 1024;

const BASE_HEADERS: Record<string, string> = {
  "User-Agent": "Supertask-Airtable-Importer/1.0",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

type AirtableImportPayload = {
  workspace_id?: number;
  airtable_share_url?: string;
  skip_files?: boolean;
  session?: string | null;
  session_signature?: string | null;
  _job_id?: number;
};

type AirtableInit = {
  requestId: string;
  initData: any;
  cookie: string;
  requestIdParam?: "requestId" | "request_id";
  userAgent?: string;
};

export type AirtableProgressState = "downloading-base" | "converting" | "downloading-files";
export type AirtableProgressReporter = (progress: number, state: AirtableProgressState) => void | Promise<void>;

type ImportedField = {
  id: number;
  airtableColumnId: string;
  airtableColumn?: any;
  airtableType: string;
  type: FieldType;
  primary: boolean;
  settings?: Record<string, unknown>;
  targetAirtableTableId?: string | null;
  targetTableId?: number | null;
  relationAirtableColumnId?: string | null;
  selectOptions?: Map<string, { id: number; value: string; color: string }>;
};

type ImportedTable = {
  airtableTable: any;
  tableData: any;
  table: any;
  fields: ImportedField[];
};

type RowLookup = Map<string, { id: number; value: string }>;

type AirtableViewSpec = {
  name: string;
  type: "grid" | "gallery" | "form" | "kanban" | "calendar" | "timeline";
  order: number;
  filterType: "AND" | "OR";
  rowHeightSize: "small" | "medium" | "large";
  cardCoverImageFieldId: number | null;
  singleSelectFieldId: number | null;
  dateFieldId: number | null;
  startDateFieldId: number | null;
  endDateFieldId: number | null;
  timescale: "day" | "week" | "month" | "year";
  fieldOptions: Array<{ fieldId: number; width: number; hidden: boolean; order: number }>;
  form?: {
    title: string;
    description: string;
    submitText: string;
    submitAction: "MESSAGE" | "REDIRECT";
    submitActionMessage: string;
    submitActionRedirectUrl: string;
    mode: "form" | "survey";
    showLogo: boolean;
    fieldOptions: Array<{
      fieldId: number;
      name: string;
      description: string;
      enabled: boolean;
      required: boolean;
      order: number;
      includeAllSelectOptions: boolean;
    }>;
  };
  sortings: Array<{ fieldId: number; order: "ASC" | "DESC" }>;
  groupBys: Array<{ fieldId: number; order: "ASC" | "DESC" }>;
  filterGroups: Array<{ airtableId: string; filterType: "AND" | "OR"; parentAirtableId: string | null }>;
  filters: Array<{ fieldId: number; type: string; value: string; groupAirtableId: string | null }>;
  decorations: Array<{ type: "left_border_color"; valueProviderType: "single_select_color" | "conditional_color"; valueProviderConf: object; order: number }>;
};

type ImportContext = {
  env: Env;
  workspaceId: number;
  userId: number | null;
  init: AirtableInit;
  rowLookups: Map<string, RowLookup>;
  signedUserContentUrls?: Record<string, string> | null;
  failedAttachmentCount?: number;
  importedFileNames?: Set<string>;
  deferAttachments?: boolean;
  currentAirtableTableId?: string;
  currentTableId?: number;
  pendingAttachments?: PendingAirtableAttachment[];
  report: AirtableImportReport;
};

type PendingAirtableAttachment = {
  taskKey: string;
  tableId: number;
  airtableTableId: string;
  airtableRowId: string;
  fieldId: number;
  airtableColumnId: string;
  fileIndex: number;
  file: any;
};

type AirtableAttachmentTaskPayload = {
  task_ids: number[];
  database_id: number;
  airtable_init?: AirtableInit;
};

function attachmentInitCacheKey(jobId: number): string {
  return `airtable:attachment-init:${jobId}`;
}

type ImportReportScope =
  | "Field"
  | "Cell"
  | "View"
  | "View sort"
  | "View group by"
  | "View filter"
  | "View color"
  | "View field options"
  | "Automations"
  | "Interfaces";

type ImportReportErrorType = "Unsupported feature" | "Data type mismatch" | "Other";

type ImportReportItem = {
  objectName: string;
  scope: ImportReportScope;
  table: string;
  errorType: ImportReportErrorType;
  message: string;
};

class AirtableImportReport {
  items: ImportReportItem[] = [];

  addFailed(
    objectName: string,
    scope: ImportReportScope,
    table: string,
    errorType: ImportReportErrorType,
    message: string
  ): void {
    this.items.push({ objectName, scope, table, errorType, message });
  }
}

const REPORT_SCOPES: Array<{ value: ImportReportScope; color: string }> = [
  { value: "Field", color: "light-blue" },
  { value: "Cell", color: "light-green" },
  { value: "View", color: "light-cyan" },
  { value: "View sort", color: "light-red" },
  { value: "View group by", color: "light-brown" },
  { value: "View filter", color: "light-pink" },
  { value: "View color", color: "light-gray" },
  { value: "View field options", color: "light-purple" },
  { value: "Automations", color: "light-orange" },
  { value: "Interfaces", color: "light-yellow" },
];

const REPORT_ERROR_TYPES: Array<{ value: ImportReportErrorType; color: string }> = [
  { value: "Unsupported feature", color: "yellow" },
  { value: "Data type mismatch", color: "red" },
  { value: "Other", color: "brown" },
];

function extractShareId(url: string): string {
  const match = url.match(/^https:\/\/airtable\.com\/((?:shr|app).*)$/);
  if (!match) {
    throw new Error("The Airtable URL is not a public shared base URL.");
  }
  return match[1];
}

function cleanName(value: unknown, fallback: string): string {
  const name = String(value || fallback).trim();
  return name.slice(0, 255) || fallback;
}

function cookiePairs(value: string): string[] {
  const pairs: string[] = [];
  const pattern = /(?:^|,\s*)([^=;,\s]+)=([^;]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) pairs.push(`${match[1]}=${match[2]}`);
  return pairs;
}

function mergeCookieHeaders(...values: Array<string | null | undefined>): string {
  const cookies = new Map<string, string>();
  for (const value of values) {
    if (!value) continue;
    for (const pair of value.includes(";") && !value.includes(",") ? value.split(";") : cookiePairs(value)) {
      const normalized = pair.trim();
      const separator = normalized.indexOf("=");
      if (separator <= 0) continue;
      cookies.set(normalized.slice(0, separator), normalized.slice(separator + 1));
    }
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function cookieHeader(headers: Headers, session?: string | null, signature?: string | null): string {
  const cookies: string[] = [];
  const setCookies = (headers as any).getSetCookie?.() || [];
  for (const cookie of setCookies) {
    const pair = cookie.split(";")[0];
    if (pair) cookies.push(pair);
  }
  if (setCookies.length === 0) cookies.push(...cookiePairs(headers.get("set-cookie") || ""));
  if (session) cookies.push(`__Host-airtable-session=${session}`);
  if (signature) cookies.push(`__Host-airtable-session.sig=${signature}`);
  return mergeCookieHeaders(...cookies);
}

function extractAssignedJson(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  let start = markerIndex + marker.length;
  while (/\s/.test(html[start] || "")) start += 1;
  if (html[start] !== "{" && html[start] !== "[") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }
  return null;
}

function parseSharedBaseHtml(
  html: string,
  cookies: string,
  evaluatedInitData?: unknown,
  evaluatedRequestId?: unknown
): AirtableInit {
  const requestId =
    (typeof evaluatedRequestId === "string" && evaluatedRequestId) ||
    html.match(/requestId\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/"requestId"\s*:\s*"([^"]+)"/)?.[1];
  const initData = evaluatedInitData ?? extractAssignedJson(html, "window.initData =");
  if (!requestId || !initData || typeof initData !== "object") {
    throw new Error("The shared Airtable link is not a base.");
  }
  if (!("sharedApplicationId" in initData)) {
    throw new Error("The shared Airtable link points to a view, not a base.");
  }
  return { requestId, initData, cookie: cookies };
}

async function fetchSharedBaseWithBrowser(
  env: Env,
  url: string,
  payload: AirtableImportPayload
): Promise<AirtableInit> {
  if (!env.BROWSER) throw new Error("The Airtable base requires authentication.");
  // Default egress: choosing a location is a feature this account doesn't have
  // (the launch fails with "not permitted to set a geoegress location").
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    let resolveApplicationRequest: (value: { url: string; headers: Record<string, string> }) => void = () => undefined;
    const applicationRequest = new Promise<{ url: string; headers: Record<string, string> }>((resolve) => {
      resolveApplicationRequest = resolve;
    });
    page.on("request", (request) => {
      const requestUrl = request.url();
      if (/\/v0\.3\/application\/[^/]+\/read\?/.test(requestUrl)) {
        resolveApplicationRequest({ url: requestUrl, headers: request.headers() });
      }
    });
    if (payload.session && payload.session_signature) {
      await page.setCookie(
        {
          name: "__Host-airtable-session",
          value: payload.session,
          url: AIRTABLE_BASE_URL,
          secure: true,
        },
        {
          name: "__Host-airtable-session.sig",
          value: payload.session_signature,
          url: AIRTABLE_BASE_URL,
          secure: true,
        }
      );
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (new URL(page.url()).pathname.startsWith("/login")) {
      throw new Error("The Airtable base requires authentication.");
    }

    const capturedRequest = await Promise.race([
      applicationRequest,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    const browserCookies = (await page.cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");
    const mergedCookies = mergeCookieHeaders(
      browserCookies,
      payload.session ? `__Host-airtable-session=${payload.session}` : "",
      payload.session_signature ? `__Host-airtable-session.sig=${payload.session_signature}` : ""
    );
    if (capturedRequest) {
      const requestUrl = new URL(capturedRequest.url);
      const applicationId = requestUrl.pathname.match(/\/application\/([^/]+)\/read/)?.[1] || "";
      const requestId = requestUrl.searchParams.get("requestId") || requestUrl.searchParams.get("request_id") || "";
      const accessPolicy = requestUrl.searchParams.get("accessPolicy") || "{}";
      const objectParams = JSON.parse(requestUrl.searchParams.get("stringifiedObjectParams") || "{}");
      const tableIds = Array.isArray(objectParams.includeDataForTableIds)
        ? objectParams.includeDataForTableIds.map(String)
        : [];
      if (!applicationId || !requestId || tableIds.length === 0) {
        throw new Error("The shared Airtable link is not a base.");
      }
      const title = (await page.title()).replace(/^Airtable\s*-\s*|\s*-\s*Airtable$/g, "").trim();
      return {
        requestId,
        requestIdParam: requestUrl.searchParams.has("requestId") ? "requestId" : "request_id",
        userAgent: capturedRequest.headers["user-agent"],
        cookie: mergedCookies,
        initData: {
          rawApplications: { [applicationId]: { name: title || "Airtable import" } },
          sharedApplicationId: applicationId,
          accessPolicy,
          codeVersion: capturedRequest.headers["x-airtable-inter-service-client-code-version"],
          pageLoadId: capturedRequest.headers["x-airtable-page-load-id"],
          singleApplicationScaffoldingData: {
            tableById: Object.fromEntries(tableIds.map((tableId: string) => [tableId, {}])),
          },
        },
      };
    }

    await page
      .waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).initData), {
        timeout: 20_000,
      })
      .catch(() => undefined);

    const html = await page.content();
    const globals = await page.evaluate(() => {
      const globalWindow = window as unknown as Record<string, unknown>;
      return {
        initData: globalWindow.initData,
        requestId: globalWindow.requestId,
      };
    });
    return parseSharedBaseHtml(
      html,
      mergedCookies,
      globals.initData,
      globals.requestId
    );
  } finally {
    await browser.close();
  }
}

async function fetchSharedBase(env: Env, shareId: string, payload: AirtableImportPayload): Promise<AirtableInit> {
  const initialUrl = `${AIRTABLE_BASE_URL}/${shareId}`;
  let url = initialUrl;
  let cookies = cookieHeader(new Headers(), payload.session, payload.session_signature);
  let response: Response | null = null;
  let redirectedToLogin = false;
  let bootstrappedAnonymousSession = false;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const headers = new Headers(BASE_HEADERS);
    if (cookies) headers.set("Cookie", cookies);
    response = await fetch(url, { headers, redirect: "manual" });
    cookies = mergeCookieHeaders(cookies, cookieHeader(response.headers));
    const location = response.headers.get("Location") || "";
    if (response.status < 300 || response.status >= 400 || !location) break;
    const nextUrl = new URL(location, url);
    if (nextUrl.pathname.startsWith("/login")) {
      if (!bootstrappedAnonymousSession) {
        bootstrappedAnonymousSession = true;
        try {
          const bootstrapHeaders = new Headers(BASE_HEADERS);
          if (cookies) bootstrapHeaders.set("Cookie", cookies);
          const bootstrap = await fetch(AIRTABLE_BASE_URL, { headers: bootstrapHeaders, redirect: "manual" });
          cookies = mergeCookieHeaders(cookies, cookieHeader(bootstrap.headers));
          url = initialUrl;
          continue;
        } catch {
          // Browser Rendering below remains the final authenticated fallback.
        }
      }
      redirectedToLogin = true;
      break;
    }
    url = nextUrl.toString();
  }
  if (redirectedToLogin || !response || !response.ok) {
    return fetchSharedBaseWithBrowser(env, initialUrl, payload);
  }

  const html = await response.text();
  try {
    return parseSharedBaseHtml(html, cookies);
  } catch (error) {
    if (error instanceof Error && error.message === "The shared Airtable link points to a view, not a base.") {
      throw error;
    }
    return fetchSharedBaseWithBrowser(env, initialUrl, payload);
  }
}

async function airtableJson(init: AirtableInit, url: string, stringifiedObjectParams: object): Promise<any> {
  const applicationId = Object.keys(init.initData.rawApplications || {})[0];
  const accessPolicy = JSON.parse(init.initData.accessPolicy || "{}");
  const params = new URLSearchParams({
    accessPolicy: JSON.stringify(accessPolicy),
    stringifiedObjectParams: JSON.stringify({ ...stringifiedObjectParams, allowMsgpackOfResult: false }),
  });
  params.set(init.requestIdParam || "request_id", init.requestId);
  const headers = new Headers({
    ...BASE_HEADERS,
    "x-airtable-application-id": applicationId,
    "x-airtable-client-queue-time": "45",
    "x-airtable-inter-service-client": "webClient",
    "x-airtable-inter-service-client-code-version": init.initData.codeVersion,
    "x-airtable-page-load-id": init.initData.pageLoadId,
    "X-Requested-With": "XMLHttpRequest",
    "x-time-zone": "Europe/Zurich",
    "x-user-locale": "en",
  });
  if (init.userAgent) headers.set("User-Agent", init.userAgent);
  if (init.cookie) headers.set("Cookie", init.cookie);

  const response = await fetch(`${url}?${params.toString()}`, { headers });
  if (!response.ok) {
    throw new Error(`Airtable request failed with status ${response.status}.`);
  }
  return response.json();
}

function tableDataFromAirtableResponse(response: any): any | null {
  const data = response?.data;
  if (!data || typeof data !== "object") return null;
  if (data.appBlanket) return data.tableDatas?.[0] || null;
  if (data.id) return data;
  return null;
}

function mergeRowsById(existing: any[] | undefined, incoming: any[] | undefined): any[] {
  const rows: any[] = [];
  const byId = new Map<string, number>();
  for (const row of [...(existing || []), ...(incoming || [])]) {
    const id = String(row?.id ?? "");
    if (!id) {
      rows.push(row);
      continue;
    }
    const index = byId.get(id);
    if (index === undefined) {
      byId.set(id, rows.length);
      rows.push(row);
    } else {
      rows[index] = { ...rows[index], ...row };
    }
  }
  return rows;
}

function mergeViewDataById(existing: any[] | undefined, incoming: any[] | undefined): any[] {
  const views: any[] = [];
  const byId = new Map<string, number>();
  for (const view of [...(existing || []), ...(incoming || [])]) {
    const id = String(view?.id ?? "");
    if (!id) {
      views.push(view);
      continue;
    }
    const index = byId.get(id);
    if (index === undefined) {
      byId.set(id, views.length);
      views.push(view);
      continue;
    }
    const previous = views[index];
    const rowOrder = [
      ...(Array.isArray(previous.rowOrder) ? previous.rowOrder : []),
      ...(Array.isArray(view.rowOrder) ? view.rowOrder : []),
    ];
    views[index] = {
      ...previous,
      ...view,
      rowOrder: rowOrder.length > 0 ? Array.from(new Set(rowOrder)) : view.rowOrder ?? previous.rowOrder,
    };
  }
  return views;
}

function mergeAirtableTableData(existing: any | undefined, incoming: any | null): any {
  if (!incoming) return existing;
  const merged = { ...(existing || {}), ...incoming };
  merged.rows = mergeRowsById(existing?.rows, incoming.rows);
  merged.viewDatas = mergeViewDataById(existing?.viewDatas, incoming.viewDatas);
  merged.signedUserContentUrls = {
    ...(existing?.signedUserContentUrls || {}),
    ...(incoming.signedUserContentUrls || {}),
  };
  return merged;
}

function airtableContinuationParams(response: any): Record<string, unknown> | null {
  const data = response?.data;
  const tableData = tableDataFromAirtableResponse(response);
  const candidates = [
    tableData?.nextOffset,
    tableData?.offset,
    tableData?.nextPageOffset,
    tableData?.nextPageToken,
    tableData?.nextCursor,
    tableData?.pagination?.next,
    tableData?.pagination?.offset,
    tableData?.pagination?.cursor,
    data?.nextOffset,
    data?.nextPageOffset,
    data?.nextPageToken,
    data?.nextCursor,
    data?.pagination?.next,
    data?.pagination?.offset,
    data?.pagination?.cursor,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === false || candidate === "") continue;
    if (typeof candidate === "object" && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
    return { offset: String(candidate) };
  }
  return null;
}

async function fetchPagedAirtableJson(
  init: AirtableInit,
  url: string,
  params: Record<string, unknown>
): Promise<any[]> {
  const maxPages = 1000;
  const pages: any[] = [];
  let nextParams: Record<string, unknown> | null = params;
  const seenContinuations = new Set<string>();
  while (nextParams) {
    if (pages.length >= maxPages) {
      throw new Error(`Airtable pagination exceeded ${maxPages} pages for ${url}; the import was stopped instead of returning partial data.`);
    }
    const response = await airtableJson(init, url, nextParams);
    pages.push(response);
    const continuation = airtableContinuationParams(response);
    if (!continuation) break;
    const key = JSON.stringify(continuation);
    if (seenContinuations.has(key)) {
      throw new Error(`Airtable returned the same pagination cursor twice for ${url}; the import was stopped instead of returning partial data.`);
    }
    seenContinuations.add(key);
    nextParams = { ...params, ...continuation };
  }
  return pages;
}

async function reportAirtableProgress(
  reporter: AirtableProgressReporter | undefined,
  progress: number,
  state: AirtableProgressState
): Promise<void> {
  if (!reporter) return;
  await reporter(Math.max(0, Math.min(99, Math.round(progress))), state);
}

async function fetchAirtableData(
  init: AirtableInit,
  progress?: AirtableProgressReporter
): Promise<{ schema: any; tables: Record<string, any> }> {
  const applicationId = Object.keys(init.initData.rawApplications || {})[0];
  const rawTables = Object.keys(init.initData.singleApplicationScaffoldingData?.tableById || {});
  if (rawTables.length === 0) {
    throw new Error("No Airtable tables were found in the shared base.");
  }

  const tables: Record<string, any> = {};
  let schema: any = null;
  for (let index = 0; index < rawTables.length; index++) {
    const tableId = rawTables[index];
    const includeSchema = index === 0;
    const pages = await fetchPagedAirtableJson(
      init,
      includeSchema
        ? `${AIRTABLE_API_BASE_URL}/application/${applicationId}/read`
        : `${AIRTABLE_API_BASE_URL}/table/${tableId}/readData`,
      {
        includeDataForViewIds: null,
        shouldIncludeSchemaChecksum: true,
        mayOnlyIncludeRowAndCellDataForIncludedViews: false,
        ...(includeSchema ? { includeDataForTableIds: [tableId] } : {}),
      }
    );
    for (const data of pages) {
      if (data.data?.appBlanket) {
        schema = schema || data.data;
        for (const tableSchema of data.data.tableSchemas || []) {
          if (!rawTables.includes(String(tableSchema.id))) rawTables.push(String(tableSchema.id));
        }
        const tableData = data.data.tableDatas?.[0];
        if (tableData?.id) tables[tableData.id] = mergeAirtableTableData(tables[tableData.id], tableData);
      } else if (data.data?.id) {
        tables[data.data.id] = mergeAirtableTableData(tables[data.data.id], data.data);
      }
    }
    await reportAirtableProgress(progress, 10 + ((index + 1) / rawTables.length) * 35, "downloading-base");
  }

  if (!schema?.tableSchemas) {
    throw new Error("The Airtable schema could not be read.");
  }

  for (const tableSchema of schema.tableSchemas || []) {
    const tableData = tables[tableSchema.id] || { id: tableSchema.id, rows: [], viewDatas: [] };
    tableData.viewDatas = Array.isArray(tableData.viewDatas) ? tableData.viewDatas : [];
    const existingViewData = new Set(tableData.viewDatas.map((viewData: any) => String(viewData.id)));
    for (const view of tableSchema.views || []) {
      if (existingViewData.has(String(view.id))) continue;
      const pages = await fetchPagedAirtableJson(init, `${AIRTABLE_API_BASE_URL}/view/${view.id}/readData`, {});
      let mergedViewData: any | null = null;
      for (const page of pages) {
        if (!page.data?.id) continue;
        mergedViewData = mergeViewDataById(mergedViewData ? [mergedViewData] : [], [page.data])[0] || null;
      }
      if (mergedViewData?.id) {
        tableData.viewDatas.push(mergedViewData);
        existingViewData.add(String(view.id));
      }
      await reportAirtableProgress(progress, 45, "downloading-base");
    }
    tables[tableSchema.id] = tableData;
  }
  return { schema, tables };
}

export function airtableType(column: any): string {
  return String(column.type || "").toLowerCase();
}

function airtableLinkedTableId(column: any): string {
  const options = column.typeOptions || {};
  return String(
    options.foreignTableId ??
    options.linkedTableId ??
    options.foreignTableID ??
    options.foreignTable ??
    options.tableId ??
    ""
  );
}

function airtableRelationColumnId(column: any): string {
  const options = column.typeOptions || {};
  return String(
    options.relationColumnId ??
    options.inverseLinkColumnId ??
    options.linkedRecordFieldId ??
    options.foreignTableReferenceColumnId ??
    ""
  );
}

function isAirtableLinkedRecordType(type: string): boolean {
  return type.includes("foreignkey") ||
    type.includes("recordlink") ||
    type.includes("linkedrecord") ||
    type.includes("linktoanotherrecord");
}

export function airtableTypeToSupertask(
  column: any,
  primary: boolean,
  tableByAirtableId: Map<string, ImportedTable>
): FieldType | null {
  const type = airtableType(column);
  const validator = String(column.typeOptions?.validatorName || "").toLowerCase();
  const computationType = String(column.typeOptions?.computationType || "").toLowerCase();
  if (type.includes("multiline") || type.includes("richtext")) return "long_text";
  if (type.includes("url") || validator === "url") return "url";
  if (type.includes("email") || validator === "email") return "email";
  if (type.includes("phone")) return "phone_number";
  if (type.includes("checkbox") || type.includes("boolean")) return "boolean";
  if (type.includes("computation")) {
    if (computationType === "createdtime") return "created_on";
    if (computationType === "lastmodifiedtime") return "last_modified";
    if (computationType === "createdby") return "created_by";
    if (computationType === "lastmodifiedby") return "last_modified_by";
  }
  if (type.includes("createdtime")) return "created_on";
  if (type.includes("lastmodifiedtime")) return "last_modified";
  if (type.includes("date")) return "date";
  if (type.includes("rating")) return "rating";
  if (type.includes("autonumber")) return "autonumber";
  if (type.includes("createdby") || type.includes("createduser")) return "created_by";
  if (type.includes("lastmodifiedby") || type.includes("lastmodifieduser")) return "last_modified_by";
  if (type.includes("count")) return "count";
  if (type.includes("lookup")) return "lookup";
  if (type.includes("rollup")) return "rollup";
  if (type.includes("currency") || type.includes("percent")) return "number";
  if (type.includes("duration")) return "duration";
  if (type.includes("number") || type.includes("decimal") || type.includes("integer")) {
    const format = String(column.typeOptions?.format || "").toLowerCase();
    return format.includes("duration") ? "duration" : "number";
  }
  if (type.includes("multiselect") || type.includes("multipleselect")) return "multiple_select";
  if (type.includes("singleselect") || type === "select") return "single_select";
  if (type.includes("collaborator") || type === "user" || type.includes("multipleuser")) return "multiple_collaborators";
  if (type.includes("attachment")) return "file";
  if (isAirtableLinkedRecordType(type) && tableByAirtableId.has(airtableLinkedTableId(column))) return "link_row";
  if (type.includes("formula")) {
    const displayType = String(column.typeOptions?.displayType || "");
    if (displayType === "createdTime") return "created_on";
    if (displayType === "lastModifiedTime") return "last_modified";
    if (airtableFormulaText(column) && airtableFormulaIsImportable(column)) return "formula";
    return null;
  }
  if (type === "text" || type.includes("singlelinetext") || type.includes("plaintext")) return "text";
  return null;
}

function canBeImportedPrimaryField(type: FieldType | null, column: any): boolean {
  if (type === null) return false;
  if (type === "long_text" && airtableType(column).includes("richtext")) return false;
  return ![
    "file",
    "link_row",
    "multiple_select",
    "multiple_collaborators",
    "formula",
    "lookup",
    "rollup",
    "count",
    "created_on",
    "last_modified",
    "created_by",
    "last_modified_by",
    "password",
    "ai",
  ].includes(type);
}

function selectPrimaryColumnId(columns: any[], preferredColumnId: string | null | undefined, tableByAirtableId: Map<string, ImportedTable>): string | null {
  const preferred = columns.find((column) => String(column.id) === String(preferredColumnId || ""));
  if (preferred) {
    const type = airtableTypeToSupertask(preferred, true, tableByAirtableId);
    if (canBeImportedPrimaryField(type, preferred)) return String(preferred.id);
  }
  for (const column of columns) {
    const type = airtableTypeToSupertask(column, false, tableByAirtableId);
    if (canBeImportedPrimaryField(type, column)) return String(column.id);
  }
  return null;
}

export function choiceList(column: any): Array<{ id?: string; name: string; color: string }> {
  const options = column.typeOptions || {};
  let choices: any[] = [];
  if (Array.isArray(options.choices)) {
    choices = options.choices;
  } else if (options.choices && typeof options.choices === "object") {
    const order = Array.isArray(options.choiceOrder) ? options.choiceOrder : Object.keys(options.choices);
    choices = order
      .map((id: string) => options.choices?.[id] ? { id, ...options.choices[id] } : null)
      .filter(Boolean);
  } else if (options.choicesById && typeof options.choicesById === "object") {
    const order = Array.isArray(options.choiceOrder) ? options.choiceOrder : Object.keys(options.choicesById);
    choices = order
      .map((id: string) => options.choicesById?.[id] ? { id, ...options.choicesById[id] } : null)
      .filter(Boolean);
  }
  return choices
    .map((choice: any) => ({
      id: choice.id,
      name: cleanName(choice.name ?? choice.value, "Option"),
      color: airtableColor(choice.color),
    }))
    .filter((choice) => choice.name.length > 0);
}

export function airtableColumnWithRuntimeChoices(column: any, rows: any[]): any {
  const type = airtableType(column);
  if (!(type.includes("multiselect") || type.includes("multipleselect") || type.includes("singleselect") || type === "select")) {
    return column;
  }
  if (choiceList(column).length > 0) return column;

  const choices = new Map<string, { id: string; name: string; color: string }>();
  for (const row of rows || []) {
    const raw = row?.cellValuesByColumnId?.[column.id];
    const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
    for (const value of values) {
      const keys = airtableValueCandidateKeys(value);
      const id = keys[0] || "";
      const name = cleanName(airtableHumanReadableText(value) || id, "Option");
      const key = id || name;
      if (key && !choices.has(key)) choices.set(key, { id: key, name, color: "blue" });
    }
  }
  if (choices.size === 0) return column;
  return {
    ...column,
    typeOptions: {
      ...(column.typeOptions || {}),
      choiceOrder: Array.from(choices.keys()),
      choices: Object.fromEntries(Array.from(choices.entries()).map(([id, choice]) => [id, choice])),
    },
  };
}

function airtableColor(color: unknown): string {
  const value = String(color || "").toLowerCase();
  const map: Record<string, string> = {
    blue: "light-blue",
    bluemedium: "blue",
    bluedark: "dark-blue",
    bluedarker: "darker-blue",
    cyan: "light-cyan",
    cyanmedium: "cyan",
    cyandark: "dark-cyan",
    cyandarker: "darker-cyan",
    teal: "light-pink",
    tealmedium: "pink",
    tealdark: "dark-pink",
    tealdarker: "darker-pink",
    green: "light-green",
    greenmedium: "green",
    greendark: "dark-green",
    greendarker: "darker-green",
    yellow: "light-yellow",
    yellowmedium: "yellow",
    yellowdark: "dark-yellow",
    yellowdarker: "darker-yellow",
    orange: "light-orange",
    orangemedium: "orange",
    orangedark: "dark-orange",
    orangedarker: "darker-orange",
    red: "light-red",
    redmedium: "red",
    reddark: "dark-red",
    reddarker: "darker-red",
    pink: "light-pink",
    purple: "light-purple",
    purplemedium: "purple",
    purpledark: "dark-purple",
    purpledarker: "darker-purple",
    gray: "light-gray",
    graymedium: "gray",
    graydark: "dark-gray",
    graydarker: "darker-gray",
    grey: "light-gray",
    greymedium: "gray",
    greydark: "dark-gray",
    greydarker: "darker-gray",
  };
  return map[value] || value || "blue";
}

function airtableFieldSettings(column: any, type: FieldType): Record<string, unknown> {
  const options = column.typeOptions || {};
  switch (type) {
    case "number": {
      const format = String(options.format || "").toLowerCase();
      const rawDefault = column.default ?? "";
      const numberDefault = rawDefault !== "" && rawDefault !== null && rawDefault !== undefined && format.includes("percent")
        ? Number(rawDefault) * 100
        : rawDefault;
      return {
        number_decimal_places: Math.min(Math.max(Number(options.precision ?? 0), 0), 10),
        number_negative: options.negative !== false && String(options.validatorName || "").toLowerCase() !== "positive",
        number_prefix: String(options.symbol || ""),
        number_suffix: format.includes("percent") ? "%" : "",
        number_separator: separatorFormat(options.separatorFormat),
        number_default: numberDefault,
      };
    }
    case "duration":
      return { duration_format: durationFormat(options.durationFormat, options.format) };
    case "date":
    case "created_on":
    case "last_modified":
      return {
        date_format: dateFormat(options.dateFormat),
        date_include_time: Boolean(options.isDateTime),
        date_time_format: String(options.timeFormat || "24hour") === "12hour" ? "12" : "24",
        date_show_tzinfo: Boolean(options.shouldDisplayTimeZone),
        date_force_timezone: options.timeZone === "client" ? null : options.timeZone ?? null,
      };
    case "rating":
      return {
        max_value: Number(options.max || 5),
        color: ratingColor(options.color),
        style: ratingStyle(options.icon),
      };
    case "boolean":
      return { boolean_default: Boolean(column.default) };
    case "long_text":
      return { long_text_enable_rich_text: airtableType(column).includes("richtext"), long_text_default: "" };
    case "text":
      return column.default ? { text_default: String(column.default) } : {};
    case "count":
      return { through_field_id: null, formula_type: "number", number_decimal_places: 0 };
    case "lookup":
      return {
        through_field_id: null,
        target_field_id: null,
        formula_type: airtableFormulaType(options.resultType),
        array_formula_type: airtableFormulaType(options.resultType),
      };
    case "rollup":
      return {
        through_field_id: null,
        target_field_id: null,
        ...airtableRollupSettings(options.formulaTextParsed, options.resultType),
        number_decimal_places: Math.min(Math.max(Number(options.precision ?? 0), 0), 10),
      };
    case "formula":
      return {
        formula: airtableFormulaText(column),
        formula_type: airtableFormulaType(options.resultType || options.displayType),
        array_formula_type: null,
        formula_type_error: null,
        nullable: true,
      };
    default:
      return {};
  }
}

function reportUnsupportedAirtableFieldOptions(report: AirtableImportReport | null | undefined, column: any, type: FieldType): void {
  if (!report) return;
  const options = column.typeOptions || {};
  const tableName = cleanName(column.tableName || "", "");
  const fieldName = cleanName(column.name, "Field");
  const rawType = airtableType(column);
  if (type === "number") {
    const separator = String(options.separatorFormat || "");
    if (separator !== "" && separatorFormat(separator) === "") {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        `The field was imported, but the separator format ${separator} was dropped because it doesn't exist in Supertask.`
      );
    }
  }
  if (type === "rating") {
    const icon = String(options.icon || "");
    const color = String(options.color || "");
    const supportedIcons = new Set(["star", "heart", "thumbsUp", "flag"]);
    const supportedColors = new Set(["blue", "green", "orange", "red"]);
    if (icon !== "" && !supportedIcons.has(icon)) {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        `The field was imported, but the icon ${icon} does not exist, so it defaulted to ${ratingStyle("")}.`
      );
    }
    if (color !== "" && !supportedColors.has(color)) {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        `The field was imported, but the color ${color} does not exist, so it defaulted to ${ratingColor("")}.`
      );
    }
  }
  if (type === "boolean" && (rawType.includes("checkbox") || rawType.includes("boolean"))) {
    const icon = String(options.icon || "check");
    const color = String(options.color || "green");
    if (icon !== "check") {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        `The field was imported, but the icon ${icon} is not supported.`
      );
    }
    if (color !== "green") {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        `The field was imported, but the color ${color} is not supported.`
      );
    }
  }
  if (type === "date" && column.default) {
    report.addFailed(
      fieldName,
      "Field",
      tableName,
      "Unsupported feature",
      "The field was imported, but the default value Current date was dropped because that's not supported in Supertask."
    );
  }
  if (
    type === "last_modified" &&
    rawType.includes("formula") &&
    String(options.displayType || "") === "lastModifiedTime" &&
    options.dependencies?.dependsOnAllColumnModifications !== true
  ) {
    report.addFailed(
      fieldName,
      "Field",
      tableName,
      "Unsupported feature",
      "The field was imported, but the support to depend on specific fields was dropped because that's not supported by Supertask."
    );
  }
  if (type === "link_row") {
    const relationship = String(options.relationship || "many");
    if (relationship !== "many") {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        "The field was imported, but support for a one to many relationship was dropped because it's not supported by Supertask."
      );
    }
    if (options.viewIdForRecordSelection !== undefined && options.viewIdForRecordSelection !== null) {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        "The field was imported, but limiting record selection to a view was dropped because the views have not been imported."
      );
    }
    if (options.filtersForRecordSelection !== undefined && options.filtersForRecordSelection !== null) {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        "The field was imported, but filtering record by a condition was dropped because it's not supported by Supertask."
      );
    }
    if (options.aiMatchingOptions !== undefined && options.aiMatchingOptions !== null) {
      report.addFailed(
        fieldName,
        "Field",
        tableName,
        "Unsupported feature",
        "The field was imported, but using AI to show top matches was dropped because it's not supported by Supertask."
      );
    }
  }
}

function airtableFormulaText(column: any): string {
  const options = column.typeOptions || {};
  return String(
    options.formulaTextParsed ??
    options.formulaText ??
    options.formula ??
    options.formulaTextStored ??
    ""
  ).trim();
}

function airtableFormulaIsImportable(column: any): boolean {
  const formula = airtableFormulaText(column);
  if (!formula) return false;
  const checked = evaluateFormula(formula, {});
  return checked.error === null;
}

function airtableFormulaType(value: unknown): string {
  const type = String(value || "").toLowerCase();
  if (type === "number" || type === "integer" || type === "decimal" || type === "currency" || type.includes("percent")) return "number";
  if (type === "date" || type === "datetime") return "date";
  if (type === "checkbox" || type === "boolean") return "boolean";
  return "text";
}

type AirtableRollupMode =
  | "and"
  | "array_compact"
  | "array_flatten"
  | "array_join"
  | "array_slice"
  | "array_unique"
  | "concatenate"
  | "numeric_count"
  | "not_empty_count"
  | "unique_count"
  | "count_all"
  | "or"
  | "xor";

function decodeAirtableStringLiteral(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const quote = value[0];
  const body = value.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return body.replace(/\\([\\'"nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function airtableArrayJoinSeparator(formula: string): string {
  const match = formula.match(/ARRAYJOIN\s*\([\s\S]*,\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\s*\)/i);
  return decodeAirtableStringLiteral(match?.[1], ",");
}

function airtableArraySliceBounds(formula: string): { start: number; end: number | null } {
  const match = formula.match(/ARRAYSLICE\s*\(\s*values\s*,\s*(-?\d+)(?:\s*,\s*(-?\d+))?/i);
  return {
    start: Number(match?.[1] || 1),
    end: match?.[2] === undefined ? null : Number(match[2]),
  };
}

export function airtableRollupSettings(value: unknown, resultType?: unknown): Record<string, unknown> {
  const rawFormula = String(value || "").trim();
  const formula = rawFormula.toUpperCase();
  const base = { formula_type: airtableFormulaType(resultType) };
  const custom = (
    rollupFunction: string,
    mode: AirtableRollupMode,
    settings: Record<string, unknown> = {}
  ) => ({
    ...base,
    rollup_function: rollupFunction,
    airtable_rollup_function: mode,
    airtable_rollup_formula: rawFormula,
    ...settings,
  });

  if (formula.includes("ARRAYJOIN(")) return custom("max", "array_join", {
    formula_type: "text",
    airtable_rollup_separator: airtableArrayJoinSeparator(rawFormula),
    airtable_rollup_compact: formula.includes("ARRAYCOMPACT("),
    airtable_rollup_flatten: formula.includes("ARRAYFLATTEN("),
    airtable_rollup_unique: formula.includes("ARRAYUNIQUE("),
  });
  if (formula.includes("ARRAYCOMPACT(")) return custom("max", "array_compact", { formula_type: "array", array_formula_type: airtableFormulaType(resultType) });
  if (formula.includes("ARRAYFLATTEN(")) return custom("max", "array_flatten", { formula_type: "array", array_formula_type: airtableFormulaType(resultType) });
  if (formula.includes("ARRAYSLICE(")) {
    const bounds = airtableArraySliceBounds(rawFormula);
    return custom("max", "array_slice", {
      formula_type: "array",
      array_formula_type: airtableFormulaType(resultType),
      airtable_rollup_slice_start: bounds.start,
      airtable_rollup_slice_end: bounds.end,
    });
  }
  if (formula.includes("ARRAYUNIQUE(")) return custom("max", "array_unique", { formula_type: "array", array_formula_type: airtableFormulaType(resultType) });
  if (formula.includes("CONCATENATE(")) return custom("max", "concatenate", { formula_type: "text" });
  if (formula.includes("COUNTALL(")) return custom("count", "count_all", { formula_type: "number" });
  if (formula.includes("COUNTA(") || formula.includes("NOT_EMPTY")) return custom("count", "not_empty_count", { formula_type: "number" });
  if (formula.includes("COUNTUNIQUE(")) return custom("count", "unique_count", { formula_type: "number" });
  if (formula.includes("COUNT(")) return custom("count", "numeric_count", { formula_type: "number" });
  if (formula.includes("AVERAGE(") || formula.includes("AVG(")) return { ...base, rollup_function: "avg", formula_type: "number" };
  if (formula.includes("SUM(")) return { ...base, rollup_function: "sum", formula_type: "number" };
  if (formula.includes("MIN(")) return { ...base, rollup_function: "min" };
  if (formula.includes("MAX(")) return { ...base, rollup_function: "max" };
  if (formula.includes("AND(")) return custom("every", "and", { formula_type: "boolean" });
  if (formula.includes("XOR(")) return custom("any", "xor", { formula_type: "boolean" });
  if (formula.includes("OR(")) return custom("any", "or", { formula_type: "boolean" });
  return custom("count", "count_all", { formula_type: "number" });
}

function dateFormat(value: unknown): string {
  const format = String(value || "");
  if (format === "European") return "EU";
  if (format === "US") return "US";
  return "ISO";
}

function durationFormat(value: unknown, format: unknown): string {
  if (format === "durationInDays") return "d h";
  const duration = String(value || "");
  if (duration === "h:mm") return "h:mm";
  if (duration === "h:mm:ss") return "h:mm:ss";
  if (duration === "h:mm:ss.s") return "h:mm:ss.s";
  if (duration === "h:mm:ss.ss") return "h:mm:ss.ss";
  return "h:mm:ss.sss";
}

function separatorFormat(value: unknown): string {
  const map: Record<string, string> = {
    commaPeriod: "COMMA_PERIOD",
    periodComma: "PERIOD_COMMA",
    spaceComma: "SPACE_COMMA",
    spacePeriod: "SPACE_PERIOD",
  };
  return map[String(value || "")] || "";
}

function ratingStyle(value: unknown): string {
  const icon = String(value || "").toLowerCase();
  if (icon.includes("heart")) return "heart";
  if (icon.includes("thumb")) return "thumbs-up";
  if (icon.includes("flag")) return "flag";
  return "star";
}

function ratingColor(value: unknown): string {
  const color = String(value || "").toLowerCase();
  if (color.includes("blue")) return "dark-blue";
  if (color.includes("green")) return "dark-green";
  if (color.includes("red")) return "dark-red";
  if (color.includes("orange")) return "dark-orange";
  return "dark-blue";
}

function fieldByAirtableId(fields: ImportedField[]): Map<string, ImportedField> {
  return new Map(fields.map((field) => [String(field.airtableColumnId), field]));
}

function airtableViewList(airtableTable: any): any[] {
  const views = Array.isArray(airtableTable.views) ? airtableTable.views : Object.values(airtableTable.viewsById || {});
  const byId = new Map(views.map((view: any) => [String(view.id), view]));
  const sections = airtableTable.viewSectionsById && typeof airtableTable.viewSectionsById === "object"
    ? airtableTable.viewSectionsById
    : {};
  const ordered = Array.isArray(airtableTable.viewOrder)
    ? airtableTable.viewOrder.flatMap((id: string) => {
      const section = sections[String(id)];
      if (section && Array.isArray(section.viewOrder)) {
        const sectionName = cleanName(section.name, "Section");
        return section.viewOrder
          .map((viewId: string) => {
            const view = byId.get(String(viewId));
            return view ? { ...view, __supertaskSectionName: sectionName } : null;
          })
          .filter(Boolean);
      }
      const view = byId.get(String(id));
      return view ? [view] : [];
    })
    : [];
  for (const view of views) {
    if (!ordered.some((item: any) => item.id === view.id)) ordered.push(view);
  }
  return ordered;
}

function viewDataById(tableData: any): Map<string, any> {
  return new Map((tableData.viewDatas || []).map((viewData: any) => [String(viewData.id), viewData]));
}

function airtableRowHeight(viewData: any): "small" | "medium" | "large" {
  const value = String(viewData?.metadata?.grid?.rowHeight || "small");
  if (value === "medium") return "medium";
  if (value === "large" || value === "xlarge") return "large";
  return "small";
}

function maybeRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function nestedRecord(root: any, path: string[]): Record<string, any> {
  let current = root;
  for (const key of path) {
    current = maybeRecord(current)[key];
  }
  return maybeRecord(current);
}

function firstText(values: unknown[], fallback = ""): string {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = primitiveText(value).trim();
    if (text) return text;
  }
  return fallback;
}

function firstBoolean(values: unknown[], fallback: boolean): boolean {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "true") return true;
    if (value === 0 || value === "false") return false;
  }
  return fallback;
}

function airtableFormFieldConfig(data: any, columnId: string): Record<string, any> {
  return {
    ...maybeRecord(nestedRecord(data, ["metadata", "form", "fieldOptionsByColumnId"])[columnId]),
    ...maybeRecord(nestedRecord(data, ["metadata", "form", "fieldsByColumnId"])[columnId]),
    ...maybeRecord(nestedRecord(data, ["fieldOptionsByColumnId"])[columnId]),
    ...maybeRecord(nestedRecord(data, ["formFieldOptionsByColumnId"])[columnId]),
    ...maybeRecord(nestedRecord(data, ["columnOptionsByColumnId"])[columnId]),
  };
}

function columnIdFromFormOrderItem(item: any): string {
  if (typeof item === "string") return item;
  return String(item?.columnId ?? item?.fieldId ?? item?.id ?? "");
}

function airtableFormFieldOrder(data: any, airtableTable: any): string[] {
  const metadataForm = nestedRecord(data, ["metadata", "form"]);
  const candidates = [
    data?.fieldOrder,
    data?.visibleFieldOrder,
    data?.formFieldOrder,
    metadataForm.fieldOrder,
    metadataForm.visibleFieldOrder,
    metadataForm.formFieldOrder,
    data?.columnOrder,
    airtableTable.meaningfulColumnOrder,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const ids = candidate.map(columnIdFromFormOrderItem).filter(Boolean);
    if (ids.length > 0) return ids;
  }
  return (airtableTable.columns || []).map((column: any) => String(column.id)).filter(Boolean);
}

function firstMappedField(
  fieldMap: Map<string, ImportedField>,
  ids: unknown[],
  allowedTypes: FieldType[]
): ImportedField | null {
  for (const rawId of ids) {
    const id = columnIdFromFormOrderItem(rawId);
    const field = id ? fieldMap.get(id) : null;
    if (field && allowedTypes.includes(field.type)) return field;
  }
  for (const field of fieldMap.values()) {
    if (allowedTypes.includes(field.type)) return field;
  }
  return null;
}

function timelineTimescale(value: unknown): "day" | "week" | "month" | "year" {
  const raw = String(value || "").toLowerCase();
  if (raw === "day" || raw === "week" || raw === "year") return raw;
  return "month";
}

function airtableOrder(value: unknown): "ASC" | "DESC" | null {
  if (value === true || value === "ascending" || value === "ASC") return "ASC";
  if (value === false || value === "descending" || value === "DESC") return "DESC";
  return null;
}

function airtableColumn(airtableTable: any, columnId: string): any | null {
  return (airtableTable.columns || []).find((column: any) => String(column.id) === columnId) || null;
}

function airtableColumnName(airtableTable: any, columnId: string): string {
  return cleanName(airtableColumn(airtableTable, columnId)?.name ?? columnId, columnId || "Field");
}

function airtableFieldName(field: ImportedField): string {
  return cleanName(field.airtableColumn?.name, `Field ${field.id}`);
}

function airtableUnknownValueToHumanReadable(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} items`;
  if (typeof value === "string" && value.startsWith("usr")) return "1 item";
  return primitiveText(value);
}

function airtableFieldCanOrderBy(field: ImportedField): boolean {
  return !["file", "password"].includes(field.type);
}

function airtableFieldCanGroupBy(field: ImportedField): boolean {
  if (!airtableFieldCanOrderBy(field)) return false;
  if (field.type === "long_text" && field.settings?.long_text_enable_rich_text === true) return false;
  return true;
}

function airtableFieldCanFilterBy(field: ImportedField): boolean {
  return field.type !== "password";
}

function airtableSupportsNotEqualFilter(type: string): boolean {
  return ["text", "multilinetext", "number", "rating", "phone", "autonumber"].includes(type);
}

function airtableSupportsComparisonFilter(type: string): boolean {
  return ["number", "rating", "autonumber"].includes(type);
}

function airtableDurationFilterValueIsSupported(column: any, rawValue: unknown): boolean {
  if (column?.typeOptions?.format !== "duration") return true;
  const value = Number.parseInt(primitiveText(rawValue), 10);
  return !Number.isFinite(value) || Math.abs(value) <= AIRTABLE_MAX_DURATION_VALUE;
}

function selectFilterValue(field: ImportedField, raw: unknown): string {
  const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  return values
    .map((value) => {
      const keys = airtableValueCandidateKeys(value);
      const label = airtableHumanReadableText(value);
      const option = keys
        .map((key) => field.selectOptions?.get(key))
        .find(Boolean) ||
        Array.from(field.selectOptions?.values() || []).find((item) => item.value === label);
      return option ? String(option.id) : "";
    })
    .filter(Boolean)
    .join(",");
}

function linkFilterValue(field: ImportedField, raw: unknown, ctx?: ImportContext): string {
  const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const lookup = field.targetAirtableTableId && ctx ? ctx.rowLookups.get(field.targetAirtableTableId) : null;
  return values
    .map((value) => {
      const airtableRowId = airtableLinkedRecordId(value);
      const linked = lookup?.get(airtableRowId);
      return linked ? String(linked.id) : "";
    })
    .filter(Boolean)
    .join(",");
}

function airtableLinkedRecordId(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" || Array.isArray(value)) return String(value || "");
  const record = value as Record<string, unknown>;
  const candidates = [
    record.foreignRowId,
    record.foreignRecordId,
    record.linkedRecordId,
    record.linkedRowId,
    record.recordId,
    record.rowId,
    record.id,
    record.value,
  ];
  for (const candidate of candidates) {
    const text = nonBlankText(candidate);
    if (text) return text;
  }
  return "";
}

function stableExternalCollaboratorId(rawId: string): number {
  let hash = 0;
  for (let i = 0; i < rawId.length; i++) {
    hash = ((hash * 31) + rawId.charCodeAt(i)) >>> 0;
  }
  return 1_000_000_000 + (hash % 900_000_000);
}

function collaboratorIdentity(value: unknown): { id: number; name: string; email: string; airtable_id: string | null; external: boolean } | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "object" ? value as Record<string, unknown> : {};
  const airtableId = String(raw.id ?? raw.userId ?? raw.user_id ?? raw.email ?? value ?? "").trim();
  const email = String(raw.email ?? raw.profileEmail ?? "").trim();
  const name = cleanName(
    raw.name ?? raw.displayName ?? raw.profileName ?? raw.firstName ?? raw.email ?? value,
    email || airtableId || "Airtable collaborator"
  );
  if (!airtableId && !email && !name) return null;
  const numeric = Number(raw.supertask_user_id ?? raw.user_id ?? raw.id);
  const id = Number.isFinite(numeric) && numeric > 0 ? numeric : stableExternalCollaboratorId(airtableId || email || name);
  return {
    id,
    name,
    email,
    airtable_id: airtableId || null,
    external: !Number.isFinite(numeric) || numeric <= 0,
  };
}

function normalizeCollaboratorValue(raw: unknown): unknown[] {
  const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const collaborators: Array<{ id: number; name: string; email: string; airtable_id: string | null; external: boolean }> = [];
  const seen = new Set<number>();
  for (const value of values) {
    const collaborator = collaboratorIdentity(value);
    if (!collaborator || seen.has(collaborator.id)) continue;
    seen.add(collaborator.id);
    collaborators.push(collaborator);
  }
  return collaborators;
}

function normalizeSingleCollaboratorValue(raw: unknown): unknown | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return collaboratorIdentity(value);
}

function collaboratorFilterValue(raw: unknown): string {
  return normalizeCollaboratorValue(raw)
    .map((value) => String((value as { id: number }).id))
    .join(",");
}

const AIRTABLE_DATE_FILTER_VALUE_MAP: Record<string, string> = {
  daysAgo: "{timeZone}?{numberOfDays}?nr_days_ago",
  daysFromNow: "{timeZone}?{numberOfDays}?nr_days_from_now",
  exactDate: "{timeZone}?{exactDate}?exact_date",
  nextMonth: "{timeZone}??next_month",
  nextNumberOfDays: "{timeZone}?{numberOfDays}?nr_days_from_now",
  nextWeek: "{timeZone}??next_week",
  nextYear: "{timeZone}??next_year",
  oneMonthAgo: "{timeZone}??one_month_ago",
  oneWeekAgo: "{timeZone}?1?nr_weeks_ago",
  oneMonthFromNow: "{timeZone}?1?nr_months_from_now",
  oneWeekFromNow: "{timeZone}?1?nr_weeks_from_now",
  pastMonth: "{timeZone}?1?nr_months_ago",
  pastNumberOfDays: "{timeZone}?{numberOfDays}?nr_days_ago",
  pastWeek: "{timeZone}?1?nr_weeks_ago",
  pastYear: "{timeZone}?1?nr_years_ago",
  thisCalendarYear: "{timeZone}??this_year",
  thisCalendarMonth: "{timeZone}??this_month",
  thisCalendarWeek: "{timeZone}??this_week",
  today: "{timeZone}??today",
  tomorrow: "{timeZone}??tomorrow",
  yesterday: "{timeZone}??yesterday",
};

function airtableDateFilterValue(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "";
  const value: Record<string, unknown> = typeof raw === "string"
    ? { mode: "exactDate", exactDate: raw, timeZone: "" }
    : typeof raw === "object"
      ? { ...(raw as Record<string, unknown>) }
      : { mode: "exactDate", exactDate: String(raw), timeZone: "" };
  const mode = String(value.mode || (value.exactDate ? "exactDate" : ""));
  const template = AIRTABLE_DATE_FILTER_VALUE_MAP[mode];
  if (!template) return primitiveText(raw);
  const exactDate = value.exactDate === undefined || value.exactDate === null ? "" : String(value.exactDate).slice(0, 10);
  return template
    .replace("{timeZone}", value.timeZone === undefined || value.timeZone === null ? "" : String(value.timeZone))
    .replace("{numberOfDays}", value.numberOfDays === undefined || value.numberOfDays === null ? "" : String(value.numberOfDays))
    .replace("{exactDate}", exactDate);
}

function reportAirtableViewImportIssue(
  ctx: ImportContext | undefined,
  objectName: string,
  scope: ImportReportScope,
  airtableTable: any,
  errorType: ImportReportErrorType,
  message: string
): void {
  ctx?.report?.addFailed(
    objectName,
    scope,
    cleanName(airtableTable.name, ""),
    errorType,
    message
  );
}

function reportAirtableIncompatibleFilter(
  ctx: ImportContext | undefined,
  airtableTable: any,
  viewName: string,
  fieldName: string,
  operator: string,
  rawValue: unknown
): null {
  const filterValue = airtableUnknownValueToHumanReadable(rawValue);
  reportAirtableViewImportIssue(
    ctx,
    `View "${viewName}", Field "${fieldName}"`,
    "View filter",
    airtableTable,
    "Unsupported feature",
    `The "${operator}" filter with value "${filterValue}" on field "${fieldName}" was ignored in view ${viewName} because not no compatible filter exists.`
  );
  return null;
}

function mapAirtableFilter(rawFilter: any, airtableTable: any, fields: ImportedField[], ctx?: ImportContext, viewName = "Airtable view"): { fieldId: number; type: string; value: string } | null {
  const columnId = String(rawFilter.columnId || "");
  const field = fieldByAirtableId(fields).get(columnId);
  const column = airtableColumn(airtableTable, columnId);
  const operator = String(rawFilter.operator || "");
  const rawValue = rawFilter.value;
  if (!field) {
    const columnName = airtableColumnName(airtableTable, columnId);
    const filterValue = airtableUnknownValueToHumanReadable(rawValue);
    reportAirtableViewImportIssue(
      ctx,
      `View "${viewName}", Field ID "${columnName}"`,
      "View filter",
      airtableTable,
      "Unsupported feature",
      `The "${operator}" filter with value "${filterValue}" on field "${columnName}" was ignored in view ${viewName} because the field was not imported.`
    );
    return null;
  }
  const fieldName = airtableFieldName(field);
  if (!airtableFieldCanFilterBy(field)) {
    const filterValue = airtableUnknownValueToHumanReadable(rawValue);
    reportAirtableViewImportIssue(
      ctx,
      `View "${viewName}", Field "${fieldName}"`,
      "View filter",
      airtableTable,
      "Unsupported feature",
      `The "${operator}" filter with value "${filterValue}" on field "${fieldName}" was ignored in view ${viewName} because it's not possible to filter by that field type.`
    );
    return null;
  }
  if (!column && !field.airtableColumn) {
    return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
  }
  const effectiveColumn = column || field.airtableColumn;
  const airtableColumnType = airtableType(effectiveColumn);

  if (operator === "isEmpty") return { fieldId: field.id, type: "empty", value: "" };
  if (operator === "isNotEmpty") return { fieldId: field.id, type: "not_empty", value: "" };
  if (operator === "contains") return { fieldId: field.id, type: field.type === "link_row" ? "link_row_contains" : "contains", value: primitiveText(rawValue) };
  if (operator === "doesNotContain") {
    if (field.type === "link_row") return { fieldId: field.id, type: "link_row_not_contains", value: primitiveText(rawValue) };
    if (field.type === "multiple_collaborators") return { fieldId: field.id, type: "multiple_collaborators_has_not", value: collaboratorFilterValue(rawValue) };
    return { fieldId: field.id, type: field.type === "multiple_select" ? "multiple_select_has_not" : "contains_not", value: field.type === "multiple_select" ? selectFilterValue(field, rawValue) : primitiveText(rawValue) };
  }
  if (operator === "filename") return { fieldId: field.id, type: "filename_contains", value: primitiveText(rawValue) };
  if (operator === "filetype") {
    if (rawValue === "image") return { fieldId: field.id, type: "has_file_type", value: "image" };
    if (rawValue === "text") return { fieldId: field.id, type: "has_file_type", value: "document" };
    return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
  }

  if (operator === "=") {
    if (field.type === "boolean") return { fieldId: field.id, type: "boolean", value: rawValue ? "true" : "false" };
    if (field.type === "single_select") return { fieldId: field.id, type: "single_select_equal", value: selectFilterValue(field, rawValue) };
    if (field.type === "multiple_select") return { fieldId: field.id, type: "multiple_select_has", value: selectFilterValue(field, rawValue) };
    if (field.type === "multiple_collaborators") return { fieldId: field.id, type: "multiple_collaborators_has", value: collaboratorFilterValue(rawValue) };
    if (field.type === "link_row") {
      if (Array.isArray(rawValue) && rawValue.length > 1) return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
      return { fieldId: field.id, type: "link_row_has", value: linkFilterValue(field, rawValue, ctx) };
    }
    if (field.type === "date") return { fieldId: field.id, type: "date_is", value: airtableDateFilterValue(rawValue) };
    if (!airtableDurationFilterValueIsSupported(effectiveColumn, rawValue)) return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
    return { fieldId: field.id, type: "equal", value: primitiveText(rawValue) };
  }
  if (operator === "!=") {
    if (field.type === "single_select") return { fieldId: field.id, type: "single_select_not_equal", value: selectFilterValue(field, rawValue) };
    if (field.type === "multiple_collaborators") return { fieldId: field.id, type: "multiple_collaborators_has_not", value: collaboratorFilterValue(rawValue) };
    if (field.type === "date") return { fieldId: field.id, type: "date_is_not", value: airtableDateFilterValue(rawValue) };
    if (airtableSupportsNotEqualFilter(airtableColumnType)) {
      if (!airtableDurationFilterValueIsSupported(effectiveColumn, rawValue)) return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
      return { fieldId: field.id, type: "not_equal", value: primitiveText(rawValue) };
    }
    return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
  }
  if (operator === "isAnyOf" && field.type === "single_select") return { fieldId: field.id, type: "single_select_is_any_of", value: selectFilterValue(field, rawValue) };
  if (operator === "isNoneOf" && field.type === "single_select") return { fieldId: field.id, type: "single_select_is_none_of", value: selectFilterValue(field, rawValue) };

  const comparisonMap: Record<string, string> = {
    "<": airtableColumnType === "date" ? "date_is_before" : "lower_than",
    ">": airtableColumnType === "date" ? "date_is_after" : "higher_than",
    "<=": airtableColumnType === "date" ? "date_is_on_or_before" : "lower_than_or_equal",
    ">=": airtableColumnType === "date" ? "date_is_on_or_after" : "higher_than_or_equal",
    isWithin: "date_is_within",
  };
  if (comparisonMap[operator]) {
    if (airtableColumnType !== "date" && !airtableSupportsComparisonFilter(airtableColumnType)) return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
    if (!airtableDurationFilterValueIsSupported(effectiveColumn, rawValue)) return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
    return { fieldId: field.id, type: comparisonMap[operator], value: airtableColumnType === "date" ? airtableDateFilterValue(rawValue) : primitiveText(rawValue) };
  }
  return reportAirtableIncompatibleFilter(ctx, airtableTable, viewName, fieldName, operator, rawValue);
}

function collectAirtableFilters(
  filterSet: any,
  airtableTable: any,
  fields: ImportedField[],
  ctx: ImportContext | undefined,
  viewName: string,
  parentGroupId: string | null,
  groups: AirtableViewSpec["filterGroups"],
  filters: AirtableViewSpec["filters"]
): void {
  for (const item of filterSet?.filterSet || []) {
    if (item?.type === "nested") {
      const groupId = String(item.id || crypto.randomUUID());
      groups.push({
        airtableId: groupId,
        filterType: String(item.conjunction || "and").toUpperCase() === "OR" ? "OR" : "AND",
        parentAirtableId: parentGroupId,
      });
      collectAirtableFilters(item, airtableTable, fields, ctx, viewName, groupId, groups, filters);
      continue;
    }
    const filter = mapAirtableFilter(item, airtableTable, fields, ctx, viewName);
    if (filter) filters.push({ ...filter, groupAirtableId: parentGroupId });
  }
}

function airtableViewDecorations(
  data: any,
  airtableTable: any,
  fields: ImportedField[],
  ctx?: ImportContext,
  viewName = "Airtable view"
): AirtableViewSpec["decorations"] {
  const colorConfig = data?.colorConfig;
  if (!colorConfig || typeof colorConfig !== "object") return [];
  const fieldMap = fieldByAirtableId(fields);
  if (colorConfig.type === "selectColumn") {
    const selectColumnId = String(colorConfig.selectColumnId || "");
    const field = fieldMap.get(selectColumnId);
    if (!field) {
      const columnName = airtableColumnName(airtableTable, selectColumnId);
      reportAirtableViewImportIssue(
        ctx,
        viewName,
        "View color",
        airtableTable,
        "Data type mismatch",
        `The select field coloring was ignored in ${viewName} because ${columnName} does not exist.`
      );
      return [];
    }
    if (field.type !== "single_select") return [];
    return [{
      type: "left_border_color",
      valueProviderType: "single_select_color",
      valueProviderConf: { field_id: field.id },
      order: 1,
    }];
  }

  if (colorConfig.type !== "colorDefinitions" || !Array.isArray(colorConfig.colorDefinitions)) return [];
  const colors: object[] = [];
  for (const definition of colorConfig.colorDefinitions) {
    const filterGroups: AirtableViewSpec["filterGroups"] = [];
    const filters: AirtableViewSpec["filters"] = [];
    collectAirtableFilters(definition, airtableTable, fields, ctx, viewName, null, filterGroups, filters);
    colors.push({
      filter_groups: filterGroups.map((group) => ({
        id: group.airtableId,
        filter_type: group.filterType,
        parent_group: group.parentAirtableId,
      })),
      filters: filters.map((filter) => ({
        id: crypto.randomUUID(),
        type: filter.type,
        field: filter.fieldId,
        group: filter.groupAirtableId,
        value: filter.value,
      })),
      operator: String(definition.conjunction || "and").toUpperCase() === "OR" ? "OR" : "AND",
      color: airtableColor(definition.color),
    });
  }
  const defaultColor = airtableColor(colorConfig.defaultColor || "");
  if (colorConfig.defaultColor) {
    colors.push({ filter_groups: [], filters: [], operator: "AND", color: defaultColor });
  }
  return colors.length > 0 ? [{
    type: "left_border_color",
    valueProviderType: "conditional_color",
    valueProviderConf: { colors },
    order: 1,
  }] : [];
}

function reportAirtableViewUnsupported(
  ctx: ImportContext | undefined,
  airtableTable: any,
  viewName: string,
  message: string
): void {
  reportAirtableViewImportIssue(
    ctx,
    viewName,
    "View",
    airtableTable,
    "Unsupported feature",
    message
  );
}

function mapAirtableSort(
  sort: any,
  airtableTable: any,
  viewName: string,
  fields: ImportedField[],
  ctx?: ImportContext
): { fieldId: number; order: "ASC" | "DESC" } | null {
  const columnId = String(sort.columnId || "");
  const field = fieldByAirtableId(fields).get(columnId);
  if (!field) {
    const columnName = airtableColumnName(airtableTable, columnId);
    reportAirtableViewImportIssue(
      ctx,
      `View "${viewName}", Field ID "${columnName}"`,
      "View sort",
      airtableTable,
      "Unsupported feature",
      `The sort on field "${columnName}" was ignored in view ${viewName} because the field is not imported.`
    );
    return null;
  }
  const fieldName = airtableFieldName(field);
  if (!airtableFieldCanOrderBy(field)) {
    reportAirtableViewImportIssue(
      ctx,
      `View "${viewName}", Field "${fieldName}"`,
      "View sort",
      airtableTable,
      "Unsupported feature",
      `The sort on field "${fieldName}" was ignored in view ${viewName} because it's not possible to order by that field type.`
    );
    return null;
  }
  const order = airtableOrder(sort.ascending);
  return order ? { fieldId: field.id, order } : null;
}

function mapAirtableGroupBy(
  group: any,
  airtableTable: any,
  viewName: string,
  fields: ImportedField[],
  ctx?: ImportContext
): { fieldId: number; order: "ASC" | "DESC" } | null {
  const columnId = String(group.columnId || "");
  const field = fieldByAirtableId(fields).get(columnId);
  if (!field) {
    const columnName = airtableColumnName(airtableTable, columnId);
    reportAirtableViewImportIssue(
      ctx,
      `View "${viewName}", Field ID "${columnName}"`,
      "View group by",
      airtableTable,
      "Unsupported feature",
      `The group by on field "${columnName}" was ignored in view ${viewName} because the field was not imported.`
    );
    return null;
  }
  const fieldName = airtableFieldName(field);
  if (!airtableFieldCanGroupBy(field)) {
    reportAirtableViewImportIssue(
      ctx,
      `View "${viewName}", Field "${fieldName}"`,
      "View group by",
      airtableTable,
      "Unsupported feature",
      `The group by on field "${fieldName}" was ignored in view ${viewName} because it's not possible to group by that field type.`
    );
    return null;
  }
  const order = airtableOrder(group.order);
  if (!order) {
    reportAirtableViewImportIssue(
      ctx,
      `View "${viewName}", Field "${fieldName}"`,
      "View group by",
      airtableTable,
      "Unsupported feature",
      `The group by on field "${fieldName}" was ignored in view ${viewName} because the order ${String(group.order)} is incompatible.`
    );
    return null;
  }
  return { fieldId: field.id, order };
}

export function buildAirtableViewSpecs(airtableTable: any, tableData: any, fields: ImportedField[], ctx?: ImportContext): AirtableViewSpec[] {
  const fieldMap = fieldByAirtableId(fields);
  const dataById = viewDataById(tableData);
  const views = airtableViewList(airtableTable).filter((view: any) => ["grid", "gallery", "form", "kanban", "calendar", "timeline"].includes(String(view.type)));
  return views.map((view: any, index: number) => {
    const data = dataById.get(String(view.id)) || {};
    const columnOrder = Array.isArray(data.columnOrder)
      ? data.columnOrder
      : (airtableTable.meaningfulColumnOrder || []);
    const viewType = String(view.type);
    const type = viewType === "gallery" ? "gallery" : viewType === "form" ? "form" : viewType === "kanban" ? "kanban" : viewType === "calendar" ? "calendar" : viewType === "timeline" ? "timeline" : "grid";
    const fallbackName = type === "grid" ? "Grid" : type === "gallery" ? "Gallery" : type === "kanban" ? "Kanban" : type === "calendar" ? "Calendar" : type === "timeline" ? "Timeline" : "Form";
    const baseViewName = cleanName(`${view.__supertaskSectionName ? `${view.__supertaskSectionName} / ` : ""}${view.name || type}`, fallbackName);
    const fieldOptions = columnOrder
      .map((item: any, optionIndex: number) => {
        const field = fieldMap.get(String(item.columnId));
        return field ? {
          fieldId: field.id,
          width: Number(item.width || 200),
          hidden: item.visibility === false,
          order: optionIndex + 1,
        } : null;
      })
      .filter(Boolean) as AirtableViewSpec["fieldOptions"];
    const sortings = ((data.lastSortsApplied?.sortSet || []) as any[])
      .map((sort: any) => mapAirtableSort(sort, airtableTable, baseViewName, fields, ctx))
      .filter(Boolean) as AirtableViewSpec["sortings"];
    const groupBys = ((data.groupLevels || []) as any[])
      .map((group: any) => mapAirtableGroupBy(group, airtableTable, baseViewName, fields, ctx))
      .filter(Boolean) as AirtableViewSpec["groupBys"];
    const filterGroups: AirtableViewSpec["filterGroups"] = [];
    const filters: AirtableViewSpec["filters"] = [];
    collectAirtableFilters(data.filters || { filterSet: [] }, airtableTable, fields, ctx, baseViewName, null, filterGroups, filters);
    const coverColumnId = String(data.metadata?.gallery?.coverColumnId || "");
    const coverField = coverColumnId ? fieldMap.get(coverColumnId) : null;
    let personalSuffix = "";
    if (view.personalForUserId) {
      reportAirtableViewUnsupported(
        ctx,
        airtableTable,
        baseViewName,
        `View "${baseViewName}" is personal, but was made collaborative because it can't be linked to a user. (Personal) was added to the name.`
      );
      personalSuffix = " (Personal)";
    }
    const finalViewName = `${baseViewName}${personalSuffix}`;
    if (view.lock) {
      reportAirtableViewUnsupported(
        ctx,
        airtableTable,
        finalViewName,
        `View "${finalViewName}" is locked, but was made collaborative because it Supertask does not support this yet.`
      );
    }
    if (type === "gallery" && coverColumnId) {
      if (!coverField) {
        reportAirtableViewUnsupported(
          ctx,
          airtableTable,
          finalViewName,
          `View "${finalViewName}" cover column with id "${coverColumnId}" is not found.`
        );
      } else if (coverField.type !== "file") {
        reportAirtableViewUnsupported(
          ctx,
          airtableTable,
          finalViewName,
          `View "${finalViewName}" cover column with id "${coverColumnId}" is not a file field.`
        );
      } else {
        const coverFitType = String(data.metadata?.gallery?.coverFitType || "");
        if (coverFitType && coverFitType !== "crop") {
          reportAirtableViewUnsupported(
            ctx,
            airtableTable,
            finalViewName,
            `View "${finalViewName}" cover fit type "${coverFitType}" is not supported, so it defaulted to "crop"`
          );
        }
      }
    }
    const kanbanConfig = type === "kanban" ? nestedRecord(data, ["metadata", "kanban"]) : {};
    const calendarConfig = type === "calendar" ? nestedRecord(data, ["metadata", "calendar"]) : {};
    const timelineConfig = type === "timeline" ? nestedRecord(data, ["metadata", "timeline"]) : {};
    const singleSelectField = type === "kanban"
      ? firstMappedField(fieldMap, [
        kanbanConfig.stackColumnId,
        kanbanConfig.stackFieldId,
        kanbanConfig.groupingColumnId,
        data.stackColumnId,
        data.singleSelectColumnId,
        data.groupingColumnId,
      ], ["single_select"])
      : null;
    const dateField = type === "calendar"
      ? firstMappedField(fieldMap, [
        calendarConfig.dateColumnId,
        calendarConfig.dateFieldId,
        calendarConfig.startDateColumnId,
        calendarConfig.startDateFieldId,
        data.dateColumnId,
        data.calendarDateFieldId,
        data.startDateColumnId,
      ], ["date", "created_on", "last_modified"])
      : null;
    const startDateField = type === "timeline"
      ? firstMappedField(fieldMap, [
        timelineConfig.startDateColumnId,
        timelineConfig.startDateFieldId,
        timelineConfig.dateColumnId,
        data.startDateColumnId,
        data.startDateFieldId,
      ], ["date", "created_on", "last_modified"])
      : null;
    const endDateField = type === "timeline"
      ? firstMappedField(fieldMap, [
        timelineConfig.endDateColumnId,
        timelineConfig.endDateFieldId,
        timelineConfig.dateColumnId,
        data.endDateColumnId,
        data.endDateFieldId,
      ], ["date", "created_on", "last_modified"]) || startDateField
      : null;
    const formConfig = type === "form" ? nestedRecord(data, ["metadata", "form"]) : {};
    const formFieldOptions = type === "form"
      ? airtableFormFieldOrder(data, airtableTable)
        .map((columnId, optionIndex) => {
          const field = fieldMap.get(columnId);
          if (!field || isReadOnlyFieldType(field.type)) return null;
          const config = airtableFormFieldConfig(data, columnId);
          const visible = firstBoolean([config.visible, config.visibility, config.enabled, config.isEnabled], true);
          const hidden = firstBoolean([config.hidden, config.isHidden], false);
          return {
            fieldId: field.id,
            name: firstText([config.label, config.name, config.title], ""),
            description: firstText([config.description, config.helpText, config.subtitle], ""),
            enabled: visible && !hidden,
            required: firstBoolean([config.required, config.isRequired], false),
            order: optionIndex + 1,
            includeAllSelectOptions: firstBoolean([config.includeAllSelectOptions, config.include_all_select_options], true),
          };
        })
        .filter(Boolean) as NonNullable<AirtableViewSpec["form"]>["fieldOptions"]
      : [];
    const submitActionRedirectUrl = firstText([formConfig.redirectUrl, formConfig.redirect_url, data.redirectUrl], "");
    return {
      name: finalViewName,
      type,
      order: index + 1,
      filterType: String(data.filters?.conjunction || "and").toUpperCase() === "OR" ? "OR" : "AND",
      rowHeightSize: type === "grid" ? airtableRowHeight(data) : "small",
      cardCoverImageFieldId: type === "gallery" && coverField?.type === "file" ? coverField.id : null,
      singleSelectFieldId: singleSelectField?.id ?? null,
      dateFieldId: dateField?.id ?? null,
      startDateFieldId: startDateField?.id ?? null,
      endDateFieldId: endDateField?.id ?? null,
      timescale: timelineTimescale(timelineConfig.timescale ?? timelineConfig.zoomLevel ?? data.timescale),
      fieldOptions,
      form: type === "form" ? {
        title: firstText([formConfig.title, data.title, view.name], cleanName(view.name, "Form")),
        description: firstText([formConfig.description, data.description], ""),
        submitText: firstText([formConfig.submitText, formConfig.submit_text, data.submitText], "Submit"),
        submitAction: submitActionRedirectUrl ? "REDIRECT" : "MESSAGE",
        submitActionMessage: firstText([formConfig.submitActionMessage, formConfig.confirmationMessage, data.submitActionMessage], ""),
        submitActionRedirectUrl,
        mode: "form",
        showLogo: firstBoolean([formConfig.showLogo, formConfig.show_logo], true),
        fieldOptions: formFieldOptions,
      } : undefined,
      sortings,
      groupBys,
      filterGroups,
      filters,
      decorations: airtableViewDecorations(data, airtableTable, fields, ctx, baseViewName),
    };
  });
}

export function primitiveText(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(primitiveText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    if (Array.isArray(value.documentValue)) {
      return quillToMarkdown(value.documentValue);
    }
    return airtableHumanReadableText(value) || JSON.stringify(value);
  }
  return String(value);
}

function nonBlankText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return primitiveText(value);
  return String(value).trim();
}

function airtableHumanReadableText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(airtableHumanReadableText).filter(Boolean).join(", ");
  if (typeof value !== "object") return nonBlankText(value);
  const record = value as Record<string, unknown>;
  const candidates = [
    record.foreignRowDisplayName,
    record.displayName,
    record.profileName,
    record.label,
    record.title,
    record.name,
    record.text,
    record.value,
    record.filename,
    record.url,
  ];
  for (const candidate of candidates) {
    const text = nonBlankText(candidate);
    if (text) return text;
  }
  return "";
}

function airtableValueCandidateKeys(value: unknown): string[] {
  const keys: string[] = [];
  const add = (candidate: unknown) => {
    const text = nonBlankText(candidate);
    if (text && !keys.includes(text)) keys.push(text);
  };
  if (value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    add(record.id);
    add(record.choiceId);
    add(record.choiceID);
    add(record.selectedChoiceId);
    add(record.selectedChoiceID);
    add(record.optionId);
    add(record.optionID);
    add(record.value);
    add(record.name);
    add(record.text);
    add(record.label);
    add(record.displayName);
  } else {
    add(value);
  }
  return keys;
}

function quillSplitWithNewlines(value: string): string[] {
  const parts = value.split(/(\n)/);
  if (parts[0] === "") parts.shift();
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function quillParseInline(insert: any, attributes: Record<string, any>): string {
  let value = insert;
  if (value && typeof value === "object" && "mention" in value) {
    value = `@${String(value.mention?.userId || "")}`;
  }
  value = primitiveText(value);
  if ("bold" in attributes) value = `**${value}**`;
  if ("italic" in attributes) value = `_${value}_`;
  if ("strike" in attributes) value = `~~${value}~~`;
  if ("code" in attributes) value = `\`${value}\``;
  if ("link" in attributes) value = `[${value}](${String(attributes.link)})`;
  return value;
}

function quillBlockWrapper(attributes: Record<string, any>): { prepend: string; append: string; multiLine: boolean } {
  let prepend = "";
  let append = "";
  let multiLine = false;
  if ("header" in attributes) prepend = `${"#".repeat(Math.max(1, Number(attributes.header) || 1))} `;
  if ("list" in attributes) {
    prepend = " ".repeat(Math.max(0, Number(attributes.indent) || 0) * 4);
    if (attributes.list === "ordered") prepend += "1. ";
    if (attributes.list === "bullet") prepend += "- ";
    if (attributes.list === "unchecked") prepend += "- [ ] ";
    if (attributes.list === "checked") prepend += "- [x] ";
  }
  if ("blockquote" in attributes || "≈≈" in attributes) prepend = "> ";
  if ("code-block" in attributes) {
    prepend = "```\n";
    append = "```\n";
    multiLine = true;
  }
  return { prepend, append, multiLine };
}

export function quillToMarkdown(ops: any[]): string {
  const output: string[] = [];
  let current = "";
  let currentMultiLine: { prepend: string; append: string } | null = null;

  const flushLine = () => {
    if (current !== "") {
      output.push(current);
      current = "";
    }
  };
  const flushMultiLine = (next: { prepend: string; append: string } | null) => {
    if (currentMultiLine && (!next || next.prepend !== currentMultiLine.prepend || next.append !== currentMultiLine.append)) {
      current = `${currentMultiLine.prepend}${current}${currentMultiLine.append}`;
      flushLine();
      currentMultiLine = null;
    }
  };

  for (const op of ops || []) {
    const rawInsert = op?.insert ?? "";
    const attributes = op?.attributes && typeof op.attributes === "object" ? op.attributes : {};
    const insertLines = typeof rawInsert === "string" ? quillSplitWithNewlines(rawInsert) : [rawInsert];
    for (const insertLine of insertLines) {
      const isNewLine = insertLine === "\n";
      const wrapper = isNewLine ? quillBlockWrapper(attributes) : { prepend: "", append: "", multiLine: false };
      if (isNewLine) {
        flushMultiLine(wrapper);
        if (wrapper.multiLine && currentMultiLine === null) {
          currentMultiLine = { prepend: wrapper.prepend, append: wrapper.append };
        }
      }
      current += quillParseInline(insertLine, attributes);
      if (isNewLine && !wrapper.multiLine) {
        current = `${wrapper.prepend}${current}${wrapper.append}`;
        flushLine();
      }
    }
  }
  flushMultiLine(null);
  flushLine();
  return output.join("").trim();
}

export function normalizeSelectValue(
  raw: any,
  field: ImportedField,
  multiple: boolean
): unknown {
  const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const options = values
    .map((value) => {
      const keys = airtableValueCandidateKeys(value);
      const label = cleanName(airtableHumanReadableText(value), "Option");
      return keys
        .map((key) => field.selectOptions?.get(key))
        .find(Boolean) ||
        Array.from(field.selectOptions?.values() || []).find((option) => option.value === label) ||
        null;
    })
    .filter(Boolean);
  return multiple ? options : options[0] || null;
}

function fileUrl(file: any, ctx?: ImportContext): string {
  const rawUrl = String(file.url || file.downloadUrl || "");
  if (rawUrl && ctx?.signedUserContentUrls?.[rawUrl]) return ctx.signedUserContentUrls[rawUrl];
  return rawUrl;
}

async function fetchAttachmentEndpoint(
  ctx: ImportContext,
  rowId: string,
  columnId: string,
  attachmentId: string,
  range?: string
): Promise<Response> {
  const applicationId = Object.keys(ctx.init.initData.rawApplications || {})[0];
  const accessPolicy = JSON.parse(ctx.init.initData.accessPolicy || "{}");
  const params = new URLSearchParams({
    accessPolicy: JSON.stringify(accessPolicy),
    stringifiedObjectParams: JSON.stringify({ columnId, attachmentId }),
  });
  params.set(ctx.init.requestIdParam || "request_id", ctx.init.requestId);
  const headers = new Headers({
    ...BASE_HEADERS,
    "x-airtable-application-id": applicationId,
    "x-airtable-client-queue-time": "45",
    "x-airtable-inter-service-client": "webClient",
    "x-airtable-inter-service-client-code-version": ctx.init.initData.codeVersion,
    "x-airtable-page-load-id": ctx.init.initData.pageLoadId,
    "X-Requested-With": "XMLHttpRequest",
    "x-time-zone": "Europe/Amsterdam",
    "x-user-locale": "en",
  });
  if (ctx.init.userAgent) headers.set("User-Agent", ctx.init.userAgent);
  if (ctx.init.cookie) headers.set("Cookie", ctx.init.cookie);
  if (range) headers.set("Range", range);
  return fetch(`${AIRTABLE_API_BASE_URL}/row/${rowId}/downloadAttachment?${params.toString()}`, {
    headers,
    redirect: "follow",
  });
}

type AirtableAttachmentRequest = (range?: string) => Promise<Response>;

async function fetchAttachmentByRanges(request: AirtableAttachmentRequest): Promise<Response | null> {
  const firstEnd = AIRTABLE_ATTACHMENT_RANGE_CHUNK_SIZE - 1;
  const first = await request(`bytes=0-${firstEnd}`);
  if (first.status === 200 && first.body) return first;
  if (first.status !== 206 || !first.body) {
    await first.body?.cancel();
    return null;
  }
  const match = (first.headers.get("content-range") || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) {
    await first.body.cancel();
    return null;
  }
  const firstStart = Number(match[1]);
  const firstRangeEnd = Number(match[2]);
  const total = Number(match[3]);
  if (firstStart !== 0 || !Number.isSafeInteger(firstRangeEnd) || !Number.isSafeInteger(total) || total <= 0) {
    await first.body.cancel();
    return null;
  }

  let firstChunk: Uint8Array | null = new Uint8Array(await first.arrayBuffer());
  let offset = firstRangeEnd + 1;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (firstChunk) {
          controller.enqueue(firstChunk);
          firstChunk = null;
          if (offset >= total) controller.close();
          return;
        }
        if (offset >= total) {
          controller.close();
          return;
        }
        const end = Math.min(total - 1, offset + AIRTABLE_ATTACHMENT_RANGE_CHUNK_SIZE - 1);
        const response = await request(`bytes=${offset}-${end}`);
        const range = (response.headers.get("content-range") || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
        if (response.status !== 206 || !response.body || !range || Number(range[1]) !== offset || Number(range[3]) !== total) {
          await response.body?.cancel();
          throw new Error("Airtable returned an invalid attachment byte range.");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0) throw new Error("Airtable returned an empty attachment byte range.");
        offset = Number(range[2]) + 1;
        controller.enqueue(bytes);
        if (offset >= total) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const headers = new Headers(first.headers);
  headers.delete("content-range");
  headers.set("content-length", String(total));
  return new Response(stream, { status: 200, headers });
}

async function downloadAirtableFile(ctx: ImportContext, rowId: string, columnId: string, file: any): Promise<Response> {
  const url = fileUrl(file, ctx);
  const canUseAttachmentEndpoint = Boolean(file.id && rowId && columnId);
  let lastStatus = "unknown";
  let lastError: unknown = null;

  for (let attempt = 0; attempt < AIRTABLE_ATTACHMENT_DOWNLOAD_ATTEMPTS; attempt++) {
    const shouldTryDirectUrl = Boolean(url) && (attempt === 0 || !canUseAttachmentEndpoint);
    if (shouldTryDirectUrl) {
      try {
        const headers = new Headers(BASE_HEADERS);
        const response = await fetch(url, { headers, redirect: "follow" });
        lastStatus = String(response.status);
        if (response.ok && response.body) return response;
        await response.body?.cancel();
      } catch (error) {
        lastError = error;
      }
    }

    if (canUseAttachmentEndpoint) {
      try {
        const response = await fetchAttachmentEndpoint(ctx, rowId, columnId, String(file.id));
        lastStatus = String(response.status);
        if (response.ok && response.body) return response;
        await response.body?.cancel();
      } catch (error) {
        lastError = error;
      }
    }
  }


  const rangedRequests: AirtableAttachmentRequest[] = [];
  if (url) {
    rangedRequests.push(async (range) => {
      const headers = new Headers(BASE_HEADERS);
      if (range) headers.set("Range", range);
      return fetch(url, { headers, redirect: "follow" });
    });
  }
  if (canUseAttachmentEndpoint) {
    rangedRequests.push((range) => fetchAttachmentEndpoint(ctx, rowId, columnId, String(file.id), range));
  }
  for (const request of rangedRequests) {
    try {
      const response = await fetchAttachmentByRanges(request);
      if (response?.ok && response.body) return response;
    } catch (error) {
      lastError = error;
    }
  }

  const errorDetail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`Airtable attachment ${file.filename || file.id || url} could not be downloaded: HTTP ${lastStatus}.${errorDetail}`);
}

export function airtableAttachmentFileName(file: any): string {
  const rawUrl = String(file.url || file.downloadUrl || "");
  if (!rawUrl) return cleanName(file.filename ?? file.name ?? file.id, "airtable-file");
  try {
    const parsed = new URL(rawUrl);
    const parts = parsed.pathname.split("/").filter(Boolean).slice(-3);
    if (parts.length > 0) return cleanName(parts.join("_"), cleanName(file.filename ?? file.name, "airtable-file"));
  } catch {
    const path = rawUrl.split("?")[0];
    const parts = path.split("/").filter(Boolean).slice(-3);
    if (parts.length > 0) return cleanName(parts.join("_"), cleanName(file.filename ?? file.name, "airtable-file"));
  }
  return cleanName(file.filename ?? file.name ?? file.id, "airtable-file");
}

async function normalizeFileValue(raw: any, skipFiles: boolean, ctx: ImportContext, field: ImportedField, row: any): Promise<unknown> {
  if (skipFiles) return [];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const imported: object[] = [];
  for (let fileIndex = 0; fileIndex < values.length; fileIndex++) {
    const file = values[fileIndex];
    const visibleName = cleanName(file.filename ?? file.name ?? file.id, "airtable-file");
    const contentType = file.type || file.mimeType || "application/octet-stream";
    if (ctx.deferAttachments && ctx.currentAirtableTableId && ctx.currentTableId) {
      const taskKey = crypto.randomUUID();
      ctx.pendingAttachments?.push({
        taskKey,
        tableId: ctx.currentTableId,
        airtableTableId: ctx.currentAirtableTableId,
        airtableRowId: String(row.id || ""),
        fieldId: field.id,
        airtableColumnId: field.airtableColumnId,
        fileIndex,
        file,
      });
      imported.push({
        visible_name: visibleName,
        original_name: visibleName,
        name: airtableAttachmentFileName(file),
        size: Number(file.size || 0),
        mime_type: contentType,
        is_image: contentType.startsWith("image/"),
        image_width: Number(file.width || 0) || null,
        image_height: Number(file.height || 0) || null,
        url: fileUrl(file, ctx),
        thumbnails: {},
        external: true,
        source: "airtable",
        airtable_task_key: taskKey,
      });
      continue;
    }
    try {
      const response = await downloadAirtableFile(ctx, String(row.id || ""), field.airtableColumnId, file);
      const body = response.body;
      if (!body) throw new Error(`Airtable attachment ${file.filename || file.id || ""} has no body.`);
      const stored = await storeUserFile(ctx.env, {
        userId: ctx.userId,
        fileName: visibleName,
        contentType: file.type || response.headers.get("content-type") || contentType,
        size: Number(file.size || response.headers.get("content-length") || 0),
        body,
        onCreated: (created) => ctx.importedFileNames?.add(String(created.name)),
      });
      const imageWidth = Number(file.width || stored.image_width || 0) || null;
      const imageHeight = Number(file.height || stored.image_height || 0) || null;
      const isImage = Boolean(stored.is_image) || (contentType.startsWith("image/") && imageWidth !== null && imageHeight !== null);
      await ctx.env.DB.prepare("UPDATE core_userfile SET is_image=?, image_width=?, image_height=? WHERE id=?")
        .bind(isImage ? 1 : 0, imageWidth, imageHeight, stored.id)
        .run();
      (stored as StoredUserFile).is_image = isImage ? 1 : 0;
      (stored as StoredUserFile).image_width = imageWidth;
      (stored as StoredUserFile).image_height = imageHeight;
      imported.push(await serializeUserFileCellForRequest(ctx.env, stored, ctx.workspaceId, visibleName));
    } catch {
      ctx.failedAttachmentCount = (ctx.failedAttachmentCount || 0) + 1;
      ctx.report.addFailed(
        `Row: "${primaryDisplayValue(row, undefined)}", field: "${field.airtableColumn?.name || "Attachment"}"`,
        "Cell",
        cleanName(field.airtableColumn?.tableName || "", ""),
        "Other",
        `File "${visibleName}" could not be downloaded from either its Airtable URL or the authenticated attachment endpoint and was not imported.`
      );
    }
  }
  return imported;
}

function attachmentCount(importedTables: ImportedTable[]): number {
  let count = 0;
  for (const importedTable of importedTables) {
    const fileColumnIds = new Set(
      importedTable.fields.filter((field) => field.type === "file").map((field) => field.airtableColumnId)
    );
    for (const row of importedTable.tableData.rows || []) {
      for (const columnId of fileColumnIds) {
        const value = row.cellValuesByColumnId?.[columnId];
        count += Array.isArray(value) ? value.length : value ? 1 : 0;
      }
    }
  }
  return count;
}

async function schedulePendingAttachmentTasks(
  ctx: ImportContext,
  jobId: number,
  databaseId: number
): Promise<number> {
  const pending = ctx.pendingAttachments || [];
  if (pending.length === 0) return 0;
  const now = new Date().toISOString();
  const statements = [];
  for (const item of pending) {
    const targetRow = ctx.rowLookups.get(item.airtableTableId)?.get(item.airtableRowId);
    if (!targetRow) throw new Error(`Airtable attachment row ${item.airtableRowId} was not mapped.`);
    statements.push(ctx.env.DB.prepare(
      `INSERT INTO database_airtable_attachment_task
       (job_id, database_id, table_id, row_id, field_id, task_key, file_index,
        airtable_row_id, airtable_column_id, file_json, status, attempts, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
    ).bind(
      jobId,
      databaseId,
      item.tableId,
      targetRow.id,
      item.fieldId,
      item.taskKey,
      item.fileIndex,
      item.airtableRowId,
      item.airtableColumnId,
      JSON.stringify(item.file),
      now,
      now
    ));
  }
  for (let index = 0; index < statements.length; index += 50) {
    await ctx.env.DB.batch(statements.slice(index, index + 50));
  }

  const tasks = await ctx.env.DB.prepare(
    `SELECT id, table_id, row_id, field_id
     FROM database_airtable_attachment_task WHERE job_id=? AND status='pending'
     ORDER BY table_id, row_id, field_id, id`
  ).bind(jobId).all<{ id: number; table_id: number; row_id: number; field_id: number }>();
  const taskIds = (tasks.results || []).map((task) => Number(task.id));
  const cellGroups = new Map<string, number[]>();
  for (const task of tasks.results || []) {
    const key = `${task.table_id}:${task.row_id}:${task.field_id}`;
    const group = cellGroups.get(key) || [];
    group.push(Number(task.id));
    cellGroups.set(key, group);
  }
  const messageTaskIds: number[][] = [];
  let currentMessage: number[] = [];
  for (const group of cellGroups.values()) {
    if (currentMessage.length > 0 && currentMessage.length + group.length > 10) {
      messageTaskIds.push(currentMessage);
      currentMessage = [];
    }
    currentMessage.push(...group);
  }
  if (currentMessage.length > 0) messageTaskIds.push(currentMessage);
  const messages: Array<{ body: JobMessage }> = [];
  await ctx.env.CACHE.put(attachmentInitCacheKey(jobId), JSON.stringify(ctx.init), { expirationTtl: 86_400 });
  for (const messageIds of messageTaskIds) {
    messages.push({
      body: {
        job_id: jobId,
        job_type: "airtable_attachment_retry",
        payload: {
          task_ids: messageIds,
          database_id: databaseId,
        },
        user_id: ctx.userId || 0,
        workspace_id: ctx.workspaceId,
      },
    });
  }
  for (let index = 0; index < messages.length; index += 100) {
    await ctx.env.JOBS_QUEUE.sendBatch(messages.slice(index, index + 100));
  }
  return taskIds.length;
}

function normalizeLinkRowValue(raw: any, field: ImportedField, ctx: ImportContext, row: any): unknown {
  const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const rowLookup = field.targetAirtableTableId ? ctx.rowLookups.get(field.targetAirtableTableId) : null;
  const imported: Array<{ id: number; value: string }> = [];
  for (const value of values) {
    const airtableRowId = airtableLinkedRecordId(value);
    if (!airtableRowId) continue;
    const linked = rowLookup?.get(airtableRowId);
    if (linked) {
      imported.push(linked);
      continue;
    }
    ctx.report.addFailed(
      `Row: "${primaryDisplayValue(row, undefined)}", field: "${field.airtableColumn?.name || "Link row"}"`,
      "Cell",
      cleanName(field.airtableColumn?.tableName || "", ""),
      "Data type mismatch",
      `Foreign row id "${airtableRowId}" was not added as relationship in the cell value because it was not found in the mapping.`
    );
  }
  return imported;
}

function normalizeAirtableLinkedAggregate(raw: any): unknown[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    const valuesByForeignRowId = raw.valuesByForeignRowId && typeof raw.valuesByForeignRowId === "object"
      ? raw.valuesByForeignRowId as Record<string, unknown>
      : null;
    if (valuesByForeignRowId) {
      const orderedIds = Array.isArray(raw.foreignRowIdOrder) ? raw.foreignRowIdOrder.map((id: unknown) => String(id)) : Object.keys(valuesByForeignRowId);
      return orderedIds
        .map((id: string) => valuesByForeignRowId[id])
        .filter((value: unknown) => value !== undefined && value !== null);
    }
    if (Array.isArray(raw.values)) return raw.values;
    if (Array.isArray(raw.linkedRecords)) return raw.linkedRecords;
    if ("value" in raw || "text" in raw || "label" in raw || "displayName" in raw) return [raw];
  }
  return [raw];
}

function normalizeLookupValue(raw: any): unknown[] {
  return normalizeAirtableLinkedAggregate(raw)
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => primitiveText(value))
    .filter((value) => value !== "");
}

function normalizeRollupValue(raw: any, field: ImportedField): unknown {
  const values = normalizeAirtableLinkedAggregate(raw).flatMap((value) => Array.isArray(value) ? value : [value]);
  const formulaType = String(field.settings?.formula_type || field.airtableColumn?.typeOptions?.resultType || "").toLowerCase();
  if (formulaType === "number" || formulaType === "integer" || formulaType === "decimal") {
    const value = values.length === 0 ? raw : values[0];
    if (isBlankAirtablePrimitive(value)) return null;
    const number = Number(typeof value === "object" && value !== null ? (value as Record<string, unknown>).value : value);
    return Number.isFinite(number) ? number : null;
  }
  if (formulaType === "date") return values.length === 0 ? primitiveText(raw) || null : primitiveText(values[0]) || null;
  if (formulaType === "boolean") return Boolean(values.length === 0 ? raw : values[0]);
  return values.map((value) => primitiveText(value)).filter(Boolean).join(", ");
}

function reportAirtableCellMismatch(
  ctx: ImportContext | undefined,
  row: any,
  field: ImportedField | undefined,
  fallbackFieldName: string,
  message: string
): void {
  ctx?.report.addFailed(
    `Row: "${primaryDisplayValue(row || {}, undefined)}", field: "${field?.airtableColumn?.name || fallbackFieldName}"`,
    "Cell",
    cleanName(field?.airtableColumn?.tableName || "", ""),
    "Data type mismatch",
    message
  );
}

function airtableDatetimeValidationError(value: string): string {
  return `time data '${value}' does not match format '%Y-%m-%dT%H:%M:%S.%fZ'`;
}

function parseStrictAirtableUtcTimestamp(raw: any): { dateOnly: string; dateTime: string } | null {
  const value = primitiveText(raw);
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = ""] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fractionText.padEnd(3, "0").slice(0, 3) || "0");

  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(0, month - 1, day, hour, minute, second, millisecond));
  date.setUTCFullYear(year);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }

  const fraction = fractionText.padEnd(6, "0");
  return {
    dateOnly: `${yearText}-${monthText}-${dayText}`,
    dateTime: fraction && !/^0+$/.test(fraction)
      ? `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${fraction}+00:00`
      : `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}+00:00`,
  };
}

function normalizeDateValue(raw: any, field: ImportedField, ctx?: ImportContext, row?: any): string | null {
  const value = primitiveText(raw);
  if (!value) return null;
  const parsed = parseStrictAirtableUtcTimestamp(value);
  if (!parsed) {
    reportAirtableCellMismatch(
      ctx,
      row,
      field,
      "Date",
      `Cell value was left empty because it didn't pass the datetime validation with error: "${airtableDatetimeValidationError(value)}"`
    );
    return null;
  }
  if (field.settings?.date_include_time) {
    return parsed.dateTime;
  }
  return parsed.dateOnly;
}

function normalizeAirtableUtcTimestamp(raw: any): string | null {
  const value = primitiveText(raw);
  if (!value) return null;
  const parsed = parseStrictAirtableUtcTimestamp(value);
  if (parsed) return parsed.dateTime;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.000Z$/, "+00:00").replace(/Z$/, "+00:00");
}

function isValidSupertaskUrl(value: string): boolean {
  return /^[^\s]{0,255}(?:\.|\/\/)[^\s]{1,}$/i.test(value);
}

function isValidSupertaskEmail(value: string): boolean {
  const lookahead = /(?=^.{3,254}$)/;
  const localAndDomain = /([-.[\]!#$&*+/=?^_`{|}~0-9]|\p{L}\p{M}*)+/u;
  const pattern = new RegExp(
    `${lookahead.source}^${localAndDomain.source}@${localAndDomain.source}$`,
    "iu"
  );
  return pattern.test(value);
}

function isValidSupertaskPhoneNumber(value: string): boolean {
  return /^[0-9NnXx,+._*()#=;/ -]{1,100}$/.test(value);
}

function normalizeValidatedText(
  raw: any,
  validator: (value: string) => boolean,
  ctx?: ImportContext,
  field?: ImportedField,
  row?: any,
  message = "email or URL validation"
): string {
  const value = primitiveText(raw);
  if (value === "" || validator(value)) return value;
  reportAirtableCellMismatch(
    ctx,
    row,
    field,
    cleanName(field?.type, "Text"),
    `Cell value "${value}" was left empty because it didn't pass the ${message}.`
  );
  return "";
}

function isBlankAirtablePrimitive(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

function airtableDurationSecondsForReport(value: unknown, normalized: number, field: ImportedField): string {
  if (field.airtableColumn?.typeOptions?.format !== "durationInDays") return String(normalized);
  const text = typeof value === "number" && Number.isInteger(value)
    ? String(value)
    : typeof value === "string" && /^-?\d+$/.test(value.trim())
      ? value.trim()
      : "";
  if (!text) return String(normalized);
  return String(BigInt(text) * 86400n);
}

export async function normalizeCellValue(raw: any, field: ImportedField, skipFiles: boolean, ctx: ImportContext, row: any): Promise<unknown> {
  if (field.airtableColumn?.syntheticPrimary) {
    const sourceColumnId = String(field.airtableColumn?.sourceColumnId || "");
    const sourceRaw = sourceColumnId ? row?.cellValuesByColumnId?.[sourceColumnId] : null;
    return primitiveText(sourceRaw) || cleanName(row?.id, "Imported row");
  }
  if (field.type === "created_on") {
    return normalizeAirtableUtcTimestamp(row?.createdTime || raw);
  }
  if (raw === null || raw === undefined) {
    if (field.type === "file" || field.type === "link_row" || field.type === "multiple_select" || field.type === "multiple_collaborators" || field.type === "lookup") {
      return [];
    }
    if (field.type === "boolean" && field.settings?.boolean_default === true) {
      return false;
    }
    if (field.type === "text" && String(field.settings?.text_default || "") !== "") {
      return "";
    }
    if (field.type === "url" || field.type === "email" || field.type === "phone_number") {
      return "";
    }
    return null;
  }
  switch (field.type) {
    case "boolean":
      return Boolean(raw);
    case "number": {
      const value = typeof raw === "object" ? raw.value : raw;
      if (isBlankAirtablePrimitive(value)) return null;
      const number = Number(value);
      if (!Number.isFinite(number)) {
        reportAirtableCellMismatch(
          ctx,
          row,
          field,
          "Number",
          `Cell value was left empty because the numeric value ${String(value)} could not be parsed"`
        );
        return null;
      }
      const normalized = String(field.settings?.number_suffix || "").includes("%") ? number * 100 : number;
      if (field.settings?.number_negative === false && normalized < 0) return null;
      return normalized;
    }
    case "duration": {
      const value = typeof raw === "object" ? raw.value : raw;
      if (isBlankAirtablePrimitive(value)) return null;
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      const normalized = field.airtableColumn?.typeOptions?.format === "durationInDays" ? number * 60 * 60 * 24 : number;
      if (Math.abs(normalized) > AIRTABLE_MAX_DURATION_VALUE) {
        reportAirtableCellMismatch(
          ctx,
          row,
          field,
          "Duration",
          `Cell value was left empty because the duration seconds ${airtableDurationSecondsForReport(value, normalized, field)} is outside the -86399999913600 and 86399999913600 range."`
        );
        return null;
      }
      return normalized;
    }
    case "rating": {
      const value = typeof raw === "object" ? raw.value : raw;
      if (isBlankAirtablePrimitive(value)) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    case "url":
      return normalizeValidatedText(raw, isValidSupertaskUrl, ctx, field, row, "email or URL validation");
    case "email":
      return normalizeValidatedText(raw, isValidSupertaskEmail, ctx, field, row, "email or URL validation");
    case "phone_number":
      return normalizeValidatedText(raw, isValidSupertaskPhoneNumber, ctx, field, row, "phone number validation");
    case "date":
      return normalizeDateValue(raw, field, ctx, row);
    case "last_modified":
      return normalizeAirtableUtcTimestamp(raw);
    case "created_by":
    case "last_modified_by":
      return normalizeSingleCollaboratorValue(raw);
    case "single_select":
      return normalizeSelectValue(raw, field, false);
    case "multiple_select":
      return normalizeSelectValue(raw, field, true);
    case "file":
      return normalizeFileValue(raw, skipFiles, ctx, field, row);
    case "link_row":
      return normalizeLinkRowValue(raw, field, ctx, row);
    case "formula":
      return null;
    case "count":
      return null;
    case "lookup":
      return normalizeLookupValue(raw);
    case "rollup":
      return normalizeRollupValue(raw, field);
    case "multiple_collaborators":
      return normalizeCollaboratorValue(raw);
    default:
      return primitiveText(raw);
  }
}

async function createImportedApplication(db: D1Database, workspaceId: number, name: string): Promise<any> {
  const now = new Date().toISOString();
  const maxOrder = await db.prepare(
    `SELECT COALESCE(MAX(a.[order]), 0) AS max_order FROM core_application a
     WHERE a.workspace_id=? AND a.trashed=0
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)`
  ).bind(workspaceId).first<{ max_order: number }>();
  const app = await db.prepare(
    `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (?, ?, 'database', ?, 0, ?, ?) RETURNING id, name, type, [order], workspace_id`
  ).bind(workspaceId, name, (maxOrder?.max_order || 0) + 1, now, now).first<any>();
  if (!app) throw new Error("Failed to create Airtable database.");
  return app;
}

async function createTable(db: D1Database, databaseId: number, name: string, order: number): Promise<any> {
  const now = new Date().toISOString();
  const table = await db.prepare(
    `INSERT INTO database_table (name, [order], database_id, version, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0) RETURNING id, name, [order], database_id, data_sync_id`
  ).bind(name, order, databaseId, now, now).first<any>();
  if (!table) throw new Error("Failed to create Airtable table.");
  await getOrCreateUserTable(db, table.id);
  return table;
}

async function createField(db: D1Database, tableId: number, column: any, order: number, primary: boolean, type: FieldType, report?: AirtableImportReport | null): Promise<ImportedField> {
  const now = new Date().toISOString();
  const settings = { ...fieldTypeDefaults(type), ...airtableFieldSettings(column, type) };
  reportUnsupportedAirtableFieldOptions(report, column, type);
  const fieldSettings = Object.keys(settings).length > 0 ? JSON.stringify(settings) : null;
  const field = await db.prepare(
    `INSERT INTO database_field
     (table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
      immutable_type, immutable_properties, field_settings, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, ?, ?, ?) RETURNING id`
  ).bind(
    tableId,
    cleanName(column.name, `Field ${order}`),
    type,
    order,
    primary ? 1 : 0,
    isReadOnlyFieldType(type) ? 1 : 0,
    column.description || null,
    fieldSettings,
    now,
    now
  ).first<{ id: number }>();
  if (!field) throw new Error("Failed to create Airtable field.");
  await addFieldColumn(db, tableId, { id: field.id, type, primary });

  const targetAirtableTableId = type === "link_row" ? airtableLinkedTableId(column) : null;
  const imported: ImportedField = {
    id: field.id,
    airtableColumnId: column.id,
    airtableType: airtableType(column),
    type,
    primary,
    settings,
    airtableColumn: column,
    targetAirtableTableId,
    relationAirtableColumnId: ["count", "lookup", "rollup"].includes(type) ? airtableRelationColumnId(column) : null,
  };
  if (type === "single_select" || type === "multiple_select") {
    imported.selectOptions = new Map();
    const choices = choiceList(column);
    const statements = choices.map((choice, index) => {
      return db.prepare(
        `INSERT INTO database_selectoption (field_id, value, color, [order])
         VALUES (?, ?, ?, ?) RETURNING id`
      ).bind(field.id, choice.name, choice.color, index);
    });
    for (let i = 0; i < statements.length; i++) {
      const inserted = await statements[i].first<{ id: number }>();
      const choice = choices[i];
      if (inserted) {
        imported.selectOptions.set(String(choice.id ?? choice.name), {
          id: inserted.id,
          value: choice.name,
          color: choice.color,
        });
      }
    }
    if (column.default !== undefined && column.default !== null) {
      const normalizedDefault = normalizeSelectValue(column.default, imported, type === "multiple_select");
      if (type === "single_select" && normalizedDefault && !Array.isArray(normalizedDefault)) {
        imported.settings = { ...(imported.settings || {}), single_select_default: (normalizedDefault as { id: number }).id };
      }
      if (type === "multiple_select" && Array.isArray(normalizedDefault) && normalizedDefault.length > 0) {
        imported.settings = {
          ...(imported.settings || {}),
          multiple_select_default: normalizedDefault.map((option: { id: number }) => option.id),
        };
      }
      await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
        .bind(JSON.stringify(imported.settings || {}), field.id)
        .run();
    }
  }
  return imported;
}

async function createGridView(db: D1Database, tableId: number, fields: ImportedField[]): Promise<void> {
  const now = new Date().toISOString();
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const view = await db.prepare(
    `INSERT INTO database_view (table_id, name, type, [order], filter_type, public,
     public_view_password, slug, trashed, created_on, updated_on,
     row_identifier_type, ownership_type, row_height_size, filters_disabled)
     VALUES (?, 'Grid', 'grid', 1, 'AND', 0, NULL, ?, 0, ?, ?, 'count', 'collaborative', 'small', 0)
     RETURNING id`
  ).bind(tableId, slug, now, now).first<{ id: number }>();
  if (!view) return;
  const statements = fields.map((field, index) => db.prepare(
    `INSERT OR IGNORE INTO database_gridviewfieldoptions
     (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
     VALUES (?, ?, 200, 0, ?, '', '')`
  ).bind(view.id, field.id, (index + 1) * 32768));
  if (statements.length > 0) await db.batch(statements);
}

async function insertSelectOptions(
  db: D1Database,
  fieldId: number,
  options: Array<{ value: string; color: string }>
): Promise<Map<string, { id: number; value: string; color: string }>> {
  const insertedOptions = new Map<string, { id: number; value: string; color: string }>();
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const inserted = await db.prepare(
      `INSERT INTO database_selectoption (field_id, value, color, [order])
       VALUES (?, ?, ?, ?) RETURNING id`
    ).bind(fieldId, option.value, option.color, index + 1).first<{ id: number }>();
    if (inserted) insertedOptions.set(option.value, { id: inserted.id, value: option.value, color: option.color });
  }
  return insertedOptions;
}

async function createAirtableImportReportTable(
  db: D1Database,
  databaseId: number,
  order: number,
  report: AirtableImportReport
): Promise<any | null> {
  if (report.items.length === 0) return null;

  const table = await createTable(db, databaseId, "Airtable import report", order);
  const objectNameField = await createField(db, table.id, { id: "object_name", name: "Object name", type: "text" }, 1, true, "text");
  const scopeField = await createField(db, table.id, { id: "scope", name: "Scope", type: "select" }, 2, false, "single_select");
  const tableField = await createField(db, table.id, { id: "table", name: "Table", type: "select" }, 3, false, "single_select");
  const errorTypeField = await createField(db, table.id, { id: "error_type", name: "Error type", type: "select" }, 4, false, "single_select");
  const messageField = await createField(db, table.id, { id: "message", name: "Message", type: "multilineText" }, 5, false, "long_text");

  const scopeOptions = await insertSelectOptions(db, scopeField.id, REPORT_SCOPES);
  const errorTypeOptions = await insertSelectOptions(db, errorTypeField.id, REPORT_ERROR_TYPES);
  const uniqueTables = Array.from(new Set(report.items.map((item) => item.table).filter(Boolean)));
  const tableColors = ["light-blue", "light-green", "light-cyan", "light-purple", "light-yellow", "light-orange"];
  const tableOptions = await insertSelectOptions(
    db,
    tableField.id,
    uniqueTables.map((value, index) => ({ value, color: tableColors[index % tableColors.length] }))
  );

  await createGridView(db, table.id, [objectNameField, scopeField, tableField, errorTypeField, messageField]);

  const tableName = `database_table_${table.id}`;
  const now = new Date().toISOString();
  const statements = report.items.map((item, index) => {
    const scope = scopeOptions.get(item.scope) || null;
    const tableOption = tableOptions.get(item.table) || null;
    const errorType = errorTypeOptions.get(item.errorType) || null;
    return db.prepare(
      `INSERT INTO "${tableName}"
       ([order], _created_on, _updated_on, "field_${objectNameField.id}", "field_${scopeField.id}",
        "field_${tableField.id}", "field_${errorTypeField.id}", "field_${messageField.id}")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      (index + 1) * 10000,
      now,
      now,
      item.objectName,
      serializeFieldValueForInsert("single_select", scope),
      serializeFieldValueForInsert("single_select", tableOption),
      serializeFieldValueForInsert("single_select", errorType),
      item.message
    );
  });
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }
  return table;
}

async function createImportedViews(db: D1Database, importedTable: ImportedTable, ctx: ImportContext): Promise<void> {
  const specs = buildAirtableViewSpecs(importedTable.airtableTable, importedTable.tableData, importedTable.fields, ctx);
  for (const view of importedTable.airtableTable.views || []) {
    if (!["grid", "gallery", "form", "kanban", "calendar", "timeline"].includes(String(view.type))) {
      ctx.report.addFailed(
        cleanName(view.name, "Airtable view"),
        "View",
        cleanName(importedTable.airtableTable.name, ""),
        "Unsupported feature",
        `View "${cleanName(view.name, "Airtable view")}" was not imported because Airtable view type "${String(view.type || "")}" is not supported by the Supertask Airtable importer.`
      );
    }
  }
  if (specs.length === 0) {
    await createGridView(db, importedTable.table.id, importedTable.fields);
    return;
  }

  const now = new Date().toISOString();
  for (const spec of specs) {
    const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const view = await db.prepare(
      `INSERT INTO database_view
       (table_id, name, type, [order], filter_type, filters_disabled, public,
        public_view_password, slug, trashed, created_on, updated_on,
        row_identifier_type, ownership_type, row_height_size, card_cover_image_field,
        single_select_field, date_field, start_date_field, end_date_field, timescale)
       VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?, 0, ?, ?, 'count', 'collaborative', ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    ).bind(
      importedTable.table.id,
      spec.name,
      spec.type,
      spec.order,
      spec.filterType,
      slug,
      now,
      now,
      spec.rowHeightSize,
      spec.cardCoverImageFieldId,
      spec.singleSelectFieldId,
      spec.dateFieldId,
      spec.startDateFieldId,
      spec.endDateFieldId,
      spec.timescale
    ).first<{ id: number }>();
    if (!view) continue;

    if (spec.type === "form" && spec.form) {
      await db.prepare(
        `INSERT OR IGNORE INTO database_formview
         (view_ptr_id, title, description, submit_text, submit_action,
          submit_action_message, submit_action_redirect_url, mode, show_logo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        view.id,
        spec.form.title,
        spec.form.description,
        spec.form.submitText,
        spec.form.submitAction,
        spec.form.submitActionMessage,
        spec.form.submitActionRedirectUrl,
        spec.form.mode,
        spec.form.showLogo ? 1 : 0
      ).run();

      const optionStatements = spec.form.fieldOptions.map((option) => db.prepare(
        `INSERT OR IGNORE INTO database_formviewfieldoptions
         (form_view_id, field_id, name, description, enabled, required, [order],
          show_when_matching_conditions, condition_type, include_all_select_options, field_component)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'AND', ?, 'default')`
      ).bind(
        view.id,
        option.fieldId,
        option.name,
        option.description,
        option.enabled ? 1 : 0,
        option.required ? 1 : 0,
        option.order,
        option.includeAllSelectOptions ? 1 : 0
      ));
      if (optionStatements.length > 0) await db.batch(optionStatements);
    } else if (spec.type === "gallery") {
      const optionStatements = spec.fieldOptions.map((option) => db.prepare(
        `INSERT OR IGNORE INTO database_galleryviewfieldoptions
         (gallery_view_id, field_id, hidden, [order])
         VALUES (?, ?, ?, ?)`
      ).bind(view.id, option.fieldId, option.hidden ? 1 : 0, option.order));
      if (optionStatements.length > 0) await db.batch(optionStatements);
    } else {
      const optionStatements = spec.fieldOptions.map((option) => db.prepare(
        `INSERT OR IGNORE INTO database_gridviewfieldoptions
         (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
         VALUES (?, ?, ?, ?, ?, '', '')`
      ).bind(view.id, option.fieldId, option.width, option.hidden ? 1 : 0, option.order));
      if (optionStatements.length > 0) await db.batch(optionStatements);
    }

    const groupIdMap = new Map<string, number>();
    for (const group of spec.filterGroups) {
      const inserted = await db.prepare(
        "INSERT INTO database_viewfiltergroup (view_id, parent_group_id, filter_type) VALUES (?, ?, ?) RETURNING id"
      ).bind(view.id, group.parentAirtableId ? groupIdMap.get(group.parentAirtableId) || null : null, group.filterType)
        .first<{ id: number }>();
      if (inserted) groupIdMap.set(group.airtableId, inserted.id);
    }
    const filterStatements = spec.filters.map((filter) => db.prepare(
      "INSERT INTO database_viewfilter (view_id, field_id, type, value, group_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(view.id, filter.fieldId, filter.type, filter.value, filter.groupAirtableId ? groupIdMap.get(filter.groupAirtableId) || null : null));
    if (filterStatements.length > 0) await db.batch(filterStatements);

    const sortStatements = spec.sortings.map((sort) => db.prepare(
      "INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (?, ?, ?, 'default')"
    ).bind(view.id, sort.fieldId, sort.order));
    if (sortStatements.length > 0) await db.batch(sortStatements);

    const groupStatements = spec.groupBys.map((group) => db.prepare(
      "INSERT INTO database_viewgroupby (view_id, field_id, [order], width, type) VALUES (?, ?, ?, 200, 'default')"
    ).bind(view.id, group.fieldId, group.order));
    if (groupStatements.length > 0) await db.batch(groupStatements);

    const decorationStatements = spec.decorations.map((decoration) => db.prepare(
      `INSERT INTO database_viewdecoration (view_id, type, value_provider_type, value_provider_conf, [order])
       VALUES (?, ?, ?, ?, ?)`
    ).bind(view.id, decoration.type, decoration.valueProviderType, JSON.stringify(decoration.valueProviderConf), decoration.order));
    if (decorationStatements.length > 0) await db.batch(decorationStatements);
  }
}

async function finalizeLinkFieldSettings(db: D1Database, importedTables: ImportedTable[], tableByAirtableId: Map<string, ImportedTable>): Promise<void> {
  for (const importedTable of importedTables) {
    for (const field of importedTable.fields) {
      if (field.type !== "link_row" || !field.targetAirtableTableId) continue;
      const target = tableByAirtableId.get(field.targetAirtableTableId);
      if (!target) continue;
      const targetPrimary = target.fields.find((item) => item.primary) || target.fields[0];
      field.targetTableId = target.table.id;
      field.settings = {
        ...(field.settings || {}),
        link_row_table_id: target.table.id,
        link_row_related_field_id: null,
        link_row_multiple_relationships: true,
        link_row_limit_selection_view_id: null,
        link_row_table: {
          id: target.table.id,
          name: target.table.name,
          order: target.table.order,
          database_id: target.table.database_id,
        },
        link_row_table_primary_field: targetPrimary ? {
          id: targetPrimary.id,
          table_id: target.table.id,
          name: cleanName(
            target.airtableTable.columns?.find((column: any) => column.id === targetPrimary.airtableColumnId)?.name,
            "Name"
          ),
          type: targetPrimary.type,
          primary: true,
        } : null,
      };
      await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
        .bind(JSON.stringify(field.settings), field.id)
        .run();
    }
  }
}

function reportBrokenComputedReference(
  ctx: ImportContext,
  field: ImportedField,
  tableName: string,
  referenceKind: "relation" | "target",
  referenceId: string
): void {
  ctx.report.addFailed(
    cleanName(field.airtableColumn?.name, `Field ${field.id}`),
    "Field",
    cleanName(tableName, ""),
    "Data type mismatch",
    `Field "${cleanName(field.airtableColumn?.name, `Field ${field.id}`)}" was imported with an unresolved Airtable ${referenceKind} reference "${referenceId || "empty"}"; the Supertask field remains valid with a null dependency.`
  );
}

async function finalizeCountFieldSettings(db: D1Database, importedTables: ImportedTable[], ctx: ImportContext): Promise<void> {
  for (const importedTable of importedTables) {
    for (const field of importedTable.fields) {
      if (field.type !== "count") continue;
      if (!field.relationAirtableColumnId) {
        reportBrokenComputedReference(ctx, field, importedTable.airtableTable.name, "relation", "");
        continue;
      }
      const throughField = importedTable.fields.find((item) => item.airtableColumnId === field.relationAirtableColumnId);
      if (!throughField || throughField.type !== "link_row") {
        reportBrokenComputedReference(ctx, field, importedTable.airtableTable.name, "relation", field.relationAirtableColumnId);
        continue;
      }
      field.settings = {
        ...(field.settings || {}),
        through_field_id: throughField.id,
        formula_type: "number",
        number_decimal_places: 0,
      };
      await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
        .bind(JSON.stringify(field.settings), field.id)
        .run();
    }
  }
}

async function finalizeLookupRollupFieldSettings(db: D1Database, importedTables: ImportedTable[], tableByAirtableId: Map<string, ImportedTable>, ctx: ImportContext): Promise<void> {
  for (const importedTable of importedTables) {
    for (const field of importedTable.fields) {
      if (field.type !== "lookup" && field.type !== "rollup") continue;
      if (!field.relationAirtableColumnId) {
        reportBrokenComputedReference(ctx, field, importedTable.airtableTable.name, "relation", "");
        continue;
      }
      const throughField = importedTable.fields.find((item) => item.airtableColumnId === field.relationAirtableColumnId);
      if (!throughField || throughField.type !== "link_row" || !throughField.targetAirtableTableId) {
        reportBrokenComputedReference(ctx, field, importedTable.airtableTable.name, "relation", field.relationAirtableColumnId);
        continue;
      }
      const targetTable = tableByAirtableId.get(throughField.targetAirtableTableId);
      const targetAirtableColumnId = String(field.airtableColumn?.typeOptions?.foreignTableRollupColumnId || "");
      const targetField = targetTable?.fields.find((item) => item.airtableColumnId === targetAirtableColumnId);
      if (!targetField) {
        reportBrokenComputedReference(ctx, field, importedTable.airtableTable.name, "target", targetAirtableColumnId);
        continue;
      }
      field.settings = {
        ...(field.settings || {}),
        through_field_id: throughField.id,
        target_field_id: targetField.id,
        ...(field.type === "lookup"
          ? {
            formula_type: "array",
            array_formula_type: airtableFormulaType(field.airtableColumn?.typeOptions?.resultType),
          }
          : airtableRollupSettings(
            field.airtableColumn?.typeOptions?.formulaTextParsed,
            field.airtableColumn?.typeOptions?.resultType
          )),
      };
      await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
        .bind(JSON.stringify(field.settings), field.id)
        .run();
    }
  }
}

function primaryDisplayValue(row: any, primaryField: ImportedField | undefined): string {
  const raw = primaryField ? row.cellValuesByColumnId?.[primaryField.airtableColumnId] : null;
  return cleanName(primitiveText(raw), `Row ${row.id || ""}`.trim());
}

async function insertRows(
  db: D1Database,
  tableId: number,
  airtableTableId: string,
  rows: any[],
  fields: ImportedField[],
  skipFiles: boolean,
  ctx: ImportContext
): Promise<void> {
  const tableName = `database_table_${tableId}`;
  const now = new Date().toISOString();
  const limitedRows = rows;
  const statements = [];
  for (let index = 0; index < limitedRows.length; index++) {
    const row = limitedRows[index];
    const cols = ["[order]", "_created_on", "_updated_on"];
    const values: unknown[] = [(index + 1) * 10000, row.createdTime || now, now];
    const cellValues = row.cellValuesByColumnId || {};
    for (const field of fields) {
      cols.push(`"field_${field.id}"`);
      if (field.type === "link_row") {
        values.push(serializeFieldValueForInsert(field.type, []));
      } else {
        values.push(serializeFieldValueForInsert(
          field.type,
          await normalizeCellValue(cellValues[field.airtableColumnId], field, skipFiles, ctx, row)
        ));
      }
    }
    statements.push(db.prepare(`INSERT INTO "${tableName}" (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...values));
  }
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }

  const insertedRows = await db.prepare(`SELECT id, [order] AS row_order FROM "${tableName}" ORDER BY [order] ASC, id ASC LIMIT ?`)
    .bind(limitedRows.length)
    .all<{ id: number; row_order: number }>();
  const lookup: RowLookup = new Map();
  const primary = fields.find((field) => field.primary) || fields[0];
  (insertedRows.results || []).forEach((inserted, index) => {
    const sourceRow = limitedRows[index];
    if (sourceRow?.id) lookup.set(String(sourceRow.id), { id: inserted.id, value: primaryDisplayValue(sourceRow, primary) });
  });
  ctx.rowLookups.set(airtableTableId, lookup);
}

async function updateLinkRows(
  db: D1Database,
  importedTables: ImportedTable[],
  skipFiles: boolean,
  ctx: ImportContext
): Promise<void> {
  for (const importedTable of importedTables) {
    const linkFields = importedTable.fields.filter((field) => field.type === "link_row");
    if (linkFields.length === 0) continue;
    const tableName = `database_table_${importedTable.table.id}`;
    const rowLookup = ctx.rowLookups.get(importedTable.airtableTable.id);
    if (!rowLookup) continue;
    const statements = [];
    for (const sourceRow of (importedTable.tableData.rows || [])) {
      const inserted = rowLookup.get(String(sourceRow.id));
      if (!inserted) continue;
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const field of linkFields) {
        sets.push(`"field_${field.id}"=?`);
        values.push(serializeFieldValueForInsert(
          field.type,
          await normalizeCellValue(sourceRow.cellValuesByColumnId?.[field.airtableColumnId], field, skipFiles, ctx, sourceRow)
        ));
      }
      values.push(inserted.id);
      statements.push(db.prepare(`UPDATE "${tableName}" SET ${sets.join(",")} WHERE id=?`).bind(...values));
    }
    for (let i = 0; i < statements.length; i += 50) {
      await db.batch(statements.slice(i, i + 50));
    }
  }
}

function importedFieldMeta(field: ImportedField): FieldMeta {
  return {
    id: field.id,
    name: cleanName(field.airtableColumn?.name, `Field ${field.id}`),
    type: field.type,
    primary: field.primary,
    readOnly: isReadOnlyFieldType(field.type),
    formula: typeof field.settings?.formula === "string" ? field.settings.formula : undefined,
    settings: field.settings || {},
  };
}

function serializeComputedValueForStore(field: ImportedField, value: unknown): unknown {
  const formulaType = String(field.settings?.formula_type || "");
  if ((field.type === "formula" || field.type === "rollup") && value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  if (field.type === "rollup" && formulaType === "boolean") return serializeFieldValueForInsert("boolean", value);
  if (field.type === "rollup" && !["number", "duration"].includes(formulaType)) return value;
  return serializeFieldValueForInsert(field.type, value);
}

async function recomputeImportedComputedFields(db: D1Database, importedTables: ImportedTable[]): Promise<void> {
  for (const importedTable of importedTables) {
    const computedFields = importedTable.fields.filter((field) => ["formula", "count", "lookup", "rollup"].includes(field.type));
    if (computedFields.length === 0) continue;
    const fields = importedTable.fields.map(importedFieldMeta);
    const tableName = `database_table_${importedTable.table.id}`;
    const rows = await db.prepare(`SELECT * FROM "${tableName}" ORDER BY [order] ASC, id ASC`).all<Record<string, unknown>>();
    for (const row of rows.results || []) {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const field of computedFields) {
        const meta = fields.find((item) => item.id === field.id);
        if (!meta) continue;
        sets.push(`"field_${field.id}"=?`);
        values.push(serializeComputedValueForStore(field, await computeLinkedFieldValue(db, row, fields, meta)));
      }
      if (sets.length === 0) continue;
      values.push(row.id);
      await db.prepare(`UPDATE "${tableName}" SET ${sets.join(", ")} WHERE id=?`).bind(...values).run();
    }
  }
}

async function cleanupFailedAirtableImport(env: Env, applicationId: number, importedFileNames: Set<string>): Promise<void> {
  const tables = await env.DB.prepare("SELECT id FROM database_table WHERE database_id=?")
    .bind(applicationId)
    .all<{ id: number }>();
  for (const table of tables.results || []) {
    await env.DB.prepare(`DROP TABLE IF EXISTS "database_table_${Number(table.id)}"`).run();
  }
  await env.DB.prepare("DELETE FROM core_application WHERE id=?").bind(applicationId).run();
  await deleteUnreferencedUserFiles(env, importedFileNames);
}

export async function importAirtableBase(
  env: Env,
  payload: AirtableImportPayload,
  userId: number | null = null,
  progress?: AirtableProgressReporter
): Promise<{ database: object; pendingAttachmentCount: number }> {
  const db = env.DB;
  const workspaceId = Number(payload.workspace_id || 0);
  if (!workspaceId) throw new Error("workspace_id is required.");
  if (!payload.airtable_share_url) throw new Error("airtable_share_url is required.");
  if (Boolean(payload.session) !== Boolean(payload.session_signature)) {
    throw new Error("Both Airtable session cookies must be provided together.");
  }

  const shareId = extractShareId(payload.airtable_share_url);
  await reportAirtableProgress(progress, 5, "downloading-base");
  const init = await fetchSharedBase(env, shareId, payload);
  await reportAirtableProgress(progress, 10, "downloading-base");
  const { schema, tables } = await fetchAirtableData(init, progress);
  await reportAirtableProgress(progress, 50, "converting");
  const importReport = new AirtableImportReport();
  let application: any | null = null;
  const importedFileNames = new Set<string>();
  try {
  application = await createImportedApplication(
    db,
    workspaceId,
    cleanName(init.initData.rawApplications?.[init.initData.sharedApplicationId]?.name, "Airtable import")
  );

  const importedTables: ImportedTable[] = [];
  const tableByAirtableId = new Map<string, ImportedTable>();
  for (let tableIndex = 0; tableIndex < schema.tableSchemas.length; tableIndex++) {
    const airtableTable = schema.tableSchemas[tableIndex];
    const tableData = tables[airtableTable.id] || { rows: [] };
    const table = await createTable(db, application.id, cleanName(airtableTable.name, `Table ${tableIndex + 1}`), tableIndex + 1);
    const importedTable: ImportedTable = { airtableTable, tableData, table, fields: [] };
    importedTables.push(importedTable);
    tableByAirtableId.set(String(airtableTable.id), importedTable);
    await reportAirtableProgress(progress, 50 + ((tableIndex + 1) / schema.tableSchemas.length) * 5, "converting");
  }

  for (const importedTable of importedTables) {
    const { airtableTable, table } = importedTable;
    const orderedColumnIds = (airtableTable.meaningfulColumnOrder || []).map((item: any) => item.columnId);
    const columns = [...(airtableTable.columns || [])].sort((a: any, b: any) => {
      const ai = orderedColumnIds.indexOf(a.id);
      const bi = orderedColumnIds.indexOf(b.id);
      return (ai === -1 ? 99999 : ai) - (bi === -1 ? 99999 : bi);
    });
    if (columns.length === 0) {
      columns.push({ id: "primary_field", name: "Name", type: "text" });
    }

    const fields: ImportedField[] = [];
    const primaryColumnId = selectPrimaryColumnId(columns, airtableTable.primaryColumnId, tableByAirtableId);
    if (primaryColumnId && String(primaryColumnId) !== String(airtableTable.primaryColumnId || "")) {
      const primaryColumn = columns.find((column: any) => String(column.id) === String(primaryColumnId));
      importReport.addFailed(
        cleanName(primaryColumn?.name, "Primary field"),
        "Field",
        cleanName(airtableTable.name, ""),
        "Unsupported feature",
        `Changed primary field to "${cleanName(primaryColumn?.name, "Primary field")}" because the original Airtable primary field is incompatible with Supertask.`
      );
    }
    if (!primaryColumnId) {
      columns.unshift({
        id: SYNTHETIC_PRIMARY_COLUMN_ID,
        name: "Name",
        type: "text",
        syntheticPrimary: true,
        sourceColumnId: airtableTable.primaryColumnId || columns[0]?.id || null,
      });
      importReport.addFailed(
        "Name",
        "Field",
        cleanName(airtableTable.name, ""),
        "Unsupported feature",
        `Created new primary field "Name" because none of the Airtable fields are compatible as a Supertask primary field.`
      );
    }
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = airtableColumnWithRuntimeChoices(columns[columnIndex], importedTable.tableData.rows || []);
      const primary: boolean = primaryColumnId ? String(column.id) === primaryColumnId : column.id === SYNTHETIC_PRIMARY_COLUMN_ID;
      const type = airtableTypeToSupertask(column, primary, tableByAirtableId);
      if (type === null) {
        importReport.addFailed(
          cleanName(column.name, `Field ${columnIndex + 1}`),
          "Field",
          cleanName(airtableTable.name, ""),
          "Unsupported feature",
          `Field "${cleanName(column.name, `Field ${columnIndex + 1}`)}" with field type ${String(column.type || "")} was not imported because it is not supported.`
        );
        continue;
      }
      fields.push(await createField(db, table.id, { ...column, tableName: airtableTable.name }, columnIndex + 1, primary, type, importReport));
    }
    importedTable.fields = fields;
    await reportAirtableProgress(progress, 55 + (importedTables.indexOf(importedTable) + 1) / importedTables.length * 10, "converting");
  }

  const ctx: ImportContext = {
    env,
    workspaceId,
    userId,
    init,
    rowLookups: new Map(),
    failedAttachmentCount: 0,
    importedFileNames,
    deferAttachments: false,
    pendingAttachments: [],
    report: importReport,
  };

  const totalAttachments = attachmentCount(importedTables);
  ctx.deferAttachments = Boolean(payload._job_id) && !payload.skip_files && totalAttachments > 20;

  await finalizeLinkFieldSettings(db, importedTables, tableByAirtableId);
  await finalizeCountFieldSettings(db, importedTables, ctx);
  await finalizeLookupRollupFieldSettings(db, importedTables, tableByAirtableId, ctx);

  for (const importedTable of importedTables) {
    ctx.signedUserContentUrls = importedTable.tableData.signedUserContentUrls || null;
    ctx.currentAirtableTableId = String(importedTable.airtableTable.id);
    ctx.currentTableId = Number(importedTable.table.id);
    const hasFileFields = importedTable.fields.some((field) => field.type === "file");
    await reportAirtableProgress(progress, hasFileFields && !payload.skip_files ? 80 : 70, hasFileFields && !payload.skip_files ? "downloading-files" : "converting");
    await insertRows(
      db,
      importedTable.table.id,
      String(importedTable.airtableTable.id),
      importedTable.tableData.rows || [],
      importedTable.fields,
      Boolean(payload.skip_files),
      ctx
    );
    await reportAirtableProgress(progress, 70 + (importedTables.indexOf(importedTable) + 1) / importedTables.length * 15, "converting");
  }

  await updateLinkRows(db, importedTables, Boolean(payload.skip_files), ctx);
  await recomputeImportedComputedFields(db, importedTables);
  await reportAirtableProgress(progress, 88, "converting");

  for (const importedTable of importedTables) {
    await createImportedViews(db, importedTable, ctx);
  }
  await reportAirtableProgress(progress, 93, "converting");

  importReport.addFailed(
    "All automations",
    "Automations",
    "",
    "Unsupported feature",
    "Airtable automations were not imported because Supertask Airtable import does not convert Airtable automations."
  );
  importReport.addFailed(
    "All interfaces",
    "Interfaces",
    "",
    "Unsupported feature",
    "Airtable interfaces were not imported because Supertask Airtable import does not convert Airtable interfaces."
  );

  const reportTable = await createAirtableImportReportTable(
    db,
    application.id,
    importedTables.length + 1,
    importReport
  );
  await reportAirtableProgress(progress, 97, "converting");

  const serializedTables: object[] = [];
  for (const importedTable of importedTables) {
    serializedTables.push(await serializeDatabaseTable(db, importedTable.table));
  }
  if (reportTable) serializedTables.push(await serializeDatabaseTable(db, reportTable));

  const pendingAttachmentCount = payload._job_id && application?.id
    ? await schedulePendingAttachmentTasks(ctx, Number(payload._job_id), Number(application.id))
    : 0;

  return {
    database: {
      id: application.id,
      name: application.name,
      type: "database",
      order: application.order,
      workspace: { id: workspaceId },
      workspace_id: workspaceId,
      tables: serializedTables,
      airtable_failed_attachment_count: ctx.failedAttachmentCount || 0,
    },
    pendingAttachmentCount,
  };
  } catch (error) {
    if (application?.id) {
      try {
        await cleanupFailedAirtableImport(env, Number(application.id), importedFileNames);
      } catch (cleanupError) {
        console.error("[airtable-import] failed to compensate an unsuccessful import", cleanupError);
      }
    }
    throw error;
  }
}

export async function processAirtableAttachmentTaskBatch(
  env: Env,
  job: JobMessage
): Promise<{ complete: boolean; failed: number; remaining: number }> {
  const payload = job.payload as unknown as AirtableAttachmentTaskPayload;
  const taskIds = [...new Set((payload.task_ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);
  const cachedInit = payload.airtable_init || JSON.parse(await env.CACHE.get(attachmentInitCacheKey(job.job_id)) || "null");
  if (taskIds.length === 0 || !cachedInit || !payload.database_id) {
    throw new Error("Airtable attachment task payload is invalid.");
  }

  const application = await env.DB.prepare(
    "SELECT workspace_id FROM core_application WHERE id=? AND trashed=0"
  ).bind(payload.database_id).first<{ workspace_id: number }>();
  if (!application) throw new Error("The Airtable import database no longer exists.");

  const placeholders = taskIds.map(() => "?").join(",");
  const tasks = await env.DB.prepare(
    `SELECT * FROM database_airtable_attachment_task
     WHERE job_id=? AND database_id=? AND status='pending' AND id IN (${placeholders})
     ORDER BY id`
  ).bind(job.job_id, payload.database_id, ...taskIds).all<any>();
  const retryIds: number[] = [];
  const report = new AirtableImportReport();

  for (const task of tasks.results || []) {
    try {
      const file = JSON.parse(task.file_json);
      const ctx: ImportContext = {
        env,
        workspaceId: Number(application.workspace_id),
        userId: job.user_id || null,
        init: cachedInit,
        rowLookups: new Map(),
        report,
      };
      const response = await downloadAirtableFile(ctx, task.airtable_row_id, task.airtable_column_id, file);
      if (!response.body) throw new Error("Airtable attachment response has no body.");
      const visibleName = cleanName(file.filename ?? file.name ?? file.id, "airtable-file");
      const contentType = file.type || response.headers.get("content-type") || "application/octet-stream";
      const stored = await storeUserFile(env, {
        userId: job.user_id || null,
        fileName: visibleName,
        contentType,
        size: Number(file.size || response.headers.get("content-length") || 0),
        body: response.body,
      });
      const imageWidth = Number(file.width || stored.image_width || 0) || null;
      const imageHeight = Number(file.height || stored.image_height || 0) || null;
      const isImage = Boolean(stored.is_image) || (contentType.startsWith("image/") && imageWidth !== null && imageHeight !== null);
      await env.DB.prepare("UPDATE core_userfile SET is_image=?, image_width=?, image_height=? WHERE id=?")
        .bind(isImage ? 1 : 0, imageWidth, imageHeight, stored.id)
        .run();
      (stored as StoredUserFile).is_image = isImage ? 1 : 0;
      (stored as StoredUserFile).image_width = imageWidth;
      (stored as StoredUserFile).image_height = imageHeight;
      const serialized = await serializeUserFileCellForRequest(env, stored, application.workspace_id, visibleName);

      const column = `field_${Number(task.field_id)}`;
      const row = await env.DB.prepare(
        `SELECT "${column}" AS value FROM "database_table_${Number(task.table_id)}" WHERE id=?`
      ).bind(task.row_id).first<{ value: string | null }>();
      const files = row?.value ? JSON.parse(row.value) : [];
      if (!Array.isArray(files)) throw new Error("Airtable attachment cell is invalid.");
      const fileIndex = files.findIndex((item: any) => item?.airtable_task_key === task.task_key);
      if (fileIndex === -1) throw new Error("Airtable attachment task marker is missing from its cell.");
      files[fileIndex] = serialized;
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`UPDATE "database_table_${Number(task.table_id)}" SET "${column}"=?, _updated_on=? WHERE id=?`)
          .bind(serializeFieldValueForInsert("file", files), now, task.row_id),
        env.DB.prepare(
          "UPDATE database_airtable_attachment_task SET status='finished', attempts=attempts+1, error=NULL, updated_on=? WHERE id=?"
        ).bind(now, task.id),
      ]);
    } catch (error) {
      const attempts = Number(task.attempts || 0) + 1;
      const terminal = attempts >= 5;
      await env.DB.prepare(
        "UPDATE database_airtable_attachment_task SET status=?, attempts=?, error=?, updated_on=? WHERE id=?"
      ).bind(
        terminal ? "failed" : "pending",
        attempts,
        error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        new Date().toISOString(),
        task.id
      ).run();
      if (!terminal) retryIds.push(Number(task.id));
    }
  }

  if (retryIds.length > 0) {
    await env.JOBS_QUEUE.send({
      ...job,
      payload: { ...job.payload, task_ids: retryIds },
    }, { delaySeconds: 5 });
  }

  return settleAirtableAttachmentJob(env, job.job_id);
}

// How many more times files of a dead-letter message are sent back, each alone
// in its own message, before they count as failed. A crash also takes down the
// other messages of its batch, so a file that is fine may need a second round.
const AIRTABLE_ATTACHMENT_DEAD_LETTER_ROUNDS = 2;

// A message lands in the dead-letter queue when the Worker died (memory, CPU)
// on each of its deliveries, without any task recording an error. Its files
// are retried one per message, so a file that crashes the Worker no longer
// takes the others down, and finally failed, so the import always ends.
export async function recoverDeadLetterAirtableAttachments(
  env: Env,
  job: JobMessage
): Promise<{ complete: boolean; failed: number; remaining: number } | null> {
  const payload = job.payload as unknown as AirtableAttachmentTaskPayload & { dead_letter_rounds?: number };
  const taskIds = [...new Set((payload.task_ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);
  if (taskIds.length === 0) return null;
  const placeholders = taskIds.map(() => "?").join(",");
  const pending = await env.DB.prepare(
    `SELECT id FROM database_airtable_attachment_task
     WHERE job_id=? AND status='pending' AND id IN (${placeholders})
     ORDER BY id`
  ).bind(job.job_id, ...taskIds).all<{ id: number }>();
  const pendingIds = (pending.results || []).map((task) => Number(task.id));

  const rounds = Number(payload.dead_letter_rounds || 0);
  if (pendingIds.length > 0 && rounds < AIRTABLE_ATTACHMENT_DEAD_LETTER_ROUNDS) {
    const messages = pendingIds.map((id) => ({
      body: { ...job, payload: { ...job.payload, task_ids: [id], dead_letter_rounds: rounds + 1 } },
    }));
    for (let index = 0; index < messages.length; index += 100) {
      await env.JOBS_QUEUE.sendBatch(messages.slice(index, index + 100));
    }
    return null;
  }

  if (pendingIds.length > 0) {
    await env.DB.prepare(
      `UPDATE database_airtable_attachment_task
       SET status='failed', attempts=attempts+1, error=?, updated_on=?
       WHERE job_id=? AND status='pending' AND id IN (${pendingIds.map(() => "?").join(",")})`
    ).bind(
      "Copying this attachment stopped the worker on every attempt (it probably ran out of memory or time).",
      new Date().toISOString(),
      job.job_id,
      ...pendingIds
    ).run();
  }
  return settleAirtableAttachmentJob(env, job.job_id);
}

// Reports the copy progress of an import's attachments, and throws once none
// is pending while some failed, so the job ends failed rather than finished.
async function settleAirtableAttachmentJob(
  env: Env,
  jobId: number
): Promise<{ complete: boolean; failed: number; remaining: number }> {
  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS finished,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
     FROM database_airtable_attachment_task WHERE job_id=?`
  ).bind(jobId).first<any>();
  const total = Number(counts?.total || 0);
  const finished = Number(counts?.finished || 0);
  const failed = Number(counts?.failed || 0);
  const remaining = Number(counts?.pending || 0);
  await env.DB.prepare(
    "UPDATE core_job SET status='downloading-files', progress_percentage=?, updated_on=? WHERE id=?"
  ).bind(total > 0 ? 80 + Math.floor((finished / total) * 19) : 99, new Date().toISOString(), jobId).run();

  if (remaining === 0 && failed > 0) {
    await env.CACHE.delete(attachmentInitCacheKey(jobId));
    throw new Error(`${failed} Airtable attachments could not be copied to R2.`);
  }
  if (remaining === 0) await env.CACHE.delete(attachmentInitCacheKey(jobId));
  return { complete: remaining === 0 && failed === 0, failed, remaining };
}
