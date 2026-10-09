import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchGa4AiReferrals, fetchSearchDaily, ga4AiPoints, ga4Days, inspectionResult, listGa4Properties } from "./index.js";

/** A fetch that records requests and answers with a fixed JSON body. */
function recorded(body: unknown) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe("Google clients", () => {
  it("asks Search Console for daily rows, filtered by page and country, and keeps position as a weight", async () => {
    const { fetchFn, requests } = recorded({ rows: [{ keys: ["2026-10-01"], clicks: 3, impressions: 100, ctr: 0.03, position: 7.5 }] });
    const rows = await fetchSearchDaily("t", "sc-domain:x.com", { startDate: "2026-09-01", endDate: "2026-10-06", pageContains: "https://x.com/guides/", country: "mys" }, fetchFn);
    assert.deepEqual(rows, [{ day: "2026-10-01", clicks: 3, impressions: 100, positionWeight: 750 }]);
    const sent = requests[0]!.body as { dimensions: string[]; dataState: string; dimensionFilterGroups: Array<{ filters: Array<{ dimension: string; expression: string }> }> };
    assert.deepEqual(sent.dimensions, ["date"]);
    assert.equal(sent.dataState, "all", "fresh days are included and overwritten later");
    assert.deepEqual(sent.dimensionFilterGroups[0]!.filters.map((filter) => [filter.dimension, filter.expression]), [["page", "https://x.com/guides/"], ["country", "mys"]]);
  });

  it("asks GA4 for sessions by source filtered to AI assistants, and folds them per assistant", async () => {
    const { fetchFn, requests } = recorded({ rows: [
      { dimensionValues: [{ value: "20261001" }, { value: "chatgpt.com" }], metricValues: [{ value: "5" }, { value: "1" }] },
      { dimensionValues: [{ value: "20261001" }, { value: "chat.openai.com" }], metricValues: [{ value: "2" }, { value: "0" }] },
      { dimensionValues: [{ value: "20261001" }, { value: "perplexity.ai" }], metricValues: [{ value: "3" }, { value: "2" }] },
      { dimensionValues: [{ value: "20261002" }, { value: "news.ycombinator.com" }], metricValues: [{ value: "9" }, { value: "0" }] },
    ] });
    const days = await fetchGa4AiReferrals("t", "properties/1", "2026-09-01", "2026-10-06", fetchFn);
    assert.deepEqual(days, [
      { day: "2026-10-01", assistant: "chatgpt", sessions: 7, keyEvents: 1 },
      { day: "2026-10-01", assistant: "perplexity", sessions: 3, keyEvents: 2 },
    ]);
    const sent = requests[0]!.body as { dimensions: Array<{ name: string }>; dimensionFilter: { filter: { fieldName: string; stringFilter: { matchType: string; value: string } } } };
    assert.deepEqual(sent.dimensions.map((dimension) => dimension.name), ["date", "sessionSource"]);
    assert.equal(sent.dimensionFilter.filter.stringFilter.matchType, "PARTIAL_REGEXP");
    assert.match("chatgpt.com", new RegExp(sent.dimensionFilter.filter.stringFilter.value));
    const points = ga4AiPoints(days);
    assert.deepEqual(points.filter((point) => point.metric === "ga4_ai_sessions"), [{ metric: "ga4_ai_sessions", day: "2026-10-01", value: 10 }]);
    assert.deepEqual(points.find((point) => point.metric === "ga4_ai_key_events"), { metric: "ga4_ai_key_events", day: "2026-10-01", value: 3 });
  });

  it("reads an inspection verdict, and treats a missing index result as not checked", () => {
    assert.deepEqual(inspectionResult({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T03:00:00Z" } } }),
      { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T03:00:00Z" });
    assert.deepEqual(inspectionResult({}), { verdict: "VERDICT_UNSPECIFIED", coverageState: null, lastCrawlTime: null });
  });

  it("lists GA4 properties with their account, and folds a report into days", async () => {
    const { fetchFn } = recorded({ accountSummaries: [{ displayName: "Clinic", propertySummaries: [{ property: "properties/9", displayName: "Website" }] }] });
    assert.deepEqual(await listGa4Properties("t", fetchFn), [{ property: "properties/9", name: "Clinic · Website" }]);
    const report = { rows: [
      { dimensionValues: [{ value: "20261001" }, { value: "Organic Search" }], metricValues: [{ value: "40" }, { value: "30" }, { value: "4" }] },
      { dimensionValues: [{ value: "20261001" }, { value: "Direct" }], metricValues: [{ value: "60" }, { value: "20" }, { value: "2" }] },
    ] };
    assert.deepEqual(ga4Days(report), [{ day: "2026-10-01", sessions: 100, organicSessions: 40, organicEngagedSessions: 30, organicKeyEvents: 4 }]);
  });

  it("lists GA4 properties across every page of accounts", async () => {
    const pages = [
      { accountSummaries: [{ displayName: "A", propertySummaries: [{ property: "properties/1", displayName: "One" }] }], nextPageToken: "p2" },
      { accountSummaries: [{ displayName: "B", propertySummaries: [{ property: "properties/2", displayName: "Two" }] }] },
    ];
    const urls: string[] = [];
    const fetchFn = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(pages[urls.length - 1])); }) as typeof fetch;
    assert.deepEqual((await listGa4Properties("t", fetchFn)).map((entry) => entry.property), ["properties/1", "properties/2"]);
    assert.ok(urls[1]!.includes("pageToken=p2"));
  });

  it("says why Google refused, so a disabled API can be fixed", async () => {
    const body = { error: { code: 403, message: "Google Analytics Admin API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED" } };
    const fetchFn = (async () => new Response(JSON.stringify(body), { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(listGa4Properties("t", fetchFn), /Admin API has not been used in project 1 before or it is disabled/);
  });
});
