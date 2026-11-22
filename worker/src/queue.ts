import { countSentSince, countSentTotal, findActiveByDomain, getSettings, setSetting, type Settings } from "./db";
import type { Application, AppStatus, Env, Hslu, PortalTip, StoredMessage } from "./env";
import { notifyError } from "./notify";
import { checkMimeHead, HEAD_BYTES } from "./rfc822";
import { escapeHtml, sendDocument, sendMessage, type InlineKeyboard } from "./telegram";
import { startOfZonedDay, zonedParts } from "./time";

export const MAX_MIME_BYTES = 15 * 1024 * 1024;
export const MIME_TTL_SEC = 90 * 86400;
export const AD_TTL_SEC = 150 * 86400;
const FORBIDDEN_DASHES = /[\u2014\u2013]/;

export interface ApplicationMeta {
  id: string;
  company: string;
  company_domain: string;
  role: string;
  kind: "stelle" | "initiativ";
  to_email: string;
  to_name?: string;
  subject: string;
  body_text: string;
  score?: number;
  reason?: string;
  sources?: string[];
  job_url?: string;
  attachment_names?: string[];
  pensum?: string;
  company_address?: string;
  contact_name?: string;
  contact_phone?: string;
  hslu?: Hslu;
}

/** Optionale Freitextfelder für den RAV-Nachweis (max. {@link RAV_FIELD_MAX} Zeichen, ohne Gedankenstriche). */
export const RAV_FIELD_MAX = 200;

/**
 * Prüft optionale String-Felder: fehlend/leer -> null, kein String oder zu lang -> 400, Gedankenstrich -> 422.
 */
export function optionalTextFields<K extends string>(
  b: Record<string, unknown>,
  keys: readonly K[],
): { ok: true; value: Record<K, string | null> } | { ok: false; status: number; error: string } {
  const value = {} as Record<K, string | null>;
  for (const k of keys) {
    const v = b[k];
    if (v === undefined || v === null) {
      value[k] = null;
      continue;
    }
    if (typeof v !== "string") return { ok: false, status: 400, error: `${k} muss ein String sein` };
    const t = v.trim();
    if (t.length > RAV_FIELD_MAX) return { ok: false, status: 400, error: `${k}: höchstens ${RAV_FIELD_MAX} Zeichen` };
    if (containsForbiddenDash(t)) return { ok: false, status: 422, error: `Gedankenstrich in ${k}` };
    value[k] = t || null;
  }
  return { ok: true, value };
}

/** Prüft das optionale Feld `hslu` ({attach: bool, reason: str}): fehlend -> null. */
export function validateHslu(v: unknown): { ok: true; value: Hslu | null } | { ok: false; status: number; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, status: 400, error: "hslu muss ein Objekt {attach, reason} sein" };
  const h = v as Record<string, unknown>;
  if (typeof h.attach !== "boolean") return { ok: false, status: 400, error: "hslu.attach muss true oder false sein" };
  const r = h.reason ?? "";
  if (typeof r !== "string") return { ok: false, status: 400, error: "hslu.reason muss ein String sein" };
  const reason = r.trim();
  if (reason.length > RAV_FIELD_MAX) return { ok: false, status: 400, error: `hslu.reason: höchstens ${RAV_FIELD_MAX} Zeichen` };
  if (containsForbiddenDash(reason)) return { ok: false, status: 422, error: "Gedankenstrich in hslu.reason" };
  return { ok: true, value: { attach: h.attach, reason } };
}

