# Content Grading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grade up to 8 of the site's important pages a month against the top 3 results for their search. Each grade covers common topics (from competitors' headings), length and structure. Show the grades on the Keywords tab, and turn weak pages into one registered check and a set of opportunities.

**Architecture:**
- Pure grading lives in `packages/core/src/content-grade.ts`.
- Target selection and page fetching live in `packages/agents/src/content-targets.ts`, which uses the crawler's `defaultFetcher`, `parseHtmlSignals` and `contentSignals`.
- Analysis-workflow steps (`content-targets`, `content-grades-n`) run before `runFullAnalysis`.
- Grades are stored in the snapshot kind `content_grades`, scoped to the site domain. No migration is needed.
- The check `content.coverage_gap` is added to the registry, plus opportunities and a `ContentGradesCard`.

**Tech Stack:** TypeScript, Cloudflare Workers + Workflows + D1, node:test, React, and the existing DataForSEO `fetchSerp`.

**Spec:** `docs/superpowers/specs/2026-10-10-content-grading-design.md`

## Global Constraints

- Branch `claude/content-grading` comes from `main`. Rank tracking, the check registry and the fix engine are already there. No migration.
- Targets:
  - at most 8 per analysis;
  - each target graded at most once per 28 days;
  - sources: tracked keywords in the top 10, then Search Console pairs at positions 4–15 by impressions;
  - de-duplicate by query and by page.
- Fetching:
  - the site's page plus the top 3 organic results;
  - skip the site's own domain, `platform` domains, and URLs disallowed by the competitor's robots.txt for `*`;
  - use the browser user agent;
  - a target needs its own page plus ≥ 2 competitor pages.
- At most 5 targets per Workflow step, which keeps each step under 50 fetches.
- Grade:
  - topic = a competitor H2/H3 heading after normalisation (lower-case, no digits or punctuation, en/ms/id stop words removed, generic headings dropped);
  - headings are merged into one topic when their Jaccard similarity is ≥ 0.5;
  - a topic counts when ≥ 2 competitors cover it (both of them when there are only 2);
  - the page covers a topic by a matching heading (Jaccard ≥ 0.5) or by having ≥ 70% of the topic's tokens in its main text;
  - score = 100 × (0.7·coverage + 0.15·min(1, own/median words) + 0.15·structure);
  - grades: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F otherwise.
- Check `content.coverage_gap`:
  - fires when ≥ 2 graded pages have coverage < 0.5 and ≥ 3 topics;
  - impact min(65, 25 + 5N).
- Opportunities:
  - for grade ≤ C, at most 5;
  - when a striking-distance opportunity already quotes the same query, enrich it instead of adding a new one.
- Third-party URLs become links only when they are http(s).
- Copy says "users" and never "operator", and names no client businesses. Hard corners.
- Commit trailer: `Co-Authored-By: Claude <your model name> <noreply@anthropic.com>`.
- Commands:
  - `npm run build:packages`
  - `npm test -w @organic-growth/<pkg>`
  - `node --test apps/web/src/<file>.test.ts`
  - `npm run typecheck -w @organic-growth/web`

## Review Focus

1. A competitor page that is mostly navigation ("Home", "About us", "Contact") must produce no topics (Task 1 test "generic headings are dropped").
2. A page written in Malay competing with Malay pages: stop words must not become topics, and coverage must match across languages' casing and diacritics (Task 1 test "Malay headings").
3. Only 1 competitor page fetched: the target is skipped with a note and never graded against a single page (Task 2 test).
4. Re-running an analysis the same month must not re-fetch targets graded within 28 days (Task 2 test).
5. A grade for a query no longer tracked or in striking distance must drop out after 90 days, not linger forever (Task 3 test).

---

### Task 1: Grading (core)

**Files:**
- Create `packages/core/src/content-grade.ts` and `packages/core/src/content-grade.test.ts`.
- Export the module from `packages/core/src/index.ts`.

