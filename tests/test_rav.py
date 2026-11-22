import sys
from datetime import date
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "routine"))
import jobagent  # noqa: E402
import rav  # noqa: E402
from pypdf import PdfReader  # noqa: E402

ENTRIES = [
    {"source": "extern", "date": "2026-10-20", "company": "Beta AG", "role": "Sachbearbeiterin", "art": "telefonisch",
     "pensum": None, "result": "offen", "company_address": None, "contact_name": None, "contact_email": None, "contact_phone": None},
    {"source": "agent", "date": "2026-10-03", "company": "Alpha GmbH", "company_address": "Weg 1, 6000 Luzern",
     "contact_name": "Frau Muster", "contact_email": "jobs@alpha.ch", "contact_phone": None, "role": "Assistentin",
     "pensum": "80%", "art": "elektronisch (E-Mail)", "result": "einladung"},
]


def test_previous_month():
    assert rav.previous_month(date(2026, 11, 1)) == "2026-10"
    assert rav.previous_month(date(2027, 1, 1)) == "2026-12"


def test_rows_sorted_and_labels():
    t = rav.rows(ENTRIES)
    assert [r["company"] for r in t] == ["Alpha GmbH", "Beta AG"]
    assert t[0]["date_label"] == "03.10.2026"
    assert t[0]["employer"] == "Alpha GmbH, Weg 1, 6000 Luzern"
    assert t[0]["contact"] == "Frau Muster, jobs@alpha.ch"
    assert t[0]["result_label"] == "Vorstellungsgespräch"
    assert t[1]["contact"] == "" and t[1]["pensum"] == ""


def test_pdf_csv_mail():
    t = rav.rows(ENTRIES)
    pdf = rav.render_pdf("2026-10", t, date(2026, 11, 1))
    text = PdfReader(BytesIO(pdf)).pages[0].extract_text()
    assert "Nachweis der persönlichen Arbeitsbemühungen" in text and "Alpha GmbH" in text and "Oktober 2026" in text
    csv_text = rav.render_csv(t).decode("utf-8-sig")
    assert csv_text.splitlines()[1].startswith("1;03.10.2026;Alpha GmbH")
    body = rav.mail_body("2026-10", t)
    assert "2 Bewerbungen" in body and "—" not in body and "–" not in body
    mime = rav.build_mime("2026-10", "Arbeitsbemühungen Oktober 2026", body, pdf, rav.render_csv(t))
    assert b"To: test.person@example.com" in mime


def test_rav_fields_from_application():
    import json
    app = json.loads((ROOT / "tests/fixtures/sample.json").read_text())
    app["pensum"] = "100%"
    f = jobagent.rav_fields(app)
    assert f["pensum"] == "100%" and f["company_address"] == "Suurstoffi 99, 6343 Rotkreuz" and f["contact_name"] == "Anna Muster"


def test_appendix_with_screenshot_and_link():
    from pypdf import PdfWriter
    entries = [dict(ENTRIES[1], job_url="https://jobs.ch/inserat/1", ad_key="ad/x"), dict(ENTRIES[0], job_url=None, ad_key=None)]
    t = rav.rows(entries)
    w = PdfWriter(); w.add_blank_page(595, 842)
    buf = BytesIO(); w.write(buf)
    fake_ad = buf.getvalue()
    app = rav.render_appendix(t, lambda key: fake_ad)
    pages = PdfReader(BytesIO(app)).pages
    assert len(pages) == 3  # Trennblatt + Screenshot, Trennblatt ohne Screenshot
    first = pages[0].extract_text()
    assert "Nr. 1: Alpha GmbH" in first and "https://jobs.ch/inserat/1" in first
    assert "Kein Screenshot vorhanden" in pages[2].extract_text()
    assert "https://jobs.ch/inserat/1" in rav.render_csv(t).decode("utf-8-sig")
    pdf = rav.render_pdf("2026-10", t, date(2026, 11, 1))
    assert "jobs.ch/inserat/1" in PdfReader(BytesIO(pdf)).pages[0].extract_text()


def test_ad_required_for_rav_person(tmp_path, monkeypatch):
    import copy, json
    monkeypatch.setitem(jobagent.PERSON, "rav", True)
    app = json.loads((ROOT / "tests/fixtures/sample.json").read_text())
    app.pop("job_url", None)
    import pytest
    with pytest.raises(SystemExit) as e:
        jobagent.capture_ad(app, tmp_path)
    assert "job_url oder ad_url" in str(e.value)
    monkeypatch.setitem(jobagent.PERSON, "rav", False)
    assert jobagent.capture_ad(app, tmp_path) is None


def test_compact_group_without_company_names(monkeypatch):
    monkeypatch.setitem(jobagent.GROUP_TITLES, "zeugnis", {"de": "Arbeitszeugnisse", "en": "References", "compact": True})
    txt = jobagent.enclosures_text(["lebenslauf", "zeugnis-stash", "zeugnis-post", "az-900"], "de")
    assert txt == "Lebenslauf, Arbeitszeugnisse, Microsoft-Zertifikate (AZ-900)"
