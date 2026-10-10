# Inspection Throughput Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** inspect up to 1,980 URLs a day per site on the Workers Free plan, from a daily cron trigger and from Sync now, in workflow steps of 40.

**Architecture:** inspection leaves the sync runner and becomes workflow steps (`sync-steps.ts`, testable through a `StepLike`); the workflow runs every site or one; Sync now creates an instance and the dashboard waits for the recorded run; a Worker cron trigger creates the daily instance.

**Tech Stack:** Cloudflare Workflows and Cron Triggers via `cf/config`; node:test over SQLite.

**Spec:** `docs/superpowers/specs/2026-10-10-inspection-throughput-design.md`

## Global Constraints

- 40 inspections per step, 10 in flight; ≤ 100 Eumon pages and ≤ 47 coverage steps a day; stop on 429/401/batch-403; step budget 1,000.
- No change to `url_index_status` / `page_index_status` schemas; no migration.
- The demo site never calls Google.

## Review Focus

- A step that throws (D1 error, token refresh failure) must end the site's inspections with a note, not the whole run.
- Step names must be unique per instance (`<siteId>/coverage-<n>`).
- `startSync` must tolerate an existing daily instance id.
- The dashboard poll must stop (fifteen minutes) and must match the run by `startedAt >= requested`.
- `syncResults` callers: route (removed), workflow (via `syncSite`), tests.

### Task 1: `sync-steps.ts` + tests (red → green). Files: `apps/web/src/sync-steps.ts`, `apps/web/src/sync-steps.test.ts`, `apps/web/src/url-inspection.ts` (`INSPECTION_STEP`, `PAGE_INSPECTIONS_PER_DAY`, `COVERAGE_ROUNDS`, `inspectEumonPages`, `coverageRound` returning `{ inspected, remaining, refused }`), `apps/web/src/results-sources.ts` (drop `inspection`), `apps/web/src/results-sync.ts` (drop `coverageLimit`), `apps/web/src/results-sync.test.ts` (move inspection tests).
### Task 2: workflow, route, cron. Files: `apps/web/src/search-sync-workflow.ts`, `apps/web/app/api/sites/[siteId]/results/sync/route.ts`, `apps/web/worker.ts`, `apps/web/cloudflare.config.ts`.
### Task 3: dashboard wait. File: `apps/web/app/components/OverviewView.tsx`.
### Task 4: glossary (`CONTEXT.md` Sync section), README line, full suite, PR.
