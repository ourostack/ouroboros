"use client";

import { useSyncExternalStore, type JSX, type Ref, type TimeHTMLAttributes } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { dateFormats, dateText, inBrowser, onServer, subscribeNever, toDate, type DateFormat } from "@/components/ouro/local-date/local-date-styles";

export type { DateFormat } from "@/components/ouro/local-date/local-date-styles";

/** The props LocalDate adds to the `<time>` attributes it passes through. */
export interface LocalDateOwnProps {
  /**
   * The instant: a `Date`, an ISO string or a timestamp in milliseconds. A calendar date with no
   * time (`"2026-06-01"`, or `"2026-06"` with `format="month"`) is that day for every reader and is
   * never moved into a time zone.
   * @claim "A calendar date with no time" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::dateText > moves an instant into the reader's time zone)
   * @claim "A calendar date with no time" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::dateText > treats only a whole calendar date as one)
   */
  value: Date | string | number;
  /** `date` "Jun 1, 2026", `month` "Jun 2026", `datetime` "Jun 1, 2026, 9:30 AM", `time` "9:30 AM". @default "date" */
  format?: DateFormat | (string & { 'Use "date", "month", "datetime" or "time"': never }) | undefined;
  /** The language and region to write it in. @default the reader's (en-US in the server's text, until the browser takes over) */
  locale?: Intl.LocalesArgument | undefined;
  /** Layout only. Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLTimeElement> | undefined;

  /** Not a prop. The instant is `value`: `<LocalDate value={note.createdAt} />`. */
  date?: { 'Use value={date}': never };
  /** Not a prop. The instant is `value`; the `<time>` gets its `dateTime` from it. */
  dateTime?: { 'Use value={date}; dateTime is set from it': never };
  /**
   * Not a prop. The text is the date; there are no children.
   *
   * @claim "The text is the date; there" registry/ouro/components/ouro/local-date/local-date.test-d.ts verify:fileLine(registry/ouro/components/ouro/local-date/local-date.test-d.ts, /\{\svalue:\sDate;\schildren:\s"June\s1"\s\}>\(\)\.not\.toExtend<LocalDateProps>/)
   */
  children?: { 'LocalDate writes the date itself; pass value={date}': never };
}

/** Props for {@link LocalDate}: its own props and the `<time>` attributes it passes through. */
export type LocalDateProps = Omit<TimeHTMLAttributes<HTMLTimeElement>, keyof LocalDateOwnProps> & LocalDateOwnProps;

/**
 * A date (and time) in the reader's own time zone and language, in a `<time>` that carries
 * the exact instant. Only the browser knows the reader's time zone and language, so the server
 * writes the instant in UTC (in en-US unless `locale` is set), hydration repeats it so the
 * markup matches, and the browser then shows the local one. A date then changes only when the instant falls near midnight, but a time
 * (`time`, `datetime`) changes for every reader outside UTC, so the server's text names the
 * zone ("9:30 AM UTC") until the browser takes over. A calendar date with no time (`"2026-06-01"`)
 * is the same day for everyone: it is written the same on the server and in the browser, and
 * the `<time>` carries that date.
 *
 * Use `RelativeTime` instead for "3 days ago", and `Intl.DateTimeFormat` in your own text for
 * a date inside a sentence you build.
 *
 * @group Text
 * @see https://ui.ouroboros.bot/docs/local-date
 *
 * @example
 * <LocalDate value={note.updatedAt} format="datetime" />
 * @claim "A date then changes only when" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::LocalDate > labels a time UTC on the server, and drops the label once the browser shows the local time)
 * @claim "A date then changes only when" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::dateText > moves an instant into the reader's time zone)
 * @claim "A date then changes only when" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::LocalDate > writes the UTC date on the server, hydrates without a mismatch, then shows the local date)
 * @claim "A calendar date with no time" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::dateText > treats only a whole calendar date as one)
 * @claim "A calendar date with no time" registry/ouro/components/ouro/local-date/local-date.test.tsx verify:testExists(registry/ouro/components/ouro/local-date/local-date.test.tsx::LocalDate > writes the UTC date on the server, hydrates without a mismatch, then shows the local date)
 */
export function LocalDate(props: LocalDateProps): JSX.Element {
  const {
    value,
    format: formatProp = "date",
    locale,
    className,
    // Guard props (hint types), dropped here so they never reach the DOM.
    date: dateProp,
    dateTime,
    children,
    ...rest
  } = props;
  const format: DateFormat = Object.hasOwn(dateFormats, formatProp) ? (formatProp as DateFormat) : "date";
  const date = toDate(value);
  useAppearanceClassNameCheck(
    "LocalDate",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; style the text around it instead`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "LocalDate",
    process.env.NODE_ENV !== "production"
      ? () => [
          format !== formatProp && [`format="${String(formatProp)}" is not a format; use "date", "month", "datetime" or "time"`, '<LocalDate format="datetime" />'],
          date === null && [`value={${JSON.stringify(value)}} is not a date`, "<LocalDate value={new Date()} />"],
          dateProp !== undefined && ["date is not a prop", "<LocalDate value={date} />"],
          dateTime !== undefined && ["dateTime is not a prop; it is set from value", "<LocalDate value={date} />"],
          children !== undefined && ["LocalDate writes the date itself", "<LocalDate value={date} />"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const hydrated = useSyncExternalStore(subscribeNever, inBrowser, onServer);
  // The server's language is not the reader's, so the server and hydration write en-US in UTC;
  // the browser then switches to the reader's language and time zone. Each engine's ICU joins and
  // spaces the same date its own way (Node "Jun 1, 2026, 9:30 AM", Safari "Jun 1, 2026 at 9:30 AM"),
  // so hydration lets the server's text stand: the next render replaces it anyway. (It also lets a `value` that differs
  // between the server and the browser through: the text follows the browser's, and `datetime` keeps the server's.)
  const written = hydrated ? dateText(value, format, locale, undefined) : dateText(value, format, locale ?? "en-US", "UTC", true);
  return (
    <time {...rest} data-ouro="local-date" dateTime={written?.dateTime} className={cn(className)} suppressHydrationWarning>
      {written?.text}
    </time>
  );
}
