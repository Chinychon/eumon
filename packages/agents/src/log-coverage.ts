import { addDays, crawlLogView } from "@organic-growth/core";
import { classifyUrlType } from "@organic-growth/crawler";
import { crawledPathsSince, firstCrawlLogDay, listCrawlLogDays, listCrawlStates, type D1Like } from "@organic-growth/db";
import type { LogCoverage } from "./connector-findings.js";

const DAY_MS = 86_400_000;
/** The crawl-log window an analysis looks back over. */
const COVERAGE_DAYS = 30;

/**
 * Which of an analysis's sitemap URLs Googlebot requested in the logs' last
 * 30 days (fewer when logs started later), per page type; null without logs.
 */
export async function crawlLogCoverage(db: D1Like, siteId: string, analysisId: string, today = new Date().toISOString().slice(0, 10)): Promise<LogCoverage | null> {
  const first = await firstCrawlLogDay(db, siteId);
  if (!first) return null;
  const days = Math.min(COVERAGE_DAYS, Math.round((Date.parse(today) - Date.parse(first)) / DAY_MS));
  const [states, requested, rows] = await Promise.all([
    listCrawlStates(db, analysisId),
    crawledPathsSince(db, siteId, "google", addDays(today, -COVERAGE_DAYS)),
    listCrawlLogDays(db, siteId, addDays(today, -60)),
  ]);
  const families = new Map<string, LogCoverage["families"][number]>();
  for (const url of states.keys()) {
    const family = classifyUrlType(url);
    const entry = families.get(family) ?? { family, sitemapUrls: 0, unrequested: 0, examples: [] };
    entry.sitemapUrls++;
    const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
    if (!requested.has(path)) {
      entry.unrequested++;
      if (entry.examples.length < 5) entry.examples.push(url);
    }
    families.set(family, entry);
  }
  return { days, families: [...families.values()].sort((a, b) => b.unrequested - a.unrequested), view: crawlLogView(rows, today) };
}

