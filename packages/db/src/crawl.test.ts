import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, getCrawlCoverage, listPendingCrawlUrls, saveCrawlBatch, upsertSite } from "./index.js";
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
      "/procedures/x", "/procedures/y", "/procedures/z", "/old/page", "/guarded/one", "/guarded/two",
    ].map((path): { url: string; routeFamily: string; blocked?: boolean } => ({ url: u(path), routeFamily: path === "/" ? "home" : path.split("/").length > 2 ? path.split("/")[1]! : "page" }))
      .concat([{ url: u("/private/report"), routeFamily: "private", blocked: true }]),
  });

  it("queues robots-blocked URLs without crawling them", async () => {
    const pending = await listPendingCrawlUrls(db, "a1", 100);
    assert.equal(pending.length, 13);
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
      ],
    });
    const coverage = await getCrawlCoverage(db, "a1");
    assert.equal(coverage.totalUrls, 14);
    assert.equal(coverage.completedUrls, 12);
    assert.equal(coverage.failedUrls, 1);
    assert.equal(coverage.pendingUrls, 0);
    assert.equal(coverage.emptyShellUrls, 2);
    assert.equal(coverage.httpErrorUrls, 1, "a bot challenge is not counted as an HTTP error");
    assert.deepEqual(coverage.issues, {
      robotsBlocked: 1,
      noindex: 1,
      canonicalMismatch: 1,
      redirected: 1,
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
    assert.deepEqual(coverage.issueExamples?.redirected, [{ url: u("/old/page"), detail: u("/new/page") }]);
    assert.deepEqual(coverage.issueExamples?.robotsBlocked, [{ url: u("/private/report") }]);
    assert.deepEqual(coverage.duplicateTitleGroups, [{ title: "Shared title", count: 2, examples: [u("/about"), u("/doctors/a")] }]);
    const procedures = coverage.families?.find((family) => family.family === "procedures");
    assert.deepEqual(procedures, { family: "procedures", urls: 3, crawled: 2, emptyShells: 2, errors: 1, noindex: 0, missingStructuredData: 0 });
    assert.equal(coverage.families?.find((family) => family.family === "home")?.noindex, 1);
  });
});
