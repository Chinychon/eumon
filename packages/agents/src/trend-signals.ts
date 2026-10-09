import { addDays, type CrawlDayRow } from "@organic-growth/core";
import { listMetricSeries, type D1Like } from "@organic-growth/db";
import type { TrendSignals } from "./connector-findings.js";

/** Days of ledger the trend findings look back over. */
export const TREND_LOOKBACK_DAYS = 120;

/**
 * The series the trend findings read: Search Console impressions, Google's
 * indexed count (the imported chart when there is one, else the inspection
 * sample), and the crawl-log days the caller already loaded.
 */
export async function loadTrendSignals(db: D1Like, siteId: string, crawlLog: CrawlDayRow[], today = new Date().toISOString().slice(0, 10)): Promise<TrendSignals> {
  const series = await listMetricSeries(db, siteId, ["search_impressions", "gsc_indexed", "pages_indexed"], addDays(today, -TREND_LOOKBACK_DAYS), today);
  const chart = series.gsc_indexed ?? [];
  const sample = series.pages_indexed ?? [];
  return {
    impressions: series.search_impressions ?? [],
    indexed: chart.length ? chart : sample,
    indexedSource: chart.length ? "search_console" : sample.length ? "inspection" : null,
    crawlLog,
    today,
  };
}
