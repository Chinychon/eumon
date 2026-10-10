# Rank Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators name up to 30 searches; Eumon checks Google's position for each one daily in every target market, keeps the history, shows it on the Keywords tab and the client link, and turns falls into findings and off-page keywords into opportunities.

**Architecture:** Two new tables (`tracked_keywords`, `rank_checks`) beside the existing `site_snapshots`. A new Workflow step group in `syncSite` (`ranks-queue`, `ranks-n`, `ranks-counts`) calls the existing `fetchSerp` 40 times a step and also refreshes the `serp` snapshot row, so every reader of results pages sees today's page. Pure view math in `packages/core/src/ranks.ts`; findings and opportunities in `packages/agents/src/rank-findings.ts`, fed through `ConnectorSignals.ranks`; a `RankTrackingCard` on the Keywords tab with the editor.

**Tech Stack:** TypeScript (Node type-stripping for tests), Cloudflare Workers + D1 (SQLite locally via `openSqliteD1`), node:test, React (Vite), DataForSEO SERP API.

**Spec:** `docs/superpowers/specs/2026-10-10-rank-tracking-design.md`

## Global Constraints

- Every new table carries `REFERENCES sites(id) ON DELETE CASCADE` (the demo test checks nothing survives a delete).
- A Workflow step makes at most 50 subrequests: **40** SERP fetches a step, D1 writes batched with `runStatements`.
- A request does a fixed number of D1 queries (never one per item; batch over `json_each` or statements).
- Keywords are stored lower-cased with whitespace collapsed; at most **30** per site; each 2–80 characters.
- DataForSEO is gated by the workspace's `dataForSeo` limit (`keysForLimits`, `featureRefusal`); the demo site never calls DataForSEO.
- Only ten results are fetched per page: a position past 10 is `null`, never estimated.
- Copy: "users", never "operator" in UI text; never name medbay or edea; hard corners in UI (no rounded styles).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run package tests with `npm test -w @organic-growth/<pkg>`; web tests with `node --test apps/web/src/<file>.test.ts` from the worktree root. After changing a package, `npm run build:packages` so the web app sees it.

## Review Focus

1. A keyword tracked in two markets where DataForSEO covers only one: the uncovered market is skipped with a note, the covered one is checked (Task 3 test "skips an uncovered market").
2. A manual "Sync now" after the daily run: no pair is fetched twice the same day, so nothing is spent (Task 3 test "a pair already checked today is not asked again").
3. A keyword removed from the list: its rows stay but the view and findings ignore it (Task 2 test "ignores checks for keywords no longer tracked"; Task 6 test "no finding for an untracked keyword").
4. A tracked keyword saved with different casing or spacing ("Dental  Implants ") equals an existing one: de-duplicated to one (Task 4 test "normalises and de-duplicates").
5. The first day of tracking (one check, no history): changes show "none", no finding fires, the card shows positions (Task 2 test "one day of checks"; Task 6 test "a single check gives nothing").

---

### Task 1: Tables and db helpers

**Files:**
- Create: `packages/db/migrations/0025_tracked_keywords.sql`
- Create: `packages/db/src/ranks.ts`
- Create: `packages/db/src/ranks.test.ts`
- Modify: `packages/db/src/index.ts` (add `export * from "./ranks.js";` after the `workspaces` line)
- Modify: `packages/core/src/ranks.ts` is created in Task 2; this task defines `RankCheck` in db and Task 2 moves nothing — see Interfaces.

**Interfaces:**
- Produces: `type RankCheck = { keyword: string; market: string; day: string; position: number | null; url: string | null; features: string[] }` (exported from `@organic-growth/core` in Task 2; for this task define it in `packages/db/src/ranks.ts` and re-point the import in Task 2).
- Produces: `setTrackedKeywords(db, siteId, keywords: string[])`, `listTrackedKeywords(db, siteId): Promise<string[]>`, `saveRankChecks(db, siteId, rows: RankCheck[])`, `listRankChecks(db, siteId, fromDay: string): Promise<RankCheck[]>`, `checkedPairsOn(db, siteId, day): Promise<Set<string>>` (keys `${keyword}|${market}`), `pruneRankChecks(db, siteId, beforeDay)`.

- [ ] **Step 1: Write the migration**

```sql
-- Rank tracking: the searches the user names, and Google's position for each in each target market, per day.
-- `position` is null when the site isn't in the ten results fetched. Rows older than 400 days are pruned by the sync.
CREATE TABLE tracked_keywords (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, keyword)
);

CREATE TABLE rank_checks (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  market TEXT NOT NULL,
  day TEXT NOT NULL,
  position INTEGER,
  url TEXT,
  features_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (site_id, keyword, market, day)
);
CREATE INDEX rank_checks_site_day ON rank_checks (site_id, day);
```

- [ ] **Step 2: Write the failing test** `packages/db/src/ranks.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openSqliteD1 } from "./sqlite.js";
import { upsertSite } from "./index.js";
import { checkedPairsOn, listRankChecks, listTrackedKeywords, pruneRankChecks, saveRankChecks, setTrackedKeywords, type RankCheck } from "./ranks.js";

const at = "2026-10-07T04:15:00.000Z";
async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
  return db;
}
const check = (keyword: string, day: string, position: number | null, market = "mys"): RankCheck => ({ keyword, market, day, position, url: position ? "https://x.com/p" : null, features: position ? ["local_pack"] : [] });

describe("rank tracking store", () => {
  it("replaces the tracked list", async () => {
    const db = await site();
    await setTrackedKeywords(db, "s", ["dental implants", "braces price"]);
    await setTrackedKeywords(db, "s", ["braces price"]);
    assert.deepEqual(await listTrackedKeywords(db, "s"), ["braces price"]);
  });

  it("upserts checks: saving a day twice keeps one row, with the later values", async () => {
    const db = await site();
    await saveRankChecks(db, "s", [check("braces price", "2026-10-06", 4), check("braces price", "2026-10-07", 5)]);
    await saveRankChecks(db, "s", [check("braces price", "2026-10-07", 3)]);
    const rows = await listRankChecks(db, "s", "2026-10-01");
    assert.deepEqual(rows.map((row) => [row.day, row.position, row.features]), [["2026-10-06", 4, ["local_pack"]], ["2026-10-07", 3, ["local_pack"]]]);
    assert.deepEqual(await checkedPairsOn(db, "s", "2026-10-07"), new Set(["braces price|mys"]));
  });

  it("lists from a day, oldest first, and prunes before a day", async () => {
    const db = await site();
    await saveRankChecks(db, "s", [check("a", "2025-01-01", 1), check("a", "2026-10-06", null), check("a", "2026-10-07", 2)]);
    assert.deepEqual((await listRankChecks(db, "s", "2026-10-06")).map((row) => row.position), [null, 2]);
    await pruneRankChecks(db, "s", "2026-01-01");
    assert.equal((await listRankChecks(db, "s", "2000-01-01")).length, 2);
  });

  it("deleting the site removes keywords and checks", async () => {
    const db = await site();
    await setTrackedKeywords(db, "s", ["a"]);
    await saveRankChecks(db, "s", [check("a", "2026-10-07", 1)]);
    await db.prepare("DELETE FROM sites WHERE id = ?").bind("s").run();
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tracked_keywords").first<{ n: number }>())!.n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM rank_checks").first<{ n: number }>())!.n, 0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w @organic-growth/db`
Expected: compile error — `./ranks.js` not found.

- [ ] **Step 4: Write `packages/db/src/ranks.ts`**

```ts
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

/*
 * Rank tracking: the searches the user names (`tracked_keywords`) and Google's
 * position for each in each target market, per day (`rank_checks`). A check
 * with a null position means the site wasn't in the ten results fetched.
 */

export type RankCheck = { keyword: string; market: string; day: string; position: number | null; url: string | null; features: string[] };

/** Replaces the list. Keywords arrive normalised (lower-cased, whitespace collapsed) and de-duplicated. */
export async function setTrackedKeywords(db: D1Like, siteId: string, keywords: string[]): Promise<void> {
  const at = nowIso();
  await runStatements(db, [
    db.prepare("DELETE FROM tracked_keywords WHERE site_id = ?").bind(siteId),
    ...keywords.map((keyword) => db.prepare("INSERT INTO tracked_keywords (site_id, keyword, created_at) VALUES (?, ?, ?)").bind(siteId, keyword, at)),
  ]);
}

export async function listTrackedKeywords(db: D1Like, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT keyword FROM tracked_keywords WHERE site_id = ? ORDER BY keyword").bind(siteId).all<{ keyword: string }>();
  return results.map((row) => row.keyword);
}

/** One row per keyword, market and day; a day saved twice keeps the later values. */
export async function saveRankChecks(db: D1Like, siteId: string, rows: RankCheck[]): Promise<void> {
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO rank_checks (site_id, keyword, market, day, position, url, features_json) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, keyword, market, day) DO UPDATE SET position = excluded.position, url = excluded.url, features_json = excluded.features_json`,
  ).bind(siteId, row.keyword, row.market, row.day, row.position, row.url, JSON.stringify(row.features)));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

/** Every check from `fromDay` on, by keyword, market and day (oldest first). */
export async function listRankChecks(db: D1Like, siteId: string, fromDay: string): Promise<RankCheck[]> {
  const { results } = await db.prepare(
    "SELECT keyword, market, day, position, url, features_json FROM rank_checks WHERE site_id = ? AND day >= ? ORDER BY keyword, market, day",
  ).bind(siteId, fromDay).all<{ keyword: string; market: string; day: string; position: number | null; url: string | null; features_json: string }>();
  return results.map((row) => ({ keyword: row.keyword, market: row.market, day: row.day, position: row.position === null ? null : Number(row.position), url: row.url, features: JSON.parse(row.features_json) as string[] }));
}

