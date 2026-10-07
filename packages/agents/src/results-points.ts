import { RANK_BUCKETS } from "@organic-growth/core";
import type { MetricPoint } from "@organic-growth/db";

export type SearchDay = { day: string; clicks: number; impressions: number; positionWeight: number };
export type QueryPosition = { query: string; position: number; impressions: number };

/** Daily Search Console totals as ledger points; rows for the same day (one per country) are summed. */
export function searchDayPoints(rows: SearchDay[], prefix = "", suffix = ""): MetricPoint[] {
  const days = new Map<string, SearchDay>();
  for (const row of rows) {
    const day = days.get(row.day) ?? { day: row.day, clicks: 0, impressions: 0, positionWeight: 0 };
    day.clicks += row.clicks;
    day.impressions += row.impressions;
    day.positionWeight += row.positionWeight;
    days.set(row.day, day);
  }
  return [...days.values()].flatMap((day) => [
    { metric: `${prefix}search_clicks${suffix}`, day: day.day, value: day.clicks },
    { metric: `${prefix}search_impressions${suffix}`, day: day.day, value: day.impressions },
    { metric: `${prefix}search_position_weight${suffix}`, day: day.day, value: day.positionWeight },
  ]);
}

/** One row per query, its position weighted by impressions (for queries fetched per country). */
export function mergePositions(rows: QueryPosition[]): QueryPosition[] {
  const merged = new Map<string, { weight: number; impressions: number }>();
  for (const row of rows) {
    const entry = merged.get(row.query) ?? { weight: 0, impressions: 0 };
    entry.weight += row.position * row.impressions;
    entry.impressions += row.impressions;
    merged.set(row.query, entry);
  }
  return [...merged].map(([query, entry]) => ({ query, position: entry.impressions ? entry.weight / entry.impressions : 0, impressions: entry.impressions }));
}

/** Queries in each top-N bucket now, and how many entered or left it since the previous window. */
export function rankingPoints(current: QueryPosition[], previous: QueryPosition[], day: string, suffix = ""): MetricPoint[] {
  return RANK_BUCKETS.flatMap((top) => {
    const now = new Set(current.filter((row) => row.position <= top).map((row) => row.query));
    const before = new Set(previous.filter((row) => row.position <= top).map((row) => row.query));
    return [
      { metric: `queries_top${top}${suffix}`, day, value: now.size },
      { metric: `queries_top${top}.new${suffix}`, day, value: [...now].filter((query) => !before.has(query)).length },
      { metric: `queries_top${top}.lost${suffix}`, day, value: [...before].filter((query) => !now.has(query)).length },
    ];
  });
}
