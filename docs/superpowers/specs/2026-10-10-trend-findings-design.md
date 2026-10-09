# Trend findings: when a number falls, say so and say why

**Status:** sub-project B of "match the MedBay report" (2026-10-09); built straight through at the user's request.

**Goal:** Eumon already stores the daily series the MedBay report reasoned from — Search Console impressions, Google's indexed count (from the Search Console import, or the URL inspection sample), and Googlebot's requests from the server logs. It draws them, but says nothing when they move. Three findings make the movement a reported problem with a date, a size and a cause where one is visible, so the growth plan ranks it and History records when it recovers.

**Out of scope:** forecasting; alerts by email; per-page or per-query drops (the Search tab's query lists cover those); any new table or sync.

## 1. The three findings

Computed at analysis time from the ledger and the crawl log (`findingsFromTrends`, fed through the connector signals like the Search Console import), category `search` for the first and `indexing` for the other two:

1. **"Search impressions fell N% since ⟨day⟩"** — the last 7 complete days' average against the highest trailing-7-day average whose window ended at least 7 days earlier, over the last 120 days; fires when the current average is at most 60% of the peak and the peak averaged at least 100 impressions a day. Summary: the two averages and the dates; when the indexed-count series fell by 10% or more within 7 days of the peak, one more sentence: "That is when Google's indexed count fell from A to B." Recommendation: open the Page indexing report (or import it), check what changed on the site around that day, and watch the number here; History records the recovery.
2. **"Google's indexed count fell from A to B since ⟨day⟩"** — the series is `gsc_indexed` when the chart was imported, else `pages_indexed` from the inspection sample; fires when the latest value is at least 10% and 50 pages under the series' 90-day maximum. Recommendation: the Search Console import names the reasons; the crawl's noindex/redirect/error counts are cited.
3. **"At Googlebot's pace the sitemap takes N days to crawl once"** — sitemap URLs (the analysis's own `sitemap.totalUrls`) divided by Googlebot's requests per day in the last 28 days of logs (needs 14 days of logs); fires when that is more than 60 days and the sitemap has at least 200 URLs. Summary: the arithmetic, and the Search Console import's "discovered, not indexed" count when there is one. Recommendation: fewer URLs in the sitemap (keep pages with real content), link the important ones from pages Googlebot already visits, and read the crawl-log card for where its requests go.

Thresholds are constants in one place with their reasons beside them.

## 2. Where the numbers come from

- `packages/core/src/trends.ts` (pure): `latestAverage`, `peakAverage`, `dropFromPeak`, `googlebotPace` over `{ day, value }` points and crawl-log day rows.
- `packages/agents/src/trend-signals.ts`: `loadTrendSignals(db, siteId, crawlLog, today)` reads 120 days of `search_impressions`, `gsc_indexed` and `pages_indexed` from the ledger and returns `TrendSignals = { impressions, indexed, indexedSource, crawlLog, today }`. The analysis workflow and the demo both call it (agents has the database; the web app imports it).
- `ConnectorSignals.trends`; the pipeline calls `findingsFromTrends` with the sitemap size and the import's discovered count.

## 3. Demo

The demo seeds 30 days of Googlebot requests (about 25 a day, 300 distinct paths) so the crawl-pace finding fires on its 1,700-URL sitemap and the Crawl log card has data. Its impressions and indexed counts rise, so the two drop findings stay quiet there, as they should.

## 4. Testing

- core: each helper on synthetic series — the peak window must end a week before the latest day; a peak under the level is null; a drop under the share or count is null; the pace is null under 14 days of logs and ends yesterday.
- agents: the three findings' thresholds and titles; the indexed-fall sentence appears only when the dates coincide; stable series give nothing; `loadTrendSignals` reads the ledger (SQLite).
- demo: the latest demo analysis carries the crawl-pace finding.
