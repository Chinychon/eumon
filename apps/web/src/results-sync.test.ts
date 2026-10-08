import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTopQueriesSnapshot, listMetricSeries, setSiteMarkets, updateSiteGa4Property, updateSiteGscProperty, upsertSite, getSite } from "@organic-growth/db";
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
});
