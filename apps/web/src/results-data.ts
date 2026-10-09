import { addDays, RESULT_METRICS, resultsView, type ResultsView, type SiteRecord } from "@organic-growth/core";
import { getPageSettings, getTopQueriesSnapshot, indexStatusCounts, listMetricSeries, listSiteCompetitorDomains, listSiteMarkets, outcomesByPageType, publishedPages, type D1Like } from "@organic-growth/db";
import { ANALYTICS_SCOPE, googleScopes } from "./gsc-auth.ts";
import { loadKeywords } from "./keywords-data.ts";
import type { SignalKeys } from "./results-sync.ts";

/** Everything the Results view shows for one site, computed from the ledger and the keyword lists. */
export async function loadResults(db: D1Like, site: SiteRecord, today = new Date().toISOString().slice(0, 10)): Promise<ResultsView> {
  const competitors = await listSiteCompetitorDomains(db, site.id);
  const perCompetitor = competitors.flatMap((domain) => [`authority:${domain}`, `kw_top10:${domain}`, `kw_traffic:${domain}`]);
  const [series, pages, index, markets] = await Promise.all([
    listMetricSeries(db, site.id, [...RESULT_METRICS, ...perCompetitor], addDays(today, -500), today),
    publishedPages(db, site.id),
    indexStatusCounts(db, site.id),
    listSiteMarkets(db, site.id),
  ]);
  const [topQueries, keywords, settings, byPageType] = await Promise.all([
    site.gscProperty ? getTopQueriesSnapshot(db, site.id, { property: site.gscProperty, markets }) : null,
    loadKeywords(db, site, { markets, competitors }),
    getPageSettings(db, site.id),
    // Ninety days: a chat can take weeks to become a customer.
    outcomesByPageType(db, site.id, addDays(today, -90)),
  ]);
  return resultsView({
    today, goLive: pages.goLive, markets, series, index, published: pages.published,
    searchConnected: Boolean(site.gscProperty), ga4Connected: Boolean(site.ga4Property), topQueries, competitors, keywords,
    outcomes: { currency: settings?.currency ?? null, byPageType },
  });
}

export type ResultsPayload = {
  site: {
    name: string; baseUrl: string; searchConnected: boolean; analytics: "connected" | "reconnect" | "none";
    /** Which keyed signals are configured: speed (Google API key), authority (Open PageRank), keywords (DataForSEO). */
    signals: { speed: boolean; authority: boolean; keywords: boolean };
  };
  results: ResultsView;
};

/** What the Results view receives. The client link gets no site health, no AI-crawler access count (an operator's setup detail), and no property IDs. */
export async function resultsPayload(db: D1Like, site: SiteRecord, options: { client?: boolean; keys?: SignalKeys } = {}): Promise<ResultsPayload> {
  const [results, scopes] = await Promise.all([loadResults(db, site), site.ga4Property ? googleScopes(db, site.id) : Promise.resolve([])]);
  return {
    site: {
      name: site.name,
      baseUrl: site.baseUrl,
      searchConnected: Boolean(site.gscProperty),
      analytics: !site.ga4Property ? "none" : scopes.includes(ANALYTICS_SCOPE) ? "connected" : "reconnect",
      signals: { speed: Boolean(options.keys?.googleApiKey), authority: Boolean(options.keys?.openPageRankKey), keywords: Boolean(options.keys?.dataForSeo) },
    },
    results: options.client ? { ...results, health: { value: null, day: null }, ai: { ...results.ai, crawlersAllowed: null } } : results,
  };
}
