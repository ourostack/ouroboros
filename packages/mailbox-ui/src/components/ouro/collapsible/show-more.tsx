"use client";

import { flushSync } from "react-dom";
import { isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type JSX, type MouseEvent, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ouro/button/button";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { serverElement } from "@/lib/ouro/server-element";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import {
  foldClass,
  itemClass,
  listClass,
  showMoreHint,
  showMoreRootClass,
  textClass,
} from "@/components/ouro/collapsible/collapsible-styles";

/**
 * Props every ShowMore takes.
 *
 * @claim "Props every ShowMore takes" registry/ouro/components/ouro/collapsible/show-more.tsx verify:fileLine(registry/ouro/components/ouro/collapsible/show-more.tsx, /export\sinterface\sShowMoreListProps\sextends\sShowMoreBaseProps/)
 * @claim "Props every ShowMore takes" registry/ouro/components/ouro/collapsible/show-more.tsx verify:fileLine(registry/ouro/components/ouro/collapsible/show-more.tsx, /export\stype\sShowMoreLinesProps\s=\sShowMoreBaseProps\s&/)
 */
export interface ShowMoreBaseProps {
  /** The button's text while there is more to show. Translate it here. @default "Show more" */
  showMoreLabel?: string | undefined;
  /** Layout only: margins, width, grid placement (`mt-6`). Text classes go on a parent so the items inherit them. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
  /**
   * A stable name for what this shows (a message id), for `lines` and `maxHeight`. A row that mounts again with the
   * same key starts from its last measured fit, so it does not mount folded and then unfold. Without it, a mount measures afresh. The browser still measures and corrects it, so a changed width costs one write.
   */
  measureKey?: string | number | undefined;

  /** Not a prop. Ouro UI uses `lines`: `<ShowMore lines={3}>`. */
  maxLines?: { 'Use <ShowMore lines={3}>': never };
  /** Not a prop. Ouro UI uses `initialCount`: `<ShowMore items={items} initialCount={5}>`. */
  limit?: { 'Use <ShowMore items={items} initialCount={5}>': never };
}

/**
 * Whether the content shows in full, for a ShowMore that can show less again (text, height and a cut
 * list), when the app sets it: to reveal a match from find in page, or a linked anchor below the fold.
 */
export interface ShowMoreOpenProps {
  /**
   * Whether the content shows in full. With it, the app owns the state: "Show more" and "Show less"
   * ask for the change through `onOpenChange`, and nothing changes until the app sets `open`.
   * Without it, ShowMore keeps its own state, starting folded.
   * @claim "With it, the app owns the state" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore open > follows open in each mode, and its buttons ask onOpenChange without changing it)
   */
  open?: boolean | undefined;
  /**
   * Called with the new state when the button is pressed, or when keyboard focus moving below
   * a `maxHeight` fold unfolds it, whether or not `open` is set.
   * @claim "Called with the new state when the button is pressed" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore open > follows open in each mode, and its buttons ask onOpenChange without changing it)
   * @claim "whether or not `open` is set" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore open > tells onOpenChange each change of its own state when open is not set)
   */
  onOpenChange?: ((open: boolean) => void) | undefined;
}

/**
 * What folded content holds. Not read: ShowMore decides from the browser's layout, and this leaves the first frame as
 * it is. Kept so an app that passes it still compiles.
 * @deprecated
 */
export interface ShowMoreEstimate {
  /** Its plain text. Not read. */
  text?: string | undefined;
  /** The CSS pixels its pictures and cards take. Not read. */
  height?: number | undefined;
}

