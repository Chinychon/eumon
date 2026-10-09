# Dashboard › History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An eighth Dashboard tab, History, listing every problem the analysis once reported that is now gone (with who or what fixed it) and every action taken through Eumon.

**Architecture:** Each finished analysis saves a compact key list of its findings into the existing `site_snapshots` store (kind `finding_keys`, scope = analysis id), flagging the previous run's findings whose pages vanished in this crawl (crawl rows are pruned later, so this is the only moment to know). Pure core code diffs consecutive key lists into resolutions; a web module joins them with `changes`, page revisions, CTA variants and page publications; a route serves it; a panel renders it.

**Tech Stack:** TypeScript monorepo; `node:test` with SQLite (`openSqliteD1`) for db and web tests; React (vinext) console; D1 on Cloudflare Workers. No new tables, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-fixed-history-design.md`

## Global Constraints

- No new table and no migration: key lists live in `site_snapshots` (kind `finding_keys`, scope = analysis id).
- `findingKey` = `${category}|${title with every run of digits replaced by "#"}`, lower-cased and trimmed.
- `pages` on a key row is `pagesAffected.slice(0, 50)`.
- History looks back over the latest **12** finished runs (`HISTORY_RUNS = 12`); a request does a fixed number of D1 queries (the Free plan allows 50).
- The History API response is `{ runs, open, numbers: { resolved, fixedWithEumon, noLongerApplies, actions }, rows }`, rows newest first, capped at **200**.
- Badge texts: "Fixed with Eumon", "Resolved", "No longer applies", "Pull request", "Page edit", "CTA test", "Published".
- Empty states: "Run an analysis first." and "History starts with your second analysis: fix something, run it again."
- Operator only: nothing is added to `ClientReport` or `/api/r/*`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Test commands: core `npm test -w @organic-growth/core`; db `npm test -w @organic-growth/db`; web tests import built packages, so run `npm run build -w @organic-growth/core && npm run build -w @organic-growth/db && npm run build -w @organic-growth/agents` before `cd apps/web && node --test src/history.test.ts`.

## Review Focus

1. Two findings in one run whose titles differ only by digits (two "Rewrite the search snippet of /prices/kl-2" style titles) share a key: the key is resolved only when both are gone. Pinned by Task 1's `findingKey` test (same key) and `runKeys` test (duplicate keys are kept as rows).
2. A run with zero findings resolves everything at once and reports `open: 0` without error. Pinned by Task 1's "resolves everything at once" test.
3. A `changes` row whose `finding_id` is unknown to every key list (older than 12 runs, or a deleted analysis) attributes nothing and does not crash. Pinned by Task 3's "ignores a change naming an unknown finding" test.
4. A cancelled or failed analysis between two completed ones is not a run: it neither resolves nor reopens anything. Pinned by Task 2's `listCompletedAnalyses` test.
5. A site with one finished analysis gets `runs: 1` and no rows, and the panel shows the second-analysis message rather than an empty table. Pinned by Task 3's "one run" test; the message is Task 4's copy.

---

### Task 1: Core history math

**Files:**
- Create: `packages/core/src/history.ts`
- Create: `packages/core/src/history.test.ts`
- Modify: `packages/core/src/index.ts` (add one export line)

**Interfaces:**
- Consumes: `Finding` from `./types.js` (`id`, `category`, `severity`, `title`, `pagesAffected?`).
- Produces (used by Tasks 2 and 3):
  ```ts
  export type KeyRow = { id: string; key: string; title: string; category: string; severity: string; pages: string[]; vanished?: true };
  export type HistoryRun = { analysisId: string; completedAt: string; keys: KeyRow[] };
  export type Resolution = { key: string; title: string; category: string; severity: string; pages: string[]; firstSeen: string; resolvedAt: string; resolvedBy: string; reopenedAt?: string; vanished: boolean };
  export function findingKey(finding: Pick<Finding, "category" | "title">): string;
  export function runKeys(report: { findings?: Finding[] }, previous?: KeyRow[], vanishedPages?: ReadonlySet<string>): KeyRow[];
  export function resolutions(runs: HistoryRun[]): { resolved: Resolution[]; open: number };
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/history.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findingKey, resolutions, runKeys, type KeyRow } from "./history.js";
import type { Finding } from "./types.js";

const finding = (id: string, title: string, overrides: Partial<Finding> = {}): Finding => ({
  id, siteId: "s", analysisId: "a", category: "metadata", severity: "HIGH", title, summary: "", evidence: {}, organicImpactScore: 50, createdAt: "2026-09-01T00:00:00.000Z", ...overrides,
});
const row = (id: string, title: string, pages: string[] = [], extra: Partial<KeyRow> = {}): KeyRow => ({ id, key: findingKey({ category: "metadata", title }), title, category: "metadata", severity: "HIGH", pages, ...extra });
const run = (analysisId: string, completedAt: string, keys: KeyRow[]) => ({ analysisId, completedAt, keys });

describe("findingKey", () => {
  it("names the same problem across runs: category and title with numbers blanked, case ignored", () => {
    assert.equal(findingKey(finding("f1", "Doctors wait for 3 data requests in sequence")), findingKey(finding("f2", "Doctors wait for 4 data requests in sequence")));
    assert.equal(findingKey(finding("f1", " Thin Meta Descriptions ")), "metadata|thin meta descriptions");
    assert.notEqual(findingKey(finding("f1", "Thin meta descriptions")), findingKey(finding("f1", "Thin meta descriptions", { category: "content" })), "another category is another problem");
    assert.equal(findingKey(finding("f1", "Rewrite the search snippet of /prices/kl-2")), findingKey(finding("f2", "Rewrite the search snippet of /prices/kl-7")), "two pages' snippet findings are one key");
  });
});

describe("runKeys", () => {
  it("lists the run's findings with up to 50 pages each, keeping duplicate keys as rows", () => {
    const rows = runKeys({ findings: [
      finding("f1", "Thin meta descriptions", { pagesAffected: Array.from({ length: 60 }, (_, index) => `https://x.com/p/${index}`) }),
      finding("f2", "Rewrite the search snippet of /prices/kl-2"),
      finding("f3", "Rewrite the search snippet of /prices/kl-7"),
    ] });
    assert.deepEqual(rows.map((entry) => entry.id), ["f1", "f2", "f3"]);
    assert.equal(rows[0]!.pages.length, 50);
    assert.equal(rows[0]!.vanished, undefined);
    assert.equal(rows[1]!.key, rows[2]!.key);
  });

  it("flags a previous finding as vanished only when it is gone, has pages, and every page vanished", () => {
    const previous: KeyRow[] = [
      row("p1", "Canonical mismatches detected", ["https://x.com/a", "https://x.com/b"]),
      row("p2", "Thin meta descriptions", ["https://x.com/c"]),
      row("p3", "Pages on page one that searchers skip"),
      row("p4", "Weak or missing titles on indexable pages", ["https://x.com/d"], { vanished: true }),
      row("p5", "Multilingual pages missing hreflang in HTML", ["https://x.com/e", "https://x.com/f"]),
    ];
    const gone = new Set(["https://x.com/a", "https://x.com/b", "https://x.com/c", "https://x.com/d", "https://x.com/e"]);
    const rows = runKeys({ findings: [finding("f2", "Thin meta descriptions")] }, previous, gone);
    assert.deepEqual(rows.map((entry) => [entry.id, entry.vanished ?? false]), [["f2", false], ["p1", true]],
      "still open (p2), no pages (p3), already vanished (p4) and one page still live (p5) are not flagged");
  });

  it("takes a report without findings", () => {
    assert.deepEqual(runKeys({}), []);
  });
});

describe("resolutions", () => {
  it("resolves a key the next run no longer reports, dated from the earliest consecutive run that had it", () => {
    const { resolved, open } = resolutions([
      run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "Thin meta descriptions"), row("f2", "Canonical mismatches detected", ["https://x.com/a"])]),
      run("a2", "2026-09-15T00:00:00.000Z", [row("f3", "Thin meta descriptions"), row("f4", "Canonical mismatches detected", ["https://x.com/a", "https://x.com/b"])]),
      run("a3", "2026-10-01T00:00:00.000Z", [row("f5", "Thin meta descriptions")]),
    ]);
    assert.equal(open, 1);
    assert.deepEqual(resolved, [{
      key: "metadata|canonical mismatches detected", title: "Canonical mismatches detected", category: "metadata", severity: "HIGH",
      pages: ["https://x.com/a", "https://x.com/b"], firstSeen: "2026-09-01T00:00:00.000Z", resolvedAt: "2026-10-01T00:00:00.000Z", resolvedBy: "a3", reopenedAt: undefined, vanished: false,
    }], "pages come from the last run that had the finding");
  });

  it("reads a vanished row as a resolution whose pages are gone, not as an open finding", () => {
    const { resolved, open } = resolutions([
      run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "Canonical mismatches detected", ["https://x.com/a"])]),
      run("a2", "2026-09-15T00:00:00.000Z", [row("f1", "Canonical mismatches detected", ["https://x.com/a"], { vanished: true })]),
      run("a3", "2026-10-01T00:00:00.000Z", []),
    ]);
    assert.equal(open, 0);
    assert.deepEqual(resolved.map(({ resolvedBy, vanished }) => ({ resolvedBy, vanished })), [{ resolvedBy: "a2", vanished: true }], "the vanished row resolves once, at a2, and a3 adds nothing");
  });

  it("marks a resolution reopened when a later run reports the key again, and resolves it again after", () => {
    const { resolved } = resolutions([
      run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "Thin meta descriptions")]),
      run("a2", "2026-09-08T00:00:00.000Z", []),
      run("a3", "2026-09-15T00:00:00.000Z", [row("f2", "Thin meta descriptions")]),
      run("a4", "2026-09-22T00:00:00.000Z", []),
    ]);
    assert.deepEqual(resolved.map(({ firstSeen, resolvedAt, reopenedAt }) => ({ firstSeen, resolvedAt, reopenedAt })), [
      { firstSeen: "2026-09-01T00:00:00.000Z", resolvedAt: "2026-09-08T00:00:00.000Z", reopenedAt: "2026-09-15T00:00:00.000Z" },
      { firstSeen: "2026-09-15T00:00:00.000Z", resolvedAt: "2026-09-22T00:00:00.000Z", reopenedAt: undefined },
    ]);
  });

  it("resolves everything at once when a run has no findings, and nothing with fewer than two runs", () => {
    assert.deepEqual(resolutions([]), { resolved: [], open: 0 });
    assert.deepEqual(resolutions([run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "Thin meta descriptions")])]), { resolved: [], open: 1 });
    const { resolved, open } = resolutions([run("a1", "2026-09-01T00:00:00.000Z", [row("f1", "A"), row("f2", "B")]), run("a2", "2026-09-02T00:00:00.000Z", [])]);
    assert.equal(resolved.length, 2);
    assert.equal(open, 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @organic-growth/core`
Expected: FAIL — `tsc` reports `Cannot find module './history.js'` (the test file does not compile), so the run stops before executing tests.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/history.ts`:

```ts
import type { Finding } from "./types.js";

/*
 * History: which problems the analysis once reported are gone, and when.
 * Each finished run keeps a key list (a few KB) in the snapshot store; the
 * Dashboard's History tab diffs consecutive lists.
 */

