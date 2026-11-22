export const dateFormats: Record<DateFormat, Intl.DateTimeFormatOptions> = {
  date: { dateStyle: "medium" },
  month: { month: "short", year: "numeric" },
  datetime: { dateStyle: "medium", timeStyle: "short" },
  time: { timeStyle: "short" },
};

/** How much of the date and time {@link LocalDate} shows. */
export type DateFormat = "date" | "month" | "datetime" | "time";

/** The instant as a Date, or null when it is not one. */
export function toDate(value: Date | string | number): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A calendar date with no time of day: `"2026-06-01"`, or `"2026-06"` for a month. It names the same day everywhere.
 *
 * @claim "A calendar date with no time" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::dateText > treats only a whole calendar date as one)
 * @claim "It names the same day everywhere" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::dateText > treats only a whole calendar date as one)
 */
const calendarDate = /^\d{4}-\d{2}(-\d{2})?$/;

/**
 * Whether `value` is a calendar date with no time of day (`"2026-06-01"`, `"2026-06"`), which no time zone moves.
 *
 * @claim "Whether `value` is a calendar date" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::dateText > treats only a whole calendar date as one)
 */
export function isCalendarDate(value: Date | string | number): value is string {
  return typeof value === "string" && calendarDate.test(value);
}

/** What {@link LocalDate} writes: the text, and the `<time>` element's machine-readable `dateTime`. */
export interface DateText {
  text: string;
  dateTime: string;
}

/**
 * The text for `value` in `timeZone` (the reader's when undefined), or null when it is not a
 * date. An instant moves into the time zone. A calendar date (`"2026-06-01"`, `"2026-06"`) parses
 * as UTC midnight, so it is always written in UTC and never moves: the 1st stays the 1st west
 * of UTC. `labelZone` adds the time zone's name after a time, for the server's UTC text.
 * @claim "`) parses as UTC midnight, so it is" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::LocalDate > writes the UTC date on the server, hydrates without a mismatch, then shows the local date)
 * @claim "`) parses as UTC midnight, so it is" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::dateText > treats only a whole calendar date as one)
 */
export function dateText(value: Date | string | number, format: DateFormat, locale: Intl.LocalesArgument, timeZone: string | undefined, labelZone = false): DateText | null {
  const date = toDate(value);
  if (!date) return null;
  if (isCalendarDate(value)) {
    return { text: new Intl.DateTimeFormat(locale, { ...dateFormats[format], timeZone: "UTC" }).format(date), dateTime: value };
  }
  let text = new Intl.DateTimeFormat(locale, { ...dateFormats[format], timeZone }).format(date);
  if (labelZone && dateFormats[format].timeStyle) {
    const zone = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")!;
    text += ` ${zone.value}`;
  }
  return { text, dateTime: date.toISOString() };
}

/** Nothing to subscribe to: the value only changes between the server and the browser. */
export const subscribeNever = (): (() => void) => () => {};
export const inBrowser = (): boolean => true;
export const onServer = (): boolean => false;
