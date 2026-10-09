# Crawler additions: soft 404s, near-duplicate pages, findings by language

**Status:** sub-project C of "match the MedBay report" (2026-10-09); built straight through at the user's request.

**Goal:** three things the MedBay report saw in the catalogue that the full crawl did not: pages that say "not found" but answer 200 (Google's *Soft 404*), profiles that are the same page twice under slugs that differ by a code (*Duplicate, Google chose different canonical*), and problems that belong to one language version (630 doctors without an English bio, 35 pages still noindex because the Indonesian bio is missing). All three come from signals the crawler already has in hand while it reads a page; nothing is stored beyond a few bytes per page.

**Out of scope:** storing page bodies; a content-quality score; merging records (the data connector, sub-project D).

## 1. Per page, at crawl time

`CrawlPageResult` gains three fields, saved into `result_json`:

- `locale`: the language prefix of the URL (`classifyLanguage`: `id`, `zh`, or `default`).
- `textHash`: a 64-bit simhash of the visible text (16 hex characters) when the text has 200 characters or more; the core function `simhash` over lower-cased words and word pairs, with `hamming` to compare. Two pages are **near-duplicates** when their titles match and their hashes are within 6 bits.
- `softNotFound`: true when the page answered under 400 and its title or first heading says it is missing (`not found`, `404`, `doesn't exist`, `no longer available`, `tidak ditemukan`, `halaman tidak ada`, `找不到`, `不存在`) and its visible text is under 2,000 characters.

## 2. The 404 probe

Before an analysis reads its crawl, it fetches one URL that cannot exist (`/eumon-404-probe-<run id>`) as Googlebot and keeps `{ url, status, title }`. A status under 400 is a finding of its own — **"The site answers 200 for pages that don't exist"** (category `indexing`) — and every crawled page with that title counts as a soft 404 too, whatever its words. The probe's result is stored on the report (`notFoundProbe`).

## 3. Coverage

`getCrawlCoverage(db, analysisId, { notFoundTitle? })` adds:

- `issues.softNotFound` (and examples), from the per-page flag plus the probe title.
- `issues.nearDuplicate` and `nearDuplicateGroups: Array<{ title, urls, suffixed }>`: within each duplicate-title group of indexable pages, URLs whose hashes are within 6 bits of another's; `suffixed` when the URLs differ only by a trailing `-<code>` (letters and digits, four or more).
- `locales: Array<{ locale, urls, crawled, emptyShells, errors, noindex, redirected, missingDescription, missingStructuredData, softNotFound }>`, only when the crawl has more than one locale.

## 4. Findings

- **"Pages that say not found but answer 200"** (`indexing`): count, examples, the probe's title when it matched; recommendation: return 404 or 410 (or redirect to the replacement) and take them out of the sitemap, so Google stops spending crawls on them.
- **"Pages that are the same page twice"** (`content`): the near-duplicate count and groups; when some groups are suffixed, "N pairs differ only by a code at the end of the address — the same record listed twice"; recommendation: one canonical per record, merge or noindex the copies.
- **By language:** the full-crawl findings for noindex, redirects, thin HTML, missing descriptions, structured data and soft 404s end their summary with "By language: 26 without a prefix, 9 under /id/." when the crawl has more than one locale; evidence carries the split. Titles do not change, so History keys stay stable.

## 5. Demo

The demo's site serves a soft 404 (a 200 "Halaman tidak ditemukan" page for two retired treatment slugs listed in the sitemap) and lists one dentist twice with a suffixed slug and the same bio, so both findings show. It has one language, so the language note does not.

## 6. Testing

- core: `simhash` identical → equal, three words changed in a 150-word page → within 6 bits, unrelated → far apart; `hamming`.
- crawler: `fetchGooglebotPage` sets `locale`, `textHash` (only with enough text) and `softNotFound` (phrase, status under 400, short text); `probeNotFound` reports status and title; `findingsFromCrawlCoverage` writes the two findings and the language note.
- db: `getCrawlCoverage` counts soft 404s (flag and probe title), near-duplicates with suffixed groups, and locales.
- agents: the probe finding; the pipeline stores the probe and adds the finding.
- demo: the latest demo analysis carries both findings.
