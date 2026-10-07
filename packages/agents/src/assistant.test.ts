import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent, ChatMessage, streamChat } from "@organic-growth/ai";
import type { CrawlPageResult, SiteRecord } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, saveAnalysisReport, saveCrawlBatch, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { blockFrom, historyMessages, runAssistantTurn, type AssistantEvent, type Row } from "./assistant.js";

const now = new Date().toISOString();
const site = (id: string): SiteRecord => ({ id, name: `${id}.com`, baseUrl: `https://${id}.com`, createdAt: now, updatedAt: now });
const page = (url: string, isEmptyShell = false): CrawlPageResult => ({
  url, status: 200, finalUrl: url, title: "A title long enough", hreflang: [], jsonLdCount: 1, contentLength: 4000, isEmptyShell,
  headingOutline: [], internalLinkCount: 3, rawTextLength: 2000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", h1Count: 1,
  routeFamily: new URL(url).pathname.split("/")[1],
});

/** A model stand-in that plays one scripted round per call and records what it was sent. */
function scriptedChat(rounds: Array<(messages: ChatMessage[]) => ChatEvent[]>) {
  const sent: Array<{ messages: ChatMessage[]; tools: number }> = [];
  const chat = (async function* (_env, input) {
    sent.push({ messages: [...input.messages], tools: input.tools.length });
    const round = rounds.shift();
    if (!round) throw new Error("unexpected round");
    yield* round(input.messages);
  }) as typeof streamChat;
  return { chat, sent };
}

const lastResultId = (messages: ChatMessage[]) => {
  const tool = [...messages].reverse().find((message) => message.role === "tool");
  return tool?.role === "tool" ? (JSON.parse(tool.content) as { resultId: string }).resultId : "";
};

describe("runAssistantTurn", async () => {
  const db = openSqliteD1();
  for (const id of ["a", "b"]) await upsertSite(db, site(id));
  await createAnalysis(db, { id: "an1", siteId: "a", status: "running", createdAt: now });
  const urls = ["/doctors/x", "/doctors/y", "/procedures/p", "/procedures/q", "/procedures/r"].map((path) => `https://a.com${path}`);
  await enqueueAnalysisCrawlUrls(db, { analysisId: "an1", siteId: "a", urls: urls.map((url) => ({ url, routeFamily: url.split("/")[3]! })) });
  await saveCrawlBatch(db, { analysisId: "an1", outcomes: urls.map((url, index) => ({ url, page: page(url, index >= 2) })) });
  await saveAnalysisReport(db, "an1", { sitemap: { totalUrls: 5 }, findings: [] }, "summary");

  it("calls a tool, draws a block from its rows, then answers", async () => {
    const { chat, sent } = scriptedChat([
      () => [
        { type: "text", text: "Checking the crawl." },
        { type: "tool_calls", calls: [{ id: "c1", name: "crawl_coverage", arguments: "{}" }] },
        { type: "finish", reason: "tool_calls" },
      ],
      (messages) => [
        { type: "tool_calls", calls: [{ id: "c2", name: "show", arguments: JSON.stringify({ resultId: lastResultId(messages), kind: "bars", title: "Empty HTML by page type", label: "page_type", values: ["empty_html"], limit: null }) }] },
        { type: "finish", reason: "tool_calls" },
      ],
      () => [{ type: "text", text: "Procedures are all empty." }, { type: "finish", reason: "stop" }],
    ]);
    const events: AssistantEvent[] = [];
    const turn = await runAssistantTurn({ env: {}, db, site: site("a"), history: [], question: "Which page types are empty?", emit: (event) => events.push(event), chat });

    assert.deepEqual(events.map((event) => event.type), ["note", "step", "step", "block", "text"], "the line before the tool call becomes a note");
    assert.deepEqual(turn.parts.map((part) => part.type), ["note", "step", "block", "text"], "the finished step replaces the running one");
    const step = turn.parts[1]!.type === "step" ? turn.parts[1]! : undefined;
    assert.equal(step?.label, "Read crawl coverage");
    assert.match(step?.summary ?? "", /^Crawl finished/, "the step says what it found");
    const block = turn.parts[2]!.type === "block" ? turn.parts[2]!.block : undefined;
    assert.deepEqual(block?.rows, [{ page_type: "/procedures/", empty_html: 3 }, { page_type: "/doctors/", empty_html: 0 }], "rows come from the tool, ranked");
    assert.equal(sent.length, 3);
    const toolMessage = sent[1]!.messages.find((message) => message.role === "tool");
    assert.match(toolMessage?.role === "tool" ? toolMessage.content : "", /"resultId":"r1"/);
    assert.deepEqual(turn.tools.map((tool) => tool.name), ["crawl_coverage", "show"]);
  });

  it("only reads the current site", async () => {
    const { chat, sent } = scriptedChat([
      () => [{ type: "tool_calls", calls: [{ id: "c1", name: "crawl_coverage", arguments: "{}" }] }, { type: "finish", reason: "tool_calls" }],
      () => [{ type: "text", text: "No analysis yet." }, { type: "finish", reason: "stop" }],
    ]);
    await runAssistantTurn({ env: {}, db, site: site("b"), history: [], question: "How is the crawl?", emit: () => undefined, chat });
    const result = sent[1]!.messages.find((message) => message.role === "tool");
    assert.match(result?.role === "tool" ? result.content : "", /No analysis has finished/, "site a's crawl is not visible from site b");
  });

  it("stops offering tools after the last round", async () => {
    const call: ChatEvent[] = [{ type: "tool_calls", calls: [{ id: "c", name: "site_overview", arguments: "{}" }] }, { type: "finish", reason: "tool_calls" }];
    const { chat, sent } = scriptedChat([...Array.from({ length: 7 }, () => () => call), () => [{ type: "text", text: "Done." }, { type: "finish", reason: "stop" }]]);
    const turn = await runAssistantTurn({ env: {}, db, site: site("a"), history: [], question: "Overview?", emit: () => undefined, chat });
    assert.equal(sent.length, 8);
    assert.equal(sent.at(-1)!.tools, 0, "the eighth round must answer");
    assert.deepEqual(turn.parts.at(-1), { type: "text", text: "Done." });
  });
});

