-- The site's referring domains (DataForSEO Backlinks, one strongest link per domain, live and lost), refreshed with
-- the link profile every 28 days and replaced whole. `spam` and `spam_reason` are Eumon's verdict (network, link-selling
-- anchor, or DataForSEO's spam score); real links are the rest.
CREATE TABLE referring_domains (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  url_from TEXT NOT NULL DEFAULT '',
  url_to TEXT NOT NULL DEFAULT '',
  anchor TEXT NOT NULL DEFAULT '',
  dofollow INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  lost INTEGER NOT NULL,
  broken INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  spam_score INTEGER,
  spam INTEGER NOT NULL,
  spam_reason TEXT,
  PRIMARY KEY (site_id, domain)
);
CREATE INDEX referring_domains_site_spam_rank ON referring_domains (site_id, spam, rank);
