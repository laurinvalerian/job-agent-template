import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations-0003-rav.sql?raw";
import migration4 from "../migrations-0004-inserate.sql?raw";
import migration5 from "../migrations-0005-hslu.sql?raw";
import schema from "../schema.sql?raw";
import { handleUpdate } from "../src/bot";
import { resetTokenCache } from "../src/gmail";
import { processInbox } from "../src/inbox-watch";
import worker from "../src/index";
import { createApplication, createPortalTip } from "../src/queue";
import { monthBoundsUtc, parseExternArgs } from "../src/rav";
import { insertApp, makeEnv, makeForm, mockFetch, sampleMeta } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenCache();
});

const EM = String.fromCharCode(0x2014);
const cols = (raw: DatabaseSync, table: string) =>
  raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
const msg = (text: string) => ({ update_id: 1, message: { message_id: 8, chat: { id: 4242 }, text } });
const tgTexts = (f: ReturnType<typeof mockFetch>) => f.telegram().map((c) => (c.body as { text?: string }).text ?? "");
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const api = (path: string, init: RequestInit = {}) =>
  new Request(`https://w.example${path}`, { ...init, headers: { authorization: "Bearer routine-secret-token", ...(init.headers ?? {}) } });

describe("Schema und Migration", () => {
  const OLD = `
    CREATE TABLE applications (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, company TEXT NOT NULL, company_domain TEXT NOT NULL,
      role TEXT NOT NULL, kind TEXT NOT NULL, to_email TEXT NOT NULL, to_name TEXT, subject TEXT NOT NULL, body_text TEXT NOT NULL,
      attachment_keys TEXT NOT NULL DEFAULT '{}', score REAL, reason TEXT, sources TEXT NOT NULL DEFAULT '[]', job_url TEXT,
      status TEXT NOT NULL, sent_at TEXT, send_started_at TEXT, gmail_message_id TEXT, gmail_thread_id TEXT, last_reply_at TEXT,
      reply_class TEXT, error TEXT);
    CREATE TABLE portal_tips (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, company TEXT NOT NULL, role TEXT NOT NULL, url TEXT,
      why TEXT, deadline TEXT, notes TEXT, files TEXT, applied_at TEXT, status TEXT NOT NULL DEFAULT 'new');
    INSERT INTO applications (id, created_at, company, company_domain, role, kind, to_email, subject, body_text, status)
      VALUES ('alt', 'x', 'A', 'a.ch', 'R', 'stelle', 'hr@a.ch', 'S', 'B', 'sent');
    INSERT INTO portal_tips (id, created_at, company, role) VALUES ('t', 'x', 'P', 'R');`;

  it("neue DB aus schema.sql hat alle neuen Spalten, Tabelle und CHECK", () => {
    const { raw } = makeEnv();
    expect(cols(raw, "applications")).toEqual(expect.arrayContaining(["pensum", "company_address", "contact_name", "contact_phone", "result"]));
    expect(cols(raw, "portal_tips")).toEqual(expect.arrayContaining(["pensum", "company_address", "result"]));
    expect(cols(raw, "external_applications")).toEqual(["id", "created_at", "applied_on", "company", "role", "art", "pensum", "result", "notes", "url"]);
    insertApp(raw, { id: "n1" });
    expect(raw.prepare("SELECT result FROM applications").get()!.result).toBe("offen");
    expect(() => raw.prepare("UPDATE applications SET result = 'vielleicht'").run()).toThrow();
  });

  it("Migration bringt eine bestehende DB auf denselben Spaltenstand, bestehende Zeilen 'offen'", () => {
    const old = new DatabaseSync(":memory:");
    old.exec(OLD);
    old.exec(migration);
    old.exec(migration4);
    old.exec(migration5);
    const fresh = new DatabaseSync(":memory:");
    fresh.exec(schema);
    for (const t of ["applications", "portal_tips", "external_applications"]) expect(cols(old, t)).toEqual(cols(fresh, t));
    expect(old.prepare("SELECT result FROM applications").get()!.result).toBe("offen");
    expect(old.prepare("SELECT result FROM portal_tips").get()!.result).toBe("offen");
  });
});

