/*
 * The analysis report as the console reads it, the small derivations the
 * Overview charts draw from it, and where in the console each area lives.
 * No React here, so it runs under `node --test`.
 */

import type { runFullAnalysis } from "@organic-growth/agents";

export type Finding = { id: string; category: string; severity: string; title: string; summary: string; recommendation?: string; organicImpactScore: number };

/** The saved report: the pipeline's output plus what the workflow adds. Reports saved before a section existed lack it. */
type Saved = Awaited<ReturnType<typeof runFullAnalysis>> & {
  /** Unchanged pages whose results were carried over from the last crawl. */
  crawlReuse?: { urls: number; from?: string };
};
type Later = "coverage" | "competition" | "aiReadiness" | "conversion" | "search" | "repo" | "rendering";
export type Report = Omit<Saved, Later> & Partial<Pick<Saved, Later>>;

/** What a finding or opportunity is about, which decides the page that explains it. */
export type Area = "technical" | "search" | "keywords" | "competitors" | "leads" | "ai" | "data";

/** Rail pages, by the keys their links use. Keys stay as they were when labels changed, so saved and shared links keep working; `results`, `keywords` and `competitors` were pages and are now Overview tabs. */
export type View = "overview" | "results" | "keywords" | "competitors" | "ask" | "connections" | "data" | "pages" | "performance" | "setup";
export type Navigate = (view: View, tab?: string) => void;

/** A rail page and, where it has tabs, the tab (null is the first). */
export type Place = { view: View; tab: string | null };

/** The tab that explains each area, and the name a link to it carries. */
export const AREA_PLACE: Record<Area, Place & { label: string }> = {
  technical: { view: "overview", tab: "technical", label: "Technical" },
  search: { view: "overview", tab: "search", label: "Search" },
  keywords: { view: "overview", tab: "keywords", label: "Keywords" },
  competitors: { view: "overview", tab: "competitors", label: "Competitors" },
  leads: { view: "overview", tab: "enquiries", label: "Enquiries" },
  ai: { view: "overview", tab: "ai", label: "AI visibility" },
  data: { view: "data", tab: null, label: "Data" },
};

/**
 * Where a link lands. Connections moved into Setup; Performance, Keywords and
 * Competitors were pages and are now Overview tabs; the old Leads tab is
 * Enquiries.
 */
export function resolveLink(view: View, tab: string | null): Place {
  if (view === "connections") return { view: "setup", tab: null };
  if (view === "results") return { view: "overview", tab: tab === "enquiries" ? "enquiries" : "search" };
  if (view === "keywords" || view === "competitors") return { view: "overview", tab: view };
  if (view === "overview" && tab === "leads") return { view: "overview", tab: "enquiries" };
  return { view, tab };
}

export const familyLabel = (family: string) => (family === "home" ? "Homepage" : family === "page" ? "Top-level pages" : `/${family}/`);

/** A URL as its path and query, the homepage as `/`: how the console names a page in a row. */
export const urlPath = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";

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
  category === "search" ? "search" : category === "competitors" ? "competitors" : category === "conversion" ? "leads" : category === "ai_visibility" ? "ai" : "technical";

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
