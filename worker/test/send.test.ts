import { afterEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../src/bot";
import { resetTokenCache } from "../src/gmail";
import { failStaleSending, processScheduled, sendApplication } from "../src/send";
import { insertApp, makeEnv, mockFetch, sampleMime, storeMime } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenCache();
});

const IN_WINDOW = new Date("2026-10-26T07:30:00Z"); // Mo 08:30 CET
const status = (raw: ReturnType<typeof makeEnv>["raw"], id: string) =>
  raw.prepare("SELECT status FROM applications WHERE id = ?").get(id)!.status;

describe("Versand im Cron", () => {
  it("ausserhalb des Fensters passiert nichts", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1") });
    const f = mockFetch();
    expect(await processScheduled(env, new Date("2026-10-26T06:30:00Z"))).toBe("outside_window");
    expect(f.calls).toHaveLength(0);
  });

  it("sendet die gespeicherte Nachricht unverändert (plus Date) per Upload, höchstens eine pro Lauf", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1") });
    insertApp(raw, { id: "a2", company_domain: "zwei.ch", created_at: "2026-09-02T08:00:00.000Z", attachment_keys: storeMime(kv, "a2") });
    let statusDuringSend: unknown;
    const f = mockFetch((url) => {
      if (url.includes("/messages/send")) statusDuringSend = status(raw, "a1");
      return undefined;
    });
    expect(await processScheduled(env, IN_WINDOW)).toBe("sent");
    expect(statusDuringSend).toBe("sending");
    const send = f.calls.filter((c) => c.url.includes("/messages/send"));
    expect(send).toHaveLength(1);
    expect(send[0].url).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media");
    expect(send[0].body).toBe(`Date: Mon, 26 Oct 2026 07:30:00 +0000\r\n${sampleMime()}`);
    const rows = raw.prepare("SELECT id, status, gmail_message_id, gmail_thread_id FROM applications ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a1", status: "sent", gmail_message_id: "msg123", gmail_thread_id: "thr123" },
      { id: "a2", status: "scheduled", gmail_message_id: null, gmail_thread_id: null },
    ]);
    // versendete Nachricht wird aus KV gelöscht, die noch geplante bleibt
    expect(kv.store.has("mime/a1")).toBe(false);
    expect(kv.store.has("mime/a2")).toBe(true);
  });

  it("vorhandener Date-Header wird nicht verdoppelt", async () => {
    const { env, raw, kv } = makeEnv();
    const mime = sampleMime({ extraHeaders: "Date: Mon, 26 Oct 2026 07:00:00 +0000" });
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1", mime) });
    const f = mockFetch();
    await processScheduled(env, IN_WINDOW);
    expect(f.calls.find((c) => c.url.includes("/messages/send"))!.body).toBe(mime);
  });

  it("pausiert: kein Versand", async () => {
    const { env, raw } = makeEnv();
    raw.prepare("UPDATE settings SET value = '1' WHERE key = 'paused'").run();
    insertApp(raw, { id: "a1" });
    mockFetch();
    expect(await processScheduled(env, IN_WINDOW)).toBe("paused");
  });

  it("Notbremse nach DAILY_BRAKE Mails: held_brake mit Buttons, dann Trotzdem senden", async () => {
    const { env, raw, kv } = makeEnv({ DAILY_BRAKE: "2" });
    insertApp(raw, { id: "s1", company_domain: "s1.ch", status: "sent", sent_at: "2026-10-26T07:05:00.000Z" });
    insertApp(raw, { id: "s2", company_domain: "s2.ch", status: "sent", sent_at: "2026-10-26T07:10:00.000Z" });
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1") });
    const f = mockFetch();
    expect(await processScheduled(env, IN_WINDOW)).toBe("held");
    expect(status(raw, "a1")).toBe("held_brake");
    const kb = (f.telegram()[0].body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard[0];
    expect(kb.map((b) => [b.text, b.callback_data])).toEqual([["Trotzdem senden", "brake_send:a1"], ["Verwerfen", "brake_drop:a1"]]);

    await handleUpdate(env, { update_id: 2, callback_query: { id: "q", data: "brake_send:a1", message: { message_id: 1, chat: { id: 4242 } } } }, undefined, IN_WINDOW);
    expect(status(raw, "a1")).toBe("sent");
  });

  it("Gmail 400 setzt failed, Gmail 503 zurück auf scheduled", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1") });
    mockFetch((url) => (url.includes("/messages/send") ? new Response("bad", { status: 400 }) : undefined));
    await processScheduled(env, IN_WINDOW);
    expect(status(raw, "a1")).toBe("failed");

    const e2 = makeEnv();
    insertApp(e2.raw, { id: "b1", attachment_keys: storeMime(e2.kv, "b1") });
    mockFetch((url) => (url.includes("/messages/send") ? new Response("oops", { status: 503 }) : undefined));
    await expect(processScheduled(e2.env, IN_WINDOW)).rejects.toThrow();
    expect(e2.raw.prepare("SELECT status, send_started_at FROM applications").get()).toEqual({ status: "scheduled", send_started_at: null });
  });

  it("OAuth-Fehler vor dem Lock lässt scheduled", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1") });
    mockFetch((url) => (url.includes("oauth2") ? Response.json({ error: "invalid_grant" }, { status: 400 }) : undefined));
    await expect(processScheduled(env, IN_WINDOW)).rejects.toThrow("OAuth");
    expect(status(raw, "a1")).toBe("scheduled");
  });
});

