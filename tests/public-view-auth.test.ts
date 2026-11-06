import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { addFieldColumn, getOrCreateUserTable, serializeFieldValueForInsert } from "../src/services/dynamic-tables";

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
    "0019_premium_view_settings.sql",
    "0020_view_filter_groups.sql",
    "0022_form_view_field_options_logic.sql",
    "0028_userfile_baserow_name_hash.sql",
    "0043_form_view_submit_notifications.sql",
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

async function setupPublicViewFixture() {
  const db = createTestD1();
  const files = new Map<string, { body: string; options?: any }>();
  const now = "2026-07-09T12:00:00.000Z";
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
    .bind(now)
    .run();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, last_login, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES
     (7, '', NULL, 0, 'owner', 'Owner', '', 'owner@example.com', 0, 1, ?),
     (8, '', NULL, 0, 'other', 'Other', '', 'other@example.com', 0, 1, ?)`
  ).bind(now, now).run();
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
    .run();
  await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 8, 'ADMIN')")
    .run();
  await db.prepare("INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on) VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)")
    .bind(now, now)
    .run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
     VALUES (20, 10, 'Table', 1, 1, 0, ?, ?)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
	  await db.prepare(
    `INSERT INTO database_field (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on)
     VALUES
     (30, 20, 'Name', 'text', 1, 1, 0, 0, '{}', ?, ?),
     (31, 20, 'Hidden', 'text', 2, 0, 0, 0, '{}', ?, ?),
     (32, 20, 'No option', 'text', 3, 0, 0, 0, '{}', ?, ?),
     (33, 20, 'Status', 'single_select', 4, 0, 0, 0, '{}', ?, ?),
     (34, 20, 'Due date', 'date', 5, 0, 0, 0, '{"date_include_time":false,"date_format":"ISO"}', ?, ?),
     (35, 20, 'End date', 'date', 6, 0, 0, 0, '{"date_include_time":false,"date_format":"ISO"}', ?, ?),
     (36, 20, 'Cover file', 'file', 7, 0, 0, 0, '{}', ?, ?),
     (37, 20, 'Formula readonly', 'formula', 8, 0, 1, 0, '{"formula":"1","formula_type":"number"}', ?, ?),
     (38, 20, 'AI unsupported', 'ai', 9, 0, 0, 0, '{}', ?, ?),
     (39, 20, 'Enabled by default', 'boolean', 10, 0, 0, 0, '{"boolean_default":true}', ?, ?),
     (40, 20, 'Submission UUID', 'uuid', 11, 0, 1, 0, '{}', ?, ?)`
  ).bind(...Array(22).fill(now)).run();
  await addFieldColumn(db as any, 20, { id: 30, type: "text", primary: true });
  await addFieldColumn(db as any, 20, { id: 31, type: "text", primary: false });
  await addFieldColumn(db as any, 20, { id: 32, type: "text", primary: false });
  await addFieldColumn(db as any, 20, { id: 33, type: "single_select", primary: false });
  await addFieldColumn(db as any, 20, { id: 34, type: "date", primary: false });
  await addFieldColumn(db as any, 20, { id: 35, type: "date", primary: false });
  await addFieldColumn(db as any, 20, { id: 36, type: "file", primary: false });
  await addFieldColumn(db as any, 20, { id: 39, type: "boolean", primary: false });
  await addFieldColumn(db as any, 20, { id: 40, type: "uuid", primary: false });
  await db.prepare(
    `INSERT INTO database_selectoption (id, field_id, value, color, [order])
     VALUES (330, 33, 'Todo', 'blue', 1), (331, 33, 'Blocked', 'red', 2)`
  )
    .run();
  await db.prepare(
    `INSERT INTO database_view
     (id, table_id, name, type, [order], filter_type, filters_disabled, public, slug,
      public_view_password, trashed, ownership_type, row_height_size, row_identifier_type, created_on, updated_on)
     VALUES
     (40, 20, 'Protected grid', 'grid', 1, 'AND', 0, 1, 'protected-grid',
      'secret-pass', 0, 'collaborative', 'small', 'count', ?, ?),
     (41, 20, 'Protected form', 'form', 2, 'AND', 0, 1, 'protected-form',
      'form-secret', 0, 'collaborative', 'small', 'count', ?, ?),
     (42, 20, 'Public gallery', 'gallery', 3, 'AND', 0, 1, 'public-gallery',
      NULL, 0, 'collaborative', 'small', 'count', ?, ?),
     (43, 20, 'Public kanban', 'kanban', 4, 'AND', 0, 1, 'public-kanban',
      NULL, 0, 'collaborative', 'small', 'count', ?, ?),
     (44, 20, 'Public calendar', 'calendar', 5, 'AND', 0, 1, 'public-calendar',
      NULL, 0, 'collaborative', 'small', 'count', ?, ?),
     (45, 20, 'Public timeline', 'timeline', 6, 'AND', 0, 1, 'public-timeline',
      NULL, 0, 'collaborative', 'small', 'count', ?, ?)`
  ).bind(now, now, now, now, now, now, now, now, now, now, now, now).run();
  await db.prepare("UPDATE database_view SET allow_public_export=1 WHERE id=40").run();
  await db.prepare("UPDATE database_view SET single_select_field=33, card_cover_image_field=31 WHERE id=43").run();
  await db.prepare("UPDATE database_view SET date_field=34 WHERE id=44").run();
  await db.prepare("UPDATE database_view SET start_date_field=34, end_date_field=35 WHERE id=45").run();
  await db.prepare("UPDATE database_view SET card_cover_image_field=31 WHERE id=42").run();
	  await db.prepare(
    `INSERT INTO database_gridviewfieldoptions
     (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
     VALUES
     (40, 30, 200, 0, 32768, '', ''),
     (40, 31, 200, 1, 65536, '', ''),
     (43, 30, 200, 0, 32768, '', ''),
     (43, 33, 200, 1, 65536, '', ''),
     (43, 31, 200, 1, 98304, '', ''),
     (44, 30, 200, 0, 32768, '', ''),
     (44, 34, 200, 1, 65536, '', ''),
     (45, 30, 200, 0, 32768, '', ''),
     (45, 34, 200, 1, 65536, '', ''),
     (45, 35, 200, 1, 98304, '', '')`
  ).run();
  await db.prepare(
    `INSERT INTO database_galleryviewfieldoptions
     (gallery_view_id, field_id, hidden, [order])
     VALUES
     (42, 30, 0, 32768),
     (42, 31, 1, 65536),
     (42, 32, 1, 98304)`
  ).run();
  await db.prepare(
    `INSERT INTO database_formview
     (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
      submit_action_redirect_url, mode, show_logo)
     VALUES (41, 'Protected form', '', 'Submit', 'MESSAGE', '', '', 'form', 1)`
  ).run();
  await db.prepare(
    `INSERT INTO database_formviewfieldoptions
     (id, form_view_id, field_id, name, description, enabled, required, [order],
      show_when_matching_conditions, condition_type, include_all_select_options, field_component)
     VALUES
     (410, 41, 30, '', '', 1, 0, 32768, 0, 'AND', 1, 'default'),
     (411, 41, 31, '', '', 0, 0, 65536, 0, 'AND', 1, 'default'),
     (412, 41, 32, '', '', 0, 0, 98304, 0, 'AND', 1, 'default'),
     (413, 41, 33, 'Visible status', '', 1, 0, 131072, 0, 'AND', 0, 'default')`
  ).run();
  await db.prepare(
    `INSERT INTO database_formviewfieldoptions_allowedselectoptions
     (form_view_field_options_id, select_option_id)
     VALUES (413, 330)`
  ).run();
  await db.prepare(
    `INSERT INTO "database_table_20"
     ([order], _created_on, _updated_on, "field_30", "field_31", "field_32", "field_33", "field_34", "field_35")
     VALUES (10000, ?, ?, 'Visible row', 'Hidden row', 'No option row', ?, '2026-07-09', '2026-07-10')`
  ).bind(now, now, serializeFieldValueForInsert("single_select", { id: 330, value: "Todo", color: "blue" })).run();

  const env = {
    DB: db,
    SECRET_KEY: "secret-key",
    JWT_SIGNING_KEY: "jwt-secret",
    CACHE: { get: async () => null, put: async () => undefined },
    FILES: {
      head: async () => null,
      put: async (key: string, body: string, options?: any) => {
        files.set(key, { body, options });
      },
    },
    JOBS_QUEUE: { send: async () => undefined },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    MCP_SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    ENVIRONMENT: "test",
    PUBLIC_URL: "https://api.supertask.test",
  } as any;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  return { db, env, ctx, files };
}

async function request(env: any, ctx: any, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return worker.fetch(new Request(`https://api.supertask.test${path}`, {
    ...init,
    headers,
  }), env, ctx);
}

