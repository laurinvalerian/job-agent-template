"""Werkzeug der täglichen Routine: Bewerbung prüfen, rendern, als Mail bauen und an den Worker übergeben.

    python routine/jobagent.py check    out/<id>/application.json
    python routine/jobagent.py build    out/<id>/application.json   # check + PDFs + MIME
    python routine/jobagent.py submit   out/<id>/application.json   # build + an Worker schicken
    python routine/jobagent.py state                                 # Ledger, Modus, Feedback vom Worker
    python routine/jobagent.py portal   out/<id>/application.json   # Portal-Paket (kind "portal", zählt nicht als Bewerbung)
    python routine/jobagent.py snapshot <url> <id> [--force]         # Inserat sofort sichern (RAV-Beweis), bevor die Stelle verschwindet
    python routine/jobagent.py note     "Heute keine Bewerbung, weil ..."
    python routine/jobagent.py attachments                           # verfügbare Beilagen-IDs
    python routine/jobagent.py whoami                                # Person, Daten-Repo, Worker
    python routine/jobagent.py rav [YYYY-MM] [--dry] [--force]       # RAV-Liste (Standard: Vormonat)
    python routine/jobagent.py rav-draft [YYYY-MM] [--dry] [--force] [--draft-only]  # Monatsentwurf in Gmail (Standard: laufender Monat)
    python routine/jobagent.py harvest [--mark-seen]                 # neue Stellen aus allen Quellen (siehe sources.py)
    python routine/jobagent.py checkpoint                            # Zwischenstand (out/, geänderte Daten-Repo-Dateien) an den Worker
    python routine/jobagent.py resume                                # Zwischenstand eines abgebrochenen Laufs zurückholen

Worker-URL fest eingebaut (JOB_WORKER_URL überschreibt). Token: in der Cloud setzt es der Agent-Proxy
(API-Credential des Environments), lokal über JOB_ROUTINE_TOKEN.
"""

import json
import os
import ssl
import subprocess
import sys
import tarfile
import urllib.request
import uuid
from datetime import date
from email.message import EmailMessage
from email.policy import SMTP
from io import BytesIO
from pathlib import Path

import typst
import yaml
from pypdf import PdfReader, PdfWriter

sys.path.insert(0, str(Path(__file__).parent))
from checks import check_application, check_pdf_pages  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

MONTHS = {"de": ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September",
                 "Oktober", "November", "Dezember"],
          "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September",
                 "October", "November", "December"]}


def find_data_dir() -> Path:
    """Das Daten-Repo der Person: JOB_DATA_DIR, sonst genau ein job-data-* neben dem Code.
    Mehrere oder keines: Abbruch, damit nie Unterlagen verschiedener Personen vermischt werden."""
    if os.environ.get("JOB_DATA_DIR"):
        d = Path(os.environ["JOB_DATA_DIR"]).expanduser().resolve()
        if not (d / "profile" / "person.yaml").exists():
            raise SystemExit(f"JOB_DATA_DIR {d} enthält kein profile/person.yaml")
        return d
    found = sorted(p for p in ROOT.parent.glob("job-data-*") if (p / "profile" / "person.yaml").exists())
    if len(found) != 1:
        raise SystemExit(f"Genau ein Daten-Repo (job-data-*) neben {ROOT} erwartet, gefunden: {[p.name for p in found]}. "
                         "Lokal JOB_DATA_DIR setzen.")
    return found[0]


DATA = find_data_dir()
DOCS = DATA / "profile" / "docs"
PERSON: dict = yaml.safe_load((DATA / "profile" / "person.yaml").read_text(encoding="utf-8"))
_REG = yaml.safe_load((DOCS / "attachments.yaml").read_text(encoding="utf-8"))
GROUP_TITLES: dict[str, dict[str, str]] = _REG.get("groups") or {}
DEFAULT_WORKER_URL = PERSON["worker_url"]
SENDER = (PERSON["name"], PERSON["email"])

# Beilagen-ID -> (Datei, Gruppe, Bezeichnung de, Bezeichnung en). Gruppe fasst die Beilagen-Zeile zusammen.
ATTACHMENTS: dict[str, tuple[Path, str, str, str]] = {
    a["id"]: (DOCS / a["file"], a.get("group") or a["id"], a["de"], a.get("en") or a["de"]) for a in _REG["attachments"]
}
if "lebenslauf" not in ATTACHMENTS:
    raise SystemExit("attachments.yaml braucht einen Eintrag 'lebenslauf'")
