import { Hono } from "hono";
import { strToU8, Unzip, UnzipInflate, Zip, ZipDeflate } from "fflate";
import type { Env, RequestVariables } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { DoesNotExist } from "../middleware/error";
import { addFieldColumn, ensureUserTableSystemColumns, getOrCreateUserTable, serializeFieldValueForInsert, type FieldType } from "../services/dynamic-tables";
import { assertHasApplicationRole, assertHasWorkspaceRole } from "../services/enterprise-permissions";
import { disableInvalidAIAutoUpdateUser, remapRuntimeFieldReferences } from "../services/ai-field-settings";
import { revalidateDateDependencyRules } from "../services/field-rules";

const snapshots = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function serializeSnapshot(s: any): object {
  return {
    id: s.id,
    name: s.name,
    snapshot_from_application: s.snapshot_from_application_id,
    created_by: s.created_by_id ? {
      id: s.created_by_id,
      username: s.created_by_username || s.created_by_email || "",
      email: s.created_by_email || "",
      name: [s.created_by_first_name, s.created_by_last_name].filter(Boolean).join(" ") || s.created_by_email || "",
    } : null,
    created_at: s.created_at,
  };
}

async function findUnusedApplicationName(db: D1Database, workspaceId: number, proposedName: string): Promise<string> {
  const rows = await db.prepare(
    `SELECT a.name FROM core_application a
     WHERE a.workspace_id=?
       AND NOT EXISTS (SELECT 1 FROM builder_domain d WHERE d.published_to_id=a.id)
     ORDER BY a.id ASC`
  )
    .bind(workspaceId)
    .all<{ name: string }>();
  const names = new Set((rows.results || []).map((row) => row.name));
  const base = proposedName.slice(0, 160);
  if (!names.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = ` ${suffix}`;
    const candidate = `${base.slice(0, 160 - suffixText.length)}${suffixText}`;
    if (!names.has(candidate)) return candidate;
  }
}

function snapshotKey(snapshotId: number): string {
  return `snapshots/${snapshotId}.json`;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

type SnapshotUserFile = {
  id?: number;
  name: string;
  original_name: string;
  original_extension?: string | null;
  sha256_hash?: string | null;
  r2_key: string;
  size: number;
  mime_type: string;
  is_image: number | boolean;
  image_width: number | null;
  image_height: number | null;
  uploaded_at: string;
  deleted_at?: string | null;
};

export type SnapshotFileEntries = Record<string, Uint8Array>;
export type SnapshotFileBody = Uint8Array | ReadableStream<Uint8Array>;

function collectSnapshotFileNameCandidates(value: unknown, names: Set<string>, seen: Set<object>): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        collectSnapshotFileNameCandidates(JSON.parse(trimmed), names, seen);
      } catch {
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSnapshotFileNameCandidates(item, names, seen);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string" && (
    "visible_name" in record ||
    "original_name" in record ||
    "mime_type" in record ||
    "is_image" in record ||
    "thumbnails" in record ||
    "url" in record
  )) {
    names.add(record.name);
  }
  for (const item of Object.values(record)) collectSnapshotFileNameCandidates(item, names, seen);
}

export function referencedSnapshotFileNames(snapshot: unknown): Set<string> {
  const names = new Set<string>();
  const snapshotWithoutMetadata = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? Object.fromEntries(Object.entries(snapshot as Record<string, unknown>).filter(([key]) => key !== "user_files"))
    : snapshot;
  collectSnapshotFileNameCandidates(snapshotWithoutMetadata, names, new Set());
  return names;
}

export async function snapshotUserFilesForNames(
  db: D1Database,
  names: Iterable<string>
): Promise<SnapshotUserFile[]> {
  const uniqueNames = [...new Set(names)].filter(Boolean);
  const files: SnapshotUserFile[] = [];
  for (let offset = 0; offset < uniqueNames.length; offset += 90) {
    const chunk = uniqueNames.slice(offset, offset + 90);
    if (chunk.length === 0) continue;
    files.push(...await optionalAll<SnapshotUserFile>(
      db,
      `SELECT * FROM core_userfile WHERE name IN (${chunk.map(() => "?").join(",")}) AND deleted_at IS NULL ORDER BY id ASC`,
      ...chunk
    ));
  }
  return files;
}

async function referencedSnapshotUserFiles(db: D1Database, snapshot: unknown): Promise<SnapshotUserFile[]> {
  return snapshotUserFilesForNames(db, referencedSnapshotFileNames(snapshot));
}

export async function* iterateSnapshotTableRows(
  db: D1Database,
  tableId: number,
  pageSize = 200
): AsyncGenerator<any[]> {
  await ensureUserTableSystemColumns(db, tableId);
  let lastOrder: number | string | null = null;
  let lastId = 0;
  while (true) {
    // Like Baserow, snapshots and exports leave trashed rows out: restoring
    // them would bring deleted rows back as live ones.
    const result: D1Result<any> = lastOrder === null
      ? await db.prepare(
        `SELECT * FROM "database_table_${tableId}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC LIMIT ?`
      ).bind(pageSize).all<any>()
      : await db.prepare(
        `SELECT * FROM "database_table_${tableId}"
         WHERE COALESCE(trashed, 0)=0 AND ([order] > ? OR ([order] = ? AND id > ?))
         ORDER BY [order] ASC, id ASC LIMIT ?`
      ).bind(lastOrder, lastOrder, lastId, pageSize).all<any>();
    const rows: any[] = result.results || [];
    if (rows.length === 0) return;
    yield rows;
    const last: any = rows[rows.length - 1];
    lastOrder = last.order ?? last["order"] ?? last["[order]"];
    lastId = Number(last.id);
    if (rows.length < pageSize) return;
  }
}

async function r2ObjectBytes(object: R2ObjectBody): Promise<Uint8Array> {
  const candidate = object as R2ObjectBody & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
    text?: () => Promise<any>;
  };
  if (typeof candidate.arrayBuffer === "function") {
    return new Uint8Array(await candidate.arrayBuffer());
  }
  if (typeof candidate.text === "function") {
    const value: any = await candidate.text();
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value;
  }
  throw new DoesNotExist("R2 object body", "bytes");
}

function joinSnapshotByteChunks(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function snapshotObjectStream(object: R2ObjectBody): Promise<ReadableStream<Uint8Array>> {
  if (object.body && typeof object.body.getReader === "function") return object.body;
  const bytes = await r2ObjectBytes(object);
  return new Blob([bytes]).stream();
}

function snapshotRowChunkPayloads(
  rows: any[],
  maxBytes = 4 * 1024 * 1024
): Array<{ bytes: Uint8Array; rowCount: number }> {
  const chunks: Array<{ bytes: Uint8Array; rowCount: number }> = [];
  let serializedRows: string[] = [];
  let size = 2;
  const flush = () => {
    if (serializedRows.length === 0) return;
    chunks.push({
      bytes: strToU8(`[${serializedRows.join(",")}]`),
      rowCount: serializedRows.length,
    });
    serializedRows = [];
    size = 2;
  };
  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const rowSize = strToU8(serialized).length + (serializedRows.length > 0 ? 1 : 0);
    if (serializedRows.length > 0 && size + rowSize > maxBytes) flush();
    serializedRows.push(serialized);
    size += rowSize;
  }
  flush();
  return chunks;
}

async function streamSnapshotArchiveToR2(
  env: Env,
  db: D1Database,
  key: string,
  snapshot: any
): Promise<void> {
  const multipart = await env.FILES.createMultipartUpload(key, {
    httpMetadata: { contentType: "application/zip" },
  });
  const partSize = 8 * 1024 * 1024;
  const uploadedParts: R2UploadedPart[] = [];
  let bufferedChunks: Uint8Array[] = [];
  let bufferedSize = 0;
  let partNumber = 1;
  const takeBytes = (size: number) => {
    const bytes = joinSnapshotByteChunks(bufferedChunks);
    const part = bytes.slice(0, size);
    const remainder = bytes.slice(size);
    bufferedChunks = remainder.length > 0 ? [remainder] : [];
    bufferedSize = remainder.length;
    return part;
  };
  const uploadBuffered = async (final: boolean) => {
    while (bufferedSize >= partSize) {
      uploadedParts.push(await multipart.uploadPart(partNumber, takeBytes(partSize)));
      partNumber += 1;
    }
    if (final && bufferedSize > 0) {
      uploadedParts.push(await multipart.uploadPart(partNumber, takeBytes(bufferedSize)));
      partNumber += 1;
    }
  };
  let outputWrites: Promise<void> = Promise.resolve();
  const archive = new Zip((error, chunk, final) => {
    outputWrites = outputWrites.then(async () => {
      if (error) throw error;
      if (chunk.length > 0) {
        bufferedChunks.push(chunk.slice());
        bufferedSize += chunk.length;
      }
      await uploadBuffered(final);
      if (final) await multipart.complete(uploadedParts);
    });
  });
  const addBytes = async (name: string, bytes: Uint8Array) => {
    const entry = new ZipDeflate(name, { level: 6 });
    archive.add(entry);
    entry.push(bytes, true);
    await outputWrites;
  };
  const addObject = async (name: string, object: R2ObjectBody) => {
    const entry = new ZipDeflate(name, { level: 6 });
    archive.add(entry);
    const reader = (await snapshotObjectStream(object)).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          entry.push(value, false);
          await outputWrites;
        }
      }
      entry.push(new Uint8Array(0), true);
      await outputWrites;
    } finally {
      reader.releaseLock();
    }
  };

  try {
    const names = new Set(["snapshot.json"]);
    const referencedFileNames = referencedSnapshotFileNames(snapshot);
    const rowChunks: Array<{ table_id: number; name: string; row_count: number }> = [];
    for (const tableBundle of snapshot.tables || []) {
      const tableId = Number(tableBundle.table?.id);
      if (!Number.isInteger(tableId) || tableId <= 0) continue;
      const inlineRows = Array.isArray(tableBundle.rows) ? tableBundle.rows : [];
      tableBundle.rows = [];
      const pages = inlineRows.length > 0
        ? (async function* () { yield inlineRows; })()
        : iterateSnapshotTableRows(db, tableId);
      let chunkIndex = 0;
      for await (const page of pages) {
        for (const fileName of referencedSnapshotFileNames(page)) referencedFileNames.add(fileName);
        for (const chunk of snapshotRowChunkPayloads(page)) {
          chunkIndex += 1;
          const name = `snapshot_rows/${tableId}/${String(chunkIndex).padStart(6, "0")}.json`;
          if (names.has(name)) throw new Error(`Invalid duplicate snapshot entry ${name}.`);
          names.add(name);
          await addBytes(name, chunk.bytes);
          rowChunks.push({ table_id: tableId, name, row_count: chunk.rowCount });
        }
      }
    }
    snapshot.row_chunks = rowChunks;
    const knownFiles = new Set((snapshot.user_files || []).map((file: any) => String(file?.name || "")).filter(Boolean));
    for (const file of await snapshotUserFilesForNames(db, referencedFileNames)) {
      if (!knownFiles.has(file.name)) {
        snapshot.user_files ||= [];
        snapshot.user_files.push(file);
        knownFiles.add(file.name);
      }
    }
    await addBytes("snapshot.json", strToU8(JSON.stringify(snapshot)));
    for (const file of snapshot.user_files || []) {
      const name = String(file.name || "");
      if (!name || names.has(name)) throw new Error(`Invalid duplicate snapshot entry ${name || "<empty>"}.`);
      names.add(name);
      const object = await env.FILES.get(String(file.r2_key || `user_files/${name}`));
      if (!object) throw new DoesNotExist("User file", name);
      await addObject(name, object);
    }
    archive.end();
    await outputWrites;
  } catch (error) {
    archive.terminate();
    await multipart.abort().catch(() => undefined);
    await env.FILES.delete(key).catch(() => undefined);
    throw error;
  }
}

type ExtractedSnapshotArchive = {
  data: any;
  loadBody: (name: string) => Promise<SnapshotFileBody | null>;
  loadTableRows?: (oldTableId: number) => AsyncIterable<any[]>;
  cleanup: () => Promise<void>;
};

