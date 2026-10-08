import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAnalysis, enqueueAnalysisCrawlUrls, getTopQueriesSnapshot, listMetricSeries, saveCrawlBatch, updateAnalysisStatus, setSiteCompetitorDomains, setSiteMarkets, updateSiteGa4Property, updateSiteGscProperty, upsertSite, getSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE } from "./gsc-auth.ts";
import { syncResults } from "./results-sync.ts";

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
    const notes = await syncResults(db, (await getSite(db, "s"))!, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn });
    assert.ok(notes.includes("coverage: inspected 120"), notes.join("; "));
    assert.ok(notes.includes("coverage stopped: Google answered 429"), notes.join("; "));
    assert.ok(inspections <= 130, `stopped within the batch after the refusal (${inspections})`);
    const saved = await db.prepare("SELECT COUNT(*) AS n FROM url_index_status WHERE site_id = 's'").first<{ n: number }>();
    assert.equal(saved?.n, 120, "statuses saved before the refusal are kept");
  });
});
