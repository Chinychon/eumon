import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAnalysis, enqueueAnalysisCrawlUrls, getSnapshot, getTopQueriesSnapshot, indexCoverage, urlsToInspect, listMetricSeries, saveCrawlBatch, updateAnalysisStatus, setSiteCompetitorDomains, setSiteMarkets, updateSiteGa4Property, updateSiteGscProperty, upsertSite, getSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { RESULT_METRICS } from "@organic-growth/core";
import { ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE } from "./gsc-auth.ts";
import { syncResults } from "./results-sync.ts";
import { coverageRound, inspectSitemapUrls } from "./url-inspection.ts";

const now = new Date("2026-10-07T04:15:00Z");

async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now.toISOString(), updatedAt: now.toISOString() });
  await updateSiteGscProperty(db, "s", "sc-domain:x.com");
  await updateSiteGa4Property(db, "s", "properties/9");
  return { db, site: (await getSite(db, "s"))! };
}


async function publishPages(db: ReturnType<typeof openSqliteD1>, count: number) {
  const at = now.toISOString();
  await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(at, at).run();
  await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'T', '{}', 'active', ?, ?)`).bind(at, at).run();
  for (let index = 0; index < count; index++) {
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES (?, 's', 't', ?, ?, 'x', '', '{}', 1, '[]', 'published', ?, ?, ?)`).bind(`p${index}`, `/guides/${index}`, String(index), at, at, at).run();
  }
}

