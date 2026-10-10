import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmHttpError, type JsonLlm } from "@organic-growth/ai";
import type { ContentGradeRow, ContentSkipRow } from "@organic-growth/agents";
import type { SerpResult, TopicProposal } from "@organic-growth/core";
import type { Fetcher, FetchResult } from "@organic-growth/crawler";
import { getSite, getSnapshot, saveRankChecks, saveSnapshot, setLimitOverrides, setSiteMarkets, setTrackedKeywords, upsertSite, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { CONTENT_STEP, contentTargets, gradeContentSteps, gradeSlice, loadContentGrades, loadContentSkips, saveContentGrades } from "./content-grading.ts";
import type { StepLike, StepOptions } from "./sync-steps.ts";

const today = "2026-10-10";
const AT = `${today}T04:00:00.000Z`;
const auth = { login: "me", password: "pw" };

async function setup(keywords: string[], workspace = false) {
  const db = openSqliteD1();
  if (workspace) await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', ?)`).bind(AT).run();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", ...(workspace ? { workspaceId: "w" } : {}), createdAt: AT, updatedAt: AT });
  await setSiteMarkets(db, "s", ["mys"]);
  await setTrackedKeywords(db, "s", keywords);
  // Each keyword ranks 3rd on its own page.
  await saveRankChecks(db, "s", keywords.map((keyword) => ({ keyword, market: "mys", day: "2026-10-09", position: 3, url: `https://x.com/${keyword.replace(/ /g, "-")}`, features: [] })));
  return { db, site: (await getSite(db, "s"))! };
}

const TOP3 = ["https://a.com/lasik", "https://b.com/lasik-guide", "https://c.com/eyes/lasik"];
const serpRow = (keyword: string, checkedAt: string, volume: number | null = null): SerpResult => ({
  keyword, checkedAt, volume, features: [], position: 3, url: null, aiOverviewSources: [], cited: false,
  organic: TOP3.map((url, i) => ({ position: i + 1, domain: new URL(url).hostname, url, title: url })),
});

/** DataForSEO stand-in that answers every search with TOP3 and records what was asked. */
function dataForSeo() {
  const asked: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const task = JSON.parse(String(init?.body))[0] as { keyword: string };
    asked.push(task.keyword);
    const items = TOP3.map((url, i) => ({ type: "organic", rank_group: i + 1, domain: new URL(url).hostname, url, title: "t" }));
    return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.004, result: [{ item_types: ["organic"], items }] }] }));
  }) as typeof fetch;
  return { asked, fetchFn };
}

/* ---------- pages ---------- */

const filler = (n: number) => Array.from({ length: n }, () => "lorem").join(" ");
const html = (headings: string[], text = "", words = 150) =>
  `<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Eye care</h1>${headings.map((h) => `<h2>${h}</h2><p>${filler(15)}</p>`).join("")}<p>${text}</p><p>${filler(words)}</p></main></body></html>`;
const SITE_TEXT = "Most adults over 18 with a stable prescription are good candidates for the procedure.";
const sitePage = { body: html(["Our service", "Who is a good candidate"], SITE_TEXT) };
const PAGES: Record<string, { status?: number; body: string }> = {
  "https://x.com/kw-a": sitePage,
  "https://x.com/kw-b": sitePage,
  "https://x.com/kw-c": sitePage,
  "https://a.com/lasik": { body: html(["Recovery time after LASIK", "LASIK cost in Malaysia", "Who is a good candidate"]) },
  "https://b.com/lasik-guide": { body: html(["Recovery time", "How much does LASIK cost?", "Candidate requirements"]) },
  "https://c.com/eyes/lasik": { body: html(["Recovery", "Cost"]) },
};
const fetcher: Fetcher = async (url): Promise<FetchResult> => {
  const page = PAGES[url];
  return page ? { url, status: page.status ?? 200, finalUrl: url, headers: { "content-type": "text/html" }, body: page.body } : { url, status: 404, finalUrl: url, headers: {}, body: "" };
};
const PROPOSALS: TopicProposal[] = [
  { label: "Good candidates", headings: [{ domain: "a.com", heading: "Who is a good candidate" }, { domain: "b.com", heading: "Candidate requirements" }], covered: true, evidence: "adults over 18 with a stable prescription are good candidates" },
  { label: "Recovery time", headings: [{ domain: "a.com", heading: "Recovery time after LASIK" }, { domain: "b.com", heading: "Recovery time" }], covered: false, evidence: null },
  { label: "Cost", headings: [{ domain: "a.com", heading: "LASIK cost in Malaysia" }, { domain: "b.com", heading: "How much does LASIK cost?" }], covered: false, evidence: null },
];
/** An AI stand-in: `answers[i]` answers the i-th call (a function throws), and it counts calls. */
function fakeLlm(answers: Array<() => unknown> = []): JsonLlm & { calls: number } {
  const model = { model: "fake", calls: 0, json: async <T,>() => (answers[model.calls++] ?? (() => ({ topics: PROPOSALS })))() as T };
  return model;
}
const row = (query: string, checkedAt: string, score = 50): ContentGradeRow => ({ query, market: "mys", page: `https://x.com/${query}`, checkedAt, score } as ContentGradeRow);
const skip = (query: string, checkedAt: string, reason = "the page could not be read"): ContentSkipRow => ({ query, market: "mys", page: `https://x.com/${query}`, checkedAt, reason });