/**
 * One finding in a run's key list. A `vanished` row is not an open finding:
 * it says the previous run's finding is gone because every page it pointed
 * at was missing or erroring in this crawl.
 */
export type KeyRow = { id: string; key: string; title: string; category: string; severity: string; pages: string[]; vanished?: true };

export type HistoryRun = { analysisId: string; completedAt: string; keys: KeyRow[] };

export type Resolution = {
  key: string; title: string; category: string; severity: string; pages: string[];
  /** Completion time of the earliest consecutive run that reported it. */
  firstSeen: string;
  /** Completion time and id of the first run that no longer reported it. */
  resolvedAt: string; resolvedBy: string;
  /** Set when a later run reported it again. */
  reopenedAt?: string;
  /** Its pages were gone in the resolving crawl: it no longer applies rather than being fixed. */
  vanished: boolean;
};

/** The same problem across runs: category and title with numbers blanked, so "waits for 3 requests" and "waits for 4" are one key. */
export const findingKey = (finding: Pick<Finding, "category" | "title">) => `${finding.category}|${finding.title.replace(/\d+/g, "#").trim().toLowerCase()}`;

/**
 * A finished run's key list: its findings, plus `vanished` rows for the
 * previous run's findings that it no longer reports and whose pages (one or
 * more) are all in `vanishedPages`.
 */
export function runKeys(report: { findings?: Finding[] }, previous: KeyRow[] = [], vanishedPages: ReadonlySet<string> = new Set()): KeyRow[] {
  const rows: KeyRow[] = (report.findings ?? []).map((finding) => ({
    id: finding.id, key: findingKey(finding), title: finding.title, category: finding.category, severity: finding.severity, pages: (finding.pagesAffected ?? []).slice(0, 50),
  }));
  const open = new Set(rows.map((row) => row.key));
  for (const row of previous) {
    if (row.vanished || open.has(row.key) || !row.pages.length || !row.pages.every((url) => vanishedPages.has(url))) continue;
    rows.push({ ...row, vanished: true });
    open.add(row.key);
  }
  return rows;
}

/** Resolutions over runs oldest → newest, and how many findings the latest run still has. */
export function resolutions(runs: HistoryRun[]): { resolved: Resolution[]; open: number } {
  const resolved: Resolution[] = [];
  const openSince = new Map<string, { row: KeyRow; firstSeen: string }>();
  for (const run of runs) {
    const present = new Map<string, KeyRow>();
    const vanished = new Set<string>();
    for (const row of run.keys) {
      if (row.vanished) vanished.add(row.key);
      else if (!present.has(row.key)) present.set(row.key, row);
    }
    for (const [key, { row, firstSeen }] of openSince) {
      if (present.has(key)) continue;
      resolved.push({ key, title: row.title, category: row.category, severity: row.severity, pages: row.pages, firstSeen, resolvedAt: run.completedAt, resolvedBy: run.analysisId, reopenedAt: undefined, vanished: vanished.has(key) });
      openSince.delete(key);
    }
    for (const [key, row] of present) {
      const stretch = openSince.get(key);
      if (stretch) { stretch.row = row; continue; }
      const earlier = resolved.filter((entry) => entry.key === key && !entry.reopenedAt).at(-1);
      if (earlier) earlier.reopenedAt = run.completedAt;
      openSince.set(key, { row, firstSeen: run.completedAt });
    }
  }
  return { resolved, open: openSince.size };
}
```

Add to `packages/core/src/index.ts` after the `sync-notes` line:

```ts
export * from "./history.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @organic-growth/core`
Expected: PASS — every test in the package passes, including the three new `describe` blocks (findingKey 1, runKeys 3, resolutions 4).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/history.ts packages/core/src/history.test.ts packages/core/src/index.ts
git commit -m "History: finding keys and resolutions between runs" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Key lists in the snapshot store, written on save and backfilled on read

