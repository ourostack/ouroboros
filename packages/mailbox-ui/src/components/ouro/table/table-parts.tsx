"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  Children,
  isValidElement,
  type CSSProperties,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
  type Ref,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { announce } from "@/lib/ouro/announce";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { devThrow, devWarn } from "@/lib/ouro/dev";
import { useMergedRef } from "@/lib/ouro/refs";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { RouterLink, safeRel } from "@/lib/ouro/router-link";
import { followStretchedLink, raiseControlsClass, stretchedLinkClass } from "@/lib/ouro/stretched-link";
import { ScrollArea } from "@/components/ouro/scroll-area/scroll-area";
import {
  alignClasses,
  cellBase,
  cellPad,
  directionOf,
  directionWarning,
  headCell,
  rowLinkClass,
  sectionCell,
  sortButtonClass,
  sortedLabelDefault,
  sortIconPaths,
  stickyHead,
  wrapClass,
  type TableAlign,
  type TableSortDirection,
} from "@/components/ouro/table/table-styles";

export type { TableAlign, TableSortDirection } from "@/components/ouro/table/table-styles";

interface TableState {
  dense: boolean;
  striped: boolean;
  stickyHeader: boolean;
  sortedLabel: (header: string, direction: TableSortDirection) => string;
}
type Section = "head" | "body" | "foot";
interface RowState {
  section: Section;
  href: string | undefined;
  external: boolean;
  externalLabel: string;
  /** The first row header cell to render claims the row link, so a row has one link and one tab stop. */
  claim: { owner?: string };
}

const TableContext = createContext<TableState | null>(null);
const SectionContext = createContext<Section | null>(null);
const RowContext = createContext<RowState | null>(null);

const shapes = {
  TableHeader: '<Table caption="…"><TableHeader>…</TableHeader></Table>',
  TableBody: '<Table caption="…"><TableBody>…</TableBody></Table>',
  TableFooter: '<Table caption="…"><TableFooter>…</TableFooter></Table>',
  TableRow: '<Table caption="…"><TableBody><TableRow>…</TableRow></TableBody></Table>',
  TableHead: '<Table caption="…"><TableHeader><TableRow><TableHead>…</TableHead></TableRow></TableHeader></Table>',
  TableCell: '<Table caption="…"><TableBody><TableRow><TableCell>…</TableCell></TableRow></TableBody></Table>',
} as const;

/** Throws in development, with the JSX the part belongs in, unless its parent is there. */
function misplaced(part: keyof typeof shapes, parent: string): never {
  return devThrow(
    part,
    `must be rendered inside <${parent}>`,
    process.env.NODE_ENV !== "production" ? shapes[part] : /* istanbul ignore next @preserve -- production only */ "",
  );
}

function useTable(part: keyof typeof shapes): TableState {
  const table = useContext(TableContext);
  return table ?? misplaced(part, "Table");
}

/** What a row link can't contain: anything that takes its own clicks or focus. */
const interactive = "a,button,input,select,textarea,summary,[tabindex]:not([tabindex='-1']),[role=button]";

const alignHint = (part: string) =>
  process.env.NODE_ENV !== "production" ? `<${part} align="end">` : /* istanbul ignore next @preserve -- production only */ undefined;
const cellHint = () =>
  process.env.NODE_ENV !== "production" ? "<Table striped> or <Table dense>; Table sets the look of its cells" : /* istanbul ignore next @preserve -- production only */ "";

/** Props for {@link TableFrame}. */
export interface TableFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  caption: string;
  hideCaption?: boolean | undefined;
  striped?: boolean | undefined;
  dense?: boolean | undefined;
  stickyHeader?: boolean | undefined;
  sortedLabel?: ((header: string, direction: TableSortDirection) => string) | undefined;
  children?: ReactNode;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  tableRef?: Ref<HTMLTableElement> | undefined;
}

