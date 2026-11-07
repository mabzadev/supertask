import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installTemplateIntoWorkspace } from "../src/services/templates";

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
    "0005_templates.sql",
    "0019_premium_view_settings.sql",
    "0020_view_filter_groups.sql",
    "0022_form_view_field_options_logic.sql",
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

const sourceTemplate = {
  name: "Lead Management",
  export: [{
    id: 100,
    name: "CRM",
    order: 1,
    type: "database",
    tables: [{
      id: 200,
      name: "Leads",
      order: 1,
      fields: [
        { id: 1, type: "text", name: "Name", order: 1, primary: true },
        {
          id: 2,
          type: "single_select",
          name: "Status",
          order: 2,
          select_options: [{ id: 20, value: "Todo", color: "blue", order: 1 }],
        },
        {
          id: 8,
          type: "multiple_select",
          name: "Tags",
          order: 3,
          select_options: [
            { id: 21, value: "Hot", color: "red", order: 1 },
            { id: 22, value: "Inbound", color: "green", order: 2 },
          ],
        },
        { id: 3, type: "file", name: "Cover", order: 4 },
        {
          id: 9,
          type: "ai",
          name: "AI summary",
          order: 5,
          ai_generative_ai_type: "openai",
          ai_generative_ai_model: "gpt-test",
          ai_output_type: "text",
          ai_prompt: { formula: "CONCAT('Summary ', get('fields.field_1'))", mode: "simple", version: "0.1" },
          ai_file_field_id: 3,
          ai_auto_update: true,
          ai_auto_update_user_id: 7,
        },
        { id: 4, type: "date", name: "Start", order: 6 },
        { id: 5, type: "date", name: "End", order: 7 },
        {
          id: 7,
          type: "link_row",
          name: "Customer",
          order: 8,
          link_row_table_id: 201,
          link_row_related_field_id: null,
          link_row_multiple_relationships: true,
        },
      ],
      views: [
        {
          id: 301,
          type: "gallery",
          name: "Gallery",
          order: 1,
          public: false,
          card_cover_image_field_id: 3,
          field_options: [
            { id: 401, field_id: 1, hidden: false, order: 10 },
            { id: 402, field_id: 3, hidden: true, order: 20 },
          ],
        },
        {
          id: 302,
          type: "kanban",
          name: "Kanban",
          order: 2,
          public: false,
          single_select_field_id: 2,
          card_cover_image_field_id: 3,
          field_options: [
            { id: 403, field_id: 1, hidden: false, order: 10 },
            { id: 404, field_id: 2, hidden: true, order: 20 },
          ],
        },
        {
          id: 303,
          type: "calendar",
          name: "Calendar",
          order: 3,
          public: false,
          date_field_id: 4,
          field_options: [
            { id: 405, field_id: 1, hidden: false, order: 10 },
            { id: 406, field_id: 4, hidden: true, order: 20 },
          ],
          decorations: [{
            id: 501,
            type: "left_border_color",
            value_provider_type: "single_select_color",
            value_provider_conf: { field_id: 2, select_option_id: 20 },
            order: 1,
          }],
        },
        {
          id: 304,
          type: "timeline",
          name: "Timeline",
          order: 4,
          public: false,
          start_date_field_id: 4,
          end_date_field_id: 5,
          timescale: "week",
          field_options: [
            { id: 407, field_id: 4, hidden: false, order: 10 },
            { id: 408, field_id: 5, hidden: false, order: 20 },
          ],
        },
        {
          id: 305,
          type: "form",
          name: "Intake form",
          order: 5,
          public: false,
          title: "Add lead",
          description: "Create a lead",
          submit_text: "Send",
          submit_action: "MESSAGE",
          submit_action_message: "Thanks",
          submit_action_redirect_url: "",
          field_options: [
            {
              id: 409,
              field_id: 1,
              name: "Lead name",
              description: "Visible lead name",
              enabled: true,
              required: true,
              order: 1,
              show_when_matching_conditions: false,
              condition_type: "AND",
              include_all_select_options: true,
              field_component: "default",
              conditions: [],
              condition_groups: [],
            },
            {
              id: 410,
              field_id: 2,
              name: "Status",
              description: "Only Todo is allowed",
              enabled: true,
              required: false,
              order: 2,
              show_when_matching_conditions: true,
              condition_type: "AND",
              include_all_select_options: false,
              allowed_select_options: [20],
              condition_groups: [{ id: 601, filter_type: "AND", parent_group_id: null }],
              conditions: [{ id: 701, field_id: 2, type: "single_select_equal", value: "20", group_id: 601 }],
              field_component: "default",
            },
          ],
        },
      ],
      rows: [{
        id: 1,
        order: 10000,
        created_on: "2026-07-09T12:00:00.000Z",
        updated_on: "2026-07-09T12:00:00.000Z",
        field_1: "Lead A",
        field_2: 20,
        field_8: [21, 22],
        field_3: [],
        field_4: "2026-07-10",
        field_5: "2026-07-17",
        field_7: [11],
      }],
    }, {
      id: 201,
      name: "Customers",
      order: 2,
      fields: [
        { id: 6, type: "text", name: "Customer name", order: 1, primary: true },
      ],
      views: [],
      rows: [{
        id: 11,
        order: 10000,
        created_on: "2026-07-09T12:00:00.000Z",
        updated_on: "2026-07-09T12:00:00.000Z",
        field_6: "Acme Ltd",
      }],
    }],
  }],
};

