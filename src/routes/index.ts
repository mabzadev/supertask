import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { userRouter } from "./user";
import { workspaceRouter } from "./workspaces";
import { applicationRouter } from "./applications";
import { databaseRouter } from "./database/index";
import { settingsRouter } from "./settings";
import { jobsRouter } from "./jobs";
import { trashRouter } from "./trash";
import { notificationsRouter } from "./notifications";
import { rowCommentsRouter } from "./row-comments";
import { snapshotsRouter } from "./snapshots";
import { adminRouter } from "./admin";
import { templatesRouter } from "./templates";
import { searchRouter } from "./search";
import { userFilesRouter } from "./user-files";
import { filesRouter } from "./files";
import { authProviderRouter } from "./auth-provider";
import { ssoRouter } from "./sso";
import { userSourceSsoRouter } from "./user-source-sso";
import { twoFactorRouter } from "./two-factor-auth";
import { auditLogRouter } from "./audit-log";
import { builderRouter } from "./builder";
import { customCodeRouter } from "./custom-code";
import { licensesRouter } from "./licenses";
import { documentRouter } from "./document";
import { whiteboardRouter } from "./whiteboards";
import { collaborationRouter } from "./collaboration";
import { dashboardRouter } from "./dashboard";
import { dispatchHttpWorkflowTrigger } from "../services/builder";
import { automationRouter } from "./automation";
import { dispatchAutomationHttpTrigger } from "../services/automation";
import { mcpRouter } from "./mcp";
import { fieldPermissionsRouter, roleRouter, teamsRouter } from "./enterprise";
import {
  applicationExtrasRouter,
  integrationItemsRouter,
  userSourceAuthRouter,
  userSourceItemsRouter,
} from "./application-extras";

const api = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

// ── Helper: mount router accepting both /path and /path/ ─────────────────────
function mount(path: string, router: Hono<any>) {
  api.route(path, router);
  api.route(path + "/", router);
}

// ── Routes ────────────────────────────────────────────────────────────────────
mount("/user", userRouter);
mount("/user-files", userFilesRouter);
mount("/files", filesRouter);
mount("/workspaces", workspaceRouter);
mount("/applications", applicationRouter);
mount("/application", applicationExtrasRouter);
mount("/integration", integrationItemsRouter);
mount("/user-source", userSourceItemsRouter);
mount("/user-source", userSourceSsoRouter);
api.route("/", userSourceAuthRouter);
mount("/settings", settingsRouter);
mount("/jobs", jobsRouter);
mount("/trash", trashRouter);
mount("/notifications", notificationsRouter);
mount("/row_comments", rowCommentsRouter);
mount("/snapshots", snapshotsRouter);
mount("/admin", adminRouter);
mount("/templates", templatesRouter);
mount("/search", searchRouter);
mount("/auth-provider", authProviderRouter);
mount("/sso", ssoRouter);
mount("/two-factor-auth", twoFactorRouter);
mount("/audit-log", auditLogRouter);
mount("/builder", builderRouter);
mount("/custom_code", customCodeRouter);
mount("/automation", automationRouter);
mount("/licenses", licensesRouter);
mount("/document", documentRouter);
mount("/whiteboards", whiteboardRouter);
mount("/collaboration", collaborationRouter);
mount("/dashboard", dashboardRouter);
mount("/mcp", mcpRouter);
mount("/teams", teamsRouter);
mount("/role", roleRouter);
mount("/field-permissions", fieldPermissionsRouter);

api.all("/webhooks/:webhookUid/", async (c) => {
  const uid = c.req.param("webhookUid");
  const url = new URL(c.req.url);
  const rawBody = ["GET", "HEAD"].includes(c.req.method) ? "" : await c.req.text();
  const contentType = c.req.header("content-type") || "";
  let body: unknown = {};
  if (rawBody && contentType.includes("application/json")) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = {};
    }
  } else if (rawBody && contentType.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(rawBody).entries());
  }
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const requestData = {
    method: c.req.method,
    headers,
    query_params: Object.fromEntries(url.searchParams.entries()),
    body,
    raw_body: rawBody,
    remote_addr: c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "",
    user_agent: c.req.header("User-Agent") || "",
  };
  const simulate = url.searchParams.get("test")?.toLowerCase() === "true";
  let result;
  try {
    result = await dispatchAutomationHttpTrigger(c.env, uid, requestData, simulate);
  } catch (error: any) {
    if (error?.name !== "DoesNotExist") throw error;
    result = await dispatchHttpWorkflowTrigger(c.env, uid, requestData, simulate);
  }
  if (url.searchParams.get("test")?.toLowerCase() === "true") {
    return c.json(result);
  }
  return c.body(null, 204);
});

// ── Database sub-routes (tables, fields, rows, views, etc.) ──────────────────
mount("/database", databaseRouter);

export { api as apiRouter };
