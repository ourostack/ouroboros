"use client";

import { Children, isValidElement, type HTMLAttributes, type JSX, type ReactNode, type Ref, useId } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";

/** The props ItemGroup adds to the div attributes it passes through. */
export interface ItemGroupOwnProps {
  /**
   * A short label above the list that also names it for screen readers: "Bearer
   * credentials". Without one, name the list with `aria-label`.
   */
  label?: string | undefined;
  /**
   * The rows: `Item`s. Each one becomes a list item.
   *
   * @claim "Each one becomes a list item" registry/ouro/components/ouro/item/item-group.test.tsx verify:testExists(registry/ouro/components/ouro/item/item-group.test.tsx::ItemGroup > is a list labelled by its label, with each Item a list item)
   */
  children?: ReactNode;
  /**
   * What to show in place of the list when there are no rows: a sentence, or an `Empty`.
   *
   * @claim "What to show in place of" registry/ouro/components/ouro/item/item-group.test.tsx verify:testExists(registry/ouro/components/ouro/item/item-group.test.tsx::ItemGroup > shows empty, outside any list, when there are no rows)
   * @claim "What to show in place of" registry/ouro/components/ouro/item/item-group.test.tsx verify:testExists(registry/ouro/components/ouro/item/item-group.test.tsx::ItemGroup > renders nothing for the list with no rows and no empty)
   */
  empty?: ReactNode;
  /**
   * `divided` draws a line between rows; `outline` frames them in a bordered surface and
   * pads them, as in a settings screen; `plain` has neither.
   * @default "divided"
   */
  variant?: "divided" | "outline" | "plain" | (string & { 'Use "divided", "outline" or "plain"': never }) | undefined;
  /** Renders an ordered list (`<ol>`), for rows whose order means something, such as steps. */
  ordered?: boolean | undefined;
  /** Layout only: margins, width, grid placement (`mt-4`). Appearance classes warn in development; use `variant`. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;

  /** Not a prop. Ouro UI uses `label`: `<ItemGroup label="Bearer credentials">`. */
  title?: { 'Use <ItemGroup label="Bearer credentials">': never };
  /** Not a prop. ItemGroup takes Items as children: `{rows.map((row) => <Item key={row.id} title={row.name} />)}`. */
  items?: { "Use children: {rows.map((row) => <Item key={row.id} title={row.name} />)}": never };
  /** Not a prop. Lines between rows are the default, `variant="divided"`. */
  divided?: { 'Use <ItemGroup variant="divided">': never };
}

/** Props for {@link ItemGroup}: its own props and the div attributes it passes through. */
export type ItemGroupProps = Omit<HTMLAttributes<HTMLDivElement>, keyof ItemGroupOwnProps> & ItemGroupOwnProps;

// The group sets its Items' frame: no outline of their own, and padding in an outlined group.
// A row a person chooses keeps its padding and corners in a divided or plain group, so its selected colour has room.
const choosable = "[&_[data-ouro=item][data-choosable]]:rounded-ouro-lg [&_[data-ouro=item][data-choosable]]:px-3";
// The outlined group doesn't clip what is in it: clipping a whole live list to a squircle repaints all of it on each change (#2349).
// Its first and last rows round their own outer corners to its radius less its border, and clip only their own highlight.
const outlineEnds =
  "[&>li:first-child]:overflow-clip [&>li:first-child]:rounded-t-[calc(var(--radius-ouro-xl)-1px)] " +
  "[&>li:last-child]:overflow-clip [&>li:last-child]:rounded-b-[calc(var(--radius-ouro-xl)-1px)]";
const variants = {
  divided:
    "[&>li:not(:last-child)]:border-b [&>li]:border-border [&_[data-ouro=item]]:rounded-none [&_[data-ouro=item]]:border-0 [&_[data-ouro=item]]:px-0 " +
    choosable,
  outline:
    "rounded-ouro-xl border border-border bg-card text-card-foreground [&>li:not(:last-child)]:border-b [&>li]:border-border " +
    outlineEnds +
    " [&_[data-ouro=item]]:rounded-none [&_[data-ouro=item]]:border-0 [&_[data-ouro=item]]:px-4",
  plain: `[&_[data-ouro=item]]:rounded-none [&_[data-ouro=item]]:border-0 [&_[data-ouro=item]]:px-0 ${choosable}`,
} as const;