**Interfaces:**
- `type GradedPage = { url: string; headings: string[]; mainText: string; words: number; listsOrTables: boolean; questionHeadings: number; faq: boolean }`
  - `headings` are the H2 and H3 texts only.
- `type ContentTopic = { label: string; covered: boolean; coveredBy: string[] }`
  - `coveredBy` holds competitor domains.
- `type ContentGrade = { score: number; grade: "A" | "B" | "C" | "D" | "F"; topics: ContentTopic[]; covered: number; missing: string[]; ownWords: number; medianWords: number; structure: Array<{ feature: "lists" | "questions" | "faq"; competitors: boolean; page: boolean }> }`
- `gradeContent(input: { page: GradedPage; competitors: Array<GradedPage & { domain: string }> }): ContentGrade`
- `normaliseHeading(text): string[]` returns the token list.
- `CONTENT_GRADE` holds the constants: `TOPIC_JACCARD: 0.5`, `TEXT_COVERAGE: 0.7`, `MISSING_MAX: 8`, the weights, and the grade cut-offs. Give each a comment with its reason.

- [ ] **Step 1: Failing tests.** Write these tests:
  - "generic headings are dropped": "Contact us", "Related posts", "Share this", "Table of contents", "FAQ", "Hubungi kami", "Artikel berkaitan" each give an empty token list.
  - "stop words and digits go": "The 5 best ways to recover after LASIK" gives `["best","ways","recover","lasik"]`. "Cara terbaik untuk pulih selepas rawatan" (ms) drops `untuk` and `selepas`.
  - "headings on different pages are one topic at Jaccard ≥ 0.5": "Recovery time after LASIK" and "LASIK recovery time" are one topic; "LASIK cost" and "Recovery time" are two.
  - "a topic counts only when two competitors cover it": 3 competitors where only one has "Celebrity patients" means that heading is not a topic. With 2 competitors, both must cover a heading for it to count.
  - "covered by heading or by text": the page has no "Risks" heading but its text says "the risks of LASIK include dry eyes", so "LASIK risks" is covered.
  - "score and grade boundaries":
    - full coverage, equal length, the same structure gives 100 and A;
    - 0 of 4 topics, half the length, no lists while competitors have them gives 100 × (0 + 0.15·0.5 + 0) = 7.5 and F;
    - check one value near each cut-off.
  - "no common topics means coverage 1".
  - "missing is ordered by how many competitors cover the topic, capped at 8".
  - "Malay headings": two Malay competitors with "Kos pembedahan LASIK" and "Kos LASIK di Malaysia" form one topic, "kos lasik". The page's text "kos pembedahan lasik ialah…" covers it.

- [ ] **Step 2: Implement.** Stop words are three small `Set`s:
  - English: the ~120 most common function words.
  - Malay: `dan, di, ke, dari, yang, untuk, dengan, pada, ini, itu, adalah, ialah, atau, juga, akan, dalam, oleh, selepas, sebelum, anda, kami, kita, saya, apa, bagaimana, berapa, mengapa, kenapa, bila, mana`.
  - Indonesian: the same plus `tidak, bisa, sudah, belum, setelah, sebagai`.

  Generic headings are a small set of normalised phrases matched on the whole token list: `contact us`, `related posts`, `share`, `share this`, `comments`, `leave a reply`, `table of contents`, `faq`, `faqs`, `hubungi kami`, `artikel berkaitan`, `kongsi`, `hubungi`, `daftar isi`, `artikel terkait`, `bagikan`. Also drop headings that end up with fewer than 2 tokens after normalisation.

  Use `/[\p{L}]+/gu` to tokenise, so letters with diacritics are kept. Lower-case with `toLocaleLowerCase()`.

  Topic clustering:
  1. Go through the competitors' headings in order.
  2. Put each heading into the first existing cluster where its Jaccard similarity with the cluster's first heading is ≥ 0.5, or start a new cluster.
  3. Each cluster records the set of competitor domains it came from.
  4. The label is the cluster's shortest original heading.

  Median words: the middle value, or the average of the two middle values. If there are no competitor pages, the median is 0 and the length ratio is 1.

