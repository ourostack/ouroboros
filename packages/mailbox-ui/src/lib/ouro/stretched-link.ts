export { followStretchedLink, raiseControlsClass, stretchedLinkBaseClass, stretchedLinkClass };
export type { StretchedClick };

/**
 * `stretchedLinkClass` without its hover and press tint, for a link whose root draws the tint itself (a Card with a
 * backdrop tints its picture, inside the picture's clip).
 *
 * @internal
 * @example
 * <a href="/recipes/1" data-stretched-link="" className={stretchedLinkBaseClass}>Ribs</a>
 */
const stretchedLinkBaseClass = "text-inherit no-underline outline-none after:absolute after:inset-0 after:z-1 after:content-['']";
/**
 * The class for a link that stretches over its whole row or card through its `::after`,
 * so the row is one link with one tab stop (`Item`, `Card` and `Table` with a row link).
 * The linked root is `relative` (and `isolate`), and the link carries
 * `data-stretched-link=""`. The layer is `z-1`, so positioned content that is not a
 * control (a ScrollArea, an AspectRatio) stays under it; raised controls are `z-10`.
 *
 * @internal
 * @example
 * <div data-linked="" className={cn("relative isolate", raiseControlsClass)}>
 *   <a href="/recipes/1" data-stretched-link="" className={stretchedLinkClass}>Ribs</a>
 * </div>
 */
const stretchedLinkClass =
  stretchedLinkBaseClass +
  " after:transition-colors after:duration-(--ouro-duration-fast) pointer-fine:hover:after:bg-foreground/[0.03] active:after:bg-foreground/[0.06]";

/**
 * The class for a linked root that lifts every control inside it (a link, a button, an
 * input, anything with a tab stop) above its stretched link, so the control takes its own
 * clicks and taps and the text around it opens the link. A nested linked root (a linked
 * `Item` in a linked `Card`, marked `data-linked=""`) is lifted whole, so its own link
 * keeps covering it. The selector is inside `:where()`, with no specificity, so a
 * control's own `absolute` or `z-*` class still wins. An element that takes focus only
 * from code (`tabindex="-1"`, as a ScrollArea that fits) stays under the link.
 *
 * @internal
 * @example
 * <tr data-linked="" className={cn("relative isolate", raiseControlsClass)}>…</tr>
 * @claim "The class for a linked root" registry/ouro/components/ouro/card/card.test.tsx verify:testExists(registry/ouro/components/ouro/card/card.test.tsx::Card with href > keeps the action and footer controls on top, as their own tab stops)
 * @claim "The selector is inside `:where()`, with" registry/ouro/lib/ouro/stretched-link.ts verify:fileLine(registry/ouro/lib/ouro/stretched-link.ts, /:where\(/)
 */
const raiseControlsClass =
  "[:where(&_:is(a,button,input,select,textarea,label,summary,[tabindex]:not([tabindex='-1']),[role=button],[data-linked]):not([data-stretched-link]))]:relative " +
  "[:where(&_:is(a,button,input,select,textarea,label,summary,[tabindex]:not([tabindex='-1']),[role=button],[data-linked]):not([data-stretched-link]))]:z-10";

/** The mouse event a linked root's `onClick` and `onAuxClick` hand to {@link followStretchedLink}. */
type StretchedClick = {
  readonly currentTarget: HTMLElement;
  readonly target: EventTarget | null;
  readonly button: number;
  readonly type: string;
  readonly defaultPrevented: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
};

// What takes its own click inside a linked root: its stretched link, and every control raiseControlsClass lifts.
const ownClick = "a,button,input,select,textarea,label,summary,[tabindex]:not([tabindex='-1']),[role=button],[role=link],[contenteditable=true],[data-linked]";

/**
 * The `onClick` and `onAuxClick` of a linked root: a click anywhere on it that no control of its
 * own takes opens its stretched link, though the app's layout leaves the link's `::after` short
 * of that spot (a body the app positions over the media, so the layer covers the body alone). A
 * plain click it hands to the link, so a router link navigates as its own click does. A middle
 * click, or a click with Cmd, Ctrl or Shift, opens the link's address in a new tab, since Safari
 * ignores the keys on a click a script hands on and would open it in place. The keyboard is
 * untouched: the link stays the one tab stop. A click that ends a text selection in the root
 * selects, and opens nothing, as does a click React hands up from a portal outside the root (a menu
 * of its actions).
 *
 * @internal
 * @example
 * <div data-linked="" onClick={followStretchedLink} onAuxClick={followStretchedLink}>…</div>
 * @claim "a click anywhere on it that no" registry/ouro/components/ouro/card/card.test.tsx verify:testExists(registry/ouro/components/ouro/card/card.test.tsx::Card with href > opens its link from a click anywhere on it, though the app positions its body over the media, with the same button and keys)
 * @claim "A middle click, or a click with" registry/ouro/components/ouro/card/card.test.tsx verify:testExists(registry/ouro/components/ouro/card/card.test.tsx::Card with href > opens its link from a click anywhere on it, though the app positions its body over the media, with the same button and keys)
 * @claim "as does a click React hands" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item with href > opens nothing from a choice in its actions' menu, which React hands up from the menu's portal outside the row)
 * @claim "A click that ends a text" registry/ouro/components/ouro/card/card.test.tsx verify:testExists(registry/ouro/components/ouro/card/card.test.tsx::Card with href > opens nothing from a click that ends a text selection, or one a control of its own takes)
 */
function followStretchedLink(event: StretchedClick): void {
  // A main click, or a middle click, which browsers send as auxclick.
  if (event.defaultPrevented || event.button !== (event.type === "auxclick" ? 1 : 0)) return;
  const root = event.currentTarget;
  // React hands a click up from a portal (an open Menu or Popover of the row's actions) to the root, though it
  // lands outside it: it is the portal's own, never the row's.
  if (!root.contains(event.target as Node)) return;
  // The root's own link: one a linked row inside it (an Item in a Card) has is that row's.
  const link = root.querySelector<HTMLElement>(":scope [data-stretched-link]:not(:scope [data-linked] [data-stretched-link])");
  // A mouse event's target is an element.
  const control = (event.target as Element).closest(ownClick);
  if (!link || (control && control !== root && root.contains(control))) return;
  // Text selected elsewhere on the page stays selected through a press on a picture, so only a selection in the root counts.
  const selection = root.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed && selection.containsNode(root, true)) return;
  const view = root.ownerDocument.defaultView;
  // A link's middle or modified click opens a new tab; a row's button takes any click as a plain one.
  if (link instanceof HTMLAnchorElement && (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey)) {
    // Stryker disable next-line OptionalChaining: a page's document always has a window
    view?.open(link.href, "_blank", "noopener");
    return;
  }
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view, altKey: event.altKey }));
}

