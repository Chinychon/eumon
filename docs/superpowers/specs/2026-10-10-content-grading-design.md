# Content grading: does the page cover what the pages that win cover?

**Status:** sub-project 5 of the competitor-features program (2026-10-10). Built straight through at the user's request. Branch `claude/content-grading` from `main`, which has rank tracking (#27), the check registry (#29) and the fix engine (#32).

**Goal:** Ahrefs' Content Grader and Semrush's SEO Writing Assistant score a page against the pages that rank for its search, and list the subtopics it misses. The audit engine already checks a page on its own terms: `content.thin`, `ai.no_answer_structure`, `ai.low_evidence`, `ai.stale`, `content.near_duplicate`. What it can't say is "the top three results for this search all cover X and Y; your page doesn't". Content grading adds that comparison for the searches that matter most, and turns the gaps into a finding, opportunities and a card.

**Success:** for each graded search, the Keywords tab shows:
- the page graded;
- a grade A–F with its score;
- how many of the top results' common topics the page covers;
- the missing topics, named from the competitors' own headings;
- the page's length against the competitors' median;
- whether competitors use lists, tables or question headings that the page lacks.

The growth plan gets one finding when several pages trail, plus an opportunity per weak page that names the topics to add. The client link shows the card read-only. The demo shows it all.

**Out of scope:**
- AI-written subtopic names. v1 uses the competitors' headings verbatim.
- Grading generated landing pages before publishing (a later quality gate).
- Editing the page. The fix engine's content edits are a later step; the missing topics are their input.
- Competitors' full keyword sets.
- Readability scores.

## 1. What gets graded

Up to **8 targets per analysis**, deduplicated by page and query:
1. **Tracked keywords** (rank tracking) whose latest check has the site in the top 10. The page is the check's landing URL. The market is the check's.
2. **Search Console striking-distance pairs** from the analysis' search insights: position 4–15, the most impressions first. The page is the pair's page. The market is the site's first target market whose results page is known, or the first covered market.

The top results come from the `serp` snapshot for that query and market when it is ≤ 28 days old. Otherwise, when the workspace may spend DataForSEO, Eumon fetches the results page with `fetchSerp` (about $0.004) and saves the row into the `serp` snapshot the way rank tracking does. Otherwise the target is skipped with a note.

A target is graded once per **28 days** (its `checkedAt` in the stored list). This spreads the work across analyses.

## 2. Fetching

For each target, Eumon fetches the site's page and the **top 3 organic results**, skipping:
- the site itself;
- platforms (`competitorKind` = `platform`: YouTube, Wikipedia, Reddit and the like);
- URLs the competitor's robots.txt disallows for `*`.

The fetch uses the crawler's `defaultFetcher` with the browser user agent, so all four pages are fetched the same way. `parseHtmlSignals` gives the heading outline and `mainText`. Pages that fail to fetch or come back as an empty shell are dropped.

A target needs the site's page plus at least **2** competitor pages to be graded. Otherwise it is skipped with a note.

The four fetches for one target run in parallel. Targets run in sequence inside one Workflow step, so 8 targets make at most 8 × (4 pages + 1 SERP + 3 robots.txt reads) = 64 fetches. That is over 50, so the step grades at most **5 targets**, about 40 fetches. A second step grades the rest. The step is named `content-grades-n`, as rank tracking names its steps.

## 3. Grading (pure, `packages/core/src/content-grade.ts`)

> **Amended 2026-10-10 after review probes.** Lexical topic matching (heading-token Jaccard, stemming, text coverage) proved unreliable on real pages: synonyms (cost/price/harga) never matched, stemming merged distinct topics (side effects/effectiveness, surgeon/surgery), Malay morphology broke stems, and half of two-competitor grades came back empty. **Topics are now proposed by the analysis' LLM and verified in code:** each topic must cite headings that exist verbatim on ≥ 2 competitor pages, and "covered" must quote a passage that exists verbatim in the site's page; anything unverified is dropped or counted missing. Length, structure, score and grade below are unchanged; fewer than 3 verified topics means no grade; no LLM means the target is skipped with a note. The paragraphs on topics and coverage below describe the superseded lexical rules.

**Topics:**
- Each competitor page's H2 and H3 headings are normalised:
  - lower-cased;
  - numbers and punctuation removed;
  - stop words removed (English, Malay and Indonesian lists);
  - generic headings dropped: "contact us", "related posts", "share", "comments", "table of contents", "faq" alone, and their Malay and Indonesian equivalents.
- Each heading becomes a token set.
- Headings from different pages are the same **topic** when their token sets' Jaccard similarity is ≥ 0.5.
- A topic counts when ≥ 2 of the competitor pages cover it. With only 2 pages, both must cover it.
- The topic's label is its shortest heading as the competitor wrote it.

**Coverage:** the page covers a topic when either:
- one of its headings matches the topic (Jaccard ≥ 0.5), or
- its `mainText` contains ≥ 70% of the topic's tokens.

