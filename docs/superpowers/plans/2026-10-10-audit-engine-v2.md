# Audit Engine v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every audit check is one declared registry entry; the existing ~60 findings and 34 new ones are produced through it; two health scores (SEO, AI visibility) and an audit table come out of every report; the Checks docs page is generated from the registry.

**Architecture:** `packages/core/src/checks/` holds the registry (`CHECKS`), the `finding()` builder and `healthScore()`. Producers in `packages/crawler` and `packages/agents` call `finding(CHECKS.x, …)` instead of building `Finding` literals. Page-level checks are flags the crawler stores in `pages.result_json`; `getCrawlCoverage` counts them in SQL and the two "unhealthy" sums with them. A new workflow step probes AI crawlers and the host. `runFullAnalysis` adds `report.audit`. The docs build imports the built registry and renders `checks.html`.

**Tech Stack:** TypeScript (ESM, `node --test`), Cloudflare Workers + Workflows + D1 (SQLite in tests via `openSqliteD1`), React (vinext), plain Node for the docs build.

**Spec:** `docs/superpowers/specs/2026-10-10-audit-engine-v2-design.md`

## Global Constraints

- No new tables or migrations. New per-page facts go into `pages.result_json`; absent means "not checked", and SQL conditions guard with `IS NOT NULL`.
- The Free plan: at most 50 D1 queries per request and 50 subrequests per Workflow step. `getCrawlCoverage` stays one counting query plus eight-example queries; the probe step makes at most 45 fetches.
- Check ids match `^[a-z]+(\.[a-z0-9_]+)+$`, are never renamed, and every registry entry has non-empty `what`, `why`, `how`, `severity` docs.
- Titles, summaries, evidence and severity arithmetic of existing findings do not change (the dashboard reads the same). Only `checkId`, `scopeKey` and a default `recommendation` are added.
- llms.txt is reported and never scored. Blocking AI crawlers in robots.txt is INFORMATIONAL and never scored. Conversion and data checks have `pillars: []`.
- Thresholds live in named constants beside their reason: `TITLE_LENGTH = { min: 30, max: 60 }`, `DESCRIPTION_MAX = 160`, `THIN_WORDS = 150`, `AI_FRESHNESS_DAYS = 365`, `LINK_DEPTH = 3`, `LEAD_WORDS_MAX = 120`.
- Docs wording: "users", never "operator"; any-size businesses; never name a client site in docs or demo data.
- Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A report saved before this change (no `checkId`, no `audit`): the dashboard must render it, History must still diff it, the Overview tiles must say "Run an analysis to score the site". Pinned in Task 3 (legacy keys) and Task 9 (null report).
2. A full crawl reusing rows from before the new fields existed: every new SQL condition must treat an absent field as not checked, never as failed, and the audit table must mark those checks skipped. Pinned in Task 5.
3. robots.txt unreadable (bot challenge on `/robots.txt`): the probe must not run, `ai.crawler_refused` must be skipped with that reason, and the AI score must not be null because of it. Pinned in Task 7.
4. A one-page site or a site with zero indexable pages: `healthScore` returns null, never divides by zero, never shows 100. Pinned in Task 8.
5. `page_links` with hundreds of thousands of rows: the depth query must bail out with a note instead of timing out. Pinned in Task 5.

---

### Task 1: The registry, `finding()` and the existing checks

**Files:**
- Create: `packages/core/src/checks/types.ts`, `packages/core/src/checks/index.ts`, `packages/core/src/checks/catalog.ts`, `packages/core/src/checks/not-run.ts`, `packages/core/src/checks/thresholds.ts`
- Create: `packages/core/src/checks/checks.test.ts`
- Modify: `packages/core/src/types.ts:96-109` (Finding gains `checkId?`, `scopeKey?`; `FindingCategory` gains `"security"`), `packages/core/src/index.ts` (export)

**Interfaces:**
- Produces: `CHECKS: Record<string, Check>`, `checkList(): Check[]`, `finding(check, input): Finding`, `NOT_RUN: Array<{ name: string; why: string }>`, `TITLE_LENGTH`, `DESCRIPTION_MAX`, `THIN_WORDS`, `AI_FRESHNESS_DAYS`, `LEAD_WORDS_MAX`, `LINK_DEPTH`, types `Check`, `Pillar`, `CheckClass`, `CheckScope`, `CheckSource`, `FixKind`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/checks/checks.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS, checkList, finding, NOT_RUN } from "./index.js";

describe("check registry", () => {
  it("has well-formed, unique, documented entries", () => {
    const ids = new Set<string>();
    for (const check of checkList()) {
      assert.match(check.id, /^[a-z]+(\.[a-z0-9_]+)+$/, check.id);
      assert.ok(!ids.has(check.id), `duplicate id ${check.id}`);
      ids.add(check.id);
      assert.equal(CHECKS[check.id], check);
      for (const field of ["what", "why", "how", "severity"] as const) assert.ok(check.docs[field].trim().length > 20, `${check.id}.docs.${field}`);
      assert.ok(check.name.length > 2 && check.name.length < 48, `${check.id}.name`);
      if (check.category !== "conversion" && !check.id.startsWith("data.")) assert.ok(check.pillars.length > 0, `${check.id} needs a pillar`);
      if (check.scope === "page") assert.ok(check.sources.some((s) => s === "crawl" || s === "sample" || s === "render" || s === "connector" || s === "search" || s === "inventory"), check.id);
      if (check.docs.unscored) assert.equal(check.class, "notice", `${check.id} unscored checks are notices`);
    }
    assert.ok(ids.size >= 55, `${ids.size} checks registered`); // Task 6 makes this === 89
  });

  it("lists checks that are deliberately not run, each with a reason", () => {
    assert.ok(NOT_RUN.length >= 7);
    for (const entry of NOT_RUN) assert.ok(entry.why.length > 20, entry.name);
  });
});

