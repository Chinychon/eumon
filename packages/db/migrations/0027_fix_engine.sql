-- Fix engine: each fix is a row in `changes`, from staged through its pull request to merged
-- or reverted; per-site autopilot settings.
ALTER TABLE changes ADD COLUMN fix_kind TEXT;
ALTER TABLE changes ADD COLUMN route TEXT;
ALTER TABLE changes ADD COLUMN file_path TEXT;
ALTER TABLE changes ADD COLUMN file_sha TEXT;
ALTER TABLE changes ADD COLUMN before_snippet TEXT;
ALTER TABLE changes ADD COLUMN after_snippet TEXT;
ALTER TABLE changes ADD COLUMN prompt_sha TEXT;
ALTER TABLE changes ADD COLUMN warnings_json TEXT;
ALTER TABLE changes ADD COLUMN score REAL;
ALTER TABLE changes ADD COLUMN branch TEXT;
ALTER TABLE changes ADD COLUMN head_sha TEXT;
ALTER TABLE changes ADD COLUMN pr_node_id TEXT;
ALTER TABLE changes ADD COLUMN preview_url TEXT;
ALTER TABLE changes ADD COLUMN verification_json TEXT;
ALTER TABLE changes ADD COLUMN updated_at TEXT;
CREATE INDEX idx_changes_site_status ON changes (site_id, status);
CREATE INDEX idx_changes_head_sha ON changes (head_sha);

CREATE TABLE site_fix_settings (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  allow_ai_search INTEGER NOT NULL DEFAULT 0,
  fix_budget INTEGER NOT NULL DEFAULT 3,
  autopilot INTEGER NOT NULL DEFAULT 1
);
