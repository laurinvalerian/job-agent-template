import { autoAllowed, dropMessage, openPortalTips, resendPortalTips } from "./queue";
import { addFeedback, countSentSince, countSentTotal, getApplication, getSettings, setPortalTipStatus, setSetting, transitionStatus } from "./db";
import type { Application, Env } from "./env";
import { notifyError } from "./notify";
import {
  ART_LABEL,
  EXTERN_EXAMPLE,
  formatDateCh,
  insertExternal,
  parseExternArgs,
  parseResult,
  ravStatusText,
  RESULT_LABEL,
  setResultByKennung,
} from "./rav";
import { sendReport } from "./report";
import { sendApplication, sendHeldNow } from "./send";
import { answerCallback, clearButtons, escapeHtml, sendMessage } from "./telegram";
import { isSendWindow, startOfZonedDay } from "./time";

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage };
}

export const HELP_TEXT = [
  "<b>Befehle</b>",
  "/status: aktueller Stand",
  "/report: Rapport sofort",
  "/senden: alle freigegebenen Bewerbungen sofort senden, auch ausserhalb des Versandfensters",
  "/pause und /resume: Versand anhalten oder fortsetzen",
  "/auto on oder /auto off: automatischer Versand ohne Freigabe",
  "/portal: alle offenen Portal-Stellen mit Anschreiben und Unterlagen nochmals schicken (/portal &lt;id&gt; für eine)",
  "/applied &lt;id&gt;: Portal-Tipp als selbst beworben markieren",
  "/dismiss &lt;id&gt;: Portal-Tipp ausblenden",
  "/feedback &lt;text&gt;: Rückmeldung für die Routine",
  "",
  "<b>RAV-Nachweis</b>",
  "/extern Firma; Stelle; Datum; Art; Pensum: selbst gemachte Bewerbung erfassen (Datum, Art und Pensum optional; Art: schriftlich, elektronisch, telefonisch, persönlich, portal)",
  "/ergebnis &lt;kennung&gt; offen|absage|einladung|anstellung: Ergebnis setzen (Kennung: Bewerbungs-id, Portal-Tipp-id oder e123)",
  "/rav: Einträge des laufenden Monats",
  "/help: diese Hilfe",
  "",
  "Freier Text wird als Feedback gespeichert.",
].join("\n");

