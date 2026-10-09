import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexNowKey } from "@organic-growth/agents";
import type { PricedKeyword, RankedKeyword, SerpResult } from "@organic-growth/core";
import {
  defaultPageSettings, getSite, getSnapshot, listCrawlLogDays, listMetricSeries, saveSnapshot, setSiteCompetitorDomains, setSiteMarkets, updateSiteGscProperty, upsertPageSettings, upsertSite,
} from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { loadConnectorLists } from "./connectors-data.ts";
import { ingestLog, logToken, readLogBody, tokenMatches } from "./crawl-logs.ts";
import { syncResults } from "./results-sync.ts";

const now = new Date("2026-10-07T04:15:00Z");
const noGoogle = { connect: async () => { throw new Error("not connected"); } };
const dataForSeo = { login: "me", password: "pw" };
const SECRET = "a-session-secret-of-at-least-32-characters";
const ok = (task: object) => new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.01, ...task }] }));

async function site(extra: { markets?: string[]; competitors?: string[] } = {}) {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now.toISOString(), updatedAt: now.toISOString() });
  await updateSiteGscProperty(db, "s", "sc-domain:x.com");
  if (extra.markets) await setSiteMarkets(db, "s", extra.markets);
  if (extra.competitors) await setSiteCompetitorDomains(db, "s", extra.competitors);
  return { db, record: (await getSite(db, "s"))! };
}

const priced = (keyword: string, volume: number, position: number): PricedKeyword => ({ keyword, volume, difficulty: 20, intent: "commercial", position, clicks: 1, impressions: 50 });
const ranked = (keyword: string, volume: number, position: number): RankedKeyword => ({ keyword, volume, difficulty: 20, intent: "commercial", position, url: "/x", traffic: 5 });

/** A DataForSEO stand-in that records each call's endpoint and task. */
function dataForSeoStub(answers: { serp?: (keyword: string) => object; refuseBacklinks?: boolean } = {}) {
  const asked: Array<{ endpoint: string; task: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const task = JSON.parse(String(init?.body ?? "[{}]"))[0] as Record<string, unknown>;
    const endpoint = url.replace("https://api.dataforseo.com/v3/", "").replace(/\/live$/, "");
    asked.push({ endpoint, task });
    if (endpoint.endsWith("serp_competitors")) return ok({ result: [{ items: [{ domain: "www.new-rival.example", avg_position: 3, keywords_count: 9, visibility: 0.4, etv: 500 }] }] });
    if (endpoint.startsWith("serp/")) return ok({ result: [answers.serp?.(String(task.keyword)) ?? { item_types: ["organic"], items: [{ type: "organic", rank_group: 1, domain: "rival.example", url: "https://rival.example/a", title: "A" }] }] });
    if (endpoint.startsWith("backlinks/")) {
      if (answers.refuseBacklinks) return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 40204, status_message: "Access denied." }] }));
      if (endpoint.endsWith("summary")) return ok({ result: [{ rank: task.target === "x.com" ? 100 : 400, backlinks: 900, referring_domains: 60, referring_main_domains: task.target === "x.com" ? 50 : 300 }] });
      return ok({ result: [{ items: [{ domain_intersection: { 1: { target: "news.example", rank: 350, backlinks: 3 } } }] }] });
    }
    return ok({ result: [{ items: [] }] });
  }) as typeof fetch;
  return { asked, fetchFn };
}

