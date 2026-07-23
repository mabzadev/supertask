import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import type { Env } from "../types/env";
import { authenticateUserSessionRequest } from "../middleware/auth";
import {
  contentKind,
  createContentVersion,
  getContentAccess,
  materializedContent,
  persistMaterializedContent,
  type ContentKind,
} from "../services/collaboration";

type RoomContext = {
  userId: number;
  kind: ContentKind;
  contentId: number;
  readOnly: boolean;
  editorSchemaVersion: number;
};

const META_MAP = "opentabl";

export class ContentRoomDO {
  private readonly room: Hocuspocus<RoomContext>;
  private kind: ContentKind | null = null;
  private contentId = 0;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.room = new Hocuspocus<RoomContext>({
      name: "opentabl-content-room",
      quiet: true,
      debounce: 800,
      maxDebounce: 4_000,
      timeout: 60_000,
      unloadImmediately: true,
      onAuthenticate: async ({ context, connectionConfig }) => {
        if (!context?.userId || !context.kind || !context.contentId) throw new Error("Non authentifié");
        await getContentAccess(this.env.DB, context.userId, context.kind, context.contentId, "VIEWER");
        const access = await getContentAccess(this.env.DB, context.userId, context.kind, context.contentId, "VIEWER");
        connectionConfig.readOnly = context.readOnly || context.editorSchemaVersion < access.editor_schema_version;
        return context;
      },
      onLoadDocument: async ({ document, context }) => {
        this.kind = context.kind;
        this.contentId = context.contentId;
        const stored = await this.state.storage.get<ArrayBuffer>("ydoc");
        if (stored) {
          Y.applyUpdate(document, new Uint8Array(stored));
          return document;
        }
        const access = await getContentAccess(this.env.DB, context.userId, context.kind, context.contentId, "VIEWER");
        document.getMap(META_MAP).set("materialized", materializedContent(access));
        document.getMap(META_MAP).set("editor_schema_version", access.editor_schema_version);
        return document;
      },
      onStoreDocument: async ({ document, lastContext }) => {
        const update = Y.encodeStateAsUpdate(document);
        await this.state.storage.put("ydoc", update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength));
        await this.state.storage.put("dirty", true);
        const alarm = await this.state.storage.getAlarm();
        if (alarm === null) await this.state.storage.setAlarm(Date.now() + 5 * 60_000);
        const materialized = document.getMap(META_MAP).get("materialized");
        if (materialized && typeof materialized === "object") {
          await persistMaterializedContent(
            this.env.DB,
            lastContext.kind,
            lastContext.contentId,
            materialized as Record<string, unknown>,
          );
        }
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("Connexion WebSocket attendue.", { status: 426 });
    }
    const user = await authenticateUserSessionRequest(this.env, request);
    if (!user) return new Response("Authentification requise.", { status: 401 });
    const url = new URL(request.url);
    const kind = contentKind(url.searchParams.get("kind"));
    const contentId = Number(url.searchParams.get("content_id"));
    const editorSchemaVersion = Math.max(0, Number(url.searchParams.get("editor_schema_version")) || 0);
    let readOnly = false;
    try {
      await getContentAccess(this.env.DB, user.id, kind, contentId, "EDITOR");
    } catch {
      await getContentAccess(this.env.DB, user.id, kind, contentId, "VIEWER");
      readOnly = true;
    }
    this.kind = kind;
    this.contentId = contentId;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.room.handleConnection(server, request, { userId: user.id, kind, contentId, readOnly, editorSchemaVersion });
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const dirty = await this.state.storage.get<boolean>("dirty");
    if (!dirty || !this.kind || !this.contentId) return;
    const row = await this.env.DB.prepare(
      this.kind === "document-page"
        ? `SELECT p.*, a.workspace_id, a.id AS application_id FROM opentabl_document_page p
           JOIN core_application a ON a.id=p.document_id WHERE p.id=? AND a.trashed=0`
        : `SELECT c.*, a.workspace_id, a.id AS application_id FROM opentabl_whiteboard_canvas c
           JOIN core_application a ON a.id=c.whiteboard_id WHERE c.id=? AND c.trashed=0 AND a.trashed=0`
    ).bind(this.contentId).first<Record<string, any>>();
    if (!row) return;
    const access = {
      kind: this.kind,
      id: this.contentId,
      application_id: Number(row.application_id),
      workspace_id: Number(row.workspace_id),
      name: String(this.kind === "document-page" ? row.title || "Sans titre" : row.name || "Canevas"),
      editor_schema_version: Math.max(1, Number(row.editor_schema_version) || 1),
      row,
    };
    await createContentVersion(this.env, access, { automatic: true });
    await this.state.storage.put("dirty", false);
  }
}
