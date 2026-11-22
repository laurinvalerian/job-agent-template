import { afterEach, describe, expect, it, vi } from "vitest";
import { containsForbiddenDash, createApplication, createPortalTip, claimRun, getDoneToday, getState, putCheckpoint, initialStatus, isPlausibleEmail, MAX_MIME_BYTES, readableAttachmentNames, setRoutineNote, validateMeta } from "../src/queue";
import { insertApp, makeEnv, makeForm, mockFetch, sampleMeta, sampleMime } from "./helpers";

afterEach(() => vi.unstubAllGlobals());
const NOW = new Date("2026-11-03T06:00:00Z");
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

describe("Dash-Validierung", () => {
  it("erkennt Em- und En-Dash, erlaubt normalen Bindestrich", () => {
    expect(containsForbiddenDash(`a ${EM} b`)).toBe(true);
    expect(containsForbiddenDash(`2020${EN}2024`)).toBe(true);
    expect(containsForbiddenDash("IT-Supporter, 2020-2024")).toBe(false);
  });

  it("lehnt subject oder body_text in meta mit 422 ab", () => {
    const s = validateMeta(sampleMeta({ subject: `Bewerbung ${EM} IT` }));
    const b = validateMeta(sampleMeta({ body_text: `Hallo ${EN} Welt` }));
    expect(s.ok || s.status).toBe(422);
    expect(b.ok || b.status).toBe(422);
  });

  it("über die API ebenfalls 422 und nichts gespeichert, auch bei Dash nur im MIME-Subject", async () => {
    const { env, raw, kv } = makeEnv();
    mockFetch();
    expect((await createApplication(env, makeForm(sampleMeta({ body_text: `x ${EM} y` })), NOW)).status).toBe(422);
    const r = await createApplication(env, makeForm(sampleMeta(), sampleMime({ subject: "=?utf-8?q?Bewerbung_=E2=80=94_IT?=" })), NOW);
    expect(r.status).toBe(422);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM applications").get()!.n).toBe(0);
    expect(kv.store.size).toBe(0);
  });
});

describe("Weitere Validierung", () => {
  it("prüft to_email", () => {
    expect(isPlausibleEmail("jobs@acme.ch")).toBe(true);
    expect(isPlausibleEmail("jobs@acme")).toBe(false);
    expect(isPlausibleEmail("jobs acme.ch")).toBe(false);
    const r = validateMeta(sampleMeta({ to_email: "kaputt" }));
    expect(r.ok || r.status).toBe(422);
  });

  it("To-Header der Nachricht muss meta.to_email enthalten", async () => {
    const { env } = makeEnv();
    mockFetch();
    const r = await createApplication(env, makeForm(sampleMeta(), sampleMime({ to: "falsch@andere.ch" })), NOW);
    expect(r.status).toBe(422);
    expect((r.body as { error: string }).error).toContain("To-Header");
  });

  it("mime muss vorhanden und unter 15 MB sein, meta muss JSON sein", async () => {
    const { env } = makeEnv();
    mockFetch();
    expect((await createApplication(env, makeForm(sampleMeta(), null), NOW)).status).toBe(400);
    expect((await createApplication(env, makeForm("{kein json"), NOW)).status).toBe(400);
    const big = sampleMime() + "x".repeat(MAX_MIME_BYTES);
    expect((await createApplication(env, makeForm(sampleMeta(), big), NOW)).status).toBe(413);
  });
});

