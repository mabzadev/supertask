import { Hono } from "hono";
import type { Env, RequestVariables, RequestUser } from "../types/env";
import { authMiddleware } from "../middleware/auth";
import { ValidationError } from "../middleware/error";
import { assertHasWorkspaceRole } from "../services/enterprise-permissions";
import { promptGenerativeAI, promptGenerativeAIWithTools, workspaceGenerativeAISettings } from "../services/generative-ai";
import { logAuditEntry } from "../services/audit-log";
import { createAssistantTools, type AssistantToolContext } from "../services/assistant-tools";

const assistant = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

type AssistantChatRow = {
  id: number;
  uuid: string;
  user_id: number;
  workspace_id: number;
  title: string;
  status: string;
  created_on: string;
  updated_on: string;
};

type AssistantMessageRow = {
  id: number;
  chat_id: number;
  role: string;
  content: string;
  artifacts: string;
  created_on: string;
  updated_on: string;
  human_sentiment?: number | null;
  prediction_id?: number | null;
};

type ProviderChoice = {
  provider: string;
  model: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nowIso() {
  return new Date().toISOString();
}

function assistantExecutionContext(c: any): AssistantToolContext["executionCtx"] {
  try {
    return c.executionCtx;
  } catch {
    return {
      waitUntil(promise: Promise<unknown>) {
        void promise.catch(() => undefined);
      },
      passThroughOnException() {},
      props: {},
    };
  }
}

function parseJson(value: unknown, fallback: any) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function validateChatUuid(chatUuid: string) {
  if (!UUID_PATTERN.test(chatUuid)) {
    throw new ValidationError("The provided chat UUID is not valid.");
  }
}

function pagination(url: URL) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  return { limit, offset };
}

function serializeChat(chat: AssistantChatRow) {
  return {
    uuid: chat.uuid,
    user_id: Number(chat.user_id),
    workspace_id: Number(chat.workspace_id),
    title: chat.title,
    status: chat.status || "idle",
    created_on: chat.created_on,
    updated_on: chat.updated_on,
  };
}

function sentimentLabel(value: number | null | undefined) {
  if (value === 1) return "LIKE";
  if (value === -1) return "DISLIKE";
  return null;
}

function serializeMessage(message: AssistantMessageRow) {
  if (message.role === "human") {
    return {
      id: Number(message.id),
      type: "human",
      content: message.content,
      timestamp: message.created_on,
    };
  }

  const artifacts = parseJson(message.artifacts, {});
  const sources = Array.isArray(artifacts.sources) ? artifacts.sources.map((source: unknown) => String(source)) : [];
  return {
    id: Number(message.id),
    type: "ai/message",
    content: message.content,
    timestamp: message.created_on,
    sources,
    can_submit_feedback: Boolean(message.prediction_id),
    human_sentiment: sentimentLabel(message.human_sentiment),
  };
}

function eventLine(event: Record<string, unknown>) {
  return `${JSON.stringify(event)}\n\n`;
}

