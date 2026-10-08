import { addDays, RESULT_METRICS, resultsView, type ResultsView, type SiteRecord } from "@organic-growth/core";
import { getTopQueriesSnapshot, indexStatusCounts, listMetricSeries, listSiteMarkets, publishedPages, type D1Like } from "@organic-growth/db";
import { ANALYTICS_SCOPE, googleScopes } from "./gsc-auth.ts";

/** Everything the Results view shows for one site, computed from the ledger. */
export async function loadResults(db: D1Like, site: SiteRecord, today = new Date().toISOString().slice(0, 10)): Promise<ResultsView> {
  const [series, pages, index, markets] = await Promise.all([
    listMetricSeries(db, site.id, RESULT_METRICS, addDays(today, -500), today),
    publishedPages(db, site.id),
    indexStatusCounts(db, site.id),
    listSiteMarkets(db, site.id),
  ]);
  const topQueries = site.gscProperty ? await getTopQueriesSnapshot(db, site.id, { property: site.gscProperty, markets }) : null;
  return resultsView({
    today, goLive: pages.goLive, markets, series, index, published: pages.published,
    searchConnected: Boolean(site.gscProperty), ga4Connected: Boolean(site.ga4Property), topQueries,
  });
}

export type ResultsPayload = {
  site: { name: string; baseUrl: string; searchConnected: boolean; analytics: "connected" | "reconnect" | "none" };
  results: ResultsView;
};

/** What the Results view receives. The client link gets no site health and no property IDs. */
export async function resultsPayload(db: D1Like, site: SiteRecord, options: { client?: boolean } = {}): Promise<ResultsPayload> {
  const [results, scopes] = await Promise.all([loadResults(db, site), site.ga4Property ? googleScopes(db, site.id) : Promise.resolve([])]);
  return {
    site: {
      name: site.name,
      baseUrl: site.baseUrl,
      searchConnected: Boolean(site.gscProperty),
      analytics: !site.ga4Property ? "none" : scopes.includes(ANALYTICS_SCOPE) ? "connected" : "reconnect",
    },
    results: options.client ? { ...results, health: { value: null, day: null } } : results,
  };
}