/** Gespeichertes hslu-JSON lesen; kaputt oder fehlend -> null. */
export function parseHslu(s: string | null | undefined): Hslu | null {
  if (!s) return null;
  try {
    const v = validateHslu(JSON.parse(s));
    return v.ok ? v.value : null;
  } catch {
    return null;
  }
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export function containsForbiddenDash(s: string): boolean {
  return FORBIDDEN_DASHES.test(s);
}

export function isPlausibleEmail(s: string): boolean {
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(
    s,
  );
}

export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validiert das Feld `meta` von POST /api/applications. */
export function validateMeta(raw: unknown): { ok: true; value: ApplicationMeta } | { ok: false; status: number; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, status: 400, error: "meta muss ein JSON-Objekt sein" };
  const b = raw as Record<string, unknown>;
  for (const f of ["id", "company", "company_domain", "role", "kind", "to_email", "subject", "body_text"]) {
    if (!str(b[f])) return { ok: false, status: 400, error: `Feld fehlt oder leer: ${f}` };
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(b.id as string)) return { ok: false, status: 400, error: "id: nur A-Z, 0-9, . _ -" };
  if (b.kind !== "stelle" && b.kind !== "initiativ") return { ok: false, status: 400, error: "kind muss 'stelle' oder 'initiativ' sein" };
  if (containsForbiddenDash(b.subject as string) || containsForbiddenDash(b.body_text as string)) {
    return { ok: false, status: 422, error: "Gedankenstriche (Em-Dash U+2014 oder En-Dash U+2013) in subject/body_text sind nicht erlaubt" };
  }
  if (!isPlausibleEmail((b.to_email as string).trim())) return { ok: false, status: 422, error: "to_email ist nicht plausibel" };
  if (b.sources !== undefined && !strArray(b.sources)) return { ok: false, status: 400, error: "sources muss ein String-Array sein" };
  if (b.attachment_names !== undefined && !strArray(b.attachment_names)) {
    return { ok: false, status: 400, error: "attachment_names muss ein String-Array sein" };
  }
  if (b.score !== undefined && typeof b.score !== "number") return { ok: false, status: 400, error: "score muss eine Zahl sein" };
  const extra = optionalTextFields(b, ["pensum", "company_address", "contact_name", "contact_phone"] as const);
  if (!extra.ok) return extra;
  const hslu = validateHslu(b.hslu);
  if (!hslu.ok) return hslu;
  return {
    ok: true,
    value: {
      ...(b as unknown as ApplicationMeta),
      pensum: extra.value.pensum ?? undefined,
      company_address: extra.value.company_address ?? undefined,
      contact_name: extra.value.contact_name ?? undefined,
      contact_phone: extra.value.contact_phone ?? undefined,
      hslu: hslu.value ?? undefined,
      company_domain: normalizeDomain(b.company_domain as string),
      to_email: (b.to_email as string).trim(),
    },
  };
}

/** Anfangsstatus einer neuen Bewerbung abhängig von Modus und Pause. */
export const autoAllowed = (env: Pick<Env, "AUTO_ALLOWED">) => env.AUTO_ALLOWED !== "0";

export function initialStatus(settings: Pick<Settings, "mode" | "paused">, allowAuto = true): AppStatus {
  if (settings.paused || !allowAuto) return "pending_approval";
  return settings.mode === "auto" ? "scheduled" : "pending_approval";
}

export function kindLabel(kind: string): string {
  return kind === "initiativ" ? "Initiativ" : "Stelle";
}

/**
 * Fertige Nachricht aus KV löschen, sobald sie nicht mehr gebraucht wird (versendet oder verworfen).
 * Sonst füllen Mails mit Beilagen (mehrere MB) bei vielen Bewerbungen das KV-Gratiskontingent. Fehler nur melden.
 */
export async function dropMessage(env: Env, app: Pick<Application, "attachment_keys">): Promise<void> {
  const stored = storedMessage(app);
  if (!stored) return;
  try {
    await env.FILES.delete(stored.mime_key);
  } catch (e) {
    await notifyError(env, "kv-aufraeumen", e);
  }
}

export function storedMessage(app: Pick<Application, "attachment_keys">): StoredMessage | null {
  try {
    const v = JSON.parse(app.attachment_keys || "{}") as Partial<StoredMessage>;
    if (typeof v.mime_key !== "string") return null;
    return { mime_key: v.mime_key, mime_size: v.mime_size ?? 0, attachment_names: v.attachment_names ?? [] };
  } catch {
    return null;
  }
}

