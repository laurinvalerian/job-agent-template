import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxCheckpoint, isAcknowledgement, matchMessage, parseClassification, processInbox } from "../src/inbox-watch";
import { resetTokenCache } from "../src/gmail";
import { insertApp, makeEnv, mockFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenCache();
});

describe("Eingangsbestätigung-Regex", () => {
  it.each([
    ["hr@acme.ch", "Eingang Ihrer Bewerbung", "Wir bestätigen den Eingang Ihrer Bewerbung."],
    ["jobs@acme.ch", "Your application", "Thank you, we have received your application for IT Support."],
    ["noreply@myworkday.com", "Bestätigung", "Bestätigung: IT Supporter"],
    ["hr@acme.ch", "Ihre Bewerbung", "Ihre Bewerbung ist bei uns eingegangen."],
  ])("erkennt %s / %s", (from, subject, text) => {
    expect(isAcknowledgement(from, subject, text)).toBe(true);
  });

  it.each([
    ["hr@acme.ch", "Ihre Bewerbung", "Leider müssen wir Ihnen mitteilen, dass wir uns anders entschieden haben."],
    ["hr@acme.ch", "Einladung zum Vorstellungsgespräch", "Gerne laden wir Sie zu einem Gespräch ein."],
    ["hr@acme.ch", "Ihre Bewerbung", "Vielen Dank für Ihre Bewerbung. Wir haben den Eingang Ihrer Bewerbung erhalten und möchten einen Termin vereinbaren."],
    ["newsletter@shop.ch", "Bestätigung Ihrer Bestellung", "Danke für den Einkauf"],
  ])("erkennt keine Bestätigung bei %s / %s", (from, subject, text) => {
    expect(isAcknowledgement(from, subject, text)).toBe(false);
  });
});

describe("Zuordnung", () => {
  const apps = [{ id: "a1", company: "Acme AG", company_domain: "acme.ch", to_email: "jobs@acme-group.com", gmail_thread_id: "t1" }];
  it("über Thread, Domain, Subdomain und to_email-Domain", () => {
    expect(matchMessage({ threadId: "t1", fromEmail: "x@gmail.com", subject: "Re" }, apps)?.application?.id).toBe("a1");
    expect(matchMessage({ threadId: "z", fromEmail: "hr@acme.ch", subject: "Hallo" }, apps)?.application?.id).toBe("a1");
    expect(matchMessage({ threadId: "z", fromEmail: "hr@mail.acme.ch", subject: "Hallo" }, apps)?.application?.id).toBe("a1");
    expect(matchMessage({ threadId: "z", fromEmail: "p@acme-group.com", subject: "Hallo" }, apps)?.application?.id).toBe("a1");
    expect(matchMessage({ threadId: "z", fromEmail: "hr@notacme.ch", subject: "Hallo" }, apps)).toBeNull();
  });
  it("Portal-Bewerbungen über Absender oder Stichwort", () => {
    expect(matchMessage({ threadId: "z", fromEmail: "noreply@myworkday.com", subject: "Update" }, apps)).toEqual({ application: null, portal: true });
    expect(matchMessage({ threadId: "z", fromEmail: "hr@x.ch", subject: "Ihre Bewerbung bei X" }, apps)?.portal).toBe(true);
  });
});

describe("AI-Antwort parsen", () => {
  it("akzeptiert Objekt und String, verwirft Unsinn", () => {
    expect(parseClassification({ response: { class: "unklar", summary: "x" } })).toEqual({ class: "unklar", summary: "x" });
    expect(parseClassification({ response: '```json\n{"class":"echte_antwort","summary":"Grüße"}\n```' })?.summary).toBe("Grüsse");
    expect(parseClassification({ response: "kein json" })).toBeNull();
    expect(parseClassification({ response: { class: "foo" } })).toBeNull();
  });
});

