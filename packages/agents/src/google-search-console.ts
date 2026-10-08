import type { SearchMetricRow } from "@organic-growth/core";
import type { QueryPosition, SearchDay } from "./results-points.js";

/** A failed Google API call, carrying the HTTP status and Google's own explanation (e.g. "… API has not been used in project …"). */
export async function googleError(response: Response, what: string): Promise<Error & { status: number }> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  const reason = body?.error?.message;
  return Object.assign(new Error(`${what} failed (${response.status})${reason ? `: ${reason}` : "."}`), { status: response.status });
}

interface SearchAnalyticsResponse {
  rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
}

export async function listSearchConsoleProperties(accessToken: string): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw await googleError(response, "Search Console properties request");
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
    if (!response.ok) throw await googleError(response, "Search Console metrics request");
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
  /** Restrict to one country (Search Console's lowercase ISO 3166-1 alpha-3 code). */
  country?: string;
  maxRows: number;
  dataState?: "final" | "all";
};

/** Pages through searchAnalytics.query up to `maxRows`. */
async function querySearchAnalytics(accessToken: string, property: string, options: QueryOptions, fetchFn: typeof fetch = fetch) {
  const rows: NonNullable<SearchAnalyticsResponse["rows"]> = [];
  const pageSize = Math.min(25_000, options.maxRows);
  const filters = [
    ...(options.pageContains ? [{ dimension: "page", operator: "contains", expression: options.pageContains }] : []),
    ...(options.country ? [{ dimension: "country", operator: "equals", expression: options.country }] : []),
  ];
  for (let startRow = 0; startRow < options.maxRows; startRow += pageSize) {
    const response = await fetchFn(
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
          ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}),
        }),
      },
    );
    if (!response.ok) throw await googleError(response, "Search Console metrics request");
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

/** Daily clicks, impressions, and position × impressions; fresh days included (later syncs overwrite them). */
export async function fetchSearchDaily(
  accessToken: string, property: string,
  options: { startDate: string; endDate: string; pageContains?: string; country?: string },
  fetchFn: typeof fetch = fetch,
): Promise<SearchDay[]> {
  const rows = await querySearchAnalytics(accessToken, property, { ...options, dimensions: ["date"], maxRows: 1_000, dataState: "all" }, fetchFn);
  return rows.map((row) => ({ day: row.keys[0] ?? "", clicks: row.clicks, impressions: row.impressions, positionWeight: row.position * row.impressions }));
}

/** Each query's average position and impressions over a finalized window. */
export async function fetchQueryPositions(
  accessToken: string, property: string,
  options: { startDate: string; endDate: string; country?: string },
  fetchFn: typeof fetch = fetch,
): Promise<QueryPosition[]> {
  const rows = await querySearchAnalytics(accessToken, property, { ...options, dimensions: ["query"], maxRows: 25_000 }, fetchFn);
  return rows.map((row) => ({ query: row.keys[0] ?? "", position: row.position, impressions: row.impressions }));
}

export type IndexInspection = { verdict: string; coverageState: string | null; lastCrawlTime: string | null };

export function inspectionResult(json: unknown): IndexInspection {
  const status = (json as { inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string } } })?.inspectionResult?.indexStatusResult;
  return { verdict: status?.verdict ?? "VERDICT_UNSPECIFIED", coverageState: status?.coverageState ?? null, lastCrawlTime: status?.lastCrawlTime ?? null };
}

/** Google's index status for one URL of a Search Console property (2,000 inspections a day per property). */
export async function inspectUrl(accessToken: string, property: string, url: string, fetchFn: typeof fetch = fetch): Promise<IndexInspection> {
  const response = await fetchFn("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: property }),
  });
  if (!response.ok) throw await googleError(response, "URL Inspection request");
  return inspectionResult(await response.json());
}