# Gruppen mit always: true gehen bei Mail-Bewerbungen immer vollständig mit.
ALWAYS: dict[str, list[str]] = {g: [i for i, a in ATTACHMENTS.items() if a[1] == g]
                                for g, t in GROUP_TITLES.items() if t.get("always")}
TAILORED_CV = PERSON.get("cv") == "tailored"  # Lebenslauf pro Stelle aus profile/cv.yaml rendern


def letter_settings() -> dict:
    """Layout aus person.yaml (letter: style, font, signature). Unterschrift als absoluter Pfad (Typst-root ist /)."""
    lt = dict(PERSON.get("letter") or {})
    if lt.get("signature"):
        sig = (DOCS / lt["signature"]).resolve()
        if not sig.exists():
            raise SystemExit(f"Unterschrift fehlt: {sig}")
        lt["signature"] = str(sig)
    return lt


def place_date(d: date, lang: str) -> str:
    if lang == "en":
        return f"{PERSON['place']}, {d.day} {MONTHS['en'][d.month - 1]} {d.year}"
    return f"{PERSON['place']}, {d.day}. {MONTHS['de'][d.month - 1]} {d.year}"


def enclosures_text(ids: list[str], lang: str) -> str:
    """Beilagen-Zeile aus den tatsächlich angehängten Dateien, damit Brief und Anhang immer übereinstimmen."""
    en = lang == "en"
    groups: dict[str, list[str]] = {}
    for i in ids:
        _, g, de_label, en_label = ATTACHMENTS[i]
        groups.setdefault(g, []).append(en_label if en else de_label)
    parts = []
    for g, labels in groups.items():
        if g in GROUP_TITLES:
            title = GROUP_TITLES[g]["en" if en else "de"]
            # compact: nur der Gruppentitel, ohne Firmennamen (z.B. "Arbeitszeugnisse")
            parts.append(title if GROUP_TITLES[g].get("compact") else f"{title} ({', '.join(labels)})")
        else:
            parts.extend(labels)
    return ", ".join(parts)


def app_dir(app_path: Path) -> Path:
    return app_path.resolve().parent


def render_letter(app: dict, spacing_scale: float = 1.0) -> bytes:
    lang = app.get("lang", "de")
    data = {
        "lang": lang,
        "sender": {k: PERSON[k] for k in ("name", "street", "zip_city", "phone", "email")},
        "letter": letter_settings(),
        "recipient": app["recipient"],
        "place_date": place_date(date.fromisoformat(app.get("date", date.today().isoformat())), lang),
        "subject": app["subject"],
        "salutation": app["salutation"],
        "paragraphs": app["paragraphs"],
        "closing": app.get("closing") or ("Kind regards" if lang == "en" else "Freundliche Grüsse"),
        "enclosures_label": "Enclosures" if lang == "en" else "Beilagen",
        # enclosures_text nur für nachträgliches Neu-Rendern bereits versendeter Briefe (Beilagen-Zeile wörtlich übernehmen)
        "enclosures": app.get("enclosures_text") or enclosures_text(app["attachments"], lang),
    }
    data["spacing_scale"] = spacing_scale
    if "font_size" in app.get("layout", {}):
        data["font_size"] = app["layout"]["font_size"]
    return typst.compile(str(ROOT / "templates" / "letter.typ"), font_paths=[str(ROOT / "fonts")], root="/",
                         sys_inputs={"data": json.dumps(data, ensure_ascii=False)})


SPACING_STEPS = (1.0, 0.95, 0.9)  # höchstens 10% enger als im Musterbrief, sonst Text kürzen
MIN_FILL = 0.8   # Anteil der nutzbaren Seitenhöhe, den der Brief mindestens füllen soll
PAGE_H, MARGIN_V = 842.0, 55.0  # A4 in pt, Rand oben/unten 1.94 cm


