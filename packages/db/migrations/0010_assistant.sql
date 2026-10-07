-- Ask Eumon conversations, kept per site. A message's content_json holds its
-- text and, for answers, the blocks it drew with a snapshot of their rows (so
-- a reopened thread looks the same) and the tools it called.
CREATE TABLE IF NOT EXISTS assistant_threads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_threads_site ON assistant_threads (site_id, updated_at);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_messages_thread ON assistant_messages (thread_id, created_at);
