-- Organic Growth Engine D1 schema
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  github_owner TEXT,
  github_repo TEXT,
  github_installation_id TEXT,
  default_branch TEXT,
  fingerprint_json TEXT,
  gsc_property TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL,
  summary TEXT,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  analysis_id TEXT NOT NULL REFERENCES analyses(id),
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  organic_impact_score REAL NOT NULL,
  recommendation TEXT,
  pages_affected_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  analysis_id TEXT NOT NULL REFERENCES analyses(id),
  url TEXT NOT NULL,
  status INTEGER,
  title TEXT,
  is_empty_shell INTEGER DEFAULT 0,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crawl_snapshots (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  analysis_id TEXT NOT NULL REFERENCES analyses(id),
  url TEXT NOT NULL,
  fetch_mode TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT,
  byte_length INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_metrics (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  analysis_id TEXT,
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

CREATE TABLE IF NOT EXISTS competitors (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  domain TEXT NOT NULL,
  category TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  summary TEXT NOT NULL,
  architecture_notes TEXT,
  content_notes TEXT,
  conversion_notes TEXT,
  technical_notes TEXT,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  analysis_id TEXT NOT NULL REFERENCES analyses(id),
  title TEXT NOT NULL,
  search_demand REAL NOT NULL,
  intent TEXT NOT NULL,
  current_rank REAL,
  competitor_strength REAL NOT NULL,
  current_page TEXT,
  potential_page TEXT,
  estimated_difficulty REAL NOT NULL,
  business_value REAL NOT NULL,
  conversion_potential REAL NOT NULL,
  technical_effort REAL NOT NULL,
  content_effort REAL NOT NULL,
  priority_score REAL NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS growth_plans (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  analysis_id TEXT NOT NULL REFERENCES analyses(id),
  situation TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  competitive_advantage TEXT NOT NULL,
  highest_impact_opportunity TEXT NOT NULL,
  priorities_json TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  analysis_id TEXT NOT NULL REFERENCES analyses(id),
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

CREATE TABLE IF NOT EXISTS conversion_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  event TEXT NOT NULL,
  destination TEXT,
  page_url TEXT,
  session_id TEXT,
  properties_json TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_credentials (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  provider TEXT NOT NULL,
  encrypted_blob TEXT NOT NULL,
  scopes TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_site ON findings(site_id);
CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(site_id);
CREATE INDEX IF NOT EXISTS idx_search_metrics_site ON search_metrics(site_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_site ON opportunities(site_id);
CREATE INDEX IF NOT EXISTS idx_conversion_events_site ON conversion_events(site_id);
