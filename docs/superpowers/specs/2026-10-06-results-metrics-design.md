# Results: metrics that prove SEO, GEO, and AEO improvement

Date: 2026-10-06 · Status: approved; Phase 1 extended 2026-10-07 with Google Analytics 4 and index status (sub-project A of the SEO data roadmap)

## Goal

Show, with real numbers over time, whether Eumon is improving a client's visibility and leads in search engines (SEO), in AI-generated answers (GEO), and in answer features such as rich results and question searches (AEO).

**Audience:** one view for both. The dashboard is client-facing. Until sign-in exists (deferred past the MVP), each client reaches their numbers through a read-only link; the operator uses the same view to see what works.

**Success:** for any site, the operator can open one view and say how leads, search traffic, and AI visibility have changed since Eumon's pages went live, and every number traces back to its source.

## Non-goals

- Third-party SERP rank tracking and competitor traffic estimates. Free authority and backlink estimates, keyword volume and difficulty, and competitor keywords are separate sub-projects (B and C) with their own specs.
- User accounts or roles. The client link is the only client access.
- Scheduled email or PDF reports. They can follow once the view exists.

## Definitions

- **Days:** first-party days (leads, fetches, visits) are UTC calendar days. Search Console days are Pacific Time, as Google reports them. The view keeps the two series apart and says so.
- **Go-live:** the earliest `published_at` among a site's generated pages. A site with no published page is "not live yet" and shows no before/after comparison.
- **Current window:** the 28 days ending yesterday. For Search Console metrics it ends three days ago, because Search Console data lags two to three days.
- **Before:** the 28 days ending the day before go-live.
- **Previous:** the 28 days before the current window.
- **Year over year:** the same 28 days a year earlier, shown when history covers it.
- **Change:** `(current − before) ÷ before`. When `before` is 0, the absolute difference is shown instead of a percentage.
- **Rates and averages** are computed from summed components over a window, never by averaging daily rates. CTR is clicks ÷ impressions. Average position is impression-weighted.
- **Lead:** a visitor session with at least one contact action that day (`whatsapp_click`, `phone_click`, `email_click`, `form_submit`, `booking_complete`, `lead_created`). Repeat actions in one session count once per day. An event without a session counts once. `lead_qualified` and `customer_created` are tracked as separate later stages.
- **Eumon lead:** a lead whose session first landed on one of the site's Eumon pages (`page_sessions`).

## Metric catalog

Each metric is stored per site per day. "Sum" metrics add up over a window; "latest" metrics take the most recent point in the window; ratio rows are derived at read time from their stored components.

