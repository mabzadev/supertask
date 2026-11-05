import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { DoesNotExist, ValidationError } from "../middleware/error";
import { assertHasApplicationRole } from "../services/enterprise-permissions";
import { logAuditEntry } from "../services/audit-log";

const whiteboards = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const EMPTY_STATE = { nodes: [], edges: [], strokes: [] };

const TEMPLATE_STATES: Record<string, Record<string, unknown>> = {
  blank: EMPTY_STATE,
  brainstorming: {
    nodes: [
      { id: "idea", type: "sticky", position: { x: 80, y: 80 }, data: { text: "Idée principale", color: "violet" } },
      { id: "idea-2", type: "sticky", position: { x: 380, y: 30 }, data: { text: "Piste 1", color: "yellow" } },
      { id: "idea-3", type: "sticky", position: { x: 380, y: 210 }, data: { text: "Piste 2", color: "blue" } },
    ],
    edges: [
      { id: "idea-edge-1", source: "idea", target: "idea-2", type: "smoothstep" },
      { id: "idea-edge-2", source: "idea", target: "idea-3", type: "smoothstep" },
    ],
    strokes: [],
  },
  flowchart: {
    nodes: [
      { id: "start", type: "shape", position: { x: 80, y: 120 }, data: { text: "Début", shape: "ellipse", color: "green" } },
      { id: "step", type: "shape", position: { x: 360, y: 120 }, data: { text: "Étape", shape: "rectangle", color: "blue" } },
      { id: "decision", type: "shape", position: { x: 650, y: 120 }, data: { text: "Décision", shape: "diamond", color: "violet" } },
    ],
    edges: [
      { id: "flow-edge-1", source: "start", target: "step", type: "smoothstep" },
      { id: "flow-edge-2", source: "step", target: "decision", type: "smoothstep" },
    ],
    strokes: [],
  },
  retrospective: {
    nodes: [
      { id: "frame-good", type: "frame", position: { x: 40, y: 40 }, data: { text: "Ce qui a bien fonctionné", color: "green", width: 320, height: 480 } },
      { id: "frame-improve", type: "frame", position: { x: 400, y: 40 }, data: { text: "À améliorer", color: "orange", width: 320, height: 480 } },
      { id: "frame-actions", type: "frame", position: { x: 760, y: 40 }, data: { text: "Actions", color: "blue", width: 320, height: 480 } },
    ],
    edges: [],
    strokes: [],
  },
  project: {
    nodes: [
      { id: "frame-todo", type: "frame", position: { x: 40, y: 40 }, data: { text: "À faire", color: "neutral", width: 300, height: 520 } },
      { id: "frame-doing", type: "frame", position: { x: 380, y: 40 }, data: { text: "En cours", color: "blue", width: 300, height: 520 } },
      { id: "frame-done", type: "frame", position: { x: 720, y: 40 }, data: { text: "Terminé", color: "green", width: 300, height: 520 } },
    ],
    edges: [],
    strokes: [],
  },
};

