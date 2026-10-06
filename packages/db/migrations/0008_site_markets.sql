-- Countries the business sells to (Search Console alpha-3 codes), so search
-- analysis can tell traffic from the target market apart from the rest.
CREATE TABLE IF NOT EXISTS site_markets (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  country TEXT NOT NULL,
  PRIMARY KEY (site_id, country)
);