def page_fill(pdf: bytes) -> float:
    """Wie weit reicht der Text auf Seite 1 nach unten (0 = oben, 1 = unterer Rand)?"""
    lowest = []
    def visit(text, cm, tm, font, size):  # noqa: ARG001
        if text.strip():
            lowest.append(tm[5] * cm[3] + cm[5] if cm else tm[5])
    PdfReader(BytesIO(pdf)).pages[0].extract_text(visitor_text=visit)
    if not lowest:
        return 0.0
    y_top = PAGE_H - min(lowest)  # PDF-y zählt von unten
    return max(0.0, min(1.0, (y_top - MARGIN_V) / (PAGE_H - 2 * MARGIN_V)))


def render_fitting(app: dict) -> bytes:
    """Mit den Abständen des Musterbriefs rendern; nur wenn es nicht auf eine Seite passt, stufenweise enger.
    Danach prüfen, dass die Seite gut gefüllt ist."""
    for scale in SPACING_STEPS:
        pdf = render_letter(app, scale)
        if len(PdfReader(BytesIO(pdf)).pages) == 1:
            break
    else:
        raise SystemExit("PRÜFUNG FEHLGESCHLAGEN:\n- Anschreiben passt auch mit engeren Abständen nicht auf 1 Seite. Text kürzen.")
    fill = page_fill(pdf)
    if fill < MIN_FILL:
        raise SystemExit(f"PRÜFUNG FEHLGESCHLAGEN:\n- Anschreiben füllt nur {fill:.0%} der Seite (mindestens {MIN_FILL:.0%}). "
                         "Inhaltlich ergänzen (konkreter zur Firma oder zu passenden Erfahrungen), nichts aufblähen.")
    return pdf


def merge_pdfs(paths: list[Path]) -> bytes:
    w = PdfWriter()
    for p in paths:
        w.append(str(p))
    w.compress_identical_objects()
    buf = BytesIO()
    w.write(buf)
    return buf.getvalue()


_TRANSLIT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", " ": "_"})


def group_file_stem(g: str, lang: str) -> str:
    """Dateiname-Stamm einer Beilagen-Gruppe: file_de/file_en, sonst Gruppentitel (bzw. Bezeichnung) ohne Leerzeichen."""
    en = lang == "en"
    t = GROUP_TITLES.get(g) or {}
    stem = t.get("file_en" if en else "file_de") or t.get("en" if en else "de") or t.get("de")
    if not stem:
        first = next(a for a in ATTACHMENTS.values() if a[1] == g)
        stem = first[3] if en else first[2]
    stem = stem.translate(_TRANSLIT)
    return "".join(c for c in stem if c.isascii() and (c.isalnum() or c in "-_"))


def file_names(app: dict) -> tuple[str, str, list[tuple[str, list[str]]]]:
    """Anschreiben, Lebenslauf und pro Beilagen-Gruppe (Reihenfolge des ersten Auftretens) Dateiname + IDs."""
    lang = app.get("lang", "de")
    en = lang == "en"
    slug = "".join(c if c.isalnum() else "_" for c in app["recipient"]["company"]).strip("_")[:40]
    fp = PERSON["file_prefix"]
    groups: dict[str, list[str]] = {}
    for i in app["attachments"]:
        if i != "lebenslauf":
            groups.setdefault(ATTACHMENTS[i][1], []).append(i)
    return ((f"Cover_Letter_{fp}_{slug}.pdf" if en else f"Anschreiben_{fp}_{slug}.pdf"),
            (f"CV_{fp}.pdf" if en else f"Lebenslauf_{fp}.pdf"),
            [(f"{group_file_stem(g, lang)}_{fp}.pdf", ids) for g, ids in groups.items()])


def build_mime(app: dict, files: list[tuple[str, bytes]]) -> bytes:
    msg = EmailMessage(policy=SMTP)
    msg["From"] = f'"{SENDER[0]}" <{SENDER[1]}>'
    to = app["email"]["to"]
    msg["To"] = f'"{app["email"]["to_name"]}" <{to}>' if app["email"].get("to_name") else to
    msg["Subject"] = app["email"].get("subject") or app["subject"]
    msg["X-Job-Agent-Id"] = app["id"]
    msg.set_content(app["email"]["body"], charset="utf-8")
    for name, data in files:
        msg.add_attachment(data, maintype="application", subtype="pdf", filename=name)
    return msg.as_bytes()


