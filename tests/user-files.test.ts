import { describe, expect, it } from "vitest";
import {
  collectUserFileNamesFromRecord,
  cleanupExpiredUserFiles,
  deleteUnreferencedUserFiles,
  scheduleUnreferencedUserFilesForDeletion,
  serializeUserFile,
  serializeUserFileCell,
  serializeUserFileForRequest,
  storeUserFile,
  UserFileSizeTooLargeError,
} from "../src/services/user-files";

function fakeEnv() {
  const state = {
    objects: new Map<string, { body: ArrayBuffer; options: any }>(),
    rows: [] as any[],
    deletedKeys: [] as string[],
    failInsert: false,
  };
  const env = {
    PUBLIC_URL: "https://supertask.test",
    FILES: {
      put: async (key: string, body: ArrayBuffer, options: any) => {
        state.objects.set(key, { body, options });
      },
      delete: async (key: string) => {
        state.deletedKeys.push(key);
        state.objects.delete(key);
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first: async () => {
                if (sql.includes("SELECT * FROM core_userfile")) {
                  return state.rows.find((row) => row.original_name === args[0] && row.sha256_hash === args[1] && row.deleted_at === null) || null;
                }
                if (!sql.includes("INSERT INTO core_userfile")) return null;
                if (state.failInsert) throw new Error("D1 insert failed");
                const row = {
                  id: state.rows.length + 1,
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
                state.rows.push(row);
                return row;
              },
            };
          },
        };
      },
    },
  };
  return { env: env as any, state };
}

function bytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

