import type { Env } from "../types/env";
import { ensureUserTableSystemColumns, serializeFieldValueForInsert } from "./dynamic-tables";
import { serializeUserFileCellForRequest, storeUserFile, type StoredUserFile } from "./user-files";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AirtableAttachmentRetryResult = {
  database_id: number;
  scanned_files: number;
  external_files: number;
  stored_files: number;
  failed_files: number;
  updated_rows: number;
};

const AIRTABLE_FILE_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:95.0) Gecko/20100101 Firefox/95.0",
  Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,application/pdf,*/*",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://airtable.com/",
  Origin: "https://airtable.com",
};

function parseFileCell(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isAirtableExternalFile(value: unknown): value is Record<string, any> {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as any).external === true &&
    (value as any).source === "airtable"
  );
}

export function airtableExternalFileUrls(file: Record<string, any>): string[] {
  const urls = [
    file.airtable_attachment?.original_url,
    file.url,
  ];
  return Array.from(new Set(urls.map((url) => String(url || "").trim()).filter(Boolean)));
}

async function downloadExternalFile(file: Record<string, any>, fetcher: Fetcher): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; size: number }> {
  const urls = airtableExternalFileUrls(file);
  let lastStatus = "missing-url";
  for (const url of urls) {
    const response = await fetcher(url, { headers: AIRTABLE_FILE_HEADERS });
    lastStatus = String(response.status);
    if (!response.ok) continue;
    if (!response.body) continue;
    return {
      body: response.body,
      contentType: response.headers.get("content-type") || file.mime_type || file.airtable_attachment?.mime_type || "application/octet-stream",
      size: Number(response.headers.get("content-length") || file.size || 0),
    };
  }
  throw new Error(`Airtable external file could not be fetched: ${lastStatus}`);
}

async function materializeExternalFile(
  env: Env,
  file: Record<string, any>,
  userId: number | null,
  fetcher: Fetcher,
  workspaceId: number | null
): Promise<object> {
  const downloaded = await downloadExternalFile(file, fetcher);
  const visibleName = String(file.visible_name || file.original_name || file.name || file.airtable_attachment?.filename || "airtable-file");
  const stored = await storeUserFile(env, {
    userId,
    fileName: visibleName,
    contentType: downloaded.contentType,
    size: downloaded.size,
    body: downloaded.body,
  });
  const imageWidth = Number(file.image_width || file.airtable_attachment?.width || stored.image_width || 0) || null;
  const imageHeight = Number(file.image_height || file.airtable_attachment?.height || stored.image_height || 0) || null;
  const isImage = Boolean(stored.is_image) || (downloaded.contentType.startsWith("image/") && imageWidth !== null && imageHeight !== null);
  await env.DB.prepare("UPDATE core_userfile SET is_image=?, image_width=?, image_height=? WHERE id=?")
    .bind(isImage ? 1 : 0, imageWidth, imageHeight, stored.id)
    .run();
  (stored as StoredUserFile).is_image = isImage ? 1 : 0;
  (stored as StoredUserFile).image_width = imageWidth;
  (stored as StoredUserFile).image_height = imageHeight;
  return serializeUserFileCellForRequest(env, stored, workspaceId, visibleName);
}

export async function retryAirtableExternalAttachments(
  env: Env,
  payload: { database_id?: unknown },
  userId: number | null,
  fetcher: Fetcher = fetch
): Promise<AirtableAttachmentRetryResult> {
  const databaseId = Number(payload.database_id || 0);
  if (!databaseId) throw new Error("database_id is required for Airtable attachment retry.");

  const result: AirtableAttachmentRetryResult = {
    database_id: databaseId,
    scanned_files: 0,
    external_files: 0,
    stored_files: 0,
    failed_files: 0,
    updated_rows: 0,
  };

  const application = await env.DB.prepare(
    "SELECT workspace_id FROM core_application WHERE id=? AND trashed=0"
  ).bind(databaseId).first<{ workspace_id: number }>();
  const workspaceId = application?.workspace_id ?? null;

  const tables = await env.DB.prepare(
    "SELECT id FROM database_table WHERE database_id=? AND trashed=0 ORDER BY [order] ASC, id ASC"
  ).bind(databaseId).all<{ id: number }>();

  for (const table of tables.results || []) {
    const fields = await env.DB.prepare(
      "SELECT id FROM database_field WHERE table_id=? AND type='file' AND trashed=0 ORDER BY [order] ASC, id ASC"
    ).bind(table.id).all<{ id: number }>();
    if (!fields.results?.length) continue;

    const fieldColumns = fields.results.map((field) => `"field_${field.id}" AS "field_${field.id}"`).join(", ");
    await ensureUserTableSystemColumns(env.DB, table.id);
    const rows = await env.DB.prepare(
      `SELECT id, ${fieldColumns} FROM "database_table_${table.id}" WHERE COALESCE(trashed, 0)=0 ORDER BY [order] ASC, id ASC`
    ).all<Record<string, unknown>>();

    for (const row of rows.results || []) {
      const sets: string[] = [];
      const bindValues: unknown[] = [];
      for (const field of fields.results) {
        const column = `field_${field.id}`;
        const files = parseFileCell(row[column]);
        if (files.length === 0) continue;
        result.scanned_files += files.length;
        let changed = false;
        const nextFiles = [];
        for (const file of files) {
          if (!isAirtableExternalFile(file)) {
            nextFiles.push(file);
            continue;
          }
          result.external_files += 1;
          try {
            nextFiles.push(await materializeExternalFile(env, file, userId, fetcher, workspaceId));
            result.stored_files += 1;
            changed = true;
          } catch {
            result.failed_files += 1;
            nextFiles.push(file);
          }
        }
        if (changed) {
          sets.push(`"${column}"=?`);
          bindValues.push(serializeFieldValueForInsert("file", nextFiles));
        }
      }
      if (sets.length > 0) {
        bindValues.push(row.id);
        await env.DB.prepare(`UPDATE "database_table_${table.id}" SET ${sets.join(", ")} WHERE id=? AND COALESCE(trashed, 0)=0`)
          .bind(...bindValues)
          .run();
        result.updated_rows += 1;
      }
    }
  }

  return result;
}
