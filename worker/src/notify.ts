import type { Env } from "./env";
import { escapeHtml, sendMessage } from "./telegram";

/** Entfernt alles, was wie ein Secret aussieht, bevor ein Fehler geloggt oder gemeldet wird. */
export function redact(env: Partial<Env>, text: string): string {
  let out = text;
  for (const key of ["ROUTINE_TOKEN", "ADMIN_TOKEN", "TELEGRAM_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const) {
    const v = env[key];
    if (typeof v === "string" && v.length >= 6) out = out.split(v).join("***");
  }
  return out.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***").replace(/ya29\.[A-Za-z0-9._-]+/g, "***");
}

/** Fehler loggen und höchstens 1x pro Stunde pro Art per Telegram melden (KV-Flag). */
export async function notifyError(env: Env, kind: string, err: unknown): Promise<void> {
  const msg = redact(env, err instanceof Error ? err.message : String(err)).slice(0, 800);
  console.error(`[${kind}] ${msg}`);
  try {
    const flagKey = `errflag:${kind}`;
    if (await env.FILES.get(flagKey)) return;
    await env.FILES.put(flagKey, "1", { expirationTtl: 3600 });
    await sendMessage(env, `⚠️ <b>Fehler: ${escapeHtml(kind)}</b>\n${escapeHtml(msg)}`);
  } catch (e) {
    console.error(`[notifyError] ${redact(env, e instanceof Error ? e.message : String(e))}`);
  }
}
