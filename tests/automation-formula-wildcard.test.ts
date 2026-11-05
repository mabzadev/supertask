import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { signAccessToken } from "../src/middleware/auth";
import { startWorkflow } from "../src/services/automation";
import { addFieldColumn, getOrCreateUserTable } from "../src/services/dynamic-tables";
import { triggerAutomationTableWorkflows, triggerDuePeriodicAutomationWorkflows } from "../src/services/automation";
import { handleQueue } from "../src/queue/handler";

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
  "0025_row_history_undo_redo.sql",
  "0026_core_action_undo_redo.sql",
  "0039_builder_published_applications.sql",
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

async function setupAutomationFixture() {
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
     VALUES (10, 1, 'Database', 'database', 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_table (id, database_id, name, [order], version, trashed, created_on, updated_on)
     VALUES (20, 10, 'Contacts', 1, 1, 0, ?, ?)`
  ).bind(now, now).run();
  await db.prepare(
    `INSERT INTO database_field (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
     VALUES (30, 20, 'Name', 'text', 1, 1, 0, 0, '{}', ?, ?)`
  ).bind(now, now).run();
  await getOrCreateUserTable(db as any, 20);
  await addFieldColumn(db as any, 20, { id: 30, type: "text", primary: true });
  await db.prepare(
    `INSERT INTO "database_table_20" (field_30, _created_on, _updated_on)
     VALUES ('Ada', ?, ?), ('Ben', ?, ?)`
  ).bind(now, now, now, now).run();

  const queueMessages: any[] = [];
  const env = {
    DB: db,
    JWT_SIGNING_KEY: "test-secret",
    CACHE: { get: async () => null, put: async () => undefined },
    FILES: { head: async () => null },
    JOBS_QUEUE: { send: async (message: any) => { queueMessages.push(message); } },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    ENVIRONMENT: "test",
    PUBLIC_URL: "https://api.supertask.test",
  } as any;
  const token = await signAccessToken({ user_id: 7, email: "owner@example.com", username: "owner@example.com" }, "test-secret", 60);
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  return { db, env, token, ctx, queueMessages };
}

async function runNextQueuedJob(env: any, queueMessages: any[]) {
  const body = queueMessages.shift();
  expect(body).toBeTruthy();
  const ack = vi.fn();
  await handleQueue({ messages: [{ body, ack }] } as any, env);
  expect(ack).toHaveBeenCalledOnce();
  return body;
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

describe("automation formula wildcard parity", () => {
  it("validates workflow names, states, protected graphs and five-minute test windows", async () => {
    const { db, env, token, ctx } = await setupAutomationFixture();
    const appResponse = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Validated automation", type: "automation" }),
    });
    const app = await appResponse.json() as any;
    const first = app.workflows[0];

    for (const name of ["Workflow", "   ", "x".repeat(256)]) {
      const response = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: name === "Workflow"
          ? "ERROR_AUTOMATION_WORKFLOW_NAME_NOT_UNIQUE"
          : "ERROR_REQUEST_BODY_VALIDATION",
      });
    }

    const secondResponse = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
      method: "POST",
      body: JSON.stringify({ name: "Second" }),
    });
    const second = await secondResponse.json() as any;
    const duplicateRename = await api(env, ctx, token, `/api/automation/workflows/${second.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Workflow" }),
    });
    expect(duplicateRename.status).toBe(400);
    expect(await duplicateRename.json()).toMatchObject({ error: "ERROR_AUTOMATION_WORKFLOW_NAME_NOT_UNIQUE" });

    const triggerResponse = await api(env, ctx, token, `/api/automation/workflow/${first.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger", service: { uid: crypto.randomUUID() } }),
    });
    expect(triggerResponse.status).toBe(200);
    const storedBefore = await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(first.id)
      .first<{ graph: string }>();
    const protectedPatch = await api(env, ctx, token, `/api/automation/workflows/${first.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ graph: {}, name: "Workflow renamed" }),
    });
    expect(protectedPatch.status).toBe(200);
    expect((await protectedPatch.json() as any).name).toBe("Workflow renamed");
    expect((await db.prepare("SELECT graph FROM automation_workflow WHERE id=?").bind(first.id).first<{ graph: string }>())?.graph)
      .toBe(storedBefore?.graph);

    const invalidState = await api(env, ctx, token, `/api/automation/workflows/${first.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ state: "pending" }),
    });
    expect(invalidState.status).toBe(400);
    expect(await invalidState.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });

    const beforeEnable = Date.now();
    const enabled = await api(env, ctx, token, `/api/automation/workflows/${first.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ allow_test_run: true }),
    });
    const enabledWorkflow = await enabled.json() as any;
    const expiresAfterMs = Date.parse(enabledWorkflow.allow_test_run_until) - beforeEnable;
    expect(expiresAfterMs).toBeGreaterThanOrEqual(4 * 60 * 1000 + 50 * 1000);
    expect(expiresAfterMs).toBeLessThanOrEqual(5 * 60 * 1000 + 10 * 1000);

    await api(env, ctx, token, `/api/automation/workflows/${first.id}/test/`, { method: "POST" });
    const beforeToggle = Date.now();
    const toggled = await api(env, ctx, token, `/api/automation/workflows/${first.id}/test/`, { method: "POST" });
    const toggledWorkflow = await toggled.json() as any;
    const toggledExpiresAfterMs = Date.parse(toggledWorkflow.allow_test_run_until) - beforeToggle;
    expect(toggledExpiresAfterMs).toBeGreaterThanOrEqual(4 * 60 * 1000 + 50 * 1000);
    expect(toggledExpiresAfterMs).toBeLessThanOrEqual(5 * 60 * 1000 + 10 * 1000);
  });

  it("orders workflows through the source route without rewriting node graphs", async () => {
    const { db, env, token, ctx } = await setupAutomationFixture();
    const appResponse = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Ordered automation", type: "automation" }),
    });
    const app = await appResponse.json() as any;
    const first = app.workflows[0];
    const triggerResponse = await api(env, ctx, token, `/api/automation/workflow/${first.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger", service: { uid: crypto.randomUUID() } }),
    });
    const trigger = await triggerResponse.json() as any;
    const routerResponse = await api(env, ctx, token, `/api/automation/workflow/${first.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "router", reference_node_id: trigger.id }),
    });
    const router = await routerResponse.json() as any;
    const edgeUid = router.service.edges[0].uid;
    await api(env, ctx, token, `/api/automation/workflow/${first.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "local_baserow_list_rows",
        reference_node_id: router.id,
        output: edgeUid,
        service: { table_id: 20 },
      }),
    });
    const graphBefore = await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(first.id)
      .first<{ graph: string }>();

    const secondResponse = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
      method: "POST",
      body: JSON.stringify({ name: "Second" }),
    });
    const second = await secondResponse.json() as any;
    const thirdResponse = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
      method: "POST",
      body: JSON.stringify({ name: "Third" }),
    });
    const third = await thirdResponse.json() as any;

    const reordered = await api(env, ctx, token, `/api/automation/${app.id}/workflows/order/`, {
      method: "POST",
      body: JSON.stringify({ workflow_ids: [third.id, first.id] }),
    });
    expect(reordered.status).toBe(204);
    expect(await reordered.text()).toBe("");
    const listedResponse = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`);
    expect((await listedResponse.json() as any[]).map((workflow) => workflow.id)).toEqual([third.id, first.id, second.id]);
    expect((await db.prepare("SELECT graph FROM automation_workflow WHERE id=?").bind(first.id).first<{ graph: string }>())?.graph)
      .toBe(graphBefore?.graph);

    const otherAppResponse = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Other automation", type: "automation" }),
    });
    const otherWorkflow = (await otherAppResponse.json() as any).workflows[0];
    const foreign = await api(env, ctx, token, `/api/automation/${app.id}/workflows/order/`, {
      method: "POST",
      body: JSON.stringify({ workflow_ids: [otherWorkflow.id] }),
    });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ error: "ERROR_AUTOMATION_WORKFLOW_NOT_IN_AUTOMATION" });

    const duplicateIds = await api(env, ctx, token, `/api/automation/${app.id}/workflows/order/`, {
      method: "POST",
      body: JSON.stringify({ workflow_ids: [first.id, first.id] }),
    });
    expect(duplicateIds.status).toBe(400);
    expect(await duplicateIds.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });

    const removedNodeOrderRoute = await api(env, ctx, token, `/api/automation/workflows/${first.id}/nodes/order/`, {
      method: "POST",
      body: JSON.stringify({ node_ids: [trigger.id, router.id] }),
    });
    expect(removedNodeOrderRoute.status).toBe(404);
  });

  it("queues workflow duplication and publishing with Baserow concurrency limits", async () => {
    const { db, env, token, ctx, queueMessages } = await setupAutomationFixture();
    const appResponse = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Queued automation", type: "automation" }),
    });
    const app = await appResponse.json() as any;
    const workflow = app.workflows[0];

    const duplicateResponse = await api(env, ctx, token, `/api/automation/workflows/${workflow.id}/duplicate/async/`, {
      method: "POST",
    });
    expect(duplicateResponse.status).toBe(202);
    const duplicateJob = await duplicateResponse.json() as any;
    expect(duplicateJob).toMatchObject({
      type: "duplicate_automation_workflow",
      state: "pending",
      progress_percentage: 0,
      original_automation_workflow: { id: workflow.id, automation_id: app.id },
    });
    expect(queueMessages[0]).toEqual({
      job_id: duplicateJob.id,
      job_type: "duplicate_automation_workflow",
      payload: { workflow_id: workflow.id, action_session: "", action_group: null },
      user_id: 7,
      workspace_id: 1,
    });
    const draftsBeforeQueue = await db.prepare(
      "SELECT COUNT(*) AS count FROM automation_workflow WHERE automation_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=0"
    ).bind(app.id).first<{ count: number }>();
    expect(draftsBeforeQueue?.count).toBe(1);

    const duplicateWhilePending = await api(env, ctx, token, `/api/automation/workflows/${workflow.id}/duplicate/async/`, {
      method: "POST",
    });
    expect(duplicateWhilePending.status).toBe(400);
    expect(await duplicateWhilePending.json()).toMatchObject({ error: "ERROR_MAX_JOB_COUNT_EXCEEDED" });

    await runNextQueuedJob(env, queueMessages);
    const completedDuplicateResponse = await api(env, ctx, token, `/api/jobs/${duplicateJob.id}/`);
    const completedDuplicate = await completedDuplicateResponse.json() as any;
    expect(completedDuplicate).toMatchObject({
      type: "duplicate_automation_workflow",
      state: "finished",
      progress_percentage: 100,
      duplicated_automation_workflow: { automation_id: app.id, state: "draft" },
    });
    expect(completedDuplicate.duplicated_automation_workflow.id).not.toBe(workflow.id);

    const publishResponses = await Promise.all([
      api(env, ctx, token, `/api/automation/workflows/${workflow.id}/publish/async/`, { method: "POST" }),
      api(env, ctx, token, `/api/automation/workflows/${workflow.id}/publish/async/`, { method: "POST" }),
    ]);
    expect(publishResponses.map((response) => response.status)).toEqual([202, 202]);
    const thirdPublish = await api(env, ctx, token, `/api/automation/workflows/${workflow.id}/publish/async/`, { method: "POST" });
    expect(thirdPublish.status).toBe(400);
    expect(await thirdPublish.json()).toMatchObject({ error: "ERROR_MAX_JOB_COUNT_EXCEEDED" });
    await runNextQueuedJob(env, queueMessages);
    await runNextQueuedJob(env, queueMessages);

    const doomedWorkflowResponse = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
      method: "POST",
      body: JSON.stringify({ name: "Deleted before queue" }),
    });
    const doomedWorkflow = await doomedWorkflowResponse.json() as any;
    const doomedJobResponse = await api(env, ctx, token, `/api/automation/workflows/${doomedWorkflow.id}/duplicate/async/`, {
      method: "POST",
    });
    const doomedJob = await doomedJobResponse.json() as any;
    expect((await api(env, ctx, token, `/api/automation/workflows/${doomedWorkflow.id}/`, { method: "DELETE" })).status).toBe(204);
    await runNextQueuedJob(env, queueMessages);
    const failedJobResponse = await api(env, ctx, token, `/api/jobs/${doomedJob.id}/`);
    expect(await failedJobResponse.json()).toMatchObject({
      state: "failed",
      error: "ERROR_JOB_FAILED",
      progress_percentage: 100,
    });
  });

  it("trashes, lists, restores and permanently deletes workflows without resurrecting defaults", async () => {
    const { db, env, token, ctx, queueMessages } = await setupAutomationFixture();
    const appResponse = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Workflow lifecycle", type: "automation" }),
    });
    expect(appResponse.status).toBe(200);
    const app = await appResponse.json() as any;
    const workflow = app.workflows[0];

    const triggerResponse = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger", label: "Incoming", service: { uid: crypto.randomUUID() } }),
    });
    expect(triggerResponse.status).toBe(200);
    const trigger = await triggerResponse.json() as any;
    const workflowBefore = await db.prepare(
      "SELECT state, graph, allow_test_run_until, simulate_until_node_id FROM automation_workflow WHERE id=?"
    ).bind(workflow.id).first<any>();
    const nodeBefore = await db.prepare("SELECT type, label, service, trashed FROM automation_node WHERE id=?")
      .bind(trigger.id).first<any>();

    const publishResponse = await api(env, ctx, token, `/api/automation/workflows/${workflow.id}/publish/async/`, {
      method: "POST",
    });
    expect(publishResponse.status).toBe(202);
    const publishJob = await publishResponse.json() as any;
    await runNextQueuedJob(env, queueMessages);
    const completedPublish = await (await api(env, ctx, token, `/api/jobs/${publishJob.id}/`)).json() as any;
    const publishedWorkflowId = completedPublish.published_automation_workflow_id;
    expect(publishedWorkflowId).toBeTruthy();

    expect((await api(env, ctx, token, `/api/automation/workflows/${workflow.id}/`, { method: "DELETE" })).status).toBe(204);
    expect(await db.prepare(
      "SELECT id FROM automation_workflow WHERE id=?"
    ).bind(publishedWorkflowId).first<any>()).toBeNull();
    expect(await db.prepare(
      "SELECT state, graph, allow_test_run_until, simulate_until_node_id, trashed FROM automation_workflow WHERE id=?"
    ).bind(workflow.id).first<any>()).toEqual({ ...workflowBefore, trashed: 1 });
    expect(await db.prepare("SELECT type, label, service, trashed FROM automation_node WHERE id=?")
      .bind(trigger.id).first<any>()).toEqual(nodeBefore);
    expect(await db.prepare(
      "SELECT user_id, trash_item_type, trash_item_id, application_id, workspace_id FROM core_trasheditem WHERE trash_item_type='automation_workflow' AND trash_item_id=?"
    ).bind(workflow.id).first<any>()).toEqual({
      user_id: 7,
      trash_item_type: "automation_workflow",
      trash_item_id: workflow.id,
      application_id: app.id,
      workspace_id: 1,
    });

    const listAfterDelete = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`);
    expect(await listAfterDelete.json()).toEqual([]);
    await api(env, ctx, token, "/api/applications/workspace/1/");
    const listAfterApplicationRead = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`);
    expect(await listAfterApplicationRead.json()).toEqual([]);

    const trashResponse = await api(env, ctx, token, `/api/trash/workspace/1/?application_id=${app.id}`);
    expect(trashResponse.status).toBe(200);
    const trash = await trashResponse.json() as any;
    expect(trash.results).toContainEqual(expect.objectContaining({
      trash_item_type: "automation_workflow",
      trash_item_id: workflow.id,
      application: app.id,
      workspace: 1,
      name: "Workflow",
      parent_name: "Workflow lifecycle",
    }));

    const restoreResponse = await api(env, ctx, token, `/api/trash/automation_workflow/${workflow.id}/restore/`, {
      method: "PATCH",
    });
    expect(restoreResponse.status).toBe(200);
    const restoredWorkflows = await (await api(env, ctx, token, `/api/automation/${app.id}/workflows/`)).json() as any[];
    expect(restoredWorkflows.map((item) => item.id)).toEqual([workflow.id]);
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(trigger.id).first<any>())
      .toEqual({ trashed: 0 });
    expect(await db.prepare(
      "SELECT id FROM core_trasheditem WHERE trash_item_type='automation_workflow' AND trash_item_id=?"
    ).bind(workflow.id).first<any>()).toBeNull();

    expect((await api(env, ctx, token, `/api/automation/workflows/${workflow.id}/`, { method: "DELETE" })).status).toBe(204);
    const permanentResponse = await api(
      env,
      ctx,
      token,
      `/api/trash/automation_workflow/${workflow.id}/?workspace_id=1`,
      { method: "DELETE" },
    );
    expect(permanentResponse.status).toBe(200);
    expect(await db.prepare("SELECT id FROM automation_workflow WHERE id=?").bind(workflow.id).first<any>()).toBeNull();
    expect(await db.prepare("SELECT id FROM automation_node WHERE id=?").bind(trigger.id).first<any>()).toBeNull();
    expect(await db.prepare(
      "SELECT id FROM core_trasheditem WHERE trash_item_type='automation_workflow' AND trash_item_id=?"
    ).bind(workflow.id).first<any>()).toBeNull();
    expect(await (await api(env, ctx, token, `/api/automation/${app.id}/workflows/`)).json()).toEqual([]);
  });

  it("restores automation nodes at their exact graph position and rejects missing references", async () => {
    const { db, env, token, ctx } = await setupAutomationFixture();
    const app = await (await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Node trash lifecycle", type: "automation" }),
    })).json() as any;
    const workflow = app.workflows[0];
    const trigger = await (await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger" }),
    })).json() as any;
    const first = await (await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_request", label: "First", reference_node_id: trigger.id }),
    })).json() as any;
    const second = await (await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_request", label: "Second", reference_node_id: first.id }),
    })).json() as any;
    const originalGraph = JSON.parse((await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(workflow.id).first<{ graph: string }>())!.graph);

    expect((await api(env, ctx, token, `/api/automation/node/${first.id}/`, { method: "DELETE" })).status).toBe(204);
    const trashEntry = await db.prepare(
      "SELECT user_id, application_id, workspace_id, extra_description FROM core_trasheditem WHERE trash_item_type='automation_node' AND trash_item_id=?"
    ).bind(first.id).first<any>();
    expect(trashEntry).toMatchObject({ user_id: 7, application_id: app.id, workspace_id: 1 });
    expect(JSON.parse(trashEntry.extra_description)).toMatchObject({
      workflow_id: workflow.id,
      reference_node_id: trigger.id,
      position: "south",
      output: "",
      name: `http_request (${first.id})`,
    });
    const graphWithoutFirst = JSON.parse((await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(workflow.id).first<{ graph: string }>())!.graph);
    expect(graphWithoutFirst[String(trigger.id)].next[""]).toEqual([second.id]);
    expect(graphWithoutFirst[String(first.id)]).toBeUndefined();

    const trashList = await (await api(env, ctx, token, `/api/trash/workspace/1/?application_id=${app.id}`)).json() as any;
    expect(trashList.results).toContainEqual(expect.objectContaining({
      trash_item_type: "automation_node",
      trash_item_id: first.id,
      application: app.id,
      workspace: 1,
      parent_name: "Workflow",
    }));
    expect((await api(env, ctx, token, `/api/trash/automation_node/${first.id}/restore/`, { method: "PATCH" })).status).toBe(200);
    const restoredGraph = JSON.parse((await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(workflow.id).first<{ graph: string }>())!.graph);
    expect(restoredGraph).toEqual(originalGraph);
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(first.id).first<any>())
      .toEqual({ trashed: 0 });

    expect((await api(env, ctx, token, `/api/automation/node/${second.id}/`, { method: "DELETE" })).status).toBe(204);
    expect((await api(env, ctx, token, `/api/automation/node/${first.id}/`, { method: "DELETE" })).status).toBe(204);
    const disallowed = await api(env, ctx, token, `/api/trash/automation_node/${second.id}/restore/`, { method: "PATCH" });
    expect(disallowed.status).toBe(400);
    expect(await disallowed.json()).toMatchObject({
      detail: "This automation node cannot be restored as its reference node has been deleted.",
    });
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(second.id).first<any>())
      .toEqual({ trashed: 1 });

    expect((await api(env, ctx, token, `/api/trash/automation_node/${first.id}/restore/`, { method: "PATCH" })).status).toBe(200);
    const permanent = await api(
      env,
      ctx,
      token,
      `/api/trash/automation_node/${second.id}/?workspace_id=1`,
      { method: "DELETE" },
    );
    expect(permanent.status).toBe(200);
    expect(await db.prepare("SELECT id FROM automation_node WHERE id=?").bind(second.id).first<any>()).toBeNull();
    expect(await db.prepare(
      "SELECT id FROM core_trasheditem WHERE trash_item_type='automation_node' AND trash_item_id=?"
    ).bind(second.id).first<any>()).toBeNull();
  });

  it("undoes and redoes every automation node mutation in the workflow scope", async () => {
    const { db, env, token, ctx } = await setupAutomationFixture();
    const app = await (await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Node undo redo", type: "automation" }),
    })).json() as any;
    const workflow = app.workflows[0];

    const mutation = (path: string, session: string, method: string, body?: unknown) => api(env, ctx, token, path, {
      method,
      headers: { ClientSessionId: session },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const action = async (direction: "undo" | "redo", session: string, actionType: string) => {
      const response = await mutation(`/api/user/${direction}/`, session, "PATCH", {
        scopes: { workflow: workflow.id },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result_code: "SUCCESS",
        actions: [{ action_type: actionType, action_scope: `workflow${workflow.id}` }],
      });
    };
    const graph = async () => JSON.parse((await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(workflow.id).first<{ graph: string }>())!.graph);

    const createSession = "automation-node-create";
    const trigger = await (await mutation(`/api/automation/workflow/${workflow.id}/nodes/`, createSession, "POST", {
      type: "http_trigger",
      label: "Trigger",
    })).json() as any;
    await action("undo", createSession, "create_automation_node");
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(trigger.id).first<any>()).toEqual({ trashed: 1 });
    expect((await graph())["0"]).toBeUndefined();
    await action("redo", createSession, "create_automation_node");
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(trigger.id).first<any>()).toEqual({ trashed: 0 });
    expect((await graph())["0"]).toBe(trigger.id);

    const updateSession = "automation-node-update";
    expect((await mutation(`/api/automation/node/${trigger.id}/`, updateSession, "PATCH", { label: "Updated trigger" })).status).toBe(200);
    await action("undo", updateSession, "update_automation_node");
    expect(await db.prepare("SELECT label FROM automation_node WHERE id=?").bind(trigger.id).first<any>()).toEqual({ label: "Trigger" });
    await action("redo", updateSession, "update_automation_node");
    expect(await db.prepare("SELECT label FROM automation_node WHERE id=?").bind(trigger.id).first<any>()).toEqual({ label: "Updated trigger" });

    const first = await (await mutation(`/api/automation/workflow/${workflow.id}/nodes/`, "setup-first", "POST", {
      type: "http_request",
      label: "First",
      reference_node_id: trigger.id,
    })).json() as any;
    const second = await (await mutation(`/api/automation/workflow/${workflow.id}/nodes/`, "setup-second", "POST", {
      type: "http_request",
      label: "Second",
      reference_node_id: first.id,
    })).json() as any;

    const moveSession = "automation-node-move";
    const graphBeforeMove = await graph();
    expect((await mutation(`/api/automation/node/${second.id}/move/`, moveSession, "POST", {
      reference_node_id: trigger.id,
      position: "south",
      output: "",
    })).status).toBe(202);
    const graphAfterMove = await graph();
    expect(graphAfterMove[String(trigger.id)].next[""]).toEqual([second.id]);
    await action("undo", moveSession, "move_automation_node");
    expect(await graph()).toEqual(graphBeforeMove);
    await action("redo", moveSession, "move_automation_node");
    expect(await graph()).toEqual(graphAfterMove);

    const duplicateSession = "automation-node-duplicate";
    const duplicated = await (await mutation(`/api/automation/node/${first.id}/duplicate/`, duplicateSession, "POST")).json() as any;
    expect(duplicated.id).not.toBe(first.id);
    await action("undo", duplicateSession, "duplicate_automation_node");
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(duplicated.id).first<any>()).toEqual({ trashed: 1 });
    await action("redo", duplicateSession, "duplicate_automation_node");
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(duplicated.id).first<any>()).toEqual({ trashed: 0 });

    const replaceSession = "automation-node-replace";
    const replaced = await (await mutation(`/api/automation/node/${duplicated.id}/replace/`, replaceSession, "POST", {
      new_type: "smtp_email",
    })).json() as any;
    expect(replaced.type).toBe("smtp_email");
    await action("undo", replaceSession, "replace_automation_node");
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(duplicated.id).first<any>()).toEqual({ trashed: 0 });
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(replaced.id).first<any>()).toEqual({ trashed: 1 });
    await action("redo", replaceSession, "replace_automation_node");
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(duplicated.id).first<any>()).toEqual({ trashed: 1 });
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(replaced.id).first<any>()).toEqual({ trashed: 0 });

    const deleteSession = "automation-node-delete";
    expect((await mutation(`/api/automation/node/${replaced.id}/`, deleteSession, "DELETE")).status).toBe(204);
    await action("undo", deleteSession, "delete_automation_node");
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(replaced.id).first<any>()).toEqual({ trashed: 0 });
    await action("redo", deleteSession, "delete_automation_node");
    expect(await db.prepare("SELECT trashed FROM automation_node WHERE id=?").bind(replaced.id).first<any>()).toEqual({ trashed: 1 });
    expect(await db.prepare(
      "SELECT id FROM core_trasheditem WHERE trash_item_type='automation_node' AND trash_item_id=?"
    ).bind(replaced.id).first<any>()).toBeTruthy();
  });

  it("undoes and redoes every automation workflow mutation in the application scope", async () => {
    const { db, env, token, ctx, queueMessages } = await setupAutomationFixture();
    const app = await (await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Workflow undo redo", type: "automation" }),
    })).json() as any;
    const defaultWorkflow = app.workflows[0];
    const mutation = (path: string, session: string, method: string, body?: unknown) => api(env, ctx, token, path, {
      method,
      headers: { ClientSessionId: session },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const action = async (direction: "undo" | "redo", session: string, actionType: string) => {
      const response = await mutation(`/api/user/${direction}/`, session, "PATCH", {
        scopes: { application: app.id },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result_code: "SUCCESS",
        actions: [{ action_type: actionType, action_scope: `application${app.id}` }],
      });
    };
    const activeWorkflowIds = async () => (await db.prepare(
      `SELECT id FROM automation_workflow
       WHERE automation_id=? AND trashed=0 AND COALESCE(is_published_version, 0)=0
       ORDER BY [order] ASC, id ASC`
    ).bind(app.id).all<{ id: number }>()).results.map((row) => Number(row.id));

    const createSession = "automation-workflow-create";
    const created = await (await mutation(`/api/automation/${app.id}/workflows/`, createSession, "POST", {
      name: "Editable workflow",
    })).json() as any;
    await action("undo", createSession, "create_automation_workflow");
    expect(await db.prepare("SELECT trashed FROM automation_workflow WHERE id=?").bind(created.id).first<any>()).toEqual({ trashed: 1 });
    await action("redo", createSession, "create_automation_workflow");
    expect(await db.prepare("SELECT trashed FROM automation_workflow WHERE id=?").bind(created.id).first<any>()).toEqual({ trashed: 0 });

    const publishJob = await (await api(
      env,
      ctx,
      token,
      `/api/automation/workflows/${created.id}/publish/async/`,
      { method: "POST" },
    )).json() as any;
    await runNextQueuedJob(env, queueMessages);
    const completedPublish = await (await api(env, ctx, token, `/api/jobs/${publishJob.id}/`)).json() as any;
    const publishedWorkflowId = Number(completedPublish.published_automation_workflow_id);
    expect(await db.prepare("SELECT state FROM automation_workflow WHERE id=?").bind(publishedWorkflowId).first<any>())
      .toEqual({ state: "live" });

    const updateSession = "automation-workflow-update";
    expect((await mutation(`/api/automation/workflows/${created.id}/`, updateSession, "PATCH", {
      name: "Renamed workflow",
      state: "paused",
    })).status).toBe(200);
    expect(await db.prepare("SELECT state FROM automation_workflow WHERE id=?").bind(publishedWorkflowId).first<any>())
      .toEqual({ state: "paused" });
    await action("undo", updateSession, "update_automation_workflow");
    expect(await db.prepare("SELECT name FROM automation_workflow WHERE id=?").bind(created.id).first<any>())
      .toEqual({ name: "Editable workflow" });
    expect(await db.prepare("SELECT state FROM automation_workflow WHERE id=?").bind(publishedWorkflowId).first<any>())
      .toEqual({ state: "live" });
    await action("redo", updateSession, "update_automation_workflow");
    expect(await db.prepare("SELECT name FROM automation_workflow WHERE id=?").bind(created.id).first<any>())
      .toEqual({ name: "Renamed workflow" });
    expect(await db.prepare("SELECT state FROM automation_workflow WHERE id=?").bind(publishedWorkflowId).first<any>())
      .toEqual({ state: "paused" });

    const orderSession = "automation-workflow-order";
    const beforeOrder = await activeWorkflowIds();
    expect((await mutation(`/api/automation/${app.id}/workflows/order/`, orderSession, "POST", {
      workflow_ids: [created.id, defaultWorkflow.id],
    })).status).toBe(204);
    expect(await activeWorkflowIds()).toEqual([created.id, defaultWorkflow.id]);
    await action("undo", orderSession, "order_automation_workflows");
    expect(await activeWorkflowIds()).toEqual(beforeOrder);
    await action("redo", orderSession, "order_automation_workflows");
    expect(await activeWorkflowIds()).toEqual([created.id, defaultWorkflow.id]);

    const duplicateSession = "automation-workflow-duplicate";
    const startedDuplicate = await (await mutation(
      `/api/automation/workflows/${created.id}/duplicate/async/`,
      duplicateSession,
      "POST",
    )).json() as any;
    await runNextQueuedJob(env, queueMessages);
    const duplicateJob = await (await api(env, ctx, token, `/api/jobs/${startedDuplicate.id}/`)).json() as any;
    const duplicatedId = Number(duplicateJob.automation_workflow_id);
    expect(duplicatedId).not.toBe(created.id);
    await action("undo", duplicateSession, "duplicate_automation_workflow");
    expect(await db.prepare("SELECT trashed FROM automation_workflow WHERE id=?").bind(duplicatedId).first<any>())
      .toEqual({ trashed: 1 });
    await action("redo", duplicateSession, "duplicate_automation_workflow");
    expect(await db.prepare("SELECT trashed FROM automation_workflow WHERE id=?").bind(duplicatedId).first<any>())
      .toEqual({ trashed: 0 });

    const deleteSession = "automation-workflow-delete";
    expect((await mutation(`/api/automation/workflows/${created.id}/`, deleteSession, "DELETE")).status).toBe(204);
    await action("undo", deleteSession, "delete_automation_workflow");
    expect(await db.prepare("SELECT trashed FROM automation_workflow WHERE id=?").bind(created.id).first<any>())
      .toEqual({ trashed: 0 });
    expect(await db.prepare("SELECT id FROM automation_workflow WHERE id=?").bind(publishedWorkflowId).first<any>())
      .toBeNull();
    await action("redo", deleteSession, "delete_automation_workflow");
    expect(await db.prepare("SELECT trashed FROM automation_workflow WHERE id=?").bind(created.id).first<any>())
      .toEqual({ trashed: 1 });
    expect(await db.prepare(
      "SELECT id FROM core_trasheditem WHERE trash_item_type='automation_workflow' AND trash_item_id=?"
    ).bind(created.id).first<any>()).toBeTruthy();
  });

  it("enforces Baserow workflow graph invariants and error contracts", async () => {
    const { env, token, ctx } = await setupAutomationFixture();
    const appResponse = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Graph invariants", type: "automation" }),
    });
    expect(appResponse.status).toBe(200);
    const app = await appResponse.json() as any;
    const workflow = app.workflows[0];

    const actionFirst = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_request" }),
    });
    expect(actionFirst.status).toBe(400);
    expect(await actionFirst.json()).toMatchObject({ error: "ERROR_AUTOMATION_FIRST_NODE_MUST_BE_TRIGGER" });

    const unknown = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "unknown_node" }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });

    for (const payload of [
      { type: 12 },
      { type: "http_trigger", position: "west" },
      { type: "http_trigger", output: [] },
    ]) {
      const invalidCreate = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      expect(invalidCreate.status).toBe(400);
      expect(await invalidCreate.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });
    }

    const triggerResponse = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger" }),
    });
    expect(triggerResponse.status).toBe(200);
    const trigger = await triggerResponse.json() as any;

    const duplicateTrigger = await api(env, ctx, token, `/api/automation/node/${trigger.id}/duplicate/`, { method: "POST" });
    expect(duplicateTrigger.status).toBe(400);
    expect(await duplicateTrigger.json()).toEqual({
      error: "ERROR_AUTOMATION_TRIGGER_ALREADY_EXISTS",
      detail: "This workflow already has a trigger",
    });

    for (const [payload, detail] of [
      [{ label: "x".repeat(76) }, "no more than 75"],
      [{ label: null }, "Not a valid string"],
      [{ service: [] }, "Expected an object"],
    ] as const) {
      const invalidUpdate = await api(env, ctx, token, `/api/automation/node/${trigger.id}/`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      expect(invalidUpdate.status).toBe(400);
      const invalidUpdateBody = await invalidUpdate.json() as any;
      expect(invalidUpdateBody).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });
      expect(String(invalidUpdateBody.detail)).toContain(detail);
    }

    const iteratorResponse = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "iterator", reference_node_id: trigger.id }),
    });
    expect(iteratorResponse.status).toBe(200);
    const iterator = await iteratorResponse.json() as any;

    const invalidChild = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_request", reference_node_id: trigger.id, position: "child" }),
    });
    expect(invalidChild.status).toBe(400);
    expect(await invalidChild.json()).toMatchObject({ error: "ERROR_AUTOMATION_NODE_REFERENCE_NODE_INVALID" });

    const childResponse = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_request", reference_node_id: iterator.id, position: "child" }),
    });
    expect(childResponse.status).toBe(200);
    const child = await childResponse.json() as any;

    const deleteTrigger = await api(env, ctx, token, `/api/automation/node/${trigger.id}/`, { method: "DELETE" });
    expect(deleteTrigger.status).toBe(400);
    expect(await deleteTrigger.json()).toMatchObject({ error: "ERROR_AUTOMATION_NODE_NOT_DELETABLE" });

    const deleteIterator = await api(env, ctx, token, `/api/automation/node/${iterator.id}/`, { method: "DELETE" });
    expect(deleteIterator.status).toBe(400);
    expect(await deleteIterator.json()).toMatchObject({ error: "ERROR_AUTOMATION_NODE_NOT_DELETABLE" });

    const replaceIterator = await api(env, ctx, token, `/api/automation/node/${iterator.id}/replace/`, {
      method: "POST",
      body: JSON.stringify({ new_type: "http_request" }),
    });
    expect(replaceIterator.status).toBe(400);
    expect(await replaceIterator.json()).toMatchObject({ error: "ERROR_AUTOMATION_NODE_NOT_REPLACEABLE" });

    const moveIteratorIntoChild = await api(env, ctx, token, `/api/automation/node/${iterator.id}/move/`, {
      method: "POST",
      body: JSON.stringify({ reference_node_id: child.id, position: "south", output: "" }),
    });
    expect(moveIteratorIntoChild.status).toBe(400);
    expect(await moveIteratorIntoChild.json()).toMatchObject({ error: "ERROR_AUTOMATION_NODE_NOT_MOVABLE" });

    const routerWorkflowResponse = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
      method: "POST",
      body: JSON.stringify({ name: "Router invariants" }),
    });
    expect(routerWorkflowResponse.status).toBe(200);
    const routerWorkflow = await routerWorkflowResponse.json() as any;
    const routerTriggerResponse = await api(env, ctx, token, `/api/automation/workflow/${routerWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger" }),
    });
    const routerTrigger = await routerTriggerResponse.json() as any;
    const edgeUid = crypto.randomUUID();
    const routerResponse = await api(env, ctx, token, `/api/automation/workflow/${routerWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "router",
        reference_node_id: routerTrigger.id,
        service: { edges: [{ uid: edgeUid, label: "Branch", condition: { formula: "true" } }] },
      }),
    });
    expect(routerResponse.status).toBe(200);
    const router = await routerResponse.json() as any;

    const missingOutput = await api(env, ctx, token, `/api/automation/workflow/${routerWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_request", reference_node_id: router.id, output: "missing-edge" }),
    });
    expect(missingOutput.status).toBe(400);
    expect(await missingOutput.json()).toMatchObject({ error: "ERROR_AUTOMATION_NODE_REFERENCE_NODE_INVALID" });

    const branchResponse = await api(env, ctx, token, `/api/automation/workflow/${routerWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_request", reference_node_id: router.id, output: edgeUid }),
    });
    expect(branchResponse.status).toBe(200);
    const branch = await branchResponse.json() as any;

    const routerUpdate = await api(env, ctx, token, `/api/automation/node/${router.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ service: { edges: [] } }),
    });
    expect(routerUpdate.status).toBe(400);
    expect(await routerUpdate.json()).toMatchObject({ error: "ERROR_AUTOMATION_NODE_MISCONFIGURED_SERVICE" });

    for (const [method, path, body, expectedError] of [
      ["DELETE", `/api/automation/node/${router.id}/`, undefined, "ERROR_AUTOMATION_NODE_NOT_DELETABLE"],
      ["POST", `/api/automation/node/${router.id}/replace/`, { new_type: "http_request" }, "ERROR_AUTOMATION_NODE_NOT_REPLACEABLE"],
      ["POST", `/api/automation/node/${router.id}/move/`, { reference_node_id: routerTrigger.id, position: "south", output: "" }, "ERROR_AUTOMATION_NODE_NOT_MOVABLE"],
    ] as const) {
      const response = await api(env, ctx, token, path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expectedError });
    }

    expect((await api(env, ctx, token, `/api/automation/node/${branch.id}/`, { method: "DELETE" })).status).toBe(204);
    const detachedRouterUpdate = await api(env, ctx, token, `/api/automation/node/${router.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ service: { edges: [] } }),
    });
    expect(detachedRouterUpdate.status).toBe(200);
    const restoreRemovedBranch = await api(env, ctx, token, `/api/trash/automation_node/${branch.id}/restore/`, {
      method: "PATCH",
    });
    expect(restoreRemovedBranch.status).toBe(400);
    expect(await restoreRemovedBranch.json()).toMatchObject({
      detail: "This automation node cannot be restored as its branch has been deleted.",
    });
  });

  it("runs only the published table trigger and claims periodic executions once", async () => {
    const { db, env, token, ctx, queueMessages } = await setupAutomationFixture();
    const appCreate = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Automation", type: "automation" }),
    });
    expect(appCreate.status).toBe(200);
    const app = await appCreate.json() as any;

    const rowWorkflow = app.workflows[0];
    const rowTriggerResponse = await api(env, ctx, token, `/api/automation/workflow/${rowWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "local_baserow_rows_created",
        label: "Rows created",
        service: { table_id: 20 },
      }),
    });
    expect(rowTriggerResponse.status).toBe(200);
    const publishRows = await api(env, ctx, token, `/api/automation/workflows/${rowWorkflow.id}/publish/async/`, { method: "POST" });
    expect(publishRows.status).toBe(202);
    await runNextQueuedJob(env, queueMessages);

    const rowRuns = await triggerAutomationTableWorkflows(env, 20, "rows.created", {
      items: [{ id: 1, field_30: "Ada" }],
    });
    expect(rowRuns).toHaveLength(1);
    const originalRowHistory = await db.prepare(
      "SELECT COUNT(*) AS count FROM automation_workflow_history WHERE workflow_id=?"
    ).bind(rowWorkflow.id).first<{ count: number }>();
    expect(originalRowHistory?.count).toBe(1);

    const periodicWorkflowResponse = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
      method: "POST",
      body: JSON.stringify({ name: "Periodic workflow" }),
    });
    expect(periodicWorkflowResponse.status).toBe(200);
    const periodicWorkflow = await periodicWorkflowResponse.json() as any;
    const periodicTriggerResponse = await api(env, ctx, token, `/api/automation/workflow/${periodicWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "periodic",
        label: "Every minute",
        service: { interval: "MINUTE", minute: 1 },
      }),
    });
    expect(periodicTriggerResponse.status).toBe(200);
    const publishPeriodic = await api(env, ctx, token, `/api/automation/workflows/${periodicWorkflow.id}/publish/async/`, { method: "POST" });
    expect(publishPeriodic.status).toBe(202);
    await runNextQueuedJob(env, queueMessages);

    const now = new Date("2026-07-11T12:00:00.000Z");
    const concurrentRuns = await Promise.all([
      triggerDuePeriodicAutomationWorkflows(env, now),
      triggerDuePeriodicAutomationWorkflows(env, now),
    ]);
    expect(concurrentRuns.flat()).toHaveLength(1);
    const periodicHistory = await db.prepare(
      "SELECT COUNT(*) AS count FROM automation_workflow_history WHERE workflow_id=?"
    ).bind(periodicWorkflow.id).first<{ count: number }>();
    expect(periodicHistory?.count).toBe(1);
  });

  it("clears old workflow history in D1-safe batches", async () => {
    const { db, env, token, ctx, queueMessages } = await setupAutomationFixture();

    const appCreate = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Automation", type: "automation" }),
    });
    expect(appCreate.status).toBe(200);
    const app = await appCreate.json() as any;
    const workflow = app.workflows[0];

    const triggerCreate = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger", label: "Webhook" }),
    });
    expect(triggerCreate.status).toBe(200);
    const trigger = await triggerCreate.json() as any;

    const oldStartedOn = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const oldHistoryIds = Array.from({ length: 130 }, (_, index) => 1000 + index);
    for (const historyId of oldHistoryIds) {
      await db.prepare(
        `INSERT INTO automation_workflow_history
         (id, workflow_id, started_on, completed_on, is_test_run, message, status, event_payload, simulate_until_node_id)
         VALUES (?, ?, ?, ?, 0, '', 'success', '{}', NULL)`
      ).bind(historyId, workflow.id, oldStartedOn, oldStartedOn).run();
      await db.prepare(
        `INSERT INTO automation_node_history
         (workflow_history_id, node_id, started_on, completed_on, status, message, input, output)
         VALUES (?, ?, ?, ?, 'success', '', '{}', '{}')`
      ).bind(historyId, trigger.id, oldStartedOn, oldStartedOn).run();
    }

    const deleteBatchSizes: number[] = [];
    env.DB = {
      database: db.database,
      batch: db.batch.bind(db),
      prepare(sql: string) {
        if (sql.includes("DELETE FROM automation_node_history") || sql.includes("DELETE FROM automation_workflow_history")) {
          const bindCount = (sql.match(/\?/g) || []).length;
          deleteBatchSizes.push(bindCount);
          if (bindCount > 100) throw new Error("D1 statement too long");
        }
        return db.prepare(sql);
      },
    };

    const result = await startWorkflow(env, workflow.id, { ok: true }, true);
    expect(result.status).toBe("success");
    expect(deleteBatchSizes.length).toBeGreaterThan(2);
    expect(Math.max(...deleteBatchSizes)).toBeLessThanOrEqual(90);

    const remainingOld = await db.prepare(
      `SELECT COUNT(*) AS count FROM automation_workflow_history
       WHERE id >= 1000 AND id < 1130`
    ).first<{ count: number }>();
    expect(remainingOld?.count).toBe(0);
  });

  it("creates Baserow default service objects for automation node service types", async () => {
    const { db, env, token, ctx } = await setupAutomationFixture();

    const appCreate = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Automation", type: "automation" }),
    });
    expect(appCreate.status).toBe(200);
    const app = await appCreate.json() as any;
    const defaultIntegrationId = app.integrations.find((integration: any) => integration.type === "local_baserow")?.id;
    expect(defaultIntegrationId).toBeTruthy();

    async function createWorkflow(name: string) {
      const response = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    }

    const triggerExpectations: Record<string, (node: any) => void> = {
      http_trigger(node) {
        expect(node.service).toMatchObject({
          type: "http_trigger",
          integration_id: null,
          exclude_get: false,
          is_public: true,
        });
        expect(typeof node.service.uid).toBe("string");
        expect(node.service.schema.properties.raw_body.title).toBe("Raw body");
      },
      periodic(node) {
        expect(node.service).toMatchObject({
          type: "periodic",
          integration_id: null,
          interval: "HOUR",
          minute: 0,
          hour: 0,
          day_of_week: 0,
          day_of_month: 1,
        });
        expect(node.service.schema.properties.triggered_at.title).toBe("Triggered at");
      },
      local_baserow_rows_created(node) {
        expect(node.service).toMatchObject({ type: "local_baserow_rows_created", integration_id: defaultIntegrationId, table_id: null });
      },
      local_baserow_rows_updated(node) {
        expect(node.service).toMatchObject({ type: "local_baserow_rows_updated", integration_id: defaultIntegrationId, table_id: null });
      },
      local_baserow_rows_deleted(node) {
        expect(node.service).toMatchObject({ type: "local_baserow_rows_deleted", integration_id: defaultIntegrationId, table_id: null });
      },
    };

    for (const [type, assertion] of Object.entries(triggerExpectations)) {
      const workflow = await createWorkflow(`Trigger ${type}`);
      const response = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
        method: "POST",
        body: JSON.stringify({ type }),
      });
      expect(response.status).toBe(200);
      assertion(await response.json());
    }

    const actionWorkflow = await createWorkflow("Action defaults");
    const triggerCreate = await api(env, ctx, token, `/api/automation/workflow/${actionWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger" }),
    });
    expect(triggerCreate.status).toBe(200);
    let previousNode = await triggerCreate.json() as any;

    async function createAction(type: string) {
      const response = await api(env, ctx, token, `/api/automation/workflow/${actionWorkflow.id}/nodes/`, {
        method: "POST",
        body: JSON.stringify({ type, reference_node_id: previousNode.id }),
      });
      expect(response.status).toBe(200);
      const node = await response.json() as any;
      previousNode = node;
      return node;
    }

    const createRow = await createAction("local_baserow_create_row");
    expect(createRow.service).toMatchObject({
      type: "local_baserow_upsert_row",
      integration_id: defaultIntegrationId,
      table_id: null,
      field_mappings: [],
    });
    expect(createRow.service.row_id).toMatchObject({ formula: "" });

    const updateRow = await createAction("local_baserow_update_row");
    expect(updateRow.service).toMatchObject({
      type: "local_baserow_upsert_row",
      integration_id: defaultIntegrationId,
      table_id: null,
      field_mappings: [],
    });

    const deleteRow = await createAction("local_baserow_delete_row");
    expect(deleteRow.service).toMatchObject({
      type: "local_baserow_delete_row",
      integration_id: defaultIntegrationId,
      table_id: null,
    });
    expect(deleteRow.service.row_id).toMatchObject({ formula: "" });

    const getRow = await createAction("local_baserow_get_row");
    expect(getRow.service).toMatchObject({
      type: "local_baserow_get_row",
      integration_id: defaultIntegrationId,
      table_id: null,
      view_id: null,
      filters: [],
      sortings: [],
      filter_type: "AND",
    });
    expect(getRow.service.row_id).toMatchObject({ formula: "" });

    const listRows = await createAction("local_baserow_list_rows");
    expect(listRows.service).toMatchObject({
      type: "local_baserow_list_rows",
      integration_id: defaultIntegrationId,
      table_id: null,
      view_id: null,
      filters: [],
      sortings: [],
      filter_type: "AND",
      default_result_count: 20,
    });

    const aggregateRows = await createAction("local_baserow_aggregate_rows");
    expect(aggregateRows.service).toMatchObject({
      type: "local_baserow_aggregate_rows",
      integration_id: defaultIntegrationId,
      table_id: null,
      field_id: null,
      aggregation_type: "",
      filters: [],
      filter_type: "AND",
    });

    const httpRequest = await createAction("http_request");
    expect(httpRequest.service).toMatchObject({
      type: "http_request",
      http_method: "GET",
      headers: [],
      query_params: [],
      form_data: [],
      body_type: "none",
      timeout: 30,
    });
    expect(httpRequest.service.url).toMatchObject({ formula: "" });
    expect(httpRequest.service.schema.properties.status_code.title).toBe("Status code");

    const smtpEmail = await createAction("smtp_email");
    expect(smtpEmail.service).toMatchObject({
      type: "smtp_email",
      integration_id: null,
      body_type: "plain",
    });
    expect(smtpEmail.service.from_email).toMatchObject({ formula: "" });
    expect(smtpEmail.service.to_emails).toMatchObject({ formula: "" });
    expect(smtpEmail.service.schema.properties.success.type).toBe("boolean");

    const router = await createAction("router");
    expect(router.service).toMatchObject({
      type: "router",
      integration_id: null,
      default_edge_label: "",
    });
    expect(router.service.edges[0]).toMatchObject({ label: "Branch", condition: { formula: "" } });
    expect(router.service.schema.properties.edge.properties.label.title).toBe("Label");

    const iterator = await createAction("iterator");
    expect(iterator.service).toMatchObject({
      type: "iterator",
      integration_id: null,
      source: { formula: "" },
      schema: null,
    });

    const aiAgent = await createAction("ai_agent");
    expect(aiAgent.service).toMatchObject({
      type: "ai_agent",
      integration_id: null,
      ai_generative_ai_type: null,
      ai_generative_ai_model: null,
      ai_output_type: "text",
      ai_temperature: null,
      ai_choices: [],
    });
    expect(aiAgent.service.ai_prompt).toMatchObject({ formula: "" });
    expect(aiAgent.service.schema.properties.result.title).toBe("AI Response");

    const removedSlack = await api(env, ctx, token, `/api/automation/workflow/${actionWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "slack_write_message", reference_node_id: aiAgent.id }),
    });
    expect(removedSlack.status).toBe(400);

    const replace = await api(env, ctx, token, `/api/automation/node/${createRow.id}/replace/`, {
      method: "POST",
      body: JSON.stringify({ new_type: "ai_agent" }),
    });
    expect(replace.status).toBe(200);
    const replaced = await replace.json() as any;
    expect(replaced.id).not.toBe(createRow.id);
    expect(replaced.type).toBe("ai_agent");
    expect(replaced.service).toMatchObject({ type: "ai_agent", ai_output_type: "text", ai_prompt: { formula: "" } });
    expect(replaced.service).not.toHaveProperty("field_mappings");
    expect(replaced.service).not.toHaveProperty("table_id");
    const nodesAfterReplace = await api(env, ctx, token, `/api/automation/workflow/${actionWorkflow.id}/nodes/`);
    expect(nodesAfterReplace.status).toBe(200);
    const listedNodes = await nodesAfterReplace.json() as any[];
    expect(listedNodes.some((node) => node.id === createRow.id)).toBe(false);
    expect(listedNodes.some((node) => node.id === replaced.id && node.type === "ai_agent")).toBe(true);
    const storedWorkflow = await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(actionWorkflow.id)
      .first<{ graph: string }>();
    const storedGraph = JSON.parse(storedWorkflow!.graph);
    expect(storedGraph[String(createRow.id)]).toBeUndefined();
    expect(storedGraph[String(replaced.id)]).toBeDefined();
  });

  it("validates and normalizes every active automation service contract", async () => {
    const { db, env, token, ctx } = await setupAutomationFixture();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO database_field
       (id, table_id, name, type, [order], [primary], read_only, trashed, field_settings, created_on, updated_on)
       VALUES
       (31, 20, 'Amount', 'number', 2, 0, 0, 0, '{"number_decimal_places": 2}', ?, ?),
       (32, 20, 'Due', 'date', 3, 0, 0, 0, '{}', ?, ?),
       (33, 20, 'Active', 'boolean', 4, 0, 0, 0, '{}', ?, ?)`
    ).bind(now, now, now, now, now, now).run();
    await addFieldColumn(db as any, 20, { id: 31, type: "number", primary: false });
    await addFieldColumn(db as any, 20, { id: 32, type: "date", primary: false });
    await addFieldColumn(db as any, 20, { id: 33, type: "boolean", primary: false });
    await db.prepare(
      `INSERT INTO database_view
       (id, table_id, name, type, [order], filter_type, created_on, updated_on)
       VALUES (40, 20, 'Grid', 'grid', 1, 'AND', ?, ?)`
    ).bind(now, now).run();

    const appResponse = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Validated services", type: "automation" }),
    });
    expect(appResponse.status).toBe(200);
    const app = await appResponse.json() as any;

    async function workflow(name: string) {
      const response = await api(env, ctx, token, `/api/automation/${app.id}/workflows/`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    }

    async function expectServiceError(nodeId: number, service: any, error = "ERROR_REQUEST_BODY_VALIDATION") {
      const response = await api(env, ctx, token, `/api/automation/node/${nodeId}/`, {
        method: "PATCH",
        body: JSON.stringify({ service }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error });
    }

    const triggerWorkflow = app.workflows[0];
    const badTrigger = await api(env, ctx, token, `/api/automation/workflow/${triggerWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger", service: { uid: "not-a-uuid" } }),
    });
    expect(badTrigger.status).toBe(400);
    expect(await badTrigger.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });
    const triggerResponse = await api(env, ctx, token, `/api/automation/workflow/${triggerWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "http_trigger",
        service: { uid: crypto.randomUUID(), exclude_get: true, is_public: false },
      }),
    });
    expect(triggerResponse.status).toBe(200);
    const trigger = await triggerResponse.json() as any;
    expect(trigger.service).toMatchObject({ exclude_get: true, is_public: false });
    await expectServiceError(trigger.id, { uid: "still-not-a-uuid" });
    await expectServiceError(trigger.id, { exclude_get: "true" });

    const legacyService = { ...trigger.service, uid: "legacy-webhook-identifier" };
    delete legacyService.schema;
    delete legacyService.context_data;
    delete legacyService.context_data_schema;
    await db.prepare("UPDATE automation_node SET service=? WHERE id=?")
      .bind(JSON.stringify(legacyService), trigger.id)
      .run();
    const legacyLabelPatch = await api(env, ctx, token, `/api/automation/node/${trigger.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ label: "Legacy compatible" }),
    });
    expect(legacyLabelPatch.status).toBe(200);
    expect((await legacyLabelPatch.json() as any).service.uid).toBe("legacy-webhook-identifier");

    const periodicWorkflow = await workflow("Periodic validation");
    const invalidPeriodic = await api(env, ctx, token, `/api/automation/workflow/${periodicWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "periodic", service: { interval: "YEAR" } }),
    });
    expect(invalidPeriodic.status).toBe(400);
    expect(await invalidPeriodic.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });
    const periodicResponse = await api(env, ctx, token, `/api/automation/workflow/${periodicWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "periodic", service: { interval: "minute", minute: 1 } }),
    });
    expect(periodicResponse.status).toBe(200);
    const periodic = await periodicResponse.json() as any;
    expect(periodic.service).toMatchObject({ interval: "MINUTE", minute: 1 });
    await expectServiceError(periodic.id, { minute: 0 }, "ERROR_AUTOMATION_NODE_MISCONFIGURED_SERVICE");
    await expectServiceError(periodic.id, { hour: 24 });
    await expectServiceError(periodic.id, { day_of_week: 7 });
    await expectServiceError(periodic.id, { day_of_month: 0 });

    for (const type of ["local_baserow_rows_created", "local_baserow_rows_updated", "local_baserow_rows_deleted"]) {
      const rowWorkflow = await workflow(`Validate ${type}`);
      const response = await api(env, ctx, token, `/api/automation/workflow/${rowWorkflow.id}/nodes/`, {
        method: "POST",
        body: JSON.stringify({ type, service: { table_id: 20 } }),
      });
      expect(response.status).toBe(200);
      const node = await response.json() as any;
      expect(node.service.table_id).toBe(20);
      await expectServiceError(node.id, { table_id: 999999 });
    }

    const actionWorkflow = await workflow("Action validation");
    const actionTriggerResponse = await api(env, ctx, token, `/api/automation/workflow/${actionWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({ type: "http_trigger" }),
    });
    expect(actionTriggerResponse.status).toBe(200);
    let previous = await actionTriggerResponse.json() as any;

    async function createAction(type: string, service: any) {
      const response = await api(env, ctx, token, `/api/automation/workflow/${actionWorkflow.id}/nodes/`, {
        method: "POST",
        body: JSON.stringify({ type, reference_node_id: previous.id, service }),
      });
      expect(response.status).toBe(200);
      const node = await response.json() as any;
      previous = node;
      return node;
    }
    const rawFormula = (formula: string) => ({ formula, mode: "raw" });

    const http = await createAction("http_request", {
      http_method: "post",
      url: rawFormula("https://example.test/hook"),
      body_type: "json",
      body_content: rawFormula("{}"),
      timeout: 15,
      headers: [{ key: "Content-Type", value: rawFormula("application/json") }],
      query_params: [{ key: "page", value: 1 }],
      form_data: [{ key: "user.name", value: rawFormula("Ada") }],
    });
    expect(http.service).toMatchObject({ http_method: "POST", body_type: "json", timeout: 15 });
    expect(http.service.url).toMatchObject({ formula: "https://example.test/hook", mode: "raw", version: "0.1" });
    expect(http.service.query_params[0].value).toMatchObject({ formula: "1" });
    const storedHttpBefore = await db.prepare("SELECT service FROM automation_node WHERE id=?")
      .bind(http.id).first<{ service: string }>();
    const actionsBefore = await db.prepare("SELECT COUNT(*) AS count FROM core_action").first<{ count: number }>();
    await expectServiceError(http.id, { http_method: "TRACE" });
    expect((await db.prepare("SELECT service FROM automation_node WHERE id=?").bind(http.id).first<{ service: string }>())?.service)
      .toBe(storedHttpBefore?.service);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM core_action").first<{ count: number }>())?.count)
      .toBe(actionsBefore?.count);
    await expectServiceError(http.id, { body_type: "xml" });
    await expectServiceError(http.id, { timeout: 0 });
    await expectServiceError(http.id, { url: { formula: "concat(" } });
    await expectServiceError(http.id, { headers: [{ key: "_invalid", value: "x" }] });
    await expectServiceError(http.id, { form_data: [{ key: "invalid key", value: "x" }] });
    await expectServiceError(http.id, { query_params: {} });

    const smtp = await createAction("smtp_email", {
      body_type: "html",
      from_email: rawFormula("sender@example.test"),
      to_emails: rawFormula("recipient@example.test"),
      subject: rawFormula("Subject"),
      body: rawFormula("<p>Body</p>"),
    });
    expect(smtp.service).toMatchObject({ body_type: "html", from_email: { formula: "sender@example.test" } });
    await expectServiceError(smtp.id, { body_type: "markdown" });
    await expectServiceError(smtp.id, { integration_id: 999999 });

    await db.prepare(
      `INSERT INTO core_integration
       (id, application_id, type, name, [order], configuration, created_on, updated_on)
       VALUES (90, ?, 'ai', 'AI models', '20000', ?, ?, ?)`
    ).bind(
      app.id,
      JSON.stringify({ ai_settings: { openai: { api_key: "test", models: ["gpt-4.1-mini"] } } }),
      now,
      now,
    ).run();
    const ai = await createAction("ai_agent", {
      integration_id: 90,
      ai_generative_ai_type: "openai",
      ai_generative_ai_model: "gpt-4.1-mini",
      ai_output_type: "choice",
      ai_temperature: 0.4,
      ai_prompt: rawFormula("Choose"),
      ai_choices: ["yes", "no"],
    });
    expect(ai.service).toMatchObject({
      ai_generative_ai_type: "openai",
      ai_output_type: "choice",
      ai_temperature: 0.4,
      ai_choices: ["yes", "no"],
    });
    await expectServiceError(ai.id, { ai_generative_ai_type: "unknown" });
    await expectServiceError(ai.id, { ai_output_type: "json" });
    await expectServiceError(ai.id, { ai_temperature: 2.1 });
    await expectServiceError(ai.id, { ai_choices: ["yes", 1] });
    await expectServiceError(ai.id, { ai_generative_ai_model: "gpt-not-enabled" });
    await expectServiceError(ai.id, { integration_id: 999999 });

    env.CACHE.get = vi.fn(async (key: string) => key === "workspace:1:generative-ai"
      ? JSON.stringify({ anthropic: { api_key: "workspace-key", models: ["workspace-claude"] } })
      : null);
    await db.prepare(
      `INSERT INTO core_integration
       (id, application_id, type, name, [order], configuration, created_on, updated_on)
       VALUES (91, ?, 'ai', 'Workspace AI models', '30000', ?, ?, ?),
              (92, ?, 'ai', 'Explicit empty override', '40000', ?, ?, ?)`
    ).bind(
      app.id,
      JSON.stringify({ ai_settings: {} }),
      now,
      now,
      app.id,
      JSON.stringify({ ai_settings: { anthropic: { models: [] } } }),
      now,
      now,
    ).run();

    const workspaceAi = await createAction("ai_agent", {
      integration_id: 91,
      ai_generative_ai_type: "anthropic",
      ai_generative_ai_model: "workspace-claude",
      ai_output_type: "text",
      ai_prompt: rawFormula("Use workspace settings"),
    });
    expect(workspaceAi.service).toMatchObject({
      integration_id: 91,
      ai_generative_ai_type: "anthropic",
      ai_generative_ai_model: "workspace-claude",
    });
    expect(env.CACHE.get).toHaveBeenCalledWith("workspace:1:generative-ai");

    const workspaceAiStored = await db.prepare("SELECT service FROM automation_node WHERE id=?")
      .bind(workspaceAi.id).first<{ service: string }>();
    const workspaceAiActions = await db.prepare("SELECT COUNT(*) AS count FROM core_action").first<{ count: number }>();
    await expectServiceError(workspaceAi.id, { ai_generative_ai_model: "workspace-model-not-enabled" });
    expect((await db.prepare("SELECT service FROM automation_node WHERE id=?")
      .bind(workspaceAi.id).first<{ service: string }>())?.service).toBe(workspaceAiStored?.service);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM core_action").first<{ count: number }>())?.count)
      .toBe(workspaceAiActions?.count);

    const nodesBeforeRejectedWorkspaceModel = await db.prepare(
      "SELECT COUNT(*) AS count FROM automation_node WHERE workflow_id=? AND trashed=0",
    ).bind(actionWorkflow.id).first<{ count: number }>();
    const graphBeforeRejectedWorkspaceModel = await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(actionWorkflow.id).first<{ graph: string }>();
    const rejectedWorkspaceModel = await api(env, ctx, token, `/api/automation/workflow/${actionWorkflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "ai_agent",
        reference_node_id: previous.id,
        service: {
          integration_id: 91,
          ai_generative_ai_type: "anthropic",
          ai_generative_ai_model: "workspace-model-not-enabled",
          ai_output_type: "text",
          ai_prompt: rawFormula("Rejected before insert"),
        },
      }),
    });
    expect(rejectedWorkspaceModel.status).toBe(400);
    expect(await rejectedWorkspaceModel.json()).toMatchObject({ error: "ERROR_REQUEST_BODY_VALIDATION" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM automation_node WHERE workflow_id=? AND trashed=0")
      .bind(actionWorkflow.id).first()).toEqual(nodesBeforeRejectedWorkspaceModel);
    expect(await db.prepare("SELECT graph FROM automation_workflow WHERE id=?")
      .bind(actionWorkflow.id).first()).toEqual(graphBeforeRejectedWorkspaceModel);

    const explicitEmptyOverride = await createAction("ai_agent", {
      integration_id: 92,
      ai_generative_ai_type: "anthropic",
      ai_generative_ai_model: "integration-allows-any-model",
      ai_output_type: "text",
      ai_prompt: rawFormula("Explicit provider override"),
    });
    expect(explicitEmptyOverride.service.ai_generative_ai_model).toBe("integration-allows-any-model");

    const iterator = await createAction("iterator", { source: { formula: "get('trigger.body.items')", mode: "advanced" } });
    expect(iterator.service.source).toMatchObject({ mode: "advanced", version: "0.1" });
    await expectServiceError(iterator.id, { source: { formula: "[]", mode: "invalid" } });
    await expectServiceError(iterator.id, { source: { formula: 1 } });

    const createRow = await createAction("local_baserow_create_row", {
      table_id: 20,
      field_mappings: [{ field_id: 30, enabled: true, value: rawFormula("Created") }],
    });
    expect(createRow.service.field_mappings[0]).toMatchObject({ field_id: 30, enabled: true, value: { formula: "Created" } });
    await expectServiceError(createRow.id, { field_mappings: [{ field_id: 999999, value: "x" }] });
    await expectServiceError(createRow.id, { field_mappings: [{ field_id: 30, enabled: "yes", value: "x" }] });
    await expectServiceError(createRow.id, { integration_id: 999999 });

    const updateRow = await createAction("local_baserow_update_row", {
      table_id: 20,
      row_id: 1,
      field_mappings: [{ field_id: 30, value: rawFormula("Updated") }],
    });
    expect(updateRow.service.row_id).toMatchObject({ formula: "1" });
    await expectServiceError(updateRow.id, { row_id: { formula: "1", mode: "unknown" } });

    const deleteRow = await createAction("local_baserow_delete_row", { table_id: 20, row_id: 1 });
    expect(deleteRow.service.row_id).toMatchObject({ formula: "1" });
    await expectServiceError(deleteRow.id, { table_id: 999999 });

    const getRow = await createAction("local_baserow_get_row", {
      table_id: 20,
      view_id: 40,
      row_id: 1,
      filter_type: "or",
      filters: [{ id: "01JTEST", field: 30, type: "contains", value: rawFormula("A"), value_is_formula: false }],
      sortings: [{ field: 30, order_by: "desc" }],
    });
    expect(getRow.service).toMatchObject({ table_id: 20, view_id: 40, filter_type: "OR" });
    expect(getRow.service.filters[0]).toMatchObject({ id: "01JTEST", field: 30, type: "contains", value_is_formula: false });
    expect(getRow.service.filters[0]).not.toHaveProperty("field_id");
    expect(getRow.service.sortings[0]).toMatchObject({ field: 30, order_by: "DESC" });
    await expectServiceError(getRow.id, { view_id: 999999 });
    await expectServiceError(getRow.id, { filter_type: "XOR" });
    await expectServiceError(getRow.id, { filters: [{ field: 999999, type: "equal", value: "" }] });
    await expectServiceError(getRow.id, { sortings: [{ field: 30, order_by: "SIDEWAYS" }] });

    const listRows = await createAction("local_baserow_list_rows", {
      table_id: 20,
      default_result_count: 0,
      search_query: rawFormula("Ada"),
    });
    expect(listRows.service).toMatchObject({ default_result_count: 0, search_query: { formula: "Ada" } });
    await expectServiceError(listRows.id, { default_result_count: -1 });
    await expectServiceError(listRows.id, { default_result_count: 1.5 });

    const aggregate = await createAction("local_baserow_aggregate_rows", {
      table_id: 20,
      field_id: 30,
      aggregation_type: "count",
    });
    expect(aggregate.service).toMatchObject({ field_id: 30, aggregation_type: "count" });
    await expectServiceError(aggregate.id, { field_id: 30, aggregation_type: "sum" });
    const numericAggregate = await api(env, ctx, token, `/api/automation/node/${aggregate.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ service: { field_id: 31, aggregation_type: "sum" } }),
    });
    expect(numericAggregate.status).toBe(200);
    expect(await numericAggregate.json()).toMatchObject({ service: { field_id: 31, aggregation_type: "sum" } });
    const dateAggregate = await api(env, ctx, token, `/api/automation/node/${aggregate.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ service: { field_id: 32, aggregation_type: "min_date" } }),
    });
    expect(dateAggregate.status).toBe(200);
    const booleanAggregate = await api(env, ctx, token, `/api/automation/node/${aggregate.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ service: { field_id: 33, aggregation_type: "checked_percentage" } }),
    });
    expect(booleanAggregate.status).toBe(200);
    await expectServiceError(aggregate.id, { field_id: 31, aggregation_type: "decile" });
    const resetAggregate = await api(env, ctx, token, `/api/automation/node/${aggregate.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ service: { field_id: null, aggregation_type: "unknown-is-reset" } }),
    });
    expect(resetAggregate.status).toBe(200);
    expect(await resetAggregate.json()).toMatchObject({ service: { field_id: null, aggregation_type: "" } });

    const edgeUid = crypto.randomUUID();
    const router = await createAction("router", {
      default_edge_label: "Otherwise",
      edges: [{ uid: edgeUid, label: "Matched", condition: true }],
    });
    expect(router.service.edges[0]).toMatchObject({ uid: edgeUid, label: "Matched", condition: { formula: "true" } });
    await expectServiceError(router.id, { edges: [{ uid: "invalid", label: "Branch", condition: true }] });
    const duplicateEdgeUid = crypto.randomUUID();
    await expectServiceError(router.id, {
      edges: [
        { uid: duplicateEdgeUid, label: "One", condition: true },
        { uid: duplicateEdgeUid, label: "Two", condition: false },
      ],
    });
    await expectServiceError(router.id, { default_edge_label: "x".repeat(76) });
    await expectServiceError(router.id, { edges: "not-a-list" });
    const emptyRouter = await api(env, ctx, token, `/api/automation/node/${router.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ service: { edges: [] } }),
    });
    expect(emptyRouter.status).toBe(200);
    expect((await emptyRouter.json() as any).service.edges).toEqual([]);
  });

  it("resolves wildcard paths from previous published node results", async () => {
    const { db, env, token, ctx, queueMessages } = await setupAutomationFixture();

    const appCreate = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Automation", type: "automation" }),
    });
    expect(appCreate.status).toBe(200);
    const app = await appCreate.json() as any;
    const workflow = app.workflows[0];
    const webhookUid = crypto.randomUUID();

    const triggerCreate = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "http_trigger",
        label: "Webhook",
        service: { uid: webhookUid, is_public: true },
      }),
    });
    expect(triggerCreate.status).toBe(200);
    const trigger = await triggerCreate.json() as any;

    const listCreate = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "local_baserow_list_rows",
        label: "List contacts",
        reference_node_id: trigger.id,
        service: { table_id: 20, default_result_count: 100 },
      }),
    });
    expect(listCreate.status).toBe(200);
    const listNode = await listCreate.json() as any;

    const createSummary = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "local_baserow_create_row",
        label: "Create summary",
        reference_node_id: listNode.id,
        service: {
          table_id: 20,
          field_mappings: [
            {
              field_id: 30,
              value: {
                formula: `concat(if(contains(get('previous_node.${listNode.id}.results.*.field_30'), 'Ada'), 'names ', 'missing '), join(get('previous_node.${listNode.id}.results.*.field_30'), ' | '), ' ', length(get('previous_node.${listNode.id}.results.*.field_30')))`,
              },
            },
          ],
        },
      }),
    });
    expect(createSummary.status).toBe(200);

    const publish = await api(env, ctx, token, `/api/automation/workflows/${workflow.id}/publish/async/`, {
      method: "POST",
    });
    expect(publish.status).toBe(202);
    const startedPublishJob = await publish.json() as any;
    expect(startedPublishJob.state).toBe("pending");
    await runNextQueuedJob(env, queueMessages);
    const completedPublish = await api(env, ctx, token, `/api/jobs/${startedPublishJob.id}/`);
    expect((await completedPublish.json() as any).state).toBe("finished");

    const webhook = await publicApi(env, ctx, `/api/webhooks/${webhookUid}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    expect(webhook.status).toBe(204);

    const rows = await db.prepare(`SELECT id, field_30 FROM "database_table_20" ORDER BY id ASC`).all<{ id: number; field_30: string }>();
    expect(rows.results.map((row) => row.field_30)).toEqual(["Ada", "Ben", "names Ada | Ben 2"]);
  });

  it("duplicates automation applications with workflows, integrations and published webhooks", async () => {
    const { db, env, token, ctx, queueMessages } = await setupAutomationFixture();

    const appCreate = await api(env, ctx, token, "/api/applications/workspace/1/", {
      method: "POST",
      body: JSON.stringify({ name: "Automation", type: "automation" }),
    });
    expect(appCreate.status).toBe(200);
    const app = await appCreate.json() as any;
    const workflow = app.workflows[0];
    const originalIntegrationId = app.integrations.find((integration: any) => integration.type === "local_baserow")?.id;
    expect(originalIntegrationId).toBeTruthy();

    const triggerCreate = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "http_trigger",
        label: "Duplicate webhook",
        service: { uid: crypto.randomUUID(), is_public: true },
      }),
    });
    expect(triggerCreate.status).toBe(200);
    const trigger = await triggerCreate.json() as any;

    const actionCreate = await api(env, ctx, token, `/api/automation/workflow/${workflow.id}/nodes/`, {
      method: "POST",
      body: JSON.stringify({
        type: "local_baserow_create_row",
        label: "Create duplicate row",
        reference_node_id: trigger.id,
        service: {
          table_id: 20,
          field_mappings: [
            {
              field_id: 30,
              value: { formula: `concat('copy ', get('previous_node.${trigger.id}.body.name'))` },
            },
          ],
        },
      }),
    });
    expect(actionCreate.status).toBe(200);
    const action = await actionCreate.json() as any;
    expect(action.service.integration_id).toBe(originalIntegrationId);

    const publish = await api(env, ctx, token, `/api/automation/workflows/${workflow.id}/publish/async/`, {
      method: "POST",
    });
    expect(publish.status).toBe(202);
    const startedPublishJob = await publish.json() as any;
    expect(startedPublishJob.state).toBe("pending");
    await runNextQueuedJob(env, queueMessages);
    const completedPublish = await api(env, ctx, token, `/api/jobs/${startedPublishJob.id}/`);
    expect((await completedPublish.json() as any).state).toBe("finished");

    const response = await api(env, ctx, token, `/api/applications/${app.id}/duplicate/async/`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(202);
    const job = await response.json() as any;
    expect(job).toMatchObject({ state: "finished", type: "duplicate_application" });
    const duplicate = job.duplicated_application;
    expect(duplicate.type).toBe("automation");
    expect(duplicate.id).not.toBe(app.id);

    const copiedIntegration = duplicate.integrations.find((integration: any) => integration.type === "local_baserow");
    expect(copiedIntegration?.id).toBeTruthy();
    expect(copiedIntegration.id).not.toBe(originalIntegrationId);

    const copiedWorkflow = duplicate.workflows.find((item: any) => item.name === workflow.name);
    expect(copiedWorkflow).toMatchObject({ state: "live" });
    expect(copiedWorkflow.id).not.toBe(workflow.id);
    expect(copiedWorkflow.graph["0"]).not.toBe(trigger.id);

    const copiedNodesResponse = await api(env, ctx, token, `/api/automation/workflow/${copiedWorkflow.id}/nodes/`);
    expect(copiedNodesResponse.status).toBe(200);
    const copiedNodes = await copiedNodesResponse.json() as any[];
    const copiedTrigger = copiedNodes.find((node) => node.type === "http_trigger");
    const copiedAction = copiedNodes.find((node) => node.type === "local_baserow_create_row");
    expect(copiedTrigger.id).not.toBe(trigger.id);
    expect(copiedTrigger.service.uid).not.toBe(trigger.service.uid);
    expect(copiedAction.id).not.toBe(action.id);
    expect(copiedAction.service.integration_id).toBe(copiedIntegration.id);
    expect(copiedAction.service.field_mappings[0].value.formula)
      .toBe(`concat('copy ', get('previous_node.${copiedTrigger.id}.body.name'))`);

    const copiedHistoryBefore = await api(env, ctx, token, `/api/automation/workflows/${copiedWorkflow.id}/history/`);
    expect(copiedHistoryBefore.status).toBe(200);
    expect((await copiedHistoryBefore.json() as any).count).toBe(0);

    const webhook = await publicApi(env, ctx, `/api/webhooks/${copiedTrigger.service.uid}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "duplicated automation" }),
    });
    expect(webhook.status).toBe(204);

    const rows = await db.prepare(`SELECT field_30 FROM "database_table_20" ORDER BY id ASC`).all<{ field_30: string }>();
    expect(rows.results.map((row) => row.field_30)).toContain("copy duplicated automation");

    const copiedHistoryAfter = await api(env, ctx, token, `/api/automation/workflows/${copiedWorkflow.id}/history/`);
    expect(copiedHistoryAfter.status).toBe(200);
    expect((await copiedHistoryAfter.json() as any).count).toBe(1);
  });
});