/** The keyword|market pairs already checked on a day, so a second sync spends nothing. */
export async function checkedPairsOn(db: D1Like, siteId: string, day: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT keyword, market FROM rank_checks WHERE site_id = ? AND day = ?").bind(siteId, day).all<{ keyword: string; market: string }>();
  return new Set(results.map((row) => `${row.keyword}|${row.market}`));
}

export async function pruneRankChecks(db: D1Like, siteId: string, beforeDay: string): Promise<void> {
  await db.prepare("DELETE FROM rank_checks WHERE site_id = ? AND day < ?").bind(siteId, beforeDay).run();
}
```

Add to `packages/db/src/index.ts` after `export * from "./workspaces.js";`:

```ts
export * from "./ranks.js";
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @organic-growth/db`
Expected: PASS, including the existing suites.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0025_tracked_keywords.sql packages/db/src/ranks.ts packages/db/src/ranks.test.ts packages/db/src/index.ts
git commit -m "Rank tracking: tracked_keywords and rank_checks tables with their helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: View model and metric group (core)

**Files:**
- Create: `packages/core/src/ranks.ts`
- Create: `packages/core/src/ranks.test.ts`
- Modify: `packages/core/src/index.ts` (export `./ranks.js`; check how the other modules are exported there and follow it)
- Modify: `packages/core/src/results.ts` — `METRICS.ranks`, `ResultsInput.ranks`, `ResultsView.ranks`, `resultsView` computes it
- Modify: `packages/db/src/ranks.ts` — replace the local `RankCheck` with `import type { RankCheck } from "@organic-growth/core";` and `export type { RankCheck }` is no longer needed (core exports it)

**Interfaces:**
- Produces (core): `TRACKED_KEYWORDS_MAX = 30`, `normalizeKeyword(text): string`, `type RankCheck`, `type RankChange = { kind: "none" | "same" | "up" | "down" | "entered" | "left"; places: number }`, `type RankRow = { keyword; market; position: number | null; url: string | null; features: string[]; change7: RankChange; change30: RankChange; best: number | null; series: Array<{ day: string; position: number | null }> }`, `type RanksView = { tracked: number; checked: number; top3: number; top10: number; unranked: number; averagePosition: number | null; asOf: string | null; rows: RankRow[] }`, `ranksView({ tracked, markets, checks, today }): RanksView`, `rankCountPoints(checks, tracked, markets, day): MetricPoint[]`.
- `ResultsInput.ranks?: { tracked: string[]; checks: RankCheck[] }`; `ResultsView.ranks: RanksView`.
- `METRICS.ranks = ["sync.ranks", "tracked_checked", "tracked_top3", "tracked_top10", "tracked_unranked", "tracked_position_sum"]`.

- [ ] **Step 1: Write the failing test** `packages/core/src/ranks.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeKeyword, rankCountPoints, ranksView, type RankCheck } from "./ranks.js";

const today = "2026-10-07";
const day = (back: number) => new Date(Date.UTC(2026, 9, 7 - back)).toISOString().slice(0, 10);
const check = (keyword: string, back: number, position: number | null, market = "mys"): RankCheck => ({ keyword, market, day: day(back), position, url: position ? `https://x.com/${keyword}` : null, features: position ? ["ai_overview"] : [] });

describe("ranksView", () => {
  it("one day of checks: positions, no changes, counts", () => {
    const view = ranksView({ tracked: ["a", "b", "c"], markets: ["mys"], checks: [check("a", 0, 2), check("b", 0, 9), check("c", 0, null)], today });
    assert.equal(view.tracked, 3);
    assert.equal(view.checked, 3);
    assert.deepEqual([view.top3, view.top10, view.unranked], [1, 2, 1]);
    assert.equal(view.averagePosition, 5.5);
    assert.equal(view.asOf, today);
    assert.deepEqual(view.rows.map((row) => [row.keyword, row.position, row.change7.kind, row.change30.kind]), [["a", 2, "none", "none"], ["b", 9, "none", "none"], ["c", null, "none", "none"]]);
  });

  it("changes over 7 and 30 days, entered and left, best, and the series", () => {
    const checks = [check("a", 30, 8), check("a", 7, 6), check("a", 0, 3), check("b", 7, null), check("b", 0, 5), check("c", 7, 4), check("c", 0, null)];
    const view = ranksView({ tracked: ["a", "b", "c"], markets: ["mys"], checks, today });
    const a = view.rows.find((row) => row.keyword === "a")!;
    assert.deepEqual(a.change7, { kind: "up", places: 3 });
    assert.deepEqual(a.change30, { kind: "up", places: 5 });
    assert.equal(a.best, 3);
    assert.equal(a.series.length, 3);
    assert.equal(view.rows.find((row) => row.keyword === "b")!.change7.kind, "entered");
    assert.equal(view.rows.find((row) => row.keyword === "c")!.change7.kind, "left");
  });

  it("uses the last check at or before the comparison day when that day was not synced", () => {
    const view = ranksView({ tracked: ["a"], markets: ["mys"], checks: [check("a", 9, 10), check("a", 0, 4)], today });
    assert.deepEqual(view.rows[0]!.change7, { kind: "up", places: 6 });
  });

  it("ignores checks for keywords no longer tracked and markets no longer targeted, sorts ranked first", () => {
    const checks = [check("gone", 0, 1), check("a", 0, null), check("b", 0, 7), check("b", 0, 2, "sgp")];
    const view = ranksView({ tracked: ["a", "b"], markets: ["mys"], checks, today });
    assert.deepEqual(view.rows.map((row) => `${row.keyword}|${row.market}|${row.position}`), ["b|mys|7", "a|mys|null"]);
    assert.equal(view.tracked, 2);
    assert.equal(view.checked, 2);
  });

  it("a tracked keyword never checked is a row with no position and no checks", () => {
    const view = ranksView({ tracked: ["a"], markets: ["mys"], checks: [], today });
    assert.deepEqual(view.rows.map((row) => [row.keyword, row.position, row.series.length]), [["a", null, 0]]);
    assert.equal(view.checked, 0);
    assert.equal(view.asOf, null);
  });
});

describe("normalizeKeyword", () => {
  it("lower-cases and collapses whitespace", () => {
    assert.equal(normalizeKeyword("  Dental   Implants \n"), "dental implants");
  });
});

