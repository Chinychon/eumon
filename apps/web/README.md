# Eumon — web app and Worker

The dashboard, API, public landing pages, and background Workflows, deployed as one Cloudflare Worker (vinext + D1 + Workflows + Browser Rendering). AI steps use DeepSeek, Claude, or Workers AI.

## Local setup

1. Install dependencies from the repository root: `npm install`, then `npm run build:packages`.
2. Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` and fill in:
   - `SESSION_SECRET` — at least 32 random characters (`openssl rand -hex 32`). Signs the GitHub install cookie and Google OAuth state.
   - `OAUTH_ENCRYPTION_KEY` — base64url of exactly 32 random bytes (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Search Console tokens are encrypted with it.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — a Google OAuth web client with redirect URI `http://localhost:5174/api/google/callback` and the Search Console API enabled.
   - `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_PRIVATE_KEY` — **optional**. A GitHub App (Setup URL `http://localhost:5174/api/github/callback`; Metadata read, Contents read/write, Pull requests read/write) enables repository analysis and draft fix PRs. Sites without a repository (WordPress, Drupal, Webflow, …) work without it.
   - `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` — **optional** language model for scoping, extraction, and page copy. The first one set wins: DeepSeek (`deepseek-flash` by default), then Claude (`claude-opus-5-5`), then Workers AI. `LLM_MODEL` overrides the model for the active provider (e.g. `deepseek-v4-pro`). Workers AI needs Cloudflare credentials in local development (`remoteBindings` is off in `vite.config.ts`), so set one of the keys to use the AI steps locally. Every other step works without a model.
3. Apply migrations: `npm run db:migrate:local -w @organic-growth/web`.
4. Start: `npm run dev` from the repository root (it rebuilds the shared packages first; the web app reads their built copies, so a stale build shows old data), or `npm run dev -w @organic-growth/web` when the packages are already built (port 5174, fails rather than switching ports). Restart it after changing `cloudflare.config.ts` or `.dev.vars`. A "Missing required secrets … ANTHROPIC_API_KEY, LLM_MODEL" warning is harmless: add the empty lines `ANTHROPIC_API_KEY=` and `LLM_MODEL=` to `.dev.vars` to silence it.

To deploy, from the repository root: sign in with `npm exec -w @organic-growth/web -- cf auth login` (the `cf` CLI is installed in the web workspace; or export `CLOUDFLARE_API_TOKEN`), apply migrations with `npm run db:migrate:remote`, set the secrets above on the deployed Worker, then run `npm run deploy` (it builds the packages first). Re-run `npm run db:migrate:remote` after pulling changes that add files to `packages/db/migrations`; already-applied migrations are skipped. To deploy your own copy, set `CF_D1_DATABASE_ID` to your D1 database (and update the ID in the `db:migrate:*` scripts).

## The landing page engine

| Step | Where | Notes |
|---|---|---|
| 1. Scope | `POST /api/sites/:id/scope` | Reads the homepage, linked pages, sitemap route families, and Search Console queries; proposes datasets (fields, page ideas, sources). |
| 2. Sources | `/api/datasets/:id/sources`, `POST /api/sources/:id/preview` | Own-site sitemap sections, directory/listing pages, sitemaps, or single pages. Preview shows matches, robots.txt status, and a sample extraction. |
| 3. Collect | `POST /api/datasets/:id/scrape` → `ScrapeWorkflow` | Durable, resumable batches. Identifies as EumonBot, obeys robots.txt and crawl-delay, paces requests per host. CSV import: `POST /api/datasets/:id/records/import`. |
| 4. Generate | `GET /api/datasets/:id/potential`, `POST /api/datasets/:id/templates`, `/api/templates/:id/generate` | Before designing, the potential estimate shows how many pages each page idea (and each other grouping the data supports) would publish under the quality gate. One page per record (or per group of records). AI writes the copy *patterns* once per template; pages are filled from data, so cost doesn't grow with page count. Thin and duplicate pages are never published. |
| 5. Serve | `GET /p/:siteId/<path>` | Complete server-rendered HTML with canonical, JSON-LD, sitemap, hub page, and related links. Published URLs never change on regeneration; removed pages return 410. |
| 6. Measure | `GET /api/sites/:id/performance`, `SearchSyncWorkflow` (daily) | Views and CTA clicks (in-page beacon), Googlebot fetches (server-side), Search Console per page and query, and conversions attributed through a first-party session cookie. |
| 7. Optimize | Suggestions, `POST /api/pages/:id/snippets`, CTA variants | Low-CTR snippets, near-miss queries, uncrawled or invisible pages, weak CTAs, winning templates. CTA variants are allocated by Thompson sampling. Every page edit is logged with before/after metrics. |

### Putting pages on the customer's domain

The customer's site forwards one path (default `/guides`) — or a whole subdomain — to `https://<app-host>/p/<siteId>/…`. **Setup** in the dashboard generates the rule for Cloudflare Workers, Vercel, Next.js, Netlify, nginx, and Apache (it detects the host from response headers), and **Run check** verifies the result as Googlebot.

Proxies must send `X-Eumon-Proxy: 1` (or an `X-Forwarded-Host` matching the public origin). Requests that arrive any other way get `X-Robots-Tag: noindex`, so the copy on the app host never competes with the customer's URL.

### Conversion tracking

Setup → *Track conversions* provides a dependency-free script for the customer's main site. It auto-tracks WhatsApp, phone, email, and form submissions (never form contents) and exposes `eumonTrack(event)`. It reuses the landing pages' `eumon_sid` cookie, so conversions are credited to the page a visitor first landed on. JavaScript apps can use `@organic-growth/sdk` instead, which reads the same cookie.

## Access control

The app has no built-in user accounts: put the hostname behind **Cloudflare Access**, but exclude the public paths, or landing pages and tracking stop working:

- `/p/*` — landing pages, sitemap, and the analytics beacon
- `/api/sites/*/events` — conversion events from customer sites
- `/r/*` and `/api/r/*` — client Results links (each is a signed, revocable token)

## Current boundaries

- One workspace; no multi-user membership or roles (see Access control).
- Competitors are owner-supplied domains (up to five per analysis). Eumon reads their sitemaps within a fixed budget (large sitemap indexes are sampled and extrapolated), inspects one page per major section as EumonBot (robots.txt respected), and compares content types with yours and with your datasets. There is no SERP or backlink data, so counts show where competitors invest, not what ranks.
- The scraper reads server-rendered HTML; sources that only render client-side, require logins, or block robots are skipped.
- Collected facts are shown to the owner before anything is published, but extraction is model output — review records and page previews before publishing.
- The analytics beacon is unauthenticated (as with any web analytics); counts can be inflated by deliberate abuse.
- Search Console data lags 2–3 days; the "changes and their effect" windows fill in as data arrives.
