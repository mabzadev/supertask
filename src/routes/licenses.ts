import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { serializePersonalLicense } from "../services/licenses";

const licenses = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

licenses.get("/", authMiddleware, async (c) => {
  return c.json([serializePersonalLicense()]);
});

licenses.post("/", authMiddleware, async (c) => {
  return c.json(serializePersonalLicense(), 201);
});

licenses.get("/:id/", authMiddleware, async (c) => {
  return c.json(serializePersonalLicense());
});

licenses.delete("/:id/", authMiddleware, async (c) => {
  return c.body(null, 204);
});

licenses.get("/:id/check/", authMiddleware, async (c) => {
  return c.json(serializePersonalLicense());
});

licenses.get("/:id/lookup-users/", authMiddleware, async (c) => {
  return c.json({
    count: 0,
    next: null,
    previous: null,
    results: [],
  });
});

licenses.post("/:id/fill-seats/", authMiddleware, async (c) => {
  return c.json(serializePersonalLicense());
});

licenses.post("/:id/remove-all-users/", authMiddleware, async (c) => {
  return c.json(serializePersonalLicense());
});

licenses.post("/:id/:userId/", authMiddleware, async (c) => {
  return c.json(serializePersonalLicense());
});

licenses.delete("/:id/:userId/", authMiddleware, async (c) => {
  return c.body(null, 204);
});

export { licenses as licensesRouter };
