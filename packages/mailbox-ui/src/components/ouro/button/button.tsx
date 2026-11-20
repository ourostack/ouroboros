"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Fragment, isValidElement, useEffect, useRef, useState } from "react";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ComponentType,
  JSX,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  Ref,
  SVGProps,
} from "react";
import { announce } from "@/lib/ouro/announce";
import { fontFor, radiusFor, sizeFor, toneFor } from "@/lib/ouro/appearance-hints";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { holdPageAtPress } from "@/lib/ouro/page-scroll-hold";
import { useMergedRef } from "@/lib/ouro/refs";
import { RouterLink } from "@/lib/ouro/router-link";
import { TouchTarget } from "@/lib/ouro/touch-target";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { toneWarning } from "@/lib/ouro/tones";

/** An icon component, such as one from `lucide-react` or `@heroicons/react`. */
export type ButtonIcon = ComponentType<SVGProps<SVGSVGElement>>;

/** Props shared by both kinds of Button (`href` switches between them). */
export interface ButtonBaseProps {
  /**
   * Color role from the theme, named after its token: `primary` reads `--primary`.
   * A solid primary button, the page's main action, reads `--ouro-action` and
   * `--ouro-action-foreground` instead when the theme sets them, with `href` too, so a theme
   * can give its actions their own colour. Only the solid look reads them: soft, outline and
   * plain primary buttons keep `--primary`, as do `Link`, checkboxes, switches and the current tab.
   * Optional `--ouro-action-hover` and `--ouro-action-active` set its state fills without
   * changing the state layers. `--ouro-action-disabled`, `--ouro-action-disabled-foreground`
   * and `--ouro-action-disabled-opacity` set its disabled look; opacity defaults to 0.5.
   * shadcn's `variant="destructive"` is `tone="destructive"`, and its `variant="secondary"` is `tone="secondary"`.
   * @claim "Optional `--ouro-action-hover` and" test/action-token.test.tsx verify:testExists(test/action-token.test.tsx::the action token > uses optional hover and active action fills for a button and a link, keeping the original state layers)
   * @claim "`--ouro-action-disabled`, `--ouro-action-disabled-foreground` and `--ouro-action-disabled-opacity` set its disabled look" test/action-token.test.tsx verify:testExists(test/action-token.test.tsx::the action token > uses optional disabled action colours and opacity without changing other button looks or selections) verify:fileLine(registry/ouro/components/ouro/button/button.tsx, /disabled:opacity-\(--ouro-action-disabled-opacity,0\.5\)/)
   * @claim "Only the solid look reads them" test/action-token.test.tsx verify:testExists(test/action-token.test.tsx::the action token > repaints the solid primary Button, as a button and as a link, and leaves every selection on --primary)
   * @claim "A solid primary button, the" test/action-token.test.tsx verify:testExists(test/action-token.test.tsx::the action token > repaints the solid primary Button, as a button and as a link, and leaves every selection on --primary)
   * @default "primary"
   */
  tone?:
    | "primary"
    | "secondary"
    | "destructive"
    | "success"
    | "warning"
    | (string & { 'danger is "destructive"; accent is "primary"; neutral is "secondary"': never })
    | undefined;
  /**
   * Visual weight: `solid` for the primary action, `soft` for secondary actions,
   * `outline` for a quiet bordered control, `plain` for a borderless one.
   * shadcn's `default` is `solid` (the default), `ghost` and `link` are `plain`, and
   * `destructive` and `secondary` are tones: `tone="destructive"`. Any other
   * string is a type error whose message names the fix.
   * Variant is visual only. For a toggle, pass `aria-pressed`; for the current
   * nav item, `aria-current="page"`.
   * @default "solid"
   */
  variant?:
    | "solid"
    | "soft"
    | "outline"
    | "plain"
    | (string & { 'From shadcn? Use tone="destructive" or tone="secondary". default is "solid"; ghost and link are "plain"': never })
    | undefined;
  /**
   * Control size. `sm`, `md` and `lg` are taller on phones and step down to desktop
   * density from the `sm` breakpoint (640px). `inline` is an action inside a line of text,
   * such as Undo in a note: it takes the text's size, leaves the line's height as it was and
   * keeps a target at least 24px tall and wide (44px on a coarse pointer). shadcn's `default`
   * is `md`; for an icon-only button, pass the icon as children and an `aria-label`: Button sizes
   * the icon as it sizes `startIcon`, unless the icon has a size class of its own, and makes the
   * button at least as wide as it is tall, so an icon's button is square (a circle where the theme's
   * controls are capsules). Wider content keeps its width, and a picture whose `width` and `height` differ,
   * such as a logo, keeps the label's padding. Any other
   * string is a type error whose message names the fix. @default "md"
   * @claim "at least as wide as it is tall" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::icon-only size > is as wide as it is tall at size %s, with only an icon and a name)
   * @claim "Wider content keeps its width" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::icon-only size > keeps an image child at its own width, and the button is never narrower than it is tall)
   * @claim "Wider content keeps its width" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::icon-only size > keeps a wide element child at its full width under its aria-label)
   * @claim "a picture whose `width` and `height` differ" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::icon-only size > keeps a label's padding around a wide picture such as a logo, and squares a square one or an icon)
   * @claim "are taller on phones" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::appearance > orders sizes sm < md < lg)
   * @claim "are taller on phones" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::className > lets the app's height and padding win at desktop widths too)
   * @claim "it takes the text's size" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::inline size > sits in a line of text at the text's size without moving the line, and keeps a 24px target)
   * @claim "it takes the text's size" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::inline size > is at least 24px wide around a one-letter label)
   * @claim "it takes the text's size" registry/ouro/components/ouro/button/button.touch.test.tsx verify:fileLine(registry/ouro/components/ouro/button/button.touch.test.tsx, /44px hit area on a coarse pointer/)
   */
  size?:
    | "sm"
    | "md"
    | "lg"
    | "inline"
    | (string & { 'From shadcn? default is "md"; for icon, pass aria-label with the icon as children': never })
    | undefined;
  /** Stretches the button to the width of its container. */
  fullWidth?: boolean | undefined;
  /**
   * Shows a centered spinner, keeps the width, sets `aria-busy` and disables
   * the button. It stays focusable, so focus is not lost when a pressed button
   * turns busy.
   */
  loading?: boolean | undefined;
  /**
   * What screen readers hear, politely, when `loading` turns on. It is spoken
   * through a shared live region, so the button's name stays its label. Use the
   * action in progress: `loadingLabel="Saving recipe"`. @default "Loading"
   */
  loadingLabel?: string | undefined;
  /** Icon before the label. Pass the component, not an element: `startIcon={PlusIcon}`. */
  startIcon?: ButtonIcon | undefined;
  /**
   * Icon after the label. Pass the component, not an element: `endIcon={ArrowRightIcon}`. On a
   * button wider than its label, such as one with `fullWidth`, it sits at the end and the label
   * stays centred in the rest, or at the start with `className="justify-start"`.
   *
   * @claim "On a button wider than its label" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::button branch > puts an end icon at the inline end of a button wider than its label, %s)
   * @claim "On a button wider than its label" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::button branch > keeps an app's justify-start on a wide button %s an end icon)
   */
  endIcon?: ButtonIcon | undefined;
  /** The label. For an icon-only button, also pass `aria-label`. */
  children: ReactNode;
  /**
   * Layout only: margins, width, grid placement (`mt-4`, `col-span-2`). Your
   * classes always win over Ouro UI's. Appearance classes warn in development;
   * use `tone`, `variant` and `size` instead.
   * @claim "Your classes always win over Ouro" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::className > lets app layout classes win over library styles)
   * @claim "Your classes always win over Ouro" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::className > lets the app's height and padding win at desktop widths too)
   */
  className?: string | undefined;

