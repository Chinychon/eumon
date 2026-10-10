-- Rank tracking: the searches the user names, and Google's position for each in each target market, per day.
-- `position` is null when the site isn't in the ten results fetched. Rows older than 400 days are pruned by the sync.
CREATE TABLE tracked_keywords (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, keyword)
);

CREATE TABLE rank_checks (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  market TEXT NOT NULL,
  day TEXT NOT NULL,
  position INTEGER,
  url TEXT,
  features_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (site_id, keyword, market, day)
);
CREATE INDEX rank_checks_site_day ON rank_checks (site_id, day);