describe("Dedup (180 Tage pro company_domain)", () => {
  it("blockiert zweite Bewerbung an dieselbe Domain mit 409", async () => {
    const { env } = makeEnv();
    mockFetch();
    expect((await createApplication(env, makeForm(), NOW)).status).toBe(201);
    const second = await createApplication(env, makeForm(sampleMeta({ id: "2026-11-04-acme", company_domain: "www.ACME.ch" })), NOW);
    expect(second.status).toBe(409);
  });

  it("gleiche id ergibt 409", async () => {
    const { env } = makeEnv();
    mockFetch();
    await createApplication(env, makeForm(), NOW);
    expect((await createApplication(env, makeForm(sampleMeta({ company_domain: "other.ch" })), NOW)).status).toBe(409);
  });

  it("verworfene oder fehlgeschlagene Bewerbungen blockieren nicht", async () => {
    const { env, raw } = makeEnv();
    mockFetch();
    insertApp(raw, { id: "old1", company_domain: "acme.ch", status: "rejected_by_user", created_at: "2026-10-01T00:00:00.000Z" });
    insertApp(raw, { id: "old2", company_domain: "acme.ch", status: "failed", created_at: "2026-10-02T00:00:00.000Z" });
    expect((await createApplication(env, makeForm(), NOW)).status).toBe(201);
  });

  it("nach 180 Tagen ist die Domain wieder frei, sending blockiert", async () => {
    const { env, raw } = makeEnv();
    mockFetch();
    insertApp(raw, { id: "old", company_domain: "acme.ch", status: "sent", created_at: "2026-05-01T00:00:00.000Z" });
    expect((await createApplication(env, makeForm(), NOW)).status).toBe(201);
    insertApp(raw, { id: "recent", company_domain: "beta.ch", status: "sending", created_at: "2026-05-08T00:00:00.000Z" });
    const r = await createApplication(env, makeForm(sampleMeta({ id: "b", company_domain: "beta.ch", to_email: "a@beta.ch" }), sampleMime({ to: "a@beta.ch" })), NOW);
    expect(r.status).toBe(409);
  });
});

describe("Status nach Modus und Speicherung", () => {
  it("initialStatus", () => {
    expect(initialStatus({ mode: "trial", paused: false })).toBe("pending_approval");
    expect(initialStatus({ mode: "auto", paused: false })).toBe("scheduled");
    expect(initialStatus({ mode: "auto", paused: true })).toBe("pending_approval");
  });

  it("trial: Vorschau, PDF als Dokument, Buttons, Nachricht roh in KV", async () => {
    const { env, raw, kv } = makeEnv();
    const f = mockFetch();
    const r = await createApplication(env, makeForm(), NOW);
    expect(r.body).toEqual({ id: "2026-11-03-acme", status: "pending_approval" });
    const tg = f.telegram();
    expect(tg.map((c) => c.url.split("/").pop())).toEqual(["sendMessage", "sendDocument", "sendMessage"]);
    expect((tg[0].body as { text: string }).text).toContain("Anschreiben_Max_Muster.pdf, Lebenslauf.pdf");
    const doc = tg[1].body as FormData;
    expect((doc.get("document") as File).name).toBe("Anschreiben_Max_Muster.pdf");
    const buttons = (tg[2].body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual(["approve_now:2026-11-03-acme", "approve:2026-11-03-acme", "reject:2026-11-03-acme"]);
    expect(buttons[0].text).toBe("📤 Sofort senden");

    const stored = kv.store.get("mime/2026-11-03-acme");
    expect(stored).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(stored as ArrayBuffer)).toBe(sampleMime());
    const keys = JSON.parse(raw.prepare("SELECT attachment_keys FROM applications").get()!.attachment_keys as string);
    expect(keys).toEqual({ mime_key: "mime/2026-11-03-acme", mime_size: sampleMime().length, attachment_names: ["Anschreiben_Max_Muster.pdf", "Lebenslauf.pdf"] });
  });

  it("ohne preview kein Dokument", async () => {
    const { env } = makeEnv();
    const f = mockFetch();
    await createApplication(env, makeForm(sampleMeta(), sampleMime(), false), NOW);
    expect(f.telegram().map((c) => c.url.split("/").pop())).toEqual(["sendMessage", "sendMessage"]);
  });

  it("auto: scheduled und nur kurze Info", async () => {
    const { env, raw } = makeEnv();
    raw.prepare("UPDATE settings SET value = 'auto' WHERE key = 'mode'").run();
    const f = mockFetch();
    const r = await createApplication(env, makeForm(), NOW);
    expect((r.body as { status: string }).status).toBe("scheduled");
    expect(f.telegram()).toHaveLength(1);
  });
});

