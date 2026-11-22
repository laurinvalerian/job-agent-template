import { describe, expect, it } from "vitest";
import { buildReport, gatherReportData, type ReportData } from "../src/report";
import { insertApp, makeEnv } from "./helpers";

const base: ReportData = {
  today: [{ company: "Acme AG", status: "sent" }],
  waiting: [{ company: "Beta AG" }],
  note: null,
};
const quiet: ReportData = { today: [], waiting: [], note: null };

describe("Rapport-Text", () => {
  const text = buildReport(base);

  it("nur Neues und Offenes, Handlungsbedarf zuerst", () => {
    const order = ["Wartet auf dich: <b>Beta AG</b>", "Beworben: <b>Acme AG</b>"];
    const idx = order.map((h) => text.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(text.split("\n")).toHaveLength(2);
  });

  it("keine Gmail-Antworten und keine offenen Portal-Stellen", () => {
    expect(text).not.toMatch(/geantwortet|Portal/);
  });

  it("lässt Vorhersehbares weg: kein Datum, keine Zähler, nichts Leeres", () => {
    expect(text).not.toMatch(/\d{2}\.\d{2}\.|Woche|total|Rapport/);
    expect(buildReport({ ...quiet, today: [{ company: "Acme AG", status: "sent" }] })).toBe("✅ Beworben: <b>Acme AG</b>");
  });

  it("Fehler stehen vor dem Beworben", () => {
    const t = buildReport({ ...quiet, today: [{ company: "A", status: "sent" }, { company: "B", status: "failed" }] });
    expect(t.indexOf("fehlgeschlagen")).toBeLessThan(t.indexOf("Beworben"));
  });

  it("kürzt lange Namenslisten", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ company: `F${i}` }));
    expect(buildReport({ ...quiet, waiting: many })).toContain("<b>F3</b> +2");
  });

  it("ruhiger Tag: eine Zeile, mit Notiz der Routine falls vorhanden", () => {
    expect(buildReport(quiet)).toBe("😴 Nichts Neues.");
    expect(buildReport({ ...quiet, note: "nichts über der Qualitätsschwelle" })).toBe("😴 Nichts Neues. nichts über der Qualitätsschwelle");
    expect(buildReport({ ...base, note: "x" })).not.toContain("Nichts Neues");
  });

  it("escapet HTML und enthält keine Gedankenstriche", () => {
    expect(buildReport({ ...quiet, waiting: [{ company: "A & B" }] })).toContain("A &amp; B");
    expect(/[\u2014\u2013]/.test(text)).toBe(false);
  });
});

describe("Rapport-Daten aus D1", () => {
  it("holt nur heutige Bewerbungen und offene Freigaben", async () => {
    const { env, raw } = makeEnv();
    const now = new Date("2026-10-28T21:00:00Z"); // Mi 22:00 CET
    insertApp(raw, { id: "a", status: "sent", created_at: "2026-10-28T06:00:00.000Z", sent_at: "2026-10-28T07:10:00.000Z" });
    insertApp(raw, { id: "b", company_domain: "b.ch", status: "sent", created_at: "2026-10-20T06:00:00.000Z", sent_at: "2026-10-20T07:10:00.000Z" });
    insertApp(raw, { id: "c", company_domain: "c.ch", status: "pending_approval", created_at: "2026-10-28T06:00:00.000Z" });
    raw.prepare("INSERT INTO portal_tips (id, created_at, company, role, status) VALUES ('t1', ?, 'P AG', 'Rolle', 'new')").run(now.toISOString());
    raw.prepare("INSERT INTO portal_tips (id, created_at, company, role, status) VALUES ('t2', ?, 'Q AG', 'Rolle', 'applied_by_user')").run(now.toISOString());
    const d = await gatherReportData(env, now);
    expect(d.today.map((x) => x.status).sort()).toEqual(["pending_approval", "sent"]);
    expect(d.waiting).toHaveLength(1);
    expect(d).not.toHaveProperty("tips");
  });
});
