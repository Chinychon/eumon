import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_SITE_ID } from "@organic-growth/agents";
import { createAnalysis, enqueueAnalysisCrawlUrls, listMetricSeries, listSyncRuns, saveCrawlBatch, setAiPrompts, setLimitOverrides, setSiteMarkets, setTrackedKeywords, updateAnalysisStatus, updateSiteGscProperty, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { SEARCH_CONSOLE_SCOPE } from "./gsc-auth.ts";
import { pacificDayStart, startDailySyncs, startSync, syncSite, type StepLike, type SyncDeps } from "./sync-steps.ts";

const now = new Date("2026-10-07T04:15:00Z");
const today = "2026-10-07";
const at = now.toISOString();

async function addSite(db: ReturnType<typeof openSqliteD1>, id: string, property = `sc-domain:${id}.com`) {
  await upsertSite(db, { id, name: `${id}.com`, baseUrl: `https://${id}.com`, createdAt: at, updatedAt: at });
  if (property) await updateSiteGscProperty(db, id, property);
}

async function publishPages(db: ReturnType<typeof openSqliteD1>, siteId: string, count: number) {
  await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES (?, ?, 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(`d-${siteId}`, siteId, at, at).run();
  await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES (?, ?, ?, 'T', '{}', 'active', ?, ?)`).bind(`t-${siteId}`, siteId, `d-${siteId}`, at, at).run();
  for (let index = 0; index < count; index++) {
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'x', '', '{}', 1, '[]', 'published', ?, ?, ?)`).bind(`p-${siteId}-${index}`, siteId, `t-${siteId}`, `/guides/${index}`, String(index), at, at, at).run();
  }
}

async function crawl(db: ReturnType<typeof openSqliteD1>, siteId: string, count: number) {
  const id = `a-${siteId}`;
  await createAnalysis(db, { id, siteId, status: "running", createdAt: at });
  const urls = Array.from({ length: count }, (_, index) => `https://${siteId}.com/doctors/d${index}`);
  await enqueueAnalysisCrawlUrls(db, { analysisId: id, siteId, urls: urls.map((url) => ({ url, routeFamily: "doctors" })) });
  await saveCrawlBatch(db, { analysisId: id, outcomes: urls.map((url) => ({ url, page: {
    url, status: 200, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1, isEmptyShell: false, headingOutline: [], internalLinkCount: 0,
    rawTextLength: 500, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot" as const, routeFamily: "doctors",
  } })) });
  await updateAnalysisStatus(db, id, "completed", { completedAt: at });
}

/** Inspections already spent today on this property, as rows checked earlier in the same Pacific day. */
async function spendQuota(db: ReturnType<typeof openSqliteD1>, siteId: string, count: number) {
  await db.prepare(
    `INSERT INTO url_index_status (site_id, url, family, verdict, coverage_state, last_crawl_time, checked_at)
     SELECT ?, 'https://' || ? || '.com/old/' || value, 'old', 'PASS', NULL, NULL, '2026-10-07T03:00:00.000Z' FROM json_each(?)`,
  ).bind(siteId, siteId, JSON.stringify(Array.from({ length: count }, (_, index) => index))).run();
}

/** A step runner that remembers every step and how many inspections it asked for; `dies` names a step that fails after its retries. */
function recorder(dies?: string) {
  const steps: Array<{ name: string; inspections: number }> = [];
  let current: { name: string; inspections: number } | null = null;
  const step: StepLike = {
    do: async (name, fn) => {
      current = { name, inspections: 0 };
      steps.push(current);
      try {
        if (name === dies) throw new Error("boom");
        return await fn();
      } finally { current = null; }
    },
  };
  return { steps, step, count: () => { if (current) current.inspections++; }, total: () => steps.reduce((sum, entry) => sum + entry.inspections, 0) };
}

const PASS = () => new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } }));
const asked = (init?: RequestInit) => (JSON.parse(String(init?.body ?? "{}")) as { inspectionUrl?: string }).inspectionUrl;

function deps(db: ReturnType<typeof openSqliteD1>, count: () => void, answer: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>, extra: Partial<SyncDeps> = {}): SyncDeps {
  let n = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (!url.includes("urlInspection")) return new Response(JSON.stringify({ rows: [] }));
    count();
    return answer(url, init, ++n);
  }) as typeof fetch;
  return { db, keys: {}, now: () => now, google: () => ({ connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn }), ...extra };
}

