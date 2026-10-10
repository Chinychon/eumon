# Backlink Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List the site's referring domains, one row each, sort them into real links and spam networks, show real link counts, new, lost and broken links, the anchor mix and the spam networks on the Backlinks card, and turn lost links, links to missing pages and spam waves into growth-plan findings.

**Architecture:**
- **Storage:** one table, `referring_domains`, replaced on each refresh with two statements (a delete plus an insert over `json_each`).
- **Fetching:** one DataForSEO call (`backlinks/backlinks/live`, `one_per_domain`, up to 1,000 rows) inside the existing `backlinks` source, when the site's profile is due (every 28 days).
- **Classification and view:** pure code in `packages/core/src/backlinks.ts`.
- **Findings:** in `packages/agents/src/link-findings.ts`, reached through `ConnectorSignals.referring`.
- **Display:** a "Your links" section in the existing `BacklinksCard`.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 (SQLite in tests), node:test, React, DataForSEO Backlinks API.

**Spec:** `docs/superpowers/specs/2026-10-10-backlink-details-design.md`

## Global Constraints

- Branch `claude/backlinks` is stacked on `claude/ai-answers` (PR #28). Migration number **0027** (`0027_referring_domains.sql`). The table `REFERENCES sites(id) ON DELETE CASCADE`.
- Each refresh writes in exactly two statements (a `DELETE` and an `INSERT … SELECT … FROM json_each(?)`), whatever the row count. Readers run bounded queries (`LIMIT`, or aggregates) and never load the whole table into the Results view.
- Spam rules, applied in this order: **network** (≥ 10 referring domains share the normalised anchor, *excluding* anchors that are empty or only the site's domain or its domain label, or ≥ 10 share the linking page's URL path), then **sales anchor** (the regex in Task 2), then **spam score** ≥ 70.
- "Real" means not spam. "New" means first seen within 30 days of the refresh day. "Lost" means `lost` and last seen within 30 days. "Broken" means a live real link whose target page is broken.
- Linking-page URLs are shown only when they are http(s).
- Finding thresholds:
  - broken: ≥ 3 domains, impact min(70, 30 + 4n);
  - lost: ≥ 3, impact min(60, 25 + 3n);
  - spam wave: ≥ 20 new spam domains, impact 15.
  All three use category `search`.
- Copy says "users", never "operator". Name no client businesses. Corners are hard.
- Every commit message ends with the trailer `Co-Authored-By: Claude <your model name> <noreply@anthropic.com>`.
- Test commands:
  - `npm run build:packages`
  - `npm test -w @organic-growth/<core|db|agents>`
  - `node --test apps/web/src/<file>.test.ts`
  - `npm run typecheck -w @organic-growth/web`

## Review Focus

1. A small business whose real links all use the brand name as anchor must not be marked spam by the anchor rule (Task 2 test "brand anchors are never a network by anchor alone").
2. A site with no spam must have no "spam networks" section and no spam finding, and its counts must equal the real total (Task 2 test "a clean profile"; Task 5 test "a clean profile gives no spam finding").
3. A refresh with zero rows (a new site DataForSEO doesn't know) must clear the old rows and show "no referring domains found", not stale data (Task 1 test "replacing with nothing clears"; Task 3 test).
4. `javascript:` or relative `url_from` values must never become links (Task 3 test "non-http linking pages are dropped").
5. A link lost more than 30 days ago must count in neither "lost in 30 days" nor the lost finding (Task 2 view test; Task 5 test).

---

### Task 1: Table and db helpers

**Files:**
- Create `packages/db/migrations/0027_referring_domains.sql`, `packages/db/src/referring-domains.ts` and `packages/db/src/referring-domains.test.ts`.
- Export the module from `packages/db/src/index.ts`.
- Create `packages/core/src/backlinks.ts` with the types only. Task 2 adds the functions. Export it from `packages/core/src/index.ts`.

**Interfaces:**
- **Core:**
  - `type ReferringDomain = { domain: string; urlFrom: string; urlTo: string; anchor: string; dofollow: boolean; firstSeen: string; lastSeen: string; lost: boolean; broken: boolean; rank: number; spamScore: number | null; spam: boolean; spamReason: string | null }`. The dates are `YYYY-MM-DD`.
  - `type ReferringCounts = { real: number; spam: number; newReal: number; lostReal: number; brokenReal: number; dofollowReal: number; newSpam: number }`.
- **Db:**
  - `replaceReferringDomains(db, siteId, rows: ReferringDomain[])`.
  - `listReferringDomains(db, siteId, filter: { spam?: boolean; newSince?: string; lostSince?: string; broken?: boolean; limit: number }): Promise<ReferringDomain[]>`, strongest first (rank desc, then domain).
  - `referringDomainCounts(db, siteId, since: string): Promise<ReferringCounts>`, a single aggregate query.

- [ ] **Step 1: Migration**

```sql
-- The site's referring domains (DataForSEO Backlinks, one strongest link per domain, live and lost), refreshed with
-- the link profile every 28 days and replaced whole. `spam` and `spam_reason` are Eumon's verdict (network, link-selling
-- anchor, or DataForSEO's spam score); real links are the rest.
CREATE TABLE referring_domains (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  url_from TEXT NOT NULL DEFAULT '',
  url_to TEXT NOT NULL DEFAULT '',
  anchor TEXT NOT NULL DEFAULT '',
  dofollow INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  lost INTEGER NOT NULL,
  broken INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  spam_score INTEGER,
  spam INTEGER NOT NULL,
  spam_reason TEXT,
  PRIMARY KEY (site_id, domain)
);
CREATE INDEX referring_domains_site_spam_rank ON referring_domains (site_id, spam, rank);
```

- [ ] **Step 2: Failing test** `packages/db/src/referring-domains.test.ts`. Set up a site with `upsertSite` as `ai-answers.test.ts` does. Build rows with a `row(domain, overrides)` helper. Tests:
  - "replacing writes every row and a second replace drops the old ones"
  - "replacing with nothing clears"
  - "lists strongest first, filtered by spam / new / lost / broken, limited"
  - "counts in one query: real, spam, new real since a day, lost real since a day, broken live real, dofollow real, new spam since a day"
  - "deleting the site removes the rows"

  Run `npm run build -w @organic-growth/core && npm test -w @organic-growth/db`. It should fail.

- [ ] **Step 3: `packages/db/src/referring-domains.ts`**

```ts
import type { ReferringCounts, ReferringDomain } from "@organic-growth/core";
import { runStatements, type D1Like } from "./d1.js";

/*
 * The site's referring domains, replaced whole on each refresh in two
 * statements whatever the count (the Free plan allows 50 queries a request).
 */

export async function replaceReferringDomains(db: D1Like, siteId: string, rows: ReferringDomain[]): Promise<void> {
  const json = JSON.stringify(rows.map((row) => [row.domain, row.urlFrom, row.urlTo, row.anchor, row.dofollow ? 1 : 0, row.firstSeen, row.lastSeen, row.lost ? 1 : 0, row.broken ? 1 : 0, row.rank, row.spamScore, row.spam ? 1 : 0, row.spamReason]));
  await runStatements(db, [
    db.prepare("DELETE FROM referring_domains WHERE site_id = ?").bind(siteId),
    db.prepare(
      `INSERT INTO referring_domains (site_id, domain, url_from, url_to, anchor, dofollow, first_seen, last_seen, lost, broken, rank, spam_score, spam, spam_reason)
       SELECT ?, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6, value->>7, value->>8, value->>9, value->>10, value->>11, value->>12
       FROM json_each(?) WHERE true ON CONFLICT(site_id, domain) DO NOTHING`,
    ).bind(siteId, json),
  ]);
}

type Row = { domain: string; url_from: string; url_to: string; anchor: string; dofollow: number; first_seen: string; last_seen: string; lost: number; broken: number; rank: number; spam_score: number | null; spam: number; spam_reason: string | null };
const fromRow = (row: Row): ReferringDomain => ({
  domain: row.domain, urlFrom: row.url_from, urlTo: row.url_to, anchor: row.anchor, dofollow: Boolean(row.dofollow), firstSeen: row.first_seen, lastSeen: row.last_seen,
  lost: Boolean(row.lost), broken: Boolean(row.broken), rank: Number(row.rank), spamScore: row.spam_score === null ? null : Number(row.spam_score), spam: Boolean(row.spam), spamReason: row.spam_reason,
});

export async function listReferringDomains(db: D1Like, siteId: string, filter: { spam?: boolean; newSince?: string; lostSince?: string; broken?: boolean; limit: number }): Promise<ReferringDomain[]> {
  const where = ["site_id = ?1"];
  if (filter.spam !== undefined) where.push(`spam = ${filter.spam ? 1 : 0}`);
  if (filter.newSince) where.push("first_seen >= ?2");
  if (filter.lostSince) where.push("lost = 1 AND last_seen >= ?3");
  if (filter.broken) where.push("broken = 1 AND lost = 0");
  const { results } = await db.prepare(`SELECT * FROM referring_domains WHERE ${where.join(" AND ")} ORDER BY rank DESC, domain LIMIT ?4`)
    .bind(siteId, filter.newSince ?? "", filter.lostSince ?? "", filter.limit).all<Row>();
  return results.map(fromRow);
}

export async function referringDomainCounts(db: D1Like, siteId: string, since: string): Promise<ReferringCounts> {
  const row = await db.prepare(
    `SELECT SUM(spam = 0) AS real, SUM(spam = 1) AS spam,
            SUM(spam = 0 AND first_seen >= ?2) AS new_real, SUM(spam = 0 AND lost = 1 AND last_seen >= ?2) AS lost_real,
            SUM(spam = 0 AND broken = 1 AND lost = 0) AS broken_real, SUM(spam = 0 AND dofollow = 1) AS dofollow_real,
            SUM(spam = 1 AND first_seen >= ?2) AS new_spam
     FROM referring_domains WHERE site_id = ?1`,
  ).bind(siteId, since).first<Record<string, number | null>>();
  const n = (key: string) => Number(row?.[key] ?? 0);
  return { real: n("real"), spam: n("spam"), newReal: n("new_real"), lostReal: n("lost_real"), brokenReal: n("broken_real"), dofollowReal: n("dofollow_real"), newSpam: n("new_spam") };
}
```

The `->>` JSON operator works in D1 and in the SQLite used by the tests. If the test SQLite rejects it, use `json_extract(value, '$[0]')` and so on.

- [ ] **Step 4:** Run `npm run build -w @organic-growth/core && npm test -w @organic-growth/core && npm test -w @organic-growth/db`. Expect PASS.
- [ ] **Step 5: Commit** with the message `"Backlinks: referring domains table, replaced in two statements"`.

---

### Task 2: Classification and the view (core)

**Files:** Modify `packages/core/src/backlinks.ts`. Create `packages/core/src/backlinks.test.ts`.

**Interfaces:**
- `classifyReferringDomains(rows: Omit<ReferringDomain, "spam" | "spamReason">[], site: string): ReferringDomain[]`.
- `type SpamNetwork = { key: string; kind: "anchor" | "path" | "sales" | "score"; label: string; domains: number; since: string; example: string }`.
- `spamNetworks(rows: ReferringDomain[]): SpamNetwork[]`, largest first.
- `type BacklinksView = { asOf: string | null; counts: ReferringCounts; top: ReferringDomain[]; anchors: Array<{ anchor: string; domains: number }>; networks: SpamNetwork[]; newReal: ReferringDomain[]; lostReal: ReferringDomain[]; brokenReal: ReferringDomain[] }`.
- `backlinksView(input: { asOf: string | null; counts: ReferringCounts; top: ReferringDomain[]; newReal: ReferringDomain[]; lostReal: ReferringDomain[]; brokenReal: ReferringDomain[]; spamRows: ReferringDomain[] }): BacklinksView`. Anchors come from `top`. Networks come from `spamRows`, which is a bounded sample (Task 4 loads at most 500).
- `REFERRING_LIMITS = { NETWORK_AT_LEAST: 10, SPAM_SCORE_AT_LEAST: 70, RECENT_DAYS: 30 }`, each with a comment giving its reason.

- [ ] **Step 1: Failing tests.**
  - "a link-selling anchor is spam": "High Quality Dofollow Backlinks DA 50…" gives `Link-selling anchor`.
  - "the same anchor on ten sites is a network, and the site's domain inside it doesn't stop that": 10 rows with "Premium SEO Authority Backlinks to Help x.com Websites Rank Higher" give `Same anchor on 10 sites`. The same anchor on 9 sites is not spam, unless the sales rule catches it, which this one does. Use a neutral anchor to test the count threshold.
  - "the same page path on ten sites is a network": `/dir/seo-growth-backlinks-133226` on 10 domains gives `Same page path on 10 sites`.
  - "brand anchors are never a network by anchor alone": 12 real sites with anchor "x.com" or "X", each on a different path, give no spam.
  - "a spam score of 70 or more is spam; 69 isn't".
  - "a clean profile": nothing spam, so networks is empty.
  - "spamNetworks groups by the shared anchor or path, with the earliest first seen and an example".
  - "the view's lists and anchor mix, capped": top capped at 25; the anchor mix from real rows, with an empty anchor shown as "(no text)" and an image link as "(image)" (rows whose anchor is empty and whose `urlFrom` points at an image are out of scope, so treat an empty anchor as "(no text)"). A link lost 40 days ago counts in neither list, because the db filter already excludes it. Pass lists as the db would return them.

- [ ] **Step 2: Implement.** Normalise an anchor with `lowercase`, collapse whitespace, replace the site's bare domain with `{site}`, and trim. The anchor network test skips normalised anchors that are `""`, `"{site}"` or the domain label. The path key is `new URL(urlFrom).pathname` (skip rows whose `urlFrom` doesn't parse). Use this sales regex:

```ts
const SALES = /\b(back ?links?|pbn|do ?follow|da ?\d+|dr ?\d+|seo authority|link ?building|guest ?posts?|fiverr|rank(ed)? (higher|first)|first page|buy (back)?links?)\b/i;
```

  The order is network, then sales, then score. Each row's `spamReason` is the first rule that applies.

- [ ] **Step 3:** Run `npm test -w @organic-growth/core`. Expect PASS. **Step 4: Commit** with the message `"Backlinks: tell real links from spam networks; the Your links view"`.

---

### Task 3: The client and the refresh

**Files:**
- Modify `packages/agents/src/dataforseo.ts` (add `fetchReferringDomains`) and `packages/agents/src/dataforseo.test.ts`.
- Modify `apps/web/src/connector-sources.ts` (the `backlinks` source) and `apps/web/src/connector-sources.test.ts`.
- Modify `packages/core/src/results.ts`: add to `METRICS.backlinks` the entries `ref_domains_real`, `ref_domains_spam`, `links_new_real`, `links_lost_real` and `links_broken_real`.

**Interfaces:**
- `fetchReferringDomains(auth, domain, fetchFn?): Promise<{ rows: Array<Omit<ReferringDomain, "spam" | "spamReason">>; cost: number }>`.

- [ ] **Step 1: Failing client test.**
  - The URL is `https://api.dataforseo.com/v3/backlinks/backlinks/live`.
  - The task body is exactly `{ target: "x.com", mode: "one_per_domain", backlinks_status_type: "all", include_subdomains: true, exclude_internal_backlinks: true, order_by: ["domain_from_rank,desc"], limit: 1000 }`.
  - Items map as follows:
    - `domain_from` goes through `bareDomain`.
    - `url_from` is kept only when it is http(s), otherwise `""`. Add the test "non-http linking pages are dropped".
    - `url_to`.
    - `anchor` becomes `""` when null.
    - `dofollow`.
    - `first_seen` and `last_seen`: DataForSEO gives `"2026-09-14 08:12:00 +00:00"`, keep the first 10 characters.
    - `is_lost` becomes `lost`.
    - `is_broken` becomes `broken`.
    - `domain_from_rank` becomes `rank` (0 when null).
    - `backlink_spam_score` becomes `spamScore` (null when null).
  - An empty result gives `rows: []`.
  - Rows with no `domain_from` are skipped.

- [ ] **Step 2: Implement** it next to `fetchBacklinkSummary`, using `post(auth, "backlinks/backlinks", task, fetchFn)`. `post` appends `/live`.

- [ ] **Step 3: The refresh.** In the `backlinks` source's loop, inside the `try` for the site's own domain (where `domain === own`), after the summary is saved:
  - fetch `fetchReferringDomains(keys.dataForSeo!, own, fetchFn)`;
  - classify with `classifyReferringDomains(rows, own)` and save with `replaceReferringDomains`;
  - read `referringDomainCounts(db, site.id, addDays(today, -30))`;
  - push the points `ref_domains_real`, `ref_domains_spam`, `links_new_real`, `links_lost_real` and `links_broken_real` for `today`;
  - add the note `backlinks: ${total} referring domains read, ${counts.real} real, ${counts.spam} spam (${networks} networks), ${dollars(cost)}`, where `networks` = `spamNetworks(classified).length`;
  - add the call's cost to `cost`.

  A failure of this call is caught on its own and becomes the note `referring domains skipped: …`; the summary stays saved. A "not active" refusal is treated as today.

  Tests in `connector-sources.test.ts`, using its `dataForSeoStub`:
  - `backlinks/backlinks` answers 12 items: 10 sharing a path, 2 real. The source writes 12 rows and the points (real 2, spam 10).
  - A second run within 28 days fetches nothing.
  - The stub answering `[]` clears earlier rows.

- [ ] **Step 4:** Run `npm run build:packages && npm test -w @organic-growth/agents && node --test apps/web/src/connector-sources.test.ts && npm test -w @organic-growth/core`. Expect PASS. **Step 5: Commit** with the message `"Backlinks: fetch referring domains with the link profile, classify and store them"`.

---

### Task 4: View loading and the card

**Files:**
- `packages/core/src/results.ts`: add `ResultsInput.referring?` and `ResultsView.links.own: BacklinksView | null`.
- `apps/web/src/connectors-data.ts`: `loadConnectorLists` loads the referring lists.
- `apps/web/app/components/results/ConnectorCards.tsx` (`BacklinksCard`).
- `apps/web/src/results-data.test.ts` or `connector-sources.test.ts` for the loading test.

**Interfaces:**
- `ConnectorLists.referring: { asOf: string | null; counts; top; newReal; lostReal; brokenReal; spamRows } | null`. It is null when the site has no rows.
- `asOf` is the `sync.backlinks` marker day or the backlinks snapshot's `periodEnd` for the site, whichever is easier to read in one existing query. Say which in the report.

- [ ] **Step 1: Loading.** In `loadConnectorLists`, inside its existing `Promise.all`, read:
  - counts with `since = addDays(today, -30)`;
  - top real, limit 25;
  - new real with `newSince`, limit 10;
  - lost real with `lostSince`, limit 10;
  - broken real, limit 25;
  - spam, limit 500.

  That is six bounded queries. Return `referring: null` when `counts.real + counts.spam === 0`. Pass it through `resultsPayload` into `resultsView`, which sets `links.own = referring ? backlinksView(referring) : null`. Test: a site with a few rows yields `links.own.counts` and the lists.

- [ ] **Step 2: The card.** In `BacklinksCard`, above the comparison table, when `links.own` is set, add a **Your links** section:
  - Four `Kpi`s:
    - "Real referring domains" (caption `${spam} more from spam networks` when spam > 0);
    - "New in 30 days";
    - "Lost in 30 days";
    - "Linking to missing pages".
  - "Strongest sites linking to you": a table of domain, rank, anchor (truncated at 80 characters, full text in `title`), follow ("follow"/"nofollow"), first seen (`formatDay`), and badges ("new" if first seen within 30 days, "lost", "missing page" when broken). Link to `urlFrom` only when it is non-empty; otherwise show plain text.
  - "Anchor text": a `BarList` of `anchors`.
  - When `networks.length`: a `<details>` element, closed by default, with the summary `Spam networks: ${spam} sites`. Inside, a table of label, sites, since (`formatDay`), and an example, with the example page shown as text only, not a link. Below it the line: "Google ignores most links like these. Eumon leaves them out of your counts. Disavow only if Search Console reports a manual action."
  - In the comparison table, the site's row "Referring domains" cell gains a muted `(${real} real)` when `links.own` is set.

  The client link uses the same card, and its existing `links.domains.some(summary)` condition keeps it visible. On the client link (`operator` false) the spam network examples are hidden (show label, sites and since only).

- [ ] **Step 3:** Run `npm run build:packages && npm test -w @organic-growth/core && node --test apps/web/src/results-data.test.ts apps/web/src/connector-sources.test.ts && npm run typecheck -w @organic-growth/web && npm run build -w @organic-growth/web`. Expect PASS. **Step 4: Commit** with the message `"Backlinks card: your real referring domains, new, lost and broken links, anchors, spam networks"`.

---

### Task 5: Findings

**Files:**
- Create `packages/agents/src/link-findings.ts` and `packages/agents/src/link-findings.test.ts`.
- Wire into `ConnectorSignals.referring` (`connector-findings.ts`), the `pipeline.ts` push, `connectorSignals(...)` (it reads `lists.referring`; no new argument, because the lists already carry it) and the index export.

**Interfaces:**
- `findingsFromReferring({ siteId, analysisId, referring }): Finding[]`, where `referring` is `ConnectorLists["referring"]` plus `networks: SpamNetwork[]` (computed with `spamNetworks(spamRows)`).
- `LINK_FINDINGS` holds the thresholds from Global Constraints, each with a reason.

Rules, all category `search`:
- **Broken.** `"${n} sites link to pages on your site that are missing"`. n is `counts.brokenReal`, and it fires at ≥ 3.
  - Summary: the 5 strongest (domain → target path).
  - `pagesAffected`: the distinct `urlTo` values.
  - Recommendation: "Redirect each missing address to its closest live page, or restore the page; these links count again once the address answers. The Search Console import suggests redirects for missing addresses."
- **Lost.** `"You lost links from ${n} sites in 30 days"`. n is `counts.lostReal`, and it fires at ≥ 3.
  - Summary: the 5 strongest with their last-seen day.
  - Recommendation: "Check whether each linking page changed or your page moved; ask the strongest sites to restore the link, and redirect any moved page."
- **Spam wave.** `"${n} spam sites started linking to you in 30 days"`. n is `counts.newSpam`, and it fires at ≥ 20.
  - Impact: 15.
  - Summary: the networks by label and size.
  - Recommendation: "Most sites need do nothing: Google ignores links like these. Don't buy links, and check Search Console's Manual actions page; disavow only if it reports one. Eumon leaves these sites out of your link counts."

- [ ] **Step 1: Failing tests:**
  - each rule fires at its threshold and not below;
  - "a clean profile gives no spam finding";
  - a lost link older than 30 days counts nothing (n comes from the counts, so build counts accordingly);
  - titles exact;
  - `pagesAffected` holds distinct targets.
- [ ] **Step 2: Implement and wire.** The analysis already loads `loadConnectorLists`, so findings need no new load.
- [ ] **Step 3:** Run `npm run build:packages && npm test -w @organic-growth/agents && npm run typecheck -w @organic-growth/web`. Expect PASS. **Step 4: Commit** with the message `"Backlinks: findings for links to missing pages, lost links and spam waves"`.

---

### Task 6: Demo

**Files:** `packages/agents/src/demo-connectors.ts` (seed in `seedDemoConnectors` with `replaceReferringDomains` and the day's points) and `packages/agents/src/demo.test.ts`.

- [ ] **Step 1: Failing assertions.** The demo analysis carries all three link findings. Their titles start "3 sites link to pages…", "You lost links from 4 sites…" and "90 spam sites started linking…".
- [ ] **Step 2: Seed.**
  - **Real rows:** 40 real referring domains on `.example`, built deterministically from a name list. Ranks run 40 to 520, anchors are a mix of brand, URL, generic and topical text, and 8 are nofollow.
    - 3 have first seen within 30 days.
    - 4 are lost, with last seen 5–20 days ago.
    - 3 are live with broken targets (`urlTo` on the demo origin with paths that the demo crawl answers 404 for, or plausible removed paths).
  - **Spam network:** 120 rows on `*.example` hosts. They share the anchor "Premium SEO Authority Backlinks to Help {site} Websites Rank Higher" (with the demo domain substituted) and the path `/dir/seo-growth-backlinks-77122`. Their rank is 0–5, and 90 have first seen within 30 days.
  - **Classification and points:** run the rows through `classifyReferringDomains` so `spam` is set by the real rules, not hand-set. Write the day's points as the source would.
  - **Analysis input:** the demo analysis's `connectors` gets `referring` through the same loader the web uses, or the equivalent db reads. Mirror how `serp` and `links` are provided there.
- [ ] **Step 3:** Run `npm run build:packages && npm test -w @organic-growth/agents`. Expect PASS, including the ownership test. **Step 4: Commit** with the message `"Demo site: real referring domains, lost and broken links, and a spam network"`.

---

### Task 7: Words, docs, full check

**Files:** `CONTEXT.md` (§ Connectors beyond Google: **Referring domain**, **Spam network**; § Growth plan: the three findings), `apps/web/app/components/ConnectorSetup.tsx` (the DataForSEO paragraph: "your referring domains, with new, lost and spam links, monthly"), `docs/site/pages/web-app.html` (one sentence beside the other program sentences).

- [ ] **Step 1:** Make the edits. Follow the copy rules.
- [ ] **Step 2:** Run `npm run build:packages && npm run typecheck && npm test`. Everything should pass.
- [ ] **Step 3:** Commit with the message `"Backlinks: context terms, setup copy and docs"`. Do not push or open a PR.
