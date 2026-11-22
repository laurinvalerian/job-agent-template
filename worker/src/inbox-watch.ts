import { getSettings, setSetting } from "./db";
import type { Application, Env, ReplyClass } from "./env";
import { getMessage, listInboxSince, parseFromHeader, type InboxMessage } from "./gmail";

export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";
/** Obergrenze neuer Mails pro Cron-Lauf (Subrequest-Limit Free Plan: 50). */
const MAX_NEW_PER_RUN = 8;
/** Seiten à 100 Nachrichten pro Inbox-Liste. */
const MAX_LIST_PAGES = 2;

const ACK_PATTERNS: RegExp[] = [
  /eingang\s+ihrer\s+bewerbung/i,
  /ihre\s+bewerbung\s+(ist\s+)?(bei\s+uns\s+)?eingegangen/i,
  /bewerbung\s+(ist\s+)?(erfolgreich\s+)?(eingegangen|erhalten)/i,
  /eingangsbest(ä|ae)tigung/i,
  /we\s+(have\s+)?received\s+your\s+application/i,
  /thank\s+you\s+for\s+(your\s+)?(application|applying)/i,
  /your\s+application\s+has\s+been\s+(received|submitted)/i,
  /accusons\s+r(é|e)ception/i,
];
/** Signale für eine echte Antwort: dann nie per Regex als Eingangsbestätigung abtun. */
const REAL_REPLY_HINTS =
  /(leider|bedauern|absage|nicht\s+berücksichtigen|interview|vorstellungsgespr(ä|ae)ch|gespr(ä|ae)ch|termin|unfortunately|regret|not\s+to\s+move\s+forward|schnuppern|telefon)/i;
const NOREPLY = /(no-?reply|do-?not-?reply|noreply|donotreply|notification|mailer)/i;

/** Regex-Vorfilter für typische Eingangsbestätigungen. */
export function isAcknowledgement(fromEmail: string, subject: string, text: string): boolean {
  const hay = `${subject}\n${text}`;
  if (REAL_REPLY_HINTS.test(hay)) return false;
  if (ACK_PATTERNS.some((p) => p.test(hay))) return true;
  return NOREPLY.test(fromEmail) && /best(ä|ae)tigung|confirmation/i.test(hay);
}

export const APPLICATION_KEYWORDS =
  /\b(bewerbung|application|kandidatur|stelle|interview|vorstellungsgespr(ä|ae)ch|absage|ihre bewerbung|your application|workday|successfactors|personio|rexx|umantis)\b/i;

export const PORTAL_SENDER_DOMAINS = [
  "myworkday.com",
  "workday.com",
  "successfactors.com",
  "successfactors.eu",
  "sapsf.com",
  "sapsf.eu",
  "personio.de",
  "personio.com",
  "rexx-systems.com",
  "rexx-recruitment.com",
  "umantis.com",
  "abacus-umantis.ch",
  "smartrecruiters.com",
  "greenhouse.io",
  "lever.co",
  "softgarden.de",
  "softgarden.io",
  "jobs.ch",
  "jobup.ch",
  "join.com",
  "recruitee.com",
  "teamtailor.com",
  "workable.com",
  "icims.com",
  "taleo.net",
  "oraclecloud.com",
  "dvinci.de",
  "prescreen.io",
];

export function emailDomain(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase().trim();
}

/** true, wenn `domain` gleich `base` oder eine Subdomain davon ist. */
export function domainMatches(domain: string, base: string): boolean {
  if (!domain || !base) return false;
  const d = domain.toLowerCase();
  const b = base.toLowerCase();
  return d === b || d.endsWith(`.${b}`);
}

export function isPortalSender(fromEmail: string): boolean {
  const d = emailDomain(fromEmail);
  return PORTAL_SENDER_DOMAINS.some((p) => domainMatches(d, p));
}

type Candidate = Pick<Application, "id" | "company" | "company_domain" | "to_email" | "gmail_thread_id">;

/**
 * Zuordnung: 1) Thread einer Bewerbung, 2) Absender-Domain == company_domain / to_email-Domain,
 * 3) Portal-Bewerbung (Stichwort im Betreff oder bekannter Portal-Absender). Liefert null bei keinem Treffer.
 */
