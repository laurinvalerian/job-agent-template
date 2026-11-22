"""Lebenslauf pro Stelle (routine/cv.py) mit eigener fiktiver Test-Person unter tests/fixtures/cv."""

import copy
import sys
from datetime import date
from io import BytesIO
from pathlib import Path

import pytest
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "routine"))
import cv as cvmod  # noqa: E402
from checks import FORBIDDEN_DASHES  # noqa: E402

DATA = ROOT / "tests" / "fixtures" / "cv"
DOCS = DATA / "profile" / "docs"
TODAY = date(2026, 10, 3)
PERSON = {"name": "Erika Muster", "street": "Testweg 2", "zip_city": "6000 Luzern",
          "phone": "+41 00 000 00 00", "email": "erika.muster@example.com"}
TAILORING = {
    "profile": "Produktionsmitarbeiterin mit Erfahrung an Verpackungsanlagen und in der Qualitätskontrolle. "
               "Seit 2025 bildet sie sich berufsbegleitend zur Testtechnikerin HF weiter.",
    "experience": ["aktuell", "vorher"],
    "highlights": {"aktuell": [1, "Reinigung und Wartung der Linie"]},
    "skills": ["qualitaet", "office"],
}


@pytest.fixture
def cv():
    return cvmod.load_cv(DATA)


def errs(cv, mutate):
    t = copy.deepcopy(TAILORING)
    mutate(t)
    return cvmod.check_tailoring(t, cv, today=TODAY)


def pdf_text(pdf: bytes) -> tuple[int, str]:
    r = PdfReader(BytesIO(pdf))
    return len(r.pages), "\n".join(p.extract_text() for p in r.pages)


def test_tailoring_ok(cv):
    assert cvmod.check_tailoring(TAILORING, cv, today=TODAY) == []


def test_missing_tailoring(cv):
    assert any("cv fehlt" in e for e in cvmod.check_tailoring(None, cv, today=TODAY))


def test_unknown_station(cv):
    assert any("unbekannte Station 'erfunden'" in e for e in errs(cv, lambda t: t["experience"].append("erfunden")))


def test_required_station_missing(cv):
    e = errs(cv, lambda t: t["experience"].remove("vorher"))
    assert any("Pflicht-Stationen fehlen" in x and "vorher" in x for x in e)


def test_old_station_optional_but_allowed(cv):
    assert errs(cv, lambda t: t["experience"].append("alt")) == []


def test_station_order_fixed(cv):
    assert any("Reihenfolge" in e for e in errs(cv, lambda t: t["experience"].reverse()))


def test_duplicate_station(cv):
    assert any("doppelt" in e for e in errs(cv, lambda t: t["experience"].append("aktuell")))


@pytest.mark.parametrize("pick", [7, "Erfundene Aufgabe", True])
def test_bad_highlight(cv, pick):
    assert errs(cv, lambda t: t["highlights"]["aktuell"].append(pick))


def test_highlight_station_not_selected(cv):
    e = errs(cv, lambda t: t["highlights"].__setitem__("alt", [0]))
    assert any("nicht in cv.experience" in x for x in e)


def test_unknown_skill_and_field(cv):
    e = errs(cv, lambda t: (t["skills"].append("zauberei"), t.__setitem__("tasks", ["neu"])))
    assert any("unbekannte Kompetenz 'zauberei'" in x for x in e)
    assert any("cv.tasks: unbekanntes Feld" in x for x in e)


@pytest.mark.parametrize("profile,needle", [
    ("Nur ein einziger Satz über die Person, der aber lang genug ist, damit nur die Satzzahl stört und sonst nichts.",
     "Sätze"),
    ("Kurz. Zu kurz.", "Zeichen"),
    ("Eins ist da. Zwei ist da. Drei ist da. Vier ist da. Fünf ist da, und der Text ist lang genug für die "
     "Zeichengrenze von hundertfünfzig Zeichen insgesamt.", "Sätze"),
])
def test_profile_length(cv, profile, needle):
    assert any(needle in e for e in errs(cv, lambda t: t.__setitem__("profile", profile)))


