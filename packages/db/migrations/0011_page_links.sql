-- Same-site links found on each crawled page, by path, with both ends'
-- page types, for orphan pages and the link map. A page's links are replaced
-- whenever it is fetched again; unchanged pages keep theirs.
CREATE TABLE IF NOT EXISTS page_links (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_family TEXT NOT NULL,
  target_path TEXT NOT NULL,
  target_family TEXT NOT NULL,
  PRIMARY KEY (site_id, source_url, target_path)
);
CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(site_id, target_path);
