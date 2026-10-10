# Backlink details: the links that count, the ones you lost, and the spam you didn't ask for

**Status:** sub-project 3 of the competitor-features program (2026-10-10); built straight through at the user's request. Stacked on AI answer tracking (PR #28, itself on #27).

**Goal:** the Backlinks card shows totals per domain (DataForSEO `summary`) and the link gap. Semrush and Ahrefs list every link with its anchor, follow status, first/last seen, and new and lost links. This sub-project adds the site's own **referring domains**, one row each, with the link that matters most from each, and sorts them into **real** links and **spam networks**, so the totals stop misleading and the growth plan can act on lost links and links pointing at missing pages.

**Why spam first (calibration, Semrush, 2026-10-10):** Semrush counts 872 backlinks from 845 domains for medbaycare.com. About 840 come from link networks: the same anchor on hundreds of domains ("Premium SEO Authority Backlinks to Help medbaycare.com Websites Rank Higher" on 687 domains; "High Quality Dofollow Backlinks DA 50 PA 40 Premium PBN…" on 72; "Reliable PBN Backlinks for medbaycare.com…" on 60), the same page path on every domain (`/dir/seo-growth-backlinks-133226`, `/all/1873/27.html`, `/share/134128`), page authority 0, and nearly all first seen in the last weeks. A list sorted by count or recency would be almost all junk, and "referring domains: 845" overstates the site's authority roughly thirtyfold. Users and their clients need the real number.

**Success:** on the Competitors tab the Backlinks card gains a "Your links" section: real referring domains (with the spam count beside it), new and lost real links in 30 days, links pointing at missing pages, a table of the strongest real referring domains (domain, rank, anchor, follow, first seen, new/lost/broken badges, linking page), the anchor mix of real links, and the spam networks found (the shared anchor or path, how many domains, since when). The growth plan gets findings for lost real links, links to missing pages, and a spam-link wave. The client link shows the section read-only. The demo shows it all.

**Out of scope:** per-link lists for competitors (the link gap already lists prospects); disavow-file generation (Google ignores most spam links; disavow is only for manual actions — the finding says so); outreach tooling; alerts by email (the findings inbox will carry these later); historical link charts beyond the existing referring-domains line.

## Source

DataForSEO Backlinks API `backlinks/backlinks/live` for the site's domain: `mode: "one_per_domain"` (the strongest link from each referring domain), `backlinks_status_type: "all"` (live and lost), `include_subdomains: true`, `exclude_internal_backlinks: true`, `order_by: ["domain_from_rank,desc"]`, `limit: 1000`. Per item: `domain_from`, `url_from`, `url_to`, `anchor`, `dofollow`, `first_seen`, `last_seen`, `is_lost`, `is_broken` (the target page answers 4xx/5xx), `domain_from_rank`, `backlink_spam_score`, `item_type`.

