-- HSLU-Hinweis ({attach, reason} als JSON) für Bewerbungen und Portal-Pakete. Nur einmal ausführen.
ALTER TABLE applications ADD COLUMN hslu TEXT;
ALTER TABLE portal_tips ADD COLUMN hslu TEXT;
