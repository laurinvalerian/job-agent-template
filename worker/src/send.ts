import { brakeLimit, countSentSince, getApplication, getSettings, transitionStatus } from "./db";
import type { Application, Env } from "./env";
import { getAccessToken, GmailError, sendRawMessage } from "./gmail";
import { dropMessage, kindLabel, storedMessage } from "./queue";
import { HEAD_BYTES, parseHeaders, rfc822Date } from "./rfc822";
import { escapeHtml, sendMessage } from "./telegram";
import { isSendWindow, startOfZonedDay } from "./time";

/** Nach so langer Zeit in `sending` gilt der Versand als unklar. */
export const SENDING_STALE_MS = 30 * 60 * 1000;

async function markFailed(env: Env, app: Application, from: Application["status"], msg: string): Promise<void> {
  await env.DB.prepare("UPDATE applications SET status = 'failed', error = ? WHERE id = ? AND status = ?")
    .bind(msg.slice(0, 500), app.id, from)
    .run();
  await sendMessage(env, `❗ Versand an <b>${escapeHtml(app.company)}</b> fehlgeschlagen: ${escapeHtml(msg.slice(0, 300))}`);
}

/**
 * Versendet die fertige RFC822-Nachricht aus KV unverändert (nur ein Date-Header wird vorangestellt,
 * falls er fehlt). Sending-Lock: vor dem Gmail-Call `scheduled` -> `sending`, danach `sent`.
 * - Gmail antwortet mit Fehler: nichts ging raus. 4xx (ausser 401/429) -> `failed`, sonst zurück auf `scheduled`.
 * - Netzwerkfehler oder Abbruch nach dem Lock: Status bleibt `sending`, siehe {@link failStaleSending}.
 * Liefert false, wenn die Bewerbung nicht (mehr) `scheduled` war.
 */
export async function sendApplication(env: Env, app: Application, now = new Date()): Promise<boolean> {
  const stored = storedMessage(app);
  if (!stored) {
    await markFailed(env, app, "scheduled", "Keine gespeicherte Nachricht (attachment_keys ungültig)");
    return false;
  }
  // Token vor dem Lock holen: ein OAuth-Fehler lässt die Bewerbung sauber auf `scheduled`.
  await getAccessToken(env);

  const locked = await env.DB.prepare(
    "UPDATE applications SET status = 'sending', send_started_at = ?, error = NULL WHERE id = ? AND status = 'scheduled'",
  )
    .bind(now.toISOString(), app.id)
    .run();
  if ((locked.meta.changes ?? 0) === 0) return false;

  const raw = await env.FILES.get(stored.mime_key, "arrayBuffer");
  if (!raw) {
    await markFailed(env, app, "sending", "Nachricht fehlt in KV (abgelaufen?)");
    return false;
  }
  const hasDate = parseHeaders(new Uint8Array(raw.slice(0, HEAD_BYTES))).has("date");
  const body = hasDate ? raw : new Blob([`Date: ${rfc822Date(now)}\r\n`, raw]);

  let res: { id: string; threadId: string };
  try {
    res = await sendRawMessage(env, body);
  } catch (e) {
    if (!(e instanceof GmailError)) throw e; // unklar, ob versendet: bleibt `sending`
    const permanent = e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429;
    if (permanent) {
      await markFailed(env, app, "sending", e.message);
      return false;
    }
    await env.DB.prepare("UPDATE applications SET status = 'scheduled', send_started_at = NULL, error = ? WHERE id = ? AND status = 'sending'")
      .bind(e.message.slice(0, 500), app.id)
      .run();
    throw e;
  }

  await env.DB.prepare(
    `UPDATE applications SET status = 'sent', sent_at = ?, gmail_message_id = ?, gmail_thread_id = ?, error = NULL
     WHERE id = ? AND status = 'sending'`,
  )
    .bind(now.toISOString(), res.id, res.threadId, app.id)
    .run();
  await dropMessage(env, app);
  await sendMessage(
    env,
    `📤 Versendet: <b>${escapeHtml(app.company)}</b>, ${escapeHtml(app.role)} (${kindLabel(app.kind)}) an ${escapeHtml(app.to_email)}`,
  );
  return true;
}

/** Hängt eine Bewerbung länger als 30 Min in `sending`: nie automatisch neu senden, sondern `failed` und nachfragen. */
export async function failStaleSending(env: Env, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SENDING_STALE_MS).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, company, role FROM applications WHERE status = 'sending' AND (send_started_at IS NULL OR send_started_at < ?)",
  )
    .bind(cutoff)
    .all<Pick<Application, "id" | "company" | "role">>();
  let n = 0;
  for (const a of results) {
    const res = await env.DB.prepare(
      "UPDATE applications SET status = 'failed', error = 'Versand unklar: über 30 Min im Status sending' WHERE id = ? AND status = 'sending'",
    )
      .bind(a.id)
      .run();
    if ((res.meta.changes ?? 0) === 0) continue;
    n++;
    await sendMessage(
      env,
      `⚠️ Versand an <b>${escapeHtml(a.company)}</b> (${escapeHtml(a.role)}) ist unklar. Ich sende nicht erneut. Bitte in Gmail unter "Gesendet" prüfen, ob die Mail rausging.`,
    );
  }
  return n;
}

/** Cron-Teil: hängende Versände prüfen, dann höchstens eine geplante Mail pro Lauf, nur im Versandfenster, mit Notbremse. */
export async function processScheduled(env: Env, now = new Date()): Promise<"outside_window" | "paused" | "idle" | "held" | "sent"> {
  await failStaleSending(env, now);
  if (!isSendWindow(now, env.TZ_NAME)) return "outside_window";
  const settings = await getSettings(env.DB);
  if (settings.paused) return "paused";
  const app = await env.DB.prepare("SELECT * FROM applications WHERE status = 'scheduled' ORDER BY created_at LIMIT 1").first<Application>();
  if (!app) return "idle";

  const sentToday = await countSentSince(env.DB, startOfZonedDay(now, env.TZ_NAME).toISOString());
  const limit = brakeLimit(env);
  if (sentToday >= limit) {
    if (await transitionStatus(env.DB, app.id, ["scheduled"], "held_brake")) {
      await sendMessage(
        env,
        `🛑 <b>Notbremse</b>: heute sind schon ${sentToday} Mails raus (Limit ${limit}).\nBewerbung an <b>${escapeHtml(app.company)}</b> (${escapeHtml(app.role)}) trotzdem senden?`,
        [[
          { text: "Trotzdem senden", callback_data: `brake_send:${app.id}` },
          { text: "Verwerfen", callback_data: `brake_drop:${app.id}` },
        ]],
      );
    }
    return "held";
  }
  return (await sendApplication(env, app, now)) ? "sent" : "idle";
}

/** Nach "Trotzdem senden": sofort versenden, ohne Fenster und Notbremse. */
export async function sendHeldNow(env: Env, id: string, now = new Date()): Promise<boolean> {
  if (!(await transitionStatus(env.DB, id, ["held_brake"], "scheduled"))) return false;
  const app = await getApplication(env.DB, id);
  if (!app) return false;
  return sendApplication(env, app, now);
}
