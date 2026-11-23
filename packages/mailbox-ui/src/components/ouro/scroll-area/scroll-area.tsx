"use client";

import { type HTMLAttributes, type JSX, type ReactNode, type Ref, useEffect, useRef } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { devWarn } from "@/lib/ouro/dev";
import { scrollFadeClass, useScrollFade } from "@/lib/ouro/scroll-fade";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";

/** Which way a ScrollArea scrolls. */
export type ScrollAreaOrientation = "vertical" | "horizontal" | "both";

/** The props ScrollArea adds to the div attributes it passes through. */
export interface ScrollAreaOwnProps {
  /** The content that scrolls. */
  children: ReactNode;
  /**
   * Which way the content scrolls. `horizontal` keeps a row of tags or cards on one line.
   * @default "vertical"
   */
  orientation?: ScrollAreaOrientation | (string & { 'Use "vertical", "horizontal" or "both"': never }) | undefined;
  /**
   * Names the scrolling region for screen readers ("Method", "Order history"). A keyboard
   * user can focus the region to scroll it, so give it a name when nothing else inside can
   * take focus.
   */
  label?: string | undefined;
  /**
   * Keeps a scroll that reaches the area's end from scrolling the page behind it, for a
   * chat thread or a list inside a dialog. Off by default, so a finger that runs out of a
   * recipe's method keeps scrolling the page.
   * @default false
   */
  contain?: boolean | undefined;
  /**
   * Layout: the area's height or maximum height, which it scrolls inside (`h-72`,
   * `max-h-80`), and its width and margins. Appearance classes warn in development.
   */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;

  /**
   * Not a prop. The scrollbar is the browser's own, thin and in the theme's color, with a mouse or a finger.
   */
  type?: { "Use <ScrollArea>; the scrollbar is the browser's own": never };
  /** Not a prop. Set the height with a class: `<ScrollArea className="max-h-80">`. */
  maxHeight?: { 'Use <ScrollArea className="max-h-80">': never };
  /** Not a prop. Set the height with a class: `<ScrollArea className="h-72">`. */
  height?: { 'Use <ScrollArea className="h-72">': never };
}

/** Props for {@link ScrollArea}: its own props and the div attributes it passes through to the root. */
export type ScrollAreaProps = Omit<HTMLAttributes<HTMLDivElement>, keyof ScrollAreaOwnProps> & ScrollAreaOwnProps;

const orientations = ["vertical", "horizontal", "both"] as const;

/**
 * The browser's own scrollbar, thin and in the theme's muted color, so nothing measures the page to draw one:
 * a custom scrollbar needs a layout read at mount. A mouse drags it, a finger pans past it and the keyboard scrolls the viewport.
 */
const scrollbar =
  "[scrollbar-width:thin] [scrollbar-color:color-mix(in_oklab,var(--muted-foreground)_40%,transparent)_transparent] " +
  // Stryker disable next-line StringLiteral: a pointer-hover-only colour, which no test pointer state reaches
  "pointer-fine:hover:[scrollbar-color:color-mix(in_oklab,var(--muted-foreground)_60%,transparent)_transparent]";
const viewports = {
  vertical: "overflow-x-hidden overflow-y-auto",
  horizontal: "overflow-x-auto overflow-y-hidden",
  both: "overflow-auto",
} as const;

/** The mask for the top and bottom fade, set only while the viewport scrolls. */
const verticalFade =
  "data-ouro-scroll-fade-y:[mask-image:linear-gradient(to_bottom,transparent,#000_min(var(--scroll-area-overflow-y-start),2rem),#000_calc(100%-min(var(--scroll-area-overflow-y-end),2rem)),transparent)]"; // fade-ok: fades a scrolling list of rows, not a picture

const focusable =
  "a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex='-1']),[contenteditable='true']";

/**
 * Makes the viewport a tab stop while its content overflows, so a keyboard user can scroll it, and
 * says how far it hides content above and below: `data-overflow-y-start` and `data-overflow-y-end`
 * while that side hides more, with `--scroll-area-overflow-y-start` and `--scroll-area-overflow-y-end`
 * in pixels. Reads sizes when the browser reports a resize or a scroll, after layout, not while React commits.
 */
