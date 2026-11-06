import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strFromU8, unzipSync } from "fflate";
import { addFieldColumn, getOrCreateUserTable, serializeFieldValueForInsert, type FieldType } from "../src/services/dynamic-tables";
import { buildTableExport } from "../src/services/table-export";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

type TestD1 = {
  database: DatabaseSync;
  prepare(sql: string): {
    bind(...args: unknown[]): { all(): Promise<{ results: any[] }>; first<T = any>(): Promise<T | null>; run(): Promise<object> };
    all(): Promise<{ results: any[] }>;
    first<T = any>(): Promise<T | null>;
    run(): Promise<object>;
  };
};

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_initial.sql", "0051_last_password_change.sql", "0003_user_files.sql", "0006_field_rules_data_sync.sql", "0028_userfile_baserow_name_hash.sql"]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
  return {
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
  };
}

function fakeR2(files: Record<string, string>) {
  return {
    async get(key: string) {
      const value = files[key];
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return {
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
  };
}

async function createField(
  db: TestD1,
  tableId: number,
  id: number,
  name: string,
  type: FieldType,
  order: number,
  settings: Record<string, unknown> = {},
  primary = false
) {
  const now = "2026-05-27T10:00:00.000Z";
  await db.prepare(
    `INSERT INTO database_field
     (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on, db_index,
      immutable_type, immutable_properties)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 0)`
  ).bind(
    id,
    tableId,
    name,
    type,
    order,
    primary ? 1 : 0,
    ["formula", "lookup", "rollup", "count", "autonumber", "uuid", "created_on", "last_modified", "created_by", "last_modified_by"].includes(type) ? 1 : 0,
    JSON.stringify(settings),
    now,
    now,
    primary ? 1 : 0
  ).run();
  await addFieldColumn(db as any, tableId, { id, type, primary });
}

async function setupExportFixture() {
  const db = createTestD1();
  const now = "2026-05-27T10:00:00.000Z";
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
    .bind(now)
    .run();
  await db.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (20, 10, 'Invoices', 1, 1, 0, ?, ?, 0, 0, 0)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (21, 10, 'Customers', 2, 1, 0, ?, ?, 0, 0, 0)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await getOrCreateUserTable(db as any, 21);

  await createField(db, 21, 201, "Customer name", "text", 1, {}, true);
  await createField(db, 20, 101, "Name", "text", 1, {}, true);
  await createField(db, 20, 102, "Status", "single_select", 2);
  await createField(db, 20, 103, "Tags", "multiple_select", 3);
  await createField(db, 20, 104, "Attachment", "file", 4);
  await createField(db, 20, 105, "Customer", "link_row", 5, { link_row_table_id: 21 });
  await createField(db, 20, 106, "Formula", "formula", 6, { formula: "concat(field('Name'), ' exported')", formula_type: "text" });
  await createField(db, 20, 107, "Date", "date", 7, { date_format: "EU", date_include_time: true, date_time_format: "24" });
  await createField(db, 20, 108, "Duration", "duration", 8);
  await createField(db, 20, 109, "Total", "number", 9, {
    number_decimal_places: 2,
    number_negative: false,
    number_prefix: "EUR ",
    number_suffix: " paid",
    number_separator: "SPACE_COMMA",
  });

  await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (301, 102, 'Todo', 'blue', 1)")
    .run();
  await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (302, 103, 'Red', 'red', 1)")
    .run();
  await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (303, 103, 'Blue', 'blue', 2)")
    .run();

  await db.prepare('INSERT INTO "database_table_21" (id, [order], field_201, _created_on, _updated_on) VALUES (1, 10000, ?, ?, ?)')
    .bind("Customer A", now, now)
    .run();
  await db.prepare(
    `INSERT INTO "database_table_20"
     (id, [order], field_101, field_102, field_103, field_104, field_105, field_107, field_108, field_109, _created_on, _updated_on)
     VALUES (1, 10000, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    "Invoice 1",
    serializeFieldValueForInsert("single_select", { id: 301, value: "Todo", color: "blue" }),
    serializeFieldValueForInsert("multiple_select", [
      { id: 302, value: "Red", color: "red" },
      { id: 303, value: "Blue", color: "blue" },
    ]),
    serializeFieldValueForInsert("file", [{ name: "stored.png", visible_name: "Contract.png", url: "https://files.test/stored.png" }]),
    serializeFieldValueForInsert("link_row", [{ id: 1, value: "Customer A" }]),
    "2020-01-02T01:23:00.000Z",
    serializeFieldValueForInsert("duration", 3660),
    serializeFieldValueForInsert("number", 1234.5),
    now,
    now
  ).run();

  return db;
}

describe("table export parity", () => {
  it("exports CSV with Baserow human values instead of raw D1 storage", async () => {
    const db = await setupExportFixture();

    const file = await buildTableExport(db as any, 20, { exporter_type: "csv" });

    expect(file.contentType).toBe("text/csv;charset=utf-8");
    expect(file.body).toBe(
      "\ufeffid,Name,Status,Tags,Attachment,Customer,Formula,Date,Duration,Total\r\n" +
      '1,Invoice 1,Todo,"Red,Blue",Contract.png,Customer A,Invoice 1 exported,02/01/2020 01:23,1:01,"EUR 1 234,50 paid"\r\n'
    );
    expect(file.body).not.toContain("field_");
    expect(file.body).not.toContain("\"id\":301");
  });

  it("exports typed JSON using field names and computed values", async () => {
    const db = await setupExportFixture();
    await createField(db, 20, 110, "Status", "text", 10);
    await createField(db, 20, 111, "Empty", "text", 11);
    await db.prepare('UPDATE "database_table_20" SET field_110=? WHERE id=1')
      .bind("Manual status")
      .run();

    const file = await buildTableExport(db as any, 20, {
      exporter_type: "json",
      fields: [106, 102, 110, 111, 104],
    });
    const rows = JSON.parse(file.body);

    expect(file.contentType).toBe("application/json");
    expect(rows).toEqual([
      {
        id: 1,
        Formula: "Invoice 1 exported",
        Status: { id: 301, value: "Todo", color: "blue" },
        "Status 2": "Manual status",
        Empty: "",
        Attachment: [{ name: "stored.png", visible_name: "Contract.png", url: "https://files.test/stored.png" }],
      },
    ]);
    expect(rows[0]).not.toHaveProperty("order");
  });

  it("exports XML using Baserow-safe tags and rich values", async () => {
    const db = await setupExportFixture();
    await createField(db, 20, 112, "123 status & type", "text", 10);
    await createField(db, 20, 113, "Empty XML", "text", 11);
    await db.prepare('UPDATE "database_table_20" SET field_112=? WHERE id=1')
      .bind("<open & close>")
      .run();

    const file = await buildTableExport(db as any, 20, {
      exporter_type: "xml",
      fields: [112, 113, 102, 104],
    });

    expect(file.contentType).toBe("application/xml;charset=utf-8");
    expect(file.extension).toBe("xml");
    expect(file.body).toBe(
      '<?xml version="1.0" encoding="utf-8" ?>\n' +
      "<rows>\n" +
      "<row>" +
      "<id>1</id>" +
      "<field-123-status-type>&lt;open &amp; close&gt;</field-123-status-type>" +
      "<Empty-XML></Empty-XML>" +
      "<Status><id>301</id><value>Todo</value><color>blue</color></Status>" +
      "<Attachment><item><name>stored.png</name><visible_name>Contract.png</visible_name><url>https://files.test/stored.png</url></item></Attachment>" +
      "</row>\n" +
      "</rows>\n"
    );
  });

  it("exports a real XLSX workbook with Baserow human values", async () => {
    const db = await setupExportFixture();

    const file = await buildTableExport(db as any, 20, {
      exporter_type: "excel",
      excel_include_header: true,
      fields: [101, 102, 103, 104, 107, 108, 109],
    });

    expect(file.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(file.extension).toBe("xlsx");
    expect(file.body).toBeInstanceOf(Uint8Array);

    const archive = unzipSync(file.body as Uint8Array);
    expect(Object.keys(archive)).toEqual(expect.arrayContaining([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
    ]));
    const sheet = strFromU8(archive["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t>id</t></is></c>');
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t>Name</t></is></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t>1</t></is></c>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t>Invoice 1</t></is></c>');
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t>Todo</t></is></c>');
    expect(sheet).toContain('<c r="D2" t="inlineStr"><is><t>Red,Blue</t></is></c>');
    expect(sheet).toContain('<c r="E2" t="inlineStr"><is><t>Contract.png</t></is></c>');
    expect(sheet).toContain('<c r="F2" t="inlineStr"><is><t>02/01/2020 01:23</t></is></c>');
    expect(sheet).toContain('<c r="G2" t="inlineStr"><is><t>1:01</t></is></c>');
    expect(sheet).toContain('<c r="H2" t="inlineStr"><is><t>EUR 1 234,50 paid</t></is></c>');
  });

  it("exports file field contents as a Baserow ZIP with optional row folders", async () => {
    const db = await setupExportFixture();
    const now = "2026-05-27T10:00:00.000Z";
    await db.prepare(
      `INSERT INTO core_userfile
       (id, user_id, name, original_name, r2_key, size, mime_type, is_image, image_width, image_height, uploaded_at)
       VALUES
       (1, NULL, 'stored.png', 'Contract.png', 'user_files/stored.png', 10, 'image/png', 1, 1, 1, ?),
       (2, NULL, 'second.pdf', 'Second.pdf', 'user_files/second.pdf', 11, 'application/pdf', 0, NULL, NULL, ?),
       (3, NULL, 'third.txt', 'Third.txt', 'user_files/third.txt', 12, 'text/plain', 0, NULL, NULL, ?)`
    ).bind(now, now, now).run();
    await db.prepare(
      `INSERT INTO "database_table_20"
       (id, [order], field_101, field_104, _created_on, _updated_on)
       VALUES (2, 20000, ?, ?, ?, ?)`
    ).bind(
      "Invoice 2",
      serializeFieldValueForInsert("file", [
        { name: "stored.png", visible_name: "Contract duplicate.png" },
        { name: "second.pdf", visible_name: "Second visible.pdf" },
        { name: "third.txt", visible_name: "Third visible.txt" },
        { name: "external.bin", visible_name: "External.bin", external: true, url: "https://example.com/external.bin" },
      ]),
      now,
      now
    ).run();

    const r2 = fakeR2({
      "user_files/stored.png": "stored-content",
      "user_files/second.pdf": "second-content",
      "user_files/third.txt": "third-content",
    });

    const flat = await buildTableExport(db as any, 20, {
      exporter_type: "file",
      organize_files: false,
      fields: [104],
    }, { files: r2 as any });
    expect(flat.contentType).toBe("application/zip");
    expect(flat.extension).toBe("zip");
    expect(flat.body).toBeInstanceOf(Uint8Array);
    const flatArchive = unzipSync(flat.body as Uint8Array);
    expect(Object.keys(flatArchive).sort()).toEqual(["second.pdf", "stored.png", "third.txt"]);
    expect(strFromU8(flatArchive["stored.png"])).toBe("stored-content");
    expect(strFromU8(flatArchive["second.pdf"])).toBe("second-content");
    expect(flatArchive["Contract.png"]).toBeUndefined();
    expect(flatArchive["external.bin"]).toBeUndefined();

    const organized = await buildTableExport(db as any, 20, {
      exporter_type: "file",
      organize_files: true,
      fields: [104],
    }, { files: r2 as any });
    const organizedArchive = unzipSync(organized.body as Uint8Array);
    expect(Object.keys(organizedArchive).sort()).toEqual([
      "row_1/stored.png",
      "row_2/second.pdf",
      "row_2/stored.png",
      "row_2/third.txt",
    ]);
    expect(strFromU8(organizedArchive["row_1/stored.png"])).toBe("stored-content");
    expect(strFromU8(organizedArchive["row_2/stored.png"])).toBe("stored-content");
  });
});