async function readSnapshotStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractSnapshotArchiveToR2(
  env: Env,
  object: R2ObjectBody,
  temporaryPrefix: string
): Promise<ExtractedSnapshotArchive> {
  const source = await snapshotObjectStream(object);
  const [probe, content] = source.tee();
  const probeReader = probe.getReader();
  const signature: number[] = [];
  try {
    while (signature.length < 4) {
      const { done, value } = await probeReader.read();
      if (done) break;
      for (const byte of value || []) {
        signature.push(byte);
        if (signature.length === 4) break;
      }
    }
    probeReader.cancel().catch(() => undefined);
  } finally {
    probeReader.releaseLock();
  }
  const isZip = signature.length >= 2 && signature[0] === 0x50 && signature[1] === 0x4b;
  if (!isZip) {
    const data = JSON.parse(new TextDecoder().decode(await readSnapshotStream(content)));
    return { data, loadBody: async () => null, cleanup: async () => undefined };
  }

  const entries = new Map<string, string>();
  const discoveredEntries = new Set<string>();
  const temporaryKeys: string[] = [];
  const schemaChunks: Uint8Array[] = [];
  let schemaSize = 0;
  let entryCount = 0;
  let processing: Promise<void> = Promise.resolve();
  const partSize = 8 * 1024 * 1024;
  const unzip = new Unzip((file) => {
    const name = file.name.replace(/^(?:\.\/)+/, "");
    if (!name || discoveredEntries.has(name)) {
      processing = processing.then(() => {
        throw new Error(`Invalid duplicate snapshot entry ${name || file.name}.`);
      });
      return;
    }
    discoveredEntries.add(name);
    entryCount += 1;
    const key = `${temporaryPrefix}${String(entryCount).padStart(6, "0")}`;
    temporaryKeys.push(key);
    const multipartPromise = env.FILES.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    let bufferedChunks: Uint8Array[] = [];
    let bufferedSize = 0;
    let partNumber = 1;
    const uploadedParts: R2UploadedPart[] = [];
    const takeBytes = (size: number) => {
      const bytes = joinSnapshotByteChunks(bufferedChunks);
      const part = bytes.slice(0, size);
      const remainder = bytes.slice(size);
      bufferedChunks = remainder.length > 0 ? [remainder] : [];
      bufferedSize = remainder.length;
      return part;
    };
    file.ondata = (error, chunk, final) => {
      const ownedChunk = chunk.slice();
      processing = processing.then(async () => {
        if (error) throw error;
        if (ownedChunk.length > 0) {
          bufferedChunks.push(ownedChunk);
          bufferedSize += ownedChunk.length;
          if (name === "snapshot.json") {
            schemaSize += ownedChunk.length;
            if (schemaSize > 32 * 1024 * 1024) throw new Error("Snapshot schema is too large.");
            schemaChunks.push(ownedChunk);
          }
        }
        const multipart = await multipartPromise;
        while (bufferedSize >= partSize) {
          uploadedParts.push(await multipart.uploadPart(partNumber, takeBytes(partSize)));
          partNumber += 1;
        }
        if (!final) return;
        if (bufferedSize > 0) uploadedParts.push(await multipart.uploadPart(partNumber, takeBytes(bufferedSize)));
        if (uploadedParts.length > 0) await multipart.complete(uploadedParts);
        else {
          await multipart.abort().catch(() => undefined);
          await env.FILES.put(key, new Uint8Array(0));
        }
        entries.set(name, key);
      }).catch(async (failure) => {
        const multipart = await multipartPromise.catch(() => null);
        await multipart?.abort().catch(() => undefined);
        throw failure;
      });
    };
    try {
      file.start();
    } catch (error) {
      processing = processing.then(() => { throw error; });
    }
  });
  unzip.register(UnzipInflate);
  const reader = content.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        unzip.push(value, false);
        await processing;
      }
    }
    unzip.push(new Uint8Array(0), true);
    await processing;
    if (!entries.has("snapshot.json")) throw new DoesNotExist("Snapshot schema", "snapshot.json");
    const data = JSON.parse(new TextDecoder().decode(joinSnapshotByteChunks(schemaChunks)));
    for (const file of data.user_files || []) {
      if (!entries.has(String(file.name || ""))) throw new DoesNotExist("Snapshot user file", file.name);
    }
    const rowChunksByTable = new Map<number, Array<{ name: string; key: string }>>();
    for (const rowChunk of data.row_chunks || []) {
      const tableId = Number(rowChunk?.table_id);
      const name = String(rowChunk?.name || "");
      const rowCount = Number(rowChunk?.row_count);
      const key = entries.get(name);
      if (!Number.isInteger(tableId) || tableId <= 0 || !name || !key || !Number.isInteger(rowCount) || rowCount < 0) {
        throw new Error("Snapshot row chunk metadata is invalid.");
      }
      const chunks = rowChunksByTable.get(tableId) || [];
      chunks.push({ name, key });
      rowChunksByTable.set(tableId, chunks);
    }
    return {
      data,
      loadBody: async (name: string) => {
        const key = entries.get(name);
        if (!key) return null;
        const fileObject = await env.FILES.get(key);
        if (!fileObject) return null;
        return snapshotObjectStream(fileObject);
      },
      loadTableRows: rowChunksByTable.size === 0
        ? undefined
        : async function* (oldTableId: number) {
          for (const chunk of rowChunksByTable.get(oldTableId) || []) {
            const rowObject = await env.FILES.get(chunk.key);
            if (!rowObject) throw new DoesNotExist("Snapshot row chunk", chunk.name);
            const rows = JSON.parse(new TextDecoder().decode(
              await readSnapshotStream(await snapshotObjectStream(rowObject))
            ));
            if (!Array.isArray(rows)) throw new Error(`Snapshot row chunk ${chunk.name} is invalid.`);
            yield rows;
          }
        },
      cleanup: async () => {
        await env.FILES.delete(temporaryKeys).catch(() => undefined);
      },
    };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await env.FILES.delete(temporaryKeys).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function cleanContentDispositionName(value: string): string {
  return value.replace(/["\\\r\n]/g, "_");
}

export async function restoreSnapshotUserFiles(
  env: Env,
  snapshot: any,
  files: Record<string, SnapshotFileBody> = {},
  options: { loadBody?: (name: string) => Promise<SnapshotFileBody | null> } = {}
): Promise<void> {
  for (const rawFile of snapshot.user_files || []) {
    const file = rawFile as SnapshotUserFile;
    const name = String(file.name || "");
    if (!name) continue;
    const r2Key = String(file.r2_key || `user_files/${name}`);
    const body = files[name] || await options.loadBody?.(name) || null;
    const existing = await env.DB.prepare("SELECT * FROM core_userfile WHERE name=?")
      .bind(name)
      .first<SnapshotUserFile>();
    if (body) {
      await env.FILES.put(r2Key, body, {
        httpMetadata: {
          contentType: file.mime_type || "application/octet-stream",
          contentDisposition: `inline; filename="${cleanContentDispositionName(file.original_name || name)}"`,
        },
        customMetadata: {
          originalName: file.original_name || name,
          generatedName: name,
        },
      });
    } else if (!existing || !(await env.FILES.head(r2Key))) {
      throw new DoesNotExist("Snapshot user file", name);
    }

    const extension = file.original_extension ?? (name.includes(".") ? name.split(".").pop() || "" : "");
    try {
      if (existing) {
        await env.DB.prepare(
          `UPDATE core_userfile
           SET original_name=?, original_extension=?, sha256_hash=?, r2_key=?, size=?, mime_type=?, is_image=?,
               image_width=?, image_height=?, uploaded_at=?, deleted_at=NULL
           WHERE name=?`
        ).bind(
          file.original_name || name,
          extension,
          file.sha256_hash || null,
          r2Key,
          body instanceof Uint8Array ? body.byteLength : file.size ?? 0,
          file.mime_type || "application/octet-stream",
          file.is_image ? 1 : 0,
          file.image_width ?? null,
          file.image_height ?? null,
          file.uploaded_at || new Date().toISOString(),
          name
        ).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO core_userfile
           (user_id, name, original_name, original_extension, sha256_hash, r2_key, size, mime_type, is_image,
            image_width, image_height, uploaded_at, deleted_at)
           VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        ).bind(
          name,
          file.original_name || name,
          extension,
          file.sha256_hash || null,
          r2Key,
          body instanceof Uint8Array ? body.byteLength : file.size ?? 0,
          file.mime_type || "application/octet-stream",
          file.is_image ? 1 : 0,
          file.image_width ?? null,
          file.image_height ?? null,
          file.uploaded_at || new Date().toISOString()
        ).run();
      }
    } catch (error) {
      if (!existing && body) await env.FILES.delete(r2Key);
      throw error;
    }
  }
}

function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function remapId(value: unknown, map: Map<number, number>): unknown {
  const id = Number(value);
  return Number.isFinite(id) && map.has(id) ? map.get(id)! : value;
}

function remapJsonReferences(value: unknown, maps: {
  applications?: Map<number, number>;
  fields?: Map<number, number>;
  tables?: Map<number, number>;
  views?: Map<number, number>;
  selectOptions?: Map<number, number>;
  formGroups?: Map<number, number>;
  integrations?: Map<number, number>;
  userSources?: Map<number, number>;
  builderPages?: Map<number, number>;
  builderElements?: Map<number, number>;
  builderDataSources?: Map<number, number>;
  builderWorkflowActions?: Map<number, number>;
  automationWorkflows?: Map<number, number>;
  automationNodes?: Map<number, number>;
}): unknown {
  if (typeof value === "string" && maps.fields) return remapRuntimeFieldReferences(value, maps.fields);
  if (Array.isArray(value)) return value.map((item) => remapJsonReferences(item, maps));
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (["application_id", "builder_id", "automation_id"].includes(key) && maps.applications) {
      result[key] = remapId(raw, maps.applications);
    } else if (key === "link_row_table_primary_field" && raw && typeof raw === "object" && maps.fields) {
      const field = raw as Record<string, unknown>;
      result[key] = { ...field, id: remapId(field.id, maps.fields) };
    } else if ([
      "field",
      "field_id",
      "through_field_id",
      "target_field_id",
      "single_select_field",
      "date_field",
      "start_date_field",
      "end_date_field",
      "card_cover_image_field",
      "email_field_id",
      "ai_file_field_id",
      "name_field_id",
      "username_field_id",
      "password_field_id",
      "role_field_id",
      "start_date_field_id",
      "end_date_field_id",
      "duration_field_id",
      "dependency_linkrow_field_id",
    ].includes(key) && maps.fields) {
      result[key] = remapId(raw, maps.fields);
    } else if (["table_id", "link_row_table_id", "source_table_id", "local_baserow_table_id"].includes(key) && maps.tables) {
      result[key] = remapId(raw, maps.tables);
    } else if (["view_id", "grid_view_id", "gallery_view_id", "form_view_id"].includes(key) && maps.views) {
      result[key] = remapId(raw, maps.views);
    } else if (["id", "select_option_id"].includes(key) && maps.selectOptions && Number.isFinite(Number(raw))) {
      result[key] = remapId(raw, maps.selectOptions);
    } else if (["group", "group_id", "parent_group", "parent_group_id"].includes(key) && maps.formGroups && raw !== null && raw !== undefined) {
      result[key] = remapId(raw, maps.formGroups);
    } else if (key === "integration_id" && maps.integrations) {
      result[key] = remapId(raw, maps.integrations);
    } else if (["user_source_id", "user_source"].includes(key) && maps.userSources) {
      result[key] = remapId(raw, maps.userSources);
    } else if (["page_id", "builder_page_id"].includes(key) && maps.builderPages) {
      result[key] = remapId(raw, maps.builderPages);
    } else if (["element_id", "parent_element_id", "builder_element_id"].includes(key) && maps.builderElements) {
      result[key] = remapId(raw, maps.builderElements);
    } else if (["data_source_id", "datasource_id", "builder_datasource_id"].includes(key) && maps.builderDataSources) {
      result[key] = remapId(raw, maps.builderDataSources);
    } else if (["workflow_action_id", "builder_workflow_action_id"].includes(key) && maps.builderWorkflowActions) {
      result[key] = remapId(raw, maps.builderWorkflowActions);
    } else if (["workflow_id", "automation_workflow_id", "published_from_workflow_id"].includes(key) && maps.automationWorkflows) {
      result[key] = remapId(raw, maps.automationWorkflows);
    } else if (["node_id", "automation_node_id", "simulate_until_node_id", "reference_node_id"].includes(key) && maps.automationNodes) {
      result[key] = remapId(raw, maps.automationNodes);
    } else {
      result[key] = remapJsonReferences(raw, maps);
    }
  }
  return result;
}