**Cost:** one request + up to 1,000 rows ≈ $0.024 + $0.036 = $0.06 per refresh (pay-as-you-go since DataForSEO's July 2026 change; no monthly minimum). Refreshed with the site's link profile, every 28 days. **Gate:** the workspace's `dataForSeo` limit, as for the rest of the backlinks source; "Backlinks API not active" is handled as today.

## 1. Store

Migration `0027_referring_domains.sql`: `referring_domains (site_id REFERENCES sites ON DELETE CASCADE, domain, url_from, url_to, anchor, dofollow INTEGER, first_seen TEXT, last_seen TEXT, lost INTEGER, broken INTEGER, rank INTEGER, spam_score INTEGER NULL, spam INTEGER, spam_reason TEXT NULL, PRIMARY KEY (site_id, domain))`, index `(site_id, spam, rank)`. Each refresh replaces the site's rows: one `DELETE` and one `INSERT … SELECT … FROM json_each(?)` (a fixed two statements, whatever the row count). `packages/db/src/referring-domains.ts`: `replaceReferringDomains`, `listReferringDomains(db, siteId, { spam?, limit })` (strongest first), `referringDomainCounts(db, siteId, since)` → `{ real, spam, newReal, lostReal, brokenReal, dofollowReal }` in one aggregate query, `spamNetworks(db, siteId)` → groups (see §2) in one query.

## 2. Telling spam from real links (pure, `packages/core/src/backlinks.ts`)

`classifyReferringDomains(rows)` marks each row `spam` with the first reason that applies:
1. **network:** its anchor (lower-cased, whitespace collapsed, the site's domain replaced by `{site}`) is shared by ≥ 10 referring domains, or its linking page's path (URL path, digits kept) is shared by ≥ 10 referring domains. Reason `"Same anchor on N sites"` / `"Same page path on N sites"`.
2. **sales anchor:** the anchor contains link-selling vocabulary: `backlink`, `pbn`, `dofollow`, `da \d`, `dr \d`, `seo authority`, `link building`, `guest post`, `fiverr`, `rank (higher|first)`, `first page`, `buy links` (word-boundary, case-insensitive). Reason `"Link-selling anchor"`.
3. **spam score:** DataForSEO's `backlink_spam_score` ≥ 70. Reason `"Spam score N"`.

Real sites often link with just the brand or the domain as anchor, so rule 1's **anchor** test skips anchors that are empty or only the site's domain or its domain label; for those, only the **path** test can mark a network (junk "share" and "stats" pages repeat one path across many domains; real sites don't).

`spamNetworks(rows)` groups spam rows by reason key (the shared anchor or path), with count, first `first_seen`, and an example linking page.

`backlinksView({ rows, counts, networks, today })` → `{ asOf, counts, top: up to 25 real rows (live first, strongest first), anchors: real rows' anchor mix (top 10: anchor text or "(image)"/"(no text)", domains), networks: top 5, newReal: up to 10, lostReal: up to 10, brokenReal: all up to 25 }`.

## 3. The refresh

In the existing `backlinks` source: when the site's own link profile is due (28 days), also fetch the referring-domain list, classify it, and replace the rows. Ledger points on that day: `ref_domains_real`, `ref_domains_spam`, `links_new_real` (first seen in the last 30 days), `links_lost_real` (lost, last seen in the last 30 days), `links_broken_real`. Note: `backlinks: 412 referring domains read, 37 real, 375 spam (3 networks), $0.06`. One request more per month, inside the `sources` step's budget.

## 4. View and card

`ResultsInput.referring` (rows the view needs: up to 25 strongest real, the new/lost/broken lists, counts, networks — read by bounded queries, never the whole table); `ResultsView.links.own: BacklinksView | null`.

The Backlinks card gains, above the comparison table, **Your links**:
- KPIs: "Real referring domains" (with "N more from spam networks"), "New in 30 days", "Lost in 30 days", "Linking to missing pages".
- "Strongest sites linking to you": domain, rank, anchor, follow/nofollow, first seen, badges (new, lost, broken target), link to the linking page (http(s) only).
- "Anchor text" `BarList` (real links).
- "Spam networks" (collapsed by default): shared anchor or path, sites, since; one line: "Google ignores most links like these. Eumon leaves them out of your counts. Disavow only if Search Console reports a manual action."
- The comparison table's "Referring domains" for the site gains a muted "(N real)".
Client link: the section without the spam network details' example URLs.

## 5. Growth plan

`ConnectorSignals.referring` (counts, new/lost/broken lists, networks, today).
- **"N sites link to pages on your site that are missing"** (category `search`): real, live links whose target is broken; fires at ≥ 3 domains; impact 30 + 4 × n, cap 70; `pagesAffected` = the target URLs; recommendation: redirect each missing URL to its closest live page (the Search Console import's redirect suggestions apply), or restore the page; the strongest linking sites are listed. The fix engine can later turn this into redirects.
- **"You lost links from N sites in 30 days"**: real links lost in 30 days; fires at ≥ 3; impact 25 + 3 × n, cap 60; lists the strongest; recommendation: check whether the linking page changed or your target moved; ask the strongest to restore it.
- **"N spam sites started linking to you in 30 days"**: spam rows first seen in 30 days; fires at ≥ 20; impact 15 (informational); summary names the networks; recommendation: no action for most sites (Google ignores them), don't buy links, check Search Console's Manual actions; Eumon excludes them from link counts.
Persistence: the counts come from the latest refresh (28 days), so findings persist between refreshes.

## 6. Demo

The demo's link list: 40 real referring domains (varied ranks, anchors, a few nofollow), 3 new and 4 lost in 30 days, 3 pointing at missing pages, and one spam network of 120 domains sharing an anchor and a path, 90 first seen in the last month. All three findings fire.

## 7. Testing

- core: classification (each rule, brand anchors never network-spam by anchor alone, path networks, sales vocabulary, score threshold), network grouping, the view's lists and caps.
- agents: the client's request body and item parsing (from documented field names), lost/broken flags.
- db: replace (two statements), list order, counts, cascade.
- web: the backlinks source fetches the list only when the profile is due, writes rows and points, a refusal note as today.
- agents: findings' thresholds; demo assertions.

## Phases

One plan. Order: store, classification + view, client + refresh, card, findings, demo, docs.
