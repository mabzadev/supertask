import { createHash } from "node:crypto";
import type { Env } from "../types/env";
import { ensureUserTableSystemColumns } from "./dynamic-tables";
import { buildFileUrl, publicMediaUrl, secureFileServeEnabled } from "./secure-file-serve";

export interface StoredUserFile {
  id: number;
  user_id: number | null;
  name: string;
  original_name: string;
  original_extension?: string | null;
  sha256_hash?: string | null;
  deleted_at?: string | null;
  r2_key: string;
  size: number;
  mime_type: string;
  is_image: number;
  image_width: number | null;
  image_height: number | null;
  uploaded_at: string;
}

type UserFileReferenceScanRow = Record<string, unknown>;

const BYTES_PER_MEGABYTE = 1024 * 1024;
const SUPERTASK_DEFAULT_FILE_UPLOAD_LIMIT_MB = 1024 * 1024;
// A Worker isolate has 128 MB. Streams up to this size are read into memory to
// be hashed and probed; larger ones are copied part by part instead.
const IN_MEMORY_FILE_LIMIT_BYTES = 16 * BYTES_PER_MEGABYTE;
// R2 multipart parts must all have the same size (at least 5 MiB), except the last.
const R2_UPLOAD_PART_BYTES = 8 * BYTES_PER_MEGABYTE;
const IMAGE_HEADER_PROBE_BYTES = 512 * 1024;
// The final key holds the sha256 of the content, known only once the whole
// stream has been read, so large files are first written under this prefix.
const STAGED_UPLOAD_PREFIX = "user_files_staging/";

export class UserFileSizeTooLargeError extends Error {
  readonly maxSizeBytes: number;
  readonly maxSizeMb: number;

  constructor(maxSizeBytes: number) {
    super("The provided file is too large.");
    this.name = "UserFileSizeTooLargeError";
    this.maxSizeBytes = maxSizeBytes;
    this.maxSizeMb = Math.floor(maxSizeBytes / BYTES_PER_MEGABYTE);
  }
}

export function userFileUploadSizeLimitBytes(env: Pick<Env, "SUPERTASK_FILE_UPLOAD_SIZE_LIMIT_MB">): number {
  const configuredMb = Number(env.SUPERTASK_FILE_UPLOAD_SIZE_LIMIT_MB);
  const maxMb = Number.isFinite(configuredMb) && configuredMb > 0
    ? configuredMb
    : SUPERTASK_DEFAULT_FILE_UPLOAD_LIMIT_MB;
  return Math.floor(maxMb * BYTES_PER_MEGABYTE);
}

export function userFileSizeTooLargeResponse(error: UserFileSizeTooLargeError): {
  error: "ERROR_FILE_SIZE_TOO_LARGE";
  detail: string;
} {
  return {
    error: "ERROR_FILE_SIZE_TOO_LARGE",
    detail: `The provided file is too large. Max ${error.maxSizeMb}MB is allowed.`,
  };
}

function assertWithinFileSizeLimit(size: number, maxSizeBytes: number): void {
  if (Number.isFinite(size) && size > maxSizeBytes) {
    throw new UserFileSizeTooLargeError(maxSizeBytes);
  }
}

function randomHex(bytes = 16): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanOriginalFilename(name: string): string {
  const base = (name || "file").split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned || "file";
}

function truncateMiddle(value: string, maxLength: number, middle = "..."): string {
  if (value.length <= maxLength) return value;
  const remaining = maxLength - middle.length;
  if (remaining <= 0) return value.slice(0, maxLength);
  const left = Math.ceil(remaining / 2);
  const right = Math.floor(remaining / 2);
  return `${value.slice(0, left)}${middle}${value.slice(value.length - right)}`;
}

function originalExtension(fileName: string): string {
  const lastSegment = fileName.split(/[\\/]/).pop() || "";
  const dot = lastSegment.lastIndexOf(".");
  if (dot === -1 || dot === lastSegment.length - 1) return "";
  return lastSegment.slice(dot + 1).toLowerCase();
}

