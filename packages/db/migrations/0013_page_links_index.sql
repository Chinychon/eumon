-- Orphan detection looks up links by target and compares their source; covering
-- both keeps it an index seek per page instead of a scan of every link.
DROP INDEX IF EXISTS idx_page_links_target;
CREATE INDEX IF NOT EXISTS idx_page_links_target_source ON page_links(site_id, target_path, source_url);