describe("results sync", () => {
  it("never asks outside services about the demo site, whose data is seeded", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "site_demo_clinic", name: "Demo", baseUrl: "https://demo-clinic.example", gscProperty: "sc-domain:demo-clinic.example", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const asked: string[] = [];
    const fetchFn = (async (url: string) => { asked.push(url); return new Response("{}"); }) as unknown as typeof fetch;
    const notes = await syncResults(db, (await getSite(db, "site_demo_clinic"))!, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE, ANALYTICS_SCOPE] }), fetchFn },
      { googleApiKey: "g", openPageRankKey: "o", dataForSeo: { login: "l", password: "p" } });
    assert.deepEqual(asked, [], "no Google, CrUX, Open PageRank or DataForSEO calls");
    assert.ok(notes[0]!.startsWith("demo site"));
    assert.equal((await listMetricSeries(db, "site_demo_clinic", ["published_pages"], "2026-10-07", "2026-10-07")).published_pages!.length, 1, "Eumon's own counts still refresh");
  });

  it("keeps first-party points when Google access is revoked", async () => {
    const { db, site: record } = await site();
    const notes = await syncResults(db, record, now, { connect: async () => { throw new Error("Google access token refresh failed (400)."); } });
    assert.ok(notes.some((note) => note.startsWith("google failed")), notes.join("; "));
    const series = await listMetricSeries(db, "s", ["published_pages"], "2026-10-07", "2026-10-07");
    assert.equal(series.published_pages!.length, 1);
  });

  it("skips GA4 without the Analytics scope, and backfills once", async () => {
    const { db, site: record } = await site();
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.includes("urlInspection") ? {} : { rows: [{ keys: ["2026-10-01"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] }));
    }) as typeof fetch;
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn };
    const first = await syncResults(db, record, now, google);
    assert.ok(first.includes("analytics: reconnect Google"));
    assert.equal(urls.some((url) => url.includes("analyticsdata")), false);
    assert.ok(first.some((note) => note.startsWith("search: 486 days")), first.join("; "));
    const second = await syncResults(db, record, now, google);
    assert.ok(second.some((note) => note.startsWith("search: 7 days")), second.join("; "));
    assert.deepEqual((await listMetricSeries(db, "s", ["search_clicks"], "2026-10-01", "2026-10-01")).search_clicks, [{ day: "2026-10-01", value: 1 }]);
  });

  it("backfills target-market history when markets are added after the first sync", async () => {
    const { db, site: record } = await site();
    const rows = { rows: [{ keys: ["2026-10-01"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] };
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn: (async () => new Response(JSON.stringify(rows))) as unknown as typeof fetch };
    await syncResults(db, record, now, google);
    await setSiteMarkets(db, "s", ["mys"]);
    const notes = await syncResults(db, record, now, google);
    assert.ok(notes.includes("markets: 486 days"), notes.join("; "));
  });

  it("inspects pages several at a time", async () => {
    const { db, site: record } = await site();
    await publishPages(db, 12);
    let inFlight = 0;
    let most = 0;
    const fetchFn = (async (url: string) => {
      if (!url.includes("urlInspection")) return new Response(JSON.stringify({ rows: [] }));
      inFlight++; most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS" } } }));
    }) as typeof fetch;
    const notes = await syncResults(db, record, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn });
    assert.ok(notes.includes("inspected 12 pages"), notes.join("; "));
    assert.ok(most > 1 && most <= 10, `at most ${most} inspections in flight`);
  });

  it("leaves a page Google won't inspect for tomorrow and carries on with the rest", async () => {
    const { db, site: record } = await site();
    await publishPages(db, 12);
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const asked = (JSON.parse(String(init?.body ?? "{}")) as { inspectionUrl?: string }).inspectionUrl;
      if (!asked) return new Response(JSON.stringify({ rows: [] }));
      if (asked.endsWith("/guides/3")) return new Response(JSON.stringify({ error: { message: "URL is not part of this property" } }), { status: 403 });
      return new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS" } } }));
    }) as typeof fetch;
    const notes = await syncResults(db, record, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn });
    assert.ok(notes.includes("inspected 11 pages"), notes.join("; "));
    assert.ok(!notes.some((note) => note.startsWith("inspection stopped")), notes.join("; "));
  });

  it("writes only metrics the Performance view reads", async () => {
    const { db, site: record } = await site();
    await setSiteMarkets(db, "s", ["mys"]);
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    await publishPages(db, 2);
    const fetchFn = (async (url: string) => {
      if (url.includes("dataforseo")) return new Response(url.includes("keyword_overview") ? overviewAnswer([]) : rankedAnswer([["kw", 10, 1, 1]]));
      if (url.includes("urlInspection")) return new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS" } } }));
      if (url.includes("chromeuxreport")) return new Response(JSON.stringify({ record: { metrics: { largest_contentful_paint: { percentilesTimeseries: { p75s: [3000] } } }, collectionPeriods: [{ lastDate: { year: 2026, month: 10, day: 3 } }] } }));
      if (url.includes("pagespeedonline")) return new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.5 } } } }));
      if (url.includes("openpagerank")) return new Response(JSON.stringify({ response: [{ status_code: 200, domain: "x.com", page_rank_decimal: 2.5 }, { status_code: 200, domain: "rival.example", page_rank_decimal: 3.1 }] }));
      if (url.includes("analyticsdata")) return new Response(JSON.stringify({ rows: [{ dimensionValues: [{ value: "20261001" }, { value: "Organic Search" }], metricValues: [{ value: "9" }, { value: "4" }, { value: "1" }] }] }));
      return new Response(JSON.stringify({ rows: [{ keys: ["2026-10-01"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] }));
    }) as typeof fetch;
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE, ANALYTICS_SCOPE] }), fetchFn };
    const notes = await syncResults(db, record, now, google, { googleApiKey: "g", openPageRankKey: "o", dataForSeo });
    assert.ok(!notes.some((note) => note.includes("failed")), notes.join("; "));
    const written = (await db.prepare("SELECT DISTINCT metric FROM metric_points WHERE site_id = 's'").all<{ metric: string }>()).results.map((row) => row.metric);
    const declared = new Set([...RESULT_METRICS, ...["authority", "kw_top10", "kw_traffic", "backlinks", "ref_domains", "backlink_rank"].map((metric) => `${metric}:rival.example`)]);
    assert.deepEqual(written.filter((metric) => !declared.has(metric)), [], "every point a sync writes is declared, so the view can read it and a property change can clear it");
    assert.ok(written.length > 20, `a full sync wrote ${written.length} metrics`);
  });

  it("retries lab scores the next day when PageSpeed answered none", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    let pagespeed = 0;
    const fetchFn = (async (url: string) => {
      if (url.includes("pagespeedonline")) { pagespeed++; return new Response("busy", { status: 500 }); }
      if (url.includes("chromeuxreport")) return new Response("{}", { status: 404 });
      return new Response("{}");
    }) as typeof fetch;
    const google = { connect: async () => { throw new Error("not connected"); }, fetchFn };
    const record = (await getSite(db, "s"))!;
    const first = await syncResults(db, record, now, google, { googleApiKey: "g" });
    assert.ok(first.some((note) => note.startsWith("lab failed")), first.join("; "));
    const before = pagespeed;
    await syncResults(db, record, new Date("2026-10-08T04:15:00Z"), google, { googleApiKey: "g" });
    assert.ok(pagespeed > before, "a run that scored nothing is not a run: PageSpeed is asked again the next day");
  });

  const dataForSeo = { login: "me", password: "pw" };
  const rankedAnswer = (rows: Array<[string, number, number, number]>) => JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.0132, result: [{ items_count: rows.length, items: rows.map(([keyword, volume, position, etv]) => ({
    keyword_data: { keyword, keyword_info: { search_volume: volume }, keyword_properties: { keyword_difficulty: 12 }, search_intent_info: { main_intent: "commercial" } },
    ranked_serp_element: { serp_item: { rank_group: position, relative_url: `/${keyword.replace(/ /g, "-")}`, etv } },
  })) }] }] });
  const overviewAnswer = (rows: Array<[string, number]>) => JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.01212, result: [{ items_count: rows.length, items: rows.map(([keyword, volume]) => ({ keyword, keyword_info: { search_volume: volume }, keyword_properties: { keyword_difficulty: 7 }, search_intent_info: { main_intent: "informational" } })) }] }] });

  it("refreshes each keyword list when it is missing or a month old, and only then", async () => {
    const { db, site: record } = await site();
    await setSiteMarkets(db, "s", ["idn", "mmr"]);
    await setSiteCompetitorDomains(db, "s", ["rival.example", "nobody.example"]);
    const asked: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("dataforseo")) {
        const task = (body as Array<Record<string, unknown>>)[0]!;
        // This test is about the keyword lists; search results and backlinks have their own.
        if (url.includes("ranked_keywords") || url.includes("keyword_overview")) asked.push({ url, body: task });
        if (url.includes("keyword_overview")) return new Response(overviewAnswer([["dr amy tan", 320]]));
        if (task.target === "nobody.example") return new Response(rankedAnswer([]));
        if (task.target === "x.com") return new Response(rankedAnswer([["x clinic", 100, 1, 50]]));
        return new Response(rankedAnswer([["veneers price", 3600, 3, 900], ["x clinic", 100, 9, 2]]));
      }
      if (body.dimensions?.join() === "query") return new Response(JSON.stringify({ rows: [{ keys: ["Dr Amy Tan"], clicks: 9, impressions: 300, ctr: 0.03, position: 4 }, { keys: ["ivf penang"], clicks: 2, impressions: 80, ctr: 0.02, position: 12 }] }));
      return new Response(JSON.stringify({ rows: [] }));
    }) as typeof fetch;
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn };

    const notes = await syncResults(db, record, now, google, { dataForSeo });
    assert.ok(notes.includes("competitor keywords: 3 lists fetched, 3 domains in 1 markets, $0.04"), notes.join("; "));
    assert.ok(notes.some((note) => note.startsWith("competitor keywords skipped mmr")), "a market DataForSEO doesn't cover is noted, not fatal");
    assert.ok(notes.includes("keyword volumes: 2 queries listed, 1 priced, $0.01"), notes.join("; "));
    // The site first, then competitors as the database lists them (alphabetically).
    assert.deepEqual(asked.filter((call) => call.url.includes("ranked_keywords")).map((call) => [call.body.target, call.body.location_code]), [["x.com", 2360], ["nobody.example", 2360], ["rival.example", 2360]]);
    assert.deepEqual(asked.find((call) => call.url.includes("keyword_overview"))!.body, { keywords: ["dr amy tan", "ivf penang"], location_code: 2360, language_code: "en" });

    const rival = (await getSnapshot<{ keyword: string }>(db, "s", "competitor_keywords", "rival.example|idn"))!;
    assert.deepEqual(rival.rows.map((row) => row.keyword), ["veneers price", "x clinic"]);
    assert.deepEqual((await getSnapshot(db, "s", "competitor_keywords", "nobody.example|idn"))!.rows, [], "an unknown domain is an empty list, not a failure");
    const priced = (await getSnapshot<{ keyword: string; volume: number | null; position: number }>(db, "s", "keywords", "sc-domain:x.com|idn"))!;
    assert.deepEqual(priced.rows.map((row) => [row.keyword, row.volume, row.position]), [["Dr Amy Tan", 320, 4], ["ivf penang", null, 12]], "every query is kept; unknown ones have no volume");
    const series = await listMetricSeries(db, "s", ["kw_top10", "kw_traffic", "kw_top10:rival.example", "kw_traffic:rival.example", "kw_traffic:nobody.example"], "2026-10-07", "2026-10-07");
    assert.deepEqual([series.kw_top10![0]!.value, series.kw_traffic![0]!.value, series["kw_top10:rival.example"]![0]!.value, series["kw_traffic:rival.example"]![0]!.value, series["kw_traffic:nobody.example"]![0]!.value], [1, 50, 2, 902, 0]);

    // Ten days later nothing is asked: every list is fresh.
    asked.length = 0;
    const rested = await syncResults(db, record, new Date("2026-10-17T04:15:00Z"), google, { dataForSeo });
    assert.equal(asked.length, 0, "fresh lists are not paid for again");
    assert.ok(rested.includes("competitor keywords: lists fresh") && rested.includes("keyword volumes: lists fresh"), rested.join("; "));
    // A competitor added the next day is fetched on the next sync, alone.
    await setSiteCompetitorDomains(db, "s", ["rival.example", "nobody.example", "newcomer.example"]);
    const added = await syncResults(db, record, new Date("2026-10-18T04:15:00Z"), google, { dataForSeo });
    assert.deepEqual(asked.map((call) => call.body.target), ["newcomer.example"], "only the missing list is fetched");
    assert.ok(added.includes("competitor keywords: 1 lists fetched, 4 domains in 1 markets, $0.01"), added.join("; "));
    assert.ok((await listMetricSeries(db, "s", ["kw_traffic:newcomer.example"], "2026-10-18", "2026-10-18"))["kw_traffic:newcomer.example"]!.length, "the trend points are recomputed from every current list");
    // 28 days after the first fetch, the first lists are stale and fetched again; the newcomer's is still fresh.
    asked.length = 0;
    await syncResults(db, record, new Date("2026-11-04T04:15:00Z"), google, { dataForSeo });
    assert.deepEqual(asked.map((call) => call.body.target ?? "prices").sort(), ["nobody.example", "prices", "rival.example", "x.com"]);
  });

  it("prices each market on its own, and leaves a market without queries for the next sync instead of locking it out", async () => {
    const { db, site: record } = await site();
    await setSiteMarkets(db, "s", ["idn", "mys"]);
    let mysQueries: Array<Record<string, unknown>> = [];
    let mysPrices: "ok" | "down" = "ok";
    const overviewCalls: number[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("keyword_overview")) {
        const task = body[0];
        overviewCalls.push(task.location_code);
        if (task.location_code === 2458 && mysPrices === "down") return new Response("down", { status: 500 });
        return new Response(overviewAnswer([[task.keywords[0], 100]]));
      }
      if (url.includes("dataforseo")) return new Response(rankedAnswer([]));
      if (body.dimensions?.join() === "query") return new Response(JSON.stringify({ rows: body.dimensionFilterGroups?.[0]?.filters?.[0]?.expression === "mys" ? mysQueries : [{ keys: ["dentist jakarta"], clicks: 5, impressions: 100, ctr: 0.05, position: 6 }] }));
      return new Response(JSON.stringify({ rows: [] }));
    }) as typeof fetch;
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn };

    const first = await syncResults(db, record, now, google, { dataForSeo });
    assert.ok(first.includes("keyword volumes: 1 queries listed, 1 priced, $0.01"), first.join("; "));
    assert.ok(first.includes("keyword volumes skipped mys: no Search Console queries yet"), first.join("; "));
    assert.deepEqual(overviewCalls, [2360], "no price list is bought for a market with nothing to price");

    // The next day Malaysia has queries, but DataForSEO is down for it: Indonesia's fresh list is left alone, Malaysia is noted and tried again later.
    mysQueries = [{ keys: ["dentist kl"], clicks: 3, impressions: 60, ctr: 0.05, position: 8 }];
    mysPrices = "down";
    const second = await syncResults(db, record, new Date("2026-10-08T04:15:00Z"), google, { dataForSeo });
    assert.deepEqual(overviewCalls, [2360, 2458]);
    assert.ok(second.some((note) => note.startsWith("keyword volumes skipped mys: DataForSEO keyword_overview request failed (500)")), second.join("; "));
    assert.equal(await getSnapshot(db, "s", "keywords", "sc-domain:x.com|mys"), null);
  });

  it("asks for target markets before spending on keywords", async () => {
    const { db, site: record } = await site();
    const notes = await syncResults(db, record, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn: (async () => new Response(JSON.stringify({ rows: [] }))) as unknown as typeof fetch }, { dataForSeo });
    assert.ok(notes.includes("competitor keywords: set target markets in Setup"), notes.join("; "));
    assert.ok(notes.includes("keyword volumes: set target markets in Setup"), notes.join("; "));
  });

  it("keeps the other domains when one DataForSEO call fails", async () => {
    const { db, site: record } = await site();
    await setSiteMarkets(db, "s", ["idn"]);
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (!url.includes("dataforseo")) return new Response(JSON.stringify({ rows: [] }));
      const task = JSON.parse(String(init?.body))[0];
      if (task.target === "rival.example") return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 40000, status_message: "You can set only one task at a time.", result: null }] }));
      return new Response(rankedAnswer([["x clinic", 100, 1, 50]]));
    }) as typeof fetch;
    const notes = await syncResults(db, record, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn }, { dataForSeo });
    assert.ok(notes.includes("competitor keywords: 1 lists fetched, 2 domains in 1 markets, $0.01"), notes.join("; "));
    assert.ok(notes.some((note) => note.startsWith("competitor keywords skipped rival.example in idn: DataForSEO ranked_keywords: You can set only one task")), notes.join("; "));
    assert.ok(await getSnapshot(db, "s", "competitor_keywords", "x.com|idn"));
  });

  it("stops inspecting when Google refuses (quota or permission)", async () => {
    const { db, site: record } = await site();
    await publishPages(db, 30);
    let inspections = 0;
    const fetchFn = (async (url: string) => {
      if (!url.includes("urlInspection")) return new Response(JSON.stringify({ rows: [] }));
      inspections++;
      return new Response("quota", { status: 429 });
    }) as typeof fetch;
    const notes = await syncResults(db, record, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn });
    assert.ok(inspections <= 10, `${inspections} inspections after the first refusal`);
    assert.ok(notes.some((note) => note.startsWith("inspection stopped")), notes.join("; "));
  });

  it("backfills once even when a property has no data yet", async () => {
    const { db, site: record } = await site();
    const fetchFn = (async () => new Response(JSON.stringify({ rows: [] }))) as unknown as typeof fetch;
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE, ANALYTICS_SCOPE] }), fetchFn };
    const first = await syncResults(db, record, now, google);
    assert.ok(first.includes("search: 486 days") && first.includes("analytics: 486 days"), first.join("; "));
    const second = await syncResults(db, record, now, google);
    assert.ok(second.includes("search: 7 days") && second.includes("analytics: 7 days"), second.join("; "));
  });

  it("keeps the top queries of the last 28 finalized days, each beside the 28 before", async () => {
    const { db, site: record } = await site();
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { dimensions?: string[]; startDate?: string; endDate?: string };
      if (body.dimensions?.join() !== "query") return new Response(JSON.stringify({ rows: [] }));
      const window = `${body.startDate}..${body.endDate}`;
      const clicks = window === "2026-09-07..2026-10-04" ? 10 : window === "2026-08-10..2026-09-06" ? 4 : null;
      return new Response(JSON.stringify({ rows: clicks === null ? [] : [{ keys: ["dentist kl"], clicks, impressions: clicks * 20, ctr: 0.05, position: 6 }] }));
    }) as typeof fetch;
    await syncResults(db, record, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn });
    assert.deepEqual(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: [] }), {
      periodEnd: "2026-10-04",
      rows: [{ query: "dentist kl", clicks: 10, impressions: 200, position: 6, before: { clicks: 4, impressions: 80, position: 6 } }],
    });
  });

  it("syncs speed, lab scores, and authority from keys alone, backfilling speed once", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://www.x.com", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    const asked: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${init?.body ?? ""}`);
      if (url.includes("chromeuxreport")) {
        const periods = JSON.parse(String(init?.body)).collectionPeriodCount as number;
        return new Response(JSON.stringify({ record: {
          metrics: { largest_contentful_paint: { percentilesTimeseries: { p75s: Array(periods).fill(3000) } } },
          collectionPeriods: Array.from({ length: periods }, (_, index) => {
            const end = new Date(Date.UTC(2026, 9, 3 - 7 * (periods - 1 - index)));
            return { lastDate: { year: end.getUTCFullYear(), month: end.getUTCMonth() + 1, day: end.getUTCDate() } };
          }),
        } }));
      }
      if (url.includes("pagespeedonline")) return new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.5 } } } }));
      if (url.includes("openpagerank")) return new Response(JSON.stringify({ response: [{ status_code: 200, domain: "x.com", page_rank_decimal: 2.5 }, { status_code: 200, domain: "rival.example", page_rank_decimal: 3.1 }] }));
      return new Response("{}");
    }) as typeof fetch;
    const google = { connect: async () => { throw new Error("not connected"); }, fetchFn };
    const keys = { googleApiKey: "g", openPageRankKey: "o" };
    const record = (await getSite(db, "s"))!;
    const notes = await syncResults(db, record, now, google, keys);
    assert.ok(notes.includes("speed: 40 weeks"), notes.join("; "));
    assert.ok(notes.includes("lab: 2 scores"), notes.join("; "));
    assert.ok(notes.includes("authority: 2 domains"), notes.join("; "));
    assert.ok(asked.some((entry) => entry.includes("chromeuxreport") && entry.includes('"origin":"https://www.x.com"')));
    const series = await listMetricSeries(db, "s", ["crux_lcp_p75.phone", "lab_score_home.phone", "authority", "authority:rival.example"], "2025-01-01", "2026-10-07");
    assert.equal(series["crux_lcp_p75.phone"]!.length, 40);
    assert.deepEqual(series["lab_score_home.phone"], [{ day: "2026-10-07", value: 50 }]);
    assert.deepEqual(series.authority, [{ day: "2026-10-07", value: 2.5 }]);
    assert.deepEqual(series["authority:rival.example"], [{ day: "2026-10-07", value: 3.1 }]);

    // The next day (a Thursday) fetches nothing weekly again.
    asked.length = 0;
    const later = await syncResults(db, record, new Date("2026-10-08T04:15:00Z"), google, keys);
    assert.equal(asked.length, 0, later.join("; "));
  });

  it("notes a missing key instead of failing", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const notes = await syncResults(db, (await getSite(db, "s"))!, now, { connect: async () => { throw new Error("no"); } });
    assert.ok(notes.includes("speed: no Google API key"), notes.join("; "));
    assert.ok(notes.includes("authority: no Open PageRank key"), notes.join("; "));
  });

  it("inspects sitemap URLs 200 at a time and stops when Google refuses", async () => {
    const { db } = await site();
    const at = now.toISOString();
    await createAnalysis(db, { id: "a", siteId: "s", status: "running", createdAt: at });
    const urls = Array.from({ length: 250 }, (_, index) => `https://x.com/doctors/d${index}`);
    await enqueueAnalysisCrawlUrls(db, { analysisId: "a", siteId: "s", urls: urls.map((url) => ({ url, routeFamily: "doctors" })) });
    await saveCrawlBatch(db, { analysisId: "a", outcomes: urls.map((url) => ({ url, page: { url, status: 200, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 1, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: "doctors" } })) });
    await updateAnalysisStatus(db, "a", "completed", { completedAt: at });
    let inspections = 0;
    const fetchFn = (async (url: string) => {
      if (!url.includes("urlInspection")) return new Response(JSON.stringify({ rows: [] }));
      inspections++;
      return inspections > 120
        ? new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 })
        : new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } }));
    }) as typeof fetch;
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn };
    const quick = await syncResults(db, (await getSite(db, "s"))!, now, google);
    assert.ok(quick.includes("coverage: inspected 50"), `"Sync now" checks 50, so the button answers in seconds: ${quick.join("; ")}`);
    await db.prepare("DELETE FROM url_index_status").run();
    inspections = 0;
    const notes = await syncResults(db, (await getSite(db, "s"))!, now, google, {}, 200);
    assert.ok(notes.includes("coverage: inspected 120"), notes.join("; "));
    assert.ok(notes.includes("coverage stopped: Google answered 429"), notes.join("; "));
    assert.ok(inspections <= 130, `stopped within the batch after the refusal (${inspections})`);
    const saved = await db.prepare("SELECT COUNT(*) AS n FROM url_index_status WHERE site_id = 's'").first<{ n: number }>();
    assert.equal(saved?.n, 120, "statuses saved before the refusal are kept");
  });

  it("ends a site's coverage rounds, without throwing, when its Google access is revoked", async () => {
    const { db } = await site();
    const more = await coverageRound(db, "s", "sc-domain:x.com", { connect: async () => { throw new Error("Google access token refresh failed (400)."); } }, "2026-10-07");
    assert.equal(more, false, "the workflow moves on to the next site");
  });

  it("records a URL Google won't inspect, so the queue moves past it", async () => {
    const { db } = await site();
    const at = now.toISOString();
    await createAnalysis(db, { id: "a", siteId: "s", status: "running", createdAt: at });
    const urls = ["https://x.com/doctors/a", "https://x.com/doctors/b", "https://other.x.com/doctors/c"];
    await enqueueAnalysisCrawlUrls(db, { analysisId: "a", siteId: "s", urls: urls.map((url) => ({ url, routeFamily: "doctors" })) });
    await saveCrawlBatch(db, { analysisId: "a", outcomes: urls.map((url) => ({ url, page: { url, status: 200, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 1, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: "doctors" } })) });
    await updateAnalysisStatus(db, "a", "completed", { completedAt: at });
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const asked = JSON.parse(String(init?.body ?? "{}")).inspectionUrl as string;
      if (asked.includes("other.x.com")) return new Response(JSON.stringify({ error: { message: "URL is not part of this property" } }), { status: 403 });
      if (asked.endsWith("/b")) return new Response(JSON.stringify({ error: { message: "Backend error" } }), { status: 500 });
      return new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } }));
    }) as typeof fetch;
    const result = await inspectSitemapUrls(db, "s", "sc-domain:x.com", "t", "2026-10-07", 10, fetchFn);
    assert.equal(result.refused, null, "one URL outside the property is not a refusal for the day");
    const rows = await db.prepare("SELECT url, verdict FROM url_index_status ORDER BY url").all<{ url: string; verdict: string }>();
    assert.deepEqual(Object.fromEntries(rows.results.map((row) => [row.url, row.verdict])), { "https://x.com/doctors/a": "PASS", "https://x.com/doctors/b": "ERROR", "https://other.x.com/doctors/c": "ERROR" });
    assert.deepEqual(await urlsToInspect(db, "s", 10, "2026-09-07"), [], "failed URLs wait 30 days like checked ones");
    const coverage = (await indexCoverage(db, "s", new Date("2026-10-08T00:00:00Z")))!;
    assert.equal(coverage.checked, 1, "a failed inspection isn't counted as checked");
  });

  it("stops for the day when Google refuses every URL in a batch", async () => {
    const { db } = await site();
    const at = now.toISOString();
    await createAnalysis(db, { id: "a", siteId: "s", status: "running", createdAt: at });
    const urls = Array.from({ length: 30 }, (_, index) => `https://x.com/doctors/d${index}`);
    await enqueueAnalysisCrawlUrls(db, { analysisId: "a", siteId: "s", urls: urls.map((url) => ({ url, routeFamily: "doctors" })) });
    await saveCrawlBatch(db, { analysisId: "a", outcomes: urls.map((url) => ({ url, page: { url, status: 200, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 1, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: "doctors" } })) });
    await updateAnalysisStatus(db, "a", "completed", { completedAt: at });
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response(JSON.stringify({ error: { message: "The caller does not have permission" } }), { status: 403 }); }) as unknown as typeof fetch;
    const result = await inspectSitemapUrls(db, "s", "sc-domain:x.com", "t", "2026-10-07", 30, fetchFn);
    assert.equal(result.refused, 403);
    assert.equal(calls, 10, "stopped after the first batch");
    const saved = await db.prepare("SELECT COUNT(*) AS n FROM url_index_status").first<{ n: number }>();
    assert.equal(saved?.n, 0, "a refusal isn't recorded against the URLs");
  });
});