async function putR2ObjectWithRetry(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
  options: R2PutOptions,
  attempts = 3
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`R2 put timed out after 10000ms on attempt ${attempt}`)), 10000);
      });
      await Promise.race([bucket.put(key, body, options), timeout]);
      return;
    } catch (error) {
      lastError = error;
      console.warn("[user-files] store:r2-put:retry", { key, attempt, error: String(error) });
      if (attempt < attempts) await sleep(250 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function uploadPartWithRetry(
  upload: R2MultipartUpload,
  partNumber: number,
  value: Uint8Array,
  attempts = 3
): Promise<R2UploadedPart> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`R2 part upload timed out after 30000ms on attempt ${attempt}`)), 30000);
      });
      return await Promise.race([upload.uploadPart(partNumber, value), timeout]);
    } catch (error) {
      lastError = error;
      console.warn("[user-files] store:r2-part:retry", { key: upload.key, partNumber, attempt, error: String(error) });
      if (attempt < attempts) await sleep(250 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Writes a stream to R2 one part at a time, so only one part is ever held in
// memory whatever the size of the file. A multipart upload also accepts a
// stream whose length is unknown, which a plain put does not.
async function uploadStreamToR2(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  options: R2MultipartOptions
): Promise<void> {
  const upload = await bucket.createMultipartUpload(key, options);
  const parts: R2UploadedPart[] = [];
  const reader = stream.getReader();
  let part = new Uint8Array(R2_UPLOAD_PART_BYTES);
  let partLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      let offset = 0;
      while (offset < value.byteLength) {
        const copied = Math.min(part.byteLength - partLength, value.byteLength - offset);
        part.set(value.subarray(offset, offset + copied), partLength);
        partLength += copied;
        offset += copied;
        if (partLength === part.byteLength) {
          parts.push(await uploadPartWithRetry(upload, parts.length + 1, part));
          part = new Uint8Array(R2_UPLOAD_PART_BYTES);
          partLength = 0;
        }
      }
    }
    if (partLength > 0 || parts.length === 0) {
      parts.push(await uploadPartWithRetry(upload, parts.length + 1, part.subarray(0, partLength)));
    }
    await upload.complete(parts);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await upload.abort().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function sanitizeFilename(name: string): string {
  const fallback = "file";
  const safe = (name || fallback).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "");
  return safe || fallback;
}

function guessMimeType(fileName: string, contentType?: string | null): string {
  const normalized = (contentType || "").split(";")[0].trim().toLowerCase();
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  const known: Record<string, string> = {
    "7z": "application/x-7z-compressed",
    avif: "image/avif",
    avi: "video/x-msvideo",
    bmp: "image/bmp",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    gif: "image/gif",
    gz: "application/gzip",
    heic: "image/heic",
    heif: "image/heif",
    html: "text/html",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mpeg: "video/mpeg",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    ogv: "video/ogg",
    pdf: "application/pdf",
    png: "image/png",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rar: "application/vnd.rar",
    svg: "image/svg+xml",
    tar: "application/x-tar",
    tif: "image/tiff",
    tiff: "image/tiff",
    txt: "text/plain",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    zip: "application/zip",
  };
  return known[extension] || normalized || "application/octet-stream";
}

type UserFileContent = { bytes: ArrayBuffer; stream?: never } | { stream: ReadableStream<Uint8Array>; bytes?: never };

// Returns the content in memory when it already is, or when a stream ends
// within IN_MEMORY_FILE_LIMIT_BYTES. A longer stream comes back as a stream
// that replays what was read and then continues with the rest.
async function readUserFileContent(
  body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
  maxSizeBytes: number
): Promise<UserFileContent> {
  if (body instanceof ArrayBuffer) {
    assertWithinFileSizeLimit(body.byteLength, maxSizeBytes);
    return { bytes: body };
  }
  if (ArrayBuffer.isView(body)) {
    assertWithinFileSizeLimit(body.byteLength, maxSizeBytes);
    const copy = new Uint8Array(body.byteLength);
    copy.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return { bytes: copy.buffer };
  }
  if (typeof body === "string") {
    const encoded = new TextEncoder().encode(body);
    assertWithinFileSizeLimit(encoded.byteLength, maxSizeBytes);
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    return { bytes: copy.buffer };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    assertWithinFileSizeLimit(body.size, maxSizeBytes);
    return { bytes: await body.arrayBuffer() };
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  let ended = false;
  try {
    while (totalSize <= IN_MEMORY_FILE_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      if (!value) continue;
      totalSize += value.byteLength;
      assertWithinFileSizeLimit(totalSize, maxSizeBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    reader.releaseLock();
    throw error;
  }

  if (!ended) {
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const buffered = chunks.shift();
        if (buffered) {
          controller.enqueue(buffered);
          return;
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else if (value) controller.enqueue(value);
      },
      async cancel(reason) {
        chunks.length = 0;
        await reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
    return { stream };
  }

  reader.releaseLock();
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: bytes.buffer };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function imageDimensionsFromBytes(buffer: ArrayBuffer): { width: number; height: number; mimeType: string } | null {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length >= 24 && bytes[0] === 0x89 && readAscii(bytes, 1, 3) === "PNG") {
    return { width: view.getUint32(16), height: view.getUint32(20), mimeType: "image/png" };
  }
  if (bytes.length >= 10 && (readAscii(bytes, 0, 6) === "GIF87a" || readAscii(bytes, 0, 6) === "GIF89a")) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true), mimeType: "image/gif" };
  }
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WEBP") {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkType = readAscii(bytes, offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      const dataOffset = offset + 8;
      if (chunkType === "VP8X" && dataOffset + 10 <= bytes.length) {
        return {
          width: readUint24LE(bytes, dataOffset + 4) + 1,
          height: readUint24LE(bytes, dataOffset + 7) + 1,
          mimeType: "image/webp",
        };
      }
      if (chunkType === "VP8L" && dataOffset + 5 <= bytes.length && bytes[dataOffset] === 0x2f) {
        const b1 = bytes[dataOffset + 1];
        const b2 = bytes[dataOffset + 2];
        const b3 = bytes[dataOffset + 3];
        const b4 = bytes[dataOffset + 4];
        return {
          width: 1 + (((b2 & 0x3f) << 8) | b1),
          height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
          mimeType: "image/webp",
        };
      }
      if (chunkType === "VP8 " && dataOffset + 10 <= bytes.length) {
        return {
          width: view.getUint16(dataOffset + 6, true) & 0x3fff,
          height: view.getUint16(dataOffset + 8, true) & 0x3fff,
          mimeType: "image/webp",
        };
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      const isStartOfFrame = (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      );
      if (isStartOfFrame && offset + 8 < bytes.length) {
        return {
          width: view.getUint16(offset + 7),
          height: view.getUint16(offset + 5),
          mimeType: "image/jpeg",
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function imageMimeType(format: string): string {
  const normalized = format.trim().toLowerCase();
  if (normalized.startsWith("image/")) return normalized;
  if (normalized === "jpg") return "image/jpeg";
  return `image/${normalized}`;
}

async function imageDimensions(
  env: Env,
  buffer: ArrayBuffer
): Promise<{ width: number; height: number; mimeType: string } | null> {
  const parsed = imageDimensionsFromBytes(buffer);
  if (parsed) return parsed;
  if (!env.IMAGES?.info) return null;
  try {
    const info = await env.IMAGES.info(new Response(buffer).body!);
    if (!("width" in info) || !("height" in info)) return null;
    return {
      width: info.width,
      height: info.height,
      mimeType: imageMimeType(info.format),
    };
  } catch {
    return null;
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function collectUserFileNamesFromValue(value: unknown): Set<string> {
  const names = new Set<string>();
  const parsed = parseMaybeJson(value);
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    const file = item as Record<string, unknown>;
    const name = typeof file.name === "string" ? file.name : "";
    if (name && file.external !== true) names.add(name);
  };
  visit(parsed);
  return names;
}

export function collectUserFileNamesFromRecord(row: UserFileReferenceScanRow): Set<string> {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(row)) {
    if (!/^field_\d+$/.test(key)) continue;
    for (const name of collectUserFileNamesFromValue(value)) names.add(name);
  }
  return names;
}

async function collectUserFileNamesFromTableFields(
  db: D1Database,
  tableId: number,
  fieldIds: number[],
  activeOnly = false
): Promise<Set<string>> {
  const names = new Set<string>();
  if (fieldIds.length === 0) return names;
  const columns = fieldIds.map((id) => `"field_${id}"`).join(", ");
  try {
    if (activeOnly) await ensureUserTableSystemColumns(db, tableId);
    const rows = await db.prepare(
      `SELECT ${columns} FROM "database_table_${tableId}"${activeOnly ? " WHERE COALESCE(trashed, 0)=0" : ""}`
    ).all<UserFileReferenceScanRow>();
    for (const row of rows.results || []) {
      for (const name of collectUserFileNamesFromRecord(row)) names.add(name);
    }
  } catch (error) {
    console.warn("[user-files] collect:table-fields-failed", { tableId, error: String(error) });
  }
  return names;
}

async function fileFieldIdsForTable(db: D1Database, tableId: number, fieldId?: number): Promise<number[]> {
  const sql = fieldId
    ? "SELECT id FROM database_field WHERE table_id=? AND id=? AND type='file'"
    : "SELECT id FROM database_field WHERE table_id=? AND type='file'";
  const rows = fieldId
    ? await db.prepare(sql).bind(tableId, fieldId).all<{ id: number }>()
    : await db.prepare(sql).bind(tableId).all<{ id: number }>();
  return (rows.results || []).map((field) => Number(field.id)).filter(Number.isFinite);
}

export async function collectUserFileNamesFromTable(
  db: D1Database,
  tableId: number,
  fieldId?: number
): Promise<Set<string>> {
  const fieldIds = await fileFieldIdsForTable(db, tableId, fieldId);
  return collectUserFileNamesFromTableFields(db, tableId, fieldIds);
}

export async function collectUserFileNamesFromApplication(db: D1Database, applicationId: number): Promise<Set<string>> {
  const names = new Set<string>();
  const tables = await db.prepare("SELECT id FROM database_table WHERE database_id=?").bind(applicationId).all<{ id: number }>();
  for (const table of tables.results || []) {
    for (const name of await collectUserFileNamesFromTable(db, Number(table.id))) names.add(name);
  }
  return names;
}

export async function collectUserFileNamesFromWorkspace(db: D1Database, workspaceId: number): Promise<Set<string>> {
  const names = new Set<string>();
  const tables = await db.prepare(
    `SELECT t.id
     FROM database_table t
     JOIN core_application a ON a.id=t.database_id
     WHERE a.workspace_id=?`
  ).bind(workspaceId).all<{ id: number }>();
  for (const table of tables.results || []) {
    for (const name of await collectUserFileNamesFromTable(db, Number(table.id))) names.add(name);
  }
  return names;
}

async function referencedUserFileNames(db: D1Database, candidates: Set<string>): Promise<Set<string>> {
  const referenced = new Set<string>();
  if (candidates.size === 0) return referenced;
  let fields;
  try {
    fields = await db.prepare(
      `SELECT f.id, f.table_id
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspace w ON w.id=a.workspace_id
       WHERE f.type='file' AND f.trashed=0 AND t.trashed=0 AND a.trashed=0 AND COALESCE(w.trashed, 0)=0`
    ).all<{ id: number; table_id: number }>();
  } catch (error: any) {
    if (!String(error?.message || error).includes("w.trashed")) throw error;
    fields = await db.prepare(
      `SELECT f.id, f.table_id
       FROM database_field f
       JOIN database_table t ON t.id=f.table_id
       JOIN core_application a ON a.id=t.database_id
       WHERE f.type='file' AND f.trashed=0 AND t.trashed=0 AND a.trashed=0`
    ).all<{ id: number; table_id: number }>();
  }
  const byTable = new Map<number, number[]>();
  for (const field of fields.results || []) {
    const tableId = Number(field.table_id);
    const fieldIds = byTable.get(tableId) || [];
    fieldIds.push(Number(field.id));
    byTable.set(tableId, fieldIds);
  }
  for (const [tableId, fieldIds] of byTable) {
    const names = await collectUserFileNamesFromTableFields(db, tableId, fieldIds, true);
    for (const name of names) if (candidates.has(name)) referenced.add(name);
  }
  const trashRows = await db.prepare(
    "SELECT extra_description FROM core_trasheditem WHERE trash_item_type='row' AND should_be_permanently_deleted=0"
  ).all<{ extra_description: string }>();
  for (const row of trashRows.results || []) {
    const parsed = parseMaybeJson(row.extra_description);
    if (!parsed || typeof parsed !== "object") continue;
    const record = (parsed as Record<string, unknown>).row;
    if (!record || typeof record !== "object") continue;
    for (const name of collectUserFileNamesFromRecord(record as UserFileReferenceScanRow)) {
      if (candidates.has(name)) referenced.add(name);
    }
  }
  return referenced;
}

export async function deleteUnreferencedUserFiles(env: Env, names: Iterable<string>): Promise<number> {
  const uniqueNames = Array.from(new Set(Array.from(names).filter(Boolean)));
  const referenced = await referencedUserFileNames(env.DB, new Set(uniqueNames));
  const referencedNames = uniqueNames.filter((name) => referenced.has(name));
  if (referencedNames.length > 0) {
    for (let index = 0; index < referencedNames.length; index += 50) {
      const chunk = referencedNames.slice(index, index + 50);
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE core_userfile SET deleted_at=NULL WHERE name IN (${placeholders})`
      ).bind(...chunk).run();
    }
  }
  const deletableNames = uniqueNames.filter((name) => !referenced.has(name));
  if (deletableNames.length === 0) return 0;

  let files: StoredUserFile[];
  try {
    const placeholders = deletableNames.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT * FROM core_userfile WHERE name IN (${placeholders})`
    ).bind(...deletableNames).all<StoredUserFile>();
    files = result.results || [];
  } catch (error: any) {
    if (String(error?.message || error).includes("core_userfile")) return 0;
    throw error;
  }
  if (files.length === 0) return 0;

  await env.FILES.delete(files.map((file) => file.r2_key));
  await env.DB.batch(files.map((file) => (
    env.DB.prepare("DELETE FROM core_userfile WHERE id=?").bind(file.id)
  )));
  return files.length;
}

export async function scheduleUnreferencedUserFilesForDeletion(env: Env, names: Iterable<string>): Promise<number> {
  const uniqueNames = Array.from(new Set(Array.from(names).filter(Boolean)));
  if (uniqueNames.length === 0) return 0;
  const referenced = await referencedUserFileNames(env.DB, new Set(uniqueNames));
  const candidates = uniqueNames.filter((name) => !referenced.has(name));
  if (candidates.length === 0) return 0;
  const now = new Date().toISOString();
  let scheduled = 0;
  for (let index = 0; index < candidates.length; index += 50) {
    const chunk = candidates.slice(index, index + 50);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `UPDATE core_userfile
          SET deleted_at=COALESCE(deleted_at, ?)
        WHERE name IN (${placeholders})`
    ).bind(now, ...chunk).run() as any;
    scheduled += Number(result?.meta?.changes ?? result?.changes ?? chunk.length);
  }
  return scheduled;
}

export async function cleanupExpiredUserFiles(env: Env, retentionHours = 48, limit = 100): Promise<number> {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
  let rows;
  try {
    rows = await env.DB.prepare(
      "SELECT name FROM core_userfile WHERE deleted_at IS NOT NULL AND deleted_at<=? ORDER BY deleted_at ASC LIMIT ?"
    ).bind(cutoff, limit).all<{ name: string }>();
  } catch (error: any) {
    if (String(error?.message || error).includes("deleted_at")) return 0;
    throw error;
  }
  return deleteUnreferencedUserFiles(env, (rows.results || []).map((row) => row.name));
}

export function buildPublicUrl(env: Env, key: string): string {
  return publicMediaUrl(env, key);
}

export function serializeUserFile(env: Env, file: StoredUserFile): object {
  const url = buildPublicUrl(env, file.r2_key);
  const thumbnails = Boolean(file.is_image)
    ? {
        tiny: { url: `${url}?thumbnail=tiny`, width: null, height: 21 },
        small: { url: `${url}?thumbnail=small`, width: 48, height: 48 },
        card_cover: { url: `${url}?thumbnail=card_cover`, width: 300, height: 160 },
      }
    : null;

  return {
    url,
    thumbnails,
    original_name: file.original_name,
    name: file.name,
    size: file.size,
    mime_type: file.mime_type,
    is_image: Boolean(file.is_image),
    image_width: file.image_width,
    image_height: file.image_height,
    uploaded_at: file.uploaded_at,
  };
}

export function serializeUserFileCell(
  env: Env,
  file: StoredUserFile,
  visibleName = file.original_name
): object {
  const { original_name: _originalName, ...serialized } = serializeUserFile(env, file) as Record<string, unknown>;
  return { ...serialized, visible_name: visibleName };
}

export async function serializeUserFileForRequest(
  env: Env,
  file: StoredUserFile,
  workspaceId?: number | null
): Promise<object> {
  if (!secureFileServeEnabled(env)) return serializeUserFile(env, file);
  const url = await buildFileUrl(env, file.r2_key, workspaceId);
  const base = serializeUserFile(env, file) as Record<string, unknown>;
  const thumbnails = Boolean(file.is_image)
    ? {
        tiny: { url: `${url}?thumbnail=tiny`, width: null, height: 21 },
        small: { url: `${url}?thumbnail=small`, width: 48, height: 48 },
        card_cover: { url: `${url}?thumbnail=card_cover`, width: 300, height: 160 },
      }
    : null;
  return { ...base, url, thumbnails };
}

export async function serializeUserFileCellForRequest(
  env: Env,
  file: StoredUserFile,
  workspaceId?: number | null,
  visibleName = file.original_name
): Promise<object> {
  const { original_name: _originalName, ...serialized } = await serializeUserFileForRequest(env, file, workspaceId) as Record<string, unknown>;
  return { ...serialized, visible_name: visibleName };
}

export async function storeUserFile(
  env: Env,
  input: {
    userId: number | null;
    fileName: string;
    contentType?: string | null;
    size?: number;
    body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;
    onCreated?: (file: StoredUserFile) => void;
  }
): Promise<StoredUserFile> {
  const originalName = truncateMiddle(cleanOriginalFilename(input.fileName), 64);
  const maxSizeBytes = userFileUploadSizeLimitBytes(env);
  if (input.size !== undefined) assertWithinFileSizeLimit(input.size, maxSizeBytes);
  const content = await readUserFileContent(input.body, maxSizeBytes);
  if (content.stream) return storeLargeUserFile(env, input, originalName, maxSizeBytes, content.stream);
  const bytes = content.bytes;
  const sha256Hash = await sha256Hex(bytes);
  const existing = await findStoredUserFile(env, originalName, sha256Hash);
  if (existing) return existing;

  const safeGeneratedName = `${randomHex()}_${sha256Hash}.${originalExtension(originalName)}`;
  const key = `user_files/${safeGeneratedName}`;
  const dimensions = await imageDimensions(env, bytes);
  const mimeType = dimensions?.mimeType || guessMimeType(originalName, input.contentType);

  console.log("[user-files] store:r2-put:start", { key, size: bytes.byteLength, mimeType });
  await putR2ObjectWithRetry(env.FILES, key, bytes, userFileObjectOptions(originalName, safeGeneratedName, mimeType));
  console.log("[user-files] store:r2-put:done", { key });

  return persistUserFile(env, input, {
    name: safeGeneratedName,
    originalName,
    sha256Hash,
    key,
    size: bytes.byteLength,
    mimeType,
    dimensions,
  });
}

function userFileObjectOptions(originalName: string, generatedName: string, mimeType: string): R2PutOptions & R2MultipartOptions {
  return {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `inline; filename="${originalName}"`,
    },
    customMetadata: {
      originalName,
      generatedName,
    },
  };
}

function findStoredUserFile(env: Env, originalName: string, sha256Hash: string): Promise<StoredUserFile | null> {
  return env.DB.prepare(
    "SELECT * FROM core_userfile WHERE original_name=? AND sha256_hash=? AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
  ).bind(originalName, sha256Hash).first<StoredUserFile>();
}

function imageDimensionsFromHeader(header: ArrayBuffer): { width: number; height: number; mimeType: string } | null {
  try {
    return imageDimensionsFromBytes(header);
  } catch {
    return null;
  }
}

// Large files are hashed while they stream to a staging object, then copied
// from R2 to their final key, which holds the hash. Memory stays at about one
// R2 part plus what readUserFileContent had already read.
async function storeLargeUserFile(
  env: Env,
  input: Parameters<typeof storeUserFile>[1],
  originalName: string,
  maxSizeBytes: number,
  stream: ReadableStream<Uint8Array>
): Promise<StoredUserFile> {
  const hash = createHash("sha256");
  const header = new Uint8Array(IMAGE_HEADER_PROBE_BYTES);
  let headerLength = 0;
  let size = 0;
  const inspected = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      assertWithinFileSizeLimit(size, maxSizeBytes);
      hash.update(chunk);
      if (headerLength < header.byteLength) {
        const copied = Math.min(header.byteLength - headerLength, chunk.byteLength);
        header.set(chunk.subarray(0, copied), headerLength);
        headerLength += copied;
      }
      controller.enqueue(chunk);
    },
  }));

  const stagingKey = `${STAGED_UPLOAD_PREFIX}${randomHex()}`;
  try {
    console.log("[user-files] store:r2-staged-upload:start", { key: stagingKey });
    await uploadStreamToR2(env.FILES, stagingKey, inspected, {});
    const sha256Hash = hash.digest("hex");
    const existing = await findStoredUserFile(env, originalName, sha256Hash);
    if (existing) return existing;

    const safeGeneratedName = `${randomHex()}_${sha256Hash}.${originalExtension(originalName)}`;
    const key = `user_files/${safeGeneratedName}`;
    const dimensions = imageDimensionsFromHeader(header.slice(0, headerLength).buffer);
    const mimeType = dimensions?.mimeType || guessMimeType(originalName, input.contentType);
    const staged = await env.FILES.get(stagingKey);
    if (!staged) throw new Error("The staged upload is missing from R2.");
    console.log("[user-files] store:r2-copy:start", { key, size, mimeType });
    await uploadStreamToR2(
      env.FILES,
      key,
      staged.body as ReadableStream<Uint8Array>,
      userFileObjectOptions(originalName, safeGeneratedName, mimeType)
    );
    console.log("[user-files] store:r2-copy:done", { key });

    return await persistUserFile(env, input, {
      name: safeGeneratedName,
      originalName,
      sha256Hash,
      key,
      size,
      mimeType,
      dimensions,
    });
  } finally {
    try {
      await env.FILES.delete(stagingKey);
    } catch (cleanupError) {
      console.error("[user-files] store:r2-staging-cleanup:failed", { key: stagingKey, error: String(cleanupError) });
    }
  }
}

