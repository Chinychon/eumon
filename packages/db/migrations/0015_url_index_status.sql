-- Google's index status for the site's own sitemap URLs (URL Inspection),
-- checked a few hundred a day and re-checked after 30 days.
CREATE TABLE IF NOT EXISTS url_index_status (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  family TEXT NOT NULL,
  verdict TEXT NOT NULL,
  coverage_state TEXT,
  last_crawl_time TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (site_id, url)
);
CREATE INDEX IF NOT EXISTS idx_url_index_status_checked ON url_index_status(site_id, checked_at);
