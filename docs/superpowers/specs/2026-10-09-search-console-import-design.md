# Search Console import: what Google says it did with every URL, checked against today

**Status:** approved in principle on 2026-10-09 as sub-project A of "match the MedBay report"; built straight through at the user's request.

**Goal:** Google's Page indexing report has no API, but it exports. An operator drops those exports into Eumon; Eumon checks each URL against its own crawl (and fetches the ones that are no longer in the sitemap) and says what each one is **today**: indexable, still noindex, redirecting, gone, erroring. For URLs that are gone it suggests the live page they should redirect to. The overview totals and the indexed-count history come along, and three findings put the result into the growth plan and History.

**Why:** the MedBay report's most useful table (§2.2: of 468 noindex URLs, 44% are indexable now, 43% redirect, 7% still noindex, 6% are 404) came from exactly this reconciliation, done by hand. Eumon has the crawl; it only lacked Google's URL lists.

**Out of scope:** the Search Console API (none exists for this report); automatic redirect PRs (the change allowlist, later); soft-404 detection from content (sub-project C); PDF exports.

## 1. What can be imported

Three export shapes, told apart by their headers and values, in CSV or inside the ZIP Search Console downloads (unzipped in the browser with fflate, which the console already ships):

| Shape | Recognised by | Becomes |
|---|---|---|
| **URL list** (a reason's drill-down) | a column whose values are URLs on the site's host; an optional date column ("Last crawled") | rows in `search_console_urls`, tagged with the reason the operator picks (pre-filled from the file name when it names one) |
| **Overview table** | columns for reason and pages (Search Console's "Reason, Source, Validation, Trend, Pages") | the summary snapshot: pages per reason |
| **Chart** | a date column beside "Indexed" / "Not indexed" counts | ledger points `gsc_indexed` and `gsc_not_indexed` per day |

Headers are matched loosely (case, spaces, a localised UI); URL and date columns are found by their values when the header doesn't say. A file that matches nothing is refused with a one-line reason.

Reasons are normalised to ids: `indexed`, `discovered`, `crawled`, `noindex`, `duplicate_canonical`, `alternate_canonical`, `duplicate_no_canonical`, `redirect`, `not_found`, `soft_404`, `server_error`, `blocked_robots`, `blocked_access`, `other` (which keeps the exported text).

## 2. Storage

Migration `0023_search_console_import.sql`:

```sql
CREATE TABLE IF NOT EXISTS search_console_urls (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  reason TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  last_crawled TEXT,
  imported_at TEXT NOT NULL,
  live_status INTEGER,
  live_final_url TEXT,
  live_noindex INTEGER,
  checked_at TEXT,
  suggested_url TEXT,
  PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_search_console_urls_reason ON search_console_urls (site_id, reason);
```

A URL imported again takes the new reason and date; its live check is kept unless the reason changed. The overview table is a snapshot (`kind = "search_console_summary"`, scope `"table"`). The chart writes two new ledger metrics in their own group, `searchConsole: ["gsc_indexed", "gsc_not_indexed"]`, so no sync ever overwrites them.

## 3. What each URL is today

For every imported URL, in this order:

1. **In the current sitemap crawl** (a `pages` row of the latest finished analysis): `status < 400` and not noindex → **indexable**; noindex → **noindex**; the crawl followed a redirect (`finalUrl` differs) → **redirect**; 404/410 → **gone**; other 4xx/5xx → **error**.
2. **Not in the crawl** (old slugs, pages dropped from the sitemap): a **live check** fetches it as Googlebot (`crawlGooglebotBatch`, the crawler's own fetcher) and classifies the same way; until then it is **unchecked**.

Live checks run from the console: `POST /api/sites/:id/search-console/check` checks up to 20 unchecked URLs per call (the Free plan allows 50 subrequests per request; a redirect chain costs several) and reports how many remain; the Setup card loops until none do. Reasons that are sitemap-sized (`discovered`, `crawled`) are almost always in the crawl and cost nothing.

## 4. Redirect suggestions

For a URL that is **gone**: tokens of its last path segment (split on non-alphanumerics, lower-cased, minus `dr`, `dato`, `datuk`, `prof`, `mr`, `mrs`, `ms`, `the`, `and`, and one-character tokens) are looked for in the slugs of live crawled URLs of the same page type. A candidate must contain every token; the one with the fewest extra tokens wins; at least two tokens must match, or one token of six characters or more. `catherine-lee` → `dr-catherine-lee-tong-how`; `pantai-melaka` → `pantai-hospital-melaka`. The suggestion is stored on the row (`suggested_url`) when the live check finds the URL gone, and recomputed for gone URLs the crawl knows when the card loads.

## 5. Where it shows

- **Setup → More sources** gains a row, "Search Console export": a file input (`.csv`, `.zip`), a reason selector for URL lists (pre-filled from the file name), and a status line: "Imported 468 URLs as Excluded by noindex. Checking 227 that are no longer in the sitemap… 120 done." Imports of the overview table and chart say what they recorded.
- **Dashboard → Search** gains a card, "Search Console: pages not indexed", under Google crawl coverage: the latest overview totals (pages per reason, Google's indexed/not-indexed counts and date), then per imported reason a row with what those URLs are today (indexable · noindex · redirect · gone · error · unchecked, as a stacked bar with counts), and a "Redirect suggestions" list (dead URL → live URL) with an Export menu (one sheet per reason plus the suggestions).
- The indexed-count history is a small line in the card when the chart was imported.
- Operator only.

## 6. Findings

`findingsFromSearchConsoleImport` (in `connector-findings.ts`, fed by `connectors-data.ts` like the crawl log) adds up to three findings to an analysis when an import exists:

1. **"Google has indexed N of the M URLs it knows (x%)"** — when the overview is imported, M ≥ 100 and x < 50%. Category `indexing`. Recommendation: fewer, better sitemap URLs (noindex or drop thin pages; the crawl's thin-page counts are cited), then watch crawl-log coverage.
2. **"N URLs Google excluded as noindex are indexable now"** — reason `noindex`, N ≥ 10 indexable today. Category `indexing`. Recommendation: Validate fix in Search Console and resubmit the sitemap; IndexNow for Bing.
3. **"N old URLs Google still crawls return 404; M match a live page"** — any reason, N ≥ 5 gone today. Category `indexing`. Recommendation: 301 redirects, with the suggestions as evidence (up to 25 pairs).

These resolve in History when the next import (or the crawl) no longer shows them.

## 7. Demo

The demo imports a plausible export: 2,000 `/guides/` URLs as `discovered`, 160 `/dentists/` URLs as `noindex` (70 in the sitemap and indexable now, 20 still noindex, 50 old slugs that redirect, 20 old slugs that are gone, 12 of them matching a live page), an overview table, and 16 weeks of chart points. Live checks are pre-recorded, since the demo never fetches outside.

## 8. Testing

- core: export detection for the three shapes (including a localised header and a URL column found by value); reason normalisation; today-classification from crawl and live results; redirect suggestion (match, best candidate, no junk match).
- db: import upserts and keeps live checks across re-imports; `urlsToCheck` returns only unchecked URLs outside the crawl; reconciliation counts per reason from crawl rows and live rows; summary snapshot and chart metrics saved.
- web: the three request handlers' pure cores over SQLite; the check loop's `remaining`; the card's data shape; the findings from a summary (thresholds, evidence).
- demo test: the demo's import gives all three findings and a card with suggestions.
