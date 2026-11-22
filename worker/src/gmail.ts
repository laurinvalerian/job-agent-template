import type { Env } from "./env";

// ---------- Base64-Helfer ----------

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url (Gmail-API-Payloads) nach UTF-8-Text. */
export function base64UrlToUtf8(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
}

// ---------- OAuth ----------

export class GmailError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export function resetTokenCache(): void {
  tokenCache = null;
}

export async function getAccessToken(env: Env, now = Date.now()): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    throw new GmailError(`OAuth-Refresh fehlgeschlagen (${res.status}): ${data.error ?? "unbekannt"}`, res.status);
  }
  tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function gmailFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken(env);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new GmailError(`Gmail ${res.status}: ${text}`, res.status);
  }
  return res;
}

// ---------- Versand ----------

/** Media-Upload der fertigen RFC822-Nachricht, damit auch Anhänge > 5 MB gehen. */
export async function sendRawMessage(env: Env, mime: BodyInit): Promise<{ id: string; threadId: string }> {
  const res = await gmailFetch(env, "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", {
    method: "POST",
    headers: { "content-type": "message/rfc822" },
    body: mime,
  });
  const data = (await res.json()) as { id: string; threadId: string };
  return { id: data.id, threadId: data.threadId };
}

/** Legt die fertige RFC822-Nachricht als Entwurf an (braucht den Scope gmail.compose). */
export async function createDraftMessage(env: Env, mime: BodyInit): Promise<{ id: string }> {
  const res = await gmailFetch(env, "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media", {
    method: "POST",
    headers: { "content-type": "message/rfc822" },
    body: mime,
  });
  const data = (await res.json()) as { id: string };
  return { id: data.id };
}

/** Erstes PDF einer gesendeten Nachricht, dessen Dateiname mit `prefix` beginnt (z.B. "Anschreiben"). */
export async function getSentPdf(env: Env, messageId: string, prefix: string): Promise<{ name: string; data: Uint8Array } | null> {
  const msg = (await (await gmailFetch(env, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`)).json()) as {
    payload?: GmailPart & { filename?: string };
  };
  const found: { name: string; id: string }[] = [];
  const walk = (p: (GmailPart & { filename?: string; body?: { attachmentId?: string } }) | undefined) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId && p.filename.toLowerCase().startsWith(prefix.toLowerCase()) && p.filename.toLowerCase().endsWith(".pdf")) {
      found.push({ name: p.filename, id: p.body.attachmentId });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  if (!found[0]) return null;
  const att = (await (await gmailFetch(env, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${found[0].id}`)).json()) as { data: string };
  const b64 = att.data.replace(/-/g, "+").replace(/_/g, "/");
  return { name: found[0].name, data: base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4)) };
}

/** Absender, Betreff und Text-Auszug aller Nachrichten eines Threads (z.B. um einen Bounce zu lesen). */
export async function getThreadTexts(env: Env, threadId: string): Promise<{ from: string; subject: string; text: string }[]> {
  const t = (await (await gmailFetch(env, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`)).json()) as {
    messages?: { payload?: GmailPart; snippet?: string }[];
  };
  return (t.messages ?? []).map((m) => {
    const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    const text = extractText(m.payload) || m.snippet || "";
    return { from: h("from"), subject: h("subject"), text: text.slice(0, 1500) };
  });
}

/** Rohe RFC822-Nachricht einer gesendeten Mail. */
export async function getRawMessage(env: Env, messageId: string): Promise<Uint8Array> {
  const m = (await (await gmailFetch(env, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=raw`)).json()) as { raw: string };
  const b64 = m.raw.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

// ---------- Posteingang ----------

/** Listet Inbox-Nachrichten seit `afterEpochSec` (neueste zuerst), bis zu `maxPages` Seiten à 100. */
export async function listInboxSince(
  env: Env,
  afterEpochSec: number,
  maxPages = 2,
): Promise<{ messages: { id: string; threadId: string }[]; truncated: boolean }> {
  const q = encodeURIComponent(`in:inbox after:${afterEpochSec}`);
  const messages: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const data = (await (await gmailFetch(env, url)).json()) as {
      messages?: { id: string; threadId: string }[];
      nextPageToken?: string;
    };
    messages.push(...(data.messages ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return { messages, truncated: !!pageToken };
}

export interface InboxMessage {
  id: string;
  threadId: string;
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  text: string;
  internalDate: number;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

function extractText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return base64UrlToUtf8(part.body.data);
  for (const p of part.parts ?? []) {
    const t = extractText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return base64UrlToUtf8(part.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

export function parseFromHeader(from: string): { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: from.trim().toLowerCase() };
}

export async function getMessage(env: Env, id: string): Promise<InboxMessage> {
  const res = await gmailFetch(env, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
  const data = (await res.json()) as {
    id: string;
    threadId: string;
    snippet?: string;
    internalDate?: string;
    payload?: GmailPart;
  };
  const header = (name: string) =>
    data.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const from = header("From");
  return {
    id: data.id,
    threadId: data.threadId,
    from,
    fromEmail: parseFromHeader(from).email,
    subject: header("Subject"),
    snippet: data.snippet ?? "",
    text: extractText(data.payload).slice(0, 4000),
    internalDate: Number(data.internalDate ?? 0),
  };
}
