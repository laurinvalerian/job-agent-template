"""Quellen-Sammler der Routine: neue Stellen aus öffentlichen Job-Schnittstellen und neue Einträge auf Karriereseiten.

Aufruf über jobagent.py:
    python routine/jobagent.py harvest              # Kandidaten nach out/harvest/ (candidates.md lesen)
    python routine/jobagent.py harvest --mark-seen  # am Ende des Laufs: gezeigte Kandidaten als gesehen merken

Konfiguration: $DATA/profile/search.yaml. Zustand im Daten-Repo: data/seen.json (Stellen und entdeckte Firmen),
data/watch.json (Link-Texte der Karriereseiten). Ohne --mark-seen wird im Daten-Repo nichts geschrieben: bricht ein
Lauf ab, erscheinen dieselben Kandidaten am nächsten Tag wieder. Jede Quelle scheitert für sich allein und steht dann
mit Fehler in der Zusammenfassung, damit die Routine dort per WebSearch nachholt (bereits Geholtes bleibt).

Quellen: jobs.ch (öffentliche Such-API), LinkedIn (öffentliche Gast-Suche), job-room.ch (RAV, öffentliche Such-API),
RSS-Feeds (z.B. ictjobs.ch) und die careers_url aller Firmen aus companies.yaml. Orte werden mit der Ortssuche von
geo.admin.ch verortet bzw. gegengeprüft (jobs.ch verortet einzelne Orte falsch, LinkedIn liefert keine Koordinaten).
"""

import html
import json
import math
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable, Iterator
from zoneinfo import ZoneInfo

import yaml

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
SEEN_KEEP_DAYS = 120
GEO_TOLERANCE_KM = 15  # weicht der Ort der Quelle so weit von der Ortssuche ab, gilt die Ortssuche
SOURCE_LABELS = {"jobsch": "jobs.ch", "linkedin": "LinkedIn", "jobroom": "job-room", "rss": "RSS", "careers": "Karriereseiten"}
DEFAULTS = {"pensum": {"min": 0, "max": 100}, "max_age_days": 21, "queries": [], "title_terms": [], "exclude_title": [],
            "fallback_terms": [],
            "sources": ["jobsch", "linkedin", "jobroom", "rss", "careers"], "rss": [], "manual": [], "areas": [],
            "pages": {"jobsch": 5, "linkedin": 1, "jobroom": 2, "rss": 3},
            "max_candidates": 80, "max_fallback": 20, "max_unknown_place": 30, "max_companies": 25,
            "linkedin_pause": 2.0, "linkedin_backoff": 30}

Fetcher = Callable[..., bytes]


@dataclass
class Job:
    source: str
    title: str
    company: str
    place: str
    url: str
    published: str = ""                     # YYYY-MM-DD, leer wenn unbekannt
    pensum: list[int] | None = None         # [min, max] in Prozent
    lat: float | None = None
    lon: float | None = None
    email: str = ""                         # Bewerbungsadresse, falls die Quelle eine nennt (job-room)
    contact: str = ""                       # Kontaktperson laut Quelle (job-room)
    sources: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    key: str = ""
    km: float | None = None                 # Luftlinie zum nächsten Suchgebiet


class SourceError(Exception):
    """Ein Teil der Abfragen einer Quelle ist gescheitert; die erfolgreichen Treffer wurden schon geliefert."""


# ---------------------------------------------------------------- HTTP

def fetch(url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET",
                                 headers={"User-Agent": UA, "Accept-Language": "de-CH,de;q=0.9", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.URLError as e:
        # Wie in jobagent._request: Cloud-Sandbox braucht den System-Store (Proxy-CA), certifi nur als Rückfall.
        if not isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            raise
        import certifi
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context(cafile=certifi.where())) as r:
            return r.read()


def _pooled(fn: Callable[..., list["Job"]], items: list, workers: int) -> Iterator["Job"]:
    """fn(item) parallel ausführen, Treffer liefern; scheitern einzelne Abfragen, am Ende SourceError."""
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(fn, it) for it in items]
        for f in as_completed(futures):
            try:
                yield from f.result()
            except Exception as e:  # noqa: BLE001 - einzelne Abfrage, die anderen zählen trotzdem
                errors.append(f"{type(e).__name__}: {e}")
    if errors:
        raise SourceError(f"{len(errors)} von {len(items)} Abfragen gescheitert, z.B. {errors[0]}")


