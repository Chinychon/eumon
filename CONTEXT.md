# Context: the words this codebase uses

Short definitions of the domain terms that name modules and seams. Architecture reviews read this first; keep it to terms that would otherwise be ambiguous.

## Performance

- **Results**: the synced numbers (Search Console, GA4, speed, authority, keywords). Their sections (`results/sections.tsx`) sit in the Dashboard's tabs: the proof (clicks since go-live, the key numbers) on Overview, then Search, Enquiries, Technical (speed), Keywords and Competitors (authority). The page once called *Performance* (view key `results`, still used in file and route names) is now those tabs; old links redirect. The read-only **client link** (`/r/<token>`) stacks every section into one report, without site health.
- **Page results** (view `performance`): the landing page engine's steps 6–7, how each generated page performs. Formerly *Page performance*.
- **Ledger**: `metric_points`, one value per site, metric and day. Numbers over time live here, and every ratio is derived by the reader. Upserts overwrite, so re-runs and Google's revised days never double count.
- **Metric group** (`METRICS` in `packages/core/src/results.ts`): the ledger metrics one upstream connection writes. A group is what its sync may write, what the view reads, and what a changed property clears.
- **Marker**: a `sync.*` metric a source writes after each run. Its absence means a first run, which backfills history.
- **Snapshot** (`site_snapshots`, `packages/db/src/snapshots.ts`): a "latest list" that replaces itself, keyed by kind and scope: `top_queries` (property|markets), `keywords` (property|market: the site's Search Console queries priced by DataForSEO), `competitor_keywords` (domain|market: a domain's ranked keywords). The scope names what made the list, so a changed property, market or competitor hides the old list until the next sync. Counts derived from a list (`kw_top10`, `kw_traffic`) go in the ledger so they trend.
- **Keyword gap**: a competitor's ranked keyword the site appears for in none of its lists; the best-placed competitor stands for it. The Keywords card shows the 25 biggest; the growth plan turns the reachable ones (volume ≥ 100, difficulty ≤ 40) into `keyword_gap` opportunities.

## AI visibility

