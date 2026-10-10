import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simhash, type CrawlPageResult } from "@organic-growth/core";
import {
  analysisStalled, compactReport, createAnalysis, enqueueAnalysisCrawlUrls, estimateCrawl, getAnalysisJob, getCrawlCoverage, getCrawlProgress, getPreviousCompletedAnalysis, listCrawlStates, listPendingCrawlUrls, pruneCrawlResults, recountCrawl, reuseCrawlResults, saveAnalysisReport, saveCrawlBatch, setLatestReportSearch, updateAnalysisProgress, updateAnalysisStatus, upsertSite,
} from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

function page(url: string, overrides: Partial<CrawlPageResult> = {}): CrawlPageResult {
  return {
    url, status: 200, finalUrl: url, title: `Unique title for ${url}`, description: "A description long enough to count as a real one.",
    hreflang: [], jsonLdCount: 1, contentLength: 5000, isEmptyShell: false, headingOutline: ["h1:Title"], internalLinkCount: 10,
    rawTextLength: 3000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", h1Count: 1, noindex: false,
    jsonLdTypes: ["WebPage"], invalidJsonLd: 0, canonicalMismatch: false, locale: "default",
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
      softNotFound: 0,
      nearDuplicate: 0,
      robotsBlocked: 1,
      noindex: 1,
      canonicalMismatch: 1,
      redirected: 1,
      metaRefresh: 1,
      missingH1: 1,
      multipleH1: 1,
      missingDescription: 1,
      missingStructuredData: 1,
      invalidStructuredData: 1,
      botFallback: 1,
      botChallenge: 1,
      duplicateTitle: 2,
      // Every page here shares one description; the rest are content checks these pages predate.
      duplicateDescription: 6,
      redirectChain: 0, mixedContent: 0, httpLinks: 0, titleLength: 0, descriptionLength: 0, h1EqualsTitle: 0, headingSkips: 0, langMissing: 0,
      viewportMissing: 0, imagesNoAlt: 0, thinContent: 0, yearInSlug: 0, snippetBlocked: 0, stale: 0, noDate: 0, noAnswerStructure: 0, lowEvidence: 0,
      noAuthor: 0, noLandmarks: 0,
    });
    assert.deepEqual(coverage.issueExamples?.canonicalMismatch, [{ url: u("/doctors/b"), detail: "https://x.com/" }]);
    assert.deepEqual(coverage.issueExamples?.redirected, [{ url: u("/old/page"), detail: u("/new/page") }]);
    assert.deepEqual(coverage.issueExamples?.metaRefresh, [{ url: u("/go/github"), detail: "https://github.com/x" }], "a meta refresh is its own check now");
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
    const wide = compactReport({ pages: [{ title: "牙科诊所".repeat(5000) }], plan: {} }, 30_000);
    assert.ok(new TextEncoder().encode(wide).byteLength <= 30_000, "measured in UTF-8 bytes, not characters");
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
      ...["/doctors/a", "/doctors/b", "/doctors/c", "/doctors/d", "/doctors/old"].map((path) => ({ url: u(path), routeFamily: "doctors" })),
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
      { url: u("/doctors/old"), page: page(u("/doctors/old"), { locale: undefined }) },
      { url: u("/blog/x"), error: "timeout" },
    ],
  });

  it("counts what the crawl has done so far, per page type, with the latest pages", async () => {
    const progress = await getCrawlProgress(db, "p1");
    assert.deepEqual(
      { total: progress.total, pending: progress.pending, crawled: progress.crawled, failed: progress.failed, blocked: progress.blocked, ok: progress.ok, httpErrors: progress.httpErrors, emptyShells: progress.emptyShells },
      { total: 7, pending: 1, crawled: 5, failed: 1, blocked: 1, ok: 3, httpErrors: 1, emptyShells: 1 },
    );
    assert.deepEqual(progress.families.find((family) => family.family === "doctors"), { family: "doctors", total: 5, done: 4, fetched: 4, blocked: 0, emptyShells: 1, errors: 1 });
    assert.equal(progress.recent.length, 5);
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
    await reuseCrawlResults(db, { analysisId: "p2", previousAnalysisId: "p1", urls: [u("/doctors/a"), u("/doctors/b"), u("/doctors/old"), u("/blog/x")] });
    const progress = await getCrawlProgress(db, "p2");
    assert.equal(progress.reused, 2, "the failed URL is not copied, nor a result from before the crawler recorded a locale: that page is fetched again");
    assert.deepEqual(progress.families.find((family) => family.family === "doctors"), { family: "doctors", total: 2, done: 2, fetched: 0, blocked: 0, emptyShells: 1, errors: 0 });
    assert.equal(progress.crawled, 0, "reused results do not count as fetched in this run");
    const coverage = await getCrawlCoverage(db, "p2");
    assert.equal(coverage.emptyShellUrls, 1, "reused results still count toward the analysis");
  });
});