/** Long text clamped to `lines` lines, with "Show more" and "Show less". */
export type ShowMoreLinesProps = ShowMoreBaseProps & ShowMoreOpenProps & {
  /** How many lines show while collapsed. The button appears only when the text is longer. */
  lines: number;
  /**
   * The text. Screen readers always read all of it.
   *
   * @claim "Screen readers always read all of" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with lines > keeps the full text for screen readers and in server HTML)
   */
  children: ReactNode;
  /**
   * The button's text while everything shows. Translate it here. @default "Show less"
   *
   * @claim "The button's text while everything shows" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with items > takes translated labels)
   */
  showLessLabel?: string | undefined;
  /**
   * Not read: ShowMore does not guess whether content is longer than its fold, so this changes nothing. Kept so an app
   * that passes it still compiles.
   *
   * @deprecated
   */
  estimate?: ShowMoreEstimate | undefined;
  /** Not with `lines`: fold by height or by lines, not both. */
  maxHeight?: never;
  /** List modes only: not with `lines`. */
  items?: never;
  /**
   * Only with `items` and no `onShowMore`.
   *
   * @claim "Only with `items` and no `onShowMore`" registry/ouro/components/ouro/collapsible/show-more.test-d.ts verify:fileLine(registry/ouro/components/ouro/collapsible/show-more.test-d.ts, /initialCount:\s3;\sonShowMore:\s\(\)\s=>\svoid;\shasMore:\strue\s\}>\(\)\.not\.toExtend/)
   */
  initialCount?: never;
  /** List modes only: not with `lines`. */
  ordered?: never;
  /** Only for a list that loads more: with `items`, without `initialCount` or `lines`. */
  onShowMore?: never;
  /** Only with `onShowMore`. */
  hasMore?: never;
  /** Only with `onShowMore`. */
  loading?: never;
  /** Only with `onShowMore`. */
  loadingLabel?: never;
  /** Only with `onShowMore`. */
  loadedLabel?: never;
  /** Only with `onShowMore`. */
  noMoreLabel?: never;
  /** Only with `onShowMore`. */
  href?: never;
};

/** Long content of any kind folded to `maxHeight` pixels under a fade, with "Show more" and "Show less". */
export type ShowMoreHeightProps = ShowMoreBaseProps & ShowMoreOpenProps & {
  /**
   * How tall the content shows while folded, in CSS pixels, with its last part fading out.
   * Content at most a fifth taller shows whole, since a button that reveals a line or two
   * helps nobody. The button appears only when the content is folded.
   *
   * @claim "Content at most a fifth taller" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with maxHeight > shows content a little taller than maxHeight whole, with no button)
   */
  maxHeight: number;
  /**
   * The content: rich text, pictures, cards. Screen readers always read all of it, and
   * moving keyboard focus into the folded part unfolds it, so nothing focusable is out of sight.
   *
   * @claim "moving keyboard focus into the folded" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with maxHeight > unfolds when keyboard focus moves into the folded part)
   */
  children: ReactNode;
  /**
   * The button's text while everything shows. Translate it here. @default "Show less"
   *
   * @claim "The button's text while everything shows" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with maxHeight > unfolds when keyboard focus moves into the folded part)
   */
  showLessLabel?: string | undefined;
  /**
   * Not read: ShowMore does not guess whether content is longer than its fold, so this changes nothing. Kept so an app
   * that passes it still compiles.
   *
   * @deprecated
   */
  estimate?: ShowMoreEstimate | undefined;
  /** Not with `maxHeight`: fold by height or by lines, not both. */
  lines?: never;
  /** List modes only: not with `maxHeight`. */
  items?: never;
  /**
   * Only with `items` and no `onShowMore`.
   *
   * @claim "Only with `items` and no `onShowMore`" registry/ouro/components/ouro/collapsible/show-more.test-d.ts verify:fileLine(registry/ouro/components/ouro/collapsible/show-more.test-d.ts, /initialCount:\s3;\sonShowMore:\s\(\)\s=>\svoid;\shasMore:\strue\s\}>\(\)\.not\.toExtend/)
   */
  initialCount?: never;
  /** List modes only: not with `maxHeight`. */
  ordered?: never;
  /** Only for a list that loads more: with `items`, without `initialCount` or `lines`. */
  onShowMore?: never;
  /** Only with `onShowMore`. */
  hasMore?: never;
  /** Only with `onShowMore`. */
  loading?: never;
  /** Only with `onShowMore`. */
  loadingLabel?: never;
  /** Only with `onShowMore`. */
  loadedLabel?: never;
  /** Only with `onShowMore`. */
  noMoreLabel?: never;
  /** Only with `onShowMore`. */
  href?: never;
};

/** Props both list modes take. */
export interface ShowMoreListProps extends ShowMoreBaseProps {
  /**
   * Every item, in order. Each renders in its own list item; give elements a `key`. With
   * `onShowMore`, append each new page here.
   * @claim "Every item, in order" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with items > shows initialCount items and an ordered list with ordered)
   * @claim "Each renders in its own list" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with items > shows initialCount items and an ordered list with ordered)
   * @claim "With `onShowMore`, append each new page" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with items a Server Component passed > knows an appended page from a replaced list, and focuses the first new item)
   */
  items: readonly ReactNode[];
  /** Renders an `<ol>`, for a ranked or numbered list. @default false (`<ul>`) */
  ordered?: boolean | undefined;
  /** Text and height modes only: a list shows its first items. */
  estimate?: never;
  /** Text mode only: not with `items`. */
  lines?: never;
  /** Height mode only: not with `items`. */
  maxHeight?: never;
  /** Text mode only: a list takes `items`. */
  children?: never;
}