- [ ] **Step 3:** Run `npm test -w @organic-growth/core`. Expect PASS.

- [ ] **Step 4: Commit** with the message `"Content grading: compare a page's topics, length and structure with the top results"`.

---

### Task 2: Targets and fetching (agents)

**Files:**
- Create `packages/agents/src/content-targets.ts` and `packages/agents/src/content-targets.test.ts`.
- Export them from `packages/agents/src/index.ts`.
- Add `listCurrentSearchMetrics(db, siteId): Promise<SearchMetricRow[]>` to `packages/db/src/index.ts`, next to `replaceCurrentSearchMetrics`. Read that function first to find the table it writes, then mirror its columns. Add one db test.

**Interfaces:**
- `type ContentTarget = { query: string; market: string; page: string; source: "tracked" | "search"; impressions: number | null }`
- `type ContentGradeRow = ContentGrade & { query: string; market: string; page: string; checkedAt: string; source: ContentTarget["source"]; impressions: number | null; competitors: Array<{ domain: string; url: string; words: number }> }`
- `pickContentTargets(input: { checks: RankCheck[]; tracked: string[]; markets: string[]; searchRows: SearchMetricRow[]; graded: ContentGradeRow[]; today: string }): ContentTarget[]`
  - Tracked keywords come first. Each latest check with a non-null position ≤ 10 gives a target with `page = url`.
  - Then Search Console pairs. Aggregate rows by (query, page) across devices and countries, weighting position by impressions. Keep positions 4–15, sorted by impressions descending. For the market, use the row's country when it is in `markets`, otherwise `markets[0]`.
  - Skip pairs whose query or page is already a target.
  - Skip targets graded within the last 28 days. A graded row matches when its (query, market) is the same.
  - Cap the list at 8.
- `fetchGradedPage(url, fetcher): Promise<GradedPage | null>`
  - Uses `defaultFetcher` with `BROWSER_UA`, then `parseHtmlSignals` and `contentSignals`.
  - Headings: take `parseHtmlSignals(...).headingOutline` entries for H2 and H3. Read its format and strip the level prefix.
  - FAQ = `jsonLdTypes` includes `FAQPage`.
  - Returns null on status ≥ 400, on an empty shell, or when the page has fewer than 100 words.
- `gradeTarget(target, input: { serpRow: SerpResult; site: string; fetcher?: Fetcher }): Promise<{ row: ContentGradeRow } | { skipped: string }>`
  - Take the first 3 organic results that are not the site and not a `platform`.
  - For each competitor origin, read robots.txt once with `fetchRobots(origin, "*", BROWSER_UA, fetcher)` and skip URLs it disallows.
  - Fetch the site's page and the competitors in parallel.
  - Needs ≥ 2 competitor pages, otherwise return `{ skipped: "fewer than 2 competitor pages could be read" }`.
  - Run `gradeContent` and build the row.

- [ ] **Step 1: Failing tests.** Use a fake fetcher that serves a few HTML fixtures and a robots.txt. Tests:
  - target selection: tracked before search; position and impressions rules; de-duplication; 28-day spacing; cap of 8; market choice;
  - a competitor page that returns 404 is dropped;
  - a robots.txt `Disallow: /` skips that competitor;
  - only 1 readable competitor gives a skip;
  - the site and platforms are never treated as competitors;
  - a full grade from fixtures has the expected `missing` list.

- [ ] **Step 2: Implement.**

- [ ] **Step 3:** Run `npm run build:packages && npm test -w @organic-growth/agents && npm test -w @organic-growth/db`. Expect PASS.

- [ ] **Step 4: Commit** with the message `"Content grading: pick the searches to grade and read the pages that rank"`.

---

### Task 3: Analysis steps and the store