describe("public view password authorization", () => {
  it("requires Baserow public view JWTs and invalidates them when the view password changes", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();

    const anonymousInfo = await request(env, ctx, "/api/database/views/protected-grid/public/info/");
    expect(anonymousInfo.status).toBe(401);
    expect(await anonymousInfo.json()).toMatchObject({ error: "ERROR_NO_AUTHORIZATION_TO_PUBLICLY_SHARED_VIEW" });

    const anonymousRows = await request(env, ctx, "/api/database/views/grid/protected-grid/public/rows/");
    expect(anonymousRows.status).toBe(401);

    const badAuth = await request(env, ctx, "/api/database/views/protected-grid/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(badAuth.status).toBe(401);

    const goodAuth = await request(env, ctx, "/api/database/views/protected-grid/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
    });
    expect(goodAuth.status).toBe(200);
    const { access_token: accessToken } = await goodAuth.json() as { access_token: string };
    expect(accessToken).toBeTruthy();

    const headers = { "Baserow-View-Authorization": `JWT ${accessToken}` };
    const authorizedInfo = await request(env, ctx, "/api/database/views/protected-grid/public/info/", { headers });
    expect(authorizedInfo.status).toBe(200);
    const infoBody = await authorizedInfo.json() as any;
    expect(infoBody.view).toMatchObject({
      id: "protected-grid",
      slug: "protected-grid",
      table: { id: 0, database_id: 0 },
      show_logo: true,
    });
    expect(infoBody.fields.map((field: any) => field.id)).toEqual([30]);

    const authorizedRows = await request(
      env,
      ctx,
      "/api/database/views/grid/protected-grid/public/rows/?include=field_options&include_fields=field_30,field_31,field_32",
      { headers }
    );
    expect(authorizedRows.status).toBe(200);
    const rowsBody = await authorizedRows.json() as any;
    expect(rowsBody).toMatchObject({ count: 1 });
    expect(Object.keys(rowsBody.results[0]).sort()).toEqual(["field_30", "id", "order"]);
    expect(Object.keys(rowsBody.field_options)).toEqual(["30"]);

    const publicRow = await request(env, ctx, "/api/database/views/protected-grid/row/1/", { headers });
    expect(publicRow.status).toBe(200);
    expect(Object.keys(await publicRow.json()).sort()).toEqual(["field_30", "id", "order"]);

    await db.prepare("UPDATE database_view SET public_view_password='changed-secret' WHERE id=40").run();
    const staleTokenInfo = await request(env, ctx, "/api/database/views/protected-grid/public/info/", { headers });
    expect(staleTokenInfo.status).toBe(401);
  });

  it("uses Baserow pagination without count when exclude_count is requested", async () => {
    const { env, ctx } = await setupPublicViewFixture();

    const auth = await request(env, ctx, "/api/database/views/protected-grid/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
    });
    expect(auth.status).toBe(200);
    const { access_token: accessToken } = await auth.json() as { access_token: string };

    const rows = await request(
      env,
      ctx,
      "/api/database/views/grid/protected-grid/public/rows/?limit=1&exclude_count=true&include=field_options,row_metadata",
      { headers: { "Baserow-View-Authorization": `JWT ${accessToken}` } }
    );
    expect(rows.status).toBe(200);
    const body = await rows.json() as any;

    expect(body).not.toHaveProperty("count");
    expect(body).not.toHaveProperty("next");
    expect(body).not.toHaveProperty("previous");
    expect(body.results.map((row: any) => row.id)).toEqual([1]);
    expect(Object.keys(body.results[0]).sort()).toEqual(["field_30", "id", "order"]);
    expect(Object.keys(body.field_options)).toEqual(["30"]);
    expect(body).toHaveProperty("row_metadata");
    expect(body.row_metadata).toEqual({});
  });

  it("limits public gallery info and rows to fields visible in Baserow public views", async () => {
    const { env, ctx } = await setupPublicViewFixture();

    const info = await request(env, ctx, "/api/database/views/public-gallery/public/info/");
    expect(info.status).toBe(200);
    const infoBody = await info.json() as any;
    expect(infoBody.fields.map((field: any) => field.id)).toEqual([30, 31]);

    const rows = await request(env, ctx, "/api/database/views/gallery/public-gallery/public/rows/?include=field_options");
    expect(rows.status).toBe(200);
    const rowsBody = await rows.json() as any;
    expect(Object.keys(rowsBody.results[0]).sort()).toEqual(["field_30", "field_31", "id", "order"]);
    expect(rowsBody.results[0].field_31).toBe("Hidden row");
    expect(Object.keys(rowsBody.field_options).sort()).toEqual(["30", "31"]);
  });

  it("keeps required hidden premium view fields visible in public kanban, calendar and timeline views", async () => {
    const { env, ctx } = await setupPublicViewFixture();

    const kanbanInfo = await request(env, ctx, "/api/database/views/public-kanban/public/info/");
    expect(kanbanInfo.status).toBe(200);
    expect((await kanbanInfo.json() as any).fields.map((field: any) => field.id)).toEqual([30, 33, 31]);

    const kanbanRows = await request(env, ctx, "/api/database/views/kanban/public-kanban/public/rows/?include=field_options");
    expect(kanbanRows.status).toBe(200);
    const kanbanBody = await kanbanRows.json() as any;
    expect(Object.keys(kanbanBody.field_options).sort()).toEqual(["30", "31", "33"]);
    expect(Object.keys(kanbanBody.rows["330"].results[0]).sort()).toEqual(["field_30", "field_31", "field_33", "id", "order"]);

    const calendarInfo = await request(env, ctx, "/api/database/views/public-calendar/public/info/");
    expect(calendarInfo.status).toBe(200);
    expect((await calendarInfo.json() as any).fields.map((field: any) => field.id)).toEqual([30, 34]);

    const calendarRows = await request(
      env,
      ctx,
      "/api/database/views/calendar/public-calendar/public/rows/?from_timestamp=2026-07-09T00:00:00.000Z&to_timestamp=2026-07-09T00:00:00.000Z&include=field_options"
    );
    expect(calendarRows.status).toBe(200);
    const calendarBody = await calendarRows.json() as any;
    expect(Object.keys(calendarBody.field_options).sort()).toEqual(["30", "34"]);
    expect(Object.keys(calendarBody.rows["2026-07-09"].results[0]).sort()).toEqual(["field_30", "field_34", "id", "order"]);

    const timelineInfo = await request(env, ctx, "/api/database/views/public-timeline/public/info/");
    expect(timelineInfo.status).toBe(200);
    expect((await timelineInfo.json() as any).fields.map((field: any) => field.id)).toEqual([30, 34, 35]);

    const timelineRows = await request(env, ctx, "/api/database/views/timeline/public-timeline/public/rows/?include=field_options");
    expect(timelineRows.status).toBe(200);
    const timelineBody = await timelineRows.json() as any;
    expect(Object.keys(timelineBody.field_options).sort()).toEqual(["30", "34", "35"]);
    expect(Object.keys(timelineBody.results[0]).sort()).toEqual(["field_30", "field_34", "field_35", "id", "order"]);
  });

  it("uses Baserow calendar date-window validation, default per-day limit and exclusive datetime upper bound", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const now = "2026-07-09T12:30:00.000Z";

    const missingRange = await request(env, ctx, "/api/database/views/calendar/public-calendar/public/rows/");
    expect(missingRange.status).toBe(400);
    expect(await missingRange.json()).toMatchObject({ error: "INVALID_REQUEST" });

    await db.prepare(
      `UPDATE database_field
       SET field_settings='{"date_include_time":true,"date_format":"ISO","date_time_format":"24","date_show_tzinfo":true}'
       WHERE id=34`
    ).run();
    await db.prepare(`UPDATE "database_table_20" SET "field_34"='2026-07-09T00:00:00.000Z' WHERE id=1`).run();

    for (let index = 0; index < 42; index += 1) {
      await db.prepare(
        `INSERT INTO "database_table_20"
         ([order], _created_on, _updated_on, "field_30", "field_31", "field_32", "field_33", "field_34", "field_35")
         VALUES (?, ?, ?, ?, '', '', NULL, ?, '2026-07-10')`
      ).bind(
        20000 + index,
        now,
        now,
        `Inside ${index}`,
        `2026-07-09T${String(index % 24).padStart(2, "0")}:30:00.000Z`
      ).run();
    }
    await db.prepare(
      `INSERT INTO "database_table_20"
       ([order], _created_on, _updated_on, "field_30", "field_31", "field_32", "field_33", "field_34", "field_35")
       VALUES (90000, ?, ?, 'Boundary excluded', '', '', NULL, '2026-07-10T00:00:00.000Z', '2026-07-10')`
    ).bind(now, now).run();

    const rows = await request(
      env,
      ctx,
      "/api/database/views/calendar/public-calendar/public/rows/?from_timestamp=2026-07-09T00:00:00.000Z&to_timestamp=2026-07-10T00:00:00.000Z&include=row_metadata"
    );
    expect(rows.status).toBe(200);
    const body = await rows.json() as any;

    expect(body.rows["2026-07-09"].count).toBe(43);
    expect(body.rows["2026-07-09"].results).toHaveLength(40);
    expect(body.rows["2026-07-09"].results.map((row: any) => row.field_30)).not.toContain("Boundary excluded");
    expect(body.rows).not.toHaveProperty("2026-07-10");
    expect(body.row_metadata).toEqual({});
  });

  it("rejects invalid timeline date settings like Baserow", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    await db.prepare("UPDATE database_view SET start_date_field=NULL WHERE id=45").run();
    const missingDateFields = await request(env, ctx, "/api/database/views/timeline/public-timeline/public/rows/");
    expect(missingDateFields.status).toBe(400);
    expect(await missingDateFields.json()).toMatchObject({ error: "ERROR_TIMELINE_VIEW_HAS_INVALID_DATE_SETTINGS" });

    await db.prepare("UPDATE database_view SET start_date_field=34, end_date_field=35 WHERE id=45").run();
    await db.prepare(
      `UPDATE database_field
       SET field_settings='{"date_include_time":true,"date_force_timezone":"UTC","date_format":"ISO","date_time_format":"24"}'
       WHERE id=35`
    ).run();
    const incompatibleRows = await request(env, ctx, "/api/database/views/timeline/public-timeline/public/rows/");
    expect(incompatibleRows.status).toBe(400);
    expect(await incompatibleRows.json()).toMatchObject({ error: "ERROR_TIMELINE_VIEW_HAS_INVALID_DATE_SETTINGS" });

    const incompatiblePatch = await request(env, ctx, "/api/database/views/45/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ start_date_field: 34, end_date_field: 35 }),
    });
    expect(incompatiblePatch.status).toBe(400);
    expect(await incompatiblePatch.json()).toMatchObject({ error: "ERROR_TIMELINE_VIEW_HAS_INVALID_DATE_SETTINGS" });

    const nonDatePatch = await request(env, ctx, "/api/database/views/45/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ start_date_field: 31, end_date_field: 35 }),
    });
    expect(nonDatePatch.status).toBe(400);
    expect(await nonDatePatch.json()).toMatchObject({ error: "ERROR_INCOMPATIBLE_FIELD" });

    await db.prepare(
      `UPDATE database_field
       SET field_settings='{"date_include_time":false,"date_format":"ISO"}'
       WHERE id=35`
    ).run();
    const invalidTimescale = await request(env, ctx, "/api/database/views/45/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ timescale: "quarter" }),
    });
    expect(invalidTimescale.status).toBe(400);
    expect(await invalidTimescale.json()).toMatchObject({ error: "INVALID_REQUEST" });

    const validPatch = await request(env, ctx, "/api/database/views/45/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ start_date_field: 34, end_date_field: 35, timescale: "year" }),
    });
    expect(validPatch.status).toBe(200);
    expect(await validPatch.json()).toMatchObject({ start_date_field: 34, end_date_field: 35, timescale: "year" });
  });

  it("validates premium view field settings before persisting them like Baserow", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const validKanbanCover = await request(env, ctx, "/api/database/views/43/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ card_cover_image_field: 36 }),
    });
    expect(validKanbanCover.status).toBe(200);
    expect(await validKanbanCover.json()).toMatchObject({ card_cover_image_field: 36 });

    const invalidKanbanCover = await request(env, ctx, "/api/database/views/43/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ card_cover_image_field: 31 }),
    });
    expect(invalidKanbanCover.status).toBe(400);
    expect(await invalidKanbanCover.json()).toMatchObject({ error: "ERROR_INCOMPATIBLE_FIELD" });
    expect(await db.prepare("SELECT card_cover_image_field FROM database_view WHERE id=43").first<any>())
      .toMatchObject({ card_cover_image_field: 36 });

    const invalidKanbanSelect = await request(env, ctx, "/api/database/views/43/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ single_select_field: 31 }),
    });
    expect(invalidKanbanSelect.status).toBe(400);
    expect(await invalidKanbanSelect.json()).toMatchObject({ error: "ERROR_INCOMPATIBLE_FIELD" });
    expect(await db.prepare("SELECT single_select_field FROM database_view WHERE id=43").first<any>())
      .toMatchObject({ single_select_field: 33 });

    const validGalleryCover = await request(env, ctx, "/api/database/views/42/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ card_cover_image_field: 36 }),
    });
    expect(validGalleryCover.status).toBe(200);
    expect(await validGalleryCover.json()).toMatchObject({ card_cover_image_field: 36 });

    const invalidGalleryCover = await request(env, ctx, "/api/database/views/42/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ card_cover_image_field: 31 }),
    });
    expect(invalidGalleryCover.status).toBe(400);
    expect(await invalidGalleryCover.json()).toMatchObject({ error: "ERROR_INCOMPATIBLE_FIELD" });
    expect(await db.prepare("SELECT card_cover_image_field FROM database_view WHERE id=42").first<any>())
      .toMatchObject({ card_cover_image_field: 36 });

    const invalidCalendarDateField = await request(env, ctx, "/api/database/views/44/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ date_field: 31 }),
    });
    expect(invalidCalendarDateField.status).toBe(400);
    expect(await invalidCalendarDateField.json()).toMatchObject({ error: "ERROR_INCOMPATIBLE_FIELD" });
    expect(await db.prepare("SELECT date_field FROM database_view WHERE id=44").first<any>())
      .toMatchObject({ date_field: 34 });

    const validCalendarDateField = await request(env, ctx, "/api/database/views/44/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ date_field: 35 }),
    });
    expect(validCalendarDateField.status).toBe(200);
    expect(await validCalendarDateField.json()).toMatchObject({ date_field: 35 });
  });

  it("filters premium view field options to Baserow hidden/order semantics", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const initialKanbanOptions = await request(env, ctx, "/api/database/views/43/field-options/", { headers });
    expect(initialKanbanOptions.status).toBe(200);
    const initialKanbanBody = await initialKanbanOptions.json() as any;
    expect(initialKanbanBody.field_options["30"]).toMatchObject({ hidden: false, order: 32768 });
    expect(initialKanbanBody.field_options["30"].width).toBeUndefined();
    expect(initialKanbanBody.field_options["30"].aggregation_type).toBeUndefined();

    const patchedKanbanOptions = await request(env, ctx, "/api/database/views/43/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "30": {
            hidden: true,
            order: 12345,
            width: 999,
            aggregation_type: "count",
            aggregation_raw_type: "empty_count",
          },
        },
      }),
    });
    expect(patchedKanbanOptions.status).toBe(200);
    const patchedKanbanBody = await patchedKanbanOptions.json() as any;
    expect(patchedKanbanBody.field_options["30"]).toEqual({ hidden: true, order: 12345 });
    expect(await db.prepare("SELECT width, hidden, [order], aggregation_type, aggregation_raw_type FROM database_gridviewfieldoptions WHERE grid_view_id=43 AND field_id=30").first<any>())
      .toMatchObject({ width: 200, hidden: 1, order: 12345, aggregation_type: "", aggregation_raw_type: "" });

    const orderOnlyPatch = await request(env, ctx, "/api/database/views/43/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ field_options: { "30": { order: 23456 } } }),
    });
    expect(orderOnlyPatch.status).toBe(200);
    expect((await orderOnlyPatch.json() as any).field_options["30"]).toEqual({ hidden: true, order: 23456 });

    const unrelatedPatch = await request(env, ctx, "/api/database/views/43/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ field_options: { "999": { hidden: false, order: 1 } } }),
    });
    expect(unrelatedPatch.status).toBe(400);
    expect(await unrelatedPatch.json()).toMatchObject({ error: "ERROR_UNRELATED_FIELD" });

    const galleryPatch = await request(env, ctx, "/api/database/views/42/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ field_options: { "30": { width: 999, aggregation_type: "count" } } }),
    });
    expect(galleryPatch.status).toBe(200);
    expect((await galleryPatch.json() as any).field_options["30"]).toEqual({ hidden: false, order: 32768 });
  });

  it("validates grid aggregation field options like Baserow", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const unknownAggregation = await request(env, ctx, "/api/database/views/40/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "30": { aggregation_type: "unknown", aggregation_raw_type: "unknown" },
        },
      }),
    });
    expect(unknownAggregation.status).toBe(400);
    expect(await unknownAggregation.json()).toMatchObject({ error: "ERROR_AGGREGATION_TYPE_DOES_NOT_EXIST" });
    expect(await db.prepare("SELECT aggregation_type, aggregation_raw_type FROM database_gridviewfieldoptions WHERE grid_view_id=40 AND field_id=30").first<any>())
      .toMatchObject({ aggregation_type: "", aggregation_raw_type: "" });

    const unsupportedAggregation = await request(env, ctx, "/api/database/views/40/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "30": { aggregation_type: "sum", aggregation_raw_type: "sum" },
        },
      }),
    });
    expect(unsupportedAggregation.status).toBe(400);
    expect(await unsupportedAggregation.json()).toMatchObject({ error: "ERROR_AGGREGATION_DOES_NOT_SUPPORTED_FIELD" });
    expect(await db.prepare("SELECT aggregation_type, aggregation_raw_type FROM database_gridviewfieldoptions WHERE grid_view_id=40 AND field_id=30").first<any>())
      .toMatchObject({ aggregation_type: "", aggregation_raw_type: "" });

    const validTextAggregation = await request(env, ctx, "/api/database/views/40/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "30": { aggregation_type: "empty_count", aggregation_raw_type: "empty_count" },
        },
      }),
    });
    expect(validTextAggregation.status).toBe(200);
    expect((await validTextAggregation.json() as any).field_options["30"]).toMatchObject({
      aggregation_type: "empty_count",
      aggregation_raw_type: "empty_count",
    });
    expect(await db.prepare("SELECT aggregation_type, aggregation_raw_type FROM database_gridviewfieldoptions WHERE grid_view_id=40 AND field_id=30").first<any>())
      .toMatchObject({ aggregation_type: "empty_count", aggregation_raw_type: "empty_count" });

    const validDateAggregation = await request(env, ctx, "/api/database/views/40/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "34": { aggregation_type: "min_date", aggregation_raw_type: "min" },
        },
      }),
    });
    expect(validDateAggregation.status).toBe(200);
    expect((await validDateAggregation.json() as any).field_options["34"]).toMatchObject({
      aggregation_type: "min_date",
      aggregation_raw_type: "min",
    });
  });

  it("returns Baserow-shaped grid aggregation values for configured visible fields", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    await db.prepare(
      `INSERT INTO "database_table_20"
       ([order], _created_on, _updated_on, "field_30", "field_31", "field_32", "field_33", "field_34", "field_35")
       VALUES (20000, ?, ?, '', 'Hidden second row', 'No option second row', ?, '2026-07-11', '2026-07-12')`
    ).bind(
      "2026-07-09T12:00:00.000Z",
      "2026-07-09T12:00:00.000Z",
      serializeFieldValueForInsert("single_select", { id: 331, value: "Blocked", color: "red" })
    ).run();

    const patchedAggregations = await request(env, ctx, "/api/database/views/40/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "30": { aggregation_type: "empty_count", aggregation_raw_type: "empty_count" },
          "31": { hidden: true, aggregation_type: "empty_count", aggregation_raw_type: "empty_count" },
          "34": { aggregation_type: "min_date", aggregation_raw_type: "min" },
        },
      }),
    });
    expect(patchedAggregations.status).toBe(200);

    const aggregations = await request(env, ctx, "/api/database/views/grid/40/aggregations/?include=total", { headers });
    expect(aggregations.status).toBe(200);
    const body = await aggregations.json() as any;
    expect(body).toMatchObject({ field_30: 1, field_34: "2026-07-09", total: 2 });
    expect(body["30"]).toBeUndefined();
    expect(body.field_31).toBeUndefined();
    expect(body.field_32).toBeUndefined();

    const searchedAggregations = await request(env, ctx, "/api/database/views/grid/40/aggregations/?search=Visible&include=total", { headers });
    expect(searchedAggregations.status).toBe(200);
    expect(await searchedAggregations.json()).toMatchObject({ field_30: 0, field_34: "2026-07-09", total: 1 });

    const publicAuth = await request(env, ctx, "/api/database/views/protected-grid/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
    });
    expect(publicAuth.status).toBe(200);
    const { access_token: publicToken } = await publicAuth.json() as any;
    const publicAggregations = await request(env, ctx, "/api/database/views/grid/protected-grid/public/aggregations/?include=total", {
      headers: { "Baserow-View-Authorization": `JWT ${publicToken}` },
    });
    expect(publicAggregations.status).toBe(200);
    const publicBody = await publicAggregations.json() as any;
    expect(publicBody).toMatchObject({ field_30: 1, field_34: "2026-07-09", total: 2 });
    expect(publicBody.field_31).toBeUndefined();
  });

  it("excludes trashed rows from public link-row lookup results", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
       VALUES (21, 10, 'Customers', 2, 1, 0, ?, ?)`
    ).bind("2026-07-09T12:00:00.000Z", "2026-07-09T12:00:00.000Z").run();
    await getOrCreateUserTable(db as any, 21);
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on)
       VALUES
       (41, 20, 'Customer', 'link_row', 12, 0, 0, 0, ?, ?, ?),
       (50, 21, 'Customer name', 'text', 1, 1, 0, 0, '{}', ?, ?)`
    ).bind(
      JSON.stringify({ link_row_table_id: 21, link_row_multiple_relationships: true }),
      "2026-07-09T12:00:00.000Z",
      "2026-07-09T12:00:00.000Z",
      "2026-07-09T12:00:00.000Z",
      "2026-07-09T12:00:00.000Z"
    ).run();
    await addFieldColumn(db as any, 20, { id: 41, type: "link_row", primary: false });
    await addFieldColumn(db as any, 21, { id: 50, type: "text", primary: true });
    await db.prepare(
      `INSERT INTO "database_table_21"
       (id, [order], trashed, _created_on, _updated_on, "field_50")
       VALUES
       (1, 10000, 0, ?, ?, 'Visible customer'),
       (2, 20000, 1, ?, ?, 'Deleted customer')`
    ).bind(...Array(4).fill("2026-07-09T12:00:00.000Z")).run();
    await db.prepare(
      `UPDATE "database_table_20"
       SET "field_41"=?
       WHERE id=1`
    ).bind(serializeFieldValueForInsert("link_row", [
      { id: 1, value: "Visible customer" },
      { id: 2, value: "Deleted customer" },
    ])).run();
    await db.prepare(
      `INSERT INTO database_gridviewfieldoptions
       (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
       VALUES (40, 41, 200, 0, 131072, '', '')`
    ).run();

    const publicAuth = await request(env, ctx, "/api/database/views/protected-grid/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
    });
    expect(publicAuth.status).toBe(200);
    const { access_token: publicToken } = await publicAuth.json() as any;

    const lookup = await request(env, ctx, "/api/database/views/protected-grid/link-row-field-lookup/41/", {
      headers: { "Baserow-View-Authorization": `JWT ${publicToken}` },
    });
    expect(lookup.status).toBe(200);
    const body = await lookup.json() as any;
    expect(body.count).toBe(1);
    expect(body.results).toEqual([
      { id: 1, value: "Visible customer", order: 10000 },
    ]);

    const unrelatedField = await request(env, ctx, "/api/database/views/protected-grid/link-row-field-lookup/30/", {
      headers: { "Baserow-View-Authorization": `JWT ${publicToken}` },
    });
    expect(unrelatedField.status).toBe(404);
  });

  it("returns Baserow single-field grid aggregation values", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    await db.prepare(
      `INSERT INTO "database_table_20"
       ([order], _created_on, _updated_on, "field_30", "field_31", "field_32", "field_33", "field_34", "field_35")
       VALUES (20000, ?, ?, '', 'Hidden second row', 'No option second row', ?, '2026-07-11', '2026-07-12')`
    ).bind(
      "2026-07-09T12:00:00.000Z",
      "2026-07-09T12:00:00.000Z",
      serializeFieldValueForInsert("single_select", { id: 331, value: "Blocked", color: "red" })
    ).run();

    const textAggregation = await request(env, ctx, "/api/database/views/grid/40/aggregation/30/?type=empty_count&include=total", { headers });
    expect(textAggregation.status).toBe(200);
    expect(await textAggregation.json()).toMatchObject({ value: 1, total: 2 });

    const searchedDateAggregation = await request(env, ctx, "/api/database/views/grid/40/aggregation/34/?type=max&search=Visible&include=total", { headers });
    expect(searchedDateAggregation.status).toBe(200);
    expect(await searchedDateAggregation.json()).toMatchObject({ value: "2026-07-09", total: 1 });

    const missingType = await request(env, ctx, "/api/database/views/grid/40/aggregation/30/", { headers });
    expect(missingType.status).toBe(400);
    expect(await missingType.json()).toMatchObject({ error: "ERROR_AGGREGATION_TYPE_DOES_NOT_EXIST" });

    const unsupportedField = await request(env, ctx, "/api/database/views/grid/40/aggregation/30/?type=sum", { headers });
    expect(unsupportedField.status).toBe(400);
    expect(await unsupportedField.json()).toMatchObject({ error: "ERROR_AGGREGATION_DOES_NOT_SUPPORTED_FIELD" });

    const missingField = await request(env, ctx, "/api/database/views/grid/40/aggregation/999/?type=empty_count", { headers });
    expect(missingField.status).toBe(404);
    expect(await missingField.json()).toMatchObject({ error: "ERROR_FIELD_DOES_NOT_EXIST" });

    await db.prepare(
      `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
       VALUES (21, 10, 'Other table', 2, 1, 0, ?, ?)`
    ).bind("2026-07-09T12:00:00.000Z", "2026-07-09T12:00:00.000Z").run();
    await db.prepare(
      `INSERT INTO database_field (id, table_id, name, type, [order], "primary", read_only, trashed, field_settings, created_on, updated_on)
       VALUES (90, 21, 'Foreign', 'text', 1, 1, 0, 0, '{}', ?, ?)`
    ).bind("2026-07-09T12:00:00.000Z", "2026-07-09T12:00:00.000Z").run();

    const foreignField = await request(env, ctx, "/api/database/views/grid/40/aggregation/90/?type=empty_count", { headers });
    expect(foreignField.status).toBe(400);
    expect(await foreignField.json()).toMatchObject({ error: "ERROR_FIELD_NOT_IN_TABLE" });
  });

  it("patches form field options without resetting omitted Baserow settings", async () => {
    const { env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const renamedStatus = await request(env, ctx, "/api/database/views/41/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "33": {
            name: "Status alias",
          },
        },
      }),
    });
    expect(renamedStatus.status).toBe(200);
    const renamedBody = await renamedStatus.json() as any;
    expect(renamedBody.field_options["33"]).toMatchObject({
      name: "Status alias",
      enabled: true,
      required: false,
      order: 131072,
      include_all_select_options: false,
      allowed_select_options: [330],
    });

    const requiredStatus = await request(env, ctx, "/api/database/views/41/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "33": {
            required: true,
          },
        },
      }),
    });
    expect(requiredStatus.status).toBe(200);
    const requiredBody = await requiredStatus.json() as any;
    expect(requiredBody.field_options["33"]).toMatchObject({
      name: "Status alias",
      enabled: true,
      required: true,
      order: 131072,
      include_all_select_options: false,
      allowed_select_options: [330],
    });

    const createdDateOption = await request(env, ctx, "/api/database/views/41/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "34": {
            name: "Due alias",
          },
        },
      }),
    });
    expect(createdDateOption.status).toBe(200);
    const createdBody = await createdDateOption.json() as any;
    expect(createdBody.field_options["34"]).toMatchObject({
      name: "Due alias",
      enabled: false,
      required: true,
      order: 32767,
      include_all_select_options: true,
      field_component: "default",
    });
  });

  it("rejects enabling read-only or unsupported form fields like Baserow", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const readOnlyField = await request(env, ctx, "/api/database/views/41/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ field_options: { "37": { enabled: true } } }),
    });
    expect(readOnlyField.status).toBe(400);
    expect(await readOnlyField.json()).toMatchObject({
      error: "ERROR_FORM_VIEW_READ_ONLY_FIELD_IS_NOT_SUPPORTED",
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_formviewfieldoptions WHERE form_view_id=41 AND field_id=37").first<any>())
      .toMatchObject({ count: 0 });

    const unsupportedField = await request(env, ctx, "/api/database/views/41/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ field_options: { "38": { enabled: true } } }),
    });
    expect(unsupportedField.status).toBe(400);
    expect(await unsupportedField.json()).toMatchObject({
      error: "ERROR_FORM_VIEW_FIELD_TYPE_IS_NOT_SUPPORTED",
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM database_formviewfieldoptions WHERE form_view_id=41 AND field_id=38").first<any>())
      .toMatchObject({ count: 0 });

    const disabledUnsupportedField = await request(env, ctx, "/api/database/views/41/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ field_options: { "38": { name: "AI hidden config", enabled: false } } }),
    });
    expect(disabledUnsupportedField.status).toBe(200);
    expect((await disabledUnsupportedField.json() as any).field_options["38"]).toMatchObject({
      name: "AI hidden config",
      enabled: false,
      required: true,
    });
  });

  it("paginates public kanban rows independently per select option stack", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const now = "2026-07-09T12:30:00.000Z";
    await db.prepare(
      `INSERT INTO "database_table_20"
       ([order], _created_on, _updated_on, "field_30", "field_31", "field_32", "field_33", "field_34", "field_35")
       VALUES
       (20000, ?, ?, 'Second todo', 'Hidden second todo', '', ?, '2026-07-11', '2026-07-12'),
       (30000, ?, ?, 'Unassigned', 'Hidden unassigned', '', NULL, '2026-07-13', '2026-07-14')`
    ).bind(
      now,
      now,
      serializeFieldValueForInsert("single_select", { id: 330, value: "Todo", color: "blue" }),
      now,
      now
    ).run();

    const rows = await request(
      env,
      ctx,
      "/api/database/views/kanban/public-kanban/public/rows/?select_option=330,1,1&select_option=null,1,0&include=row_metadata"
    );
    expect(rows.status).toBe(200);
    const body = await rows.json() as any;

    expect(Object.keys(body.rows).sort()).toEqual(["330", "null"]);
    expect(body.rows["330"].count).toBe(2);
    expect(body.rows["330"].results.map((row: any) => row.field_30)).toEqual(["Second todo"]);
    expect(body.rows.null.count).toBe(1);
    expect(body.rows.null.results.map((row: any) => row.field_30)).toEqual(["Unassigned"]);
    expect(Object.keys(body.rows["330"].results[0]).sort()).toEqual(["field_30", "field_31", "field_33", "id", "order"]);
    expect(Object.keys(body.rows.null.results[0]).sort()).toEqual(["field_30", "field_31", "field_33", "id", "order"]);
    expect(body.row_metadata).toEqual({});
  });

  it("exports public views through signed anonymous jobs and only includes public-visible fields", async () => {
    const { db, env, ctx, files } = await setupPublicViewFixture();

    const anonymousExport = await request(env, ctx, "/api/database/view/protected-grid/export-public-view/", {
      method: "POST",
      body: JSON.stringify({ exporter_type: "csv", fields: [30, 31, 32] }),
    });
    expect(anonymousExport.status).toBe(401);

    const auth = await request(env, ctx, "/api/database/views/protected-grid/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
    });
    const { access_token: accessToken } = await auth.json() as { access_token: string };

    const exported = await request(env, ctx, "/api/database/view/protected-grid/export-public-view/", {
      method: "POST",
      headers: { "Baserow-View-Authorization": `JWT ${accessToken}` },
      body: JSON.stringify({ exporter_type: "csv", fields: [30, 31, 32] }),
    });
    expect(exported.status).toBe(200);
    const exportedBody = await exported.json() as any;
    expect(exportedBody).toMatchObject({ state: "finished", progress_percentage: 100, exporter_type: "csv" });
    expect(typeof exportedBody.id).toBe("string");
    expect(Number(exportedBody.id)).toBeNaN();

    const storedJob = await db.prepare(
      `SELECT j.user_id, e.view_id, e.table_id, e.export_options, e.exported_file_name
       FROM core_job j
       JOIN database_exportjob e ON e.job_ptr_id=j.id`
    ).first<any>();
    expect(storedJob).toMatchObject({ user_id: null, view_id: 40, table_id: 20 });
    expect(JSON.parse(storedJob.export_options).fields).toEqual([30]);

    const file = files.get(storedJob.exported_file_name);
    expect(file?.options?.httpMetadata?.contentType).toBe("text/csv;charset=utf-8");
    expect(file?.body).toContain("id,Name");
    expect(file?.body).toContain("1,Visible row");
    expect(file?.body).not.toContain("Hidden");
    expect(file?.body).not.toContain("No option");

    const polled = await request(env, ctx, `/api/database/view/get-public-view-export/${exportedBody.id}/`);
    expect(polled.status).toBe(200);
    const polledBody = await polled.json() as any;
    expect(polledBody).toMatchObject({ state: "finished", exporter_type: "csv" });
    expect(typeof polledBody.id).toBe("string");
    expect(polledBody.url).toBe(exportedBody.url);
  });

	it("lets authenticated workspace users export protected public views without a public view token", async () => {
		const { db, env, ctx } = await setupPublicViewFixture();
		const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );

    const exported = await request(env, ctx, "/api/database/view/protected-grid/export-public-view/", {
      method: "POST",
      headers: { Authorization: `JWT ${accessToken}` },
      body: JSON.stringify({ exporter_type: "csv", fields: [30, 31] }),
    });

    expect(exported.status).toBe(200);
    const exportedBody = await exported.json() as any;
    expect(exportedBody).toMatchObject({ state: "finished", exporter_type: "csv" });
    expect(typeof exportedBody.id).toBe("string");

    const storedJob = await db.prepare(
      `SELECT j.user_id, e.view_id, e.export_options
       FROM core_job j
       JOIN database_exportjob e ON e.job_ptr_id=j.id`
    ).first<any>();
    expect(storedJob).toMatchObject({ user_id: null, view_id: 40 });
		expect(JSON.parse(storedJob.export_options).fields).toEqual([30]);
	});

  it("persists allow_public_export through authenticated view updates", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const disabled = await request(env, ctx, "/api/database/views/40/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ allow_public_export: false }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ id: 40, allow_public_export: false });
    expect(await db.prepare("SELECT allow_public_export FROM database_view WHERE id=40").first<any>())
      .toMatchObject({ allow_public_export: 0 });

    const enabled = await request(env, ctx, "/api/database/views/40/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ allow_public_export: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ id: 40, allow_public_export: true });
    expect(await db.prepare("SELECT allow_public_export FROM database_view WHERE id=40").first<any>())
      .toMatchObject({ allow_public_export: 1 });

    const fetched = await request(env, ctx, "/api/database/views/40/", { headers });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      id: 40,
      table_id: 20,
      table: { id: 20, name: "Table", order: 1, database_id: 10 },
      public_view_has_password: true,
      show_logo: true,
      allow_public_export: true,
    });
  });

  it("supports the premium view attributes endpoint used by the Baserow frontend", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const updated = await request(env, ctx, "/api/database/view/40/premium", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ show_logo: false, allow_public_export: false }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: 40,
      table: { id: 20, database_id: 10 },
      show_logo: false,
      allow_public_export: false,
    });
    expect(await db.prepare("SELECT show_logo, allow_public_export FROM database_view WHERE id=40").first<any>())
      .toMatchObject({ show_logo: 0, allow_public_export: 0 });

    const invalid = await request(env, ctx, "/api/database/view/40/premium", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ show_logo: "no" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("persists the current user's form submission notification preference", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const enabled = await request(env, ctx, "/api/database/views/41/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ receive_notification_on_submit: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ id: 41, receive_notification_on_submit: true });
    expect(await db.prepare(
      "SELECT formview_id, user_id FROM database_formview_users_to_notify_on_submit WHERE formview_id=41 AND user_id=7"
    ).first<any>()).toEqual({ formview_id: 41, user_id: 7 });

    const disabled = await request(env, ctx, "/api/database/views/41/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ receive_notification_on_submit: false }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ id: 41, receive_notification_on_submit: false });
    expect(await db.prepare(
      "SELECT 1 FROM database_formview_users_to_notify_on_submit WHERE formview_id=41 AND user_id=7"
    ).first()).toBeNull();

    const invalidOptions = await request(env, ctx, "/api/database/views/41/field-options/", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        field_options: {
          "33": { include_all_select_options: false, allowed_select_options: [999999] },
        },
      }),
    });
    expect(invalidOptions.status).toBe(400);
    expect(await db.prepare(
      `SELECT select_option_id
       FROM database_formviewfieldoptions_allowedselectoptions
       WHERE form_view_field_options_id=413
       ORDER BY select_option_id ASC`
    ).all<any>()).toEqual({ results: [{ select_option_id: 330 }] });
  });

  it("honors Baserow view list filters and grid row refresh response shape", async () => {
    const { env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const galleryViews = await request(env, ctx, "/api/database/views/table/20/?type=gallery&limit=1", { headers });
    expect(galleryViews.status).toBe(200);
    expect((await galleryViews.json() as any[]).map((view) => view.id)).toEqual([42]);

    const noViews = await request(env, ctx, "/api/database/views/table/20/?limit=0", { headers });
    expect(noViews.status).toBe(200);
    expect(await noViews.json()).toEqual([]);

    const invalidType = await request(env, ctx, "/api/database/views/table/20/?type=unknown", { headers });
    expect(invalidType.status).toBe(400);

    const refreshed = await request(env, ctx, "/api/database/views/grid/40/", {
      method: "POST",
      headers,
      body: JSON.stringify({ row_ids: [1], field_ids: [30] }),
    });
    expect(refreshed.status).toBe(200);
    const rows = await refreshed.json() as any[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, field_30: "Visible row" });
    expect(rows[0].field_31).toBeUndefined();

    const invalidRows = await request(env, ctx, "/api/database/views/grid/40/", {
      method: "POST",
      headers,
      body: JSON.stringify({ row_ids: [] }),
    });
    expect(invalidRows.status).toBe(400);
  });

  it("enforces personal view ownership across create, list, read, update and ownership changes", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const ownerToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const otherToken = await signAccessToken(
      { user_id: 8, email: "other@example.com", username: "other" },
      env.JWT_SIGNING_KEY,
      10
    );
    const ownerHeaders = { Authorization: `JWT ${ownerToken}` };
    const otherHeaders = { Authorization: `JWT ${otherToken}` };

    const created = await request(env, ctx, "/api/database/views/table/20/", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: "Owner only", type: "grid", ownership_type: "personal" }),
    });
    expect(created.status).toBe(200);
    const personal = await created.json() as any;
    expect(personal).toMatchObject({ ownership_type: "personal", owned_by_id: 7 });

    const ownerList = await request(env, ctx, "/api/database/views/table/20/", { headers: ownerHeaders });
    expect((await ownerList.json() as any[]).some((view) => view.id === personal.id)).toBe(true);
    const otherList = await request(env, ctx, "/api/database/views/table/20/", { headers: otherHeaders });
    expect((await otherList.json() as any[]).some((view) => view.id === personal.id)).toBe(false);

    const otherRead = await request(env, ctx, `/api/database/views/${personal.id}/`, { headers: otherHeaders });
    expect(otherRead.status).toBe(403);
    const otherUpdate = await request(env, ctx, `/api/database/views/${personal.id}/`, {
      method: "PATCH",
      headers: otherHeaders,
      body: JSON.stringify({ name: "Not allowed" }),
    });
    expect(otherUpdate.status).toBe(403);

    const collaborative = await request(env, ctx, `/api/database/views/${personal.id}/`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ ownership_type: "collaborative" }),
    });
    expect(collaborative.status).toBe(200);
    expect(await collaborative.json()).toMatchObject({ ownership_type: "collaborative", owned_by_id: 7 });

    const claimed = await request(env, ctx, `/api/database/views/${personal.id}/`, {
      method: "PATCH",
      headers: otherHeaders,
      body: JSON.stringify({ ownership_type: "personal" }),
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ ownership_type: "personal", owned_by_id: 8 });
    expect(await db.prepare("SELECT ownership_type, owned_by_id FROM database_view WHERE id=?").bind(personal.id).first<any>())
      .toEqual({ ownership_type: "personal", owned_by_id: 8 });

    const formerOwnerRead = await request(env, ctx, `/api/database/views/${personal.id}/`, { headers: ownerHeaders });
    expect(formerOwnerRead.status).toBe(403);

    const invalid = await request(env, ctx, "/api/database/views/table/20/", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: "Invalid", ownership_type: "unknown" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("validates and persists Baserow sort and group-by types", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    const accessToken = await signAccessToken(
      { user_id: 7, email: "owner@example.com", username: "owner" },
      env.JWT_SIGNING_KEY,
      10
    );
    const headers = { Authorization: `JWT ${accessToken}` };

    const sorting = await request(env, ctx, "/api/database/views/40/sortings/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field: 33, order: "DESC", type: "order" }),
    });
    expect(sorting.status).toBe(200);
    expect(await sorting.json()).toMatchObject({ field: 33, order: "DESC", type: "order" });
    expect(await db.prepare("SELECT field_id, [order], type FROM database_viewsort WHERE view_id=40").first<any>())
      .toEqual({ field_id: 33, order: "DESC", type: "order" });

    const duplicateSort = await request(env, ctx, "/api/database/views/40/sortings/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field: 33, order: "ASC", type: "default" }),
    });
    expect(duplicateSort.status).toBe(400);
    expect(await duplicateSort.json()).toMatchObject({ error: "ERROR_VIEW_SORT_FIELD_ALREADY_EXISTS" });

    const fileSort = await request(env, ctx, "/api/database/views/40/sortings/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field: 36, order: "ASC", type: "default" }),
    });
    expect(fileSort.status).toBe(400);
    expect(await fileSort.json()).toMatchObject({ error: "ERROR_VIEW_SORT_FIELD_NOT_SUPPORTED" });

    const grouping = await request(env, ctx, "/api/database/views/40/group_bys/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field: 33, order: "ASC", type: "order", width: 240 }),
    });
    expect(grouping.status).toBe(200);
    expect(await grouping.json()).toMatchObject({ field: 33, order: "ASC", type: "order", width: 240 });

    const formSorting = await request(env, ctx, "/api/database/views/41/sortings/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field: 30 }),
    });
    expect(formSorting.status).toBe(400);
    expect(await formSorting.json()).toMatchObject({ error: "ERROR_VIEW_SORT_NOT_SUPPORTED" });

    const formFilter = await request(env, ctx, "/api/database/views/41/filters/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field: 30, type: "contains", value: "x" }),
    });
    expect(formFilter.status).toBe(400);
    expect(await formFilter.json()).toMatchObject({ error: "ERROR_VIEW_FILTER_NOT_SUPPORTED" });
  });

  it("enforces required form values and allowed select options on the server", async () => {
    const { db, env, ctx } = await setupPublicViewFixture();
    await db.prepare(
      `UPDATE database_formviewfieldoptions
       SET required=1, include_all_select_options=0
       WHERE id=413`
    ).run();

    const auth = await request(env, ctx, "/api/database/views/protected-form/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "form-secret" }),
    });
    const { access_token: accessToken } = await auth.json() as { access_token: string };
    const headers = { "Baserow-View-Authorization": `JWT ${accessToken}` };

    const missing = await request(env, ctx, "/api/database/views/form/protected-form/submit/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field_30: "Missing status" }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: { field_33: [{ error: "This field is required.", code: "required" }] },
    });

    const forbidden = await request(env, ctx, "/api/database/views/form/protected-form/submit/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field_30: "Forbidden status", field_33: 331 }),
    });
    expect(forbidden.status).toBe(400);
    expect(await forbidden.json()).toEqual({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: { field_33: [{ error: "The provided select option 331 is not allowed.", code: "invalid" }] },
    });

    const accepted = await request(env, ctx, "/api/database/views/form/protected-form/submit/", {
      method: "POST",
      headers,
      body: JSON.stringify({ field_30: "Allowed status", field_33: 330 }),
    });
    expect(accepted.status).toBe(200);
  });

  it("uploads public form files with the form workspace context", async () => {
    const { db, env, ctx, files } = await setupPublicViewFixture();
    const auth = await request(env, ctx, "/api/database/views/protected-form/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "form-secret" }),
    });
    const { access_token: accessToken } = await auth.json() as { access_token: string };
    const formData = new FormData();
    formData.set("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "contract.pdf", {
      type: "application/pdf",
    }));

    const uploaded = await request(env, ctx, "/api/database/views/form/protected-form/upload-file/", {
      method: "POST",
      headers: { "Baserow-View-Authorization": `JWT ${accessToken}` },
      body: formData,
    });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toMatchObject({
      original_name: "contract.pdf",
      mime_type: "application/pdf",
      size: 4,
      is_image: false,
    });
    expect(files.size).toBe(1);
    expect(await db.prepare(
      "SELECT original_name, mime_type, size FROM core_userfile WHERE original_name='contract.pdf'"
    ).first<any>()).toEqual({ original_name: "contract.pdf", mime_type: "application/pdf", size: 4 });
  });

		it("uses the Baserow form-specific authorization error for protected public forms", async () => {
		const { db, env, ctx } = await setupPublicViewFixture();

    const anonymousForm = await request(env, ctx, "/api/database/views/form/protected-form/submit/");
    expect(anonymousForm.status).toBe(401);
    expect(await anonymousForm.json()).toMatchObject({ error: "ERROR_NO_PERMISSION_TO_PUBLICLY_SHARED_FORM" });

    const auth = await request(env, ctx, "/api/database/views/protected-form/public/auth/", {
      method: "POST",
      body: JSON.stringify({ password: "form-secret" }),
    });
    const { access_token: accessToken } = await auth.json() as { access_token: string };
    const authorizedForm = await request(env, ctx, "/api/database/views/form/protected-form/submit/", {
      headers: { "Baserow-View-Authorization": `JWT ${accessToken}` },
    });
    expect(authorizedForm.status).toBe(200);
    const formBody = await authorizedForm.json() as any;
    expect(formBody).toMatchObject({ title: "Protected form", mode: "form" });
    expect(formBody.fields.map((option: any) => option.field.id)).toEqual([30, 33]);
    const statusOption = formBody.fields.find((option: any) => option.field.id === 33);
    expect(statusOption).toMatchObject({
      name: "Visible status",
      include_all_select_options: false,
      allowed_select_options: [330],
    });
    expect(statusOption.field.select_options).toEqual([
      { id: 330, value: "Todo", color: "blue", order: 1 },
    ]);

    await db.prepare(
      "INSERT INTO database_formview_users_to_notify_on_submit (formview_id, user_id) VALUES (41, 7)"
    ).run();

    const submitted = await request(env, ctx, "/api/database/views/form/protected-form/submit/", {
      method: "POST",
      headers: { "Baserow-View-Authorization": `JWT ${accessToken}` },
      body: JSON.stringify({ field_30: "Submitted visible", field_31: "Submitted hidden" }),
    });
    expect(submitted.status).toBe(200);
    const submittedBody = await submitted.json() as any;
    const inserted = await env.DB.prepare('SELECT "field_30", "field_31", "field_39", "field_40" FROM "database_table_20" WHERE id=?')
      .bind(submittedBody.row_id)
      .first<any>();
    expect(inserted).toMatchObject({ field_30: "Submitted visible", field_31: null, field_39: 1 });
    expect(inserted.field_40).toMatch(/^[0-9a-f-]{36}$/i);
    const notification = await db.prepare(
      `SELECT n.type, n.workspace_id, n.sender_id, n.data, nr.recipient_id
       FROM core_notification n
       JOIN core_notificationrecipient nr ON nr.notification_id=n.id
       WHERE n.type='form_submitted'`
    ).first<any>();
    expect(notification).toMatchObject({
      type: "form_submitted",
      workspace_id: 1,
      sender_id: null,
      recipient_id: 7,
    });
    expect(JSON.parse(notification.data)).toMatchObject({
      form_id: 41,
      form_name: "Protected form",
      table_id: 20,
      table_name: "Table",
      database_id: 10,
      row_id: submittedBody.row_id,
      values: [["Name", "Submitted visible"]],
    });

    const legacySubmitted = await request(env, ctx, "/api/database/views/public/protected-form/submit/", {
      method: "POST",
      headers: { "Baserow-View-Authorization": `JWT ${accessToken}` },
      body: JSON.stringify({ Name: "Legacy visible", Status: { id: 330, value: "Todo", color: "blue" }, Hidden: "Legacy hidden" }),
    });
    expect(legacySubmitted.status).toBe(200);
    const legacyBody = await legacySubmitted.json() as any;
    expect(legacyBody.row_id).toEqual(expect.any(Number));
    const legacyInserted = await env.DB.prepare('SELECT "field_30", "field_31", "field_33" FROM "database_table_20" WHERE id=?')
      .bind(legacyBody.row_id)
      .first<any>();
    expect(legacyInserted.field_30).toBe("Legacy visible");
    expect(legacyInserted.field_31).toBeNull();
    expect(JSON.parse(legacyInserted.field_33)).toMatchObject({ id: 330, value: "Todo", color: "blue" });
  });
});
