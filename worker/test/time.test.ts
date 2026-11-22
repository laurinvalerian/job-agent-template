import { describe, expect, it } from "vitest";
import { isReportDue, isSendWindow, startOfZonedDay, startOfZonedWeek, tzOffsetMinutes, zonedParts } from "../src/time";

const d = (iso: string) => new Date(iso);

describe("Zürich-Zeit", () => {
  it("kennt Sommer- und Winterzeit rund um den 25.10.2026", () => {
    expect(tzOffsetMinutes(d("2026-10-24T12:00:00Z"))).toBe(120);
    expect(tzOffsetMinutes(d("2026-10-25T00:59:00Z"))).toBe(120); // 02:59 CEST
    expect(tzOffsetMinutes(d("2026-10-25T01:00:00Z"))).toBe(60); // 02:00 CET
    expect(tzOffsetMinutes(d("2026-10-26T12:00:00Z"))).toBe(60);
  });

  it("Versandfenster Mo-Fr 08:00 bis 10:30, vor dem Wechsel (CEST)", () => {
    // Fr 23.10.2026
    expect(isSendWindow(d("2026-10-23T05:59:00Z"))).toBe(false); // 07:59
    expect(isSendWindow(d("2026-10-23T06:00:00Z"))).toBe(true); // 08:00
    expect(isSendWindow(d("2026-10-23T08:29:00Z"))).toBe(true); // 10:29
    expect(isSendWindow(d("2026-10-23T08:30:00Z"))).toBe(false); // 10:30
  });

  it("Versandfenster nach dem Wechsel (CET) verschiebt sich um eine Stunde UTC", () => {
    // Mo 26.10.2026
    expect(isSendWindow(d("2026-10-26T06:00:00Z"))).toBe(false); // 07:00 CET
    expect(isSendWindow(d("2026-10-26T06:59:00Z"))).toBe(false); // 07:59
    expect(isSendWindow(d("2026-10-26T07:00:00Z"))).toBe(true); // 08:00
    expect(isSendWindow(d("2026-10-26T09:29:00Z"))).toBe(true); // 10:29
    expect(isSendWindow(d("2026-10-26T09:30:00Z"))).toBe(false); // 10:30
  });

  it("kein Versand am Wochenende (So 25.10.2026, Tag des Wechsels)", () => {
    expect(zonedParts(d("2026-10-25T08:00:00Z")).weekday).toBe(7);
    expect(isSendWindow(d("2026-10-25T08:00:00Z"))).toBe(false);
    expect(isSendWindow(d("2026-10-24T07:00:00Z"))).toBe(false);
  });

  it("Tagesbeginn ist Zürich-Mitternacht, auch am 25-Stunden-Tag", () => {
    expect(startOfZonedDay(d("2026-10-25T12:00:00Z")).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(startOfZonedDay(d("2026-10-26T12:00:00Z")).toISOString()).toBe("2026-10-25T23:00:00.000Z");
    // 23:30 UTC am 25.10. ist schon der 26.10. in Zürich
    expect(zonedParts(d("2026-10-25T23:30:00Z")).dateKey).toBe("2026-10-26");
  });

  it("Wochenbeginn Montag 00:00 Zürich", () => {
    expect(startOfZonedWeek(d("2026-10-25T20:00:00Z")).toISOString()).toBe("2026-10-18T22:00:00.000Z");
    expect(startOfZonedWeek(d("2026-10-28T20:00:00Z")).toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("Rapport ab 22:00 Lokalzeit, einmal pro Tag", () => {
    expect(isReportDue(d("2026-10-24T19:59:00Z"), "")).toBe(false); // 21:59 CEST
    expect(isReportDue(d("2026-10-24T20:00:00Z"), "")).toBe(true); // 22:00 CEST
    expect(isReportDue(d("2026-10-25T20:59:00Z"), "")).toBe(false); // 21:59 CET
    expect(isReportDue(d("2026-10-25T21:00:00Z"), "")).toBe(true); // 22:00 CET
    expect(isReportDue(d("2026-10-25T21:00:00Z"), "2026-10-25")).toBe(false);
  });
});
