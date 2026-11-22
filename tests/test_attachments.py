"""Beilagen pro Gruppe als eigenes PDF, Upload-Inhalte von submit/portal, hslu- und always-Regeln."""

import copy
import json
import sys
from email import message_from_bytes
from email.policy import default
from io import BytesIO
from pathlib import Path

import pytest
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "routine"))
import jobagent  # noqa: E402
from checks import check_application  # noqa: E402

SAMPLE = json.loads((ROOT / "tests/fixtures/sample.json").read_text())

# Erwartete Mail-Anhänge der Testperson: Name -> Seiten (jede Fixture-Beilage hat 1 Seite)
EXPECTED = {
    "Anschreiben_Test_Person_Muster_Security_AG.pdf": 1,
    "Lebenslauf_Test_Person.pdf": 1,
    "Arbeitszeugnisse_Test_Person.pdf": 5,
    "SPARC_Zertifikate_Test_Person.pdf": 4,
    "Microsoft_Zertifikate_Test_Person.pdf": 2,
    "Aufnahmebestaetigung_HSLU_Test_Person.pdf": 1,
}


def pages(data: bytes) -> int:
    return len(PdfReader(BytesIO(data)).pages)


def write_app(tmp_path: Path, app: dict) -> Path:
    p = tmp_path / "application.json"
    p.write_text(json.dumps(app, ensure_ascii=False))
    return p


def portal_app() -> dict:
    a = copy.deepcopy(SAMPLE)
    a["kind"] = "portal"
    a.pop("email")
    a["portal"] = {"url": "https://jobs.example.ch/123", "notes": "SPARC betonen"}
    return a


def parse_multipart(body: bytes, ctype: str) -> dict:
    msg = message_from_bytes(f"Content-Type: {ctype}\r\n\r\n".encode() + body, policy=default)
    return {part.get_param("name", header="content-disposition"): (part.get_filename(), part.get_payload(decode=True))
            for part in msg.iter_parts()}


@pytest.fixture
def sent(monkeypatch):
    """Fängt den Upload an den Worker ab, statt ihn zu senden."""
    calls = []
    def fake(method, path, body=None, ctype=None):
        calls.append((path, parse_multipart(body, ctype)))
        return {"ok": True}
    monkeypatch.setattr(jobagent, "_request", fake)
    return calls


def test_build_separate_pdfs(tmp_path):
    files = jobagent.build_files(SAMPLE, tmp_path)
    assert {n: pages(d) for n, d in files} == EXPECTED
    assert [n for n, _ in files] == list(EXPECTED)  # Reihenfolge: erstes Auftreten in attachments
    for n in EXPECTED:
        assert (tmp_path / n).exists()


def test_group_order_follows_attachments(tmp_path):
    app = copy.deepcopy(SAMPLE)
    app["attachments"] = ["lebenslauf", "az-900", "zeugnis-post", "sc-900"]
    names = [n for n, _ in jobagent.build_files(app, tmp_path)]
    assert names[2:] == ["Microsoft_Zertifikate_Test_Person.pdf", "Arbeitszeugnisse_Test_Person.pdf"]


def test_english_file_names():
    app = copy.deepcopy(SAMPLE)
    app["lang"] = "en"
    letter, cv, groups = jobagent.file_names(app)
    assert letter == "Cover_Letter_Test_Person_Muster_Security_AG.pdf" and cv == "CV_Test_Person.pdf"
    assert [n for n, _ in groups] == ["References_Test_Person.pdf", "SPARC_Certificates_Test_Person.pdf",
                                      "Microsoft_Certificates_Test_Person.pdf", "HSLU_Admission_Test_Person.pdf"]


def test_group_without_title_falls_back_to_label():
    assert jobagent.group_file_stem("schule", "de") == "Jahreszeugnis_Maturajahr"


