# Speed, Authority, and Google's View of the Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Performance (formerly Results) gains "Is the site fast and trusted?":
- real-user speed for phones and desktops;
- Lighthouse lab scores;
- authority against competitors.

The Overview's Search tab gains "Has Google crawled your pages?" from URL Inspection of sitemap URLs.

**Architecture:**
- **Data:** three keyed sources (CrUX History, PageSpeed Insights, Open PageRank) write snapshot points into the existing `metric_points` ledger, from a new step in `syncResults` that runs before, and independently of, the Google OAuth step.
- **Crawl coverage:** a new table `url_index_status`, filled 200 URLs per step through the existing URL Inspection client, from the daily `SearchSyncWorkflow` (9 steps a day) and "Sync now" (1 step).
- **Views:** `resultsView` in core computes the new section, and a new route serves crawl coverage to the Search tab.

**Tech Stack:**
- TypeScript, Cloudflare Workers/D1/Workflows, vinext, React 19.
- Tests: `node:test` with SQLite through `openSqliteD1`.

**Spec:** `docs/superpowers/specs/2026-10-08-speed-authority-crawl-design.md`

## Global Constraints

- **Branch:** `claude/seo-data`. Commit after each task; never push. Never run `npm run db:migrate:remote`.
- **Keys:**
  - New Worker secrets: `GOOGLE_API_KEY` (CrUX and PSI) and `OPEN_PAGERANK_KEY`.
  - A missing key skips its step with a note; it never fails the sync.
- **Endpoints:**
  - Open PageRank: `https://openpagerank.keywordseverywhere.com/api/v1.0/getPageRank`, header `API-OPR`.
  - CrUX History: `https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=…`.
  - PSI: `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=…&strategy=mobile|desktop&category=performance&key=…`.
- **Metric names** (snapshot values, stored on a day):
  - `crux_lcp_p75.phone`, `crux_inp_p75.phone`, `crux_cls_p75.phone`, and the `.desktop` equivalents;
  - `sync.crux`;
  - `lab_score_home.phone`, `lab_score_home.desktop`, `lab_score_eumon.phone`, `lab_score_eumon.desktop`;
  - `authority`, and `authority:<domain>` for each competitor.
- **Speed thresholds:**

  | Metric | Good | Needs work | Poor |
  |---|---|---|---|
  | LCP | ≤ 2500 ms | ≤ 4000 ms | above |
  | INP | ≤ 200 ms | ≤ 500 ms | above |
  | CLS | ≤ 0.1 | ≤ 0.25 | above |

- **URL Inspection budget:**
  - 200 per step;
  - 9 steps a day in the workflow, 1 per "Sync now";
  - 10 concurrent;
  - stop on 401, 403 or 429;
  - re-check URLs after 30 days.
- **Copy:** never invent numbers; missing data says why. The authority caption must say "Open PageRank: a free 0–10 estimate from public link data, updated about monthly. Not Google's own measure."
- **Design:** square corners, 1px rules, mono for machinery. Green, amber and red are used only as Good, Needs work and Poor (DESIGN.md Square Rule and Alarm-Only Rule).
- **Builds and server:**
  - Packages must be rebuilt before dependants see changes: `npm run build -w @organic-growth/<pkg>`, in the order core, db, agents.
  - Don't restart the user's dev server on 5174.
- **Running tests:**
  - Web tests: `cd apps/web && npm test`.
  - Package tests: `npm test -w @organic-growth/<pkg>`.

## Review Focus

1. **A CrUX period with no value.** The API returns `"NaN"` or `null` in `p75s` for weeks with too little data. Expected: that week is skipped, not stored as 0. Pinned in Task 2.
2. **A site whose `baseUrl` has `www.`** Expected: CrUX queries the exact origin, and Open PageRank gets the hostname without `www.` Pinned in Tasks 2 and 3.
3. **Competitors change after authority was stored.** Expected: removed competitors no longer show, and new ones show "—" until the next weekly fetch. Pinned in Task 4.
4. **The latest crawl drops URLs that were inspected earlier.** Expected: coverage counts only URLs in the current crawl, so "checked" never exceeds "total". Pinned in Task 6.
5. **Google refuses inspection part-way (429).** Expected: the day's coverage run stops, statuses already saved are kept, and nothing is retried in a tight loop. Pinned in Task 7.

---

## File Structure

- `packages/core/src/signals.ts` (new): speed thresholds, `speedRating`, `CoverageClass`, `coverageClass`. Pure functions, exported from core's index.
- `packages/agents/src/site-signals.ts` (new): `fetchCruxHistory`, `cruxHistoryPoints`, `fetchLabScore`, `fetchAuthority`. Exported from agents' index.
- `packages/db/migrations/0015_url_index_status.sql` (new).
- `packages/db/src/coverage.ts` (new): `urlsToInspect`, `saveUrlIndexStatus`, `indexCoverage`. Exported from db's index.
- `packages/db/src/metrics.ts`: `listSitesForResults` covers every site; new `topEumonPage`.
- `packages/core/src/results.ts`: `RESULT_METRICS` grows; `ResultsInput.competitors`; `ResultsView.speed`, `lab`, `authority`.
- `apps/web/src/results-sync.ts`: `SignalKeys`, `syncSignals`, `inspectSitemapUrls`; `syncResults(…, keys = {})`.
- `apps/web/src/results-data.ts`: loads competitor authority series; the payload carries `signals`.
- `apps/web/src/search-sync-workflow.ts`, `apps/web/app/api/sites/[siteId]/results/sync/route.ts`, `apps/web/app/api/r/[token]/route.ts`, `apps/web/app/api/sites/[siteId]/results/route.ts`: pass the keys and signals.
- `apps/web/app/api/sites/[siteId]/index-coverage/route.ts` (new).
- `apps/web/app/components/ResultsView.tsx`: the new section.
- `apps/web/app/components/ReportTabs.tsx`: the `IndexCoverageCard` in `SearchTab`.
- `apps/web/app/components/OverviewView.tsx`: passes `siteId` to `SearchTab`.
- `apps/web/app/globals.css`: styles for both.
- `apps/web/cloudflare.config.ts`, `apps/web/.dev.vars.example`: the new secrets.
- `packages/agents/src/demo.ts`: demo speed, lab, authority, and coverage.

---

### Task 1: Speed ratings and coverage classes (core)

**Files:**
- Create: `packages/core/src/signals.ts`
- Create: `packages/core/src/signals.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./signals.js";`)

**Interfaces:**
- Produces:
  - `type SpeedMetric = "lcp" | "inp" | "cls"`
  - `type SpeedRating = "good" | "needs-work" | "poor"`
  - `const SPEED_METRICS: SpeedMetric[]`
  - `speedRating(metric: SpeedMetric, p75: number): SpeedRating`
  - `type CoverageClass = "indexed" | "crawled" | "discovered" | "unknown" | "excluded"`
  - `const COVERAGE_CLASSES: CoverageClass[]`
  - `coverageClass(verdict: string, coverageState: string | null): CoverageClass`

- [ ] **Step 1: Write the failing test** `packages/core/src/signals.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coverageClass, speedRating } from "./signals.js";

describe("site signals", () => {
  it("rates speed on Google's thresholds, inclusive at each edge", () => {
    assert.equal(speedRating("lcp", 2500), "good");
    assert.equal(speedRating("lcp", 2501), "needs-work");
    assert.equal(speedRating("lcp", 4000), "needs-work");
    assert.equal(speedRating("lcp", 4001), "poor");
    assert.equal(speedRating("inp", 200), "good");
    assert.equal(speedRating("inp", 500), "needs-work");
    assert.equal(speedRating("inp", 1042), "poor");
    assert.equal(speedRating("cls", 0.1), "good");
    assert.equal(speedRating("cls", 0.25), "needs-work");
    assert.equal(speedRating("cls", 0.26), "poor");
  });

  it("sorts URL Inspection results into what Google did with the page", () => {
    assert.equal(coverageClass("PASS", "Submitted and indexed"), "indexed");
    assert.equal(coverageClass("NEUTRAL", "Crawled - currently not indexed"), "crawled");
    assert.equal(coverageClass("NEUTRAL", "Discovered - currently not indexed"), "discovered");
    assert.equal(coverageClass("NEUTRAL", "URL is unknown to Google"), "unknown");
    assert.equal(coverageClass("NEUTRAL", "Excluded by ‘noindex’ tag"), "excluded");
    assert.equal(coverageClass("FAIL", null), "excluded");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w @organic-growth/core`
Expected: a TypeScript error, `Cannot find module './signals.js'`.

- [ ] **Step 3: Implement** `packages/core/src/signals.ts`

```ts
/*
 * Site signals: Google's Core Web Vitals thresholds, and what URL Inspection
 * says Google did with a page.
 */

export type SpeedMetric = "lcp" | "inp" | "cls";
export type SpeedRating = "good" | "needs-work" | "poor";
export const SPEED_METRICS: SpeedMetric[] = ["lcp", "inp", "cls"];

/** Google's thresholds at the 75th percentile: good up to the first, needs work up to the second. */
const THRESHOLDS: Record<SpeedMetric, [number, number]> = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] };

export function speedRating(metric: SpeedMetric, p75: number): SpeedRating {
  const [good, needsWork] = THRESHOLDS[metric];
  return p75 <= good ? "good" : p75 <= needsWork ? "needs-work" : "poor";
}

export type CoverageClass = "indexed" | "crawled" | "discovered" | "unknown" | "excluded";
export const COVERAGE_CLASSES: CoverageClass[] = ["indexed", "crawled", "discovered", "unknown", "excluded"];

/** Indexed, crawled but not indexed, discovered but not crawled, unknown to Google, or excluded for another reason. */
export function coverageClass(verdict: string, coverageState: string | null): CoverageClass {
  if (verdict === "PASS") return "indexed";
  const state = coverageState ?? "";
  if (state.startsWith("Crawled")) return "crawled";
  if (state.startsWith("Discovered")) return "discovered";
  if (state.includes("unknown to Google")) return "unknown";
  return "excluded";
}
```

