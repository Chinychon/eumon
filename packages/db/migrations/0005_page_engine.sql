-- Programmatic page engine: scoped datasets, scrape sources, structured
-- records, page templates, generated pages, and their performance.

-- The scoping agent's read of the business, reused when designing templates.
CREATE TABLE IF NOT EXISTS site_scopes (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  goal TEXT,
  business_summary TEXT NOT NULL,
  conversion_goal TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  description TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  key_field TEXT NOT NULL,
  page_ideas_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_datasets_site ON datasets(site_id);

CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  url_pattern TEXT,
  max_pages INTEGER NOT NULL,
  origin TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL,
  robots_allowed INTEGER,
  record_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_sources_dataset ON data_sources(dataset_id);

CREATE TABLE IF NOT EXISTS data_records (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  record_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  source_id TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_data_records_key ON data_records(dataset_id, record_key);

-- Generic background job status (scrapes today; generation and syncs later).
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_subject ON jobs(subject_id, created_at);

-- URLs a scrape job will visit, so large sources never pass through one
-- Workflow step result.
CREATE TABLE IF NOT EXISTS scrape_queue (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  records_found INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, url)
);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_state ON scrape_queue(job_id, state);

CREATE TABLE IF NOT EXISTS page_templates (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_templates_dataset ON page_templates(dataset_id);

CREATE TABLE IF NOT EXISTS generated_pages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES page_templates(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  group_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content_json TEXT NOT NULL,
  quality_score REAL NOT NULL,
  quality_issues_json TEXT NOT NULL,
  status TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_pages_path ON generated_pages(site_id, path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_pages_group ON generated_pages(template_id, group_key);
CREATE INDEX IF NOT EXISTS idx_generated_pages_status ON generated_pages(site_id, status);

-- Before/after record of every change to a live page, for impact measurement.
CREATE TABLE IF NOT EXISTS page_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES generated_pages(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  reason TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id, created_at);

CREATE TABLE IF NOT EXISTS page_settings (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  public_origin TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  site_name TEXT NOT NULL,
  brand_color TEXT NOT NULL,
  cta_label TEXT NOT NULL,
  cta_url TEXT NOT NULL,
  cta_copy TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cta_variants (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  copy TEXT NOT NULL,
  url TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cta_variants_site ON cta_variants(site_id);

-- Daily per-page counters. Bot hits come from server renders; views and CTA
-- clicks come from the in-page beacon (humans only); search columns come from
-- Search Console syncs. Conversions are attributed via page_sessions instead.
CREATE TABLE IF NOT EXISTS page_metrics_daily (
  site_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  day TEXT NOT NULL,
  googlebot_hits INTEGER NOT NULL DEFAULT 0,
  other_bot_hits INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  cta_clicks INTEGER NOT NULL DEFAULT 0,
  -- Search Console, per page and day (overwritten on each sync).
  search_clicks INTEGER NOT NULL DEFAULT 0,
  search_impressions INTEGER NOT NULL DEFAULT 0,
  search_position REAL,
  PRIMARY KEY (page_id, day)
);
CREATE INDEX IF NOT EXISTS idx_page_metrics_site_day ON page_metrics_daily(site_id, day);

-- First generated page an anonymous session landed on, for attributing
-- conversions that happen elsewhere on the customer's site.
CREATE TABLE IF NOT EXISTS page_sessions (
  session_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_sessions_page ON page_sessions(page_id);

-- Search Console rows for generated pages (page × query, last synced window).
CREATE TABLE IF NOT EXISTS page_search_metrics (
  site_id TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_conversion_events_session ON conversion_events(session_id);
