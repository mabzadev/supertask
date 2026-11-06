import { Hono } from "hono";
import type { Env, RequestVariables } from "../types/env";
import { databaseTokenAuthMiddleware } from "../middleware/auth";
import {
  serializeUserFileForRequest,
  storeUserFile,
  UserFileSizeTooLargeError,
  userFileSizeTooLargeResponse,
} from "../services/user-files";
import { verifySecureFileData } from "../services/secure-file-serve";
import { serveR2Object } from "./media";

const userFiles = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
const REMOTE_FILE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:95.0) Gecko/20100101 Firefox/95.0",
  Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,audio/*,video/*,application/pdf,*/*",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://airtable.com/",
  Origin: "https://airtable.com",
};
const ERROR_INVALID_FILE = {
  error: "ERROR_INVALID_FILE",
  detail: "No file has been provided or the file is invalid.",
};
const ERROR_INVALID_FILE_URL = {
  error: "ERROR_INVALID_FILE_URL",
  detail: "The provided URL is not valid.",
};

function fileUrlCouldNotBeReached(detail = "The provided URL could not be reached.") {
  return {
    error: "ERROR_FILE_URL_COULD_NOT_BE_REACHED",
    detail,
  };
}

function generatedRemoteFileName(contentType: string): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  const extensionByMimeType: Record<string, string> = {
    "application/json": "json",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "audio/mpeg": "mp3",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "text/csv": "csv",
    "text/html": "html",
    "text/plain": "txt",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const prefix = Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}.${extensionByMimeType[normalized] || "bin"}`;
}

function parseDownloadUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4Value(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InCidr(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function isNonPublicIpv4(hostname: string): boolean {
  const value = ipv4Value(hostname);
  if (value === null) return false;
  return [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ].some(([network, prefix]) => ipv4InCidr(value, network, prefix));
}

function isNonPublicIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const normalized = hostname.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(normalized)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isNonPublicIpv4(mappedIpv4) : false;
}

function remoteUrlIsPublic(url: URL): boolean {
  const hostname = normalizedHostname(url);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  return !isNonPublicIpv4(hostname) && !isNonPublicIpv6(hostname);
}

async function fetchPublicRemoteFile(url: URL): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = url;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (!remoteUrlIsPublic(currentUrl)) throw new Error("The URL points to a non-public address.");
    const response = await fetch(currentUrl.toString(), {
      headers: REMOTE_FILE_HEADERS,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirect === 5) throw new Error("The remote URL redirected too many times.");
    const nextUrl = parseDownloadUrl(new URL(location, currentUrl).toString());
    if (!nextUrl) throw new Error("The remote URL redirected to an invalid URL.");
    currentUrl = nextUrl;
  }
  throw new Error("The remote URL redirected too many times.");
}

function fileSizeErrorResponse(c: any, error: unknown): Response | null {
  if (!(error instanceof UserFileSizeTooLargeError)) return null;
  return c.json(userFileSizeTooLargeResponse(error), 413);
}

function addOrigin(origins: Set<string>, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    origins.add(new URL(value).origin);
  } catch {
  }
}

function knownLocalOrigins(env: Env, requestUrl: string): Set<string> {
  const origins = new Set<string>();
  addOrigin(origins, requestUrl);
  addOrigin(origins, env.PUBLIC_URL);
  addOrigin(origins, env.MEDIA_URL);
  addOrigin(origins, env.PUBLIC_WEB_FRONTEND_URL);
  return origins;
}

function decodePathKey(path: string, prefix: string): string {
  return path
    .replace(prefix, "")
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join("/");
}

function normalizeUserFileObjectKey(key: string): string {
  return key.startsWith("user_files/") ? key : `user_files/${key}`;
}

async function localR2KeyFromUrl(env: Env, requestUrl: string, parsedUrl: URL): Promise<string | null> {
  if (!knownLocalOrigins(env, requestUrl).has(parsedUrl.origin)) return null;
  if (parsedUrl.pathname.startsWith("/media/")) {
    return decodePathKey(parsedUrl.pathname, "/media/");
  }
  if (parsedUrl.pathname.startsWith("/api/user-files/")) {
    return normalizeUserFileObjectKey(decodePathKey(parsedUrl.pathname, "/api/user-files/"));
  }
  if (parsedUrl.pathname.startsWith("/api/files/")) {
    const signedData = decodePathKey(parsedUrl.pathname, "/api/files/");
    const payload = await verifySecureFileData(env, signedData);
    return payload?.name || null;
  }
  return null;
}

async function storeR2ObjectFromUrl(c: any, userId: number, sourceKey: string, requestedName?: string): Promise<Response> {
  const object = await c.env.FILES.get(sourceKey);
  if (!object) return c.json(fileUrlCouldNotBeReached(), 400);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const guessedName = requestedName || decodeURIComponent(sourceKey.split("/").pop() || "file");
  try {
    const stored = await storeUserFile(c.env, {
      userId,
      fileName: guessedName,
      contentType: headers.get("content-type") || "application/octet-stream",
      size: object.size,
      body: object.body,
    });
    return c.json(await serializeUserFileForRequest(c.env, stored), 200);
  } catch (error) {
    const response = fileSizeErrorResponse(c, error);
    if (response) return response;
    throw error;
  }
}

// ── POST /api/user-files/upload-file/ — Upload from multipart form ────────────
userFiles.post("/upload-file/", databaseTokenAuthMiddleware(), async (c) => {
  const user = c.get("user")!;
  console.log("[user-files] upload-file:start", { userId: user.id });
  const formData = await c.req.formData();
  console.log("[user-files] upload-file:form-data");
  const file = formData.get("file") as File | null;

  if (!file) return c.json(ERROR_INVALID_FILE, 400);
  console.log("[user-files] upload-file:file", {
    userId: user.id,
    name: file.name,
    size: file.size,
    type: file.type,
  });
  try {
    const stored = await storeUserFile(c.env, {
      userId: user.id,
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      body: file.stream(),
    });
    console.log("[user-files] upload-file:stored", { userId: user.id, fileId: stored.id, key: stored.r2_key });
    return c.json(await serializeUserFileForRequest(c.env, stored), 200);
  } catch (error) {
    const response = fileSizeErrorResponse(c, error);
    if (response) return response;
    throw error;
  }
});

// ── POST /api/user-files/upload-via-url/ — Fetch remote file → R2 ────────────
userFiles.post("/upload-via-url/", databaseTokenAuthMiddleware(), async (c) => {
  const user = c.get("user")!;
  let body: { url?: string; name?: string };
  try {
    body = await c.req.json<{ url?: string; name?: string }>();
  } catch {
    return c.json(ERROR_INVALID_FILE_URL, 400);
  }

  const parsedUrl = parseDownloadUrl(body.url);
  if (!parsedUrl) return c.json(ERROR_INVALID_FILE_URL, 400);

  const localKey = await localR2KeyFromUrl(c.env, c.req.url, parsedUrl);
  if (localKey) {
    return storeR2ObjectFromUrl(c, user.id, localKey, body.name);
  }

  let res: Response;
  try {
    res = (await fetchPublicRemoteFile(parsedUrl)).response;
  } catch {
    return c.json(fileUrlCouldNotBeReached(), 400);
  }
  if (!res.ok && parsedUrl.pathname.startsWith("/media/")) {
    return storeR2ObjectFromUrl(c, user.id, decodePathKey(parsedUrl.pathname, "/media/"), body.name);
  }
  if (!res.ok) return c.json(fileUrlCouldNotBeReached(), 400);

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  const pathName = pathParts.length > 0 ? decodeURIComponent(pathParts[pathParts.length - 1]) : "";
  const guessedName = body.name || pathName || generatedRemoteFileName(contentType);
  const size = Number(res.headers.get("content-length") || 0);
  if (!res.body) return c.json(fileUrlCouldNotBeReached(), 400);

  try {
    const stored = await storeUserFile(c.env, {
      userId: user.id,
      fileName: guessedName,
      contentType,
      size,
      body: res.body,
    });
    return c.json(await serializeUserFileForRequest(c.env, stored), 200);
  } catch (error) {
    const response = fileSizeErrorResponse(c, error);
    if (response) return response;
    throw error;
  }
});

// ── GET /api/user-files/:key — Serve file from R2 (public access) ─────────────
userFiles.get("/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const objectKey = key.startsWith("user_files/") ? key : `user_files/${key}`;
  return serveR2Object(c as any, objectKey);
});

userFiles.on("HEAD", "/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const objectKey = key.startsWith("user_files/") ? key : `user_files/${key}`;
  const object = await c.env.FILES.head(objectKey);

  if (!object) return new Response(null, { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }
  return new Response(null, { headers });
});

export { userFiles as userFilesRouter };