describe("AI referral sessions from GA4", () => {
  it("zeroes an assistant's day when GA4 no longer reports it, so the by-assistant bars match the total", async () => {
    const { db, site: record } = await site();
    let aiRows: Array<Record<string, unknown>> = [{ dimensionValues: [{ value: "20261001" }, { value: "chatgpt.com" }], metricValues: [{ value: "3" }, { value: "1" }] }];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("analyticsdata")) {
        const dims = (body.dimensions as Array<{ name: string }> | undefined)?.map((entry) => entry.name).join() ?? "";
        if (dims.includes("sessionSource")) return new Response(JSON.stringify({ rows: aiRows }));
        return new Response(JSON.stringify({ rows: [{ dimensionValues: [{ value: "20261001" }, { value: "Organic Search" }], metricValues: [{ value: "9" }, { value: "4" }, { value: "1" }] }] }));
      }
      return new Response(JSON.stringify({ rows: [] }));
    }) as typeof fetch;
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE, ANALYTICS_SCOPE] }), fetchFn };
    await syncResults(db, record, now, google);
    const first = await listMetricSeries(db, "s", ["ga4_ai_sessions.chatgpt", "ga4_ai_sessions"], "2026-10-01", "2026-10-01");
    assert.deepEqual([first["ga4_ai_sessions.chatgpt"]![0]!.value, first.ga4_ai_sessions![0]!.value], [3, 3]);
    aiRows = [];
    await syncResults(db, record, now, google);
    const second = await listMetricSeries(db, "s", ["ga4_ai_sessions.chatgpt", "ga4_ai_sessions"], "2026-10-01", "2026-10-01");
    assert.deepEqual([second["ga4_ai_sessions.chatgpt"]![0]!.value, second.ga4_ai_sessions![0]!.value], [0, 0], "a revised day is rewritten per assistant, not only in total");
  });
});
