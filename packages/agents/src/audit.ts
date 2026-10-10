import { CHECKS, checkList, healthScore, type CrawlCoverage, type Finding, type Pillar } from "@organic-growth/core";

/*
 * The audit on every report: each registered check as passed, failed (with
 * its page count) or skipped (with what the site lacks), and the two health
 * scores. Class decides the score; severity, set per finding, ranks the plan.
 */

export type AuditRow = { id: string; status: "passed" | "failed" | "skipped"; pages?: number; reason?: string };
export type Score = { value: number | null; indexable: number; unhealthy: number; reason?: string };
export type Audit = { seo: Score; ai: Score; checks: AuditRow[] };

export type AuditContext = {
  findings: Finding[];
  coverage?: CrawlCoverage;
  hasRepo: boolean;
  hasSearch: boolean;
  hasLogs: boolean;
  hasDataset: boolean;
  /** A browser rendered one page per template. */
  rendered: boolean;
  languages: number;
  hasDataForSeo: boolean;
  robotsReadable: boolean;
  /** The AI crawler and host probe ran. */
  probed: boolean;
  probe?: Array<{ agent: string; search: boolean; allowedByRobots: boolean; fetched: number; refused: number }>;
};

const RECRAWL = "run a full crawl once after deploying";
/** Checks that read fields the crawler records since the audit engine; rows from older crawls lack them. */
const NEEDS_NEW_FIELDS = new Set([
  "http.redirect_chain", "http.meta_refresh", "security.mixed_content", "security.http_links", "title.length", "description.length", "description.duplicate",
  "heading.h1_equals_title", "heading.skipped_levels", "html.lang_missing", "html.viewport_missing", "image.alt_missing", "content.thin", "url.year_in_slug",
  "ai.snippet_blocked", "ai.stale", "ai.no_date", "ai.no_answer_structure", "ai.low_evidence", "ai.no_author", "ai.semantic_html_missing",
  "links.broken_internal", "links.orphan", "links.single_inbound", "links.depth",
]);

export function auditTable(ctx: AuditContext): AuditRow[] {
  const failed = new Map<string, number>();
  for (const found of ctx.findings) if (found.checkId) failed.set(found.checkId, (failed.get(found.checkId) ?? 0) + (found.pagesAffected?.length ?? 0));
  const issues = (ctx.coverage?.issues ?? {}) as Record<string, number | undefined>;
  return checkList().map((check): AuditRow => {
    // Coverage counts every page; pagesAffected holds examples only.
    if (failed.has(check.id)) return { id: check.id, status: "failed", pages: (check.issue && issues[check.issue]) || failed.get(check.id)! };
    const skip = (reason: string): AuditRow => ({ id: check.id, status: "skipped", reason });
    const needs = check.requires ?? "";
    if (/repository/.test(needs) && !ctx.hasRepo) return skip(needs);
    if (/Search Console/.test(needs) && !ctx.hasSearch) return skip(needs);
    if (/server logs/.test(needs) && !ctx.hasLogs) return skip(needs);
    if (/dataset/.test(needs) && !ctx.hasDataset) return skip(needs);
    if (/languages/.test(needs) && ctx.languages < 2) return skip(needs);
    if (/DataForSEO/.test(needs) && !ctx.hasDataForSeo) return skip(needs);
    if (/browser render/.test(needs) && !ctx.rendered) return skip(needs);
    if (check.sources.includes("crawl") && !check.sources.includes("sample") && !ctx.coverage?.completedUrls) return skip("a full crawl");
    if (NEEDS_NEW_FIELDS.has(check.id) && ctx.coverage && !ctx.coverage.health?.checked) return skip(RECRAWL);
    if (check.id === "ai.crawler_refused" && !ctx.robotsReadable) return skip("robots.txt could not be read");
    if (check.sources.includes("probe") && check.id !== "server.soft_404_probe" && !ctx.probed) return skip("the AI crawler and host probe");
    if (check.id === "links.depth" && ctx.coverage?.linkGraph?.depth?.skipped) return skip(ctx.coverage.linkGraph.depth.skipped);
    return { id: check.id, status: "passed" };
  });
}

/** Both health scores. A site-wide error of the pillar zeroes it; for AI, a refused crawler zeroes it only when every search crawler robots.txt allows was refused. */
export function pillarScores(ctx: AuditContext): { seo: Score; ai: Score } {
  const health = ctx.coverage?.health;
  const siteError = (pillar: Pillar) => ctx.findings.find((found) => {
    const check = found.checkId ? CHECKS[found.checkId] : undefined;
    return check && check.scope === "site" && check.class === "error" && check.pillars.includes(pillar) && check.id !== "ai.crawler_refused";
  });
  const allowed = (ctx.probe ?? []).filter((agent) => agent.search && agent.allowedByRobots && agent.fetched > 0);
  const allRefused = allowed.length > 0 && allowed.every((agent) => agent.refused === agent.fetched);
  const score = (pillar: Pillar, unhealthy: number): Score => {
    if (!health) return { value: null, indexable: 0, unhealthy, reason: "no finished full crawl" };
    if (!health.checked) return { value: null, indexable: health.indexable, unhealthy, reason: RECRAWL };
    const blocker = siteError(pillar) ?? (pillar === "ai" && allRefused ? ctx.findings.find((found) => found.checkId === "ai.crawler_refused") : undefined);
    return { value: healthScore({ indexable: health.indexable, unhealthy, siteErrors: blocker ? 1 : 0 }), indexable: health.indexable, unhealthy, ...(blocker ? { reason: blocker.title } : {}) };
  };
  return { seo: score("seo", health?.unhealthySeo ?? 0), ai: score("ai", health?.unhealthyAi ?? 0) };
}

export function buildAudit(ctx: AuditContext): Audit {
  return { ...pillarScores(ctx), checks: auditTable(ctx) };
}