def test_eml_attachment_names(tmp_path):
    app, out = jobagent.cmd_build(write_app(tmp_path, SAMPLE))
    msg = message_from_bytes((out / "message.eml").read_bytes(), policy=default)
    atts = {a.get_filename(): pages(a.get_payload(decode=True)) for a in msg.iter_attachments()}
    assert atts == EXPECTED


def test_submit_meta(tmp_path, sent):
    jobagent.cmd_submit(write_app(tmp_path, SAMPLE))
    [(path, parts)] = sent
    assert path == "/api/applications"
    meta = json.loads(parts["meta"][1])
    assert meta["attachment_names"] == list(EXPECTED)
    assert meta["hslu"] == SAMPLE["hslu"]
    assert set(parts) == {"meta", "mime", "preview"}  # kein preview_cv ohne cv: tailored
    assert parts["preview"][0] == "Anschreiben_Test_Person_Muster_Security_AG.pdf"


def test_portal_uploads_only_letter(tmp_path, sent):
    jobagent.cmd_portal(write_app(tmp_path, portal_app()))
    [(path, parts)] = sent
    assert path == "/api/portal-tips"
    assert set(parts) == {"meta", "file_0"}
    assert parts["file_0"][0] == "Anschreiben_Test_Person_Muster_Security_AG.pdf"
    assert pages(parts["file_0"][1]) == 1
    assert json.loads(parts["meta"][1])["hslu"] == SAMPLE["hslu"]


def errs(app):
    return jobagent.check(app)


def test_hslu_required_when_registered():
    a = copy.deepcopy(SAMPLE)
    a.pop("hslu")
    assert any("hslu fehlt" in x for x in errs(a))
    a["hslu"] = {"attach": True, "reason": ""}
    assert any("hslu fehlt" in x for x in errs(a))
    a["hslu"] = {"attach": "ja", "reason": "x"}
    assert any("hslu fehlt" in x for x in errs(a))


def test_hslu_mail_must_match_attachments():
    a = copy.deepcopy(SAMPLE)
    a["hslu"]["attach"] = False
    assert any("hslu.attach" in x for x in errs(a))
    a["attachments"].remove("hslu-aufnahme")
    assert errs(a) == []
    a["hslu"]["attach"] = True
    assert any("hslu.attach" in x for x in errs(a))


def test_hslu_portal_required_as_note():
    a = portal_app()
    a.pop("hslu")
    assert any("hslu fehlt" in x for x in errs(a))
    a["hslu"] = {"attach": False, "reason": "Vollzeitstelle ohne Studienbezug"}
    a["attachments"].remove("hslu-aufnahme")
    assert errs(a) == []


def test_hslu_portal_must_match_attachments():
    # Sonst nennt die Beilagen-Zeile im Brief etwas anderes als der Hinweis an die Person
    a = portal_app()
    a["hslu"]["attach"] = False
    assert any("hslu.attach" in x for x in errs(a))
    a["attachments"].remove("hslu-aufnahme")
    a["hslu"]["attach"] = True
    assert any("hslu.attach" in x for x in errs(a))


def test_hslu_reason_max_length():
    a = copy.deepcopy(SAMPLE)
    a["hslu"]["reason"] = "x" * 201
    assert any("höchstens 200" in x for x in errs(a))
    a["hslu"]["reason"] = "x" * 200
    assert not any("höchstens" in x for x in errs(a))


def test_hslu_not_mentioned_when_not_attached():
    a = copy.deepcopy(SAMPLE)
    a["attachments"].remove("hslu-aufnahme")
    a["hslu"]["attach"] = False
    a["email"]["body"] = a["email"]["body"].replace("Zeugnisse und Zertifikate", "Zertifikate sowie die Aufnahmebestätigung der HSLU")
    assert any("email.body erwähnt" in x for x in errs(a))
    a["hslu"]["attach"] = True
    a["attachments"].append("hslu-aufnahme")
    assert not any("erwähnt" in x for x in errs(a))


