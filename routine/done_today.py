"""Erster Schritt jedes Routine-Laufs: Soll dieser Start arbeiten?

    python routine/done_today.py   # druckt FERTIG, WARTEN, LÄUFT oder OFFEN

FERTIG: Der Lauf von heute ist erledigt (Abschluss-Notiz liegt beim Worker), sofort beenden.
WARTEN: person.yaml nennt `after_worker` (Person mit Vorrang) und deren Lauf von heute ist noch nicht fertig.
        Sofort beenden, damit beide nicht gleichzeitig am selben Nutzungslimit ziehen; ein späterer Start holt es nach.
LÄUFT:  Ein anderer Lauf derselben Person arbeitet gerade (Anmeldung beim Worker, verlängert durch jeden
        Zwischenstand, frei nach 90 Minuten Stille oder mit der Abschluss-Notiz). Sofort beenden.
OFFEN:  Dieser Start ist angemeldet und arbeitet (bei einem abgebrochenen Lauf mit `jobagent.py resume` weiter).

Nur Standardbibliothek, damit der Check ohne pip install in Sekunden läuft. Im Zweifel OFFEN.
"""

import json
import os
import re
import ssl
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def person_yaml() -> str:
    if os.environ.get("JOB_DATA_DIR"):
        found = [Path(os.environ["JOB_DATA_DIR"]).expanduser() / "profile" / "person.yaml"]
    else:
        found = sorted(ROOT.parent.glob("job-data-*/profile/person.yaml"))
    if len(found) != 1:
        raise SystemExit(f"Genau ein Daten-Repo (job-data-*) erwartet, gefunden: {len(found)}")
    return found[0].read_text(encoding="utf-8")


def yaml_value(text: str, key: str) -> str | None:
    m = re.search(rf"^{key}:\s*[\"']?([^\"'\s#]+)", text, re.M)
    return m.group(1) if m else None


def fetch(req: urllib.request.Request) -> bytes:
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.URLError as e:
        # Lokal unter macOS fehlen python.org-Builds die CA-Zertifikate, die Cloud nutzt den System-Store.
        if not isinstance(e.reason, ssl.SSLCertVerificationError):
            raise
        import certifi
        with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context(cafile=certifi.where())) as r:
            return r.read()


def done_today(worker: str) -> bool:
    req = urllib.request.Request(worker.rstrip("/") + "/done-today", headers={"User-Agent": "job-agent-routine/1.0"})
    return json.loads(fetch(req)).get("done") is True


def claim(worker: str) -> str:
    """Anmeldung beim eigenen Worker. In der Cloud setzt der Proxy das Token, lokal JOB_ROUTINE_TOKEN."""
    headers = {"User-Agent": "job-agent-routine/1.0"}
    if os.environ.get("JOB_ROUTINE_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['JOB_ROUTINE_TOKEN']}"
    return json.loads(fetch(urllib.request.Request(worker.rstrip("/") + "/api/claim", data=b"{}", method="POST",
                                                   headers=headers)))["state"]


def main() -> None:
    text = person_yaml()
    worker = os.environ.get("JOB_WORKER_URL") or yaml_value(text, "worker_url")
    try:
        if done_today(worker):
            print("FERTIG")
            return
        after = yaml_value(text, "after_worker")
        if after and not done_today(after):
            print(f"WARTEN ({after} hat Vorrang und ist heute noch nicht fertig)")
            return
        state = claim(worker)
    except Exception as e:  # noqa: BLE001
        print(f"OFFEN (Status nicht abrufbar: {e})")
        return
    print({"done": "FERTIG", "running": "LÄUFT (ein anderer Lauf arbeitet gerade)"}.get(state, "OFFEN"))


if __name__ == "__main__":
    main()
