/*
 * The analysis report as the console reads it, the small derivations the
 * Overview charts draw from it, and where in the console each area lives.
 * No React here, so it runs under `node --test`.
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

/** What a finding or opportunity is about, which decides the page that explains it. */
export type Area = "technical" | "search" | "keywords" | "competitors" | "leads" | "data";

/** Rail pages, by the keys their links use. Keys stay as they were when labels changed, so saved and shared links keep working. */
export type View = "overview" | "results" | "keywords" | "competitors" | "ask" | "connections" | "data" | "pages" | "performance" | "setup";
export type Navigate = (view: View, tab?: string) => void;

/** A rail page and, where it has tabs, the tab. */
export type Place = { view: View; tab: string | null };

/** The page and tab that explain each area, and the name a link to it carries. */
export const AREA_PLACE: Record<Area, Place & { label: string }> = {
  technical: { view: "overview", tab: "technical", label: "Technical" },
  search: { view: "results", tab: "search", label: "Search" },
  keywords: { view: "keywords", tab: null, label: "Keywords" },
  competitors: { view: "competitors", tab: null, label: "Competitors" },
  leads: { view: "results", tab: "enquiries", label: "Enquiries" },
  data: { view: "data", tab: null, label: "Data" },
};

/**
 * Where a link lands. Connections moved into Setup, and the Overview's Search,
 * Competitors and Leads tabs moved to the pages that now hold their content.
 */
export function resolveLink(view: View, tab: string | null): Place {
  if (view === "connections") return { view: "setup", tab: null };
  if (view === "overview" && (tab === "search" || tab === "competitors" || tab === "leads")) return { view: AREA_PLACE[tab].view, tab: AREA_PLACE[tab].tab };
  return { view, tab };
}

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

/** Which area explains an opportunity. A technical enabler resolves one finding, so it goes where that finding does. */
export function opportunityArea(opportunity: Pick<Report["opportunities"][number], "title" | "intent">, findings: Pick<Finding, "title" | "category">[] = []): Area {
  const { intent } = opportunity;
  if (intent === "unpublished_data") return "data";
  if (intent === "keyword_gap") return "keywords";
  if (intent === "content_gap") return "competitors";
  if (intent === "technical_enabler") {
    const finding = findings.find((entry) => opportunity.title === `Resolve: ${entry.title}`);
    return finding ? findingArea(finding.category) : "technical";
  }
  return "search";
}

/** Which area explains a finding. */
export const findingArea = (category: string): Area =>
  category === "search" ? "search" : category === "competitors" ? "competitors" : category === "conversion" ? "leads" : "technical";

export type Action = { title: string; score: number; area: Area };

const URGENT = new Set(["CRITICAL", "HIGH"]);

/**
 * The backlog's top. The growth plan's opportunities rank technical fixes,
 * queries near page one, content and keyword gaps, and unpublished data in
 * one priority order; critical and high findings go first anyway, because
 * the plan can rank a dozen near-page-one queries above pages Google can't
 * read.
 */
export function doFirst(report: Pick<Report, "findings" | "opportunities">, limit = 5): Action[] {
  const urgent = new Set(report.findings.filter((finding) => URGENT.has(finding.severity)).map((finding) => `Resolve: ${finding.title}`));
  return [...report.opportunities]
    .sort((a, b) => Number(urgent.has(b.title)) - Number(urgent.has(a.title)) || b.priorityScore - a.priorityScore)
    .slice(0, limit)
    .map((opportunity) => ({ title: opportunity.title, score: opportunity.priorityScore, area: opportunityArea(opportunity, report.findings) }));
}


type Competition = NonNullable<Report["competition"]>;

/** Content sections ordered by how far the strongest competitor is ahead of you. */
export function gapsFirst(competition: Competition) {
  const lead = (row: Competition["rows"][number]) => Math.max(0, ...row.competitors.map((entry) => entry.pages)) - row.you.pages;
  return [...competition.rows].sort((a, b) => lead(b) - lead(a));
}
