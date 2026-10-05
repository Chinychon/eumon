import {
  createId,
  type CompetitorProfile,
  type Finding,
  type FrameworkFingerprint,
  type GrowthPlan,
  type Opportunity,
  type ProposedChange,
  type SearchMetricRow,
  type SitemapAudit,
  type CrawlPageResult,
} from "@organic-growth/core";
import type { RepoAnalysisResult } from "@organic-growth/repo-analyzer";

export interface AnalysisBundle {
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
}

export function discoverCompetitors(input: {
  siteId: string;
  baseUrl: string;
  searchMetrics: SearchMetricRow[];
  competitorDomains?: Array<{ domain: string; status?: number; title?: string; pageCount?: number }>;
  industryHints?: string[];
}): CompetitorProfile[] {
  return (input.competitorDomains ?? []).map((competitor) => ({
    id: createId("competitor"), siteId: input.siteId, domain: competitor.domain,
    category: "business", relevanceScore: 0,
    summary: "Domain supplied by the site owner; observations below come from a single homepage fetch.",
    technicalNotes: competitor.status === undefined
      ? "Homepage could not be fetched during this run."
      : `Homepage returned HTTP ${competitor.status}${competitor.title ? ` with title “${competitor.title}”` : ""}.`,
    evidence: { source: "owner_selected", homepageStatus: competitor.status, homepageTitle: competitor.title, sampledPageCount: competitor.pageCount ?? 0 },
  }));
}

/** Query wording that usually signals purchase or booking intent, across common markets. */
export const COMMERCIAL_QUERY_PATTERN =
  /\b(cost|costs|price|prices|pricing|cheap|cheapest|affordable|quote|book|booking|appointment|buy|hire|near me|best|top|review|reviews|vs|compare|comparison|service|services|clinic|package|biaya|harga|terbaik|murah)\b/i;

export function analyzeSearchTraffic(rows: SearchMetricRow[], brandTerms: string[] = []): {
  totalClicks: number;
  totalImpressions: number;
  countryShare: Record<string, number>;
  brandedShare: number;
  commercialGapQueries: SearchMetricRow[];
  narrative: string;
} {
  const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
  const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);
  const countryShare: Record<string, number> = {};
  for (const r of rows) {
    countryShare[r.country] = (countryShare[r.country] ?? 0) + r.impressions;
  }
  for (const k of Object.keys(countryShare)) {
    countryShare[k] = countryShare[k] / Math.max(totalImpressions, 1);
  }

  const brands = brandTerms.map((term) => term.toLowerCase()).filter((term) => term.length >= 3);
  const brandedClicks = rows
    .filter((r) => brands.some((brand) => r.query.toLowerCase().includes(brand)))
    .reduce((s, r) => s + r.clicks, 0);
  const brandedShare = totalClicks ? brandedClicks / totalClicks : 0;

  const commercialGapQueries = rows
    .filter((r) => COMMERCIAL_QUERY_PATTERN.test(r.query) && r.position > 10)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25);

  const [topCountry, topShare] = Object.entries(countryShare).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const narrative = [
    `Organic search shows ~${totalClicks.toLocaleString()} clicks and ~${totalImpressions.toLocaleString()} impressions in the synced window.`,
    topCountry ? `${Math.round(topShare * 100)}% of impressions come from ${topCountry.toUpperCase()}; confirm that matches the market you sell to.` : "",
    brands.length
      ? brandedShare > 0.5
        ? `About ${Math.round(brandedShare * 100)}% of clicks are branded searches, so non-brand discovery is still small.`
        : `Branded searches account for about ${Math.round(brandedShare * 100)}% of clicks.`
      : "",
    commercialGapQueries.length
      ? `${commercialGapQueries.length} commercial-intent queries rank beyond position 10 — demand exists that current pages are not capturing.`
      : "Few commercial-intent queries appear beyond page one in the current sample.",
  ].filter(Boolean).join(" ");

  return {
    totalClicks,
    totalImpressions,
    countryShare,
    brandedShare,
    commercialGapQueries,
    narrative,
  };
}

