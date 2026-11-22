# Worker-Spezifikation (Cloudflare Worker `job-agent`)

Der Worker ist der immer wache Teil. Die tägliche Claude-Routine schreibt Bewerbungen und übergibt sie hier. Der Worker verschickt, überwacht den Posteingang und spricht mit Max über Telegram.

**Kostenregel:** Nur Workers Free, D1 Free, KV Free, Workers AI Free-Kontingent. Kein Dienst, der bei Überschreitung verrechnet. Bei Limit-Fehlern: hart scheitern und per Telegram melden.

## Bindings / Secrets
- D1 `DB` (Ledger), KV `FILES` (fertige Mails bis zum Versand oder Verwerfen, höchstens 90 Tage; Inserat-Screenshots 150 Tage), AI `AI` (Workers AI)
- Secrets: `ROUTINE_TOKEN` (Bearer für /api/*), `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`
- Vars: `SENDER_NAME="Max Muster"`, `SENDER_EMAIL="max.muster@example.com"`, `DAILY_BRAKE=20`, `TZ_NAME="Europe/Zurich"`
- Ein einziger Cron `*/5 * * * *`; alle Zeitlogik (Versandfenster, 22:00-Rapport) rechnet in Europe/Zurich.

## Datenmodell (D1)
- `applications`: id (text, von Routine), created_at, company, company_domain, role, kind (`stelle`|`initiativ`), to_email, to_name, subject, body_text, attachment_keys (JSON `{mime_key, mime_size, attachment_names}`), score, reason, sources (JSON), job_url, status (`pending_approval`|`scheduled`|`sending`|`sent`|`rejected_by_user`|`held_brake`|`failed`), sent_at, send_started_at (Sending-Lock), gmail_message_id, gmail_thread_id, last_reply_at, reply_class, error, hslu (JSON `{attach, reason}` oder null)
- `portal_tips`: id, created_at, company, role, url, why, deadline, notes, files, applied_at, status (`new`|`applied_by_user`|`dismissed`), pensum, company_address, result, hslu (JSON `{attach, reason}` oder null). **Zählen nie als Bewerbung des Agenten** (für den RAV-Nachweis aber schon, sobald `applied_by_user`).
- RAV-Felder in `applications`: pensum, company_address, contact_name, contact_phone, result (`offen`|`absage`|`einladung`|`anstellung`, Start `offen`).
- `external_applications`: id (Kennung `e<id>`), created_at, applied_on (YYYY-MM-DD), company, role, art (`schriftlich`|`elektronisch`|`telefonisch`|`persoenlich`|`portal`), pensum, result, notes. Selbst gemachte Bewerbungen, erfasst per Telegram `/extern`.
- Bestehende DBs: `migrations-0003-rav.sql`, `migrations-0004-inserate.sql` und `migrations-0005-hslu.sql` je einmal ausführen.
- `inbox_seen`: gmail_message_id PK, seen_at, application_id, class (`eingangsbestaetigung`|`echte_antwort`|`unklar`|`irrelevant`), notified (0/1)
- `feedback`: id, created_at, application_id (nullable), text  (Max' Rückmeldungen, liest die Routine)
- `settings`: key/value: `mode` (`trial`|`auto`, Start `trial`), `paused` (0/1), `trial_remaining` (Start 7), `last_report_date`, `last_inbox_check`

## HTTP-API (alle mit `Authorization: Bearer ROUTINE_TOKEN`)
- `POST /api/applications` als `multipart/form-data` (sonst 415):
  - Feld `meta` (JSON-String):
    ```json
    {"id":"2026-11-03-acme","company":"Acme AG","company_domain":"acme.ch","role":"IT Supporter 100%",
     "kind":"stelle","to_email":"jobs@acme.ch","to_name":"Frau Muster","subject":"Bewerbung als ...",
     "body_text":"Sehr geehrte Frau Muster\n\n...","score":8.7,"reason":"Warum diese Stelle",
     "sources":["https://..."],"job_url":"https://...",
     "attachment_names":["Anschreiben_Max_Muster_acme.pdf","Lebenslauf_Max_Muster.pdf","Arbeitszeugnisse_Max_Muster.pdf",
       "Microsoft_Zertifikate_Max_Muster.pdf","SPARC_Zertifikate_Max_Muster.pdf"],
     "hslu":{"attach":false,"reason":"Vollzeitstelle, Studium kein Vorteil"}}
    ```
    `attachment_names` (alle tatsächlich gebauten Dateien) dient nur der Anzeige (Vorschau, Rapport). `hslu` optional (nur Max): `attach` boolean, `reason` String (max. 200 Zeichen, keine Gedankenstriche: 422), sonst 400; gespeichert als JSON in `applications.hslu`.
  - Datei `mime`: die komplette, fertige RFC822-Nachricht (von der Routine gebaut: From `"Max Muster" <max.muster@example.com>`, To, Subject RFC2047-kodiert, multipart/mixed mit Text und Anhängen; ohne Date und Message-ID). Der Worker baut kein MIME und rechnet kein Base64, damit das 10-ms-CPU-Limit des Free Plans kein Risiko ist.
  - Datei `preview` (optional, `application/pdf`): das Anschreiben für die Telegram-Vorschau.
  - Datei `preview_cv` (optional, nur bei `cv: tailored`, Person B): der angepasste Lebenslauf, geht als zweites Dokument nach dem Anschreiben in die Vorschau, wird nicht gespeichert.

  Validiert: keine "—"/"–" in meta.subject/meta.body_text (sonst 422), to_email plausibel (422), `mime` vorhanden (400) und < 15 MB (413), im Header-Block der ersten 8 KB von `mime` muss `To:` die meta.to_email enthalten und `Subject:` (RFC2047 B/Q dekodiert) darf keine "—"/"–" enthalten (422), keine aktive Bewerbung (nicht `rejected_by_user`/`failed`) an dieselbe company_domain in den letzten 180 Tagen (409), id noch nicht vorhanden (409). `mime` wird roh als ArrayBuffer in KV gespeichert (`mime/<id>`, TTL 90 Tage; nach `sent` und nach Verwerfen per Telegram wird der Key gelöscht, damit das KV-Kontingent auch bei vielen Bewerbungen reicht). Status: `paused` -> trotzdem speichern als `pending_approval` (mit Vorschau und Buttons); `mode=trial` -> `pending_approval` + Telegram-Vorschau (Mailtext, Begründung, Score, Quellen, "Mitgeschickt werden: Anschreiben, Lebenslauf, Arbeitszeugnisse, ..." aus `attachment_names` ohne Dateipräfix, Zeile "HSLU-Bestätigung: beigelegt/nicht beigelegt (Grund)" falls `hslu`, Hinweis dass unten nur das Anschreiben (ggf. plus angepasster Lebenslauf) zur Ansicht kommt und alles andere automatisch mit der Mail mitgeht; danach `preview` und `preview_cv` als Dokumente) mit Inline-Buttons `📤 Sofort senden` (`approve_now:<id>`) / `🕗 Mo-Fr 08:00` (`approve:<id>`) / `❌ Verwerfen` (`reject:<id>`); `mode=auto` -> `scheduled` + kurze Telegram-Info.
- `POST /api/portal-tips` Body `{company, role, url, why, deadline, notes, pensum?, company_address?, hslu?}` (JSON oder multipart `meta` plus Dateien) -> speichern und Paket sofort per Telegram. Dateien: `file_0` = Anschreiben, bei `cv: tailored` zusätzlich `file_1` = angepasster Lebenslauf (Lebenslauf, Zeugnisse und Zertifikate hat die Person selbst; technisch bis `file_4` möglich). `hslu` wie bei `/api/applications`, gespeichert in `portal_tips.hslu`.
  Telegram-Text: "Lade das Anschreiben herunter und häng es im Portal an. Lebenslauf, Zeugnisse und Zertifikate hast du selbst." (2 Dateien: "Anschreiben und den angepassten Lebenslauf ... Zeugnisse und Zertifikate hast du selbst."; alte Pakete mit mehr Dateien: "Alles Nötige ist unten angehängt.") plus bei `hslu` "📎 HSLU-Bestätigung anhängen: **Ja**/**Nein** (Grund)", danach die Dateien und Knöpfe `✅ Beworben` / `❌ Nicht interessiert`. `/portal` und `POST /api/portal-resend` schicken denselben Text.
- Optionale meta-Felder in `POST /api/applications`: `pensum`, `company_address`, `contact_name`, `contact_phone` (Strings, max. 200 Zeichen, keine Gedankenstriche: 422).
- `GET /api/rav?month=YYYY-MM` -> `{month, entries:[{source, id, date, company, company_address, contact_name, contact_email, contact_phone, role, pensum, art, result}]}` nach Datum sortiert. `agent` = applications `sent` mit sent_at im Zürich-Kalendermonat (art "elektronisch (E-Mail)", contact_email = to_email, contact_name fällt auf to_name zurück); `portal` = portal_tips `applied_by_user` mit applied_at im Monat (art "elektronisch (Portal)"); `extern` = external_applications mit applied_on im Monat (id `e<id>`). Fehlende Werte `null`, ungültiger month 400.
- `POST /api/rav-report` multipart: `meta` `{month, subject, count, force?}`, `mime` (fertige Nachricht der Routine), optional `pdf`. Die Liste geht nur an die Person selbst: Header-Block in den ersten 8 KB, genau ein `To:` und alle Adressen in To/Cc/Bcc == `SENDER_EMAIL`, sonst 422. < 15 MB (413), month YYYY-MM (400). Pro Monat einmal (Setting `rav_sent_<YYYY-MM>`, sonst 409, ausser `force: true`). Versand sofort über Gmail (Date-Header wie beim Bewerbungsversand), dann Telegram "📋 RAV-Liste <Monat Jahr> ist in deinem Postfach (N Einträge) ..." plus PDF. Gmail-Fehler: notifyError, 502, Monat wieder frei; bei Netzwerkabbruch bleibt der Monat belegt (erneut nur mit force).
- `GET /api/state` -> `{settings, applications:[{id, company, company_domain, role, kind, status, created_at, sent_at, reply_class}], portal_tips:[...letzte 60 Tage], feedback:[...ungelesene], stats:{sent_total, sent_today}}`. Markiert gelieferte Feedbacks als gelesen.
- `POST /api/note` Body `{text}` -> Notiz der Routine für den heutigen Rapport (z. B. "heute keine Bewerbung, weil nichts über der Qualitätsschwelle war").
- `POST /api/setup-webhook` -> Telegram-Webhook setzen (siehe Telegram).
- `GET /health` (ohne Auth) -> `ok`.

## Versand
- Cron prüft `scheduled`: nur Mo-Fr 08:00-10:30 Zürich-Zeit; pro Cron-Lauf höchstens 1 Mail (verteilt die Mails natürlich).
- Notbremse: sind heute schon `DAILY_BRAKE` Mails versendet, Status `held_brake` + Telegram-Frage mit Buttons `Trotzdem senden` / `Verwerfen`.
- Die fertige Nachricht aus KV geht unverändert an Gmail; fehlt ein `Date:`-Header, stellt der Worker einen voran (Versandzeitpunkt). Upload über `https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media` (Content-Type `message/rfc822`), damit Anhänge > 5 MB gehen. Speichert message id + threadId.
- Sending-Lock: vor dem Gmail-Call bedingtes `UPDATE ... SET status='sending', send_started_at=now WHERE status='scheduled'` (nur wer den Lock bekommt, sendet), danach `sent`. Antwortet Gmail mit einem Fehler, ging nichts raus: 4xx (ausser 401/429) -> `failed` + Telegram, sonst zurück auf `scheduled`. Bei Netzwerkfehler oder Abbruch bleibt `sending`. Hängt eine Bewerbung > 30 Min in `sending`, wird sie **nie** automatisch erneut gesendet, sondern `failed` + Telegram "bitte in Gmail 'Gesendet' prüfen".
- Access-Token aus Refresh-Token über `https://oauth2.googleapis.com/token`, im Speicher cachen bis Ablauf.

## Posteingang-Überwachung (jeder Cron-Lauf)
- `users/me/messages?q=in:inbox after:<last_inbox_check-600s>&maxResults=100` (Gmail-Suche), per `nextPageToken` höchstens 2 Seiten; jede neue Message-ID einmal verarbeiten (`inbox_seen`), älteste zuerst, höchstens 8 pro Lauf (Subrequest-Limit). Checkpoint `last_inbox_check`: alles verarbeitet -> jetzt; sonst nur bis zur jüngsten verarbeiteten Nachricht, damit Unverarbeitete nie übersprungen werden. Mehr als 2 Seiten -> Fehlermeldung per Telegram.
- Zuordnung: threadId einer Bewerbung, oder Absender-Domain == company_domain / to_email-Domain, oder (für Portal-Bewerbungen von Max selbst) Stichworte im Betreff/Text (Bewerbung, Application, Kandidatur, Stelle, Interview, Vorstellungsgespräch, Absage, Ihre Bewerbung, your application, Workday, SuccessFactors, Personio, rexx, Umantis) plus bekannte Portal-Absender.
- Klassifizierung mit Workers AI (`@cf/meta/llama-3.1-8b-instruct` oder aktuelles kleines Instruct-Modell, JSON-Antwort): `eingangsbestaetigung` | `echte_antwort` | `unklar` | `irrelevant`. Regex-Vorfilter für typische Eingangsbestätigungen ("Eingang Ihrer Bewerbung", "we have received your application", noreply + "Bestätigung"). Bei AI-Fehler/Limit: als `unklar` behandeln.
- Workers AI liefert zusätzlich `ergebnis` (`absage`|`einladung`|`rueckfrage`|`andere`). Bei `echte_antwort` mit zugeordneter Bewerbung setzt `absage`/`einladung` das `result` (ein `anstellung` wird nie überschrieben); die Sofortmeldung nennt das Ergebnis.
- `echte_antwort` und `unklar`: **sofort** Telegram: "🔔 Antwort von <Firma>", Klasse, Absender, Betreff, 2-3 Sätze Zusammenfassung, Gmail-Link `https://mail.google.com/mail/u/0/#inbox/<messageId>`. Nie selbst antworten, nie zusagen/absagen.
- `eingangsbestaetigung`: nur loggen, erscheint im Rapport.

## Telegram
- Webhook `POST /telegram` mit Header `X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET`; nur Updates aus `TELEGRAM_CHAT_ID` verarbeiten, alles andere ignorieren.
- Callback-Buttons: `approve_now:<id>` (Sofort senden: `scheduled` und sofort versenden, auch ausserhalb des Fensters), `approve:<id>` (Mo-Fr 08:00) -> `scheduled` (trial_remaining--, bei 0 Hinweis "Probelauf fertig, /auto on zum Umschalten"), `reject:<id>` -> `rejected_by_user` + Bitte um kurzen Grund (nächste Textnachricht als Feedback speichern), `brake_send:<id>`, `brake_drop:<id>`.
- Befehle: `/status`, `/report` (Rapport sofort), `/pause`, `/resume`, `/auto on|off`, `/applied <portal_tip_id>` (Tipp als selbst beworben markieren), `/dismiss <portal_tip_id>`, `/feedback <text>`, `/help`, RAV: `/extern Firma; Stelle; Datum; Art; Pensum` (Datum TT.MM.JJJJ oder JJJJ-MM-TT, Standard heute Zürich; Art Standard elektronisch; Antwort mit Kennung `e<id>`), `/ergebnis <kennung> <offen|absage|einladung|anstellung>` (Bewerbungs-id, Portal-Tipp-id oder `e<id>`), `/rav` (Einträge des laufenden Monats nach Quelle). Freier Text ohne Befehl -> als Feedback speichern und bestätigen.
- Nachrichten auf Deutsch, Schweizer Schreibweise, HTML-Parse-Mode mit Escaping, max 4096 Zeichen pro Nachricht (splitten).
- Einmal-Setup-Route `POST /api/setup-webhook` (Bearer) ruft `setWebhook` mit `secret_token` und `allowed_updates=["message","callback_query"]`.

## 22:00-Rapport (Zürich-Zeit, einmal pro Tag über `last_report_date`)
Nur Neues und Offenes, Wichtigstes zuerst, eine Zeile pro Thema, nur Firmennamen (max 4, dann "+n"). Vorhersehbares bleibt weg: kein Datum, keine Zähler, keine Eingangsbestätigungen, keine Liste laufender Bewerbungen. Reihenfolge:
1. Echte (oder unklare) Antworten heute, je eine Zeile mit Betreff.
2. Wartet auf dich (pending_approval / held_brake).
3. Versand heute fehlgeschlagen.
4. Heute beworben, eingeplant.
5. Offene Portal-Tipps (status new, nie mitgezählt): nur Firmennamen.
Ist nichts davon da: eine Zeile "😴 Nichts Neues." plus Notiz der Routine, falls vorhanden.

## Robustheit
- Fehler in einem Teil des Crons dürfen die anderen nicht blockieren (try/catch je Teil). Fehler max. 1x pro Stunde pro Art per Telegram melden (KV-Flag), Secrets nie loggen.
- Tests mit vitest + `@cloudflare/vitest-pool-workers` oder reinen Unit-Tests für: MIME-Header-Prüfung (To, Subject RFC2047), unveränderter Versand der gespeicherten Nachricht, Sending-Lock, Inbox-Paginierung/Checkpoint, Dash-Validierung, Dedup, Zürich-Zeitfenster (inkl. Sommer/Winterzeit-Wechsel 25.10.2026), Eingangsbestätigung-Regex, Rapport-Text (Portal-Tipps separat).
