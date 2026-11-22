import json
import sys
import urllib.error
import urllib.parse
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "routine"))
import sources  # noqa: E402

FIX = Path(__file__).parent / "fixtures" / "sources"
TODAY = date(2026, 10, 10)
HOCHDORF = {"name": "Hochdorf", "lat": 47.168, "lon": 8.292, "km": 30, "jobsch": ["LU"], "linkedin": "Lucerne, Switzerland"}
GEO = {"Luzern": (47.05, 8.31), "Zug": (47.17, 8.52), "Rothenburg": (47.09, 8.25), "Willisau": (47.12, 7.99),
       "Sursee": (47.17, 8.10), "Winikon": (47.24, 8.05)}


def cfg(**over) -> dict:
    c = {**sources.DEFAULTS, "areas": [HOCHDORF], "queries": ["Informatik"], "rss": [],
         "title_terms": ["security", " ict ", "support", "informatik", "schreiner", "logistik"],
         "exclude_title": ["senior", "leiter"], "pensum": {"min": 40, "max": 100}, "linkedin_pause": 0, "linkedin_backoff": 0,
         "sources": ["jobsch", "linkedin", "jobroom", "rss"]}
    c.update(over)
    c["pages"] = {**sources.DEFAULTS["pages"], **(over.get("pages") or {})}
    return c


class Fake:
    """Antwortet je nach Host mit den gespeicherten echten Antworten; `fail` lässt einen Host scheitern."""

    def __init__(self, fail: str | None = None, careers: dict | None = None):
        self.fail, self.careers, self.calls = fail, careers or {}, []

    def __call__(self, url: str, data=None, headers=None, timeout=25) -> bytes:
        self.calls.append(url)
        if self.fail and self.fail in url:
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
        if "geo.admin.ch" in url:
            name = url.split("searchText=")[1].split("&")[0]
            name = urllib.parse.unquote_plus(name)
            pt = GEO.get(name)
            res = [{"attrs": {"label": f"<b>{name} (LU)</b>", "lat": pt[0], "lon": pt[1]}}] if pt else []
            return json.dumps({"results": res}).encode()
        if "jobs.ch" in url:
            return (FIX / "jobsch.json").read_bytes()
        if "linkedin.com" in url:
            return (FIX / "linkedin.html").read_bytes()
        if "job-room.ch" in url:
            return (FIX / "jobroom.json").read_bytes()
        if url in self.careers:
            return self.careers[url].encode()
        if url.endswith("feed/"):
            return (FIX / "rss.xml").read_bytes()
        raise AssertionError(url)



def test_parsers():
    li = sources.parse_linkedin((FIX / "linkedin.html").read_text(encoding="utf-8"))
    assert li[0].title == "ICT Support Specialist 80-100% (w/m/d)" and li[0].company == "achermann ict-services ag"
    assert li[0].url == "https://www.linkedin.com/jobs/view/4472500127/" and li[0].published == "2026-10-01"
    jr = sources.parse_jobroom(json.loads((FIX / "jobroom.json").read_text(encoding="utf-8")))
    assert jr[2].company == "Anker Swiss ZP AG" and jr[2].email == "a.reimann@anker-swiss.ch" and jr[2].lat is not None
    rss = sources.parse_rss((FIX / "rss.xml").read_bytes())
    assert rss[0].company == "DATA UNIT AG" and rss[0].pensum == [80, 100] and rss[0].published == "2026-10-09"


def test_normalize_and_pensum():
    assert sources.job_key("Muster AG", "IT Supporter:in (a) 80-100%") == sources.job_key("Muster", "IT Supporter 80 - 100 %")
    assert sources.parse_pensum("Logistik 60 \u2013 80%") == [60, 80] and sources.parse_pensum("ohne") is None
    assert sources.pensum_ok([60, 100], {"min": 40, "max": 80}) and not sources.pensum_ok([100, 100], {"min": 40, "max": 80})
    assert sources.title_relevant("IT-Supporter", [" it "]) and not sources.title_relevant("Kitchen Aid", [" it "])
    assert sources.place_name("Dübendorf (und Homeoffice)") == "Dübendorf" and sources.place_name("Raum Zürich") == "Zürich"