# ---------------------------------------------------------------- Normalisieren, Filtern

_LEGAL = re.compile(r"\b(ag|gmbh|sa|sarl|sàrl|ltd|llc|inc|se|kg|co|und|schweiz|suisse|switzerland|svizzera|holding|group|gruppe|ch)\b")
_GENDER = re.compile(r"\((?:[mwfdxa]\s*[/|,]\s*)+[mwfdxa]\)|\((?:a|m|w|d|x|all genders?)\)|[:*/_]\s?-?in(?:nen)?\b|/-in\b", re.I)
_PENSUM = re.compile(r"(\d{2,3})\s*%?\s*(?:-|\u2013|bis|to|/)\s*(\d{2,3})\s*%|(\d{2,3})\s*%")


def norm_company(name: str) -> str:
    s = re.sub(r"\(.*?\)", " ", name.lower())
    s = _LEGAL.sub(" ", re.sub(r"[^\w]+", " ", s))
    return " ".join(s.split())


def norm_title(title: str) -> str:
    s = _GENDER.sub(" ", title)
    s = _PENSUM.sub(" ", s)
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s.lower())
    return " ".join(re.sub(r"[^\w]+", " ", s).split())


def job_key(company: str, title: str) -> str:
    return f"{norm_company(company)}|{norm_title(title)}"


def padded(title: str) -> str:
    """Titel klein, Satzzeichen als Leerzeichen, vorne und hinten ein Leerzeichen: ' it ' trifft nur das Wort IT."""
    return " " + " ".join(re.sub(r"[^\w%]+", " ", title.lower()).split()) + " "


def title_relevant(title: str, terms: list[str]) -> bool:
    if not terms:
        return True
    t = padded(title)
    return any(term.lower() in t for term in terms)


def title_excluded(title: str, excludes: list[str]) -> bool:
    t = padded(title)
    return any(x.lower() in t for x in excludes)


def parse_pensum(text: str) -> list[int] | None:
    m = _PENSUM.search(text)
    if not m:
        return None
    if m.group(3):
        v = int(m.group(3))
        return [v, v] if 10 <= v <= 100 else None
    a, b = int(m.group(1)), int(m.group(2))
    return [min(a, b), max(a, b)] if 10 <= a <= 100 and 10 <= b <= 100 else None


def pensum_ok(p: list[int] | None, cfg: dict) -> bool:
    """Spanne der Stelle überschneidet die gewünschte Spanne (z.B. 60 bis 100% passt zu höchstens 80%)."""
    if not p:
        return True
    return p[0] <= cfg["max"] and p[1] >= cfg["min"]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearest_area_km(lat: float, lon: float, areas: list[dict]) -> tuple[float, bool]:
    """Distanz zum nächsten Suchgebiet und ob der Ort in irgendeinem Gebiet liegt."""
    best, inside = float("inf"), False
    for a in areas:
        d = haversine_km(lat, lon, a["lat"], a["lon"])
        best = min(best, d)
        inside = inside or d <= a["km"]
    return best, inside


# ---------------------------------------------------------------- Ortssuche (geo.admin.ch)

_ALIASES = {"lucerne": "Luzern", "zurich": "Zürich", "berne": "Bern", "geneva": "Genf", "basle": "Basel"}
_TRANSLIT = str.maketrans({"ä": "a", "ö": "o", "ü": "u", "é": "e", "è": "e", "à": "a"})


def place_name(place: str) -> str:
    """Erster Ort einer Ortsangabe ohne Zusätze: 'Dübendorf (und Homeoffice)' -> 'Dübendorf', 'Raum Zürich' -> 'Zürich'."""
    s = re.sub(r"\(.*?\)", " ", place.split(",")[0].split(";")[0])
    s = re.sub(r"\b(raum|region|grossraum|gebiet|bei|nähe|und umgebung|umgebung)\b", " ", s, flags=re.I)
    s = re.sub(r"^\d{4}\s+", "", " ".join(s.split()))
    return _ALIASES.get(s.lower(), s)


def _loose(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower().translate(_TRANSLIT))