/** A list cut to its first `initialCount` items, with "Show more" and "Show less". */
export type ShowMoreItemsProps = ShowMoreListProps & ShowMoreOpenProps & {
  /** How many items show while collapsed. @default 5 */
  initialCount?: number | undefined;
  /**
   * The button's text while everything shows. Translate it here. @default "Show less"
   *
   * @claim "The button's text while everything shows" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with items > takes translated labels)
   */
  showLessLabel?: string | undefined;
  /** Only for a list that loads more: with `items`, without `initialCount` or `lines`. */
  onShowMore?: never;
  /** Only with `onShowMore`. */
  hasMore?: never;
  /** Only with `onShowMore`. */
  loading?: never;
  /** Only with `onShowMore`. */
  loadingLabel?: never;
  /** Only with `onShowMore`. */
  loadedLabel?: never;
  /** Only with `onShowMore`. */
  noMoreLabel?: never;
  /** Only with `onShowMore`. */
  href?: never;
};

/** A list the server grows a page at a time: "Show more" asks for the next page and appends it. */
export type ShowMoreLoadProps = ShowMoreListProps & {
  /** Asks for the next page. The button is busy while `loading`, and focus moves to the first new item when it arrives. */
  onShowMore: () => void;
  /** Whether there is another page. Without one, the button goes away. */
  hasMore: boolean;
  /** Shows the button as busy, and keeps it from asking twice. */
  loading?: boolean | undefined;
  /** What screen readers hear when loading starts. Translate it here. @default "Loading" */
  loadingLabel?: string | undefined;
  /**
   * What screen readers hear after each page, from the number of items now shown. Name the
   * items and translate it here: `` (count) => `Showing ${count} recipes` ``.
   * @default (count) => `Showing ${count} items`
   * @claim "What screen readers hear after each" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore announcements > says how many items show after each page, through a polite status region)
   */
  loadedLabel?: ((count: number) => string) | undefined;
  /**
   * What screen readers hear when a page comes back empty and there is no more. Translate it here. @default "No more items"
   *
   * @claim "What screen readers hear when a" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore announcements > says there are no more items when a later page comes back empty, in the words of noMoreLabel)
   */
  noMoreLabel?: string | undefined;
  /**
   * The next page's URL, so the button is a link that works before JavaScript loads. With
   * JavaScript, pressing it calls `onShowMore` instead.
   */
  href?: string | undefined;
  /**
   * Only with `items` and no `onShowMore`.
   *
   * @claim "Only with `items` and no `onShowMore`" registry/ouro/components/ouro/collapsible/show-more.test-d.ts verify:fileLine(registry/ouro/components/ouro/collapsible/show-more.test-d.ts, /initialCount:\s3;\sonShowMore:\s\(\)\s=>\svoid;\shasMore:\strue\s\}>\(\)\.not\.toExtend/)
   */
  initialCount?: never;
  /** Not for a list that loads more, which only grows. */
  open?: never;
  /** Not for a list that loads more, which only grows. */
  onOpenChange?: never;
  /**
   * A list that loads more never shrinks, so it has no "Show less".
   *
   * @claim "A list that loads more never" registry/ouro/components/ouro/collapsible/show-more.test-d.ts verify:fileLine(registry/ouro/components/ouro/collapsible/show-more.test-d.ts, /showLessLabel:\s"Less"\s\}>\(\)\.not\.toExtend/)
   */
  showLessLabel?: never;
};

/**
 * Props for {@link ShowMore}: clamp text with `lines`, fold any content with `maxHeight`, cut a
 * list with `items`, or grow it from the server with `onShowMore`.
 */
export type ShowMoreProps = ShowMoreLinesProps | ShowMoreHeightProps | ShowMoreItemsProps | ShowMoreLoadProps;

const DEFAULT_COUNT = 5;
const DEFAULT_LINES = 3;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focuses the first focusable thing in a row, or the row itself. */
function focusRow(row: Element): void {
  (row.querySelector<HTMLElement>(FOCUSABLE) ?? (row as HTMLElement)).focus();
}

/** The first item of a list that was empty when "Show more" was pressed: any first page is new items. */
const EMPTY = Symbol("empty");

