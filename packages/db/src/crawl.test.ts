import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import {
  analysisStalled, compactReport, createAnalysis, enqueueAnalysisCrawlUrls, estimateCrawl, getAnalysisJob, getCrawlCoverage, getCrawlProgress, getPreviousCompletedAnalysis,
  listCrawlStates, listPendingCrawlUrls, reuseCrawlResults, saveAnalysisReport, saveCrawlBatch, setLatestReportSearch, updateAnalysisProgress, updateAnalysisStatus, upsertSite,
} from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

function page(url: string, overrides: Partial<CrawlPageResult> = {}): CrawlPageResult {
  return {
    url, status: 200, finalUrl: url, title: `Unique title for ${url}`, description: "A description long enough to count as a real one.",
    hreflang: [], jsonLdCount: 1, contentLength: 5000, isEmptyShell: false, headingOutline: ["h1:Title"], internalLinkCount: 10,
    rawTextLength: 3000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", h1Count: 1, noindex: false,
    jsonLdTypes: ["WebPage"], invalidJsonLd: 0, canonicalMismatch: false,
    routeFamily: new URL(url).pathname.split("/").filter(Boolean).length > 1 ? new URL(url).pathname.split("/")[1] : "page",
    ...overrides,
  };
}

describe("full-crawl coverage", async () => {
  const db = openSqliteD1();
  const now = new Date().toISOString();
  await upsertSite(db, { id: "site", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  await createAnalysis(db, { id: "a1", siteId: "site", status: "running", createdAt: now });
  const u = (path: string) => `https://x.com${path}`;
  await enqueueAnalysisCrawlUrls(db, {
    analysisId: "a1",
    siteId: "site",
    urls: [
      "/", "/about", "/doctors/a", "/doctors/b", "/doctors/c", "/doctors/d", "/doctors/e",
      "/procedures/x", "/procedures/y", "/procedures/z", "/old/page", "/guarded/one", "/guarded/two", "/go/github",
    ].map((path): { url: string; routeFamily: string; blocked?: boolean } => ({ url: u(path), routeFamily: path === "/" ? "home" : path.split("/").length > 2 ? path.split("/")[1]! : "page" }))
      .concat([{ url: u("/private/report"), routeFamily: "private", blocked: true }]),
  });

  it("queues robots-blocked URLs without crawling them", async () => {
    const pending = await listPendingCrawlUrls(db, "a1", 100);
    assert.equal(pending.length, 14);
    assert.equal(pending.includes(u("/private/report")), false);
  });

  it("counts every issue across the crawl, with examples and families", async () => {
    await saveCrawlBatch(db, {
      analysisId: "a1",
      outcomes: [
        { url: u("/"), page: page(u("/"), { routeFamily: "home", noindex: true, robots: "noindex" }) },
        { url: u("/about"), page: page(u("/about"), { title: "Shared title", jsonLdCount: 0 }) },
        { url: u("/doctors/a"), page: page(u("/doctors/a"), { title: "Shared title", h1Count: 0, description: "" }) },
        { url: u("/doctors/b"), page: page(u("/doctors/b"), { canonicalMismatch: true, canonical: "https://x.com/", title: "Shared title" }) },
        { url: u("/doctors/c"), page: page(u("/doctors/c"), { h1Count: 3, jsonLdCount: 0 }) },
        { url: u("/doctors/d"), page: page(u("/doctors/d"), { invalidJsonLd: 1 }) },
        { url: u("/doctors/e"), page: page(u("/doctors/e"), { status: 404 }) },
        { url: u("/procedures/x"), page: page(u("/procedures/x"), { isEmptyShell: true, jsonLdCount: 0, h1Count: 0 }) },
        { url: u("/procedures/y"), page: page(u("/procedures/y"), { isEmptyShell: true, jsonLdCount: 0, h1Count: 0 }) },
        { url: u("/procedures/z"), error: "Timed out" },
        { url: u("/old/page"), page: page(u("/old/page"), { finalUrl: u("/new/page") }) },
        { url: u("/guarded/one"), page: page(u("/guarded/one"), { status: 403, botChallenge: true }) },
        { url: u("/guarded/two"), page: page(u("/guarded/two"), { fetchMode: "raw", googlebotBlockedStatus: 403 }) },
        { url: u("/go/github"), page: page(u("/go/github"), { metaRefresh: "https://github.com/x" }) },
      ],
    });
    const coverage = await getCrawlCoverage(db, "a1");
    assert.equal(coverage.totalUrls, 15);
    assert.equal(coverage.completedUrls, 13);
    assert.equal(coverage.failedUrls, 1);
    assert.equal(coverage.pendingUrls, 0);
    assert.equal(coverage.emptyShellUrls, 2);
    assert.equal(coverage.httpErrorUrls, 1, "a bot challenge is not counted as an HTTP error");
    assert.deepEqual(coverage.issues, {
      robotsBlocked: 1,
      noindex: 1,
      canonicalMismatch: 1,
      redirected: 2,
      missingH1: 1,
      multipleH1: 1,
      missingDescription: 1,
      missingStructuredData: 1,
      invalidStructuredData: 1,
      botFallback: 1,
      botChallenge: 1,
      duplicateTitle: 2,
    });
    assert.deepEqual(coverage.issueExamples?.canonicalMismatch, [{ url: u("/doctors/b"), detail: "https://x.com/" }]);
    assert.deepEqual(coverage.issueExamples?.redirected, [{ url: u("/go/github"), detail: "https://github.com/x" }, { url: u("/old/page"), detail: u("/new/page") }]);
    assert.deepEqual(coverage.issueExamples?.robotsBlocked, [{ url: u("/private/report") }]);
    assert.deepEqual(coverage.duplicateTitleGroups, [{ title: "Shared title", count: 2, examples: [u("/about"), u("/doctors/a")] }]);
    const procedures = coverage.families?.find((family) => family.family === "procedures");
    assert.deepEqual(procedures, { family: "procedures", urls: 3, crawled: 2, emptyShells: 2, errors: 1, noindex: 0, missingStructuredData: 0 });
    assert.equal(coverage.families?.find((family) => family.family === "home")?.noindex, 1);
  });
});

describe("compactReport", () => {
  it("drops bulky detail before the summary when a report nears the row limit", () => {
    const bulky = "x".repeat(2000);
    const report = {
      plan: { situation: "Keep me" },
      pages: Array.from({ length: 50 }, () => ({ bulky })),
      findings: Array.from({ length: 30 }, (_, index) => ({ title: `Finding ${index}`, evidence: { bulky } })),
    };
    const json = compactReport(report, 60_000);
    assert.ok(json.length <= 60_000, `${json.length}`);
    const parsed = JSON.parse(json);
    assert.equal(parsed.plan.situation, "Keep me");
    assert.equal(parsed.pages.length, 0);
    assert.equal(parsed.findings.length, 30, "every finding is kept");
    assert.equal(compactReport({ small: true }), JSON.stringify({ small: true }));
  });
});

describe("live crawl progress", async () => {
  const db = openSqliteD1();
  const now = new Date().toISOString();
  const u = (path: string) => `https://y.com${path}`;
  await upsertSite(db, { id: "site", name: "y.com", baseUrl: "https://y.com", createdAt: now, updatedAt: now });
  await createAnalysis(db, { id: "p1", siteId: "site", status: "running", createdAt: now });
  await enqueueAnalysisCrawlUrls(db, {
    analysisId: "p1", siteId: "site",
    urls: [
      ...["/doctors/a", "/doctors/b", "/doctors/c", "/doctors/d"].map((path) => ({ url: u(path), routeFamily: "doctors" })),
      { url: u("/blog/x"), routeFamily: "blog" },
      { url: u("/private/x"), routeFamily: "private", blocked: true },
    ],
  });
  await saveCrawlBatch(db, {
    analysisId: "p1",
    outcomes: [
      { url: u("/doctors/a"), page: page(u("/doctors/a")) },
      { url: u("/doctors/b"), page: page(u("/doctors/b"), { isEmptyShell: true }) },
      { url: u("/doctors/c"), page: page(u("/doctors/c"), { status: 404 }) },
      { url: u("/blog/x"), error: "timeout" },
    ],
  });

  it("counts what the crawl has done so far, per page type, with the latest pages", async () => {
    const progress = await getCrawlProgress(db, "p1");
    assert.deepEqual(
      { total: progress.total, pending: progress.pending, crawled: progress.crawled, failed: progress.failed, blocked: progress.blocked, ok: progress.ok, httpErrors: progress.httpErrors, emptyShells: progress.emptyShells },
      { total: 6, pending: 1, crawled: 4, failed: 1, blocked: 1, ok: 2, httpErrors: 1, emptyShells: 1 },
    );
    assert.deepEqual(progress.families.find((family) => family.family === "doctors"), { family: "doctors", total: 4, done: 3, fetched: 3, blocked: 0, emptyShells: 1, errors: 1 });
    assert.equal(progress.recent.length, 4);
    assert.ok(progress.firstCrawledAt);
  });

  it("estimates pace and time left only once the crawl has settled", () => {
    const start = Date.parse("2026-10-07T10:00:00.000Z");
    assert.deepEqual(estimateCrawl({ crawled: 50, pending: 950, firstCrawledAt: "2026-10-07T10:00:00.000Z" }, start + 120_000), {}, "too few pages");
    assert.deepEqual(estimateCrawl({ crawled: 300, pending: 900, firstCrawledAt: "2026-10-07T10:00:00.000Z" }, start + 30_000), {}, "too early");
    assert.deepEqual(estimateCrawl({ crawled: 300, pending: 900, firstCrawledAt: "2026-10-07T10:00:00.000Z" }, start + 180_000), { perMinute: 100, secondsLeft: 540 });
    assert.deepEqual(
      estimateCrawl({ crawled: 600, pending: 0, firstCrawledAt: "2026-10-07T10:00:00.000Z", lastCrawledAt: "2026-10-07T10:03:00.000Z" }, start + 6 * 3_600_000),
      { perMinute: 200, secondsLeft: 0 },
      "a finished crawl keeps its own pace",
    );
  });

  it("times each stage and carries stage detail", async () => {
    await updateAnalysisProgress(db, "p1", "sitemap", "Reading the sitemap");
    await updateAnalysisProgress(db, "p1", "crawl", "Crawled 100", { reused: 20 });
    await updateAnalysisProgress(db, "p1", "crawl", "Crawled 200", { reused: 20 });
    const job = await getAnalysisJob(db, "p1");
    assert.deepEqual(job?.progress?.history?.map((entry) => entry.stage), ["sitemap", "crawl"]);
    assert.equal(job?.progress?.message, "Crawled 200");
    assert.deepEqual(job?.progress?.detail, { reused: 20 });
  });

  it("treats a run with no progress for 45 minutes as stopped", () => {
    const start = Date.parse("2026-10-07T10:00:00.000Z");
    const job = (status: string, updatedAt?: string) => ({ status, createdAt: "2026-10-07T10:00:00.000Z", progress: updatedAt ? { stage: "crawl", message: "", updatedAt } : undefined });
    assert.equal(analysisStalled(job("running", "2026-10-07T10:30:00.000Z"), start + 60 * 60_000), false, "updated 30 minutes ago");
    assert.equal(analysisStalled(job("running", "2026-10-07T10:30:00.000Z"), start + 80 * 60_000), true, "silent for 50 minutes");
    assert.equal(analysisStalled(job("queued"), start + 50 * 60_000), true, "never started");
    assert.equal(analysisStalled(job("completed"), start + 5 * 3_600_000), false, "finished runs are not stalled");
  });

  it("carries unchanged results into a re-run and never reuses a failure", async () => {
    await updateAnalysisStatus(db, "p1", "completed", { completedAt: now });
    await createAnalysis(db, { id: "p2", siteId: "site", status: "running", createdAt: new Date(Date.now() + 1000).toISOString() });
    assert.deepEqual(await getPreviousCompletedAnalysis(db, "site", "p2"), { id: "p1", completedAt: now });
    const states = await listCrawlStates(db, "p1");
    assert.equal(states.get(u("/blog/x"))?.state, "failed");
    await reuseCrawlResults(db, { analysisId: "p2", previousAnalysisId: "p1", urls: [u("/doctors/a"), u("/doctors/b"), u("/blog/x")] });
    const progress = await getCrawlProgress(db, "p2");
    assert.equal(progress.reused, 2, "the failed URL is not copied");
    assert.deepEqual(progress.families.find((family) => family.family === "doctors"), { family: "doctors", total: 2, done: 2, fetched: 0, blocked: 0, emptyShells: 1, errors: 0 });
    assert.equal(progress.crawled, 0, "reused results do not count as fetched in this run");
    const coverage = await getCrawlCoverage(db, "p2");
    assert.equal(coverage.emptyShellUrls, 1, "reused results still count toward the analysis");
  });
});

describe("run lifecycle", () => {
  it("never changes a finished run again: a dying run can't overwrite a cancel", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "z.com", baseUrl: "https://z.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "r1", siteId: "site", status: "queued", createdAt: now });
    assert.equal(await updateAnalysisStatus(db, "r1", "running", { startedAt: now }), true);
    assert.equal(await updateAnalysisProgress(db, "r1", "crawl", "Crawled 100"), true, "an open run takes progress");
    assert.equal(await updateAnalysisStatus(db, "r1", "cancelled", { completedAt: now }), true);

    assert.equal(await updateAnalysisStatus(db, "r1", "failed", { error: "boom" }), false);
    assert.equal(await updateAnalysisStatus(db, "r1", "running"), false, "a retried first step can't reopen it");
    assert.equal(await updateAnalysisProgress(db, "r1", "competitors", "Reading x.com"), false, "tells the run to stop");
    await saveAnalysisReport(db, "r1", { findings: [] }, "late report");
    const job = await getAnalysisJob(db, "r1");
    assert.equal(job?.status, "cancelled");
    assert.equal(job?.error, undefined);
    assert.equal(job?.progress?.message, "Crawled 100");
    assert.equal(job?.report, undefined);
  });
});

describe("search section on the last report", () => {
  it("fills in the latest finished report's search data without a new run", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "z.com", baseUrl: "https://z.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "old", siteId: "site", status: "running", createdAt: "2026-10-01T00:00:00.000Z" });
    await saveAnalysisReport(db, "old", { findings: [], search: null }, "old");
    await createAnalysis(db, { id: "new", siteId: "site", status: "running", createdAt: "2026-10-02T00:00:00.000Z" });
    await saveAnalysisReport(db, "new", { findings: [1], search: null }, "new");
    await createAnalysis(db, { id: "live", siteId: "site", status: "running", createdAt: "2026-10-03T00:00:00.000Z" });

    assert.equal(await setLatestReportSearch(db, "site", { totals: { clicks: 5 } }), true);
    assert.deepEqual((await getAnalysisJob(db, "new"))?.report, { findings: [1], search: { totals: { clicks: 5 } } });
    assert.deepEqual((await getAnalysisJob(db, "old"))?.report, { findings: [], search: null }, "older reports keep their own data");
  });
});
