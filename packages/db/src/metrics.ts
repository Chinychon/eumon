import { addDays } from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

/*
 * Results ledger: one value per site, metric, and day. Sync jobs overwrite
 * points (so re-runs and Search Console revisions never double count), and
 * readers derive every ratio from the stored components.
 */

export type MetricPoint = { metric: string; day: string; value: number };

export async function upsertMetricPoints(db: D1Like, siteId: string, points: MetricPoint[]): Promise<void> {
  const statements = points.map((point) => db.prepare(
    `INSERT INTO metric_points (site_id, metric, day, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(site_id, metric, day) DO UPDATE SET value = excluded.value`,
  ).bind(siteId, point.metric, point.day, point.value));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Each metric's points between two days (inclusive), oldest first; metrics without points get an empty series. */
export async function listMetricSeries(db: D1Like, siteId: string, metrics: string[], from: string, to: string) {
  const { results } = await db.prepare(
    `SELECT metric, day, value FROM metric_points
     WHERE site_id = ? AND metric IN (SELECT value FROM json_each(?)) AND day >= ? AND day <= ?
     ORDER BY metric, day`,
  ).bind(siteId, JSON.stringify(metrics), from, to).all<{ metric: string; day: string; value: number }>();
  const series: Record<string, Array<{ day: string; value: number }>> = Object.fromEntries(metrics.map((metric) => [metric, []]));
  for (const row of results) series[row.metric]!.push({ day: row.day, value: Number(row.value) });
  return series;
}

export async function firstMetricDay(db: D1Like, siteId: string, metric: string): Promise<string | null> {
  const row = await db.prepare("SELECT MIN(day) AS day FROM metric_points WHERE site_id = ? AND metric = ?").bind(siteId, metric).first<{ day: string | null }>();
  return row?.day ?? null;
}

export async function updateSiteGa4Property(db: D1Like, siteId: string, property: string | null): Promise<void> {
  await db.prepare("UPDATE sites SET ga4_property = ?, updated_at = ? WHERE id = ?").bind(property, nowIso(), siteId).run();
}

/** Revokes every client link issued so far; returns the new version. */
export async function bumpReportShareVersion(db: D1Like, siteId: string): Promise<number> {
  await db.prepare("UPDATE sites SET report_share_version = report_share_version + 1, updated_at = ? WHERE id = ?").bind(nowIso(), siteId).run();
  const row = await db.prepare("SELECT report_share_version AS v FROM sites WHERE id = ?").bind(siteId).first<{ v: number }>();
  return Number(row?.v ?? 1);
}

/** Contact actions that make a visit a lead (Results spec, "Lead"). */
export const LEAD_EVENTS = ["whatsapp_click", "phone_click", "email_click", "form_submit", "booking_complete", "lead_created"];

/** Leads per UTC day: a session counts once a day; an event without a session counts once. */
export async function dailyLeads(db: D1Like, siteId: string, sinceDay: string) {
  const { results } = await db.prepare(
    `WITH contacts AS (
       SELECT substr(occurred_at, 1, 10) AS day, COALESCE(session_id, 'event:' || id) AS who
       FROM conversion_events
       WHERE site_id = ? AND occurred_at >= ? AND event IN (SELECT value FROM json_each(?))
       GROUP BY day, who
     )
     SELECT c.day AS day, COUNT(*) AS leads, SUM(CASE WHEN s.session_id IS NULL THEN 0 ELSE 1 END) AS eumon
     FROM contacts c LEFT JOIN page_sessions s ON s.session_id = c.who AND s.site_id = ?
     GROUP BY c.day ORDER BY c.day`,
  ).bind(siteId, sinceDay, JSON.stringify(LEAD_EVENTS), siteId).all<{ day: string; leads: number; eumon: number }>();
  return results.map((row) => ({ day: row.day, leads: Number(row.leads), eumonLeads: Number(row.eumon) }));
}

/** How many Eumon pages are published, and the day the first one went live. */
export async function publishedPages(db: D1Like, siteId: string): Promise<{ published: number; goLive: string | null }> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n, MIN(published_at) AS first FROM generated_pages WHERE site_id = ? AND status = 'published'",
  ).bind(siteId).first<{ n: number; first: string | null }>();
  return { published: Number(row?.n ?? 0), goLive: row?.first ? row.first.slice(0, 10) : null };
}