function textEventStream(events: Array<Record<string, unknown>>) {
  return new Response(events.map(eventLine).join(""), {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}

function firstEnabledProvider(settings: Record<string, unknown>): ProviderChoice | null {
  for (const [provider, rawConfig] of Object.entries(settings)) {
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) continue;
    const config = rawConfig as Record<string, unknown>;
    const model = Array.isArray(config.models)
      ? config.models.map((item) => String(item || "").trim()).find(Boolean)
      : "";
    if (!model) continue;
    return { provider, model };
  }
  return null;
}

function assistantPrompt(content: string, uiContext: Record<string, unknown>) {
  return [
    "You are the Supertask assistant for this workspace.",
    "Use the available tools whenever the request concerns workspace data or asks you to create, update, delete, inspect or open something.",
    "Inspect existing builders, tables, schemas and views before creating objects that could duplicate existing ones.",
    "Use field names for row values and preserve the exact Baserow field types requested by the user.",
    "After a mutation, explain exactly what was changed. Never claim a mutation succeeded unless its tool result confirms it.",
    "Answer directly when no tool is needed, using the UI context when it is relevant.",
    "",
    `UI context: ${JSON.stringify(uiContext)}`,
    "",
    `User message: ${content}`,
  ].join("\n");
}

async function workspaceName(db: D1Database, workspaceId: number) {
  const row = await db.prepare("SELECT name FROM core_workspace WHERE id=?").bind(workspaceId).first<{ name: string }>();
  return row?.name || "";
}

async function getOwnedChat(db: D1Database, userId: number, chatUuid: string) {
  validateChatUuid(chatUuid);
  return db.prepare(
    "SELECT * FROM enterprise_assistantchat WHERE uuid=? AND user_id=?"
  ).bind(chatUuid, userId).first<AssistantChatRow>();
}

async function getOrCreateChat(db: D1Database, user: RequestUser, workspaceId: number, chatUuid: string, titleSeed: string) {
  validateChatUuid(chatUuid);
  const existing = await getOwnedChat(db, user.id, chatUuid);
  if (existing) {
    if (Number(existing.workspace_id) !== workspaceId) {
      return null;
    }
    return existing;
  }
  const now = nowIso();
  const title = titleSeed.trim().slice(0, 250);
  return db.prepare(
    `INSERT INTO enterprise_assistantchat
       (uuid, user_id, workspace_id, title, status, created_on, updated_on)
     VALUES (?, ?, ?, ?, 'idle', ?, ?)
     RETURNING *`
  ).bind(chatUuid, user.id, workspaceId, title, now, now).first<AssistantChatRow>();
}

async function insertMessage(
  db: D1Database,
  chatId: number,
  role: "human" | "ai",
  content: string,
  artifacts: Record<string, unknown> = {},
) {
  const now = nowIso();
  return db.prepare(
    `INSERT INTO enterprise_assistantchatmessage
       (chat_id, role, content, artifacts, created_on, updated_on)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`
  ).bind(chatId, role, content, JSON.stringify(artifacts), now, now).first<AssistantMessageRow>();
}

async function createPrediction(db: D1Database, humanMessageId: number, aiMessageId: number, prediction: Record<string, unknown>) {
  const now = nowIso();
  await db.prepare(
    `INSERT INTO enterprise_assistantchatprediction
       (human_message_id, ai_response_id, prediction, human_feedback, created_on, updated_on)
     VALUES (?, ?, ?, '', ?, ?)`
  ).bind(humanMessageId, aiMessageId, JSON.stringify(prediction), now, now).run();
}

async function markChatStatus(db: D1Database, chatId: number, status: "idle" | "in_progress" | "canceling") {
  await db.prepare("UPDATE enterprise_assistantchat SET status=?, updated_on=? WHERE id=?")
    .bind(status, nowIso(), chatId)
    .run();
}

async function cancellationKey(cache: KVNamespace, chatUuid: string) {
  return cache.get(`assistant:cancel:${chatUuid}`);
}

async function clearCancellation(cache: KVNamespace, chatUuid: string) {
  await cache.delete(`assistant:cancel:${chatUuid}`);
}

assistant.get("/chat/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const url = new URL(c.req.url);
  const workspaceId = Number(url.searchParams.get("workspace_id") || 0);
  if (!workspaceId) throw new ValidationError("workspace_id is required.");
  await assertHasWorkspaceRole(c.env.DB, user.id, workspaceId, "VIEWER");
  const { limit, offset } = pagination(url);

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM enterprise_assistantchat c
      WHERE c.user_id=? AND c.workspace_id=? AND c.title <> ''
        AND EXISTS (SELECT 1 FROM enterprise_assistantchatmessage m WHERE m.chat_id=c.id)`
  ).bind(user.id, workspaceId).first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT *
       FROM enterprise_assistantchat c
      WHERE c.user_id=? AND c.workspace_id=? AND c.title <> ''
        AND EXISTS (SELECT 1 FROM enterprise_assistantchatmessage m WHERE m.chat_id=c.id)
      ORDER BY c.updated_on DESC, c.id DESC
      LIMIT ? OFFSET ?`
  ).bind(user.id, workspaceId, limit, offset).all<AssistantChatRow>();

  const total = count?.count || 0;
  return c.json({
    count: total,
    next: offset + limit < total ? `?workspace_id=${workspaceId}&limit=${limit}&offset=${offset + limit}` : null,
    previous: offset > 0 ? `?workspace_id=${workspaceId}&limit=${limit}&offset=${Math.max(0, offset - limit)}` : null,
    results: (rows.results || []).map(serializeChat),
  });
});

