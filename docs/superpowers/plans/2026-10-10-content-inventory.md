# Content Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Executed by its author in the same session; names and test cases are exact, routine code follows TDD.

**Goal:** A dataset answers "which records lack a field (by language), which are listed twice, whose pages are thin", as findings and a card; a dataset can read a Supabase table.

**Spec:** `docs/superpowers/specs/2026-10-10-content-inventory-design.md`

## Global Constraints
- Inventory findings only for datasets with ≥ 50 records; thresholds as spec §2.
- The Supabase key is stored sealed under provider `supabase:<source id>` and never leaves the server.
- A pull reads at most 40 pages of 1,000 rows.
- No migration (`urlPattern` carries the table; `oauth_credentials` holds the key).

## Review Focus
1. A field whose key is `id` is not read as the Indonesian variant of a field named "" (language suffix detection needs a base). Task 1.
2. Two different people with the same name are one "duplicate group" — the finding says "listed more than once", not "the same person"; the Merge action decides. Task 1 + 2.
3. The pull stops on a non-2xx and reports it; a wrong key is a 401 shown as a plain message, never retried in a loop. Task 3.
4. The key is absent from every API response and from the sources list. Task 3.
5. A dataset without URLs on its records has `pages: null` and no thin-pages finding. Task 1 + 2.

### Task 1: `packages/pages/src/inventory.ts` (+ test, export).
### Task 2: `findingsFromInventory` in `connector-findings.ts`; `ConnectorSignals.inventory`; `apps/web/src/inventory-data.ts` (`datasetInventory(db, dataset)`, `loadInventories(db, siteId)`); `pagesByUrl` in db; pipeline + workflow + demo wiring; tests.
### Task 3: Supabase source: `DataSourceKind` + `SOURCE_KINDS`, `apps/web/src/supabase-source.ts` (`pullSupabaseSource`, `saveSupabaseKey`, `supabaseKey`), routes (`sources` POST accepts kind supabase + key; `sources/:id/pull`); tests. (Ruled while building: no daily sync source, see the spec's rulings.)
### Task 4: UI — inventory section and Supabase option in `DataView.tsx`; `GET /api/datasets/:id/inventory`.
### Task 5: Demo fields + test; glossary; full suite; PR.
