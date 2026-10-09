# Context: the words this codebase uses

Short definitions of the domain terms that name modules and seams. Architecture reviews read this first; keep it to terms that would otherwise be ambiguous.

## Performance

- **Performance** (view): the client-facing page that answers "is it working": Google clicks since go-live, enquiries, speed, authority. Formerly *Results*; the code still says `results` in file and route names. The read-only **client link** (`/r/<token>`) shows the same view without site health.
- **Ledger**: `metric_points`, one value per site, metric and day. Numbers over time live here, and every ratio is derived by the reader. Upserts overwrite, so re-runs and Google's revised days never double count.
- **Metric group** (`METRICS` in `packages/core/src/results.ts`): the ledger metrics one upstream connection writes. A group is what its sync may write, what the view reads, and what a changed property clears.
- **Marker**: a `sync.*` metric a source writes after each run. Its absence means a first run, which backfills history.
- **Snapshot** (`site_snapshots`, `packages/db/src/snapshots.ts`): a "latest list" that replaces itself, keyed by kind and scope: `top_queries` (property|markets), `keywords` (property|market: the site's Search Console queries priced by DataForSEO), `competitor_keywords` (domain|market: a domain's ranked keywords). The scope names what made the list, so a changed property, market or competitor hides the old list until the next sync. Counts derived from a list (`kw_top10`, `kw_traffic`) go in the ledger so they trend.
- **Keyword gap**: a competitor's ranked keyword the site appears for in none of its lists; the best-placed competitor stands for it. The Keywords card shows the 25 biggest; the growth plan turns the reachable ones (volume ≥ 100, difficulty ≤ 40) into `keyword_gap` opportunities.

## Sync

- **Source** (`apps/web/src/results-sources.ts`): one thing the sync collects: Search Console daily series, rankings, top queries, URL inspection, GA4, CrUX, PageSpeed, Open PageRank, the site's own numbers. Each knows its upstream, its cadence and its points. Adding a feed means adding a source, not editing the runner.
- **Sync runner** (`syncResults` in `apps/web/src/results-sync.ts`): runs every source for one site, connecting Google once, writing points and markers, turning a throw into a `<name> failed` note. "Sync now" and the daily workflow both call it.
- **Refusal**: a URL Inspection answer that holds for the rest of the day: quota (429), a revoked token (401), or a whole batch of 403. A lone failure is one URL Google won't inspect; the queue moves past it.

## Growth plan

- **Opportunity**: a prioritised thing to do, from search data, competitor content, collected datasets or a technical finding. Its `searchDemand` and `estimatedDifficulty` come from one **demand estimate** (`packages/agents/src/demand.ts`); until keyword data is synced they are heuristics, and the rationales say so.
