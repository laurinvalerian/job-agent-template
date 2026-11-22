export interface Env {
  DB: D1Database;
  FILES: KVNamespace;
  AI: Ai;
  ROUTINE_TOKEN: string;
  ADMIN_TOKEN?: string;
  TELEGRAM_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  SENDER_NAME: string;
  SENDER_EMAIL: string;
  DAILY_BRAKE: string;
  TZ_NAME: string;
  /** "0": Automatik gesperrt, jede Bewerbung braucht immer eine Freigabe (Wunsch von Person B). */
  AUTO_ALLOWED?: string;
}

export type AppStatus =
  | "pending_approval"
  | "scheduled"
  | "sending"
  | "sent"
  | "rejected_by_user"
  | "held_brake"
  | "failed";

/** Ergebnis einer Bewerbung für den RAV-Nachweis. */
export type AppResult = "offen" | "absage" | "einladung" | "anstellung";
export const APP_RESULTS: readonly AppResult[] = ["offen", "absage", "einladung", "anstellung"];

/** Art einer extern (ohne Agent) gemachten Bewerbung. */
export type ExternalArt = "schriftlich" | "elektronisch" | "telefonisch" | "persoenlich" | "portal";

export type ReplyClass = "eingangsbestaetigung" | "echte_antwort" | "unklar" | "irrelevant";

export interface Application {
  id: string;
  created_at: string;
  company: string;
  company_domain: string;
  role: string;
  kind: "stelle" | "initiativ";
  to_email: string;
  to_name: string | null;
  subject: string;
  body_text: string;
  attachment_keys: string;
  score: number | null;
  reason: string | null;
  sources: string;
  job_url: string | null;
  status: AppStatus;
  sent_at: string | null;
  send_started_at: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  last_reply_at: string | null;
  reply_class: ReplyClass | null;
  error: string | null;
  pensum: string | null;
  company_address: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  result: AppResult;
  /** JSON {@link Hslu} oder null (alte Einträge, Person B). */
  hslu?: string | null;
}

export interface PortalTip {
  id: string;
  created_at: string;
  company: string;
  role: string;
  url: string | null;
  why: string | null;
  deadline: string | null;
  notes: string | null;
  files: string | null;
  applied_at: string | null;
  status: "new" | "applied_by_user" | "dismissed";
  pensum: string | null;
  company_address: string | null;
  result: AppResult;
  /** JSON {@link Hslu} oder null (alte Tipps, Person B). */
  hslu?: string | null;
}

/** Soll die HSLU-Aufnahmebestätigung mit? Entscheid der Routine samt Grund. */
export interface Hslu {
  attach: boolean;
  reason: string;
}

export interface ExternalApplication {
  id: number;
  created_at: string;
  applied_on: string;
  company: string;
  role: string;
  art: ExternalArt;
  pensum: string | null;
  result: AppResult;
  notes: string | null;
}

/**
 * Inhalt von applications.attachment_keys: KV-Key der fertigen RFC822-Nachricht
 * (roh als ArrayBuffer) plus Dateinamen der Anhänge für Anzeige und Rapport.
 */
export interface StoredMessage {
  mime_key: string;
  mime_size: number;
  attachment_names: string[];
}
