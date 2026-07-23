import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { ValidationError } from "../middleware/error";
import {
  authenticateUserSource,
  blacklistUserSourceToken,
  createIntegration,
  createUserSource,
  listIntegrations,
  listUserSources,
  listUsersPerSource,
  moveIntegration,
  moveUserSource,
  refreshUserSourceAuth,
  requireApplicationAccess,
  requireIntegrationAccess,
  requireUserSourceAccess,
  serializeIntegration,
  updateIntegration,
  updateUserSource,
  userSourceAuthResponse,
  userSourceRoles,
} from "../services/application-extras";

const applicationExtras = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const integrationItems = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const userSourceItems = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const userSourceAuth = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

applicationExtras.get("/:applicationId/integrations/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  await requireApplicationAccess(c.env.DB, user.id, applicationId);
  return c.json(await listIntegrations(c.env.DB, applicationId));
});

applicationExtras.post("/:applicationId/integrations/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  await requireApplicationAccess(c.env.DB, user.id, applicationId, "BUILDER");
  return c.json(await createIntegration(c.env.DB, applicationId, await c.req.json<Record<string, unknown>>()));
});

applicationExtras.get("/:applicationId/user-sources/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  await requireApplicationAccess(c.env.DB, user.id, applicationId);
  return c.json(await listUserSources(c.env.DB, applicationId));
});

applicationExtras.post("/:applicationId/user-sources/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  await requireApplicationAccess(c.env.DB, user.id, applicationId, "BUILDER");
  return c.json(await createUserSource(c.env.DB, applicationId, await c.req.json<Record<string, unknown>>()));
});

applicationExtras.get("/:applicationId/user-sources/roles/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  await requireApplicationAccess(c.env.DB, user.id, applicationId);
  return c.json(await userSourceRoles(c.env.DB, applicationId));
});

applicationExtras.get("/:applicationId/list-user-source-users/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  await requireApplicationAccess(c.env.DB, user.id, applicationId);
  return c.json(await listUsersPerSource(c.env.DB, applicationId, c.req.query("search") || ""));
});

integrationItems.patch("/:integrationId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const integrationId = Number(c.req.param("integrationId"));
  await requireIntegrationAccess(c.env.DB, user.id, integrationId, "BUILDER");
  return c.json(await updateIntegration(c.env.DB, integrationId, await c.req.json<Record<string, unknown>>()));
});

integrationItems.patch("/:integrationId/move/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const integrationId = Number(c.req.param("integrationId"));
  await requireIntegrationAccess(c.env.DB, user.id, integrationId, "BUILDER");
  const body = await c.req.json<{ before_id?: number | null }>();
  await moveIntegration(c.env.DB, integrationId, body.before_id || null);
  return c.json({});
});

integrationItems.delete("/:integrationId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const integrationId = Number(c.req.param("integrationId"));
  await requireIntegrationAccess(c.env.DB, user.id, integrationId, "BUILDER");
  await c.env.DB.prepare("DELETE FROM core_integration WHERE id=?").bind(integrationId).run();
  return c.json({});
});

userSourceItems.patch("/:userSourceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const userSourceId = Number(c.req.param("userSourceId"));
  await requireUserSourceAccess(c.env.DB, user.id, userSourceId, "BUILDER");
  return c.json(await updateUserSource(c.env.DB, userSourceId, await c.req.json<Record<string, unknown>>()));
});

userSourceItems.patch("/:userSourceId/move/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const userSourceId = Number(c.req.param("userSourceId"));
  await requireUserSourceAccess(c.env.DB, user.id, userSourceId, "BUILDER");
  const body = await c.req.json<{ before_id?: number | null }>();
  await moveUserSource(c.env.DB, userSourceId, body.before_id || null);
  return c.json({});
});

userSourceItems.delete("/:userSourceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const userSourceId = Number(c.req.param("userSourceId"));
  await requireUserSourceAccess(c.env.DB, user.id, userSourceId, "BUILDER");
  await c.env.DB.prepare("DELETE FROM core_usersource WHERE id=?").bind(userSourceId).run();
  return c.json({});
});

userSourceItems.post("/:userSourceId/force-token-auth", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const userSourceId = Number(c.req.param("userSourceId"));
  const userSource = await requireUserSourceAccess(c.env.DB, user.id, userSourceId, "BUILDER");
  const body = await c.req.json<{ user_id?: number }>();
  if (!body.user_id) throw new ValidationError("user_id is required.");
  const users = await listUsersPerSource(c.env.DB, userSource.application_id, "");
  const match = (users.users_per_user_sources[String(userSourceId)] || []).find((candidate: any) => candidate.id === body.user_id);
  if (!match) throw new ValidationError("The selected user source user does not exist.");
  return c.json(await userSourceAuthResponse(c.env, userSource, match));
});

userSourceItems.post("/:userSourceId/token-auth", async (c) => {
  const userSourceId = Number(c.req.param("userSourceId"));
  const userSource = await c.env.DB.prepare("SELECT * FROM core_usersource WHERE id=?").bind(userSourceId).first<any>();
  if (!userSource) throw new ValidationError("The selected user source does not exist.");
  return c.json(await authenticateUserSource(c.env, userSource, await c.req.json<Record<string, unknown>>()));
});

userSourceAuth.post("/user-source-auth-refresh/", async (c) => {
  const body = await c.req.json<{ refresh_token?: string }>();
  if (!body.refresh_token) throw new ValidationError("refresh_token is required.");
  return c.json(await refreshUserSourceAuth(c.env, body.refresh_token));
});

userSourceAuth.post("/user-source-token-blacklist/", async (c) => {
  const body = await c.req.json<{ refresh_token?: string }>();
  if (!body.refresh_token) throw new ValidationError("refresh_token is required.");
  await blacklistUserSourceToken(c.env, body.refresh_token);
  return c.json({});
});

export {
  applicationExtras as applicationExtrasRouter,
  integrationItems as integrationItemsRouter,
  userSourceItems as userSourceItemsRouter,
  userSourceAuth as userSourceAuthRouter,
};