@pytest.mark.parametrize("bad", list(FORBIDDEN_DASHES[:2]) + ["ß"])
def test_profile_forbidden_chars(cv, bad):
    e = errs(cv, lambda t: t.__setitem__("profile", t["profile"].replace("Seit 2025", f"Seit 2025 {bad} gross")))
    assert any("Gedankenstrich" in x or "'ß'" in x for x in e)


def test_dash_in_cv_yaml(cv):
    cv["experience"][0]["tasks"][0] = f"Bedienung {FORBIDDEN_DASHES[1]} Verpackung"
    assert any(x.startswith("cv.yaml.experience[0].tasks[0]") for x in cvmod.check_tailoring(TAILORING, cv, today=TODAY))


@pytest.mark.parametrize("tailoring,lang", [(None, "de"), (TAILORING, "de"), (TAILORING, "en")])
def test_render(cv, tailoring, lang):
    pages, text = pdf_text(cvmod.render_cv(cv, tailoring, PERSON, DOCS, lang, ROOT))
    assert 1 <= pages <= 2
    assert not any(ch in text for ch in FORBIDDEN_DASHES)
    assert "Erika Muster" in text and "erika.muster@example.com" in text
    assert "Muster AG" in text and "Beispiel GmbH" in text
    if tailoring:
        assert "Verpackungsanlagen und in der Qualitätskontrolle" in text
        assert "Alt AG" not in text
        # Hervorgehobene Aufgaben stehen zuerst
        assert text.index("Qualitätskontrolle nach Prüfplan") < text.index("Bedienung von Verpackungsanlagen")
        assert text.index("Prüfung nach Plan") < text.index("Bedienung und Wartung")
    else:
        assert "Alt AG" in text
    # Fixture hat nur teilweise englische Texte: dann deutsch, nie gemischt
    assert "Production Worker" not in text and "seit 03.2024" in text and "LEBENSLAUF" in text.replace(" ", "")


def english(cv: dict) -> dict:
    """Alle Pflicht-Texte mit X_en ergänzen."""
    en = copy.deepcopy(cv)
    for sec, keys in cvmod.EN_FIELDS.items():
        for x in en.get(sec, []):
            for k in keys:
                if x.get(k) and not x.get(f"{k}_en"):
                    x[f"{k}_en"] = [f"EN {t}" for t in x[k]] if isinstance(x[k], list) else f"EN {x[k]}"
    for g in en["skills"]:
        g.setdefault("title_en", "EN " + g["title"])
        for it in g["items"]:
            it.setdefault("label_en", "EN " + it["label"])
            it.setdefault("text_en", "EN " + it["text"])
    en["hobbies_en"] = ["Hiking", "Reading"]
    return en


def test_render_english(cv):
    assert cvmod.missing_en(cv)
    en = english(cv)
    assert cvmod.missing_en(en) == []
    pages, text = pdf_text(cvmod.render_cv(en, TAILORING, PERSON, DOCS, "en", ROOT))
    assert 1 <= pages <= 2
    assert "Production Worker" in text and "since 03.2024" in text and "EN Inventur" in text
    assert "Muttersprache" not in text


def test_render_rejects_bad_tailoring(cv):
    with pytest.raises(SystemExit, match="Pflicht-Stationen"):
        cvmod.render_cv(cv, {**TAILORING, "experience": ["aktuell"]}, PERSON, DOCS, "de", ROOT)


def test_render_too_long(cv):
    long = copy.deepcopy(cv)
    base = long["experience"][1]
    long["experience"] += [{**base, "id": f"x{i}", "tasks": [f"Aufgabe {i}.{k} mit etwas Text" for k in range(8)]}
                           for i in range(12)]
    with pytest.raises(SystemExit, match="Seiten"):
        cvmod.render_cv(long, None, PERSON, DOCS, "de", ROOT)
