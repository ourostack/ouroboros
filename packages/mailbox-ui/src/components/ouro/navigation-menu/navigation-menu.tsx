"use client";

import { NavigationMenu as BaseNavigationMenu } from "@base-ui/react/navigation-menu";
import { useState, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { currentHref, samePath } from "@/lib/ouro/current-path";
import { floatingPortalClass } from "@/lib/ouro/floating";
import { RouterLink } from "@/lib/ouro/router-link";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { PortalScope, usePortalContainer } from "@/lib/ouro/portal-container";

/** One link inside a NavigationMenu panel. */
export interface NavigationMenuLink {
  /** The link's text: "Browse". */
  label: string;
  /** Where it goes. Internal paths go through `OuroProvider`'s `linkComponent` (your router's link). */
  href: string;
  /**
   * A line under the label that says what is there: "Everything you have saved."
   *
   * @claim "A line under the label that" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > opens a panel of links on click, with each link's description)
   */
  description?: string | undefined;
  /** Marks this link as the current page, when the menu's `currentPath` cannot tell. */
  current?: boolean | undefined;
}

/** A NavigationMenu item that is a link to a page. */
export interface NavigationMenuLinkItem {
  /** The link's text: "Pricing". */
  label: string;
  /** Where it goes. Internal paths go through `OuroProvider`'s `linkComponent` (your router's link). */
  href: string;
  /** Marks this link as the current page, when the menu's `currentPath` cannot tell. */
  current?: boolean | undefined;
  /** Not with `href`. An item is a link (`href`) or a panel (`links`, `content`). */
  links?: never;
  /** Not with `href`. An item is a link (`href`) or a panel (`links`, `content`). */
  content?: never;
}

/**
 * What every panel item has: its button's text, and how its links are laid out.
 *
 * @claim "What every panel item has: its" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > renders a named nav with a button for each panel and a link for each page)
 * @claim "What every panel item has: its" registry/ouro/components/ouro/navigation-menu/navigation-menu.test-d.ts verify:fileLine(registry/ouro/components/ouro/navigation-menu/navigation-menu.test-d.ts, /expectTypeOf<\{\slabel:\s"Recipes";\scolumns:\s3;\slinks:\s\[\]\s\}>\(\)\.not\.toExtend<NavigationMenuItem>/)
 */
interface NavigationMenuPanelBase {
  /** The button's text: "Recipes". */
  label: string;
  /**
   * The panel's links in one column or two, from 640px up; a phone always shows one.
   * @default 1
   * @claim "The panel's links in one column" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu panels and easing > shows a panel's content beside its links, in two columns)
   * @claim "The panel's links in one column" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu panels and easing > stacks the content above the links on a phone)
   */
  columns?: 1 | 2 | (number & { "Use columns={1} or columns={2}": never }) | undefined;
  /** Not with a panel. To link the section's own page, make it the panel's first link. */
  href?: never;
}

/**
 * A NavigationMenu item that opens a panel: a list of `links`, with any `content` at its
 * start, such as a featured `Card` beside a two-column grid of links. A panel needs one of
 * the two.
 * @claim "A NavigationMenu item that opens a" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > opens a panel of links on click, with each link's description)
 * @claim "A NavigationMenu item that opens a" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu panels and easing > shows a panel's content beside its links, in two columns)
 * @claim "A panel needs one of the" registry/ouro/components/ouro/navigation-menu/navigation-menu.test-d.ts verify:fileLine(registry/ouro/components/ouro/navigation-menu/navigation-menu.test-d.ts, /\{\slabel:\s"Recipes"\s\}>\(\)\.not\.toExtend<NavigationMenuItem>/)
 */
export type NavigationMenuPanelItem = NavigationMenuPanelBase &
  (
    | {
        /**
         * The links in the panel, each with an optional `description`.
         *
         * @claim "The links in the panel, each" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > opens a panel of links on click, with each link's description)
         */
        links: readonly NavigationMenuLink[];
        /**
         * Anything else in the panel, before its links (above them on a phone): a featured
         * `Card`, an image, a line of text. A link in it closes the panel when it is followed.
         */
        content?: ReactNode;
      }
    | {
        links?: undefined;
        /**
         * The panel's content, when it has no list of links. A link in it closes the panel when it is followed.
         *
         * @claim "The panel's content, when it has" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu panels and easing > shows a panel's content beside its links, in two columns)
         */
        content: ReactNode;
      }
  );

/** One item of a NavigationMenu: a link (`href`), or a button that opens a panel (`links`, `content`). */
export type NavigationMenuItem = NavigationMenuLinkItem | NavigationMenuPanelItem;

/** Props for {@link NavigationMenu}. */
export interface NavigationMenuProps {
  /** Names the navigation for screen readers ("Main"). It is not shown. */
  label: string;
  /** The row's items, in order: links, and buttons that open a panel of links. */
  items: readonly NavigationMenuItem[];
  /**
   * The path of the page being shown, from your router (`useLocation().pathname`, or
   * `usePathname()` in Next.js). The link to that path gets `aria-current="page"`, in the row
   * or in a panel; else the longest link above it, the section the page is in, gets
   * `aria-current="true"`, so a screen reader hears one current page.
   */
  currentPath?: string | undefined;
  /** Layout only: margins, grid placement (`ms-4`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLElement> | undefined;

  /** Not a prop. Ouro UI uses `items`; a panel's links go in an item's `links`. */
  links?: { 'Use items={[{ label: "Recipes", links: [...] }, { label: "Pricing", href: "/pricing" }]}': never };
  /** Not a prop. Ouro UI uses `currentPath`: `<NavigationMenu currentPath={pathname}>`. */
  pathname?: { "Use <NavigationMenu currentPath={pathname}>": never };
  /** Not a prop. The menu is a row; for a column of links use `Sidebar`. */
  orientation?: { "Use <Sidebar> for a column of links": never };
  /** Not rendered. The menu is data: `items={[{ label: "Recipes", links: [...] }, { label: "Pricing", href: "/pricing" }]}`. */
  children?: { 'Use items={[{ label: "Recipes", links: [...] }, { label: "Pricing", href: "/pricing" }]}': never };
}

// Class strings are literal so the app's Tailwind finds them when it compiles.

// A row item, link or button: 44px with 16px text on a coarse pointer at every width, 36px
// with 14px text with a fine one. The current page, or the section it is in, is underlined in the primary colour, as in
// FamilyBar; forced colours keep the underline.
const rowItem =
  "press relative m-0 box-border inline-flex h-11 min-w-11 pointer-fine:h-9 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap " +
  "rounded-md border-0 forced-colors:border forced-colors:border-solid bg-transparent px-3 font-[inherit] text-base pointer-fine:text-sm leading-5 font-medium text-muted-foreground no-underline " +
  "select-none touch-manipulation [-webkit-tap-highlight-color:transparent] " +
  "pointer-fine:hover:bg-accent pointer-fine:hover:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground " +
  "aria-[current=page]:font-semibold aria-[current=page]:text-foreground aria-[current=true]:font-semibold aria-[current=true]:text-foreground data-current:text-foreground " +
  "aria-[current=page]:underline aria-[current=true]:underline decoration-primary decoration-2 underline-offset-5 [text-decoration-skip-ink:none] " +
  "motion-safe:active:scale-(--ouro-press-scale) outline-ring -outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid";

// The theme's enter and exit curve.
const easeOut = "ease-(--ouro-ease-out)";

// Opened or closed from the keyboard, nothing animates (`data-ouro-instant`).
const instantly = "data-ouro-instant:transition-none";

// The chevron turns when its panel is open; with reduced motion it turns without a transition.
const chevron = cn("inline-flex motion-safe:transition-[rotate] motion-safe:duration-(--ouro-duration-base) data-popup-open:rotate-180", easeOut, instantly);

// The popup follows the open panel. Its box and place change at once between panels, since
// layout does not animate; it opens with a scale and fade from its button and closes faster.
// Reduced motion keeps only the fade.
const positioner = "box-border h-(--positioner-height) w-(--positioner-width) max-w-(--available-width)";
const popup = cn(
  "relative box-border h-(--popup-height) w-(--popup-width) origin-(--transform-origin) rounded-lg bg-popover text-popover-foreground outline-none " +
  "ring-1 ring-border/60 shadow-(--shadow-lg) " +
  "transition-opacity duration-(--ouro-duration-base) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--ouro-duration-fast) " +
    "motion-safe:transition-[opacity,scale] motion-safe:data-starting-style:scale-96 motion-safe:data-ending-style:scale-96",
  easeOut,
  instantly,
);
// A panel: nearly the screen's width on a phone, as wide as its links from 640px; wider with
// content or two columns.
const panel = cn(
  "box-border h-full w-[calc(100vw-2rem)] p-2 sm:w-max sm:min-w-64 sm:max-w-md data-wide:sm:max-w-2xl " +
    "transition-opacity duration-(--ouro-duration-base) data-starting-style:opacity-0 data-ending-style:opacity-0",
  easeOut,
  instantly,
);
// A link in a panel: a full-width row, which highlights while pressed instead of scaling.
const panelLink =
  "relative m-0 box-border flex min-h-11 pointer-fine:min-h-9 flex-col justify-center gap-0.5 rounded-md px-3 py-2 text-base pointer-fine:text-sm leading-5 " +
  "text-popover-foreground no-underline select-none touch-manipulation [-webkit-tap-highlight-color:transparent] " +
  "transition-colors duration-(--ouro-duration-fast) ease-[ease] pointer-fine:hover:bg-accent pointer-fine:hover:text-accent-foreground active:bg-accent active:text-accent-foreground " +
  "outline-ring -outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid";
// A panel link's label, which carries the current page's mark, so that its line of description stays plain.
const panelLabel = "decoration-primary decoration-2 underline-offset-5 [text-decoration-skip-ink:none]";

const example =
  '<NavigationMenu label="Main" items={[{ label: "Recipes", links: [{ label: "Browse", href: "/recipes" }] }, { label: "Pricing", href: "/pricing" }]} />';

/**
 * A row of links where some open a panel of further links, each with a line of
 * description: the navigation of a site with more pages than fit in a bar. Panels open on
 * hover or click, move between each other without closing, and close on Escape, on an
 * outside press and when a link is chosen. The current page is marked `aria-current="page"`, and the link of the section it is in `aria-current="true"`, both underlined in the primary colour, distinct from hover and press highlights.
 * Built on Base UI's Navigation Menu.
 *
 * Use `Navbar` instead when every item is a plain link; it also collapses into a drawer on
 * a phone, which this row does not. Use `Menu` for actions rather than pages, and `Sidebar`
 * for a column of links.
 *
 * @group Navigation
 * @see https://ui.ouroboros.bot/docs/navigation-menu
 *
 * @example
 * <NavigationMenu
 *   label="Main"
 *   items={[
 *     {
 *       label: "Recipes",
 *       links: [
 *         { label: "Browse", href: "/recipes", description: "Everything you have saved." },
 *         { label: "Import", href: "/recipes/import", description: "Bring one in from a link." },
 *       ],
 *     },
 *     { label: "Pricing", href: "/pricing" },
 *   ]}
 *   currentPath={pathname}
 * />
 * @claim "A row of links where some" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > opens a panel of links on click, with each link's description)
 * @claim "Panels open on hover or click" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > opens on hover with a mouse and switches panels)
 * @claim "Panels open on hover or click" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > opens a panel of links on click, with each link's description)
 * @claim "Panels open on hover or click" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > closes on Escape and returns focus to the button)
 * @claim "Panels open on hover or click" registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx verify:testExists(registry/ouro/components/ouro/navigation-menu/navigation-menu.test.tsx::NavigationMenu > closes when a link in the panel is chosen)
 * @claim "Panels open on hover or click" https://base-ui.com/react/components/navigation-menu verify:urlOk(https://base-ui.com/react/components/navigation-menu)
 */
export function NavigationMenu(props: NavigationMenuProps): JSX.Element {
  const {
    label,
    items,
    currentPath,
    className,
    ref,
    // Guard props (hint types), dropped here so they never reach the DOM.
    links,
    pathname,
    orientation,
    children,
  } = props;
  useAppearanceClassNameCheck(
    "NavigationMenu",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; NavigationMenu sets its own look`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "NavigationMenu",
    process.env.NODE_ENV !== "production"
      ? () => {
          // The types rule this shape out; an untyped caller can still pass it.
          const loose = items as ReadonlyArray<{ label: string; href?: string; links?: unknown; content?: unknown }>;
          const both = loose.find((item) => (item.links !== undefined || item.content !== undefined) && item.href !== undefined);
          const empty = loose.find((item) => item.href === undefined && item.links === undefined && item.content === undefined);
          return [
            !label && ["label is required; it names the navigation for screen readers", '<NavigationMenu label="Main">'],
            empty && [`"${empty.label}" has no href, links or content`, `{ label: "${empty.label}", href: "/…" } or { label: "${empty.label}", links: [{ label, href }] }`],
            both && [
              `"${both.label}" has both href and a panel, and renders as a panel`,
              `{ label: "${both.label}", links: [{ label: "All ${both.label.toLowerCase()}", href: "${String(both.href)}" }, …] }`,
            ],
            links !== undefined && ["links is not a prop", example],
            pathname !== undefined && ["pathname is not a prop", "<NavigationMenu currentPath={pathname}>"],
            orientation !== undefined && ["orientation is not a prop; the menu is a row", "<Sidebar> for a column of links"],
            children !== undefined && ["children are not rendered; the menu is data", example],
          ];
        }
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );

  return <NavigationMenuView label={label} items={items} currentPath={currentPath} className={className} ref={ref} />;
}

/** Props for {@link NavigationMenuView}: NavigationMenu's, and what Navbar needs to measure its row. */
interface NavigationMenuViewProps {
  label: string;
  items: readonly NavigationMenuItem[];
  currentPath?: string | undefined;
  className?: string | undefined;
  ref?: Ref<HTMLElement> | undefined;
  /** Keeps the row on one line, so its list overflows when it does not fit. */
  oneLine?: boolean | undefined;
  /** The row's list, to measure. */
  listRef?: Ref<HTMLUListElement> | undefined;
}

/** A panel item, by its `links` or `content`; an untyped item with `href` too is still a panel. */
function isPanel(item: NavigationMenuItem): item is NavigationMenuPanelItem {
  return item.links !== undefined || item.content !== undefined;
}

/**
 * The NavigationMenu without its development checks: Navbar's row.
 *
 * @internal Shared by NavigationMenu and Navbar; apps use those.
 */
export function NavigationMenuView(props: NavigationMenuViewProps): JSX.Element {
  const { label, items, currentPath, className, ref, oneLine, listRef } = props;
  // Controlled, so a link in a panel's content can close it.
  const [value, setValue] = useState<number | null>(null);
  const [instant, setInstant] = useState(false);

  // A link's own `current` wins; otherwise the path decides, across the row and the panels.
  const all = items.flatMap((item): ReadonlyArray<{ href: string; current?: boolean | undefined }> =>
    isPanel(item) ? (item.links ?? []) : [item],
  );
  const marked = all.some((link) => link.current)
    ? undefined
    : currentHref(
        all.map((link) => link.href),
        currentPath,
      );
  const isCurrent = (link: { href: string; current?: boolean | undefined }) => Boolean(link.current) || link.href === marked;
  // The page itself is the current page; a link above it, the section it is in, is current but not the page.
  const currentOf = (link: { href: string; current?: boolean | undefined }) =>
    !isCurrent(link) ? undefined : link.current || samePath(link.href, currentPath) ? ("page" as const) : ("true" as const);
  const closeOnLink = (event: ReactMouseEvent) => {
    if ((event.target as Element).closest("a[href]")) setValue(null);
  };

  const portal = usePortalContainer("NavigationMenu");
  return (
    <BaseNavigationMenu.Root
      ref={ref}
      data-ouro="navigation-menu"
      aria-label={label}
      value={value}
      onValueChange={(next, { event }) => {
        // A key press, or the click a key press makes (detail 0), opens and closes at once.
        setInstant(event.type === "keydown" || (event.type === "click" && (event as MouseEvent).detail === 0));
        setValue(next as number | null);
      }}
      className={cn("min-w-0", className)}
    >
      <BaseNavigationMenu.List ref={listRef} className={cn("m-0 flex list-none items-center gap-1 p-0", oneLine ? "flex-nowrap" : "flex-wrap")}>
        {items.map((item, index) =>
          isPanel(item) ? (
            <BaseNavigationMenu.Item key={index} value={index}>
              <BaseNavigationMenu.Trigger data-current={item.links?.some(isCurrent) ? "" : undefined} data-ouro-control="navigation-menu" data-ouro-part="trigger" className={rowItem}>
                {item.label}
                <BaseNavigationMenu.Icon data-ouro-instant={instant ? "" : undefined} className={chevron}>
                  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-3.5">
                    <path d="m4 6 4 4 4-4" />
                  </svg>
                </BaseNavigationMenu.Icon>
              </BaseNavigationMenu.Trigger>
              <BaseNavigationMenu.Content
                data-ouro-instant={instant ? "" : undefined}
                data-wide={item.content !== undefined || item.columns === 2 ? "" : undefined}
                className={panel}
              >
                <div className={cn("grid gap-2", item.content !== undefined && item.links !== undefined && "sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]")}>
                  {item.content !== undefined && (
                    // A link in the content closes the panel, as the list's links do.
                    <div data-ouro-navigation-menu-content="" onClick={closeOnLink} className="min-w-0">
                      {item.content}
                    </div>
                  )}
                  {item.links !== undefined && (
                    <ul className={cn("m-0 grid list-none gap-1 p-0", item.columns === 2 && "sm:grid-cols-2")}>
                      {item.links.map((link, position) => (
                        <li key={position}>
                          <BaseNavigationMenu.Link
                            render={<RouterLink href={link.href} />}
                            active={currentOf(link) === "page"}
                            aria-current={currentOf(link)}
                            closeOnClick
                            data-ouro-control="navigation-menu"
                            data-ouro-part="panel-link"
                            className={panelLink}
                          >
                            <span className={cn("font-medium", panelLabel, isCurrent(link) && "font-semibold underline")}>{link.label}</span>
                            {link.description !== undefined && <span className="text-sm leading-5 text-muted-foreground">{link.description}</span>}
                          </BaseNavigationMenu.Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </BaseNavigationMenu.Content>
            </BaseNavigationMenu.Item>
          ) : (
            <BaseNavigationMenu.Item key={index} value={index}>
              <BaseNavigationMenu.Link
                render={<RouterLink href={item.href} />}
                active={currentOf(item) === "page"}
                aria-current={currentOf(item)}
                data-ouro-control="navigation-menu"
                data-ouro-part="link"
                className={rowItem}
              >
                {item.label}
              </BaseNavigationMenu.Link>
            </BaseNavigationMenu.Item>
          ),
        )}
      </BaseNavigationMenu.List>
      <BaseNavigationMenu.Portal {...portal} data-ouro="navigation-menu-portal" className={floatingPortalClass}>
        <PortalScope>
          <BaseNavigationMenu.Positioner sideOffset={8} collisionPadding={16} className={positioner}>
            <BaseNavigationMenu.Popup data-ouro="navigation-menu-popup" data-ouro-instant={instant ? "" : undefined} className={popup}>
              <BaseNavigationMenu.Viewport className="relative h-full w-full overflow-hidden rounded-[inherit]" />
            </BaseNavigationMenu.Popup>
          </BaseNavigationMenu.Positioner>
        </PortalScope>
      </BaseNavigationMenu.Portal>
    </BaseNavigationMenu.Root>
  );
}