describe("Beilagen und HSLU in der Vorschau", () => {
  const NAMES = [
    "Anschreiben_Max_Muster_acme.pdf",
    "Lebenslauf_Max_Muster.pdf",
    "Arbeitszeugnisse_Max_Muster.pdf",
    "Microsoft_Zertifikate_Max_Muster.pdf",
    "SPARC_Zertifikate_Max_Muster.pdf",
    "Aufnahmebestaetigung_HSLU_Max_Muster.pdf",
  ];

  it("lesbare Namen ohne Präfix, ohne Lebenslauf die vollen Namen", () => {
    expect(readableAttachmentNames(NAMES)).toEqual([
      "Anschreiben", "Lebenslauf", "Arbeitszeugnisse", "Microsoft Zertifikate", "SPARC Zertifikate", "Aufnahmebestaetigung HSLU",
    ]);
    expect(readableAttachmentNames(["a.pdf", "b.pdf"])).toEqual(["a.pdf", "b.pdf"]);
  });

  it("englische Namen ebenso lesbar", () => {
    expect(readableAttachmentNames([
      "Cover_Letter_Max_Muster_Acme.pdf", "CV_Max_Muster.pdf", "References_Max_Muster.pdf", "HSLU_Admission_Max_Muster.pdf",
    ])).toEqual(["Cover Letter", "CV", "References", "HSLU Admission"]);
  });

  it("nennt was mitgeht, HSLU mit Grund, speichert hslu", async () => {
    const { env, raw } = makeEnv();
    const f = mockFetch();
    const meta = sampleMeta({ attachment_names: NAMES, hslu: { attach: true, reason: "Teilzeit neben dem Studium" } });
    expect((await createApplication(env, makeForm(meta), NOW)).status).toBe(201);
    const text = (f.telegram()[0].body as { text: string }).text;
    expect(text).toContain("<b>Mitgeschickt werden:</b> Anschreiben, Lebenslauf, Arbeitszeugnisse, Microsoft Zertifikate, SPARC Zertifikate, Aufnahmebestaetigung HSLU");
    expect(text).toContain("<b>HSLU-Bestätigung:</b> beigelegt (Teilzeit neben dem Studium)");
    expect(text).toContain("Unten zur Ansicht nur das Anschreiben, alles andere geht automatisch mit der Mail mit.");
    expect(text).not.toContain("Anhänge:");
    expect(JSON.parse(raw.prepare("SELECT hslu FROM applications").get()!.hslu as string)).toEqual({ attach: true, reason: "Teilzeit neben dem Studium" });
  });

  it("nicht beigelegt, ohne hslu keine Zeile und Spalte null", async () => {
    const { env, raw } = makeEnv();
    let f = mockFetch();
    await createApplication(env, makeForm(sampleMeta({ hslu: { attach: false, reason: "Vollzeitstelle" } })), NOW);
    expect((f.telegram()[0].body as { text: string }).text).toContain("<b>HSLU-Bestätigung:</b> nicht beigelegt (Vollzeitstelle)");
    f = mockFetch();
    await createApplication(env, makeForm(sampleMeta({ id: "b", company_domain: "b.ch" })), NOW);
    expect((f.telegram()[0].body as { text: string }).text).not.toContain("HSLU");
    expect(raw.prepare("SELECT hslu FROM applications WHERE id = 'b'").get()!.hslu).toBeNull();
  });

  it("hslu wird validiert", () => {
    expect(validateMeta(sampleMeta({ hslu: { attach: "ja", reason: "x" } })).ok).toBe(false);
    expect(validateMeta(sampleMeta({ hslu: "ja" })).ok).toBe(false);
    const d = validateMeta(sampleMeta({ hslu: { attach: true, reason: `a ${EM} b` } }));
    expect(d.ok || d.status).toBe(422);
  });

  it("preview_cv kommt als zweites Dokument nach dem Anschreiben", async () => {
    const { env } = makeEnv();
    const f = mockFetch();
    const form = makeForm();
    form.append("preview_cv", new File(["%PDF-1.4 cv"], "Lebenslauf_Person B.pdf", { type: "application/pdf" }));
    await createApplication(env, form, NOW);
    const tg = f.telegram();
    expect(tg.map((c) => c.url.split("/").pop())).toEqual(["sendMessage", "sendDocument", "sendDocument", "sendMessage"]);
    expect(((tg[2].body as FormData).get("document") as File).name).toBe("Lebenslauf_Person B.pdf");
    expect((tg[0].body as { text: string }).text).toContain("nur das Anschreiben und der angepasste Lebenslauf");
  });
});

