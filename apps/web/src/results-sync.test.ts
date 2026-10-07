import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listMetricSeries, setSiteMarkets, updateSiteGa4Property, updateSiteGscProperty, upsertSite, getSite } from "@organic-growth/db";
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

  it("backfills target-market history when markets are added after the first sync", async () => {
    const { db, site: record } = await site();
    const rows = { rows: [{ keys: ["2026-10-01"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] };
    const google = { token: async () => "t", scopes: [SEARCH_CONSOLE_SCOPE], fetchFn: (async () => new Response(JSON.stringify(rows))) as unknown as typeof fetch };
    await syncResults(db, record, now, google);
    await setSiteMarkets(db, "s", ["mys"]);
    const notes = await syncResults(db, record, now, google);
    assert.ok(notes.includes("markets: 486 days"), notes.join("; "));
  });

  it("inspects pages several at a time", async () => {
    const { db, site: record } = await site();
    const at = now.toISOString();
    await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'T', '{}', 'active', ?, ?)`).bind(at, at).run();
    for (let index = 0; index < 12; index++) {
      await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
        VALUES (?, 's', 't', ?, ?, 'x', '', '{}', 1, '[]', 'published', ?, ?, ?)`).bind(`p${index}`, `/guides/${index}`, String(index), at, at, at).run();
    }
    let inFlight = 0;
    let most = 0;
    const fetchFn = (async (url: string) => {
      if (!url.includes("urlInspection")) return new Response(JSON.stringify({ rows: [] }));
      inFlight++; most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS" } } }));
    }) as typeof fetch;
    const notes = await syncResults(db, record, now, { token: async () => "t", scopes: [SEARCH_CONSOLE_SCOPE], fetchFn });
    assert.ok(notes.includes("inspected 12 pages"), notes.join("; "));
    assert.ok(most > 1 && most <= 10, `at most ${most} inspections in flight`);
  });
});
