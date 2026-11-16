export {
  menuBackdropClass,
  menuBarClass,
  menuBarTriggerClass,
  menuContextTriggerClass,
  menuGroupLabelClass,
  menuGuardsClass,
  menuIndicatorClass,
  menuItemClass,
  menuPopupClass,
  menuPositionerClass,
  menuSeparatorClass,
  menuSheetPopupClass,
  menuSheetPositionerClass,
};

// Class strings for Menu and its items, apart from the components so menu.tsx exports only
// components (React Fast Refresh). Class strings are literals so the app's Tailwind finds them.

/**
 * The positioner beside a trigger or at the pointer.
 *
 * @internal
 */
const menuPositionerClass = "outline-none";

/**
 * The positioner of a phone sheet: pinned to the bottom edge at full width, over the place
 * Base UI computed beside the trigger.
 *
 * @internal
 */
const menuSheetPositionerClass =
  "outline-none fixed! inset-x-0! top-auto! bottom-0! w-auto! transform-none!";

/**
 * The menu panel beside its trigger. It opens instantly and closes with a 150ms scale and
 * fade towards the trigger; reduced motion keeps only the fade,
 * and Base UI's `data-instant` (switching between menubar menus) skips it. A menu with
 * checkbox or radio items indents every label by the indicator's width, so labels line up.
 *
 * @internal
 * @claim "A menu with checkbox or radio" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu items > indents every item when the menu has checkbox or radio items, so labels line up)
 * @claim "It opens instantly and closes with" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu motion > opens instantly and closes with a quick scale and fade from its origin)
 */
const menuPopupClass =
  "box-border min-w-48 max-w-(--available-width) max-h-(--available-height) overflow-y-auto overscroll-contain p-1 " +
  "rounded-lg bg-popover text-popover-foreground outline-none " +
  "ring-1 ring-border/60 shadow-(--shadow-lg) " +
  "has-[[data-ouro-menu-indicator]]:[--ouro-menu-inset:1.5rem] " +
  "origin-(--transform-origin) " +
  "[transition:transform_var(--ouro-duration-fast)_var(--ouro-ease-out),opacity_var(--ouro-duration-fast)_var(--ouro-ease-out)] " +
  "data-ending-style:[transform:scale(0.96)] data-ending-style:opacity-0 " +
  "motion-reduce:[transition:opacity_var(--ouro-duration-fast)_var(--ouro-ease-out)] motion-reduce:data-ending-style:[transform:none] " +
  "data-instant:[transition:none]";

/**
 * The menu as a bottom sheet on a phone: full width with rounded top corners, clear of the
 * home indicator, scrolling when it is taller than most of the screen. It rises on the
 * drawer easing token and drops quickly; reduced motion fades it instead.
 *
 * @internal
 * @claim "The menu as a bottom sheet" registry/ouro/components/ouro/menu/menu.touch.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.touch.test.tsx::Menu on a phone > opens a dropdown as a bottom sheet from a tap, with 44px items and 16px text)
 * @claim "The menu as a bottom sheet" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu presentation > is a bottom sheet below 640px, with a backdrop, and its submenu is a sheet with a Back item)
 */
const menuSheetPopupClass =
  "box-border w-full max-h-[min(80dvh,calc(100dvh-4rem))] overflow-y-auto overscroll-contain " +
  "px-2 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+0.5rem)] " +
  "rounded-t-xl bg-popover text-popover-foreground outline-none " +
  "[box-shadow:var(--ouro-shadow-sheet-bottom)] " +
  "has-[[data-ouro-menu-indicator]]:[--ouro-menu-inset:1.5rem] " +
  "[transition:transform_var(--ouro-duration-sheet)_var(--ouro-ease-drawer),opacity_var(--ouro-duration-fast)_var(--ouro-ease-out)] " +
  "data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)] " +
  "data-ending-style:duration-(--ouro-duration-base) " +
  "motion-reduce:[transition:opacity_var(--ouro-duration-base)_var(--ouro-ease-out)] " +
  "motion-reduce:data-starting-style:[transform:none] motion-reduce:data-ending-style:[transform:none] " +
  "motion-reduce:data-starting-style:opacity-0 motion-reduce:data-ending-style:opacity-0";

/**
 * The dimmed page behind the phone sheet.
 *
 * @internal
 */
const menuBackdropClass =
  "fixed inset-0 bg-(--ouro-backdrop-color) opacity-(--ouro-backdrop-max) " +
  "transition-opacity duration-(--ouro-duration-base) ease-(--ouro-ease-out) data-starting-style:opacity-0 data-ending-style:opacity-0";

