/*
 * Bing Webmaster Tools (daily clicks, impressions and crawl counts for a
 * verified site) and IndexNow (telling Bing, and the engines that share its
 * submissions, that pages changed). Bing's index also answers Copilot and
 * other assistants built on it.
 */

import { derivedKey } from "@organic-growth/core";

const BING_API = "https://ssl.bing.com/webmaster/api.svc/json";
const INDEXNOW = "https://api.indexnow.org/indexnow";

/** Bing's WCF dates, `/Date(1316156400000-0700)/`, as the calendar day in the zone Bing wrote them in. */
export function bingDay(value: string): string | null {
  const match = /\/Date\((-?\d+)([+-]\d{2})?(\d{2})?\)\//.exec(value);
  if (!match) return null;
  const offset = match[2] ? (Number(match[2]) * 60 + Math.sign(Number(match[2]) || 1) * Number(match[3] ?? 0)) * 60_000 : 0;
  return new Date(Number(match[1]) + offset).toISOString().slice(0, 10);
}

async function bing<T>(apiKey: string, method: string, siteUrl: string, fetchFn: typeof fetch): Promise<T[]> {
  const response = await fetchFn(`${BING_API}/${method}?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    // Bing answers 400 with a message for a site the key's account hasn't verified.
    const said = await response.json().catch(() => null) as { Message?: string } | null;
    throw new Error(`Bing Webmaster ${method}: ${said?.Message ?? `request failed (${response.status})`}.`);
  }
  const json = await response.json() as { d?: T[] | null };
  return json.d ?? [];
}

export type BingTrafficDay = { day: string; clicks: number; impressions: number };

/** Clicks and impressions per day, as far back as Bing keeps them (about six months). */
export async function fetchBingTraffic(apiKey: string, siteUrl: string, fetchFn: typeof fetch = fetch): Promise<BingTrafficDay[]> {
  const rows = await bing<{ Date: string; Clicks?: number; Impressions?: number }>(apiKey, "GetRankAndTrafficStats", siteUrl, fetchFn);
  return rows.flatMap((row) => {
    const day = bingDay(row.Date);
    return day ? [{ day, clicks: row.Clicks ?? 0, impressions: row.Impressions ?? 0 }] : [];
  });
}

export type BingCrawlDay = { day: string; crawledPages: number; crawlErrors: number; inIndex: number };

/** Pages Bingbot crawled, crawl errors, and pages in Bing's index, per day. */
export async function fetchBingCrawlStats(apiKey: string, siteUrl: string, fetchFn: typeof fetch = fetch): Promise<BingCrawlDay[]> {
  const rows = await bing<{ Date: string; CrawledPages?: number; CrawlErrors?: number; InIndex?: number }>(apiKey, "GetCrawlStats", siteUrl, fetchFn);
  return rows.flatMap((row) => {
    const day = bingDay(row.Date);
    return day ? [{ day, crawledPages: row.CrawledPages ?? 0, crawlErrors: row.CrawlErrors ?? 0, inIndex: row.InIndex ?? 0 }] : [];
  });
}

/** A site's IndexNow key: 32 hex characters derived from the server secret, so it needs no storage and never changes while the secret doesn't. */
export const indexNowKey = (secret: string, siteId: string) => derivedKey(secret, `indexnow:${siteId}`);

/** The IndexNow answer: 200 and 202 accepted (202 while the key is being checked); 403 means the key file wasn't found. */
const INDEXNOW_REFUSALS: Record<number, string> = {
  400: "the request was malformed",
  403: "the key file wasn't found at its location",
  422: "the URLs don't belong to the host or the key's location",
  429: "too many submissions",
};

/**
 * Submits up to 10,000 changed URLs on one host. The key file's location
 * bounds which URLs count, so Eumon serves it inside its own mount path and
 * submits only its own pages.
 */
export async function submitIndexNow(input: { host: string; key: string; keyLocation: string; urls: string[] }, fetchFn: typeof fetch = fetch): Promise<{ status: number; submitted: number }> {
  const urls = input.urls.slice(0, 10_000);
  if (!urls.length) return { status: 200, submitted: 0 };
  const response = await fetchFn(INDEXNOW, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: input.host, key: input.key, keyLocation: input.keyLocation, urlList: urls }),
  });
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`IndexNow refused the submission: ${INDEXNOW_REFUSALS[response.status] ?? `status ${response.status}`}.`);
  }
  return { status: response.status, submitted: urls.length };
}