/**
 * The frame Table and TableRoot render: the caption, a ScrollArea that scrolls the table
 * sideways (and down, inside a height), and the `<table>`.
 *
 * @internal Table and TableRoot render it.
 * @example
 * <TableFrame caption="Recipes"><TableBody>…</TableBody></TableFrame>
 */
export function TableFrame(props: TableFrameProps): JSX.Element {
  const { caption, hideCaption, striped, dense, stickyHeader, sortedLabel = sortedLabelDefault, children, className, tableRef, ...rest } = props;
  return (
    <TableContext.Provider value={{ dense: Boolean(dense), striped: Boolean(striped), stickyHeader: Boolean(stickyHeader), sortedLabel }}>
      <div {...rest} data-ouro="table" className={cn("flex min-w-0 flex-col gap-3", className)}>
        {!hideCaption && (
          <div aria-hidden data-table-caption="" className="text-sm font-medium text-muted-foreground">
            {caption}
          </div>
        )}
        <ScrollArea orientation="both" label={caption} className="min-h-0 flex-1">
          <table ref={tableRef} className="w-full border-separate border-spacing-0 text-base text-foreground pointer-fine:text-sm">
            <caption className="sr-only">{caption}</caption>
            {children}
          </table>
        </ScrollArea>
      </div>
    </TableContext.Provider>
  );
}

/** Props for {@link TableRoot}. */
export interface TableRootProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "title"> {
  /** What the table shows. It names the table and its scrolling region, and shows above it unless `hideCaption`. */
  caption: string;
  /** Hides the caption visually and keeps it as the table's name. */
  hideCaption?: boolean | undefined;
  /**
   * Shades every other body row.
   *
   * @claim "Shades every other body row" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > shades every other body row with striped)
   */
  striped?: boolean | undefined;
  /** Tighter cells, for many rows. */
  dense?: boolean | undefined;
  /** Keeps the header row at the top while the rows scroll, inside the height you give it (`className="max-h-96"`). */
  stickyHeader?: boolean | undefined;
  /**
   * What screen readers hear after a header with `onSort` is pressed, from the header's text
   * and the new direction. Pass it to translate the message.
   * @default (header, direction) => `Sorted by ${header}, ${direction}`
   */
  sortedLabel?: ((header: string, direction: TableSortDirection) => string) | undefined;
  /** `TableHeader`, `TableBody` and `TableFooter`. */
  children: ReactNode;
  /** Layout: margins, width and the height the table scrolls inside. Appearance classes warn in development. */
  className?: string | undefined;
  /** A ref to the `<table>` element. */
  ref?: Ref<HTMLTableElement> | undefined;
}

/**
 * Part: the root of a table built from parts, with its caption and its scrolling region.
 * `Table` takes the same parts as children (`<Table caption="Pantry">…</Table>`), so use
 * it instead unless you are composing parts of your own; `Table` also builds the whole
 * table from `columns` and `rows`.
 *
 * @group Data
 * @example
 * <TableRoot caption="Pantry">
 *   <TableHeader>
 *     <TableRow>
 *       <TableHead>Item</TableHead>
 *       <TableHead align="end">Qty</TableHead>
 *     </TableRow>
 *   </TableHeader>
 *   <TableBody>
 *     <TableRow href="/pantry/flour">
 *       <TableCell rowHeader>Flour</TableCell>
 *       <TableCell align="end">2 kg</TableCell>
 *     </TableRow>
 *   </TableBody>
 * </TableRoot>
 */
