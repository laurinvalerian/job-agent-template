"""Screenshot eines Stelleninserats als PDF (für die RAV-Liste).

Die ganze Seite wird mit einem Headless-Browser fotografiert, in A4-hohe Streifen geschnitten und mit
Kopfzeile (Link, Abrufzeitpunkt) als PDF gespeichert. So bleibt das Inserat belegbar, auch wenn es offline geht.

    python routine/screenshot.py <url> <out.pdf>
In der Cloud vorher einmal: python -m playwright install --with-deps chromium
"""

import io
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
COOKIE_BUTTONS = ("Alle akzeptieren", "Alle Cookies akzeptieren", "Akzeptieren", "Einverstanden", "Zustimmen",
                  "Accept all", "Accept", "OK", "Tout accepter")
MAX_HEIGHT_PX = 16000  # sehr lange Seiten kappen, das Inserat steht oben


def _launch(p):
    # In der Cloud läuft aller Verkehr über den Agent-Proxy (HTTPS_PROXY), der TLS neu terminiert.
    # Chromium kennt dessen CA nicht, deshalb Proxy explizit setzen und Zertifikatsfehler im Kontext ignorieren
    # (es werden nur öffentliche Inserate fotografiert, keine Logins).
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    base = {"proxy": {"server": proxy}} if proxy else {}
    for kwargs in (base, {**base, "channel": "chrome"}):  # Cloud: Playwright-Chromium, lokal: installiertes Chrome
        try:
            return p.chromium.launch(**kwargs)
        except Exception:  # noqa: BLE001
            continue
    raise SystemExit("Kein Browser für Screenshots gefunden (python -m playwright install --with-deps chromium).")


def capture_png(url: str) -> bytes:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = _launch(p)
        context = browser.new_context(viewport={"width": 1280, "height": 1600}, locale="de-CH", ignore_https_errors=True)
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:  # noqa: BLE001
            pass
        for label in COOKIE_BUTTONS:  # Cookie-Banner wegklicken, falls vorhanden
            try:
                btn = page.get_by_role("button", name=label, exact=False).first
                if btn.is_visible(timeout=500):
                    btn.click(timeout=1500)
                    page.wait_for_timeout(800)
                    break
            except Exception:  # noqa: BLE001
                continue
        png = page.screenshot(full_page=True)
        browser.close()
    return png


def png_to_pdf(png: bytes, url: str, when: datetime) -> bytes:
    import typst
    img = Image.open(io.BytesIO(png)).convert("RGB")
    if img.height > MAX_HEIGHT_PX:
        img = img.crop((0, 0, img.width, MAX_HEIGHT_PX))
    slice_h = int(img.width * 1.3)
    tmp = Path("out") / "_shots"
    tmp.mkdir(parents=True, exist_ok=True)
    stamp = when.strftime("%Y%m%d%H%M%S%f")
    paths = []
    for i, top in enumerate(range(0, img.height, slice_h)):
        part = img.crop((0, top, img.width, min(top + slice_h, img.height)))
        pth = (tmp / f"{stamp}-{i}.jpg").resolve()
        part.save(pth, "JPEG", quality=70)
        paths.append(str(pth))
    data = {"url": url, "when": when.strftime("%d.%m.%Y %H:%M"), "images": paths}
    pdf = typst.compile(str(ROOT / "templates" / "inserat.typ"), root="/",
                        font_paths=[str(ROOT / "fonts")], sys_inputs={"data": json.dumps(data, ensure_ascii=False)})
    for pth in paths:
        Path(pth).unlink(missing_ok=True)
    return pdf


def capture_pdf(url: str) -> bytes:
    return png_to_pdf(capture_png(url), url, datetime.now(ZoneInfo("Europe/Zurich")))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    Path(sys.argv[2]).write_bytes(capture_pdf(sys.argv[1]))
    print(f"Screenshot gespeichert: {sys.argv[2]}")
