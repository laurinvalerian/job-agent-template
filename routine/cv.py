"""Lebenslauf pro Stelle aus profile/cv.yaml rendern (nur für Personen mit "cv: tailored" in person.yaml).

Faktenschutz: Texte über Stationen, Aufgaben und Kompetenzen kommen ausschliesslich aus cv.yaml. Das Feld "cv"
in application.json darf nur auswählen, umsortieren und hervorheben, frei formuliert ist nur das Kurzprofil.

Schema profile/cv.yaml (Zeiträume als "JJJJ-MM", to fehlt/null = laufend; jedes Textfeld X darf ein X_en haben,
das bei lang "en" verwendet wird; englisch wird nur gerendert, wenn alle Texte X_en haben, siehe missing_en):
    photo: foto.jpg                        # optional, relativ zu profile/docs
    photo_crop: {zoom: 1.4, x: 0.47, y: 0} # optional: Ausschnitt (Vergrösserung, Bildmitte x, Versatz y)
    personal:                              # Zusatzangaben im Kopf (Kontaktdaten kommen aus person.yaml)
      - {label: Geburtsdatum, value: 12. Juni 2000}
    education:
      - {id, from, to, title, institution, note?}
    experience:                            # neueste zuerst
      - {id, from, to, role, company, location?, note?, tasks: [str, ...]}
    skills:                                # Gruppen, item-ids über alle Gruppen eindeutig
      - {group, title, items: [{id, label, text}, ...]}
    languages:
      - {language, level}
    hobbies: [str, ...]

Feld "cv" in application.json:
    {"profile": "Kurzprofil, 2 bis 4 Sätze, 150 bis 600 Zeichen, nur Fakten aus facts.md",
     "experience": ["selecta", "post", ...],   # Stations-ids in cv.yaml-Reihenfolge (neueste zuerst,
                                               # nicht umsortieren); weglassen nur, was vor mehr
                                               # als 10 Jahren endete (keine Lücken verstecken)
     "highlights": {"selecta": [1, "Qualitäts- und Hygienekontrollen gemäss Vorgaben"]},
                                               # pro Station Aufgaben (Index ab 0 oder exakter Text), die zuerst
                                               # und hervorgehoben stehen; optional
     "skills": ["maschinenfuehrung", "qualitaetskontrolle"]}
                                               # Kompetenz-ids, die innerhalb ihrer Gruppe zuerst stehen;
                                               # nicht genannte folgen in cv.yaml-Reihenfolge; optional
"""

import json
import re
import sys
from datetime import date
from io import BytesIO
from pathlib import Path

import typst
import yaml
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).parent))
from checks import FORBIDDEN_DASHES  # noqa: E402

MAX_PAGES = 2
KEEP_YEARS = 10                       # Stationen, die in den letzten 10 Jahren endeten, müssen drinbleiben
PROFILE_SENTENCES = (2, 4)
PROFILE_CHARS = (150, 600)
TAILORING_KEYS = {"profile", "experience", "highlights", "skills"}

HEADINGS = {
    "de": {"title": "Lebenslauf", "profile": "Kurzprofil", "experience": "Berufserfahrung", "education": "Ausbildung",
           "languages": "Sprachen", "hobbies": "Hobbys", "since": "seit", "today": "heute"},
    "en": {"title": "Curriculum Vitae", "profile": "Profile", "experience": "Work experience",
           "education": "Education", "languages": "Languages", "hobbies": "Hobbies", "since": "since",
           "today": "present"},
}


def load_cv(data_dir: Path) -> dict:
    """profile/cv.yaml des Daten-Repos lesen."""
    path = Path(data_dir) / "profile" / "cv.yaml"
    if not path.exists():
        raise SystemExit(f"Lebenslauf-Daten fehlen: {path}")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _ym(s: str | None) -> tuple[int, int] | None:
    if not s:
        return None
    y, m = str(s).split("-")
    return int(y), int(m)


