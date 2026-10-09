/*
 * DataForSEO Labs (Google): a domain's ranked keywords in a country, and
 * volume, difficulty and intent for a list of keywords. Paid per request and
 * per row; the account allows one task per request.
 */
import type { RankedKeyword } from "@organic-growth/core";

export type DataForSeoAuth = { login: string; password: string };

/** DataForSEO's Google location for a country: 2000 + its ISO 3166-1 numeric code. */
export const dataForSeoLocation = (numeric: number) => 2000 + numeric;

type Task<T> = { status_code: number; status_message: string; result: T[] | null };
type Envelope<T> = { status_code: number; status_message: string; tasks: Array<Task<T>> | null };

/** Posts one task and returns its first result (undefined when the task has none). */
async function labs<T>(auth: DataForSeoAuth, endpoint: string, task: object, fetchFn: typeof fetch): Promise<T | undefined> {
  const response = await fetchFn(`https://api.dataforseo.com/v3/dataforseo_labs/google/${endpoint}/live`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${auth.login}:${auth.password}`)}`, "Content-Type": "application/json" },
    body: JSON.stringify([task]),
  });
  if (!response.ok) throw new Error(`DataForSEO ${endpoint} request failed (${response.status}).`);
  const json = await response.json() as Envelope<T>;
  const first = json.tasks?.[0];
  if (!first) throw new Error(`DataForSEO: ${json.status_message} (${json.status_code}).`);
  if (first.status_code !== 20000) throw new Error(`DataForSEO ${endpoint}: ${first.status_message} (${first.status_code}).`);
  return first.result?.[0];
}

type RankedItem = {
  keyword_data: { keyword: string; keyword_info?: { search_volume?: number | null } | null; keyword_properties?: { keyword_difficulty?: number | null } | null; search_intent_info?: { main_intent?: string | null } | null };
  ranked_serp_element: { serp_item: { rank_group: number; relative_url?: string | null; etv?: number | null } };
};

/** Rows of a `ranked_keywords` result; a domain DataForSEO doesn't know has none. */
export function rankedKeywordRows(result: unknown): RankedKeyword[] {
  const items = (result as { items?: RankedItem[] | null } | undefined)?.items ?? [];
  return items.map((item) => ({
    keyword: item.keyword_data.keyword,
    volume: item.keyword_data.keyword_info?.search_volume ?? null,
    difficulty: item.keyword_data.keyword_properties?.keyword_difficulty ?? null,
    intent: item.keyword_data.search_intent_info?.main_intent ?? null,
    position: item.ranked_serp_element.serp_item.rank_group,
    url: item.ranked_serp_element.serp_item.relative_url ?? "/",
    traffic: item.ranked_serp_element.serp_item.etv ?? 0,
  }));
}

/** A domain's keywords in a country, every language, highest volume first; at most 1,000. */
export async function fetchRankedKeywords(auth: DataForSeoAuth, domain: string, location: number, fetchFn: typeof fetch = fetch): Promise<RankedKeyword[]> {
  return rankedKeywordRows(await labs(auth, "ranked_keywords", { target: domain, location_code: location, limit: 1000, order_by: ["keyword_data.keyword_info.search_volume,desc"] }, fetchFn));
}

type OverviewItem = { keyword: string; keyword_info?: { search_volume?: number | null } | null; keyword_properties?: { keyword_difficulty?: number | null } | null; search_intent_info?: { main_intent?: string | null } | null };
export type KeywordPrice = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null };

export function keywordOverviewRows(result: unknown): KeywordPrice[] {
  const items = (result as { items?: OverviewItem[] | null } | undefined)?.items ?? [];
  return items.map((item) => ({
    keyword: item.keyword,
    volume: item.keyword_info?.search_volume ?? null,
    difficulty: item.keyword_properties?.keyword_difficulty ?? null,
    intent: item.search_intent_info?.main_intent ?? null,
  }));
}

/** Volume, difficulty and intent for up to 700 keywords in a country and language. Keywords DataForSEO doesn't know are left out, and not charged. */
export async function fetchKeywordOverview(auth: DataForSeoAuth, keywords: string[], location: number, language: string, fetchFn: typeof fetch = fetch): Promise<KeywordPrice[]> {
  return keywordOverviewRows(await labs(auth, "keyword_overview", { keywords: keywords.slice(0, 700), location_code: location, language_code: language }, fetchFn));
}
