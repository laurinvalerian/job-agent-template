// Zürich-Zeit ohne externe Libs, über Intl.DateTimeFormat.

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = Montag ... 7 = Sonntag */
  weekday: number;
  /** YYYY-MM-DD in der Zielzeitzone */
  dateKey: string;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function zonedParts(date: Date, tz = "Europe/Zurich"): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Offset der Zeitzone gegenüber UTC in Minuten (Zürich: +60 Winter, +120 Sommer). */
export function tzOffsetMinutes(date: Date, tz = "Europe/Zurich"): number {
  const p = zonedParts(date, tz);
  const second = Number(
    formatter(tz).formatToParts(date).find((x) => x.type === "second")?.value ?? "0",
  );
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** UTC-Zeitpunkt für eine lokale Wanduhrzeit in der Zeitzone. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  tz = "Europe/Zurich",
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - tzOffsetMinutes(new Date(naive), tz) * 60000;
  guess = naive - tzOffsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess);
}

/** Beginn des lokalen Kalendertags (00:00) als UTC-Date. */
export function startOfZonedDay(date: Date, tz = "Europe/Zurich"): Date {
  const p = zonedParts(date, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz);
}

/** Beginn der lokalen Woche (Montag 00:00) als UTC-Date. */
export function startOfZonedWeek(date: Date, tz = "Europe/Zurich"): Date {
  const p = zonedParts(date, tz);
  const mondayNoon = new Date(Date.UTC(p.year, p.month - 1, p.day, 12) - (p.weekday - 1) * 86400000);
  return zonedToUtc(
    mondayNoon.getUTCFullYear(),
    mondayNoon.getUTCMonth() + 1,
    mondayNoon.getUTCDate(),
    0,
    0,
    tz,
  );
}

/** Versandfenster: Mo-Fr, 08:00 bis vor 10:30 Lokalzeit. */
export function isSendWindow(date: Date, tz = "Europe/Zurich"): boolean {
  const p = zonedParts(date, tz);
  if (p.weekday < 1 || p.weekday > 5) return false;
  const m = p.hour * 60 + p.minute;
  return m >= 8 * 60 && m < 10 * 60 + 30;
}

/** Rapport ab 22:00 Lokalzeit (einmal pro Tag, über last_report_date). */
export function isReportDue(date: Date, lastReportDate: string, tz = "Europe/Zurich"): boolean {
  const p = zonedParts(date, tz);
  return p.hour >= 22 && lastReportDate !== p.dateKey;
}

/** Ganze Kalendertage zwischen zwei Zeitpunkten in Lokalzeit. */
export function zonedDaysBetween(fromIso: string, to: Date, tz = "Europe/Zurich"): number {
  const a = zonedParts(new Date(fromIso), tz);
  const b = zonedParts(to, tz);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000,
  );
}
