# Eumon — organic growth engine

Eumon turns what a business sells into crawlable landing pages for the specific things its customers search for, then measures which pages bring visits, clicks, and customers.

A medical-tourism site becomes one page per doctor, procedure, and hospital. A mall-hoarding contractor becomes one page per mall it works in. Each page describes exactly what the searcher is looking for, puts a call to action where it can't be missed, and is served as real HTML on the business's own domain.

```text
Scope → Find sources → Collect → Generate → Serve on your domain → Measure → Optimize
```

Eumon also compares the site with the competitors you name — which kinds of pages they publish that you don't (and which of those you already have data for), plus how their pages convert — and analyzes the existing site the way Google sees it — every sitemap URL fetched as Googlebot and broken down by page template, the HTML compared with what a browser renders, repeated fetches to catch intermittent empty pages, and ranked technical findings — and, when a GitHub repository is connected, proposes safe fixes as draft pull requests.

> **Status:** early MVP. Works with any website stack (Next.js, WordPress, Drupal, Webflow, custom); a GitHub repository is optional.

## How it works

1. **Add a website.** Only the URL is required.
2. **Scope.** An AI analyst reads the site, its sitemap structure, and Search Console queries, then breaks the business into the units people search for (doctors, procedures, malls, products…). Each becomes a dataset with fields to collect.
3. **Source and collect.** Pull records from the site's own pages, public directories, sitemaps, or a CSV. The collector identifies itself, obeys robots.txt, and paces requests; every source can be previewed first.
4. **Generate.** A template turns each record into a landing page. AI writes the copy pattern once per template; pages are filled from the data, and pages without enough substance are held back.
5. **Publish on your domain.** One proxy rule (Cloudflare Worker, Vercel, Netlify, nginx, Apache…) forwards a path such as `/guides` to Eumon, which serves complete HTML with canonical tags, structured data, a sitemap, and internal links. A built-in check verifies what Googlebot receives.
6. **Measure.** Page views, CTA clicks, Googlebot fetches, Search Console impressions and clicks per page, and conversions on the main site attributed to the landing page a visitor arrived on.
7. **Optimize.** Ranked suggestions (titles that under-perform their ranking, near-miss queries, pages Google ignores, weak CTAs), AI title rewrites, automatic CTA testing, and a before/after record of every change.

## Quick start

Requirements: Node.js 20+ and npm 10. Local development runs entirely on Miniflare; a Cloudflare account is only needed to deploy.

```sh
npm install
npm run build:packages
cp apps/web/.dev.vars.example apps/web/.dev.vars   # fill in what you need (below)
npm run db:migrate:local
npm run dev                                         # builds the packages, then http://localhost:5174
```

What each setting in `.dev.vars` unlocks (details in [apps/web/README.md](apps/web/README.md)):

| Setting | Unlocks |
|---|---|
| nothing | Site analysis, CSV import, page generation, publishing, analytics |
| `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` | AI scoping, data extraction from web pages, page copy, title suggestions |
| `SESSION_SECRET`, `OAUTH_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Search Console data |
| `GITHUB_APP_*` (plus `SESSION_SECRET`) | Repository analysis and draft pull requests |

## Repository layout

| Package | Responsibility |
|---|---|
| `apps/web` | Dashboard, API routes, public landing pages (`/p/:siteId/*`), and Cloudflare Workflows. Setup and deployment: [apps/web/README.md](apps/web/README.md). |
| `packages/core` | Shared types and the organic-impact scoring model. |
| `packages/ai` | One JSON-output interface over DeepSeek, Claude, and Workers AI. |
| `packages/db` | D1 queries and migrations (`packages/db/migrations`). |
| `packages/crawler` | Sitemap discovery, Googlebot crawling, rendering and technical SEO findings. |
| `packages/scraper` | Scoping analyst, robots.txt-aware collection, structured extraction, CSV import. |
| `packages/pages` | Page generation with quality gates, HTML rendering, CTA testing, performance insights. |
| `packages/repo-analyzer` | Stack detection (framework, router, CMS, database, deployment) and per-route code inspection: rendering mode, browser-side data fetching, where titles come from, request waterfalls, and unpaginated queries. |
| `packages/agents` | Growth plan synthesis; search analysis (target-market share, intent mix, striking distance, skipped snippets, cannibalization); competitor comparison; code findings; Search Console client; safe-change and pull request generation. |
| `packages/sdk` | Browser conversion tracker for JavaScript sites. |

Built on Cloudflare Workers ([vinext](https://www.npmjs.com/package/vinext) + React), D1, Workflows, and Browser Rendering.

## Development

```sh
npm test            # unit tests (every package)
npm run typecheck   # every workspace
npm run build       # packages + production Worker bundle
npm run audit -- https://example.com --max 300   # site analysis from the command line
npm run eval        # end-to-end collection quality on a real site (calls the model; a few cents)
npm run db:migrate:remote && npm run deploy   # deploy (after `npm exec -w @organic-growth/web -- cf auth login`)
```

`npm run audit` runs the same steps as the analysis Workflow — sitemap, robots.txt, a Googlebot crawl of every sitemap URL (up to `--max`), per-template coverage, sampled checks, findings, and the growth plan — with an in-memory SQLite database in place of D1. Add `--competitor other.com` (repeatable) to include competitors, `--market idn` (repeatable, Search Console country codes) for target markets, and `--json` for the full report. With Playwright installed (`npm i -D playwright`), it also renders one page per template in Chromium for the source-vs-render comparison. Behind an HTTPS proxy, run it with `NODE_USE_ENV_PROXY=1`.

`npm run eval` runs the real collection pipeline (pagination, extraction, merging, duplicate resolution) against a live website and grades it against an answer key parsed from the same pages without AI: how many collected records are real, how many published facts the site actually states, and how many of the site's facts were captured. Run it before and after changing prompts or merge logic.

## Principles

- Pages exist to serve a searcher: thin or duplicate pages are held back, never published to inflate URL counts.
- First-party data (Search Console, on-page analytics, conversions) is the source of truth for what works.
- Every change is reviewable and measured: page edits are logged with before/after metrics, and code changes go through draft pull requests.