/**
 * Lesbare Namen der Mail-Anhänge: "Microsoft_Zertifikate_Max_Muster.pdf" -> "Microsoft Zertifikate".
 * Das Dateipräfix kommt aus "Lebenslauf_<prefix>.pdf"; ohne Lebenslauf bleiben die vollen Namen.
 */
export function readableAttachmentNames(names: string[]): string[] {
  const cv = names.map((n) => /^(?:Lebenslauf|CV)_(.+)\.pdf$/i.exec(n)).find(Boolean);
  if (!cv) return names;
  const suffix = `_${cv[1]}`;
  return names.map((n) => {
    const stem = n.replace(/\.pdf$/i, "");
    if (/^Anschreiben_/i.test(stem)) return "Anschreiben";
    if (/^Cover_Letter_/i.test(stem)) return "Cover Letter";
    if (stem.endsWith(suffix) && stem.length > suffix.length) return stem.slice(0, -suffix.length).replace(/_/g, " ");
    return n;
  });
}

export function hsluLine(h: Hslu | null): string | null {
  if (!h) return null;
  const why = h.reason ? ` (${escapeHtml(h.reason)})` : "";
  return `<b>HSLU-Bestätigung:</b> ${h.attach ? "beigelegt" : "nicht beigelegt"}${why}`;
}

export function previewText(app: Application, attachmentNames: string[], paused: boolean, cvPreview = false): string {
  const sources = safeJsonArray(app.sources);
  const lines = [
    `📝 <b>Neue Bewerbung zur Freigabe</b>${paused ? " (Versand pausiert)" : ""}`,
    `<b>${escapeHtml(app.company)}</b>: ${escapeHtml(app.role)} (${kindLabel(app.kind)})`,
    `Score: <b>${app.score ?? "?"}</b>`,
    `An: ${escapeHtml(app.to_name ? `${app.to_name} <${app.to_email}>` : app.to_email)}`,
    `Betreff: ${escapeHtml(app.subject)}`,
    "",
    `<b>Warum:</b> ${escapeHtml(app.reason ?? "")}`,
  ];
  if (sources.length) {
    lines.push("", "<b>Quellen:</b>");
    for (const s of sources) lines.push(`• ${escapeHtml(s)}`);
  }
  if (app.job_url) lines.push(`Inserat: ${escapeHtml(app.job_url)}`);
  if (attachmentNames.length) {
    lines.push("", `<b>Mitgeschickt werden:</b> ${readableAttachmentNames(attachmentNames).map(escapeHtml).join(", ")}`);
  }
  const hl = hsluLine(parseHslu(app.hslu));
  if (hl) lines.push(hl);
  if (attachmentNames.length || hl) {
    lines.push(
      cvPreview
        ? "Unten zur Ansicht nur das Anschreiben und der angepasste Lebenslauf, alles andere geht automatisch mit der Mail mit."
        : "Unten zur Ansicht nur das Anschreiben, alles andere geht automatisch mit der Mail mit.",
    );
  }
  lines.push("", "<b>Mailtext:</b>", "", escapeHtml(app.body_text));
  return lines.join("\n");
}

/** Alle noch nicht freigegebenen Entwürfe nochmals als Vorschau mit Freigabe-Tasten schicken (ohne PDFs). */
export async function resendPending(env: Env): Promise<{ sent: string[]; failed: string[] }> {
  const { results } = await env.DB.prepare("SELECT * FROM applications WHERE status = 'pending_approval' ORDER BY created_at").all<Application>();
  const settings = await getSettings(env.DB);
  const sent: string[] = [];
  const failed: string[] = [];
  for (const app of results) {
    try {
      await sendMessage(env, previewText(app, storedMessage(app)?.attachment_names ?? [], settings.paused));
      await sendMessage(env, `Bewerbung an <b>${escapeHtml(app.company)}</b> senden?`, [
        [
          { text: "📤 Sofort senden", callback_data: `approve_now:${app.id}` },
          { text: "🕗 Mo-Fr 08:00", callback_data: `approve:${app.id}` },
        ],
        [{ text: "❌ Verwerfen", callback_data: `reject:${app.id}` }],
      ]);
      sent.push(app.id);
    } catch {
      failed.push(app.id);
    }
  }
  return { sent, failed };
}

