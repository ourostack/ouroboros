"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, HTMLAttributes, JSX, Ref, RefCallback } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { joinWave } from "@/components/ouro/skeleton/skeleton-styles";
import { useMergedRef } from "@/lib/ouro/refs";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";

/** Avatar's sizes, for `<Skeleton shape="circle" size>`. */
export type SkeletonAvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

/** Skeleton's layout props, ref and hint props, whatever its shape. */
interface SkeletonCommonProps {
  /** Layout only: size, margins and placement (`h-32`, `w-1/2`). The color and corners come from the theme and `shape`. */
  className?: string | undefined;
  ref?: Ref<HTMLSpanElement> | undefined;
  /**
   * Whether the placeholder breathes once it has been loading for a second. `false` draws it still, as reduced motion does.
   * Only the first placeholders mounted at once breathe; the rest of a long list hold still, which keeps WebKit's wheel scrolling smooth.
   * Choose it for a long list of pictures loading at once, where animating each may slow scrolling.
   * @default true
   */
  shimmer?: boolean | undefined;

  /** Not a prop. Ouro UI uses `shape`: `<Skeleton shape="circle">`. */
  variant?: { 'Use <Skeleton shape="circle">': never };
  /** Not a prop. Skeleton breathes, and holds still with reduced motion. */
  animation?: { 'Not a prop: Skeleton breathes, and holds still with reduced motion': never };
  /** Not a prop. Size it with a layout class: `<Skeleton className="w-32">`. */
  width?: { 'Use <Skeleton className="w-32">': never };
  /** Not a prop. Size it with a layout class, or give `shape="text"` its `lines`: `<Skeleton className="h-6">`. */
  height?: { 'Use <Skeleton className="h-6">, or <Skeleton shape="text" lines={3}>': never };
}

/** A block, such as an image or a chart: `<Skeleton className="h-32" />`. */
export interface SkeletonRectShape {
  /**
   * The outline of what is loading: `rect` (a block), `text` (lines), `circle` (an avatar), `row` (a list row) or `card`.
   * @default "rect"
   */
  shape?: "rect" | undefined;
  /** Only with `shape="text"`, `"circle"`, `"row"` or `"card"`. Size a block with a layout class. */
  size?: never;
  /** Only with `shape="text"`. */
  lines?: never;
  /** Only with `shape="row"` or `"card"`. */
  count?: never;
}

/** Lines of text: `<Skeleton shape="text" size="sm" lines={3} />`. */
export interface SkeletonTextShape {
  /** The outline of what is loading: `rect` (a block), `text` (lines), `circle` (an avatar), `row` (a list row) or `card`. */
  shape: "text";
  /**
   * Text's size, so each line is one line box of that text. Leave it out to inherit the surrounding text's size.
   * @claim "Text's size, so each line is one line box" registry/ouro/components/ouro/skeleton/skeleton.test.tsx verify:testExists(registry/ouro/components/ouro/skeleton/skeleton.test.tsx::Skeleton > takes the space of the text it stands in for at each of Text's sizes, the last of several lines shorter)
   */
  size?: "sm" | "md" | "lg" | (string & { 'Use "sm", "md" or "lg", Text\'s sizes': never }) | undefined;
  /**
   * How many lines of text it stands in for; the last of several is shorter, like a paragraph's.
   * @default 1
   */
  lines?: number | undefined;
  /** Only with `shape="row"` or `"card"`. For several lines use `lines`. */
  count?: never;
}

/** An avatar: `<Skeleton shape="circle" size="lg" />`. */
export interface SkeletonCircleShape {
  /** The outline of what is loading: `rect` (a block), `text` (lines), `circle` (an avatar), `row` (a list row) or `card`. */
  shape: "circle";
  /**
   * Avatar's size, so it is the avatar's exact box. A layout class (`size-12`) sizes it instead.
   * @default "md"
   */
  size?: SkeletonAvatarSize | (string & { 'Use Avatar\'s sizes: "xs", "sm", "md", "lg", "xl", "2xl" or "3xl"': never }) | undefined;
  /** Only with `shape="text"`. */
  lines?: never;
  /** Only with `shape="row"` or `"card"`. */
  count?: never;
}

