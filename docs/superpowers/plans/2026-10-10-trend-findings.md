# Trend Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Executed by its author in the same session: names, interfaces and test cases are exact; routine code follows TDD.

**Goal:** Three findings from series Eumon already stores: an impressions fall, an indexed-count fall, and Googlebot's crawl pace against the sitemap.

**Architecture:** Pure math in `packages/core/src/trends.ts`; `loadTrendSignals` in `packages/agents/src/trend-signals.ts` reads the ledger; `findingsFromTrends` in `connector-findings.ts`; wired through `ConnectorSignals.trends` in the pipeline, the analysis workflow and the demo.

**Spec:** `docs/superpowers/specs/2026-10-10-trend-findings-design.md`

## Global Constraints

- Thresholds, in one place: impressions window 7 days, lookback 120 days, peak level ≥ 100/day, fire at ≤ 60% of peak, peak window ends ≥ 7 days before the latest day; indexed fall ≥ 10% and ≥ 50 pages against the 90-day maximum; crawl pace > 60 days with ≥ 200 sitemap URLs, from ≥ 14 days of logs, averaged over the last 28 days ending yesterday.
- Finding titles carry digits only where History's key blanking handles them (numbers and dates); no commas inside numbers in titles.
- No new table, no new sync, no new secret.

## Review Focus

1. A series with gaps (days without points) averages over the points present, never treating a missing day as zero. Task 1.
2. A site whose impressions never reached 100/day gets no impressions finding, however steep the relative fall. Task 1 + 2.
3. The indexed-count finding prefers the imported chart but falls back to the inspection sample, and says which it used. Task 2.
4. Fewer than 14 days of logs, or logs ending long ago, give no pace finding rather than a wrong one. Task 1.
5. The demo's rising series produce no drop findings. Task 3.

---

### Task 1: Core trend math
**Files:** create `packages/core/src/trends.ts`, `packages/core/src/trends.test.ts`; modify `packages/core/src/index.ts`.
**Produces:**
```ts
export type DayPoint = { day: string; value: number };
export type Window = { from: string; to: string; average: number };
export function latestAverage(series: DayPoint[], window?: number): Window | null;
export function peakAverage(series: DayPoint[], window?: number, minLevel?: number, endBefore?: string): Window | null;
export function dropFromPeak(series: DayPoint[], minShare: number, minCount: number): { peakDay: string; peak: number; latestDay: string; latest: number; share: number } | null;
export function googlebotPace(rows: CrawlDayRow[], today: string, window?: number, minDays?: number): { perDay: number; days: number } | null;
```
- [ ] Tests first (watch fail), implement, `npm test -w @organic-growth/core`, commit.

### Task 2: Signals and findings
**Files:** create `packages/agents/src/trend-signals.ts`; modify `packages/agents/src/connector-findings.ts` (`TrendSignals` on `ConnectorSignals`, `findingsFromTrends`), `packages/agents/src/pipeline.ts`, `packages/agents/src/index.ts` (export), `apps/web/src/connectors-data.ts` + `apps/web/src/analysis-workflow.ts` (pass trends); tests in `connector-findings.test.ts` and `trend-signals.test.ts`.
**Produces:**
```ts
export type TrendSignals = { impressions: DayPoint[]; indexed: DayPoint[]; indexedSource: "search_console" | "inspection" | null; crawlLog: CrawlDayRow[]; today: string };
export function loadTrendSignals(db: D1Like, siteId: string, crawlLog: CrawlDayRow[], today?: string): Promise<TrendSignals>;
export function findingsFromTrends(input: { siteId: string; analysisId: string; trends: TrendSignals | null; sitemapUrls: number | null; discovered: number | null }): Finding[];
```
- [ ] Tests first, implement, agents + web suites, typecheck, commit.

### Task 3: Demo and glossary
**Files:** modify `packages/agents/src/demo.ts` (`seedDemoCrawlLog`, pass trends), `packages/agents/src/demo.test.ts` (the pace finding), `CONTEXT.md`.
- [ ] Test first, implement, full `npm test` + `npm run typecheck`, commit.