export function matchMessage(
  msg: Pick<InboxMessage, "threadId" | "fromEmail" | "subject">,
  apps: Candidate[],
): { application: Candidate | null; portal: boolean } | null {
  const byThread = apps.find((a) => a.gmail_thread_id && a.gmail_thread_id === msg.threadId);
  if (byThread) return { application: byThread, portal: false };
  const d = emailDomain(msg.fromEmail);
  const byDomain = apps.find((a) => domainMatches(d, a.company_domain) || domainMatches(d, emailDomain(a.to_email)));
  if (byDomain) return { application: byDomain, portal: false };
  if (isPortalSender(msg.fromEmail) || APPLICATION_KEYWORDS.test(msg.subject)) return { application: null, portal: true };
  return null;
}

/** Inhaltliches Ergebnis einer Antwort (nur bei echte_antwort aussagekräftig). */
export type Ergebnis = "absage" | "einladung" | "rueckfrage" | "andere";
const ERGEBNISSE: readonly Ergebnis[] = ["absage", "einladung", "rueckfrage", "andere"];

export interface Classification {
  class: ReplyClass;
  summary: string;
  ergebnis?: Ergebnis;
}

const CLASS_SCHEMA = {
  type: "object",
  properties: {
    class: { type: "string", enum: ["eingangsbestaetigung", "echte_antwort", "unklar", "irrelevant"] },
    ergebnis: { type: "string", enum: [...ERGEBNISSE] },
    summary: { type: "string" },
  },
  required: ["class", "ergebnis", "summary"],
};

