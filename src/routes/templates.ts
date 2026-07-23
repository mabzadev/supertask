import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import {
  getTemplateSerialized,
  installTemplateIntoWorkspace,
  listTemplateCategories,
  templateById,
  templateBySlug,
} from "../services/templates";
const r = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

r.get("/", async (c) => {
  return c.json(await listTemplateCategories(c.env.DB));
});

r.get("/:slug/", async (c) => {
  return c.json(await getTemplateSerialized(c.env, c.req.param("slug")));
});

async function install(c: any, workspaceId: number, templateId: number) {
  const user = c.get("user")!;
  const applications = await installTemplateIntoWorkspace(c.env, workspaceId, templateId, user.id);
  return applications.map((app: any) => ({
    id: app.id,
    name: app.name,
    type: app.type,
    order: app.order,
    workspace: app.workspace_id,
    workspace_id: app.workspace_id,
  }));
}

r.post("/install/:workspaceId/:templateId/", authMiddleware, async (c) => {
  return c.json(await install(c, Number(c.req.param("workspaceId")), Number(c.req.param("templateId"))), 200);
});

r.post("/install/:workspaceId/:templateId/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = Number(c.req.param("workspaceId"));
  const templateId = Number(c.req.param("templateId"));
  const template = templateById(templateId);
  if (!template) return c.json({ error: "ERROR_TEMPLATE_DOES_NOT_EXIST" }, 404);
  const applications = await install(c, workspaceId, templateId);
  const now = new Date().toISOString();
  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on)
     VALUES ('install_template', 'finished', 100, ?, ?, ?) RETURNING id`
  ).bind(user.id, now, now).first<{ id: number }>();
  return c.json({
    id: job?.id,
    type: "install_template",
    state: "finished",
    status: "finished",
    progress_percentage: 100,
    workspace: { id: workspaceId },
    template: await getTemplateSerialized(c.env, template.slug),
    installed_applications: applications,
    created_on: now,
    updated_on: now,
  }, 202);
});

export { r as templatesRouter };
