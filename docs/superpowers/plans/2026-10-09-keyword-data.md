# Keywords and Competitor Keywords Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Performance gains a "Keywords" card (your top keywords priced, keyword gaps competitors win, share of visibility), and the growth plan gets real search volume and difficulty plus "rank for this gap" opportunities, all from DataForSEO, synced monthly.

**Architecture:**
- **Store:** a generic `site_snapshots` table (kind, scope, period, rows) replaces the one-off `search_top_queries` table; keyword lists live there, trend counts (`kw_top10`, `kw_traffic`) in the `metric_points` ledger.
- **Sync:** two new `Source`s in `apps/web/src/results-sources.ts` with a new **monthly** cadence in the runner: *competitor keywords* (DataForSEO `ranked_keywords` for the site and each competitor, per market) and *keyword volumes* (the site's Search Console queries priced by `keyword_overview`).
- **Views:** pure keyword math in `packages/core/src/keywords.ts` (`keywordGaps`, `keywordsView`, `demandFromSnapshots`); `resultsView` gains `keywords`; a `KeywordsCard` is the first card module under `apps/web/app/components/results/`.
- **Growth plan:** `estimateDemand` takes a `KeywordDemand` lookup; `gapOpportunities` turns the biggest gaps into opportunities; the analysis workflow loads both from the snapshots.

**Tech Stack:** TypeScript, Cloudflare Workers/D1/Workflows, vinext, React 19. Tests: `node:test`; SQLite through `openSqliteD1` (every migration applied).

**Spec:** `docs/superpowers/specs/2026-10-09-keyword-data-design.md`

## Global Constraints

- **Branch:** `claude/keyword-data`. Commit after each task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never push; never run `npm run db:migrate:remote`.
- **DataForSEO:** Basic auth from `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD`; base `https://api.dataforseo.com/v3/dataforseo_labs/google/<endpoint>/live`; **one task per request**; `ranked_keywords` `limit: 1000`; `keyword_overview` at most 700 keywords, `location_code` and `language_code` required. Location = `2000 + ISO 3166-1 numeric` (verified against DataForSEO's country list on 2026-10-09; 12 countries in our table are not covered and must fail with a note, never a crash).
- **Cadence:** monthly = the marker is absent or 28 or more days old. No forced refresh.
- **Missing credentials or markets are notes, never failures.** Credentials missing: skipped silently except the card's operator hint. Markets missing: "<source>: set target markets in Setup".
- **Every ledger metric a sync writes is declared** in `METRICS` (core); the existing guard test in `apps/web/src/results-sync.test.ts` enforces it.
- **Copy:** plain English, no exclamation marks; numbers formatted with `formatNumber`; "—" for unknown.
- **Spec amendments** (made in Task 1): location by numeric code instead of `location_name`; only the new card is a module (`KeywordsCard.tsx`), existing cards move out when next touched.
- Run `npm run typecheck` and `npm test` from the repo root before every commit; both must be clean.

## Review Focus

1. **A competitor DataForSEO doesn't know** (200 with zero items): its snapshot is saved empty, its visibility bar reads 0 visits (not "—"), and it adds no gaps. Pinned in Task 6.
2. **The same keyword in two markets** with different volumes: the site's list keeps one row, the higher volume. Pinned in Task 3.
3. **A target market DataForSEO doesn't cover** (e.g. `mmr`): that market is skipped with a note and the other markets still sync. Pinned in Task 6.
4. **Search Console queries with capitals** ("Dr Amy Tan"): priced by matching DataForSEO's lowercase keyword, so they aren't all left unpriced. Pinned in Task 6.
5. **A site whose `baseUrl` has `www.`**: the site's own ranked list is saved and read under the bare domain, so its row isn't mistaken for a competitor and its keywords count as its own. Pinned in Task 7.

---

### Task 1: Country numeric codes, and two spec amendments

**Files:**
- Modify: `packages/core/src/countries.ts`
- Create: `packages/core/src/countries.test.ts`
- Modify: `docs/superpowers/specs/2026-10-09-keyword-data-design.md` (two sentences)

**Interfaces:**
- Produces: `COUNTRIES: Array<{ code: string; name: string; numeric: number }>`; `countryNumeric(code: string): number | null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/countries.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COUNTRIES, countryName, countryNumeric } from "./countries.js";

describe("countries", () => {
  it("knows each market's ISO numeric code, for DataForSEO's locations", () => {
    assert.equal(countryNumeric("idn"), 360);
    assert.equal(countryNumeric("MYS"), 458);
    assert.equal(countryNumeric("xyz"), null);
    assert.ok(COUNTRIES.every((country) => Number.isInteger(country.numeric) && country.numeric > 0));
    assert.equal(countryName("sgp"), "Singapore");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/core && npm test 2>&1 | grep -E "error TS|not ok|# (pass|fail)"`
Expected: `error TS2305: Module './countries.js' has no exported member 'countryNumeric'`.

- [ ] **Step 3: Add the numeric codes**

Replace the table and add the helper in `packages/core/src/countries.ts`:

```ts
/**
 * Countries as Search Console reports them (ISO 3166-1 alpha-3, lower case),
 * with English names and ISO numeric codes: the markets most sites target.
 * Codes outside this list are still accepted and shown as-is. DataForSEO's
 * Google location for a country is 2000 + its numeric code.
 */
export const COUNTRIES: Array<{ code: string; name: string; numeric: number }> = [
  { code: "idn", name: "Indonesia", numeric: 360 }, { code: "mys", name: "Malaysia", numeric: 458 }, { code: "sgp", name: "Singapore", numeric: 702 }, { code: "tha", name: "Thailand", numeric: 764 },
  { code: "vnm", name: "Vietnam", numeric: 704 }, { code: "phl", name: "Philippines", numeric: 608 }, { code: "brn", name: "Brunei", numeric: 96 }, { code: "khm", name: "Cambodia", numeric: 116 },
  { code: "mmr", name: "Myanmar", numeric: 104 }, { code: "lao", name: "Laos", numeric: 418 }, { code: "chn", name: "China", numeric: 156 }, { code: "hkg", name: "Hong Kong", numeric: 344 },
  { code: "twn", name: "Taiwan", numeric: 158 }, { code: "jpn", name: "Japan", numeric: 392 }, { code: "kor", name: "South Korea", numeric: 410 }, { code: "ind", name: "India", numeric: 356 },
  { code: "pak", name: "Pakistan", numeric: 586 }, { code: "bgd", name: "Bangladesh", numeric: 50 }, { code: "lka", name: "Sri Lanka", numeric: 144 }, { code: "npl", name: "Nepal", numeric: 524 },
  { code: "aus", name: "Australia", numeric: 36 }, { code: "nzl", name: "New Zealand", numeric: 554 }, { code: "usa", name: "United States", numeric: 840 }, { code: "can", name: "Canada", numeric: 124 },
  { code: "mex", name: "Mexico", numeric: 484 }, { code: "bra", name: "Brazil", numeric: 76 }, { code: "arg", name: "Argentina", numeric: 32 }, { code: "col", name: "Colombia", numeric: 170 },
  { code: "chl", name: "Chile", numeric: 152 }, { code: "gbr", name: "United Kingdom", numeric: 826 }, { code: "irl", name: "Ireland", numeric: 372 }, { code: "deu", name: "Germany", numeric: 276 },
  { code: "fra", name: "France", numeric: 250 }, { code: "esp", name: "Spain", numeric: 724 }, { code: "ita", name: "Italy", numeric: 380 }, { code: "nld", name: "Netherlands", numeric: 528 },
  { code: "bel", name: "Belgium", numeric: 56 }, { code: "che", name: "Switzerland", numeric: 756 }, { code: "aut", name: "Austria", numeric: 40 }, { code: "swe", name: "Sweden", numeric: 752 },
  { code: "nor", name: "Norway", numeric: 578 }, { code: "dnk", name: "Denmark", numeric: 208 }, { code: "fin", name: "Finland", numeric: 246 }, { code: "pol", name: "Poland", numeric: 616 },
  { code: "prt", name: "Portugal", numeric: 620 }, { code: "tur", name: "Turkey", numeric: 792 }, { code: "rus", name: "Russia", numeric: 643 }, { code: "ukr", name: "Ukraine", numeric: 804 },
  { code: "are", name: "United Arab Emirates", numeric: 784 }, { code: "sau", name: "Saudi Arabia", numeric: 682 }, { code: "qat", name: "Qatar", numeric: 634 }, { code: "kwt", name: "Kuwait", numeric: 414 },
  { code: "omn", name: "Oman", numeric: 512 }, { code: "egy", name: "Egypt", numeric: 818 }, { code: "nga", name: "Nigeria", numeric: 566 }, { code: "ken", name: "Kenya", numeric: 404 },
  { code: "zaf", name: "South Africa", numeric: 710 }, { code: "isr", name: "Israel", numeric: 376 },
];

export function countryName(code: string): string {
  return COUNTRIES.find((country) => country.code === code.toLowerCase())?.name ?? code.toUpperCase();
}

/** ISO 3166-1 numeric code, or null for a country outside the table. */
export function countryNumeric(code: string): number | null {
  return COUNTRIES.find((country) => country.code === code.toLowerCase())?.numeric ?? null;
}
```

- [ ] **Step 4: Run the core tests**

Run: `cd packages/core && npm test 2>&1 | grep -E "not ok|# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Amend the spec**

In `docs/superpowers/specs/2026-10-09-keyword-data-design.md`:
- Replace the **Location** bullet with: `- **Location:** \`location_code\` = 2000 + the market's ISO 3166-1 numeric code (\`countryNumeric\` in \`packages/core/src/countries.ts\`); the rule matches DataForSEO's country list. A market DataForSEO doesn't cover (Myanmar, Hong Kong, Taiwan, China, Nepal, Turkey, Russia, Qatar, Kuwait, Oman, Brunei, Laos) is skipped with a note.`
- Replace the last two sentences of section 3 (from "This is the first new card") with: `\`KeywordsCard.tsx\` under \`apps/web/app/components/results/\` is the first card module; the existing cards move out of \`ResultsView.tsx\` when they are next touched.`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/countries.ts packages/core/src/countries.test.ts docs/superpowers/specs/2026-10-09-keyword-data-design.md
git commit -m "Add ISO numeric codes to the country table, for DataForSEO's locations" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The snapshot store

**Files:**
- Create: `packages/db/migrations/0016_site_snapshots.sql`
- Create: `packages/db/src/snapshots.ts`
- Create: `packages/db/src/snapshots.test.ts`
- Modify: `packages/db/src/metrics.ts` (remove the top-queries functions and `QueryScope`; add `lastMetricDay`)
- Modify: `packages/db/src/metrics.test.ts` (move the "top queries" describe to the new test file)
- Modify: `packages/db/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `saveSnapshot<T>(db, siteId, { kind: string; scope: string; periodEnd: string; rows: T[] }): Promise<void>`
  - `getSnapshot<T>(db, siteId, kind: string, scope: string): Promise<{ periodEnd: string; rows: T[] } | null>`
  - `listSnapshots<T>(db, siteId, kind: string): Promise<Array<{ scope: string; periodEnd: string; rows: T[] }>>`
  - `saveTopQueriesSnapshot` / `getTopQueriesSnapshot` keep their signatures (kind `top_queries`, scope `<property>|<sorted markets>`).
  - `lastMetricDay(db, siteId, metric): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/db/src/snapshots.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getSnapshot, getTopQueriesSnapshot, lastMetricDay, listSnapshots, saveSnapshot, saveTopQueriesSnapshot, upsertMetricPoints, upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const now = "2026-10-09T00:00:00.000Z";

describe("snapshots", () => {
  it("keeps one list per kind and scope, replaced by each save", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|idn", periodEnd: "2026-10-01", rows: [{ keyword: "a" }] });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|idn", periodEnd: "2026-10-09", rows: [{ keyword: "b" }] });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|mys", periodEnd: "2026-10-09", rows: [] });
    assert.deepEqual(await getSnapshot(db, "s", "competitor_keywords", "rival.example|idn"), { periodEnd: "2026-10-09", rows: [{ keyword: "b" }] });
    assert.equal(await getSnapshot(db, "s", "keywords", "rival.example|idn"), null, "another kind");
    assert.deepEqual((await listSnapshots(db, "s", "competitor_keywords")).map((entry) => entry.scope), ["rival.example|idn", "rival.example|mys"]);
  });

  it("keeps the latest top-queries list per site, and only for the property and markets it was fetched for", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    const rows = [{ query: "q", clicks: 3, impressions: 40, position: 6, before: null }];
    await saveTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: ["sgp", "mys"], periodEnd: "2026-10-04", rows });
    await saveTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: ["mys", "sgp"], periodEnd: "2026-10-05", rows });
    assert.deepEqual(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: ["mys", "sgp"] }), { periodEnd: "2026-10-05", rows });
    assert.equal(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:other.com", markets: ["mys", "sgp"] }), null, "another property's queries");
    assert.equal(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: [] }), null, "fetched for other markets");
  });

  it("carries the old top-queries table into the store when the migration runs", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await db.prepare("CREATE TABLE search_top_queries (site_id TEXT PRIMARY KEY, property TEXT NOT NULL, markets TEXT NOT NULL, period_end TEXT NOT NULL, rows_json TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
    await db.prepare("INSERT INTO search_top_queries VALUES ('s', 'sc-domain:x.com', 'mys,sgp', '2026-10-04', '[]', ?)").bind(now).run();
    const migration = readFileSync(new URL("../migrations/0016_site_snapshots.sql", import.meta.url), "utf8");
    for (const statement of migration.split(";").map((sql) => sql.trim()).filter(Boolean)) await db.prepare(statement).run();
    assert.deepEqual(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: ["sgp", "mys"] }), { periodEnd: "2026-10-04", rows: [] });
  });

  it("knows the last day a metric was written", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    assert.equal(await lastMetricDay(db, "s", "sync.competitor_keywords"), null);
    await upsertMetricPoints(db, "s", [{ metric: "sync.competitor_keywords", day: "2026-09-01", value: 1 }, { metric: "sync.competitor_keywords", day: "2026-09-29", value: 1 }]);
    assert.equal(await lastMetricDay(db, "s", "sync.competitor_keywords"), "2026-09-29");
  });
});
```

Also delete the `describe("top queries", …)` block from `packages/db/src/metrics.test.ts` (it moves here), and remove `getTopQueriesSnapshot, saveTopQueriesSnapshot` from that file's import if nothing else uses them.

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/db && npm test 2>&1 | grep -E "error TS|not ok|# (pass|fail)" | head`
Expected: `error TS2305 … has no exported member 'saveSnapshot'` (and `lastMetricDay`, `listSnapshots`, `getSnapshot`).