  /** Not a prop. Ouro UI uses `loading`: `<Button loading>`. */
  isLoading?: { 'Use <Button loading>': never };
  /** Not a prop. Ouro UI uses `tone`: `<Button tone="destructive">`. */
  color?: { 'Use <Button tone="destructive">': never };
  /** Not a prop. To render a link, pass `href`: `<Button href="/recipes">`. For other elements, use parts. */
  asChild?: { 'Use <Button href="/path">': never };
  /** Not a prop. Ouro UI uses `startIcon`: `<Button startIcon={PlusIcon}>`. */
  leftIcon?: { 'Use <Button startIcon={Icon}>': never };
  /** Not a prop. Ouro UI uses `endIcon`: `<Button endIcon={ArrowRightIcon}>`. */
  rightIcon?: { 'Use <Button endIcon={Icon}>': never };
}

/** A Button with `href`: renders a link that looks like a button. */
export type ButtonLinkProps = ButtonBaseProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonBaseProps | "type"> & {
    /**
     * Where the link goes. Internal paths render through `OuroProvider`'s
     * `linkComponent` (your router's link); `http(s)://`, `mailto:` and other
     * absolute URLs render as a plain `<a>`. An absolute URL with
     * `target="_blank"` always gets `rel="noopener noreferrer"`, merged with
     * any `rel` you pass.
     * @claim "`, merged with any `rel` you pass." registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::link branch > merges an explicit rel with noopener noreferrer on an external _blank link)
     */
    href: string;
    /**
     * Loads the document instead of using the provider's router link, for a server sign-in
     * or a resource route. A present `download` attribute does the same.
     * @claim "Loads the document instead of using" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::link branch > uses the document for reloadDocument and downloads, retaining router navigation otherwise)
     */
    reloadDocument?: boolean | undefined;
    /**
     * Links have no `type`. Remove `href` to make a submit button: `<Button type="submit">`.
     *
     * @claim "Links have no `type`" registry/ouro/components/ouro/button/button.test-d.ts verify:fileLine(registry/ouro/components/ouro/button/button.test-d.ts, /\{\schildren:\s"Go";\shref:\s"\/x";\stype:\s"submit"\s\}>\(\)\.not\.toExtend<ButtonProps>/)
     */
    type?: never;
    /** A link cannot be disabled. Remove `href` to render a disabled button, or don't render the link. */
    disabled?: never;
    /** A dialog's default action is a button. Remove `href`: `<Button default onClick={start}>`. */
    default?: never;
    ref?: Ref<HTMLAnchorElement> | undefined;
  };

