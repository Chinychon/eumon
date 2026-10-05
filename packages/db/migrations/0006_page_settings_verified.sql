-- When the live setup check last confirmed that Googlebot receives Eumon's
-- pages on the customer's domain. Until then, published pages are shown as
-- "approved" rather than "live".
ALTER TABLE page_settings ADD COLUMN verified_at TEXT;