/** List rows or Cards: `<Skeleton shape="row" count={6} />`. */
export interface SkeletonRowOrCardShape {
  /** The outline of what is loading: `rect` (a block), `text` (lines), `circle` (an avatar), `row` (a list row) or `card`. */
  shape: "row" | "card";
  /**
   * Item's or Card's size, so each placeholder is that component's exact height.
   * @claim "Item's or Card's size, so each placeholder" registry/ouro/components/ouro/skeleton/skeleton.test.tsx verify:testExists(registry/ouro/components/ouro/skeleton/skeleton.test.tsx::Skeleton > is the exact height of an Item row and an outline Card, at each size, so nothing moves when they arrive)
   * @default "md"
   */
  size?: "sm" | "md" | (string & { 'Use "sm" or "md", Item\'s and Card\'s sizes': never }) | undefined;
  /**
   * How many rows or cards to show. Each is its own element, so they sit in the grid or the
   * `div` the content will fill (not directly in a `ul`: the rows are `span`s with `display: grid`).
   * @claim "Each is its own element, so they sit" registry/ouro/components/ouro/skeleton/skeleton.test.tsx verify:testExists(registry/ouro/components/ouro/skeleton/skeleton.test.tsx::Skeleton > repeats rows and cards count times, each its own element, with the ref and the id on the first)
   * @default 1
   */
  count?: number | undefined;
  /** Only with `shape="text"`. */
  lines?: never;
}

/**
 * The outline of what is loading, and the sizes that make it take the content's exact space.
 * `rect` is a block (an image, a chart); `text` is lines of text, each one line box tall in
 * Text's `size`; `circle` is an avatar at Avatar's `size`; `row` is a list row the height of
 * an Item with a title, a description and 40px media; `card` is an outline Card with a title,
 * a description and two lines of body text. `row` and `card` repeat `count` times.
 * @claim "`rect` is a block (an image, a chart)" registry/ouro/components/ouro/skeleton/skeleton.test.tsx verify:testExists(registry/ouro/components/ouro/skeleton/skeleton.test.tsx::Skeleton > is the exact height of an Item row and an outline Card, at each size, so nothing moves when they arrive)
 * @claim "`rect` is a block (an image, a chart)" registry/ouro/components/ouro/skeleton/skeleton.test.tsx verify:testExists(registry/ouro/components/ouro/skeleton/skeleton.test.tsx::Skeleton > takes the space of the text it stands in for at each of Text's sizes, the last of several lines shorter)
 * @claim "`rect` is a block (an image, a chart)" registry/ouro/components/ouro/skeleton/skeleton.test.tsx verify:testExists(registry/ouro/components/ouro/skeleton/skeleton.test.tsx::Skeleton > is the exact box of an Avatar at each of its sizes)
 */
export type SkeletonShapeProps = SkeletonRectShape | SkeletonTextShape | SkeletonCircleShape | SkeletonRowOrCardShape;

/** The props Skeleton adds to the `<span>` attributes it passes through. */
export type SkeletonOwnProps = SkeletonCommonProps & SkeletonShapeProps;

/** The `<span>` attributes Skeleton passes through, and its props shared by the shapes. */
type SkeletonBaseProps = Omit<HTMLAttributes<HTMLSpanElement>, keyof SkeletonCommonProps | "shape" | "size" | "lines" | "count" | "children"> &
  SkeletonCommonProps;
/** Skeleton's props for a block. */
export type SkeletonRectProps = SkeletonBaseProps & SkeletonRectShape;
/** Skeleton's props for lines of text. */
export type SkeletonTextProps = SkeletonBaseProps & SkeletonTextShape;
/** Skeleton's props for an avatar. */
export type SkeletonCircleProps = SkeletonBaseProps & SkeletonCircleShape;
/** Skeleton's props for list rows or Cards. */
export type SkeletonRowOrCardProps = SkeletonBaseProps & SkeletonRowOrCardShape;

/** Props for {@link Skeleton}: its own props and the `<span>` attributes it passes through, by shape. */
export type SkeletonProps = SkeletonRectProps | SkeletonTextProps | SkeletonCircleProps | SkeletonRowOrCardProps;

