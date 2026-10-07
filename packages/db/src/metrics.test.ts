import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analysisHealthPoints, clearMetricPoints, SEARCH_METRIC_PATTERNS, indexStatusCounts, listSitesForResults, pagesToInspect, saveIndexStatus, bumpReportShareVersion, createAnalysis, dailyLeads, firstMetricDay, getSite, insertConversionEvent, listMetricSeries, publishedPages, recordLandingSession, saveAnalysisReport, syncFirstPartyResults, updateSiteGa4Property, upsertMetricPoints, upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const now = "2026-10-07T00:00:00.000Z";

describe("metric ledger", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });

  it("overwrites a point on re-run instead of adding a second one", async () => {
    await upsertMetricPoints(db, "s", [{ metric: "search_clicks", day: "2026-10-01", value: 5 }, { metric: "search_clicks", day: "2026-10-02", value: 7 }]);
    await upsertMetricPoints(db, "s", [{ metric: "search_clicks", day: "2026-10-02", value: 9 }]);
    const series = await listMetricSeries(db, "s", ["search_clicks", "leads"], "2026-09-01", "2026-10-31");
    assert.deepEqual(series.search_clicks, [{ day: "2026-10-01", value: 5 }, { day: "2026-10-02", value: 9 }]);
    assert.deepEqual(series.leads, [], "a metric with no points is an empty series");
  });

  it("knows whether a metric was ever written", async () => {
    assert.equal(await firstMetricDay(db, "s", "search_clicks"), "2026-10-01");
    assert.equal(await firstMetricDay(db, "s", "ga4_sessions"), null);
  });

  it("stores the GA4 property and versions the client link", async () => {
    await updateSiteGa4Property(db, "s", "properties/123");
    assert.equal((await getSite(db, "s"))?.ga4Property, "properties/123");
    assert.equal((await getSite(db, "s"))?.reportShareVersion, 1);
    assert.equal(await bumpReportShareVersion(db, "s"), 2);
  });
});

describe("first-party results", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  const event = (id: string, name: string, at: string, sessionId?: string) =>
    insertConversionEvent(db, { id, siteId: "s", event: name, occurredAt: at, ...(sessionId ? { sessionId } : {}) });
  await event("e1", "whatsapp_click", "2026-10-01T02:00:00Z", "a");
  await event("e2", "form_submit", "2026-10-01T05:00:00Z", "a");      // same session, same day: one lead
  await event("e3", "whatsapp_click", "2026-10-02T01:00:00Z", "a");   // same session, next day: another lead
  await event("e4", "phone_click", "2026-10-01T09:00:00Z");           // no session: counts once
  await event("e5", "page_view", "2026-10-01T09:30:00Z", "b");        // not a contact action
  await recordLandingSession(db, { siteId: "s", sessionId: "a", pageId: "p1" });

  it("counts a session once per day and attributes it to Eumon when it landed on an Eumon page", async () => {
    assert.deepEqual(await dailyLeads(db, "s", "2026-09-01"), [
      { day: "2026-10-01", leads: 2, eumonLeads: 1 },
      { day: "2026-10-02", leads: 1, eumonLeads: 1 },
    ]);
  });

  it("writes the daily points, and a re-run overwrites them", async () => {
    await syncFirstPartyResults(db, "s", new Date("2026-10-07T04:15:00Z"));
    await syncFirstPartyResults(db, "s", new Date("2026-10-07T04:15:00Z"));
    const series = await listMetricSeries(db, "s", ["leads", "leads_eumon", "published_pages"], "2026-09-01", "2026-10-31");
    assert.deepEqual(series.leads!.map((point) => point.value), [2, 1, 0, 0, 0, 0], "event days, then zeros through yesterday");
    assert.deepEqual(series.leads_eumon!.slice(0, 2), [{ day: "2026-10-01", value: 1 }, { day: "2026-10-02", value: 1 }]);
    assert.deepEqual(series.published_pages, [{ day: "2026-10-07", value: 0 }]);
    assert.deepEqual(await publishedPages(db, "s"), { published: 0, goLive: null });
  });
});

describe("site health snapshots", async () => {
  it("measures health against crawled pages, and skips reports without a full crawl", () => {
    const points = analysisHealthPoints({ coverage: { totalUrls: 120, completedUrls: 100, emptyShellUrls: 8, httpErrorUrls: 2, issues: { noindex: 5 } } }, "2026-10-07");
    assert.deepEqual(points.find((point) => point.metric === "site_health"), { metric: "site_health", day: "2026-10-07", value: 85 });
    assert.deepEqual(analysisHealthPoints({ coverage: null }, "2026-10-07"), []);
    assert.deepEqual(analysisHealthPoints({ coverage: { totalUrls: 0, completedUrls: 0, emptyShellUrls: 0, httpErrorUrls: 0 } }, "2026-10-07"), []);
  });

  it("is written when an analysis report is saved", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: now });
    await saveAnalysisReport(db, "a1", { coverage: { totalUrls: 10, completedUrls: 10, emptyShellUrls: 1, httpErrorUrls: 0 } }, "summary");
    const today = new Date().toISOString().slice(0, 10);
    const series = await listMetricSeries(db, "s", ["site_health"], today, today);
    assert.deepEqual(series.site_health, [{ day: today, value: 90 }]);
  });
});

