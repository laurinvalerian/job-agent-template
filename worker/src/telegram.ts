import type { Env } from "./env";

export const TELEGRAM_MAX = 4096;

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Teilt HTML-Text in Stücke <= max. Bevorzugt Zeilenumbrüche; Tags dürfen deshalb
 * nie über Zeilen gehen. Überlange Zeilen werden hart geschnitten, ohne ein
 * HTML-Entity (&amp; etc.) zu zerteilen.
 */
export function splitMessage(text: string, max = TELEGRAM_MAX): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.replace(/\n+$/, ""));
    current = "";
  };
  for (const line of text.split("\n")) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    flush();
    let rest = line;
    while (rest.length > max) {
      let cut = max;
      const amp = rest.lastIndexOf("&", cut - 1);
      if (amp > cut - 10 && rest.indexOf(";", amp) >= cut) cut = amp;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  flush();
  return chunks.length > 0 ? chunks : [""];
}

async function call<T = unknown>(env: Env, method: string, body: unknown): Promise<T> {
  const init: RequestInit =
    body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, init);
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !data.ok) {
    // Token nie loggen: nur Methode und Beschreibung
    throw new Error(`Telegram ${method} fehlgeschlagen (${res.status}): ${data.description ?? "unbekannt"}`);
  }
  return data.result as T;
}

/** Sendet HTML-Text, gesplittet. Buttons hängen an der letzten Nachricht. */
export async function sendMessage(env: Env, html: string, keyboard?: InlineKeyboard): Promise<void> {
  const parts = splitMessage(html);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    await call(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: parts[i],
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(last && keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }
}

/** Schickt eine Datei direkt aus dem Blob (kein Umkopieren, kein Base64). */
export async function sendDocument(env: Env, file: Blob, filename: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("document", file, filename);
  await call(env, "sendDocument", form);
}

export async function answerCallback(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  await call(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

/** Entfernt die Buttons einer Nachricht (nach Klick). Fehler sind egal. */
export async function clearButtons(env: Env, chatId: number | string, messageId: number): Promise<void> {
  await call(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => undefined);
}

export async function setWebhook(env: Env, url: string): Promise<unknown> {
  return call(env, "setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}