/** Verarbeitet ein Telegram-Update. Updates aus fremden Chats werden ignoriert. */
export async function handleUpdate(env: Env, update: TgUpdate, ctx?: Pick<ExecutionContext, "waitUntil">, now = new Date()): Promise<void> {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (chatId === undefined || String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return;
  if (update.callback_query) return handleCallback(env, update.callback_query, ctx, now);
  const text = update.message?.text?.trim();
  if (text) return handleText(env, text, ctx, now);
}

async function handleCallback(
  env: Env,
  cq: NonNullable<TgUpdate["callback_query"]>,
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
  now: Date,
): Promise<void> {
  const [action, id] = (cq.data ?? "").split(/:(.*)/s);
  if (action === "tip_applied" || action === "tip_dismiss") return handleTipCallback(env, cq, action, id, now);
  const app = id ? await getApplication(env.DB, id) : null;
  if (!app) {
    await answerCallback(env, cq.id, "Bewerbung nicht gefunden");
    return;
  }
  const done = async (toast: string) => {
    await answerCallback(env, cq.id, toast);
    if (cq.message) await clearButtons(env, cq.message.chat.id, cq.message.message_id);
  };
  const name = `<b>${escapeHtml(app.company)}</b>`;

  switch (action) {
    case "approve": {
      if (!(await transitionStatus(env.DB, id, ["pending_approval"], "scheduled"))) return done("Bereits erledigt");
      await done("Eingeplant");
      const s = await getSettings(env.DB);
      let extra = "";
      if (!autoAllowed(env)) {
        extra = "";
      } else if (s.mode === "trial" && s.trial_remaining > 0) {
        const left = s.trial_remaining - 1;
        await setSetting(env.DB, "trial_remaining", left);
        extra = left === 0 ? "\n\n✅ Probelauf fertig, /auto on zum Umschalten." : `\nProbelauf: noch ${left} Freigaben.`;
      }
      if (isSendWindow(now, env.TZ_NAME)) {
        await sendMessage(env, `✅ ${name} eingeplant. Versand in den nächsten Minuten.${extra}`);
        return;
      }
      await sendMessage(env, `✅ ${name} eingeplant. Versand im nächsten Fenster Mo-Fr 08:00 bis 10:30.${extra}`, [[
        { text: "📤 Jetzt senden", callback_data: `send_now:${id}` },
      ]]);
      return;
    }
    case "approve_now": {
      if (!(await transitionStatus(env.DB, id, ["pending_approval"], "scheduled"))) return done("Bereits erledigt");
      await done("Wird gesendet");
      const fresh = await getApplication(env.DB, id);
      const job = (fresh ? sendApplication(env, fresh, now) : Promise.resolve(false)).catch((e) => notifyError(env, "versand", e));
      if (ctx) ctx.waitUntil(job);
      else await job;
      return;
    }
    case "send_now": {
      if (app.status !== "scheduled") return done("Bereits erledigt");
      await done("Wird gesendet");
      const job = sendApplication(env, app, now).catch((e) => notifyError(env, "versand", e));
      if (ctx) ctx.waitUntil(job);
      else await job;
      return;
    }
    case "reject": {
      if (!(await transitionStatus(env.DB, id, ["pending_approval"], "rejected_by_user"))) return done("Bereits erledigt");
      await done("Verworfen");
      await dropMessage(env, app);
      await setSetting(env.DB, "awaiting_feedback_for", id);
      await sendMessage(env, `❌ ${name} verworfen. Magst du kurz schreiben, warum? Deine nächste Nachricht speichere ich als Feedback.`);
      return;
    }
    case "brake_send": {
      if (app.status !== "held_brake") return done("Bereits erledigt");
      await done("Wird gesendet");
      const job = sendHeldNow(env, id, now).catch((e) => notifyError(env, "versand", e));
      if (ctx) ctx.waitUntil(job);
      else await job;
      return;
    }
    case "brake_drop": {
      if (!(await transitionStatus(env.DB, id, ["held_brake"], "rejected_by_user"))) return done("Bereits erledigt");
      await done("Verworfen");
      await dropMessage(env, app);
      await sendMessage(env, `❌ ${name} verworfen.`);
      return;
    }
    default:
      await answerCallback(env, cq.id, "Unbekannte Aktion");
  }
}

async function handleTipCallback(
  env: Env,
  cq: NonNullable<TgUpdate["callback_query"]>,
  action: "tip_applied" | "tip_dismiss",
  id: string | undefined,
  now: Date,
): Promise<void> {
  const ok = id ? await setPortalTipStatus(env.DB, id, action === "tip_applied" ? "applied_by_user" : "dismissed", now) : false;
  await answerCallback(env, cq.id, ok ? (action === "tip_applied" ? "Als beworben markiert" : "Ausgeblendet") : "Tipp nicht gefunden");
  if (ok && cq.message) await clearButtons(env, cq.message.chat.id, cq.message.message_id);
  if (ok) await sendMessage(env, action === "tip_applied" ? "👍 Super, als selbst beworben markiert. Viel Erfolg!" : "🗑 Tipp ausgeblendet.");
}

async function handleText(env: Env, text: string, ctx: Pick<ExecutionContext, "waitUntil"> | undefined, now: Date): Promise<void> {
  if (!text.startsWith("/")) {
    const s = await getSettings(env.DB);
    const appId = s.awaiting_feedback_for || null;
    await addFeedback(env.DB, text, appId, now);
    if (appId) await setSetting(env.DB, "awaiting_feedback_for", "");
    await sendMessage(env, appId ? "📝 Danke, Begründung gespeichert." : "📝 Danke, als Feedback gespeichert.");
    return;
  }

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/start":
    case "/help":
      return sendMessage(env, HELP_TEXT);
    case "/status":
      return sendMessage(env, await statusText(env, now));
    case "/report":
      return sendReport(env, now);
    case "/pause":
      await setSetting(env.DB, "paused", true);
      return sendMessage(env, "⏸ Versand pausiert. Neue Bewerbungen warten auf Freigabe. /resume zum Fortsetzen.");
    case "/resume":
      await setSetting(env.DB, "paused", false);
      return sendMessage(env, "▶️ Versand läuft wieder.");
    case "/auto": {
      const v = arg.toLowerCase();
      if (v !== "on" && v !== "off") return sendMessage(env, "Bitte /auto on oder /auto off.");
      if (v === "on" && !autoAllowed(env)) {
        return sendMessage(env, "✋ Die Automatik ist für dich fest ausgeschaltet. Jede Bewerbung geht nur raus, wenn du sie selbst freigibst (📤 Sofort senden oder 🕗 Mo-Fr 08:00).");
      }
      await setSetting(env.DB, "mode", v === "on" ? "auto" : "trial");
      return sendMessage(
        env,
        v === "on" ? "🤖 Automatik an: neue Bewerbungen werden ohne Freigabe eingeplant." : "✋ Automatik aus: jede Bewerbung braucht wieder deine Freigabe.",
      );
    }
    case "/portal": {
      const tips = await openPortalTips(env, arg || undefined);
      if (!tips.length) return sendMessage(env, arg ? `Portal-Tipp ${escapeHtml(arg)} nicht gefunden.` : "Keine offenen Portal-Stellen.");
      await sendMessage(env, tips.length === 1 ? "📦 Schicke das Portal-Paket." : `📦 Schicke ${tips.length} Portal-Pakete.`);
      // Im Hintergrund, damit der Webhook sofort antwortet und Telegram nicht wiederholt
      const job = resendPortalTips(env, tips).catch((e) => notifyError(env, "portal", e));
      if (ctx) ctx.waitUntil(job);
      else await job;
      return;
    }
    case "/senden": {
      const { results } = await env.DB.prepare("SELECT * FROM applications WHERE status = 'scheduled' ORDER BY created_at").all<Application>();
      if (!results.length) return sendMessage(env, "Keine eingeplanten Bewerbungen.");
      for (const a of results) await sendApplication(env, a, now);
      return;
    }
    case "/applied":
    case "/dismiss": {
      if (!arg) return sendMessage(env, `Bitte ${cmd} &lt;id&gt; angeben.`);
      const ok = await setPortalTipStatus(env.DB, arg, cmd === "/applied" ? "applied_by_user" : "dismissed", now);
      if (!ok) return sendMessage(env, `Portal-Tipp ${escapeHtml(arg)} nicht gefunden.`);
      return sendMessage(env, cmd === "/applied" ? "👍 Als selbst beworben markiert." : "🗑 Tipp ausgeblendet.");
    }
    case "/extern":
      return handleExtern(env, arg, now);
    case "/ergebnis":
      return handleErgebnis(env, arg);
    case "/rav":
      return sendMessage(env, await ravStatusText(env, now));
    case "/feedback":
      if (!arg) return sendMessage(env, "Bitte /feedback &lt;text&gt; angeben.");
      await addFeedback(env.DB, arg, null, now);
      return sendMessage(env, "📝 Danke, als Feedback gespeichert.");
    default:
      return sendMessage(env, `Unbekannter Befehl.\n\n${HELP_TEXT}`);
  }
}

