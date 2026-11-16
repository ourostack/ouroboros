import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

export { holdPageAtPress, holdPageScroll };

// What the person does to scroll the page: these leave a scroll that follows them alone.
// A key counts only when nothing handled it, so the arrow keys that move through a menu don't.
const scrollKeys = new Set([" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"]);

/** How long after the person acts a page scroll is theirs, in milliseconds. */
const INTENT_MS = 1000;
/** How long a scroll of theirs that is still going keeps the page free, in milliseconds. */
const SCROLLING_MS = 200;
/**
 * How long a press on a trigger holds the page when no popup opens from it, in milliseconds.
 * @claim "How long a press on a trigger holds the page when no popup opens from it" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > makes the page's scrolls instant and holds the page from the press, until a second passes with no popup)
 */
const PRESS_MS = 1000;
/** The keys that open a popup from a button trigger: the button's click. */
const buttonKeys = ["Enter", " "];
/** The keys that open a list from its trigger as Base UI's list navigation does, closed: an up or down arrow. */
const listKeys = ["ArrowDown", "ArrowUp"];

const portals = new Set<HTMLElement>();
let left = 0;
let top = 0;
let freeUntil = 0;
let release: (() => void) | undefined;
/** Ends the hold a press on a trigger started, until a popup takes it over. */
let pressEnds: ReturnType<typeof setTimeout> | undefined;
/** The key that pressed a trigger: the person opening a popup with it, not scrolling. */
let pressKey: KeyboardEvent | undefined;
/** The event a trigger's press handled last, so a second handler on the same element (an Ouro Button's, under a component's) leaves it alone. */
let pressedBy: Event | undefined;
/** The trigger whose click ends its press's hold, for a dialog, which holds the page itself once open. */
let clicked: { trigger: HTMLElement; view: Window } | undefined;
/** The page's own inline `scroll-behavior` while the hold has made its scrolls instant, else null. */
let behavior: string | null = null;

/**
 * Makes the page's scrolls instant. A smooth scroll's first step can reach the screen before its
 * scroll event, so one the hold undoes would show for a frame; an instant one is undone first.
 *
 * @claim "an instant one is undone first" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageScroll > undoes a page scroll while a popup is open, before the next frame paints it)
 */
function pin(html: HTMLElement) {
  behavior ??= html.style.scrollBehavior;
  html.style.scrollBehavior = "auto";
}

/** Gives the page its own `scroll-behavior` back, unless something else has set it since. */
function unpin(html: HTMLElement) {
  if (behavior !== null && html.style.scrollBehavior === "auto") html.style.scrollBehavior = behavior;
  behavior = null;
}

/** Whether the page is held: a trigger was just pressed, or a portal holds a popup Base UI marks open, not one that is closing. */
const held = () => pressEnds !== undefined || [...portals].some((portal) => portal.querySelector("[data-open]") !== null);

/** Starts listening, from where the page is now, unless a popup or a press already holds it. */
function start(view: Window) {
  if (portals.size > 0 || pressEnds !== undefined) return;
  left = view.scrollX;
  top = view.scrollY;
  release = listen(view);
}

/**
 * Stops listening and gives the page its scrolls back, once no popup and no press holds it.
 * @claim "once no popup and no press holds it" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > holds the page while a press is pending, though the popup that was open closes)
 */
function stop(view: Window) {
  if (portals.size > 0 || pressEnds !== undefined) return;
  release!();
  unpin(view.document.documentElement);
}

/**
 * Ends a press's hold: a popup took it over, or none opened in time.
 * @claim "a popup took it over, or none opened in time" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > hands the press's hold to the popup that opens from it, from where the press stopped the page)
 * @claim "a popup took it over, or none opened in time" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > makes the page's scrolls instant and holds the page from the press, until a second passes with no popup)
 */
function endPress() {
  clearTimeout(pressEnds);
  pressEnds = undefined;
  clicked?.trigger.removeEventListener("click", letGo);
  clicked = undefined;
}

/** Ends a dialog trigger's press at its click, which opens the dialog. */
function letGo() {
  const { view } = clicked!;
  endPress();
  stop(view);
}

/**
 * Holds the page from a press on a trigger, before its popup opens: stops a page scroll in flight
 * where it is, and makes the page's scrolls instant, until the popup takes the hold over or, when
 * none opens, a second later. A press on the trigger of an open popup, which closes it, leaves the
 * page to that popup's hold.
 *
 * @claim "stops a page scroll in flight where it is" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > stops a smooth scroll in flight where it is, at a press of the primary button or an opening key)
 * @claim "when none opens, a second later" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > makes the page's scrolls instant and holds the page from the press, until a second passes with no popup)
 * @claim "until the popup takes the hold over" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > hands the press's hold to the popup that opens from it, from where the press stopped the page)
 * @claim "A press on the trigger of an open popup" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > leaves the page to the open popup's hold at a press on its trigger, which closes it)
 */