describe("processInbox", () => {
  const gmailMessage = (id: string, from: string, subject: string, text: string, internalDate = 0) =>
    Response.json({
      id,
      threadId: `th-${id}`,
      internalDate: String(internalDate),
      snippet: text.slice(0, 50),
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "From", value: from }, { name: "Subject", value: subject }],
        body: { data: btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_") },
      },
    });

  it("meldet nichts per Telegram, loggt Bestätigungen, verarbeitet jede ID nur einmal", async () => {
    const { env, raw } = makeEnv();
    insertApp(raw, { id: "a1", company: "Acme AG", company_domain: "acme.ch", status: "sent", sent_at: "2026-10-20T07:00:00.000Z" });
    const f = mockFetch((url) => {
      if (url.includes("/messages?q=")) return Response.json({ messages: [{ id: "m2" }, { id: "m1" }, { id: "m3" }] });
      if (url.endsWith("/messages/m1?format=full")) return gmailMessage("m1", "HR <hr@acme.ch>", "Eingang Ihrer Bewerbung", "Wir bestätigen den Eingang Ihrer Bewerbung.");
      if (url.endsWith("/messages/m2?format=full")) return gmailMessage("m2", "Frau Muster <muster@acme.ch>", "Einladung", "Gerne laden wir Sie zum Gespräch ein.");
      if (url.endsWith("/messages/m3?format=full")) return gmailMessage("m3", "Shop <info@shop.ch>", "Sale", "Rabatt");
      return undefined;
    });
    const now = new Date("2026-10-21T10:00:00Z");
    expect((await processInbox(env, now)).processed).toBe(3);

    expect(f.telegram()).toHaveLength(0);
    expect(env.AI.run).toHaveBeenCalledTimes(1); // nur m2: m1 per Regex, m3 nicht zugeordnet

    const seen = raw.prepare("SELECT gmail_message_id, class, notified FROM inbox_seen ORDER BY gmail_message_id").all();
    expect(seen).toEqual([
      { gmail_message_id: "m1", class: "eingangsbestaetigung", notified: 0 },
      { gmail_message_id: "m2", class: "echte_antwort", notified: 0 },
      { gmail_message_id: "m3", class: "irrelevant", notified: 0 },
    ]);
    expect(raw.prepare("SELECT reply_class FROM applications WHERE id = 'a1'").get()!.reply_class).toBe("echte_antwort");

    // Zweiter Lauf: gleiche IDs, nichts doppelt
    expect((await processInbox(env, new Date("2026-10-21T10:05:00Z"))).processed).toBe(0);
  });

  it("AI-Fehler wird zu 'unklar' und still erfasst", async () => {
    const { env, raw } = makeEnv();
    (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("4006: daily free allocation exceeded"));
    insertApp(raw, { id: "a1", company: "Acme AG", company_domain: "acme.ch", status: "sent", sent_at: "2026-10-20T07:00:00.000Z" });
    const f = mockFetch((url) => {
      if (url.includes("/messages?q=")) return Response.json({ messages: [{ id: "m9" }] });
      if (url.includes("/messages/m9")) return gmailMessage("m9", "hr@acme.ch", "Rückfrage", "Können Sie uns Ihre Zeugnisse senden?");
      return undefined;
    });
    await processInbox(env, new Date("2026-10-21T10:00:00Z"));
    expect(f.telegram()).toHaveLength(0);
    expect(raw.prepare("SELECT class FROM inbox_seen WHERE gmail_message_id = 'm9'").get()!.class).toBe("unklar");
  });

  it("liest bis 2 Seiten à 100, verarbeitet max. 8 älteste zuerst, Checkpoint nicht über Unverarbeitete hinaus", async () => {
    const { env, raw } = makeEnv();
    raw.prepare("UPDATE settings SET value = ? WHERE key = 'last_inbox_check'").run(String(1_792_000_000));
    // 12 Mails, neueste zuerst: m12 (neueste) ... m1 (älteste); internalDate in ms
    const base = 1_792_000_100;
    const ids = Array.from({ length: 12 }, (_, i) => `m${12 - i}`);
    const f = mockFetch((url) => {
      if (url.includes("/messages?q=")) {
        const page2 = url.includes("pageToken=p2");
        return Response.json(page2 ? { messages: ids.slice(6).map((id) => ({ id })) } : { messages: ids.slice(0, 6).map((id) => ({ id })), nextPageToken: "p2" });
      }
      const m = url.match(/messages\/(m\d+)\?format=full/);
      if (m) return gmailMessage(m[1], "Shop <info@shop.ch>", "Sale", "Rabatt", (base + Number(m[1].slice(1))) * 1000);
      return undefined;
    });
    const now = new Date(1_792_000_500 * 1000);
    expect((await processInbox(env, now)).processed).toBe(8);

    const lists = f.calls.filter((c) => c.url.includes("/messages?q="));
    expect(lists).toHaveLength(2);
    expect(lists[0].url).toContain("maxResults=100");
    expect(lists[0].url).toContain(`after%3A${1_792_000_000 - 600}`);
    const fetched = f.calls.map((c) => c.url.match(/messages\/(m\d+)\?/)?.[1]).filter(Boolean);
    expect(fetched).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
    // Checkpoint = jüngste verarbeitete (m8), nicht "jetzt"
    expect(raw.prepare("SELECT value FROM settings WHERE key = 'last_inbox_check'").get()!.value).toBe(String(base + 8));

    // Nächster Lauf holt m9 bis m12 und setzt dann auf jetzt
    const now2 = new Date(1_792_000_800 * 1000);
    expect((await processInbox(env, now2)).processed).toBe(4);
    expect(raw.prepare("SELECT value FROM settings WHERE key = 'last_inbox_check'").get()!.value).toBe(String(1_792_000_800));
    expect(raw.prepare("SELECT COUNT(*) AS n FROM inbox_seen").get()!.n).toBe(12);
  });

  it("mehr als 2 Seiten: meldet Überlauf als Fehler", async () => {
    const { env } = makeEnv();
    mockFetch((url) => (url.includes("/messages?q=") ? Response.json({ messages: [], nextPageToken: "more" }) : undefined));
    await expect(processInbox(env, new Date("2026-10-21T10:00:00Z"))).rejects.toThrow("mehr als 200");
  });
});

describe("inboxCheckpoint", () => {
  it("alles verarbeitet -> jetzt; teilweise -> jüngste verarbeitete; nichts -> unverändert", () => {
    expect(inboxCheckpoint(1000, 3, 3, 900)).toBe(1000);
    expect(inboxCheckpoint(1000, 0, 0, 0)).toBe(1000);
    expect(inboxCheckpoint(1000, 10, 8, 900)).toBe(900);
    expect(inboxCheckpoint(1000, 10, 0, 0)).toBeNull();
  });
});
