"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ComponentType, JSX, HTMLAttributes, MouseEventHandler, ReactNode, Ref, SVGProps } from "react";
import { fontFor, radiusFor, toneFor } from "@/lib/ouro/appearance-hints";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { RouterLink } from "@/lib/ouro/router-link";
import { toneWarning } from "@/lib/ouro/tones";
import { TouchTarget } from "@/lib/ouro/touch-target";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";

/** An icon component, such as one from `lucide-react` or `@heroicons/react`. */
export type BadgeIcon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Props shared by every kind of Badge (`href` makes a link, `onClick` a button).
 *
 * @claim "Props shared by every kind of" registry/ouro/components/ouro/badge/badge.test.tsx verify:testExists(registry/ouro/components/ouro/badge/badge.test.tsx::Badge > renders a button with onClick, with a touch target and press feedback)
 * @claim "Props shared by every kind of" registry/ouro/components/ouro/badge/badge.test.tsx verify:testExists(registry/ouro/components/ouro/badge/badge.test.tsx::Badge > renders a link with href through the provider's linkComponent)
 */
export interface BadgeBaseProps {
  /**
   * Color role from the theme, named after its token. `secondary` is a quiet neutral
   * label; use `success`, `warning` and `destructive` for status.
   * shadcn's `variant="destructive"` is `tone="destructive"`.
   * @default "secondary"
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
   * Visual weight: `solid` fills the badge with the tone, `soft` tints it, `outline`
   * draws only the border. shadcn's `default` is `tone="primary"`, its `secondary` and
   * `destructive` are tones, and `ghost` is `soft`.
   * @default "solid"
   */
  variant?:
    | "solid"
    | "soft"
    | "outline"
    | (string & { 'From shadcn? secondary and destructive are tones; default is tone="primary"; ghost is "soft"': never })
    | undefined;
  /**
   * Runs when the badge is pressed. Without `href` it makes the badge a `<button>`
   * (pass `aria-pressed` too when it toggles a filter); with `href` it runs before the
   * link navigates.
   */
  onClick?: MouseEventHandler<HTMLElement> | undefined;
  /** Icon before the label. Pass the component, not an element: `icon={CheckIcon}`. */
  icon?: BadgeIcon | undefined;
  /**
   * A status dot before the label, in the tone's colour: `<Badge tone="success" dot>Published</Badge>`.
   * The dot is decorative; the label names the status.
   * @default false
   * @claim "A status dot before the label, in the tone's colour" registry/ouro/components/ouro/badge/badge.test.tsx verify:testExists(registry/ouro/components/ouro/badge/badge.test.tsx::Badge > shows a status dot before its label, in the tone's colour)
   */
  dot?: boolean | undefined;
  /** The label: a short word, or a count. */
  children: ReactNode;
  /** Layout only: margins, grid placement (`ms-2`). Appearance classes warn in development; use `tone` and `variant`. */
  className?: string | undefined;

  /** Not a prop. Ouro UI uses `tone`: `<Badge tone="destructive">`. */
  color?: { 'Use <Badge tone="destructive">': never };
  /** Not a prop. To render a link, pass `href`: `<Badge href="/tags/vegan">`. */
  asChild?: { 'Use <Badge href="/path">': never };
}

/** The props only a link Badge takes: `href` and the anchor's own attributes (`target`, `rel`, `download`). */
export type BadgeLinkModeProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof HTMLAttributes<HTMLAnchorElement> | "type"> & {
  /**
   * Where the link goes. Internal paths render through `OuroProvider`'s
   * `linkComponent` (your router's link); absolute URLs render as a plain `<a>`, and
   * with `target="_blank"` always get `rel="noopener noreferrer"`.
   * @claim "Internal paths render through `OuroProvider`'s `linkComponent`" registry/ouro/components/ouro/badge/badge.test.tsx verify:testExists(registry/ouro/components/ouro/badge/badge.test.tsx::Badge > renders an absolute URL as a plain <a> with a safe rel in a new tab)
   * @claim "Internal paths render through `OuroProvider`'s `linkComponent`" registry/ouro/components/ouro/badge/badge.test.tsx verify:testExists(registry/ouro/components/ouro/badge/badge.test.tsx::Badge > renders a link with href through the provider's linkComponent)
   */
  href: string;
  /**
   * Links have no `type`. Remove `href` and pass `onClick` for a button.
   *
   * @claim "Links have no `type`" registry/ouro/components/ouro/badge/badge.tsx verify:fileLine(registry/ouro/components/ouro/badge/badge.tsx, /^\s+type\?:\snever;/)
   */
  type?: never;
  /** A link cannot be disabled. Remove `href` and pass `onClick` for a button. */
  disabled?: never;
  ref?: Ref<HTMLAnchorElement> | undefined;
};

/** The props only a Badge without `href` takes: the button's own attributes (`type`, `disabled`). */
export type BadgeButtonModeProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof HTMLAttributes<HTMLButtonElement> | "type"> & {
  /** Not set: a static badge or, with `onClick`, a button. Pass `href` for a link. */
  href?: never;
  /** With `onClick`, the button's role in a form. @default "button" */
  type?: "button" | "submit" | "reset" | undefined;
  ref?: Ref<HTMLButtonElement & HTMLSpanElement> | undefined;
};

/**
 * The HTML attributes every kind of Badge passes through, outside the mode union so the editor keeps their hover docs.
 *
 * @claim "The HTML attributes every kind of" registry/ouro/components/ouro/badge/badge.test.tsx verify:testExists(registry/ouro/components/ouro/badge/badge.test.tsx::Badge > passes aria-pressed through for a filter badge)
 * @claim "The HTML attributes every kind of" registry/ouro/components/ouro/badge/badge.test.tsx verify:testExists(registry/ouro/components/ouro/badge/badge.test.tsx::Badge development messages > keeps button attributes off a static badge)
 */
type BadgeCommonProps = Omit<HTMLAttributes<HTMLElement>, keyof BadgeBaseProps> & BadgeBaseProps;

/** A Badge with `href`: a link that looks like a badge, such as a tag that opens its list. */
export type BadgeLinkProps = BadgeCommonProps & BadgeLinkModeProps;

/**
 * A Badge without `href`: a `<button>` when it has `onClick`, such as a filter chip (pass
 * `aria-pressed` for a toggle), and otherwise a static `<span>` label.
 */
export type BadgeButtonProps = BadgeCommonProps & BadgeButtonModeProps;

/** Props for {@link Badge}: `href` makes it a link, `onClick` a button, and neither a `<span>`. */
export type BadgeProps = BadgeCommonProps & (BadgeLinkModeProps | BadgeButtonModeProps);

// Class strings are literal so the app's Tailwind finds them when it compiles.
const base =
  "relative isolate box-border inline-flex shrink-0 items-center gap-1 align-middle " +
  // Stryker disable next-line StringLiteral: a class string in a class position, unchanged but for the joining plus
  "h-6 rounded-ouro-md border border-solid px-2 text-xs/none font-medium whitespace-nowrap no-underline " +
  // Where corner-shape is missing, the surface slot paints the background, border and state layer instead (see ouro-base.css).
  "bg-(--ouro-bg) border-(--ouro-bd) [--ouro-sq-w:1px] [--ouro-sq-r:calc(var(--radius)*var(--ouro-radius-scale,1)*0.8)]";

// Only for the link and button kinds: press feedback, a state layer and the focus ring,
// as on Button.
const interactive =
  "press cursor-pointer select-none touch-manipulation [-webkit-tap-highlight-color:transparent] " +
  "outline-ring outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid " +
  "before:pointer-events-none before:absolute before:-inset-px before:rounded-[inherit] before:[corner-shape:inherit] before:bg-current " +
  "before:opacity-0 before:transition-opacity before:duration-(--ouro-duration-fast) before:ease-[ease] " +
  // Stryker disable next-line StringLiteral: a class string in a class position; test/state-hovers.test.tsx reads its tokens, outside this file's tests
  "not-data-disabled:not-active:pointer-fine:hover:before:opacity-[var(--ouro-state-hover,8%)] not-data-disabled:active:before:opacity-[var(--ouro-state-pressed,14%)] " +
  // Stryker disable next-line StringLiteral: a class string in a class position, which no test reads
  "not-data-disabled:not-active:pointer-fine:hover:[--ouro-state:var(--ouro-state-hover,8%)] not-data-disabled:active:[--ouro-state:var(--ouro-state-pressed,14%)] " +
  "motion-safe:not-data-disabled:active:scale-(--ouro-press-scale) " +
  "disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50";

// `soft` text is the tone mixed 20% toward the foreground, as on Button, so it keeps
// 4.5:1 on the tint under shadcn's stock values too. `secondary` is shadcn's quiet surface.
const looks = {
  solid: {
    primary: "[--ouro-bd:transparent] [--ouro-bg:var(--primary)] text-primary-foreground",
    secondary: "[--ouro-bd:transparent] [--ouro-bg:var(--secondary)] text-secondary-foreground",
    destructive: "[--ouro-bd:transparent] [--ouro-bg:var(--destructive)] text-destructive-foreground",
    success: "[--ouro-bd:transparent] [--ouro-bg:var(--success)] text-success-foreground",
    warning: "[--ouro-bd:transparent] [--ouro-bg:var(--warning)] text-warning-foreground",
  },
  soft: {
    primary: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--primary)_10%,transparent)] text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))] contrast-more:[--ouro-bd:currentColor]",
    secondary: "[--ouro-bd:transparent] [--ouro-bg:var(--muted)] text-foreground contrast-more:[--ouro-bd:currentColor]",
    destructive: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--destructive)_10%,transparent)] text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))] contrast-more:[--ouro-bd:currentColor]",
    success: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--success)_10%,transparent)] text-[color-mix(in_oklab,var(--success)_80%,var(--foreground))] contrast-more:[--ouro-bd:currentColor]",
    warning: "[--ouro-bd:transparent] [--ouro-bg:color-mix(in_oklab,var(--warning)_10%,transparent)] text-[color-mix(in_oklab,var(--warning)_80%,var(--foreground))] contrast-more:[--ouro-bd:currentColor]",
  },
  outline: {
    primary: "[--ouro-bd:color-mix(in_oklab,var(--primary)_45%,transparent)] [--ouro-bg:transparent] text-primary",
    secondary: "[--ouro-bd:var(--border)] [--ouro-bg:transparent] text-foreground",
    destructive: "[--ouro-bd:color-mix(in_oklab,var(--destructive)_45%,transparent)] [--ouro-bg:transparent] text-destructive",
    success: "[--ouro-bd:color-mix(in_oklab,var(--success)_45%,transparent)] [--ouro-bg:transparent] text-success",
    warning: "[--ouro-bd:color-mix(in_oklab,var(--warning)_45%,transparent)] [--ouro-bg:transparent] text-warning",
  },
} as const;