describe("crawl counters", () => {
  it("match a full recount after saves, a retried save, a page-type change and a failure", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    const u = (path: string) => `https://z.com${path}`;
    await upsertSite(db, { id: "site", name: "z.com", baseUrl: "https://z.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "c1", siteId: "site", status: "running", createdAt: now });
    await enqueueAnalysisCrawlUrls(db, { analysisId: "c1", siteId: "site", urls: ["/a/1", "/a/2", "/a/3", "/b/1", "/b/2"].map((path) => ({ url: u(path), routeFamily: path.split("/")[1]! })) });
    const batch = [
      { url: u("/a/1"), page: page(u("/a/1"), { noindex: true }) },
      { url: u("/a/2"), page: page(u("/a/2"), { routeFamily: "moved" }) },
      { url: u("/b/1"), page: page(u("/b/1"), { status: 500 }) },
      { url: u("/b/2"), error: "timeout" },
    ];
    await saveCrawlBatch(db, { analysisId: "c1", outcomes: batch });
    const first = await getCrawlProgress(db, "c1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveCrawlBatch(db, { analysisId: "c1", outcomes: batch });
    const retried = await getCrawlProgress(db, "c1");
    assert.deepEqual(retried, first, "a retried save moves nothing");
    await recountCrawl(db, "c1");
    assert.deepEqual(await getCrawlProgress(db, "c1"), first, "counters equal a recount");
    assert.deepEqual({ total: first.total, pending: first.pending, crawled: first.crawled, failed: first.failed, noindex: first.noindex, httpErrors: first.httpErrors },
      { total: 5, pending: 1, crawled: 4, failed: 1, noindex: 1, httpErrors: 1 });
    assert.deepEqual(first.families.map((family) => [family.family, family.total, family.done]), [["a", 2, 1], ["b", 2, 2], ["moved", 1, 1]]);
    assert.deepEqual(first.recent.map((entry) => entry.url).sort(), batch.map((entry) => entry.url).sort());
  });
});

describe("crawl retention", () => {
  it("keeps crawl rows for the two latest finished analyses and anything newer, and every report and counter", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "r.com", baseUrl: "https://r.com", createdAt: now, updatedAt: now });
    const runs = [["old", "completed"], ["stopped", "cancelled"], ["previous", "completed"], ["latest", "completed"], ["later", "failed"], ["running", "running"]] as const;
    for (const [index, [id, status]] of runs.entries()) {
      await createAnalysis(db, { id, siteId: "site", status: "running", createdAt: `2026-10-0${index + 1}T00:00:00.000Z` });
      await enqueueAnalysisCrawlUrls(db, { analysisId: id, siteId: "site", urls: [{ url: `https://r.com/${id}`, routeFamily: "page" }] });
      if (status === "completed") await saveAnalysisReport(db, id, { coverage: null }, "done");
      else if (status !== "running") await updateAnalysisStatus(db, id, status);
    }
    assert.equal(await pruneCrawlResults(db, "site"), 0, "already pruned when the latest finished");
    const left = await db.prepare("SELECT DISTINCT analysis_id AS id FROM pages ORDER BY id").all<{ id: string }>();
    assert.deepEqual(left.results.map((row) => row.id), ["later", "latest", "previous", "running"]);
    assert.equal((await getCrawlProgress(db, "old")).total, 1, "an old analysis keeps its counts");
    assert.ok((await getAnalysisJob(db, "old"))?.report, "and its report");
  });
});

