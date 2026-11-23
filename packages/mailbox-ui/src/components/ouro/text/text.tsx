"use client";

import type { CSSProperties, HTMLAttributes, JSX, ReactNode, Ref } from "react";
import { fontFor, isWeight, sizeFor, toneFor } from "@/lib/ouro/appearance-hints";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { toneWarning } from "@/lib/ouro/tones";
import { alignClasses, checkAlign, type TextAlign } from "@/components/ouro/text/text-styles";

export type { TextAlign } from "@/components/ouro/text/text-styles";

/** The props Text adds to the HTML attributes it passes through. */
export interface TextOwnProps {
  /** The element to render. Use `span` inside other text, `div` around block content. @default "p" */
  as?: "p" | "span" | "div" | (string & { 'Use "p", "span" or "div"; for a title use Heading': never }) | undefined;
  /** Type size from the theme. @default "md" */
  size?: "sm" | "md" | "lg" | (string & { 'Use "sm", "md" or "lg"; for a title use Heading': never }) | undefined;
  /**
   * Text color: `default` foreground, `muted` for secondary text, or a tone for
   * status text (`destructive` for an error). `secondary` is the same as `muted`,
   * because shadcn's `--secondary` is a surface color, not a text color. @default "default"
   */
  tone?:
    | "default"
    | "muted"
    | "primary"
    | "secondary"
    | "destructive"
    | "success"
    | "warning"
    | (string & { 'danger is "destructive"; accent is "primary"; neutral is "secondary"': never })
    | undefined;
  /** Alignment in writing direction. @default inherited */
  align?: TextAlign | (string & { 'Use "start", "center" or "end": left is "start", right is "end"': never }) | undefined;
  /**
   * Layout only: margins, width, grid placement (`mt-2`, `max-w-prose`).
   * Appearance classes warn in development; use `size`, `tone` and `align`.
   */
  className?: string | undefined;
  /** The text. Inline elements such as `<strong>` and `<a>` are fine inside. */
  children: ReactNode;
  ref?: Ref<HTMLElement> | undefined;
  /** Not a prop. Ouro UI uses `tone`: `<Text tone="muted">`. */
  color?: { 'Use <Text tone="muted">': never };
  /**
   * Not a prop. Text has no variants; use `size` and `tone`: `<Text size="sm" tone="muted">`.
   *
   * @claim "Text has no variants; use `size`" registry/ouro/components/ouro/text/text.test.tsx verify:testExists(registry/ouro/components/ouro/text/text.test.tsx::runtime guards > strips variant from Text and warns with the fix)
   */
  variant?: { 'Use <Text size="sm" tone="muted">': never };
}

/**
 * Props for {@link Text}. `truncate` (one line) and `lines` (many) are exclusive. The
 * HTML attributes sit outside the `truncate`/`lines` union, which keeps the editor's
 * hover docs on every prop.
 * @claim "The HTML attributes sit outside the" registry/ouro/components/ouro/text/text.test.tsx verify:testExists(registry/ouro/components/ouro/text/text.test.tsx::Text > passes HTML attributes and a ref through)
 * @claim "The HTML attributes sit outside the" registry/ouro/components/ouro/text/text.tsx verify:fileLine(registry/ouro/components/ouro/text/text.tsx, /^export\stype\sTextProps\s=\sOmit</)
 */
export type TextProps = Omit<
  HTMLAttributes<HTMLElement>,
  "color" | "className" | "children" | "truncate" | "lines" | keyof TextOwnProps
> &
  TextOwnProps &
  (
    | {
        /** Cuts the text to one line with an ellipsis. Use `lines` for more than one line. */
        truncate?: boolean | undefined;
        /** Not with `truncate`. Use `truncate` for one line or `lines` for more, not both. */
        lines?: never;
      }
    | {
        /** Clamps the text to this many lines with an ellipsis. Use `truncate` for one line. */
        lines?: number | undefined;
        /** Not with `lines`. Use `truncate` for one line or `lines` for more, not both. */
        truncate?: never;
      }
  );

const sizes = { sm: "text-sm", md: "text-base", lg: "text-lg" } as const;

const tones = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  primary: "text-primary",
  secondary: "text-muted-foreground",
  destructive: "text-destructive",
  success: "text-success",
  warning: "text-warning",
} as const;

