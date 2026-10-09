-- AI visibility on Eumon's landing pages, per page and day:
--   signal 'fetch'    : an AI agent requested the page (name = its product token, e.g. GPTBot, ChatGPT-User)
--   signal 'referral' : a person arrived from an AI assistant (name = the assistant, e.g. chatgpt)
-- The engine and fetch kind come from the agent table in code, so they are not stored.
CREATE TABLE IF NOT EXISTS ai_page_daily (
  site_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  day TEXT NOT NULL,
  signal TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, day, signal, name)
);
CREATE INDEX IF NOT EXISTS idx_ai_page_daily_site_day ON ai_page_daily (site_id, day);

-- Where a session first landed from: 'search', 'ai:<assistant>' or 'other'. Null for sessions recorded before this column.
ALTER TABLE page_sessions ADD COLUMN source TEXT;