def load(app_path: Path) -> dict:
    return json.loads(app_path.read_text(encoding="utf-8"))


def check(app: dict) -> list[str]:
    """check_application mit allen Regeln der Person (always-Gruppen, hslu, angepasster Lebenslauf)."""
    check_cv = None
    if TAILORED_CV:
        import cv
        cv_data = cv.load_cv(DATA)
        check_cv = lambda t: cv.check_tailoring(t, cv_data)  # noqa: E731
    return check_application(app, set(ATTACHMENTS), always_groups=ALWAYS, check_cv=check_cv)


def cmd_check(app_path: Path) -> dict:
    app = load(app_path)
    errors = check(app)
    if errors:
        raise SystemExit("PRÜFUNG FEHLGESCHLAGEN:\n- " + "\n- ".join(errors))
    return app


def render_cv_pdf(app: dict) -> bytes:
    """Lebenslauf: bei cv: tailored pro Stelle gerendert, sonst das statische PDF aus dem Register."""
    if not TAILORED_CV:
        return ATTACHMENTS["lebenslauf"][0].read_bytes()
    import cv
    return cv.render_cv(cv.load_cv(DATA), app["cv"], PERSON, DOCS, app.get("lang", "de"), ROOT)


def build_files(app: dict, out: Path, portal: bool = False) -> list[tuple[str, bytes]]:
    """Anschreiben rendern (genau 1 Seite), Lebenslauf und pro Gruppe ein Beilagen-PDF; schreibt alles nach out/.
    portal: nur Anschreiben (plus angepasster Lebenslauf), den Rest hat die Person selbst."""
    letter = render_fitting(app)
    n_letter, n_cv, groups = file_names(app)
    files = [(n_letter, letter)]
    if not portal or TAILORED_CV:
        files.append((n_cv, render_cv_pdf(app)))
    if not portal:
        files += [(name, merge_pdfs([ATTACHMENTS[i][0] for i in ids])) for name, ids in groups]
    for name, data in files:
        (out / name).write_bytes(data)
    return files


def cmd_build(app_path: Path) -> tuple[dict, Path]:
    app, out, _ = _build(app_path)
    return app, out


def _build(app_path: Path) -> tuple[dict, Path, list[tuple[str, bytes]]]:
    app = cmd_check(app_path)
    if app["kind"] == "portal":
        raise SystemExit("kind 'portal' wird mit dem Befehl 'portal' gebaut, nicht mit build/submit.")
    out = app_dir(app_path)
    files = build_files(app, out)
    capture_ad(app, out)
    n_letter = files[0][0]
    mime = build_mime(app, files)
    (out / "message.eml").write_bytes(mime)
    total = len(mime) / 1e6
    if total > 12:
        raise SystemExit(f"Mail ist {total:.1f} MB gross, weniger Beilagen wählen.")
    print(f"OK: {n_letter} (1 Seite), {len(files)} Anhänge {[n for n, _ in files]}, Mail {total:.2f} MB -> {out}")
    return app, out, files


def _token() -> str:
    """Token für den Worker: JOB_ROUTINE_TOKEN, sonst lokale Datei ~/.config/job-agent/<id>.token (ADMIN_TOKEN des Workers)."""
    if os.environ.get("JOB_ROUTINE_TOKEN"):
        return os.environ["JOB_ROUTINE_TOKEN"]
    f = Path.home() / ".config" / "job-agent" / f"{PERSON['id']}.token"
    return f.read_text().strip() if f.exists() else ""


def _request(method: str, path: str, body: bytes | None = None, ctype: str | None = None) -> dict:
    url = os.environ.get("JOB_WORKER_URL", DEFAULT_WORKER_URL).rstrip("/") + path
    headers = {"User-Agent": "job-agent-routine/1.0", **({"Content-Type": ctype} if ctype else {})}
    # In der Cloud-Routine setzt der Agent-Proxy den Bearer-Token selbst (API-Credential des Environments),
    # das Token ist dort nicht sichtbar. Lokal kommt es aus JOB_ROUTINE_TOKEN.
    if _token():
        headers["Authorization"] = f"Bearer {_token()}"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.URLError as e:
            # python.org-Builds unter macOS bringen keine CA-Zertifikate mit. Die Cloud-Sandbox dagegen
            # braucht den System-Store (Proxy-CA), deshalb certifi nur als Rückfall.
            if not isinstance(e.reason, ssl.SSLCertVerificationError):
                raise
            import certifi
            ctx = ssl.create_default_context(cafile=certifi.where())
            with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
                return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Worker {e.code}: {e.read().decode(errors='replace')}")


