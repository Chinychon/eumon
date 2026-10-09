import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linksView, referringDomainGap, type BacklinkSummary } from "./links.js";
import { METRICS, resultsView } from "./results.js";
import { competitorKind, serpCrowding, serpLookup, serpView, suggestCompetitors, type SerpResult } from "./serp.js";
import { aggregateHits, crawlLogView, logBot, parseLogBody } from "./server-logs.js";

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BINGBOT = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
const PERSON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";

describe("server logs", () => {
  it("reads Cloudflare Logpush, Vercel drain, generic and combined lines", () => {
    const body = [
      JSON.stringify({ ClientRequestHost: "www.x.com", ClientRequestURI: "/doctors/a?ref=1", ClientRequestUserAgent: GOOGLEBOT, EdgeResponseStatus: 200, EdgeStartTimestamp: "2026-10-08T01:02:03Z" }),
      JSON.stringify({ source: "static", timestamp: 1, proxy: { timestamp: 1791418923000, host: "x.com", path: "/treatments/b", userAgent: [BINGBOT], statusCode: 404 } }),
      JSON.stringify({ source: "build", message: "Build completed" }),
      JSON.stringify({ time: 1791418923, host: "x.com", url: "https://x.com/blog/c", status: 301, ua: "GPTBot/1.2" }),
      `66.249.66.1 - - [08/Oct/2026:13:55:36 +0800] "GET /clinics/d HTTP/1.1" 503 512 "-" "${GOOGLEBOT}"`,
      "garbage line",
    ].join("\n");
    const hits = parseLogBody(body);
    assert.equal(hits.length, 4, "the build log and the garbage line are skipped");
    assert.deepEqual(hits[0], { time: "2026-10-08T01:02:03.000Z", host: "www.x.com", path: "/doctors/a?ref=1", status: 200, userAgent: GOOGLEBOT });
    assert.equal(hits[1]!.status, 404);
    assert.equal(hits[2]!.path, "/blog/c");
    assert.equal(hits[3]!.time, "2026-10-08T05:55:36.000Z", "the zone offset is applied");
  });

  it("reads a Vercel JSON array, and Unix nanoseconds", () => {
    const hits = parseLogBody(JSON.stringify([{ proxy: { timestamp: 1791418923000, host: "x.com", path: "/a", userAgent: [GOOGLEBOT], statusCode: 200 } }, { proxy: { timestamp: 1791418923000, host: "x.com", path: "/b", userAgent: [GOOGLEBOT], statusCode: -1 } }]));
    assert.equal(hits.length, 1, "a background revalidation (-1) is no response");
    assert.equal(parseLogBody(JSON.stringify({ ClientRequestURI: "/a", ClientRequestUserAgent: GOOGLEBOT, EdgeResponseStatus: 200, EdgeStartTimestamp: 1791418923000000000 }))[0]!.time.slice(0, 10), "2026-10-08");
  });

  it("names crawlers and leaves people out", () => {
    assert.deepEqual(logBot(GOOGLEBOT), { bot: "googlebot", group: "google" });
    assert.deepEqual(logBot(BINGBOT), { bot: "bingbot", group: "bing" });
    assert.deepEqual(logBot("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)"), { bot: "ClaudeBot", group: "ai" });
    assert.deepEqual(logBot("AhrefsBot/7.0"), { bot: "other", group: "other" });
    assert.equal(logBot(PERSON), null);
  });

  it("sums crawler requests per day, bot, page type and status, and keeps the latest per path", () => {
    const hit = (path: string, ua: string, time: string, status = 200, host: string | null = "x.com") => ({ time, host, path, status, userAgent: ua });
    const result = aggregateHits([
      hit("/doctors/a", GOOGLEBOT, "2026-10-08T01:00:00Z"),
      hit("/doctors/a", GOOGLEBOT, "2026-10-08T05:00:00Z", 500),
      hit("/doctors/b?x=1", GOOGLEBOT, "2026-10-08T02:00:00Z"),
      hit("/doctors/a", PERSON, "2026-10-08T03:00:00Z"),
      hit("/doctors/a", GOOGLEBOT, "2026-10-08T04:00:00Z", 200, "preview.x.dev"),
      hit("/blog/c", "GPTBot/1.2", "2026-10-09T01:00:00Z"),
    ], { host: "www.x.com", familyOf: (path) => path.split("/")[1] ?? "home" });
    assert.equal(result.crawler, 4);
    assert.equal(result.skipped, 2, "a person and another host");
    assert.deepEqual(result.days.find((row) => row.statusClass === "5xx"), { day: "2026-10-08", bot: "googlebot", family: "doctors", statusClass: "5xx", query: false, hits: 1 });
    assert.equal(result.days.find((row) => row.query)?.hits, 1);
    const a = result.paths.find((row) => row.path === "/doctors/a")!;
    assert.deepEqual([a.hits, a.lastStatus, a.lastSeen], [2, 500, "2026-10-08T05:00:00Z"]);
    assert.equal(result.paths.some((row) => row.path === "/blog/c"), false, "AI agents are counted, not tracked per path");
  });

  it("builds the card from day rows: 28 days to yesterday, weeks, page types, waste", () => {
    const view = crawlLogView([
      { day: "2026-09-28", bot: "googlebot", family: "doctors", statusClass: "2xx", query: false, hits: 70 },
      { day: "2026-10-05", bot: "googlebot", family: "doctors", statusClass: "4xx", query: false, hits: 10 },
      { day: "2026-10-06", bot: "googlebot", family: "search", statusClass: "2xx", query: true, hits: 20 },
      { day: "2026-10-06", bot: "bingbot", family: "doctors", statusClass: "2xx", query: false, hits: 5 },
      { day: "2026-10-06", bot: "GPTBot", family: "blog", statusClass: "2xx", query: false, hits: 3 },
      { day: "2026-10-09", bot: "googlebot", family: "doctors", statusClass: "2xx", query: false, hits: 999 },
    ], "2026-10-09");
    assert.deepEqual(view.totals, { googlebot: 100, bingbot: 5, ai: 3, other: 0 }, "today is left out");
    assert.deepEqual(view.families[0], { family: "doctors", hits: 80, errors: 10, redirects: 0 });
    assert.equal(view.parameterHits, 20);
    assert.deepEqual(view.weeks.map((week) => [week.week, week.googlebot]), [["2026-09-28", 70], ["2026-10-05", 1029]]);
    assert.equal(view.weeks[1]!.partial, true);
  });
});