**Files:**
- `apps/web/src/content-grading.ts` (new) and `apps/web/src/content-grading.test.ts`.
- `apps/web/src/analysis-workflow.ts`: add the steps before the step that calls `runFullAnalysis`.
- `packages/agents/src/connector-findings.ts`: `ConnectorSignals.contentGrades?: ContentGradeRow[]`.
- `apps/web/src/connectors-data.ts`: load the snapshot into the signals.

**Interfaces:**
- `contentTargets(db, site, today, keys): Promise<{ targets: ContentTarget[]; serp: Record<string, SerpResult>; notes: string[] }>`
  - For each target, find its results page in the `serp` snapshot for its market, using rows with `checkedAt` within 28 days.
  - Otherwise, when `keys.dataForSeo` is set, call `fetchSerp` and save the row into the `serp` snapshot, the same way `rank-tracking.ts` does.
  - Otherwise skip the target with the note `content grading skipped “q”: no results page (track it or add DataForSEO)`.
  - Read the search rows with `listCurrentSearchMetrics`, the rank checks with `listRankChecks` from today−30, and the tracked keywords and markets.
- `gradeSlice(db, site, slice, serp, today, fetcher?): Promise<{ rows: ContentGradeRow[]; notes: string[] }>`
- `saveContentGrades(db, site, rows, today)` loads the snapshot `content_grades` scoped to the site domain, then:
  - replaces rows with the same (query, market);
  - keeps the other rows;
  - drops rows older than 90 days whose target is no longer picked (just drop rows older than 90 days);
  - saves the result.

In `analysis-workflow.ts`:
- Add a `content-targets` step.
- Then `content-grades-1`, `content-grades-2` (5 targets each). Use `{ retries: { limit: 1, delay: "10 seconds" } }` and a 10-minute timeout.
- Then a `content-save` step.
- A failing step only adds a note. Wrap each step in a try/catch, the way the existing optional steps (research, inventory) do.
- Keys come from the workspace limits, the way the sync does. Read how the analysis gets keys (it may not have DataForSEO keys today). If the analysis has no access to the DataForSEO credentials, use only the stored `serp` snapshot and note that.
- The analysis' connector signals gain `contentGrades`, read from the saved snapshot.

- [ ] **Step 1: Failing tests** in `apps/web/src/content-grading.test.ts`, using real SQLite, a fake fetcher and a fake DataForSEO:
  - targets use the snapshot SERP when it is fresh, and fetch and save one when it isn't (when keys exist);
  - with no keys and no snapshot, the target is skipped with the note;
  - slices hold ≤ 5 targets;
  - save replaces and keeps rows, and drops rows older than 90 days.

- [ ] **Step 2: Implement and wire.**

- [ ] **Step 3:** Run `npm run build:packages && node --test apps/web/src/content-grading.test.ts && npm run typecheck -w @organic-growth/web`. Expect PASS.

- [ ] **Step 4: Commit** with the message `"Content grading: analysis steps grade up to 8 searches, five a step, and keep the latest grade per search"`.

---

### Task 4: The card

**Files:**
- `packages/core/src/results.ts`: `ResultsInput.contentGrades?: ContentGradeRow[]` and `ResultsView.contentGrades`. Sort by grade, worst first, then by impressions.
- `apps/web/src/results-data.ts`: load the snapshot, with `.catch(() => [])`.
- `apps/web/app/components/results/ContentGradesCard.tsx` (new).
- `apps/web/app/components/SitePanels.tsx`: in `KeywordsPanel`, after `RankTrackingCard`.
- `apps/web/app/r/[token]/ClientReport.tsx`: only when there are grades.

- [ ] **Step 1:** Write a loading test in `results-data.test.ts`.

- [ ] **Step 2:** Build the card as the spec's §6 describes:
  - grade badge tones: A/B green, C amber, D/F red;
  - "N of M topics";
  - words against the median;
  - up to 5 missing topics, then "+N more";
  - the date checked;
  - a row click opens a detail row with the full topic list, the structure comparison, and the competitor pages (links only when http(s));
  - the spec's empty states.

  Follow the structure of `RankTrackingCard.tsx` and `AiAnswersCard.tsx`.