describe("rankCountPoints", () => {
  it("counts today's checks and sums ranked positions", () => {
    const points = rankCountPoints([check("a", 0, 2), check("b", 0, 9), check("c", 0, null), check("a", 1, 1)], ["a", "b", "c"], ["mys"], today);
    assert.deepEqual(Object.fromEntries(points.map((point) => [point.metric, point.value])), { tracked_checked: 3, tracked_top3: 1, tracked_top10: 2, tracked_unranked: 1, tracked_position_sum: 11 });
    assert.ok(points.every((point) => point.day === today));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @organic-growth/core`
Expected: compile error — `./ranks.js` not found.

- [ ] **Step 3: Write `packages/core/src/ranks.ts`**

```ts
import { addDays } from "./dates.js";

/*
 * Rank tracking, pure: the searches the user names, checked daily per target
 * market, and what the card and the ledger make of the checks. A null
 * position means the site wasn't in the ten results fetched.
 */

export const TRACKED_KEYWORDS_MAX = 30;
/** Days of history the card's series shows. */
export const RANK_SERIES_DAYS = 90;

export const normalizeKeyword = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

export type RankCheck = { keyword: string; market: string; day: string; position: number | null; url: string | null; features: string[] };
export type RankChange = { kind: "none" | "same" | "up" | "down" | "entered" | "left"; places: number };
export type RankRow = {
  keyword: string; market: string; position: number | null; url: string | null; features: string[];
  change7: RankChange; change30: RankChange; best: number | null;
  series: Array<{ day: string; position: number | null }>;
};
export type RanksView = { tracked: number; checked: number; top3: number; top10: number; unranked: number; averagePosition: number | null; asOf: string | null; rows: RankRow[] };

/** The position then against now: entered or left the ten, or places gained (positive) or lost. */
function change(then: RankCheck | undefined, now: RankCheck | undefined): RankChange {
  if (!then || !now) return { kind: "none", places: 0 };
  if (then.position === null && now.position === null) return { kind: "same", places: 0 };
  if (then.position === null) return { kind: "entered", places: 0 };
  if (now.position === null) return { kind: "left", places: 0 };
  const places = then.position - now.position;
  return { kind: places > 0 ? "up" : places < 0 ? "down" : "same", places: Math.abs(places) };
}

/** The last check on or before a day (a missed sync leaves a gap). */
const at = (series: RankCheck[], day: string) => series.filter((row) => row.day <= day).at(-1);

export function ranksView(input: { tracked: string[]; markets: string[]; checks: RankCheck[]; today: string }): RanksView {
  const tracked = new Set(input.tracked);
  const markets = new Set(input.markets);
  const bySeries = new Map<string, RankCheck[]>();
  for (const row of input.checks) {
    if (!tracked.has(row.keyword) || !markets.has(row.market)) continue;
    const key = `${row.keyword}|${row.market}`;
    bySeries.set(key, [...(bySeries.get(key) ?? []), row]);
  }
  const rows: RankRow[] = [];
  for (const keyword of input.tracked) {
    for (const market of input.markets) {
      const series = (bySeries.get(`${keyword}|${market}`) ?? []).sort((a, b) => a.day.localeCompare(b.day));
      const latest = series.at(-1);
      const monthAgo = latest ? addDays(latest.day, -30) : input.today;
      const ranked = series.filter((row) => row.day > monthAgo && row.position !== null).map((row) => row.position!);
      rows.push({
        keyword, market, position: latest?.position ?? null, url: latest?.url ?? null, features: latest?.features ?? [],
        change7: change(latest && at(series, addDays(latest.day, -7)), latest), change30: change(latest && at(series, monthAgo), latest),
        best: ranked.length ? Math.min(...ranked) : null,
        series: series.filter((row) => row.day > addDays(input.today, -RANK_SERIES_DAYS)).map((row) => ({ day: row.day, position: row.position })),
      });
    }
  }
  rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || a.keyword.localeCompare(b.keyword) || a.market.localeCompare(b.market));
  const checked = rows.filter((row) => row.series.length);
  const positions = checked.filter((row) => row.position !== null).map((row) => row.position!);
  return {
    tracked: input.tracked.length, checked: checked.length,
    top3: positions.filter((position) => position <= 3).length, top10: positions.length, unranked: checked.length - positions.length,
    averagePosition: positions.length ? Math.round((positions.reduce((sum, value) => sum + value, 0) / positions.length) * 10) / 10 : null,
    asOf: checked.map((row) => row.series.at(-1)!.day).sort().at(-1) ?? null,
    rows,
  };
}

/** The day's ledger points from its checks: pairs checked, in the top 3 and 10, not in the ten, and the sum of ranked positions (the reader derives the average). */
export function rankCountPoints(checks: RankCheck[], tracked: string[], markets: string[], day: string): Array<{ metric: string; day: string; value: number }> {
  const view = ranksView({ tracked, markets, checks: checks.filter((row) => row.day === day), today: day });
  const sum = view.rows.filter((row) => row.position !== null).reduce((total, row) => total + row.position!, 0);
  return [
    { metric: "tracked_checked", day, value: view.checked }, { metric: "tracked_top3", day, value: view.top3 }, { metric: "tracked_top10", day, value: view.top10 },
    { metric: "tracked_unranked", day, value: view.unranked }, { metric: "tracked_position_sum", day, value: sum },
  ];
}
```

`addDays` lives in `packages/core/src/results.ts:18`, and `results.ts` will import `ranks.ts`, so move it first: create `packages/core/src/dates.ts` holding `export function addDays(day: string, n: number): string { … }` (the body cut from `results.ts`), and in `results.ts` replace the definition with `export { addDays } from "./dates.js";` so every existing importer keeps working.

Export `ranks.js` from `packages/core/src/index.ts` the way `serp.js` is exported there.

- [ ] **Step 4: Wire `results.ts`**

In `packages/core/src/results.ts`:
- import `{ ranksView, type RankCheck, type RanksView } from "./ranks.js"`;
- add to `METRICS` after `serp`: ``/** Rank tracking: pairs checked a day, how many in the top 3 and 10, not in the ten, and the sum of ranked positions. */ ranks: ["sync.ranks", "tracked_checked", "tracked_top3", "tracked_top10", "tracked_unranked", "tracked_position_sum"],``
- add to `ResultsInput`: ``/** The tracked keywords and their daily checks (last 90 days). */ ranks?: { tracked: string[]; checks: RankCheck[] };``
- add to `ResultsView` after `serp: SerpView;`: `ranks: RanksView;`
- in `resultsView`, beside `const serp = serpView(...)`: `const ranks = ranksView({ tracked: input.ranks?.tracked ?? [], markets: input.markets, checks: input.ranks?.checks ?? [], today: input.today });` and add `ranks` to the returned object next to `serp`.

In `packages/db/src/ranks.ts` replace the local type with `import type { RankCheck } from "@organic-growth/core";` (db already depends on core; see `metrics.ts`).

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm run build -w @organic-growth/core && npm test -w @organic-growth/core && npm test -w @organic-growth/db`
Expected: PASS. If a results test asserts the exact `METRICS` list or the view's keys, update it to include `ranks`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/ranks.ts packages/core/src/ranks.test.ts packages/core/src/dates.ts packages/core/src/index.ts packages/core/src/results.ts packages/db/src/ranks.ts
git commit -m "Rank tracking: view model, ledger metric group and results input

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The daily rank-check steps

**Files:**
- Create: `apps/web/src/rank-tracking.ts`
- Create: `apps/web/src/rank-tracking.test.ts`
- Modify: `apps/web/src/sync-steps.ts:92-99` (after the `sources` step)
- Modify: `apps/web/src/sync-steps.test.ts` (one new test)

**Interfaces:**
- Consumes: `fetchSerp` (`@organic-growth/agents`), `marketLocation`, `dollars`, `said` (`./source-helpers.ts`), `getPageSettings`/`defaultPageSettings`, `listSiteMarkets`, `listTrackedKeywords`, `checkedPairsOn`, `saveRankChecks`, `getSnapshot`, `saveSnapshot`, `pruneRankChecks`, `upsertMetricPoints`, `rankCountPoints`, `listRankChecks`.
- Produces: `RANK_STEP = 40`; `type RankTarget = { keyword: string; market: string }`; `rankQueue(db, site, today): Promise<{ targets: RankTarget[]; notes: string[] }>`; `checkRanks(db, site, auth, today, targets, fetchFn?): Promise<{ checked: number; cost: number; notes: string[] }>`; `writeRankCounts(db, site, today): Promise<void>`; `trackRanks(db, safe, site, auth, today, fetchFn?): Promise<string[]>` (notes).

- [ ] **Step 1: Write the failing test** `apps/web/src/rank-tracking.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SerpResult } from "@organic-growth/core";
import { getSite, getSnapshot, listMetricSeries, listRankChecks, saveRankChecks, setSiteMarkets, setTrackedKeywords, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { checkRanks, rankQueue, RANK_STEP, writeRankCounts } from "./rank-tracking.ts";

const today = "2026-10-07";
const at = `${today}T04:15:00.000Z`;
const auth = { login: "me", password: "pw" };

async function site(markets: string[], keywords: string[]) {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
  await setSiteMarkets(db, "s", markets);
  await setTrackedKeywords(db, "s", keywords);
  return { db, record: (await getSite(db, "s"))! };
}

/** DataForSEO stand-in: the site ranks at the position the keyword's trailing number says, or not at all; `fails` names a keyword that errors. */
function serpStub(fails?: string) {
  const asked: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const task = JSON.parse(String(init?.body))[0] as { keyword: string; location_code: number };
    asked.push(`${task.keyword}@${task.location_code}`);
    if (task.keyword === fails) return new Response(JSON.stringify({ status_code: 40000, status_message: "bad", tasks: [] }));
    const position = Number(/(\d+)$/.exec(task.keyword)?.[1] ?? 0);
    const items = Array.from({ length: 10 }, (_, index) => ({ type: "organic", rank_group: index + 1, domain: index + 1 === position ? "x.com" : `r${index}.example`, url: `https://${index + 1 === position ? "x.com" : `r${index}.example`}/p`, title: "t" }));
    return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.004, result: [{ item_types: ["organic", "local_pack"], items }] }] }));
  }) as typeof fetch;
  return { asked, fetchFn };
}

