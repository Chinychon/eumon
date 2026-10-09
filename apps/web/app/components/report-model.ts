/*
 * The analysis report as the console reads it, and the small derivations the
 * Overview charts draw from it. No React here, so it runs under `node --test`.
 */

export type Finding = { id: string; category: string; severity: string; title: string; summary: string; recommendation?: string; organicImpactScore: number };

export type Report = {
  analysisId: string;
  site: { name: string; baseUrl: string; fingerprint?: { framework: string; rendering?: string; deployment?: string } };
  sitemap: { totalUrls: number; sampledUrls: number; errors: string[] };
  /** Unchanged pages whose results were carried over from the last crawl. */
  crawlReuse?: { urls: number; from?: string };
  coverage?: {
    totalUrls: number;
    completedUrls: number;
    emptyShellUrls: number;
    httpErrorUrls: number;
    families?: Array<{ family: string; urls: number; crawled: number; emptyShells: number; errors: number; noindex: number; missingStructuredData: number }>;
  } | null;
  pages: Array<{ url: string; renderedTextLength: number }>;
  findings: Finding[];
  competitors: Array<{ domain: string; category: string; summary: string; relevanceScore?: number; architectureNotes?: string; conversionNotes?: string; technicalNotes?: string }>;
  opportunities: Array<{ title: string; rationale: string; priorityScore: number; potentialPage?: string; intent?: string }>;
  plan: { situation: string; competitiveAdvantage: string; highestImpactOpportunity: string; priorities: Array<{ rank: number; title: string; whyThisMatters: string }> };
  searchNarrative: { totalClicks: number; totalImpressions: number; narrative: string };
  competition?: {
    rows: Array<{
      key: string;
      label: string;
      status: "gap" | "advantage" | "shared" | "yours_only";
      you: { pages: number; urls?: number; languages?: number };
      data?: { dataset: string; records: number; livePages: number };
      competitors: Array<{ domain: string; pages: number; urls?: number; languages?: number; examples: string[] }>;
    }>;
    competitors: Array<{ domain: string; analyzed: boolean; partial: boolean; estimatedUrls: number }>;
    insights: string[];
    aiLabels: boolean;
  } | null;
  conversion?: {
    templates: Array<{ family: string; url: string; paths: string[]; prices: boolean; tracking: string[] }>;
    tracking: string[];
    suggestedEvents: Array<{ event: string; trigger: string }>;
  } | null;
  search?: {
    totals: { clicks: number; impressions: number; ctr: number };
    targetMarkets: string[];
    targetShare: { clicks: number; impressions: number } | null;
    countries: Array<{ country: string; name: string; impressionShare: number }>;
    brandedShare: number;
    commercialShare: number;
    entityQueries: { share: number; byType: Array<{ entityType: string; clicks: number; examples: string[] }> } | null;
    strikingDistance: Array<{ query: string; page: string; position: number; impressions: number; clicks: number }>;
    lowCtrPages: Array<{ page: string; impressions: number; ctr: number; expectedCtr: number; position: number; queries: string[] }>;
    cannibalized: Array<{ query: string; impressions: number; pages: Array<{ page: string; position: number }> }>;
    narrative: string;
  } | null;
  repo?: { fingerprint: Fingerprint; routeInspections?: RouteInspection[]; sitemapCode?: { source: string; splitsSitemaps: boolean } } | null;
  rendering?: {
    comparisons: Array<{ url: string; family: string; verdict: string; rawTextLength: number; renderedTextLength: number; rawTitle?: string; renderedTitle?: string }>;
    repeatability: Array<{ family: string; urls: number; attempts: number; failed: number; medianMs: number }>;
  };
};

type RouteInspection = { pathPattern: string; source: string; dynamic: boolean; rendering: string; renderingEvidence?: string; clientDataFetching?: string; metadata: string; sequentialAwaits: number; unboundedQueries: string[] };
type Fingerprint = { framework: string; router?: string; rendering?: string; deployment?: string; cms?: string; database?: string; analytics: string[]; seoTooling: string[]; contentSource?: string; language: string; packageManager: string };

