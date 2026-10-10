import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, isProblemNote } from "@organic-growth/core";
import { getSite, listAiAnswerChecks, listMetricSeries, saveAiAnswerChecks, setAiBrandNames, setAiPrompts, setSiteCompetitorDomains, setSiteMarkets, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { aiQueue, checkAiAnswers, writeAiCounts, AI_CHECKS_PER_DAY, type AiTarget } from "./ai-answers.ts";

const today = "2026-10-07";
const at = `${today}T04:15:00.000Z`;
const auth = { login: "me", password: "pw" };
const ENGINES = ["chatgpt", "gemini", "ai_mode", "perplexity"] as const;

async function site(markets: string[], prompts: string[]) {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "Bright Smile", baseUrl: "https://brightsmile.example", createdAt: at, updatedAt: at });
  await setSiteMarkets(db, "s", markets);
  await setAiPrompts(db, "s", prompts);
  await setAiBrandNames(db, "s", ["Bright Smile"]);
  await setSiteCompetitorDomains(db, "s", ["rival.example"]);
  return { db, record: (await getSite(db, "s"))! };
}

const check = (prompt: string, engine: AiTarget["engine"], day: string, answered = true) => ({ prompt, market: "mys", engine, day, answered, mentioned: false, cited: false, citedRank: null, sources: [], rivals: [], excerpt: "" });
const ok = (result: unknown) => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.01, result: [result] }] }));

/** DataForSEO stand-in answering by URL: ChatGPT names the brand and a rival, AI Mode cites the site, Perplexity and Gemini say nothing; `refuses` names an engine path that answers 40501, `empty` one that answers with nothing. */
function stub(refuses?: string, empty?: string) {
  let inFlight = 0;
  const seen = { most: 0, urls: [] as string[] };
  const fetchFn = (async (url: string) => {
    seen.urls.push(url);
    seen.most = Math.max(seen.most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      if (refuses && url.includes(refuses)) return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 40501, status_message: "Invalid Field: 'location_code'." }] }));
      if (empty && url.includes(empty)) return ok({ markdown: "", sources: [] });
      if (url.includes("chat_gpt")) return ok({ markdown: "Try Bright Smile, or rival.example.", sources: [{ domain: "wiki.example", url: "https://wiki.example/a" }] });
      if (url.includes("ai_mode")) return ok({ items: [{ text: "Plenty of clinics.", references: [{ domain: "brightsmile.example", url: "https://brightsmile.example/x" }] }] });
      if (url.includes("perplexity")) return ok({ items: [{ sections: [{ text: "Nobody in particular.", annotations: [] }] }] });
      return ok({ markdown: "Nobody in particular.", sources: [] });
    } finally { inFlight--; }
  }) as typeof fetch;
  return { seen, fetchFn };
}

const cells = (prompts: string[], market = "mys"): AiTarget[] => prompts.flatMap((prompt) => ENGINES.map((engine) => ({ prompt, market, engine })));

