import { addDays, GSC_REASONS, parseSearchConsoleExport, reasonFromFileName, suggestRedirect, urlFamily, type GscReason, type SiteRecord } from "@organic-growth/core";
import { crawlGooglebotBatch, type GooglebotCrawlOutcome } from "@organic-growth/crawler";
import {
  importSearchConsoleUrls, listMetricSeries, liveUrlsOfFamily, saveSearchConsoleChart, saveSearchConsoleChecks, saveSearchConsoleSummary, searchConsoleChecksRemaining,
  searchConsoleReconciliation, searchConsoleUrlsToCheck, type D1Like, type SearchConsoleReconciliation,
} from "@organic-growth/db";

/*
 * Search Console's Page indexing exports, imported from Setup: a reason's
 * URL list, the overview table, or the chart. URLs the current crawl doesn't
 * know are fetched a few at a time from the console until none remain.
 */

/** Live fetches per request: the Free plan allows 50 subrequests, and a redirect chain costs several. */
export const CHECKS_PER_REQUEST = 20;
/** A fetch the crawler could not complete is recorded as this status: an error, not a URL still waiting. */
export const FETCH_FAILED = 599;

export type ImportOutcome =
  | { kind: "urls"; reason: GscReason; imported: number; otherHost: number; remainingChecks: number }
  | { kind: "table"; imported: number }
  | { kind: "chart"; imported: number }
  | { error: string };

const isReason = (value: unknown): value is GscReason => GSC_REASONS.some((entry) => entry.reason === value);

/** Reads one export and records it; a URL list needs its reason, from the file name or the operator. */
export async function importExport(db: D1Like, site: Pick<SiteRecord, "id" | "baseUrl">, text: string, options: { reason?: string | null; fileName?: string | null; now?: Date } = {}): Promise<ImportOutcome> {
  const host = new URL(site.baseUrl).hostname;
  const parsed = parseSearchConsoleExport(text, host);
  const now = (options.now ?? new Date()).toISOString();
  if (parsed.kind === "unknown") return { error: parsed.why };
  if (parsed.kind === "table") {
    await saveSearchConsoleSummary(db, site.id, parsed.rows, now);
    return { kind: "table", imported: parsed.rows.length };
  }
  if (parsed.kind === "chart") {
    await saveSearchConsoleChart(db, site.id, parsed.points);
    return { kind: "chart", imported: parsed.points.length };
  }
  if (!parsed.urls.length) {
    return { error: parsed.otherHost ? `The ${parsed.otherHost.toLocaleString("en")} URLs in this file are on another host, not ${host}. Export from the Search Console property for ${host}.` : "The file lists no URLs." };
  }
  const reason = isReason(options.reason) ? options.reason : options.fileName ? reasonFromFileName(options.fileName) : null;
  if (!reason) return { error: "Say which reason this URL list is for: Search Console puts it in the export's file name, or pick it here." };
  await importSearchConsoleUrls(db, site.id, { reason, reasonText: GSC_REASONS.find((entry) => entry.reason === reason)!.label, urls: parsed.urls, importedAt: now });
  return { kind: "urls", reason, imported: parsed.urls.length, otherHost: parsed.otherHost, remainingChecks: await searchConsoleChecksRemaining(db, site.id) };
}

export type Crawl = (urls: string[]) => Promise<GooglebotCrawlOutcome[]>;

/** Fetches the next unchecked URLs as Googlebot, records what they are today, and pairs gone ones with a live page of the same type. */
export async function checkSearchConsoleUrls(db: D1Like, site: Pick<SiteRecord, "id" | "baseUrl">, options: { limit?: number; crawl?: Crawl } = {}): Promise<{ checked: number; remaining: number }> {
  const crawl = options.crawl ?? ((urls: string[]) => crawlGooglebotBatch(urls, undefined, 4));
  const urls = await searchConsoleUrlsToCheck(db, site.id, options.limit ?? CHECKS_PER_REQUEST);
  if (!urls.length) return { checked: 0, remaining: 0 };
  const outcomes = await crawl(urls);
  const liveByFamily = new Map<string, string[]>();
  const rows = [];
  for (const outcome of outcomes) {
    if ("error" in outcome) {
      rows.push({ url: outcome.url, status: FETCH_FAILED, finalUrl: null, noindex: null, suggestedUrl: null });
      continue;
    }
    const { page } = outcome;
    let suggestedUrl: string | null = null;
    if (page.status === 404 || page.status === 410) {
      const family = urlFamily(outcome.url);
      if (!liveByFamily.has(family)) liveByFamily.set(family, await liveUrlsOfFamily(db, site.id, family));
      suggestedUrl = suggestRedirect(outcome.url, liveByFamily.get(family)!);
    }
    rows.push({ url: outcome.url, status: page.status, finalUrl: page.finalUrl ?? null, noindex: page.noindex ?? null, suggestedUrl });
  }
  await saveSearchConsoleChecks(db, site.id, rows);
  return { checked: rows.length, remaining: await searchConsoleChecksRemaining(db, site.id) };
}

export type SearchConsoleView = SearchConsoleReconciliation & { history: Array<{ day: string; indexed: number; notIndexed: number }> };

/** The card: every imported reason reconciled with today, the overview totals, suggestions, and Google's indexed counts over time. */
export async function searchConsoleView(db: D1Like, siteId: string, now = new Date()): Promise<SearchConsoleView> {
  const today = now.toISOString().slice(0, 10);
  const [view, series] = await Promise.all([searchConsoleReconciliation(db, siteId), listMetricSeries(db, siteId, ["gsc_indexed", "gsc_not_indexed"], addDays(today, -480), today)]);
  const days = new Map<string, { day: string; indexed: number; notIndexed: number }>();
  for (const point of series.gsc_indexed ?? []) days.set(point.day, { day: point.day, indexed: point.value, notIndexed: 0 });
  for (const point of series.gsc_not_indexed ?? []) (days.get(point.day) ?? days.set(point.day, { day: point.day, indexed: 0, notIndexed: 0 }).get(point.day)!).notIndexed = point.value;
  return { ...view, history: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}
