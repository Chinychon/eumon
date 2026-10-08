import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import type { Fetcher } from "@organic-growth/crawler";
import { createAnalysis, getCrawlProgress, saveCrawlBatch, updateAnalysisStatus, upsertSite, enqueueAnalysisCrawlUrls } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { queueFullCrawl, shouldReuse } from "./pipeline.js";

const DAY = 86_400_000;

describe("shouldReuse", () => {
  const crawledAt = "2026-10-01T09:00:00.000Z";
  const at = (days: number) => Date.parse(crawledAt) + days * DAY;
  it("reuses only results that still stand", () => {
    assert.equal(shouldReuse(undefined, undefined, at(1)), false, "never crawled");
    assert.equal(shouldReuse({ state: "failed", crawledAt }, undefined, at(1)), false, "failed before");
    assert.equal(shouldReuse({ state: "complete", crawledAt }, undefined, at(3)), true, "no lastmod, crawled 3 days ago");
    assert.equal(shouldReuse({ state: "complete", crawledAt }, undefined, at(8)), false, "no lastmod, older than a week");
    assert.equal(shouldReuse({ state: "complete", crawledAt }, "2026-09-20", at(20)), true, "unchanged since the crawl");
    assert.equal(shouldReuse({ state: "complete", crawledAt }, "2026-10-01", at(2)), false, "changed the day it was crawled");
    assert.equal(shouldReuse({ state: "complete", crawledAt }, "2026-10-02T08:00:00+00:00", at(2)), false, "changed after the crawl");
    assert.equal(shouldReuse({ state: "complete", crawledAt }, "2026-09-20", at(31)), false, "older than 30 days");
    assert.equal(shouldReuse({ state: "complete", crawledAt }, "not a date", at(3)), true, "an unreadable lastmod counts as missing");
  });
});

describe("queueFullCrawl", async () => {
  const origin = "https://clinic.example";
  const sitemap = `<urlset>
    <url><loc>${origin}/blog/a</loc><lastmod>2020-01-01</lastmod></url>
    <url><loc>${origin}/blog/b</loc></url>
    <url><loc>${origin}/doctors/x</loc></url>
    <url><loc>${origin}/doctors/y</loc><lastmod>2999-01-01</lastmod></url>
    <url><loc>${origin}/doctors/new</loc></url>
  </urlset>`;
  const fetcher: Fetcher = async (url) => {
    const body = url.endsWith("/robots.txt") ? `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml` : url.endsWith("/sitemap.xml") ? sitemap : "";
    return { url, finalUrl: url, headers: {}, status: body ? 200 : 404, body };
  };
  const page = (url: string): CrawlPageResult => ({
    url, status: 200, finalUrl: url, title: "A title long enough", hreflang: [], jsonLdCount: 1, contentLength: 4000, isEmptyShell: false,
    headingOutline: [], internalLinkCount: 3, rawTextLength: 2000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: "blog",
  });
  const db = openSqliteD1();
  const created = new Date().toISOString();
  await upsertSite(db, { id: "s", name: "clinic.example", baseUrl: origin, createdAt: created, updatedAt: created });
  await createAnalysis(db, { id: "first", siteId: "s", status: "running", createdAt: created });
  await enqueueAnalysisCrawlUrls(db, { analysisId: "first", siteId: "s", urls: ["/blog/a", "/blog/b", "/doctors/x", "/doctors/y"].map((path) => ({ url: `${origin}${path}`, routeFamily: path.split("/")[1]! })) });
  await saveCrawlBatch(db, {
    analysisId: "first",
    outcomes: [
      { url: `${origin}/blog/a`, page: page(`${origin}/blog/a`) },
      { url: `${origin}/blog/b`, page: page(`${origin}/blog/b`) },
      { url: `${origin}/doctors/x`, error: "timeout" },
      { url: `${origin}/doctors/y`, page: page(`${origin}/doctors/y`) },
    ],
  });
  await updateAnalysisStatus(db, "first", "completed", { completedAt: created });

  it("fetches only what changed, failed, or is new, and reuses the rest", async () => {
    await createAnalysis(db, { id: "second", siteId: "s", status: "running", createdAt: new Date(Date.now() + 1000).toISOString() });
    const queued = await queueFullCrawl(db, { analysisId: "second", siteId: "s", baseUrl: origin, maxUrls: 100, fetcher, now: Date.now() + 2 * DAY });
    assert.deepEqual(queued, { declared: 5, queued: 3, reused: 2, reusedFrom: created });
    const progress = await getCrawlProgress(db, "second");
    assert.equal(progress.reused, 2);
    assert.equal(progress.pending, 3, "the failed, the changed, and the new URL");
  });

  it("reuses pages a cancelled run fetched after the last finished one", async () => {
    await createAnalysis(db, { id: "stopped", siteId: "s", status: "running", createdAt: new Date(Date.now() + 1500).toISOString() });
    await enqueueAnalysisCrawlUrls(db, { analysisId: "stopped", siteId: "s", urls: [{ url: `${origin}/doctors/x`, routeFamily: "doctors" }, { url: `${origin}/doctors/new`, routeFamily: "doctors" }] });
    await saveCrawlBatch(db, { analysisId: "stopped", outcomes: [{ url: `${origin}/doctors/x`, page: page(`${origin}/doctors/x`) }] });
    await updateAnalysisStatus(db, "stopped", "cancelled", { completedAt: new Date().toISOString() });
    await createAnalysis(db, { id: "after", siteId: "s", status: "running", createdAt: new Date(Date.now() + 1800).toISOString() });
    const queued = await queueFullCrawl(db, { analysisId: "after", siteId: "s", baseUrl: origin, maxUrls: 100, fetcher, now: Date.now() + 2 * DAY });
    assert.equal(queued.reused, 3, "blog/a and blog/b from the finished run, doctors/x from the cancelled one");
    assert.equal(queued.queued, 2, "only the changed and the never-fetched URL");
  });

  it("re-crawls everything on a full run", async () => {
    await createAnalysis(db, { id: "third", siteId: "s", status: "running", createdAt: new Date(Date.now() + 2000).toISOString() });
    const queued = await queueFullCrawl(db, { analysisId: "third", siteId: "s", baseUrl: origin, maxUrls: 100, fetcher, full: true });
    assert.deepEqual(queued, { declared: 5, queued: 5, reused: 0 });
  });
});
