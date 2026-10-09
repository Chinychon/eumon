# Performance: keywords and competitor keywords (sub-project C)

**Status:** design approved in chat on 2026-10-09; this spec awaits review.

**Goal:** the Performance page shows what the site's searches are worth (monthly searches, difficulty), which searches competitors win that the site doesn't, and each domain's share of visibility. The same data gives the growth plan real demand figures instead of heuristics.

**Success:** for a site with target markets and competitors, the operator and the client link show:
- the site's top keywords with monthly searches and difficulty beside their Search Console position;
- keyword gaps: searches a competitor ranks for and the site doesn't, by volume, with who ranks and where;
- share of visibility across the site and its competitors.

The growth plan's striking-distance and snippet opportunities carry real volume and difficulty, and the biggest gaps appear as opportunities of their own. Every figure names its source and date; nothing is estimated when data is missing.

**What the probes showed (2026-10-09):** DataForSEO knows medbaycare.com for 20 keywords (none in the top 15) but opsimedis.id for 343 in Indonesia (110 in the top 10). So Search Console stays the source for the site's own positions; DataForSEO adds volume, difficulty, intent, and everything about competitors.

**Out of scope:**
- Generating the queries Eumon's future landing pages would target (entity × place) and pricing them. Later; the gap list covers the first need.
- Automatic competitor discovery.
- A weekly rank tracker.
- Keyword data for sites without target markets: DataForSEO is per country, so the card asks for markets first.

## Sources and quotas

