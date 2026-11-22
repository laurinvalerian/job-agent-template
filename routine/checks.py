"""Harte Qualitäts-Gates für eine Bewerbung. Jeder Fehler blockiert den Versand."""

import re
from collections.abc import Callable
from datetime import date

FORBIDDEN_DASHES = ("—", "–", "‒", "―", "⸺", "⸻")  # — – ‒ ― ⸺ ⸻

# Floskeln und KI-Muster aus profile/style.md. Treffer sind Fehler, nicht nur Warnungen.
FORBIDDEN_PHRASES = (
    "hiermit bewerbe ich mich",
    "mit grossem interesse habe ich",
    "ideale besetzung",
    "ideale kandidat",
    "teamplayer",
    "spannende reise",
    "massgeschneidert",
    "synergien",
    "nahtlos",
    "in der heutigen",
    "nicht nur",
)

MIN_WORDS, MAX_WORDS = 200, 380
MAX_MAIL_SENTENCES = 12

# Höflichkeit in der Begleitmail: mindestens ein Dank und ein Satz zur Vorfreude/Rückmeldung.
MAIL_THANKS = ("danke", "vielen dank", "herzlichen dank", "thank")
MAIL_OUTLOOK = ("freue mich", "freuen", "rückmeldung", "look forward", "hearing from you")

REQUIRED = ("id", "kind", "role", "company_domain", "recipient", "subject", "salutation",
            "paragraphs", "attachments", "email", "reason", "sources", "score")


def _texts(app: dict) -> list[tuple[str, str]]:
    """Alle Freitexte, die Empfänger zu sehen bekommen, mit Feldname."""
    out = [("subject", app.get("subject", "")), ("salutation", app.get("salutation", "")),
           ("closing", app.get("closing", ""))]
    out += [(f"paragraphs[{i}]", p) for i, p in enumerate(app.get("paragraphs", []))]
    r = app.get("recipient", {}) or {}
    out += [(f"recipient.{k}", v) for k, v in r.items() if isinstance(v, str)]
    pt = app.get("portal", {}) or {}
    out += [(f"portal.{k}", v) for k, v in pt.items() if isinstance(v, str) and k != "url"]
    m = app.get("email", {}) or {}
    out += [("email.subject", m.get("subject", "")), ("email.body", m.get("body", ""))]
    h = app.get("hslu")
    if isinstance(h, dict) and isinstance(h.get("reason"), str):
        out.append(("hslu.reason", h["reason"]))
    cv = app.get("cv")
    if isinstance(cv, dict) and isinstance(cv.get("profile"), str):
        out.append(("cv.profile", cv["profile"]))
    return out


HSLU_REASON_MAX = 200  # wie RAV_FIELD_MAX im Worker
# Erwähnung der Bestätigung selbst (das Studium darf immer erwähnt werden)
HSLU_MENTION = re.compile(r"aufnahmebest|admission (confirmation|letter)", re.I)


def _check_hslu(app: dict) -> list[str]:
    """hslu: {attach, reason} ist Pflicht, sobald die Person eine HSLU-Aufnahmebestätigung im Register hat.
    attach muss zu den Beilagen passen (auch beim Portal, sonst widerspricht die Beilagen-Zeile im Brief
    dem Hinweis an die Person). Liegt sie nicht bei, dürfen Brief und Mail sie nicht ankündigen."""
    h = app.get("hslu")
    if not isinstance(h, dict) or not isinstance(h.get("attach"), bool) or not str(h.get("reason") or "").strip():
        return ["hslu fehlt oder unvollständig: {\"attach\": true|false, \"reason\": \"Grund\"}"]
    errors = []
    if len(h["reason"].strip()) > HSLU_REASON_MAX:
        errors.append(f"hslu.reason hat {len(h['reason'].strip())} Zeichen (höchstens {HSLU_REASON_MAX})")
    if h["attach"] != ("hslu-aufnahme" in app["attachments"]):
        errors.append("hslu.attach passt nicht zu den Beilagen (attach true genau dann, wenn 'hslu-aufnahme' beiliegt)")
    elif not h["attach"]:
        texts = [(f"paragraphs[{i}]", p) for i, p in enumerate(app.get("paragraphs", []))]
        texts.append(("email.body", (app.get("email") or {}).get("body", "")))
        errors += [f"HSLU-Bestätigung in {f} erwähnt, liegt aber nicht bei" for f, t in texts if HSLU_MENTION.search(t)]
    return errors


