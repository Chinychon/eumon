# Performance: speed, authority, and Google's view of the site (sub-project B)

**Status:** design approved in chat on 2026-10-08; this spec awaits review.

**Goal:** the Performance page (formerly Results) answers "Is the site fast and trusted?" with real-user speed, Lighthouse lab scores, and an authority estimate against competitors. The Overview's Search tab shows how much of the site Google has crawled and indexed.

**Success:** for any site, the operator and the client link show:
- speed for real Chrome visitors on phones and desktops, with Google's thresholds and a weekly trend;
- the site's authority beside each competitor's.

The operator sees, page type by page type, how many sitemap URLs Google has indexed, crawled without indexing, or not crawled yet. Every number traces to its API. When data is missing, the page says why and never shows an estimate in its place.

**Out of scope:**
- Google Business Profile (sub-project D, waiting for API approval).
- Keyword volume and competitor keywords (sub-project C, DataForSEO).
- Per-URL real-user speed: CrUX rarely has URL-level data for SMB pages.
- Authority from paid tools.

## Sources and quotas

| Source | Auth | Limit | Used for |
|---|---|---|---|
| CrUX History API `records:queryHistoryRecord` | `GOOGLE_API_KEY` | 150/min per project (shared with CrUX) | Weekly p75 LCP, INP, CLS for the site's origin, `PHONE` and `DESKTOP`, up to 40 weeks back |
| PageSpeed Insights v5 `runPagespeed` | `GOOGLE_API_KEY` | Generous; 4 calls a week per site | Lighthouse performance score, mobile and desktop |
| Open PageRank `openpagerank.keywordseverywhere.com/api/v1.0/getPageRank` (moved from openpagerank.com) | `OPEN_PAGERANK_KEY` (`API-OPR` header) | 1,000 requests/day; 100 domains per request | 0–10 authority for the site and its competitors; source data updates about monthly |
| URL Inspection API | Google OAuth (Search Console) | 2,000/day and 600/min per property | Index status of sitemap URLs |

The Sitemaps API's `indexed` count has been empty since 2019, and the Page indexing report has no API. Inspecting URLs one by one is the only source.

`GOOGLE_API_KEY` and `OPEN_PAGERANK_KEY` are new Worker secrets: add them to `cloudflare.config.ts` and `.dev.vars.example`.

## 1. Real-user speed (CrUX)

- **Query:** the site's origin (`new URL(site.baseUrl).origin`), for both `PHONE` and `DESKTOP`. Metrics: `largest_contentful_paint`, `interaction_to_next_paint`, `cumulative_layout_shift`.
- **When:**
  - First run: `collectionPeriodCount: 40` as a backfill.
  - After that: `collectionPeriodCount: 2` on Mondays (the API updates Mondays around 04:00 UTC), or whenever no `sync.crux` marker exists.
- **Stored in `metric_points`:**
  - One point per collection period, on the period's `lastDate`, as snapshot metrics `crux_lcp_p75.phone`, `crux_inp_p75.phone`, `crux_cls_p75.phone`, and the `.desktop` equivalents.
  - LCP and INP in milliseconds; CLS as the decimal value.
  - A `sync.crux` marker on the sync day.
  - Upserts overwrite, as Search Console's revised days do.
- **Not enough traffic:** a 404 (`NOT_FOUND`) means Chrome has too few visits for that form factor. No points are written, only the marker. The view then says "Not enough Chrome visits on phones for Google to report real-user speed."
- **Ratings** use Google's thresholds, kept in `@organic-growth/core`:

  | Metric | Good | Needs work | Poor |
  |---|---|---|---|
  | LCP | ≤ 2,500 ms | ≤ 4,000 ms | above 4,000 ms |
  | INP | ≤ 200 ms | ≤ 500 ms | above 500 ms |
  | CLS | ≤ 0.1 | ≤ 0.25 | above 0.25 |

## 2. Lab scores (PageSpeed Insights)

- **When:** weekly, on Mondays or whenever no `lab_score_home.phone` exists. Strategies `mobile` and `desktop`, category `performance`.
- **Pages:**
  - the site's homepage;
  - one published Eumon page: the one with the most Google clicks over the last 28 days, or else the earliest published.
- **Stored:** `lab_score_home.phone`, `lab_score_home.desktop`, `lab_score_eumon.phone`, `lab_score_eumon.desktop` (0–100) on the sync day.
- **Timing and failures:** the four calls run in parallel with a 90 s timeout each. A failed call writes nothing and adds a sync note.

## 3. Authority (Open PageRank)

- **When:** weekly, on Mondays or whenever no `authority` point exists. One request covers the site's domain and its competitor domains (`listSiteCompetitorDomains`, up to 100).
- **Stored:**
  - `authority` for the site;
  - `authority:<domain>` for each competitor (`page_rank_decimal`, 0–10), on the sync day.
  - A domain the API doesn't know (non-200 `status_code` in its row) writes nothing.
- **View:** competitors shown are the site's current competitor list. Older `authority:<domain>` series stay in the ledger unshown.

## 4. Google's view of the site (URL Inspection of sitemap URLs)

- **Source pages:** served pages (`crawl_state = 'complete'`, `status < 400`) in the site's latest completed analysis, with their page type (`routeFamily`).
- **New table `url_index_status`** (migration `0015`):
  ```sql
  url_index_status (
    site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
    url TEXT,
    family TEXT,
    verdict TEXT,
    coverage_state TEXT,
    last_crawl_time TEXT,
    checked_at TEXT,
    PRIMARY KEY (site_id, url)
  )
  ```
  Plus an index on `(site_id, checked_at)`.
