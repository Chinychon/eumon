# Crawler Additions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Executed by its author in the same session; names and test cases are exact, routine code follows TDD.

**Goal:** Soft 404s, near-duplicate pages and per-language splits in the full-crawl findings, from signals the crawler already has.

**Architecture:** `simhash`/`hamming` in core; three new `CrawlPageResult` fields set in the crawler's `toCrawlResult` and stored in `result_json`; `probeNotFound` in the crawler; `getCrawlCoverage` grows two issues, near-duplicate groups and a locale split; `findingsFromCrawlCoverage` grows two findings and a language note; the pipeline, workflow and demo run the probe first.

**Spec:** `docs/superpowers/specs/2026-10-10-crawler-additions-design.md`

## Global Constraints
- Near-duplicate: same title and `hamming ≤ 6` (`NEAR_DUPLICATE_DISTANCE`); hashes only for text ≥ 200 characters.
- Soft 404 phrases: `not found`, `404`, `doesn't exist`, `no longer available`, `tidak ditemukan`, `halaman tidak ada`, `找不到`, `不存在`; status < 400; text < 2,000 characters.
- Probe path: `/eumon-404-probe-<run id>`; one fetch per analysis.
- Finding titles unchanged for existing findings (History keys); the language note goes in summaries and evidence.
- No migration; `result_json` carries the new fields; older crawls lack them and the new counts read 0.

## Review Focus
1. A page whose title legitimately contains "404" (a blog post about errors) with long text is not a soft 404 (the text-length guard). Task 2.
2. Two different people who share a name (same title, different bios) are not near-duplicates. Task 1 + 3.
3. A site that answers 200 for everything makes every page share the probe's title only if it really does; pages with their own titles are untouched. Task 3.
4. A single-language crawl produces no language note and no `locales`. Task 3 + 4.
5. Older crawls (no `locale`/`textHash`/`softNotFound` in `result_json`) count 0 and never fail. Task 3.

---
### Task 1: Core fingerprints — `packages/core/src/fingerprint.ts` (+ test, export).
### Task 2: Crawler fields and probe — `CrawlPageResult` (+`locale`, `textHash`, `softNotFound`), `toCrawlResult`, `probeNotFound`; tests in `crawler.test.ts`.
### Task 3: Coverage — `saveCrawlBatch` stores the fields; `CRAWL_ISSUES.softNotFound`; `getCrawlCoverage(db, id, { notFoundTitle })` adds near-duplicate groups and locales; `CrawlIssue`/`CrawlCoverage` types; tests in `crawl.test.ts`.
### Task 4: Findings — `findingsFromCrawlCoverage` two drafts + language note; tests in `crawler.test.ts`.
### Task 5: Probe wiring — `notFoundProbeFinding` (agents), pipeline input `notFoundProbe`, workflow and demo run the probe and pass `notFoundTitle`; demo serves a soft 404 and a duplicate dentist; demo test.
### Task 6: Glossary; full suite; PR.