/** A Button without `href`: renders a native `<button>`. */
export type ButtonButtonProps = ButtonBaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonBaseProps | "type"> & {
    /** Not set: this is a `<button>`. Pass `href` to render a link instead. */
    href?: never;
    /** Document navigation needs a link: pass `href` with `reloadDocument`. */
    reloadDocument?: never;
    /**
     * The button's role in a form: `submit` sends it, `reset` clears it.
     * @default "button" (never submits a form by accident)
     * @claim "never submits a form by accident" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::button branch > renders a native button with type=button and data-ouro)
     */
    type?: "button" | "submit" | "reset" | (string & { 'Use "button", "submit" or "reset"; for looks use tone and variant': never }) | undefined;
    /**
     * The dialog's default action, as on a Mac: Return presses it from anywhere in the dialog
     * around it, unless focus is in a multi-line field (where Command or Control Return presses
     * it), on a control that takes Return itself (another button, a link, an option) or in a
     * list that is open, or Shift or Option is held. Return calls `onClick` with the key's own
     * `KeyboardEvent`, so an action that needs a person's gesture still gets one, and a submit
     * button then sends its form once. It tells assistive technology so with
     * `aria-keyshortcuts`. Give it to one button per dialog, the main action, and keep
     * the solid look; outside a dialog it does nothing, since Return there belongs to the page.
     * @claim "The dialog's default action, as" registry/ouro/components/ouro/button/button.default.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.default.test.tsx::Button default > is what Return presses from a field in its dialog, with the key's own trusted event)
     * @claim "Return presses it from anywhere" registry/ouro/components/ouro/button/button.default.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.default.test.tsx::Button default > leaves Return to a multi-line field, and takes Command or Control Return from it)
     * @claim "Return presses it from anywhere" registry/ouro/components/ouro/button/button.default.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.default.test.tsx::Button default > leaves Return to a control that takes it itself: another button, a link, a list's option and an open list)
     * @claim "Return presses it from anywhere" registry/ouro/components/ouro/button/button.default.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.default.test.tsx::Button default > leaves Return alone with Shift or Option held, while an input method composes, or when the app took it)
     * @claim "Return calls `onClick` with the" registry/ouro/components/ouro/button/button.default.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.default.test.tsx::Button default > is what Return presses from a field in its dialog, with the key's own trusted event)
     * @claim "and a submit button then" registry/ouro/components/ouro/button/button.default.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.default.test.tsx::Button default > sends its form once as a submit button, and calls onClick alone without a form)
     * @claim "It tells assistive technology so" registry/ouro/components/ouro/button/button.default.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.default.test.tsx::Button default > says so to assistive technology, and looks like the dialog's main action)
     * @claim "Give it to one button" registry/ouro/components/ouro/button/button.default.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.default.test.tsx::Button default > does nothing outside a dialog, where Return belongs to the page)
     */
    default?: boolean | undefined;
    ref?: Ref<HTMLButtonElement> | undefined;
  };

