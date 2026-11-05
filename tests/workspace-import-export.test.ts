import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strFromU8, unzipSync, zipSync } from "fflate";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { addFieldColumn, getOrCreateUserTable, serializeFieldValueForInsert } from "../src/services/dynamic-tables";
import { createDataSyncTable } from "../src/services/data-sync";
import { iterateSnapshotTableRows } from "../src/routes/snapshots";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

type StoredObject = {
  body: Uint8Array;
  options?: Record<string, any>;
  streamed?: boolean;
  multipartPartSizes?: number[];
};

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0001_initial.sql",
    "0003_user_files.sql",
    "0006_field_rules_data_sync.sql",
    "0007_data_sync_schema_upgrade.sql",
    "0008_core_job_result.sql",
    "0009_builder_core.sql",
    "0029_builder_custom_code.sql",
    "0030_builder_settings.sql",
    "0010_application_integrations_user_sources.sql",
    "0011_automation_core.sql",
    "0012_automation_published_versions.sql",
    "0013_automation_history_event_payload_simulation.sql",
    "0015_documents_dashboards.sql",
    "0018_enterprise_parity.sql",
    "0019_premium_view_settings.sql",
    "0020_view_filter_groups.sql",
    "0021_workspace_trash.sql",
    "0022_form_view_field_options_logic.sql",
    "0024_data_sync_periodic.sql",
    "0038_data_sync_authorized_user.sql",
    "0039_builder_published_applications.sql",
    "0028_userfile_baserow_name_hash.sql",
    "0034_dashboard_data_sources.sql",
    "0043_form_view_submit_notifications.sql",
    "0046_data_sync_select_option_mapping.sql",
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
    batch(statements: Array<{ all?: () => Promise<any>; first?: () => Promise<any>; run?: () => Promise<any> }>) {
      return Promise.all(statements.map((statement) => statement.run ? statement.run() : statement.first ? statement.first() : statement.all?.()));
    },
  };
}

function createR2() {
  const objects = new Map<string, StoredObject>();
  const bodyBytes = async (body: any) => typeof body === "string"
    ? new TextEncoder().encode(body)
    : body instanceof Uint8Array
      ? body
      : new Uint8Array(await new Response(body).arrayBuffer());
  return {
    objects,
    bucket: {
      async put(key: string, body: any, options?: Record<string, any>) {
        const streamed = body instanceof ReadableStream;
        const bytes = await bodyBytes(body);
        objects.set(key, { body: bytes, options, streamed });
      },
      async createMultipartUpload(key: string, options?: Record<string, any>) {
        const parts = new Map<number, Uint8Array>();
        return {
          key,
          uploadId: crypto.randomUUID(),
          async uploadPart(partNumber: number, body: any) {
            parts.set(partNumber, await bodyBytes(body));
            return { partNumber, etag: `etag-${partNumber}` };
          },
          async abort() {
            parts.clear();
            objects.delete(key);
          },
          async complete(uploadedParts: Array<{ partNumber: number }>) {
            const chunks = uploadedParts
              .slice()
              .sort((left, right) => left.partNumber - right.partNumber)
              .map((part) => parts.get(part.partNumber) || new Uint8Array(0));
            const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
            const body = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.length;
            }
            objects.set(key, {
              body,
              options,
              streamed: true,
              multipartPartSizes: chunks.map((chunk) => chunk.length),
            });
            return { key };
          },
        };
      },
      async get(key: string) {
        const stored = objects.get(key);
        if (!stored) return null;
        return {
          body: new Blob([stored.body]).stream(),
          async arrayBuffer() {
            return stored.body.buffer.slice(stored.body.byteOffset, stored.body.byteOffset + stored.body.byteLength);
          },
          async text() {
            return new TextDecoder().decode(stored.body);
          },
          httpMetadata: stored.options?.httpMetadata || {},
        };
      },
      async head(key: string) {
        return objects.has(key) ? { key } : null;
      },
      async list(options?: { prefix?: string; limit?: number }) {
        const prefix = options?.prefix || "";
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, options?.limit || 1000);
        return { objects: keys.map((key) => ({ key })) };
      },
      async delete(key: string | string[]) {
        for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
      },
    },
  };
}

