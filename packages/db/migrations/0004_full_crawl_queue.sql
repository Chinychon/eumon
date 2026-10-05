-- Persist a sitemap-driven crawl without putting tens of thousands of pages
-- into one Workflow result or one D1 report row.
ALTER TABLE pages ADD COLUMN crawl_state TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE pages ADD COLUMN crawl_error TEXT;
ALTER TABLE pages ADD COLUMN crawled_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_analysis_url ON pages(analysis_id, url);
CREATE INDEX IF NOT EXISTS idx_pages_analysis_crawl_state ON pages(analysis_id, crawl_state);
