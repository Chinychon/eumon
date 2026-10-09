-- Each Results sync (Sync now, or the daily run) and what every source said: what ran, what was skipped, what failed.
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  notes_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_site ON sync_runs (site_id, started_at);
