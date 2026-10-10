import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_SITE_ID } from "@organic-growth/agents";
import {
  createAnalysis, defaultPageSettings, enqueueAnalysisCrawlUrls, listMetricSeries, listSyncRuns, saveCrawlBatch, setAiPrompts, setLimitOverrides, setSiteCompetitorDomains, setSiteMarkets, setTrackedKeywords,
  updateAnalysisStatus, updateSiteGa4Property, updateSiteGscProperty, upsertPageSettings, upsertSite,
} from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE } from "./gsc-auth.ts";
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

describe("subrequests per step", () => {
  // DataForSEO's envelope around one result.
  const dfs = (result: unknown) => ({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.01, result: [result] }] });
  const queries = Array.from({ length: 40 }, (_, index) => `query ${index}`);
  const answer = (url: string, init?: RequestInit): Response => {
    const { host, pathname } = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (pathname.includes("urlInspection")) return PASS();
    if (host === "api.dataforseo.com") {
      if (pathname.includes("ranked_keywords")) return json(dfs({ items: queries.map((keyword) => ({ keyword_data: { keyword, keyword_info: { search_volume: 100 } }, ranked_serp_element: { serp_item: { rank_group: 5, relative_url: "/", etv: 1 } } })) }));
      if (pathname.includes("keyword_overview")) return json(dfs({ items: body[0].keywords.map((keyword: string) => ({ keyword, keyword_info: { search_volume: 100 } })) }));
      if (pathname.includes("serp/google")) return json(dfs({ item_types: [], items: [] }));
      if (pathname.includes("backlinks/summary")) return json(dfs({ rank: 10, backlinks: 5, referring_domains: 4, referring_main_domains: 4 }));
      if (pathname.includes("backlinks/backlinks")) return json(dfs({ items: Array.from({ length: 50 }, (_, index) => ({ domain_from: `d${index}.com`, url_from: `https://d${index}.com/p`, url_to: "https://s.com/", anchor: "s", dofollow: true, first_seen: "2026-01-01 00:00:00 +00:00", last_seen: "2026-10-01 00:00:00 +00:00", is_lost: false, is_broken: false, domain_from_rank: 100 - index })) }));
      return json(dfs({ items: [] }));
    }
    if (pathname.includes("searchAnalytics")) {
      return json({ rows: body.dimensions[0] === "date" ? [{ keys: ["2026-10-01"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] : queries.map((query) => ({ keys: [query], clicks: 1, impressions: 10, ctr: 0.1, position: 5 })) });
    }
    if (host.includes("pagespeedonline")) return json({ lighthouseResult: { categories: { performance: { score: 0.9 } } } });
    if (host.includes("chromeuxreport")) return json({}, 404);
    if (host.includes("bing")) return json({ d: [] });
    return json({ rows: [], response: [] });
  };

  it("keeps the sources and DataForSEO steps within 50 fetches each on a worst-case Monday, and records the run", async () => {
    const monday = new Date("2026-10-05T04:15:00Z");
    const db = openSqliteD1();
    await addSite(db, "s");
    await updateSiteGa4Property(db, "s", "properties/9");
    await setSiteCompetitorDomains(db, "s", ["a.com", "b.com", "c.com"]);
    await setSiteMarkets(db, "s", ["mys", "sgp"]);
    await upsertPageSettings(db, { ...defaultPageSettings("s", "s.com", "https://s.com"), verifiedAt: at, updatedAt: at });
    await publishPages(db, "s", 1);
    await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', ?)`).bind(at).run();
    await setLimitOverrides(db, "w", { dataForSeo: true });
    await db.prepare("UPDATE sites SET workspace_id = 'w' WHERE id = 's'").run();
    const { steps, step, count } = recorder();
    const fetchFn = (async (url: string, init?: RequestInit) => {
      count();
      return answer(url, init);
    }) as typeof fetch;
    // Connecting costs one token fetch in production.
    const google = () => ({ connect: async () => { await fetchFn("https://oauth2.googleapis.com/token"); return { token: "t", scopes: [SEARCH_CONSOLE_SCOPE, ANALYTICS_SCOPE] }; }, fetchFn });
    const keys = { googleApiKey: "g", openPageRankKey: "o", dataForSeo: { login: "l", password: "p" }, bingApiKey: "b", indexNowSecret: "x".repeat(40) };
    const notes = await syncSite({ db, keys, now: () => monday, google }, step, "s", "daily");
    const fetches = Object.fromEntries(steps.map((entry) => [entry.name, entry.inspections]));
    console.log("fetches per step:", JSON.stringify(fetches));
    for (const [name, made] of Object.entries(fetches)) assert.ok(made <= 50, `${name} made ${made} fetches`);
    assert.ok(fetches["s/sources"]! > 0 && fetches["s/dataforseo"]! > 0, JSON.stringify(fetches));
    assert.ok(notes.some((note) => note.startsWith("speed:")) && notes.some((note) => note.startsWith("search results:")), notes.join("; "));
    assert.ok(notes.some((note) => /^backlinks: \d+ referring domains read/.test(note)), notes.join("; "));
    assert.equal((await listSyncRuns(db, "s")).length, 1);
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
