import type { Env } from "../types/env";

type KnowledgeDocument = {
  title: string;
  slug: string;
  content: string;
  sourceUrl: string;
  category: string;
  type: string;
};

type KnowledgeChunk = KnowledgeDocument & {
  id: string;
  index: number;
  content: string;
};

const KNOWLEDGE_MODEL = "@cf/baai/bge-base-en-v1.5";
export const ASSISTANT_KNOWLEDGE_SOURCE_KEY = "assistant/knowledge/website_export.csv";
const ASSISTANT_KNOWLEDGE_MANIFEST_KEY = "assistant/knowledge/vector-ids.json";
const INDEX_BATCH_SIZE = 80;
const EMBEDDING_BATCH_SIZE = 20;

function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

export function parseAssistantKnowledgeCsv(csv: string): KnowledgeDocument[] {
  const rows = csvRows(csv);
  const headers = rows.shift()?.map((header) => header.trim()) || [];
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  for (const required of ["slug", "title", "markdown_body", "source_url"]) {
    if (index[required] === undefined) throw new Error(`Assistant knowledge CSV is missing ${required}.`);
  }
  const documents: KnowledgeDocument[] = [];
  for (const row of rows) {
    const content = String(row[index.markdown_body] || "").trim();
    const slug = String(row[index.slug] || "").trim();
    const title = String(row[index.title] || row[index.name] || "").trim();
    if (!slug || !title || !content) continue;
    documents.push({
      title,
      slug,
      content,
      sourceUrl: String(row[index.source_url] || "").trim(),
      category: String(row[index.category] || "").trim(),
      type: String(row[index.type] || "").trim(),
    });
  }
  return documents;
}

function splitKnowledgeContent(content: string, maxLength = 1400): string[] {
  const paragraphs = content.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLength) {
      pushCurrent();
      for (let offset = 0; offset < paragraph.length; offset += maxLength) {
        chunks.push(paragraph.slice(offset, offset + maxLength).trim());
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxLength) pushCurrent();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  pushCurrent();
  return chunks;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function knowledgeChunks(documents: KnowledgeDocument[]): Promise<KnowledgeChunk[]> {
  const chunks: KnowledgeChunk[] = [];
  for (const document of documents) {
    const contentChunks = splitKnowledgeContent(document.content);
    for (let index = 0; index < contentChunks.length; index += 1) {
      chunks.push({
        ...document,
        id: await sha256(`${document.type}:${document.slug}:${index}:${contentChunks[index]}`),
        index,
        content: contentChunks[index],
      });
    }
  }
  return chunks;
}

async function embeddings(env: Env, texts: string[]): Promise<number[][]> {
  if (!env.AI) throw new Error("Workers AI is not configured for assistant knowledge.");
  const response = await env.AI.run(KNOWLEDGE_MODEL, { text: texts }) as any;
  const values = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
  if (values.length !== texts.length || values.some((vector: unknown) => !Array.isArray(vector) || vector.length !== 768)) {
    throw new Error("Workers AI returned an invalid assistant knowledge embedding batch.");
  }
  return values as number[][];
}

async function readManifest(env: Env): Promise<string[]> {
  const object = await env.FILES.get(ASSISTANT_KNOWLEDGE_MANIFEST_KEY);
  if (!object) return [];
  try {
    const value = JSON.parse(await object.text());
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function deleteStaleVectors(env: Env, currentIds: string[]) {
  if (!env.KNOWLEDGE_BASE) throw new Error("Vectorize is not configured for assistant knowledge.");
  const current = new Set(currentIds);
  const stale = (await readManifest(env)).filter((id) => !current.has(id));
  for (let offset = 0; offset < stale.length; offset += 1000) {
    await env.KNOWLEDGE_BASE.deleteByIds(stale.slice(offset, offset + 1000));
  }
  return stale.length;
}

export async function processAssistantKnowledgeBatch(
  env: Env,
  offset: number,
  sourceEtag: string,
): Promise<{ complete: boolean; nextOffset: number; total: number; indexed: number; deleted: number }> {
  if (!env.KNOWLEDGE_BASE) throw new Error("Vectorize is not configured for assistant knowledge.");
  const source = await env.FILES.get(ASSISTANT_KNOWLEDGE_SOURCE_KEY);
  if (!source) throw new Error("The assistant knowledge CSV is missing from R2.");
  if (sourceEtag && source.etag !== sourceEtag) throw new Error("The assistant knowledge CSV changed during indexing.");
  const chunks = await knowledgeChunks(parseAssistantKnowledgeCsv(await source.text()));
  const ids = chunks.map((chunk) => chunk.id);
  const deleted = offset === 0 ? await deleteStaleVectors(env, ids) : 0;
  const selected = chunks.slice(offset, offset + INDEX_BATCH_SIZE);
  for (let batchOffset = 0; batchOffset < selected.length; batchOffset += EMBEDDING_BATCH_SIZE) {
    const batch = selected.slice(batchOffset, batchOffset + EMBEDDING_BATCH_SIZE);
    const vectors = await embeddings(env, batch.map((chunk) => `${chunk.title}\n\n${chunk.content}`));
    await env.KNOWLEDGE_BASE.upsert(batch.map((chunk, index) => ({
      id: chunk.id,
      values: vectors[index],
      metadata: {
        title: chunk.title,
        slug: chunk.slug,
        source_url: chunk.sourceUrl,
        category: chunk.category,
        document_type: chunk.type,
        chunk_index: chunk.index,
        content: chunk.content,
      },
    })));
  }
  const nextOffset = offset + selected.length;
  const complete = nextOffset >= chunks.length;
  if (complete) {
    await env.FILES.put(ASSISTANT_KNOWLEDGE_MANIFEST_KEY, JSON.stringify(ids), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.CACHE.put("assistant:knowledge:source-etag", source.etag);
  }
  return { complete, nextOffset, total: chunks.length, indexed: selected.length, deleted };
}

export async function searchAssistantKnowledge(env: Env, question: string, limit = 10) {
  if (!env.AI || !env.KNOWLEDGE_BASE) throw new Error("Assistant knowledge search is not configured.");
  const [queryVector] = await embeddings(env, [question]);
  const result = await env.KNOWLEDGE_BASE.query(queryVector, {
    topK: Math.min(20, Math.max(1, limit)),
    returnMetadata: "all",
  });
  const matches = (result.matches || []).map((match) => {
    const metadata = (match.metadata || {}) as Record<string, unknown>;
    return {
      title: String(metadata.title || ""),
      content: String(metadata.content || ""),
      source_url: String(metadata.source_url || ""),
      score: Number(match.score || 0),
    };
  }).filter((match) => match.content);
  const sources = [...new Set(matches.map((match) => match.source_url).filter(Boolean))].slice(0, 3);
  const bestScore = matches[0]?.score || 0;
  return {
    question,
    matches,
    sources,
    reliability: bestScore >= 0.75 ? 0.9 : bestScore >= 0.55 ? 0.6 : 0.2,
  };
}