// Class strings are literal so the app's Tailwind finds them when it compiles, so the keyframes name is a plain
// literal here, kept in step with the constant below by the test that reads both. The placeholder holds still
// for its first second, since most loads end sooner, then breathes: its opacity eases down and back, so the loop
// has no seam. Opacity runs on the compositor and nothing repaints. With reduced motion it holds still.
const fill =
  "relative block overflow-hidden bg-muted " +
  "animate-[ouro-skeleton-breathe_2.4s_ease-in-out_var(--ouro-skeleton-delay,1s)_infinite] motion-reduce:animate-none " +
  // Forced colours paint the fill as the page's own Canvas, so an outline in the text colour keeps the shape.
  "forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1 forced-colors:outline-[CanvasText]";

// The keyframes name above, as a plain value: which CSSAnimation the join correction below applies to.
const breatheAnimationName = "ouro-skeleton-breathe";

// `shimmer={false}`: no breathing at all.
const still = "animate-none";

// WebKit drops wheel-scroll frames once a hundred or so placeholders animate at once, each its own compositing layer.
// So only the first few mounted placeholders breathe; the rest hold still. A short list still shows life, and a long
// one costs nothing. A placeholder that goes away hands its place to the next one that mounts.
const breatheLimit = 24;
let breathing = 0;

// Every placeholder on the page breathes as one wave. A CSS animation starts when its element is first drawn, so one
// drawn later (a remount, a pane that opens while the others breathe) would start its breath over, out of step with the
// rest. So each one sets its own delay, from the wave's start, before its first frame: still for what remains of the
// first second, then partway through a breath. The wave starts with the first placeholder of a load and ends once
// none has breathed for a second; the next starts a new one. This writes a custom property and reads no layout.
let waveStart = 0;
let emptiedAt = Number.NEGATIVE_INFINITY;