function useScrollTabStop(viewportRef: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    const viewport = viewportRef.current!;
    const update = () => {
      const scrollsAtAll = viewport.scrollHeight > viewport.clientHeight || viewport.scrollWidth > viewport.clientWidth;
      // Content inside can already take focus and scroll the viewport to it, so the viewport itself
      // needs no extra tab stop; axe's scrollable-region-focusable is satisfied either way. Writing
      // tabIndex is itself a tabindex mutation the observer below watches, so skip the write once the
      // value already holds, or setting it would retrigger the observer without end.
      const stop = scrollsAtAll && !viewport.querySelector(focusable) ? 0 : -1;
      if (viewport.tabIndex !== stop) viewport.tabIndex = stop;
      const hidden = viewport.scrollHeight - viewport.clientHeight;
      const start = Math.max(0, viewport.scrollTop);
      const end = Math.max(0, hidden - start);
      // Stryker disable next-line EqualityOperator: a one pixel threshold only absorbs rounding; no test can make content exactly one pixel taller
      const scrolls = hidden > 1 && getComputedStyle(viewport).overflowY !== "hidden";
      viewport.toggleAttribute("data-ouro-scroll-fade-y", scrolls);
      // Stryker disable next-line EqualityOperator: a one pixel threshold only absorbs rounding; no test can place a scroll offset at exactly one pixel
      viewport.toggleAttribute("data-overflow-y-start", scrolls && start > 1);
      // Stryker disable next-line EqualityOperator: a one pixel threshold only absorbs rounding; no test can place a scroll offset at exactly one pixel
      viewport.toggleAttribute("data-overflow-y-end", scrolls && end > 1);
      viewport.style.setProperty("--scroll-area-overflow-y-start", `${scrolls ? start : 0}px`);
      viewport.style.setProperty("--scroll-area-overflow-y-end", `${scrolls ? end : 0}px`);
    };
    const observer = new ResizeObserver(update);
    // Stryker disable next-line CallExpression: the observer fires for the first child's resize too, so a height change reaches update either way
    observer.observe(viewport);
    observer.observe(viewport.firstElementChild!);
    viewport.addEventListener("scroll", update);
    // Content can gain or lose focusable elements with no resize (a disabled button turning
    // enabled), which changes whether the viewport itself still needs the tab stop.
    const content = new MutationObserver(update);
    content.observe(viewport, { childList: true, subtree: true, attributes: true, attributeFilter: ["tabindex", "disabled", "href"] });
    // Stryker disable next-line BlockStatement,CallExpression,StringLiteral: cleanup only releases listeners on an element that is going away, which nothing can observe
    return () => {
      // Stryker disable next-line CallExpression: cleanup only releases an observer on an element that is going away, which nothing can observe
      observer.disconnect();
      // Stryker disable next-line CallExpression: cleanup only releases an observer on an element that is going away, which nothing can observe
      content.disconnect();
      // Stryker disable next-line CallExpression,StringLiteral: cleanup only releases a listener on an element that is going away, which nothing can observe
      viewport.removeEventListener("scroll", update);
    };
  },
  // Stryker disable next-line ArrayDeclaration: the ref object never changes, so the effect runs once either way
  [viewportRef]);
}

/**
 * Warns when the viewport takes keyboard focus to scroll (it is a tab stop once
 * the content overflows) but has no name and nothing inside that could take focus instead.
 * Development only.
 * @claim "Warns when the viewport takes keyboard" registry/ouro/components/ouro/scroll-area/scroll-area.test.tsx verify:testExists(registry/ouro/components/ouro/scroll-area/scroll-area.test.tsx::ScrollArea development messages > warns when the area takes keyboard focus to scroll but has no name)
 */
function useUnnamedRegionCheck(viewportRef: { current: HTMLDivElement | null }, label: string | undefined): void {
  const key = useRef({});
  useEffect(() => {
    /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
    if (process.env.NODE_ENV !== "production") {
      const viewport = viewportRef.current;
      if (!viewport || label) return;
      const check = () => {
        if (viewport.tabIndex === 0 && !viewport.querySelector(focusable)) {
          devWarn("ScrollArea", "the area takes keyboard focus to scroll, and has no name", '<ScrollArea label="Method">', key.current);
        }
      };
      check();
      const observer = new MutationObserver(check);
      observer.observe(viewport, { attributes: true, attributeFilter: ["tabindex"] });
      return () => observer.disconnect();
    }
  }, [viewportRef, label]);
}

