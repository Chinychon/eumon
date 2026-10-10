# Audit engine v2: one check registry, two health scores, generated docs

**Status:** competitor-features sub-project 4 ("audit health score"), widened after the 2026-10-10 brainstorm into the audit engine itself. Approved decisions: registry-first; health = share of healthy pages (Ahrefs-style); two pillars, **SEO** and **AI visibility**.

**Goal:** Eumon's audit is about 60 hand-built findings produced by ten pure functions, each assembling its own `Finding` with its own severity arithmetic, and documented by hand. Semrush runs 98 named checks, Ahrefs 170, and both publish a health score. This spec makes every check a declared entry in one registry (id, pillar, class, scope, docs, fix kind), migrates the existing findings onto it, adds 34 checks the research showed matter in 2026 (23 SEO, 11 AI visibility), computes two health scores from the registry's classes, and generates the Checks documentation page from the same registry so the docs cannot drift.

**Success:** an analysis report carries an audit table listing every registered check as passed, failed (with the page count) or not run (with the reason). The Overview shows **SEO health** and **AI visibility health**, each 0 to 100 with a 28-day change, and clicking one opens the checks behind it. Every finding carries a `checkId`; History matches findings by it instead of by blanked titles. The docs site has a Checks page listing every check, its class, scope, fix kind, what it means, why it matters and how to fix it, plus the checks Eumon deliberately does not run and why. A registry entry without docs fails the build.

**Calibration (Semrush, 2026-10-10):** Semrush's Site Audit for the user's own site crawled 5 pages (depth 0), scored 95, and reported: missing H1, low text-to-HTML ratio, low word count, no HSTS, pages with one internal link. Eumon crawls the whole sitemap. After this spec Eumon reports every one of those except text-to-HTML ratio, which is skipped on purpose (see §7).

**Out of scope:** the growth plan as an executable backlog (next spec; it consumes `fixKind` from this one); AI answer tracking (sub-project 2); anchor-text checks (need anchor text stored per link); TLS certificate inspection (not reachable from Workers `fetch`); readability scores (language dependent); pixel-width title checks; Lighthouse opportunities (CrUX and the lab score already come from the speed sync); changing how opportunities are scored.

## 1. The registry (`packages/core/src/checks/`)

One file per category (`render.ts`, `title.ts`, `links.ts`, `ai.ts`, …) exporting `Check` entries; `index.ts` exports `CHECKS` (a `Record<string, Check>` keyed by id), `checkList()` and `finding()`.

```ts
export type Pillar = "seo" | "ai";
/** Whether a failed instance makes a page unhealthy for the score. Severity (for ranking) is separate; see §4. */
export type CheckClass = "error" | "warning" | "notice";
export type CheckScope = "page" | "family" | "site";
export type CheckSource = "crawl" | "sample" | "render" | "probe" | "repo" | "search" | "connector" | "inventory";
/** What a fix changes, for the fix engine and the backlog spec. */
export type FixKind = "meta" | "content" | "schema" | "robots" | "redirect" | "links" | "server" | "sitemap" | "none";

export type Check = {
  /** Stable, lower-case, dotted. Never renamed; a retired check keeps its id in `RETIRED` so old reports still resolve. */
  id: string;
  /** Short name for tables and docs, e.g. "Missing H1". */
  name: string;
  pillars: Pillar[];            // [] for conversion and data checks: shown, never scored
  category: FindingCategory;    // the existing twelve; decides the dashboard tab
  class: CheckClass;
  scope: CheckScope;
  sources: CheckSource[];
  fix: FixKind;
  /** When the check needs something the site may not have: "full crawl", "repository", "Search Console", "server logs", "two or more languages", "DataForSEO". */
  requires?: string;
  docs: {
    what: string;      // what is checked, in one or two sentences
    why: string;       // why it matters, with the source when it is a study or a Google statement
    how: string;       // how to fix it, for a developer
    severity: string;  // how the instance's severity is decided, in words ("10 + 55 when empty shells are at scale …")
    /** When true, the docs say so and the score ignores it: llms.txt. */
    unscored?: boolean;
  };
};
```