assistant.get("/chat/:chatUuid/messages/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const chatUuid = c.req.param("chatUuid");
  const chat = await getOwnedChat(c.env.DB, user.id, chatUuid);
  if (!chat) {
    return c.json({
      error: "ERROR_ASSISTANT_CHAT_DOES_NOT_EXIST",
      detail: "The specified AI assistant chat does not exist.",
    }, 404);
  }
  await assertHasWorkspaceRole(c.env.DB, user.id, Number(chat.workspace_id), "VIEWER");
  const rows = await c.env.DB.prepare(
    `SELECT m.*, p.id AS prediction_id, p.human_sentiment
       FROM enterprise_assistantchatmessage m
       LEFT JOIN enterprise_assistantchatprediction p ON p.ai_response_id=m.id
      WHERE m.chat_id=?
      ORDER BY m.created_on ASC, m.id ASC`
  ).bind(chat.id).all<AssistantMessageRow>();
  return c.json({ messages: (rows.results || []).map(serializeMessage) });
});

assistant.post("/chat/:chatUuid/messages/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const chatUuid = c.req.param("chatUuid");
  validateChatUuid(chatUuid);
  const body = await c.req.json<{ content?: unknown; ui_context?: unknown }>().catch(() => ({} as { content?: unknown; ui_context?: unknown }));
  const content = String(body.content || "").trim();
  const uiContext = body.ui_context && typeof body.ui_context === "object" && !Array.isArray(body.ui_context)
    ? body.ui_context as Record<string, unknown>
    : {};
  const workspace = uiContext.workspace && typeof uiContext.workspace === "object" && !Array.isArray(uiContext.workspace)
    ? uiContext.workspace as Record<string, unknown>
    : {};
  const workspaceId = Number(workspace.id || 0);
  if (!content) throw new ValidationError("content is required.");
  if (!workspaceId) throw new ValidationError("ui_context.workspace.id is required.");
  await assertHasWorkspaceRole(c.env.DB, user.id, workspaceId, "VIEWER");
  await clearCancellation(c.env.CACHE, chatUuid);

  const chat = await getOrCreateChat(c.env.DB, user, workspaceId, chatUuid, content);
  if (!chat) {
    return c.json({
      error: "ERROR_ASSISTANT_CHAT_DOES_NOT_EXIST",
      detail: "The specified AI assistant chat does not exist.",
    }, 404);
  }

  const humanMessage = await insertMessage(c.env.DB, chat.id, "human", content);
  await markChatStatus(c.env.DB, chat.id, "in_progress");

  const events: Array<Record<string, unknown>> = [
    { type: "ai/started", message_id: String(humanMessage?.id || crypto.randomUUID()) },
    { type: "ai/thinking", content: "Thinking..." },
  ];

  try {
    const settings = await workspaceGenerativeAISettings(c.env.CACHE, workspaceId);
    const provider = firstEnabledProvider(settings);
    if (!provider) {
      throw new ValidationError("The AI assistant provider is not configured for this workspace.");
    }
    const tools = createAssistantTools({
      env: c.env,
      executionCtx: assistantExecutionContext(c),
      authorization: c.req.header("Authorization") || "",
      user,
      workspaceId,
      uiContext,
      navigate: async (location) => {
        events.push({ type: "ai/navigation", location });
      },
      generateText: (prompt) => promptGenerativeAI(
        settings,
        provider.provider,
        provider.model,
        prompt,
        0.1,
      ),
    });
    const toolResult = await promptGenerativeAIWithTools(
      settings,
      provider.provider,
      provider.model,
      assistantPrompt(content, uiContext),
      tools,
      0.2,
      async (call) => {
        if (await cancellationKey(c.env.CACHE, chatUuid)) {
          throw new ValidationError("The assistant request was cancelled.");
        }
        events.push({ type: "ai/thinking", content: `Completed ${call.name}.` });
      },
    );
    const answer = toolResult.content;
    const sources = [...new Set(toolResult.calls.flatMap((call) => {
      const result = call.result && typeof call.result === "object" && !Array.isArray(call.result)
        ? call.result as Record<string, unknown>
        : {};
      return Array.isArray(result.sources) ? result.sources.map(String).filter(Boolean) : [];
    }))].slice(0, 3);
    if (await cancellationKey(c.env.CACHE, chatUuid)) {
      events.push({ type: "ai/cancelled", message_id: String(humanMessage?.id || "") });
    } else {
      const aiMessage = await insertMessage(c.env.DB, chat.id, "ai", answer || "", {
        sources,
        tool_calls: toolResult.calls,
      });
      if (humanMessage && aiMessage) {
        await createPrediction(c.env.DB, humanMessage.id, aiMessage.id, {
          provider: provider.provider,
          model: provider.model,
          tool_calls: toolResult.calls,
        });
      }
      events.push({
        id: aiMessage?.id,
        type: "ai/message",
        content: answer || "",
        sources,
        can_submit_feedback: true,
        human_sentiment: null,
      });
      if (!chat.title) {
        events.push({ type: "chat/title", content: content.slice(0, 250) });
      }
    }
  } catch (error: any) {
    events.push({
      type: "ai/error",
      code: "unknown",
      content: error?.message || "The assistant could not produce a response.",
    });
  } finally {
    await markChatStatus(c.env.DB, chat.id, "idle");
    await clearCancellation(c.env.CACHE, chatUuid);
    await logAuditEntry(c.env.DB, "assistant.chat.message.create", {
      user,
      workspace_id: workspaceId,
      workspace_name: await workspaceName(c.env.DB, workspaceId),
    }, { id: chat.id, type: "assistant_chat" }, {
      chat_uuid: chatUuid,
      message_id: humanMessage?.id,
    });
  }

  return textEventStream(events);
});

