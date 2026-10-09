# Connectors: search results, backlinks, Bing, IndexNow and server logs

**Status:** built on 2026-10-09 after the product review in chat ("can we add 1, 4, 5 and a backlink source").

**Goal:** the growth plan and the dashboard get evidence the Google connections can't give: who actually wins the site's searches and what their results pages hold, how the site's links compare, Bing's numbers, faster discovery of new pages, and what crawlers really request across the whole site.

## Sources

| Source | Auth | Cadence | Writes |
|---|---|---|---|
| DataForSEO Labs `serp_competitors` | DataForSEO login | one call per market, monthly | snapshot `serp_competitors` |
| DataForSEO SERP `google/organic/live/advanced` (with `load_async_ai_overview`) | DataForSEO login | ten pages a sync, each monthly | snapshot `serp`; `serp_ai_overviews`, `serp_ai_cited` |
| DataForSEO Backlinks `summary`, `domain_intersection` | DataForSEO login, Backlinks API active | per domain and gap, monthly | snapshots `backlinks`, `link_gap`; `backlinks`, `ref_domains`, `backlink_rank` (+ `:<domain>`) |
| Bing Webmaster `GetRankAndTrafficStats`, `GetCrawlStats` | `BING_WEBMASTER_API_KEY` | daily, backfill then 14 days | `bing_clicks`, `bing_impressions`, `bing_crawled_pages`, `bing_crawl_errors`, `bing_in_index` |
| IndexNow (`api.indexnow.org`) | key derived from `SESSION_SECRET` | daily, once the proxy is verified | `indexnow_submitted` |
| Server or CDN logs | per-site token derived from `SESSION_SECRET` | pushed by the site | `crawl_log_daily`, `crawl_log_paths` (migration 0022) |

Costs at DataForSEO's October 2026 prices: about $0.004 per results page, $0.01 per competitor list, $0.03 per link profile or gap. A site with two competitors and two markets spends under $0.50 a month (60 results pages, 2 competitor lists, 3 link profiles and a gap).

**Logs** arrive as Cloudflare Logpush (Enterprise), a Vercel log drain (Pro), a forwarding Cloudflare Worker (any plan; the snippet is in Setup), a daily `curl` of an nginx/Apache log, or an upload. Gzip is detected by its magic bytes. Only crawler requests are kept, by user agent (a claim, not verified).

## Where it shows

- **Keywords tab:** Search results pages (features, AI Overview citations, who ranks).
- **Competitors tab:** suggested competitors with an Add button; Backlinks (profiles, referring domains over time, link gap).
- **Search tab:** Bing.
- **Technical tab:** What crawlers request (per crawler, per page type, status mix, query-string share, weekly).
- **Setup:** More sources (status of each, log snippets, upload).
- **Client link:** Bing, search results pages and backlinks; no crawl log and no suggestions.

## Growth plan

- Findings from logs: page types where Googlebot requested under 70% of the sitemap URLs in 30 days (needs 14 days of logs), redirects and errors over 20% of Googlebot's requests, query-string URLs over 25%.
- One `link_gap` opportunity when five or more gap sites exist, weighted 1.5 when the strongest competitor has more referring domains.
- Opportunities naming a search (“…”) get what its results page holds: crowding above the links, AI Overview citations, the top three.
- Without competitors, the constraints and the strategy name the search competitors found. "What I checked" lists the sources used.

## Out of scope

WhatsApp Business, CRMs, and verifying crawler IPs by reverse DNS.
