import { afterEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../src/bot";
import { createPortalTip, openPortalTips, portalText, resendPortalTips } from "../src/queue";
import { makeEnv, mockFetch } from "./helpers";

afterEach(() => vi.unstubAllGlobals());
const NOW = new Date("2026-09-26T12:00:00Z");

function packageForm(meta: Record<string, unknown>, files: [string, string][] = [["Anschreiben.pdf", "%PDF-1 a"], ["Lebenslauf.pdf", "%PDF-1 b"]]) {
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  files.forEach(([name, body], i) => form.append(`file_${i}`, new File([body], name, { type: "application/pdf" })));
  return form;
}

describe("Portal-Pakete", () => {
  it("speichert Dateien in KV und schickt Paket sofort per Telegram", async () => {
    const { env, raw, kv } = makeEnv();
    const f = mockFetch();
    const r = await createPortalTip(env, undefined, NOW, packageForm({ company: "Zuger Polizei", role: "Praktikum Forensik", url: "https://x.ch/1", why: "Security-Praxis", notes: "HSLU betonen" }));
    expect(r.status).toBe(201);
    const id = (r.body as { id: string }).id;
    const row = raw.prepare("SELECT * FROM portal_tips WHERE id = ?").get(id)!;
    expect(row.status).toBe("new");
    expect(JSON.parse(String(row.files)).map((x: { name: string }) => x.name)).toEqual(["Anschreiben.pdf", "Lebenslauf.pdf"]);
    expect(kv.store.size).toBe(2);
    const tg = f.telegram().map((c) => c.url.split("/").pop());
    expect(tg).toEqual(["sendMessage", "sendDocument", "sendDocument", "sendMessage"]);
    const last = f.telegram().at(-1)!.body as { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
    expect(last.reply_markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual([`tip_applied:${id}`, `tip_dismiss:${id}`]);
  });

  it("JSON ohne Dateien geht weiterhin und meldet sich ebenfalls sofort", async () => {
    const { env } = makeEnv();
    const f = mockFetch();
    const r = await createPortalTip(env, { company: "KPMG", role: "Werkstudent" }, NOW);
    expect(r.status).toBe(201);
    expect(f.telegram().length).toBe(2);
  });

  it("lehnt Gedankenstriche ab", async () => {
    const { env } = makeEnv();
    mockFetch();
    const r = await createPortalTip(env, { company: "A", role: "B", why: `x ${String.fromCharCode(0x2014)} y` }, NOW);
    expect(r.status).toBe(422);
  });

  it("Button Beworben setzt Status und Zeitpunkt, zählt nicht als Bewerbung", async () => {
    const { env, raw } = makeEnv();
    mockFetch();
    const id = ((await createPortalTip(env, { company: "A", role: "B" }, NOW)).body as { id: string }).id;
    await handleUpdate(env, { update_id: 1, callback_query: { id: "cq", data: `tip_applied:${id}`, message: { message_id: 7, chat: { id: 4242 } } } }, undefined, NOW);
    const row = raw.prepare("SELECT status, applied_at FROM portal_tips WHERE id = ?").get(id)!;
    expect(row.status).toBe("applied_by_user");
    expect(row.applied_at).toBe(NOW.toISOString());
    expect(raw.prepare("SELECT COUNT(*) AS n FROM applications").get()!.n).toBe(0);
  });

  it("Text nennt Link, Frist und dass es nicht mitzählt", () => {
    const t = portalText({ id: "x", company: "A & B", role: "R", url: "https://a.ch", why: "w", deadline: "15.10.", notes: "n" }, 3);
    expect(t).toContain("A &amp; B");
    expect(t).toContain("Zählt nicht als Bewerbung");
    expect(t).toContain("Frist:");
  });

  it("nur Anschreiben: Upload-Hinweis und HSLU Ja/Nein mit Grund", () => {
    const base = { id: "x", company: "K", role: "R", url: null, why: null, deadline: null, notes: null };
    const ja = portalText({ ...base, hslu: JSON.stringify({ attach: true, reason: "Praktikum mit Studium" }) }, 1);
    expect(ja).toContain("Lade das Anschreiben herunter und häng es im Portal an. Lebenslauf, Zeugnisse und Zertifikate hast du selbst.");
    expect(ja).toContain("📎 HSLU-Bestätigung anhängen: <b>Ja</b> (Praktikum mit Studium)");
    const nein = portalText({ ...base, hslu: JSON.stringify({ attach: false, reason: "Vollzeit" }) }, 1);
    expect(nein).toContain("<b>Nein</b> (Vollzeit)");
    const cv = portalText(base, 2);
    expect(cv).toContain("Anschreiben und den angepassten Lebenslauf");
    expect(cv).not.toContain("HSLU");
  });

  it("alte Tipps ohne hslu und mit Vollpaket bleiben lesbar", () => {
    const base = { id: "x", company: "K", role: "R", url: null, why: null, deadline: null, notes: null };
    expect(portalText({ ...base, hslu: null }, 3)).toContain("Alles Nötige ist unten angehängt.");
    expect(portalText({ ...base, hslu: "kaputt" }, 0)).toContain("Noch keine Dateien zu diesem Tipp.");
    expect(portalText(base, 0)).not.toContain("HSLU");
  });

  it("speichert hslu und zeigt es auch beim erneuten Schicken", async () => {
    const { env, raw } = makeEnv();
    mockFetch();
    const r = await createPortalTip(
      env, undefined, NOW,
      packageForm({ company: "KastGroup", role: "Praktikum", hslu: { attach: true, reason: "Praktikum mit Studium" } }, [["Anschreiben.pdf", "%PDF-1 a"]]),
    );
    expect(r.status).toBe(201);
    const id = (r.body as { id: string }).id;
    expect(JSON.parse(String(raw.prepare("SELECT hslu FROM portal_tips WHERE id = ?").get(id)!.hslu))).toEqual({ attach: true, reason: "Praktikum mit Studium" });
    const f = mockFetch();
    await resendPortalTips(env, await openPortalTips(env, id));
    const text = (f.telegram()[0].body as { text: string }).text;
    expect(text).toContain("<b>Ja</b> (Praktikum mit Studium)");
    expect(text).toContain("Lade das Anschreiben herunter");
    expect(f.telegram().map((c) => c.url.split("/").pop())).toEqual(["sendMessage", "sendDocument", "sendMessage"]);
  });

  it("ungültiges hslu wird abgelehnt", async () => {
    const { env } = makeEnv();
    mockFetch();
    expect((await createPortalTip(env, { company: "A", role: "B", hslu: { attach: "ja" } }, NOW)).status).toBe(400);
  });
});

describe("Portal-Pakete nochmals schicken", () => {
  it("/portal bestätigt sofort und schickt jedes offene Paket samt Dateien", async () => {
    const { env } = makeEnv();
    mockFetch();
    await createPortalTip(env, undefined, NOW, packageForm({ company: "A AG", role: "R" }));
    await createPortalTip(env, undefined, NOW, packageForm({ company: "B AG", role: "R" }));
    const f = mockFetch();
    const pending: Promise<unknown>[] = [];
    await handleUpdate(env, { update_id: 2, message: { message_id: 1, chat: { id: 4242 }, text: "/portal" } }, { waitUntil: (p) => pending.push(p) }, NOW);
    expect((f.telegram()[0].body as { text: string }).text).toContain("Schicke 2 Portal-Pakete");
    await Promise.all(pending);
    const tg = f.telegram().map((c) => c.url.split("/").pop());
    expect(tg.filter((m) => m === "sendDocument")).toHaveLength(4);
    expect(tg).toHaveLength(1 + 2 * 4);
  });

  it("ein fehlgeschlagenes Paket blockiert die übrigen nicht", async () => {
    const { env } = makeEnv();
    mockFetch();
    await createPortalTip(env, { company: "A AG", role: "R" }, NOW);
    await createPortalTip(env, { company: "B AG", role: "R" }, NOW);
    let calls = 0;
    mockFetch((url) => (url.endsWith("/sendMessage") && ++calls === 1 ? Response.json({ ok: false, description: "x" }, { status: 500 }) : undefined));
    const r = await resendPortalTips(env, await openPortalTips(env));
    expect(r.sent).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
  });
});