- [ ] **Step 3: Write the migration**

```sql
-- packages/db/migrations/0016_site_snapshots.sql
-- Latest lists that replace themselves (top queries, keyword lists): one row per
-- site, kind and scope. The scope says what made the list (property, markets,
-- competitor domain), so a list fetched for something else is never read.
CREATE TABLE IF NOT EXISTS site_snapshots (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  period_end TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, kind, scope)
);
INSERT OR REPLACE INTO site_snapshots (site_id, kind, scope, period_end, rows_json, updated_at)
  SELECT site_id, 'top_queries', property || '|' || markets, period_end, rows_json, updated_at FROM search_top_queries;
DROP TABLE IF EXISTS search_top_queries;
```

- [ ] **Step 4: Write the store**

```ts
// packages/db/src/snapshots.ts
import type { TopQuery } from "@organic-growth/core";
import { nowIso, type D1Like } from "./d1.js";

/*
 * Snapshots: lists that replace themselves (the Results spec's "latest list"),
 * beside the ledger's numbers over time. One row per site, kind and scope.
 */

export type Snapshot<T> = { periodEnd: string; rows: T[] };

/** Replaces the list of this kind and scope. */
export async function saveSnapshot<T>(db: D1Like, siteId: string, input: { kind: string; scope: string; periodEnd: string; rows: T[] }): Promise<void> {
  await db.prepare(
    `INSERT INTO site_snapshots (site_id, kind, scope, period_end, rows_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, kind, scope) DO UPDATE SET period_end = excluded.period_end, rows_json = excluded.rows_json, updated_at = excluded.updated_at`,
  ).bind(siteId, input.kind, input.scope, input.periodEnd, JSON.stringify(input.rows), nowIso()).run();
}

export async function getSnapshot<T>(db: D1Like, siteId: string, kind: string, scope: string): Promise<Snapshot<T> | null> {
  const row = await db.prepare("SELECT period_end, rows_json FROM site_snapshots WHERE site_id = ? AND kind = ? AND scope = ?")
    .bind(siteId, kind, scope).first<{ period_end: string; rows_json: string }>();
  return row ? { periodEnd: row.period_end, rows: JSON.parse(row.rows_json) as T[] } : null;
}

/** Every list of one kind, by scope. */
export async function listSnapshots<T>(db: D1Like, siteId: string, kind: string): Promise<Array<Snapshot<T> & { scope: string }>> {
  const { results } = await db.prepare("SELECT scope, period_end, rows_json FROM site_snapshots WHERE site_id = ? AND kind = ? ORDER BY scope")
    .bind(siteId, kind).all<{ scope: string; period_end: string; rows_json: string }>();
  return results.map((row) => ({ scope: row.scope, periodEnd: row.period_end, rows: JSON.parse(row.rows_json) as T[] }));
}

/** Which fetch a top-queries list belongs to: a different property or set of markets makes it stale. */
export type QueryScope = { property: string; markets: string[] };
const queryScope = ({ property, markets }: QueryScope) => `${property}|${[...markets].sort().join(",")}`;

export const saveTopQueriesSnapshot = (db: D1Like, siteId: string, input: QueryScope & { periodEnd: string; rows: TopQuery[] }) =>
  saveSnapshot(db, siteId, { kind: "top_queries", scope: queryScope(input), periodEnd: input.periodEnd, rows: input.rows });

export const getTopQueriesSnapshot = (db: D1Like, siteId: string, scope: QueryScope) => getSnapshot<TopQuery>(db, siteId, "top_queries", queryScope(scope));
```

In `packages/db/src/metrics.ts`: delete everything from the `/** Which fetch a top-queries list belongs to …` comment to the end of `getTopQueriesSnapshot` (the `QueryScope` type, `scopeKey`, both functions), drop `type TopQuery` from its core import if now unused, and add after `firstMetricDay`:

```ts
/** The last day a metric was written, or null if never. */
export async function lastMetricDay(db: D1Like, siteId: string, metric: string): Promise<string | null> {
  const row = await db.prepare("SELECT MAX(day) AS day FROM metric_points WHERE site_id = ? AND metric = ?").bind(siteId, metric).first<{ day: string | null }>();
  return row?.day ?? null;
}
```

In `packages/db/src/index.ts`, after `export * from "./coverage.js";` add `export * from "./snapshots.js";`.

- [ ] **Step 5: Run the db tests and the full suite**

Run: `cd packages/db && npm test 2>&1 | grep -E "not ok|# (pass|fail)"` then from the root `npm run typecheck && npm test 2>&1 | grep -E "^# fail" | sort | uniq -c`
Expected: all `# fail 0`. The demo seeding and the Results sync still save top queries through the moved functions.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0016_site_snapshots.sql packages/db/src/snapshots.ts packages/db/src/snapshots.test.ts packages/db/src/metrics.ts packages/db/src/metrics.test.ts packages/db/src/index.ts
git commit -m "One snapshot store for latest lists; top queries move into it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Keyword math in core

**Files:**
- Create: `packages/core/src/keywords.ts`
- Create: `packages/core/src/keywords.test.ts`
- Modify: `packages/core/src/results.ts` (`METRICS.keywords`, `ResultsInput.keywords`, `ResultsView.keywords`)
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Produces (all pure):
  - `type RankedKeyword = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; position: number; url: string; traffic: number }`
  - `type PricedKeyword = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; position: number; clicks: number; impressions: number }`
  - `type KeywordsInput = { site: string; competitors: string[]; synced: boolean; priced: Array<{ periodEnd: string; rows: PricedKeyword[] }>; ranked: Array<{ domain: string; periodEnd: string; rows: RankedKeyword[] }> }`
  - `type KeywordGap = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; domain: string; position: number; url: string }`
  - `keywordGaps(input: KeywordsInput): KeywordGap[]` (every gap, highest volume first)
  - `keywordsView(input: KeywordsInput): { asOf: string | null; synced: boolean; top: PricedKeyword[]; gaps: KeywordGap[] }`
  - `demandFromSnapshots(priced: PricedKeyword[]): KeywordDemand`, with `type KeywordDemand = { lookup(query: string): { volume: number | null; difficulty: number | null; intent: string | null } | null }`
  - `ResultsView.keywords: KeywordsView` where `type KeywordsView = ReturnType<typeof keywordsView> & { visibility: Array<{ domain: string; traffic: number | null; top10: number | null; share: number | null }> }`
  - `METRICS.keywords = ["sync.competitor_keywords", "sync.keyword_volumes", "kw_top10", "kw_traffic"]` (plus `kw_top10:<domain>`, `kw_traffic:<domain>` per competitor, read like `authority:<domain>`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/keywords.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demandFromSnapshots, keywordGaps, keywordsView, type KeywordsInput, type PricedKeyword, type RankedKeyword } from "./keywords.js";
import { METRICS, resultsView } from "./results.js";

const priced = (keyword: string, volume: number | null, clicks: number, extra: Partial<PricedKeyword> = {}): PricedKeyword =>
  ({ keyword, volume, difficulty: 20, intent: "commercial", position: 8, clicks, impressions: clicks * 20, ...extra });
const ranked = (keyword: string, volume: number, position: number, extra: Partial<RankedKeyword> = {}): RankedKeyword =>
  ({ keyword, volume, difficulty: 10, intent: "commercial", position, url: `/${keyword.replace(/ /g, "-")}`, traffic: volume / position, ...extra });

const input: KeywordsInput = {
  site: "x.com", competitors: ["rival.example", "other.example"], synced: true,
  priced: [
    { periodEnd: "2026-10-06", rows: [priced("dentist kl", 1900, 40), priced("braces price", 2400, 30)] },
    { periodEnd: "2026-10-06", rows: [priced("dentist kl", 880, 5), priced("invisalign sg", null, 12)] },
  ],
  ranked: [
    { domain: "x.com", periodEnd: "2026-10-09", rows: [ranked("x clinic", 100, 1)] },
    { domain: "rival.example", periodEnd: "2026-10-09", rows: [ranked("veneers price", 3600, 3), ranked("dentist kl", 1900, 2), ranked("x clinic", 100, 9)] },
    { domain: "other.example", periodEnd: "2026-10-09", rows: [ranked("veneers price", 3600, 7), ranked("root canal cost", 590, 4)] },
  ],
};

describe("keyword gaps", () => {
  it("lists competitor keywords the site appears for nowhere, best-placed competitor first, by volume", () => {
    assert.deepEqual(keywordGaps(input).map((gap) => [gap.keyword, gap.domain, gap.position]), [["veneers price", "rival.example", 3], ["root canal cost", "other.example", 4]]);
  });
});

describe("keywordsView", () => {
  const view = keywordsView(input);
  it("keeps one row per keyword across markets, the higher volume, ordered by clicks", () => {
    assert.deepEqual(view.top.map((row) => [row.keyword, row.volume, row.clicks]), [["dentist kl", 1900, 40], ["braces price", 2400, 30], ["invisalign sg", null, 12]]);
  });
  it("dates the card by the newest list", () => {
    assert.equal(view.asOf, "2026-10-09");
    assert.equal(keywordsView({ ...input, priced: [], ranked: [], synced: false }).asOf, null);
  });
});

describe("demandFromSnapshots", () => {
  it("answers a query with its highest volume across markets, and null for an unknown one", () => {
    const demand = demandFromSnapshots(input.priced.flatMap((list) => list.rows));
    assert.deepEqual(demand.lookup("Dentist KL"), { volume: 1900, difficulty: 20, intent: "commercial" });
    assert.equal(demand.lookup("never seen"), null);
  });
});

