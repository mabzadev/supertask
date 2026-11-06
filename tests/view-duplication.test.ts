import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { duplicateViewDependencies } from "../src/services/view-duplication";
import { restoreViewStateForUndoRedo, snapshotViewForUndoRedo } from "../src/services/view-snapshots";

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
  for (const file of ["0001_initial.sql", "0051_last_password_change.sql", "0020_view_filter_groups.sql", "0022_form_view_field_options_logic.sql", "0043_form_view_submit_notifications.sql"]) {
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

async function seedBase(db: TestD1) {
  const now = "2026-01-01T00:00:00.000Z";
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Workspace', ?, 0, 1)").bind(now).run();
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_active, date_joined)
     VALUES (7, '', 'owner', 'Owner', '', 'owner@example.com', 1, ?)`
  ).bind(now).run();
  await db.prepare("INSERT INTO core_application (id, workspace_id, name, type, [order], created_on, updated_on) VALUES (10, 1, 'Database', 'database', 1, ?, ?)").bind(now, now).run();
  await db.prepare("INSERT INTO database_table (id, database_id, name, [order], created_on, updated_on) VALUES (20, 10, 'Table', 1, ?, ?)").bind(now, now).run();
  await db.prepare("INSERT INTO database_field (id, table_id, name, type, [order], \"primary\", created_on, updated_on) VALUES (101, 20, 'Name', 'text', 1, 1, ?, ?)").bind(now, now).run();
  await db.prepare("INSERT INTO database_field (id, table_id, name, type, [order], \"primary\", created_on, updated_on) VALUES (102, 20, 'Status', 'single_select', 2, 0, ?, ?)").bind(now, now).run();
  await db.prepare("INSERT INTO database_selectoption (id, field_id, value, color, [order]) VALUES (201, 102, 'Open', 'blue', 1)").run();
}

describe("view duplication", () => {
  it("duplicates form view details, field options, allowed select options and condition logic", async () => {
    const db = createTestD1();
    await seedBase(db);
    const now = "2026-01-01T00:00:00.000Z";
    await db.prepare(
      "INSERT INTO database_view (id, table_id, name, type, [order], slug, created_on, updated_on) VALUES (301, 20, 'Form', 'form', 1, 'formslug', ?, ?)"
    ).bind(now, now).run();
    await db.prepare(
      "INSERT INTO database_view (id, table_id, name, type, [order], slug, created_on, updated_on) VALUES (302, 20, 'Form copy', 'form', 2, 'copyformslug', ?, ?)"
    ).bind(now, now).run();
    await db.prepare(
      `INSERT INTO database_formview
       (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
        submit_action_redirect_url, mode, show_logo, cover_image, logo_image)
       VALUES (301, 'Public title', 'Public description', 'Send', 'MESSAGE', 'Thanks', '', 'survey', 0, '{"name":"cover"}', '{"name":"logo"}')`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptions
       (id, form_view_id, field_id, name, description, enabled, required, [order],
        show_when_matching_conditions, condition_type, include_all_select_options, field_component)
       VALUES (401, 301, 102, 'Status label', 'Pick one', 1, 1, 32768, 1, 'OR', 0, 'default')`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptions_allowedselectoptions
       (form_view_field_options_id, select_option_id)
       VALUES (401, 201)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptionsconditiongroup
       (id, field_option_id, filter_type, parent_group_id)
       VALUES (501, 401, 'AND', NULL)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formviewfieldoptionscondition
       (field_option_id, field_id, type, value, group_id)
       VALUES (401, 101, 'contains', 'VIP', 501)`
    ).run();
    await db.prepare(
      `INSERT INTO database_formview_users_to_notify_on_submit (formview_id, user_id)
       VALUES (301, 7)`
    ).run();
    const undoSnapshot = await snapshotViewForUndoRedo(db as any, 301);

    await duplicateViewDependencies(db as any, 301, 302, "form");

    const form = await db.prepare("SELECT * FROM database_formview WHERE view_ptr_id=302").first<any>();
    expect(form).toMatchObject({ title: "Public title", description: "Public description", submit_text: "Send", mode: "survey", show_logo: 0 });

    const option = await db.prepare("SELECT * FROM database_formviewfieldoptions WHERE form_view_id=302 AND field_id=102").first<any>();
    expect(option).toMatchObject({
      name: "Status label",
      description: "Pick one",
      enabled: 1,
      required: 1,
      show_when_matching_conditions: 1,
      condition_type: "OR",
      include_all_select_options: 0,
    });

    const allowed = await db.prepare("SELECT * FROM database_formviewfieldoptions_allowedselectoptions WHERE form_view_field_options_id=?").bind(option.id).first<any>();
    expect(allowed.select_option_id).toBe(201);

    const group = await db.prepare("SELECT * FROM database_formviewfieldoptionsconditiongroup WHERE field_option_id=?").bind(option.id).first<any>();
    expect(group).toMatchObject({ filter_type: "AND", parent_group_id: null });

    const condition = await db.prepare("SELECT * FROM database_formviewfieldoptionscondition WHERE field_option_id=?").bind(option.id).first<any>();
    expect(condition).toMatchObject({ field_id: 101, type: "contains", value: "VIP", group_id: group.id });
    expect(condition.group_id).not.toBe(501);
    expect(await db.prepare(
      "SELECT formview_id, user_id FROM database_formview_users_to_notify_on_submit WHERE formview_id=302"
    ).first<any>()).toEqual({ formview_id: 302, user_id: 7 });

    await db.prepare("DELETE FROM database_formview_users_to_notify_on_submit WHERE formview_id=301").run();
    await restoreViewStateForUndoRedo(db as any, undoSnapshot as any);
    expect(await db.prepare(
      "SELECT formview_id, user_id FROM database_formview_users_to_notify_on_submit WHERE formview_id=301"
    ).first<any>()).toEqual({ formview_id: 301, user_id: 7 });
  });

  it("duplicates filters, sorts, group bys, decorations and grid field options", async () => {
    const db = createTestD1();
    await seedBase(db);
    const now = "2026-01-01T00:00:00.000Z";
    await db.prepare("INSERT INTO database_view (id, table_id, name, type, [order], slug, created_on, updated_on) VALUES (601, 20, 'Grid', 'grid', 1, 'grid', ?, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO database_view (id, table_id, name, type, [order], slug, created_on, updated_on) VALUES (602, 20, 'Grid copy', 'grid', 2, 'gridcopy', ?, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO database_viewfiltergroup (id, view_id, parent_group_id, filter_type) VALUES (701, 601, NULL, 'OR')").run();
    await db.prepare("INSERT INTO database_viewfilter (view_id, field_id, type, value, preload_values, group_id) VALUES (601, 101, 'contains', 'Acme', '{\"a\":1}', 701)").run();
    await db.prepare("INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (601, 101, 'DESC', 'default')").run();
    await db.prepare("INSERT INTO database_viewgroupby (view_id, field_id, [order], width, type) VALUES (601, 102, 'ASC', 250, 'default')").run();
    await db.prepare("INSERT INTO database_viewdecoration (view_id, type, value_provider_type, value_provider_conf, [order]) VALUES (601, 'left_border_color', 'single_select_color', '{\"field_id\":102}', 3)").run();
    await db.prepare("INSERT INTO database_gridviewfieldoptions (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type) VALUES (601, 101, 320, 1, 32768, 'count', 'empty')").run();

    await duplicateViewDependencies(db as any, 601, 602, "grid");

    const group = await db.prepare("SELECT * FROM database_viewfiltergroup WHERE view_id=602").first<any>();
    expect(group).toMatchObject({ filter_type: "OR", parent_group_id: null });
    expect(group.id).not.toBe(701);

    const filter = await db.prepare("SELECT * FROM database_viewfilter WHERE view_id=602").first<any>();
    expect(filter).toMatchObject({ field_id: 101, type: "contains", value: "Acme", preload_values: "{\"a\":1}", group_id: group.id });
    expect(await db.prepare("SELECT [order] FROM database_viewsort WHERE view_id=602").first<any>()).toMatchObject({ order: "DESC" });
    expect(await db.prepare("SELECT width FROM database_viewgroupby WHERE view_id=602").first<any>()).toMatchObject({ width: 250 });
    expect(await db.prepare("SELECT [order], value_provider_conf FROM database_viewdecoration WHERE view_id=602").first<any>()).toMatchObject({ order: 3, value_provider_conf: "{\"field_id\":102}" });
    expect(await db.prepare("SELECT width, hidden, aggregation_type FROM database_gridviewfieldoptions WHERE grid_view_id=602").first<any>()).toMatchObject({ width: 320, hidden: 1, aggregation_type: "count" });
  });
});
