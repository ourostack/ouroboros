"use client";

import { useMemo, useState, useSyncExternalStore, type CSSProperties, type HTMLAttributes, type JSX, type Key, type ReactNode, type Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { useDevWarnings, type DevWarning } from "@/lib/ouro/use-dev-messages";
import { TableBody, TableCell, TableHead, TableFrame, TableHeader, TableRow, type TableAlign } from "@/components/ouro/table/table-parts";
import { directionOf, directionWarning, type TableSortDirection } from "@/components/ouro/table/table-styles";

export type { TableSortDirection } from "@/components/ouro/table/table-styles";

/** The keys of `Row` whose values are assignable to `Value`. */
export type TableKeysOf<Row, Value> = { [K in keyof Row]-?: Row[K] extends Value ? K : never }[keyof Row] & string;

/** What a column sorts by: text, a number, a date or a boolean. An empty value sorts last. */
export type TableSortValue = string | number | Date | boolean | null | undefined;

/**
 * Which column the rows are sorted by, and which way: what `sort`, `defaultSort` and
 * `onSortChange` take.
 *
 * @example
 * const [sort, setSort] = useState<TableSort>({ key: "name", direction: "ascending" });
 */
export interface TableSort {
  /** The sorted column's `key`. */
  key: string;
  /** `"ascending"`: A to Z, low to high, old to new. `"descending"`: the other way. */
  direction: TableSortDirection | (string & { 'Use "ascending" or "descending": asc is "ascending"': never });
}

/**
 * What every column takes, whichever way its cells are filled.
 *
 * @claim "What every column takes, whichever way" registry/ouro/components/ouro/table/table.test-d.ts verify:fileLine(registry/ouro/components/ouro/table/table.test-d.ts, /expectTypeOf<\{\skey:\s"name"\s\}>\(\)\.not\.toExtend<TableColumn<Recipe>>/)
 */
export interface TableColumnBase {
  /**
   * The column's name, in its header cell. Keep it even for a column of buttons, and hide
   * it with `hideHeader`: screen readers read it with every cell.
   */
  header: string;
  /** Hides the header visually and keeps it for screen readers, for a column of actions. */
  hideHeader?: boolean | undefined;
  /**
   * How the column lines up: `end` for numbers and amounts, `center` for a status mark.
   * @default "start"
   */
  align?: TableAlign | (string & { 'Use "start", "center" or "end": right is "end"': never }) | undefined;
  /**
   * Makes this column the rows' headers (`<th scope="row">`), what each row is. With
   * `rowHref` its cell holds the row's link and names it. Without one, the first column with
   * no `cell` renderer is, or else the first column.
   * @claim "Makes this column the rows' headers" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > makes the column marked rowHeader the row header, and keeps a hidden header's name)
   * @claim "Makes this column the rows' headers" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > renders a semantic table named by its caption, with column and row headers)
   * @claim "Without one, the first column with" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table with rowHref > puts the row link in the first column without a cell renderer, past a leading checkbox)
   */
  rowHeader?: boolean | undefined;
  /**
   * Lets long text wrap onto more lines, at least 192px wide, instead of widening the table.
   *
   * @claim "Lets long text wrap onto more" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > lets a column with wrap break its text onto more lines, at least 192px wide)
   * @claim "Lets long text wrap onto more" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > breaks a long URL in a wrap column instead of widening it)
   */
  wrap?: boolean | undefined;
  /** Layout only, on the header cell: a width (`w-32`). */
  className?: string | undefined;
  /**
   * Makes the column's header a button that sorts the rows by it; pressing it again reverses
   * them. Table sorts by the row's `key` field, or by `sortValue`: numbers and dates as
   * numbers and dates, text in the reader's language with the numbers in it in order ("Step 2"
   * before "Step 10"), and rows with an empty value last. Rows with equal values keep their order.
   *
   * @claim "Makes the column's header a button" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table sorting > sorts by a sortable column from its header, and reverses on the next press, with aria-sort and an arrow)
   * @claim "Table sorts by the row's `key`" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table sorting > sorts numbers, dates and text with numbers in order, and puts empty values last both ways)
   * @claim "Rows with equal values keep their" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table sorting > keeps rows with equal values in their order, both ways)
   */
  sortable?: boolean | undefined;

  /** Not a prop. Ouro UI uses `sortable`: `{ key: "name", header: "Recipe", sortable: true }`. */
  enableSorting?: { "Use sortable: true": never };
  /** Not a prop. Ouro UI uses `key`: `{ key: "name", header: "Recipe" }`. */
  accessorKey?: { 'Use key: "name"': never };
  /** Not a prop. Ouro UI uses `header`: `{ key: "name", header: "Recipe" }`. */
  title?: { 'Use header: "Recipe"': never };
  /** Not a prop. Ouro UI uses `header`: `{ key: "name", header: "Recipe" }`. */
  label?: { 'Use header: "Recipe"': never };
  /** Not a prop. Ouro UI uses `cell`: `{ key: "save", header: "Save", cell: (row) => <Button>Save</Button> }`. */
  render?: { "Use cell: (row) => ...": never };
}

/**
 * One column of a {@link Table}: its `header`, and where its cells come from. `key` names a
 * field of the row whose value is shown as it is (text, a number, an element), or, with
 * `cell`, any name, and `cell` renders each row's cell.
 * @claim "`key` names a field of the" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > renders a semantic table named by its caption, with column and row headers)
 */
export type TableColumn<Row> = TableColumnBase & {
  /**
   * What the column sorts by, when its cells show something else (a `cell` renderer, a
   * formatted date): `sortValue: (row) => row.added`. It makes the column `sortable`.
   *
   * @claim "It makes the column `sortable`" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table sorting > sorts a cell column by its sortValue, which makes it sortable)
   */
  sortValue?: ((row: Row) => TableSortValue) | undefined;
} & (
    | {
        /**
         * The field of each row to show, and the column's React key.
         *
         * @claim "The field of each row to" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > keys rows by id, by a rowKey field or function, and by index without an id)
         */
        key: TableKeysOf<Row, ReactNode>;
        /** Renders the row's cell instead of the field's value. */
        cell?: ((row: Row, index: number) => ReactNode) | undefined;
      }
    | {
        /** The column's name for React; with `cell`, it need not be a field of the row. */
        key: string;
        /**
         * Renders the row's cell: a badge, a formatted date, a button. From a Server
         * Component, put the element in the row's field instead, because a function can't
         * cross to the client.
         */
        cell: (row: Row, index: number) => ReactNode;
      }
  );

/**
 * The props every Table takes, with columns and rows or with parts.
 *
 * @claim "The props every Table takes, with" registry/ouro/components/ouro/table/table.test-d.ts verify:fileLine(registry/ouro/components/ouro/table/table.test-d.ts, /expectTypeOf<\{\scaption:\s"Recipes";\scolumns:\sTableColumn<Recipe>\[\];\srows:\sRecipe\[\];\srowHref:\s"href";\srowKey:\s"id"\s\}>\(\)\.toExtend<TableProps<Recipe>>/)
 * @claim "The props every Table takes, with" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > renders a semantic table named by its caption, with column and row headers)
 */
export interface TableOwnProps {
  /**
   * What the table shows: "Recipes", "Order history". It names the table and its scrolling
   * region for screen readers, and shows above it unless `hideCaption`.
   */
  caption: string;
  /** Hides the caption visually and keeps it as the table's name, when a heading already shows it. */
  hideCaption?: boolean | undefined;
  /**
   * Shades every other body row, for long rows that are hard to follow across.
   *
   * @claim "Shades every other body row, for" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > shades every other body row with striped)
   */
  striped?: boolean | undefined;
  /**
   * Tighter cells, for many rows. A row is still 44px tall on a touch screen when it is a link.
   *
   * @claim "A row is still 44px tall" registry/ouro/components/ouro/table/table.touch.test.tsx verify:fileLine(registry/ouro/components/ouro/table/table.touch.test.tsx, /makes\sa\slinked\srow\sat\sleast\s44px\stall\sin\s%s/)
   */
  dense?: boolean | undefined;
  /**
   * Keeps the header row at the top while the rows scroll under it. The table scrolls inside
   * its own height, so give it one: `className="max-h-96"`. It keeps working while the table
   * also scrolls sideways.
   */
  stickyHeader?: boolean | undefined;
  /**
   * Layout: margins, width, and the height the table scrolls inside (`max-h-96`). Appearance
   * classes warn in development; put the Table inside a `Card` for a frame.
   */
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /** A ref to the `<table>` element. */
  ref?: Ref<HTMLTableElement> | undefined;
  /**
   * What screen readers hear after a header sorts the rows, from the column's header and the
   * new direction. Pass it to translate the message.
   * @default (header, direction) => `Sorted by ${header}, ${direction}`
   * @claim "What screen readers hear after a" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table sorting > tells screen readers how the rows are sorted, once per press, in the words sortedLabel gives)
   */
  sortedLabel?: ((header: string, direction: TableSortDirection) => string) | undefined;

  /** Not a prop. Ouro UI uses `rows`: `<Table rows={recipes} columns={…}>`. */
  data?: { "Use rows={recipes}": never };
  /** Not a prop. A row opens a link with `rowHref`: `` <Table rowHref={(row) => `/recipes/${row.id}`}> ``. */
  onRowClick?: { "Use rowHref={(row) => `/recipes/${row.id}`}": never };
  /** Not a prop. Ouro UI uses `caption`: `<Table caption="Recipes">`. */
  title?: { 'Use <Table caption="Recipes">': never };
  /** Not a prop. A column sorts with `sortable`: `{ key: "name", header: "Recipe", sortable: true }`. */
  sortable?: { "Put sortable on a column: { key, header, sortable: true }": never };
}

/** With columns and rows: the props that describe the whole table. */
export interface TableDataProps<Row> {
  /**
   * The columns, in order: each one's `header`, `key` and optional `cell`.
   *
   * @claim "The columns, in order: each one's" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > renders a semantic table named by its caption, with column and row headers)
   */
  columns: readonly TableColumn<NoInfer<Row>>[];
  /** The rows, in the order to show them until a `sortable` column sorts them. Table does not page them. */
  rows: readonly Row[];
  /**
   * The sorted column, controlled: Table marks its header and shows the rows in the order you
   * pass them, so you sort them (on a server, say), and `onSortChange` tells you which sort to
   * show next. Pass `null` while nothing is sorted. To let Table sort the rows itself, use
   * `defaultSort` instead.
   *
   * @claim "Table marks its header and shows" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table sorting > with sort, marks the header and keeps the rows in the order passed, and asks for the next sort)
   */
  sort?: TableSort | null | undefined;
  /**
   * The column the rows are sorted by at first. Table then sorts the rows itself as the
   * headers are pressed.
   *
   * @claim "The column the rows are sorted" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table sorting > starts sorted by defaultSort, and renders it on the server)
   */
  defaultSort?: TableSort | undefined;
  /** Called with the new sort when a header is pressed, with `sort` or without it. */
  onSortChange?: ((sort: { key: string; direction: TableSortDirection }) => void) | undefined;
  /**
   * Each row's React key: the name of a field (`rowKey="slug"`) or a function. Without it,
   * a row's `id` field, or else its position.
   * @claim "Each row's React key: the name" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > keys rows by id, by a rowKey field or function, and by index without an id)
   */
  rowKey?: TableKeysOf<Row, string | number> | ((row: Row, index: number) => Key) | undefined;
  /**
   * Makes each row one link, with one tab stop, named by its row header cell: a function
   * that returns the row's path (or `undefined` for a row that is not a link), or the name
   * of a field that holds it (`rowHref="href"`), which a Server Component can pass. Buttons,
   * links and inputs in the cells stay their own tab stops and take their own taps. On a
   * touch screen a linked row is at least 44px tall.
   * @claim "On a touch screen a linked" registry/ouro/components/ouro/table/table.touch.test.tsx verify:fileLine(registry/ouro/components/ouro/table/table.touch.test.tsx, /makes\sa\slinked\srow\sat\sleast\s44px\stall\sin\s%s/)
   * @claim "Makes each row one link, with" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table with rowHref > makes each linked row one link named by its row header, with one tab stop, covering the row)
   * @claim "Makes each row one link, with" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table parts > warns when a linked row has no row header cell to hold its link)
   */
  rowHref?: TableKeysOf<Row, string | undefined> | ((row: Row) => string | undefined) | undefined;
  /**
   * Opens every row link in a new tab, safely, and tells screen readers so with `externalLabel`.
   *
   * @claim "Opens every row link in a" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table with rowHref > opens external row links in a new tab, safely, and says so with a translatable label)
   * @claim "Opens every row link in a" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table with rowHref > keeps internal row links in the same tab)
   */
  rowExternal?: boolean | undefined;
  /**
   * What screen readers hear after a row link's name with `rowExternal`.
   * @default "(opens in a new tab)"
   */
  externalLabel?: string | undefined;
  /**
   * What the body shows when there are no rows, in one cell across every column.
   * @default "Nothing here yet."
   * @claim "What the body shows when there" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table > shows the empty message in one cell across every column)
   */
  empty?: ReactNode;
  /** Only with parts. Pass columns and rows, or parts as children. */
  children?: never;
}

/** With parts: `TableHeader`, `TableBody` and `TableFooter` as children. */
export interface TablePartsProps {
  /** The parts: `TableHeader`, `TableBody` and `TableFooter`, with `TableRow`, `TableHead` and `TableCell` in them. */
  children: ReactNode;
  /** Only without parts. */
  columns?: never;
  /** Only without parts. */
  rows?: never;
  /** Only without parts. */
  rowKey?: never;
  /** Only without parts. Give a linked row `<TableRow href="…">`. */
  rowHref?: never;
  /** Only without parts. */
  empty?: never;
  /** Only without parts. Give a row `<TableRow href="…" external>`. */
  rowExternal?: never;
  /** Only without parts. Give a row `<TableRow externalLabel="…">`. */
  externalLabel?: never;
  /** Only without parts. Give the sorted column's header `<TableHead sorted="ascending">`. */
  sort?: never;
  /** Only without parts. Give the sorted column's header `<TableHead sorted="ascending">`. */
  defaultSort?: never;
  /** Only without parts. Give each header `<TableHead onSort={…}>`. */
  onSortChange?: never;
}

/**
 * Props for {@link Table}: columns and rows, or parts as children. The HTML attributes go to
 * the root `<div>`, and sit outside the union, which keeps the editor's hover docs.
 */
export type TableProps<Row extends object = Record<string, unknown>> = Omit<HTMLAttributes<HTMLDivElement>, keyof TableOwnProps | "children"> &
  TableOwnProps &
  (TableDataProps<Row> | TablePartsProps);

const aligns: readonly string[] = ["start", "center", "end"];

/** Whether the className or style gives the table a height to scroll inside. */
function hasHeight(className: string | undefined, style: CSSProperties | undefined): boolean {
  if (style?.height !== undefined || style?.maxHeight !== undefined) return true;
  return (className ?? "").split(/\s+/).some((token) => /^(max-)?h-/.test(token.slice(token.lastIndexOf(":") + 1)));
}

/** What a value sorts as: a number (for numbers, dates and booleans), text, or `null` for an empty value or one that can't sort. */
function sortKey(value: unknown): number | string | null {
  const plain = value instanceof Date ? value.getTime() : typeof value === "boolean" ? Number(value) : value;
  if (typeof plain === "number") return Number.isNaN(plain) ? null : plain;
  return typeof plain === "string" && plain !== "" ? plain : null;
}

type SortColumn<Row> = TableColumnBase & { key: string; sortValue?: ((row: Row) => TableSortValue) | undefined };

const isSortable = (column: { sortable?: boolean | undefined; sortValue?: unknown }) => column.sortable ?? column.sortValue !== undefined;

/** The value a column sorts a row by: its `sortValue`, or else the row's field. */
const sortValueOf = <Row,>(column: SortColumn<Row>, row: Row): unknown => (column.sortValue ? column.sortValue(row) : (row as Record<string, unknown>)[column.key]);

/**
 * The rows in the sort's order: stable, with empty values last both ways, numbers before text
 * when a column mixes them, and text compared in `locale` with the numbers in it in order.
 */
function sortRows<Row>(rows: readonly Row[], column: SortColumn<Row>, direction: TableSortDirection, locale: string | undefined): readonly Row[] {
  const collator = new Intl.Collator(locale, { numeric: true });
  const sign = direction === "descending" ? -1 : 1;
  const compare = (a: number | string, b: number | string) =>
    typeof a !== typeof b ? (typeof a === "number" ? -1 : 1) : typeof a === "number" ? a - (b as number) : collator.compare(a as string, b as string);
  const keyed = rows.map((row) => ({ row, key: sortKey(sortValueOf(column, row)) }));
  // Array sort is stable, so rows with equal values keep their order, and so do the empty ones after them.
  const valued = keyed.filter((entry): entry is { row: Row; key: number | string } => entry.key !== null).sort((x, y) => sign * compare(x.key, y.key));
  return [...valued, ...keyed.filter((entry) => entry.key === null)].map((entry) => entry.row);
}

// Text sorts in the reader's language, which the server can't know: it sorts in English, and
// the browser sorts again in its own language once the page has hydrated.
// Stryker disable next-line ArrowFunction: the store never changes, so there is nothing to unsubscribe
const noSubscribe = () => () => {};
// Stryker disable next-line ArrowFunction: undefined is the browser's own locale, so the mutant is the same function
const browserLocale = () => undefined;
// Stryker disable next-line ArrowFunction: the test browsers' own locale is English, so they sort as the mutant does; pinning it keeps every server alike
const serverLocale = () => "en";

const none: readonly never[] = [];

function sortWarnings<Row>(columns: readonly SortColumn<Row>[], rows: readonly Row[], sort: TableSort | undefined): DevWarning[] {
  const named = sort && columns.find((column) => column.key === sort.key);
  return [
    sort !== undefined && directionWarning(sort.direction, (direction) => `{ key: "${sort.key}", direction: "${direction}" }`),
    sort !== undefined &&
      !(named && isSortable(named)) && [`the sort names "${sort.key}", which is not a sortable column`, `{ key: "${sort.key}", header: "…", sortable: true }`],
    ...columns.map((column): DevWarning => {
      if (!isSortable(column) || column.sortValue || rows.length === 0) return false;
      const fields = rows as readonly Record<string, unknown>[];
      // A `cell` column whose key is no field, or a field that holds an element.
      const missing = fields.every((row) => !(column.key in row));
      const element = fields.some((row) => typeof row[column.key] === "object" && row[column.key] !== null && !(row[column.key] instanceof Date));
      return (
        (missing || element) && [
          `column "${column.key}" has no text, number or date to sort by`,
          `{ key: "${column.key}", header: "…", sortable: true, sortValue: (row) => row.name }`,
        ]
      );
    }),
  ];
}

function columnWarnings(columns: readonly (TableColumnBase & { key: string })[]): DevWarning[] {
  const seen = new Set<string>();
  return columns.flatMap((column): DevWarning[] => {
    const { key } = column;
    const duplicate = seen.has(key);
    seen.add(key);
    return [
      !column.header && ["every column needs a header; it names the column for screen readers", '{ key: "…", header: "Actions", hideHeader: true }'],
      duplicate && [`two columns have key "${key}"; keys name columns, so each is unique`, '{ key: "name", … }, { key: "time", … }'],
      column.align !== undefined &&
        !aligns.includes(column.align) && [
          `align="${String(column.align)}" is not an alignment; use "start", "center", "end"`,
          `{ align: "${String(column.align) === "left" ? "start" : "end"}" }`,
        ],
      column.accessorKey !== undefined && ["a column's accessorKey is not a prop", `{ key: "${String(column.accessorKey)}", header: "…" }`],
      column.title !== undefined && ["a column's title is not a prop", `{ key: "…", header: "${String(column.title)}" }`],
      column.label !== undefined && ["a column's label is not a prop", `{ key: "…", header: "${String(column.label)}" }`],
      column.render !== undefined && ["a column's render is not a prop", '{ key: "…", header: "…", cell: (row) => … }'],
      column.enableSorting !== undefined && ["a column's enableSorting is not a prop", `{ key: "${key}", header: "…", sortable: true }`],
    ];
  });
}

/**
 * A data table: a caption, column headers, and rows, from `columns` and `rows` or from
 * parts. It scrolls sideways inside its own region on a phone, so the page never does.
 * With `rowHref` each row is one link with one tab stop, named by its row header, and the
 * buttons, links and inputs in its cells keep their own taps. A `sortable` column sorts the
 * rows when its header is pressed, and reverses them on the next press. `striped`, `dense` and
 * `stickyHeader` (inside a height you set) change how it reads. It does not page or filter.
 *
 * Use `DescriptionList` instead for one thing's details as label and value pairs, and
 * `ItemGroup` for a list of rows that need no columns, which reads better on a phone. To sort
 * on a server or by more than one column, control `sort` and pass the rows in that order.
 *
 * @group Data
 * @see https://ui.ouroboros.bot/docs/table
 *
 * @example
 * <Table
 *   caption="Recipes"
 *   columns={[
 *     { key: "name", header: "Recipe" },
 *     { key: "time", header: "Time" },
 *     { key: "serves", header: "Serves", align: "end" },
 *   ]}
 *   rows={recipes}
 *   rowHref={(recipe) => `/recipes/${recipe.id}`}
 * />
 * <Table
 *   caption="Orders"
 *   columns={[
 *     { key: "customer", header: "Customer", sortable: true },
 *     { key: "placed", header: "Placed", cell: (order) => formatDate(order.placed), sortValue: (order) => order.placed },
 *     { key: "total", header: "Total", align: "end", sortable: true },
 *   ]}
 *   rows={orders}
 *   defaultSort={{ key: "placed", direction: "descending" }}
 * />
 * <Table caption="Pantry" hideCaption>
 *   <TableHeader>
 *     <TableRow><TableHead>Item</TableHead><TableHead align="end">Qty</TableHead></TableRow>
 *   </TableHeader>
 *   <TableBody>
 *     <TableRow><TableCell rowHeader>Flour</TableCell><TableCell align="end">2 kg</TableCell></TableRow>
 *   </TableBody>
 * </Table>
 * @claim "A `sortable` column sorts the rows" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table sorting > sorts by a sortable column from its header, and reverses on the next press, with aria-sort and an arrow)
 * @claim "It scrolls sideways inside its own" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table scrolling > scrolls sideways inside its own region on a phone, named by the caption, without widening the page)
 * @claim "With `rowHref` each row is one" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table with rowHref > opens the row from a real tap on any cell, and buttons, links and inputs in cells keep their own taps on a phone)
 * @claim "With `rowHref` each row is one" registry/ouro/components/ouro/table/table.test.tsx verify:testExists(registry/ouro/components/ouro/table/table.test.tsx::Table with rowHref > makes each linked row one link named by its row header, with one tab stop, covering the row)
 */
export function Table<Row extends object = Record<string, unknown>>(props: TableProps<Row>): JSX.Element {
  const {
    caption,
    hideCaption,
    striped,
    dense,
    stickyHeader,
    className,
    style,
    ref,
    columns,
    rows,
    rowKey,
    rowHref,
    rowExternal,
    externalLabel,
    empty = "Nothing here yet.",
    sort,
    defaultSort,
    onSortChange,
    sortedLabel,
    children,
    data,
    onRowClick,
    title,
    sortable,
    ...rest
  } = props as TableProps<Row> & Partial<TableDataProps<Row>> & { children?: ReactNode };
  useAppearanceClassNameCheck(
    "Table",
    className,
    process.env.NODE_ENV !== "production" ? "put the Table inside a <Card> for a frame" : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Table",
    process.env.NODE_ENV !== "production"
      ? () => [
          !caption && ["caption is required; it names the table", '<Table caption="Recipes">, with hideCaption when a heading already shows it'],
          data !== undefined && ["data is not a prop", "<Table rows={recipes} columns={…}>"],
          onRowClick !== undefined && ["onRowClick is not a prop; a row opens a link", "<Table rowHref={(row) => `/recipes/${row.id}`}>"],
          title !== undefined && ["title is not a prop", `<Table caption="${String(title)}">`],
          sortable !== undefined && ["sortable is not a Table prop; it goes on a column", '{ key: "name", header: "Recipe", sortable: true }'],
          children !== undefined &&
            columns !== undefined && ["pass columns and rows, or parts as children, not both", '<Table caption="…" columns={…} rows={…} />'],
          columns !== undefined && rows === undefined && ["columns need rows", "<Table columns={…} rows={recipes}>"],
          stickyHeader && !hasHeight(className, style) && ["stickyHeader needs a height to scroll inside", '<Table stickyHeader className="max-h-96">'],
          ...columnWarnings(columns ?? []),
          ...sortWarnings(columns ?? none, rows ?? none, sort ?? defaultSort),
          sort !== undefined &&
            !onSortChange && ["sort needs onSortChange, or its headers can't change it", "<Table sort={sort} onSortChange={setSort}>, or defaultSort={…} for Table to sort the rows"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const list = rows ?? none;
  const [ownSort, setOwnSort] = useState<TableSort | null>(defaultSort ?? null);
  const controlled = sort !== undefined;
  const current = controlled ? sort : ownSort;
  const sortColumn = (columns ?? none).find((column) => column.key === current?.key && isSortable(column));
  const direction = directionOf(current?.direction);
  const locale = useSyncExternalStore(noSubscribe, browserLocale, serverLocale);
  const changeSort = (next: { key: string; direction: TableSortDirection }) => {
    // Controlled, the state goes unread, so setting it is harmless.
    setOwnSort(next);
    onSortChange?.(next);
  };
  const shown = useMemo(
    () => (controlled || !sortColumn ? list : sortRows(list, sortColumn as SortColumn<Row>, direction!, locale)),
    [controlled, list, sortColumn, direction, locale],
  );
  // The row header holds the row link and names it: the column marked rowHeader, or else the
  // first that shows a field's value (a `cell` renderer is often a checkbox or a badge).
  const marked = columns?.findIndex((column) => column.rowHeader) ?? -1;
  const headerIndex = marked >= 0 ? marked : Math.max(0, columns?.findIndex((column) => !column.cell) ?? 0);
  const alignOf = (align: string | undefined) => (align !== undefined && aligns.includes(align) ? (align as TableAlign) : undefined);
  const body =
    columns === undefined ? (
      children
    ) : (
      <>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.key}
                align={alignOf(column.align)}
                hideHeader={column.hideHeader}
                wrap={column.wrap}
                className={column.className}
                sorted={column === sortColumn ? direction : undefined}
                onSort={isSortable(column) ? (next) => changeSort({ key: column.key, direction: next }) : undefined}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length}>
                <span className="text-muted-foreground">{empty}</span>
              </TableCell>
            </TableRow>
          ) : (
            shown.map((row, index) => {
              const fields = row as Record<string, unknown>;
              const key =
                typeof rowKey === "function"
                  ? rowKey(row, index)
                  : rowKey !== undefined
                    ? (fields[rowKey] as Key)
                    : typeof fields["id"] === "string" || typeof fields["id"] === "number"
                      ? fields["id"]
                      : index;
              const href = typeof rowHref === "function" ? rowHref(row) : rowHref !== undefined ? (fields[rowHref] as string | undefined) : undefined;
              return (
                <TableRow key={key} href={href} external={rowExternal} externalLabel={externalLabel}>
                  {columns.map((column, columnIndex) => (
                    <TableCell key={column.key} rowHeader={columnIndex === headerIndex} align={alignOf(column.align)} wrap={column.wrap}>
                      {column.cell ? column.cell(row, index) : (fields[column.key] as ReactNode)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </>
    );
  return (
    <TableFrame
      {...rest}
      caption={caption}
      hideCaption={hideCaption}
      striped={striped}
      dense={dense}
      stickyHeader={stickyHeader}
      sortedLabel={sortedLabel}
      className={className}
      style={style}
      tableRef={ref}
    >
      {body}
    </TableFrame>
  );
}
