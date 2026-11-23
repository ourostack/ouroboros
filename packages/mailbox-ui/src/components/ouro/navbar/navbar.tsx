"use client";

import { startTransition, useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { currentHref, samePath } from "@/lib/ouro/current-path";
import { RouterLink } from "@/lib/ouro/router-link";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { useMediaQuery } from "@/lib/ouro/use-media-query";
import { Button } from "@/components/ouro/button/button";
import { NavigationMenuView } from "@/components/ouro/navigation-menu/navigation-menu";
import { SheetFrame } from "@/components/ouro/sheet/sheet";
import { willOverflow } from "./navbar-styles";

/** One link in a Navbar: in the bar, or in a group's panel. */
export interface NavbarLink {
  /** The link's text: "Recipes". */
  label: string;
  /** Where it goes. Internal paths go through `OuroProvider`'s `linkComponent` (your router's link). */
  href: string;
  /**
   * In a group: a line under the label in the bar's panel, "Everything you have saved."
   *
   * @claim "In a group: a line under" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar at tablet widths and with groups > opens a group of links as a panel in the bar)
   */
  description?: string | undefined;
  /**
   * Marks this link as the current page (`aria-current="page"`), when the Navbar's
   * `currentPath` cannot tell: a link whose page lives at another path.
   */
  current?: boolean | undefined;
  /** Not with `href`. An item is a link (`href`) or a group of links (`links`). */
  links?: never;
}

/** A group of links in a Navbar: a button that opens a panel in the bar, and a labelled group in the sheet. */
export interface NavbarGroup {
  /** The group's name, the button's text: "Recipes". */
  label: string;
  /**
   * The group's links, each with an optional `description`.
   *
   * @claim "The group's links, each with an" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar at tablet widths and with groups > closes the sheet when the links come to fit)
   */
  links: readonly NavbarLink[];
  /** Not with `links`. To link the section's own page, make it the group's first link. */
  href?: never;
}

/** One item of a Navbar: a link (`href`), or a group of links (`links`). */
export type NavbarItem = NavbarLink | NavbarGroup;

/** Props for {@link Navbar}. */
export interface NavbarProps {
  /** Names the navigation for screen readers ("Main"). It is not shown. */
  label: string;
  /**
   * The links, in order, and groups of links (`{ label, links }`), which open a panel in the
   * bar. When they do not fit, as on a phone, they move into a sheet.
   */
  items: readonly NavbarItem[];
  /**
   * The path of the page being shown, from your router (`useLocation().pathname`, or
   * `usePathname()` in Next.js). The link to that path gets `aria-current="page"` and the
   * current look. On a deeper page, the longest link above it, the section
   * (`/recipes` for `/recipes/12`), gets the same look and `aria-current="true"`, so a
   * screen reader hears one current page.
   */
  currentPath?: string | undefined;
  /** Your logo or product name, at the start of the bar. Link it to the home page. */
  brand?: ReactNode;
  /**
   * Controls at the end of the bar, at every width: a search button, an account `Menu`.
   *
   * @claim "Controls at the end of the" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > shows the brand at the start and the actions at the end)
   */
  actions?: ReactNode;
  /**
   * The name of the button that opens the links below `collapseBelow` (640px by default), and the title of the sheet
   * it opens. @default "Menu"
   * @claim "The name of the button that" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > collapses the links into a sheet behind a menu button below 640px)
   * @claim "The name of the button that" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > hides the menu button from 640px up)
   */
  menuLabel?: string | undefined;
  /**
   * What the sheet behind the menu button holds in place of the `items` links, when a phone
   * needs more than the bar, such as a section's own pages under its name, or a filter over a
   * long list. It replaces them, so list the links they held too. It sits in the sheet's `nav`;
   * mark the current page yourself (`aria-current="page"`). Choosing a link in it closes the
   * sheet. Once the page has been idle it mounts, hidden, ahead of the first press (a press
   * before then mounts it as it opens), and it mounts afresh the same way after each close, so
   * each open starts with the state it first had.
   *
   * @claim "Choosing a link in it closes the sheet." registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > shows the menu prop in the sheet in place of the links, and closes it when a link there is chosen)
   * @claim "Once the page has been idle" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > builds the sheet while the page is idle once the menu button shows, and keeps it, hidden, between opens)
   * @claim "so each open starts with the" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > opens afresh after each close: the menu prop's state and the sheet's scroll as the first open had them)
   */
  menu?: ReactNode;
  /** The label of that sheet's close button. @default "Close" */
  closeLabel?: string | undefined;
  /**
   * The Tailwind breakpoint below which the links collapse behind the menu button: `sm`, `md`, `lg` or `xl`. The server HTML
   * and the first paint use it too, so the bar matches on hydration at every width. Use `lg` when the links need more room
   * than a tablet's bar has. @default "sm"
   * @claim "The Tailwind breakpoint below which the links collapse" test/navbar-first-paint.test.tsx verify:testExists(test/navbar-first-paint.test.tsx::Navbar's collapse breakpoint > with collapseBelow lg, the menu shows below lg and the links from lg up)
   * @claim "The server HTML and the first paint use it too" test/navbar-first-paint.test.tsx verify:testExists(test/navbar-first-paint.test.tsx::Navbar's collapse breakpoint > with collapseBelow lg, is the same bar at 390, 768, 1024 and 1440, server HTML and hydrated, with nothing swapped)
   */
  collapseBelow?: "sm" | "md" | "lg" | "xl" | (string & { "one of sm, md, lg, xl": never }) | undefined;
  /** Layout only: margins, position (`sticky top-0`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLElement> | undefined;

  /** Not a prop. Ouro UI uses `items`: `<Navbar label="Main" items={[{ label: "Recipes", href: "/recipes" }]} />`. */
  links?: { 'Use <Navbar label="Main" items={[{ label: "Recipes", href: "/recipes" }]} />': never };
  /** Not a prop. Ouro UI uses `brand`: `<Navbar brand={<Logo />}>`. */
  logo?: { "Use <Navbar brand={<Logo />}>": never };
  /** Not a prop. Ouro UI uses `currentPath`: `<Navbar currentPath={pathname}>`. */
  pathname?: { "Use <Navbar currentPath={pathname}>": never };
  /** Not rendered. The bar is `items`, `brand` and `actions`. */
  children?: { "Use items={[{ label, href }]}, brand={...} and actions={...}": never };
}

// Class strings are literal so the app's Tailwind finds them when it compiles. Each breakpoint is one of Tailwind's, the
// media query the script reads, and the classes that show or hide the two forms and wrap the bar below it.
const breakpoints = {
  sm: { query: "(min-width: 40rem)", show: "sm:hidden", hide: "max-sm:hidden", wrap: "max-sm:flex-wrap max-sm:py-1" },
  md: { query: "(min-width: 48rem)", show: "md:hidden", hide: "max-md:hidden", wrap: "max-md:flex-wrap max-md:py-1" },
  lg: { query: "(min-width: 64rem)", show: "lg:hidden", hide: "max-lg:hidden", wrap: "max-lg:flex-wrap max-lg:py-1" },
  xl: { query: "(min-width: 80rem)", show: "xl:hidden", hide: "max-xl:hidden", wrap: "max-xl:flex-wrap max-xl:py-1" },
} as const;

// Below the collapse breakpoint the links are always behind the menu button, so a wrap there changes no measure of theirs;
// from it up the links' room decides whether the menu button shows, and a wrap would change that room.
const bar =
  "box-border flex min-h-14 items-center gap-2 border-0 border-b border-solid border-border bg-background text-foreground " +
  "ps-[max(1rem,env(safe-area-inset-left,0px))] pe-[max(1rem,env(safe-area-inset-right,0px))]";

// A link: 44px with 16px text on a coarse pointer at every width, 36px with 14px text with a
// fine one. The current page, or the section it is in, is underlined in the primary colour as in the bar's row and in
// FamilyBar, not given a hover highlight; forced colours keep the underline.
const link_ =
  "relative m-0 box-border items-center rounded-ouro-md px-3 font-medium text-muted-foreground no-underline select-none touch-manipulation " +
  "text-base pointer-fine:text-sm leading-5 [-webkit-tap-highlight-color:transparent] " +
  "pointer-fine:hover:bg-accent pointer-fine:hover:text-accent-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground aria-[current=true]:font-semibold aria-[current=true]:text-foreground " +
  "aria-[current=page]:underline aria-[current=true]:underline decoration-primary decoration-2 underline-offset-5 [text-decoration-skip-ink:none] " +
  "outline-ring -outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid";
// In the sheet a link is a full-width row, which highlights while pressed instead of scaling.
const sheetLink = "flex min-h-ouro-11 pointer-fine:min-h-9 py-2 transition-colors duration-(--ouro-duration-fast) ease-[ease] active:bg-accent active:text-accent-foreground";

const list_ = "m-0 flex list-none p-0";
const example = '<Navbar label="Main" items={[{ label: "Recipes", href: "/recipes" }]}';

/**
 * The bar across the top of an app: your brand, the main links and a few controls, with
 * the current page marked `aria-current="page"`, and the link of the section it is in `aria-current="true"`, both underlined in the primary colour as in `FamilyBar`, distinct from hover and press highlights. A group of links (`{ label, links }`)
 * opens a panel, as in `NavigationMenu`. Whenever the links do not fit, below the `collapseBelow` breakpoint and
 * wherever they overflow the bar, they collapse behind a menu button into a `Sheet` that slides in from
 * the side, with each group under its name; the brand and `actions` stay in the bar. When, below the collapse breakpoint,
 * even the brand and `actions` do not fit side by side (large text on a phone), the actions
 * move to a second row rather than off the screen. Links render through `OuroProvider`'s `linkComponent`,
 * so your router navigates.
 *
 * The phone menu opens once JavaScript has loaded (after hydration). Both the links and the menu button are in the
 * server HTML, and CSS shows one of them at the `collapseBelow` breakpoint, so the bar does not change when the page hydrates; only links
 * that do not fit the bar, on a tablet, collapse once the page has measured them. A tap on the menu button before then
 * does nothing unless your app keeps it: this site's head script keeps a tap on any control React has not yet hydrated, shows
 * the control pressed, and presses it again once it has (`site/src/early-input.ts` in the
 * repository). Once the menu button shows, the sheet is built while the page is idle and kept,
 * hidden, between opens, so a press only shows it.
 *
 * Use `Sidebar` instead for more than a handful of destinations, or sections of them. Use
 * `NavigationMenu` alone for a row of panels inside a page, and `Tabs` for views of one
 * page. `StackedLayout` puts a Navbar above the page.
 *
 * @group Navigation
 * @see https://ui.ouroboros.bot/docs/navbar
 *
 * @example
 * <Navbar
 *   label="Main"
 *   brand={<Link href="/">Spoonjoy</Link>}
 *   items={[
 *     { label: "Recipes", href: "/recipes" },
 *     { label: "Cookbooks", href: "/cookbooks" },
 *   ]}
 *   currentPath={pathname}
 *   actions={<Button href="/recipes/new">New recipe</Button>}
 * />
 * @claim "Whenever the links do not fit" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar at tablet widths and with groups > collapses into the menu button whenever its links do not fit, from 640px up too)
 * @claim "Whenever the links do not fit" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > collapses the links into a sheet behind a menu button below 640px)
 * @claim "Whenever the links do not fit" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar at tablet widths and with groups > puts a group's button and the bar's links in the server HTML)
 * @claim "The phone menu opens once JavaScript" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > collapses the links into a sheet behind a menu button below 640px)
 * @claim "The phone menu opens once JavaScript" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar at tablet widths and with groups > puts a group's button and the bar's links in the server HTML)
 * @claim "this site's head script keeps a tap" site/e2e/early-input.spec.ts verify:fileLine(site/e2e/early-input.spec.ts, /a tap on the menu button before the page's script has run opens the menu/) verify:fileLine(site/src/early-input.ts, /export function keepEarlyInput/)
 * @claim "the sheet is built while the page is" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > builds the sheet while the page is idle once the menu button shows, and keeps it, hidden, between opens)
 * @claim "When, below the collapse breakpoint, even the brand and `actions` do not fit side by side" registry/ouro/components/ouro/navbar/navbar.test.tsx verify:testExists(registry/ouro/components/ouro/navbar/navbar.test.tsx::Navbar > moves its actions to a second row when they and the brand do not fit beside each other, as with large text)
 * @claim "Both the links and the menu button are in the server HTML" test/navbar-first-paint.test.tsx verify:testExists(test/navbar-first-paint.test.tsx::Navbar's first paint > is the same bar on a phone, server HTML and hydrated, with nothing swapped)
 */
export function Navbar(props: NavbarProps): JSX.Element {
  const {
    label,
    items,
    currentPath,
    brand,
    actions,
    menuLabel = "Menu",
    menu,
    closeLabel = "Close",
    collapseBelow = "sm",
    className,
    ref,
    // Guard props (hint types), dropped here so they never reach the DOM.
    links,
    logo,
    pathname,
    children,
  } = props;
  useAppearanceClassNameCheck(
    "Navbar",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; Navbar sets its own look`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Navbar",
    process.env.NODE_ENV !== "production"
      ? () => [
          !label && ["label is required; it names the navigation for screen readers", '<Navbar label="Main">'],
          links !== undefined && ["links is not a prop", `${example} />`],
          logo !== undefined && ["logo is not a prop", "<Navbar brand={<Logo />}>"],
          pathname !== undefined && ["pathname is not a prop", "<Navbar currentPath={pathname}>"],
          children !== undefined && ["children are not rendered", `${example} brand={…} actions={…} />`],
          !Object.hasOwn(breakpoints, collapseBelow) && ["collapseBelow is not a breakpoint; it takes sm, md, lg or xl", '<Navbar collapseBelow="lg">'],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );

  // The unknown value, which the development check names, renders as sm.
  const breakpoint = Object.hasOwn(breakpoints, collapseBelow) ? breakpoints[collapseBelow as keyof typeof breakpoints] : breakpoints.sm;
  // Both forms are in the server HTML, and CSS shows one: the links from the collapse breakpoint up, the menu button below it.
  // This query is that same breakpoint, in rem as the Tailwind classes are, so the sheet's script and the CSS agree at any root font size.
  // The links also collapse wherever they do not fit the bar, which only the measure below can tell.
  // Stryker disable next-line BooleanLiteral: the server default feeds only the hydration render, which draws the same bar either way; the sheet's build waits for an effect that reads the live value.
  const wide = useMediaQuery(breakpoint.query, true);
  const [overflow, setOverflow] = useState(false);
  const collapsed = !wide || overflow;
  const [open, setOpen] = useState(false);
  // Focus goes back to the menu button when the sheet closes, in every browser.
  const menuButton = useRef<HTMLButtonElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  if (!collapsed && open) setOpen(false);
  // Once the menu button shows, the sheet is built while the page is idle, so a press only shows it: building it then
  // (a long menu is hundreds of elements) would hold up the press's first frame. Kept from then on, hidden while closed,
  // and built afresh once each close has finished, so every open starts as the first did: the `menu` prop's own state
  // (a filter's text, a list unfolded) and the sheet's scroll left behind.
  const [built, setBuilt] = useState(false);
  // The sheet's content goes in on a later turn than its frame: a transition renders in slices, but commits in one, and
  // the docs' menu and the sheet's frame together held a frame of 110 ms on CI's WebKit (ourostack/ouro-ui#670).
  const [filled, setFilled] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!collapsed || filled) return;
    // As a transition, which React renders in slices that leave the frames between them free: built in one go, a long
    // menu held a frame past 100 ms on a slow screen. A press in the middle opens the sheet as it is.
    const build = () => startTransition(() => (built ? setFilled(true) : setBuilt(true)));
    // Where the browser has no idle callback (Safari), after the page's other start-up work, and the content a beat later.
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(build, built ? 100 : 500);
      return () => clearTimeout(timer);
    }
    // Stryker disable next-line ObjectLiteral: the timeout only bounds a page that is never idle, which no test page is.
    const idle = requestIdleCallback(build, { timeout: 2000 });
    return () => cancelIdleCallback(idle);
    // `round` too: a close sets `filled` back, which changes nothing when the last content's transition had not committed
    // yet (a loaded runner), and the fresh sheet must still ask for its content's turn.
  }, [collapsed, built, filled, round]);

  // Before paint, so a client mount never shows a row that does not fit.
  useLayoutEffect(() => {
    const measure = () => {
      // The room the links would have: the slot, and the menu button's place when it shows. Its own negative
      // margin (-ms-ouro-2) already gives back the one gap its appearing adds to the row, so its offsetWidth
      // alone is the room the slot loses when it shows, not offsetWidth plus a gap on top of that.
      const button = menuButton.current!.offsetWidth;
      const room = slot.current!.clientWidth + button;
      const needed = list.current!.scrollWidth;
      setOverflow((was) => willOverflow(was, needed, room));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot.current!);
    observer.observe(list.current!);
    return () => observer.disconnect();
  }, []);

  // An item's own `current` wins; otherwise the path decides, across the links and the groups.
  const all = items.flatMap((item): ReadonlyArray<{ href: string; current?: boolean | undefined }> => (item.links !== undefined ? item.links : [item]));
  const marked = all.some((link) => link.current)
    ? undefined
    : currentHref(
        all.map((link) => link.href),
        currentPath,
      );
  const id = useId();
  const sheetLinkFor = (link: { label: string; href: string; current?: boolean | undefined }, key: number) => (
    <li key={key}>
      <RouterLink
        href={link.href}
        aria-current={link.current || (link.href === marked && samePath(link.href, currentPath)) ? "page" : link.href === marked ? "true" : undefined}
        data-ouro-control="navbar"
        data-ouro-part="sheet-link"
        className={cn(link_, sheetLink)}
      >
        {link.label}
      </RouterLink>
    </li>
  );

  return (
    <header ref={ref} data-ouro="navbar" className={cn(bar, breakpoint.wrap, className)}>
      <Button
        ref={menuButton}
        data-ouro-navbar-menu=""
        data-ouro-control="navbar"
        data-ouro-part="menu"
        variant="plain"
        tone="secondary"
        aria-label={menuLabel}
        // In the server HTML at every width, so the bar never changes on hydration: where the button is hidden it is out of
        // the tree, and where it shows it opens the sheet.
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn("-ms-ouro-2 w-ouro-11 px-0", !overflow && breakpoint.show)}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-ouro-5">
          <path d="M3 5.5h14M3 10h14M3 14.5h14" />
        </svg>
      </Button>
      {brand !== undefined && <div className="flex min-w-0 shrink-0 items-center">{brand}</div>}
      {/* The links' slot takes the room between the brand and the actions; hidden but measured when they do not fit. */}
      <div ref={slot} data-ouro-navbar-links="" className={cn("min-w-0 flex-1 overflow-hidden", breakpoint.hide, overflow && "invisible")}>
        <NavigationMenuView label={label} items={items} currentPath={currentPath} oneLine listRef={list} />
      </div>
      {actions !== undefined && <div className="ms-auto flex shrink-0 items-center gap-2">{actions}</div>}
      <SheetFrame
        key={round}
        onOpenChangeComplete={(shown) => {
          if (shown) return;
          // Stryker disable next-line ArithmeticOperator: any key the sheet has not had builds it afresh, a count down as well as up.
          setRound((count) => count + 1);
          // The fresh sheet, too, takes its frame now and its content on a later turn (ourostack/ouro-ui#670).
          setFilled(false);
        }}
        keepMounted={built}
        title={menuLabel}
        closeLabel={closeLabel}
        side="left"
        open={open}
        onOpenChange={setOpen}
        finalFocus={menuButton}
      >
        <nav
          aria-label={label}
          // A link chosen in the sheet closes it: the items' links, and any in the menu prop. Not one opened elsewhere (a new
          // tab or window, with a modifier key held): the page stays, and so does the sheet. A router's link that handles the
          // click itself still closes it.
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if ((event.target as Element).closest("a[href]")) setOpen(false);
          }}
        >
          {!open && !filled ? null : menu ?? (
            <ul className={cn(list_, "flex-col gap-1")}>
              {items.map((item, index) =>
                item.links !== undefined ? (
                  <li key={index} className="grid gap-1 pt-3 first:pt-0">
                    <p id={`${id}${index}`} className="m-0 px-3 py-1 text-xs leading-4 font-medium text-muted-foreground">
                      {item.label}
                    </p>
                    <ul aria-labelledby={`${id}${index}`} className={cn(list_, "flex-col gap-1")}>
                      {item.links.map(sheetLinkFor)}
                    </ul>
                  </li>
                ) : (
                  sheetLinkFor(item, index)
                ),
              )}
            </ul>
          )}
        </nav>
      </SheetFrame>
    </header>
  );
}