describe("run lifecycle", () => {
  it("never changes a finished run again: a dying run can't overwrite a cancel", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "z.com", baseUrl: "https://z.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "r1", siteId: "site", status: "queued", createdAt: now });
    assert.equal(await updateAnalysisStatus(db, "r1", "running"), true);
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

describe("soft 404s, near-duplicates and locales in coverage", () => {
  it("counts soft 404s (by flag and by the probe's title), near-duplicate groups with suffixed slugs, and the split by locale", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "c1", siteId: "site", status: "running", createdAt: now });
    const u = (path: string) => `https://x.com${path}`;
    const bio = (hospital: string, city: string) => `Dr Lim Ai Wei is a consultant obstetrician and gynaecologist at ${hospital} in ${city} with many years of experience. She completed her medical degree at the University of Malaya and her postgraduate training in obstetrics and gynaecology in Kuala Lumpur and Singapore. Her clinical interests include high-risk pregnancy, minimally invasive gynaecological surgery, fertility assessment and menopause care. She sees patients for antenatal care, routine screening, contraception advice and the management of fibroids and endometriosis. Dr Lim speaks English, Malay and Mandarin, and consults on weekdays with Saturday morning sessions for returning patients. Appointments can be made through the hospital's patient line or by WhatsApp; most insurers and company panels are accepted.`;
    const bioA = simhash(bio("Pantai Hospital", "Kuala Lumpur"));
    const bioB = simhash(bio("Gleneagles Hospital", "Penang"));
    const bioC = simhash("Dr Lim Ai Wei is a dermatologist at Sunway Medical Centre treating acne, eczema and psoriasis, offering laser treatments and mole checks with same-day appointments for urgent rashes.");
    const pages: CrawlPageResult[] = [
      page(u("/doctors/dr-lim-ai-wei"), { title: "Dr Lim Ai Wei", textHash: bioA, locale: "default" }),
      page(u("/doctors/dr-lim-ai-wei-7f3a2b"), { title: "Dr Lim Ai Wei", textHash: bioB, locale: "default" }),
      page(u("/doctors/dr-lim-ai-wei-derm"), { title: "Dr Lim Ai Wei", textHash: bioC, locale: "default" }),
      page(u("/doctors/dr-chen-san-san"), { title: "Dr Chen San San", textHash: bioA, locale: "default" }),
      page(u("/doctors/dr-chen-san-san-sunway"), { title: "Dr Chen San San", textHash: bioB, locale: "default" }),
      page(u("/"), { title: "Oops", locale: "default", routeFamily: "home" }),
      page(u("/shell"), { title: "Oops", locale: "default", isEmptyShell: true }),
      page(u("/treatments/old"), { title: "Page not found", softNotFound: true, locale: "default", noindex: false }),
      page(u("/treatments/older"), { title: "Oops", locale: "default" }),
      page(u("/id/doctors/dr-lim-ai-wei"), { title: "Dr Lim Ai Wei (ID)", locale: "id", noindex: true }),
      page(u("/id/doctors/dr-tan"), { title: "Dr Tan", locale: "id", noindex: true }),
    ];
    await enqueueAnalysisCrawlUrls(db, { analysisId: "c1", siteId: "site", urls: pages.map((entry) => ({ url: entry.url, routeFamily: entry.url === u("/") ? "home" : "doctors" })) });
    await saveCrawlBatch(db, { analysisId: "c1", outcomes: pages.map((entry) => ({ url: entry.url, page: entry })) });
    const plain = await getCrawlCoverage(db, "c1");
    assert.equal(plain.issues?.softNotFound, 1, "the flagged page");
    assert.equal(plain.issues?.nearDuplicate, 4, "two namesakes are the same page, and Dr Chen's two listings are too");
    assert.deepEqual(plain.nearDuplicateGroups, [
      { title: "Dr Chen San San", urls: [u("/doctors/dr-chen-san-san"), u("/doctors/dr-chen-san-san-sunway")], suffixed: false },
      { title: "Dr Lim Ai Wei", urls: [u("/doctors/dr-lim-ai-wei"), u("/doctors/dr-lim-ai-wei-7f3a2b")], suffixed: true },
    ], "a hospital name on the end is not a code; a hex code is");
    assert.deepEqual(plain.locales?.map((entry) => [entry.locale, entry.urls, entry.noindex]), [["default", 9, 0], ["id", 2, 2]]);
    const probed = await getCrawlCoverage(db, "c1", { notFoundTitle: "Oops" });
    assert.equal(probed.issues?.softNotFound, 2, "plus the one real page that shares the probe's title: not the homepage, not the empty shell");
    const everywhere = await getCrawlCoverage(db, "c1", { notFoundTitle: "Dr Lim Ai Wei" });
    assert.equal(everywhere.issues?.softNotFound, 1, "a title on more than a fifth of the pages is the site's template, not a not-found page");
    assert.equal(probed.notFoundTitle, "Oops");
    assert.ok(probed.issueExamples?.softNotFound?.some((example) => example.url === u("/treatments/older")));
    assert.ok(!probed.issueExamples?.softNotFound?.some((example) => example.url === u("/")), "the homepage is never a soft 404 by title");
  });

  it("reads 0 and no locales for crawls saved before these fields existed", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "old", siteId: "site", status: "running", createdAt: now });
    await enqueueAnalysisCrawlUrls(db, { analysisId: "old", siteId: "site", urls: [{ url: "https://x.com/a", routeFamily: "page" }] });
    await saveCrawlBatch(db, { analysisId: "old", outcomes: [{ url: "https://x.com/a", page: page("https://x.com/a") }] });
    await db.prepare("UPDATE pages SET result_json = json_remove(result_json, '$.locale', '$.textHash', '$.softNotFound') WHERE analysis_id = 'old'").run();
    const coverage = await getCrawlCoverage(db, "old");
    assert.deepEqual([coverage.issues?.softNotFound, coverage.issues?.nearDuplicate, coverage.locales], [0, 0, undefined]);
  });
});