export function parseClassification(raw: unknown): Classification | null {
  let obj: unknown = raw;
  if (raw && typeof raw === "object" && "response" in raw) obj = (raw as { response: unknown }).response;
  if (typeof obj === "string") {
    const m = obj.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const c = (obj as Record<string, unknown>).class;
  const s = (obj as Record<string, unknown>).summary;
  if (c !== "eingangsbestaetigung" && c !== "echte_antwort" && c !== "unklar" && c !== "irrelevant") return null;
  const e = (obj as Record<string, unknown>).ergebnis;
  return {
    class: c,
    summary: typeof s === "string" ? s.replace(/[\u2014\u2013]/g, "-").replace(/ß/g, "ss").slice(0, 600) : "",
    ergebnis: ERGEBNISSE.includes(e as Ergebnis) ? (e as Ergebnis) : undefined,
  };
}

export async function classifyWithAi(env: Env, msg: InboxMessage, company: string | null): Promise<Classification> {
  const fallback: Classification = { class: "unklar", summary: msg.snippet.slice(0, 300) };
  try {
    const out = await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "Du klassifizierst E-Mails im Posteingang eines Stellensuchenden. Klassen: " +
            "eingangsbestaetigung = automatische Bestätigung, dass die Bewerbung eingegangen ist; " +
            "echte_antwort = persönliche Antwort zur Bewerbung (Einladung, Absage, Rückfrage, Terminvorschlag); " +
            "unklar = bezieht sich auf eine Bewerbung, aber nicht eindeutig; " +
            "irrelevant = Newsletter, Werbung, Jobalarm, nichts mit einer konkreten Bewerbung. " +
            "Zusätzlich ergebnis: absage = die Firma sagt ab oder berücksichtigt die Bewerbung nicht weiter; " +
            "einladung = Einladung zu Gespräch, Interview, Test, Schnuppertag oder Terminvorschlag; " +
            "rueckfrage = die Firma bittet um Unterlagen, Angaben oder Rückruf, ohne Entscheid; " +
            "andere = alles andere (auch bei Eingangsbestätigung, unklar, irrelevant). " +
            'Antworte nur mit JSON {"class": ..., "ergebnis": ..., "summary": ...}. summary: 2 bis 3 Sätze auf Deutsch (Schweizer Schreibweise, ss statt ß).',
        },
        {
          role: "user",
          content: `Firma (vermutet): ${company ?? "unbekannt"}\nVon: ${msg.from}\nBetreff: ${msg.subject}\n\n${(msg.text || msg.snippet).slice(0, 3000)}`,
        },
      ],
      response_format: { type: "json_schema", json_schema: CLASS_SCHEMA },
      max_tokens: 300,
      temperature: 0,
    });
    return parseClassification(out) ?? fallback;
  } catch (e) {
    console.error(`[ai] Klassifizierung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

const CLASS_RANK: Record<string, number> = { eingangsbestaetigung: 1, unklar: 2, echte_antwort: 3 };

/**
 * Neuer Wert für last_inbox_check. Alles verarbeitet: jetzt. Sonst nur bis zur jüngsten verarbeiteten
 * Nachricht (älteste zuerst verarbeitet, also liegen alle unverarbeiteten danach); die 600 s Überlappung
 * der Suche und inbox_seen fangen den Rest ab. null: Checkpoint nicht bewegen.
 */
export function inboxCheckpoint(nowSec: number, pendingCount: number, processed: number, newestProcessedSec: number): number | null {
  if (processed >= pendingCount) return nowSec;
  if (processed === 0 || newestProcessedSec <= 0) return null;
  return newestProcessedSec;
}

/** Cron-Teil: neue Mails holen, zuordnen, klassifizieren, melden. */
export async function processInbox(env: Env, now = new Date()): Promise<{ processed: number }> {
  const settings = await getSettings(env.DB);
  const nowSec = Math.floor(now.getTime() / 1000);
  const last = Number.parseInt(settings.last_inbox_check, 10);
  const after = (Number.isFinite(last) ? last : nowSec - 86400) - 600;

  const { messages: listed, truncated } = await listInboxSince(env, after, MAX_LIST_PAGES);
  const seen = new Set<string>();
  // D1 erlaubt höchstens 100 gebundene Parameter pro Query
  for (let i = 0; i < listed.length; i += 100) {
    const ids = listed.slice(i, i + 100).map((m) => m.id);
    const rows = await env.DB.prepare(
      `SELECT gmail_message_id FROM inbox_seen WHERE gmail_message_id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ gmail_message_id: string }>();
    for (const r of rows.results) seen.add(r.gmail_message_id);
  }
  // Gmail liefert neueste zuerst; verarbeitet wird älteste zuerst
  const pending = listed.filter((m) => !seen.has(m.id)).reverse();
  const fresh = pending.slice(0, MAX_NEW_PER_RUN);

  const apps = fresh.length
    ? (
        await env.DB.prepare(
          `SELECT id, company, company_domain, to_email, gmail_thread_id FROM applications
           WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 500`,
        ).all<Candidate>()
      ).results
    : [];

  let processed = 0;
  let newestProcessedSec = 0;
  for (const ref of fresh) {
    const msg = await getMessage(env, ref.id);
    newestProcessedSec = Math.max(newestProcessedSec, Math.floor(msg.internalDate / 1000));
    let cls: ReplyClass = "irrelevant";
    let company: string | null = null;
    let appId: string | null = null;

    if (msg.fromEmail !== env.SENDER_EMAIL.toLowerCase()) {
      const match = matchMessage(msg, apps);
      if (match) {
        appId = match.application?.id ?? null;
        company = match.application?.company ?? (parseFromHeader(msg.from).name || emailDomain(msg.fromEmail));
        let c: Classification;
        if (isAcknowledgement(msg.fromEmail, msg.subject, msg.text || msg.snippet)) {
          c = { class: "eingangsbestaetigung", summary: "" };
        } else {
          c = await classifyWithAi(env, msg, company);
        }
        cls = c.class;
        // Keine Telegram-Meldung: Antworten sieht die Person selbst in Gmail
        if (appId && cls !== "irrelevant") {
          await env.DB.prepare(
            `UPDATE applications SET last_reply_at = ?,
               reply_class = CASE WHEN ? > COALESCE(CASE reply_class WHEN 'eingangsbestaetigung' THEN 1 WHEN 'unklar' THEN 2 WHEN 'echte_antwort' THEN 3 END, 0)
                                  THEN ? ELSE reply_class END
             WHERE id = ?`,
          )
            .bind(now.toISOString(), CLASS_RANK[cls] ?? 0, cls, appId)
            .run();
        }
        // RAV-Ergebnis: nur eindeutige Antworten; eine erfasste Anstellung wird nie überschrieben
        if (appId && cls === "echte_antwort" && (c.ergebnis === "absage" || c.ergebnis === "einladung")) {
          await env.DB.prepare("UPDATE applications SET result = ? WHERE id = ? AND result <> 'anstellung'")
            .bind(c.ergebnis, appId)
            .run();
        }
      }
    }

    await env.DB.prepare(
      `INSERT OR IGNORE INTO inbox_seen (gmail_message_id, seen_at, application_id, class, notified, from_addr, subject, company)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(msg.id, now.toISOString(), appId, cls, 0, msg.from.slice(0, 300), msg.subject.slice(0, 300), company)
      .run();
    processed++;
  }

  const checkpoint = inboxCheckpoint(nowSec, pending.length, processed, newestProcessedSec);
  if (checkpoint !== null) await setSetting(env.DB, "last_inbox_check", String(checkpoint));
  if (truncated) {
    throw new Error(`Posteingang: mehr als ${MAX_LIST_PAGES * 100} Mails seit dem letzten Check, ältere wurden nicht geprüft`);
  }
  return { processed };
}

