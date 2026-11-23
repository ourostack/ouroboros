export { alignClasses, cellBase, cellPad, directionOf, directionWarning, headCell, rowLinkClass, sectionCell, sortButtonClass, sortIconPaths, sortedLabelDefault, stickyHead, tableAligns, wrapClass };
export type { TableAlign, TableSortDirection };

/** How a column's content lines up: `end` for numbers, `center` for a status mark. */
type TableAlign = "start" | "center" | "end";

/** The alignments a column or cell takes, for the dev message on an unknown one. */
const tableAligns: readonly TableAlign[] = ["start", "center", "end"];

const alignClasses = { start: "text-start", center: "text-center", end: "text-end" } as const;

// Cells stay on one line, so a wide table scrolls sideways instead of squeezing its columns.
const cellBase = "m-0 align-middle whitespace-nowrap border-b border-border font-normal";
// `anywhere` (not `break-word`) also lowers the cell's minimum width, so a long URL wraps
// instead of widening the column.
const wrapClass = "whitespace-normal wrap-anywhere min-w-48";
const cellPad = { md: "px-4 py-3", dense: "px-3 py-1.5" } as const;

const headCell = "font-medium text-muted-foreground";
// Inside the ScrollArea's viewport, which scrolls both ways, the header sticks to its top and
// moves sideways with its column. z-20 keeps it over the rows' links (z-1) and raised controls (z-10).
const stickyHead = "sticky top-0 z-20 bg-background";

// The last body row has no line under it; a footer has a line above it and none under it.
const sectionCell = {
  head: "",
  body: "[tbody>tr:last-child>&]:border-b-0",
  foot: "border-t border-b-0 font-medium",
} as const;

// The row link's focus ring is drawn by the layer that covers the row, so it outlines the
// whole row in every browser (WebKit paints no outline on a <tr>).
const rowLinkClass = "after:outline-ring after:-outline-offset-2 focus-visible:after:outline-2 focus-visible:after:outline-solid";

/** Which way a sorted column runs, in the words `aria-sort` uses. */
type TableSortDirection = "ascending" | "descending";

/** What screen readers hear after a header sorts the rows, unless the table says otherwise. */
const sortedLabelDefault = (header: string, direction: TableSortDirection): string => `Sorted by ${header}, ${direction}`;

// The sort button's layer covers its header cell, so a press anywhere on the cell sorts, and its
// focus ring outlines the cell. It highlights while pressed instead of scaling, as a linked row
// does, because a whole cell that shrinks reads as a jump. Under forced colours the layer keeps an
// edge, since its highlight is a background.
const sortButtonClass =
  "m-0 inline-flex max-w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-start [font:inherit] text-inherit outline-none " +
  "pointer-fine:hover:text-foreground after:absolute after:inset-0 after:z-1 after:content-[''] " +
  "after:transition-colors after:duration-(--ouro-duration-fast) pointer-fine:hover:after:bg-foreground/[0.03] active:after:bg-foreground/[0.06] " +
  "after:outline-ring after:-outline-offset-2 focus-visible:after:outline-2 focus-visible:after:outline-solid " +
  "forced-colors:after:border forced-colors:after:border-solid";

// An arrow up or down for the sorted column, and both chevrons for one that can sort: a shape, not a colour.
const sortIconPaths = {
  ascending: "M8 13V3M4 7l4-4 4 4",
  descending: "M8 3v10M4 9l4 4 4-4",
  none: "M5 6l3-3 3 3M5 10l3 3 3-3",
} as const;

/** A sort direction that is not one of ours reads as ascending. */
function directionOf(direction: string | undefined): TableSortDirection | undefined {
  return direction === undefined ? undefined : direction === "descending" ? "descending" : "ascending";
}

/** The development message for a sort direction that is not one of ours, with `fix` given the likely one. */
function directionWarning(direction: string | undefined, fix: (direction: TableSortDirection) => string): readonly [string, string] | false {
  return (
    directionOf(direction) !== direction && [
      `"${direction}" is not a sort direction; use "ascending" or "descending"`,
      fix(String(direction).startsWith("d") ? "descending" : "ascending"),
    ]
  );
}
