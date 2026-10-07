# Results, Phase 1 (sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Results view that shows, with 16 months of history, whether a site's Google clicks, rankings, organic sessions, indexed pages, and enquiries have improved since Eumon's pages went live, plus a read-only client link to it.

**Architecture:** Every number is a daily point in one ledger table (`metric_points`), written by the existing daily `SearchSyncWorkflow` (extended) from Search Console, Google Analytics 4, the URL Inspection API, and Eumon's own first-party tables, and by each finished analysis. The Results API reads series from the ledger and a pure function (`resultsView` in `@organic-growth/core`) turns them into windows, weeks, and comparisons. The view and the client link render that one shape.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 + Workflows, vinext (Next-compatible app router) and React 19, `node:test` on SQLite (`@organic-growth/db/sqlite`), Google Search Console API, URL Inspection API, GA4 Data API and Admin API.

**Spec:** `docs/superpowers/specs/2026-10-06-results-metrics-design.md` (Phase 1, as extended on 2026-10-07 with Google Analytics 4 and index status). Phases 2 and 3 and sub-projects B–D are out of scope.

## Global Constraints

- Branch: `claude/seo-data`. Commit after each task. Never push. Never run `npm run db:migrate:remote` (the user does, on deploy).
- Never kill the user's dev server on port 5174. Rebuilding a package while it runs can leave it with a cached failed import; if that happens, ask the user to restart it.
- Days: first-party days are UTC (`YYYY-MM-DD`). Search Console days are as Google reports them.
- Current window: the 28 days ending yesterday (first-party) or ending three days ago (Search Console and GA4). Before: the 28 days ending the day before go-live. Previous: the 28 days before the current window.
- Go-live: the earliest `published_at` among the site's published generated pages. No published page → no go-live, and no before/after comparison.
- Rates are derived from summed components: CTR = clicks ÷ impressions; average position = Σ(position × impressions) ÷ impressions. Never average daily rates.
- Lead: a session with at least one contact event that day (`whatsapp_click`, `phone_click`, `email_click`, `form_submit`, `booking_complete`, `lead_created`), counted once per session per day; an event without a session counts once. Eumon lead: the session first landed on an Eumon page (`page_sessions`).
- Honesty: missing data is a labeled state, never 0. Pages never inspected are "not checked yet", never "not indexed". GA4 key events are labeled "GA4 key events" and never added to Eumon's lead count.
- Ledger stores only additive daily values or point-in-time snapshots; ratios are derived at read time. Re-running any sync overwrites points, never duplicates them.
- Target markets: when `site_markets` has countries, Search Console series and ranking buckets are also stored for those countries with the metric suffix `@markets` (e.g. `search_clicks@markets`), and section 1 shows them with the all-countries figure beside.
- Backfill window: 486 days (16 months) for Search Console and GA4.
- UI follows `apps/web/DESIGN.md`: square ruled panels sharing rules, Geist / Geist Mono, both themes, existing chart components (`LineChart`, `BarList`, `Funnel`), one-line `Why` rows. Copy uses commas, colons, and full stops rather than dashes.
- Tests: `node:test`, no live API calls; Google clients take an injectable `fetchFn` and are tested on recorded response fixtures.

## Review Focus

1. A site with Search Console but no published Eumon page: no go-live, so key numbers compare with the previous 28 days and the headline has no marker; nothing reads "before Eumon". (Task 4 test.)
2. Google access revoked or expired during the daily sync: that site's Google steps report failure, first-party points are still written, and the other sites still sync. (Task 9 test.)
3. A GA4 property chosen on a credential granted before `analytics.readonly` was requested: GA4 is skipped with a "Reconnect Google" state, no GA4 request is made, Search Console still syncs. (Task 9 test.)
4. The first sync run twice (backfill re-run): points are overwritten, never duplicated, and the second run fetches only the last 7 days. (Task 1 and Task 9 tests.)
5. Weeks with no data (Search Console gaps, a site connected mid-history) and the current partial week: empty weeks are `null`, not 0, and weeks after the last complete day are marked partial so they draw dashed. (Task 4 test.)

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/migrations/0012_results.sql` | `metric_points`, `page_index_status`, `sites.ga4_property`, `sites.report_share_version` |
| `packages/db/src/metrics.ts` | Ledger read/write, first-party daily metrics, analysis health points, index status storage, site list for the sync |
| `packages/db/src/metrics.test.ts` | Ledger, leads, health, index status tests |
| `packages/core/src/results.ts` | Pure window, weekly, comparison math and `resultsView` assembly |
| `packages/core/src/results.test.ts` | Tests for the above |
| `packages/agents/src/results-points.ts` | Pure conversion of Google rows into ledger points; ranking buckets |
| `packages/agents/src/results-points.test.ts` | Tests for the above |
| `packages/agents/src/google-search-console.ts` | Add daily series, query positions, URL inspection (modify) |
| `packages/agents/src/google-analytics.ts` | GA4 property list and daily report |
| `packages/agents/src/google-clients.test.ts` | Parsers on recorded fixtures |
| `apps/web/src/gsc-auth.ts` | Store and read granted scopes (modify) |
| `apps/web/src/results-sync.ts` | Orchestrates one site's daily Results sync |
| `apps/web/src/results-sync.test.ts` | Failure isolation and scope tests |
| `apps/web/src/search-sync-workflow.ts` | Run Results sync for every eligible site (modify) |
| `apps/web/app/api/sites/[siteId]/ga4/properties/route.ts` | List and choose a GA4 property |
| `apps/web/app/api/sites/[siteId]/results/route.ts` | Results view data |
| `apps/web/app/api/sites/[siteId]/results/sync/route.ts` | "Sync now" |
| `apps/web/app/api/sites/[siteId]/share/route.ts` | Create and revoke the client link |
| `apps/web/app/api/r/[token]/route.ts` | Client link data |
| `apps/web/app/r/[token]/page.tsx`, `apps/web/app/r/[token]/ClientReport.tsx` | Client link page |
| `apps/web/app/components/ResultsView.tsx` | The Results view |
| `apps/web/app/components/charts.tsx` | `LineChart` go-live marker and dashed partial weeks (modify) |
| `apps/web/app/components/ConnectionsView.tsx`, `apps/web/app/page.tsx`, `apps/web/app/globals.css` | GA4 row, Results nav item, styles (modify) |
| `packages/agents/src/demo.ts`, `packages/agents/src/demo.test.ts` | Demo history so the view can be checked (modify) |

---

### Task 1: The ledger

**Files:**
- Create: `packages/db/migrations/0012_results.sql`, `packages/db/src/metrics.ts`, `packages/db/src/metrics.test.ts`
- Modify: `packages/db/src/index.ts` (export, `mapSite`), `packages/core/src/types.ts` (`SiteRecord`)

**Interfaces:**
- Produces: `type MetricPoint = { metric: string; day: string; value: number }`; `upsertMetricPoints(db, siteId, points: MetricPoint[]): Promise<void>`; `listMetricSeries(db, siteId, metrics: string[], from: string, to: string): Promise<Record<string, Array<{ day: string; value: number }>>>`; `firstMetricDay(db, siteId, metric): Promise<string | null>`; `SiteRecord.ga4Property?: string`; `SiteRecord.reportShareVersion?: number`; `updateSiteGa4Property(db, siteId, property: string | null)`; `bumpReportShareVersion(db, siteId): Promise<number>`.

- [ ] **Step 1: Write the migration**

`packages/db/migrations/0012_results.sql`:

```sql
-- Results: one daily point per site and metric. Sums are additive daily
-- values; snapshots are the value on that day. Ratios are derived on read.
CREATE TABLE IF NOT EXISTS metric_points (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (site_id, metric, day)
);

