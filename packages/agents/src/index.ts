import {
  countryName,
  createId,
  demandFromSnapshots,
  keywordGaps,
  type CompetitorProfile,
  type Finding,
  type FrameworkFingerprint,
  type GrowthPlan,
  type KeywordGap,
  type KeywordsInput,
  type Opportunity,
  type SearchMetricRow,
  type SitemapAudit,
  type CrawlPageResult,
} from "@organic-growth/core";
import type { RepoAnalysisResult } from "@organic-growth/repo-analyzer";
import { competitionOpportunities, counted, type CompetitionReport } from "./competition.js";
import { linkGapOpportunity, withSerpContext, type ConnectorSignals } from "./connector-findings.js";
import { estimateDemand } from "./demand.js";
import { analyzeSearch, searchOpportunities, type SearchInsights } from "./search.js";

export interface AnalysisBundle {
  /** What the site answered for a URL that cannot exist; a status under 400 is a soft-404 site. */
  notFoundProbe?: { url: string; finalUrl?: string; status: number; title?: string };
  siteId: string;
  analysisId: string;
  baseUrl: string;
  repo?: RepoAnalysisResult;
  fingerprint?: FrameworkFingerprint;
  sitemap?: SitemapAudit;
  pages?: CrawlPageResult[];
  findings: Finding[];
  searchMetrics: SearchMetricRow[];
  competitors: CompetitorProfile[];
  /** Brand words (site and repo name) used to separate branded from discovery demand. */
  brandTerms?: string[];
  /** Content-architecture comparison with competitor sitemaps and pages. */
  competition?: CompetitionReport;
  /** Collected datasets: records held versus entity pages published. */
  datasets?: Array<{ name: string; entityType: string; records: number; livePages: number }>;
  /** Search Console analysis (market alignment, intent mix, striking distance). */
  search?: SearchInsights;
  /** The site's and competitors' keyword lists from the Performance sync, for real demand and keyword gaps. */
  keywords?: KeywordsInput;
  /** Search results pages, suggested competitors, links and the crawl log, from the sync's other sources. */
  connectors?: ConnectorSignals;
}

/** The legacy search summary shape stored in reports as `searchNarrative`. */
export function analyzeSearchTraffic(rows: SearchMetricRow[], brandTerms: string[] = [], insights = analyzeSearch(rows, { brandTerms })): {
  totalClicks: number;
  totalImpressions: number;
  countryShare: Record<string, number>;
  brandedShare: number;
  commercialGapQueries: Array<{ query: string; page: string; clicks: number; impressions: number; position: number }>;
  narrative: string;
} {
  return {
    totalClicks: insights.totals.clicks,
    totalImpressions: insights.totals.impressions,
    countryShare: Object.fromEntries(insights.countries.map((country) => [country.country, country.impressionShare])),
    brandedShare: insights.brandedShare,
    commercialGapQueries: insights.commercialGaps,
    narrative: insights.narrative,
  };
}

