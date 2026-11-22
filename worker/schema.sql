-- D1-Schema für job-agent. Anwenden: npx wrangler d1 execute job-agent --remote --file=schema.sql
-- Alle Zeitstempel: ISO-8601 UTC (new Date().toISOString()).

CREATE TABLE IF NOT EXISTS applications (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL,
  company          TEXT NOT NULL,
  company_domain   TEXT NOT NULL,
  role             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('stelle','initiativ')),
  to_email         TEXT NOT NULL,
  to_name          TEXT,
  subject          TEXT NOT NULL,
  body_text        TEXT NOT NULL,
  attachment_keys  TEXT NOT NULL DEFAULT '{}', -- JSON {mime_key, mime_size, attachment_names}
  score            REAL,
  reason           TEXT,
  sources          TEXT NOT NULL DEFAULT '[]',
  job_url          TEXT,
  status           TEXT NOT NULL CHECK (status IN ('pending_approval','scheduled','sending','sent','rejected_by_user','held_brake','failed')),
  sent_at          TEXT,
  send_started_at  TEXT, -- Sending-Lock: Zeitpunkt, an dem status auf 'sending' ging
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  last_reply_at    TEXT,
  reply_class      TEXT,
  error            TEXT,
  pensum           TEXT, -- z. B. "80-100%" (RAV-Nachweis)
  company_address  TEXT, -- Postadresse der Firma (RAV-Nachweis)
  contact_name     TEXT, -- Kontaktperson, falls abweichend von to_name
  contact_phone    TEXT,
  result           TEXT NOT NULL DEFAULT 'offen' CHECK (result IN ('offen','absage','einladung','anstellung')),
  ad_key           TEXT, -- KV-Key des Inserat-Screenshots (PDF) für die RAV-Liste
  hslu             TEXT  -- JSON {attach, reason}: HSLU-Aufnahmebestätigung beigelegt? (nur Max)
);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_app_domain ON applications(company_domain, created_at);
CREATE INDEX IF NOT EXISTS idx_app_thread ON applications(gmail_thread_id);

CREATE TABLE IF NOT EXISTS portal_tips (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  company    TEXT NOT NULL,
  role       TEXT NOT NULL,
  url        TEXT,
  why        TEXT,
  deadline   TEXT,
  notes      TEXT,
  files      TEXT,  -- JSON [{key, name}] der Paket-Dateien in KV (Anschreiben, ggf. angepasster Lebenslauf; alte Tipps auch Beilagen)
  applied_at TEXT,  -- wann Max sich selbst beworben hat (/applied oder Button)
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','applied_by_user','dismissed')),
  pensum          TEXT,
  company_address TEXT,
  result          TEXT NOT NULL DEFAULT 'offen' CHECK (result IN ('offen','absage','einladung','anstellung')),
  ad_key     TEXT,
  hslu       TEXT   -- JSON {attach, reason}: HSLU-Aufnahmebestätigung im Portal anhängen?
);

-- Bewerbungen, die die Person selbst ausserhalb des Agenten gemacht hat (Telegram /extern), für den RAV-Nachweis
CREATE TABLE IF NOT EXISTS external_applications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  applied_on TEXT NOT NULL, -- YYYY-MM-DD (Zürich)
  company    TEXT NOT NULL,
  role       TEXT NOT NULL,
  art        TEXT NOT NULL CHECK (art IN ('schriftlich','elektronisch','telefonisch','persoenlich','portal')),
  pensum     TEXT,
  result     TEXT NOT NULL DEFAULT 'offen' CHECK (result IN ('offen','absage','einladung','anstellung')),
  notes      TEXT,
  url        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ext_applied_on ON external_applications(applied_on);

CREATE TABLE IF NOT EXISTS inbox_seen (
  gmail_message_id TEXT PRIMARY KEY,
  seen_at          TEXT NOT NULL,
  application_id   TEXT,
  class            TEXT NOT NULL CHECK (class IN ('eingangsbestaetigung','echte_antwort','unklar','irrelevant')),
  notified         INTEGER NOT NULL DEFAULT 0,
  from_addr        TEXT,
  subject          TEXT,
  company          TEXT
);
CREATE INDEX IF NOT EXISTS idx_seen_at ON inbox_seen(seen_at);

CREATE TABLE IF NOT EXISTS feedback (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL,
  application_id TEXT,
  text           TEXT NOT NULL,
  read_at        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('mode', 'trial'),
  ('paused', '0'),
  ('trial_remaining', '7'),
  ('last_report_date', ''),
  ('last_inbox_check', '');
