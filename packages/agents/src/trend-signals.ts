import { addDays, type CrawlDayRow } from "@organic-growth/core";
import { listMetricSeries, type D1Like } from "@organic-growth/db";
import type { TrendSignals } from "./connector-findings.js";

/** Days of ledger the trend findings look back over. */
export const TREND_LOOKBACK_DAYS = 120;
/** Search Console's latest days are still filling in (the Results view treats them the same way), so the current week ends before them. */
export const FRESH_DAYS = 3;

/**
 * The series the trend findings read: Search Console impressions, Google's
 * indexed count (the imported chart when there is one, else the inspection
 * sample), and the crawl-log days the caller already loaded.
 */
export async function loadTrendSignals(db: D1Like, siteId: string, crawlLog: CrawlDayRow[], today = new Date().toISOString().slice(0, 10)): Promise<TrendSignals> {
  const series = await listMetricSeries(db, siteId, ["search_impressions", "gsc_indexed", "pages_indexed", "pages_not_indexed"], addDays(today, -TREND_LOOKBACK_DAYS), today);
  const chart = series.gsc_indexed ?? [];
  const sample = series.pages_indexed ?? [];
  const complete = addDays(today, -FRESH_DAYS);
  return {
    impressions: (series.search_impressions ?? []).filter((point) => point.day <= complete),
    indexed: chart.length ? chart : sample,
    indexedSource: chart.length ? "search_console" : sample.length ? "inspection" : null,
    notIndexed: chart.length ? [] : series.pages_not_indexed ?? [],
    crawlLog,
    today,
  };
}