describe("sync steps", () => {
  it("asks Google at most 40 times a step: 100 Eumon pages, then 47 coverage steps from one queue, within the day's quota", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 130);
    await crawl(db, "s", 2000);
    const { steps, step, count, total } = recorder();
    const notes = await syncSite(deps(db, count, PASS), step, "s", "daily");
    assert.ok(steps.every((entry) => entry.inspections <= 40), `most inspections in a step: ${Math.max(...steps.map((entry) => entry.inspections))}`);
    assert.ok(notes.includes("inspected 100 pages"), notes.join("; "));
    assert.ok(notes.includes("coverage: inspected 1,880 in 47 steps"), notes.join("; "));
    assert.equal(total(), 1980, "under the 2,000-a-day quota");
    assert.equal(steps.filter((entry) => entry.name.startsWith("s/pages-")).length, 3);
    assert.equal(steps.filter((entry) => entry.name === "s/coverage-queue").length, 1, "the queue is read once, not once a step");
    assert.equal(steps.filter((entry) => /^s\/coverage-\d+$/.test(entry.name)).length, 47);
    assert.deepEqual((await listMetricSeries(db, "s", ["pages_indexed"], today, today)).pages_indexed, [{ day: today, value: 100 }]);
    const runs = await listSyncRuns(db, "s");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.trigger, "daily");
    assert.deepEqual(runs[0]!.notes, notes);
  });

  it("records a page Google fails on, so it is not asked again today, and never runs more than three page steps", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 130);
    const { steps, step, count, total } = recorder();
    let failures = 0;
    const notes = await syncSite(deps(db, count, (_url, init) => {
      if (asked(init)?.endsWith("/guides/3")) { failures++; return new Response("{}", { status: 500 }); }
      return PASS();
    }), step, "s", "daily");
    assert.equal(steps.filter((entry) => entry.name.startsWith("s/pages-")).length, 3, "the cap, not the loop, ends the page steps");
    assert.equal(failures, 1, "a failed page is recorded as checked today and not asked again");
    assert.equal(total(), 100);
    assert.ok(notes.includes("inspected 99 pages"), notes.join("; "));
    assert.deepEqual((await listMetricSeries(db, "s", ["pages_indexed"], today, today)).pages_indexed, [{ day: today, value: 99 }]);
  });

  it("stops the day at a refusal, quota or a whole batch refused, and keeps the statuses saved before it", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 30);
    await crawl(db, "s", 250);
    const { steps, step, count, total } = recorder();
    const notes = await syncSite(deps(db, count, (_url, _init, n) => (n > 120 ? new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 }) : PASS())), step, "s", "daily");
    assert.ok(notes.includes("inspected 30 pages"), notes.join("; "));
    assert.ok(notes.includes("coverage: inspected 90 in 3 steps"), notes.join("; "));
    assert.ok(notes.includes("coverage stopped: Google answered 429"), notes.join("; "));
    assert.ok(!steps.some((entry) => entry.name === "s/coverage-4"), "no step after the refusal");
    assert.ok(total() <= 130, "stopped within the batch after the refusal");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM url_index_status WHERE site_id = 's'").first<{ n: number }>())?.n, 90);

    const forbidden = openSqliteD1();
    await addSite(forbidden, "s");
    await crawl(forbidden, "s", 100);
    const second = recorder();
    const refused = await syncSite(deps(forbidden, second.count, () => new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403 })), second.step, "s", "daily");
    assert.ok(refused.includes("coverage stopped: Google answered 403"), refused.join("; "));
    assert.equal(second.total(), 10, "one batch, all refused, ends the day");
  });

  it("spends only what is left of the property's 2,000 for the Pacific day", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 130);
    await crawl(db, "s", 500);
    await spendQuota(db, "s", 1950);
    const { steps, step, count, total } = recorder();
    const notes = await syncSite(deps(db, count, PASS), step, "s", "manual");
    assert.equal(total(), 50, "1,950 were spent earlier today");
    assert.ok(notes.some((note) => /1,950/.test(note)), notes.join("; "));
    assert.ok(notes.includes("inspected 50 pages"), notes.join("; "));
    assert.equal(steps.filter((entry) => /^s\/coverage-\d+$/.test(entry.name)).length, 0, "nothing left for coverage");
  });

  it("inspects ten at a time", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 12);
    let inFlight = 0;
    let most = 0;
    const { step, count } = recorder();
    const notes = await syncSite(deps(db, count, async () => {
      inFlight++; most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight--;
      return PASS();
    }), step, "s", "manual");
    assert.ok(most > 1 && most <= 10, `at most ${most} in flight`);
    assert.ok(notes.includes("inspected 12 pages"), notes.join("; "));
  });

  it("records the run with a note, and no inspection steps, when Google access is revoked", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 5);
    const { steps, step } = recorder();
    const revoked: SyncDeps = { db, keys: {}, now: () => now, google: () => ({ connect: async () => { throw new Error("Google access token refresh failed (400)."); } }) };
    const notes = await syncSite(revoked, step, "s", "daily");
    assert.ok(notes.some((note) => note.startsWith("google failed")), notes.join("; "));
    assert.deepEqual(steps.map((entry) => entry.name), ["s/start", "s/sources", "s/record"]);
    assert.equal((await listSyncRuns(db, "s")).length, 1);
  });

  it("turns a step that dies after its retries into a note, and carries on", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 5);
    await crawl(db, "s", 50);
    const { steps, step, count } = recorder("s/index-counts");
    const notes = await syncSite(deps(db, count, PASS), step, "s", "daily");
    assert.ok(notes.some((note) => note.startsWith("index counts failed: boom")), notes.join("; "));
    assert.ok(notes.includes("coverage: inspected 50 in 2 steps"), notes.join("; "));
    assert.ok(steps.some((entry) => entry.name === "s/record"));
    assert.equal((await listSyncRuns(db, "s")).length, 1);
  });

  it("syncs the generated pages' search data first, when the site has pages, and notes a failure", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await publishPages(db, "s", 2);
    await addSite(db, "b");
    const seen: string[] = [];
    const { step, count } = recorder();
    const fine = await syncSite(deps(db, count, PASS, { pageSearch: async (site) => { seen.push(site.id); return { queries: 3 }; } }), step, "s", "daily");
    assert.equal(fine[0], "pages: 3 query rows", fine.join("; "));
    const failing = await syncSite(deps(db, count, PASS, { pageSearch: async () => { throw new Error("nope"); } }), recorder().step, "s", "daily");
    assert.ok(failing.some((note) => note === "pages failed: nope"), failing.join("; "));
    await syncSite(deps(db, count, PASS, { pageSearch: async (site) => { seen.push(site.id); return { queries: 1 }; } }), recorder().step, "b", "daily");
    assert.deepEqual(seen, ["s"], "a site without generated pages has nothing to sync");
  });

  it("never asks Google about the demo, whose data is seeded", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: DEMO_SITE_ID, name: "Demo", baseUrl: "https://demo-clinic.example", gscProperty: "sc-domain:demo-clinic.example", createdAt: at, updatedAt: at });
    const { step, count, total } = recorder();
    const notes = await syncSite(deps(db, count, PASS), step, DEMO_SITE_ID, "manual");
    assert.equal(total(), 0);
    assert.ok(notes[0]!.startsWith("demo site"), notes.join("; "));
  });
});

