import { afterEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../src/bot";
import { escapeHtml, splitMessage } from "../src/telegram";
import { insertApp, makeEnv, mockFetch, storeMime } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("Telegram-Helfer", () => {
  it("escaped HTML", () => {
    expect(escapeHtml("<b>A & B</b>")).toBe("&lt;b&gt;A &amp; B&lt;/b&gt;");
  });
  it("splittet auf max. 4096 Zeichen, bevorzugt an Zeilen, ohne Entities zu zerteilen", () => {
    const text = Array.from({ length: 300 }, (_, i) => `Zeile ${i} ${"x".repeat(30)}`).join("\n");
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join("\n")).toBe(text);
    const long = "a".repeat(4094) + "&amp;" + "b".repeat(10);
    const lp = splitMessage(long);
    expect(lp[0].endsWith("a")).toBe(true);
    expect(lp[1].startsWith("&amp;")).toBe(true);
  });
});

const cb = (data: string, chat = 4242) => ({
  update_id: 1,
  callback_query: { id: "cq", data, message: { message_id: 7, chat: { id: chat } } },
});
const msg = (text: string, chat = 4242) => ({ update_id: 1, message: { message_id: 8, chat: { id: chat }, text } });

describe("Webhook-Logik", () => {
  it("ignoriert fremde Chats", async () => {
    const { env, raw } = makeEnv();
    insertApp(raw, { id: "a1", status: "pending_approval" });
    const f = mockFetch();
    await handleUpdate(env, cb("approve:a1", 999));
    expect(f.calls).toHaveLength(0);
    expect(raw.prepare("SELECT status FROM applications").get()!.status).toBe("pending_approval");
  });

  it("approve plant ein und zählt den Probelauf herunter, bei 0 Hinweis", async () => {
    const { env, raw } = makeEnv();
    raw.prepare("UPDATE settings SET value = '1' WHERE key = 'trial_remaining'").run();
    insertApp(raw, { id: "a1", status: "pending_approval" });
    const f = mockFetch();
    await handleUpdate(env, cb("approve:a1"));
    expect(raw.prepare("SELECT status FROM applications").get()!.status).toBe("scheduled");
    expect(raw.prepare("SELECT value FROM settings WHERE key = 'trial_remaining'").get()!.value).toBe("0");
    const texts = f.telegram().map((c) => (c.body as { text?: string }).text ?? "");
    expect(texts.some((t) => t.includes("Probelauf fertig, /auto on zum Umschalten"))).toBe(true);
  });

  it("reject fragt nach Grund und speichert die nächste Nachricht als Feedback zur Bewerbung", async () => {
    const { env, raw } = makeEnv();
    insertApp(raw, { id: "a1", status: "pending_approval" });
    mockFetch();
    await handleUpdate(env, cb("reject:a1"));
    expect(raw.prepare("SELECT status FROM applications").get()!.status).toBe("rejected_by_user");
    await handleUpdate(env, msg("Zu weit weg"));
    await handleUpdate(env, msg("Allgemeiner Hinweis"));
    expect(raw.prepare("SELECT application_id, text FROM feedback ORDER BY id").all()).toEqual([
      { application_id: "a1", text: "Zu weit weg" },
      { application_id: null, text: "Allgemeiner Hinweis" },
    ]);
  });

  it("reject löscht die fertige Nachricht aus KV", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", status: "pending_approval", attachment_keys: storeMime(kv, "a1") });
    mockFetch();
    expect(kv.store.has("mime/a1")).toBe(true);
    await handleUpdate(env, cb("reject:a1"));
    expect(kv.store.has("mime/a1")).toBe(false);
  });

  it("Befehle /pause, /auto on, /applied", async () => {
    const { env, raw } = makeEnv();
    raw.prepare("INSERT INTO portal_tips (id, created_at, company, role) VALUES ('t1', 'x', 'P', 'R')").run();
    mockFetch();
    await handleUpdate(env, msg("/pause"));
    await handleUpdate(env, msg("/auto on"));
    await handleUpdate(env, msg("/applied t1"));
    const s = Object.fromEntries(raw.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));
    expect(s.paused).toBe("1");
    expect(s.mode).toBe("auto");
    expect(raw.prepare("SELECT status FROM portal_tips").get()!.status).toBe("applied_by_user");
  });
});

describe("Automatik gesperrt (AUTO_ALLOWED=0)", () => {
  it("/auto on wird abgelehnt, Modus bleibt trial", async () => {
    const { env, raw } = makeEnv({ AUTO_ALLOWED: "0" });
    const f = mockFetch();
    await handleUpdate(env, msg("/auto on"));
    expect(raw.prepare("SELECT value FROM settings WHERE key = 'mode'").get()!.value).toBe("trial");
    expect(JSON.stringify(f.telegram().at(-1)!.body)).toContain("fest ausgeschaltet");
  });
  it("Freigabe erwähnt keinen Probelauf", async () => {
    const { env, raw } = makeEnv({ AUTO_ALLOWED: "0" });
    const f = mockFetch();
    insertApp(raw, { id: "a1", status: "pending_approval" });
    await handleUpdate(env, cb("approve:a1"));
    const texts = f.telegram().map((c) => JSON.stringify(c.body)).join(" ");
    expect(texts).not.toContain("Probelauf");
    expect(texts).not.toContain("/auto on");
  });
  it("/portal schickt offene Portal-Stellen samt Unterlagen aus KV nochmals", async () => {
    const { env, raw } = makeEnv();
    await env.FILES.put("portal/t1/0", new TextEncoder().encode("%PDF-1"));
    raw.prepare("INSERT INTO portal_tips (id, created_at, company, role, files) VALUES ('t1', 'a', 'Offen AG', 'R', ?)").run(JSON.stringify([{ key: "portal/t1/0", name: "Anschreiben.pdf" }]));
    raw.prepare("INSERT INTO portal_tips (id, created_at, company, role, status) VALUES ('t2', 'b', 'Erledigt AG', 'R', 'applied_by_user')").run();
    const f = mockFetch();
    await handleUpdate(env, msg("/portal"));
    const tg = f.telegram();
    expect(tg.filter((c) => c.url.endsWith("/sendDocument"))).toHaveLength(1);
    const texts = tg.map((c) => JSON.stringify(c.body ?? "")).join("\n");
    expect(texts).toContain("Offen AG");
    expect(texts).not.toContain("Erledigt AG");
  });
});