describe("rank tracking steps", () => {
  it("queues every tracked keyword in every covered market, skipping an uncovered market with a note and pairs already checked today", async () => {
    const { db, record } = await site(["mys", "mmr"], ["kw 3", "kw 0"]);
    await saveRankChecks(db, "s", [{ keyword: "kw 0", market: "mys", day: today, position: null, url: null, features: [] }]);
    const queue = await rankQueue(db, record, today);
    assert.deepEqual(queue.targets, [{ keyword: "kw 3", market: "mys" }]);
    assert.ok(queue.notes.some((note) => note.includes("mmr")), queue.notes.join("; "));
  });

  it("checks a slice, saves the day's rows, refreshes the serp snapshot row, and goes on past a failing keyword", async () => {
    const { db, record } = await site(["mys"], ["kw 3", "kw 0", "kw bad"]);
    const { asked, fetchFn } = serpStub("kw bad");
    const result = await checkRanks(db, record, auth, today, [{ keyword: "kw 3", market: "mys" }, { keyword: "kw 0", market: "mys" }, { keyword: "kw bad", market: "mys" }], fetchFn);
    assert.equal(result.checked, 2);
    assert.ok(result.notes.some((note) => note.includes("kw bad")), result.notes.join("; "));
    assert.equal(asked.length, 3);
    const rows = await listRankChecks(db, "s", today);
    assert.deepEqual(rows.map((row) => [row.keyword, row.position, row.url, row.features]), [["kw 0", null, null, ["local_pack"]], ["kw 3", 3, "https://x.com/p", ["local_pack"]]]);
    const serp = (await getSnapshot<SerpResult>(db, "s", "serp", "mys"))!;
    assert.deepEqual(serp.rows.map((row) => [row.keyword, row.position, row.checkedAt]).sort(), [["kw 0", null, today], ["kw 3", 3, today]]);
  });

  it("writes the day's counts and the marker", async () => {
    const { db, record } = await site(["mys"], ["kw 3", "kw 0"]);
    await checkRanks(db, record, auth, today, [{ keyword: "kw 3", market: "mys" }, { keyword: "kw 0", market: "mys" }], serpStub().fetchFn);
    await writeRankCounts(db, record, today);
    const series = await listMetricSeries(db, "s", ["sync.ranks", "tracked_checked", "tracked_top3", "tracked_top10", "tracked_unranked", "tracked_position_sum"], today, today);
    assert.deepEqual(Object.fromEntries(Object.entries(series).map(([metric, points]) => [metric, points[0]?.value])), { "sync.ranks": 1, tracked_checked: 2, tracked_top3: 1, tracked_top10: 1, tracked_unranked: 1, tracked_position_sum: 3 });
  });

  it("the step size is 40", () => { assert.equal(RANK_STEP, 40); });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:packages && node --test apps/web/src/rank-tracking.test.ts`
Expected: FAIL — cannot find `./rank-tracking.ts`.

- [ ] **Step 3: Write `apps/web/src/rank-tracking.ts`**

```ts
import { authorityDomain, DEMO_SITE_ID, fetchSerp } from "@organic-growth/agents";
import { addDays, rankCountPoints, type RankCheck, type SerpResult, type SiteRecord } from "@organic-growth/core";
import {
  checkedPairsOn, defaultPageSettings, getPageSettings, getSnapshot, listRankChecks, listSiteMarkets, listTrackedKeywords, pruneRankChecks, saveRankChecks, saveSnapshot, upsertMetricPoints, type D1Like,
} from "@organic-growth/db";
import { dollars, marketLocation, said } from "./source-helpers.ts";
import type { StepOptions } from "./sync-steps.ts";

/*
 * Rank tracking's daily steps: the queue of (keyword, market) pairs not yet
 * checked today, SERP fetches 40 a step (the Free plan allows 50 subrequests
 * a step), and the day's counts. Each check also refreshes the `serp`
 * snapshot row, so the Search results card and the growth plan see today's
 * page without a second fetch.
 */

export const RANK_STEP = 40;
/** Days of checks kept. */
const KEEP_DAYS = 400;
const RANK: StepOptions = { retries: { limit: 1, delay: 30_000 }, timeout: 3 * 60_000 };

export type RankTarget = { keyword: string; market: string };
type Auth = { login: string; password: string };

/** Every tracked keyword in every covered market, minus the pairs already checked today. */
export async function rankQueue(db: D1Like, site: SiteRecord, today: string): Promise<{ targets: RankTarget[]; notes: string[] }> {
  const [keywords, markets, done] = await Promise.all([listTrackedKeywords(db, site.id), listSiteMarkets(db, site.id), checkedPairsOn(db, site.id, today)]);
  const notes: string[] = [];
  const covered = markets.filter((market) => {
    if (marketLocation(market) !== null) return true;
    notes.push(`ranks skipped ${market}: DataForSEO doesn't cover it`);
    return false;
  });
  const targets = keywords.flatMap((keyword) => covered.map((market) => ({ keyword, market }))).filter((target) => !done.has(`${target.keyword}|${target.market}`));
  return { targets, notes };
}

/** One slice of checks: fetch each page, save the rows, and put each page into its market's `serp` list. */
export async function checkRanks(db: D1Like, site: SiteRecord, auth: Auth, today: string, targets: RankTarget[], fetchFn: typeof fetch = fetch): Promise<{ checked: number; cost: number; notes: string[] }> {
  const language = ((await getPageSettings(db, site.id)) ?? defaultPageSettings(site.id, site.name, site.baseUrl)).language;
  const own = authorityDomain(site.baseUrl);
  const notes: string[] = [];
  const rows: RankCheck[] = [];
  const pages = new Map<string, SerpResult[]>();
  let cost = 0;
  for (const target of targets) {
    try {
      const answer = await fetchSerp(auth, { keyword: target.keyword, location: marketLocation(target.market)!, language, site: own, checkedAt: today, volume: null }, fetchFn);
      rows.push({ keyword: target.keyword, market: target.market, day: today, position: answer.row.position, url: answer.row.url, features: answer.row.features });
      pages.set(target.market, [...(pages.get(target.market) ?? []), answer.row]);
      cost += answer.cost;
    } catch (error) {
      notes.push(`ranks skipped “${target.keyword}” in ${target.market}: ${said(error)}`);
    }
  }
  await saveRankChecks(db, site.id, rows);
  for (const [market, results] of pages) {
    const kept = new Map(((await getSnapshot<SerpResult>(db, site.id, "serp", market))?.rows ?? []).map((row) => [row.keyword.toLowerCase(), row]));
    // The keyword list's volume is kept when the page was already there; a tracked keyword outside the lists has none.
    for (const row of results) kept.set(row.keyword.toLowerCase(), { ...row, volume: kept.get(row.keyword.toLowerCase())?.volume ?? null });
    await saveSnapshot(db, site.id, { kind: "serp", scope: market, periodEnd: today, rows: [...kept.values()] });
  }
  return { checked: rows.length, cost, notes };
}

/** The day's ledger points and the marker, then the prune. */
export async function writeRankCounts(db: D1Like, site: SiteRecord, today: string): Promise<void> {
  const [checks, keywords, markets] = await Promise.all([listRankChecks(db, site.id, today), listTrackedKeywords(db, site.id), listSiteMarkets(db, site.id)]);
  const points = rankCountPoints(checks, keywords, markets, today);
  await upsertMetricPoints(db, site.id, [...points, { metric: "sync.ranks", day: today, value: points.length }]);
  await pruneRankChecks(db, site.id, addDays(today, -KEEP_DAYS));
}

type Safe = <T>(name: string, fn: () => Promise<T>, options?: StepOptions) => Promise<{ ok: T } | { error: string }>;

/** The step group for one site: queue, 40 checks a step, counts. Returns the run's notes. */
export async function trackRanks(db: D1Like, safe: Safe, site: SiteRecord, auth: Auth, today: string, fetchFn?: typeof fetch): Promise<string[]> {
  if (site.id === DEMO_SITE_ID) return [];
  const queue = await safe("ranks-queue", () => rankQueue(db, site, today));
  if ("error" in queue) return [`ranks failed: ${queue.error}`];
  const notes = [...queue.ok.notes];
  if (!queue.ok.targets.length) return notes;
  let checked = 0;
  let cost = 0;
  let steps = 0;
  for (let offset = 0, round = 1; offset < queue.ok.targets.length; offset += RANK_STEP, round++) {
    const slice = queue.ok.targets.slice(offset, offset + RANK_STEP);
    const result = await safe(`ranks-${round}`, () => checkRanks(db, site, auth, today, slice, fetchFn), RANK);
    if ("error" in result) { notes.push(`ranks failed: ${result.error}`); break; }
    steps++;
    checked += result.ok.checked;
    cost += result.ok.cost;
    notes.push(...result.ok.notes);
  }
  if (checked) {
    notes.unshift(`ranks: ${checked} checked in ${steps} step${steps === 1 ? "" : "s"}, ${dollars(cost)}`);
    const counts = await safe("ranks-counts", () => writeRankCounts(db, site, today));
    if ("error" in counts) notes.push(`ranks counts failed: ${counts.error}`);
  }
  return notes;
}
```

If `DEMO_SITE_ID` or `authorityDomain` are not exported from `@organic-growth/agents` under those names, use the names `connector-sources.ts` and `sync-steps.ts` import.

- [ ] **Step 4: Wire `syncSite`**

In `apps/web/src/sync-steps.ts`, import `trackRanks` from `./rank-tracking.ts`, and after the line `notes.push(...("ok" in sources ? sources.ok : [...]))` add:

```ts
    // Rank tracking: DataForSEO where the workspace may spend it, after the sources so a new keyword list is priced first.
    const rankKeys = site.workspaceId ? keysForLimits(deps.keys, await limitsFor(deps.db, site.workspaceId)) : keysForLimits(deps.keys, FREE_LIMITS);
    if (rankKeys.dataForSeo) notes.push(...await trackRanks(deps.db, safe, site, rankKeys.dataForSeo, startedAt.slice(0, 10), deps.google(siteId).fetchFn));
```

(`limitsFor` is already awaited inside the sources step; this second call is one D1 read. If the implementer prefers, hoist the computed `keys` out of the `sources` step closure and reuse them.)

Add to `apps/web/src/sync-steps.test.ts` (reuse `addSite`, `recorder`, `deps`; the `deps` helper's `fetchFn` answers non-inspection URLs with `{ rows: [] }`, so pass a custom one through `extra.google`):

```ts
  it("checks tracked keywords 40 a step when the workspace may spend DataForSEO, and spends nothing on a second run the same day", async () => {
    const db = openSqliteD1();
    await addSite(db, "s", "");
    await setSiteMarkets(db, "s", ["mys"]);
    await setTrackedKeywords(db, "s", Array.from({ length: 41 }, (_, index) => `kw ${index}`));
    let serps = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (!url.includes("/serp/")) return new Response(JSON.stringify({ rows: [] }));
      serps++;
      return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.004, result: [{ item_types: ["organic"], items: [{ type: "organic", rank_group: 1, domain: "s.com", url: "https://s.com/p", title: "t" }] }] }] }));
    }) as typeof fetch;
    const { steps, step, count } = recorder();
    const keys = { dataForSeo: { login: "me", password: "pw" } };
    const run = () => syncSite(deps(db, count, PASS, { keys, google: () => ({ connect: async () => ({ token: "t", scopes: [] }), fetchFn }) }), step, "s", "daily");
    let notes = await run();
    assert.ok(notes.includes("ranks: 41 checked in 2 steps, $0.16"), notes.join("; "));
    assert.equal(steps.filter((entry) => /^s\/ranks-\d+$/.test(entry.name)).length, 2);
    assert.equal(serps, 41);
    notes = await run();
    assert.equal(serps, 41, "a pair already checked today is not asked again");
    assert.ok(!notes.some((note) => note.startsWith("ranks:")), notes.join("; "));
  });

  it("does not check ranks for a workspace without the DataForSEO feature", async () => {
    const db = openSqliteD1();
    await addSite(db, "s", "");
    await setSiteMarkets(db, "s", ["mys"]);
    await setTrackedKeywords(db, "s", ["kw"]);
    const { steps, step, count } = recorder();
    await syncSite(deps(db, count, PASS, { keys: { dataForSeo: { login: "me", password: "pw" } } }), step, "s", "daily");
    assert.ok(!steps.some((entry) => entry.name.startsWith("s/ranks-")), "FREE_LIMITS has dataForSeo: false; a site without a workspace follows it");
  });
```

For the first test the site needs a workspace whose limits allow DataForSEO. As `limits.test.ts:18` does: `await setLimitOverrides(db, "w", { dataForSeo: true });` then `await db.prepare("UPDATE sites SET workspace_id = 'w' WHERE id = 's'").run();` right after `addSite`. Import `setLimitOverrides`, `setSiteMarkets` and `setTrackedKeywords` from `@organic-growth/db` at the top of the test file.

- [ ] **Step 5: Run the tests**

Run: `node --test apps/web/src/rank-tracking.test.ts apps/web/src/sync-steps.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/rank-tracking.ts apps/web/src/rank-tracking.test.ts apps/web/src/sync-steps.ts apps/web/src/sync-steps.test.ts
git commit -m "Rank tracking: daily SERP checks 40 a step, serp snapshot refresh, day counts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The keywords API route