describe("search results and search competitors", () => {
  it("finds who ranks for the site's searches and checks their results pages, ten per sync", async () => {
    const { db, record } = await site({ markets: ["idn"], competitors: ["rival.example"] });
    // Lists the keyword sources wrote: 25 priced queries and a competitor's keywords.
    await saveSnapshot(db, "s", { kind: "keywords", scope: "sc-domain:x.com|idn", periodEnd: "2026-10-04", rows: Array.from({ length: 25 }, (_, i) => priced(`q${i}`, 1000 - i, 8)) });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|idn", periodEnd: "2026-10-07", rows: [ranked("veneers price", 5000, 2)] });
    const stub = dataForSeoStub({ serp: (keyword) => keyword === "q0"
      ? { item_types: ["ai_overview", "organic"], items: [{ type: "ai_overview", references: [{ domain: "x.com" }] }, { type: "organic", rank_group: 4, domain: "x.com", url: "https://x.com/q0", title: "Q0" }] }
      : { item_types: ["organic"], items: [] } });
    const google = { ...noGoogle, fetchFn: stub.fetchFn };

    const notes = await syncResults(db, record, now, google, { dataForSeo });
    assert.ok(notes.includes("search competitors: 1 of 1 markets fetched, $0.01"), notes.join("; "));
    const seeds = stub.asked.find((call) => call.endpoint.endsWith("serp_competitors"))!.task;
    assert.equal((seeds.keywords as string[])[0], "q0", "the biggest priced queries seed the search");
    assert.equal(seeds.language_code, "en");
    assert.ok(notes.includes("search results: 10 pages checked, $0.10"), notes.join("; "));
    const pages = stub.asked.filter((call) => call.endpoint.startsWith("serp/")).map((call) => call.task.keyword);
    assert.deepEqual(pages, ["q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9"], "the biggest of the site's queries first, ten per sync");
    const q0 = (await getSnapshot<SerpResult>(db, "s", "serp", "idn"))!.rows.find((row) => row.keyword === "q0")!;
    assert.deepEqual([q0.position, q0.cited, q0.volume], [4, true, 1000]);
    const series = await listMetricSeries(db, "s", ["serp_ai_overviews", "serp_ai_cited"], "2026-10-07", "2026-10-07");
    assert.deepEqual([series.serp_ai_overviews![0]!.value, series.serp_ai_cited![0]!.value], [1, 1]);

    // The next day the next ten (and the competitor's gap) are checked; nothing is fetched twice.
    stub.asked.length = 0;
    await syncResults(db, record, new Date("2026-10-08T04:15:00Z"), google, { dataForSeo });
    const next = stub.asked.filter((call) => call.endpoint.startsWith("serp/")).map((call) => call.task.keyword);
    assert.deepEqual(next, ["q10", "q11", "q12", "q13", "q14", "q15", "q16", "q17", "q18", "q19"]);
    assert.equal(stub.asked.some((call) => call.endpoint.endsWith("serp_competitors")), false, "the competitor list is fresh for a month");
    await syncResults(db, record, new Date("2026-10-09T04:15:00Z"), google, { dataForSeo });
    assert.ok(stub.asked.some((call) => call.task.keyword === "veneers price"), "keyword gaps get their results page too");

    const lists = await loadConnectorLists(db, record, { markets: ["idn"], competitors: ["rival.example"] }, "2026-10-09");
    assert.deepEqual(lists.serp.suggestions.map((entry) => entry.domain), ["new-rival.example"]);
    assert.equal(lists.serp.lists[0]!.rows.length, 21);
    assert.equal((await loadConnectorLists(db, record, { markets: ["mys"], competitors: [] })).serp.lists.length, 0, "another market's lists are hidden");
  });

  it("waits for keyword lists before choosing searches", async () => {
    const { db, record } = await site({ markets: ["idn"] });
    const notes = await syncResults(db, record, now, { ...noGoogle, fetchFn: dataForSeoStub().fetchFn }, { dataForSeo });
    assert.ok(notes.includes("search competitors skipped idn: too few priced keywords yet"), notes.join("; "));
    assert.ok(notes.includes("search results: no searches to check until keyword lists are synced"), notes.join("; "));
  });
});

