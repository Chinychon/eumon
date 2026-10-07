import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchSearchDaily, ga4Days, inspectionResult, listGa4Properties } from "./index.js";

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
});
