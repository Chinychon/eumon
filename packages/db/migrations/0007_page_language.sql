-- Language the landing pages are written in (BCP 47, e.g. "en", "id", "ms").
ALTER TABLE page_settings ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