describe("user files", () => {
  it("stores image metadata and returns the exact Baserow upload contract", async () => {
    const { env, state } = fakeEnv();
    const png1x1 = bytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=");

    const stored = await storeUserFile(env, {
      userId: 7,
      fileName: "Folder/My image file.png",
      contentType: "",
      body: png1x1,
    });
    const serialized = serializeUserFile(env, stored) as any;

    expect(state.objects.size).toBe(1);
    expect(stored.original_name).toBe("My image file.png");
    expect(stored.original_extension).toBe("png");
    expect(stored.sha256_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.name).toMatch(/^[a-f0-9]{32}_[a-f0-9]{64}\.png$/);
    expect(stored.mime_type).toBe("image/png");
    expect(stored.size).toBe(png1x1.byteLength);
    expect(stored.is_image).toBe(1);
    expect(stored.image_width).toBe(1);
    expect(stored.image_height).toBe(1);
    expect(serialized.original_name).toBe("My image file.png");
    expect(serialized.visible_name).toBeUndefined();
    expect(serialized.thumbnails.tiny.url).toContain("?thumbnail=tiny");
    expect(serialized.thumbnails.tiny).toMatchObject({ width: null, height: 21 });

    const cell = serializeUserFileCell(env, stored, "Renamed image.png") as any;
    expect(cell.visible_name).toBe("Renamed image.png");
    expect(cell.original_name).toBeUndefined();
    expect(cell.name).toBe(stored.name);
  });

  it("deduplicates uploads by original name and sha256 like Baserow", async () => {
    const { env, state } = fakeEnv();
    const body = new TextEncoder().encode("same bytes");

    const first = await storeUserFile(env, {
      userId: 7,
      fileName: "report.txt",
      contentType: "application/octet-stream",
      body,
    });
    const second = await storeUserFile(env, {
      userId: 8,
      fileName: "report.txt",
      contentType: "application/octet-stream",
      body,
    });

    expect(second).toEqual(first);
    expect(state.rows).toHaveLength(1);
    expect(state.objects.size).toBe(1);
    expect(first.mime_type).toBe("text/plain");
    expect(first.name).toMatch(/^[a-f0-9]{32}_[a-f0-9]{64}\.txt$/);
  });

  it("infers common document mime types when the upload omits content type", async () => {
    const { env } = fakeEnv();
    const stored = await storeUserFile(env, {
      userId: 7,
      fileName: "invoice.pdf",
      contentType: "",
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });

    expect(stored.mime_type).toBe("application/pdf");
    expect(stored.is_image).toBe(0);
    expect(stored.image_width).toBeNull();
    expect(stored.image_height).toBeNull();
  });

  it("preserves Baserow MIME precedence for CSV and unknown file extensions", async () => {
    const csvFixture = fakeEnv();
    const csv = await storeUserFile(csvFixture.env, {
      userId: 7,
      fileName: "records.csv",
      contentType: "application/octet-stream",
      body: "name,value\nalpha,1\n",
    });
    expect(csv.mime_type).toBe("text/csv");
    expect(csv.is_image).toBe(0);

    const unknownFixture = fakeEnv();
    const unknown = await storeUserFile(unknownFixture.env, {
      userId: 7,
      fileName: "payload.custom-extension",
      contentType: "application/x-supertask-fixture",
      body: new Uint8Array([0, 255, 17, 34]),
    });
    expect(unknown.mime_type).toBe("application/x-supertask-fixture");
    expect(unknown.is_image).toBe(0);
    expect(unknown.image_width).toBeNull();
    expect(unknown.image_height).toBeNull();
  });

  it("infers common office, archive, audio and video MIME types from extensions", async () => {
    const fixtures = [
      ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["bundle.zip", "application/zip"],
      ["recording.mp3", "audio/mpeg"],
      ["clip.mp4", "video/mp4"],
    ] as const;

    for (const [fileName, mimeType] of fixtures) {
      const { env } = fakeEnv();
      const stored = await storeUserFile(env, {
        userId: 7,
        fileName,
        contentType: "",
        body: new Uint8Array([1, 2, 3]),
      });
      expect(stored.mime_type).toBe(mimeType);
      expect(stored.is_image).toBe(0);
    }
  });

  it("uses Cloudflare Images metadata for raster formats outside the byte parser", async () => {
    const { env } = fakeEnv();
    env.IMAGES = {
      info: async (stream: ReadableStream<Uint8Array>) => {
        await new Response(stream).arrayBuffer();
        return { format: "image/avif", fileSize: 4, width: 320, height: 180 };
      },
    } as any;

    const stored = await storeUserFile(env, {
      userId: 7,
      fileName: "cover.avif",
      contentType: "image/avif",
      body: new Uint8Array([0, 1, 2, 3]),
    });

    expect(stored).toMatchObject({
      mime_type: "image/avif",
      is_image: 1,
      image_width: 320,
      image_height: 180,
    });
  });

  it("serializes signed backend URLs when secure file serve is enabled", async () => {
    const { env } = fakeEnv();
    env.JWT_SIGNING_KEY = "test-secret";
    env.SECRET_KEY = "test-secret";
    env.BASEROW_SERVE_FILES_THROUGH_BACKEND = "true";
    env.BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS = "0";
    const stored = await storeUserFile(env, {
      userId: 7,
      fileName: "contract.png",
      contentType: "image/png",
      body: bytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="),
    });

    const serialized = await serializeUserFileForRequest(env, stored, 1) as any;

    expect(serialized.url).toMatch(/^https:\/\/supertask\.test\/api\/files\//);
    expect(serialized.thumbnails.tiny.url).toContain("/api/files/");
    expect(serialized.thumbnails.tiny.url).toContain("thumbnail=tiny");
    expect(serialized.name).toBe(stored.name);
    expect(serialized.original_name).toBe("contract.png");
    expect(serialized.visible_name).toBeUndefined();
  });

  it("rejects declared and streamed bodies above the configured Baserow limit", async () => {
    const declared = fakeEnv();
    declared.env.BASEROW_FILE_UPLOAD_SIZE_LIMIT_MB = "0.000001";
    await expect(storeUserFile(declared.env, {
      userId: 7,
      fileName: "too-large.txt",
      size: 2,
      body: new Uint8Array([1]),
    })).rejects.toBeInstanceOf(UserFileSizeTooLargeError);
    expect(declared.state.objects.size).toBe(0);

    const streamed = fakeEnv();
    streamed.env.BASEROW_FILE_UPLOAD_SIZE_LIMIT_MB = "0.000001";
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    await expect(storeUserFile(streamed.env, {
      userId: 7,
      fileName: "too-large-stream.txt",
      body,
    })).rejects.toBeInstanceOf(UserFileSizeTooLargeError);
    expect(streamed.state.objects.size).toBe(0);
  });

  it("removes the R2 object when D1 metadata persistence fails", async () => {
    const { env, state } = fakeEnv();
    state.failInsert = true;

    await expect(storeUserFile(env, {
      userId: 7,
      fileName: "orphan.txt",
      body: new TextEncoder().encode("orphan"),
    })).rejects.toThrow("D1 insert failed");

    expect(state.objects.size).toBe(0);
    expect(state.deletedKeys).toHaveLength(1);
    expect(state.deletedKeys[0]).toMatch(/^user_files\//);
  });

  it("deletes R2 objects only when the user file is no longer referenced", async () => {
    const state = {
      deletedKeys: [] as string[],
      userFiles: [
        { id: 1, name: "delete-me.png", r2_key: "user_files/delete-me.png" },
        { id: 2, name: "keep-me.png", r2_key: "user_files/keep-me.png" },
      ],
      liveRows: [
        { field_20: JSON.stringify([{ name: "keep-me.png", visible_name: "keep-me.png" }]) },
      ],
      trashRows: [] as any[],
    };
    const env = {
      FILES: {
        delete: async (keys: string | string[]) => {
          state.deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
        },
      },
      DB: {
        prepare(sql: string) {
          const execute = async (args: unknown[], mode: "all" | "first") => {
            if (sql.includes("FROM database_field f")) {
              return { results: [{ id: 20, table_id: 10 }] };
            }
            if (sql.includes('FROM "database_table_10"')) {
              return { results: state.liveRows };
            }
            if (sql.includes("FROM core_trasheditem")) {
              return { results: state.trashRows };
            }
            if (sql.includes("SELECT * FROM core_userfile")) {
              if (mode === "all") {
                return { results: state.userFiles.filter((file) => args.includes(file.name)) };
              }
              return state.userFiles.find((file) => file.name === args[0]) || null;
            }
            if (sql.includes("DELETE FROM core_userfile")) {
              state.userFiles = state.userFiles.filter((file) => file.id !== args[0]);
              return { success: true };
            }
            return mode === "all" ? { results: [] } : null;
          };
          return {
            bind(...args: unknown[]) {
              return {
                all: () => execute(args, "all"),
                first: () => execute(args, "first"),
                run: () => execute(args, "first"),
              };
            },
            all: () => execute([], "all"),
          };
        },
        async batch(statements: Array<{ run: () => Promise<unknown> }>) {
          return Promise.all(statements.map((statement) => statement.run()));
        },
      },
    };

    const deleted = await deleteUnreferencedUserFiles(env as any, ["delete-me.png", "keep-me.png"]);

    expect(deleted).toBe(1);
    expect(state.deletedKeys).toEqual(["user_files/delete-me.png"]);
    expect(state.userFiles.map((file) => file.name)).toEqual(["keep-me.png"]);
  });

  it("schedules removed cell files and physically deletes them after the retention window", async () => {
    const state = {
      deletedKeys: [] as string[],
      userFiles: [
        { id: 1, name: "removed.pdf", r2_key: "user_files/removed.pdf", deleted_at: null as string | null },
      ],
    };
    const env = {
      FILES: {
        delete: async (keys: string | string[]) => {
          state.deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
        },
      },
      DB: {
        prepare(sql: string) {
          const execute = async (args: unknown[], mode: "all" | "first" | "run") => {
            if (sql.includes("FROM database_field f")) return { results: [] };
            if (sql.includes("FROM core_trasheditem")) return { results: [] };
            if (sql.includes("SET deleted_at=COALESCE")) {
              for (const file of state.userFiles) {
                if (args.slice(1).includes(file.name)) file.deleted_at ||= String(args[0]);
              }
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET deleted_at=NULL")) {
              for (const file of state.userFiles) if (args.includes(file.name)) file.deleted_at = null;
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SELECT name FROM core_userfile WHERE deleted_at")) {
              return { results: state.userFiles.filter((file) => file.deleted_at).map(({ name }) => ({ name })) };
            }
            if (sql.includes("SELECT * FROM core_userfile")) {
              return { results: state.userFiles.filter((file) => args.includes(file.name)) };
            }
            if (sql.includes("DELETE FROM core_userfile")) {
              state.userFiles = state.userFiles.filter((file) => file.id !== args[0]);
              return { meta: { changes: 1 } };
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
          };
        },
        async batch(statements: Array<{ run: () => Promise<unknown> }>) {
          return Promise.all(statements.map((statement) => statement.run()));
        },
      },
    };

    expect(await scheduleUnreferencedUserFilesForDeletion(env as any, ["removed.pdf"])).toBe(1);
    expect(state.userFiles[0].deleted_at).not.toBeNull();
    state.userFiles[0].deleted_at = "2000-01-01T00:00:00.000Z";

    expect(await cleanupExpiredUserFiles(env as any, 48)).toBe(1);
    expect(state.deletedKeys).toEqual(["user_files/removed.pdf"]);
    expect(state.userFiles).toEqual([]);
  });

  it("extracts user file names from row records without including external references", () => {
    const names = collectUserFileNamesFromRecord({
      field_1: JSON.stringify([
        { name: "stored.png", visible_name: "stored.png" },
        { name: "external.png", external: true },
      ]),
      other: JSON.stringify([{ name: "ignored.png" }]),
    });

    expect(Array.from(names)).toEqual(["stored.png"]);
  });
});