| Source | Auth | Limit | Used for |
|---|---|---|---|
| DataForSEO Labs `google/ranked_keywords/live` | Basic auth, `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | 1,000 rows per call; one task per request; $0.012 + $0.00012 per row | Each domain's keywords in a market: volume, difficulty, intent, position, URL, estimated traffic |
| DataForSEO Labs `google/keyword_overview/live` | same | 700 keywords per call; location and language required; $0.012 + $0.00012 per keyword | Volume, difficulty, intent for the site's own Search Console queries |
| Search Console `searchAnalytics/query` | Google OAuth | existing | The queries to enrich (last 28 days, per market) |

- **Location:** `location_name` = `countryName(market)` from `packages/core/src/countries.ts`; DataForSEO uses the same English names for every market listed there. An unknown name fails that market with a note.
- **Language:** `ranked_keywords` runs without a language (every language in the country). `keyword_overview` uses the site's page language (`page_settings.language`, e.g. `id`, `ms`, `en`).
- **Cost per sync:** (competitors + 1) × markets × at most $0.132, plus markets × at most $0.096. Medbay (2 competitors, 1 market): about $0.25. Monthly.
- `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` are new Worker secrets: add them to `cloudflare.config.ts` and `.dev.vars.example`. `SignalKeys` gains `dataForSeo?: { login: string; password: string }`.

## 1. Snapshot store

The second "latest list" generalises the first (`CONTEXT.md`, *Snapshot*).

- Migration `0016_site_snapshots.sql`: `site_snapshots (site_id, kind, scope, period_end, rows_json, updated_at, PRIMARY KEY (site_id, kind, scope))`. It copies `search_top_queries` in as kind `top_queries` with scope `<property>|<markets>` and drops the old table.
- `saveSnapshot(db, siteId, { kind, scope, periodEnd, rows })`, `getSnapshot(db, siteId, kind, scope)`, `listSnapshots(db, siteId, kind)`. `saveTopQueriesSnapshot` and `getTopQueriesSnapshot` become calls on these.
- Scope keys carry what makes a list stale, so stale lists are never read: a competitor removed, a market changed, a property switched.

## 2. Sources

Two sources join `results-sources.ts`. The runner gains a **monthly** cadence: run when the marker is absent or its latest day is 28 or more days old (`lastMetricDay` in `packages/db/src/metrics.ts`). "Sync now" runs them only when due; there is no forced refresh.

### Competitor keywords (`competitor keywords`, monthly, marker `sync.competitor_keywords`)

- **Applies** with DataForSEO credentials. **Skips** with a note when the site has no target markets ("competitor keywords: set target markets in Setup").
- For each market and each domain (the site's own domain first, then every competitor): `ranked_keywords` with `limit: 1000`, ordered by volume. Rows kept: `keyword, volume, difficulty, intent, position, url, traffic` (`etv`).
- Snapshot kind `competitor_keywords`, scope `<domain>|<market>`, `periodEnd` = sync day.
- Ledger, summed over markets: `kw_top10` and `kw_traffic` for the site; `kw_top10:<domain>` and `kw_traffic:<domain>` for each competitor (like `authority:<domain>`).
- One domain failing (unknown to DataForSEO, a bad location name) is noted and the others continue; the marker is written when at least one domain succeeded.

### Keyword volumes (`keyword volumes`, monthly, marker `sync.keyword_volumes`, needs Google)

- **Applies** with DataForSEO credentials and a Search Console property. **Skips** without target markets, as above.
- For each market: the site's queries over the last 28 finalized days in that country (`fetchQueryPositions`), top 700 by impressions, to `keyword_overview` in the page language. Rows kept: `keyword, volume, difficulty, intent, position, clicks, impressions`.
- Snapshot kind `keywords`, scope `<property>|<market>`.
- No ledger points: the view reads the list.

## 3. Performance card "Keywords"

Subtitle: "Searches per month and difficulty from DataForSEO, updated monthly. Positions from Search Console." Three parts, each with the data's date.

1. **Your top keywords:** a table of the 25 enriched queries with the most clicks, across markets: keyword, searches/month, difficulty, position, clicks. The intent shows as a small badge.
2. **Keyword gaps:** the 25 competitor keywords with the most searches that the site does not appear for in any list (neither enriched nor its own `ranked_keywords`): keyword, searches/month, difficulty, who ranks (domain and position, linking the URL). Difficulty colours: ≤ 30 green, ≤ 60 amber, else red.
3. **Share of visibility:** a bar list of estimated monthly visits from search for the site and each competitor (`kw_traffic`, `kw_traffic:<domain>`), with each share as a percentage, and the site's `kw_top10` beside its Search Console top-10 count so the two indexes aren't confused.

Empty states: no credentials ("Add DataForSEO credentials to price keywords and see competitor gaps", operator only; "Not measured yet" on the client link); no markets ("Set target markets in Setup", operator only); synced but nothing found ("DataForSEO has no keywords for these domains in <markets>").

`ResultsView` gains `keywords: { asOf: string | null; top: Row[]; gaps: Gap[]; visibility: Array<{ domain: string; traffic: number | null; top10: number | null }> }`; `ResultsInput` gains the snapshot lists; `resultsPayload.site.signals.keywords` says whether credentials are set. This is the first new card, so the Performance render splits by card (`CONTEXT.md` deferred item): `ResultsView.tsx` keeps the header, key numbers and card order; each card takes its slice.

## 4. Growth plan

- `KeywordDemand = { lookup(query): { volume, difficulty, intent } | null }`, built from the `keywords` snapshots (highest volume across markets). The analysis workflow loads it into `AnalysisBundle.demand` before `buildOpportunities`.
- `estimateDemand` takes the lookup: `ranking` and `snippet` inputs carry their `query`; a hit returns `searchDemand` = volume and `estimatedDifficulty` = DataForSEO's difficulty, and the builder's rationale says "2,400 searches a month, difficulty 16". A miss keeps today's heuristic.
- **Gap opportunities:** the six biggest gaps with volume ≥ 100, difficulty ≤ 40, commercial and transactional intent first. Intent `keyword_gap`; title "Rank for “dj stent di penang”: 5,400 searches a month; opsimedis.id ranks 15"; `potentialPage` = the competitor's URL; `priorityScore` = log10(volume + 1) × 12 × (1 − difficulty / 100) × (1.5 for commercial or transactional, else 1), comparable with content gaps. `synthesizeGrowthPlan` gets copy for the intent: build a landing page that answers the search, study the competitor's page for the facts searchers expect.

## 5. Demo site

`seedDemoResults` writes two competitor keyword snapshots, one enriched keyword list, and the `kw_*` points, so the card shows a full example without credentials.

## 6. Testing

- DataForSEO client: parsing from fixtures captured on 2026-10-09 (a domain with rows, a domain with none, an error task); one task per request; cost read from the response.
- Sources through `syncResults` with a fake fetch: credentials missing is a note, not a failure; no markets is a note; a run writes snapshots and ledger points; the monthly cadence runs once, not again ten days later, again after 28; one failing domain doesn't stop the others; the metric guard test still passes with the `kw_*` group declared.
- Snapshot store: save, get by scope, list by kind, the top-queries migration keeps existing rows.
- View model: gaps exclude keywords in either of the site's lists; visibility shares sum to 100; empty states per missing input.
- Growth plan: a hit replaces the heuristic and the rationale says so; gap opportunities are ranked by the formula; the demo test covers the card's data.

## Phases

One plan. Order: store, client, sources, view model and card, growth plan, demo.
