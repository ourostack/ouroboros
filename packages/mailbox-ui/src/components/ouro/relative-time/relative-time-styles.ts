const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];
const DAY_SECONDS = 24 * 3600;
const DAY_MS = DAY_SECONDS * 1000;

/**
 * "3 days ago", "in 5 minutes", "now": the largest whole unit to an instant, rounded.
 *
 * @claim "the largest whole unit to an instant" registry/ouro/components/ouro/relative-time/relative-time.test.tsx verify:fileLine(registry/ouro/components/ouro/relative-time/relative-time.test.tsx, /\[5\s\*\sMINUTE\s\+\s10\s\*\sSECOND,\s"auto",\s"in\s5\sminutes"\]/)
 */
export function relative(date: Date, at: number, locale: Intl.LocalesArgument, numeric: "auto" | "always"): string {
  const seconds = (date.getTime() - at) / 1000;
  const [unit, size] = units.find(([, length]) => Math.abs(seconds) >= length) ?? ["second", 1];
  const amount = unit === "second" && Math.abs(seconds) < 45 ? 0 : Math.round(seconds / size);
  return new Intl.RelativeTimeFormat(locale, { numeric }).format(amount, unit);
}

/**
 * "tomorrow", "in 3 days", "this month": how far a calendar date (`"2026-06-01"`, or `"2026-06"`
 * for a month) is from the day it is at `at` in `timeZone` (the reader's when undefined), in
 * whole days, or whole months for a month, so it turns over at the reader's own midnight.
 */
export function calendarRelative(value: string, at: number, locale: Intl.LocalesArgument, numeric: "auto" | "always", timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at);
  const today = (type: "year" | "month" | "day") => Number(parts.find((part) => part.type === type)!.value);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number | undefined];
  const format = new Intl.RelativeTimeFormat(locale, { numeric });
  if (day === undefined) {
    const months = year * 12 + month - (today("year") * 12 + today("month"));
    return Math.abs(months) >= 12 ? format.format(Math.round(months / 12), "year") : format.format(months, "month");
  }
  const days = (Date.UTC(year, month - 1, day) - Date.UTC(today("year"), today("month") - 1, today("day"))) / DAY_MS;
  const [unit, size] = units.find(([, length]) => Math.abs(days) * DAY_SECONDS >= length) ?? ["day", DAY_SECONDS];
  return format.format(Math.round((days * DAY_SECONDS) / size), unit);
}
