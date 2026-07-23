import { Hono } from "hono";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth";
import { AuthenticationError, DoesNotExist } from "../middleware/error";
import { getBuilderCustomCode, requireBuilderAccess } from "../services/builder";
import type { Env, RequestVariables } from "../types/env";

const customCode = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

type CustomCodeType = "css" | "js";

async function requirePublicOrPreviewAccess(db: D1Database, builderId: number, userId?: number) {
  const builder = await db.prepare(
    `SELECT id
     FROM core_application
     WHERE id = ? AND type = 'builder' AND trashed = 0`
  )
    .bind(builderId)
    .first<{ id: number }>();
  if (!builder) throw new DoesNotExist("Builder", builderId);

  const published = await db.prepare(
    `SELECT d.id FROM builder_domain d
     JOIN core_application source ON source.id=d.builder_id
     WHERE d.published_to_id=? AND d.published=1 AND source.trashed=0 LIMIT 1`
  )
    .bind(builderId)
    .first<{ id: number }>();
  if (published) return;

  if (!userId) throw new AuthenticationError();
  await requireBuilderAccess(db, userId, builderId);
}

async function customCodeResponse(db: D1Database, builderId: number, type: CustomCodeType) {
  const code = await getBuilderCustomCode(db, builderId);
  const body = String(code[type] || "");
  const contentType = type === "css"
    ? "text/css; charset=utf-8"
    : "application/javascript; charset=utf-8";
  return new Response(body, { headers: { "content-type": contentType } });
}

customCode.get("/:builderId/css/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  await requireBuilderAccess(c.env.DB, user.id, builderId);
  return customCodeResponse(c.env.DB, builderId, "css");
});

customCode.get("/:builderId/js/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  await requireBuilderAccess(c.env.DB, user.id, builderId);
  return customCodeResponse(c.env.DB, builderId, "js");
});

customCode.get("/:builderId/css/public/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const builderId = Number(c.req.param("builderId"));
  await requirePublicOrPreviewAccess(c.env.DB, builderId, user?.id);
  return customCodeResponse(c.env.DB, builderId, "css");
});

customCode.get("/:builderId/js/public/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const builderId = Number(c.req.param("builderId"));
  await requirePublicOrPreviewAccess(c.env.DB, builderId, user?.id);
  return customCodeResponse(c.env.DB, builderId, "js");
});

export { customCode as customCodeRouter };
