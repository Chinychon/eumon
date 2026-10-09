import { GSC_REASONS, type GscReason, type GscSummaryRow, type TodayStatus } from "@organic-growth/core";
import { latestCrawl } from "./coverage.js";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";
import { upsertMetricPoints } from "./metrics.js";
import { getSnapshot, saveSnapshot } from "./snapshots.js";

/*
 * Search Console's Page indexing exports, kept per URL with the reason Google
 * gave, and read back against the latest crawl: what each URL is today.
 */

const SUMMARY = "search_console_summary";
const TODAY: TodayStatus[] = ["indexable", "noindex", "redirect", "gone", "error", "unchecked"];
const EXAMPLES = 10;

/**
 * Saves a reason's URL list in place of the last one for that reason, in two
 * statements whatever its size: a URL Google no longer lists leaves Eumon
 * too, and every listed URL starts unchecked, so a re-import re-checks.
 */
export async function importSearchConsoleUrls(
  db: D1Like, siteId: string,
  input: { reason: GscReason; reasonText: string; urls: Array<{ url: string; lastCrawled: string | null }>; importedAt: string },
): Promise<{ imported: number }> {
  const unique = [...new Map(input.urls.map((row) => [row.url, row])).values()];
  await runStatements(db, [
    db.prepare("DELETE FROM search_console_urls WHERE site_id = ? AND reason = ?").bind(siteId, input.reason),
    db.prepare(
      `INSERT INTO search_console_urls (site_id, url, reason, reason_text, last_crawled, imported_at)
       SELECT ?, json_extract(value, '$.url'), ?, ?, json_extract(value, '$.lastCrawled'), ? FROM json_each(?) WHERE true
       ON CONFLICT(site_id, url) DO UPDATE SET reason = excluded.reason, reason_text = excluded.reason_text, last_crawled = excluded.last_crawled, imported_at = excluded.imported_at,
         live_status = NULL, live_final_url = NULL, live_noindex = NULL, checked_at = NULL, suggested_url = NULL`,
    ).bind(siteId, input.reason, input.reasonText, input.importedAt, JSON.stringify(unique)),
  ]);
  return { imported: unique.length };
}

/** The overview table (pages per reason) as exported, replacing the last one. */
export async function saveSearchConsoleSummary(db: D1Like, siteId: string, rows: GscSummaryRow[], importedAt: string): Promise<void> {
  await saveSnapshot(db, siteId, { kind: SUMMARY, scope: "table", periodEnd: importedAt.slice(0, 10), rows });
}

/** The chart's indexed and not-indexed counts per day, into the ledger. */
export async function saveSearchConsoleChart(db: D1Like, siteId: string, points: Array<{ day: string; indexed: number; notIndexed: number }>): Promise<void> {
  await upsertMetricPoints(db, siteId, points.flatMap((point) => [
    { metric: "gsc_indexed", day: point.day, value: point.indexed },
    { metric: "gsc_not_indexed", day: point.day, value: point.notIndexed },
  ]));
}

/** Imported URLs not yet fetched that the crawl doesn't know (old slugs, pages dropped from the sitemap), alphabetically. */
export async function searchConsoleUrlsToCheck(db: D1Like, siteId: string, limit: number, crawlId?: string): Promise<string[]> {
  const crawl = crawlId ?? (await latestCrawl(db, siteId)) ?? "";
  const { results } = await db.prepare(
    `SELECT s.url FROM search_console_urls s
     WHERE s.site_id = ? AND s.checked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.analysis_id = ? AND p.url = s.url AND p.crawl_state = 'complete')
     ORDER BY s.url LIMIT ?`,
  ).bind(siteId, crawl, limit).all<{ url: string }>();
  return results.map((row) => String(row.url));
}