describe("meta-Felder für den RAV-Nachweis", () => {
  const NOW = new Date("2026-11-03T06:00:00Z");
  it("POST /api/applications speichert pensum, Adresse und Kontakt", async () => {
    const { env, raw } = makeEnv();
    mockFetch();
    const meta = sampleMeta({ pensum: "80-100%", company_address: "Bahnhofstr. 1, 8000 Zürich", contact_name: "Frau Muster", contact_phone: "+41 44 000 00 00" });
    expect((await createApplication(env, makeForm(meta), NOW)).status).toBe(201);
    expect(raw.prepare("SELECT pensum, company_address, contact_name, contact_phone, result FROM applications").get()).toEqual({
      pensum: "80-100%",
      company_address: "Bahnhofstr. 1, 8000 Zürich",
      contact_name: "Frau Muster",
      contact_phone: "+41 44 000 00 00",
      result: "offen",
    });
  });

  it("prüft Länge und Gedankenstriche", async () => {
    const { env, raw } = makeEnv();
    mockFetch();
    expect((await createApplication(env, makeForm(sampleMeta({ pensum: "x".repeat(201) })), NOW)).status).toBe(400);
    expect((await createApplication(env, makeForm(sampleMeta({ company_address: `A ${EM} B` })), NOW)).status).toBe(422);
    expect((await createApplication(env, makeForm(sampleMeta({ contact_phone: 41 })), NOW)).status).toBe(400);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM applications").get()!.n).toBe(0);
  });

  it("POST /api/portal-tips speichert pensum und Adresse (JSON und multipart)", async () => {
    const { env, raw } = makeEnv();
    mockFetch();
    const r1 = await createPortalTip(env, { company: "A", role: "R", pensum: "60%", company_address: "Weg 2, 6000 Luzern" }, NOW);
    const form = new FormData();
    form.append("meta", JSON.stringify({ company: "B", role: "R", pensum: "100%" }));
    const r2 = await createPortalTip(env, undefined, NOW, form);
    const get = (id: unknown) => raw.prepare("SELECT pensum, company_address, result FROM portal_tips WHERE id = ?").get(String(id));
    expect(get((r1.body as { id: string }).id)).toEqual({ pensum: "60%", company_address: "Weg 2, 6000 Luzern", result: "offen" });
    expect(get((r2.body as { id: string }).id)).toEqual({ pensum: "100%", company_address: null, result: "offen" });
    expect((await createPortalTip(env, { company: "A", role: "R", pensum: `50${EM}60%` }, NOW)).status).toBe(422);
  });
});

describe("Posteingang setzt result", () => {
  const gmailMessage = (id: string) =>
    Response.json({
      id,
      threadId: `th-${id}`,
      internalDate: "0",
      snippet: "Antwort",
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: "HR <hr@acme.ch>" }, { name: "Subject", value: "Ihre Bewerbung" }], body: { data: "QW50d29ydA" } },
    });

  async function run(ergebnis: string, initial = "offen", cls = "echte_antwort") {
    const { env, raw } = makeEnv();
    (env.AI.run as ReturnType<typeof vi.fn>).mockResolvedValue({ response: { class: cls, ergebnis, summary: "Kurz." } });
    insertApp(raw, { id: "a1", company: "Acme AG", company_domain: "acme.ch", status: "sent", sent_at: "2026-10-20T07:00:00.000Z" });
    raw.prepare("UPDATE applications SET result = ?").run(initial);
    const f = mockFetch((url) => {
      if (url.includes("/messages?q=")) return Response.json({ messages: [{ id: "m1" }] });
      if (url.includes("/messages/m1")) return gmailMessage("m1");
      return undefined;
    });
    await processInbox(env, new Date("2026-10-21T10:00:00Z"));
    return { result: raw.prepare("SELECT result FROM applications").get()!.result, texts: tgTexts(f) };
  }

  it("einladung und absage setzen result, ohne Telegram-Meldung", async () => {
    const e = await run("einladung");
    expect(e.result).toBe("einladung");
    expect(e.texts).toEqual([]);
    const a = await run("absage");
    expect(a.result).toBe("absage");
    expect(a.texts).toEqual([]);
  });

  it("rueckfrage ändert nichts; anstellung wird nie überschrieben; unklar setzt nichts", async () => {
    const r = await run("rueckfrage");
    expect(r.result).toBe("offen");
    expect((await run("absage", "anstellung")).result).toBe("anstellung");
    expect((await run("absage", "offen", "unklar")).result).toBe("offen");
  });
});

