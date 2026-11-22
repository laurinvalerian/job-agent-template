# job-agent (Cloudflare Worker)

Versendet die Bewerbungen der täglichen Routine über Gmail, überwacht den Posteingang und spricht mit Max per Telegram. Spezifikation: `../docs/worker-spec.md`.

**Kostenregel:** nur Workers Free, D1, KV und das Workers-AI-Free-Kontingent (10'000 Neurons/Tag). Bei Limits scheitert der Worker und meldet das per Telegram, es entstehen keine Kosten. Ein einziger Cron `*/5 * * * *`.

## Lokal

```sh
npm install
npx tsc --noEmit
npx vitest run
```

## Setup (einmalig)

1. **D1 anlegen** und die ausgegebene `database_id` in `wrangler.jsonc` statt `TODO` eintragen:
   ```sh
   npx wrangler d1 create job-agent
   ```
2. **KV anlegen** und die `id` in `wrangler.jsonc` (`FILES`) eintragen:
   ```sh
   npx wrangler kv namespace create FILES
   ```
3. **Schema anwenden:**
   ```sh
   npx wrangler d1 execute job-agent --remote --file=schema.sql
   ```
   Bestehende DB: die fehlenden Migrationen der Reihe nach je einmal ausführen, vor `wrangler deploy`. Ein zweiter Lauf scheitert harmlos mit "duplicate column name".
   ```sh
   for m in 0002-portal-files 0003-rav 0004-inserate 0005-hslu; do
     npx wrangler d1 execute job-agent --remote --file=migrations-$m.sql
   done
   ```
   Ohne 0005 scheitert jede Bewerbung und jedes Portal-Paket mit "no column named hslu".
4. **Gmail-Refresh-Token holen** (OAuth-Client vom Typ "Desktop-App", Gmail API aktiviert):
   ```sh
   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-auth.mjs
   ```
   Das Token landet nur in `~/job-agent-gmail-token.txt` (chmod 600).
   Hinweis: Solange der OAuth-Consent-Screen im Status "Testing" ist, laufen Refresh-Tokens nach 7 Tagen ab. Für Dauerbetrieb auf "In production" stellen (für den Eigengebrauch ohne Verifizierung möglich, Google zeigt dann eine Warnung beim Login).
5. **Secrets setzen** (jeweils interaktiv):
   ```sh
   npx wrangler secret put ROUTINE_TOKEN          # z. B. openssl rand -hex 32
   npx wrangler secret put TELEGRAM_TOKEN         # von @BotFather
   npx wrangler secret put TELEGRAM_CHAT_ID       # Max' Chat-ID
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET # openssl rand -hex 32
   npx wrangler secret put GMAIL_CLIENT_ID
   npx wrangler secret put GMAIL_CLIENT_SECRET
   npx wrangler secret put GMAIL_REFRESH_TOKEN < ~/job-agent-gmail-token.txt
   ```
   Danach `~/job-agent-gmail-token.txt` löschen.
6. **Deploy:**
   ```sh
   npx wrangler deploy
   ```
7. **Telegram-Webhook setzen:**
   ```sh
   curl -X POST -H "Authorization: Bearer $ROUTINE_TOKEN" https://job-agent.<subdomain>.workers.dev/api/setup-webhook
   ```
   Test: `/help` an den Bot schicken, `curl https://job-agent.<subdomain>.workers.dev/health` liefert `ok`.

## API (Bearer `ROUTINE_TOKEN`, oder optional `ADMIN_TOKEN` für lokale Sitzungen)

Lokal liegt der Token in `~/.config/job-agent/<person>.token` (setzen: `npx wrangler secret put ADMIN_TOKEN`); `routine/jobagent.py` liest ihn automatisch, z.B. `python3 routine/jobagent.py portal-resend [id]` schickt offene Portal-Pakete erneut per Telegram.


| Route | Zweck |
| --- | --- |
| `POST /api/applications` | Bewerbung übergeben als `multipart/form-data`: `meta` (JSON), `mime` (fertige RFC822-Nachricht), optional `preview` (PDF). 422 bei Gedankenstrichen, ungültiger Adresse oder falschem `To:`, 409 bei Dublette, 413 ab 15 MB |
| `POST /api/portal-tips` | Portal-Tipp speichern (erscheint im Rapport, zählt nie als Bewerbung) |
| `POST /api/note` | `{"text": "..."}`: Notiz für den heutigen Rapport, z. B. warum keine Bewerbung kam |
| `GET /api/rav?month=YYYY-MM` | RAV-Nachweis: alle Arbeitsbemühungen des Zürich-Kalendermonats (Agent, Portal, extern), nach Datum sortiert |
| `POST /api/rav-report` | Fertige RAV-Mail (`meta`, `mime`, optional `pdf`) sofort an die eigene Adresse senden. 422 wenn `To:` nicht nur `SENDER_EMAIL` ist, 409 bei Doppelversand im Monat (ausser `force: true`), 502 bei Gmail-Fehler |
| `GET /api/state` | Stand, Statistik und ungelesenes Feedback (wird dabei als gelesen markiert) |
| `POST /api/setup-webhook` | Telegram-Webhook einrichten |
| `GET /health` | ohne Auth, liefert `ok` |

### Beispiel: Bewerbung übergeben

```sh
curl -X POST https://job-agent.<subdomain>.workers.dev/api/applications \
  -H "Authorization: Bearer $ROUTINE_TOKEN" \
  -F 'meta={"id":"2026-11-03-acme","company":"Acme AG","company_domain":"acme.ch","role":"IT Supporter","kind":"stelle","to_email":"jobs@acme.ch","subject":"Bewerbung als IT Supporter","body_text":"...","attachment_names":["Anschreiben.pdf"]}' \
  -F 'mime=@bewerbung.eml;type=message/rfc822' \
  -F 'preview=@Anschreiben.pdf;type=application/pdf'
```

Die `.eml` baut die Routine (z. B. Python `email.message.EmailMessage`, Policy `SMTP`), ohne `Date` und `Message-ID`.

## Ablauf pro Cron-Lauf (alle 5 Minuten)

1. Versand: Mo-Fr 08:00 bis 10:30 Zürich, höchstens eine Mail pro Lauf, Notbremse ab `DAILY_BRAKE` Mails pro Tag. Die Nachricht aus KV geht unverändert an Gmail und wird danach aus KV gelöscht (ebenso beim Verwerfen), Inserat-Screenshots laufen nach 150 Tagen ab. Sending-Lock: `scheduled` -> `sending` -> `sent`; hängt eine Bewerbung über 30 Min in `sending`, wird sie `failed` und Max soll in Gmail unter "Gesendet" nachsehen (nie automatisch neu senden).
2. Posteingang: bis 2 Seiten à 100 Mails listen, höchstens 8 neue pro Lauf (älteste zuerst, Checkpoint überspringt nichts), zuordnen, Eingangsbestätigungen per Regex, sonst Workers AI (`@cf/meta/llama-3.1-8b-instruct`, JSON-Modus). Echte oder unklare Antworten sofort per Telegram.
3. Rapport: ab 22:00 Zürich einmal pro Tag.

## RAV-Nachweis

Die Routine holt am 1. des Monats `GET /api/rav?month=YYYY-MM`, baut PDF/CSV/Mail und schickt sie über `POST /api/rav-report` an die eigene Adresse; Telegram meldet das mit PDF. Per Telegram: `/extern` erfasst selbst gemachte Bewerbungen, `/ergebnis` setzt Absage/Einladung/Anstellung, `/rav` zeigt den Monatsstand. Antworten im Posteingang setzen Absage oder Einladung automatisch.

Jeder Teil läuft isoliert; Fehler werden höchstens einmal pro Stunde und Art gemeldet.