**Files:**
- Create: `apps/web/src/tracked-keywords.ts`
- Create: `apps/web/src/tracked-keywords.test.ts`
- Create: `apps/web/app/api/sites/[siteId]/keywords/route.ts`
- Modify: `apps/web/src/routes-guarded.test.ts` if it enumerates every route (read it; add the new route the way the competitors route is listed)

**Interfaces:**
- Produces: `parseTrackedKeywords(body: unknown): { keywords: string[] } | { error: string }`; `GET /api/sites/:siteId/keywords → { keywords: string[] }`; `PUT` with `{ keywords: string[] }` → `{ keywords }` or `{ error }` (400), `featureRefusal` message (403).

- [ ] **Step 1: Write the failing test** `apps/web/src/tracked-keywords.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTrackedKeywords } from "./tracked-keywords.ts";

describe("parseTrackedKeywords", () => {
  it("normalises and de-duplicates", () => {
    assert.deepEqual(parseTrackedKeywords({ keywords: ["Dental  Implants ", "dental implants", "Braces\nprice"] }), { keywords: ["dental implants", "braces price"] });
  });
  it("refuses a missing list, too many, and bad lengths", () => {
    assert.ok("error" in parseTrackedKeywords({}));
    assert.ok("error" in parseTrackedKeywords({ keywords: Array.from({ length: 31 }, (_, index) => `kw ${index}`) }));
    assert.ok("error" in parseTrackedKeywords({ keywords: ["a"] }));
    assert.ok("error" in parseTrackedKeywords({ keywords: ["x".repeat(81)] }));
    assert.ok("error" in parseTrackedKeywords({ keywords: [42] }));
  });
  it("an empty list clears tracking", () => {
    assert.deepEqual(parseTrackedKeywords({ keywords: [] }), { keywords: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/web/src/tracked-keywords.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `apps/web/src/tracked-keywords.ts` and the route**

```ts
import { normalizeKeyword, TRACKED_KEYWORDS_MAX } from "@organic-growth/core";