describe("/extern", () => {
  const NOW = new Date("2026-10-31T23:30:00Z"); // in Zürich schon 01.11.2026

  it("parst alle Felder, Datum in beiden Formaten, persönlich", () => {
    const p = parseExternArgs("Muster AG; IT Supporter; 03.10.2026; persönlich; 80%", NOW, "Europe/Zurich");
    expect(p).toEqual({ ok: true, value: { company: "Muster AG", role: "IT Supporter", applied_on: "2026-10-03", art: "persoenlich", pensum: "80%", notes: null, url: null } });
    const q = parseExternArgs("A; B; 2026-10-05; Telefonisch", NOW, "Europe/Zurich");
    expect(q.ok && q.value).toMatchObject({ applied_on: "2026-10-05", art: "telefonisch", pensum: null });
  });

  it("Standardwerte: heute in Zürich-Zeit, elektronisch; speichert und bestätigt mit Kennung", async () => {
    const { env, raw } = makeEnv();
    const f = mockFetch();
    await handleUpdate(env, msg("/extern Muster AG; IT Supporter"), undefined, NOW);
    expect(raw.prepare("SELECT id, applied_on, company, role, art, pensum, result FROM external_applications").get()).toEqual({
      id: 1, applied_on: "2026-11-01", company: "Muster AG", role: "IT Supporter", art: "elektronisch", pensum: null, result: "offen",
    });
    const t = tgTexts(f)[0];
    expect(t).toContain("Kennung <b>e1</b>");
    expect(t).toContain("01.11.2026, elektronisch");
  });

  it("fehlende Stelle, unbekannte Art oder falsches Datum: Hilfe mit Beispiel, nichts gespeichert", async () => {
    const { env, raw } = makeEnv();
    const f = mockFetch();
    await handleUpdate(env, msg("/extern Muster AG"), undefined, NOW);
    await handleUpdate(env, msg("/extern"), undefined, NOW);
    await handleUpdate(env, msg("/extern A; B; ; Brieftaube"), undefined, NOW);
    await handleUpdate(env, msg("/extern A; B; 31.02.2026"), undefined, NOW);
    const texts = tgTexts(f);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain("mindestens Firma und Stelle");
    for (const t of texts) expect(t).toContain("/extern Muster AG; Produktionsmitarbeiterin; 03.10.2026; elektronisch; 80%; https://link-zum-inserat");
    expect(texts[2]).toContain("Brieftaube");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM external_applications").get()!.n).toBe(0);
  });
});

describe("/ergebnis", () => {
  it("setzt result für Bewerbung, Portal-Tipp und externe Bewerbung", async () => {
    const { env, raw } = makeEnv();
    insertApp(raw, { id: "2026-10-01-acme", company: "Acme AG", status: "sent" });
    raw.prepare("INSERT INTO portal_tips (id, created_at, company, role) VALUES ('ab12cd34', 'x', 'Portal AG', 'R')").run();
    raw.prepare("INSERT INTO external_applications (created_at, applied_on, company, role, art) VALUES ('x', '2026-10-02', 'Ext AG', 'R', 'telefonisch')").run();
    const f = mockFetch();
    await handleUpdate(env, msg("/ergebnis 2026-10-01-acme einladung"));
    await handleUpdate(env, msg("/ergebnis ab12cd34 Absage"));
    await handleUpdate(env, msg("/ergebnis e1 anstellung"));
    await handleUpdate(env, msg("/ergebnis e99 absage"));
    await handleUpdate(env, msg("/ergebnis e1 vielleicht"));
    expect(raw.prepare("SELECT result FROM applications").get()!.result).toBe("einladung");
    expect(raw.prepare("SELECT result FROM portal_tips").get()!.result).toBe("absage");
    expect(raw.prepare("SELECT result FROM external_applications").get()!.result).toBe("anstellung");
    const t = tgTexts(f);
    expect(t[0]).toContain("Acme AG");
    expect(t[2]).toContain("Anstellung");
    expect(t[3]).toContain("nicht gefunden");
    expect(t[4]).toContain("Bitte so");
  });
});

