import type { CrawlDayRow, CrawlPathRow } from "@organic-growth/core";
import { chunks, runStatements, type D1Like } from "./d1.js";

/*
 * Crawler requests from the site's own logs: sums per day, crawler, page type
 * and status class, and the latest search-engine request per path. Each
 * delivery adds to the sums, so a batch delivered twice counts twice: log
 * shippers deliver at least once, and the numbers are read as trends.
 */

export async function recordCrawlLog(db: D1Like, siteId: string, input: { days: CrawlDayRow[]; paths: CrawlPathRow[] }): Promise<void> {
  const statements = [
    ...input.days.map((row) => db.prepare(
      `INSERT INTO crawl_log_daily (site_id, day, bot, family, status_class, query, hits) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, day, bot, family, status_class, query) DO UPDATE SET hits = hits + excluded.hits`,
    ).bind(siteId, row.day, row.bot, row.family, row.statusClass, row.query ? 1 : 0, row.hits)),
    ...input.paths.map((row) => db.prepare(
      `INSERT INTO crawl_log_paths (site_id, grp, path, last_seen, last_status, hits) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, grp, path) DO UPDATE SET
         hits = hits + excluded.hits,
         last_status = CASE WHEN excluded.last_seen > last_seen THEN excluded.last_status ELSE last_status END,
         last_seen = MAX(last_seen, excluded.last_seen)`,
    ).bind(siteId, row.group, row.path, row.lastSeen, row.lastStatus, row.hits)),
  ];
  // D1 caps a batch's size; deliveries of a few thousand lines stay well within a few batches.
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Day rows from `from` on, for the Crawl log card. */
export async function listCrawlLogDays(db: D1Like, siteId: string, from: string): Promise<CrawlDayRow[]> {
  const { results } = await db.prepare(
    "SELECT day, bot, family, status_class, query, hits FROM crawl_log_daily WHERE site_id = ? AND day >= ? ORDER BY day",
  ).bind(siteId, from).all<{ day: string; bot: string; family: string; status_class: string; query: number; hits: number }>();
  return results.map((row) => ({ day: row.day, bot: row.bot, family: row.family, statusClass: row.status_class, query: row.query === 1, hits: row.hits }));
}

/** Paths (query strings dropped) a search engine requested on or after `since`. */
export async function crawledPathsSince(db: D1Like, siteId: string, group: "google" | "bing", since: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT path FROM crawl_log_paths WHERE site_id = ? AND grp = ? AND last_seen >= ?")
    .bind(siteId, group, since).all<{ path: string }>();
  return new Set(results.map((row) => row.path.split("?")[0]!.replace(/\/+$/, "") || "/"));
}

/** The first day any log was received, or null. */
export async function firstCrawlLogDay(db: D1Like, siteId: string): Promise<string | null> {
  const row = await db.prepare("SELECT MIN(day) AS day FROM crawl_log_daily WHERE site_id = ?").bind(siteId).first<{ day: string | null }>();
  return row?.day ?? null;
}

/** Drops path rows not seen since `pathsBefore` and day rows before `daysBefore`. */
export async function pruneCrawlLog(db: D1Like, siteId: string, input: { pathsBefore: string; daysBefore: string }): Promise<void> {
  await runStatements(db, [
    db.prepare("DELETE FROM crawl_log_paths WHERE site_id = ? AND last_seen < ?").bind(siteId, input.pathsBefore),
    db.prepare("DELETE FROM crawl_log_daily WHERE site_id = ? AND day < ?").bind(siteId, input.daysBefore),
  ]);
}