Add `export * from "./signals.js";` to `packages/core/src/index.ts`, next to the existing `export * from "./results.js";`.

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -w @organic-growth/core`
Expected: every test passes.

- [ ] **Step 5: Build and commit**

```bash
npm run build -w @organic-growth/core
git add packages/core/src/signals.ts packages/core/src/signals.test.ts packages/core/src/index.ts
git commit -m "Speed ratings and URL inspection classes in core"
```

---

### Task 2: CrUX, PageSpeed, and Open PageRank clients (agents)

**Files:**
- Create: `packages/agents/src/site-signals.ts`
- Create: `packages/agents/src/site-signals.test.ts`
- Modify: `packages/agents/src/index.ts` (add `export * from "./site-signals.js";` next to `export * from "./results-points.js";`)

**Interfaces:**
- Consumes: `googleError(response, what)` from `./google-search-console.js`; `MetricPoint` type from `@organic-growth/db`.
- Produces:
  - `type FormFactor = "phone" | "desktop"`
  - `cruxHistoryPoints(json: unknown, formFactor: FormFactor): MetricPoint[]`
  - `fetchCruxHistory(apiKey: string, origin: string, formFactor: FormFactor, periods: number, fetchFn?: typeof fetch): Promise<MetricPoint[]>` (a 404 resolves to `[]`)
  - `fetchLabScore(apiKey: string, url: string, strategy: "mobile" | "desktop", fetchFn?: typeof fetch): Promise<number>` (0–100)
  - `authorityDomain(baseUrl: string): string`
  - `fetchAuthority(apiKey: string, domains: string[], fetchFn?: typeof fetch): Promise<Array<{ domain: string; score: number }>>`

- [ ] **Step 1: Write the failing test** `packages/agents/src/site-signals.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorityDomain, cruxHistoryPoints, fetchAuthority, fetchCruxHistory, fetchLabScore } from "./site-signals.js";

// Recorded from the CrUX History API for medbaycare.com on 2026-10-08 (trimmed), plus a missing week.
const history = {
  record: {
    metrics: {
      largest_contentful_paint: { percentilesTimeseries: { p75s: [7126, "NaN", 7012] } },
      interaction_to_next_paint: { percentilesTimeseries: { p75s: [1271, 1189, null] } },
      cumulative_layout_shift: { percentilesTimeseries: { p75s: ["0.09", "0.07", "0.07"] } },
    },
    collectionPeriods: [
      { firstDate: { year: 2026, month: 8, day: 23 }, lastDate: { year: 2026, month: 9, day: 19 } },
      { firstDate: { year: 2026, month: 8, day: 30 }, lastDate: { year: 2026, month: 9, day: 26 } },
      { firstDate: { year: 2026, month: 9, day: 6 }, lastDate: { year: 2026, month: 10, day: 3 } },
    ],
  },
};

describe("site signals clients", () => {
  it("turns CrUX history into one point per week and metric, skipping weeks without data", () => {
    const points = cruxHistoryPoints(history, "phone");
    const lcp = points.filter((point) => point.metric === "crux_lcp_p75.phone");
    assert.deepEqual(lcp, [{ metric: "crux_lcp_p75.phone", day: "2026-09-19", value: 7126 }, { metric: "crux_lcp_p75.phone", day: "2026-10-03", value: 7012 }]);
    assert.equal(points.filter((point) => point.metric === "crux_inp_p75.phone").length, 2);
    assert.deepEqual(points.find((point) => point.metric === "crux_cls_p75.phone" && point.day === "2026-10-03"), { metric: "crux_cls_p75.phone", day: "2026-10-03", value: 0.07 });
  });

  it("asks CrUX for the exact origin and form factor, and reads a 404 as no data", async () => {
    let body: Record<string, unknown> = {};
    const found = (async (_url: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify(history)); }) as typeof fetch;
    assert.equal((await fetchCruxHistory("k", "https://www.x.com", "desktop", 40, found)).length, 7);
    assert.deepEqual(body, { origin: "https://www.x.com", formFactor: "DESKTOP", collectionPeriodCount: 40, metrics: ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"] });
    const missing = (async () => new Response(JSON.stringify({ error: { code: 404, message: "chrome ux report data not found", status: "NOT_FOUND" } }), { status: 404 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchCruxHistory("k", "https://small.example", "phone", 40, missing), []);
    const refused = (async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(fetchCruxHistory("k", "https://x.com", "phone", 2, refused), /API key not valid/);
  });

  it("reads the Lighthouse performance score as 0-100", async () => {
    let asked = "";
    const fetchFn = (async (url: string) => { asked = url; return new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.32 } } } })); }) as typeof fetch;
    assert.equal(await fetchLabScore("k", "https://x.com/", "mobile", fetchFn), 32);
    assert.ok(asked.includes("strategy=mobile") && asked.includes("category=performance") && asked.includes(encodeURIComponent("https://x.com/")));
  });

  it("scores authority per domain, skipping domains Open PageRank doesn't know", async () => {
    assert.equal(authorityDomain("https://www.medbaycare.com/"), "medbaycare.com");
    let headers: HeadersInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers = init?.headers;
      return new Response(JSON.stringify({ status_code: 200, response: [
        { status_code: 200, page_rank_decimal: 0.25, domain: "medbaycare.com" },
        { status_code: 404, error: "Domain not found", page_rank_decimal: 0, domain: "nope.example" },
      ] }));
    }) as typeof fetch;
    assert.deepEqual(await fetchAuthority("secret", ["medbaycare.com", "nope.example"], fetchFn), [{ domain: "medbaycare.com", score: 0.25 }]);
    assert.deepEqual(headers, { "API-OPR": "secret" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w @organic-growth/agents`
Expected: a TypeScript error, `Cannot find module './site-signals.js'`.

- [ ] **Step 3: Implement** `packages/agents/src/site-signals.ts`

```ts
/*
 * Keyed site signals: real-user speed (CrUX History), Lighthouse lab scores
 * (PageSpeed Insights), and an authority estimate (Open PageRank).
 */
import type { MetricPoint } from "@organic-growth/db";
import { googleError } from "./google-search-console.js";

export type FormFactor = "phone" | "desktop";

const CRUX_METRICS = { largest_contentful_paint: "lcp", interaction_to_next_paint: "inp", cumulative_layout_shift: "cls" } as const;
type DateParts = { year: number; month: number; day: number };
const isoDay = (date: DateParts) => `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

/** One point per collection period and metric, on the period's last day; weeks without data ("NaN" or null) are skipped. */
export function cruxHistoryPoints(json: unknown, formFactor: FormFactor): MetricPoint[] {
  const record = (json as { record?: { metrics?: Record<string, { percentilesTimeseries?: { p75s?: unknown[] } }>; collectionPeriods?: Array<{ lastDate: DateParts }> } })?.record;
  const periods = record?.collectionPeriods ?? [];
  return Object.entries(CRUX_METRICS).flatMap(([name, short]) => (record?.metrics?.[name]?.percentilesTimeseries?.p75s ?? []).flatMap((raw, index) => {
    const value = raw === null ? Number.NaN : Number(raw);
    const period = periods[index];
    return Number.isFinite(value) && period ? [{ metric: `crux_${short}_p75.${formFactor}`, day: isoDay(period.lastDate), value }] : [];
  }));
}

/** Weekly real-user speed for an origin; an origin with too few Chrome visits (404) has none. */
export async function fetchCruxHistory(apiKey: string, origin: string, formFactor: FormFactor, periods: number, fetchFn: typeof fetch = fetch): Promise<MetricPoint[]> {
  const response = await fetchFn(`https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, formFactor: formFactor.toUpperCase(), collectionPeriodCount: periods, metrics: Object.keys(CRUX_METRICS) }),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw await googleError(response, "Chrome UX Report request");
  return cruxHistoryPoints(await response.json(), formFactor);
}