describe("backlinks", () => {
  it("fetches each domain's profile and the link gap once a month", async () => {
    const { db, record } = await site({ competitors: ["rival.example"] });
    const stub = dataForSeoStub();
    const notes = await syncResults(db, record, now, { ...noGoogle, fetchFn: stub.fetchFn }, { dataForSeo });
    assert.ok(notes.includes("backlinks: 3 of 3 lists fetched, $0.03"), notes.join("; "));
    assert.deepEqual(stub.asked.find((call) => call.endpoint.endsWith("domain_intersection"))!.task.exclude_targets, ["x.com"]);
    const series = await listMetricSeries(db, "s", ["ref_domains", "ref_domains:rival.example"], "2026-10-07", "2026-10-07");
    assert.deepEqual([series.ref_domains![0]!.value, series["ref_domains:rival.example"]![0]!.value], [50, 300]);
    const lists = await loadConnectorLists(db, record, { markets: [], competitors: ["rival.example"] });
    assert.deepEqual(lists.links.gap?.rows.map((row) => row.domain), ["news.example"]);
    assert.equal(lists.links.summaries.length, 2);

    stub.asked.length = 0;
    const again = await syncResults(db, record, new Date("2026-10-20T04:15:00Z"), { ...noGoogle, fetchFn: stub.fetchFn }, { dataForSeo });
    assert.ok(again.includes("backlinks: lists fresh") && !stub.asked.some((call) => call.endpoint.startsWith("backlinks/")), again.join("; "));
  });

  it("says once when the Backlinks API isn't active, without failing the sync", async () => {
    const { db, record } = await site({ competitors: ["rival.example"] });
    const notes = await syncResults(db, record, now, { ...noGoogle, fetchFn: dataForSeoStub({ refuseBacklinks: true }).fetchFn }, { dataForSeo });
    assert.deepEqual(notes.filter((note) => note.startsWith("backlinks")), ["backlinks: the Backlinks API isn't active on this DataForSEO account (app.dataforseo.com → Backlinks API)"]);
  });
});

describe("Bing Webmaster Tools", () => {
  const ms = (day: string) => Date.parse(`${day}T07:00:00Z`);
  const bingFetch = (async (url: string) => new Response(JSON.stringify({ d: url.includes("GetCrawlStats")
    ? [{ Date: `/Date(${ms("2026-10-05")}-0700)/`, CrawledPages: 80, CrawlErrors: 1, InIndex: 300 }]
    : [{ Date: `/Date(${ms("2026-03-01")}-0700)/`, Clicks: 2, Impressions: 40 }, { Date: `/Date(${ms("2026-10-05")}-0700)/`, Clicks: 5, Impressions: 70 }, { Date: `/Date(${ms("2026-10-07")}-0700)/`, Clicks: 1, Impressions: 3 }] }))) as unknown as typeof fetch;

  it("backfills everything Bing keeps the first time, then the last 14 days, and never today", async () => {
    const { db, record } = await site();
    const first = await syncResults(db, record, now, { ...noGoogle, fetchFn: bingFetch }, { bingApiKey: "b" });
    assert.ok(first.includes("bing: 3 days"), first.join("; "));
    const series = await listMetricSeries(db, "s", ["bing_clicks", "bing_in_index"], "2026-01-01", "2026-10-07");
    assert.deepEqual(series.bing_clicks, [{ day: "2026-03-01", value: 2 }, { day: "2026-10-05", value: 5 }], "today is still being counted");
    assert.deepEqual(series.bing_in_index, [{ day: "2026-10-05", value: 300 }]);
    const second = await syncResults(db, record, new Date("2026-10-08T04:15:00Z"), { ...noGoogle, fetchFn: bingFetch }, { bingApiKey: "b" });
    assert.ok(second.includes("bing: 14 days"), second.join("; "));
  });
});