describe("template import parity", () => {
  it("remaps Supertask template view settings, field options, form logic and decorations", async () => {
    const db = createTestD1();
    const now = "2026-07-09T12:00:00.000Z";
    await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)")
      .bind(now)
      .run();
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, last_login, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (7, '', NULL, 0, 'owner', 'Owner', '', 'owner@example.com', 0, 1, ?)`
    ).bind(now).run();
    await db.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 7, 'ADMIN')")
      .run();

    const env = {
      DB: db,
      FILES: {
        get: async (key: string) => key === "templates/lead-management.json"
          ? { text: async () => JSON.stringify(sourceTemplate) }
          : null,
        put: async () => undefined,
      },
      PUBLIC_URL: "https://api.supertask.test",
    } as any;

    const applications = await installTemplateIntoWorkspace(env, 1, 73, 7);
    expect(applications).toHaveLength(1);

    const tables = (await db.prepare("SELECT * FROM database_table WHERE database_id=?").bind(applications[0].id).all<any>()).results;
    const tableByName = new Map(tables.map((row: any) => [row.name, row]));
    const table = tableByName.get("Leads");
    const customerTable = tableByName.get("Customers");
    const fields = (await db.prepare("SELECT * FROM database_field WHERE table_id=?").bind(table.id).all<any>()).results;
    const fieldByName = new Map(fields.map((field: any) => [field.name, field]));
    const statusOption = await db.prepare("SELECT * FROM database_selectoption WHERE field_id=?").bind(fieldByName.get("Status").id).first<any>();
    const tagOptions = (await db.prepare("SELECT * FROM database_selectoption WHERE field_id=? ORDER BY [order] ASC")
      .bind(fieldByName.get("Tags").id)
      .all<any>()).results;

    const views = (await db.prepare("SELECT * FROM database_view WHERE table_id=? ORDER BY [order] ASC").bind(table.id).all<any>()).results;
    const viewByName = new Map(views.map((view: any) => [view.name, view]));

    expect(viewByName.get("Gallery")).toMatchObject({ type: "gallery", card_cover_image_field: fieldByName.get("Cover").id });
    expect(await db.prepare("SELECT hidden, [order] FROM database_galleryviewfieldoptions WHERE gallery_view_id=? AND field_id=?")
      .bind(viewByName.get("Gallery").id, fieldByName.get("Name").id)
      .first<any>()).toMatchObject({ hidden: 0, order: 10 });

    expect(viewByName.get("Kanban")).toMatchObject({
      type: "kanban",
      single_select_field: fieldByName.get("Status").id,
      card_cover_image_field: fieldByName.get("Cover").id,
    });
    expect(await db.prepare("SELECT hidden, [order] FROM database_gridviewfieldoptions WHERE grid_view_id=? AND field_id=?")
      .bind(viewByName.get("Kanban").id, fieldByName.get("Status").id)
      .first<any>()).toMatchObject({ hidden: 1, order: 20 });

    expect(viewByName.get("Calendar")).toMatchObject({ type: "calendar", date_field: fieldByName.get("Start").id });
    const decoration = await db.prepare("SELECT * FROM database_viewdecoration WHERE view_id=?").bind(viewByName.get("Calendar").id).first<any>();
    expect(JSON.parse(decoration.value_provider_conf)).toMatchObject({
      field_id: fieldByName.get("Status").id,
      select_option_id: statusOption.id,
    });

    expect(viewByName.get("Timeline")).toMatchObject({
      type: "timeline",
      start_date_field: fieldByName.get("Start").id,
      end_date_field: fieldByName.get("End").id,
      timescale: "week",
    });

    const form = viewByName.get("Intake form");
    const formDetails = await db.prepare("SELECT * FROM database_formview WHERE view_ptr_id=?").bind(form.id).first<any>();
    expect(formDetails).toMatchObject({ title: "Add lead", description: "Create a lead", submit_text: "Send", submit_action_message: "Thanks" });
    const formStatusOption = await db.prepare("SELECT * FROM database_formviewfieldoptions WHERE form_view_id=? AND field_id=?")
      .bind(form.id, fieldByName.get("Status").id)
      .first<any>();
    expect(formStatusOption).toMatchObject({ include_all_select_options: 0, show_when_matching_conditions: 1 });
    expect(await db.prepare("SELECT select_option_id FROM database_formviewfieldoptions_allowedselectoptions WHERE form_view_field_options_id=?")
      .bind(formStatusOption.id)
      .first<any>()).toMatchObject({ select_option_id: statusOption.id });
    const condition = await db.prepare("SELECT * FROM database_formviewfieldoptionscondition WHERE field_option_id=?")
      .bind(formStatusOption.id)
      .first<any>();
    expect(condition).toMatchObject({
      field_id: fieldByName.get("Status").id,
      type: "single_select_equal",
      value: String(statusOption.id),
    });

    const linkField = fieldByName.get("Customer");
    const linkSettings = JSON.parse(linkField.field_settings);
    expect(linkSettings.link_row_table_id).toBe(customerTable.id);
    const aiField = fieldByName.get("AI summary");
    const aiSettings = JSON.parse(aiField.field_settings);
    expect(aiSettings).toMatchObject({
      ai_prompt: { formula: `CONCAT('Summary ', get('fields.field_${fieldByName.get("Name").id}'))` },
      ai_file_field_id: fieldByName.get("Cover").id,
      ai_auto_update: true,
      ai_auto_update_user_id: 7,
    });
    const aiDependencies = await db.prepare(
      "SELECT dependency_id FROM database_fielddependency WHERE dependant_id=? ORDER BY dependency_id ASC"
    ).bind(aiField.id).all<any>();
    expect(aiDependencies.results.map((item: any) => item.dependency_id)).toEqual([
      fieldByName.get("Name").id,
      fieldByName.get("Cover").id,
    ].sort((left, right) => left - right));
    const leadRow = await db.prepare(
      `SELECT "field_${fieldByName.get("Status").id}" AS status_value,
              "field_${fieldByName.get("Tags").id}" AS tags_value,
              "field_${linkField.id}" AS link_value
         FROM "database_table_${table.id}" WHERE id=1`
    ).first<any>();
    expect(JSON.parse(leadRow.status_value)).toEqual({
      id: statusOption.id,
      value: "Todo",
      color: "blue",
    });
    expect(JSON.parse(leadRow.tags_value)).toEqual([
      { id: tagOptions[0].id, value: "Hot", color: "red" },
      { id: tagOptions[1].id, value: "Inbound", color: "green" },
    ]);
    expect(JSON.parse(leadRow.link_value)).toEqual([{ id: 11, value: "Acme Ltd" }]);
  });
});
