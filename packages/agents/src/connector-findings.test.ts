import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlLogView, type LinksInput, type SerpResult } from "@organic-growth/core";
import { findingsFromCrawlLog, linkGapOpportunity, withSerpContext, type LogCoverage } from "./connector-findings.js";
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