const serp = (keyword: string, extra: Partial<SerpResult> = {}): SerpResult => ({
  keyword, checkedAt: "2026-10-09", volume: 1000, features: [], position: null, url: null, aiOverviewSources: [], cited: false,
  organic: [{ position: 1, domain: "rival.example", url: "https://rival.example/a", title: "A" }], ...extra,
});

describe("search results", () => {
  it("suggests the domains that win the searches, without the site, known rivals or platforms", () => {
    const suggestions = suggestCompetitors([
      { market: "idn", rows: [
        { domain: "www.x.com", keywords: 30, avgPosition: 8, visibility: 0.2, traffic: 100 },
        { domain: "youtube.com", keywords: 40, avgPosition: 3, visibility: 0.5, traffic: 900 },
        { domain: "rival.example", keywords: 20, avgPosition: 4, visibility: 0.3, traffic: 400 },
        { domain: "new-rival.example", keywords: 12, avgPosition: 5, visibility: 0.1, traffic: 300 },
        { domain: "alodokter.com", keywords: 25, avgPosition: 2, visibility: 0.4, traffic: 800 },
        { domain: "once.example", keywords: 1, avgPosition: 1, visibility: 0.9, traffic: 50 },
      ] },
      { market: "mys", rows: [{ domain: "new-rival.example", keywords: 5, avgPosition: 3, visibility: 0.35, traffic: 100 }] },
    ], "x.com", ["rival.example"]);
    assert.deepEqual(suggestions.map((entry) => [entry.domain, entry.kind]), [["new-rival.example", "competitor"], ["alodokter.com", "directory"]]);
    assert.deepEqual(suggestions[0]!.markets, ["idn", "mys"]);
    assert.equal(suggestions[0]!.avgPosition, 3);
    assert.equal(competitorKind("en.wikipedia.org"), "platform");
  });

  it("counts result types and AI Overview citations, and words what crowds a result", () => {
    const view = serpView([{ market: "idn", periodEnd: "2026-10-09", rows: [
      serp("ivf cost", { features: ["ai_overview", "local_pack"], cited: true, volume: 2400 }),
      serp("ivf clinic", { features: ["ai_overview"] }),
      serp("ivf", { features: ["people_also_ask"], volume: null }),
    ] }], []);
    assert.equal(view.checked, 3);
    assert.deepEqual(view.aiOverview, { searches: 2, citesYou: 1 });
    assert.deepEqual(view.features.map((entry) => [entry.feature, entry.searches]), [["ai_overview", 2], ["local_pack", 1], ["people_also_ask", 1]]);
    assert.equal(view.rows[0]!.keyword, "ivf cost");
    assert.equal(serpCrowding(view.rows[0]!), "an AI Overview and a map pack");
    assert.equal(serpCrowding(serp("x")), null);
    assert.equal(serpLookup([{ rows: view.rows }])("IVF Cost")?.volume, 2400);
  });
});