function parseObject(value: unknown, fallback: Record<string, unknown> = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function serializeCanvas(row: any) {
  return {
    id: Number(row.id),
    whiteboard_id: Number(row.whiteboard_id),
    name: String(row.name || ""),
    icon: String(row.icon || "🧠"),
    order: Number(row.order || 0),
    state: parseObject(row.state, EMPTY_STATE),
    settings: parseObject(row.settings),
    thumbnail_key: String(row.thumbnail_key || ""),
    editor_schema_version: Number(row.editor_schema_version || 1),
    created_on: row.created_on,
    updated_on: row.updated_on,
  };
}

async function whiteboardAccess(db: D1Database, userId: number, applicationId: number, role = "VIEWER") {
  const app = await db.prepare(
    `SELECT a.id, a.name, a.workspace_id
       FROM core_application a
      WHERE a.id=? AND a.type='whiteboard' AND a.trashed=0`
  ).bind(applicationId).first<any>();
  if (!app) throw new DoesNotExist("Whiteboard", applicationId);
  await assertHasApplicationRole(db, userId, applicationId, role);
  return app;
}

async function canvasAccess(db: D1Database, userId: number, canvasId: number, role = "VIEWER") {
  const canvas = await db.prepare(
    `SELECT c.*, a.workspace_id, a.name AS whiteboard_name
       FROM supertask_whiteboard_canvas c
       JOIN core_application a ON a.id=c.whiteboard_id
      WHERE c.id=? AND c.trashed=0 AND a.type='whiteboard' AND a.trashed=0`
  ).bind(canvasId).first<any>();
  if (!canvas) throw new DoesNotExist("WhiteboardCanvas", canvasId);
  await assertHasApplicationRole(db, userId, Number(canvas.whiteboard_id), role);
  return canvas;
}

async function createCanvas(db: D1Database, applicationId: number, userId: number, body: any) {
  const max = await db.prepare(
    "SELECT COALESCE(MAX([order]), 0) AS max_order FROM supertask_whiteboard_canvas WHERE whiteboard_id=? AND trashed=0"
  ).bind(applicationId).first<{ max_order: number }>();
  const template = String(body.template || "blank");
  const initialState = TEMPLATE_STATES[template] || TEMPLATE_STATES.blank;
  const state = body.state === undefined ? initialState : parseObject(body.state, initialState);
  const serializedState = JSON.stringify(state);
  if (serializedState.length > 2_000_000) throw new ValidationError("Le contenu du tableau blanc est trop volumineux.");
  const now = new Date().toISOString();
  const row = await db.prepare(
    `INSERT INTO supertask_whiteboard_canvas
     (whiteboard_id, name, icon, [order], state, settings, thumbnail_key,
      editor_schema_version, trashed, created_by_id, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, 0, ?, ?, ?) RETURNING *`
  ).bind(
    applicationId,
    String(body.name || "Nouveau canevas"),
    String(body.icon || "🧠"),
    Number(max?.max_order || 0) + 1,
    serializedState,
    JSON.stringify(parseObject(body.settings)),
    Math.max(1, Number(body.editor_schema_version) || 1),
    userId,
    now,
    now,
  ).first<any>();
  if (!row) throw new Error("Impossible de créer le canevas.");
  return row;
}

whiteboards.get("/:applicationId/canvases/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  await whiteboardAccess(c.env.DB, user.id, applicationId);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM supertask_whiteboard_canvas WHERE whiteboard_id=? AND trashed=0 ORDER BY [order], id"
  ).bind(applicationId).all<any>();
  return c.json((rows.results || []).map(serializeCanvas));
});

whiteboards.post("/:applicationId/canvases/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  const body = await c.req.json<any>().catch(() => ({}));
  const app = await whiteboardAccess(c.env.DB, user.id, applicationId, "BUILDER");
  const row = await createCanvas(c.env.DB, applicationId, user.id, body);
  await logAuditEntry(c.env.DB, "whiteboard.canvas.create", {
    user,
    workspace_id: Number(app.workspace_id),
  }, { id: row.id, type: "whiteboard_canvas" }, {
    whiteboard_id: applicationId,
    canvas_name: row.name,
  });
  return c.json(serializeCanvas(row), 201);
});

whiteboards.post("/:applicationId/canvases/order/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const applicationId = Number(c.req.param("applicationId"));
  const body = await c.req.json<any>().catch(() => ({}));
  await whiteboardAccess(c.env.DB, user.id, applicationId, "BUILDER");
  const ids = Array.isArray(body.canvas_ids) ? body.canvas_ids.map(Number).filter(Number.isInteger) : [];
  const rows = await c.env.DB.prepare(
    "SELECT id FROM supertask_whiteboard_canvas WHERE whiteboard_id=? AND trashed=0 ORDER BY [order], id"
  ).bind(applicationId).all<{ id: number }>();
  const existing = (rows.results || []).map((row) => Number(row.id));
  if (ids.length !== existing.length || ids.some((id: number) => !existing.includes(id))) {
    throw new ValidationError("canvas_ids doit contenir chaque canevas actif exactement une fois.");
  }
  const now = new Date().toISOString();
  await c.env.DB.batch(ids.map((id: number, index: number) => c.env.DB.prepare(
    "UPDATE supertask_whiteboard_canvas SET [order]=?, updated_on=? WHERE id=? AND whiteboard_id=?"
  ).bind(index + 1, now, id, applicationId)));
  return c.json({});
});

