import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateSync, strFromU8 } from "fflate";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { addFieldColumn, getOrCreateUserTable } from "../src/services/dynamic-tables";
import { connect } from "cloudflare:sockets";

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

const MIGRATIONS = [
  "0001_initial.sql",
  "0002_auth_sessions.sql",
  "0003_user_files.sql",
  "0004_core_settings_2fa.sql",
  "0005_templates.sql",
  "0006_field_rules_data_sync.sql",
  "0007_data_sync_schema_upgrade.sql",
  "0008_core_job_result.sql",
  "0009_builder_core.sql",
  "0029_builder_custom_code.sql",
  "0010_application_integrations_user_sources.sql",
  "0011_automation_core.sql",
  "0012_automation_published_versions.sql",
  "0013_automation_history_event_payload_simulation.sql",
  "0014_completed_guided_tours.sql",
  "0015_documents_dashboards.sql",
  "0017_mcp_endpoints.sql",
  "0018_enterprise_parity.sql",
  "0019_premium_view_settings.sql",
  "0020_view_filter_groups.sql",
  "0021_workspace_trash.sql",
  "0024_data_sync_periodic.sql",
  "0028_userfile_baserow_name_hash.sql",
  "0035_autonumber_sequences.sql",
  "0039_builder_published_applications.sql",
  "0044_user_source_sso_state.sql",
];

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    database.exec(readFileSync(join(process.cwd(), "migrations", migration), "utf8"));
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

