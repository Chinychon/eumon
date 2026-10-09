# Dashboard › History: the problems Eumon helped fix

**Status:** design approved in chat on 2026-10-09; this spec awaits review.

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

- When `saveAnalysisReport` completes a run, it also saves a snapshot of kind `finding_keys`, scope = the analysis id, `periodEnd` = the completion day, rows `{ id, key, title, category, severity, pages }` where `pages` is `pagesAffected.slice(0, 50)`. A missing snapshots table (code deployed before its migration) costs only the snapshot, as the health point does today.
- `ensureFindingKeys(db, siteId)` (db) fills the snapshot for completed analyses that have none, from `report_json`, for the latest 24 completed runs. The History API calls it first, so sites analysed before this feature have a history the first time the tab opens.
- `listCompletedAnalyses(db, siteId, limit = 24)` returns `{ id, completedAt }` oldest first.

## 3. Resolutions

`resolutions(runs)` in core, pure, over runs oldest → newest, each `{ analysisId, completedAt, keys: KeyRow[] }`:
- A key present in run *i* and absent from run *i+1* is **resolved** at run *i+1*: `resolvedAt` = its completion time, `resolvedBy` = its analysis id, `firstSeen` = the completion time of the earliest consecutive run that had it.
- A resolved key that appears again in a later run marks that resolution `reopenedAt`; a new open stretch starts, and a later disappearance is a new resolution.
- Keys present in the latest run are **open**; their count is returned beside the resolutions.
- Output row: `{ key, title, category, severity, pages, firstSeen, resolvedAt, resolvedBy, reopenedAt? }`, with the title and pages from the last run that had the finding.

## 4. Attribution

In the History API, for each resolution, in this order:
1. **Fixed with Eumon** when a `changes` row of the site has `finding_id` naming a finding whose key equals the resolution's key (the id → key map comes from that run's `finding_keys` snapshot), status `merged` or `pr_opened`, and `created_at` between `firstSeen` and `resolvedAt`. The row carries the change title and `prUrl`/`prNumber`.
2. **No longer applies** when the resolution has pages and every one of them is, in the resolving run's crawl (`pages` table, `analysis_id = resolvedBy`), either absent or `status >= 400`.
3. **Resolved** otherwise.

## 5. Actions

Eumon's dated deeds, from existing rows, each `{ at, kind, title, detail, link }`:
- `change`: `changes` with status `merged` or `pr_opened` → "Pull request #n: ⟨title⟩", detail the reason, link the PR.
- `edit`: `page_revisions` (`listPageRevisions`) → "Edited ⟨field⟩ of ⟨path⟩", detail the reason and the before/after effect the revision already carries, link Page results.
- `cta`: `cta_variants` created → "Started CTA test: ⟨label⟩", link Page results.
- `publish`: `generated_pages` with `published_at`, grouped by day and template → "Published 48 pages from Doctors", link Landing pages.

## 6. The History tab

- `OVERVIEW_TABS` gains `{ tab: "history", label: "History" }` last; `AREA_PLACE` is unchanged (nothing links *to* History yet).
- `GET /api/sites/:id/history` → `{ numbers: { resolved, fixedWithEumon, noLongerApplies, actions }, open, rows: Array<Resolution & { attribution } | Action> }` sorted by date, newest first, capped at 200 rows.
- `HistoryPanel` (in `SitePanels.tsx`): four `Kpi`s, then one list in the ruled column. Each row: the date (`formatDay`), a `Badge` for its kind (Fixed with Eumon · Resolved · No longer applies · Pull request · Page edit · CTA test · Published), the title, "since ⟨first seen⟩" for resolutions, "reopened ⟨date⟩" when it was, and a link that opens the Technical, Search or Enquiries tab for a finding (by `findingArea(category)`) or the engine page for an action. An `ExportMenu` with one sheet, "History".
- Empty states: one completed analysis → "History starts with your second analysis: fix something, run it again." No analyses → "Run an analysis first." Rows but no actions → the list simply has none.
- Operator only: the client report does not render it, and `/api/r/*` does not serve it.

## 7. Demo

The demo site already has two completed analyses with different findings; `seedDemoSite` additionally merges one change against a first-run finding so the demo shows all three attributions. The demo test asserts the History response has resolutions with each label and at least one action.

## 8. Testing

- core: `findingKey` normalises digits and case; `resolutions` resolves, dates `firstSeen` from the earliest consecutive run, reopens, counts open.
- db: `saveAnalysisReport` writes the `finding_keys` snapshot; `ensureFindingKeys` fills missing ones from `report_json` and leaves existing ones alone; `listCompletedAnalyses` orders oldest first.
- web: `assembleHistory(db, siteId)` over SQLite rows: a merged change attributes; pages all 404 in the resolving run give "no longer applies"; otherwise "resolved"; actions come from changes, revisions, CTA variants and publications and sort newest first; the row cap.
- demo test as in §7.

## Phases

One plan. Order: core math, db snapshot and backfill, the API assembler, the tab, the demo.