whiteboards.get("/canvases/:canvasId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const row = await canvasAccess(c.env.DB, user.id, Number(c.req.param("canvasId")));
  return c.json(serializeCanvas(row));
});

whiteboards.patch("/canvases/:canvasId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const canvasId = Number(c.req.param("canvasId"));
  const body = await c.req.json<any>().catch(() => ({}));
  const existing = await canvasAccess(c.env.DB, user.id, canvasId, "EDITOR");
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const field of ["name", "icon", "thumbnail_key"] as const) {
    if (field in body) { sets.push(`${field}=?`); values.push(String(body[field] ?? "")); }
  }
  if ("state" in body) {
    const state = JSON.stringify(parseObject(body.state, EMPTY_STATE));
    if (state.length > 2_000_000) throw new ValidationError("Le contenu du tableau blanc est trop volumineux.");
    sets.push("state=?"); values.push(state);
  }
  if ("settings" in body) { sets.push("settings=?"); values.push(JSON.stringify(parseObject(body.settings))); }
  if ("editor_schema_version" in body) {
    sets.push("editor_schema_version=?"); values.push(Math.max(1, Number(body.editor_schema_version) || 1));
  }
  if (sets.length === 0) return c.json(serializeCanvas(existing));
  sets.push("updated_on=?"); values.push(new Date().toISOString());
  await c.env.DB.prepare(`UPDATE supertask_whiteboard_canvas SET ${sets.join(", ")} WHERE id=?`)
    .bind(...values, canvasId).run();
  const updated = await c.env.DB.prepare("SELECT * FROM supertask_whiteboard_canvas WHERE id=?")
    .bind(canvasId).first<any>();
  await logAuditEntry(c.env.DB, "whiteboard.canvas.update", {
    user,
    workspace_id: Number(existing.workspace_id),
  }, { id: canvasId, type: "whiteboard_canvas" }, { fields: sets.map((set) => set.split("=")[0]) });
  return c.json(serializeCanvas(updated));
});

whiteboards.post("/canvases/:canvasId/duplicate/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const canvasId = Number(c.req.param("canvasId"));
  const existing = await canvasAccess(c.env.DB, user.id, canvasId, "BUILDER");
  const row = await createCanvas(c.env.DB, Number(existing.whiteboard_id), user.id, {
    name: `${existing.name || "Canevas"} copie`,
    icon: existing.icon,
    state: parseObject(existing.state, EMPTY_STATE),
    settings: parseObject(existing.settings),
    editor_schema_version: existing.editor_schema_version,
  });
  return c.json(serializeCanvas(row), 201);
});

whiteboards.delete("/canvases/:canvasId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const canvasId = Number(c.req.param("canvasId"));
  const existing = await canvasAccess(c.env.DB, user.id, canvasId, "BUILDER");
  const now = new Date().toISOString();
  await c.env.DB.prepare("UPDATE supertask_whiteboard_canvas SET trashed=1, updated_on=? WHERE id=?")
    .bind(now, canvasId).run();
  await logAuditEntry(c.env.DB, "whiteboard.canvas.delete", {
    user,
    workspace_id: Number(existing.workspace_id),
  }, { id: canvasId, type: "whiteboard_canvas" }, {
    whiteboard_id: Number(existing.whiteboard_id),
    canvas_name: existing.name,
  });
  return c.body(null, 204);
});

export async function ensureWhiteboardDefaults(db: D1Database, applicationId: number, userId: number) {
  const existing = await db.prepare(
    "SELECT id FROM supertask_whiteboard_canvas WHERE whiteboard_id=? AND trashed=0 LIMIT 1"
  ).bind(applicationId).first();
  if (!existing) await createCanvas(db, applicationId, userId, { name: "Premier canevas", template: "blank" });
}

export { whiteboards as whiteboardRouter };