def check_application(app: dict, known_attachments: set[str], today: date | None = None,
                      always_groups: dict[str, list[str]] | None = None,
                      check_cv: Callable[[dict], list[str]] | None = None) -> list[str]:
    """always_groups: Gruppe -> alle Beilagen-IDs, die bei Mail-Bewerbungen immer mitgehen.
    check_cv: nur bei Personen mit angepasstem Lebenslauf (cv: tailored), prüft das Feld cv."""
    errors: list[str] = []
    portal = app.get("kind") == "portal"
    required = [k for k in REQUIRED if not (portal and k == "email")] + (["portal"] if portal else [])
    for k in required:
        if k not in app or app[k] in (None, "", [], {}):
            errors.append(f"Pflichtfeld fehlt: {k}")
    if errors:
        return errors

    if app["kind"] not in ("stelle", "initiativ", "portal"):
        errors.append("kind muss 'stelle', 'initiativ' oder 'portal' sein")
    if portal:
        pt = app["portal"]
        if not str(pt.get("url", "")).startswith("http"):
            errors.append("portal.url muss der Link zur Stelle sein")
        if not pt.get("notes"):
            errors.append("portal.notes fehlt (was im Portal betonen)")

    for field, text in _texts(app):
        for ch in FORBIDDEN_DASHES:
            if ch in text:
                errors.append(f"Gedankenstrich {ch!r} in {field}")
        if "ß" in text:
            errors.append(f"'ß' in {field} (Schweizer Schreibweise: ss)")
        # Ein Bindestrich mit Leerzeichen rundherum ist ein verkappter Gedankenstrich.
        if re.search(r"\s-\s", text):
            errors.append(f"' - ' als Gedankenstrich in {field}")
        low = text.lower()
        for phrase in FORBIDDEN_PHRASES:
            if phrase in low:
                errors.append(f"Floskel {phrase!r} in {field}")

    words = sum(len(p.split()) for p in app["paragraphs"])
    if not MIN_WORDS <= words <= MAX_WORDS:
        errors.append(f"Fliesstext hat {words} Wörter (erlaubt {MIN_WORDS} bis {MAX_WORDS})")

    atts = app["attachments"]
    if not atts or atts[0] != "lebenslauf":
        errors.append("erste Beilage muss 'lebenslauf' sein")
    unknown = [a for a in atts if a not in known_attachments]
    if unknown:
        errors.append(f"unbekannte Beilagen: {unknown}")
    if len(set(atts)) != len(atts):
        errors.append("doppelte Beilagen")
    if "hslu-aufnahme" in known_attachments:
        errors += _check_hslu(app)
    if check_cv is not None:
        if not app.get("cv"):
            errors.append("Pflichtfeld fehlt: cv (angepasster Lebenslauf)")
        else:
            errors += check_cv(app["cv"])

    if portal:
        return errors + _common_tail(app)
    for g, ids in (always_groups or {}).items():
        missing = [i for i in ids if i not in atts]
        if missing:
            errors.append(f"Gruppe {g!r} geht bei Mail immer vollständig mit, es fehlen: {missing}")
    mail = app["email"]
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", mail.get("to", ""), re.I):
        errors.append(f"ungültige Empfängeradresse: {mail.get('to')!r}")
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", mail.get("body", "").strip()) if s]
    if len(sentences) > MAX_MAIL_SENTENCES + 4:  # Signaturzeilen enden ohne Punkt, grosszügig zählen
        errors.append(f"Begleitmail zu lang ({len(sentences)} Sätze)")
    body_low = mail.get("body", "").lower()
    if not any(w in body_low for w in MAIL_THANKS):
        errors.append("Begleitmail ohne Dank (z.B. 'Vielen Dank, dass Sie sich Zeit für meine Unterlagen nehmen.')")
    if not any(w in body_low for w in MAIL_OUTLOOK):
        errors.append("Begleitmail ohne Vorfreude auf Rückmeldung (z.B. 'Ich freue mich sehr auf Ihre Rückmeldung.')")
    domain = app["company_domain"].lower()
    if "@" in mail.get("to", "") and not mail["to"].lower().split("@")[1].endswith(domain.split(".", 1)[-1] if domain.count(".") > 1 else domain):
        errors.append(f"Empfänger-Domain passt nicht zu company_domain {domain}")

    return errors + _common_tail(app)


def _common_tail(app: dict) -> list[str]:
    errors = []
    if not all(str(s).startswith("http") for s in app["sources"]):
        errors.append("sources müssen URLs sein")
    if not isinstance(app["score"], (int, float)) or not 0 <= app["score"] <= 10:
        errors.append("score muss 0 bis 10 sein")
    return errors


def check_pdf_pages(pages: int) -> list[str]:
    return [] if pages == 1 else [f"Anschreiben hat {pages} Seiten (muss genau 1 sein)"]