**Files:**
- Create: `packages/db/src/history.ts`
- Create: `packages/db/src/history.test.ts`
- Modify: `packages/db/src/snapshots.ts` (add `snapshotStatement`; `saveSnapshot` uses it)
- Modify: `packages/db/src/index.ts` (import, re-export, hook in `saveAnalysisReport`)
- Modify: `packages/db/src/page-engine.ts` (add `listPublications`)

**Interfaces:**
- Consumes: `runKeys`, `KeyRow`, `HistoryRun`, `Finding` from `@organic-growth/core` (Task 1); `saveSnapshot`, `getSnapshot`, `listSnapshots` from `./snapshots.js`; `runStatements`, `D1Like` from `./d1.js`.
- Produces (used by Task 3):
  ```ts
  export const FINDING_KEYS = "finding_keys";
  export const HISTORY_RUNS = 12;
  export type CompletedAnalysis = { id: string; completedAt: string };
  export function listCompletedAnalyses(db: D1Like, siteId: string, limit?: number): Promise<CompletedAnalysis[]>;   // oldest first
  export function vanishedPages(db: D1Like, previousId: string, analysisId: string, urls: string[]): Promise<Set<string>>;
  export function saveFindingKeys(db: D1Like, siteId: string, analysisId: string, day: string, report: { findings?: Finding[] }): Promise<void>;
  export function historyRuns(db: D1Like, siteId: string): Promise<HistoryRun[]>;                                      // oldest first, lists filled
  export function listPublications(db: D1Like, siteId: string): Promise<Array<{ templateId: string; template: string; day: string; pages: number }>>;  // page-engine.ts, newest day first
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/history.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult, Finding, KeyRow } from "@organic-growth/core";
import {
  createAnalysis, enqueueAnalysisCrawlUrls, FINDING_KEYS, getSnapshot, historyRuns, listCompletedAnalyses, listPublications, saveAnalysisReport, saveCrawlBatch,
  updateAnalysisStatus, upsertSite, type D1Like,
} from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const finding = (id: string, title: string, pagesAffected: string[] = []): Finding => ({
  id, siteId: "s", analysisId: "a", category: "metadata", severity: "HIGH", title, summary: "", evidence: {}, organicImpactScore: 50, pagesAffected, createdAt: "2026-09-01T00:00:00.000Z",
});
const page = (url: string, status: number): CrawlPageResult => ({
  url, status, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1000, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 500, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot",
});

async function site(): Promise<D1Like> {
  const db = openSqliteD1();
  const now = "2026-09-01T00:00:00.000Z";
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  return db;
}

/** A run that crawled `crawl` (status per URL) and finished with `findings` at `completedAt`. */
async function finished(db: D1Like, id: string, completedAt: string, findings: Finding[], crawl: Record<string, number> = {}) {
  await createAnalysis(db, { id, siteId: "s", status: "running", createdAt: completedAt });
  const urls = Object.keys(crawl);
  if (urls.length) {
    await enqueueAnalysisCrawlUrls(db, { analysisId: id, siteId: "s", urls: urls.map((url) => ({ url, routeFamily: "page" })) });
    await saveCrawlBatch(db, { analysisId: id, outcomes: urls.map((url) => ({ url, page: page(url, crawl[url]!) })) });
  }
  await saveAnalysisReport(db, id, { findings }, "done");
  // The save stamps the real clock; the test wants its own dates.
  await db.prepare("UPDATE analyses SET completed_at = ? WHERE id = ?").bind(completedAt, id).run();
}

describe("history key lists", () => {
  it("saves a finished run's key list, flagging the previous run's findings whose pages all vanished in this crawl", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [
      finding("f1", "Canonical mismatches detected", ["https://x.com/a", "https://x.com/b"]),
      finding("f2", "Thin meta descriptions", ["https://x.com/c"]),
      finding("f3", "Weak or missing titles on indexable pages", ["https://x.com/never-crawled"]),
      finding("f4", "Multilingual pages missing hreflang in HTML"),
    ], { "https://x.com/a": 200, "https://x.com/b": 200, "https://x.com/c": 200 });
    await finished(db, "a2", "2026-09-15T00:00:00.000Z", [finding("f5", "Multilingual pages missing hreflang in HTML")], { "https://x.com/a": 404, "https://x.com/c": 200 });
    const first = await getSnapshot<KeyRow>(db, "s", FINDING_KEYS, "a1");
    assert.deepEqual(first?.rows.map((row) => row.id), ["f1", "f2", "f3", "f4"]);
    assert.equal(first?.rows[0]!.key, "metadata|canonical mismatches detected");
    const second = await getSnapshot<KeyRow>(db, "s", FINDING_KEYS, "a2");
    assert.deepEqual(second?.rows.map((row) => [row.id, row.vanished ?? false]), [["f5", false], ["f1", true]],
      "a and b vanished (404, missing); c is still live; never-crawled pages are unknown, not vanished; f4 has no pages");
  });

  it("fills key lists for runs saved before this feature from their reports, and leaves existing lists alone", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Thin meta descriptions")]);
    await finished(db, "a2", "2026-09-15T00:00:00.000Z", [finding("f2", "Thin meta descriptions"), finding("f3", "Canonical mismatches detected")]);
    await finished(db, "a3", "2026-10-01T00:00:00.000Z", [finding("f4", "Canonical mismatches detected")]);
    // As if a1 and a3 finished before key lists existed.
    await db.prepare("DELETE FROM site_snapshots WHERE kind = ? AND scope IN ('a1', 'a3')").bind(FINDING_KEYS).run();
    await db.prepare("UPDATE site_snapshots SET rows_json = ? WHERE kind = ? AND scope = 'a2'").bind(JSON.stringify([{ id: "kept", key: "metadata|kept", title: "Kept", category: "metadata", severity: "LOW", pages: [] }]), FINDING_KEYS).run();
    const runs = await historyRuns(db, "s");
    assert.deepEqual(runs.map((run) => [run.analysisId, run.completedAt, run.keys.map((row) => row.id)]), [
      ["a1", "2026-09-01T00:00:00.000Z", ["f1"]],
      ["a2", "2026-09-15T00:00:00.000Z", ["kept"]],
      ["a3", "2026-10-01T00:00:00.000Z", ["f4"]],
    ]);
    assert.ok(await getSnapshot(db, "s", FINDING_KEYS, "a1"), "the filled list is saved");
    assert.deepEqual((await historyRuns(db, "s")).map((run) => run.keys.length), [1, 1, 1], "a second call changes nothing");
  });

  it("counts only finished runs with a report, oldest first, within the window", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", []);
    await createAnalysis(db, { id: "stopped", siteId: "s", status: "running", createdAt: "2026-09-02T00:00:00.000Z" });
    await updateAnalysisStatus(db, "stopped", "cancelled");
    await createAnalysis(db, { id: "broken", siteId: "s", status: "running", createdAt: "2026-09-03T00:00:00.000Z" });
    await updateAnalysisStatus(db, "broken", "failed", { error: "boom" });
    await finished(db, "a2", "2026-09-04T00:00:00.000Z", []);
    await finished(db, "a3", "2026-09-05T00:00:00.000Z", []);
    assert.deepEqual((await listCompletedAnalyses(db, "s")).map((run) => run.id), ["a1", "a2", "a3"]);
    assert.deepEqual((await listCompletedAnalyses(db, "s", 2)).map((run) => run.id), ["a2", "a3"], "the window keeps the latest");
  });

  it("groups published pages by day and template, newest day first", async () => {
    const db = await site();
    const at = "2026-09-01T00:00:00.000Z";
    await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'Doctors', 'doctor', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'Doctors', '{}', 'active', ?, ?)`).bind(at, at).run();
    const insert = (id: string, publishedAt: string | null) => db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES (?, 's', 't', ?, ?, 'x', '', '{}', 1, '[]', ?, ?, ?, ?)`).bind(id, `/doctors/${id}`, id, publishedAt ? "published" : "draft", publishedAt, at, at).run();
    await insert("p1", "2026-09-03T09:00:00.000Z");
    await insert("p2", "2026-09-03T11:00:00.000Z");
    await insert("p3", "2026-09-05T09:00:00.000Z");
    await insert("p4", null);
    assert.deepEqual(await listPublications(db, "s"), [
      { templateId: "t", template: "Doctors", day: "2026-09-05", pages: 1 },
      { templateId: "t", template: "Doctors", day: "2026-09-03", pages: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build -w @organic-growth/core && npm test -w @organic-growth/db`