describe("crawl queue query plans", () => {
  // Both queries once chose the index that walks every row of the analysis (one row read per
  // sitemap URL per batch); on a 23,000-URL site that used D1's daily row budget in one crawl.
  const db = openSqliteD1();
  const plan = async (sql: string, ...args: unknown[]) =>
    (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((row) => row.detail).join("; ");

  it("reads the next pending URLs off the crawl-state index, not the whole analysis", async () => {
    assert.match(await plan("SELECT url FROM pages WHERE analysis_id = ? AND crawl_state = 'pending' LIMIT ?", "a", 100), /idx_pages_analysis_crawl_state/);
  });

  it("finds a batch's rows by primary key, not by scanning every pending row", async () => {
    assert.match(
      await plan("SELECT route_family, SUM(1) FROM pages WHERE analysis_id = ? AND +crawl_state = 'pending' AND url IN (?, ?) GROUP BY route_family", "a", "u1", "u2"),
      /analysis_id=\? AND url=\?/,
    );
  });
});

describe("content signals in result_json", async () => {
  const db = openSqliteD1();
  const now = new Date().toISOString();
  await upsertSite(db, { id: "cs", name: "y.com", baseUrl: "https://y.com", createdAt: now, updatedAt: now });
  await createAnalysis(db, { id: "cs1", siteId: "cs", status: "running", createdAt: now });
  await enqueueAnalysisCrawlUrls(db, { analysisId: "cs1", siteId: "cs", urls: [{ url: "https://y.com/blog/a", routeFamily: "blog" }] });

  it("keeps every new per-page signal", async () => {
    const signals = { redirectHops: 2, hsts: true, lang: "en", viewport: false, images: 3, imagesNoAlt: 1, mixedContent: 1, httpLinks: 2, externalLinks: 4, h1: "A", words: 120, questionHeadings: 1, listsOrTables: true, leadWords: 40, statistics: 5, quotes: 1, modified: "2024-01-01", articleLike: true, author: false, snippetBlocked: true, landmarks: 2, headingSkips: true, entitySchema: false };
    await saveCrawlBatch(db, { analysisId: "cs1", outcomes: [{ url: "https://y.com/blog/a", page: page("https://y.com/blog/a", signals) }] });
    const row = await db.prepare("SELECT result_json FROM pages WHERE analysis_id = 'cs1'").first<{ result_json: string }>();
    const saved = JSON.parse(row!.result_json) as Record<string, unknown>;
    for (const [key, value] of Object.entries(signals)) assert.deepEqual(saved[key], value, key);
  });
});