function useBreathes(shimmer: boolean): { breathes: boolean; style: CSSProperties | undefined; registerNode: (index: number) => RefCallback<Element> } {
  const [claim, setClaim] = useState<{ breathes: boolean; delay: string | undefined }>({ breathes: true, delay: undefined });
  // Where the wave's own start was when this placeholder joined it, so a later correction (below) can read it again.
  const startRef = useRef<number | undefined>(undefined);
  // Every drawn element of this placeholder (the root, or one Bar per row/card item beyond the first), so the
  // correction below can reach each of their animations. Keyed by index, so re-renders reuse the same callback
  // identity instead of detaching and reattaching on every one.
  const nodesRef = useRef<Map<number, Element>>(new Map());
  const callbacksRef = useRef<Map<number, RefCallback<Element>>>(new Map());
  const registerNode = useCallback((index: number): RefCallback<Element> => {
    let callback = callbacksRef.current.get(index);
    if (!callback) {
      callback = (node) => {
        if (node) nodesRef.current.set(index, node);
        else nodesRef.current.delete(index);
      };
      callbacksRef.current.set(index, callback);
    }
    return callback;
  },
  // The closing array sits on its own line so this comment leads it directly: placed where the array itself
  // starts, the disable reaches the exact node the mutator rewrites, rather than trailing the return above it.
  // Stryker disable next-line ArrayDeclaration: not equivalent in syntax but unobservable here; every render passes the same number of elements, so React's per-index equality check compares them the same way regardless of what the array holds, and registerNode stays memoized forever either way.
  []);
  // A layout effect, so a placeholder past the limit is still, and one that breathes is on the wave, on its first frame.
  useLayoutEffect(() => {
    if (!shimmer) return;
    const place = breathing < breatheLimit;
    // Claiming a place is shared module state, so it can only be read once mounted.
    let delay: string | undefined;
    if (place) {
      const joined = joinWave(performance.now(), breathing, emptiedAt, waveStart);
      waveStart = joined.start;
      delay = joined.delay;
      startRef.current = joined.start;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClaim({ breathes: place, delay });
    breathing += place ? 1 : 0;
    return () => {
      breathing -= place ? 1 : 0;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: a later cleanup that finds none left sets it again, and a new wave starts only when none breathes, so setting it early changes nothing.
      if (breathing === 0) emptiedAt = performance.now();
    };
  }, [shimmer]);
  // The delay above is a clock read at commit time, written into a custom property before the first frame draws.
  // A CSS animation's own clock (its startTime) is pegged only once that frame actually draws, which, past a hold
  // of the main thread between the two, can land much later than the read the delay came from — so the animation
  // starts that much out of step with the rest of the wave. Once a frame finally draws, read the join fresh and
  // set each animation's own clock to it directly, so the join no longer depends on when that frame lands.
  useLayoutEffect(() => {
    // Stryker disable next-line ConditionalExpression,LogicalOperator: whichever side is true, this placeholder
    // has no CSS animation at all yet (still, or not yet past its first frame), so the loop below finds none and
    // removing the guard changes nothing observable.
    if (!shimmer || claim.delay === undefined || startRef.current === undefined) return;
    const start = startRef.current;
    const staleDelayMs = Number.parseFloat(claim.delay);
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      // Stryker disable next-line ConditionalExpression: cancelAnimationFrame below always runs before a
      // cancelled frame could fire, so this callback never actually observes cancelled true.
      /* istanbul ignore next @preserve -- cancelAnimationFrame below always runs before a cancelled frame could
         fire, so this callback never actually observes cancelled true; the guard only protects a browser race
         no test can force. */
      if (cancelled) return;
      // Reusing joinWave with a nonzero `breathing` always takes its `waveStart` argument as the wave's start,
      // so this reads the same join fresh, from this placeholder's own start, without touching the shared module
      // state a placeholder mounting or unmounting elsewhere since may have moved on.
      const freshDelayMs = Number.parseFloat(joinWave(performance.now(), 1, 0, start).delay);
      const correction = staleDelayMs - freshDelayMs;
      for (const node of nodesRef.current.values()) {
        // jsdom, where apps often run their component tests, has no getAnimations: there is no wave to correct.
        for (const animation of node.getAnimations?.({ subtree: true }) ?? []) {
          // Stryker disable next-line ConditionalExpression,LogicalOperator: registerNode only ever sees this
          // component's own Bar elements, which carry no animation but the breathe one it applies itself.
          /* istanbul ignore next @preserve -- registerNode only ever sees this component's own Bar elements,
             which carry no animation but the breathe one this component applies itself, so the non-matching
             branch never runs. */
          if (animation instanceof CSSAnimation && animation.animationName === breatheAnimationName) animation.currentTime = correction;
        }
      }
    });
    return () => {
      // Stryker disable next-line BooleanLiteral: only read by the cancelled check above, itself disabled as unreachable.
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [shimmer, claim.delay]);
  return {
    breathes: shimmer && claim.breathes,
    // Stryker disable next-line ConditionalExpression: a style object whose only value is undefined draws the same as none.
    style: claim.delay === undefined ? undefined : ({ "--ouro-skeleton-delay": claim.delay } as CSSProperties),
    registerNode,
  };
}

const shapes = {
  rect: "h-ouro-4 w-full rounded-ouro-md",
  circle: "aspect-square rounded-full",
} as const;

const avatarSizes = { xs: "w-ouro-6", sm: "w-ouro-8", md: "w-ouro-10", lg: "w-ouro-12", xl: "w-ouro-16", "2xl": "w-ouro-18", "3xl": "w-ouro-28" } as const;
const textSizes = { sm: "text-sm", md: "text-base", lg: "text-lg" } as const;

// A line is one line box of its text (`1lh`), with a bar the height of the letters in the middle,
// so the text that replaces it takes the same space.
const line = "flex h-[1lh] items-center";
const bar = "h-[0.75em] rounded-ouro-sm";

// Item's row (item.tsx): a 40px media lined up with the title, a medium title and a small description.
const rowSizes = { md: "py-3", sm: "py-2" } as const;
// Card's outline frame (card.tsx): its gap, padding and the heading's size.
const cardSizes = {
  md: { root: "gap-6 py-6", pad: "px-6", title: "text-lg" },
  sm: { root: "gap-4 py-4", pad: "px-4", title: "text-base" },
} as const;

// Widths that vary from row to row, the same on the server and in the browser.
const titleWidths = ["w-2/3", "w-1/2", "w-3/4", "w-1/3", "w-1/2"] as const;
const detailWidths = ["w-full", "w-3/4", "w-full", "w-2/3", "w-3/4"] as const;

type Shape = "rect" | "text" | "circle" | "row" | "card";
const sizesFor = { rect: {}, text: textSizes, circle: avatarSizes, row: rowSizes, card: cardSizes } as const;
const shapeNames = Object.keys(sizesFor);

const muiVariants: Readonly<Record<string, Shape>> = { circular: "circle", text: "text", rectangular: "rect", rounded: "rect" };

function skeletonHint(token: string): string {
  if (token.startsWith("rounded")) return token === "rounded-full" ? 'shape="circle"' : 'shape="rect"';
  return "remove it; Skeleton takes its color from the theme's --muted";
}

/** The class for a guessed `width` or `height` value, for a development message. */
function sizeClass(prefix: "w" | "h", value: unknown): string {
  return `${prefix}-[${typeof value === "number" ? `${value}px` : String(value)}]`;
}

/** A whole number of at least one, or one. */
function atLeastOne(value: number | undefined): number {
  return Math.max(1, Number.isInteger(value) ? (value as number) : 1);
}

function Bar({ className, shimmer }: { className: string | undefined; shimmer: boolean }): JSX.Element {
  return <span className={cn(fill, !shimmer && still, bar, className)} />;
}

/**
 * A placeholder that breathes after a second in the shape and size of content that is still loading, so the
 * content takes its place without moving anything. Screen readers skip it, so mark the region
 * that is loading with `aria-busy` while it shows. Placeholders on the page breathe in the same step, so one that
 * mounts or remounts later joins the others mid-breath instead of starting over. With reduced motion, or
 * `shimmer={false}`, it holds still.
 *
 * Pick the shape of what is coming: `shape="text"` with `lines` and Text's `size` for a
 * paragraph, `shape="circle"` with Avatar's `size` for an avatar, `shape="row"` with `count`
 * for a list of Items, `shape="card"` for Cards, and `rect` sized with a layout class for an
 * image or a chart. A placeholder stands in for content; a spinner does not, so an app shows
 * a Skeleton wherever content loads.
 *
 * Use `Button`'s `loading` instead for an action in progress, and `Progress` when you know how
 * far along the work is.
 *
 * @group Display
 * @see https://ui.ouroboros.bot/docs/skeleton
 *
 * @example
 * <>
 *   <div aria-busy="true" aria-label="Messages" role="group">
 *     <Skeleton shape="row" count={6} />
 *   </div>
 *   <Skeleton shape="text" size="sm" lines={3} />
 *   <Skeleton shape="circle" size="lg" />
 * </>
 */
export function Skeleton(props: SkeletonProps): JSX.Element {
  const { shape: shapeProp = "rect", size: sizeProp, lines: linesProp, count: countProp, className, shimmer: shimmerProp = true, variant, animation, width, height, ref, ...rest } =
    props as SkeletonCommonProps &
      Omit<HTMLAttributes<HTMLSpanElement>, "children"> & { shape?: string; size?: string; lines?: number; count?: number };
  const { breathes: shimmer, style: waveStyle, registerNode } = useBreathes(shimmerProp);
  const mergedRef = useMergedRef(ref, registerNode(0));
  // A shape that is not one of Ouro UI's (a type error) warns and renders the default.
  const shape: Shape = shapeNames.includes(shapeProp) ? (shapeProp as Shape) : "rect";
  const sizes: object = sizesFor[shape];
  const sizeKnown = sizeProp === undefined || Object.hasOwn(sizes, sizeProp);
  const size = sizeKnown ? sizeProp : undefined;
  useAppearanceClassNameCheck(
    "Skeleton",
    className,
    process.env.NODE_ENV !== "production" ? skeletonHint : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Skeleton",
    process.env.NODE_ENV !== "production"
      ? () => [
          shape !== shapeProp && [
            `shape="${shapeProp}" is not a shape; use "rect", "text", "circle", "row", "card"`,
            shapeProp === "avatar"
              ? `<Skeleton shape="circle"${Object.hasOwn(avatarSizes, String(sizeProp)) ? ` size="${sizeProp}"` : ""}>`
              : '<Skeleton shape="rect">',
          ],
          // A size for a shape that isn't one says nothing more: the shape's fix comes first.
          !sizeKnown &&
            shape === shapeProp && [
              `size="${String(sizeProp)}" is not a size for shape="${shape}"; use ${Object.keys(sizes).length ? Object.keys(sizes).map((name) => `"${name}"`).join(", ") : "a layout class"}`,
              Object.keys(sizes).length ? `<Skeleton shape="${shape}" size="${Object.keys(sizes)[0]}">` : '<Skeleton className="h-32">',
            ],
          variant !== undefined && [
            "variant is not a prop",
            `<Skeleton shape="${Object.hasOwn(muiVariants, String(variant)) ? muiVariants[String(variant)] : "rect"}">`,
          ],
          animation !== undefined && ["animation is not a prop; Skeleton breathes, and holds still with reduced motion", "<Skeleton>"],
          width !== undefined && ["width is not a prop", `<Skeleton className="${sizeClass("w", width)}">`],
          height !== undefined && ["height is not a prop", `<Skeleton className="${sizeClass("h", height)}">`],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const common = { "aria-hidden": true, "data-ouro": "skeleton", "data-shape": shape } as const;

  if (shape === "rect" || shape === "circle") {
    const shapeClass = shape === "circle" ? cn(shapes.circle, avatarSizes[(size ?? "md") as SkeletonAvatarSize]) : shapes.rect;
    return <span {...rest} {...common} ref={mergedRef} style={waveStyle ? { ...rest.style, ...waveStyle } : rest.style} className={cn(fill, !shimmer && still, shapeClass, className)} />;
  }
  if (shape === "text") {
    const lines = atLeastOne(linesProp);
    return (
      <span {...rest} {...common} ref={mergedRef} style={waveStyle ? { ...rest.style, ...waveStyle } : rest.style} className={cn("block w-full", size && textSizes[size as keyof typeof textSizes], className)}>
        {Array.from({ length: lines }, (_, index) => (
          <span key={index} className={line}>
            <Bar shimmer={shimmer} className={lines > 1 && index === lines - 1 ? "w-2/3" : "w-full"} />
          </span>
        ))}
      </span>
    );
  }
  const frame = (size ?? "md") as keyof typeof rowSizes;
  const count = atLeastOne(countProp);
  return (
    <>
      {Array.from({ length: count }, (_, index) => {
        const own = index === 0 ? { ...rest, ref: mergedRef } : { ...rest, id: undefined, ref: registerNode(index) };
        const title = titleWidths[index % titleWidths.length];
        const detail = detailWidths[index % detailWidths.length];
        if (shape === "row") {
          return (
            <span key={index} {...own} {...common} style={waveStyle ? { ...own.style, ...waveStyle } : own.style} className={cn("grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4", rowSizes[frame], className)}>
              <Bar shimmer={shimmer} className="mt-0.75 size-ouro-10 self-start rounded-ouro-md" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cn(line, "text-base")}>
                  <Bar shimmer={shimmer} className={title} />
                </span>
                <span className={cn(line, "text-sm")}>
                  <Bar shimmer={shimmer} className={detail} />
                </span>
              </span>
            </span>
          );
        }
        const card = cardSizes[frame];
        return (
          <span
            key={index}
            {...own}
            {...common}
            style={waveStyle ? { ...own.style, ...waveStyle } : own.style}
            className={cn("flex min-w-0 flex-col overflow-hidden rounded-ouro-xl border border-border bg-card", card.root, className)}
          >
            <span className={cn("flex min-w-0 flex-col gap-1", card.pad)}>
              <span className={cn(line, card.title)}>
                <Bar shimmer={shimmer} className={title} />
              </span>
              <span className={cn(line, "text-sm")}>
                <Bar shimmer={shimmer} className={detail} />
              </span>
            </span>
            <span className={cn("block min-w-0 text-sm", card.pad)}>
              <span className={line}>
                <Bar shimmer={shimmer} className="w-full" />
              </span>
              <span className={line}>
                <Bar shimmer={shimmer} className="w-2/3" />
              </span>
            </span>
          </span>
        );
      })}
    </>
  );
}
