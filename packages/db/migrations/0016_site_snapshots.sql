-- Latest lists that replace themselves (top queries, keyword lists): one row per
-- site, kind and scope. The scope says what made the list (property, markets,
-- competitor domain), so a list fetched for something else is never read.
CREATE TABLE IF NOT EXISTS site_snapshots (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  period_end TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, kind, scope)
);
INSERT OR REPLACE INTO site_snapshots (site_id, kind, scope, period_end, rows_json, updated_at)
  SELECT site_id, 'top_queries', property || '|' || markets, period_end, rows_json, updated_at FROM search_top_queries;
DROP TABLE IF EXISTS search_top_queries;
