import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "@cloudflare/puppeteer";
import {
  airtableTypeToBaserow,
  airtableColumnWithRuntimeChoices,
  airtableAttachmentFileName,
  buildAirtableViewSpecs,
  choiceList,
  importAirtableBase,
  normalizeCellValue,
  normalizeSelectValue,
  processAirtableAttachmentTaskBatch,
  primitiveText,
  quillToMarkdown,
} from "../src/services/airtable-import";
import { storeUserFile } from "../src/services/user-files";

type TestD1 = {
  database: DatabaseSync;
  prepare(sql: string): {
    bind(...args: unknown[]): { all(): Promise<{ results: any[] }>; first<T = any>(): Promise<T | null>; run(): Promise<object> };
    all(): Promise<{ results: any[] }>;
    first<T = any>(): Promise<T | null>;
    run(): Promise<object>;
  };
  batch(statements: Array<{ all?: () => Promise<any>; first?: () => Promise<any>; run?: () => Promise<any> }>): Promise<any[]>;
};

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0001_initial.sql",
    "0003_user_files.sql",
    "0006_field_rules_data_sync.sql",
    "0008_core_job_result.sql",
    "0009_builder_core.sql",
    "0019_premium_view_settings.sql",
    "0020_view_filter_groups.sql",
    "0021_workspace_trash.sql",
    "0028_userfile_baserow_name_hash.sql",
    "0039_builder_published_applications.sql",
    "0042_airtable_attachment_tasks.sql",
  ]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
  const api: TestD1 = {
    database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const executeAll = (args: unknown[]) => Promise.resolve({ results: statement.all(...args.map(d1Value)) });
      const executeFirst = <T = any>(args: unknown[]) => Promise.resolve((statement.get(...args.map(d1Value)) || null) as T | null);
      const executeRun = (args: unknown[]) => Promise.resolve(statement.run(...args.map(d1Value)));
      return {
        bind(...args: unknown[]) {
          return {
            all: () => executeAll(args),
            first: <T = any>() => executeFirst<T>(args),
            run: () => executeRun(args),
          };
        },
        all: () => executeAll([]),
        first: <T = any>() => executeFirst<T>([]),
        run: () => executeRun([]),
      };
    },
    batch(statements) {
      return Promise.all(statements.map((statement) => statement.run ? statement.run() : statement.first ? statement.first() : statement.all?.()));
    },
  };
  api.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Fixture workspace', ?, 0, 1)")
    .bind(new Date().toISOString())
    .run();
  api.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (7, '', 'fixture@example.com', 'Fixture', 'User', 'fixture@example.com', 0, 1, ?)`
  ).bind(new Date().toISOString()).run();
  return api;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function airtableFixture() {
  const initData = {
    rawApplications: { appFixture: { name: "Fixture Airtable Base" } },
    sharedApplicationId: "appFixture",
    accessPolicy: "{}",
    codeVersion: "fixture",
    pageLoadId: "pageFixture",
    singleApplicationScaffoldingData: { tableById: { tblCustomers: {}, tblOrders: {}, tblPrimarySelect: {} } },
  };
  const customersTable = {
    id: "tblCustomers",
    name: "Customers",
    primaryColumnId: "fldCustomerName",
    meaningfulColumnOrder: [{ columnId: "fldCustomerName" }, { columnId: "fldStatus" }, { columnId: "fldEmail" }, { columnId: "fldCustomerScore" }, { columnId: "fldCustomerNotes" }],
    columns: [
      { id: "fldCustomerName", name: "Customer", type: "text" },
      { id: "fldStatus", name: "Status", type: "select", typeOptions: { choices: {} } },
      { id: "fldEmail", name: "Email", type: "email" },
      { id: "fldCustomerScore", name: "Score", type: "number", typeOptions: { format: "integer", precision: 0 } },
      { id: "fldCustomerNotes", name: "Notes", type: "richText" },
    ],
    views: [
      { id: "viwCustomersGrid", name: "Customers grid", type: "grid" },
      { id: "viwCustomersKanban", name: "Customers kanban", type: "kanban" },
    ],
    viewOrder: ["viwCustomersGrid", "viwCustomersKanban"],
  };
  const ordersTable = {
    id: "tblOrders",
    name: "Orders",
    primaryColumnId: "fldOrderName",
    meaningfulColumnOrder: [
      { columnId: "fldOrderName" },
      { columnId: "fldPaid" },
      { columnId: "fldAmount" },
      { columnId: "fldCurrency" },
      { columnId: "fldDuration" },
      { columnId: "fldDurationTenths" },
      { columnId: "fldDurationHundredths" },
      { columnId: "fldDueDate" },
      { columnId: "fldUrl" },
      { columnId: "fldPhone" },
      { columnId: "fldRating" },
      { columnId: "fldOwner" },
      { columnId: "fldTags" },
      { columnId: "fldCustomerLink" },
      { columnId: "fldAltCustomerLink" },
      { columnId: "fldCustomerCount" },
      { columnId: "fldCustomerEmailLookup" },
      { columnId: "fldCustomerScoreRollup" },
      { columnId: "fldBrokenCount" },
      { columnId: "fldBrokenLookup" },
      { columnId: "fldBrokenRollup" },
      { columnId: "fldFiles" },
      { columnId: "fldCreated" },
      { columnId: "fldLastModified" },
      { columnId: "fldCreatedBy" },
      { columnId: "fldLastModifiedBy" },
      { columnId: "fldCalculatedAmount" },
      { columnId: "fldUnsupportedFormula" },
      { columnId: "fldUnknownUnsupported" },
      { columnId: "fldBarcodeUnsupported" },
      { columnId: "fldAuto" },
    ],
    columns: [
      { id: "fldOrderName", name: "Order", type: "text" },
      { id: "fldPaid", name: "Paid", type: "checkbox", typeOptions: { icon: "x", color: "red" } },
      { id: "fldAmount", name: "Amount percent", type: "number", default: 0.25, typeOptions: { format: "percent", precision: 2, negative: false, separatorFormat: "thinSpacePeriod" } },
      { id: "fldCurrency", name: "Currency", type: "currency", typeOptions: { symbol: "EUR", precision: 2, negative: true, separatorFormat: "spacePeriod" } },
      { id: "fldDuration", name: "Duration days", type: "number", typeOptions: { format: "durationInDays" } },
      { id: "fldDurationTenths", name: "Duration tenths", type: "number", typeOptions: { format: "duration", durationFormat: "h:mm:ss.s" } },
      { id: "fldDurationHundredths", name: "Duration hundredths", type: "number", typeOptions: { format: "duration", durationFormat: "h:mm:ss.ss" } },
      { id: "fldDueDate", name: "Due date", type: "date", default: "now", typeOptions: { dateFormat: "ISO", isDateTime: false } },
      { id: "fldUrl", name: "Website", type: "url" },
      { id: "fldPhone", name: "Phone", type: "phone" },
      { id: "fldRating", name: "Rating", type: "rating", typeOptions: { max: 5, color: "yellow", icon: "dot" } },
      { id: "fldOwner", name: "Owner", type: "collaborator" },
      { id: "fldTags", name: "Tags", type: "multiSelect", default: ["Gift"], typeOptions: { choices: {} } },
      { id: "fldCustomerLink", name: "Customer", type: "foreignKey", typeOptions: { foreignTableId: "tblCustomers" } },
      {
        id: "fldAltCustomerLink",
        name: "Alt customer",
        type: "multipleRecordLinks",
        typeOptions: {
          foreignTableId: "tblCustomers",
          relationship: "one",
          viewIdForRecordSelection: "viwCustomersGrid",
          filtersForRecordSelection: { conjunction: "and" },
          aiMatchingOptions: { enabled: true },
        },
      },
      { id: "fldCustomerCount", name: "Customer count", type: "count", typeOptions: { relationColumnId: "fldCustomerLink" } },
      {
        id: "fldCustomerEmailLookup",
        name: "Customer email lookup",
        type: "lookup",
        typeOptions: {
          relationColumnId: "fldCustomerLink",
          foreignTableRollupColumnId: "fldEmail",
          resultType: "text",
          resultIsArray: true,
        },
      },
      {
        id: "fldCustomerScoreRollup",
        name: "Customer score rollup",
        type: "rollup",
        typeOptions: {
          relationColumnId: "fldCustomerLink",
          foreignTableRollupColumnId: "fldCustomerScore",
          formulaTextParsed: "SUM(values)",
          resultType: "number",
          resultIsArray: false,
        },
      },
      { id: "fldBrokenCount", name: "Broken customer count", type: "count", typeOptions: { relationColumnId: "fldMissingLink" } },
      {
        id: "fldBrokenLookup",
        name: "Broken customer email lookup",
        type: "lookup",
        typeOptions: {
          relationColumnId: "fldMissingLink",
          foreignTableRollupColumnId: "fldEmail",
          resultType: "text",
          resultIsArray: true,
        },
      },
      {
        id: "fldBrokenRollup",
        name: "Broken customer score rollup",
        type: "rollup",
        typeOptions: {
          relationColumnId: "fldMissingLink",
          foreignTableRollupColumnId: "fldCustomerScore",
          formulaTextParsed: "SUM(values)",
          resultType: "number",
          resultIsArray: false,
        },
      },
      { id: "fldFiles", name: "Files", type: "multipleAttachment" },
      { id: "fldCreated", name: "Created", type: "formula", typeOptions: { displayType: "createdTime", isDateTime: true } },
      {
        id: "fldCreatedBy",
        name: "Created by",
        type: "computation",
        typeOptions: {
          resultType: "collaborator",
          resultIsArray: false,
          computationType: "createdBy",
          computationParams: {},
        },
      },
      {
        id: "fldLastModified",
        name: "Last modified",
        type: "formula",
        typeOptions: {
          displayType: "lastModifiedTime",
          isDateTime: false,
          dateFormat: "US",
          timeZone: "Europe/Amsterdam",
          timeFormat: "12hour",
          dependencies: { dependsOnAllColumnModifications: true },
          resultType: "date",
        },
      },
      {
        id: "fldLastModifiedSpecific",
        name: "Last modified specific fields",
        type: "formula",
        typeOptions: {
          displayType: "lastModifiedTime",
          isDateTime: true,
          dependencies: { dependsOnAllColumnModifications: false, columnIds: ["fldAmount"] },
          resultType: "date",
        },
      },
      {
        id: "fldLastModifiedBy",
        name: "Last modified by",
        type: "computation",
        typeOptions: {
          resultType: "collaborator",
          resultIsArray: false,
          computationType: "lastModifiedBy",
          computationParams: { allColumns: true, columnIds: [] },
          dependencies: { referencedColumnIdsForValue: [], dependsOnAllColumnModifications: true },
        },
      },
      {
        id: "fldCalculatedAmount",
        name: "Calculated amount",
        type: "formula",
        typeOptions: { displayType: "number", formulaTextParsed: "{Amount percent} * 2", resultType: "number" },
      },
      {
        id: "fldUnsupportedFormula",
        name: "Unsupported formula",
        type: "formula",
        typeOptions: { displayType: "number", formulaTextParsed: "AIRTABLE_ONLY({Amount percent})", resultType: "number" },
      },
      { id: "fldUnknownUnsupported", name: "Unknown unsupported", type: "mysteryField" },
      { id: "fldBarcodeUnsupported", name: "Barcode unsupported", type: "barcode" },
      { id: "fldAuto", name: "Auto", type: "autoNumber" },
    ],
    views: [
      { id: "viwOrdersGrid", name: "Orders grid", type: "grid" },
      { id: "viwOrdersGallery", name: "Orders gallery", type: "gallery" },
      { id: "viwOrdersForm", name: "Orders form", type: "form" },
      { id: "viwOrdersCalendar", name: "Orders calendar", type: "calendar" },
      { id: "viwOrdersTimeline", name: "Orders timeline", type: "timeline" },
    ],
    viewOrder: ["viwOrdersGrid", "viwOrdersGallery", "viwOrdersForm", "viwOrdersCalendar", "viwOrdersTimeline"],
  };
  const primarySelectTable = {
    id: "tblPrimarySelect",
    name: "Primary select",
    primaryColumnId: "fldPrimaryStatus",
    meaningfulColumnOrder: [{ columnId: "fldPrimaryStatus" }, { columnId: "fldPrimaryNotes" }],
    columns: [
      {
        id: "fldPrimaryStatus",
        name: "Stage",
        type: "select",
        typeOptions: {
          choices: {
            stageTodo: { id: "stageTodo", name: "Todo", color: "blue" },
            stageDone: { id: "stageDone", name: "Done", color: "green" },
          },
          choiceOrder: ["stageTodo", "stageDone"],
        },
        default: "stageDone",
      },
      { id: "fldPrimaryNotes", name: "Notes", type: "text" },
    ],
    views: [{ id: "viwPrimarySelectGrid", name: "Primary select grid", type: "grid" }],
    viewOrder: ["viwPrimarySelectGrid"],
  };
  const customersData = {
    id: "tblCustomers",
    rows: [
      {
        id: "recCust1",
        createdTime: "2026-01-01T00:00:00.000Z",
        cellValuesByColumnId: {
          fldCustomerName: "Acme",
          fldStatus: { id: "selActive", name: "Active" },
          fldEmail: "a@example.com",
          fldCustomerScore: 8,
          fldCustomerNotes: {
            documentValue: [
              { insert: "Important", attributes: { bold: true } },
              { insert: " customer\n", attributes: { header: 2 } },
              { insert: "Website", attributes: { link: "https://example.com/acme" } },
              { insert: "\n" },
              { insert: "Ship samples" },
              { insert: "\n", attributes: { list: "checked" } },
            ],
          },
        },
      },
      {
        id: "recCust2",
        createdTime: "2026-01-02T00:00:00.000Z",
        cellValuesByColumnId: { fldCustomerName: "Beta", fldStatus: "Lead", fldEmail: "b@example.com", fldCustomerScore: 3, fldCustomerNotes: null },
      },
    ],
    viewDatas: [
      {
        id: "viwCustomersGrid",
        columnOrder: [{ columnId: "fldCustomerName", width: 220 }, { columnId: "fldStatus", visibility: true }],
        metadata: { grid: { rowHeight: "small" } },
      },
      {
        id: "viwCustomersKanban",
        columnOrder: [{ columnId: "fldCustomerName", width: 220 }, { columnId: "fldStatus" }],
        metadata: { kanban: { stackColumnId: "fldStatus" } },
      },
    ],
  };
  const ordersData = {
    id: "tblOrders",
    signedUserContentUrls: { "https://files.airtable.test/ok.png": "https://signed.airtable.test/ok.png" },
    rows: [
      {
        id: "recOrder1",
        createdTime: "2026-02-01T00:00:00.000Z",
        cellValuesByColumnId: {
          fldOrderName: "Order one",
          fldPaid: true,
          fldAmount: 0.25,
          fldCurrency: 123.45,
          fldDuration: 2,
          fldDurationTenths: 1.2,
          fldDurationHundredths: 1.23,
          fldDueDate: "2026-03-01T15:45:30.000Z",
          fldUrl: "https://example.com/order-one",
          fldPhone: "+33123456789",
          fldRating: 4,
          fldOwner: [{ id: "usrAlice", name: "Alice Example", email: "alice@example.com" }],
          fldTags: [{ id: "tagUrgent", name: "Urgent" }, "Gift"],
          fldCustomerLink: [{ foreignRowId: "recCust1", foreignRowDisplayName: "Acme" }],
          fldAltCustomerLink: [{ foreignRowId: "recCust1", foreignRowDisplayName: "Acme" }],
          fldCustomerCount: 999,
          fldCustomerEmailLookup: { valuesByForeignRowId: { recCust1: "a@example.com" }, foreignRowIdOrder: ["recCust1"] },
          fldCustomerScoreRollup: 8,
          fldBrokenCount: 999,
          fldBrokenLookup: { valuesByForeignRowId: { recCust1: "a@example.com" }, foreignRowIdOrder: ["recCust1"] },
          fldBrokenRollup: 8,
          fldFiles: [{ id: "attOk", url: "https://files.airtable.test/ok.png", filename: "ok.png", type: "image/png", size: 3, width: 10, height: 20 }],
          fldCreated: "2026-02-01T00:00:00.000Z",
          fldCreatedBy: { id: "usrCreator", name: "Creator Example", email: "creator@example.com" },
          fldLastModified: "2026-02-03T14:51:00.000Z",
          fldLastModifiedSpecific: "2026-02-03T15:51:00.000Z",
          fldLastModifiedBy: { id: "usrEditor", name: "Editor Example", email: "editor@example.com" },
          fldCalculatedAmount: 0.5,
          fldUnsupportedFormula: 2,
          fldUnknownUnsupported: "must not become text",
          fldAuto: 10,
        },
      },
      {
        id: "recOrder2",
        createdTime: "2026-02-02T00:00:00.000Z",
        cellValuesByColumnId: {
          fldOrderName: "Order two",
          fldPaid: false,
          fldAmount: "INVALID_NUMBER",
          fldCurrency: 67.89,
          fldDuration: 86399999913601,
          fldDurationTenths: 2.3,
          fldDurationHundredths: 2.34,
          fldDueDate: "2026-02-31T08:15:00.000Z",
          fldUrl: "not a url",
          fldPhone: "call me maybe",
          fldRating: 5,
          fldOwner: [{ id: "usrBob", displayName: "Bob Example", email: "bob@example.com" }, { id: "usrAlice", name: "Alice Example", email: "alice@example.com" }],
          fldTags: ["Gift"],
          fldCustomerLink: [{ foreignRowId: "recCust2", foreignRowDisplayName: "Beta" }],
          fldAltCustomerLink: [{ foreignRowId: "recCust2", foreignRowDisplayName: "Beta" }],
          fldCustomerCount: 999,
          fldCustomerEmailLookup: { valuesByForeignRowId: { recCust2: "b@example.com" }, foreignRowIdOrder: ["recCust2"] },
          fldCustomerScoreRollup: 3,
          fldBrokenCount: 999,
          fldBrokenLookup: { valuesByForeignRowId: { recCust2: "b@example.com" }, foreignRowIdOrder: ["recCust2"] },
          fldBrokenRollup: 3,
          fldFiles: [{ id: "attDenied", url: "https://files.airtable.test/denied.pdf", filename: "denied.pdf", type: "application/pdf", size: 4 }],
          fldCreated: "2026-02-02T00:00:00.000Z",
          fldCreatedBy: { id: "usrCreator", name: "Creator Example", email: "creator@example.com" },
          fldLastModified: "2026-02-04T14:51:00.000Z",
          fldLastModifiedSpecific: "2026-02-04T15:51:00.000Z",
          fldLastModifiedBy: { id: "usrBob", displayName: "Bob Example", email: "bob@example.com" },
          fldCalculatedAmount: 1,
          fldUnsupportedFormula: 2,
          fldUnknownUnsupported: "must not become text",
          fldAuto: 11,
        },
      },
    ],
    viewDatas: [
      {
        id: "viwOrdersGrid",
        columnOrder: [{ columnId: "fldOrderName", width: 240 }, { columnId: "fldTags", visibility: false }, { columnId: "fldFiles" }],
        metadata: { grid: { rowHeight: "medium" } },
        lastSortsApplied: { sortSet: [{ columnId: "fldOrderName", ascending: true }] },
        groupLevels: [{ columnId: "fldTags", order: "ascending" }],
        filters: {
          conjunction: "and",
          filterSet: [
            { id: "fltPaid", columnId: "fldPaid", operator: "=", value: true },
            { id: "fltOwner", columnId: "fldOwner", operator: "=", value: { id: "usrAlice", name: "Alice Example", email: "alice@example.com" } },
          ],
        },
      },
      {
        id: "viwOrdersGallery",
        columnOrder: [{ columnId: "fldFiles", visibility: true }],
        metadata: { gallery: { coverColumnId: "fldFiles" } },
      },
      {
        id: "viwOrdersForm",
        metadata: {
          form: {
            title: "Order intake",
            description: "Public order form",
            submitText: "Send order",
            confirmationMessage: "Order received",
            fieldOrder: ["fldOrderName", "fldPaid", "fldFiles", "fldCreated"],
            fieldOptionsByColumnId: {
              fldOrderName: { label: "Order", required: true },
              fldPaid: { hidden: true },
              fldFiles: { helpText: "Attach documents" },
            },
          },
        },
      },
      {
        id: "viwOrdersCalendar",
        columnOrder: [{ columnId: "fldOrderName", width: 240 }, { columnId: "fldDueDate" }],
        metadata: { calendar: { dateColumnId: "fldDueDate" } },
      },
      {
        id: "viwOrdersTimeline",
        columnOrder: [{ columnId: "fldOrderName", width: 240 }, { columnId: "fldDueDate" }, { columnId: "fldLastModified" }],
        metadata: { timeline: { startDateColumnId: "fldDueDate", endDateColumnId: "fldLastModified", timescale: "month" } },
      },
    ],
  };
  const primarySelectData = {
    id: "tblPrimarySelect",
    rows: [
      {
        id: "recPrimary1",
        createdTime: "2026-04-01T00:00:00.000Z",
        cellValuesByColumnId: { fldPrimaryStatus: { id: "stageTodo", name: "Todo" }, fldPrimaryNotes: "Keep primary select typed" },
      },
    ],
    viewDatas: [
      {
        id: "viwPrimarySelectGrid",
        columnOrder: [{ columnId: "fldPrimaryStatus", width: 180 }, { columnId: "fldPrimaryNotes", width: 240 }],
        metadata: { grid: { rowHeight: "small" } },
      },
    ],
  };
  const schema = { appBlanket: true, tableSchemas: [customersTable, ordersTable, primarySelectTable], tableDatas: [customersData] };
  return { initData, schema, customersData, ordersData, primarySelectData };
}

function baserowAirtableBasicFixture(fileName: string): string {
  const sourceDir = process.env.BASEROW_SOURCE_DIR || "/Users/appmonster/Workspace/baserow";
  return readFileSync(join(sourceDir, "backend/tests/airtable_responses/basic", fileName), "utf8");
}

function baserowAirtableBasicJson(fileName: string): unknown {
  return JSON.parse(baserowAirtableBasicFixture(fileName));
}

async function withAirtableFetchFixture<T>(
  fn: (calls: string[]) => Promise<T>,
  fixture = airtableFixture()
): Promise<T> {
  const calls: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://airtable.com/appFixture") {
      return new Response(`<html><script>requestId: "reqFixture",</script><script>window.initData = ${JSON.stringify(fixture.initData)};\n</script></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.startsWith("https://airtable.com/v0.3/application/appFixture/read")) return jsonResponse({ data: fixture.schema });
    if (url.startsWith("https://airtable.com/v0.3/table/tblOrders/readData")) return jsonResponse({ data: fixture.ordersData });
    if (url.startsWith("https://airtable.com/v0.3/table/tblPrimarySelect/readData")) return jsonResponse({ data: fixture.primarySelectData });
    if (url === "https://signed.airtable.test/ok.png") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png", "content-length": "3" } });
    }
    if (url.startsWith("https://files.airtable.test/denied.pdf") || url.includes("/downloadAttachment")) {
      return new Response("denied", { status: 403 });
    }
    throw new Error(`Unexpected Airtable fixture request: ${url}`);
  });
  try {
    return await fn(calls);
  } finally {
    fetchMock.mockRestore();
  }
}