describe("Sending-Lock", () => {
  it("Netzwerkfehler nach dem Lock: bleibt sending, kein zweiter Versand", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1") });
    const f = mockFetch((url) => {
      if (url.includes("/messages/send")) throw new TypeError("network connection lost");
      return undefined;
    });
    await expect(processScheduled(env, IN_WINDOW)).rejects.toThrow("network");
    expect(status(raw, "a1")).toBe("sending");
    // Nächster Lauf 5 Min später: nichts mehr scheduled, kein weiterer Send-Versuch
    expect(await processScheduled(env, new Date(IN_WINDOW.getTime() + 5 * 60000))).toBe("idle");
    expect(f.calls.filter((c) => c.url.includes("/messages/send"))).toHaveLength(1);
  });

  it("nach über 30 Min in sending: failed und Hinweis auf Gmail Gesendet, nie neu senden", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", status: "sending", send_started_at: "2026-10-26T07:00:00.000Z", attachment_keys: storeMime(kv, "a1") });
    insertApp(raw, { id: "a2", company_domain: "b.ch", status: "sending", send_started_at: "2026-10-26T07:20:00.000Z" });
    const f = mockFetch();
    expect(await failStaleSending(env, new Date("2026-10-26T07:31:00Z"))).toBe(1);
    expect(status(raw, "a1")).toBe("failed");
    expect(status(raw, "a2")).toBe("sending");
    const text = (f.telegram()[0].body as { text: string }).text;
    expect(text).toContain('Bitte in Gmail unter "Gesendet" prüfen');
    expect(f.calls.filter((c) => c.url.includes("/messages/send"))).toHaveLength(0);
  });

  it("zwei parallele Versuche: nur einer bekommt den Lock", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1") });
    const f = mockFetch();
    const app = raw.prepare("SELECT * FROM applications WHERE id = 'a1'").get() as never;
    const results = await Promise.all([sendApplication(env, app, IN_WINDOW), sendApplication(env, app, IN_WINDOW)]);
    expect(results.sort()).toEqual([false, true]);
    expect(f.calls.filter((c) => c.url.includes("/messages/send"))).toHaveLength(1);
  });
});

describe("Sofortversand ausserhalb des Fensters", () => {
  const LATE = new Date("2026-09-30T21:40:00Z"); // Mi 23:40 Zürich
  const cb = (data: string) => ({ update_id: 1, callback_query: { id: "cq", data, message: { message_id: 7, chat: { id: 4242 } } } });
  const msg = (text: string) => ({ update_id: 1, message: { message_id: 8, chat: { id: 4242 }, text } });

  it("Freigabe spätabends bietet 'Jetzt senden' an, der Button versendet sofort", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", status: "pending_approval", attachment_keys: storeMime(kv, "a1") });
    const f = mockFetch();
    await handleUpdate(env, cb("approve:a1"), undefined, LATE);
    expect(status(raw, "a1")).toBe("scheduled");
    expect(JSON.stringify(f.telegram().map((c) => c.body))).toContain("send_now:a1");
    await handleUpdate(env, cb("send_now:a1"), undefined, LATE);
    expect(status(raw, "a1")).toBe("sent");
  });

  it("/senden verschickt alle eingeplanten sofort", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", attachment_keys: storeMime(kv, "a1") });
    insertApp(raw, { id: "a2", company_domain: "zwei.ch", attachment_keys: storeMime(kv, "a2") });
    insertApp(raw, { id: "a3", company_domain: "drei.ch", status: "pending_approval", attachment_keys: storeMime(kv, "a3") });
    mockFetch();
    await handleUpdate(env, msg("/senden"), undefined, LATE);
    expect([status(raw, "a1"), status(raw, "a2"), status(raw, "a3")]).toEqual(["sent", "sent", "pending_approval"]);
  });
});

describe("Knopf Sofort senden in der Vorschau", () => {
  it("approve_now versendet direkt, auch spätabends", async () => {
    const { env, raw, kv } = makeEnv();
    insertApp(raw, { id: "a1", status: "pending_approval", attachment_keys: storeMime(kv, "a1") });
    mockFetch();
    await handleUpdate(env, { update_id: 1, callback_query: { id: "cq", data: "approve_now:a1", message: { message_id: 7, chat: { id: 4242 } } } }, undefined, new Date("2026-09-30T21:45:00Z"));
    expect(status(raw, "a1")).toBe("sent");
  });
});