describe("GET /api/state", () => {
  it("liefert ungelesenes Feedback einmal und markiert es als gelesen", async () => {
    const { env, raw } = makeEnv();
    raw.prepare("INSERT INTO feedback (created_at, text) VALUES (?, ?)").run(NOW.toISOString(), "Weniger Grossfirmen");
    await createPortalTip(env, { company: "Beta AG", role: "Support" }, NOW);
    const first = (await getState(env, NOW)).body as { feedback: unknown[]; portal_tips: unknown[]; stats: { sent_total: number } };
    expect(first.feedback).toHaveLength(1);
    expect(first.portal_tips).toHaveLength(1);
    expect(first.stats.sent_total).toBe(0);
    const second = (await getState(env, NOW)).body as { feedback: unknown[] };
    expect(second.feedback).toHaveLength(0);
  });
});

describe("GET /api/done-today", () => {
  it("erst nach der Notiz von heute fertig, Feedback bleibt ungelesen", async () => {
    const { env, raw } = makeEnv();
    raw.prepare("INSERT INTO feedback (created_at, text) VALUES (?, ?)").run(NOW.toISOString(), "Mehr Druckereien");
    expect((await getDoneToday(env, NOW)).body).toEqual({ done: false, date: "2026-11-03" });
    await setRoutineNote(env, { text: "Heute 2 Bewerbungen" }, NOW);
    expect((await getDoneToday(env, NOW)).body).toMatchObject({ done: true });
    expect((await getDoneToday(env, new Date("2026-11-04T06:00:00Z"))).body).toMatchObject({ done: false });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM feedback WHERE read_at IS NULL").get()!.n).toBe(1);
  });
});

describe("initialStatus mit gesperrter Automatik", () => {
  it("bleibt pending_approval, auch wenn mode auto ist", () => {
    expect(initialStatus({ mode: "auto", paused: false }, false)).toBe("pending_approval");
    expect(initialStatus({ mode: "auto", paused: false }, true)).toBe("scheduled");
  });
});

describe("Zwischenstand", () => {
  it("wird gespeichert und mit der Abschluss-Notiz gelöscht", async () => {
    const { env, kv } = makeEnv();
    expect((await putCheckpoint(env, new ArrayBuffer(0), NOW)).status).toBe(400);
    expect((await putCheckpoint(env, new Uint8Array([1, 2, 3]).buffer, NOW)).status).toBe(200);
    expect(kv.store.has("checkpoint")).toBe(true);
    await setRoutineNote(env, { text: "fertig" }, NOW);
    expect(kv.store.has("checkpoint")).toBe(false);
  });
});

describe("Anmeldung eines Laufs", () => {
  const at = (min: number) => new Date(NOW.getTime() + min * 60000);
  const state = async (env: Parameters<typeof claimRun>[0], d: Date) => (await claimRun(env, d)).body;

  it("nur ein Lauf gleichzeitig, Zwischenstand verlängert, nach 90 Minuten Stille wieder frei", async () => {
    const { env } = makeEnv();
    expect(await state(env, NOW)).toEqual({ state: "claimed" });
    expect(await state(env, at(30))).toEqual({ state: "running" });
    await putCheckpoint(env, new Uint8Array([1]).buffer, at(80));
    expect(await state(env, at(120))).toEqual({ state: "running" });
    expect(await state(env, at(171))).toEqual({ state: "claimed" });
  });

  it("nach der Abschluss-Notiz: heute erledigt", async () => {
    const { env } = makeEnv();
    await claimRun(env, NOW);
    await setRoutineNote(env, { text: "fertig" }, at(40));
    expect(await state(env, at(60))).toEqual({ state: "done" });
    expect(await state(env, new Date("2026-11-04T06:00:00Z"))).toEqual({ state: "claimed" });
  });
});
