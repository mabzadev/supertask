import { jwtVerify } from "jose";
import type { Env, WSMessage } from "../types/env";
import {
  assertHasApplicationRole,
  assertHasTableRole,
  assertHasWorkspaceRole,
} from "../services/enterprise-permissions";

export const CORE_REALTIME_ROOM = "core";

type PageType = "table" | "row" | "view" | "dashboard";

type PageSubscription = {
  key: string;
  type: PageType;
  parameters: Record<string, unknown>;
};

type ClientAttachment = {
  websocketId: string;
  userId: number;
  pages: PageSubscription[];
};

interface ConnectedClient {
  webSocket: WebSocket;
  websocketId: string;
  userId: number;
  pages: Map<string, PageSubscription>;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function normalizeRealtimePage(
  pageValue: unknown,
  parameters: Record<string, unknown>,
): PageSubscription | null {
  const rawPage = String(pageValue ?? "");
  const legacyTable = /^table-(\d+)$/.exec(rawPage);
  if (legacyTable) {
    const tableId = Number(legacyTable[1]);
    return { key: `table-${tableId}`, type: "table", parameters: { table_id: tableId } };
  }
  const legacyRow = /^table-(\d+)-row-(\d+)$/.exec(rawPage);
  if (legacyRow) {
    const tableId = Number(legacyRow[1]);
    const rowId = Number(legacyRow[2]);
    return {
      key: `table-${tableId}-row-${rowId}`,
      type: "row",
      parameters: { table_id: tableId, row_id: rowId },
    };
  }
  if (rawPage === "table") {
    const tableId = positiveInteger(parameters.table_id);
    return tableId
      ? { key: `table-${tableId}`, type: "table", parameters: { table_id: tableId } }
      : null;
  }
  if (rawPage === "row") {
    const tableId = positiveInteger(parameters.table_id);
    const rowId = positiveInteger(parameters.row_id);
    return tableId && rowId
      ? {
          key: `table-${tableId}-row-${rowId}`,
          type: "row",
          parameters: { table_id: tableId, row_id: rowId },
        }
      : null;
  }
  if (rawPage === "view") {
    const slug = String(parameters.slug || "").trim();
    if (!slug) return null;
    return {
      key: `view-${slug}`,
      type: "view",
      parameters: { slug, token: parameters.token || null },
    };
  }
  if (rawPage === "dashboard") {
    const dashboardId = positiveInteger(parameters.dashboard_id);
    return dashboardId
      ? {
          key: `dashboard-${dashboardId}`,
          type: "dashboard",
          parameters: { dashboard_id: dashboardId },
        }
      : null;
  }
  return null;
}

function attachmentFromSocket(state: DurableObjectState, ws: WebSocket): ClientAttachment {
  const tags = state.getTags(ws);
  const stored = ws.deserializeAttachment?.() as Partial<ClientAttachment> | null;
  return {
    websocketId: String(stored?.websocketId || tags[0] || ""),
    userId: Number(stored?.userId ?? tags[1] ?? 0),
    pages: Array.isArray(stored?.pages) ? stored.pages : [],
  };
}

export class WorkspaceRoomDO {
  private state: DurableObjectState;
  private env: Env;
  private clients: Map<string, ConnectedClient> = new Map();
  /**
   * Broadcasts are delivered one after the other, in arrival order: writers
   * don't wait for them, so two quick edits of a row must not reach the other
   * clients swapped.
   */
  private broadcasts: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/broadcast") {
      const delivered = this.broadcasts.then(() => this.handleBroadcast(request));
      this.broadcasts = delivered.catch(() => undefined);
      return delivered;
    }
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request, url);
    }
    return new Response("Not found", { status: 404 });
  }

  private clientForSocket(ws: WebSocket): ConnectedClient {
    const attachment = attachmentFromSocket(this.state, ws);
    const cached = this.clients.get(attachment.websocketId);
    if (cached) return cached;
    const client = {
      webSocket: ws,
      websocketId: attachment.websocketId,
      userId: attachment.userId,
      pages: new Map(attachment.pages.map((page) => [page.key, page])),
    };
    this.clients.set(client.websocketId, client);
    return client;
  }

  private persistClient(client: ConnectedClient): void {
    client.webSocket.serializeAttachment({
      websocketId: client.websocketId,
      userId: client.userId,
      pages: [...client.pages.values()],
    } satisfies ClientAttachment);
  }

  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const token =
      url.searchParams.get("jwt_token") ||
      url.searchParams.get("token") ||
      request.headers.get("Authorization")?.replace("JWT ", "");

    let userId = 0;
    try {
      if (!token) throw new Error("No token");
      if (token !== "anonymous") {
        // Same checks as the HTTP API: access tokens only, active user, not
        // invalidated by a password change. Builder user-source and 2FA
        // tokens share the signing key and must not open a session.
        const { authenticateUserSessionRequest } = await import("../middleware/auth");
        const user = await authenticateUserSessionRequest(this.env, request);
        if (!user) throw new Error("Invalid token");
        userId = user.id;
      }
    } catch {
      server.accept();
      server.send(JSON.stringify({ type: "authentication", success: false, web_socket_id: null }));
      server.close(1008, "Unauthorized");
      return new Response(null, { status: 101, webSocket: client });
    }

    const websocketId = crypto.randomUUID();
    this.state.acceptWebSocket(server, [websocketId, String(userId)]);
    const connectedClient: ConnectedClient = {
      webSocket: server,
      websocketId,
      userId,
      pages: new Map(),
    };
    this.clients.set(websocketId, connectedClient);
    this.persistClient(connectedClient);
    server.send(JSON.stringify({
      type: "authentication",
      success: true,
      web_socket_id: websocketId,
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async tableScope(tableId: number) {
    return this.env.DB.prepare(
      `SELECT t.id, t.database_id, a.workspace_id
         FROM database_table t
         JOIN core_application a ON a.id=t.database_id
        WHERE t.id=? AND t.trashed=0 AND a.trashed=0`
    ).bind(tableId).first<{ id: number; database_id: number; workspace_id: number }>();
  }

  private async canSubscribe(client: ConnectedClient, page: PageSubscription): Promise<boolean> {
    if (page.type === "view") {
      const view = await this.env.DB.prepare(
        `SELECT id, slug, public_view_password
           FROM database_view
          WHERE slug=? AND public=1 AND trashed=0`
      ).bind(String(page.parameters.slug)).first<{ id: number; slug: string; public_view_password: string | null }>();
      if (!view) return false;
      if (!view.public_view_password) return true;
      const token = String(page.parameters.token || "");
      if (!token) return false;
      try {
        const secret = `${view.slug}-${view.public_view_password}-${this.env.SECRET_KEY || this.env.JWT_SIGNING_KEY}`;
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
        return payload.slug_id === view.slug;
      } catch {
        return false;
      }
    }
    if (client.userId <= 0) return false;
    if (page.type === "dashboard") {
      try {
        await assertHasApplicationRole(
          this.env.DB,
          client.userId,
          Number(page.parameters.dashboard_id),
          "VIEWER",
        );
        return true;
      } catch {
        return false;
      }
    }
    const tableId = Number(page.parameters.table_id);
    const table = await this.tableScope(tableId);
    if (!table) return false;
    try {
      await assertHasTableRole(this.env.DB, client.userId, table, "VIEWER");
      if (page.type === "row") {
        const rowId = Number(page.parameters.row_id);
        const row = await this.env.DB.prepare(
          `SELECT id FROM "database_table_${tableId}" WHERE id=? AND trashed=0`
        ).bind(rowId).first<{ id: number }>();
        return Boolean(row);
      }
      return true;
    } catch {
      return false;
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const client = this.clientForSocket(ws);
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    const adding = Object.prototype.hasOwnProperty.call(data, "page") || data.type === "page_add";
    const removing = Object.prototype.hasOwnProperty.call(data, "remove_page") || data.type === "page_discard";
    if (adding) {
      const page = normalizeRealtimePage(data.page, data);
      if (!page || !await this.canSubscribe(client, page)) return;
      client.pages.set(page.key, page);
      this.persistClient(client);
      ws.send(JSON.stringify({ type: "page_add", page: page.type, parameters: page.parameters }));
    }
    if (removing) {
      const page = normalizeRealtimePage(data.remove_page ?? data.page, data);
      if (!page) return;
      client.pages.delete(page.key);
      this.persistClient(client);
      ws.send(JSON.stringify({ type: "page_discard", page: page.type, parameters: page.parameters }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.clients.delete(attachmentFromSocket(this.state, ws).websocketId);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const websocketId = attachmentFromSocket(this.state, ws).websocketId;
    this.clients.delete(websocketId);
    console.error(`WebSocket error for ${websocketId}:`, error);
  }

  private async canReceiveWorkspaceBroadcast(
    client: ConnectedClient,
    workspaceId: number,
    page: PageSubscription | null,
    targeted: boolean,
    message: WSMessage,
  ): Promise<boolean> {
    if (targeted && message.type === "permissions_updated") {
      for (const subscribedPage of [...client.pages.values()]) {
        if (!["table", "row", "dashboard"].includes(subscribedPage.type)) continue;
        if (await this.canSubscribe(client, subscribedPage)) continue;
        client.pages.delete(subscribedPage.key);
        client.webSocket.send(JSON.stringify({
          type: "page_discard",
          page: subscribedPage.type,
          parameters: subscribedPage.parameters,
        }));
      }
      this.persistClient(client);
      return true;
    }
    if (page?.type === "view") return client.pages.has(page.key);
    if (client.userId <= 0) return false;
    if (page?.type === "table" || page?.type === "row") {
      const table = await this.tableScope(Number(page.parameters.table_id));
      if (!table || table.workspace_id !== workspaceId) return false;
      try {
        await assertHasTableRole(this.env.DB, client.userId, table, "VIEWER");
        return true;
      } catch {
        client.pages.delete(page.key);
        this.persistClient(client);
        client.webSocket.send(JSON.stringify({
          type: "page_discard",
          page: page.type,
          parameters: page.parameters,
        }));
        return false;
      }
    }
    try {
      await assertHasWorkspaceRole(this.env.DB, client.userId, workspaceId, "VIEWER");
      return true;
    } catch {
      return false;
    }
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const data = await request.json<{
      message: WSMessage;
      workspace_id: number;
      exclude_websocket_id?: string;
      page_filter?: string;
      user_ids?: number[];
    }>();
    const { message, exclude_websocket_id, page_filter } = data;
    const workspaceId = Number(data.workspace_id);
    const allowedUserIds = Array.isArray(data.user_ids) ? new Set(data.user_ids.map(Number)) : null;
    const page = page_filter ? normalizeRealtimePage(page_filter, {}) : null;
    const candidates = this.state.getWebSockets()
      .map((ws) => ({ ws, client: this.clientForSocket(ws) }))
      .filter(({ client }) => client.websocketId !== exclude_websocket_id
        && (!allowedUserIds || allowedUserIds.has(client.userId))
        && (!page_filter || (page !== null && client.pages.has(page.key))));
    // Recipients are checked concurrently, so a broadcast (which the writing
    // request waits for) costs the same with one connected tab or many.
    const allowed = await Promise.all(candidates.map(({ client }) =>
      this.canReceiveWorkspaceBroadcast(client, workspaceId, page, Boolean(allowedUserIds), message)));
    let recipients = 0;
    const payload = JSON.stringify(message);
    candidates.forEach(({ ws, client }, index) => {
      if (!allowed[index]) return;
      try {
        ws.send(payload);
        recipients++;
      } catch {
        this.clients.delete(client.websocketId);
      }
    });
    return Response.json({ ok: true, recipients });
  }
}

export async function broadcastToWorkspace(
  env: Env,
  workspaceId: number,
  message: WSMessage,
  options: { excludeWebsocketId?: string; pageFilter?: string; userIds?: number[] } = {}
): Promise<void> {
  try {
    const roomId = env.WORKSPACE_ROOM.idFromName(CORE_REALTIME_ROOM);
    const room = env.WORKSPACE_ROOM.get(roomId);
    await room.fetch("https://internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        workspace_id: workspaceId,
        exclude_websocket_id: options.excludeWebsocketId,
        page_filter: options.pageFilter,
        user_ids: options.userIds,
      }),
    });
  } catch (error) {
    console.error("Failed to broadcast:", error);
  }
}
