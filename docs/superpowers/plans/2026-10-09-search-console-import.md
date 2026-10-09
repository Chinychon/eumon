# Search Console Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is executed by its author in the same session, so it names files, interfaces, algorithms and test cases exactly, and leaves routine code to TDD.

**Goal:** Operators import Search Console's Page-indexing exports; Eumon says what each URL is today, suggests redirects for dead ones, and turns the result into findings.

**Architecture:** Pure parsing/classification in `packages/core/src/search-console.ts`; storage and SQL reconciliation in `packages/db/src/search-console.ts` (+ migration 0023); request cores in `apps/web/src/search-console-import.ts` behind three routes; a Setup upload row and a Search-tab card; findings in `connector-findings.ts` wired through `connectors-data.ts`.

**Tech Stack:** TypeScript monorepo, node:test + SQLite, fflate (already a web dependency) for ZIPs in the browser, the crawler's `crawlGooglebotBatch` for live checks.

**Spec:** `docs/superpowers/specs/2026-10-09-search-console-import-design.md`

## Global Constraints

- One migration, `0023_search_console_import.sql`, exactly the table in spec §2.
- New ledger metrics only in a new group `searchConsole: ["gsc_indexed", "gsc_not_indexed"]`.
- Live checks: at most 20 URLs per request; only URLs with no crawl row.
- Today statuses: `indexable | noindex | redirect | gone | error | unchecked`.
- Reason ids: `indexed, discovered, crawled, noindex, duplicate_canonical, alternate_canonical, duplicate_no_canonical, redirect, not_found, soft_404, server_error, blocked_robots, blocked_access, other`.
- Operator only; nothing on the client link.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A CSV with a BOM, CRLF line ends and quoted fields containing commas parses (Search Console exports have all three). Pinned in Task 1.
2. A URL list whose URLs are on another host (wrong property) is refused rather than imported. Task 1 + Task 3.
3. Re-importing the same URL under a new reason keeps nothing stale: the reason changes, the live check is cleared. Task 2.
4. The check endpoint never fetches a URL the crawl already knows, and never more than 20. Task 2 + 3.
5. A suggestion is never a junk match: one short common token (`lee`) alone does not pair two URLs. Task 1.

---

### Task 1: Core — parse exports, normalise reasons, classify today, suggest redirects

**Files:** create `packages/core/src/search-console.ts`, `packages/core/src/search-console.test.ts`; modify `packages/core/src/index.ts` (export), `packages/core/src/results.ts` (`METRICS.searchConsole`).

**Produces:**
```ts
export type GscReason = "indexed" | "discovered" | "crawled" | "noindex" | "duplicate_canonical" | "alternate_canonical" | "duplicate_no_canonical" | "redirect" | "not_found" | "soft_404" | "server_error" | "blocked_robots" | "blocked_access" | "other";
export const GSC_REASONS: Array<{ reason: GscReason; label: string }>;           // display order, labels as Search Console writes them
export function gscReason(text: string): GscReason;                               // normalise exported text
export type ParsedExport =
  | { kind: "urls"; urls: Array<{ url: string; lastCrawled: string | null }>; otherHost: number }
  | { kind: "table"; rows: Array<{ reason: GscReason; reasonText: string; source: string | null; validation: string | null; pages: number }> }
  | { kind: "chart"; points: Array<{ day: string; indexed: number; notIndexed: number }> }
  | { kind: "unknown"; why: string };
export function parseSearchConsoleExport(text: string, host: string): ParsedExport;  // host = the site's host, with/without www
export function reasonFromFileName(name: string): GscReason | null;
export type TodayStatus = "indexable" | "noindex" | "redirect" | "gone" | "error" | "unchecked";
export function todayStatus(input: { url: string; status: number | null; finalUrl?: string | null; noindex?: boolean | null } | null): TodayStatus;
export function suggestRedirect(deadUrl: string, liveUrls: string[]): string | null;
```

- [ ] Tests (write first, watch fail): BOM+CRLF+quoted URL list with "Last crawled" → `urls` with ISO dates; URL list under a Dutch header (`URL`,`Laatst gecrawld`) still `urls` (date found by value); URLs on another host counted in `otherHost` and excluded; overview table → `table` with normalised reasons and numeric pages (thousands separators stripped); chart → `chart`; nonsense → `unknown`. `gscReason` for each of Search Console's nine phrases + "Indexed". `todayStatus`: 200 → indexable, 200 noindex → noindex, finalUrl ≠ url → redirect, 404/410 → gone, 503 → error, null → unchecked. `suggestRedirect`: `catherine-lee` → `dr-catherine-lee-tong-how` over `dr-lee-wong`; `pantai-melaka` → `pantai-hospital-melaka`; `lee` alone → null; a 6+ character single token (`badaruddin`) matches.
- [ ] Implement; `npm test -w @organic-growth/core` green; commit "Search Console export: parse, normalise, classify, suggest".

### Task 2: Database — table, import, checks, reconciliation

**Files:** create `packages/db/migrations/0023_search_console_import.sql`, `packages/db/src/search-console.ts`, `packages/db/src/search-console.test.ts`; modify `packages/db/src/index.ts` (re-export).

