import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRealtimePage, WorkspaceRoomDO } from "../src/durable-objects/workspace-room";

class FakeSocket {
  attachment: unknown = null;
  sent: string[] = [];

  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment() {
    return structuredClone(this.attachment);
  }

  send(value: string) {
    this.sent.push(value);
  }
}

function fakeDatabase(canViewTable: () => boolean) {
  return {
    prepare(sql: string) {
      const result = () => {
        if (sql.includes("FROM database_table t") && sql.includes("JOIN core_application")) {
          return [{ id: 20, database_id: 10, workspace_id: 1 }];
        }
        if (sql.includes("SELECT permissions FROM core_workspaceuser")) {
          return [{ permissions: canViewTable() ? "EDITOR" : "NO_ACCESS" }];
        }
        return [];
      };
      const statement = {
        bind: (..._args: unknown[]) => statement,
        all: async () => ({ results: result() }),
        first: async () => result()[0] || null,
        run: async () => ({}),
      };
      return statement;
    },
  };
}

function fakeState(socket: FakeSocket) {
  return {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: () => [socket],
    getTags: () => ["socket-1", "8"],
  };
}

describe("WorkspaceRoomDO Baserow protocol", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocketRequestResponsePair", class {
      constructor(_request: string, _response: string) {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("normalizes the frontend page payload and legacy backend group names", () => {
    expect(normalizeRealtimePage("table", { table_id: 20 })).toMatchObject({
      key: "table-20",
      type: "table",
      parameters: { table_id: 20 },
    });
    expect(normalizeRealtimePage("row", { table_id: 20, row_id: 42 })).toMatchObject({
      key: "table-20-row-42",
      type: "row",
    });
    expect(normalizeRealtimePage("table-20", {})).toMatchObject({
      key: "table-20",
      type: "table",
    });
  });

  it("delivers broadcasts in arrival order when an earlier recipient check is slower", async () => {
    const socket = new FakeSocket();
    const base = fakeDatabase(() => true);
    // When armed, the next membership read waits until released.
    let slowRead: Promise<void> | null = null;
    const db = {
      prepare(sql: string) {
        const statement = base.prepare(sql);
        if (!slowRead || !sql.includes("SELECT permissions FROM core_workspaceuser")) return statement;
        const wait = slowRead;
        slowRead = null;
        const delayed: any = {
          bind: () => delayed,
          all: async () => { await wait; return statement.all(); },
          first: async () => { await wait; return statement.first(); },
        };
        return delayed;
      },
    };
    const room = new WorkspaceRoomDO(fakeState(socket) as any, { DB: db, JWT_SIGNING_KEY: "test-secret" } as any);
    await room.webSocketMessage(socket as any, JSON.stringify({ page: "table", table_id: 20 }));
    socket.sent = [];

    let release!: () => void;
    slowRead = new Promise<void>((resolve) => { release = resolve; });
    const broadcast = (edit: number) => room.fetch(new Request("https://internal/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: 1, page_filter: "table-20", message: { type: "rows_updated", table_id: 20, edit } }),
    }));
    const first = broadcast(1);
    const second = broadcast(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.sent).toEqual([]);

    release();
    await Promise.all([first, second]);
    expect(socket.sent.map((message) => JSON.parse(message).edit)).toEqual([1, 2]);
  });

  it("persists subscriptions across hibernation and discards a revoked table page", async () => {
    let canView = true;
    const socket = new FakeSocket();
    const state = fakeState(socket);
    const env = {
      DB: fakeDatabase(() => canView),
      JWT_SIGNING_KEY: "test-secret",
    } as any;

    const room = new WorkspaceRoomDO(state as any, env);
    await room.webSocketMessage(socket as any, JSON.stringify({ page: "table", table_id: 20 }));
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "page_add",
      page: "table",
      parameters: { table_id: 20 },
    });
    expect(socket.attachment).toMatchObject({
      websocketId: "socket-1",
      userId: 8,
      pages: [expect.objectContaining({ key: "table-20" })],
    });

    canView = false;
    const resumedRoom = new WorkspaceRoomDO(state as any, env);
    const permissionResponse = await resumedRoom.fetch(new Request("https://internal/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: 1,
        user_ids: [8],
        message: { type: "permissions_updated", workspace_id: 1 },
      }),
    }));

    expect(await permissionResponse.json()).toEqual({ ok: true, recipients: 1 });
    const sent = socket.sent.map((message) => JSON.parse(message));
    expect(sent.at(-2)).toEqual({
      type: "page_discard",
      page: "table",
      parameters: { table_id: 20 },
    });
    expect(sent.at(-1)).toEqual({ type: "permissions_updated", workspace_id: 1 });
    expect(socket.attachment).toMatchObject({ pages: [] });

    const eventResponse = await resumedRoom.fetch(new Request("https://internal/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: 1,
        page_filter: "table-20",
        message: { type: "row_updated", table_id: 20 },
      }),
    }));
    expect(await eventResponse.json()).toEqual({ ok: true, recipients: 0 });
  });
});
