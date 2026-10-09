import Anthropic from "@anthropic-ai/sdk";

/**
 * JSON Schema subset accepted by every provider. Objects must list every
 * property in `required` and set `additionalProperties: false`; optional
 * values are expressed as `anyOf: [{...}, { type: "null" }]`.
 */
export type JsonSchema = { [key: string]: unknown };

/** How much reasoning a call deserves. Extraction is `low`; strategy is `high`. */
export type LlmEffort = "low" | "medium" | "high";

export interface JsonRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  maxTokens?: number;
  effort?: LlmEffort;
}

export interface JsonLlm {
  /** Provider/model label recorded on AI-authored changes. */
  readonly model: string;
  json<T>(request: JsonRequest): Promise<T>;
}

export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export class LlmError extends Error {}

export const WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export type LlmEnv = {
  AI?: WorkersAiBinding;
  DEEPSEEK_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Optional model override for whichever provider is active (e.g. `deepseek-v4-pro`). */
  LLM_MODEL?: string;
};

/**
 * Picks the provider from the configured keys: DeepSeek, then Claude, then
 * Workers AI (which needs no key, so it stays the zero-config default).
 */
export function createLlm(env: LlmEnv, fetcher: typeof fetch = fetch): JsonLlm {
  const model = env.LLM_MODEL?.trim() || undefined;
  if (env.DEEPSEEK_API_KEY) return new DeepSeekJsonLlm(env.DEEPSEEK_API_KEY, model ?? DEFAULT_DEEPSEEK_MODEL, fetcher);
  if (env.ANTHROPIC_API_KEY) return new AnthropicJsonLlm(env.ANTHROPIC_API_KEY, model ?? DEFAULT_ANTHROPIC_MODEL);
  if (env.AI) return new WorkersAiJsonLlm(env.AI, model ?? WORKERS_AI_MODEL);
  throw new LlmError("No language model is configured. Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY, or bind Workers AI.");
}

/** A provider HTTP failure; `status` lets callers tell setup problems from transient ones. */
export class LlmHttpError extends Error {
  constructor(readonly provider: string, readonly status: number, detail: string) {
    super(`${provider} API error ${status}: ${detail}`);
  }
}

/** Every provider is told the exact JSON shape; providers without schema enforcement rely on this plus caller validation. */
function jsonInstructions(request: JsonRequest): string {
  return `${request.system}\n\nRespond with a single JSON object (json only, no prose) matching this JSON Schema:\n${JSON.stringify(request.schema)}`;
}

/**
 * DeepSeek's OpenAI-compatible chat API in JSON mode. Bulk, low-effort calls
 * (extraction) run with thinking disabled; scoping and copy keep thinking on.
 */
class DeepSeekJsonLlm implements JsonLlm {
  constructor(private readonly apiKey: string, readonly model: string, private readonly fetcher: typeof fetch) {}

  async json<T>(request: JsonRequest): Promise<T> {
    const thinking = (request.effort ?? "medium") !== "low";
    // JSON mode can occasionally return empty or unparsable content; one retry fixes nearly all of it.
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetcher(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: jsonInstructions(request) },
            { role: "user", content: request.user },
          ],
          response_format: { type: "json_object" },
          thinking: { type: thinking ? "enabled" : "disabled" },
          // With thinking on, the default budget (64K) leaves room for reasoning before the answer.
          // Temperature only applies without thinking; extraction should be repeatable.
          ...(thinking ? {} : { max_tokens: request.maxTokens ?? 8000, temperature: 0 }),
          stream: false,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      // While a request waits for capacity DeepSeek streams keep-alive blank lines, so trim before parsing.
      const text = (await response.text()).trim();
      if (!response.ok) {
        let detail = text.slice(0, 300);
        try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* keep raw text */ }
        throw new LlmHttpError("DeepSeek", response.status, detail);
      }
      const body = JSON.parse(text) as { choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }> };
      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") throw new LlmError("The model response was truncated.");
      if (choice?.finish_reason === "content_filter") throw new LlmError("The model declined this request.");
      if (choice?.finish_reason === "insufficient_system_resource" || choice?.finish_reason === "aborted") {
        throw new LlmHttpError("DeepSeek", 503, "The model was interrupted by provider load; retry shortly.");
      }
      const content = choice?.message?.content?.trim();
      try {
        if (content) return parseJson<T>(content);
      } catch (error) {
        if (attempt >= 2) throw error;
        continue;
      }
      if (attempt >= 2) throw new LlmError("The model returned an empty response.");
    }
  }
}

class AnthropicJsonLlm implements JsonLlm {
  private readonly client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async json<T>(request: JsonRequest): Promise<T> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      output_config: {
        effort: request.effort ?? "medium",
        format: { type: "json_schema", schema: request.schema },
      },
    });
    if (response.stop_reason === "refusal") throw new LlmError("The model declined this request.");
    if (response.stop_reason === "max_tokens") throw new LlmError("The model response was truncated.");
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    return parseJson<T>(text);
  }
}

class WorkersAiJsonLlm implements JsonLlm {
  constructor(private readonly ai: WorkersAiBinding, readonly model: string) {}