Expected: FAIL — `tsc` reports that `./index.js` has no exported member `FINDING_KEYS` (and `historyRuns`, `listCompletedAnalyses`, `listPublications`).

- [ ] **Step 3: Add `snapshotStatement` to the snapshot store**

In `packages/db/src/snapshots.ts`, replace `saveSnapshot` with:

```ts
/** The statement that replaces the list of this kind and scope, for batching. */
export function snapshotStatement<T>(db: D1Like, siteId: string, input: { kind: string; scope: string; periodEnd: string; rows: T[] }) {
  return db.prepare(
    `INSERT INTO site_snapshots (site_id, kind, scope, period_end, rows_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, kind, scope) DO UPDATE SET period_end = excluded.period_end, rows_json = excluded.rows_json, updated_at = excluded.updated_at`,
  ).bind(siteId, input.kind, input.scope, input.periodEnd, JSON.stringify(input.rows), nowIso());
}

/** Replaces the list of this kind and scope. */
export async function saveSnapshot<T>(db: D1Like, siteId: string, input: { kind: string; scope: string; periodEnd: string; rows: T[] }): Promise<void> {
  await snapshotStatement(db, siteId, input).run();
}
```

- [ ] **Step 4: Write the db history module**

Create `packages/db/src/history.ts`:

```ts
import { runKeys, type Finding, type HistoryRun, type KeyRow } from "@organic-growth/core";
import { runStatements, type D1Like } from "./d1.js";
import { getSnapshot, listSnapshots, snapshotStatement } from "./snapshots.js";

/*
 * History: each finished run's finding key list in the snapshot store (kind
 * `finding_keys`, scope = the analysis id), so the Dashboard's History tab
 * can diff runs without parsing reports. Crawl rows are pruned to the two
 * latest runs, so whether a finding's pages vanished is decided on save.
 */

export const FINDING_KEYS = "finding_keys";
/** How many finished runs History looks back over: keeps the first open within the Free plan's query budget. */
export const HISTORY_RUNS = 12;

export type CompletedAnalysis = { id: string; completedAt: string };

/** The latest finished runs with a report, oldest first. */
export async function listCompletedAnalyses(db: D1Like, siteId: string, limit = HISTORY_RUNS): Promise<CompletedAnalysis[]> {
  const { results } = await db.prepare(
    `SELECT id, COALESCE(completed_at, created_at) AS completed_at FROM analyses
     WHERE site_id = ? AND status = 'completed' AND report_json IS NOT NULL ORDER BY created_at DESC LIMIT ?`,
  ).bind(siteId, limit).all<{ id: string; completed_at: string }>();
  return results.reverse().map((row) => ({ id: String(row.id), completedAt: String(row.completed_at) }));
}

/** Of `urls`, those live in the previous crawl (fetched, status under 400) and missing or erroring (status 400 or more) in this one. Pages the previous crawl never fetched are unknown, never vanished. */
export async function vanishedPages(db: D1Like, previousId: string, analysisId: string, urls: string[]): Promise<Set<string>> {
  if (!urls.length) return new Set();
  const list = JSON.stringify([...new Set(urls)].slice(0, 500));
  const matching = async (id: string, condition: string) => new Set((await db.prepare(
    `SELECT url FROM pages WHERE analysis_id = ? AND url IN (SELECT value FROM json_each(?)) AND ${condition}`,
  ).bind(id, list).all<{ url: string }>()).results.map((row) => String(row.url)));
  const [live, stillThere] = await Promise.all([matching(previousId, "status IS NOT NULL AND status < 400"), matching(analysisId, "(status IS NULL OR status < 400)")]);
  return new Set([...live].filter((url) => !stillThere.has(url)));
}

/** Saves a finished run's key list; runs before its crawl rows are pruned. */
export async function saveFindingKeys(db: D1Like, siteId: string, analysisId: string, day: string, report: { findings?: Finding[] }): Promise<void> {
  const previous = await db.prepare(
    `SELECT id FROM analyses WHERE site_id = ? AND id != ? AND status = 'completed' AND report_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
  ).bind(siteId, analysisId).first<{ id: string }>();
  const before = previous ? (await getSnapshot<KeyRow>(db, siteId, FINDING_KEYS, previous.id))?.rows ?? [] : [];
  const gone = previous ? await vanishedPages(db, previous.id, analysisId, before.flatMap((row) => row.pages)) : new Set<string>();
  await snapshotStatement(db, siteId, { kind: FINDING_KEYS, scope: analysisId, periodEnd: day, rows: runKeys(report, before, gone) }).run();
}

/**
 * The latest finished runs with their key lists, oldest first. Runs saved
 * before key lists existed get theirs from their report here (one read, one
 * batch of writes); their crawls are long pruned, so no vanished rows.
 */
