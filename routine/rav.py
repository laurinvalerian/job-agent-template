"""Monatliche RAV-Liste: Arbeitsbemühungen des Vormonats als PDF, CSV und Mail an die Person selbst.

Aufruf über jobagent.py:  python routine/jobagent.py rav [YYYY-MM] [--dry] [--force]
Standard ist der Vormonat (Europe/Zurich). --dry baut nur die Dateien in out/rav-<monat>/.
"""

import csv
import io
import json
import re
from datetime import date, datetime
from email.message import EmailMessage
from email.policy import SMTP
from pathlib import Path
from zoneinfo import ZoneInfo

import typst

import jobagent as ja
from checks import FORBIDDEN_DASHES

RESULT_LABELS = {"offen": "offen", "absage": "Absage", "einladung": "Vorstellungsgespräch", "anstellung": "Anstellung"}


def previous_month(today: date | None = None) -> str:
    t = today or datetime.now(ZoneInfo("Europe/Zurich")).date()
    y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
    return f"{y:04d}-{m:02d}"


def month_label(month: str) -> str:
    y, m = month.split("-")
    return f"{ja.MONTHS['de'][int(m) - 1]} {y}"


def _join(*parts: str | None, sep: str = ", ") -> str:
    return sep.join(p.strip() for p in parts if p and p.strip())


def rows(entries: list[dict]) -> list[dict]:
    """Einträge vom Worker in lesbare Zeilen für PDF, CSV und Mail umwandeln. Fehlendes bleibt leer, nie erfunden."""
    out = []
    for e in sorted(entries, key=lambda x: (x.get("date") or "", x.get("company") or "")):
        d = e.get("date") or ""
        out.append({
            "date": d,
            "date_label": f"{d[8:10]}.{d[5:7]}.{d[0:4]}" if len(d) == 10 else d,
            "company": e.get("company") or "",
            "employer": _join(e.get("company"), e.get("company_address")),
            "contact": _join(e.get("contact_name"), e.get("contact_phone"), e.get("contact_email")),
            "role": e.get("role") or "",
            "pensum": e.get("pensum") or "",
            "art": e.get("art") or "",
            "result": e.get("result") or "offen",
            "result_label": RESULT_LABELS.get(e.get("result") or "offen", e.get("result") or "offen"),
            "job_url": e.get("job_url") or "",
            "ad_key": e.get("ad_key") or "",
        })
    return out


def render_pdf(month: str, table: list[dict], today: date) -> bytes:
    data = {
        "person": {k: ja.PERSON[k] for k in ("name", "street", "zip_city", "phone", "email")},
        "personennummer": str(ja.PERSON.get("rav_personennummer") or ""),
        "month_label": month_label(month),
        "entries": table,
        "place_date": ja.place_date(today, "de"),
        "footer": f"Arbeitsbemühungen {month_label(month)}, {ja.PERSON['name']}",
    }
    return typst.compile(str(ja.ROOT / "templates" / "rav.typ"), font_paths=[str(ja.ROOT / "fonts")],
                         sys_inputs={"data": json.dumps(data, ensure_ascii=False)})