  async json<T>(request: JsonRequest): Promise<T> {
    // Workers AI JSON mode does not enforce a schema, so the schema travels in
    // the prompt and callers validate the result.
    const raw = await this.ai.run(this.model, {
      messages: [
        { role: "system", content: jsonInstructions(request) },
        { role: "user", content: request.user },
      ],
      response_format: { type: "json_object" },
      max_tokens: Math.min(request.maxTokens ?? 4000, 8000),
    });
    const record = raw as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    const content = record.response ?? record.choices?.[0]?.message?.content;
    if (typeof content === "object" && content !== null) return content as T;
    if (typeof content !== "string") throw new LlmError("Workers AI returned no content.");
    return parseJson<T>(content);
  }
}

function parseJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new LlmError("The model returned malformed JSON.");
  }
}

/** Turns provider failures into a message that says how to fix the setup, when it is a setup problem. */
export function describeModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof LlmHttpError ? error.status : undefined;
  if (status === 402 || /insufficient balance/i.test(message)) {
    return `The language model account has run out of credit (${message}). Top up the provider account, then retry.`;
  }
  if (status === 401 || status === 403 || /run remotely|not logged in|authenticat|unauthori[sz]ed|invalid x-api-key/i.test(message)) {
    return `The language model is unavailable (${message}). Check the API key in .dev.vars / Worker secrets (DEEPSEEK_API_KEY or ANTHROPIC_API_KEY); in local development Workers AI needs Cloudflare credentials, so set one of those keys instead.`;
  }
  if (status === 429 || status === 500 || status === 503 || /rate limit|overloaded|\b529\b/i.test(message)) {
    return `The language model is busy (${message}). Try again in a minute.`;
  }
  return message || "The language model request failed.";
}

export type ChatToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ChatToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ChatTool = { name: string; description: string; parameters: JsonSchema };

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ChatToolCall[] }
  | { type: "finish"; reason: string; usage?: { promptTokens: number; completionTokens: number } };

/** The data lines of a server-sent event stream, reassembled across network chunks. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
}

/**
 * One streamed DeepSeek chat turn with tools: text as it arrives, then the
 * tool calls once their arguments are complete. Thinking stays off, so tool
 * rounds never have to send earlier reasoning back.
 */
export async function* streamChat(
  env: LlmEnv,
  input: { messages: ChatMessage[]; tools: ChatTool[]; signal?: AbortSignal; maxTokens?: number },
  fetcher: typeof fetch = fetch,
): AsyncGenerator<ChatEvent> {
  if (!env.DEEPSEEK_API_KEY) throw new LlmError("Ask Eumon needs a DeepSeek key. Set DEEPSEEK_API_KEY in .dev.vars locally, or as a Worker secret.");
  const response = await fetcher(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.LLM_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
      messages: input.messages.map((message) => (
        message.role === "tool" ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
        : message.role === "assistant" && message.toolCalls?.length ? {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
        }
        : { role: message.role, content: message.content })),
      ...(input.tools.length ? { tools: input.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
      thinking: { type: "disabled" },
      max_tokens: input.maxTokens ?? 4000,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const text = (await response.text()).trim();
    let detail = text.slice(0, 300);
    try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* keep raw text */ }
    throw new LlmHttpError("DeepSeek", response.status, detail);
  }
  const calls = new Map<number, ChatToolCall>();
  let reason = "";
  let usage: { promptTokens: number; completionTokens: number } | undefined;
  for await (const data of sseData(response.body)) {
    if (data === "[DONE]") break;
    const chunk = JSON.parse(data) as {
      usage?: { prompt_tokens: number; completion_tokens: number };
      choices?: Array<{
        finish_reason?: string | null;
        delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
      }>;
    };
    if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) yield { type: "text", text: choice.delta.content };
    for (const fragment of choice?.delta?.tool_calls ?? []) {
      const call = calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name = fragment.function.name;
      call.arguments += fragment.function?.arguments ?? "";
      calls.set(fragment.index, call);
    }
    if (choice?.finish_reason) reason = choice.finish_reason;
  }
  if (reason === "insufficient_system_resource") throw new LlmHttpError("DeepSeek", 503, "The model was interrupted by provider load; retry shortly.");
  if (calls.size) yield { type: "tool_calls", calls: [...calls.values()] };
  yield { type: "finish", reason, ...(usage ? { usage } : {}) };
}

/** Helpers for building strict schemas without repeating boilerplate. */
export const schema = {
  object(properties: Record<string, JsonSchema>): JsonSchema {
    return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  },
  array(items: JsonSchema): JsonSchema {
    return { type: "array", items };
  },
  string(description?: string): JsonSchema {
    return description ? { type: "string", description } : { type: "string" };
  },
  number(description?: string): JsonSchema {
    return description ? { type: "number", description } : { type: "number" };
  },
  boolean(description?: string): JsonSchema {
    return description ? { type: "boolean", description } : { type: "boolean" };
  },
  enum(values: string[], description?: string): JsonSchema {
    return { type: "string", enum: values, ...(description ? { description } : {}) };
  },
  nullable(inner: JsonSchema): JsonSchema {
    return { anyOf: [inner, { type: "null" }] };
  },
};