/** Props for {@link Button}. Passing `href` makes it a link; otherwise it is a `<button>`. */
export type ButtonProps = ButtonLinkProps | ButtonButtonProps;

// Class strings are literal so the app's Tailwind finds them when it compiles.
const base =
  "press relative box-border inline-flex shrink-0 items-center justify-center align-middle " +
  "rounded-ouro-control border border-solid font-medium whitespace-nowrap " +
  "no-underline select-none touch-manipulation [-webkit-tap-highlight-color:transparent] " +
  "outline-ring outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid " +
  // A state layer in the text color: a light wash on hover, a deeper one while pressed.
  "before:pointer-events-none before:absolute before:-inset-px before:rounded-[inherit] before:[corner-shape:inherit] before:bg-current " +
  "before:opacity-0 before:transition-opacity before:duration-(--ouro-duration-fast) before:ease-[ease] " +
  // Stryker disable next-line StringLiteral: a class string in a class position; test/state-hovers.test.tsx reads its tokens, outside this file's tests
  "not-data-disabled:not-active:pointer-fine:hover:before:opacity-[var(--ouro-state-hover,8%)] not-data-disabled:active:before:opacity-[var(--ouro-state-pressed,14%)] " +
  // Where corner-shape is missing, the surface slot paints the background, border and state layer instead (see ouro-base.css).
  "bg-(--ouro-bg) border-(--ouro-bd) [--ouro-sq-w:1px] " +
  // Stryker disable next-line StringLiteral: a class string in a class position, which no test reads
  "not-data-disabled:not-active:pointer-fine:hover:[--ouro-state:var(--ouro-state-hover,8%)] not-data-disabled:active:[--ouro-state:var(--ouro-state-pressed,14%)] " +
  // Press feedback: scale only when motion is allowed and the button is enabled.
  "motion-safe:not-data-disabled:active:scale-(--ouro-press-scale) " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress";

// Height and padding step down to desktop density at the `sm` breakpoint through two
// variables, so the button has one unprefixed `h-*` and `px-*` class and the app's own
// (`className="h-20"`) replaces it at every width.
const density = "h-(--ouro-button-h) px-(--ouro-button-px)";
const sizes = {
  sm:
    `${density} gap-1.5 text-sm [--ouro-button-h:calc(var(--spacing)*9)] [--ouro-button-px:calc(var(--spacing)*3)] ` +
    "sm:[--ouro-button-h:calc(var(--spacing)*8)] sm:[--ouro-button-px:calc(var(--spacing)*2.5)]",
  md:
    `${density} gap-2 text-base sm:text-sm [--ouro-button-h:calc(var(--spacing)*11)] [--ouro-button-px:calc(var(--spacing)*4)] ` +
    "sm:[--ouro-button-h:calc(var(--spacing)*9)] sm:[--ouro-button-px:calc(var(--spacing)*3.5)]",
  lg:
    `${density} gap-2 text-base [--ouro-button-h:calc(var(--spacing)*12)] [--ouro-button-px:calc(var(--spacing)*5)] ` +
    "sm:[--ouro-button-h:calc(var(--spacing)*11)]",
  // In a line of text, at the text's own size: the padding takes the box to 24px and more, and the
  // negative margin gives that back, so the line keeps its height and the label sits on its baseline.
  inline: "h-auto min-w-6 px-1 py-[3px] -my-1 gap-1 rounded-ouro-md align-baseline text-[length:inherit] leading-[inherit]",
} as const;