export function safeJsonArray(s: string | null): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const isFile = (v: unknown): v is File => typeof v === "object" && v !== null && typeof (v as Blob).arrayBuffer === "function";

/**
 * POST /api/applications als multipart/form-data:
 * `meta` (JSON-String), `mime` (fertige RFC822-Nachricht), optional `preview` (Anschreiben-PDF für Telegram)
 * und `preview_cv` (angepasster Lebenslauf, nur bei cv: tailored; wird nur gezeigt, nicht gespeichert).
 * Die Nachricht wird unverändert als ArrayBuffer in KV abgelegt; kein MIME-Bau und kein Base64 im Worker.
 */
export async function createApplication(env: Env, form: FormData, now = new Date()): Promise<ApiResult> {
  const metaRaw = form.get("meta");
  if (typeof metaRaw !== "string") return { status: 400, body: { error: "Feld meta (JSON-String) fehlt" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaRaw);
  } catch {
    return { status: 400, body: { error: "meta ist kein gültiges JSON" } };
  }
  const v = validateMeta(parsed);
  if (!v.ok) return { status: v.status, body: { error: v.error } };
  const meta = v.value;

  const mime = form.get("mime");
  if (!isFile(mime) || mime.size === 0) return { status: 400, body: { error: "Datei mime (RFC822) fehlt" } };
  if (mime.size >= MAX_MIME_BYTES) return { status: 413, body: { error: "mime muss unter 15 MB bleiben" } };
  const previewRaw = form.get("preview");
  const preview = isFile(previewRaw) && previewRaw.size > 0 ? previewRaw : null;
  const previewCvRaw = form.get("preview_cv");
  const previewCv = isFile(previewCvRaw) && previewCvRaw.size > 0 && previewCvRaw.size < MAX_MIME_BYTES ? previewCvRaw : null;
  const adRaw = form.get("ad");
  const ad = isFile(adRaw) && adRaw.size > 0 && adRaw.size < MAX_MIME_BYTES ? adRaw : null;

  const head = new Uint8Array(await mime.slice(0, HEAD_BYTES).arrayBuffer());
  const check = checkMimeHead(head, meta.to_email);
  if (!check.ok) return { status: 422, body: { error: check.error } };

  if (await env.DB.prepare("SELECT 1 FROM applications WHERE id = ?").bind(meta.id).first()) {
    return { status: 409, body: { error: `id existiert bereits: ${meta.id}` } };
  }
  const dup = await findActiveByDomain(env.DB, meta.company_domain, now);
  if (dup) {
    return {
      status: 409,
      body: { error: `Aktive Bewerbung an ${meta.company_domain} in den letzten 180 Tagen`, existing: dup },
    };
  }

  const stored: StoredMessage = { mime_key: `mime/${meta.id}`, mime_size: mime.size, attachment_names: meta.attachment_names ?? [] };
  await env.FILES.put(stored.mime_key, await mime.arrayBuffer(), { expirationTtl: MIME_TTL_SEC });

  const settings = await getSettings(env.DB);
  const status = initialStatus(settings, autoAllowed(env));
  const app: Application = {
    id: meta.id,
    created_at: now.toISOString(),
    company: meta.company.trim(),
    company_domain: meta.company_domain,
    role: meta.role.trim(),
    kind: meta.kind,
    to_email: meta.to_email,
    to_name: meta.to_name?.trim() || null,
    subject: meta.subject,
    body_text: meta.body_text,
    attachment_keys: JSON.stringify(stored),
    score: meta.score ?? null,
    reason: meta.reason ?? null,
    sources: JSON.stringify(meta.sources ?? []),
    job_url: meta.job_url ?? null,
    status,
    sent_at: null,
    send_started_at: null,
    gmail_message_id: null,
    gmail_thread_id: null,
    last_reply_at: null,
    reply_class: null,
    error: null,
    pensum: meta.pensum ?? null,
    company_address: meta.company_address ?? null,
    contact_name: meta.contact_name ?? null,
    contact_phone: meta.contact_phone ?? null,
    result: "offen",
    hslu: meta.hslu ? JSON.stringify(meta.hslu) : null,
  };
  await env.DB.prepare(
    `INSERT INTO applications (id, created_at, company, company_domain, role, kind, to_email, to_name, subject, body_text,
       attachment_keys, score, reason, sources, job_url, status, pensum, company_address, contact_name, contact_phone, hslu)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      app.id, app.created_at, app.company, app.company_domain, app.role, app.kind, app.to_email, app.to_name,
      app.subject, app.body_text, app.attachment_keys, app.score, app.reason, app.sources, app.job_url, app.status,
      app.pensum, app.company_address, app.contact_name, app.contact_phone, app.hslu,
    )
    .run();

  if (ad) await storeAd(env, "applications", app.id, `ad/${app.id}`, ad);

  try {
    if (status === "pending_approval") {
      await sendMessage(env, previewText(app, stored.attachment_names, settings.paused, !!previewCv));
      if (preview) await sendDocument(env, preview, preview.name || "Anschreiben.pdf");
      if (previewCv) await sendDocument(env, previewCv, previewCv.name || "Lebenslauf.pdf");
      const keyboard: InlineKeyboard = [[
        { text: "📤 Sofort senden", callback_data: `approve_now:${app.id}` },
        { text: "🕗 Mo-Fr 08:00", callback_data: `approve:${app.id}` },
      ], [
        { text: "❌ Verwerfen", callback_data: `reject:${app.id}` },
      ]];
      await sendMessage(env, `Bewerbung an <b>${escapeHtml(app.company)}</b> senden?`, keyboard);
    } else {
      await sendMessage(
        env,
        `📬 Eingeplant: <b>${escapeHtml(app.company)}</b>, ${escapeHtml(app.role)} (${kindLabel(app.kind)}, Score ${app.score ?? "?"}). Versand im nächsten Fenster Mo-Fr 08:00 bis 10:30.`,
      );
    }
  } catch (e) {
    await notifyError(env, "telegram-vorschau", e);
  }

  return { status: 201, body: { id: app.id, status } };
}

const PORTAL_MAX_FILES = 5;

/** Inserat-Screenshot (PDF) 150 Tage in KV ablegen: genug für die RAV-Liste am Anfang des Folgemonats, ohne dass KV volläuft. */
async function storeAd(env: Env, table: "applications" | "portal_tips", id: string, key: string, file: File): Promise<void> {
  await env.FILES.put(key, await file.arrayBuffer(), { expirationTtl: AD_TTL_SEC });
  await env.DB.prepare(`UPDATE ${table} SET ad_key = ? WHERE id = ?`).bind(key, id).run();
}

/**
 * POST /api/portal-tips: JSON (nur Tipp) oder multipart/form-data mit `meta` (JSON) und bis zu 5 PDF-Dateien
 * (`file_0` Anschreiben, bei cv: tailored `file_1` angepasster Lebenslauf). Optional `hslu` {attach, reason}
 * als Hinweis, ob die HSLU-Bestätigung ins Portal gehört. Das Paket geht sofort per Telegram raus.
 * Portal-Tipps zählen nie als Bewerbung.
 */
export async function createPortalTip(env: Env, raw: unknown, now = new Date(), form?: FormData | null): Promise<ApiResult> {
  let body: unknown = raw;
  if (form) {
    const metaRaw = form.get("meta");
    if (typeof metaRaw !== "string") return { status: 400, body: { error: "Feld meta (JSON-String) fehlt" } };
    try {
      body = JSON.parse(metaRaw);
    } catch {
      return { status: 400, body: { error: "meta ist kein gültiges JSON" } };
    }
  }
  if (!body || typeof body !== "object") return { status: 400, body: { error: "Body muss ein JSON-Objekt sein" } };
  const b = body as Record<string, unknown>;
  if (!str(b.company) || !str(b.role)) return { status: 400, body: { error: "company und role sind Pflicht" } };
  const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  for (const k of ["company", "role", "why", "notes"]) {
    if (typeof b[k] === "string" && /[\u2013\u2014]/.test(b[k] as string)) {
      return { status: 422, body: { error: `Gedankenstrich in ${k}` } };
    }
  }
  const extra = optionalTextFields(b, ["pensum", "company_address"] as const);
  if (!extra.ok) return { status: extra.status, body: { error: extra.error } };
  const hslu = validateHslu(b.hslu);
  if (!hslu.ok) return { status: hslu.status, body: { error: hslu.error } };
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);

  const files: { key: string; name: string }[] = [];
  const blobs: File[] = [];
  if (form) {
    let total = 0;
    for (let i = 0; i < PORTAL_MAX_FILES; i++) {
      const f = form.get(`file_${i}`);
      if (!isFile(f) || f.size === 0) continue;
      total += f.size;
      if (total >= MAX_MIME_BYTES) return { status: 413, body: { error: "Paket muss unter 15 MB bleiben" } };
      blobs.push(f);
    }
    for (const [i, f] of blobs.entries()) {
      const key = `portal/${id}/${i}`;
      await env.FILES.put(key, await f.arrayBuffer(), { expirationTtl: MIME_TTL_SEC });
      files.push({ key, name: f.name || `Datei_${i + 1}.pdf` });
    }
  }

  const tip: PortalTip = {
    id,
    created_at: now.toISOString(),
    company: (b.company as string).trim(),
    role: (b.role as string).trim(),
    url: opt(b.url),
    why: opt(b.why),
    deadline: opt(b.deadline),
    notes: opt(b.notes),
    files: files.length ? JSON.stringify(files) : null,
    applied_at: null,
    status: "new",
    pensum: extra.value.pensum,
    company_address: extra.value.company_address,
    result: "offen",
    hslu: hslu.value ? JSON.stringify(hslu.value) : null,
  };
  await env.DB.prepare(
    `INSERT INTO portal_tips (id, created_at, company, role, url, why, deadline, notes, files, status, pensum, company_address, hslu)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
  )
    .bind(
      tip.id, tip.created_at, tip.company, tip.role, tip.url, tip.why, tip.deadline, tip.notes, tip.files, tip.pensum,
      tip.company_address, tip.hslu,
    )
    .run();

  if (form) {
    const adP = form.get("ad");
    if (isFile(adP) && adP.size > 0 && adP.size < MAX_MIME_BYTES) await storeAd(env, "portal_tips", tip.id, `ad/portal-${tip.id}`, adP);
  }

  try {
    await sendPortalPackage(env, tip, blobs);
  } catch (e) {
    await notifyError(env, "telegram-portal", e);
  }
  return { status: 201, body: { id, files: files.length } };
}

