-- Results: the site's top Search Console queries over the last 28 days, each
-- beside the 28 days before, replaced by every sync. One row per site.
CREATE TABLE IF NOT EXISTS search_top_queries (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  property TEXT NOT NULL,
  markets TEXT NOT NULL,
  period_end TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
