"use client";

import { isValidElement, useId, useRef, useState, type JSX, type MouseEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { currentHref } from "@/lib/ouro/current-path";
import { RouterLink } from "@/lib/ouro/router-link";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { useMediaQuery } from "@/lib/ouro/use-media-query";
import { Button } from "@/components/ouro/button/button";
import { Menu, MenuItem } from "@/components/ouro/menu/menu";
import { SheetFrame } from "@/components/ouro/sheet/sheet";
import { Tooltip } from "@/components/ouro/tooltip/tooltip";

/**
 * What every Sidebar item has: its text, an icon and a badge.
 *
 * @claim "What every Sidebar item has: its" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar items > shows a badge after the label, read as part of the link's name, and keeps it in the name on the rail)
 * @claim "What every Sidebar item has: its" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > hides the icons from screen readers)
 * @claim "What every Sidebar item has: its" registry/ouro/components/ouro/sidebar/sidebar.test-d.ts verify:fileLine(registry/ouro/components/ouro/sidebar/sidebar.test-d.ts, /expectTypeOf<\{\slabel:\s"New\schat";\sonClick:\s\(\)\s=>\svoid;\scurrent:\strue\s\}>\(\)\.not\.toExtend<SidebarItem>/)
 */
interface SidebarItemBase {
  /** The item's text: "Recipes". It stays the item's name when the sidebar is collapsed. */
  label: string;
  /**
   * An icon before the label, as an element: `icon: <BookIcon />`. It is hidden from screen
   * readers. Collapsed, the sidebar shows only the icons; an item without one shows its
   * first letter.
   */
  icon?: ReactNode;
  /**
   * A short count or tag after the label: `badge: 12`, `badge: "New"`, drawn as a muted tag. An
   * element (`badge: <Badge tone="warning">Busy</Badge>`) is drawn as it is, with no tag around it.
   * It is read as part of the item's name, and hidden from sight when the sidebar is collapsed.
   * @claim "element (`badge: <Badge" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar items > draws a badge given as an element as it is, with no muted tag around it, at the row's end)
   */
  badge?: ReactNode;
}

/** A link in a Sidebar. */
export interface SidebarLinkItem extends SidebarItemBase {
  /** Where it goes. Internal paths go through `OuroProvider`'s `linkComponent` (your router's link). */
  href: string;
  /**
   * Marks this link as the current page (`aria-current="page"`), when the Sidebar's
   * `currentPath` cannot tell: a link whose page lives at another path.
   */
  current?: boolean | undefined;
  /** Called when the link is followed, before your router navigates. */
  onClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /** Not with `href`. Nested links go in an item without `href`: `{ label: "Settings", items: [...] }`. */
  items?: never;
}

/** A button in a Sidebar, for an action rather than a page: "New chat", "Search" opening a `Command`. */
export interface SidebarButtonItem extends SidebarItemBase {
  /** What the button does. In the phone's drawer, the drawer closes first. */
  onClick: (event: MouseEvent<HTMLElement>) => void;
  /** Not with `onClick` alone. Give a link `href`; a button has none. */
  href?: never;
  /** Not on a button. Only a link can be the current page. */
  current?: never;
  /** Not on a button. Nested links go in an item without `onClick`: `{ label: "Settings", items: [...] }`. */
  items?: never;
}

/**
 * An item with links nested under it, one level deep: a button that shows and hides them.
 * It starts open when it holds the current page. On the collapsed rail the button opens
 * them in a `Menu` beside it.
 */
export interface SidebarGroupItem extends SidebarItemBase {
  /** The nested links and buttons. They do not nest further. */
  items: readonly (SidebarLinkItem | SidebarButtonItem)[];
  /** Not with `items`. To link the group's own page, make it the group's first item. */
  href?: never;
  /** Not with `items`; the group's button shows and hides them. */
  onClick?: never;
  /** Not on a group. One of its links is the current page. */
  current?: never;
}

/** One item of a Sidebar: a link (`href`), a button (`onClick`), or links nested under a button (`items`). */
export type SidebarItem = SidebarLinkItem | SidebarButtonItem | SidebarGroupItem;

/** A group of links in a Sidebar, under an optional label. */
export interface SidebarSection {
  /** The group's name, shown above its links: "Library". */
  label?: string | undefined;
  /** The group's items, in order: links, buttons and nested links. */
  items: readonly SidebarItem[];
}

/** Props for {@link Sidebar}. */
export interface SidebarProps {
  /** Names the navigation for screen readers ("Main"). It is not shown. */
  label: string;
  /** The links, in groups: `sections={[{ items: [...] }, { label: "Library", items: [...] }]}`. */
  sections: readonly SidebarSection[];
  /**
   * The path of the page being shown, from your router (`useLocation().pathname`, or
   * `usePathname()` in Next.js). The link to that path, or else the longest link above it
   * (`/recipes` for `/recipes/12`), gets `aria-current="page"` and the current look.
   */
  currentPath?: string | undefined;
  /** Above the links: your logo, product name or a workspace `Menu`. Clipped to the rail when collapsed. */
  header?: ReactNode;
  /** Below the links: the signed-in person, an account `Menu`. Clipped to the rail when collapsed. */
  footer?: ReactNode;
  /**
   * Whether the sidebar has a button that collapses it to a rail of icons, from 640px up.
   * @default true
   * @claim "Whether the sidebar has a button" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > collapses to a rail of icons with the toggle, keeping each link's name)
   * @claim "Whether the sidebar has a button" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > hides the menu button from 640px up)
   */
  collapsible?: boolean | undefined;
  /** Whether the sidebar is collapsed, when you control it (to remember it). Pair it with `onCollapsedChange`. */
  collapsed?: boolean | undefined;
  /** Whether the sidebar starts collapsed, when it keeps its own state. @default false */
  defaultCollapsed?: boolean | undefined;
  /** Called with the new state when the person collapses or expands the sidebar. */
  onCollapsedChange?: ((collapsed: boolean) => void) | undefined;
  /** The collapse button's name and text; `aria-pressed` says whether it is on. @default "Collapse sidebar" */
  collapseLabel?: string | undefined;
  /**
   * Below 640px: the name of the button that opens the sidebar as a drawer, and the
   * drawer's title (shown when there is no `header`). @default "Menu"
   * @claim "Below 640px: the name of the" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > becomes a menu button that opens a drawer below 640px)
   * @claim "Below 640px: the name of the" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > hides the menu button from 640px up)
   * @claim "Below 640px: the name of the" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > closes the drawer when the screen grows past 640px)
   */
  menuLabel?: string | undefined;
  /** The label of the drawer's close button. @default "Close" */
  closeLabel?: string | undefined;
  /** Layout only: grid placement and margins (`row-span-2`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;

  /** Not a prop. Links go in `sections`: `sections={[{ items: [{ label: "Recipes", href: "/recipes" }] }]}`. */
  items?: { 'Use sections={[{ items: [{ label: "Recipes", href: "/recipes" }] }]}': never };
  /** Not a prop. Ouro UI uses `collapsed` with `onCollapsedChange`, or `defaultCollapsed`. */
  isCollapsed?: { "Use <Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed}>": never };
  /** Not a prop. Ouro UI uses `currentPath`: `<Sidebar currentPath={pathname}>`. */
  pathname?: { "Use <Sidebar currentPath={pathname}>": never };
  /** Not rendered. The sidebar is `sections`, `header` and `footer`. */
  children?: { "Use sections={[{ items: [{ label, href }] }]}, header={...} and footer={...}": never };
}

// Class strings are literal so the app's Tailwind finds them when it compiles.

// The column: --ouro-sidebar-w, which the app may set on the Sidebar or around it, else 16rem; or a rail (a 44px target,
// its padding and the border) when collapsed. The width changes at once: layout does not animate.
const column =
  "box-border flex h-full w-[var(--ouro-sidebar-w,16rem)] flex-col overflow-hidden border-0 border-e border-solid border-border bg-background text-foreground " +
  "data-collapsed:w-[calc(3.75rem+1px)] max-sm:hidden";

// A count or tag at the row's end. Its muted text is mixed 20% toward the foreground, so it keeps
// 4.5:1 on the muted tag under shadcn's stock values too (plain text-muted-foreground is 4.34:1).
const badgeClass = "ms-auto shrink-0 rounded-ouro-sm bg-muted px-1.5 text-xs leading-5 font-medium text-[color-mix(in_oklab,var(--muted-foreground)_80%,var(--foreground))] tabular-nums";
// A badge given as an element (`badge: <Badge>Idle</Badge>`) brings its own look, so it sits bare at the row's end (the label
// takes the room before it):
// the muted tag drawn around it too would be a frame in a frame, its corners off by the inner radius.
const badgeSlot = (badge: ReactNode) => (isValidElement(badge) ? undefined : badgeClass);

// A row: 44px with 16px text on a coarse pointer at every width, 36px with 14px text with a
// fine one. A full-width row highlights while pressed instead of scaling.
const row =
  "relative m-0 box-border flex w-full min-h-ouro-11 pointer-fine:min-h-9 cursor-pointer items-center gap-3 rounded-ouro-md border-0 forced-colors:border forced-colors:border-solid bg-transparent px-3 py-2 " +
  "text-start font-[inherit] text-base pointer-fine:text-sm leading-5 font-medium text-muted-foreground no-underline select-none touch-manipulation " +
  "[-webkit-tap-highlight-color:transparent] transition-colors duration-(--ouro-duration-fast) ease-[ease] " +
  "pointer-fine:hover:bg-accent pointer-fine:hover:text-accent-foreground active:bg-accent active:text-accent-foreground " +
  "aria-[current=page]:font-semibold aria-[current=page]:text-foreground " +
  "aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2 aria-[current=page]:before:start-0 aria-[current=page]:before:w-ouro-0_5 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-current aria-[current=page]:before:content-[''] " +
  "forced-colors:aria-[current=page]:before:border-s-2 forced-colors:aria-[current=page]:before:border-solid forced-colors:aria-[current=page]:before:border-current " +
  "outline-ring -outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid";
const railRow = "justify-center px-0";
const iconSlot = "flex size-ouro-5 shrink-0 items-center justify-center text-sm [&_svg]:size-ouro-5 [&_svg]:shrink-0";
const list = "m-0 grid grid-cols-1 list-none gap-1 p-0";
const example = '<Sidebar label="Main" sections={[{ items: [{ label: "Recipes", href: "/recipes" }] }]}';

/**
 * The column of links down the side of an app, in sections, with the current page marked
 * `aria-current="page"` and a bar at the start edge, distinct from hover and press highlights. An item can carry a `badge` ("Inbox 12"), be a button (`onClick`
 * without `href`), or hold one level of nested links (`items`). From 640px up it fills its
 * container's height and collapses to a rail of icons with its own button, each named by a
 * `Tooltip`, where an item with nested links opens them in a `Menu`; below 640px it is a menu button that opens the same links as a `Sheet`
 * drawer. Links render through `OuroProvider`'s `linkComponent`, so your router navigates.
 * It is 16rem wide; set `--ouro-sidebar-w` on it or around it for another width (`className="[--ouro-sidebar-w:12rem]"`).
 *
 * The phone menu opens once JavaScript has loaded (after hydration);
 * the links are in the server HTML from 640px up.
 *
 * Put it in a `SidebarLayout`, which places it beside the page and in the phone's top bar.
 * Use `Navbar` instead for a handful of links across the top, `NavigationRail` for a narrow bar
 * of the app's top-level pages, each an icon over its label, and `Tabs` for views of one page.
 *
 * @group Navigation
 * @see https://ui.ouroboros.bot/docs/sidebar
 *
 * @example
 * <Sidebar
 *   label="Main"
 *   header={<Link href="/">Spoonjoy</Link>}
 *   sections={[
 *     { items: [{ label: "Recipes", href: "/recipes", icon: <BookIcon /> }] },
 *     { label: "Library", items: [{ label: "Cookbooks", href: "/cookbooks", icon: <StackIcon /> }] },
 *   ]}
 *   currentPath={pathname}
 * />
 * @claim "From 640px up it fills its" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > becomes a menu button that opens a drawer below 640px)
 * @claim "From 640px up it fills its" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > hides the menu button from 640px up)
 * @claim "From 640px up it fills its" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > closes the drawer when the screen grows past 640px)
 * @claim "It is 16rem wide; set `--ouro-sidebar-w`" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > takes its width from --ouro-sidebar-w, set on it or around it, and is still a rail when collapsed)
 * @claim "The phone menu opens once JavaScript" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > puts the nav and its links in the server HTML)
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const {
    label,
    sections,
    currentPath,
    header,
    footer,
    collapsible = true,
    collapsed: collapsedProp,
    defaultCollapsed = false,
    onCollapsedChange,
    collapseLabel = "Collapse sidebar",
    menuLabel = "Menu",
    closeLabel = "Close",
    className,
    ref,
    // Guard props (hint types), dropped here so they never reach the DOM.
    items,
    isCollapsed,
    pathname,
    children,
  } = props;
  useAppearanceClassNameCheck(
    "Sidebar",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; Sidebar sets its own look`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  const group = sections.flatMap((section) => section.items).find((item) => item.items !== undefined);
  useDevWarnings(
    "Sidebar",
    process.env.NODE_ENV !== "production"
      ? () => [
          !label && ["label is required; it names the navigation for screen readers", '<Sidebar label="Main">'],
          collapsedProp !== undefined &&
            collapsible &&
            onCollapsedChange === undefined && [
              "collapsed without onCollapsedChange cannot be toggled",
              "<Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed}> or defaultCollapsed",
            ],
          collapsedProp === true &&
            onCollapsedChange === undefined &&
            group !== undefined && [
              `collapsed without onCollapsedChange cannot expand, so "${group.label}" shows its links only in a menu`,
              "<Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed}> or defaultCollapsed",
            ],
          items !== undefined && ["items is not a prop; links go in sections", `${example} />`],
          isCollapsed !== undefined && ["isCollapsed is not a prop", "<Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed}>"],
          pathname !== undefined && ["pathname is not a prop", "<Sidebar currentPath={pathname}>"],
          children !== undefined && ["children are not rendered", `${example} header={…} footer={…} />`],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );

  // Wide in server HTML, where CSS hides the column on a phone until the client corrects it.
  // The drawer exists only below the sm breakpoint; a screen that grows past it closes it.
  const wide = useMediaQuery("(min-width: 640px)", true);
  const [open, setOpen] = useState(false);
  // Focus goes back to the menu button when the sheet closes, in every browser.
  const menuButton = useRef<HTMLButtonElement>(null);
  if (wide && open) setOpen(false);

  const [own, setOwn] = useState(defaultCollapsed);
  const collapsed = collapsedProp ?? own;
  const toggle = () => {
    setOwn(!collapsed);
    onCollapsedChange?.(!collapsed);
  };

  // An item's own `current` wins; otherwise the path decides, across nested links too.
  const links = sections.flatMap((section) =>
    section.items.flatMap((item): readonly (SidebarLinkItem | SidebarButtonItem)[] => (item.items !== undefined ? item.items : [item])),
  );
  const all = links.filter((item): item is SidebarLinkItem => item.href !== undefined);
  const marked = all.some((item) => item.current)
    ? undefined
    : currentHref(
        all.map((item) => item.href),
        currentPath,
      );
  const isCurrent = (item: SidebarLinkItem | SidebarButtonItem) => item.href !== undefined && (Boolean(item.current) || item.href === marked);

  // Which groups are open, by place; a group holding the current page starts open.
  const [opened, setOpened] = useState<Readonly<Record<string, boolean>>>({});
  const isOpen = (key: string, group: SidebarGroupItem) => opened[key] ?? group.items.some(isCurrent);

  const id = useId();
  /** One row's inside: icon (or the rail's letter), label and badge. */
  const rowContent = (item: SidebarItem, rail: boolean) => (
    <>
      {(item.icon !== undefined || rail) && (
        <span aria-hidden="true" className={iconSlot}>
          {item.icon !== undefined ? item.icon : item.label.charAt(0).toUpperCase()}
        </span>
      )}
      <span className={rail ? "sr-only" : "min-w-0 flex-1 [overflow-wrap:anywhere]"}>{item.label}</span>
      {item.badge !== undefined && (
        <>
          {" "}
          <span data-ouro-sidebar-badge="" className={rail ? "sr-only" : badgeSlot(item.badge)}>
            {item.badge}
          </span>
        </>
      )}
    </>
  );
  /**
   * A collapsed rail names each row with a tooltip, since only its icon shows.
   *
   * @claim "A collapsed rail names each row" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar items > names each rail link with a tooltip on hover and keyboard focus)
   * @claim "A collapsed rail names each row" registry/ouro/components/ouro/sidebar/sidebar.test.tsx verify:testExists(registry/ouro/components/ouro/sidebar/sidebar.test.tsx::Sidebar > collapses to a rail of icons with the toggle, keeping each link's name)
   */
  const tip = (rail: boolean, label: string, element: ReactElement) =>
    rail ? (
      <Tooltip content={label} side="right">
        {element}
      </Tooltip>
    ) : (
      element
    );
  /** A link or a button row. */
  const leaf = (item: SidebarLinkItem | SidebarButtonItem, rail: boolean, onNavigate: (() => void) | undefined) =>
    tip(
      rail,
      item.label,
      item.href !== undefined ? (
        <RouterLink
          href={item.href}
          aria-current={isCurrent(item) ? "page" : undefined}
          data-ouro-control="sidebar"
          data-ouro-part="link"
          onClick={(event) => {
            onNavigate?.();
            item.onClick?.(event);
          }}
          className={cn(row, rail && railRow)}
        >
          {rowContent(item, rail)}
        </RouterLink>
      ) : (
        <button
          type="button"
          data-ouro-control="sidebar"
          data-ouro-part="button"
          onClick={(event) => {
            onNavigate?.();
            item.onClick(event);
          }}
          className={cn(row, rail && railRow)}
        >
          {rowContent(item, rail)}
        </button>
      ),
    );

  /** The sections as lists: in the column (`rail` when collapsed) or in the drawer. */
  const renderSections = (place: string, rail: boolean, onNavigate?: () => void) =>
    sections.map((section, index) => (
      // A rule above every section after the first, so a section's label reads as the start of a group.
      <div key={index} className={cn("grid grid-cols-1 gap-1", index > 0 && "border-0 border-t border-solid border-border pt-4")}>
        {section.label !== undefined && (
          <p id={`${id}${place}${index}`} className={rail ? "sr-only" : "m-0 px-3 py-1 text-sm leading-5 font-semibold text-foreground"}>
            {section.label}
          </p>
        )}
        <ul aria-labelledby={section.label !== undefined ? `${id}${place}${index}` : undefined} className={list}>
          {section.items.map((item, position) => {
            if (item.items === undefined) return <li key={position}>{leaf(item, rail, onNavigate)}</li>;
            const holdsCurrent = item.items.some(isCurrent);
            if (rail) {
              // On the rail a group's links open in a menu beside its button, so they are in
              // reach whether or not the sidebar can expand.
              return (
                <li key={position}>
                  <Menu
                    side="right"
                    closeLabel={closeLabel}
                    trigger={
                      <Tooltip content={item.label} side="right">
                        <button type="button" data-current={holdsCurrent ? "" : undefined} data-ouro-control="sidebar" data-ouro-part="group" className={cn(row, "data-current:text-foreground", railRow)}>
                          {rowContent(item, true)}
                        </button>
                      </Tooltip>
                    }
                  >
                    {item.items.map((child, at) => (
                      <MenuItem key={at} href={child.href} current={isCurrent(child)} onClick={child.onClick}>
                        {child.label}
                        {child.badge !== undefined && (
                          <>
                            {" "}
                            <span className={cn(badgeSlot(child.badge), "ms-2")}>{child.badge}</span>
                          </>
                        )}
                      </MenuItem>
                    ))}
                  </Menu>
                </li>
              );
            }
            const key = `${index}-${position}`;
            const open = isOpen(key, item);
            return (
              <li key={position}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`${id}${place}${key}`}
                  data-ouro-control="sidebar"
                  data-ouro-part="group"
                  data-current={holdsCurrent && !open ? "" : undefined}
                  onClick={() => setOpened({ ...opened, [key]: !open })}
                  className={cn(row, "data-current:text-foreground")}
                >
                  {rowContent(item, false)}
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={cn("size-ouro-4 shrink-0 rtl:-scale-x-100", open && "rotate-90 rtl:-rotate-90")}
                  >
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                </button>
                {open && (
                  <ul id={`${id}${place}${key}`} className={cn(list, "ms-5 mt-1 border-0 border-s border-solid border-border ps-2")}>
                    {item.items.map((child, at) => (
                      <li key={at}>{leaf(child, false, onNavigate)}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    ));

  return (
    <div ref={ref} data-ouro="sidebar" data-collapsed={collapsed ? "" : undefined} className={cn("max-sm:inline-flex sm:h-full", className)}>
      <Button
        ref={menuButton}
        data-ouro-sidebar-menu=""
        data-ouro-control="sidebar"
        data-ouro-part="menu"
        variant="plain"
        tone="secondary"
        aria-label={menuLabel}
        // Only where the button shows: below the sm breakpoint it opens the sheet.
        aria-haspopup={wide ? undefined : "dialog"}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      className="w-ouro-11 px-0 sm:hidden"
      >
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-ouro-5">
          <path d="M3 5.5h14M3 10h14M3 14.5h14" />
        </svg>
      </Button>
      {wide && (
        <nav aria-label={label} data-collapsed={collapsed ? "" : undefined} className={column}>
          {header !== undefined && <div className="flex min-h-14 shrink-0 items-center overflow-hidden px-3 py-2">{header}</div>}
          <div data-ouro-sidebar-scroll="" className="grid grid-cols-1 min-h-0 flex-1 content-start gap-6 overflow-y-auto overscroll-contain p-2">
            {renderSections("c", collapsed)}
          </div>
          {collapsible && (
            <div className="shrink-0 p-2">
              <button type="button" aria-pressed={collapsed} data-ouro-control="sidebar" data-ouro-part="collapse" onClick={toggle} className={cn(row, collapsed && railRow)}>
                <span aria-hidden="true" className={iconSlot}>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="rtl:-scale-x-100">
                    <rect x="3" y="4" width="14" height="12" rx="2" />
                    <path d="M8 4v12" />
                  </svg>
                </span>
                <span className={collapsed ? "sr-only" : "min-w-0 flex-1 [overflow-wrap:anywhere]"}>{collapseLabel}</span>
              </button>
            </div>
          )}
          {footer !== undefined && (
            <div className="flex min-h-14 shrink-0 items-center overflow-hidden border-0 border-t border-solid border-border px-3 py-2">{footer}</div>
          )}
        </nav>
      )}
      <SheetFrame title={menuLabel} hideTitle={header !== undefined} closeLabel={closeLabel} side="left" open={open} onOpenChange={setOpen} finalFocus={menuButton}>
        <div className="grid gap-4">
          {header !== undefined && <div className="flex min-h-11 items-center px-3">{header}</div>}
          <nav aria-label={label} className="grid gap-6">
            {renderSections("d", false, () => setOpen(false))}
          </nav>
          {footer !== undefined && <div className="flex min-h-11 items-center border-0 border-t border-solid border-border px-3 pt-4">{footer}</div>}
        </div>
      </SheetFrame>
    </div>
  );
}
