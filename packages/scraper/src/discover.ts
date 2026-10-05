import type { DataSource } from "@organic-growth/core";
import { collectSitemapUrls, isSameSite } from "@organic-growth/crawler";
import { PoliteFetcher } from "./fetch.js";
import { extractLinks, findNextPage } from "./html.js";
import { compilePathPattern } from "./url-pattern.js";

export type ExpandedSource = {
  /** Detail-page URLs to scrape, already filtered by pattern and robots.txt. */
  urls: string[];
  /** URLs matched but excluded by robots.txt. */
  blocked: number;
  /** Total matching URLs before the source's page budget was applied. */
  matched: number;
  notes: string[];
};

const MAX_LISTING_PAGES = 25;

/**
 * Turns a source definition into the list of pages to extract from:
 * - `page`: the URL itself (e.g. a price table or directory on one page)
 * - `sitemap` / `own_site`: sitemap URLs filtered by `urlPattern`
 * - `listing`: links on a listing page (following `rel=next`) filtered by `urlPattern`
 */
export async function expandSource(
  source: Pick<DataSource, "url" | "kind" | "urlPattern" | "maxPages">,
  fetcher = new PoliteFetcher(),
): Promise<ExpandedSource> {
  const notes: string[] = [];
  const matches = source.urlPattern ? compilePathPattern(source.urlPattern) : () => true;
  let candidates: string[] = [];

  if (source.kind === "page") {
    candidates = [source.url];
  } else if (source.kind === "sitemap" || source.kind === "own_site") {
    const sitemapUrls = await sitemapEntryPoints(source.url, fetcher);
    const errors: string[] = [];
    const origin = new URL(source.url).origin;
    const state = { visited: new Set<string>(), maxFiles: 200 };
    for (const sitemap of sitemapUrls) {
      // Sitemaps are fetched as EumonBot through the polite fetcher's rules.
      const fetchSitemap = async (url: string, init?: { maxBytes?: number }) => fetcher.fetch(url, init?.maxBytes);
      candidates.push(...await collectSitemapUrls(sitemap, fetchSitemap, [], errors, 0, origin, state));
    }
    notes.push(...errors.slice(0, 3));
    candidates = candidates.filter(matches);
  } else {
    let pageUrl: string | null = source.url;
    const seen = new Set<string>();
    for (let page = 0; pageUrl && page < MAX_LISTING_PAGES && candidates.length < source.maxPages * 2; page++) {
      if (seen.has(pageUrl)) break;
      seen.add(pageUrl);
      const response = await fetcher.fetch(pageUrl);
      if (response.status >= 400) {
        notes.push(`${pageUrl} returned HTTP ${response.status}.`);
        break;
      }
      candidates.push(...extractLinks(response.body, response.finalUrl).filter(matches));
      pageUrl = findNextPage(response.body, response.finalUrl);
    }
    if (!source.urlPattern) notes.push("No URL pattern set; every same-site link on the listing was included.");
  }

  const unique = [...new Set(candidates)];
  const allowed: string[] = [];
  let blocked = 0;
  for (const url of unique) {
    if (allowed.length >= source.maxPages) break;
    if (await fetcher.isAllowed(url)) allowed.push(url);
    else blocked++;
  }
  if (unique.length > source.maxPages) {
    notes.push(`${unique.length.toLocaleString()} pages matched; this run is capped at ${source.maxPages.toLocaleString()}.`);
  }
  return { urls: allowed, blocked, matched: unique.length, notes };
}

async function sitemapEntryPoints(url: string, fetcher: PoliteFetcher): Promise<string[]> {
  const parsed = new URL(url);
  if (/\.xml(\.gz)?$/i.test(parsed.pathname)) return [url];
  // A bare domain: use the sitemaps robots.txt declares, then the conventional location.
  const declared = (await fetcher.policy(url)).sitemaps.filter((entry) => isSameSite(entry, parsed.origin));
  return declared.length ? declared : [`${parsed.origin}/sitemap.xml`];
}
