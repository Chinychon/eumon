import { addDays, RESULT_METRICS, resultsView, type ResultsView, type SiteRecord } from "@organic-growth/core";
import { indexStatusCounts, listMetricSeries, listSiteMarkets, publishedPages, type D1Like } from "@organic-growth/db";

/** Everything the Results view shows for one site, computed from the ledger. */
export async function loadResults(db: D1Like, site: SiteRecord, today = new Date().toISOString().slice(0, 10)): Promise<ResultsView> {
  const [series, pages, index, markets] = await Promise.all([
    listMetricSeries(db, site.id, RESULT_METRICS, addDays(today, -500), today),
    publishedPages(db, site.id),
    indexStatusCounts(db, site.id),
    listSiteMarkets(db, site.id),
  ]);
  return resultsView({
    today, goLive: pages.goLive, markets, series, index, published: pages.published,
    searchConnected: Boolean(site.gscProperty), ga4Connected: Boolean(site.ga4Property),
  });
}