class Geocoder:
    """Ortsname -> (lat, lon) über die Ortssuche des Bundes (gratis, ohne Schlüssel), pro Lauf gecacht.
    Nur Treffer, deren Name zum gesuchten passt (Emmenbrücke ~ Emmen), sonst None: lieber unbekannt als falsch."""

    def __init__(self, fetcher: Fetcher):
        self.fetch = fetcher
        self.cache: dict[str, tuple[float, float] | None] = {}

    def lookup(self, place: str) -> tuple[float, float] | None:
        name = place_name(place)
        if len(name) < 2 or name.lower() in ("switzerland", "schweiz", "suisse", "remote", "homeoffice", "diverse"):
            return None
        if name in self.cache:
            return self.cache[name]
        q = urllib.parse.urlencode({"searchText": name, "type": "locations", "origins": "gg25,zipcode", "limit": 3})
        hit = None
        try:
            for r in json.loads(self.fetch(f"https://api3.geo.admin.ch/rest/services/api/SearchServer?{q}")).get("results") or []:
                label = re.sub(r"<[^>]+>|\(.*?\)|^\d{4}\s+", "", r["attrs"].get("label", "")).strip()
                a, b = _loose(label), _loose(name)
                if a and b and (a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a)))):
                    hit = (r["attrs"]["lat"], r["attrs"]["lon"])
                    break
        except Exception:  # noqa: BLE001 - Ort bleibt dann unbekannt
            hit = None
        self.cache[name] = hit
        return hit

    def prefetch(self, places: set[str], workers: int = 6) -> None:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(self.lookup, sorted(places)))


def locate(jobs: list["Job"], geo: Geocoder) -> None:
    """Fehlende Koordinaten ergänzen und offensichtlich falsche (Abweichung > GEO_TOLERANCE_KM) korrigieren."""
    geo.prefetch({j.place for j in jobs if j.place})
    for j in jobs:
        pt = geo.lookup(j.place) if j.place else None
        if pt is None:
            continue
        if j.lat is None or haversine_km(j.lat, j.lon, *pt) > GEO_TOLERANCE_KM:
            j.lat, j.lon = pt


# ---------------------------------------------------------------- Quellen

def _date(s: str | None) -> str:
    return (s or "")[:10]


def src_jobsch(cfg: dict, fetcher: Fetcher, cutoff: str) -> Iterator[Job]:
    """jobs.ch kennt keinen Radius: pro Suchbegriff und Ort (Kantonskürzel oder Ortsname) nach Datum blättern."""
    def one(combo: tuple[str, str]) -> list[Job]:
        query, loc = combo
        jobs = []
        for page in range(1, cfg["pages"]["jobsch"] + 1):
            q = urllib.parse.urlencode({"query": query, "location": loc, "rows": 20, "page": page, "sort": "date"})
            d = json.loads(fetcher(f"https://www.jobs.ch/api/v1/public/search?{q}"))
            docs = d.get("documents") or []
            for x in docs:
                c = x.get("coordinates") or {}
                grades = x.get("employment_grades") or []
                jobs.append(Job(
                    source="jobsch", title=x.get("title") or "",
                    company=(x.get("company_name") or "") if x.get("company_visible", True) else "",
                    place=x.get("place") or "", published=_date(x.get("publication_date")),
                    url=f"https://www.jobs.ch/de/stellenangebote/detail/{x['job_id']}/",
                    pensum=[min(grades), max(grades)] if grades else None, lat=c.get("lat"), lon=c.get("lon")))
            if not docs or page >= (d.get("num_pages") or 1) or _date(docs[-1].get("publication_date")) < cutoff:
                break
        return jobs

    combos = [(q, loc) for q in cfg["queries"] for a in cfg["areas"] for loc in (a.get("jobsch") or [])]
    yield from _pooled(one, combos, workers=4)


_LI_CARD = re.compile(r'data-entity-urn="urn:li:jobPosting:(\d+)"(.*?)(?=data-entity-urn="urn:li:jobPosting:|\Z)', re.S)


def parse_linkedin(fragment: str) -> list[Job]:
    jobs = []
    for job_id, body in _LI_CARD.findall(fragment):
        def grab(pattern: str) -> str:
            m = re.search(pattern, body, re.S)
            return " ".join(html.unescape(m.group(1)).split()) if m else ""
        jobs.append(Job(
            source="linkedin", title=grab(r'base-search-card__title">(.*?)</h3>'),
            company=grab(r'base-search-card__subtitle">.*?(?:<a[^>]*>)?\s*([^<]+?)\s*(?:</a>|</h4>)'),
            place=grab(r'job-search-card__location">(.*?)</span>'), published=grab(r'datetime="([\d-]+)"'),
            url=f"https://www.linkedin.com/jobs/view/{job_id}/"))
    return jobs


