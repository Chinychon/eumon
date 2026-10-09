import { inspectUrl, type IndexInspection } from "@organic-growth/agents";
import { addDays } from "@organic-growth/core";
import { saveUrlIndexStatus, urlsToInspect, type D1Like } from "@organic-growth/db";
import type { GoogleAccess } from "./results-sync.ts";

/** URL inspections per daily-workflow step (up to nine a day). */
export const COVERAGE_STEP = 200;

export type Inspected<T> = { entry: T; result: IndexInspection | null; status: number; message: string };

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
 * Asks Google about the next sitemap URLs: unchecked first, then those last
 * checked over 30 days ago. A URL Google won't inspect (for example one
 * outside the property) is recorded as ERROR, so it waits 30 days like a
 * checked one instead of blocking the queue.
 */
export async function inspectSitemapUrls(
  db: D1Like, siteId: string, property: string, token: string, today: string, limit: number, fetchFn?: typeof fetch,
): Promise<{ inspected: number; refused: number | null; remaining: boolean }> {
  const queue = await urlsToInspect(db, siteId, limit, addDays(today, -30));
  const outcome = await inspectUrls(queue, (entry) => entry.url, token, property, fetchFn, (batch) => saveUrlIndexStatus(db, siteId, batch.map(({ entry, result, message }) => ({
    ...entry, ...(result ?? { verdict: "ERROR", coverageState: message.slice(0, 300), lastCrawlTime: null }),
  }))));
  return { ...outcome, remaining: queue.length === limit && outcome.refused === null };
}

/**
 * One of the daily workflow's extra coverage steps: true while URLs remain.
 * Any failure (revoked access, a database error) ends this site's rounds
 * quietly, so the workflow moves on to the next site.
 */
export async function coverageRound(db: D1Like, siteId: string, property: string, google: GoogleAccess, today: string, limit = COVERAGE_STEP): Promise<boolean> {
  try {
    const { token } = await google.connect();
    return (await inspectSitemapUrls(db, siteId, property, token, today, limit, google.fetchFn)).remaining;
  } catch {
    return false;
  }
}