def _request_bytes(path: str) -> bytes:
    """GET auf den Worker, Antwort als Bytes (z.B. Inserat-Screenshot)."""
    url = os.environ.get("JOB_WORKER_URL", DEFAULT_WORKER_URL).rstrip("/") + path
    headers = {"User-Agent": "job-agent-routine/1.0"}
    if _token():
        headers["Authorization"] = f"Bearer {_token()}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except urllib.error.URLError as e:
        if not isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            raise
        import certifi
        with urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context(cafile=certifi.where())) as r:
            return r.read()


CHECKPOINT_SUFFIXES = {".json", ".md", ".txt", ".yaml"}
CHECKPOINT_SKIP = {"_shots", "sample", "test-e2e"}


def _checkpoint_members() -> list[tuple[str, Path]]:
    """Was ein Wiederholungslauf braucht: Textdateien aus out/ (Entwürfe, progress.md, Kandidaten; PDFs und Mails
    baut build neu) und alle geänderten oder neuen Dateien im Daten-Repo (companies.yaml, learnings.md ...)."""
    out = ROOT / "out"
    members = [(f"out/{p.relative_to(out)}", p) for p in sorted(out.rglob("*"))
               if p.is_file() and p.suffix in CHECKPOINT_SUFFIXES and p.stat().st_size < 2_000_000
               and p.relative_to(out).parts[0] not in CHECKPOINT_SKIP] if out.exists() else []
    status = subprocess.run(["git", "-C", str(DATA), "status", "--porcelain", "-uall"],
                            capture_output=True, text=True, check=True).stdout
    for line in status.splitlines():
        rel = line[3:].split(" -> ")[-1].strip('"')
        if (DATA / rel).is_file():
            members.append((f"data-repo/{rel}", DATA / rel))
    return members


def cmd_checkpoint(quiet: bool = False) -> None:
    buf = BytesIO()
    members = _checkpoint_members()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, path in members:
            tar.add(path, arcname=name)
    _request("PUT", "/api/checkpoint", buf.getvalue(), "application/gzip")
    if not quiet:
        print(f"Zwischenstand gespeichert: {len(members)} Dateien, {len(buf.getvalue()) // 1024} KB")


def auto_checkpoint() -> None:
    """Nach build/submit/portal automatisch sichern. Nur in der Cloud (dort setzt der Proxy das Token, lokal steht es in
    JOB_ROUTINE_TOKEN), damit lokale Tests nie den Zwischenstand eines echten Laufs überschreiben."""
    if os.environ.get("JOB_ROUTINE_TOKEN"):
        return
    try:
        cmd_checkpoint(quiet=True)
    except (Exception, SystemExit) as e:  # noqa: BLE001
        print(f"Warnung: Zwischenstand nicht gespeichert ({e}). Später `jobagent.py checkpoint` erneut.")


def cmd_resume() -> None:
    try:
        data = _request_bytes("/api/checkpoint")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        print("Kein Zwischenstand: frischer Lauf.")
        return
    targets = {"out": ROOT / "out", "data-repo": DATA}
    n = 0
    with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            top, _, rel = m.name.partition("/")
            if not m.isfile() or top not in targets or not rel or ".." in Path(rel).parts or Path(rel).is_absolute():
                continue
            dest = targets[top] / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(tar.extractfile(m).read())
            n += 1
    print(f"Zwischenstand zurückgeholt: {n} Dateien (out/ und Daten-Repo).")
    progress = ROOT / "out" / "progress.md"
    print(progress.read_text(encoding="utf-8") if progress.exists() else "Keine out/progress.md im Zwischenstand.")


def ad_url(app: dict) -> str | None:
    """Welche Seite wird als Inserat fotografiert: ad_url, sonst job_url, sonst Portal-Link."""
    return app.get("ad_url") or app.get("job_url") or (app.get("portal") or {}).get("url")