`finding(check, input)` builds a `Finding`: `id`, `createdAt`, `category` and `checkId` from the check; `title`, `summary`, `evidence`, `pagesAffected`, `organicImpactScore` from the input; `severity` from `severityFromImpact(impact)` unless the input sets one (the two overrides today: Googlebot blocked site-wide is CRITICAL; AI crawlers blocked by robots.txt is INFORMATIONAL). `recommendation` defaults to `check.docs.how` and the input may replace it with a specific one (today's producers often name the exact file or URL; they keep that). `scopeKey` (new on `Finding`, optional) distinguishes several findings from one check: the family for family-scoped checks, the query or entity type for search and inventory checks.

`Finding` gains `checkId?: string` and `scopeKey?: string`. Reports written before this spec have neither; readers fall back to category (§4, §5).

Registry invariants, tested: ids unique and `^[a-z]+(\.[a-z0-9_]+)+$`; every docs field non-empty; `pillars` non-empty unless category is `conversion` or the check is a data check; a `page`-scoped check names at least one of `crawl`, `sample`; a check with `docs.unscored` has class `notice`.

### Migrating the existing producers

Mechanical: each `findings.push({ id: createId("finding"), … })` becomes `finding(CHECKS["…"], { … })`. Titles, summaries, evidence and severity arithmetic do not change in this spec, so the dashboard reads the same. The one behavioural change: `recommendation` is always present (from the docs when a producer had none). The table in §3 names the id for every existing finding.

## 2. New signals per page (crawl time, no extra fetches)

`parseHtmlSignals` and `toCrawlResult` add fields to `CrawlPageResult`, saved into `result_json` (a few bytes each; `0`/`false`/absent are not written):

| Field | From | Used by |
|---|---|---|
| `redirectHops` | the fetcher counts hops before the final response (`FetchResult.hops`) | `http.redirect_chain` |
| `lang` | `<html lang>` | `html.lang_missing` |
| `viewport` | `<meta name=viewport>` present | `html.viewport_missing` |
| `images`, `imagesNoAlt` | `<img>` count, and those with no `alt` attribute (an empty `alt` is decorative and fine) | `image.alt_missing` |
| `mixedContent` | `http://` in `src`/`href` of img, script, link, iframe, video, source on an https page | `security.mixed_content` |
| `httpLinks` | same-site `<a href="http://…">` count | `security.http_links` |
| `externalLinks` | `<a>` to other hosts, in the main content, excluding the hosts in `SOCIAL_HOSTS` (facebook, instagram, x, tiktok, youtube, linkedin, whatsapp, wa.me, t.me) | `ai.low_evidence` |
| `h1` | text of the first H1 (the outline keeps all headings) | `heading.h1_equals_title` |
| `words` | words in `mainText` | `content.thin`, `ai.no_answer_structure` |
| `questionHeadings` | h2/h3 that end with `?` or start with how, what, why, when, which, who, can, should, apa, bagaimana, mengapa, kenapa, bila, berapa, siapa, 如何, 什么, 为什么 | `ai.no_answer_structure` |
| `listsOrTables` | `<ol>`, `<ul>` (3+ items), `<table>` in the main content | `ai.no_answer_structure` |
| `leadWords` | words in the first paragraph after the H1 | `ai.no_answer_structure` |
| `statistics` | numbers with a unit or percent in the main text (`\d[\d,.]*\s?(%|percent|peratus|persen|million|juta|billion|km|kg|RM|USD|SGD|\$|years?|tahun)`) | `ai.low_evidence` |
| `quotes` | `<blockquote>` plus quoted spans of 40+ characters (`“…”`, `"…"`) | `ai.low_evidence` |
| `modified` | ISO date: JSON-LD `dateModified` else `datePublished`, else `<meta property=article:modified_time>` / `article:published_time`, else the first `<time datetime>` in the main content | `ai.stale`, `ai.no_date` |
| `articleLike` | JSON-LD type Article/BlogPosting/NewsArticle/MedicalWebPage, or `og:type=article`, or a `/blog/`, `/news/`, `/artikel/`, `/berita/` path segment | gates `ai.stale`, `ai.no_date`, `ai.no_author`, `ai.low_evidence` |
| `author` | JSON-LD `author`, `<meta name=author>`, `rel=author`, or a byline (`by`, `oleh`, `ditulis oleh` + a name) in the main content | `ai.no_author` |
| `snippetBlocked` | `nosnippet` or `max-snippet:0` in the robots meta or `X-Robots-Tag` | `ai.snippet_blocked` |
| `landmarks` | count of `<main>`, `<article>`, `<nav>`, `<header>`, `<footer>` | `ai.semantic_html_missing` |
| `headingSkips` | a heading more than one level below the previous (h2 → h4) | `heading.skipped_levels` |
| `entitySchema` | JSON-LD Organization, LocalBusiness or a subtype, or Person, with `sameAs` or `url` | `ai.no_entity_schema` (homepage) |

`CrawlIssue` grows one key per new page check; `CRAWL_ISSUES` in `packages/db/src/index.ts` gets its SQL condition, so `getCrawlCoverage` counts it in the same single query and lists eight examples the same way. The `pages` row's `status` and `title` columns already serve `http.error` and `title.*`.

**Response headers.** `toCrawlResult` records `hsts: true` when the final response carries `Strict-Transport-Security`; the site check reads the homepage's flag.

**Redirect hops.** `defaultFetcher` already follows up to five same-site redirects; it returns `hops` on `FetchResult`. A page with `hops >= 2` is a chain. The existing `redirected` issue (`finalUrl != url` or meta refresh) splits into `sitemap.redirects` (one hop), `http.redirect_chain` (two or more) and `http.meta_refresh`.

## 3. The checks

Class decides the score (§4); severity decides the plan's ranking, as today. **New** marks checks this spec adds. Scope `site` findings have no `pagesAffected`; `family` findings name the template.

### SEO pillar

| Id | Name | Class | Scope | Source | Fix | Today's title / note |
|---|---|---|---|---|---|---|
| `robots.googlebot_blocked` | Googlebot blocked site-wide | error | site | crawl | robots | "robots.txt blocks Googlebot from the entire site" (CRITICAL) |
| `robots.foreign_sitemap` | Sitemap on another domain | error | site | crawl | robots | "robots.txt points search engines to a sitemap on another domain" |
| `robots.missing` | No robots.txt | notice | site | crawl | robots | **New.** 404/410 for `/robots.txt`. Everything is allowed; the file is where the sitemap is declared. |
| `robots.sitemap_undeclared` | Sitemap not in robots.txt | notice | site | crawl | robots | **New.** A sitemap exists but no `Sitemap:` line names it. |
| `access.bot_challenge` | Bot protection blocked the crawl | error | site | crawl | server | "Bot protection blocked part of the crawl" |
| `access.googlebot_refused` | Firewall refuses unverified Googlebot | warning | site | crawl | server | "Your firewall refuses unverified Googlebot requests" |
| `server.soft_404_probe` | 200 for pages that don't exist | error | site | probe | server | "The site answers 200 for pages that don't exist" |
| `server.intermittent` | Intermittent failures | error | family | sample | server | "Intermittent empty or failed responses on …" |
| `server.slow` | Slow responses | warning | family | sample | server | "Slow responses on …" |
| `server.www_duplicate` | www and bare host both answer | warning | site | probe | redirect | **New.** The other host form returns 200 without redirecting to the base URL (one fetch). |
| `server.http_not_redirected` | HTTP homepage not redirected | error | site | probe | redirect | **New.** `http://` homepage answers 200 or redirects elsewhere than the https homepage (one fetch). |
| `security.hsts_missing` | No HSTS | notice | site | crawl | server | **New.** Homepage response lacks `Strict-Transport-Security`. |
| `security.mixed_content` | Mixed content | error | page | crawl | content | **New.** Browsers block or warn; Google treats it as a security issue. |
| `security.http_links` | Links to HTTP pages | warning | page | crawl | links | **New.** |
| `http.error` | URLs that fail | error | page | crawl | server | "Sitemap URLs fail or return error responses". Also `ai`: a page that errors cannot be cited. |
| `http.redirect_chain` | Redirect chains | error | page | crawl | redirect | **New.** Two or more hops; Google follows up to ten but each hop costs crawl and dilutes signals. |
| `http.meta_refresh` | Meta refresh redirects | error | page | crawl | redirect | **New.** Split from `redirected`. |
| `fetch.failed` | Sampled page could not be fetched | warning | page | sample | server | "Failed to fetch …" |
| `sitemap.redirects` | Sitemap URLs redirect | warning | page | crawl | sitemap | "Sitemap lists URLs that redirect" (one hop) |
| `sitemap.noindex` | Sitemap lists noindex pages | warning | page | crawl | sitemap | "Sitemap lists pages that are marked noindex" |
| `sitemap.blocked` | Sitemap lists blocked URLs | error | page | crawl | sitemap | "Sitemap lists URLs that robots.txt blocks for Googlebot" |
| `render.empty_shell` | Empty HTML to crawlers | error | page | crawl, sample | server | "Googlebot receives empty or thin HTML on sitemap URLs", "Entity pages return empty or thin HTML shells to crawlers". Also pillar `ai`. |
| `render.empty_after_js` | Empty after JavaScript | error | page | render | server | "Pages stay empty even after JavaScript runs" |
| `render.googlebot_less` | Googlebot gets less content | warning | page | render | server | "Googlebot receives less content than browsers". Also `ai`. |
| `render.prerender_mismatch` | Crawlers get HTML browsers don't | warning | page | render | server | "Crawlers get pre-rendered HTML that browsers don't" |
| `render.meta_by_js` | Titles and meta set by JavaScript | error | page | render | meta | "Titles and meta tags are set by JavaScript". Also `ai` (AI crawlers do not run JavaScript). |
| `render.js_content` | Content added by JavaScript | warning | page | render | server | "Page content only appears after JavaScript runs" / "Part of the page content is added by JavaScript". Also `ai`. |
| `render.coverage_weak` | Large sitemap, weak render coverage | warning | site | sample | server | "Large sitemap with weak render coverage" |
| `title.weak` | Weak or missing titles | error | page | crawl, sample | meta | "Sitemap URLs are missing useful title tags", "Weak or missing titles on indexable pages" |
| `title.duplicate` | Duplicate titles | warning | page | crawl | meta | "Several indexable pages share the same title" |
| `title.length` | Title too short or too long | warning | page | crawl | meta | **New.** Under 30 or over 60 characters on indexable pages; Google rewrites over-long titles. Threshold in `TITLE_LENGTH` with its reason. |
| `description.missing` | Missing or thin descriptions | warning | page | crawl, sample | meta | "Missing or very short meta descriptions", "Thin meta descriptions" |
| `description.duplicate` | Duplicate descriptions | warning | page | crawl | meta | **New.** Same query shape as `DUPLICATE_TITLES`. |
| `description.length` | Description too long | notice | page | crawl | meta | **New.** Over 160 characters. |
| `heading.h1_missing` | Missing H1 | warning | page | crawl | content | "Pages without an H1 heading". Also `ai`. |
| `heading.h1_multiple` | Multiple H1s | notice | page | crawl | content | "Pages with more than one H1 heading" |
| `heading.h1_equals_title` | H1 repeats the title | notice | page | crawl | content | **New.** A wasted chance to cover a second phrasing. |
| `heading.skipped_levels` | Skipped heading levels | notice | page | crawl | content | **New.** Also `ai`. |
| `canonical.mismatch` | Canonical points elsewhere | notice | page | crawl, sample | meta | "Canonical mismatches detected". Notice: pages that canonicalise elsewhere are excluded from the score's denominator rather than counted against it. |
| `hreflang.missing` | Multilingual pages without hreflang | warning | page | sample | meta | "Multilingual pages missing hreflang in HTML"; requires two or more languages |
| `html.lang_missing` | No language declared | warning | page | crawl | meta | **New.** `<html lang>` absent. |
| `html.viewport_missing` | No viewport | warning | page | crawl | meta | **New.** |
| `image.alt_missing` | Images without alt | warning | page | crawl | content | **New.** Counted per page; the finding says how many images on how many pages. |
| `content.soft_404` | Soft 404s | error | page | crawl | server | "Pages that say not found but answer 200" |
| `content.near_duplicate` | Same page twice | warning | page | crawl | redirect | "Pages that are the same page twice" |
| `content.thin` | Thin pages | warning | page | crawl | content | **New.** Detail pages (not home or page family) with under 150 words of main text and not empty shells. Also `ai`. |
| `content.thin_records` | Record pages with almost no content | warning | page | inventory | content | "N {entity} pages have almost no content" |
| `schema.missing` | No structured data | warning | page | crawl, sample | schema | "Detail pages have no structured data", "Detail pages missing JSON-LD in crawler HTML". Also `ai`. |
| `schema.invalid` | Structured data fails to parse | warning | page | crawl | schema | "Structured data that fails to parse". Also `ai`. |
| `links.broken_internal` | Broken internal links | error | page | crawl | links | **New.** `page_links` joined to the crawl: targets whose row is `failed` or `status >= 400`. Reported per source page; evidence lists the top broken targets with how many pages link to each. |
| `links.orphan` | Orphan pages | warning | page | crawl | links | **New.** Sitemap URLs (not the homepage) with no `page_links` row targeting their path, in crawls where links were recorded. |
| `links.single_inbound` | One incoming link | notice | page | crawl | links | **New.** |
| `links.depth` | More than three clicks deep | notice | page | crawl | links | **New.** Recursive CTE over `page_links` from the homepage, six levels at most. `ponytail:` skipped with a note when the site has over 200,000 link rows; a BFS in a step replaces it if that is ever hit. |
| `links.gap` | Sites linking to competitors, not you | notice | site | connector | none | "Earn links from the N sites …" (it is also an opportunity) |
| `url.year_in_slug` | Year in the URL | notice | page | crawl | redirect | **New.** `/20\d\d/` or `-20\d\d` in the path of an article-like page: such URLs lose AI citations fastest when the year passes (Greenflag, 2026). Also `ai`. |
| `repo.client_rendered` | Template renders on the client | warning | family | repo | server | "… don't render on the server". Also `ai`. |
| `repo.client_fetch` | Template fetches content in the browser | warning | family | repo | server | "… fetch their content in the browser". Also `ai`. |
| `repo.sequential_awaits` | Sequential data requests | notice | family | repo | server | "… wait for N data requests" |
| `repo.soft_200` | Soft-200 responses | warning | site | repo | server | "Soft-200 responses risk indexing junk URLs" |
| `repo.sitemap_unpaged` | Sitemap from one unpaged query | warning | site | repo | sitemap | "The sitemap is built from one query with no paging" |
| `search.low_ctr` | Page-one results searchers skip | notice | page | search | meta | "Pages on page one that searchers skip" |
| `search.market_mismatch` | Visibility outside the target market | notice | site | search | content | "Most search visibility comes from outside your target market" |
| `search.navigational` | Traffic is mostly name lookups | notice | site | search | content | "Search traffic is mostly people looking up a … by name" |
| `search.cannibalisation` | Pages compete for the same searches | notice | page | search | links | "Several pages compete for the same searches" |
| `trend.impressions_fell` | Impressions fell | notice | site | connector | none | "Search impressions fell N% since …" |
| `trend.index_coverage` | Indexed share | notice | site | connector | none | "Google has indexed N of the N URLs it knows" |
| `trend.googlebot_pace` | Googlebot pace | notice | site | connector | none | "Googlebot hasn't …" |
| `index.gone_urls` | Old URLs Google still crawls | warning | page | connector | redirect | "N old URLs Google still crawls return 404; N match a live page" |
| `index.noindex_recovered` | Excluded URLs now indexable | notice | page | connector | sitemap | "N URLs Google excluded as noindex are indexable now" |
| `crawl.budget_parameters` | Googlebot on parameter URLs | notice | site | connector | robots | "N% of Googlebot …" (parameters) |
| `crawl.budget_wasted` | Googlebot on errors and redirects | notice | site | connector | server | "N% of Googlebot …" (wasted) |

### AI visibility pillar

Checks tagged "Also `ai`" above belong to both pillars. The checks below are `ai` only.

| Id | Name | Class | Scope | Source | Fix | Note |
|---|---|---|---|---|---|---|
| `robots.ai_blocked` | robots.txt blocks AI crawlers | notice | site | crawl | robots | "robots.txt blocks AI assistants from reading the site" / "… AI training crawlers" (INFORMATIONAL). Deliberate blocking is legitimate and never costs score. |
| `ai.crawler_refused` | Firewall refuses AI search crawlers | error | site | probe | server | **New.** robots.txt allows the agent, but the fetch is refused or challenged (§6). The error is the misconfiguration, not the choice. |
| `ai.snippet_blocked` | Snippets blocked | error | page | crawl | meta | **New.** `nosnippet` or `max-snippet:0` on an indexable page. Google: these are the controls that exclude a page from AI Overviews and AI Mode. |
| `ai.stale` | Stale articles | warning | page | crawl | content | **New.** Article-like pages whose `modified` is over 365 days old. Seer: 75% of AI-cited pages were updated within 12 months. Threshold in `AI_FRESHNESS`. |
| `ai.no_date` | Articles without a date | notice | page | crawl | content | **New.** Article-like pages with no date anywhere. Assistants and users cannot judge freshness. |
| `ai.no_answer_structure` | No answer structure | warning | page | crawl | content | **New.** Detail and article-like pages with no question heading, no list or table, and a lead paragraph over 120 words. Q&A format, section structure and a summary up front each raised citation rates 20 to 30% (Semrush 2025, 337k URLs; Princeton GEO 2024). |
| `ai.low_evidence` | No statistics, quotes or sources | notice | page | crawl | content | **New.** Article-like pages with 0 statistics, 0 quotes and 0 outbound citations. Statistics +33%, quotations +41%, cited sources +28% (Princeton GEO). A heuristic, so a notice. |
| `ai.no_author` | No author | notice | page | crawl | schema | **New.** Article-like pages without an author signal. E-E-A-T signals +30% (Semrush 2025). |
| `ai.no_entity_schema` | No organisation schema | warning | site | crawl | schema | **New.** The homepage has no Organization, LocalBusiness or Person JSON-LD with `sameAs`. Entity disambiguation is how assistants tell the business from namesakes. |
| `ai.semantic_html_missing` | No semantic landmarks | notice | page | crawl | content | **New.** No `<main>` or `<article>`. |
| `ai.llms_txt` | llms.txt | notice, unscored | site | crawl | content | **New.** Reported as present or absent. The docs say: no AI engine has confirmed reading it, Google says it neither helps nor harms, 97% of llms.txt files saw no bot traffic (Ahrefs, May 2026). Semrush and Lighthouse check it, so Eumon reports it, and never scores it. |
| `ai.llms_txt_format` | llms.txt format | notice, unscored | site | crawl | content | **New.** Present but not Markdown with an H1 (llmstxt.org). |

`faqPages` in `AiReadiness` stays a fact on the AI tab labelled "Q&A markup" with the note that Google removed FAQ rich results in May 2026; it is not a check.

### Conversion and data (no pillar)

`conversion.no_tracking`, `conversion.no_cta`, `conversion.no_contact`, `data.duplicates`, `data.missing_field` keep their findings and appear on their tabs; they have `pillars: []` and never touch a score.

## 4. Health scores

```ts
/** Share of indexable crawled pages with no error-class issue in the pillar, 0–100 with one decimal. */
export function healthScore(input: { indexable: number; unhealthy: number; siteErrors: number }): number | null
```

- **Denominator:** indexable pages = crawled sitemap URLs the site intends to be indexed: not `noindex`, not canonicalising elsewhere, not redirected. Pages the site excludes on purpose do not count either way. Pages that answer an error stay in the denominator and count as unhealthy.
- **Unhealthy:** a page with at least one error-class page issue of the pillar (`CRAWL_ISSUES` conditions OR-ed per pillar in one `SUM(CASE …)` each, added to the `getCrawlCoverage` query, so a page with three errors counts once). Empty shells and HTTP errors are error-class, so they count.
- **Site-scope errors:** any error-class `site` finding of the pillar makes the score 0 and the tile says why ("robots.txt blocks Googlebot"). For `ai`, `ai.crawler_refused` zeroes the score only when every search-facing crawler probed was refused; otherwise the tile shows "N of M AI crawlers can read the site" beside the page score.
- **Null** when there is no finished full crawl, so a tile never shows a number it cannot stand behind.
- Severity still ranks findings for the growth plan; class only decides the score. The docs state this in one paragraph, with the reason: a single page-level warning on 10,000 pages is urgent for the plan but does not make the site unhealthy.

**Ledger** (`METRICS.analysis`): `health_seo`, `health_ai`, `health_pages` (the denominator), `health_unhealthy_seo`, `health_unhealthy_ai`, written by `analysisHealthPoints` beside `site_health`, which stays for the Results view as it is. **Report:** `report.audit = { seo: Score, ai: Score, checks: AuditRow[] }` where `Score = { value: number | null; indexable: number; unhealthy: number; reason?: string }` and `AuditRow = { id, status: "passed" | "failed" | "skipped", pages?: number, reason?: string }`, one row per registered check: failed when a finding with that `checkId` exists, skipped when `requires` is not met (the reason is the `requires` text) or the source did not run, passed otherwise. Old reports have no `audit`; the UI shows "Run an analysis to score the site".

## 5. Dashboard and History

- **Overview:** two tiles, "SEO health" and "AI visibility health", value, 28-day change from the ledger, and the count line "71 checks · 58 passed · 9 failed · 4 not run". Each tile opens its tab.
- **Technical tab** (seo) and **AI visibility tab** (ai): a **Checks** card above the findings: one row per check in the pillar, grouped error / warning / notice, with status, page count (linking to the finding) or the skip reason. A passed row shows the check's `what` on hover. The existing finding cards gain the check name as a label and keep title, summary, evidence and "Next step".
- `findingArea` keeps mapping categories to tabs. Pillar comes from `CHECKS[checkId].pillars`, else from category for old reports (`ai_visibility` → ai; `conversion` → none; everything else → seo).
- **History:** `keyOf(finding) = checkId ? \`${checkId}|${scopeKey ?? ""}\` : findingKey(finding)`. When a run saves its key list and the previous list has legacy keys, each legacy row that matches a current finding's `findingKey` is written under the finding's new key, so nothing shows as resolved because the key format changed. The History tab labels resolutions by check name.
- **Ask Eumon** reads `report.audit` like any other report field; the assistant prompt lists failed checks by name.

## 6. The AI crawler probe (analysis step)

A new workflow step `probe-ai-crawlers`, after the crawl and before `runFullAnalysis`: for the homepage plus one served URL per route family (five families at most, six URLs), fetch as each of `OAI-SearchBot`, `ChatGPT-User`, `PerplexityBot`, `Claude-SearchBot`, `Claude-User`, `GPTBot`, `ClaudeBot`: 42 fetches at most, concurrency 6. `AI_AGENTS` holds tokens, not user-agent strings, so `packages/core/src/ai-agents.ts` gains `AI_PROBE_AGENTS`: the seven tokens with the full user-agent string each vendor documents, and their search/training kind. Each result is `{ agent, url, status, challenge }` using `isBotChallenge`. The probe runs only for agents robots.txt allows for that path; blocked ones are the existing `robots.ai_blocked` finding. The report stores `aiReadiness.probe: Array<{ agent, allowedByRobots, fetched, refused: number, of: number }>`.

`ai.crawler_refused` fires when a search-facing agent that robots.txt allows was refused or challenged on every probed URL (a single refused URL is rate limiting, not policy). Summary names the agents and the status, and when `cf-mitigated` or a Cloudflare challenge page was seen, says "Cloudflare's AI crawler setting is blocking it". Recommendation: allow the search-facing agents in the firewall or Cloudflare's AI Crawl Control, keep blocking training agents if that is the intent.

`server.www_duplicate`, `server.http_not_redirected` and `ai.llms_txt` run in the same step (three fetches). The step makes 47 fetches at most (robots.txt, 42 agent fetches, 4 host fetches), under the Free plan's 50 subrequests per step. When robots.txt was unreadable the probe does not run and `ai.crawler_refused` is skipped with that reason.

## 7. Checks Eumon does not run, and why

Listed on the docs page and in `packages/core/src/checks/not-run.ts` so the list is reviewed with the code:

- **Text-to-HTML ratio, too many URL parameters, underscores in URLs, URL length, encoding and doctype declarations, frames and plugins, AMP:** no measurable effect on ranking or citation in 2026; modern frameworks fail the ratio check by design.
- **Uncompressed, unminified or uncached JavaScript and CSS, large HTML, too many files:** real-user speed from CrUX and the lab score from PageSpeed already measure what these approximate.
- **TLS version, certificate name and expiry, SNI:** not observable from Workers `fetch`; browsers and Search Console report them.
- **Readability and spelling:** language dependent; the sites Eumon serves write in Malay, Indonesian, Chinese and English.
- **FAQPage and HowTo markup as issues:** Google removed those rich results (HowTo 2023, FAQ May 2026). Q&A structure is checked as content (`ai.no_answer_structure`), not as markup.
- **llms.txt as a scored check:** reported, never scored (see `ai.llms_txt`).
- **Anchor text quality, nofollow on internal links:** needs anchor text and `rel` stored per link; a later crawler addition.

## 8. Docs

`docs/site/pages/checks.html` is **generated**: `docs/site/build.mjs` imports `packages/core/dist/checks/index.js` (so `npm run build -w @organic-growth/core` runs first; a missing dist fails the docs build with a message, like the missing codebase map) and renders, per pillar then category, a table (check, class, scope, source, fix kind, requires) followed by a `dl` with what, why, how and severity for each check, then the "Not run" list. The page starts from `pages/checks.head.html` (lede and the one paragraph on class versus severity). The findings page loses its hand-written catalogue and links to Checks; its pipeline-mechanics sections stay. A registry entry whose docs fail the invariants fails `build.mjs` with the id.

## 9. Demo

The demo site gains, through its generator and fake fetcher, one of each new failure: a redirect chain, a mixed-content image, a page with `max-snippet:0`, an orphan treatment page, a broken internal link, an article from 2024 without an author, a blog slug with `-2024`, no HSTS header, and a fake firewall that challenges `PerplexityBot` while robots.txt allows it. The demo analysis therefore shows every new check at least once, and both health tiles with non-trivial values.

## 10. Testing

- **core:** registry invariants; `finding()` fills category, checkId, recommendation default and severity override; `healthScore` (no indexable pages → null; site error → 0; 97 of 100 → 97.0); `keyOf` with and without checkId; freshness date parsing (JSON-LD, meta, `<time>`, none); question-heading detection in en/ms/id/zh; statistics and quote counting; `snippetBlocked` from meta and header.
- **crawler:** `parseHtmlSignals` fixtures for every new field; `defaultFetcher` reports `hops`; the probe with a fake fetcher (allowed, refused on all URLs, refused on one URL, Cloudflare challenge); robots-blocked agents are not fetched.
- **db:** `getCrawlCoverage` counts every new issue and the two unhealthy sums on sqlite fixtures; orphan, broken-link and depth queries; legacy key upgrade in the key list.
- **agents:** every finding the pipeline produces has a `checkId` in `CHECKS` (the test fails on a new finding that bypasses the registry); the audit table has one row per check with the right status for a fixture report; conversion findings have no pillar.
- **web:** `analysisHealthPoints` writes the five health metrics; the Overview tiles render null, zero-with-reason and a value; the Checks card groups and links.
- **docs:** `node docs/site/build.mjs` passes and the Checks page lists every registry id; a test registry entry with an empty `why` makes the build fail.
- **demo:** the latest demo analysis carries every new check as failed at least once and both scores.

## 11. Budget and limits

No new tables or migrations. Per-page fields add roughly 150 bytes to `result_json`. The coverage query stays one statement; the three link queries and the probe step are new; the analysis stays under 50 D1 queries per request and 50 subrequests per step. Reused crawl results from before this spec lack the new fields: the SQL conditions treat an absent field as "not checked" (`IS NOT NULL` guards, as `missingDescription` does with `h1Count`), the audit table marks those checks skipped with "run a full crawl once after deploying", and the user runs one full crawl.
