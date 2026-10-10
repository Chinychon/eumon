-- AI answer tracking: the questions users ask AI assistants about their market, the names the brand goes by, and
-- one row per question, market, engine and day: whether the answer mentioned the brand and cited the site, the
-- sources it cited (up to 20), the competitors it named, and an excerpt. An attempt that got no answer (refused, or
-- empty) is a row with answered = 0, so the queue knows it was tried. Rows older than 400 days are pruned.
CREATE TABLE ai_prompts (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, prompt)
);

CREATE TABLE ai_brand_names (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (site_id, name)
);

CREATE TABLE ai_answer_checks (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  market TEXT NOT NULL,
  engine TEXT NOT NULL,
  day TEXT NOT NULL,
  answered INTEGER NOT NULL DEFAULT 1,
  mentioned INTEGER NOT NULL,
  cited INTEGER NOT NULL,
  cited_rank INTEGER,
  sources_json TEXT NOT NULL DEFAULT '[]',
  rivals_json TEXT NOT NULL DEFAULT '[]',
  excerpt TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (site_id, prompt, market, engine, day)
);
CREATE INDEX ai_answer_checks_site_day ON ai_answer_checks (site_id, day);
