"use client";

import { Drawer } from "@base-ui/react/drawer";
import { createContext, useCallback, useContext, type JSX, type Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { devThrow } from "@/lib/ouro/dev";
import { useMergedRef } from "@/lib/ouro/refs";
import { useBackdropAnchor } from "@/lib/ouro/use-backdrop-anchor";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { useKeyboardScrollable } from "@/lib/ouro/use-keyboard-scrollable";
import { holdPageAtPress } from "@/lib/ouro/page-scroll-hold";
import { PortalScope } from "@/lib/ouro/portal-container";
import {
  iosBackdrop,
  registerSheetProperties,
  sheetHint,
  sheetSides,
  sideWarning,
  type SheetSide,
} from "@/components/ouro/sheet/sheet-styles";

export type { SheetSide } from "@/components/ouro/sheet/sheet-styles";

/**
 * A snap point for a bottom or top sheet: a fraction of the viewport height
 * (`0.5`), or a height in `px` or `rem` (`"320px"`, `"20rem"`).
 */
export type SheetSnapPoint = number | `${number}px` | `${number}rem`;

interface SheetContextValue {
  side: SheetSide;
  snap: boolean;
  /** Whether the sheet shuts off the page; a non-modal one lets presses through around it. */
  modal: boolean;
}

const SheetContext = createContext<SheetContextValue | null>(null);

const swipeDirections = { bottom: "down", top: "up", left: "left", right: "right" } as const;

/*
 * Styles: Base UI Drawer, tuned through its CSS variables (spec section 7).
 *
 * - Base UI moves the popup with --drawer-swipe-movement-x/y and places snap points
 *   with --drawer-snap-point-offset. Past the open edge it damps the pull to the
 *   square root of the distance (s = √d for a pull of d). The sheet lifts
 *   k·(s − k/4) with k = --ouro-sheet-stretch, which is never more than the pull:
 *   d − k·(s − k/4) = (s − k/2)² ≥ 0. An 80px pull lifts it about 28px, like
 *   RedwoodUI. A bleed (::after) in the sheet's color extends past the edge, so the
 *   lift reads as stretching.
 * - Base UI measures a drag from where the sheet is when the finger takes it, which is
 *   off its rest position while it is opening or on its way back from an earlier drag.
 *   --ouro-sheet-grab holds that distance for as long as the drag lasts (useGrabOffset),
 *   so the sheet stays under the finger and does not jump to rest. It is added after the
 *   stretch, which applies to the finger's movement alone.
 * - The drag rewrites these variables on the popup every frame. They are registered as
 *   not inherited (registerSheetProperties, as Base UI does for its own), so the popup's
 *   content is not restyled for it.
 * - The backdrop fades with --drawer-swipe-progress, up to --ouro-backdrop-max.
 * - Release and entry take --ouro-duration-sheet on the drawer curve; a flick's release is
 *   scaled by --drawer-swipe-strength (0.1 to 1).
 * - Reduced motion drops transform transitions and keeps an opacity fade.
 *
 * Class strings are literal so the app's Tailwind finds them when it compiles.
 */

registerSheetProperties();

const backdropClass =
  "fixed inset-0 z-1000 min-h-dvh bg-(--ouro-backdrop-color) " +
  "opacity-[calc(var(--ouro-backdrop-max)*(1-var(--drawer-swipe-progress,0)))] " +
  "[transition:opacity_var(--ouro-duration-sheet)_var(--ouro-ease-drawer)] " +
  "data-starting-style:opacity-0 data-ending-style:opacity-0 " +
  "data-ending-style:duration-(--ouro-duration-slow) data-ending-style:ease-(--ouro-ease-out) data-swiping:duration-0 " +
  // A flick sends the sheet away in about 100ms. Base UI pins the backdrop's
  // --drawer-swipe-strength at 1, but marks it data-swipe-dismiss, so fade it as fast.
  "data-swipe-dismiss:data-ending-style:duration-(--ouro-duration-fast) " +
  iosBackdrop;

const viewportClasses = {
  bottom: "items-end justify-center",
  top: "items-start justify-center",
  left: "[justify-content:left]",
  right: "[justify-content:right]",
} as const;

const popupBase =
  "[--ouro-sheet-stretch:3.5] [--ouro-sheet-slack:calc(var(--ouro-sheet-stretch)*0.25px)] [--ouro-sheet-gap:2rem] " +
  "relative box-border flex min-h-0 flex-col outline-none touch-none " +
  "bg-popover text-popover-foreground [-webkit-tap-highlight-color:transparent] " +
  "[transition:transform_calc(var(--ouro-duration-sheet)*var(--drawer-swipe-strength,1))_var(--ouro-ease-drawer)] " +
  "will-change-transform [transform:var(--ouro-sheet-transform)] data-swiping:select-none " +
  // While a finger is down, Base UI also writes the raw damped offset as an inline
  // transform. The stretched transform has to win over it, so it is important here.
  "data-swiping:[transform:var(--ouro-sheet-transform)]! " +
  // Where the finger took the sheet counts only while it holds it: a release settles from
  // there to rest. Important, to win over the value useGrabOffset leaves on the element.
  "not-data-swiping:[--ouro-sheet-grab:0px]! " +
  // The bleed: the sheet's color past its edge, so pulling it inward looks like stretching.
  "after:pointer-events-none after:absolute after:bg-inherit " +
  // Reduced motion: fade in place.
  "motion-reduce:[transition:transform_0s,opacity_var(--ouro-duration-base)_var(--ouro-ease-out)] " +
  "motion-reduce:data-starting-style:[transform:var(--ouro-sheet-transform)] motion-reduce:data-starting-style:opacity-0 " +
  "motion-reduce:data-ending-style:[transform:var(--ouro-sheet-transform)] motion-reduce:data-ending-style:opacity-0";

// Bottom (the default) and top: full width up to 40rem, fitting content up to the viewport less a gap.
const popupSides = {
  bottom:
    "w-full max-w-[40rem] max-h-[calc(100dvh-var(--ouro-sheet-gap))] ps-[env(safe-area-inset-left,0px)] pe-[env(safe-area-inset-right,0px)] " +
    "[--ouro-sheet-y:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px))] " +
    "[--ouro-sheet-transform:translateY(calc(max(var(--ouro-sheet-y),0px)+min(var(--ouro-sheet-y)+var(--ouro-sheet-slack),0px)*var(--ouro-sheet-stretch)+var(--ouro-sheet-grab,0px)))] " +
    "rounded-t-xl [box-shadow:var(--ouro-shadow-sheet-bottom)] " +
    "after:inset-x-0 after:top-[calc(100%-1px)] after:h-[50dvh] " +
    "data-starting-style:[transform:translateY(calc(100%+2px))] data-ending-style:[transform:translateY(calc(100%+2px))]",
  top:
    "w-full max-w-[40rem] max-h-[calc(100dvh-var(--ouro-sheet-gap))] ps-[env(safe-area-inset-left,0px)] pe-[env(safe-area-inset-right,0px)] " +
    "[--ouro-sheet-y:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px))] " +
    "[--ouro-sheet-transform:translateY(calc(min(var(--ouro-sheet-y),0px)+max(var(--ouro-sheet-y)-var(--ouro-sheet-slack),0px)*var(--ouro-sheet-stretch)+var(--ouro-sheet-grab,0px)))] " +
    "rounded-b-xl [box-shadow:var(--ouro-shadow-sheet-top)] " +
    "pt-[env(safe-area-inset-top,0px)] " +
    "after:inset-x-0 after:bottom-[calc(100%-1px)] after:h-[50dvh] " +
    "data-starting-style:[transform:translateY(calc(-100%-2px))] data-ending-style:[transform:translateY(calc(-100%-2px))]",
  // Left and right: full height, up to 22rem wide, always leaving a strip of the page visible.
  left:
    "h-full w-[min(22rem,calc(100vw-3rem))] pt-[env(safe-area-inset-top,0px)] " +
    "pb-[calc(env(safe-area-inset-bottom,0px)+var(--drawer-keyboard-inset,0px))] " +
    "[--ouro-sheet-x:var(--drawer-swipe-movement-x,0px)] " +
    "[--ouro-sheet-transform:translateX(calc(min(var(--ouro-sheet-x),0px)+max(var(--ouro-sheet-x)-var(--ouro-sheet-slack),0px)*var(--ouro-sheet-stretch)+var(--ouro-sheet-grab,0px)))] " +
    "rounded-r-xl [box-shadow:var(--ouro-shadow-sheet-left)] pl-[env(safe-area-inset-left,0px)] " +
    "after:inset-y-0 after:right-[calc(100%-1px)] after:w-[50vw] " +
    "data-starting-style:[transform:translateX(calc(-100%-2px))] data-ending-style:[transform:translateX(calc(-100%-2px))]",
  right:
    "h-full w-[min(22rem,calc(100vw-3rem))] pt-[env(safe-area-inset-top,0px)] " +
    "pb-[calc(env(safe-area-inset-bottom,0px)+var(--drawer-keyboard-inset,0px))] " +
    "[--ouro-sheet-x:var(--drawer-swipe-movement-x,0px)] " +
    "[--ouro-sheet-transform:translateX(calc(max(var(--ouro-sheet-x),0px)+min(var(--ouro-sheet-x)+var(--ouro-sheet-slack),0px)*var(--ouro-sheet-stretch)+var(--ouro-sheet-grab,0px)))] " +
    "rounded-l-xl [box-shadow:var(--ouro-shadow-sheet-right)] pr-[env(safe-area-inset-right,0px)] " +
    "after:inset-y-0 after:left-[calc(100%-1px)] after:w-[50vw] " +
    "data-starting-style:[transform:translateX(calc(100%+2px))] data-ending-style:[transform:translateX(calc(100%+2px))]",
} as const;

/**
 * A bottom sheet's padding keeps its body above the home indicator and the software
 * keyboard. At a lower snap point part of the sheet sits below the screen, so it is
 * padded by that much more and the body ends on screen. The padding follows the snap
 * point, not the finger: it changes when the sheet lands on another point, never on the
 * frames of a drag.
 * @claim "The padding follows the snap point" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::feel > pads a sheet at a lower snap point by the part below the screen, and holds that padding through a drag)
 * @claim "The padding follows the snap point" registry/ouro/components/ouro/sheet/sheet.touch.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.touch.test.tsx::Sheet on a phone > stays under the finger when a sheet with snap points is caught on its way back to one)
 */
const bottomPadding = {
  fit: "pb-[calc(env(safe-area-inset-bottom,0px)+var(--drawer-keyboard-inset,0px))]",
  snap: "h-[calc(100dvh-var(--ouro-sheet-gap))] pb-[calc(env(safe-area-inset-bottom,0px)+var(--drawer-keyboard-inset,0px)+max(0px,var(--drawer-snap-point-offset,0px)))]",
} as const;

/** The JSX that puts a part in its place, for the dev message when it is not. */
function shape(inner: string): string {
  return `<SheetRoot><SheetTrigger render={<Button>Open</Button>} /><SheetPortal><SheetBackdrop /><SheetViewport><SheetPopup>${inner}</SheetPopup></SheetViewport></SheetPortal></SheetRoot>`;
}

/** Reads the sheet context, or throws in development with the JSX the part belongs in. */
function useSheetPart(part: string, inner: string): SheetContextValue {
  const context = useContext(SheetContext);
  if (!context) {
    devThrow(
      part,
      "must be rendered inside <SheetRoot>",
      process.env.NODE_ENV !== "production" ? shape(inner) : /* istanbul ignore next @preserve -- production only */ "",
    );
  }
  return context;
}

/**
 * Props for {@link SheetRoot}: Base UI `Drawer.Root` props with `side` in place of `swipeDirection`.
 * `modal={false}` leaves the page in use beside the sheet: no focus trap and no scroll lock, presses
 * reach the page around the sheet, and a press or focus outside leaves it open (unless you pass
 * `disablePointerDismissal={false}`). Leave out `SheetBackdrop` with it.
 * @claim "leaves the page in use" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > built from parts, stays open on a press on the page, unless the app passes disablePointerDismissal={false})
 */
export type SheetRootProps = Omit<Drawer.Root.Props, "swipeDirection" | "snapPoints"> & {
  /** The edge the sheet slides in from. @default "bottom" */
  side?: SheetSide | (string & { 'Use "bottom", "top", "left" or "right"': never }) | undefined;
  /** Snap points for a bottom or top sheet. Without them the sheet fits its content. */
  snapPoints?: SheetSnapPoint[] | undefined;
};

/**
 * Part: the state owner of a sheet built from parts. Use the `Sheet` component
 * instead unless its props cannot express your layout.
 *
 * @example
 * <SheetRoot side="bottom">
 *   <SheetTrigger render={<Button>Open</Button>} />
 *   <SheetPortal>
 *     <SheetBackdrop />
 *     <SheetViewport>
 *       <SheetPopup>
 *         <SheetHandle />
 *         <SheetTitle>Filters</SheetTitle>
 *         <SheetContent>…</SheetContent>
 *       </SheetPopup>
 *     </SheetViewport>
 *   </SheetPortal>
 * </SheetRoot>
 */
export function SheetRoot({ side: sideProp = "bottom", snapPoints, ...props }: SheetRootProps): JSX.Element {
  const modal = props.modal !== false;
  // A side that is not one of Ouro UI's (a type error) warns and renders a bottom sheet.
  const side = sheetSides.includes(sideProp as SheetSide) ? (sideProp as SheetSide) : "bottom";
  useDevWarnings(
    "SheetRoot",
    process.env.NODE_ENV !== "production"
      ? () => [side !== sideProp && sideWarning(String(sideProp), "<SheetRoot side=\"bottom\">")]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const snap = Boolean(snapPoints && snapPoints.length > 0);
  return (
    <SheetContext.Provider value={{ side, snap, modal }}>
      <Drawer.Root
        {...props}
        disablePointerDismissal={props.disablePointerDismissal ?? !modal}
        {...(snapPoints ? { snapPoints } : {})}
        swipeDirection={swipeDirections[side]}
      />
    </SheetContext.Provider>
  );
}

/** Part: the button that opens the sheet. Pass your button as `render={<Button>Open</Button>}`. */
export function SheetTrigger({ onPointerDown, onKeyDown, ...props }: Drawer.Trigger.Props): JSX.Element {
  useSheetPart("SheetTrigger", "…");
  return (
    <Drawer.Trigger
      {...(props.render === undefined ? { className: "forced-colors:border forced-colors:border-solid", "data-ouro-control": "sheet", "data-ouro-part": "trigger" } : {})}
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        holdPageAtPress.dialog.onPointerDown(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        holdPageAtPress.dialog.onKeyDown(event);
      }}
    />
  );
}

/**
 * Part: moves the sheet to the end of `<body>` and makes it aware of the
 * software keyboard (`Drawer.VirtualKeyboardProvider`), so focused inputs stay visible.
 * The portal is its own stacking context at the `--ouro-layer` z-index (50 by default,
 * from ouro-base.css). If your app has fixed bars above z-50, raise it in a `:root`
 * rule of your own after the Ouro tokens, outside any `@layer`: `:root { --ouro-layer: 60; }`.
 * Don't edit the line shadcn wrote; `shadcn add` resets it.
 * @claim "The portal is its own stacking" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet stacking above the app's fixed bars > puts the portal on the --ouro-layer level, as its own stacking context)
 * @claim "The portal is its own stacking" registry/ouro/theme/ouro-base.css verify:fileLine(registry/ouro/theme/ouro-base.css, /^\s+--ouro-layer:\s50;/)
 */
export function SheetPortal(props: Omit<Drawer.Portal.Props, "className">): JSX.Element {
  useSheetPart("SheetPortal", "…");
  return (
    <Drawer.VirtualKeyboardProvider>
      {/* The keyboard's inset, 0px until Base UI sets it on the viewport inside: set there as each sheet opens, it
          changed what the whole sheet inherits and restyled all of it once more in the middle of the press. Under a
          0px of the same name it changes nothing until a keyboard shows. */}
      <Drawer.Portal {...props} data-ouro="sheet-portal" className="relative isolate z-(--ouro-layer) [--drawer-keyboard-inset:0px]">
        <PortalScope>{props.children}</PortalScope>
      </Drawer.Portal>
    </Drawer.VirtualKeyboardProvider>
  );
}

/**
 * Part: the dimming layer. It lightens as the sheet is dragged away. On iOS it
 * stays anchored to the top of the screen on a scrolled page. A `ref` reaches
 * the backdrop element.
 */
export function SheetBackdrop({
  ref,
  ...props
}: Omit<Drawer.Backdrop.Props, "className"> & { ref?: Ref<HTMLDivElement> | undefined }): JSX.Element {
  useSheetPart("SheetBackdrop", "…");
  const anchorRef = useBackdropAnchor(ref);
  return <Drawer.Backdrop {...props} ref={anchorRef} data-ouro="sheet-backdrop" className={backdropClass} />;
}

/**
 * Keeps a sheet under the finger that catches it while it is still moving. On each event
 * that can begin a drag, until Base UI has begun one, it writes how far the sheet is from
 * rest to `--ouro-sheet-grab` on the popup: that is where Base UI starts the drag from.
 * The listeners are on the window, on the way down, because Base UI begins a touch drag
 * from a listener on the document that stops the event there.
 * @claim "On each event that can begin" registry/ouro/components/ouro/sheet/sheet.touch.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.touch.test.tsx::Sheet on a phone > stays under a finger that catches it by its scrolling body, where the drag starts with the first move)
 * @claim "On each event that can begin" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::feel > keeps the variables a drag rewrites out of the sheet's content)
 */
function useGrabOffset(side: SheetSide): (viewport: HTMLDivElement) => () => void {
  return useCallback(
    (viewport) => {
      const horizontal = side === "left" || side === "right";
      // Whether the press may still need measuring: it is inside the viewport, Base UI has not begun a drag, and the sheet is moving.
      let watching = false;
      /** Writes how far the sheet is from rest. Returns whether to measure again on the next move. */
      const measure = () => {
        const popup = viewport.querySelector<HTMLElement>('[data-ouro="sheet"]');
        // Base UI turns the popup's transition off for as long as it drags it: the drag has begun.
        if (!popup || popup.style.transitionProperty === "none") return false;
        const style = getComputedStyle(popup);
        const live = new DOMMatrixReadOnly(style.transform);
        const rest = horizontal ? 0 : parseFloat(style.getPropertyValue("--drawer-snap-point-offset"));
        popup.style.setProperty("--ouro-sheet-grab", `${(horizontal ? live.m41 : live.m42) - rest}px`);
        // A sheet that stands still is where this measured it for the rest of the press, so a
        // mouse that drags a slider or selects text inside it reads no style on its moves.
        return popup.getAnimations().length > 0;
      };
      const onDown = (event: PointerEvent) => {
        watching = viewport.contains(event.target as Node) && measure();
      };
      const onMove = () => {
        if (watching) watching = measure();
      };
      const onEnd = () => {
        watching = false;
      };
      addEventListener("pointerdown", onDown, true);
      addEventListener("pointermove", onMove, true);
      addEventListener("pointerup", onEnd, true);
      addEventListener("pointercancel", onEnd, true);
      return () => {
        removeEventListener("pointerdown", onDown, true);
        removeEventListener("pointermove", onMove, true);
        removeEventListener("pointerup", onEnd, true);
        removeEventListener("pointercancel", onEnd, true);
      };
    },
    [side],
  );
}

/** Part: the full-screen layer that positions the popup against its edge. A `ref` reaches the viewport element. */
export function SheetViewport({
  ref,
  ...props
}: Omit<Drawer.Viewport.Props, "className"> & { ref?: Ref<HTMLDivElement> | undefined }): JSX.Element {
  const { side, modal } = useSheetPart("SheetViewport", "…");
  const viewportRef = useMergedRef(ref, useGrabOffset(side));
  return (
    <Drawer.Viewport
      {...props}
      ref={viewportRef}
      data-ouro="sheet-viewport"
      data-side={side}
      // `overflow-clip`, not `overflow-hidden`: a hidden box is still a scroll container, so
      // scrolling a control into view while the sheet enters would scroll the viewport and
      // leave the sheet floating above its edge.
      // A non-modal sheet's viewport lets presses through to the page around the sheet.
      className={cn("fixed inset-0 z-1000 flex overflow-clip touch-none", !modal && "pointer-events-none", viewportClasses[side])}
    />
  );
}

/** Props for {@link SheetPopup}. `className` is for layout only (width, margins). */
export type SheetPopupProps = Omit<Drawer.Popup.Props, "className"> & { className?: string | undefined };

/** Part: the sheet panel. It stretches past its edge when pulled and springs back on release. */
export function SheetPopup(props: SheetPopupProps): JSX.Element {
  useAppearanceClassNameCheck(
    "SheetPopup",
    props.className,
    process.env.NODE_ENV !== "production"
      ? sheetHint("<SheetPopup>", "</SheetPopup>")
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  return <SheetPopupUnchecked {...props} />;
}

/**
 * The popup without its own className check, for `Sheet`, which checks its own `className`.
 *
 * @internal
 */
export function SheetPopupUnchecked({ className, ...props }: SheetPopupProps): JSX.Element {
  const { side, snap, modal } = useSheetPart("SheetPopup", "…");
  return (
    <Drawer.Popup
      {...props}
      className={cn(
        popupBase,
        popupSides[side],
        side === "bottom" && bottomPadding[snap ? "snap" : "fit"],
        side === "top" && snap && "h-[calc(100dvh-var(--ouro-sheet-gap))]",
        !modal && "pointer-events-auto",
        className,
      )}
      aria-modal={modal ? "true" : undefined}
      data-ouro="sheet"
      data-side={side}
      data-snap-points={snap ? "" : undefined}
      data-modal={modal ? undefined : "false"}
    />
  );
}

/** Part: the grab handle at the free edge of a bottom or top sheet. Decorative; renders nothing on side sheets. */
export function SheetHandle(): JSX.Element | null {
  const { side } = useSheetPart("SheetHandle", "<SheetHandle />…");
  if (side === "left" || side === "right") return null;
  return (
    <div
      aria-hidden="true"
      data-ouro-sheet-handle=""
      className="flex shrink-0 justify-center py-2 touch-none"
    >
      <div className="h-1.25 w-9 rounded-full bg-border" />
    </div>
  );
}

/** Props for {@link SheetTitle}. */
export type SheetTitleProps = Omit<Drawer.Title.Props, "className"> & {
  /** Hides the title visually; it still names the dialog for screen readers. */
  visuallyHidden?: boolean | undefined;
};

/**
 * Part: the sheet's title, which names the dialog. Every sheet needs one.
 *
 * @claim "Every sheet needs one" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:fileLine(registry/ouro/components/ouro/sheet/sheet.test.tsx, /warns\swhen\sthe\stitle\sis\smissing/)
 */
export function SheetTitle({ visuallyHidden, ...props }: SheetTitleProps): JSX.Element {
  useSheetPart("SheetTitle", "<SheetTitle>…</SheetTitle>…");
  return (
    <Drawer.Title
      {...props}
      data-ouro-sheet-title=""
      className={
        visuallyHidden
          ? "sr-only"
          : "m-0 font-[family-name:var(--font-heading,inherit)] text-lg leading-6 font-semibold text-balance text-popover-foreground"
      }
    />
  );
}

/** Part: a line under the title that describes the dialog. */
export function SheetDescription(props: Omit<Drawer.Description.Props, "className">): JSX.Element {
  useSheetPart("SheetDescription", "<SheetDescription>…</SheetDescription>…");
  return (
    <Drawer.Description
      {...props}
      data-ouro-sheet-description=""
      className="m-0 text-sm leading-5 text-muted-foreground"
    />
  );
}

/** Props for {@link SheetContent}. `className` is for layout only. */
export type SheetContentProps = Omit<Drawer.Content.Props, "className"> & { className?: string | undefined };

/**
 * Part: the scrollable body. A mouse can select text in it without dragging the
 * sheet; touch still drags from anywhere once the body is scrolled to the top.
 * While it overflows it is a tab stop, so a keyboard can scroll it.
 * Its focus ring is drawn over the content, so a header that sticks to the top never hides an edge of it.
 * @claim "Its focus ring is drawn over the content" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::SheetContent > draws its focus ring whole over content that sticks to an edge, and leaves the pointer to the content)
 */
export function SheetContent({ className, ref, ...props }: SheetContentProps): JSX.Element {
  const scrollRef = useMergedRef(ref, useKeyboardScrollable<HTMLDivElement>(props.tabIndex === undefined));
  useSheetPart("SheetContent", "<SheetContent>…</SheetContent>");
  useAppearanceClassNameCheck(
    "SheetContent",
    className,
    process.env.NODE_ENV !== "production"
      ? sheetHint("<SheetContent>", "</SheetContent>")
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  // The wrapper takes the body's place in the sheet's column; the scroller fills it. Its focus ring is a sibling drawn
  // over the scroller, so content that sticks to an edge inside the body never covers it.
  return (
    <div className="relative box-border flex min-h-0 flex-1 flex-col">
      <Drawer.Content
        data-ouro-control="sheet"
        data-ouro-part="content"
        {...props}
        ref={scrollRef}
        data-ouro-sheet-content=""
        className={cn(
          "peer box-border min-h-0 flex-1 overflow-y-auto overscroll-contain touch-auto px-5 pt-2 pb-5 outline-none focus-visible:isolate",
          // Under forced colours, where the body ends while it is one.
          "forced-colors:[&[tabindex='0']]:outline-1 forced-colors:[&[tabindex='0']]:outline-solid forced-colors:[&[tabindex='0']]:-outline-offset-1",
          className,
        )}
      />
      <span
        aria-hidden="true"
        data-sheet-focus-ring=""
        className="pointer-events-none absolute inset-0 hidden rounded-[inherit] outline-ring -outline-offset-2 peer-focus-visible:block peer-focus-visible:outline-2 peer-focus-visible:outline-solid"
      />
    </div>
  );
}


/** Part: closes the sheet. Pass your button as `render={<Button>Done</Button>}`. */
export function SheetClose(props: Drawer.Close.Props): JSX.Element {
  useSheetPart("SheetClose", "<SheetContent><SheetClose>…</SheetClose></SheetContent>");
  return <Drawer.Close {...(props.render === undefined ? { className: "forced-colors:border forced-colors:border-solid", "data-ouro-control": "sheet", "data-ouro-part": "close" } : {})} {...props} />;
}