describe("index status", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  await upsertSite(db, { id: "idle", name: "y.com", baseUrl: "https://y.com", createdAt: now, updatedAt: now });
  await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at)
    VALUES ('d', 's', 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(now, now).run();
  await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'T', '{}', 'active', ?, ?)`).bind(now, now).run();
  for (const slug of ["a", "b", "c"]) {
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES (?, 's', 't', ?, ?, ?, '', '{}', 1, '[]', 'published', ?, ?, ?)`).bind(`p_${slug}`, `/guides/${slug}`, slug, slug, now, now, now).run();
  }

  it("inspects never-checked pages first and counts unchecked pages apart from not indexed", async () => {
    await saveIndexStatus(db, "s", [{ pageId: "p_a", verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: null }]);
    assert.deepEqual((await pagesToInspect(db, "s", 2)).map((page) => page.path), ["/guides/b", "/guides/c"]);
    await saveIndexStatus(db, "s", [{ pageId: "p_b", verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed", lastCrawlTime: null }]);
    assert.deepEqual(await indexStatusCounts(db, "s"), { indexed: 1, notIndexed: 1, unchecked: 1 });
    await saveIndexStatus(db, "s", [{ pageId: "p_c", verdict: "VERDICT_UNSPECIFIED", coverageState: null, lastCrawlTime: null }]);
    assert.deepEqual(await indexStatusCounts(db, "s"), { indexed: 1, notIndexed: 1, unchecked: 1 }, "no verdict from Google is not checked yet, not 'not indexed'");
  });

  it("syncs only sites with something to sync", async () => {
    assert.deepEqual(await listSitesForResults(db), ["s"]);
  });
});

describe("review fixes", async () => {
  it("stores days without enquiries as 0 from the first tracked day, so a drop to zero shows", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await insertConversionEvent(db, { id: "e1", siteId: "s", event: "whatsapp_click", occurredAt: "2026-10-01T02:00:00Z", sessionId: "x" });
    await insertConversionEvent(db, { id: "e2", siteId: "s", event: "whatsapp_click", occurredAt: "2026-10-03T02:00:00Z", sessionId: "y" });
    await db.prepare("INSERT INTO page_metrics_daily (site_id, page_id, day, views) VALUES ('s', 'p', '2026-10-02', 5)").run();
    await syncFirstPartyResults(db, "s", new Date("2026-10-05T04:00:00Z"));
    const series = await listMetricSeries(db, "s", ["leads", "eumon_page_views"], "2026-09-01", "2026-10-31");
    assert.deepEqual(series.leads!.map((point) => [point.day, point.value]), [["2026-10-01", 1], ["2026-10-02", 0], ["2026-10-03", 1], ["2026-10-04", 0]]);
    assert.deepEqual(series.eumon_page_views!.map((point) => point.value), [5, 0, 0], "page activity zero-fills from its first day");
  });

  it("clears one source's history, so a new property backfills its own", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await upsertMetricPoints(db, "s", ["search_clicks", "search_clicks@markets", "eumon_search_clicks", "queries_top10", "ga4_sessions", "leads"].map((metric) => ({ metric, day: "2026-10-01", value: 1 })));
    await clearMetricPoints(db, "s", ["%@markets"]);
    assert.equal(await firstMetricDay(db, "s", "search_clicks@markets"), null);
    await clearMetricPoints(db, "s", SEARCH_METRIC_PATTERNS);
    const left = await listMetricSeries(db, "s", ["search_clicks", "eumon_search_clicks", "queries_top10", "ga4_sessions", "leads"], "2026-01-01", "2026-12-31");
    assert.deepEqual(Object.entries(left).filter(([, points]) => points.length).map(([metric]) => metric), ["ga4_sessions", "leads"]);
  });
});

describe("deploy order", () => {
  it("still saves an analysis when the Results ledger table doesn't exist yet", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: now });
    await db.prepare("DROP TABLE metric_points").run();
    await saveAnalysisReport(db, "a1", { coverage: { totalUrls: 10, completedUrls: 10, emptyShellUrls: 1, httpErrorUrls: 0 } }, "summary");
    const row = await db.prepare("SELECT status FROM analyses WHERE id = 'a1'").first<{ status: string }>();
    assert.equal(row?.status, "completed");
  });
});
