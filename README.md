# Job-Agent

Automatische Jobsuche und Bewerbung. Eine tägliche Claude-Routine sucht passende Stellen (Jobportale, RSS, Initiativbewerbungen), recherchiert die Firma, schreibt Anschreiben und Lebenslauf als PDF und übergibt alles an einen Cloudflare Worker. Der Worker verschickt per Gmail, überwacht den Posteingang und meldet per Telegram. Du bestätigst per Knopfdruck oder lässt es automatisch laufen.

**Kosten:** 0 CHF ausser dem Claude-Abo. Nur Free Tiers (Cloudflare Workers, D1, KV, Telegram, Gmail API).

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `routine/` | Python-CLI und `PROMPT.md` (die Anweisung für die tägliche Claude-Routine) |
| `templates/` | Typst-Vorlagen für Lebenslauf, Anschreiben, RAV-Nachweis |
| `worker/` | Cloudflare Worker (Versand, Posteingang, Telegram-Bot), Details in `worker/README.md` |
| `job-data-example/` | Beispiel für deine persönlichen Daten (Profil, Lebenslauf, Zeugnisse) |
| `docs/worker-spec.md` | Spezifikation des Workers |

## Setup

Am schnellsten: Repo in Claude Code öffnen und sagen **"Richte das Projekt für mich ein"**. Manuell:

1. **Voraussetzungen:** Python 3.11+, Node 20+, [Typst](https://typst.app), Cloudflare-Account (gratis), Claude-Abo mit Claude Code.
2. **Eigene Daten anlegen:** `job-data-example` nach `../job-data-<deinname>` kopieren (neben dieses Repo, am besten als privates Git-Repo). Darin `profile/person.yaml`, `profile/cv.yaml`, `profile/docs/attachments.yaml` und deine echten PDFs eintragen. Diese Daten gehören nie in dieses Repo.
3. **Python:** `python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && pytest`
4. **Worker:** Schritte in `worker/README.md` (D1 und KV anlegen, IDs in `worker/wrangler.jsonc`, Telegram-Bot über @BotFather, Gmail-OAuth mit `scripts/gmail-auth.mjs`, Secrets setzen, `npx wrangler deploy`).
5. **Worker-URL** in `profile/person.yaml` bei `worker_url` eintragen.
6. **Routine anlegen:** In Claude Code `/schedule` einrichten, Inhalt von `routine/PROMPT.md` als Anweisung, beide Repos (Code und Daten) als Quellen. Täglich laufen lassen.

## Wichtig

- Die Routine versendet echte Mails in deinem Namen. Zuerst mit einer Testadresse ausprobieren.
- Die Texte, Quellen und Regeln in `routine/PROMPT.md` sind auf die Schweiz und deutschsprachige Bewerbungen zugeschnitten. Passe sie an deine Zielstellen an.
- Es gibt kein Tageslimit nach Menge, sondern eine Qualitätsschwelle (Score) pro Stelle.
