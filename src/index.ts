import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env, RequestVariables } from "./types/env";
import { CORE_REALTIME_ROOM, WorkspaceRoomDO } from "./durable-objects/workspace-room";
import { McpSessionDO } from "./durable-objects/mcp-session";
import { ContentRoomDO } from "./durable-objects/content-room";
import { authenticateUserSessionRequest } from "./middleware/auth";
import { contentKind, getContentAccess } from "./services/collaboration";
import { apiRouter } from "./routes/index";
import { mediaRouter } from "./routes/media";
import { mcpServerRouter } from "./routes/mcp";
import { assistantRouter } from "./routes/assistant";
import { handleQueue } from "./queue/handler";
import { handleCron } from "./cron/handler";
import { errorHandler } from "./middleware/error";

export { WorkspaceRoomDO, McpSessionDO, ContentRoomDO };

const app = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

type AppContext = Context<{ Bindings: Env; Variables: RequestVariables }>;

async function healthResponse(c: AppContext) {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({
      status: "ok",
      version: "2.1.4",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return c.json({ status: "error", error: String(e) }, 503);
  }
}

async function fullHealthResponse(c: AppContext) {
  const checks: Record<string, object> = {};
  let status = "ok";
  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks.database = { status: "ok" };
  } catch (error) {
    status = "error";
    checks.database = { status: "error", error: String(error) };
  }

  try {
    await c.env.CACHE.put("healthcheck", "ok", { expirationTtl: 60 });
    checks.cache = { status: "ok" };
  } catch (error) {
    status = "error";
    checks.cache = { status: "error", error: String(error) };
  }

  try {
    await c.env.FILES.head("healthcheck");
    checks.files = { status: "ok" };
  } catch {
    checks.files = { status: "ok" };
  }

  return c.json({
    status,
    version: "2.1.4",
    environment: c.env.ENVIRONMENT || "production",
    checks,
    timestamp: new Date().toISOString(),
  }, status === "ok" ? 200 : 503);
}

async function emailHealthResponse(c: AppContext) {
  const body = await c.req.json<{ target_email?: string }>().catch((): { target_email?: string } => ({}));
  return c.json({
    status: "ok",
    email: {
      configured: Boolean(c.env.SMTP_HOST && c.env.SMTP_FROM),
      target_email: body.target_email || null,
      sent: false,
      detail: "Email delivery is not sent by the health endpoint in the Cloudflare runtime.",
    },
  });
}

async function staticAssetProxy(c: AppContext) {
  const frontendUrl =
    c.env.PUBLIC_WEB_FRONTEND_URL || "https://supertask-web.pages.dev";
  const requestUrl = new URL(c.req.url);
  const target = new URL(requestUrl.pathname + requestUrl.search, frontendUrl);
  const headers = new Headers();
  const ifNoneMatch = c.req.header("If-None-Match");
  const ifModifiedSince = c.req.header("If-Modified-Since");
  if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);
  if (ifModifiedSince) headers.set("If-Modified-Since", ifModifiedSince);
  const response = await fetch(target.toString(), {
    method: c.req.method,
    headers,
  });
  if ((response.headers.get("Content-Type") || "").includes("text/html")) {
    return c.json({ error: "NOT_FOUND", detail: "Static asset not found." }, 404);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function webSocketHandler(c: AppContext) {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const url = new URL(c.req.url);
  const token =
    url.searchParams.get("jwt_token") ||
    url.searchParams.get("token") ||
    c.req.header("Authorization")?.replace("JWT ", "");

  if (!token) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const roomId = c.env.WORKSPACE_ROOM.idFromName(CORE_REALTIME_ROOM);
  const room = c.env.WORKSPACE_ROOM.get(roomId);
  return room.fetch(c.req.raw);
}

async function collaborationWebSocketHandler(c: AppContext) {
  if ((c.req.header("Upgrade") || "").toLowerCase() !== "websocket") {
    return c.json({ error: "UPGRADE_REQUIRED", detail: "Connexion WebSocket attendue." }, 426);
  }
  const user = await authenticateUserSessionRequest(c.env, c.req.raw);
  if (!user) return c.json({ error: "AUTHENTICATION_REQUIRED", detail: "Authentification requise." }, 401);
  const kind = contentKind(c.req.param("kind"));
  const contentId = Number(c.req.param("id"));
  await getContentAccess(c.env.DB, user.id, kind, contentId, "VIEWER");
  const roomId = c.env.CONTENT_ROOM.idFromName(`${kind}:${contentId}`);
  const room = c.env.CONTENT_ROOM.get(roomId);
  const url = new URL(c.req.url);
  url.searchParams.set("kind", kind);
  url.searchParams.set("content_id", String(contentId));
  return room.fetch(new Request(url, c.req.raw));
}

// ── Global middleware ─────────────────────────────────────────────────────────
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "WebsocketId",
      "ClientSessionId",
      "ClientUndoRedoActionGroupId",
      "Baserow-View-Authorization",
      "UserSourceAuthorization",
    ],
    exposeHeaders: ["Content-Disposition"],
    maxAge: 86400,
  })
);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/_health/", healthResponse);
app.get("/api/health", healthResponse);
app.get("/api/health/", healthResponse);
app.get("/_health/", healthResponse);
app.get("/_health/full/", fullHealthResponse);
app.post("/_health/email/", emailHealthResponse);

// ── API routes ────────────────────────────────────────────────────────────────
app.route("/api", apiRouter);

// ── Enterprise assistant routes ──────────────────────────────────────────────
app.route("/assistant", assistantRouter);

// ── Media/static compatibility routes ────────────────────────────────────────
app.route("/media", mediaRouter);
app.get("/static/:key{.+}", staticAssetProxy);

// ── MCP server endpoints ─────────────────────────────────────────────────────
app.route("/mcp", mcpServerRouter);

// ── WebSocket upgrade (forward to Durable Object) ────────────────────────────
app.get("/ws/core", webSocketHandler);
app.get("/ws/core/", webSocketHandler);
app.get("/ws/collaboration/:kind/:id", collaborationWebSocketHandler);
app.get("/ws/collaboration/:kind/:id/", collaborationWebSocketHandler);

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError(errorHandler);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.notFound((c) => {
  return c.json(
    {
      detail: "Not found.",
      error: "NOT_FOUND",
    },
    404
  );
});

// ── Worker export ─────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  // Queue consumer
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return handleQueue(batch, env);
  },

  // Cron scheduler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(event.cron, env));
  },
};