async function handleExtern(env: Env, arg: string, now: Date): Promise<void> {
  const p = parseExternArgs(arg, now, env.TZ_NAME);
  if (!p.ok) {
    const hint =
      p.error === "missing"
        ? "Bitte mindestens Firma und Stelle angeben, getrennt mit Semikolon."
        : escapeHtml(p.error);
    return sendMessage(
      env,
      [
        `🙂 ${hint}`,
        "",
        "So geht's:",
        `<code>${escapeHtml(EXTERN_EXAMPLE)}</code>`,
        "",
        "Datum (TT.MM.JJJJ), Art und Pensum sind optional. Ohne Datum nehme ich heute, ohne Art elektronisch.",
      ].join("\n"),
    );
  }
  const v = p.value;
  const id = await insertExternal(env.DB, v, now);
  const details = [formatDateCh(v.applied_on), ART_LABEL[v.art], v.pensum ? `Pensum ${v.pensum}` : null].filter(Boolean).join(", ");
  return sendMessage(
    env,
    [
      `✅ Externe Bewerbung gespeichert (Kennung <b>e${id}</b>)`,
      `<b>${escapeHtml(v.company)}</b>: ${escapeHtml(v.role)}`,
      escapeHtml(details),
      "",
      `Ergebnis später setzen: /ergebnis e${id} absage|einladung|anstellung`,
    ].join("\n"),
  );
}

async function handleErgebnis(env: Env, arg: string): Promise<void> {
  const [kennung, wert, ...extra] = arg.split(/\s+/).filter(Boolean);
  const result = wert ? parseResult(wert) : null;
  if (!kennung || !result || extra.length) {
    return sendMessage(env, "Bitte so: /ergebnis &lt;kennung&gt; offen|absage|einladung|anstellung\nBeispiel: /ergebnis e3 einladung");
  }
  const hit = await setResultByKennung(env.DB, kennung, result);
  if (!hit) return sendMessage(env, `Kennung ${escapeHtml(kennung)} nicht gefunden (Bewerbungs-id, Portal-Tipp-id oder e123).`);
  const icon = result === "anstellung" ? "🎉" : result === "einladung" ? "🤝" : result === "absage" ? "📪" : "📝";
  return sendMessage(env, `${icon} Ergebnis für <b>${escapeHtml(hit.company)}</b> (${escapeHtml(hit.role)}): ${RESULT_LABEL[result]}`);
}

async function statusText(env: Env, now: Date): Promise<string> {
  const s = await getSettings(env.DB);
  const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM applications GROUP BY status").all<{ status: string; n: number }>();
  const by = Object.fromEntries(counts.results.map((r) => [r.status, r.n]));
  const tips = await env.DB.prepare("SELECT COUNT(*) AS n FROM portal_tips WHERE status = 'new'").first<{ n: number }>();
  return [
    "<b>Status</b>",
    `Modus: ${s.mode === "auto" ? "Automatik" : `Probelauf (noch ${s.trial_remaining} Freigaben)`}`,
    `Versand: ${s.paused ? "pausiert" : "aktiv"}`,
    `Heute versendet: ${await countSentSince(env.DB, startOfZonedDay(now, env.TZ_NAME).toISOString())}`,
    `Versendet gesamt: ${await countSentTotal(env.DB)}`,
    `Wartet auf Freigabe: ${by.pending_approval ?? 0}, Notbremse: ${by.held_brake ?? 0}`,
    `Eingeplant: ${by.scheduled ?? 0}, wird gesendet: ${by.sending ?? 0}, fehlgeschlagen: ${by.failed ?? 0}`,
    `Offene Portal-Tipps: ${tips?.n ?? 0}`,
  ].join("\n");
}
