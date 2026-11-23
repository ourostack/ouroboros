"use client";

import type { HTMLAttributes, JSX, Ref } from "react";
import { toneFor } from "@/lib/ouro/appearance-hints";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { toneWarning } from "@/lib/ouro/tones";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";

/** The props Spinner adds to the `<span>` attributes it passes through. */
export interface SpinnerOwnProps {
  /**
   * What is loading, for screen readers: "Loading recipes". It is not shown; put visible
   * text next to the spinner when you want one.
   * @default "Loading"
   */
  label?: string | undefined;
  /**
   * The spinner's size: 16px, 20px or 32px. To match running text, use `sm`.
   * @default "md"
   * @claim "The spinner's size: 16px, 20px or" registry/ouro/components/ouro/spinner/spinner.test.tsx verify:testExists(registry/ouro/components/ouro/spinner/spinner.test.tsx::Spinner > sizes 16, 20 and 32px, md by default)
   */
  size?: "sm" | "md" | "lg" | (string & { 'Use "sm", "md" or "lg"': never }) | undefined;
  /**
   * Color role from the theme, named after its token. Without a tone the spinner takes the
   * surrounding text color, so it matches the button or text it sits in. `secondary` is
   * the muted foreground.
   */
  tone?:
    | "primary"
    | "secondary"
    | "destructive"
    | "success"
    | "warning"
    | (string & { 'danger is "destructive"; accent is "primary"; neutral is "secondary"': never })
    | undefined;
  /** Layout only: margins, alignment in a flex row (`ms-2`). Appearance classes warn in development; use `tone` and `size`. */
  className?: string | undefined;
  ref?: Ref<HTMLSpanElement> | undefined;

  /** Not a prop. Ouro UI uses `tone`: `<Spinner tone="primary">`. */
  color?: { 'Use <Spinner tone="primary">': never };
}

/** Props for {@link Spinner}: its own props and the `<span>` attributes it passes through. */
export type SpinnerProps = Omit<HTMLAttributes<HTMLSpanElement>, keyof SpinnerOwnProps | "children" | "role"> & SpinnerOwnProps;

// Class strings are literal so the app's Tailwind finds them when it compiles.
const sizes = { sm: "size-ouro-4", md: "size-ouro-5", lg: "size-ouro-8" } as const;

const tones = {
  primary: "text-primary",
  secondary: "text-muted-foreground",
  destructive: "text-destructive",
  success: "text-success",
  warning: "text-warning",
} as const;

function spinnerHint(token: string): string {
  if (/^text-(xs|sm|base|lg|\d?xl)$/.test(token)) return 'size="sm", size="md" or size="lg"';
  return `tone="${toneFor(token)}"`;
}

/**
 * A small spinning ring that says an action is under way, inline: in a field's adornment, a
 * toast's or a menu entry's icon, or beside the words that say what is happening. Screen
 * readers hear its `label` as a status; with reduced motion it pulses instead of spinning.
 *
 * Use `Skeleton` instead to hold the place of content that is loading (a spinner alone where
 * content will be fails the source rule's `content-spinner`), `Button`'s `loading` when the
 * wait follows a press, and `Progress` when you know how far along the work is.
 *
 * @group Feedback
 * @see https://ui.ouroboros.bot/docs/spinner
 *
 * @example
 * <TextField label="Find" endAdornment={<Spinner size="sm" label="Searching" />} />
 */
export function Spinner(props: SpinnerProps): JSX.Element {
  const { label = "Loading", size: sizeProp = "md", tone: toneProp, className, color, ...rest } = props;
  // A size or tone that is not one of Ouro UI's (a type error) warns and renders the default.
  const size = Object.hasOwn(sizes, sizeProp) ? (sizeProp as keyof typeof sizes) : "md";
  const tone = toneProp !== undefined && Object.hasOwn(tones, toneProp) ? (toneProp as keyof typeof tones) : undefined;
  useAppearanceClassNameCheck(
    "Spinner",
    className,
    process.env.NODE_ENV !== "production" ? spinnerHint : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Spinner",
    process.env.NODE_ENV !== "production"
      ? () => [
          size !== sizeProp && [`size="${String(sizeProp)}" is not a size; use "sm", "md", "lg"`, '<Spinner size="md">'],
          toneProp !== undefined && tone !== toneProp && toneWarning("Spinner", String(toneProp), Object.keys(tones)),
          color !== undefined && ["color is not a prop", `<Spinner tone="${toneFor(`text-${String(color)}`)}">`],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  return (
    <span
      {...rest}
      role="status"
      data-ouro="spinner"
      className={cn("relative inline-flex shrink-0 align-middle", sizes[size], tone && tones[tone], className)}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        className="size-full animate-[ouro-spin_0.8s_linear_infinite] motion-reduce:animate-[ouro-pulse_1.6s_ease-in-out_infinite]"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