// Records the file in D1 once its object is in R2, and removes the object
// again when that fails so no orphan stays in the bucket.
async function persistUserFile(
  env: Env,
  input: Parameters<typeof storeUserFile>[1],
  file: {
    name: string;
    originalName: string;
    sha256Hash: string;
    key: string;
    size: number;
    mimeType: string;
    dimensions: { width: number; height: number } | null;
  }
): Promise<StoredUserFile> {
  const { key, dimensions } = file;
  try {
    console.log("[user-files] store:d1:start", { key });
    const row = await env.DB.prepare(
      `INSERT INTO core_userfile
       (user_id, name, original_name, original_extension, sha256_hash, r2_key, size, mime_type, is_image, image_width, image_height, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
      .bind(
        input.userId,
        file.name,
        file.originalName,
        originalExtension(file.originalName),
        file.sha256Hash,
        key,
        file.size,
        file.mimeType,
        dimensions ? 1 : 0,
        dimensions?.width ?? null,
        dimensions?.height ?? null,
        new Date().toISOString()
      )
      .first<StoredUserFile>();

    if (!row) throw new Error("Failed to persist user file metadata");
    console.log("[user-files] store:d1:done", { key, fileId: row.id });
    try {
      input.onCreated?.(row);
    } catch (callbackError) {
      console.error("[user-files] store:on-created:failed", { key, error: String(callbackError) });
    }
    return row;
  } catch (error) {
    try {
      await env.FILES.delete(key);
    } catch (cleanupError) {
      console.error("[user-files] store:r2-cleanup:failed", { key, error: String(cleanupError) });
    }
    throw error;
  }
}
