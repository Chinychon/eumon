import { RANK_BUCKETS, type TopQuery } from "@organic-growth/core";
import type { MetricPoint } from "@organic-growth/db";
import { isQuestionQuery } from "./search.js";

export type SearchDay = { day: string; clicks: number; impressions: number; positionWeight: number };
export type QueryPosition = { query: string; position: number; impressions: number; clicks: number };

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
  const merged = new Map<string, { weight: number; impressions: number; clicks: number }>();
  for (const row of rows) {
    const entry = merged.get(row.query) ?? { weight: 0, impressions: 0, clicks: 0 };
    entry.weight += row.position * row.impressions;
    entry.impressions += row.impressions;
    entry.clicks += row.clicks;
    merged.set(row.query, entry);
  }
  return [...merged].map(([query, entry]) => ({ query, position: entry.impressions ? entry.weight / entry.impressions : 0, impressions: entry.impressions, clicks: entry.clicks }));
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

/** The queries with the most clicks (then impressions), each beside the same query in the previous window. */
export function topQueries(current: QueryPosition[], previous: QueryPosition[], limit = 25): TopQuery[] {
  const before = new Map(previous.map((row) => [row.query, row]));
  return [...current]
    .filter((row) => row.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.query.localeCompare(b.query))
    .slice(0, limit)
    .map((row) => {
      const was = before.get(row.query);
      return {
        query: row.query, clicks: row.clicks, impressions: row.impressions, position: row.position,
        before: was ? { clicks: was.clicks, impressions: was.impressions, position: was.position } : null,
      };
    });
}

/** Question searches in a query list (a 28-day window), as a snapshot on the window's last day: how many, and their clicks and impressions. */
export function questionPoints(rows: QueryPosition[], day: string): MetricPoint[] {
  const questions = rows.filter((row) => isQuestionQuery(row.query));
  return [
    { metric: "question_queries", day, value: questions.length },
    { metric: "question_clicks", day, value: questions.reduce((total, row) => total + row.clicks, 0) },
    { metric: "question_impressions", day, value: questions.reduce((total, row) => total + row.impressions, 0) },
  ];
}