def src_linkedin(cfg: dict, fetcher: Fetcher, cutoff: str) -> Iterator[Job]:
    """Nacheinander mit Pause; bei 429 einmal länger warten, beim zweiten 429 abbrechen (Geholtes bleibt)."""
    seconds = cfg["max_age_days"] * 86400
    for query in cfg["queries"]:
        for a in cfg["areas"]:
            if not a.get("linkedin"):
                continue
            miles = next((m for m in (5, 10, 25, 50) if m >= a["km"] / 1.609), 50)
            for page in range(cfg["pages"]["linkedin"]):
                q = urllib.parse.urlencode({"keywords": query, "location": a["linkedin"], "distance": miles,
                                            "f_TPR": f"r{seconds}", "start": page * 10})
                url = f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?{q}"
                try:
                    raw = fetcher(url)
                except urllib.error.HTTPError as e:
                    if e.code != 429:
                        raise
                    time.sleep(cfg["linkedin_backoff"])
                    raw = fetcher(url)
                found = parse_linkedin(raw.decode("utf-8", "replace"))
                yield from found
                time.sleep(cfg["linkedin_pause"])
                if len(found) < 10:
                    break


def parse_jobroom(items: list[dict]) -> list[Job]:
    jobs = []
    for e in items:
        a = e.get("jobAdvertisement") or e
        jc = a.get("jobContent") or {}
        descs = jc.get("jobDescriptions") or [{}]
        desc = next((d for d in descs if d.get("languageIsoCode") == "de"), descs[0])
        loc, emp, ch = jc.get("location") or {}, jc.get("employment") or {}, jc.get("applyChannel") or {}
        coords, pc = loc.get("coordinates") or {}, jc.get("publicContact") or {}
        lo, hi = emp.get("workloadPercentageMin"), emp.get("workloadPercentageMax")
        jobs.append(Job(
            source="jobroom", title=re.sub(r"</?em>", "", desc.get("title") or ""),
            company=(jc.get("company") or {}).get("name") or "", place=loc.get("city") or "",
            published=_date((a.get("publication") or {}).get("startDate")),
            url=f"https://www.job-room.ch/job-search/{a.get('id')}",
            pensum=[int(lo), int(hi)] if lo and hi else None,
            lat=float(coords["lat"]) if coords.get("lat") else None, lon=float(coords["lon"]) if coords.get("lon") else None,
            email=ch.get("emailAddress") or "",
            contact=" ".join(x for x in (pc.get("firstName"), pc.get("lastName")) if x)))
    return jobs


def src_jobroom(cfg: dict, fetcher: Fetcher, cutoff: str) -> Iterator[Job]:
    size = 50

    def one(combo: tuple[str, dict]) -> list[Job]:
        query, a = combo
        body = {"workloadPercentageMin": max(10, cfg["pensum"]["min"]), "workloadPercentageMax": 100,
                "permanent": None, "companyName": None, "onlineSince": cfg["max_age_days"], "displayRestricted": False,
                "keywords": query.split(), "professionCodes": [], "communalCodes": [], "cantonCodes": [],
                # job-room verlangt mindestens 10 km; genauer filtert danach nearest_area_km
                "radiusSearchRequest": {"geoPoint": {"lat": a["lat"], "lon": a["lon"]}, "distance": max(10, round(a["km"]))}}
        jobs = []
        for page in range(cfg["pages"]["jobroom"]):
            items = json.loads(fetcher(f"https://www.job-room.ch/jobadservice/api/jobAdvertisements/_search?page={page}&size={size}&sort=date_desc",
                                       data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}))
            jobs.extend(parse_jobroom(items))
            if len(items) < size:
                break
        return jobs

    yield from _pooled(one, [(q, a) for q in cfg["queries"] for a in cfg["areas"]], workers=3)


