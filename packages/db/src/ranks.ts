import type { RankCheck } from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

/*
 * Rank tracking: the searches the user names (`tracked_keywords`) and Google's
 * position for each in each target market, per day (`rank_checks`). A check
 * with a null position means the site wasn't in the ten results fetched.
 */

/** Replaces the list. Keywords arrive normalised (lower-cased, whitespace collapsed) and de-duplicated. */
export async function setTrackedKeywords(db: D1Like, siteId: string, keywords: string[]): Promise<void> {
  const at = nowIso();
  await runStatements(db, [
    db.prepare("DELETE FROM tracked_keywords WHERE site_id = ?").bind(siteId),
    ...keywords.map((keyword) => db.prepare("INSERT INTO tracked_keywords (site_id, keyword, created_at) VALUES (?, ?, ?)").bind(siteId, keyword, at)),
  ]);
}

export async function listTrackedKeywords(db: D1Like, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT keyword FROM tracked_keywords WHERE site_id = ? ORDER BY keyword").bind(siteId).all<{ keyword: string }>();
  return results.map((row) => row.keyword);
}

/** One row per keyword, market and day; a day saved twice keeps the later values. */
export async function saveRankChecks(db: D1Like, siteId: string, rows: RankCheck[]): Promise<void> {
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO rank_checks (site_id, keyword, market, day, position, url, features_json) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, keyword, market, day) DO UPDATE SET position = excluded.position, url = excluded.url, features_json = excluded.features_json`,
  ).bind(siteId, row.keyword, row.market, row.day, row.position, row.url, JSON.stringify(row.features)));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Every check from `fromDay` on, by keyword, market and day (oldest first). */
export async function listRankChecks(db: D1Like, siteId: string, fromDay: string): Promise<RankCheck[]> {
  const { results } = await db.prepare(
    "SELECT keyword, market, day, position, url, features_json FROM rank_checks WHERE site_id = ? AND day >= ? ORDER BY keyword, market, day",
  ).bind(siteId, fromDay).all<{ keyword: string; market: string; day: string; position: number | null; url: string | null; features_json: string }>();
  return results.map((row) => ({ keyword: row.keyword, market: row.market, day: row.day, position: row.position === null ? null : Number(row.position), url: row.url, features: JSON.parse(row.features_json) as string[] }));
}

/** The keyword|market pairs already checked on a day, so a second sync spends nothing. */
export async function checkedPairsOn(db: D1Like, siteId: string, day: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT keyword, market FROM rank_checks WHERE site_id = ? AND day = ?").bind(siteId, day).all<{ keyword: string; market: string }>();
  return new Set(results.map((row) => `${row.keyword}|${row.market}`));
}

export async function pruneRankChecks(db: D1Like, siteId: string, beforeDay: string): Promise<void> {
  await db.prepare("DELETE FROM rank_checks WHERE site_id = ? AND day < ?").bind(siteId, beforeDay).run();
}