async function setupFixture() {
  const db = createTestD1();
  const now = "2026-05-27T10:00:00.000Z";
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
    .bind(now)
    .run();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (7, '', 'owner@example.com', 'Owner', '', 'owner@example.com', 1, 1, ?),
            (8, '', 'member@example.com', 'Member', '', 'member@example.com', 0, 1, ?)`
  ).bind(now, now).run();
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
    .run();
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 8, 'EDITOR')")
    .run();
  await db.prepare(
    `INSERT INTO core_userfile
     (id, user_id, name, original_name, r2_key, size, mime_type, is_image, image_width, image_height,
      uploaded_at, original_extension, sha256_hash, deleted_at)
     VALUES (500, 7, 'favicon.png', 'Favicon.png', 'user_files/favicon.png', 68, 'image/png', 1, 16, 16,
      ?, 'png', 'sha256-favicon', NULL)`
  ).bind(now).run();
  await db.prepare(
    `INSERT INTO core_userfile
     (id, user_id, name, original_name, r2_key, size, mime_type, is_image, image_width, image_height,
      uploaded_at, original_extension, sha256_hash, deleted_at)
     VALUES (501, 7, 'row-document.pdf', 'Customer contract.pdf', 'user_files/row-document.pdf', 4,
      'application/pdf', 0, NULL, NULL, ?, 'pdf', '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a', NULL)`
  ).bind(now).run();
  await db.prepare(
    `INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?),
            (11, 1, 'Builder app', 'builder', 2, 0, ?, ?),
            (12, 1, 'Automation app', 'automation', 3, 0, ?, ?),
            (13, 1, 'Document app', 'document', 4, 0, ?, ?),
            (14, 1, 'Dashboard app', 'dashboard', 5, 0, ?, ?)`
  ).bind(now, now, now, now, now, now, now, now, now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on,
     needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
     VALUES (20, 10, 'Customers', 1, 1, 0, ?, ?, 0, 0, 0)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await db.prepare(
    `INSERT INTO database_field
     (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on, db_index,
      immutable_type, immutable_properties)
     VALUES (30, 20, 'Name', 'text', 1, 1, 0, 0, '{}', ?, ?, 1, 0, 0),
            (31, 20, 'Status', 'single_select', 2, 0, 0, 0, '{}', ?, ?, 0, 0, 0),
            (32, 20, 'Contract', 'file', 3, 0, 0, 0, '{}', ?, ?, 0, 0, 0),
            (33, 20, 'AI summary', 'ai', 4, 0, 0, 0, ?, ?, ?, 0, 0, 0)`
  ).bind(
    now, now,
    now, now,
    now, now,
    JSON.stringify({
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-test",
      ai_output_type: "text",
      ai_prompt: { formula: "CONCAT('Summary ', get('fields.field_30'))", mode: "simple", version: "0.1" },
      ai_file_field_id: 32,
      ai_auto_update: true,
      ai_auto_update_user_id: 8,
    }),
    now,
    now
  ).run();
  await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (40, 31, 'Active', 'green', 1)")
    .run();
  await db.prepare(
    `INSERT INTO database_view
     (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug, public_view_password,
      trashed, show_logo, allow_public_export, ownership_type, row_height_size, row_identifier_type, created_on, updated_on)
     VALUES
     (80, 20, 'Grid', 'grid', 1, 'AND', 0, 0, 'grid-slug', NULL, 0, 1, 1, 'collaborative', 'small', 'count', ?, ?),
     (81, 20, 'Intake form', 'form', 2, 'AND', 0, 0, 'form-slug', NULL, 0, 0, 0, 'personal', 'small', 'count', ?, ?)`
  ).bind(now, now, now, now).run();
  await db.prepare("UPDATE database_view SET owned_by_id=7 WHERE id IN (80, 81)").run();
  await db.prepare(
    `INSERT INTO database_formview
     (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
      submit_action_redirect_url, mode, show_logo)
     VALUES (81, 'Customer intake', '', 'Send', 'MESSAGE', 'Thank you', '', 'form', 0)`
  ).run();
  await db.prepare(
    `INSERT INTO database_formview_users_to_notify_on_submit (formview_id, user_id)
     VALUES (81, 7)`
  ).run();
  await db.prepare(
    `INSERT INTO enterprise_roleassignment (role_id, subject_id, subject_type, scope_id, scope_type)
     VALUES ((SELECT id FROM enterprise_role WHERE uid='VIEWER'), 8, 'auth.User', 10, 'application'),
            ((SELECT id FROM enterprise_role WHERE uid='COMMENTER'), 8, 'auth.User', 20, 'table'),
            ((SELECT id FROM enterprise_role WHERE uid='VIEWER'), 8, 'auth.User', 80, 'view'),
            ((SELECT id FROM enterprise_role WHERE uid='NO_ACCESS'), 8, 'auth.User', 32, 'field')`
  ).run();
  await db.prepare(
    `INSERT INTO enterprise_fieldpermission (field_id, role_uid, allow_read, allow_write, allow_in_forms)
     VALUES (32, 'NOBODY', 1, 0, 0)`
  ).run();
  await addFieldColumn(db as any, 20, { id: 30, type: "text", primary: true });
  await addFieldColumn(db as any, 20, { id: 31, type: "single_select", primary: false });
  await addFieldColumn(db as any, 20, { id: 32, type: "file", primary: false });
  await addFieldColumn(db as any, 20, { id: 33, type: "ai" as any, primary: false });
  await db.prepare("INSERT INTO database_fielddependency (dependant_id, dependency_id) VALUES (33, 30), (33, 32)").run();
  await db.prepare(
    'INSERT INTO "database_table_20" (id, [order], field_30, field_31, field_32, _created_on, _updated_on) VALUES (1, 10000, ?, ?, ?, ?, ?)'
  ).bind(
    "Alice",
    serializeFieldValueForInsert("single_select", { id: 40, value: "Active", color: "green" }),
    serializeFieldValueForInsert("file", [{
      name: "row-document.pdf",
      visible_name: "Renamed contract.pdf",
      size: 4,
      mime_type: "application/pdf",
      is_image: false,
      image_width: null,
      image_height: null,
      uploaded_at: now,
    }]),
    now,
    now
  ).run();
  await createDataSyncTable(db as any, 10, {
    type: "local_baserow_table",
    table_name: "Customers mirror",
    source_table_id: 20,
    synced_properties: ["field_30", "field_31"],
    auto_add_new_properties: false,
    periodic_interval: "day",
    periodic_interval_count: 2,
  });

  await db.prepare("INSERT INTO builder_theme (builder_id, theme, updated_on) VALUES (11, ?, ?)")
    .bind(JSON.stringify({ primary_color: "#0f766e" }), now)
    .run();
  await db.prepare("INSERT INTO builder_custom_code (builder_id, css, js, created_on, updated_on) VALUES (11, ?, ?, ?, ?)")
    .bind(".portal { color: red; }", "window.__portal = true;", now, now)
    .run();
  await db.prepare(
    `INSERT INTO builder_custom_script
     (id, builder_id, [order], type, url, load_type, crossorigin, created_on, updated_on)
     VALUES (77, 11, 1, 'javascript', 'https://cdn.example.com/portal.js', 'defer', 'anonymous', ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO builder_page
     (id, builder_id, name, path, path_params, query_params, shared, visibility, role_type, roles, settings, [order], created_on, updated_on)
     VALUES (50, 11, 'Home', '/', '[]', '[]', 0, 'all', 'allow_all', '[]', ?, 1, ?, ?)`
  ).bind(JSON.stringify({ title: "Customer portal" }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_settings (builder_id, favicon_file, login_page_id, created_on, updated_on)
     VALUES (11, ?, 50, ?, ?)`
  ).bind(JSON.stringify({ name: "favicon.png", visible_name: "Favicon.png" }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_datasource (id, page_id, type, name, [order], configuration, created_on, updated_on)
     VALUES (70, 50, 'local_baserow_list_rows', 'Customers source', '10000', ?, ?, ?)`
  ).bind(JSON.stringify({ table_id: 20, view_id: 80, field_id: 30 }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_element
     (id, page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
     VALUES (60, 50, 'heading', '10000', NULL, NULL, ?, ?, ?),
            (61, 50, 'button', '20000', 60, 'children', ?, ?, ?)`
  ).bind(
    JSON.stringify({ value: "Customers", data_source_id: 70 }),
    now,
    now,
    JSON.stringify({ value: "Refresh", data_source_id: 70 }),
    now,
    now
  ).run();
  await db.prepare(
    `INSERT INTO builder_workflowaction
     (id, page_id, element_id, type, event, [order], configuration, created_on, updated_on)
     VALUES (75, 50, 61, 'notification', 'click', '10000', ?, ?, ?)`
  ).bind(JSON.stringify({ data_source_id: 70, field_id: 30 }), now, now).run();
  await db.prepare(
    `INSERT INTO builder_domain (id, builder_id, type, domain_name, published, last_published, settings, created_on, updated_on)
     VALUES (76, 11, 'custom', 'builder-fixture.example', 1, ?, '{}', ?, ?)`
  ).bind(now, now, now).run();
  await db.prepare(
    `INSERT INTO core_integration (id, application_id, type, name, [order], configuration, created_on, updated_on)
     VALUES (200, 11, 'local_baserow', 'Builder Local Baserow', '10000', ?, ?, ?),
            (210, 12, 'local_baserow', 'Automation Local Baserow', '10000', ?, ?, ?),
            (220, 14, 'local_baserow', 'Dashboard Local Baserow', '10000', ?, ?, ?)`
  ).bind(
    JSON.stringify({ table_id: 20, view_id: 80 }),
    now,
    now,
    JSON.stringify({ table_id: 20 }),
    now,
    now,
    JSON.stringify({ table_id: 20, view_id: 80 }),
    now,
    now
  ).run();
  await db.prepare(
    `INSERT INTO core_usersource
     (id, application_id, integration_id, type, name, uid, [order], configuration, auth_providers, created_on, updated_on)
     VALUES (201, 11, 200, 'database', 'Portal users', '__user_source_201', '10000', ?, ?, ?, ?)`
  ).bind(
    JSON.stringify({ table_id: 20, email_field_id: 30, name_field_id: 30 }),
    JSON.stringify([{ type: "password", enabled: true }]),
    now,
    now
  ).run();
  await db.prepare(
    `INSERT INTO automation_workflow
     (id, automation_id, name, [order], state, allow_test_run_until, simulate_until_node_id, published_on,
      graph, trashed, created_on, updated_on, published_from_workflow_id, is_published_version)
     VALUES (90, 12, 'Notify customers', 1, 'draft', NULL, 92, NULL, ?, 0, ?, ?, NULL, 0),
            (93, 12, 'Notify customers [published]', 1, 'live', NULL, NULL, ?, ?, 0, ?, ?, 90, 1)`
  ).bind(
    JSON.stringify({ "0": 91, "91": { next: { "": [92] } }, "92": { next: {} } }),
    now,
    now,
    now,
    JSON.stringify({ "0": 94, "94": { next: {} } }),
    now,
    now
  ).run();
  await db.prepare(
    `INSERT INTO automation_node (id, workflow_id, type, label, service, trashed, created_on, updated_on)
     VALUES (91, 90, 'local_baserow_rows_created', 'Rows created', ?, 0, ?, ?),
            (92, 90, 'send_email', 'Send email', ?, 0, ?, ?),
            (94, 93, 'local_baserow_rows_created', 'Published trigger', ?, 0, ?, ?)`
  ).bind(
    JSON.stringify({ table_id: 20 }),
    now,
    now,
    JSON.stringify({ integration_id: 210, table_id: 20, field_id: 30, node_id: 91 }),
    now,
    now,
    JSON.stringify({ table_id: 20 }),
    now,
    now
  ).run();
  await db.prepare(
    `INSERT INTO automation_workflow_history
     (id, workflow_id, started_on, completed_on, is_test_run, message, status, event_payload, simulate_until_node_id)
     VALUES (300, 90, ?, ?, 1, 'ok', 'success', ?, 92)`
  ).bind(now, now, JSON.stringify({ table_id: 20, row_id: 1 })).run();
  await db.prepare(
    `INSERT INTO automation_node_history
     (id, workflow_history_id, node_id, started_on, completed_on, status, message, input, output)
     VALUES (301, 300, 92, ?, ?, 'success', '', ?, ?)`
  ).bind(
    now,
    now,
    JSON.stringify({ node_id: 91 }),
    JSON.stringify({ table_id: 20, field_id: 30 })
  ).run();
  await db.prepare(
    `INSERT INTO supertask_document_page
     (id, document_id, parent_id, title, content, icon, [order], created_on, updated_on)
     VALUES (400, 13, NULL, 'Overview', ?, 'document', 1, ?, ?),
            (401, 13, 400, 'Details', ?, 'page', 2, ?, ?)`
  ).bind(
    JSON.stringify({ type: "doc", content: [{ type: "paragraph", text: "Customer overview" }] }),
    now,
    now,
    JSON.stringify({ type: "doc", content: [{ type: "paragraph", text: "Customer details" }] }),
    now,
    now
  ).run();
  await db.prepare(
    `INSERT INTO supertask_dashboard_data_source
     (id, dashboard_id, type, name, [order], service, created_on, updated_on)
     VALUES (500, 14, 'local_baserow_grouped_aggregate_rows', 'Customer status', '1', ?, ?, ?)`
  ).bind(JSON.stringify({ integration_id: 220, table_id: 20, view_id: 80 }), now, now).run();
  await db.prepare(
    `INSERT INTO supertask_dashboard_aggregation_series
     (id, data_source_id, field_id, aggregation_type, [order]) VALUES (510, 500, 30, 'count', 1)`
  ).run();
  await db.prepare(
    `INSERT INTO supertask_dashboard_aggregation_group_by
     (id, data_source_id, field_id, [order]) VALUES (511, 500, 31, 1)`
  ).run();
  await db.prepare(
    `INSERT INTO supertask_dashboard_aggregation_sort
     (id, data_source_id, sort_on, reference, direction, [order])
     VALUES (512, 500, 'GROUP_BY', 'field_31', 'ASC', 1)`
  ).run();
  await db.prepare(
    `INSERT INTO supertask_dashboard_widget
     (id, dashboard_id, type, title, description, [order], data_source_id, config, created_on, updated_on)
     VALUES (520, 14, 'chart', 'Customers by status', 'Active customers', 1, 500, ?, ?, ?)`
  ).bind(JSON.stringify({ default_series_chart_type: "BAR", series_config: [{ series_id: 510, series_chart_type: "BAR" }] }), now, now).run();

  const r2 = createR2();
  r2.objects.set("user_files/favicon.png", {
    body: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")),
  });
  r2.objects.set("user_files/row-document.pdf", {
    body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  });
  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    SECRET_KEY: "test-secret",
    CACHE: { get: async () => null, put: async () => undefined },
    FILES: r2.bucket,
    JOBS_QUEUE: null,
    ENVIRONMENT: "test",
    PUBLIC_URL: "https://test.local",
  } as any;
  env.JOBS_QUEUE = {
    async send(body: any) {
      await worker.queue({
        messages: [{ body, ack: () => undefined, retry: () => undefined }],
      } as any, env);
    },
  };
  const token = await signAccessToken({ user_id: 7, email: "owner@example.com", username: "owner@example.com" }, "test-secret", 60);
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  return { db, env, token, ctx, objects: r2.objects };
}