describe("IndexNow", () => {
  async function published(db: ReturnType<typeof openSqliteD1>, path: string, at: string, status = "published") {
    await db.prepare(`INSERT OR IGNORE INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT OR IGNORE INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'T', '{}', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES (?, 's', 't', ?, ?, 'x', '', '{}', 1, '[]', ?, ?, ?, ?)`).bind(path, path, path, status, at, at, at).run();
  }

  it("waits for a verified proxy, then sends every live page once and later only what changed", async () => {
    const { db, record } = await site();
    await published(db, "/guides/a", "2026-10-01T00:00:00Z");
    await published(db, "/guides/old", "2026-10-01T00:00:00Z", "retired");
    const sent: Array<{ host: string; key: string; keyLocation: string; urlList: string[] }> = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return new Response(null, { status: 200 }); }) as typeof fetch;
    const keys = { indexNowSecret: SECRET };
    const waiting = await syncResults(db, record, now, { ...noGoogle, fetchFn }, keys);
    assert.ok(waiting.includes("indexnow: waiting for the proxy to be verified in Setup"), waiting.join("; "));

    await upsertPageSettings(db, { ...defaultPageSettings("s", "X", "https://x.com"), mountPath: "/guides", verifiedAt: "2026-10-06T00:00:00Z" });
    const first = await syncResults(db, record, now, { ...noGoogle, fetchFn }, keys);
    assert.ok(first.includes("indexnow: 1 URLs submitted"), first.join("; "));
    const key = await indexNowKey(SECRET, "s");
    assert.deepEqual(sent[0], { host: "x.com", key, keyLocation: `https://x.com/guides/${key}.txt`, urlList: ["https://x.com/guides/a"] }, "the first submission is every live page; old takedowns aren't news");

    await published(db, "/guides/b", "2026-10-08T09:00:00Z");
    await db.prepare("UPDATE generated_pages SET status = 'unpublished', updated_at = '2026-10-08T10:00:00Z' WHERE path = '/guides/a'").run();
    await syncResults(db, record, new Date("2026-10-08T23:00:00Z"), { ...noGoogle, fetchFn }, keys);
    assert.deepEqual(sent[1]!.urlList.sort(), ["https://x.com/guides/a", "https://x.com/guides/b"], "new pages and takedowns since the last submission");
    const quiet = await syncResults(db, record, new Date("2026-10-10T04:15:00Z"), { ...noGoogle, fetchFn }, keys);
    assert.ok(quiet.includes("indexnow: nothing changed"), quiet.join("; "));
  });
});

describe("server and CDN logs", () => {
  const googlebot = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

  it("checks the site's token, from a bearer header or the address", async () => {
    const token = await logToken(SECRET, "s");
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.ok(await tokenMatches(new Request("https://eumon.example/api/logs/s", { headers: { Authorization: `Bearer ${token}` } }), SECRET, "s"));
    assert.ok(await tokenMatches(new Request(`https://eumon.example/api/logs/s?token=${token}`), SECRET, "s"));
    assert.equal(await tokenMatches(new Request(`https://eumon.example/api/logs/s?token=${token}`), SECRET, "other"), false, "one site's token opens no other");
    assert.equal(await tokenMatches(new Request("https://eumon.example/api/logs/s"), SECRET, "s"), false);
  });

  it("reads gzipped and plain deliveries and stores only crawler requests for the site's host", async () => {
    const { db, record } = await site();
    const lines = [
      JSON.stringify({ ClientRequestHost: "x.com", ClientRequestURI: "/doctors/a", ClientRequestUserAgent: googlebot, EdgeResponseStatus: 200, EdgeStartTimestamp: "2026-10-06T01:00:00Z" }),
      JSON.stringify({ ClientRequestHost: "x.com", ClientRequestURI: "/doctors/a", ClientRequestUserAgent: "Mozilla/5.0 Safari", EdgeResponseStatus: 200, EdgeStartTimestamp: "2026-10-06T01:00:00Z" }),
    ].join("\n");
    const gzipped = new Uint8Array(await new Response(new Blob([lines]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const body = await readLogBody(new Request("https://eumon.example/api/logs/s", { method: "POST", body: gzipped }));
    assert.deepEqual(await ingestLog(db, record, body!), { received: 2, crawler: 1, skipped: 1 });
    assert.equal(await readLogBody(new Request("https://e.example", { method: "POST", body: "x".repeat(100) }), 10), null, "too large");
    assert.deepEqual(await ingestLog(db, record, JSON.stringify({ content: "tests" })), { received: 0, crawler: 0, skipped: 0 }, "Logpush's check delivery is accepted and stores nothing");
    const days = await listCrawlLogDays(db, "s", "2026-10-01");
    assert.deepEqual(days, [{ day: "2026-10-06", bot: "googlebot", family: "doctors", statusClass: "2xx", query: false, hits: 1 }]);

    const notes = await syncResults(db, record, now, noGoogle);
    assert.ok(notes.includes("crawl log: 1 Googlebot and 0 Bingbot requests yesterday"), notes.join("; "));
    const lists = await loadConnectorLists(db, record, { markets: [], competitors: [] }, "2026-10-07");
    assert.equal(lists.crawlLog.length, 1);
  });
});