const tags = ["p", "span", "div"] as const;

function textTone(token: string): string {
  const tone = toneFor(token);
  return tone === "secondary" ? "muted" : tone;
}

function textHint(token: string): string {
  const size = sizeFor(token, ["sm", "sm", "md", "lg", "lg", "lg", "lg"]);
  if (size) return `size="${size}"`;
  if (isWeight(token)) return "<Text><strong>…</strong></Text>";
  if (token.startsWith("font-")) return fontFor("Text", token);
  return `tone="${textTone(token)}"`;
}

/**
 * Body text in the theme's type scale and colors. Renders a `<p>` by default.
 * It wraps with `text-wrap: pretty`, so a paragraph does not end on one stranded word.
 *
 * Use `Heading` instead for titles (it renders `<h1>`–`<h6>`). Inside a
 * `Button`, pass plain text as children; the button styles it.
 *
 * @group Text
 * @see https://ui.ouroboros.bot/docs/text
 *
 * @example
 * <Text>Braise for three hours.</Text>
 * <Text size="sm" tone="muted">Updated 2 days ago</Text>
 * <Text tone="destructive">Recipe not saved: the server is offline.</Text>
 * <Text lines={2}>{recipe.description}</Text>
 */
export function Text(props: TextProps): JSX.Element {
  const {
    as: asProp = "p",
    size: sizeProp = "md",
    tone: toneProp = "default",
    align: alignProp,
    truncate,
    lines,
    className,
    style,
    ref,
    // Guard props (hint types), dropped here so they never reach the DOM.
    color,
    variant,
    ...rest
  } = props;
  // A tone that is not one of Ouro UI's (a type error) warns and renders the default.
  const tone = Object.hasOwn(tones, toneProp) ? (toneProp as keyof typeof tones) : "default";
  // Likewise an element, size or alignment: it renders a <p>, size md, or inherited alignment.
  const Tag = tags.includes(asProp as (typeof tags)[number]) ? (asProp as (typeof tags)[number]) : "p";
  const size = Object.hasOwn(sizes, sizeProp) ? (sizeProp as keyof typeof sizes) : "md";
  const [align, alignWarning] = checkAlign("Text", alignProp);
  useAppearanceClassNameCheck(
    "Text",
    className,
    process.env.NODE_ENV !== "production" ? textHint : /* istanbul ignore next @preserve -- production only */ "",
    process.env.NODE_ENV !== "production" ? 'align="center"' : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  useDevWarnings(
    "Text",
    process.env.NODE_ENV !== "production"
      ? () => [
          tone !== toneProp && toneWarning("Text", String(toneProp), Object.keys(tones)),
          Tag !== asProp && [
            `as="${String(asProp)}" is not an element Text renders; use "p", "span", "div"`,
            /^h[1-6]$/.test(String(asProp)) ? `<Heading level={${String(asProp).slice(1)}}>` : '<Text as="span">',
          ],
          size !== sizeProp && [
            `size="${String(sizeProp)}" is not a size; use "sm", "md", "lg"`,
            /xl$/.test(String(sizeProp)) ? "<Heading level={2}>" : '<Text size="md">',
          ],
          alignWarning,
          color !== undefined && ["color is not a prop", `<Text tone="${textTone(`text-${String(color)}`)}">`],
          variant !== undefined && ["variant is not a prop; Text has no variants", '<Text size="sm" tone="muted">'],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const classes = cn(
    // A `<p>` has a margin in the browser's stylesheet. It is cleared in a sublayer of
    // Tailwind's utilities (`[@layer_ouro-reset]:`), which every plain utility beats whatever
    // its specificity: a parent's `space-y-4` (a `:where()` rule) and the app's margin class.
    "[@layer_ouro-reset]:m-0",
    sizes[size],
    tones[tone],
    align && alignClasses[align],
    truncate ? "truncate" : "text-pretty",
    lines !== undefined && "line-clamp-(--ouro-lines)",
    className,
  );
  const finalStyle = lines !== undefined ? ({ ...style, "--ouro-lines": lines } as CSSProperties) : style;
  return <Tag {...rest} ref={ref as Ref<HTMLParagraphElement>} data-ouro="text" className={classes} style={finalStyle} />;
}