| Metric | Section | Definition | Source | Cadence | Window | Phase |
|---|---|---|---|---|---|---|
| `leads` | Outcomes | Leads on the client's tracked site | conversion events | daily | sum | 1 |
| `leads_eumon` | Outcomes | Leads whose session landed on an Eumon page | conversion events × page sessions | daily | sum | 1 |
| `leads_eumon.search` / `.ai` / `.other` | Outcomes | Eumon leads by landing source (see Landing source) | page sessions | daily | sum | 2 |
| `qualified_leads`, `customers` | Outcomes | `lead_qualified`, `customer_created` events | conversion events | daily | sum | 1 |
| `search_clicks`, `search_impressions` | SEO | Whole-site Google clicks and impressions | Search Console, `date` | daily | sum | 1 |
| `search_position_weight` | SEO | Σ(position × impressions); with impressions gives average position | Search Console | daily | sum | 1 |
| `eumon_search_clicks`, `eumon_search_impressions`, `eumon_position_weight` | SEO | Same, for pages under the site's mount path | Search Console, page filter | daily | sum | 1 |
| CTR, average position, Eumon share of clicks | SEO | Derived: clicks ÷ impressions; weight ÷ impressions; Eumon clicks ÷ site clicks | derived | — | ratio | 1 |
| `queries_top3`, `queries_top10`, `queries_top20`, `queries_top100` | SEO | Distinct queries with average position ≤ 3 / 10 / 20 / 100 over the last 7 days | Search Console, `query` | weekly | latest | 1 |
| `queries_top10.new`, `queries_top10.lost` (and for each bucket) | SEO | Queries that entered or left the bucket against the 7 days before | Search Console, two 7-day windows | weekly | latest | 1 |
| `search_visibility` | SEO | Impression-weighted expected CTR of the site's queries at their average positions (the `expectedCtr` curve in `packages/pages`), as a percentage | Search Console, `query` | weekly | latest | 2 |
| `googlebot_fetches` | SEO | Googlebot requests to Eumon pages | `page_metrics_daily` | daily | sum | 1 |
| `eumon_page_views`, `eumon_cta_clicks` | Outcomes | Visitor views of Eumon pages, and clicks on their calls to action | `page_metrics_daily` | daily | sum | 1 |
| `crawl_urls`, `crawl_empty_shells`, `crawl_http_errors`, `crawl_noindex` | Site health | Coverage from an analysis run | analysis report | per analysis | latest | 1 |
| `site_health` | Site health | Share of crawled sitemap URLs with no HTTP error, empty shell, or noindex | analysis report | per analysis | latest | 1 |
| `ai_crawler_fetches` (+ `.<engine>`) | GEO | AI training and AI-search crawler requests to Eumon pages | request user agent | daily | sum | 2 |
| `ai_live_fetches` (+ `.<engine>`) | GEO | Requests an AI assistant made to answer a person (ChatGPT-User, Perplexity-User, …) | request user agent | daily | sum | 2 |
| `ai_referral_visits` (+ `.<assistant>`) | GEO | Eumon page views whose visitor arrived from an AI assistant | beacon referrer / `utm_source` | daily | sum | 2 |
| `ai_crawlers_allowed` | GEO | Major AI crawlers robots.txt allows (of 5) | analysis report | per analysis | latest | 2 |
| `question_impressions`, `question_clicks` | AEO | Search Console rows whose query is a question (see Question queries) | Search Console, `query` + `date` | daily | sum | 2 |
| `rich_result_impressions` | AEO | Impressions with a rich-result search appearance | Search Console, `searchAppearance` | daily | sum | 2 |
| `ga4_sessions`, `ga4_organic_sessions` | SEO | All sessions, and sessions whose default channel group is Organic Search | Google Analytics 4 Data API, `date` × `sessionDefaultChannelGroup` | daily | sum | 1 |
| `ga4_organic_engaged_sessions`, `ga4_organic_key_events` | Outcomes | Engaged sessions and key events from Organic Search sessions | Google Analytics 4 Data API | daily | sum | 1 |
| `pages_indexed`, `pages_not_indexed` | SEO | Published Eumon pages Google reports as indexed (verdict PASS) or not, from each page's latest inspection | Search Console URL Inspection API | daily | latest | 1 |
| `published_pages` | Outcomes | Published Eumon pages | generated pages | daily | latest | 1 |
| `faq_pages` | AEO | Published Eumon pages with an FAQ block (every Eumon page already carries entity JSON-LD) | generated pages (`content_json.faq`) | daily | latest | 2 |
| `ai_answers`, `ai_mentions`, `ai_citations` (+ `.<engine>`) | GEO | Successful checks, answers naming the client, answers citing a client URL | AI answer checks | weekly | latest | 3 |
| `ai_competitor_mentions` | GEO | Answers naming any operator-listed competitor | AI answer checks | weekly | latest | 3 |
| Mention rate, citation rate, share of voice | GEO | Derived: mentions ÷ answers; citations ÷ answers; client mentions ÷ (client + competitor mentions) | derived | — | ratio | 3 |

Search Console omits anonymized queries, so query-level sums (`queries_top10`, question metrics) are lower than whole-site totals. The view says so wherever a query-based number appears.

## Collection

### Search Console history and daily sync (phase 1)

