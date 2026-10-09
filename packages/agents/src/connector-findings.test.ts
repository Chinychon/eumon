import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlLogView, type LinksInput, type SerpResult } from "@organic-growth/core";
import { findingsFromCrawlLog, findingsFromInventory, findingsFromSearchConsoleImport, findingsFromTrends, linkGapOpportunity, withSerpContext, type InventorySignal, type LogCoverage, type TrendSignals } from "./connector-findings.js";
import { buildOpportunities, gapOpportunities, synthesizeGrowthPlan } from "./index.js";

const view = (googlebot: { ok: number; redirect?: number; missing?: number; error?: number; query?: number }) => crawlLogView([
  { day: "2026-10-05", bot: "googlebot", family: "doctors", statusClass: "2xx", query: false, hits: googlebot.ok },
  { day: "2026-10-05", bot: "googlebot", family: "doctors", statusClass: "3xx", query: false, hits: googlebot.redirect ?? 0 },
  { day: "2026-10-05", bot: "googlebot", family: "doctors", statusClass: "4xx", query: false, hits: googlebot.missing ?? 0 },
  { day: "2026-10-05", bot: "googlebot", family: "doctors", statusClass: "5xx", query: false, hits: googlebot.error ?? 0 },
  { day: "2026-10-05", bot: "googlebot", family: "search", statusClass: "2xx", query: true, hits: googlebot.query ?? 0 },
], "2026-10-09");

describe("crawl-log findings", () => {
  it("names the page types Googlebot skips, and the requests it wastes", () => {
    const coverage: LogCoverage = {
      days: 30,
      families: [
        { family: "procedures", sitemapUrls: 3000, unrequested: 2400, examples: ["https://x.com/procedures/a"] },
        { family: "doctors", sitemapUrls: 7000, unrequested: 700, examples: [] },
        { family: "blog", sitemapUrls: 15, unrequested: 15, examples: [] },
      ],
      view: view({ ok: 500, redirect: 150, error: 40, query: 300 }),
    };
    const findings = findingsFromCrawlLog({ siteId: "s", analysisId: "a", coverage });
    // 190 of 990 requests (19%) were redirects or errors: under the 20% that makes a finding.
    assert.deepEqual(findings.map((finding) => finding.title), [
      "Googlebot hasn't requested 80% of the /procedures/ pages in 30 days",
      "30% of Googlebot's requests are for URLs with query strings",
    ], "a page type mostly fetched, or too small to judge, is not a finding");
    assert.equal(findings[0]!.severity, "HIGH");
    assert.deepEqual(findings[0]!.pagesAffected, ["https://x.com/procedures/a"]);
  });

  it("waits for two weeks of logs before saying a page type is skipped", () => {
    const coverage: LogCoverage = { days: 6, families: [{ family: "procedures", sitemapUrls: 3000, unrequested: 2400, examples: [] }], view: view({ ok: 10 }) };
    assert.deepEqual(findingsFromCrawlLog({ siteId: "s", analysisId: "a", coverage }), []);
  });

  it("says how much of Googlebot's crawl goes to redirects and errors", () => {
    const coverage: LogCoverage = { days: 30, families: [], view: view({ ok: 600, redirect: 200, error: 100 }) };
    const [finding] = findingsFromCrawlLog({ siteId: "s", analysisId: "a", coverage });
    assert.equal(finding!.title, "33% of Googlebot's requests hit redirects or errors");
    assert.equal(finding!.organicImpactScore, 60, "server errors also slow Google's crawl");
  });
});

const links: LinksInput = {
  site: "x.com", competitors: ["rival.example"], synced: true,
  summaries: [
    { periodEnd: "2026-10-05", row: { domain: "x.com", rank: 100, backlinks: 300, referringDomains: 40, referringMainDomains: 40, brokenBacklinks: 0, spamScore: 1 } },
    { periodEnd: "2026-10-05", row: { domain: "rival.example", rank: 400, backlinks: 9000, referringDomains: 600, referringMainDomains: 600, brokenBacklinks: 0, spamScore: 1 } },
  ],
  gap: { periodEnd: "2026-10-05", rows: Array.from({ length: 30 }, (_, i) => ({ domain: `site${i}.example`, rank: 100 + i, backlinks: 2, linksTo: ["rival.example"] })) },
};