describe("resultsView keywords", () => {
  it("shares visibility by estimated traffic, you first, and declares the keyword metrics", () => {
    const today = "2026-10-09";
    const view = resultsView({
      today, goLive: null, markets: ["mys"], published: 0, index: { indexed: 0, notIndexed: 0, unchecked: 0 }, searchConnected: true, ga4Connected: false,
      competitors: ["rival.example"], keywords: { ...input, competitors: ["rival.example"] },
      series: { kw_traffic: [{ day: today, value: 100 }], "kw_traffic:rival.example": [{ day: today, value: 300 }], kw_top10: [{ day: today, value: 2 }], "kw_top10:rival.example": [{ day: today, value: 40 }] },
    });
    assert.deepEqual(view.keywords.visibility, [
      { domain: "x.com", traffic: 100, top10: 2, share: 0.25 },
      { domain: "rival.example", traffic: 300, top10: 40, share: 0.75 },
    ]);
    assert.equal(view.keywords.gaps[0]!.keyword, "veneers price");
    for (const metric of ["sync.competitor_keywords", "sync.keyword_volumes", "kw_top10", "kw_traffic"]) assert.ok(METRICS.keywords.includes(metric), metric);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/core && npm test 2>&1 | grep -E "error TS" | head -3`
Expected: `Cannot find module './keywords.js'`.

- [ ] **Step 3: Write the keyword math**

```ts
// packages/core/src/keywords.ts
/*
 * Keyword lists from DataForSEO, and what the Performance card and the growth
 * plan derive from them. Pure: the API, the client link, the analysis and the
 * tests compute the same gaps.
 */

/** One of a domain's ranked keywords in a market (DataForSEO `ranked_keywords`). */
export type RankedKeyword = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; position: number; url: string; traffic: number };
/** One of the site's Search Console queries with DataForSEO's figures (`keyword_overview`); volume is null when DataForSEO doesn't know it. */
export type PricedKeyword = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; position: number; clicks: number; impressions: number };

export type KeywordsInput = {
  /** The site's domain without `www.`, as its own ranked list is scoped. */
  site: string;
  competitors: string[];
  /** Whether the keyword sources have run (their markers exist). */
  synced: boolean;
  /** The site's priced queries, one list per market. */
  priced: Array<{ periodEnd: string; rows: PricedKeyword[] }>;
  /** Ranked lists for the site and each competitor, one per domain and market. */
  ranked: Array<{ domain: string; periodEnd: string; rows: RankedKeyword[] }>;
};

export type KeywordGap = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null; domain: string; position: number; url: string };

export type KeywordDemand = { lookup(query: string): { volume: number | null; difficulty: number | null; intent: string | null } | null };

const byVolume = <T extends { volume: number | null }>(a: T, b: T) => (b.volume ?? 0) - (a.volume ?? 0);

/** The site's priced queries across markets: one row per keyword, the higher volume winning. */
function ownKeywords(input: KeywordsInput): Map<string, PricedKeyword> {
  const own = new Map<string, PricedKeyword>();
  for (const row of input.priced.flatMap((list) => list.rows)) {
    const key = row.keyword.toLowerCase();
    const seen = own.get(key);
    if (!seen || (row.volume ?? -1) > (seen.volume ?? -1)) own.set(key, row);
  }
  return own;
}

/** Competitor keywords the site appears for in neither of its lists; the best-placed competitor stands for each. Highest volume first. */
export function keywordGaps(input: KeywordsInput): KeywordGap[] {
  const has = new Set([...ownKeywords(input).keys(), ...input.ranked.filter((list) => list.domain === input.site).flatMap((list) => list.rows.map((row) => row.keyword.toLowerCase()))]);
  const gaps = new Map<string, KeywordGap>();
  for (const list of input.ranked) {
    if (list.domain === input.site) continue;
    for (const row of list.rows) {
      const key = row.keyword.toLowerCase();
      if (has.has(key)) continue;
      const seen = gaps.get(key);
      if (!seen || row.position < seen.position) gaps.set(key, { keyword: row.keyword, volume: row.volume, difficulty: row.difficulty, intent: row.intent, domain: list.domain, position: row.position, url: row.url });
    }
  }
  return [...gaps.values()].sort(byVolume);
}

/** What the Keywords card shows from the lists: the 25 queries with the most clicks, the 25 biggest gaps, and the data's date. */
export function keywordsView(input: KeywordsInput) {
  const asOf = [...input.priced, ...input.ranked].map((list) => list.periodEnd).sort().at(-1) ?? null;
  const top = [...ownKeywords(input).values()].sort((a, b) => b.clicks - a.clicks || byVolume(a, b)).slice(0, 25);
  return { asOf, synced: input.synced, top, gaps: keywordGaps(input).slice(0, 25) };
}

/** A lookup from the site's priced queries, for the growth plan. */
export function demandFromSnapshots(priced: PricedKeyword[]): KeywordDemand {
  const own = ownKeywords({ site: "", competitors: [], synced: true, priced: [{ periodEnd: "", rows: priced }], ranked: [] });
  return {
    lookup(query) {
      const row = own.get(query.toLowerCase());
      return row ? { volume: row.volume, difficulty: row.difficulty, intent: row.intent } : null;
    },
  };
}
```

In `packages/core/src/results.ts`:
- Import: `import { keywordsView, type KeywordsInput } from "./keywords.js";`
- In `METRICS`, after `authority`: `/** Plus \`kw_top10:<domain>\` and \`kw_traffic:<domain>\` for each current competitor. */\n  keywords: ["sync.competitor_keywords", "sync.keyword_volumes", "kw_top10", "kw_traffic"],`
- In `ResultsInput`, after `competitors?`: `/** The keyword lists, scoped to the current property, markets and competitors. */\n  keywords?: KeywordsInput;`
- Add the type: `export type KeywordsView = ReturnType<typeof keywordsView> & { visibility: Array<{ domain: string; traffic: number | null; top10: number | null; share: number | null }> };`
- In `ResultsView`, after `authority`: `keywords: KeywordsView;`
- In `resultsView`, before the `return`:

```ts
  const keywordLists = input.keywords ?? { site: "", competitors: input.competitors ?? [], synced: false, priced: [], ranked: [] };
  const visibilityRows = [
    { domain: keywordLists.site, traffic: latest(series.kw_traffic, today), top10: latest(series.kw_top10, today) },
    ...(input.competitors ?? []).map((domain) => ({ domain, traffic: latest(series[`kw_traffic:${domain}`], today), top10: latest(series[`kw_top10:${domain}`], today) })),
  ];
  const visibleTotal = visibilityRows.reduce((total, row) => total + (row.traffic ?? 0), 0);
  const keywords = { ...keywordsView(keywordLists), visibility: visibilityRows.map((row) => ({ ...row, share: visibleTotal && row.traffic !== null ? row.traffic / visibleTotal : null })) };
```
and `keywords` joins the returned object after `speed, lab, authority`.

In `packages/core/src/index.ts` add `export * from "./keywords.js";`.

- [ ] **Step 4: Run the core tests**

Run: `cd packages/core && npm test 2>&1 | grep -E "not ok|# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Typecheck the repo (the view type grew)**

Run: `npm run typecheck 2>&1 | grep -E "error TS" | head`
Expected: no output. (`ResultsView.tsx` doesn't read `keywords` yet; that's Task 8.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/keywords.ts packages/core/src/keywords.test.ts packages/core/src/results.ts packages/core/src/index.ts
git commit -m "Keyword gaps, the site's priced keywords, and visibility share in the view model" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The DataForSEO client

**Files:**
- Create: `packages/agents/src/dataforseo.ts`
- Create: `packages/agents/src/dataforseo.test.ts`
- Modify: `packages/agents/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `type DataForSeoAuth = { login: string; password: string }`
  - `dataForSeoLocation(numeric: number): number` (= 2000 + numeric)
  - `fetchRankedKeywords(auth, domain: string, location: number, fetchFn?): Promise<RankedKeyword[]>`
  - `fetchKeywordOverview(auth, keywords: string[], location: number, language: string, fetchFn?): Promise<Array<{ keyword: string; volume: number | null; difficulty: number | null; intent: string | null }>>`
  - `rankedKeywordRows(result: unknown): RankedKeyword[]`, `keywordOverviewRows(result: unknown)` (parsers, for tests and the sources)

- [ ] **Step 1: Write the failing tests** (fixtures trimmed from real answers captured on 2026-10-09)

```ts
// packages/agents/src/dataforseo.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dataForSeoLocation, fetchKeywordOverview, fetchRankedKeywords } from "./dataforseo.js";

const auth = { login: "me@example.com", password: "secret" };
const envelope = (task: object) => JSON.stringify({ version: "0.1.20260917", status_code: 20000, status_message: "Ok.", cost: 0.0132, tasks_count: 1, tasks_error: 0, tasks: [task] });

const rankedTask = {
  status_code: 20000, status_message: "Ok.", cost: 0.0132,
  result: [{ se_type: "google", target: "medbaycare.com", location_code: 2360, language_code: null, total_count: 20, items_count: 2,
    metrics: { organic: { pos_1: 0, pos_2_3: 0, pos_4_10: 0, pos_11_20: 1, count: 20, etv: 28.51 } },
    items: [
      { se_type: "google", keyword_data: { keyword: "mahkota medical centre", keyword_info: { search_volume: 2900, cpc: 0.2, competition: 0.1 }, keyword_properties: { keyword_difficulty: 16 }, search_intent_info: { main_intent: "navigational" } },
        ranked_serp_element: { se_type: "google", serp_item: { type: "organic", rank_group: 21, rank_absolute: 23, relative_url: "/id/hospitals/mahkota-medical-centre", etv: 10.4 } } },
      { se_type: "google", keyword_data: { keyword: "loh guan lye hospital", keyword_info: { search_volume: 2400 }, keyword_properties: { keyword_difficulty: null }, search_intent_info: null },
        ranked_serp_element: { se_type: "google", serp_item: { type: "organic", rank_group: 43, rank_absolute: 45, relative_url: null, etv: null } } },
    ] }],
};

describe("DataForSEO client", () => {
  it("maps a country's numeric code to DataForSEO's location", () => {
    assert.equal(dataForSeoLocation(360), 2360);
  });

  it("asks for a domain's ranked keywords in a country and reads each row", async () => {
    const asked: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => { asked.push({ url, init }); return new Response(envelope(rankedTask)); }) as typeof fetch;
    const rows = await fetchRankedKeywords(auth, "medbaycare.com", 2360, fetchFn);
    assert.equal(asked[0]!.url, "https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live");
    assert.equal((asked[0]!.init!.headers as Record<string, string>).Authorization, `Basic ${btoa("me@example.com:secret")}`);
    assert.deepEqual(JSON.parse(String(asked[0]!.init!.body)), [{ target: "medbaycare.com", location_code: 2360, limit: 1000, order_by: ["keyword_data.keyword_info.search_volume,desc"] }]);
    assert.deepEqual(rows, [
      { keyword: "mahkota medical centre", volume: 2900, difficulty: 16, intent: "navigational", position: 21, url: "/id/hospitals/mahkota-medical-centre", traffic: 10.4 },
      { keyword: "loh guan lye hospital", volume: 2400, difficulty: null, intent: null, position: 43, url: "/", traffic: 0 },
    ]);
  });

  it("returns no rows for a domain DataForSEO doesn't know", async () => {
    const fetchFn = (async () => new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0.012, result: [{ total_count: null, items_count: 0, items: null, metrics: { organic: {} } }] }))) as unknown as typeof fetch;
    assert.deepEqual(await fetchRankedKeywords(auth, "nobody.example", 2360, fetchFn), []);
  });

  it("prices keywords in a country and language, leaving out the ones DataForSEO doesn't know", async () => {
    const task = { status_code: 20000, status_message: "Ok.", cost: 0.01212, result: [{ se_type: "google", location_code: 2360, language_code: "id", items_count: 1,
      items: [{ se_type: "google", keyword: "chf adalah", keyword_info: { search_volume: 12100, monthly_searches: [{ year: 2026, month: 9, search_volume: 12100 }] }, keyword_properties: { keyword_difficulty: 0 }, search_intent_info: { main_intent: "informational" } }] }] };
    let body = "";
    const fetchFn = (async (_url: string, init?: RequestInit) => { body = String(init?.body); return new Response(envelope(task)); }) as typeof fetch;
    const rows = await fetchKeywordOverview(auth, ["chf adalah", "dj stent di penang"], 2360, "id", fetchFn);
    assert.deepEqual(JSON.parse(body), [{ keywords: ["chf adalah", "dj stent di penang"], location_code: 2360, language_code: "id" }]);
    assert.deepEqual(rows, [{ keyword: "chf adalah", volume: 12100, difficulty: 0, intent: "informational" }]);
  });

  it("turns an account or task error into a readable failure", async () => {
    const unverified = (async () => new Response(JSON.stringify({ status_code: 40104, status_message: "Please verify your account before using the API.", cost: 0, tasks: null }))) as unknown as typeof fetch;
    await assert.rejects(fetchRankedKeywords(auth, "x.com", 2360, unverified), /verify your account/);
    const oneTask = (async () => new Response(envelope({ status_code: 40000, status_message: "You can set only one task at a time.", cost: 0, result: null }))) as unknown as typeof fetch;
    await assert.rejects(fetchRankedKeywords(auth, "x.com", 2360, oneTask), /only one task/);
    const http = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(fetchRankedKeywords(auth, "x.com", 2360, http), /503/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/agents && npm test 2>&1 | grep -E "error TS" | head -3`
Expected: `Cannot find module './dataforseo.js'`.

- [ ] **Step 3: Write the client**

```ts
// packages/agents/src/dataforseo.ts
/*
 * DataForSEO Labs (Google): a domain's ranked keywords in a country, and
 * volume, difficulty and intent for a list of keywords. Paid per request and
 * per row; the account allows one task per request.
 */
import type { RankedKeyword } from "@organic-growth/core";

export type DataForSeoAuth = { login: string; password: string };

/** DataForSEO's Google location for a country: 2000 + its ISO 3166-1 numeric code. */
export const dataForSeoLocation = (numeric: number) => 2000 + numeric;

type Task<T> = { status_code: number; status_message: string; result: T[] | null };
type Envelope<T> = { status_code: number; status_message: string; tasks: Array<Task<T>> | null };

/** Posts one task and returns its first result (undefined when the task has none). */
async function labs<T>(auth: DataForSeoAuth, endpoint: string, task: object, fetchFn: typeof fetch): Promise<T | undefined> {
  const response = await fetchFn(`https://api.dataforseo.com/v3/dataforseo_labs/google/${endpoint}/live`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${auth.login}:${auth.password}`)}`, "Content-Type": "application/json" },
    body: JSON.stringify([task]),
  });
  if (!response.ok) throw new Error(`DataForSEO ${endpoint} request failed (${response.status}).`);
  const json = await response.json() as Envelope<T>;
  const first = json.tasks?.[0];
  if (!first) throw new Error(`DataForSEO: ${json.status_message} (${json.status_code}).`);
  if (first.status_code !== 20000) throw new Error(`DataForSEO ${endpoint}: ${first.status_message} (${first.status_code}).`);
  return first.result?.[0];
}

type RankedItem = {
  keyword_data: { keyword: string; keyword_info?: { search_volume?: number | null } | null; keyword_properties?: { keyword_difficulty?: number | null } | null; search_intent_info?: { main_intent?: string | null } | null };
  ranked_serp_element: { serp_item: { rank_group: number; relative_url?: string | null; etv?: number | null } };
};

/** Rows of a `ranked_keywords` result; a domain DataForSEO doesn't know has none. */
export function rankedKeywordRows(result: unknown): RankedKeyword[] {
  const items = (result as { items?: RankedItem[] | null } | undefined)?.items ?? [];
  return items.map((item) => ({
    keyword: item.keyword_data.keyword,
    volume: item.keyword_data.keyword_info?.search_volume ?? null,
    difficulty: item.keyword_data.keyword_properties?.keyword_difficulty ?? null,
    intent: item.keyword_data.search_intent_info?.main_intent ?? null,
    position: item.ranked_serp_element.serp_item.rank_group,
    url: item.ranked_serp_element.serp_item.relative_url ?? "/",
    traffic: item.ranked_serp_element.serp_item.etv ?? 0,
  }));
}

/** A domain's keywords in a country, every language, highest volume first; at most 1,000. */
export async function fetchRankedKeywords(auth: DataForSeoAuth, domain: string, location: number, fetchFn: typeof fetch = fetch): Promise<RankedKeyword[]> {
  return rankedKeywordRows(await labs(auth, "ranked_keywords", { target: domain, location_code: location, limit: 1000, order_by: ["keyword_data.keyword_info.search_volume,desc"] }, fetchFn));
}

type OverviewItem = { keyword: string; keyword_info?: { search_volume?: number | null } | null; keyword_properties?: { keyword_difficulty?: number | null } | null; search_intent_info?: { main_intent?: string | null } | null };
export type KeywordPrice = { keyword: string; volume: number | null; difficulty: number | null; intent: string | null };

export function keywordOverviewRows(result: unknown): KeywordPrice[] {
  const items = (result as { items?: OverviewItem[] | null } | undefined)?.items ?? [];
  return items.map((item) => ({
    keyword: item.keyword,
    volume: item.keyword_info?.search_volume ?? null,
    difficulty: item.keyword_properties?.keyword_difficulty ?? null,
    intent: item.search_intent_info?.main_intent ?? null,
  }));
}

/** Volume, difficulty and intent for up to 700 keywords in a country and language. Keywords DataForSEO doesn't know are left out, and not charged. */
export async function fetchKeywordOverview(auth: DataForSeoAuth, keywords: string[], location: number, language: string, fetchFn: typeof fetch = fetch): Promise<KeywordPrice[]> {
  return keywordOverviewRows(await labs(auth, "keyword_overview", { keywords: keywords.slice(0, 700), location_code: location, language_code: language }, fetchFn));
}
```

In `packages/agents/src/index.ts`, after `export * from "./google-analytics.js";` add `export * from "./dataforseo.js";`.

- [ ] **Step 4: Run the agents tests**

Run: `cd packages/agents && npm test 2>&1 | grep -E "not ok|# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/dataforseo.ts packages/agents/src/dataforseo.test.ts packages/agents/src/index.ts
git commit -m "DataForSEO client: ranked keywords per domain, prices per keyword" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Credentials, keys, and a monthly cadence

**Files:**
- Modify: `apps/web/cloudflare.config.ts`, `apps/web/.dev.vars.example`
- Modify: `apps/web/src/results-sync.ts` (`SignalKeys.dataForSeo`, `cadence: "monthly"`)
- Modify: `apps/web/src/results-access.ts` (`signalKeys(env)`)
- Modify: `apps/web/src/search-sync-workflow.ts`, `apps/web/app/api/sites/[siteId]/results/sync/route.ts` (use `signalKeys`)
- Create: `apps/web/src/results-access.test.ts`

**Interfaces:**
- Produces: `SignalKeys = { googleApiKey?: string; openPageRankKey?: string; dataForSeo?: { login: string; password: string } }`; `signalKeys(env: { GOOGLE_API_KEY?: string; OPEN_PAGERANK_KEY?: string; DATAFORSEO_LOGIN?: string; DATAFORSEO_PASSWORD?: string }): SignalKeys`; `Source.cadence: "daily" | "weekly" | "monthly"`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/results-access.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signalKeys } from "./results-access.ts";

