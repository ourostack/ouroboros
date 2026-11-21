"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cloneElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactElement, type ReactNode, type Ref } from "react";
import { devWarn } from "@/lib/ouro/dev";
import {
  floatingAlign,
  floatingMotionClass,
  floatingPlacementWarnings,
  floatingPortalClass,
  floatingPositionMethod,
  floatingSide,
  type FloatingAlign,
  type FloatingSide,
} from "@/lib/ouro/floating";
import { lastInput } from "@/lib/ouro/last-input";
import { useMergedRef } from "@/lib/ouro/refs";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { PortalScope, TooltipsGrouped, TooltipsHidden, usePortalContainer } from "@/lib/ouro/portal-container";
import { serverElement } from "@/lib/ouro/server-element";

export type { FloatingAlign as TooltipAlign, FloatingSide as TooltipSide } from "@/lib/ouro/floating";

/** Props for {@link Tooltip}. */
export interface TooltipProps {
  /**
   * A short label for the trigger, a few words: "Add to cookbook". It shows on hover and
   * keyboard focus, never on touch, and screen readers don't read it, so it must never
   * hold anything the user needs.
   * @claim "It shows on hover and keyboard" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > shows on keyboard focus and hides on Escape)
   * @claim "It shows on hover and keyboard" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > shows its content above the trigger on hover, and hides it when the pointer leaves)
   * @claim "It shows on hover and keyboard" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > never opens after a touch on the trigger, even when the touch focuses it)
   */
  content: ReactNode;
  /**
   * The trigger: one element that can take focus, usually a Button. It needs a name of
   * its own; give an icon-only button `aria-label`.
   */
  children: ReactElement;
  /**
   * The side of the trigger the tooltip sits on; it flips when there is no room. @default "top"
   *
   * @claim "it flips when there is no room" https://base-ui.com/react/components/tooltip verify:urlOk(https://base-ui.com/react/components/tooltip)
   */
  side?: FloatingSide | (string & { 'Use "top", "bottom", "left" or "right"': never }) | undefined;
  /** How the tooltip lines up with the trigger along that side. @default "center" */
  align?: FloatingAlign | (string & { 'Use "start", "center" or "end": left is "start", right is "end"': never }) | undefined;

  /** Not a prop. The text is `content`: `<Tooltip content="Add to cookbook">`. */
  title?: { 'Use <Tooltip content="...">': never };
  /** Not a prop. Ouro UI sets the delay, and `OuroProvider` groups tooltips so neighbours open instantly. */
  delayDuration?: { "Ouro UI sets the delay; wrap the app in <OuroProvider> to group tooltips": never };
  /** Not a prop. Ouro UI sets the delay, and `OuroProvider` groups tooltips so neighbours open instantly. */
  delay?: { "Ouro UI sets the delay; wrap the app in <OuroProvider> to group tooltips": never };
  /** Not a prop. The child is the trigger: `<Tooltip content="…"><Button>…</Button></Tooltip>`. */
  asChild?: { 'The child is the trigger: <Tooltip content="..."><Button>...</Button></Tooltip>': never };
  /** Not a prop. Ouro UI splits placement into `side` and `align`: `<Tooltip side="bottom" align="start">`. */
  placement?: { 'Use side="bottom" align="start"': never };
}

/** Content longer than this is more than a label. */
const LABEL_LENGTH = 80;

const popupClass =
  floatingMotionClass +
  " box-border max-w-xs rounded-ouro-md bg-foreground px-2 py-1 text-xs leading-4 text-balance text-background [--ouro-floating-duration:var(--ouro-duration-fast)] data-instant:duration-0";

// Base UI's delay before a tooltip opens under a resting pointer, and how long after one closes a neighbour inside
// OuroProvider still opens at once.
const OPEN_DELAY = 600;
const GROUP_TIMEOUT = 400;
// Long enough to cross the gap from the trigger onto the tooltip, which keeps it open, as Base UI's tooltips allow.
const CLOSE_DELAY = 100;

// The page's tooltips: how many show, and when the last one went, so a neighbour opens at once inside OuroProvider.
// Stryker disable next-line ObjectLiteral: equivalent; read once at import, before mutants switch, and each test's tooltips leave the count where they found it.
const shown = { count: 0, closedAt: Number.NEGATIVE_INFINITY };