export function buildOpportunities(bundle: AnalysisBundle): Opportunity[] {
  const technical = bundle.findings.map((finding) => {
    const impact = Math.max(1, finding.organicImpactScore);
    const effort = finding.category === "rendering" ? 4 : 2;
    return {
      id: createId("opp"),
      siteId: bundle.siteId,
      analysisId: bundle.analysisId,
      title: `Resolve: ${finding.title}`,
      searchDemand: 0,
      intent: "technical_enabler",
      competitorStrength: 0,
      estimatedDifficulty: Math.min(100, effort * 15),
      businessValue: impact,
      conversionPotential: 0,
      technicalEffort: effort,
      contentEffort: 0,
      priorityScore: impact / effort,
      rationale: `${finding.summary} Search demand and conversion value have not been connected, so this priority reflects technical impact only.`,
      currentPage: finding.pagesAffected?.[0],
    };
  });
  const queryGroups = new Map<string, SearchMetricRow[]>();
  for (const row of bundle.searchMetrics) {
    if (row.impressions < 20 || row.position < 4) continue;
    const key = `${row.query}\n${row.page}`;
    queryGroups.set(key, [...(queryGroups.get(key) ?? []), row]);
  }
  const searchOpportunities = [...queryGroups.values()].map((rows) => {
    const sample = rows[0]!;
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
    const position = rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / Math.max(impressions, 1);
    const commercial = COMMERCIAL_QUERY_PATTERN.test(sample.query);
    const effort = 2;
    const score = (impressions * (commercial ? 1.5 : 1) * Math.min(1, Math.max(0, 0.1 - clicks / Math.max(impressions, 1)))) / effort;
    return {
      id: createId("opp"), siteId: bundle.siteId, analysisId: bundle.analysisId,
      title: `Improve page visibility for “${sample.query}”`, searchDemand: impressions,
      intent: commercial ? "commercial (query-pattern heuristic)" : "informational or mixed (verify manually)",
      currentRank: position, competitorStrength: 0, estimatedDifficulty: Math.min(100, position * 4),
      currentPage: sample.page, businessValue: commercial ? 1.5 : 1, conversionPotential: commercial ? 1 : 0.5,
      technicalEffort: effort, contentEffort: effort, priorityScore: score,
      rationale: `${impressions} impressions and ${clicks} clicks across imported rows; average position ${position.toFixed(1)}. Query intent is a text-pattern heuristic. Score is for prioritization, not a traffic forecast.`,
    };
  }).sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 10);
  return [...technical, ...searchOpportunities].sort((a, b) => b.priorityScore - a.priorityScore);
}

