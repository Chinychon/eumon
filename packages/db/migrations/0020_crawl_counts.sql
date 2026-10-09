-- Crawl counters: one row per analysis and page type, kept up to date as each
-- batch of pages is saved, so the progress view (polled every few seconds)
-- reads a few rows instead of counting every crawl row each time.
CREATE TABLE crawl_counts (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  -- fetched by this analysis (complete or failed), not reused
  fetched INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  reused INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  http_errors INTEGER NOT NULL DEFAULT 0,
  empty_shells INTEGER NOT NULL DEFAULT 0,
  noindex INTEGER NOT NULL DEFAULT 0,
  challenges INTEGER NOT NULL DEFAULT 0,
  -- first and last fetch by this analysis, for the crawl rate
  first_at TEXT,
  last_at TEXT,
  PRIMARY KEY (analysis_id, family)
) WITHOUT ROWID;

-- The URLs of the latest saved batch, newest first (the progress view's "just fetched").
ALTER TABLE analyses ADD COLUMN crawl_recent TEXT;

-- Existing crawls, counted once.
INSERT INTO crawl_counts (analysis_id, family, total, pending, blocked, fetched, failed, reused, ok, http_errors, empty_shells, noindex, challenges, first_at, last_at)
SELECT analysis_id, route_family,
  COUNT(*),
  SUM(crawl_state = 'pending'),
  SUM(crawl_state = 'blocked'),
  SUM(crawl_state IN ('complete', 'failed') AND reused_from IS NULL),
  SUM(crawl_state = 'failed'),
  SUM(crawl_state = 'complete' AND reused_from IS NOT NULL),
  SUM(crawl_state = 'complete' AND status < 400 AND COALESCE(json_extract(result_json, '$.botChallenge'), 0) != 1),
  SUM(crawl_state = 'complete' AND status >= 400 AND COALESCE(json_extract(result_json, '$.botChallenge'), 0) != 1),
  SUM(crawl_state = 'complete' AND is_empty_shell = 1),
  SUM(crawl_state = 'complete' AND status < 400 AND json_extract(result_json, '$.noindex') = 1),
  SUM(crawl_state = 'complete' AND COALESCE(json_extract(result_json, '$.botChallenge'), 0) = 1),
  MIN(CASE WHEN crawl_state IN ('complete', 'failed') AND reused_from IS NULL THEN crawled_at END),
  MAX(CASE WHEN crawl_state IN ('complete', 'failed') AND reused_from IS NULL THEN crawled_at END)
FROM pages GROUP BY analysis_id, route_family;