-- Latest URL Inspection result per published Eumon page.
CREATE TABLE IF NOT EXISTS page_index_status (
  page_id TEXT PRIMARY KEY REFERENCES generated_pages(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  coverage_state TEXT,
  last_crawl_time TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_index_status_site ON page_index_status(site_id);

ALTER TABLE sites ADD COLUMN ga4_property TEXT;
ALTER TABLE sites ADD COLUMN report_share_version INTEGER NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Write the failing test**

`packages/db/src/metrics.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bumpReportShareVersion, firstMetricDay, getSite, listMetricSeries, updateSiteGa4Property, upsertMetricPoints, upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const now = "2026-10-07T00:00:00.000Z";

describe("metric ledger", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });

  it("overwrites a point on re-run instead of adding a second one", async () => {
    await upsertMetricPoints(db, "s", [{ metric: "search_clicks", day: "2026-10-01", value: 5 }, { metric: "search_clicks", day: "2026-10-02", value: 7 }]);
    await upsertMetricPoints(db, "s", [{ metric: "search_clicks", day: "2026-10-02", value: 9 }]);
    const series = await listMetricSeries(db, "s", ["search_clicks", "leads"], "2026-09-01", "2026-10-31");
    assert.deepEqual(series.search_clicks, [{ day: "2026-10-01", value: 5 }, { day: "2026-10-02", value: 9 }]);
    assert.deepEqual(series.leads, [], "a metric with no points is an empty series");
  });

  it("knows whether a metric was ever written", async () => {
    assert.equal(await firstMetricDay(db, "s", "search_clicks"), "2026-10-01");
    assert.equal(await firstMetricDay(db, "s", "ga4_sessions"), null);
  });

  it("stores the GA4 property and versions the client link", async () => {
    await updateSiteGa4Property(db, "s", "properties/123");
    assert.equal((await getSite(db, "s"))?.ga4Property, "properties/123");
    assert.equal((await getSite(db, "s"))?.reportShareVersion, 1);
    assert.equal(await bumpReportShareVersion(db, "s"), 2);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm run build -w @organic-growth/core && cd packages/db && npx tsc -p tsconfig.test.json; node --disable-warning=ExperimentalWarning --test dist-test/metrics.test.js`
Expected: compile errors, `upsertMetricPoints` and the others are not exported.

- [ ] **Step 4: Implement**

In `packages/core/src/types.ts`, add to `SiteRecord` after `gscProperty?: string;`:

```ts
  /** GA4 property (`properties/123456`) whose sessions feed Results. */
  ga4Property?: string;
  /** Bumped to revoke every client link to this site's Results. */
  reportShareVersion?: number;
```

In `packages/db/src/index.ts`, in `mapSite` after the `gscProperty` line:

```ts
    ga4Property: row.ga4_property ? String(row.ga4_property) : undefined,
    reportShareVersion: row.report_share_version === undefined || row.report_share_version === null ? undefined : Number(row.report_share_version),
```

and add beside the other exports at the top of the file:

```ts
export * from "./metrics.js";
```

Create `packages/db/src/metrics.ts`:

```ts
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

/*
 * Results ledger: one value per site, metric, and day. Sync jobs overwrite
 * points (so re-runs and Search Console revisions never double count), and
 * readers derive every ratio from the stored components.
 */

export type MetricPoint = { metric: string; day: string; value: number };

export async function upsertMetricPoints(db: D1Like, siteId: string, points: MetricPoint[]): Promise<void> {
  const statements = points.map((point) => db.prepare(
    `INSERT INTO metric_points (site_id, metric, day, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(site_id, metric, day) DO UPDATE SET value = excluded.value`,
  ).bind(siteId, point.metric, point.day, point.value));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Each metric's points between two days (inclusive), oldest first; metrics without points get an empty series. */
export async function listMetricSeries(db: D1Like, siteId: string, metrics: string[], from: string, to: string) {
  const { results } = await db.prepare(
    `SELECT metric, day, value FROM metric_points
     WHERE site_id = ? AND metric IN (SELECT value FROM json_each(?)) AND day >= ? AND day <= ?
     ORDER BY metric, day`,
  ).bind(siteId, JSON.stringify(metrics), from, to).all<{ metric: string; day: string; value: number }>();
  const series: Record<string, Array<{ day: string; value: number }>> = Object.fromEntries(metrics.map((metric) => [metric, []]));
  for (const row of results) series[row.metric]!.push({ day: row.day, value: Number(row.value) });
  return series;
}

export async function firstMetricDay(db: D1Like, siteId: string, metric: string): Promise<string | null> {
  const row = await db.prepare("SELECT MIN(day) AS day FROM metric_points WHERE site_id = ? AND metric = ?").bind(siteId, metric).first<{ day: string | null }>();
  return row?.day ?? null;
}

export async function updateSiteGa4Property(db: D1Like, siteId: string, property: string | null): Promise<void> {
  await db.prepare("UPDATE sites SET ga4_property = ?, updated_at = ? WHERE id = ?").bind(property, nowIso(), siteId).run();
}

/** Revokes every client link issued so far; returns the new version. */
export async function bumpReportShareVersion(db: D1Like, siteId: string): Promise<number> {
  await db.prepare("UPDATE sites SET report_share_version = report_share_version + 1, updated_at = ? WHERE id = ?").bind(nowIso(), siteId).run();
  const row = await db.prepare("SELECT report_share_version AS v FROM sites WHERE id = ?").bind(siteId).first<{ v: number }>();
  return Number(row?.v ?? 1);
}
```

- [ ] **Step 5: Run the test and the whole db suite**

Run: `npm run build -w @organic-growth/core && npm test -w @organic-growth/db 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0012_results.sql packages/db/src/metrics.ts packages/db/src/metrics.test.ts packages/db/src/index.ts packages/core/src/types.ts
git commit -m "Add the Results ledger: daily metric points, GA4 property, client link version"
```

---

### Task 2: First-party daily metrics

**Files:**
- Modify: `packages/db/src/metrics.ts`, `packages/db/src/metrics.test.ts`

**Interfaces:**
- Consumes: `upsertMetricPoints`, `firstMetricDay` (Task 1); `addDays` from `@organic-growth/core` (Task 4 defines it; implement Task 4 Step 3's `addDays` first if executing out of order).
- Produces: `LEAD_EVENTS: string[]`; `dailyLeads(db, siteId, sinceDay): Promise<Array<{ day: string; leads: number; eumonLeads: number }>>`; `publishedPages(db, siteId): Promise<{ published: number; goLive: string | null }>`; `syncFirstPartyResults(db, siteId, now?: Date): Promise<void>` writing `leads`, `leads_eumon`, `googlebot_fetches`, `eumon_page_views`, `eumon_cta_clicks` per day and `published_pages` for today.

- [ ] **Step 1: Write the failing test** (append to `packages/db/src/metrics.test.ts`; add `dailyLeads, insertConversionEvent, publishedPages, recordLandingSession, syncFirstPartyResults` to the import from `./index.js`)

```ts
describe("first-party results", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  const event = (id: string, name: string, at: string, sessionId?: string) =>
    insertConversionEvent(db, { id, siteId: "s", event: name, occurredAt: at, ...(sessionId ? { sessionId } : {}) });
  await event("e1", "whatsapp_click", "2026-10-01T02:00:00Z", "a");
  await event("e2", "form_submit", "2026-10-01T05:00:00Z", "a");      // same session, same day: one lead
  await event("e3", "whatsapp_click", "2026-10-02T01:00:00Z", "a");   // same session, next day: another lead
  await event("e4", "phone_click", "2026-10-01T09:00:00Z");           // no session: counts once
  await event("e5", "page_view", "2026-10-01T09:30:00Z", "b");        // not a contact action
  await recordLandingSession(db, { siteId: "s", sessionId: "a", pageId: "p1" });

  it("counts a session once per day and attributes it to Eumon when it landed on an Eumon page", async () => {
    assert.deepEqual(await dailyLeads(db, "s", "2026-09-01"), [
      { day: "2026-10-01", leads: 2, eumonLeads: 1 },
      { day: "2026-10-02", leads: 1, eumonLeads: 1 },
    ]);
  });

  it("writes the daily points, and a re-run overwrites them", async () => {
    await syncFirstPartyResults(db, "s", new Date("2026-10-07T04:15:00Z"));
    await syncFirstPartyResults(db, "s", new Date("2026-10-07T04:15:00Z"));
    const series = await listMetricSeries(db, "s", ["leads", "leads_eumon", "published_pages"], "2026-09-01", "2026-10-31");
    assert.deepEqual(series.leads, [{ day: "2026-10-01", value: 2 }, { day: "2026-10-02", value: 1 }]);
    assert.deepEqual(series.leads_eumon, [{ day: "2026-10-01", value: 1 }, { day: "2026-10-02", value: 1 }]);
    assert.deepEqual(series.published_pages, [{ day: "2026-10-07", value: 0 }]);
    assert.deepEqual(await publishedPages(db, "s"), { published: 0, goLive: null });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/db && npx tsc -p tsconfig.test.json; node --disable-warning=ExperimentalWarning --test dist-test/metrics.test.js`
Expected: compile errors for the missing exports.

- [ ] **Step 3: Implement** (append to `packages/db/src/metrics.ts`; add `import { addDays } from "@organic-growth/core";` at the top)

```ts
/** Contact actions that make a visit a lead (Results spec, "Lead"). */
export const LEAD_EVENTS = ["whatsapp_click", "phone_click", "email_click", "form_submit", "booking_complete", "lead_created"];

/** Leads per UTC day: a session counts once a day; an event without a session counts once. */
export async function dailyLeads(db: D1Like, siteId: string, sinceDay: string) {
  const { results } = await db.prepare(
    `WITH contacts AS (
       SELECT substr(occurred_at, 1, 10) AS day, COALESCE(session_id, 'event:' || id) AS who
       FROM conversion_events
       WHERE site_id = ? AND occurred_at >= ? AND event IN (SELECT value FROM json_each(?))
       GROUP BY day, who
     )
     SELECT c.day AS day, COUNT(*) AS leads, SUM(CASE WHEN s.session_id IS NULL THEN 0 ELSE 1 END) AS eumon
     FROM contacts c LEFT JOIN page_sessions s ON s.session_id = c.who AND s.site_id = ?
     GROUP BY c.day ORDER BY c.day`,
  ).bind(siteId, sinceDay, JSON.stringify(LEAD_EVENTS), siteId).all<{ day: string; leads: number; eumon: number }>();
  return results.map((row) => ({ day: row.day, leads: Number(row.leads), eumonLeads: Number(row.eumon) }));
}

/** How many Eumon pages are published, and the day the first one went live. */
export async function publishedPages(db: D1Like, siteId: string): Promise<{ published: number; goLive: string | null }> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n, MIN(published_at) AS first FROM generated_pages WHERE site_id = ? AND status = 'published'",
  ).bind(siteId).first<{ n: number; first: string | null }>();
  return { published: Number(row?.n ?? 0), goLive: row?.first ? row.first.slice(0, 10) : null };
}

/**
 * Writes the first-party Results points: leads, Googlebot fetches, page views
 * and CTA clicks per day, and today's published page count. The first run
 * backfills all history; later runs rewrite the last 7 days.
 */
export async function syncFirstPartyResults(db: D1Like, siteId: string, now = new Date()): Promise<void> {
  const today = now.toISOString().slice(0, 10);
  const since = (await firstMetricDay(db, siteId, "published_pages")) ? addDays(today, -7) : "2000-01-01";
  const [leads, activity, pages] = await Promise.all([
    dailyLeads(db, siteId, since),
    db.prepare(
      `SELECT day, SUM(googlebot_hits) AS googlebot, SUM(views) AS views, SUM(cta_clicks) AS cta
       FROM page_metrics_daily WHERE site_id = ? AND day >= ? GROUP BY day`,
    ).bind(siteId, since).all<{ day: string; googlebot: number; views: number; cta: number }>(),
    publishedPages(db, siteId),
  ]);
  await upsertMetricPoints(db, siteId, [
    ...leads.flatMap((row) => [
      { metric: "leads", day: row.day, value: row.leads },
      { metric: "leads_eumon", day: row.day, value: row.eumonLeads },
    ]),
    ...activity.results.flatMap((row) => [
      { metric: "googlebot_fetches", day: row.day, value: Number(row.googlebot) },
      { metric: "eumon_page_views", day: row.day, value: Number(row.views) },
      { metric: "eumon_cta_clicks", day: row.day, value: Number(row.cta) },
    ]),
    { metric: "published_pages", day: today, value: pages.published },
  ]);
}
```

- [ ] **Step 4: Run the db suite**

Run: `npm test -w @organic-growth/db 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/metrics.ts packages/db/src/metrics.test.ts
git commit -m "Write leads, page activity, and published pages into the Results ledger"
```

---

### Task 3: Site health from each finished analysis

**Files:**
- Modify: `packages/db/src/metrics.ts`, `packages/db/src/index.ts` (`saveAnalysisReport`), `packages/db/src/metrics.test.ts`

**Interfaces:**
- Consumes: `upsertMetricPoints` (Task 1).
- Produces: `analysisHealthPoints(report: unknown, day: string): MetricPoint[]` returning `crawl_urls`, `crawl_empty_shells`, `crawl_http_errors`, `crawl_noindex`, `site_health` (percentage 0–100); `saveAnalysisReport` writes them dated to the completion day.

- [ ] **Step 1: Write the failing test** (append; add `analysisHealthPoints, createAnalysis, saveAnalysisReport` to the import)

```ts
describe("site health snapshots", async () => {
  it("measures health against crawled pages, and skips reports without a full crawl", () => {
    const points = analysisHealthPoints({ coverage: { totalUrls: 120, completedUrls: 100, emptyShellUrls: 8, httpErrorUrls: 2, issues: { noindex: 5 } } }, "2026-10-07");
    assert.deepEqual(points.find((point) => point.metric === "site_health"), { metric: "site_health", day: "2026-10-07", value: 85 });
    assert.deepEqual(analysisHealthPoints({ coverage: null }, "2026-10-07"), []);
    assert.deepEqual(analysisHealthPoints({ coverage: { totalUrls: 0, completedUrls: 0, emptyShellUrls: 0, httpErrorUrls: 0 } }, "2026-10-07"), []);
  });

  it("is written when an analysis report is saved", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: now });
    await saveAnalysisReport(db, "a1", { coverage: { totalUrls: 10, completedUrls: 10, emptyShellUrls: 1, httpErrorUrls: 0 } }, "summary");
    const today = new Date().toISOString().slice(0, 10);
    const series = await listMetricSeries(db, "s", ["site_health"], today, today);
    assert.deepEqual(series.site_health, [{ day: today, value: 90 }]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/db && npx tsc -p tsconfig.test.json; node --disable-warning=ExperimentalWarning --test dist-test/metrics.test.js`
Expected: `analysisHealthPoints` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/db/src/metrics.ts`:

```ts
/** Coverage counts and site health (share of crawled URLs with no error, empty shell, or noindex) from a report. */
export function analysisHealthPoints(report: unknown, day: string): MetricPoint[] {
  const coverage = (report as { coverage?: { totalUrls?: number; completedUrls?: number; emptyShellUrls?: number; httpErrorUrls?: number; issues?: { noindex?: number } } | null } | null)?.coverage;
  if (!coverage?.completedUrls) return [];
  const empty = coverage.emptyShellUrls ?? 0;
  const errors = coverage.httpErrorUrls ?? 0;
  const noindex = coverage.issues?.noindex ?? 0;
  const healthy = Math.max(0, coverage.completedUrls - empty - errors - noindex);
  return [
    { metric: "crawl_urls", day, value: coverage.totalUrls ?? coverage.completedUrls },
    { metric: "crawl_empty_shells", day, value: empty },
    { metric: "crawl_http_errors", day, value: errors },
    { metric: "crawl_noindex", day, value: noindex },
    { metric: "site_health", day, value: Math.round((healthy / coverage.completedUrls) * 1000) / 10 },
  ];
}
```

In `packages/db/src/index.ts`, replace the body of `saveAnalysisReport` with:

```ts
  const completedAt = new Date().toISOString();
  await db.prepare("UPDATE analyses SET report_json = ?, summary = ?, status = 'completed', completed_at = ? WHERE id = ?")
    .bind(compactReport(report), summary, completedAt, id).run();
  // Every finished analysis adds a site-health point to Results.
  const points = analysisHealthPoints(report, completedAt.slice(0, 10));
  const site = points.length ? await db.prepare("SELECT site_id FROM analyses WHERE id = ?").bind(id).first<{ site_id: string }>() : null;
  if (site) await upsertMetricPoints(db, site.site_id, points);
```

and add `import { analysisHealthPoints, upsertMetricPoints } from "./metrics.js";` with the other imports.

- [ ] **Step 4: Run the db suite**

Run: `npm test -w @organic-growth/db 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/metrics.ts packages/db/src/index.ts packages/db/src/metrics.test.ts
git commit -m "Record site health in the Results ledger after every analysis"
```

---

### Task 4: Windows, weeks, and the Results view shape

**Files:**
- Create: `packages/core/src/results.ts`, `packages/core/src/results.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `addDays(day: string, n: number): string`; `weekStart(day: string): string` (Monday).
  - `type DayValue = { day: string; value: number }`.
  - `weekly(series: DayValue[], from: string, to: string, complete: string): Array<{ week: string; value: number | null; partial: boolean }>`.
  - `type Compare = { current: number | null; before: number | null; previous: number | null }`.
  - `RESULT_METRICS: string[]` (every metric the view reads).
  - `type ResultsInput` and `type ResultsView` (below), `resultsView(input: ResultsInput): ResultsView`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/results.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, resultsView, weekStart, weekly, type ResultsInput } from "./results.js";

const days = (from: string, count: number, value: (index: number) => number) =>
  Array.from({ length: count }, (_, index) => ({ day: addDays(from, index), value: value(index) }));

const base = (overrides: Partial<ResultsInput> = {}): ResultsInput => ({
  today: "2026-10-07", goLive: null, markets: [], series: {}, index: { indexed: 0, notIndexed: 0, unchecked: 0 },
  published: 0, searchConnected: true, ga4Connected: false, ...overrides,
});

describe("results math", () => {
  it("counts days and weeks from Monday", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(weekStart("2026-10-07"), "2026-10-05");
    assert.equal(weekStart("2026-10-05"), "2026-10-05");
    assert.equal(weekStart("2026-10-04"), "2026-09-28");
  });

  it("leaves empty weeks empty and marks weeks after the last complete day as partial", () => {
    const series = [{ day: "2026-09-14", value: 3 }, { day: "2026-09-15", value: 4 }, { day: "2026-10-05", value: 1 }];
    assert.deepEqual(weekly(series, "2026-09-14", "2026-10-07", "2026-10-04"), [
      { week: "2026-09-14", value: 7, partial: false },
      { week: "2026-09-21", value: null, partial: false },
      { week: "2026-09-28", value: null, partial: false },
      { week: "2026-10-05", value: 1, partial: true },
    ]);
  });

  it("compares with the 28 days before go-live, and with the previous 28 days without one", () => {
    const clicks = days("2026-06-01", 128, (index) => (index < 60 ? 1 : 3));
    const live = resultsView(base({ goLive: "2026-07-31", published: 10, series: { search_clicks: clicks } }));
    assert.equal(live.numbers.clicks.current, 84, "28 days ending three days ago, at 3 a day");
    assert.equal(live.numbers.clicks.before, 28, "28 days before go-live, at 1 a day");
    const noGoLive = resultsView(base({ series: { search_clicks: clicks } }));
    assert.equal(noGoLive.goLive, null);
    assert.equal(noGoLive.numbers.clicks.before, null, "nothing reads 'before Eumon' without a go-live");
    assert.equal(noGoLive.numbers.clicks.previous, 84);
  });

  it("derives CTR and position from summed parts, and leaves missing data null", () => {
    const view = resultsView(base({ series: {
      search_clicks: days("2026-09-01", 40, () => 2),
      search_impressions: days("2026-09-01", 40, () => 100),
      search_position_weight: days("2026-09-01", 40, () => 800),
    } }));
    assert.equal(view.search?.ctr.current, 0.02);
    assert.equal(view.search?.position.current, 8);
    assert.equal(view.numbers.leads.current, null, "no lead points is 'collecting', not 0");
    assert.equal(view.numbers.organicSessions, null, "GA4 not connected");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/core && npx tsc -p tsconfig.test.json; node --test dist-test/results.test.js`
Expected: cannot find module `./results.js`.

- [ ] **Step 3: Implement**

`packages/core/src/results.ts`:

```ts
/*
 * Results math: windows, weeks, and comparisons over ledger series. Pure, so
 * the API, the client link, and the tests all compute the same numbers.
 */

export type DayValue = { day: string; value: number };
export type Compare = { current: number | null; before: number | null; previous: number | null };
type Range = [string, string];

export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** The Monday on or before `day`; weeks run Monday to Sunday. */
export function weekStart(day: string): string {
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
}

/** Sum of points inside a range, or null when the range has no points at all. */
function sum(series: DayValue[] | undefined, [from, to]: Range): number | null {
  const inside = (series ?? []).filter((point) => point.day >= from && point.day <= to);
  return inside.length ? inside.reduce((total, point) => total + point.value, 0) : null;
}

/** The latest point on or before a day (for snapshot metrics). */
function latest(series: DayValue[] | undefined, to: string): number | null {
  const points = (series ?? []).filter((point) => point.day <= to);
  return points.length ? points[points.length - 1]!.value : null;
}

/** Weekly sums from the week of `from` to the week of `to`; weeks ending after `complete` are partial. */
export function weekly(series: DayValue[] | undefined, from: string, to: string, complete: string) {
  const sums = new Map<string, number>();
  for (const point of series ?? []) {
    if (point.day < from || point.day > to) continue;
    const week = weekStart(point.day);
    sums.set(week, (sums.get(week) ?? 0) + point.value);
  }
  const weeks: Array<{ week: string; value: number | null; partial: boolean }> = [];
  for (let week = weekStart(from); week <= to; week = addDays(week, 7)) {
    weeks.push({ week, value: sums.get(week) ?? null, partial: addDays(week, 6) > complete });
  }
  return weeks;
}

/** The current, previous, and before-go-live 28-day windows, ending `lag` days before today. */
function windows(today: string, goLive: string | null, lag: number) {
  const end = addDays(today, -lag);
  return {
    current: [addDays(end, -27), end] as Range,
    previous: [addDays(end, -55), addDays(end, -28)] as Range,
    before: goLive ? [addDays(goLive, -28), addDays(goLive, -1)] as Range : null,
  };
}

function compare(series: DayValue[] | undefined, w: ReturnType<typeof windows>): Compare {
  return { current: sum(series, w.current), previous: sum(series, w.previous), before: w.before ? sum(series, w.before) : null };
}

function ratio(top: DayValue[] | undefined, bottom: DayValue[] | undefined, w: ReturnType<typeof windows>): Compare {
  const one = (range: Range | null) => {
    if (!range) return null;
    const a = sum(top, range);
    const b = sum(bottom, range);
    return a === null || !b ? null : a / b;
  };
  return { current: one(w.current), previous: one(w.previous), before: one(w.before) };
}

export const RANK_BUCKETS = [3, 10, 20, 100] as const;
const SEARCH = ["search_clicks", "search_impressions", "search_position_weight"];
const BUCKET_METRICS = RANK_BUCKETS.flatMap((n) => [`queries_top${n}`, `queries_top${n}.new`, `queries_top${n}.lost`]);

/** Every metric the Results view reads. */
export const RESULT_METRICS = [
  ...SEARCH, ...SEARCH.map((metric) => `${metric}@markets`), ...SEARCH.map((metric) => `eumon_${metric}`),
  ...BUCKET_METRICS, ...BUCKET_METRICS.map((metric) => `${metric}@markets`),
  "leads", "leads_eumon", "googlebot_fetches", "eumon_page_views", "eumon_cta_clicks", "published_pages",
  "ga4_sessions", "ga4_organic_sessions", "ga4_organic_engaged_sessions", "ga4_organic_key_events",
  "site_health", "crawl_urls", "crawl_empty_shells", "crawl_http_errors", "crawl_noindex",
];

export type ResultsInput = {
  today: string;
  goLive: string | null;
  /** Target-market country codes; when set, section 1 uses the `@markets` series. */
  markets: string[];
  series: Record<string, DayValue[]>;
  index: { indexed: number; notIndexed: number; unchecked: number };
  published: number;
  searchConnected: boolean;
  ga4Connected: boolean;
};

export type ResultsView = {
  today: string;
  goLive: string | null;
  /** The last day Search Console has reported. */
  searchThrough: string | null;
  markets: string[];
  headline: Array<{ week: string; site: number | null; eumon: number | null; partial: boolean }>;
  numbers: {
    clicks: Compare;
    leads: Compare;
    organicSessions: Compare | null;
    pages: { live: number; indexed: number; notIndexed: number; unchecked: number };
  };
  search: {
    weeks: Array<{ week: string; clicks: number | null; impressions: number | null; partial: boolean }>;
    clicksAllCountries: Compare | null;
    ctr: Compare;
    position: Compare;
    buckets: Array<{ top: number; queries: number | null; added: number | null; lost: number | null }>;
  } | null;
  organic: Array<{ week: string; sessions: number | null; keyEvents: number | null; partial: boolean }> | null;
  leads: {
    weeks: Array<{ week: string; eumon: number | null; other: number | null; partial: boolean }>;
    funnel: Array<{ label: string; value: number }> | null;
  };
  health: { value: number | null; day: string | null };
};

const HISTORY_DAYS = 486;

export function resultsView(input: ResultsInput): ResultsView {
  const { series, today, goLive } = input;
  const from = addDays(today, -HISTORY_DAYS);
  const google = windows(today, goLive, 3);
  const firstParty = windows(today, goLive, 1);
  const googleComplete = addDays(today, -3);
  const scoped = (metric: string) => (input.markets.length && series[`${metric}@markets`]?.length ? `${metric}@markets` : metric);
  const searchThrough = series.search_clicks?.length ? series.search_clicks[series.search_clicks.length - 1]!.day : null;

  const siteWeeks = weekly(series.search_clicks, from, today, googleComplete);
  const eumonWeeks = weekly(series.eumon_search_clicks, from, today, googleComplete);
  const headline = siteWeeks.map((week, index) => ({
    week: week.week, site: week.value, partial: week.partial,
    eumon: goLive && addDays(week.week, 6) >= goLive ? eumonWeeks[index]!.value : null,
  }));

  const hasSearch = Boolean(series.search_clicks?.length);
  const clicksMetric = scoped("search_clicks");
  const search = hasSearch ? {
    weeks: weekly(series[clicksMetric], from, today, googleComplete).map((week, index, all) => ({
      week: week.week, clicks: week.value, partial: all[index]!.partial,
      impressions: weekly(series[scoped("search_impressions")], from, today, googleComplete)[index]!.value,
    })),
    clicksAllCountries: clicksMetric === "search_clicks" ? null : compare(series.search_clicks, google),
    ctr: ratio(series[clicksMetric], series[scoped("search_impressions")], google),
    position: ratio(series[scoped("search_position_weight")], series[scoped("search_impressions")], google),
    buckets: RANK_BUCKETS.map((top) => ({
      top,
      queries: latest(series[scoped(`queries_top${top}`)], today),
      added: latest(series[scoped(`queries_top${top}.new`)], today),
      lost: latest(series[scoped(`queries_top${top}.lost`)], today),
    })),
  } : null;

  const leadsWeeks = weekly(series.leads, from, today, addDays(today, -1));
  const eumonLeadWeeks = weekly(series.leads_eumon, from, today, addDays(today, -1));
  const sumCurrent = (metric: string) => sum(series[metric], google.current);
  const funnelSteps = [
    { label: "Google impressions", value: sumCurrent("eumon_search_impressions") },
    { label: "Google clicks", value: sumCurrent("eumon_search_clicks") },
    { label: "Page views", value: sumCurrent("eumon_page_views") },
    { label: "CTA clicks", value: sumCurrent("eumon_cta_clicks") },
    { label: "Enquiries", value: sumCurrent("leads_eumon") },
  ];

  const ga4Sessions = weekly(series.ga4_organic_sessions, from, today, googleComplete);
  const ga4Events = weekly(series.ga4_organic_key_events, from, today, googleComplete);

  return {
    today, goLive, searchThrough, markets: input.markets, headline,
    numbers: {
      clicks: compare(series[clicksMetric], google),
      leads: compare(series.leads, firstParty),
      organicSessions: input.ga4Connected && series.ga4_organic_sessions?.length ? compare(series.ga4_organic_sessions, google) : null,
      pages: { live: input.published, ...input.index },
    },
    search,
    organic: input.ga4Connected && series.ga4_organic_sessions?.length
      ? ga4Sessions.map((week, index) => ({ week: week.week, sessions: week.value, keyEvents: ga4Events[index]!.value, partial: week.partial }))
      : null,
    leads: {
      weeks: leadsWeeks.map((week, index) => {
        const eumon = eumonLeadWeeks[index]!.value;
        return { week: week.week, eumon, other: week.value === null ? null : week.value - (eumon ?? 0), partial: week.partial };
      }),
      funnel: funnelSteps[0]!.value ? funnelSteps.map((step) => ({ label: step.label, value: step.value ?? 0 })) : null,
    },
    health: {
      value: latest(series.site_health, today),
      day: series.site_health?.length ? series.site_health[series.site_health.length - 1]!.day : null,
    },
  };
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./results.js";
```

- [ ] **Step 4: Run the core suite**

Run: `npm test -w @organic-growth/core 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/results.ts packages/core/src/results.test.ts packages/core/src/index.ts
git commit -m "Compute Results windows, weeks, and comparisons from ledger series"
```

---

### Task 5: Google rows into ledger points, and ranking buckets

**Files:**
- Create: `packages/agents/src/results-points.ts`, `packages/agents/src/results-points.test.ts`
- Modify: `packages/agents/src/index.ts` (export)

**Interfaces:**
- Consumes: `MetricPoint` from `@organic-growth/db` (Task 1); `RANK_BUCKETS` from `@organic-growth/core` (Task 4).
- Produces: `type SearchDay = { day: string; clicks: number; impressions: number; positionWeight: number }`; `searchDayPoints(rows: SearchDay[], prefix?: string, suffix?: string): MetricPoint[]` (sums rows of the same day, so per-country rows merge); `type QueryPosition = { query: string; position: number; impressions: number }`; `mergePositions(rows: QueryPosition[]): QueryPosition[]` (impression-weighted per query); `rankingPoints(current: QueryPosition[], previous: QueryPosition[], day: string, suffix?: string): MetricPoint[]`.

- [ ] **Step 1: Write the failing test**

`packages/agents/src/results-points.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePositions, rankingPoints, searchDayPoints } from "./results-points.js";

describe("results points", () => {
  it("sums rows of the same day, so per-country fetches merge", () => {
    const points = searchDayPoints([
      { day: "2026-10-01", clicks: 2, impressions: 100, positionWeight: 800 },
      { day: "2026-10-01", clicks: 1, impressions: 50, positionWeight: 300 },
    ], "", "@markets");
    assert.deepEqual(points, [
      { metric: "search_clicks@markets", day: "2026-10-01", value: 3 },
      { metric: "search_impressions@markets", day: "2026-10-01", value: 150 },
      { metric: "search_position_weight@markets", day: "2026-10-01", value: 1100 },
    ]);
    assert.equal(searchDayPoints([{ day: "2026-10-01", clicks: 1, impressions: 1, positionWeight: 1 }], "eumon_")[0]!.metric, "eumon_search_clicks");
  });

  it("weights a query's position by impressions across countries", () => {
    assert.deepEqual(mergePositions([{ query: "q", position: 2, impressions: 300 }, { query: "q", position: 10, impressions: 100 }]), [{ query: "q", position: 4, impressions: 400 }]);
  });

  it("counts queries in each bucket and the ones that entered or left it", () => {
    const current = [{ query: "a", position: 2, impressions: 10 }, { query: "b", position: 8, impressions: 10 }, { query: "c", position: 30, impressions: 10 }];
    const previous = [{ query: "a", position: 5, impressions: 10 }, { query: "d", position: 9, impressions: 10 }];
    const points = Object.fromEntries(rankingPoints(current, previous, "2026-10-05").map((point) => [point.metric, point.value]));
    assert.equal(points["queries_top3"], 1);
    assert.equal(points["queries_top3.new"], 1, "a moved into the top 3");
    assert.equal(points["queries_top10"], 2);
    assert.equal(points["queries_top10.new"], 1, "b is new; a was already in the top 10");
    assert.equal(points["queries_top10.lost"], 1, "d left");
    assert.equal(points["queries_top100"], 3);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/agents && npx tsc -p tsconfig.test.json; node --test dist-test/results-points.test.js`
Expected: cannot find module `./results-points.js`.

- [ ] **Step 3: Implement**

`packages/agents/src/results-points.ts`:

```ts
import { RANK_BUCKETS } from "@organic-growth/core";
import type { MetricPoint } from "@organic-growth/db";

export type SearchDay = { day: string; clicks: number; impressions: number; positionWeight: number };
export type QueryPosition = { query: string; position: number; impressions: number };

/** Daily Search Console totals as ledger points; rows for the same day (one per country) are summed. */
export function searchDayPoints(rows: SearchDay[], prefix = "", suffix = ""): MetricPoint[] {
  const days = new Map<string, SearchDay>();
  for (const row of rows) {
    const day = days.get(row.day) ?? { day: row.day, clicks: 0, impressions: 0, positionWeight: 0 };
    day.clicks += row.clicks;
    day.impressions += row.impressions;
    day.positionWeight += row.positionWeight;
    days.set(row.day, day);
  }
  return [...days.values()].flatMap((day) => [
    { metric: `${prefix}search_clicks${suffix}`, day: day.day, value: day.clicks },
    { metric: `${prefix}search_impressions${suffix}`, day: day.day, value: day.impressions },
    { metric: `${prefix}search_position_weight${suffix}`, day: day.day, value: day.positionWeight },
  ]);
}

/** One row per query, its position weighted by impressions (for queries fetched per country). */
export function mergePositions(rows: QueryPosition[]): QueryPosition[] {
  const merged = new Map<string, { weight: number; impressions: number }>();
  for (const row of rows) {
    const entry = merged.get(row.query) ?? { weight: 0, impressions: 0 };
    entry.weight += row.position * row.impressions;
    entry.impressions += row.impressions;
    merged.set(row.query, entry);
  }
  return [...merged].map(([query, entry]) => ({ query, position: entry.impressions ? entry.weight / entry.impressions : 0, impressions: entry.impressions }));
}

/** Queries in each top-N bucket now, and how many entered or left it since the previous window. */
export function rankingPoints(current: QueryPosition[], previous: QueryPosition[], day: string, suffix = ""): MetricPoint[] {
  return RANK_BUCKETS.flatMap((top) => {
    const now = new Set(current.filter((row) => row.position <= top).map((row) => row.query));
    const before = new Set(previous.filter((row) => row.position <= top).map((row) => row.query));
    return [
      { metric: `queries_top${top}${suffix}`, day, value: now.size },
      { metric: `queries_top${top}.new${suffix}`, day, value: [...now].filter((query) => !before.has(query)).length },
      { metric: `queries_top${top}.lost${suffix}`, day, value: [...before].filter((query) => !now.has(query)).length },
    ];
  });
}
```

Add to `packages/agents/src/index.ts`:

```ts
export * from "./results-points.js";
```

- [ ] **Step 4: Run the agents suite**

Run: `npm run build -w @organic-growth/core -w @organic-growth/db && npm test -w @organic-growth/agents 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/results-points.ts packages/agents/src/results-points.test.ts packages/agents/src/index.ts
git commit -m "Turn Search Console rows into Results points and ranking buckets"
```

---

### Task 6: Google API clients

**Files:**
- Modify: `packages/agents/src/google-search-console.ts`
- Create: `packages/agents/src/google-analytics.ts`, `packages/agents/src/google-clients.test.ts`
- Modify: `packages/agents/src/index.ts` (export `google-analytics.js`)

**Interfaces:**
- Consumes: `SearchDay`, `QueryPosition` (Task 5).
- Produces:
  - `fetchSearchDaily(token, property, options: { startDate: string; endDate: string; pageContains?: string; country?: string }, fetchFn?: typeof fetch): Promise<SearchDay[]>`.
  - `fetchQueryPositions(token, property, options: { startDate: string; endDate: string; country?: string }, fetchFn?): Promise<QueryPosition[]>`.
  - `type IndexInspection = { verdict: string; coverageState: string | null; lastCrawlTime: string | null }`; `inspectUrl(token, property, url, fetchFn?): Promise<IndexInspection>`; `inspectionResult(json: unknown): IndexInspection`.
  - `listGa4Properties(token, fetchFn?): Promise<Array<{ property: string; name: string }>>`.
  - `type Ga4Day = { day: string; sessions: number; organicSessions: number; organicEngagedSessions: number; organicKeyEvents: number }`; `fetchGa4Daily(token, property, startDate, endDate, fetchFn?): Promise<Ga4Day[]>`; `ga4Days(json: unknown): Ga4Day[]`.

- [ ] **Step 1: Write the failing test**

`packages/agents/src/google-clients.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchSearchDaily, ga4Days, inspectionResult, listGa4Properties } from "./index.js";

/** A fetch that records requests and answers with a fixed JSON body. */
function recorded(body: unknown) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe("Google clients", () => {
  it("asks Search Console for daily rows, filtered by page and country, and keeps position as a weight", async () => {
    const { fetchFn, requests } = recorded({ rows: [{ keys: ["2026-10-01"], clicks: 3, impressions: 100, ctr: 0.03, position: 7.5 }] });
    const rows = await fetchSearchDaily("t", "sc-domain:x.com", { startDate: "2026-09-01", endDate: "2026-10-06", pageContains: "https://x.com/guides/", country: "mys" }, fetchFn);
    assert.deepEqual(rows, [{ day: "2026-10-01", clicks: 3, impressions: 100, positionWeight: 750 }]);
    const sent = requests[0]!.body as { dimensions: string[]; dataState: string; dimensionFilterGroups: Array<{ filters: Array<{ dimension: string; expression: string }> }> };
    assert.deepEqual(sent.dimensions, ["date"]);
    assert.equal(sent.dataState, "all", "fresh days are included and overwritten later");
    assert.deepEqual(sent.dimensionFilterGroups[0]!.filters.map((filter) => [filter.dimension, filter.expression]), [["page", "https://x.com/guides/"], ["country", "mys"]]);
  });

  it("reads an inspection verdict, and treats a missing index result as not checked", () => {
    assert.deepEqual(inspectionResult({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T03:00:00Z" } } }),
      { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T03:00:00Z" });
    assert.deepEqual(inspectionResult({}), { verdict: "VERDICT_UNSPECIFIED", coverageState: null, lastCrawlTime: null });
  });

  it("lists GA4 properties with their account, and folds a report into days", async () => {
    const { fetchFn } = recorded({ accountSummaries: [{ displayName: "Clinic", propertySummaries: [{ property: "properties/9", displayName: "Website" }] }] });
    assert.deepEqual(await listGa4Properties("t", fetchFn), [{ property: "properties/9", name: "Clinic · Website" }]);
    const report = { rows: [
      { dimensionValues: [{ value: "20261001" }, { value: "Organic Search" }], metricValues: [{ value: "40" }, { value: "30" }, { value: "4" }] },
      { dimensionValues: [{ value: "20261001" }, { value: "Direct" }], metricValues: [{ value: "60" }, { value: "20" }, { value: "2" }] },
    ] };
    assert.deepEqual(ga4Days(report), [{ day: "2026-10-01", sessions: 100, organicSessions: 40, organicEngagedSessions: 30, organicKeyEvents: 4 }]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/agents && npx tsc -p tsconfig.test.json; node --test dist-test/google-clients.test.js`
Expected: compile errors for the missing exports.

- [ ] **Step 3: Implement**

In `packages/agents/src/google-search-console.ts`, extend `QueryOptions` and `querySearchAnalytics`:

```ts
type QueryOptions = {
  dimensions: Array<"page" | "query" | "date" | "country" | "device">;
  startDate: string;
  endDate: string;
  /** Restrict to page URLs containing this text (e.g. `https://example.com/guides/`). */
  pageContains?: string;
  /** Restrict to one country (Search Console's lowercase ISO 3166-1 alpha-3 code). */
  country?: string;
  maxRows: number;
  dataState?: "final" | "all";
};

/** Pages through searchAnalytics.query up to `maxRows`. */
async function querySearchAnalytics(accessToken: string, property: string, options: QueryOptions, fetchFn: typeof fetch = fetch) {
  const rows: NonNullable<SearchAnalyticsResponse["rows"]> = [];
  const pageSize = Math.min(25_000, options.maxRows);
  const filters = [
    ...(options.pageContains ? [{ dimension: "page", operator: "contains", expression: options.pageContains }] : []),
    ...(options.country ? [{ dimension: "country", operator: "equals", expression: options.country }] : []),
  ];
  for (let startRow = 0; startRow < options.maxRows; startRow += pageSize) {
    const response = await fetchFn(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: options.startDate,
          endDate: options.endDate,
          dimensions: options.dimensions,
          rowLimit: pageSize,
          startRow,
          dataState: options.dataState ?? "final",
          ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}),
        }),
      },
    );
    if (!response.ok) throw new Error(`Search Console metrics request failed (${response.status}).`);
    const batch = ((await response.json()) as SearchAnalyticsResponse).rows ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}
```

Append to the same file (and add `import type { QueryPosition, SearchDay } from "./results-points.js";` at the top):

```ts
/** Daily clicks, impressions, and position × impressions; fresh days included (later syncs overwrite them). */
export async function fetchSearchDaily(
  accessToken: string, property: string,
  options: { startDate: string; endDate: string; pageContains?: string; country?: string },
  fetchFn: typeof fetch = fetch,
): Promise<SearchDay[]> {
  const rows = await querySearchAnalytics(accessToken, property, { ...options, dimensions: ["date"], maxRows: 1_000, dataState: "all" }, fetchFn);
  return rows.map((row) => ({ day: row.keys[0] ?? "", clicks: row.clicks, impressions: row.impressions, positionWeight: row.position * row.impressions }));
}

/** Each query's average position and impressions over a finalized window. */
export async function fetchQueryPositions(
  accessToken: string, property: string,
  options: { startDate: string; endDate: string; country?: string },
  fetchFn: typeof fetch = fetch,
): Promise<QueryPosition[]> {
  const rows = await querySearchAnalytics(accessToken, property, { ...options, dimensions: ["query"], maxRows: 25_000 }, fetchFn);
  return rows.map((row) => ({ query: row.keys[0] ?? "", position: row.position, impressions: row.impressions }));
}

export type IndexInspection = { verdict: string; coverageState: string | null; lastCrawlTime: string | null };

export function inspectionResult(json: unknown): IndexInspection {
  const status = (json as { inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string } } })?.inspectionResult?.indexStatusResult;
  return { verdict: status?.verdict ?? "VERDICT_UNSPECIFIED", coverageState: status?.coverageState ?? null, lastCrawlTime: status?.lastCrawlTime ?? null };
}

/** Google's index status for one URL of a Search Console property (2,000 inspections a day per property). */
export async function inspectUrl(accessToken: string, property: string, url: string, fetchFn: typeof fetch = fetch): Promise<IndexInspection> {
  const response = await fetchFn("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: property }),
  });
  if (!response.ok) throw new Error(`URL Inspection request failed (${response.status}).`);
  return inspectionResult(await response.json());
}
```

Create `packages/agents/src/google-analytics.ts`:

```ts
/*
 * Google Analytics 4: the properties a Google connection can read, and daily
 * sessions with the Organic Search share, for the Results ledger.
 */

export type Ga4Day = { day: string; sessions: number; organicSessions: number; organicEngagedSessions: number; organicKeyEvents: number };

export async function listGa4Properties(accessToken: string, fetchFn: typeof fetch = fetch): Promise<Array<{ property: string; name: string }>> {
  const response = await fetchFn("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google Analytics properties request failed (${response.status}).`);
  const json = await response.json() as { accountSummaries?: Array<{ displayName?: string; propertySummaries?: Array<{ property: string; displayName?: string }> }> };
  return (json.accountSummaries ?? []).flatMap((account) => (account.propertySummaries ?? []).map((summary) => ({
    property: summary.property,
    name: `${account.displayName ?? "Account"} · ${summary.displayName ?? summary.property}`,
  })));
}

/** Folds a `date` × `sessionDefaultChannelGroup` report into one row per day. */
export function ga4Days(json: unknown): Ga4Day[] {
  const rows = (json as { rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }> })?.rows ?? [];
  const days = new Map<string, Ga4Day>();
  for (const row of rows) {
    const raw = row.dimensionValues[0]?.value ?? "";
    const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const entry = days.get(day) ?? { day, sessions: 0, organicSessions: 0, organicEngagedSessions: 0, organicKeyEvents: 0 };
    const [sessions, engaged, keyEvents] = row.metricValues.map((metric) => Number(metric.value) || 0);
    entry.sessions += sessions ?? 0;
    if (row.dimensionValues[1]?.value === "Organic Search") {
      entry.organicSessions += sessions ?? 0;
      entry.organicEngagedSessions += engaged ?? 0;
      entry.organicKeyEvents += keyEvents ?? 0;
    }
    days.set(day, entry);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export async function fetchGa4Daily(accessToken: string, property: string, startDate: string, endDate: string, fetchFn: typeof fetch = fetch): Promise<Ga4Day[]> {
  const response = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }],
      limit: 100_000,
    }),
  });
  if (!response.ok) throw new Error(`Google Analytics report request failed (${response.status}).`);
  return ga4Days(await response.json());
}
```

Add to `packages/agents/src/index.ts`:

```ts
export * from "./google-analytics.js";
```

- [ ] **Step 4: Run the agents suite**

Run: `npm test -w @organic-growth/agents 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/google-search-console.ts packages/agents/src/google-analytics.ts packages/agents/src/google-clients.test.ts packages/agents/src/index.ts
git commit -m "Add Search Console daily, query, and URL Inspection clients, and GA4"
```

---

### Task 7: Index status storage and the sync's site list

**Files:**
- Modify: `packages/db/src/metrics.ts`, `packages/db/src/metrics.test.ts`

**Interfaces:**
- Produces: `pagesToInspect(db, siteId, limit): Promise<Array<{ pageId: string; path: string }>>` (never-checked first, then oldest check); `saveIndexStatus(db, siteId, rows: Array<{ pageId: string; verdict: string; coverageState: string | null; lastCrawlTime: string | null }>)`; `indexStatusCounts(db, siteId): Promise<{ indexed: number; notIndexed: number; unchecked: number }>`; `listSitesForResults(db): Promise<string[]>` (sites with a Search Console property, a GA4 property, or a published page).

- [ ] **Step 1: Write the failing test** (append; add the four names to the import)

```ts
describe("index status", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  await upsertSite(db, { id: "idle", name: "y.com", baseUrl: "https://y.com", createdAt: now, updatedAt: now });
  await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at)
    VALUES ('d', 's', 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(now, now).run();
  await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'T', '{}', 'active', ?, ?)`).bind(now, now).run();
  for (const slug of ["a", "b", "c"]) {
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES (?, 's', 't', ?, ?, ?, '', '{}', 1, '[]', 'published', ?, ?, ?)`).bind(`p_${slug}`, `/guides/${slug}`, slug, slug, now, now, now).run();
  }

  it("inspects never-checked pages first and counts unchecked pages apart from not indexed", async () => {
    await saveIndexStatus(db, "s", [{ pageId: "p_a", verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: null }]);
    assert.deepEqual((await pagesToInspect(db, "s", 2)).map((page) => page.path), ["/guides/b", "/guides/c"]);
    await saveIndexStatus(db, "s", [{ pageId: "p_b", verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed", lastCrawlTime: null }]);
    assert.deepEqual(await indexStatusCounts(db, "s"), { indexed: 1, notIndexed: 1, unchecked: 1 });
  });

  it("syncs only sites with something to sync", async () => {
    assert.deepEqual(await listSitesForResults(db), ["s"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/db && npx tsc -p tsconfig.test.json; node --disable-warning=ExperimentalWarning --test dist-test/metrics.test.js`
Expected: compile errors for the missing exports.

- [ ] **Step 3: Implement** (append to `packages/db/src/metrics.ts`)

```ts
/** Published Eumon pages to inspect next: never checked first, then the oldest check. */
export async function pagesToInspect(db: D1Like, siteId: string, limit: number): Promise<Array<{ pageId: string; path: string }>> {
  const { results } = await db.prepare(
    `SELECT g.id, g.path FROM generated_pages g LEFT JOIN page_index_status s ON s.page_id = g.id
     WHERE g.site_id = ? AND g.status = 'published'
     ORDER BY s.checked_at IS NOT NULL, s.checked_at, g.path LIMIT ?`,
  ).bind(siteId, limit).all<{ id: string; path: string }>();
  return results.map((row) => ({ pageId: row.id, path: row.path }));
}

export async function saveIndexStatus(
  db: D1Like, siteId: string,
  rows: Array<{ pageId: string; verdict: string; coverageState: string | null; lastCrawlTime: string | null }>,
): Promise<void> {
  const checkedAt = nowIso();
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO page_index_status (page_id, site_id, verdict, coverage_state, last_crawl_time, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET verdict = excluded.verdict, coverage_state = excluded.coverage_state,
       last_crawl_time = excluded.last_crawl_time, checked_at = excluded.checked_at`,
  ).bind(row.pageId, siteId, row.verdict, row.coverageState, row.lastCrawlTime, checkedAt));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Published pages by their latest inspection: indexed (PASS), not indexed (any other verdict), never checked. */
export async function indexStatusCounts(db: D1Like, siteId: string): Promise<{ indexed: number; notIndexed: number; unchecked: number }> {
  const row = await db.prepare(
    `SELECT SUM(CASE WHEN s.verdict = 'PASS' THEN 1 ELSE 0 END) AS indexed,
            SUM(CASE WHEN s.verdict IS NOT NULL AND s.verdict != 'PASS' THEN 1 ELSE 0 END) AS not_indexed,
            SUM(CASE WHEN s.verdict IS NULL THEN 1 ELSE 0 END) AS unchecked
     FROM generated_pages g LEFT JOIN page_index_status s ON s.page_id = g.id
     WHERE g.site_id = ? AND g.status = 'published'`,
  ).bind(siteId).first<{ indexed: number | null; not_indexed: number | null; unchecked: number | null }>();
  return { indexed: Number(row?.indexed ?? 0), notIndexed: Number(row?.not_indexed ?? 0), unchecked: Number(row?.unchecked ?? 0) };
}

/** Sites the daily Results sync covers. */
export async function listSitesForResults(db: D1Like): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT id FROM sites WHERE gsc_property IS NOT NULL OR ga4_property IS NOT NULL
       OR id IN (SELECT site_id FROM generated_pages WHERE status = 'published') ORDER BY id`,
  ).all<{ id: string }>();
  return results.map((row) => row.id);
}
```

- [ ] **Step 4: Run the db suite**

Run: `npm test -w @organic-growth/db 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/metrics.ts packages/db/src/metrics.test.ts
git commit -m "Store index status per Eumon page and list the sites Results syncs"
```

---

### Task 8: Google Analytics in Connections

**Files:**
- Modify: `apps/web/src/gsc-auth.ts`, `apps/web/app/api/sites/[siteId]/gsc/connect/route.ts`, `apps/web/app/api/google/callback/route.ts`, `apps/web/app/components/ConnectionsView.tsx`
- Create: `apps/web/app/api/sites/[siteId]/ga4/properties/route.ts`

**Interfaces:**
- Consumes: `updateSiteGa4Property` (Task 1), `listGa4Properties` (Task 6).
- Produces: `saveGoogleRefreshToken(db, siteId, refreshToken, encryptionKey, scopes: string)`; `googleScopes(db, siteId): Promise<string[]>`; `ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"`; `GET /api/sites/:id/ga4/properties` → `{ properties: Array<{ property, name }>, selected: string | null, needsReconnect: boolean }`; `POST` `{ property: string | null }`.

- [ ] **Step 1: Store and read the granted scopes**

In `apps/web/src/gsc-auth.ts` replace `saveGoogleRefreshToken` and add the scope helpers:

```ts
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/** `scopes` is Google's space-separated grant, so later code can tell which APIs this connection may call. */
export async function saveGoogleRefreshToken(db: D1Like, siteId: string, refreshToken: string, encryptionKey: string, scopes: string) {
  await upsertOAuthCredential(db, {
    id: createId("oauth"), siteId, provider: "google_search_console",
    encryptedBlob: await encryptSecret(refreshToken, encryptionKey), scopes,
  });
}

/** Scopes the site's Google connection was granted; connections made before scopes were stored read as Search Console only. */
export async function googleScopes(db: D1Like, siteId: string): Promise<string[]> {
  const credential = await getOAuthCredential(db, siteId, "google_search_console");
  if (!credential) return [];
  return (credential.scopes ?? "").split(/\s+/).filter(Boolean).map((scope) => (scope === "webmasters.readonly" ? SEARCH_CONSOLE_SCOPE : scope));
}
```

- [ ] **Step 2: Ask for Analytics when connecting, and record what was granted**

In `apps/web/app/api/sites/[siteId]/gsc/connect/route.ts` change the scope line to:

```ts
    scope: `${SEARCH_CONSOLE_SCOPE} ${ANALYTICS_SCOPE}`,
```

with `import { ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE } from "../../../../../../src/gsc-auth";`.

In `apps/web/app/api/google/callback/route.ts` change the token type and the save call:

```ts
  const token = await response.json() as { refresh_token?: string; scope?: string };
  if (!token.refresh_token) return Response.redirect(new URL("/?gsc=reauthorize", url.origin), 303);
  try {
    await saveGoogleRefreshToken(env.DB, siteId, token.refresh_token, env.OAUTH_ENCRYPTION_KEY, token.scope ?? "webmasters.readonly");
```

- [ ] **Step 3: Add the GA4 properties route**

`apps/web/app/api/sites/[siteId]/ga4/properties/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { listGa4Properties } from "@organic-growth/agents";
import { getSite, updateSiteGa4Property } from "@organic-growth/db";
import { ANALYTICS_SCOPE, googleAccessToken, googleScopes } from "../../../../../../src/gsc-auth";
import { fail, json, readJson } from "../../../../../../src/server";

/** GA4 properties the site's Google connection can read; `needsReconnect` when it was granted before Analytics was requested. */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const scopes = await googleScopes(env.DB, siteId);
  if (!scopes.length) return json({ properties: [], selected: site.ga4Property ?? null, needsReconnect: false, connected: false });
  if (!scopes.includes(ANALYTICS_SCOPE)) return json({ properties: [], selected: site.ga4Property ?? null, needsReconnect: true, connected: true });
  const token = await googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
  return json({ properties: await listGa4Properties(token), selected: site.ga4Property ?? null, needsReconnect: false, connected: true });
}

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  const property = (await readJson<{ property?: unknown }>(request))?.property;
  if (property !== null && (typeof property !== "string" || !/^properties\/\d+$/.test(property))) return fail("Choose a GA4 property.");
  await updateSiteGa4Property(env.DB, siteId, property);
  return json({ property });
}
```

- [ ] **Step 4: Add the GA4 row to Connections**

In `apps/web/app/components/ConnectionsView.tsx`, add state beside the Search Console state:

```tsx
  const [ga4, setGa4] = useState<{ properties: Array<{ property: string; name: string }>; selected: string | null; needsReconnect: boolean; connected: boolean } | null>(null);
  const [ga4Message, setGa4Message] = useState("");
```

load it in the existing `useEffect`:

```tsx
    api<{ properties: Array<{ property: string; name: string }>; selected: string | null; needsReconnect: boolean; connected: boolean }>(`/api/sites/${site.id}/ga4/properties`)
      .then(setGa4).catch(() => setGa4(null));
```

add the handler:

```tsx
  async function chooseGa4(property: string) {
    try {
      await api(`/api/sites/${site.id}/ga4/properties`, { method: "POST", json: { property: property || null } });
      setGa4((current) => (current ? { ...current, selected: property || null } : current));
      setGa4Message(property ? "Google Analytics property saved. Results fills in on the next sync." : "Google Analytics disconnected.");
      onSiteChanged({ ...site, ga4Property: property || undefined });
    } catch (cause) { setGa4Message(errorMessage(cause)); }
  }
```

and insert this row immediately before the Target markets row (the `list-row` whose badge reads `markets.length ? "Markets" : "Recommended"`):

```tsx
        <div className="list-row">
          <Badge tone={site.ga4Property ? "green" : "gray"}>{site.ga4Property ? "Analytics" : "Recommended"}</Badge>
          <div className="grow">
            <h3>{ga4?.properties.find((entry) => entry.property === site.ga4Property)?.name ?? site.ga4Property ?? "Google Analytics 4"}</h3>
            <p>Organic sessions and key events, with 16 months of history: the "before Eumon" baseline Results compares against.</p>
            <div className="row" style={{ marginTop: 8 }}>
              {!ga4?.connected || ga4.needsReconnect
                ? <a className="btn btn-secondary btn-small" href={`/api/sites/${site.id}/gsc/connect`}>{ga4?.needsReconnect ? "Reconnect Google to add Analytics" : "Connect Google"}</a>
                : (
                  <select className="select" style={{ maxWidth: 360 }} value={ga4.selected ?? ""} onChange={(event) => void chooseGa4(event.target.value)}>
                    <option value="">Choose a property</option>
                    {ga4.properties.map((entry) => <option key={entry.property} value={entry.property}>{entry.name}</option>)}
                  </select>
                )}
            </div>
            {ga4Message && <p className="small">{ga4Message}</p>}
          </div>
        </div>
```

- [ ] **Step 5: Typecheck and check by hand**

Run: `npm run build:packages >/dev/null && cd apps/web && npx tsc --noEmit -p . 2>&1 | grep "error TS"`
Expected: no output.
Manual: on http://localhost:5174, Connections for medbaycare.com shows "Reconnect Google to add Analytics" (its credential predates the scope). Reconnecting lists GA4 properties; choosing one shows "Google Analytics property saved."

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/gsc-auth.ts "apps/web/app/api/sites/[siteId]/gsc/connect/route.ts" apps/web/app/api/google/callback/route.ts "apps/web/app/api/sites/[siteId]/ga4/properties/route.ts" apps/web/app/components/ConnectionsView.tsx
git commit -m "Connect Google Analytics 4 and remember which Google scopes were granted"
```

---

### Task 9: The daily Results sync

**Files:**
- Create: `apps/web/src/results-sync.ts`, `apps/web/src/results-sync.test.ts`, `apps/web/app/api/sites/[siteId]/results/sync/route.ts`
- Modify: `apps/web/src/search-sync-workflow.ts`, `apps/web/package.json` (test glob)

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6, 7, 8.
- Produces: `syncResults(db, site, now: Date, google: GoogleAccess): Promise<string[]>` where `type GoogleAccess = { token: () => Promise<string>; scopes: string[]; fetchFn?: typeof fetch }`; returns notes such as `"search: 7 days"`, `"search failed: …"`, `"analytics: reconnect Google"`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/results-sync.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listMetricSeries, updateSiteGa4Property, updateSiteGscProperty, upsertSite, getSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE } from "./gsc-auth.ts";
import { syncResults } from "./results-sync.ts";

const now = new Date("2026-10-07T04:15:00Z");

async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now.toISOString(), updatedAt: now.toISOString() });
  await updateSiteGscProperty(db, "s", "sc-domain:x.com");
  await updateSiteGa4Property(db, "s", "properties/9");
  return { db, site: (await getSite(db, "s"))! };
}

describe("results sync", () => {
  it("keeps first-party points when Google access is revoked", async () => {
    const { db, site: record } = await site();
    const notes = await syncResults(db, record, now, { token: async () => { throw new Error("Google access token refresh failed (400)."); }, scopes: [SEARCH_CONSOLE_SCOPE, ANALYTICS_SCOPE] });
    assert.ok(notes.some((note) => note.startsWith("google failed")), notes.join("; "));
    const series = await listMetricSeries(db, "s", ["published_pages"], "2026-10-07", "2026-10-07");
    assert.equal(series.published_pages!.length, 1);
  });

  it("skips GA4 without the Analytics scope, and backfills once", async () => {
    const { db, site: record } = await site();
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.includes("urlInspection") ? {} : { rows: [{ keys: ["2026-10-01"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] }));
    }) as typeof fetch;
    const google = { token: async () => "t", scopes: [SEARCH_CONSOLE_SCOPE], fetchFn };
    const first = await syncResults(db, record, now, google);
    assert.ok(first.includes("analytics: reconnect Google"));
    assert.equal(urls.some((url) => url.includes("analyticsdata")), false);
    assert.ok(first.some((note) => note.startsWith("search: 486 days")), first.join("; "));
    const second = await syncResults(db, record, now, google);
    assert.ok(second.some((note) => note.startsWith("search: 7 days")), second.join("; "));
    assert.deepEqual((await listMetricSeries(db, "s", ["search_clicks"], "2026-10-01", "2026-10-01")).search_clicks, [{ day: "2026-10-01", value: 1 }]);
  });
});
```

In `apps/web/package.json` change the test script to cover `src`:

```json
    "test": "node --test \"app/**/*.test.ts\" \"src/**/*.test.ts\""
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run build:packages >/dev/null && cd apps/web && node --test src/results-sync.test.ts 2>&1 | tail -5`
Expected: cannot find module `./results-sync.ts`.

- [ ] **Step 3: Implement**

`apps/web/src/results-sync.ts` (imports use `.ts` extensions so `node --test` can load it; `allowImportingTsExtensions` is on):

```ts
import type { SiteRecord } from "@organic-growth/core";
import { fetchGa4Daily, fetchQueryPositions, fetchSearchDaily, inspectUrl, mergePositions, rankingPoints, searchDayPoints } from "@organic-growth/agents";
import { addDays } from "@organic-growth/core";
import {
  defaultPageSettings, firstMetricDay, getPageSettings, indexStatusCounts, listSiteMarkets, pagesToInspect,
  saveIndexStatus, syncFirstPartyResults, upsertMetricPoints, type D1Like, type MetricPoint,
} from "@organic-growth/db";
import { ANALYTICS_SCOPE } from "./gsc-auth.ts";

export type GoogleAccess = { token: () => Promise<string>; scopes: string[]; fetchFn?: typeof fetch };

/** Search Console and GA4 history fetched on a site's first sync. */
const BACKFILL_DAYS = 486;
/** URL inspections per site per day (the API allows 2,000 per property). */
const INSPECTIONS_PER_DAY = 100;

/**
 * One site's daily Results sync: first-party points always, then Search
 * Console (daily series, Monday ranking buckets, index status) and GA4.
 * Each Google step fails on its own; the notes say what ran.
 */
export async function syncResults(db: D1Like, site: SiteRecord, now: Date, google: GoogleAccess): Promise<string[]> {
  const notes: string[] = [];
  await syncFirstPartyResults(db, site.id, now);
  if (!site.gscProperty && !site.ga4Property) return notes;
  let token: string;
  try {
    token = await google.token();
  } catch (error) {
    return [...notes, `google failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const today = now.toISOString().slice(0, 10);
  if (site.gscProperty) {
    try {
      notes.push(...await syncSearch(db, site, site.gscProperty, token, today, now, google.fetchFn));
    } catch (error) {
      notes.push(`search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (site.ga4Property) {
    if (!google.scopes.includes(ANALYTICS_SCOPE)) notes.push("analytics: reconnect Google");
    else {
      try {
        const backfill = !(await firstMetricDay(db, site.id, "ga4_sessions"));
        const days = await fetchGa4Daily(token, site.ga4Property, addDays(today, backfill ? -BACKFILL_DAYS : -7), addDays(today, -1), google.fetchFn);
        await upsertMetricPoints(db, site.id, days.flatMap((day) => [
          { metric: "ga4_sessions", day: day.day, value: day.sessions },
          { metric: "ga4_organic_sessions", day: day.day, value: day.organicSessions },
          { metric: "ga4_organic_engaged_sessions", day: day.day, value: day.organicEngagedSessions },
          { metric: "ga4_organic_key_events", day: day.day, value: day.organicKeyEvents },
        ]));
        notes.push(`analytics: ${days.length} days`);
      } catch (error) {
        notes.push(`analytics failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return notes;
}

async function syncSearch(db: D1Like, site: SiteRecord, property: string, token: string, today: string, now: Date, fetchFn?: typeof fetch): Promise<string[]> {
  const backfill = !(await firstMetricDay(db, site.id, "search_clicks"));
  const span = backfill ? BACKFILL_DAYS : 7;
  const range = { startDate: addDays(today, -span), endDate: addDays(today, -1) };
  const settings = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
  const origin = new URL(settings.publicOrigin).origin;
  const markets = await listSiteMarkets(db, site.id);
  const [all, eumon, ...perMarket] = await Promise.all([
    fetchSearchDaily(token, property, range, fetchFn),
    fetchSearchDaily(token, property, { ...range, pageContains: `${origin}${settings.mountPath}/` }, fetchFn),
    ...markets.map((country) => fetchSearchDaily(token, property, { ...range, country }, fetchFn)),
  ]);
  const points: MetricPoint[] = [
    ...searchDayPoints(all),
    ...searchDayPoints(eumon, "eumon_"),
    ...(markets.length ? searchDayPoints(perMarket.flat(), "", "@markets") : []),
  ];

  // Ranking buckets weekly (Mondays), or now if none exist yet; finalized data only.
  if (now.getUTCDay() === 1 || !(await firstMetricDay(db, site.id, "queries_top10"))) {
    const current = { startDate: addDays(today, -9), endDate: addDays(today, -3) };
    const previous = { startDate: addDays(today, -16), endDate: addDays(today, -10) };
    const [now7, before7] = await Promise.all([fetchQueryPositions(token, property, current, fetchFn), fetchQueryPositions(token, property, previous, fetchFn)]);
    points.push(...rankingPoints(now7, before7, today));
    if (markets.length) {
      const scoped = await Promise.all(markets.flatMap((country) => [
        fetchQueryPositions(token, property, { ...current, country }, fetchFn),
        fetchQueryPositions(token, property, { ...previous, country }, fetchFn),
      ]));
      points.push(...rankingPoints(mergePositions(scoped.filter((_, index) => index % 2 === 0).flat()), mergePositions(scoped.filter((_, index) => index % 2 === 1).flat()), today, "@markets"));
    }
  }

  // Index status: a rolling sample of published Eumon pages each day.
  const pages = await pagesToInspect(db, site.id, INSPECTIONS_PER_DAY);
  const inspected = [];
  for (const page of pages) {
    try {
      inspected.push({ pageId: page.pageId, ...await inspectUrl(token, property, `${origin}${page.path}`, fetchFn) });
    } catch {
      // One page's failure (quota, a transient error) leaves it for tomorrow.
    }
  }
  await saveIndexStatus(db, site.id, inspected);
  if (pages.length) {
    const counts = await indexStatusCounts(db, site.id);
    points.push({ metric: "pages_indexed", day: today, value: counts.indexed }, { metric: "pages_not_indexed", day: today, value: counts.notIndexed });
  }
  await upsertMetricPoints(db, site.id, points);
  return [`search: ${span} days`, `inspected ${inspected.length} pages`];
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && node --test src/results-sync.test.ts 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Run it every day, and on demand**

Replace the body of `run` in `apps/web/src/search-sync-workflow.ts`:

```ts
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const siteIds = await step.do("list-sites", () => listSitesForResults(this.env.DB));
    const results: Record<string, string> = {};
    for (const siteId of siteIds) {
      results[siteId] = await step.do(`sync-${siteId}`, { retries: { limit: 1, delay: "1 minute" } }, async () => {
        const site = await getSite(this.env.DB, siteId);
        if (!site) return "skipped: site removed";
        const notes: string[] = [];
        if (site.gscProperty && (await publishedPages(this.env.DB, siteId)).published) {
          try {
            notes.push(`pages: ${(await syncGeneratedPageSearch(this.env, site)).queries} query rows`);
          } catch (error) {
            // One site's revoked Google access must not stop the others.
            notes.push(`pages failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        notes.push(...await syncResults(this.env.DB, site, new Date(), googleAccess(this.env, siteId)));
        return notes.join("; ");
      });
    }
    return results;
  }
```

and replace the file's `import { getSite, listSitesWithLivePages } from "@organic-growth/db";` line with:

```ts
import { getSite, listSitesForResults, publishedPages } from "@organic-growth/db";
import { googleAccess } from "./results-access";
import { syncResults } from "./results-sync";
```

Create `apps/web/src/results-access.ts` (kept apart from `results-sync.ts` so the sync stays testable without Workers bindings):

```ts
import type { D1Like } from "@organic-growth/db";
import { googleAccessToken, googleScopes } from "./gsc-auth";
import type { GoogleAccess } from "./results-sync";

type GoogleEnv = { DB: D1Like; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string; OAUTH_ENCRYPTION_KEY: string };

/** The site's Google token (fetched only when a Google step needs it) and its granted scopes. */
export function googleAccess(env: GoogleEnv, siteId: string): GoogleAccess {
  const scopes: string[] = [];
  return {
    token: async () => {
      scopes.push(...await googleScopes(env.DB, siteId));
      return googleAccessToken(env.DB, siteId, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_ENCRYPTION_KEY);
    },
    get scopes() { return scopes; },
  };
}
```

`GoogleAccess.scopes` is read after `token()` resolves, which is the order `syncResults` uses.

Create `apps/web/app/api/sites/[siteId]/results/sync/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { googleAccess } from "../../../../../../src/results-access";
import { syncResults } from "../../../../../../src/results-sync";
import { fail, json } from "../../../../../../src/server";

/** "Sync now": the same sync the daily workflow runs, for one site. */
export async function POST(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ notes: await syncResults(env.DB, site, new Date(), googleAccess(env, siteId)) });
}
```

- [ ] **Step 6: Typecheck, test, and check by hand**

Run: `npm run build:packages >/dev/null && npm run typecheck 2>&1 | grep "error TS"; npm test -w @organic-growth/web 2>&1 | grep -E "^# (pass|fail)"`
Expected: no type errors; `# fail 0`.
Manual: `npm run db:migrate:local`, then `curl -X POST http://localhost:5174/api/sites/<medbay site id>/results/sync`. Expected notes include `search: 486 days` and `inspected N pages`; a second call says `search: 7 days`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/results-sync.ts apps/web/src/results-sync.test.ts apps/web/src/results-access.ts apps/web/src/search-sync-workflow.ts "apps/web/app/api/sites/[siteId]/results/sync/route.ts" apps/web/package.json
git commit -m "Sync Search Console, GA4, index status, and leads into Results every day"
```

---

### Task 10: The Results API

**Files:**
- Create: `apps/web/app/api/sites/[siteId]/results/route.ts`, `apps/web/src/results-data.ts`

**Interfaces:**
- Consumes: `RESULT_METRICS`, `resultsView`, `addDays` (Task 4); `listMetricSeries`, `publishedPages`, `indexStatusCounts` (Tasks 1, 2, 7).
- Produces: `loadResults(db, site, today?): Promise<ResultsView>`; `GET /api/sites/:id/results` → `ResultsView`.

- [ ] **Step 1: Implement the loader and route**

`apps/web/src/results-data.ts`:

```ts
import { addDays, RESULT_METRICS, resultsView, type ResultsView, type SiteRecord } from "@organic-growth/core";
import { indexStatusCounts, listMetricSeries, listSiteMarkets, publishedPages, type D1Like } from "@organic-growth/db";

/** Everything the Results view shows for one site, computed from the ledger. */
export async function loadResults(db: D1Like, site: SiteRecord, today = new Date().toISOString().slice(0, 10)): Promise<ResultsView> {
  const [series, pages, index, markets] = await Promise.all([
    listMetricSeries(db, site.id, RESULT_METRICS, addDays(today, -500), today),
    publishedPages(db, site.id),
    indexStatusCounts(db, site.id),
    listSiteMarkets(db, site.id),
  ]);
  return resultsView({
    today, goLive: pages.goLive, markets, series, index, published: pages.published,
    searchConnected: Boolean(site.gscProperty), ga4Connected: Boolean(site.ga4Property),
  });
}
```

`apps/web/app/api/sites/[siteId]/results/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { loadResults } from "../../../../../src/results-data";
import { fail, json } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ site: { name: site.name, baseUrl: site.baseUrl, gscProperty: site.gscProperty ?? null, ga4Property: site.ga4Property ?? null }, results: await loadResults(env.DB, site) });
}
```

- [ ] **Step 2: Typecheck and check by hand**

Run: `npm run typecheck 2>&1 | grep "error TS"`
Expected: no output.
Manual: `curl -s http://localhost:5174/api/sites/<medbay site id>/results | python3 -m json.tool | head -40` shows `headline` weeks, `numbers.clicks`, and `searchThrough`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/results-data.ts "apps/web/app/api/sites/[siteId]/results/route.ts"
git commit -m "Serve the Results view from the ledger"
```

---

### Task 11: The Results view

**Files:**
- Create: `apps/web/app/components/ResultsView.tsx`
- Modify: `apps/web/app/components/charts.tsx` (`LineChart` marker and dashed partial weeks), `apps/web/app/page.tsx` (nav), `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `GET /api/sites/:id/results` (Task 10), `POST /api/sites/:id/results/sync` (Task 9).
- Produces: `ResultsView({ endpoint, operator, onNavigate? })` rendering the view from any endpoint returning `{ site, results }` (Task 13 reuses it read-only). `LineChart` gains `marker?: { x: string; label: string }` and `partialFrom?: string`.

- [ ] **Step 1: Teach `LineChart` the go-live marker and partial weeks**

In `apps/web/app/components/charts.tsx`, change the `LineChart` signature and the incomplete-tail logic:

```tsx
export function LineChart({ points, series, marker, partialFrom }: {
  points: Array<{ x: string; values: Array<number | null> }>;
  series: string[];
  /** A vertical hairline at the first point on or after `x`, labeled (e.g. go-live). */
  marker?: { x: string; label: string };
  /** Points from this x on are still filling in and draw dashed. */
  partialFrom?: string;
}) {
```

Replace `const incomplete = points.length > 1 && points.at(-1)?.x === TODAY();` with:

```tsx
  const firstPartial = partialFrom ? points.findIndex((point) => point.x >= partialFrom) : points.at(-1)?.x === TODAY() ? points.length - 1 : -1;
  const incomplete = points.length > 1 && firstPartial > 0;
```

Replace the two series paths with a split at `firstPartial`:

```tsx
            const solid = incomplete ? pairs.filter(([px]) => px <= x(firstPartial - 1)) : pairs;
            const tail = incomplete ? pairs.filter(([px]) => px >= x(firstPartial - 1)) : [];
            return (
              <g key={name} className={`chart-series s${index}`}>
                <path d={path(solid)} />
                {tail.length > 1 && <path d={path(tail)} className="chart-tail" />}
              </g>
            );
```

and draw the marker after the grid lines inside the `<svg>`:

```tsx
          {marker && (() => {
            const at = points.findIndex((point) => point.x >= marker.x);
            return at >= 0 ? <line x1={x(at)} x2={x(at)} y1="0" y2="100" className="chart-marker" /> : null;
          })()}
```

and after the `chart-tick` spans:

```tsx
        {marker && points.findIndex((point) => point.x >= marker.x) >= 0 && (
          <span className="chart-marker-label" style={{ left: `${x(points.findIndex((point) => point.x >= marker.x))}%` }}>{marker.label}</span>
        )}
```

- [ ] **Step 2: Write the view**

`apps/web/app/components/ResultsView.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Compare, ResultsView as Results } from "@organic-growth/core";
import { api, errorMessage, formatNumber } from "./api";
import { Funnel, LineChart } from "./charts";
import { Button, Card, Kpi, ViewHeader } from "./ui";

type Payload = { site: { name: string; baseUrl: string; gscProperty: string | null; ga4Property: string | null }; results: Results };

const day = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
const pct = (value: number | null, digits = 1) => (value === null ? "—" : `${(value * 100).toFixed(digits)}%`);

/** "was 120 before Eumon", or the previous 28 days without a go-live, or "collecting". */
function versus(compare: Compare, format: (value: number) => string = formatNumber) {
  if (compare.current === null) return "Collecting data";
  if (compare.before !== null) return `was ${format(compare.before)} before Eumon`;
  if (compare.previous !== null) return `${format(compare.previous)} in the 28 days before`;
  return "First 28 days of data";
}

/**
 * Is it working? Google clicks over 16 months with the go-live marked, the
 * key numbers against before Eumon, then one section per question.
 */
export function ResultsView({ endpoint, operator, onNavigate }: { endpoint: string; operator: boolean; onNavigate?: (view: "connections" | "overview") => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const load = useCallback(() => api<Payload>(endpoint).then(setData).catch((cause) => setError(errorMessage(cause))), [endpoint]);
  useEffect(() => { setData(null); setError(""); void load(); }, [load]);

  async function syncNow() {
    setSyncing(true); setError("");
    try {
      await api(endpoint.replace(/\/results$/, "/results/sync"), { method: "POST" });
      await load();
    } catch (cause) { setError(errorMessage(cause)); } finally { setSyncing(false); }
  }

  if (error) return <div className="callout error" role="alert">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const { site, results } = data;
  const host = new URL(site.baseUrl).hostname;
  const goLive = results.goLive ? { x: results.goLive, label: `Eumon live ${day(results.goLive)}` } : undefined;
  const partialFrom = results.headline.find((week) => week.partial)?.week;
  const pages = results.numbers.pages;

  return (
    <div>
      <ViewHeader
        title={operator ? "Results" : site.name}
        description={<>Is Eumon working for {host}? {results.searchThrough ? `Google data through ${day(results.searchThrough)}.` : "Google data appears after the first sync."}</>}
        actions={operator && <Button variant="secondary" busy={syncing} onClick={syncNow}>Sync now</Button>}
      />
      <div className="results">
        <Card title="Google clicks per week" subtitle={results.goLive ? "The whole site, and Eumon's pages since they went live." : "The whole site. Eumon's pages appear once the first one is published."}>
          {site.gscProperty && results.headline.some((week) => week.site !== null)
            ? <LineChart series={results.goLive ? ["whole site", "eumon pages"] : ["whole site"]} marker={goLive} partialFrom={partialFrom}
                points={results.headline.map((week) => ({ x: week.week, values: results.goLive ? [week.site, week.eumon] : [week.site] }))} />
            : <ConnectPrompt operator={operator} what="Search Console" onNavigate={onNavigate} />}
        </Card>
        <div className="metrics-grid">
          <Kpi label="Google clicks · 28 days" value={results.numbers.clicks.current === null ? "—" : formatNumber(results.numbers.clicks.current)} caption={versus(results.numbers.clicks)} />
          <Kpi label="Enquiries · 28 days" value={results.numbers.leads.current === null ? "—" : formatNumber(results.numbers.leads.current)} caption={versus(results.numbers.leads)} />
          <Kpi label="Organic sessions · 28 days" value={results.numbers.organicSessions?.current == null ? "—" : formatNumber(results.numbers.organicSessions.current)} caption={results.numbers.organicSessions ? versus(results.numbers.organicSessions) : "Connect Google Analytics"} />
          <Kpi label="Pages live" value={formatNumber(pages.live)} caption={pages.live ? `${formatNumber(pages.indexed)} indexed · ${formatNumber(pages.notIndexed)} not · ${formatNumber(pages.unchecked)} not checked yet` : "was 0 before Eumon"} />
        </div>

        <Card title="Are more people finding you on Google?" subtitle={results.markets.length ? `Scoped to your target markets: ${results.markets.join(", ").toUpperCase()}.` : "Every country. Set target markets in Connections to focus this section."}>
          {results.search ? (
            <>
              <div className="ruled-grid c11 results-pair">
                <div><div className="section-title">Clicks per week</div><LineChart series={["clicks"]} partialFrom={partialFrom} points={results.search.weeks.map((week) => ({ x: week.week, values: [week.clicks] }))} /></div>
                <div><div className="section-title">Impressions per week</div><LineChart series={["impressions"]} partialFrom={partialFrom} points={results.search.weeks.map((week) => ({ x: week.week, values: [week.impressions] }))} /></div>
              </div>
              <div className="metrics-grid results-inline">
                <Kpi label="Click-through rate" value={pct(results.search.ctr.current)} caption={versus(results.search.ctr, (value) => pct(value))} />
                <Kpi label="Average position" value={results.search.position.current === null ? "—" : results.search.position.current.toFixed(1)} caption={versus(results.search.position, (value) => value.toFixed(1))} />
                {results.search.clicksAllCountries && <Kpi label="Clicks · every country" value={results.search.clicksAllCountries.current === null ? "—" : formatNumber(results.search.clicksAllCountries.current)} caption="Beside the target-market figure above" />}
              </div>
              <div className="section-title">Queries by position, this week</div>
              <ol className="rank-buckets">
                {results.search.buckets.map((bucket) => (
                  <li key={bucket.top}>
                    <span className="rank-label">Top {bucket.top}</span>
                    <strong>{bucket.queries === null ? "—" : formatNumber(bucket.queries)}</strong>
                    <span className="rank-change">{bucket.added === null ? "" : `+${formatNumber(bucket.added)} new · −${formatNumber(bucket.lost ?? 0)} lost`}</span>
                  </li>
                ))}
              </ol>
              <p className="small muted">Search Console leaves out anonymized queries, so query counts are lower than total clicks suggest. Data arrives two to three days late.</p>
            </>
          ) : <ConnectPrompt operator={operator} what="Search Console" onNavigate={onNavigate} />}
          {results.organic && (
            <>
              <div className="section-title">Organic sessions per week, from Google Analytics</div>
              <LineChart series={["organic sessions", "GA4 key events"]} partialFrom={partialFrom} marker={goLive} points={results.organic.map((week) => ({ x: week.week, values: [week.sessions, week.keyEvents] }))} />
            </>
          )}
        </Card>

        <Card title="Is it bringing enquiries?" subtitle="Eumon's pages from a Google search to an enquiry, over the last 28 days of Search Console data.">
          {results.leads.funnel ? <Funnel steps={results.leads.funnel} /> : <p className="empty-state">The funnel appears once Eumon's pages have Google impressions.</p>}
          <div className="section-title">Enquiries per week</div>
          {results.leads.weeks.some((week) => week.other !== null || week.eumon !== null)
            ? <LineChart series={["from eumon pages", "everything else"]} marker={goLive} points={results.leads.weeks.map((week) => ({ x: week.week, values: [week.eumon, week.other] }))} />
            : <p className="empty-state">No enquiries tracked yet. Install tracking in Setup to count WhatsApp taps, calls, and forms.</p>}
        </Card>

        {operator && (
          <Card title="Is the site healthy?" subtitle="Share of crawled sitemap pages with no error, no empty HTML, and no noindex, from the latest analysis.">
            <div className="big-number">{results.health.value === null ? "—" : `${results.health.value}%`}</div>
            <p className="small muted">{results.health.day ? `Analysis of ${day(results.health.day)}.` : "Run an analysis to measure it."}</p>
          </Card>
        )}
      </div>
    </div>
  );
}

function ConnectPrompt({ operator, what, onNavigate }: { operator: boolean; what: string; onNavigate?: (view: "connections") => void }) {
  return (
    <div className="empty-state">
      {operator ? <>Connect {what} to see 16 months of history. <Button small variant="secondary" onClick={() => onNavigate?.("connections")}>Open Connections</Button></> : `${what} is not connected yet.`}
    </div>
  );
}
```

- [ ] **Step 3: Add the nav item and styles**

In `apps/web/app/page.tsx`: add `"results"` to the `View` union, add `{ view: "results", label: "Results" },` to `NAV` directly after Overview, import `ResultsView`, and render:

```tsx
              {view === "results" && <ResultsView endpoint={`/api/sites/${site.id}/results`} operator onNavigate={navigate} />}
```

Append to `apps/web/app/globals.css` before `/* Heatmap: a ruled grid`:

```css
/* Results */
.chart-marker { stroke: var(--green); stroke-width: 1; stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; }
.chart-marker-label { position: absolute; top: -18px; transform: translateX(-50%); font-family: var(--mono); font-size: 11px; color: var(--green-ink); white-space: nowrap; }
.results-pair { gap: 0 24px; margin-bottom: 14px; }
.results-inline { margin: 6px 0 14px; }
.rank-buckets { margin: 0 calc(-1 * var(--pad)); padding: 0; list-style: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.rank-buckets li { display: grid; gap: 4px; padding: 12px var(--pad); border-right: 1px solid var(--line); }
.rank-buckets li:last-child { border-right: 0; }
.rank-label { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--soft); }
.rank-buckets strong { font-size: 24px; font-weight: 400; font-variant-numeric: tabular-nums; }
.rank-change { font-family: var(--mono); font-size: 11px; color: var(--muted); }
@media (max-width: 760px) { .rank-buckets { grid-template-columns: repeat(2, minmax(0, 1fr)); } .results-pair { grid-template-columns: minmax(0, 1fr); } }
```

- [ ] **Step 4: Typecheck, detector, and look at it**

Run: `npm run typecheck 2>&1 | grep "error TS"; /home/gabrielchin/.claude/skills/impeccable/scripts/impeccable detect --no-advisory apps/web/app/components/ResultsView.tsx apps/web/app/components/charts.tsx apps/web/app/globals.css`
Expected: no type errors; detector exit 0.
Manual: open http://localhost:5174/?site=<medbay id>&view=results after Task 9's sync: the headline shows weekly clicks over 16 months; key numbers show captions; ranking buckets show four counts.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/ResultsView.tsx apps/web/app/components/charts.tsx apps/web/app/page.tsx apps/web/app/globals.css
git commit -m "Add the Results view: Google clicks since go-live, rankings, enquiries, health"
```

---

### Task 12: Demo history

**Files:**
- Modify: `packages/agents/src/demo.ts`, `packages/agents/src/demo.test.ts`

**Interfaces:**
- Consumes: `upsertMetricPoints`, `saveIndexStatus`, `syncFirstPartyResults` (Tasks 1, 2, 7); `resultsView`, `RESULT_METRICS`, `addDays` (Task 4).
- Produces: `seedDemoResults(db, now)` called at the end of `seedDemoSite`, writing fictional history: guides published 80 days ago, 486 days of Search Console points (all, Eumon, `@markets`), GA4 points, weekly ranking buckets for 16 Mondays, and index statuses for the 60 guides (40 indexed, 12 not, 8 unchecked).

- [ ] **Step 1: Write the failing test** (append inside the existing `describe` in `packages/agents/src/demo.test.ts`; add `addDays, RESULT_METRICS, resultsView` from `@organic-growth/core` and `indexStatusCounts, listMetricSeries, publishedPages` from `@organic-growth/db` to the imports)

```ts
  it("gives the demo 16 months of Results history with a go-live 80 days ago", async () => {
    const db = openSqliteD1();
    const now = Date.now();
    await seedDemoSite(db, now);
    const today = new Date(now).toISOString().slice(0, 10);
    const pages = await publishedPages(db, DEMO_SITE_ID);
    assert.equal(pages.goLive, addDays(today, -80));
    const view = resultsView({
      today, goLive: pages.goLive, markets: ["mys", "sgp"], published: pages.published,
      series: await listMetricSeries(db, DEMO_SITE_ID, RESULT_METRICS, addDays(today, -500), today),
      index: await indexStatusCounts(db, DEMO_SITE_ID), searchConnected: true, ga4Connected: true,
    });
    assert.ok(view.numbers.clicks.current! > view.numbers.clicks.before!, "clicks grew after go-live");
    assert.deepEqual(view.numbers.pages, { live: 60, indexed: 40, notIndexed: 12, unchecked: 8 });
    assert.ok(view.search!.buckets[1]!.queries! > 0);
    assert.ok(view.organic!.length > 60);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run build:packages >/dev/null; cd packages/agents && npx tsc -p tsconfig.test.json; node --disable-warning=ExperimentalWarning --test dist-test/demo.test.js 2>&1 | grep -E "^# (pass|fail)|not ok"`
Expected: the new test fails (no go-live 80 days ago, no points).

- [ ] **Step 3: Implement** (append to `packages/agents/src/demo.ts`; extend the imports with `addDays` from `@organic-growth/core` and `saveIndexStatus, syncFirstPartyResults, upsertMetricPoints` from `@organic-growth/db`, and `type MetricPoint`)

```ts
/**
 * Fictional Results history for the demo: Search Console and GA4 back 16
 * months, growth after Eumon's guides went live 80 days ago, weekly ranking
 * buckets, and index statuses. Real sites get these from the daily sync.
 */
async function seedDemoResults(db: D1Like, now: number) {
  const today = new Date(now).toISOString().slice(0, 10);
  const goLive = addDays(today, -80);
  await db.prepare("UPDATE generated_pages SET published_at = ? WHERE site_id = ? AND status = 'published'").bind(`${goLive}T02:00:00.000Z`, DEMO_SITE_ID).run();
  const points: MetricPoint[] = [];
  for (let back = 486; back >= 1; back--) {
    const day = addDays(today, -back);
    const live = day >= goLive;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const season = 1 + 0.12 * Math.sin(back / 24) - (weekday === 0 || weekday === 6 ? 0.18 : 0);
    const lift = live ? 1 + Math.min(1, (80 - back + 1) / 60) * 0.55 : 1;
    const clicks = Math.round(70 * season * lift);
    const impressions = Math.round(2600 * season * (live ? lift * 1.1 : 1));
    const position = live ? 11 - Math.min(1, (80 - back) / 60) * 2.5 : 11;
    points.push(
      { metric: "search_clicks", day, value: clicks },
      { metric: "search_impressions", day, value: impressions },
      { metric: "search_position_weight", day, value: impressions * position },
      { metric: "search_clicks@markets", day, value: Math.round(clicks * 0.93) },
      { metric: "search_impressions@markets", day, value: Math.round(impressions * 0.9) },
      { metric: "search_position_weight@markets", day, value: Math.round(impressions * 0.9) * (position - 0.4) },
      { metric: "ga4_sessions", day, value: Math.round(clicks * 2.6) },
      { metric: "ga4_organic_sessions", day, value: Math.round(clicks * 1.15) },
      { metric: "ga4_organic_engaged_sessions", day, value: Math.round(clicks * 0.8) },
      { metric: "ga4_organic_key_events", day, value: Math.round(clicks * 0.05) },
    );
    if (live) {
      const eumonClicks = Math.round(clicks * Math.min(0.32, (80 - back + 1) / 200));
      points.push(
        { metric: "eumon_search_clicks", day, value: eumonClicks },
        { metric: "eumon_search_impressions", day, value: eumonClicks * 38 },
        { metric: "eumon_search_position_weight", day, value: eumonClicks * 38 * 9 },
      );
    }
  }
  for (let week = 0; week < 16; week++) {
    const day = addDays(today, -7 * week);
    const growth = Math.max(0, 16 - week);
    for (const [top, base] of [[3, 14], [10, 52], [20, 118], [100, 290]] as const) {
      const queries = base + growth * (top === 3 ? 1 : 3);
      for (const suffix of ["", "@markets"]) {
        points.push(
          { metric: `queries_top${top}${suffix}`, day, value: suffix ? Math.round(queries * 0.9) : queries },
          { metric: `queries_top${top}.new${suffix}`, day, value: 2 + (week % 3) },
          { metric: `queries_top${top}.lost${suffix}`, day, value: week % 2 },
        );
      }
    }
  }
  await upsertMetricPoints(db, DEMO_SITE_ID, points);
  const { results: guides } = await db.prepare("SELECT id FROM generated_pages WHERE site_id = ? AND status = 'published' ORDER BY path").bind(DEMO_SITE_ID).all<{ id: string }>();
  await saveIndexStatus(db, DEMO_SITE_ID, guides.slice(0, 52).map((page, index) => ({
    pageId: page.id,
    verdict: index < 40 ? "PASS" : "NEUTRAL",
    coverageState: index < 40 ? "Submitted and indexed" : "Discovered - currently not indexed",
    lastCrawlTime: index < 40 ? `${addDays(today, -(index % 9) - 1)}T03:00:00Z` : null,
  })));
  await syncFirstPartyResults(db, DEMO_SITE_ID, new Date(now));
}
```

and call it as the last line of `seedDemoSite`, before `return { siteId: DEMO_SITE_ID };`:

```ts
  await seedDemoResults(db, now);
```

- [ ] **Step 4: Run the agents suite**

Run: `npm test -w @organic-growth/agents 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Check it on the dev server**

Run: `npm run db:migrate:local && curl -s -X POST http://localhost:5174/api/dev/demo-site`
Open http://localhost:5174/?site=site_demo_clinic&view=results. Expected: the headline rises after a dashed "Eumon live" marker 80 days back; Pages live reads "60 · 40 indexed · 12 not · 8 not checked yet".

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/demo.ts packages/agents/src/demo.test.ts
git commit -m "Give the demo site 16 months of Results history"
```

---

### Task 13: The client link

**Files:**
- Create: `apps/web/app/api/sites/[siteId]/share/route.ts`, `apps/web/app/api/r/[token]/route.ts`, `apps/web/app/r/[token]/page.tsx`, `apps/web/app/r/[token]/ClientReport.tsx`, `apps/web/src/share.ts`, `apps/web/src/share.test.ts`
- Modify: `apps/web/app/components/ResultsView.tsx` (share controls), `README.md` (Access note)

**Interfaces:**
- Consumes: `bumpReportShareVersion`, `SiteRecord.reportShareVersion` (Task 1); `loadResults` (Task 10); `ResultsView` (Task 11); `signToken`, `verifyToken` from `@organic-growth/core`.
- Produces: `shareToken(site, secret): Promise<string>`; `siteForShareToken(db, token, secret): Promise<SiteRecord | null>`; `POST /api/sites/:id/share` → `{ url }`; `DELETE /api/sites/:id/share` → `{ revoked: true }`; `GET /api/r/:token` → `{ site, results }` (health omitted); page `/r/:token`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/share.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bumpReportShareVersion, getSite, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { shareToken, siteForShareToken } from "./share.ts";

const secret = "s".repeat(40);

describe("client link", () => {
  it("opens the site until revoked, and never another site", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    const token = await shareToken((await getSite(db, "s"))!, secret);
    assert.equal((await siteForShareToken(db, token, secret))?.id, "s");
    assert.equal(await siteForShareToken(db, `${token}x`, secret), null, "a tampered token");
    await bumpReportShareVersion(db, "s");
    assert.equal(await siteForShareToken(db, token, secret), null, "revoked");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && node --test src/share.test.ts 2>&1 | tail -3`
Expected: cannot find module `./share.ts`.

- [ ] **Step 3: Implement**

`apps/web/src/share.ts`:

```ts
import { signToken, verifyToken, type SiteRecord } from "@organic-growth/core";
import { getSite, type D1Like } from "@organic-growth/db";

const FIVE_YEARS = 5 * 365 * 86_400_000;

/** A read-only Results link; it stops working when the site's share version is bumped. */
export function shareToken(site: SiteRecord, secret: string): Promise<string> {
  return signToken({ siteId: site.id, v: site.reportShareVersion ?? 1 }, FIVE_YEARS, secret);
}

export async function siteForShareToken(db: D1Like, token: string, secret: string): Promise<SiteRecord | null> {
  const data = await verifyToken<{ siteId: string; v: number }>(token, secret);
  if (!data) return null;
  const site = await getSite(db, data.siteId);
  return site && (site.reportShareVersion ?? 1) === data.v ? site : null;
}
```

`apps/web/app/api/sites/[siteId]/share/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { bumpReportShareVersion, getSite } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";
import { shareToken } from "../../../../../src/share";

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ url: new URL(`/r/${await shareToken(site, env.SESSION_SECRET)}`, request.url).toString() });
}

/** Revokes every link issued so far. */
export async function DELETE(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  await bumpReportShareVersion(env.DB, siteId);
  return json({ revoked: true });
}
```

`apps/web/app/api/r/[token]/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { fail, json } from "../../../../src/server";
import { loadResults } from "../../../../src/results-data";
import { siteForShareToken } from "../../../../src/share";

/** The client's read-only Results: no site health, nothing to edit. */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const site = await siteForShareToken(env.DB, token, env.SESSION_SECRET);
  if (!site) return fail("This link has expired or was revoked.", 404);
  const results = await loadResults(env.DB, site);
  return json({
    site: { name: site.name, baseUrl: site.baseUrl, gscProperty: site.gscProperty ?? null, ga4Property: site.ga4Property ?? null },
    results: { ...results, health: { value: null, day: null } },
  });
}
```

`apps/web/app/r/[token]/page.tsx`:

```tsx
import { ClientReport } from "./ClientReport";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ClientReport token={token} />;
}
```

`apps/web/app/r/[token]/ClientReport.tsx`:

```tsx
"use client";

import { ResultsView } from "../../components/ResultsView";

/** A client's view of their Results, without the console around it. */
export function ClientReport({ token }: { token: string }) {
  return (
    <main className="client-report">
      <ResultsView endpoint={`/api/r/${token}`} operator={false} />
      <footer className="client-report-credit">Report by Eumon</footer>
    </main>
  );
}
```

In `ResultsView`, `syncNow` derives its URL from `endpoint`; the client page never shows it because `operator` is false. Add share controls to the operator header actions:

```tsx
        actions={operator && (
          <div className="row">
            <Button variant="ghost" onClick={shareLink}>{shared ? "Link copied" : "Copy client link"}</Button>
            <Button variant="secondary" busy={syncing} onClick={syncNow}>Sync now</Button>
          </div>
        )}
```

with:

```tsx
  const [shared, setShared] = useState(false);
  async function shareLink() {
    try {
      const { url } = await api<{ url: string }>(endpoint.replace(/\/results$/, "/share"), { method: "POST" });
      await navigator.clipboard.writeText(url);
      setShared(true);
    } catch (cause) { setError(errorMessage(cause)); }
  }
```

Append to `apps/web/app/globals.css`:

```css
.client-report { width: min(1190px, 100% - 32px); margin: 0 auto; padding: 44px 0 32px; }
.client-report-credit { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--soft); }
```

In `README.md`, in the Cloudflare Access section beside `/p/*`, add: "`/r/*` and `/api/r/*` (client Results links) must also bypass Access."

- [ ] **Step 4: Test, typecheck, and check by hand**

Run: `cd apps/web && node --test src/share.test.ts 2>&1 | grep -E "^# (pass|fail)"; cd ../.. && npm run typecheck 2>&1 | grep "error TS"`
Expected: `# fail 0`; no type errors.
Manual: on the demo's Results, "Copy client link", open it in a private window: the same numbers, no Sync, no health card, "Report by Eumon" at the foot. Revoking (`curl -X DELETE http://localhost:5174/api/sites/site_demo_clinic/share`) makes the link show "This link has expired or was revoked."

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/share.ts apps/web/src/share.test.ts "apps/web/app/api/sites/[siteId]/share/route.ts" "apps/web/app/api/r/[token]/route.ts" "apps/web/app/r/[token]/page.tsx" "apps/web/app/r/[token]/ClientReport.tsx" apps/web/app/components/ResultsView.tsx apps/web/app/globals.css README.md
git commit -m "Share Results with a client through a revocable read-only link"
```

---

### Task 14: Verify the whole branch

**Files:**
- Modify: `apps/web/DESIGN.md` (Results components), memory notes outside the repo.

- [ ] **Step 1: Run everything**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)" | awk '{s[$2]+=$3} END {print "pass",s["pass"],"fail",s["fail"]}'; npm run typecheck 2>&1 | grep -c "error TS"`
Expected: `fail 0`; `0`.

- [ ] **Step 2: Capture the view**

Using `scratchpad/cdpshots.py` with `BASE="http://localhost:5174/?site=site_demo_clinic"`, capture `view=results` in light and dark at 1440 wide (full page) and 390 wide, and the client link page. Check: the go-live marker and label are legible in both themes; partial weeks draw dashed; the ranking buckets fit two per row at 390; nothing scrolls sideways.

- [ ] **Step 3: Design check**

Run: `/home/gabrielchin/.claude/skills/impeccable/scripts/impeccable detect --no-advisory apps/web/app/components/ResultsView.tsx apps/web/app/r/[token]/ClientReport.tsx apps/web/app/globals.css`
Expected: exit 0.

- [ ] **Step 4: Record the new components**

In `apps/web/DESIGN.md` under `### Charts`, add a line for the go-live marker (dashed green hairline with a mono label) and partial-week dashed tails; add a `### Results` entry describing the headline card, key numbers, ranking bucket strip, and the client report frame.

- [ ] **Step 5: Commit**

```bash
git add apps/web/DESIGN.md
git commit -m "Record the Results view in the design system"
```

- [ ] **Step 6: Hand off**

Tell the user: migration `0012_results.sql` is applied locally only and must be applied remotely on deploy; existing Google connections need "Reconnect Google" once for Analytics; the client link path `/r/*` needs a Cloudflare Access bypass.