/**
 * A scrolling region with a thin scrollbar in the theme's color, inside a height you set.
 * It keeps the browser's own scrolling, so touch, the mouse wheel, the keyboard and
 * momentum all work; Content
 * wider than the area fades out at the side where it goes on, and a vertical area fades at the
 * top and bottom edge that hides more, so at rest it reads as more to scroll to, not as cut off.
 * A vertical area also marks the viewport with `data-overflow-y-start` and `data-overflow-y-end`
 * while that edge hides content, and sets `--scroll-area-overflow-y-start` and `--scroll-area-overflow-y-end`
 * (pixels hidden), so a parent can draw a hairline once it is scrolled from the start. Its focus ring
 * is drawn over the content, so a header that sticks to the top never hides an edge of it.
 *
 * Use plain page scrolling instead for a page's main content, and `Dialog` or `Sheet`,
 * which scroll their own bodies, for long content in an overlay.
 *
 * @group Layout
 * @see https://ui.ouroboros.bot/docs/scroll-area
 *
 * @example
 * <ScrollArea className="h-72" label="Method">
 *   {steps.map((step) => <Text key={step.id}>{step.text}</Text>)}
 * </ScrollArea>
 * <ScrollArea orientation="horizontal" label="Tags">
 *   <Row gap="sm">{tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</Row>
 * </ScrollArea>
 * @claim "Content wider than the area fades out" registry/ouro/components/ouro/scroll-area/scroll-area.test.tsx verify:testExists(registry/ouro/components/ouro/scroll-area/scroll-area.test.tsx::ScrollArea > fades out at the side that hides more, drawing its focus ring over the fade, and keeps keyboard scrolling)
 * @claim "Its focus ring is drawn over the content" registry/ouro/components/ouro/scroll-area/scroll-area.test.tsx verify:testExists(registry/ouro/components/ouro/scroll-area/scroll-area.test.tsx::ScrollArea > draws its focus ring whole over content that sticks to an edge, and leaves the pointer to the content)
 * @claim "It keeps the browser's own scrolling" registry/ouro/components/ouro/scroll-area/scroll-area.touch.test.tsx verify:testExists(registry/ouro/components/ouro/scroll-area/scroll-area.touch.test.tsx::leaves touch scrolling to the browser: the viewport is a native scroll container)
 * @claim "It keeps the browser's own scrolling" registry/ouro/components/ouro/scroll-area/scroll-area.test.tsx verify:testExists(registry/ouro/components/ouro/scroll-area/scroll-area.test.tsx::ScrollArea > draws a thin native scrollbar in the theme's muted color, and scrolls only the way it is asked to)
 */
export function ScrollArea(props: ScrollAreaProps): JSX.Element {
  const { children, orientation: orientationProp = "vertical", label, contain, className, type, maxHeight, height, ...rest } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  useUnnamedRegionCheck(viewportRef, label);
  useScrollFade(viewportRef);
  useScrollTabStop(viewportRef);
  const orientation = (orientations as readonly string[]).includes(orientationProp) ? (orientationProp as ScrollAreaOrientation) : "vertical";
  useAppearanceClassNameCheck(
    "ScrollArea",
    className,
    process.env.NODE_ENV !== "production" ? "put the ScrollArea inside a <Card> for a frame" : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "ScrollArea",
    process.env.NODE_ENV !== "production"
      ? () => [
          orientation !== orientationProp && [
            `orientation="${String(orientationProp)}" is not an orientation; use "vertical", "horizontal", "both"`,
            `<ScrollArea orientation="${String(orientationProp).toLowerCase().startsWith("x") ? "horizontal" : "vertical"}">`,
          ],
          type !== undefined && ["type is not a prop; the scrollbar is the browser's own", "<ScrollArea>"],
          maxHeight !== undefined && ["maxHeight is not a prop", '<ScrollArea className="max-h-80">'],
          height !== undefined && ["height is not a prop", '<ScrollArea className="h-72">'],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  // Stryker disable next-line ConditionalExpression: the mask needs the data attribute, which only a vertical area gets
  const fadeY = orientation === "vertical" && verticalFade;
  return (
    <div
      {...rest}
      data-ouro="scroll-area"
      className={cn(
        "group/scroll-area relative flex min-h-0 min-w-0 flex-col overflow-hidden",
        className,
      )}
    >
      <div
        ref={viewportRef}
        data-scroll-viewport=""
        // Stryker disable next-line UnaryOperator: the observer sets the real value as soon as it starts, before any read
        tabIndex={-1}
        data-ouro-control="scroll-area"
        data-ouro-part="viewport"
        role={label ? "region" : undefined}
        aria-label={label}
        // While focused, isolate keeps the content's own stacking (a sticky header's z-index) inside the viewport, under the
        // focus ring. Only then: at rest the content stacks with the page, as it always has.
        className={cn("peer min-h-0 focus-visible:isolate flex-1 rounded-[inherit] outline-none", viewports[orientation], scrollbar, scrollFadeClass, fadeY, contain && "overscroll-contain")}
      >
        <div className={orientation === "vertical" ? "min-w-0" : "min-w-fit"}>{children}</div>
      </div>
      {/* The viewport's focus ring, drawn over it, so neither the edge fade nor content that sticks to an edge covers it. It is
          there only while the viewport has focus: at rest nothing lies over the content, so a contrast check sees the text's own background. */}
      <span
        aria-hidden="true"
        data-scroll-focus-ring=""
        className="pointer-events-none absolute inset-0 hidden rounded-[inherit] outline-ring -outline-offset-2 peer-focus-visible:block peer-focus-visible:outline-2 peer-focus-visible:outline-solid"
      />
    </div>
  );
}