/** Lighthouse's performance score for one URL, 0-100. */
export async function fetchLabScore(apiKey: string, url: string, strategy: "mobile" | "desktop", fetchFn: typeof fetch = fetch): Promise<number> {
  const query = new URLSearchParams({ url, strategy, category: "performance", key: apiKey });
  const response = await fetchFn(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${query}`, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw await googleError(response, "PageSpeed Insights request");
  const score = (await response.json() as { lighthouseResult?: { categories?: { performance?: { score?: number } } } }).lighthouseResult?.categories?.performance?.score;
  if (typeof score !== "number") throw new Error("PageSpeed Insights returned no performance score.");
  return Math.round(score * 100);
}

/** The domain Open PageRank scores: the host without `www.` */
export const authorityDomain = (baseUrl: string) => new URL(baseUrl).hostname.replace(/^www\./, "");

/** Open PageRank's 0-10 estimate per domain (up to 100 per request); domains it doesn't know are left out. */
export async function fetchAuthority(apiKey: string, domains: string[], fetchFn: typeof fetch = fetch): Promise<Array<{ domain: string; score: number }>> {
  const query = new URLSearchParams(domains.slice(0, 100).map((domain) => ["domains[]", domain]));
  const response = await fetchFn(`https://openpagerank.keywordseverywhere.com/api/v1.0/getPageRank?${query}`, { headers: { "API-OPR": apiKey } });
  if (!response.ok) throw new Error(`Open PageRank request failed (${response.status}).`);
  const json = await response.json() as { response?: Array<{ status_code: number; domain: string; page_rank_decimal: number }> };
  return (json.response ?? []).filter((row) => row.status_code === 200).map((row) => ({ domain: row.domain, score: Number(row.page_rank_decimal) }));
}
```

Add `export * from "./site-signals.js";` to `packages/agents/src/index.ts`.

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -w @organic-growth/agents`
Expected: every test passes, including the four new ones.

- [ ] **Step 5: Build and commit**

```bash
npm run build -w @organic-growth/agents
git add packages/agents/src/site-signals.ts packages/agents/src/site-signals.test.ts packages/agents/src/index.ts
git commit -m "Clients for CrUX history, PageSpeed lab scores, and Open PageRank"
```

---

### Task 3: Sync speed, lab scores, and authority

**Files:**
- Modify: `apps/web/src/results-sync.ts`
- Modify: `apps/web/src/results-sync.test.ts`
- Modify: `packages/db/src/metrics.ts` (`listSitesForResults`, new `topEumonPage`)
- Modify: `packages/db/src/metrics.test.ts`
- Modify: `apps/web/src/search-sync-workflow.ts`
- Modify: `apps/web/app/api/sites/[siteId]/results/sync/route.ts`
- Modify: `apps/web/cloudflare.config.ts`
- Modify: `apps/web/.dev.vars.example`

**Interfaces:**
- Consumes: from Task 2, `fetchCruxHistory`, `fetchLabScore`, `fetchAuthority`, `authorityDomain`, `FormFactor`.
- Produces:
  - `type SignalKeys = { googleApiKey?: string; openPageRankKey?: string }` (exported from `results-sync.ts`)
  - `syncResults(db, site, now, google, keys: SignalKeys = {})`, which runs the signals step first
  - `topEumonPage(db, siteId, today): Promise<string | null>`: the path of the published Eumon page with the most search clicks in the last 28 days, else the earliest published
  - `listSitesForResults` returns every site

- [ ] **Step 1: Write the failing db test.** Append to `packages/db/src/metrics.test.ts`, and add `topEumonPage` to its import from `./index.js`:

```ts
describe("signals helpers", () => {
  it("covers every site in the daily sync, and picks the Eumon page with the most clicks", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    assert.deepEqual(await listSitesForResults(db), ["s"], "speed and authority need no connection");
    assert.equal(await topEumonPage(db, "s", "2026-10-07"), null);
    await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(now, now).run();
    await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'T', '{}', 'active', ?, ?)`).bind(now, now).run();
    for (const [id, published] of [["a", "2026-09-01"], ["b", "2026-09-05"]] as const) {
      await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
        VALUES (?, 's', 't', ?, ?, 'x', '', '{}', 1, '[]', 'published', ?, ?, ?)`).bind(id, `/guides/${id}`, id, published, now, now).run();
    }
    assert.equal(await topEumonPage(db, "s", "2026-10-07"), "/guides/a", "no clicks yet: the earliest published");
    await db.prepare("INSERT INTO page_metrics_daily (site_id, page_id, day, search_clicks, search_impressions, search_position) VALUES ('s', 'b', '2026-10-01', 9, 90, 4)").run();
    assert.equal(await topEumonPage(db, "s", "2026-10-07"), "/guides/b");
  });
});
```

If `page_metrics_daily` needs more NOT NULL columns, read `packages/db/migrations/*` for `CREATE TABLE IF NOT EXISTS page_metrics_daily` and fill them with 0.

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w @organic-growth/db`
Expected: a TypeScript error, `has no exported member 'topEumonPage'`.

- [ ] **Step 3: Implement.** In `packages/db/src/metrics.ts`, replace `listSitesForResults`, and add `topEumonPage` after it:

```ts
/** Sites the daily Results sync covers: every site, since speed and authority need no connection. */
export async function listSitesForResults(db: D1Like): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM sites ORDER BY id").all<{ id: string }>();
  return results.map((row) => row.id);
}

/** The published Eumon page with the most Google clicks over the last 28 days, or the earliest published one. */
export async function topEumonPage(db: D1Like, siteId: string, today: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT g.path FROM generated_pages g
     LEFT JOIN page_metrics_daily m ON m.page_id = g.id AND m.site_id = g.site_id AND m.day >= ?
     WHERE g.site_id = ? AND g.status = 'published'
     GROUP BY g.id ORDER BY COALESCE(SUM(m.search_clicks), 0) DESC, g.published_at, g.path LIMIT 1`,
  ).bind(addDays(today, -28), siteId).first<{ path: string }>();
  return row?.path ?? null;
}
```

Run `npm test -w @organic-growth/db`; expect a pass. If the old `listSitesForResults` test now fails because it asserted unconnected sites are left out, update that assertion to the new rule (every site is listed), with the message "speed and authority need no connection". Then run `npm run build -w @organic-growth/db`.

- [ ] **Step 4: Write the failing sync test.** Append to `apps/web/src/results-sync.test.ts`, inside `describe("results sync")`:

```ts
  it("syncs speed, lab scores, and authority from keys alone, backfilling speed once", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://www.x.com", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    const asked: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${init?.body ?? ""}`);
      if (url.includes("chromeuxreport")) {
        const periods = JSON.parse(String(init?.body)).collectionPeriodCount as number;
        return new Response(JSON.stringify({ record: {
          metrics: { largest_contentful_paint: { percentilesTimeseries: { p75s: Array(periods).fill(3000) } } },
          collectionPeriods: Array.from({ length: periods }, (_, index) => {
            const end = new Date(Date.UTC(2026, 9, 3 - 7 * (periods - 1 - index)));
            return { lastDate: { year: end.getUTCFullYear(), month: end.getUTCMonth() + 1, day: end.getUTCDate() } };
          }),
        } }));
      }
      if (url.includes("pagespeedonline")) return new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.5 } } } }));
      if (url.includes("openpagerank")) return new Response(JSON.stringify({ response: [{ status_code: 200, domain: "x.com", page_rank_decimal: 2.5 }, { status_code: 200, domain: "rival.example", page_rank_decimal: 3.1 }] }));
      return new Response("{}");
    }) as typeof fetch;
    const google = { connect: async () => { throw new Error("not connected"); }, fetchFn };
    const keys = { googleApiKey: "g", openPageRankKey: "o" };
    const site = (await getSite(db, "s"))!;
    const notes = await syncResults(db, site, now, google, keys);
    assert.ok(notes.includes("speed: 40 weeks"), notes.join("; "));
    assert.ok(notes.includes("lab: 2 scores"), notes.join("; "));
    assert.ok(notes.includes("authority: 2 domains"), notes.join("; "));
    assert.ok(asked.some((entry) => entry.includes("chromeuxreport") && entry.includes('"origin":"https://www.x.com"')));
    const series = await listMetricSeries(db, "s", ["crux_lcp_p75.phone", "lab_score_home.phone", "authority", "authority:rival.example"], "2025-01-01", "2026-10-07");
    assert.equal(series["crux_lcp_p75.phone"]!.length, 40);
    assert.deepEqual(series["lab_score_home.phone"], [{ day: "2026-10-07", value: 50 }]);
    assert.deepEqual(series.authority, [{ day: "2026-10-07", value: 2.5 }]);
    assert.deepEqual(series["authority:rival.example"], [{ day: "2026-10-07", value: 3.1 }]);

    // The next day (a Thursday) fetches nothing weekly again.
    asked.length = 0;
    const later = await syncResults(db, site, new Date("2026-10-08T04:15:00Z"), google, keys);
    assert.equal(asked.length, 0, later.join("; "));
  });

  it("notes a missing key instead of failing", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const notes = await syncResults(db, (await getSite(db, "s"))!, now, { connect: async () => { throw new Error("no"); } });
    assert.ok(notes.includes("speed: no Google API key"), notes.join("; "));
    assert.ok(notes.includes("authority: no Open PageRank key"), notes.join("; "));
  });
```

Add `setSiteCompetitorDomains` to the test's `@organic-growth/db` import. `now` is `2026-10-07T04:15:00Z` (a Wednesday), and the first run fetches because no markers exist. Lab has no Eumon page here, so it makes 2 calls (the homepage, mobile and desktop).

- [ ] **Step 5: Run it to see it fail**

Run: `cd apps/web && npm test`
Expected: FAIL. The notes don't include `speed: 40 weeks`.

- [ ] **Step 6: Implement in `apps/web/src/results-sync.ts`.**

Add to the imports:

```ts
import { authorityDomain, fetchAuthority, fetchCruxHistory, fetchLabScore, type FormFactor } from "@organic-growth/agents";
import { listSiteCompetitorDomains, topEumonPage } from "@organic-growth/db";
```

Merge these into the existing import lines from the same packages; don't add duplicate import statements.

Add the type and the step:

```ts
/** API keys for the signals that need no Google sign-in: CrUX and PageSpeed (Google API key), Open PageRank. */
export type SignalKeys = { googleApiKey?: string; openPageRankKey?: string };

const FORM_FACTORS: FormFactor[] = ["phone", "desktop"];

/**
 * Real-user speed (weekly CrUX history: 40 weeks the first time, then the
 * latest 2 on Mondays), Lighthouse lab scores, and authority (both weekly).
 * Each source fails on its own.
 */