async function api(env: any, ctx: any, token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `JWT ${token}`);
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return worker.fetch(new Request(`https://test.local${path}`, { ...init, headers }), env, ctx);
}

function parseWorkspaceArchive(bytes: Uint8Array) {
  const entries = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const item = manifest.applications.database.items[0];
  const schema = JSON.parse(strFromU8(entries[item.files.schema]));
  return { entries, manifest, item, schema };
}

function archiveSchema(entries: Record<string, Uint8Array>, manifest: any, type: string) {
  const item = manifest.applications[type].items[0];
  return JSON.parse(strFromU8(entries[item.files.schema]));
}

describe("workspace import and export package parity", () => {
  it("exports a Baserow manifest ZIP and imports the selected application", async () => {
    const { db, env, token, ctx, objects } = await setupFixture();
    const exportResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10] }),
    });
    expect(exportResponse.status).toBe(202);
    const exportJob = await exportResponse.json() as any;
    expect(exportJob).toMatchObject({
      state: "finished",
      application_count: 1,
    });
    expect(exportJob).toMatchObject({ type: "export_applications", state: "finished" });
    expect(exportJob.exported_file_name).toMatch(/^export_[0-9a-f-]+\.zip$/);
    expect(exportJob.exported_file_key).toMatch(/^workspace-exports\/1\/[0-9a-f-]+\.zip$/);
    const listResponse = await api(env, ctx, token, "/api/workspaces/1/export/");
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      results: [expect.objectContaining({
        id: exportJob.id,
        type: "export_applications",
        workspace_id: 1,
        exported_file_name: exportJob.exported_file_name,
      })],
    });

    const stored = objects.get(exportJob.exported_file_key);
    expect(stored?.options?.httpMetadata?.contentType).toBe("application/zip");
    const { entries, manifest, item, schema } = parseWorkspaceArchive(stored!.body);
    expect(entries["manifest_signature.json"]).toBeInstanceOf(Uint8Array);
    expect(manifest).toMatchObject({
      version: "1.0.0",
      baserow_version: "1.0.0",
      configuration: { only_structure: false },
      total_files: Object.keys(entries).length,
    });
    expect(item).toMatchObject({ id: 10, type: "database", name: "Database", total_files: 2 });
    expect(manifest.applications.builder).toBeUndefined();
    expect(schema.tables[0].rows).toEqual([]);
    expect(item.files.row_chunks).toEqual([
      expect.objectContaining({ table_id: 20, row_count: 1 }),
    ]);
    const exportedRows = JSON.parse(strFromU8(entries[item.files.row_chunks[0].name]));
    expect(exportedRows).toEqual([expect.objectContaining({ field_30: "Alice" })]);
    expect(schema.user_files).toEqual([
      expect.objectContaining({
        name: "row-document.pdf",
        original_name: "Customer contract.pdf",
        mime_type: "application/pdf",
      }),
    ]);
    expect(schema.enterprise.role_assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject_id: 8, scope_id: 10, scope_type: "application", role_uid: "VIEWER" }),
      expect.objectContaining({ subject_id: 8, scope_id: 20, scope_type: "table", role_uid: "COMMENTER" }),
      expect.objectContaining({ subject_id: 8, scope_id: 80, scope_type: "view", role_uid: "VIEWER" }),
      expect.objectContaining({ subject_id: 8, scope_id: 32, scope_type: "field", role_uid: "NO_ACCESS" }),
    ]));
    expect(schema.enterprise.field_permissions).toEqual([
      expect.objectContaining({ field_id: 32, role_uid: "NOBODY", allow_write: 0, allow_in_forms: 0 }),
    ]);
    expect(Array.from(entries["row-document.pdf"])).toEqual([0x25, 0x50, 0x44, 0x46]);
    const schemaDataSyncTable = schema.tables.find((table: any) => table.table.name === "Customers mirror");
    expect(schemaDataSyncTable?.data_sync?.data_sync).toMatchObject({
      type: "local_baserow_table",
      auto_add_new_properties: 0,
      two_way_sync: 0,
      periodic_interval: "day",
      periodic_interval_count: 2,
    });
    expect(schemaDataSyncTable?.data_sync?.synced_properties.map((property: any) => property.key)).toEqual(["id", "field_30", "field_31"]);

    await db.prepare("DELETE FROM core_userfile WHERE name='row-document.pdf'").run();
    objects.delete("user_files/row-document.pdf");

    const formData = new FormData();
    formData.append("file", new Blob([stored!.body], { type: "application/zip" }), "workspace.zip");
    const uploadResponse = await api(env, ctx, token, "/api/workspaces/1/import/upload-file/", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toBe(200);
    const upload = await uploadResponse.json() as any;
    expect(upload.id).toBe(upload.resource_id);
    expect(objects.get(upload.key)?.streamed).toBe(true);

    const importResponse = await api(env, ctx, token, "/api/workspaces/1/import/async/", {
      method: "POST",
      body: JSON.stringify({ resource_id: upload.id, application_ids: [10] }),
    });
    expect(importResponse.status).toBe(202);
    const importJob = await importResponse.json() as any;
    expect(importJob.installed_applications).toHaveLength(1);
    expect(importJob.imported_applications).toEqual(importJob.installed_applications);
    expect(importJob.installed_applications[0]).toMatchObject({ name: "Database", type: "database", workspace_id: 1 });

    const restoredTables = await db.prepare("SELECT t.id, t.name, t.data_sync_id FROM database_table t JOIN core_application a ON a.id=t.database_id WHERE a.id=? ORDER BY t.[order] ASC, t.id ASC")
      .bind(importJob.installed_applications[0].id)
      .all<any>();
    expect(restoredTables.results.map((row: any) => row.name)).toEqual(["Customers", "Customers mirror"]);
    const restoredTableId = await db.prepare("SELECT id FROM database_table WHERE database_id=? AND name='Customers'")
      .bind(importJob.installed_applications[0].id)
      .first<any>();
    const restoredNameField = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND name='Name'")
      .bind(restoredTableId.id)
      .first<any>();
    const restoredRows = await db.prepare(`SELECT "field_${restoredNameField.id}" AS name FROM "database_table_${restoredTableId.id}"`).all<any>();
    expect(restoredRows.results).toHaveLength(1);
    expect(restoredRows.results[0].name).toBe("Alice");
    const restoredContractField = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND name='Contract'")
      .bind(restoredTableId.id)
      .first<any>();
    const restoredAIField = await db.prepare("SELECT id, field_settings FROM database_field WHERE table_id=? AND name='AI summary'")
      .bind(restoredTableId.id)
      .first<any>();
    expect(JSON.parse(restoredAIField.field_settings)).toMatchObject({
      ai_prompt: { formula: `CONCAT('Summary ', get('fields.field_${restoredNameField.id}'))` },
      ai_file_field_id: restoredContractField.id,
      ai_auto_update: true,
      ai_auto_update_user_id: 8,
    });
    const restoredAIDependencies = await db.prepare(
      "SELECT dependency_id FROM database_fielddependency WHERE dependant_id=? ORDER BY dependency_id ASC"
    ).bind(restoredAIField.id).all<any>();
    expect(restoredAIDependencies.results.map((item: any) => item.dependency_id)).toEqual([
      restoredNameField.id,
      restoredContractField.id,
    ].sort((left, right) => left - right));
    const restoredContractCell = await db.prepare(`SELECT "field_${restoredContractField.id}" AS contract FROM "database_table_${restoredTableId.id}"`)
      .first<any>();
    expect(JSON.parse(restoredContractCell.contract)).toEqual([
      expect.objectContaining({ name: "row-document.pdf", visible_name: "Renamed contract.pdf" }),
    ]);
    expect(await db.prepare("SELECT original_name, mime_type FROM core_userfile WHERE name='row-document.pdf'").first<any>())
      .toEqual({ original_name: "Customer contract.pdf", mime_type: "application/pdf" });
    expect(Array.from(objects.get("user_files/row-document.pdf")!.body)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(objects.get("user_files/row-document.pdf")?.streamed).toBe(true);
    expect([...objects.keys()].some((key) => key.startsWith("workspace-import-extracted/"))).toBe(false);
    const restoredView = await db.prepare("SELECT id FROM database_view WHERE table_id=? AND name='Grid'")
      .bind(restoredTableId.id)
      .first<any>();
    const importedAssignments = await db.prepare(
      `SELECT ra.scope_type, ra.scope_id, r.uid AS role_uid
         FROM enterprise_roleassignment ra
         JOIN enterprise_role r ON r.id=ra.role_id
        WHERE ra.subject_id=8 AND ra.subject_type='auth.User'
          AND ((ra.scope_type='application' AND ra.scope_id=?)
            OR (ra.scope_type='table' AND ra.scope_id=?)
            OR (ra.scope_type='view' AND ra.scope_id=?)
            OR (ra.scope_type='field' AND ra.scope_id=?))
        ORDER BY ra.scope_type ASC`
    ).bind(importJob.installed_applications[0].id, restoredTableId.id, restoredView.id, restoredContractField.id).all<any>();
    expect(importedAssignments.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope_type: "application", role_uid: "VIEWER" }),
      expect.objectContaining({ scope_type: "table", role_uid: "COMMENTER" }),
      expect.objectContaining({ scope_type: "view", role_uid: "VIEWER" }),
      expect.objectContaining({ scope_type: "field", role_uid: "NO_ACCESS" }),
    ]));
    expect(await db.prepare(
      "SELECT role_uid, allow_read, allow_write, allow_in_forms FROM enterprise_fieldpermission WHERE field_id=?"
    ).bind(restoredContractField.id).first<any>()).toEqual({
      role_uid: "NOBODY",
      allow_read: 1,
      allow_write: 0,
      allow_in_forms: 0,
    });
    const restoredMirror = restoredTables.results.find((row: any) => row.name === "Customers mirror");
    const restoredDataSync = await db.prepare("SELECT * FROM database_datasync WHERE table_id=?")
      .bind(restoredMirror.id)
      .first<any>();
    expect(restoredDataSync).toMatchObject({
      type: "local_baserow_table",
      auto_add_new_properties: 0,
      two_way_sync: 0,
      periodic_interval: "day",
      periodic_interval_count: 2,
    });
    expect(JSON.parse(restoredDataSync.settings).source_table_id).toBe(restoredTableId.id);
    const restoredStatusField = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND name='Status'")
      .bind(restoredTableId.id)
      .first<any>();
    const restoredProperties = await db.prepare(
      "SELECT key, unique_primary FROM database_datasyncsyncedproperty WHERE data_sync_id=? ORDER BY id ASC"
    ).bind(restoredDataSync.id).all<any>();
    expect(restoredProperties.results).toEqual([
      expect.objectContaining({ key: "id", unique_primary: 1 }),
      expect.objectContaining({ key: `field_${restoredNameField.id}`, unique_primary: 0 }),
      expect.objectContaining({ key: `field_${restoredStatusField.id}`, unique_primary: 0 }),
    ]);

    await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (2, 'Target', ?, 0, 1)")
      .bind("2026-05-27T10:00:00.000Z")
      .run();
    await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (2, 7, 'ADMIN')").run();
    const targetForm = new FormData();
    targetForm.append("file", new Blob([stored!.body], { type: "application/zip" }), "workspace-target.zip");
    const targetUploadResponse = await api(env, ctx, token, "/api/workspaces/2/import/upload-file/", {
      method: "POST",
      body: targetForm,
    });
    expect(targetUploadResponse.status).toBe(200);
    const targetUpload = await targetUploadResponse.json() as any;
    const targetImportResponse = await api(env, ctx, token, "/api/workspaces/2/import/async/", {
      method: "POST",
      body: JSON.stringify({ resource_id: targetUpload.id, application_ids: [10] }),
    });
    expect(targetImportResponse.status).toBe(202);
    const targetImport = await targetImportResponse.json() as any;
    const targetTable = await db.prepare("SELECT id FROM database_table WHERE database_id=? AND name='Customers'")
      .bind(targetImport.installed_applications[0].id)
      .first<any>();
    const targetAIField = await db.prepare("SELECT field_settings FROM database_field WHERE table_id=? AND name='AI summary'")
      .bind(targetTable.id)
      .first<any>();
    expect(JSON.parse(targetAIField.field_settings)).toMatchObject({
      ai_auto_update: false,
      ai_auto_update_user_id: null,
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM database_fielddependency WHERE dependant_id=(SELECT id FROM database_field WHERE table_id=? AND name='AI summary')"
    ).bind(targetTable.id).first<any>())?.count).toBe(2);
  });

  it("queues workspace exports and exposes Baserow pending-to-finished job contracts", async () => {
    const { env, token, ctx, objects } = await setupFixture();
    const queued: any[] = [];
    env.JOBS_QUEUE = {
      async send(body: any) {
        queued.push(body);
      },
    };

    const startResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10], only_structure: false }),
    });
    expect(startResponse.status).toBe(202);
    const started = await startResponse.json() as any;
    expect(started).toMatchObject({
      type: "export_applications",
      state: "pending",
      status: "pending",
      progress_percentage: 0,
      workspace_id: 1,
    });
    expect(queued).toEqual([expect.objectContaining({
      job_id: started.id,
      job_type: "export_applications",
      workspace_id: 1,
      payload: expect.objectContaining({ workspace_id: 1, application_ids: [10] }),
    })]);
    expect([...objects.keys()].some((key) => key.startsWith("workspace-exports/1/"))).toBe(false);
    const duplicateResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10] }),
    });
    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.json()).toEqual({
      error: "ERROR_MAX_JOB_COUNT_EXCEEDED",
      detail: "A workspace export job is already running.",
    });
    expect(queued).toHaveLength(1);

    const pendingList = await api(env, ctx, token, "/api/workspaces/1/export/");
    expect(await pendingList.json()).toEqual({ results: [] });

    await worker.queue({
      messages: [{ body: queued[0], ack: () => undefined, retry: () => undefined }],
    } as any, env);
    const finishedResponse = await api(env, ctx, token, `/api/jobs/${started.id}/`);
    expect(finishedResponse.status).toBe(200);
    const finished = await finishedResponse.json() as any;
    expect(finished).toMatchObject({
      type: "export_applications",
      state: "finished",
      progress_percentage: 100,
      workspace_id: 1,
      application_count: 1,
    });
    expect(objects.has(finished.exported_file_key)).toBe(true);
    const finishedList = await api(env, ctx, token, "/api/workspaces/1/export/");
    expect(await finishedList.json()).toEqual({
      results: [expect.objectContaining({ id: started.id, type: "export_applications", state: "finished" })],
    });

    const archive = objects.get(finished.exported_file_key)!.body;
    const form = new FormData();
    form.append("file", new Blob([archive], { type: "application/zip" }), "queued-import.zip");
    const uploadResponse = await api(env, ctx, token, "/api/workspaces/1/import/upload-file/", {
      method: "POST",
      body: form,
    });
    expect(uploadResponse.status).toBe(200);
    const uploadResource = await uploadResponse.json() as any;
    queued.length = 0;
    const importResponse = await api(env, ctx, token, "/api/workspaces/1/import/async/", {
      method: "POST",
      body: JSON.stringify({ resource_id: uploadResource.id, application_ids: [10] }),
    });
    expect(importResponse.status).toBe(202);
    const startedImport = await importResponse.json() as any;
    expect(startedImport).toMatchObject({ type: "import_applications", state: "pending" });
    const duplicateImportResponse = await api(env, ctx, token, "/api/workspaces/1/import/async/", {
      method: "POST",
      body: JSON.stringify({ resource_id: uploadResource.id, application_ids: [10] }),
    });
    expect(duplicateImportResponse.status).toBe(400);
    expect(await duplicateImportResponse.json()).toEqual({
      error: "ERROR_MAX_JOB_COUNT_EXCEEDED",
      detail: "A workspace import job is already running.",
    });
    expect(queued).toHaveLength(1);
    await worker.queue({
      messages: [{ body: queued[0], ack: () => undefined, retry: () => undefined }],
    } as any, env);
    const importedResponse = await api(env, ctx, token, `/api/jobs/${startedImport.id}/`);
    expect(await importedResponse.json()).toMatchObject({ type: "import_applications", state: "finished" });
  });

  it("rejects non-ZIP and oversized workspace uploads before storing a resource", async () => {
    const { env, token, ctx, objects } = await setupFixture();
    const invalidForm = new FormData();
    invalidForm.append("file", new Blob([new Uint8Array([1, 2, 3, 4])]), "invalid.bin");
    const invalidResponse = await api(env, ctx, token, "/api/workspaces/1/import/upload-file/", {
      method: "POST",
      body: invalidForm,
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({
      error: "INVALID_REQUEST",
      detail: "The provided file is not a valid ZIP workspace export.",
    });
    expect([...objects.keys()].some((key) => key.startsWith("workspace-imports/1/"))).toBe(false);

    env.BASEROW_FILE_UPLOAD_SIZE_LIMIT_MB = "1";
    const oversizedForm = new FormData();
    oversizedForm.append("file", new Blob([new Uint8Array(1024 * 1024 + 1)]), "oversized.zip");
    const oversizedResponse = await api(env, ctx, token, "/api/workspaces/1/import/upload-file/", {
      method: "POST",
      body: oversizedForm,
    });
    expect(oversizedResponse.status).toBe(400);
    expect(await oversizedResponse.json()).toEqual({
      error: "ERROR_FILE_SIZE_TOO_LARGE",
      detail: "The provided file is too large. The maximum size is 1 MB.",
    });
    expect([...objects.keys()].some((key) => key.startsWith("workspace-imports/1/"))).toBe(false);
  });

  it("maps canonical RBAC scopes, users by email and teams by name across workspaces", async () => {
    const { db, env, token, ctx, objects } = await setupFixture();
    const now = "2026-05-27T10:00:00.000Z";
    await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (2, 'Target', ?, 0, 2)")
      .bind(now).run();
    await db.prepare(
      "INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (2, 7, 'ADMIN'), (2, 8, 'EDITOR')"
    ).run();
    await db.prepare(
      `INSERT INTO enterprise_team (id, workspace_id, name, default_role_uid, created_on, trashed)
       VALUES (301, 1, 'Operators', 'VIEWER', ?, 0), (302, 2, 'Operators', 'VIEWER', ?, 0)`
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO enterprise_roleassignment (role_id, subject_id, subject_type, scope_id, scope_type)
       VALUES ((SELECT id FROM enterprise_role WHERE uid='VIEWER'), 8, 'auth.User', 20, 'database_table'),
              ((SELECT id FROM enterprise_role WHERE uid='COMMENTER'), 301, 'baserow_enterprise.Team', 32, 'database_field')`
    ).run();

    const exportResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10] }),
    });
    expect(exportResponse.status).toBe(202);
    const exportJob = await exportResponse.json() as any;
    const stored = objects.get(exportJob.exported_file_key)!;
    const { schema } = parseWorkspaceArchive(stored.body);
    expect(schema.enterprise.role_assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope_type: "database_table",
        subject_type: "auth.User",
        subject_email: "member@example.com",
      }),
      expect.objectContaining({
        scope_type: "database_field",
        subject_type: "baserow_enterprise.Team",
        subject_name: "Operators",
      }),
    ]));

    const formData = new FormData();
    formData.append("file", new Blob([stored.body], { type: "application/zip" }), "rbac-workspace.zip");
    const uploadResponse = await api(env, ctx, token, "/api/workspaces/2/import/upload-file/", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toBe(200);
    const upload = await uploadResponse.json() as any;
    const importResponse = await api(env, ctx, token, "/api/workspaces/2/import/async/", {
      method: "POST",
      body: JSON.stringify({ resource_id: upload.id, application_ids: [10] }),
    });
    expect(importResponse.status).toBe(202);
    const imported = await importResponse.json() as any;
    const applicationId = Number(imported.installed_applications[0].id);
    const table = await db.prepare("SELECT id FROM database_table WHERE database_id=? AND name='Customers'")
      .bind(applicationId).first<any>();
    const field = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND name='Contract'")
      .bind(table.id).first<any>();

    expect(await db.prepare(
      `SELECT ra.subject_id, ra.scope_id, r.uid AS role_uid
       FROM enterprise_roleassignment ra JOIN enterprise_role r ON r.id=ra.role_id
       WHERE ra.subject_type='auth.User' AND ra.scope_type='database_table' AND ra.scope_id=?`
    ).bind(table.id).first<any>()).toEqual({ subject_id: 8, scope_id: table.id, role_uid: "VIEWER" });
    expect(await db.prepare(
      `SELECT ra.subject_id, ra.scope_id, r.uid AS role_uid
       FROM enterprise_roleassignment ra JOIN enterprise_role r ON r.id=ra.role_id
       WHERE ra.subject_type='baserow_enterprise.Team' AND ra.scope_type='database_field' AND ra.scope_id=?`
    ).bind(field.id).first<any>()).toEqual({ subject_id: 302, scope_id: field.id, role_uid: "COMMENTER" });
  });

  it("honors Baserow only_structure exports by excluding row data from schema files", async () => {
    const { env, token, ctx, objects } = await setupFixture();
    const exportResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10], only_structure: true }),
    });
    expect(exportResponse.status).toBe(202);
    const exportJob = await exportResponse.json() as any;
    const stored = objects.get(exportJob.exported_file_key);
    const { entries, manifest, schema } = parseWorkspaceArchive(stored!.body);
    expect(manifest.configuration.only_structure).toBe(true);
    expect(schema.tables.every((table: any) => Array.isArray(table.rows) && table.rows.length === 0)).toBe(true);
    expect(schema.user_files).toEqual([]);
    expect(entries["row-document.pdf"]).toBeUndefined();
  });

  it("uploads large workspace archives in uniform R2 multipart chunks", async () => {
    const { db, env, token, ctx, objects } = await setupFixture();
    const largeFile = new Uint8Array(9 * 1024 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < largeFile.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      largeFile[index] = state & 0xff;
    }
    objects.set("user_files/row-document.pdf", { body: largeFile });
    await db.prepare("UPDATE core_userfile SET size=? WHERE name='row-document.pdf'")
      .bind(largeFile.length)
      .run();

    const exportResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10] }),
    });
    expect(exportResponse.status).toBe(202);
    const exportJob = await exportResponse.json() as any;
    const stored = objects.get(exportJob.exported_file_key)!;
    expect(stored.multipartPartSizes?.length).toBeGreaterThan(1);
    expect(stored.multipartPartSizes?.[0]).toBe(8 * 1024 * 1024);
    expect(stored.multipartPartSizes?.slice(0, -1).every((size) => size === 8 * 1024 * 1024)).toBe(true);
    expect(stored.multipartPartSizes?.at(-1)).toBeGreaterThan(0);
    expect(stored.multipartPartSizes?.at(-1)).toBeLessThan(8 * 1024 * 1024);
    const { entries } = parseWorkspaceArchive(stored.body);
    expect(entries["row-document.pdf"]).toEqual(largeFile);
  }, 120_000);

  it("rejects a workspace archive when a checksummed user file has been altered", async () => {
    const { env, token, ctx, objects } = await setupFixture();
    const exportResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10] }),
    });
    const exportJob = await exportResponse.json() as any;
    const stored = objects.get(exportJob.exported_file_key)!;
    const entries = unzipSync(stored.body);
    entries["row-document.pdf"] = new Uint8Array([0x42, 0x41, 0x44]);
    const alteredArchive = zipSync(entries);

    const formData = new FormData();
    formData.append("file", new Blob([alteredArchive], { type: "application/zip" }), "altered-workspace.zip");
    const uploadResponse = await api(env, ctx, token, "/api/workspaces/1/import/upload-file/", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toBe(400);
    expect(await uploadResponse.json()).toEqual({
      error: "INVALID_REQUEST",
      detail: "The uploaded workspace export checksum failed for row-document.pdf.",
    });
    expect([...objects.keys()].some((key) => key.startsWith("workspace-imports/1/"))).toBe(false);
  });

  it("compensates every D1 table, permission and R2 file after a multi-application import fails", async () => {
    const { db, env, token, ctx, objects } = await setupFixture();
    const exportResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10, 11] }),
    });
    expect(exportResponse.status).toBe(202);
    const exportJob = await exportResponse.json() as any;
    const archive = objects.get(exportJob.exported_file_key)!.body;

    await db.prepare('UPDATE "database_table_20" SET field_32=?').bind("[]").run();
    await db.prepare("UPDATE builder_settings SET favicon_file=NULL WHERE builder_id=11").run();
    await db.prepare("DELETE FROM core_userfile WHERE name IN ('row-document.pdf', 'favicon.png')").run();
    objects.delete("user_files/row-document.pdf");
    objects.delete("user_files/favicon.png");
    const beforeApplications = await db.prepare("SELECT id FROM core_application ORDER BY id").all<any>();
    const beforeDynamicTables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'database_table_[0-9]*' ORDER BY name"
    ).all<any>();

    const formData = new FormData();
    formData.append("file", new Blob([archive], { type: "application/zip" }), "multi-application.zip");
    const uploadResponse = await api(env, ctx, token, "/api/workspaces/1/import/upload-file/", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toBe(200);
    const upload = await uploadResponse.json() as any;

    const originalDb = env.DB;
    let applicationInsertCount = 0;
    env.DB = {
      ...originalDb,
      prepare(sql: string) {
        const statement = originalDb.prepare(sql);
        if (!sql.includes("INSERT INTO core_application")) return statement;
        return {
          ...statement,
          bind(...args: unknown[]) {
            const bound = statement.bind(...args);
            return {
              ...bound,
              async first<T = any>() {
                applicationInsertCount += 1;
                if (applicationInsertCount === 2) throw new Error("forced second application restore failure");
                return bound.first<T>();
              },
            };
          },
        };
      },
    };

    const importResponse = await api(env, ctx, token, "/api/workspaces/1/import/async/", {
      method: "POST",
      body: JSON.stringify({ resource_id: upload.id }),
    });
    expect(importResponse.status).toBe(202);
    const failedJob = await importResponse.json() as any;
    expect(failedJob).toMatchObject({
      type: "import_applications",
      state: "failed",
      progress_percentage: 100,
      human_readable_error: "forced second application restore failure",
    });
    await worker.queue({
      messages: [{
        body: {
          job_id: failedJob.id,
          job_type: "import_applications",
          payload: { workspace_id: 1, resource_id: upload.id, application_ids: [] },
          user_id: 7,
          workspace_id: 1,
        },
        ack: () => undefined,
        retry: () => undefined,
      }],
    } as any, env);
    expect(applicationInsertCount).toBe(2);

    const afterApplications = await db.prepare("SELECT id FROM core_application ORDER BY id").all<any>();
    const afterDynamicTables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'database_table_[0-9]*' ORDER BY name"
    ).all<any>();
    expect(afterApplications.results).toEqual(beforeApplications.results);
    expect(afterDynamicTables.results).toEqual(beforeDynamicTables.results);
    expect((await db.prepare(
      "SELECT name FROM core_userfile WHERE name IN ('row-document.pdf', 'favicon.png') ORDER BY name"
    ).all<any>()).results).toEqual([]);
    expect(objects.has("user_files/row-document.pdf")).toBe(false);
    expect(objects.has("user_files/favicon.png")).toBe(false);
    expect([...objects.keys()].some((key) => key.startsWith("workspace-import-extracted/"))).toBe(false);
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM enterprise_roleassignment WHERE scope_id NOT IN (10, 20, 32, 80)"
    ).first<any>())?.count).toBe(0);
  });

  it("restores snapshot files after the original D1 metadata and R2 object are deleted", async () => {
    const { db, env, token, ctx, objects } = await setupFixture();
    const createResponse = await api(env, ctx, token, "/api/snapshots/application/10/", {
      method: "POST",
      body: JSON.stringify({ name: "Database with files" }),
    });
    expect(createResponse.status).toBe(202);
    const createJob = await createResponse.json() as any;
    const snapshotId = Number(createJob.snapshot.id);
    const archiveKey = `snapshots/${snapshotId}.json`;
    const archive = objects.get(archiveKey);
    expect(archive?.options?.httpMetadata?.contentType).toBe("application/zip");
    expect(archive?.streamed).toBe(true);
    expect(Array.from(archive!.body.slice(0, 2))).toEqual([0x50, 0x4b]);

    const snapshotEntries = unzipSync(archive!.body);
    const snapshotData = JSON.parse(strFromU8(snapshotEntries["snapshot.json"]));
    expect(snapshotData.tables[0].rows).toEqual([]);
    expect(snapshotData.row_chunks).toEqual([
      expect.objectContaining({ table_id: 20, row_count: 1 }),
    ]);
    expect(JSON.parse(strFromU8(snapshotEntries[snapshotData.row_chunks[0].name]))).toEqual([
      expect.objectContaining({ id: 1, field_30: "Alice" }),
    ]);
    expect(snapshotData.user_files).toEqual([
      expect.objectContaining({
        name: "row-document.pdf",
        original_name: "Customer contract.pdf",
      }),
    ]);
    expect(Array.from(snapshotEntries["row-document.pdf"])).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(snapshotData.enterprise.role_assignments).toHaveLength(4);
    expect(snapshotData.enterprise.field_permissions).toEqual([
      expect.objectContaining({ field_id: 32, role_uid: "NOBODY", allow_write: 0, allow_in_forms: 0 }),
    ]);
    const formBundle = snapshotData.tables[0].views.find((bundle: any) => bundle.view.id === 81);
    expect(formBundle.form_users_to_notify).toEqual([{ formview_id: 81, user_id: 7 }]);

    const duplicateResponse = await api(env, ctx, token, "/api/snapshots/application/10/", {
      method: "POST",
      body: JSON.stringify({ name: "Database with files" }),
    });
    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.json()).toEqual({
      error: "ERROR_SNAPSHOT_NAME_NOT_UNIQUE",
      detail: "Snapshots names must be unique per application.",
    });

    await db.prepare("DELETE FROM core_userfile WHERE name='row-document.pdf'").run();
    objects.delete("user_files/row-document.pdf");

    const restoreResponse = await api(env, ctx, token, `/api/snapshots/${snapshotId}/restore/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(restoreResponse.status).toBe(200);
    const restoreJob = await restoreResponse.json() as any;
    const restoredApplicationId = Number(restoreJob.application.id);
    expect(restoredApplicationId).not.toBe(10);
    expect(restoreJob.application.name).toBe("Database with files");

    const restoredSnapshot = await db.prepare("SELECT snapshot_to_application_id FROM core_snapshot WHERE id=?")
      .bind(snapshotId)
      .first<any>();
    expect(restoredSnapshot.snapshot_to_application_id).toBe(restoredApplicationId);
    expect(await db.prepare("SELECT original_name, mime_type FROM core_userfile WHERE name='row-document.pdf'").first<any>())
      .toEqual({ original_name: "Customer contract.pdf", mime_type: "application/pdf" });
    expect(Array.from(objects.get("user_files/row-document.pdf")!.body)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(objects.get("user_files/row-document.pdf")?.streamed).toBe(true);
    expect([...objects.keys()].some((key) => key.startsWith("snapshot-restore-extracted/"))).toBe(false);

    const restoredTable = await db.prepare("SELECT id FROM database_table WHERE database_id=? AND name='Customers'")
      .bind(restoredApplicationId)
      .first<any>();
    const restoredFileField = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND name='Contract'")
      .bind(restoredTable.id)
      .first<any>();
    const restoredCell = await db.prepare(`SELECT "field_${restoredFileField.id}" AS value FROM "database_table_${restoredTable.id}"`)
      .first<any>();
    expect(JSON.parse(restoredCell.value)).toEqual([
      expect.objectContaining({ name: "row-document.pdf", visible_name: "Renamed contract.pdf" }),
    ]);
    const restoredView = await db.prepare("SELECT id FROM database_view WHERE table_id=? AND name='Grid'")
      .bind(restoredTable.id)
      .first<any>();
    const restoredForm = await db.prepare(
      "SELECT id, ownership_type, owned_by_id, show_logo FROM database_view WHERE table_id=? AND name='Intake form'"
    ).bind(restoredTable.id).first<any>();
    expect(restoredForm).toMatchObject({ ownership_type: "personal", owned_by_id: 7, show_logo: 0 });
    expect(await db.prepare(
      "SELECT user_id FROM database_formview_users_to_notify_on_submit WHERE formview_id=?"
    ).bind(restoredForm.id).first<any>()).toEqual({ user_id: 7 });
    const restoredAssignments = await db.prepare(
      `SELECT ra.scope_type, ra.scope_id, r.uid AS role_uid
         FROM enterprise_roleassignment ra
         JOIN enterprise_role r ON r.id=ra.role_id
        WHERE ra.subject_id=8 AND ra.subject_type='auth.User'
          AND ((ra.scope_type='application' AND ra.scope_id=?)
            OR (ra.scope_type='table' AND ra.scope_id=?)
            OR (ra.scope_type='view' AND ra.scope_id=?)
            OR (ra.scope_type='field' AND ra.scope_id=?))`
    ).bind(restoredApplicationId, restoredTable.id, restoredView.id, restoredFileField.id).all<any>();
    expect(restoredAssignments.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope_type: "application", role_uid: "VIEWER" }),
      expect.objectContaining({ scope_type: "table", role_uid: "COMMENTER" }),
      expect.objectContaining({ scope_type: "view", role_uid: "VIEWER" }),
      expect.objectContaining({ scope_type: "field", role_uid: "NO_ACCESS" }),
    ]));
    expect(await db.prepare(
      "SELECT role_uid, allow_read, allow_write, allow_in_forms FROM enterprise_fieldpermission WHERE field_id=?"
    ).bind(restoredFileField.id).first<any>()).toEqual({
      role_uid: "NOBODY",
      allow_read: 1,
      allow_write: 0,
      allow_in_forms: 0,
    });

    const secondRestoreResponse = await api(env, ctx, token, `/api/snapshots/${snapshotId}/restore/`, {
      method: "POST",
    });
    expect(secondRestoreResponse.status).toBe(200);
    const secondRestoreJob = await secondRestoreResponse.json() as any;
    expect(secondRestoreJob.application.name).toBe("Database with files 2");
    expect(secondRestoreJob.application.id).not.toBe(restoredApplicationId);
    expect(await db.prepare("SELECT snapshot_to_application_id FROM core_snapshot WHERE id=?")
      .bind(snapshotId)
      .first<any>()).toEqual({ snapshot_to_application_id: secondRestoreJob.application.id });
    expect([...objects.keys()].some((key) => key.startsWith("snapshot-restore-extracted/"))).toBe(false);

    const deleteResponse = await api(env, ctx, token, `/api/snapshots/${snapshotId}/`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);
    expect(objects.has(archiveKey)).toBe(false);
    expect(await db.prepare("SELECT id FROM core_snapshot WHERE id=?").bind(snapshotId).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM core_application WHERE id=?").bind(restoredApplicationId).first<any>())
      .toEqual({ id: restoredApplicationId });
    expect(await db.prepare("SELECT id FROM core_application WHERE id=?").bind(secondRestoreJob.application.id).first<any>())
      .toEqual({ id: secondRestoreJob.application.id });
  });

  it("cleans temporary snapshot entries when a streamed archive is incomplete", async () => {
    const { db, env, token, ctx, objects } = await setupFixture();
    const createResponse = await api(env, ctx, token, "/api/snapshots/application/10/", {
      method: "POST",
      body: JSON.stringify({ name: "Incomplete snapshot" }),
    });
    expect(createResponse.status).toBe(202);
    const snapshotId = Number((await createResponse.json() as any).snapshot.id);
    const archiveKey = `snapshots/${snapshotId}.json`;
    const entries = unzipSync(objects.get(archiveKey)!.body);
    delete entries["row-document.pdf"];
    objects.set(archiveKey, { body: zipSync(entries), options: { httpMetadata: { contentType: "application/zip" } } });
    await db.prepare("DELETE FROM core_userfile WHERE name='row-document.pdf'").run();
    objects.delete("user_files/row-document.pdf");

    const beforeApplications = await db.prepare("SELECT id FROM core_application ORDER BY id").all<any>();
    const restoreResponse = await api(env, ctx, token, `/api/snapshots/${snapshotId}/restore/`, { method: "POST" });
    expect(restoreResponse.status).toBe(404);
    expect(await restoreResponse.json()).toMatchObject({
      error: "NOT_FOUND",
      detail: "Snapshot user file with id row-document.pdf does not exist.",
    });
    expect((await db.prepare("SELECT id FROM core_application ORDER BY id").all<any>()).results)
      .toEqual(beforeApplications.results);
    expect([...objects.keys()].some((key) => key.startsWith("snapshot-restore-extracted/"))).toBe(false);
  });

  it("reads snapshot rows from D1 in stable keyset pages", async () => {
    const { db } = await setupFixture();
    const statements = [];
    for (let id = 2; id <= 451; id += 1) {
      statements.push(db.prepare(
        'INSERT INTO "database_table_20" (id, [order], field_30, field_31, field_32, _created_on, _updated_on) VALUES (?, ?, ?, NULL, ?, ?, ?)'
      ).bind(id, id * 10000, `Row ${id}`, "[]", "2026-05-27T10:00:00.000Z", "2026-05-27T10:00:00.000Z"));
    }
    for (let offset = 0; offset < statements.length; offset += 90) {
      await db.batch(statements.slice(offset, offset + 90));
    }

    const pages = [];
    for await (const page of iterateSnapshotTableRows(db as any, 20, 200)) pages.push(page);
    expect(pages.map((page) => page.length)).toEqual([200, 200, 51]);
    expect(pages.flat().map((row) => row.id)).toEqual(Array.from({ length: 451 }, (_, index) => index + 1));
  });

  it("roundtrips document pages and dashboard widgets with remapped database references", async () => {
    const { db, env, token, ctx, objects } = await setupFixture();
    const exportResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10, 13, 14] }),
    });
    expect(exportResponse.status).toBe(202);
    const exportJob = await exportResponse.json() as any;
    const stored = objects.get(exportJob.exported_file_key)!;
    const entries = unzipSync(stored.body);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    const documentSnapshot = archiveSchema(entries, manifest, "document");
    const dashboardSnapshot = archiveSchema(entries, manifest, "dashboard");
    expect(documentSnapshot.document.pages).toEqual([
      expect.objectContaining({ id: 400, parent_id: null, title: "Overview" }),
      expect.objectContaining({ id: 401, parent_id: 400, title: "Details" }),
    ]);
    expect(dashboardSnapshot.dashboard.data_sources[0]).toMatchObject({
      data_source: expect.objectContaining({ id: 500, name: "Customer status" }),
      aggregation_series: [expect.objectContaining({ id: 510, field_id: 30, aggregation_type: "count" })],
      aggregation_group_bys: [expect.objectContaining({ field_id: 31 })],
      aggregation_sorts: [expect.objectContaining({ reference: "field_31", direction: "ASC" })],
    });
    expect(dashboardSnapshot.dashboard.widgets).toEqual([
      expect.objectContaining({ id: 520, data_source_id: 500, title: "Customers by status" }),
    ]);

    const formData = new FormData();
    formData.append("file", new Blob([stored.body], { type: "application/zip" }), "applications.zip");
    const uploadResponse = await api(env, ctx, token, "/api/workspaces/1/import/upload-file/", {
      method: "POST",
      body: formData,
    });
    const upload = await uploadResponse.json() as any;
    const importResponse = await api(env, ctx, token, "/api/workspaces/1/import/async/", {
      method: "POST",
      body: JSON.stringify({ resource_id: upload.id, application_ids: [10, 13, 14] }),
    });
    expect(importResponse.status).toBe(202);
    const importJob = await importResponse.json() as any;
    const restoredDatabase = importJob.installed_applications.find((application: any) => application.type === "database");
    const restoredDocument = importJob.installed_applications.find((application: any) => application.type === "document");
    const restoredDashboard = importJob.installed_applications.find((application: any) => application.type === "dashboard");
    expect([restoredDatabase, restoredDocument, restoredDashboard].every(Boolean)).toBe(true);

    const restoredPages = await db.prepare(
      "SELECT id, parent_id, title, content, icon, [order] FROM supertask_document_page WHERE document_id=? ORDER BY [order], id"
    ).bind(restoredDocument.id).all<any>();
    expect(restoredPages.results).toHaveLength(2);
    expect(restoredPages.results[0]).toMatchObject({ parent_id: null, title: "Overview", icon: "document", order: 1 });
    expect(restoredPages.results[1]).toMatchObject({
      parent_id: restoredPages.results[0].id,
      title: "Details",
      icon: "page",
      order: 2,
    });
    expect(JSON.parse(restoredPages.results[1].content).content[0].text).toBe("Customer details");

    const restoredTable = await db.prepare("SELECT id FROM database_table WHERE database_id=? AND name='Customers'")
      .bind(restoredDatabase.id)
      .first<any>();
    const restoredNameField = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND name='Name'")
      .bind(restoredTable.id)
      .first<any>();
    const restoredStatusField = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND name='Status'")
      .bind(restoredTable.id)
      .first<any>();
    const restoredView = await db.prepare("SELECT id FROM database_view WHERE table_id=? AND name='Grid'")
      .bind(restoredTable.id)
      .first<any>();
    const restoredIntegration = await db.prepare("SELECT id, configuration FROM core_integration WHERE application_id=?")
      .bind(restoredDashboard.id)
      .first<any>();
    expect(JSON.parse(restoredIntegration.configuration)).toMatchObject({
      table_id: restoredTable.id,
      view_id: restoredView.id,
    });

    const restoredSource = await db.prepare("SELECT id, service FROM supertask_dashboard_data_source WHERE dashboard_id=?")
      .bind(restoredDashboard.id)
      .first<any>();
    expect(JSON.parse(restoredSource.service)).toMatchObject({
      integration_id: restoredIntegration.id,
      table_id: restoredTable.id,
      view_id: restoredView.id,
    });
    const restoredSeries = await db.prepare(
      "SELECT id, field_id, aggregation_type FROM supertask_dashboard_aggregation_series WHERE data_source_id=?"
    ).bind(restoredSource.id).first<any>();
    expect(restoredSeries).toMatchObject({ field_id: restoredNameField.id, aggregation_type: "count" });
    expect(await db.prepare(
      "SELECT field_id FROM supertask_dashboard_aggregation_group_by WHERE data_source_id=?"
    ).bind(restoredSource.id).first<any>()).toEqual({ field_id: restoredStatusField.id });
    expect(await db.prepare(
      "SELECT reference, direction FROM supertask_dashboard_aggregation_sort WHERE data_source_id=?"
    ).bind(restoredSource.id).first<any>()).toEqual({ reference: `field_${restoredStatusField.id}`, direction: "ASC" });
    const restoredWidget = await db.prepare(
      "SELECT data_source_id, title, config FROM supertask_dashboard_widget WHERE dashboard_id=?"
    ).bind(restoredDashboard.id).first<any>();
    expect(restoredWidget).toMatchObject({ data_source_id: restoredSource.id, title: "Customers by status" });
    expect(JSON.parse(restoredWidget.config).series_config).toEqual([
      { series_id: restoredSeries.id, series_chart_type: "BAR" },
    ]);
  });

  it("roundtrips builder and automation application data with remapped references", async () => {
    const { db, env, token, ctx, objects } = await setupFixture();
    const updateBuilderResponse = await api(env, ctx, token, "/api/applications/11/", {
      method: "PATCH",
      body: JSON.stringify({ login_page_id: 50, favicon_file: { name: "favicon.png" } }),
    });
    expect(updateBuilderResponse.status).toBe(200);
    const updatedBuilder = await updateBuilderResponse.json() as any;
    expect(updatedBuilder.login_page_id).toBe(50);
    expect(updatedBuilder.favicon_file).toMatchObject({
      name: "favicon.png",
      original_name: "Favicon.png",
      mime_type: "image/png",
      is_image: true,
      image_width: 16,
      image_height: 16,
    });
    expect(updatedBuilder.favicon_file.url).toBe("https://test.local/media/user_files/favicon.png");

    const duplicateBuilderResponse = await api(env, ctx, token, "/api/applications/11/duplicate/async/", {
      method: "POST",
    });
    expect(duplicateBuilderResponse.status).toBe(202);
    const duplicateBuilderJob = await duplicateBuilderResponse.json() as any;
    expect(duplicateBuilderJob.duplicated_application.favicon_file).toMatchObject({
      name: "favicon.png",
      original_name: "Favicon.png",
    });
    const duplicatedLoginPageId = duplicateBuilderJob.duplicated_application.login_page_id;
    const duplicatedLoginPage = duplicateBuilderJob.duplicated_application.pages.find((page: any) => page.id === duplicatedLoginPageId);
    expect(duplicatedLoginPage).toMatchObject({ name: "Home", path: "/" });

    const exportResponse = await api(env, ctx, token, "/api/workspaces/1/export/async/", {
      method: "POST",
      body: JSON.stringify({ application_ids: [10, 11, 12] }),
    });
    expect(exportResponse.status).toBe(202);
    const exportJob = await exportResponse.json() as any;
    const stored = objects.get(exportJob.exported_file_key);
    const { entries, manifest } = parseWorkspaceArchive(stored!.body);
    expect(manifest.applications.builder.items[0]).toMatchObject({ id: 11, type: "builder", name: "Builder app" });
    expect(manifest.applications.automation.items[0]).toMatchObject({ id: 12, type: "automation", name: "Automation app" });
    const exportedBuilderSnapshot = archiveSchema(entries, manifest, "builder");
    const exportedBuilder = exportedBuilderSnapshot.builder;
    expect(exportedBuilder.custom_code).toMatchObject({
      css: ".portal { color: red; }",
      js: "window.__portal = true;",
    });
    expect(exportedBuilder.scripts).toEqual([
      expect.objectContaining({
        id: 77,
        type: "javascript",
        url: "https://cdn.example.com/portal.js",
        load_type: "defer",
        crossorigin: "anonymous",
      }),
    ]);
    expect(exportedBuilder.domains).toEqual([]);
    expect(exportedBuilder.favicon_file).toMatchObject({
      name: "favicon.png",
      original_name: "Favicon.png",
      mime_type: "image/png",
    });
    expect(exportedBuilderSnapshot.user_files).toEqual([
      expect.objectContaining({ name: "favicon.png", original_name: "Favicon.png" }),
    ]);
    expect(entries["favicon.png"]).toBeInstanceOf(Uint8Array);
    expect(exportedBuilder.login_page.page).toMatchObject({ id: 50, name: "Home", path: "/" });
    expect(exportedBuilder.pages[0].elements).toHaveLength(2);
    const exportedAutomation = archiveSchema(entries, manifest, "automation").automation;
    expect(exportedAutomation.workflows[0].nodes).toHaveLength(2);
    expect(exportedAutomation.workflows[0].histories).toEqual([]);

    await db.prepare("DELETE FROM core_userfile WHERE name='favicon.png'").run();
    objects.delete("user_files/favicon.png");

    const formData = new FormData();
    formData.append("file", new Blob([stored!.body], { type: "application/zip" }), "workspace.zip");
    const uploadResponse = await api(env, ctx, token, "/api/workspaces/1/import/upload-file/", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toBe(200);
    const upload = await uploadResponse.json() as any;

    const importResponse = await api(env, ctx, token, "/api/workspaces/1/import/async/", {
      method: "POST",
      body: JSON.stringify({ resource_id: upload.id, application_ids: [10, 11, 12] }),
    });
    expect(importResponse.status).toBe(202);
    const importJob = await importResponse.json() as any;
    expect(importJob.installed_applications.map((application: any) => application.type).sort()).toEqual(["automation", "builder", "database"]);

    const restoredDatabase = importJob.installed_applications.find((application: any) => application.type === "database");
    const restoredBuilder = importJob.installed_applications.find((application: any) => application.type === "builder");
    const restoredAutomation = importJob.installed_applications.find((application: any) => application.type === "automation");
    const restoredTable = await db.prepare("SELECT id FROM database_table WHERE database_id=? AND name='Customers'")
      .bind(restoredDatabase.id)
      .first<any>();
    const restoredNameField = await db.prepare("SELECT id FROM database_field WHERE table_id=? AND name='Name'")
      .bind(restoredTable.id)
      .first<any>();
    const restoredGridView = await db.prepare("SELECT id FROM database_view WHERE table_id=? AND name='Grid'")
      .bind(restoredTable.id)
      .first<any>();

    const theme = await db.prepare("SELECT theme FROM builder_theme WHERE builder_id=?")
      .bind(restoredBuilder.id)
      .first<any>();
    expect(JSON.parse(theme.theme)).toEqual({ primary_color: "#0f766e" });
    const customCode = await db.prepare("SELECT css, js FROM builder_custom_code WHERE builder_id=?")
      .bind(restoredBuilder.id)
      .first<any>();
    expect(customCode).toEqual({
      css: ".portal { color: red; }",
      js: "window.__portal = true;",
    });
    const customScripts = await db.prepare("SELECT type, url, load_type, crossorigin FROM builder_custom_script WHERE builder_id=? ORDER BY [order] ASC, id ASC")
      .bind(restoredBuilder.id)
      .all<any>();
    expect(customScripts.results).toEqual([
      {
        type: "javascript",
        url: "https://cdn.example.com/portal.js",
        load_type: "defer",
        crossorigin: "anonymous",
      },
    ]);
    const restoredPage = await db.prepare("SELECT * FROM builder_page WHERE builder_id=? AND name='Home'")
      .bind(restoredBuilder.id)
      .first<any>();
    expect(restoredPage.path).toBe("/");
    const restoredBuilderSettings = await db.prepare("SELECT * FROM builder_settings WHERE builder_id=?")
      .bind(restoredBuilder.id)
      .first<any>();
    expect(JSON.parse(restoredBuilderSettings.favicon_file)).toMatchObject({
      name: "favicon.png",
      original_name: "Favicon.png",
      mime_type: "image/png",
    });
    expect(restoredBuilderSettings.login_page_id).toBe(restoredPage.id);
    const restoredBuilderResponse = await api(env, ctx, token, `/api/applications/${restoredBuilder.id}/`);
    expect(restoredBuilderResponse.status).toBe(200);
    const restoredBuilderBody = await restoredBuilderResponse.json() as any;
    expect(restoredBuilderBody.login_page_id).toBe(restoredPage.id);
    expect(restoredBuilderBody.favicon_file).toMatchObject({
      name: "favicon.png",
      original_name: "Favicon.png",
    });
    const restoredDataSource = await db.prepare("SELECT * FROM builder_datasource WHERE page_id=? AND name='Customers source'")
      .bind(restoredPage.id)
      .first<any>();
    expect(JSON.parse(restoredDataSource.configuration)).toMatchObject({
      table_id: restoredTable.id,
      view_id: restoredGridView.id,
      field_id: restoredNameField.id,
    });
    const restoredElements = await db.prepare("SELECT * FROM builder_element WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC")
      .bind(restoredPage.id)
      .all<any>();
    expect(restoredElements.results).toHaveLength(2);
    expect(restoredElements.results[1].parent_element_id).toBe(restoredElements.results[0].id);
    expect(JSON.parse(restoredElements.results[1].configuration).data_source_id).toBe(restoredDataSource.id);
    const restoredAction = await db.prepare("SELECT * FROM builder_workflowaction WHERE page_id=?")
      .bind(restoredPage.id)
      .first<any>();
    expect(restoredAction.element_id).toBe(restoredElements.results[1].id);
    expect(JSON.parse(restoredAction.configuration)).toMatchObject({
      data_source_id: restoredDataSource.id,
      field_id: restoredNameField.id,
    });
    const restoredDomain = await db.prepare("SELECT COUNT(*) AS count FROM builder_domain WHERE builder_id=?")
      .bind(restoredBuilder.id)
      .first<any>();
    expect(restoredDomain.count).toBe(0);

    const restoredIntegration = await db.prepare("SELECT * FROM core_integration WHERE application_id=? AND name='Builder Local Baserow'")
      .bind(restoredBuilder.id)
      .first<any>();
    expect(JSON.parse(restoredIntegration.configuration)).toMatchObject({
      table_id: restoredTable.id,
      view_id: restoredGridView.id,
    });
    const restoredUserSource = await db.prepare("SELECT * FROM core_usersource WHERE application_id=? AND name='Portal users'")
      .bind(restoredBuilder.id)
      .first<any>();
    expect(restoredUserSource.integration_id).toBe(restoredIntegration.id);
    expect(JSON.parse(restoredUserSource.configuration)).toMatchObject({
      table_id: restoredTable.id,
      email_field_id: restoredNameField.id,
      name_field_id: restoredNameField.id,
    });

    const restoredAutomationIntegration = await db.prepare("SELECT * FROM core_integration WHERE application_id=? AND name='Automation Local Baserow'")
      .bind(restoredAutomation.id)
      .first<any>();
    const restoredWorkflow = await db.prepare("SELECT * FROM automation_workflow WHERE automation_id=? AND name='Notify customers'")
      .bind(restoredAutomation.id)
      .first<any>();
    const restoredNodes = await db.prepare("SELECT * FROM automation_node WHERE workflow_id=? ORDER BY id ASC")
      .bind(restoredWorkflow.id)
      .all<any>();
    expect(restoredNodes.results).toHaveLength(2);
    const graph = JSON.parse(restoredWorkflow.graph);
    expect(graph["0"]).toBe(restoredNodes.results[0].id);
    expect(graph[String(restoredNodes.results[0].id)].next[""]).toEqual([restoredNodes.results[1].id]);
    expect(restoredWorkflow.simulate_until_node_id).toBe(restoredNodes.results[1].id);
    expect(JSON.parse(restoredNodes.results[1].service)).toMatchObject({
      integration_id: restoredAutomationIntegration.id,
      table_id: restoredTable.id,
      field_id: restoredNameField.id,
      node_id: restoredNodes.results[0].id,
    });
    const restoredPublished = await db.prepare("SELECT * FROM automation_workflow WHERE automation_id=? AND is_published_version=1")
      .bind(restoredAutomation.id)
      .first<any>();
    expect(restoredPublished.published_from_workflow_id).toBe(restoredWorkflow.id);
    const restoredHistory = await db.prepare("SELECT COUNT(*) AS count FROM automation_workflow_history WHERE workflow_id=?")
      .bind(restoredWorkflow.id)
      .first<any>();
    expect(restoredHistory.count).toBe(0);
  });
});
