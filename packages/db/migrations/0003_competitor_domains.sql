CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_site_provider
  ON oauth_credentials(site_id, provider);

CREATE TABLE IF NOT EXISTS site_competitor_domains (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, domain)
);