describe("runAssistantTurn resilience", async () => {
  const db = openSqliteD1();
  await upsertSite(db, site("a"));

  it("keeps a short line before tool calls as a note, out of the answer text", async () => {
    const { chat } = scriptedChat([
      () => [{ type: "text", text: "I'll check the overview." }, { type: "tool_calls", calls: [{ id: "c", name: "site_overview", arguments: "{}" }] }, { type: "finish", reason: "tool_calls" }],
      () => [{ type: "text", text: "Search Console is not connected." }, { type: "finish", reason: "stop" }],
    ]);
    const turn = await runAssistantTurn({ env: {}, db, site: site("a"), history: [], question: "Status?", emit: () => undefined, chat });
    assert.deepEqual(turn.parts.filter((part) => part.type !== "step"), [{ type: "note", text: "I'll check the overview." }, { type: "text", text: "Search Console is not connected." }]);
  });

  it("retries a round once when it fails before saying anything, then reports the error", async () => {
    let calls = 0;
    const flaky = (async function* () {
      calls++;
      if (calls === 1) throw new Error("internal error; reference = x");
      yield { type: "text", text: "Recovered." } as ChatEvent;
      yield { type: "finish", reason: "stop" } as ChatEvent;
    }) as unknown as typeof streamChat;
    const turn = await runAssistantTurn({ env: {}, db, site: site("a"), history: [], question: "Hi", emit: () => undefined, chat: flaky });
    assert.equal(calls, 2);
    assert.deepEqual(turn.parts, [{ type: "text", text: "Recovered." }]);

    const broken = (async function* () { throw new Error("down"); }) as unknown as typeof streamChat;
    const failed = await runAssistantTurn({ env: {}, db, site: site("a"), history: [], question: "Hi", emit: () => undefined, chat: broken });
    assert.match(String(failed.error), /down/);
  });
});

describe("blockFrom", () => {
  const rows: Row[] = [{ day: "2026-10-02", views: 5, page: "/b" }, { day: "2026-10-01", views: 9, page: "/a" }];
  const results = new Map([["r1", { resultId: "r1", summary: "", columns: ["day", "views", "page"], rows }]]);
  it("draws only from a known result, known columns, and numbers", () => {
    assert.match(String(blockFrom(results, { resultId: "r9", kind: "bars", label: "page", values: ["views"] })), /no result "r9"/);
    assert.match(String(blockFrom(results, { resultId: "r1", kind: "bars", label: "page", values: ["clicks"] })), /Unknown columns: clicks/);
    assert.match(String(blockFrom(results, { resultId: "r1", kind: "bars", label: "views", values: ["page"] })), /not numbers: page/);
    assert.deepEqual(blockFrom(results, { resultId: "r1", kind: "bars", title: "One page", label: "page", values: ["views"], where: { column: "page", equals: "/A" } }), {
      kind: "bars", title: "One page", label: "page", values: ["views"], rows: [{ page: "/a", views: 9 }],
    });
    assert.match(String(blockFrom(results, { resultId: "r1", kind: "bars", label: "page", values: ["views"], where: { column: "page", equals: "/z" } })), /No rows have page/);
    assert.deepEqual(blockFrom(results, { resultId: "r1", kind: "line", title: "Views", label: "day", values: ["views"] }), {
      kind: "line", title: "Views", label: "day", values: ["views"], rows: [{ day: "2026-10-01", views: 9 }, { day: "2026-10-02", views: 5 }],
    });
  });
});

describe("historyMessages", () => {
  it("replays text and names the blocks an answer drew", () => {
    assert.deepEqual(historyMessages([
      { role: "user", content: { text: "Which pages are empty?" } },
      { role: "assistant", content: { parts: [{ type: "text", text: "Procedures." }, { type: "block", block: { kind: "bars", title: "Empty HTML", values: [], rows: [] } }] } },
    ]), [
      { role: "user", content: "Which pages are empty?" },
      { role: "assistant", content: "Procedures.\n\n[Showed a bars: Empty HTML]" },
    ]);
  });
});
