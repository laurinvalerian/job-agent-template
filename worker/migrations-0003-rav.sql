-- Migration für bestehende DBs: RAV-Nachweis (Pensum, Adresse, Kontakt, Ergebnis, externe Bewerbungen).
-- Anwenden: npx wrangler d1 execute job-agent --remote --file=migrations-0003-rav.sql
-- SQLite kennt kein "ADD COLUMN IF NOT EXISTS": die ALTER-Zeilen nur einmal ausführen
-- (ein zweiter Lauf scheitert mit "duplicate column name", ohne etwas zu verändern).
-- Die CHECK-Bedingungen für result stehen nur in schema.sql.

ALTER TABLE applications ADD COLUMN pensum TEXT;
ALTER TABLE applications ADD COLUMN company_address TEXT;
ALTER TABLE applications ADD COLUMN contact_name TEXT;
ALTER TABLE applications ADD COLUMN contact_phone TEXT;
ALTER TABLE applications ADD COLUMN result TEXT NOT NULL DEFAULT 'offen';

ALTER TABLE portal_tips ADD COLUMN pensum TEXT;
ALTER TABLE portal_tips ADD COLUMN company_address TEXT;
ALTER TABLE portal_tips ADD COLUMN result TEXT NOT NULL DEFAULT 'offen';

CREATE TABLE IF NOT EXISTS external_applications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  applied_on TEXT NOT NULL,
  company    TEXT NOT NULL,
  role       TEXT NOT NULL,
  art        TEXT NOT NULL,
  pensum     TEXT,
  result     TEXT NOT NULL DEFAULT 'offen',
  notes      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ext_applied_on ON external_applications(applied_on);
