import copy
import os
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "routine"))
import jobagent  # noqa: E402
from checks import check_application, check_pdf_pages  # noqa: E402

SAMPLE = json.loads((ROOT / "tests/fixtures/sample.json").read_text())
KNOWN = set(jobagent.ATTACHMENTS)


def errs(mutate):
    app = copy.deepcopy(SAMPLE)
    mutate(app)
    return jobagent.check(app)


def test_sample_ok():
    assert jobagent.check(SAMPLE) == []


@pytest.mark.parametrize("dash", ["—", "–"])
def test_long_dash_rejected(dash):
    e = errs(lambda a: a["paragraphs"].__setitem__(0, a["paragraphs"][0] + f" Das ist {dash} wichtig."))
    assert any("Gedankenstrich" in x for x in e)


def test_dash_in_mail_rejected():
    assert errs(lambda a: a["email"].__setitem__("body", a["email"]["body"] + " — x"))


def test_spaced_hyphen_rejected():
    assert any("' - '" in x for x in errs(lambda a: a.__setitem__("subject", "Bewerbung - IT")))


def test_compound_hyphen_ok():
    assert errs(lambda a: a.__setitem__("subject", "Bewerbung IT-Support")) == []


def test_eszett_rejected():
    assert any("ß" in x for x in errs(lambda a: a.__setitem__("salutation", "Sehr geehrte Frau Muster, Grüße")))


def test_floskel_rejected():
    assert any("Floskel" in x for x in errs(lambda a: a["paragraphs"].append("Ich bin ein Teamplayer.")))


def test_too_long_rejected():
    assert any("Wörter" in x for x in errs(lambda a: a["paragraphs"].append("wort " * 200)))


def test_unknown_attachment_rejected():
    assert any("unbekannte" in x for x in errs(lambda a: a["attachments"].append("fantasie-zertifikat")))


def test_cv_first():
    assert any("lebenslauf" in x for x in errs(lambda a: a["attachments"].reverse()))


def test_wrong_domain_rejected():
    assert any("Domain" in x for x in errs(lambda a: a["email"].__setitem__("to", "hr@andere-firma.ch")))


def test_subdomain_ok():
    assert errs(lambda a: a["email"].__setitem__("to", "hr@jobs.muster-security.ch")) == []


def test_pages():
    assert check_pdf_pages(1) == []
    assert check_pdf_pages(2)


def test_enclosures_match_attachments():
    txt = jobagent.enclosures_text(["lebenslauf", "zeugnis-stash", "sparc-3020", "az-900"], "de")
    assert txt == "Lebenslauf, Arbeitszeugnisse (STASH AG), SPARC-Zertifikate (3020 Blue Team Fundamentals), Microsoft-Zertifikate (AZ-900)"


def test_all_attachment_files_exist():
    missing = [k for k, (p, *_) in jobagent.ATTACHMENTS.items() if not p.exists()]
    assert missing == []


def test_build_sample(tmp_path):
    d = tmp_path / "x"
    d.mkdir()
    (d / "application.json").write_text(json.dumps(SAMPLE, ensure_ascii=False))
    app, out = jobagent.cmd_build(d / "application.json")
    eml = (out / "message.eml").read_bytes()
    assert b"jobs@muster-security.ch" in eml[:4000]
    assert b"\xe2\x80\x94" not in eml and b"\xe2\x80\x93" not in eml


def test_build_rejects_two_pages(tmp_path):
    app = copy.deepcopy(SAMPLE)
    app["layout"] = {"font_size": 16}
    d = tmp_path / "y"
    d.mkdir()
    (d / "application.json").write_text(json.dumps(app, ensure_ascii=False))
    with pytest.raises(SystemExit) as e:
        jobagent.cmd_build(d / "application.json")
    assert "nicht auf 1 Seite" in str(e.value)


CURT_MAIL = ("Sehr geehrte Frau Muster\n\nIm Anhang meine Initiativbewerbung. Anschreiben, Lebenslauf und Zeugnisse finden Sie im Anhang.\n\n"
             "Freundliche Grüsse\nMax Muster")


def test_curt_mail_rejected():
    e = errs(lambda a: a["email"].__setitem__("body", CURT_MAIL))
    assert any("ohne Dank" in x for x in e)
    assert any("Vorfreude" in x for x in e)


def test_polite_sample_mail_ok():
    body = SAMPLE["email"]["body"].lower()
    assert "vielen dank" in body and "freue mich" in body and "gerne" in body


def portal_app():
    a = copy.deepcopy(SAMPLE)
    a["kind"] = "portal"
    a.pop("email")
    a["portal"] = {"url": "https://jobs.example.ch/123", "notes": "HSLU-Aufnahme betonen", "deadline": "15.10.2026"}
    return a


def test_portal_ok_without_email():
    assert jobagent.check(portal_app()) == []


def test_portal_needs_url_and_notes():
    a = portal_app()
    a["portal"] = {"url": "keine-url"}
    e = jobagent.check(a)
    assert any("portal.url" in x for x in e) and any("portal.notes" in x for x in e)


def test_portal_dash_in_notes_rejected():
    a = portal_app()
    a["portal"]["notes"] = "SPARC — betonen"
    assert any("Gedankenstrich" in x for x in jobagent.check(a))


def test_portal_build_files(tmp_path):
    # Portal: nur das Anschreiben, Lebenslauf und Beilagen hat die Person selbst
    files = jobagent.build_files(portal_app(), tmp_path, portal=True)
    assert [n for n, _ in files] == ["Anschreiben_Test_Person_Muster_Security_AG.pdf"]
    assert (tmp_path / files[0][0]).exists()


def test_build_refuses_portal(tmp_path):
    (tmp_path / "application.json").write_text(json.dumps(portal_app(), ensure_ascii=False))
    with pytest.raises(SystemExit):
        jobagent.cmd_build(tmp_path / "application.json")


def test_data_dir_requires_exactly_one(tmp_path, monkeypatch):
    import subprocess
    code = tmp_path / "job-agent"
    code.mkdir()
    import shutil
    shutil.copytree(ROOT / "routine", code / "routine")
    env = {k: v for k, v in os.environ.items() if k != "JOB_DATA_DIR"}
    run = lambda: subprocess.run([sys.executable, str(code / "routine" / "jobagent.py"), "whoami"], capture_output=True, text=True, env=env)
    r = run()
    assert r.returncode != 0 and "Genau ein Daten-Repo" in (r.stderr + r.stdout)
    for name in ("job-data-a", "job-data-b"):
        (tmp_path / name / "profile").mkdir(parents=True)
        (tmp_path / name / "profile" / "person.yaml").write_text("id: x\n")
    r = run()
    assert r.returncode != 0 and "job-data-a" in (r.stderr + r.stdout)


def test_sender_from_person():
    assert jobagent.SENDER == ("Test Person", "test.person@example.com")
    assert jobagent.place_date(jobagent.date(2026, 11, 3), "de") == "Luzern, 3. November 2026"


def test_short_letter_rejected_for_underfilled_page(tmp_path):
    app = copy.deepcopy(SAMPLE)
    app["paragraphs"] = app["paragraphs"][:2]
    (tmp_path / "application.json").write_text(json.dumps(app, ensure_ascii=False))
    with pytest.raises(SystemExit) as e:
        jobagent.render_fitting(app)
    assert "füllt nur" in str(e.value)


def test_sample_fills_page():
    assert jobagent.page_fill(jobagent.render_fitting(SAMPLE)) >= jobagent.MIN_FILL