/** The request body of PUT /api/sites/:id/keywords: up to 30 keywords, 2–80 characters each once normalised, de-duplicated. */
export function parseTrackedKeywords(body: unknown): { keywords: string[] } | { error: string } {
  const list = (body as { keywords?: unknown } | null)?.keywords;
  if (!Array.isArray(list)) return { error: "Send a list of keywords." };
  if (list.length > TRACKED_KEYWORDS_MAX) return { error: `Track up to ${TRACKED_KEYWORDS_MAX} keywords.` };
  const keywords: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") return { error: "Each keyword must be text." };
    const keyword = normalizeKeyword(entry);
    if (keyword.length < 2 || keyword.length > 80) return { error: "Each keyword must be 2 to 80 characters." };
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  return { keywords };
}
```

`apps/web/app/api/sites/[siteId]/keywords/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { getSite, listTrackedKeywords, setTrackedKeywords } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";
import { featureRefusal, FREE_LIMITS } from "../../../../../src/limits";
import { parseTrackedKeywords } from "../../../../../src/tracked-keywords";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  return Response.json({ keywords: await listTrackedKeywords(env.DB, siteId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const site = await getSite(env.DB, siteId);
  // A site without a workspace follows FREE_LIMITS, which doesn't include DataForSEO.
  const refusal = site?.workspaceId ? await featureRefusal(env.DB, site.workspaceId, "dataForSeo") : (FREE_LIMITS.dataForSeo ? null : "This workspace's plan doesn't include keyword data yet.");
  if (refusal) return Response.json({ error: refusal }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Send a list of keywords." }, { status: 400 }); }
  const parsed = parseTrackedKeywords(body);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  await setTrackedKeywords(env.DB, siteId, parsed.keywords);
  return Response.json({ keywords: parsed.keywords });
}
```

Check `requireSite`'s return type: if `SiteAccess` already carries the site record (with `workspaceId`), use it instead of `getSite`.

- [ ] **Step 4: Run the tests**

Run: `node --test apps/web/src/tracked-keywords.test.ts apps/web/src/routes-guarded.test.ts && npm run typecheck -w @organic-growth/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/tracked-keywords.ts apps/web/src/tracked-keywords.test.ts "apps/web/app/api/sites/[siteId]/keywords/route.ts" apps/web/src/routes-guarded.test.ts
git commit -m "Rank tracking: keywords route with the DataForSEO gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Results loading and the card

**Files:**
- Modify: `apps/web/src/results-data.ts:10-32` (load tracked keywords and 90 days of checks into `ranks`)
- Create: `apps/web/app/components/results/RankTrackingCard.tsx`
- Modify: `apps/web/app/components/SitePanels.tsx:63-72` (`KeywordsPanel`)
- Modify: `apps/web/app/r/[token]/ClientReport.tsx:35` (before `KeywordsCard`)
- Modify: `apps/web/src/results-data.test.ts` (one assertion that `ranks` is populated)

**Interfaces:**
- Consumes: `ResultsView.ranks: RanksView`, `api<T>(path, { method, json })`, `Card`, `Badge`, `Button`, `LineChart`, `formatDay`, `countryName`, `SERP_FEATURES`, `TRACKED_KEYWORDS_MAX`.
- Produces: `RankTrackingCard({ ranks, siteId, operator, hasCredentials, hasMarkets, markets, onSaved? })`.

- [ ] **Step 1: Load the input**

In `loadResults` (`apps/web/src/results-data.ts`) add to the second `Promise.all`:

```ts
    listTrackedKeywords(db, site.id),
    listRankChecks(db, site.id, addDays(today, -90)),
```

destructure them as `tracked, checks`, and pass `ranks: { tracked, checks }` into `resultsView(...)`. Import both from `@organic-growth/db`.

Add to `apps/web/src/results-data.test.ts` (follow its existing site setup):

```ts
  it("loads tracked keywords and their checks into the view", async () => {
    // reuse the test file's db/site helper; then:
    await setTrackedKeywords(db, site.id, ["kw"]);
    await setSiteMarkets(db, site.id, ["mys"]);
    await saveRankChecks(db, site.id, [{ keyword: "kw", market: "mys", day: today, position: 4, url: "https://x.com/p", features: [] }]);
    const view = await loadResults(db, site, today);
    assert.deepEqual(view.ranks.rows.map((row) => [row.keyword, row.position]), [["kw", 4]]);
  });
```

Run: `node --test apps/web/src/results-data.test.ts` — expected FAIL (ranks empty) before the change, PASS after.

- [ ] **Step 2: Write the card** `apps/web/app/components/results/RankTrackingCard.tsx`

```tsx
"use client";

import { countryName, SERP_FEATURES, TRACKED_KEYWORDS_MAX, type RankChange, type RanksView } from "@organic-growth/core";
import { useState } from "react";
import { api, errorMessage, formatDay } from "../api";
import { LineChart } from "../charts";
import { Badge, Button, Card, Kpi } from "../ui";

const FEATURE_LABEL = Object.fromEntries(SERP_FEATURES.map(({ feature, label }) => [feature, label]));
const positionTone = (position: number) => (position <= 3 ? "green" : "amber");
/** A page costs about $0.004 at DataForSEO; thirty days a month. */
const monthlyCost = (keywords: number, markets: number) => keywords * markets * 0.004 * 30;

function Change({ change }: { change: RankChange }) {
  if (change.kind === "none") return <span className="muted">—</span>;
  if (change.kind === "same") return <span className="muted">0</span>;
  if (change.kind === "entered") return <span className="rank-up">entered</span>;
  if (change.kind === "left") return <span className="rank-down">left</span>;
  return <span className={change.kind === "up" ? "rank-up" : "rank-down"}>{change.kind === "up" ? "▲" : "▼"} {change.places}</span>;
}

/** Up to eight keywords' positions over time; drawn as places from 11 so the top of the chart is position 1. */
function Series({ ranks }: { ranks: RanksView }) {
  const shown = ranks.rows.filter((row) => row.series.length > 1).slice(0, 8);
  if (!shown.length) return null;
  const days = [...new Set(shown.flatMap((row) => row.series.map((point) => point.day)))].sort();
  return (
    <>
      <div className="section-title">Positions over time</div>
      <LineChart series={shown.map((row) => `${row.keyword} · ${countryName(row.market)}`)} partialFrom="9999-12-31"
        points={days.map((day) => ({ x: day, values: shown.map((row) => { const point = row.series.find((entry) => entry.day === day); return point ? 11 - (point.position ?? 11) : null; }) }))} />
      <p className="small muted">Higher is better: 10 means position 1, 0 means not in the top 10.</p>
    </>
  );
}

/**
 * The searches the user names, checked daily per target market: today's
 * position, the change over 7 and 30 days, the best position, the landing
 * page and the result types on the page. Users edit the list here.
 */
export function RankTrackingCard({ ranks, siteId, operator, hasCredentials, hasMarkets, markets, onSaved }: {
  ranks: RanksView; siteId: string; operator: boolean; hasCredentials: boolean; hasMarkets: boolean; markets: string[]; onSaved?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const current = [...new Set(ranks.rows.map((row) => row.keyword))];
  const draft = text ?? current.join("\n");
  const changed = draft.trim() !== current.join("\n").trim();

  async function save() {
    setBusy(true); setError(""); setSaved(false);
    try {
      await api<{ keywords: string[] }>(`/api/sites/${siteId}/keywords`, { method: "PUT", json: { keywords: draft.split("\n").map((line) => line.trim()).filter(Boolean) } });
      setText(null); setSaved(true); onSaved?.();
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }

  const empty = !hasCredentials ? (operator ? "Add DataForSEO credentials (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) to track positions." : "Not measured yet.")
    : !hasMarkets ? (operator ? "Set target markets in Setup: positions are checked per country." : "Not measured yet.")
    : !ranks.tracked ? (operator ? null : "No keywords are tracked yet.")
    : !ranks.checked ? "First check at the next sync." : null;
  const keywordCount = draft.split("\n").filter((line) => line.trim()).length;
  return (
    <Card title="Rank tracking" subtitle={`Google's position for each keyword, checked daily in your target markets by DataForSEO${ranks.asOf ? ` (last on ${formatDay(ranks.asOf)})` : ""}.`}>
      {empty && <p className="empty-state">{empty}</p>}
      {!empty && ranks.checked > 0 && (
        <>
          <div className="metrics-grid results-inline">
            <Kpi label="Tracked" value={ranks.tracked} />
            <Kpi label="In the top 3" value={ranks.top3} />
            <Kpi label="In the top 10" value={ranks.top10} />
            <Kpi label="Not in the top 10" value={ranks.unranked} />
            <Kpi label="Average position" value={ranks.averagePosition ?? "—"} caption="Of the keywords in the top 10" />
          </div>
          <div className="table-wrap">
            <table className="table top-queries">
              <thead><tr><th>Keyword</th><th>Market</th><th className="num">Position</th><th className="num">7 days</th><th className="num">30 days</th><th className="num">Best</th><th>Page</th><th>On the page</th></tr></thead>
              <tbody>{ranks.rows.map((row) => (
                <tr key={`${row.keyword}|${row.market}`}>
                  <td>{row.keyword}</td>
                  <td>{countryName(row.market)}</td>
                  <td className="num">{row.position === null ? <Badge tone="gray">not in top 10</Badge> : <Badge tone={positionTone(row.position)}>{row.position}</Badge>}</td>
                  <td className="num"><Change change={row.change7} /></td>
                  <td className="num"><Change change={row.change30} /></td>
                  <td className="num">{row.best ?? "—"}</td>
                  <td>{row.url ? <a href={row.url} target="_blank" rel="noreferrer">{new URL(row.url).pathname}</a> : "—"}</td>
                  <td>{row.features.map((feature) => <Badge key={feature} tone="gray">{FEATURE_LABEL[feature] ?? feature}</Badge>)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Series ranks={ranks} />
        </>
      )}
      {operator && hasCredentials && hasMarkets && (
        <>
          <div className="section-title">Keywords to track</div>
          <textarea className="textarea" style={{ minHeight: 96 }} placeholder={"dental implants\nbraces price kuala lumpur"} value={draft} onChange={(event) => setText(event.target.value)} />
          <div className="row" style={{ gap: 12, alignItems: "center", marginTop: 8 }}>
            <Button small variant="secondary" disabled={!changed} busy={busy} onClick={save}>Save keywords</Button>
            <span className="small muted">
              Up to {TRACKED_KEYWORDS_MAX}, one per line. {keywordCount} keyword{keywordCount === 1 ? "" : "s"} × {markets.length} market{markets.length === 1 ? "" : "s"} ≈ ${monthlyCost(keywordCount, markets.length).toFixed(2)} a month at DataForSEO. The first check runs at the next sync.
            </span>
            {saved && !changed && <span className="small muted">Saved</span>}
          </div>
          {error && <p className="error">{error}</p>}
        </>
      )}
    </Card>
  );
}
```

Match class names to what `KeywordsCard.tsx` and `ConnectionsView.tsx` (textarea, Button row) use. Add to `apps/web/app/globals.css`, beside `.rank-change`:

```css
.rank-up { color: var(--green-ink); }
.rank-down { color: var(--red); }
```

- [ ] **Step 3: Place the card**

`SitePanels.tsx` `KeywordsPanel`, before `<KeywordsCard …>`:

```tsx
      <RankTrackingCard ranks={results.ranks} siteId={site.id} operator hasCredentials={data.site.signals.keywords} hasMarkets={results.markets.length > 0} markets={results.markets} />
```

`ClientReport.tsx`, before `<KeywordsCard …>`:

```tsx
            {data.results.ranks.checked > 0 && <RankTrackingCard ranks={data.results.ranks} siteId="" operator={false} hasCredentials={data.site.signals.keywords} hasMarkets={data.results.markets.length > 0} markets={data.results.markets} />}
```

If `KeywordsPanel` has access to the results `reload` (see `useResults` in `site-data.ts` and how `onCompetitorsChanged` is threaded into `CompetitorsPanel`), pass `onSaved={reload}`; otherwise leave it: the card's own state shows "Saved".

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck -w @organic-growth/web && npm run build -w @organic-growth/web`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/results-data.ts apps/web/src/results-data.test.ts apps/web/app/components/results/RankTrackingCard.tsx apps/web/app/components/SitePanels.tsx "apps/web/app/r/[token]/ClientReport.tsx" apps/web/app/globals.css
git commit -m "Rank tracking card on the Keywords tab and the client link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Findings and opportunities

**Files:**
- Create: `packages/agents/src/rank-findings.ts`
- Create: `packages/agents/src/rank-findings.test.ts`
- Modify: `packages/agents/src/connector-findings.ts:36-44` (`ConnectorSignals.ranks?: RankSignals | null`)
- Modify: `packages/agents/src/pipeline.ts:358-363` (push `findingsFromRanks`)
- Modify: `packages/agents/src/index.ts:124-126` (`buildOpportunities`: add `rankOpportunities` before `withSerpContext`), export the new module
- Modify: `apps/web/src/connectors-data.ts:44-46` (`connectorSignals` takes `ranks`)
- Modify: `apps/web/src/analysis-workflow.ts:168-172` (load `loadRankSignals`)

**Interfaces:**
- Produces: `type RankSignals = { tracked: string[]; markets: string[]; checks: RankCheck[]; today: string }`; `RANKS` thresholds; `findingsFromRanks({ siteId, analysisId, ranks }): Finding[]`; `rankOpportunities({ siteId, analysisId, ranks, searchMetrics, existing, demand }): Opportunity[]`; `loadRankSignals(db, siteId, today): Promise<RankSignals | null>` (null when no tracked keywords).

- [ ] **Step 1: Write the failing test** `packages/agents/src/rank-findings.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Opportunity, RankCheck, SearchMetricRow } from "@organic-growth/core";
import { findingsFromRanks, rankOpportunities, type RankSignals } from "./rank-findings.js";

const today = "2026-10-07";
const day = (back: number) => new Date(Date.UTC(2026, 9, 7 - back)).toISOString().slice(0, 10);
const series = (keyword: string, positions: Array<number | null>, market = "mys"): RankCheck[] =>
  positions.map((position, index) => ({ keyword, market, day: day(positions.length - 1 - index), position, url: position ? `https://x.com/${position <= 5 ? "a" : "b"}` : null, features: position && position > 8 ? ["ai_overview"] : [] }));
const signals = (checks: RankCheck[], tracked = ["kw"]): RankSignals => ({ tracked, markets: ["mys"], checks, today });
const run = (checks: RankCheck[], tracked?: string[]) => findingsFromRanks({ siteId: "s", analysisId: "a", ranks: signals(checks, tracked) });

describe("findingsFromRanks", () => {
  it("a fall of five or more places from a 30-day best of 20 or better, with the day and the pages then and now", () => {
    const findings = run(series("kw", [4, 4, 4, 5, 7, 9, 10, 10]));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.title, `“kw” fell from 4 to 10 in Malaysia since ${day(4)}`);
    assert.equal(findings[0]!.category, "search");
    assert.match(findings[0]!.summary, /\/a .*\/b/s);
    assert.match(findings[0]!.summary, /AI Overview/);
    assert.equal(findings[0]!.organicImpactScore, 35 + 2 * 6);
  });

  it("dropping out of the ten after holding a position seven days or more", () => {
    const findings = run(series("kw", [2, 2, 2, 2, 2, 2, 2, 3, null, null]));
    assert.equal(findings[0]!.title, `“kw” dropped out of the top 10 in Malaysia since ${day(1)}`);
    assert.equal(findings[0]!.organicImpactScore, Math.min(80, 35 + 2 * 9 + 15));
  });

  it("a stable series, a small fall, a fall from a weak best, a short hold before leaving, and a single check give nothing", () => {
    assert.equal(run(series("kw", [5, 5, 5, 5])).length, 0);
    assert.equal(run(series("kw", [5, 5, 5, 9])).length, 0);
    assert.equal(run(series("kw", [null, null, 10, 10, 10, 10, 10, 10, 10, 10])).length, 0, "no fall: the best is 10, now 10");
    assert.equal(run(series("kw", [3, 3, null])).length, 0, "held only two days");
    assert.equal(run(series("kw", [3])).length, 0);
  });

  it("no finding for an untracked keyword; at most five, biggest falls first", () => {
    assert.equal(run(series("gone", [1, 1, 1, 9]), ["kw"]).length, 0);
    const many = Array.from({ length: 7 }, (_, index) => series(`k${index}`, [1, 1, 1, 2 + index + 5]));
    const findings = findingsFromRanks({ siteId: "s", analysisId: "a", ranks: signals(many.flat(), many.map((_, index) => `k${index}`)) });
    assert.equal(findings.length, 5);
    assert.ok(findings[0]!.organicImpactScore >= findings[4]!.organicImpactScore);
  });
});

describe("rankOpportunities", () => {
  const row = (query: string, position: number, impressions = 300): SearchMetricRow => ({ query, page: "https://x.com/p", country: "mys", device: "desktop", impressions, clicks: 5, ctr: 0.02, position });
  const existing = (query: string): Opportunity => ({ id: "o", siteId: "s", analysisId: "a", title: `Move “${query}” onto the first results (now position 12.0)`, searchDemand: 1, intent: "x", competitorStrength: 0, estimatedDifficulty: 1, businessValue: 1, conversionPotential: 1, technicalEffort: 1, contentEffort: 1, priorityScore: 1, rationale: "" });

  it("a tracked keyword not in the ten with a Search Console average of 30 or better, unless an opportunity already names it", () => {
    const ranks = signals(series("kw", [null, null]));
    const made = rankOpportunities({ siteId: "s", analysisId: "a", ranks, searchMetrics: [row("kw", 14)], existing: [] });
    assert.equal(made.length, 1);
    assert.match(made[0]!.title, /“kw”/);
    assert.equal(made[0]!.currentRank, 14);
    assert.equal(rankOpportunities({ siteId: "s", analysisId: "a", ranks, searchMetrics: [row("kw", 14)], existing: [existing("kw")] }).length, 0);
    assert.equal(rankOpportunities({ siteId: "s", analysisId: "a", ranks, searchMetrics: [row("kw", 44)], existing: [] }).length, 0);
    assert.equal(rankOpportunities({ siteId: "s", analysisId: "a", ranks: signals(series("kw", [null, 7])), searchMetrics: [row("kw", 14)], existing: [] }).length, 0, "ranked today");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @organic-growth/agents`
Expected: compile error — `./rank-findings.js` not found.

- [ ] **Step 3: Write `packages/agents/src/rank-findings.ts`**

```ts
import { addDays, countryName, createId, severityFromImpact, type Finding, type JsonObject, type Opportunity, type RankCheck, type SearchMetricRow, SERP_FEATURES } from "@organic-growth/core";
import { listRankChecks, listSiteMarkets, listTrackedKeywords, type D1Like } from "@organic-growth/db";
import { estimateDemand, type KeywordDemand } from "./demand.js";

/*
 * What rank tracking adds to an analysis: a finding when a tracked keyword
 * falls or drops out of the ten, and an opportunity when a tracked keyword
 * is off the first page but Search Console still sees it within reach.
 */

export type RankSignals = { tracked: string[]; markets: string[]; checks: RankCheck[]; today: string };

/** Thresholds, with their reasons. */
export const RANKS = {
  /** Days the best position is taken from. */
  LOOKBACK_DAYS: 30,
  /** A fall under this many places is noise between Google's data centres. */
  FALL_PLACES: 5,
  /** A best past this was never a real ranking to lose. */
  BEST_AT_MOST: 20,
  /** A keyword must have held a position this many days before "dropped out" means anything. */
  HELD_DAYS: 7,
  MAX_FINDINGS: 5,
  /** Search Console average position (28 days) within which an unranked tracked keyword is worth a push. */
  GSC_POSITION_AT_MOST: 30,
};

const label = (feature: string) => SERP_FEATURES.find((entry) => entry.feature === feature)?.label ?? feature;
const path = (url: string | null) => (url ? new URL(url).pathname : "no page");

/** Reads one keyword's checks in one market, oldest first, within the lookback. */
function seriesOf(signals: RankSignals): Map<string, RankCheck[]> {
  const tracked = new Set(signals.tracked);
  const since = addDays(signals.today, -RANKS.LOOKBACK_DAYS);
  const map = new Map<string, RankCheck[]>();
  for (const row of signals.checks) {
    if (!tracked.has(row.keyword) || !signals.markets.includes(row.market) || row.day < since) continue;
    const key = `${row.keyword}|${row.market}`;
    map.set(key, [...(map.get(key) ?? []), row].sort((a, b) => a.day.localeCompare(b.day)));
  }
  return map;
}

export function findingsFromRanks(input: { siteId: string; analysisId: string; ranks: RankSignals | null | undefined }): Finding[] {
  if (!input.ranks) return [];
  const drafts: Array<{ impact: number; title: string; summary: string; evidence: JsonObject; pagesAffected: string[] }> = [];
  for (const series of seriesOf(input.ranks).values()) {
    if (series.length < 2) continue;
    const latest = series.at(-1)!;
    const ranked = series.filter((row) => row.position !== null);
    if (!ranked.length) continue;
    const best = Math.min(...ranked.map((row) => row.position!));
    const bestRow = ranked.find((row) => row.position === best)!;
    const lastBest = [...ranked].reverse().find((row) => row.position === best)!;
    const since = series[series.indexOf(lastBest) + 1]?.day ?? latest.day;
    const market = countryName(latest.market);
    const appeared = latest.features.filter((feature) => !bestRow.features.includes(feature)).map(label);
    const pages = `The page was ${path(bestRow.url)} then and ${path(latest.url)} now${bestRow.url && latest.url && bestRow.url !== latest.url ? ": Google swapped the page it shows" : ""}.`;
    const since_ = appeared.length ? ` Since then the results page gained ${appeared.join(", ")}, which pushes the links down.` : "";
    const evidence: JsonObject = { keyword: latest.keyword, market: latest.market, best, now: latest.position, since, pageThen: bestRow.url, pageNow: latest.url };
    if (latest.position !== null) {
      const places = latest.position - best;
      if (places < RANKS.FALL_PLACES || best > RANKS.BEST_AT_MOST) continue;
      drafts.push({
        impact: Math.min(80, 35 + 2 * places + (best <= 3 ? 15 : 0)),
        title: `“${latest.keyword}” fell from ${best} to ${latest.position} in ${market} since ${since}`,
        summary: `Google's position for “${latest.keyword}” in ${market} was ${best} on ${bestRow.day} and is ${latest.position} on ${latest.day}. ${pages}${since_}`,
        evidence, pagesAffected: [latest.url ?? bestRow.url].filter((url): url is string => Boolean(url)),
      });
    } else {
      // Held: the run of ranked days ending at the last ranked check.
      const lastRanked = ranked.at(-1)!;
      let held = 0;
      for (let index = series.indexOf(lastRanked); index >= 0 && series[index]!.position !== null; index--) held++;
      if (held < RANKS.HELD_DAYS || best > RANKS.BEST_AT_MOST) continue;
      const left = series[series.indexOf(lastRanked) + 1]!.day;
      drafts.push({
        impact: Math.min(80, 35 + 2 * (11 - best) + (best <= 3 ? 15 : 0)),
        title: `“${latest.keyword}” dropped out of the top 10 in ${market} since ${left}`,
        summary: `Google's position for “${latest.keyword}” in ${market} was ${best} at best (${lastRanked.position} on ${lastRanked.day}) and the site is not in the ten results on ${latest.day}. ${pages}${since_}`,
        evidence: { ...evidence, since: left, held }, pagesAffected: [lastRanked.url].filter((url): url is string => Boolean(url)),
      });
    }
  }
  const createdAt = new Date().toISOString();
  return drafts.sort((a, b) => b.impact - a.impact).slice(0, RANKS.MAX_FINDINGS).map((draft) => ({
    id: createId("finding"), siteId: input.siteId, analysisId: input.analysisId, category: "search", severity: severityFromImpact(draft.impact),
    title: draft.title, summary: draft.summary, evidence: draft.evidence, organicImpactScore: draft.impact,
    recommendation: "Compare the page with the top three on today's results page (the Keywords tab shows them), check that it still answers the search and loads quickly, and strengthen its title and the internal links to it. History records the recovery.",
    pagesAffected: draft.pagesAffected, createdAt,
  }));
}

/** Tracked keywords not in today's ten that Search Console still sees at 30 or better, unless an opportunity already names them. */
export function rankOpportunities(input: { siteId: string; analysisId: string; ranks: RankSignals | null | undefined; searchMetrics: SearchMetricRow[]; existing: Opportunity[]; demand?: KeywordDemand }): Opportunity[] {
  if (!input.ranks) return [];
  const named = new Set(input.existing.map((opportunity) => /“(.+?)”/.exec(opportunity.title)?.[1]?.toLowerCase()).filter(Boolean));
  const made: Opportunity[] = [];
  for (const [key, series] of seriesOf(input.ranks)) {
    const [keyword, market] = key.split("|") as [string, string];
    if (series.at(-1)!.position !== null || named.has(keyword)) continue;
    const rows = input.searchMetrics.filter((row) => row.query.toLowerCase() === keyword);
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    if (!impressions) continue;
    const position = rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions;
    if (position > RANKS.GSC_POSITION_AT_MOST) continue;
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
    const estimate = estimateDemand({ kind: "ranking", query: keyword, position, impressions }, input.demand);
    named.add(keyword);
    made.push({
      id: createId("opp"), siteId: input.siteId, analysisId: input.analysisId,
      title: `Move “${keyword}” onto the first page in ${countryName(market)} (tracked; Search Console average position ${position.toFixed(1)})`,
      searchDemand: estimate.searchDemand, estimatedDifficulty: estimate.estimatedDifficulty, intent: "ranking (tracked keyword)",
      currentRank: Math.round(position * 10) / 10, competitorStrength: 0, currentPage: rows.sort((a, b) => b.impressions - a.impressions)[0]?.page,
      businessValue: 1.2, conversionPotential: 1, technicalEffort: 1, contentEffort: 2,
      priorityScore: Number((impressions * 0.1 / 2).toFixed(2)),
      rationale: `You chose to track “${keyword}”; Google's page for it in ${countryName(market)} doesn't show the site in the top 10, while Search Console reports ${impressions.toLocaleString("en")} impressions and ${clicks.toLocaleString("en")} clicks at average position ${position.toFixed(1)} over 28 days. A page already in reach of the first page.${estimate.priced ? ` ${estimate.priced}` : ""}`,
    });
  }
  return made;
}

/** What the analysis reads: the tracked list, the target markets, and 30 days of checks; null when nothing is tracked. */
export async function loadRankSignals(db: D1Like, siteId: string, today = new Date().toISOString().slice(0, 10)): Promise<RankSignals | null> {
  const tracked = await listTrackedKeywords(db, siteId);
  if (!tracked.length) return null;
  const [markets, checks] = await Promise.all([listSiteMarkets(db, siteId), listRankChecks(db, siteId, addDays(today, -RANKS.LOOKBACK_DAYS))]);
  return { tracked, markets, checks, today };
}
```

Check that `countryName` takes the alpha-3 code the markets use (`countryName("mys") === "Malaysia"`; see `packages/core/src/countries.ts`) and that `estimateDemand`'s `DemandInput` for `ranking` matches `{ kind, query, position, impressions }` (`demand.ts:28`); adjust the call if not. `priorityScore` mirrors the striking-distance formula's order of magnitude (`searchOpportunities`): if its `gain` helper (`expectedCtr`) is exported from `search.ts`, use `impressions * expectedCtr(3) / 2` instead of `impressions * 0.1 / 2`.

- [ ] **Step 4: Wire the pipeline, the bundle, the signals**

- `connector-findings.ts`: `import type { RankSignals } from "./rank-findings.js";` and add `ranks?: RankSignals | null;` to `ConnectorSignals`.
- `pipeline.ts` after the `findingsFromTrends` push: `findings.push(...findingsFromRanks({ siteId: input.siteId, analysisId, ranks: input.connectors?.ranks }));` (import it).
- `index.ts` `buildOpportunities`: before `return withSerpContext(...)`:
  ```ts
  const base = [...technical, ...fromSearch, ...contentGaps, ...unpublishedData, ...gaps, ...(links ? [links] : [])];
  const tracked = rankOpportunities({ siteId: bundle.siteId, analysisId: bundle.analysisId, ranks: bundle.connectors?.ranks, searchMetrics: bundle.searchMetrics, existing: base, demand });
  return withSerpContext([...base, ...tracked], bundle.connectors?.serp).sort((a, b) => b.priorityScore - a.priorityScore);
  ```
  and `export * from "./rank-findings.js";` where the other modules are exported.
- `apps/web/src/connectors-data.ts`: `connectorSignals(lists, logCoverage, searchConsole = null, trends = null, inventory = [], ranks: RankSignals | null = null)` returning `{ …, ranks }`.
- `apps/web/src/analysis-workflow.ts:172`: in the `.then`, load `await loadRankSignals(db, siteId).catch(() => null)` and pass it as the sixth argument; the `.catch` fallback passes `null`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm run build:packages && npm test -w @organic-growth/agents && npm run typecheck -w @organic-growth/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/rank-findings.ts packages/agents/src/rank-findings.test.ts packages/agents/src/connector-findings.ts packages/agents/src/pipeline.ts packages/agents/src/index.ts apps/web/src/connectors-data.ts apps/web/src/analysis-workflow.ts
git commit -m "Rank tracking: fall findings and tracked-keyword opportunities in the growth plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Demo site

**Files:**
- Modify: `packages/agents/src/demo.ts` — a new `seedDemoRanks` called right after `seedDemoConnectors` (grep `seedDemoConnectors(` in `demo.ts` for the call site), and `connectors.ranks` in the demo analysis input (lines ~440-449)
- Modify: `packages/agents/src/demo.test.ts:108-111` (assert the drop finding and the opportunity)

**Interfaces:**
- Consumes: `setTrackedKeywords`, `saveRankChecks`, `loadRankSignals`, `demoConnectorInput()` (its `ranked[own].mys` rows: `[keyword, volume, difficulty, intent, position, url]`), `TREATMENTS` (in `demo.ts`), `ORIGIN`.

- [ ] **Step 1: Write the failing assertion**

In `demo.test.ts`, beside the crawl-pace assertion (line ~110):

```ts
    const drop = report.findings.find((finding) => finding.title.includes("dropped out of the top 10"));
    assert.ok(drop, report.findings.map((finding) => finding.title).join(" | "));
```

Run: `npm test -w @organic-growth/agents` — expected FAIL on this assertion.

- [ ] **Step 2: Seed**

In `demo.ts`, add this function and call it right after `seedDemoConnectors(...)` with the same `now`:

```ts
/**
 * Rank tracking: seven of the clinic's own searches, checked daily for 60 days
 * in both markets, plus one search the clinic has never had in the ten but
 * Search Console sees at position 11 (the growth plan's opportunity). The
 * first tracked search slips from 4 to out of the ten over the last two weeks
 * (the growth plan's finding).
 */
async function seedDemoRanks(db: D1Like, now: number): Promise<void> {
  const today = new Date(now).toISOString().slice(0, 10);
  const demo = demoConnectorInput();
  const ownRows = (market: string) => demo.ranked[demo.own]?.[market] ?? [];
  const tracked = ownRows("mys").filter((row) => row[3] !== "navigational").slice(0, 7).map((row) => row[0]);
  const slipped = tracked[0]!;
  // demoSearchRows adds `${words} cost kuala lumpur` for every treatment at position 11 + i; the first one sits at 11.
  const unranked = `${TREATMENTS[0]!.replace(/-/g, " ")} cost kuala lumpur`;
  await setTrackedKeywords(db, DEMO_SITE_ID, [...tracked, unranked]);
  const checks: RankCheck[] = [];
  for (let back = 60; back >= 0; back--) {
    const day = addDays(today, -back);
    for (const market of ["mys", "sgp"]) {
      tracked.forEach((keyword, index) => {
        const row = ownRows(market).find((entry) => entry[0] === keyword);
        const base = row?.[4] ?? 6 + index;
        // The slipping search: 4 until two weeks ago, then one place a day until it leaves the ten.
        const raw = keyword === slipped ? (back > 14 ? 4 : 4 + (14 - back)) : Math.max(1, base - Math.round((60 - back) / 30) + (back % 9 === 0 ? 1 : 0));
        const position = raw <= 10 ? raw : null;
        checks.push({ keyword, market, day, position, url: position ? `${ORIGIN}${row?.[5] ?? "/"}` : null, features: index % 2 ? ["people_also_ask"] : [] });
      });
      checks.push({ keyword: unranked, market, day, position: null, url: null, features: ["ai_overview"] });
    }
  }
  await saveRankChecks(db, DEMO_SITE_ID, checks);
}
```

Import `type RankCheck` and `addDays` from `@organic-growth/core`, `saveRankChecks` and `setTrackedKeywords` from `@organic-growth/db` (add them to the existing import lists). If `demoConnectorInput` lives in `demo-connectors.ts` rather than `demo.ts`, import it; if `ORIGIN` is named differently in `demo.ts` (grep `const ORIGIN`), use that name.

In `demo.ts`'s demo analysis input (`connectors: { … }`), add: `ranks: await loadRankSignals(db, DEMO_SITE_ID, new Date(input.now).toISOString().slice(0, 10)),` (import from `./rank-findings.js`).

Add a second assertion to the demo test:

```ts
    const withOpportunities = (await getAnalysisJob(db, "analysis_demo_2"))!.report as unknown as { opportunities: Array<{ title: string }> };
    assert.ok(withOpportunities.opportunities.some((opportunity) => opportunity.title.includes("(tracked;")), "the tracked-keyword opportunity");
```

`runFullAnalysis` (`pipeline.ts`, the `return { … }` after `buildOpportunities`) names the key the opportunities are stored under; if it is not `opportunities`, use that key in the assertion.

- [ ] **Step 3: Run the tests**

Run: `npm run build:packages && npm test -w @organic-growth/agents`
Expected: PASS, including the ownership test (every rank row goes with the site).

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/demo.ts packages/agents/src/demo.test.ts
git commit -m "Demo site tracks eight keywords, one slipping out of the ten

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Words, docs, full check, PR

**Files:**
- Modify: `CONTEXT.md` (Sync and Growth plan sections)
- Modify: `apps/web/app/components/ConnectorSetup.tsx:172-177` (mention tracked keywords)
- Modify: `docs/site/pages/` — the page that lists the Keywords tab's cards, one sentence (find it with `grep -rl "Keyword gaps" docs/site`)

- [ ] **Step 1: CONTEXT.md**

Under **Sync** add:

```
- **Rank tracking** (`tracked_keywords`, `rank_checks`, `apps/web/src/rank-tracking.ts`): the searches the user names (up to 30), checked daily in every covered target market with the SERP source's `fetchSerp`, 40 a Workflow step (`ranks-queue`, `ranks-n`, `ranks-counts`) after the sources; a check also refreshes the keyword's row in the `serp` snapshot. A **check** keeps the position (null when not in the ten results fetched), the landing URL and the result types; `tracked_*` ledger metrics count the day. Rows older than 400 days are pruned.
```

Under **Growth plan** add:

```
- **Rank finding** (`findingsFromRanks`): a tracked keyword five or more places under its 30-day best (best 20 or better), or out of the ten after holding a position seven days; thresholds in `RANKS`. A tracked keyword not in the ten that Search Console averages at 30 or better is a `ranking` opportunity unless one already names the query.
```

- [ ] **Step 2: Setup copy**

In `ConnectorSetup.tsx` the DataForSEO paragraph (connected state) becomes: "Google's first page for your biggest searches (10 a day) and daily positions for the keywords you track on the Keywords tab, the domains that win them, and link profiles with the link gap, each refreshed monthly. Backlinks need the Backlinks API active on the DataForSEO account."

- [ ] **Step 3: Full check**

Run: `npm run typecheck && npm test`
Expected: clean and PASS. Fix anything that fails before continuing.

- [ ] **Step 4: Commit and open the PR**

```bash
git add CONTEXT.md apps/web/app/components/ConnectorSetup.tsx docs/site
git commit -m "Rank tracking: context terms and setup copy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin claude/rank-tracking
gh pr create --title "Rank tracking: daily positions for the keywords you choose" --body "$(cat <<'EOF'
Sub-project 1 of the competitor-features program (spec: docs/superpowers/specs/2026-10-10-rank-tracking-design.md).

- Users name up to 30 keywords on the Keywords tab; each is checked daily in every target market (DataForSEO SERP, 40 a step, ~$0.004 a page).
- `rank_checks` keeps position, landing URL and result types per day; the `serp` snapshot row is refreshed too, so the Search results card and the growth plan see today's page.
- Card with today's position, 7/30-day change, best, page, result types and a positions chart; read-only on the client link.
- Findings for falls of 5+ places or dropping out of the ten; opportunities for tracked keywords Search Console still sees within 30.
- Demo site seeded with eight tracked keywords.

Migration 0025 needs `npm run db:migrate:remote` on deploy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