- [ ] **Step 3:** Run `npm run build:packages && node --test apps/web/src/results-data.test.ts && npm run typecheck -w @organic-growth/web && npm run build -w @organic-growth/web`. Expect PASS.

- [ ] **Step 4: Commit** with the message `"Content grades card on the Keywords tab and the client link"`.

---

### Task 5: The check and opportunities

**Files:**
- `packages/core/src/checks/catalog.ts`: add the `content.coverage_gap` entry with full docs. See the spec's §7 and mirror the `rank.fell` entry's shape.
- Wherever the registry produces findings from connector signals: read how `rank.fell` and `answers.*` are produced through the registry on `main`, and produce `content.coverage_gap` the same way.
- `packages/agents/src/content-findings.ts` (new): `findingsFromContentGrades` and `contentOpportunities`, with tests.
- `packages/agents/src/index.ts`: in `buildOpportunities`, add `contentOpportunities` before `withSerpContext`. Pass the opportunities list built so far as `existing`. When a striking-distance opportunity quotes the same query, append the sentence ` The top results also cover: ${missing.slice(0,5).join(", ")}.` to its rationale instead of adding a new opportunity.
- `demand.ts`: if you need a new demand kind, add it the way `ai_answer` was added.

- [ ] **Step 1: Failing tests.**
  - The check fires at 2 weak pages and not at 1. A page with fewer than 3 topics doesn't count. The title is exact. Impact matches the formula. `pagesAffected` holds the pages.
  - Opportunities are made for C, D and F and not for A or B. There are at most 5. The striking-distance rationale is enriched rather than duplicated. The title format is exact.
  - The registry test that counts checks is updated.

- [ ] **Step 2: Implement and register.** Also update the generated checks docs, if the repo generates them; see how #29 or #34 added a check.

- [ ] **Step 3:** Run `npm run build:packages && npm test -w @organic-growth/core && npm test -w @organic-growth/agents && npm run typecheck -w @organic-growth/web`. Expect PASS.

- [ ] **Step 4: Commit** with the message `"Content grading: the coverage-gap check and per-page opportunities"`.

---

### Task 6: Demo

**Files:** `packages/agents/src/demo.ts`, `demo-connectors.ts` and `demo.test.ts`.

- [ ] **Step 1:** Write failing assertions:
  - the demo analysis has the finding "2 pages cover less than half of what the top results cover" (or the exact title for the seeded data);
  - it has two `Cover what the top results cover for “…”` opportunities.

  Show the red step.

- [ ] **Step 2:** Seed 5 grade rows, as the spec's §8 describes, for the demo's own queries (treatments × Kuala Lumpur), with the demo's competitor domains. Build each row by running `gradeContent` over small synthetic page fixtures, so the numbers come from the real grader rather than being written by hand. Save the `content_grades` snapshot. The demo analysis' connectors get `contentGrades`.

- [ ] **Step 3:** Run `npm run build:packages && npm test -w @organic-growth/agents`. Expect PASS, including the ownership test.

- [ ] **Step 4: Commit** with the message `"Demo site: five graded searches, two that trail the top results"`.

---

### Task 7: Words, docs, full check

**Files:**
- `CONTEXT.md`: under Growth plan, add **Content grade**, with the topic and coverage rules.
- `docs/site/pages/web-app.html`: one sentence.
- `docs/site/pages/findings.html`: a Producers row.
- The checks docs, if they are generated.

- [ ] **Step 1:** Make the edits. Follow the copy rules.

- [ ] **Step 2:** Run `npm run build:packages && npm run typecheck && npm test`. If there is a docs build script, run that too. Everything must pass.

- [ ] **Step 3:** Commit with the message `"Content grading: context terms and docs"`. Do not push or open a PR.