- **AI agent** (`packages/core/src/ai-agents.ts`): a user agent that reads pages for an AI company, mapped to an **engine** (the radar's axes: OpenAI, Anthropic, Perplexity, Meta, Common Crawl, others). A **crawler** collects pages ahead of time (training or an AI search index); a **live fetch** is an assistant opening a page to answer someone. Google has no AI user agent: its AI answers fetch as Googlebot, and `Google-Extended` is a robots.txt token only.
- **AI fetch**: an AI agent's request for a published Eumon page, counted per page, day and agent in `ai_page_daily` (signal `fetch`) and rolled into `ai_crawler_fetches.<engine>` / `ai_live_fetches.<engine>`. Only Eumon's pages are seen; the rest of the client's site isn't.
- **AI referral**: a visit an AI assistant sent, from the referrer host or `utm_source` (signal `referral`, `ai_referral_visits.<assistant>`). The whole site's AI-referred sessions come from GA4 (`ga4_ai_sessions`); the two are never added.
- **Landing source**: where a session first landed from (`search`, `ai:<assistant>`, `other`), kept on `page_sessions.source`; it splits Eumon-page leads (`leads_eumon.<source>`).
- **Question search**: a query phrased as a question (`QUESTION_QUERY_PATTERN`), counted from the 28-day query list the sync already fetches.
- **AI readiness**: an analysis's robots.txt verdict per AI token (exact token match), llms.txt, and FAQ markup. Blocking is reported (`ai_visibility` findings), never auto-fixed.

## Sync

- **Source** (`apps/web/src/results-sources.ts`): one thing the sync collects: Search Console daily series, rankings, top queries, URL inspection, GA4, CrUX, PageSpeed, Open PageRank, the site's own numbers. Each knows its upstream, its cadence and its points. Adding a feed means adding a source, not editing the runner.
- **Sync runner** (`syncResults` in `apps/web/src/results-sync.ts`): runs every source for one site, connecting Google once, writing points and markers, turning a throw into a `<name> failed` note. "Sync now" and the daily workflow both call it.
- **Sync run** (`sync_runs`, `packages/db/src/activity.ts`): one sync and every note its sources wrote, kept 30 per site and shown in Setup → Sync history. A note with "failed", "stopped" or "refused" is a problem; Sync now on the Dashboard repeats those.
- **Refusal**: a URL Inspection answer that holds for the rest of the day: quota (429), a revoked token (401), or a whole batch of 403. A lone failure is one URL Google won't inspect; the queue moves past it.
- **Fresh list**: a keyword list (snapshot) is refreshed when it is missing or 28 or more days old; a sync whose lists are all fresh spends nothing at DataForSEO. Budget: up to (competitors + 1) × markets calls per sync, in sequence, against the Workers Free plan's 50 subrequests per invocation.

## Growth plan

- **Opportunity**: a prioritised thing to do, from search data, competitor content, collected datasets or a technical finding. Its `searchDemand` and `estimatedDifficulty` come from one **demand estimate** (`packages/agents/src/demand.ts`); until keyword data is synced they are heuristics, and the rationales say so.

## Data

- **Ownership**: every table with a `site_id` cascades from `sites`, so deleting a site is `DELETE FROM sites` (`deleteSite` clears the two largest tables first). Crawl results (`pages`) and changes cascade from their analysis; daily page counters (`page_metrics_daily`, `ai_page_daily`) from their generated page. A new table that belongs to a site takes `REFERENCES sites(id) ON DELETE CASCADE`; the demo test checks nothing survives a delete.
- **Crawl result** (`pages`): one row per analysis and URL (`PRIMARY KEY (analysis_id, url)`). The page type (`route_family`) and reuse (`reused_from`, the earlier analysis a result was copied from) are columns; the rest of what the crawler saw is `result_json`.
- **Google connection**: one `oauth_credentials` row per site with provider `google`, covering Search Console, Analytics and Sheets (its `scopes` say which were granted).
- **Table rebuild**: SQLite can't add a foreign key to an existing table, so a migration that changes one creates the new table, copies the rows, drops the old one and renames. A parent is replaced only after its old children are dropped: dropping a table deletes its rows, and that delete cascades into any table already pointing at it (`0019_ownership_and_indexes.sql`).
- **Crawl counters** (`crawl_counts`): per analysis and page type, the counts the progress view shows (pending, fetched, reused, errors, empty, …) and the first and last fetch. Each saved batch takes its rows' old counts off and puts their new counts on in the same batch; queueing recounts once (`recountCrawl`). Anything that edits crawl rows outside `saveCrawlBatch` must call `recountCrawl`. The latest batch's URLs are `analyses.crawl_recent`.
- **Crawl retention**: when an analysis finishes, crawl rows are deleted for all but the latest two finished analyses and any run newer than the latest one (`pruneCrawlResults`). Every report and crawl counter stays, so history and pace are unaffected; drill-downs read only the latest crawl.
- **Query budget**: the Workers Free plan allows 50 D1 queries per request and 5M rows read a day. A request does a fixed number of queries (never one per item; batch over `json_each` instead), and anything polled reads counters, not whole tables.

## Leads

- **Reference code** (`packages/core/src/whatsapp.ts`): five letters and digits (no 0/O/1/I) the browser writes into a WhatsApp link's message when it is clicked ("… (ref K7M2Q)"), on Eumon's pages (the CTA) and on the main site (the tracking snippet). The click's beacon or event carries the same code, so the chat that arrives can be matched to the visit.
- **Lead** (`leads`, `packages/db/src/leads.ts`): one per code (or entered by hand without one). Its **status** moves `clicked` → `chat` → `qualified` → `won` (with a value in the site's **currency**, `page_settings.currency`), or `lost`. Each stage keeps when it was reached; reaching a stage fills the earlier ones, moving back clears the later ones. No phone number or message is stored.
- **Outcomes** (`wa_clicks`, `lead_chats`, `leads_qualified`, `customers`, `revenue`): leads in the ledger on the day each stage was reached, rewritten in full by every sync and every change to a lead. **By page type**: leads of the last 90 days by the template of the Eumon page the visitor first landed on ("Rest of the site" when they never landed on one).
