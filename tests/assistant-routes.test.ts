import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { createAssistantTools } from "../src/services/assistant-tools";

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
  for (const file of readdirSync(join(process.cwd(), "migrations")).filter((file) => file.endsWith(".sql")).sort()) {
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

function createKv() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) || null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

async function createEnv() {
  const db = createTestD1();
  const kv = createKv();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Assistant workspace', ?, 0, 1)")
    .bind(now)
    .run();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, last_login, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (1, '!', NULL, 0, 'owner@example.com', 'Owner', '', 'owner@example.com', 1, 1, ?),
            (2, '!', NULL, 0, 'outsider@example.com', 'Outsider', '', 'outsider@example.com', 0, 1, ?)`
  ).bind(now, now).run();
  await db.prepare("INSERT INTO core_workspaceuser (id, workspace_id, user_id, [order], permissions, to_be_deleted) VALUES (1, 1, 1, 1, 'ADMIN', 0)")
    .run();
  const env = {
    DB: db,
    CACHE: kv,
    FILES: { head: async () => null },
    JOBS_QUEUE: { send: async () => undefined },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    MCP_SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    JWT_SIGNING_KEY: "test-secret",
    SECRET_KEY: "secret",
    ENVIRONMENT: "test",
    JWT_ACCESS_TTL_MINUTES: "10",
    JWT_REFRESH_TTL_DAYS: "7",
    PUBLIC_URL: "https://api.supertask.test",
    PUBLIC_WEB_FRONTEND_URL: "https://web.supertask.test",
  } as any;
  const ownerToken = await signAccessToken({ user_id: 1, email: "owner@example.com" }, "test-secret", 10);
  const outsiderToken = await signAccessToken({ user_id: 2, email: "outsider@example.com" }, "test-secret", 10);
  return { db, kv, env, ownerToken, outsiderToken };
}

async function request(env: any, token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `JWT ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return worker.fetch(
    new Request(`https://api.supertask.test${path}`, { ...init, headers }),
    env,
    toolExecutionContext(),
  );
}

