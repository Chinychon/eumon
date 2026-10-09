import { authorityDomain, type ConnectorSignals, type LogCoverage, type SearchConsoleSignal } from "@organic-growth/agents";
import { addDays, suggestCompetitors, type BacklinkSummary, type CrawlDayRow, type LinkGap, type LinksInput, type ResultsInput, type SerpCompetitor, type SerpResult, type SiteRecord } from "@organic-growth/core";
import { firstMetricDay, listCrawlLogDays, listSnapshots, type D1Like } from "@organic-growth/db";

/** What the connectors beyond Google stored: search results and suggested competitors, link profiles and the gap, and the crawl log. */
export type ConnectorLists = { serp: NonNullable<ResultsInput["serp"]>; links: LinksInput; crawlLog: CrawlDayRow[] };

/**
 * The lists the view and the growth plan read, scoped like the keyword lists:
 * only the current target markets and competitors count, so a changed setting
 * hides the old lists until the next sync replaces them.
 */
export async function loadConnectorLists(db: D1Like, site: Pick<SiteRecord, "id" | "baseUrl">, scope: { markets: string[]; competitors: string[] }, today = new Date().toISOString().slice(0, 10)): Promise<ConnectorLists> {
  const own = authorityDomain(site.baseUrl);
  const domains = new Set([own, ...scope.competitors]);
  const [serpLists, serpCompetitorLists, summaries, gaps, backlinksMarker, crawlLog] = await Promise.all([
    listSnapshots<SerpResult>(db, site.id, "serp"),
    listSnapshots<SerpCompetitor>(db, site.id, "serp_competitors"),
    listSnapshots<BacklinkSummary>(db, site.id, "backlinks"),
    listSnapshots<LinkGap>(db, site.id, "link_gap"),
    firstMetricDay(db, site.id, "sync.backlinks"),
    // Six months of days: enough for the weekly chart, and the 28-day totals.
    listCrawlLogDays(db, site.id, addDays(today, -182)),
  ]);
  const gapScope = scope.competitors.slice(0, 3).sort().join(",");
  const gap = gaps.find((list) => list.scope === gapScope);
  return {
    serp: {
      lists: serpLists.filter((list) => scope.markets.includes(list.scope)).map(({ scope: market, periodEnd, rows }) => ({ market, periodEnd, rows })),
      suggestions: suggestCompetitors(serpCompetitorLists.filter((list) => scope.markets.includes(list.scope)).map((list) => ({ market: list.scope, rows: list.rows })), own, scope.competitors),
    },
    links: {
      site: own,
      competitors: scope.competitors,
      synced: backlinksMarker !== null,
      summaries: summaries.filter((list) => domains.has(list.scope) && list.rows[0]).map((list) => ({ periodEnd: list.periodEnd, row: list.rows[0]! })),
      gap: gap ? { periodEnd: gap.periodEnd, rows: gap.rows } : null,
    },
    crawlLog,
  };
}

/** Everything the analysis takes from the connectors, in the shape the pipeline reads. */
export function connectorSignals(lists: ConnectorLists, logCoverage: LogCoverage | null, searchConsole: SearchConsoleSignal | null = null): ConnectorSignals {
  return { serp: lists.serp.lists.flatMap((list) => list.rows), suggestions: lists.serp.suggestions, links: lists.links, logCoverage, searchConsole };
}