/**
 * Writes the first-party Results points: leads, Googlebot fetches, page views
 * and CTA clicks per day, and today's published page count. The first run
 * backfills all history; later runs rewrite the last 7 days.
 */
export async function syncFirstPartyResults(db: D1Like, siteId: string, now = new Date()): Promise<void> {
  const today = now.toISOString().slice(0, 10);
  const since = (await firstMetricDay(db, siteId, "published_pages")) ? addDays(today, -7) : "2000-01-01";
  const [leads, activity, pages, firsts] = await Promise.all([
    dailyLeads(db, siteId, since),
    db.prepare(
      `SELECT day, SUM(googlebot_hits) AS googlebot, SUM(views) AS views, SUM(cta_clicks) AS cta
       FROM page_metrics_daily WHERE site_id = ? AND day >= ? GROUP BY day`,
    ).bind(siteId, since).all<{ day: string; googlebot: number; views: number; cta: number }>(),
    publishedPages(db, siteId),
    db.prepare(
      `SELECT (SELECT substr(MIN(occurred_at), 1, 10) FROM conversion_events WHERE site_id = ?1) AS events,
              (SELECT MIN(day) FROM page_metrics_daily WHERE site_id = ?1) AS activity`,
    ).bind(siteId).first<{ events: string | null; activity: string | null }>(),
  ]);
  // Once tracking has started, a day with nothing is a real 0, not missing data.
  const yesterday = addDays(today, -1);
  const daysFrom = (first: string | null | undefined) => {
    const days: string[] = [];
    if (first) for (let day = first > since ? first : since; day <= yesterday; day = addDays(day, 1)) days.push(day);
    return days;
  };
  const leadsByDay = new Map(leads.map((row) => [row.day, row]));
  const activityByDay = new Map(activity.results.map((row) => [row.day, row]));
  const leadDays = [...new Set([...daysFrom(firsts?.events), ...leadsByDay.keys()])];
  const activityDays = [...new Set([...daysFrom(firsts?.activity), ...activityByDay.keys()])];
  await upsertMetricPoints(db, siteId, [
    ...leadDays.flatMap((day) => [
      { metric: "leads", day, value: leadsByDay.get(day)?.leads ?? 0 },
      { metric: "leads_eumon", day, value: leadsByDay.get(day)?.eumonLeads ?? 0 },
    ]),
    ...activityDays.flatMap((day) => {
      const row = activityByDay.get(day);
      return [
        { metric: "googlebot_fetches", day, value: Number(row?.googlebot ?? 0) },
        { metric: "eumon_page_views", day, value: Number(row?.views ?? 0) },
        { metric: "eumon_cta_clicks", day, value: Number(row?.cta ?? 0) },
      ];
    }),
    { metric: "published_pages", day: today, value: pages.published },
  ]);
}

/** Coverage counts and site health (share of crawled URLs with no error, empty shell, or noindex) from a report. */
export function analysisHealthPoints(report: unknown, day: string): MetricPoint[] {
  const coverage = (report as { coverage?: { totalUrls?: number; completedUrls?: number; emptyShellUrls?: number; httpErrorUrls?: number; issues?: { noindex?: number } } | null } | null)?.coverage;
  if (!coverage?.completedUrls) return [];
  const empty = coverage.emptyShellUrls ?? 0;
  const errors = coverage.httpErrorUrls ?? 0;
  const noindex = coverage.issues?.noindex ?? 0;
  const healthy = Math.max(0, coverage.completedUrls - empty - errors - noindex);
  return [
    { metric: "crawl_urls", day, value: coverage.totalUrls ?? coverage.completedUrls },
    { metric: "crawl_empty_shells", day, value: empty },
    { metric: "crawl_http_errors", day, value: errors },
    { metric: "crawl_noindex", day, value: noindex },
    { metric: "site_health", day, value: Math.round((healthy / coverage.completedUrls) * 1000) / 10 },
  ];
}