describe("pacificDayStart", () => {
  it("is midnight in Los Angeles, in summer and winter, for the day the instant falls on there", () => {
    assert.equal(pacificDayStart(new Date("2026-07-15T12:00:00Z")).toISOString(), "2026-07-15T07:00:00.000Z");
    assert.equal(pacificDayStart(new Date("2026-01-15T12:00:00Z")).toISOString(), "2026-01-15T08:00:00.000Z");
    assert.equal(pacificDayStart(new Date("2026-07-15T05:00:00Z")).toISOString(), "2026-07-14T07:00:00.000Z", "22:00 the evening before, Pacific time");
  });
});

describe("startSync and startDailySyncs", () => {
  type Created = { id: string; params: unknown };
  function workflow(running: Record<string, string> = {}) {
    const created: Created[] = [];
    return {
      created,
      binding: {
        create: async (options: Created) => {
          if (created.some((entry) => entry.id === options.id) || running[options.id]) throw new Error(`instance.already_exists: ${options.id}`);
          created.push(options);
          return { id: options.id };
        },
        get: async (id: string) => {
          if (!created.some((entry) => entry.id === id) && !running[id]) throw new Error("instance.not_found");
          return { status: async () => ({ status: running[id] ?? "complete" }) };
        },
      },
    };
  }

  it("gives a manual sync one id per site per ten minutes, so a second click joins the first run", async () => {
    const { binding, created } = workflow();
    const first = await startSync({ SEARCH_SYNC_WORKFLOW: binding }, { siteId: "s", trigger: "manual" }, now);
    const again = await startSync({ SEARCH_SYNC_WORKFLOW: binding }, { siteId: "s", trigger: "manual" }, new Date(now.getTime() + 3 * 60_000));
    assert.equal(first.created, true);
    assert.deepEqual([again.id, again.created, again.startedAt], [first.id, false, first.startedAt], "the same run; the dashboard waits for its record");
    assert.match(first.id, /^manual-s-\d+$/);
    assert.ok(first.startedAt <= at, "the window's start, so the run's record counts as after it");
    assert.deepEqual(created[0]!.params, { siteId: "s", trigger: "manual" });
    const later = await startSync({ SEARCH_SYNC_WORKFLOW: binding }, { siteId: "s", trigger: "manual" }, new Date(now.getTime() + 11 * 60_000));
    assert.notEqual(later.id, first.id);
  });

  it("refuses a manual sync while the day's daily run for the site is going", async () => {
    const { binding } = workflow({ "daily-2026-10-07-s": "running" });
    const result = await startSync({ SEARCH_SYNC_WORKFLOW: binding }, { siteId: "s", trigger: "manual" }, now);
    assert.deepEqual([result.created, result.running], [false, "daily-2026-10-07-s"]);
  });

  it("starts one daily instance per site, named after the day and the site, and tolerates ones that exist", async () => {
    const db = openSqliteD1();
    await addSite(db, "s");
    await addSite(db, "b", "");
    const { binding, created } = workflow();
    assert.deepEqual(await startDailySyncs({ DB: db, SEARCH_SYNC_WORKFLOW: binding }, now), ["daily-2026-10-07-b", "daily-2026-10-07-s"]);
    assert.deepEqual(created.map((entry) => entry.params), [{ siteId: "b", trigger: "daily" }, { siteId: "s", trigger: "daily" }]);
    assert.deepEqual(await startDailySyncs({ DB: db, SEARCH_SYNC_WORKFLOW: binding }, now), [], "a second firing the same day creates nothing");
    const broken = { create: async () => { throw new Error("binding unavailable"); }, get: async () => { throw new Error("instance.not_found"); } };
    await assert.rejects(() => startSync({ SEARCH_SYNC_WORKFLOW: broken }, { siteId: "s", trigger: "manual" }, now), /binding unavailable/);
  });

  /** A site in a workspace that may spend DataForSEO, tracking `keywords` in `markets`; `run` syncs it and counts SERP fetches. */
  async function rankSite(markets: string[], keywords: number, dies?: string) {
    const db = openSqliteD1();
    await addSite(db, "s", "");
    await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', ?)`).bind(at).run();
    await setLimitOverrides(db, "w", { dataForSeo: true });
    await db.prepare("UPDATE sites SET workspace_id = 'w' WHERE id = 's'").run();
    await setSiteMarkets(db, "s", markets);
    await setTrackedKeywords(db, "s", Array.from({ length: keywords }, (_, index) => `kw ${index}`));
    const serps = { count: 0, ai: 0 };
    const fetchFn = (async (url: string) => {
      if (url.includes("ai_optimization") || url.includes("ai_mode")) {
        serps.ai++;
        return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.01, result: [{ markdown: "text", sources: [], items: [{ type: "message", markdown: "text", sections: [{ type: "text", text: "text" }] }] }] }] }));
      }
      if (!url.includes("/serp/")) return new Response(JSON.stringify({ rows: [] }));
      serps.count++;
      return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.004, result: [{ item_types: ["organic"], items: [{ type: "organic", rank_group: 1, domain: "s.com", url: "https://s.com/p", title: "t" }] }] }] }));
    }) as typeof fetch;
    const { steps, step, count } = recorder(dies);
    const keys = { dataForSeo: { login: "me", password: "pw" } };
    const run = () => syncSite(deps(db, count, PASS, { keys, google: () => ({ connect: async () => ({ token: "t", scopes: [] }), fetchFn }) }), step, "s", "daily");
    return { db, steps, serps, run };
  }

  it("checks tracked keywords 40 a step when the workspace may spend DataForSEO, and spends nothing on a second run the same day", async () => {
    const { steps, run, serps } = await rankSite(["mys"], 41);
    let notes = await run();
    assert.ok(notes.includes("ranks: 41 checked in 2 steps, $0.16"), notes.join("; "));
    assert.equal(steps.filter((entry) => /^s\/ranks-\d+$/.test(entry.name)).length, 2);
    assert.equal(serps.count, 41);
    notes = await run();
    assert.equal(serps.count, 41, "a pair already checked today is not asked again");
    assert.ok(!notes.some((note) => note.startsWith("ranks:")), notes.join("; "));
  });

  it("checks AI answers weekly when the workspace may spend DataForSEO, and fetches nothing more on a second run the same day", async () => {
    const { db, steps, run, serps } = await rankSite(["mys"], 0);
    await setAiPrompts(db, "s", ["best clinic", "cheap clinic"]);
    const before = serps.ai;
    await run();
    const names = steps.map((entry) => entry.name);
    assert.ok(names.includes("s/ai-queue"), names.join(", "));
    assert.equal(names.filter((name) => /^s\/ai-\d+$/.test(name)).length, 1);
    assert.ok(names.includes("s/ai-counts"));
    assert.equal(serps.ai - before, 8);
    await run();
    assert.equal(serps.ai - before, 8, "cells checked this week are not asked again");
  });

  it("goes on to the next slice when a rank step dies", async () => {
    const { steps, run } = await rankSite(["mys", "sgp"], 2, "s/ranks-1");
    const notes = await run();
    assert.ok(notes.includes("ranks failed: boom"), notes.join("; "));
    assert.ok(steps.some((entry) => entry.name === "s/ranks-2"), "the second market's slice still runs");
    assert.ok(notes.includes("ranks: 2 checked in 1 step, $0.01"), notes.join("; "));
  });

  it("goes on to the next market's AI slice when an AI step dies", async () => {
    const { db, steps, run } = await rankSite(["mys", "sgp"], 0, "s/ai-1");
    await setAiPrompts(db, "s", ["best clinic", "cheap clinic"]);
    const notes = await run();
    assert.ok(notes.includes("ai answers failed: boom"), notes.join("; "));
    assert.ok(steps.some((entry) => entry.name === "s/ai-2"), "the second market's slice still runs");
    assert.ok(notes.includes("ai answers: 8 checked in 1 step, $0.08"), notes.join("; "));
    assert.ok(steps.some((entry) => entry.name === "s/ai-counts"));
  });

  it("skips ranks with a note, and still records the run, when reading the workspace's limits dies", async () => {
    const { db, steps, serps, run } = await rankSite(["mys"], 2, "s/dataforseo-limits");
    const notes = await run();
    assert.ok(notes.includes("dataforseo limits failed: boom"), notes.join("; "));
    assert.equal(serps.count, 0);
    assert.ok(steps.some((entry) => entry.name === "s/record"));
    assert.equal((await listSyncRuns(db, "s")).length, 1);
  });

  it("does not check ranks for a site without the DataForSEO feature", async () => {
    const db = openSqliteD1();
    await addSite(db, "s", "");
    await setSiteMarkets(db, "s", ["mys"]);
    await setTrackedKeywords(db, "s", ["kw"]);
    const { steps, step, count } = recorder();
    await syncSite(deps(db, count, PASS, { keys: { dataForSeo: { login: "me", password: "pw" } } }), step, "s", "daily");
    assert.ok(!steps.some((entry) => /^s\/ranks-(queue|\d+)$/.test(entry.name)), "FREE_LIMITS has dataForSeo: false; a site without a workspace follows it");
  });
});
