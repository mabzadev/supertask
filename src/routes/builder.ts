import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth";
import { AuthenticationError, DoesNotExist, ValidationError } from "../middleware/error";
import { broadcastToWorkspace } from "../durable-objects/workspace-room";
import { serializeUserFileCellForRequest, storeUserFile } from "../services/user-files";
import {
  createDataSource,
  createDomain,
  createElement,
  createPage,
  createWorkflowAction,
  duplicatePage,
  dispatchDataSource,
  dispatchWorkflowAction,
  duplicateElement,
  ensureBuilderDefaults,
  listPages,
  moveDataSource,
  moveElement,
  publishBuilderDomain,
  recordNames,
  requireBuilderAccess,
  requireDataSourceAccess,
  requireDomainAccess,
  requireElementAccess,
  requirePageAccess,
  requireWorkflowActionAccess,
  serializeBuilderApplication,
  serializeDataSource,
  serializeDomain,
  serializeElement,
  serializeWorkflowAction,
  updateDataSource,
  updateElement,
  updatePage,
  updateTheme,
  updateWorkflowAction,
} from "../services/builder";

const builder = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

async function publicPageById(db: D1Database, pageId: number, userId?: number) {
  const page = await db.prepare(
    `SELECT p.*, a.workspace_id,
            EXISTS (
              SELECT 1 FROM builder_domain d
              JOIN core_application source ON source.id=d.builder_id
              WHERE d.published_to_id=p.builder_id AND d.published=1 AND source.trashed=0
            ) AS is_published_builder
     FROM builder_page p
     JOIN core_application a ON a.id = p.builder_id
     WHERE p.id = ? AND a.type = 'builder' AND a.trashed = 0`
  ).bind(pageId).first<any>();
  if (!page) throw new DoesNotExist("Builder page", pageId);
  if (Number(page.is_published_builder)) return page;
  if (!userId) throw new AuthenticationError();
  await requirePageAccess(db, userId, pageId);
  return page;
}

async function publicDataSourceById(db: D1Database, dataSourceId: number, userId?: number) {
  const dataSource = await db.prepare(
    `SELECT ds.*, p.builder_id, a.workspace_id,
            EXISTS (
              SELECT 1 FROM builder_domain d
              JOIN core_application source ON source.id=d.builder_id
              WHERE d.published_to_id=p.builder_id AND d.published=1 AND source.trashed=0
            ) AS is_published_builder
     FROM builder_datasource ds
     JOIN builder_page p ON p.id = ds.page_id
     JOIN core_application a ON a.id = p.builder_id
     WHERE ds.id = ? AND a.type = 'builder' AND a.trashed = 0`
  ).bind(dataSourceId).first<any>();
  if (!dataSource) throw new DoesNotExist("Builder data source", dataSourceId);
  if (Number(dataSource.is_published_builder)) return dataSource;
  if (!userId) throw new AuthenticationError();
  await requireDataSourceAccess(db, userId, dataSourceId);
  return dataSource;
}

async function publicWorkflowActionById(db: D1Database, workflowActionId: number, userId?: number) {
  const workflowAction = await db.prepare(
    `SELECT wa.*, p.builder_id, a.workspace_id,
            EXISTS (
              SELECT 1 FROM builder_domain d
              JOIN core_application source ON source.id=d.builder_id
              WHERE d.published_to_id=p.builder_id AND d.published=1 AND source.trashed=0
            ) AS is_published_builder
     FROM builder_workflowaction wa
     JOIN builder_page p ON p.id=wa.page_id
     JOIN core_application a ON a.id=p.builder_id
     WHERE wa.id=? AND a.type='builder' AND a.trashed=0`
  ).bind(workflowActionId).first<any>();
  if (!workflowAction) throw new DoesNotExist("Builder workflow action", workflowActionId);
  if (Number(workflowAction.is_published_builder)) return workflowAction;
  if (!userId) throw new AuthenticationError();
  await requireWorkflowActionAccess(db, userId, workflowActionId);
  return workflowAction;
}

