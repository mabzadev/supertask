import { Hono, type Context } from "hono";
import type { Env, RequestVariables } from "../types/env";

const media = new Hono<{ Bindings: Env; Variables: RequestVariables }>();
type AppContext = Context<{ Bindings: Env; Variables: RequestVariables }>;
type ParsedRange = { start: number; end: number };
type ThumbnailPreset = {
  name: "tiny" | "small" | "card_cover";
  width: number | null;
  height: number;
  fit: "cover";
};
type ServeOptions = {
  downloadName?: string;
  fallbackName?: string;
};

const THUMBNAIL_PRESETS: Record<string, ThumbnailPreset> = {
  tiny: { name: "tiny", width: null, height: 21, fit: "cover" },
  small: { name: "small", width: 48, height: 48, fit: "cover" },
  card_cover: { name: "card_cover", width: 300, height: 160, fit: "cover" },
};
const TRANSFORMABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

function decodeMediaKey(rawKey: string): string {
  return rawKey
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
}

function objectHeaders(object: R2Object | R2ObjectBody): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(object.size));
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }
  return headers;
}

function quotedFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, "_");
}

function applyContentDisposition(headers: Headers, options?: ServeOptions) {
  const downloadName = options?.downloadName || "";
  const fallbackName = options?.fallbackName || "";
  if (downloadName) {
    headers.set("Content-Disposition", `attachment; filename="${quotedFilename(downloadName)}"`);
  } else if (fallbackName) {
    headers.set("Content-Disposition", `inline; filename="${quotedFilename(fallbackName)}"`);
  }
}

function thumbnailPreset(c: AppContext): ThumbnailPreset | null {
  const name = c.req.query("thumbnail");
  return name ? THUMBNAIL_PRESETS[name] || null : null;
}

function normalizeContentType(headers: Headers): string {
  return (headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
}

function outputFormatForSource(contentType: string): ImageOutputOptions["format"] {
  if (contentType === "image/jpeg") return "image/jpeg";
  if (contentType === "image/png") return "image/png";
  if (contentType === "image/gif") return "image/gif";
  if (contentType === "image/avif") return "image/avif";
  return "image/webp";
}

function transformedHeaders(response: Response, preset: ThumbnailPreset): Headers {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "none");
  headers.set("X-Opentabl-Thumbnail", preset.name);
  return headers;
}

function thumbnailTransformOptions(preset: ThumbnailPreset) {
  return {
    ...(preset.width === null ? {} : { width: preset.width }),
    height: preset.height,
    fit: preset.fit,
  };
}

async function transformWithImagesBinding(
  c: AppContext,
  key: string,
  contentType: string,
  preset: ThumbnailPreset
): Promise<Response | null> {
  if (!c.env.IMAGES?.input) return null;
  const object = await c.env.FILES.get(key);
  if (!object?.body) return null;

  const result = await c.env.IMAGES.input(object.body)
    .transform(thumbnailTransformOptions(preset))
    .output({ format: outputFormatForSource(contentType), quality: 85, anim: false });
  const response = result.response();
  return new Response(response.body, {
    status: response.status,
    headers: transformedHeaders(response, preset),
  });
}

async function transformWithCfImageFetch(c: AppContext, preset: ThumbnailPreset): Promise<Response | null> {
  if (c.env.ENVIRONMENT !== "production") return null;
  const sourceUrl = new URL(c.req.url);
  if (sourceUrl.protocol !== "https:") return null;
  sourceUrl.searchParams.delete("thumbnail");

  const response = await fetch(sourceUrl.toString(), {
    cf: {
      image: {
        ...thumbnailTransformOptions(preset),
        quality: 85,
        metadata: "none",
        anim: false,
      },
    },
  });
  if (!response.ok) return null;
  return new Response(response.body, {
    status: response.status,
    headers: transformedHeaders(response, preset),
  });
}

async function serveThumbnail(c: AppContext, key: string, object: R2Object | R2ObjectBody, preset: ThumbnailPreset): Promise<Response | null> {
  const headers = objectHeaders(object);
  const contentType = normalizeContentType(headers);
  if (!TRANSFORMABLE_IMAGE_TYPES.has(contentType)) return null;

  try {
    return (await transformWithImagesBinding(c, key, contentType, preset)) || (await transformWithCfImageFetch(c, preset));
  } catch (error) {
    console.warn("[media] thumbnail-transform-failed", { key, preset: preset.name, error: String(error) });
    return null;
  }
}

function parseByteRange(rangeHeader: string | undefined, size: number): ParsedRange | null | "invalid" {
  if (!rangeHeader) return null;
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size < 1) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    const length = Math.min(suffixLength, size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serveR2Object(c: AppContext, key: string, options?: ServeOptions): Promise<Response> {
  const object = await c.env.FILES.head(key);
  if (!object) {
    return c.json({ error: "NOT_FOUND", detail: "File not found." }, 404);
  }

  const preset = thumbnailPreset(c);
  if (preset) {
    const thumbnail = await serveThumbnail(c, key, object, preset);
    if (thumbnail) return thumbnail;
  }

  const headers = objectHeaders(object);
  applyContentDisposition(headers, options);
  const range = parseByteRange(c.req.header("Range"), object.size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${object.size}`,
      },
    });
  }
  if (range) {
    const length = range.end - range.start + 1;
    const rangedObject = await c.env.FILES.get(key, {
      range: {
        offset: range.start,
        length,
      },
    });
    if (!rangedObject?.body) {
      return c.json({ error: "NOT_FOUND", detail: "File not found." }, 404);
    }
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${object.size}`);
    return new Response(rangedObject.body, {
      status: 206,
      headers,
    });
  }

  const bodyObject = await c.env.FILES.get(key);
  if (!bodyObject?.body) {
    return c.json({ error: "NOT_FOUND", detail: "File not found." }, 404);
  }

  return new Response(bodyObject.body, {
    headers,
  });
}

media.get("/:key{.+}", async (c) => {
  return serveR2Object(c, decodeMediaKey(c.req.param("key")));
});

media.on("HEAD", "/:key{.+}", async (c) => {
  const key = decodeMediaKey(c.req.param("key"));
  const object = await c.env.FILES.head(key);
  if (!object) return new Response(null, { status: 404 });
  return new Response(null, { headers: objectHeaders(object) });
});

export { media as mediaRouter, serveR2Object };
