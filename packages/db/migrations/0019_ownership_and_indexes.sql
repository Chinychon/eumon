-- One ownership rule, the missing indexes, and leaner tables.
--
-- * Every table with a site_id deletes with its site (ON DELETE CASCADE), so
--   deleting a site is one statement. Crawl results and changes delete with
--   their analysis; daily page counters with their generated page.
-- * Landing sessions are keyed by (site_id, session_id): the id comes from the
--   browser, so one site can't claim another's.
-- * Columns nothing reads are dropped; the Google connection's provider is
--   "google" (it covers Search Console, Analytics and Sheets).
-- * Crawl results are keyed by (analysis_id, url), with the page type and
--   reuse as real columns instead of JSON lookups; small, write-heavy tables
--   are WITHOUT ROWID (one write per row instead of two).
--
-- SQLite can't add foreign keys to an existing table, so each table is
-- rebuilt: create the new shape, copy the rows that still have an owner,
-- drop the old table, rename.
--
-- Crawl results and changes are set aside first and the old tables dropped
-- before analyses is replaced: dropping a table deletes its rows, and that
-- delete would cascade into any new table already pointing at analyses.

CREATE TABLE analyses_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  summary TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  progress_json TEXT,
  report_json TEXT
);
INSERT INTO analyses_new (id, site_id, status, summary, completed_at, error, created_at, progress_json, report_json)
  SELECT id, site_id, status, summary, completed_at, error, created_at, progress_json, report_json FROM analyses WHERE site_id IN (SELECT id FROM sites);

CREATE TABLE pages_kept AS SELECT * FROM pages WHERE analysis_id IN (SELECT id FROM analyses_new);
CREATE TABLE changes_kept AS SELECT * FROM changes WHERE analysis_id IN (SELECT id FROM analyses_new);
DROP TABLE changes;
DROP TABLE pages;
DROP TABLE analyses;
ALTER TABLE analyses_new RENAME TO analyses;

-- pages (crawl results): keyed by analysis and URL; page type and reuse as columns.
CREATE TABLE pages (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status INTEGER,
  title TEXT,
  is_empty_shell INTEGER NOT NULL DEFAULT 0,
  route_family TEXT NOT NULL DEFAULT 'other',
  reused_from TEXT,
  crawl_state TEXT NOT NULL DEFAULT 'complete',
  crawled_at TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (analysis_id, url)
);
INSERT OR IGNORE INTO pages (analysis_id, url, status, title, is_empty_shell, route_family, reused_from, crawl_state, crawled_at, result_json, created_at)
  SELECT analysis_id, url, status, title, COALESCE(is_empty_shell, 0), COALESCE(json_extract(result_json, '$.routeFamily'), 'other'),
         json_extract(result_json, '$.reusedFrom'), COALESCE(crawl_state, 'complete'), crawled_at, result_json, created_at
  FROM pages_kept;
DROP TABLE pages_kept;

-- changes: cascade from sites and analyses.
CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  finding_id TEXT,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  files_changed_json TEXT NOT NULL,
  pages_affected_json TEXT NOT NULL,
  patch TEXT NOT NULL,
  status TEXT NOT NULL,
  pr_url TEXT,
  pr_number INTEGER,
  author TEXT NOT NULL,
  ai_model TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO changes SELECT id, site_id, analysis_id, opportunity_id, finding_id, title, reason, evidence_json, files_changed_json, pages_affected_json,
  patch, status, pr_url, pr_number, author, ai_model, result, created_at FROM changes_kept;
DROP TABLE changes_kept;

CREATE INDEX idx_analyses_site ON analyses (site_id, status, created_at);
CREATE INDEX idx_pages_analysis_crawl_state ON pages (analysis_id, crawl_state);
CREATE INDEX idx_changes_site ON changes (site_id, created_at);

-- conversion_events: cascade; read by site and time, and by session.
CREATE TABLE conversion_events_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  destination TEXT,
  page_url TEXT,
  session_id TEXT,
  properties_json TEXT,
  occurred_at TEXT NOT NULL
);
INSERT INTO conversion_events_new SELECT id, site_id, event, destination, page_url, session_id, properties_json, occurred_at
  FROM conversion_events WHERE site_id IN (SELECT id FROM sites);
DROP TABLE conversion_events;
ALTER TABLE conversion_events_new RENAME TO conversion_events;
CREATE INDEX idx_conversion_events_site_time ON conversion_events (site_id, occurred_at);
CREATE INDEX idx_conversion_events_session ON conversion_events (session_id);

-- search_metrics: cascade; analysis_id was always null.
CREATE TABLE search_metrics_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  country TEXT NOT NULL,
  device TEXT NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  period_start TEXT,
  period_end TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO search_metrics_new SELECT id, site_id, query, page, country, device, impressions, clicks, ctr, position, period_start, period_end, created_at
  FROM search_metrics WHERE site_id IN (SELECT id FROM sites);
DROP TABLE search_metrics;
ALTER TABLE search_metrics_new RENAME TO search_metrics;
CREATE INDEX idx_search_metrics_site ON search_metrics (site_id);

-- oauth_credentials: one per site and provider, cascading; expires_at was never written.
CREATE TABLE oauth_credentials_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_blob TEXT NOT NULL,
  scopes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, provider)
);
INSERT INTO oauth_credentials_new SELECT id, site_id, CASE provider WHEN 'google_search_console' THEN 'google' ELSE provider END, encrypted_blob, scopes, created_at, updated_at
  FROM oauth_credentials WHERE site_id IN (SELECT id FROM sites);
