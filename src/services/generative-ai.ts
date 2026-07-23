import { ValidationError } from "../middleware/error";

type JsonObject = Record<string, unknown>;

export type GenerativeAITool = {
  name: string;
  description: string;
  parameters: JsonObject;
  execute: (input: JsonObject) => Promise<unknown>;
};

export type GenerativeAIToolCall = {
  name: string;
  input: JsonObject;
  result: unknown;
};

export type GenerativeAIToolResult = {
  content: string;
  calls: GenerativeAIToolCall[];
};

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function normalizeGenerativeAISettings(value: unknown): JsonObject {
  const settings = objectValue(value);
  const normalized: JsonObject = {};
  for (const [type, rawConfig] of Object.entries(settings)) {
    const config = objectValue(rawConfig);
    if (Object.keys(config).length === 0) continue;
    const models = Array.isArray(config.models)
      ? config.models.map((model) => String(model).trim()).filter(Boolean)
      : [];
    normalized[type] = { ...config, models };
  }
  return normalized;
}

export function enabledGenerativeAIModels(settings: JsonObject): Record<string, string[]> {
  const enabled: Record<string, string[]> = {};
  for (const [type, rawConfig] of Object.entries(settings)) {
    const models = Array.isArray(objectValue(rawConfig).models)
      ? (objectValue(rawConfig).models as unknown[]).map((model) => String(model).trim()).filter(Boolean)
      : [];
    if (models.length > 0) enabled[type] = models;
  }
  return enabled;
}

export async function workspaceGenerativeAISettings(cache: KVNamespace, workspaceId: number): Promise<JsonObject> {
  const raw = await cache.get(`workspace:${workspaceId}:generative-ai`);
  if (!raw) return {};
  try {
    return normalizeGenerativeAISettings(JSON.parse(raw));
  } catch {
    return {};
  }
}

function providerSettings(settings: JsonObject, provider: string): JsonObject {
  return objectValue(settings[provider]);
}

function assertModelEnabled(settings: JsonObject, provider: string, model: string) {
  const models = Array.isArray(providerSettings(settings, provider).models)
    ? (providerSettings(settings, provider).models as unknown[]).map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!models.includes(model)) {
    throw new ValidationError("The selected model is not enabled for this workspace.");
  }
}

function assertApiKey(settings: JsonObject, provider: string) {
  if (!settings.api_key) {
    throw new ValidationError(`The ${provider} provider is missing an API key.`);
  }
}

async function responseJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function toolInput(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return objectValue(JSON.parse(value));
  } catch {
    throw new ValidationError("The AI provider returned invalid tool arguments.");
  }
}

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value ?? null);
  return serialized === undefined ? "null" : serialized;
}

async function executeTool(
  tools: Map<string, GenerativeAITool>,
  name: string,
  input: JsonObject,
  calls: GenerativeAIToolCall[],
  onToolCall?: (call: GenerativeAIToolCall) => void | Promise<void>,
) {
  const tool = tools.get(name);
  let result: unknown;
  if (!tool) {
    result = { error: `Unknown assistant tool: ${name}` };
  } else {
    try {
      result = await tool.execute(input);
    } catch (error: any) {
      result = { error: error?.message || String(error) };
    }
  }
  const call = { name, input, result };
  calls.push(call);
  await onToolCall?.(call);
  return result;
}

function openAITools(tools: GenerativeAITool[]) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

async function promptOpenAICompatibleWithTools(
  endpoint: string,
  headers: Record<string, string>,
  model: string,
  prompt: string,
  temperature: number | undefined,
  tools: GenerativeAITool[],
  onToolCall?: (call: GenerativeAIToolCall) => void | Promise<void>,
): Promise<GenerativeAIToolResult> {
  const messages: any[] = [{ role: "user", content: prompt }];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const calls: GenerativeAIToolCall[] = [];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        tools: openAITools(tools),
        tool_choice: "auto",
        ...(temperature === undefined ? {} : { temperature }),
      }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    const message = data.choices?.[0]?.message || {};
    const providerCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (providerCalls.length === 0) {
      return { content: String(message.content || ""), calls };
    }
    messages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: providerCalls,
    });
    for (const providerCall of providerCalls) {
      const name = String(providerCall?.function?.name || "");
      const input = toolInput(providerCall?.function?.arguments);
      const result = await executeTool(toolMap, name, input, calls, onToolCall);
      messages.push({
        role: "tool",
        tool_call_id: String(providerCall.id || crypto.randomUUID()),
        content: toolOutput(result),
      });
    }
  }
  throw new ValidationError("The AI assistant reached the tool execution limit.");
}

