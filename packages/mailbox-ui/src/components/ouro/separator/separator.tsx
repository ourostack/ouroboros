"use client";

import { Separator as BaseSeparator } from "@base-ui/react/separator";
import type { HTMLAttributes, JSX, ReactNode, Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { toneWarning } from "@/lib/ouro/tones";

/** The props Separator adds to the `<div>` attributes it passes through. */
export interface SeparatorOwnProps {
  /**
   * `horizontal` spans the width of its container between stacked content; `vertical`
   * stands as tall as its row between side-by-side items (put it in a flex row).
   * @default "horizontal"
   */
  orientation?: "horizontal" | "vertical" | (string & { 'Use "horizontal" or "vertical"': never }) | undefined;
  /**
   * Hides the line from screen readers (`role="none"`). Use it when the line only
   * decorates, such as between a heading and its text; leave it off when it divides
   * two groups of content a reader should hear as separate.
   */
  decorative?: boolean | undefined;
  /**
   * Colors the lines and the label from the theme, for an accent line such as where unread
   * messages start. Without it the lines are the border color and the label is muted.
   * `secondary` is a surface, not a line color, so it is not a tone here.
   */
  tone?:
    | "primary"
    | "destructive"
    | "success"
    | "warning"
    | (string & { 'danger is "destructive"; accent is "primary"; neutral is no tone': never })
    | undefined;
  /**
   * A short word in the middle of a horizontal line, such as "or" between two ways to sign
   * in: `<Separator label="or" />`. The label is read as text in its place, and the lines on
   * either side are hidden from screen readers. Only for `horizontal`.
   * @claim "A short word in the middle" registry/ouro/components/ouro/separator/separator.test.tsx verify:testExists(registry/ouro/components/ouro/separator/separator.test.tsx::Separator > puts a label in the middle of a horizontal line, read as text while the lines are hidden)
   */
  label?: ReactNode;
  /** Layout only: margins, width, flex sizing (`my-4`, `flex-1`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;

  /** Not a prop. Ouro UI uses `orientation`: `<Separator orientation="vertical" />`. */
  vertical?: { 'Use <Separator orientation="vertical" />': never };
  /** Not a prop. The text in the middle of the line is `label`: `<Separator label="or" />`. */
  children?: { 'Use <Separator label="or" />': never };
  /** Not a prop. The text in the middle of the line is `label`: `<Separator label="or" />`. */
  text?: { 'Use <Separator label="or" />': never };
}

/** Props for {@link Separator}: its own props and the `<div>` attributes it passes through. */
export type SeparatorProps = Omit<HTMLAttributes<HTMLDivElement>, keyof SeparatorOwnProps | "role"> & SeparatorOwnProps;

const orientations = {
  horizontal: "h-px w-full",
  vertical: "w-px self-stretch",
} as const;

const line = "h-px min-w-0 flex-1 shrink border-0";

// Class strings are literal so the app's Tailwind finds them. A forced-colours line is drawn
// in CanvasText, because forced colours would otherwise drop its background.
const tones = {
  primary: { line: "bg-primary forced-colors:bg-[CanvasText]", label: "text-primary" },
  destructive: { line: "bg-destructive forced-colors:bg-[CanvasText]", label: "text-destructive" },
  success: { line: "bg-success forced-colors:bg-[CanvasText]", label: "text-success" },
  warning: { line: "bg-warning forced-colors:bg-[CanvasText]", label: "text-warning" },
} as const;

/**
 * A thin line in the theme's border color between groups of content, horizontal or
 * vertical. Built on Base UI's Separator, so it is a `role="separator"` with its
 * orientation for screen readers, unless `decorative`. With `label` it is a horizontal
 * line with a word in its middle, such as "or" between two ways to sign in. With `tone`
 * the lines and the label take the tone's color, such as an accent line where unread
 * messages start.
 *
 * Use spacing (margins or a gap) instead when whitespace alone separates the groups,
 * and a `Heading` when the next group needs a name.
 *
 * @group Display
 * @see https://ui.ouroboros.bot/docs/separator
 *
 * @example
 * <Separator className="my-4" />
 * <div className="flex items-center gap-3">
 *   <Button variant="plain">Edit</Button>
 *   <Separator orientation="vertical" />
 *   <Button variant="plain">Share</Button>
 * </div>
 * <Separator label="or" className="my-6" />
 * <Separator tone="primary" label="New since you left · 2 messages" />
 * @claim "With `label` it is a horizontal" registry/ouro/components/ouro/separator/separator.test.tsx verify:testExists(registry/ouro/components/ouro/separator/separator.test.tsx::Separator > puts a label in the middle of a horizontal line, read as text while the lines are hidden)
 */
export function Separator(props: SeparatorProps): JSX.Element {
  const {
    orientation: orientationProp = "horizontal",
    decorative,
    tone: toneProp,
    label,
    className,
    // Guard props (hint types), dropped here so they never reach the DOM.
    vertical,
    children,
    text,
    ...rest
  } = props;
  // An orientation that is not one of Ouro UI's (a type error) warns and renders horizontal.
  const orientation = Object.hasOwn(orientations, orientationProp) ? (orientationProp as keyof typeof orientations) : "horizontal";
  const labelled = label != null && label !== false;
  // A tone that is not one of Ouro UI's (a type error) warns and renders the default.
  const tone = Object.hasOwn(tones, String(toneProp)) ? (toneProp as keyof typeof tones) : undefined;
  const lineColor = tone ? tones[tone].line : "bg-border";
  const labelColor = tone ? tones[tone].label : "text-muted-foreground";
  useAppearanceClassNameCheck(
    "Separator",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; Separator uses the theme's --border color`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Separator",
    process.env.NODE_ENV !== "production"
      ? () => [
          vertical !== undefined && ["vertical is not a prop", '<Separator orientation="vertical" />'],
          orientation !== orientationProp && [
            `orientation="${String(orientationProp)}" is not an orientation; use "horizontal", "vertical"`,
            /col|vert|^y$/i.test(String(orientationProp)) ? '<Separator orientation="vertical" />' : '<Separator orientation="horizontal" />',
          ],
          tone !== toneProp &&
            (toneProp === "neutral"
              ? ['tone="neutral" is not a tone; a line without a tone is the default', "<Separator>"]
              : toneWarning("Separator", String(toneProp), Object.keys(tones))),
          children !== undefined && ["Separator takes no children; its text is label", `<Separator label="${typeof children === "string" ? children : "or"}" />`],
          text !== undefined && ["text is not a prop", `<Separator label="${typeof text === "string" ? text : "or"}" />`],
          labelled && orientation === "vertical" && ["label works on a horizontal line only, so the line renders horizontal", `<Separator label="or" />`],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  if (labelled) {
    // The text reads in its place; the two lines only decorate it.
    return (
      <div
        data-slot="separator"
        {...rest}
        data-ouro="separator"
        data-orientation="horizontal"
        className={cn("flex w-full min-w-0 items-center gap-3", className)}
      >
        <BaseSeparator role="none" aria-orientation={undefined} data-slot="separator-line" className={cn(line, lineColor)} />
        <span data-slot="separator-label" className={cn("max-w-full shrink-0 text-center text-sm leading-5", labelColor)}>
          {label}
        </span>
        <BaseSeparator role="none" aria-orientation={undefined} data-slot="separator-line" className={cn(line, lineColor)} />
      </div>
    );
  }
  return (
    <BaseSeparator
      data-slot="separator"
      {...rest}
      orientation={orientation}
      {...(decorative ? { role: "none", "aria-orientation": undefined } : {})}
      data-ouro="separator"
      className={cn("shrink-0 border-0", lineColor, orientations[orientation], className)}
    />
  );
}