const serp = (keyword: string, extra: Partial<SerpResult> = {}): SerpResult => ({
  keyword, checkedAt: "2026-10-08", volume: 5400, features: ["ai_overview", "local_pack"], position: null, url: null, aiOverviewSources: ["rival.example"], cited: false,
  organic: [{ position: 1, domain: "rival.example", url: "https://rival.example/a", title: "A" }, { position: 2, domain: "dir.example", url: "https://dir.example/b", title: "B" }], ...extra,
});

describe("links and results pages in the plan", () => {
  it("turns the link gap into one opportunity, weighted when the site trails", () => {
    const opportunity = linkGapOpportunity(links, "s", "a")!;
    assert.equal(opportunity.title, "Earn links from the 30 sites that link to your competitors but not to you");
    assert.match(opportunity.rationale, /^rival\.example has 600 referring domains to your 40\. 30 sites link to rival\.example and not to you, the strongest being site29\.example, site28\.example, site27\.example/);
    assert.equal(opportunity.priorityScore, Number((8 * Math.log10(31) * 1.5).toFixed(2)));
    assert.equal(linkGapOpportunity({ ...links, gap: { periodEnd: "", rows: links.gap!.rows.slice(0, 4) } }, "s", "a"), null, "a handful of sites is not a plan");
  });

  it("adds what the results page holds to an opportunity about that search", () => {
    const [gap] = gapOpportunities([{ keyword: "dj stent di penang", volume: 5400, difficulty: 0, intent: "transactional", domain: "rival.example", position: 15, url: "/x" }], "s", "a");
    const [annotated] = withSerpContext([gap!], [serp("DJ stent di Penang")]);
    assert.match(annotated!.rationale, /Google's page for it shows an AI Overview and a map pack above the links; the AI Overview cites other sites, so answering the question directly matters; the top three are rival\.example, dir\.example \(checked 2026-10-08\)\.$/);
    assert.equal(withSerpContext([gap!], [])[0], gap, "no results page, no change");
  });

  it("puts links, results pages and suggested competitors into the growth plan", () => {
    const bundle = {
      siteId: "s", analysisId: "a", baseUrl: "https://x.com", findings: [], competitors: [], searchMetrics: [],
      connectors: { links, serp: [serp("ivf cost")], suggestions: [{ domain: "found.example", kind: "competitor" as const, keywords: 9, avgPosition: 3, visibility: 0.4, traffic: 300, markets: ["idn"] }] },
    };
    assert.ok(buildOpportunities(bundle).some((opportunity) => opportunity.intent === "link_gap"));
    const plan = synthesizeGrowthPlan(bundle);
    assert.ok(plan.constraints.includes("No competitor domains have been supplied; Google's results for your searches show found.example winning them."), plan.constraints.join(" | "));
    const checked = plan.sections.find((section) => section.title === "What I checked")!.body;
    assert.match(checked, /7\. Google's results pages for 1 of your biggest searches \(1 with an AI Overview\)\n8\. Backlinks for you and 1 competitors, and 30 sites in the link gap/);
    const priority = plan.priorities.find((entry) => entry.title.startsWith("Earn links"))!;
    assert.match(priority.contentRequired, /Never buy links/);
    assert.match(plan.sections.find((section) => section.title === "Strategy sequence")!.body, /Add the competitors that win your searches \(found\.example\)[\s\S]*Earn links from the sites that already link to your competitors/);
  });
});

describe("Search Console import findings", () => {
  const today = (over: Partial<Record<string, number>>) => ({ indexable: 0, noindex: 0, redirect: 0, gone: 0, error: 0, unchecked: 0, ...over });
  const summary = (indexed: number, notIndexed: number) => ({ importedAt: "2026-10-09", rows: [
    { reason: "indexed" as const, reasonText: "Indexed", source: null, validation: null, pages: indexed },
    { reason: "discovered" as const, reasonText: "Discovered - currently not indexed", source: "Google systems", validation: "Not Started", pages: notIndexed },
  ] });

  it("names a low indexed share, noindex URLs that are indexable now, and dead URLs with their redirects", () => {
    const findings = findingsFromSearchConsoleImport({ siteId: "s", analysisId: "a", view: {
      importedAt: "2026-10-09T00:00:00.000Z", summary: summary(1561, 24498), remainingChecks: 0, counts: null,
      reasons: [
        { reason: "noindex", reasonText: "Excluded by 'noindex' tag", urls: 468, today: today({ indexable: 207, redirect: 199, noindex: 35, gone: 27 }), examples: { indexable: ["https://x.com/doctors/dr-a"] } },
        { reason: "not_found", reasonText: "Not found (404)", urls: 6, today: today({ gone: 6 }), examples: {} },
      ],
      suggestions: Array.from({ length: 30 }, (_, i) => ({ url: `https://x.com/doctors/old-${i}`, suggestedUrl: `https://x.com/doctors/dr-new-${i}` })),
    } });
    assert.deepEqual(findings.map((finding) => finding.title), [
      "Google has indexed 1,561 of the 26,059 URLs it knows (6%)",
      "207 URLs Google excluded as noindex are indexable now",
      "33 old URLs Google still crawls return 404; 30 match a live page",
    ]);
    assert.ok(findings.every((finding) => finding.category === "indexing" && finding.recommendation));
    const dead = findings[2]!;
    assert.equal((dead.evidence.suggestions as unknown[]).length, 25, "evidence carries at most 25 pairs");
    assert.equal(dead.pagesAffected?.length, 30, "the dead URLs it can name: the suggested ones (the fixture has no gone examples)");
  });

  it("stays quiet under the thresholds, and without an import", () => {
    assert.deepEqual(findingsFromSearchConsoleImport({ siteId: "s", analysisId: "a", view: null }), []);
    const quiet = findingsFromSearchConsoleImport({ siteId: "s", analysisId: "a", view: {
      importedAt: "2026-10-09T00:00:00.000Z", summary: summary(900, 100), remainingChecks: 0, counts: null,
      reasons: [{ reason: "noindex", reasonText: "Excluded by 'noindex' tag", urls: 12, today: today({ indexable: 9, gone: 3 }), examples: {} }], suggestions: [],
    } });
    assert.deepEqual(quiet, [], "90% indexed, 9 indexable, 3 gone: none reaches its threshold");
  });

  it("takes Google's indexed count from the chart when the table has no Indexed row, as the real export does", () => {
    const table = { importedAt: "2026-10-09", rows: [{ reason: "discovered" as const, reasonText: "Discovered - currently not indexed", source: "Google systems", validation: "Not Started", pages: 23100 }] };
    const withChart = findingsFromSearchConsoleImport({ siteId: "s", analysisId: "a", view: { importedAt: null, summary: table, counts: { day: "2026-10-04", indexed: 1561, notIndexed: 24498 }, reasons: [], suggestions: [], remainingChecks: 0 } });
    assert.deepEqual(withChart.map((finding) => finding.title), ["Google has indexed 1,561 of the 26,059 URLs it knows (6%)"]);
    const tableOnly = findingsFromSearchConsoleImport({ siteId: "s", analysisId: "a", view: { importedAt: null, summary: table, counts: null, reasons: [], suggestions: [], remainingChecks: 0 } });
    assert.deepEqual(tableOnly, [], "the table alone never says how many are indexed");
  });
});

describe("trend findings", () => {
  const day = (offset: number, from: string) => new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const series = (values: number[], from = "2026-07-01") => values.map((value, index) => ({ day: day(index, from), value }));
  const logs = (days: number, hits: number) => Array.from({ length: days }, (_, index) => ({ day: day(-1 - index, "2026-10-09"), bot: "googlebot", family: "doctors", statusClass: "2xx", query: false, hits }));
  const signals = (over: Partial<TrendSignals>): TrendSignals => ({ impressions: [], indexed: [], notIndexed: [], indexedSource: null, crawlLog: [], today: "2026-10-09", ...over });

  it("names an impressions fall, and the indexed fall that happened with it", () => {
    // 1 Jul → 20 Sep rising to a peak of about 4,900 a day around 21 Sep, then 80% lower.
    const impressions = series([...Array(82).fill(0).map((_, i) => 400 + i * 50), ...Array(18).fill(950)]);
    const indexed = [{ day: "2026-09-15", value: 88 }, { day: "2026-09-19", value: 1774 }, { day: "2026-09-22", value: 1561 }, { day: "2026-10-04", value: 1561 }];
    const findings = findingsFromTrends({ siteId: "s", analysisId: "a", trends: signals({ impressions, indexed, indexedSource: "search_console" }), sitemapUrls: 22913, discovered: 23100 });
    const fall = findings.find((finding) => finding.title.startsWith("Search impressions fell"))!;
    assert.match(fall.title, /^Search impressions fell 7\d% since Sep 20$/);
    assert.equal(fall.category, "search");
    assert.match(fall.summary, /indexed count fell from 1,774 to 1,561/);
    const indexedFall = findings.find((finding) => finding.title.startsWith("Google's indexed count fell"))!;
    assert.equal(indexedFall.title, "Google's indexed count fell from 1774 to 1561 since Sep 19");
    assert.match(indexedFall.summary, /Search Console/);
  });

  it("does not tie an indexed fall to the impressions fall when the dates are weeks apart", () => {
    const impressions = series([...Array(82).fill(0).map((_, i) => 400 + i * 50), ...Array(18).fill(950)]);
    const indexed = [{ day: "2026-07-20", value: 1774 }, { day: "2026-07-25", value: 1561 }, { day: "2026-10-04", value: 1561 }];
    const fall = findingsFromTrends({ siteId: "s", analysisId: "a", trends: signals({ impressions, indexed, indexedSource: "search_console" }), sitemapUrls: null, discovered: null }).find((finding) => finding.title.startsWith("Search impressions fell"))!;
    assert.doesNotMatch(fall.summary, /indexed count fell/);
  });

  it("trusts the inspection sample's fall only when Google's not-indexed count rose with it, not when pages were unpublished", () => {
    const indexed = [{ day: "2026-09-01", value: 500 }, { day: "2026-10-01", value: 420 }];
    const unpublished = findingsFromTrends({ siteId: "s", analysisId: "a", trends: signals({ indexed, indexedSource: "inspection", notIndexed: [{ day: "2026-09-01", value: 20 }, { day: "2026-10-01", value: 20 }] }), sitemapUrls: null, discovered: null });
    assert.deepEqual(unpublished, [], "80 fewer indexed pages but none more left out: the operator unpublished them");
    const dropped = findingsFromTrends({ siteId: "s", analysisId: "a", trends: signals({ indexed, indexedSource: "inspection", notIndexed: [{ day: "2026-09-01", value: 20 }, { day: "2026-10-01", value: 90 }] }), sitemapUrls: null, discovered: null });
    assert.equal(dropped[0]?.title, "Google's indexed count fell from 500 to 420 since Sep 1");
    assert.match(dropped[0]!.summary, /inspection sample/);
  });

  it("says how long Googlebot takes to get round the sitemap at its current pace", () => {
    const [pace] = findingsFromTrends({ siteId: "s", analysisId: "a", trends: signals({ crawlLog: logs(28, 25) }), sitemapUrls: 1785, discovered: 660 });
    assert.equal(pace!.title, "At Googlebot's pace the sitemap takes 72 days to crawl once");
    assert.match(pace!.summary, /25 requests a day/);
    assert.match(pace!.summary, /660 .*discovered/i);
    assert.equal(pace!.category, "indexing");
  });

  it("stays quiet on rising or small series, short logs, small sitemaps, and without signals", () => {
    assert.deepEqual(findingsFromTrends({ siteId: "s", analysisId: "a", trends: null, sitemapUrls: 1785, discovered: null }), []);
    const rising = signals({ impressions: series(Array.from({ length: 100 }, (_, i) => 100 + i * 20)), indexed: series([300, 320, 350]), indexedSource: "inspection", crawlLog: logs(28, 400) });
    assert.deepEqual(findingsFromTrends({ siteId: "s", analysisId: "a", trends: rising, sitemapUrls: 1785, discovered: null }), []);
    const tiny = signals({ impressions: series([...Array(50).fill(60), ...Array(30).fill(10)]), crawlLog: logs(10, 5) });
    assert.deepEqual(findingsFromTrends({ siteId: "s", analysisId: "a", trends: tiny, sitemapUrls: 150, discovered: null }), [], "under 100 a day, ten days of logs, 150 URLs");
  });
});

describe("inventory findings", () => {
  const fields = (over: Array<[string, string, number, number, string?]>) => over.map(([key, label, filled, share, language]) => ({ key, label, filled, share, ...(language ? { language } : {}) }));
  const base = (records: number): InventorySignal => ({
    dataset: { id: "d", name: "Doctors", entityType: "doctor", records },
    inventory: { records, fields: [], languages: [], duplicates: { groups: 0, records: 0, examples: [] }, pages: null },
  });

  it("names the language a field is missing in, the records listed twice, and the thin pages", () => {
    const signal: InventorySignal = { ...base(7704), inventory: {
      records: 7704,
      fields: fields([["name", "Name", 7704, 1], ["bio_en", "Bio (EN)", 7074, 0.918, "EN"], ["bio_id", "Bio (ID)", 7077, 0.919, "ID"], ["bio_zh", "Bio (ZH)", 7077, 0.919, "ZH"]]),
      languages: [{ base: "Bio", variants: [{ language: "EN", filled: 7074, share: 0.918 }, { language: "ID", filled: 7077, share: 0.919 }, { language: "ZH", filled: 7077, share: 0.919 }] }],
      duplicates: { groups: 20, records: 40, examples: [{ name: "Dr Lim Ai Wei", keys: ["a", "b"] }] },
      pages: { linked: 7000, thin: 596, gone: 18, unreached: 0, examples: { thin: ["https://x.com/doctors/a"], gone: [] } },
    } };
    const findings = findingsFromInventory({ siteId: "s", analysisId: "a", inventories: [signal] });
    assert.deepEqual(findings.map((finding) => finding.title), [
      "630 of 7,704 doctors have no Bio (EN)",
      "40 doctors are listed more than once",
      "596 doctor pages have almost no content",
    ]);
    assert.ok(findings.every((finding) => finding.category === "content"));
    assert.match(findings[0]!.summary, /92%/);
    assert.deepEqual(findings[1]!.evidence.examples, [{ name: "Dr Lim Ai Wei", keys: ["a", "b"] }]);
    assert.match(findings[1]!.summary, /may be the same/, "a shared name is a suspicion, not a verdict");
    assert.match(findings[1]!.recommendation ?? "", /deletes the extra records/i, "Merge duplicates applies, it does not propose");
  });

  it("takes the plural from the dataset's name, and never rounds a gap up to 100% filled", () => {
    const specialties: InventorySignal = { dataset: { id: "d2", name: "Specialties", entityType: "specialty", records: 200 }, inventory: {
      records: 200, fields: fields([["overview", "Overview", 40, 0.2]]), languages: [], duplicates: { groups: 0, records: 0, examples: [] },
      pages: { linked: 200, thin: 30, gone: 2, unreached: 1, examples: { thin: ["https://x.com/specialties/a"], gone: ["https://x.com/specialties/z"] } },
    } };
    const titles = findingsFromInventory({ siteId: "s", analysisId: "a", inventories: [specialties] }).map((finding) => finding.title);
    assert.deepEqual(titles, ["160 of 200 specialties have no Overview", "30 specialty pages have almost no content"]);
    const nearlyFull: InventorySignal = { ...base(50000), inventory: { ...base(50000).inventory, fields: fields([["bio_en", "Bio (EN)", 49950, 0.999, "EN"]]), languages: [{ base: "Bio", variants: [{ language: "EN", filled: 49950, share: 0.999 }] }] } };
    const [finding] = findingsFromInventory({ siteId: "s", analysisId: "a", inventories: [nearlyFull] });
    assert.equal(finding?.title, "50 of 50,000 doctors have no Bio (EN)");
    assert.match(finding!.summary, /99%/);
    assert.doesNotMatch(finding!.summary, /100%/);
  });

  it("stays quiet on small datasets, well-filled fields, few duplicates and few thin pages", () => {
    const small = { ...base(40), inventory: { ...base(40).inventory, fields: fields([["bio_en", "Bio (EN)", 10, 0.25, "EN"]]), duplicates: { groups: 5, records: 10, examples: [] } } };
    assert.deepEqual(findingsFromInventory({ siteId: "s", analysisId: "a", inventories: [small] }), [], "under 50 records");
    const fine = { ...base(500), inventory: { ...base(500).inventory, fields: fields([["bio", "Bio", 480, 0.96], ["phone", "Phone", 300, 0.6]]), duplicates: { groups: 1, records: 3, examples: [] }, pages: { linked: 500, thin: 9, gone: 0, unreached: 0, examples: { thin: [], gone: [] } } } };
    assert.deepEqual(findingsFromInventory({ siteId: "s", analysisId: "a", inventories: [fine] }), [], "96% filled, phone under 50% but only 200 missing is... fine? no: 200 missing of 500 at 60% is above the 50% line");
    const plain = { ...base(500), inventory: { ...base(500).inventory, fields: fields([["overview", "Overview", 60, 0.12]]) } };
    assert.deepEqual(findingsFromInventory({ siteId: "s", analysisId: "a", inventories: [plain] }).map((finding) => finding.title), ["440 of 500 doctors have no Overview"], "a plain field under half filled");
  });
});