/**
 * What stays the same for an item across renders: an element's key, or a text or number item
 * itself. An element without a key is a new object every render, so it has none (null).
 * @claim "An element without a key is" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with items a Server Component passed > keys each row by its item's own key, so a row keeps its node when the order changes)
 */
function identity(item: ReactNode): unknown {
  // An item a Server Component passed can be a lazy wrapper, a new object on every payload.
  const element = serverElement(item);
  if (isValidElement(element)) return element.key;
  return element;
}

/** The row's key: the item's own key, or its place in the list. */
function rowKey(item: ReactNode, index: number): string | number {
  const element = serverElement(item);
  return isValidElement(element) && element.key !== null ? element.key : index;
}

/**
 * Whether the content shows in full: `open` when the app sets it, else ShowMore's own state, and
 * a setter that tells `onOpenChange` and keeps the asked-for state, which shows once `open` is unset.
 */
function useOpen(open: boolean | undefined, onOpenChange: ((open: boolean) => void) | undefined): [boolean, (next: boolean) => void] {
  const [own, setOwn] = useState(false);
  const set = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  return [open ?? own, set];
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const isHeight = (value: unknown): value is number => Number.isFinite(value) && (value as number) > 0;
const DEFAULT_HEIGHT = 240;

/**
 * "Show more" for a long list or a long text. It cuts a list to its first items, clamps text
 * to a number of lines, folds content of any kind (a long post with pictures) to a height
 * under a fade, or grows a list a page at a time from the server, and moves focus to
 * the first newly shown item, so keyboard and screen reader users land on what they asked
 * for. A list that loads more also says how many items now show. The button names what it
 * folds (`aria-controls`) and, unless it loads more, says whether it is open (`aria-expanded`).
 * Folded text and content are folded by CSS in the first commit and in server HTML, and the button comes after the
 * browser has laid them out: ShowMore does not guess whether they are longer than the fold. One ResizeObserver reads the
 * layout and adds the button to what overflows.
 * The visible items are in the server HTML. ShowMore draws the list itself: put a border
 * around the list on a wrapping element, and borders between rows on each item.
 *
 * Use `Collapsible` instead to hide a whole section behind its title. Use `Pagination`
 * instead when people need to jump to a page or share its URL.
 *
 * @group Lists
 * @see https://ui.ouroboros.bot/docs/show-more
 *
 * @example
 * <ShowMore items={reviews.map((review) => <Review key={review.id} {...review} />)} initialCount={3} />
 * <ShowMore lines={3}>{recipe.description}</ShowMore>
 * <ShowMore maxHeight={180}><Post body={post.body} /></ShowMore>
 * <ShowMore items={rows} hasMore={Boolean(nextCursor)} loading={loading} onShowMore={loadNext} href={nextHref} />
 * <ShowMore lines={3} open={open} onOpenChange={setOpen}>{recipe.description}</ShowMore>
 * @claim "The button names what it folds" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore toggle semantics > names the list, the text or the fold it opens and says whether it is open, in every mode that folds)
 * @claim "The button names what it folds" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore toggle semantics > names the list a load adds to, and claims no open state, since loading more never folds)
 * @claim "folds content of any kind" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with maxHeight > folds long content to maxHeight under a fade, with Show more)
 * @claim "ShowMore draws the list itself: put" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore with items > lets app layout classes win and keys rows by their own keys)
 */
export function ShowMore(props: ShowMoreProps): JSX.Element {
  const { showMoreLabel = "Show more", className, ref, maxLines, limit } = props;
  const { lines, initialCount, items, maxHeight } = props;
  useAppearanceClassNameCheck(
    "ShowMore",
    className,
    process.env.NODE_ENV !== "production" ? showMoreHint : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "ShowMore",
    process.env.NODE_ENV !== "production"
      ? () => [
          maxLines !== undefined && ["maxLines is not a prop", `<ShowMore lines={${String(maxLines)}}>`],
          limit !== undefined && ["limit is not a prop", `<ShowMore items={items} initialCount={${String(limit)}}>`],
          initialCount !== undefined &&
            !isCount(initialCount) && [
              `initialCount={${String(initialCount)}} is not a whole number above 0`,
              `<ShowMore items={items} initialCount={${DEFAULT_COUNT}}>`,
            ],
          lines !== undefined &&
            !isCount(lines) && [`lines={${String(lines)}} is not a whole number above 0`, `<ShowMore lines={${DEFAULT_LINES}}>`],
          maxHeight !== undefined &&
            !isHeight(maxHeight) && [`maxHeight={${String(maxHeight)}} is not a number of pixels above 0`, `<ShowMore maxHeight={${DEFAULT_HEIGHT}}>`],
          (props as ShowMoreOpenProps).open !== undefined &&
            (props as ShowMoreOpenProps).onOpenChange === undefined && ["open without onOpenChange: its button can't change it", "<ShowMore open={open} onOpenChange={setOpen}>"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  if (items === undefined && maxHeight !== undefined) {
    const { children, showLessLabel = "Show less", open, onOpenChange } = props as ShowMoreHeightProps;
    const { measureKey } = props;
    return (
      <ShowMoreHeight
        open={open}
        onOpenChange={onOpenChange}
        maxHeight={isHeight(maxHeight) ? maxHeight : DEFAULT_HEIGHT}
        showMoreLabel={showMoreLabel}
        showLessLabel={showLessLabel}
        className={className}
        rootRef={ref}
        measureKey={measureKey}
      >
        {children}
      </ShowMoreHeight>
    );
  }
  if (items === undefined) {
    // Text mode. A guessed maxLines (a type error) still clamps, as lines would.
    const { children, showLessLabel = "Show less", open, onOpenChange } = props as ShowMoreLinesProps;
    const { measureKey } = props;
    const clamp = [lines, maxLines].find(isCount) ?? DEFAULT_LINES;
    return (
      <ShowMoreText
        open={open}
        onOpenChange={onOpenChange}
        lines={clamp}
        showMoreLabel={showMoreLabel}
        showLessLabel={showLessLabel}
        className={className}
        rootRef={ref}
        measureKey={measureKey}
      >
        {children}
      </ShowMoreText>
    );
  }
  return <ShowMoreList {...(props as ShowMoreItemsProps | ShowMoreLoadProps)} showMoreLabel={showMoreLabel} />;
}

/**
 * What an instance last measured, by its `measureKey`, so a row that mounts again (a list that scrolls, a chat that
 * loads older messages) that has one starts with its last answer instead of folding and then undoing it. The resize
 * observer still measures and corrects it, so a wrong guess (a new width) costs one correction.
 */
const fitCache = new Map<string, boolean>();
const FIT_CACHE_SIZE = 1000;

const remember = (key: string | undefined, value: boolean): void => {
  // Stryker disable next-line ConditionalExpression: an unkeyed instance never reads the cache, so a stray entry is not observable
  if (key === undefined) return;
  // Stryker disable next-line all: only moves a key to the newest place; it matters one eviction later and not by a line's worth of behaviour
  fitCache.delete(key);
  fitCache.set(key, value);
  // Stryker disable next-line EqualityOperator: one entry more or fewer is not observable
  if (fitCache.size > FIT_CACHE_SIZE) fitCache.delete(fitCache.keys().next().value!);
};

/**
 * One ResizeObserver for every ShowMore, and one animation-frame callback that measures them all. The observer only says
 * which ones changed size; the answers are read and committed in the next animation frame's callback, which the browser
 * runs before it lays the page out for that frame's observers and before it paints. So the button and the fade are in the
 * first frame the browser paints, a list of many folds costs one layout, and no read is forced while React commits.
 * Committing inside the observer's callback instead resizes elements the app watches above this one (its body, its shell),
 * and WebKit answers with the window error "ResizeObserver loop completed with undelivered notifications", which an
 * app's end-to-end fixture that fails on page errors counts as a failure.
 *
 * @claim "One ResizeObserver for every ShowMore" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore in its first frame > measures many folds with one observer, every one's button in the same first painted frame)
 * @claim "So the button and the fade are in the first frame the browser paints" registry/ouro/components/ouro/collapsible/show-more.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/show-more.test.tsx::ShowMore in its first frame > has its button and fade in the first frame the browser paints, and nothing for what fits)
 */
type Fit = () => () => void;
// Weak, so an element that is gone needs no clean-up: the observer delivers only the elements it watches.
const fitReaders = new WeakMap<Element, Fit>();
const pendingFits = new Set<Element>();
let fitFrame = 0;
let fitObserver: ResizeObserver | undefined;
function scheduleFit(): void {
  fitFrame ||= requestAnimationFrame(() => {
    fitFrame = 0;
    const targets = [...pendingFits];
    pendingFits.clear();
    // Every read first, then every write, so no read lays the page out again.
    const answers = targets.map((target) => fitReaders.get(target)!());
    flushSync(() => answers.forEach((answer) => answer()));
  });
}
function observeFit(element: Element, fit: Fit): () => void {
  fitObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) pendingFits.add(entry.target);
    scheduleFit();
  });
  fitReaders.set(element, fit);
  // Measured in the next frame's callback, ahead of the observer's own first delivery, so the first painted frame has it.
  pendingFits.add(element);
  scheduleFit();
  fitObserver.observe(element);
  return () => {
    pendingFits.delete(element);
    fitObserver!.unobserve(element);
  };
}

const clampClass = "line-clamp-(--ouro-show-more-lines)";

function ShowMoreText({
  open,
  onOpenChange,
  lines,
  children,
  showMoreLabel,
  showLessLabel,
  className,
  rootRef,
  measureKey,
}: {
  lines: number;
  children: ReactNode;
  showMoreLabel: string;
  showLessLabel: string;
  className: string | undefined;
  rootRef: Ref<HTMLDivElement> | undefined;
  measureKey: string | number | undefined;
} & ShowMoreOpenProps): JSX.Element {
  const [expanded, setExpanded] = useOpen(open, onOpenChange);
  // Folded by CSS in the first commit and in server HTML, with no button and no guess: a ResizeObserver reads after the
  // browser lays the text out and adds the button to text that overflows, so no instance makes the page lay out again.
  // It starts in a layout effect and commits with every other ShowMore's answer before paint (observeFit).
  const fitKey = measureKey === undefined ? undefined : `text:${lines}:${measureKey}`;
  // Stryker disable next-line ConditionalExpression: an unkeyed instance has nothing cached, so reading by an undefined key gives the same answer
  const [overflowing, setOverflowing] = useState(() => (fitKey === undefined ? undefined : fitCache.get(fitKey)) ?? false);
  const textRef = useRef<HTMLDivElement>(null);
  const textId = useId();
  useLayoutEffect(() => {
    const text = textRef.current!;
    return observeFit(text, () => {
      // Clamped, whether it hides any; whole, whether it is taller than the lines it clamps to.
      const clamped = !expanded;
      const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
      if (clamped) {
        // Stryker disable next-line EqualityOperator: a hidden line is many pixels, so > and >= differ only at a 1px rounding gap no text has
        const over = text.scrollHeight > text.clientHeight + 1;
        remember(fitKey, over);
        return () => setOverflowing(over);
      }
      // A line height that is not a length (`normal`) cannot say, so the button stays: shown whole, it is the way back.
      // Stryker disable next-line EqualityOperator: as above, a line is many pixels.
      const over = lineHeight > 0 ? text.clientHeight > lineHeight * lines + 1 : true;
      // Stryker disable next-line all: a mount is always folded and measures again, so what an expanded one remembers only changes whether a later remount writes
      remember(fitKey, over);
      return () => setOverflowing(over);
    });
  }, [expanded, lines, fitKey]);
  return (
    <div ref={rootRef} data-ouro="show-more" className={cn(showMoreRootClass, className)}>
      <div
        ref={textRef}
        id={textId}
        data-ouro-show-more-text=""
        data-ouro-allow="clipped-text"
        data-ouro-allow-why="Clamped to its lines on purpose; Show more shows the rest"
        className={cn(textClass, !expanded && clampClass)}
        style={{ "--ouro-show-more-lines": lines } as CSSProperties}
      >
        {children}
      </div>
      {overflowing && (
        <Button
          variant="plain"
          size="sm"
          className="-ms-(--ouro-button-px)"
          data-ouro-show-more-toggle=""
          data-ouro-control="show-more"
          data-ouro-part="toggle"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? showLessLabel : showMoreLabel}
        </Button>
      )}
    </div>
  );
}