/** Published Eumon pages to inspect next: never checked first, then the oldest check. */
export async function pagesToInspect(db: D1Like, siteId: string, limit: number): Promise<Array<{ pageId: string; path: string }>> {
  const { results } = await db.prepare(
    `SELECT g.id, g.path FROM generated_pages g LEFT JOIN page_index_status s ON s.page_id = g.id
     WHERE g.site_id = ? AND g.status = 'published'
     ORDER BY s.checked_at IS NOT NULL, s.checked_at, g.path LIMIT ?`,
  ).bind(siteId, limit).all<{ id: string; path: string }>();
  return results.map((row) => ({ pageId: row.id, path: row.path }));
}

export async function saveIndexStatus(
  db: D1Like, siteId: string,
  rows: Array<{ pageId: string; verdict: string; coverageState: string | null; lastCrawlTime: string | null }>,
): Promise<void> {
  const checkedAt = nowIso();
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO page_index_status (page_id, site_id, verdict, coverage_state, last_crawl_time, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET verdict = excluded.verdict, coverage_state = excluded.coverage_state,
       last_crawl_time = excluded.last_crawl_time, checked_at = excluded.checked_at`,
  ).bind(row.pageId, siteId, row.verdict, row.coverageState, row.lastCrawlTime, checkedAt));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Published pages by their latest inspection: indexed (PASS), not indexed (a verdict other than PASS), and not checked yet (never inspected, or Google gave no verdict). */
export async function indexStatusCounts(db: D1Like, siteId: string): Promise<{ indexed: number; notIndexed: number; unchecked: number }> {
  const row = await db.prepare(
    `SELECT SUM(CASE WHEN s.verdict = 'PASS' THEN 1 ELSE 0 END) AS indexed,
            SUM(CASE WHEN s.verdict IS NOT NULL AND s.verdict NOT IN ('PASS', 'VERDICT_UNSPECIFIED') THEN 1 ELSE 0 END) AS not_indexed,
            SUM(CASE WHEN s.verdict IS NULL OR s.verdict = 'VERDICT_UNSPECIFIED' THEN 1 ELSE 0 END) AS unchecked
     FROM generated_pages g LEFT JOIN page_index_status s ON s.page_id = g.id
     WHERE g.site_id = ? AND g.status = 'published'`,
  ).bind(siteId).first<{ indexed: number | null; not_indexed: number | null; unchecked: number | null }>();
  return { indexed: Number(row?.indexed ?? 0), notIndexed: Number(row?.not_indexed ?? 0), unchecked: Number(row?.unchecked ?? 0) };
}

/** Sites the daily Results sync covers. */
export async function listSitesForResults(db: D1Like): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT id FROM sites WHERE gsc_property IS NOT NULL OR ga4_property IS NOT NULL
       OR id IN (SELECT site_id FROM generated_pages WHERE status = 'published') ORDER BY id`,
  ).all<{ id: string }>();
  return results.map((row) => row.id);
}

/** Every Search Console metric, as `LIKE` patterns (a property change starts their history over). */
export const SEARCH_METRIC_PATTERNS = ["search\\_%", "eumon\\_search\\_%", "queries\\_%", "pages\\_indexed", "pages\\_not\\_indexed"];
/** Every GA4 metric. */
export const GA4_METRIC_PATTERNS = ["ga4\\_%"];

/** Deletes a source's points (by `LIKE` pattern), so the next sync backfills them from the new source. */
export async function clearMetricPoints(db: D1Like, siteId: string, patterns: string[]): Promise<void> {
  await runStatements(db, patterns.map((pattern) => db.prepare("DELETE FROM metric_points WHERE site_id = ? AND metric LIKE ? ESCAPE '\\'").bind(siteId, pattern)));
}