def parse_rss(xml_bytes: bytes) -> list[Job]:
    root = ET.fromstring(xml_bytes)
    jobs = []
    for it in root.iter("item"):
        title = html.unescape((it.findtext("title") or "").strip())
        pub = it.findtext("pubDate") or ""
        try:
            published = parsedate_to_datetime(pub).date().isoformat() if pub else ""
        except (TypeError, ValueError):
            published = ""
        jobs.append(Job(source="rss", title=title, company=(it.findtext("{http://purl.org/dc/elements/1.1/}creator") or "").strip(),
                        place="", url=(it.findtext("link") or "").strip(), published=published, pensum=parse_pensum(title)))
    return jobs


def src_rss(cfg: dict, fetcher: Fetcher, cutoff: str) -> Iterator[Job]:
    for feed in cfg["rss"]:
        for page in range(1, cfg["pages"]["rss"] + 1):
            url = feed if page == 1 else f"{feed}{'&' if '?' in feed else '?'}paged={page}"
            found = parse_rss(fetcher(url))
            yield from found
            if not found or min(j.published or "9999" for j in found) < cutoff:
                break


SOURCES: dict[str, Callable[[dict, Fetcher, str], Iterator[Job]]] = {
    "jobsch": src_jobsch, "linkedin": src_linkedin, "jobroom": src_jobroom, "rss": src_rss}


# ---------------------------------------------------------------- Karriereseiten

_JOBLIKE = re.compile(r"%|\b[mwf]\s*/\s*[wmf]\b|\(a\)|:in\b|\*in\b|/in\b|stelle|job|praktik|werkstudent|working student|"
                      r"trainee|lehre|lernende|mitarbeiter|spezialist|techniker|analyst|engineer|supporter", re.I)


def page_entries(page_html: str) -> list[str]:
    """Link- und Überschriftstexte einer Karriereseite (dort stehen Stellentitel), ohne Skripte und Navigation."""
    s = re.sub(r"<(script|style|noscript|svg)\b.*?</\1>", " ", page_html, flags=re.S | re.I)
    out = []
    for m in re.finditer(r"<(a|h[1-4]|li)\b[^>]*>(.*?)</\1>", s, re.S | re.I):
        text = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", m.group(2))).split())
        if 6 <= len(text) <= 140:
            out.append(text)
    return sorted(set(out))