def render_appendix(table: list[dict], fetch) -> bytes | None:
    """Anhang: pro Eintrag ein Trennblatt (Nr., Firma, Stelle, Link) und der Inserat-Screenshot, falls vorhanden."""
    from pypdf import PdfReader, PdfWriter
    if not table:
        return None
    w = PdfWriter()
    for i, r in enumerate(table, 1):
        ad = None
        if r.get("ad_key"):
            try:
                ad = fetch(r["ad_key"])
            except Exception:  # noqa: BLE001
                ad = None
        sep = typst.compile(str(ja.ROOT / "templates" / "rav_anhang.typ"), font_paths=[str(ja.ROOT / "fonts")],
                            sys_inputs={"data": json.dumps({"nr": i, "company": r["company"], "role": r["role"],
                                                            "date": r["date_label"], "url": r["job_url"],
                                                            "has_ad": bool(ad)}, ensure_ascii=False)})
        w.append(io.BytesIO(sep))
        if ad:
            w.append(io.BytesIO(ad))
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def render_csv(table: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Nr.", "Datum", "Arbeitgeber (Name, Adresse)", "Kontaktperson", "Stelle als", "Pensum", "Art der Bewerbung", "Ergebnis", "Link zum Inserat"])
    for i, r in enumerate(table, 1):
        w.writerow([i, r["date_label"], r["employer"], r["contact"], r["role"], r["pensum"], r["art"], r["result_label"], r["job_url"]])
    return ("﻿" + buf.getvalue()).encode("utf-8")  # BOM, damit Excel Umlaute richtig zeigt


def mail_body(month: str, table: list[dict]) -> str:
    first = ja.PERSON.get("first_name") or ja.PERSON["name"].split()[0]
    lines = [f"Hallo {first}", "",
             f"Hier ist deine Liste der Arbeitsbemühungen für {month_label(month)} mit {len(table)} "
             f"{'Bewerbung' if len(table) == 1 else 'Bewerbungen'}. Im Anhang findest du sie als PDF (zum Weiterleiten ans RAV "
             "oder zum Ausdrucken und Unterschreiben) und als CSV für Excel oder job-room.ch.", "",
             "Bitte kurz durchsehen, ob alles stimmt. Bewerbungen, die du selbst gemacht hast, kannst du im Bot mit /extern "
             "nachtragen, Ergebnisse mit /ergebnis ändern.", ""]
    for i, r in enumerate(table, 1):
        lines.append(f"{i}. {r['date_label']}: {r['company']}, {r['role']}"
                     + (f", {r['pensum']}" if r["pensum"] else "") + f" ({r['art']}, {r['result_label']})"
                     + (f"\n   {r['job_url']}" if r["job_url"] else ""))
    if not table:
        lines.append("In diesem Monat sind keine Bewerbungen erfasst.")
    lines += ["", "Viel Erfolg weiterhin!", "Dein Bewerbungs-Agent"]
    return "\n".join(lines)


def build_mime(month: str, subject: str, body: str, pdf: bytes, csv_bytes: bytes) -> bytes:
    msg = EmailMessage(policy=SMTP)
    msg["From"] = f'"{ja.PERSON["name"]}" <{ja.PERSON["email"]}>'
    msg["To"] = ja.PERSON["email"]
    msg["Subject"] = subject
    msg.set_content(body, charset="utf-8")
    base = f"Arbeitsbemuehungen_{month}_{ja.PERSON['file_prefix']}"
    msg.add_attachment(pdf, maintype="application", subtype="pdf", filename=f"{base}.pdf")
    msg.add_attachment(csv_bytes, maintype="text", subtype="csv", filename=f"{base}.csv")
    return msg.as_bytes()


def cmd_rav(args: list[str]) -> None:
    if not ja.PERSON.get("rav"):
        raise SystemExit("Für diese Person ist keine RAV-Liste eingestellt (person.yaml: rav: false).")
    month = next((a for a in args if not a.startswith("--")), None) or previous_month()
    if len(month) != 7 or month[4] != "-":
        raise SystemExit("Monat im Format YYYY-MM angeben.")
    data = ja._request("GET", f"/api/rav?month={month}")
    table = rows(data.get("entries", []))
    today = datetime.now(ZoneInfo("Europe/Zurich")).date()
    pdf = render_pdf(month, table, today)
    appendix = render_appendix(table, lambda key: ja._request_bytes(f"/api/file?key={key}"))
    if appendix:
        from pypdf import PdfWriter
        w = PdfWriter()
        w.append(io.BytesIO(pdf))
        w.append(io.BytesIO(appendix))
        buf = io.BytesIO()
        w.write(buf)
        pdf = buf.getvalue()
    csv_bytes = render_csv(table)
    subject = f"Arbeitsbemühungen {month_label(month)}, {ja.PERSON['name']}"
    body = mail_body(month, table)
    for text in (subject, body):
        if any(ch in text for ch in FORBIDDEN_DASHES):
            raise SystemExit("Gedankenstrich in RAV-Mail")
    mime = build_mime(month, subject, body, pdf, csv_bytes)
    out = Path("out") / f"rav-{month}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "liste.pdf").write_bytes(pdf)
    (out / "liste.csv").write_bytes(csv_bytes)
    (out / "message.eml").write_bytes(mime)
    print(f"RAV-Liste {month_label(month)}: {len(table)} Einträge -> {out}")
    if "--dry" in args:
        return
    meta = {"month": month, "subject": subject, "count": len(table), **({"force": True} if "--force" in args else {})}
    body_mp, ctype = ja._multipart({"meta": json.dumps(meta, ensure_ascii=False)},
                                   {"mime": ("message.eml", "message/rfc822", mime),
                                    "pdf": (f"Arbeitsbemuehungen_{month}.pdf", "application/pdf", pdf)})
    print(json.dumps(ja._request("POST", "/api/rav-report", body_mp, ctype), ensure_ascii=False))


# ---------- Monatsentwurf: Bewerbungen mit Anschreiben, Link und Screenshot zum Bearbeiten ----------

DRAFT_IMG_WIDTH = 900


def is_last_day_of_month(d: date) -> bool:
    from datetime import timedelta
    return (d + timedelta(days=1)).month != d.month


def ad_image_jpeg(pdf: bytes) -> bytes | None:
    """Inserat-Screenshot (PDF aus lauter Bildstreifen) als ein einziges JPEG, damit es im Entwurf sichtbar ist."""
    from PIL import Image
    from pypdf import PdfReader
    parts = []
    for page in PdfReader(io.BytesIO(pdf)).pages:
        parts += [Image.open(io.BytesIO(im.data)).convert("RGB") for im in page.images]
    if not parts:
        return None
    w = max(p.width for p in parts)
    sheet = Image.new("RGB", (w, sum(p.height for p in parts)), "white")
    y = 0
    for p in parts:
        sheet.paste(p, (0, y))
        y += p.height
    if sheet.width > DRAFT_IMG_WIDTH:
        sheet = sheet.resize((DRAFT_IMG_WIDTH, round(sheet.height * DRAFT_IMG_WIDTH / sheet.width)))
    buf = io.BytesIO()
    sheet.save(buf, "JPEG", quality=65)
    return buf.getvalue()


def pdf_text(pdf: bytes) -> str:
    from pypdf import PdfReader
    return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(pdf)).pages).strip()