- **Budget:**
  - Up to 1,800 inspections a day per site. With the existing 100 for Eumon pages, that stays under the 2,000 limit.
  - 10 at a time, at most 500 a minute.
  - This runs only in the daily `SearchSyncWorkflow`, in its own steps of 200 URLs each, so a long run can retry part-way.
  - "Sync now" runs one step of 200, so the button answers in seconds and still shows movement.
  - A 401, 403 or 429 stops the day's run, as it does for Eumon pages.
- **Order:**
  1. URLs never checked come first, taken round-robin across page types, so every type has a sample within the first day.
  2. Then URLs whose last check is older than 30 days, oldest first.

  On medbaycare (22,913 URLs) a full first pass takes about 13 days.
- **Classification** (in `@organic-growth/core`, from `verdict` and `coverageState`):
  - **Indexed:** verdict `PASS`.
  - **Crawled, not indexed:** "Crawled - currently not indexed".
  - **Discovered, not crawled:** "Discovered - currently not indexed".
  - **Unknown to Google:** "URL is unknown to Google".
  - **Excluded:** every other state, such as noindex, redirects, a different canonical, or a soft 404. The state is kept for the tooltip.
- **Overview → Search tab, new card "Has Google crawled your pages?":**
  - A progress line: "Checked 1,800 of 22,913 sitemap URLs with Google. About 12 days until every URL is checked once."
  - One stacked bar for every checked URL (Indexed, Crawled not indexed, Discovered not crawled, Unknown, Excluded), with counts and shares "of checked URLs".
  - One row per page type with the same stacked bar and "N checked of M".
  - "Last crawled by Google": the share of checked URLs Google crawled in the last 30 days, from `last_crawl_time`.
  - Without Search Console, it shows the existing connect prompt.
  - The card refreshes with the report; no polling.

## 5. Performance page section "Is the site fast and trusted?"

It sits after "Is it bringing enquiries?" and before site health. It's on the operator view and the client link; the client link gets no property IDs, as now.

- **Speed:** three tiles in a `ruled-grid c3`: "Loading" (LCP), "Responding to taps" (INP), "Staying still while loading" (CLS). Each tile shows:
  - the Phone and Desktop p75 values, each with a Good / Needs work / Poor badge (green, amber, red);
  - a weekly line chart with two series, phone and desktop, over the stored periods.
- **Lab scores:** a KPI row, "Lighthouse score, phone" and "Lighthouse score, desktop". Each shows the Eumon page and the homepage side by side, like "96 Eumon page · 41 homepage". It's hidden until a page is published; before that, only the homepage shows.
- **Authority:**
  - a bar list of the site and each current competitor (latest value, one decimal);
  - a line of the site's own `authority` over time, once there are 2 or more points;
  - caption: "Open PageRank: a free 0–10 estimate from public link data, updated about monthly. Not Google's own measure."
- **Missing states:**
  - no `GOOGLE_API_KEY`: operator sees "Add a Google API key in .dev.vars / Worker secrets"; the client sees "Not measured yet";
  - no CrUX data: the not-enough-visits sentence, per form factor;
  - no `OPEN_PAGERANK_KEY`: the same pattern as the Google API key.

The view model is `resultsView` in core, which gains `speed`, `lab`, and `authority`. The Search tab card reads a new `GET /api/sites/:id/index-coverage`.

## 6. Sync wiring and errors

- `syncResults(db, site, now, google, keys)` gains `keys: { googleApiKey?: string; openPageRankKey?: string }`.
  - The speed, lab and authority steps run before and independently of the Google OAuth connect, so they work without Search Console.
  - URL inspection of sitemap URLs runs inside `syncSearch` after the Eumon-page inspections, sharing the stop-on-refusal rule.
- Each step catches its own failure and adds a note: `speed: 40 weeks`, `speed failed: …`, `lab: 4 scores`, `authority: 3 domains`, `coverage: inspected 200`.
- The `SearchSyncWorkflow` and the "Sync now" route pass the keys from `env`.

## 7. Testing

- **Core:** speed ratings at the threshold edges; coverage classification for each state; `resultsView` gains `speed`, `lab`, `authority`.
- **Agents:** parsers from recorded API JSON:
  - `cruxHistoryPoints` (periods to points; a 404 gives no points);
  - `labScore` (Lighthouse `categories.performance.score × 100`);
  - `authorityPoints` (rows with errors skipped).
- **DB:**
  - `url_index_status` queue order: round-robin across types for never-checked URLs, then the oldest past 30 days;
  - coverage counts per type;
  - migration 0015 applies on SQLite.
- **Web:**
  - a sync with a fake fetch writes speed, lab and authority points;
  - it backfills 40 weeks only once;
  - a missing key adds a note without failing the sync;
  - coverage inspection stops on 429.
- **UI:** captured on the demo site in light, dark and 390px wide. The demo seeds fictional speed, lab, authority and coverage data, labelled as demo data like the rest.

## Phases

One plan, in this order:
1. speed;
2. lab;
3. authority;
4. the Performance section;
5. crawl coverage, with its migration, workflow steps and Search-tab card;
6. the demo seed.

Each phase ships on its own with tests.