async function serializedDataSourcesForPage(db: D1Database, pageId: number) {
  const rows = await db.prepare("SELECT * FROM builder_datasource WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  return Promise.all((rows.results || []).map((row) => serializeDataSource(db, row)));
}

async function serializedWorkflowActionsForPage(db: D1Database, pageId: number) {
  const rows = await db.prepare("SELECT * FROM builder_workflowaction WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  return Promise.all((rows.results || []).map((row) => serializeWorkflowAction(db, row)));
}

function fileTypeAllowed(file: File, allowedTypes: unknown): boolean {
  if (!Array.isArray(allowedTypes) || allowedTypes.length === 0) return true;
  const mimeType = String(file.type || "application/octet-stream").toLowerCase();
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  return allowedTypes.some((entry) => {
    const allowed = String(entry || "").trim().toLowerCase();
    if (!allowed) return false;
    if (allowed.endsWith("/*")) return mimeType.startsWith(allowed.slice(0, -1));
    if (allowed.includes("/")) return mimeType === allowed;
    return extension === allowed.replace(/^\./, "");
  });
}

async function storeDispatchFile(
  c: any,
  form: FormData,
  descriptor: Record<string, unknown>,
  element: any,
  workspaceId: number
) {
  if (!descriptor.__file__ || descriptor.url) return descriptor;
  const fileKey = String(descriptor.file || "");
  const value = fileKey ? form.get(fileKey) : null;
  if (!(value instanceof File)) throw new ValidationError("A Builder file input is missing its uploaded file.");
  const maxSizeMb = Math.max(1, Number(element.max_filesize || 5));
  if (value.size > maxSizeMb * 1024 * 1024) {
    throw new ValidationError(`The file ${String(descriptor.name || value.name)} is too large. Max ${maxSizeMb}MB.`);
  }
  if (!fileTypeAllowed(value, element.allowed_filetypes)) {
    throw new ValidationError(`The file ${String(descriptor.name || value.name)} type is not allowed.`);
  }
  const user = c.get("user");
  const stored = await storeUserFile(c.env, {
    userId: user?.id ?? null,
    fileName: String(descriptor.name || value.name),
    contentType: value.type,
    size: value.size,
    body: value,
  });
  return serializeUserFileCellForRequest(
    c.env,
    stored,
    workspaceId,
    String(descriptor.name || value.name)
  );
}

async function parseBody(c: any, pageId: number, workspaceId: number) {
  const contentType = c.req.header("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const metadata = form.get("metadata");
    if (typeof metadata === "string") {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(metadata) as Record<string, unknown>;
      } catch {
        throw new ValidationError("Invalid JSON format in metadata.");
      }
      const formData = parsed.form_data;
      if (formData && typeof formData === "object" && !Array.isArray(formData)) {
        for (const [elementId, value] of Object.entries(formData as Record<string, unknown>)) {
          const element = await c.env.DB.prepare(
            "SELECT * FROM builder_element WHERE id=? AND page_id=? AND type='input_file'"
          ).bind(Number(elementId), pageId).first();
          const candidates = Array.isArray(value) ? value : [value];
          if (!candidates.some((candidate) => candidate && typeof candidate === "object" && (candidate as any).__file__)) continue;
          if (!element) throw new ValidationError("The uploaded file does not belong to a file input on this page.");
          const configuration = JSON.parse(element.configuration || "{}");
          const normalizedElement = { ...element, ...configuration };
          const storedFiles = await Promise.all(candidates.map((candidate) =>
            candidate && typeof candidate === "object"
              ? storeDispatchFile(c, form, candidate as Record<string, unknown>, normalizedElement, workspaceId)
              : candidate
          ));
          (formData as Record<string, unknown>)[elementId] = normalizedElement.multiple ? storedFiles : storedFiles[0] ?? null;
        }
      }
      return parsed;
    }
    return {};
  }
  const body = await c.req.json().catch(() => ({}));
  if (body && typeof body === "object" && !Array.isArray(body) && body.metadata && typeof body.metadata === "object") {
    return body.metadata;
  }
  return body;
}

async function parseDispatchMetadata(c: any) {
  const body = await c.req.json().catch(() => ({}));
  if (body && typeof body === "object" && !Array.isArray(body) && body.metadata && typeof body.metadata === "object") {
    return body.metadata as Record<string, unknown>;
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

async function sha256(value: number | string) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

builder.get("/:builderId/pages/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  await requireBuilderAccess(c.env.DB, user.id, builderId);
  return c.json(await listPages(c.env.DB, builderId));
});

builder.post("/:builderId/pages/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  const app = await requireBuilderAccess(c.env.DB, user.id, builderId, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  const page = await createPage(c.env.DB, builderId, body);
  await broadcastToWorkspace(c.env, app.workspace_id, { type: "page_created", page });
  return c.json(page);
});

builder.post("/:builderId/pages/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  const app = await requireBuilderAccess(c.env.DB, user.id, builderId, "BUILDER");
  const body = await c.req.json<{ page_ids?: number[] }>();
  const ids = body.page_ids || [];
  if (ids.length > 0) {
    await c.env.DB.batch(ids.map((id, index) =>
      c.env.DB.prepare("UPDATE builder_page SET [order]=?, updated_on=? WHERE id=? AND builder_id=?")
        .bind(index + 1, new Date().toISOString(), id, builderId)
    ));
  }
  await broadcastToWorkspace(c.env, app.workspace_id, {
    type: "pages_reordered",
    builder_id: await sha256(builderId),
    order: await Promise.all(ids.map((id) => sha256(id))),
  });
  return c.json({});
});