/** Was im Portal hochzuladen ist: 1 Datei = Anschreiben, 2 = plus angepasster Lebenslauf, mehr = altes Vollpaket. */
function portalUploadHint(nFiles: number): string {
  if (nFiles === 1) return "Lade das Anschreiben herunter und häng es im Portal an. Lebenslauf, Zeugnisse und Zertifikate hast du selbst.";
  if (nFiles === 2) {
    return "Lade das Anschreiben und den angepassten Lebenslauf herunter und häng beide im Portal an. Zeugnisse und Zertifikate hast du selbst.";
  }
  if (nFiles > 2) return "Alles Nötige ist unten angehängt.";
  return "Noch keine Dateien zu diesem Tipp.";
}

export function portalText(
  tip: Pick<PortalTip, "id" | "company" | "role" | "url" | "why" | "deadline" | "notes"> & { hslu?: string | null },
  nFiles: number,
): string {
  const e = escapeHtml;
  const out = [
    `📦 <b>Portal-Paket: ${e(tip.company)}</b>`,
    e(tip.role),
    "",
    "Hier musst du dich selbst im Portal bewerben. Zählt nicht als Bewerbung des Agenten.",
    "",
    portalUploadHint(nFiles),
  ];
  const h = parseHslu(tip.hslu);
  if (h) out.push("", `📎 HSLU-Bestätigung anhängen: <b>${h.attach ? "Ja" : "Nein"}</b>${h.reason ? ` (${e(h.reason)})` : ""}`);
  if (tip.url) out.push("", `<b>Link:</b> ${e(tip.url)}`);
  if (tip.deadline) out.push(`<b>Frist:</b> ${e(tip.deadline)}`);
  if (tip.why) out.push("", `<b>Warum:</b> ${e(tip.why)}`);
  if (tip.notes) out.push("", `<b>Im Portal betonen:</b> ${e(tip.notes)}`);
  if (nFiles) out.push("", `<b>Dateien (${nFiles}):</b> folgen direkt unter dieser Nachricht.`);
  return out.join("\n");
}