export async function historyRuns(db: D1Like, siteId: string): Promise<HistoryRun[]> {
  const runs = await listCompletedAnalyses(db, siteId);
  const saved = new Map((await listSnapshots<KeyRow>(db, siteId, FINDING_KEYS)).map((entry) => [entry.scope, entry.rows]));
  const missing = runs.filter((run) => !saved.has(run.id)).map((run) => run.id);
  const reports = new Map<string, { findings?: Finding[] }>();
  if (missing.length) {
    const { results } = await db.prepare("SELECT id, report_json FROM analyses WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(missing)).all<{ id: string; report_json: string }>();
    for (const row of results) reports.set(String(row.id), JSON.parse(String(row.report_json)));
  }
  const statements: ReturnType<typeof snapshotStatement>[] = [];
  let previous: KeyRow[] = [];
  const out: HistoryRun[] = [];
  for (const run of runs) {
    const keys = saved.get(run.id) ?? runKeys(reports.get(run.id) ?? {}, previous);
    if (!saved.has(run.id)) statements.push(snapshotStatement(db, siteId, { kind: FINDING_KEYS, scope: run.id, periodEnd: run.completedAt.slice(0, 10), rows: keys }));
    out.push({ analysisId: run.id, completedAt: run.completedAt, keys });
    previous = keys;
  }
  await runStatements(db, statements);
  return out;
}
```

- [ ] **Step 5: Hook the save into `saveAnalysisReport` and re-export**

In `packages/db/src/index.ts`:

Add `Finding,` to the type import list from `@organic-growth/core` (alphabetical, after `CrawlPageResult`).

After `export * from "./snapshots.js";` add:

```ts
export * from "./history.js";
import { saveFindingKeys } from "./history.js";
```

In `saveAnalysisReport`, between the health-point `try` and the prune `try`, add:

```ts
  try {
    if (site) await saveFindingKeys(db, site.site_id, id, completedAt.slice(0, 10), report as { findings?: Finding[] });
  } catch {
    // History's key list; without a snapshots table (code deployed before its migration) History fills it from the report later.
  }
```

- [ ] **Step 6: Add `listPublications` to the page engine**

In `packages/db/src/page-engine.ts`, after `listTemplates`:

```ts
/** Pages published per day and template, newest day first: the engine's publication log. */
export async function listPublications(db: D1Like, siteId: string): Promise<Array<{ templateId: string; template: string; day: string; pages: number }>> {
  const { results } = await db.prepare(
    `SELECT p.template_id, t.name, substr(p.published_at, 1, 10) AS day, COUNT(*) AS n
     FROM generated_pages p JOIN page_templates t ON t.id = p.template_id
     WHERE p.site_id = ? AND p.published_at IS NOT NULL GROUP BY p.template_id, day ORDER BY day DESC, t.name`,
  ).bind(siteId).all<Row>();
  return results.map((row) => ({ templateId: String(row.template_id), template: String(row.name), day: String(row.day), pages: Number(row.n) }));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w @organic-growth/db`
Expected: PASS — the four `history key lists` tests pass and every existing db test still passes (the `crawl retention` and `snapshots` suites among them).

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/history.ts packages/db/src/history.test.ts packages/db/src/snapshots.ts packages/db/src/index.ts packages/db/src/page-engine.ts
git commit -m "History: key lists saved per run, backfilled from reports, publications grouped" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The History assembler and its route

**Files:**
- Create: `apps/web/src/history.ts`
- Create: `apps/web/src/history.test.ts`
- Create: `apps/web/app/api/sites/[siteId]/history/route.ts`

**Interfaces:**
- Consumes: `resolutions` (Task 1); `historyRuns`, `listPublications` (Task 2); `listChanges`, `listPageRevisions`, `listCtaVariants`, `D1Like` from `@organic-growth/db`.
- Produces (used by Task 4):
  ```ts
  export type HistoryKind = "fixed" | "resolved" | "vanished" | "change" | "edit" | "cta" | "publish";
  export type HistoryRow = { kind: HistoryKind; at: string; title: string; detail: string; category?: string; since?: string; reopenedAt?: string; href?: string; view?: "performance" | "pages" };
  export type History = { runs: number; open: number; numbers: { resolved: number; fixedWithEumon: number; noLongerApplies: number; actions: number }; rows: HistoryRow[] };
  export function assembleHistory(db: D1Like, siteId: string): Promise<History>;
  ```
  Route: `GET /api/sites/:siteId/history` → `History` as JSON, 404 `{ error: "Site not found." }` for an unknown site.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/history.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChangeStatus, CrawlPageResult, Finding } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, insertChange, insertCtaVariant, saveAnalysisReport, saveCrawlBatch, upsertSite, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { assembleHistory } from "./history.ts";

const finding = (id: string, title: string, pagesAffected: string[] = []): Finding => ({
  id, siteId: "s", analysisId: "a", category: "metadata", severity: "HIGH", title, summary: "", evidence: {}, organicImpactScore: 50, pagesAffected, createdAt: "2026-09-01T00:00:00.000Z",
});
const page = (url: string, status: number): CrawlPageResult => ({
  url, status, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1000, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 500, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot",
});

async function site(): Promise<D1Like> {
  const db = openSqliteD1();
  const now = "2026-09-01T00:00:00.000Z";
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  return db;
}

async function finished(db: D1Like, id: string, completedAt: string, findings: Finding[], crawl: Record<string, number> = {}) {
  await createAnalysis(db, { id, siteId: "s", status: "running", createdAt: completedAt });
  const urls = Object.keys(crawl);
  if (urls.length) {
    await enqueueAnalysisCrawlUrls(db, { analysisId: id, siteId: "s", urls: urls.map((url) => ({ url, routeFamily: "page" })) });
    await saveCrawlBatch(db, { analysisId: id, outcomes: urls.map((url) => ({ url, page: page(url, crawl[url]!) })) });
  }
  await saveAnalysisReport(db, id, { findings }, "done");
  await db.prepare("UPDATE analyses SET completed_at = ? WHERE id = ?").bind(completedAt, id).run();
}

/** A change for a finding; its PR number is the id's length, so "c1" opens pull request #2. */
const change = (db: D1Like, id: string, findingId: string | undefined, createdAt: string, status: ChangeStatus = "merged") => insertChange(db, {
  id, siteId: "s", analysisId: "a1", findingId, title: `Fix for ${findingId ?? "nothing"}`, reason: "Because.", evidence: {}, filesChanged: ["app/page.tsx"], pagesAffected: [], patch: "",
  status, prUrl: `https://github.com/x/y/pull/${id.length}`, prNumber: id.length, author: "eumon", createdAt,
});

