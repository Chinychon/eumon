import { addDays, RESULT_METRICS, resultsView, type ResultsView, type SiteRecord } from "@organic-growth/core";
import { getTopQueriesSnapshot, indexStatusCounts, listMetricSeries, listSiteCompetitorDomains, listSiteMarkets, publishedPages, type D1Like } from "@organic-growth/db";
import { ANALYTICS_SCOPE, googleScopes } from "./gsc-auth.ts";

/** Everything the Results view shows for one site, computed from the ledger. */
export async function loadResults(db: D1Like, site: SiteRecord, today = new Date().toISOString().slice(0, 10)): Promise<ResultsView> {
  const competitors = await listSiteCompetitorDomains(db, site.id);
  const [series, pages, index, markets] = await Promise.all([
    listMetricSeries(db, site.id, [...RESULT_METRICS, ...competitors.map((domain) => `authority:${domain}`)], addDays(today, -500), today),
    publishedPages(db, site.id),
    indexStatusCounts(db, site.id),
    listSiteMarkets(db, site.id),
  ]);
  const topQueries = site.gscProperty ? await getTopQueriesSnapshot(db, site.id, { property: site.gscProperty, markets }) : null;
  return resultsView({
    today, goLive: pages.goLive, markets, series, index, published: pages.published,
    searchConnected: Boolean(site.gscProperty), ga4Connected: Boolean(site.ga4Property), topQueries, competitors,
  });
}

export type ResultsPayload = {
  site: {
    name: string; baseUrl: string; searchConnected: boolean; analytics: "connected" | "reconnect" | "none";
    /** Whether the speed (Google API) and authority (Open PageRank) keys are set. */
    signals: { speed: boolean; authority: boolean };
  };
  results: ResultsView;
};

/** What the Results view receives. The client link gets no site health and no property IDs. */
export async function resultsPayload(db: D1Like, site: SiteRecord, options: { client?: boolean; signals?: { speed: boolean; authority: boolean } } = {}): Promise<ResultsPayload> {
  const [results, scopes] = await Promise.all([loadResults(db, site), site.ga4Property ? googleScopes(db, site.id) : Promise.resolve([])]);
  return {
    site: {
      name: site.name,
      baseUrl: site.baseUrl,
      searchConnected: Boolean(site.gscProperty),
      analytics: !site.ga4Property ? "none" : scopes.includes(ANALYTICS_SCOPE) ? "connected" : "reconnect",
      signals: options.signals ?? { speed: false, authority: false },
    },
    results: options.client ? { ...results, health: { value: null, day: null } } : results,
  };
}
