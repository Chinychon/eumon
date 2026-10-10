import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bingDay, fetchBingCrawlStats, fetchBingTraffic, indexNowKey, submitIndexNow } from "./bing.js";
import { DataForSeoError, fetchBacklinkSummary, fetchLinkGap, fetchSerp, fetchSerpCompetitors } from "./dataforseo.js";

const auth = { login: "me@example.com", password: "secret" };
const envelope = (task: object) => JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.01, ...task }] });
const recorder = (body: string | ((url: string) => Response)) => {
  const asked: Array<{ url: string; body: unknown }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return typeof body === "string" ? new Response(body) : body(url);
  }) as typeof fetch;
  return { asked, fetchFn };
};

describe("DataForSEO search results and backlinks", () => {
  it("reads the domains that rank for a market's keywords", async () => {
    const { asked, fetchFn } = recorder(envelope({ result: [{ items: [{ domain: "www.rival.example", avg_position: 3.4, keywords_count: 12, visibility: 0.31, etv: 840.5 }] }] }));
    const answer = await fetchSerpCompetitors(auth, ["ivf cost", "ivf clinic"], 2360, "id", fetchFn);
    assert.equal(asked[0]!.url, "https://api.dataforseo.com/v3/dataforseo_labs/google/serp_competitors/live");
    assert.deepEqual(asked[0]!.body, [{ keywords: ["ivf cost", "ivf clinic"], location_code: 2360, language_code: "id", item_types: ["organic"], limit: 100, order_by: ["visibility,desc"] }]);
    assert.deepEqual(answer.rows, [{ domain: "rival.example", keywords: 12, avgPosition: 3.4, visibility: 0.31, traffic: 840.5 }]);
  });

  it("reads a results page: features, organic results, the site's place and the AI Overview's sources", async () => {
    const page = {
      item_types: ["ai_overview", "organic", "people_also_ask", "short_videos"],
      items: [
        { type: "ai_overview", rank_group: 1, references: [{ domain: "rival.example" }], items: [{ type: "ai_overview_element", references: [{ domain: "www.x.com" }] }] },
        { type: "organic", rank_group: 1, domain: "rival.example", url: "https://rival.example/ivf", title: "IVF cost" },
        { type: "people_also_ask", rank_group: 1 },
        { type: "organic", rank_group: 2, domain: "www.x.com", url: "https://www.x.com/ivf", title: "IVF at X" },
      ],
    };
    const { asked, fetchFn } = recorder(envelope({ result: [page] }));
    const { row } = await fetchSerp(auth, { keyword: "ivf cost", location: 2360, language: "id", site: "x.com", checkedAt: "2026-10-09", volume: 2400 }, fetchFn);
    assert.equal(asked[0]!.url, "https://api.dataforseo.com/v3/serp/google/organic/live/advanced");
    assert.deepEqual((asked[0]!.body as object[])[0], { keyword: "ivf cost", location_code: 2360, language_code: "id", depth: 10, load_async_ai_overview: true });
    assert.deepEqual(row.features, ["ai_overview", "people_also_ask", "video"]);
    assert.deepEqual([row.position, row.url, row.cited], [2, "https://www.x.com/ivf", true]);
    assert.deepEqual(row.aiOverviewSources, ["rival.example", "x.com"]);
    assert.equal(row.organic.length, 2);
  });

  it("reads link profiles and the link gap, and says when the Backlinks API isn't active", async () => {
    const summary = recorder(envelope({ result: [{ target: "x.com", rank: 212, backlinks: 5400, referring_domains: 140, referring_main_domains: 120, broken_backlinks: 3, backlinks_spam_score: 4 }] }));
    const { row } = await fetchBacklinkSummary(auth, "x.com", summary.fetchFn);
    assert.equal(summary.asked[0]!.url, "https://api.dataforseo.com/v3/backlinks/summary/live");
    assert.deepEqual(row, { domain: "x.com", rank: 212, backlinks: 5400, referringDomains: 140, referringMainDomains: 120, brokenBacklinks: 3, spamScore: 4 });

    const gap = recorder(envelope({ result: [{ items: [{ domain_intersection: { 1: { target: "www.news.example", rank: 300, backlinks: 4 }, 2: { target: "www.news.example", rank: 120, backlinks: 1 } }, summary: { intersections_count: 2 } }] }] }));
    const answer = await fetchLinkGap(auth, ["a.example", "b.example", "c.example", "d.example"], "x.com", gap.fetchFn);
    assert.deepEqual((gap.asked[0]!.body as Array<{ targets: object; exclude_targets: string[] }>)[0]!.targets, { 1: "a.example", 2: "b.example", 3: "c.example" }, "at most three competitors");
    assert.deepEqual(answer.rows, [{ domain: "news.example", rank: 300, backlinks: 5, linksTo: ["a.example", "b.example"] }]);

    const refused = recorder(JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 40204, status_message: "Access denied. Visit Plans and Subscriptions to activate your subscription and get access to this API." }] }));
    await assert.rejects(fetchBacklinkSummary(auth, "x.com", refused.fetchFn), (error: unknown) => error instanceof DataForSeoError && error.code === 40204);
  });
});