/**
 * A link or control inside the content, which no one can reach: the tooltip closes when the pointer leaves the trigger for it.
 *
 * @claim "A link or control inside the" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip dev messages > warns when the content holds a link or a control, once it shows)
 */
const INTERACTIVE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The dev message for content that holds essential information. Development only. */
function essential(detail: string): readonly [string, string] {
  return [
    `${detail}; a tooltip never opens on touch, so phone users never see it`,
    'move essential information out of the tooltip, into the page or a <Popover title="…">',
  ];
}

// Base UI's Menu and Popover triggers set aria-haspopup and aria-expanded while their popup is open. A disclosure (an
// accordion's toggle) sets aria-expanded alone, and an expanded one holds nothing a tooltip would cover.
function popupOpen(expanded: unknown, haspopup: unknown): boolean {
  return (expanded === true || expanded === "true") && haspopup !== undefined && haspopup !== null && haspopup !== false && haspopup !== "false";
}

/**
 * A short label that appears beside its trigger on hover and keyboard focus, for an
 * icon button's purpose or a control's shortcut. It never opens on touch, and screen
 * readers don't read it, so it only repeats or adds to what the page already says.
 * Inside `OuroProvider`, tooltips share one delay: once one shows, its neighbours open
 * instantly. A press on the trigger closes it, and it stays closed while the trigger's menu or popover is open.
 *
 * Use `Popover` instead for anything the user needs or can act on (it opens on tap and
 * holds controls), `HoverCard` for a preview of a link, and plain text on the page for
 * essential information.
 *
 * It stacks above the page at `--ouro-layer`, a z-index of 50 by default (from
 * ouro-base.css), like Dialog and Sheet. Opened from inside a Dialog or a Sheet, it shows
 * above it.
 *
 * @group Overlays
 * @see https://ui.ouroboros.bot/docs/tooltip
 *
 * On a button that opens a Popover, Dialog or Menu, put the Tooltip inside that
 * component's `trigger`, never around the component: the Tooltip passes the trigger
 * props it receives on to its child.
 *
 * @example
 * <Tooltip content="Add to cookbook">
 *   <Button aria-label="Save" variant="plain"><BookmarkIcon /></Button>
 * </Tooltip>
 * <Popover
 *   title="Share recipe"
 *   trigger={<Tooltip content="Share recipe"><Button aria-label="Share"><ShareIcon /></Button></Tooltip>}
 * >
 *   <TextField label="Link" defaultValue={url} readOnly />
 * </Popover>
 * @claim "It stacks above the page at" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > portals at the --ouro-layer level, as its own stacking context)
 * @claim "Opened from inside a Dialog or a Sheet" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > shows above a %s it is opened from)
 * @claim "It stacks above the page at" registry/ouro/theme/ouro-base.css verify:fileLine(registry/ouro/theme/ouro-base.css, /^\s+--ouro-layer:\s50;/)
 * @claim "It never opens on touch, and" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > never opens after a touch on the trigger, even when the touch focuses it)
 * @claim "It never opens on touch, and" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > opens on mouse hover after a touch elsewhere, as on a laptop with a touchscreen)
 * @claim "A press on the trigger closes it" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > closes on Enter when the press opens something and focus stays on the trigger)
 * @claim "it stays closed while the trigger's menu or popover is open" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > closes on a click, and stays closed while its trigger's menu is open)
 * @claim "it stays closed while the trigger's menu or popover is open" registry/ouro/components/ouro/tooltip/tooltip.test.tsx verify:testExists(registry/ouro/components/ouro/tooltip/tooltip.test.tsx::Tooltip > closes on a click, and stays closed while its trigger's popover is open)
 */
