"use client";

import { Fragment, type HTMLAttributes, type JSX, type ReactNode, type Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings, type DevWarning } from "@/lib/ouro/use-dev-messages";

/** One pair in a {@link DescriptionList}: what it is, and its value. */
export interface DescriptionListItem {
  /** What the details describe: "Prep time", "Email". */
  term: ReactNode;
  /** The value: text, a link, a badge. */
  details: ReactNode;

  /** Not a prop. Ouro UI uses `term`: `{ term: "Prep time", details: "20 minutes" }`. */
  label?: { 'Use term: "Prep time"': never };
  /** Not a prop. Ouro UI uses `details`: `{ term: "Prep time", details: "20 minutes" }`. */
  value?: { 'Use details: "20 minutes"': never };
  /** Not a prop. Ouro UI uses `details`: `{ term: "Prep time", details: "20 minutes" }`. */
  description?: { 'Use details: "20 minutes"': never };
}

/** The props DescriptionList adds to the `<dl>` attributes it passes through. */
export interface DescriptionListOwnProps {
  /** The pairs, in order: `{ term, details }`. */
  items: readonly DescriptionListItem[];
  /**
   * While the list itself is narrower than this, each term sits above its details, as on a
   * phone or in a narrow sheet; from it up, the terms form a column beside them. `sm` is
   * 28rem (448px), `md` 32rem (512px). The list's own width decides, not the window's, so a
   * list in a side sheet stacks on a wide screen too.
   * @default "sm"
   * @claim "While the list itself is narrower" registry/ouro/components/ouro/description-list/description-list.test.tsx verify:testExists(registry/ouro/components/ouro/description-list/description-list.test.tsx::DescriptionList > puts each term beside its details in a list 28rem wide or more, in one shared column of terms)
   * @claim "While the list itself is narrower" registry/ouro/components/ouro/description-list/description-list.test.tsx verify:testExists(registry/ouro/components/ouro/description-list/description-list.test.tsx::DescriptionList > stacks each term above its details in a list narrower than 28rem, however wide the window)
   * @claim "`sm` is 28rem (448px), `md`" registry/ouro/components/ouro/description-list/description-list.test.tsx verify:testExists(registry/ouro/components/ouro/description-list/description-list.test.tsx::DescriptionList > stacks below 32rem with stackBelow=md)
   */
  stackBelow?: "sm" | "md" | (string & { 'Use "sm" (448px) or "md" (512px)': never }) | undefined;
  /** Layout only: margins, width (`mt-6`, `max-w-2xl`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLDListElement> | undefined;

  /** Not a prop. Ouro UI uses `items`: `<DescriptionList items={[{ term, details }]}>`. */
  data?: { "Use items={[{ term: ..., details: ... }]}": never };
  /** Not a prop. The list comes from `items`: `<DescriptionList items={[{ term, details }]}>`. */
  children?: { "Use items={[{ term: ..., details: ... }]}": never };
}

/** Props for {@link DescriptionList}: its own props and the `<dl>` attributes it passes through. */
export type DescriptionListProps = Omit<HTMLAttributes<HTMLDListElement>, keyof DescriptionListOwnProps> & DescriptionListOwnProps;

// The list is a size container, so its own width, not the window's, decides the layout. Its
// columns read a variable, so an app's grid-cols-* class still wins; stacked, each term and its
// details span both columns. Stacked, a line runs above each term; side by side, above each
// term and its details.
const layouts = {
  sm: {
    root: "@container grid-cols-(--ouro-dl-cols) [--ouro-dl-cols:min(40%,14rem)_minmax(0,1fr)]",
    term: "col-span-full @md:col-span-1 pt-3 pb-1 @md:py-3 first:pt-0 @md:first:pt-0",
    details: "col-span-full @md:col-span-1 pb-3 @md:border-t @md:border-border @md:py-3 @md:nth-2:border-t-0 @md:nth-2:pt-0",
  },
  md: {
    root: "@container grid-cols-(--ouro-dl-cols) [--ouro-dl-cols:min(40%,14rem)_minmax(0,1fr)]",
    term: "col-span-full @lg:col-span-1 pt-3 pb-1 @lg:py-3 first:pt-0 @lg:first:pt-0",
    details: "col-span-full @lg:col-span-1 pb-3 @lg:border-t @lg:border-border @lg:py-3 @lg:nth-2:border-t-0 @lg:nth-2:pt-0",
  },
} as const;