/** A StepLike that runs each step once and records its name, options and output. */
function recorder(): StepLike & { names: string[]; outputs: unknown[]; options: Array<StepOptions | undefined> } {
  const names: string[] = [];
  const outputs: unknown[] = [];
  const options: Array<StepOptions | undefined> = [];
  return {
    names, outputs, options,
    async do<T>(name: string, fn: () => Promise<T>, opts?: StepOptions) {
      names.push(name);
      options.push(opts);
      const out = await fn();
      outputs.push(JSON.parse(JSON.stringify(out ?? null)));
      return out;
    },
  };
}

describe("content targets", () => {
  it("uses a fresh results page from the serp snapshot, and fetches and saves a stale one when DataForSEO is allowed", async () => {
    const { db, site } = await setup(["kw a", "kw b"]);
    await saveSnapshot(db, "s", { kind: "serp", scope: "mys", periodEnd: "2026-09-01", rows: [serpRow("kw a", "2026-09-20"), serpRow("kw b", "2026-09-01", 900)] });
    const stub = dataForSeo();
    const result = await contentTargets(db, site, today, { dataForSeo: auth }, stub.fetchFn);
    assert.deepEqual(stub.asked, ["kw b"], "only the stale page is fetched");
    assert.deepEqual(result.targets.map((t) => t.query).sort(), ["kw a", "kw b"]);
    assert.deepEqual(result.notes, ["content grading: 1 results page fetched, $0.00"], "the DataForSEO spend is noted");
    assert.equal(result.serp["kw a|mys"]!.checkedAt, "2026-09-20");
    assert.equal(result.serp["kw b|mys"]!.checkedAt, today);
    const saved = (await getSnapshot<SerpResult>(db, "s", "serp", "mys"))!;
    assert.deepEqual(saved.rows.map((r) => [r.keyword, r.checkedAt, r.volume]).sort(), [["kw a", "2026-09-20", null], ["kw b", today, 900]], "saved like rank tracking: the list's volume kept");
  });

  it("skips a target with a note when there is no results page and no DataForSEO", async () => {
    const { db, site } = await setup(["kw a"]);
    const result = await contentTargets(db, site, today, {});
    assert.deepEqual(result.targets, []);
    assert.deepEqual(result.notes, ["content grading skipped “kw a”: no results page (track it or add DataForSEO)"]);
  });

  it("leaves out searches graded in the last 28 days", async () => {
    const { db, site } = await setup(["kw a", "kw b"]);
    await saveSnapshot(db, "s", { kind: "serp", scope: "mys", periodEnd: today, rows: [serpRow("kw a", today), serpRow("kw b", today)] });
    await saveContentGrades(db, site, [row("kw a", "2026-10-01T00:00:00.000Z")], today);
    assert.deepEqual((await contentTargets(db, site, today, {})).targets.map((t) => t.query), ["kw b"]);
  });

  it("leaves out searches skipped in the last 7 days", async () => {
    const { db, site } = await setup(["kw a", "kw b"]);
    await saveSnapshot(db, "s", { kind: "serp", scope: "mys", periodEnd: today, rows: [serpRow("kw a", today), serpRow("kw b", today)] });
    await saveContentGrades(db, site, [], today, [skip("kw a", "2026-10-05T00:00:00.000Z")]);
    assert.deepEqual((await contentTargets(db, site, today, {})).targets.map((t) => t.query), ["kw b"]);
  });
});

