import { getSettings, setSetting } from "./db";
import type { AppStatus, Env } from "./env";
import { escapeHtml, sendMessage } from "./telegram";
import { isReportDue, startOfZonedDay, zonedParts } from "./time";

export interface ReportData {
  today: { company: string; status: AppStatus }[];
  waiting: { company: string }[];
  note: string | null;
}

/** Kürzt eine Namensliste auf die ersten `max` plus "+n". */
function names(list: (string | null)[], max = 4): string {
  const shown = list.slice(0, max).map((n) => `<b>${escapeHtml(n ?? "?")}</b>`).join(", ");
  return list.length > max ? `${shown} +${list.length - max}` : shown;
}

/**
 * Baut den 22:00-Rapport: nur Neues und Offenes, Wichtigstes zuerst. Vorhersehbares
 * (Datum, Zähler, Eingangsbestätigungen, laufende Bewerbungen) bleibt weg.
 * Ist nichts los, genügt eine Zeile. Gmail-Antworten und offene Portal-Stellen kommen bewusst nicht vor:
 * Antworten sieht die Person selbst in Gmail, Portal-Pakete kommen direkt beim Erstellen.
 */
export function buildReport(r: ReportData): string {
  const out: string[] = [];
  if (r.waiting.length) out.push(`⏳ Wartet auf dich: ${names(r.waiting.map((w) => w.company))}`);
  const failed = r.today.filter((a) => a.status === "failed");
  if (failed.length) out.push(`❌ Versand fehlgeschlagen: ${names(failed.map((a) => a.company))}`);
  const sent = r.today.filter((a) => a.status === "sent");
  if (sent.length) out.push(`✅ Beworben: ${names(sent.map((a) => a.company))}`);
  const planned = r.today.filter((a) => a.status === "scheduled" || a.status === "sending");
  if (planned.length) out.push(`🕒 Eingeplant: ${names(planned.map((a) => a.company))}`);
  if (out.length === 0) return r.note ? `😴 Nichts Neues. ${escapeHtml(r.note)}` : "😴 Nichts Neues.";
  return out.join("\n");
}

export async function gatherReportData(env: Env, now = new Date()): Promise<ReportData> {
  const tz = env.TZ_NAME;
  const dayStart = startOfZonedDay(now, tz).toISOString();
  const dateKey = zonedParts(now, tz).dateKey;
  const db = env.DB;

  const today = await db
    .prepare("SELECT company, status FROM applications WHERE created_at >= ? OR sent_at >= ? ORDER BY created_at")
    .bind(dayStart, dayStart)
    .all<ReportData["today"][number]>();
  const waiting = await db
    .prepare("SELECT company FROM applications WHERE status IN ('pending_approval','held_brake') ORDER BY created_at")
    .all<ReportData["waiting"][number]>();
  const settings = await getSettings(db);

  return {
    today: today.results,
    waiting: waiting.results,
    note: settings.routine_note_date === dateKey && settings.routine_note ? settings.routine_note : null,
  };
}

export async function sendReport(env: Env, now = new Date()): Promise<void> {
  await sendMessage(env, buildReport(await gatherReportData(env, now)));
}

/** Cron-Teil: ab 22:00 Zürich einmal pro Tag. */
export async function maybeSendDailyReport(env: Env, now = new Date()): Promise<boolean> {
  const settings = await getSettings(env.DB);
  if (!isReportDue(now, settings.last_report_date, env.TZ_NAME)) return false;
  await sendReport(env, now);
  await setSetting(env.DB, "last_report_date", zonedParts(now, env.TZ_NAME).dateKey);
  return true;
}
