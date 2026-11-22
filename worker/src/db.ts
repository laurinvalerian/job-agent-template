import type { Application, AppStatus, Env, PortalTip } from "./env";

export interface Settings {
  mode: "trial" | "auto";
  paused: boolean;
  trial_remaining: number;
  last_report_date: string;
  last_inbox_check: string;
  /** Bewerbung, zu der die nächste freie Textnachricht als Begründung gespeichert wird */
  awaiting_feedback_for: string;
  /** Notiz der Routine für den Rapport (z. B. "nichts über der Qualitätsschwelle") */
  routine_note: string;
  routine_note_date: string;
  /** Zeitpunkt (ISO), zu dem ein Routine-Lauf sich angemeldet oder zuletzt einen Zwischenstand gesichert hat */
  run_lease: string;
}

const DEFAULTS: Record<keyof Settings, string> = {
  mode: "trial",
  paused: "0",
  trial_remaining: "7",
  last_report_date: "",
  last_inbox_check: "",
  awaiting_feedback_for: "",
  routine_note: "",
  routine_note_date: "",
  run_lease: "",
};

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string | null }>();
  const raw: Record<string, string> = { ...DEFAULTS };
  for (const r of results) raw[r.key] = r.value ?? "";
  return {
    mode: raw.mode === "auto" ? "auto" : "trial",
    paused: raw.paused === "1",
    trial_remaining: Number.parseInt(raw.trial_remaining, 10) || 0,
    last_report_date: raw.last_report_date,
    last_inbox_check: raw.last_inbox_check,
    awaiting_feedback_for: raw.awaiting_feedback_for,
    routine_note: raw.routine_note,
    routine_note_date: raw.routine_note_date,
    run_lease: raw.run_lease,
  };
}

export async function setSetting(db: D1Database, key: keyof Settings, value: string | number | boolean): Promise<void> {
  const v = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, v)
    .run();
}

export async function getApplication(db: D1Database, id: string): Promise<Application | null> {
  return db.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<Application>();
}

/** Setzt den Status nur, wenn die Bewerbung noch im erwarteten Status ist. Liefert true bei Erfolg. */
export async function transitionStatus(
  db: D1Database,
  id: string,
  from: AppStatus[],
  to: AppStatus,
): Promise<boolean> {
  const placeholders = from.map(() => "?").join(",");
  const res = await db
    .prepare(`UPDATE applications SET status = ? WHERE id = ? AND status IN (${placeholders})`)
    .bind(to, id, ...from)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Aktive Bewerbung (nicht verworfen/fehlgeschlagen) an dieselbe Domain in den letzten `days` Tagen. */
export async function findActiveByDomain(
  db: D1Database,
  domain: string,
  now: Date,
  days = 180,
): Promise<Pick<Application, "id" | "company" | "status" | "created_at"> | null> {
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  return db
    .prepare(
      `SELECT id, company, status, created_at FROM applications
       WHERE lower(company_domain) = lower(?) AND created_at >= ?
         AND status NOT IN ('rejected_by_user','failed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(domain, since)
    .first();
}

export async function countSentSince(db: D1Database, sinceIso: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'sent' AND sent_at >= ?")
    .bind(sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countSentTotal(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'sent'").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function addFeedback(db: D1Database, text: string, applicationId: string | null, now: Date): Promise<void> {
  await db
    .prepare("INSERT INTO feedback (created_at, application_id, text) VALUES (?, ?, ?)")
    .bind(now.toISOString(), applicationId, text)
    .run();
}

export async function setPortalTipStatus(
  db: D1Database,
  id: string,
  status: PortalTip["status"],
  now = new Date(),
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE portal_tips SET status = ?, applied_at = CASE WHEN ? = 'applied_by_user' THEN ? ELSE applied_at END WHERE id = ?")
    .bind(status, status, now.toISOString(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export function brakeLimit(env: Env): number {
  const n = Number.parseInt(env.DAILY_BRAKE, 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/** Freier Settings-Schlüssel (z. B. rav_sent_2026-10), nicht Teil von {@link Settings}. */
export async function getRawSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string | null }>();
  return row ? (row.value ?? "") : null;
}
