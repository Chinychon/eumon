import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, getSite, saveAnalysisReport, saveCrawlBatch, upsertSite, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import type { GooglebotCrawlOutcome } from "@organic-growth/crawler";
import { DEMO_SITE_ID, seedDemoSite } from "@organic-growth/agents";
import { getAnalysisJob } from "@organic-growth/db";
import { CHECKS_PER_REQUEST, checkSearchConsoleUrls, importExport, MAX_URLS_PER_IMPORT, searchConsoleView } from "./search-console-import.ts";

const AT = "2026-10-01T00:00:00.000Z";
const u = (path: string) => `https://x.com${path}`;
const page = (url: string, status: number, extra: Partial<CrawlPageResult> = {}): CrawlPageResult => ({
  url, status, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1000, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 500, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", ...extra,
});
const csv = (lines: string[]) => `${lines.join("\r\n")}\r\n`;

/** A site whose latest crawl knows two live doctor pages. */
async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
  await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: AT });
  const pages = [page(u("/doctors/dr-a"), 200), page(u("/doctors/dr-catherine-lee-tong-how"), 200)];
  await enqueueAnalysisCrawlUrls(db, { analysisId: "a1", siteId: "s", urls: pages.map((entry) => ({ url: entry.url, routeFamily: "doctors" })) });
  await saveCrawlBatch(db, { analysisId: "a1", outcomes: pages.map((entry) => ({ url: entry.url, page: entry })) });
  await saveAnalysisReport(db, "a1", { findings: [] }, "done");
  return { db: db as D1Like, site: (await getSite(db, "s"))! };
}