- The first time a site has a Search Console property and no `search_clicks` points, fetch daily totals for the last 16 months with dimension `date`, once for the whole property and once filtered to the mount path. This backfill gives every site its "before Eumon" history on day one.
- The existing daily `SearchSyncWorkflow` (04:15 UTC) is extended. It re-fetches the last 7 days of both series and overwrites them, because Search Console revises recent days. It writes yesterday's lead, Googlebot, and (phase 2) AI counters, page counts, and question-query sums. It writes the weekly `queries_top3/top10` snapshot on Mondays.
- The sync's first run for a site also backfills the existing history: leads from `conversion_events` since the first event, and Googlebot fetches from `page_metrics_daily`.
- `fetchSearchConsoleMetrics` and the existing `querySearchAnalytics` helper in `packages/agents` already support the `date` dimension and paging. They are reused rather than adding a client.

### Ranking buckets and visibility (phase 1, visibility in phase 2)

- The Monday sync fetches the `query` dimension for the last 7 days and for the 7 days before, in one pass of two requests. Bucket counts come from the first window. A query is **new** to a bucket when its position there is inside the bucket and its earlier position was outside or absent, and **lost** the other way round. No per-query history is stored.
- **Target-market scope:** when the site has target markets (`site_markets`), every Google-based number is computed for those countries, with the all-countries figure beside it. Search Console's `country` filter does this server-side.

### Google Analytics 4 (phase 1)

