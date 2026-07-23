import { afterEach, describe, expect, it, vi } from "vitest";
import { promptGenerativeAIWithTools, type GenerativeAITool } from "../src/services/generative-ai";

const echoTool: GenerativeAITool = {
  name: "echo",
  description: "Return the provided value.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  execute: async (input) => ({ echoed: input.value }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generative AI tool transports", () => {
  it.each([
    ["mistral", "https://api.mistral.ai/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
  ])("executes OpenAI-compatible tool calls for %s", async (provider, endpoint) => {
    const requests: Array<{ url: string; body: any }> = [];
    const responses = [
      {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "tool-1",
              type: "function",
              function: { name: "echo", arguments: JSON.stringify({ value: "hello" }) },
            }],
          },
        }],
      },
      { choices: [{ message: { content: "completed" } }] },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body || "{}")) });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }));

    const result = await promptGenerativeAIWithTools({
      [provider]: { api_key: "key", models: ["model"] },
    }, provider, "model", "run the tool", [echoTool]);

    expect(result).toEqual({
      content: "completed",
      calls: [{ name: "echo", input: { value: "hello" }, result: { echoed: "hello" } }],
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(endpoint);
    expect(requests[1].body.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "tool-1",
      content: JSON.stringify({ echoed: "hello" }),
    });
  });

  it("executes Anthropic tool_use blocks and returns tool_result blocks", async () => {
    const requests: any[] = [];
    const responses = [
      {
        content: [{ type: "tool_use", id: "tool-2", name: "echo", input: { value: "anthropic" } }],
      },
      { content: [{ type: "text", text: "completed" }] },
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }));

    const result = await promptGenerativeAIWithTools({
      anthropic: { api_key: "key", models: ["model"] },
    }, "anthropic", "model", "run the tool", [echoTool]);

    expect(result.content).toBe("completed");
    expect(result.calls[0]).toEqual({
      name: "echo",
      input: { value: "anthropic" },
      result: { echoed: "anthropic" },
    });
    expect(requests[1].messages.at(-1)).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-2",
        content: JSON.stringify({ echoed: "anthropic" }),
      }],
    });
  });

  it("executes Ollama tool calls through the chat endpoint", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const responses = [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "echo", arguments: { value: "ollama" } } }],
        },
      },
      { message: { role: "assistant", content: "completed" } },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body || "{}")) });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }));

    const result = await promptGenerativeAIWithTools({
      ollama: { host: "https://ollama.example", models: ["model"] },
    }, "ollama", "model", "run the tool", [echoTool]);

    expect(result.content).toBe("completed");
    expect(result.calls[0]).toEqual({
      name: "echo",
      input: { value: "ollama" },
      result: { echoed: "ollama" },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://ollama.example/api/chat",
      "https://ollama.example/api/chat",
    ]);
    expect(requests[1].body.messages.at(-1)).toEqual({
      role: "tool",
      tool_name: "echo",
      content: JSON.stringify({ echoed: "ollama" }),
    });
  });
});
