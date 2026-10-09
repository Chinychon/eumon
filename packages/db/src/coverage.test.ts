import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, indexCoverage, saveCrawlBatch, saveUrlIndexStatus, updateAnalysisStatus, upsertSite, urlsToInspect } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const u = (path: string) => `https://x.com${path}`;
const page = (path: string): CrawlPageResult => ({
  url: u(path), status: 200, finalUrl: u(path), hreflang: [], jsonLdCount: 0, contentLength: 5000, isEmptyShell: false, headingOutline: [],
  internalLinkCount: 0, rawTextLength: 3000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: path.split("/")[1]!,
});

async function crawled(paths: string[]) {
  const db = openSqliteD1();
  const now = new Date().toISOString();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  await createAnalysis(db, { id: "a", siteId: "s", status: "running", createdAt: now });
  await enqueueAnalysisCrawlUrls(db, { analysisId: "a", siteId: "s", urls: paths.map((path) => ({ url: u(path), routeFamily: path.split("/")[1]! })) });
  await saveCrawlBatch(db, { analysisId: "a", outcomes: paths.map((path) => ({ url: u(path), page: page(path) })) });
  await updateAnalysisStatus(db, "a", "completed", { completedAt: now });
  return db;
}

describe("url index status", () => {
  it("queues never-checked URLs round-robin across page types, then the oldest stale ones", async () => {
    const db = await crawled(["/doctors/a", "/doctors/b", "/doctors/c", "/blog/x", "/blog/y"]);
    assert.deepEqual((await urlsToInspect(db, "s", 4, "2026-09-08")).map((row) => row.url), [u("/blog/x"), u("/doctors/a"), u("/blog/y"), u("/doctors/b")]);
    const row = (url: string, verdict: string, state: string | null) => ({ url, family: url.split("/")[3]!, verdict, coverageState: state, lastCrawlTime: null });
    await saveUrlIndexStatus(db, "s", [row(u("/doctors/a"), "PASS", "Submitted and indexed"), row(u("/blog/x"), "NEUTRAL", "Crawled - currently not indexed")]);
    await db.prepare("UPDATE url_index_status SET checked_at = '2026-08-01T00:00:00.000Z' WHERE url = ?").bind(u("/blog/x")).run();
    assert.deepEqual((await urlsToInspect(db, "s", 10, "2026-09-08")).map((entry) => entry.url), [u("/blog/y"), u("/doctors/b"), u("/doctors/c"), u("/blog/x")], "unchecked first, then stale");
  });

  it("counts only URLs in the current crawl, by what Google did with them", async () => {
    const db = await crawled(["/doctors/a", "/doctors/b", "/blog/x"]);
    await saveUrlIndexStatus(db, "s", [
      { url: u("/doctors/a"), family: "doctors", verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T00:00:00Z" },
      { url: u("/blog/x"), family: "blog", verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed", lastCrawlTime: null },
      { url: u("/old/gone"), family: "old", verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T00:00:00Z" },
    ]);
    const coverage = (await indexCoverage(db, "s", new Date("2026-10-08T00:00:00Z")))!;
    assert.equal(coverage.total, 3);
    assert.equal(coverage.checked, 2, "a URL no longer in the crawl doesn't count");
    assert.equal(coverage.recentlyCrawled, 1);
    assert.deepEqual(coverage.byClass, { indexed: 1, crawled: 0, discovered: 1, unknown: 0, excluded: 0 });
    assert.deepEqual(coverage.families.find((entry) => entry.family === "doctors"), { family: "doctors", total: 2, checked: 1, byClass: { indexed: 1, crawled: 0, discovered: 0, unknown: 0, excluded: 0 } });
  });
});
