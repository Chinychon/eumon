-- Crawler requests from the site's server or CDN logs (Cloudflare Logpush, Vercel log drains, Eumon's
-- log-forwarding Worker, uploaded nginx/Apache logs). Only crawler requests are kept; a person's never is.
-- Per day, crawler (googlebot, bingbot, an AI agent's token, or 'other'), page type, status class, and
-- whether the URL had a query string.
CREATE TABLE IF NOT EXISTS crawl_log_daily (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  bot TEXT NOT NULL,
  family TEXT NOT NULL,
  status_class TEXT NOT NULL,
  query INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, bot, family, status_class, query)
) WITHOUT ROWID;

-- The latest Googlebot ('google') and Bingbot ('bing') request per path, to tell which sitemap URLs
-- a search engine hasn't fetched lately. Rows not seen for 120 days are pruned by the daily sync.
CREATE TABLE IF NOT EXISTS crawl_log_paths (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  grp TEXT NOT NULL,
  path TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_status INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, grp, path)
);
CREATE INDEX IF NOT EXISTS idx_crawl_log_paths_seen ON crawl_log_paths (site_id, grp, last_seen);