// `soft` is the tone at low opacity behind text in the tone, the pattern shadcn uses for
// destructive, with the text mixed 20% toward the foreground so it keeps 4.5:1 on the
// tint under shadcn's stock values too (plain `text-destructive` there is 3.97:1). `secondary` is shadcn's: a quiet surface (`bg-secondary`) with its own
// foreground, so its outline and plain text are the page's foreground. The primary outline's
// text is the foreground too, as in shadcn, where --primary is a fill color: a theme whose primary
// only just reaches 4.5:1 on its page loses it on any tinted surface around the button.
// The solid primary is the page's main action: it reads --ouro-action and its foreground, which
// fall back to --primary and --primary-foreground at the button itself (never in a :root rule,
// so a theme scoped to part of the page still repaints it). A theme sets them to give the action
// its own colour while selection (checkboxes, switches, the current tab) keeps --primary.
const looks = {
  solid: {
    primary:
      "[--ouro-bd:transparent] [--ouro-bg:var(--ouro-action,var(--primary))] text-(--ouro-action-foreground,var(--primary-foreground)) " +
      "not-data-disabled:not-active:pointer-fine:hover:[--ouro-bg:var(--ouro-action-hover,var(--ouro-action,var(--primary)))] " +
      "not-data-disabled:active:[--ouro-bg:var(--ouro-action-active,var(--ouro-action,var(--primary)))] " +
      "data-disabled:[--ouro-bg:var(--ouro-action-disabled,var(--ouro-action,var(--primary)))] " +
      "data-disabled:text-(--ouro-action-disabled-foreground,var(--ouro-action-foreground,var(--primary-foreground))) " +
      "disabled:opacity-(--ouro-action-disabled-opacity,0.5)",
    secondary: "[--ouro-bd:transparent] [--ouro-bg:var(--secondary)] text-secondary-foreground",
    destructive: "[--ouro-bd:transparent] [--ouro-bg:var(--destructive)] text-destructive-foreground",
    success: "[--ouro-bd:transparent] [--ouro-bg:var(--success)] text-success-foreground",
    warning: "[--ouro-bd:transparent] [--ouro-bg:var(--warning)] text-warning-foreground",
  },
  soft: {
    primary: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--primary)_10%,transparent)] text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))] contrast-more:[--ouro-bd:currentColor]",
    secondary: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--secondary)_50%,transparent)] text-secondary-foreground contrast-more:[--ouro-bd:currentColor]",
    destructive: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--destructive)_10%,transparent)] text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))] contrast-more:[--ouro-bd:currentColor]",
    success: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--success)_10%,transparent)] text-[color-mix(in_oklab,var(--success)_80%,var(--foreground))] contrast-more:[--ouro-bd:currentColor]",
    warning: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--warning)_10%,transparent)] text-[color-mix(in_oklab,var(--warning)_80%,var(--foreground))] contrast-more:[--ouro-bd:currentColor]",
  },
  outline: {
    primary: "[--ouro-bd:color-mix(in_oklab,var(--primary)_45%,transparent)] [--ouro-bg:transparent] text-foreground",
    secondary: "[--ouro-bd:var(--border)] [--ouro-bg:transparent] text-foreground",
    destructive: "[--ouro-bd:color-mix(in_oklab,var(--destructive)_45%,transparent)] [--ouro-bg:transparent] text-destructive",
    success: "[--ouro-bd:color-mix(in_oklab,var(--success)_45%,transparent)] [--ouro-bg:transparent] text-success",
    warning: "[--ouro-bd:color-mix(in_oklab,var(--warning)_45%,transparent)] [--ouro-bg:transparent] text-warning",
  },
  plain: {
    primary: "[--ouro-bd:transparent] [--ouro-bg:transparent] text-primary",
    secondary: "[--ouro-bd:transparent] [--ouro-bg:transparent] text-foreground",
    destructive: "[--ouro-bd:transparent] [--ouro-bg:transparent] text-destructive",
    success: "[--ouro-bd:transparent] [--ouro-bg:transparent] text-success",
    warning: "[--ouro-bd:transparent] [--ouro-bg:transparent] text-warning",
  },
} as const;

const iconClass = "size-[1.25em] shrink-0";

// An icon passed as children sizes like `startIcon`, unless it carries a size class of its own.
const iconChildClass =
  "[&>[data-ouro-label]>svg:not([class*='size-'])]:size-[1.25em] [&>[data-ouro-label]>svg]:shrink-0";

// An icon-only button drops the label's side padding and is at least as wide as it is tall: the height is a floor,
// never a width, so an icon sits in a square and a child wider than the height keeps its width.
const iconOnlyClass = "min-w-(--ouro-button-h) [--ouro-button-px:0px] sm:[--ouro-button-px:0px]";

const buttonTypes = ["button", "submit", "reset"] as const;

function buttonHint(token: string): string {
  const size = sizeFor(token, ["sm", "sm", "md", "lg", "lg", "lg", "lg"]);
  if (size) return `size="${size}"`;
  if (token.startsWith("font-")) return fontFor("Button", token);
  if (token.startsWith("rounded")) return radiusFor(token);
  if (/^(border|ring|shadow)/.test(token)) return 'variant="outline"';
  if (/^bg-(transparent|none)$/.test(token)) return 'variant="plain"';
  return `tone="${toneFor(token)}"`;
}

/** shadcn's Button variants, with the Ouro UI props that do the same job. Development only. */
const shadcnVariants: Readonly<Record<string, string>> = {
  default: "<Button>",
  destructive: '<Button tone="destructive">',
  secondary: '<Button tone="secondary">',
  ghost: '<Button variant="plain">',
  link: '<Button variant="plain" href="/path">',
};