describe("GET /api/rav und /rav", () => {
  function seed(raw: DatabaseSync) {
    // 2026-10-31T23:30Z ist in Zürich der 01.11. (Winterzeit, UTC+1)
    insertApp(raw, { id: "nov1", company: "Nov AG", company_domain: "nov.ch", to_email: "hr@nov.ch", to_name: "Herr Nov", status: "sent", sent_at: "2026-10-31T23:30:00.000Z" });
    raw.prepare("UPDATE applications SET pensum = '100%', company_address = 'Weg 1', contact_phone = '044' WHERE id = 'nov1'").run();
    insertApp(raw, { id: "okt", company: "Okt AG", company_domain: "okt.ch", status: "sent", sent_at: "2026-10-31T22:59:00.000Z" });
    insertApp(raw, { id: "nov30", company: "Ende AG", company_domain: "ende.ch", status: "sent", sent_at: "2026-11-30T22:59:00.000Z" });
    insertApp(raw, { id: "dez", company: "Dez AG", company_domain: "dez.ch", status: "sent", sent_at: "2026-11-30T23:00:00.000Z" });
    insertApp(raw, { id: "nicht_sent", company: "X", company_domain: "x.ch", status: "failed", sent_at: "2026-11-05T08:00:00.000Z" });
    raw.prepare("INSERT INTO portal_tips (id, created_at, company, role, status, applied_at, pensum) VALUES ('p1', 'x', 'Portal AG', 'Dev', 'applied_by_user', '2026-11-10T09:00:00.000Z', '80%')").run();
    raw.prepare("INSERT INTO portal_tips (id, created_at, company, role, status, applied_at) VALUES ('p2', 'x', 'Neu AG', 'Dev', 'new', '2026-11-10T09:00:00.000Z')").run();
    raw.prepare("INSERT INTO external_applications (created_at, applied_on, company, role, art, result) VALUES ('x', '2026-11-03', 'Ext AG', 'Support', 'persoenlich', 'absage')").run();
    raw.prepare("INSERT INTO external_applications (created_at, applied_on, company, role, art) VALUES ('x', '2026-10-30', 'Alt AG', 'Support', 'schriftlich')").run();
  }

  it("liefert den Zürich-Kalendermonat, nur sent / applied_by_user, sortiert, mit allen Feldern", async () => {
    const { env, raw } = makeEnv();
    seed(raw);
    const res = await worker.fetch(api("/api/rav?month=2026-11"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: string; entries: Record<string, unknown>[] };
    expect(body.month).toBe("2026-11");
    expect(body.entries.map((e) => `${e.source}:${e.id}:${e.date}`)).toEqual([
      "agent:nov1:2026-11-01",
      "extern:e1:2026-11-03",
      "portal:p1:2026-11-10",
      "agent:nov30:2026-11-30",
    ]);
    expect(body.entries[0]).toEqual({
      source: "agent", id: "nov1", date: "2026-11-01", company: "Nov AG", company_address: "Weg 1", contact_name: "Herr Nov",
      contact_email: "hr@nov.ch", contact_phone: "044", role: "Rolle", pensum: "100%", art: "elektronisch (E-Mail)", result: "offen",
      job_url: null, ad_key: null, letter_text: expect.any(String), letter_key: null,
    });
    expect(body.entries[1]).toMatchObject({ art: "persönlich", result: "absage", contact_email: null, company_address: null });
    expect(body.entries[2]).toMatchObject({ art: "elektronisch (Portal)", pensum: "80%", contact_name: null });
  });

  it("ungültiger oder fehlender month: 400; ohne Token: 401", async () => {
    const { env } = makeEnv();
    expect((await worker.fetch(api("/api/rav?month=2026-13"), env, ctx)).status).toBe(400);
    expect((await worker.fetch(api("/api/rav"), env, ctx)).status).toBe(400);
    expect((await worker.fetch(new Request("https://w.example/api/rav?month=2026-11"), env, ctx)).status).toBe(401);
  });

  it("Monatsgrenzen auch über den Sommerzeit-Wechsel", () => {
    const b = monthBoundsUtc("2026-10", "Europe/Zurich");
    expect(b.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("/rav zeigt die Einträge des laufenden Monats aufgeteilt", async () => {
    const { env, raw } = makeEnv();
    seed(raw);
    const f = mockFetch();
    await handleUpdate(env, msg("/rav"), undefined, new Date("2026-11-15T10:00:00Z"));
    const t = tgTexts(f)[0];
    expect(t).toContain("RAV-Nachweis November 2026</b>: bisher 4 Einträge");
    expect(t).toContain("Agent (per E-Mail versendet): 2");
    expect(t).toContain("Portal (selbst beworben): 1");
    expect(t).toContain("Extern erfasst: 1");
  });
});

describe("POST /api/rav-report", () => {
  const ravMime = (to = "Max Muster <max.muster@example.com>", extra = "") =>
    [
      'From: "Max Muster" <max.muster@example.com>',
      `To: ${to}`,
      ...(extra ? [extra] : []),
      "Subject: RAV-Liste Oktober 2026",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Anbei die Liste.",
      "",
    ].join("\r\n");

  function form(opts: { mime?: string; meta?: Record<string, unknown>; pdf?: boolean } = {}) {
    const fd = new FormData();
    fd.append("meta", JSON.stringify({ month: "2026-10", subject: "RAV-Liste Oktober 2026", count: 12, ...opts.meta }));
    fd.append("mime", new File([opts.mime ?? ravMime()], "rav.eml", { type: "message/rfc822" }));
    if (opts.pdf !== false) fd.append("pdf", new File(["%PDF-1.4 rav"], "RAV_Oktober_2026.pdf", { type: "application/pdf" }));
    return fd;
  }
  const post = (env: ReturnType<typeof makeEnv>["env"], fd: FormData) =>
    worker.fetch(api("/api/rav-report", { method: "POST", body: fd }), env, ctx);

  it("Erfolg: sendet über Gmail (mit Date-Header) und meldet per Telegram mit PDF", async () => {
    const { env, raw } = makeEnv();
    const f = mockFetch();
    const res = await post(env, form());
    expect(res.status).toBe(200);
    const gmail = f.calls.filter((c) => c.url.includes("/messages/send"));
    expect(gmail).toHaveLength(1);
    expect(String(gmail[0].body)).toMatch(/^Date: .+\r\nFrom: "Max Muster"/);
    expect(String(gmail[0].body)).toContain("Anbei die Liste.");
    const tg = f.telegram();
    expect(tg.map((c) => c.url.split("/").pop())).toEqual(["sendMessage", "sendDocument"]);
    expect((tg[0].body as { text: string }).text).toBe(
      "📋 RAV-Liste Oktober 2026 ist in deinem Postfach (12 Einträge). Du kannst sie direkt ans RAV weiterleiten.",
    );
    const stored = JSON.parse(String(raw.prepare("SELECT value FROM settings WHERE key = 'rav_sent_2026-10'").get()!.value));
    expect(stored).toMatchObject({ gmail_message_id: "msg123", count: 12 });
  });

  it("falscher Empfänger, zusätzliche Adresse oder Cc an Dritte: 422, nichts gesendet", async () => {
    const { env } = makeEnv();
    const f = mockFetch();
    expect((await post(env, form({ mime: ravMime("rav@arbeit.ch") }))).status).toBe(422);
    expect((await post(env, form({ mime: ravMime("max.muster@example.com, rav@arbeit.ch") }))).status).toBe(422);
    expect((await post(env, form({ mime: ravMime("max.muster@example.com.evil.ch") }))).status).toBe(422);
    expect((await post(env, form({ mime: ravMime(undefined, "Cc: rav@arbeit.ch") }))).status).toBe(422);
    expect(f.calls).toHaveLength(0);
  });

  it("Doppelversand im selben Monat: 409, mit force erneut möglich", async () => {
    const { env } = makeEnv();
    const f = mockFetch();
    expect((await post(env, form())).status).toBe(200);
    const again = await post(env, form());
    expect(again.status).toBe(409);
    expect(f.calls.filter((c) => c.url.includes("/messages/send"))).toHaveLength(1);
    expect((await post(env, form({ meta: { force: true }, pdf: false }))).status).toBe(200);
    expect(f.calls.filter((c) => c.url.includes("/messages/send"))).toHaveLength(2);
    // anderer Monat ist unabhängig
    expect((await post(env, form({ meta: { month: "2026-11" } }))).status).toBe(200);
  });

  it("ungültiger month oder count: 400; Gmail-Fehler: 502 und ein neuer Versuch bleibt möglich", async () => {
    const { env, raw } = makeEnv();
    let fail = true;
    const f = mockFetch((url) => (fail && url.includes("/messages/send") ? new Response("boom", { status: 500 }) : undefined));
    expect((await post(env, form({ meta: { month: "10-2026" } }))).status).toBe(400);
    expect((await post(env, form({ meta: { count: "zwölf" } }))).status).toBe(400);
    expect((await post(env, form())).status).toBe(502);
    expect(tgTexts(f).some((t) => t.includes("Fehler: rav-report"))).toBe(true);
    expect(raw.prepare("SELECT value FROM settings WHERE key = 'rav_sent_2026-10'").get()).toBeUndefined();
    fail = false;
    expect((await post(env, form())).status).toBe(200);
  });
});


describe("Inserat-Screenshots und Links", () => {
  const NOW = new Date("2026-11-03T06:00:00Z");
  it("/extern mit Link speichert die URL", async () => {
    const p = parseExternArgs("A AG; Rolle; 03.10.2026; portal; 50%; https://jobs.ch/x; Notiz", NOW, "Europe/Zurich");
    expect(p.ok && p.value).toMatchObject({ url: "https://jobs.ch/x", notes: "Notiz", art: "portal" });
  });
  it("Bewerbung mit ad-Datei legt Screenshot ohne Ablauf ab, /api/rav nennt Link und Key, /api/file liefert ihn", async () => {
    const { env, kv } = makeEnv();
    mockFetch();
    const form = makeForm(sampleMeta({ job_url: "https://jobs.ch/inserat" }));
    form.append("ad", new File(["%PDF-ad"], "inserat.pdf", { type: "application/pdf" }));
    const r = await createApplication(env, form, NOW);
    expect(r.status).toBe(201);
    const id = (r.body as { id: string }).id;
    expect(kv.store.has(`ad/${id}`)).toBe(true);
    const bad = await worker.fetch(api("/api/file?key=mime/" + id), env, ctx);
    expect(bad.status).toBe(400);
    const ok = await worker.fetch(api("/api/file?key=ad/" + id), env, ctx);
    expect(ok.status).toBe(200);
  });
});

describe("POST /api/rav-draft", () => {
  const mime = (to = "Max Muster <max.muster@example.com>") =>
    ["From: x <max.muster@example.com>", `To: ${to}`, "Subject: Bewerbungen Oktober 2026", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Entwurf.", ""].join("\r\n");
  const form = (to?: string, meta: Record<string, unknown> = {}) => {
    const fd = new FormData();
    fd.append("meta", JSON.stringify({ month: "2026-10", count: 3, ...meta }));
    fd.append("mime", new File([mime(to)], "d.eml", { type: "message/rfc822" }));
    return fd;
  };
  const post = (env: ReturnType<typeof makeEnv>["env"], fd: FormData) =>
    worker.fetch(api("/api/rav-draft", { method: "POST", body: fd }), env, ctx);

  it("legt einen Entwurf an (sendet nichts), nur einmal pro Monat, nur an die eigene Adresse", async () => {
    const { env } = makeEnv();
    const f = mockFetch();
    expect((await post(env, form("rav@arbeit.ch"))).status).toBe(422);
    expect(f.calls).toHaveLength(0);
    expect((await post(env, form())).status).toBe(200);
    expect(f.calls.filter((c) => c.url.includes("/drafts"))).toHaveLength(1);
    expect(f.calls.filter((c) => c.url.includes("/messages/send"))).toHaveLength(0);
    expect((await post(env, form())).status).toBe(409);
    expect((await post(env, form(undefined, { force: true }))).status).toBe(200);
  });
});

describe("POST /api/rav-draft ohne Scope", () => {
  it("403 von Gmail: 502, mit fallback_mail als normale Mail an sich selbst", async () => {
    const { env } = makeEnv();
    const f = mockFetch((url) => (url.includes("/drafts") ? new Response("no scope", { status: 403 }) : undefined));
    const mk = (meta: Record<string, unknown>) => {
      const fd = new FormData();
      fd.append("meta", JSON.stringify({ month: "2026-10", count: 2, ...meta }));
      fd.append("mime", new File(["From: x <max.muster@example.com>\r\nTo: max.muster@example.com\r\nSubject: s\r\n\r\nb\r\n"], "d.eml"));
      return fd;
    };
    const go = (meta: Record<string, unknown>) => worker.fetch(api("/api/rav-draft", { method: "POST", body: mk(meta) }), env, ctx);
    expect((await go({})).status).toBe(502);
    const ok = await go({ fallback_mail: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { mode: string }).mode).toBe("mail");
    expect(f.calls.filter((c) => c.url.includes("/messages/send"))).toHaveLength(1);
  });
});