/** Offene Portal-Stellen (status new) holen. Mit id nur diese eine, egal welcher Status. */
export async function openPortalTips(env: Env, id?: string): Promise<PortalTip[]> {
  const rows = id
    ? await env.DB.prepare("SELECT * FROM portal_tips WHERE id = ?").bind(id).all<PortalTip>()
    : await env.DB.prepare("SELECT * FROM portal_tips WHERE status = 'new' ORDER BY created_at").all<PortalTip>();
  return rows.results;
}

/**
 * Portal-Pakete erneut schicken, samt gespeicherter Unterlagen. Jedes Paket für sich: ein Fehler
 * wird gemeldet und blockiert die übrigen nicht. Liefert die ids der zugestellten und fehlgeschlagenen.
 */
export async function resendPortalTips(env: Env, tips: PortalTip[]): Promise<{ sent: string[]; failed: string[] }> {
  const sent: string[] = [];
  const failed: string[] = [];
  for (const tip of tips) {
    try {
      const blobs: File[] = [];
      for (const f of JSON.parse(tip.files ?? "[]") as { key: string; name: string }[]) {
        const data = await env.FILES.get(f.key, "arrayBuffer");
        if (data) blobs.push(new File([data], f.name, { type: "application/pdf" }));
      }
      await sendPortalPackage(env, tip, blobs);
      sent.push(tip.id);
    } catch (e) {
      failed.push(tip.id);
      await notifyError(env, `portal ${tip.company}`, e);
    }
  }
  return { sent, failed };
}

