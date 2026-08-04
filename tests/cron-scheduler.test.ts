import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  builder: vi.fn(async () => []),
  automation: vi.fn(async () => []),
  ai: vi.fn(async () => undefined),
  webhooks: vi.fn(async () => 0),
  userFiles: vi.fn(async () => 0),
}));

vi.mock("../src/services/builder", () => ({ triggerDuePeriodicBuilderWorkflows: mocks.builder }));
vi.mock("../src/services/automation", () => ({ triggerDuePeriodicAutomationWorkflows: mocks.automation }));
vi.mock("../src/services/ai-auto-update", () => ({ reschedulePendingAIUpdates: mocks.ai }));
vi.mock("../src/routes/database/webhooks", () => ({ recoverWebhookDeliveryQueue: mocks.webhooks }));
vi.mock("../src/services/user-files", () => ({ cleanupExpiredUserFiles: mocks.userFiles }));
vi.mock("../src/routes/trash", () => ({ permanentlyDeleteItem: vi.fn(async () => undefined) }));
vi.mock("../src/services/account-deletion", () => ({
  deleteUserAccount: vi.fn(async () => null),
  isLastActiveInstanceAdmin: vi.fn(async () => false),
}));
vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

import { handleCron } from "../src/cron/handler";

function environment() {
  const prepared: string[] = [];
  const values = new Map<string, string>();
  const DB = {
    prepare(sql: string) {
      prepared.push(sql);
      const statement = {
        bind: () => statement,
        all: async () => ({ results: [] }),
        first: async () => sql.includes("account_deletion_grace_delay")
          ? { account_deletion_grace_delay: 30 }
          : null,
        run: async () => ({ success: true }),
      };
      return statement;
    },
  };
  const CACHE = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
  };
  return {
    prepared,
    env: {
      DB,
      CACHE,
      FILES: {},
      JOBS_QUEUE: { send: vi.fn(async () => undefined) },
    } as any,
  };
}

describe("consolidated cron scheduler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("polls once per trigger while gating hourly and daily maintenance", async () => {
    const { env, prepared } = environment();
    const first = new Date("2026-08-04T04:05:00.000Z");

    await handleCron("*/5 * * * *", env, first);
    await handleCron("*/5 * * * *", env, new Date("2026-08-04T04:10:00.000Z"));

    expect(mocks.builder).toHaveBeenCalledTimes(2);
    expect(mocks.automation).toHaveBeenCalledTimes(2);
    expect(mocks.webhooks).toHaveBeenCalledTimes(2);
    expect(prepared.filter((sql) => sql.includes("UPDATE core_job SET status='expired'"))).toHaveLength(1);
    expect(prepared.filter((sql) => sql.includes("account_deletion_grace_delay"))).toHaveLength(1);

    await handleCron("*/5 * * * *", env, new Date("2026-08-04T05:00:00.000Z"));
    await handleCron("*/5 * * * *", env, new Date("2026-08-05T03:00:00.000Z"));

    expect(prepared.filter((sql) => sql.includes("UPDATE core_job SET status='expired'"))).toHaveLength(3);
    expect(prepared.filter((sql) => sql.includes("account_deletion_grace_delay"))).toHaveLength(2);
  });

  it("ignores obsolete cron schedules after consolidation", async () => {
    const { env, prepared } = environment();
    await handleCron("* * * * *", env, new Date("2026-08-04T04:05:00.000Z"));
    expect(prepared).toEqual([]);
    expect(mocks.builder).not.toHaveBeenCalled();
  });
});