describe("finding()", () => {
  const base = { siteId: "s", analysisId: "a", title: "T", summary: "S", evidence: {}, impact: 72 };

  it("fills category, checkId, severity from impact, and the docs' fix as the default recommendation", () => {
    const result = finding(CHECKS["title.weak"]!, base);
    assert.equal(result.category, "metadata");
    assert.equal(result.checkId, "title.weak");
    assert.equal(result.severity, "HIGH");
    assert.equal(result.organicImpactScore, 72);
    assert.equal(result.recommendation, CHECKS["title.weak"]!.docs.how);
    assert.deepEqual(result.pagesAffected, []);
    assert.match(result.id, /^finding_/);
  });

  it("keeps a producer's own recommendation, severity override and scope key", () => {
    const result = finding(CHECKS["server.slow"]!, { ...base, recommendation: "Cache /doctors/.", severity: "CRITICAL", scopeKey: "doctors", pagesAffected: ["https://x.com/doctors/a"] });
    assert.equal(result.recommendation, "Cache /doctors/.");
    assert.equal(result.severity, "CRITICAL");
    assert.equal(result.scopeKey, "doctors");
    assert.deepEqual(result.pagesAffected, ["https://x.com/doctors/a"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @organic-growth/core`
Expected: compile error, `./index.js` under `checks/` does not exist.

- [ ] **Step 3: Write the types**

`packages/core/src/checks/types.ts`:

```ts
import type { FindingCategory } from "../types.js";

export type Pillar = "seo" | "ai";
/** Whether a failed instance makes a page unhealthy for the health score. Severity, which ranks the growth plan, is decided per instance by the producer. */
export type CheckClass = "error" | "warning" | "notice";
export type CheckScope = "page" | "family" | "site";
export type CheckSource = "crawl" | "sample" | "render" | "probe" | "repo" | "search" | "connector" | "inventory";
/** What a fix changes; the fix engine and the plan backlog read it. */
export type FixKind = "meta" | "content" | "schema" | "robots" | "redirect" | "links" | "server" | "sitemap" | "none";

export type Check = {
  /** Stable, lower-case, dotted. Never renamed. */
  id: string;
  /** Short name for tables and docs. */
  name: string;
  /** Empty for conversion and data checks: shown, never scored. */
  pillars: Pillar[];
  category: FindingCategory;
  class: CheckClass;
  scope: CheckScope;
  sources: CheckSource[];
  fix: FixKind;
  /** What the check needs that a site may not have, shown as the skip reason in the audit table. */
  requires?: string;
  /** The `CrawlIssue` key that counts it in `getCrawlCoverage`, for per-page crawl checks; the audit table reads its page count there. */
  issue?: string;
  docs: {
    what: string;
    why: string;
    how: string;
    /** How the instance's severity is decided, in words. */
    severity: string;
    /** The docs say it is reported but never scored (llms.txt). */
    unscored?: boolean;
  };
};
```

- [ ] **Step 4: Write the builder and the index**

`packages/core/src/checks/index.ts`:

```ts
import { createId } from "../ids.js";
import { severityFromImpact } from "../severity.js";
import type { Finding, Severity } from "../types.js";
import { CATALOG } from "./catalog.js";
import type { Check } from "./types.js";

export * from "./types.js";
export * from "./thresholds.js";
export { NOT_RUN } from "./not-run.js";

/** Every check by id. */
export const CHECKS: Record<string, Check> = Object.fromEntries(CATALOG.map((check) => [check.id, check]));

export function checkList(): Check[] {
  return CATALOG;
}

export type FindingInput = {
  siteId: string;
  analysisId: string;
  title: string;
  summary: string;
  evidence: Finding["evidence"];
  /** 0–100; severity follows it unless `severity` is given. */
  impact: number;
  severity?: Severity;
  recommendation?: string;
  pagesAffected?: string[];
  /** Distinguishes several findings from one check: the family, query or entity type. */
  scopeKey?: string;
  createdAt?: string;
};

/** A finding for a registered check: category and checkId from the check, recommendation from its docs unless the producer has a specific one. */
export function finding(check: Check, input: FindingInput): Finding {
  return {
    id: createId("finding"),
    siteId: input.siteId,
    analysisId: input.analysisId,
    category: check.category,
    checkId: check.id,
    ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
    severity: input.severity ?? severityFromImpact(input.impact),
    title: input.title,
    summary: input.summary,
    evidence: input.evidence,
    organicImpactScore: input.impact,
    recommendation: input.recommendation ?? check.docs.how,
    pagesAffected: input.pagesAffected ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
```

`packages/core/src/checks/not-run.ts`:

```ts
/** Checks other tools run that Eumon does not, with the reason. Rendered on the Checks docs page. */
export const NOT_RUN: Array<{ name: string; why: string }> = [
  { name: "Text-to-HTML ratio, URL parameters, underscores in URLs, URL length, encoding and doctype, frames and plugins, AMP", why: "No measurable effect on ranking or AI citation in 2026; modern frameworks fail the ratio check by design." },
  { name: "Uncompressed, unminified or uncached JavaScript and CSS, large HTML, too many files", why: "Real-user speed from the Chrome UX Report and the lab score from PageSpeed measure what these approximate." },
  { name: "TLS version, certificate name and expiry, SNI", why: "Not observable from a Workers fetch; browsers and Search Console report them." },
  { name: "Readability and spelling", why: "Language dependent; sites write in Malay, Indonesian, Chinese and English." },
  { name: "FAQPage and HowTo markup as issues", why: "Google removed those rich results (HowTo in 2023, FAQ in May 2026). Question-and-answer structure is checked as content, not markup." },
  { name: "llms.txt as a scored check", why: "No AI engine has confirmed reading it and Google says it neither helps nor harms. It is reported, never scored." },
  { name: "Anchor text quality, nofollow on internal links", why: "Needs anchor text and rel stored per link; a later crawler addition." },
];
```

- [ ] **Step 5: Write the thresholds**

`packages/core/src/checks/thresholds.ts` (the db SQL and the findings both read these):

```ts
/** Google shows about 600 px of title, roughly 60 characters; under 30 wastes the space. */
export const TITLE_LENGTH = { min: 30, max: 60 };
/** Google cuts descriptions at about 160 characters. */
export const DESCRIPTION_MAX = 160;
/** Under this many words of main content a detail page has too little to rank or be cited. */
export const THIN_WORDS = 150;
/** 75% of pages cited in AI answers were updated within 12 months (Seer, 2026). */
export const AI_FRESHNESS_DAYS = 365;
/** A lead paragraph longer than this is not a summary an assistant can lift. */
export const LEAD_WORDS_MAX = 120;
/** Pages more than this many clicks from the homepage are crawled last and least. */
export const LINK_DEPTH = 3;
```

- [ ] **Step 6: Write the catalogue for the existing checks**

`packages/core/src/checks/catalog.ts`. One entry per row of spec §3 that is not marked New. Write each with the four docs texts; the docs are the product's own words, so write them for a developer who has never seen the site. The complete file is long; the shape, and the first entries, are:

```ts
import type { Check } from "./types.js";

const c = (check: Check): Check => check;

export const CATALOG: Check[] = [
  c({ id: "robots.googlebot_blocked", name: "Googlebot blocked site-wide", pillars: ["seo"], category: "indexing", class: "error", scope: "site", sources: ["crawl"], fix: "robots",
    docs: {
      what: "robots.txt, read as Googlebot reads it, disallows the homepage and everything below it.",
      why: "Google cannot fetch any page, so nothing new is indexed and existing rankings decay as pages are re-crawled and fail.",
      how: "Remove the site-wide Disallow from the group that applies to Googlebot (its own group, or User-agent: *) and keep only intentional private path blocks.",
      severity: "Always CRITICAL: the whole site is affected.",
    } }),
  c({ id: "robots.foreign_sitemap", name: "Sitemap on another domain", pillars: ["seo"], category: "sitemap", class: "error", scope: "site", sources: ["crawl"], fix: "robots",
    docs: {
      what: "robots.txt names a sitemap on a different host than the site.",
      why: "Search engines discover pages through the sitemap robots.txt declares; a foreign or stale sitemap (an agency's staging domain, often) hides the site's real pages.",
      how: "Replace the Sitemap line with this site's own sitemap URL and submit it in Search Console.",
      severity: "The impact formula with every sitemap URL affected; crawl-blocking when the site declares no sitemap of its own.",
    } }),
  // … every other existing check from spec §3, in table order:
  // access.bot_challenge, access.googlebot_refused, server.soft_404_probe, server.intermittent, server.slow,
  // http.error, fetch.failed, sitemap.redirects, sitemap.noindex, sitemap.blocked,
  // render.empty_shell (pillars seo+ai), render.empty_after_js, render.googlebot_less (seo+ai), render.prerender_mismatch, render.meta_by_js (seo+ai), render.coverage_weak,
  // title.weak, title.duplicate, description.missing, heading.h1_missing (seo+ai), heading.h1_multiple, canonical.mismatch (notice), hreflang.missing (requires "two or more languages"),
  // content.soft_404, content.near_duplicate, content.thin_records, schema.missing (seo+ai), schema.invalid (seo+ai),
  // links.gap, repo.client_rendered (seo+ai), repo.client_fetch (seo+ai), repo.sequential_awaits, repo.soft_200, repo.sitemap_unpaged,
  // search.low_ctr, search.market_mismatch, search.navigational, search.cannibalisation,
  // trend.impressions_fell, trend.index_coverage, trend.googlebot_pace, index.gone_urls, index.noindex_recovered, crawl.budget_parameters, crawl.budget_wasted,
  // render.js_content (warning, page, render, server, pillars seo+ai: "Page content only appears after JavaScript runs" / "Part of the page content is added by JavaScript"),
  // indexing.homepage_noindex (error, site: "The homepage is marked noindex"),
  // robots.ai_blocked (pillars ["ai"], category ai_visibility, notice, site),
  // conversion.no_tracking, conversion.no_cta (family), conversion.no_contact (pillars []),
  // data.duplicates, data.missing_field (pillars [], category content, scope site, sources ["inventory"]).
];
```

The pillars, class, scope, sources, fix and `requires` for each come from the spec table, with three changes the score needs: `http.error` and `access.bot_challenge` get pillars `["seo", "ai"]` (a page that errors cannot be cited either), and `access.bot_challenge` gets scope `page`. **`category` is the category the producer uses today**: read each finding literal and copy it, because the dashboard tab and History keys depend on it; Task 2's test fails on a mismatch. Set `issue` on the page checks coverage counts: `sitemap.noindex` "noindex", `sitemap.blocked` "robotsBlocked", `sitemap.redirects` "redirected", `heading.h1_missing` "missingH1", `heading.h1_multiple` "multipleH1", `description.missing` "missingDescription", `schema.missing` "missingStructuredData", `schema.invalid` "invalidStructuredData", `title.duplicate` "duplicateTitle", `canonical.mismatch` "canonicalMismatch", `content.soft_404` "softNotFound", `content.near_duplicate` "nearDuplicate", `access.bot_challenge` "botChallenge", `access.googlebot_refused` "botFallback". That makes 55 entries. `requires` values: `hreflang.missing` "two or more languages"; `repo.*` "a connected repository"; `search.*` "Search Console"; `trend.impressions_fell`, `index.*` "Search Console"; `trend.googlebot_pace`, `crawl.budget_*` "server logs"; `links.gap` "DataForSEO"; `content.thin_records`, `data.*` "a dataset"; `render.*` with source `render` "a browser render (one page per template)".

- [ ] **Step 7: Extend the Finding type and export the registry**

In `packages/core/src/types.ts` add `| "security"` to `FindingCategory`, and in `Finding` after `category`:

```ts
  /** The registry check that produced it; reports from before the registry have none. */
  checkId?: string;
  /** Distinguishes several findings from one check: the family, query or entity type. */
  scopeKey?: string;
```

In `packages/core/src/index.ts` add `export * from "./checks/index.js";`.

- [ ] **Step 8: Run the tests**

Run: `npm run test -w @organic-growth/core`
Expected: PASS with 55 checks registered.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/checks packages/core/src/types.ts packages/core/src/index.ts
git commit -m "Check registry: types, finding() builder, catalogue of today's checks, not-run list"
```

---

### Task 2: Produce every existing finding through the registry

**Files:**
- Modify: `packages/crawler/src/tech-seo.ts` (14 literals), `packages/crawler/src/coverage-findings.ts:300-361` (the `drafts.map` at the end), `packages/crawler/src/index.ts:627-760` (`findingsFromCrawl`, 8 literals), `packages/crawler/src/rendering.ts` (1), `packages/agents/src/code-findings.ts` (1), `packages/agents/src/conversion.ts` (4), `packages/agents/src/search.ts` (1), `packages/agents/src/connector-findings.ts` (3), `packages/agents/src/not-found-probe.ts` (1), `packages/agents/src/pipeline.ts:198-212` (the "Failed to fetch" literal)
- Test: `packages/agents/src/pipeline.test.ts`

**Interfaces:**
- Consumes: `finding`, `CHECKS` from `@organic-growth/core`.
- Produces: every `Finding` the pipeline returns has `checkId` in `CHECKS`.

- [ ] **Step 1: Write the failing test**

Add to `packages/agents/src/pipeline.test.ts` (it already runs `runFullAnalysis` with a fake fetcher; reuse that setup):

```ts
it("produces every finding through a registered check", async () => {
  // pipeline.test.ts has no runFullAnalysis fixture yet. Add `fixtureSite(): Fetcher` at the top of the file:
  // robots.txt allowing all with a Sitemap line, a sitemap of three URLs, a homepage with a title, an H1 and
  // Organization JSON-LD, `/doctors/a` as an empty shell (`<div id="root"></div>`), `/doctors/b` without an H1.
  // Tasks 7 and 8 reuse it.
  const report = await runFullAnalysis({ analysisId: "a", siteId: "s", name: "Clinic", baseUrl: "https://clinic.example", fetcher: fixtureSite(), repeatability: false, maxPages: 5 });
  const { CHECKS } = await import("@organic-growth/core");
  for (const f of report.findings) {
    assert.ok(f.checkId && CHECKS[f.checkId], `finding "${f.title}" has no registered checkId`);
    assert.equal(f.category, CHECKS[f.checkId!]!.category, f.title);
    assert.ok(f.recommendation, `${f.title} has no recommendation`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:packages && npm run test -w @organic-growth/agents`
Expected: FAIL, "has no registered checkId".

- [ ] **Step 3: Migrate `coverage-findings.ts`**

Add `checkId` to `Draft` (`checkId: string;`) and set it on every draft using the spec ids (`render.empty_shell`, `indexing.homepage_noindex`, `sitemap.noindex`, `sitemap.blocked`, `sitemap.redirects`, `http.error`, `title.weak`, `title.duplicate`, `description.missing`, `heading.h1_missing`, `heading.h1_multiple`, `schema.missing`, `schema.invalid`, `access.bot_challenge`, `access.googlebot_refused`, `content.soft_404`, `content.near_duplicate`, `render.coverage_weak`). Replace the final map with:

```ts
  return drafts.map((draft) => finding(CHECKS[draft.checkId]!, {
    siteId: input.siteId, analysisId: input.analysisId, title: draft.title, summary: draft.summary, evidence: draft.evidence,
    impact: draft.impact, recommendation: draft.recommendation, pagesAffected: draft.pagesAffected ?? [], createdAt,
  }));
```

Keep the `split` map for "By language" as it is (it keys on titles, which do not change).

- [ ] **Step 4: Migrate `tech-seo.ts`**

Each `findings.push({ id: createId("finding"), siteId, analysisId, category, severity, title, summary, evidence, organicImpactScore, recommendation, pagesAffected, createdAt })` becomes:

```ts
findings.push(finding(CHECKS["canonical.mismatch"]!, {
  siteId, analysisId, impact,
  title: "Canonical mismatches detected",
  summary: `${canonicalMismatches.length} sampled pages have canonical URLs that do not match the fetched URL.`,
  evidence: { examples: canonicalMismatches.slice(0, 10).map((p) => ({ url: p.url, canonical: p.canonical })) },
  recommendation: "Align canonical tags with the preferred indexable URL for each page.",
  pagesAffected: canonicalMismatches.map((p) => p.url),
}));
```

Ids in file order: `canonical.mismatch`, `hreflang.missing`, `title.weak` (impact `Math.min(impact, 45)`), `robots.googlebot_blocked` (`severity: "CRITICAL"`), `robots.ai_blocked` (`severity: "INFORMATIONAL"`, `impact: 10`), `robots.foreign_sitemap`, `description.missing` (impact `Math.min(impact, 30)`). Remove the now-unused `createId` and `severityFromImpact` imports where nothing else uses them.

- [ ] **Step 5: Migrate the rest the same way**

- `packages/crawler/src/index.ts` `findingsFromCrawl`: `render.empty_shell`, `repo.soft_200` for "Soft-200 responses risk indexing junk URLs" (keep the title), then in order of the file: `sitemap.blocked`, `title.weak` ("Sitemap URLs are missing useful title tags"), `http.error`, `sitemap.noindex`, `schema.missing` ("Detail pages missing JSON-LD in crawler HTML"), `sitemap.redirects`. Read each literal's title and match it to the spec table.
- `packages/crawler/src/rendering.ts`: the builder at the end of the file covers eight titles; add `checkId` to each draft: "Page content only appears after JavaScript runs" and "Part of the page content is added by JavaScript" → `render.js_content`, "Pages stay empty even after JavaScript runs" → `render.empty_after_js`, "Googlebot receives less content than browsers" → `render.googlebot_less`, "Crawlers get pre-rendered HTML that browsers don't" → `render.prerender_mismatch`, "Titles and meta tags are set by JavaScript" → `render.meta_by_js`, "Intermittent empty or failed responses on …" → `server.intermittent` with `scopeKey: family`, "Slow responses on …" → `server.slow` with `scopeKey: family`.
- `packages/agents/src/code-findings.ts`: `repo.client_rendered`, `repo.client_fetch`, `repo.sequential_awaits`, `repo.sitemap_unpaged`, each with `scopeKey: family` where the title names one.
- `packages/agents/src/conversion.ts`: `conversion.no_tracking`, `conversion.no_cta` (`scopeKey: family`), `conversion.no_contact`.
- `packages/agents/src/search.ts`: `search.low_ctr`, `search.market_mismatch`, `search.navigational`, `search.cannibalisation`.
- `packages/agents/src/connector-findings.ts`: `crawl.budget_parameters`, `crawl.budget_wasted`, `trend.googlebot_pace`, `index.gone_urls`, `index.noindex_recovered`, `trend.index_coverage`, `trend.impressions_fell`, `data.duplicates` (`scopeKey: entityType`), `data.missing_field` (`scopeKey: \`${entityType}|${field}\``), `content.thin_records` (`scopeKey: entityType`), `links.gap`.
- `packages/agents/src/not-found-probe.ts`: `server.soft_404_probe`.
- `packages/agents/src/pipeline.ts:198`: `fetch.failed` with `impact: 30`, `scopeKey: url`.

- [ ] **Step 6: Check nothing builds a finding by hand any more**

Run: `grep -rn 'createId("finding")' packages/crawler/src packages/agents/src --include='*.ts' | grep -v '\.test\.'`
Expected: no output. A literal left behind is a check missing from the catalogue: add it to `catalog.ts` (and to the count) and migrate it.

- [ ] **Step 7: Run every package's tests**

Run: `npm test`
Expected: PASS. Existing tests compare titles and severities, which are unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/crawler/src packages/agents/src
git commit -m "Produce every finding through the check registry"
```

---

### Task 3: History keys by check id

**Files:**
- Modify: `packages/core/src/history.ts:33-50`
- Test: `packages/core/src/history.test.ts`

**Interfaces:**
- Produces: `keyOf(finding): string`; `runKeys` writes new-format keys and upgrades legacy rows in place.

- [ ] **Step 1: Write the failing tests**

```ts
import { keyOf, runKeys, findingKey } from "./history.js";

it("keys a finding by check id and scope key, and by the legacy title key without one", () => {
  const f = { category: "rendering", title: "Slow responses on /doctors/", checkId: "server.slow", scopeKey: "doctors" } as Finding;
  assert.equal(keyOf(f), "server.slow|doctors");
  assert.equal(keyOf({ category: "rendering", title: "Slow responses on /doctors/" } as Finding), findingKey({ category: "rendering", title: "Slow responses on /doctors/" }));
});

it("upgrades a legacy key to the new key when the same finding is still open", () => {
  const legacy = { id: "f1", key: findingKey({ category: "metadata", title: "3 pages have no H1" }), title: "3 pages have no H1", category: "metadata", severity: "LOW", pages: ["https://x/a"] };
  const current = { id: "f2", category: "metadata", title: "5 pages have no H1", checkId: "heading.h1_missing", pagesAffected: ["https://x/a"], severity: "LOW" } as Finding; // category as the producer sets it
  const rows = runKeys({ findings: [current] }, [legacy]);
  assert.equal(rows.length, 1, "the legacy row is the same finding, not a resolved one");
  assert.equal(rows[0]!.key, "heading.h1_missing|");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @organic-growth/core`
Expected: FAIL, `keyOf` is not exported.

- [ ] **Step 3: Implement**

In `history.ts`, after `findingKey`:

```ts
/** The same problem across runs: the registry check and its scope (family, query, entity), or the legacy title key for findings saved before the registry. */
export const keyOf = (finding: Pick<Finding, "category" | "title" | "checkId" | "scopeKey">) =>
  finding.checkId ? `${finding.checkId}|${finding.scopeKey ?? ""}` : findingKey(finding);
```

In `runKeys`, build rows with `key: keyOf(finding)`, then before the `previous` loop:

```ts
  // Rows saved before the registry carry title keys (`category|title`); a current finding with the same title key is the same problem under its new key.
  const findings = report.findings ?? [];
  const newKeyOf = new Map(findings.filter((finding) => finding.checkId).map((finding) => [findingKey(finding), keyOf(finding)]));
  const upgraded = previous.map((row) => (newKeyOf.has(row.key) ? { ...row, key: newKeyOf.get(row.key)! } : row));
```

and use `upgraded` instead of `previous` in the loop. A new key (`title.weak|`) never equals a title key (`metadata|…`, no dot in a category), so only legacy rows can match. `resolutions()` diffs consecutive saved lists: the previous run's list is stored with old keys, so apply the same upgrade in `resolutions` when a run has old keys and the next has new ones (map the earlier run's rows through the later run's `findingKey → keyOf` table, built from its rows' `title` and `category`).

- [ ] **Step 4: Run tests, then the db history tests**

Run: `npm run test -w @organic-growth/core && npm run build -w @organic-growth/core && npm run test -w @organic-growth/db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/history.ts packages/core/src/history.test.ts
git commit -m "History: key findings by check id, upgrade legacy keys in place"
```

---

### Task 4: New per-page signals in the crawler

**Files:**
- Modify: `packages/crawler/src/index.ts` (`HtmlSignals`, `parseHtmlSignals:132-195`, `FetchResult:13-20`, `defaultFetcher:66-94`, `toCrawlResult`), `packages/core/src/types.ts` (`CrawlPageResult`)
- Create: `packages/crawler/src/content-signals.ts`
- Test: `packages/crawler/src/content-signals.test.ts`, `packages/crawler/src/crawler.test.ts`

**Interfaces:**
- Produces on `CrawlPageResult` (all optional): `redirectHops`, `lang`, `viewport`, `images`, `imagesNoAlt`, `mixedContent`, `httpLinks`, `externalLinks`, `h1`, `words`, `questionHeadings`, `listsOrTables`, `leadWords`, `statistics`, `quotes`, `modified`, `articleLike`, `author`, `snippetBlocked`, `landmarks`, `headingSkips`, `entitySchema`, `hsts`.
- `FetchResult.hops?: number`.

- [ ] **Step 1: Write the failing tests**

`packages/crawler/src/content-signals.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentSignals, countStatistics, countQuotes, isQuestionHeading, parseModified } from "./content-signals.js";

describe("content signals", () => {
  it("detects question headings in four languages", () => {
    for (const h of ["How much do braces cost?", "Berapa kos pendakap gigi", "Apa itu implan", "如何选择牙医", "Why choose us"]) assert.ok(isQuestionHeading(h), h);
    assert.ok(!isQuestionHeading("Our clinics"));
  });
  it("counts statistics and quotes", () => {
    assert.equal(countStatistics("Braces cost RM 4,500 and take 18 months; 72% of patients finish early."), 3);
    assert.equal(countQuotes("<blockquote>x</blockquote> She said “this is the best clinic I have been to in years”."), 2);
  });
  it("reads the modified date from JSON-LD, then meta, then <time>", () => {
    assert.equal(parseModified({ jsonLd: [{ "@type": "Article", dateModified: "2026-03-01" }], metas: {}, html: "" }), "2026-03-01");
    assert.equal(parseModified({ jsonLd: [], metas: { "article:published_time": "2025-01-02T00:00:00Z" }, html: "" }), "2025-01-02");
    assert.equal(parseModified({ jsonLd: [], metas: {}, html: '<main><time datetime="2024-06-07">7 June</time></main>' }), "2024-06-07");
    assert.equal(parseModified({ jsonLd: [], metas: {}, html: "" }), undefined);
  });
  it("summarises a page", () => {
    const html = `<html lang="ms"><head><meta name="viewport" content="width=device-width"><meta name="robots" content="max-snippet:0"><meta name="author" content="Dr A"></head>
      <body><header></header><main><article><h1>Braces</h1><p>${"word ".repeat(30)}</p><h2>How long do braces take?</h2><ul><li>a</li><li>b</li><li>c</li></ul><h4>skip</h4>
      <img src="http://cdn.example/a.jpg"><img src="/b.jpg" alt=""><a href="https://who.int/x">WHO</a><a href="https://facebook.com/x">fb</a><a href="http://site.example/old">old</a></article></main></body></html>`;
    const s = contentSignals(html, "https://site.example/blog/braces-2024", { jsonLdTypes: ["BlogPosting"], jsonLd: [{ "@type": "BlogPosting", author: { name: "Dr A" } }] });
    assert.equal(s.lang, "ms"); assert.equal(s.viewport, true); assert.equal(s.snippetBlocked, true); assert.equal(s.author, true);
    assert.equal(s.images, 2); assert.equal(s.imagesNoAlt, 1, "an empty alt is decorative"); assert.equal(s.mixedContent, 1); assert.equal(s.httpLinks, 1); assert.equal(s.externalLinks, 1, "social hosts are not citations");
    assert.equal(s.h1, "Braces"); assert.equal(s.questionHeadings, 1); assert.equal(s.listsOrTables, true); assert.equal(s.leadWords, 30); assert.equal(s.headingSkips, true);
    assert.equal(s.landmarks, 3); assert.equal(s.articleLike, true); assert.equal(s.words > 30, true);
  });
});
```

Add to `crawler.test.ts`:

```ts
it("counts redirect hops and records HSTS", async () => {
  // Use the existing fake-fetch pattern for defaultFetcher if present; otherwise test toCrawlResult through fetchGooglebotPage:
  const fake: Fetcher = async (url) => ({ url, finalUrl: url, hops: 2, status: 200, headers: { "strict-transport-security": "max-age=1" }, body: "<html><head><title>T</title></head><body><main>x</main></body></html>" });
  const page = await fetchGooglebotPage("https://x.com/a", fake);
  assert.equal(page.redirectHops, 2); assert.equal(page.hsts, true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @organic-growth/crawler`
Expected: FAIL, module `./content-signals.js` missing.

- [ ] **Step 3: Implement `content-signals.ts`**

```ts
import { elementSpans, findTags, innerText, parseAttributes, stripElements, visibleText } from "./html.js";

// `\b` only after Latin words: Chinese characters are not word characters, so a boundary never follows them.
const QUESTION = /\?\s*$|？\s*$|^\s*(?:(?:how|what|why|when|which|who|can|should|is|are|do|does|apa|bagaimana|mengapa|kenapa|bila|bilakah|berapa|siapa|adakah)\b|如何|什么|为什么|怎么|哪)/i;
export const isQuestionHeading = (text: string) => QUESTION.test(text.trim());

// A currency before the number, or a unit after it. `(?![a-z])` instead of `\b`: there is no word boundary after `%`.
const STAT = /(?:RM|USD|SGD|IDR|Rp|S?\$)\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|percent|peratus|persen|million|juta|billion|bilion|km|kg|mm|cm|years?|tahun|months?|bulan|minutes?|minit|hours?|jam|days?|hari|patients?|pesakit|pasien)(?![a-z])/gi;
export const countStatistics = (text: string) => (text.match(STAT) ?? []).length;

const QUOTE = /<blockquote[\s>]|[“"]([^”"]{40,})[”"]/gi;
export const countQuotes = (html: string) => (html.match(QUOTE) ?? []).length;

export const SOCIAL_HOSTS = /(^|\.)(facebook|instagram|x|twitter|tiktok|youtube|linkedin|whatsapp|threads|pinterest)\.com$|^wa\.me$|^t\.me$/i;

const day = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
};

/** The page's last-modified day: JSON-LD dateModified, else datePublished, else Open Graph article times, else the first <time datetime> in the main content. */
export function parseModified(input: { jsonLd: Array<Record<string, unknown>>; metas: Record<string, string>; html: string }): string | undefined {
  for (const key of ["dateModified", "datePublished"]) for (const block of input.jsonLd) { const d = day(block[key]); if (d) return d; }
  for (const key of ["article:modified_time", "article:published_time"]) { const d = day(input.metas[key]); if (d) return d; }
  return day(findTags(input.html, "time").find((t) => t.datetime)?.datetime);
}

const ARTICLE_TYPES = /^(Article|BlogPosting|NewsArticle|MedicalWebPage|ScholarlyArticle|TechArticle)$/i;
const ARTICLE_PATH = /\/(blog|news|artikel|berita|articles?|posts?|guides?|panduan)\//i;
const ENTITY_TYPES = /^(Organization|LocalBusiness|Person|Corporation|MedicalOrganization|MedicalBusiness|MedicalClinic|Dentist|Physician|Hospital|Store|Restaurant|ProfessionalService|LegalService|FinancialService|HomeAndConstructionBusiness|.*Business)$/i;
const BYLINE = /\b(by|oleh|ditulis oleh|written by|作者)\s*[:：]?\s*(dr\.?\s)?[A-Z一-鿿][^\n<]{2,60}/;

export type ContentSignals = {
  lang?: string; viewport: boolean; images: number; imagesNoAlt: number; mixedContent: number; httpLinks: number; externalLinks: number;
  h1?: string; words: number; questionHeadings: number; listsOrTables: boolean; leadWords: number; statistics: number; quotes: number;
  modified?: string; articleLike: boolean; author: boolean; snippetBlocked: boolean; landmarks: number; headingSkips: boolean; entitySchema: boolean;
};

export function contentSignals(html: string, pageUrl: string, ld: { jsonLdTypes: string[]; jsonLd: Array<Record<string, unknown>> }): ContentSignals {
  const url = new URL(pageUrl);
  const metas = findTags(html, "meta");
  const meta = (key: string) => metas.find((m) => (m.name ?? m.property)?.toLowerCase() === key)?.content;
  const robots = [meta("robots"), meta("googlebot")].filter(Boolean).join(",");
  const main = elementSpans(html, ["main", "article"])[0];
  const mainHtml = main ? html.slice(main.contentStart, main.contentEnd) : stripElements(html, ["nav", "header", "footer", "aside", "form"]);
  const mainText = visibleText(mainHtml);
  const words = mainText.split(/\s+/).filter(Boolean).length;
  const headings = elementSpans(html, ["h1", "h2", "h3", "h4", "h5", "h6"]);
  const h1Span = headings.find((h) => h.tag === "h1");
  const h1 = h1Span ? innerText(html.slice(h1Span.contentStart, h1Span.contentEnd)).slice(0, 200) : undefined;
  let headingSkips = false, previous = 0;
  for (const h of headings) { const level = Number(h.tag[1]); if (previous && level > previous + 1) headingSkips = true; previous = level; }
  const questionHeadings = headings.filter((h) => h.tag === "h2" || h.tag === "h3").filter((h) => isQuestionHeading(innerText(html.slice(h.contentStart, h.contentEnd)))).length;
  const afterH1 = h1Span ? html.slice(h1Span.contentEnd) : mainHtml;
  const lead = elementSpans(afterH1, ["p"])[0];
  const leadWords = lead ? innerText(afterH1.slice(lead.contentStart, lead.contentEnd)).split(/\s+/).filter(Boolean).length : 0;
  const listsOrTables = /<table[\s>]/i.test(mainHtml) || (mainHtml.match(/<li[\s>]/gi) ?? []).length >= 3;
  const imgs = findTags(html, "img");
  const https = url.protocol === "https:";
  const insecure = (src?: string) => Boolean(https && src && /^http:\/\//i.test(src.trim()));
  const mixedContent = [...imgs, ...findTags(html, "script"), ...findTags(html, "iframe"), ...findTags(html, "video"), ...findTags(html, "source"), ...findTags(html, "link").filter((l) => /stylesheet/i.test(l.rel ?? ""))].filter((t) => insecure(t.src ?? t.href)).length;
  let httpLinks = 0, externalLinks = 0;
  for (const a of findTags(mainHtml, "a")) {
    const href = a.href?.trim(); if (!href) continue;
    let target: URL; try { target = new URL(href, pageUrl); } catch { continue; }
    const sameSite = target.hostname.replace(/^www\./, "") === url.hostname.replace(/^www\./, "");
    if (sameSite && target.protocol === "http:" && https) httpLinks++;
    if (!sameSite && /^https?:$/.test(target.protocol) && !SOCIAL_HOSTS.test(target.hostname)) externalLinks++;
  }
  const articleLike = ld.jsonLdTypes.some((t) => ARTICLE_TYPES.test(t)) || /article/i.test(meta("og:type") ?? "") || ARTICLE_PATH.test(url.pathname);
  const author = ld.jsonLd.some((b) => Boolean(b.author)) || Boolean(meta("author")) || findTags(html, "a").some((a) => /\bauthor\b/i.test(a.rel ?? "")) || BYLINE.test(mainText);
  const entitySchema = ld.jsonLd.some((b) => ENTITY_TYPES.test(String(b["@type"] ?? "")) && (Boolean(b.sameAs) || Boolean(b.url)));
  return {
    lang: parseAttributes(html.match(/<html\b[^>]*>/i)?.[0].slice(5, -1) ?? "").lang?.trim() || undefined,
    viewport: Boolean(meta("viewport")), images: imgs.length, imagesNoAlt: imgs.filter((i) => i.alt === undefined).length,
    mixedContent, httpLinks, externalLinks, h1, words, questionHeadings, listsOrTables, leadWords,
    statistics: countStatistics(mainText), quotes: countQuotes(mainHtml),
    modified: parseModified({ jsonLd: ld.jsonLd, metas: Object.fromEntries(metas.filter((m) => m.property && m.content).map((m) => [m.property!.toLowerCase(), m.content!])), html: mainHtml }),
    articleLike, author, snippetBlocked: /\bnosnippet\b|max-snippet\s*:\s*0\b/i.test(robots), landmarks: ["main", "article", "nav", "header", "footer"].filter((t) => new RegExp(`<${t}[\\s>]`, "i").test(html)).length,
    headingSkips, entitySchema,
  };
}
```

`readJsonLd` in `index.ts` (line 212) returns `{ blocks, types, invalid }`; make `visit` also push every object it visits into `objects: Array<Record<string, unknown>>` (so `@graph` members are included, capped at 50) and return it; `HtmlSignals` gains `jsonLdObjects`. `parseAttributes` already returns `""` for `alt` and `alt=""` and leaves an absent `alt` undefined, which is what `imagesNoAlt` needs.

- [ ] **Step 4: Wire it into `toCrawlResult`, the fetcher and the types**

In `FetchResult` add `hops?: number;`. In `defaultFetcher`, keep a `hops` counter: increment on each 3xx followed, return `{ …, hops }`.

In `CrawlPageResult` (core types) add every field of `ContentSignals` as optional, plus `redirectHops?: number` and `hsts?: boolean`.

In `toCrawlResult`, after `signals`:

```ts
  const content = contentSignals(fetchResult.body, finalUrl, { jsonLdTypes: signals.jsonLdTypes, jsonLd: signals.jsonLdObjects });
  const keep = <T>(value: T) => (value === 0 || value === false || value === undefined ? undefined : value);
```

and spread into the result: `redirectHops: keep(fetchResult.hops)`, `hsts: keep(Boolean(fetchResult.headers["strict-transport-security"]))`, and each content field through `keep`, except `viewport`, `author`, `articleLike`, `entitySchema`, `listsOrTables`, `landmarks`, `words`, `leadWords`, `images` which are always written (a `false`/`0` there is a real answer; absence must mean "not checked"). In `saveCrawlBatch` (db) add every new field to the `result` object written to `result_json`.

- [ ] **Step 5: Run tests**

Run: `npm run build:packages && npm run test -w @organic-growth/crawler && npm run test -w @organic-growth/db`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/crawler/src packages/core/src/types.ts packages/db/src/index.ts
git commit -m "Crawler: content, security and freshness signals per page; redirect hops; HSTS"
```

---

### Task 5: Counting the new page checks and the link graph in SQL

**Files:**
- Modify: `packages/core/src/types.ts` (`CrawlIssue`, `CrawlCoverage`), `packages/db/src/index.ts:810-970` (`CRAWL_ISSUES`, `getCrawlCoverage`)
- Create: `packages/db/src/link-graph.ts`
- Test: `packages/db/src/coverage.test.ts` (new), `packages/db/src/link-graph.test.ts` (new)

**Interfaces:**
- Produces: `CrawlIssue` adds `redirectChain | metaRefresh | mixedContent | httpLinks | titleLength | descriptionLength | duplicateDescription | h1EqualsTitle | headingSkips | langMissing | viewportMissing | imagesNoAlt | thinContent | yearInSlug | snippetBlocked | stale | noDate | noAnswerStructure | lowEvidence | noAuthor | noLandmarks`; `CrawlCoverage.health?: { indexable: number; unhealthySeo: number; unhealthyAi: number; checked: boolean }`, `CrawlCoverage.duplicateDescriptionGroups?`; `linkGraphIssues(db, siteId, analysisId): Promise<LinkGraphIssues>` with `{ orphans: { count: number; examples: string[] } | null; singleInbound: …; brokenLinks: { links: number; sources: number; targets: Array<{ path: string; status: number; from: number }> } | null; depth: { deep: number; examples: string[]; skipped?: string } | null }`.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/coverage.test.ts` builds an analysis with `createAnalysis` and inserts `pages` rows with `result_json` (see `index.test.ts` for the insert helper, or insert directly: `INSERT INTO pages (analysis_id, site_id, url, route_family, crawl_state, status, title, is_empty_shell, result_json, crawled_at) VALUES …`). Rows:

Every row except `/f` has the title "A good title for this page" (under 15 characters counts as a weak title, an SEO error).

- `/a` healthy: status 200, `{"h1Count":1,"description":"…60 chars…","jsonLdCount":1,"viewport":true,"lang":"en","words":400,"images":2,"imagesNoAlt":0,"articleLike":false}`.
- `/b` seo-error: status 200, `{"mixedContent":2,"redirectHops":2,"h1Count":1,"viewport":true,"lang":"en","words":400}`.
- `/c` ai-error only: status 200, `{"snippetBlocked":true,"h1Count":1,"viewport":true,"lang":"en","words":400}`.
- `/d` noindex: `{"noindex":true}` (not in the denominator).
- `/e` legacy row: `{"h1Count":1}` only (no new fields).
- `/f` status 500.

```ts
it("counts the new issues and the unhealthy pages per pillar, treating absent fields as not checked", async () => {
  const c = await getCrawlCoverage(db, "an1");
  assert.equal(c.issues?.mixedContent, 1); assert.equal(c.issues?.redirectChain, 1); assert.equal(c.issues?.snippetBlocked, 1);
  assert.equal(c.issues?.viewportMissing, 0, "the legacy row has no viewport field and is not counted");
  assert.deepEqual(c.health, { indexable: 5, unhealthySeo: 2, unhealthyAi: 2, checked: true }); // b and f for seo; c and f for ai (f: http error counts for both)
});
it("says the health is unchecked when no row carries the new fields", async () => {
  const legacy = openSqliteD1();
  // same site and analysis setup as above, one row: `/e` with `{"h1Count":1}` and a good title
  const c = await getCrawlCoverage(legacy, "an1");
  assert.equal(c.health?.checked, false);
  assert.equal(c.issues?.thinContent, 0);
});
```

`packages/db/src/link-graph.test.ts`: insert `page_links` rows for site `s`: `/` → `/a`, `/a` → `/b`, `/b` → `/c`, `/c` → `/d`, `/a` → `/gone`; pages rows for `/`, `/a`, `/b`, `/c`, `/d`, `/orphan` (200) and `/gone` (404).

```ts
it("finds orphans, single-inbound pages, broken links and deep pages", async () => {
  const r = await linkGraphIssues(db, "s", "an1");
  assert.deepEqual(r.orphans, { count: 1, examples: ["https://x.com/orphan"] });
  assert.equal(r.singleInbound?.count, 5);
  assert.deepEqual(r.brokenLinks, { links: 1, sources: 1, targets: [{ path: "/gone", status: 404, from: 1 }] });
  assert.deepEqual(r.depth, { deep: 1, examples: ["https://x.com/d"] }); // / is 0, a 1, b 2, c 3, d 4
});
it("skips the depth query on a huge link table", async () => {
  const r = await linkGraphIssues(db, "s", "an1", { maxLinkRows: 3 });
  assert.equal(r.depth?.skipped, "The link map has more than 3 rows; depth is not computed.");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @organic-growth/db`
Expected: FAIL (module missing; `health` undefined).

- [ ] **Step 3: Add the issue conditions**

`CRAWL_ISSUES` is typed `Record<Exclude<CrawlIssue, "duplicateTitle" | "nearDuplicate">, …>`; add `"duplicateDescription"` to the excluded keys (it is counted by its own group query). Import the thresholds from `@organic-growth/core` and use them in the conditions (`TITLE_LENGTH.min`, `TITLE_LENGTH.max`, `DESCRIPTION_MAX`, `THIN_WORDS`, `LEAD_WORDS_MAX`, `AI_FRESHNESS_DAYS`) where the literals below show 30, 60, 160, 150, 120 and 365. In `CRAWL_ISSUES`, with `const F = crawlField;` and `const DETAIL = DETAIL_PAGE`:

```ts
  redirectChain: { where: `${SERVED} AND ${F("redirectHops")} >= 2`, detail: F("redirectHops") },
  metaRefresh: { where: `${SERVED} AND ${F("metaRefresh")} IS NOT NULL`, detail: F("metaRefresh") },
  mixedContent: { where: `${SERVED} AND ${F("mixedContent")} > 0`, detail: F("mixedContent") },
  httpLinks: { where: `${SERVED} AND ${F("httpLinks")} > 0`, detail: F("httpLinks") },
  titleLength: { where: `${SERVED} AND is_empty_shell = 0 AND ${F("words")} IS NOT NULL AND title IS NOT NULL AND (LENGTH(TRIM(title)) < 30 OR LENGTH(TRIM(title)) > 60)`, detail: "LENGTH(TRIM(title))" },
  descriptionLength: { where: `${SERVED} AND LENGTH(COALESCE(${F("description")}, '')) > 160`, detail: `LENGTH(${F("description")})` },
  h1EqualsTitle: { where: `${SERVED} AND ${F("h1")} IS NOT NULL AND LOWER(TRIM(${F("h1")})) = LOWER(TRIM(title))` },
  headingSkips: { where: `${SERVED} AND ${F("headingSkips")} = 1` },
  langMissing: { where: `${SERVED} AND is_empty_shell = 0 AND ${F("viewport")} IS NOT NULL AND ${F("lang")} IS NULL` },
  viewportMissing: { where: `${SERVED} AND is_empty_shell = 0 AND ${F("viewport")} = 0` },
  imagesNoAlt: { where: `${SERVED} AND ${F("imagesNoAlt")} > 0`, detail: F("imagesNoAlt") },
  thinContent: { where: `${SERVED} AND is_empty_shell = 0 AND ${DETAIL} AND ${F("words")} IS NOT NULL AND ${F("words")} < 150 AND COALESCE(${F("softNotFound")}, 0) = 0`, detail: F("words") },
  yearInSlug: { where: `${SERVED} AND ${F("articleLike")} = 1 AND url GLOB '*[-/]20[0-9][0-9]*'` },
  snippetBlocked: { where: `${SERVED} AND ${F("snippetBlocked")} = 1 AND COALESCE(${F("noindex")}, 0) = 0` },
  stale: { where: `${SERVED} AND ${F("articleLike")} = 1 AND ${F("modified")} IS NOT NULL AND ${F("modified")} < date('now', '-365 days')`, detail: F("modified") },
  noDate: { where: `${SERVED} AND ${F("articleLike")} = 1 AND ${F("modified")} IS NULL` },
  noAnswerStructure: { where: `${SERVED} AND is_empty_shell = 0 AND (${DETAIL} OR ${F("articleLike")} = 1) AND ${F("words")} >= 150 AND COALESCE(${F("questionHeadings")}, 0) = 0 AND ${F("listsOrTables")} = 0 AND ${F("leadWords")} > 120` },
  lowEvidence: { where: `${SERVED} AND ${F("articleLike")} = 1 AND ${F("words")} >= 150 AND COALESCE(${F("statistics")}, 0) = 0 AND COALESCE(${F("quotes")}, 0) = 0 AND COALESCE(${F("externalLinks")}, 0) = 0` },
  noAuthor: { where: `${SERVED} AND ${F("articleLike")} = 1 AND ${F("author")} = 0` },
  noLandmarks: { where: `${SERVED} AND is_empty_shell = 0 AND ${F("landmarks")} = 0` },
```

Every condition that can fire on a legacy row is guarded by a field that is always written by the new crawler (`viewport`, `words`, `articleLike`, `author`, `landmarks`, `listsOrTables`) so a legacy row never matches. `redirected` becomes one-hop only: add `AND COALESCE(${F("redirectHops")}, 1) < 2 AND ${F("metaRefresh")} IS NULL`.

Add to the `SELECT` in `getCrawlCoverage`:

```ts
      SUM(CASE WHEN ${INDEXABLE} THEN 1 ELSE 0 END) AS indexable,
      SUM(CASE WHEN ${INDEXABLE} AND (${SEO_ERRORS}) THEN 1 ELSE 0 END) AS unhealthy_seo,
      SUM(CASE WHEN ${INDEXABLE} AND (${AI_ERRORS}) THEN 1 ELSE 0 END) AS unhealthy_ai,
      SUM(CASE WHEN crawl_state = 'complete' AND ${F("viewport")} IS NOT NULL THEN 1 ELSE 0 END) AS checked_rows
```

where `INDEXABLE = \`crawl_state = 'complete' AND COALESCE(${F("noindex")},0) = 0 AND COALESCE(${F("canonicalMismatch")},0) = 0 AND (${F("finalUrl")} IS NULL OR ${F("finalUrl")} = url)\``, `SEO_ERRORS` ORs: `status >= 400`, `is_empty_shell = 1`, `${CHALLENGE}`, the `where` of `softNotFound`, `mixedContent`, `redirectChain`, `metaRefresh`, and `(title IS NULL OR LENGTH(TRIM(title)) < 15)`; `AI_ERRORS` ORs: `status >= 400`, `is_empty_shell = 1`, `${CHALLENGE}`, the `where` of `snippetBlocked`. These are exactly the checks in `PAGE_ERROR_CHECKS` (Task 8), whose test cross-checks them against the registry; keep a comment beside each OR naming its check id. Set `coverage.health = { indexable, unhealthySeo, unhealthyAi, checked: checked_rows > 0 }`.

Add `duplicateDescriptionGroups` with the `DUPLICATE_TITLES` query shape over `json_extract(result_json,'$.description')`, and `issues.duplicateDescription` as the sum of its counts.

**Query budget.** With 33 issue keys, one example query per issue would exceed the Free plan's 50 queries. Replace the per-issue `Promise.all` with one statement: `SELECT issue, url, detail FROM (…) WHERE rn <= 8`, the inner part a `UNION ALL` of `SELECT '<key>' AS issue, url, <detail> AS detail, ROW_NUMBER() OVER (ORDER BY url) AS rn FROM pages WHERE analysis_id = ?1 AND <where>` for each issue whose count is above zero, binding the analysis id once as `?1`.

- [ ] **Step 4: Write `link-graph.ts`**

Move `URL_PATH` from `index.ts` into `link-graph.ts`, export it, and import it back in `index.ts`.

```ts
import type { D1Like } from "./d1.js";

export type LinkGraphIssues = {
  orphans: { count: number; examples: string[] } | null;
  singleInbound: { count: number; examples: string[] } | null;
  brokenLinks: { links: number; sources: number; targets: Array<{ path: string; status: number; from: number }> } | null;
  depth: { deep: number; examples: string[]; skipped?: string } | null;
};

/** A URL's path as `page_links` stores targets: no trailing slash, `` for the homepage. */
export const URL_PATH = (column: string) => `rtrim(substr(${column}, instr(substr(${column}, 9), '/') + 8), '/')`;

/** Orphans, single-inbound pages, broken internal links and deep pages, from `page_links` against this analysis's crawl. Null when the crawl recorded no links. */
export async function linkGraphIssues(db: D1Like, siteId: string, analysisId: string, options: { maxLinkRows?: number } = {}): Promise<LinkGraphIssues> {
  const links = Number((await db.prepare("SELECT COUNT(*) AS n FROM page_links WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n ?? 0);
  if (!links) return { orphans: null, singleInbound: null, brokenLinks: null, depth: null };
  // Uses idx_page_links_target (site_id, target_path).
  const inbound = `(SELECT COUNT(*) FROM page_links l WHERE l.site_id = ? AND l.target_path = ${URL_PATH("p.url")} AND l.source_url != p.url)`;
  const served = `p.analysis_id = ? AND p.crawl_state = 'complete' AND p.status < 400 AND p.route_family != 'home'`;
  const orphans = await db.prepare(`SELECT COUNT(*) AS n, substr(group_concat(url, ' '), 1, 1200) AS urls FROM (SELECT p.url FROM pages p WHERE ${served} AND ${inbound} = 0 ORDER BY p.url LIMIT 100000)`).bind(analysisId, siteId).first<{ n: number; urls: string | null }>();
  const single = await db.prepare(`SELECT COUNT(*) AS n, substr(group_concat(url, ' '), 1, 1200) AS urls FROM (SELECT p.url FROM pages p WHERE ${served} AND ${inbound} = 1 ORDER BY p.url LIMIT 100000)`).bind(analysisId, siteId).first<{ n: number; urls: string | null }>();
  // Failing pages first (few), then their inbound links through the target index.
  const failing = `FROM pages p JOIN page_links l ON l.site_id = ? AND l.target_path = ${URL_PATH("p.url")}
     WHERE p.analysis_id = ? AND (p.crawl_state = 'failed' OR (p.crawl_state = 'complete' AND p.status >= 400))`;
  const broken = await db.prepare(
    `SELECT l.target_path AS path, COALESCE(p.status, 0) AS status, COUNT(DISTINCT l.source_url) AS sources ${failing}
     GROUP BY l.target_path, p.status ORDER BY sources DESC LIMIT 20`,
  ).bind(siteId, analysisId).all<{ path: string; status: number; sources: number }>();
  const brokenTotals = await db.prepare(`SELECT COUNT(*) AS links, COUNT(DISTINCT l.source_url) AS sources ${failing}`).bind(siteId, analysisId).first<{ links: number; sources: number }>();
  const examples = (urls: string | null) => (urls ?? "").split(" ").filter(Boolean).slice(0, 8);
  const max = options.maxLinkRows ?? 200_000;
  // Pages reachable within LINK_DEPTH clicks of the homepage; a linked page outside that set is deep (an unlinked one is an orphan instead).
  // The edges CTE is materialised so SQLite indexes it automatically; the recursion stops at LINK_DEPTH, so it touches each path a few times at most.
  // ponytail: one statement over the whole link table, capped at maxLinkRows; a BFS in its own step replaces it if a site exceeds the cap.
  const depth = links > max
    ? { deep: 0, examples: [], skipped: `The link map has more than ${max.toLocaleString("en")} rows; depth is not computed.` }
    : await db.prepare(
      `WITH RECURSIVE edges(s, t) AS MATERIALIZED (SELECT ${URL_PATH("source_url")}, target_path FROM page_links WHERE site_id = ?),
       reach(path, depth) AS (SELECT '', 0 UNION SELECT e.t, r.depth + 1 FROM reach r JOIN edges e ON e.s = r.path WHERE r.depth < ${LINK_DEPTH}),
       near(path) AS (SELECT DISTINCT path FROM reach)
       SELECT COUNT(*) AS n, substr(group_concat(url, ' '), 1, 1200) AS urls FROM (
         SELECT p.url FROM pages p WHERE ${served} AND ${URL_PATH("p.url")} NOT IN (SELECT path FROM near) AND ${inbound} > 0 ORDER BY p.url LIMIT 100000)`,
    ).bind(siteId, analysisId, siteId).first<{ n: number; urls: string | null }>().then((row) => ({ deep: Number(row?.n ?? 0), examples: examples(row?.urls ?? null) }));
  return {
    orphans: { count: Number(orphans?.n ?? 0), examples: examples(orphans?.urls ?? null) },
    singleInbound: { count: Number(single?.n ?? 0), examples: examples(single?.urls ?? null) },
    brokenLinks: { links: Number(brokenTotals?.links ?? 0), sources: Number(brokenTotals?.sources ?? 0), targets: broken.results.map((row) => ({ path: row.path, status: Number(row.status), from: Number(row.sources) })) },
    depth,
  };
}
```

Import `LINK_DEPTH` from `@organic-growth/core`. Define `LinkGraphIssues` in core `types.ts` (import it in db) and export `linkGraphIssues` from `packages/db/src/index.ts`. `CrawlCoverage` gains `linkGraph?: LinkGraphIssues`, filled inside `getCrawlCoverage`: read the site with `SELECT site_id FROM analyses WHERE id = ?` and call `linkGraphIssues(db, siteId, analysisId)`, so every caller (the workflow, the demo) gets it. Coverage now costs about 1 count + 1 examples + 4 group queries + 7 link queries; Task 7 moves it into its own workflow step so it never shares the analysis step's 50-query budget.

Fixture note for `link-graph.test.ts`: `page_links.source_url` is a full URL (`https://x.com/`, `https://x.com/a`) and `target_path` a path with a leading slash and no trailing one (`/a`, `/gone`; `` for the homepage), as `saveCrawlBatch` writes them.

- [ ] **Step 5: Run tests**

Run: `npm run build -w @organic-growth/core && npm run test -w @organic-growth/db`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/db/src
git commit -m "Coverage: count the new page checks, unhealthy pages per pillar, and the link graph issues"
```

---

### Task 6: The new findings and their registry entries

**Files:**
- Modify: `packages/core/src/checks/catalog.ts` (34 new entries), `packages/crawler/src/coverage-findings.ts` (new drafts), `packages/crawler/src/tech-seo.ts` (robots.missing, robots.sitemap_undeclared)
- Create: `packages/crawler/src/link-findings.ts`, `packages/crawler/src/ai-findings.ts`
- Test: `packages/crawler/src/crawler.test.ts` (coverage drafts), `packages/crawler/src/link-findings.test.ts`, `packages/crawler/src/ai-findings.test.ts`, `packages/core/src/checks/checks.test.ts` (raise count to `>= 90`)

**Interfaces:**
- Produces: `findingsFromLinkGraph({ siteId, analysisId, linkGraph }): Finding[]`; `findingsFromAiContent({ siteId, analysisId, coverage, homepage?: CrawlPageResult }): Finding[]`; new drafts inside `findingsFromCrawlCoverage`.

- [ ] **Step 1: Write the failing tests**

In `crawler.test.ts`, extend the `findingsFromCrawlCoverage` fixture coverage with `issues: { mixedContent: 3, redirectChain: 2, metaRefresh: 1, httpLinks: 4, titleLength: 10, descriptionLength: 2, duplicateDescription: 6, h1EqualsTitle: 5, headingSkips: 2, langMissing: 7, viewportMissing: 1, imagesNoAlt: 9, thinContent: 12, yearInSlug: 2 }` and examples, then:

```ts
it("writes one finding per new SEO page check with its check id", () => {
  const ids = findingsFromCrawlCoverage({ siteId: "s", analysisId: "a", coverage }).map((f) => f.checkId);
  for (const id of ["security.mixed_content", "http.redirect_chain", "http.meta_refresh", "security.http_links", "title.length", "description.length", "description.duplicate", "heading.h1_equals_title", "heading.skipped_levels", "html.lang_missing", "html.viewport_missing", "image.alt_missing", "content.thin", "url.year_in_slug"]) assert.ok(ids.includes(id), id);
});
```

`link-findings.test.ts`:

```ts
it("turns link graph issues into findings", () => {
  const f = findingsFromLinkGraph({ siteId: "s", analysisId: "a", linkGraph: { orphans: { count: 40, examples: ["https://x/o"] }, singleInbound: { count: 3, examples: [] }, brokenLinks: { links: 12, sources: 5, targets: [{ path: "/gone", status: 404, from: 5 }] }, depth: { deep: 7, examples: ["https://x/d"] } } });
  assert.deepEqual(f.map((x) => x.checkId), ["links.broken_internal", "links.orphan", "links.single_inbound", "links.depth"]);
  assert.equal(f[0]!.title, "12 internal links point at pages that fail");
  assert.match(f[1]!.summary, /40 sitemap URLs/);
  assert.equal(findingsFromLinkGraph({ siteId: "s", analysisId: "a", linkGraph: { orphans: null, singleInbound: null, brokenLinks: null, depth: { deep: 0, examples: [], skipped: "x" } } }).length, 0);
});
```

`ai-findings.test.ts`: coverage with `issues: { snippetBlocked: 2, stale: 30, noDate: 4, noAnswerStructure: 50, lowEvidence: 20, noAuthor: 25, noLandmarks: 9 }` and a homepage result with `entitySchema: false`:

```ts
it("writes the AI visibility content findings", () => {
  const ids = findingsFromAiContent({ siteId: "s", analysisId: "a", coverage, homepage }).map((f) => f.checkId);
  assert.deepEqual(ids, ["ai.snippet_blocked", "ai.stale", "ai.no_date", "ai.no_answer_structure", "ai.low_evidence", "ai.no_author", "ai.semantic_html_missing", "ai.no_entity_schema"]);
  const stale = findingsFromAiContent({ siteId: "s", analysisId: "a", coverage, homepage }).find((f) => f.checkId === "ai.stale")!;
  assert.equal(stale.category, "ai_visibility"); assert.ok(stale.organicImpactScore >= 40);
});
it("skips the entity schema check when the homepage was not crawled", () => {
  const ids = findingsFromAiContent({ siteId: "s", analysisId: "a", coverage, homepage: undefined }).map((f) => f.checkId);
  assert.ok(!ids.includes("ai.no_entity_schema"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @organic-growth/crawler`
Expected: FAIL.

- [ ] **Step 3: Add the 34 registry entries**

Raise the registry test to `assert.equal(ids.size, 89)`.

In `catalog.ts`, following the spec tables, with full docs. Example of one SEO and one AI entry:

```ts
  c({ id: "links.orphan", name: "Orphan pages", pillars: ["seo"], category: "internal_links", class: "warning", scope: "page", sources: ["crawl"], fix: "links", requires: "a full crawl with links recorded",
    docs: {
      what: "Sitemap URLs that no other crawled page links to.",
      why: "Google finds and ranks pages partly through internal links; a page only the sitemap knows is crawled less, ranks lower and sends no authority anywhere.",
      how: "Link each orphan from its parent list page, a related page, or the navigation. Generated pages should be linked from the page that lists their records.",
      severity: "The impact formula with the orphan count as pages affected, capped at 60.",
    } }),
  c({ id: "ai.stale", name: "Stale articles", pillars: ["ai"], category: "ai_visibility", class: "warning", scope: "page", sources: ["crawl"], fix: "content",
    docs: {
      what: "Article-like pages (Article or BlogPosting markup, an article Open Graph type, or a blog, news or guide path) whose last-modified date is over 365 days old.",
      why: "AI assistants prefer recent sources: three quarters of pages cited in AI answers were updated within twelve months (Seer, 2026), and AI-cited content is about a quarter fresher than the organic top ten (Ahrefs).",
      how: "Review the article, update facts and prices, and set dateModified in its structured data (and the visible date) to the day it was revised. Do not change the date without changing the content.",
      severity: "The impact formula with the stale count as pages affected, capped at 55.",
    } }),
```

Ids to add, with class/scope/category/fix from the spec: `robots.missing`, `robots.sitemap_undeclared`, `server.www_duplicate`, `server.http_not_redirected`, `security.hsts_missing`, `security.mixed_content`, `security.http_links`, `http.redirect_chain`, `http.meta_refresh`, `title.length`, `description.duplicate`, `description.length`, `heading.h1_equals_title`, `heading.skipped_levels` (seo+ai), `html.lang_missing`, `html.viewport_missing`, `image.alt_missing`, `content.thin` (seo+ai), `links.broken_internal`, `links.orphan`, `links.single_inbound`, `links.depth`, `url.year_in_slug` (seo+ai), `ai.crawler_refused`, `ai.snippet_blocked`, `ai.stale`, `ai.no_date`, `ai.no_answer_structure`, `ai.low_evidence`, `ai.no_author`, `ai.no_entity_schema`, `ai.semantic_html_missing`, `ai.llms_txt` (unscored), `ai.llms_txt_format` (unscored). `security.*` use the new `"security"` category; `html.*`, `title.*`, `description.*` use `metadata`; `image.*`, `heading.*`, `content.*` use `content`; `links.*` use `internal_links`; `http.*` use `indexing`; `ai.*` use `ai_visibility`; `server.*` use `indexing`.

- [ ] **Step 4: Add the coverage drafts**

In `findingsFromCrawlCoverage`, after the near-duplicate draft, one block per check in the test's list. Pattern (the counts, caps and thresholds are the registry's `severity` text made concrete):

```ts
  const simple = (checkId: string, issue: CrawlIssue, cap: number, title: (n: number) => string, summary: (n: number) => string, category: FindingCategory) => {
    const n = issues[issue] ?? 0;
    if (n > 0) drafts.push({ checkId, category, impact: Math.min(organicImpactScore({ category, pagesAffected: n }), cap), title: title(n), summary: summary(n), evidence: { [issue]: n, examples: examples[issue] ?? [] }, recommendation: CHECKS[checkId]!.docs.how, pagesAffected: exampleUrls(issue) });
  };
  simple("security.mixed_content", "mixedContent", 70, (n) => `${pages(n)} load images or scripts over HTTP`, (n) => `${pages(n)} on this HTTPS site reference http:// images, scripts, styles or frames. Browsers block or warn on them, and Google treats mixed content as a security issue.`, "security");
  simple("http.redirect_chain", "redirectChain", 65, (n) => `${pages(n, "sitemap URL")} reach their page through two or more redirects`, (n) => `${pages(n, "sitemap URL")} redirect twice or more before answering. Each hop costs a crawl and dilutes the signals the final page receives.`, "indexing");
  simple("http.meta_refresh", "metaRefresh", 60, (n) => `${pages(n)} redirect with a meta refresh`, (n) => `${pages(n)} use a <meta http-equiv="refresh"> instead of an HTTP redirect. Search engines treat it as a weak redirect and may index the empty page.`, "indexing");
  simple("security.http_links", "httpLinks", 45, (n) => `${pages(n)} link to HTTP versions of this site`, (n) => `${pages(n)} carry links to http:// URLs on this site, so every click goes through a redirect.`, "security");
  simple("title.length", "titleLength", 45, (n) => `${pages(n)} have a title under 30 or over 60 characters`, (n) => `${pages(n)} have titles Google will pad or cut: under ${TITLE_LENGTH.min} or over ${TITLE_LENGTH.max} characters.`, "metadata");
  simple("description.length", "descriptionLength", 25, (n) => `${pages(n)} have a meta description over 160 characters`, (n) => `${pages(n)} have descriptions longer than Google shows; the end is cut off.`, "metadata");
  simple("heading.h1_equals_title", "h1EqualsTitle", 25, (n) => `${pages(n)} repeat the title as the H1`, (n) => `${pages(n)} have an H1 identical to the title tag: a second phrasing would cover another search.`, "content");
  simple("heading.skipped_levels", "headingSkips", 25, (n) => `${pages(n)} skip heading levels`, (n) => `${pages(n)} jump from one heading level to one more than a step below (an H2 followed by an H4). Assistants and screen readers read the outline; a skipped level breaks it.`, "content");
  simple("html.lang_missing", "langMissing", 40, (n) => `${pages(n)} declare no language`, (n) => `${pages(n)} have no lang attribute on <html>. Search engines and assistants guess the language, and guess wrong on mixed-language sites.`, "metadata");
  simple("html.viewport_missing", "viewportMissing", 45, (n) => `${pages(n)} have no viewport tag`, (n) => `${pages(n)} lack <meta name="viewport">, so phones render the desktop layout and Google's mobile-first index sees a poor page.`, "metadata");
  simple("image.alt_missing", "imagesNoAlt", 35, (n) => `${pages(n)} have images without alt text`, (n) => `${pages(n)} carry images with no alt attribute. Image search and assistants cannot read them, and screen readers skip them.`, "content");
  simple("content.thin", "thinContent", 50, (n) => `${pages(n)} have under 150 words`, (n) => `${pages(n)} (detail pages, not empty shells) have fewer than ${THIN_WORDS} words of main content: too little to rank for anything or to be cited.`, "content");
  simple("url.year_in_slug", "yearInSlug", 20, (n) => `${pages(n, "article")} carry a year in the URL`, (n) => `${pages(n, "article")} have a year in their address. When the year passes, assistants and searchers read them as outdated; such URLs lose AI citations fastest.`, "content");
  const dupDesc = coverage.duplicateDescriptionGroups ?? [];
  if (dupDesc.length) drafts.push({ checkId: "description.duplicate", category: "metadata", impact: Math.min(organicImpactScore({ category: "metadata", pagesAffected: issues.duplicateDescription ?? 0 }), 40), title: "Several pages share the same meta description", summary: `${pages(issues.duplicateDescription ?? 0)} share a description with another page (${count(dupDesc.length)} descriptions). Google ignores a description that does not describe the page and writes its own.`, evidence: { groups: dupDesc.slice(0, 10) }, recommendation: CHECKS["description.duplicate"]!.docs.how, pagesAffected: dupDesc.flatMap((g) => g.examples).slice(0, 20) });
```

The thresholds come from `packages/core/src/checks/thresholds.ts` (Task 1). Set `issue` on each new page check's registry entry to its `CrawlIssue` key.

- [ ] **Step 5: Write `link-findings.ts` and `ai-findings.ts`**

`link-findings.ts`:

```ts
import { CHECKS, finding, organicImpactScore, type Finding, type LinkGraphIssues } from "@organic-growth/core";

const n = (v: number) => v.toLocaleString("en");

export function findingsFromLinkGraph(input: { siteId: string; analysisId: string; linkGraph: LinkGraphIssues | undefined }): Finding[] {
  const g = input.linkGraph;
  if (!g) return [];
  const out: Finding[] = [];
  const base = { siteId: input.siteId, analysisId: input.analysisId };
  if (g.brokenLinks && g.brokenLinks.links > 0) out.push(finding(CHECKS["links.broken_internal"]!, { ...base,
    impact: Math.min(organicImpactScore({ category: "internal_links", pagesAffected: g.brokenLinks.sources, isBlockingCrawl: g.brokenLinks.links >= 100 }), 75),
    title: `${n(g.brokenLinks.links)} internal links point at pages that fail`,
    summary: `${n(g.brokenLinks.links)} links on ${n(g.brokenLinks.sources)} pages lead to sitemap URLs that answer an error or could not be fetched. Most linked: ${g.brokenLinks.targets.slice(0, 3).map((t) => `${t.path || "/"} (${t.status}, from ${n(t.from)} pages)`).join(", ")}.`,
    evidence: { links: g.brokenLinks.links, sources: g.brokenLinks.sources, targets: g.brokenLinks.targets } }));
  if (g.orphans && g.orphans.count > 0) out.push(finding(CHECKS["links.orphan"]!, { ...base,
    impact: Math.min(organicImpactScore({ category: "internal_links", pagesAffected: g.orphans.count }), 60),
    title: `${n(g.orphans.count)} pages have no internal links pointing at them`,
    summary: `${n(g.orphans.count)} sitemap URLs are linked from no other crawled page. Only the sitemap tells Google they exist, so they are crawled less and rank lower.`,
    evidence: { orphans: g.orphans.count, examples: g.orphans.examples }, pagesAffected: g.orphans.examples }));
  if (g.singleInbound && g.singleInbound.count > 0) out.push(finding(CHECKS["links.single_inbound"]!, { ...base, impact: 12,
    title: `${n(g.singleInbound.count)} pages have only one internal link`,
    summary: `${n(g.singleInbound.count)} pages are reachable through a single link; one broken link makes each an orphan.`,
    evidence: { pages: g.singleInbound.count, examples: g.singleInbound.examples }, pagesAffected: g.singleInbound.examples }));
  if (g.depth && g.depth.deep > 0 && !g.depth.skipped) out.push(finding(CHECKS["links.depth"]!, { ...base, impact: 14,
    title: `${n(g.depth.deep)} pages are more than three clicks from the homepage`,
    summary: `${n(g.depth.deep)} pages need four or more clicks from the homepage. Crawlers reach deep pages last and least.`,
    evidence: { deep: g.depth.deep, examples: g.depth.examples }, pagesAffected: g.depth.examples }));
  return out;
}
```

`ai-findings.ts` follows the same shape over `coverage.issues` for `snippetBlocked` (cap 80, title "N pages block search snippets", summary says these pages cannot appear in AI Overviews or AI Mode per Google), `stale` (cap 55), `noDate` (impact 12), `noAnswerStructure` (cap 50), `lowEvidence` (impact 14), `noAuthor` (impact 14), `noLandmarks` (impact 12), each `category: "ai_visibility"`; plus `ai.no_entity_schema` (impact 45, site scope) when `homepage` is given and `homepage.entitySchema === false`. Every finding's `recommendation` comes from the registry (omit it in the input).

In `tech-seo.ts` add `robots.missing` (when `input.robotsState === "missing"`, impact 10) and `robots.sitemap_undeclared` (when robots.txt was read, declares no `Sitemap:` line, and `sitemap.totalUrls > 0`, impact 12); `runTechnicalSeoAudit` gains `robotsState?: "read" | "missing" | "unreadable"`, passed from the pipeline (it already computes `robotsState`).

- [ ] **Step 6: Wire into the pipeline**

In `runFullAnalysis` (`pipeline.ts`), inside the `if (fullCrawl && input.crawlCoverage)` branch after `findingsFromCrawlCoverage`: `findings.push(...findingsFromLinkGraph({ siteId, analysisId, linkGraph: input.crawlCoverage.coverage.linkGraph }))` and `findings.push(...findingsFromAiContent({ siteId, analysisId, coverage: input.crawlCoverage.coverage, homepage: pageResults.find((p) => new URL(p.finalUrl ?? p.url).pathname === "/") }))`. The homepage comes from the sampled `pageResults` (the seed list always includes it), not from the 50 crawl examples, which may not. Export both from the crawler index.

- [ ] **Step 7: Run tests**

Run: `npm run build:packages && npm test`
Expected: PASS; the registry test now asserts `>= 90`.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/checks packages/crawler/src packages/agents/src/pipeline.ts
git commit -m "34 new checks: security, links, on-page, and AI visibility content findings"
```

---

### Task 7: The AI crawler and host probe step

**Files:**
- Modify: `packages/core/src/ai-agents.ts` (`AI_PROBE_AGENTS`), `packages/crawler/src/ai-readiness.ts` (`AiReadiness.probe`, `probeHost`), `packages/crawler/src/index.ts` (exports), `apps/web/src/analysis-workflow.ts:82-160` (new step), `packages/agents/src/pipeline.ts` (`RunAnalysisInput.hostProbe`, findings), `packages/crawler/src/tech-seo.ts` (host findings)
- Create: `packages/crawler/src/probe.ts`
- Test: `packages/crawler/src/probe.test.ts`

**Interfaces:**
- Produces: `AI_PROBE_AGENTS: Array<{ agent: string; userAgent: string; search: boolean }>`; `probeAiCrawlers(baseUrl, urls, robotsTxt | null, fetcher): Promise<AiProbe[]>` with `AiProbe = { agent: string; allowedByRobots: boolean; fetched: number; refused: number; of: number; challenge: boolean }`; `probeHost(baseUrl, fetcher): Promise<HostProbe>` with `HostProbe = { wwwDuplicate: boolean; httpRedirected: boolean | null; hsts: boolean; llmsTxt: "missing" | "present" | "malformed" }`; `RunAnalysisInput.hostProbe?: { ai: AiProbe[]; host: HostProbe; robotsReadable: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { probeAiCrawlers, probeHost } from "./probe.js";
const robots = "User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\n";
const site = (behaviour: (ua: string, url: string) => number): Fetcher => async (url, init) => {
  const status = behaviour(init?.userAgent ?? "", url);
  return { url, finalUrl: url, status, headers: status === 403 ? { "cf-mitigated": "challenge" } : {}, body: status === 403 ? "<title>Just a moment</title>" : "<html><body><main>ok</main></body></html>" };
};
it("reports each agent's robots permission and live result", async () => {
  const r = await probeAiCrawlers("https://x.com", ["https://x.com/", "https://x.com/a"], robots, site((ua) => (/PerplexityBot/.test(ua) ? 403 : 200)));
  const perplexity = r.find((p) => p.agent === "PerplexityBot")!;
  assert.deepEqual(perplexity, { agent: "PerplexityBot", allowedByRobots: true, fetched: 2, refused: 2, of: 2, challenge: true });
  assert.equal(r.find((p) => p.agent === "GPTBot")!.fetched, 0, "robots-blocked agents are not fetched");
  assert.equal(r.find((p) => p.agent === "OAI-SearchBot")!.refused, 0);
});
it("does not treat one refused URL as a policy", async () => {
  const r = await probeAiCrawlers("https://x.com", ["https://x.com/", "https://x.com/a"], robots, site((ua, url) => (/ClaudeBot/.test(ua) && url.endsWith("/a") ? 429 : 200)));
  assert.equal(r.find((p) => p.agent === "ClaudeBot")!.refused, 1);
});
it("probes the host: www duplicate, http redirect, hsts, llms.txt", async () => {
  const fetcher: Fetcher = async (url) => url.startsWith("http://") ? { url, finalUrl: "https://x.com/", status: 200, headers: {}, body: "" }
    : url.includes("www.") ? { url, finalUrl: url, status: 200, headers: {}, body: "<html/>" }
    : url.endsWith("/llms.txt") ? { url, finalUrl: url, status: 200, headers: {}, body: "# X\n> about\n## Docs\n- [a](/a)" }
    : { url, finalUrl: url, status: 200, headers: { "strict-transport-security": "max-age=1" }, body: "<html/>" };
  assert.deepEqual(await probeHost("https://x.com", fetcher), { wwwDuplicate: true, httpRedirected: true, hsts: true, llmsTxt: "present" });
});
```

In `pipeline.test.ts`, using `fixtureSite()` from Task 2:

```ts
const probe = (ai: AiProbe[], host: Partial<HostProbe> = {}, robotsReadable = true) => ({ ai, host: { wwwDuplicate: false, httpRedirected: true, hsts: true, llmsTxt: "present" as const, ...host }, robotsReadable });
const run = (hostProbe: ReturnType<typeof probe>) => runFullAnalysis({ analysisId: "a", siteId: "s", name: "Clinic", baseUrl: "https://clinic.example", fetcher: fixtureSite(), repeatability: false, maxPages: 5, hostProbe });
const ids = async (hostProbe: ReturnType<typeof probe>) => (await run(hostProbe)).findings.map((f) => f.checkId);

it("reports a firewall that refuses a search crawler robots.txt allows", async () => {
  assert.ok((await ids(probe([{ agent: "PerplexityBot", allowedByRobots: true, fetched: 3, refused: 3, of: 3, challenge: true }]))).includes("ai.crawler_refused"));
  assert.ok(!(await ids(probe([{ agent: "PerplexityBot", allowedByRobots: true, fetched: 3, refused: 1, of: 3, challenge: false }]))).includes("ai.crawler_refused"), "one refused URL is rate limiting");
  assert.ok(!(await ids(probe([{ agent: "GPTBot", allowedByRobots: true, fetched: 3, refused: 3, of: 3, challenge: false }]))).includes("ai.crawler_refused"), "training crawlers are not scored");
});
it("reports the host checks", async () => {
  const found = await ids(probe([], { wwwDuplicate: true, httpRedirected: false, hsts: false, llmsTxt: "malformed" }));
  for (const id of ["server.www_duplicate", "server.http_not_redirected", "security.hsts_missing", "ai.llms_txt_format"]) assert.ok(found.includes(id), id);
  assert.ok((await ids(probe([], { llmsTxt: "missing" }))).includes("ai.llms_txt"));
});
it("skips the crawler probe when robots.txt could not be read", async () => {
  const report = await run(probe([], {}, false));
  assert.deepEqual(report.audit.checks.find((r) => r.id === "ai.crawler_refused"), { id: "ai.crawler_refused", status: "skipped", reason: "robots.txt could not be read" });
});
```

(The last test needs Task 8; write it now and expect it to fail until then, or move it into Task 8's Step 1.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @organic-growth/crawler`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ai-agents.ts`:

```ts
/** The agents the analysis fetches as, with the user-agent string each vendor documents. Search-facing ones feed answers; the training ones are probed so a firewall policy is visible, never scored. */
export const AI_PROBE_AGENTS: Array<{ agent: string; userAgent: string; search: boolean }> = [
  { agent: "OAI-SearchBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", search: true },
  { agent: "ChatGPT-User", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", search: true },
  { agent: "PerplexityBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", search: true },
  { agent: "Claude-SearchBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot)", search: true },
  { agent: "Claude-User", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +https://www.anthropic.com/claude-user)", search: true },
  { agent: "GPTBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot", search: false },
  { agent: "ClaudeBot", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", search: false },
];
```

`probe.ts`:

```ts
import { AI_PROBE_AGENTS } from "@organic-growth/core";
import { isBotChallenge, type Fetcher } from "./index.js";
import { parseRobots } from "./robots.js";

export type AiProbe = { agent: string; allowedByRobots: boolean; fetched: number; refused: number; of: number; challenge: boolean };
export type HostProbe = { wwwDuplicate: boolean; httpRedirected: boolean | null; hsts: boolean; llmsTxt: "missing" | "present" | "malformed" };

const REFUSED = new Set([401, 403, 429, 503]);

/** Fetches each URL as each AI agent robots.txt allows, concurrency 6, and counts refusals and challenge pages. */
export async function probeAiCrawlers(baseUrl: string, urls: string[], robotsTxt: string | null, fetcher: Fetcher): Promise<AiProbe[]> {
  const jobs = AI_PROBE_AGENTS.map((entry) => {
    const policy = robotsTxt ? parseRobots(robotsTxt, entry.agent.toLowerCase(), { exact: true }) : null;
    const allowed = urls.filter((url) => !policy || policy.isAllowed(new URL(url).pathname));
    return { entry, allowedByRobots: !policy || policy.isAllowed("/"), allowed };
  });
  const out: AiProbe[] = [];
  for (const job of jobs) {
    let refused = 0, challenge = false;
    const results = await Promise.all(job.allowed.map((url) => fetcher(url, { userAgent: job.entry.userAgent }).catch(() => null)));
    for (const r of results) {
      if (!r) { refused++; continue; }
      if (REFUSED.has(r.status)) { refused++; if (isBotChallenge(r)) challenge = true; }
    }
    out.push({ agent: job.entry.agent, allowedByRobots: job.allowedByRobots, fetched: job.allowed.length, refused, of: urls.length, challenge });
  }
  return out;
}

const looksLikeLlms = (body: string) => /^\s*#\s+\S/.test(body) && !/^\s*<(!doctype|html)/i.test(body);

export async function probeHost(baseUrl: string, fetcher: Fetcher): Promise<HostProbe> {
  const origin = new URL(baseUrl);
  const other = new URL(baseUrl); other.hostname = origin.hostname.startsWith("www.") ? origin.hostname.slice(4) : `www.${origin.hostname}`;
  const [home, alt, http, llms] = await Promise.all([
    fetcher(origin.origin + "/").catch(() => null),
    fetcher(other.origin + "/").catch(() => null),
    origin.protocol === "https:" ? fetcher(`http://${origin.host}/`).catch(() => null) : Promise.resolve(null),
    fetcher(`${origin.origin}/llms.txt`, { maxBytes: 200_000 }).catch(() => null),
  ]);
  const sameHost = (a?: string, b?: string) => Boolean(a && b && new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""));
  return {
    wwwDuplicate: Boolean(alt && alt.status === 200 && new URL(alt.finalUrl).hostname === other.hostname),
    httpRedirected: http ? Boolean(http.finalUrl.startsWith("https://") && sameHost(http.finalUrl, baseUrl)) : null,
    hsts: Boolean(home?.headers["strict-transport-security"]),
    llmsTxt: !llms || llms.status !== 200 || !llms.body.trim() ? "missing" : looksLikeLlms(llms.body) ? "present" : "malformed",
  };
}
```

Note `defaultFetcher` throws on a cross-site redirect; the www probe is same-site by `isSameSite` (www is ignored), and the http probe too, so both resolve. Concurrency: the agents run one after another with each agent's URLs in parallel, 6 at most since URLs are at most 6.

Two workflow steps after the crawl loop and before `list-competitors`. First, coverage gets its own step so its queries have their own budget (the analysis step then uses `coverage` from this step's output instead of calling `getCrawlCoverage`; the not-found probe moves here too because coverage needs its title):

```ts
      const { coverage, notFoundProbe } = await step.do("coverage", { retries: { limit: 2, delay: "5 seconds" } }, async () => {
        const probe = await probeNotFound(site.baseUrl, analysisId).catch(() => undefined);
        return { notFoundProbe: probe, coverage: await getCrawlCoverage(db, analysisId, { notFoundTitle: probeTitleForCoverage(probe) }) };
      });
```

Then the probe:

```ts
      const hostProbe = await step.do("probe-ai-crawlers", { retries: { limit: 1, delay: "10 seconds" } }, async () => {
        await progress("probe", "Checking how AI crawlers and the host answer");
        const [robots, sample] = await Promise.all([
          defaultFetcher(new URL("/robots.txt", site.baseUrl).toString(), { maxBytes: 500_000 }).catch(() => null),
          listCrawlPageResults(db, analysisId, 50),
        ]);
        const state = robotsState(robots);
        const urls = [new URL("/", site.baseUrl).toString(), ...samplePerFamily(sample.filter((p) => p.status < 400 && !p.isEmptyShell && p.routeFamily !== "home").map((p) => p.url), 1, 5)];
        const ai = state.robots === "unreadable" ? [] : await probeAiCrawlers(site.baseUrl, urls, state.body ?? null, defaultFetcher);
        return { ai, host: await probeHost(site.baseUrl, defaultFetcher), robotsReadable: state.robots !== "unreadable" };
      });
```

It makes at most 1 + 42 + 4 = 47 fetches, under the Free plan's 50 subrequests a step (D1 calls are internal and do not count). Pass `hostProbe` into `runFullAnalysis`. There, `aiReadiness.probe = input.hostProbe?.ai`, and the host findings in `tech-seo.ts` (new input `hostProbe`): `server.www_duplicate` (impact 40), `server.http_not_redirected` (impact 70, only when `httpRedirected === false`), `security.hsts_missing` (impact 10), and in `ai-findings.ts`: `ai.llms_txt` (impact 5, title "No llms.txt" / summary states it is optional and unproven), `ai.llms_txt_format` (impact 5), `ai.crawler_refused` (impact 75; agents with `search && allowedByRobots && fetched > 0 && refused === fetched`; summary names them and "Cloudflare's AI crawler setting is blocking it" when `challenge`).

- [ ] **Step 4: Run tests**

Run: `npm run build:packages && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ai-agents.ts packages/crawler/src apps/web/src/analysis-workflow.ts packages/agents/src
git commit -m "Probe step: AI crawlers as each agent, www and HTTP redirects, HSTS, llms.txt"
```

---

### Task 8: Health scores, the audit table and the ledger

**Files:**
- Create: `packages/core/src/checks/health.ts`, `packages/agents/src/audit.ts`
- Modify: `packages/agents/src/pipeline.ts` (return `audit`), `packages/db/src/metrics.ts:216-245` (`analysisHealthPoints`), `packages/core/src/results.ts:102` (`METRICS.analysis`)
- Test: `packages/core/src/checks/health.test.ts`, `packages/agents/src/audit.test.ts`, `packages/db/src/metrics.test.ts`

**Interfaces:**
- Produces: `healthScore({ indexable, unhealthy, siteErrors }): number | null`; `PAGE_ERROR_CHECKS: Record<Pillar, string[]>` (the check ids whose SQL feeds the unhealthy sums); `auditTable(input: { findings: Finding[]; coverage?: CrawlCoverage; hostProbe?: …; hasRepo: boolean; hasSearch: boolean; hasLogs: boolean; hasDataset: boolean; rendered: boolean; languages: number; hasDataForSeo: boolean }): AuditRow[]`; `AuditRow = { id: string; status: "passed" | "failed" | "skipped"; pages?: number; reason?: string }`; `report.audit: { seo: Score; ai: Score; checks: AuditRow[] }`, `Score = { value: number | null; indexable: number; unhealthy: number; reason?: string }`.

- [ ] **Step 1: Write the failing tests**

`health.test.ts`:

```ts
it("is the share of healthy indexable pages, null without pages, zero with a site error", () => {
  assert.equal(healthScore({ indexable: 100, unhealthy: 3, siteErrors: 0 }), 97);
  assert.equal(healthScore({ indexable: 3, unhealthy: 1, siteErrors: 0 }), 66.7);
  assert.equal(healthScore({ indexable: 0, unhealthy: 0, siteErrors: 0 }), null);
  assert.equal(healthScore({ indexable: 100, unhealthy: 0, siteErrors: 1 }), 0);
});
it("names the page-level error checks per pillar from the registry", () => {
  for (const pillar of ["seo", "ai"] as const) for (const id of PAGE_ERROR_CHECKS[pillar]) {
    const check = CHECKS[id]!; assert.equal(check.class, "error"); assert.equal(check.scope, "page"); assert.ok(check.pillars.includes(pillar));
  }
  const expected = checkList().filter((c) => c.class === "error" && c.scope === "page" && c.sources.includes("crawl")).map((c) => c.id);
  for (const id of expected) assert.ok(PAGE_ERROR_CHECKS.seo.includes(id) || PAGE_ERROR_CHECKS.ai.includes(id) || id in UNSCORED_PAGE_ERRORS, `${id} is an error-class page check the score ignores without saying why`);
});
```

`audit.test.ts`:

```ts
it("lists every check as passed, failed or skipped", () => {
  const rows = auditTable({ findings: [finding(CHECKS["title.weak"]!, { siteId: "s", analysisId: "a", title: "t", summary: "s", evidence: {}, impact: 50, pagesAffected: ["u1", "u2"] })], coverage: { completedUrls: 10, totalUrls: 10, failedUrls: 0, pendingUrls: 0, emptyShellUrls: 0, httpErrorUrls: 0, missingTitleUrls: 2, issues: { titleLength: 0 }, health: { indexable: 10, unhealthySeo: 2, unhealthyAi: 0, checked: true } }, hasRepo: false, hasSearch: false, hasLogs: false, hasDataset: false, rendered: true, languages: 1, hasDataForSeo: false, robotsReadable: true });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(rows.length, checkList().length);
  assert.deepEqual(by["title.weak"], { id: "title.weak", status: "failed", pages: 2 });
  assert.deepEqual(by["title.length"], { id: "title.length", status: "passed" });
  assert.deepEqual(by["repo.client_rendered"], { id: "repo.client_rendered", status: "skipped", reason: "a connected repository" });
  assert.deepEqual(by["hreflang.missing"], { id: "hreflang.missing", status: "skipped", reason: "two or more languages" });
});
const ctx = (over: Partial<AuditContext> = {}): AuditContext => ({ findings: [], coverage: { completedUrls: 10, totalUrls: 10, failedUrls: 0, pendingUrls: 0, emptyShellUrls: 0, httpErrorUrls: 0, missingTitleUrls: 0, issues: {}, health: { indexable: 10, unhealthySeo: 0, unhealthyAi: 0, checked: true } }, hasRepo: false, hasSearch: false, hasLogs: false, hasDataset: false, rendered: false, languages: 1, hasDataForSeo: false, robotsReadable: true, ...over });
it("marks the new crawl checks skipped when the crawl predates the new fields", () => {
  const old = ctx({ coverage: { ...ctx().coverage!, health: { indexable: 10, unhealthySeo: 0, unhealthyAi: 0, checked: false } } });
  const row = auditTable(old).find((r) => r.id === "content.thin")!;
  assert.deepEqual(row, { id: "content.thin", status: "skipped", reason: "run a full crawl once after deploying" });
  assert.equal(auditTable(old).find((r) => r.id === "heading.h1_missing")!.status, "passed", "checks that existed before still run");
  assert.deepEqual(pillarScores(old).seo, { value: null, indexable: 10, unhealthy: 0, reason: "run a full crawl once after deploying" });
});
it("skips the crawler probe when robots.txt was unreadable, without nulling the AI score", () => {
  const unreadable = ctx({ robotsReadable: false });
  assert.deepEqual(auditTable(unreadable).find((r) => r.id === "ai.crawler_refused"), { id: "ai.crawler_refused", status: "skipped", reason: "robots.txt could not be read" });
  assert.equal(pillarScores(unreadable).ai.value, 100);
});
it("zeroes the AI score only when every search crawler robots.txt allows is refused", () => {
  const refused = finding(CHECKS["ai.crawler_refused"]!, { siteId: "s", analysisId: "a", title: "PerplexityBot is refused", summary: "", evidence: {}, impact: 75 });
  const some = { ai: [{ agent: "PerplexityBot", allowedByRobots: true, fetched: 2, refused: 2 }, { agent: "OAI-SearchBot", allowedByRobots: true, fetched: 2, refused: 0 }] };
  assert.equal(pillarScores(ctx({ findings: [refused] }), some).ai.value, 100);
  const all = { ai: some.ai.map((a) => ({ ...a, refused: a.fetched })) };
  assert.deepEqual(pillarScores(ctx({ findings: [refused] }), all).ai, { value: 0, indexable: 10, unhealthy: 0, reason: "PerplexityBot is refused" });
});
```

`metrics.test.ts`: a report with `audit: { seo: { value: 82.5, indexable: 200, unhealthy: 35 }, ai: { value: 64, indexable: 200, unhealthy: 72 } }` yields points `health_seo 82.5`, `health_ai 64`, `health_pages 200`, `health_unhealthy_seo 35`, `health_unhealthy_ai 72`; a report without `audit` yields none of them.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @organic-growth/core`
Expected: FAIL.

- [ ] **Step 3: Implement `health.ts`**

```ts
import type { Pillar } from "./types.js";

/** Share of indexable crawled pages with no error-class issue in the pillar, 0–100 with one decimal; null without pages; 0 when a site-wide error of the pillar stands. */
export function healthScore(input: { indexable: number; unhealthy: number; siteErrors: number }): number | null {
  if (input.indexable <= 0) return null;
  if (input.siteErrors > 0) return 0;
  return Math.round(((input.indexable - Math.min(input.unhealthy, input.indexable)) / input.indexable) * 1000) / 10;
}

/** The page-level error checks each pillar's unhealthy count is built from (the SQL in packages/db mirrors this list; the test keeps them equal). */
export const PAGE_ERROR_CHECKS: Record<Pillar, string[]> = {
  seo: ["http.error", "render.empty_shell", "access.bot_challenge", "content.soft_404", "security.mixed_content", "http.redirect_chain", "http.meta_refresh", "title.weak", "sitemap.blocked"],
  ai: ["http.error", "render.empty_shell", "access.bot_challenge", "ai.snippet_blocked"],
};

/** Error-class page checks that do not feed the score, and why. */
export const UNSCORED_PAGE_ERRORS: Record<string, string> = {
  // ponytail: a page with a broken outbound link is not itself broken; counting it needs a link join inside the coverage query.
  "links.broken_internal": "Counted per source page outside the coverage query; the broken target is already counted as an HTTP error.",
  "sitemap.blocked": "Blocked URLs are not fetched, so they are never indexable pages.",
};
```

Drop `sitemap.blocked` from the seo list above. `SEO_ERRORS`/`AI_ERRORS` in Task 5 match these lists exactly.

- [ ] **Step 4: Implement `audit.ts` and the pipeline output**

```ts
import { CHECKS, checkList, healthScore, type CrawlCoverage, type Finding } from "@organic-growth/core";

export type AuditRow = { id: string; status: "passed" | "failed" | "skipped"; pages?: number; reason?: string };
export type Score = { value: number | null; indexable: number; unhealthy: number; reason?: string };

export type AuditContext = { findings: Finding[]; coverage?: CrawlCoverage; hasRepo: boolean; hasSearch: boolean; hasLogs: boolean; hasDataset: boolean; rendered: boolean; languages: number; hasDataForSeo: boolean; robotsReadable: boolean };

const RECRAWL = "run a full crawl once after deploying";
const NEW_ISSUE_CHECKS = new Set(["http.redirect_chain", "http.meta_refresh", "security.mixed_content", "security.http_links", "title.length", "description.length", "description.duplicate", "heading.h1_equals_title", "heading.skipped_levels", "html.lang_missing", "html.viewport_missing", "image.alt_missing", "content.thin", "url.year_in_slug", "ai.snippet_blocked", "ai.stale", "ai.no_date", "ai.no_answer_structure", "ai.low_evidence", "ai.no_author", "ai.semantic_html_missing", "ai.no_entity_schema", "links.broken_internal", "links.orphan", "links.single_inbound", "links.depth"]);

export function auditTable(ctx: AuditContext): AuditRow[] {
  const failed = new Map<string, number>();
  for (const f of ctx.findings) if (f.checkId) failed.set(f.checkId, (failed.get(f.checkId) ?? 0) + (f.pagesAffected?.length ?? 0));
  const issues = (ctx.coverage?.issues ?? {}) as Record<string, number | undefined>;
  return checkList().map((check) => {
    // Coverage counts every page; pagesAffected holds examples only.
    if (failed.has(check.id)) return { id: check.id, status: "failed", pages: (check.issue && issues[check.issue]) || failed.get(check.id)! };
    const skip = (reason: string): AuditRow => ({ id: check.id, status: "skipped", reason });
    const needs = check.requires ?? "";
    if (/repository/.test(needs) && !ctx.hasRepo) return skip(needs);
    if (/Search Console/.test(needs) && !ctx.hasSearch) return skip(needs);
    if (/server logs/.test(needs) && !ctx.hasLogs) return skip(needs);
    if (/dataset/.test(needs) && !ctx.hasDataset) return skip(needs);
    if (/languages/.test(needs) && ctx.languages < 2) return skip(needs);
    if (/DataForSEO/.test(needs) && !ctx.hasDataForSeo) return skip(needs);
    if (/browser render/.test(needs) && !ctx.rendered) return skip(needs);
    if (check.sources.includes("crawl") && !ctx.coverage?.completedUrls) return skip("a full crawl");
    if (NEW_ISSUE_CHECKS.has(check.id) && ctx.coverage && !ctx.coverage.health?.checked) return skip(RECRAWL);
    if (check.id === "ai.crawler_refused" && !ctx.robotsReadable) return skip("robots.txt could not be read");
    if (check.id === "links.depth" && ctx.coverage?.linkGraph?.depth?.skipped) return skip(ctx.coverage.linkGraph.depth.skipped);
    return { id: check.id, status: "passed" };
  });
}

export function pillarScores(ctx: AuditContext, probe?: { ai: Array<{ agent: string; allowedByRobots: boolean; fetched: number; refused: number }> }): { seo: Score; ai: Score } {
  const h = ctx.coverage?.health;
  const siteError = (pillar: "seo" | "ai") => ctx.findings.find((f) => f.checkId && CHECKS[f.checkId]!.scope === "site" && CHECKS[f.checkId]!.class === "error" && CHECKS[f.checkId]!.pillars.includes(pillar) && f.checkId !== "ai.crawler_refused");
  const allRefused = Boolean(probe?.ai.length) && probe!.ai.filter((a) => a.allowedByRobots && a.fetched > 0).every((a) => a.refused === a.fetched);
  const score = (pillar: "seo" | "ai", unhealthy: number): Score => {
    const blocker = siteError(pillar) ?? (pillar === "ai" && allRefused ? ctx.findings.find((f) => f.checkId === "ai.crawler_refused") : undefined);
    if (!h?.checked) return { value: null, indexable: h?.indexable ?? 0, unhealthy, reason: h ? RECRAWL : "no finished full crawl" };
    return { value: healthScore({ indexable: h.indexable, unhealthy, siteErrors: blocker ? 1 : 0 }), indexable: h.indexable, unhealthy, ...(blocker ? { reason: blocker.title } : {}) };
  };
  return { seo: score("seo", h?.unhealthySeo ?? 0), ai: score("ai", h?.unhealthyAi ?? 0) };
}
```

In `runFullAnalysis`, build `ctx` from the inputs (`hasRepo: Boolean(repo)`, `hasSearch: searchMetrics.length > 0`, `hasLogs: Boolean(input.connectors?.logCoverage)`, `hasDataset: (input.datasets ?? []).length > 0`, `rendered: comparisons.length > 0`, `languages: input.crawlCoverage?.coverage.locales?.length ?? 1`, `hasDataForSeo: Boolean(input.keywords)`, `robotsReadable: input.hostProbe?.robotsReadable ?? aiAccess.robots !== "unreadable"`) and return `audit: { ...pillarScores(ctx, input.hostProbe), checks: auditTable(ctx) }`.

`metrics.ts`: add `auditPoints(report, day)` returning the five metrics when `report.audit` exists (`value` null → no `health_*` point for that pillar, the counts still written), spread into `analysisHealthPoints`. `METRICS.analysis` adds `"health_seo", "health_ai", "health_pages", "health_unhealthy_seo", "health_unhealthy_ai"`.

- [ ] **Step 5: Run tests**

Run: `npm run build:packages && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/agents/src packages/db/src
git commit -m "Health scores per pillar, the audit table on every report, ledger points"
```

---

### Task 9: Dashboard: score tiles, Checks cards, check names on findings

**Files:**
- Modify: `apps/web/app/components/report-model.ts` (types, `pillarOf`), `apps/web/app/components/ReportTabs.tsx` (`TechnicalTab`, `AiReadinessCard`, `FindingRow`), `apps/web/app/components/OverviewView.tsx` (tiles row beside `KeyNumbers`), `apps/web/app/components/HistoryPanel.tsx` (check names), `packages/core/src/results.ts` (`health.seo`, `health.ai` series compare)
- Create: `apps/web/app/components/ChecksCard.tsx`
- Test: `apps/web/app/components/report-model.test.ts`

**Interfaces:**
- Consumes: `report.audit`, `CHECKS` from core (the web app already imports core types; import the value from `@organic-growth/core`).
- Produces: `pillarOf(finding): "seo" | "ai" | null`; `checksFor(report, pillar): Array<{ check: Check; row: AuditRow; finding?: Finding }>` grouped by class; `<ChecksCard pillar report />`; `<HealthTiles report results onTab />`.

- [ ] **Step 1: Write the failing tests** (`report-model.test.ts`)

```ts
it("derives the pillar from the check id, else from the category for old reports", () => {
  assert.equal(pillarOf({ category: "metadata", checkId: "title.weak" } as Finding), "seo");
  assert.equal(pillarOf({ category: "ai_visibility" } as Finding), "ai");
  assert.equal(pillarOf({ category: "conversion" } as Finding), null);
  assert.equal(pillarOf({ category: "content", checkId: "ai.stale" } as Finding), "ai");
});
it("groups a pillar's checks by class with the finding attached", () => {
  const report = { findings: [{ id: "f", category: "metadata", severity: "HIGH", title: "t", summary: "s", organicImpactScore: 70, checkId: "title.weak" }], audit: { seo: { value: 90, indexable: 10, unhealthy: 1 }, ai: { value: null, indexable: 0, unhealthy: 0, reason: "no finished full crawl" }, checks: [{ id: "title.weak", status: "failed", pages: 1 }, { id: "title.length", status: "passed" }, { id: "ai.stale", status: "skipped", reason: "x" }] } } as unknown as Report;
  const groups = checksFor(report, "seo");
  assert.equal(groups.error.find((r) => r.check.id === "title.weak")!.finding!.id, "f");
  assert.ok(groups.warning.some((r) => r.check.id === "title.length" && r.row.status === "passed"));
  assert.ok(!Object.values(groups).flat().some((r) => r.check.id === "ai.stale"));
  assert.deepEqual(auditCounts(report), { checks: 3, passed: 1, failed: 1, skipped: 1 });
});
it("gives an old report no audit", () => { assert.equal(auditCounts({ findings: [] } as unknown as Report), null); });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @organic-growth/web`
Expected: FAIL.

- [ ] **Step 3: Implement the model**

In `report-model.ts`:

```ts
import { CHECKS, type Check } from "@organic-growth/core";
export type Finding = { id: string; category: string; severity: string; title: string; summary: string; recommendation?: string; organicImpactScore: number; checkId?: string; pagesAffected?: string[] };
export type AuditRow = { id: string; status: "passed" | "failed" | "skipped"; pages?: number; reason?: string };
export type Score = { value: number | null; indexable: number; unhealthy: number; reason?: string };
// Report: add `audit?: { seo: Score; ai: Score; checks: AuditRow[] }` to Later.

export const pillarOf = (finding: Pick<Finding, "category" | "checkId">): "seo" | "ai" | null => {
  const check = finding.checkId ? CHECKS[finding.checkId] : undefined;
  if (check) return check.pillars.includes("ai") && !check.pillars.includes("seo") ? "ai" : check.pillars.length ? "seo" : null;
  return finding.category === "ai_visibility" ? "ai" : finding.category === "conversion" ? null : "seo";
};

export type CheckRow = { check: Check; row: AuditRow; finding?: Finding };
export function checksFor(report: Report, pillar: "seo" | "ai"): Record<"error" | "warning" | "notice", CheckRow[]> {
  const groups = { error: [] as CheckRow[], warning: [] as CheckRow[], notice: [] as CheckRow[] };
  for (const row of report.audit?.checks ?? []) {
    const check = CHECKS[row.id]; if (!check || !check.pillars.includes(pillar)) continue;
    groups[check.class].push({ check, row, finding: report.findings.find((f) => f.checkId === row.id) });
  }
  const order = { failed: 0, skipped: 2, passed: 1 };
  for (const list of Object.values(groups)) list.sort((a, b) => order[a.row.status] - order[b.row.status] || a.check.name.localeCompare(b.check.name));
  return groups;
}
export const auditCounts = (report: Report) => report.audit ? { checks: report.audit.checks.length, passed: report.audit.checks.filter((r) => r.status === "passed").length, failed: report.audit.checks.filter((r) => r.status === "failed").length, skipped: report.audit.checks.filter((r) => r.status === "skipped").length } : null;
```

- [ ] **Step 4: Build the components**

`ChecksCard.tsx`: a `Card` titled "Checks" with subtitle "Every check for this pillar: what failed, what passed, what could not run." and the counts pill. Three `details` groups (Errors, Warnings, Notices) each a `table.table` with columns Check, Result, Pages; a failed row links `#finding-<id>` (add `id={`finding-${finding.id}`}` to `FindingRow`'s wrapper); a skipped row shows the reason in `small muted`; a passed row's name carries `title={check.docs.what}`. Empty state when `report.audit` is missing: "Run an analysis to see every check." Pillar `ai` renders the same from `checksFor(report, "ai")`.

`HealthTiles` (in `OverviewView.tsx` next to `KeyNumbers`): two `Kpi`s, "SEO health" and "AI visibility health", value `score.value === null ? "—" : score.value.toFixed(0)`, caption: the reason when there is one, else the 28-day change from `results.data.results.health` series (add `healthSeo`/`healthAi` to the Results view in `results.ts` from `series.health_seo`/`series.health_ai` with `compare()`), else "No earlier analysis to compare". Clicking a tile calls `onTab("technical")` / `onTab("ai")`. Below: the line "71 checks · 58 passed · 9 failed · 4 not run" from `auditCounts`, or "Run an analysis to score the site".

For the AI tile, when `report.aiReadiness.probe` has entries, the caption is "N of M AI search crawlers can read the site" (search-facing agents allowed by robots.txt and not refused on every URL, of those probed) unless the score has a reason.

`HistoryPanel.tsx`: label each resolution with the check's name when its key starts with a registered id (`CHECKS[row.key.split("|")[0]]?.name`), before the title.

`TechnicalTab`: render `<ChecksCard pillar="seo" report={report} />` above the "Fixes" card. `AiReadinessCard`: render `<ChecksCard pillar="ai" report={report} />` after the KPI grid, and change the FAQ KPI label to "Pages with Q&A markup" with caption "No longer a Google rich result; still a structure signal". `FindingRow` and the AI tab's `WhyRow` show `CHECKS[finding.checkId]?.name` as a small label before the title when present.

- [ ] **Step 5: Typecheck and test**

Run: `npm run build:packages && npm run typecheck -w @organic-growth/web && npm run test -w @organic-growth/web`
Expected: PASS. Then `npm run dev` and open a demo site: the tiles show, the Checks cards render on both tabs.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components
git commit -m "Dashboard: health tiles, Checks cards on the Technical and AI tabs, check names on findings"
```

---

### Task 10: Generated Checks docs page

**Files:**
- Create: `docs/site/pages/checks.head.html`
- Modify: `docs/site/build.mjs` (ORDER, generator), `docs/site/pages/findings.html` (drop the catalogue, link to Checks), `docs/site/CONVENTIONS.md` (one paragraph on the generated page)
- Test: the build itself (`node docs/site/build.mjs` exits 0 and the page lists every id), plus a guard test in `packages/core/src/checks/checks.test.ts` already covering docs.

- [ ] **Step 1: Write `checks.head.html`**

```html
<article id="checks" data-title="Checks" data-group="Reference">
  <h1>Checks</h1>
  <p class="lede">Every check the analysis runs, generated from the registry in <code class="path">packages/core/src/checks/catalog.ts</code>, and the checks Eumon deliberately does not run.</p>
  <h2 id="class-and-severity">Class and severity</h2>
  <p>Each check has a <strong>class</strong> (error, warning or notice) that decides whether a failed page counts against the health score: only error-class page checks do, and only on indexable pages. Each <strong>finding</strong> has a <strong>severity</strong> (CRITICAL to INFORMATIONAL) from its organic impact score, which ranks the growth plan. The two are separate on purpose: a warning on ten thousand pages is urgent for the plan, but it does not make the site unhealthy. The health score is the share of indexable pages with no error-class issue; a site-wide error makes it zero and the tile says why.</p>
  <!--CHECKS-->
</article>
```

- [ ] **Step 2: Generate in `build.mjs`**

Add `"checks"` to `ORDER` after `"findings"`. Before the `pages` map:

```js
const checksDist = join(here, "../../packages/core/dist/checks/index.js");
let checks = null;
if (existsSync(checksDist)) checks = await import(pathToFileURL(checksDist).href);
else problems.push("missing packages/core/dist: run `npm run build -w @organic-growth/core`, then build again");

function checksPage(head) {
  if (!checks) return head.replace("<!--CHECKS-->", "");
  const list = checks.checkList();
  const bad = list.filter((c) => ["what", "why", "how", "severity"].some((k) => !c.docs[k] || c.docs[k].trim().length < 20));
  for (const c of bad) problems.push(`check ${c.id} is missing docs`);
  const byPillar = { seo: list.filter((c) => c.pillars.includes("seo")), ai: list.filter((c) => c.pillars.includes("ai") && !c.pillars.includes("seo")), none: list.filter((c) => !c.pillars.length) };
  const section = (id, title, items) => {
    const cats = [...new Set(items.map((c) => c.category))];
    return `<h2 id="${id}">${esc(title)} (${items.length})</h2>` + cats.map((cat) => {
      const rows = items.filter((c) => c.category === cat);
      return `<h3>${esc(cat)}</h3><table><thead><tr><th>Check</th><th>Class</th><th>Scope</th><th>Source</th><th>Fix</th><th>Needs</th></tr></thead><tbody>${rows.map((c) =>
        `<tr><td><code>${esc(c.id)}</code><br>${esc(c.name)}</td><td>${esc(c.class)}${c.docs.unscored ? " (unscored)" : ""}</td><td>${esc(c.scope)}</td><td>${esc(c.sources.join(", "))}</td><td>${esc(c.fix)}</td><td>${esc(c.requires ?? "")}</td></tr>`).join("")}</tbody></table>`
        + `<dl>${rows.map((c) => `<dt id="check-${esc(c.id).replaceAll(".", "-")}">${esc(c.name)} <code>${esc(c.id)}</code></dt><dd><p><strong>What.</strong> ${esc(c.docs.what)}</p><p><strong>Why.</strong> ${esc(c.docs.why)}</p><p><strong>Fix.</strong> ${esc(c.docs.how)}</p><p><strong>Severity.</strong> ${esc(c.docs.severity)}</p></dd>`).join("")}</dl>`;
    }).join("");
  };
  const notRun = `<h2 id="not-run">Checks Eumon does not run</h2><dl>${checks.NOT_RUN.map((e) => `<dt>${esc(e.name)}</dt><dd>${esc(e.why)}</dd>`).join("")}</dl>`;
  return head.replace("<!--CHECKS-->", section("seo-checks", "SEO", byPillar.seo) + section("ai-checks", "AI visibility", byPillar.ai) + section("unscored-checks", "Shown, never scored", byPillar.none) + notRun);
}
```

In the `pages` map, read `checks.head.html` when `slug === "checks"` and pass it through `checksPage` before the other transforms. Import `pathToFileURL` from `node:url`.

- [ ] **Step 3: Trim `findings.html`**

Replace its per-producer catalogue sections with one paragraph: "Every finding comes from a registered check; the Checks page lists them with class, scope, fix kind and docs." linking `<a href="#checks">`. Keep the Finding type, severity formula, ranking and "how they are combined" sections, and add `checkId` and `scopeKey` to the type listing, and a sentence on `keyOf` replacing `findingKey` for History.

- [ ] **Step 4: Build and check**

Run: `npm run build -w @organic-growth/core && node docs/site/build.mjs && grep -c 'id="check-' docs/site/dist/eumon-docs.html`
Expected: the build prints 15 pages and exits 0; the grep count is 89.

- [ ] **Step 5: Commit**

```bash
git add docs/site
git commit -m "Docs: Checks page generated from the registry; findings page points at it"
```

---

### Task 11: Demo site failures and the demo test

**Files:**
- Modify: `packages/agents/src/demo.ts` (`demoResponse`, `demoFetcher`, `relatedLinks`, `document`), `packages/agents/src/demo.test.ts`, `apps/web/src/analysis-workflow.ts` is not involved (the demo runs `analyzeDemo`): pass a `hostProbe` built with `probeAiCrawlers`/`probeHost` over `demoFetcher` in `analyzeDemo`.

- [ ] **Step 1: Write the failing test**

```ts
it("shows every new check at least once, and both health scores", async () => {
  const report = (await getAnalysisJob(db, "analysis_demo_2"))!.report as { findings: Array<{ checkId?: string }>; audit: { seo: { value: number | null }; ai: { value: number | null }; checks: Array<{ id: string; status: string }> } };
  const failed = new Set(report.findings.map((f) => f.checkId));
  for (const id of ["http.redirect_chain", "security.mixed_content", "ai.snippet_blocked", "links.orphan", "links.broken_internal", "ai.stale", "ai.no_author", "url.year_in_slug", "security.hsts_missing", "ai.crawler_refused", "image.alt_missing", "title.length"]) assert.ok(failed.has(id), id);
  assert.ok(typeof report.audit.seo.value === "number" && report.audit.seo.value > 0 && report.audit.seo.value < 100, String(report.audit.seo.value));
  assert.ok(typeof report.audit.ai.value === "number" && report.audit.ai.value > 0, String(report.audit.ai.value));
  assert.equal(report.audit.checks.length, 89);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @organic-growth/agents`
Expected: FAIL.

- [ ] **Step 3: Add the failures to the demo**

- `document()`: blog posts get `<img src="http://img.demo-clinic.example/hero.jpg">` (mixed content, no alt) in the body; every third post (by its index in `BLOG`) gets `jsonLd: { "@context": "https://schema.org", "@type": "BlogPosting", datePublished: "2024-03-01" }` and no author. In the `BLOG` array itself, every tenth slug ends in `-2024` (`\`${…}-guide-${i + 1}${i % 10 === 0 ? "-2024" : ""}\``), so links and the sitemap agree. The pricing page gets `robots: "max-snippet:0"`. Dentist titles already run past 60 characters, so `title.length` fails without a change.
- `demoFetcher`: `/insurance` answers with `{ status: 200, hops: 2, finalUrl: \`${ORIGIN}/insurance-and-plans\` }` (the fake fetcher does not follow redirects, so it reports the chain directly); the homepage carries no HSTS header (it already does not); any request whose user agent contains `PerplexityBot` gets `403` with `cf-mitigated: challenge` on every path, while robots.txt allows it (the fake firewall). `relatedLinks` for `/blog/${BLOG[12]}` adds `/blog/removed-guide`, which is listed in the sitemap and answers 404, so the broken-link join finds a failing crawled page with an inbound link. If an existing demo assertion on URL or error counts moves by one, update the number and say so in the commit message.
- `relatedLinks`: price pages in the other six cities are already orphans; keep.
- `analyzeDemo`: compute `hostProbe` with the demo fetcher and pass it to `runFullAnalysis`.

- [ ] **Step 4: Run the demo test and the full suite**

Run: `npm run build:packages && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/demo.ts packages/agents/src/demo.test.ts
git commit -m "Demo site: one of every new failure, so the checks and both scores show"
```

---

### Task 12: Context docs, final verification, pull request

**Files:**
- Modify: `CONTEXT.md` (Growth plan section: a line on checks, classes, pillars, scores and `keyOf`), `docs/site/pages/glossary.html` (Check, Pillar, Class, Health score entries), `docs/site/pages/flow-analysis.html` (the coverage and probe steps, and `audit` in the saved report), `packages/agents/src/assistant.ts:150-160` (the findings context)

- [ ] **Step 0: Give Ask Eumon the audit**

In `assistant.ts`, where the latest report's findings are listed for the model (line 155), add the scores and the failed checks:

```ts
      const audit = (last.report as { audit?: { seo: { value: number | null }; ai: { value: number | null }; checks: Array<{ id: string; status: string; pages?: number }> } }).audit;
      const checks = audit ? { seoHealth: audit.seo.value, aiHealth: audit.ai.value, failed: audit.checks.filter((row) => row.status === "failed").map((row) => ({ check: CHECKS[row.id]?.name ?? row.id, pages: row.pages })) } : null;
```

and include `checks` in the same tool result as `findings`. Add a test in `assistant.test.ts` that a report with `audit` puts the failed check names in that tool's output.

- [ ] **Step 1: Write the context lines**

In `CONTEXT.md` under "## Growth plan", before "Finding key":

```
- **Check**: one entry in the registry (`packages/core/src/checks/catalog.ts`): id, pillar (`seo` or `ai`), class (error, warning, notice), scope, sources, fix kind and docs. Every finding carries its `checkId`; `finding()` builds it. The Checks docs page is generated from the registry, so a check without docs fails the docs build.
- **Health score** (`healthScore`): per pillar, the share of indexable crawled pages with no error-class page issue, 0–100; a site-wide error of the pillar makes it 0 with the reason; null without a finished full crawl. Class decides the score; severity ranks the plan. Written daily as `health_seo` and `health_ai`.
- **Audit table** (`report.audit.checks`): every registered check as passed, failed (page count) or skipped (reason: what the site lacks, or "run a full crawl once after deploying" for rows older than the new fields).
```

Change the "Finding key" line to say the key is `keyOf`: the check id plus scope key, with the legacy title key for older reports, upgraded in place when a run saves its key list.

- [ ] **Step 2: Full verification**

Run, in order, and paste the tails into the PR description:

```bash
npm run typecheck
npm test
node docs/site/build.mjs
```

Expected: all three exit 0.

- [ ] **Step 3: Run the demo locally and look**

`npm run dev` on the user's port is theirs; use `vite dev --port 5175` from `apps/web`, `POST /api/dev/demo-site`, open the demo site: Overview tiles show two numbers and the counts line; Technical and AI visibility tabs show the Checks cards with failed, passed and skipped rows; a finding row shows its check name; History shows no spurious resolutions after a second run.

- [ ] **Step 4: Commit and open the PR**

```bash
git add CONTEXT.md docs/site/pages
git commit -m "Context and docs: checks, pillars, health scores, audit table"
git push -u origin claude/audit-engine-v2
gh pr create --title "Audit engine v2: check registry, health scores, 34 new checks, generated docs" --body-file /tmp/pr-body.md
```

The PR body: the spec path, the three verification outputs, the list of new check ids, and the note that one full crawl per site is needed after deploy for the new page checks to stop reading as "skipped".