async function sendPortalPackage(env: Env, tip: PortalTip, blobs: File[]): Promise<void> {
  await sendMessage(env, portalText(tip, blobs.length));
  for (const f of blobs) await sendDocument(env, f, f.name || "Datei.pdf");
  const keyboard: InlineKeyboard = [[
    { text: "✅ Beworben", callback_data: `tip_applied:${tip.id}` },
    { text: "❌ Nicht interessiert", callback_data: `tip_dismiss:${tip.id}` },
  ]];
  await sendMessage(env, `Hast du dich bei <b>${escapeHtml(tip.company)}</b> beworben?`, keyboard);
}

export const CHECKPOINT_KEY = "checkpoint";
const CHECKPOINT_MAX_BYTES = 20 * 1024 * 1024;
const CHECKPOINT_TTL_SEC = 3 * 86400;

/** Zwischenstand der Routine (tar.gz mit Entwürfen, Fortschritt, geänderten Daten-Repo-Dateien). Ein Lauf, der am
 * Nutzungslimit abbricht, setzt beim nächsten Start dort wieder an. Gelöscht wird er mit der Abschluss-Notiz. */
export async function putCheckpoint(env: Env, body: ArrayBuffer, now = new Date()): Promise<ApiResult> {
  if (!body.byteLength) return { status: 400, body: { error: "leerer Zwischenstand" } };
  if (body.byteLength > CHECKPOINT_MAX_BYTES) return { status: 413, body: { error: "Zwischenstand zu gross" } };
  await env.FILES.put(CHECKPOINT_KEY, body, { expirationTtl: CHECKPOINT_TTL_SEC, metadata: { saved_at: now.toISOString() } });
  await setSetting(env.DB, "run_lease", now.toISOString()); // der Lauf lebt noch
  return { status: 200, body: { ok: true, bytes: body.byteLength } };
}