/**
 * One item: 44px tall with 16px text on a coarse pointer, 32px with 14px text with a fine
 * pointer. Highlighted by keyboard or pointer, dimmed when disabled; `tone="destructive"`
 * mixes the destructive color 20% toward the foreground, for contrast on the highlight.
 * Links lose their underline and color.
 *
 * @internal
 * @claim "One item: 44px tall with 16px" registry/ouro/components/ouro/menu/menu.touch.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.touch.test.tsx::Menu on a phone > opens a dropdown as a bottom sheet from a tap, with 44px items and 16px text)
 * @claim "Highlighted by keyboard or pointer, dimmed" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu items > paints tone destructive in the destructive color)
 * @claim "Highlighted by keyboard or pointer, dimmed" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu items > paints tone destructive in the destructive color)
 */
const menuItemClass =
  "relative m-0 box-border flex w-full min-h-11 pointer-fine:min-h-8 cursor-default items-center gap-3 " +
  "rounded-md py-1.5 pe-2 ps-[calc(0.5rem+var(--ouro-menu-inset,0px))] " +
  "text-start text-base leading-5 pointer-fine:text-sm text-popover-foreground no-underline outline-none select-none " +
  "[-webkit-tap-highlight-color:transparent] " +
  "data-highlighted:bg-accent data-highlighted:text-accent-foreground active:bg-accent active:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground " +
  // Forced colours drop the fill, so the highlight (and an open submenu's trigger) takes the system's pair.
  "forced-colors:data-highlighted:bg-[Highlight] forced-colors:data-highlighted:text-[HighlightText] forced-colors:data-popup-open:bg-[Highlight] forced-colors:data-popup-open:text-[HighlightText] " +
  // The current page is marked by weight and a bar at the start edge, so it differs from the highlight without relying on color.
  "aria-[current=page]:font-medium aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2 aria-[current=page]:before:start-0 aria-[current=page]:before:w-0.5 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-current aria-[current=page]:before:content-[''] " +
  "forced-colors:aria-[current=page]:before:border-s-2 forced-colors:aria-[current=page]:before:border-solid forced-colors:aria-[current=page]:before:border-current " +
  "data-[tone=destructive]:text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))] " +
  "data-[tone=destructive]:data-highlighted:bg-destructive/10 " +
  "data-disabled:pointer-events-none data-disabled:opacity-50 " +
  "[&_svg]:size-4 [&_svg]:shrink-0";

/**
 * The slot at the start of a checkbox or radio item that holds its mark.
 *
 * @internal
 */
const menuIndicatorClass = "absolute start-2 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center";

/**
 * A group's label: small and muted, lined up with the item labels.
 *
 * @internal
 */
const menuGroupLabelClass =
  "box-border py-1.5 pe-2 ps-[calc(0.5rem+var(--ouro-menu-inset,0px))] text-xs leading-4 font-medium text-muted-foreground select-none";

/**
 * A hairline between items.
 *
 * @internal
 */
const menuSeparatorClass = "-mx-1 my-1 h-px border-0 bg-border";

/**
 * The menubar: a row of menu buttons.
 *
 * @internal
 */
const menuBarClass = "box-border flex items-center gap-1";

/**
 * The holder of a bar menu's or a submenu's focus guards: out of the flow, so the bar's gap stays shut.
 *
 * @internal
 */
const menuGuardsClass = "absolute";

/**
 * A menubar's menu button: 44px tall on a coarse pointer, 32px with a fine pointer,
 * highlighted while its menu is open.
 *
 * @internal
 * @claim "A menubar's menu button: 44px tall" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::MenuBar > gives its triggers a 32px row with a fine pointer)
 * @claim "A menubar's menu button: 44px tall" registry/ouro/components/ouro/menu/menu.touch.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.touch.test.tsx::Menu on a phone > gives menubar buttons a 44px height)
 */
const menuBarTriggerClass =
  "relative m-0 box-border inline-flex h-11 pointer-fine:h-8 items-center rounded-md border-0 bg-transparent px-3 " +
  "font-[inherit] text-base pointer-fine:text-sm leading-5 font-medium text-foreground cursor-default select-none " +
  "[-webkit-tap-highlight-color:transparent] outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid " +
  "pointer-fine:hover:bg-accent pointer-fine:hover:text-accent-foreground active:bg-accent active:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground " +
  "data-disabled:opacity-50";

/**
 * The context menu's area: its text stays selectable and keeps its callout, except while a
 * finger is down (a long press opens the menu instead of the iOS text-selection callout).
 *
 * @internal
 */
const menuContextTriggerClass = "data-ouro-pressing:select-none data-ouro-pressing:[-webkit-touch-callout:none]";
