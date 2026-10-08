/*
 * Keyed site signals: real-user speed (CrUX History), Lighthouse lab scores
 * (PageSpeed Insights), and an authority estimate (Open PageRank).
 */
import type { MetricPoint } from "@organic-growth/db";
import { googleError } from "./google-search-console.js";

export type FormFactor = "phone" | "desktop";

const CRUX_METRICS = { largest_contentful_paint: "lcp", interaction_to_next_paint: "inp", cumulative_layout_shift: "cls" } as const;
type DateParts = { year: number; month: number; day: number };
const isoDay = (date: DateParts) => `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

/** One point per collection period and metric, on the period's last day; weeks without data ("NaN" or null) are skipped. */
export function cruxHistoryPoints(json: unknown, formFactor: FormFactor): MetricPoint[] {
  const record = (json as { record?: { metrics?: Record<string, { percentilesTimeseries?: { p75s?: unknown[] } }>; collectionPeriods?: Array<{ lastDate: DateParts }> } })?.record;
  const periods = record?.collectionPeriods ?? [];
  return Object.entries(CRUX_METRICS).flatMap(([name, short]) => (record?.metrics?.[name]?.percentilesTimeseries?.p75s ?? []).flatMap((raw, index) => {
    const value = raw === null ? Number.NaN : Number(raw);
    const period = periods[index];
    return Number.isFinite(value) && period ? [{ metric: `crux_${short}_p75.${formFactor}`, day: isoDay(period.lastDate), value }] : [];
  }));
}

/** Weekly real-user speed for an origin; an origin with too few Chrome visits (404) has none. */
export async function fetchCruxHistory(apiKey: string, origin: string, formFactor: FormFactor, periods: number, fetchFn: typeof fetch = fetch): Promise<MetricPoint[]> {
  const response = await fetchFn(`https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, formFactor: formFactor.toUpperCase(), collectionPeriodCount: periods, metrics: Object.keys(CRUX_METRICS) }),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw await googleError(response, "Chrome UX Report request");
  return cruxHistoryPoints(await response.json(), formFactor);
}

/** Lighthouse's performance score for one URL, 0-100. */
export async function fetchLabScore(apiKey: string, url: string, strategy: "mobile" | "desktop", fetchFn: typeof fetch = fetch): Promise<number> {
  const query = new URLSearchParams({ url, strategy, category: "performance", key: apiKey });
  const response = await fetchFn(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${query}`, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw await googleError(response, "PageSpeed Insights request");
  const score = (await response.json() as { lighthouseResult?: { categories?: { performance?: { score?: number } } } }).lighthouseResult?.categories?.performance?.score;
  if (typeof score !== "number") throw new Error("PageSpeed Insights returned no performance score.");
  return Math.round(score * 100);
}

/** The domain Open PageRank scores: the host without `www.` */
export const authorityDomain = (baseUrl: string) => new URL(baseUrl).hostname.replace(/^www\./, "");

/** Open PageRank's 0-10 estimate per domain (up to 100 per request); domains it doesn't know are left out. */
export async function fetchAuthority(apiKey: string, domains: string[], fetchFn: typeof fetch = fetch): Promise<Array<{ domain: string; score: number }>> {
  const query = new URLSearchParams(domains.slice(0, 100).map((domain) => ["domains[]", domain]));
  const response = await fetchFn(`https://openpagerank.keywordseverywhere.com/api/v1.0/getPageRank?${query}`, { headers: { "API-OPR": apiKey } });
  if (!response.ok) throw new Error(`Open PageRank request failed (${response.status}).`);
  const json = await response.json() as { response?: Array<{ status_code: number; domain: string; page_rank_decimal: number }> };
  return (json.response ?? []).filter((row) => row.status_code === 200).map((row) => ({ domain: row.domain, score: Number(row.page_rank_decimal) }));
}
