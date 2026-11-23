"use client";

import { useSyncExternalStore, type JSX, type Ref, type TimeHTMLAttributes } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { dateText, isCalendarDate, type DateFormat } from "@/components/ouro/local-date/local-date-styles";
import { calendarRelative, relative } from "@/components/ouro/relative-time/relative-time-styles";

/** The props RelativeTime adds to the `<time>` attributes it passes through. */
export interface RelativeTimeOwnProps {
  /**
   * The instant: a `Date`, an ISO string or a timestamp in milliseconds. A calendar date with no
   * time (`"2026-06-01"`, or `"2026-06"` for a month) counts whole days (or months) in the
   * reader's own calendar and is never moved into a time zone.
   * @claim "A calendar date with no time" registry/ouro/components/ouro/relative-time/relative-time.test.tsx verify:testExists(registry/ouro/components/ouro/relative-time/relative-time.test.tsx::RelativeTime > counts a calendar date in whole days of the reader's calendar, titled with that day)
   * @claim "A calendar date with no time" registry/ouro/components/ouro/relative-time/relative-time.test.tsx verify:testExists(registry/ouro/components/ouro/relative-time/relative-time.test.tsx::RelativeTime > writes a calendar date as that day on the server)
   */
  value: Date | string | number;
  /** The language and region to write it in. @default the reader's (en-US in the server's text, until the browser takes over) */
  locale?: Intl.LocalesArgument | undefined;
  /** `auto` says "yesterday" and "now"; `always` says "1 day ago" and "in 0 seconds". @default "auto" */
  numeric?: "auto" | "always" | (string & { 'Use "auto" or "always"': never }) | undefined;
  /** Layout only. Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLTimeElement> | undefined;

  /** Not a prop. The instant is `value`: `<RelativeTime value={comment.createdAt} />`. */
  date?: { 'Use value={date}': never };
  /** Not a prop. The time updates itself; nothing to pass. */
  now?: { 'RelativeTime keeps itself current; remove now': never };
}

/** Props for {@link RelativeTime}: its own props and the `<time>` attributes it passes through. */
export type RelativeTimeProps = Omit<TimeHTMLAttributes<HTMLTimeElement>, keyof RelativeTimeOwnProps> & RelativeTimeOwnProps;

// One clock for every RelativeTime on the page, moved on every 30 seconds while any shows.
let now = 0;
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  now = Date.now();
  interval ??= setInterval(() => {
    now = Date.now();
    for (const each of [...listeners]) each();
  }, 30_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(interval);
    interval = undefined;
  };
}
const readNow = () => now;
const serverNow = () => 0;

/**
 * How long ago (or how soon) something happens, in the reader's language: "3 days ago",
 * "yesterday", "in 5 minutes", "now", kept current while it shows. It is a `<time>` with the
 * exact instant, and its `title` gives the full local date and time. The server writes the UTC
 * date (in en-US unless `locale` is set) and hydration repeats it, so the markup matches; the
 * browser then shows the relative time in the reader's language.
 * A calendar date with no time (`"2026-06-01"`) counts whole days from the reader's own today
 * ("tomorrow", "in 3 days"), and its `title` and `<time>` carry that day, never moved into a
 * time zone.
 *
 * Use `LocalDate` instead where the date itself matters, such as a due date.
 *
 * @group Text
 * @see https://ui.ouroboros.bot/docs/relative-time
 *
 * @example
 * <RelativeTime value={comment.createdAt} />
 * @claim "A calendar date with no time" registry/ouro/components/ouro/relative-time/relative-time.test.tsx verify:testExists(registry/ouro/components/ouro/relative-time/relative-time.test.tsx::RelativeTime > counts a calendar date in whole days of the reader's calendar, titled with that day)
 * @claim "A calendar date with no time" registry/ouro/components/ouro/relative-time/relative-time.test.tsx verify:testExists(registry/ouro/components/ouro/relative-time/relative-time.test.tsx::RelativeTime > writes a calendar date as that day on the server)
 */
export function RelativeTime(props: RelativeTimeProps): JSX.Element {
  const {
    value,
    locale,
    numeric: numericProp = "auto",
    className,
    title,
    // Guard props (hint types), dropped here so they never reach the DOM.
    date: dateProp,
    now: nowProp,
    ...rest
  } = props;
  const numeric = numericProp === "always" ? "always" : "auto";
  const calendar = isCalendarDate(value);
  const shape: DateFormat = calendar && value.length === 7 ? "month" : "date";
  // What the server writes, and hydration repeats: the date in UTC, in en-US unless the app set a
  // language, because the server's own is not the reader's.
  const written = dateText(value, shape, locale ?? "en-US", "UTC");
  useAppearanceClassNameCheck(
    "RelativeTime",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; style the text around it instead`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "RelativeTime",
    process.env.NODE_ENV !== "production"
      ? () => [
          numeric !== numericProp && [`numeric="${String(numericProp)}" is not an option; use "auto" or "always"`, '<RelativeTime numeric="always" />'],
          written === null && [`value={${JSON.stringify(value)}} is not a date`, "<RelativeTime value={new Date()} />"],
          dateProp !== undefined && ["date is not a prop", "<RelativeTime value={date} />"],
          nowProp !== undefined && ["now is not a prop; RelativeTime keeps itself current", "<RelativeTime value={date} />"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const at = useSyncExternalStore(subscribe, readNow, serverNow);
  const hydrated = at !== 0;
  let text = written?.text;
  let full: string | undefined;
  if (written && hydrated) {
    text = calendar ? calendarRelative(value, at, locale, numeric) : relative(new Date(value), at, locale, numeric);
    full = dateText(value, calendar ? shape : "datetime", locale, undefined)!.text;
  }
  // The server's UTC date is a placeholder another engine's ICU may write differently (LocalDate), so hydration lets it stand.
  return (
    <time {...rest} data-ouro="relative-time" dateTime={written?.dateTime} title={title ?? full} className={cn(className)} suppressHydrationWarning>
      {text}
    </time>
  );
}
