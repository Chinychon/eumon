# Results: metrics that prove SEO, GEO, and AEO improvement

Date: 2026-10-06 · Status: approved design, awaiting spec review

## Goal

Show, with real numbers over time, whether Eumon is improving a client's visibility and leads in search engines (SEO), in AI-generated answers (GEO), and in answer features such as rich results and question searches (AEO).

**Audience:** one view for both. The operator (Eumon's founder, running sites for clients) uses it to see what works; each client gets a read-only link to the same numbers for their own site.

**Success:** for any site, the operator can open one view and say how leads, search traffic, and AI visibility have changed since Eumon's pages went live, and every number traces back to its source.

## Non-goals

- Third-party SERP rank tracking, backlink data, or competitor traffic estimates.
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
| `queries_top3`, `queries_top10` | SEO | Distinct queries with average position ≤ 3 / ≤ 10 over the last 7 days | Search Console, `query` | weekly | latest | 1 |
| `googlebot_fetches` | SEO | Googlebot requests to Eumon pages | `page_metrics_daily` | daily | sum | 1 |
| `crawl_urls`, `crawl_empty_shells`, `crawl_http_errors`, `crawl_noindex` | Site health | Coverage from an analysis run | analysis report | per analysis | latest | 1 |
| `ai_crawler_fetches` (+ `.<engine>`) | GEO | AI training and AI-search crawler requests to Eumon pages | request user agent | daily | sum | 2 |
| `ai_live_fetches` (+ `.<engine>`) | GEO | Requests an AI assistant made to answer a person (ChatGPT-User, Perplexity-User, …) | request user agent | daily | sum | 2 |
| `ai_referral_visits` (+ `.<assistant>`) | GEO | Eumon page views whose visitor arrived from an AI assistant | beacon referrer / `utm_source` | daily | sum | 2 |
| `ai_crawlers_allowed` | GEO | Major AI crawlers robots.txt allows (of 5) | analysis report | per analysis | latest | 2 |
| `question_impressions`, `question_clicks` | AEO | Search Console rows whose query is a question (see Question queries) | Search Console, `query` + `date` | daily | sum | 2 |
| `rich_result_impressions` | AEO | Impressions with a rich-result search appearance | Search Console, `searchAppearance` | daily | sum | 2 |
| `published_pages`, `faq_pages` | AEO | Published Eumon pages, and those with an FAQ block (every Eumon page already carries entity JSON-LD) | generated pages (`content_json.faq`) | daily | latest | 2 |
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

## Results view (operator)

- A new **Results** navigation item, between Overview and Data. It is built in the dashboard's established visual world through Impeccable's new-surface flow.
- **Sections:** Outcomes, SEO, GEO, AEO, Site health, in that order.
- **Each metric shows:**
  - The current-window value.
  - Change against Before, and against Previous (and Year over year when available).
  - A line over time with a go-live marker. Daily metrics show 16 months; weekly metrics show every point since collection began.
- **States:**
  - Too few points: "collecting since <date>", with no number.
  - No Search Console property: a connect prompt.
  - AI engine unconfigured: "not configured".
  - Incomplete AI week: labeled "incomplete".
  - Freshness ("Search Console data through <date>") under each Search Console section.
- **Drill-downs:** a GEO rate opens the questions and answers behind it, excerpt and citations included. A lead count opens the landing pages that produced the leads.
- **Operator-only controls:** edit the AI question set and brand aliases, copy and revoke the client link, and the AI checks' weekly call count.

## Client view

- `GET /r/<token>`. The token is `signToken({ siteId, v: report_share_version }, 5 years)` from `packages/core`. It is valid while `v` matches the site's current version. Revoking increments the version and kills every earlier link.
- It renders the Results sections read-only, titled with the client's site name, with a small "Report by Eumon" credit. It has no operator controls, no call counts, and no question editing. Answer excerpts and citations stay visible, because they are the evidence.
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

## Phases and acceptance

1. **Ledger, SEO, leads.**
   - Connecting Search Console on a site fills 16 months of daily clicks and impressions.
   - Results shows site and Eumon-page series with a go-live marker, leads with Eumon leads, the weekly top-3/top-10 counts, and site health from analysis runs.
   - The client link opens the same numbers read-only and stops working after revoke.
2. **Free GEO and AEO signals.**
   - AI crawler and live-fetch counts appear by engine.
   - AI-referred visits are counted, and Eumon leads split by landing source.
   - Question-query and rich-result series appear, along with the structured-page counts.
3. **Paid AI answer checks.**
   - With at least one engine key set, the weekly workflow fills mention rate, citation rate, and share of voice per engine.
   - Every rate drills down to its stored answers.
   - Engines without keys read "not configured".
