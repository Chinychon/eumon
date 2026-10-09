-- Enquiries and how they turned out. A row is written when a WhatsApp link with a reference code is
-- clicked (status 'clicked'), or by hand for an enquiry without one. Staff match a chat by its code and
-- move the row on: 'chat', 'qualified', 'won' (with a value), or 'lost'. Each status keeps the time it
-- was reached, so outcomes are counted on the day they happened. No phone number or message is stored.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ref TEXT,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  status TEXT NOT NULL,
  session_id TEXT,
  page_url TEXT,
  placement TEXT,
  value REAL,
  note TEXT,
  clicked_at TEXT,
  chat_at TEXT,
  qualified_at TEXT,
  won_at TEXT,
  lost_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_ref ON leads (site_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_site_created ON leads (site_id, created_at);

-- The currency lead values are entered in (ISO 4217, e.g. MYR), one per site.
ALTER TABLE page_settings ADD COLUMN currency TEXT;
