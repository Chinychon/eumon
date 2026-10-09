# Dashboard › History: the problems Eumon helped fix

**Status:** design approved in chat on 2026-10-09; revised the same day for crawl retention (PR #6: crawl rows are kept for the two latest finished runs only).

**Goal:** an eighth Dashboard tab, **History**, listing every problem the analysis once reported that is now gone, who or what fixed it, and every action taken through Eumon, dated. It answers "what has Eumon done for this site" for the operator; the client link does not show it (yet).

**Success:** on a site with two or more completed analyses, History shows each finding that disappeared between runs with the date it was first seen and the date it was gone, labelled **Fixed with Eumon** (a merged change or opened PR for that finding), **No longer applies** (its pages vanished), or **Resolved**; and every merged change, PR, page edit, CTA test and page publication, in one dated list. Four numbers summarise it. Nothing is claimed that the rows don't show.

**Out of scope:**
- Opportunity wins (a query reaching page one, a gap closed): a later addition.
- A manual "mark as fixed".
- A client-link version.
- Any new table: the key lists live in `site_snapshots`.
- Crediting page edits or published pages to a finding; nothing links them, so they appear as actions.

## 1. Finding identity

`findingKey(finding)` in `packages/core/src/history.ts`: `${category}|${title with every run of digits replaced by "#"}`, lower-cased and trimmed. "Doctors wait for 3 data requests in sequence" and "… 4 …" are one problem. `pagesAffected` is kept beside the key for the "no longer applies" test but is not part of it: a finding that still affects fewer pages is still open.

## 2. Keys per run

- When `saveAnalysisReport` completes a run it also saves a snapshot of kind `finding_keys`, scope = the analysis id, `periodEnd` = the completion day, rows `KeyRow = { id, key, title, category, severity, pages, vanished? }` where `pages` is `pagesAffected.slice(0, 50)`. A missing snapshots table (code deployed before its migration) costs only the snapshot, as the health point does today.
- **Vanished rows.** Crawl rows are pruned to the two latest finished runs, so "did this finding's pages disappear" can only be answered when the run is saved. At that moment the previous run's key list is read and, for each of its findings that this run no longer reports and that has pages, the pages are checked in both crawls: a page that was live in the previous crawl (fetched, status under 400) and is missing or erroring (status 400 or more) now has vanished. When every page of the finding vanished, the finding is added to this run's list as `{ ...row, vanished: true }`: not an open finding, a record that it is gone because its pages are. Pages that were not in the previous crawl are unknown and never count as vanished. The save runs before the crawl rows are pruned.
- `historyRuns(db, siteId)` (db) returns the latest 12 finished runs with their key lists, oldest first, filling lists for runs that have none (runs before this feature) from their `report_json`: one read for all missing reports, one batch of writes. Old crawls are pruned, so backfilled lists carry no vanished rows; such resolutions read as **Resolved**. The History API calls it, so sites analysed before this feature have a history the first time the tab opens.
- Twelve runs keep the first open within the Free plan's 50 D1 queries per request (`listCompletedAnalyses(db, siteId, limit = HISTORY_RUNS)`).

## 3. Resolutions

`resolutions(runs)` in core, pure, over runs oldest → newest, each `{ analysisId, completedAt, keys: KeyRow[] }`:
- A key present in run *i* and absent from run *i+1* is **resolved** at run *i+1*: `resolvedAt` = its completion time, `resolvedBy` = its analysis id, `firstSeen` = the completion time of the earliest consecutive run that had it. A `vanished` row in run *i+1* is an absence that sets the resolution's `vanished: true`.
- A resolved key that appears again in a later run marks that resolution `reopenedAt`; a new open stretch starts, and a later disappearance is a new resolution.
- Keys present in the latest run are **open**; their count is returned beside the resolutions.
- Output row: `{ key, title, category, severity, pages, firstSeen, resolvedAt, resolvedBy, reopenedAt?, vanished }`, with the title and pages from the last run that had the finding.

## 4. Attribution

In the History API, for each resolution, in this order:
1. **Fixed with Eumon** when a `changes` row of the site has `finding_id` naming a finding whose key equals the resolution's key (the id → key map comes from the runs' key lists), status `merged` or `pr_opened`, and `created_at` between `firstSeen` and `resolvedAt`. The row carries the change title and `prUrl`/`prNumber`.
2. **No longer applies** when the resolution is `vanished` (§2).
3. **Resolved** otherwise.