async function promptAnthropicWithTools(
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number | undefined,
  tools: GenerativeAITool[],
  onToolCall?: (call: GenerativeAIToolCall) => void | Promise<void>,
): Promise<GenerativeAIToolResult> {
  const messages: any[] = [{ role: "user", content: prompt }];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const calls: GenerativeAIToolCall[] = [];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        ...(temperature === undefined ? {} : { temperature }),
      }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    const content = Array.isArray(data.content) ? data.content : [];
    const providerCalls = content.filter((part: any) => part?.type === "tool_use");
    if (providerCalls.length === 0) {
      return {
        content: content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text || "")).join(""),
        calls,
      };
    }
    messages.push({ role: "assistant", content });
    const toolResults = [];
    for (const providerCall of providerCalls) {
      const name = String(providerCall.name || "");
      const input = toolInput(providerCall.input);
      const result = await executeTool(toolMap, name, input, calls, onToolCall);
      toolResults.push({
        type: "tool_result",
        tool_use_id: String(providerCall.id || crypto.randomUUID()),
        content: toolOutput(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  throw new ValidationError("The AI assistant reached the tool execution limit.");
}

async function promptOllamaWithTools(
  host: string,
  model: string,
  prompt: string,
  temperature: number | undefined,
  tools: GenerativeAITool[],
  onToolCall?: (call: GenerativeAIToolCall) => void | Promise<void>,
): Promise<GenerativeAIToolResult> {
  const messages: any[] = [{ role: "user", content: prompt }];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const calls: GenerativeAIToolCall[] = [];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        tools: openAITools(tools),
        ...(temperature === undefined ? {} : { options: { temperature } }),
      }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    const message = data.message || {};
    const providerCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (providerCalls.length === 0) return { content: String(message.content || ""), calls };
    messages.push(message);
    for (const providerCall of providerCalls) {
      const name = String(providerCall?.function?.name || "");
      const input = toolInput(providerCall?.function?.arguments);
      const result = await executeTool(toolMap, name, input, calls, onToolCall);
      messages.push({ role: "tool", tool_name: name, content: toolOutput(result) });
    }
  }
  throw new ValidationError("The AI assistant reached the tool execution limit.");
}

export async function promptGenerativeAIWithTools(
  settings: JsonObject,
  provider: string,
  model: string,
  prompt: string,
  tools: GenerativeAITool[],
  temperature?: number | null,
  onToolCall?: (call: GenerativeAIToolCall) => void | Promise<void>,
): Promise<GenerativeAIToolResult> {
  if (!provider || !model || !prompt.trim()) {
    throw new ValidationError("The AI assistant is missing provider, model or prompt.");
  }
  if (tools.length === 0) {
    return { content: await promptGenerativeAI(settings, provider, model, prompt, temperature), calls: [] };
  }
  assertModelEnabled(settings, provider, model);
  const config = providerSettings(settings, provider);
  const normalizedTemperature = temperature === null || temperature === undefined || Number.isNaN(Number(temperature))
    ? undefined
    : Number(temperature);

  if (provider === "openai" || provider === "openrouter" || provider === "mistral") {
    assertApiKey(config, provider);
    const endpoint = provider === "mistral"
      ? "https://api.mistral.ai/v1/chat/completions"
      : `${provider === "openrouter" ? "https://openrouter.ai/api/v1" : String(config.base_url || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
    return promptOpenAICompatibleWithTools(endpoint, {
      Authorization: `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
      ...(provider === "openai" && config.organization ? { "OpenAI-Organization": String(config.organization) } : {}),
    }, model, prompt, normalizedTemperature, tools, onToolCall);
  }

  if (provider === "anthropic") {
    assertApiKey(config, provider);
    return promptAnthropicWithTools(String(config.api_key), model, prompt, normalizedTemperature, tools, onToolCall);
  }

  if (provider === "ollama") {
    const host = String(config.host || "").replace(/\/$/, "");
    if (!host) throw new ValidationError("The Ollama provider is missing a host.");
    return promptOllamaWithTools(host, model, prompt, normalizedTemperature, tools, onToolCall);
  }

  throw new ValidationError(`Unknown AI provider: ${provider}`);
}

export async function promptGenerativeAI(
  settings: JsonObject,
  provider: string,
  model: string,
  prompt: string,
  temperature?: number | null
): Promise<string> {
  if (!provider || !model || !prompt.trim()) {
    throw new ValidationError("The AI field is missing provider, model or prompt.");
  }
  assertModelEnabled(settings, provider, model);
  const config = providerSettings(settings, provider);
  const normalizedTemperature = temperature === null || temperature === undefined || Number.isNaN(Number(temperature))
    ? undefined
    : Number(temperature);

  if (provider === "openai" || provider === "openrouter") {
    assertApiKey(config, provider);
    const baseUrl = provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : String(config.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.api_key}`,
        "Content-Type": "application/json",
        ...(config.organization ? { "OpenAI-Organization": String(config.organization) } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        ...(normalizedTemperature === undefined ? {} : { temperature: normalizedTemperature }),
      }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    return String(data.choices?.[0]?.message?.content || "");
  }

  if (provider === "anthropic") {
    assertApiKey(config, provider);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": String(config.api_key || ""),
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
        ...(normalizedTemperature === undefined ? {} : { temperature: normalizedTemperature }),
      }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    return String((data.content || []).map((part: any) => part.text || "").join(""));
  }

  if (provider === "mistral") {
    assertApiKey(config, provider);
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        ...(normalizedTemperature === undefined ? {} : { temperature: normalizedTemperature }),
      }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    return String(data.choices?.[0]?.message?.content || "");
  }

  if (provider === "ollama") {
    const host = String(config.host || "").replace(/\/$/, "");
    if (!host) throw new ValidationError("The Ollama provider is missing a host.");
    const response = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        ...(normalizedTemperature === undefined ? {} : { options: { temperature: normalizedTemperature } }),
      }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new ValidationError(`AI provider rejected the prompt: ${JSON.stringify(data)}`);
    return String(data.response || "");
  }

  throw new ValidationError(`Unknown AI provider: ${provider}`);
}