describe("signalKeys", () => {
  it("reads the keyed signals from the environment, treating blank secrets as absent", () => {
    assert.deepEqual(signalKeys({ GOOGLE_API_KEY: "g", OPEN_PAGERANK_KEY: "", DATAFORSEO_LOGIN: "me", DATAFORSEO_PASSWORD: "pw" }), { googleApiKey: "g", openPageRankKey: undefined, dataForSeo: { login: "me", password: "pw" } });
    assert.equal(signalKeys({ DATAFORSEO_LOGIN: "me" }).dataForSeo, undefined, "a login without a password is no credential");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && node --test src/results-access.test.ts 2>&1 | grep -E "not ok|error|# (pass|fail)" | head -3`
Expected: fails: `signalKeys` is not exported (`SyntaxError: The requested module './results-access.ts' does not provide an export named 'signalKeys'`).

- [ ] **Step 3: Declare the secrets and the keys**

`apps/web/cloudflare.config.ts`, after `OPEN_PAGERANK_KEY: bindings.secret(),`:
```ts
      // Optional: DataForSEO (keyword volume, difficulty, competitor keywords). Basic auth: the API login and API password.
      DATAFORSEO_LOGIN: bindings.secret(),
      DATAFORSEO_PASSWORD: bindings.secret(),
```

`apps/web/.dev.vars.example`, after the `OPEN_PAGERANK_KEY=` line:
```
# Optional: DataForSEO API login and API password (app.dataforseo.com → API Access), for keyword volume, difficulty and competitor keywords.
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=
```

`apps/web/src/results-sync.ts`:
```ts
/** API keys for the signals that need no Google sign-in: CrUX and PageSpeed (Google API key), Open PageRank, DataForSEO. */
export type SignalKeys = { googleApiKey?: string; openPageRankKey?: string; dataForSeo?: { login: string; password: string } };
```
and in `Source`:
```ts
  /** Daily sources run every sync. Weekly ones run on Mondays, or until their marker exists. Monthly ones run when their marker is absent or 28 or more days old. */
  cadence: "daily" | "weekly" | "monthly";
```
and replace the weekly line in `syncResults` with:
```ts
    const first = source.marker ? !(await firstMetricDay(db, site.id, source.marker)) : false;
    const due = first || source.cadence === "daily"
      || (source.cadence === "weekly" ? now.getUTCDay() === 1 : ((await lastMetricDay(db, site.id, source.marker!)) ?? "") <= addDays(today, -28));
    if (!due) continue;
```
with `lastMetricDay` added to the `@organic-growth/db` import and `addDays` imported from `@organic-growth/core`.

`apps/web/src/results-access.ts`, add:
```ts
import type { GoogleAccess, SignalKeys } from "./results-sync";

type KeyEnv = { GOOGLE_API_KEY?: string; OPEN_PAGERANK_KEY?: string; DATAFORSEO_LOGIN?: string; DATAFORSEO_PASSWORD?: string };

/** The keyed signals the environment provides; a blank secret is no key. */
export function signalKeys(env: KeyEnv): SignalKeys {
  return {
    googleApiKey: env.GOOGLE_API_KEY || undefined,
    openPageRankKey: env.OPEN_PAGERANK_KEY || undefined,
    dataForSeo: env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD ? { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD } : undefined,
  };
}
```

`apps/web/src/search-sync-workflow.ts`: import `signalKeys` beside `googleAccess`, and replace `{ googleApiKey: this.env.GOOGLE_API_KEY, openPageRankKey: this.env.OPEN_PAGERANK_KEY }` with `signalKeys(this.env)`.
`apps/web/app/api/sites/[siteId]/results/sync/route.ts`: same, `signalKeys(env)`.

- [ ] **Step 4: Run the test, the typecheck and the sync tests**

Run: `cd apps/web && node --test src/results-access.test.ts src/results-sync.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"; cd ../.. && npm run typecheck 2>&1 | grep "error TS" | head`
Expected: `# fail 0`, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/cloudflare.config.ts apps/web/.dev.vars.example apps/web/src/results-sync.ts apps/web/src/results-access.ts apps/web/src/results-access.test.ts apps/web/src/search-sync-workflow.ts "apps/web/app/api/sites/[siteId]/results/sync/route.ts"
git commit -m "DataForSEO credentials as a signal key, and a monthly cadence for sources" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The two keyword sources

**Files:**
- Modify: `apps/web/src/results-sources.ts`
- Modify: `apps/web/src/results-sync.test.ts`

**Interfaces:**
- Consumes: `fetchRankedKeywords`, `fetchKeywordOverview`, `dataForSeoLocation`, `authorityDomain` (agents); `countryNumeric` (core); `saveSnapshot`, `getPageSettings`, `defaultPageSettings`, `listSiteMarkets`, `listSiteCompetitorDomains` (db); `fetchQueryPositions` (agents).
- Produces: snapshots of kind `competitor_keywords` (scope `<domain>|<market>`, rows `RankedKeyword[]`) and `keywords` (scope `<property>|<market>`, rows `PricedKeyword[]`); ledger `kw_top10`, `kw_traffic`, `kw_top10:<domain>`, `kw_traffic:<domain>`; markers `sync.competitor_keywords`, `sync.keyword_volumes`.

- [ ] **Step 1: Write the failing tests** (append inside `describe("results sync")` in `apps/web/src/results-sync.test.ts`; add `getSnapshot, listSnapshots` to the `@organic-growth/db` import)

```ts
  const dataForSeo = { login: "me", password: "pw" };
  const rankedAnswer = (rows: Array<[string, number, number, number]>) => JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ items_count: rows.length, items: rows.map(([keyword, volume, position, etv]) => ({
    keyword_data: { keyword, keyword_info: { search_volume: volume }, keyword_properties: { keyword_difficulty: 12 }, search_intent_info: { main_intent: "commercial" } },
    ranked_serp_element: { serp_item: { rank_group: position, relative_url: `/${keyword.replace(/ /g, "-")}`, etv } },
  })) }] }] });
  const overviewAnswer = (rows: Array<[string, number]>) => JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ items_count: rows.length, items: rows.map(([keyword, volume]) => ({ keyword, keyword_info: { search_volume: volume }, keyword_properties: { keyword_difficulty: 7 }, search_intent_info: { main_intent: "informational" } })) }] }] });

  it("syncs competitor keywords and prices the site's queries once a month, per market", async () => {
    const { db, site: record } = await site();
    await setSiteMarkets(db, "s", ["idn", "mmr"]);
    await setSiteCompetitorDomains(db, "s", ["rival.example", "nobody.example"]);
    const asked: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("dataforseo")) {
        const task = (body as Array<Record<string, unknown>>)[0]!;
        asked.push({ url, body: task });
        if (url.includes("keyword_overview")) return new Response(overviewAnswer([["dr amy tan", 320]]));
        if (task.target === "nobody.example") return new Response(rankedAnswer([]));
        if (task.target === "x.com") return new Response(rankedAnswer([["x clinic", 100, 1, 50]]));
        return new Response(rankedAnswer([["veneers price", 3600, 3, 900], ["x clinic", 100, 9, 2]]));
      }
      if (body.dimensions?.join() === "query") return new Response(JSON.stringify({ rows: [{ keys: ["Dr Amy Tan"], clicks: 9, impressions: 300, ctr: 0.03, position: 4 }, { keys: ["ivf penang"], clicks: 2, impressions: 80, ctr: 0.02, position: 12 }] }));
      return new Response(JSON.stringify({ rows: [] }));
    }) as typeof fetch;
    const google = { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn };

    const notes = await syncResults(db, record, now, google, { dataForSeo });
    assert.ok(notes.includes("competitor keywords: 3 domains in 1 markets"), notes.join("; "));
    assert.ok(notes.some((note) => note.startsWith("competitor keywords skipped mmr")), "a market DataForSEO doesn't cover is noted, not fatal");
    assert.ok(notes.includes("keyword volumes: 2 queries listed, 1 priced"), notes.join("; "));
    assert.deepEqual(asked.filter((call) => call.url.includes("ranked_keywords")).map((call) => [call.body.target, call.body.location_code]), [["x.com", 2360], ["rival.example", 2360], ["nobody.example", 2360]]);
    assert.deepEqual(asked.find((call) => call.url.includes("keyword_overview"))!.body, { keywords: ["dr amy tan", "ivf penang"], location_code: 2360, language_code: "en" });

    const rival = (await getSnapshot<{ keyword: string }>(db, "s", "competitor_keywords", "rival.example|idn"))!;
    assert.deepEqual(rival.rows.map((row) => row.keyword), ["veneers price", "x clinic"]);
    assert.deepEqual((await getSnapshot(db, "s", "competitor_keywords", "nobody.example|idn"))!.rows, [], "an unknown domain is an empty list, not a failure");
    const priced = (await getSnapshot<{ keyword: string; volume: number | null; position: number }>(db, "s", "keywords", "sc-domain:x.com|idn"))!;
    assert.deepEqual(priced.rows.map((row) => [row.keyword, row.volume, row.position]), [["Dr Amy Tan", 320, 4], ["ivf penang", null, 12]], "every query is kept; unknown ones have no volume");
    const series = await listMetricSeries(db, "s", ["kw_top10", "kw_traffic", "kw_top10:rival.example", "kw_traffic:rival.example", "kw_traffic:nobody.example"], "2026-10-07", "2026-10-07");
    assert.deepEqual([series.kw_top10![0]!.value, series.kw_traffic![0]!.value, series["kw_top10:rival.example"]![0]!.value, series["kw_traffic:rival.example"]![0]!.value, series["kw_traffic:nobody.example"]![0]!.value], [1, 50, 2, 902, 0]);

    // Ten days later nothing is asked; 28 days later both run again.
    asked.length = 0;
    await syncResults(db, record, new Date("2026-10-17T04:15:00Z"), google, { dataForSeo });
    assert.equal(asked.length, 0, "monthly sources rest between runs");
    await syncResults(db, record, new Date("2026-11-04T04:15:00Z"), google, { dataForSeo });
    assert.equal(asked.length, 4, "three ranked lists and one price list again");
  });

  it("asks for target markets before spending on keywords", async () => {
    const { db, site: record } = await site();
    const notes = await syncResults(db, record, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn: (async () => new Response(JSON.stringify({ rows: [] }))) as unknown as typeof fetch }, { dataForSeo });
    assert.ok(notes.includes("competitor keywords: set target markets in Setup"), notes.join("; "));
    assert.ok(notes.includes("keyword volumes: set target markets in Setup"), notes.join("; "));
  });

  it("keeps the other domains when one DataForSEO call fails", async () => {
    const { db, site: record } = await site();
    await setSiteMarkets(db, "s", ["idn"]);
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (!url.includes("dataforseo")) return new Response(JSON.stringify({ rows: [] }));
      const task = JSON.parse(String(init?.body))[0];
      if (task.target === "rival.example") return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 40000, status_message: "You can set only one task at a time.", result: null }] }));
      return new Response(rankedAnswer([["x clinic", 100, 1, 50]]));
    }) as typeof fetch;
    const notes = await syncResults(db, record, now, { connect: async () => ({ token: "t", scopes: [SEARCH_CONSOLE_SCOPE] }), fetchFn }, { dataForSeo });
    assert.ok(notes.includes("competitor keywords: 1 domains in 1 markets"), notes.join("; "));
    assert.ok(notes.some((note) => note.startsWith("competitor keywords skipped rival.example in idn: DataForSEO ranked_keywords: You can set only one task")), notes.join("; "));
    assert.ok(await getSnapshot(db, "s", "competitor_keywords", "x.com|idn"));
  });
```

Also extend the existing guard test "writes only metrics the Performance view reads": add `dataForSeo` to its keys, give its fake a `dataforseo` branch returning `rankedAnswer([["kw", 10, 1, 1]])` for ranked and `overviewAnswer([])` for prices, and add `"kw_top10:rival.example", "kw_traffic:rival.example"` to its `declared` set. (Its `setSiteMarkets(db, "s", ["mys"])` already gives a covered market.)

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/web && node --test src/results-sync.test.ts 2>&1 | grep -E "^    not ok|# (pass|fail)"`
Expected: the three new tests fail (notes lack "competitor keywords…") and the guard fails on undeclared `kw_*`… no: the guard passes until sources exist; expect 3 failures.

- [ ] **Step 3: Write the sources**

In `apps/web/src/results-sources.ts`, extend the imports:
- from `@organic-growth/agents`: add `dataForSeoLocation, fetchKeywordOverview, fetchRankedKeywords`;
- from `@organic-growth/core`: add `countryNumeric, type PricedKeyword`;
- from `@organic-growth/db`: add `saveSnapshot`.

Add before `export const SOURCES`:

```ts
/** DataForSEO's location for a target market, or null for a country it doesn't cover. */
const marketLocation = (market: string): number | null => {
  const numeric = countryNumeric(market);
  return numeric === null ? null : dataForSeoLocation(numeric);
};

const noMarkets = (name: string) => async ({ db, site }: SyncContext) => ((await listSiteMarkets(db, site.id)).length ? null : `${name}: set target markets in Setup`);

/**
 * Every domain's ranked keywords in each target market, the site's own first:
 * the lists behind keyword gaps and share of visibility. One DataForSEO call
 * per domain and market, so a domain or market that fails is noted and the
 * rest continue; the marker is written once anything was fetched.
 */
const competitorKeywords: Source = {
  name: "competitor keywords", cadence: "monthly", marker: "sync.competitor_keywords",
  applies: ({ keys }) => Boolean(keys.dataForSeo),
  skip: noMarkets("competitor keywords"),
  run: async ({ db, site, today, keys, fetchFn }) => {
    const markets = await listSiteMarkets(db, site.id);
    const own = authorityDomain(site.baseUrl);
    const domains = [own, ...(await listSiteCompetitorDomains(db, site.id))];
    const totals = new Map<string, { top10: number; traffic: number }>();
    const skipped: string[] = [];
    let marketsCovered = 0;
    for (const market of markets) {
      const location = marketLocation(market);
      if (location === null) {
        skipped.push(`${market}: not covered by DataForSEO`);
        continue;
      }
      marketsCovered++;
      for (const domain of domains) {
        try {
          const rows = await fetchRankedKeywords(keys.dataForSeo!, domain, location, fetchFn);
          await saveSnapshot(db, site.id, { kind: "competitor_keywords", scope: `${domain}|${market}`, periodEnd: today, rows });
          const sum = totals.get(domain) ?? { top10: 0, traffic: 0 };
          sum.top10 += rows.filter((row) => row.position <= 10).length;
          sum.traffic += rows.reduce((total, row) => total + row.traffic, 0);
          totals.set(domain, sum);
        } catch (error) {
          skipped.push(`${domain} in ${market}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (!totals.size) throw new Error(skipped.join("; ") || "no markets covered");
    const points = [...totals].flatMap(([domain, sum]) => {
      const suffix = domain === own ? "" : `:${domain}`;
      return [{ metric: `kw_top10${suffix}`, day: today, value: sum.top10 }, { metric: `kw_traffic${suffix}`, day: today, value: Math.round(sum.traffic) }];
    });
    return { points, notes: [`competitor keywords: ${totals.size} domains in ${marketsCovered} markets`, ...skipped.map((entry) => `competitor keywords skipped ${entry}`)] };
  },
};

/**
 * The site's Search Console queries of the last 28 finalized days in each
 * market, up to 700 by impressions, priced by DataForSEO in the page language.
 * Every query is kept; one DataForSEO doesn't know has no volume.
 */
const keywordVolumes: Source = {
  name: "keyword volumes", cadence: "monthly", marker: "sync.keyword_volumes", google: true,
  applies: ({ keys, site }) => Boolean(keys.dataForSeo && site.gscProperty),
  skip: noMarkets("keyword volumes"),
  run: async (ctx) => {
    const { db, site, today, keys, fetchFn } = ctx;
    const { token } = await ctx.google();
    const property = site.gscProperty!;
    const { language } = (await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl);
    const range = { startDate: addDays(today, -30), endDate: addDays(today, -3) };
    let listed = 0;
    let priced = 0;
    for (const market of await listSiteMarkets(db, site.id)) {
      const location = marketLocation(market);
      if (location === null) continue; // noted by competitor keywords
      const queries = (await fetchQueryPositions(token, property, { ...range, country: market }, fetchFn)).sort((a, b) => b.impressions - a.impressions).slice(0, 700);
      if (!queries.length) continue;
      const prices = new Map((await fetchKeywordOverview(keys.dataForSeo!, queries.map((query) => query.query.toLowerCase()), location, language, fetchFn)).map((row) => [row.keyword, row]));
      const rows: PricedKeyword[] = queries.map((query) => {
        const price = prices.get(query.query.toLowerCase());
        return { keyword: query.query, volume: price?.volume ?? null, difficulty: price?.difficulty ?? null, intent: price?.intent ?? null, position: query.position, clicks: query.clicks, impressions: query.impressions };
      });
      await saveSnapshot(db, site.id, { kind: "keywords", scope: `${property}|${market}`, periodEnd: range.endDate, rows });
      listed += rows.length;
      priced += prices.size;
    }
    return { notes: [`keyword volumes: ${listed} queries listed, ${priced} priced`] };
  },
};
```

`SyncContext` is imported as a type from `./results-sync.ts` already; add it to that import. Append both sources to `SOURCES` after `analytics`: `…, analytics, competitorKeywords, keywordVolumes]`.

- [ ] **Step 4: Run the sync tests and the whole suite**

Run: `cd apps/web && node --test src/results-sync.test.ts 2>&1 | grep -E "^    not ok|# (pass|fail)"; cd ../.. && npm run typecheck 2>&1 | grep "error TS" | head; npm test 2>&1 | grep -E "^# fail" | sort | uniq -c`
Expected: `# fail 0` everywhere. If the guard test lists `kw_*` as undeclared, Task 3's `METRICS.keywords` is missing a name: fix the declaration, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/results-sources.ts apps/web/src/results-sync.test.ts
git commit -m "Sync competitor keywords and price the site's queries with DataForSEO, monthly" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Load the keyword lists for the view

**Files:**
- Create: `apps/web/src/keywords-data.ts`
- Modify: `apps/web/src/results-data.ts`, `apps/web/src/results-data.test.ts`
- Modify: `apps/web/app/api/sites/[siteId]/results/route.ts`, `apps/web/app/api/r/[token]/route.ts`

**Interfaces:**
- Produces: `loadKeywords(db, site: SiteRecord, scope: { markets: string[]; competitors: string[] }): Promise<KeywordsInput>`; `resultsPayload(db, site, options: { client?: boolean; keys?: SignalKeys })` with `site.signals: { speed: boolean; authority: boolean; keywords: boolean }`.

- [ ] **Step 1: Write the failing test** (append to `apps/web/src/results-data.test.ts`; import `loadKeywords` from `./keywords-data.ts`, `saveSnapshot, setSiteCompetitorDomains, setSiteMarkets, updateSiteGscProperty, upsertMetricPoints` from `@organic-growth/db` as needed)

```ts
  it("reads only the keyword lists for the current property, markets and competitors, under the bare domain", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://www.x.com", createdAt: now, updatedAt: now });
    await updateSiteGscProperty(db, "s", "sc-domain:x.com");
    await setSiteMarkets(db, "s", ["idn"]);
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    const rows = [{ keyword: "k", volume: 10, difficulty: 1, intent: null, position: 1, url: "/k", traffic: 5 }];
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "x.com|idn", periodEnd: "2026-10-09", rows });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|idn", periodEnd: "2026-10-09", rows });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|mys", periodEnd: "2026-10-09", rows });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "gone.example|idn", periodEnd: "2026-10-09", rows });
    await saveSnapshot(db, "s", { kind: "keywords", scope: "sc-domain:x.com|idn", periodEnd: "2026-10-06", rows: [] });
    await saveSnapshot(db, "s", { kind: "keywords", scope: "sc-domain:old.com|idn", periodEnd: "2026-10-06", rows: [] });
    await upsertMetricPoints(db, "s", [{ metric: "sync.competitor_keywords", day: "2026-10-09", value: 2 }]);
    const site = (await getSite(db, "s"))!;
    const keywords = await loadKeywords(db, site, { markets: ["idn"], competitors: ["rival.example"] });
    assert.equal(keywords.site, "x.com");
    assert.equal(keywords.synced, true);
    assert.deepEqual(keywords.ranked.map((list) => list.domain), ["rival.example", "x.com"], "the other market and the removed competitor are left out");
    assert.equal(keywords.priced.length, 1, "the old property's prices are left out");
    const payload = await resultsPayload(db, site, { keys: { dataForSeo: { login: "a", password: "b" } } });
    assert.deepEqual(payload.site.signals, { speed: false, authority: false, keywords: true });
    assert.equal(payload.results.keywords.visibility[0]!.domain, "x.com");
  });
```

The existing tests in that file pass `signals` to `resultsPayload`; change them to pass `keys` (e.g. `{ keys: { googleApiKey: "g" } }`) and expect `keywords: false` in `signals`.

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && node --test src/results-data.test.ts 2>&1 | grep -E "not ok|error|# (pass|fail)" | head -3`
Expected: `Cannot find module './keywords-data.ts'`.

- [ ] **Step 3: Write the loader and wire the payload**

```ts
// apps/web/src/keywords-data.ts
import { authorityDomain } from "@organic-growth/agents";
import type { KeywordsInput, PricedKeyword, RankedKeyword, SiteRecord } from "@organic-growth/core";
import { firstMetricDay, listSnapshots, type D1Like } from "@organic-growth/db";

/**
 * The keyword lists the view and the growth plan read: only those fetched for
 * the current property, target markets and competitors (the scope says which),
 * so a changed setting hides the old lists until the next sync replaces them.
 */
export async function loadKeywords(db: D1Like, site: SiteRecord, scope: { markets: string[]; competitors: string[] }): Promise<KeywordsInput> {
  const own = authorityDomain(site.baseUrl);
  const domains = new Set([own, ...scope.competitors]);
  const [priced, ranked, marker] = await Promise.all([
    listSnapshots<PricedKeyword>(db, site.id, "keywords"),
    listSnapshots<RankedKeyword>(db, site.id, "competitor_keywords"),
    firstMetricDay(db, site.id, "sync.competitor_keywords"),
  ]);
  const inScope = (list: { scope: string }, first: (value: string) => boolean) => {
    const [head, market] = list.scope.split("|");
    return first(head!) && scope.markets.includes(market!);
  };
  return {
    site: own,
    competitors: scope.competitors,
    synced: marker !== null,
    priced: priced.filter((list) => inScope(list, (property) => property === site.gscProperty)).map(({ periodEnd, rows }) => ({ periodEnd, rows })),
    ranked: ranked.filter((list) => inScope(list, (domain) => domains.has(domain))).map(({ scope: key, periodEnd, rows }) => ({ domain: key.split("|")[0]!, periodEnd, rows })),
  };
}
```

`apps/web/src/results-data.ts`:
- Import `loadKeywords` from `./keywords-data.ts` and `type SignalKeys` from `./results-sync.ts`.
- In `loadResults`, read the per-competitor metrics for keywords too and load the lists:
```ts
  const competitors = await listSiteCompetitorDomains(db, site.id);
  const perCompetitor = competitors.flatMap((domain) => [`authority:${domain}`, `kw_top10:${domain}`, `kw_traffic:${domain}`]);
  const [series, pages, index, markets] = await Promise.all([
    listMetricSeries(db, site.id, [...RESULT_METRICS, ...perCompetitor], addDays(today, -500), today),
    publishedPages(db, site.id),
    indexStatusCounts(db, site.id),
    listSiteMarkets(db, site.id),
  ]);
  const [topQueries, keywords] = await Promise.all([
    site.gscProperty ? getTopQueriesSnapshot(db, site.id, { property: site.gscProperty, markets }) : null,
    loadKeywords(db, site, { markets, competitors }),
  ]);
  return resultsView({ today, goLive: pages.goLive, markets, series, index, published: pages.published, searchConnected: Boolean(site.gscProperty), ga4Connected: Boolean(site.ga4Property), topQueries, competitors, keywords });
```
- `ResultsPayload.site.signals` becomes `{ speed: boolean; authority: boolean; keywords: boolean }` with the comment `/** Which keyed signals are configured: speed (Google API key), authority (Open PageRank), keywords (DataForSEO). */`.
- `resultsPayload(db, site, options: { client?: boolean; keys?: SignalKeys } = {})` sets `signals: { speed: Boolean(options.keys?.googleApiKey), authority: Boolean(options.keys?.openPageRankKey), keywords: Boolean(options.keys?.dataForSeo) }`.

Routes: `apps/web/app/api/sites/[siteId]/results/route.ts` passes `{ keys: signalKeys(env) }`; `apps/web/app/api/r/[token]/route.ts` passes `{ client: true, keys: signalKeys(env) }`; both import `signalKeys` from `src/results-access`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd apps/web && node --test src/results-data.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"; cd ../.. && npm run typecheck 2>&1 | grep "error TS" | head`
Expected: `# fail 0`; the only type errors, if any, are in `ResultsView.tsx` reading `site.signals` (fixed in Task 8; if so, proceed to Task 8 before committing both together).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/keywords-data.ts apps/web/src/results-data.ts apps/web/src/results-data.test.ts "apps/web/app/api/sites/[siteId]/results/route.ts" "apps/web/app/api/r/[token]/route.ts"
git commit -m "Serve the keyword lists with the Performance view, scoped to the current setup" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The Keywords card

**Files:**
- Create: `apps/web/app/components/results/KeywordsCard.tsx`
- Modify: `apps/web/app/components/ResultsView.tsx`
- Modify: `apps/web/app/components/api.ts` (export `formatDay`)

**Interfaces:**
- Consumes: `ResultsView.keywords: KeywordsView`, `Payload.site.signals.keywords`.
- Produces: `KeywordsCard({ keywords, host, operator, hasCredentials, hasMarkets, searchTop10 })`; `formatDay(day: string): string` in `api.ts`.

- [ ] **Step 1: Move the day formatter**

In `apps/web/app/components/api.ts` add:
```ts
/** "9 Oct" from "2026-10-09". */
export const formatDay = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
```
In `ResultsView.tsx` replace `const day = (value: string) => …;` with `const day = formatDay;` and add `formatDay` to the `./api` import.

- [ ] **Step 2: Write the card**

```tsx
// apps/web/app/components/results/KeywordsCard.tsx
"use client";

import type { KeywordsView } from "@organic-growth/core";
import { formatDay, formatNumber } from "../api";
import { BarList } from "../charts";
import { Badge, Card } from "../ui";

const num = (value: number | null) => (value === null ? "—" : formatNumber(value));
const difficultyTone = (value: number) => (value <= 30 ? "green" : value <= 60 ? "amber" : "red");

function Difficulty({ value }: { value: number | null }) {
  return value === null ? <>—</> : <Badge tone={difficultyTone(value)}>{value}</Badge>;
}

/**
 * What the site's searches are worth and which ones competitors win: the
 * site's queries priced by DataForSEO, keyword gaps, and share of visibility.
 */
export function KeywordsCard({ keywords, host, operator, hasCredentials, hasMarkets, searchTop10 }: {
  keywords: KeywordsView; host: string; operator: boolean; hasCredentials: boolean; hasMarkets: boolean; searchTop10: number | null;
}) {
  const empty = !hasCredentials && !keywords.synced
    ? (operator ? "Add DataForSEO credentials (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) to price keywords and see competitor gaps." : "Not measured yet.")
    : !hasMarkets ? (operator ? "Set target markets in Setup: keyword data is per country." : "Not measured yet.")
    : !keywords.synced ? "Keywords appear after the next sync."
    : !keywords.top.length && !keywords.gaps.length && keywords.visibility.every((row) => !row.traffic) ? "DataForSEO has no keywords for these domains in your target markets."
    : null;
  const you = keywords.visibility[0];
  return (
    <Card title="Keywords" subtitle={`Searches per month and difficulty from DataForSEO, updated monthly${keywords.asOf ? ` (last on ${formatDay(keywords.asOf)})` : ""}. Positions from Search Console.`}>
      {empty ? <p className="empty-state">{empty}</p> : (
        <>
          <div className="section-title">Your top keywords</div>
          {keywords.top.length ? (
            <div className="table-wrap">
              <table className="table top-queries">
                <thead><tr><th>Keyword</th><th className="num">Searches / month</th><th className="num">Difficulty</th><th className="num">Position</th><th className="num">Clicks</th></tr></thead>
                <tbody>{keywords.top.map((row) => (
                  <tr key={row.keyword}>
                    <td>{row.keyword}{row.intent && <span className="was">{row.intent}</span>}</td>
                    <td className="num">{num(row.volume)}</td>
                    <td className="num"><Difficulty value={row.difficulty} /></td>
                    <td className="num">{row.position.toFixed(1)}</td>
                    <td className="num">{formatNumber(row.clicks)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="empty-state">{operator ? "Connect Search Console so your queries can be priced." : "No priced keywords yet."}</p>}

          <div className="section-title">Keyword gaps</div>
          {keywords.gaps.length ? (
            <div className="table-wrap">
              <table className="table top-queries">
                <thead><tr><th>Keyword</th><th className="num">Searches / month</th><th className="num">Difficulty</th><th>Who ranks</th></tr></thead>
                <tbody>{keywords.gaps.map((gap) => (
                  <tr key={gap.keyword}>
                    <td>{gap.keyword}{gap.intent && <span className="was">{gap.intent}</span>}</td>
                    <td className="num">{num(gap.volume)}</td>
                    <td className="num"><Difficulty value={gap.difficulty} /></td>
                    <td><a href={`https://${gap.domain}${gap.url}`} target="_blank" rel="noreferrer">{gap.domain}</a><span className="was">position {gap.position}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="empty-state">No gaps found: you appear for every keyword your competitors rank for.</p>}

          <div className="section-title">Share of visibility</div>
          <BarList format={(value) => `${formatNumber(value)} visits/mo`} rows={keywords.visibility.map((row, index) => ({ label: index === 0 ? host : row.domain, value: row.traffic }))} />
          <p className="small muted">
            Estimated monthly visits from Google, in DataForSEO's index, which knows fewer of your keywords than Search Console does
            {you?.top10 !== null && you?.top10 !== undefined ? `: it sees you in the top 10 for ${formatNumber(you.top10)} searches${searchTop10 !== null ? `, Search Console counts ${formatNumber(searchTop10)}` : ""}` : ""}.
          </p>
        </>
      )}
    </Card>
  );
}
```

- [ ] **Step 3: Render it**

In `ResultsView.tsx`:
- `type Payload`'s `signals` becomes `{ speed: boolean; authority: boolean; keywords: boolean }`.
- Import `{ KeywordsCard } from "./results/KeywordsCard";`.
- After the `</Card>` of the "Google search" card (before the "Enquiries" card), add:
```tsx
        <KeywordsCard keywords={results.keywords} host={host} operator={operator} hasCredentials={site.signals.keywords} hasMarkets={results.markets.length > 0}
          searchTop10={results.search?.buckets.find((bucket) => bucket.top === 10)?.queries ?? null} />
```

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck 2>&1 | grep "error TS" | head; npm test 2>&1 | grep -E "^# fail" | sort | uniq -c`
Expected: no type errors; all `# fail 0`. The visual check happens in Task 10 with the demo site.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/results/KeywordsCard.tsx apps/web/app/components/ResultsView.tsx apps/web/app/components/api.ts
git commit -m "Performance: a Keywords card with priced queries, competitor gaps and share of visibility" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Real demand in the growth plan, and gap opportunities

**Files:**
- Modify: `packages/agents/src/demand.ts`, `packages/agents/src/demand.test.ts`
- Modify: `packages/agents/src/search.ts` (pass the query and the lookup)
- Modify: `packages/agents/src/index.ts` (`AnalysisBundle.keywords`, `gapOpportunities`, growth-plan copy)
- Modify: `packages/agents/src/pipeline.ts` (`RunAnalysisInput.keywords` → bundle)
- Modify: `apps/web/src/analysis-workflow.ts` (load the lists)
- Modify: `apps/web/app/components/report-model.ts` (tab for `keyword_gap`)
- Create: `packages/agents/src/opportunities.test.ts`

**Interfaces:**
- Consumes: `KeywordsInput`, `keywordGaps`, `demandFromSnapshots`, `KeywordDemand`, `KeywordGap` (core); `loadKeywords` (web).
- Produces: `estimateDemand(input, demand?: KeywordDemand): { searchDemand: number; estimatedDifficulty: number; priced: string | null }` where `ranking` and `snippet` inputs carry `query: string`; `gapOpportunities(gaps: KeywordGap[], siteId, analysisId): Opportunity[]`; `AnalysisBundle.keywords?: KeywordsInput`; `RunAnalysisInput.keywords?: KeywordsInput`; opportunity intent `keyword_gap`.

- [ ] **Step 1: Write the failing tests**

Replace `packages/agents/src/demand.test.ts` with:
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demandFromSnapshots } from "@organic-growth/core";
import { estimateDemand } from "./demand.js";

describe("estimateDemand", () => {
  it("rates a ranking move by its distance from page one, with impressions as demand", () => {
    assert.deepEqual(estimateDemand({ kind: "ranking", query: "q", position: 7, impressions: 120 }), { searchDemand: 120, estimatedDifficulty: 35, priced: null });
  });

  it("never rates anything harder than 100", () => {
    assert.equal(estimateDemand({ kind: "ranking", query: "q", position: 40, impressions: 1 }).estimatedDifficulty, 100);
    assert.equal(estimateDemand({ kind: "content_gap", competitorPages: 1_000_000 }).estimatedDifficulty, 100);
  });

  it("reads a competitor's page count as difficulty, with no demand figure to show", () => {
    assert.deepEqual(estimateDemand({ kind: "content_gap", competitorPages: 999 }), { searchDemand: 0, estimatedDifficulty: 75, priced: null });
  });

  it("prefers DataForSEO's volume and difficulty when the query is priced, and says so", () => {
    const demand = demandFromSnapshots([{ keyword: "ivf cost penang", volume: 2400, difficulty: 16, intent: "commercial", position: 7, clicks: 8, impressions: 900 }]);
    assert.deepEqual(estimateDemand({ kind: "ranking", query: "IVF cost Penang", position: 7, impressions: 900 }, demand), { searchDemand: 2400, estimatedDifficulty: 16, priced: "2,400 searches a month, difficulty 16 of 100 (DataForSEO)." });
    assert.deepEqual(estimateDemand({ kind: "snippet", query: "other", impressions: 50 }, demand), { searchDemand: 50, estimatedDifficulty: 10, priced: null });
  });
});
```

```ts
// packages/agents/src/opportunities.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeywordsInput } from "@organic-growth/core";
import { buildOpportunities, gapOpportunities, synthesizeGrowthPlan } from "./index.js";

const keywords: KeywordsInput = {
  site: "x.com", competitors: ["rival.example"], synced: true,
  priced: [{ periodEnd: "2026-10-06", rows: [{ keyword: "ivf cost penang", volume: 2400, difficulty: 16, intent: "commercial", position: 7, clicks: 8, impressions: 900 }] }],
  ranked: [{ domain: "rival.example", periodEnd: "2026-10-09", rows: [
    { keyword: "dj stent di penang", volume: 5400, difficulty: 0, intent: "transactional", position: 15, url: "/prosedur-pasang-dj-stent-di-penang/", traffic: 60 },
    { keyword: "chf adalah", volume: 12100, difficulty: 0, intent: "informational", position: 10, url: "/gagal-jantung/", traffic: 400 },
    { keyword: "too hard", volume: 9000, difficulty: 70, intent: "commercial", position: 2, url: "/hard", traffic: 900 },
    { keyword: "too small", volume: 40, difficulty: 1, intent: "commercial", position: 1, url: "/small", traffic: 20 },
    { keyword: "ivf cost penang", volume: 2400, difficulty: 16, intent: "commercial", position: 3, url: "/ivf", traffic: 300 },
  ] }],
};

describe("gap opportunities", () => {
  it("turns the biggest reachable gaps into pages to build, commercial intent first", () => {
    const gaps = gapOpportunities([
      { keyword: "dj stent di penang", volume: 5400, difficulty: 0, intent: "transactional", domain: "rival.example", position: 15, url: "/prosedur-pasang-dj-stent-di-penang/" },
      { keyword: "chf adalah", volume: 12100, difficulty: 0, intent: "informational", domain: "rival.example", position: 10, url: "/gagal-jantung/" },
      { keyword: "too hard", volume: 9000, difficulty: 70, intent: "commercial", domain: "rival.example", position: 2, url: "/hard" },
      { keyword: "too small", volume: 40, difficulty: 1, intent: "commercial", domain: "rival.example", position: 1, url: "/small" },
    ], "s", "a");
    assert.deepEqual(gaps.map((gap) => gap.title), [
      "Rank for “dj stent di penang”: 5,400 searches a month; rival.example ranks 15",
      "Rank for “chf adalah”: 12,100 searches a month; rival.example ranks 10",
    ]);
    assert.equal(gaps[0]!.intent, "keyword_gap");
    assert.equal(gaps[0]!.searchDemand, 5400);
    assert.equal(gaps[0]!.potentialPage, "https://rival.example/prosedur-pasang-dj-stent-di-penang/");
    assert.ok(gaps[0]!.priorityScore > gaps[1]!.priorityScore, "commercial intent outranks a bigger informational gap");
  });

  it("joins the growth plan with its own copy, and prices striking-distance queries from the lists", () => {
    const bundle = {
      siteId: "s", analysisId: "a", baseUrl: "https://x.com", findings: [], competitors: [], keywords,
      searchMetrics: [{ query: "ivf cost penang", page: "https://x.com/ivf", country: "mys", device: "MOBILE", impressions: 900, clicks: 8, ctr: 0.009, position: 7 }],
    };
    const opportunities = buildOpportunities(bundle);
    const striking = opportunities.find((opportunity) => opportunity.title.includes("ivf cost penang"))!;
    assert.equal(striking.searchDemand, 2400);
    assert.ok(striking.rationale.includes("2,400 searches a month"), striking.rationale);
    assert.ok(opportunities.some((opportunity) => opportunity.intent === "keyword_gap" && opportunity.title.includes("dj stent")), "the gap the site doesn't rank for");
    assert.ok(!opportunities.some((opportunity) => opportunity.intent === "keyword_gap" && opportunity.title.includes("ivf cost penang")), "a keyword the site ranks for is no gap");
    const plan = synthesizeGrowthPlan(bundle);
    const priority = plan.priorities.find((entry) => entry.title.includes("dj stent"))!;
    assert.ok(priority.implementationRequired.includes("landing page"), priority.implementationRequired);
    assert.ok(priority.contentRequired.includes("rival.example"), priority.contentRequired);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/agents && npm test 2>&1 | grep -E "error TS" | head -5`
Expected: type errors: `query` not in the ranking input; `gapOpportunities` not exported; `keywords` not in `AnalysisBundle`.

- [ ] **Step 3: Implement**

`packages/agents/src/demand.ts`:
```ts
/*
 * Search demand and difficulty for an opportunity, in one place. A query that
 * DataForSEO has priced (the site's keyword lists) gets its real volume and
 * difficulty; anything else is estimated from what the analysis saw, and the
 * rationales say so.
 */
import type { KeywordDemand } from "@organic-growth/core";

export type DemandInput =
  /** A query ranking 4–15: harder the further from page one; demand is what Search Console saw. */
  | { kind: "ranking"; query: string; position: number; impressions: number }
  /** Rewriting a page-one snippet: cheap. */
  | { kind: "snippet"; query: string; impressions: number }
  /** A page type competitors publish and the site doesn't: their investment stands in for demand we can't see. */
  | { kind: "content_gap"; competitorPages: number }
  /** Records collected but not yet published as pages. */
  | { kind: "unpublished_data" }
  /** A technical fix, scaled by effort (1–4). */
  | { kind: "technical"; effort: number };

export type DemandEstimate = { searchDemand: number; estimatedDifficulty: number; /** A sentence for the rationale when the figures are DataForSEO's. */ priced: string | null };

export function estimateDemand(input: DemandInput, demand?: KeywordDemand): DemandEstimate {
  const cap = (value: number) => Math.min(100, Math.round(value));
  if ((input.kind === "ranking" || input.kind === "snippet") && demand) {
    const price = demand.lookup(input.query);
    if (price && price.volume !== null && price.difficulty !== null) {
      return { searchDemand: price.volume, estimatedDifficulty: price.difficulty, priced: `${price.volume.toLocaleString("en")} searches a month, difficulty ${price.difficulty} of 100 (DataForSEO).` };
    }
  }
  switch (input.kind) {
    case "ranking": return { searchDemand: input.impressions, estimatedDifficulty: cap(input.position * 5), priced: null };
    case "snippet": return { searchDemand: input.impressions, estimatedDifficulty: 10, priced: null };
    case "content_gap": return { searchDemand: 0, estimatedDifficulty: cap(Math.log10(input.competitorPages + 1) * 25), priced: null };
    case "unpublished_data": return { searchDemand: 0, estimatedDifficulty: 20, priced: null };
    case "technical": return { searchDemand: 0, estimatedDifficulty: cap(input.effort * 15), priced: null };
  }
}
```

The five call sites stop spreading the estimate (its `priced` sentence must not land in the stored opportunity) and name the two fields instead:

`packages/agents/src/search.ts`: `export function searchOpportunities(insights: SearchInsights, siteId: string, analysisId: string, demand?: KeywordDemand): Opportunity[]` (import `type KeywordDemand` from core). In the striking map, before the object literal:
```ts
    const estimate = estimateDemand({ kind: "ranking", query: entry.query, position: entry.position, impressions: entry.impressions }, demand);
```
and in the literal `searchDemand: estimate.searchDemand, estimatedDifficulty: estimate.estimatedDifficulty,` with the rationale ending `… A prioritization aid, not a traffic forecast.${estimate.priced ? ` ${estimate.priced}` : ""}`. In the snippet map the same with `const estimate = estimateDemand({ kind: "snippet", query: page.queries[0] ?? "", impressions: page.impressions }, demand);`, the two fields, and `${estimate.priced ? ` ${estimate.priced}` : ""}` appended to its rationale.

`packages/agents/src/competition.ts`, in `competitionOpportunities`: `const estimate = estimateDemand({ kind: "content_gap", competitorPages: leader.pages });` beside `const leader = …`, then `searchDemand: estimate.searchDemand, estimatedDifficulty: estimate.estimatedDifficulty,` in place of the spread.

`packages/agents/src/index.ts`, in `buildOpportunities`: the technical map gets `const estimate = estimateDemand({ kind: "technical", effort });` after `const effort = …`; the unpublished-data map gets `const estimate = estimateDemand({ kind: "unpublished_data" });` after `const waiting = …`; both literals name the two fields in place of the spread.

`packages/agents/src/index.ts`:
- Imports: `demandFromSnapshots, keywordGaps, type KeywordGap, type KeywordsInput` from core.
- `AnalysisBundle` gains `/** The site's and competitors' keyword lists from the Performance sync, for real demand and keyword gaps. */ keywords?: KeywordsInput;`
- Add:
```ts
const COMMERCIAL_INTENT = new Set(["commercial", "transactional"]);

/** The biggest searches competitors win and the site doesn't, as pages to build: volume ≥ 100, difficulty ≤ 40, commercial intent first. */
export function gapOpportunities(gaps: KeywordGap[], siteId: string, analysisId: string): Opportunity[] {
  const commercial = (gap: KeywordGap) => COMMERCIAL_INTENT.has(gap.intent ?? "");
  return gaps
    .filter((gap) => (gap.volume ?? 0) >= 100 && gap.difficulty !== null && gap.difficulty <= 40)
    .sort((a, b) => Number(commercial(b)) - Number(commercial(a)) || (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 6)
    .map((gap) => {
      const volume = gap.volume!;
      const weight = commercial(gap) ? 1.5 : 1;
      return {
        id: createId("opp"), siteId, analysisId,
        title: `Rank for “${gap.keyword}”: ${volume.toLocaleString("en")} searches a month; ${gap.domain} ranks ${gap.position}`,
        searchDemand: volume, estimatedDifficulty: gap.difficulty!, intent: "keyword_gap", competitorStrength: gap.position,
        potentialPage: `https://${gap.domain}${gap.url}`,
        businessValue: weight, conversionPotential: commercial(gap) ? 1 : 0.5, technicalEffort: 1, contentEffort: 3,
        priorityScore: Number((Math.log10(volume + 1) * 12 * (1 - gap.difficulty! / 100) * weight).toFixed(2)),
        rationale: `${volume.toLocaleString("en")} searches a month in your target markets, difficulty ${gap.difficulty} of 100, ${gap.intent ?? "unknown"} intent (DataForSEO). ${gap.domain} ranks ${gap.position} with ${gap.url}; you don't appear. A page that answers this search directly is the usual way in.`,
      };
    });
}
```
- In `buildOpportunities`: `const demand = bundle.keywords ? demandFromSnapshots(bundle.keywords.priced.flatMap((list) => list.rows)) : undefined;` pass it: `searchOpportunities(search, bundle.siteId, bundle.analysisId, demand)`; add `const gaps = bundle.keywords ? gapOpportunities(keywordGaps(bundle.keywords), bundle.siteId, bundle.analysisId) : [];` and include `...gaps` in the returned list before sorting.
- In `synthesizeGrowthPlan`'s `priorities`, add the `keyword_gap` branches:
  - `whyThisMatters`: before the `content_gap` branch: `opp.intent === "keyword_gap" ? \`${opp.rationale} Real searches, measured monthly: this is demand you can see before building.\` :`
  - `implementationRequired`: `opp.intent === "keyword_gap" ? "Build a landing page that answers this search (a dataset and template in Data, or a page by hand), and link it from related pages." :`
  - `contentRequired`: `opp.intent === "keyword_gap" ? \`Study ${opp.potentialPage} for the facts searchers expect, then answer the search more completely, in the market's language.\` :`
  - `risk`: `opp.intent === "keyword_gap" ? "Volume is a monthly average for the country; check that the search's intent matches what the business sells before building." :`

`packages/agents/src/pipeline.ts`: `RunAnalysisInput` gains `/** Keyword lists from the Performance sync (DataForSEO), when synced. */ keywords?: KeywordsInput;` (import the type from core) and the bundle literal gains `keywords: input.keywords,`.

`apps/web/src/analysis-workflow.ts`: import `loadKeywords` from `./keywords-data` and `listSiteCompetitorDomains` from db if not imported; extend the `Promise.all` to `const [coverage, examples, datasets, targetMarkets, entityKeys, competitorDomains] = await Promise.all([…, listSiteCompetitorDomains(db, siteId)]);` then `const keywords = await loadKeywords(db, site, { markets: targetMarkets, competitors: competitorDomains });` and pass `keywords,` into `runFullAnalysis`.

`apps/web/app/components/report-model.ts`: `intent === "content_gap" || intent === "unpublished_data" || intent === "keyword_gap" ? "competitors"`.

- [ ] **Step 4: Run the agents tests, typecheck, full suite**

Run: `cd packages/agents && npm test 2>&1 | grep -E "not ok|# (pass|fail)"; cd ../.. && npm run typecheck 2>&1 | grep "error TS" | head; npm test 2>&1 | grep -E "^# fail" | sort | uniq -c`
Expected: all `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/demand.ts packages/agents/src/demand.test.ts packages/agents/src/search.ts packages/agents/src/competition.ts packages/agents/src/index.ts packages/agents/src/pipeline.ts packages/agents/src/opportunities.test.ts apps/web/src/analysis-workflow.ts apps/web/app/components/report-model.ts
git commit -m "Growth plan: real volume and difficulty for priced queries, and keyword gaps as pages to build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The demo site shows the card; look at it

**Files:**
- Modify: `packages/agents/src/demo.ts` (`seedDemoResults`)
- Modify: `packages/agents/src/demo.test.ts`

**Interfaces:**
- Consumes: `saveSnapshot` (db), `PricedKeyword`, `RankedKeyword` (core).

- [ ] **Step 1: Write the failing test** (append inside the demo test's `it`, after the `signals` assertions; import `listSnapshots, keywordsView`-friendly types as needed)

```ts
    const priced = await listSnapshots<{ keyword: string; volume: number | null }>(db, DEMO_SITE_ID, "keywords");
    const ranked = await listSnapshots<{ keyword: string }>(db, DEMO_SITE_ID, "competitor_keywords");
    assert.equal(priced.length, 1, "the demo's queries are priced for Malaysia");
    assert.ok(priced[0]!.rows.length >= 8 && priced[0]!.rows.some((row) => row.volume === null), "a query DataForSEO doesn't know shows no volume");
    assert.deepEqual(ranked.map((list) => list.scope).sort(), ["brightcare-dental.example|mys", "demo-clinic.example|mys", "smile-dental.example|mys"]);
    const kw = await listMetricSeries(db, DEMO_SITE_ID, ["sync.competitor_keywords", "sync.keyword_volumes", "kw_traffic", "kw_traffic:brightcare-dental.example"], addDays(today, -40), today);
    assert.ok(kw["sync.competitor_keywords"]!.length && kw["sync.keyword_volumes"]!.length && kw.kw_traffic!.length && kw["kw_traffic:brightcare-dental.example"]!.length, "keyword markers and visibility points");
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/agents && npm test 2>&1 | grep -E "^    not ok|# (pass|fail)"`
Expected: the demo test fails on `priced.length` (0 ≠ 1).

- [ ] **Step 3: Seed the keyword data**

In `packages/agents/src/demo.ts`, add `saveSnapshot` to the `@organic-growth/db` import and `type PricedKeyword, type RankedKeyword` to the core import. At the end of `seedDemoResults`, before `await syncFirstPartyResults(...)`:

```ts
  // Fictional keyword data for Malaysia: the demo's queries priced (one unknown to DataForSEO), and ranked lists for the clinic and both competitors.
  const volumes: Array<[number | null, number, string]> = [[1900, 34, "commercial"], [2400, 41, "commercial"], [null, 0, "navigational"], [1300, 22, "commercial"], [2900, 58, "commercial"], [880, 27, "commercial"], [720, 19, "transactional"], [590, 31, "commercial"], [480, 15, "transactional"], [260, 12, "commercial"]];
  const pricedRows: PricedKeyword[] = queries.map(([query, clicks, impressions, position], index) => {
    const [volume, difficulty, intent] = volumes[index]!;
    return { keyword: query, volume, difficulty: volume === null ? null : difficulty, intent: volume === null ? null : intent, position, clicks, impressions };
  });
  await saveSnapshot(db, DEMO_SITE_ID, { kind: "keywords", scope: "sc-domain:demo-clinic.example|mys", periodEnd: addDays(today, -3), rows: pricedRows });
  const rankedRow = (keyword: string, volume: number, difficulty: number, intent: string, position: number, url: string): RankedKeyword =>
    ({ keyword, volume, difficulty, intent, position, url, traffic: Math.round(volume * (position <= 3 ? 0.2 : position <= 10 ? 0.05 : 0.01)) });
  const rankedLists: Record<string, RankedKeyword[]> = {
    "demo-clinic.example": [rankedRow("dental implants kuala lumpur", 1900, 34, "commercial", 4, "/implants"), rankedRow("braces price malaysia", 2400, 41, "commercial", 6, "/braces"), rankedRow("demo dental clinic", 300, 0, "navigational", 1, "/")],
    [competitors[0] ?? "brightcare-dental.example"]: [
      rankedRow("veneers price malaysia", 3600, 24, "commercial", 3, "/veneers-price"), rankedRow("dental implants kuala lumpur", 1900, 34, "commercial", 2, "/implants"),
      rankedRow("gum disease treatment", 2200, 18, "informational", 5, "/gum-disease"), rankedRow("emergency dentist kl", 1600, 9, "transactional", 2, "/emergency"), rankedRow("dental crown cost", 1300, 29, "commercial", 7, "/crowns"),
    ],
    [competitors[1] ?? "smile-dental.example"]: [
      rankedRow("veneers price malaysia", 3600, 24, "commercial", 8, "/veneers"), rankedRow("kids dentist kl", 900, 11, "commercial", 3, "/kids"), rankedRow("teeth cleaning price", 2600, 21, "commercial", 4, "/cleaning"),
    ],
  };
  const keywordPoints: MetricPoint[] = [{ metric: "sync.competitor_keywords", day: today, value: 1 }, { metric: "sync.keyword_volumes", day: today, value: 1 }];
  for (const [domain, rows] of Object.entries(rankedLists)) {
    await saveSnapshot(db, DEMO_SITE_ID, { kind: "competitor_keywords", scope: `${domain}|mys`, periodEnd: today, rows });
    const suffix = domain === "demo-clinic.example" ? "" : `:${domain}`;
    keywordPoints.push({ metric: `kw_top10${suffix}`, day: today, value: rows.filter((row) => row.position <= 10).length }, { metric: `kw_traffic${suffix}`, day: today, value: rows.reduce((total, row) => total + row.traffic, 0) });
  }
  await upsertMetricPoints(db, DEMO_SITE_ID, keywordPoints);
```

(`queries` and `competitors` are the arrays already defined earlier in `seedDemoResults`; `competitors` comes from `listSiteCompetitorDomains`, seeded as `brightcare-dental.example` and `smile-dental.example`.)

- [ ] **Step 4: Run the agents tests and the full suite**

Run: `cd packages/agents && npm test 2>&1 | grep -E "not ok|# (pass|fail)"; cd ../.. && npm run typecheck 2>&1 | grep "error TS" | head; npm test 2>&1 | grep -E "^# fail" | sort | uniq -c`
Expected: all `# fail 0`.

- [ ] **Step 5: Look at the card on the demo site**

Don't touch the user's dev server on 5174 or its state in `apps/web/.cloudflare/state`. Start an isolated server on 5175 with its own state and cache, both under the session scratchpad (`$SCRATCH` below):

```ts
// $SCRATCH/vite.isolated.config.ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

export default defineConfig({
  root: "/home/gabrielchin/Desktop/workstation/eumon-growth-engine/apps/web",
  cacheDir: process.env.SCRATCH + "/vite-cache",
  plugins: [
    vinext({ images: { optimizer: imagesOptimizer() } }),
    cloudflare({ remoteBindings: false, persistState: { path: process.env.SCRATCH + "/state" }, viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
  ],
});
```

```bash
cd apps/web
npx cf d1 migrations apply 591e4045-cbff-4ef4-a894-cbe4ece424ec --local --persist-to "$SCRATCH/state" --dir ../../packages/db/migrations
SCRATCH="$SCRATCH" VINEXT_NO_DEV_LOCK=1 npx vite dev --config "$SCRATCH/vite.isolated.config.ts" --port 5175 --strictPort   # run in the background
curl -s -X POST http://localhost:5175/api/dev/demo-site
```

Then open `http://localhost:5175` in the browser tools, pick the demo clinic, open Performance, and check in light and dark mode and at phone width:
- the Keywords card sits below "Google search": a priced table with one "—" volume, a gaps table naming the competitor with a position, and a bar list with the clinic first;
- the client link shows the same card without the credentials hint;
- the Overview's Competitors tab lists a "Rank for “veneers price malaysia”…" opportunity.
Fix anything off, then stop the isolated server.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/demo.ts packages/agents/src/demo.test.ts
git commit -m "Demo: priced queries, competitor keyword lists, and visibility for the Keywords card" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Memory, deploy notes, hand-off

**Files:**
- Modify: `CONTEXT.md` (Snapshot entry: now the store exists)
- Modify: the project memory file `eumon-seo-roadmap.md` and `migration-0009-pending.md` (0016 is applied locally only; new secrets `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`)

- [ ] **Step 1: Update `CONTEXT.md`**

Replace the **Snapshot** bullet with: `- **Snapshot** (\`site_snapshots\`, \`packages/db/src/snapshots.ts\`): a "latest list" that replaces itself, keyed by kind and scope: \`top_queries\` (property|markets), \`keywords\` (property|market: the site's priced queries), \`competitor_keywords\` (domain|market). Counts derived from a list (\`kw_top10\`, \`kw_traffic\`) go in the ledger so they trend.`

- [ ] **Step 2: Run the full verification once more**

Run: `npm run typecheck && npm test 2>&1 | grep -E "^# (tests|fail)" | paste - -`
Expected: every line ends `# fail 0`.

- [ ] **Step 3: Commit and report**

```bash
git add CONTEXT.md
git commit -m "Context: the snapshot store and its kinds" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Report to the user: what was built, the test counts, that migration 0016 and the two secrets are needed on deploy, and the one-time cost of the first sync (about $0.25 for medbay).