MONTH_TARGET = 10  # RAV-Vorgabe von Person B: 10 Bewerbungen pro Monat auf 100%-Stellen


def is_full_time(e: dict) -> bool:
    return (e.get("pensum") or "").replace(" ", "") == "100%"


def draft_sections(table: list[dict], fetch, fetch_letter) -> list[dict]:
    """Pro Eintrag: Motivationsschreiben (PDF), Link und Screenshot. Fehlendes bleibt leer (Hinweis im Entwurf), nie erfunden."""
    out = []
    for r, e in table:
        letter = None
        try:
            letter = fetch(e["letter_key"]) if e.get("letter_key") else fetch_letter(e["id"])
        except BaseException:  # noqa: BLE001  (SystemExit vom Worker bei 404)
            letter = None
        img, page_url = None, ""
        if r.get("ad_key"):
            try:
                ad = fetch(r["ad_key"])
                img = ad_image_jpeg(ad)
                m = re.search(r"https?://\S+", pdf_text(ad))  # Kopfzeile des Screenshots: "Inserat abgerufen am ...: <url>"
                page_url = m.group(0) if m else ""
            except Exception:  # noqa: BLE001
                pass
        out.append({"r": r, "letter": letter, "img": img, "url": r["job_url"] or page_url, "initiativ": not r["job_url"]})
    return out


def draft_html(month: str, secs: list[dict]) -> str:
    from html import escape
    first = ja.PERSON.get("first_name") or ja.PERSON["name"].split()[0]
    n = len(secs)
    missing = max(0, MONTH_TARGET - n)
    status = (f"Das Ziel von {MONTH_TARGET} ist erreicht." if not missing
              else f"Fürs RAV fehlen noch {missing} Bewerbungen auf 100%-Stellen (Ziel {MONTH_TARGET}).")
    h = [f"<div style=\"font-family:Arial,sans-serif;font-size:14px;line-height:1.45\">",
         f"<p>Hallo {escape(first)}</p>",
         f"<p>Das sind deine {n} Bewerbungen auf 100%-Stellen im {month_label(month)}. {status} "
         "Zu jeder findest du Link und Screenshot, das Motivationsschreiben hängt als PDF an. "
         "Du kannst alles hier direkt bearbeiten, ergänzen oder löschen.</p>"]
    for i, s in enumerate(secs, 1):
        r = s["r"]
        h.append("<hr style=\"margin:28px 0 12px\">")
        h.append(f"<h2 style=\"font-size:17px;margin:0 0 4px\">{i}. {escape(r['company'])}</h2>")
        h.append(f"<p style=\"margin:0 0 8px\">{escape(r['role'])}<br>Beworben am {r['date_label']} ({escape(r['art'])})</p>")
        u = escape(s["url"], quote=True)
        if s["url"] and not s["initiativ"]:
            h.append(f"<p><b>Stelle:</b> <a href=\"{u}\">{u}</a></p>")
        elif s["url"]:
            h.append(f"<p><b>Initiativbewerbung</b> (kein Inserat), passende Seite des Betriebs: <a href=\"{u}\">{u}</a></p>")
        else:
            h.append("<p><b>Initiativbewerbung</b> (kein Inserat).</p>")
        h.append("<p><b>Motivationsschreiben:</b> " + (f"siehe Anhang {escape(s['letter_name'])}" if s["letter"] else "<i>PDF nicht mehr verfügbar.</i>") + "</p>")
        if s["img"]:
            h.append(f"<p><b>Screenshot:</b><br><img src=\"cid:ad{i}\" style=\"max-width:100%;border:1px solid #ddd\"></p>")
    h.append("</div>")
    return "".join(h)


