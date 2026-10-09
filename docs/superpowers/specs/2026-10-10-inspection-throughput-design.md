# Inspection throughput on the Free plan: 2,000 a day in steps of 40

**Status:** sub-project E of "match the MedBay report" (2026-10-09); built straight through at the user's request.

**Goal:** Google's URL Inspection API allows 2,000 inspections a day per property, and Eumon's index-status views (Results › Indexing, the coverage by page type, the `pages_indexed` series) are only as current as the inspections behind them. In production Eumon inspects almost nothing: the daily `SearchSyncWorkflow` has had no trigger since 2026-10-09 (the Workflow `schedules` option was dropped because it needs the paid Workers plan), so only "Sync now" runs, and it inspects 100 Eumon pages plus 50 sitemap URLs inline, in one request. Even the workflow's own steps of 200 inspections would fail on the Free plan, which allows 50 subrequests per step. The MedBay report's indexing table came from Google's URL lists; Eumon should be able to ask Google about every sitemap URL within days, not months.

**Out of scope:** the paid plan (the user declined it); more than one property per site; inspecting URLs outside the latest crawl.

## 1. Steps of 40

- `INSPECTION_STEP = 40`: inspections per workflow step, ten at a time as now. With the token refresh and a handful of D1 statements that stays under the Free plan's 50 subrequests per step.
- **Eumon pages:** up to 100 a day (`PAGE_INSPECTIONS_PER_DAY`), least recently checked first, in steps of 40 (three steps). Pages checked today are skipped, so a second Sync now spends nothing. After the last page step, `pages_indexed` and `pages_not_indexed` are written for the day.
- **Sitemap URLs:** up to 47 steps of 40 (`COVERAGE_ROUNDS`), 1,880 a day: unchecked URLs round-robin across page types, then those checked over 30 days ago. Total ≤ 1,980 a day, under the quota.
- A **refusal** (429, 401, or a whole batch of 403) ends the site's inspections for the day, as now; the notes say so.
- **Step budget:** a Workflow instance may run 1,024 steps on the Free plan. The daily run counts its steps and stops a site's coverage rounds when 1,000 are used (note `coverage paused: step budget`), so a run over many sites finishes instead of failing. About 52 steps per site: nineteen sites fit in one daily instance.

## 2. One workflow for both triggers

`SearchSyncWorkflow` takes `{ siteId?: string; trigger: "daily" | "manual" }`: every site for the daily run, one site for Sync now. Per site:

1. `<site>/sources`: every source except inspection, through `syncResults` as today (one retry).
2. `<site>/pages-1..3`: Eumon pages, 40 a step, until fewer than 40 come back or Google refuses.
3. `<site>/index-counts`: the two `pages_*` points (D1 only).
4. `<site>/coverage-1..47`: sitemap URLs, 40 a step, until the queue is empty, Google refuses, or the step budget is reached.
5. `<site>/record`: the sync run with every note, including `inspected N pages` and `coverage: inspected N in K steps`.

`syncSite(deps, step, siteId, trigger, budget)` and `syncSites(deps, step, params)` in `apps/web/src/sync-steps.ts` hold the logic behind a small `StepLike` interface (`do(name, fn, options?)`), so tests run them with a plain function and count inspections per step. The workflow class only adapts `WorkflowStep`. The `inspection` source, `coverageLimit` and `SYNC_NOW_COVERAGE` go.

The demo site runs through the same path but skips inspection (its property is fictional; `syncResults` already limits it to first-party counts).

## 3. Sync now starts the workflow

`POST /api/sites/:id/results/sync` creates the instance `manual-<siteId>-<time>` with `{ siteId, trigger: "manual" }` and answers 202 `{ startedAt }`. The dashboard's Sync now polls Setup › Sync history (`GET /api/sites/:id/sync-runs`) every four seconds, up to fifteen minutes, until a run started at or after `startedAt` appears, then reloads the results and reports the problem notes as before. If nothing appears in time it says the sync is still running and where its result will show. One site's 2,000 inspections take about ten minutes at ten in flight.

## 4. A daily trigger the Free plan allows

A **Worker cron trigger** (`triggers.scheduled({ schedule: "15 4 * * *" })` in `cloudflare.config.ts`; Cron Triggers are on the Free plan, five per account) invokes a `scheduled` handler exported from `worker.ts` beside vinext's fetch handler. The handler creates the instance `daily-<YYYY-MM-DD>` with `{ trigger: "daily" }`; an instance that already exists (a second firing the same day) is left alone. The Workflow `schedules` option stays off.

## 5. Testing

- `apps/web/src/sync-steps.test.ts` over SQLite with a fake fetch and a step recorder: no step asks Google more than 40 times; 130 published pages and 2,000 sitemap URLs give `inspected 100 pages` and `coverage: inspected 1,880 in 47 steps`; a 429 after 120 answers stops the day with the statuses before it kept; ten in flight at most; a lone 403 page is skipped and the rest inspected; a revoked token records the run with `google failed` and no inspection steps; a manual sync for one site touches only that site; the step budget pauses coverage with its note; the demo site never asks Google; `pages_indexed` is written once per day.
- `startSync(env, params, now)`: the daily id is the date, and an instance that exists is not an error.
- The existing inspection tests in `results-sync.test.ts` move to the new file; `syncResults` is tested without inspection.

## Rulings while building

- The `inspection` source leaves `syncResults` rather than shrinking to 40: in one HTTP request every source shares the 50 subrequests, so inline inspection on the Free plan can never be more than a sample, and the sample was what made Sync now exceed the budget.
- Sync now becomes asynchronous. The button used to answer with the notes in about half a minute; now it answers at once and the dashboard waits for the run to be recorded. Cost if wrong: an operator who closes the tab sees the result only in Sync history.