def _required_stations(cv: dict, today: date) -> list[str]:
    """Stationen, die laufen oder in den letzten KEEP_YEARS Jahren endeten."""
    limit = (today.year - KEEP_YEARS, today.month)
    return [e["id"] for e in cv.get("experience", []) if (_ym(e.get("to")) or (9999, 12)) >= limit]


def _skill_ids(cv: dict) -> list[str]:
    return [it["id"] for g in cv.get("skills", []) for it in g.get("items", [])]


def _strings(obj, path: str = ""):
    """Alle Texte einer verschachtelten Struktur mit Pfad."""
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from _strings(v, f"{path}.{k}" if path else str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _strings(v, f"{path}[{i}]")


def _text_errors(obj, prefix: str) -> list[str]:
    errors = []
    for where, s in _strings(obj, prefix):
        for ch in FORBIDDEN_DASHES:
            if ch in s:
                errors.append(f"{where}: verbotener Gedankenstrich '{ch}' (nur normalen Bindestrich verwenden)")
        if "ß" in s:
            errors.append(f"{where}: 'ß' gefunden (Schweizer Schreibweise: ss)")
    return errors


def check_tailoring(tailoring: dict | None, cv: dict, today: date | None = None) -> list[str]:
    """Feld "cv" aus application.json gegen cv.yaml prüfen. Leere Liste = in Ordnung."""
    today = today or date.today()
    errors = _text_errors(cv, "cv.yaml")
    if not isinstance(tailoring, dict):
        return errors + ["cv fehlt: {\"profile\": ..., \"experience\": [...], \"highlights\": {...}, \"skills\": [...]}"]
    errors += [f"cv.{k}: unbekanntes Feld (erlaubt: {', '.join(sorted(TAILORING_KEYS))})"
               for k in tailoring if k not in TAILORING_KEYS]

    prof = tailoring.get("profile")
    if not isinstance(prof, str) or not prof.strip():
        errors.append("cv.profile fehlt (Kurzprofil, 2 bis 4 Sätze, nur Fakten)")
    else:
        n = len([s for s in re.split(r"(?<=[.!?])\s+", prof.strip()) if s.strip()])
        if not PROFILE_SENTENCES[0] <= n <= PROFILE_SENTENCES[1]:
            errors.append(f"cv.profile hat {n} Sätze (erlaubt {PROFILE_SENTENCES[0]} bis {PROFILE_SENTENCES[1]})")
        if not PROFILE_CHARS[0] <= len(prof) <= PROFILE_CHARS[1]:
            errors.append(f"cv.profile hat {len(prof)} Zeichen (erlaubt {PROFILE_CHARS[0]} bis {PROFILE_CHARS[1]})")

    stations = {e["id"]: e for e in cv.get("experience", [])}
    exp = tailoring.get("experience")
    if not isinstance(exp, list) or not all(isinstance(x, str) for x in exp):
        errors.append("cv.experience muss eine Liste von Stations-ids sein")
        exp = []
    for x in exp:
        if x not in stations:
            errors.append(f"cv.experience: unbekannte Station '{x}' (bekannt: {', '.join(stations)})")
    if len(set(exp)) != len(exp):
        errors.append("cv.experience: Station doppelt")
    # Reihenfolge fest wie in cv.yaml (neueste zuerst), sonst wirken die Daten durcheinander; Gewicht nur über highlights
    known_order = [x for x in exp if x in stations]
    if known_order != sorted(known_order, key=list(stations).index):
        errors.append("cv.experience: Reihenfolge wie in cv.yaml (neueste zuerst), nur auswählen, nicht umsortieren")
    missing = [s for s in _required_stations(cv, today) if s not in exp]
    if missing:
        errors.append(f"cv.experience: Pflicht-Stationen fehlen (letzte {KEEP_YEARS} Jahre, keine Lücken): "
                      + ", ".join(missing))

    hl = tailoring.get("highlights", {}) or {}
    if not isinstance(hl, dict):
        errors.append("cv.highlights muss ein Objekt {station_id: [Index oder Text, ...]} sein")
        hl = {}
    for sid, picks in hl.items():
        if sid not in stations:
            errors.append(f"cv.highlights: unbekannte Station '{sid}'")
            continue
        if sid not in exp:
            errors.append(f"cv.highlights: Station '{sid}' steht nicht in cv.experience")
        tasks = stations[sid].get("tasks", [])
        if not isinstance(picks, list):
            errors.append(f"cv.highlights.{sid} muss eine Liste sein")
            continue
        for p in picks:
            if isinstance(p, bool) or not isinstance(p, (int, str)):
                errors.append(f"cv.highlights.{sid}: {p!r} ist weder Index noch Text")
            elif isinstance(p, int) and not 0 <= p < len(tasks):
                errors.append(f"cv.highlights.{sid}: Index {p} ausserhalb 0 bis {len(tasks) - 1}")
            elif isinstance(p, str) and p not in tasks:
                errors.append(f"cv.highlights.{sid}: Text '{p}' steht nicht in cv.yaml (Aufgaben nur wörtlich)")

    sk = tailoring.get("skills", []) or []
    known = _skill_ids(cv)
    if not isinstance(sk, list):
        errors.append("cv.skills muss eine Liste von Kompetenz-ids sein")
        sk = []
    for x in sk:
        if x not in known:
            errors.append(f"cv.skills: unbekannte Kompetenz '{x}'")
    if len(set(map(str, sk))) != len(sk):
        errors.append("cv.skills: Kompetenz doppelt")

    errors += _text_errors({k: v for k, v in tailoring.items() if k == "profile"}, "cv")
    return errors


# Felder, die für einen englischen Lebenslauf ein X_en brauchen (Firmen-, Schul- und Ortsnamen nicht)
EN_FIELDS = {"personal": ("label", "value"), "education": ("title", "note"), "experience": ("role", "note", "tasks"),
             "languages": ("language", "level")}


def missing_en(cv: dict) -> list[str]:
    """Texte ohne englische Fassung. Fehlt etwas, wird der Lebenslauf deutsch gerendert (nie gemischt)."""
    out = [f"{sec}[{i}].{k}_en" for sec, keys in EN_FIELDS.items() for i, x in enumerate(cv.get(sec, []))
           for k in keys if x.get(k) and not x.get(f"{k}_en")]
    for gi, g in enumerate(cv.get("skills", [])):
        out += [f"skills[{gi}].title_en"] if not g.get("title_en") else []
        out += [f"skills[{gi}].items[{i}].{k}_en" for i, it in enumerate(g.get("items", []))
                for k in ("label", "text") if not it.get(f"{k}_en")]
    if cv.get("hobbies") and not cv.get("hobbies_en"):
        out.append("hobbies_en")
    for sid, e in ((e["id"], e) for e in cv.get("experience", [])):
        if e.get("tasks_en") and len(e["tasks_en"]) != len(e.get("tasks", [])):
            out.append(f"experience {sid}: tasks_en hat nicht gleich viele Einträge wie tasks")
    return out


def _loc(d: dict, key: str, lang: str):
    """Text in der gewünschten Sprache (X_en bei Englisch, sonst X)."""
    return d.get(f"{key}_en", d.get(key)) if lang == "en" else d.get(key)


def _period(f: str | None, t: str | None, lang: str) -> str:
    fmt = lambda s: "{1:02d}.{0}".format(*_ym(s))  # noqa: E731
    if not t:
        return f"{HEADINGS[lang]['since']} {fmt(f)}"
    return f"{fmt(f)} - {fmt(t)}"


def _picked(tasks: list[str], picks: list) -> list[int]:
    out = []
    for p in picks:
        i = p if isinstance(p, int) else tasks.index(p)
        if i not in out:
            out.append(i)
    return out


def cv_data(cv: dict, tailoring: dict | None, person: dict, docs_dir: Path, lang: str) -> dict:
    """Alles, was cv.typ braucht, fertig sortiert und in der richtigen Sprache."""
    t = tailoring or {}
    stations = {e["id"]: e for e in cv.get("experience", [])}
    order = t.get("experience") or list(stations)
    hl = t.get("highlights") or {}
    experience = []
    for sid in order:
        e = stations[sid]
        tasks = _loc(e, "tasks", lang) or []
        first = _picked(e.get("tasks", []), hl.get(sid, []))
        rest = [i for i in range(len(tasks)) if i not in first]
        experience.append({
            "period": _period(e.get("from"), e.get("to"), lang),
            "role": _loc(e, "role", lang), "company": _loc(e, "company", lang),
            "location": _loc(e, "location", lang), "note": _loc(e, "note", lang),
            "tasks": [{"text": tasks[i], "hl": True} for i in first] + [{"text": tasks[i], "hl": False} for i in rest],
        })
    prio = t.get("skills") or []
    skills = []
    for g in cv.get("skills", []):
        items = sorted(g.get("items", []), key=lambda it: prio.index(it["id"]) if it["id"] in prio else len(prio))
        skills.append({"title": _loc(g, "title", lang),
                       "items": [{"label": _loc(it, "label", lang), "text": _loc(it, "text", lang)} for it in items]})
    photo = None
    if cv.get("photo"):
        p = (Path(docs_dir) / cv["photo"]).resolve()
        if not p.exists():
            raise SystemExit(f"Foto für den Lebenslauf fehlt: {p}")
        photo = str(p)
    return {
        "lang": lang,
        "h": HEADINGS[lang],
        "name": person["name"],
        "contact": {k: person.get(k) for k in ("street", "zip_city", "phone", "email")},
        "personal": [{"label": _loc(x, "label", lang), "value": _loc(x, "value", lang)} for x in cv.get("personal", [])],
        "photo": photo,
        "photo_crop": cv.get("photo_crop") or {},
        "profile": t.get("profile"),
        "education": [{"period": _period(e.get("from"), e.get("to"), lang), "title": _loc(e, "title", lang),
                       "institution": _loc(e, "institution", lang), "note": _loc(e, "note", lang)}
                      for e in cv.get("education", [])],
        "experience": experience,
        "skills": skills,
        "languages": [{"language": _loc(x, "language", lang), "level": _loc(x, "level", lang)}
                      for x in cv.get("languages", [])],
        "hobbies": _loc(cv, "hobbies", lang) or [],
    }


def render_cv(cv: dict, tailoring: dict, person: dict, docs_dir: Path, lang: str, root: Path) -> bytes:
    """Lebenslauf als PDF (1 bis 2 Seiten). tailoring None = Reihenfolge wie in cv.yaml, ohne Kurzprofil.
    lang "en" nur, wenn cv.yaml alle Texte auch englisch hat (missing_en leer), sonst deutsch."""
    if tailoring is not None:
        errors = check_tailoring(tailoring, cv)
        if errors:
            raise SystemExit("PRÜFUNG FEHLGESCHLAGEN (Lebenslauf):\n" + "\n".join(f"- {e}" for e in errors))
    if lang not in HEADINGS or (lang == "en" and missing_en(cv)):
        lang = "de"   # lieber ganz deutsch als gemischt
    data = cv_data(cv, tailoring, person, docs_dir, lang)
    pdf = typst.compile(str(Path(root) / "templates" / "cv.typ"), font_paths=[str(Path(root) / "fonts")], root="/",
                        sys_inputs={"data": json.dumps(data, ensure_ascii=False)})
    pages = len(PdfReader(BytesIO(pdf)).pages)
    if not 1 <= pages <= MAX_PAGES:
        raise SystemExit(f"PRÜFUNG FEHLGESCHLAGEN:\n- Lebenslauf hat {pages} Seiten (erlaubt 1 bis {MAX_PAGES}). "
                         "Weniger Hervorhebungen oder ein kürzeres Kurzprofil wählen.")
    return pdf