**Length:** the page's word count against the competitors' median, as min(1, own ÷ median).

**Structure:** for each of the three features below, Eumon notes whether the competitors use it (at least half of them) and whether the page does:
- a list or table;
- question headings (the `QUESTION_QUERY_PATTERN` family);
- FAQ markup.

**Score:** 100 × (0.7 × coverage + 0.15 × length + 0.15 × structure).
- coverage = covered topics ÷ topics, or 1 when there are no common topics;
- structure = the share of the competitors' majority features that the page also has, or 1 when they have none.

**Grade:** A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F below.

`verifyTopics(proposals, { page, competitors, query })` keeps the AI's proposed topics whose citations and quotes check out, and `gradeContent({ page, competitors, topics })` grades the page on those topics. It returns null below 3 topics, otherwise:
- `score` and `grade`;
- `topics`: label, covered, which competitors cover it, and the verified quote (evidence);
- `missing`: labels, up to 8, the most-covered first;
- `ownWords` and `medianWords`;
- `structure`: per feature, competitors yes/no and page yes/no.

## 4. Store

No new table. The grades are the snapshot kind `content_grades`, scoped to the site's domain. The rows are the latest grade per (query, market):

`{ query, market, page, checkedAt, score, grade, topics, covered, missing, ownWords, medianWords, structure, competitors: [{ domain, url, words }] }`

A refresh replaces the rows it graded and keeps the others. Rows whose target no longer qualifies are dropped after 90 days.

## 5. Where it runs

The grading runs as Workflow steps in the analysis workflow, before `runFullAnalysis`, so the findings see this analysis' grades. The steps are:
- `content-targets`: picks the targets due, from rank checks, the search insights (the analysis already has the Search Console rows) and the `serp` snapshot;
- `content-grades-n`: up to 5 targets a step;
- the snapshot save.

A step that dies costs its note. The analysis goes on with the grades already stored.

## 6. Card

A **Content grades** card on the Keywords tab, after Rank tracking:
- A table with one row per graded search:
  - the query and market;
  - the page path, linked to the page;
  - the grade, as a badge (A/B green, C amber, D/F red);
  - "N of M topics";
  - the words against the median;
  - the missing topics as small labels, up to 5, with "+N more";
  - the date checked.
- Clicking a row shows the full topic list (covered or missing, and which competitors cover each one), the structure comparison, and the competitor pages, linked only when they are http(s).

Empty states:
- nothing graded yet: "Grades appear after the next analysis, for your tracked keywords and the searches where you rank 4 to 15";
- no results pages: "Add DataForSEO credentials or track keywords so Eumon knows who ranks".

The client link shows the card read-only.

## 7. Growth plan

**Check `content.coverage_gap`** (pillar `seo`, category `content`, class `warning`, scope `site`, fix `content`, requires "graded searches"):
- Title: "N pages cover less than half of what the top results cover".
- It fires when ≥ 2 graded pages have coverage under 0.5 and ≥ 3 common topics.
- Impact: 25 + 5 × N, capped at 65.
- `pagesAffected`: the pages.
- The summary names the worst three, with their missing topics.
- How to fix: "Add a section for each missing topic, in your own words and with your own facts. Answer the question in the opening lines, and use lists or tables where the top results do."
- It is registered in the catalog with its docs, and its History key comes from the check id.

**Opportunity per graded page with grade C or below** (up to 5):
- Title: `Cover what the top results cover for “${query}”: ${missing.slice(0,3).join(", ")}`.
- intent `content_coverage`.
- `currentPage` = the page.
- Priority: the striking-distance formula's impressions term when the target came from Search Console, or the keyword's volume when it is priced, multiplied by (1 − score/100).
- It is deduplicated against existing opportunities that quote the same query: when a striking-distance opportunity already names the query, its rationale gains the missing topics instead of adding a second opportunity.

## 8. Demo

The demo stores grades for 5 searches:
- one A;
- two B;
- one D, missing "Recovery time", "Risks and side effects" and "Cost breakdown";
- one F, missing five topics, with half the median length and no list.

The finding and two opportunities fire.

## 9. Testing

- **core:**
  - normalisation and stop words, including Malay and Indonesian;
  - generic headings are dropped;
  - topic clustering across pages (Jaccard);
  - the two-of-three rule;
  - coverage by heading and by text;
  - length and structure;
  - score and grade boundaries;
  - two pages instead of three.
- **agents:** target selection (tracked versus striking distance, deduplication, the 28-day spacing, the 8-target cap), and the finding and opportunity thresholds.
- **web:**
  - steps of at most 5 targets;
  - a page that fails to fetch is dropped;
  - a robots.txt disallow skips a competitor;
  - fewer than 2 competitors skips the target with a note;
  - the snapshot is replaced per target and the others are kept.
- **demo:** the finding and opportunities are present.

## Phases

One plan, in this order: grading (core), targets and fetching, the analysis steps, the card, the check and opportunities, the demo, docs.