builder.patch("/pages/:pageId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  const pageAccess = await requirePageAccess(c.env.DB, user.id, pageId, "BUILDER");
  const page = await updatePage(c.env.DB, pageId, await c.req.json<Record<string, unknown>>());
  await broadcastToWorkspace(c.env, pageAccess.workspace_id, { type: "page_updated", page });
  return c.json(page);
});

builder.delete("/pages/:pageId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  const page = await requirePageAccess(c.env.DB, user.id, pageId, "BUILDER");
  if (page.shared) throw new ValidationError("The shared page cannot be deleted.");
  await c.env.DB.prepare("DELETE FROM builder_page WHERE id=?").bind(pageId).run();
  await broadcastToWorkspace(c.env, page.workspace_id, { type: "page_deleted", builder_id: page.builder_id, page_id: pageId });
  return c.json({});
});

builder.post("/pages/:pageId/duplicate/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  await requirePageAccess(c.env.DB, user.id, pageId, "BUILDER");
  const duplicated = await duplicatePage(c.env.DB, pageId);
  return c.json({
    id: Date.now(),
    type: "duplicate_builder_page",
    state: "finished",
    human_readable_error: "",
    original_page: duplicated.original,
    duplicated_page: duplicated.duplicate,
    page_id: duplicated.duplicate.id,
  });
});

builder.get("/page/:pageId/elements/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  await requirePageAccess(c.env.DB, user.id, pageId);
  const rows = await c.env.DB.prepare("SELECT * FROM builder_element WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  return c.json((rows.results || []).map(serializeElement));
});

builder.post("/page/:pageId/elements/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  const page = await requirePageAccess(c.env.DB, user.id, pageId, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  const element = await createElement(c.env.DB, pageId, body);
  await broadcastToWorkspace(c.env, page.workspace_id, { type: "element_created", element, before_id: body.before_id || null });
  return c.json(element);
});

builder.patch("/element/:elementId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const elementId = Number(c.req.param("elementId"));
  const access = await requireElementAccess(c.env.DB, user.id, elementId, "BUILDER");
  const element = await updateElement(c.env.DB, elementId, await c.req.json<Record<string, unknown>>());
  await broadcastToWorkspace(c.env, access.workspace_id, { type: "element_updated", element });
  return c.json(element);
});

builder.patch("/element/:elementId/move/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const elementId = Number(c.req.param("elementId"));
  const access = await requireElementAccess(c.env.DB, user.id, elementId, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  const element = await moveElement(c.env.DB, elementId, body);
  await broadcastToWorkspace(c.env, access.workspace_id, {
    type: "element_moved",
    page_id: element.page_id,
    element_id: element.id,
    before_id: body.before_id || null,
    parent_element_id: body.parent_element_id || null,
    place_in_container: body.place_in_container || null,
  });
  return c.json(element);
});

builder.delete("/element/:elementId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const elementId = Number(c.req.param("elementId"));
  const element = await requireElementAccess(c.env.DB, user.id, elementId, "BUILDER");
  await c.env.DB.prepare("DELETE FROM builder_element WHERE id=?").bind(elementId).run();
  await broadcastToWorkspace(c.env, element.workspace_id, { type: "element_deleted", page_id: element.page_id, element_id: elementId });
  return c.json({});
});