def test_harvest_filters_merges_and_discovers():
    companies = [{"name": "Gemeindeverband ICT"}]
    r = sources.harvest(cfg(), companies, {}, {}, fetcher=Fake(), today=TODAY)
    titles = [j["title"] for j in r["candidates"]]
    assert not any("Abwasch" in t for t in titles)                     # Titel ohne Suchbegriff
    assert "Data Engineer (w/m/d)" not in titles                       # Titel ohne Suchbegriff
    assert any(t.startswith("Cyber Security Specialist") for t in titles)
    assert any("Schreiner" in t for t in titles)                       # job-room
    assert any(t.startswith("ICT Support Specialist") for t in titles)  # LinkedIn, Ort per Ortssuche
    assert r["candidates"] == sorted(r["candidates"], key=lambda j: j["published"], reverse=True)
    # gleiche Stelle aus jobs.ch mehrfach (pro Suchbegriff) nur einmal
    assert len(titles) == len(set(titles))
    # bekannte Firma nicht als Initiativ-Kandidat, unbekannte schon
    names = [c["company"] for c in r["companies"]]
    assert "Gemeindeverband ICT" not in names and "Anker Swiss ZP AG" in names
    assert r["summary"]["jobsch"] == {"hits": 3, "error": None, "secs": r["summary"]["jobsch"]["secs"]}


def test_distance_and_wrong_coordinates():
    far = {**HOCHDORF, "km": 5}
    r = sources.harvest(cfg(areas=[far]), [], {}, {}, fetcher=Fake(), today=TODAY)
    assert r["candidates"] == []                                        # alles weiter als 5 km
    j = sources.Job(source="jobsch", title="x", company="y", place="Luzern", url="u", lat=46.0, lon=7.0)
    sources.locate([j], sources.Geocoder(Fake()))
    assert (j.lat, j.lon) == GEO["Luzern"]                              # falsche Quell-Koordinaten korrigiert


def test_source_failure_keeps_others():
    r = sources.harvest(cfg(), [], {}, {}, fetcher=Fake(fail="linkedin.com"), today=TODAY)
    assert r["summary"]["linkedin"]["error"] and r["summary"]["jobsch"]["error"] is None
    assert any("Schreiner" in j["title"] for j in r["candidates"])
    assert "LinkedIn" in sources.render_md(r, "Test")


def test_seen_and_mark_seen():
    r1 = sources.harvest(cfg(), [], {}, {}, fetcher=Fake(), today=TODAY)
    assert r1["candidates"]
    # Lauf bricht ab (kein mark-seen): am nächsten Tag kommt alles wieder
    again = sources.harvest(cfg(), [], {}, {}, fetcher=Fake(), today=TODAY)
    assert len(again["candidates"]) == len(r1["candidates"])
    seen = sources.mark_seen(r1, {}, TODAY)
    r2 = sources.harvest(cfg(), [], seen, {}, fetcher=Fake(), today=TODAY)
    assert r2["candidates"] == [] and r2["companies"] == []
    # nach 120 Tagen fallen gemerkte Stellen raus
    later = sources.mark_seen({**r2, "candidates": [], "unknown_place": []}, seen, date(2027, 3, 1))
    assert later["jobs"] == {}


def test_caps_hold_back_rest():
    r = sources.harvest(cfg(max_candidates=1, max_companies=1), [], {}, {}, fetcher=Fake(), today=TODAY)
    assert len(r["candidates"]) == 1 and r["held_back"]["candidates"] >= 1
    assert len(r["companies"]) == 1
    assert "folgen in den nächsten Läufen" in sources.render_md(r, "Test")


def test_careers_watch():
    url = "https://firma.example/jobs"
    companies = [{"name": "Firma AG", "careers_url": url}]
    v1 = "<ul><li><a href='/a'>Sachbearbeiter Einkauf 80%</a></li></ul>"
    v2 = v1 + "<ul><li><a href='/b'>IT Supporter 100% (m/w/d)</a></li><li>Impressum und Datenschutz</li></ul>"
    c = cfg(sources=["careers"])
    first = sources.harvest(c, companies, {}, {}, fetcher=Fake(careers={url: v1}), today=TODAY)
    assert first["careers"] == [] and url in first["watch_state"]     # erste Sichtung merkt nur
    second = sources.harvest(c, companies, {}, first["watch_state"], fetcher=Fake(careers={url: v2}), today=TODAY)
    assert second["careers"] == [{"company": "Firma AG", "url": url, "new": ["IT Supporter 100% (m/w/d)"]}]