def check_careers(companies: list[dict], watch: dict, fetcher: Fetcher, terms: list[str],
                  workers: int = 6) -> tuple[list[dict], dict, int, int]:
    """Neue job-artige Einträge pro careers_url gegenüber watch.json. Erste Sichtung merkt nur, meldet nichts.
    Rückgabe: Änderungen, neuer Zustand, Anzahl geprüfter Seiten, Anzahl nicht erreichbarer Seiten."""
    targets = [(c.get("name") or "", c["careers_url"]) for c in companies
               if c.get("careers_url") and c.get("status", "offen") != "gesperrt"]

    def one(t: tuple[str, str]):
        try:
            return t, page_entries(fetcher(t[1]).decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 - einzelne Seite darf scheitern
            return t, None

    changes, state, failed = [], {}, 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for (name, url), entries in ex.map(one, targets):
            if entries is None:
                failed += 1
                if url in watch:
                    state[url] = watch[url]
                continue
            # nur job-artige Einträge merken (Navigation, Impressum usw. würden watch.json nur aufblähen)
            jobish = [e for e in entries if _JOBLIKE.search(e) or title_relevant(e, terms)]
            state[url] = jobish
            if url not in watch:
                continue
            old = set(watch[url])
            new = [e for e in jobish if e not in old]
            if new:
                changes.append({"company": name, "url": url, "new": new[:8]})
    return changes, state, len(targets), failed


# ---------------------------------------------------------------- Zusammenführen

def load_config(data_dir: Path) -> dict:
    p = data_dir / "profile" / "search.yaml"
    if not p.exists():
        raise SystemExit(f"{p} fehlt (Suchauftrag für harvest)")
    cfg = {**DEFAULTS, **(yaml.safe_load(p.read_text(encoding="utf-8")) or {})}
    cfg["pages"] = {**DEFAULTS["pages"], **(cfg.get("pages") or {})}
    cfg["pensum"] = {**DEFAULTS["pensum"], **(cfg.get("pensum") or {})}
    if not cfg["areas"] or not cfg["queries"]:
        raise SystemExit("search.yaml braucht areas und queries")
    return cfg


def load_companies(data_dir: Path) -> list[dict]:
    p = data_dir / "data" / "companies.yaml"
    if not p.exists():
        return []
    return (yaml.safe_load(p.read_text(encoding="utf-8")) or {}).get("companies") or []


def known_company(name: str, known: list[str]) -> bool:
    n = norm_company(name)
    if not n:
        return True
    return any(k and (n == k or (min(len(n), len(k)) >= 4 and (n.startswith(k) or k.startswith(n)))) for k in known)


def clean(text: str) -> str:
    """HTML-Entities auflösen, Leerraum zusammenfassen, '|' ersetzen (Trennzeichen der Kandidatenliste)."""
    return " ".join(html.unescape(html.unescape(text or "")).replace("\xa0", " ").replace("|", "/").split())


def merge(jobs: list[Job]) -> list[Job]:
    """Dieselbe Stelle aus mehreren Quellen zusammenlegen (Schlüssel Firma|Titel), alle Links behalten."""
    by_key: dict[str, Job] = {}
    for j in jobs:
        j.key = j.key or job_key(j.company, j.title)
        cur = by_key.get(j.key)
        if cur is None:
            j.sources, j.urls = [j.source], [j.url]
            by_key[j.key] = j
            continue
        if j.source not in cur.sources:
            cur.sources.append(j.source)
        if j.url not in cur.urls:
            cur.urls.append(j.url)
        if cur.lat is None and j.lat is not None:
            cur.lat, cur.lon, cur.place = j.lat, j.lon, j.place or cur.place
        cur.pensum = cur.pensum or j.pensum
        cur.email = cur.email or j.email
        cur.contact = cur.contact or j.contact
        if j.published and (not cur.published or j.published < cur.published):
            cur.published = j.published
    return list(by_key.values())


def run_sources(cfg: dict, fetcher: Fetcher, cutoff: str) -> tuple[list[Job], dict]:
    """Alle Quellen gleichzeitig (verschiedene Hosts). Fehler einer Quelle behalten deren bisherige Treffer."""
    names = [n for n in cfg["sources"] if n in SOURCES and not (n == "rss" and not cfg["rss"])]

    def one(name: str) -> tuple[str, list[Job], str | None, float]:
        got: list[Job] = []
        t0 = time.monotonic()
        try:
            for j in SOURCES[name](cfg, fetcher, cutoff):
                got.append(j)
            return name, got, None, time.monotonic() - t0
        except Exception as e:  # noqa: BLE001 - Quelle fällt einzeln aus, die anderen laufen weiter
            return name, got, f"{type(e).__name__}: {e}"[:240], time.monotonic() - t0

    raw, summary = [], {}
    with ThreadPoolExecutor(max_workers=max(1, len(names))) as ex:
        for name, got, err, secs in ex.map(one, names):
            raw.extend(got)
            summary[name] = {"hits": len(got), "error": err, "secs": round(secs)}
    return raw, summary


def harvest(cfg: dict, companies: list[dict], seen: dict, watch: dict, fetcher: Fetcher = fetch,
            today: date | None = None) -> dict:
    today = today or datetime.now(ZoneInfo("Europe/Zurich")).date()
    cutoff = (today - timedelta(days=cfg["max_age_days"])).isoformat()
    raw, summary = run_sources(cfg, fetcher, cutoff)
    for j in raw:
        j.title, j.company, j.place = clean(j.title), clean(j.company), clean(j.place)
        if j.source == "linkedin" and j.place.count(",") >= 2:
            j.place = j.place.split(",")[0].strip()  # "Zürich, Zürich, Schweiz" -> "Zürich"
        j.pensum = j.pensum or parse_pensum(j.title)
    jobs = merge(raw)
    locate(jobs, Geocoder(fetcher))

    known = [norm_company(c.get("name") or "") for c in companies]
    seen_jobs = seen.get("jobs") or {}
    seen_urls = {u for v in seen_jobs.values() for u in v.get("urls", [])}
    seen_companies = set(seen.get("companies") or [])

    candidates, fallback, unknown_place, discovered = [], [], [], {}
    for j in jobs:
        inside = True
        if j.lat is not None:
            km, inside = nearest_area_km(j.lat, j.lon, cfg["areas"])
            j.km = round(km, 1)
        if not inside or not title_relevant(j.title, cfg["title_terms"]):
            continue
        if j.published and j.published < cutoff:
            continue
        nc = norm_company(j.company)
        is_fallback = title_relevant(j.title, cfg["fallback_terms"]) and not title_relevant(
            j.title, [t for t in cfg["title_terms"] if t not in cfg["fallback_terms"]])
        # Firma mit Inseraten im Zielbereich (auch zu senior oder falsches Pensum): Kandidat für eine Initiativbewerbung
        if not is_fallback and j.company and j.lat is not None and not known_company(j.company, known) and nc not in seen_companies:
            d = discovered.setdefault(nc, {"company": j.company, "place": j.place, "km": j.km, "titles": [], "url": j.urls[0]})
            if len(d["titles"]) < 3 and j.title not in d["titles"]:
                d["titles"].append(j.title)
        if title_excluded(j.title, cfg["exclude_title"]) or not pensum_ok(j.pensum, cfg["pensum"]):
            continue
        if j.key in seen_jobs or any(u in seen_urls for u in j.urls):
            continue
        (unknown_place if j.lat is None else fallback if is_fallback else candidates).append(j)

    for lst in (candidates, fallback, unknown_place):
        lst.sort(key=lambda j: j.published or "0000", reverse=True)
    companies_found = sorted(discovered.values(), key=lambda d: (-len(d["titles"]), d["km"] if d["km"] is not None else 99))
    careers, watch_state = [], watch
    if "careers" in cfg["sources"]:
        careers, watch_state, checked, failed = check_careers(companies, watch, fetcher, cfg["title_terms"])
        summary["careers"] = {"hits": len(careers), "checked": checked, "failed": failed, "error": None}
    # Nur Gezeigtes wird später als gesehen gemerkt; der Rest erscheint in den nächsten Tagen.
    return {"date": today.isoformat(),
            "candidates": [asdict(j) for j in candidates[:cfg["max_candidates"]]],
            "fallback": [asdict(j) for j in fallback[:cfg["max_fallback"]]],
            "unknown_place": [asdict(j) for j in unknown_place[:cfg["max_unknown_place"]]],
            "companies": companies_found[:cfg["max_companies"]],
            "held_back": {"candidates": max(0, len(candidates) - cfg["max_candidates"]),
                          "fallback": max(0, len(fallback) - cfg["max_fallback"]),
                          "unknown_place": max(0, len(unknown_place) - cfg["max_unknown_place"]),
                          "companies": max(0, len(companies_found) - cfg["max_companies"])},
            "careers": careers, "summary": summary, "watch_state": watch_state, "manual": cfg["manual"]}


def mark_seen(result: dict, seen: dict, today: date) -> dict:
    """Alles, was harvest gezeigt hat, als gesehen merken; Einträge älter als SEEN_KEEP_DAYS fallen raus."""
    jobs = dict(seen.get("jobs") or {})
    for j in result["candidates"] + result.get("fallback", []) + result["unknown_place"]:
        jobs.setdefault(j["key"], {"first_seen": result["date"], "title": j["title"], "company": j["company"], "urls": j["urls"]})
    limit = (today - timedelta(days=SEEN_KEEP_DAYS)).isoformat()
    jobs = {k: v for k, v in jobs.items() if v.get("first_seen", "") >= limit}
    companies = sorted(set(seen.get("companies") or []) | {norm_company(c["company"]) for c in result["companies"]})
    return {"jobs": jobs, "companies": companies}


# ---------------------------------------------------------------- Ausgabe

def _line(j: dict) -> str:
    p = j.get("pensum")
    pensum = "?" if not p else (f"{p[0]}%" if p[0] == p[1] else f"{p[0]}-{p[1]}%")
    where = (j["place"] or "?") + (f" ({j['km']:.0f} km)" if j.get("km") is not None else "")
    srcs = ", ".join(SOURCE_LABELS.get(s, s) for s in j["sources"])
    extra = (f" | Mail: {j['email']}" if j.get("email") else "") + (f" | Kontakt: {j['contact']}" if j.get("contact") else "")
    return f"- {j['published'] or '?'} | {j['title']} | {j['company'] or '(anonym)'} | {where} | {pensum} | {srcs} | {' '.join(j['urls'])}{extra}"


def _company_line(c: dict) -> str:
    where = c["place"] + (f", {c['km']:.0f} km" if c.get("km") is not None else "")
    return f"- {c['company']} ({where}): {'; '.join(c['titles'])} | {c['url']}"


def render_md(result: dict, person: str) -> str:
    s, held = result["summary"], result.get("held_back") or {}
    parts = []
    for k, v in s.items():
        label = SOURCE_LABELS.get(k, k)
        if k == "careers":
            parts.append(f"{label} {v['checked']} geprüft, {v['hits']} mit Neuem" + (f", {v['failed']} nicht erreichbar" if v["failed"] else ""))
        else:
            parts.append(f"{label} {v['hits']}" + (" (Fehler)" if v["error"] else ""))
    lines = [f"# Kandidaten {result['date']} ({person})", "", "Treffer roh: " + "; ".join(parts)]
    errs = [f"{SOURCE_LABELS.get(k, k)}: {v['error']}" for k, v in s.items() if v.get("error")]
    if errs:
        lines += ["", "Ausgefallen oder unvollständig, heute per WebSearch/WebFetch nachholen:"] + [f"- {e}" for e in errs]

    def more(n: int) -> list[str]:
        return [f"- (weitere {n} folgen in den nächsten Läufen)"] if n else []

    lines += ["", f"## Neue Stellen im Suchgebiet ({len(result['candidates'])}), neueste zuerst"]
    lines += ([_line(j) for j in result["candidates"]] or ["- keine"]) + more(held.get("candidates", 0))
    if result.get("fallback"):
        lines += ["", f"## Fallback-Stellen ({len(result['fallback'])}), nur wenn sie laut preferences.md passen"]
        lines += [_line(j) for j in result["fallback"]] + more(held.get("fallback", 0))
    if result["unknown_place"]:
        lines += ["", f"## Ort unbekannt, im Inserat prüfen ({len(result['unknown_place'])})"]
        lines += [_line(j) for j in result["unknown_place"]] + more(held.get("unknown_place", 0))
    lines += ["", f"## Firmen mit Inseraten im Zielbereich, noch nicht in companies.yaml ({len(result['companies'])}): Initiativ-Kandidaten"]
    lines += ([_company_line(c) for c in result["companies"]] or ["- keine"]) + more(held.get("companies", 0))
    if result["careers"]:
        lines += ["", f"## Karriereseiten mit neuen Einträgen ({len(result['careers'])})"]
        lines += [f"- {c['company']} {c['url']}: " + "; ".join(f'"{e}"' for e in c["new"]) for c in result["careers"]]
    if result["manual"]:
        lines += ["", "## Ohne Schnittstelle, selbst prüfen"] + [f"- {m}" for m in result["manual"]]
    return "\n".join(lines) + "\n"


def _read_json(p: Path, default):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def _write_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def cmd_harvest(args: list[str]) -> None:
    import jobagent as ja
    out = ja.ROOT / "out" / "harvest"
    seen_p, watch_p = ja.DATA / "data" / "seen.json", ja.DATA / "data" / "watch.json"
    if "--mark-seen" in args:
        cand_p = out / "candidates.json"
        if not cand_p.exists():
            raise SystemExit("Zuerst `harvest` ausführen, dann am Ende des Laufs `harvest --mark-seen`.")
        result = _read_json(cand_p, {})
        _write_json(seen_p, mark_seen(result, _read_json(seen_p, {}), date.fromisoformat(result["date"])))
        _write_json(watch_p, result["watch_state"])
        print(f"Gemerkt: {len(result['candidates']) + len(result.get('fallback', [])) + len(result['unknown_place'])} Stellen, "
              f"{len(result['companies'])} Firmen, {len(result['watch_state'])} Karriereseiten -> {seen_p.name}, {watch_p.name}")
        return
    result = harvest(load_config(ja.DATA), load_companies(ja.DATA), _read_json(seen_p, {}), _read_json(watch_p, {}))
    _write_json(out / "candidates.json", result)
    md = render_md(result, ja.PERSON["name"])
    (out / "candidates.md").write_text(md, encoding="utf-8")
    print(md.split("\n## ")[0].strip())
    print(f"\n{len(result['candidates'])} neue Stellen, {len(result['fallback'])} Fallback, {len(result['unknown_place'])} mit unbekanntem Ort, "
          f"{len(result['companies'])} neue Firmen, {len(result['careers'])} Karriereseiten mit Neuem -> {out / 'candidates.md'}")
