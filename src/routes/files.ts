import { Hono } from "hono";
import { authenticateUserSessionRequest } from "../middleware/auth";
import type { Env, RequestVariables, RequestUser } from "../types/env";
import { assertHasWorkspaceRole } from "../services/enterprise-permissions";
import {
  secureFileServePermission,
  verifySecureFileData,
} from "../services/secure-file-serve";
import { serveR2Object } from "./media";

const files = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

const SECURE_FILE_ERROR = {
  error: "ERROR_SECURE_FILE_SERVE_EXCEPTION",
  detail: "The requested signed data is invalid.",
};

function fileNameFromKey(key: string): string {
  return key.split("/").filter(Boolean).pop() || "file";
}

async function ensurePermission(
  env: Env,
  request: Request,
  user: RequestUser | null,
  workspaceId: number | null
): Promise<boolean> {
  const permission = secureFileServePermission(env);
  if (permission === "DISABLED") return true;
  const requestUser = user || await authenticateUserSessionRequest(env, request);
  if (!requestUser) return false;
  if (permission === "SIGNED_IN") return true;
  if (!workspaceId) return Boolean(requestUser.is_staff);
  try {
    await assertHasWorkspaceRole(env.DB, requestUser.id, workspaceId, "VIEWER");
    return true;
  } catch {
    return false;
  }
}

files.get("/:signedData{.+}", async (c) => {
  const signedData = c.req.param("signedData");
  const payload = await verifySecureFileData(c.env, signedData);
  if (!payload) return c.json(SECURE_FILE_ERROR, 403);

  const user = c.get("user") || null;
  if (!await ensurePermission(c.env, c.req.raw, user, payload.workspace_id)) {
    return c.json(SECURE_FILE_ERROR, 403);
  }

  const downloadName = c.req.query("dl") || "";
  return serveR2Object(c as any, payload.name, {
    downloadName,
    fallbackName: fileNameFromKey(payload.name),
  });
});

files.on("HEAD", "/:signedData{.+}", async (c) => {
  const signedData = c.req.param("signedData");
  const payload = await verifySecureFileData(c.env, signedData);
  if (!payload) return c.json(SECURE_FILE_ERROR, 403);

  if (!await ensurePermission(c.env, c.req.raw, c.get("user") || null, payload.workspace_id)) {
    return c.json(SECURE_FILE_ERROR, 403);
  }

  const request = new Request(c.req.url.replace(`/api/files/${signedData}`, `/media/${payload.name}`), {
    method: "HEAD",
    headers: c.req.raw.headers,
  });
  return c.env.FILES.head(payload.name).then((object) => {
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Content-Length", String(object.size));
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Accept-Ranges", "bytes");
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
    const dl = new URL(request.url).searchParams.get("dl") || "";
    const filename = dl || fileNameFromKey(payload.name);
    headers.set("Content-Disposition", `${dl ? "attachment" : "inline"}; filename="${filename.replace(/["\\\r\n]/g, "_")}"`);
    return new Response(null, { headers });
  });
});

export { files as filesRouter };
