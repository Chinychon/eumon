import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import {
  createAnalysis, enqueueAnalysisCrawlUrls, getSnapshot, importSearchConsoleUrls, listMetricSeries, liveUrlsOfFamily, saveAnalysisReport, saveCrawlBatch,
  saveSearchConsoleChart, saveSearchConsoleChecks, saveSearchConsoleSummary, searchConsoleReconciliation, searchConsoleUrlsToCheck, upsertSite, type D1Like,
} from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const AT = "2026-10-01T00:00:00.000Z";
const page = (url: string, status: number, extra: Partial<CrawlPageResult> = {}): CrawlPageResult => ({
  url, status, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1000, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 500, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", ...extra,
});
const u = (path: string) => `https://x.com${path}`;

/** A site whose latest crawl knows five doctor pages: live, noindex, redirected, gone, erroring. */
async function siteWithCrawl(): Promise<D1Like> {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
  await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: AT });
  const pages = [page(u("/doctors/dr-a"), 200), page(u("/doctors/dr-b"), 200, { noindex: true }), page(u("/doctors/dr-c"), 200, { finalUrl: u("/doctors/dr-c-new") }), page(u("/doctors/dr-d"), 404), page(u("/doctors/dr-e"), 503)];
  await enqueueAnalysisCrawlUrls(db, { analysisId: "a1", siteId: "s", urls: pages.map((entry) => ({ url: entry.url, routeFamily: "doctors" })) });
  await saveCrawlBatch(db, { analysisId: "a1", outcomes: pages.map((entry) => ({ url: entry.url, page: entry })) });
  await saveAnalysisReport(db, "a1", { findings: [] }, "done");
  return db;
}
const list = (paths: string[]) => paths.map((path) => ({ url: u(path), lastCrawled: "2026-09-30" }));

describe("Search Console import", () => {
  it("imports a reason's URLs; a re-import under another reason takes the new reason and clears the live check", async () => {
    const db = await siteWithCrawl();
    assert.deepEqual(await importSearchConsoleUrls(db, "s", { reason: "noindex", reasonText: "Excluded by 'noindex' tag", urls: list(["/doctors/dr-a", "/old/one", "/old/two"]), importedAt: AT }), { imported: 3 });
    await saveSearchConsoleChecks(db, "s", [{ url: u("/old/one"), status: 301, finalUrl: u("/doctors/dr-a"), noindex: false, suggestedUrl: null }]);
    await importSearchConsoleUrls(db, "s", { reason: "not_found", reasonText: "Not found (404)", urls: list(["/old/one"]), importedAt: "2026-10-02T00:00:00.000Z" });
    const row = await db.prepare("SELECT reason, live_status, checked_at, imported_at FROM search_console_urls WHERE site_id = 's' AND url = ?").bind(u("/old/one")).first<Record<string, unknown>>();
    assert.deepEqual({ ...row }, { reason: "not_found", live_status: null, checked_at: null, imported_at: "2026-10-02T00:00:00.000Z" });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM search_console_urls WHERE site_id = 's'").first<{ n: number }>())!.n, 3, "an upsert, not a duplicate");
  });

  it("lists only unchecked URLs the latest crawl doesn't know, up to the limit", async () => {
    const db = await siteWithCrawl();
    await importSearchConsoleUrls(db, "s", { reason: "noindex", reasonText: "noindex", urls: list(["/doctors/dr-a", "/old/w", "/old/x", "/old/y", "/old/z"]), importedAt: AT });
    await saveSearchConsoleChecks(db, "s", [{ url: u("/old/w"), status: 404, finalUrl: null, noindex: null, suggestedUrl: null }]);
    assert.deepEqual(await searchConsoleUrlsToCheck(db, "s", 2), [u("/old/x"), u("/old/y")]);
    assert.deepEqual(await searchConsoleUrlsToCheck(db, "s", 10), [u("/old/x"), u("/old/y"), u("/old/z")]);
  });

  it("reconciles each reason from crawl rows and live checks, with examples and suggestions", async () => {
    const db = await siteWithCrawl();
    await importSearchConsoleUrls(db, "s", { reason: "noindex", reasonText: "Excluded by 'noindex' tag", urls: list(["/doctors/dr-a", "/doctors/dr-b", "/doctors/dr-c", "/doctors/dr-d", "/doctors/dr-e", "/old/1", "/old/2", "/old/3"]), importedAt: AT });
    await importSearchConsoleUrls(db, "s", { reason: "discovered", reasonText: "Discovered - currently not indexed", urls: list(Array.from({ length: 15 }, (_, i) => `/guides/${i}`)), importedAt: AT });
    await saveSearchConsoleChecks(db, "s", [
      { url: u("/old/1"), status: 301, finalUrl: u("/doctors/dr-a"), noindex: false, suggestedUrl: null },
      { url: u("/old/2"), status: 404, finalUrl: null, noindex: null, suggestedUrl: u("/doctors/dr-a") },
    ]);
    const view = await searchConsoleReconciliation(db, "s");
    assert.equal(view.importedAt, AT);
    assert.equal(view.remainingChecks, 16, "one old URL and the fifteen guides the crawl doesn't know");
    const noindex = view.reasons.find((entry) => entry.reason === "noindex")!;
    assert.deepEqual(noindex.today, { indexable: 1, noindex: 1, redirect: 2, gone: 2, error: 1, unchecked: 1 });
    assert.deepEqual(noindex.examples.gone?.sort(), [u("/doctors/dr-d"), u("/old/2")]);
    assert.deepEqual(view.suggestions, [{ url: u("/old/2"), suggestedUrl: u("/doctors/dr-a") }]);
    const discovered = view.reasons.find((entry) => entry.reason === "discovered")!;
    assert.equal(discovered.urls, 15);
    assert.equal(discovered.examples.unchecked?.length, 10, "examples are capped at ten");
    assert.deepEqual(view.reasons.map((entry) => entry.reason), ["discovered", "noindex"], "Search Console's order");
  });

  it("saves the overview summary as a snapshot and the chart as ledger points", async () => {
    const db = await siteWithCrawl();
    const rows = [{ reason: "discovered" as const, reasonText: "Discovered - currently not indexed", source: "Google systems", validation: "Not Started", pages: 23100 }];
    await saveSearchConsoleSummary(db, "s", rows, AT);
    assert.deepEqual((await getSnapshot(db, "s", "search_console_summary", "table"))?.rows, rows);
    await saveSearchConsoleChart(db, "s", [{ day: "2026-09-19", indexed: 1774, notIndexed: 3309 }, { day: "2026-09-22", indexed: 1561, notIndexed: 24498 }]);
    const series = await listMetricSeries(db, "s", ["gsc_indexed", "gsc_not_indexed"], "2026-09-01", "2026-09-30");
    assert.deepEqual(series.gsc_indexed!.map((point) => [point.day, point.value]), [["2026-09-19", 1774], ["2026-09-22", 1561]]);
    assert.equal(series.gsc_not_indexed![1]!.value, 24498);
  });

  it("lists the live URLs of a page type from the latest crawl", async () => {
    const db = await siteWithCrawl();
    assert.deepEqual(await liveUrlsOfFamily(db, "s", "doctors"), [u("/doctors/dr-a"), u("/doctors/dr-b"), u("/doctors/dr-c")], "served pages only: not the 404 or the 503");
    assert.deepEqual(await liveUrlsOfFamily(db, "s", "guides"), []);
  });
});