function remapDataSyncPropertyKey(value: unknown, fieldMap: Map<number, number>): string {
  const key = String(value || "");
  const match = key.match(/^field_(\d+)$/);
  if (!match) return key;
  const newFieldId = fieldMap.get(Number(match[1]));
  return newFieldId ? `field_${newFieldId}` : key;
}

function remapDataSyncFieldKeys(value: unknown, fieldMap: Map<number, number>): unknown {
  if (typeof value === "string") return remapDataSyncPropertyKey(value, fieldMap);
  if (Array.isArray(value)) return value.map((item) => remapDataSyncFieldKeys(item, fieldMap));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    remapDataSyncFieldKeys(item, fieldMap),
  ]));
}

function remapSelectValue(value: unknown, optionMap: Map<number, number>): unknown {
  const parsed = parseJson(value);
  if (parsed === null || parsed === undefined || parsed === "") return parsed;
  if (Array.isArray(parsed)) return parsed.map((item) => remapSelectValue(item, optionMap));
  if (typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    return { ...raw, id: remapId(raw.id, optionMap) };
  }
  return remapId(parsed, optionMap);
}

function remapLinkRowValue(value: unknown, rowMap: Map<number, number>): unknown {
  const parsed = parseJson(value);
  if (parsed === null || parsed === undefined || parsed === "") return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if (item && typeof item === "object") {
      const raw = item as Record<string, unknown>;
      return { ...raw, id: remapId(raw.id, rowMap) };
    }
    return { id: remapId(item, rowMap), value: String(item ?? "") };
  });
}

export type SnapshotRestoreContext = {
  applications: Map<number, number>;
  tables: Map<number, number>;
  fields: Map<number, number>;
  views: Map<number, number>;
  selectOptions: Map<number, number>;
  integrations: Map<number, number>;
  userSources: Map<number, number>;
  builderPages: Map<number, number>;
  builderElements: Map<number, number>;
  builderDataSources: Map<number, number>;
  builderWorkflowActions: Map<number, number>;
  automationWorkflows: Map<number, number>;
  automationNodes: Map<number, number>;
  documentPages: Map<number, number>;
  dashboardDataSources: Map<number, number>;
  dashboardAggregationSeries: Map<number, number>;
};

export function createSnapshotRestoreContext(existing?: SnapshotRestoreContext): SnapshotRestoreContext {
  return existing || {
    applications: new Map(),
    tables: new Map(),
    fields: new Map(),
    views: new Map(),
    selectOptions: new Map(),
    integrations: new Map(),
    userSources: new Map(),
    builderPages: new Map(),
    builderElements: new Map(),
    builderDataSources: new Map(),
    builderWorkflowActions: new Map(),
    automationWorkflows: new Map(),
    automationNodes: new Map(),
    documentPages: new Map(),
    dashboardDataSources: new Map(),
    dashboardAggregationSeries: new Map(),
  };
}

function restoreMaps(context: SnapshotRestoreContext) {
  return {
    applications: context.applications,
    fields: context.fields,
    tables: context.tables,
    views: context.views,
    selectOptions: context.selectOptions,
    integrations: context.integrations,
    userSources: context.userSources,
    builderPages: context.builderPages,
    builderElements: context.builderElements,
    builderDataSources: context.builderDataSources,
    builderWorkflowActions: context.builderWorkflowActions,
    automationWorkflows: context.automationWorkflows,
    automationNodes: context.automationNodes,
  };
}

function remapStoredJson(value: unknown, context: SnapshotRestoreContext): string {
  return stringifyJson(remapJsonReferences(parseJson(value), restoreMaps(context))) || "{}";
}

function remapDataSyncStoredJson(value: unknown, context: SnapshotRestoreContext): string {
  const remappedIds = remapJsonReferences(parseJson(value), restoreMaps(context));
  return stringifyJson(remapDataSyncFieldKeys(remappedIds, context.fields)) || "{}";
}

function remapAutomationGraph(graph: unknown, nodeMap: Map<number, number>): unknown {
  const parsed = parseJson(graph);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed || {};
  const result: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const mappedKey = rawKey === "0"
      ? rawKey
      : String(remapId(Number(rawKey), nodeMap));
    result[mappedKey] = remapAutomationGraphValue(rawValue, nodeMap);
  }
  return result;
}

function remapAutomationGraphValue(value: unknown, nodeMap: Map<number, number>): unknown {
  if (typeof value === "number") return remapId(value, nodeMap);
  if (Array.isArray(value)) return value.map((item) => remapAutomationGraphValue(item, nodeMap));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    remapAutomationGraphValue(item, nodeMap),
  ]));
}

async function requireApplicationAccess(db: D1Database, userId: number, applicationId: number, requiredRole = "VIEWER") {
  const app = await db.prepare(
    "SELECT id, workspace_id, name, type, [order] FROM core_application WHERE id=? AND trashed=0"
  ).bind(applicationId).first<any>();
  if (!app) throw new DoesNotExist("Application", applicationId);
  await assertHasApplicationRole(db, userId, applicationId, requiredRole);
  return app;
}

async function optionalAll<T = any>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const statement = db.prepare(sql);
    const result = binds.length ? await statement.bind(...binds).all<T>() : await statement.all<T>();
    return (result.results || []) as T[];
  } catch (error) {
    if (String((error as Error)?.message || error).toLowerCase().includes("no such")) return [];
    throw error;
  }
}

async function optionalFirst<T = any>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    const statement = db.prepare(sql);
    return (binds.length ? await statement.bind(...binds).first<T>() : await statement.first<T>()) || null;
  } catch (error) {
    if (String((error as Error)?.message || error).toLowerCase().includes("no such")) return null;
    throw error;
  }
}

async function optionalRun(db: D1Database, sql: string, ...binds: unknown[]): Promise<void> {
  try {
    const statement = db.prepare(sql);
    await (binds.length ? statement.bind(...binds).run() : statement.run());
  } catch (error) {
    if (!String((error as Error)?.message || error).toLowerCase().includes("no such")) throw error;
  }
}

async function restoreEnterpriseSnapshot(
  db: D1Database,
  workspaceId: number,
  enterpriseData: any,
  context: SnapshotRestoreContext
): Promise<void> {
  if (!enterpriseData) return;
  const scopeMaps: Record<string, Map<number, number>> = {
    application: context.applications,
    table: context.tables,
    view: context.views,
    field: context.fields,
  };

  for (const assignment of enterpriseData.role_assignments || []) {
    const scopeType = String(assignment.scope_type || "");
    const scopeMapType = scopeType === "database_table"
      ? "table"
      : scopeType === "database_view"
        ? "view"
        : scopeType === "database_field"
          ? "field"
          : scopeType;
    const scopeId = scopeMaps[scopeMapType]?.get(Number(assignment.scope_id));
    if (!scopeId) continue;
    const subjectType = String(assignment.subject_type || "");
    let subjectId = Number(assignment.subject_id);
    if (!subjectType || !subjectId) continue;
    if (subjectType === "auth.User") {
      const email = String(assignment.subject_email || "").trim();
      const member = email
        ? await optionalFirst<{ user_id: number }>(
          db,
          `SELECT wu.user_id FROM core_workspaceuser wu
           JOIN auth_user u ON u.id=wu.user_id
           WHERE wu.workspace_id=? AND wu.to_be_deleted=0 AND u.is_active=1 AND u.email=? COLLATE NOCASE
           ORDER BY wu.id ASC LIMIT 1`,
          workspaceId,
          email
        )
        : await optionalFirst<{ user_id: number }>(
          db,
          "SELECT user_id FROM core_workspaceuser WHERE workspace_id=? AND user_id=? AND to_be_deleted=0",
          workspaceId,
          subjectId
        );
      if (!member) continue;
      subjectId = Number(member.user_id);
    } else if (subjectType === "baserow_enterprise.Team") {
      const teamName = String(assignment.subject_name || "").trim();
      const team = teamName
        ? await optionalFirst<{ id: number }>(
          db,
          "SELECT id FROM enterprise_team WHERE workspace_id=? AND name=? COLLATE NOCASE AND trashed=0 ORDER BY id ASC LIMIT 1",
          workspaceId,
          teamName
        )
        : await optionalFirst<{ id: number }>(
          db,
          "SELECT id FROM enterprise_team WHERE workspace_id=? AND id=? AND trashed=0",
          workspaceId,
          subjectId
        );
      if (!team) continue;
      subjectId = Number(team.id);
    }

    const roleUid = String(assignment.role_uid || "");
    if (!roleUid) continue;
    let role = await optionalFirst<{ id: number }>(db, "SELECT id FROM enterprise_role WHERE uid=?", roleUid);
    if (!role) {
      role = await db.prepare("INSERT INTO enterprise_role (uid, description) VALUES (?, '') RETURNING id")
        .bind(roleUid)
        .first<{ id: number }>();
    }
    if (!role?.id) continue;
    await db.prepare(
      `DELETE FROM enterprise_roleassignment
       WHERE subject_id=? AND subject_type=? AND scope_id=? AND scope_type=?`
    ).bind(subjectId, subjectType, scopeId, scopeType).run();
    await db.prepare(
      `INSERT INTO enterprise_roleassignment (role_id, subject_id, subject_type, scope_id, scope_type)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(role.id, subjectId, subjectType, scopeId, scopeType).run();
  }

  for (const permission of enterpriseData.field_permissions || []) {
    const fieldId = context.fields.get(Number(permission.field_id));
    if (!fieldId) continue;
    await db.prepare("DELETE FROM enterprise_fieldpermission WHERE field_id=?").bind(fieldId).run();
    await db.prepare(
      `INSERT INTO enterprise_fieldpermission
       (field_id, role_uid, allow_read, allow_write, allow_in_forms)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      fieldId,
      String(permission.role_uid || "EDITOR"),
      permission.allow_read === 0 ? 0 : 1,
      permission.allow_write === 0 ? 0 : 1,
      permission.allow_in_forms === 0 ? 0 : 1
    ).run();
  }
}

export type ApplicationSnapshotOptions = {
  includeBuilderDomains?: boolean;
  includeAutomationHistory?: boolean;
  includeRows?: boolean;
};

