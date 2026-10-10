# Fix engine: autopilot pull requests that change the site

**Status:** designed 2026-10-10; branch `claude/fix-engine`. This is project 1 of 4 that move Eumon from "tells you what's wrong" to "fixes it and proves it". The other three: 2, a WordPress writer for the same fixes; 3, the growth plan as an executable backlog; 4, the proof loop that measures the effect of merged fixes. They come later and are out of scope here.

**Why.** The 2026-10-10 product audit found that on customers' own sites Eumon diagnoses and reports, but almost never acts:
- About half the code reports.
- The "growth plan" shows finding titles with boilerplate how-to text.
- "Autopilot PRs" is about 180 lines that may only touch `public/robots.txt`, after two manual clicks.

The diagnosis layer is strong, though. The repo analyzer already knows each route's file, rendering mode, and where its metadata comes from, with the evidence line. The engine turns that knowledge into safe, reviewable code changes.

**Goal.** After each analysis, Eumon opens small draft pull requests that add or correct head tags, structured data, `llms.txt` and AI-search robots rules on a Next.js App Router site. Each PR:
- covers one fix type on one route;
- is checked against the site's own CI and preview deploy before it leaves draft;
- is merged by a human.

**Decisions (from the brainstorm):**
- **Autonomy:** Eumon opens PRs by itself, within a budget; humans merge. No auto-merge.
- **Fix types in v1:** head tags (title, description, canonical, hreflang); JSON-LD structured data; `llms.txt` plus AI-search rules in `robots.txt`. Content edits (alt text, FAQ and answer blocks) are a later step.
- **Safety check:** Eumon validates its own edit, then waits for the repo's checks and preview deploy, fetches the preview, and confirms the tags render. Only then does the PR leave draft.
- **PR shape:** one fix type per route, e.g. "Add MedicalProcedure JSON-LD to `/procedures/[slug]`".
- **Frameworks in v1:** Next.js App Router only. Pages Router and Astro come later, one edit module each.
- **How edits are made:** rule-based edits on a parsed syntax tree. The AI writes only words: descriptions, an optional title qualifier, and which page facts fill which schema fields. A file with an unrecognised shape is never edited; it becomes a ready-to-paste snippet.
- **Inspiration:** MedBay's content scripts (`MedBay/medbay-web/scripts/rewrite-content.mjs`, `write-clinic-doctor-bios.mjs`, `lib/deepseek.mjs`), which worked well. Titles there were deterministic templates; the AI wrote only prose under strict guardrails.

**Out of scope:**
- WordPress, Pages Router, Astro
- content edits
- auto-merge
- measuring traffic effect (project 4)
- changing the growth-plan UI beyond showing fixes (project 3)
- AI *training*-bot rules

---

## 1. Structure

### New package `packages/fixes`

Pure TypeScript with no Cloudflare dependencies, unit-tested with `node --test` like the other packages. It depends on `@organic-growth/core` and `@babel/parser`.

| Module | Responsibility |
|---|---|
| `detect.ts` | Crawl results plus route inspections in, `FixCandidate[]` out: one per route and fix type, with the affected URLs and evidence |
| `scope.ts` | Lists the variables in scope where an edit happens: `generateMetadata` parameters and awaited data, the page component's props and locals. The AI may reference only these. |
| `edit/metadata.ts` | Head-tag edits inside `export const metadata` or `generateMetadata` |
| `edit/jsonld.ts` | Adds the JSON-LD component and its element to a page |
| `edit/llms-txt.ts` | Writes `public/llms.txt` |
| `edit/ai-robots.ts` | Unblocks AI *search* bots in a static `public/robots.txt` |
| `validate.ts` | The gate every edit must pass: parses, region-only change, file allowlist, size cap, variables in scope |
| `snippet.ts` | The ready-to-paste fallback for a skipped candidate |
| `types.ts` | `FixKind`, `FixCandidate`, `FixPlan`, `EditResult`, `ValidationResult` |

