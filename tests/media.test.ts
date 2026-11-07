import { describe, expect, it, vi } from "vitest";
import { mediaRouter } from "../src/routes/media";
import { userFilesRouter } from "../src/routes/user-files";
import { filesRouter } from "../src/routes/files";
import { refreshSessionBlacklistKey, sha256Hex, signAccessToken, signUserSession } from "../src/middleware/auth";
import { signSecureFileData } from "../src/services/secure-file-serve";

function r2Object(key: string, body: Uint8Array, contentType = "application/octet-stream") {
  const storedBody = new Uint8Array(body);
  return {
    key,
    size: storedBody.byteLength,
    httpEtag: `"${key}-etag"`,
    body: new Response(storedBody).body,
    contentType,
    storedBody,
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", contentType);
    },
    arrayBuffer: vi.fn(async () => {
      const copy = new Uint8Array(storedBody.byteLength);
      copy.set(storedBody);
      return copy.buffer;
    }),
  };
}

function fakeEnv() {
  const files = new Map<string, ReturnType<typeof r2Object>>();
  const userFiles: any[] = [];
  const getCalls: Array<{ key: string; options: any }> = [];
  const cache = new Map<string, string>();
  const users = new Map<number, any>([
    [7, { id: 7, email: "user@example.com", username: "user@example.com", is_staff: 0, is_active: 1 }],
    [8, { id: 8, email: "other@example.com", username: "other@example.com", is_staff: 0, is_active: 1 }],
    [9, { id: 9, email: "staff@example.com", username: "staff@example.com", is_staff: 1, is_active: 1 }],
  ]);
  const memberships = new Map<string, string>([
    ["7:1", "ADMIN"],
    ["9:1", "ADMIN"],
  ]);
  const env = {
    ENVIRONMENT: "test",
    JWT_SIGNING_KEY: "test-secret",
    SECRET_KEY: "test-secret",
    PUBLIC_URL: "https://test.local",
    CACHE: {
      get: async (key: string) => cache.get(key) || null,
      put: async (key: string, value: string) => {
        cache.set(key, value);
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            return {
              first: async () => {
                if (sql.includes("FROM auth_user WHERE id")) {
                  return users.get(Number(args[0])) || null;
                }
                if (sql.includes("SELECT permissions FROM core_workspaceuser")) {
                  const role = memberships.get(`${Number(args[0])}:${Number(args[1])}`);
                  return role ? { permissions: role } : null;
                }
                if (sql.includes("SELECT * FROM core_userfile WHERE original_name")) {
                  return userFiles.find((file) => file.original_name === args[0] && file.sha256_hash === args[1]) || null;
                }
                if (sql.includes("INSERT INTO core_userfile")) {
                  const row = {
                    id: userFiles.length + 1,
                    user_id: args[0],
                    name: args[1],
                    original_name: args[2],
                    original_extension: args[3],
                    sha256_hash: args[4],
                    r2_key: args[5],
                    size: args[6],
                    mime_type: args[7],
                    is_image: args[8],
                    image_width: args[9],
                    image_height: args[10],
                    uploaded_at: args[11],
                    deleted_at: null,
                  };
                  userFiles.push(row);
                  return row;
                }
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => ({}),
            };
          },
        };
      },
    },
    FILES: {
      get: async (key: string, options?: any) => {
        getCalls.push({ key, options });
        const object = files.get(key);
        if (!object) return null;
        const range = options?.range;
        if (range && !(range instanceof Headers)) {
          const start = typeof range.suffix === "number"
            ? Math.max(object.storedBody.byteLength - range.suffix, 0)
            : Number(range.offset || 0);
          const length = typeof range.suffix === "number"
            ? object.storedBody.byteLength - start
            : Number(range.length || object.storedBody.byteLength - start);
          return r2Object(key, object.storedBody.slice(start, start + length), object.contentType);
        }
        return object;
      },
      put: async (key: string, body: BodyInit, options?: any) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        files.set(key, r2Object(key, bytes, options?.httpMetadata?.contentType || "application/octet-stream"));
        return {};
      },
      delete: async (key: string) => {
        files.delete(key);
      },
      head: async (key: string) => files.get(key) || null,
    },
  };
  return { env: env as any, files, getCalls, userFiles, users, memberships };
}

