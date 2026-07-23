import { describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_KNOWLEDGE_SOURCE_KEY,
  parseAssistantKnowledgeCsv,
  processAssistantKnowledgeBatch,
  searchAssistantKnowledge,
} from "../src/services/assistant-knowledge";
import { scheduleAssistantKnowledgeSync } from "../src/cron/handler";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

function sourceCsv() {
  return [
    "id,name,slug,title,markdown_body,category,type,source_url",
    "1,Quick start,quick-start,Quick start,\"# Start",
    "",
    "Create a table, then add a \"\"Status\"\" field.\",Database,baserow_user_docs,https://baserow.io/user-docs/quick-start",
    "2,Views,views,Views,\"Use grid, gallery, and form views.\",Database,baserow_user_docs,https://baserow.io/user-docs/views",
  ].join("\n");
}

function createKnowledgeEnv() {
  const stored = new Map<string, { text: string; etag: string }>([
    [ASSISTANT_KNOWLEDGE_SOURCE_KEY, { text: sourceCsv(), etag: "source-etag" }],
    ["assistant/knowledge/vector-ids.json", { text: JSON.stringify(["stale-vector"]), etag: "manifest-etag" }],
  ]);
  const upserts: any[][] = [];
  const deleted: string[][] = [];
  const cache = new Map<string, string>();
  const env = {
    FILES: {
      get: vi.fn(async (key: string) => {
        const value = stored.get(key);
        if (!value) return null;
        return { etag: value.etag, text: async () => value.text };
      }),
      put: vi.fn(async (key: string, value: string) => {
        stored.set(key, { text: String(value), etag: "written-etag" });
      }),
    },
    CACHE: {
      put: vi.fn(async (key: string, value: string) => {
        cache.set(key, value);
      }),
    },
    AI: {
      run: vi.fn(async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((_text, index) => Array.from({ length: 768 }, (_value, position) => position === index ? 1 : 0)),
      })),
    },
    KNOWLEDGE_BASE: {
      upsert: vi.fn(async (vectors: any[]) => {
        upserts.push(vectors);
        return { count: vectors.length };
      }),
      deleteByIds: vi.fn(async (ids: string[]) => {
        deleted.push(ids);
        return { count: ids.length };
      }),
      query: vi.fn(async () => ({
        matches: [
          {
            id: "one",
            score: 0.82,
            metadata: {
              title: "Quick start",
              content: "Create a table.",
              source_url: "https://baserow.io/user-docs/quick-start",
            },
          },
          {
            id: "two",
            score: 0.75,
            metadata: {
              title: "Quick start",
              content: "Add fields.",
              source_url: "https://baserow.io/user-docs/quick-start",
            },
          },
        ],
      })),
    },
  } as any;
  return { env, stored, upserts, deleted, cache };
}

describe("assistant knowledge base", () => {
  it("parses quoted multiline documentation CSV fields", () => {
    expect(parseAssistantKnowledgeCsv(sourceCsv())).toEqual([
      {
        title: "Quick start",
        slug: "quick-start",
        content: "# Start\n\nCreate a table, then add a \"Status\" field.",
        sourceUrl: "https://baserow.io/user-docs/quick-start",
        category: "Database",
        type: "baserow_user_docs",
      },
      {
        title: "Views",
        slug: "views",
        content: "Use grid, gallery, and form views.",
        sourceUrl: "https://baserow.io/user-docs/views",
        category: "Database",
        type: "baserow_user_docs",
      },
    ]);
  });

  it("indexes deterministic chunks and replaces stale Vectorize entries", async () => {
    const { env, stored, upserts, deleted, cache } = createKnowledgeEnv();
    const result = await processAssistantKnowledgeBatch(env, 0, "source-etag");

    expect(result.complete).toBe(true);
    expect(result.total).toBe(2);
    expect(result.indexed).toBe(2);
    expect(result.deleted).toBe(1);
    expect(deleted).toEqual([["stale-vector"]]);
    expect(upserts.flat()).toHaveLength(2);
    expect(upserts.flat().every((vector) => vector.id.length === 64 && vector.values.length === 768)).toBe(true);
    expect(upserts.flat()[0].metadata).toMatchObject({
      title: "Quick start",
      source_url: "https://baserow.io/user-docs/quick-start",
      chunk_index: 0,
    });
    const manifest = JSON.parse(stored.get("assistant/knowledge/vector-ids.json")!.text);
    expect(manifest).toEqual(upserts.flat().map((vector) => vector.id));
    expect(cache.get("assistant:knowledge:source-etag")).toBe("source-etag");
  });

  it("searches Vectorize and returns ranked chunks with unique sources", async () => {
    const { env } = createKnowledgeEnv();
    const result = await searchAssistantKnowledge(env, "How do I create a table?", 15);

    expect(result.reliability).toBe(0.9);
    expect(result.matches).toHaveLength(2);
    expect(result.sources).toEqual(["https://baserow.io/user-docs/quick-start"]);
    expect(env.AI.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
      text: ["How do I create a table?"],
    });
    expect(env.KNOWLEDGE_BASE.query).toHaveBeenCalledWith(expect.any(Array), {
      topK: 15,
      returnMetadata: "all",
    });
  });

  it("schedules only one active knowledge sync for an unchanged R2 source", async () => {
    const messages: any[] = [];
    let activeJobId: number | null = null;
    const env = {
      AI: {},
      KNOWLEDGE_BASE: {},
      FILES: { head: vi.fn(async () => ({ etag: "source-etag" })) },
      CACHE: { get: vi.fn(async () => null) },
      JOBS_QUEUE: { send: vi.fn(async (message: any) => messages.push(message)) },
      DB: {
        prepare(sql: string) {
          return {
            bind(..._values: unknown[]) {
              return {
                first: async () => {
                  if (sql.includes("SELECT id FROM core_job")) return activeJobId ? { id: activeJobId } : null;
                  if (sql.includes("INSERT INTO core_job")) {
                    activeJobId = 41;
                    return { id: activeJobId };
                  }
                  return null;
                },
                run: async () => ({}),
              };
            },
            first: async () => activeJobId ? { id: activeJobId } : null,
          };
        },
      },
    } as any;

    expect(await scheduleAssistantKnowledgeSync(env)).toBe(41);
    expect(await scheduleAssistantKnowledgeSync(env)).toBe(41);
    expect(messages).toEqual([{
      job_id: 41,
      job_type: "sync_assistant_knowledge",
      payload: { source_etag: "source-etag", offset: 0, deleted_vectors: 0 },
      user_id: 0,
      workspace_id: 0,
    }]);
  });
});