describe("gradeSlice", () => {
  const serp = { "kw a|mys": serpRow("kw a", today), "kw b|mys": serpRow("kw b", today), "kw c|mys": serpRow("kw c", today) };
  const target = (q: string) => ({ query: q, market: "mys", page: `https://x.com/${q.replace(/ /g, "-")}`, source: "tracked" as const, impressions: null });

  it("grades each target and turns skips into notes", async () => {
    const { db, site } = await setup([]);
    const result = await gradeSlice(db, site, [target("kw a"), target("kw z")], { ...serp, "kw z|mys": serpRow("kw z", today) }, fakeLlm(), fetcher);
    assert.deepEqual(result.rows.map((r) => [r.query, r.covered]), [["kw a", 1]]);
    assert.deepEqual(result.notes, ["content grading skipped “kw z”: the page could not be read"]);
    assert.deepEqual(result.skips.map((s) => [s.query, s.market, s.page, s.reason]), [["kw z", "mys", "https://x.com/kw-z", "the page could not be read"]]);
    assert.equal(result.stop, false);
  });

  it("does not keep a skip that is not the target's fault: no AI model, an AI outage, the allowance", async () => {
    const { db, site } = await setup([], true);
    assert.deepEqual((await gradeSlice(db, site, [target("kw a")], serp, null, fetcher)).skips, []);
    const down = fakeLlm([() => { throw new LlmHttpError("deepseek", 503, "down"); }]);
    const outage = await gradeSlice(db, site, [target("kw a")], serp, down, fetcher);
    assert.deepEqual([outage.notes, outage.skips], [["content grading skipped “kw a”: the AI could not be reached"], []]);
    await setLimitOverrides(db, "w", { aiRunsPerDay: 0 });
    assert.deepEqual((await gradeSlice(db, site, [target("kw a")], serp, fakeLlm(), fetcher)).skips, []);
  });

  it("ends the slice on a setup error with one note, keeping the grades made before it", async () => {
    const { db, site } = await setup([]);
    const llm = fakeLlm([() => ({ topics: PROPOSALS }), () => { throw new LlmHttpError("deepseek", 401, "bad key"); }]);
    const result = await gradeSlice(db, site, [target("kw a"), target("kw b"), target("kw c")], serp, llm, fetcher);
    assert.deepEqual(result.rows.map((r) => r.query), ["kw a"]);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0]!, /^content grading failed: /);
    assert.equal(result.stop, true);
    assert.equal(llm.calls, 2, "kw c is never tried");
  });

  it("spends one AI run per target that reaches the AI, and stops when the allowance is used", async () => {
    const { db, site } = await setup([], true);
    await setLimitOverrides(db, "w", { aiRunsPerDay: 1 });
    const llm = fakeLlm();
    const result = await gradeSlice(db, site, [target("kw z"), target("kw a"), target("kw b")], { ...serp, "kw z|mys": serpRow("kw z", today) }, llm, fetcher);
    assert.deepEqual(result.rows.map((r) => r.query), ["kw a"], "the unreadable page cost nothing, so kw a had the allowance");
    assert.equal(llm.calls, 1);
    assert.equal(result.notes.length, 2);
    assert.match(result.notes[1]!, /^content grading: Your workspace has used today's 1 AI writing runs/);
    assert.equal(result.stop, true);
  });
});