describe("media files", () => {
  it("serves R2 byte ranges with Supertask-compatible 206 headers", async () => {
    const { env, files, getCalls } = fakeEnv();
    const object = r2Object("user_files/sample.txt", new TextEncoder().encode("abcdef"), "text/plain");
    files.set("user_files/sample.txt", object);

    const response = await mediaRouter.fetch(new Request("https://test.local/user_files/sample.txt", {
      headers: { Range: "bytes=2-4" },
    }), env);

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("cde");
    expect(response.headers.get("Content-Range")).toBe("bytes 2-4/6");
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(object.arrayBuffer).not.toHaveBeenCalled();
    expect(getCalls).toEqual([{ key: "user_files/sample.txt", options: { range: { offset: 2, length: 3 } } }]);
  });

  it("serves suffix byte ranges for previews and media players", async () => {
    const { env, files } = fakeEnv();
    files.set("user_files/sample.txt", r2Object("user_files/sample.txt", new TextEncoder().encode("abcdef"), "text/plain"));

    const response = await mediaRouter.fetch(new Request("https://test.local/user_files/sample.txt", {
      headers: { Range: "bytes=-2" },
    }), env);

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("ef");
    expect(response.headers.get("Content-Range")).toBe("bytes 4-5/6");
  });

  it("rejects unsatisfiable byte ranges with 416", async () => {
    const { env, files } = fakeEnv();
    files.set("user_files/sample.txt", r2Object("user_files/sample.txt", new TextEncoder().encode("abcdef"), "text/plain"));

    const response = await mediaRouter.fetch(new Request("https://test.local/user_files/sample.txt", {
      headers: { Range: "bytes=10-12" },
    }), env);

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */6");
  });

  it("keeps /api/user-files media serving aligned with /media", async () => {
    const { env, files } = fakeEnv();
    files.set("user_files/sample.txt", r2Object("user_files/sample.txt", new TextEncoder().encode("abcdef"), "text/plain"));

    const response = await userFilesRouter.fetch(new Request("https://test.local/sample.txt", {
      headers: { Range: "bytes=1-3" },
    }), env);

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("bcd");
    expect(response.headers.get("Content-Range")).toBe("bytes 1-3/6");
  });

  it("serves /api/user-files HEAD with Supertask media headers", async () => {
    const { env, files } = fakeEnv();
    files.set("user_files/sample.txt", r2Object("user_files/sample.txt", new TextEncoder().encode("abcdef"), "text/plain"));

    const response = await userFilesRouter.fetch(new Request("https://test.local/sample.txt", {
      method: "HEAD",
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("6");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
  });

  it("returns Supertask-compatible upload-via-url errors instead of 500s", async () => {
    const { env } = fakeEnv();
    const token = await signAccessToken({ user_id: 7, email: "user@example.com" }, "test-secret", 60);

    const invalid = await userFilesRouter.fetch(new Request("https://test.local/upload-via-url/", {
      method: "POST",
      headers: {
        authorization: `JWT ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "ftp://example.com/file.txt" }),
    }), env);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "ERROR_INVALID_FILE_URL" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    try {
      const unreachable = await userFilesRouter.fetch(new Request("https://test.local/upload-via-url/", {
        method: "POST",
        headers: {
          authorization: `JWT ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/file.txt" }),
      }), env);
      expect(unreachable.status).toBe(400);
      expect(await unreachable.json()).toMatchObject({ error: "ERROR_FILE_URL_COULD_NOT_BE_REACHED" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("generates a MIME-derived filename when an upload URL has no path name", async () => {
    const { env } = fakeEnv();
    const token = await signAccessToken({ user_id: 7, email: "user@example.com" }, "test-secret", 60);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("remote text", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));

    try {
      const response = await userFilesRouter.fetch(new Request("https://test.local/upload-via-url/", {
        method: "POST",
        headers: {
          authorization: `JWT ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/" }),
      }), env);
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.original_name).toMatch(/^[a-f0-9]{12}\.txt$/);
      expect(body.name).toMatch(/^[a-f0-9]{32}_[a-f0-9]{64}\.txt$/);
      expect(body.mime_type).toBe("text/plain");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("blocks private upload URLs and redirects before a private fetch is attempted", async () => {
    const { env } = fakeEnv();
    const token = await signAccessToken({ user_id: 7, email: "user@example.com" }, "test-secret", 60);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private.txt" },
    }));

    try {
      const directPrivate = await userFilesRouter.fetch(new Request("https://test.local/upload-via-url/", {
        method: "POST",
        headers: {
          authorization: `JWT ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "http://127.0.0.1/private.txt" }),
      }), env);
      expect(directPrivate.status).toBe(400);
      expect(await directPrivate.json()).toMatchObject({ error: "ERROR_FILE_URL_COULD_NOT_BE_REACHED" });
      expect(fetchSpy).not.toHaveBeenCalled();

      const redirectPrivate = await userFilesRouter.fetch(new Request("https://test.local/upload-via-url/", {
        method: "POST",
        headers: {
          authorization: `JWT ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/redirect.txt" }),
      }), env);
      expect(redirectPrivate.status).toBe(400);
      expect(await redirectPrivate.json()).toMatchObject({ error: "ERROR_FILE_URL_COULD_NOT_BE_REACHED" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns the Supertask 413 contract for oversized direct and remote uploads", async () => {
    const { env } = fakeEnv();
    env.SUPERTASK_FILE_UPLOAD_SIZE_LIMIT_MB = "1";
    const token = await signAccessToken({ user_id: 7, email: "user@example.com" }, "test-secret", 60);
    const formData = new FormData();
    formData.set("file", new File([new Uint8Array(1024 * 1024 + 1)], "large.bin"));
    const direct = await userFilesRouter.fetch(new Request("https://test.local/upload-file/", {
      method: "POST",
      headers: { authorization: `JWT ${token}` },
      body: formData,
    }), env);
    expect(direct.status).toBe(413);
    expect(await direct.json()).toEqual({
      error: "ERROR_FILE_SIZE_TOO_LARGE",
      detail: "The provided file is too large. Max 1MB is allowed.",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(2 * 1024 * 1024),
      },
    }));
    try {
      const remote = await userFilesRouter.fetch(new Request("https://test.local/upload-via-url/", {
        method: "POST",
        headers: {
          authorization: `JWT ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/large.bin" }),
      }), env);
      expect(remote.status).toBe(413);
      expect(await remote.json()).toMatchObject({ error: "ERROR_FILE_SIZE_TOO_LARGE" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("copies secure backend file URLs through upload-via-url without fetching itself", async () => {
    const { env, files } = fakeEnv();
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND = "true";
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_PERMISSION = "DISABLED";
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS = "0";
    files.set("user_files/source.txt", r2Object("user_files/source.txt", new TextEncoder().encode("source"), "text/plain"));
    const token = await signAccessToken({ user_id: 7, email: "user@example.com" }, "test-secret", 60);
    const signedFile = await signSecureFileData(env, "user_files/source.txt", 1);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("self fetch should not happen"));

    try {
      const response = await userFilesRouter.fetch(new Request("https://test.local/upload-via-url/", {
        method: "POST",
        headers: {
          authorization: `JWT ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: `https://test.local/api/files/${encodeURIComponent(signedFile)}`,
          name: "Copied text.txt",
        }),
      }), env);
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(body.original_name).toBe("Copied text.txt");
      expect(body.visible_name).toBeUndefined();
      expect(body.mime_type).toBe("text/plain");
      expect(body.url).toContain("https://test.local/api/files/");
      expect(body.url).not.toContain("/media/");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("serves named image thumbnails through the Cloudflare Images binding", async () => {
    const { env, files } = fakeEnv();
    const calls: any[] = [];
    files.set("user_files/sample.png", r2Object("user_files/sample.png", new Uint8Array([1, 2, 3]), "image/png"));
    env.IMAGES = {
      input() {
        return {
          transform(options: any) {
            calls.push(options);
            return this;
          },
          async output(options: any) {
            calls.push(options);
            return {
              response() {
                return new Response("thumbnail-bytes", { headers: { "Content-Type": options.format } });
              },
            };
          },
        };
      },
    } as any;

    const response = await mediaRouter.fetch(new Request("https://test.local/user_files/sample.png?thumbnail=tiny"), env as any);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("thumbnail-bytes");
    expect(calls[0]).toEqual({ height: 21, fit: "cover" });
    expect(calls[1]).toEqual({ format: "image/png", quality: 85, anim: false });
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
  });

  it("serves secure signed files with inline, attachment and range headers", async () => {
    const { env, files } = fakeEnv();
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND = "true";
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_PERMISSION = "DISABLED";
    files.set("user_files/sample.txt", r2Object("user_files/sample.txt", new TextEncoder().encode("abcdef"), "text/plain"));
    const signed = await signSecureFileData(env, "user_files/sample.txt");

    const inline = await filesRouter.fetch(new Request(`https://test.local/${signed}`), env);
    expect(inline.status).toBe(200);
    expect(await inline.text()).toBe("abcdef");
    expect(inline.headers.get("Content-Disposition")).toBe('inline; filename="sample.txt"');

    const attachment = await filesRouter.fetch(new Request(`https://test.local/${signed}?dl=download.txt`, {
      headers: { Range: "bytes=1-3" },
    }), env);
    expect(attachment.status).toBe(206);
    expect(await attachment.text()).toBe("bcd");
    expect(attachment.headers.get("Content-Range")).toBe("bytes 1-3/6");
    expect(attachment.headers.get("Content-Disposition")).toBe('attachment; filename="download.txt"');
  });

  it("requires a valid user session cookie for secure signed-in downloads", async () => {
    const { env, files } = fakeEnv();
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND = "true";
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_PERMISSION = "SIGNED_IN";
    files.set("user_files/private.txt", r2Object("user_files/private.txt", new TextEncoder().encode("private"), "text/plain"));
    const signed = await signSecureFileData(env, "user_files/private.txt");

    const anonymous = await filesRouter.fetch(new Request(`https://test.local/${signed}`), env);
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({ error: "ERROR_SECURE_FILE_SERVE_EXCEPTION" });

    const refresh = "refresh-token-for-file-session";
    const userSession = await signUserSession({ user_id: 7 }, refresh, env.JWT_SIGNING_KEY, 7);
    const authenticated = await filesRouter.fetch(new Request(`https://test.local/${signed}`, {
      headers: { Cookie: `user_session=${encodeURIComponent(userSession)}` },
    }), env);
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toBe("private");

    await env.CACHE.put(refreshSessionBlacklistKey(await sha256Hex(refresh)), "1");
    const signedOut = await filesRouter.fetch(new Request(`https://test.local/${signed}`, {
      headers: { Cookie: `user_session=${encodeURIComponent(userSession)}` },
    }), env);
    expect(signedOut.status).toBe(403);
  });

  it("rejects expired secure file links for anonymous and authenticated users", async () => {
    vi.useFakeTimers();
    try {
      const { env, files } = fakeEnv();
      env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND = "true";
      env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_PERMISSION = "SIGNED_IN";
      env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS = "59";
      files.set("user_files/expiring.txt", r2Object("user_files/expiring.txt", new TextEncoder().encode("expires"), "text/plain"));
      vi.setSystemTime(new Date("2026-07-11T00:00:00Z"));
      const signed = await signSecureFileData(env, "user_files/expiring.txt");
      const userSession = await signUserSession({ user_id: 7 }, "refresh", env.JWT_SIGNING_KEY, 7);

      const beforeExpiry = await filesRouter.fetch(new Request(`https://test.local/${signed}`, {
        headers: { Cookie: `user_session=${encodeURIComponent(userSession)}` },
      }), env);
      expect(beforeExpiry.status).toBe(200);

      vi.setSystemTime(new Date("2026-07-11T00:01:00Z"));
      const afterExpiry = await filesRouter.fetch(new Request(`https://test.local/${signed}`, {
        headers: { Cookie: `user_session=${encodeURIComponent(userSession)}` },
      }), env);
      expect(afterExpiry.status).toBe(403);
      expect(await afterExpiry.json()).toMatchObject({ error: "ERROR_SECURE_FILE_SERVE_EXCEPTION" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects secure downloads after the authenticated user is deactivated", async () => {
    const { env, files, users } = fakeEnv();
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND = "true";
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_PERMISSION = "SIGNED_IN";
    files.set("user_files/private.txt", r2Object("user_files/private.txt", new TextEncoder().encode("private"), "text/plain"));
    const signed = await signSecureFileData(env, "user_files/private.txt");
    const userSession = await signUserSession({ user_id: 7 }, "refresh", env.JWT_SIGNING_KEY, 7);
    users.get(7).is_active = 0;

    const response = await filesRouter.fetch(new Request(`https://test.local/${signed}`, {
      headers: { Cookie: `user_session=${encodeURIComponent(userSession)}` },
    }), env);
    expect(response.status).toBe(403);
  });

  it("enforces workspace access for signed file URLs carrying a workspace id", async () => {
    const { env, files } = fakeEnv();
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND = "true";
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_PERMISSION = "WORKSPACE_ACCESS";
    files.set("exports/workspace.csv", r2Object("exports/workspace.csv", new TextEncoder().encode("csv"), "text/csv"));
    const allowed = await signSecureFileData(env, "exports/workspace.csv", 1);
    const denied = await signSecureFileData(env, "exports/workspace.csv", 2);
    const userSession = await signUserSession({ user_id: 7 }, "refresh", env.JWT_SIGNING_KEY, 7);

    const ok = await filesRouter.fetch(new Request(`https://test.local/${allowed}`, {
      headers: { Cookie: `user_session=${encodeURIComponent(userSession)}` },
    }), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("csv");

    const forbidden = await filesRouter.fetch(new Request(`https://test.local/${denied}`, {
      headers: { Cookie: `user_session=${encodeURIComponent(userSession)}` },
    }), env);
    expect(forbidden.status).toBe(403);
  });

  it("allows staff files without a workspace but not files from an inaccessible workspace", async () => {
    const { env, files } = fakeEnv();
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND = "true";
    env.SUPERTASK_SERVE_FILES_THROUGH_BACKEND_PERMISSION = "WORKSPACE_ACCESS";
    files.set("exports/admin.csv", r2Object("exports/admin.csv", new TextEncoder().encode("csv"), "text/csv"));
    const unscoped = await signSecureFileData(env, "exports/admin.csv", null);
    const inaccessible = await signSecureFileData(env, "exports/admin.csv", 2);
    const staffSession = await signUserSession({ user_id: 9 }, "staff-refresh", env.JWT_SIGNING_KEY, 7);
    const headers = { Cookie: `user_session=${encodeURIComponent(staffSession)}` };

    const allowed = await filesRouter.fetch(new Request(`https://test.local/${unscoped}`, { headers }), env);
    expect(allowed.status).toBe(200);
    const denied = await filesRouter.fetch(new Request(`https://test.local/${inaccessible}`, { headers }), env);
    expect(denied.status).toBe(403);
  });
});