def draft_text(month: str, secs: list[dict]) -> str:
    lines = [f"Deine Bewerbungen auf 100%-Stellen im {month_label(month)}", ""]
    for i, s in enumerate(secs, 1):
        r = s["r"]
        lines += [f"{i}. {r['company']}, {r['role']} ({r['date_label']})", s["url"] or "Initiativbewerbung", ""]
    return "\n".join(lines)


def build_draft_mime(month: str, secs: list[dict]) -> bytes:
    msg = EmailMessage(policy=SMTP)
    msg["From"] = f'"{ja.PERSON["name"]}" <{ja.PERSON["email"]}>'
    msg["To"] = ja.PERSON["email"]
    msg["Subject"] = f"Meine Bewerbungen {month_label(month)}"
    msg.set_content(draft_text(month, secs), charset="utf-8")
    msg.add_alternative(draft_html(month, secs), subtype="html", charset="utf-8")
    html_part = msg.get_payload()[1]
    for i, s in enumerate(secs, 1):
        if s["img"]:
            html_part.add_related(s["img"], maintype="image", subtype="jpeg", cid=f"<ad{i}>", filename=f"inserat-{i}.jpg",
                                  disposition="inline")
    for s in secs:
        if s["letter"]:
            msg.add_attachment(s["letter"], maintype="application", subtype="pdf", filename=s["letter_name"])
    return msg.as_bytes()


def cmd_rav_draft(args: list[str]) -> None:
    """Entwurf an sich selbst mit allen Bewerbungen des Monats. Standard: laufender Monat (Aufruf am letzten Tag)."""
    if not ja.PERSON.get("rav"):
        raise SystemExit("Für diese Person ist kein Monatsentwurf eingestellt (person.yaml: rav: false).")
    today = datetime.now(ZoneInfo("Europe/Zurich")).date()
    month = next((a for a in args if not a.startswith("--")), None) or f"{today.year:04d}-{today.month:02d}"
    if len(month) != 7 or month[4] != "-":
        raise SystemExit("Monat im Format YYYY-MM angeben.")
    entries = ja._request("GET", f"/api/rav?month={month}").get("entries", [])
    entries = [e for e in entries if e.get("source") != "extern"
               and (is_full_time(e) or not ja.PERSON.get("rav_full_time_only"))]
    by_id = {(e["source"], e["id"]): e for e in entries}
    table = [(r, by_id[(e["source"], e["id"])]) for r, e in zip(rows(entries), sorted(
        entries, key=lambda x: (x.get("date") or "", x.get("company") or "")))]
    secs = draft_sections(table, lambda key: ja._request_bytes(f"/api/file?key={key}"),
                          lambda app_id: ja._request_bytes(f"/api/letter?id={app_id}"))
    for i, sec in enumerate(secs, 1):
        slug = re.sub(r"[^A-Za-z0-9]+", "_", sec["r"]["company"]).strip("_")
        sec["letter_name"] = f"Motivationsschreiben_{i:02d}_{slug}.pdf"
    mime = build_draft_mime(month, secs)
    out = Path("out") / f"rav-draft-{month}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "message.eml").write_bytes(mime)
    print(f"Monatsentwurf {month_label(month)}: {len(secs)} Bewerbungen auf 100%, {len(mime) / 1e6:.1f} MB -> {out}")
    print(f"Fehlen fürs RAV-Ziel ({MONTH_TARGET}): {max(0, MONTH_TARGET - len(secs))}"
          + "".join(f"\n  ohne Motivationsschreiben: {x['r']['company']}" for x in secs if not x["letter"]))
    if "--dry" in args:
        return
    meta = {"month": month, "count": len(secs), **({"force": True} if "--force" in args else {}),
            **({} if "--draft-only" in args else {"fallback_mail": True})}
    body_mp, ctype = ja._multipart({"meta": json.dumps(meta, ensure_ascii=False)},
                                   {"mime": ("message.eml", "message/rfc822", mime)})
    print(json.dumps(ja._request("POST", "/api/rav-draft", body_mp, ctype), ensure_ascii=False))