export function buildOpportunities(bundle: AnalysisBundle): Opportunity[] {
  const technical = bundle.findings.map((finding) => {
    const impact = Math.max(1, finding.organicImpactScore);
    const effort = finding.category === "rendering" ? 4 : 2;
    const estimate = estimateDemand({ kind: "technical", effort });
    // Squared so severity dominates: informational fixes can't outrank a large
    // content gap, while critical blockers stay on top.
    const priorityScore = (impact * impact) / (50 * effort);
    return {
      id: createId("opp"),
      siteId: bundle.siteId,
      analysisId: bundle.analysisId,
      title: `Resolve: ${finding.title}`,
      searchDemand: estimate.searchDemand,
      estimatedDifficulty: estimate.estimatedDifficulty,
      intent: "technical_enabler",
      competitorStrength: 0,
      businessValue: impact,
      conversionPotential: 0,
      technicalEffort: effort,
      contentEffort: 0,
      priorityScore: Number(priorityScore.toFixed(2)),
      rationale: `${finding.summary} Search demand and conversion value have not been connected, so this priority reflects technical impact only.`,
      currentPage: finding.pagesAffected?.[0],
    };
  });
  const search = bundle.search ?? analyzeSearch(bundle.searchMetrics, { brandTerms: bundle.brandTerms });
  const demand = bundle.keywords ? demandFromSnapshots(bundle.keywords.priced.flatMap((list) => list.rows)) : undefined;
  const fromSearch = searchOpportunities(search, bundle.siteId, bundle.analysisId, demand);
  const contentGaps = bundle.competition ? competitionOpportunities(bundle.competition, bundle.siteId, bundle.analysisId) : [];
  const gaps = bundle.keywords ? gapOpportunities(keywordGaps(bundle.keywords), bundle.siteId, bundle.analysisId) : [];
  // Data already collected but not published: the cheapest landing pages to add.
  const coveredByGap = new Set(bundle.competition?.rows.filter((row) => row.status === "gap" && row.data).map((row) => row.data!.dataset));
  const unpublishedData = (bundle.datasets ?? [])
    .filter((dataset) => dataset.records - dataset.livePages >= 20 && !coveredByGap.has(dataset.name))
    .map((dataset) => {
      const waiting = dataset.records - dataset.livePages;
      const estimate = estimateDemand({ kind: "unpublished_data" });
      return {
        id: createId("opp"),
        siteId: bundle.siteId,
        analysisId: bundle.analysisId,
        title: `Publish landing pages from your ${dataset.name} data (${waiting.toLocaleString()} records without a page)`,
        searchDemand: estimate.searchDemand,
        estimatedDifficulty: estimate.estimatedDifficulty,
        intent: "unpublished_data",
        competitorStrength: 0,
        businessValue: 1.2,
        conversionPotential: 1,
        technicalEffort: 1,
        contentEffort: 2,
        priorityScore: Number(((12 * Math.log10(waiting + 1) * 1.2) / 2 * 2).toFixed(2)),
        rationale: `“${dataset.name}” holds ${dataset.records.toLocaleString()} ${dataset.entityType} records and ${dataset.livePages.toLocaleString()} published pages. Each record with enough facts can become a landing page for searches that name it; the Data step shows how many pass the quality gate.`,
      };
    });
  const links = linkGapOpportunity(bundle.connectors?.links, bundle.siteId, bundle.analysisId);
  return withSerpContext([...technical, ...fromSearch, ...contentGaps, ...unpublishedData, ...gaps, ...(links ? [links] : [])], bundle.connectors?.serp)
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

const COMMERCIAL_INTENT = new Set(["commercial", "transactional"]);

/** The biggest searches competitors win and the site doesn't, as pages to build: volume ≥ 100, difficulty ≤ 40, commercial intent first. A competitor's own name (navigational) is not a page to build. */
export function gapOpportunities(gaps: KeywordGap[], siteId: string, analysisId: string): Opportunity[] {
  const commercial = (gap: KeywordGap) => COMMERCIAL_INTENT.has(gap.intent ?? "");
  return gaps
    .filter((gap) => (gap.volume ?? 0) >= 100 && gap.difficulty !== null && gap.difficulty <= 40 && gap.intent !== "navigational")
    .sort((a, b) => Number(commercial(b)) - Number(commercial(a)) || (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 6)
    .map((gap) => {
      const volume = gap.volume!;
      const weight = commercial(gap) ? 1.5 : 1;
      return {
        id: createId("opp"), siteId, analysisId,
        title: `Rank for “${gap.keyword}”: ${volume.toLocaleString("en")} searches a month; ${gap.domain} ranks ${gap.position}`,
        searchDemand: volume, estimatedDifficulty: gap.difficulty!, intent: "keyword_gap", competitorStrength: gap.position,
        potentialPage: `https://${gap.domain}${gap.url}`,
        businessValue: weight, conversionPotential: commercial(gap) ? 1 : 0.5, technicalEffort: 1, contentEffort: 3,
        priorityScore: Number((Math.log10(volume + 1) * 12 * (1 - gap.difficulty! / 100) * weight).toFixed(2)),
        rationale: `${volume.toLocaleString("en")} searches a month in your target markets, difficulty ${gap.difficulty} of 100, ${gap.intent ?? "unknown"} intent (DataForSEO). ${gap.domain} ranks ${gap.position} with ${gap.url}; you don't appear. A page that answers this search directly is the usual way in.`,
      };
    });
}

/** Below this priority, the top opportunity is housekeeping rather than growth. */
const MINOR_PRIORITY = 8;

export function synthesizeGrowthPlan(bundle: AnalysisBundle): GrowthPlan {
  const search = bundle.search ?? analyzeSearch(bundle.searchMetrics, { brandTerms: bundle.brandTerms });
  const opportunities = buildOpportunities({ ...bundle, search });
  const topFindings = [...bundle.findings].sort(
    (a, b) => b.organicImpactScore - a.organicImpactScore,
  );

  // Only findings with real organic impact (MEDIUM and above) count as constraints.
  const blocking = topFindings.filter((finding) => finding.organicImpactScore >= 40);
  const constraints = [
    ...(blocking.length
      ? blocking.slice(0, 3).map((finding) => finding.title)
      : ["No serious technical issue was found; remaining findings are minor."]),
    searchConstraint(bundle, search),
    competitionConstraint(bundle),
  ];

  const stack = bundle.fingerprint && bundle.fingerprint.framework !== "unknown"
    ? `runs ${bundle.fingerprint.framework}${bundle.fingerprint.deployment ? ` on ${bundle.fingerprint.deployment}` : ""}`
    : "was analyzed from the outside (no repository connected)";
  const sitemapTotal = bundle.sitemap?.totalUrls ?? 0;
  const situation = [
    `Website at ${bundle.baseUrl} ${stack}${bundle.sitemap ? `, with a sitemap declaring ~${sitemapTotal.toLocaleString()} URLs` : ""}.`,
    bundle.searchMetrics.length ? search.narrative : "No first-party search performance data is connected yet.",
    `The crawl sampled ${bundle.pages?.length ?? 0} pages and found ${topFindings.length} technical issues.`,
  ].join(" ");

  // Route families with many URLs are the raw material for landing pages.
  const families = Object.entries(bundle.sitemap?.urlTypes ?? {})
    .filter(([type]) => type !== "home" && type !== "page")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const lead = bundle.competition?.rows.find((row) => row.status === "advantage" || row.status === "yours_only");
  const unpublished = bundle.competition?.rows.find((row) => row.data && row.data.records > row.data.livePages * 2 && row.status === "gap");
  const competitiveAdvantage = lead
    ? `You publish ${counted(lead.you, lead.label)}${lead.competitors[0] ? `, more than any competitor analyzed (largest: ${lead.competitors[0].domain} with ${counted(lead.competitors[0])})` : ", which no competitor analyzed has"}. ${unpublished ? `You also hold ${unpublished.data!.records.toLocaleString()} records in “${unpublished.data!.dataset}”, the data competitors turn into ${unpublished.label}.` : "Build on this with internal links and richer facts per page."}`
    : unpublished
      ? `You already hold ${unpublished.data!.records.toLocaleString()} records in “${unpublished.data!.dataset}” — the raw material for ${unpublished.label}, which competitors publish (~${unpublished.competitors[0]!.pages.toLocaleString()} on ${unpublished.competitors[0]!.domain}).`
      : bundle.repo
    ? `The repository exposes ${bundle.repo.routes.length} detected routes and uses ${bundle.fingerprint?.framework ?? "an unknown framework"}; these code-level signals support targeted implementation recommendations.`
    : families.length
      ? `The site already publishes structured page families (${families.map(([type, urls]) => `/${type}/: ${counted({ pages: bundle.sitemap?.sections?.[type]?.pages ?? urls, urls, languages: bundle.sitemap?.sections?.[type]?.languages }, "pages")}`).join(", ")}). Each family is a ready-made dataset for focused landing pages.`
      : "The site's offering can be broken into specific products, services, or locations, each worth its own landing page — scope them in the Data step.";

  const top = opportunities[0];
  const highestImpactOpportunity = !top
    ? "Connect Google Search Console and review the sampled pages for technical issues."
    : top.priorityScore < MINOR_PRIORITY && top.intent === "technical_enabler"
      ? "No serious technical blocker was found. The biggest lever is new demand: scope the specific things your customers search for (products, services, locations, people) and publish a landing page for each, then connect Search Console to measure them."
      : top.title;

  const priorities = opportunities.slice(0, 6).map((opp, index) => ({
    rank: index + 1,
    title: opp.title,
    expectedObjective: opp.rationale,
    whyThisMatters: opp.intent === "technical_enabler"
      ? "Prioritized from the observed technical finding. Search demand and conversion value are not yet available."
      : opp.intent === "keyword_gap"
        ? `${opp.rationale} Real searches, measured monthly: this is demand you can see before building.`
      : opp.intent === "link_gap"
        ? `${opp.rationale} Links from relevant sites are how search engines judge which of several good pages to trust; these sites already link to businesses like yours.`
      : opp.intent === "content_gap"
        ? `${opp.rationale} Competitors that invest this heavily in a page type usually do so because it brings them traffic.`
        : /prioritization aid/i.test(opp.rationale) ? opp.rationale : `${opp.rationale} This opportunity score is a prioritization aid, not a traffic forecast.`,
    pagesAffected: opp.potentialPage ? [opp.potentialPage] : opp.currentPage ? [opp.currentPage] : [],
    implementationRequired: opp.intent === "technical_enabler"
      ? "Review the affected route and implement a targeted change in a Git branch."
      : opp.intent === "keyword_gap"
        ? "Build a landing page that answers this search (a dataset and template in Data, or a page by hand), and link it from related pages."
      : opp.intent === "link_gap"
        ? "No code change. Review the strongest sites in the Competitors tab's link gap and see how each links to competitors (directory listing, article, partner page)."
      : opp.intent === "content_gap" || opp.intent === "unpublished_data"
        ? "Create a dataset for this entity type in Data (or reuse the existing one), add sources, and generate one landing page per record with a template."
        : "Review the page against the query intent, then improve its title, content coverage, or internal links as evidence supports.",
    contentRequired: opp.intent === "technical_enabler"
      ? "No content change inferred from technical crawl data alone."
      : opp.intent === "keyword_gap"
        ? `Study ${opp.potentialPage} for the facts searchers expect, then answer the search more completely, in the market's language.`
      : opp.intent === "link_gap"
        ? "Give each site a reason to link: a listing with your details, data or a guide worth citing, or a partnership. Never buy links."
      : opp.intent === "unpublished_data"
        ? "Fill missing fields on thin records first; publish only pages that pass the quality gate."
      : opp.intent === "content_gap"
        ? `Study competitor examples${opp.potentialPage ? ` (e.g. ${opp.potentialPage})` : ""} for the facts searchers expect, and publish only pages with enough unique facts to stand on their own.`
        : "Validate the search intent and improve the existing page only where it adds distinct user value.",
    dependencies: [bundle.searchMetrics.length ? "Confirm the query and page in Search Console before implementation." : "Connect Search Console to validate organic demand and measure impact."],
    risk: opp.intent === "technical_enabler"
      ? "The crawl is sampled; confirm the issue across the relevant page template before changing production code."
      : opp.intent === "keyword_gap"
        ? "Volume is a monthly average for the country; check that the search's intent matches what the business sells before building."
      : opp.intent === "link_gap"
        ? "Link indexes miss links and keep some that are gone; a link from an irrelevant or spammy site does nothing or harms."
      : "The query-intent label is heuristic; validate it manually and avoid rewriting a page based only on average position.",
    measurementMethod: "Compare Search Console impressions, clicks, CTR, and position for the query and landing page after changes; then check conversion events.",
  }));

  const sections = [
    {
      title: "What I checked",
      body: [
        "1. HTTP responses and crawler-visible page HTML",
        "2. Sitemap and robots.txt setup",
        "3. Repository framework, routes, and rendering clues",
        "4. Browser-rendered DOM for representative sampled pages",
        "5. Search Console data: " + (bundle.searchMetrics.length ? "connected" : "not connected"),
        "6. Competitors: " + (bundle.competition?.competitors.length
          ? `${bundle.competition.competitors.filter((competitor) => competitor.analyzed).length} analyzed from their sitemaps and sampled pages`
          : "not supplied"),
        ...checkedConnectors(bundle.connectors),
      ].join("\n"),
      evidenceIds: topFindings.slice(0, 3).map((f) => f.id),
    },
    {
      title: "Evidence snapshot",
      body: topFindings
        .slice(0, 5)
        .map((f) => `- [${f.severity}] ${f.title}: ${f.summary}`)
        .join("\n"),
      evidenceIds: topFindings.slice(0, 5).map((f) => f.id),
    },
    {
      title: "Competitive gap",
      body: bundle.competition?.insights.length
        ? bundle.competition.insights.map((insight) => `- ${insight}`).join("\n")
        : bundle.competitors.length
          ? bundle.competitors.map((c) => `- ${c.domain}: ${c.summary}`).join("\n")
          : "No competitor domains were supplied for this analysis. Add two or three sites that win the searches you want.",
    },
    {
      title: "Strategy sequence",
      body: strategySequence(bundle, topFindings).join("\n→ "),
    },
  ];

  const markdown = renderGrowthPlanMarkdown({
    situation,
    constraints,
    competitiveAdvantage,
    highestImpactOpportunity,
    priorities,
    sections,
  });

  return {
    id: createId("plan"),
    siteId: bundle.siteId,
    analysisId: bundle.analysisId,
    situation,
    constraints,
    competitiveAdvantage,
    highestImpactOpportunity,
    priorities,
    sections,
    markdown,
    createdAt: new Date().toISOString(),
  };
}

function searchConstraint(bundle: AnalysisBundle, search: SearchInsights): string {
  if (!bundle.searchMetrics.length) return "Google Search Console is not connected; search demand, rankings, and market fit are unknown.";
  if (search.targetShare && search.targetShare.impressions < 0.3) {
    return `Market fit: only ${Math.round(search.targetShare.impressions * 100)}% of search impressions come from your target market${search.targetMarkets.length > 1 ? "s" : ""} (${search.targetMarkets.map(countryName).join(", ")}).`;
  }
  const entity = search.entityQueries?.byType[0];
  if (search.entityQueries && search.entityQueries.share >= 0.5 && entity) {
    return `Intent: ${Math.round(search.entityQueries.share * 100)}% of clicks come from people looking up a specific ${entity.entityType} by name; commercial searches bring ${Math.round(search.commercialShare * 100)}%.`;
  }
  return `Search data covers ${search.totals.clicks.toLocaleString()} clicks and ${search.totals.impressions.toLocaleString()} impressions in the last 28 days.`;
}

/** Lines 7 onwards of "What I checked", for the sources that were synced. */
function checkedConnectors(connectors: ConnectorSignals | undefined): string[] {
  const lines: string[] = [];
  if (connectors?.serp?.length) {
    const overviews = connectors.serp.filter((row) => row.features.includes("ai_overview")).length;
    lines.push(`Google's results pages for ${connectors.serp.length} of your biggest searches (${overviews} with an AI Overview)`);
  }
  if (connectors?.links?.summaries.length) lines.push(`Backlinks for you and ${connectors.links.summaries.length - 1} competitors${connectors.links.gap ? `, and ${connectors.links.gap.rows.length} sites in the link gap` : ""}`);
  if (connectors?.logCoverage) lines.push(`Your server logs: ${connectors.logCoverage.view.totals.googlebot.toLocaleString("en")} Googlebot requests in 28 days`);
  return lines.map((line, index) => `${index + 7}. ${line}`);
}

function competitionConstraint(bundle: AnalysisBundle): string {
  const gap = bundle.competition?.rows.find((row) => row.status === "gap");
  if (gap) {
    return `Content gap: ${gap.competitors[0]!.domain} publishes ${counted(gap.competitors[0]!, gap.label)}; you have ${gap.you.pages ? counted(gap.you) : "none"}.`;
  }
  if (bundle.competition?.competitors.some((competitor) => competitor.analyzed)) return "No large content gap against the competitors analyzed; differentiation will come from depth and conversion, not page count.";
  const found = (bundle.connectors?.suggestions ?? []).filter((entry) => entry.kind === "competitor").slice(0, 2).map((entry) => entry.domain);
  if (!bundle.competitors.length && found.length) return `No competitor domains have been supplied; Google's results for your searches show ${found.join(" and ")} winning them.`;
  return bundle.competitors.length ? "Competitor observations are limited to domains selected by the site owner." : "No competitor domains have been supplied, so content gaps are unknown.";
}

/** The order of work this site needs, from what the analysis actually found. */
function strategySequence(bundle: AnalysisBundle, findings: Finding[]): string[] {
  const steps: string[] = [];
  if (findings.some((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH")) steps.push("Fix the critical and high-impact technical findings so search engines receive every page");
  const rows = bundle.competition?.rows ?? [];
  if (rows.some((row) => row.status === "gap" && row.data)) steps.push("Publish landing pages from data you already hold");
  if (rows.some((row) => row.status === "gap" && !row.data)) steps.push("Close the largest content gaps against competitors with data-backed landing pages");
  if (!bundle.searchMetrics.length) steps.push("Connect Search Console to see which queries and pages have demand");
  else {
    if (bundle.search?.targetShare && bundle.search.targetShare.impressions < 0.3) steps.push("Publish pages in your target market's language, built around what that market searches for");
    steps.push("Improve pages ranking just off page one for commercial queries");
  }
  if (!bundle.competition?.competitors.length) {
    const found = (bundle.connectors?.suggestions ?? []).filter((entry) => entry.kind === "competitor").slice(0, 3).map((entry) => entry.domain);
    steps.push(found.length ? `Add the competitors that win your searches (${found.join(", ")}) to find content gaps` : "Add two or three competitor domains to find content gaps");
  }
  if ((bundle.connectors?.links?.gap?.rows.length ?? 0) >= 5) steps.push("Earn links from the sites that already link to your competitors");
  steps.push("Track conversions on landing pages and double down on the page types that produce customers");
  return steps;
}

function renderGrowthPlanMarkdown(input: {
  situation: string;
  constraints: string[];
  competitiveAdvantage: string;
  highestImpactOpportunity: string;
  priorities: GrowthPlan["priorities"];
  sections: GrowthPlan["sections"];
}): string {
  const lines = [
    "# Organic Growth Plan",
    "",
    "### Current situation",
    "",
    input.situation,
    "",
    "### Main constraints",
    "",
    ...input.constraints.map((c, i) => `${i + 1}. ${c}`),
    "",
    "### Competitive advantage",
    "",
    input.competitiveAdvantage,
    "",
    "### Highest-impact opportunity",
    "",
    input.highestImpactOpportunity,
    "",
    "### Recommended priorities",
    "",
  ];
  for (const p of input.priorities) {
    lines.push(`#### Priority ${p.rank}: ${p.title}`);
    lines.push("");
    lines.push(`- **Expected objective:** ${p.expectedObjective}`);
    lines.push(`- **Why this matters:** ${p.whyThisMatters}`);
    lines.push(`- **Pages affected:** ${p.pagesAffected.join(", ") || "TBD"}`);
    lines.push(`- **Implementation required:** ${p.implementationRequired}`);
    lines.push(`- **Content required:** ${p.contentRequired}`);
    lines.push(`- **Dependencies:** ${p.dependencies.join(", ") || "None"}`);
    lines.push(`- **Risk:** ${p.risk}`);
    lines.push(`- **Measurement:** ${p.measurementMethod}`);
    lines.push("");
  }
  for (const section of input.sections) {
    lines.push(`### ${section.title}`);
    lines.push("");
    lines.push(section.body);
    lines.push("");
  }
  return lines.join("\n");
}

export * from "./pipeline.js";
export * from "./inventory-data.js";
export * from "./github-pr.js";
export * from "./ai-plan.js";
export * from "./google-search-console.js";
export * from "./change-generator.js";
export * from "./competition.js";
export * from "./code-findings.js";
export * from "./search.js";
export * from "./conversion.js";
export * from "./assistant.js";
export * from "./demo.js";
export * from "./results-points.js";
export * from "./site-signals.js";
export * from "./google-analytics.js";
export * from "./google-sheets.js";
export * from "./dataforseo.js";
export * from "./bing.js";
export * from "./connector-findings.js";
export * from "./log-coverage.js";
export * from "./trend-signals.js";
export * from "./not-found-probe.js";
