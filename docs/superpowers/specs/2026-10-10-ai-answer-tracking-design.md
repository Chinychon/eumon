# AI answer tracking: does ChatGPT name you when people ask?

**Status:** sub-project 2 of the competitor-features program (2026-10-10); built straight through at the user's request. Stacked on rank tracking (PR #27), whose step machinery it reuses.

**Goal:** Eumon already measures what AI systems *do with the site's pages* (AI crawler and live fetches on Eumon pages, AI-referred visits, AI Overview citations for checked searches). It doesn't measure what they *say*. Ahrefs Brand Radar and Semrush's AI Visibility Toolkit ask the assistants questions and record whether the brand is mentioned and the site cited. This sub-project does the same for questions the user chooses, in each target market, every week, and turns gaps into findings and opportunities the growth plan ranks.

**Success:** on the AI visibility tab the user enters up to 25 questions people ask (with suggestions from Search Console question queries and tracked keywords) and the names the brand goes by. After the next sync, a card shows for each question and engine whether the answer **mentions** the brand and **cites** the site, with which competitors are mentioned or cited instead; the share of voice across the site and its competitors per engine; the domains AI cites most for these questions; and the trend week by week. A question where competitors are cited and the site isn't is an opportunity; losing citations is a finding. The client link shows the card read-only. The demo shows a full example.

**Out of scope:** Claude and Copilot (DataForSEO's scraper covers ChatGPT and Gemini; Claude answers come only from its API, which doesn't reflect the consumer product); sentiment; prompt volume ("AI search volume"); DataForSEO's LLM Mentions database ($100/month minimum); generating answer-ready content (the fix engine's job); alerts by email.

## Engines and sources

One DataForSEO account (already configured) covers all four. Every check is one task, Live mode, in the market's location and the site's page language.

| Engine | Endpoint | What it returns | Cost |
|---|---|---|---|
| ChatGPT | `ai_optimization/chat_gpt/llm_scraper/live/advanced` | The answer chatgpt.com gives (with web search), `markdown`, `sources[]` (`domain`, `url`, `title`), `brand_entities[]` | ~$0.004 |
| Gemini | `ai_optimization/gemini/llm_scraper/live/advanced` | Same shape | ~$0.004 |
| Google AI Mode | `serp/google/ai_mode/live/advanced` | `ai_overview` elements: `markdown`, `references[]` (`domain`, `url`) | ~$0.004 |
| Perplexity | `ai_optimization/perplexity/llm_responses/live`, model `sonar`, `web_search_country_iso_code` = the market's alpha-2 | `items[].sections[].text`, `annotations[]` (`url`, `title`) | ~$0.007 |

The scrapers return what a person sees in the product, not a bare model answer, which is what Ahrefs and Semrush measure. Google's AI Overviews are already measured by the search-results source (`serp_ai_cited`); the card shows them beside the four engines from that data, not a fifth fetch.

**Cost:** questions × markets × about $0.019 a week (four engines). 25 questions in one market: about $2 a month; the editor shows the estimate.

**Gate:** the workspace's `dataForSeo` limit, as for rank tracking; the demo never calls DataForSEO.

## 1. Store

Migration `0026_ai_answers.sql` (0025 is rank tracking; renumber at merge if another branch took it):

- `ai_prompts (site_id REFERENCES sites ON DELETE CASCADE, prompt, created_at, PRIMARY KEY (site_id, prompt))` — prompts trimmed, whitespace collapsed, 5–200 characters, case kept (answers can depend on it), de-duplicated case-insensitively.
- `ai_brand_names (site_id REFERENCES sites ON DELETE CASCADE, name, PRIMARY KEY (site_id, name))` — up to 5 names the brand goes by; the site's name and its bare domain label are always matched too.
- `ai_answer_checks (site_id REFERENCES sites ON DELETE CASCADE, prompt, market, engine, day, mentioned INTEGER, cited INTEGER, cited_rank INTEGER NULL, sources_json, rivals_json, excerpt, PRIMARY KEY (site_id, prompt, market, engine, day))`, index `(site_id, day)`. `sources_json`: up to 20 `{ domain, url }` in the answer's order; `rivals_json`: competitor domains mentioned or cited, each `{ domain, mentioned, cited }`; `excerpt`: up to 600 characters of the answer around the first mention (or its start). Answers themselves aren't kept (size).

`packages/db/src/ai-answers.ts`: `setAiPrompts`, `listAiPrompts`, `setAiBrandNames`, `listAiBrandNames`, `saveAiAnswerChecks` (batched upsert), `listAiAnswerChecks(db, siteId, fromDay)`, `aiCheckedSince(db, siteId, day): Set<"prompt|market|engine">`, `pruneAiAnswerChecks(db, siteId, before)` (older than 400 days).

## 2. Reading an answer (pure, `packages/core/src/ai-answers.ts`)

`readAnswer({ text, sources, brandNames, site, competitors })` → `{ mentioned, cited, citedRank, rivals, excerpt }`:
- **mentioned:** any brand name (case-insensitive, whole-word: not inside another word; names of three characters or fewer need an exact-case match) or the site's bare domain appears in the answer text.
- **cited:** a source's domain is the site's domain or a subdomain of it; `citedRank` = its 1-based position among the distinct source domains.
- **rivals:** each current competitor domain, mentioned (its domain or its label, e.g. "brightcare-dental" for brightcare-dental.example, in the text) and/or cited (in the sources).
- **excerpt:** 600 characters centred on the first mention, else the answer's first 600.