export type ReportTab = "overview" | "technical" | "search" | "competitors" | "leads";

export const familyLabel = (family: string) => (family === "home" ? "Homepage" : family === "page" ? "Top-level pages" : `/${family}/`);

type Family = NonNullable<NonNullable<Report["coverage"]>["families"]>[number];

/** The page-type × problem grid: each cell counts pages with that problem, and its share of the pages it applies to. */
export const HEALTH_COLUMNS = [
  { key: "emptyShells", label: "Empty HTML", of: (family: Family) => family.crawled },
  { key: "errors", label: "Errors", of: (family: Family) => family.urls },
  { key: "noindex", label: "Noindex", of: (family: Family) => family.crawled },
  { key: "missingStructuredData", label: "No schema", of: (family: Family) => family.crawled },
] as const;

export function pageTypeHealth(families: Family[], limit = 12) {
  return [...families].sort((a, b) => b.urls - a.urls).slice(0, limit).map((family) => ({
    family: family.family,
    label: familyLabel(family.family),
    urls: family.urls,
    cells: HEALTH_COLUMNS.map((column) => {
      // Structured data is expected on detail pages only.
      const applies = column.key !== "missingStructuredData" || (family.family !== "home" && family.family !== "page");
      const count = applies ? family[column.key] : 0;
      const of = column.of(family);
      return { key: column.key, label: column.label, count, share: applies && of ? count / of : 0, applies };
    }),
  }));
}

/** Share of sitemap URLs that reached Google as a real page: fetched, not an error, not empty. */
export function servedShare(coverage: Report["coverage"]): number | null {
  if (!coverage?.totalUrls) return null;
  const served = coverage.completedUrls - coverage.emptyShellUrls - coverage.httpErrorUrls;
  return Math.max(0, served) / coverage.totalUrls;
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFORMATIONAL: 4 };

/** Which tab explains an opportunity. */
export const opportunityTab = (intent?: string): ReportTab =>
  intent === "content_gap" || intent === "unpublished_data" || intent === "keyword_gap" ? "competitors" : intent === "technical_enabler" ? "technical" : "search";

/** Which tab explains a finding. */
export const findingTab = (category: string): ReportTab =>
  category === "search" ? "search" : category === "competitors" ? "competitors" : category === "conversion" ? "leads" : "technical";

export type Action = { title: string; severity?: string; tab: ReportTab };

/**
 * The three things to do first: critical and high findings, then the
 * strongest opportunity, then the remaining findings by impact.
 */
export function doFirst(report: Pick<Report, "findings" | "opportunities">, limit = 3): Action[] {
  const findings = [...report.findings].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.organicImpactScore - a.organicImpactScore);
  const asAction = (finding: Finding): Action => ({ title: finding.title, severity: finding.severity, tab: findingTab(finding.category) });
  const urgent = findings.filter((finding) => (SEVERITY_RANK[finding.severity] ?? 9) <= 1).map(asAction);
  const top = [...report.opportunities].sort((a, b) => b.priorityScore - a.priorityScore)[0];
  const rest = findings.filter((finding) => (SEVERITY_RANK[finding.severity] ?? 9) > 1).map(asAction);
  return [...urgent, ...(top ? [{ title: top.title, tab: opportunityTab(top.intent) }] : []), ...rest].slice(0, limit);
}


type Competition = NonNullable<Report["competition"]>;

/** Content sections ordered by how far the strongest competitor is ahead of you. */
export function gapsFirst(competition: Competition) {
  const lead = (row: Competition["rows"][number]) => Math.max(0, ...row.competitors.map((entry) => entry.pages)) - row.you.pages;
  return [...competition.rows].sort((a, b) => lead(b) - lead(a));
}
