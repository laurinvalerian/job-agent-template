// Leichte Prüfung einer fertigen RFC822-Nachricht: nur der Header-Block in den ersten 8 KB.

export const HEAD_BYTES = 8 * 1024;

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** RFC 2047 encoded-words (B und Q) dekodieren. Leerraum zwischen zwei encoded-words entfällt. */
export function decodeEncodedWords(value: string): string {
  const re = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g, "$1")
    .replace(re, (_m, charset: string, enc: string, text: string) => {
      let bytes: Uint8Array;
      if (enc.toUpperCase() === "B") {
        try {
          const bin = atob(text);
          bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } catch {
          return text;
        }
      } else {
        const out: number[] = [];
        const s = text.replace(/_/g, " ");
        for (let i = 0; i < s.length; i++) {
          if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
            out.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            out.push(s.charCodeAt(i) & 0xff);
          }
        }
        bytes = Uint8Array.from(out);
      }
      return decodeBytes(bytes, charset);
    });
}

/** Header-Block (entfaltet) aus dem Anfang einer Nachricht. Schlüssel in Kleinbuchstaben, erster Treffer gewinnt. */
export function parseHeaders(head: Uint8Array | string): Map<string, string> {
  const text = typeof head === "string" ? head : new TextDecoder().decode(head);
  const end = text.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(i + 1).trim());
  }
  return headers;
}

export interface MimeCheck {
  ok: boolean;
  error?: string;
  subject?: string;
}

/** Prüft To (enthält toEmail) und Subject (vorhanden, ohne Gedankenstriche) der fertigen Nachricht. */
export function checkMimeHead(head: Uint8Array | string, toEmail: string): MimeCheck {
  const h = parseHeaders(head);
  const to = h.get("to");
  if (!to) return { ok: false, error: "MIME: To-Header fehlt in den ersten 8 KB" };
  if (!to.toLowerCase().includes(toEmail.trim().toLowerCase())) {
    return { ok: false, error: "MIME: To-Header enthält meta.to_email nicht" };
  }
  const raw = h.get("subject");
  if (!raw) return { ok: false, error: "MIME: Subject-Header fehlt" };
  const subject = decodeEncodedWords(raw);
  if (/[—–]/.test(subject)) {
    return { ok: false, error: "MIME: Subject enthält Gedankenstriche (Em-Dash U+2014 oder En-Dash U+2013)" };
  }
  return { ok: true, subject };
}

/** RFC 5322 Date-Header, z. B. "Mon, 26 Oct 2026 07:05:00 +0000". */
export function rfc822Date(d: Date): string {
  return d.toUTCString().replace("GMT", "+0000");
}