function parseStreamEvents(body: string) {
  return body
    .split("\n\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function toolExecutionContext() {
  return {
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => undefined);
    },
    passThroughOnException() {},
    props: {},
  } as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enterprise assistant routes", () => {
  it("persists chats and returns a Baserow-shaped error stream when no provider is configured", async () => {
    const { env, ownerToken, outsiderToken } = await createEnv();
    const chatUuid = "11111111-1111-4111-8111-111111111111";

    const denied = await request(env, outsiderToken, "/assistant/chat/?workspace_id=1");
    expect(denied.status).toBe(403);

    const emptyList = await request(env, ownerToken, "/assistant/chat/?workspace_id=1");
    expect(await emptyList.json()).toMatchObject({ count: 0, results: [] });

    const response = await request(env, ownerToken, `/assistant/chat/${chatUuid}/messages/`, {
      method: "POST",
      body: JSON.stringify({
        content: "Create a table for invoices",
        ui_context: { workspace: { id: 1, name: "Assistant workspace" }, timezone: "Europe/Zurich" },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = parseStreamEvents(await response.text());
    expect(events.map((event) => event.type)).toEqual(["ai/started", "ai/thinking", "ai/error"]);
    expect(events[2].content).toContain("provider is not configured");

    const listed = await request(env, ownerToken, "/assistant/chat/?workspace_id=1");
    const listedBody: any = await listed.json();
    expect(listedBody.count).toBe(1);
    expect(listedBody.results[0]).toMatchObject({
      uuid: chatUuid,
      user_id: 1,
      workspace_id: 1,
      title: "Create a table for invoices",
      status: "idle",
    });

    const messages = await request(env, ownerToken, `/assistant/chat/${chatUuid}/messages/`);
    expect(await messages.json()).toMatchObject({
      messages: [
        {
          type: "human",
          content: "Create a table for invoices",
        },
      ],
    });

    const cancelled = await request(env, ownerToken, `/assistant/chat/${chatUuid}/cancel/`, { method: "DELETE" });
    expect(cancelled.status).toBe(204);
    const chat = await env.DB.prepare("SELECT status FROM enterprise_assistantchat WHERE uuid=?").bind(chatUuid).first<{ status: string }>();
    expect(chat?.status).toBe("canceling");
  });

  it("streams provider answers, stores predictions and accepts message feedback", async () => {
    const { env, kv, ownerToken } = await createEnv();
    const chatUuid = "22222222-2222-4222-8222-222222222222";
    await kv.put("workspace:1:generative-ai", JSON.stringify({
      openai: {
        api_key: "test-key",
        models: ["gpt-test"],
      },
    }));
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Use an invoices table with due dates and payment status." } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await request(env, ownerToken, `/assistant/chat/${chatUuid}/messages/`, {
      method: "POST",
      body: JSON.stringify({
        content: "How should I track invoices?",
        ui_context: {
          workspace: { id: 1, name: "Assistant workspace" },
          database: { id: "10", name: "Database" },
          timezone: "Europe/Zurich",
        },
      }),
    });
    expect(response.status).toBe(200);
    const events = parseStreamEvents(await response.text());
    expect(events.map((event) => event.type)).toEqual(["ai/started", "ai/thinking", "ai/message"]);
    expect(events[2]).toMatchObject({
      type: "ai/message",
      content: "Use an invoices table with due dates and payment status.",
      can_submit_feedback: true,
      human_sentiment: null,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();

    const messagesResponse = await request(env, ownerToken, `/assistant/chat/${chatUuid}/messages/`);
    const messagesBody: any = await messagesResponse.json();
    expect(messagesBody.messages).toHaveLength(2);
    expect(messagesBody.messages[1]).toMatchObject({
      type: "ai/message",
      content: "Use an invoices table with due dates and payment status.",
      can_submit_feedback: true,
      human_sentiment: null,
    });

    const aiMessageId = messagesBody.messages[1].id;
    const feedback = await request(env, ownerToken, `/assistant/messages/${aiMessageId}/feedback/`, {
      method: "PUT",
      body: JSON.stringify({ sentiment: "DISLIKE", feedback: "Too generic" }),
    });
    expect(feedback.status).toBe(204);

    const updatedMessagesResponse = await request(env, ownerToken, `/assistant/chat/${chatUuid}/messages/`);
    const updatedMessages: any = await updatedMessagesResponse.json();
    expect(updatedMessages.messages[1].human_sentiment).toBe("DISLIKE");
    const prediction = await env.DB.prepare(
      "SELECT human_sentiment, human_feedback FROM enterprise_assistantchatprediction WHERE ai_response_id=?"
    ).bind(aiMessageId).first<{ human_sentiment: number; human_feedback: string }>();
    expect(prediction).toMatchObject({ human_sentiment: -1, human_feedback: "Too generic" });

    const humanFeedback = await request(env, ownerToken, `/assistant/messages/${messagesBody.messages[0].id}/feedback/`, {
      method: "PUT",
      body: JSON.stringify({ sentiment: "LIKE" }),
    });
    expect(humanFeedback.status).toBe(400);
    expect(await humanFeedback.json()).toMatchObject({ error: "ERROR_CANNOT_SUBMIT_MESSAGE_FEEDBACK" });
  });

  it("executes builder and table tools through the real API contracts and emits navigation", async () => {
    const { env, kv, ownerToken, db } = await createEnv();
    const chatUuid = "33333333-3333-4333-8333-333333333333";
    await kv.put("workspace:1:generative-ai", JSON.stringify({
      openai: {
        api_key: "test-key",
        models: ["gpt-test"],
      },
    }));
    const providerResponses = [
      {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "create-builder-call",
              type: "function",
              function: {
                name: "create_builders",
                arguments: JSON.stringify({
                  builders: [{ name: "Finance", type: "database" }],
                }),
              },
            }],
          },
        }],
      },
      {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "create-table-call",
              type: "function",
              function: {
                name: "create_tables",
                arguments: JSON.stringify({
                  database_id: 1,
                  tables: [
                    {
                      name: "Clients",
                      primary_field: { name: "Client", type: "text" },
                      fields: [],
                      sample_rows: [{ Client: "Acme" }],
                    },
                    {
                      name: "Invoices",
                      primary_field: { name: "Invoice", type: "text" },
                      fields: [
                        { name: "Amount", type: "number", number_decimal_places: 2 },
                        { name: "Customer", type: "link_row", linked_table: "Clients" },
                      ],
                      sample_rows: [{ Invoice: "INV-001", Amount: 125.5 }],
                    },
                  ],
                  add_sample_rows: true,
                }),
              },
            }],
          },
        }],
      },
      {
        choices: [{ message: { content: "Created the Finance database and its Invoices table." } }],
      },
    ];
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body || "{}"));
      const toolNames = requestBody.tools?.map((tool: any) => tool.function.name) || [];
      expect(toolNames).toContain("create_builders");
      expect(toolNames).toContain("create_tables");
      expect(toolNames).toContain("create_rows");
      expect(toolNames).toContain("table_and_fields_tool_factory");
      expect(toolNames).toContain("rows_tool_factory");
      expect(toolNames).toContain("views_tool_factory");
      expect(toolNames).toContain("workflow_tool_factory");
      const response = providerResponses.shift();
      if (!response) throw new Error("Unexpected provider request");
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await request(env, ownerToken, `/assistant/chat/${chatUuid}/messages/`, {
      method: "POST",
      body: JSON.stringify({
        content: "Create a Finance database with an Invoices table and one example invoice.",
        ui_context: {
          workspace: { id: 1, name: "Assistant workspace" },
          timezone: "Europe/Zurich",
        },
      }),
    });
    expect(response.status).toBe(200);
    const events = parseStreamEvents(await response.text());
    expect(events.some((event) => event.type === "ai/navigation" && event.location?.type === "database-table")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "ai/message",
      content: "Created the Finance database and its Invoices table.",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const application = await db.prepare("SELECT id, name, type FROM core_application WHERE workspace_id=1 AND name='Finance'")
      .first<{ id: number; name: string; type: string }>();
    expect(application).toMatchObject({ id: 1, name: "Finance", type: "database" });
    const table = await db.prepare("SELECT id, name FROM database_table WHERE database_id=1 AND name='Invoices'")
      .first<{ id: number; name: string }>();
    expect(table?.name).toBe("Invoices");
    const clientsTable = await db.prepare("SELECT id, name FROM database_table WHERE database_id=1 AND name='Clients'")
      .first<{ id: number; name: string }>();
    expect(clientsTable?.name).toBe("Clients");
    const fields = await db.prepare("SELECT id, name, type, [primary] FROM database_field WHERE table_id=? AND trashed=0 ORDER BY [order]")
      .bind(table!.id)
      .all();
    expect(fields.results).toMatchObject([
      { name: "Invoice", type: "text", primary: 1 },
      { name: "Amount", type: "number", primary: 0 },
      { name: "Customer", type: "link_row", primary: 0 },
    ]);
    const customerField = fields.results.find((field: any) => field.name === "Customer") as any;
    const customerResponse = await request(env, ownerToken, `/api/database/fields/${customerField.id}/`);
    expect(await customerResponse.json()).toMatchObject({ link_row_table_id: clientsTable!.id });
    const invoiceField = fields.results.find((field: any) => field.name === "Invoice") as any;
    const amountField = fields.results.find((field: any) => field.name === "Amount") as any;
    const row = await db.prepare(
      `SELECT "field_${invoiceField.id}" AS invoice, "field_${amountField.id}" AS amount
       FROM "database_table_${table!.id}" WHERE trashed=0`
    ).first<{ invoice: string; amount: string }>();
    expect(row).toMatchObject({ invoice: "INV-001", amount: "n:125.5" });
    const rowsResponse = await request(env, ownerToken, `/api/database/rows/table/${table!.id}/?user_field_names=true`);
    const rowsBody: any = await rowsResponse.json();
    expect(rowsBody.results[0]).toMatchObject({ Invoice: "INV-001", Amount: "125.50" });
  });

  it("propagates official knowledge-base sources to the streamed and persisted answer", async () => {
    const { env, kv, ownerToken } = await createEnv();
    const chatUuid = "44444444-4444-4444-8444-444444444444";
    await kv.put("workspace:1:generative-ai", JSON.stringify({
      openai: { api_key: "test-key", models: ["gpt-test"] },
    }));
    env.AI = {
      run: vi.fn(async () => ({ data: [Array.from({ length: 768 }, () => 0.1)] })),
    };
    env.KNOWLEDGE_BASE = {
      query: vi.fn(async () => ({
        matches: [
          {
            id: "doc-1",
            score: 0.84,
            metadata: {
              title: "Views",
              content: "Baserow supports grid and gallery views.",
              source_url: "https://baserow.io/user-docs/views",
            },
          },
          {
            id: "doc-2",
            score: 0.78,
            metadata: {
              title: "Views",
              content: "Create a view from the table sidebar.",
              source_url: "https://baserow.io/user-docs/views",
            },
          },
        ],
      })),
    };
    const responses = [
      {
        choices: [{ message: {
          content: null,
          tool_calls: [{
            id: "search-docs-call",
            type: "function",
            function: {
              name: "search_user_docs",
              arguments: JSON.stringify({ question: "How do Baserow views work?" }),
            },
          }],
        } }],
      },
      { choices: [{ message: { content: "Use the table sidebar to create a view." } }] },
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => (
      new Response(JSON.stringify(responses.shift()), { status: 200 })
    )));

    const response = await request(env, ownerToken, `/assistant/chat/${chatUuid}/messages/`, {
      method: "POST",
      body: JSON.stringify({
        content: "How do views work?",
        ui_context: { workspace: { id: 1, name: "Assistant workspace" } },
      }),
    });
    const events = parseStreamEvents(await response.text());
    expect(events.at(-1)).toMatchObject({
      type: "ai/message",
      sources: ["https://baserow.io/user-docs/views"],
    });

    const history = await request(env, ownerToken, `/assistant/chat/${chatUuid}/messages/`);
    const historyBody: any = await history.json();
    expect(historyBody.messages[1].sources).toEqual(["https://baserow.io/user-docs/views"]);
  });

  it("creates every source-shaped view and converts source-shaped filters", async () => {
    const { env, ownerToken } = await createEnv();
    const applicationResponse = await request(env, ownerToken, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "View database", type: "database", init_with_data: false }),
    });
    const application: any = await applicationResponse.json();
    const tableResponse = await request(env, ownerToken, `/api/database/tables/database/${application.id}/`, {
      method: "POST",
      body: JSON.stringify({ name: "Tasks" }),
    });
    const table: any = await tableResponse.json();
    const initialFieldsResponse = await request(env, ownerToken, `/api/database/fields/table/${table.id}/`);
    const initialFields: any[] = await initialFieldsResponse.json();
    const primary = initialFields.find((field) => field.primary);
    const createField = async (body: Record<string, unknown>) => {
      const response = await request(env, ownerToken, `/api/database/fields/table/${table.id}/`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    const amount = await createField({ name: "Amount", type: "number", number_decimal_places: 2 });
    const status = await createField({
      name: "Status",
      type: "single_select",
      select_options: [
        { value: "Open", color: "blue" },
        { value: "Closed", color: "green" },
      ],
    });
    const start = await createField({ name: "Start", type: "date", date_include_time: false });
    const end = await createField({ name: "End", type: "date", date_include_time: false });
    const attachment = await createField({ name: "Attachment", type: "file" });
    const navigation: any[] = [];
    const tools = createAssistantTools({
      env,
      executionCtx: toolExecutionContext(),
      authorization: `JWT ${ownerToken}`,
      user: { id: 1, email: "owner@example.com", username: "owner@example.com", is_staff: true, is_active: true },
      workspaceId: 1,
      uiContext: { workspace: { id: 1 }, timezone: "Europe/Zurich" },
      navigate: async (location) => navigation.push(location),
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const created: any = await tool("create_views").execute({
      table_id: table.id,
      views: [
        { name: "Dense grid", type: "grid", public: true, row_height: "medium" },
        { name: "Cards", type: "gallery", cover_field_id: attachment.id },
        { name: "Board", type: "kanban", column_field_id: status.id },
        { name: "Schedule", type: "calendar", date_field_id: start.id },
        { name: "Timeline", type: "timeline", start_date_field_id: start.id, end_date_field_id: end.id },
        {
          name: "Task form",
          type: "form",
          title: "Submit a task",
          description: "Task intake",
          submit_button_label: "Create task",
          receive_notification_on_submit: true,
          submit_action: "MESSAGE",
          submit_action_message: "Saved",
          field_options: [
            { field_id: primary.id, name: "Task", description: "Task name", required: true, order: 1 },
            { field_id: amount.id, name: "Budget", description: "Expected amount", required: false, order: 2 },
          ],
        },
      ],
    });
    expect(created.created_views).toHaveLength(6);
    const byName = new Map(created.created_views.map((view: any) => [view.name, view]));
    expect(byName.get("Dense grid")).toMatchObject({ public: true, row_height_size: "medium" });
    expect(byName.get("Cards")).toMatchObject({ card_cover_image_field: attachment.id });
    expect(byName.get("Board")).toMatchObject({ single_select_field: status.id });
    expect(byName.get("Schedule")).toMatchObject({ date_field: start.id });
    expect(byName.get("Timeline")).toMatchObject({ start_date_field: start.id, end_date_field: end.id });
    const form: any = byName.get("Task form");
    expect(form).toMatchObject({
      title: "Submit a task",
      description: "Task intake",
      submit_text: "Create task",
      submit_action_message: "Saved",
    });
    expect(form.field_options).toMatchObject({
      [primary.id]: { name: "Task", enabled: true, required: true, order: 1 },
      [amount.id]: { name: "Budget", enabled: true, required: false, order: 2 },
    });
    expect(navigation[0]).toMatchObject({ type: "database-view", view_id: byName.get("Dense grid").id });

    const grid: any = byName.get("Dense grid");
    const filters: any = await tool("create_view_filters").execute({
      view_filters: [{
        view_id: grid.id,
        filters: [
          { field_id: primary.id, type: "text", operator: "contains", value: "invoice" },
          { field_id: amount.id, type: "number", operator: "higher_than", or_equal: true, value: 100 },
          { field_id: start.id, type: "date", operator: "after", or_equal: true, value: { year: 2026, month: 7, day: 12 }, mode: "exact_date" },
          { field_id: status.id, type: "single_select", operator: "is_any_of", value: ["Open"] },
        ],
      }],
    });
    const createdFilters = filters.created_view_filters[0].filters;
    expect(createdFilters).toMatchObject([
      { field: primary.id, type: "contains", value: "invoice" },
      { field: amount.id, type: "higher_than_or_equal", value: "100" },
      { field: start.id, type: "date_is_on_or_after", value: "Europe/Zurich?2026-07-12?exact_date" },
      { field: status.id, type: "single_select_is_any_of" },
    ]);
    expect(createdFilters[3].value).toBe(String(status.select_options.find((option: any) => option.value === "Open").id));
  });

  it("generates validated formulas from descriptions and executes all row mutation tools", async () => {
    const { env, ownerToken, db } = await createEnv();
    const applicationResponse = await request(env, ownerToken, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Formula database", type: "database", init_with_data: false }),
    });
    const application: any = await applicationResponse.json();
    const tableResponse = await request(env, ownerToken, `/api/database/tables/database/${application.id}/`, {
      method: "POST",
      body: JSON.stringify({ name: "Invoices" }),
    });
    const table: any = await tableResponse.json();
    const amountResponse = await request(env, ownerToken, `/api/database/fields/table/${table.id}/`, {
      method: "POST",
      body: JSON.stringify({ name: "Amount", type: "number", number_decimal_places: 2 }),
    });
    const amount: any = await amountResponse.json();
    const fieldsResponse = await request(env, ownerToken, `/api/database/fields/table/${table.id}/`);
    const fields: any[] = await fieldsResponse.json();
    const primary = fields.find((field) => field.primary);
    const generated = [
      JSON.stringify({ table_id: table.id, field_name: "Gross", formula: "if(" }),
      JSON.stringify({ table_id: table.id, field_name: "Gross", formula: "field('Amount') * 1.2" }),
    ];
    const generateText = vi.fn(async () => generated.shift() || "{}");
    const navigation: any[] = [];
    const tools = createAssistantTools({
      env,
      executionCtx: toolExecutionContext(),
      authorization: `JWT ${ownerToken}`,
      user: { id: 1, email: "owner@example.com", username: "owner@example.com", is_staff: true, is_active: true },
      workspaceId: 1,
      uiContext: { workspace: { id: 1 }, timezone: "Europe/Zurich" },
      navigate: async (location) => navigation.push(location),
      generateText,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const formula: any = await tool("generate_database_formula").execute({
      database_id: application.id,
      description: "Add 20 percent tax to Amount",
      save_to_field: true,
    });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(String(generateText.mock.calls[1][0])).toContain("Previous validation error");
    expect(formula).toMatchObject({
      table_id: table.id,
      field_name: "Gross",
      formula: "field('Amount') * 1.2",
      formula_type: "number",
      operation: "field created",
    });
    expect(navigation.at(-1)).toMatchObject({ type: "database-table", table_id: table.id });

    const created: any = await tool("create_rows").execute({
      table_id: table.id,
      rows: [
        { Name: "INV-001", Amount: 100 },
        { Name: "INV-002", Amount: 50 },
      ],
    });
    expect(created.created_rows).toHaveLength(2);
    expect(created.created_rows[0]).toMatchObject({ Name: "INV-001", Amount: "100.00", Gross: "120.00" });
    const listed: any = await tool("list_rows").execute({
      table_id: table.id,
      offset: 0,
      limit: 20,
      field_ids: [primary.id, amount.id],
    });
    expect(listed.total).toBe(2);
    expect(listed.rows).toMatchObject([
      { id: created.created_rows[0].id, Name: "INV-001", Amount: "100.00" },
      { id: created.created_rows[1].id, Name: "INV-002", Amount: "50.00" },
    ]);
    const updated: any = await tool("update_rows").execute({
      table_id: table.id,
      rows: [{ id: created.created_rows[0].id, Amount: 125 }],
    });
    expect(updated.updated_rows[0]).toMatchObject({ Amount: "125.00", Gross: "150.00" });
    await tool("delete_rows").execute({ table_id: table.id, row_ids: [created.created_rows[1].id] });
    const trashed = await db.prepare(`SELECT trashed FROM "database_table_${table.id}" WHERE id=?`)
      .bind(created.created_rows[1].id)
      .first<{ trashed: number }>();
    expect(trashed?.trashed).toBe(1);
  });

  it("creates source-shaped workflows with router branches and compensates failed graphs", async () => {
    const { env, ownerToken, db } = await createEnv();
    const databaseResponse = await request(env, ownerToken, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Automation data", type: "database", init_with_data: false }),
    });
    const database: any = await databaseResponse.json();
    const tableResponse = await request(env, ownerToken, `/api/database/tables/database/${database.id}/`, {
      method: "POST",
      body: JSON.stringify({ name: "Generated rows" }),
    });
    const table: any = await tableResponse.json();
    const fieldsResponse = await request(env, ownerToken, `/api/database/fields/table/${table.id}/`);
    const fields: any[] = await fieldsResponse.json();
    const primary = fields.find((field) => field.primary);
    const automationResponse = await request(env, ownerToken, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Assistant automation", type: "automation" }),
    });
    const automation: any = await automationResponse.json();
    const tools = createAssistantTools({
      env,
      executionCtx: toolExecutionContext(),
      authorization: `JWT ${ownerToken}`,
      user: { id: 1, email: "owner@example.com", username: "owner@example.com", is_staff: true, is_active: true },
      workspaceId: 1,
      uiContext: { workspace: { id: 1 }, timezone: "Europe/Zurich" },
      navigate: async () => undefined,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const baseline: any = await tool("list_workflows").execute({ automation_id: automation.id });
    const created: any = await tool("create_workflows").execute({
      automation_id: automation.id,
      workflows: [{
        name: "Route generated rows",
        trigger: {
          ref: "timer",
          label: "Every five minutes",
          type: "periodic",
          periodic_interval: { interval: "MINUTE", minute: 5, hour: 0, day_of_week: 0, day_of_month: 1 },
        },
        nodes: [
          {
            ref: "route",
            label: "Choose branch",
            type: "router",
            previous_node_ref: "timer",
            edges: [{ label: "Create", condition: "true" }],
          },
          {
            ref: "create",
            label: "Create generated row",
            type: "create_row",
            previous_node_ref: "route",
            router_edge_label: "Create",
            table_id: table.id,
            values: {
              [primary.id]: "Generated from {{ timer }}",
            },
          },
        ],
      }],
    });
    expect(created.created_workflows).toHaveLength(1);
    const workflowId = created.created_workflows[0].id;
    const workflow = await db.prepare("SELECT graph FROM automation_workflow WHERE id=? AND trashed=0")
      .bind(workflowId)
      .first<{ graph: string }>();
    const nodes = await db.prepare("SELECT id, type, service FROM automation_node WHERE workflow_id=? AND trashed=0 ORDER BY id")
      .bind(workflowId)
      .all<any>();
    expect(nodes.results.map((node) => node.type)).toEqual(["periodic", "router", "local_baserow_create_row"]);
    const triggerNode = nodes.results[0];
    const routerNode = nodes.results[1];
    const createNode = nodes.results[2];
    const routerService = JSON.parse(routerNode.service);
    const createService = JSON.parse(createNode.service);
    expect(routerService.edges[0]).toMatchObject({ label: "Create", condition: { formula: "true" } });
    expect(createService).toMatchObject({
      table_id: table.id,
      field_mappings: [{ field_id: primary.id, enabled: true }],
    });
    expect(createService.field_mappings[0].value.formula).toContain(`previous_node.${triggerNode.id}`);
    const graph = JSON.parse(workflow!.graph);
    expect(graph[String(routerNode.id)].next[routerService.edges[0].uid]).toEqual([createNode.id]);
    const listed: any = await tool("list_workflows").execute({ automation_id: automation.id });
    expect(listed.workflows.some((workflowItem: any) => workflowItem.id === workflowId)).toBe(true);

    const now = new Date().toISOString();
    for (const [index, type] of ["smtp", "ai"].entries()) {
      await db.prepare(
        `INSERT INTO core_integration (application_id, type, name, [order], configuration, created_on, updated_on)
         VALUES (?, ?, ?, ?, '{}', ?, ?)`
      ).bind(automation.id, type, `${type} integration`, String((index + 2) * 10000), now, now).run();
    }
    const remaining: any = await tool("create_workflows").execute({
      automation_id: automation.id,
      workflows: [
        {
          name: "All source actions",
          trigger: { ref: "timer", label: "Hourly", type: "periodic", periodic_interval: { interval: "HOUR", minute: 10 } },
          nodes: [
            {
              ref: "update",
              label: "Update row",
              type: "update_row",
              previous_node_ref: "timer",
              table_id: table.id,
              row_id: "1",
              values: { [primary.id]: "Updated by assistant" },
            },
            {
              ref: "delete",
              label: "Delete row",
              type: "delete_row",
              previous_node_ref: "update",
              table_id: table.id,
              row_id: "2",
            },
            {
              ref: "email",
              label: "Send email",
              type: "smtp_email",
              previous_node_ref: "delete",
              to_emails: "ops@example.com",
              cc_emails: "",
              bcc_emails: "",
              subject: "Workflow completed",
              body: "Updated row {{ update.id }}",
              body_type: "plain",
            },
            {
              ref: "ai",
              label: "Summarize",
              type: "ai_agent",
              previous_node_ref: "email",
              output_type: "choice",
              choices: ["success", "failure"],
              prompt: "Classify {{ email.id }}",
            },
          ],
        },
        {
          name: "Rows trigger",
          trigger: {
            ref: "row",
            label: "Rows created",
            type: "rows_created",
            rows_triggers_settings: { table_id: table.id },
          },
          nodes: [],
        },
        {
          name: "HTTP trigger",
          trigger: { ref: "http", label: "Public webhook", type: "http_trigger" },
          nodes: [],
        },
      ],
    });
    expect(remaining.created_workflows).toHaveLength(3);
    const allActionsId = remaining.created_workflows.find((item: any) => item.name === "All source actions").id;
    const allActionNodes = await db.prepare(
      "SELECT type, service FROM automation_node WHERE workflow_id=? AND trashed=0 ORDER BY id"
    ).bind(allActionsId).all<any>();
    expect(allActionNodes.results.map((node) => node.type)).toEqual([
      "periodic",
      "local_baserow_update_row",
      "local_baserow_delete_row",
      "smtp_email",
      "ai_agent",
    ]);
    const updateService = JSON.parse(allActionNodes.results[1].service);
    const deleteService = JSON.parse(allActionNodes.results[2].service);
    const emailService = JSON.parse(allActionNodes.results[3].service);
    const aiService = JSON.parse(allActionNodes.results[4].service);
    expect(updateService).toMatchObject({ table_id: table.id, row_id: { formula: "1" } });
    expect(updateService.field_mappings[0]).toMatchObject({ field_id: primary.id, value: { formula: "'Updated by assistant'" } });
    expect(deleteService).toMatchObject({ table_id: table.id, row_id: { formula: "2" } });
    expect(emailService).toMatchObject({
      to_emails: { formula: "'ops@example.com'" },
      subject: { formula: "'Workflow completed'" },
      body_type: "plain",
    });
    expect(emailService.body.formula).toContain("previous_node.");
    expect(aiService).toMatchObject({
      ai_output_type: "choice",
      ai_choices: ["success", "failure"],
    });
    expect(aiService.ai_prompt.formula).toContain("previous_node.");
    const rowTriggerId = remaining.created_workflows.find((item: any) => item.name === "Rows trigger").id;
    const rowTrigger = await db.prepare("SELECT type, service FROM automation_node WHERE workflow_id=? AND trashed=0")
      .bind(rowTriggerId).first<any>();
    expect(rowTrigger).toMatchObject({ type: "local_baserow_rows_created" });
    expect(JSON.parse(rowTrigger.service)).toMatchObject({ table_id: table.id });
    const httpTriggerId = remaining.created_workflows.find((item: any) => item.name === "HTTP trigger").id;
    const httpTrigger = await db.prepare("SELECT type, service FROM automation_node WHERE workflow_id=? AND trashed=0")
      .bind(httpTriggerId).first<any>();
    expect(httpTrigger).toMatchObject({ type: "http_trigger" });
    expect(JSON.parse(httpTrigger.service)).toMatchObject({ is_public: true, exclude_get: false });

    await expect(tool("create_workflows").execute({
      automation_id: automation.id,
      workflows: [{
        name: "Invalid graph",
        trigger: { ref: "timer", label: "Timer", type: "periodic", periodic_interval: { interval: "HOUR", minute: 0 } },
        nodes: [{
          ref: "bad",
          label: "Broken action",
          type: "create_row",
          previous_node_ref: "missing",
          table_id: table.id,
          values: { [primary.id]: "Never persisted" },
        }],
      }],
    })).rejects.toThrow("Unknown previous_node_ref: missing");
    const activeAfterFailure: any = await tool("list_workflows").execute({ automation_id: automation.id });
    expect(activeAfterFailure.workflows).toHaveLength(baseline.workflows.length + 4);
    expect(activeAfterFailure.workflows.some((workflowItem: any) => workflowItem.name === "Invalid graph")).toBe(false);
  });
});