## 5. Actions

Eumon's dated deeds, from existing rows, each `{ at, kind, title, detail, href?, view? }`:
- `change`: `changes` with status `merged` or `pr_opened` → "Pull request #n: ⟨title⟩", detail the reason, link the PR.
- `edit`: `page_revisions` (`listPageRevisions`) → "Edited ⟨field⟩ of ⟨path⟩", detail the reason and the before/after views and CTA clicks the revision already carries, link Page results.
- `cta`: `cta_variants` created → "Started CTA test: ⟨label⟩", link Page results.
- `publish`: `generated_pages` with `published_at`, grouped by day and template (`listPublications`) → "Published 48 pages from Doctors", link Landing pages.

## 6. The History tab

- `OVERVIEW_TABS` gains `{ tab: "history", label: "History" }` last; `AREA_PLACE` is unchanged (nothing links *to* History yet). The tab does not wait for the Results payload.
- `GET /api/sites/:id/history` → `{ runs, open, numbers: { resolved, fixedWithEumon, noLongerApplies, actions }, rows: HistoryRow[] }`, rows sorted by date newest first, capped at 200. `HistoryRow = { kind: "fixed" | "resolved" | "vanished" | "change" | "edit" | "cta" | "publish", at, title, detail, category?, since?, reopenedAt?, href?, view? }`.
- `HistoryPanel` (`apps/web/app/components/HistoryPanel.tsx`): one card with four `Kpi`s (Resolved, with the open count as caption · Fixed with Eumon · No longer apply · Actions), then `list-row`s. Each row: a `Badge` for its kind (Fixed with Eumon · Resolved · No longer applies · Pull request · Page edit · CTA test · Published), the title, the detail with "since ⟨first seen⟩" for resolutions and "reopened ⟨date⟩" when it was, the date on the right, and a link that opens the tab that explains a finding (`AREA_PLACE[findingArea(category)]`), the PR, or the engine page for an action. An `ExportMenu` with one sheet, "History".
- Empty states: no finished analysis → "Run an analysis first."; one finished analysis and no rows → "History starts with your second analysis: fix something, run it again."
- Operator only: the client report does not render it, and `/api/r/*` does not serve it.

## 7. Demo

The demo site already has two completed analyses through the real pipeline whose findings differ. `seedDemoSite` additionally inserts one merged change (with a PR number and URL, dated between the runs) against a first-run finding the second run no longer reports, so the demo shows a **Fixed with Eumon** row beside its **Resolved** rows; its published pages give **Published** actions. The demo test asserts those three.

## 8. Testing

- core: `findingKey` normalises digits and case and keeps categories apart; `runKeys` lists findings with up to 50 pages and flags vanished rows only when a previous finding is gone, has pages, and every page vanished; `resolutions` resolves, dates `firstSeen` from the earliest consecutive run, reads vanished rows, reopens, counts open, handles zero and one run.
- db: `saveAnalysisReport` writes the `finding_keys` snapshot with vanished rows from the two crawls; `historyRuns` fills missing lists from `report_json`, leaves existing ones alone, and orders oldest first; `listCompletedAnalyses` skips cancelled and failed runs; `listPublications` groups by day and template.
- web: `assembleHistory(db, siteId)` over SQLite rows: a merged change dated between the runs attributes; a vanished row gives "no longer applies"; otherwise "resolved"; a change naming an unknown finding id is ignored; actions come from changes, revisions, CTA variants and publications and sort newest first; one run gives `runs: 1` and no rows; the demo site (seeded in the test) has a fixed row, resolved rows and published actions.

## Phases

One plan. Order: core math, db snapshot and backfill, the API assembler and route, the tab, the demo, the glossary.