def capture_ad(app: dict, out: Path) -> Path | None:
    """Für Personen mit RAV-Liste Pflicht: Screenshot des Inserats (bei Initiativ: Karriere-/Kontaktseite).
    Ein früher mit `snapshot` gesicherter Screenshot derselben URL bleibt erhalten (das Inserat kann inzwischen offline sein)."""
    if not PERSON.get("rav"):
        return None
    url = ad_url(app)
    if not url or not url.startswith("http"):
        raise SystemExit("Für die RAV-Liste braucht jede Bewerbung job_url oder ad_url (bei Initiativ: Karriere- oder Kontaktseite).")
    path, marker = out / "inserat.pdf", out / "inserat.url"
    if path.exists() and marker.exists() and marker.read_text().strip() == url:
        print(f"Inserat-Screenshot vom früheren Sichern übernommen: {path}")
        return path
    return _save_snapshot(url, out)


def _save_snapshot(url: str, out: Path) -> Path:
    import screenshot
    try:
        pdf = screenshot.capture_pdf(url)
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"Screenshot von {url} fehlgeschlagen ({e}). Andere URL als ad_url versuchen (z.B. das gleiche Inserat auf jobs.ch).")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "inserat.pdf"
    path.write_bytes(pdf)
    (out / "inserat.url").write_text(url)
    print(f"Inserat-Screenshot: {path}")
    return path


def cmd_snapshot(args: list[str]) -> None:
    """Sofort beim Sichten einer Stelle (vor Recherche und Bewerbung) das Inserat als PDF sichern, denn Firmen löschen
    es oft, sobald die Stelle besetzt ist. Bestehende Sicherung derselben URL bleibt (außer --force)."""
    force = "--force" in args
    args = [a for a in args if a != "--force"]
    if len(args) != 2 or not args[0].startswith("http"):
        raise SystemExit("snapshot <url> <id> [--force]")
    if not PERSON.get("rav"):
        print("Person ohne RAV-Liste: kein Screenshot nötig.")
        return
    out = ROOT / "out" / args[1]
    if not force and (out / "inserat.pdf").exists() and (out / "inserat.url").exists() \
            and (out / "inserat.url").read_text().strip() == args[0]:
        print(f"Schon gesichert: {out / 'inserat.pdf'}")
        return
    _save_snapshot(args[0], out)


def _multipart(fields: dict[str, str], files: dict[str, tuple[str, str, bytes]]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n'
                     f'Content-Type: application/json; charset=utf-8\r\n\r\n'.encode() + v.encode() + b"\r\n")
    for k, (fname, ctype, data) in files.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fname}"\r\n'
                     f"Content-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def rav_fields(app: dict) -> dict:
    """Angaben für die RAV-Liste: Pensum, Adresse des Arbeitgebers, Kontaktperson. Leere Werte weglassen."""
    r = app.get("recipient", {})
    person = (r.get("person") or "").replace("z. Hd.", "").strip() or None
    fields = {
        "pensum": app.get("pensum"),
        "company_address": ", ".join(x for x in (r.get("street"), r.get("zip_city")) if x) or None,
        "contact_name": (app.get("email") or {}).get("to_name") or person,
        "contact_phone": app.get("contact_phone"),
    }
    return {k: v for k, v in fields.items() if v}


def cmd_submit(app_path: Path) -> None:
    app, out, files = _build(app_path)
    names = [n for n, _ in files]
    n_letter, n_cv = names[0], names[1]
    meta = {
        "id": app["id"], "company": app["recipient"]["company"], "company_domain": app["company_domain"],
        "role": app["role"], "kind": app["kind"], "to_email": app["email"]["to"],
        "to_name": app["email"].get("to_name"), "subject": app["email"].get("subject") or app["subject"],
        "body_text": app["email"]["body"], "score": app["score"], "reason": app["reason"],
        "sources": app["sources"], "job_url": app.get("job_url"), "attachment_names": names,
        **({"hslu": app["hslu"]} if app.get("hslu") else {}), **rav_fields(app),
    }
    parts = {"mime": ("message.eml", "message/rfc822", (out / "message.eml").read_bytes()),
             "preview": (n_letter, "application/pdf", (out / n_letter).read_bytes())}
    if TAILORED_CV:
        parts["preview_cv"] = (n_cv, "application/pdf", (out / n_cv).read_bytes())
    if (out / "inserat.pdf").exists():
        parts["ad"] = ("inserat.pdf", "application/pdf", (out / "inserat.pdf").read_bytes())
    body, ctype = _multipart({"meta": json.dumps(meta, ensure_ascii=False)}, parts)
    print(json.dumps(_request("POST", "/api/applications", body, ctype), ensure_ascii=False, indent=2))