function ShowMoreHeight({
  open,
  onOpenChange,
  maxHeight,
  children,
  showMoreLabel,
  showLessLabel,
  className,
  rootRef,
  measureKey,
}: {
  maxHeight: number;
  children: ReactNode;
  showMoreLabel: string;
  showLessLabel: string;
  className: string | undefined;
  rootRef: Ref<HTMLDivElement> | undefined;
  measureKey: string | number | undefined;
} & ShowMoreOpenProps): JSX.Element {
  const [expanded, setExpanded] = useOpen(open, onOpenChange);
  // Unknown until the browser has laid the content out, so the first commit and server HTML are folded by CSS with no
  // button and no guess: the ResizeObserver reads after layout and says whether it fits. It starts in a layout effect and
  // commits with every other ShowMore's answer before paint (observeFit).
  const fitKey = measureKey === undefined ? undefined : `height:${maxHeight}:${measureKey}`;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: an unkeyed instance has nothing cached; a cached answer is a boolean and `&& null` differs only by folding first, which the remount tests hold through the keyed path
  const [fits, setFits] = useState<boolean | null>(() => (fitKey === undefined ? undefined : fitCache.get(fitKey)) ?? null);
  const contentRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const foldId = useId();
  useLayoutEffect(() => {
    const content = contentRef.current!;
    // Measured once as it starts, and again on every change of size.
    return observeFit(content, () => {
      const fit = content.scrollHeight <= maxHeight * 1.2;
      remember(fitKey, fit);
      return () => setFits(fit);
    });
  }, [maxHeight, fitKey]);
  const folded = !expanded && fits !== true;
  const toggle = () => {
    if (expanded) {
      setExpanded(false);
      // The content shrinks above the button; keep the button on screen.
      requestAnimationFrame(() => buttonRef.current?.scrollIntoView({ block: "nearest" }));
    } else setExpanded(true);
  };
  // Focus that lands below the fold (a link, a button in a card) unfolds the content.
  const reveal = (event: FocusEvent<HTMLDivElement>) => {
    // Unfolded, nothing is below the box's bottom, so this is folded content only.
    const fold = event.currentTarget;
    // The browser may already have scrolled the clipped box to the focused element, so measure
    // from the box's unscrolled top.
    const bottom = (event.target as HTMLElement).getBoundingClientRect().bottom - fold.getBoundingClientRect().top + fold.scrollTop;
    if (bottom > fold.clientHeight) {
      fold.scrollTop = 0;
      setExpanded(true);
    }
  };
  return (
    <div ref={rootRef} data-ouro="show-more" className={cn(showMoreRootClass, className)}>
      <div
        id={foldId}
        data-ouro-show-more-fold=""
        data-folded={folded && fits === false ? "" : undefined}
        data-ouro-allow="clipped-text"
        data-ouro-allow-why="Folded to its height on purpose; Show more shows the rest"
        onFocus={reveal}
        className={cn(foldClass, folded && "max-h-(--ouro-show-more-height) overflow-hidden")}
        style={{ "--ouro-show-more-height": `${maxHeight}px` } as CSSProperties}
      >
        <div ref={contentRef} className="flow-root">
          {children}
        </div>
      </div>
      {fits === false && (
        <Button
          ref={buttonRef}
          variant="plain"
          size="sm"
          className="-ms-(--ouro-button-px)"
          data-ouro-show-more-toggle=""
          data-ouro-control="show-more"
          data-ouro-part="toggle"
          aria-expanded={expanded}
          aria-controls={foldId}
          onClick={toggle}
        >
          {expanded ? showLessLabel : showMoreLabel}
        </Button>
      )}
    </div>
  );
}