/** Wie lange eine Anmeldung ohne neuen Zwischenstand gilt. Danach gilt der Lauf als abgebrochen. */
export const LEASE_MIN = 90;

/** Anmeldung eines Routine-Starts: "done" (heute erledigt), "running" (ein anderer Lauf ist aktiv) oder "claimed"
 * (dieser Start arbeitet). Atomar über ein bedingtes UPSERT, damit nie zwei Läufe derselben Person parallel arbeiten. */
export async function claimRun(env: Env, now = new Date()): Promise<ApiResult> {
  const settings = await getSettings(env.DB);
  if (settings.routine_note_date === zonedParts(now, env.TZ_NAME).dateKey) return { status: 200, body: { state: "done" } };
  const cutoff = new Date(now.getTime() - LEASE_MIN * 60000).toISOString();
  const r = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('run_lease', ?1)
     ON CONFLICT(key) DO UPDATE SET value = ?1 WHERE settings.value IS NULL OR settings.value = '' OR settings.value < ?2`,
  ).bind(now.toISOString(), cutoff).run();
  return { status: 200, body: { state: r.meta.changes ? "claimed" : "running" } };
}

/** Notiz der Routine für den heutigen Rapport (z. B. warum heute keine Bewerbung kam). */
export async function setRoutineNote(env: Env, raw: unknown, now = new Date()): Promise<ApiResult> {
  const text = raw && typeof raw === "object" ? (raw as Record<string, unknown>).text : undefined;
  if (!str(text)) return { status: 400, body: { error: "text ist Pflicht" } };
  await setSetting(env.DB, "routine_note", text.trim().slice(0, 1000));
  await setSetting(env.DB, "routine_note_date", zonedParts(now, env.TZ_NAME).dateKey);
  // Der Lauf ist abgeschlossen: Zwischenstand und Anmeldung werden nicht mehr gebraucht.
  await env.FILES.delete(CHECKPOINT_KEY);
  await setSetting(env.DB, "run_lease", "");
  return { status: 200, body: { ok: true } };
}

/** Hat die Routine heute schon ihre Abschluss-Notiz geschrieben? Ohne Nebenwirkung (anders als getState,
 * das Feedback als gelesen markiert), damit Wiederholungsläufe nach einem Limit gefahrlos nachfragen können. */
export async function getDoneToday(env: Env, now = new Date()): Promise<ApiResult> {
  const settings = await getSettings(env.DB);
  const today = zonedParts(now, env.TZ_NAME).dateKey;
  return { status: 200, body: { done: settings.routine_note_date === today, date: today } };
}

export async function getState(env: Env, now = new Date()): Promise<ApiResult> {
  const settings = await getSettings(env.DB);
  const apps = await env.DB.prepare(
    `SELECT id, company, company_domain, role, kind, status, created_at, sent_at, reply_class
     FROM applications ORDER BY created_at DESC`,
  ).all();
  const tipsSince = new Date(now.getTime() - 60 * 86400000).toISOString();
  const tips = await env.DB.prepare("SELECT * FROM portal_tips WHERE created_at >= ? ORDER BY created_at DESC")
    .bind(tipsSince)
    .all();
  const fb = await env.DB.prepare("SELECT id, created_at, application_id, text FROM feedback WHERE read_at IS NULL ORDER BY id")
    .all<{ id: number }>();
  if (fb.results.length) {
    const maxId = fb.results[fb.results.length - 1].id;
    await env.DB.prepare("UPDATE feedback SET read_at = ? WHERE read_at IS NULL AND id <= ?").bind(now.toISOString(), maxId).run();
  }
  const { awaiting_feedback_for: _a, ...publicSettings } = settings;
  return {
    status: 200,
    body: {
      settings: publicSettings,
      applications: apps.results,
      portal_tips: tips.results,
      feedback: fb.results,
      stats: {
        sent_total: await countSentTotal(env.DB),
        sent_today: await countSentSince(env.DB, startOfZonedDay(now, env.TZ_NAME).toISOString()),
      },
    },
  };
}