Each edit module exports `apply(source: string, plan: FixPlan): EditResult`. `EditResult` is `{ ok: true; source: string; summary: string } | { ok: false; reason: string; snippet: string }`.

### The AI text step (`packages/agents/src/fix-text.ts`)

Writes the words for a candidate, using the guardrails in §4.

### Orchestration (`apps/web`)

- **Analysis workflow:** a new final step, `fixes`. It runs the detector, writes words, edits, validates, stages in `changes`, and opens draft PRs within budget (§5).
- **`/api/github/webhook`:** a public endpoint that verifies the HMAC signature and receives `check_suite`, `check_run`, `status`, `deployment_status` and `pull_request` events (§5).
- **UI:** a Fixes panel on the Dashboard's Technical tab (§6).

### Replaced

`change-generator.ts` and the robots.txt-only flow (`analyses/[analysisId]/changes`, `changes/[changeId]/pull-request`) are replaced by the engine. The `pull-request` route remains as the manual "open now" action for a staged fix.

## 2. Detection

`detect(input)` takes:
- the crawl rows for the analysis: URL, status, page type, and the head tags as Google received them (title, description, canonical, hreflang, JSON-LD types);
- the repo analysis: `RouteInspection[]` from `packages/repo-analyzer/src/routes.ts`, the framework fingerprint, and the root layout source;
- the site's language versions from the crawl.

It maps each crawled URL to its route by matching `pathPattern`. Dynamic segments match any value.

| Candidate | When |
|---|---|
| `metadata-base` | The root `app/layout.tsx` has no `metadataBase` and any route needs a canonical |
| `head:title` | Pages of the route have no title, duplicate titles across pages, a title over 65 characters, or only the site name |
| `head:description` | Missing, duplicated, or outside 70–170 characters |
| `head:canonical` | Missing, or pointing at another URL without a redirect reason |
| `head:hreflang` | The crawl shows language versions of these pages (e.g. `/x` and `/id/x`) but no `alternates.languages` |
| `jsonld` | No JSON-LD on the route's pages, or none of the type that fits the page type (§3.2) |
| `llms-txt` | No `public/llms.txt`, or an Eumon-written one that is out of date |
| `ai-robots` | A static `public/robots.txt` blocks an AI *search* bot, and the site setting `allowAiSearch` is on |

Head-tag problems on one route become **one** `head` candidate listing every sub-problem, so each PR covers one fix type per route.

Candidates are ranked by the number of affected pages times a weight per fix type: metadata-base 5, ai-robots 4, head 3, jsonld 2, llms-txt 1. Findings are keyed by title and don't map onto routes, so their impact scores can't be reused.

## 3. Edit rules (Next.js App Router)

Parsing uses `@babel/parser` with the `typescript` and `jsx` plugins. Edits are position-based insertions and replacements on the original text, so formatting outside the edit is untouched.

### 3.1 Head tags

| The route file has | The engine |
|---|---|
| `export const metadata = { … }` (object literal) | sets or adds `title`, `description`, `alternates: { canonical, languages }` inside it |
| `export (async) function generateMetadata(…)` with a single `return { … }` | the same, inside the returned object, using in-scope variables |
| no metadata export, and the route is **static** | adds `export const metadata = { … }` after the imports |
| no metadata export, and the route is **dynamic** | skips; the snippet is a full `generateMetadata` |
| `"use client"` in the file | skips; the snippet says to move metadata to a server `layout.tsx` or page wrapper |
| any other shape (spread, a function call, conditional returns) | skips; snippet |

Rules:
- Existing values are changed only for the detected problem. The PR shows old and new values.
- **Titles are templates by default:** `{heading-or-entity} | {siteName}`, from in-scope variables, like MedBay's `withSiteName`. The AI may add one qualifier between them (§4).
- **Canonical:** `alternates.canonical` takes the route path with its params, e.g. `` `/procedures/${params.slug}` ``. It depends on `metadataBase`; until the `metadata-base` PR merges, canonical candidates wait.
- **Hreflang:** `alternates.languages` only for locales the crawl proved exist, plus `x-default`.

