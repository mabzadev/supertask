import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createCtx, createEnv, createTestD1 } from "./helpers/worker-harness";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

describe("web app routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands the web app's /api/docs pages to Pages and keeps the API on /api", async () => {
    const env = createEnv(createTestD1());
    const pages = vi.fn(async () => new Response("<html>docs</html>", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", pages);
    const get = (url: string) => worker.fetch(new Request(url), env, createCtx());

    // createEnv serves the web app from web.supertask.test.
    const docs = await get("https://web.supertask.test/api/docs/database/1");
    expect(await docs.text()).toBe("<html>docs</html>");
    expect(pages).toHaveBeenCalledTimes(1);

    const health = await get("https://web.supertask.test/api/_health/");
    expect(health.status).toBe(200);
    expect(await get("https://api.supertask.test/api/docs/")).toMatchObject({ status: 404 });
    expect(pages).toHaveBeenCalledTimes(1);
  });
});
