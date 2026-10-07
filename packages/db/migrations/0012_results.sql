-- Results: one daily point per site and metric. Sums are additive daily
-- values; snapshots are the value on that day. Ratios are derived on read.
CREATE TABLE IF NOT EXISTS metric_points (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (site_id, metric, day)
);

-- Latest URL Inspection result per published Eumon page.
CREATE TABLE IF NOT EXISTS page_index_status (
  page_id TEXT PRIMARY KEY REFERENCES generated_pages(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  coverage_state TEXT,
  last_crawl_time TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_index_status_site ON page_index_status(site_id);

ALTER TABLE sites ADD COLUMN ga4_property TEXT;
ALTER TABLE sites ADD COLUMN report_share_version INTEGER NOT NULL DEFAULT 1;