describe("history", () => {
  it("attributes a resolved finding to the merged change made for it, and the rest to the analysis", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Thin meta descriptions"), finding("f2", "Canonical mismatches detected", ["https://x.com/a"])], { "https://x.com/a": 200 });
    await change(db, "c1", "f1", "2026-09-05T00:00:00.000Z");
    await change(db, "c2", "f2", "2026-09-20T00:00:00.000Z", "proposed");
    await finished(db, "a2", "2026-09-10T00:00:00.000Z", [], { "https://x.com/a": 200 });
    const history = await assembleHistory(db, "s");
    assert.equal(history.runs, 2);
    assert.equal(history.open, 0);
    assert.deepEqual(history.numbers, { resolved: 2, fixedWithEumon: 1, noLongerApplies: 0, actions: 1 });
    const fixed = history.rows.find((row) => row.kind === "fixed")!;
    assert.equal(fixed.title, "Thin meta descriptions");
    assert.equal(fixed.detail, "Pull request #2: Fix for f1");
    assert.equal(fixed.href, "https://github.com/x/y/pull/2");
    assert.equal(fixed.since, "2026-09-01T00:00:00.000Z");
    assert.equal(fixed.at, "2026-09-10T00:00:00.000Z");
    assert.equal(fixed.category, "metadata");
    const resolved = history.rows.find((row) => row.kind === "resolved")!;
    assert.equal(resolved.title, "Canonical mismatches detected", "a proposed change fixes nothing");
    assert.deepEqual(history.rows.map((row) => row.kind), ["fixed", "resolved", "change"], "newest first; the two resolutions share a date and come before the earlier PR");
  });

  it("says a finding no longer applies when its pages vanished, and ignores a change naming an unknown finding", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Canonical mismatches detected", ["https://x.com/a", "https://x.com/b"])], { "https://x.com/a": 200, "https://x.com/b": 200 });
    await change(db, "c1", "finding_from_long_ago", "2026-09-05T00:00:00.000Z");
    await finished(db, "a2", "2026-09-10T00:00:00.000Z", [], { "https://x.com/a": 410 });
    const history = await assembleHistory(db, "s");
    assert.deepEqual(history.numbers, { resolved: 1, fixedWithEumon: 0, noLongerApplies: 1, actions: 1 });
    assert.equal(history.rows[0]!.kind, "vanished");
    assert.equal(history.rows[0]!.detail, "Every page it pointed at is gone or erroring, so it no longer applies.");
  });

  it("lists Eumon's actions newest first: pull requests, page edits with their effect, CTA tests and publications", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", []);
    await change(db, "c1", undefined, "2026-09-02T00:00:00.000Z", "pr_opened");
    await insertCtaVariant(db, { id: "v1", siteId: "s", label: "Book now", copy: "Book a visit", url: "https://x.com/book", impressions: 0, clicks: 0, active: true, createdAt: "2026-09-03T00:00:00.000Z" });
    const at = "2026-09-01T00:00:00.000Z";
    await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'Doctors', 'doctor', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'Doctors', '{}', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES ('p1', 's', 't', '/doctors/lee', 'lee', 'Dr Lee', '', '{}', 1, '[]', 'published', '2026-09-04T00:00:00.000Z', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO page_revisions (id, page_id, field, before_value, after_value, reason, author, created_at) VALUES ('r1', 'p1', 'title', 'Dr Lee', 'Dr Lee, dentist in KL', 'Snippet rewrite', 'owner', '2026-09-05T00:00:00.000Z')`).run();
    const history = await assembleHistory(db, "s");
    assert.equal(history.numbers.actions, 4);
    assert.deepEqual(history.rows.map((row) => [row.kind, row.at.slice(0, 10), row.title]), [
      ["edit", "2026-09-05", "Edited title of /doctors/lee"],
      ["publish", "2026-09-04", "Published 1 page from Doctors"],
      ["cta", "2026-09-03", "Started CTA test: Book now"],
      ["change", "2026-09-02", "Pull request #2: Fix for nothing"],
    ]);
    assert.match(history.rows[0]!.detail, /^Snippet rewrite\. \d+ days after: 0 views and 0 CTA clicks \(0 and 0 before\)\.$/);
    assert.equal(history.rows[0]!.view, "performance");
    assert.equal(history.rows[1]!.view, "pages");
    assert.equal(history.rows[3]!.href, "https://github.com/x/y/pull/2");
  });

  it("has nothing to say with one run, and nothing at all with none", async () => {
    const db = await site();
    assert.deepEqual(await assembleHistory(db, "s"), { runs: 0, open: 0, numbers: { resolved: 0, fixedWithEumon: 0, noLongerApplies: 0, actions: 0 }, rows: [] });
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Thin meta descriptions")]);
    const history = await assembleHistory(db, "s");
    assert.equal(history.runs, 1);
    assert.equal(history.open, 1);
    assert.deepEqual(history.rows, []);
  });
});
```

(The demo assertion is added to this file in Task 5.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build -w @organic-growth/core && npm run build -w @organic-growth/db && cd apps/web && node --test src/history.test.ts`
Expected: FAIL — `Cannot find module '.../apps/web/src/history.ts'`.

- [ ] **Step 3: Write the assembler**

Create `apps/web/src/history.ts`:

```ts
import { resolutions } from "@organic-growth/core";
import { historyRuns, listChanges, listCtaVariants, listPageRevisions, listPublications, type D1Like } from "@organic-growth/db";

/*
 * The Dashboard's History tab: problems the analysis once reported that are
 * gone, with what fixed them, and every action taken through Eumon.
 */

export type HistoryKind = "fixed" | "resolved" | "vanished" | "change" | "edit" | "cta" | "publish";
export type HistoryRow = {
  kind: HistoryKind; at: string; title: string; detail: string;
  /** Resolutions: the finding's category (which tab explains it), when it was first reported, and whether it came back. */
  category?: string; since?: string; reopenedAt?: string;
  /** A pull request to open, or the engine page an action belongs to. */
  href?: string; view?: "performance" | "pages";
};
export type History = { runs: number; open: number; numbers: { resolved: number; fixedWithEumon: number; noLongerApplies: number; actions: number }; rows: HistoryRow[] };

const ROWS = 200;
const DONE = new Set(["merged", "pr_opened"]);

/** Resolutions with their attribution and Eumon's actions, newest first. */
export async function assembleHistory(db: D1Like, siteId: string): Promise<History> {
  const runs = await historyRuns(db, siteId);
  const [changes, revisions, variants, publications] = await Promise.all([listChanges(db, siteId), listPageRevisions(db, siteId), listCtaVariants(db, siteId), listPublications(db, siteId)]);
  const { resolved, open } = resolutions(runs);

  // A change names a finding id; the key lists say which problem that id was.
  const keyOf = new Map(runs.flatMap((run) => run.keys.map((row) => [row.id, row.key] as const)));
  const done = changes.filter((change) => DONE.has(change.status));
  const fixedBy = new Map<string, (typeof done)[number]>();
  for (const change of done) {
    const key = change.findingId && keyOf.get(change.findingId);
    if (key && !fixedBy.has(key)) fixedBy.set(key, change);
  }
  const prTitle = (change: (typeof done)[number]) => `${change.prNumber ? `Pull request #${change.prNumber}` : "Change"}: ${change.title}`;

  const resolutionRows: HistoryRow[] = resolved.map((entry) => {
    const change = fixedBy.get(entry.key);
    const fixed = change && change.createdAt >= entry.firstSeen && change.createdAt <= entry.resolvedAt ? change : undefined;
    return {
      kind: fixed ? "fixed" : entry.vanished ? "vanished" : "resolved",
      at: entry.resolvedAt, title: entry.title,
      detail: fixed ? prTitle(fixed) : entry.vanished ? "Every page it pointed at is gone or erroring, so it no longer applies." : "The analysis stopped reporting it.",
      category: entry.category, since: entry.firstSeen, reopenedAt: entry.reopenedAt, href: fixed?.prUrl,
    };
  });
  const actions: HistoryRow[] = [
    ...done.map((change): HistoryRow => ({ kind: "change", at: change.createdAt, title: prTitle(change), detail: change.reason, href: change.prUrl })),
    ...revisions.map((revision): HistoryRow => ({
      kind: "edit", at: revision.createdAt, title: `Edited ${revision.field} of ${revision.path}`, view: "performance",
      detail: revision.windowDays
        ? `${revision.reason}. ${revision.windowDays} days after: ${revision.metricsAfter.views} views and ${revision.metricsAfter.ctaClicks} CTA clicks (${revision.metricsBefore.views} and ${revision.metricsBefore.ctaClicks} before).`
        : `${revision.reason}. Too soon to compare.`,
    })),
    ...variants.map((variant): HistoryRow => ({ kind: "cta", at: variant.createdAt, title: `Started CTA test: ${variant.label}`, detail: `“${variant.copy}” → ${variant.url}`, view: "performance" })),
    ...publications.map((entry): HistoryRow => ({ kind: "publish", at: `${entry.day}T00:00:00.000Z`, title: `Published ${entry.pages} ${entry.pages === 1 ? "page" : "pages"} from ${entry.template}`, detail: "", view: "pages" })),
  ];
  const kinds = (kind: HistoryKind) => resolutionRows.filter((row) => row.kind === kind).length;
  return {
    runs: runs.length, open,
    numbers: { resolved: resolutionRows.length, fixedWithEumon: kinds("fixed"), noLongerApplies: kinds("vanished"), actions: actions.length },
    rows: [...resolutionRows, ...actions].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ROWS),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && node --test src/history.test.ts`
Expected: PASS — 4 tests pass. If the first test's row order assertion fails on the two same-dated resolutions, the sort is stable in V8 and `resolved` lists them in key-list order (f1 then f2), so "fixed" precedes "resolved": check the fixture, not the sort.

- [ ] **Step 5: Add the route**

Create `apps/web/app/api/sites/[siteId]/history/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { assembleHistory } from "../../../../../src/history";

/** The problems the analysis once reported that are gone, with what fixed them, and every action taken through Eumon. */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return Response.json({ error: "Site not found." }, { status: 404 });
  return Response.json(await assembleHistory(env.DB, siteId), { headers: { "Cache-Control": "no-store" } });
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (builds every package, then `tsc --noEmit` in each workspace, the web app included).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/history.ts apps/web/src/history.test.ts "apps/web/app/api/sites/[siteId]/history/route.ts"
git commit -m "History: resolutions with attribution and Eumon's actions, served per site" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The History tab

**Files:**
- Create: `apps/web/app/components/HistoryPanel.tsx`
- Modify: `apps/web/app/components/OverviewView.tsx` (`Tab` type, `OVERVIEW_TABS`, the results gate, the panel switch, one import)

**Interfaces:**
- Consumes: `History`, `HistoryRow` types from `../../src/history` (Task 3, type-only import); `api`, `errorMessage`, `formatDay` from `./api`; `Badge`, `Card`, `Kpi` from `./ui`; `ExportMenu` from `./export/ExportMenu` (`sheets: () => Sheet[]`, `Sheet = { name; columns; rows: Cell[][] }`, `Cell = string | number | null`); `AREA_PLACE`, `findingArea`, `Navigate` from `./report-model`.
- Produces: `export function HistoryPanel({ siteId, onNavigate }: { siteId: string; onNavigate: Navigate })`.

No unit test covers React components in this repo; the panel is verified in the browser in Step 4 and by `npm run typecheck`.

- [ ] **Step 1: Write the panel**

Create `apps/web/app/components/HistoryPanel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import type { History, HistoryRow } from "../../src/history";
import { api, errorMessage, formatDay } from "./api";
import { ExportMenu } from "./export/ExportMenu";
import { AREA_PLACE, findingArea, type Navigate } from "./report-model";
import { Badge, Card, Kpi } from "./ui";

/*
 * The Dashboard's History tab: what was wrong and is gone, who fixed it, and
 * every change made through Eumon, newest first.
 */

const LABEL: Record<HistoryRow["kind"], { text: string; tone: string }> = {
  fixed: { text: "Fixed with Eumon", tone: "green" },
  resolved: { text: "Resolved", tone: "green" },
  vanished: { text: "No longer applies", tone: "gray" },
  change: { text: "Pull request", tone: "amber" },
  edit: { text: "Page edit", tone: "amber" },
  cta: { text: "CTA test", tone: "amber" },
  publish: { text: "Published", tone: "amber" },
};
const day = (iso: string) => formatDay(iso.slice(0, 10));

export function HistoryPanel({ siteId, onNavigate }: { siteId: string; onNavigate: Navigate }) {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setHistory(null);
    setError("");
    api<History>(`/api/sites/${siteId}/history`).then(setHistory).catch((cause) => setError(errorMessage(cause)));
  }, [siteId]);
  const sheets = () => [{
    name: "History", columns: ["Date", "Kind", "Title", "Detail", "Since"],
    rows: (history?.rows ?? []).map((row) => [row.at.slice(0, 10), LABEL[row.kind].text, row.title, row.detail, row.since?.slice(0, 10) ?? null]),
  }];
  return (
    <div className="results">
      <Card title="History" subtitle="Every problem the analysis once reported that is now gone, who or what fixed it, and every change made through Eumon." actions={history?.rows.length ? <ExportMenu title="History" sheets={sheets} /> : undefined}>
        {error ? <p className="empty-state">{error}</p>
          : !history ? <p className="empty-state">Loading…</p>
          : history.runs === 0 ? <p className="empty-state">Run an analysis first.</p>
          : history.runs < 2 && !history.rows.length ? <p className="empty-state">History starts with your second analysis: fix something, run it again.</p>
          : (
            <>
              <div className="kpi-grid">
                <Kpi label="Resolved" value={history.numbers.resolved} caption={`${history.open} still open`} />
                <Kpi label="Fixed with Eumon" value={history.numbers.fixedWithEumon} />
                <Kpi label="No longer apply" value={history.numbers.noLongerApplies} />
                <Kpi label="Actions" value={history.numbers.actions} />
              </div>
              {history.rows.map((row, index) => <Row key={index} row={row} onNavigate={onNavigate} />)}
            </>
          )}
      </Card>
    </div>
  );
}

function Row({ row, onNavigate }: { row: HistoryRow; onNavigate: Navigate }) {
  const label = LABEL[row.kind];
  const open = row.category
    ? () => { const place = AREA_PLACE[findingArea(row.category!)]; onNavigate(place.view, place.tab ?? undefined); }
    : row.view ? () => onNavigate(row.view!) : undefined;
  const title = row.href ? <a href={row.href} target="_blank" rel="noreferrer">{row.title}</a>
    : open ? <a href="#" onClick={(event) => { event.preventDefault(); open(); }}>{row.title}</a>
    : row.title;
  return (
    <div className="list-row">
      <Badge tone={label.tone}>{label.text}</Badge>
      <div className="grow">
        <h4>{title}</h4>
        <p>{row.detail}{row.since && <> · since {day(row.since)}</>}{row.reopenedAt && <> · reopened {day(row.reopenedAt)}</>}</p>
      </div>
      <span className="small muted">{day(row.at)}</span>
    </div>
  );
}
```

- [ ] **Step 2: Wire the tab into the Overview**

In `apps/web/app/components/OverviewView.tsx`:

Add the import after the `SitePanels` import line:

```ts
import { HistoryPanel } from "./HistoryPanel";
```

Change the `Tab` type and `OVERVIEW_TABS`:

```ts
type Tab = "overview" | "technical" | "search" | "enquiries" | "keywords" | "competitors" | "ai" | "history";
/** The first tab has no `?tab=`; the others' keys are what links carry. */
export const OVERVIEW_TABS: Array<{ tab: Tab; label: string }> = [
  { tab: "overview", label: "Overview" },
  { tab: "technical", label: "Technical" },
  { tab: "search", label: "Search" },
  { tab: "enquiries", label: "Enquiries" },
  { tab: "keywords", label: "Keywords" },
  { tab: "competitors", label: "Competitors" },
  { tab: "ai", label: "AI visibility" },
  { tab: "history", label: "History" },
];
```

In the tab panel, the gate that waits for the Results payload currently reads:

```tsx
{!loaded || (current !== "overview" && current !== "technical" && !results.data) ? (
```

History loads its own data, so change it to:

```tsx
{!loaded || (current !== "overview" && current !== "technical" && current !== "history" && !results.data) ? (
```

After the `AiPanel` line (`{results.data && current === "ai" && <AiPanel … />}`) add:

```tsx
{current === "history" && <HistoryPanel siteId={site.id} onNavigate={onNavigate} />}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Look at it**

Run the dev server (`npm run dev`, or the user's server on port 5174 if it is already running), open a site, click **History** in the Dashboard tabs. With the demo site seeded (`curl -X POST http://localhost:5174/api/dev/demo-site`), the tab shows four numbers and a dated list with "Resolved" and "Published" badges; a site with one analysis shows the second-analysis message; the Export menu offers CSV, Excel, Google Sheets and Copy. Open the client link (`/r/:token`): no History tab.
Expected: as described; fix anything that is not before committing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/HistoryPanel.tsx apps/web/app/components/OverviewView.tsx
git commit -m "Dashboard: a History tab" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The demo shows a fix

**Files:**
- Modify: `packages/agents/src/demo.ts` (`seedDemoSite`, one import)
- Modify: `apps/web/src/history.test.ts` (one more test)

**Interfaces:**
- Consumes: `findingKey` (Task 1); `insertChange`, `getAnalysisJob` from `@organic-growth/db`; `assembleHistory` (Task 3); `seedDemoSite`, `DEMO_SITE_ID` from `@organic-growth/agents`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to the `describe("history", …)` block in `apps/web/src/history.test.ts`, and add `import { DEMO_SITE_ID, seedDemoSite } from "@organic-growth/agents";` to its imports:

```ts
  it("shows the demo site a fix, resolved findings and its publications", async () => {
    const db = openSqliteD1();
    await seedDemoSite(db, Date.now());
    const history = await assembleHistory(db, DEMO_SITE_ID);
    assert.equal(history.runs, 2);
    assert.ok(history.numbers.fixedWithEumon >= 1, `fixed ${history.numbers.fixedWithEumon}`);
    assert.ok(history.numbers.resolved > history.numbers.fixedWithEumon, `resolved ${history.numbers.resolved}`);
    assert.ok(history.rows.some((row) => row.kind === "publish"), "published pages are actions");
    const fixed = history.rows.find((row) => row.kind === "fixed")!;
    assert.match(fixed.detail, /^Pull request #12: /);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build -w @organic-growth/agents && cd apps/web && node --test --test-name-pattern "demo site" src/history.test.ts`
Expected: FAIL at `fixed 0` (the demo has resolved findings but no change; if it reports `resolved 0`, the two demo runs report the same findings — stop and say so, the design assumed they differ).

- [ ] **Step 3: Give the demo runs their simulated completion times**

`saveAnalysisReport` stamps `completed_at` with the real clock and closes the run, so the `updateAnalysisStatus(db, id, "completed", { completedAt })` that follows it in `completedAnalysis` is refused by the finished-run guard: both demo analyses currently read as completed "today", and a change dated 20 days ago could never fall between them. In `packages/agents/src/demo.ts`, in `completedAnalysis`, replace

```ts
  await updateAnalysisStatus(db, id, "completed", { completedAt: new Date(at).toISOString() });
```

with

```ts
  // The save stamps the real clock; this run finished at its simulated time.
  await db.prepare("UPDATE analyses SET completed_at = ? WHERE id = ?").bind(new Date(at).toISOString(), id).run();
```

`updateAnalysisStatus` stays imported: `startDemoRun` and `advanceDemoRun` use it.

- [ ] **Step 4: Seed a merged change against a finding the second run no longer reports**

In `packages/agents/src/demo.ts`, change the first two import lines to

```ts
import type { DataRecord, Dataset, Finding, KeywordsInput, PageTemplate, RankedKeyword, SearchMetricRow } from "@organic-growth/core";
import { addDays, findingKey, slugify } from "@organic-growth/core";
```

and add `insertChange,` to the `@organic-growth/db` import list (after `getCrawlProgress,`). Then in `seedDemoSite`, after the two `completedAnalysis` calls and before `seedDemoResults`, add:

```ts
  await seedDemoFix(db, now);
```

and add this function above `seedDemoSite`:

```ts
/** One pull request, merged between the two analyses, for a first-run finding the second run no longer reports: History's "Fixed with Eumon" row. */
async function seedDemoFix(db: D1Like, now: number) {
  type Reported = { findings: Finding[] };
  const [first, second] = await Promise.all([getAnalysisJob(db, "analysis_demo_1"), getAnalysisJob(db, "analysis_demo_2")]);
  const after = new Set((second?.report as Reported | undefined)?.findings.map(findingKey) ?? []);
  const fixed = (first?.report as Reported | undefined)?.findings.find((finding) => !after.has(findingKey(finding)));
  if (!fixed) return;
  await insertChange(db, {
    id: "change_demo_1", siteId: DEMO_SITE_ID, analysisId: "analysis_demo_1", findingId: fixed.id, title: fixed.title,
    reason: fixed.recommendation ?? fixed.summary, evidence: {}, filesChanged: ["app/prices/[city]/page.tsx"], pagesAffected: fixed.pagesAffected ?? [], patch: "",
    status: "merged", prUrl: "https://github.com/demo-clinic/site/pull/12", prNumber: 12, author: "eumon", createdAt: new Date(now - 20 * DAY).toISOString(),
  });
}
```

`DAY` and `getAnalysisJob` are already in the file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build -w @organic-growth/agents && cd apps/web && node --test src/history.test.ts`
Expected: PASS — 5 tests. Then `npm test -w @organic-growth/agents`: PASS (the demo suite still seeds, plays a run, and deletes cleanly; `changes` cascades from `analyses`).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/demo.ts apps/web/src/history.test.ts
git commit -m "Demo: one merged pull request, so History shows a fix" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Glossary and full verification

**Files:**
- Modify: `CONTEXT.md` (two glossary entries)

- [ ] **Step 1: Add the terms**

In `CONTEXT.md`, after the **Opportunity** entry (before the `## Data` heading), add:

```markdown
- **Finding key**: the same problem across analyses: a finding's category and title with numbers blanked (`findingKey`). Each finished analysis saves its **key list** (kind `finding_keys` in the snapshot store, scope = the analysis id); a `vanished` row in a list says a previous finding is gone because every page it pointed at was missing or erroring in that crawl, decided on save because crawl rows are pruned later.
- **Resolution**: a finding key present in one analysis and absent from the next (`resolutions`). The History tab labels it **Fixed with Eumon** when a merged change or opened PR names a finding with that key, **No longer applies** when its row vanished, and **Resolved** otherwise. Eumon's **actions** (pull requests, page edits, CTA tests, publications) are listed beside them.
```

- [ ] **Step 2: Run everything**

Run: `npm test`
Expected: exit 0, every package's suite passes (core, db, agents, crawler, pages, web and the rest).

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "Glossary: finding key, resolution" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
