import type { SearchMetricRow } from "@organic-growth/core";

interface SearchAnalyticsResponse {
  rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
}

export async function listSearchConsoleProperties(accessToken: string): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Search Console properties request failed (${response.status}).`);
  const result = await response.json() as { siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> };
  return result.siteEntry ?? [];
}

/** Imports a bounded, finalized 28-day window, excluding the usual processing lag. */
export async function fetchSearchConsoleMetrics(
  accessToken: string,
  property: string,
  now = new Date(),
): Promise<SearchMetricRow[]> {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const format = (date: Date) => date.toISOString().slice(0, 10);
  const rows: SearchMetricRow[] = [];

  // Bound the retained result so one report stays comfortably below D1 row limits.
  for (let startRow = 0; startRow < 5_000; startRow += 5_000) {
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: format(start),
          endDate: format(end),
          dimensions: ["query", "page", "country", "device"],
          rowLimit: 5_000,
          startRow,
          dataState: "final",
        }),
      },
    );
    if (!response.ok) throw new Error(`Search Console metrics request failed (${response.status}).`);
    const result = await response.json() as SearchAnalyticsResponse;
    const resultRows = result.rows ?? [];
    for (const row of resultRows) {
      rows.push({
        query: row.keys[0] ?? "",
        page: row.keys[1] ?? "",
        country: row.keys[2] ?? "",
        device: row.keys[3] ?? "",
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        periodStart: format(start),
        periodEnd: format(end),
      });
    }
    if (resultRows.length < 5_000) break;
  }
  return rows;
}

type QueryOptions = {
  dimensions: Array<"page" | "query" | "date" | "country" | "device">;
  startDate: string;
  endDate: string;
  /** Restrict to page URLs containing this text (e.g. `https://example.com/guides/`). */
  pageContains?: string;
  maxRows: number;
  dataState?: "final" | "all";
};

/** Pages through searchAnalytics.query up to `maxRows`. */
async function querySearchAnalytics(accessToken: string, property: string, options: QueryOptions) {
  const rows: NonNullable<SearchAnalyticsResponse["rows"]> = [];
  const pageSize = Math.min(25_000, options.maxRows);
  for (let startRow = 0; startRow < options.maxRows; startRow += pageSize) {
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: options.startDate,
          endDate: options.endDate,
          dimensions: options.dimensions,
          rowLimit: pageSize,
          startRow,
          dataState: options.dataState ?? "final",
          ...(options.pageContains
            ? { dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: options.pageContains }] }] }
            : {}),
        }),
      },
    );
    if (!response.ok) throw new Error(`Search Console metrics request failed (${response.status}).`);
    const batch = ((await response.json()) as SearchAnalyticsResponse).rows ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

export type PageSearchRows = {
  periodStart: string;
  periodEnd: string;
  /** Page × query totals for the window. */
  queries: Array<{ pageUrl: string; query: string; clicks: number; impressions: number; ctr: number; position: number }>;
  /** Page × day totals, for before/after measurement of page changes. */
  daily: Array<{ pageUrl: string; day: string; clicks: number; impressions: number; position: number }>;
};

/**
 * Imports the last 28 days of Search Console data for generated pages only.
 * Includes fresh (provisional) days, which later syncs overwrite.
 */
export async function fetchGeneratedPageSearchMetrics(
  accessToken: string,
  property: string,
  pagePrefix: string,
  now = new Date(),
): Promise<PageSearchRows> {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const format = (date: Date) => date.toISOString().slice(0, 10);
  const base = { startDate: format(start), endDate: format(end), pageContains: pagePrefix, dataState: "all" as const };
  const [queryRows, dailyRows] = await Promise.all([
    querySearchAnalytics(accessToken, property, { ...base, dimensions: ["page", "query"], maxRows: 50_000 }),
    querySearchAnalytics(accessToken, property, { ...base, dimensions: ["page", "date"], maxRows: 50_000 }),
  ]);
  return {
    periodStart: base.startDate,
    periodEnd: base.endDate,
    queries: queryRows.map((row) => ({
      pageUrl: row.keys[0] ?? "", query: row.keys[1] ?? "", clicks: row.clicks,
      impressions: row.impressions, ctr: row.ctr, position: row.position,
    })),
    daily: dailyRows.map((row) => ({
      pageUrl: row.keys[0] ?? "", day: row.keys[1] ?? "", clicks: row.clicks,
      impressions: row.impressions, position: row.position,
    })),
  };
}
