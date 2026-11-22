import { describe, expect, it } from "vitest";
import { checkMimeHead, decodeEncodedWords, parseHeaders, rfc822Date } from "../src/rfc822";
import { sampleMime } from "./helpers";

const EM = String.fromCharCode(0x2014);
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("RFC 2047 dekodieren", () => {
  it("B- und Q-Kodierung, Umlaute, mehrere Wörter", () => {
    expect(decodeEncodedWords(`=?utf-8?b?${b64("Bewerbung Zürich")}?=`)).toBe("Bewerbung Zürich");
    expect(decodeEncodedWords("=?UTF-8?Q?Gr=C3=BCsse_aus_Z=C3=BCrich?=")).toBe("Grüsse aus Zürich");
    expect(decodeEncodedWords(`=?utf-8?b?${b64("Teil ")}?=\r\n =?utf-8?b?${b64("zwei")}?=`.replace(/\r\n /, " "))).toBe("Teil zwei");
    expect(decodeEncodedWords("Plain ASCII")).toBe("Plain ASCII");
  });
});

describe("Header der fertigen Nachricht prüfen", () => {
  it("akzeptiert passende Nachricht und liefert dekodierten Betreff", () => {
    const r = checkMimeHead(sampleMime(), "jobs@acme.ch");
    expect(r).toEqual({ ok: true, subject: "Bewerbung als IT Supporter" });
  });

  it("entfaltet gefaltete Header", () => {
    const h = parseHeaders("To: Frau Muster\r\n <jobs@acme.ch>\r\nSubject: x\r\n\r\nBody: nein");
    expect(h.get("to")).toBe("Frau Muster <jobs@acme.ch>");
    expect(h.has("body")).toBe(false);
  });

  it("lehnt falschen oder fehlenden Empfänger ab", () => {
    expect(checkMimeHead(sampleMime({ to: "andere@firma.ch" }), "jobs@acme.ch").ok).toBe(false);
    expect(checkMimeHead("Subject: x\r\n\r\n", "jobs@acme.ch").ok).toBe(false);
    expect(checkMimeHead(sampleMime({ to: "JOBS@Acme.ch" }), "jobs@acme.ch").ok).toBe(true);
  });

  it("lehnt Gedankenstriche im Subject ab, roh, B- und Q-kodiert", () => {
    expect(checkMimeHead(sampleMime({ subject: `Bewerbung ${EM} IT` }), "jobs@acme.ch").ok).toBe(false);
    expect(checkMimeHead(sampleMime({ subject: `=?utf-8?b?${b64(`Bewerbung ${EM} IT`)}?=` }), "jobs@acme.ch").ok).toBe(false);
    expect(checkMimeHead(sampleMime({ subject: "=?utf-8?q?Bewerbung_=E2=80=93_IT?=" }), "jobs@acme.ch").ok).toBe(false);
    expect(checkMimeHead(sampleMime({ subject: "=?utf-8?q?IT-Supporter_2020-2024?=" }), "jobs@acme.ch").ok).toBe(true);
  });

  it("Date-Format nach RFC 5322", () => {
    expect(rfc822Date(new Date("2026-10-26T07:05:00Z"))).toBe("Mon, 26 Oct 2026 07:05:00 +0000");
  });
});
