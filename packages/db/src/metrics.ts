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