export function Tooltip(props: TooltipProps): JSX.Element {
  const {
    content,
    children,
    side: sideProp,
    align: alignProp,
    // Guard props (hint types), dropped here so they never reach the DOM.
    title,
    delayDuration,
    delay,
    asChild,
    placement,
    // Props and a ref from a parent trigger, such as Popover's `trigger`, go on to the child.
    ref,
    ...forwarded
  } = props as TooltipProps & { ref?: Ref<HTMLButtonElement> };

  const side = floatingSide(sideProp, "top");
  const align = floatingAlign(alignProp);
  const key = useRef({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The child's own ref, a parent trigger's (Popover's), and the tooltip's own.
  const child = serverElement(children);
  const mergedRef = useMergedRef((child.props as { ref?: Ref<HTMLButtonElement> }).ref, useMergedRef(ref, triggerRef));

  useDevWarnings(
    "Tooltip",
    process.env.NODE_ENV !== "production"
      ? () => {
          const timing = (name: string) =>
            [
              `${name} is not a prop; Ouro UI sets the delay, and OuroProvider groups tooltips`,
              "<OuroProvider><App /></OuroProvider>",
            ] as const;
          return [
            ...floatingPlacementWarnings("<Tooltip", sideProp, "top", alignProp, placement),
            title !== undefined && ["title is not a prop; the text is content", '<Tooltip content="…">'],
            delayDuration !== undefined && timing("delayDuration"),
            delay !== undefined && timing("delay"),
            asChild !== undefined && [
              "asChild is not a prop; the child is the trigger",
              '<Tooltip content="…"><Button>…</Button></Tooltip>',
            ],
            typeof content === "string" &&
              content.length > LABEL_LENGTH &&
              essential(`content is ${content.length} characters, more than a label`),
          ];
        }
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );

  // A trigger with no name of its own is unnamed for screen readers: the tooltip is not one.
  useEffect(() => {
    /* istanbul ignore else @preserve -- the else path exists only in production bundles */
    if (process.env.NODE_ENV !== "production") {
      const element = triggerRef.current;
      if (!element) {
        devWarn(
          "Tooltip",
          "the trigger never received the tooltip's ref, so the tooltip cannot open; the child must pass its props and ref to an element, and Popover and Dialog do not",
          'put the Tooltip inside the trigger: trigger={<Tooltip content="…"><Button …/></Tooltip>}',
          key.current,
        );
        return;
      }
      const named =
        element.textContent!.trim() !== "" ||
        element.hasAttribute("aria-label") ||
        element.hasAttribute("aria-labelledby");
      if (!named) {
        devWarn(
          "Tooltip",
          "the trigger has no accessible name, and a tooltip is not one",
          `<Button aria-label="${typeof content === "string" ? content : "…"}">`,
          key.current,
        );
      }
    }
  });

  // Links and controls in the content show up only once it renders.
  const checkContent = useCallback((element: HTMLElement | null) => {
    /* istanbul ignore else @preserve -- the else path exists only in production bundles */
    if (process.env.NODE_ENV !== "production") {
      if (element?.querySelector(INTERACTIVE)) {
        const [problem, fix] = essential("content holds a link or control, which no one can reach");
        devWarn("Tooltip", problem, fix, key.current);
      }
    }
  }, []);

  // The tooltip mounts only once someone may want it: on the trigger's first hover or keyboard focus. Until then the
  // trigger is the child itself with a few handlers, so a row of many (a message's reactions) mounts no tooltips. The
  // child is never wrapped or drawn again as it arms, so focus and the pointer stay on it.
  const grouped = useContext(TooltipsGrouped);
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState<false | "delay" | "focus" | "now">(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (how: "delay" | "focus" | "now") => {
    // Never after a touch: a tap that focuses the trigger would otherwise show it, and a phone has no way to hover it away.
    // Nor while the trigger's own menu or popover is open: the person is using that, so the tooltip waits until it closes.
    const element = triggerRef.current;
    if (content === undefined || content === null || content === "") return;
    if (lastInput() !== "touch" && !popupOpen(element?.getAttribute("aria-expanded"), element?.getAttribute("aria-haspopup"))) setOpen(how);
  };
  const after = (delay: number, act: () => void) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(act, delay);
  };
  const close = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    shown.count += 1;
    return () => {
      shown.count -= 1;
      shown.closedAt = performance.now();
    };
  }, [open]);
  // A pending open must not fire after its trigger has unmounted.
  // Stryker disable next-line ArrayDeclaration: equivalent; any constant dependency list runs this cleanup once, at unmount.
  useEffect(() => () => clearTimeout(timer.current), []);

  // Closed as the container it is in hides, such as a toolbar that fades out. A layout effect, so
  // the close is asked in the same commit that hides the container, not a frame later.
  const hidden = useContext(TooltipsHidden);
  useLayoutEffect(() => {
    // Stryker disable next-line ConditionalExpression: equivalent; the effect also runs at mount and as the container shows again, when the tooltip is already closed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (hidden) close();
  }, [hidden]);

  // A popup the trigger opens while the tooltip shows (not by a press, which already closed it) closes the tooltip. The
  // trigger's props come from a parent's `trigger` (Popover's or Menu's) or the child itself, the child's winning.
  const childExpanded = (child.props as Record<string, unknown>)["aria-expanded"] ?? (forwarded as Record<string, unknown>)["aria-expanded"];
  const childHaspopup = (child.props as Record<string, unknown>)["aria-haspopup"] ?? (forwarded as Record<string, unknown>)["aria-haspopup"];
  const expanded = popupOpen(childExpanded, childHaspopup);
  // Closing as the popup shuts finds nothing to close: the guard keeps a tooltip shut while its trigger's popup is open.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    close();
  }, [expanded]);

  const portal = usePortalContainer("Tooltip");
  const trigger = cloneElement(
    child,
    // The child takes the merged ref and handlers, none of which run during render. A parent trigger's
    // props come first, so the child's own (a toolbar control's tabIndex) win, as Base UI's render does.
    // eslint-disable-next-line react-hooks/refs
    mergeProps(forwarded as object, child.props as object, {
      ref: mergedRef,
      // Only while open: a closed tooltip leaves a parent's data-popup-open (its menu's, say) as it is.
      // Stryker disable next-line StringLiteral: read by the attribute alone, as Base UI's open trigger is.
      ...(open ? { "data-popup-open": "" } : {}),
      // Marks the trigger as Base UI's own tooltip trigger did, so a nested trigger and tests still find it.
      // Stryker disable next-line StringLiteral: read by the attribute alone.
      ...(content === undefined || content === null || content === "" ? {} : { "data-base-ui-tooltip-trigger": "" }),
      onPointerEnter: (event: { pointerType: string; timeStamp: number }) => {
        if (event.pointerType === "touch") return;
        setArmed(true);
        // Inside OuroProvider a neighbour opens at once while one shows, or a moment after it went.
        if (grouped && (shown.count > 0 || event.timeStamp - shown.closedAt < GROUP_TIMEOUT)) show("delay");
        else after(OPEN_DELAY, () => show("now"));
      },
      onPointerLeave: () => after(CLOSE_DELAY, () => setOpen(false)),
      onFocus: (event: { currentTarget: Element }) => {
        if (!event.currentTarget.matches(":focus-visible")) return;
        setArmed(true);
        clearTimeout(timer.current);
        show("focus");
      },
      onBlur: close,
      // Escape on the trigger closes an open tooltip and goes no further, so a popover or rail around it stays: the
      // tooltip takes the first Escape, as Base UI's does.
      onKeyDown: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
        if (event.key !== "Escape" || !open) return;
        close();
        event.preventDefault();
        event.stopPropagation();
      },
      // A press closes it, and keeps a pending one from opening. A click closes it too: Enter or Space on a trigger that
      // opens something without moving focus off it would otherwise leave the tooltip over what it opened.
      onPointerDown: close,
      onClick: close,
    }) as Record<string, unknown>,
  );
  if (!armed) return trigger;
  return (
    <>
      {trigger}
      <BaseTooltip.Root
        open={open !== false}
        // Base UI asks only to close a tooltip it holds no trigger for: on Escape or a press outside it.
        onOpenChange={close}
      >
        <BaseTooltip.Portal data-slot="tooltip-portal" {...portal} data-ouro="tooltip-portal" className={floatingPortalClass}>
          <PortalScope>
            <BaseTooltip.Positioner anchor={triggerRef} positionMethod={floatingPositionMethod} side={side} align={align} sideOffset={6} collisionPadding={8} data-ouro="tooltip-positioner">
              <BaseTooltip.Popup
                data-slot="tooltip-content"
                ref={checkContent}
                data-ouro="tooltip"
                // Opened by keyboard focus, or at once beside one already shown: no entrance, as Base UI does.
                data-instant={open === "focus" || open === "delay" ? open : undefined}
                // The pointer may cross from the trigger onto the tooltip and stay.
                onPointerEnter={() => clearTimeout(timer.current)}
                onPointerLeave={() => after(CLOSE_DELAY, () => setOpen(false))}
                className={popupClass}
              >
                {content}
              </BaseTooltip.Popup>
            </BaseTooltip.Positioner>
          </PortalScope>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </>
  );
}