/** The dev message for a variant that is not one of Ouro UI's. */
function variantWarning(variant: string): readonly [string, string] {
  const fix = Object.hasOwn(shadcnVariants, variant) ? shadcnVariants[variant]! : '<Button variant="solid">';
  return [`variant="${variant}" is not a variant`, fix];
}

/** The dev message for a size that is not one of Ouro UI's, such as shadcn's `default` and `icon`. */
function sizeWarning(size: string): readonly [string, string] {
  const fix = size === "icon" ? '<Button aria-label="Add"><PlusIcon /></Button>' : '<Button size="md">';
  return [`size="${size}" is not a size`, fix];
}

function Spinner({ fadeIn }: { fadeIn: boolean }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-0 flex items-center justify-center transition-opacity duration-(--ouro-duration-base) ease-(--ouro-ease-out)",
        fadeIn && "starting:opacity-0",
      )}
    >
      <svg
        data-ouro-spinner=""
        viewBox="0 0 24 24"
        fill="none"
        className="size-[1.25em] animate-[ouro-spin_0.8s_linear_infinite] motion-reduce:animate-[ouro-pulse_1.6s_ease-in-out_infinite]"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

const preventDefault = (event: MouseEvent) => event.preventDefault();

/** What takes Return itself, so a dialog's default action leaves it be: controls, links, options and an open list. */
const takesReturn =
  "button,a[href],select,[contenteditable]:not([contenteditable=false]),input:is([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=file])," +
  "[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=treeitem],[aria-expanded=true]";