describe("AI answer steps", () => {
  it("queues every prompt × covered market × engine, oldest first, at most 40 a day, and skips an uncovered market with a note", async () => {
    const prompts = Array.from({ length: 12 }, (_, index) => `question ${index}`);
    const { db, record } = await site(["mys", "mmr"], prompts);
    await saveAiAnswerChecks(db, "s", [check("question 0", "gemini", "2026-10-04")]);
    const queue = await aiQueue(db, record, today);
    assert.equal(queue.targets.length, AI_CHECKS_PER_DAY);
    assert.ok(queue.targets.every((target) => target.market === "mys"));
    assert.ok(queue.notes.some((note) => note.includes("mmr")), queue.notes.join("; "));
    assert.ok(!queue.targets.some((target) => target.prompt === "question 0" && target.engine === "gemini"), "a 3-day-old check is not due");

    const week = await site(["mys"], ["q"]);
    await saveAiAnswerChecks(week.db, "s", [check("q", "gemini", "2026-10-04"), check("q", "chatgpt", "2026-09-30")]);
    const due = (await aiQueue(week.db, week.record, today)).targets.map((target) => target.engine);
    assert.deepEqual(due, ["ai_mode", "perplexity", "chatgpt"], "never-checked first, then the 7-day-old; the 3-day-old waits");
  });

  it("checks done this week aren't asked again", async () => {
    const { db, record } = await site(["mys"], ["q1", "q2"]);
    const queue = await aiQueue(db, record, today);
    assert.equal(queue.targets.length, 8);
    await checkAiAnswers(db, record, auth, today, queue.targets.slice(0, 4), stub().fetchFn);
    const after = (await aiQueue(db, record, today)).targets;
    assert.equal(after.length, 4);
    for (const done of queue.targets.slice(0, 4)) assert.ok(!after.some((target) => target.prompt === done.prompt && target.engine === done.engine));
  });

  it("checks a slice ten at a time, reads each answer, saves the rows", async () => {
    const { db, record } = await site(["mys"], ["q1", "q2", "q3", "q4", "q5"]);
    const { seen, fetchFn } = stub();
    const result = await checkAiAnswers(db, record, auth, today, cells(["q1", "q2", "q3", "q4", "q5"]), fetchFn);
    assert.equal(result.checked, 20);
    assert.deepEqual(result.notes, []);
    assert.equal(seen.urls.length, 20);
    assert.equal(seen.most, 10);
    const rows = await listAiAnswerChecks(db, "s", today);
    assert.equal(rows.length, 20);
    for (const row of rows) {
      assert.equal(row.mentioned, row.engine === "chatgpt", `${row.engine} mentioned`);
      assert.equal(row.cited, row.engine === "ai_mode", `${row.engine} cited`);
      assert.deepEqual(row.rivals, row.engine === "chatgpt" ? [{ domain: "rival.example", mentioned: true, cited: false }] : []);
    }
  });

  it("a refused engine is a problem note and an unanswered attempt; the rest are answered", async () => {
    const { db, record } = await site(["mys"], ["q1"]);
    const result = await checkAiAnswers(db, record, auth, today, cells(["q1"]), stub("gemini").fetchFn);
    assert.equal(result.checked, 3);
    assert.equal(result.notes.length, 1);
    assert.ok(result.notes[0]!.startsWith("ai answers refused on Gemini for “q1” in mys: "), result.notes[0]);
    assert.ok(isProblemNote(result.notes[0]!));
    assert.deepEqual((await listAiAnswerChecks(db, "s", today)).map((row) => row.engine).sort(), ["ai_mode", "chatgpt", "perplexity"]);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM ai_answer_checks WHERE answered = 0 AND engine = 'gemini'").first<{ n: number }>())!.n, 1);
  });

  it("an empty answer is a note and an unanswered attempt; the rest are answered", async () => {
    const { db, record } = await site(["mys"], ["q1"]);
    const result = await checkAiAnswers(db, record, auth, today, cells(["q1"]), stub(undefined, "gemini").fetchFn);
    assert.equal(result.checked, 3);
    assert.deepEqual(result.notes, ["ai answers: Gemini gave no answer to “q1” in mys"]);
    assert.deepEqual((await listAiAnswerChecks(db, "s", today)).map((row) => row.engine).sort(), ["ai_mode", "chatgpt", "perplexity"]);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM ai_answer_checks WHERE answered = 0 AND engine = 'gemini'").first<{ n: number }>())!.n, 1);
  });

  it("a refused cell is asked again after 2 days, not before", async () => {
    const { db, record } = await site(["mys"], ["q1"]);
    await checkAiAnswers(db, record, auth, today, cells(["q1"]), stub("gemini").fetchFn);
    const due = async (day: string) => (await aiQueue(db, record, day)).targets.map((target) => target.engine);
    assert.deepEqual(await due(today), []);
    assert.deepEqual(await due(addDays(today, 1)), []);
    assert.deepEqual(await due(addDays(today, 2)), ["gemini"]);
    assert.deepEqual(await due(addDays(today, 7)), ENGINES.slice(), "answered cells come due again after 7 days");
  });

  it("today's cap counts the attempts already made today, answered or not", async () => {
    const prompts = Array.from({ length: 12 }, (_, index) => `question ${index}`);
    const { db, record } = await site(["mys"], prompts);
    await saveAiAnswerChecks(db, "s", cells(prompts).slice(0, 30).map((target, index) => check(target.prompt, target.engine, today, index % 2 === 0)));
    assert.equal((await aiQueue(db, record, today)).targets.length, AI_CHECKS_PER_DAY - 30);
    await saveAiAnswerChecks(db, "s", cells(prompts).slice(30, 40).map((target) => check(target.prompt, target.engine, today, false)));
    assert.deepEqual((await aiQueue(db, record, today)).targets, [], "a manual sync after the daily run asks nothing more");
  });

  it("an engine that always refuses and one that always answers empty don't starve the others", async () => {
    const prompts = Array.from({ length: 25 }, (_, index) => `question ${index}`);
    const { db, record } = await site(["mys"], prompts);
    const { fetchFn } = stub("gemini", "ai_mode");
    for (let offset = 0; offset < 21; offset++) {
      const day = addDays(today, offset);
      const { targets } = await aiQueue(db, record, day);
      assert.ok(targets.length <= AI_CHECKS_PER_DAY);
      await checkAiAnswers(db, record, auth, day, targets, fetchFn);
    }
    const answered = await listAiAnswerChecks(db, "s", today);
    for (const engine of ["chatgpt", "perplexity"] as const) {
      const rows = answered.filter((row) => row.engine === engine);
      assert.deepEqual(new Set(rows.map((row) => row.prompt)), new Set(prompts), `every question answered by ${engine}`);
      for (const prompt of prompts) {
        const days = rows.filter((row) => row.prompt === prompt).map((row) => row.day);
        assert.ok(days.length >= 2, `${engine} “${prompt}” asked again: ${days.join(", ")}`);
        for (let index = 1; index < days.length; index++) assert.ok(days[index]! >= addDays(days[index - 1]!, 7), `${engine} “${prompt}” not asked again within 7 days: ${days.join(", ")}`);
      }
    }
    assert.ok(answered.filter((row) => row.engine === "chatgpt").length >= 50);
  });

  it("the site's name isn't a brand name unless the user enters it", async () => {
    const { db } = await site(["mys"], ["q1"]);
    await upsertSite(db, { id: "s", name: "website", baseUrl: "https://brightsmile.example", createdAt: at, updatedAt: at });
    await setAiBrandNames(db, "s", []);
    const fetchFn = (async () => ok({ markdown: "For braces, visit their website.", sources: [] })) as unknown as typeof fetch;
    await checkAiAnswers(db, (await getSite(db, "s"))!, auth, today, [{ prompt: "q1", market: "mys", engine: "chatgpt" }], fetchFn);
    const [row] = await listAiAnswerChecks(db, "s", today);
    assert.equal(row?.mentioned, false);
  });

  it("writes the counts and the marker, and prunes", async () => {
    const { db, record } = await site(["mys"], ["q1"]);
    await saveAiAnswerChecks(db, "s", [check("q1", "chatgpt", "2020-01-01")]);
    await checkAiAnswers(db, record, auth, today, cells(["q1"]), stub().fetchFn);
    await writeAiCounts(db, record, today);
    const series = await listMetricSeries(db, "s", ["sync.ai_answers", "ai_answers_checked", "ai_answers_mentioned", "ai_answers_cited", "ai_answers_mentioned:rival.example"], today, today);
    const value = (metric: string) => series[metric]?.[0]?.value;
    assert.equal(value("ai_answers_checked"), 4);
    assert.equal(value("ai_answers_mentioned"), 1);
    assert.equal(value("ai_answers_cited"), 1);
    assert.equal(value("ai_answers_mentioned:rival.example"), 1);
    assert.ok((value("sync.ai_answers") ?? 0) > 0);
    assert.equal((await listAiAnswerChecks(db, "s", "2000-01-01")).some((row) => row.day === "2020-01-01"), false, "a check older than 400 days is pruned");
  });
});