export function synthesizeGrowthPlan(bundle: AnalysisBundle): GrowthPlan {
  const search = analyzeSearchTraffic(bundle.searchMetrics, bundle.brandTerms);
  const opportunities = buildOpportunities(bundle);
  const topFindings = [...bundle.findings].sort(
    (a, b) => b.organicImpactScore - a.organicImpactScore,
  );

  const constraints = [
    ...(topFindings.length
      ? topFindings.slice(0, 3).map((finding) => finding.title)
      : ["No critical technical issue was detected in the sampled pages."]),
    bundle.searchMetrics.length
      ? `Search data covers ${search.totalClicks} clicks and ${search.totalImpressions} impressions in the supplied sample.`
      : "Google Search Console is not connected; search demand, rankings, and market fit are unknown.",
    bundle.competitors.length
      ? "Competitor observations are limited to domains selected by the site owner."
      : "No competitor domains or SERP data have been supplied.",
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
  const competitiveAdvantage = bundle.repo
    ? `The repository exposes ${bundle.repo.routes.length} detected routes and uses ${bundle.fingerprint?.framework ?? "an unknown framework"}; these code-level signals support targeted implementation recommendations.`
    : families.length
      ? `The site already publishes structured page families (${families.map(([type, count]) => `/${type}/: ${count.toLocaleString()} pages`).join(", ")}). Each family is a ready-made dataset for focused landing pages.`
      : "The site's offering can be broken into specific products, services, or locations, each worth its own landing page — scope them in the Data step.";

  const highestImpactOpportunity =
    opportunities[0]?.title ??
    "Connect Google Search Console and review the sampled pages for technical issues.";

  const priorities = opportunities.slice(0, 6).map((opp, index) => ({
    rank: index + 1,
    title: opp.title,
    expectedObjective: opp.rationale,
    whyThisMatters: opp.intent === "technical_enabler"
      ? "Prioritized from the observed technical finding. Search demand and conversion value are not yet available."
      : `${opp.rationale} This opportunity score is a prioritization aid, not a traffic forecast.`,
    pagesAffected: opp.potentialPage ? [opp.potentialPage] : opp.currentPage ? [opp.currentPage] : [],
    implementationRequired: opp.intent === "technical_enabler"
      ? "Review the affected route and implement a targeted change in a Git branch."
      : "Review the page against the query intent, then improve its title, content coverage, or internal links as evidence supports.",
    contentRequired: opp.intent === "technical_enabler"
      ? "No content change inferred from technical crawl data alone."
      : "Validate the search intent and improve the existing page only where it adds distinct user value.",
    dependencies: [bundle.searchMetrics.length ? "Confirm the query and page in Search Console before implementation." : "Connect Search Console to validate organic demand and measure impact."],
    risk: opp.intent === "technical_enabler"
      ? "The crawl is sampled; confirm the issue across the relevant page template before changing production code."
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
        "6. Competitors: " + (bundle.competitors.length ? "user-selected domains" : "not supplied"),
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
      body: bundle.competitors.length ? bundle.competitors
        .map(
          (c) =>
            `- ${c.domain} (${c.category}, relevance ${c.relevanceScore.toFixed(2)}): ${c.summary}`,
        )
        .join("\n") : "No competitor domains or SERP evidence were supplied for this analysis.",
    },
    {
      title: "Strategy sequence",
      body: [
        "Resolve high-impact technical findings with a reviewed change",
        "Connect Search Console to identify queries and pages with measurable demand",
        "Add site-specific competitor domains for comparison",
        "Track organic conversions before prioritizing growth experiments",
      ].join("\n→ "),
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

export function proposeSafeTechnicalChange(input: {
  siteId: string;
  analysisId: string;
  finding?: Finding;
  opportunity?: Opportunity;
}): ProposedChange {
  const finding = input.finding;
  const title = finding ? `Review recommended fix for: ${finding.title}` : "No code change generated from this sample";

  return {
    id: createId("change"),
    siteId: input.siteId,
    analysisId: input.analysisId,
    opportunityId: input.opportunity?.id,
    findingId: finding?.id,
    title,
    reason: finding
      ? `${finding.summary} This is an evidence-backed review item; no repository patch has been generated yet.`
      : "The sampled crawl did not identify a specific code change that can be proposed safely.",
    evidence: {
      finding: finding
        ? {
            id: finding.id,
            severity: finding.severity,
            organicImpactScore: finding.organicImpactScore,
            evidence: finding.evidence,
          }
        : undefined,
      opportunityId: input.opportunity?.id,
    },
    filesChanged: [],
    pagesAffected: finding?.pagesAffected?.slice(0, 20) ?? [],
    patch: "",
    status: "proposed",
    author: "organic-growth-rules-v1",
    createdAt: new Date().toISOString(),
  };
}

export * from "./pipeline.js";
export * from "./github-pr.js";
export * from "./ai-plan.js";
export * from "./google-search-console.js";
export * from "./change-generator.js";
