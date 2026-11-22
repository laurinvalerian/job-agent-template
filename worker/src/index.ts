import { getRawMessage, getSentPdf, getThreadTexts, sendRawMessage } from "./gmail";
import { handleUpdate, type TgUpdate } from "./bot";
import type { Env } from "./env";
import { processInbox } from "./inbox-watch";
import { notifyError } from "./notify";
import { createApplication, createPortalTip, claimRun, getDoneToday, getState, CHECKPOINT_KEY, putCheckpoint, openPortalTips, resendPortalTips, resendPending, setRoutineNote, type ApiResult } from "./queue";
import { createRavDraft, createRavReport, getRav } from "./rav";
import { maybeSendDailyReport } from "./report";
import { processScheduled } from "./send";
import { setWebhook } from "./telegram";

const json = (r: ApiResult) => Response.json(r.body, { status: r.status });

/** Vergleich in konstanter Zeit, damit Tokens nicht über Timing erraten werden können. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") ?? "";
  // ROUTINE_TOKEN für die Cloud-Routine, ADMIN_TOKEN (optional) für lokale Sitzungen
  return (!!env.ROUTINE_TOKEN && safeEqual(h, `Bearer ${env.ROUTINE_TOKEN}`)) || (!!env.ADMIN_TOKEN && safeEqual(h, `Bearer ${env.ADMIN_TOKEN}`));
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

async function readForm(req: Request): Promise<FormData | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return null;
  try {
    return await req.formData();
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /health") return new Response("ok");

    if (route === "POST /telegram") {
      const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await readJson(req)) as TgUpdate | undefined;
      if (update) {
        try {
          await handleUpdate(env, update, ctx);
        } catch (e) {
          await notifyError(env, "telegram-webhook", e);
        }
      }
      // Immer 200, damit Telegram nicht endlos wiederholt
      return new Response("ok");
    }

    // Öffentlich, verrät nur "heute fertig ja/nein": so kann die Routine der zweiten Person warten, bis die erste fertig ist.
    if (route === "GET /done-today") return json(await getDoneToday(env));

    if (url.pathname.startsWith("/api/")) {
      if (!authorized(req, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        switch (route) {
          case "POST /api/applications": {
            const form = await readForm(req);
            if (!form) return Response.json({ error: "multipart/form-data erwartet (meta, mime, optional preview)" }, { status: 415 });
            return json(await createApplication(env, form));
          }
          case "POST /api/portal-tips": {
            const form = await readForm(req);
            return json(await createPortalTip(env, form ? undefined : await readJson(req), new Date(), form));
          }
          case "POST /api/portal-resend": {
            // Offene Portal-Pakete (oder eines per id) nochmals per Telegram schicken
            const b = (await readJson(req)) as { id?: unknown } | undefined;
            const id = typeof b?.id === "string" && b.id.trim() ? b.id.trim() : undefined;
            const tips = await openPortalTips(env, id);
            if (id && !tips.length) return Response.json({ error: "nicht gefunden" }, { status: 404 });
            return Response.json(await resendPortalTips(env, tips));
          }
          case "POST /api/pending-resend":
            return Response.json(await resendPending(env));
          case "POST /api/note":
            return json(await setRoutineNote(env, await readJson(req)));
          case "GET /api/file": {
            // Nur Inserat-Screenshots und Portal-Anschreiben herausgeben (für RAV-Liste und Monatsentwurf der Routine)
            const key = url.searchParams.get("key") ?? "";
            if (!/^(ad\/[A-Za-z0-9._-]{1,120}|portal\/[A-Za-z0-9._-]{1,60}\/\d)$/.test(key)) return Response.json({ error: "ungültiger key" }, { status: 400 });
            const data = await env.FILES.get(key, "arrayBuffer");
            if (!data) return Response.json({ error: "nicht gefunden" }, { status: 404 });
            return new Response(data, { headers: { "content-type": "application/pdf" } });
          }
          case "GET /api/letter": {
            // Anschreiben-PDF einer versendeten Bewerbung aus dem Gesendet-Ordner (für den Monatsentwurf)
            const id = url.searchParams.get("id") ?? "";
            const row = await env.DB.prepare("SELECT gmail_message_id FROM applications WHERE id = ? AND status = 'sent'").bind(id).first<{ gmail_message_id: string | null }>();
            if (!row?.gmail_message_id) return Response.json({ error: "nicht gefunden" }, { status: 404 });
            const pdf = await getSentPdf(env, row.gmail_message_id, "Anschreiben");
            if (!pdf) return Response.json({ error: "kein Anschreiben-PDF in der Mail" }, { status: 404 });
            return new Response(pdf.data, { headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent(pdf.name) } });
          }
          case "GET /api/thread": {
            // Antworten und Bounces einer versendeten Bewerbung lesen (nur Lesen, Admin)
            const id = url.searchParams.get("id") ?? "";
            const row = await env.DB.prepare("SELECT gmail_thread_id FROM applications WHERE id = ?").bind(id).first<{ gmail_thread_id: string | null }>();
            if (!row?.gmail_thread_id) return Response.json({ error: "nicht gefunden" }, { status: 404 });
            return Response.json({ messages: await getThreadTexts(env, row.gmail_thread_id) });
          }
          case "POST /api/resend-corrected": {
            // Zugestellte-Bounce korrigieren: gleiche Mail (inkl. Anhänge) an die richtige Adresse. Nur wenn der Thread einen Zustellfehler enthält.
            const b = (await req.json().catch(() => ({}))) as { id?: string; to?: string };
            if (!b.id || !b.to || !/^[^\s<>,;"]+@[^\s<>,;"]+\.[a-z]{2,}$/i.test(b.to)) return Response.json({ error: "id und to erwartet" }, { status: 400 });
            const row = await env.DB.prepare("SELECT gmail_message_id, gmail_thread_id, to_name FROM applications WHERE id = ? AND status = 'sent'").bind(b.id).first<{ gmail_message_id: string; gmail_thread_id: string; to_name: string | null }>();
            if (!row?.gmail_message_id) return Response.json({ error: "nicht gefunden" }, { status: 404 });
            const bounced = (await getThreadTexts(env, row.gmail_thread_id)).some((m) => /mailer-daemon|postmaster/i.test(m.from));
            if (!bounced) return Response.json({ error: "kein Zustellfehler im Thread, nichts zu korrigieren" }, { status: 409 });
            const raw = new TextDecoder("latin1").decode(await getRawMessage(env, row.gmail_message_id));
            const end = raw.search(/\r?\n\r?\n/);
            const headers = raw.slice(0, end).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).filter((l) => !/^(to|cc|bcc|message-id|date|delivered-to|received|return-path|x-gm-message-state|x-google-[^:]*|x-received|arc-[^:]*|authentication-results|received-spf|dkim-signature):/i.test(l));
            const toHeader = row.to_name ? `To: ${row.to_name} <${b.to}>` : `To: ${b.to}`;
            const fixed = [...headers, toHeader].join("\r\n") + raw.slice(end);
            const text = `Date: ${new Date().toUTCString().replace("GMT", "+0000")}\r\n${fixed}`;
            const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff); // latin1 rein/raus, Bytes bleiben unverändert
            const sent = await sendRawMessage(env, bytes);
            await env.DB.prepare("UPDATE applications SET to_email = ?, gmail_message_id = ?, gmail_thread_id = ? WHERE id = ?").bind(b.to, sent.id, sent.threadId, b.id).run();
            return Response.json({ ok: true, gmail_message_id: sent.id });
          }
          case "GET /api/rav":
            return json(await getRav(env, url.searchParams.get("month")));
          case "POST /api/rav-report": {
            const form = await readForm(req);
            if (!form) return Response.json({ error: "multipart/form-data erwartet (meta, mime, optional pdf)" }, { status: 415 });
            return json(await createRavReport(env, form));
          }
          case "POST /api/rav-draft": {
            const form = await readForm(req);
            if (!form) return Response.json({ error: "multipart/form-data erwartet (meta, mime)" }, { status: 415 });
            return json(await createRavDraft(env, form));
          }
          case "POST /api/claim":
            return json(await claimRun(env));
          case "PUT /api/checkpoint":
            return json(await putCheckpoint(env, await req.arrayBuffer()));
          case "GET /api/checkpoint": {
            const cp = await env.FILES.getWithMetadata<{ saved_at?: string }>(CHECKPOINT_KEY, "arrayBuffer");
            if (!cp.value) return Response.json({ error: "kein Zwischenstand" }, { status: 404 });
            return new Response(cp.value, { headers: { "content-type": "application/gzip", "x-saved-at": cp.metadata?.saved_at ?? "" } });
          }
          case "GET /api/state":
            return json(await getState(env));
          case "POST /api/setup-webhook":
            return Response.json({ ok: true, result: await setWebhook(env, `${url.origin}/telegram`) });
        }
      } catch (e) {
        await notifyError(env, `api ${route}`, e);
        return Response.json({ error: "interner Fehler" }, { status: 500 });
      }
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, new Date()));
  },
} satisfies ExportedHandler<Env>;

/** Jeder Teil läuft isoliert: ein Fehler blockiert die anderen nicht. */
export async function runCron(env: Env, now: Date): Promise<void> {
  const parts: [string, () => Promise<unknown>][] = [
    ["versand", () => processScheduled(env, now)],
    ["posteingang", () => processInbox(env, now)],
    ["rapport", () => maybeSendDailyReport(env, now)],
  ];
  for (const [kind, fn] of parts) {
    try {
      await fn();
    } catch (e) {
      await notifyError(env, kind, e);
    }
  }
}
