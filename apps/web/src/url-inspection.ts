import { inspectUrl, type IndexInspection } from "@organic-growth/agents";
import { addDays, type SiteRecord } from "@organic-growth/core";
import { pagesToInspect, saveIndexStatus, saveUrlIndexStatus, urlsToInspect, type D1Like } from "@organic-growth/db";
import type { GoogleAccess } from "./results-sync.ts";
import { eumonOrigin } from "./source-helpers.ts";

/** URL inspections per workflow step: ten asked at a time, under the Free plan's 50 subrequests a step with the token refresh. */
export const INSPECTION_STEP = 40;
/** Published Eumon pages inspected a day per site, least recently checked first. */
export const PAGE_INSPECTIONS_PER_DAY = 100;
/** Sitemap URLs inspected a day per site (47 steps of 40), which with the pages stays under Google's 2,000 a day per property. */
export const COVERAGE_URLS_PER_DAY = 1880;

export type Inspected<T> = { entry: T; result: IndexInspection | null; status: number; message: string };
export type Round = { inspected: number; remaining: boolean; refused: number | null; error?: string };

/**
 * Asks Google about URLs ten at a time (well under the API's 600 a minute),
 * handing each batch to `save` as it lands. Stops at a refusal that holds for
 * the day: quota (429), a revoked token (401), or a whole batch refused (403).
 * A lone failure is one URL Google won't inspect, or a passing error: `save`
 * sees it with a null result. Nothing is saved for the URLs of a refused batch.
 */
export async function inspectUrls<T>(
  entries: T[], urlOf: (entry: T) => string, token: string, property: string, fetchFn: typeof fetch | undefined,
  save: (batch: Inspected<T>[]) => Promise<void>,
): Promise<{ inspected: number; refused: number | null }> {
  let inspected = 0;
  for (let start = 0; start < entries.length; start += 10) {
    const batch = await Promise.all(entries.slice(start, start + 10).map(async (entry): Promise<Inspected<T>> => {
      try {
        return { entry, result: await inspectUrl(token, property, urlOf(entry), fetchFn), status: 0, message: "" };
      } catch (error) {
        return { entry, result: null, status: (error as { status?: number }).status ?? 0, message: error instanceof Error ? error.message : String(error) };
      }
    }));
    const failed = batch.filter((item) => !item.result);
    const refused = failed.find((item) => item.status === 429 || item.status === 401)?.status
      ?? (failed.length === batch.length && failed.every((item) => item.status === 403) ? 403 : null);
    await save(refused === null ? batch : batch.filter((item) => item.result));
    inspected += batch.length - failed.length;
    if (refused !== null) return { inspected, refused };
  }
  return { inspected, refused: null };
}

/**
 * One step of Eumon pages: those never checked or checked longest ago, skipping
 * pages checked today (so a second sync spends no quota). A page Google fails
 * on is recorded as checked with no verdict, so it counts as "not checked yet"
 * and is not asked again until tomorrow.
 */
export async function inspectEumonPages(db: D1Like, site: SiteRecord, google: GoogleAccess, today: string, limit: number): Promise<{ asked: number; inspected: number; refused: number | null }> {
  const { token } = await google.connect();
  const { origin } = await eumonOrigin(db, site);
  const pages = await pagesToInspect(db, site.id, limit, today);
  const outcome = await inspectUrls(pages, (page) => `${origin}${page.path}`, token, site.gscProperty!, google.fetchFn, (batch) =>
    saveIndexStatus(db, site.id, batch.map(({ entry, result, message }) => ({
      pageId: entry.pageId, ...(result ?? { verdict: "VERDICT_UNSPECIFIED", coverageState: message.slice(0, 300), lastCrawlTime: null }),
    }))));
  return { asked: pages.length, ...outcome };
}

/** One step of the day's sitemap queue. A URL Google won't inspect (for example one outside the property) is recorded as ERROR, so it waits 30 days like a checked one. */
export async function inspectQueuedUrls(
  db: D1Like, siteId: string, property: string, google: GoogleAccess, entries: Array<{ url: string; family: string }>,
): Promise<{ inspected: number; refused: number | null }> {
  const { token } = await google.connect();
  return inspectUrls(entries, (entry) => entry.url, token, property, google.fetchFn, (batch) => saveUrlIndexStatus(db, siteId, batch.map(({ entry, result, message }) => ({
    ...entry, ...(result ?? { verdict: "ERROR", coverageState: message.slice(0, 300), lastCrawlTime: null }),
  }))));
}

/** The next sitemap URLs (unchecked first, then those last checked over 30 days ago) inspected in one go: the queue and a step together. */
export async function inspectSitemapUrls(
  db: D1Like, siteId: string, property: string, token: string, today: string, limit: number, fetchFn?: typeof fetch,
): Promise<Round> {
  const queue = await urlsToInspect(db, siteId, limit, addDays(today, -30));
  const outcome = await inspectQueuedUrls(db, siteId, property, { connect: async () => ({ token, scopes: [] }), fetchFn }, queue);
  return { ...outcome, remaining: queue.length === limit && outcome.refused === null };
}
