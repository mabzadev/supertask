import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanupExpiredAccounts, cleanupExpiredTrash } from "../src/cron/handler";
import { updateUserLastLogin } from "../src/services/user";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

function testD1() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const file of [
    "0001_initial.sql",
    "0003_user_files.sql",
    "0021_workspace_trash.sql",
    "0028_userfile_baserow_name_hash.sql",
    "0049_deletion_lifecycle.sql",
  ]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
  const prepare = (sql: string) => {
    const statement = database.prepare(sql);
    const run = (args: unknown[]) => Promise.resolve(statement.run(...args.map((value) => value === undefined ? null : value)));
    const first = <T>(args: unknown[]) => Promise.resolve((statement.get(...args) || null) as T | null);
    const all = <T>(args: unknown[]) => Promise.resolve({ results: statement.all(...args) as T[] });
    return {
      bind(...args: unknown[]) {
        return { run: () => run(args), first: <T>() => first<T>(args), all: <T>() => all<T>(args) };
      },
      run: () => run([]),
      first: <T>() => first<T>([]),
      all: <T>() => all<T>([]),
    };
  };
  return {
    database,
    prepare,
    batch: (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
  } as any;
}

async function fixture() {
  const DB = testD1();
  const deletedKeys: string[] = [];
  const env = {
    DB,
    FILES: {
      delete: async (keys: string | string[]) => deletedKeys.push(...(Array.isArray(keys) ? keys : [keys])),
    },
    JOBS_QUEUE: { sendBatch: async () => undefined },
  } as any;
  const now = new Date().toISOString();
  await DB.prepare(
    `INSERT INTO auth_user
     (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES
       (1, '', 'admin@example.com', 'Admin', '', 'admin@example.com', 1, 1, ?),
       (2, '', 'delete@example.com', 'Delete', '', 'delete@example.com', 0, 1, ?)`
  ).bind(now, now).run();
  await DB.prepare(
    `INSERT INTO core_userprofile (user_id, language, email_notification_frequency, to_be_deleted, deletion_requested_at)
     VALUES (1, 'fr', 'instant', 0, NULL), (2, 'fr', 'instant', 1, '2000-01-01T00:00:00.000Z')`
  ).run();
  await DB.prepare("UPDATE core_settings SET account_deletion_grace_delay=30 WHERE id=1").run();
  return { DB, env, deletedKeys, now };
}

describe("deletion lifecycle", () => {
  it("physically deletes expired trash rows and their unreferenced R2 files", async () => {
    const { DB, env, deletedKeys, now } = await fixture();
    await DB.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'W', ?, 0, 1)")
      .bind(now).run();
    await DB.prepare("INSERT INTO core_workspaceuser (workspace_id, user_id, permissions) VALUES (1, 1, 'ADMIN')").run();
    await DB.prepare(
      "INSERT INTO core_application (id, workspace_id, name, type, [order], trashed, created_on, updated_on) VALUES (10, 1, 'DB', 'database', 1, 0, ?, ?)"
    ).bind(now, now).run();
    await DB.prepare(
      "INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on) VALUES (20, 10, 'T', 1, 1, 0, ?, ?)"
    ).bind(now, now).run();
    await DB.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], [primary], read_only, trashed, created_on, updated_on)
       VALUES (30, 20, 'Files', 'file', 1, 1, 0, 0, ?, ?)`
    ).bind(now, now).run();
    await DB.prepare(
      `CREATE TABLE "database_table_20" (
        id INTEGER PRIMARY KEY, [order] REAL NOT NULL DEFAULT 1, trashed INTEGER NOT NULL DEFAULT 0,
        _created_on TEXT, _updated_on TEXT, _created_by_id INTEGER, _last_modified_by_id INTEGER,
        "field_30" TEXT
      )`
    ).run();
    const cell = JSON.stringify([{ name: "expired.pdf", visible_name: "expired.pdf" }]);
    await DB.prepare("INSERT INTO database_table_20 (id, trashed, field_30) VALUES (1, 1, ?)").bind(cell).run();
    await DB.prepare(
      `INSERT INTO core_userfile
       (id, user_id, name, original_name, r2_key, size, mime_type, is_image, uploaded_at)
       VALUES (1, 2, 'expired.pdf', 'expired.pdf', 'user_files/expired.pdf', 10, 'application/pdf', 0, ?)`
    ).bind(now).run();
    await DB.prepare(
      `INSERT INTO core_trasheditem
       (user_id, trash_item_type, trash_item_id, parent_trash_item_id, trashed_at,
        should_be_permanently_deleted, extra_description, application_id, workspace_id)
       VALUES (1, 'row', 1, 20, '2000-01-01T00:00:00.000Z', 0, ?, 10, 1)`
    ).bind(JSON.stringify({ row: { id: 1, field_30: cell } })).run();

    expect(await cleanupExpiredTrash(env)).toBe(1);
    expect(await DB.prepare("SELECT id FROM database_table_20 WHERE id=1").first()).toBeNull();
    expect(await DB.prepare("SELECT id FROM core_userfile WHERE id=1").first()).toBeNull();
    expect(await DB.prepare("SELECT id FROM core_trasheditem").first()).toBeNull();
    expect(deletedKeys).toEqual(["user_files/expired.pdf"]);
  });

  it("deletes accounts after their grace period and cancels deletion on login", async () => {
    const { DB, env, now } = await fixture();
    await DB.prepare(
      "INSERT INTO enterprise_roleassignment (role_id, subject_id, subject_type, scope_id, scope_type) VALUES (1, 2, 'auth.User', 1, 'workspace')"
    ).run();

    expect(await cleanupExpiredAccounts(env)).toBe(1);
    expect(await DB.prepare("SELECT id FROM auth_user WHERE id=2").first()).toBeNull();
    expect(await DB.prepare("SELECT id FROM enterprise_roleassignment WHERE subject_id=2").first()).toBeNull();

    await DB.prepare(
      `INSERT INTO auth_user
       (id, password, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (3, '', 'cancel@example.com', 'Cancel', '', 'cancel@example.com', 0, 1, ?)`
    ).bind(now).run();
    await DB.prepare(
      `INSERT INTO core_userprofile
       (user_id, language, email_notification_frequency, to_be_deleted, deletion_requested_at)
       VALUES (3, 'fr', 'instant', 1, '2000-01-01T00:00:00.000Z')`
    ).run();
    await updateUserLastLogin(DB, 3);
    expect(await DB.prepare(
      "SELECT to_be_deleted, deletion_requested_at FROM core_userprofile WHERE user_id=3"
    ).first()).toEqual({ to_be_deleted: 0, deletion_requested_at: null });
  });
});