function airtableRequestParams(url: string): Record<string, any> {
  const raw = new URL(url).searchParams.get("stringifiedObjectParams") || "{}";
  return JSON.parse(raw);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Airtable import mapping", () => {
  const tableMap = new Map<string, unknown>([["tblCustomers", {}]]);

  it("preserves Airtable cookies across shared-base redirects and API requests", async () => {
    const fixture = airtableFixture();
    const db = createTestD1();
    const apiRequests: Request[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://airtable.com/appFixture") {
        expect(new Request(url, init).headers.get("user-agent")).toBe("OpenTabl-Airtable-Importer/1.0");
        return new Response(null, {
          status: 302,
          headers: { location: "/appFixture/canonical", "set-cookie": "route_cookie=first; Path=/; Secure" },
        });
      }
      if (url === "https://airtable.com/appFixture/canonical") {
        return new Response(`<html><script>requestId: "reqFixture",</script><script>window.initData = ${JSON.stringify(fixture.initData)};\n</script></html>`, {
          status: 200,
          headers: { "content-type": "text/html", "set-cookie": "base_cookie=second; Path=/; Secure" },
        });
      }
      const request = new Request(url, init);
      apiRequests.push(request);
      if (url.startsWith("https://airtable.com/v0.3/application/appFixture/read")) return jsonResponse({ data: fixture.schema });
      if (url.startsWith("https://airtable.com/v0.3/table/tblOrders/readData")) return jsonResponse({ data: fixture.ordersData });
      if (url.startsWith("https://airtable.com/v0.3/table/tblPrimarySelect/readData")) return jsonResponse({ data: fixture.primarySelectData });
      throw new Error(`Unexpected redirected Airtable fixture request: ${url}`);
    });
    try {
      const result = await importAirtableBase({
        DB: db as any,
        FILES: { put: vi.fn(async () => ({})) },
        JOBS_QUEUE: { send: vi.fn(async () => undefined) },
        PUBLIC_URL: "https://opentabl.test",
      } as any, {
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
        skip_files: true,
      }, 7);
      expect(result.database.id).toEqual(expect.any(Number));
      expect(apiRequests.length).toBeGreaterThan(0);
      for (const request of apiRequests) {
        expect(request.headers.get("cookie")).toContain("route_cookie=first");
        expect(request.headers.get("cookie")).toContain("base_cookie=second");
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses Cloudflare Browser Rendering when Airtable redirects Worker HTTP egress to login", async () => {
    const fixture = airtableFixture();
    const db = createTestD1();
    const apiRequests: Request[] = [];
    const browserClose = vi.fn(async () => undefined);
    let applicationRequestHandler: ((request: any) => void) | null = null;
    const page = {
      setCookie: vi.fn(async () => undefined),
      setUserAgent: vi.fn(async () => undefined),
      on: vi.fn((event: string, handler: (request: any) => void) => {
        if (event === "request") applicationRequestHandler = handler;
      }),
      goto: vi.fn(async () => {
        applicationRequestHandler?.({
          url: () => "https://airtable.com/v0.3/application/appFixture/read?requestId=reqBrowser&accessPolicy=%7B%7D&stringifiedObjectParams=%7B%22includeDataForTableIds%22%3A%5B%22tblCustomers%22%5D%7D",
          headers: () => ({
            "user-agent": "Modern Airtable Browser",
            "x-airtable-inter-service-client-code-version": "browser-code",
            "x-airtable-page-load-id": "browser-page",
          }),
        });
        return null;
      }),
      waitForFunction: vi.fn(async () => undefined),
      url: vi.fn(() => "https://airtable.com/appFixture"),
      title: vi.fn(async () => "Airtable - Fixture Airtable Base"),
      content: vi.fn(async () => `<html><script>requestId: "reqBrowser",</script></html>`),
      evaluate: vi.fn(async () => ({ initData: fixture.initData, requestId: "reqBrowser" })),
      cookies: vi.fn(async () => [{ name: "brw_browser", value: "browser-session" }]),
    };
    vi.spyOn(puppeteer, "launch").mockResolvedValue({
      newPage: vi.fn(async () => page),
      close: browserClose,
    } as any);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://airtable.com") {
        return new Response(null, { status: 200, headers: { "set-cookie": "anonymous_session=bootstrap; Path=/; Secure" } });
      }
      if (url === "https://airtable.com/appFixture") {
        return new Response(null, { status: 302, headers: { location: "/login" } });
      }
      const request = new Request(url, init);
      apiRequests.push(request);
      if (url.startsWith("https://airtable.com/v0.3/application/appFixture/read")) return jsonResponse({ data: fixture.schema });
      if (url.startsWith("https://airtable.com/v0.3/table/tblOrders/readData")) return jsonResponse({ data: fixture.ordersData });
      if (url.startsWith("https://airtable.com/v0.3/table/tblPrimarySelect/readData")) return jsonResponse({ data: fixture.primarySelectData });
      throw new Error(`Unexpected browser fallback Airtable fixture request: ${url}`);
    });
    try {
      const result = await importAirtableBase({
        DB: db as any,
        FILES: { put: vi.fn(async () => ({})) },
        JOBS_QUEUE: { send: vi.fn(async () => undefined) },
        BROWSER: { fetch: vi.fn() },
        PUBLIC_URL: "https://opentabl.test",
      } as any, {
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
        skip_files: true,
      }, 7);
      expect(result.database.id).toEqual(expect.any(Number));
      expect(page.goto).toHaveBeenCalledWith("https://airtable.com/appFixture", expect.any(Object));
      expect(browserClose).toHaveBeenCalledOnce();
      expect(apiRequests.length).toBeGreaterThan(0);
      for (const request of apiRequests) {
        expect(request.headers.get("cookie")).toContain("brw_browser=browser-session");
        expect(request.headers.get("user-agent")).toBe("Modern Airtable Browser");
        expect(new URL(request.url).searchParams.get("requestId")).toBe("reqBrowser");
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("bootstraps an anonymous Airtable session before treating a public base as authenticated", async () => {
    const fixture = airtableFixture();
    const db = createTestD1();
    let baseAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(input), init);
      if (request.url === "https://airtable.com/appFixture") {
        baseAttempts += 1;
        if (baseAttempts === 1) {
          return new Response(null, { status: 302, headers: { location: "/login" } });
        }
        expect(request.headers.get("cookie")).toContain("anonymous_session=bootstrap");
        return new Response(`<html><script>requestId: "reqFixture",</script><script>window.initData = ${JSON.stringify(fixture.initData)};\n</script></html>`, {
          status: 200,
        });
      }
      if (request.url === "https://airtable.com/") {
        return new Response(null, { status: 200, headers: { "set-cookie": "anonymous_session=bootstrap; Path=/; Secure" } });
      }
      if (request.url.startsWith("https://airtable.com/v0.3/application/appFixture/read")) return jsonResponse({ data: fixture.schema });
      if (request.url.startsWith("https://airtable.com/v0.3/table/tblOrders/readData")) return jsonResponse({ data: fixture.ordersData });
      if (request.url.startsWith("https://airtable.com/v0.3/table/tblPrimarySelect/readData")) return jsonResponse({ data: fixture.primarySelectData });
      throw new Error(`Unexpected anonymous session fixture request: ${request.url}`);
    });
    try {
      const result = await importAirtableBase({
        DB: db as any,
        FILES: { put: vi.fn(async () => ({})) },
        JOBS_QUEUE: { send: vi.fn(async () => undefined) },
        PUBLIC_URL: "https://opentabl.test",
      } as any, {
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
        skip_files: true,
      }, 7);
      expect(result.database.id).toEqual(expect.any(Number));
      expect(baseAttempts).toBe(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("copies large Airtable attachment imports through resumable queue batches before completing the parent job", async () => {
    const fixture = airtableFixture();
    fixture.ordersData.rows[0].cellValuesByColumnId.fldFiles = Array.from({ length: 21 }, (_, index) => ({
      id: `attQueued${index}`,
      url: "https://signed.airtable.test/ok.png",
      filename: `queued-${index}.png`,
      type: "image/png",
      size: 3,
      width: 10,
      height: 20,
    }));
    fixture.ordersData.rows[1].cellValuesByColumnId.fldFiles = [];
    const db = createTestD1();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_job (id, type, status, progress_percentage, user_id, created_on, updated_on)
       VALUES (99, 'airtable', 'running', 0, 7, ?, ?)`
    ).bind(now, now).run();
    const queuedMessages: any[] = [];
    const cache = new Map<string, string>();
    const env = {
      DB: db as any,
      FILES: { put: vi.fn(async () => ({})) },
      JOBS_QUEUE: {
        send: vi.fn(async (message: any) => { queuedMessages.push(message); }),
        sendBatch: vi.fn(async (messages: any[]) => { queuedMessages.push(...messages.map((message) => message.body)); }),
      },
      CACHE: {
        get: vi.fn(async (key: string) => cache.get(key) || null),
        put: vi.fn(async (key: string, value: string) => { cache.set(key, value); }),
        delete: vi.fn(async (key: string) => { cache.delete(key); }),
      },
      PUBLIC_URL: "https://opentabl.test",
    } as any;

    await withAirtableFetchFixture(async () => {
      const result = await importAirtableBase(env, {
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
        skip_files: false,
        _job_id: 99,
      } as any, 7);
      expect(result.pendingAttachmentCount).toBe(21);
      expect(queuedMessages).toHaveLength(1);

      let finalState = { complete: false, failed: 0, remaining: 21 };
      for (const message of [...queuedMessages]) {
        finalState = await processAirtableAttachmentTaskBatch(env, message);
      }
      expect(finalState).toEqual({ complete: true, failed: 0, remaining: 0 });

      const tasks = await db.prepare(
        "SELECT status, attempts FROM database_airtable_attachment_task WHERE job_id=99 ORDER BY id"
      ).all();
      expect(tasks.results).toHaveLength(21);
      expect(tasks.results.every((task: any) => task.status === "finished" && task.attempts === 1)).toBe(true);

      const applicationId = Number((result.database as any).id);
      const ordersTable = await db.prepare(
        "SELECT id FROM database_table WHERE database_id=? AND name='Orders'"
      ).bind(applicationId).first<any>();
      const fileField = await db.prepare(
        "SELECT id FROM database_field WHERE table_id=? AND name='Files'"
      ).bind(ordersTable.id).first<any>();
      const importedRow = await db.prepare(
        `SELECT "field_${fileField.id}" AS files FROM "database_table_${ordersTable.id}" ORDER BY id LIMIT 1`
      ).first<any>();
      const files = JSON.parse(importedRow.files);
      expect(files).toHaveLength(21);
      expect(files.every((file: any) => file.external !== true && file.url.startsWith("https://opentabl.test/") && !file.url.includes("airtable"))).toBe(true);
    }, fixture);
  });

  it("maps Airtable column types to Baserow field types without falling back to text", () => {
    expect(airtableTypeToBaserow({ type: "checkbox" }, false, tableMap as any)).toBe("boolean");
    expect(airtableTypeToBaserow({ type: "select", typeOptions: { choices: { selA: { id: "selA", name: "A" } } } }, false, tableMap as any)).toBe("single_select");
    expect(airtableTypeToBaserow({ type: "select", typeOptions: { choices: { selA: { id: "selA", name: "A" } } } }, true, tableMap as any)).toBe("single_select");
    expect(airtableTypeToBaserow({ type: "multiSelect", typeOptions: { choices: { selA: { id: "selA", name: "A" } } } }, false, tableMap as any)).toBe("multiple_select");
    expect(airtableTypeToBaserow({ type: "select", typeOptions: { choices: {} } }, false, tableMap as any)).toBe("single_select");
    expect(airtableTypeToBaserow({ type: "multipleSelect", typeOptions: { choices: {} } }, false, tableMap as any)).toBe("multiple_select");
    expect(airtableTypeToBaserow({ type: "multipleAttachment" }, false, tableMap as any)).toBe("file");
    expect(airtableTypeToBaserow({ type: "collaborator" }, false, tableMap as any)).toBe("multiple_collaborators");
    expect(airtableTypeToBaserow({ type: "foreignKey", typeOptions: { foreignTableId: "tblCustomers" } }, false, tableMap as any)).toBe("link_row");
    expect(airtableTypeToBaserow({ type: "multipleRecordLinks", typeOptions: { foreignTableId: "tblCustomers" } }, false, tableMap as any)).toBe("link_row");
    expect(airtableTypeToBaserow({ type: "lookup", typeOptions: { resultType: "text" } }, false, tableMap as any)).toBe("lookup");
    expect(airtableTypeToBaserow({ type: "rollup", typeOptions: { resultType: "number" } }, false, tableMap as any)).toBe("rollup");
    expect(airtableTypeToBaserow({ type: "number", typeOptions: { format: "duration" } }, false, tableMap as any)).toBe("duration");
    expect(airtableTypeToBaserow({ type: "createdTime" }, false, tableMap as any)).toBe("created_on");
    expect(airtableTypeToBaserow({ type: "lastModifiedTime" }, false, tableMap as any)).toBe("last_modified");
    expect(airtableTypeToBaserow({ type: "formula", typeOptions: { displayType: "createdTime" } }, false, tableMap as any)).toBe("created_on");
    expect(airtableTypeToBaserow({ type: "createdBy" }, false, tableMap as any)).toBe("created_by");
    expect(airtableTypeToBaserow({ type: "lastModifiedBy" }, false, tableMap as any)).toBe("last_modified_by");
    expect(airtableTypeToBaserow({ type: "computation", typeOptions: { computationType: "createdTime" } }, false, tableMap as any)).toBe("created_on");
    expect(airtableTypeToBaserow({ type: "computation", typeOptions: { computationType: "lastModifiedTime" } }, false, tableMap as any)).toBe("last_modified");
    expect(airtableTypeToBaserow({ type: "computation", typeOptions: { computationType: "createdBy", resultType: "collaborator" } }, false, tableMap as any)).toBe("created_by");
    expect(airtableTypeToBaserow({ type: "computation", typeOptions: { computationType: "lastModifiedBy", resultType: "collaborator" } }, false, tableMap as any)).toBe("last_modified_by");
    expect(airtableTypeToBaserow({ type: "formula", typeOptions: { displayType: "number", formulaTextParsed: "1 + 1" } }, false, tableMap as any)).toBe("formula");
    expect(airtableTypeToBaserow({ type: "formula", typeOptions: { displayType: "number", formulaTextParsed: "AIRTABLE_ONLY(1)" } }, false, tableMap as any)).toBe(null);
    expect(airtableTypeToBaserow({ type: "unknown" }, false, tableMap as any)).toBe(null);
  });

  it("keeps every Airtable column type registered by the Baserow source under contract", () => {
    const sourceDir = process.env.BASEROW_SOURCE_DIR || "/Users/appmonster/Workspace/baserow";
    const source = readFileSync(join(sourceDir, "backend/src/baserow/contrib/database/airtable/airtable_column_types.py"), "utf8");
    const registeredTypes = Array.from(source.matchAll(
      /class\s+\w+AirtableColumnType\(AirtableColumnType\):[\s\S]*?\n\s+type\s*=\s*"([^"]+)"/g
    )).map((match) => match[1]);
    expect(registeredTypes).toEqual([
      "text",
      "multilineText",
      "richText",
      "number",
      "rating",
      "checkbox",
      "date",
      "formula",
      "foreignKey",
      "multipleAttachment",
      "select",
      "multiSelect",
      "phone",
      "count",
      "autoNumber",
    ]);

    const sourceCases: Array<[any, string]> = [
      [{ type: "text" }, "text"],
      [{ type: "text", typeOptions: { validatorName: "url" } }, "url"],
      [{ type: "text", typeOptions: { validatorName: "email" } }, "email"],
      [{ type: "multilineText" }, "long_text"],
      [{ type: "richText" }, "long_text"],
      [{ type: "number" }, "number"],
      [{ type: "number", typeOptions: { format: "duration" } }, "duration"],
      [{ type: "rating" }, "rating"],
      [{ type: "checkbox" }, "boolean"],
      [{ type: "date" }, "date"],
      [{ type: "formula", typeOptions: { displayType: "createdTime" } }, "created_on"],
      [{ type: "formula", typeOptions: { displayType: "lastModifiedTime" } }, "last_modified"],
      [{ type: "foreignKey", typeOptions: { foreignTableId: "tblCustomers" } }, "link_row"],
      [{ type: "multipleAttachment" }, "file"],
      [{ type: "select" }, "single_select"],
      [{ type: "multiSelect" }, "multiple_select"],
      [{ type: "phone" }, "phone_number"],
      [{ type: "count" }, "count"],
      [{ type: "autoNumber" }, "autonumber"],
    ];
    for (const [column, expected] of sourceCases) {
      expect(airtableTypeToBaserow(column, false, tableMap as any), JSON.stringify(column)).toBe(expected);
    }
  });

  it("imports all documented Airtable rollup functions as live computed fields with valid Baserow editor values", async () => {
    const fixture = airtableFixture();
    const ordersTable = fixture.schema.tableSchemas.find((table: any) => table.id === "tblOrders");
    const formulas = [
      ["AND", "AND(values)"],
      ["ARRAYCOMPACT", "ARRAYCOMPACT(values)"],
      ["ARRAYFLATTEN", "ARRAYFLATTEN(values)"],
      ["ARRAYJOIN", 'ARRAYJOIN(values, "; ")'],
      ["ARRAYSLICE", "ARRAYSLICE(values, 1, 1)"],
      ["ARRAYUNIQUE", "ARRAYUNIQUE(values)"],
      ["AVERAGE", "AVERAGE(values)"],
      ["CONCATENATE", "CONCATENATE(values)"],
      ["COUNT", "COUNT(values)"],
      ["COUNTA", "COUNTA(values)"],
      ["COUNTALL", "COUNTALL(values)"],
      ["MAX", "MAX(values)"],
      ["MIN", "MIN(values)"],
      ["OR", "OR(values)"],
      ["SUM", "SUM(values)"],
      ["XOR", "XOR(values)"],
    ];
    for (const [name, formula] of formulas) {
      ordersTable.columns.push({
        id: `fldRollup${name}`,
        name: `Rollup ${name}`,
        type: "rollup",
        typeOptions: {
          relationColumnId: "fldCustomerLink",
          foreignTableRollupColumnId: "fldCustomerScore",
          formulaTextParsed: formula,
          resultType: ["AND", "OR", "XOR"].includes(name) ? "boolean" : "number",
        },
      });
    }

    await withAirtableFetchFixture(async () => {
      const db = createTestD1();
      const env = {
        DB: db as any,
        FILES: { put: vi.fn(async () => ({})) },
        JOBS_QUEUE: { send: vi.fn(async () => undefined) },
        PUBLIC_URL: "https://opentabl.test",
      };
      const result = await importAirtableBase(env as any, {
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
      }, 7);
      const applicationId = Number((result.database as any).id);
      const orders = await db.prepare("SELECT id FROM database_table WHERE database_id=? AND name='Orders'").bind(applicationId).first<any>();
      const fields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order]").bind(orders.id).all()).results;
      const byName = new Map(fields.map((field: any) => [field.name, field]));
      const rows = (await db.prepare(`SELECT * FROM "database_table_${orders.id}" ORDER BY [order]`).all()).results;
      const validBaserowFunctions = new Set(["any", "every", "count", "sum", "avg", "min", "max"]);

      for (const [name] of formulas) {
        const field: any = byName.get(`Rollup ${name}`);
        expect(field?.type, name).toBe("rollup");
        const settings = JSON.parse(field.field_settings);
        expect(validBaserowFunctions.has(settings.rollup_function), name).toBe(true);
        expect(rows[0][`field_${field.id}`], name).not.toBeNull();
      }
      expect(rows[0][`field_${(byName.get("Rollup COUNTALL") as any).id}`]).toBe("n:1");
      expect(rows[0][`field_${(byName.get("Rollup ARRAYJOIN") as any).id}`]).toBe("8");
      expect(JSON.parse(rows[0][`field_${(byName.get("Rollup ARRAYUNIQUE") as any).id}`])).toEqual([8]);
      expect(Number(rows[0][`field_${(byName.get("Rollup AND") as any).id}`])).toBe(1);
    }, fixture);
  });

  it("keeps Airtable select labels and colors instead of exposing choice ids", () => {
    const options = choiceList({
      typeOptions: {
        choiceOrder: ["selB", "selA", "selC"],
        choices: {
          selA: { id: "selA", name: "Alpha", color: "blue" },
          selB: { id: "selB", name: "Beta", color: "cyan" },
          selC: { id: "selC", name: "Gamma", color: "teal" },
        },
      },
    });
    expect(options).toEqual([
      { id: "selB", name: "Beta", color: "light-cyan" },
      { id: "selA", name: "Alpha", color: "light-blue" },
      { id: "selC", name: "Gamma", color: "light-pink" },
    ]);

    const field = {
      selectOptions: new Map([
        ["selA", { id: 10, value: "Alpha", color: "light-blue" }],
        ["selB", { id: 11, value: "Beta", color: "light-cyan" }],
      ]),
    };
    expect(normalizeSelectValue("selA", field as any, false)).toEqual({ id: 10, value: "Alpha", color: "light-blue" });
    expect(normalizeSelectValue(["selB", { id: "selA" }], field as any, true)).toEqual([
      { id: 11, value: "Beta", color: "light-cyan" },
      { id: 10, value: "Alpha", color: "light-blue" },
    ]);
  });

  it("resolves Airtable select cells by object choice keys when choice objects omit ids", () => {
    const options = choiceList({
      typeOptions: {
        choiceOrder: ["selActive", "selLead"],
        choices: {
          selActive: { name: "Active", color: "green" },
          selLead: { name: "Lead", color: "blue" },
        },
      },
    });
    expect(options).toEqual([
      { id: "selActive", name: "Active", color: "light-green" },
      { id: "selLead", name: "Lead", color: "light-blue" },
    ]);

    const field = {
      selectOptions: new Map([
        ["selActive", { id: 11, value: "Active", color: "light-green" }],
        ["selLead", { id: 12, value: "Lead", color: "light-blue" }],
      ]),
    };
    expect(normalizeSelectValue("selActive", field as any, false)).toEqual({ id: 11, value: "Active", color: "light-green" });
  });

  it("resolves Airtable select cells from enriched choice payloads without leaking technical ids", () => {
    const field = {
      selectOptions: new Map([
        ["selActive", { id: 11, value: "Active", color: "light-green" }],
        ["selLead", { id: 12, value: "Lead", color: "light-blue" }],
      ]),
    };

    expect(normalizeSelectValue({ choiceId: "selActive", label: "Active" }, field as any, false))
      .toEqual({ id: 11, value: "Active", color: "light-green" });
    expect(normalizeSelectValue({ value: "selLead", text: "Lead" }, field as any, false))
      .toEqual({ id: 12, value: "Lead", color: "light-blue" });
    expect(normalizeSelectValue({ id: "airtable-id-only", displayName: "Lead" }, field as any, false))
      .toEqual({ id: 12, value: "Lead", color: "light-blue" });
  });

  it("builds missing select options from Airtable row values", () => {
    const column = airtableColumnWithRuntimeChoices({
      id: "fldStatus",
      type: "select",
      typeOptions: { choices: {} },
    }, [
      { cellValuesByColumnId: { fldStatus: { id: "selA", name: "Alpha" } } },
      { cellValuesByColumnId: { fldStatus: "Beta" } },
      { cellValuesByColumnId: { fldStatus: { choiceId: "selC", label: "Gamma" } } },
      { cellValuesByColumnId: { fldStatus: { id: "selA", name: "Alpha" } } },
    ]);

    expect(choiceList(column)).toEqual([
      { id: "selA", name: "Alpha", color: "light-blue" },
      { id: "Beta", name: "Beta", color: "light-blue" },
      { id: "selC", name: "Gamma", color: "light-blue" },
    ]);
    expect(normalizeSelectValue("selA", {
      selectOptions: new Map([
        ["selA", { id: 10, value: "Alpha", color: "blue" }],
        ["Beta", { id: 11, value: "Beta", color: "blue" }],
      ]),
    } as any, false)).toEqual({ id: 10, value: "Alpha", color: "blue" });
  });

  it("keeps duplicated Airtable select option ids isolated per field", () => {
    const firstChoices = choiceList({
      id: "fldFirst",
      type: "select",
      typeOptions: {
        choiceOrder: ["selShared", "selOther"],
        choices: {
          selShared: { id: "selShared", name: "First label", color: "blue" },
          selOther: { id: "selOther", name: "First other", color: "cyan" },
        },
      },
    });
    const secondChoices = choiceList({
      id: "fldSecond",
      type: "select",
      typeOptions: {
        choiceOrder: ["selShared", "selOther"],
        choices: {
          selShared: { id: "selShared", name: "Second label", color: "blue" },
          selOther: { id: "selOther", name: "Second other", color: "cyan" },
        },
      },
    });
    const firstField = {
      selectOptions: new Map(firstChoices.map((choice, index) => [
        String(choice.id),
        { id: 100 + index, value: choice.name, color: choice.color },
      ])),
    };
    const secondField = {
      selectOptions: new Map(secondChoices.map((choice, index) => [
        String(choice.id),
        { id: 200 + index, value: choice.name, color: choice.color },
      ])),
    };

    expect(normalizeSelectValue("selShared", firstField as any, false)).toEqual({
      id: 100,
      value: "First label",
      color: "light-blue",
    });
    expect(normalizeSelectValue("selShared", secondField as any, false)).toEqual({
      id: 200,
      value: "Second label",
      color: "light-blue",
    });
  });

  it("normalizes primitive Airtable values by target Baserow type", async () => {
    const report = { addFailed: vi.fn() };
    const ctx = { rowLookups: new Map(), report };
    await expect(normalizeCellValue(0.25, { type: "number", settings: { number_suffix: "%" } } as any, false, ctx as any, {}))
      .resolves.toBe(25);
    await expect(normalizeCellValue(-0.25, { type: "number", settings: { number_suffix: "%", number_negative: false } } as any, false, ctx as any, {}))
      .resolves.toBe(null);
    await expect(normalizeCellValue("", { type: "number", settings: { number_default: 25 } } as any, false, ctx as any, {}))
      .resolves.toBe(null);
    await expect(normalizeCellValue("   ", { type: "number" } as any, false, ctx as any, {}))
      .resolves.toBe(null);
    await expect(normalizeCellValue("INVALID_NUMBER", {
      type: "number",
      airtableColumn: { name: "Amount", tableName: "Orders" },
    } as any, false, ctx as any, { id: "recBad" })).resolves.toBe(null);
    expect(report.addFailed).toHaveBeenCalledWith(
      'Row: "Row recBad", field: "Amount"',
      "Cell",
      "Orders",
      "Data type mismatch",
      'Cell value was left empty because the numeric value INVALID_NUMBER could not be parsed"'
    );
    await expect(normalizeCellValue(3661, { type: "duration" } as any, false, ctx as any, {}))
      .resolves.toBe(3661);
    await expect(normalizeCellValue("", { type: "duration" } as any, false, ctx as any, {}))
      .resolves.toBe(null);
    await expect(normalizeCellValue(86399999913601, { type: "duration" } as any, false, ctx as any, {}))
      .resolves.toBe(null);
    expect(report.addFailed).toHaveBeenCalledWith(
      'Row: "Row", field: "Duration"',
      "Cell",
      "",
      "Data type mismatch",
      'Cell value was left empty because the duration seconds 86399999913601 is outside the -86399999913600 and 86399999913600 range."'
    );
    await expect(normalizeCellValue(2, {
      type: "duration",
      airtableColumn: { typeOptions: { format: "durationInDays" } },
    } as any, false, ctx as any, {})).resolves.toBe(172800);
    await expect(normalizeCellValue(4, { type: "rating" } as any, false, ctx as any, {}))
      .resolves.toBe(4);
    await expect(normalizeCellValue("", { type: "rating" } as any, false, ctx as any, {}))
      .resolves.toBe(null);
    await expect(normalizeCellValue(null, { type: "boolean", settings: { boolean_default: true } } as any, false, ctx as any, {}))
      .resolves.toBe(false);
    await expect(normalizeCellValue(null, { type: "text", settings: { text_default: "Default text" } } as any, false, ctx as any, {}))
      .resolves.toBe("");
    await expect(normalizeCellValue(null, { type: "url" } as any, false, ctx as any, {}))
      .resolves.toBe("");
    await expect(normalizeCellValue(undefined, { type: "email" } as any, false, ctx as any, {}))
      .resolves.toBe("");
    await expect(normalizeCellValue(null, { type: "phone_number" } as any, false, ctx as any, {}))
      .resolves.toBe("");
    await expect(normalizeCellValue("2026-03-01T15:45:30.000Z", {
      type: "date",
      settings: { date_include_time: false },
    } as any, false, ctx as any, {})).resolves.toBe("2026-03-01");
    await expect(normalizeCellValue("2026-03-01T15:45:30.000Z", {
      type: "date",
      settings: { date_include_time: true },
    } as any, false, ctx as any, {})).resolves.toBe("2026-03-01T15:45:30+00:00");
    await expect(normalizeCellValue("2026-03-01T15:45:30.828Z", {
      type: "date",
      settings: { date_include_time: true },
    } as any, false, ctx as any, {})).resolves.toBe("2026-03-01T15:45:30.828000+00:00");
    await expect(normalizeCellValue("2026-02-31T15:45:30.000Z", {
      type: "date",
      settings: { date_include_time: false },
      airtableColumn: { name: "Due date", tableName: "Orders" },
    } as any, false, ctx as any, { id: "recBadDate" })).resolves.toBe(null);
    expect(report.addFailed).toHaveBeenCalledWith(
      'Row: "Row recBadDate", field: "Due date"',
      "Cell",
      "Orders",
      "Data type mismatch",
      expect.stringContaining("datetime validation")
    );
    await expect(normalizeCellValue(null, { type: "created_on" } as any, false, ctx as any, { createdTime: "2026-03-01T15:45:30.000Z" }))
      .resolves.toBe("2026-03-01T15:45:30+00:00");
    await expect(normalizeCellValue(null, { type: "created_on" } as any, false, ctx as any, { createdTime: "2026-03-01T15:45:30.828Z" }))
      .resolves.toBe("2026-03-01T15:45:30.828000+00:00");
    await expect(normalizeCellValue("2026-03-02T08:15:00.000Z", { type: "last_modified" } as any, false, ctx as any, {}))
      .resolves.toBe("2026-03-02T08:15:00+00:00");
    await expect(normalizeCellValue("https://example.com/path", { type: "url" } as any, false, ctx as any, {}))
      .resolves.toBe("https://example.com/path");
    await expect(normalizeCellValue("not a url", { type: "url", airtableColumn: { name: "Website", tableName: "Orders" } } as any, false, ctx as any, { id: "recBadUrl" }))
      .resolves.toBe("");
    expect(report.addFailed).toHaveBeenCalledWith(
      'Row: "Row recBadUrl", field: "Website"',
      "Cell",
      "Orders",
      "Data type mismatch",
      expect.stringContaining("email or URL validation")
    );
    await expect(normalizeCellValue("josé@example.com", { type: "email" } as any, false, ctx as any, {}))
      .resolves.toBe("josé@example.com");
    await expect(normalizeCellValue("not an email", { type: "email", airtableColumn: { name: "Email", tableName: "Customers" } } as any, false, ctx as any, { id: "recBadEmail" }))
      .resolves.toBe("");
    expect(report.addFailed).toHaveBeenCalledWith(
      'Row: "Row recBadEmail", field: "Email"',
      "Cell",
      "Customers",
      "Data type mismatch",
      expect.stringContaining("email or URL validation")
    );
    await expect(normalizeCellValue("+33 (0)1 23 45 67 89", { type: "phone_number" } as any, false, ctx as any, {}))
      .resolves.toBe("+33 (0)1 23 45 67 89");
    await expect(normalizeCellValue("call me maybe", { type: "phone_number", airtableColumn: { name: "Phone", tableName: "Orders" } } as any, false, ctx as any, { id: "recBadPhone" }))
      .resolves.toBe("");
    expect(report.addFailed).toHaveBeenCalledWith(
      'Row: "Row recBadPhone", field: "Phone"',
      "Cell",
      "Orders",
      "Data type mismatch",
      expect.stringContaining("phone number validation")
    );
    await expect(normalizeCellValue([{ id: "usrAlice", name: "Alice Example", email: "alice@example.com" }], { type: "multiple_collaborators" } as any, false, ctx as any, {}))
      .resolves.toEqual([expect.objectContaining({ name: "Alice Example", email: "alice@example.com", airtable_id: "usrAlice", external: true })]);
    await expect(normalizeCellValue(
      { valuesByForeignRowId: { rec1: "a@example.com", rec2: "b@example.com" }, foreignRowIdOrder: ["rec2", "rec1"] },
      { type: "lookup" } as any,
      false,
      ctx as any,
      {}
    )).resolves.toEqual(["b@example.com", "a@example.com"]);
    await expect(normalizeCellValue(
      { value: "recTechnicalId", text: "Readable lookup label" },
      { type: "lookup" } as any,
      false,
      ctx as any,
      {}
    )).resolves.toEqual(["Readable lookup label"]);
    await expect(normalizeCellValue(999, { type: "count", settings: { through_field_id: 1 } } as any, false, ctx as any, {}))
      .resolves.toBe(null);
    await expect(normalizeCellValue(12, { type: "rollup", settings: { formula_type: "number" } } as any, false, ctx as any, {}))
      .resolves.toBe(12);
    await expect(normalizeCellValue("", { type: "rollup", settings: { formula_type: "number" } } as any, false, ctx as any, {}))
      .resolves.toBe(null);
    expect(primitiveText({ foreignRowDisplayName: "Readable label", id: "rec123" })).toBe("Readable label");
    expect(primitiveText({ value: "rec123", text: "Readable label" })).toBe("Readable label");
  });

  it("drops Airtable link rows without a real mapped foreign row id", async () => {
    const failures: unknown[][] = [];
    const ctx = {
      rowLookups: new Map([
        ["tblCustomers", new Map([
          ["recCust1", { id: 1, value: "Acme" }],
          ["recCust2", { id: 2, value: "Beta" }],
          ["recCust3", { id: 3, value: "Gamma" }],
          ["recCust4", { id: 4, value: "Delta" }],
          ["recCust5", { id: 5, value: "Epsilon" }],
          ["recCust6", { id: 6, value: "Zeta" }],
        ])],
      ]),
      report: {
        addFailed: (...args: unknown[]) => failures.push(args),
      },
    };

    await expect(normalizeCellValue([
      { foreignRowId: "recCust1", foreignRowDisplayName: "Acme" },
      { id: "recCust2", name: "Beta" },
      { recordId: "recCust3", displayName: "Gamma" },
      { linkedRecordId: "recCust4", title: "Delta" },
      { value: "recCust5", text: "Epsilon" },
      { foreignRowDisplayName: "Display only must not become id null" },
      { foreignRowId: "recMissing", foreignRowDisplayName: "Missing" },
      "recCust6",
    ], {
      type: "link_row",
      targetAirtableTableId: "tblCustomers",
      airtableColumnId: "fldCustomerLink",
      airtableColumn: { name: "Customer", tableName: "Orders" },
    } as any, false, ctx as any, {
      id: "recOrder1",
      cellValuesByColumnId: { fldOrderName: "Order one" },
    })).resolves.toEqual([
      { id: 1, value: "Acme" },
      { id: 2, value: "Beta" },
      { id: 3, value: "Gamma" },
      { id: 4, value: "Delta" },
      { id: 5, value: "Epsilon" },
      { id: 6, value: "Zeta" },
    ]);
    expect(failures).toHaveLength(1);
    expect(String(failures[0][4])).toContain('Foreign row id "recMissing"');
  });

  it("converts Airtable rich text Quill document values to Baserow markdown", () => {
    expect(quillToMarkdown([
      { insert: "Title" },
      { insert: "\n", attributes: { header: 1 } },
      { insert: "Bold", attributes: { bold: true } },
      { insert: " and " },
      { insert: "linked", attributes: { link: "https://example.com" } },
      { insert: "\n" },
      { insert: "Task" },
      { insert: "\n", attributes: { list: "unchecked", indent: 1 } },
      { insert: "code" },
      { insert: "\n", attributes: { "code-block": true } },
    ])).toBe("# Title\n**Bold** and [linked](https://example.com)\n    - [ ] Task\n```\ncode\n```");
    expect(primitiveText({
      documentValue: [
        { insert: { mention: { userId: "usrAlice" } } },
        { insert: "\n", attributes: { blockquote: true } },
      ],
    })).toBe("> @usrAlice");
  });

  it("uses the Baserow Airtable attachment filename convention without URL tokens", () => {
    expect(airtableAttachmentFileName({
      id: "att1",
      url: "https://dl.airtable.com/.attachments/hash/part/file-sample.pdf?token=secret",
      filename: "file-sample.pdf",
    })).toBe("hash_part_file-sample.pdf");
  });

  it("downloads Airtable attachments from the original endpoint instead of thumbnail URLs", async () => {
    const db = createTestD1();
    const requestedUrls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/downloadAttachment")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": "4" },
        });
      }
      return new Response(new Uint8Array([9]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "1" },
      });
    });
    const storedFiles: any[] = [];
    const ctx = {
      env: {
        DB: db as any,
        FILES: {
          put: vi.fn(async (key: string, body: unknown, options: unknown) => {
            storedFiles.push({ key, body, options });
            return {};
          }),
        },
        PUBLIC_URL: "https://opentabl.test",
        JWT_SIGNING_KEY: "test-secret",
        SECRET_KEY: "test-secret",
        BASEROW_SERVE_FILES_THROUGH_BACKEND: "true",
        BASEROW_SERVE_FILES_THROUGH_BACKEND_PERMISSION: "DISABLED",
        BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS: "0",
      },
      workspaceId: 1,
      userId: 7,
      init: {
        requestId: "reqFixture",
        initData: {
          rawApplications: { appFixture: {} },
          accessPolicy: "{}",
          codeVersion: "fixture",
          pageLoadId: "pageFixture",
        },
        cookie: "",
      },
      rowLookups: new Map(),
      failedAttachmentCount: 0,
      report: { addFailed: vi.fn() },
    };

    const files = await normalizeCellValue([
      {
        id: "attPdf",
        filename: "contract.pdf",
        type: "application/pdf",
        size: 4,
        thumbnails: { large: { url: "https://thumb.airtable.test/large.png" } },
      },
    ], {
      type: "file",
      airtableColumnId: "fldFile",
      airtableColumn: { name: "Contract", tableName: "Docs" },
    } as any, false, ctx as any, { id: "recPdf" }) as any[];

    fetchMock.mockRestore();
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("/downloadAttachment");
    expect(requestedUrls[0]).not.toContain("thumb.airtable.test");
    expect(storedFiles).toHaveLength(1);
    expect(storedFiles[0].key).toMatch(/^user_files\/[a-f0-9]{32}_[a-f0-9]{64}\.pdf$/);
    expect(storedFiles[0].key).not.toContain("large.png");
    expect((storedFiles[0].options as any).customMetadata).toMatchObject({
      originalName: "contract.pdf",
    });
    expect(files[0]).toMatchObject({
      visible_name: "contract.pdf",
      mime_type: "application/pdf",
      size: 4,
    });
    expect(files[0].original_name).toBeUndefined();
    expect(files[0].url).toContain("https://opentabl.test/api/files/");
    expect(files[0].url).not.toContain("/media/");
  });

  it("retries the authenticated Airtable attachment endpoint with the Baserow request contract", async () => {
    const db = createTestD1();
    const endpointRequests: Request[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/downloadAttachment")) throw new Error(`Unexpected attachment request: ${url}`);
      endpointRequests.push(new Request(url, init));
      if (endpointRequests.length < 3) return new Response("temporary", { status: 503 });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          "content-type": "application/pdf",
          "content-length": "3",
          "content-range": "bytes 0-2/3",
        },
      });
    });
    const ctx = {
      env: {
        DB: db as any,
        FILES: { put: vi.fn(async () => ({})) },
        PUBLIC_URL: "https://opentabl.test",
      },
      workspaceId: 1,
      userId: 7,
      init: {
        requestId: "reqAttachment",
        initData: {
          rawApplications: { appAttachment: {} },
          accessPolicy: JSON.stringify({ allowedActions: [{ action: "downloadAttachment" }] }),
          codeVersion: "codeAttachment",
          pageLoadId: "pageAttachment",
        },
        cookie: "brw=session-value; other=value",
      },
      rowLookups: new Map(),
      failedAttachmentCount: 0,
      report: { addFailed: vi.fn() },
    };

    const files = await normalizeCellValue([{
      id: "attRetry",
      filename: "retry.pdf",
      type: "application/pdf",
      size: 3,
    }], {
      type: "file",
      airtableColumnId: "fldFile",
      airtableColumn: { name: "Files", tableName: "Documents" },
    } as any, false, ctx as any, { id: "recRetry" }) as any[];

    fetchMock.mockRestore();
    expect(endpointRequests).toHaveLength(3);
    const finalRequest = endpointRequests[2];
    expect(finalRequest.url).toContain("/v0.3/row/recRetry/downloadAttachment?");
    expect(new URL(finalRequest.url).searchParams.get("request_id")).toBe("reqAttachment");
    expect(JSON.parse(new URL(finalRequest.url).searchParams.get("stringifiedObjectParams") || "{}")).toEqual({
      columnId: "fldFile",
      attachmentId: "attRetry",
    });
    expect(finalRequest.headers.get("cookie")).toBe("brw=session-value; other=value");
    expect(finalRequest.headers.get("x-airtable-application-id")).toBe("appAttachment");
    expect(finalRequest.headers.get("x-airtable-inter-service-client-code-version")).toBe("codeAttachment");
    expect(finalRequest.headers.get("x-airtable-page-load-id")).toBe("pageAttachment");
    expect(files).toHaveLength(1);
    expect(ctx.failedAttachmentCount).toBe(0);
    expect(ctx.report.addFailed).not.toHaveBeenCalled();
  });

  it("streams an Airtable attachment by byte ranges when full endpoint downloads are refused", async () => {
    const db = createTestD1();
    const requests: Request[] = [];
    const storedFiles: any[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(input), init);
      requests.push(request);
      if (!request.url.includes("/downloadAttachment")) throw new Error(`Unexpected attachment request: ${request.url}`);
      if (!request.headers.get("range")) return new Response("full download denied", { status: 403 });
      expect(request.headers.get("range")).toBe("bytes=0-1048575");
      return new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), {
        status: 206,
        headers: {
          "content-type": "application/pdf",
          "content-range": "bytes 0-5/6",
          "content-length": "6",
        },
      });
    });
    const ctx = {
      env: {
        DB: db as any,
        FILES: {
          put: vi.fn(async (key: string, body: unknown, options: unknown) => {
            storedFiles.push({ key, body, options });
            return {};
          }),
        },
        PUBLIC_URL: "https://opentabl.test",
      },
      workspaceId: 1,
      userId: 7,
      init: {
        requestId: "reqRange",
        initData: {
          rawApplications: { appRange: {} },
          accessPolicy: "{}",
          codeVersion: "codeRange",
          pageLoadId: "pageRange",
        },
        cookie: "brw=range-session",
      },
      rowLookups: new Map(),
      failedAttachmentCount: 0,
      report: { addFailed: vi.fn() },
    };

    const files = await normalizeCellValue([{
      id: "attRange",
      filename: "range.pdf",
      type: "application/pdf",
      size: 6,
    }], {
      type: "file",
      airtableColumnId: "fldRange",
      airtableColumn: { name: "Files", tableName: "Documents" },
    } as any, false, ctx as any, { id: "recRange" }) as any[];

    fetchMock.mockRestore();
    expect(requests.filter((request) => !request.headers.get("range"))).toHaveLength(3);
    expect(requests.filter((request) => request.headers.get("range"))).toHaveLength(1);
    expect(storedFiles).toHaveLength(1);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ visible_name: "range.pdf", mime_type: "application/pdf", size: 6 });
    expect(ctx.failedAttachmentCount).toBe(0);
    expect(ctx.report.addFailed).not.toHaveBeenCalled();
  });

  it("converts Airtable grid and gallery views with field options, sorts, groups and filters", () => {
    const fields = [
      { id: 100, airtableColumnId: "fldName", type: "text", primary: true },
      { id: 101, airtableColumnId: "fldStatus", type: "single_select", selectOptions: new Map([["selA", { id: 201, value: "A", color: "light-blue" }]]) },
      { id: 102, airtableColumnId: "fldFile", type: "file" },
      { id: 103, airtableColumnId: "fldCreated", type: "created_on", read_only: true },
      { id: 104, airtableColumnId: "fldDue", type: "date" },
      { id: 105, airtableColumnId: "fldEnd", type: "date" },
    ];
    const table = {
      views: [
        { id: "viwGrid", name: "All rows", type: "grid" },
        { id: "viwGallery", name: "Cards", type: "gallery" },
        { id: "viwForm", name: "Lead form", type: "form" },
        { id: "viwKanban", name: "Pipeline", type: "kanban" },
        { id: "viwCalendar", name: "Schedule", type: "calendar" },
        { id: "viwTimeline", name: "Roadmap", type: "timeline" },
      ],
      viewOrder: ["viwGrid", "viwGallery", "viwForm", "viwKanban", "viwCalendar", "viwTimeline"],
      columns: [
        { id: "fldName", name: "Name", type: "text" },
        { id: "fldStatus", name: "Status", type: "select" },
        { id: "fldFile", name: "File", type: "multipleAttachment" },
        { id: "fldCreated", name: "Created", type: "formula" },
        { id: "fldDue", name: "Due", type: "date" },
        { id: "fldEnd", name: "End", type: "date" },
      ],
    };
    const specs = buildAirtableViewSpecs(table, {
      viewDatas: [
        {
          id: "viwGrid",
          columnOrder: [
            { columnId: "fldName", visibility: true, width: 180 },
            { columnId: "fldStatus", visibility: false },
          ],
          metadata: { grid: { rowHeight: "medium" } },
          lastSortsApplied: { sortSet: [{ columnId: "fldName", ascending: false }] },
          groupLevels: [{ columnId: "fldStatus", order: "ascending" }],
          filters: {
            conjunction: "or",
            filterSet: [
              { id: "flt1", columnId: "fldName", operator: "contains", value: "Alpha" },
              {
                id: "grp1",
                type: "nested",
                conjunction: "and",
                filterSet: [{ id: "flt2", columnId: "fldStatus", operator: "=", value: "selA" }],
              },
            ],
          },
        },
        {
          id: "viwGallery",
          columnOrder: [{ columnId: "fldFile", visibility: true }],
          metadata: { gallery: { coverColumnId: "fldFile", coverFitType: "crop" } },
        },
        {
          id: "viwForm",
          metadata: {
            form: {
              title: "Lead intake",
              description: "Tell us what you need",
              submitText: "Send",
              confirmationMessage: "Thanks",
              fieldOrder: ["fldName", "fldStatus", "fldCreated"],
              fieldOptionsByColumnId: {
                fldName: { label: "Company", required: true },
                fldStatus: { hidden: true },
              },
            },
          },
        },
        {
          id: "viwKanban",
          columnOrder: [{ columnId: "fldName", width: 210 }, { columnId: "fldStatus" }],
          metadata: { kanban: { stackColumnId: "fldStatus" } },
        },
        {
          id: "viwCalendar",
          columnOrder: [{ columnId: "fldName", width: 210 }, { columnId: "fldDue" }],
          metadata: { calendar: { dateColumnId: "fldDue" } },
        },
        {
          id: "viwTimeline",
          columnOrder: [{ columnId: "fldName", width: 210 }, { columnId: "fldDue" }, { columnId: "fldEnd" }],
          metadata: { timeline: { startDateColumnId: "fldDue", endDateColumnId: "fldEnd", timescale: "week" } },
        },
      ],
    }, fields as any);

    expect(specs[0]).toMatchObject({
      name: "All rows",
      type: "grid",
      rowHeightSize: "medium",
      filterType: "OR",
      fieldOptions: [
        { fieldId: 100, width: 180, hidden: false, order: 1 },
        { fieldId: 101, width: 200, hidden: true, order: 2 },
      ],
      sortings: [{ fieldId: 100, order: "DESC" }],
      groupBys: [{ fieldId: 101, order: "ASC" }],
      filterGroups: [{ airtableId: "grp1", filterType: "AND", parentAirtableId: null }],
      filters: [
        { fieldId: 100, type: "contains", value: "Alpha", groupAirtableId: null },
        { fieldId: 101, type: "single_select_equal", value: "201", groupAirtableId: "grp1" },
      ],
    });
    expect(specs[1]).toMatchObject({
      name: "Cards",
      type: "gallery",
      cardCoverImageFieldId: 102,
      fieldOptions: [{ fieldId: 102, width: 200, hidden: false, order: 1 }],
    });
    expect(specs[2]).toMatchObject({
      name: "Lead form",
      type: "form",
      form: {
        title: "Lead intake",
        description: "Tell us what you need",
        submitText: "Send",
        submitAction: "MESSAGE",
        submitActionMessage: "Thanks",
        mode: "form",
        showLogo: true,
        fieldOptions: [
          { fieldId: 100, name: "Company", description: "", enabled: true, required: true, order: 1 },
          { fieldId: 101, name: "", description: "", enabled: false, required: false, order: 2 },
        ],
      },
    });
    expect(specs[3]).toMatchObject({
      name: "Pipeline",
      type: "kanban",
      singleSelectFieldId: 101,
      fieldOptions: [
        { fieldId: 100, width: 210, hidden: false, order: 1 },
        { fieldId: 101, width: 200, hidden: false, order: 2 },
      ],
    });
    expect(specs[4]).toMatchObject({
      name: "Schedule",
      type: "calendar",
      dateFieldId: 104,
      fieldOptions: [
        { fieldId: 100, width: 210, hidden: false, order: 1 },
        { fieldId: 104, width: 200, hidden: false, order: 2 },
      ],
    });
    expect(specs[5]).toMatchObject({
      name: "Roadmap",
      type: "timeline",
      startDateFieldId: 104,
      endDateFieldId: 105,
      timescale: "week",
      fieldOptions: [
        { fieldId: 100, width: 210, hidden: false, order: 1 },
        { fieldId: 104, width: 200, hidden: false, order: 2 },
        { fieldId: 105, width: 200, hidden: false, order: 3 },
      ],
    });
  });

  it("reports Airtable view options that Baserow imports with degraded behavior", () => {
    const report = { addFailed: vi.fn() };
    const fields = [
      { id: 100, airtableColumnId: "fldName", type: "text", primary: true },
      { id: 101, airtableColumnId: "fldFile", type: "file" },
    ];
    const specs = buildAirtableViewSpecs({
      name: "View report table",
      views: [
        { id: "viwMissingCover", name: "Missing cover", type: "gallery" },
        { id: "viwTextCover", name: "Text cover", type: "gallery" },
        { id: "viwFitCover", name: "Fit cover", type: "gallery" },
        { id: "viwPersonalLocked", name: "Private locked", type: "grid", personalForUserId: "usr1", lock: { type: "locked" } },
      ],
      viewOrder: ["viwMissingCover", "viwTextCover", "viwFitCover", "viwPersonalLocked"],
      columns: [
        { id: "fldName", name: "Name", type: "text" },
        { id: "fldFile", name: "File", type: "multipleAttachment" },
      ],
    }, {
      viewDatas: [
        { id: "viwMissingCover", metadata: { gallery: { coverColumnId: "fldMissing" } } },
        { id: "viwTextCover", metadata: { gallery: { coverColumnId: "fldName" } } },
        { id: "viwFitCover", metadata: { gallery: { coverColumnId: "fldFile", coverFitType: "contain" } } },
        { id: "viwPersonalLocked", columnOrder: [{ columnId: "fldName" }] },
      ],
    }, fields as any, { report } as any);

    expect(specs.map((spec) => spec.name)).toEqual([
      "Missing cover",
      "Text cover",
      "Fit cover",
      "Private locked (Personal)",
    ]);
    expect(specs[0].cardCoverImageFieldId).toBe(null);
    expect(specs[1].cardCoverImageFieldId).toBe(null);
    expect(specs[2].cardCoverImageFieldId).toBe(101);
    expect(report.addFailed).toHaveBeenCalledWith(
      "Missing cover",
      "View",
      "View report table",
      "Unsupported feature",
      'View "Missing cover" cover column with id "fldMissing" is not found.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      "Text cover",
      "View",
      "View report table",
      "Unsupported feature",
      'View "Text cover" cover column with id "fldName" is not a file field.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      "Fit cover",
      "View",
      "View report table",
      "Unsupported feature",
      'View "Fit cover" cover fit type "contain" is not supported, so it defaulted to "crop"'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      "Private locked",
      "View",
      "View report table",
      "Unsupported feature",
      'View "Private locked" is personal, but was made collaborative because it can\'t be linked to a user. (Personal) was added to the name.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      "Private locked (Personal)",
      "View",
      "View report table",
      "Unsupported feature",
      'View "Private locked (Personal)" is locked, but was made collaborative because it Baserow does not support this yet.'
    );
  });

  it("reports Airtable view sort group filter and color options ignored by Baserow", () => {
    const report = { addFailed: vi.fn() };
    const fields = [
      { id: 100, airtableColumnId: "fldName", airtableColumn: { name: "Name" }, type: "text", primary: true },
      { id: 101, airtableColumnId: "fldFile", airtableColumn: { name: "Attachment" }, type: "file" },
      { id: 102, airtableColumnId: "fldRich", airtableColumn: { name: "Rich notes" }, type: "long_text", settings: { long_text_enable_rich_text: true } },
    ];
    const specs = buildAirtableViewSpecs({
      name: "View detail table",
      views: [{ id: "viwAudit", name: "Audit view", type: "grid" }],
      viewOrder: ["viwAudit"],
      columns: [
        { id: "fldName", name: "Name", type: "text" },
        { id: "fldFile", name: "Attachment", type: "multipleAttachment" },
        { id: "fldRich", name: "Rich notes", type: "richText" },
        { id: "fldSkipped", name: "Skipped source field", type: "formula" },
      ],
    }, {
      viewDatas: [{
        id: "viwAudit",
        lastSortsApplied: {
          sortSet: [
            { columnId: "fldMissingSort", ascending: true },
            { columnId: "fldFile", ascending: false },
            { columnId: "fldName", ascending: true },
          ],
        },
        groupLevels: [
          { columnId: "fldMissingGroup", order: "ascending" },
          { columnId: "fldRich", order: "ascending" },
          { columnId: "fldName", order: "sideways" },
        ],
        filters: {
          conjunction: "and",
          filterSet: [
            { id: "fltMissing", columnId: "fldSkipped", operator: "contains", value: "hidden" },
            { id: "fltUnsupported", columnId: "fldName", operator: "isAnyOf", value: ["A", "B"] },
            { id: "fltValid", columnId: "fldName", operator: "contains", value: "ok" },
          ],
        },
        colorConfig: { type: "selectColumn", selectColumnId: "fldMissingColor" },
      }],
    }, fields as any, { report } as any);

    expect(specs[0].sortings).toEqual([{ fieldId: 100, order: "ASC" }]);
    expect(specs[0].groupBys).toEqual([]);
    expect(specs[0].filters).toEqual([{ fieldId: 100, type: "contains", value: "ok", groupAirtableId: null }]);
    expect(specs[0].decorations).toEqual([]);
    expect(report.addFailed).toHaveBeenCalledWith(
      'View "Audit view", Field ID "fldMissingSort"',
      "View sort",
      "View detail table",
      "Unsupported feature",
      'The sort on field "fldMissingSort" was ignored in view Audit view because the field is not imported.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      'View "Audit view", Field "Attachment"',
      "View sort",
      "View detail table",
      "Unsupported feature",
      'The sort on field "Attachment" was ignored in view Audit view because it\'s not possible to order by that field type.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      'View "Audit view", Field ID "fldMissingGroup"',
      "View group by",
      "View detail table",
      "Unsupported feature",
      'The group by on field "fldMissingGroup" was ignored in view Audit view because the field was not imported.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      'View "Audit view", Field "Rich notes"',
      "View group by",
      "View detail table",
      "Unsupported feature",
      'The group by on field "Rich notes" was ignored in view Audit view because it\'s not possible to group by that field type.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      'View "Audit view", Field "Name"',
      "View group by",
      "View detail table",
      "Unsupported feature",
      'The group by on field "Name" was ignored in view Audit view because the order sideways is incompatible.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      'View "Audit view", Field ID "Skipped source field"',
      "View filter",
      "View detail table",
      "Unsupported feature",
      'The "contains" filter with value "hidden" on field "Skipped source field" was ignored in view Audit view because the field was not imported.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      'View "Audit view", Field "Name"',
      "View filter",
      "View detail table",
      "Unsupported feature",
      'The "isAnyOf" filter with value "2 items" on field "Name" was ignored in view Audit view because not no compatible filter exists.'
    );
    expect(report.addFailed).toHaveBeenCalledWith(
      "Audit view",
      "View color",
      "View detail table",
      "Data type mismatch",
      "The select field coloring was ignored in Audit view because fldMissingColor does not exist."
    );
  });

  it("flattens Airtable view sections into Baserow ordered view names", () => {
    const fields = [{ id: 100, airtableColumnId: "fldName", type: "text", primary: true }];
    const specs = buildAirtableViewSpecs({
      views: [
        { id: "viwLater", name: "Later", type: "grid" },
        { id: "viwSectionGrid", name: "Pipeline", type: "grid" },
        { id: "viwSectionGallery", name: "Cards", type: "gallery", personalForUserId: "usr1" },
      ],
      viewOrder: ["vsecOps", "viwLater"],
      viewSectionsById: {
        vsecOps: { id: "vsecOps", name: "Operations", viewOrder: ["viwSectionGrid", "viwSectionGallery"] },
      },
      columns: [{ id: "fldName", name: "Name", type: "text" }],
    }, {
      viewDatas: [
        { id: "viwSectionGrid", columnOrder: [{ columnId: "fldName", width: 180 }] },
        { id: "viwSectionGallery", columnOrder: [{ columnId: "fldName", visibility: false }] },
        { id: "viwLater", columnOrder: [{ columnId: "fldName" }] },
      ],
    }, fields as any);

    expect(specs.map((spec) => ({ name: spec.name, type: spec.type, order: spec.order }))).toEqual([
      { name: "Operations / Pipeline", type: "grid", order: 1 },
      { name: "Operations / Cards (Personal)", type: "gallery", order: 2 },
      { name: "Later", type: "grid", order: 3 },
    ]);
    expect(specs[1].fieldOptions).toEqual([{ fieldId: 100, width: 200, hidden: true, order: 1 }]);
  });

  it("converts Airtable date/link/file filters and color decorations with Baserow values", () => {
    const fields = [
      { id: 101, airtableColumnId: "fldStatus", type: "single_select", selectOptions: new Map([["selA", { id: 201, value: "A", color: "light-blue" }]]) },
      { id: 102, airtableColumnId: "fldFile", type: "file" },
      { id: 103, airtableColumnId: "fldDate", type: "date" },
      { id: 104, airtableColumnId: "fldLink", type: "link_row", targetAirtableTableId: "tblLinked" },
      { id: 105, airtableColumnId: "fldName", type: "text" },
      { id: 106, airtableColumnId: "fldOwner", type: "multiple_collaborators" },
      { id: 107, airtableColumnId: "fldTags", type: "multiple_select", selectOptions: new Map([["selA", { id: 202, value: "A", color: "light-blue" }]]) },
      { id: 108, airtableColumnId: "fldPaid", type: "boolean" },
      { id: 109, airtableColumnId: "fldDuration", type: "duration" },
    ];
    const table = {
      views: [
        { id: "viwGrid", name: "Filtered", type: "grid" },
        { id: "viwConditional", name: "Colored", type: "grid" },
      ],
      viewOrder: ["viwGrid", "viwConditional"],
      columns: [
        { id: "fldStatus", name: "Status", type: "select" },
        { id: "fldFile", name: "File", type: "multipleAttachment" },
        { id: "fldDate", name: "Date", type: "date" },
        { id: "fldLink", name: "Link", type: "foreignKey" },
        { id: "fldName", name: "Name", type: "text" },
        { id: "fldOwner", name: "Owner", type: "collaborator" },
        { id: "fldTags", name: "Tags", type: "multiSelect" },
        { id: "fldPaid", name: "Paid", type: "checkbox" },
        { id: "fldDuration", name: "Duration", type: "number", typeOptions: { format: "duration" } },
      ],
    };
    const specs = buildAirtableViewSpecs(table, {
      viewDatas: [
        {
          id: "viwGrid",
          filters: {
            conjunction: "and",
            filterSet: [
              { id: "fltDate", columnId: "fldDate", operator: "=", value: { mode: "exactDate", exactDate: "2025-01-15T10:00:00.000Z", timeZone: "Europe/Zurich" } },
              { id: "fltWithin", columnId: "fldDate", operator: "isWithin", value: { mode: "pastNumberOfDays", numberOfDays: 7, timeZone: "Europe/Zurich" } },
              { id: "fltLink", columnId: "fldLink", operator: "=", value: ["recLinked"] },
              { id: "fltLinkRecordId", columnId: "fldLink", operator: "=", value: [{ recordId: "recLinked", displayName: "Linked row" }] },
              { id: "fltLinkMultiSkipped", columnId: "fldLink", operator: "=", value: ["recLinked", "recOther"] },
              { id: "fltLinkNot", columnId: "fldLink", operator: "doesNotContain", value: "Blocked" },
              { id: "fltOwner", columnId: "fldOwner", operator: "=", value: { id: "usrAlice", name: "Alice Example" } },
              { id: "fltOwnerNot", columnId: "fldOwner", operator: "!=", value: { id: "usrBob", name: "Bob Example" } },
              { id: "fltTagsNotSkipped", columnId: "fldTags", operator: "!=", value: ["selA"] },
              { id: "fltPaidNotSkipped", columnId: "fldPaid", operator: "!=", value: true },
              { id: "fltTextComparisonSkipped", columnId: "fldName", operator: ">", value: "Alpha" },
              { id: "fltDurationValid", columnId: "fldDuration", operator: "<", value: 30 },
              { id: "fltDurationEqualTooHighSkipped", columnId: "fldDuration", operator: "=", value: 86399999913601 },
              { id: "fltDurationComparisonTooHighSkipped", columnId: "fldDuration", operator: ">", value: -86399999913601 },
              { id: "fltImage", columnId: "fldFile", operator: "filetype", value: "image" },
              { id: "fltIgnored", columnId: "fldFile", operator: "filetype", value: "spreadsheet" },
            ],
          },
          colorConfig: { type: "selectColumn", selectColumnId: "fldStatus" },
        },
        {
          id: "viwConditional",
          filters: { conjunction: "and", filterSet: [] },
          colorConfig: {
            type: "colorDefinitions",
            defaultColor: "grayDark",
            colorDefinitions: [
              {
                id: "col1",
                conjunction: "or",
                color: "tealDark",
                filterSet: [{ id: "fltColor", columnId: "fldName", operator: "contains", value: "VIP" }],
              },
            ],
          },
        },
      ],
    }, fields as any, {
      rowLookups: new Map([["tblLinked", new Map([["recLinked", { id: 301, value: "Linked row" }]])]]),
    } as any);

    expect(specs[0].filters).toEqual([
      { fieldId: 103, type: "date_is", value: "Europe/Zurich?2025-01-15?exact_date", groupAirtableId: null },
      { fieldId: 103, type: "date_is_within", value: "Europe/Zurich?7?nr_days_ago", groupAirtableId: null },
      { fieldId: 104, type: "link_row_has", value: "301", groupAirtableId: null },
      { fieldId: 104, type: "link_row_has", value: "301", groupAirtableId: null },
      { fieldId: 104, type: "link_row_not_contains", value: "Blocked", groupAirtableId: null },
      { fieldId: 106, type: "multiple_collaborators_has", value: expect.stringMatching(/^\d+$/), groupAirtableId: null },
      { fieldId: 106, type: "multiple_collaborators_has_not", value: expect.stringMatching(/^\d+$/), groupAirtableId: null },
      { fieldId: 109, type: "lower_than", value: "30", groupAirtableId: null },
      { fieldId: 102, type: "has_file_type", value: "image", groupAirtableId: null },
    ]);
    expect(specs[0].decorations).toEqual([
      {
        type: "left_border_color",
        valueProviderType: "single_select_color",
        valueProviderConf: { field_id: 101 },
        order: 1,
      },
    ]);
    expect(specs[1].decorations).toEqual([
      {
        type: "left_border_color",
        valueProviderType: "conditional_color",
        valueProviderConf: {
          colors: [
            {
              filter_groups: [],
              filters: [expect.objectContaining({ type: "contains", field: 105, group: null, value: "VIP" })],
              operator: "OR",
              color: "dark-pink",
            },
            { filter_groups: [], filters: [], operator: "AND", color: "dark-gray" },
          ],
        },
        order: 1,
      },
    ]);
  });

  it("imports an Airtable base fixture into D1 with typed fields, rows, links, views and files", async () => {
    await withAirtableFetchFixture(async (calls) => {
      const db = createTestD1();
      const queuedJobs: any[] = [];
      const storedFiles: any[] = [];
      const progressEvents: Array<{ progress: number; state: string }> = [];
      const env = {
        DB: db as any,
        FILES: {
          put: vi.fn(async (key: string, body: unknown, options: unknown) => {
            storedFiles.push({ key, body, options });
            return {};
          }),
        },
        JOBS_QUEUE: {
          send: vi.fn(async (message: unknown) => {
            queuedJobs.push(message);
          }),
        },
        PUBLIC_URL: "https://opentabl.test",
        JWT_SIGNING_KEY: "test-secret",
        SECRET_KEY: "test-secret",
        BASEROW_SERVE_FILES_THROUGH_BACKEND: "true",
        BASEROW_SERVE_FILES_THROUGH_BACKEND_PERMISSION: "DISABLED",
        BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS: "0",
      };

      const result = await importAirtableBase(env as any, {
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
      }, 7, (progress, state) => {
        progressEvents.push({ progress, state });
      });

      expect(result.database).toMatchObject({
        name: "Fixture Airtable Base",
        type: "database",
        airtable_failed_attachment_count: 1,
      });
      expect(progressEvents.some((event) => event.state === "downloading-base")).toBe(true);
      expect(progressEvents.some((event) => event.state === "converting")).toBe(true);
      expect(progressEvents.some((event) => event.state === "downloading-files")).toBe(true);
      expect(Math.max(...progressEvents.map((event) => event.progress))).toBeGreaterThanOrEqual(90);
      expect(calls.some((url) => url.includes("/application/appFixture/read"))).toBe(true);
      expect(calls.some((url) => url.includes("/table/tblOrders/readData"))).toBe(true);

      const app = await db.prepare("SELECT * FROM core_application WHERE name=?").bind("Fixture Airtable Base").first<any>();
      expect(app?.workspace_id).toBe(1);

      const customers = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Customers").first<any>();
      const orders = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Orders").first<any>();
      const primarySelect = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Primary select").first<any>();
      const importReport = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Airtable import report").first<any>();
      expect(customers?.id).toBeTruthy();
      expect(orders?.id).toBeTruthy();
      expect(primarySelect?.id).toBeTruthy();
      expect(importReport?.id).toBeTruthy();

      const customerFields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(customers.id).all()).results;
      const orderFields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(orders.id).all()).results;
      const primarySelectFields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(primarySelect.id).all()).results;
      const customerStatus = customerFields.find((field: any) => field.name === "Status");
      const customerNotes = customerFields.find((field: any) => field.name === "Notes");
      const orderName = orderFields.find((field: any) => field.name === "Order");
      const orderPaid = orderFields.find((field: any) => field.name === "Paid");
      const orderTags = orderFields.find((field: any) => field.name === "Tags");
      const orderLink = orderFields.find((field: any) => field.name === "Customer");
      const orderAltLink = orderFields.find((field: any) => field.name === "Alt customer");
      const orderCount = orderFields.find((field: any) => field.name === "Customer count");
      const orderLookup = orderFields.find((field: any) => field.name === "Customer email lookup");
      const orderRollup = orderFields.find((field: any) => field.name === "Customer score rollup");
      const orderBrokenCount = orderFields.find((field: any) => field.name === "Broken customer count");
      const orderBrokenLookup = orderFields.find((field: any) => field.name === "Broken customer email lookup");
      const orderBrokenRollup = orderFields.find((field: any) => field.name === "Broken customer score rollup");
      const orderFiles = orderFields.find((field: any) => field.name === "Files");
      const orderCreated = orderFields.find((field: any) => field.name === "Created");
      const orderLastModified = orderFields.find((field: any) => field.name === "Last modified");
      const orderLastModifiedSpecific = orderFields.find((field: any) => field.name === "Last modified specific fields");
      const orderCreatedBy = orderFields.find((field: any) => field.name === "Created by");
      const orderLastModifiedBy = orderFields.find((field: any) => field.name === "Last modified by");
      const orderCalculatedAmount = orderFields.find((field: any) => field.name === "Calculated amount");
      const orderUnsupportedFormula = orderFields.find((field: any) => field.name === "Unsupported formula");
      const orderUnknownUnsupported = orderFields.find((field: any) => field.name === "Unknown unsupported");
      const orderDuration = orderFields.find((field: any) => field.name === "Duration days");
      const orderDurationTenths = orderFields.find((field: any) => field.name === "Duration tenths");
      const orderDurationHundredths = orderFields.find((field: any) => field.name === "Duration hundredths");
      const orderAmount = orderFields.find((field: any) => field.name === "Amount percent");
      const orderCurrency = orderFields.find((field: any) => field.name === "Currency");
      const orderDueDate = orderFields.find((field: any) => field.name === "Due date");
      const orderUrl = orderFields.find((field: any) => field.name === "Website");
      const orderPhone = orderFields.find((field: any) => field.name === "Phone");
      const orderOwner = orderFields.find((field: any) => field.name === "Owner");
      const orderRating = orderFields.find((field: any) => field.name === "Rating");

      expect(customerStatus.type).toBe("single_select");
      expect(customerNotes.type).toBe("long_text");
      expect(JSON.parse(customerNotes.field_settings).long_text_enable_rich_text).toBe(true);
      expect(orderTags.type).toBe("multiple_select");
      expect(orderLink.type).toBe("link_row");
      expect(orderAltLink.type).toBe("link_row");
      expect(orderCount.type).toBe("count");
      expect(orderLookup.type).toBe("lookup");
      expect(orderRollup.type).toBe("rollup");
      expect(orderBrokenCount.type).toBe("count");
      expect(orderBrokenLookup.type).toBe("lookup");
      expect(orderBrokenRollup.type).toBe("rollup");
      expect(orderFiles.type).toBe("file");
      expect(orderCreated.type).toBe("created_on");
      expect(orderLastModified.type).toBe("last_modified");
      expect(orderLastModifiedSpecific.type).toBe("last_modified");
      expect(orderCreatedBy.type).toBe("created_by");
      expect(orderLastModifiedBy.type).toBe("last_modified_by");
      expect(orderCalculatedAmount.type).toBe("formula");
      expect(orderUnsupportedFormula).toBeUndefined();
      expect(orderUnknownUnsupported).toBeUndefined();
      expect(orderDuration.type).toBe("duration");
      expect(orderDurationTenths.type).toBe("duration");
      expect(orderDurationHundredths.type).toBe("duration");
      expect(orderAmount.type).toBe("number");
      expect(orderCurrency.type).toBe("number");
      expect(orderDueDate.type).toBe("date");
      expect(orderUrl.type).toBe("url");
      expect(orderPhone.type).toBe("phone_number");
      expect(orderOwner.type).toBe("multiple_collaborators");
      expect(JSON.parse(orderRating.field_settings)).toMatchObject({ max_value: 5, color: "dark-blue", style: "star" });
      const primaryStage = primarySelectFields.find((field: any) => field.name === "Stage");
      expect(primaryStage).toMatchObject({ type: "single_select", primary: 1 });

      const statusOptionRows = (await db.prepare("SELECT id, value, [order] FROM database_selectoption WHERE field_id=? ORDER BY [order] ASC").bind(customerStatus.id).all()).results;
      const tagOptionRows = (await db.prepare("SELECT id, value, [order] FROM database_selectoption WHERE field_id=? ORDER BY [order] ASC").bind(orderTags.id).all()).results;
      const primaryStageOptionRows = (await db.prepare("SELECT id, value, [order] FROM database_selectoption WHERE field_id=? ORDER BY [order] ASC").bind(primaryStage.id).all()).results;
      expect(statusOptionRows.map((row: any) => row.value)).toEqual(["Active", "Lead"]);
      expect(tagOptionRows.map((row: any) => row.value)).toEqual(["Urgent", "Gift"]);
      expect(tagOptionRows.map((row: any) => row.order)).toEqual([0, 1]);
      expect(JSON.parse(orderTags.field_settings).multiple_select_default).toEqual([
        tagOptionRows.find((row: any) => row.value === "Gift").id,
      ]);
      expect(JSON.parse(primaryStage.field_settings).single_select_default).toBe(
        primaryStageOptionRows.find((row: any) => row.value === "Done").id
      );

      const linkSettings = JSON.parse(orderLink.field_settings);
      const altLinkSettings = JSON.parse(orderAltLink.field_settings);
      const amountSettings = JSON.parse(orderAmount.field_settings);
      const currencySettings = JSON.parse(orderCurrency.field_settings);
      const durationTenthsSettings = JSON.parse(orderDurationTenths.field_settings);
      const durationHundredthsSettings = JSON.parse(orderDurationHundredths.field_settings);
      const createdSettings = JSON.parse(orderCreated.field_settings);
      const lastModifiedSettings = JSON.parse(orderLastModified.field_settings);
      const calculatedAmountSettings = JSON.parse(orderCalculatedAmount.field_settings);
      expect(linkSettings.link_row_table_id).toBe(customers.id);
      expect(linkSettings.link_row_table_primary_field.name).toBe("Customer");
      expect(altLinkSettings.link_row_table_id).toBe(customers.id);
      expect(amountSettings.number_suffix).toBe("%");
      expect(amountSettings.number_default).toBe(25);
      expect(currencySettings.number_separator).toBe("SPACE_PERIOD");
      expect(durationTenthsSettings.duration_format).toBe("h:mm:ss.s");
      expect(durationHundredthsSettings.duration_format).toBe("h:mm:ss.ss");
      expect(createdSettings.date_include_time).toBe(true);
      expect(lastModifiedSettings).toMatchObject({ date_format: "US", date_include_time: false, date_time_format: "12", date_force_timezone: "Europe/Amsterdam" });
      expect(calculatedAmountSettings).toMatchObject({ formula: "{Amount percent} * 2", formula_type: "number", formula_type_error: null });
      const lookupSettings = JSON.parse(orderLookup.field_settings);
      const rollupSettings = JSON.parse(orderRollup.field_settings);
      const countSettings = JSON.parse(orderCount.field_settings);
      const brokenCountSettings = JSON.parse(orderBrokenCount.field_settings);
      const brokenLookupSettings = JSON.parse(orderBrokenLookup.field_settings);
      const brokenRollupSettings = JSON.parse(orderBrokenRollup.field_settings);
      expect(countSettings.through_field_id).toBe(orderLink.id);
      expect(countSettings.formula_type).toBe("number");
      expect(lookupSettings.through_field_id).toBe(orderLink.id);
      expect(lookupSettings.target_field_id).toBe(customerFields.find((field: any) => field.name === "Email").id);
      expect(rollupSettings.through_field_id).toBe(orderLink.id);
      expect(rollupSettings.target_field_id).toBe(customerFields.find((field: any) => field.name === "Score").id);
      expect(rollupSettings.rollup_function).toBe("sum");
      expect(brokenCountSettings).toMatchObject({
        through_field_id: null,
        formula_type: "number",
        formula_type_error: null,
        nullable: false,
        number_decimal_places: 0,
      });
      expect(brokenLookupSettings).toMatchObject({
        through_field_id: null,
        target_field_id: null,
        formula_type: "text",
        array_formula_type: "text",
        formula_type_error: null,
        nullable: true,
      });
      expect(brokenRollupSettings).toMatchObject({
        through_field_id: null,
        target_field_id: null,
        rollup_function: "sum",
        formula_type: "number",
        formula_type_error: null,
        nullable: true,
      });

      const orderRows = (await db.prepare(`SELECT * FROM "database_table_${orders.id}" ORDER BY id ASC`).all()).results;
      const customerRows = (await db.prepare(`SELECT * FROM "database_table_${customers.id}" ORDER BY id ASC`).all()).results;
      expect(customerRows[0][`field_${customerNotes.id}`]).toBe("## **Important** customer\n[Website](https://example.com/acme)\n- [x] Ship samples");
      expect(orderRows).toHaveLength(2);
      expect(orderRows[0][`field_${orderAmount.id}`]).toBe("n:25");
      expect(orderRows[1][`field_${orderAmount.id}`]).toBe(null);
      expect(orderRows[0][`field_${orderCurrency.id}`]).toBe("n:123.45");
      expect(orderRows[0][`field_${orderDuration.id}`]).toBe("n:172800");
      expect(orderRows[1][`field_${orderDuration.id}`]).toBe(null);
      expect(orderRows[0][`field_${orderDurationTenths.id}`]).toBe("n:1.2");
      expect(orderRows[0][`field_${orderDurationHundredths.id}`]).toBe("n:1.23");
      expect(orderRows[0][`field_${orderDueDate.id}`]).toBe("2026-03-01");
      expect(orderRows[1][`field_${orderDueDate.id}`]).toBe(null);
      expect(orderRows[0][`field_${orderCreated.id}`]).toBe("2026-02-01T00:00:00+00:00");
      expect(orderRows[0][`field_${orderLastModifiedSpecific.id}`]).toBe("2026-02-03T15:51:00+00:00");
      expect(orderRows[0][`field_${orderLastModified.id}`]).toBe("2026-02-03T14:51:00+00:00");
      expect(JSON.parse(orderRows[0][`field_${orderCreatedBy.id}`])).toMatchObject({
        name: "Creator Example",
        email: "creator@example.com",
        airtable_id: "usrCreator",
        external: true,
      });
      expect(JSON.parse(orderRows[0][`field_${orderLastModifiedBy.id}`])).toMatchObject({
        name: "Editor Example",
        email: "editor@example.com",
        airtable_id: "usrEditor",
        external: true,
      });
      expect(Number(orderRows[0][`field_${orderCalculatedAmount.id}`])).toBe(50);
      expect(orderRows[0][`field_${orderUrl.id}`]).toBe("https://example.com/order-one");
      expect(orderRows[1][`field_${orderUrl.id}`]).toBe("");
      expect(orderRows[0][`field_${orderPhone.id}`]).toBe("+33123456789");
      expect(orderRows[1][`field_${orderPhone.id}`]).toBe("");
      expect(JSON.parse(orderRows[0][`field_${orderTags.id}`]).map((option: any) => option.value)).toEqual(["Urgent", "Gift"]);
      expect(JSON.parse(orderRows[0][`field_${orderLink.id}`])).toEqual([{ id: 1, value: "Acme" }]);
      expect(JSON.parse(orderRows[0][`field_${orderAltLink.id}`])).toEqual([{ id: 1, value: "Acme" }]);
      expect(orderRows[0][`field_${orderCount.id}`]).toBe("n:1");
      expect(JSON.parse(orderRows[0][`field_${orderLookup.id}`])).toEqual([{ id: 1, value: "a@example.com" }]);
      expect(orderRows[0][`field_${orderRollup.id}`]).toBe("n:8");
      expect(orderRows[0][`field_${orderBrokenCount.id}`]).toBe(null);
      expect(JSON.parse(orderRows[0][`field_${orderBrokenLookup.id}`])).toEqual([]);
      expect(JSON.parse(orderRows[0][`field_${orderOwner.id}`])).toEqual([
        expect.objectContaining({ name: "Alice Example", email: "alice@example.com", airtable_id: "usrAlice", external: true }),
      ]);

      const firstFiles = JSON.parse(orderRows[0][`field_${orderFiles.id}`]);
      const secondFiles = JSON.parse(orderRows[1][`field_${orderFiles.id}`]);
      expect(firstFiles[0]).toMatchObject({
        visible_name: "ok.png",
        mime_type: "image/png",
        image_width: 10,
        image_height: 20,
      });
      expect(firstFiles[0].original_name).toBeUndefined();
      expect(firstFiles[0].url).toContain("https://opentabl.test/api/files/");
      expect(firstFiles[0].url).not.toContain("/media/");
      expect(secondFiles).toEqual([]);
      expect(storedFiles).toHaveLength(1);
      expect(queuedJobs).toHaveLength(0);
      const reportFields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(importReport.id).all()).results;
      expect(reportFields.map((field: any) => [field.name, field.type, field.primary])).toEqual([
        ["Object name", "text", 1],
        ["Scope", "single_select", 0],
        ["Table", "single_select", 0],
        ["Error type", "single_select", 0],
        ["Message", "long_text", 0],
      ]);
      const reportRows = (await db.prepare(`SELECT * FROM "database_table_${importReport.id}" ORDER BY id ASC`).all()).results;
      const reportObjectField = reportFields.find((field: any) => field.name === "Object name");
      const reportMessageField = reportFields.find((field: any) => field.name === "Message");
      const reportObjects = reportRows.map((row: any) => row[`field_${reportObjectField.id}`]);
      const reportMessages = reportRows.map((row: any) => row[`field_${reportMessageField.id}`]);
      expect(reportObjects).toEqual(expect.arrayContaining([
        "Paid",
        "Amount percent",
        "Due date",
        "Rating",
        "Alt customer",
        "Last modified specific fields",
        "Unsupported formula",
        "Unknown unsupported",
        "Barcode unsupported",
        "Broken customer count",
        "Broken customer email lookup",
        "Broken customer score rollup",
        'Row: "Row recOrder2", field: "Amount percent"',
        'Row: "Row recOrder2", field: "Duration days"',
        'Row: "Row recOrder2", field: "Due date"',
        'Row: "Row recOrder2", field: "Website"',
        'Row: "Row recOrder2", field: "Phone"',
        "All automations",
        "All interfaces",
      ]));
      expect(reportMessages).toEqual(expect.arrayContaining([
        'Field "Unknown unsupported" with field type mysteryField was not imported because it is not supported.',
        'Field "Barcode unsupported" with field type barcode was not imported because it is not supported.',
      ]));
      expect(reportMessages.some((message: string) => message.includes("icon x is not supported"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("color red is not supported"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("separator format thinSpacePeriod was dropped"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("default value Current date was dropped"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("icon dot does not exist"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("color yellow does not exist"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("support for a one to many relationship was dropped"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("limiting record selection to a view was dropped"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("filtering record by a condition was dropped"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("using AI to show top matches was dropped"))).toBe(true);
      expect(reportMessages.some((message: string) => message === "The field was imported, but the support to depend on specific fields was dropped because that's not supported by Baserow.")).toBe(true);
      expect(reportMessages.some((message: string) => message === 'Cell value was left empty because the numeric value INVALID_NUMBER could not be parsed"')).toBe(true);
      expect(reportMessages.some((message: string) => message === 'Cell value was left empty because the duration seconds 7464959992535126400 is outside the -86399999913600 and 86399999913600 range."')).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("datetime validation"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("email or URL validation"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("phone number validation"))).toBe(true);
      expect(reportMessages.some((message: string) => message.includes("authenticated attachment endpoint") && message.includes("was not imported"))).toBe(true);
      expect(reportMessages.filter((message: string) => message.includes("unresolved Airtable relation reference")).length).toBe(3);
      const primarySelectRows = (await db.prepare(`SELECT * FROM "database_table_${primarySelect.id}" ORDER BY id ASC`).all()).results;
      expect(JSON.parse(primarySelectRows[0][`field_${primaryStage.id}`])).toMatchObject({ value: "Todo" });

      const customerViews = (await db.prepare("SELECT * FROM database_view WHERE table_id=? ORDER BY [order] ASC").bind(customers.id).all()).results;
      expect(customerViews.map((view: any) => view.type)).toEqual(["grid", "kanban"]);
      expect(customerViews[1].single_select_field).toBe(customerStatus.id);
      const customerKanbanOptions = (await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=? ORDER BY [order] ASC").bind(customerViews[1].id).all()).results;
      expect(customerKanbanOptions.map((option: any) => option.field_id)).toEqual([
        customerFields.find((field: any) => field.name === "Customer").id,
        customerStatus.id,
      ]);

      const views = (await db.prepare("SELECT * FROM database_view WHERE table_id=? ORDER BY [order] ASC").bind(orders.id).all()).results;
      expect(views.map((view: any) => view.type)).toEqual(["grid", "gallery", "form", "calendar", "timeline"]);
      expect(views[0].row_height_size).toBe("medium");
      expect(views[1].card_cover_image_field).toBe(orderFiles.id);
      expect(views[3].date_field).toBe(orderDueDate.id);
      const calendarOptions = (await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=? ORDER BY [order] ASC").bind(views[3].id).all()).results;
      expect(calendarOptions.map((option: any) => option.field_id)).toEqual([orderName.id, orderDueDate.id]);
      expect(views[4]).toMatchObject({
        start_date_field: orderDueDate.id,
        end_date_field: orderLastModified.id,
        timescale: "month",
      });
      const timelineOptions = (await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=? ORDER BY [order] ASC").bind(views[4].id).all()).results;
      expect(timelineOptions.map((option: any) => option.field_id)).toEqual([orderName.id, orderDueDate.id, orderLastModified.id]);
      const formDetails = await db.prepare("SELECT * FROM database_formview WHERE view_ptr_id=?").bind(views[2].id).first<any>();
      const formOptions = (await db.prepare("SELECT * FROM database_formviewfieldoptions WHERE form_view_id=? ORDER BY [order] ASC").bind(views[2].id).all()).results;
      expect(formDetails).toMatchObject({
        title: "Order intake",
        description: "Public order form",
        submit_text: "Send order",
        submit_action: "MESSAGE",
        submit_action_message: "Order received",
        mode: "form",
        show_logo: 1,
      });
      expect(formOptions.map((option: any) => ({
        field_id: option.field_id,
        name: option.name,
        description: option.description,
        enabled: option.enabled,
        required: option.required,
      }))).toEqual([
        { field_id: orderName.id, name: "Order", description: "", enabled: 1, required: 1 },
        { field_id: orderPaid.id, name: "", description: "", enabled: 0, required: 0 },
        { field_id: orderFiles.id, name: "", description: "Attach documents", enabled: 1, required: 0 },
      ]);
      const filters = (await db.prepare("SELECT * FROM database_viewfilter WHERE view_id=?").bind(views[0].id).all()).results;
      const sortings = (await db.prepare("SELECT * FROM database_viewsort WHERE view_id=?").bind(views[0].id).all()).results;
      const groupBys = (await db.prepare("SELECT * FROM database_viewgroupby WHERE view_id=?").bind(views[0].id).all()).results;
      expect(filters).toHaveLength(2);
      expect(filters[0]).toMatchObject({ type: "boolean", value: "true" });
      expect(filters[1]).toMatchObject({ field_id: orderOwner.id, type: "multiple_collaborators_has" });
      expect(sortings).toHaveLength(1);
      expect(groupBys).toHaveLength(1);
    });
  });

  it("imports the Baserow source Airtable basic fixture with typed fields, rows, views and attachments", async () => {
    const db = createTestD1();
    const storedFiles: any[] = [];
    const env = {
      DB: db as any,
      FILES: {
        put: vi.fn(async (key: string, body: unknown, options: unknown) => {
          storedFiles.push({ key, body, options });
          return {};
        }),
      },
      JOBS_QUEUE: { send: vi.fn(async () => undefined) },
      PUBLIC_URL: "https://opentabl.test",
    };
    const baseHtml = baserowAirtableBasicFixture("airtable_base.html");
    const appJson = baserowAirtableBasicJson("airtable_application.json");
    const tableJson = baserowAirtableBasicJson("airtable_table.json");
    const filteredGridJson = baserowAirtableBasicJson("airtable_view_viwDgBCKTEdCQoHTQKH.json");
    const galleryJson = baserowAirtableBasicJson("airtable_view_viwBAGnUgZ6X5Eyg5Wf.json");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://airtable.com/appZkaH3aWX3ZjT3b") {
        return new Response(baseHtml, {
          status: 200,
          headers: { "content-type": "text/html", "set-cookie": "brw=test;" },
        });
      }
      if (url.startsWith("https://airtable.com/v0.3/application/appZkaH3aWX3ZjT3b/read")) return jsonResponse(appJson);
      if (url.startsWith("https://airtable.com/v0.3/table/tbl7glLIGtH8C8zGCzb/readData")) return jsonResponse(tableJson);
      if (url.startsWith("https://airtable.com/v0.3/view/viwDgBCKTEdCQoHTQKH/readData")) return jsonResponse(filteredGridJson);
      if (url.startsWith("https://airtable.com/v0.3/view/viwBAGnUgZ6X5Eyg5Wf/readData")) return jsonResponse(galleryJson);
      if (url.startsWith("https://dl.airtable.com/")) {
        const contentType = url.endsWith(".jpg") ? "image/jpeg" : url.endsWith(".doc") ? "application/msword" : "text/plain";
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": contentType, "content-length": "4" },
        });
      }
      if (url.includes("/downloadAttachment")) {
        return new Response(new Uint8Array([5, 6, 7, 8]), {
          status: 206,
          headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-3/4" },
        });
      }
      throw new Error(`Unexpected Baserow Airtable fixture request: ${url}`);
    });

    try {
      const result = await importAirtableBase(env as any, {
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appZkaH3aWX3ZjT3b",
      }, 7);

      expect(result.database).toMatchObject({ name: "Test", type: "database" });
      const app = await db.prepare("SELECT * FROM core_application WHERE name=?").bind("Test").first<any>();
      const users = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Users").first<any>();
      const data = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Data").first<any>();
      const report = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Airtable import report").first<any>();
      expect(users?.id).toBeTruthy();
      expect(data?.id).toBeTruthy();
      expect(report?.id).toBeTruthy();

      const userRows = (await db.prepare(`SELECT * FROM "database_table_${users.id}" ORDER BY id ASC`).all()).results;
      const dataRows = (await db.prepare(`SELECT * FROM "database_table_${data.id}" ORDER BY id ASC`).all()).results;
      expect(userRows).toHaveLength(3);
      expect(dataRows).toHaveLength(4);

      const fields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC").bind(data.id).all()).results;
      const fieldByName = new Map(fields.map((field: any) => [field.name, field]));
      expect(fieldByName.get("Link to Users")?.type).toBe("link_row");
      expect(fieldByName.get("Name lookup (from Users)")?.type).toBe("lookup");
      expect(fieldByName.get("Count rollup (from Users)")?.type).toBe("rollup");
      expect(fieldByName.get("Count (Link to Users)")?.type).toBe("count");
      expect(fieldByName.get("Attachment")?.type).toBe("file");
      expect(fieldByName.get("Rich long text")?.type).toBe("long_text");
      expect(fieldByName.get("Barcode")).toBeUndefined();
      expect(JSON.parse(fieldByName.get("Duration")?.field_settings || "{}").duration_format).toBe("h:mm");
      expect(JSON.parse(fieldByName.get("Duration with miliseconds")?.field_settings || "{}").duration_format).toBe("h:mm:ss.sss");
      expect(JSON.parse(fieldByName.get("Percent")?.field_settings || "{}")).toMatchObject({ number_suffix: "%", number_negative: false });
      expect(JSON.parse(fieldByName.get("Currency")?.field_settings || "{}")).toMatchObject({ number_prefix: "$", number_separator: "" });

      const views = (await db.prepare("SELECT * FROM database_view WHERE table_id=? ORDER BY [order] ASC").bind(data.id).all()).results;
      expect(views.map((view: any) => view.type)).toEqual(["grid", "grid", "gallery"]);
      expect(storedFiles.length).toBeGreaterThanOrEqual(3);
      const reportFields = (await db.prepare("SELECT * FROM database_field WHERE table_id=?").bind(report.id).all()).results;
      const reportObjectName = reportFields.find((field: any) => field.name === "Object name");
      const reportRows = (await db.prepare(`SELECT * FROM "database_table_${report.id}" ORDER BY id ASC`).all()).results;
      expect(reportRows.some((row: any) => String(row[`field_${reportObjectName.id}`] || "").includes("Barcode"))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("merges paged Airtable table responses before creating fields and rows", async () => {
    const fixture = airtableFixture();
    const formViewData = fixture.ordersData.viewDatas.find((view: any) => view.id === "viwOrdersForm");
    fixture.ordersData.viewDatas = fixture.ordersData.viewDatas.filter((view: any) => view.id !== "viwOrdersForm");
    let formViewPageRequests = 0;
    const db = createTestD1();
    const env = {
      DB: db,
      FILES: { put: async () => undefined },
      JOBS_QUEUE: { send: async () => undefined },
      PUBLIC_URL: "https://opentabl.test",
    } as any;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://airtable.com/appFixture") {
        return new Response(`<html><script>requestId: "reqFixture",</script><script>window.initData = ${JSON.stringify(fixture.initData)};\n</script></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://airtable.com/v0.3/application/appFixture/read")) {
        const params = airtableRequestParams(url);
        if (params.offset === "customers-page-2") {
          return jsonResponse({ data: { ...fixture.customersData, rows: [fixture.customersData.rows[1]], viewDatas: [] } });
        }
        return jsonResponse({
          data: {
            ...fixture.schema,
            tableDatas: [{ ...fixture.customersData, rows: [fixture.customersData.rows[0]], nextOffset: "customers-page-2" }],
          },
        });
      }
      if (url.startsWith("https://airtable.com/v0.3/table/tblOrders/readData")) {
        const params = airtableRequestParams(url);
        if (params.offset === "orders-page-2") {
          return jsonResponse({ data: { ...fixture.ordersData, rows: [fixture.ordersData.rows[1]], viewDatas: [] } });
        }
        return jsonResponse({
          data: {
            ...fixture.ordersData,
            rows: [fixture.ordersData.rows[0]],
            pagination: { next: { offset: "orders-page-2" } },
          },
        });
      }
      if (url.startsWith("https://airtable.com/v0.3/table/tblPrimarySelect/readData")) return jsonResponse({ data: fixture.primarySelectData });
      if (url.startsWith("https://airtable.com/v0.3/view/viwOrdersForm/readData")) {
        formViewPageRequests += 1;
        const params = airtableRequestParams(url);
        if (params.offset === "form-page-2") {
          return jsonResponse({ data: { id: "viwOrdersForm", rowOrder: ["recOrder2"] } });
        }
        return jsonResponse({
          data: {
            ...formViewData,
            rowOrder: ["recOrder1"],
            nextOffset: "form-page-2",
          },
        });
      }
      if (url === "https://signed.airtable.test/ok.png") return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png", "content-length": "3" } });
      if (url.startsWith("https://files.airtable.test/denied.pdf") || url.includes("/downloadAttachment")) return new Response("denied", { status: 403 });
      throw new Error(`Unexpected paged Airtable fixture request: ${url}`);
    });

    await importAirtableBase(env, {
      workspace_id: 1,
      airtable_share_url: "https://airtable.com/appFixture",
    }, 7);
    fetchMock.mockRestore();

    const app = await db.prepare("SELECT * FROM core_application WHERE name=?").bind("Fixture Airtable Base").first<any>();
    const customers = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Customers").first<any>();
    const orders = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Orders").first<any>();
    const customerRows = (await db.prepare(`SELECT * FROM "database_table_${customers.id}" ORDER BY [order]`).all()).results;
    const orderRows = (await db.prepare(`SELECT * FROM "database_table_${orders.id}" ORDER BY [order]`).all()).results;
    expect(customerRows).toHaveLength(2);
    expect(orderRows).toHaveLength(2);
    const customerStatus = await db.prepare("SELECT * FROM database_field WHERE table_id=? AND name=?").bind(customers.id, "Status").first<any>();
    const statusOptions = (await db.prepare("SELECT value FROM database_selectoption WHERE field_id=? ORDER BY [order]").bind(customerStatus.id).all()).results;
    expect(statusOptions.map((option: any) => option.value)).toEqual(["Active", "Lead"]);
    expect(formViewPageRequests).toBe(2);
    const importedForm = await db.prepare("SELECT * FROM database_view WHERE table_id=? AND name=?")
      .bind(orders.id, "Orders form")
      .first<any>();
    expect(importedForm?.type).toBe("form");
  });

  it("compensates D1 dynamic tables and new R2 files when an import fails after creation", async () => {
    const fixture = airtableFixture();
    fixture.ordersData.rows[0].cellValuesByColumnId.fldFiles.push({
      id: "attSecond",
      url: "https://files.airtable.test/ok.png",
      filename: "second.png",
      type: "image/png",
      size: 3,
    });
    const db = createTestD1();
    const r2Objects = new Set<string>();
    const deletedR2Objects: string[] = [];
    const failingDb = {
      database: db.database,
      batch: db.batch.bind(db),
      prepare(sql: string) {
        if (sql.includes("INSERT INTO database_view")) throw new Error("forced view persistence failure");
        return db.prepare(sql);
      },
    };
    const env = {
      DB: failingDb,
      FILES: {
        async put(key: string) {
          r2Objects.add(key);
        },
        async delete(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            deletedR2Objects.push(key);
            r2Objects.delete(key);
          }
        },
      },
      JOBS_QUEUE: { send: async () => undefined },
      PUBLIC_URL: "https://opentabl.test",
    } as any;
    const preexisting = await storeUserFile(env, {
      userId: 7,
      fileName: "ok.png",
      contentType: "image/png",
      size: 3,
      body: new Uint8Array([1, 2, 3]),
    });

    await withAirtableFetchFixture(async () => {
      await expect(importAirtableBase(env, {
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
      }, 7)).rejects.toThrow("forced view persistence failure");
    }, fixture);

    const applications = await db.prepare("SELECT COUNT(*) AS count FROM core_application").first<{ count: number }>();
    const tables = await db.prepare("SELECT COUNT(*) AS count FROM database_table").first<{ count: number }>();
    const dynamicTables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'database_table_[0-9]*'"
    ).all<{ name: string }>();
    const userFiles = await db.prepare("SELECT COUNT(*) AS count FROM core_userfile").first<{ count: number }>();
    expect(applications?.count).toBe(0);
    expect(tables?.count).toBe(0);
    expect(dynamicTables.results).toEqual([]);
    expect(userFiles?.count).toBe(1);
    expect(deletedR2Objects.length).toBeGreaterThan(0);
    expect(r2Objects).toEqual(new Set([preexisting.r2_key]));
  });

  it("fails explicitly when Airtable repeats a pagination cursor", async () => {
    const fixture = airtableFixture();
    const db = createTestD1();
    const env = {
      DB: db,
      FILES: { put: async () => undefined },
      JOBS_QUEUE: { send: async () => undefined },
      PUBLIC_URL: "https://opentabl.test",
    } as any;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://airtable.com/appFixture") {
        return new Response(`<html><script>requestId: "reqFixture",</script><script>window.initData = ${JSON.stringify(fixture.initData)};\n</script></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://airtable.com/v0.3/application/appFixture/read")) {
        return jsonResponse({
          data: {
            ...fixture.schema,
            tableDatas: [{ ...fixture.customersData, rows: [fixture.customersData.rows[0]], nextOffset: "repeated-cursor" }],
          },
        });
      }
      throw new Error(`Unexpected repeated-cursor fixture request: ${url}`);
    });

    await expect(importAirtableBase(env, {
      workspace_id: 1,
      airtable_share_url: "https://airtable.com/appFixture",
    }, 7)).rejects.toThrow("same pagination cursor twice");
    const applications = await db.prepare("SELECT COUNT(*) AS count FROM core_application").first<{ count: number }>();
    expect(applications?.count).toBe(0);
  });
});