def test_cv_profile_checked_like_letter():
    a = copy.deepcopy(SAMPLE)
    a["cv"] = {"profile": "Informatiker - Teamplayer mit Erfahrung."}
    e = errs(a)
    assert any("' - '" in x and "cv.profile" in x for x in e) and any("teamplayer" in x and "cv.profile" in x for x in e)


def test_hslu_reason_no_dash():
    a = copy.deepcopy(SAMPLE)
    a["hslu"]["reason"] = "Werkstudent — klar"
    assert any("hslu.reason" in x for x in errs(a))


def test_hslu_not_required_without_register_entry():
    a = copy.deepcopy(SAMPLE)
    a.pop("hslu")
    a["attachments"].remove("hslu-aufnahme")
    known = set(jobagent.ATTACHMENTS) - {"hslu-aufnahme"}
    assert check_application(a, known) == []


def test_always_groups_complete_for_mail():
    assert set(jobagent.ALWAYS) == {"zeugnis", "microsoft"}
    a = copy.deepcopy(SAMPLE)
    a["attachments"].remove("sc-900")
    a["attachments"].remove("bestaetigung-roche")
    e = [x for x in errs(a) if "immer vollständig" in x]
    assert len(e) == 2 and any("sc-900" in x for x in e) and any("bestaetigung-roche" in x for x in e)


def test_always_groups_not_enforced_for_portal():
    a = portal_app()
    a["attachments"].remove("sc-900")
    assert errs(a) == []


def test_check_cv_hook():
    # Ohne cv: tailored wird nichts verlangt; mit Hook ist cv Pflicht und wird geprüft
    a = copy.deepcopy(SAMPLE)
    known = set(jobagent.ATTACHMENTS)
    assert any("cv" in x for x in check_application(a, known, check_cv=lambda t: []))
    a["cv"] = {"profile": "x"}
    assert check_application(a, known, check_cv=lambda t: ["cv: unbekannte Station"]) == ["cv: unbekannte Station"]


@pytest.fixture
def tailored(monkeypatch):
    """Person mit cv: tailored; cv.py-Funktionen ersetzt, damit nur die Verdrahtung in jobagent geprüft wird."""
    import cv
    fake_pdf = (ROOT / "tests/fixtures/data/profile/docs/lebenslauf.pdf").read_bytes()
    rendered = []
    monkeypatch.setattr(jobagent, "TAILORED_CV", True)
    monkeypatch.setattr(cv, "load_cv", lambda data_dir: {"experience": []})
    monkeypatch.setattr(cv, "check_tailoring", lambda t, c, today=None: [] if t.get("profile") else ["cv.profile fehlt"])
    monkeypatch.setattr(cv, "render_cv", lambda c, t, person, docs, lang, root: rendered.append((t, lang)) or fake_pdf)
    return rendered


def with_cv(app: dict) -> dict:
    app = copy.deepcopy(app)
    app["cv"] = {"profile": "Kurzprofil."}
    return app


def test_tailored_requires_cv_field(tailored):
    assert any("Pflichtfeld fehlt: cv" in x for x in errs(SAMPLE))
    assert errs(with_cv(SAMPLE)) == []
    a = with_cv(SAMPLE)
    a["cv"] = {"experience": []}
    assert "cv.profile fehlt" in errs(a)


def test_tailored_submit_sends_preview_cv(tmp_path, tailored, sent):
    app = with_cv(SAMPLE)
    jobagent.cmd_submit(write_app(tmp_path, app))
    [(_, parts)] = sent
    assert set(parts) == {"meta", "mime", "preview", "preview_cv"}
    assert parts["preview_cv"][0] == "Lebenslauf_Test_Person.pdf"
    assert tailored == [(app["cv"], "de")]


def test_tailored_portal_sends_letter_and_cv(tmp_path, tailored, sent):
    jobagent.cmd_portal(write_app(tmp_path, with_cv(portal_app())))
    [(_, parts)] = sent
    assert set(parts) == {"meta", "file_0", "file_1"}
    assert parts["file_1"][0] == "Lebenslauf_Test_Person.pdf"