describe("gradeContentSteps", () => {
  const keywords = ["kw 1", "kw 2", "kw 3", "kw 4", "kw 5", "kw 6", "kw 7"];
  const never = (async () => { throw new Error("DataForSEO called"); }) as typeof fetch;
  const deps = (db: D1Like, llm: JsonLlm | null) => ({ db, siteId: "s", now: () => new Date(AT), keys: { dataForSeo: auth }, llm: () => llm, fetcher, fetchFn: never });

  it("spends DataForSEO only where the workspace may: a site on the free limits uses stored pages only", async () => {
    const { db } = await setup(["kw a"]);
    const step = recorder();
    assert.deepEqual(await gradeContentSteps(step, deps(db, null)), ["content grading skipped “kw a”: no results page (track it or add DataForSEO)"]);
    assert.deepEqual(step.names, ["content-targets"]);
  });

  it("grades four targets a step, then saves, with a retry and a 10-minute timeout per grading step", async () => {
    const { db } = await setup(keywords);
    await saveSnapshot(db, "s", { kind: "serp", scope: "mys", periodEnd: today, rows: keywords.map((k) => serpRow(k, today)) });
    const step = recorder();
    const notes = await gradeContentSteps(step, deps(db, null));
    assert.equal(CONTENT_STEP, 4);
    assert.deepEqual(step.names, ["content-targets", "content-grades-1", "content-grades-2", "content-save"]);
    assert.deepEqual([step.outputs[1], step.outputs[2]].map((out) => (out as { notes: string[] }).notes.length), [4, 3]);
    assert.deepEqual(step.options[0], { retries: { limit: 1, delay: 10_000 } });
    assert.deepEqual(step.options[1], { retries: { limit: 1, delay: 10_000 }, timeout: 10 * 60_000 });
    assert.equal(notes.length, 7);
    assert.ok(notes.every((note) => note.endsWith(": no AI model configured")));
    assert.ok(!JSON.stringify(step.outputs).includes("pw"));
  });

  it("stops after a setup error, saving the grades made before it", async () => {
    const { db } = await setup(["kw a", "kw b", "kw c", "kw d", "kw e", "kw f"]);
    await saveSnapshot(db, "s", { kind: "serp", scope: "mys", periodEnd: today, rows: ["kw a", "kw b", "kw c", "kw d", "kw e", "kw f"].map((k) => serpRow(k, today)) });
    const step = recorder();
    const llm = fakeLlm([() => ({ topics: PROPOSALS }), () => { throw new LlmHttpError("deepseek", 403, "forbidden"); }]);
    const notes = await gradeContentSteps(step, deps(db, llm));
    assert.deepEqual(step.names, ["content-targets", "content-grades-1", "content-save"]);
    assert.ok(notes.some((note) => note.startsWith("content grading failed: ")), notes.join("; "));
    assert.equal((await loadContentGrades(db, (await getSite(db, "s"))!)).length, 1);
  });

  it("goes on when a grading step dies, and the demo site is never graded", async () => {
    const { db } = await setup(keywords);
    await saveSnapshot(db, "s", { kind: "serp", scope: "mys", periodEnd: today, rows: keywords.map((k) => serpRow(k, today)) });
    const step = recorder();
    const dying: StepLike = { do: (name, fn, opts) => (name === "content-grades-1" ? Promise.reject(new Error("timed out")) : step.do(name, fn, opts)) };
    const notes = await gradeContentSteps(dying, deps(db, null));
    assert.deepEqual(step.names, ["content-targets", "content-grades-2", "content-save"]);
    assert.ok(notes.includes("content grading failed: timed out"));
    const demo = recorder();
    assert.deepEqual(await gradeContentSteps(demo, { ...deps(db, null), siteId: "site_demo_clinic" }), []);
    assert.deepEqual(demo.names, []);
  });

  it("saves the skips with the grades, so a page that can't be read waits a week", async () => {
    const { db } = await setup(["kw a", "kw b"]);
    await saveSnapshot(db, "s", { kind: "serp", scope: "mys", periodEnd: today, rows: ["kw a", "kw b"].map((k) => serpRow(k, today)) });
    PAGES["https://x.com/kw-b"] = { status: 500, body: "" };
    try {
      await gradeContentSteps(recorder(), deps(db, fakeLlm()));
    } finally {
      PAGES["https://x.com/kw-b"] = sitePage;
    }
    const site = (await getSite(db, "s"))!;
    assert.deepEqual((await loadContentGrades(db, site)).map((r) => r.query), ["kw a"]);
    assert.deepEqual((await loadContentSkips(db, site)).map((r) => [r.query, r.reason]), [["kw b", "the page could not be read"]]);
  });
});

describe("saveContentGrades", () => {
  it("replaces rows for the same search, keeps the others, and drops rows older than 90 days", async () => {
    const { db, site } = await setup([]);
    await saveContentGrades(db, site, [row("kw a", "2026-09-01T00:00:00.000Z", 40), row("kw b", "2026-09-01T00:00:00.000Z"), row("kw old", "2026-07-01T00:00:00.000Z")], "2026-09-01");
    await saveContentGrades(db, site, [row("KW A", `${today}T00:00:00.000Z`, 80)], today);
    const saved = await loadContentGrades(db, site);
    assert.deepEqual(saved.map((r) => [r.query, r.score]), [["KW A", 80], ["kw b", 50]]);
    const snapshot = (await getSnapshot<ContentGradeRow>(db, "s", "content_grades", "x.com"))!;
    assert.equal(snapshot.periodEnd, today);
  });

  it("keeps the latest skip per search in content_skips, and drops skips older than 90 days", async () => {
    const { db, site } = await setup([]);
    await saveContentGrades(db, site, [], "2026-09-01", [skip("kw a", "2026-09-01T00:00:00.000Z", "old reason"), skip("kw b", "2026-09-01T00:00:00.000Z"), skip("kw old", "2026-07-01T00:00:00.000Z")]);
    await saveContentGrades(db, site, [row("kw b", `${today}T00:00:00.000Z`)], today, [skip("KW A", `${today}T00:00:00.000Z`, "new reason")]);
    assert.deepEqual((await loadContentSkips(db, site)).map((r) => [r.query, r.reason]), [["KW A", "new reason"], ["kw b", "the page could not be read"]]);
    assert.equal((await getSnapshot<ContentSkipRow>(db, "s", "content_skips", "x.com"))!.periodEnd, today);
  });
});
