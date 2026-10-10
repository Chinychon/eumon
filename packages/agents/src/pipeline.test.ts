import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import type { Fetcher } from "@organic-growth/crawler";
import { createAnalysis, getCrawlProgress, reuseCrawlResults, saveCrawlBatch, updateAnalysisStatus, upsertSite, enqueueAnalysisCrawlUrls } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { CHECKS } from "@organic-growth/core";
import { queueFullCrawl, runFullAnalysis, shouldReuse } from "./pipeline.js";

/** A three-page site for runFullAnalysis: a good homepage, an empty shell, and a page without an H1. */
export function fixtureSite(): Fetcher {
  const origin = "https://clinic.example";
  const html = (title: string, body: string, head = "") => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="viewport" content="width=device-width">${head}</head><body>${body}</body></html>`;
  const pages: Record<string, string> = {
    "/": html("Clinic Example | Dental care in Kuala Lumpur", `<main><h1>Dental care</h1><p>${"We treat patients every day. ".repeat(40)}</p><a href="/doctors/a">A</a><a href="/doctors/b">B</a></main>`,
      `<meta name="description" content="Dental care in Kuala Lumpur with same-week appointments and clear prices."><script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Clinic Example","url":"${origin}/","sameAs":["https://facebook.com/clinic"]}</script>`),
    "/doctors/a": html("Doctor A", '<div id="root"></div><script src="/app.js"></script>'),
    "/doctors/b": html("Dr B, orthodontist at Clinic Example", `<main><h2>About</h2><p>${"Dr B fits braces and aligners. ".repeat(30)}</p></main>`),
  };
  const files: Record<string, string> = {
    "/robots.txt": `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
    "/sitemap.xml": `<urlset>${Object.keys(pages).map((path) => `<url><loc>${origin}${path}</loc></url>`).join("")}</urlset>`,
  };
  return async (url) => {
    const { pathname } = new URL(url);
    const body = pages[pathname] ?? files[pathname];
    return { url, finalUrl: url, headers: { "content-type": pages[pathname] ? "text/html" : "text/plain" }, status: body ? 200 : 404, body: body ?? "Not found" };
  };
}

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
    headingOutline: [], internalLinkCount: 3, rawTextLength: 2000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: "blog", locale: "default",
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

  it("takes each page's newest fetch, not the newest run's copy of an older one", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A stopped run fetches /blog/a again; a later stopped run only copied the first crawl's older /blog/a.
    await createAnalysis(db, { id: "refetch", siteId: "s", status: "running", createdAt: new Date(Date.now() + 1900).toISOString() });
    await enqueueAnalysisCrawlUrls(db, { analysisId: "refetch", siteId: "s", urls: [{ url: `${origin}/blog/a`, routeFamily: "blog" }] });
    await saveCrawlBatch(db, { analysisId: "refetch", outcomes: [{ url: `${origin}/blog/a`, page: page(`${origin}/blog/a`) }] });
    await updateAnalysisStatus(db, "refetch", "cancelled", { completedAt: new Date().toISOString() });
    await createAnalysis(db, { id: "copier", siteId: "s", status: "running", createdAt: new Date(Date.now() + 1950).toISOString() });
    await reuseCrawlResults(db, { analysisId: "copier", previousAnalysisId: "first", urls: [`${origin}/blog/a`] });
    await updateAnalysisStatus(db, "copier", "cancelled", { completedAt: new Date().toISOString() });

    await createAnalysis(db, { id: "later", siteId: "s", status: "running", createdAt: new Date(Date.now() + 1980).toISOString() });
    await queueFullCrawl(db, { analysisId: "later", siteId: "s", baseUrl: origin, maxUrls: 100, fetcher, now: Date.now() + 2 * DAY });
    const row = await db.prepare("SELECT reused_from AS source FROM pages WHERE analysis_id = 'later' AND url = ?").bind(`${origin}/blog/a`).first<{ source: string }>();
    assert.equal(row?.source, "refetch");
  });

  it("re-crawls everything on a full run", async () => {
    await createAnalysis(db, { id: "third", siteId: "s", status: "running", createdAt: new Date(Date.now() + 2000).toISOString() });
    const queued = await queueFullCrawl(db, { analysisId: "third", siteId: "s", baseUrl: origin, maxUrls: 100, fetcher, full: true });
    assert.deepEqual(queued, { declared: 5, queued: 5, reused: 0 });
  });
});

describe("runFullAnalysis", () => {
  it("produces every finding through a registered check", async () => {
    const report = await runFullAnalysis({ analysisId: "a", siteId: "s", name: "Clinic", baseUrl: "https://clinic.example", fetcher: fixtureSite(), repeatability: false, maxPages: 5 });
    assert.ok(report.findings.length >= 3, report.findings.map((f) => f.title).join(" | "));
    for (const f of report.findings) {
      assert.ok(f.checkId && CHECKS[f.checkId], `finding "${f.title}" has no registered checkId`);
      assert.equal(f.category, CHECKS[f.checkId!]!.category, f.title);
      assert.ok(f.recommendation, `${f.title} has no recommendation`);
    }
  });
});