builder.post("/element/:elementId/duplicate/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const elementId = Number(c.req.param("elementId"));
  const access = await requireElementAccess(c.env.DB, user.id, elementId, "BUILDER");
  const duplicated = await duplicateElement(c.env.DB, elementId);
  for (const element of duplicated.elements) {
    await broadcastToWorkspace(c.env, access.workspace_id, {
      type: "element_created",
      element,
      before_id: null,
    });
  }
  for (const workflowAction of duplicated.workflow_actions) {
    await broadcastToWorkspace(c.env, access.workspace_id, {
      type: "workflow_action_created",
      page_id: workflowAction.page_id,
      workflow_action: workflowAction,
    });
  }
  return c.json(duplicated);
});

builder.get("/page/:pageId/data-sources/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  await requirePageAccess(c.env.DB, user.id, pageId);
  return c.json(await serializedDataSourcesForPage(c.env.DB, pageId));
});

builder.post("/page/:pageId/data-sources/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  const page = await requirePageAccess(c.env.DB, user.id, pageId, "BUILDER");
  const body = await c.req.json<Record<string, unknown>>();
  const dataSource = await createDataSource(c.env.DB, pageId, body);
  await broadcastToWorkspace(c.env, page.workspace_id, { type: "data_source_created", data_source: dataSource, before_id: body.before_id || null });
  return c.json(dataSource);
});

builder.patch("/data-source/:dataSourceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dataSourceId = Number(c.req.param("dataSourceId"));
  const access = await requireDataSourceAccess(c.env.DB, user.id, dataSourceId, "BUILDER");
  const dataSource = await updateDataSource(c.env.DB, dataSourceId, await c.req.json<Record<string, unknown>>());
  await broadcastToWorkspace(c.env, access.workspace_id, { type: "data_source_updated", data_source: dataSource });
  return c.json(dataSource);
});

builder.patch("/data-source/:dataSourceId/move/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dataSourceId = Number(c.req.param("dataSourceId"));
  await requireDataSourceAccess(c.env.DB, user.id, dataSourceId, "BUILDER");
  const body = await c.req.json<{ before_id?: number | null }>();
  await moveDataSource(c.env.DB, dataSourceId, body.before_id || null);
  return c.json({});
});

builder.delete("/data-source/:dataSourceId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dataSourceId = Number(c.req.param("dataSourceId"));
  const dataSource = await requireDataSourceAccess(c.env.DB, user.id, dataSourceId, "BUILDER");
  await c.env.DB.prepare("DELETE FROM builder_datasource WHERE id=?").bind(dataSourceId).run();
  await broadcastToWorkspace(c.env, dataSource.workspace_id, { type: "data_source_deleted", page_id: dataSource.page_id, data_source_id: dataSourceId });
  return c.json({});
});

builder.post("/data-source/:dataSourceId/dispatch/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dataSourceId = Number(c.req.param("dataSourceId"));
  const dataSource = await requireDataSourceAccess(c.env.DB, user.id, dataSourceId);
  return c.json(await dispatchDataSource(c.env.DB, dataSource, new URL(c.req.url).searchParams, await parseDispatchMetadata(c)));
});

builder.post("/page/:pageId/dispatch-data-sources/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  await requirePageAccess(c.env.DB, user.id, pageId);
  const rows = await c.env.DB.prepare("SELECT * FROM builder_datasource WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  const result: Record<string, unknown> = {};
  const query = new URL(c.req.url).searchParams;
  const metadata = await parseDispatchMetadata(c);
  for (const dataSource of rows.results || []) {
    try {
      result[dataSource.id] = await dispatchDataSource(c.env.DB, dataSource, query, metadata);
    } catch (error: any) {
      result[dataSource.id] = { _error: error.name || "ERROR", detail: error.message };
    }
  }
  return c.json(result);
});

builder.get("/data-source/:dataSourceId/record-names/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const dataSourceId = Number(c.req.param("dataSourceId"));
  const dataSource = await requireDataSourceAccess(c.env.DB, user.id, dataSourceId);
  const ids = String(c.req.query("record_ids") || "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter(Boolean);
  return c.json(await recordNames(c.env.DB, dataSource, ids));
});

builder.get("/:builderId/domains/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  await requireBuilderAccess(c.env.DB, user.id, builderId);
  const rows = await c.env.DB.prepare("SELECT * FROM builder_domain WHERE builder_id=? ORDER BY id ASC").bind(builderId).all<any>();
  return c.json((rows.results || []).map(serializeDomain));
});

