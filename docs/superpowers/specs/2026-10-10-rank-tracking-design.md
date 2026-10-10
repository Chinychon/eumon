# Rank tracking: the searches you care about, checked every day

**Status:** sub-project 1 of the competitor-features program (2026-10-10); built straight through at the user's request.

**Goal:** Search Console gives an average position over 28 days; Semrush and Ahrefs give an exact position per keyword per day, by country, with the landing page and the result types on the page. Eumon already fetches Google's first page for its biggest priced queries (the `serp` snapshot, ten pages a sync, each refreshed monthly). Rank tracking lets the operator name the searches that matter, checks each one every day in every target market, keeps the history, and turns a fall into a finding the growth plan ranks and History records.

**Success:** on the Keywords tab the operator adds up to 30 keywords. From the next sync on, each shows today's position (or "not in the top 10"), the landing URL, the change over 7 and 30 days, the best position, the result types on the page, and a line of positions over time. A keyword that falls five or more places from its 30-day best is a finding with the date; a tracked keyword off the first page that Search Console still sees at an average position of 30 or better is a `ranking` opportunity naming who holds the top three. The client link shows the same table without the editor. The demo site shows a full example.

**Calibration (Semrush, 2026-10-10):** Semrush's Position Tracking keeps, per keyword and day, the position, the landing URL, the result types on the page, visibility and share of voice; its overview counts keywords in the top 3, 10, 20 and 100 with improved, declined, entered and left. Eumon keeps the same per-day facts (position, URL, result types) and the same counts; visibility and share of voice are left out until asked for.