export async function buildApplicationSnapshot(
  db: D1Database,
  applicationId: number,
  options: ApplicationSnapshotOptions = {}
) {
  const app = await db.prepare("SELECT * FROM core_application WHERE id=?").bind(applicationId).first<any>();
  if (!app) throw new DoesNotExist("Application", applicationId);
  const includeBuilderDomains = options.includeBuilderDomains ?? true;
  const includeAutomationHistory = options.includeAutomationHistory ?? true;
  const includeRows = options.includeRows ?? true;

  const integrations = await optionalAll(db, "SELECT * FROM core_integration WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC", applicationId);
  const userSources = await optionalAll(db, "SELECT * FROM core_usersource WHERE application_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC", applicationId);

  const tablesResult = await db.prepare(
    "SELECT * FROM database_table WHERE database_id=? AND trashed=0 ORDER BY [order] ASC"
  ).bind(applicationId).all();
  const tables = [];

  for (const table of tablesResult.results || []) {
    const fields = await db.prepare(
      "SELECT * FROM database_field WHERE table_id=? AND trashed=0 ORDER BY [order] ASC"
    ).bind(table.id).all<any>();
    const views = await db.prepare(
      "SELECT * FROM database_view WHERE table_id=? AND trashed=0 ORDER BY [order] ASC"
    ).bind(table.id).all<any>();
    const rows: any[] = [];
    if (includeRows) {
      for await (const page of iterateSnapshotTableRows(db, Number(table.id))) rows.push(...page);
    }
    const fieldDependencies = await db.prepare(
      `SELECT d.*, COALESCE(d.broken_reference_field_name, dependency.name) AS restore_broken_reference_field_name
       FROM database_fielddependency d
       JOIN database_field dependant ON dependant.id=d.dependant_id
       LEFT JOIN database_field dependency ON dependency.id=d.dependency_id
       WHERE dependant.table_id=?
       ORDER BY d.id ASC`
    ).bind(table.id).all<any>();
    const dataSync = table.data_sync_id
      ? await optionalFirst(db, "SELECT * FROM database_datasync WHERE id=?", table.data_sync_id)
      : null;
    const dataSyncProperties = dataSync
      ? await optionalAll(db, "SELECT * FROM database_datasyncsyncedproperty WHERE data_sync_id=? ORDER BY id ASC", (dataSync as any).id)
      : [];
    const fieldRules = await optionalAll(db, "SELECT * FROM database_fieldrule WHERE table_id=? ORDER BY id ASC", table.id);
    const fieldBundles = [];
    for (const field of fields.results || []) {
      const selectOptions = await db.prepare(
        "SELECT * FROM database_selectoption WHERE field_id=? ORDER BY [order] ASC, id ASC"
      ).bind(field.id).all<any>();
      fieldBundles.push({
        field,
        select_options: selectOptions.results || [],
      });
    }

    const viewBundles = [];
    for (const view of views.results || []) {
      const filters = await db.prepare("SELECT * FROM database_viewfilter WHERE view_id=? ORDER BY id ASC")
        .bind(view.id).all<any>();
      const filterGroups = await db.prepare("SELECT * FROM database_viewfiltergroup WHERE view_id=? ORDER BY id ASC")
        .bind(view.id).all<any>();
      const sortings = await db.prepare("SELECT * FROM database_viewsort WHERE view_id=? ORDER BY id ASC")
        .bind(view.id).all<any>();
      const groupBys = await db.prepare("SELECT * FROM database_viewgroupby WHERE view_id=? ORDER BY id ASC")
        .bind(view.id).all<any>();
      const gridOptions = await db.prepare("SELECT * FROM database_gridviewfieldoptions WHERE grid_view_id=? ORDER BY [order] ASC, id ASC")
        .bind(view.id).all<any>();
      const galleryOptions = await db.prepare("SELECT * FROM database_galleryviewfieldoptions WHERE gallery_view_id=? ORDER BY [order] ASC, id ASC")
        .bind(view.id).all<any>();
      const formView = await db.prepare("SELECT * FROM database_formview WHERE view_ptr_id=?")
        .bind(view.id).first<any>();
      const formUsersToNotify = await optionalAll(
        db,
        `SELECT formview_id, user_id
         FROM database_formview_users_to_notify_on_submit
         WHERE formview_id=?
         ORDER BY user_id ASC`,
        view.id
      );
      const formOptions = await db.prepare("SELECT * FROM database_formviewfieldoptions WHERE form_view_id=? ORDER BY [order] ASC, id ASC")
        .bind(view.id).all<any>();
      const formOptionBundles = [];
      for (const option of formOptions.results || []) {
        const allowedSelectOptions = await db.prepare(
          "SELECT * FROM database_formviewfieldoptions_allowedselectoptions WHERE form_view_field_options_id=? ORDER BY id ASC"
        ).bind(option.id).all<any>();
        const conditionGroups = await db.prepare(
          "SELECT * FROM database_formviewfieldoptionsconditiongroup WHERE field_option_id=? ORDER BY id ASC"
        ).bind(option.id).all<any>();
        const conditions = await db.prepare(
          "SELECT * FROM database_formviewfieldoptionscondition WHERE field_option_id=? ORDER BY id ASC"
        ).bind(option.id).all<any>();
        formOptionBundles.push({
          option,
          allowed_select_options: allowedSelectOptions.results || [],
          condition_groups: conditionGroups.results || [],
          conditions: conditions.results || [],
        });
      }
      const decorations = await db.prepare("SELECT * FROM database_viewdecoration WHERE view_id=? ORDER BY [order] ASC, id ASC")
        .bind(view.id).all<any>();
      viewBundles.push({
        view,
        filters: filters.results || [],
        filter_groups: filterGroups.results || [],
        sortings: sortings.results || [],
        group_bys: groupBys.results || [],
        grid_field_options: gridOptions.results || [],
        gallery_field_options: galleryOptions.results || [],
        form_view: formView || null,
        form_users_to_notify: formUsersToNotify,
        form_field_options: formOptionBundles,
        decorations: decorations.results || [],
      });
    }

    tables.push({
      table,
      data_sync: dataSync ? {
        data_sync: dataSync,
        synced_properties: dataSyncProperties,
      } : null,
      fields: fieldBundles,
      field_dependencies: fieldDependencies.results || [],
      field_rules: fieldRules,
      views: viewBundles,
      rows,
    });
  }

  const builderTheme = app.type === "builder"
    ? await optionalFirst(db, "SELECT * FROM builder_theme WHERE builder_id=?", applicationId)
    : null;
  const builderCustomCode = app.type === "builder"
    ? await optionalFirst(db, "SELECT * FROM builder_custom_code WHERE builder_id=?", applicationId)
    : null;
  const builderCustomScripts = app.type === "builder"
    ? await optionalAll<any>(db, "SELECT * FROM builder_custom_script WHERE builder_id=? ORDER BY [order] ASC, id ASC", applicationId)
    : [];
  const builderSettings = app.type === "builder"
    ? await optionalFirst<any>(db, "SELECT * FROM builder_settings WHERE builder_id=?", applicationId)
    : null;
  const builderPages = app.type === "builder"
    ? await optionalAll<any>(db, "SELECT * FROM builder_page WHERE builder_id=? ORDER BY [order] ASC, id ASC", applicationId)
    : [];
  const builderDomains = app.type === "builder" && includeBuilderDomains
    ? await optionalAll<any>(db, "SELECT * FROM builder_domain WHERE builder_id=? ORDER BY id ASC", applicationId)
    : [];
  const builderPageBundles = [];
  for (const page of builderPages) {
    builderPageBundles.push({
      page,
      elements: await optionalAll(db, "SELECT * FROM builder_element WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC", page.id),
      data_sources: await optionalAll(db, "SELECT * FROM builder_datasource WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC", page.id),
      workflow_actions: await optionalAll(db, "SELECT * FROM builder_workflowaction WHERE page_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC", page.id),
    });
  }

  const automationWorkflows = app.type === "automation"
    ? await optionalAll<any>(db, "SELECT * FROM automation_workflow WHERE automation_id=? AND trashed=0 ORDER BY COALESCE(is_published_version, 0) ASC, [order] ASC, id ASC", applicationId)
    : [];
  const automationWorkflowBundles = [];
  for (const workflow of automationWorkflows) {
    const histories = includeAutomationHistory
      ? await optionalAll<any>(db, "SELECT * FROM automation_workflow_history WHERE workflow_id=? ORDER BY started_on ASC, id ASC", workflow.id)
      : [];
    const historyBundles = [];
    for (const history of histories) {
      historyBundles.push({
        history,
        node_histories: await optionalAll(db, "SELECT * FROM automation_node_history WHERE workflow_history_id=? ORDER BY started_on ASC, id ASC", history.id),
      });
    }
    automationWorkflowBundles.push({
      workflow,
      nodes: await optionalAll(db, "SELECT * FROM automation_node WHERE workflow_id=? AND trashed=0 ORDER BY id ASC", workflow.id),
      histories: historyBundles,
    });
  }

  const documentPages = app.type === "document"
    ? await optionalAll<any>(db, "SELECT * FROM supertask_document_page WHERE document_id=? ORDER BY [order] ASC, id ASC", applicationId)
    : [];
  const whiteboardCanvases = app.type === "whiteboard"
    ? await optionalAll<any>(db, "SELECT * FROM supertask_whiteboard_canvas WHERE whiteboard_id=? AND trashed=0 ORDER BY [order] ASC, id ASC", applicationId)
    : [];
  const dashboardDataSources = app.type === "dashboard"
    ? await optionalAll<any>(db, "SELECT * FROM supertask_dashboard_data_source WHERE dashboard_id=? ORDER BY CAST([order] AS REAL) ASC, id ASC", applicationId)
    : [];
  const dashboardDataSourceBundles = [];
  for (const dataSource of dashboardDataSources) {
    dashboardDataSourceBundles.push({
      data_source: dataSource,
      aggregation_series: await optionalAll(db, "SELECT * FROM supertask_dashboard_aggregation_series WHERE data_source_id=? ORDER BY [order] ASC, id ASC", dataSource.id),
      aggregation_group_bys: await optionalAll(db, "SELECT * FROM supertask_dashboard_aggregation_group_by WHERE data_source_id=? ORDER BY [order] ASC, id ASC", dataSource.id),
      aggregation_sorts: await optionalAll(db, "SELECT * FROM supertask_dashboard_aggregation_sort WHERE data_source_id=? ORDER BY [order] ASC, id ASC", dataSource.id),
    });
  }
  const dashboardWidgets = app.type === "dashboard"
    ? await optionalAll<any>(db, "SELECT * FROM supertask_dashboard_widget WHERE dashboard_id=? ORDER BY [order] ASC, id ASC", applicationId)
    : [];

  const roleAssignments = await optionalAll(
    db,
    `SELECT ra.*, r.uid AS role_uid, u.email AS subject_email, team.name AS subject_name
       FROM enterprise_roleassignment ra
       JOIN enterprise_role r ON r.id=ra.role_id
       LEFT JOIN auth_user u ON ra.subject_type='auth.User' AND u.id=ra.subject_id
       LEFT JOIN enterprise_team team ON ra.subject_type='baserow_enterprise.Team' AND team.id=ra.subject_id
      WHERE (ra.scope_type='application' AND ra.scope_id=?)
         OR (ra.scope_type IN ('database_table', 'table') AND EXISTS (
              SELECT 1 FROM database_table t WHERE t.id=ra.scope_id AND t.database_id=?
            ))
         OR (ra.scope_type IN ('database_view', 'view') AND EXISTS (
              SELECT 1 FROM database_view v
              JOIN database_table t ON t.id=v.table_id
              WHERE v.id=ra.scope_id AND t.database_id=?
            ))
         OR (ra.scope_type IN ('database_field', 'field') AND EXISTS (
              SELECT 1 FROM database_field f
              JOIN database_table t ON t.id=f.table_id
              WHERE f.id=ra.scope_id AND t.database_id=?
            ))
      ORDER BY ra.id ASC`,
    applicationId,
    applicationId,
    applicationId,
    applicationId
  );
  const fieldPermissions = await optionalAll(
    db,
    `SELECT fp.*
       FROM enterprise_fieldpermission fp
       JOIN database_field f ON f.id=fp.field_id
       JOIN database_table t ON t.id=f.table_id
      WHERE t.database_id=?
      ORDER BY fp.id ASC`,
    applicationId
  );

  const snapshot = {
    version: 1,
    application: app,
    integrations,
    user_sources: userSources,
    tables,
    builder: app.type === "builder" ? {
      theme: builderTheme,
      custom_code: builderCustomCode,
      scripts: builderCustomScripts,
      settings: builderSettings,
      favicon_file: parseJson(builderSettings?.favicon_file),
      login_page: builderSettings?.login_page_id
        ? builderPageBundles.find((bundle) => Number((bundle as any).page?.id) === Number(builderSettings.login_page_id)) || null
        : null,
      pages: builderPageBundles,
      domains: builderDomains,
    } : null,
    automation: app.type === "automation" ? {
      workflows: automationWorkflowBundles,
    } : null,
    document: app.type === "document" ? {
      pages: documentPages,
    } : null,
    whiteboard: app.type === "whiteboard" ? {
      canvases: whiteboardCanvases,
    } : null,
    dashboard: app.type === "dashboard" ? {
      data_sources: dashboardDataSourceBundles,
      widgets: dashboardWidgets,
    } : null,
    enterprise: {
      role_assignments: roleAssignments,
      field_permissions: fieldPermissions,
    },
    created_at: new Date().toISOString(),
  };
  return {
    ...snapshot,
    user_files: await referencedSnapshotUserFiles(db, snapshot),
  };
}