async function setupBuilderFixture() {
  const db = createTestD1();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (7, '', 'owner@example.com', 'Owner', 'User', 'owner@example.com', 1, 1, ?)`
  ).bind(now).run();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
    .bind(now)
    .run();
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
    .run();
  await db.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?),
            (11, 1, 'Builder', 'builder', 2, 0, ?, ?)`
  ).bind(now, now, now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
     VALUES (20, 10, 'Contacts', 1, 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_field (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
     VALUES (30, 20, 'Name', 'text', 1, 1, 0, 0, '{}', ?, ?),
            (31, 20, 'Status', 'single_select', 2, 0, 0, 0, '{}', ?, ?),
            (32, 20, 'Tags', 'multiple_select', 3, 0, 0, 0, '{}', ?, ?),
            (33, 20, 'Enabled', 'boolean', 4, 0, 0, 0, '{"boolean_default":true}', ?, ?),
            (34, 20, 'UUID', 'uuid', 5, 0, 1, 0, '{}', ?, ?),
            (35, 20, 'Sequence', 'autonumber', 6, 0, 1, 0, '{}', ?, ?),
            (36, 20, 'Last modified', 'last_modified', 7, 0, 1, 0, '{}', ?, ?),
            (37, 20, 'Last modified by', 'last_modified_by', 8, 0, 1, 0, '{}', ?, ?),
            (38, 20, 'Created by', 'created_by', 9, 0, 1, 0, '{}', ?, ?),
            (39, 20, 'Attachment', 'file', 10, 0, 0, 0, '{}', ?, ?)`
  ).bind(...Array(20).fill(now)).run();
  await db.prepare(
    `INSERT INTO database_selectoption (id, field_id, value, color, [order])
     VALUES (401, 31, 'Active', 'green', 1),
            (402, 31, 'Paused', 'orange', 2),
            (403, 32, 'VIP', 'red', 1)`
  ).run();
  await getOrCreateUserTable(db as any, 20);
  await addFieldColumn(db as any, 20, { id: 30, type: "text", primary: true });
  await addFieldColumn(db as any, 20, { id: 31, type: "single_select" });
  await addFieldColumn(db as any, 20, { id: 32, type: "multiple_select" });
  await addFieldColumn(db as any, 20, { id: 33, type: "boolean" });
  await addFieldColumn(db as any, 20, { id: 34, type: "uuid" });
  await addFieldColumn(db as any, 20, { id: 35, type: "autonumber" });
  await addFieldColumn(db as any, 20, { id: 36, type: "last_modified" });
  await addFieldColumn(db as any, 20, { id: 37, type: "last_modified_by" });
  await addFieldColumn(db as any, 20, { id: 38, type: "created_by" });
  await addFieldColumn(db as any, 20, { id: 39, type: "file" });
  await db.prepare(
    `INSERT INTO builder_page
     (id, builder_id, name, path, path_params, query_params, shared, visibility, role_type, roles, settings, [order], created_on, updated_on)
     VALUES (99, 11, 'Shared', '__shared__', '[]', '[]', 1, 'all', 'allow_all', '[]', '{}', 0, ?, ?),
            (100, 11, 'Form', '/', '[]', '[]', 0, 'all', 'allow_all', '[]', '{}', 1, ?, ?)`
  ).bind(now, now, now, now).run();
  await db.prepare(
    `INSERT INTO builder_element
     (id, page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
     VALUES (600, 100, 'input_file', '10000', NULL, NULL, ?, ?, ?)`
  ).bind(JSON.stringify({
    label: { formula: "'Attachment'" },
    multiple: true,
    required: false,
    max_filesize: 1,
    allowed_filetypes: ["txt"],
    preview: false,
  }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_workflowaction
     (id, page_id, element_id, type, event, [order], configuration, created_on, updated_on)
     VALUES (200, 100, NULL, 'create_row', 'click', '10000', ?, ?, ?)`
  ).bind(JSON.stringify({
    service: {
      table_id: 20,
      field_mappings: [
        { field_id: 30, value: { formula: "get('form_data.500')" } },
      ],
    },
  }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_workflowaction
     (id, page_id, element_id, type, event, [order], configuration, created_on, updated_on)
     VALUES (201, 100, NULL, 'update_row', 'click', '20000', ?, ?, ?),
            (202, 100, NULL, 'logout', 'click', '30000', '{}', ?, ?)`
  ).bind(JSON.stringify({
    service: {
      table_id: 20,
      row_id: { formula: "get('previous_action.200.id')" },
      field_mappings: [
        { field_id: 30, value: { formula: "concat(get('previous_action.200.field_30'), ' Updated')" } },
      ],
    },
  }), now, now, now, now).run();
  await db.prepare(
    `INSERT INTO builder_workflowaction
     (id, page_id, element_id, type, event, [order], configuration, created_on, updated_on)
     VALUES (203, 100, NULL, 'create_row', 'click', '40000', ?, ?, ?)`
  ).bind(JSON.stringify({
    service: {
      table_id: 20,
      field_mappings: [
        {
          field_id: 30,
          value: {
            formula: "if(is_empty(get('form_data.501')), concat('fallback ', upper('guest')), replace(get('form_data.501'), ' ', '-'))",
          },
        },
      ],
    },
  }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_workflowaction
     (id, page_id, element_id, type, event, [order], configuration, created_on, updated_on)
     VALUES (204, 100, NULL, 'http_request', 'click', '50000', ?, ?, ?),
            (205, 100, NULL, 'smtp_email', 'click', '60000', ?, ?, ?),
            (206, 100, NULL, 'ai_agent', 'click', '70000', ?, ?, ?)`
  ).bind(
    JSON.stringify({
      service: {
        http_method: "GET",
        url: { formula: "'https://example.com/api'" },
        headers: [{ key: "Authorization", value: { formula: "'Bearer token'" } }],
        query_params: [],
        form_data: [],
        body_type: "none",
        body_content: { formula: "''" },
        timeout: 30,
        sample_data: {
          data: {
            body: {
              message: "ok",
              count: 2,
              nested: { enabled: true },
              rows: [{ name: "Ada" }, { name: "Grace", score: 10 }],
            },
            headers: {
              "x-request-id": "req_123",
              "x-ratelimit-remaining": 99,
            },
          },
        },
      },
    }),
    now,
    now,
    JSON.stringify({
      service: {
        integration_id: 9,
        from_email: { formula: "'sender@example.com'" },
        from_name: { formula: "'Sender'" },
        to_emails: { formula: "'recipient@example.com'" },
        cc_emails: { formula: "''" },
        bcc_emails: { formula: "''" },
        subject: { formula: "'Subject'" },
        body_type: "plain",
        body: { formula: "'Body'" },
      },
    }),
    now,
    now,
    JSON.stringify({
      service: {
        integration_id: 10,
        ai_generative_ai_type: "openai",
        ai_generative_ai_model: "gpt-test",
        ai_output_type: "text",
        ai_temperature: null,
        ai_prompt: { formula: "'Summarize'" },
        ai_choices: [],
      },
    }),
    now,
    now
  ).run();
  await db.prepare(
    `INSERT INTO builder_workflowaction
     (id, page_id, element_id, type, event, [order], configuration, created_on, updated_on)
     VALUES (208, 100, NULL, 'create_row', 'click', '90000', ?, ?, ?)`
  ).bind(JSON.stringify({
    service: {
      table_id: 20,
      field_mappings: [
        { field_id: 30, value: { formula: "'File upload'" } },
        { field_id: 39, value: { formula: "get('form_data.600')" } },
      ],
    },
  }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_datasource
     (id, page_id, type, name, [order], configuration, created_on, updated_on)
     VALUES (300, 100, 'local_baserow_get_row', 'Selected contact', '10000', ?, ?, ?)`
  ).bind(JSON.stringify({
    table_id: 20,
    row_id: { formula: "get('page_parameter.row_id')" },
  }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_datasource
     (id, page_id, type, name, [order], configuration, created_on, updated_on)
     VALUES (301, 100, 'local_baserow_aggregate_rows', 'Name count', '20000', ?, ?, ?)`
  ).bind(JSON.stringify({
    table_id: 20,
    field_id: 30,
    aggregation_type: "count",
  }), now, now).run();

  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    CACHE: { get: async () => null, put: async () => undefined },
    FILES: { head: async () => null, put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    ENVIRONMENT: "test",
    PUBLIC_URL: "https://api.supertask.test",
  } as any;
  const token = await signAccessToken({ user_id: 7, email: "owner@example.com", username: "owner@example.com" }, "test-secret", 60);
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  return { db, env, token, ctx };
}

async function api(env: any, ctx: any, token: string, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://api.supertask.test${path}`, {
    ...init,
    headers: {
      authorization: `JWT ${token}`,
      ...(init.headers || {}),
    },
  }), env, ctx);
}

async function publicApi(env: any, ctx: any, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://api.supertask.test${path}`, init), env, ctx);
}

describe("builder dispatch formula parity", () => {
  it("creates every active Builder element type with Baserow model defaults", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const expected: Record<string, Record<string, unknown>> = {
      column: { column_amount: 3, column_gap: 20, alignment: "top" },
      form_container: { reset_initial_values_post_submission: false },
      simple_container: {},
      table: { items_per_page: 20, fields: [], orientation: { smartphone: "horizontal", tablet: "horizontal", desktop: "horizontal" } },
      repeat: { orientation: "vertical", items_per_row: {}, horizontal_gap: 0, vertical_gap: 0 },
      record_selector: { required: false, multiple: false, data_source_id: null },
      heading: { level: 1 },
      text: { format: "plain" },
      link: { navigation_type: "page", navigate_to_page_id: null, target: "self", variant: "link" },
      image: { image_source_type: "upload", image_file: null },
      rating: { max_value: 5, color: "primary", rating_style: "star" },
      rating_input: { max_value: 5, required: false },
      input_text: { required: false, validation_type: "any", is_multiline: false, rows: 3, input_type: "text" },
      button: {},
      checkbox: { required: false },
      choice: { options: [], multiple: false, show_as_dropdown: true, option_type: "manual" },
      iframe: { source_type: "url", height: 300 },
      datetime_picker: { required: false, date_format: "EU", include_time: false, time_format: "24" },
      header: { share_type: "all", pages: [] },
      footer: { share_type: "all", pages: [] },
      menu: { orientation: "horizontal", alignment: "left", menu_items: [] },
      auth_form: { user_source_id: null },
      input_file: { multiple: false, required: false, max_filesize: 5, allowed_filetypes: [], preview: false },
    };

    for (const [type, typeDefaults] of Object.entries(expected)) {
      const pageId = type === "header" || type === "footer" ? 99 : 100;
      const response = await api(env, ctx, token, `/api/builder/page/${pageId}/elements/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type }),
      });
      expect(response.status, type).toBe(200);
      const element = await response.json() as any;
      expect(element, type).toMatchObject({
        type,
        visibility: "all",
        visibility_condition: { formula: "", mode: "simple", version: "0.1" },
        styles: {},
        style_padding_top: 10,
        style_padding_left: 20,
        style_background: "none",
        style_width: "normal",
        role_type: "allow_all",
        roles: [],
        ...typeDefaults,
      });
    }

    const unknown = await api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "unknown_element" }),
    });
    expect(unknown.status).toBe(400);
    const heading = await db.prepare("SELECT id, type FROM builder_element WHERE page_id=100 AND type='heading' ORDER BY id DESC LIMIT 1").first<any>();
    const changedType = await api(env, ctx, token, `/api/builder/element/${heading.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "text" }),
    });
    expect(changedType.status).toBe(400);
    expect(await db.prepare("SELECT type FROM builder_element WHERE id=?").bind(heading.id).first<any>()).toEqual({ type: "heading" });
  });

  it("enforces Baserow element placement rules without mutating rejected elements", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const create = (pageId: number, body: Record<string, unknown>) => api(
      env,
      ctx,
      token,
      `/api/builder/page/${pageId}/elements/`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );

    const countBefore = await db.prepare("SELECT COUNT(*) AS total FROM builder_element").first<{ total: number }>();
    expect((await create(100, { type: "header" })).status).toBe(400);
    expect((await create(99, { type: "text" })).status).toBe(400);
    expect(await db.prepare("SELECT COUNT(*) AS total FROM builder_element").first()).toEqual(countBefore);

    const headerResponse = await create(99, { type: "header" });
    expect(headerResponse.status).toBe(200);
    const header = await headerResponse.json() as any;
    const menuResponse = await create(99, { type: "menu", parent_element_id: header.id });
    expect(menuResponse.status).toBe(200);
    expect(await menuResponse.json()).toMatchObject({ parent_element_id: header.id, type: "menu" });
    expect((await create(99, { type: "footer", parent_element_id: header.id })).status).toBe(400);

    const columnResponse = await create(100, { type: "column", column_amount: 3 });
    const column = await columnResponse.json() as any;
    expect((await create(100, {
      type: "column",
      parent_element_id: column.id,
      place_in_container: "0",
    })).status).toBe(400);
    expect((await create(100, {
      type: "text",
      parent_element_id: column.id,
      place_in_container: "3",
    })).status).toBe(400);
    const childResponse = await create(100, {
      type: "text",
      parent_element_id: column.id,
      place_in_container: 2,
    });
    expect(childResponse.status).toBe(200);
    expect(await childResponse.json()).toMatchObject({ parent_element_id: column.id, place_in_container: "2" });

    const textResponse = await create(100, { type: "text" });
    const textElement = await textResponse.json() as any;
    const linkInNonContainer = await create(100, { type: "link", parent_element_id: textElement.id });
    expect(linkInNonContainer.status).toBe(200);
    expect((await create(99, { type: "link" })).status).toBe(200);

    const missingParent = await create(100, { type: "text", parent_element_id: 999999 });
    expect(missingParent.status).toBe(404);
    expect(await missingParent.json()).toMatchObject({ error: "ERROR_ELEMENT_DOES_NOT_EXIST" });
  });

  it("moves children when a Baserow column loses places and validates move defaults", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const create = async (body: Record<string, unknown>) => {
      const response = await api(env, ctx, token, "/api/builder/page/100/elements/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    const column = await create({ type: "column", column_amount: 3 });
    const first = await create({ type: "text", parent_element_id: column.id, place_in_container: "0" });
    const second = await create({ type: "text", parent_element_id: column.id, place_in_container: "1" });
    const third = await create({ type: "text", parent_element_id: column.id, place_in_container: "2" });

    const reduce = await api(env, ctx, token, `/api/builder/element/${column.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column_amount: 1 }),
    });
    expect(reduce.status).toBe(200);
    expect(await reduce.json()).toMatchObject({ column_amount: 1 });
    const children = await db.prepare(
      "SELECT id, place_in_container, CAST([order] AS REAL) AS element_order FROM builder_element WHERE parent_element_id=? ORDER BY element_order",
    ).bind(column.id).all<any>();
    expect(children.results?.map((child) => child.place_in_container)).toEqual(["0", "0", "0"]);
    expect(children.results?.map((child) => child.id)).toEqual([first.id, second.id, third.id]);

    const rejectedAmount = await api(env, ctx, token, `/api/builder/element/${column.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column_amount: 7 }),
    });
    expect(rejectedAmount.status).toBe(400);
    expect(JSON.parse((await db.prepare("SELECT configuration FROM builder_element WHERE id=?")
      .bind(column.id).first<any>()).configuration).column_amount).toBe(1);

    const rejectedChild = await api(env, ctx, token, `/api/builder/element/${first.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent_element_id: column.id, place_in_container: "1" }),
    });
    expect(rejectedChild.status).toBe(400);
    expect(await db.prepare("SELECT place_in_container FROM builder_element WHERE id=?").bind(first.id).first())
      .toEqual({ place_in_container: "0" });

    const moveToRoot = await api(env, ctx, token, `/api/builder/element/${second.id}/move/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ before_id: first.id }),
    });
    expect(moveToRoot.status).toBe(200);
    expect(await moveToRoot.json()).toMatchObject({ parent_element_id: null, place_in_container: null });

    const missingBefore = await api(env, ctx, token, `/api/builder/element/${third.id}/move/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ before_id: 999999 }),
    });
    expect(missingBefore.status).toBe(404);

    const headerResponse = await api(env, ctx, token, "/api/builder/page/99/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "header" }),
    });
    const header = await headerResponse.json() as any;
    const wrongPageBefore = await api(env, ctx, token, `/api/builder/element/${third.id}/move/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ before_id: header.id }),
    });
    expect(wrongPageBefore.status).toBe(400);
    expect(await wrongPageBefore.json()).toMatchObject({ error: "ERROR_ELEMENT_NOT_IN_SAME_PAGE" });

    const invalidMovePlace = await api(env, ctx, token, `/api/builder/element/${third.id}/move/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent_element_id: column.id, place_in_container: "1" }),
    });
    expect(invalidMovePlace.status).toBe(400);
    expect(await db.prepare("SELECT parent_element_id, place_in_container FROM builder_element WHERE id=?")
      .bind(third.id).first()).toEqual({ parent_element_id: column.id, place_in_container: "0" });
  });

  it("normalizes and validates every active Builder element formula field", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const formulaFields: Record<string, string[]> = {
      form_container: ["submit_button_label"],
      table: ["button_load_more_label"],
      repeat: ["button_load_more_label"],
      record_selector: ["button_load_more_label", "label", "default_value", "placeholder", "option_name_suffix"],
      heading: ["value"],
      text: ["value"],
      link: ["navigate_to_url", "value"],
      image: ["image_url", "alt_text"],
      rating: ["value"],
      rating_input: ["value", "label"],
      input_text: ["label", "default_value", "placeholder"],
      button: ["value"],
      checkbox: ["label", "default_value"],
      choice: ["label", "default_value", "placeholder", "formula_value", "formula_name"],
      iframe: ["url", "embed"],
      datetime_picker: ["label", "default_value"],
      auth_form: ["login_button_label"],
      input_file: ["label", "default_name", "default_url", "help_text"],
    };

    for (const [type, fields] of Object.entries(formulaFields)) {
      const body = Object.fromEntries(fields.map((field) => [field, "'Valid'"]));
      const response = await api(env, ctx, token, "/api/builder/page/100/elements/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, visibility_condition: "true", ...body }),
      });
      expect(response.status, type).toBe(200);
      const element = await response.json() as any;
      expect(element.visibility_condition, type).toEqual({ formula: "true", mode: "simple", version: "0.1" });
      for (const field of fields) {
        expect(element[field], `${type}.${field}`).toEqual({ formula: "'Valid'", mode: "simple", version: "0.1" });
      }
    }

    const countBefore = await db.prepare("SELECT COUNT(*) AS total FROM builder_element").first<{ total: number }>();
    const invalid = await api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "heading", value: "not a formula" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: { value: [{ code: "invalid" }] },
    });
    expect(await db.prepare("SELECT COUNT(*) AS total FROM builder_element").first()).toEqual(countBefore);

    const raw = await api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "heading", value: { formula: "not a formula", mode: "raw", version: "0.1" } }),
    });
    expect(raw.status).toBe(200);
    const rawElement = await raw.json() as any;
    expect(rawElement).toMatchObject({ value: { formula: "not a formula", mode: "raw", version: "0.1" } });

    const invalidMode = await api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "heading", value: { formula: "'Valid'", mode: "unknown" } }),
    });
    expect(invalidMode.status).toBe(400);
    expect(await invalidMode.json()).toMatchObject({
      detail: { value: { mode: [{ code: "invalid" }] } },
    });

    const configurationBefore = (await db.prepare("SELECT configuration FROM builder_element WHERE id=?")
      .bind(rawElement.id).first<any>()).configuration;
    const invalidUpdate = await api(env, ctx, token, `/api/builder/element/${rawElement.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "still not a formula" }),
    });
    expect(invalidUpdate.status).toBe(400);
    expect((await db.prepare("SELECT configuration FROM builder_element WHERE id=?")
      .bind(rawElement.id).first<any>()).configuration).toBe(configurationBefore);
  });

  it("validates nested link, menu and table collection formulas before D1 writes", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const create = (body: Record<string, unknown>) => api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const linkResponse = await create({
      type: "link",
      value: "'Open'",
      navigate_to_url: "'https://example.test'",
      page_parameters: [{ name: "id", value: "get('page_parameter.id')" }],
      query_parameters: [{ name: "q", value: { formula: "plain query", mode: "raw" } }],
    });
    expect(linkResponse.status).toBe(200);
    expect(await linkResponse.json()).toMatchObject({
      page_parameters: [{ value: { formula: "get('page_parameter.id')", mode: "simple", version: "0.1" } }],
      query_parameters: [{ value: { formula: "plain query", mode: "raw", version: "0.1" } }],
    });

    const tableResponse = await create({
      type: "table",
      fields: [
        { type: "boolean", value: "true" },
        { type: "rating", value: "5" },
        { type: "text", value: "'Name'" },
        {
          type: "link",
          link_name: "'Open'",
          navigate_to_url: "'https://example.test'",
          page_parameters: [{ name: "id", value: "1" }],
          query_parameters: [],
        },
        { type: "tags", values: "'One'", colors: "red", colors_is_formula: false },
        { type: "button", label: "'Run'" },
        { type: "image", src: "'https://example.test/image.png'", alt: "'Image'" },
      ],
    });
    expect(tableResponse.status).toBe(200);
    const table = await tableResponse.json() as any;
    expect(table.fields[4].colors).toEqual({ formula: "red", mode: "raw", version: "0.1" });
    expect(table.fields[3].page_parameters[0].value).toEqual({ formula: "1", mode: "simple", version: "0.1" });

    const menuResponse = await create({
      type: "menu",
      menu_items: [{
        name: "Home",
        navigate_to_url: "'https://example.test'",
        page_parameters: [{ name: "id", value: "1" }],
        query_parameters: [{ name: "q", value: "'search'" }],
      }],
    });
    expect(menuResponse.status).toBe(200);
    expect(await menuResponse.json()).toMatchObject({
      menu_items: [{ navigate_to_url: { formula: "'https://example.test'", mode: "simple", version: "0.1" } }],
    });

    const countBefore = await db.prepare("SELECT COUNT(*) AS total FROM builder_element").first<{ total: number }>();
    const invalidNested = await create({
      type: "table",
      fields: [{ type: "link", page_parameters: [{ name: "id", value: "not a formula" }] }],
    });
    expect(invalidNested.status).toBe(400);
    expect(await invalidNested.json()).toMatchObject({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: { fields: [{ page_parameters: [{ value: [{ code: "invalid" }] }] }] },
    });
    expect(await db.prepare("SELECT COUNT(*) AS total FROM builder_element").first()).toEqual(countBefore);
  });

  it("enforces Baserow auth form user source ownership on create and update", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO core_application
       (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
       VALUES (12, 1, 'Other builder', 'builder', 3, 0, ?, ?)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO core_usersource
       (id, application_id, integration_id, type, name, uid, [order], configuration, auth_providers, created_on, updated_on)
       VALUES (901, 11, NULL, 'database', 'Portal users', '__user_source_901', '10000', '{}', '[]', ?, ?),
              (902, 12, NULL, 'database', 'Other users', '__user_source_902', '10000', '{}', '[]', ?, ?)`
    ).bind(now, now, now, now).run();

    const validCreate = await api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "auth_form",
        user_source_id: 901,
        login_button_label: { formula: "'Sign in'", mode: "simple", version: "0.1" },
      }),
    });
    expect(validCreate.status).toBe(200);
    const authForm = await validCreate.json() as any;
    expect(authForm).toMatchObject({
      type: "auth_form",
      user_source_id: 901,
      login_button_label: { formula: "'Sign in'", mode: "simple", version: "0.1" },
    });

    const countBeforeRejectedCreate = await db.prepare(
      "SELECT COUNT(*) AS total FROM builder_element WHERE page_id=100"
    ).first<{ total: number }>();
    const foreignCreate = await api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "auth_form", user_source_id: 902 }),
    });
    expect(foreignCreate.status).toBe(400);
    expect(await foreignCreate.json()).toEqual({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: {
        user_source_id: [
          {
            detail: "The provided user source doesn't belong to the same application.",
            code: "invalid_user_source",
          },
        ],
      },
    });
    expect(await db.prepare(
      "SELECT COUNT(*) AS total FROM builder_element WHERE page_id=100"
    ).first<{ total: number }>()).toEqual(countBeforeRejectedCreate);

    const missingCreate = await api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "auth_form", user_source_id: 999999 }),
    });
    expect(missingCreate.status).toBe(404);
    expect(await missingCreate.json()).toEqual({
      error: "ERROR_USER_SOURCE_DOES_NOT_EXIST",
      detail: "The requested user_source does not exist.",
    });

    const foreignUpdate = await api(env, ctx, token, `/api/builder/element/${authForm.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_source_id: 902 }),
    });
    expect(foreignUpdate.status).toBe(400);
    expect((await db.prepare("SELECT configuration FROM builder_element WHERE id=?")
      .bind(authForm.id)
      .first<{ configuration: string }>())?.configuration).toContain('"user_source_id":901');

    const clearUpdate = await api(env, ctx, token, `/api/builder/element/${authForm.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_source_id: null }),
    });
    expect(clearUpdate.status).toBe(200);
    expect(await clearUpdate.json()).toMatchObject({ user_source_id: null });
  });

  it("validates and authenticates a Local Baserow user source end to end", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const cache = new Map<string, string>();
    env.CACHE = {
      get: async (key: string) => cache.get(key) || null,
      put: async (key: string, value: string) => { cache.set(key, value); },
    };
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES (40, 20, 'Password', 'password', 11, 0, 0, 0, '{}', ?, ?),
              (41, 20, 'Display name', 'text', 12, 0, 0, 0, '{}', ?, ?)`
    ).bind(now, now, now, now).run();
    await addFieldColumn(db as any, 20, { id: 40, type: "password" });
    await addFieldColumn(db as any, 20, { id: 41, type: "text" });

    const rowResponse = await api(env, ctx, token, "/api/database/rows/table/20/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field_30: "person@example.com",
        field_31: 401,
        field_40: "Secret123!",
        field_41: "Ada Lovelace",
      }),
    });
    expect(rowResponse.status).toBe(200);
    const userRow = await rowResponse.json() as any;
    expect(userRow.field_40).toBe(true);

    const integrationResponse = await api(env, ctx, token, "/api/application/11/integrations/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "local_baserow", name: "Portal database" }),
    });
    expect(integrationResponse.status).toBe(200);
    const integration = await integrationResponse.json() as any;

    const sourceResponse = await api(env, ctx, token, "/api/application/11/user-sources/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "local_baserow",
        name: "Portal users",
        integration_id: integration.id,
        table_id: 20,
        email_field_id: 30,
        name_field_id: 41,
        role_field_id: 31,
        auth_providers: [{
          id: 101,
          type: "local_baserow_password",
          enabled: true,
          password_field_id: 40,
        }],
      }),
    });
    expect(sourceResponse.status).toBe(200);
    const userSource = await sourceResponse.json() as any;
    expect(userSource).toMatchObject({
      type: "local_baserow",
      name: "Portal users",
      table_id: 20,
      email_field_id: 30,
      name_field_id: 41,
      role_field_id: 31,
      auth_providers: [{
        id: 101,
        type: "local_baserow_password",
        domain: null,
        password_field_id: 40,
      }],
    });
    expect(userSource.auth_providers[0].enabled).toBeUndefined();

    const invalidFieldUpdate = await api(env, ctx, token, `/api/user-source/${userSource.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email_field_id: 39 }),
    });
    expect(invalidFieldUpdate.status).toBe(400);
    expect(await invalidFieldUpdate.json()).toMatchObject({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: { email_field_id: [{ code: "invalid_field" }] },
    });
    expect(JSON.parse((await db.prepare("SELECT configuration FROM core_usersource WHERE id=?")
      .bind(userSource.id).first<any>()).configuration).email_field_id).toBe(30);

    const authFormResponse = await api(env, ctx, token, "/api/builder/page/100/elements/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "auth_form", user_source_id: userSource.id }),
    });
    expect(authFormResponse.status).toBe(200);
    expect(await authFormResponse.json()).toMatchObject({
      type: "auth_form",
      user_source_id: userSource.id,
    });

    const domainResponse = await api(env, ctx, token, "/api/builder/11/domains/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "custom", domain_name: "auth-builder.example.test" }),
    });
    expect(domainResponse.status).toBe(200);
    const domain = await domainResponse.json() as any;
    const publishResponse = await api(env, ctx, token, `/api/builder/domains/${domain.id}/publish/async/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain_id: domain.id }),
    });
    expect(publishResponse.status).toBe(200);
    const publication = await publishResponse.json() as any;
    const publishedBuilderResponse = await publicApi(
      env,
      ctx,
      "/api/builder/domains/published/by_name/auth-builder.example.test/",
    );
    expect(publishedBuilderResponse.status).toBe(200);
    const publishedBuilder = await publishedBuilderResponse.json() as any;
    const publishedSource = publishedBuilder.user_sources.find((item: any) => item.name === "Portal users");
    expect(publishedSource).toMatchObject({
      application_id: publication.published_builder_id,
      table_id: 20,
      email_field_id: 30,
      name_field_id: 41,
      role_field_id: 31,
    });
    expect(publishedSource.auth_providers).toEqual([{
      id: 101,
      type: "local_baserow_password",
      domain: null,
      password_field_id: 40,
    }]);
    const publishedPage = publishedBuilder.pages.find((item: any) => item.path === "/");
    const publishedElementsResponse = await publicApi(
      env,
      ctx,
      `/api/builder/domains/published/page/${publishedPage.id}/elements/`,
    );
    expect(publishedElementsResponse.status).toBe(200);
    expect(await publishedElementsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "auth_form", user_source_id: publishedSource.id }),
    ]));
    const republishResponse = await api(env, ctx, token, `/api/builder/domains/${domain.id}/publish/async/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain_id: domain.id }),
    });
    expect(republishResponse.status).toBe(200);
    const republication = await republishResponse.json() as any;
    expect(republication.published_builder_id).not.toBe(publication.published_builder_id);
    expect(await db.prepare("SELECT id FROM core_application WHERE id=?")
      .bind(publication.published_builder_id).first()).toBeNull();
    const republishedBuilderResponse = await publicApi(
      env,
      ctx,
      "/api/builder/domains/published/by_name/auth-builder.example.test/",
    );
    const republishedBuilder = await republishedBuilderResponse.json() as any;
    const republishedSource = republishedBuilder.user_sources.find((item: any) => item.name === "Portal users");
    expect(republishedSource).toMatchObject({
      application_id: republication.published_builder_id,
      uid: `domain_${domain.id}__${userSource.uid}`,
    });
    expect(republishedSource.id).not.toBe(publishedSource.id);

    const wrongPassword = await publicApi(env, ctx, `/api/user-source/${userSource.id}/token-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com", password: "wrong" }),
    });
    expect(wrongPassword.status).toBe(403);

    const login = await publicApi(env, ctx, `/api/user-source/${userSource.id}/token-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "PERSON@EXAMPLE.COM", password: "Secret123!" }),
    });
    expect(login.status).toBe(200);
    const tokens = await login.json() as any;
    expect(tokens.access_token).toEqual(expect.any(String));
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const roleUpdate = await api(env, ctx, token, `/api/database/rows/table/20/${userRow.id}/`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field_31: 402, field_41: "Grace Hopper" }),
    });
    expect(roleUpdate.status).toBe(200);
    const refresh = await publicApi(env, ctx, "/api/user-source-auth-refresh/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    expect(refresh.status).toBe(200);
    const refreshedTokens = await refresh.json() as any;
    const refreshedPayload = JSON.parse(
      Buffer.from(refreshedTokens.access_token.split(".")[1], "base64url").toString("utf8")
    );
    expect(refreshedPayload).toMatchObject({
      username: "Grace Hopper",
      email: "person@example.com",
      role: "Paused",
      user_source_id: userSource.id,
      user_source_uid: userSource.uid,
    });

    const blacklist = await publicApi(env, ctx, "/api/user-source-token-blacklist/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshedTokens.refresh_token }),
    });
    expect(blacklist.status).toBe(200);
    const blacklistedRefresh = await publicApi(env, ctx, "/api/user-source-auth-refresh/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshedTokens.refresh_token }),
    });
    expect(blacklistedRefresh.status).toBe(403);

    const secondLogin = await publicApi(env, ctx, `/api/user-source/${userSource.id}/token-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com", password: "Secret123!" }),
    });
    const secondTokens = await secondLogin.json() as any;
    expect((await api(env, ctx, token, `/api/database/rows/table/20/${userRow.id}/`, {
      method: "DELETE",
    })).status).toBe(200);
    const deletedUserRefresh = await publicApi(env, ctx, "/api/user-source-auth-refresh/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: secondTokens.refresh_token }),
    });
    expect(deletedUserRefresh.status).toBe(403);

    const invalidRefresh = await publicApi(env, ctx, "/api/user-source-auth-refresh/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "not-a-jwt" }),
    });
    expect(invalidRefresh.status).toBe(403);
  });

  it("runs the Builder user-source OpenID Connect flow with PKCE and creates the D1 user", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES (41, 20, 'Display name', 'text', 11, 0, 0, 0, '{}', ?, ?),
              (42, 20, 'id', 'text', 12, 0, 0, 0, '{}', ?, ?)`
    ).bind(now, now, now, now).run();
    await addFieldColumn(db as any, 20, { id: 41, type: "text" });
    await addFieldColumn(db as any, 20, { id: 42, type: "text" });

    const integration = await (await api(env, ctx, token, "/api/application/11/integrations/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "local_baserow", name: "Portal database" }),
    })).json() as any;
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://idp.example/.well-known/openid-configuration") {
        return Response.json({
          authorization_endpoint: "https://idp.example/authorize",
          token_endpoint: "https://idp.example/token",
          userinfo_endpoint: "https://idp.example/userinfo",
          jwks_uri: "https://idp.example/jwks",
          issuer: "https://idp.example",
        });
      }
      if (url === "https://idp.example/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code")).toBe("authorization-code");
        expect(body.get("code_verifier")).toBeTruthy();
        return Response.json({ access_token: "provider-access" });
      }
      if (url === "https://idp.example/userinfo") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-access");
        return Response.json({ email: "oidc-user@example.com", name: "OIDC User" });
      }
      throw new Error(`Unexpected OIDC request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sourceResponse = await api(env, ctx, token, "/api/application/11/user-sources/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "local_baserow",
        name: "OIDC users",
        integration_id: integration.id,
        table_id: 20,
        email_field_id: 30,
        name_field_id: 30,
        role_field_id: null,
        auth_providers: [{
          id: 77,
          type: "openid_connect",
          name: "Example IDP",
          base_url: "https://idp.example",
          client_id: "client-id",
          secret: "client-secret",
          email_attr_key: "email",
          first_name_attr_key: "name",
          last_name_attr_key: "",
          use_id_token: false,
        }],
      }),
      });
      expect(sourceResponse.status).toBe(200);
      const userSource = await sourceResponse.json() as any;
      expect(userSource.auth_providers[0]).toMatchObject({
        authorization_url: "https://idp.example/authorize",
        access_token_url: "https://idp.example/token",
        user_info_url: "https://idp.example/userinfo",
        jwks_url: "https://idp.example/jwks",
        issuer: "https://idp.example",
      });
      const oidcDomain = await (await api(env, ctx, token, "/api/builder/11/domains/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "custom", domain_name: "oidc-builder.example.test" }),
      })).json() as any;
      expect((await api(env, ctx, token, `/api/builder/domains/${oidcDomain.id}/publish/async/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain_id: oidcDomain.id }),
      })).status).toBe(200);
      const publicBuilder = await (await publicApi(
        env,
        ctx,
        "/api/builder/domains/published/by_name/oidc-builder.example.test/",
      )).json() as any;
      const publicOidcProvider = publicBuilder.user_sources
        .find((item: any) => item.name === "OIDC users")
        .auth_providers[0];
      expect(publicOidcProvider).toEqual({
        id: 77,
        type: "openid_connect",
        domain: null,
        name: "Example IDP",
        base_url: "https://idp.example",
      });
      const original = "https://task.mabza.dev/public/portal";
      const login = await publicApi(
      env,
      ctx,
      `/api/user-source/${encodeURIComponent(userSource.uid)}/sso/oauth2/openid_connect/login/?iss=${encodeURIComponent("https://idp.example")}&original=${encodeURIComponent(original)}`,
    );
    expect(login.status).toBe(302);
    const authorization = new URL(login.headers.get("location")!);
    expect(`${authorization.origin}${authorization.pathname}`).toBe("https://idp.example/authorize");
    expect(authorization.searchParams.get("client_id")).toBe("client-id");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("nonce")).toBeTruthy();
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    expect(callback.pathname).toBe(`/api/user-source/${userSource.id}_20_30_0/sso/oauth2/openid_connect/callback/`);
    const state = authorization.searchParams.get("state")!;
    expect(await db.prepare("SELECT kind FROM core_user_source_sso_state WHERE state=?")
      .bind(state).first<any>()).toMatchObject({ kind: "oidc" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://idp.example/.well-known/openid-configuration",
        expect.objectContaining({ headers: { accept: "application/json" } }),
      );
      const completed = await publicApi(
        env,
        ctx,
        `${callback.pathname}?state=${encodeURIComponent(state)}&code=authorization-code`,
      );
      expect(completed.status).toBe(302);
      const destination = new URL(completed.headers.get("location")!);
      expect(`${destination.origin}${destination.pathname}`).toBe(original);
      const refreshToken = destination.searchParams.get(`user_source_oidc_token__${userSource.id}`);
      expect(refreshToken).toBeTruthy();
      expect(await db.prepare("SELECT state FROM core_user_source_sso_state WHERE state=?")
        .bind(state).first<any>()).toBeNull();

      const refreshed = await publicApi(env, ctx, "/api/user-source-auth-refresh/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      expect(refreshed.status).toBe(200);
      const refreshedPayload = JSON.parse(
        Buffer.from(((await refreshed.json() as any).access_token).split(".")[1], "base64url").toString("utf8")
      );
      expect(refreshedPayload).toMatchObject({
        email: "oidc-user@example.com",
        username: "oidc-user@example.com",
        user_source_id: userSource.id,
      });
      const createdRow = await db.prepare(
        `SELECT field_30, field_41 FROM "database_table_20" WHERE COALESCE(trashed, 0)=0`
      ).first<any>();
      expect(createdRow).toMatchObject({ field_30: "oidc-user@example.com", field_41: null });

      const replay = await publicApi(
        env,
        ctx,
        `${callback.pathname}?state=${encodeURIComponent(state)}&code=authorization-code`,
      );
      expect(replay.status).toBe(302);
      expect(new URL(replay.headers.get("location")!).searchParams.get("oidc_error")).toBe("errorAuthFlowError");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("runs the Builder user-source SAML flow and keeps provider metadata private", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES (41, 20, 'Display name', 'text', 11, 0, 0, 0, '{}', ?, ?)`
    ).bind(now, now).run();
    await addFieldColumn(db as any, 20, { id: 41, type: "text" });

    const metadata = `
      <EntityDescriptor entityID="https://saml-idp.example/metadata" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
        <IDPSSODescriptor>
          <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://saml-idp.example/sso"/>
        </IDPSSODescriptor>
      </EntityDescriptor>`;
    const integration = await (await api(env, ctx, token, "/api/application/11/integrations/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "local_baserow", name: "Portal database" }),
    })).json() as any;
    const sourceResponse = await api(env, ctx, token, "/api/application/11/user-sources/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "local_baserow",
        name: "SAML users",
        integration_id: integration.id,
        table_id: 20,
        email_field_id: 30,
        name_field_id: 41,
        role_field_id: null,
        auth_providers: [{
          id: 88,
          type: "saml",
          domain: "example.com",
          metadata,
          email_attr_key: "email",
          first_name_attr_key: "first_name",
          last_name_attr_key: "last_name",
        }],
      }),
    });
    expect(sourceResponse.status).toBe(200);
    const userSource = await sourceResponse.json() as any;
    const original = "https://task.mabza.dev/public/portal";
    const login = await publicApi(
      env,
      ctx,
      `/api/user-source/${encodeURIComponent(userSource.uid)}/sso/saml/login/?email=${encodeURIComponent("saml-user@example.com")}&original=${encodeURIComponent(original)}`,
    );
    expect(login.status).toBe(302);
    const identityProviderUrl = new URL(login.headers.get("location")!);
    expect(`${identityProviderUrl.origin}${identityProviderUrl.pathname}`).toBe("https://saml-idp.example/sso");
    const relayState = new URL(identityProviderUrl.searchParams.get("RelayState")!);
    expect(relayState.searchParams.get("_baserow_saml_state")).toBeTruthy();
    relayState.searchParams.delete("_baserow_saml_state");
    expect(relayState.toString()).toBe(original);
    const authnRequest = strFromU8(inflateSync(Buffer.from(identityProviderUrl.searchParams.get("SAMLRequest")!, "base64")));
    expect(authnRequest).toContain('AssertionConsumerServiceURL="https://api.supertask.test/api/user-source/sso/saml/acs/"');

    const acsUrl = "https://api.supertask.test/api/user-source/sso/saml/acs/";
    const notBefore = new Date(Date.now() - 60_000).toISOString();
    const notOnOrAfter = new Date(Date.now() + 300_000).toISOString();
    const responseXml = `
      <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${now}" Destination="${acsUrl}">
        <saml:Issuer>https://saml-idp.example/metadata</saml:Issuer>
        <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
        <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${now}">
          <saml:Issuer>https://saml-idp.example/metadata</saml:Issuer>
          <saml:Subject>
            <saml:NameID>saml-user@example.com</saml:NameID>
            <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
              <saml:SubjectConfirmationData Recipient="${acsUrl}" NotOnOrAfter="${notOnOrAfter}"/>
            </saml:SubjectConfirmation>
          </saml:Subject>
          <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
            <saml:AudienceRestriction><saml:Audience>${acsUrl}</saml:Audience></saml:AudienceRestriction>
          </saml:Conditions>
          <saml:AttributeStatement>
            <saml:Attribute Name="email"><saml:AttributeValue>saml-user@example.com</saml:AttributeValue></saml:Attribute>
            <saml:Attribute Name="first_name"><saml:AttributeValue>SAML</saml:AttributeValue></saml:Attribute>
            <saml:Attribute Name="last_name"><saml:AttributeValue>User</saml:AttributeValue></saml:Attribute>
          </saml:AttributeStatement>
        </saml:Assertion>
      </samlp:Response>`;
    const completed = await publicApi(env, ctx, "/api/user-source/sso/saml/acs/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLResponse: Buffer.from(responseXml).toString("base64"),
        RelayState: identityProviderUrl.searchParams.get("RelayState")!,
      }),
    });
    expect(completed.status).toBe(302);
    const destination = new URL(completed.headers.get("location")!);
    expect(`${destination.origin}${destination.pathname}`).toBe(original);
    const refreshToken = destination.searchParams.get(`user_source_saml_token__${userSource.id}`);
    expect(refreshToken).toBeTruthy();
    const refreshed = await publicApi(env, ctx, "/api/user-source-auth-refresh/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const refreshedPayload = JSON.parse(
      Buffer.from(((await refreshed.clone().json() as any).access_token).split(".")[1], "base64url").toString("utf8")
    );
    expect(refreshedPayload).toMatchObject({ email: "saml-user@example.com", username: "SAML User" });
    const createdRow = await db.prepare(
      `SELECT field_30, field_41 FROM "database_table_20" WHERE COALESCE(trashed, 0)=0`
    ).first<any>();
    expect(createdRow).toMatchObject({ field_30: "saml-user@example.com", field_41: "SAML User" });

    const domain = await (await api(env, ctx, token, "/api/builder/11/domains/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "custom", domain_name: "saml-builder.example.test" }),
    })).json() as any;
    expect((await api(env, ctx, token, `/api/builder/domains/${domain.id}/publish/async/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain_id: domain.id }),
    })).status).toBe(200);
    const publicBuilder = await (await publicApi(
      env,
      ctx,
      "/api/builder/domains/published/by_name/saml-builder.example.test/",
    )).json() as any;
    const publicUserSource = publicBuilder.user_sources.find((item: any) => item.name === "SAML users");
    const publicProvider = publicUserSource.auth_providers[0];
    expect(publicProvider).toEqual({ id: 88, type: "saml", domain: "example.com" });
    expect(JSON.stringify(publicBuilder)).not.toContain("saml-idp.example/metadata");

    const publishedOriginal = "https://saml-builder.example.test/login";
    const publishedLogin = await publicApi(
      env,
      ctx,
      `/api/user-source/${encodeURIComponent(publicUserSource.uid)}/sso/saml/login/?email=${encodeURIComponent("saml-user@example.com")}&original=${encodeURIComponent(publishedOriginal)}`,
    );
    const publishedIdentityProviderUrl = new URL(publishedLogin.headers.get("location")!);
    const publishedCompleted = await publicApi(env, ctx, "/api/user-source/sso/saml/acs/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLResponse: Buffer.from(responseXml).toString("base64"),
        RelayState: publishedIdentityProviderUrl.searchParams.get("RelayState")!,
      }),
    });
    const publishedDestination = new URL(publishedCompleted.headers.get("location")!);
    expect(`${publishedDestination.origin}${publishedDestination.pathname}`).toBe(publishedOriginal);
    expect(publishedDestination.searchParams.get(`user_source_saml_token__${publicUserSource.id}`)).toBeTruthy();

    const unsafeRelay = await publicApi(env, ctx, "/api/user-source/sso/saml/acs/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLResponse: Buffer.from(responseXml).toString("base64"),
        RelayState: "https://attacker.example/steal",
      }),
    });
    expect(new URL(unsafeRelay.headers.get("location")!).host).toBe("task.mabza.dev");
  });

  it("validates Builder SAML and OIDC provider configuration like Baserow", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const integration = await (await api(env, ctx, token, "/api/application/11/integrations/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "local_baserow", name: "Portal database" }),
    })).json() as any;
    const base = {
      type: "local_baserow",
      name: "Validated users",
      integration_id: integration.id,
      table_id: 20,
      email_field_id: 30,
      name_field_id: 30,
      role_field_id: null,
    };
    const metadata = `
      <EntityDescriptor entityID="https://idp.example/metadata" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
        <IDPSSODescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/sso"/></IDPSSODescriptor>
      </EntityDescriptor>`;
    const duplicateSaml = await api(env, ctx, token, "/api/application/11/user-sources/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...base,
        auth_providers: [
          { id: 1, type: "saml", domain: "example.com", metadata },
          { id: 2, type: "saml", domain: "EXAMPLE.COM", metadata },
        ],
      }),
    });
    expect(duplicateSaml.status).toBe(400);
    expect(await duplicateSaml.json()).toMatchObject({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: { auth_providers: [{}, { domain: [{ code: "duplicate_domain" }] }] },
    });
    const invalidSaml = await api(env, ctx, token, "/api/application/11/user-sources/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...base,
        auth_providers: [{ id: 1, type: "saml", domain: "example.com", metadata: "<invalid>" }],
      }),
    });
    expect(invalidSaml.status).toBe(400);
    expect(await invalidSaml.json()).toMatchObject({
      detail: { auth_providers: [{ metadata: [{ code: "invalid" }] }] },
    });

    const originalFetch = globalThis.fetch;
    const discovery = vi.fn(async () => Response.json({
      authorization_endpoint: "https://oidc.example/authorize",
      token_endpoint: "https://oidc.example/token",
      userinfo_endpoint: "https://oidc.example/userinfo",
      jwks_uri: "https://oidc.example/jwks",
      issuer: "https://oidc.example",
    }));
    vi.stubGlobal("fetch", discovery);
    try {
      const oidcResponse = await api(env, ctx, token, "/api/application/11/user-sources/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...base,
          auth_providers: [{
            id: 3,
            type: "openid_connect",
            name: "OIDC",
            base_url: "https://oidc.example/",
            client_id: "client",
            secret: "secret",
          }],
        }),
      });
      expect(oidcResponse.status).toBe(200);
      const oidcSource = await oidcResponse.json() as any;
      expect(discovery).toHaveBeenCalledTimes(1);
      const renamed = await api(env, ctx, token, `/api/user-source/${oidcSource.id}/`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed users" }),
      });
      expect(renamed.status).toBe(200);
      expect(discovery).toHaveBeenCalledTimes(1);

      discovery.mockResolvedValueOnce(new Response(null, { status: 404 }));
      const invalidOidc = await api(env, ctx, token, "/api/application/11/user-sources/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...base,
          name: "Invalid OIDC users",
          auth_providers: [{
            id: 4,
            type: "openid_connect",
            name: "Invalid",
            base_url: "https://invalid-oidc.example",
            client_id: "client",
            secret: "secret",
          }],
        }),
      });
      expect(invalidOidc.status).toBe(400);
      expect(await invalidOidc.json()).toMatchObject({
        detail: { auth_providers: [{ base_url: [{ code: "invalid_url" }] }] },
      });
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
    expect((await db.prepare("SELECT COUNT(*) AS count FROM core_usersource").first<any>()).count).toBe(1);
  });

  it("serializes Local Baserow data source context data like Baserow", async () => {
    const { env, token, ctx } = await setupBuilderFixture();

    const response = await api(env, ctx, token, "/api/builder/page/100/data-sources/");
    expect(response.status).toBe(200);
    const dataSources = await response.json() as any[];
    const selectedContact = dataSources.find((item) => item.id === 300);
    expect(selectedContact.schema.properties.field_30).toMatchObject({
      title: "Name",
      original_type: "text",
      metadata: expect.objectContaining({ primary: true }),
    });
    expect(selectedContact.context_data).toEqual({
      field_31: [
        { id: 401, value: "Active", color: "green", order: 1 },
        { id: 402, value: "Paused", color: "orange", order: 2 },
      ],
      field_32: [
        { id: 403, value: "VIP", color: "red", order: 1 },
      ],
    });
    expect(selectedContact.context_data_schema).toMatchObject({
      type: "object",
      properties: {
        field_31: {
          type: "array",
          title: "Status",
          items: { properties: { id: { type: "number" }, value: { type: "string" }, color: { type: "string" } } },
        },
        field_32: {
          type: "array",
          title: "Tags",
        },
      },
    });
    expect(selectedContact.context_data_schema.properties.field_30).toBeUndefined();

    const aggregate = dataSources.find((item) => item.id === 301);
    expect(aggregate.schema.properties.result).toMatchObject({ title: "Name result", type: "number" });
    expect(aggregate.context_data.field).toMatchObject({ id: 30, name: "Name", type: "text" });
    expect(aggregate.context_data_schema).toBeNull();
  });

  it("serializes Local Baserow workflow action services like Baserow", async () => {
    const { env, token, ctx } = await setupBuilderFixture();

    const response = await api(env, ctx, token, "/api/builder/page/100/workflow_actions/");
    expect(response.status).toBe(200);
    const workflowActions = await response.json() as any[];
    const createRow = workflowActions.find((item) => item.id === 200);
    expect(createRow).toMatchObject({
      id: 200,
      page_id: 100,
      element_id: null,
      type: "create_row",
      event: "click",
    });
    expect(createRow.service).toMatchObject({
      id: 200,
      type: "local_baserow_upsert_row",
      table_id: 20,
      integration_id: null,
      sample_data: null,
    });
    expect(createRow.service.field_mappings).toEqual([
      { enabled: true, field_id: 30, value: { formula: "get('form_data.500')" } },
    ]);
    expect(createRow.service.schema.properties.field_30).toMatchObject({
      title: "Name",
      original_type: "text",
      metadata: expect.objectContaining({ id: 30, primary: true, read_only: false }),
    });
    expect(createRow.service.context_data).toEqual({
      field_31: [
        { id: 401, value: "Active", color: "green", order: 1 },
        { id: 402, value: "Paused", color: "orange", order: 2 },
      ],
      field_32: [
        { id: 403, value: "VIP", color: "red", order: 1 },
      ],
    });
    expect(createRow.service.context_data_schema).toMatchObject({
      type: "object",
      properties: {
        field_31: { type: "array", title: "Status" },
        field_32: { type: "array", title: "Tags" },
      },
    });
    expect(createRow.service.context_data_schema.properties.field_30).toBeUndefined();

    const updateRow = workflowActions.find((item) => item.id === 201);
    expect(updateRow.service).toMatchObject({
      type: "local_baserow_upsert_row",
      row_id: { formula: "get('previous_action.200.id')" },
    });
    expect(updateRow.service.schema.properties.field_31).toMatchObject({
      title: "Status",
      original_type: "single_select",
    });

    const logout = workflowActions.find((item) => item.id === 202);
    expect(logout.service).toBeUndefined();
  });

  it("serializes core workflow action service schemas like Baserow", async () => {
    const { env, token, ctx } = await setupBuilderFixture();

    const response = await api(env, ctx, token, "/api/builder/page/100/workflow_actions/");
    expect(response.status).toBe(200);
    const workflowActions = await response.json() as any[];

    const httpRequest = workflowActions.find((item) => item.id === 204);
    expect(httpRequest.service).toMatchObject({
      id: 204,
      type: "http_request",
      context_data: null,
      context_data_schema: null,
    });
    expect(httpRequest.service.schema).toMatchObject({
      title: "HTTPRequest204Schema",
      type: "object",
      properties: {
        body: {
          "$schema": "http://json-schema.org/schema#",
          title: "Body",
          type: "object",
          properties: {
            message: { type: "string" },
            count: { type: "integer" },
            nested: { type: "object", properties: { enabled: { type: "boolean" } } },
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  score: { type: "integer" },
                },
                required: ["name"],
              },
            },
          },
        },
        raw_body: { type: "string", title: "Raw body" },
        headers: {
          "$schema": "http://json-schema.org/schema#",
          title: "Headers",
          type: "object",
          properties: {
            "x-request-id": { type: "string" },
            "x-ratelimit-remaining": { type: "integer" },
          },
        },
        status_code: { type: "number", title: "Status code" },
      },
    });

    const smtp = workflowActions.find((item) => item.id === 205);
    expect(smtp.service.schema).toEqual({
      title: "SMTPEmail205Schema",
      type: "object",
      properties: {
        success: {
          type: "boolean",
          title: "Success",
          description: "Whether the email was sent successfully",
        },
      },
    });

    const ai = workflowActions.find((item) => item.id === 206);
    expect(ai.service.schema).toEqual({
      type: "object",
      title: "AIAgent206Schema",
      properties: {
        result: {
          type: "string",
          title: "AI Response",
        },
      },
    });

  });

  it("creates default service objects for new workflow action service types", async () => {
    const { env, token, ctx } = await setupBuilderFixture();

    const createRow = await api(env, ctx, token, "/api/builder/page/100/workflow_actions/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "create_row", event: "click" }),
    });
    expect(createRow.status).toBe(200);
    const createdCreateRow = await createRow.json() as any;
    expect(createdCreateRow.service).toMatchObject({
      type: "local_baserow_upsert_row",
      integration_id: null,
      table_id: null,
      row_id: { formula: "", mode: "simple", version: "0.1" },
      field_mappings: [],
      schema: null,
      context_data: null,
      context_data_schema: null,
    });

    const http = await api(env, ctx, token, "/api/builder/page/100/workflow_actions/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "http_request", event: "click" }),
    });
    expect(http.status).toBe(200);
    const createdHttp = await http.json() as any;
    expect(createdHttp.service).toMatchObject({
      type: "http_request",
      http_method: "GET",
      url: { formula: "", mode: "simple", version: "0.1" },
      headers: [],
      query_params: [],
      form_data: [],
      body_type: "none",
      body_content: { formula: "", mode: "simple", version: "0.1" },
      timeout: 30,
      context_data: null,
      context_data_schema: null,
    });
    expect(createdHttp.service.schema.properties).toMatchObject({
      raw_body: { type: "string", title: "Raw body" },
      headers: { type: "object", title: "Headers" },
      status_code: { type: "number", title: "Status code" },
    });
    expect(createdHttp.service.schema.properties.body).toBeUndefined();

    const smtp = await api(env, ctx, token, "/api/builder/page/100/workflow_actions/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "smtp_email", event: "click" }),
    });
    expect(smtp.status).toBe(200);
    const createdSmtp = await smtp.json() as any;
    expect(createdSmtp.service).toMatchObject({
      type: "smtp_email",
      integration_id: null,
      from_email: { formula: "", mode: "simple", version: "0.1" },
      to_emails: { formula: "", mode: "simple", version: "0.1" },
      body_type: "plain",
    });
    expect(createdSmtp.service.schema.properties.success).toMatchObject({ type: "boolean", title: "Success" });

    const ai = await api(env, ctx, token, "/api/builder/page/100/workflow_actions/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ai_agent", event: "click" }),
    });
    expect(ai.status).toBe(200);
    const createdAi = await ai.json() as any;
    expect(createdAi.service).toMatchObject({
      type: "ai_agent",
      integration_id: null,
      ai_generative_ai_type: null,
      ai_generative_ai_model: null,
      ai_output_type: "text",
      ai_temperature: null,
      ai_prompt: { formula: "", mode: "simple", version: "0.1" },
      ai_choices: [],
    });
    expect(createdAi.service.schema.properties.result).toMatchObject({ type: "string", title: "AI Response" });

    const slack = await api(env, ctx, token, "/api/builder/page/100/workflow_actions/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "slack_write_message", event: "click" }),
    });
    expect(slack.status).toBe(400);
  });

  it("rejects changing an existing workflow action to the removed Slack type", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const before = await db.prepare("SELECT type, configuration FROM builder_workflowaction WHERE id=200").first<any>();

    const response = await api(env, ctx, token, "/api/builder/workflow_action/200/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "slack_write_message" }),
    });

    expect(response.status).toBe(400);
    const after = await db.prepare("SELECT type, configuration FROM builder_workflowaction WHERE id=200").first<any>();
    expect(after).toEqual(before);
  });

  it("evaluates workflow action form metadata before writing row values", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const form = new FormData();
    form.set("metadata", JSON.stringify({ form_data: { "500": "Alice Example" } }));

    const response = await api(env, ctx, token, "/api/builder/workflow_action/200/dispatch/", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.field_30).toBe("Alice Example");
    expect(body).toMatchObject({ field_33: true, field_35: 1 });
    expect(body.field_34).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.field_36).toEqual(expect.any(String));
    expect(body.field_37).toEqual({ id: 7, name: "Owner User", email: "owner@example.com" });
    expect(body.field_38).toEqual(body.field_37);
    const stored = await db.prepare(`SELECT * FROM "database_table_20" WHERE id=?`).bind(body.id).first<any>();
    expect(stored).toMatchObject({
      field_30: "Alice Example",
      field_33: 1,
      field_35: "n:1",
      _created_by_id: 7,
      _last_modified_by_id: 7,
    });
    expect(stored.field_34).toBe(body.field_34);
    expect(stored.field_36).toBe(stored._updated_on);
  });

  it("uses dispatch metadata for local Baserow data source row formulas", async () => {
    const { env, token, ctx } = await setupBuilderFixture();
    const create = await api(env, ctx, token, "/api/builder/workflow_action/200/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { form_data: { "500": "Bob Example" } } }),
    });
    expect(create.status).toBe(200);
    const created = await create.json() as any;

    const response = await api(env, ctx, token, "/api/builder/data-source/300/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { page_parameter: { row_id: created.id } } }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.id).toBe(created.id);
    expect(body.field_30).toBe("Bob Example");
  });

  it("resolves previous action results for chained workflow actions", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const create = await api(env, ctx, token, "/api/builder/workflow_action/200/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { form_data: { "500": "Carol Example" } } }),
    });
    expect(create.status).toBe(200);
    const created = await create.json() as any;

    const update = await api(env, ctx, token, "/api/builder/workflow_action/201/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { previous_action: { "200": created }, current_dispatch_id: "dispatch-1" } }),
    });

    expect(update.status).toBe(200);
    const updated = await update.json() as any;
    expect(updated.id).toBe(created.id);
    expect(updated.field_30).toBe("Carol Example Updated");
    expect(updated.field_36).toEqual(expect.any(String));
    expect(updated.field_37).toEqual({ id: 7, name: "Owner User", email: "owner@example.com" });
    const stored = await db.prepare(`SELECT * FROM "database_table_20" WHERE id=?`).bind(created.id).first<any>();
    expect(stored.field_36).toBe(stored._updated_on);
    expect(JSON.parse(stored.field_37)).toEqual(updated.field_37);
  });

  it("duplicates builder pages with remapped chained workflow action references", async () => {
    const { env, token, ctx } = await setupBuilderFixture();

    const response = await api(env, ctx, token, "/api/builder/pages/100/duplicate/async/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const job = await response.json() as any;
    expect(job).toMatchObject({ state: "finished", type: "duplicate_builder_page" });

    const actionsResponse = await api(env, ctx, token, `/api/builder/page/${job.page_id}/workflow_actions/`);
    expect(actionsResponse.status).toBe(200);
    const actions = await actionsResponse.json() as any[];
    const create = actions.find((item) => item.type === "create_row" && item.order === "10000");
    const update = actions.find((item) => item.type === "update_row" && item.order === "20000");
    expect(create.id).not.toBe(200);
    expect(update.id).not.toBe(201);
    expect(update.service.row_id.formula).toBe(`get('previous_action.${create.id}.id')`);
    expect(update.service.field_mappings[0].value.formula)
      .toBe(`concat(get('previous_action.${create.id}.field_30'), ' Updated')`);
  });

  it("duplicates an element subtree and its workflow actions with remapped references", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO builder_element
       (id, page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
       VALUES (700, 100, 'simple_container', '90000', NULL, NULL, '{"style_padding_left":0}', ?, ?),
              (701, 100, 'button', '91000', 700, '0', '{"value":{"formula":"''"}}', ?, ?),
              (702, 100, 'text', '92000', NULL, NULL, '{"value":{"formula":"''"}}', ?, ?)`
    ).bind(now, now, now, now, now, now).run();
    await db.prepare(
      `INSERT INTO builder_workflowaction
       (id, page_id, element_id, type, event, [order], configuration, created_on, updated_on)
       VALUES (700, 100, 700, 'notification', 'click', '90000', '{"title":{"formula":"''"}}', ?, ?),
              (701, 100, 701, 'notification', 'click', '91000', ?, ?, ?)`
    ).bind(
      now,
      now,
      JSON.stringify({
        builder_element_id: 700,
        workflow_action_id: 700,
        title: { formula: "get('previous_action.700.title')" },
      }),
      now,
      now,
    ).run();

    const response = await api(env, ctx, token, "/api/builder/element/700/duplicate/", { method: "POST" });
    expect(response.status).toBe(200);
    const duplicated = await response.json() as any;
    expect(duplicated.elements).toHaveLength(2);
    expect(duplicated.workflow_actions).toHaveLength(2);
    const root = duplicated.elements.find((element: any) => element.type === "simple_container");
    const child = duplicated.elements.find((element: any) => element.type === "button");
    expect(root.id).not.toBe(700);
    expect(child.parent_element_id).toBe(root.id);
    expect(duplicated.elements.some((element: any) => element.id === 702)).toBe(false);

    const rootAction = duplicated.workflow_actions.find((action: any) => action.element_id === root.id);
    const childAction = duplicated.workflow_actions.find((action: any) => action.element_id === child.id);
    expect(rootAction.id).not.toBe(700);
    expect(childAction.builder_element_id).toBe(root.id);
    expect(childAction.workflow_action_id).toBe(rootAction.id);
    expect(childAction.title.formula).toBe(`get('previous_action.${rootAction.id}.title')`);
  });

  it("returns a stable response for frontend-local logout actions when dispatched directly", async () => {
    const { env, token, ctx } = await setupBuilderFixture();

    const response = await api(env, ctx, token, "/api/builder/workflow_action/202/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: {} }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ logged_out: true });
  });

  it("evaluates frontend runtime helper formulas before writing workflow action rows", async () => {
    const { env, token, ctx } = await setupBuilderFixture();

    const fallback = await api(env, ctx, token, "/api/builder/workflow_action/203/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { form_data: { "501": "" } } }),
    });
    expect(fallback.status).toBe(200);
    expect((await fallback.json() as any).field_30).toBe("fallback GUEST");

    const transformed = await api(env, ctx, token, "/api/builder/workflow_action/203/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { form_data: { "501": "Ada Lovelace" } } }),
    });
    expect(transformed.status).toBe(200);
    expect((await transformed.json() as any).field_30).toBe("Ada-Lovelace");
  });

  it("dispatches HTTP actions with Baserow response data and blocks private redirect targets", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const originalFetch = globalThis.fetch;
    const now = new Date().toISOString();

    try {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("user-agent")).toBe("Baserow/2.1.4/HTTPRequestService");
        expect(init.redirect).toBe("manual");
        return new Response('{"message":"ok","count":2}', {
          status: 201,
          headers: { "content-type": "text/plain", "x-request-id": "request-1" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const dispatched = await api(env, ctx, token, "/api/builder/workflow_action/204/dispatch/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      });
      expect(dispatched.status).toBe(200);
      expect(await dispatched.json()).toEqual({
        raw_body: '{"message":"ok","count":2}',
        body: { message: "ok", count: 2 },
        headers: expect.objectContaining({ "content-type": "text/plain", "x-request-id": "request-1" }),
        status_code: 201,
      });

      await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=204")
        .bind(JSON.stringify({
          service: {
            http_method: "GET",
            url: { formula: "'https://public.example/start'" },
            headers: [],
            query_params: [],
            form_data: [],
            body_type: "none",
            timeout: 30,
          },
        }), now)
        .run();
      const redirectFetch = vi.fn(async () => new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      }));
      vi.stubGlobal("fetch", redirectFetch);

      const blockedRedirect = await api(env, ctx, token, "/api/builder/workflow_action/204/dispatch/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      });
      expect(blockedRedirect.status).toBe(400);
      expect(redirectFetch).toHaveBeenCalledTimes(1);
      await expect(blockedRedirect.json()).resolves.toMatchObject({
        error: "INVALID_REQUEST",
      });
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("dispatches SMTP and every configured AI provider through real service paths", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const now = new Date().toISOString();
    const aiSettings = {
      openai: { api_key: "openai-key", base_url: "https://openai.example/v1", models: ["gpt-test"] },
      openrouter: { api_key: "openrouter-key", models: ["router-test"] },
      anthropic: { api_key: "anthropic-key", models: ["claude-test"] },
      mistral: { api_key: "mistral-key", models: ["mistral-test"] },
      ollama: { host: "https://ollama.example", models: ["llama-test"] },
    };
    await db.prepare(
      `INSERT INTO core_integration
       (id, application_id, type, name, [order], configuration, created_on, updated_on)
       VALUES
       (9, 11, 'smtp', 'SMTP', '10000', ?, ?, ?),
       (10, 11, 'ai', 'AI', '20000', ?, ?, ?)`
    ).bind(
      JSON.stringify({ host: "smtp.example", port: 2525, use_tls: false, username: "", password: "" }), now, now,
      JSON.stringify({ ai_settings: aiSettings }), now, now,
    ).run();

    const smtpWrites: string[] = [];
    let smtpController: ReadableStreamDefaultController<Uint8Array>;
    const enqueueSmtp = (response: string) => {
      smtpController.enqueue(new TextEncoder().encode(`${response}\r\n`));
    };
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        smtpController = controller;
        enqueueSmtp("220 smtp.example ready");
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const command = new TextDecoder().decode(chunk);
        smtpWrites.push(command);
        if (command.startsWith("EHLO ")) enqueueSmtp("250 smtp.example hello");
        else if (command.startsWith("MAIL FROM:")) enqueueSmtp("250 sender accepted");
        else if (command.startsWith("RCPT TO:")) enqueueSmtp("250 recipient accepted");
        else if (command === "DATA\r\n") enqueueSmtp("354 send data");
        else if (command.endsWith("\r\n.\r\n")) enqueueSmtp("250 queued");
      },
    });
    const close = vi.fn(async () => undefined);
    vi.mocked(connect).mockReturnValue({ readable, writable, close } as any);

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://openai.example/v1/chat/completions") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openai-key");
        return Response.json({ choices: [{ message: { content: "openai result" } }] });
      }
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openrouter-key");
        return Response.json({ choices: [{ message: { content: "openrouter result" } }] });
      }
      if (url === "https://api.anthropic.com/v1/messages") {
        return Response.json({ content: [{ text: "anthropic " }, { text: "result" }] });
      }
      if (url === "https://api.mistral.ai/v1/chat/completions") {
        return Response.json({ choices: [{ message: { content: "mistral result" } }] });
      }
      if (url === "https://ollama.example/api/generate") {
        return Response.json({ response: "ollama result" });
      }
      throw new Error(`Unexpected external request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const smtp = await api(env, ctx, token, "/api/builder/workflow_action/205/dispatch/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      });
      expect(smtp.status).toBe(200);
      expect(await smtp.json()).toEqual({ success: true, sent: true });
      expect(connect).toHaveBeenCalledWith(
        { hostname: "smtp.example", port: 2525 },
        { allowHalfOpen: false, secureTransport: "off" },
      );
      const smtpTranscript = smtpWrites.join("");
      expect(smtpTranscript).toContain("EHLO smtp.example\r\n");
      expect(smtpTranscript).toContain("MAIL FROM:<sender@example.com>\r\n");
      expect(smtpTranscript).toContain("RCPT TO:<recipient@example.com>\r\n");
      expect(smtpTranscript).toContain("Subject: Subject\r\n");
      expect(smtpTranscript).toContain("Body\r\n.\r\n");
      expect(close).toHaveBeenCalledOnce();

      for (const [provider, model, expected] of [
        ["openai", "gpt-test", "openai result"],
        ["openrouter", "router-test", "openrouter result"],
        ["anthropic", "claude-test", "anthropic result"],
        ["mistral", "mistral-test", "mistral result"],
        ["ollama", "llama-test", "ollama result"],
      ]) {
        await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=206")
          .bind(JSON.stringify({ service: {
            integration_id: 10,
            ai_generative_ai_type: provider,
            ai_generative_ai_model: model,
            ai_output_type: "text",
            ai_temperature: 0.3,
            ai_prompt: { formula: "'Summarize'" },
            ai_choices: [],
          } }), now)
          .run();
        const response = await api(env, ctx, token, "/api/builder/workflow_action/206/dispatch/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ metadata: {} }),
        });
        expect(response.status, provider).toBe(200);
        expect(await response.json(), provider).toEqual({ result: expected });
      }

      await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=206")
        .bind(JSON.stringify({ service: {
          integration_id: 10,
          ai_generative_ai_type: "openai",
          ai_generative_ai_model: "gpt-test",
          ai_output_type: "choice",
          ai_prompt: { formula: "'Choose'" },
          ai_choices: [],
        } }), now)
        .run();
      const fetchCountBeforeChoice = fetchMock.mock.calls.length;
      const invalidChoice = await api(env, ctx, token, "/api/builder/workflow_action/206/dispatch/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      });
      expect(invalidChoice.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(fetchCountBeforeChoice);

      await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=206")
        .bind(JSON.stringify({ service: {
          integration_id: 10,
          ai_generative_ai_type: "openai",
          ai_generative_ai_model: "not-enabled",
          ai_output_type: "text",
          ai_prompt: { formula: "'Prompt'" },
          ai_choices: [],
        } }), now)
        .run();
      const unavailableModel = await api(env, ctx, token, "/api/builder/workflow_action/206/dispatch/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      });
      expect(unavailableModel.status).toBe(400);

      await db.prepare("UPDATE core_integration SET configuration=? WHERE id=10")
        .bind(JSON.stringify({ ai_settings: {} }))
        .run();
      env.CACHE.get = vi.fn(async (key: string) => key === "workspace:1:generative-ai"
        ? JSON.stringify({ anthropic: { api_key: "workspace-anthropic", models: ["workspace-claude"] } })
        : null);
      await db.prepare("UPDATE builder_workflowaction SET configuration=?, updated_on=? WHERE id=206")
        .bind(JSON.stringify({ service: {
          integration_id: 10,
          ai_generative_ai_type: "anthropic",
          ai_generative_ai_model: "workspace-claude",
          ai_output_type: "text",
          ai_prompt: { formula: "'Workspace prompt'" },
          ai_choices: [],
        } }), now)
        .run();
      const fallback = await api(env, ctx, token, "/api/builder/workflow_action/206/dispatch/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      });
      expect(fallback.status).toBe(200);
      expect(await fallback.json()).toEqual({ result: "anthropic result" });
      const anthropicCalls = fetchMock.mock.calls.filter(([url]) => String(url) === "https://api.anthropic.com/v1/messages");
      expect(new Headers(anthropicCalls.at(-1)?.[1]?.headers).get("x-api-key")).toBe("workspace-anthropic");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      vi.mocked(connect).mockReset();
    }
  });

  it("stores Builder file input uploads in R2 before applying workflow field mappings", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const fileId = "3c913094-c69a-4fd3-b19d-c35322f7d5c5";
    const form = new FormData();
    form.set("metadata", JSON.stringify({
      form_data: {
        "600": [{
          __file__: true,
          name: "notes.txt",
          content_type: "text/plain",
          size: 11,
          file: fileId,
        }],
      },
    }));
    form.set(fileId, new File(["hello world"], "browser-name.txt", { type: "text/plain" }));

    const response = await api(env, ctx, token, "/api/builder/workflow_action/208/dispatch/", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    const row = await response.json() as any;
    expect(row.field_39).toHaveLength(1);
    expect(row.field_39[0]).toMatchObject({
      visible_name: "notes.txt",
      mime_type: "text/plain",
      size: 11,
      is_image: false,
    });
    expect(row.field_39[0].name).toMatch(/\.txt$/);
    expect(row.field_39[0].url).toContain("/user_files/");
    expect(env.FILES.put).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT original_name, mime_type, size FROM core_userfile").first()).toEqual({
      original_name: "notes.txt",
      mime_type: "text/plain",
      size: 11,
    });

    const invalidForm = new FormData();
    invalidForm.set("metadata", JSON.stringify({
      form_data: {
        "600": [{ __file__: true, name: "script.js", file: "invalid-type" }],
      },
    }));
    invalidForm.set("invalid-type", new File(["alert(1)"], "script.js", { type: "text/javascript" }));
    const invalid = await api(env, ctx, token, "/api/builder/workflow_action/208/dispatch/", {
      method: "POST",
      body: invalidForm,
    });
    expect(invalid.status).toBe(400);
    expect(env.FILES.put).toHaveBeenCalledTimes(1);
  });

  it("protects builder preview and unpublished public runtime endpoints like Baserow", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();

    const anonymousPreview = await publicApi(env, ctx, "/api/builder/domains/published/by_id/11/");
    expect(anonymousPreview.status).toBe(401);

    const authenticatedPreview = await api(env, ctx, token, "/api/builder/domains/published/by_id/11/");
    expect(authenticatedPreview.status).toBe(200);
    const preview = await authenticatedPreview.json() as any;
    expect(preview.id).toBe(11);
    expect(preview.pages.some((page: any) => page.id === 100)).toBe(true);

    const anonymousUnpublishedElements = await publicApi(env, ctx, "/api/builder/domains/published/page/100/elements/");
    expect(anonymousUnpublishedElements.status).toBe(401);

    const authenticatedUnpublishedElements = await api(env, ctx, token, "/api/builder/domains/published/page/100/elements/");
    expect(authenticatedUnpublishedElements.status).toBe(200);

    const create = await api(env, ctx, token, "/api/builder/workflow_action/200/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { form_data: { "500": "Published Example" } } }),
    });
    expect(create.status).toBe(200);
    const created = await create.json() as any;

    const anonymousUnpublishedDispatch = await publicApi(env, ctx, "/api/builder/domains/published/data-source/300/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { page_parameter: { row_id: created.id } } }),
    });
    expect(anonymousUnpublishedDispatch.status).toBe(401);

    const anonymousUnpublishedAction = await publicApi(env, ctx, "/api/builder/workflow_action/200/dispatch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { form_data: { "500": "Denied draft" } } }),
    });
    expect(anonymousUnpublishedAction.status).toBe(401);

    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO builder_domain
       (id, builder_id, type, domain_name, published, last_published, settings, created_on, updated_on)
       VALUES (900, 11, 'custom', 'public-builder.supertask.test', 0, NULL, '{}', ?, ?)`
    ).bind(now, now).run();

    const publishResponse = await api(env, ctx, token, "/api/builder/domains/900/publish/async/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(publishResponse.status).toBe(200);
    const publishJob = await publishResponse.json() as any;
    expect(publishJob).toMatchObject({
      state: "finished",
      type: "publish_builder",
      builder_id: 11,
    });
    expect(publishJob.published_builder_id).not.toBe(11);

    const publicBuilderResponse = await publicApi(
      env,
      ctx,
      "/api/builder/domains/published/by_name/public-builder.supertask.test/"
    );
    expect(publicBuilderResponse.status).toBe(200);
    const publicBuilder = await publicBuilderResponse.json() as any;
    const publicPage = publicBuilder.pages.find((item: any) => item.path === "/");
    expect(publicBuilder.id).toBe(publishJob.published_builder_id);
    expect(publicPage.id).not.toBe(100);

    const anonymousPublishedElements = await publicApi(env, ctx, `/api/builder/domains/published/page/${publicPage.id}/elements/`);
    expect(anonymousPublishedElements.status).toBe(200);

    const publicDataSourcesResponse = await publicApi(
      env,
      ctx,
      `/api/builder/domains/published/page/${publicPage.id}/data_sources/`
    );
    expect(publicDataSourcesResponse.status).toBe(200);
    const publicDataSources = await publicDataSourcesResponse.json() as any[];
    const publicDataSource = publicDataSources.find((item: any) => item.name === "Selected contact");
    expect(publicDataSource.id).not.toBe(300);

    const publicActionsResponse = await publicApi(
      env,
      ctx,
      `/api/builder/domains/published/page/${publicPage.id}/workflow_actions/`
    );
    expect(publicActionsResponse.status).toBe(200);
    const publicActions = await publicActionsResponse.json() as any[];
    const publicCreateAction = publicActions.find((item: any) => item.type === "create_row" && item.order === "10000");
    expect(publicCreateAction.id).not.toBe(200);

    const anonymousPublishedAction = await publicApi(
      env,
      ctx,
      `/api/builder/workflow_action/${publicCreateAction.id}/dispatch/`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: { form_data: { "500": "Public action" } } }),
      }
    );
    expect(anonymousPublishedAction.status).toBe(200);
    expect((await anonymousPublishedAction.json() as any).field_30).toBe("Public action");

    const anonymousPublishedDispatch = await publicApi(env, ctx, `/api/builder/domains/published/data-source/${publicDataSource.id}/dispatch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { page_parameter: { row_id: created.id } } }),
    });
    expect(anonymousPublishedDispatch.status).toBe(200);
    expect((await anonymousPublishedDispatch.json() as any).field_30).toBe("Published Example");

    await db.prepare("UPDATE builder_page SET name='Changed draft', updated_on=? WHERE id=100")
      .bind(new Date().toISOString())
      .run();
    const unchangedPublication = await publicApi(
      env,
      ctx,
      "/api/builder/domains/published/by_name/public-builder.supertask.test/"
    );
    expect(unchangedPublication.status).toBe(200);
    expect((await unchangedPublication.json() as any).pages.find((item: any) => item.id === publicPage.id).name)
      .not.toBe("Changed draft");

    const visibleApplications = await api(env, ctx, token, "/api/applications/workspace/1/");
    expect(visibleApplications.status).toBe(200);
    expect((await visibleApplications.json() as any[]).some((item) => item.id === publishJob.published_builder_id)).toBe(false);

    await db.prepare("UPDATE core_application SET trashed=1 WHERE id=11").run();
    const trashedSourceDomain = await publicApi(
      env,
      ctx,
      "/api/builder/domains/published/by_name/public-builder.supertask.test/"
    );
    expect(trashedSourceDomain.status).toBe(404);
    const trashedSourcePage = await publicApi(
      env,
      ctx,
      `/api/builder/domains/published/page/${publicPage.id}/elements/`
    );
    expect(trashedSourcePage.status).toBe(401);
    await db.prepare("UPDATE core_application SET trashed=0 WHERE id=11").run();

    const republishResponse = await api(env, ctx, token, "/api/builder/domains/900/publish/async/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(republishResponse.status).toBe(200);
    const republishJob = await republishResponse.json() as any;
    expect(republishJob.published_builder_id).not.toBe(publishJob.published_builder_id);
    expect(await db.prepare("SELECT id FROM core_application WHERE id=?").bind(publishJob.published_builder_id).first()).toBeNull();

    const republished = await publicApi(
      env,
      ctx,
      "/api/builder/domains/published/by_name/public-builder.supertask.test/"
    );
    expect(republished.status).toBe(200);
    expect((await republished.json() as any).pages.find((item: any) => item.path === "/").name).toBe("Changed draft");

    const deleteDomain = await api(env, ctx, token, "/api/builder/domains/900/", { method: "DELETE" });
    expect(deleteDomain.status).toBe(200);
    expect(await db.prepare("SELECT id FROM core_application WHERE id=?").bind(republishJob.published_builder_id).first()).toBeNull();
  });

  it("duplicates builder applications with content, custom code and remapped runtime references", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();
    const now = new Date().toISOString();
    const css = ".duplicate-builder { color: red; }";
    const js = "window.__duplicateBuilder = true;";

    const patch = await api(env, ctx, token, "/api/applications/11/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        custom_code: { css, js },
        scripts: [
          { id: 999, type: "stylesheet", url: "https://cdn.example.com/builder.css", load_type: "", crossorigin: "" },
          { type: "javascript", url: "https://cdn.example.com/builder.js", load_type: "defer", crossorigin: "anonymous" },
        ],
      }),
    });
    expect(patch.status).toBe(200);

    await db.prepare(
      `INSERT INTO core_integration (id, application_id, type, name, [order], configuration, created_on, updated_on)
       VALUES (900, 11, 'local_baserow', 'Builder Local Baserow', '10000', ?, ?, ?)`
    ).bind(JSON.stringify({ table_id: 20, page_id: 100 }), now, now).run();
    await db.prepare(
      `INSERT INTO core_usersource
       (id, application_id, integration_id, type, name, uid, [order], configuration, auth_providers, created_on, updated_on)
       VALUES (901, 11, 900, 'database', 'Portal users', '__user_source_901', '10000', ?, ?, ?, ?)`
    ).bind(
      JSON.stringify({ table_id: 20, integration_id: 900, user_source_id: 901 }),
      JSON.stringify([{ type: "password", integration_id: 900 }]),
      now,
      now
    ).run();
    await db.prepare(
      `INSERT INTO builder_element
       (id, page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
       VALUES (500, 100, 'heading', '10000', NULL, NULL, ?, ?, ?),
              (501, 100, 'button', '20000', 500, 'children', ?, ?, ?)`
    ).bind(
      JSON.stringify({ value: "Parent heading" }),
      now,
      now,
      JSON.stringify({
        value: { formula: "get('data_source.300.field_30')" },
        data_source_id: 300,
        datasource_id: 301,
        integration_id: 900,
        user_source_id: 901,
        nested: { user_source: 901 },
      }),
      now,
      now
    ).run();
    await db.prepare(
      `INSERT INTO builder_domain
       (id, builder_id, type, domain_name, published, last_published, settings, created_on, updated_on)
       VALUES (902, 11, 'custom', 'duplicated-builder.supertask.test', 1, ?, '{}', ?, ?)`
    ).bind(now, now, now).run();

    const response = await api(env, ctx, token, "/api/applications/11/duplicate/async/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as any;
    expect(body.state).toBe("finished");
    expect(body.duplicated_application).toMatchObject({
      type: "builder",
      custom_code: { css, js },
    });

    const duplicated = body.duplicated_application;
    expect(duplicated.id).not.toBe(11);
    expect(duplicated.scripts).toMatchObject([
      { type: "stylesheet", url: "https://cdn.example.com/builder.css", load_type: "", crossorigin: "" },
      { type: "javascript", url: "https://cdn.example.com/builder.js", load_type: "defer", crossorigin: "anonymous" },
    ]);
    expect(duplicated.scripts[0].id).not.toBe(999);

    const copiedIntegration = duplicated.integrations.find((item: any) => item.name === "Builder Local Baserow");
    expect(copiedIntegration).toMatchObject({ type: "local_baserow", table_id: 20 });
    expect(copiedIntegration.id).not.toBe(900);
    const copiedUserSource = duplicated.user_sources.find((item: any) => item.name === "Portal users");
    expect(copiedUserSource).toMatchObject({
      type: "database",
      integration_id: copiedIntegration.id,
      table_id: 20,
    });
    expect(copiedUserSource.id).not.toBe(901);
    expect(copiedUserSource.uid).toBe(`__user_source_${copiedUserSource.id}`);
    expect(copiedUserSource.auth_providers[0].integration_id).toBe(copiedIntegration.id);

    const copiedPage = duplicated.pages.find((item: any) => item.name === "Form");
    expect(copiedPage).toMatchObject({ path: "/", shared: false });
    expect(copiedPage.id).not.toBe(100);

    const dataSourcesResponse = await api(env, ctx, token, `/api/builder/page/${copiedPage.id}/data-sources/`);
    expect(dataSourcesResponse.status).toBe(200);
    const copiedDataSources = await dataSourcesResponse.json() as any[];
    const copiedSelectedContact = copiedDataSources.find((item) => item.name === "Selected contact");
    const copiedAggregate = copiedDataSources.find((item) => item.name === "Name count");
    expect(copiedSelectedContact?.id).not.toBe(300);
    expect(copiedAggregate?.id).not.toBe(301);

    const elementsResponse = await api(env, ctx, token, `/api/builder/page/${copiedPage.id}/elements/`);
    expect(elementsResponse.status).toBe(200);
    const copiedElements = await elementsResponse.json() as any[];
    const copiedHeading = copiedElements.find((item) => item.type === "heading" && item.value === "Parent heading");
    const copiedButton = copiedElements.find((item) => item.type === "button");
    expect(copiedHeading.id).not.toBe(500);
    expect(copiedButton.parent_element_id).toBe(copiedHeading.id);
    expect(copiedButton.data_source_id).toBe(copiedSelectedContact.id);
    expect(copiedButton.datasource_id).toBe(copiedAggregate.id);
    expect(copiedButton.integration_id).toBe(copiedIntegration.id);
    expect(copiedButton.user_source_id).toBe(copiedUserSource.id);
    expect(copiedButton.nested.user_source).toBe(copiedUserSource.id);
    expect(copiedButton.value.formula).toBe(`get('data_source.${copiedSelectedContact.id}.field_30')`);

    const actionsResponse = await api(env, ctx, token, `/api/builder/page/${copiedPage.id}/workflow_actions/`);
    expect(actionsResponse.status).toBe(200);
    const copiedActions = await actionsResponse.json() as any[];
    const copiedCreate = copiedActions.find((item) => item.type === "create_row" && item.order === "10000");
    const copiedUpdate = copiedActions.find((item) => item.type === "update_row" && item.order === "20000");
    expect(copiedCreate.id).not.toBe(200);
    expect(copiedUpdate.id).not.toBe(201);
    expect(copiedUpdate.service.row_id.formula).toBe(`get('previous_action.${copiedCreate.id}.id')`);
    expect(copiedUpdate.service.field_mappings[0].value.formula)
      .toBe(`concat(get('previous_action.${copiedCreate.id}.field_30'), ' Updated')`);

    const duplicatedDomainCount = await db.prepare("SELECT COUNT(*) AS count FROM builder_domain WHERE builder_id=?")
      .bind(duplicated.id)
      .first<{ count: number }>();
    expect(duplicatedDomainCount?.count).toBe(0);
  });

  it("serializes and serves enterprise builder custom code like Baserow", async () => {
    const { db, env, token, ctx } = await setupBuilderFixture();

    const initial = await api(env, ctx, token, "/api/applications/11/");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      custom_code: { css: "", js: "" },
      scripts: [],
    });

    const css = ".hello { color: red; }";
    const js = "window.__hello = true;";
    const patch = await api(env, ctx, token, "/api/applications/11/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        custom_code: { css, js },
        scripts: [
          {
            id: 999,
            type: "stylesheet",
            url: "https://cdn.example.com/site.css",
            load_type: "",
            crossorigin: "",
          },
          {
            type: "javascript",
            url: "https://cdn.example.com/site.js",
            load_type: "defer",
            crossorigin: "anonymous",
          },
        ],
      }),
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json() as any;
    expect(patched.custom_code).toEqual({ css, js });
    expect(patched.scripts).toMatchObject([
      {
        type: "stylesheet",
        url: "https://cdn.example.com/site.css",
        load_type: "",
        crossorigin: "",
      },
      {
        type: "javascript",
        url: "https://cdn.example.com/site.js",
        load_type: "defer",
        crossorigin: "anonymous",
      },
    ]);
    expect(patched.scripts[0].id).not.toBe(999);

    const previewCss = await api(env, ctx, token, "/api/custom_code/11/css/");
    expect(previewCss.status).toBe(200);
    expect(previewCss.headers.get("content-type")).toContain("text/css");
    expect(await previewCss.text()).toBe(css);

    const previewJs = await api(env, ctx, token, "/api/custom_code/11/js/");
    expect(previewJs.status).toBe(200);
    expect(previewJs.headers.get("content-type")).toContain("application/javascript");
    expect(await previewJs.text()).toBe(js);

    const anonymousUnpublishedCss = await publicApi(env, ctx, "/api/custom_code/11/css/public/");
    expect(anonymousUnpublishedCss.status).toBe(401);

    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO builder_domain
       (id, builder_id, type, domain_name, published, last_published, settings, created_on, updated_on)
       VALUES (901, 11, 'custom', 'custom-code.supertask.test', 0, NULL, '{}', ?, ?)`
    ).bind(now, now).run();

    const publish = await api(env, ctx, token, "/api/builder/domains/901/publish/async/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(publish.status).toBe(200);
    const publishedBuilderId = (await publish.json() as any).published_builder_id;

    const publicCss = await publicApi(env, ctx, `/api/custom_code/${publishedBuilderId}/css/public/`);
    expect(publicCss.status).toBe(200);
    expect(publicCss.headers.get("content-type")).toContain("text/css");
    expect(await publicCss.text()).toBe(css);

    const publicJs = await publicApi(env, ctx, `/api/custom_code/${publishedBuilderId}/js/public/`);
    expect(publicJs.status).toBe(200);
    expect(publicJs.headers.get("content-type")).toContain("application/javascript");
    expect(await publicJs.text()).toBe(js);
  });

  it("converts legacy published domains to isolated applications on first public access", async () => {
    const { db, env, ctx } = await setupBuilderFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO builder_domain
       (id, builder_id, type, domain_name, published, last_published, settings, created_on, updated_on)
       VALUES (950, 11, 'custom', 'legacy-builder.supertask.test', 1, ?, '{}', ?, ?)`
    ).bind(now, now, now).run();

    const response = await publicApi(
      env,
      ctx,
      "/api/builder/domains/published/by_name/legacy-builder.supertask.test/"
    );
    expect(response.status).toBe(200);
    const publicBuilder = await response.json() as any;
    expect(publicBuilder.id).not.toBe(11);
    const domain = await db.prepare("SELECT published_to_id FROM builder_domain WHERE id=950").first<any>();
    expect(domain.published_to_id).toBe(publicBuilder.id);
  });
});