/**
 * A list of `Item` rows, with an optional label that names it, lines between the rows, and
 * what to show when it is empty. It wraps each Item in an `<li>`, so screen readers count
 * the rows.
 *
 * Use `Stack` instead to space out content that is not a list of rows, and a grid of
 * `Card`s for larger tiles.
 *
 * @group Lists
 * @see https://ui.ouroboros.bot/docs/item-group
 *
 * @example
 * <ItemGroup label="Bearer credentials" empty="No active bearer credentials.">
 *   {credentials.map((credential) => (
 *     <Item key={credential.id} title={credential.name} description={credential.scopes} actions={<Button>Revoke</Button>} />
 *   ))}
 * </ItemGroup>
 * @claim "It wraps each Item in an" registry/ouro/components/ouro/item/item-group.test.tsx verify:testExists(registry/ouro/components/ouro/item/item-group.test.tsx::ItemGroup > is a list labelled by its label, with each Item a list item)
 */
export function ItemGroup(props: ItemGroupProps): JSX.Element {
  const { label, children, empty, variant: variantProp = "divided", ordered, className, title, items, divided, ...rest } = props;
  const labelId = useId();
  const variant = Object.hasOwn(variants, variantProp) ? (variantProp as keyof typeof variants) : "divided";
  const rows = Children.toArray(children);
  useAppearanceClassNameCheck(
    "ItemGroup",
    className,
    process.env.NODE_ENV !== "production" ? '<ItemGroup variant="outline">' : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "ItemGroup",
    process.env.NODE_ENV !== "production"
      ? () => [
          !label &&
            !rest["aria-label"] &&
            !rest["aria-labelledby"] && [
              "the list has no name",
              '<ItemGroup label="Bearer credentials">, or aria-label="…" to name it without showing a label',
            ],
          variant !== variantProp && [
            `variant="${String(variantProp)}" is not a variant; use "divided", "outline", "plain"`,
            '<ItemGroup variant="divided">',
          ],
          title !== undefined && ["title is not a prop", `<ItemGroup label="${String(title)}">`],
          items !== undefined && [
            "items is not a prop; ItemGroup takes Items as children",
            "<ItemGroup>{rows.map((row) => <Item key={row.id} title={row.name} />)}</ItemGroup>",
          ],
          divided !== undefined && ["divided is not a prop", '<ItemGroup variant="divided">'],
          rows.some((row) => isValidElement<{ as?: unknown }>(row) && row.props.as === "li") && [
            '<Item as="li"> puts a list item inside the list item ItemGroup already wraps each row in',
            '<Item title="…"> without as',
          ],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const { "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, ...wrapper } = rest;
  const List = ordered ? "ol" : "ul";
  return (
    <div {...wrapper} data-ouro="item-group" className={cn("group/item-group flex min-w-0 flex-col gap-2", className)}>
      {label && (
        // Lined up with the rows' text when they keep padding to show a selected row.
        <div id={labelId} className={cn("text-sm font-medium text-muted-foreground", variant !== "outline" && "group-has-[[data-choosable]]/item-group:px-3")}>
          {label}
        </div>
      )}
      {rows.length > 0 ? (
        <List
          aria-label={ariaLabel}
          aria-labelledby={label ? labelId : ariaLabelledBy}
          className={cn("m-0 flex list-none flex-col p-0", variants[variant])}
        >
          {rows.map((row, index) => (
            <li key={isValidElement(row) ? row.key : index} className="m-0 min-w-0 p-0">
              {row}
            </li>
          ))}
        </List>
      ) : (
        empty && <div className="text-sm text-muted-foreground">{empty}</div>
      )}
    </div>
  );
}