async function restoreApplicationIntegrations(
  db: D1Database,
  applicationId: number,
  integrations: any[] | undefined,
  context: SnapshotRestoreContext,
  now: string
) {
  for (const integration of integrations || []) {
    const row = await db.prepare(
      `INSERT INTO core_integration (application_id, type, name, [order], configuration, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      applicationId,
      integration.type || "local_baserow",
      integration.name || "Integration",
      integration.order ?? "10000",
      remapStoredJson(integration.configuration, context),
      now,
      now
    ).first<any>();
    if (row?.id && integration.id) context.integrations.set(Number(integration.id), Number(row.id));
  }
}

async function restoreApplicationUserSources(
  db: D1Database,
  applicationId: number,
  userSources: any[] | undefined,
  context: SnapshotRestoreContext,
  now: string
) {
  for (const userSource of userSources || []) {
    const integrationId = userSource.integration_id
      ? remapId(userSource.integration_id, context.integrations)
      : null;
    const row = await db.prepare(
      `INSERT INTO core_usersource
       (application_id, integration_id, type, name, uid, [order], configuration, auth_providers, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      applicationId,
      integrationId,
      userSource.type || "database",
      userSource.name || "User source",
      crypto.randomUUID(),
      userSource.order ?? "10000",
      remapStoredJson(userSource.configuration, context),
      stringifyJson(remapJsonReferences(parseJson(userSource.auth_providers), restoreMaps(context))) || "[]",
      now,
      now
    ).first<any>();
    if (row?.id) {
      const uid = `__user_source_${row.id}`;
      await db.prepare("UPDATE core_usersource SET uid=? WHERE id=?").bind(uid, row.id).run();
      if (userSource.id) context.userSources.set(Number(userSource.id), Number(row.id));
    }
  }
}

async function uniqueBuilderDomainName(db: D1Database, proposed: unknown, builderId: number): Promise<string> {
  const value = String(proposed || "").trim();
  if (!value) return `builder-${builderId}.supertask.local`;
  const existing = await db.prepare("SELECT builder_id FROM builder_domain WHERE domain_name=?")
    .bind(value)
    .first<any>();
  if (!existing) return value;
  const dot = value.indexOf(".");
  const candidate = dot > 0
    ? `${value.slice(0, dot)}-copy-${builderId}${value.slice(dot)}`
    : `${value}-copy-${builderId}`;
  const candidateExists = await db.prepare("SELECT id FROM builder_domain WHERE domain_name=?")
    .bind(candidate)
    .first<any>();
  return candidateExists ? `${builderId}-${candidate}` : candidate;
}

async function restoreBuilderSnapshot(
  db: D1Database,
  applicationId: number,
  builderData: any,
  context: SnapshotRestoreContext,
  now: string
) {
  if (!builderData) return;
  if (builderData.theme) {
    await db.prepare("INSERT OR REPLACE INTO builder_theme (builder_id, theme, updated_on) VALUES (?, ?, ?)")
      .bind(applicationId, remapStoredJson(builderData.theme.theme, context), now)
      .run();
  }
  if (builderData.custom_code) {
    await db.prepare(
      "INSERT OR REPLACE INTO builder_custom_code (builder_id, css, js, created_on, updated_on) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(
        applicationId,
        String(builderData.custom_code.css || ""),
        String(builderData.custom_code.js || ""),
        now,
        now
      )
      .run();
  }
  for (const script of builderData.scripts || []) {
    await db.prepare(
      `INSERT INTO builder_custom_script
       (builder_id, [order], type, url, load_type, crossorigin, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      applicationId,
      script.order ?? "10000",
      script.type || "javascript",
      script.url || "",
      script.load_type || "",
      script.crossorigin || "",
      now,
      now
    ).run();
  }

  const pendingElements: Array<{ newId: number; oldParentId: number | null }> = [];
  for (const bundle of builderData.pages || []) {
    const page = bundle.page || bundle;
    const inserted = await db.prepare(
      `INSERT INTO builder_page
       (builder_id, name, path, path_params, query_params, shared, visibility, role_type, roles, settings, [order], created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      applicationId,
      page.name || "Page",
      page.path ?? "/",
      stringifyJson(remapJsonReferences(parseJson(page.path_params), restoreMaps(context))) || "[]",
      stringifyJson(remapJsonReferences(parseJson(page.query_params), restoreMaps(context))) || "[]",
      page.shared ? 1 : 0,
      page.visibility || "all",
      page.role_type || "allow_all",
      stringifyJson(remapJsonReferences(parseJson(page.roles), restoreMaps(context))) || "[]",
      remapStoredJson(page.settings, context),
      page.order ?? 1,
      now,
      now
    ).first<any>();
    if (inserted?.id && page.id) context.builderPages.set(Number(page.id), Number(inserted.id));
  }

  const loginPageSource =
    builderData.login_page?.page ||
    builderData.login_page ||
    (builderData.settings?.login_page_id
      ? { id: builderData.settings.login_page_id }
      : null);
  const loginPageId = loginPageSource?.id
    ? context.builderPages.get(Number(loginPageSource.id)) ?? null
    : null;
  await optionalRun(
    db,
    `INSERT INTO builder_settings (builder_id, favicon_file, login_page_id, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(builder_id) DO UPDATE SET
       favicon_file=excluded.favicon_file,
       login_page_id=excluded.login_page_id,
       updated_on=excluded.updated_on`,
    applicationId,
    stringifyJson(builderData.favicon_file ?? parseJson(builderData.settings?.favicon_file)),
    loginPageId,
    now,
    now
  );

  for (const bundle of builderData.pages || []) {
    const oldPageId = Number((bundle.page || bundle).id);
    const newPageId = context.builderPages.get(oldPageId);
    if (!newPageId) continue;
    for (const dataSource of bundle.data_sources || []) {
      const inserted = await db.prepare(
        `INSERT INTO builder_datasource (page_id, type, name, [order], configuration, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        newPageId,
        dataSource.type || "local_baserow_list_rows",
        dataSource.name || "Data source",
        dataSource.order ?? "10000",
        remapStoredJson(dataSource.configuration, context),
        now,
        now
      ).first<any>();
      if (inserted?.id && dataSource.id) context.builderDataSources.set(Number(dataSource.id), Number(inserted.id));
    }
  }

  for (const bundle of builderData.pages || []) {
    const oldPageId = Number((bundle.page || bundle).id);
    const newPageId = context.builderPages.get(oldPageId);
    if (!newPageId) continue;
    for (const element of bundle.elements || []) {
      const inserted = await db.prepare(
        `INSERT INTO builder_element
         (page_id, type, [order], parent_element_id, place_in_container, configuration, created_on, updated_on)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?) RETURNING id`
      ).bind(
        newPageId,
        element.type || "heading",
        element.order ?? "10000",
        element.place_in_container ?? null,
        remapStoredJson(element.configuration, context),
        now,
        now
      ).first<any>();
      if (inserted?.id) {
        if (element.id) context.builderElements.set(Number(element.id), Number(inserted.id));
        pendingElements.push({
          newId: Number(inserted.id),
          oldParentId: element.parent_element_id ? Number(element.parent_element_id) : null,
        });
      }
    }
  }

  for (const pending of pendingElements) {
    if (!pending.oldParentId) continue;
    const parentId = context.builderElements.get(pending.oldParentId);
    if (parentId) {
      await db.prepare("UPDATE builder_element SET parent_element_id=?, updated_on=? WHERE id=?")
        .bind(parentId, now, pending.newId)
        .run();
    }
  }

  for (const domain of builderData.domains || []) {
    const domainName = await uniqueBuilderDomainName(db, domain.domain_name, applicationId);
    await db.prepare(
      `INSERT INTO builder_domain
       (builder_id, type, domain_name, published, last_published, settings, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      applicationId,
      domain.type || "custom",
      domainName,
      domain.published ? 1 : 0,
      domain.last_published || null,
      remapStoredJson(domain.settings, context),
      now,
      now
    ).run();
  }

  for (const bundle of builderData.pages || []) {
    const oldPageId = Number((bundle.page || bundle).id);
    const newPageId = context.builderPages.get(oldPageId);
    if (!newPageId) continue;
    for (const action of bundle.workflow_actions || []) {
      const inserted = await db.prepare(
        `INSERT INTO builder_workflowaction
         (page_id, element_id, type, event, [order], configuration, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        newPageId,
        action.element_id ? remapId(action.element_id, context.builderElements) : null,
        action.type || "notification",
        action.event || "click",
        action.order ?? "10000",
        remapStoredJson(action.configuration, context),
        now,
        now
      ).first<any>();
      if (inserted?.id && action.id) context.builderWorkflowActions.set(Number(action.id), Number(inserted.id));
    }
  }
}

async function restoreAutomationSnapshot(
  db: D1Database,
  applicationId: number,
  automationData: any,
  context: SnapshotRestoreContext,
  now: string
) {
  if (!automationData) return;
  for (const bundle of automationData.workflows || []) {
    const workflow = bundle.workflow || bundle;
    const inserted = await db.prepare(
      `INSERT INTO automation_workflow
       (automation_id, name, [order], state, allow_test_run_until, simulate_until_node_id, published_on,
        graph, trashed, created_on, updated_on, published_from_workflow_id, is_published_version)
       VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', 0, ?, ?, NULL, ?) RETURNING id`
    ).bind(
      applicationId,
      workflow.name || "Workflow",
      workflow.order ?? 1,
      workflow.state || "draft",
      workflow.allow_test_run_until || null,
      workflow.published_on || null,
      now,
      now,
      workflow.is_published_version ? 1 : 0
    ).first<any>();
    if (inserted?.id && workflow.id) context.automationWorkflows.set(Number(workflow.id), Number(inserted.id));
  }

  const pendingNodes: Array<{ newId: number; oldNode: any }> = [];
  for (const bundle of automationData.workflows || []) {
    const oldWorkflowId = Number((bundle.workflow || bundle).id);
    const newWorkflowId = context.automationWorkflows.get(oldWorkflowId);
    if (!newWorkflowId) continue;
    for (const node of bundle.nodes || []) {
      const inserted = await db.prepare(
        `INSERT INTO automation_node (workflow_id, type, label, service, trashed, created_on, updated_on)
         VALUES (?, ?, ?, '{}', 0, ?, ?) RETURNING id`
      ).bind(
        newWorkflowId,
        node.type || "noop",
        node.label || "",
        now,
        now
      ).first<any>();
      if (inserted?.id) {
        if (node.id) context.automationNodes.set(Number(node.id), Number(inserted.id));
        pendingNodes.push({ newId: Number(inserted.id), oldNode: node });
      }
    }
  }

  for (const bundle of automationData.workflows || []) {
    const workflow = bundle.workflow || bundle;
    const newWorkflowId = context.automationWorkflows.get(Number(workflow.id));
    if (!newWorkflowId) continue;
    await db.prepare(
      `UPDATE automation_workflow
       SET graph=?, simulate_until_node_id=?, published_from_workflow_id=?, updated_on=?
       WHERE id=?`
    ).bind(
      stringifyJson(remapAutomationGraph(workflow.graph, context.automationNodes)) || "{}",
      workflow.simulate_until_node_id ? remapId(workflow.simulate_until_node_id, context.automationNodes) : null,
      workflow.published_from_workflow_id ? remapId(workflow.published_from_workflow_id, context.automationWorkflows) : null,
      now,
      newWorkflowId
    ).run();
  }

  for (const pending of pendingNodes) {
    await db.prepare("UPDATE automation_node SET service=?, updated_on=? WHERE id=?")
      .bind(remapStoredJson(pending.oldNode.service, context), now, pending.newId)
      .run();
  }

  for (const bundle of automationData.workflows || []) {
    const oldWorkflowId = Number((bundle.workflow || bundle).id);
    const newWorkflowId = context.automationWorkflows.get(oldWorkflowId);
    if (!newWorkflowId) continue;
    for (const historyBundle of bundle.histories || []) {
      const history = historyBundle.history || historyBundle;
      const inserted = await db.prepare(
        `INSERT INTO automation_workflow_history
         (workflow_id, started_on, completed_on, is_test_run, message, status, event_payload, simulate_until_node_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        newWorkflowId,
        history.started_on || now,
        history.completed_on || null,
        history.is_test_run ? 1 : 0,
        history.message || "",
        history.status || "started",
        remapStoredJson(history.event_payload, context),
        history.simulate_until_node_id ? remapId(history.simulate_until_node_id, context.automationNodes) : null
      ).first<any>();
      if (!inserted?.id) continue;
      for (const nodeHistory of historyBundle.node_histories || []) {
        const newNodeId = nodeHistory.node_id ? remapId(nodeHistory.node_id, context.automationNodes) : null;
        if (!newNodeId) continue;
        await db.prepare(
          `INSERT INTO automation_node_history
           (workflow_history_id, node_id, started_on, completed_on, status, message, input, output)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          inserted.id,
          newNodeId,
          nodeHistory.started_on || now,
          nodeHistory.completed_on || null,
          nodeHistory.status || "started",
          nodeHistory.message || "",
          remapStoredJson(nodeHistory.input, context),
          remapStoredJson(nodeHistory.output, context)
        ).run();
      }
    }
  }
}

async function restoreDocumentSnapshot(
  db: D1Database,
  applicationId: number,
  documentData: any,
  context: SnapshotRestoreContext,
  now: string
): Promise<void> {
  if (!documentData) return;
  const pendingParents: Array<{ pageId: number; oldParentId: number }> = [];
  for (const page of documentData.pages || []) {
    const baseValues = [
      applicationId, page.title || "",
      typeof page.content === "string" ? page.content : stringifyJson(page.content) || "",
      page.icon || "",
    ] as const;
    let inserted: { id: number } | null;
    try {
      inserted = await db.prepare(
        `INSERT INTO supertask_document_page
         (document_id, parent_id, title, content, icon, cover, settings, editor_schema_version,
          collaboration_initialized, [order], created_on, updated_on)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) RETURNING id`
      ).bind(
        ...baseValues, page.cover || "", stringifyJson(parseJson(page.settings)) || "{}",
        Math.max(1, Number(page.editor_schema_version) || 1), page.order ?? 0,
        page.created_on || now, page.updated_on || now
      ).first<{ id: number }>();
    } catch (error) {
      if (!String(error).includes("no column named cover")) throw error;
      inserted = await db.prepare(
        `INSERT INTO supertask_document_page
         (document_id, parent_id, title, content, icon, [order], created_on, updated_on)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(...baseValues, page.order ?? 0, page.created_on || now, page.updated_on || now).first<{ id: number }>();
    }
    if (!inserted?.id) continue;
    if (page.id) context.documentPages.set(Number(page.id), Number(inserted.id));
    if (page.parent_id) pendingParents.push({ pageId: Number(inserted.id), oldParentId: Number(page.parent_id) });
  }
  for (const pending of pendingParents) {
    const parentId = context.documentPages.get(pending.oldParentId);
    if (parentId) {
      await db.prepare("UPDATE supertask_document_page SET parent_id=? WHERE id=?")
        .bind(parentId, pending.pageId)
        .run();
    }
  }
}

async function restoreWhiteboardSnapshot(
  db: D1Database,
  applicationId: number,
  whiteboardData: any,
  now: string,
): Promise<void> {
  if (!whiteboardData) return;
  for (const canvas of whiteboardData.canvases || []) {
    await db.prepare(
      `INSERT INTO supertask_whiteboard_canvas
       (whiteboard_id, name, icon, [order], state, settings, thumbnail_key,
        editor_schema_version, trashed, created_by_id, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
    ).bind(
      applicationId,
      canvas.name || "Canevas",
      canvas.icon || "🧠",
      canvas.order ?? 0,
      stringifyJson(parseJson(canvas.state)) || '{"nodes":[],"edges":[],"strokes":[]}',
      stringifyJson(parseJson(canvas.settings)) || "{}",
      canvas.thumbnail_key || "",
      Math.max(1, Number(canvas.editor_schema_version) || 1),
      canvas.created_on || now,
      canvas.updated_on || now,
    ).run();
  }
}

function remapDashboardReference(value: unknown, fieldMap: Map<number, number>): string {
  return String(value || "").replace(/^field_(\d+)(.*)$/, (_match, id, suffix) => {
    const mapped = fieldMap.get(Number(id));
    return mapped ? `field_${mapped}${suffix}` : `field_${id}${suffix}`;
  });
}

function remapDashboardWidgetConfig(value: unknown, context: SnapshotRestoreContext): unknown {
  if (Array.isArray(value)) return value.map((item) => remapDashboardWidgetConfig(item, context));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (key === "series_id") {
      return [key, remapId(item, context.dashboardAggregationSeries)];
    }
    if (key === "field_id") return [key, remapId(item, context.fields)];
    if (key === "table_id") return [key, remapId(item, context.tables)];
    if (key === "view_id") return [key, remapId(item, context.views)];
    if (key === "integration_id") return [key, remapId(item, context.integrations)];
    return [key, remapDashboardWidgetConfig(item, context)];
  }));
}

async function restoreDashboardSnapshot(
  db: D1Database,
  applicationId: number,
  dashboardData: any,
  context: SnapshotRestoreContext,
  now: string
): Promise<void> {
  if (!dashboardData) return;
  for (const bundle of dashboardData.data_sources || []) {
    const dataSource = bundle.data_source || bundle;
    const inserted = await db.prepare(
      `INSERT INTO supertask_dashboard_data_source
       (dashboard_id, type, name, [order], service, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      applicationId,
      dataSource.type || "local_baserow_aggregate_rows",
      dataSource.name || "",
      dataSource.order ?? "1",
      remapStoredJson(dataSource.service, context),
      dataSource.created_on || now,
      dataSource.updated_on || now
    ).first<{ id: number }>();
    if (!inserted?.id) continue;
    if (dataSource.id) context.dashboardDataSources.set(Number(dataSource.id), Number(inserted.id));

    for (const series of bundle.aggregation_series || []) {
      const restoredSeries = await db.prepare(
        `INSERT INTO supertask_dashboard_aggregation_series
         (data_source_id, field_id, aggregation_type, [order])
         VALUES (?, ?, ?, ?) RETURNING id`
      ).bind(
        inserted.id,
        series.field_id ? remapId(series.field_id, context.fields) : null,
        series.aggregation_type || "",
        series.order ?? 1
      ).first<{ id: number }>();
      if (restoredSeries?.id && series.id) {
        context.dashboardAggregationSeries.set(Number(series.id), Number(restoredSeries.id));
      }
    }
    for (const groupBy of bundle.aggregation_group_bys || []) {
      await db.prepare(
        `INSERT INTO supertask_dashboard_aggregation_group_by (data_source_id, field_id, [order])
         VALUES (?, ?, ?)`
      ).bind(
        inserted.id,
        groupBy.field_id ? remapId(groupBy.field_id, context.fields) : null,
        groupBy.order ?? 1
      ).run();
    }
    for (const sort of bundle.aggregation_sorts || []) {
      await db.prepare(
        `INSERT INTO supertask_dashboard_aggregation_sort
         (data_source_id, sort_on, reference, direction, [order])
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        inserted.id,
        sort.sort_on || "",
        remapDashboardReference(sort.reference, context.fields),
        sort.direction || "ASC",
        sort.order ?? 1
      ).run();
    }
  }

  for (const widget of dashboardData.widgets || []) {
    const config = remapDashboardWidgetConfig(parseJson(widget.config), context);
    await db.prepare(
      `INSERT INTO supertask_dashboard_widget
       (dashboard_id, type, title, description, [order], data_source_id, config, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      applicationId,
      widget.type || "summary",
      widget.title || "",
      widget.description || "",
      widget.order ?? 0,
      widget.data_source_id ? remapId(widget.data_source_id, context.dashboardDataSources) : null,
      stringifyJson(config) || "{}",
      widget.created_on || now,
      widget.updated_on || now
    ).run();
  }
}

async function restoreTableDataSync(
  db: D1Database,
  tableId: number,
  dataSyncBundle: any,
  context: SnapshotRestoreContext,
  now: string
) {
  const dataSync = dataSyncBundle?.data_sync || dataSyncBundle;
  if (!dataSync?.type) return;

  const row = await db.prepare(
    `INSERT INTO database_datasync
     (table_id, type, synced_properties, settings, last_sync, last_error,
      auto_add_new_properties, two_way_sync, authorized, periodic_interval,
      periodic_interval_count, last_periodic_sync, next_periodic_sync,
      consecutive_failures, deactivated, deactivation_reason, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    tableId,
    dataSync.type,
    remapDataSyncStoredJson(dataSync.synced_properties || "[]", context),
    remapDataSyncStoredJson(dataSync.settings || "{}", context),
    dataSync.last_sync || null,
    dataSync.last_error || null,
    dataSync.auto_add_new_properties ? 1 : 0,
    dataSync.two_way_sync ? 1 : 0,
    dataSync.authorized === 0 ? 0 : 1,
    dataSync.periodic_interval || null,
    dataSync.periodic_interval_count || 1,
    dataSync.last_periodic_sync || null,
    dataSync.next_periodic_sync || null,
    dataSync.consecutive_failures || 0,
    dataSync.deactivated ? 1 : 0,
    dataSync.deactivation_reason || null,
    dataSync.created_on || now,
    dataSync.updated_on || now
  ).first<any>();
  if (!row?.id) throw new Error("Failed to restore data sync");

  await db.prepare("UPDATE database_table SET data_sync_id=? WHERE id=?")
    .bind(row.id, tableId)
    .run();

  for (const property of dataSyncBundle?.synced_properties || []) {
    await db.prepare(
      `INSERT OR IGNORE INTO database_datasyncsyncedproperty
       (data_sync_id, field_id, key, unique_primary)
       VALUES (?, ?, ?, ?)`
    ).bind(
      row.id,
      property.field_id ? remapId(property.field_id, context.fields) : null,
      remapDataSyncPropertyKey(property.key, context.fields),
      property.unique_primary ? 1 : 0
    ).run();
  }
}

export async function restoreApplicationSnapshot(
  db: D1Database,
  snapshot: any,
  data: any,
  options: {
    targetWorkspaceId?: number;
    name?: string;
    context?: SnapshotRestoreContext;
    onApplicationCreated?: (application: any) => void | Promise<void>;
    loadTableRows?: (oldTableId: number) => AsyncIterable<any[]>;
  } = {}
) {
  const now = new Date().toISOString();
  const sourceApp = data.application;
  const context = createSnapshotRestoreContext(options.context);
  const workspaceId = options.targetWorkspaceId ?? sourceApp.workspace_id;
  const requestedName = options.name || snapshot.name || sourceApp.name;
  const applicationName = options.name
    ? requestedName
    : await findUnusedApplicationName(db, workspaceId, requestedName);
  const tableMap = new Map<number, number>();
  const fieldMap = new Map<number, number>();
  const selectOptionMap = new Map<number, number>();
  const rowMapByTable = new Map<number, Map<number, number>>();
  const pendingFieldSettings: Array<{ fieldId: number; type: string; settings: unknown }> = [];
  const pendingFieldDependencies: any[] = [];
  const pendingDataSyncs: Array<{ tableId: number; bundle: unknown }> = [];
  const pendingFieldRules: Array<{ tableId: number; rules: any[] }> = [];
  const pendingLinkValues: Array<{
    tableId: number;
    rowId: number;
    fieldId: number;
    targetOldTableId: number;
    value: unknown;
  }> = [];
  const newApp = await db.prepare(
    `INSERT INTO core_application (workspace_id, name, type, [order], trashed, created_on, updated_on)
     VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING *`
  ).bind(
    workspaceId,
    applicationName,
    sourceApp.type || "database",
    (sourceApp.order || 1) + 1,
    now,
    now
  ).first<any>();
  if (!newApp) throw new Error("Failed to restore application");
  await options.onApplicationCreated?.(newApp);
  if (sourceApp.id) context.applications.set(Number(sourceApp.id), Number(newApp.id));

  for (const tableBundle of data.tables || []) {
    const oldTable = tableBundle.table;
    const newTable = await db.prepare(
      `INSERT INTO database_table (database_id, name, [order], version, trashed, created_on, updated_on,
       needs_background_update_column_added, last_modified_by_column_added, created_by_column_added)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, 0) RETURNING *`
    ).bind(newApp.id, oldTable.name, oldTable.order, oldTable.version || 1, now, now).first<any>();
    if (!newTable) throw new Error("Failed to restore table");
    tableMap.set(Number(oldTable.id), Number(newTable.id));
    context.tables.set(Number(oldTable.id), Number(newTable.id));
    rowMapByTable.set(Number(oldTable.id), new Map());
    if (tableBundle.data_sync) pendingDataSyncs.push({ tableId: Number(newTable.id), bundle: tableBundle.data_sync });
    if (Array.isArray(tableBundle.field_rules) && tableBundle.field_rules.length > 0) {
      pendingFieldRules.push({ tableId: Number(newTable.id), rules: tableBundle.field_rules });
    }
    pendingFieldDependencies.push(...(tableBundle.field_dependencies || []));

    await getOrCreateUserTable(db, newTable.id);
    const fieldBundles = (tableBundle.fields || []).map((bundle: any) => bundle?.field ? bundle : { field: bundle, select_options: [] });
    const oldFields = fieldBundles.map((bundle: any) => bundle.field);
    for (const fieldBundle of fieldBundles) {
      const oldField = fieldBundle.field;
      const newField = await db.prepare(
        `INSERT INTO database_field
         (table_id, name, type, [order], "primary", read_only, trashed, description, db_index,
          immutable_type, immutable_properties, field_settings, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).bind(
        newTable.id,
        oldField.name,
        oldField.type,
        oldField.order,
        oldField.primary ? 1 : 0,
        oldField.read_only ? 1 : 0,
        oldField.description,
        oldField.db_index ? 1 : 0,
        oldField.immutable_type ? 1 : 0,
        oldField.immutable_properties ? 1 : 0,
        oldField.field_settings,
        now,
        now
      ).first<any>();
      if (!newField) throw new Error("Failed to restore field");
      fieldMap.set(oldField.id, newField.id);
      context.fields.set(Number(oldField.id), Number(newField.id));
      pendingFieldSettings.push({ fieldId: newField.id, type: oldField.type, settings: oldField.field_settings });
      await addFieldColumn(db, newTable.id, { id: newField.id, type: newField.type as FieldType, primary: Boolean(newField.primary) });

      for (const oldOption of fieldBundle.select_options || []) {
        const newOption = await db.prepare(
          `INSERT INTO database_selectoption (field_id, value, color, [order])
           VALUES (?, ?, ?, ?) RETURNING id`
        ).bind(newField.id, oldOption.value, oldOption.color || "blue", oldOption.order ?? 1).first<any>();
        if (newOption?.id) {
          selectOptionMap.set(Number(oldOption.id), Number(newOption.id));
          context.selectOptions.set(Number(oldOption.id), Number(newOption.id));
        }
      }
    }

    for (const viewBundleRaw of tableBundle.views || []) {
      const viewBundle = viewBundleRaw?.view ? viewBundleRaw : { view: viewBundleRaw };
      const oldView = viewBundle.view;
      const newView = await db.prepare(
        `INSERT INTO database_view (table_id, name, type, [order], filter_type, filters_disabled, public, allow_public_export,
         public_view_password, slug, trashed, created_on, updated_on, row_identifier_type,
         ownership_type, owned_by_id, show_logo, row_height_size, card_cover_image_field, single_select_field, date_field,
         ical_public, ical_slug, start_date_field, end_date_field, timescale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).bind(
        newTable.id,
        oldView.name,
        oldView.type,
        oldView.order,
        oldView.filter_type || "AND",
        oldView.filters_disabled ? 1 : 0,
        oldView.public ? 1 : 0,
        oldView.allow_public_export ? 1 : 0,
        oldView.public_view_password || null,
        crypto.randomUUID().replace(/-/g, "").slice(0, 20),
        now,
        now,
        oldView.row_identifier_type || "count",
        oldView.ownership_type || "collaborative",
        oldView.owned_by_id ?? null,
        oldView.show_logo === 0 ? 0 : 1,
        oldView.row_height_size || "small",
        remapId(oldView.card_cover_image_field, fieldMap) ?? null,
        remapId(oldView.single_select_field, fieldMap) ?? null,
        remapId(oldView.date_field, fieldMap) ?? null,
        oldView.ical_public ? 1 : 0,
        oldView.ical_slug ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : null,
        remapId(oldView.start_date_field, fieldMap) ?? null,
        remapId(oldView.end_date_field, fieldMap) ?? null,
        oldView.timescale || "month"
      ).first<any>();
      if (!newView) throw new Error("Failed to restore view");
      context.views.set(Number(oldView.id), Number(newView.id));

      const viewGroupMap = new Map<number, number>();
      for (const oldGroup of viewBundle.filter_groups || []) {
        const parent = oldGroup.parent_group_id ? viewGroupMap.get(Number(oldGroup.parent_group_id)) ?? null : null;
        const group = await db.prepare(
          `INSERT INTO database_viewfiltergroup (view_id, parent_group_id, filter_type)
           VALUES (?, ?, ?) RETURNING id`
        ).bind(newView.id, parent, oldGroup.filter_type || "AND").first<any>();
        if (group?.id) viewGroupMap.set(Number(oldGroup.id), Number(group.id));
      }
      for (const oldFilter of viewBundle.filters || []) {
        await db.prepare(
          `INSERT INTO database_viewfilter (view_id, field_id, type, value, preload_values, group_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          newView.id,
          remapId(oldFilter.field_id, fieldMap),
          oldFilter.type,
          oldFilter.value ?? "",
          stringifyJson(remapJsonReferences(parseJson(oldFilter.preload_values), { fields: fieldMap, selectOptions: selectOptionMap })) || "{}",
          oldFilter.group_id ? viewGroupMap.get(Number(oldFilter.group_id)) ?? null : null
        ).run();
      }
      for (const oldSort of viewBundle.sortings || []) {
        await db.prepare("INSERT INTO database_viewsort (view_id, field_id, [order], type) VALUES (?, ?, ?, ?)")
          .bind(newView.id, remapId(oldSort.field_id, fieldMap), oldSort.order || "ASC", oldSort.type || "default")
          .run();
      }
      for (const oldGroupBy of viewBundle.group_bys || []) {
        await db.prepare("INSERT INTO database_viewgroupby (view_id, field_id, [order], width, type) VALUES (?, ?, ?, ?, ?)")
          .bind(newView.id, remapId(oldGroupBy.field_id, fieldMap), oldGroupBy.order || "ASC", oldGroupBy.width ?? 200, oldGroupBy.type || "default")
          .run();
      }
      for (const option of viewBundle.grid_field_options || []) {
        await db.prepare(
          `INSERT OR IGNORE INTO database_gridviewfieldoptions
           (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          newView.id,
          remapId(option.field_id, fieldMap),
          option.width ?? 200,
          option.hidden ? 1 : 0,
          option.order ?? 32767,
          option.aggregation_type || "",
          option.aggregation_raw_type || ""
        ).run();
      }
      for (const option of viewBundle.gallery_field_options || []) {
        await db.prepare(
          "INSERT OR IGNORE INTO database_galleryviewfieldoptions (gallery_view_id, field_id, hidden, [order]) VALUES (?, ?, ?, ?)"
        ).bind(newView.id, remapId(option.field_id, fieldMap), option.hidden ? 1 : 0, option.order ?? 32767).run();
      }
      if (viewBundle.form_view) {
        const form = viewBundle.form_view;
        await db.prepare(
          `INSERT OR REPLACE INTO database_formview
           (view_ptr_id, title, description, submit_text, submit_action, submit_action_message,
            submit_action_redirect_url, mode, show_logo, cover_image, logo_image)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          newView.id,
          form.title || "",
          form.description || "",
          form.submit_text || "Submit",
          form.submit_action || "MESSAGE",
          form.submit_action_message || "",
          form.submit_action_redirect_url || "",
          form.mode === "survey" ? "survey" : "form",
          form.show_logo === 0 ? 0 : 1,
          form.cover_image || null,
          form.logo_image || null
        ).run();
      }
      for (const subscriber of viewBundle.form_users_to_notify || []) {
        await db.prepare(
          `INSERT OR IGNORE INTO database_formview_users_to_notify_on_submit (formview_id, user_id)
           SELECT ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM auth_user u
             JOIN core_workspaceuser wu ON wu.user_id=u.id
             WHERE u.id=? AND wu.workspace_id=? AND wu.to_be_deleted=0
           )`
        ).bind(newView.id, subscriber.user_id, subscriber.user_id, newApp.workspace_id).run();
      }
      const formOptionMap = new Map<number, number>();
      for (const formOptionBundle of viewBundle.form_field_options || []) {
        const option = formOptionBundle.option;
        const newOption = await db.prepare(
          `INSERT INTO database_formviewfieldoptions
           (form_view_id, field_id, name, description, enabled, required, [order],
            show_when_matching_conditions, condition_type, include_all_select_options, field_component)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(
          newView.id,
          remapId(option.field_id, fieldMap),
          option.name || "",
          option.description || "",
          option.enabled ? 1 : 0,
          option.required ? 1 : 0,
          option.order ?? 32767,
          option.show_when_matching_conditions ? 1 : 0,
          option.condition_type || "AND",
          option.include_all_select_options === 0 ? 0 : 1,
          option.field_component || "default"
        ).first<any>();
        if (newOption?.id) formOptionMap.set(Number(option.id), Number(newOption.id));
      }
      const formGroupMap = new Map<number, number>();
      for (const formOptionBundle of viewBundle.form_field_options || []) {
        const newOptionId = formOptionMap.get(Number(formOptionBundle.option.id));
        if (!newOptionId) continue;
        for (const allowed of formOptionBundle.allowed_select_options || []) {
          const newSelectOptionId = selectOptionMap.get(Number(allowed.select_option_id));
          if (newSelectOptionId) {
            await db.prepare(
              `INSERT OR IGNORE INTO database_formviewfieldoptions_allowedselectoptions
               (form_view_field_options_id, select_option_id)
               VALUES (?, ?)`
            ).bind(newOptionId, newSelectOptionId).run();
          }
        }
        for (const group of formOptionBundle.condition_groups || []) {
          const parent = group.parent_group_id ? formGroupMap.get(Number(group.parent_group_id)) ?? null : null;
          const newGroup = await db.prepare(
            `INSERT INTO database_formviewfieldoptionsconditiongroup
             (field_option_id, filter_type, parent_group_id)
             VALUES (?, ?, ?) RETURNING id`
          ).bind(newOptionId, group.filter_type || "AND", parent).first<any>();
          if (newGroup?.id) formGroupMap.set(Number(group.id), Number(newGroup.id));
        }
      }
      for (const formOptionBundle of viewBundle.form_field_options || []) {
        const newOptionId = formOptionMap.get(Number(formOptionBundle.option.id));
        if (!newOptionId) continue;
        for (const condition of formOptionBundle.conditions || []) {
          await db.prepare(
            `INSERT INTO database_formviewfieldoptionscondition
             (field_option_id, field_id, type, value, group_id)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(
            newOptionId,
            remapId(condition.field_id, fieldMap),
            condition.type,
            condition.value ?? "",
            condition.group_id ? formGroupMap.get(Number(condition.group_id)) ?? null : null
          ).run();
        }
      }
      for (const decoration of viewBundle.decorations || []) {
        await db.prepare(
          `INSERT INTO database_viewdecoration (view_id, type, value_provider_type, value_provider_conf, [order])
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          newView.id,
          decoration.type,
          decoration.value_provider_type || "",
          stringifyJson(remapJsonReferences(parseJson(decoration.value_provider_conf), { fields: fieldMap, selectOptions: selectOptionMap })) || "{}",
          decoration.order ?? 1
        ).run();
      }
    }

    const inlineRows = async function* () {
      yield tableBundle.rows || [];
    };
    const rowChunks = options.loadTableRows
      ? options.loadTableRows(Number(oldTable.id))
      : inlineRows();
    for await (const rowChunk of rowChunks) {
      for (const oldRow of rowChunk) {
      const cols = ["[order]", "_created_on", "_updated_on", "_created_by_id", "_last_modified_by_id"];
      const vals: unknown[] = [
        oldRow.order ?? oldRow["[order]"] ?? 10000,
        oldRow._created_on || now,
        oldRow._updated_on || now,
        oldRow._created_by_id || null,
        oldRow._last_modified_by_id || null,
      ];
      for (const oldField of oldFields) {
        const newFieldId = fieldMap.get(oldField.id);
        if (!newFieldId) continue;
        if (oldField.type === "link_row") continue;
        cols.push(`"field_${newFieldId}"`);
        const rawValue = oldRow[`field_${oldField.id}`];
        const value = oldField.type === "single_select" || oldField.type === "multiple_select"
          ? remapSelectValue(rawValue, selectOptionMap)
          : rawValue;
        vals.push(serializeFieldValueForInsert(oldField.type as FieldType, value));
      }
      const bindMarks = cols.map(() => "?").join(", ");
      const inserted = await db.prepare(`INSERT INTO "database_table_${newTable.id}" (${cols.join(", ")}) VALUES (${bindMarks}) RETURNING id`)
        .bind(...vals)
        .first<any>();
      if (inserted?.id) rowMapByTable.get(Number(oldTable.id))?.set(Number(oldRow.id), Number(inserted.id));
      for (const oldField of oldFields.filter((field: any) => field.type === "link_row")) {
        const newFieldId = fieldMap.get(oldField.id);
        if (!newFieldId || !inserted?.id) continue;
        const settings = parseJson(oldField.field_settings) as Record<string, unknown> | null;
        pendingLinkValues.push({
          tableId: Number(newTable.id),
          rowId: Number(inserted.id),
          fieldId: Number(newFieldId),
          targetOldTableId: Number(settings?.link_row_table_id || oldTable.id),
          value: oldRow[`field_${oldField.id}`],
        });
      }
      }
    }
  }

  for (const pending of pendingFieldSettings) {
    let settings = remapJsonReferences(parseJson(pending.settings), {
      fields: fieldMap,
      tables: tableMap,
      selectOptions: selectOptionMap,
    });
    if (pending.type === "ai" && settings && typeof settings === "object" && !Array.isArray(settings)) {
      settings = await disableInvalidAIAutoUpdateUser(db, workspaceId, settings as Record<string, unknown>);
    }
    await db.prepare("UPDATE database_field SET field_settings=? WHERE id=?")
      .bind(stringifyJson(settings), pending.fieldId)
      .run();
  }

  for (const dependency of pendingFieldDependencies) {
    const dependantId = fieldMap.get(Number(dependency.dependant_id));
    if (!dependantId) continue;
    const dependencyId = dependency.dependency_id === null || dependency.dependency_id === undefined
      ? null
      : fieldMap.get(Number(dependency.dependency_id)) ?? null;
    const viaId = dependency.via_id === null || dependency.via_id === undefined
      ? null
      : fieldMap.get(Number(dependency.via_id)) ?? null;
    const brokenReference = dependencyId
      ? null
      : dependency.broken_reference_field_name || dependency.restore_broken_reference_field_name || null;
    await db.prepare(
      `INSERT INTO database_fielddependency
       (dependant_id, via_id, dependency_id, broken_reference_field_name)
       VALUES (?, ?, ?, ?)`
    ).bind(dependantId, viaId, dependencyId, brokenReference).run();
  }

  for (const pending of pendingLinkValues) {
    const rowMap = rowMapByTable.get(pending.targetOldTableId) || new Map<number, number>();
    const value = remapLinkRowValue(pending.value, rowMap);
    await db.prepare(`UPDATE "database_table_${pending.tableId}" SET "field_${pending.fieldId}"=? WHERE id=?`)
      .bind(serializeFieldValueForInsert("link_row", value), pending.rowId)
      .run();
  }

  for (const pending of pendingFieldRules) {
    for (const rule of pending.rules) {
      const settings = remapJsonReferences(parseJson(rule.settings), { fields: fieldMap, tables: tableMap });
      await db.prepare(
        `INSERT INTO database_fieldrule
         (table_id, type, is_active, is_valid, error_text, settings, created_on, updated_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        pending.tableId,
        rule.type,
        rule.is_active ? 1 : 0,
        rule.is_valid ? 1 : 0,
        rule.error_text || null,
        stringifyJson(settings) || "{}",
        rule.created_on || now,
        rule.updated_on || now
      ).run();
    }
    await revalidateDateDependencyRules(db, pending.tableId);
  }

  for (const pending of pendingDataSyncs) {
    await restoreTableDataSync(db, pending.tableId, pending.bundle, context, now);
  }

  await restoreApplicationIntegrations(db, Number(newApp.id), data.integrations, context, now);
  await restoreApplicationUserSources(db, Number(newApp.id), data.user_sources, context, now);
  await restoreDocumentSnapshot(db, Number(newApp.id), data.document, context, now);
  await restoreWhiteboardSnapshot(db, Number(newApp.id), data.whiteboard, now);
  await restoreDashboardSnapshot(db, Number(newApp.id), data.dashboard, context, now);
  await restoreBuilderSnapshot(db, Number(newApp.id), data.builder, context, now);
  await restoreAutomationSnapshot(db, Number(newApp.id), data.automation, context, now);
  await restoreEnterpriseSnapshot(db, Number(newApp.workspace_id), data.enterprise, context);

  await db.prepare("UPDATE core_snapshot SET snapshot_to_application_id=? WHERE id=?")
    .bind(newApp.id, snapshot.id)
    .run();

  return newApp;
}

function finishedJob(id: number, type: string, values: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id,
    type,
    state: "finished",
    status: "finished",
    progress_percentage: 100,
    created_on: now,
    updated_on: now,
    ...values,
  };
}

async function listApplicationSnapshots(c: any, applicationId: number) {
  const user = c.get("user")!;
  await requireApplicationAccess(c.env.DB, user.id, applicationId);

  const res = await c.env.DB.prepare(
    `SELECT s.*, u.username AS created_by_username, u.email AS created_by_email,
            u.first_name AS created_by_first_name, u.last_name AS created_by_last_name
     FROM core_snapshot s
     LEFT JOIN auth_user u ON u.id = s.created_by_id
     WHERE s.snapshot_from_application_id=?
     ORDER BY s.created_at DESC, s.id DESC`
  ).bind(applicationId).all();

  return c.json((res.results || []).map(serializeSnapshot));
}

// ── GET /api/snapshots/application/:applicationId/ ───────────────────────────
snapshots.get("/application/:applicationId/", authMiddleware, async (c) => {
  return listApplicationSnapshots(c, Number(c.req.param("applicationId")));
});

// ── GET /api/snapshots/:applicationId/ — Compatibility alias ─────────────────
snapshots.get("/:applicationId/", authMiddleware, async (c) => {
  return listApplicationSnapshots(c, Number(c.req.param("applicationId")));
});

async function createApplicationSnapshot(c: any, applicationId: number) {
  const user = c.get("user")!;
  const body = await c.req.json().catch(() => ({ name: undefined })) as { name?: string };
  await requireApplicationAccess(c.env.DB, user.id, applicationId, "BUILDER");

  const now = new Date().toISOString();
  const snapshotName = body.name?.trim();
  if (!snapshotName) {
    return c.json({
      error: "ERROR_REQUEST_BODY_VALIDATION",
      detail: { name: [{ error: "This field is required.", code: "required" }] },
    }, 400);
  }
  const duplicate = await c.env.DB.prepare(
    `SELECT id FROM core_snapshot
     WHERE snapshot_from_application_id=? AND created_by_id=? AND name=?`
  ).bind(applicationId, user.id, snapshotName).first();
  if (duplicate) {
    return c.json({
      error: "ERROR_SNAPSHOT_NAME_NOT_UNIQUE",
      detail: "Snapshots names must be unique per application.",
    }, 400);
  }
  const snapshot = await c.env.DB.prepare(
    `INSERT INTO core_snapshot (snapshot_from_application_id, snapshot_to_application_id, name, created_at, created_by_id)
     VALUES (?, NULL, ?, ?, ?) RETURNING *`
  ).bind(applicationId, snapshotName, now, user.id).first();
  if (!snapshot) throw new Error("Failed to create snapshot");

  try {
    const snapshotData = await buildApplicationSnapshot(c.env.DB, applicationId, { includeRows: false });
    await streamSnapshotArchiveToR2(c.env, c.env.DB, snapshotKey((snapshot as any).id), snapshotData);
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM core_snapshot WHERE id=?").bind((snapshot as any).id).run();
    throw error;
  }

  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on)
     VALUES ('create_snapshot', 'finished', 100, ?, ?, ?) RETURNING id`
  ).bind(user.id, now, now).first() as { id: number } | null;
  if (!job) throw new Error("Failed to create snapshot job");

  return c.json(finishedJob(job.id, "create_snapshot", {
    snapshot: serializeSnapshot(snapshot),
  }), 202);
}

// ── POST /api/snapshots/application/:applicationId/ ──────────────────────────
snapshots.post("/application/:applicationId/", authMiddleware, async (c) => {
  return createApplicationSnapshot(c, Number(c.req.param("applicationId")));
});

// ── POST /api/snapshots/:applicationId/ — Compatibility alias ────────────────
snapshots.post("/:applicationId/", authMiddleware, async (c) => {
  return createApplicationSnapshot(c, Number(c.req.param("applicationId")));
});

// ── DELETE /api/snapshots/:snapshotId/ ───────────────────────────────────────
snapshots.delete("/:snapshotId/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const snapshotId = parseInt(c.req.param("snapshotId"));

  const snapshot = await c.env.DB.prepare(
    `SELECT s.id, s.snapshot_from_application_id, a.workspace_id FROM core_snapshot s
     JOIN core_application a ON a.id = s.snapshot_from_application_id
     WHERE s.id=?`
  ).bind(snapshotId).first<any>();
  if (!snapshot) throw new DoesNotExist("Snapshot", snapshotId);
  await assertHasApplicationRole(c.env.DB, user.id, Number(snapshot.snapshot_from_application_id), "BUILDER");

  await c.env.FILES.delete(snapshotKey(snapshotId));
  await c.env.DB.prepare("DELETE FROM core_snapshot WHERE id=?").bind(snapshotId).run();
  return c.body(null, 204);
});

// ── POST /api/snapshots/:snapshotId/restore/ ─────────────────────────────────
snapshots.post("/:snapshotId/restore/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const snapshotId = parseInt(c.req.param("snapshotId"));

  const snapshot = await c.env.DB.prepare(
    `SELECT s.*, a.workspace_id FROM core_snapshot s
     JOIN core_application a ON a.id = s.snapshot_from_application_id
     WHERE s.id=?`
  ).bind(snapshotId).first<any>();
  if (!snapshot) throw new DoesNotExist("Snapshot", snapshotId);
  await assertHasApplicationRole(c.env.DB, user.id, Number(snapshot.snapshot_from_application_id), "BUILDER");
  await assertHasWorkspaceRole(c.env.DB, user.id, Number(snapshot.workspace_id), "BUILDER");

  const now = new Date().toISOString();
  const object = await c.env.FILES.get(snapshotKey(snapshotId));
  if (!object) throw new DoesNotExist("Snapshot file", snapshotId);
  const extracted = await extractSnapshotArchiveToR2(
    c.env,
    object,
    `snapshot-restore-extracted/${snapshotId}/${crypto.randomUUID()}/`
  );
  let restoredApplication: any;
  try {
    await restoreSnapshotUserFiles(c.env, extracted.data, {}, { loadBody: extracted.loadBody });
    restoredApplication = await restoreApplicationSnapshot(c.env.DB, snapshot, extracted.data, {
      loadTableRows: extracted.loadTableRows,
    });
  } finally {
    await extracted.cleanup();
  }
  await c.env.DB.prepare("UPDATE core_snapshot SET snapshot_to_application_id=? WHERE id=?")
    .bind(restoredApplication.id, snapshotId)
    .run();

  const job = await c.env.DB.prepare(
    `INSERT INTO core_job (type, status, progress_percentage, user_id, created_on, updated_on)
     VALUES ('restore_snapshot', 'finished', 100, ?, ?, ?) RETURNING id`
  ).bind(user.id, now, now).first() as { id: number } | null;
  if (!job) throw new Error("Failed to create restore job");

  return c.json(finishedJob(job.id, "restore_snapshot", {
    snapshot: serializeSnapshot(snapshot),
    application: {
      id: restoredApplication.id,
      name: restoredApplication.name,
      type: restoredApplication.type,
      order: restoredApplication.order,
      workspace: { id: restoredApplication.workspace_id },
      workspace_id: restoredApplication.workspace_id,
    },
  }), 200);
});

export { snapshots as snapshotsRouter };