describe("Bing Webmaster and IndexNow", () => {
  it("reads Bing's dates in the zone they were written in", () => {
    assert.equal(bingDay("/Date(1316156400000-0700)/"), "2011-09-16");
    assert.equal(bingDay("/Date(1791417600000)/"), "2026-10-08");
    assert.equal(bingDay("2026-10-08"), null);
  });

  it("reads traffic and crawl stats, and passes on Bing's refusal", async () => {
    const { asked, fetchFn } = recorder((url) => new Response(JSON.stringify({ d: url.includes("GetCrawlStats")
      ? [{ __type: "CrawlStats", Date: "/Date(1791417600000)/", CrawledPages: 120, CrawlErrors: 2, InIndex: 400 }]
      : [{ __type: "RankAndTrafficStats", Date: "/Date(1791417600000)/", Clicks: 4, Impressions: 90 }] })));
    assert.deepEqual(await fetchBingTraffic("key", "https://x.com/", fetchFn), [{ day: "2026-10-08", clicks: 4, impressions: 90 }]);
    assert.deepEqual(await fetchBingCrawlStats("key", "https://x.com/", fetchFn), [{ day: "2026-10-08", crawledPages: 120, crawlErrors: 2, inIndex: 400 }]);
    assert.equal(asked[0]!.url, "https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats?siteUrl=https%3A%2F%2Fx.com%2F&apikey=key");
    const refused = recorder(() => new Response(JSON.stringify({ ErrorCode: 14, Message: "NotAuthorized" }), { status: 400 }));
    await assert.rejects(fetchBingTraffic("key", "https://x.com/", refused.fetchFn), /NotAuthorized/);
  });

  it("derives a stable hex key per site and submits changed URLs with the key's location", async () => {
    const key = await indexNowKey("a-secret-that-is-at-least-32-characters", "site_1");
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.equal(key, await indexNowKey("a-secret-that-is-at-least-32-characters", "site_1"));
    assert.notEqual(key, await indexNowKey("a-secret-that-is-at-least-32-characters", "site_2"));
    const { asked, fetchFn } = recorder(() => new Response(null, { status: 202 }));
    const sent = await submitIndexNow({ host: "x.com", key, keyLocation: `https://x.com/guides/${key}.txt`, urls: ["https://x.com/guides/a"] }, fetchFn);
    assert.deepEqual(sent, { status: 202, submitted: 1 });
    assert.deepEqual(asked[0]!.body, { host: "x.com", key, keyLocation: `https://x.com/guides/${key}.txt`, urlList: ["https://x.com/guides/a"] });
    assert.deepEqual(await submitIndexNow({ host: "x.com", key, keyLocation: "", urls: [] }, fetchFn), { status: 200, submitted: 0 }, "nothing to send, nothing sent");
    const refused = recorder(() => new Response(null, { status: 403 }));
    await assert.rejects(submitIndexNow({ host: "x.com", key, keyLocation: "k", urls: ["https://x.com/a"] }, refused.fetchFn), /key file/);
  });
});