**Produces:**
```ts
export function importSearchConsoleUrls(db, siteId, input: { reason: GscReason; reasonText: string; urls: Array<{ url: string; lastCrawled: string | null }>; importedAt: string }): Promise<{ imported: number }>;
export function saveSearchConsoleSummary(db, siteId, rows: ParsedExport<"table">["rows"], importedAt: string): Promise<void>;   // snapshot kind search_console_summary, scope "table"
export function saveSearchConsoleChart(db, siteId, points): Promise<void>;        // gsc_indexed / gsc_not_indexed points
export function searchConsoleUrlsToCheck(db, siteId, limit: number): Promise<string[]>;   // unchecked, no row in the latest crawl
export function saveSearchConsoleChecks(db, siteId, rows: Array<{ url: string; status: number | null; finalUrl: string | null; noindex: boolean | null; suggestedUrl: string | null }>): Promise<void>;
export function liveUrlsOfFamily(db, siteId, family: string): Promise<string[]>;  // latest crawl, status < 400
export type SearchConsoleReconciliation = { importedAt: string | null; summary: { rows; importedAt } | null; reasons: Array<{ reason: GscReason; reasonText: string; urls: number; today: Record<TodayStatus, number>; examples: Partial<Record<TodayStatus, string[]>> }>; suggestions: Array<{ url: string; suggestedUrl: string }>; remainingChecks: number };
export function searchConsoleReconciliation(db, siteId): Promise<SearchConsoleReconciliation>;
```
Reconciliation is one SQL query joining `search_console_urls` with the latest crawl's `pages` (`status`, `json_extract(result_json,'$.finalUrl')`, `json_extract(result_json,'$.noindex')`) and classifying in JS per row (rows ≤ a few thousand; `discovered` lists can be 20k+ — classify in SQL with `CASE` for the counts and fetch examples with `LIMIT 10` per reason/status, so the request reads counts, not rows).

- [ ] Tests first: import then re-import under another reason clears live columns; `urlsToCheck` excludes crawl-known URLs and respects the limit; reconciliation counts per reason from crawl rows (indexable/noindex/redirect/gone) and from live rows; examples capped at 10; summary and chart saved; `deleteSite` cascades (add to the demo delete test's table list if it enumerates tables).
- [ ] Implement; `npm test -w @organic-growth/db` green; commit.

### Task 3: Web — import, check and read handlers

**Files:** create `apps/web/src/search-console-import.ts`, `apps/web/src/search-console-import.test.ts`, routes `apps/web/app/api/sites/[siteId]/search-console/route.ts` (GET), `.../search-console/import/route.ts` (POST, `?reason=&name=`, text body ≤ 8 MB via `readText`), `.../search-console/check/route.ts` (POST).

**Produces:**
```ts
export function importExport(db, site, text: string, options: { reason?: GscReason; fileName?: string; now?: Date }): Promise<{ kind: "urls" | "table" | "chart"; imported: number; reason?: GscReason; otherHost: number; remainingChecks: number } | { error: string }>;
export function checkSearchConsoleUrls(db, site, options: { limit?: number; crawl?: typeof crawlGooglebotBatch }): Promise<{ checked: number; remaining: number }>;   // 404/410 → suggestRedirect against liveUrlsOfFamily
export function searchConsoleView(db, siteId): Promise<SearchConsoleReconciliation & { history: Array<{ day: string; indexed: number; notIndexed: number }> }>;
```
- [ ] Tests first (SQLite, a fake `crawl` that returns scripted statuses): a URL-list import records rows and reports `remainingChecks`; a wrong-host file errors; a table import saves the summary; the check loop stops at zero and stores a suggestion for a 404 whose slug matches a live URL; the view merges counts, suggestions and history.
- [ ] Implement + routes; `cd apps/web && node --test src/search-console-import.test.ts` green; typecheck; commit.

### Task 4: Console — Setup upload row and the Search-tab card

**Files:** modify `apps/web/app/components/ConnectorSetup.tsx` (row + upload loop; `unzipSync` from fflate for `.zip`), create `apps/web/app/components/results/SearchConsoleCard.tsx`, modify `apps/web/app/components/SitePanels.tsx` (card under `IndexCoverageCard` in `SearchPanel`), `apps/web/app/components/export/report-sheets.ts` (`searchConsoleSheets`).

- [ ] Build; `npm run typecheck -w @organic-growth/web`; look at it against the demo (Task 5 seeds data) at desktop width; commit.

### Task 5: Findings and demo

**Files:** modify `packages/agents/src/connector-findings.ts` (`findingsFromSearchConsoleImport`, `ConnectorSignals.searchConsole`), `packages/agents/src/pipeline.ts` (call it), `apps/web/src/connectors-data.ts` (load the summary), `packages/agents/src/demo.ts` (`seedDemoSearchConsole`), tests in `connector-findings.test.ts` and `apps/web/src/search-console-import.test.ts` (demo case).

- [ ] Tests first: thresholds for the three findings; evidence carries up to 25 suggestion pairs; the demo's import yields all three and a view with suggestions.
- [ ] Implement; agents + web suites green; commit.

### Task 6: Glossary and verification

- [ ] `CONTEXT.md`: **Search Console import**, **Today status**, **Redirect suggestion**.
- [ ] `npm run typecheck && npm test` green; commit.
