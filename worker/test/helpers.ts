import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import schema from "../schema.sql?raw";
import type { Env } from "../src/env";

/** D1-Teilmenge (prepare/bind/first/all/run) auf node:sqlite. */
export function fakeD1(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(schema);
  const norm = (params: unknown[]) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p));
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    async first<T>(col?: string): Promise<T | null> {
      const row = raw.prepare(sql).get(...norm(params));
      if (!row) return null;
      return (col ? row[col] : { ...row }) as T;
    },
    async all<T>() {
      return { results: raw.prepare(sql).all(...norm(params)).map((r) => ({ ...r })) as T[], success: true, meta: {} };
    },
    async run() {
      const r = raw.prepare(sql).run(...norm(params));
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { db: { prepare: (sql: string) => stmt(sql) } as unknown as D1Database, raw };
}

export function fakeKV(): KVNamespace & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: unknown) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace & { store: Map<string, unknown> };
}

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** Mockt fetch global: Telegram, Google OAuth und Gmail antworten mit Erfolg. */
export function mockFetch(overrides: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = init?.body;
    if (typeof body === "string" && body.startsWith("{")) body = JSON.parse(body);
    if (body instanceof Blob || body instanceof ArrayBuffer) body = await new Response(body).text();
    calls.push({ url, method: init?.method ?? "GET", body });
    const o = overrides(url, init);
    if (o) return o;
    if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: {} });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    if (url.includes("/messages/send")) return Response.json({ id: "msg123", threadId: "thr123" });
    if (url.includes("/upload/gmail/v1/users/me/drafts")) return Response.json({ id: "draft123" });
    return new Response("not mocked", { status: 500 });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, telegram: () => calls.filter((c) => c.url.startsWith("https://api.telegram.org/")) };
}

export function makeEnv(overrides: Partial<Env> = {}) {
  const { db, raw } = fakeD1();
  const kv = fakeKV();
  const env: Env = {
    DB: db,
    FILES: kv,
    AI: { run: vi.fn(async () => ({ response: { class: "echte_antwort", summary: "Einladung zum Gespräch." } })) } as unknown as Ai,
    ROUTINE_TOKEN: "routine-secret-token",
    TELEGRAM_TOKEN: "123:telegram-secret",
    TELEGRAM_CHAT_ID: "4242",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    GMAIL_CLIENT_ID: "cid",
    GMAIL_CLIENT_SECRET: "csecret",
    GMAIL_REFRESH_TOKEN: "refresh",
    SENDER_NAME: "Max Muster",
    SENDER_EMAIL: "max.muster@example.com",
    DAILY_BRAKE: "8",
    TZ_NAME: "Europe/Zurich",
    ...overrides,
  };
  return { env, raw, kv };
}

export function sampleMeta(overrides: Record<string, unknown> = {}) {
  return {
    id: "2026-11-03-acme",
    company: "Acme AG",
    company_domain: "acme.ch",
    role: "IT Supporter 100%",
    kind: "stelle",
    to_email: "jobs@acme.ch",
    to_name: "Frau Muster",
    subject: "Bewerbung als IT Supporter",
    body_text: "Sehr geehrte Frau Muster\n\nGerne bewerbe ich mich.\n\nFreundliche Grüsse\nMax Muster",
    score: 8.7,
    reason: "Passt gut zum Profil",
    sources: ["https://acme.ch/jobs/1"],
    job_url: "https://acme.ch/jobs/1",
    attachment_names: ["Anschreiben_Max_Muster.pdf", "Lebenslauf.pdf"],
    ...overrides,
  };
}

/** Fertige RFC822-Nachricht, wie sie die Routine baut (ohne Date/Message-ID). */
export function sampleMime(opts: { to?: string; subject?: string; extraHeaders?: string } = {}) {
  return [
    'From: "Max Muster" <max.muster@example.com>',
    `To: ${opts.to ?? "Frau Muster <jobs@acme.ch>"}`,
    `Subject: ${opts.subject ?? "=?utf-8?b?QmV3ZXJidW5nIGFscyBJVCBTdXBwb3J0ZXI=?="}`,
    ...(opts.extraHeaders ? [opts.extraHeaders] : []),
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Sehr geehrte Frau Muster",
    "--B--",
    "",
  ].join("\r\n");
}

export function makeForm(meta: unknown = sampleMeta(), mime: string | null = sampleMime(), preview = true): FormData {
  const form = new FormData();
  form.append("meta", typeof meta === "string" ? meta : JSON.stringify(meta));
  if (mime !== null) form.append("mime", new File([mime], "bewerbung.eml", { type: "message/rfc822" }));
  if (preview) form.append("preview", new File(["%PDF-1.4 test"], "Anschreiben_Max_Muster.pdf", { type: "application/pdf" }));
  return form;
}

/** Legt die fertige Nachricht für eine Bewerbung in KV ab und liefert den attachment_keys-JSON. */
export function storeMime(kv: ReturnType<typeof fakeKV>, id: string, mime = sampleMime()): string {
  const buf = new TextEncoder().encode(mime).buffer;
  kv.store.set(`mime/${id}`, buf);
  return JSON.stringify({ mime_key: `mime/${id}`, mime_size: buf.byteLength, attachment_names: ["CV.pdf"] });
}

/** Fügt eine Bewerbung direkt in D1 ein (für Tests von Versand, Rapport etc.). */
export function insertApp(raw: DatabaseSync, a: Record<string, unknown>) {
  const row = {
    id: "app1",
    created_at: "2026-09-01T08:00:00.000Z",
    company: "Firma",
    company_domain: "firma.ch",
    role: "Rolle",
    kind: "stelle",
    to_email: "hr@firma.ch",
    to_name: null,
    subject: "Bewerbung",
    body_text: "Text",
    attachment_keys: "[]",
    score: 8,
    reason: "Grund",
    sources: "[]",
    job_url: null,
    status: "scheduled",
    sent_at: null,
    gmail_thread_id: null,
    reply_class: null,
    ...a,
  };
  const cols = Object.keys(row);
  raw
    .prepare(`INSERT INTO applications (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}
