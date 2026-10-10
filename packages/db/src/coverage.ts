import { COVERAGE_CLASSES, coverageClass, type CoverageClass } from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

/** The site's latest finished analysis: its crawl is the set of sitemap URLs Google should have. */
export async function latestCrawl(db: D1Like, siteId: string): Promise<string | null> {
  const row = await db.prepare("SELECT id FROM analyses WHERE site_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1").bind(siteId).first<{ id: string }>();
  return row?.id ?? null;
}

/** Served pages of a crawl, with their page type. */
const CURRENT = `SELECT url, route_family AS family FROM pages
  WHERE analysis_id = ? AND crawl_state = 'complete' AND status < 400`;

/**
 * The next sitemap URLs to inspect: never-checked ones first, taken in turn
 * from each page type so every type is sampled early, then ones last checked
 * before `staleBefore`, oldest first.
 */
export async function urlsToInspect(db: D1Like, siteId: string, limit: number, staleBefore: string): Promise<Array<{ url: string; family: string }>> {
  const latest = await latestCrawl(db, siteId);
  if (!latest) return [];
  const { results: fresh } = await db.prepare(
    `SELECT url, family FROM (
       SELECT c.url, c.family, ROW_NUMBER() OVER (PARTITION BY c.family ORDER BY c.url) AS turn
       FROM (${CURRENT}) c LEFT JOIN url_index_status s ON s.site_id = ? AND s.url = c.url
       WHERE s.url IS NULL)
     ORDER BY turn, family LIMIT ?`,
  ).bind(latest, siteId, limit).all<{ url: string; family: string }>();
  if (fresh.length >= limit) return fresh;
  const { results: stale } = await db.prepare(
    `SELECT s.url, s.family FROM url_index_status s JOIN (${CURRENT}) c ON c.url = s.url
     WHERE s.site_id = ? AND s.checked_at < ? ORDER BY s.checked_at, s.url LIMIT ?`,
  ).bind(latest, siteId, staleBefore, limit - fresh.length).all<{ url: string; family: string }>();
  return [...fresh, ...stale];
}

export async function saveUrlIndexStatus(
  db: D1Like, siteId: string,
  rows: Array<{ url: string; family: string; verdict: string; coverageState: string | null; lastCrawlTime: string | null }>,
): Promise<void> {
  const checkedAt = nowIso();
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO url_index_status (site_id, url, family, verdict, coverage_state, last_crawl_time, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, url) DO UPDATE SET family = excluded.family, verdict = excluded.verdict, coverage_state = excluded.coverage_state,
       last_crawl_time = excluded.last_crawl_time, checked_at = excluded.checked_at`,
  ).bind(siteId, row.url, row.family, row.verdict, row.coverageState, row.lastCrawlTime, checkedAt));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

export type IndexCoverage = {
  /** Sitemap URLs in the latest crawl, and how many Google has been asked about. */
  total: number;
  checked: number;
  /** Checked URLs Google crawled in the last 30 days. */
  recentlyCrawled: number;
  byClass: Record<CoverageClass, number>;
  families: Array<{ family: string; total: number; checked: number; byClass: Record<CoverageClass, number> }>;
};

const emptyClasses = () => Object.fromEntries(COVERAGE_CLASSES.map((name) => [name, 0])) as Record<CoverageClass, number>;

/** What Google did with the sitemap URLs it has been asked about, overall and per page type; null before the first finished crawl. */
export async function indexCoverage(db: D1Like, siteId: string, now: Date): Promise<IndexCoverage | null> {
  const latest = await latestCrawl(db, siteId);
  if (!latest) return null;
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const { results } = await db.prepare(
    `SELECT c.family, s.verdict, s.coverage_state, COUNT(*) AS n, SUM(CASE WHEN s.last_crawl_time >= ? THEN 1 ELSE 0 END) AS recent
     FROM (${CURRENT}) c LEFT JOIN url_index_status s ON s.site_id = ? AND s.url = c.url
     GROUP BY c.family, s.verdict, s.coverage_state`,
  ).bind(since, latest, siteId).all<{ family: string; verdict: string | null; coverage_state: string | null; n: number; recent: number | null }>();
  const families = new Map<string, IndexCoverage["families"][number]>();
  const coverage: IndexCoverage = { total: 0, checked: 0, recentlyCrawled: 0, byClass: emptyClasses(), families: [] };
  for (const row of results) {
    const family = families.get(row.family) ?? { family: row.family, total: 0, checked: 0, byClass: emptyClasses() };
    const n = Number(row.n);
    family.total += n;
    coverage.total += n;
    // ERROR: Google wouldn't inspect it (outside the property, say); it waits like a checked URL but isn't counted as one.
    if (row.verdict !== null && row.verdict !== "ERROR") {
      const name = coverageClass(row.verdict, row.coverage_state);
      family.checked += n;
      family.byClass[name] += n;
      coverage.checked += n;
      coverage.byClass[name] += n;
      coverage.recentlyCrawled += Number(row.recent ?? 0);
    }
    families.set(row.family, family);
  }
  coverage.families = [...families.values()].sort((a, b) => b.total - a.total || a.family.localeCompare(b.family));
  return coverage;
}

/** Inspections of this site's pages and sitemap URLs since an instant: what the day's quota has already paid for. */
export async function countInspectionsSince(db: D1Like, siteId: string, since: string): Promise<number> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM url_index_status WHERE site_id = ?1 AND checked_at >= ?2)
          + (SELECT COUNT(*) FROM page_index_status WHERE site_id = ?1 AND checked_at >= ?2) AS n`,
  ).bind(siteId, since).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
