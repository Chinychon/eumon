-- URLs from Search Console's Page indexing exports (a reason's URL list), with the reason Google gave,
-- when Google last crawled each, and — for URLs the current sitemap crawl doesn't know — what a live
-- fetch found and the live page a gone URL should redirect to. The overview table is a snapshot
-- (kind 'search_console_summary'); the chart is the ledger metrics gsc_indexed / gsc_not_indexed.
CREATE TABLE IF NOT EXISTS search_console_urls (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  reason TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  last_crawled TEXT,
  imported_at TEXT NOT NULL,
  live_status INTEGER,
  live_final_url TEXT,
  live_noindex INTEGER,
  checked_at TEXT,
  suggested_url TEXT,
  PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_search_console_urls_reason ON search_console_urls (site_id, reason);