describe("backlinks", () => {
  const summary = (domain: string, referringMainDomains: number): BacklinkSummary => ({ domain, rank: 300, backlinks: referringMainDomains * 10, referringDomains: referringMainDomains, referringMainDomains, brokenBacklinks: 0, spamScore: 2 });
  const input = {
    site: "x.com", competitors: ["a.example", "b.example"], synced: true,
    summaries: [{ periodEnd: "2026-10-05", row: summary("x.com", 40) }, { periodEnd: "2026-10-05", row: summary("a.example", 300) }],
    gap: { periodEnd: "2026-10-06", rows: [{ domain: "weak.example", rank: 50, backlinks: 2, linksTo: ["a.example", "b.example"] }, { domain: "strong.example", rank: 400, backlinks: 9, linksTo: ["a.example", "b.example"] }] },
  };

  it("lines up each domain's profile and sorts the gap by rank", () => {
    const view = linksView(input);
    assert.equal(view.asOf, "2026-10-06");
    assert.deepEqual(view.domains.map((entry) => [entry.domain, entry.summary?.referringMainDomains ?? null]), [["x.com", 40], ["a.example", 300], ["b.example", null]]);
    assert.equal(view.gap![0]!.domain, "strong.example");
    assert.deepEqual(referringDomainGap(input), { leader: "a.example", theirs: 300, yours: 40 });
  });

  it("puts the new metric groups in the view, empty until synced", () => {
    assert.ok(METRICS.backlinks.includes("ref_domains") && METRICS.bing.includes("bing_clicks") && METRICS.indexnow.includes("indexnow_submitted"));
    const empty = resultsView({ today: "2026-10-09", goLive: null, markets: [], series: {}, index: { indexed: 0, notIndexed: 0, unchecked: 0 }, published: 0, searchConnected: false, ga4Connected: false });
    assert.equal(empty.bing, null);
    assert.equal(empty.indexNow, null);
    assert.equal(empty.crawlLog, null);
    assert.equal(empty.serp.checked, 0);
    assert.equal(empty.links.synced, false);
    const bing = resultsView({
      today: "2026-10-09", goLive: null, markets: [], index: { indexed: 0, notIndexed: 0, unchecked: 0 }, published: 0, searchConnected: false, ga4Connected: false,
      series: { "sync.bing": [{ day: "2026-10-09", value: 3 }], bing_clicks: [{ day: "2026-10-01", value: 7 }, { day: "2026-10-02", value: 5 }], bing_in_index: [{ day: "2026-10-08", value: 420 }] },
    });
    assert.equal(bing.bing!.clicks.current, 12);
    assert.equal(bing.bing!.inIndex, 420);
  });
});