**Out of scope:** tracking by device (DataForSEO's default is desktop) or by city; positions past the first page (DataForSEO is asked for ten results, as today); visibility and share-of-voice indexes; tracking competitors' positions for the keywords (the results page already holds the top ten); alerts by email; a Sheets export.

## Sources and quotas

| Source | Auth | Cost | Used for |
|---|---|---|---|
| DataForSEO SERP `google/organic/live/advanced` (`fetchSerp`, as today) | DataForSEO login | about $0.004 a page | One results page per keyword, market and day |

- **Location and language:** `marketLocation(market)` and the site's page language, as the search-results source does. A market DataForSEO doesn't cover is skipped with a note.
- **Cost:** keywords × covered markets × $0.004 a day. 30 keywords in one market: about $3.60 a month; the card says so beside the editor ("30 keywords × 1 market ≈ $3.60 a month").
- **Budget:** 40 checks per Workflow step (the Free plan allows 50 subrequests a step), writes batched; up to 30 keywords × markets, so at most a few steps a day.
- **Gate:** the workspace's `dataForSeo` limit (`limits.ts`). Without it the editor refuses with `featureRefusal` and the sync skips the step.

## 1. Store

Migration `0025_tracked_keywords.sql`:

- `tracked_keywords (site_id REFERENCES sites(id) ON DELETE CASCADE, keyword, created_at, PRIMARY KEY (site_id, keyword))`. Keywords are kept lower-cased and whitespace-collapsed; a keyword is tracked in every covered target market, so there is no market column.
- `rank_checks (site_id REFERENCES sites(id) ON DELETE CASCADE, keyword, market, day, position INTEGER NULL, url TEXT NULL, features_json TEXT, PRIMARY KEY (site_id, keyword, market, day))`. `position` is null when the site isn't in the ten results fetched. An index on `(site_id, day)` serves the counts.

`packages/db/src/ranks.ts`: `setTrackedKeywords`, `listTrackedKeywords`, `saveRankChecks(db, siteId, rows)` (upsert, batched), `listRankChecks(db, siteId, fromDay)` (every keyword and market, oldest first), `pruneRankChecks(db, siteId, before)` (rows older than 400 days). A removed keyword's history stays until pruned; the view ignores keywords no longer tracked.

## 2. The daily step

`apps/web/src/rank-tracking.ts`, `checkRanks(db, site, keys, today, slice, fetchFn)`: for each (keyword, market) in `slice`, `fetchSerp` with the market's location and the page language; save the `rank_checks` row (`position`, `url`, `features`), and put the full `SerpResult` into the `serp` snapshot for that market (replacing the row with the same keyword, adding it otherwise), so the Search results card, the growth plan's rationales and the AI Overview counts see today's page. A keyword DataForSEO fails on is noted and skipped; the step goes on.

`syncSite` (`sync-steps.ts`) runs it after `sources`, when the site isn't the demo, the workspace's keys still include DataForSEO after `keysForLimits`, and the site has tracked keywords and covered markets: the pairs are listed in a `ranks-queue` step (keywords already checked today are left out, so a manual sync after the daily run spends nothing), then checked 40 a step (`ranks-n`, the inspection steps' retry policy), then a `ranks-counts` step writes the day's ledger points and prunes. A step that dies costs its note, never the run. Notes: "ranks: 30 checked in 1 step, $0.12", "ranks skipped “…” in MYS: …".

**Ledger** (`METRICS.ranks`): `sync.ranks`, `tracked_checked` (keyword–market pairs checked), `tracked_top3`, `tracked_top10`, `tracked_unranked`, `tracked_position_sum` (over ranked pairs, so the reader derives the average). `tracked_top20` is left out: only ten results are fetched.

## 3. Editor and API

`PUT /api/sites/[siteId]/keywords` with `{ keywords: string[] }`, like the competitors route: write access, at most 30, each 2–80 characters after trimming and collapsing whitespace, lower-cased, de-duplicated; `featureRefusal(db, workspaceId, "dataForSeo")` first (a site without a workspace follows `FREE_LIMITS`, which refuses). `GET` returns the list. Keywords that disappear from the list stop being checked the next day.

On the Keywords tab a card **Rank tracking** sits above Keywords. For operators: a textarea (one keyword a line) with Save, the cost line, and a note that the first check runs at the next sync (Sync now works). The card's subtitle: "Google's position for each keyword, checked daily in your target markets by DataForSEO (last on ⟨day⟩)."

## 4. View

`packages/core/src/ranks.ts` (pure): `ranksView(checks, tracked, markets, today)` returns, per tracked keyword and market: `position`, `url`, `features`, `change7`, `change30` (position then minus now; null when either is missing; a keyword that entered or left the ten is "entered"/"left"), `best` (lowest position in 30 days), `series` (last 90 days of `{ day, position }` for the line; a null position is drawn as 11), plus counts for the header: tracked, in the top 3, in the top 10, not in the top 10, and the average position today. Rows sort by position (unranked last), then keyword.

The card: the header counts, then a table — keyword, market, position (a badge: green ≤ 3, amber ≤ 10, grey "–" otherwise), 7-day and 30-day change (▲/▼ with the number), best, landing URL (path only, linking the page), result types (the `SERP_FEATURES` labels as small badges), and a `LineChart` of the series across the tracked keywords (one series per keyword, y inverted so 1 is at the top, up to 8 keywords in the chart). Empty states: no credentials (operator: "Add DataForSEO credentials to track positions"; client: "Not measured yet"); no markets ("Set target markets in Setup"); no keywords ("Add the searches you want to watch"); keywords but no checks yet ("First check at the next sync").

`ResultsView.ranks` carries the view model; `ResultsInput.ranks` carries `{ tracked, checks }`; `resultsPayload.site.signals.ranks` says whether credentials are set. The client link renders the card read-only.

## 5. Growth plan

`ConnectorSignals.ranks: RankSignals | null` (`{ tracked, checks, today }`), loaded with the other lists in `loadConnectorLists`.

- **Finding "“⟨keyword⟩” fell from A to B in ⟨market⟩ since ⟨day⟩"** (category `search`): the latest position against the best position in the last 30 days, with the day the fall started (the first day after the best whose position stayed worse); fires when the fall is five places or more and the best was 20 or better, or when the keyword left the ten after holding a position for seven or more days ("“…” dropped out of the top 10 in ⟨market⟩ since ⟨day⟩"). Impact: 35 + 2 × places lost, + 15 when the best was in the top 3, capped at 80. Summary names the landing page then and now (a changed URL means Google swapped the page) and the result types that appeared since (an AI Overview or a map pack arriving explains part of a fall). Recommendation: compare the page with the top three on today's results page, check the page still answers the search and loads, and watch here; History records the recovery. At most five such findings, biggest falls first. Thresholds live in one `RANKS` constant with their reasons.
- **Opportunity:** only ten results are fetched, so a position past the first page is unknown; the rule uses Search Console instead. A tracked keyword not in today's ten whose 28-day average position in the Search Console query list is 30 or better becomes a `ranking` opportunity, unless an existing striking-distance opportunity already names the same query. Its rationale carries the results page's top three and crowding, as `serpCrowding` does today; `searchDemand` from the keyword list when priced, else the heuristic.

## 6. Demo

The demo seeds eight tracked keywords and 60 days of checks in its two markets: most hold or improve; one falls from 4 to 12 over the last two weeks, so the finding fires and History has something to resolve; one sits unranked with a good Search Console position, so the opportunity shows. Results-page rows for the eight are added to `demoSerpLists`.

## 7. Testing

- db: tracked keywords save and list (lower-cased, de-duplicated); rank checks upsert twice without duplicates; prune; delete site cascades (the demo test).
- rank-tracking: a fake fetch; 41 pairs make two steps; a keyword already checked today isn't asked again; a failing keyword is noted and the rest saved; the `serp` snapshot row is replaced; the counts and marker are written.
- route: refusal without the feature; cap, length, normalisation, write access.
- core: `ranksView` changes, entered/left, best, series padding; sort order.
- agents: the two finding shapes and thresholds; a stable series gives nothing; at most five; the opportunity dedupes against an existing striking-distance one.
- demo: the latest demo analysis carries the fall finding.

## Phases

One plan. Order: migration and db, step and sync wiring, route, view model and card, growth plan, demo.
