import { Hono } from "hono";
import type { Env, RequestVariables } from "../../types/env";
import { authMiddleware } from "../../middleware/auth";
import { DoesNotExist } from "../../middleware/error";
import { broadcastToWorkspace } from "../../durable-objects/workspace-room";
import {
  createDateDependencyRule,
  getTableAccess,
  recomputeFieldRuleValidity,
  serializeFieldRule,
  updateDateDependencyRule,
  type DateDependencyRule,
} from "../../services/field-rules";
import { ensureUserTableSystemColumns } from "../../services/dynamic-tables";
import { readAfterAccessCheck } from "../../services/enterprise-permissions";

const r = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

r.get("/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const rules = await readAfterAccessCheck(getTableAccess(c.env.DB, user.id, tableId), c.env.DB.prepare(
    "SELECT * FROM database_fieldrule WHERE table_id=? ORDER BY id ASC"
  ).bind(tableId).all<DateDependencyRule>());
  return c.json((rules.results || []).map(serializeFieldRule));
});

r.post("/:tableId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const table = await getTableAccess(c.env.DB, user.id, tableId, "MEMBER");
  const result = await createDateDependencyRule(c.env.DB, tableId, await c.req.json<Record<string, unknown>>());
  if ("error" in result) {
    return c.json({ error: result.error, detail: "The requested rule already exists." }, 409);
  }
  const serialized = serializeFieldRule(result.rule);
  await broadcastToWorkspace(c.env, table.workspace_id, { type: "field_rule_added", rule: serialized });
  return c.json(serialized, 200);
});

r.put("/:tableId/rule/:ruleId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const ruleId = Number(c.req.param("ruleId"));
  const table = await getTableAccess(c.env.DB, user.id, tableId, "MEMBER");
  const rule = await updateDateDependencyRule(c.env.DB, tableId, ruleId, await c.req.json<Record<string, unknown>>());
  const serialized = serializeFieldRule(rule);
  await broadcastToWorkspace(c.env, table.workspace_id, { type: "field_rule_updated", rule: serialized });
  return c.json(serialized);
});

r.delete("/:tableId/rule/:ruleId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  const ruleId = Number(c.req.param("ruleId"));
  const table = await getTableAccess(c.env.DB, user.id, tableId, "MEMBER");
  const rule = await c.env.DB.prepare("SELECT * FROM database_fieldrule WHERE id=? AND table_id=?")
    .bind(ruleId, tableId)
    .first<DateDependencyRule>();
  if (!rule) throw new DoesNotExist("Rule", ruleId);
  await c.env.DB.prepare("DELETE FROM database_fieldrule WHERE id=?").bind(ruleId).run();
  await recomputeFieldRuleValidity(c.env.DB, tableId);
  await broadcastToWorkspace(c.env, table.workspace_id, { type: "field_rule_deleted", rule: serializeFieldRule(rule) });
  return new Response(null, { status: 204 });
});

r.get("/:tableId/invalid-rows/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const tableId = Number(c.req.param("tableId"));
  await getTableAccess(c.env.DB, user.id, tableId);
  await recomputeFieldRuleValidity(c.env.DB, tableId);
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const size = Math.min(200, Number(c.req.query("size") || 100));
  const offset = (page - 1) * size;
  await ensureUserTableSystemColumns(c.env.DB, tableId);
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 AND field_rules_are_valid=0`
  ).first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT id FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 AND field_rules_are_valid=0 ORDER BY id ASC LIMIT ? OFFSET ?`
  ).bind(size, offset).all<{ id: number }>();
  return c.json({
    count: count?.count || 0,
    next: offset + size < (count?.count || 0) ? `?page=${page + 1}&size=${size}` : null,
    previous: page > 1 ? `?page=${page - 1}&size=${size}` : null,
    results: rows.results || [],
  });
});

export { r as fieldRulesRouter };
