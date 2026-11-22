"use client";

import type { HTMLAttributes, JSX, ReactNode, Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { Heading } from "@/components/ouro/text/heading";

/** The props SectionHeader adds to the `<div>` attributes it passes through. */
export interface SectionHeaderOwnProps {
  /** The section's title, its `<h2>` (or `<h3>` with `level={3}`), in the theme's heading font. */
  title: ReactNode;
  /**
   * A short count or status at the end of the row, in small tracked capitals: "2 recipes · 2 cookbooks".
   * It wraps under the title when the row is too narrow for both.
   * @claim "in small tracked capitals" registry/ouro/components/ouro/section-header/section-header.test.tsx verify:testExists(registry/ouro/components/ouro/section-header/section-header.test.tsx::SectionHeader > sets the meta in small tracked capitals in the muted color, after the title)
   */
  meta?: ReactNode;
  /**
   * A text action at the end of the row, such as a `Link` to the whole list. It stays on the title's row
   * at every width.
   * @claim "It stays on the title's row" registry/ouro/components/ouro/section-header/section-header.test.tsx verify:testExists(registry/ouro/components/ouro/section-header/section-header.test.tsx::SectionHeader > keeps the action on the title's row on a phone, with the meta between them)
   */
  actions?: ReactNode;
  /** The title's heading level: `2` under the page's `<h1>`, `3` for a section inside one. @default 2 */
  level?: 2 | 3 | (number & { 'Use 2 for a section or 3 for one inside it': never }) | undefined;
  /**
   * The hairline under the row, between the header and the section's content. @default true
   * @claim "The hairline under the row" registry/ouro/components/ouro/section-header/section-header.test.tsx verify:testExists(registry/ouro/components/ouro/section-header/section-header.test.tsx::SectionHeader > draws a hairline in the border color under the row, and none with divider false)
   */
  divider?: boolean | undefined;
  /** Layout only: margins, width (`mt-8`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;

  /** Not a prop. The count is `meta`: `<SectionHeader title="Recipes" meta="12 recipes" />`. */
  count?: { 'Use meta="12 recipes"': never };
  /** Not a prop. The text beside the title is `meta`: `<SectionHeader meta="2 shelves" />`. */
  description?: { 'Use meta="2 shelves"; a sentence belongs in the section': never };
  /** Not a prop. The link is `actions`: `<SectionHeader actions={<Link href="/recipes">See all</Link>} />`. */
  action?: { 'Use actions={<Link href="...">See all</Link>}': never };
  /** Not a prop. The title is `title`: `<SectionHeader title="Recipes" />`. */
  heading?: { 'Use <SectionHeader title="Recipes" />': never };
}

/** Props for {@link SectionHeader}: its own props and the `<div>` attributes it passes through. */
export type SectionHeaderProps = Omit<HTMLAttributes<HTMLDivElement>, keyof SectionHeaderOwnProps> & SectionHeaderOwnProps;

/**
 * The head of a section inside a page: its title in the theme's heading font, a short count in
 * small capitals at the end of the row (`meta`), an optional text action such as a link to the whole list, and a
 * hairline under it. The action stays on the title's row on phones.
 *
 * Use `PageHeader` instead for the top of the page, with its eyebrow, description and buttons,
 * and `Heading` instead for a title with nothing around it.
 *
 * @group Layout
 * @see https://ui.ouroboros.bot/docs/section-header
 *
 * @example
 * <SectionHeader
 *   title="Your recipes"
 *   meta="2 recipes · 2 cookbooks"
 *   actions={<Link href="/recipes">See all</Link>}
 * />
 */
export function SectionHeader(props: SectionHeaderProps): JSX.Element {
  const {
    title,
    meta,
    actions,
    level: levelProp = 2,
    divider = true,
    className,
    // Guard props (hint types), dropped here so they never reach the DOM.
    count,
    description,
    action,
    heading,
    ...rest
  } = props;
  const level = levelProp === 3 ? 3 : 2;
  useAppearanceClassNameCheck(
    "SectionHeader",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; SectionHeader sets its own look from the theme`
      : // Stryker disable next-line StringLiteral: production only; the check never runs there.
        /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "SectionHeader",
    process.env.NODE_ENV !== "production"
      ? () => [
          level !== levelProp && [`level={${String(levelProp)}} is not a level; use 2 or 3`, "<SectionHeader level={3} />"],
          count !== undefined && ["count is not a prop", `<SectionHeader meta="${typeof count === "string" || typeof count === "number" ? String(count) : "..."}" />`],
          description !== undefined && ["description is not a prop", '<SectionHeader meta="2 shelves" />'],
          action !== undefined && ["action is not a prop", '<SectionHeader actions={<Link href="...">See all</Link>} />'],
          heading !== undefined && ["heading is not a prop", `<SectionHeader title="${typeof heading === "string" ? heading : "..."}" />`],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  return (
    <div
      {...rest}
      data-ouro="section-header"
      className={cn("flex min-w-0 items-baseline gap-x-3", divider && "border-0 border-b border-solid border-border pb-2", className)}
    >
      <div className="flex min-w-0 grow flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <Heading level={level} size={level === 2 ? "lg" : "md"} className="min-w-0 grow break-words">
          {title}
        </Heading>
        {meta != null ? (
          <p data-slot="meta" className="m-0 text-xs leading-4 font-medium tracking-[0.08em] text-muted-foreground uppercase tabular-nums">
            {meta}
          </p>
        ) : null}
      </div>
      {actions != null ? (
        <div data-slot="actions" className="flex shrink-0 items-baseline gap-3 text-sm">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