/** shadcn's Badge variants, with the Ouro UI props that do the same job. Development only. */
const shadcnVariants: Readonly<Record<string, string>> = {
  default: '<Badge tone="primary" variant="solid">',
  secondary: '<Badge tone="secondary">',
  destructive: '<Badge tone="destructive">',
  ghost: '<Badge variant="soft">',
  link: '<Badge href="/path">',
};

function badgeHint(token: string): string {
  if (/^text-(xs|sm|base|lg|xl|\dxl)$/.test(token)) return `remove "${token}"; Badge sets its own size`;
  if (token.startsWith("font-")) return fontFor("Badge", token);
  if (token.startsWith("rounded")) return radiusFor(token);
  if (/^border-/.test(token)) return `variant="outline" tone="${toneFor(token)}"`;
  return `tone="${toneFor(token)}"`;
}

/**
 * A short label for a status, category or count: "Draft", "Vegan", "3". With `href` it
 * becomes a link and with `onClick` a button, with press feedback and a 44px touch
 * target on phones, the same way `Button` does. Without `onClick` or `href` a Badge is
 * not a button: it is a static `<span>`, and `disabled` and `type` do nothing.
 *
 * Use `Button` instead for an action that needs a clear call to action, and `Alert` for
 * a message the reader must notice.
 *
 * @group Display
 * @see https://ui.ouroboros.bot/docs/badge
 *
 * @example
 * <Badge>Draft</Badge>
 * <Badge tone="success" variant="soft">Published</Badge>
 * <Badge href="/tags/vegan">Vegan</Badge>
 * <Badge onClick={toggle} aria-pressed={active}>Quick</Badge>
 * @claim "With `href` it becomes a link" registry/ouro/components/ouro/badge/badge.test.tsx verify:testExists(registry/ouro/components/ouro/badge/badge.test.tsx::Badge > renders a button with onClick, with a touch target and press feedback)
 */
