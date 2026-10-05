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
          ...(thinking ? {} : { max_tokens: request.maxTokens ?? 8000 }),
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