Engine parsers (`packages/agents/src/dataforseo.ts`): `fetchAiAnswer(auth, { engine, prompt, location, language, countryIso2 })` → `{ text, sources: Array<{ domain, url }>, cost }`, one function per endpoint shape behind one switch; domains through `bareDomain`.

## 3. The weekly steps

Each question is checked once a week per market and engine: a (prompt, market, engine) whose last check is 7 or more days old is due. Due checks are spread across the week: at most `AI_CHECKS_PER_DAY` = 40 a site a day, oldest first, so 25 questions × 4 engines in one market finish in three days and then run about 14 a day. `apps/web/src/ai-answers.ts` mirrors `rank-tracking.ts`: an `ai-queue` step, then `ai-n` steps of up to 20 checks (all one market; fetched ten at a time; a live scraper task can take up to 90 s, so 20 a step stays inside the 10-minute step timeout and under 50 subrequests: 20 fetches + reads + one batch), then `ai-counts`. It runs after rank tracking in `syncSite`, under the same gate step (`ranks-limits` is renamed `dataforseo-limits`; one step decides both). A failing check is a note; a dead step is a note and the next slice still runs.

**Ledger** (`METRICS.aiAnswers`): `sync.ai_answers`; per day the checks ran, over the latest check of every (prompt, market, engine) in the last 7 days: `ai_answers_checked`, `ai_answers_mentioned`, `ai_answers_cited`, the same per engine (`.<engine>`), and per current competitor `ai_answers_mentioned:<domain>`, `ai_answers_cited:<domain>`. Share of voice and rates are derived by the reader.

## 4. Editor and API

`PUT /api/sites/[siteId]/ai-prompts` with `{ prompts: string[], brandNames: string[] }` (write access; the `dataForSeo` gate; at most 25 prompts and 5 names; validation as in §1). `GET` returns both lists plus `suggestions`: up to 10 of the site's own question queries from the latest Search Console top-queries list (`QUESTION_QUERY_PATTERN`, most impressions first), verbatim, that aren't in the list yet. No suggestions are invented.

## 5. View and card

`packages/core/src/ai-answers.ts` also has `aiAnswersView({ prompts, checks, markets, competitors, site, today, overview })`:
- per (prompt, market): one cell per engine with the latest check (mentioned, cited, citedRank, rivals, excerpt, day) or null;
- per engine: mention rate and citation rate over the latest checks, and the same for each competitor (share of voice = a domain's mentions ÷ all mentions of the site and its competitors);
- top cited domains across the latest checks (count, and whether it is the site, a competitor, or other), top 10;
- weekly series of the site's mention and citation rates (last 12 weeks);
- `overview`: Google AI Overview citations for the checked searches, from `serp_ai_cited`/`serp_ai_overviews` (existing).

**AI answers card**, top of the AI visibility tab: KPIs (questions tracked, mentioned in, cited in — as "x of y answers"); a `Radar` of mention rate per engine for the site and up to 3 competitors; share-of-voice `BarList`; the question grid (rows = questions × markets, columns = engines; a cell shows ● cited, ◐ mentioned, ○ neither, "—" not checked yet; hovering/clicking a cell shows the excerpt and who was cited); "Sites AI cites for these questions" list; the weekly line. Editor for users: prompts textarea, brand names input, suggestions as add-buttons, the cost line. Empty states as rank tracking (credentials, markets, no questions, no checks yet). Client link: read-only, unchecked cells hidden.

## 6. Growth plan

`ConnectorSignals.aiAnswers` (latest checks of the last 90 days, prompts, competitors, today).

- **Finding "AI assistants cite competitors but not you for N of M questions"** (category `ai_visibility`): over the latest checks, questions where at least one competitor is cited or mentioned and the site is neither, in at least 2 engines; fires at N ≥ 3. Summary names the questions (up to 5) and the competitors cited; evidence lists them. Recommendation: the citation levers (the answer to the question in the first lines of a page, statistics and quotes with sources, Q&A structure, fresh dates; get listed on the sites AI cites — the card shows them).
- **Finding "ChatGPT stopped citing you for N questions since ⟨day⟩"** (per engine, `ai_visibility`): questions cited in the earlier of two consecutive checks and not in the latest; fires at N ≥ 2; stays while not cited again (90-day window), like rank findings.
- **Opportunity per question** (up to 5): "Get cited for “⟨prompt⟩”" where competitors are cited and the site isn't, `priorityScore` comparable with keyword gaps (engines missing × 8, × 1.5 when a competitor is cited in ≥ 2 engines); rationale names the cited pages to study.

## 7. Demo

Six questions in Malaysia, four engines, eight weeks: the clinic is cited by Perplexity and AI Mode for two, mentioned by ChatGPT for three, absent from Gemini; a competitor is cited for four; one question lost its ChatGPT citation two weeks ago, so both findings and the opportunities show.

## 8. Testing

- core: `readAnswer` (whole-word, short names, subdomains, rank, rivals by label and by source, excerpt centring); `aiAnswersView` (latest per cell, rates, share of voice, top domains, weekly series).
- agents: each engine parser from captured-shape fixtures (answer text and sources extracted; an empty answer is a check with nothing mentioned, not an error; a refused task throws); findings and opportunity thresholds; persistence.
- db: lists, upsert, `aiCheckedSince`, prune, cascade.
- web: queue spreads due checks (40 a day, oldest first, 7-day freshness), slices one market ≤ 20, a failing check is a note, a dead step doesn't stop the next; the route's validation and gate; results loading.
- demo: findings and an opportunity present.

## Phases

One plan. Order: store, reading + parsers, steps, route, view + card, growth plan, demo, docs.
