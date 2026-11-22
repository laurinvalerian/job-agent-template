// RAV-Nachweis der Arbeitsbemühungen: Monatsliste (GET /api/rav), Versand der fertigen Liste an sich selbst
// (POST /api/rav-report), externe Bewerbungen und Ergebnisse (Telegram /extern, /ergebnis, /rav).

import { getRawSetting } from "./db";
import { APP_RESULTS, type AppResult, type Env, type ExternalArt } from "./env";
import { createDraftMessage, GmailError, sendRawMessage } from "./gmail";
import { notifyError } from "./notify";
import { containsForbiddenDash, MAX_MIME_BYTES, type ApiResult } from "./queue";
import { HEAD_BYTES, parseHeaders, rfc822Date } from "./rfc822";
import { escapeHtml, sendDocument, sendMessage } from "./telegram";
import { zonedParts, zonedToUtc } from "./time";

export type RavSource = "agent" | "portal" | "extern";

export interface RavEntry {
  source: RavSource;
  id: string;
  /** YYYY-MM-DD in Europe/Zurich */
  date: string;
  company: string;
  company_address: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  role: string;
  pensum: string | null;
  art: string;
  result: AppResult;
  job_url: string | null;
  ad_key: string | null;
  /** Mailtext der Bewerbung (= Motivationsschreiben), nur bei agent */
  letter_text: string | null;
  /** KV-Key des Anschreiben-PDFs, nur bei portal */
  letter_key: string | null;
}

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export function isValidMonth(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** "2026-10" -> "Oktober 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Laufender Monat (YYYY-MM) in der Zeitzone. */
export function currentMonth(now: Date, tz: string): string {
  return zonedParts(now, tz).dateKey.slice(0, 7);
}

/** Beginn und Ende (exklusiv) des lokalen Kalendermonats als UTC. */
export function monthBoundsUtc(month: string, tz: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { start: zonedToUtc(y, m, 1, 0, 0, tz), end: zonedToUtc(ny, nm, 1, 0, 0, tz) };
}

export const EXTERNAL_ARTS: readonly ExternalArt[] = ["schriftlich", "elektronisch", "telefonisch", "persoenlich", "portal"];

export const ART_LABEL: Record<ExternalArt, string> = {
  schriftlich: "schriftlich",
  elektronisch: "elektronisch",
  telefonisch: "telefonisch",
  persoenlich: "persönlich",
  portal: "elektronisch (Portal)",
};

export const RESULT_LABEL: Record<AppResult, string> = {
  offen: "offen",
  absage: "Absage",
  einladung: "Einladung",
  anstellung: "Anstellung",
};

const asResult = (v: unknown): AppResult => (APP_RESULTS.includes(v as AppResult) ? (v as AppResult) : "offen");
const orNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
/** Erste Paket-Datei eines Portal-Tipps ist das Anschreiben. */
function portalLetterKey(id: unknown, files: unknown): string | null {
  try {
    const list = JSON.parse(String(files ?? "[]")) as { key?: string }[];
    return typeof list[0]?.key === "string" ? list[0].key : null;
  } catch {
    return null;
  }
}
const SOURCE_ORDER: Record<RavSource, number> = { agent: 0, portal: 1, extern: 2 };

/**
 * Alle Arbeitsbemühungen eines Zürich-Kalendermonats, nach Datum sortiert.
 * Zeitstempel werden grosszügig per SQL vorgefiltert und dann exakt über das lokale Datum zugeordnet.
 */
export async function collectRavEntries(env: Env, month: string): Promise<RavEntry[]> {
  const tz = env.TZ_NAME;
  const { start, end } = monthBoundsUtc(month, tz);
  const from = new Date(start.getTime() - 86400000).toISOString();
  const to = new Date(end.getTime() + 86400000).toISOString();
  const localDate = (iso: string) => zonedParts(new Date(iso), tz).dateKey;
  const inMonth = (d: string) => d.slice(0, 7) === month;
  const entries: RavEntry[] = [];

  const agent = await env.DB.prepare(
    `SELECT id, company, company_address, contact_name, to_name, to_email, contact_phone, role, pensum, result, sent_at, job_url, ad_key, body_text
     FROM applications WHERE status = 'sent' AND sent_at >= ? AND sent_at < ?`,
  )
    .bind(from, to)
    .all<Record<string, unknown>>();
  for (const r of agent.results) {
    const date = localDate(String(r.sent_at));
    if (!inMonth(date)) continue;
    entries.push({
      source: "agent",
      id: String(r.id),
      date,
      company: String(r.company),
      company_address: orNull(r.company_address),
      contact_name: orNull(r.contact_name) ?? orNull(r.to_name),
      contact_email: orNull(r.to_email),
      contact_phone: orNull(r.contact_phone),
      role: String(r.role),
      pensum: orNull(r.pensum),
      art: "elektronisch (E-Mail)",
      result: asResult(r.result),
      job_url: orNull(r.job_url),
      ad_key: orNull(r.ad_key),
      letter_text: orNull(r.body_text),
      letter_key: null,
    });
  }

  const portal = await env.DB.prepare(
    `SELECT id, company, company_address, role, pensum, result, applied_at, url, ad_key, files
     FROM portal_tips WHERE status = 'applied_by_user' AND applied_at >= ? AND applied_at < ?`,
  )
    .bind(from, to)
    .all<Record<string, unknown>>();
  for (const r of portal.results) {
    const date = localDate(String(r.applied_at));
    if (!inMonth(date)) continue;
    entries.push({
      source: "portal",
      id: String(r.id),
      date,
      company: String(r.company),
      company_address: orNull(r.company_address),
      contact_name: null,
      contact_email: null,
      contact_phone: null,
      role: String(r.role),
      pensum: orNull(r.pensum),
      art: "elektronisch (Portal)",
      result: asResult(r.result),
      job_url: orNull(r.url),
      ad_key: orNull(r.ad_key),
      letter_text: null,
      letter_key: portalLetterKey(r.id, r.files),
    });
  }

  const ext = await env.DB.prepare(
    "SELECT id, applied_on, company, role, art, pensum, result, url FROM external_applications WHERE substr(applied_on, 1, 7) = ?",
  )
    .bind(month)
    .all<Record<string, unknown>>();
  for (const r of ext.results) {
    entries.push({
      source: "extern",
      id: `e${r.id}`,
      date: String(r.applied_on),
      company: String(r.company),
      company_address: null,
      contact_name: null,
      contact_email: null,
      contact_phone: null,
      role: String(r.role),
      pensum: orNull(r.pensum),
      art: ART_LABEL[r.art as ExternalArt] ?? String(r.art),
      result: asResult(r.result),
      job_url: orNull(r.url),
      ad_key: null,
      letter_text: null,
      letter_key: null,
    });
  }

  return entries.sort(
    (a, b) => a.date.localeCompare(b.date) || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.id.localeCompare(b.id),
  );
}

/** GET /api/rav?month=YYYY-MM */
export async function getRav(env: Env, month: string | null): Promise<ApiResult> {
  if (!isValidMonth(month)) return { status: 400, body: { error: "month im Format YYYY-MM erwartet" } };
  return { status: 200, body: { month, entries: await collectRavEntries(env, month) } };
}

export function countBySource(entries: RavEntry[]): Record<RavSource, number> {
  const c: Record<RavSource, number> = { agent: 0, portal: 0, extern: 0 };
  for (const e of entries) c[e.source]++;
  return c;
}

/** Telegram /rav: Stand des laufenden Monats. */
export async function ravStatusText(env: Env, now: Date): Promise<string> {
  const month = currentMonth(now, env.TZ_NAME);
  const entries = await collectRavEntries(env, month);
  const c = countBySource(entries);
  return [
    `📋 <b>RAV-Nachweis ${monthLabel(month)}</b>: bisher ${entries.length} ${entries.length === 1 ? "Eintrag" : "Einträge"}`,
    `Agent (per E-Mail versendet): ${c.agent}`,
    `Portal (selbst beworben): ${c.portal}`,
    `Extern erfasst: ${c.extern}`,
    "",
    "Weitere Bewerbungen erfassen mit /extern Firma; Stelle; Datum; Art; Pensum",
  ].join("\n");
}

// ---------- /extern ----------

export interface ExternInput {
  company: string;
  role: string;
  applied_on: string;
  art: ExternalArt;
  pensum: string | null;
  notes: string | null;
  url?: string | null;
}

export const EXTERN_EXAMPLE = "/extern Muster AG; Produktionsmitarbeiterin; 03.10.2026; elektronisch; 80%; https://link-zum-inserat";

const clean = (s: string) => s.replace(/[\u2014\u2013]/g, "-").trim().slice(0, 200);

/** TT.MM.JJJJ oder JJJJ-MM-TT -> YYYY-MM-DD, sonst null. */
export function parseDateInput(s: string): string | null {
  let y: number, m: number, d: number;
  const ch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ch) [d, m, y] = [Number(ch[1]), Number(ch[2]), Number(ch[3])];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseArt(s: string): ExternalArt | null {
  const v = s.trim().toLowerCase().replace("ö", "oe");
  return EXTERNAL_ARTS.includes(v as ExternalArt) ? (v as ExternalArt) : null;
}

/** Parst "Firma; Stelle; Datum; Art; Pensum; Link" (alles ab Datum optional; ein Teil mit http ist der Link, der Rest Notiz). */
export function parseExternArgs(arg: string, now: Date, tz: string): { ok: true; value: ExternInput } | { ok: false; error: string } {
  const parts = arg.split(";").map(clean);
  const [company = "", role = "", dateRaw = "", artRaw = "", pensum = "", ...rest] = parts;
  if (!company || !role) return { ok: false, error: "missing" };
  const today = zonedParts(now, tz).dateKey;
  let applied_on = today;
  if (dateRaw) {
    const d = parseDateInput(dateRaw);
    if (!d) return { ok: false, error: `Datum "${dateRaw}" verstehe ich nicht. Bitte TT.MM.JJJJ oder JJJJ-MM-TT.` };
    if (d > today) return { ok: false, error: `Das Datum ${dateRaw} liegt in der Zukunft.` };
    applied_on = d;
  }
  let art: ExternalArt = "elektronisch";
  if (artRaw) {
    const a = parseArt(artRaw);
    if (!a) return { ok: false, error: `Art "${artRaw}" kenne ich nicht. Erlaubt: schriftlich, elektronisch, telefonisch, persönlich, portal.` };
    art = a;
  }
  const url = rest.find((x) => /^https?:\/\//i.test(x)) ?? null;
  const notes = rest.filter((x) => x && x !== url).join("; ");
  return { ok: true, value: { company, role, applied_on, art, pensum: pensum || null, notes: notes || null, url } };
}

export async function insertExternal(db: D1Database, v: ExternInput, now: Date): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO external_applications (created_at, applied_on, company, role, art, pensum, notes, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(now.toISOString(), v.applied_on, v.company, v.role, v.art, v.pensum, v.notes, v.url ?? null)
    .run();
  return Number(res.meta.last_row_id);
}

/** "2026-10-03" -> "03.10.2026" */
export function formatDateCh(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

// ---------- /ergebnis ----------

export function parseResult(s: string): AppResult | null {
  const v = s.trim().toLowerCase();
  return APP_RESULTS.includes(v as AppResult) ? (v as AppResult) : null;
}

/**
 * Setzt das Ergebnis über eine Kennung: e<zahl> (extern), sonst Bewerbungs-id, sonst Portal-Tipp-id.
 * Liefert Firma und Stelle oder null, wenn nichts gefunden wurde.
 */
export async function setResultByKennung(
  db: D1Database,
  kennung: string,
  result: AppResult,
): Promise<{ source: RavSource; company: string; role: string } | null> {
  const ext = kennung.match(/^e(\d+)$/i);
  const targets: [RavSource, string, string | number][] = ext
    ? [["extern", "external_applications", Number(ext[1])]]
    : [
        ["agent", "applications", kennung],
        ["portal", "portal_tips", kennung],
      ];
  for (const [source, table, id] of targets) {
    const row = await db.prepare(`SELECT company, role FROM ${table} WHERE id = ?`).bind(id).first<{ company: string; role: string }>();
    if (!row) continue;
    await db.prepare(`UPDATE ${table} SET result = ? WHERE id = ?`).bind(result, id).run();
    return { source, company: row.company, role: row.role };
  }
  return null;
}

// ---------- POST /api/rav-report ----------

const isFile = (v: unknown): v is File => typeof v === "object" && v !== null && typeof (v as Blob).arrayBuffer === "function";

/**
 * Die RAV-Liste darf nur an die eigene Adresse gehen: Header-Block vollständig in den ersten 8 KB,
 * genau ein To-Header, alle Adressen in To (und allfälligen Cc/Bcc) gleich `own`.
 */
export function checkOwnRecipient(head: Uint8Array, own: string): { ok: true } | { ok: false; error: string } {
  const text = new TextDecoder().decode(head);
  const end = text.search(/\r?\n\r?\n/);
  if (end < 0) return { ok: false, error: "MIME: Header-Block endet nicht in den ersten 8 KB" };
  const lines = text.slice(0, end).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  const me = own.trim().toLowerCase();
  let toCount = 0;
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (key !== "to" && key !== "cc" && key !== "bcc") continue;
    if (key === "to") toCount++;
    const addrs = (line.slice(i + 1).match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) ?? []).map((a) => a.toLowerCase());
    if (key === "to" && addrs.length === 0) return { ok: false, error: "MIME: To-Header ohne Adresse" };
    if (addrs.some((a) => a !== me)) {
      return { ok: false, error: `MIME: Die RAV-Liste darf nur an die eigene Adresse (${own}) gehen, gefunden in ${key.toUpperCase()}: ${addrs.join(", ")}` };
    }
  }
  if (toCount !== 1) return { ok: false, error: "MIME: genau ein To-Header mit der eigenen Adresse erwartet" };
  return { ok: true };
}

const ravKey = (month: string) => `rav_sent_${month}`;

/**
 * POST /api/rav-report (multipart): `meta` {month, subject, count, force?}, `mime` (fertige Nachricht an sich selbst),
 * optional `pdf`. Sendet sofort über Gmail und meldet per Telegram. Pro Monat nur einmal, ausser force.
 */
export async function createRavReport(env: Env, form: FormData, now = new Date()): Promise<ApiResult> {
  const metaRaw = form.get("meta");
  if (typeof metaRaw !== "string") return { status: 400, body: { error: "Feld meta (JSON-String) fehlt" } };
  let meta: Record<string, unknown>;
  try {
    const p = JSON.parse(metaRaw);
    if (!p || typeof p !== "object") throw new Error();
    meta = p as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "meta ist kein gültiges JSON-Objekt" } };
  }
  if (!isValidMonth(meta.month)) return { status: 400, body: { error: "meta.month im Format YYYY-MM erwartet" } };
  const month = meta.month;
  if (typeof meta.subject !== "string" || !meta.subject.trim()) return { status: 400, body: { error: "meta.subject fehlt" } };
  if (containsForbiddenDash(meta.subject)) return { status: 422, body: { error: "Gedankenstrich in meta.subject" } };
  const count = meta.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return { status: 400, body: { error: "meta.count muss eine ganze Zahl >= 0 sein" } };
  }
  const force = meta.force === true;

  const mime = form.get("mime");
  if (!isFile(mime) || mime.size === 0) return { status: 400, body: { error: "Datei mime (RFC822) fehlt" } };
  if (mime.size >= MAX_MIME_BYTES) return { status: 413, body: { error: "mime muss unter 15 MB bleiben" } };
  const pdfRaw = form.get("pdf");
  const pdf = isFile(pdfRaw) && pdfRaw.size > 0 ? pdfRaw : null;
  if (pdf && pdf.size >= MAX_MIME_BYTES) return { status: 413, body: { error: "pdf muss unter 15 MB bleiben" } };

  const head = new Uint8Array(await mime.slice(0, HEAD_BYTES).arrayBuffer());
  const rcpt = checkOwnRecipient(head, env.SENDER_EMAIL);
  if (!rcpt.ok) return { status: 422, body: { error: rcpt.error } };

  // Doppelversand verhindern: Schlüssel atomar belegen (force überschreibt)
  const key = ravKey(month);
  const prev = await getRawSetting(env.DB, key);
  const claim = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE ? = 1 OR settings.value IS NULL OR settings.value = ''`,
  )
    .bind(key, `sending:${now.toISOString()}`, force ? 1 : 0)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    return {
      status: 409,
      body: { error: `RAV-Liste ${month} wurde schon gesendet (mit meta.force = true erneut senden)`, previous: prev },
    };
  }

  const hasDate = parseHeaders(head).has("date");
  const body = hasDate ? mime : new Blob([`Date: ${rfc822Date(now)}\r\n`, mime]);
  let sent: { id: string; threadId: string };
  try {
    sent = await sendRawMessage(env, body);
  } catch (e) {
    // Belegung zurücknehmen, damit ein neuer Versuch möglich ist. Bei Netzwerkfehler (kein GmailError) ist unklar,
    // ob die Mail rausging: dann bleibt die Belegung und ein erneuter Versand braucht force.
    if (e instanceof GmailError) {
      if (prev === null) await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
      else await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(prev, key).run();
    }
    await notifyError(env, "rav-report", e);
    return { status: 502, body: { error: `Versand fehlgeschlagen: ${e instanceof Error ? e.message.slice(0, 200) : "unbekannt"}` } };
  }

  await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .bind(JSON.stringify({ sent_at: now.toISOString(), gmail_message_id: sent.id, count }), key)
    .run();

  let telegram = true;
  try {
    await sendMessage(
      env,
      `📋 RAV-Liste ${escapeHtml(monthLabel(month))} ist in deinem Postfach (${count} ${count === 1 ? "Eintrag" : "Einträge"}). Du kannst sie direkt ans RAV weiterleiten.`,
    );
    if (pdf) await sendDocument(env, pdf, pdf.name || `RAV-Liste_${month}.pdf`);
  } catch (e) {
    telegram = false;
    await notifyError(env, "telegram-rav", e);
  }
  return { status: 200, body: { ok: true, month, gmail_message_id: sent.id, telegram } };
}

// ---------- POST /api/rav-draft ----------

/**
 * POST /api/rav-draft (multipart): `meta` {month, count?, force?}, `mime` (fertige Nachricht an sich selbst).
 * Legt sie als Entwurf im Postfach an (sendet nichts). Pro Monat nur einmal, ausser force.
 */
export async function createRavDraft(env: Env, form: FormData, now = new Date()): Promise<ApiResult> {
  const metaRaw = form.get("meta");
  if (typeof metaRaw !== "string") return { status: 400, body: { error: "Feld meta (JSON-String) fehlt" } };
  let meta: Record<string, unknown>;
  try {
    const p = JSON.parse(metaRaw);
    if (!p || typeof p !== "object") throw new Error();
    meta = p as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "meta ist kein gültiges JSON-Objekt" } };
  }
  if (!isValidMonth(meta.month)) return { status: 400, body: { error: "meta.month im Format YYYY-MM erwartet" } };
  const month = meta.month;
  const mime = form.get("mime");
  if (!isFile(mime) || mime.size === 0) return { status: 400, body: { error: "Datei mime (RFC822) fehlt" } };
  if (mime.size >= MAX_MIME_BYTES) return { status: 413, body: { error: "mime muss unter 15 MB bleiben" } };
  const head = new Uint8Array(await mime.slice(0, HEAD_BYTES).arrayBuffer());
  const rcpt = checkOwnRecipient(head, env.SENDER_EMAIL);
  if (!rcpt.ok) return { status: 422, body: { error: rcpt.error } };

  const key = `rav_draft_${month}`;
  const claim = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE ? = 1 OR settings.value IS NULL OR settings.value = ''`,
  )
    .bind(key, `creating:${now.toISOString()}`, meta.force === true ? 1 : 0)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    return { status: 409, body: { error: `Entwurf ${month} wurde schon angelegt (mit meta.force = true erneut anlegen)` } };
  }
  let draft: { id: string };
  let mode: "draft" | "mail" = "draft";
  try {
    const hasDate = parseHeaders(head).has("date");
    const body = hasDate ? mime : new Blob([`Date: ${rfc822Date(now)}\r\n`, mime]);
    try {
      draft = await createDraftMessage(env, body);
    } catch (e) {
      // Ohne Scope gmail.compose (Token noch nicht erneuert) auf Wunsch als normale Mail an sich selbst zustellen
      if (!(meta.fallback_mail === true && e instanceof GmailError && e.status === 403)) throw e;
      draft = await sendRawMessage(env, body);
      mode = "mail";
    }
  } catch (e) {
    if (e instanceof GmailError) await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    await notifyError(env, "rav-draft", e);
    return { status: 502, body: { error: `Entwurf fehlgeschlagen: ${e instanceof Error ? e.message.slice(0, 300) : "unbekannt"}` } };
  }
  await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .bind(JSON.stringify({ created_at: now.toISOString(), draft_id: draft.id }), key)
    .run();
  try {
    await sendMessage(
      env,
      mode === "draft"
        ? `📝 Entwurf mit deinen Bewerbungen ${escapeHtml(monthLabel(month))} liegt in deinen Gmail-Entwürfen (${typeof meta.count === "number" ? meta.count : "?"} Einträge). Du kannst ihn dort in Ruhe bearbeiten.`
        : `📝 Beispiel deiner Bewerbungen ${escapeHtml(monthLabel(month))} (${typeof meta.count === "number" ? meta.count : "?"} Einträge) ist in deinem Postfach. Ab Monatsende kommt es als Entwurf.`,
    );
  } catch (e) {
    await notifyError(env, "telegram-rav-draft", e);
  }
  return { status: 200, body: { ok: true, month, mode, draft_id: draft.id } };
}
