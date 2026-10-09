import type { CrawlDayRow } from "./server-logs.js";

/*
 * Movement in the daily series Eumon stores: the fall from a peak, and how
 * fast Googlebot gets through a sitemap. Pure arithmetic over day points; a
 * day without a point is absent, never zero.
 */

export type DayPoint = { day: string; value: number };
export type Window = { from: string; to: string; average: number };

const DAY_MS = 86_400_000;
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const sorted = (series: DayPoint[]) => [...series].sort((a, b) => a.day.localeCompare(b.day));
const mean = (points: DayPoint[]) => points.reduce((total, point) => total + point.value, 0) / points.length;

/** The last `window` points present, averaged. */
export function latestAverage(series: DayPoint[], window = 7): Window | null {
  const points = sorted(series).slice(-window);
  if (!points.length) return null;
  return { from: points[0]!.day, to: points.at(-1)!.day, average: mean(points) };
}

/**
 * The highest trailing average of `window` points whose last day is at least
 * `window` days before `endBefore` (the series' last day), the latest such
 * window when several tie; null when none reaches `minLevel`. A peak inside
 * the last week is not yet something to have fallen from.
 */
export function peakAverage(series: DayPoint[], window = 7, minLevel = 0, endBefore?: string): Window | null {
  const points = sorted(series);
  const last = endBefore ?? points.at(-1)?.day;
  if (!last) return null;
  const cutoff = shift(last, -window);
  let best: Window | null = null;
  for (let end = window; end <= points.length; end++) {
    const slice = points.slice(end - window, end);
    if (slice.at(-1)!.day > cutoff) break;
    const average = mean(slice);
    if (average >= minLevel && (!best || average >= best.average)) best = { from: slice[0]!.day, to: slice.at(-1)!.day, average };
  }
  return best;
}

/** The fall from the series' highest value in its last 90 days to its latest, when it is at least `minShare` of the peak and `minCount` in absolute terms. */
export function dropFromPeak(series: DayPoint[], minShare: number, minCount: number): { peakDay: string; peak: number; latestDay: string; latest: number; share: number } | null {
  const points = sorted(series);
  const latest = points.at(-1);
  if (!latest) return null;
  const since = shift(latest.day, -90);
  const peak = points.filter((point) => point.day >= since).reduce((best, point) => (point.value > best.value ? point : best), latest);
  const fall = peak.value - latest.value;
  if (peak.value <= 0 || fall < minCount || fall / peak.value < minShare) return null;
  return { peakDay: peak.day, peak: peak.value, latestDay: latest.day, latest: latest.value, share: Math.round((fall / peak.value) * 100) / 100 };
}

/** Googlebot's requests per day over the `window` days ending yesterday, from the log days present; null under `minDays` of them. */
export function googlebotPace(rows: CrawlDayRow[], today: string, window = 28, minDays = 14): { perDay: number; days: number } | null {
  const from = shift(today, -window);
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (row.bot !== "googlebot" || row.day < from || row.day >= today) continue;
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.hits);
  }
  if (byDay.size < minDays) return null;
  const total = [...byDay.values()].reduce((sum, hits) => sum + hits, 0);
  return { perDay: total / byDay.size, days: byDay.size };
}