assistant.delete("/chat/:chatUuid/cancel/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const chatUuid = c.req.param("chatUuid");
  const chat = await getOwnedChat(c.env.DB, user.id, chatUuid);
  if (!chat) {
    return c.json({
      error: "ERROR_ASSISTANT_CHAT_DOES_NOT_EXIST",
      detail: "The specified AI assistant chat does not exist.",
    }, 404);
  }
  await assertHasWorkspaceRole(c.env.DB, user.id, Number(chat.workspace_id), "VIEWER");
  await c.env.CACHE.put(`assistant:cancel:${chatUuid}`, "1", { expirationTtl: 300 });
  await markChatStatus(c.env.DB, chat.id, "canceling");
  return c.body(null, 204);
});

assistant.put("/messages/:messageId/feedback/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const messageId = Number(c.req.param("messageId"));
  const body = await c.req.json<{ sentiment?: unknown; feedback?: unknown }>().catch(() => ({} as { sentiment?: unknown; feedback?: unknown }));
  const sentiment = body.sentiment === null || body.sentiment === undefined ? null : String(body.sentiment);
  if (sentiment !== null && sentiment !== "LIKE" && sentiment !== "DISLIKE") {
    throw new ValidationError("sentiment must be LIKE, DISLIKE or null.");
  }
  const message = await c.env.DB.prepare(
    `SELECT m.*, c.workspace_id, c.user_id, p.id AS prediction_id
       FROM enterprise_assistantchatmessage m
       JOIN enterprise_assistantchat c ON c.id=m.chat_id
       LEFT JOIN enterprise_assistantchatprediction p ON p.ai_response_id=m.id
      WHERE m.id=? AND c.user_id=?`
  ).bind(messageId, user.id).first<AssistantMessageRow & { workspace_id: number; prediction_id: number | null }>();
  if (!message) {
    return c.json({
      error: "ERROR_ASSISTANT_CHAT_DOES_NOT_EXIST",
      detail: "The specified AI assistant chat does not exist.",
    }, 404);
  }
  await assertHasWorkspaceRole(c.env.DB, user.id, Number(message.workspace_id), "VIEWER");
  if (!message.prediction_id) {
    return c.json({
      error: "ERROR_CANNOT_SUBMIT_MESSAGE_FEEDBACK",
      detail: "This message cannot be submitted for feedback because it has no associated prediction.",
    }, 400);
  }
  await c.env.DB.prepare(
    "UPDATE enterprise_assistantchatprediction SET human_sentiment=?, human_feedback=?, updated_on=? WHERE id=?"
  ).bind(
    sentiment === "LIKE" ? 1 : sentiment === "DISLIKE" ? -1 : null,
    sentiment === "DISLIKE" ? String(body.feedback || "") : "",
    nowIso(),
    message.prediction_id,
  ).run();
  return c.body(null, 204);
});

export { assistant as assistantRouter };