export function TableRoot(props: TableRootProps): JSX.Element {
  const { ref, className, ...rest } = props;
  useAppearanceClassNameCheck(
    "TableRoot",
    className,
    process.env.NODE_ENV !== "production" ? "put the table inside a <Card> for a frame" : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "TableRoot",
    process.env.NODE_ENV !== "production"
      ? () => [!props.caption && ["caption is required; it names the table", '<TableRoot caption="Pantry">, with hideCaption when a heading already shows it']]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  return <TableFrame {...rest} className={className} tableRef={ref} />;
}

/** Props for {@link TableHeader}, {@link TableBody} and {@link TableFooter}. */
export interface TableSectionProps extends HTMLAttributes<HTMLTableSectionElement> {
  /** Layout only. Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLTableSectionElement> | undefined;
}

function TableSection(props: TableSectionProps & { part: "TableHeader" | "TableBody" | "TableFooter"; kind: Section }): JSX.Element {
  const { part, kind, className, ...rest } = props;
  useTable(part);
  useAppearanceClassNameCheck(part, className, cellHint());
  const Element = kind === "head" ? "thead" : kind === "body" ? "tbody" : "tfoot";
  return (
    <SectionContext.Provider value={kind}>
      <Element {...rest} className={cn(className)} />
    </SectionContext.Provider>
  );
}

/**
 * Part: the table's header rows (`<thead>`), holding a `TableRow` of `TableHead` cells.
 * With `stickyHeader` on the Table, they stay at the top while the rows scroll.
 *
 * @group Data
 * @example
 * <TableHeader>
 *   <TableRow>
 *     <TableHead>Recipe</TableHead>
 *     <TableHead align="end">Serves</TableHead>
 *   </TableRow>
 * </TableHeader>
 */
export function TableHeader(props: TableSectionProps): JSX.Element {
  return <TableSection {...props} part="TableHeader" kind="head" />;
}

/**
 * Part: the table's body rows (`<tbody>`).
 *
 * @group Data
 * @example
 * <TableBody>
 *   <TableRow href="/recipes/ribs">
 *     <TableCell rowHeader>Braised short ribs</TableCell>
 *     <TableCell align="end">6</TableCell>
 *   </TableRow>
 * </TableBody>
 */
export function TableBody(props: TableSectionProps): JSX.Element {
  return <TableSection {...props} part="TableBody" kind="body" />;
}

/**
 * Part: summary rows under the body (`<tfoot>`), such as a total, with a line above them.
 *
 * @group Data
 * @example
 * <TableFooter>
 *   <TableRow>
 *     <TableCell rowHeader>Total</TableCell>
 *     <TableCell align="end">3 kg</TableCell>
 *   </TableRow>
 * </TableFooter>
 */
export function TableFooter(props: TableSectionProps): JSX.Element {
  return <TableSection {...props} part="TableFooter" kind="foot" />;
}

/** Props for {@link TableRow}. */
export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /**
   * Makes the whole body row one link, with one tab stop, named by its row header cell
   * (`<TableCell rowHeader>`), which holds the link. Internal paths go through
   * `OuroProvider`'s `linkComponent`. Buttons, links and inputs in other cells stay their
   * own tab stops and take their own clicks and taps. On a touch screen the row is at least
   * 44px tall.
   * @claim "On a touch screen the row" registry/ouro/components/ouro/table/table.touch.test.tsx verify:fileLine(registry/ouro/components/ouro/table/table.touch.test.tsx, /makes\sa\slinked\srow\sat\sleast\s44px\stall\sin\s%s/)
   * @claim "On a touch screen the row" registry/ouro/components/ouro/table/table-parts.tsx verify:fileLine(registry/ouro/components/ouro/table/table-parts.tsx, /pointer-coarse:h-11/)
   */
  href?: string | undefined;
  /** With `href`: opens the link in a new tab, safely, and tells screen readers so with `externalLabel`. */
  external?: boolean | undefined;
  /**
   * What screen readers hear after the link's name when `external` opens it in a new tab.
   * @default "(opens in a new tab)"
   */
  externalLabel?: string | undefined;
  /** Layout only. Appearance classes warn in development; use the Table's `striped`. */
  className?: string | undefined;
  ref?: Ref<HTMLTableRowElement> | undefined;
}

/**
 * Part: one row (`<tr>`). With `href` a body row is one link, held by its row header cell.
 *
 * @group Data
 * @example
 * <TableRow href="/recipes/ribs">
 *   <TableCell rowHeader>Braised short ribs</TableCell>
 *   <TableCell>4 h</TableCell>
 * </TableRow>
 */
export function TableRow(props: TableRowProps): JSX.Element {
  const { href, external, externalLabel = "(opens in a new tab)", className, ref, children, ...rest } = props;
  const table = useTable("TableRow");
  const kind = useContext(SectionContext) ?? misplaced("TableRow", "TableBody");
  const own = useRef<HTMLTableRowElement>(null);
  const merged = useMergedRef(ref, own);
  useAppearanceClassNameCheck(
    "TableRow",
    className,
    process.env.NODE_ENV !== "production" ? "<Table striped>" : /* istanbul ignore next @preserve -- production only */ "",
  );
  const linked = href !== undefined && kind === "body";
  useEffect(() => {
    /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
    if (process.env.NODE_ENV !== "production") {
      const row = own.current;
      /* istanbul ignore if @preserve -- the ref is set before effects run */
      if (!row) return;
      if (href !== undefined && !linked) {
        devWarn("TableRow", "href works on body rows only", '<TableBody><TableRow href="…">…</TableRow></TableBody>', own);
        return;
      }
      if (!linked) return;
      const link = row.querySelector("[data-stretched-link]");
      if (!link) {
        const text = row.cells[0]?.textContent || "…";
        devWarn(
          "TableRow",
          "href needs a row header cell, which holds the link and names it",
          `<TableRow href="${href}"><TableCell rowHeader>${text}</TableCell>…</TableRow>`,
          own,
        );
        return;
      }
      const nameFix = '{ key: "name", header: "Recipe", rowHeader: true }, or <TableCell rowHeader>Name</TableCell>';
      const name = [...link.childNodes]
        .filter((node) => !(node instanceof Element && node.hasAttribute("data-external-label")))
        .map((node) => node.textContent)
        .join("")
        .trim();
      if (link.querySelector(interactive)) devWarn("TableRow", "the row link holds a control, and a link can't contain one", nameFix, own);
      else if (!name && !link.querySelector("img[alt]:not([alt=''])")) devWarn("TableRow", "the row link has no text to name it", nameFix, own);
      if (row.querySelectorAll("th[scope=row]").length > 1) {
        devWarn("TableRow", "two cells are row headers, and only the first holds the row link", "<TableCell rowHeader> on the name cell only", own);
      }
    }
  });
  return (
    <RowContext.Provider value={{ section: kind, href: linked ? href : undefined, external: Boolean(external), externalLabel, claim: {} }}>
      <tr
        {...rest}
        ref={merged}
        // A click anywhere on a linked row opens its link, though a sticky cell keeps the link's layer to itself.
        onClick={(event) => (rest.onClick?.(event), followStretchedLink(event))}
        onAuxClick={(event) => (rest.onAuxClick?.(event), followStretchedLink(event))}
        data-linked={linked ? "" : undefined}
        data-follows-link={linked ? "" : undefined}
        className={cn(
          table.striped && kind === "body" && "even:bg-muted/50",
          linked && "relative isolate cursor-pointer pointer-coarse:h-ouro-11",
          linked && raiseControlsClass,
          className,
        )}
      >
        {children}
      </tr>
    </RowContext.Provider>
  );
}

/** The props TableHead and TableCell share. */
interface CellOwnProps {
  /**
   * How the content lines up: `end` for numbers and amounts, `center` for a status mark.
   * @default "start"
   */
  align?: TableAlign | (string & { 'Use "start", "center" or "end": right is "end"': never }) | undefined;
  /**
   * Lets long text wrap onto more lines, at least 192px wide, instead of widening the table.
   *
   * @claim "Lets long text wrap onto more" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > lets a column with wrap break its text onto more lines, at least 192px wide)
   * @claim "Lets long text wrap onto more" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > breaks a long URL in a wrap column instead of widening it)
   */
  wrap?: boolean | undefined;
  /** Layout only: a width (`w-32`). Appearance classes warn in development; alignment is `align`. */
  className?: string | undefined;
}

function alignOf(align: string | undefined): TableAlign {
  return align === "center" || align === "end" ? align : "start";
}

/** Warns in development when `align` is not one of ours; the cell aligns to the start. */
function useAlignCheck(part: string, align: string | undefined): void {
  useDevWarnings(
    part,
    process.env.NODE_ENV !== "production"
      ? () => [
          align !== undefined &&
            alignOf(align) !== align && [
              `align="${align}" is not an alignment; use "start", "center", "end"`,
              `<${part} align="${align === "left" ? "start" : "end"}">`,
            ],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
}

/** Props for {@link TableHead}. */
export interface TableHeadProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, "align">, CellOwnProps {
  /** The column's name. Keep it even for a column of buttons, and hide it with `hideHeader`. */
  children: ReactNode;
  /** Hides the header visually and keeps it for screen readers, for a column of actions. */
  hideHeader?: boolean | undefined;
  /**
   * Which way the rows are sorted by this column. It sets `aria-sort` and shows an arrow; leave
   * it out on the columns the rows are not sorted by.
   */
  sorted?: TableSortDirection | (string & { 'Use "ascending" or "descending": asc is "ascending"': never }) | undefined;
  /**
   * Makes the header a button that sorts the rows by this column, with an arrow that shows the
   * direction. A press calls it with the direction to sort to (`"descending"` when this column
   * is sorted ascending, or else `"ascending"`) and tells screen readers. Sort the rows yourself
   * and pass `sorted` back. On a touch screen the header is at least 44px tall.
   *
   * @claim "A press calls it with the direction" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table parts > sorts from a TableHead with onSort, which the app sorts and marks with sorted)
   * @claim "On a touch screen the header" registry/ouro/components/ouro/table/table.touch.test.tsx verify:fileLine(registry/ouro/components/ouro/table/table.touch.test.tsx, /makes\sa\ssortable\sheader\sat\sleast\s44px\stall/)
   */
  onSort?: ((direction: TableSortDirection) => void) | undefined;
  ref?: Ref<HTMLTableCellElement> | undefined;
}

/**
 * Part: a column header (`<th scope="col">`) in a `TableHeader` row. With `onSort` it is a
 * button that sorts the rows by its column, and `sorted` marks the column they are sorted by.
 *
 * @group Data
 * @example
 * <TableHead align="end">Serves</TableHead>
 * <TableHead hideHeader>Actions</TableHead>
 * <TableHead sorted={sort.key === "name" ? sort.direction : undefined} onSort={(direction) => setSort({ key: "name", direction })}>
 *   Recipe
 * </TableHead>
 */
export function TableHead(props: TableHeadProps): JSX.Element {
  const { align, hideHeader, wrap, sorted, onSort, className, children, ...rest } = props;
  const table = useTable("TableHead");
  const row = useContext(RowContext) ?? misplaced("TableHead", "TableRow");
  useAppearanceClassNameCheck("TableHead", className, cellHint(), alignHint("TableHead"));
  useAlignCheck("TableHead", align);
  useDevWarnings(
    "TableHead",
    process.env.NODE_ENV !== "production"
      ? () => [directionWarning(sorted, (direction) => `<TableHead sorted="${direction}">`)]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const direction = directionOf(sorted);
  const label = hideHeader ? <span className="sr-only">{children}</span> : children;
  const icon = (onSort || direction) && (
    <svg
      aria-hidden="true"
      data-sort-icon={direction ?? "none"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-ouro-3_5 shrink-0"
    >
      <path d={sortIconPaths[direction ?? "none"]} />
    </svg>
  );
  return (
    <th
      scope="col"
      aria-sort={direction}
      {...rest}
      className={cn(
        cellBase,
        headCell,
        cellPad[table.dense ? "dense" : "md"],
        alignClasses[alignOf(align)],
        sectionCell[row.section],
        wrap && wrapClass,
        direction && "text-foreground",
        onSort && "relative pointer-coarse:h-ouro-11",
        table.stickyHeader && row.section === "head" && stickyHead,
        className,
      )}
    >
      {onSort ? (
        <button
          type="button"
          data-ouro-control="table"
          data-ouro-part="sort"
          // An end-aligned column keeps its name over its numbers, with the arrow before it.
          className={cn(sortButtonClass, alignOf(align) === "end" && "flex-row-reverse")}
          onClick={(event) => {
            const next = direction === "ascending" ? "descending" : "ascending";
            announce(table.sortedLabel(event.currentTarget.textContent!, next));
            onSort(next);
          }}
        >
          <span className="min-w-0">{label}</span>
          {icon}
        </button>
      ) : (
        <>
          {label}
          {icon && <span className="ms-1.5 inline-flex align-middle">{icon}</span>}
        </>
      )}
    </th>
  );
}

/** Props for {@link TableCell}. */
export interface TableCellProps extends Omit<TdHTMLAttributes<HTMLTableCellElement>, "align">, CellOwnProps {
  /**
   * Makes this cell the row's header (`<th scope="row">`): what the row is, such as a
   * recipe's name. In a row with `href` it holds the link, so its text names the link.
   */
  rowHeader?: boolean | undefined;
  ref?: Ref<HTMLTableCellElement> | undefined;
}

function holdsAnchor(node: ReactNode): boolean {
  return Children.toArray(node).some(
    (child) => isValidElement<{ children?: ReactNode }>(child) && (child.type === "a" || holdsAnchor(child.props.children)),
  );
}

/**
 * Part: a cell (`<td>`), or the row's header with `rowHeader` (`<th scope="row">`).
 *
 * @group Data
 * @example
 * <TableCell rowHeader>Braised short ribs</TableCell>
 * <TableCell align="end">6</TableCell>
 */
export function TableCell(props: TableCellProps): JSX.Element {
  const { rowHeader, align, wrap, className, children, ...rest } = props;
  const table = useTable("TableCell");
  const row = useContext(RowContext) ?? misplaced("TableCell", "TableRow");
  const id = useId();
  useAppearanceClassNameCheck("TableCell", className, cellHint(), alignHint("TableCell"));
  useAlignCheck("TableCell", align);
  // The first row header cell holds the row link; a second one stays plain (TableRow warns).
  if (rowHeader && row.href !== undefined) row.claim.owner ??= id;
  // Stryker disable next-line LogicalOperator,ConditionalExpression: only a row header with a row link claims the row (above), so the owner check already rules out a plain cell and a row without a link
  const holdsLink = rowHeader && row.href !== undefined && row.claim.owner === id && !holdsAnchor(children);
  const Element = rowHeader ? "th" : "td";
  return (
    <Element
      scope={rowHeader ? "row" : undefined}
      {...rest}
      className={cn(
        cellBase,
        cellPad[table.dense ? "dense" : "md"],
        alignClasses[alignOf(align)],
        sectionCell[row.section],
        rowHeader && "font-medium",
        wrap && wrapClass,
        className,
      )}
    >
      {holdsLink ? (
        <RouterLink
          href={row.href!}
          target={row.external ? "_blank" : undefined}
          rel={row.external ? safeRel(undefined) : undefined}
          data-table-row-link=""
          data-stretched-link=""
          data-ouro-control="table"
          data-ouro-part="row-link"
          className={cn(stretchedLinkClass, rowLinkClass)}
        >
          {children}
          {row.external && (
            <span data-external-label="" className="sr-only">
              {" "}
              {row.externalLabel}
            </span>
          )}
        </RouterLink>
      ) : (
        children
      )}
    </Element>
  );
}