/** Whether this key press is Return for the default action of the dialog `root`. */
function returnPresses(event: globalThis.KeyboardEvent, root: Element): boolean {
  if (event.key !== "Enter" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return false;
  const target = event.target as Element;
  if (!root.contains(target)) return false;
  if (target.matches("textarea")) return event.metaKey || event.ctrlKey;
  return !target.matches(takesReturn);
}

/**
 * A button, or a link styled as one. The obvious name for any action: pressing
 * it gives physical feedback, it has a 44px touch target on phones, and `loading`
 * handles the busy state without the layout jumping.
 *
 * Use `href` to navigate (it renders a link); use `type="submit"` in a form.
 * Use `Text` with an `<a>` instead when a link sits inside running text.
 *
 * A button that opens a dialog says so with `aria-haspopup="dialog"`; pressing it (or Enter or
 * Space on it) while the page smooth-scrolls then stops the page where it is until its click, so
 * the release lands on the button and the dialog opens.
 *
 * @group Actions
 * @see https://ui.ouroboros.bot/docs/button
 *
 * @example
 * <Button onClick={save} loading={saving}>Save</Button>
 * <Button href="/recipes/new" startIcon={PlusIcon}>New recipe</Button>
 * <Button tone="destructive" variant="soft" type="submit">Delete</Button>
 * @claim "The obvious name for any action" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::press feedback > scales to --ouro-press-scale while pressed)
 * @claim "then stops the page where it is until its click" registry/ouro/components/ouro/button/button.test.tsx verify:fileLine(registry/ouro/components/ouro/button/button.test.tsx, /with aria-haspopup="dialog", stops the scroll where/)
 * @claim "then stops the page where it is until its click" registry/ouro/components/ouro/dialog/dialog.test.tsx verify:fileLine(registry/ouro/components/ouro/dialog/dialog.test.tsx, /opens and leaves the page where the press found it, pressed mid-scroll/)
 * @claim "The obvious name for any action" registry/ouro/components/ouro/button/button.touch.test.tsx verify:fileLine(registry/ouro/components/ouro/button/button.touch.test.tsx, /44px hit area on a coarse pointer/)
 * @claim "The obvious name for any action" registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::loading > sets aria-busy, disables without losing focus, and keeps the width within 1px)
 */
export function Button(props: ButtonProps): JSX.Element {
  const {
    tone: toneProp = "primary",
    variant: variantProp = "solid",
    size: sizeProp = "md",
    fullWidth,
    loading,
    loadingLabel = "Loading",
    startIcon: StartIcon,
    endIcon: EndIcon,
    children,
    className,
    // Guard props (hint types), dropped here so they never reach the DOM.
    isLoading,
    color,
    asChild,
    leftIcon,
    rightIcon,
    reloadDocument,
    default: isDefault,
    ...rest
  } = props;
  // A tone, variant or size that is not one of Ouro UI's (a type error) warns and renders the default.
  const tone = Object.hasOwn(looks.solid, toneProp) ? (toneProp as keyof typeof looks.solid) : "primary";
  const variant = Object.hasOwn(looks, variantProp) ? (variantProp as keyof typeof looks) : "solid";
  const size = Object.hasOwn(sizes, sizeProp) ? (sizeProp as keyof typeof sizes) : "md";
  useAppearanceClassNameCheck(
    "Button",
    className,
    process.env.NODE_ENV !== "production" ? buttonHint : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Button",
    process.env.NODE_ENV !== "production"
      ? () => {
          const link = rest as { href?: string; type?: string; disabled?: boolean };
          return [
            tone !== toneProp && toneWarning("Button", String(toneProp), Object.keys(looks.solid)),
            variant !== variantProp && variantWarning(String(variantProp)),
            size !== sizeProp && sizeWarning(String(sizeProp)),
            isLoading !== undefined && ["isLoading is not a prop", "<Button loading>"],
            color !== undefined && ["color is not a prop", `<Button tone="${toneFor(`bg-${String(color)}`)}">`],
            asChild !== undefined && ["asChild is not a prop", '<Button href="/path">'],
            leftIcon !== undefined && ["leftIcon is not a prop", "<Button startIcon={Icon}>"],
            rightIcon !== undefined && ["rightIcon is not a prop", "<Button endIcon={Icon}>"],
            link.href === undefined &&
              link.type !== undefined &&
              !buttonTypes.includes(link.type as (typeof buttonTypes)[number]) && [
                `type="${link.type}" is not a button type; use "button", "submit", "reset"`,
                Object.hasOwn(looks.solid, link.type) ? `<Button tone="${link.type}">` : '<Button type="button">',
              ],
            link.href === undefined &&
              reloadDocument !== undefined && ["reloadDocument needs href", '<Button href="/path" reloadDocument>'],
            link.href !== undefined &&
              link.type !== undefined && [
                `a link has no type, so type="${link.type}" is ignored`,
                `<Button type="${link.type}"> without href`,
              ],
            link.href !== undefined &&
              link.disabled !== undefined && ["a link cannot be disabled", "<Button disabled> without href"],
          ];
        }
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );

  // Speak the busy state when loading turns on. The shared region sits outside the
  // button, so the button's accessible name stays exactly its label.
  const wasLoading = useRef(loading);
  // A button that mounts already loading draws its spinner on the first frame; it fades in only when loading turns on later.
  const [mounted, setMounted] = useState(false);
  useEffect(
    () => {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
    },
    // Stryker disable next-line ArrayDeclaration: an effect that only sets a flag to true runs the same whatever its list holds.
    [],
  );
  useEffect(() => {
    if (loading && !wasLoading.current) announce(loadingLabel);
    wasLoading.current = loading;
  }, [loading, loadingLabel]);

  // The default action listens on the document, after React's own handlers, so a key the app took
  // (an open list's Return) is seen as taken; the button's latest onClick gets the key's own event.
  const own = useRef<HTMLElement | null>(null);
  const press = useRef<((event: globalThis.KeyboardEvent) => void) | undefined>(undefined);
  const onClick = (rest as unknown as { onClick?: (event: globalThis.KeyboardEvent) => void }).onClick;
  useEffect(() => {
    press.current = onClick;
  });
  const pressable = isDefault && rest.href === undefined && !(rest as { disabled?: boolean }).disabled && !loading;
  useEffect(() => {
    const root = pressable ? own.current!.closest("[role=dialog],[role=alertdialog]") : null;
    if (!root) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!returnPresses(event, root)) return;
      event.preventDefault();
      press.current?.(event);
      // A submit button sends its form, once: the browser's own submit on Return was prevented above.
      const button = own.current as HTMLButtonElement;
      if (button.type === "submit") button.form?.requestSubmit(button);
    };
    root.ownerDocument.addEventListener("keydown", onKeyDown);
    return () => root.ownerDocument.removeEventListener("keydown", onKeyDown);
  }, [pressable]);

  const buttonRef = useMergedRef((rest as { ref?: Ref<HTMLElement> }).ref, own);
  // An icon-only button (one element as its whole label, named by aria-label or aria-labelledby) is at least as wide as
  // it is tall, so an icon's button is square, as shadcn's icon size is, and a theme whose controls are capsules draws
  // it as a circle. Its width is a floor, so content that is wider than the height keeps its width.
  // A picture whose width and height differ, such as a logo, is not an icon: it keeps the label's padding.
  const named = rest as { "aria-label"?: string; "aria-labelledby"?: string };
  const iconOnly =
    size !== "inline" &&
    !StartIcon &&
    !EndIcon &&
    isValidElement<{ width?: unknown; height?: unknown }>(children) &&
    children.type !== Fragment &&
    !(children.type === "img" && children.props.width !== children.props.height) &&
    Boolean(named["aria-label"] || named["aria-labelledby"]);
  const classes = cn(base, iconChildClass, sizes[size], iconOnly && iconOnlyClass, looks[variant][tone], fullWidth && "w-full", className);

  // The touch target comes first and the label is positioned, so the label paints above
  // the target: the target still enlarges the hit area, and nothing covers the text
  // (axe can check its contrast).
  const fade = cn("relative transition-opacity duration-(--ouro-duration-fast) ease-(--ouro-ease-out)", loading && "opacity-0");
  const content = (
    <>
      <TouchTarget />
      <span data-ouro-surface="" aria-hidden="true" />
      <span
        data-ouro-label=""
        // The label takes the room a wider button has, aligned as the button aligns it (centred, or the app's
        // justify-start), so an end icon after it sits at the end.
        className={cn("inline-flex grow items-center gap-[inherit] [justify-content:inherit]", fade)}
      >
        {StartIcon && <StartIcon aria-hidden="true" className={cn(iconClass, "-ms-0.5")} />}
        {children}
      </span>
      {EndIcon && <EndIcon aria-hidden="true" className={cn(iconClass, fade, "-me-0.5")} />}
      {loading && <Spinner fadeIn={mounted} />}
    </>
  );

  if (rest.href !== undefined) {
    // `type` and `disabled` are typed `never` on links; drop them if they arrive anyway.
    const { onClick, type: _type, disabled: _disabled, ...anchorProps } = rest as Omit<ButtonLinkProps, keyof ButtonBaseProps>;
    return (
      <RouterLink
        data-ouro-control="button"
        data-ouro-part="root"
        {...anchorProps}
        reloadDocument={reloadDocument}
        onClick={loading ? preventDefault : onClick}
        onAuxClick={loading ? preventDefault : anchorProps.onAuxClick}
        className={classes}
        data-ouro="button"
        data-ouro-squircle=""
        data-variant={variant}
        data-tone={tone}
        data-loading={loading ? "" : undefined}
        data-disabled={loading ? "" : undefined}
        aria-busy={loading || anchorProps["aria-busy"]}
        aria-disabled={loading || anchorProps["aria-disabled"]}
      >
        {content}
      </RouterLink>
    );
  }

  // Stryker disable next-line StringLiteral: a type that is not a button type renders "button", so "" does too.
  const { ref: _ref, disabled, type: typeProp = "button", ...buttonProps } = rest as Omit<ButtonButtonProps, keyof ButtonBaseProps>;
  // A button that opens a dialog (its own, or a component's trigger) holds the page from the press,
  // so a release during a smooth scroll lands on it and its click opens the dialog.
  const holdsPage =
    buttonProps["aria-haspopup"] === "dialog"
      ? {
          onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
            buttonProps.onPointerDown?.(event);
            holdPageAtPress.dialog.onPointerDown(event);
          },
          onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
            buttonProps.onKeyDown?.(event);
            holdPageAtPress.dialog.onKeyDown(event);
          },
        }
      : {};
  // A type that is not a button type would submit forms (the browser's default), so it renders "button".
  const type = buttonTypes.includes(typeProp as (typeof buttonTypes)[number]) ? (typeProp as (typeof buttonTypes)[number]) : "button";
  return (
    <BaseButton
      data-ouro-control="button"
      data-ouro-part="root"
      {...buttonProps}
      {...holdsPage}
      ref={buttonRef}
      type={type}
      disabled={Boolean(disabled || loading)}
      focusableWhenDisabled={Boolean(loading && !disabled)}
      className={classes}
      data-ouro="button"
      data-ouro-squircle=""
      data-variant={variant}
      data-tone={tone}
      data-loading={loading ? "" : undefined}
      data-default={isDefault ? "" : undefined}
      aria-keyshortcuts={isDefault ? "Enter" : buttonProps["aria-keyshortcuts"]}
      aria-busy={loading || buttonProps["aria-busy"]}
    >
      {content}
    </BaseButton>
  );
}
