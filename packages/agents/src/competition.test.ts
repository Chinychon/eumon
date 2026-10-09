import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonLlm, JsonRequest } from "@organic-growth/ai";
import type { Fetcher, PageInspection, SiteResearch } from "@organic-growth/crawler";
import { compareCompetition, competitionOpportunities, contentKey, contentTypeEntries, counted, labelContentTypes, type OwnContent } from "./competition.js";
import { synthesizeGrowthPlan } from "./index.js";
import { runFullAnalysis } from "./pipeline.js";

const inspection = (url: string, overrides: Partial<PageInspection> = {}): PageInspection => ({
  url, family: "x", status: 200, textLength: 3000, emptyShell: false, schemaTypes: ["WebPage"], faq: false,
  conversion: { whatsapp: false, phone: false, email: false, form: true, booking: false, prices: false }, tracking: [], ...overrides,
});

const rival = (domain: string, families: Array<[string, number]>, pages: PageInspection[] = []): SiteResearch => ({
  domain, origin: `https://${domain}`, allowed: true, pages,
  sitemap: {
    origin: `https://${domain}`, filesRead: 3, filesListed: 3, urlsSeen: 0, estimatedUrls: families.reduce((sum, [, n]) => sum + n, 0), partial: false, languages: {}, notes: [],
    families: families.map(([family, estimated]) => ({ family, urls: estimated, estimated, examples: [`https://${domain}/${family}/example`] })),
  },
});

const own: OwnContent = {
  domain: "medbay.example",
  families: { doctors: 7000, blog: 40, page: 12, home: 1 },
  pages: [inspection("https://medbay.example/doctors/amy")],
  datasets: [{ name: "Treatments", entityType: "treatment", records: 412, livePages: 0 }],
};

describe("compareCompetition", () => {
  const research = [
    rival("rival-a.example", [["treatments", 3400], ["doctors", 1200], ["blog", 300], ["tag", 5000]], [
      inspection("https://rival-a.example/treatments/ivf", { schemaTypes: ["MedicalProcedure", "FAQPage"], faq: true, conversion: { whatsapp: true, phone: true, email: false, form: true, booking: true, prices: true } }),
    ]),
    rival("rival-b.example", [["treatments", 900], ["cities", 120]], [
      inspection("https://rival-b.example/treatments/lasik", { conversion: { whatsapp: true, phone: false, email: false, form: false, booking: false, prices: true } }),
    ]),
  ];
  const report = compareCompetition(own, research);
  const row = (key: string) => report.rows.find((entry) => entry.key === key);

  it("finds content gaps, advantages, and data the site already holds", () => {
    assert.equal(row("treatment")?.status, "gap");
    assert.deepEqual(row("treatment")?.data, { dataset: "Treatments", records: 412, livePages: 0 });
    assert.equal(row("treatment")?.competitors[0]?.domain, "rival-a.example");
    assert.equal(row("doctor")?.status, "advantage");
    assert.equal(row("blog")?.status, "gap");
    assert.equal(row("city")?.status, "gap");
    assert.equal(row("tag"), undefined, "taxonomy sections are not content");
    assert.equal(report.rows[0]?.key, "treatment", "the largest gap comes first");
  });

  it("explains the gaps, the data, and conversion differences in plain language", () => {
    assert.ok(report.insights[0]?.includes("rival-a.example publishes ~3,400 /treatments/ pages; you have none. You already hold 412 records in “Treatments” but publish none of them."), report.insights[0]);
    assert.ok(report.insights.some((insight) => insight.includes("You publish ~7,000 /doctors/ pages")));
    assert.ok(report.insights.some((insight) => insight.startsWith("2 of 2 competitors show prices")));
    assert.ok(report.insights.some((insight) => insight.startsWith("2 of 2 competitors offer a WhatsApp contact")));
    assert.ok(report.insights.some((insight) => insight.includes("MedicalProcedure")));
  });

  it("ranks the gap backed by existing data above gaps that need new data", () => {
    const opportunities = competitionOpportunities(report, "s", "a").sort((a, b) => b.priorityScore - a.priorityScore);
    assert.equal(opportunities[0]?.title, "Publish your Treatments data as /treatments/ pages");
    assert.ok(opportunities[0]!.priorityScore > opportunities[1]!.priorityScore);
  });

  it("scores competitor relevance by content overlap", () => {
    const [a, b] = report.competitors;
    assert.ok(a!.overlap > b!.overlap, `${a!.overlap} vs ${b!.overlap}`);
  });

  it("matches sections across languages through content-type labels", async () => {
    const llm: JsonLlm = {
      model: "stub",
      async json<T>(request: JsonRequest) {
        const { entries } = JSON.parse(request.user) as { entries: Array<{ id: string }> };
        const label = (id: string) => (/doctor|dokter/.test(id) ? "doctor profiles" : /treatment|perawatan/i.test(id) ? "treatment pages" : "other pages");
        return { items: [...entries.map((entry) => ({ id: entry.id, label: label(entry.id) })), { id: "invented|x", label: "made up" }] } as T;
      },
    };
    const indonesian = [rival("rival-id.example", [["dokter", 2500], ["perawatan", 800]])];
    const labels = await labelContentTypes(llm, contentTypeEntries(own, indonesian));
    assert.equal(labels.has("invented|x"), false, "unknown ids are dropped");
    const labelled = compareCompetition(own, indonesian, labels);
    assert.equal(labelled.rows.find((entry) => entry.key === "doctor-profile")?.competitors[0]?.pages, 2500);
    assert.equal(labelled.rows.find((entry) => entry.key === "treatment-page")?.data?.dataset, "Treatments");
    assert.equal(labelled.aiLabels, true);
  });

  it("normalizes section names for matching", () => {
    assert.equal(contentKey("Doctors"), "doctor");
    assert.equal(contentKey("cities"), "city");
    assert.equal(contentKey("find-a-doctor"), "find-a-doctor");
  });
});

