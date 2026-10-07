import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listMetricSeries, updateSiteGa4Property, updateSiteGscProperty, upsertSite, getSite } from "@organic-growth/db";
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

describe("results sync", () => {
  it("keeps first-party points when Google access is revoked", async () => {
    const { db, site: record } = await site();
    const notes = await syncResults(db, record, now, { token: async () => { throw new Error("Google access token refresh failed (400)."); }, scopes: [SEARCH_CONSOLE_SCOPE, ANALYTICS_SCOPE] });
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
    const google = { token: async () => "t", scopes: [SEARCH_CONSOLE_SCOPE], fetchFn };
    const first = await syncResults(db, record, now, google);
    assert.ok(first.includes("analytics: reconnect Google"));
    assert.equal(urls.some((url) => url.includes("analyticsdata")), false);
    assert.ok(first.some((note) => note.startsWith("search: 486 days")), first.join("; "));
    const second = await syncResults(db, record, now, google);
    assert.ok(second.some((note) => note.startsWith("search: 7 days")), second.join("; "));
    assert.deepEqual((await listMetricSeries(db, "s", ["search_clicks"], "2026-10-01", "2026-10-01")).search_clicks, [{ day: "2026-10-01", value: 1 }]);
  });
});