builder.post("/:builderId/domains/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  await requireBuilderAccess(c.env.DB, user.id, builderId, "BUILDER");
  return c.json(await createDomain(c.env.DB, builderId, await c.req.json<Record<string, unknown>>()));
});

builder.delete("/domains/:domainId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const domainId = Number(c.req.param("domainId"));
  await requireDomainAccess(c.env.DB, user.id, domainId, "BUILDER");
  await c.env.DB.prepare("DELETE FROM builder_domain WHERE id=?").bind(domainId).run();
  return c.json({});
});

builder.patch("/:builderId/theme/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  const app = await requireBuilderAccess(c.env.DB, user.id, builderId, "BUILDER");
  const properties = await updateTheme(c.env.DB, builderId, await c.req.json<Record<string, unknown>>());
  await broadcastToWorkspace(c.env, app.workspace_id, { type: "theme_updated", builder_id: builderId, properties });
  return c.json(properties);
});

builder.get("/page/:pageId/workflow_actions/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  await requirePageAccess(c.env.DB, user.id, pageId);
  return c.json(await serializedWorkflowActionsForPage(c.env.DB, pageId));
});

builder.post("/page/:pageId/workflow_actions/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  const page = await requirePageAccess(c.env.DB, user.id, pageId, "BUILDER");
  const workflowAction = await createWorkflowAction(c.env.DB, pageId, await c.req.json<Record<string, unknown>>());
  await broadcastToWorkspace(c.env, page.workspace_id, { type: "workflow_action_created", page_id: pageId, workflow_action: workflowAction });
  return c.json(workflowAction);
});

builder.patch("/workflow_action/:workflowActionId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowActionId = Number(c.req.param("workflowActionId"));
  const access = await requireWorkflowActionAccess(c.env.DB, user.id, workflowActionId, "BUILDER");
  const workflowAction = await updateWorkflowAction(c.env.DB, workflowActionId, await c.req.json<Record<string, unknown>>());
  await broadcastToWorkspace(c.env, access.workspace_id, { type: "workflow_action_updated", page_id: workflowAction.page_id, workflow_action: workflowAction });
  return c.json(workflowAction);
});

builder.delete("/workflow_action/:workflowActionId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workflowActionId = Number(c.req.param("workflowActionId"));
  const workflowAction = await requireWorkflowActionAccess(c.env.DB, user.id, workflowActionId, "BUILDER");
  await c.env.DB.prepare("DELETE FROM builder_workflowaction WHERE id=?").bind(workflowActionId).run();
  await broadcastToWorkspace(c.env, workflowAction.workspace_id, {
    type: "workflow_action_deleted",
    page_id: workflowAction.page_id,
    workflow_action_id: workflowActionId,
  });
  return c.json({});
});

builder.post("/page/:pageId/workflow_actions/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const pageId = Number(c.req.param("pageId"));
  await requirePageAccess(c.env.DB, user.id, pageId, "BUILDER");
  const body = await c.req.json<{ workflow_action_ids?: number[]; element_id?: number | null }>();
  const ids = body.workflow_action_ids || [];
  if (ids.length > 0) {
    await c.env.DB.batch(ids.map((id, index) =>
      c.env.DB.prepare("UPDATE builder_workflowaction SET [order]=?, element_id=?, updated_on=? WHERE id=? AND page_id=?")
        .bind(String(index + 1), body.element_id || null, new Date().toISOString(), id, pageId)
    ));
  }
  return c.json({});
});

builder.post("/workflow_action/:workflowActionId/dispatch/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const workflowActionId = Number(c.req.param("workflowActionId"));
  const workflowAction = await publicWorkflowActionById(c.env.DB, workflowActionId, user?.id);
  return c.json(await dispatchWorkflowAction(
    c.env,
    workflowAction,
    await parseBody(c, Number(workflowAction.page_id), Number(workflowAction.workspace_id)),
    user?.id ?? null
  ));
});

builder.post("/domains/:domainId/publish/async/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const domainId = Number(c.req.param("domainId"));
  await requireDomainAccess(c.env.DB, user.id, domainId, "BUILDER");
  const publication = await publishBuilderDomain(c.env.DB, domainId);
  return c.json({
    id: Date.now(),
    type: "publish_builder",
    state: "finished",
    domain_id: publication.domainId,
    builder_id: publication.builderId,
    published_builder_id: publication.publishedBuilderId,
  });
});