async function syncSignals(db: D1Like, site: SiteRecord, today: string, monday: boolean, keys: SignalKeys, fetchFn?: typeof fetch): Promise<string[]> {
  const notes: string[] = [];
  const weekly = async (marker: string) => monday || !(await firstMetricDay(db, site.id, marker));
  if (!keys.googleApiKey) notes.push("speed: no Google API key");
  else {
    if (await weekly("sync.crux")) {
      try {
        const first = !(await firstMetricDay(db, site.id, "sync.crux"));
        const origin = new URL(site.baseUrl).origin;
        const points = (await Promise.all(FORM_FACTORS.map((form) => fetchCruxHistory(keys.googleApiKey!, origin, form, first ? 40 : 2, fetchFn)))).flat();
        await upsertMetricPoints(db, site.id, [...points, { metric: "sync.crux", day: today, value: points.length }]);
        notes.push(`speed: ${first ? 40 : 2} weeks`);
      } catch (error) {
        notes.push(`speed failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (await weekly("lab_score_home.phone")) {
      const settings = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
      const eumonPath = await topEumonPage(db, site.id, today);
      const targets = [
        { name: "home", url: new URL("/", site.baseUrl).toString() },
        ...(eumonPath ? [{ name: "eumon", url: `${new URL(settings.publicOrigin).origin}${eumonPath}` }] : []),
      ];
      const scored = await Promise.all(targets.flatMap((target) => FORM_FACTORS.map(async (form) => {
        try {
          return { metric: `lab_score_${target.name}.${form}`, day: today, value: await fetchLabScore(keys.googleApiKey!, target.url, form === "phone" ? "mobile" : "desktop", fetchFn) };
        } catch {
          return null;
        }
      })));
      const points = scored.filter((point) => point !== null);
      await upsertMetricPoints(db, site.id, points);
      notes.push(`lab: ${points.length} scores`);
    }
  }
  if (!keys.openPageRankKey) notes.push("authority: no Open PageRank key");
  else if (await weekly("authority")) {
    try {
      const own = authorityDomain(site.baseUrl);
      const rivals = await listSiteCompetitorDomains(db, site.id);
      const scores = await fetchAuthority(keys.openPageRankKey, [own, ...rivals], fetchFn);
      await upsertMetricPoints(db, site.id, scores.map((row) => ({ metric: row.domain === own ? "authority" : `authority:${row.domain}`, day: today, value: row.score })));
      notes.push(`authority: ${scores.length} domains`);
    } catch (error) {
      notes.push(`authority failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notes;
}
```

Change `syncResults` so the signals run first and need no connection:

```ts
export async function syncResults(db: D1Like, site: SiteRecord, now: Date, google: GoogleAccess, keys: SignalKeys = {}): Promise<string[]> {
  const today = now.toISOString().slice(0, 10);
  const notes = await syncSignals(db, site, today, now.getUTCDay() === 1, keys, google.fetchFn);
  await syncFirstPartyResults(db, site.id, now);
  if (!site.gscProperty && !site.ga4Property) return notes;
  // … the existing body continues unchanged, except it no longer declares `notes` or `today` (both declared above).
```

`authority` is only written when the site's own domain is scored. If Open PageRank doesn't know the site, the `authority` marker is missing, so the next day tries again. That's acceptable: one request a day.

- [ ] **Step 7: Pass the keys from env.** `apps/web/src/search-sync-workflow.ts`:

```ts
notes.push(...await syncResults(this.env.DB, site, new Date(), googleAccess(this.env, siteId), { googleApiKey: this.env.GOOGLE_API_KEY, openPageRankKey: this.env.OPEN_PAGERANK_KEY }));
```

`apps/web/app/api/sites/[siteId]/results/sync/route.ts`:

```ts
return json({ notes: await syncResults(env.DB, site, new Date(), googleAccess(env, siteId), { googleApiKey: env.GOOGLE_API_KEY, openPageRankKey: env.OPEN_PAGERANK_KEY }) });
```

`apps/web/cloudflare.config.ts`, after `OAUTH_ENCRYPTION_KEY: bindings.secret(),`:

```ts
      // Optional: real-user speed and lab scores (Google API key with the CrUX and PageSpeed Insights APIs), and authority (Open PageRank).
      GOOGLE_API_KEY: bindings.secret(),
      OPEN_PAGERANK_KEY: bindings.secret(),
```

`apps/web/.dev.vars.example`, after the `OAUTH_ENCRYPTION_KEY` line:

```
# Optional: a Google Cloud API key restricted to the Chrome UX Report and PageSpeed Insights APIs (real-user speed and lab scores).
GOOGLE_API_KEY=
# Optional: an Open PageRank key (free, openpagerank.keywordseverywhere.com) for the authority estimate.
OPEN_PAGERANK_KEY=
```

- [ ] **Step 8: Run all web tests and the typecheck**

Run: `cd apps/web && npm test && npx tsc --noEmit -p .`
Expected: every test passes and there are no type errors. If `AppEnv` doesn't pick up the new secrets automatically, add `GOOGLE_API_KEY?: string; OPEN_PAGERANK_KEY?: string` where `AppEnv` is declared in `cloudflare.config.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/metrics.ts packages/db/src/metrics.test.ts apps/web/src/results-sync.ts apps/web/src/results-sync.test.ts apps/web/src/search-sync-workflow.ts "apps/web/app/api/sites/[siteId]/results/sync/route.ts" apps/web/cloudflare.config.ts apps/web/.dev.vars.example
git commit -m "Sync real-user speed, lab scores, and authority with API keys"
```

---

### Task 4: The view model for "Is the site fast and trusted?"

**Files:**
- Modify: `packages/core/src/results.ts`
- Modify: `packages/core/src/results.test.ts`
- Modify: `apps/web/src/results-data.ts`
- Modify: `apps/web/src/results-data.test.ts`
- Modify: `apps/web/app/api/sites/[siteId]/results/route.ts` and `apps/web/app/api/r/[token]/route.ts`

**Interfaces:**
- Consumes: `SpeedMetric`, `SpeedRating`, `SPEED_METRICS`, `speedRating` (Task 1); the metric names written in Task 3.
- Produces:
  - `ResultsInput.competitors?: string[]`
  - `ResultsView.speed: { measured: boolean; metrics: Array<{ metric: SpeedMetric; phone: SpeedValue; desktop: SpeedValue; history: Array<{ day: string; phone: number | null; desktop: number | null }> }> }`, with `type SpeedValue = { p75: number | null; rating: SpeedRating | null }`. `measured` is true once `sync.crux` exists.
  - `ResultsView.lab: { phone: { home: number | null; eumon: number | null }; desktop: { home: number | null; eumon: number | null } }`
  - `ResultsView.authority: { site: number | null; competitors: Array<{ domain: string; score: number | null }>; history: Array<{ day: string; value: number }> }`
  - `ResultsPayload.site.signals: { speed: boolean; authority: boolean }` (whether each key is set)
  - `resultsPayload(db, site, options: { client?: boolean; signals?: { speed: boolean; authority: boolean } })`

- [ ] **Step 1: Write the failing core test.** Append inside the main `describe` of `packages/core/src/results.test.ts`:

```ts
  it("reports speed per form factor with ratings, lab scores, and authority for current competitors", () => {
    const view = resultsView(base({
      competitors: ["rival.example", "new.example"],
      series: {
        "sync.crux": [{ day: "2026-10-05", value: 6 }],
        "crux_lcp_p75.phone": [{ day: "2026-09-26", value: 7763 }, { day: "2026-10-03", value: 7012 }],
        "crux_lcp_p75.desktop": [{ day: "2026-10-03", value: 2100 }],
        "crux_cls_p75.phone": [{ day: "2026-10-03", value: 0.07 }],
        "lab_score_home.phone": [{ day: "2026-10-05", value: 32 }],
        "lab_score_eumon.phone": [{ day: "2026-10-05", value: 96 }],
        authority: [{ day: "2026-09-28", value: 0.2 }, { day: "2026-10-05", value: 0.25 }],
        "authority:rival.example": [{ day: "2026-10-05", value: 1.14 }],
        "authority:gone.example": [{ day: "2026-10-05", value: 5 }],
      },
    }));
    const lcp = view.speed.metrics.find((entry) => entry.metric === "lcp")!;
    assert.equal(view.speed.measured, true);
    assert.deepEqual(lcp.phone, { p75: 7012, rating: "poor" });
    assert.deepEqual(lcp.desktop, { p75: 2100, rating: "good" });
    assert.deepEqual(lcp.history, [{ day: "2026-09-26", phone: 7763, desktop: null }, { day: "2026-10-03", phone: 7012, desktop: 2100 }]);
    assert.deepEqual(view.speed.metrics.find((entry) => entry.metric === "inp")!.phone, { p75: null, rating: null }, "no INP data on phones");
    assert.deepEqual(view.lab, { phone: { home: 32, eumon: 96 }, desktop: { home: null, eumon: null } });
    assert.deepEqual(view.authority.competitors, [{ domain: "rival.example", score: 1.14 }, { domain: "new.example", score: null }], "removed competitors drop out; new ones wait for the weekly fetch");
    assert.equal(view.authority.site, 0.25);
    assert.equal(view.authority.history.length, 2);
    assert.equal(resultsView(base()).speed.measured, false);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w @organic-growth/core`
Expected: TypeScript errors, since `competitors` isn't in `ResultsInput` and `speed` isn't in `ResultsView`.

- [ ] **Step 3: Implement in `packages/core/src/results.ts`.**

Import at the top: `import { SPEED_METRICS, speedRating, type SpeedMetric, type SpeedRating } from "./signals.js";`.

Extend `RESULT_METRICS` (append inside the array):

```ts
  "sync.crux", ...["lcp", "inp", "cls"].flatMap((metric) => [`crux_${metric}_p75.phone`, `crux_${metric}_p75.desktop`]),
  "lab_score_home.phone", "lab_score_home.desktop", "lab_score_eumon.phone", "lab_score_eumon.desktop", "authority",
```

Add to `ResultsInput`:

```ts
  /** The site's current competitor domains, for `authority:<domain>` series. */
  competitors?: string[];
```

Add the types and fields to `ResultsView`:

```ts
export type SpeedValue = { p75: number | null; rating: SpeedRating | null };
// inside ResultsView:
  speed: {
    /** Whether CrUX has been asked yet; asked with no values means too few Chrome visits. */
    measured: boolean;
    metrics: Array<{ metric: SpeedMetric; phone: SpeedValue; desktop: SpeedValue; history: Array<{ day: string; phone: number | null; desktop: number | null }> }>;
  };
  lab: { phone: { home: number | null; eumon: number | null }; desktop: { home: number | null; eumon: number | null } };
  authority: { site: number | null; competitors: Array<{ domain: string; score: number | null }>; history: Array<{ day: string; value: number }> };
```

Compute them in `resultsView`, before `return`:

```ts
  const speedValue = (metric: SpeedMetric, form: "phone" | "desktop"): SpeedValue => {
    const p75 = latest(series[`crux_${metric}_p75.${form}`], today);
    return { p75, rating: p75 === null ? null : speedRating(metric, p75) };
  };
  const speed = {
    measured: Boolean(series["sync.crux"]?.length),
    metrics: SPEED_METRICS.map((metric) => {
      const phone = series[`crux_${metric}_p75.phone`] ?? [];
      const desktop = series[`crux_${metric}_p75.desktop`] ?? [];
      const days = [...new Set([...phone, ...desktop].map((point) => point.day))].sort();
      const at = (points: DayValue[], day: string) => points.find((point) => point.day === day)?.value ?? null;
      return { metric, phone: speedValue(metric, "phone"), desktop: speedValue(metric, "desktop"), history: days.map((day) => ({ day, phone: at(phone, day), desktop: at(desktop, day) })) };
    }),
  };
  const lab = {
    phone: { home: latest(series["lab_score_home.phone"], today), eumon: latest(series["lab_score_eumon.phone"], today) },
    desktop: { home: latest(series["lab_score_home.desktop"], today), eumon: latest(series["lab_score_eumon.desktop"], today) },
  };
  const authority = {
    site: latest(series.authority, today),
    competitors: (input.competitors ?? []).map((domain) => ({ domain, score: latest(series[`authority:${domain}`], today) })),
    history: series.authority ?? [],
  };
```

Add `speed, lab, authority,` to the returned object.

- [ ] **Step 4: Run the core tests**

Run: `npm test -w @organic-growth/core && npm run build -w @organic-growth/core`
Expected: everything passes.

- [ ] **Step 5: Write the failing web test.** Append to `apps/web/src/results-data.test.ts`, and add `setSiteCompetitorDomains` to the imports:

```ts
  it("loads authority for the site's current competitors, and says which keys are set", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    await upsertMetricPoints(db, "s", [{ metric: "authority:rival.example", day: at.slice(0, 10), value: 1.1 }]);
    const payload = await resultsPayload(db, (await getSite(db, "s"))!, { signals: { speed: true, authority: false } });
    assert.deepEqual(payload.results.authority.competitors, [{ domain: "rival.example", score: 1.1 }]);
    assert.deepEqual(payload.site.signals, { speed: true, authority: false });
  });
```

- [ ] **Step 6: Run it to see it fail**

Run: `cd apps/web && npm test`
Expected: FAIL, because `competitors` is empty and `signals` is undefined.

- [ ] **Step 7: Implement in `apps/web/src/results-data.ts`.**

In `loadResults`:
- add `listSiteCompetitorDomains` to the `@organic-growth/db` import;
- fetch `const competitors = await listSiteCompetitorDomains(db, site.id);` before the `Promise.all`;
- pass `[...RESULT_METRICS, ...competitors.map((domain) => `authority:${domain}`)]` to `listMetricSeries`;
- add `competitors` to the `resultsView` input.

In `ResultsPayload.site`, add `signals: { speed: boolean; authority: boolean }`. `resultsPayload` takes `options: { client?: boolean; signals?: { speed: boolean; authority: boolean } } = {}` and sets `site.signals = options.signals ?? { speed: false, authority: false }`.

In both routes (`apps/web/app/api/sites/[siteId]/results/route.ts` and `apps/web/app/api/r/[token]/route.ts`), pass `signals: { speed: Boolean(env.GOOGLE_API_KEY), authority: Boolean(env.OPEN_PAGERANK_KEY) }` in the options object the route already gives `resultsPayload`. Keep `client: true` on the `r/[token]` route.

- [ ] **Step 8: Run the tests and the typecheck**

Run: `cd apps/web && npm test && npx tsc --noEmit -p .`
Expected: everything passes.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/results.ts packages/core/src/results.test.ts apps/web/src/results-data.ts apps/web/src/results-data.test.ts "apps/web/app/api/sites/[siteId]/results/route.ts" "apps/web/app/api/r/[token]/route.ts"
git commit -m "Results view model: speed per form factor, lab scores, authority"
```

---

### Task 5: The "Is the site fast and trusted?" section (UI)

**Files:**
- Modify: `apps/web/app/components/ResultsView.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes:
  - `results.speed`, `results.lab`, `results.authority`, and `site.signals` from Task 4;
  - `LineChart` and `BarList` from `./charts`, and `Card`, `Kpi`, `Badge` from `./ui`.

Before editing, run the Impeccable context (`/home/gabrielchin/.claude/skills/impeccable/scripts/impeccable context --target apps/web/app/components/ResultsView.tsx`) and read `reference/craft-floor.md`. Follow DESIGN.md: square corners, ruled grids, Alarm-Only colours.

- [ ] **Step 1: Add the section.** Place it in `ResultsView` after the "Is it bringing enquiries?" card and before the operator-only health card:

```tsx
        <Card title="Is the site fast and trusted?" subtitle="Speed for real Chrome visitors over 28 days (Google's 75th percentile), Lighthouse lab scores, and an authority estimate.">
          {!site.signals.speed && !results.speed.measured
            ? <p className="empty-state">{operator ? "Add a Google API key (GOOGLE_API_KEY) with the Chrome UX Report and PageSpeed Insights APIs to measure speed." : "Not measured yet."}</p>
            : (
              <div className="ruled-grid c3 speed-tiles">
                {results.speed.metrics.map((entry) => (
                  <div key={entry.metric} className="speed-tile">
                    <div className="section-title">{SPEED_LABEL[entry.metric]}</div>
                    {(["phone", "desktop"] as const).map((form) => (
                      <div key={form} className="speed-row">
                        <span className="speed-form">{form === "phone" ? "Phones" : "Desktops"}</span>
                        {entry[form].p75 === null
                          ? <span className="small muted">{results.speed.measured ? "Not enough Chrome visits for Google to report" : "Measuring after the next sync"}</span>
                          : <><strong>{formatSpeed(entry.metric, entry[form].p75!)}</strong><Badge tone={RATING_TONE[entry[form].rating!]}>{RATING_LABEL[entry[form].rating!]}</Badge></>}
                      </div>
                    ))}
                    {entry.history.length > 1 && (
                      <LineChart series={["phones", "desktops"]} points={entry.history.map((week) => ({ x: week.day, values: [week.phone, week.desktop] }))} />
                    )}
                  </div>
                ))}
              </div>
            )}
          {(results.lab.phone.home !== null || results.lab.desktop.home !== null) && (
            <div className="metrics-grid results-inline">
              {(["phone", "desktop"] as const).map((form) => (
                <Kpi key={form} label={`Lighthouse score · ${form === "phone" ? "phone" : "desktop"}`}
                  value={results.lab[form].eumon ?? results.lab[form].home ?? "—"}
                  caption={results.lab[form].eumon !== null ? `Eumon page · homepage ${results.lab[form].home ?? "—"}` : "homepage"} />
              ))}
            </div>
          )}
          <div className="section-title">Authority</div>
          {results.authority.site === null && !results.authority.competitors.some((entry) => entry.score !== null)
            ? <p className="empty-state">{operator && !site.signals.authority ? "Add an Open PageRank key (OPEN_PAGERANK_KEY) to compare authority with your competitors." : "Not measured yet."}</p>
            : (
              <>
                <BarList rows={[{ label: host, value: results.authority.site ?? 0 }, ...results.authority.competitors.map((entry) => ({ label: entry.domain, value: entry.score ?? 0 }))]} />
                {results.authority.history.length > 1 && <LineChart series={["authority"]} points={results.authority.history.map((point) => ({ x: point.day, values: [point.value] }))} />}
              </>
            )}
          <p className="small muted">Open PageRank: a free 0–10 estimate from public link data, updated about monthly. Not Google's own measure.</p>
        </Card>
```

Add the helpers near the top of the file:

```tsx
const SPEED_LABEL: Record<SpeedMetric, string> = { lcp: "Loading", inp: "Responding to taps", cls: "Staying still while loading" };
const RATING_LABEL: Record<SpeedRating, string> = { good: "Good", "needs-work": "Needs work", poor: "Poor" };
const RATING_TONE: Record<SpeedRating, string> = { good: "green", "needs-work": "amber", poor: "red" };
const formatSpeed = (metric: SpeedMetric, value: number) => (metric === "cls" ? value.toFixed(2) : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);
```

Import `type SpeedMetric, type SpeedRating` from `@organic-growth/core`, `BarList` from `./charts`, and `Badge` from `./ui`. BarList formats its values with `formatNumber`. If that rounds 0.25 to 0, add an optional `format?: (value: number) => string` prop to `BarList` in `charts.tsx`, defaulting to `formatNumber`, and pass `(value) => value.toFixed(2)` here.

- [ ] **Step 2: Add the styles** to `apps/web/app/globals.css`, next to `.top-queries`:

```css
.speed-tiles { margin: 0 calc(-1 * var(--pad)) 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.speed-tile { padding: 14px var(--pad) 10px; min-width: 0; }
.speed-tile + .speed-tile { border-left: 1px solid var(--line); }
.speed-row { display: flex; align-items: center; gap: 10px; min-height: 34px; }
.speed-form { width: 72px; font-family: var(--mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.speed-row strong { font-size: 20px; font-weight: 400; font-variant-numeric: tabular-nums; }
@media (max-width: 1050px) { .speed-tile + .speed-tile { border-left: 0; border-top: 1px solid var(--line); } }
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Check it renders.** On the 5174 server, after Task 9 seeds the demo (or after "Sync now" on medbaycare), capture `view=results` on desktop (1440) and phone (390), in light and dark, with `scratchpad/cdpshots.py`. Fix what the capture shows in one batch.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/ResultsView.tsx apps/web/app/components/charts.tsx apps/web/app/globals.css
git commit -m "Performance: speed for phones and desktops, lab scores, and authority"
```

---

### Task 6: URL index status store (migration and db)

**Files:**
- Create: `packages/db/migrations/0015_url_index_status.sql`
- Create: `packages/db/src/coverage.ts`
- Create: `packages/db/src/coverage.test.ts`
- Modify: `packages/db/src/index.ts` (add `export * from "./coverage.js";`)

**Interfaces:**
- Consumes: `coverageClass`, `COVERAGE_CLASSES`, `CoverageClass` (Task 1); `getPreviousCompletedAnalysis` from `./index.js`.
- Produces:
  - `urlsToInspect(db, siteId, limit, staleBefore: string): Promise<Array<{ url: string; family: string }>>`
  - `saveUrlIndexStatus(db, siteId, rows: Array<{ url: string; family: string; verdict: string; coverageState: string | null; lastCrawlTime: string | null }>): Promise<void>`
  - `type IndexCoverage = { total: number; checked: number; recentlyCrawled: number; byClass: Record<CoverageClass, number>; families: Array<{ family: string; total: number; checked: number; byClass: Record<CoverageClass, number> }> }`
  - `indexCoverage(db, siteId, now: Date): Promise<IndexCoverage | null>`

- [ ] **Step 1: Write the migration** `packages/db/migrations/0015_url_index_status.sql`

```sql
-- Google's index status for the site's own sitemap URLs (URL Inspection),
-- checked a few hundred a day and re-checked after 30 days.
CREATE TABLE IF NOT EXISTS url_index_status (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  family TEXT NOT NULL,
  verdict TEXT NOT NULL,
  coverage_state TEXT,
  last_crawl_time TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (site_id, url)
);
CREATE INDEX IF NOT EXISTS idx_url_index_status_checked ON url_index_status(site_id, checked_at);
```

- [ ] **Step 2: Write the failing test** `packages/db/src/coverage.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, indexCoverage, saveCrawlBatch, saveUrlIndexStatus, updateAnalysisStatus, upsertSite, urlsToInspect } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const u = (path: string) => `https://x.com${path}`;
const page = (path: string): CrawlPageResult => ({
  url: u(path), status: 200, finalUrl: u(path), hreflang: [], jsonLdCount: 0, contentLength: 5000, isEmptyShell: false, headingOutline: [],
  internalLinkCount: 0, rawTextLength: 3000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: path.split("/")[1]!,
});

async function crawled(paths: string[]) {
  const db = openSqliteD1();
  const now = new Date().toISOString();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  await createAnalysis(db, { id: "a", siteId: "s", status: "running", createdAt: now });
  await enqueueAnalysisCrawlUrls(db, { analysisId: "a", siteId: "s", urls: paths.map((path) => ({ url: u(path), routeFamily: path.split("/")[1]! })) });
  await saveCrawlBatch(db, { analysisId: "a", outcomes: paths.map((path) => ({ url: u(path), page: page(path) })) });
  await updateAnalysisStatus(db, "a", "completed", { completedAt: now });
  return db;
}

describe("url index status", () => {
  it("queues never-checked URLs round-robin across page types, then the oldest stale ones", async () => {
    const db = await crawled(["/doctors/a", "/doctors/b", "/doctors/c", "/blog/x", "/blog/y"]);
    assert.deepEqual((await urlsToInspect(db, "s", 4, "2026-09-08")).map((row) => row.url), [u("/blog/x"), u("/doctors/a"), u("/blog/y"), u("/doctors/b")]);
    const row = (url: string, verdict: string, state: string | null) => ({ url, family: url.split("/")[3]!, verdict, coverageState: state, lastCrawlTime: null });
    await saveUrlIndexStatus(db, "s", [row(u("/doctors/a"), "PASS", "Submitted and indexed"), row(u("/blog/x"), "NEUTRAL", "Crawled - currently not indexed")]);
    await db.prepare("UPDATE url_index_status SET checked_at = '2026-08-01T00:00:00.000Z' WHERE url = ?").bind(u("/blog/x")).run();
    assert.deepEqual((await urlsToInspect(db, "s", 10, "2026-09-08")).map((entry) => entry.url), [u("/blog/y"), u("/doctors/b"), u("/doctors/c"), u("/blog/x")], "unchecked first, then stale");
  });

  it("counts only URLs in the current crawl, by what Google did with them", async () => {
    const db = await crawled(["/doctors/a", "/doctors/b", "/blog/x"]);
    await saveUrlIndexStatus(db, "s", [
      { url: u("/doctors/a"), family: "doctors", verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T00:00:00Z" },
      { url: u("/blog/x"), family: "blog", verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed", lastCrawlTime: null },
      { url: u("/old/gone"), family: "old", verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-01T00:00:00Z" },
    ]);
    const coverage = (await indexCoverage(db, "s", new Date("2026-10-08T00:00:00Z")))!;
    assert.equal(coverage.total, 3);
    assert.equal(coverage.checked, 2, "a URL no longer in the crawl doesn't count");
    assert.equal(coverage.recentlyCrawled, 1);
    assert.deepEqual(coverage.byClass, { indexed: 1, crawled: 0, discovered: 1, unknown: 0, excluded: 0 });
    assert.deepEqual(coverage.families.find((entry) => entry.family === "doctors"), { family: "doctors", total: 2, checked: 1, byClass: { indexed: 1, crawled: 0, discovered: 0, unknown: 0, excluded: 0 } });
  });
});
```

Round-robin order, explained: unchecked rows are numbered within each page type by URL (blog: x=1, y=2; doctors: a=1, b=2, c=3), then sorted by number and page type. So the order is blog/x, doctors/a, blog/y, doctors/b, doctors/c.

- [ ] **Step 3: Run it to see it fail**

Run: `npm test -w @organic-growth/db`
Expected: a TypeScript error, `has no exported member 'urlsToInspect'`.

- [ ] **Step 4: Implement** `packages/db/src/coverage.ts`

```ts
import { COVERAGE_CLASSES, coverageClass, type CoverageClass } from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";
import { getPreviousCompletedAnalysis } from "./index.js";

/** Served pages of the latest finished crawl: the sitemap URLs Google should have. */
const CURRENT = `SELECT url, COALESCE(json_extract(result_json, '$.routeFamily'), 'other') AS family FROM pages
  WHERE analysis_id = ? AND crawl_state = 'complete' AND status < 400`;

/**
 * The next sitemap URLs to inspect: never-checked ones first, taken in turn
 * from each page type so every type is sampled early, then ones last checked
 * before `staleBefore`, oldest first.
 */
export async function urlsToInspect(db: D1Like, siteId: string, limit: number, staleBefore: string): Promise<Array<{ url: string; family: string }>> {
  const latest = await getPreviousCompletedAnalysis(db, siteId, "");
  if (!latest) return [];
  const { results: fresh } = await db.prepare(
    `SELECT url, family FROM (
       SELECT c.url, c.family, ROW_NUMBER() OVER (PARTITION BY c.family ORDER BY c.url) AS turn
       FROM (${CURRENT}) c LEFT JOIN url_index_status s ON s.site_id = ? AND s.url = c.url
       WHERE s.url IS NULL)
     ORDER BY turn, family LIMIT ?`,
  ).bind(latest.id, siteId, limit).all<{ url: string; family: string }>();
  if (fresh.length >= limit) return fresh;
  const { results: stale } = await db.prepare(
    `SELECT s.url, s.family FROM url_index_status s JOIN (${CURRENT}) c ON c.url = s.url
     WHERE s.site_id = ? AND s.checked_at < ? ORDER BY s.checked_at, s.url LIMIT ?`,
  ).bind(latest.id, siteId, staleBefore, limit - fresh.length).all<{ url: string; family: string }>();
  return [...fresh, ...stale];
}

export async function saveUrlIndexStatus(
  db: D1Like, siteId: string,
  rows: Array<{ url: string; family: string; verdict: string; coverageState: string | null; lastCrawlTime: string | null }>,
): Promise<void> {
  const checkedAt = nowIso();
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO url_index_status (site_id, url, family, verdict, coverage_state, last_crawl_time, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, url) DO UPDATE SET family = excluded.family, verdict = excluded.verdict, coverage_state = excluded.coverage_state,
       last_crawl_time = excluded.last_crawl_time, checked_at = excluded.checked_at`,
  ).bind(siteId, row.url, row.family, row.verdict, row.coverageState, row.lastCrawlTime, checkedAt));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

export type IndexCoverage = {
  /** Sitemap URLs in the latest crawl, and how many Google has been asked about. */
  total: number;
  checked: number;
  /** Checked URLs Google crawled in the last 30 days. */
  recentlyCrawled: number;
  byClass: Record<CoverageClass, number>;
  families: Array<{ family: string; total: number; checked: number; byClass: Record<CoverageClass, number> }>;
};

const emptyClasses = () => Object.fromEntries(COVERAGE_CLASSES.map((name) => [name, 0])) as Record<CoverageClass, number>;

/** What Google did with the sitemap URLs it has been asked about, overall and per page type; null before the first finished crawl. */
export async function indexCoverage(db: D1Like, siteId: string, now: Date): Promise<IndexCoverage | null> {
  const latest = await getPreviousCompletedAnalysis(db, siteId, "");
  if (!latest) return null;
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const { results } = await db.prepare(
    `SELECT c.family, s.verdict, s.coverage_state, COUNT(*) AS n, SUM(CASE WHEN s.last_crawl_time >= ? THEN 1 ELSE 0 END) AS recent
     FROM (${CURRENT}) c LEFT JOIN url_index_status s ON s.site_id = ? AND s.url = c.url
     GROUP BY c.family, s.verdict, s.coverage_state`,
  ).bind(since, latest.id, siteId).all<{ family: string; verdict: string | null; coverage_state: string | null; n: number; recent: number | null }>();
  const families = new Map<string, IndexCoverage["families"][number]>();
  const coverage: IndexCoverage = { total: 0, checked: 0, recentlyCrawled: 0, byClass: emptyClasses(), families: [] };
  for (const row of results) {
    const family = families.get(row.family) ?? { family: row.family, total: 0, checked: 0, byClass: emptyClasses() };
    const n = Number(row.n);
    family.total += n;
    coverage.total += n;
    if (row.verdict !== null) {
      const name = coverageClass(row.verdict, row.coverage_state);
      family.checked += n;
      family.byClass[name] += n;
      coverage.checked += n;
      coverage.byClass[name] += n;
      coverage.recentlyCrawled += Number(row.recent ?? 0);
    }
    families.set(row.family, family);
  }
  coverage.families = [...families.values()].sort((a, b) => b.total - a.total || a.family.localeCompare(b.family));
  return coverage;
}
```

If importing `getPreviousCompletedAnalysis` from `./index.js` makes a circular import fail at runtime, inline its query instead: `SELECT id FROM analyses WHERE site_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1`.

Add `export * from "./coverage.js";` to `packages/db/src/index.ts` beside `export * from "./metrics.js";`. Add `"url_index_status"` to the `deleteSite` tables list only if a test shows that deleting a site leaves its rows; `ON DELETE CASCADE` covers it when foreign keys are on.

- [ ] **Step 5: Run it to see it pass**

Run: `npm test -w @organic-growth/db`
Expected: every test passes.

- [ ] **Step 6: Time it on real data, read-only.** Copy the dev database with Python's `sqlite3` backup to the scratchpad. Run the `urlsToInspect` and `indexCoverage` SQL against medbaycare's latest analysis (22,913 pages) and check each takes under 1 s. If not, check `EXPLAIN QUERY PLAN` for a full scan of `url_index_status`; the primary key covers `(site_id, url)`.

- [ ] **Step 7: Build and commit**

```bash
npm run build -w @organic-growth/db
git add packages/db/migrations/0015_url_index_status.sql packages/db/src/coverage.ts packages/db/src/coverage.test.ts packages/db/src/index.ts
git commit -m "Store Google's index status for sitemap URLs, queued across page types"
```

---

### Task 7: Inspect sitemap URLs in the sync and the daily workflow

**Files:**
- Modify: `apps/web/src/results-sync.ts`
- Modify: `apps/web/src/results-sync.test.ts`
- Modify: `apps/web/src/search-sync-workflow.ts`

**Interfaces:**
- Consumes:
  - `urlsToInspect` and `saveUrlIndexStatus` (Task 6);
  - `inspectUrl(token, property, url, fetchFn)` from agents, which throws an error with `status`;
  - `addDays`.
- Produces:
  - `inspectSitemapUrls(db, siteId, property, token, today, limit, fetchFn?): Promise<{ inspected: number; refused: number | null; remaining: boolean }>`
  - `syncSearch` calls it once, with limit 200, after the Eumon-page inspections, unless those were refused.
  - Notes `coverage: inspected N` and `coverage stopped: Google answered 429`.

- [ ] **Step 1: Write the failing test.** Append inside `describe("results sync")` in `apps/web/src/results-sync.test.ts`:

```ts
  it("inspects sitemap URLs 200 at a time and stops when Google refuses", async () => {
    const { db } = await site();
    const now2 = now.toISOString();
    await createAnalysis(db, { id: "a", siteId: "s", status: "running", createdAt: now2 });
    const urls = Array.from({ length: 250 }, (_, index) => `https://x.com/doctors/d${index}`);
    await enqueueAnalysisCrawlUrls(db, { analysisId: "a", siteId: "s", urls: urls.map((url) => ({ url, routeFamily: "doctors" })) });
    await saveCrawlBatch(db, { analysisId: "a", outcomes: urls.map((url) => ({ url, page: { url, status: 200, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 1, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: "doctors" } })) });
    await updateAnalysisStatus(db, "a", "completed", { completedAt: now2 });
    let inspections = 0;
    const fetchFn = (async (url: string) => {
      if (!url.includes("urlInspection")) return new Response(JSON.stringify({ rows: [] }));
      inspections++;
      return inspections > 120
        ? new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 })
        : new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } }));
    }) as typeof fetch;
    const notes = await syncResults(db, (await getSite(db, "s"))!, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn });
    assert.ok(notes.includes("coverage: inspected 120"), notes.join("; "));
    assert.ok(notes.includes("coverage stopped: Google answered 429"), notes.join("; "));
    assert.ok(inspections <= 130, `stopped within the batch after the refusal (${inspections})`);
    const saved = await db.prepare("SELECT COUNT(*) AS n FROM url_index_status WHERE site_id = 's'").first<{ n: number }>();
    assert.equal(saved?.n, 120, "statuses saved before the refusal are kept");
  });
```

Add `createAnalysis, enqueueAnalysisCrawlUrls, saveCrawlBatch, updateAnalysisStatus` to the test's `@organic-growth/db` import.

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && npm test`
Expected: FAIL, with no `coverage:` note.

- [ ] **Step 3: Implement in `apps/web/src/results-sync.ts`.**

Add `urlsToInspect, saveUrlIndexStatus` to the `@organic-growth/db` import, then add:

```ts
/** URL inspections per step: a "Sync now" runs one step; the daily workflow runs up to nine. */
export const COVERAGE_STEP = 200;

/**
 * Asks Google about the next sitemap URLs (unchecked first, then those last
 * checked over 30 days ago), ten at a time, keeping what was learned
 * before any refusal.
 */
export async function inspectSitemapUrls(
  db: D1Like, siteId: string, property: string, token: string, today: string, limit: number, fetchFn?: typeof fetch,
): Promise<{ inspected: number; refused: number | null; remaining: boolean }> {
  const queue = await urlsToInspect(db, siteId, limit, addDays(today, -30));
  let refused: number | null = null;
  let inspected = 0;
  for (let start = 0; start < queue.length && refused === null; start += 10) {
    const batch = await Promise.all(queue.slice(start, start + 10).map(async (entry) => {
      try {
        return { ...entry, ...await inspectUrl(token, property, entry.url, fetchFn) };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403 || status === 429) refused = status;
        return null;
      }
    }));
    const rows = batch.filter((row) => row !== null);
    await saveUrlIndexStatus(db, siteId, rows);
    inspected += rows.length;
  }
  return { inspected, refused, remaining: queue.length === limit && refused === null };
}
```

`inspectUrl` returns `{ verdict, coverageState, lastCrawlTime }`, so the spread gives each row the fields `saveUrlIndexStatus` needs.

In `syncSearch`, after the Eumon-page inspection loop and before `upsertMetricPoints`, add:

```ts
  // Sitemap URLs: one step of 200 here; the daily workflow runs more steps (see SearchSyncWorkflow).
  const coverageNotes: string[] = [];
  if (refused === null) {
    const coverage = await inspectSitemapUrls(db, site.id, property, token, today, COVERAGE_STEP, fetchFn);
    if (coverage.inspected || coverage.refused) coverageNotes.push(`coverage: inspected ${coverage.inspected}`);
    if (coverage.refused) coverageNotes.push(`coverage stopped: Google answered ${coverage.refused}`);
  }
```

Then append `...coverageNotes` to the notes array `syncSearch` returns.

- [ ] **Step 4: Run it to see it pass**

Run: `cd apps/web && npm test`
Expected: every test passes. Re-check the two existing inspection tests ("inspects pages several at a time", "stops inspecting when Google refuses"). They have no completed analysis, so `urlsToInspect` returns nothing and their counts don't change.

- [ ] **Step 5: More steps in the workflow.** In `apps/web/src/search-sync-workflow.ts`, after the `sync-${siteId}` step, add:

```ts
      // Up to 8 more coverage steps (1,600 inspections), so a 23,000-URL site is checked within about two weeks under the 2,000-a-day quota.
      const site = await getSite(this.env.DB, siteId);
      if (site?.gscProperty) {
        for (let round = 1; round <= 8; round++) {
          const more = await step.do(`coverage-${siteId}-${round}`, { retries: { limit: 1, delay: "1 minute" } }, async () => {
            const { token } = await googleAccess(this.env, siteId).connect();
            const result = await inspectSitemapUrls(this.env.DB, siteId, site.gscProperty!, token, new Date().toISOString().slice(0, 10), COVERAGE_STEP);
            return result.remaining;
          });
          if (!more) break;
        }
      }
```

Import `inspectSitemapUrls, COVERAGE_STEP` from `./results-sync`. The first step's per-site `try/catch` already protects the other sites; a thrown coverage step fails only its own retry.

- [ ] **Step 6: Typecheck and commit**

Run: `cd apps/web && npx tsc --noEmit -p . && npm test`

```bash
git add apps/web/src/results-sync.ts apps/web/src/results-sync.test.ts apps/web/src/search-sync-workflow.ts
git commit -m "Inspect sitemap URLs with Google: 200 per sync, up to 1,800 a day"
```

---

### Task 8: "Has Google crawled your pages?" on the Search tab

**Files:**
- Create: `apps/web/app/api/sites/[siteId]/index-coverage/route.ts`
- Modify: `apps/web/app/components/ReportTabs.tsx`
- Modify: `apps/web/app/components/OverviewView.tsx` (pass `siteId` and `searchConnected`)
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `indexCoverage`, `IndexCoverage` (Task 6); `COVERAGE_CLASSES`, `CoverageClass` (Task 1); `familyLabel` from `./report-model`.
- Produces: `GET /api/sites/:siteId/index-coverage` returns `{ coverage: IndexCoverage | null; connected: boolean }`.

Before editing UI, load the Impeccable context for `apps/web/app/components/ReportTabs.tsx` and re-read `reference/craft-floor.md`.

- [ ] **Step 1: The route** `apps/web/app/api/sites/[siteId]/index-coverage/route.ts`

```ts
import { env } from "cloudflare:workers";
import { getSite, indexCoverage } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";

/** What Google did with the site's sitemap URLs so far (URL Inspection, a few hundred a day). */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ coverage: await indexCoverage(env.DB, siteId, new Date()), connected: Boolean(site.gscProperty) });
}
```

- [ ] **Step 2: The card.** Add to `ReportTabs.tsx`:

```tsx
const COVERAGE_LABEL: Record<CoverageClass, string> = {
  indexed: "Indexed", crawled: "Crawled, not indexed", discovered: "Discovered, not crawled", unknown: "Unknown to Google", excluded: "Excluded",
};

/** A stacked bar of what Google did with checked URLs, in the class order. */
function CoverageBar({ byClass, checked }: { byClass: Record<CoverageClass, number>; checked: number }) {
  return (
    <span className="coverage-bar" role="img" aria-label={COVERAGE_CLASSES.map((name) => `${COVERAGE_LABEL[name]} ${byClass[name]}`).join(", ")}>
      {checked > 0 && COVERAGE_CLASSES.map((name) => byClass[name] > 0 && <i key={name} className={`cov-${name}`} style={{ width: `${(byClass[name] / checked) * 100}%` }} title={`${COVERAGE_LABEL[name]}: ${formatNumber(byClass[name])}`} />)}
    </span>
  );
}

/** How many sitemap URLs Google has crawled and indexed, from URL Inspection a few hundred a day. */
function IndexCoverageCard({ siteId, onNavigate }: { siteId: string; onNavigate: Navigate }) {
  const [data, setData] = useState<{ coverage: IndexCoverage | null; connected: boolean } | null>(null);
  useEffect(() => { api<{ coverage: IndexCoverage | null; connected: boolean }>(`/api/sites/${siteId}/index-coverage`).then(setData).catch(() => setData(null)); }, [siteId]);
  if (!data) return null;
  const title = "Has Google crawled your pages?";
  if (!data.connected) return <Card title={title}><p className="empty-state">Connect Search Console to ask Google about each sitemap URL.</p><Button small variant="secondary" onClick={() => onNavigate("connections")}>Open Setup</Button></Card>;
  const coverage = data.coverage;
  if (!coverage || coverage.checked === 0) return <Card title={title} subtitle="Google is asked about a few hundred sitemap URLs a day."><p className="empty-state">No URLs checked yet. The first ones are checked on the next sync.</p></Card>;
  const days = Math.ceil((coverage.total - coverage.checked) / 1800);
  return (
    <Card title={title} subtitle={`Checked ${formatNumber(coverage.checked)} of ${formatNumber(coverage.total)} sitemap URLs with Google.${days > 0 ? ` About ${days} more day${days === 1 ? "" : "s"} until every URL is checked once.` : " Every URL has been checked; each is checked again after 30 days."}`}>
      <CoverageBar byClass={coverage.byClass} checked={coverage.checked} />
      <div className="chart-legend coverage-legend">
        {COVERAGE_CLASSES.map((name) => <span key={name} className={`cov-${name}`}>{COVERAGE_LABEL[name]} {formatNumber(coverage.byClass[name])} · {Math.round((coverage.byClass[name] / coverage.checked) * 100)}%</span>)}
      </div>
      <p className="small muted">{formatNumber(coverage.recentlyCrawled)} of the checked URLs ({Math.round((coverage.recentlyCrawled / coverage.checked) * 100)}%) were crawled by Google in the last 30 days. Shares are of checked URLs.</p>
      <table className="table coverage-table">
        <thead><tr><th>Page type</th><th className="num">Checked</th><th>What Google did</th></tr></thead>
        <tbody>{coverage.families.map((family) => (
          <tr key={family.family}>
            <td><code>{familyLabel(family.family)}</code></td>
            <td className="num">{formatNumber(family.checked)} of {formatNumber(family.total)}</td>
            <td><CoverageBar byClass={family.byClass} checked={family.checked} /></td>
          </tr>
        ))}</tbody>
      </table>
    </Card>
  );
}
```

Imports to add to `ReportTabs.tsx`:
- `useEffect, useState` from `react`;
- `COVERAGE_CLASSES, type CoverageClass` from `@organic-growth/core`;
- `type IndexCoverage` from `@organic-growth/db`;
- `api` from `./api` (merge with the existing `formatNumber` import).

`Navigate` already accepts `"connections"`, which `page.tsx` resolves to Setup.

`SearchTab` takes a new `siteId: string` prop and renders `<IndexCoverageCard siteId={siteId} onNavigate={onNavigate} />`:
- first in its returned `results` div, when `report.search` exists;
- in a fragment after the "No search data yet" card otherwise.

In `OverviewView.tsx`, change the call to `<SearchTab siteId={site.id} report={report} onNavigate={onNavigate} />`.

- [ ] **Step 3: Styles** in `globals.css`, next to `.top-queries`:

```css
.coverage-bar { display: flex; height: 10px; width: 100%; min-width: 120px; background: var(--track); }
.coverage-bar i { display: block; height: 100%; }
.cov-indexed { --c: var(--green); } .coverage-bar .cov-indexed { background: var(--green); }
.cov-crawled { --c: var(--amber-fill); } .coverage-bar .cov-crawled { background: var(--amber-fill); }
.cov-discovered { --c: var(--series-sky); } .coverage-bar .cov-discovered { background: var(--series-sky); }
.cov-unknown { --c: var(--line-strong); } .coverage-bar .cov-unknown { background: var(--line-strong); }
.cov-excluded { --c: var(--red); } .coverage-bar .cov-excluded { background: var(--red); }
.coverage-legend { margin: 10px 0 6px; }
.coverage-table { margin-top: 12px; }
.coverage-table td:last-child { width: 50%; }
```

If `--series-sky` isn't defined as a CSS custom property in `globals.css`, use the existing series token name; read the `:root` block for it.

- [ ] **Step 4: Typecheck, then check it renders after Task 9 seeds the demo**

Run: `cd apps/web && npx tsc --noEmit -p .`
Then capture `view=overview&tab=search` on the demo site at 1440 and 390, light and dark, with `cdpshots.py`. Fix what the capture shows in one batch.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/api/sites/[siteId]/index-coverage/route.ts" apps/web/app/components/ReportTabs.tsx apps/web/app/components/OverviewView.tsx apps/web/app/globals.css
git commit -m "Search tab: how many sitemap URLs Google has crawled and indexed"
```

---

### Task 9: Demo data, local migration, real run, and wrap-up

**Files:**
- Modify: `packages/agents/src/demo.ts` (`seedDemoResults`)
- Modify: `packages/agents/src/demo.test.ts`

**Interfaces:**
- Consumes: `upsertMetricPoints`, `saveUrlIndexStatus`, and the metric names above.

- [ ] **Step 1: Write the failing demo assertion.** In `demo.test.ts`'s Results test, after the top-queries assertion:

```ts
    const signals = await listMetricSeries(db, DEMO_SITE_ID, ["crux_lcp_p75.phone", "crux_lcp_p75.desktop", "lab_score_eumon.phone", "authority", "authority:brightcare-dental.example"], addDays(today, -400), today);
    assert.ok(signals["crux_lcp_p75.phone"]!.length >= 20 && signals["crux_lcp_p75.desktop"]!.length >= 20, "weekly speed history for both form factors");
    assert.ok(signals["lab_score_eumon.phone"]!.length && signals.authority!.length && signals["authority:brightcare-dental.example"]!.length);
    const coverage = await db.prepare("SELECT COUNT(*) AS n FROM url_index_status WHERE site_id = ?").bind(DEMO_SITE_ID).first<{ n: number }>();
    assert.ok(Number(coverage?.n) > 300, "a sample of sitemap URLs checked with Google");
```

The demo's competitor domains are set in `seedDemoSite`; read them there. If they differ from `brightcare-dental.example`, use the first one.

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w @organic-growth/agents`
Expected: FAIL, because the series are empty.

- [ ] **Step 3: Implement in `seedDemoResults`**, before `syncFirstPartyResults`. All the data is fictional, and the site is labelled as demo already.

```ts
  // Fictional real-user speed: 30 weeks for phones and desktops, phones slower, both improving after go-live.
  const speed: MetricPoint[] = [{ metric: "sync.crux", day: today, value: 1 }];
  for (let week = 29; week >= 0; week--) {
    const day = addDays(today, -2 - week * 7);
    const after = day >= addDays(today, -80) ? 0.8 : 1;
    speed.push(
      { metric: "crux_lcp_p75.phone", day, value: Math.round(4300 * after + (week % 4) * 60) },
      { metric: "crux_lcp_p75.desktop", day, value: Math.round(2300 * after + (week % 3) * 40) },
      { metric: "crux_inp_p75.phone", day, value: Math.round(320 * after) },
      { metric: "crux_inp_p75.desktop", day, value: Math.round(140 * after) },
      { metric: "crux_cls_p75.phone", day, value: 0.12 },
      { metric: "crux_cls_p75.desktop", day, value: 0.05 },
    );
  }
  const competitors = await listSiteCompetitorDomains(db, DEMO_SITE_ID);
  await upsertMetricPoints(db, DEMO_SITE_ID, [
    ...speed,
    { metric: "lab_score_home.phone", day: today, value: 41 }, { metric: "lab_score_home.desktop", day: today, value: 78 },
    { metric: "lab_score_eumon.phone", day: today, value: 96 }, { metric: "lab_score_eumon.desktop", day: today, value: 99 },
    ...[0, 1, 2, 3].map((month) => ({ metric: "authority", day: addDays(today, -month * 30), value: 1.6 + (3 - month) * 0.1 })),
    ...competitors.map((domain, index) => ({ metric: `authority:${domain}`, day: today, value: 2.4 - index * 0.9 })),
  ]);
  // Fictional URL Inspection results for a sample of the latest crawl's pages.
  const { results: sample } = await db.prepare(
    `SELECT url, COALESCE(json_extract(result_json, '$.routeFamily'), 'other') AS family FROM pages
     WHERE analysis_id = 'analysis_demo_2' AND crawl_state = 'complete' AND status < 400 ORDER BY url LIMIT 600`,
  ).all<{ url: string; family: string }>();
  const states = ["Submitted and indexed", "Submitted and indexed", "Submitted and indexed", "Crawled - currently not indexed", "Discovered - currently not indexed", "URL is unknown to Google"];
  await saveUrlIndexStatus(db, DEMO_SITE_ID, sample.map((row, index) => {
    const state = row.family === "prices" && index % 2 ? "Discovered - currently not indexed" : states[index % states.length]!;
    return { url: row.url, family: row.family, verdict: state === "Submitted and indexed" ? "PASS" : "NEUTRAL", coverageState: state, lastCrawlTime: state.startsWith("Submitted") || state.startsWith("Crawled") ? `${addDays(today, -(index % 40))}T02:00:00Z` : null };
  }));
```

Add `listSiteCompetitorDomains, saveUrlIndexStatus` to the demo's `@organic-growth/db` import. If `analysis_demo_2` isn't the demo's latest analysis id, read `seedDemoSite` for it.

- [ ] **Step 4: Run, build, and commit**

Run: `npm test -w @organic-growth/agents && npm run build -w @organic-growth/agents`
Expected: every test passes.

```bash
git add packages/agents/src/demo.ts packages/agents/src/demo.test.ts
git commit -m "Demo: speed, lab scores, authority, and Google coverage sample"
```

- [ ] **Step 5: Run it for real**
1. `npm run db:migrate:local`, which applies 0015 to the 5174 database.
2. `curl -X POST localhost:5174/api/dev/demo-site` to reseed the demo.
3. `curl -X POST localhost:5174/api/sites/site_00bc1f00-9f7e-4d65-bf40-fd442a3aa3ae/results/sync`, then check the notes include `speed: 40 weeks`, `lab: 2 scores` and `authority: 2 domains` (or the site's competitor count plus one), and `coverage: inspected 200`.
4. Capture the Performance page and the Search tab for both the demo and medbaycare.com in light, dark and phone widths, then do Task 5 step 4 and Task 8 step 4.

- [ ] **Step 6: The whole suite, then review**

Run: `npm test && (cd apps/web && npx tsc --noEmit -p .)`
Expected: every suite passes and there are no type errors.

Then:
- add 0015 to the memory note on migrations pending remotely (`migration-0009-pending.md` and its MEMORY.md line);
- dispatch the final whole-branch review (superpowers:requesting-code-review), and fix what it confirms.
