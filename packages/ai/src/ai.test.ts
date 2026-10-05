import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlm, describeModelError, LlmError, LlmHttpError, schema } from "./index.js";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fetch stand-in that replays canned responses and records each request. */
function fakeFetch(responses: Array<{ status?: number; body: string }>): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return new Response(next.body, { status: next.status ?? 200 });
  }) as typeof fetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const completion = (content: string | null, finishReason = "stop") =>
  JSON.stringify({ choices: [{ finish_reason: finishReason, message: { role: "assistant", content } }] });

const request = { system: "Extract records.", user: "page text", schema: schema.object({ name: schema.string() }) };

describe("DeepSeek provider", () => {
  it("sends an OpenAI-compatible JSON-mode request, with thinking off for bulk work", async () => {
    const fetcher = fakeFetch([{ body: completion('{"name":"Sunway Pyramid"}') }]);
    const llm = createLlm({ DEEPSEEK_API_KEY: "sk-test" }, fetcher);
    assert.equal(llm.model, "deepseek-flash");
    assert.deepEqual(await llm.json({ ...request, effort: "low", maxTokens: 12000 }), { name: "Sunway Pyramid" });
    const [call] = fetcher.calls;
    assert.equal(call!.url, "https://api.deepseek.com/chat/completions");
    assert.equal((call!.init.headers as Record<string, string>).Authorization, "Bearer sk-test");
    assert.deepEqual(call!.body.response_format, { type: "json_object" });
    assert.deepEqual(call!.body.thinking, { type: "disabled" });
    assert.equal(call!.body.max_tokens, 12000);
    const system = (call!.body.messages as Array<{ role: string; content: string }>)[0]!.content;
    assert.match(system, /json/i, "JSON mode requires the prompt to ask for JSON");
    assert.ok(system.includes('"name"'), "the schema travels in the prompt");
  });

  it("keeps thinking on for strategy work and leaves room for reasoning", async () => {
    const fetcher = fakeFetch([{ body: completion('{"name":"x"}') }]);
    await createLlm({ DEEPSEEK_API_KEY: "sk-test", LLM_MODEL: "deepseek-v4-pro" }, fetcher).json({ ...request, effort: "high", maxTokens: 16000 });
    assert.equal(fetcher.calls[0]!.body.model, "deepseek-v4-pro");
    assert.deepEqual(fetcher.calls[0]!.body.thinking, { type: "enabled" });
    assert.equal(fetcher.calls[0]!.body.max_tokens, undefined);
  });

  it("tolerates keep-alive whitespace before the response body", async () => {
    const fetcher = fakeFetch([{ body: `\n\n\n${completion('{"name":"ok"}')}` }]);
    assert.deepEqual(await createLlm({ DEEPSEEK_API_KEY: "k" }, fetcher).json(request), { name: "ok" });
  });

  it("retries once when JSON mode returns empty content", async () => {
    const fetcher = fakeFetch([{ body: completion("") }, { body: completion('{"name":"second try"}') }]);
    assert.deepEqual(await createLlm({ DEEPSEEK_API_KEY: "k" }, fetcher).json(request), { name: "second try" });
    assert.equal(fetcher.calls.length, 2);
  });

  it("reports truncation as a model error (fails that page, not the run)", async () => {
    const fetcher = fakeFetch([{ body: completion('{"name":', "length") }]);
    await assert.rejects(createLlm({ DEEPSEEK_API_KEY: "k" }, fetcher).json(request), LlmError);
  });

  it("surfaces billing and capacity errors with actionable messages", async () => {
    const broke = fakeFetch([{ status: 402, body: JSON.stringify({ error: { message: "Insufficient Balance" } }) }]);
    const error = await createLlm({ DEEPSEEK_API_KEY: "k" }, broke).json(request).catch((cause: unknown) => cause);
    assert.ok(error instanceof LlmHttpError && error.status === 402);
    assert.match(describeModelError(error), /run out of credit/);
    assert.ok(!(error instanceof LlmError), "provider outages must not be mistaken for a bad page");

    const busy = fakeFetch([{ status: 503, body: "Server Overloaded" }]);
    assert.match(describeModelError(await createLlm({ DEEPSEEK_API_KEY: "k" }, busy).json(request).catch((cause: unknown) => cause)), /busy/);

    const badKey = fakeFetch([{ status: 401, body: JSON.stringify({ error: { message: "Authentication Fails" } }) }]);
    assert.match(describeModelError(await createLlm({ DEEPSEEK_API_KEY: "k" }, badKey).json(request).catch((cause: unknown) => cause)), /Check the API key/);
  });
});

describe("createLlm", () => {
  it("prefers DeepSeek, then Claude, then Workers AI", () => {
    const ai = { run: async () => ({ response: "{}" }) };
    assert.equal(createLlm({ DEEPSEEK_API_KEY: "d", ANTHROPIC_API_KEY: "a", AI: ai }).model, "deepseek-flash");
    assert.equal(createLlm({ ANTHROPIC_API_KEY: "a", AI: ai }).model, "claude-opus-5-5");
    assert.equal(createLlm({ AI: ai, DEEPSEEK_API_KEY: "" }).model, "@cf/google/gemma-4-26b-a4b-it");
    assert.throws(() => createLlm({}), LlmError);
  });
});