DROP TABLE oauth_credentials;
ALTER TABLE oauth_credentials_new RENAME TO oauth_credentials;

-- page_metrics_daily: cascades from its site and its page; other_bot_hits and search_position were never read.
CREATE TABLE page_metrics_daily_new (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES generated_pages(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  googlebot_hits INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  cta_clicks INTEGER NOT NULL DEFAULT 0,
  search_clicks INTEGER NOT NULL DEFAULT 0,
  search_impressions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, day)
) WITHOUT ROWID;
INSERT INTO page_metrics_daily_new SELECT site_id, page_id, day, googlebot_hits, views, cta_clicks, search_clicks, search_impressions
  FROM page_metrics_daily WHERE site_id IN (SELECT id FROM sites) AND page_id IN (SELECT id FROM generated_pages);
DROP TABLE page_metrics_daily;
ALTER TABLE page_metrics_daily_new RENAME TO page_metrics_daily;
CREATE INDEX idx_page_metrics_site_day ON page_metrics_daily (site_id, day);

-- ai_page_daily: the same ownership.
CREATE TABLE ai_page_daily_new (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES generated_pages(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  signal TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, day, signal, name)
) WITHOUT ROWID;
INSERT INTO ai_page_daily_new SELECT site_id, page_id, day, signal, name, count
  FROM ai_page_daily WHERE site_id IN (SELECT id FROM sites) AND page_id IN (SELECT id FROM generated_pages);
DROP TABLE ai_page_daily;
ALTER TABLE ai_page_daily_new RENAME TO ai_page_daily;
CREATE INDEX idx_ai_page_daily_site_day ON ai_page_daily (site_id, day);

-- page_sessions: keyed by site and session. The page is kept without a foreign key, so a
-- session still counts as having landed on an Eumon page after that page is removed.
CREATE TABLE page_sessions_new (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (site_id, session_id)
) WITHOUT ROWID;
INSERT OR IGNORE INTO page_sessions_new SELECT site_id, session_id, page_id, first_seen_at, source FROM page_sessions WHERE site_id IN (SELECT id FROM sites);
DROP TABLE page_sessions;
ALTER TABLE page_sessions_new RENAME TO page_sessions;
CREATE INDEX idx_page_sessions_page ON page_sessions (page_id);

-- page_search_metrics: cascade.
CREATE TABLE page_search_metrics_new (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL,
  query TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  PRIMARY KEY (site_id, page_url, query)
);
INSERT INTO page_search_metrics_new SELECT site_id, page_url, query, clicks, impressions, ctr, position, period_start, period_end
  FROM page_search_metrics WHERE site_id IN (SELECT id FROM sites);
DROP TABLE page_search_metrics;
ALTER TABLE page_search_metrics_new RENAME TO page_search_metrics;

-- sync_runs: cascade.
CREATE TABLE sync_runs_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  notes_json TEXT NOT NULL
);
INSERT INTO sync_runs_new SELECT id, site_id, trigger, started_at, finished_at, notes_json FROM sync_runs WHERE site_id IN (SELECT id FROM sites);
DROP TABLE sync_runs;
ALTER TABLE sync_runs_new RENAME TO sync_runs;
CREATE INDEX idx_sync_runs_site ON sync_runs (site_id, started_at);

-- data_records: a deleted source leaves its records without a source, not pointing at nothing.
CREATE TABLE data_records_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  record_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  source_id TEXT REFERENCES data_sources(id) ON DELETE SET NULL,
  source_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO data_records_new SELECT id, site_id, dataset_id, record_key, data_json,
  CASE WHEN source_id IN (SELECT id FROM data_sources) THEN source_id END, source_url, created_at, updated_at FROM data_records;
DROP TABLE data_records;
ALTER TABLE data_records_new RENAME TO data_records;
CREATE UNIQUE INDEX idx_data_records_key ON data_records (dataset_id, record_key);
CREATE INDEX idx_data_records_source ON data_records (source_id);

-- Small, write-heavy tables without a rowid: each upsert writes one row, not two.
CREATE TABLE metric_points_new (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (site_id, metric, day)
) WITHOUT ROWID;
INSERT INTO metric_points_new SELECT site_id, metric, day, value FROM metric_points;
DROP TABLE metric_points;
ALTER TABLE metric_points_new RENAME TO metric_points;

CREATE TABLE page_links_new (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_family TEXT NOT NULL,
  target_path TEXT NOT NULL,
  target_family TEXT NOT NULL,
  PRIMARY KEY (site_id, source_url, target_path)
) WITHOUT ROWID;
INSERT INTO page_links_new SELECT site_id, source_url, source_family, target_path, target_family FROM page_links;
DROP TABLE page_links;
ALTER TABLE page_links_new RENAME TO page_links;
CREATE INDEX idx_page_links_target_source ON page_links (site_id, target_path, source_url);

CREATE TABLE url_index_status_new (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  family TEXT NOT NULL,
  verdict TEXT NOT NULL,
  coverage_state TEXT,
  last_crawl_time TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
INSERT INTO url_index_status_new SELECT site_id, url, family, verdict, coverage_state, last_crawl_time, checked_at FROM url_index_status;
DROP TABLE url_index_status;
ALTER TABLE url_index_status_new RENAME TO url_index_status;
CREATE INDEX idx_url_index_status_checked ON url_index_status (site_id, checked_at);