function itemWarnings(items: readonly DescriptionListItem[]): DevWarning[] {
  return items.flatMap((item): DevWarning[] => [
    item.label !== undefined && ["an item's label is not a prop", `{ term: "${String(item.label)}", details: … }`],
    item.value !== undefined && ["an item's value is not a prop", `{ term: …, details: "${String(item.value)}" }`],
    item.description !== undefined && ["an item's description is not a prop", `{ term: …, details: "${String(item.description)}" }`],
  ]);
}

/**
 * One thing's details as pairs of a term and its value: a recipe's prep time and servings,
 * an order's date and total, an account's email. In a narrow space, a phone or a side sheet,
 * each term sits above its details; once the list is 28rem wide the terms form a column beside
 * them, with a line between the pairs. It takes the width it is given.
 *
 * Use `Table` instead to compare many things across the same columns, and `ItemGroup` for
 * a list of things a person opens or acts on.
 *
 * @group Display
 * @see https://ui.ouroboros.bot/docs/description-list
 *
 * @example
 * <DescriptionList
 *   items={[
 *     { term: "Prep time", details: "20 minutes" },
 *     { term: "Cook time", details: "4 hours" },
 *     { term: "Serves", details: "6" },
 *   ]}
 * />
 * @claim "In a narrow space, a phone" registry/ouro/components/ouro/description-list/description-list.test.tsx verify:testExists(registry/ouro/components/ouro/description-list/description-list.test.tsx::DescriptionList > puts each term beside its details in a list 28rem wide or more, in one shared column of terms)
 * @claim "In a narrow space, a phone" registry/ouro/components/ouro/description-list/description-list.test.tsx verify:testExists(registry/ouro/components/ouro/description-list/description-list.test.tsx::DescriptionList > stacks each term above its details in a list narrower than 28rem, however wide the window)
 * @claim "In a narrow space, a phone" registry/ouro/components/ouro/description-list/description-list.test.tsx verify:testExists(registry/ouro/components/ouro/description-list/description-list.test.tsx::DescriptionList > stacks each term above its details on a phone)
 * @claim "It takes the width it is" registry/ouro/components/ouro/description-list/description-list.test.tsx verify:testExists(registry/ouro/components/ouro/description-list/description-list.test.tsx::DescriptionList > takes the width it is given in a row, as a size container must)
 */
export function DescriptionList(props: DescriptionListProps): JSX.Element {
  const { items: itemsProp, stackBelow: stackBelowProp = "sm", className, data, children, ...rest } = props;
  const items = itemsProp ?? [];
  const stackBelow = stackBelowProp === "md" ? "md" : "sm";
  useAppearanceClassNameCheck(
    "DescriptionList",
    className,
    process.env.NODE_ENV !== "production"
      ? 'pass styled content in details, such as <Text size="lg">'
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "DescriptionList",
    process.env.NODE_ENV !== "production"
      ? () => [
          data !== undefined && ["data is not a prop", "<DescriptionList items={[{ term: …, details: … }]}>"],
          itemsProp === undefined &&
            data === undefined && ["items is required; it holds the pairs", '<DescriptionList items={[{ term: "Prep time", details: "20 minutes" }]}>'],
          children !== undefined && [
            "children are not rendered; the list comes from items",
            '<DescriptionList items={[{ term: "Prep time", details: "20 minutes" }]}>',
          ],
          stackBelow !== stackBelowProp && [
            `stackBelow="${String(stackBelowProp)}" is not a breakpoint; use "sm", "md"`,
            '<DescriptionList stackBelow="sm">',
          ],
          ...itemWarnings(items),
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const layout = layouts[stackBelow];
  return (
    <dl {...rest} data-ouro="description-list" className={cn("[@layer_ouro-reset]:m-0 grid w-full min-w-0 text-base pointer-fine:text-sm", layout.root, className)}>
      {items.map((item, index) => {
        // A guessed `label` or `value` still shows, beside its development message.
        const loose = item as unknown as { label?: ReactNode; value?: ReactNode; description?: ReactNode };
        return (
          <Fragment key={index}>
            <dt className={cn("m-0 border-t border-border font-normal text-muted-foreground wrap-break-word first:border-t-0", layout.term)}>{item.term ?? loose.label}</dt>
            <dd className={cn("m-0 text-foreground wrap-break-word", layout.details)}>{item.details ?? loose.value ?? loose.description}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}