### 3.2 JSON-LD

- The first JSON-LD PR on a repo adds `components/eumon-json-ld.tsx` (or `src/components/…` when the repo uses `src/`). It is a server component that renders `<script type="application/ld+json">` with `JSON.stringify(data).replace(/</g, "\\u003c")`. Later PRs reuse it.
- The page's default export must `return (<Root>…</Root>)` once. The engine inserts the import and `<EumonJsonLd data={…} />` as the first child of `<Root>`. Any other shape is a skip with a snippet.
- **Schema type by page type:**
  - home: `Organization` + `WebSite`
  - entity routes: the type the dataset or page type implies (`MedicalProcedure`, `Physician`, `Hospital`, `Product`, `Service`, `Article`), otherwise `WebPage`
  - every non-home page also gets `BreadcrumbList`
- The data object is built only from in-scope variables, through the AI's field mapping (§4).

### 3.3 `llms.txt`

- Written to `public/llms.txt`, starting with the line `# <site name>`, then the comment `<!-- maintained by Eumon -->`.
- **Content:**
  - a one-paragraph site summary from the scope analysis;
  - sections per page type, each listing up to 50 key URLs with one-line descriptions, taken from crawled titles and descriptions and capped at 200 URLs.
- If an `llms.txt` exists **without** the marker, it is never edited; suggestions go to the growth plan.

### 3.4 AI-search robots rules

- Only for a static `public/robots.txt`, and only when the site setting `allowAiSearch` is on (new, off by default).
- Adds `Allow: /` groups for AI **search** agents: OAI-SearchBot, PerplexityBot, Claude-SearchBot, and others from `core/src/ai-agents.ts` with role `search`.
- Never touches training crawlers.
- `app/robots.ts` is a skip with a snippet.

## 4. The AI text step

The AI writes words only. Each guardrail mirrors one that worked in MedBay's scripts.

**Inputs:**
- the route's in-scope variables: name, type if known, and an example value from a crawled page;
- up to 5 crawled pages of the route: URL, H1, current title and description, the first 600 characters of visible text;
- the site name and language;
- the site's top Search Console queries for these URLs, when connected;
- the detected problems.

**Output (JSON mode), one of:**
- `{"facts": [...], "titleQualifier": "…" | null, "descriptionPattern": "…", "schemaMapping": {"name": "procedure.name", …}}`
- `{"skip": true, "reason": "…"}`

**Guardrails:**
1. **Facts first.** The AI lists the facts it will use, and its output may use only those facts.
2. **Closed variable set.** Every `${…}` in a pattern and every value in `schemaMapping` must be an in-scope variable path. Anything else is rejected.
3. **No invention.** Numbers, names and credentials in literal text must appear in the supplied pages.
4. **Banned claims.** Words like *leading, renowned, best, world-class, award-winning, top, premier* are rejected unless the site's own pages use them.
5. **Length is checked on rendered values.** Each pattern is rendered against the example values of all 5 pages. Titles must be ≤ 60 characters (a 65-character hard cap) and descriptions 120–155.
6. **Language.** Output matches the page language. Indonesian and Malay output passes MedBay's function-word check.
7. **A separate checker call,** with a fresh context and temperature 0, sees only the facts and the rendered outputs and flags unsupported claims. Any flag is a skip.
8. **One retry,** naming the exact failure, and only for length or language. Anything else becomes a skip with a snippet.
9. **Titles stay deterministic unless a qualifier helps.** The qualifier must come from Search Console queries when connected (e.g. "Cost in Malaysia"); otherwise it is null.

**AI client.** It reuses `@organic-growth/ai` in MedBay's cheap mode:
- thinking off, JSON mode, forgiving JSON parsing;
- backoff with jitter on 429/5xx;
- a per-analysis budget of AI **calls** (default 30), since the client has no cost tracking. Once it is spent, the remaining candidates skip with snippets.

