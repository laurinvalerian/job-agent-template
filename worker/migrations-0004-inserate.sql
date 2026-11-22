-- Inserat-Screenshots und Links für die RAV-Liste. Nur einmal ausführen.
ALTER TABLE applications ADD COLUMN ad_key TEXT;
ALTER TABLE portal_tips ADD COLUMN ad_key TEXT;
ALTER TABLE external_applications ADD COLUMN url TEXT;