export function Badge(props: BadgeProps): JSX.Element {
  const {
    tone: toneProp = "secondary",
    variant: variantProp = "solid",
    icon: Icon,
    dot = false,
    onClick,
    children,
    className,
    // Guard props (hint types), dropped here so they never reach the DOM.
    color,
    asChild,
    ...rest
  } = props;
  // A tone or variant that is not one of Ouro UI's (a type error) warns and renders the default.
  const tone = Object.hasOwn(looks.solid, toneProp) ? (toneProp as keyof typeof looks.solid) : "secondary";
  const variant = Object.hasOwn(looks, variantProp) ? (variantProp as keyof typeof looks) : "solid";
  useAppearanceClassNameCheck(
    "Badge",
    className,
    process.env.NODE_ENV !== "production" ? badgeHint : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Badge",
    process.env.NODE_ENV !== "production"
      ? () => {
          const kind = rest as { href?: string; type?: string; disabled?: boolean };
          const isStatic = kind.href === undefined && onClick === undefined;
          return [
            tone !== toneProp && toneWarning("Badge", String(toneProp), Object.keys(looks.solid)),
            variant !== variantProp &&
              (Object.hasOwn(shadcnVariants, variantProp)
                ? [`variant="${variantProp}" is not a variant`, shadcnVariants[variantProp]!]
                : [`variant="${String(variantProp)}" is not a variant; use "solid", "soft", "outline"`, '<Badge variant="solid">']),
            color !== undefined && ["color is not a prop", `<Badge tone="${toneFor(`bg-${String(color)}`)}">`],
            asChild !== undefined && ["asChild is not a prop", '<Badge href="/path">'],
            kind.href !== undefined &&
              kind.type !== undefined && [`a link has no type, so type="${kind.type}" is ignored`, `<Badge onClick={…} type="${kind.type}"> without href`],
            isStatic &&
              kind.disabled !== undefined && [
                "disabled does nothing on a Badge without onClick, because a static Badge is not a button",
                "<Badge onClick={…} disabled>",
              ],
            isStatic &&
              kind.type !== undefined && [
                `type="${kind.type}" does nothing on a Badge without onClick, because a static Badge is not a button`,
                `<Button type="${kind.type}">`,
              ],
          ];
        }
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );

  const look = looks[variant][tone];
  // The icon and the label go in as siblings of the surface, not in a fragment, which would be a component of its own.
  const icon = Icon && <Icon aria-hidden="true" className="relative -ms-0.5 size-3.5 shrink-0" />;
  const statusDot = dot && <span data-slot="badge-dot" data-ouro-dot="" aria-hidden="true" className="relative size-1.5 shrink-0 rounded-full bg-current" />;

  if (rest.href !== undefined) {
    const { type: _type, disabled: _disabled, ...anchorProps } = rest as Omit<BadgeLinkProps, keyof BadgeBaseProps>;
    return (
      <RouterLink data-ouro-control="badge" data-ouro-part="root" data-slot="badge" {...anchorProps} onClick={onClick} data-ouro="badge" data-ouro-squircle="" className={cn(base, interactive, look, className)}>
        <TouchTarget />
        <span data-ouro-surface="" aria-hidden="true" style={{ zIndex: -1 }} />
        {statusDot}
        {icon}
        {children}
      </RouterLink>
    );
  }
  const { ref, type = "button", disabled, ...buttonProps } = rest as Omit<BadgeButtonProps, keyof BadgeBaseProps>;
  if (onClick !== undefined) {
    return (
      <BaseButton data-ouro-control="badge" data-ouro-part="root" data-slot="badge" {...buttonProps} onClick={onClick} disabled={disabled} ref={ref as Ref<HTMLElement> | undefined} type={type} data-ouro="badge" data-ouro-squircle="" className={cn(base, interactive, look, className)}>
        <TouchTarget />
        <span data-ouro-surface="" aria-hidden="true" style={{ zIndex: -1 }} />
        {statusDot}
        {icon}
        {children}
      </BaseButton>
    );
  }
  // A static Badge is a <span>, not a button: the button's own attributes are dropped.
  const { name: _name, value: _value, form: _form, ...spanProps } = buttonProps;
  return (
    <span data-slot="badge" {...(spanProps as HTMLAttributes<HTMLSpanElement>)} ref={ref} data-ouro="badge" data-ouro-squircle="" className={cn(base, look, className)}>
      <span data-ouro-surface="" aria-hidden="true" style={{ zIndex: -1 }} />
      {statusDot}
      {icon}
      {children}
    </span>
  );
}