builder.get("/domains/published/by_name/:domain/", optionalAuthMiddleware, async (c) => {
  const domainName = c.req.param("domain");
  const findDomain = () => c.env.DB.prepare(
    `SELECT d.* FROM builder_domain d
     JOIN core_application source ON source.id=d.builder_id
     WHERE d.domain_name=? AND d.published=1 AND source.trashed=0`
  ).bind(domainName).first<any>();
  let domain = await findDomain();
  if (!domain) throw new DoesNotExist("Published builder domain", domainName);
  if (!domain.published_to_id) {
    try {
      await publishBuilderDomain(c.env.DB, Number(domain.id));
    } catch (error) {
      const concurrentlyPublished = await findDomain();
      if (!concurrentlyPublished?.published_to_id) throw error;
    }
    domain = await findDomain();
  }
  const app = await c.env.DB.prepare("SELECT * FROM core_application WHERE id=? AND type='builder' AND trashed=0").bind(domain.published_to_id).first<any>();
  if (!app) throw new DoesNotExist("Builder", domain.published_to_id);
  await ensureBuilderDefaults(c.env.DB, app.id);
  return c.json({
    id: app.id,
    name: app.name,
    type: app.type,
    order: app.order,
    workspace: { id: app.workspace_id },
    workspace_id: app.workspace_id,
    ...(await serializeBuilderApplication(c.env.DB, app, c.env, { public: true })),
  });
});

builder.get("/domains/published/by_id/:builderId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const builderId = Number(c.req.param("builderId"));
  await requireBuilderAccess(c.env.DB, user.id, builderId);
  const app = await c.env.DB.prepare("SELECT * FROM core_application WHERE id=? AND type='builder' AND trashed=0").bind(builderId).first<any>();
  if (!app) throw new DoesNotExist("Builder", builderId);
  return c.json({
    id: app.id,
    name: app.name,
    type: app.type,
    order: app.order,
    workspace: { id: app.workspace_id },
    workspace_id: app.workspace_id,
    ...(await serializeBuilderApplication(c.env.DB, app, c.env)),
  });
});

builder.get("/domains/published/page/:pageId/elements/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const pageId = Number(c.req.param("pageId"));
  await publicPageById(c.env.DB, pageId, user?.id);
  const rows = await c.env.DB.prepare("SELECT * FROM builder_element WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  return c.json((rows.results || []).map(serializeElement));
});

builder.get("/domains/published/page/:pageId/data_sources/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const pageId = Number(c.req.param("pageId"));
  await publicPageById(c.env.DB, pageId, user?.id);
  return c.json(await serializedDataSourcesForPage(c.env.DB, pageId));
});

builder.get("/domains/published/page/:pageId/workflow_actions/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const pageId = Number(c.req.param("pageId"));
  await publicPageById(c.env.DB, pageId, user?.id);
  return c.json(await serializedWorkflowActionsForPage(c.env.DB, pageId));
});

builder.post("/domains/published/data-source/:dataSourceId/dispatch/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const dataSourceId = Number(c.req.param("dataSourceId"));
  const dataSource = await publicDataSourceById(c.env.DB, dataSourceId, user?.id);
  return c.json(await dispatchDataSource(c.env.DB, dataSource, new URL(c.req.url).searchParams, await parseDispatchMetadata(c)));
});

builder.post("/domains/published/page/:pageId/dispatch-data-sources/", optionalAuthMiddleware, async (c) => {
  const user = c.get("user");
  const pageId = Number(c.req.param("pageId"));
  await publicPageById(c.env.DB, pageId, user?.id);
  const rows = await c.env.DB.prepare("SELECT * FROM builder_datasource WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC")
    .bind(pageId)
    .all<any>();
  const result: Record<string, unknown> = {};
  const query = new URL(c.req.url).searchParams;
  const metadata = await parseDispatchMetadata(c);
  for (const dataSource of rows.results || []) {
    try {
      result[dataSource.id] = await dispatchDataSource(c.env.DB, dataSource, query, metadata);
    } catch (error: any) {
      result[dataSource.id] = { _error: error.name || "ERROR", detail: error.message };
    }
  }
  return c.json(result);
});

export { builder as builderRouter };
