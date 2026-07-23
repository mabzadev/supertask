import { describe, expect, it } from "vitest";
import {
  airtableExternalFileUrls,
  retryAirtableExternalAttachments,
} from "../src/services/airtable-attachment-retry";

function fakeEnv() {
  const state = {
    userFiles: [] as any[],
    rows: [
      {
        id: 30,
        order: 10000,
        field_20: JSON.stringify([
          {
            url: "https://dl.airtable.com/.attachments/hash/part/file-sample.pdf?token=secret",
            visible_name: "file-sample.pdf",
            original_name: "file-sample.pdf",
            name: "file-sample.pdf",
            size: 42,
            mime_type: "application/pdf",
            is_image: false,
            image_width: null,
            image_height: null,
            uploaded_at: "2026-01-01T00:00:00.000Z",
            external: true,
            source: "airtable",
            airtable_attachment: {
              id: "att1",
              row_id: "rec1",
              column_id: "fldFile",
              original_url: "https://dl.airtable.com/.attachments/hash/part/file-sample.pdf?token=secret",
              filename: "file-sample.pdf",
              mime_type: "application/pdf",
              size: 42,
            },
          },
        ]),
      },
    ],
  };

  const db = {
    prepare(sql: string) {
      const execute = async (args: unknown[], mode: "all" | "first" | "run") => {
        if (sql.includes("FROM core_application WHERE id")) {
          return { workspace_id: 1 };
        }
        if (sql.includes("FROM database_table WHERE database_id")) {
          return { results: [{ id: 10 }] };
        }
        if (sql.includes("FROM database_field WHERE table_id")) {
          return { results: [{ id: 20 }] };
        }
        if (sql.includes('FROM "database_table_10"') && mode === "all") {
          return { results: state.rows };
        }
        if (sql.includes("INSERT INTO core_userfile")) {
          const row = {
            id: state.userFiles.length + 1,
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
          state.userFiles.push(row);
          return row;
        }
        if (sql.includes("UPDATE core_userfile")) {
          const file = state.userFiles.find((item) => item.id === args[3]);
          if (file) {
            file.is_image = args[0];
            file.image_width = args[1];
            file.image_height = args[2];
          }
          return { success: true };
        }
        if (sql.includes('UPDATE "database_table_10"')) {
          const row = state.rows.find((item) => item.id === args[1]);
          if (row) row.field_20 = String(args[0]);
          return { success: true };
        }
        return mode === "all" ? { results: [] } : null;
      };
      return {
        bind(...args: unknown[]) {
          return {
            all: () => execute(args, "all"),
            first: () => execute(args, "first"),
            run: () => execute(args, "run"),
          };
        },
        all: () => execute([], "all"),
        first: () => execute([], "first"),
        run: () => execute([], "run"),
      };
    },
  };

  const env = {
    DB: db,
    FILES: {
      put: async () => ({}),
    },
    PUBLIC_URL: "https://opentabl.test",
  };
  return { env: env as any, state };
}

describe("Airtable attachment retry", () => {
  it("deduplicates external Airtable URLs in retry priority order", () => {
    expect(airtableExternalFileUrls({
      url: "https://example.com/a",
      airtable_attachment: { original_url: "https://example.com/a" },
      thumbnails: { large: { url: "https://example.com/b" } },
    })).toEqual(["https://example.com/a"]);
  });

  it("stores retryable external Airtable files in R2 and updates the cell value", async () => {
    const { env, state } = fakeEnv();
    const fetcher = async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": "3" },
    });

    const result = await retryAirtableExternalAttachments(env, { database_id: 1 }, 9, fetcher);
    const files = JSON.parse(state.rows[0].field_20);

    expect(result).toMatchObject({
      database_id: 1,
      scanned_files: 1,
      external_files: 1,
      stored_files: 1,
      failed_files: 0,
      updated_rows: 1,
    });
    expect(files[0]).toMatchObject({
      url: expect.stringContaining("https://opentabl.test/media/user_files/"),
      visible_name: "file-sample.pdf",
      mime_type: "application/pdf",
    });
    expect(files[0].original_name).toBeUndefined();
    expect(files[0].external).toBeUndefined();
  });

  it("stores retryable external Airtable files with secure backend URLs when enabled", async () => {
    const { env, state } = fakeEnv();
    env.JWT_SIGNING_KEY = "test-secret";
    env.SECRET_KEY = "test-secret";
    env.BASEROW_SERVE_FILES_THROUGH_BACKEND = "true";
    env.BASEROW_SERVE_FILES_THROUGH_BACKEND_PERMISSION = "DISABLED";
    env.BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS = "0";
    const fetcher = async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": "3" },
    });

    await retryAirtableExternalAttachments(env, { database_id: 1 }, 9, fetcher);
    const files = JSON.parse(state.rows[0].field_20);

    expect(files[0]).toMatchObject({
      url: expect.stringContaining("https://opentabl.test/api/files/"),
      visible_name: "file-sample.pdf",
      mime_type: "application/pdf",
    });
    expect(files[0].original_name).toBeUndefined();
    expect(files[0].url).not.toContain("/media/");
    expect(files[0].external).toBeUndefined();
  });

  it("does not replace the original Airtable attachment with a thumbnail", async () => {
    const { env, state } = fakeEnv();
    const originalFiles = JSON.parse(state.rows[0].field_20);
    originalFiles[0].thumbnails = {
      large: { url: "https://dl.airtable.com/.attachments/hash/part/thumb-large.png" },
      small: { url: "https://dl.airtable.com/.attachments/hash/part/thumb-small.png" },
    };
    state.rows[0].field_20 = JSON.stringify(originalFiles);
    const requestedUrls: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response("denied", { status: 403 });
    };

    const result = await retryAirtableExternalAttachments(env, { database_id: 1 }, 9, fetcher);
    const files = JSON.parse(state.rows[0].field_20);

    expect(requestedUrls).toEqual(["https://dl.airtable.com/.attachments/hash/part/file-sample.pdf?token=secret"]);
    expect(result).toMatchObject({
      external_files: 1,
      stored_files: 0,
      failed_files: 1,
      updated_rows: 0,
    });
    expect(files[0]).toMatchObject({
      external: true,
      source: "airtable",
      visible_name: "file-sample.pdf",
    });
  });
});