The prompt version is a hash stored with each staged fix.

## 5. Lifecycle

### 5.1 Staging, at the end of each analysis

For each candidate, in rank order:
1. The AI writes the words; the edit is applied and validated (§5.4).
2. The result is stored in `changes` with status `staged`, or `skipped` with the snippet. Stored alongside: original and new snippets, file path, the file's SHA, prompt hash and warnings.
3. A route plus fix type that already has an open or rejected change is not staged again.

### 5.2 Opening PRs

Within the budget:
- at most **3** open Eumon PRs per site at once;
- only when the workspace's `pullRequests` feature is on.

Steps:
- The engine re-reads the file from the default branch and opens the PR **only if its SHA still equals the staged SHA**. Otherwise it re-stages on the next analysis.
- Branch `eumon/<fix-kind>-<route-slug>`, one commit, **draft** PR.
- **PR body:**
  - what changed and why;
  - the affected pages: count plus 5 example URLs;
  - old and new values;
  - what will be verified;
  - a one-line revert instruction.
- Status `draft`.

### 5.3 Checking

The webhook moves the status:

| Event | Action |
|---|---|
| All checks on the head SHA pass and a preview deploy succeeds (`deployment_status` success with an `environment_url`) | Fetch the preview URL of up to 3 affected pages and confirm the new tags are in the **raw HTML** (AI crawlers don't run JavaScript). On success: mark ready for review, comment "verified on preview", status `ready`. On failure: comment the diff of expected vs found, status `failed`. |
| Checks pass, no preview deploy within 30 min | Status `ready`, with a comment: "no preview available; verified build only" |
| Any check fails | Comment the failing check names, status `failed`, stays a draft |
| PR merged | Status `merged`. The next analysis's recrawl confirms the finding is gone; if the page now errors or the tag vanished, Eumon opens a revert PR and flags the site. |
| PR closed unmerged | Status `rejected`. Not re-staged. |
| Draft older than 7 days | Closed by Eumon with a comment, status `closed` |

The daily cron sweeps for PRs whose webhooks were missed, polling up to 20 PRs per site.

### 5.4 Validator

Every edit must pass all of these, or it is a skip:
- the file parses before and after;
- everything outside the allowed region is byte-identical. Regions: the `metadata` object or the `generateMetadata` return object; the import block plus one inserted element; the whole file for `llms.txt`, `robots.txt` and the JSON-LD component;
- files only from the allowlist: `app/**/page.tsx`, `app/**/layout.tsx` (root only, for `metadata-base`), the JSON-LD component path, `public/llms.txt`, `public/robots.txt`;
- no new dependencies, and imports only of the Eumon JSON-LD component;
- at most 60 changed lines;
- every referenced variable is in scope;
- none of the analyzer's sensitive paths (`analyze.ts:35-42`).

## 6. Dashboard

On the Dashboard's Technical tab, a **Fixes** panel lists staged, open, ready, merged and failed fixes. Each row shows:
- fix type, route, number of pages and status;
- a link to the PR;
- the before/after snippet diff.

**Actions:**
- **Open now** (for a staged fix, ignoring the queue but not the budget);
- **Reject** (never re-stage);
- **Copy snippet** (for skipped ones).

The Setup page gains the `allowAiSearch` switch, the PR budget (1–5) and an "Autopilot on/off" switch per site (default on once the GitHub App is installed).

## 7. Data

**Migration `0025_fix_engine.sql`** (re-check the number on `origin/main` before writing):
- `changes` gains:
  - `fix_kind TEXT`, `route TEXT`
  - `file_path TEXT`, `file_sha TEXT`
  - `before_snippet TEXT`, `after_snippet TEXT`
  - `prompt_sha TEXT`, `warnings_json TEXT`
  - `preview_url TEXT`, `verification_json TEXT`
  - `branch TEXT`, `head_sha TEXT`, `updated_at TEXT`
- Status values become `staged`, `skipped`, `draft`, `ready`, `merged`, `failed`, `rejected`, `closed`. Old rows (`proposed`, `pr_opened`) stay readable.
- New table `site_fix_settings (site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, allow_ai_search INTEGER NOT NULL DEFAULT 0, fix_budget INTEGER NOT NULL DEFAULT 3, autopilot INTEGER NOT NULL DEFAULT 1)`. It is separate from `page_settings`, which belongs to the landing-page engine. No row means the defaults.
- An index on `changes (site_id, status)`.

## 8. GitHub App changes (manual, by the owner)

**Permissions:**
- Contents: read & write (already)
- Pull requests: read & write (already)
- **Checks: read**
- **Commit statuses: read**
- **Deployments: read**

**Webhook:**
- URL `https://<origin>/api/github/webhook`
- secret → new Worker secret `GITHUB_WEBHOOK_SECRET`
- events: Check suite, Check run, Status, Deployment status, Pull request

## 9. Errors and limits

- Every failure is recorded on the change row with a sentence that says what to do next. Nothing fails silently.
- The fixes step never fails the analysis. Its errors are notes on the analysis.
- **Workers Free plan:** each workflow step stays under 50 subrequests by batching candidates (GitHub reads and writes count). PR opening is spread across steps of at most 5 candidates.

## 10. Testing

- **`packages/fixes` fixtures:** synthetic App Router files for each shape in §3. MedBay is a Vite + React Router single-page app, not Next.js (see §12), so it can't supply fixtures. Each rule gets an "applies" and a "skips with snippet" test.
- **Validator tests** that try edits outside the region, unknown variables, extra imports, a forbidden file, and an oversize diff. Every one must be refused.
- **`detect` tests** on crawl and route fixtures: duplicate titles, missing descriptions, a missing `metadataBase`, language variants.
- **AI text step:** the pure checks (closed variables, grounded example values, banned words, rendered-length budget, number check, language) are unit-tested against fixed model outputs.
- **Webhook:** recorded GitHub payloads drive every status transition in §5.3. The signature check refuses tampered bodies.
- **End to end, manual:** a test repo (a fork of a small Next.js App Router site) with the App installed and a Vercel or Cloudflare Pages preview. Run an analysis and watch the PRs open, verify on preview, and leave draft.

## 12. Corrections from the code research (2026-10-10)

- **The crawl stores no page text,** only head tags, heading outline and lengths. The AI step fetches up to 3 live pages per route at fix time, using `defaultFetcher`, `parseHtmlSignals` and `visibleText`.
- **Grounding.** The AI must return example values for every variable path it uses, one set per sample page. Each value must appear in that page's title, H1, description or text. Lengths are checked on these rendered examples.
- **Route patterns use `:param`** (`/procedures/:slug`). Matching a crawled URL to a route prefers the pattern with more static segments.
- **Repo files are not kept after analysis.** The engine fetches the files it edits, with their blob SHA, from GitHub's contents API.
- **Leaving draft:** GitHub's REST API can't take a PR out of draft. The engine uses the GraphQL mutation `markPullRequestReadyForReview`.
- **Settings location.** Autopilot on/off, PR budget and "allow AI search" sit at the top of the Fixes panel rather than on the Setup page, so all fix controls are in one place.
- **MedBay is Vite + React Router,** with head tags set by an edge Worker. v1 (Next.js App Router) only gives it snippets; support for its setup is a later version. This is the user's decision.

## 11. Risks

- **Preview detection varies by host.** Vercel, Netlify and Cloudflare Pages all post `deployment_status` with an `environment_url`; others may not, which falls back to "verified build only".
- **Coverage.** Real repos use shapes the rules skip. Skips still produce useful snippets, and the share of skips per shape guides which rule to add next.
- **The install-flow `state` question** from the accounts work: confirm on the first real install. It is unrelated to this engine, but it blocks testing.