function ShowMoreList(props: (ShowMoreItemsProps | ShowMoreLoadProps) & { showMoreLabel: string }): JSX.Element {
  const { items, ordered, showMoreLabel, className, ref } = props;
  const load = props.onShowMore !== undefined ? (props as ShowMoreLoadProps) : undefined;
  const { initialCount, showLessLabel = "Show less", open, onOpenChange } = props as ShowMoreItemsProps;
  const count = isCount(initialCount) ? initialCount : DEFAULT_COUNT;
  const [expanded, setExpanded] = useOpen(open, onOpenChange);
  // Rows from this index on are newly shown: they fade in.
  const [freshFrom, setFreshFrom] = useState<number | null>(null);
  // The index of the first row the last press asked for, until focus has moved there, and the
  // first item when it was asked: a different first item means a new list, not the next page.
  const pending = useRef<number | null>(null);
  const pendingFirst = useRef<unknown>(undefined);
  const listRef = useRef<HTMLUListElement & HTMLOListElement>(null);
  const buttonRef = useRef<HTMLElement>(null);
  const listId = useId();
  const loading = load?.loading === true;
  const visible = load || expanded ? items : items.slice(0, count);
  const hasButton = load ? load.hasMore : items.length > count;

  // What the status region says after a page loads (load mode only).
  const [status, setStatus] = useState("");
  // Whether `loading` was true since the last press, so a load that ends with no new items is noticed.
  const loaded = useRef(false);
  const loadedLabel = load?.loadedLabel ?? ((shown: number) => `Showing ${shown} items`);
  const noMoreLabel = load?.noMoreLabel ?? "No more items";

  useEffect(() => {
    const from = pending.current;
    if (from === null) return;
    if (loading) {
      loaded.current = true;
      return;
    }
    const rows = listRef.current!.children;
    const stop = () => {
      pending.current = null;
      loaded.current = false;
    };
    const arrive = (row: Element | undefined, message: string) => {
      stop();
      // The button is gone. An empty list whose load found nothing has no row, so focus moves
      // to the list itself (focusable and named by noMoreLabel while empty), never to the page.
      if (row) focusRow(row);
      else listRef.current!.focus();
      if (load) setStatus(message);
    };
    const replaced = pendingFirst.current !== EMPTY && identity(items[0]) !== pendingFirst.current;
    if (replaced || rows.length < from) {
      // The list was replaced (a new first item, or fewer items: a new search). Stop waiting,
      // so a later change to the list never moves focus.
      stop();
    } else if (rows.length > from) {
      arrive(rows[from]!, loadedLabel(rows.length));
    } else if (!hasButton) {
      // The last page came back empty and the button is gone: keep focus in the list.
      arrive(rows[rows.length - 1], noMoreLabel);
    } else if (loaded.current) {
      // The load ended with no new items (it failed): stop waiting, as above.
      stop();
    }
  });

  const press = (event: MouseEvent) => {
    if (load) {
      event.preventDefault();
      pending.current = items.length;
      pendingFirst.current = items.length === 0 ? EMPTY : identity(items[0]);
      loaded.current = false;
      setFreshFrom(items.length);
      load.onShowMore();
    } else if (expanded) {
      setExpanded(false);
      setFreshFrom(null);
      // The list shrinks above the button; keep the button on screen.
      requestAnimationFrame(() => buttonRef.current?.scrollIntoView({ block: "nearest" }));
    } else {
      pending.current = count;
      // The button shows only when there are more items than count, so the list is not empty.
      pendingFirst.current = identity(items[0]);
      setFreshFrom(count);
      setExpanded(true);
    }
  };

  const List = ordered ? "ol" : "ul";
  // An empty list with nothing more to load takes focus when the last load finds nothing, so it
  // is named for that already when focus lands.
  const emptyEnd = load !== undefined && items.length === 0 && !load.hasMore;
  const button = !hasButton ? null : load ? (
    <Button
      ref={buttonRef as Ref<HTMLAnchorElement & HTMLButtonElement>}
      variant="plain"
      size="sm"
      className="-ms-(--ouro-button-px)"
      data-ouro-show-more-toggle="" data-ouro-control="show-more" data-ouro-part="toggle"
      aria-controls={listId}
      loading={loading}
      loadingLabel={load.loadingLabel}
      onClick={press}
      {...(load.href !== undefined ? { href: load.href } : {})}
    >
      {showMoreLabel}
    </Button>
  ) : (
    <Button
      ref={buttonRef as Ref<HTMLButtonElement>}
      variant="plain"
      size="sm"
      className="-ms-(--ouro-button-px)"
      data-ouro-show-more-toggle=""
      data-ouro-control="show-more"
      data-ouro-part="toggle"
      aria-expanded={expanded}
      aria-controls={listId}
      onClick={press}
    >
      {expanded ? showLessLabel : showMoreLabel}
    </Button>
  );
  return (
    <div ref={ref} data-ouro="show-more" className={cn(showMoreRootClass, className)}>
      {/* Safari drops list semantics from an unstyled list unless the role is explicit. */}
      <List
        ref={listRef}
        id={listId}
        role="list"
        tabIndex={emptyEnd ? -1 : undefined}
        aria-label={emptyEnd ? noMoreLabel : undefined}
        className={cn(listClass, emptyEnd && "outline-none")}
      >
        {visible.map((item, index) => (
          <li
            key={rowKey(item, index)}
            tabIndex={-1}
            className={cn(
              itemClass,
              freshFrom !== null && index >= freshFrom && "transition-opacity duration-(--ouro-duration-base) ease-(--ouro-ease-out) starting:opacity-0",
            )}
          >
            {item}
          </li>
        ))}
      </List>
      {button}
      {/* Stays mounted after the last page, so the last count is still read. */}
      {load && (
        <p role="status" data-ouro-show-more-status="" className="sr-only">
          {status}
        </p>
      )}
    </div>
  );
}