def cmd_portal(app_path: Path) -> None:
    """Portal-Paket: Anschreiben (bei cv: tailored zusätzlich der angepasste Lebenslauf) plus Hinweis, ob die
    HSLU-Bestätigung mitgehört, geht sofort per Telegram an die Person. Lebenslauf, Zeugnisse und Zertifikate
    hat sie selbst. Ein Tipp ohne Anschreiben ist nicht erlaubt, weil die Person damit nichts einreichen kann."""
    app = cmd_check(app_path)
    if app["kind"] != "portal":
        raise SystemExit("Für Portal-Pakete muss kind 'portal' sein.")
    files = build_files(app, app_dir(app_path), portal=True)
    ad = capture_ad(app, app_dir(app_path))
    pt = app["portal"]
    meta = {"company": app["recipient"]["company"], "role": app["role"], "url": pt["url"], "why": app["reason"],
            "deadline": pt.get("deadline"), "notes": pt["notes"],
            **({"hslu": app["hslu"]} if app.get("hslu") else {}), **rav_fields(app)}
    body, ctype = _multipart({"meta": json.dumps(meta, ensure_ascii=False)},
                             {**{f"file_{i}": (name, "application/pdf", data) for i, (name, data) in enumerate(files)},
                              **({"ad": ("inserat.pdf", "application/pdf", ad.read_bytes())} if ad else {})})
    print(json.dumps(_request("POST", "/api/portal-tips", body, ctype), ensure_ascii=False))
    print(f"Paket mit {len(files)} Dateien gesendet: {[n for n, _ in files]}")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "check":
        cmd_check(Path(args[0]))
        print("OK")
    elif cmd == "build":
        cmd_build(Path(args[0]))
        auto_checkpoint()
    elif cmd == "submit":
        cmd_submit(Path(args[0]))
        auto_checkpoint()
    elif cmd == "state":
        print(json.dumps(_request("GET", "/api/state"), ensure_ascii=False, indent=2))
    elif cmd == "portal":
        cmd_portal(Path(args[0]))
        auto_checkpoint()
    elif cmd == "portal-resend":
        body = json.dumps({"id": args[0]} if args else {}).encode()
        print(json.dumps(_request("POST", "/api/portal-resend", body, "application/json"), ensure_ascii=False))
    elif cmd == "pending-resend":
        print(json.dumps(_request("POST", "/api/pending-resend", b"{}", "application/json"), ensure_ascii=False))
    elif cmd == "checkpoint":
        cmd_checkpoint()
    elif cmd == "resume":
        cmd_resume()
    elif cmd == "note":
        body = json.dumps({"text": " ".join(args)}, ensure_ascii=False).encode()
        print(json.dumps(_request("POST", "/api/note", body, "application/json"), ensure_ascii=False))
    elif cmd == "rav":
        import rav
        rav.cmd_rav(args)
    elif cmd == "snapshot":
        cmd_snapshot(args)
        auto_checkpoint()
    elif cmd == "rav-draft":
        import rav
        rav.cmd_rav_draft(args)
    elif cmd == "harvest":
        import sources
        sources.cmd_harvest(args)
    elif cmd == "whoami":
        print(f"Person: {PERSON['name']} ({PERSON['id']})\nDaten-Repo: {DATA}\nWorker: {DEFAULT_WORKER_URL}\nRAV-Liste: {'ja' if PERSON.get('rav') else 'nein'}")
    elif cmd == "attachments":
        for k, (p, g, de, _) in ATTACHMENTS.items():
            print(f"{k:28} {g:10} {de}{'  (immer bei Mail)' if g in ALWAYS else ''}{'' if p.exists() else '  (FEHLT!)'}")
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