function press(trigger: HTMLElement, event: Event, untilClick: boolean) {
  if (event === pressedBy) return;
  pressedBy = event;
  if (trigger.getAttribute("aria-expanded") === "true") return;
  const view = trigger.ownerDocument.defaultView!;
  // Stryker disable next-line ObjectLiteral: scrollTo({}) also scrolls to where the page is, which ends a smooth scroll in flight there too; the place and the instant behaviour are spelled out so that does not rest on the page's scroll-behavior.
  view.scrollTo({ left: view.scrollX, top: view.scrollY, behavior: "instant" });
  start(view);
  endPress();
  pressEnds = setTimeout(() => {
    endPress();
    stop(view);
  }, PRESS_MS);
  freeUntil = 0;
  // A dialog's scroll lock saves the page's inline scroll-behavior and puts it back as it closes, so
  // a pinned "auto" would outlast the press; its press holds the page until the click instead.
  if (untilClick) {
    clicked = { trigger, view };
    trigger.addEventListener("click", letGo);
  } else pin(view.document.documentElement);
}

/**
 * Event props that hold the page from a press on a trigger: a pointerdown that `opens` takes (the
 * primary button's by default), or one of `keys`; with `untilClick`, only until the trigger's click.
 */
function pressHandlers(keys: string[], untilClick = false, opens = (event: ReactPointerEvent<HTMLElement>) => event.button === 0) {
  const opening = new Set(keys);
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (opens(event)) press(event.currentTarget, event.nativeEvent, untilClick);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!opening.has(event.key)) return;
      pressKey = event.nativeEvent;
      press(event.currentTarget, event.nativeEvent, untilClick);
    },
  };
}

/**
 * Event props for the trigger of a menu, popover, select or combobox, which hold the page from
 * the press that opens it rather than from when its popup opens: the primary button's
 * pointerdown, or a key that opens that kind of trigger's popup. `button` (Popover) takes Enter
 * and Space, which click it; `listButton` (Menu's dropdown and its menubar triggers, Select) takes
 * those and an up or down arrow; `listInput` (Combobox) takes only the arrows, as Enter in its
 * closed input submits the form and opens nothing. `dialog` (the trigger of a Dialog, ConfirmDialog, Sheet or Command, a
 * Lightbox's thumbnail, and a Button with `aria-haspopup="dialog"`) takes Enter and Space and
 * holds the page only until the trigger's click opens the dialog, whose own scroll lock holds it
 * from then; it leaves `scroll-behavior` alone. `contextMenu` (a context menu's area) takes the
 * right button's pointerdown and no key; not a touch, which may start a scroll over the area, and
 * stops a scroll in flight by itself. A press during a smooth scroll stops the page where it is at once, so a
 * popup that opens on pointerdown does not take the release, over whatever moved under the
 * pointer, for a press outside it and close, and the release of a press on a dialog's trigger
 * lands on the trigger, so its click opens the dialog. Spread them on the trigger, with `holdPage`
 * on its `usePortalContainer` for a popup.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @example
 * <BaseMenu.Trigger render={trigger} {...holdPageAtPress.listButton} />
 * @claim "A press during a smooth scroll stops the page where it is at once" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > stops a smooth scroll in flight where it is, at a press of the primary button or an opening key)
 * @claim "so a popup that opens on pointerdown does not take the release" registry/ouro/components/ouro/menu/menu.test.tsx verify:fileLine(registry/ouro/components/ouro/menu/menu.test.tsx, /stays open and stops the page where it is, pressed mid-scroll/)
 * @claim "takes only the arrows, as Enter in its closed input submits the form" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > holds the page only at the keys that open each kind of trigger's popup)
 * @claim "takes only the arrows, as Enter in its closed input submits the form" registry/ouro/components/ouro/combobox/combobox.test.tsx verify:fileLine(registry/ouro/components/ouro/combobox/combobox.test.tsx, /leaves the page to the app at Enter in its closed input, which submits the form/)
 * @claim "holds the page only until the trigger's click opens the dialog" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > holds the page from a dialog trigger's press until its click, leaving scroll-behavior alone)
 * @claim "lands on the trigger, so its click opens the dialog" registry/ouro/components/ouro/dialog/dialog.test.tsx verify:fileLine(registry/ouro/components/ouro/dialog/dialog.test.tsx, /opens and leaves the page where the press found it, pressed mid-scroll/)
 * @claim "takes Enter and Space, which click it" registry/ouro/components/ouro/popover/popover.test.tsx verify:fileLine(registry/ouro/components/ouro/popover/popover.test.tsx, /leaves the page free at an arrow key on its trigger, which opens nothing/)
 * @claim "takes the right button's pointerdown and no key; not a touch" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageAtPress > holds the page from a context area's right-button press, not its primary press or a touch, which may start a scroll)
 */