- Connecting Google asks for `analytics.readonly` beside `webmasters.readonly`. Sites connected before this keep working for Search Console and show "Reconnect Google to add Analytics" until they reconnect; the granted scopes are stored with the credential.
- The operator picks a GA4 property in Connections (listed through the Analytics Admin API's account summaries). It is stored on the site.
- Backfill and daily sync follow Search Console: 16 months on the first sync, then the last 7 days overwritten daily. Dimensions `date` and `sessionDefaultChannelGroup`; metrics `sessions`, `engagedSessions`, `keyEvents`.
- Key events give enquiries a "before Eumon" history that first-party tracking cannot recover; the view labels them "GA4 key events" and never adds them to Eumon's lead count.

### Index status (phase 1)

- The daily sync inspects up to 100 published Eumon pages a day through the URL Inspection API, least recently checked first (the API allows 2,000 a day per property). Each result (verdict, coverage state, last crawl) is stored per page.
- `pages_indexed` and `pages_not_indexed` are written daily from the stored results; pages never inspected count as "not checked yet", never as not indexed.

### Analysis snapshots (phase 1)

When an analysis run completes, write its coverage counts (`crawl_*`), and from phase 2 `ai_crawlers_allowed`, as points dated to the completion day.

### AI bots and AI referrals (phase 2)

- `botKind` in `apps/web/src/public-pages.ts` gains two AI classes, each mapped to an engine. Patterns live in one tested module:
  - **Live, user-triggered:** `ChatGPT-User` (OpenAI), `Perplexity-User` (Perplexity), `Claude-User` (Anthropic), `MistralAI-User` (Mistral), `DuckAssistBot` (DuckDuckGo).
  - **Crawlers:** `GPTBot`, `OAI-SearchBot` (OpenAI); `ClaudeBot`, `Claude-SearchBot`, `anthropic-ai` (Anthropic); `PerplexityBot` (Perplexity); `CCBot` (Common Crawl); `Bytespider` (ByteDance); `Meta-ExternalAgent` (Meta); `Amazonbot` (Amazon).
  - Everything else keeps today's classes (`googlebot_hits`, `other_bot_hits`).
- `page_metrics_daily` gains `ai_crawler_hits`, `ai_live_hits`, and `ai_referrals` columns for per-page detail. Per-engine site counts go straight to `metric_points` with an additive upsert (`value = value + 1`). AI bot volume is low enough for one write per request.
- The landing-page beacon also sends the referrer's host (host only, never the full URL) and the page's `utm_source`. A visit counts as AI-referred when either matches `chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com`, `claude.ai`, or `meta.ai`.
- **Landing source:** `page_sessions` gains `source` (`search`, `ai:<assistant>`, `other`), set once when the session first lands. Search engines are matched by referrer host: Google, Bing, DuckDuckGo, Yahoo, Yandex, Ecosia, Baidu. Sessions created before this column exists have no source and count as `other`.

### Question queries and rich results (phase 2)

- **Question queries:** a query is a question when it starts with, or contains as a word, one of these:
  - English: who, what, when, where, why, how, which, can, does, is, are, best, top, vs, near me.
  - Malay: apa, siapa, bila, di mana, mengapa, kenapa, bagaimana, berapa, terbaik.
  - Indonesian: apa, siapa, kapan, di mana, mengapa, kenapa, bagaimana, berapa, terbaik.

  The list lives beside the existing commercial-query patterns in `packages/agents/src/search.ts`. The daily sync fetches `query` × `date` for the last 7 days and sums matching rows.
- **Rich results:** fetch impressions by `searchAppearance` per day. Before relying on it, verify that the API accepts `searchAppearance` together with `date`. If it does not, fetch `searchAppearance` alone for each single day.

### AI answer checks (phase 3)

- **Question set:** 20–40 questions per site, in the site's page language. The first draft comes from the existing language model: the site's datasets (entity type × place, such as "best knee surgeon in Penang") and its top Search Console queries rephrased as questions. The operator edits, adds, and deactivates questions. Hard cap: 40 active questions.
- **Engines,** each skipped when its key is absent and shown as "not configured", never as zero:
  - ChatGPT: OpenAI Responses API with the web-search tool. Citations come from URL citation annotations.
  - Perplexity: Sonar chat completions. Citations come from the returned citation list.
  - Gemini: `generateContent` with Google Search grounding. Gemini's grounding chunks carry redirect URIs, so match on each chunk's domain title.

  New optional secrets: `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`. Each API's request and response shape is verified against current documentation at implementation time.
- **Detection:**
  - **Mentioned:** the answer text contains the client's site name, an operator-entered alias, or its domain (case-insensitive, whole words).
  - **Cited:** any citation's host equals or ends with the client's domain or the public origin's host.
  - **Competitor mention:** the competitor's domain, or its first label (`medlads.com` → "medlads"), as a whole word.
- **Schedule:** a new `AiVisibilityWorkflow`, weekly on Mondays at 05:00 UTC, one step per engine. That is at most 40 questions × 3 engines = 120 calls per site per week.
- **Records:** every check is stored with status, citations, and an answer excerpt, so any rate can be opened to the answers behind it.
- **Failures:** a failed call is stored as `failed` and excluded from rates. When more than half of an engine's checks fail, that week's engine metrics show "incomplete".

## Storage

New migration:

```sql
CREATE TABLE IF NOT EXISTS metric_points (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,            -- YYYY-MM-DD, UTC
  value REAL NOT NULL,
  PRIMARY KEY (site_id, metric, day)
);

-- Phase 3
CREATE TABLE IF NOT EXISTS ai_questions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  source TEXT NOT NULL,         -- dataset | query | operator
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_answer_checks (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES ai_questions(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,         -- chatgpt | perplexity | gemini
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,         -- ok | failed
  mentioned INTEGER,
  cited INTEGER,
  competitor_mentions_json TEXT,
  citations_json TEXT,
  answer_excerpt TEXT,          -- first 600 characters
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_answer_checks_site ON ai_answer_checks(site_id, checked_at);
```

- Phase 2 adds the three `page_metrics_daily` columns and `page_sessions.source`.
- `sites` gains `report_share_version INTEGER NOT NULL DEFAULT 1` for the client link, and `brand_aliases TEXT` (JSON) for mention detection.
- `deleteSite` clears `metric_points`, `ai_questions`, and `ai_answer_checks`.

The ledger stores only additive daily values or point-in-time snapshots. Ratios are always derived at read time. One module (`packages/db`) owns writing points (`upsertMetricPoints`, `incrementMetricPoint`) and reading series (`listMetricSeries(siteId, metrics, from, to)`).

## Results view

A new **Results** navigation item, between Overview and Data. It answers one question for the whole site: is it working? Page-level work stays in Performance. The view is built in the dashboard's established visual world through Impeccable's new-surface flow. All charts are weekly; comparisons are fixed (no date pickers in the first version).

### Top

- **Title row:** the site name and the data's freshness ("Google data through 3 Oct").
- **Headline chart:** Google clicks per week over 16 months, with a vertical go-live marker. Two lines: the whole site, and Eumon pages from go-live on. Hovering shows each week's values. Google clicks lead because they are the only series with real history before Eumon, through the backfill.
- **Key numbers,** each for the current window, beneath the chart:
  - **Google clicks**, "was X before Eumon".
  - **Enquiries**, "was X before Eumon" when tracking predates go-live, otherwise "since <first tracked day>".
  - **AI citations**, "cited in N of M answers", against the first check; "not configured" until an engine key exists.
  - **Pages live**, "was 0 before Eumon".

### Sections

Each section is titled with the question it answers, in funnel order.

1. **Are more people finding you on Google?** Clicks and impressions for the site and for Eumon pages (weekly lines); average position and CTR with change; ranking buckets (top 3, 10, 20, 100) as weekly counts with how many queries entered and left each; search visibility as one weekly line; a top-queries table (clicks, impressions, CTR, position, each with change against the previous 28 days); pages Googlebot fetched. When target markets are set, the section is scoped to them, and its title row says which countries ("Malaysia, Indonesia").
2. **Do AI assistants mention you?** Citation rate and mention rate per engine (ChatGPT, Perplexity, Gemini) as weekly trends; share of voice against the named competitors; AI assistants reading the pages (live fetches, crawler fetches) and visits they send. Every rate opens the questions and answers behind it, excerpt and citations included.
3. **Do you show up for questions?** Impressions and clicks on question-style searches; rich-result impressions; pages with an FAQ block.
4. **Is it bringing enquiries?** A search-to-enquiry funnel for Eumon pages (Google impressions → Google clicks → page views → CTA clicks → enquiries), each step with its count and its conversion from the step before, all over the Search Console window so the steps are comparable. Then enquiries per week since tracking began, from Eumon pages against the rest, and by landing source (Google, AI assistant, other); qualified leads and customers when those events exist. A count opens the landing pages that produced it.
5. **Is the site healthy?** Site health as one percentage with its trend across analysis runs, then the empty shells, HTTP errors, and noindex pages behind it. Operator only.

### Visual design

The view inherits the dashboard's established world as recorded in `apps/web/DESIGN.md`: warm paper and forest-night themes, Geist and Geist Mono, square hairline panels sharing rules, green for primary, progress, and positive state, and the existing chart components. Patterns drawn from the operator's PostHog dashboards are integrated in that world, not copied:

- **Self-explaining tiles:**
  - Every tile carries a one-line, plain-language definition under its title ("Clicks from Google search to any page on the site").
  - Every section opens with its question and one sentence on why it matters.
  - Every number's label names its window ("Google clicks · last 28 days").
- **Dashed incomplete periods:** the current partial week, and the days Search Console has not yet reported, draw as a dashed tail, so a partial week never reads as a drop.
- **Ranked horizontal bars** for breakdowns (enquiries by source, AI citations by engine, share of voice against competitors), in the series colours. Every bar is labeled with its value.
- **Two-line charts:** the whole site and Eumon pages in the first two series colours, with the go-live marker as a hairline with a mono date label.
- **Freshness:** a "data through" stamp in the title row and under every Google-based section.
- **Loading:** hairline placeholder shapes in each tile's real chart position while data loads, never a spinner over empty space.

Not taken from those dashboards: rounded tiles, colored accent bars beside titles, and the date-range, filter, and breakdown toolbar.

### States

- Too few points: "collecting since <date>", with no number.
- No Search Console property: a connect prompt.
- AI engine unconfigured: "not configured". Incomplete AI week: labeled "incomplete".
- Search Console freshness ("data through <date>") under every Google-based section.

### Operator-only controls

Site health; editing the AI question set and brand aliases; copying and revoking the client link; the AI checks' weekly call count; links through to Overview and Performance.

## Client view

- `GET /r/<token>`. The token is `signToken({ siteId, v: report_share_version }, 5 years)` from `packages/core`. It is valid while `v` matches the site's current version. Revoking increments the version and kills every earlier link.
- It renders the top and sections 1–4 read-only, titled with the client's site name, with a small "Report by Eumon" credit. It has no site health, no operator controls, no call counts, and no question editing. Answer excerpts and citations stay visible, because they are the evidence.
- Like `/p/*`, `/r/*` must be excluded from Cloudflare Access. The README's Access control section lists it.

## Honesty rules

- No number is shown without data behind it. Missing data is a labeled state, never 0.
- Failed AI checks never count as "not mentioned".
- The view labels Search Console lag and anonymized-query omissions where they apply.
- AI answer checks are a weekly sample of a fixed question set. The view says so beside every AI rate.

## Testing

- **Unit tests:**
  - User-agent classification: every listed bot, plus browsers and unknown bots.
  - Referrer and `utm_source` classification.
  - Question-query patterns in all three languages.
  - Mention and citation detection, against recorded answer fixtures for each engine (including Gemini's redirect URIs).
  - Window and change math: zero baselines, a missing go-live, partial windows.
  - The ledger's additive upsert.
- **Database tests (SQLite, like `crawl.test.ts`):** backfill idempotency (a re-run overwrites, never duplicates); the lead definition's per-session deduplication.
- No test calls a live API. Engine adapters are tested on recorded responses.
- Each phase ends with the Results view checked against the founder's own site (medbaycare.com).

## Later candidates

These came out of reviewing the operator's Semrush project for medbaycare.com, and are deliberately not in the three phases:

- **Google AI Overviews and AI Mode:** there is no official API, so it needs SERP collection or a paid data provider.
- **Backlinks and authority score:** sub-project B uses a free rough estimate (Open PageRank, built from Common Crawl); toxicity stays out.

## Phases and acceptance

1. **Ledger, SEO, leads, Analytics, indexing.**
   - Connecting Search Console on a site fills 16 months of daily clicks and impressions; choosing a GA4 property fills 16 months of sessions and organic key events.
   - Pages live shows how many are indexed, not indexed, and not checked yet.
   - Results shows the headline Google-clicks chart with site and Eumon-page lines and a go-live marker, the Google clicks, enquiries, and pages-live key numbers, section 1 (with ranking buckets, new and lost queries, the top-queries table, and target-market scope), section 4 with the search-to-enquiry funnel, and site health as a percentage from analysis runs.
   - The client link opens the same numbers read-only and stops working after revoke.
2. **Free GEO and AEO signals.** Built on `claude/ai-visibility` (the AI visibility tab). Differences from this plan: per-agent counts go to a raw table (`ai_page_daily`) rolled up by the sync, since the ledger overwrites; question searches come from the 28-day query list already fetched, without buying words (best, top, vs, near me); robots.txt verdicts cover every counted agent plus Google-Extended and Applebot-Extended; rich results wait until `searchAppearance` × `date` is verified against a live property.
   - AI crawler and live-fetch counts appear by engine.
   - AI-referred visits are counted, and Eumon leads split by landing source.
   - Question-query and rich-result series appear, along with the FAQ-page counts and the search-visibility line.
3. **Paid AI answer checks.**
   - With at least one engine key set, the weekly workflow fills mention rate, citation rate, and share of voice per engine.
   - Every rate drills down to its stored answers.
   - Engines without keys read "not configured".