describe("runFullAnalysis with competitors", () => {
  // A site that converts and measures it, so content gaps decide the plan.
  const page = (title: string) => `<html><head><title>${title}</title><meta name="description" content="A page about ${title} with enough words to count."><script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head><body><h1>${title}</h1><p>${"Useful facts. ".repeat(80)}</p><a href="https://wa.me/60123">WhatsApp us</a></body></html>`;
  const sitemap = (origin: string, paths: string[]) => `<urlset>${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join("")}</urlset>`;
  const files: Record<string, string> = {
    "https://medbay.example/robots.txt": "User-agent: *\nAllow: /",
    "https://medbay.example/sitemap.xml": sitemap("https://medbay.example", ["/", ...Array.from({ length: 30 }, (_, i) => `/doctors/d${i}`)]),
    "https://rival.example/robots.txt": "User-agent: *\nAllow: /",
    "https://rival.example/sitemap.xml": sitemap("https://rival.example", Array.from({ length: 60 }, (_, i) => `/treatments/t${i}`)),
  };
  const fetcher: Fetcher = async (url) => {
    const body = files[url] ?? (/\/(doctors|treatments)\/|\.example\/$/.test(url) ? page(new URL(url).pathname) : "");
    return { url, finalUrl: url, headers: {}, status: body ? 200 : 404, body };
  };

  it("turns a competitor's sitemap into a content-gap priority in the plan", async () => {
    const report = await runFullAnalysis({
      analysisId: "a", siteId: "s", name: "medbay.example", baseUrl: "https://medbay.example", fetcher, maxPages: 8,
      competitorDomains: ["rival.example"], repeatability: false,
      datasets: [{ name: "Treatments", entityType: "treatment", records: 120, livePages: 0 }],
    });
    assert.equal(report.competition?.rows[0]?.status, "gap");
    assert.equal(report.plan.highestImpactOpportunity, "Publish your Treatments data as /treatments/ pages");
    assert.ok(report.plan.constraints.some((constraint) => constraint.includes("rival.example publishes ~60 /treatments/ pages")), report.plan.constraints.join(" | "));
    assert.ok(report.plan.competitiveAdvantage.includes("120 records"), report.plan.competitiveAdvantage);
    assert.equal(report.competitors[0]?.domain, "rival.example");
  });

  it("turns collected but unpublished data into a priority even without competitors", async () => {
    const report = await runFullAnalysis({
      analysisId: "a", siteId: "s", name: "medbay.example", baseUrl: "https://medbay.example", fetcher, maxPages: 8, repeatability: false,
      datasets: [{ name: "Hospitals", entityType: "hospital", records: 140, livePages: 0 }],
    });
    assert.equal(report.plan.highestImpactOpportunity, "Publish landing pages from your Hospitals data (140 records without a page)");
  });

  it("points a healthy site without competitors at growth, not housekeeping", async () => {
    const report = await runFullAnalysis({ analysisId: "a", siteId: "s", name: "medbay.example", baseUrl: "https://medbay.example", fetcher, maxPages: 8, repeatability: false });
    assert.ok(report.plan.highestImpactOpportunity.startsWith("No serious technical blocker was found"), report.plan.highestImpactOpportunity);
  });
});

describe("translated content", () => {
  it("counts a translated page once, so translations never manufacture an advantage", () => {
    const translated: OwnContent = { domain: "medbay.example", families: { blog: 57 }, sections: { blog: { pages: 19, languages: 3 } } };
    const report = compareCompetition(translated, [rival("rival.example", [["blog", 18]])]);
    const blog = report.rows.find((row) => row.you.families.includes("blog"))!;
    assert.deepEqual({ pages: blog.you.pages, urls: blog.you.urls, languages: blog.you.languages }, { pages: 19, urls: 57, languages: 3 });
    assert.equal(blog.status, "shared", "19 articles against 18 is comparable, not a lead");
    assert.ok(!report.insights.some((insight) => insight.startsWith("You publish")));
    assert.equal(counted(blog.you, "blog articles"), "~19 blog articles in 3 languages (57 URLs)");
    assert.equal(counted(blog.competitors[0]!, "blog articles"), "~18 blog articles");
  });

  it("describes a translated site's page families in distinct pages", () => {
    const plan = synthesizeGrowthPlan({
      siteId: "s", analysisId: "a", baseUrl: "https://medbay.example", findings: [], searchMetrics: [], competitors: [],
      sitemap: {
        totalUrls: 60, sampledUrls: 0, indexFiles: [], errors: [], languages: { default: 20, id: 20, zh: 20 },
        urlTypes: { blog: 57, home: 3 }, sections: { blog: { pages: 19, languages: 3 }, home: { pages: 1, languages: 3 } },
      },
    });
    assert.match(plan.competitiveAdvantage, /\/blog\/: ~19 pages in 3 languages \(57 URLs\)/);
  });
});
