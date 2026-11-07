import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { handleQueue } from "../src/queue/handler";
import { addFieldColumn, getOrCreateUserTable, serializeFieldValueForInsert } from "../src/services/dynamic-tables";
import { enqueueAutomaticAIUpdates } from "../src/services/ai-auto-update";

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
  batch(statements: Array<{ all?: () => Promise<any>; first?: () => Promise<any>; run?: () => Promise<any> }>): Promise<any[]>;
};

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0001_initial.sql", "0051_last_password_change.sql",
    "0003_user_files.sql",
    "0005_templates.sql",
    "0006_field_rules_data_sync.sql",
    "0008_core_job_result.sql",
    "0009_builder_core.sql",
    "0019_premium_view_settings.sql",
    "0020_view_filter_groups.sql",
    "0021_workspace_trash.sql",
    "0028_userfile_supertask_name_hash.sql",
    "0039_builder_published_applications.sql",
    "0040_ai_field_scheduled_updates.sql",
  ]) {
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
    batch(statements) {
      return Promise.all(statements.map((statement) => statement.run ? statement.run() : statement.first ? statement.first() : statement.all?.()));
    },
  };
}

async function setupFixture() {
  const db = createTestD1();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
    .bind(now)
    .run();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (7, '', 'job@example.com', 'Job', '', 'job@example.com', 0, 1, ?)`
  ).bind(now).run();
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
    .run();

  const sentMessages: any[] = [];
  const files = new Map<string, { body: string; options?: any }>();
  const cache = new Map<string, string>();
  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    CACHE: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => { cache.set(key, value); },
      delete: async (key: string) => { cache.delete(key); },
    },
    FILES: {
      head: async () => null,
      put: async (key: string, body: any, options?: any) => {
        files.set(key, { body: typeof body === "string" ? body : await new Response(body).text(), options });
      },
      get: async (key: string) => {
        const file = files.get(key);
        return file ? { text: async () => file.body, httpMetadata: file.options?.httpMetadata || {} } : null;
      },
    },
    JOBS_QUEUE: {
      send: async (message: any) => {
        sentMessages.push(message);
      },
    },
    ENVIRONMENT: "test",
    PUBLIC_URL: "https://test.local",
  } as any;
  const token = await signAccessToken({ user_id: 7, email: "job@example.com", username: "job@example.com" }, "test-secret", 60);
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  return { db, env, token, ctx, sentMessages, files };
}

async function api(env: any, ctx: any, token: string, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://test.local${path}`, {
    ...init,
    headers: {
      authorization: `JWT ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }), env, ctx);
}

describe("job route parity", () => {
  it("exposes Supertask AI field settings and processes generate_ai_values jobs", async () => {
    const { db, env, ctx, token, sentMessages } = await setupFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
       VALUES (20, 10, 'AI rows', 1, 1, 0, ?, ?)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 20);
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on)
       VALUES
       (30, 20, 'Name', 'text', 1, 1, 0, 0, '{}', ?, ?),
       (31, 20, 'Summary', 'ai', 2, 0, 0, 0, ?, ?, ?),
       (32, 20, 'Last modified', 'last_modified', 3, 0, 1, 0, '{}', ?, ?),
       (33, 20, 'Last modified by', 'last_modified_by', 4, 0, 1, 0, '{}', ?, ?)`
    ).bind(
      now,
      now,
      JSON.stringify({
        ai_generative_ai_type: "openai",
        ai_generative_ai_model: "gpt-test",
        ai_output_type: "text",
        ai_temperature: null,
        ai_prompt: { formula: 'CONCAT("Summarize ", {Name})', mode: "simple", version: "0.1" },
        ai_file_field_id: null,
        ai_auto_update: false,
      }),
      now,
      now,
      now,
      now,
      now,
      now
    ).run();
    await addFieldColumn(db as any, 20, { id: 30, type: "text", primary: true });
    await addFieldColumn(db as any, 20, { id: 31, type: "ai" as any });
    await addFieldColumn(db as any, 20, { id: 32, type: "last_modified" });
    await addFieldColumn(db as any, 20, { id: 33, type: "last_modified_by" });
    await db.prepare(`INSERT INTO "database_table_20" (id, [order], trashed, field_30) VALUES (1, 10000, 0, 'Alpha')`).run();
    await db.prepare(`INSERT INTO "database_table_20" (id, [order], trashed, field_30) VALUES (2, 20000, 1, 'Trashed')`).run();

    const settings = await api(env, ctx, token, "/api/workspaces/1/settings/generative-ai/", {
      method: "PATCH",
      body: JSON.stringify({ openai: { api_key: "sk-test", models: ["gpt-test"] } }),
    });
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toMatchObject({
      id: 1,
      generative_ai_models_enabled: { openai: ["gpt-test"] },
    });

    const fields = await api(env, ctx, token, "/api/database/fields/table/20/");
    expect(fields.status).toBe(200);
    const serializedFields = await fields.json() as any[];
    expect(serializedFields.find((field) => field.id === 31)).toMatchObject({
      type: "ai",
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "text",
      ai_temperature: null,
      ai_file_field_id: null,
      ai_auto_update: false,
      ai_prompt: { formula: 'CONCAT("Summarize ", {Name})' },
    });

    let mutateScheduleDuringGeneration = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const prompt = body.messages?.[0]?.content || "";
      if (mutateScheduleDuringGeneration) {
        mutateScheduleDuringGeneration = false;
        await db.prepare(
          "UPDATE premium_aifieldscheduledupdate SET updated_on=? WHERE field_id=31 AND row_id=1"
        ).bind(new Date(Date.now() + 1000).toISOString()).run();
      }
      const content = prompt.includes("formula")
        ? 'CONCAT({Name}, "!")'
        : `Generated: ${prompt}`;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const formula = await api(env, ctx, token, "/api/database/fields/table/20/generate-ai-formula/", {
      method: "POST",
      body: JSON.stringify({
        ai_type: "openai",
        ai_model: "gpt-test",
        ai_temperature: null,
        ai_prompt: "formula for appending an exclamation mark",
      }),
    });
    expect(formula.status).toBe(200);
    await expect(formula.json()).resolves.toEqual({ formula: 'CONCAT({Name}, "!")' });

    const rejectedTrashedRow = await api(env, ctx, token, "/api/database/fields/31/generate-ai-field-values/", {
      method: "POST",
      body: JSON.stringify({ row_ids: [1, 2] }),
    });
    expect(rejectedTrashedRow.status).toBe(404);

    const created = await api(env, ctx, token, "/api/database/fields/31/generate-ai-field-values/", {
      method: "POST",
      body: JSON.stringify({ row_ids: [1] }),
    });
    expect(created.status).toBe(202);
    const createdJob = await created.json() as any;
    expect(createdJob).toMatchObject({
      type: "generate_ai_values",
      state: "pending",
      field_id: 31,
      row_ids: [1],
    });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      job_type: "generate_ai_values",
      payload: { field_id: 31, row_ids: [1] },
      workspace_id: 1,
    });

    const listed = await api(env, ctx, token, "/api/jobs/?type=generate_ai_values&generate_ai_values_field_id=31&limit=10&offset=0");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as any;
    expect(listedBody.count).toBe(1);
    expect(listedBody.results[0]).toMatchObject({ id: createdJob.id, field_id: 31 });

    const ack = vi.fn();
    sentMessages[0].payload.row_ids = [1, 2];
    await handleQueue({ messages: [{ body: sentMessages[0], ack }] } as any, env);
    expect(ack).toHaveBeenCalledOnce();
    const generatedRow = await db.prepare(`SELECT * FROM "database_table_20" WHERE id=1`).first<any>();
    expect(generatedRow).toMatchObject({
      field_31: "Generated: Summarize Alpha",
      _last_modified_by_id: 7,
    });
    expect(generatedRow.field_32).toBe(generatedRow._updated_on);
    expect(JSON.parse(generatedRow.field_33)).toEqual({ id: 7, name: "Job", email: "job@example.com" });
    await expect(db.prepare(`SELECT field_31 FROM "database_table_20" WHERE id=2`).first<any>())
      .resolves.toMatchObject({ field_31: null });
    await expect(db.prepare("SELECT status, progress_percentage, result FROM core_job WHERE id=?").bind(createdJob.id).first<any>())
      .resolves.toMatchObject({ status: "finished", progress_percentage: 100 });
    const storedJob = await db.prepare("SELECT result FROM core_job WHERE id=?").bind(createdJob.id).first<any>();
    expect(JSON.parse(storedJob.result)).toMatchObject({ row_ids: [1], generated_row_ids: [1], failed_rows: [] });

    const aiSettings = {
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "text",
      ai_temperature: null,
      ai_prompt: { formula: 'CONCAT("Summarize ", {Name})', mode: "simple", version: "0.1" },
      ai_file_field_id: null,
      ai_auto_update: true,
      ai_auto_update_user_id: 7,
    };
    await db.prepare("UPDATE database_field SET field_settings=? WHERE id=31")
      .bind(JSON.stringify(aiSettings))
      .run();
    await db.prepare(
      "INSERT INTO database_fielddependency (dependant_id, dependency_id) VALUES (31, 30)"
    ).run();
    await db.prepare(`UPDATE "database_table_20" SET field_31='Before stale generation' WHERE id=1`).run();

    expect(await enqueueAutomaticAIUpdates(env, 20, [1], new Set([30]))).toBe(1);
    expect(sentMessages).toHaveLength(2);
    mutateScheduleDuringGeneration = true;
    const staleAck = vi.fn();
    await handleQueue({ messages: [{ body: sentMessages[1], ack: staleAck }] } as any, env);
    expect(staleAck).toHaveBeenCalledOnce();
    await expect(db.prepare(`SELECT field_31 FROM "database_table_20" WHERE id=1`).first<any>())
      .resolves.toMatchObject({ field_31: "Before stale generation" });
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[2]).toMatchObject({
      job_type: "generate_ai_values",
      payload: { field_id: 31, row_ids: null, is_auto_update: true },
    });

    const latestAck = vi.fn();
    await handleQueue({ messages: [{ body: sentMessages[2], ack: latestAck }] } as any, env);
    expect(latestAck).toHaveBeenCalledOnce();
    await expect(db.prepare(`SELECT field_31 FROM "database_table_20" WHERE id=1`).first<any>())
      .resolves.toMatchObject({ field_31: "Generated: Summarize Alpha" });
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM premium_aifieldscheduledupdate WHERE field_id=31"
    ).first<any>())?.count).toBe(0);

    fetchSpy.mockRestore();
  });

  it("creates and cancels Airtable import jobs with the Supertask frontend contract", async () => {
    const { env, ctx, token, sentMessages } = await setupFixture();

    const invalid = await api(env, ctx, token, "/api/jobs/", {
      method: "POST",
      body: JSON.stringify({
        type: "airtable",
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
        session: "session-without-signature",
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "INVALID_REQUEST" });

    const create = await api(env, ctx, token, "/api/jobs/", {
      method: "POST",
      body: JSON.stringify({
        type: "airtable",
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
        skip_files: false,
        session: "airtable-session",
        session_signature: "airtable-signature",
      }),
    });
    expect(create.status).toBe(202);
    const created = await create.json() as any;
    expect(created).toMatchObject({
      id: 1,
      type: "airtable",
      state: "pending",
      status: "pending",
      progress_percentage: 0,
      user_id: 7,
    });
    expect(sentMessages).toEqual([
      expect.objectContaining({
        job_id: 1,
        job_type: "airtable",
        user_id: 7,
        workspace_id: 1,
        payload: expect.objectContaining({
          type: "airtable",
          workspace_id: 1,
          airtable_share_url: "https://airtable.com/appFixture",
          skip_files: false,
          session: "airtable-session",
          session_signature: "airtable-signature",
        }),
      }),
    ]);

    const list = await api(env, ctx, token, "/api/jobs/?states=pending&limit=10");
    expect(list.status).toBe(200);
    const listed = await list.json() as any;
    expect(listed.results).toHaveLength(1);
    expect(listed.results[0]).toMatchObject({ id: 1, type: "airtable", state: "pending" });

    const cancel = await api(env, ctx, token, "/api/jobs/1/cancel/", { method: "POST" });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ id: 1, state: "cancelled", status: "cancelled" });
  });

  it("processes queued Airtable jobs through the Worker queue and stores the finished import result", async () => {
    const { db, env, ctx, token, sentMessages } = await setupFixture();
    db.database.exec(`
      CREATE TABLE core_job_updates (status TEXT, progress_percentage INTEGER);
      CREATE TRIGGER core_job_progress_trace
      AFTER UPDATE OF status, progress_percentage ON core_job
      BEGIN
        INSERT INTO core_job_updates (status, progress_percentage)
        VALUES (NEW.status, NEW.progress_percentage);
      END;
    `);
    const fixture = {
      initData: {
        rawApplications: { appFixture: { name: "Queued Airtable Base" } },
        sharedApplicationId: "appFixture",
        accessPolicy: "{}",
        codeVersion: "fixture",
        pageLoadId: "pageFixture",
        singleApplicationScaffoldingData: { tableById: { tblMain: {} } },
      },
      schema: {
        appBlanket: true,
        tableSchemas: [
          {
            id: "tblMain",
            name: "Imported table",
            primaryColumnId: "fldName",
            meaningfulColumnOrder: [{ columnId: "fldName" }, { columnId: "fldStatus" }],
            columns: [
              { id: "fldName", name: "Name", type: "text" },
              {
                id: "fldStatus",
                name: "Status",
                type: "select",
                typeOptions: {
                  choices: {
                    selOpen: { id: "selOpen", name: "Open", color: "green" },
                    selDone: { id: "selDone", name: "Done", color: "blue" },
                  },
                  choiceOrder: ["selOpen", "selDone"],
                },
              },
            ],
            views: [{ id: "viwGrid", name: "Grid", type: "grid" }],
            viewOrder: ["viwGrid"],
          },
        ],
        tableDatas: [
          {
            id: "tblMain",
            rows: [
              {
                id: "recOne",
                createdTime: "2026-01-01T00:00:00.000Z",
                cellValuesByColumnId: {
                  fldName: "First imported row",
                  fldStatus: { id: "selOpen", name: "Open" },
                },
              },
            ],
            viewDatas: [{ id: "viwGrid", columnOrder: [{ columnId: "fldName" }, { columnId: "fldStatus" }] }],
          },
        ],
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://airtable.com/appFixture") {
        return new Response(`<html><script>requestId: "reqFixture",</script><script>window.initData = ${JSON.stringify(fixture.initData)};\n</script></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://airtable.com/v0.3/application/appFixture/read")) {
        return new Response(JSON.stringify({ data: fixture.schema }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Airtable request: ${url}`);
    });

    const create = await api(env, ctx, token, "/api/jobs/", {
      method: "POST",
      body: JSON.stringify({
        type: "airtable",
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appFixture",
      }),
    });
    expect(create.status).toBe(202);
    expect(sentMessages).toHaveLength(1);

    const ack = vi.fn();
    await handleQueue({ messages: [{ body: sentMessages[0], ack }] } as any, env);
    fetchMock.mockRestore();

    expect(ack).toHaveBeenCalledOnce();
    const job = await db.prepare("SELECT * FROM core_job WHERE id=1").first<any>();
    expect(job).toMatchObject({ status: "finished", progress_percentage: 100 });
    const progressUpdates = (await db.prepare("SELECT * FROM core_job_updates").all()).results;
    expect(progressUpdates.map((update: any) => update.status)).toEqual(expect.arrayContaining([
      "downloading-base",
      "converting",
      "finished",
    ]));
    expect(Math.max(...progressUpdates.map((update: any) => update.progress_percentage))).toBe(100);
    const result = JSON.parse(job.result);
    expect(result.database).toMatchObject({
      name: "Queued Airtable Base",
      type: "database",
      workspace_id: 1,
    });

    const app = await db.prepare("SELECT * FROM core_application WHERE name=?").bind("Queued Airtable Base").first<any>();
    const table = await db.prepare("SELECT * FROM database_table WHERE database_id=? AND name=?").bind(app.id, "Imported table").first<any>();
    const statusField = await db.prepare("SELECT * FROM database_field WHERE table_id=? AND name=?").bind(table.id, "Status").first<any>();
    expect(statusField).toMatchObject({ type: "single_select" });
    const options = (await db.prepare("SELECT value FROM database_selectoption WHERE field_id=? ORDER BY [order]").bind(statusField.id).all()).results;
    expect(options.map((option: any) => option.value)).toEqual(["Open", "Done"]);
    const rows = (await db.prepare(`SELECT * FROM "database_table_${table.id}"`).all()).results;
    expect(JSON.parse(rows[0][`field_${statusField.id}`])).toMatchObject({ value: "Open" });
  });

  it("stores Supertask-compatible Airtable job errors when the shared link is not a base", async () => {
    const { db, env, ctx, token, sentMessages } = await setupFixture();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://airtable.com/appViewOnly") {
        return new Response(`<html><script>requestId: "reqFixture",</script><script>window.initData = {"rawApplications":{},"accessPolicy":"{}"};\n</script></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected Airtable request: ${url}`);
    });

    const create = await api(env, ctx, token, "/api/jobs/", {
      method: "POST",
      body: JSON.stringify({
        type: "airtable",
        workspace_id: 1,
        airtable_share_url: "https://airtable.com/appViewOnly",
      }),
    });
    expect(create.status).toBe(202);

    const ack = vi.fn();
    await handleQueue({ messages: [{ body: sentMessages[0], ack }] } as any, env);
    fetchMock.mockRestore();

    const job = await db.prepare("SELECT * FROM core_job WHERE id=1").first<any>();
    expect(job).toMatchObject({
      status: "failed",
      progress_percentage: 100,
      error: "ERROR_JOB_FAILED",
      human_readable_error: "The shared link is not a base. It's probably a view and the Airtable import tool only supports shared bases.",
    });
  });

  it("processes queued table exports with typed Supertask values and without the old 10000 row cap", async () => {
    const { db, env, files } = await setupFixture();
    const now = "2026-07-09T10:00:00.000Z";
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (20, 10, 'Queued export table', 1, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 20);
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on,
        db_index, immutable_type, immutable_properties)
       VALUES (101, 20, 'Name', 'text', 1, 1, 0, 0, '{}', ?, ?, 1, 0, 0)`
    ).bind(now, now).run();
    await addFieldColumn(db as any, 20, { id: 101, type: "text", primary: true });
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on,
        db_index, immutable_type, immutable_properties)
       VALUES (102, 20, 'Status', 'single_select', 2, 0, 0, 0, '{}', ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await addFieldColumn(db as any, 20, { id: 102, type: "single_select" });
    await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (301, 102, 'Open', 'green', 1)")
      .run();

    db.database.exec("BEGIN");
    const insert = db.database.prepare(
      `INSERT INTO "database_table_20" (id, [order], field_101, field_102, _created_on, _updated_on)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const status = serializeFieldValueForInsert("single_select", { id: 301, value: "Open", color: "green" });
    for (let index = 1; index <= 10001; index += 1) {
      insert.run(index, index * 10000, `Row ${index}`, status, now, now);
    }
    db.database.exec("COMMIT");

    await db.prepare(
      `INSERT INTO core_job (id, user_id, type, status, progress_percentage, created_on, updated_on)
       VALUES (77, 7, 'export_table', 'pending', 0, ?, ?)`
    ).bind(now, now).run();

    const ack = vi.fn();
    await handleQueue({
      messages: [{
        body: {
          job_id: 77,
          job_type: "export_table",
          user_id: 7,
          workspace_id: 1,
          payload: { table_id: 20, exporter_type: "csv" },
        },
        ack,
      }],
    } as any, env);

    expect(ack).toHaveBeenCalledOnce();
    const job = await db.prepare("SELECT * FROM core_job WHERE id=77").first<any>();
    expect(job).toMatchObject({ status: "finished", progress_percentage: 100 });
    const exportJob = await db.prepare("SELECT * FROM database_exportjob WHERE job_ptr_id=77").first<any>();
    expect(exportJob).toMatchObject({ table_id: 20, exporter_type: "csv" });
    expect(exportJob.exported_file_name).toMatch(/^exports\/table-20-.*Queued_export_table\.csv$/);
    const exported = files.get(exportJob.exported_file_name);
    expect(exported?.options?.httpMetadata?.contentType).toBe("text/csv;charset=utf-8");
    expect(exported?.body).toContain("id,Name,Status");
    expect(exported?.body).toContain("1,Row 1,Open");
    expect(exported?.body).toContain("10001,Row 10001,Open");
    expect(exported?.body).not.toContain("\"id\":301");
    expect(exported?.body).not.toContain("field_102");
  });

  it("processes queued CSV imports with quoted cells, typed values and more than 1000 rows", async () => {
    const { db, env, files } = await setupFixture();
    const now = "2026-07-09T11:00:00.000Z";
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (20, 10, 'CSV import table', 1, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 20);

    const fieldRows = [
      [101, "Name", "text", 1, 1, "{}"],
      [102, "Notes", "long_text", 2, 0, "{}"],
      [103, "Amount", "number", 3, 0, JSON.stringify({ number_decimal_places: 2, number_negative: false, number_separator: "SPACE_COMMA" })],
      [104, "Done", "boolean", 4, 0, "{}"],
      [105, "Status", "single_select", 5, 0, "{}"],
      [106, "Tags", "multiple_select", 6, 0, "{}"],
      [107, "Due", "date", 7, 0, JSON.stringify({ date_format: "EU", date_include_time: false })],
      [108, "Formula", "formula", 8, 0, JSON.stringify({ formula: "concat(field('Name'), ' computed')", formula_type: "text" })],
      [109, "Enabled", "boolean", 9, 0, JSON.stringify({ boolean_default: true })],
      [110, "Import UUID", "uuid", 10, 0, "{}"],
    ] as const;
    for (const [id, name, type, order, primary, settings] of fieldRows) {
      await db.prepare(
        `INSERT INTO database_field
         (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on,
          db_index, immutable_type, immutable_properties)
         VALUES (?, 20, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 0)`
      ).bind(
        id,
        name,
        type,
        order,
        primary,
        type === "formula" ? 1 : 0,
        settings,
        now,
        now,
        primary
      ).run();
      await addFieldColumn(db as any, 20, { id, type: type as any, primary: Boolean(primary) });
    }
    await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (301, 105, 'Open', 'green', 1)")
      .run();
    await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (302, 106, 'Red', 'red', 1)")
      .run();
    await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (303, 106, 'Blue', 'blue', 2)")
      .run();

    const rows = [
      "\ufeffName,Notes,Amount,Done,Status,Tags,Due,Formula",
      '"Acme, Inc.","Line ""quoted"", with comma","1 234,50",checked,Open,"Blue,Red",21/05/2026,SHOULD_NOT_STORE',
    ];
    for (let index = 2; index <= 1001; index += 1) {
      rows.push(`Row ${index},Plain ${index},${index},false,Open,Red,2026-05-21,IGNORED`);
    }
    await env.FILES.put("imports/7/customers.csv", rows.join("\r\n"), {
      httpMetadata: { contentType: "text/csv" },
    });

    await db.prepare(
      `INSERT INTO core_job (id, user_id, type, status, progress_percentage, created_on, updated_on)
       VALUES (88, 7, 'import_csv', 'pending', 0, ?, ?)`
    ).bind(now, now).run();

    const ack = vi.fn();
    await handleQueue({
      messages: [{
        body: {
          job_id: 88,
          job_type: "import_csv",
          user_id: 7,
          workspace_id: 1,
          payload: { table_id: 20, file_key: "imports/7/customers.csv" },
        },
        ack,
      }],
    } as any, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(files.get("imports/7/customers.csv")?.body).toContain("Acme, Inc.");
    const job = await db.prepare("SELECT * FROM core_job WHERE id=88").first<any>();
    expect(job).toMatchObject({ status: "finished", progress_percentage: 100 });
    const count = await db.prepare('SELECT COUNT(*) AS count FROM "database_table_20"').first<any>();
    expect(count.count).toBe(1001);
    const first = await db.prepare('SELECT * FROM "database_table_20" WHERE id=1').first<any>();
    expect(first).toMatchObject({
      field_101: "Acme, Inc.",
      field_102: 'Line "quoted", with comma',
      field_103: "n:1234.50",
      field_104: 1,
      field_107: "2026-05-21",
      field_108: null,
      field_109: 1,
      _created_by_id: 7,
      _last_modified_by_id: 7,
    });
    expect(first.field_110).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.parse(first.field_105)).toEqual({ id: 301, value: "Open", color: "green" });
    expect(JSON.parse(first.field_106)).toEqual([
      { id: 303, value: "Blue", color: "blue" },
      { id: 302, value: "Red", color: "red" },
    ]);
    const last = await db.prepare('SELECT * FROM "database_table_20" WHERE id=1001').first<any>();
    expect(last).toMatchObject({
      field_101: "Row 1001",
      field_103: "n:1001",
      field_104: 0,
      field_109: 1,
    });
    expect(last.field_110).toMatch(/^[0-9a-f-]{36}$/i);
    expect(last.field_110).not.toBe(first.field_110);
  });

  it("processes queued table duplication with fields, options, rows and view dependencies", async () => {
    const { db, env } = await setupFixture();
    const now = "2026-07-09T12:00:00.000Z";
    await db.prepare(
      `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (20, 10, 'Source table', 1, 1, 0, ?, ?, 0, 0, 0)`
    ).bind(now, now).run();
    await getOrCreateUserTable(db as any, 20);

    const fields = [
      [101, "Name", "text", 1, 1, "{}"],
      [102, "Status", "single_select", 2, 0, JSON.stringify({ single_select_default: 301 })],
      [103, "Tags", "multiple_select", 3, 0, JSON.stringify({ multiple_select_default: [302, 303] })],
      [104, "Related", "link_row", 4, 0, JSON.stringify({ link_row_table_id: 20 })],
      [105, "Computed", "formula", 5, 0, JSON.stringify({ formula: "field('Name')", formula_type: "text" })],
    ] as const;
    for (const [id, name, type, order, primary, settings] of fields) {
      await db.prepare(
        `INSERT INTO database_field
         (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on,
          db_index, immutable_type, immutable_properties)
         VALUES (?, 20, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 0)`
      ).bind(id, name, type, order, primary, type === "formula" ? 1 : 0, settings, now, now, primary).run();
      await addFieldColumn(db as any, 20, { id, type: type as any, primary: Boolean(primary) });
    }
    await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (301, 102, 'Open', 'green', 1)")
      .run();
    await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (302, 103, 'Red', 'red', 1)")
      .run();
    await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (303, 103, 'Blue', 'blue', 2)")
      .run();
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (501, 105, 101, NULL, NULL)"
    ).run();
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (502, 105, 101, 104, NULL)"
    ).run();
    await db.prepare(
      "INSERT INTO database_fielddependency (id, dependant_id, dependency_id, via_id, broken_reference_field_name) VALUES (503, 105, NULL, NULL, 'Missing field')"
    ).run();

    await db.prepare(
      `INSERT INTO "database_table_20"
       (id, [order], field_101, field_102, field_103, field_104, field_105, _created_on, _updated_on, _created_by_id, _last_modified_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      10,
      10000,
      "First row",
      serializeFieldValueForInsert("single_select", { id: 301, value: "Open", color: "green" }),
      serializeFieldValueForInsert("multiple_select", [
        { id: 302, value: "Red", color: "red" },
        { id: 303, value: "Blue", color: "blue" },
      ]),
      serializeFieldValueForInsert("link_row", [{ id: 11, value: "Second row" }]),
      null,
      now,
      now,
      7,
      7
    ).run();
    await db.prepare(
      `INSERT INTO "database_table_20"
       (id, [order], field_101, field_102, field_103, field_104, field_105, _created_on, _updated_on, _created_by_id, _last_modified_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      11,
      20000,
      "Second row",
      null,
      serializeFieldValueForInsert("multiple_select", [{ id: 303, value: "Blue", color: "blue" }]),
      serializeFieldValueForInsert("link_row", []),
      null,
      now,
      now,
      7,
      7
    ).run();

    await db.prepare(
      `INSERT INTO database_view (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug, trashed,
       created_on, updated_on, row_identifier_type, ownership_type, row_height_size)
       VALUES (401, 20, 'Grid', 'grid', 1, 'AND', 0, 0, 'source-grid', 0, ?, ?, 'count', 'collaborative', 'small')`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_gridviewfieldoptions
       (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (401, 102, 240, 0, 2, '', '')`
    ).run();
    await db.prepare("INSERT INTO database_viewfilter (view_id, field_id, type, value, preload_values) VALUES (401, 102, 'single_select_equal', ?, '{}')")
      .bind(serializeFieldValueForInsert("single_select", { id: 301, value: "Open", color: "green" }))
      .run();
    await db.prepare("INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (401, 101, 'ASC', 'default')")
      .run();

    await db.prepare(
      `INSERT INTO core_job (id, user_id, type, status, progress_percentage, created_on, updated_on)
       VALUES (99, 7, 'duplicate_table', 'pending', 0, ?, ?)`
    ).bind(now, now).run();

    const ack = vi.fn();
    await handleQueue({
      messages: [{
        body: {
          job_id: 99,
          job_type: "duplicate_table",
          user_id: 7,
          workspace_id: 1,
          payload: { source_table_id: 20, database_id: 10 },
        },
        ack,
      }],
    } as any, env);

    expect(ack).toHaveBeenCalledOnce();
    const job = await db.prepare("SELECT * FROM core_job WHERE id=99").first<any>();
    expect(job).toMatchObject({ status: "finished", progress_percentage: 100 });
    const result = JSON.parse(job.result);
    expect(result.report).toEqual({ failing_rows: {} });
    expect(result.original_table).toMatchObject({ id: 20, name: "Source table" });
    expect(result.duplicated_table).toMatchObject({ name: "Source table (copy)" });

    const duplicatedTableId = result.table_id;
    expect(duplicatedTableId).not.toBe(20);
    const duplicatedFields = (await db.prepare("SELECT * FROM database_field WHERE table_id=? ORDER BY [order] ASC")
      .bind(duplicatedTableId)
      .all()).results as any[];
    expect(duplicatedFields.map((field) => field.name)).toEqual(["Name", "Status", "Tags", "Related", "Computed"]);
    const duplicatedByName = Object.fromEntries(duplicatedFields.map((field) => [field.name, field]));
    expect(duplicatedByName.Status.id).not.toBe(102);
    expect(duplicatedByName.Tags.id).not.toBe(103);
    expect(duplicatedByName.Related.id).not.toBe(104);
    expect(duplicatedByName.Computed.id).not.toBe(105);

    const statusOptions = (await db.prepare("SELECT * FROM database_selectoption WHERE field_id=? ORDER BY [order]")
      .bind(duplicatedByName.Status.id)
      .all()).results as any[];
    const tagOptions = (await db.prepare("SELECT * FROM database_selectoption WHERE field_id=? ORDER BY [order]")
      .bind(duplicatedByName.Tags.id)
      .all()).results as any[];
    expect(statusOptions.map((option) => option.value)).toEqual(["Open"]);
    expect(tagOptions.map((option) => option.value)).toEqual(["Red", "Blue"]);
    expect(statusOptions[0].id).not.toBe(301);
    expect(tagOptions.map((option) => option.id)).not.toEqual([302, 303]);

    const statusSettings = JSON.parse(duplicatedByName.Status.field_settings);
    const tagsSettings = JSON.parse(duplicatedByName.Tags.field_settings);
    const relatedSettings = JSON.parse(duplicatedByName.Related.field_settings);
    expect(statusSettings.single_select_default).toBe(statusOptions[0].id);
    expect(tagsSettings.multiple_select_default).toEqual(tagOptions.map((option) => option.id));
    expect(relatedSettings.link_row_table_id).toBe(duplicatedTableId);
    const dependencies = (await db.prepare(
      `SELECT dependant_id, dependency_id, via_id, broken_reference_field_name
       FROM database_fielddependency
       WHERE dependant_id=?
       ORDER BY id ASC`
    ).bind(duplicatedByName.Computed.id).all()).results as any[];
    expect(dependencies).toEqual([
      {
        dependant_id: duplicatedByName.Computed.id,
        dependency_id: duplicatedByName.Name.id,
        via_id: null,
        broken_reference_field_name: null,
      },
      {
        dependant_id: duplicatedByName.Computed.id,
        dependency_id: duplicatedByName.Name.id,
        via_id: duplicatedByName.Related.id,
        broken_reference_field_name: null,
      },
      {
        dependant_id: duplicatedByName.Computed.id,
        dependency_id: null,
        via_id: null,
        broken_reference_field_name: "Missing field",
      },
    ]);

    const copiedRows = (await db.prepare(`SELECT * FROM "database_table_${duplicatedTableId}" ORDER BY [order] ASC`)
      .all()).results as any[];
    expect(copiedRows).toHaveLength(2);
    // Like Supertask's import_serialized, duplicated rows keep their ids.
    expect(copiedRows[0].id).toBe(10);
    expect(copiedRows[0][`field_${duplicatedByName.Name.id}`]).toBe("First row");
    expect(JSON.parse(copiedRows[0][`field_${duplicatedByName.Status.id}`])).toEqual({
      id: statusOptions[0].id,
      value: "Open",
      color: "green",
    });
    expect(JSON.parse(copiedRows[0][`field_${duplicatedByName.Tags.id}`])).toEqual([
      { id: tagOptions[0].id, value: "Red", color: "red" },
      { id: tagOptions[1].id, value: "Blue", color: "blue" },
    ]);
    expect(JSON.parse(copiedRows[0][`field_${duplicatedByName.Related.id}`])).toEqual([
      { id: copiedRows[1].id, value: "Second row" },
    ]);

    const duplicatedView = await db.prepare("SELECT * FROM database_view WHERE table_id=? AND name='Grid'")
      .bind(duplicatedTableId)
      .first<any>();
    expect(duplicatedView).toMatchObject({ type: "grid", filter_type: "AND" });
    expect(duplicatedView.slug).not.toBe("source-grid");
    const duplicatedFilter = await db.prepare("SELECT * FROM database_viewfilter WHERE view_id=?")
      .bind(duplicatedView.id)
      .first<any>();
    expect(duplicatedFilter.field_id).toBe(duplicatedByName.Status.id);
    expect(JSON.parse(duplicatedFilter.value)).toEqual({
      id: statusOptions[0].id,
      value: "Open",
      color: "green",
    });
    const duplicatedSort = await db.prepare("SELECT * FROM database_viewsort WHERE view_id=?")
      .bind(duplicatedView.id)
      .first<any>();
    expect(duplicatedSort.field_id).toBe(duplicatedByName.Name.id);
    const gridOption = await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=?")
      .bind(duplicatedView.id)
      .first<any>();
    expect(gridOption).toMatchObject({ field_id: duplicatedByName.Status.id, width: 240 });
  });
});
