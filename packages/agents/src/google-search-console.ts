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
      });
    }
    if (resultRows.length < 5_000) break;
  }
  return rows;
}
