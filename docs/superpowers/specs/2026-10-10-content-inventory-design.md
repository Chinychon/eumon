# Content inventory and a Supabase table source

**Status:** sub-project D of "match the MedBay report" (2026-10-09); built straight through at the user's request.

**Goal:** the MedBay report's §1 and §3.1 came from the client's database: 7,720 doctors of whom 630 have no English bio, 819 procedures of which only 60 have an overview, 40 doctor profiles that are duplicates. Eumon's Data section already holds a client's records as **datasets** (CSV import, scrapes of the client's own pages). This makes a dataset answer those questions — field completeness by language, records listed twice, records whose pages are thin — as findings and as a card, and lets a dataset read a **Supabase table** directly (read-only) so the inventory stays current without CSV exports.

**Out of scope:** writing to the client's database; merging records automatically (the existing "Merge duplicates" action stays the operator's); other databases (the pull is PostgREST; Postgres connection strings later).

## 1. Inventory

`inventory(dataset, records, pages?)` in `packages/pages/src/inventory.ts` (pure, beside the page engine's `fieldCoverage`):

- **Fields:** for every field, how many records have a value and the share.
- **Languages:** fields whose key ends in a language code (`bio_en`, `bio_id`, `bio-zh`) or whose label carries one (`Bio (EN)`) are grouped by their base: "Bio: EN 92%, ID 92%, ZH 91%".
- **Duplicates:** records whose name (the key field's value, or a field named `name`/`title`) is the same once lower-cased, stripped of honorifics (`dr`, `dato'`, `datuk`, `prof`) and punctuation; groups and the records in them, with examples.
- **Pages:** when records carry a URL on the site (`sourceUrl` from a scrape of the site's own pages, or a `url` field), the latest crawl says which of those pages are **thin** (empty shell or under 250 characters of text) or **missing** (404/410 or not crawled).

`GET /api/datasets/:id/inventory` serves it; the dataset card in Data shows it under **Inventory** (fill bars per field, languages grouped, duplicates with the existing Merge button beside them, thin pages).

## 2. Findings

`findingsFromInventory` (connector signals, category `content`), per dataset with 50 records or more:

1. **"⟨missing⟩ of ⟨records⟩ ⟨entities⟩ have no ⟨field⟩ (⟨language⟩)"** — the language variant most records lack (the lowest share) when at least 50 records lack it — MedBay's English bios are 92% filled and still 630 doctors short; without language variants, any field under 50% filled with at least 50 missing, the worst one. Recommendation: write them, starting with the entities whose pages Google already indexes; the landing-page engine skips records that lack them.
2. **"⟨n⟩ ⟨entities⟩ are listed more than once"** — when duplicate groups hold 4 records or more. Recommendation: merge in the data (the Merge duplicates action proposes merges) and redirect the dropped page to the kept one.
3. **"⟨thin⟩ ⟨entity⟩ pages have almost no content"** — when thin pages are at least 10 and 5% of linked pages (MedBay: 596 of about 7,000). Recommendation: fill the record (the page follows) or leave the page out of the sitemap until it has content.

## 3. A Supabase table as a source

- A new source kind, `supabase`: `url` is the project URL, the table (or view) name rides in the source's `urlPattern` field, the **read-only API key** the operator pastes is stored encrypted in `oauth_credentials` under provider `supabase:<source id>` with the same AES-GCM sealing the Google refresh token uses, and is never returned.
- **Pull:** `POST /api/sources/:id/pull` reads the table through PostgREST (`/rest/v1/<table>?select=*&offset=&limit=1000`, `apikey` and `Authorization: Bearer` headers) in pages of 1,000 up to 40,000 rows per pull, maps columns to fields by key or label (the CSV mapping), and upserts the records; it reports rows read and records written. The daily sync pulls every Supabase source of the site (`supabase` source, cadence daily).
- Setup in the dataset card's **Add source** form: Supabase table → project URL, table, read-only key (password field). Guidance beside it: create a dedicated role or an anon key with RLS that can only `select` the columns Eumon needs; the service-role key is never the right one.

## 4. Demo

The demo's Dentists dataset gains `bio_en` and `bio_ms` fields with the Malay bio missing for half of the 128 seeded dentists, so the inventory card has languages to show and the latest analysis carries "64 of 128 dentists have no Bio (MS)".

## 5. Testing

- pages: `inventory` fills, language grouping, duplicates (honorifics and case), thin and missing pages from a crawl map.
- agents: the three findings' thresholds and titles; no findings under 50 records.
- web: the pull with a fake PostgREST (two pages, column mapping, upsert count, key never echoed); the inventory handler over SQLite with a crawl; the credential sealed and opened.
- demo: the inventory finding in the latest demo analysis.

## Rulings while building

- No daily Supabase pull: the Results sync runs every source in one workflow step, already close to the Free plan's 50 subrequests, and a pull is up to 40. The table is read when the source is added and on **Pull now**; a scheduled pull belongs in its own workflow step later.
- `inventory(dataset, records, pages?)` became `inventoryFromRows(fields, rows)` over SQL counts (`datasetInventoryRows`): a 7,704-record dataset is counted in the database, not loaded into the Worker.
- The language-gap rule has no 90% ceiling (above): the test and the MedBay report both flag a 92%-filled field with 630 records missing.
- Thin pages fire at a twentieth of the linked pages, not a tenth: 596 thin doctor pages of 7,000 is the case the report made.
- The demo seeds 128 dentists (the twelve leavers are left out), so the Malay bio is missing for half of them to clear the 50-missing threshold.