describe("Search Console import", () => {
  it("imports a URL list, taking the reason from the file name, and counts the live checks still to do", async () => {
    const { db, site: record } = await site();
    const text = csv(["URL,Last crawled", `${u("/doctors/dr-a")},2026-09-30`, `${u("/old/one")},2026-09-29`]);
    assert.deepEqual(await importExport(db, record, text, { fileName: "x.com-Coverage-Drilldown-2026-10-09 Excluded by 'noindex' tag.zip" }),
      { kind: "urls", reason: "noindex", imported: 2, otherHost: 0, remainingChecks: 1 });
    const unnamed = await importExport(db, record, text, { fileName: "Table.csv" });
    assert.ok("error" in unnamed && /reason/i.test(unnamed.error), "a URL list needs a reason");
    assert.deepEqual(await importExport(db, record, text, { fileName: "Table.csv", reason: "not_found" }), { kind: "urls", reason: "not_found", imported: 2, otherHost: 0, remainingChecks: 1 });
  });

  it("refuses a list from another property and a file it cannot read", async () => {
    const { db, site: record } = await site();
    const elsewhere = await importExport(db, record, csv(["URL,Last crawled", "https://other.example/a,2026-09-30"]), { reason: "noindex" });
    assert.ok("error" in elsewhere && /other\.example|another/i.test(elsewhere.error), elsewhere && "error" in elsewhere ? elsewhere.error : "");
    const junk = await importExport(db, record, csv(["a,b", "1,2"]), { reason: "noindex" });
    assert.ok("error" in junk && /URL/.test(junk.error));
  });

  it("caps one import at a few thousand URLs, and checks ten URLs a request", async () => {
    const { db, site: record } = await site();
    assert.equal(CHECKS_PER_REQUEST, 10);
    const many = csv(["URL,Last crawled", ...Array.from({ length: MAX_URLS_PER_IMPORT + 1 }, (_, i) => `${u(`/doctors/d${i}`)},2026-09-30`)]);
    const outcome = await importExport(db, record, many, { reason: "discovered" });
    assert.ok("error" in outcome && new RegExp(MAX_URLS_PER_IMPORT.toLocaleString("en")).test(outcome.error), "error" in outcome ? outcome.error : "imported");
  });

  it("pairs a gone URL the crawl already knows with a live page during the check pass", async () => {
    const { db, site: record } = await site();
    await createAnalysis(db, { id: "a2", siteId: "s", status: "running", createdAt: "2026-10-05T00:00:00.000Z" });
    await enqueueAnalysisCrawlUrls(db, { analysisId: "a2", siteId: "s", urls: [{ url: u("/doctors/catherine-lee"), routeFamily: "doctors" }, { url: u("/doctors/dr-catherine-lee-tong-how"), routeFamily: "doctors" }] });
    await saveCrawlBatch(db, { analysisId: "a2", outcomes: [{ url: u("/doctors/catherine-lee"), page: page(u("/doctors/catherine-lee"), 404) }, { url: u("/doctors/dr-catherine-lee-tong-how"), page: page(u("/doctors/dr-catherine-lee-tong-how"), 200) }] });
    await saveAnalysisReport(db, "a2", { findings: [] }, "done");
    await importExport(db, record, csv(["URL,Last crawled", `${u("/doctors/catherine-lee")},2026-09-30`]), { reason: "not_found" });
    assert.deepEqual(await checkSearchConsoleUrls(db, record, { crawl: async () => [] }), { checked: 0, remaining: 0 }, "nothing to fetch: the crawl knows it");
    assert.deepEqual((await searchConsoleView(db, "s")).suggestions, [{ url: u("/doctors/catherine-lee"), suggestedUrl: u("/doctors/dr-catherine-lee-tong-how") }]);
  });

  it("records the overview table and the chart, and the view carries both", async () => {
    const { db, site: record } = await site();
    assert.deepEqual(await importExport(db, record, csv(["Reason,Source,Validation,Trend,Pages", 'Discovered - currently not indexed,Google systems,Not Started,,"23,100"', "Excluded by 'noindex' tag,Website,Failed,,468"]), {}), { kind: "table", imported: 2 });
    assert.deepEqual(await importExport(db, record, csv(["Date,Indexed,Not indexed", "2026-09-19,1774,3309", "2026-09-22,1561,24498"]), {}), { kind: "chart", imported: 2 });
    const view = await searchConsoleView(db, "s", new Date("2026-10-09T00:00:00Z"));
    assert.equal(view.summary?.rows.length, 2);
    assert.deepEqual(view.history, [{ day: "2026-09-19", indexed: 1774, notIndexed: 3309 }, { day: "2026-09-22", indexed: 1561, notIndexed: 24498 }]);
    assert.equal(view.importedAt, null, "no URL list yet");
  });

  it("checks unknown URLs a few at a time, keeps a redirect suggestion for a gone one, and stops at zero", async () => {
    const { db, site: record } = await site();
    await importExport(db, record, csv(["URL,Last crawled", `${u("/doctors/dr-a")},2026-09-30`, `${u("/doctors/catherine-lee")},2026-09-29`, `${u("/old/two")},2026-09-29`, `${u("/old/three")},2026-09-29`, `${u("/old/four")},2026-09-29`]), { reason: "noindex" });
    const script: Record<string, GooglebotCrawlOutcome> = {
      [u("/doctors/catherine-lee")]: { url: u("/doctors/catherine-lee"), page: page(u("/doctors/catherine-lee"), 404) },
      [u("/old/two")]: { url: u("/old/two"), page: page(u("/old/two"), 200, { finalUrl: u("/doctors/dr-a") }) },
      [u("/old/three")]: { url: u("/old/three"), page: page(u("/old/three"), 200) },
      [u("/old/four")]: { url: u("/old/four"), error: "The crawler could not fetch this URL." },
    };
    const fetched: string[][] = [];
    const crawl = async (urls: string[]) => { fetched.push(urls); return urls.map((url) => script[url]!); };
    assert.deepEqual(await checkSearchConsoleUrls(db, record, { limit: 2, crawl }), { checked: 2, remaining: 2 });
    assert.deepEqual(await checkSearchConsoleUrls(db, record, { limit: 2, crawl }), { checked: 2, remaining: 0 });
    assert.deepEqual(await checkSearchConsoleUrls(db, record, { limit: 2, crawl }), { checked: 0, remaining: 0 });
    assert.deepEqual(fetched.flat().sort(), [u("/doctors/catherine-lee"), u("/old/four"), u("/old/three"), u("/old/two")], "the crawl's own page is never fetched");
    const view = await searchConsoleView(db, "s");
    const noindex = view.reasons[0]!;
    assert.deepEqual(noindex.today, { indexable: 2, noindex: 0, redirect: 1, gone: 1, error: 1, unchecked: 0 }, "a fetch failure counts as an error, not as waiting");
    assert.deepEqual(view.suggestions, [{ url: u("/doctors/catherine-lee"), suggestedUrl: u("/doctors/dr-catherine-lee-tong-how") }]);
    assert.equal(view.remainingChecks, 0);
  });

  it("gives the demo an import to show: reasons reconciled, redirect suggestions, and the three findings in its latest analysis", async () => {
    const db = openSqliteD1();
    await seedDemoSite(db, Date.now());
    const view = await searchConsoleView(db, DEMO_SITE_ID);
    const noindex = view.reasons.find((entry) => entry.reason === "noindex")!;
    assert.ok(noindex.today.indexable > 0 && noindex.today.redirect > 0 && noindex.today.gone > 0, JSON.stringify(noindex.today));
    assert.ok(view.suggestions.length >= 10, `suggestions ${view.suggestions.length}`);
    assert.ok(view.history.length >= 10 && view.summary, "the chart and the overview");
    assert.equal(view.remainingChecks, 0, "the demo's live checks are pre-recorded");
    const titles = ((await getAnalysisJob(db, "analysis_demo_2"))!.report as { findings: Array<{ title: string }> }).findings.map((finding) => finding.title);
    assert.ok(titles.some((title) => /^Google has indexed/.test(title)), titles.join(" | "));
    assert.ok(titles.some((title) => /excluded as noindex are indexable now$/.test(title)));
    assert.ok(titles.some((title) => /return 404; \d+ match a live page$/.test(title)));
  });
});