/** How many imported URLs outside the crawl still wait for a live fetch. */
export async function searchConsoleChecksRemaining(db: D1Like, siteId: string, crawlId?: string): Promise<number> {
  const crawl = crawlId ?? (await latestCrawl(db, siteId)) ?? "";
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM search_console_urls s WHERE s.site_id = ? AND s.checked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.analysis_id = ? AND p.url = s.url AND p.crawl_state = 'complete')`,
  ).bind(siteId, crawl).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** What live fetches found, and for gone URLs the live page suggested. */
export async function saveSearchConsoleChecks(
  db: D1Like, siteId: string,
  rows: Array<{ url: string; status: number | null; finalUrl: string | null; noindex: boolean | null; suggestedUrl: string | null }>,
): Promise<void> {
  const checkedAt = nowIso();
  const statements = rows.map((row) => db.prepare(
    "UPDATE search_console_urls SET live_status = ?, live_final_url = ?, live_noindex = ?, checked_at = ?, suggested_url = ? WHERE site_id = ? AND url = ?",
  ).bind(row.status, row.finalUrl, row.noindex === null ? null : row.noindex ? 1 : 0, checkedAt, row.suggestedUrl, siteId, row.url));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Imported URLs the crawl knows as gone (404/410) that haven't been paired with a live page yet, alphabetically. */
export async function searchConsoleGoneUnsuggested(db: D1Like, siteId: string, crawlId: string | undefined, limit: number): Promise<string[]> {
  const crawl = crawlId ?? (await latestCrawl(db, siteId)) ?? "";
  const { results } = await db.prepare(
    `SELECT s.url FROM search_console_urls s JOIN pages p ON p.analysis_id = ? AND p.url = s.url AND p.crawl_state = 'complete'
     WHERE s.site_id = ? AND s.checked_at IS NULL AND p.status IN (404, 410) ORDER BY s.url LIMIT ?`,
  ).bind(crawl, siteId, limit).all<{ url: string }>();
  return results.map((row) => String(row.url));
}

/** The live pages gone URLs should redirect to (null when none fits); each URL counts as checked so it isn't asked again. */
export async function saveSearchConsoleSuggestions(db: D1Like, siteId: string, rows: Array<{ url: string; suggestedUrl: string | null }>): Promise<void> {
  const checkedAt = nowIso();
  const statements = rows.map((row) => db.prepare("UPDATE search_console_urls SET suggested_url = ?, checked_at = ? WHERE site_id = ? AND url = ?").bind(row.suggestedUrl, checkedAt, siteId, row.url));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Served URLs of one page type (the crawler's `route_family`) in a crawl: the candidates a gone URL can redirect to. */
export async function liveUrlsOfFamily(db: D1Like, siteId: string, family: string, crawlId?: string): Promise<string[]> {
  const crawl = crawlId ?? (await latestCrawl(db, siteId));
  if (!crawl) return [];
  const { results } = await db.prepare(
    "SELECT url FROM pages WHERE analysis_id = ? AND crawl_state = 'complete' AND status < 400 AND route_family = ? ORDER BY url",
  ).bind(crawl, family).all<{ url: string }>();
  return results.map((row) => String(row.url));
}

export type SearchConsoleReconciliation = {
  /** When the latest URL list was imported; null when nothing has been. */
  importedAt: string | null;
  summary: { rows: GscSummaryRow[]; importedAt: string } | null;
  /** Google's own indexed and not-indexed counts on the latest day the chart was imported for. */
  counts: { day: string; indexed: number; notIndexed: number } | null;
  /** Per imported reason, in Search Console's order: what those URLs are today, with up to ten examples each. */
  reasons: Array<{ reason: GscReason; reasonText: string; urls: number; today: Record<TodayStatus, number>; examples: Partial<Record<TodayStatus, string[]>> }>;
  suggestions: Array<{ url: string; suggestedUrl: string }>;
  /** Imported URLs outside the crawl still waiting for a live fetch. */
  remainingChecks: number;
};

/**
 * Every imported URL classified today (the same rules as `todayStatus`,
 * written in SQL so a 20,000-URL list costs counts, not rows): the crawl's
 * row when it has one, otherwise the live check, otherwise unchecked. The
 * crawl is the latest finished one unless the caller names one, as an
 * analysis being built names its own.
 */
export async function searchConsoleReconciliation(db: D1Like, siteId: string, crawlId?: string): Promise<SearchConsoleReconciliation> {
  const crawl = crawlId ?? (await latestCrawl(db, siteId)) ?? "";
  const [latest, summary, { results: ranked }, { results: suggested }, remaining, { results: chart }] = await Promise.all([
    db.prepare("SELECT MAX(imported_at) AS at FROM search_console_urls WHERE site_id = ?").bind(siteId).first<{ at: string | null }>(),
    getSnapshot<GscSummaryRow>(db, siteId, SUMMARY, "table"),
    db.prepare(
      `WITH known AS (
         SELECT s.url, s.reason, s.reason_text,
           CASE WHEN p.url IS NOT NULL THEN p.status ELSE s.live_status END AS st,
           CASE WHEN p.url IS NOT NULL THEN json_extract(p.result_json, '$.finalUrl') ELSE s.live_final_url END AS fin,
           CASE WHEN p.url IS NOT NULL THEN json_extract(p.result_json, '$.noindex') ELSE s.live_noindex END AS noi
         FROM search_console_urls s LEFT JOIN pages p ON p.analysis_id = ? AND p.url = s.url AND p.crawl_state = 'complete'
         WHERE s.site_id = ?),
       classified AS (
         SELECT url, reason, reason_text,
           CASE WHEN st IS NULL THEN 'unchecked' WHEN st IN (404, 410) THEN 'gone' WHEN st >= 400 THEN 'error'
             WHEN fin IS NOT NULL AND rtrim(fin, '/') != rtrim(url, '/') THEN 'redirect' WHEN noi = 1 THEN 'noindex' ELSE 'indexable' END AS today
         FROM known),
       ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY reason, today ORDER BY url) AS rn, COUNT(*) OVER (PARTITION BY reason, today) AS n FROM classified)
       SELECT reason, reason_text, today, n, url FROM ranked WHERE rn <= ? ORDER BY reason, today, url`,
    ).bind(crawl, siteId, EXAMPLES).all<{ reason: GscReason; reason_text: string; today: TodayStatus; n: number; url: string }>(),
    db.prepare("SELECT url, suggested_url FROM search_console_urls WHERE site_id = ? AND suggested_url IS NOT NULL ORDER BY url LIMIT 200").bind(siteId).all<{ url: string; suggested_url: string }>(),
    searchConsoleChecksRemaining(db, siteId, crawl),
    db.prepare(
      `SELECT metric, day, value FROM metric_points WHERE site_id = ? AND metric IN ('gsc_indexed', 'gsc_not_indexed')
         AND day = (SELECT MAX(day) FROM metric_points WHERE site_id = ? AND metric = 'gsc_indexed')`,
    ).bind(siteId, siteId).all<{ metric: string; day: string; value: number }>(),
  ]);
  const counts = chart.length ? { day: String(chart[0]!.day), indexed: Number(chart.find((row) => row.metric === "gsc_indexed")?.value ?? 0), notIndexed: Number(chart.find((row) => row.metric === "gsc_not_indexed")?.value ?? 0) } : null;
  const reasons = new Map<GscReason, SearchConsoleReconciliation["reasons"][number]>();
  for (const row of ranked) {
    const entry = reasons.get(row.reason) ?? { reason: row.reason, reasonText: row.reason_text, urls: 0, today: Object.fromEntries(TODAY.map((name) => [name, 0])) as Record<TodayStatus, number>, examples: {} };
    if (!entry.today[row.today]) { entry.today[row.today] = Number(row.n); entry.urls += Number(row.n); }
    (entry.examples[row.today] ??= []).push(String(row.url));
    reasons.set(row.reason, entry);
  }
  const order = new Map(GSC_REASONS.map((entry, index) => [entry.reason, index]));
  return {
    importedAt: latest?.at ?? null,
    summary: summary ? { rows: summary.rows, importedAt: summary.periodEnd } : null,
    counts,
    reasons: [...reasons.values()].sort((a, b) => (order.get(a.reason) ?? 99) - (order.get(b.reason) ?? 99)),
    suggestions: suggested.map((row) => ({ url: String(row.url), suggestedUrl: String(row.suggested_url) })),
    remainingChecks: remaining,
  };
}