const holdPageAtPress = {
  button: pressHandlers(buttonKeys),
  listButton: pressHandlers([...buttonKeys, ...listKeys]),
  listInput: pressHandlers(listKeys),
  dialog: pressHandlers(buttonKeys, true),
  // Stryker disable next-line ArrayDeclaration: a context area opens on no key, and a key list no real key matches holds the page at none, as the empty one does.
  contextMenu: pressHandlers([], false, (event) => event.button === 2),
};

/**
 * Keeps the page where it is while an overlay in `portal` is open. Opening a menu, popover,
 * select or combobox focuses and scrolls to its items, and a browser scrolls the page for that
 * too: far, when the popup is not placed yet or the page sets `scroll-padding`, and smoothly,
 * when it sets `scroll-behavior: smooth`. While a popup is open, such a scroll is undone before
 * it is painted, and the page's scrolls are instant (`scroll-behavior: auto` on `<html>`) so
 * none shows a first step. A scroll the person makes still moves the page: with the wheel, a touch, the
 * scroll bar, a key nothing else handled, or a click on something in the popup (a link to a
 * section, say). Returns what stops holding the page for this portal.
 *
 * Internal: Ouro UI components use it, through `usePortalContainer`; apps don't need to.
 *
 * @example
 * const stop = holdPageScroll(portalElement);
 * @claim "such a scroll is undone before it is painted" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageScroll > undoes a page scroll while a popup is open, before the next frame paints it)
 * @claim "the page's scrolls are instant" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageScroll > makes the page's scrolls instant while it holds the page, and gives back its own scroll-behavior after)
 * @claim "A scroll the person makes still" registry/ouro/lib/ouro/page-scroll-hold.test.ts verify:testExists(registry/ouro/lib/ouro/page-scroll-hold.test.ts::holdPageScroll > leaves a scroll that follows the wheel, a touch, the scroll bar, a key nothing handled or a click in the popup)
 */
function holdPageScroll(portal: HTMLElement): () => void {
  const view = portal.ownerDocument.defaultView!;
  // From where the page is, or, when a press on its trigger held it first, from where the press stopped it.
  start(view);
  endPress();
  // A popup that opens now was opened by what the person just did; what it scrolls is not theirs.
  freeUntil = 0;
  pin(view.document.documentElement);
  portals.add(portal);
  return () => {
    portals.delete(portal);
    stop(view);
  };
}

function listen(view: Window): () => void {
  const document = view.document;
  // What the person starts glides as the page sets it.
  const free = () => {
    freeUntil = performance.now() + INTENT_MS;
    unpin(document.documentElement);
  };
  const onPointerDown = (event: PointerEvent) => {
    // The scroll bar, or a middle-button press that starts the browser's autoscroll.
    if (event.target === document.documentElement || event.button === 1) free();
  };
  const onClick = (event: MouseEvent) => {
    if ([...portals].some((portal) => portal.contains(event.target as Node))) free();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event === pressKey) return;
    if (event.defaultPrevented) {
      freeUntil = 0;
      pin(document.documentElement);
    } else if (scrollKeys.has(event.key)) free();
  };
  const onScroll = () => {
    const now = performance.now();
    const theirs = now < freeUntil;
    if (theirs) freeUntil = Math.max(freeUntil, now + SCROLLING_MS);
    if (theirs || !held()) {
      left = view.scrollX;
      top = view.scrollY;
      return;
    }
    // Back where it was, at once: a scroll to where the page already is does nothing.
    view.scrollTo({ left, top, behavior: "instant" });
  };
  const capture = {
    capture: true,
    // Stryker disable next-line BooleanLiteral: passive only tells the browser the listener never cancels the event, which none does.
    passive: true,
  };
  document.addEventListener("wheel", free, capture);
  document.addEventListener("touchmove", free, capture);
  document.addEventListener("pointerdown", onPointerDown, capture);
  document.addEventListener("click", onClick, capture);
  // Bubbling, on the window: after the popup's own handlers, which mark the keys they used.
  view.addEventListener("keydown", onKeyDown);
  document.addEventListener("scroll", onScroll);
  return () => {
    document.removeEventListener("wheel", free, capture);
    document.removeEventListener("touchmove", free, capture);
    document.removeEventListener("pointerdown", onPointerDown, capture);
    document.removeEventListener("click", onClick, capture);
    view.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("scroll", onScroll);
  };
}
