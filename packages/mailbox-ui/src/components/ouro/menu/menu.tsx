"use client";

import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Menubar } from "@base-ui/react/menubar";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type JSX,
  type ReactElement,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { PageDirection } from "@/lib/ouro/page-direction";
import { devThrow } from "@/lib/ouro/dev";
import { ariaKeyShortcuts } from "@/lib/ouro/key-shortcuts";
import type { Platform } from "@/lib/ouro/platform";
import { usePlatform } from "@/lib/ouro/use-platform";
import {
  floatingAligns,
  floatingHint,
  floatingPlacementWarnings,
  floatingPortalClass,
  floatingSide,
  type FloatingAlign,
  type FloatingSide,
} from "@/lib/ouro/floating";
import { RouterLink } from "@/lib/ouro/router-link";
import { toneWarning } from "@/lib/ouro/tones";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { useSheetPresentation } from "@/lib/ouro/use-sheet-presentation";
import { holdPageAtPress } from "@/lib/ouro/page-scroll-hold";
import { PortalScope, usePortalContainer } from "@/lib/ouro/portal-container";
import { Kbd } from "@/components/ouro/kbd/kbd";
import {
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
} from "@/components/ouro/menu/menu-styles";

export type { FloatingAlign as MenuAlign, FloatingSide as MenuSide } from "@/lib/ouro/floating";

/** Keys for a shortcut, as `Kbd` takes them: `["mod", "e"]` shows ⌘E on Apple platforms and Ctrl+E elsewhere. */
export type MenuShortcut = readonly string[] | (string & { 'Use an array: shortcut={["mod", "k"]}': never });

/** A menu entry for `items`: an action, or a link with `href`. */
export interface MenuItemEntry {
  type?: "item" | undefined;
  /** The item's text. */
  label: string;
  /**
   * An icon before the text, as a `MenuItem` shows one in its children: an `<svg>` drawn at 16px
   * in the item's color. It is decoration: screen readers hear the label alone.
   * @claim "An icon before the text, as a" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu items > shows an entry's icon before its label, at 16px, out of its name)
   */
  icon?: ReactNode;
  /** Runs when the item is chosen, by click, tap or Enter. The menu then closes. */
  onClick?: (() => void) | undefined;
  /** Makes the item a link, through `OuroProvider`'s router link for an internal path. */
  href?: string | undefined;
  /** The keys of the item's shortcut, shown at its end: `["mod", "e"]`. It does not bind them. */
  shortcut?: MenuShortcut | undefined;
  /** `"destructive"` for an action that deletes or cannot be undone. */
  tone?: "destructive" | undefined;
  /** Shown, but cannot be chosen. */
  disabled?: boolean | undefined;
  /**
   * The id of the agent action this item performs, set as `data-ax-action` on it, so the component
   * that declares the action finds its control: `axAction: "mute"`.
   */
  axAction?: string | undefined;
}

/** A menu entry for `items`: an on/off setting that stays in the menu when toggled. */
export interface MenuCheckboxEntry {
  type: "checkbox";
  label: string;
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  onCheckedChange?: ((checked: boolean) => void) | undefined;
  shortcut?: MenuShortcut | undefined;
  disabled?: boolean | undefined;
  /** The id of the agent action it performs, set as `data-ax-action` on it, as on an item. */
  axAction?: string | undefined;
}

/** A menu entry for `items`: one choice of several, as radio items under an optional label. */
export interface MenuRadioEntry {
  type: "radio";
  /** Names the group: "Sort by". */
  label?: string | undefined;
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  options: ReadonlyArray<{ value: string; label: string; shortcut?: MenuShortcut | undefined; disabled?: boolean | undefined }>;
}

/** A menu entry for `items`: entries under a label. */
export interface MenuGroupEntry {
  type: "group";
  label: string;
  items: readonly MenuEntry[];
}

/** A menu entry for `items`: an item that opens a nested menu. */
export interface MenuSubmenuEntry {
  type: "submenu";
  label: string;
  items: readonly MenuEntry[];
  disabled?: boolean | undefined;
  /** The text of the item that goes back from the submenu in the phone sheet. Default "Back". */
  backLabel?: string | undefined;
}

/** One entry in a Menu's `items`: an item (the default `type`), a checkbox, a radio group, a group, a submenu or a separator. */
export type MenuEntry =
  | MenuItemEntry
  | MenuCheckboxEntry
  | MenuRadioEntry
  | MenuGroupEntry
  | MenuSubmenuEntry
  | { type: "separator" };

/**
 * Props shared by every way of opening a Menu.
 *
 * @claim "Props shared by every way of" registry/ouro/components/ouro/menu/menu.test.tsx verify:fileLine(registry/ouro/components/ouro/menu/menu.test.tsx, /throws\sthe\sexact\sfix\swith\sno\sway\sto\sopen/)
 */
export interface MenuBaseProps {
  /** The entries as data, in place of children: `items={[{ label: "Edit", onClick: edit }, { type: "separator" }]}`. */
  items?: readonly MenuEntry[] | undefined;
  /** The entries as `MenuItem`, `MenuCheckboxItem`, `MenuRadioGroup`, `MenuGroup`, `MenuSub` and `MenuSeparator`. */
  children?: ReactNode;
  /** Whether the menu is open, to control it; pass `onOpenChange` with it. */
  open?: boolean | undefined;
  /** Called when the menu opens or closes. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * Layout only, applied to the menu panel: width (`w-64`; at least 12rem by default) and
   * margins. The phone sheet keeps its full width. Appearance classes warn in development.
   * @claim "Layout only, applied to the menu" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu dropdown > is at least 12rem wide, and className sets layout)
   */
  className?: string | undefined;
  /**
   * The text of the item that ends the phone sheet and closes it, for screen-reader and
   * switch users, who cannot swipe or tap the backdrop. Default "Close".
   */
  closeLabel?: string | undefined;

  /** Not a prop. Ouro UI uses `open` with `onOpenChange`: `<Menu open={open} onOpenChange={setOpen} trigger={…}>`. */
  isOpen?: { 'Use <Menu open={open} onOpenChange={setOpen} trigger={...}>': never };
  /** Not a prop. `onOpenChange(false)` fires on close: `<Menu open={open} onOpenChange={setOpen} trigger={…}>`. */
  onClose?: { 'Use <Menu open={open} onOpenChange={setOpen} trigger={...}>': never };
  /** Not a prop. Ouro UI splits placement into `side` and `align`: `<Menu side="bottom" align="start">`. */
  placement?: { 'Use side="bottom" align="start"': never };
  /** Not a prop. The trigger element is the button: `trigger={<Button>Actions</Button>}`. */
  asChild?: { "Use trigger={<Button>Actions</Button>}": never };
  /** Not a prop. The entries are `items` (or children): `items={[{ label: "Edit", onClick: edit }]}`. */
  options?: { 'Use items={[{ label: "Edit", onClick: edit }]}': never };
}

/** Where a dropdown sits beside its trigger. */
interface MenuPlacementProps {
  /**
   * The side of the trigger the menu sits on; it flips when there is no room. @default "bottom"
   *
   * @claim "it flips when there is no room" https://base-ui.com/react/components/menu verify:urlOk(https://base-ui.com/react/components/menu)
   */
  side?: FloatingSide | (string & { 'Use "top", "bottom", "left" or "right"': never }) | undefined;
  /** How the menu lines up with the trigger along that side. @default "start" */
  align?: FloatingAlign | (string & { 'Use "start", "center" or "end": left is "start", right is "end"': never }) | undefined;
}

/**
 * A dropdown: `trigger` opens it. Below 640px it is a bottom sheet.
 *
 * @claim "Below 640px it is a bottom" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu presentation > is a bottom sheet below 640px, with a backdrop, and its submenu is a sheet with a Back item)
 */
export type MenuDropdownProps = MenuBaseProps &
  MenuPlacementProps & {
    /** The button that opens the menu, usually a Button: `trigger={<Button>Actions</Button>}`. */
    trigger: ReactElement;
    /**
     * Whether the open dropdown holds the page: it locks the page's scroll, and a click outside
     * only closes it. `modal={false}` leaves the page scrolling and its controls live, and spares
     * the browser a layout and repaint of the whole page each time the menu opens and closes:
     * for a small menu that a list repeats on every row. The phone sheet always holds the page.
     * @default true
     * @claim "it locks the page's scroll" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu modal > holds the page while open: its scroll is locked, and a click outside only closes it)
     * @claim "a click outside only closes it" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu modal > holds the page while open: its scroll is locked, and a click outside only closes it)
     * @claim "leaves the page scrolling and its controls live" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu modal > with modal={false}, leaves the page's scroll alone while a modal Menu's lock comes and goes) verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu modal > with modal={false}, leaves the page's controls live: a click outside reaches them and closes the menu)
     * @claim "The phone sheet always holds the page" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu modal > keeps the phone sheet holding the page with modal={false})
     */
    modal?: boolean | undefined;
    /** Not with `trigger`. Use one way to open a menu. */
    contextTrigger?: never;
    /** Not with `trigger`. `label` is for a Menu inside `MenuBar`. */
    label?: never;
    /** Not with `trigger`. Use one way to open a menu. */
    anchor?: never;
  };

/** A context menu: right-click or long-press on `contextTrigger` opens it at the pointer. */
export type MenuContextProps = MenuBaseProps & {
  /**
   * The area that opens the menu on right-click, or on a long press on touch screens:
   * `contextTrigger={<div>…</div>}`. Its text stays selectable; only while a finger is
   * down does it turn off text selection and the iOS callout, so a long press opens the
   * menu. Give the same actions a visible control too: a context menu is hard to discover.
   */
  contextTrigger: ReactElement;
  /** Not with `contextTrigger`. Use one way to open a menu. */
  trigger?: never;
  /** Not with `contextTrigger`. `label` is for a Menu inside `MenuBar`. */
  label?: never;
  /** Not with `contextTrigger`: a context menu opens at the pointer. */
  side?: never;
  /** Not with `contextTrigger`: a context menu opens at the pointer. */
  align?: never;
  /** Not with `contextTrigger`: a context menu holds the page while it is open. */
  modal?: never;
  /** Not with `contextTrigger`. Use one way to open a menu. */
  anchor?: never;
};

/** A menu in a `MenuBar`: `label` is its button's text. */
export type MenuBarMenuProps = MenuBaseProps &
  MenuPlacementProps & {
    /** The text of the menu's button in the `MenuBar`: `<Menu label="File">`. */
    label: string;
    /** Not with `label`. A menu in a `MenuBar` gets its button from `label`. */
    trigger?: never;
    /** Not with `label`. A menu in a `MenuBar` gets its button from `label`. */
    contextTrigger?: never;
    /** Not with `label`: the `MenuBar` decides how its menus hold the page. */
    modal?: never;
    /** Not with `label`. A menu in a `MenuBar` gets its button from `label`. */
    anchor?: never;
  };

/**
 * A menu the app opens itself, at an element or a point: one menu that many rows share, opened from
 * each row's own button, right-click or keys. Beside an element it is a bottom sheet below 640px, as a
 * dropdown is; at a point it is a menu at every width, as a context menu is.
 *
 * @claim "A menu the app opens itself" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu anchor > opens at a point the app gives, named by its aria-label, and puts focus back where the app says when it closes)
 * @claim "Beside an element it is a" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu anchor > opens beside an element, as a bottom sheet below 640px, and at a point as a menu)
 */
export type MenuAnchorProps = MenuBaseProps &
  MenuPlacementProps & {
    /**
     * Where the menu opens: beside an element (`side` and `align` place it), beside a box measured
     * once (`{ getBoundingClientRect: () => box }`, for an element that goes as the menu opens), or at
     * a point in the window, `{ x, y }`, as a right-click's `clientX` and `clientY`.
     */
    anchor: MenuAnchor;
    /** Whether the menu is open: the app opens it. */
    open: boolean;
    /** Called when the menu opens or closes: an item chosen, Escape, a press outside. */
    onOpenChange: (open: boolean) => void;
    /** What screen readers hear for the menu, in place of a button's name: "Actions for Ana's message". */
    "aria-label": string;
    /**
     * Where focus goes when the menu closes (Escape, an item chosen), such as the row it opened for.
     * An item that moved focus itself, as one opening a dialog does, keeps it there.
     * @claim "An item that moved focus itself" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu anchor > leaves focus where a chosen item moved it)
     */
    returnFocus?: HTMLElement | null | undefined;
    /** Not with `anchor`. Use one way to open a menu. */
    trigger?: never;
    /** Not with `anchor`. Use one way to open a menu. */
    contextTrigger?: never;
    /** Not with `anchor`. `label` is for a Menu inside `MenuBar`; name this one with `aria-label`. */
    label?: never;
    /** Not with `anchor`: it leaves the page live, so it opens and closes without a layout of the whole page. */
    modal?: never;
  };

/** Where an anchored Menu opens: an element, a box (`{ getBoundingClientRect }`) or a point in the window (`{ x, y }`). */
export type MenuAnchor = Element | { getBoundingClientRect: () => DOMRect } | { x: number; y: number };

/** Props for {@link Menu}: `trigger` (a dropdown), `contextTrigger` (a context menu), `label` (in a `MenuBar`) or `anchor` (opened by the app). */
export type MenuProps = MenuDropdownProps | MenuContextProps | MenuBarMenuProps | MenuAnchorProps;

/** What items read from the menu around them: that there is one, and whether it is a phone sheet. */
const MenuContext = createContext<{ sheet: boolean } | null>(null);
/** Whether a Menu sits in a MenuBar. */
const MenuBarContext = createContext(false);
/** Whether a radio item sits in a MenuRadioGroup. */
const RadioGroupContext = createContext(false);

const openFix =
  "Pass trigger={<Button>…</Button>} for a dropdown, contextTrigger={<div>…</div>} for a right-click or long-press area, label inside <MenuBar>, or anchor={element} with open for a menu the app opens";
const controlFix = "<Menu open={open} onOpenChange={setOpen} trigger={…}>";
const itemsFix = '<Menu trigger={…} items={[{ label: "Edit", onClick: edit }]} />';

/** Throws in development, with the JSX the item belongs in, unless it sits inside a Menu. */
function useMenuPart(part: string, inner: string): { sheet: boolean } {
  const context = useContext(MenuContext);
  if (!context) {
    devThrow(
      part,
      "must be rendered inside <Menu>",
      process.env.NODE_ENV !== "production"
        ? `<Menu trigger={<Button>Actions</Button>}>${inner}</Menu>`
        : /* istanbul ignore next @preserve -- production only */ "",
    );
  }
  return context;
}

/** The items for `items`. */
function renderEntries(entries: readonly MenuEntry[]): ReactNode {
  return entries.map((entry, index) => {
    switch (entry.type) {
      case "separator":
        return <MenuSeparator key={index} />;
      case "checkbox":
        return (
          <MenuCheckboxItem
            key={index}
            checked={entry.checked}
            defaultChecked={entry.defaultChecked}
            onCheckedChange={entry.onCheckedChange}
            shortcut={entry.shortcut}
            disabled={entry.disabled}
            axAction={entry.axAction}
          >
            {entry.label}
          </MenuCheckboxItem>
        );
      case "radio":
        return (
          <MenuRadioGroup
            key={index}
            label={entry.label}
            value={entry.value}
            defaultValue={entry.defaultValue}
            onValueChange={entry.onValueChange}
          >
            {entry.options.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} shortcut={option.shortcut} disabled={option.disabled}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        );
      case "group":
        return (
          <MenuGroup key={index} label={entry.label}>
            {renderEntries(entry.items)}
          </MenuGroup>
        );
      case "submenu":
        return (
          <MenuSub key={index} label={entry.label} disabled={entry.disabled} backLabel={entry.backLabel}>
            {renderEntries(entry.items)}
          </MenuSub>
        );
      default:
        return (
          <MenuItem
            key={index}
            onClick={entry.onClick}
            href={entry.href}
            shortcut={entry.shortcut}
            tone={entry.tone}
            disabled={entry.disabled}
            axAction={entry.axAction}
          >
            {entry.icon !== undefined && (
              <span aria-hidden="true" data-ouro-menu-icon="" className="flex shrink-0">
                {entry.icon}
              </span>
            )}
            {entry.label}
          </MenuItem>
        );
    }
  });
}

/** Marks a context area as pressed while a finger is down, so the class turns off selection and the callout. */
function pressing(on: boolean) {
  return (event: TouchEvent<HTMLElement>) => event.currentTarget.toggleAttribute("data-ouro-pressing", on);
}

/** The portal, positioner and popup of a menu or submenu, beside its trigger or as a phone sheet. */
function MenuSurface({
  sheet,
  context,
  side,
  align,
  className,
  children,
  closeLabel,
  anchor,
  point,
  label,
  finalFocus,
}: {
  sheet: boolean;
  context: boolean;
  side?: FloatingSide | undefined;
  align?: FloatingAlign | undefined;
  className?: string | undefined;
  children: ReactNode;
  /** Set for a top-level menu: its phone sheet ends with a Close item. */
  closeLabel?: string | undefined;
  /** An anchored menu's place: an element or a box. */
  anchor?: Element | { getBoundingClientRect: () => DOMRect } | undefined;
  /** At a point: the menu opens right at it, as a context menu opens at the pointer. */
  point?: boolean | undefined;
  /** An anchored menu's name. */
  label?: string | undefined;
  /** An anchored menu's focus on closing. */
  finalFocus?: (() => HTMLElement | boolean) | undefined;
}): JSX.Element {
  const Positioner = context ? ContextMenu.Positioner : BaseMenu.Positioner;
  const portal = usePortalContainer("Menu", true);
  // An open menu leaves two focus guards beside its trigger (Base UI's FloatingPortal): a menubar's menu leaves them in
  // the bar, a submenu in its menu. In WebKit on Apple platforms they are role="button", so that VoiceOver's cursor
  // lands on them and is sent into the popup (Base UI utils/FocusGuard), and a menubar or a menu may hold no buttons
  // (aria-required-children, issue #663). There they are hidden, as they are on every other platform; Tab still stops on
  // them. The group Base UI puts between them owns the popup (aria-owns), so the popup is read right after its trigger.
  // The guards inside the popup are left as buttons on purpose, so VoiceOver's cursor still moves focus into and out of
  // it: they sit in the owned popup, beside the menu, not among the bar's or the menu's own children. A dropdown's guards
  // are left alone too, as its trigger sits in no container that limits its children.
  const inMenu = useContext(MenuContext) !== null;
  const inBar = useContext(MenuBarContext);
  const inside = inMenu || inBar;
  const guards = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const holder = guards.current;
    if (holder === null) return;
    const hide = () => {
      for (const guard of holder.querySelectorAll("[data-base-ui-focus-guard][role]")) {
        guard.removeAttribute("role");
        guard.setAttribute("aria-hidden", "true");
      }
    };
    const observer = new MutationObserver(hide);
    // Base UI mounts a guard without a role and gives it one a render later, so a change of role is all to watch for.
    observer.observe(holder, { subtree: true, attributeFilter: ["role"] });
    // `inside` comes from context fixed by where the surface is rendered, so the holder never comes or goes.
    // Stryker disable next-line ArrowFunction: an observer left on a holder that has left the page sees no more changes.
    return () => observer.disconnect();
  },
  // Stryker disable next-line ArrayDeclaration: the effect reads only the holder, the same element for the surface's life, so it runs once whatever it lists.
  []);
  const surface = (
    <BaseMenu.Portal {...portal} data-ouro="menu-portal" className={floatingPortalClass}>
      <PortalScope>
        {sheet && <BaseMenu.Backdrop data-ouro="menu-backdrop" className={menuBackdropClass} />}
        <Positioner
          data-ouro="menu-positioner"
          className={sheet ? menuSheetPositionerClass : menuPositionerClass}
          sideOffset={context || point ? 0 : 4}
          collisionPadding={8}
          // Stryker disable next-line ConditionalExpression: Base UI reads an anchor of undefined as none, as it reads no anchor.
          {...(anchor !== undefined ? { anchor } : {})}
          // An anchored menu mounts open, and its first placement can come before the layer it renders in is laid out
          // (WebKit): placed absolutely, it was drawn offset by as far as that layer is down the page, then jumped back a
          // frame later. Placed fixed, as Base UI places a context menu, it is right from its first frame.
          // Stryker disable next-line ConditionalExpression: a dropdown placed fixed is placed again as its page scrolls, where one placed absolutely moves with it, so no test can tell them apart.
          {...(anchor !== undefined ? { positionMethod: "fixed" as const } : {})}
          {...(side ? { side } : {})}
          {...(align ? { align } : {})}
        >
          <BaseMenu.Popup
            data-ouro="menu"
            data-ouro-presentation={sheet ? "sheet" : "menu"}
            aria-label={label}
            // Stryker disable next-line ConditionalExpression: Base UI reads a finalFocus of undefined as none, as it reads no finalFocus.
            {...(finalFocus !== undefined ? { finalFocus } : {})}
            className={cn(sheet ? menuSheetPopupClass : menuPopupClass, sheet ? undefined : className)}
          >
            <MenuContext.Provider value={{ sheet }}>{children}</MenuContext.Provider>
            {sheet && closeLabel !== undefined && (
              <>
                <BaseMenu.Separator className={menuSeparatorClass} />
                <BaseMenu.Item data-ouro-menu-close="" data-ouro-control="menu" data-ouro-part="close" className={menuItemClass}>
                  <span data-ouro-menu-label="">{closeLabel}</span>
                </BaseMenu.Item>
              </>
            )}
          </BaseMenu.Popup>
        </Positioner>
      </PortalScope>
    </BaseMenu.Portal>
  );
  if (!inside) return surface;
  return (
    <span ref={guards} data-ouro-menu-guards="" className={menuGuardsClass}>
      {surface}
    </span>
  );
}

/**
 * A list of actions that opens from a button, from a right-click or long press, or from a
 * menubar, with one API for all three. Items take a shortcut (shown with `Kbd`),
 * `tone="destructive"` and `href`, and there are checkbox items, radio groups, labelled
 * groups, submenus and separators. Below 640px a dropdown is a bottom sheet; a context menu
 * opens at the pointer at every width.
 *
 * Pass `trigger` for a dropdown, `contextTrigger` for a context menu, `label` for a menu
 * in a `MenuBar`, or `anchor` with `open` for a menu the app opens itself, at an element or a
 * point, such as one menu shared by every row of a list. Give the entries as children or as `items` data. To give the trigger a
 * tooltip too, put the Tooltip inside `trigger`:
 * `trigger={<Tooltip content="More actions"><Button aria-label="More">…</Button></Tooltip>}`.
 *
 * Use `Select` instead to pick a value for a form, `Popover` for a panel with fields or
 * text, and `Command` for a searchable list of every action in the app.
 *
 * It stacks above the page at `--ouro-layer`, a z-index of 50 by default (from
 * ouro-base.css), like Dialog and Sheet.
 *
 * A dropdown closes when focus moves anywhere outside it, as it does on a click outside, so Tab
 * goes on from wherever focus went.
 * In a right-to-left page (`dir="rtl"` on `<html>`) a submenu opens to the left, with ArrowLeft.
 *
 *
 * @group Menus
 * @claim "In a right-to-left page" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu items > opens a submenu with ArrowLeft in a right-to-left page, where it opens to the left, and closes it with ArrowRight)
 * @see https://ui.ouroboros.bot/docs/menu
 *
 * @example
 * <Menu trigger={<Button variant="outline">Actions</Button>}>
 *   <MenuItem onClick={edit} shortcut={["mod", "e"]}>Edit</MenuItem>
 *   <MenuItem href="/recipes/1/print">Print</MenuItem>
 *   <MenuSeparator />
 *   <MenuItem tone="destructive" onClick={remove}>Delete</MenuItem>
 * </Menu>
 * <Menu contextTrigger={<RecipeCard recipe={recipe} />} items={[{ label: "Copy link", onClick: copy }]} />
 * <Menu anchor={{ x: event.clientX, y: event.clientY }} open={open} onOpenChange={setOpen} aria-label="Actions for Ana's message" returnFocus={row} items={entries} />
 * @claim "Below 640px a dropdown is a" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu presentation > is a bottom sheet below 640px, with a backdrop, and its submenu is a sheet with a Back item)
 * @claim "a context menu opens at the pointer at every width" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu context trigger > stays a menu at the pointer on a phone, not a sheet)
 * @claim "A dropdown closes when focus moves" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu focus > closes when focus moves outside it, so a forward Tab from before its trigger goes on to the trigger)
 * @claim "It stacks above the page at" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu stacking > puts the portal on the --ouro-layer level, as its own stacking context)
 * @claim "It stacks above the page at" registry/ouro/theme/ouro-base.css verify:fileLine(registry/ouro/theme/ouro-base.css, /^\s+--ouro-layer:\s50;/)
 * @claim "A list of actions that opens" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu dropdown > opens a menu below its trigger, aligned to its start, named by the trigger)
 * @claim "A list of actions that opens" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu context trigger > opens at the pointer on right-click)
 * @claim "A list of actions that opens" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::MenuBar > is a menubar of menus that the arrow keys move between)
 */
export function Menu(props: MenuProps): JSX.Element {
  const {
    trigger,
    contextTrigger,
    label,
    anchor,
    "aria-label": ariaLabel,
    returnFocus,
    items,
    children,
    side: sideProp,
    align: alignProp,
    className,
    closeLabel = "Close",
    modal,
    open,
    onOpenChange,
    // Guard props (hint types), dropped here so they never reach the DOM.
    isOpen,
    onClose,
    placement,
    asChild,
    options,
  } = props as MenuBaseProps &
    MenuPlacementProps & {
      trigger?: ReactElement;
      contextTrigger?: ReactElement;
      label?: string;
      modal?: boolean | undefined;
      anchor?: MenuAnchor;
      "aria-label"?: string;
      returnFocus?: HTMLElement | null | undefined;
    };
  const inBar = useContext(MenuBarContext);
  const fix = (code: string) => (process.env.NODE_ENV !== "production" ? code : /* istanbul ignore next @preserve -- production only */ "");

  const modes = [trigger, contextTrigger, label, anchor].filter((mode) => mode !== undefined).length;
  if (modes === 0) devThrow("Menu", "needs trigger, contextTrigger, label or anchor", fix(openFix));
  if (modes > 1) devThrow("Menu", "takes one of trigger, contextTrigger, label and anchor", fix(openFix));
  if (anchor !== undefined && open === undefined) devThrow("Menu", "anchor needs open: the app opens a menu it anchors", fix('<Menu anchor={row} open={open} onOpenChange={setOpen} aria-label="Actions for Ana\'s message">'));
  if (anchor !== undefined && !ariaLabel) devThrow("Menu", "anchor needs aria-label: no button names the menu", fix('<Menu anchor={row} open={open} onOpenChange={setOpen} aria-label="Actions for Ana\'s message">'));
  if (inBar && label === undefined) {
    devThrow("Menu", "a Menu inside <MenuBar> takes label, not trigger or contextTrigger", fix('<MenuBar><Menu label="File">…</Menu></MenuBar>'));
  }
  if (!inBar && label !== undefined) {
    devThrow(
      "Menu",
      "label is for a Menu inside <MenuBar>",
      fix(`<MenuBar><Menu label="${label}">…</Menu></MenuBar>, or trigger={<Button>${label}</Button>} for a dropdown`),
    );
  }
  if (items === undefined && children === undefined) devThrow("Menu", "needs items or children", fix(itemsFix));
  if (items !== undefined && children !== undefined) {
    devThrow("Menu", "takes items or children, not both", fix("move the children into items, or the items into <MenuItem> children"));
  }
  if (open !== undefined && typeof onOpenChange !== "function") devThrow("Menu", "open needs onOpenChange", fix(controlFix));

  const context = contextTrigger !== undefined;
  // At a point, a menu at every width, as a context menu is; beside an element, a sheet on a phone, as a dropdown is.
  const point = anchor !== undefined && !("getBoundingClientRect" in anchor) ? anchor : undefined;
  // A side or alignment that is not one of Ouro UI's (a type error) warns and renders the default.
  const side = floatingSide(sideProp, "bottom");
  const align = floatingAligns.includes(alignProp as FloatingAlign) ? (alignProp as FloatingAlign) : "start";

  useAppearanceClassNameCheck(
    "Menu",
    className,
    process.env.NODE_ENV !== "production" ? floatingHint("<Menu trigger={…}>", "</Menu>") : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Menu",
    process.env.NODE_ENV !== "production"
      ? () => [
          ...(context
            ? [
                sideProp !== undefined && (["side is not used by a context menu, which opens at the pointer", "remove side"] as const),
                alignProp !== undefined && (["align is not used by a context menu, which opens at the pointer", "remove align"] as const),
                modal !== undefined && (["modal is not used by a context menu, which holds the page while open", "remove modal"] as const),
              ]
            : floatingPlacementWarnings("<Menu", sideProp, "bottom", alignProp, placement)),
          label !== undefined && modal !== undefined && ["modal is not used by a menu in <MenuBar>; the bar decides", "remove modal"],
          isOpen !== undefined && ["isOpen is not a prop", controlFix],
          onClose !== undefined && ["onClose is not a prop", controlFix],
          asChild !== undefined && ["asChild is not a prop; the trigger element is the button", "trigger={<Button>Actions</Button>}"],
          options !== undefined && ["options is not a prop; the entries are items", itemsFix],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );

  // A dropdown (and a menubar's menu) is a bottom sheet on a phone; a context menu opens at
  // the pointer, where the finger is, at every width.
  const sheet = useSheetPresentation(
    context || point !== undefined
      ? // Stryker disable next-line StringLiteral: useSheetPresentation is a sheet for "sheet" or "auto" alone, so any other word here is the same popup.
        "menu"
      : "auto",
  );
  const body = items !== undefined ? renderEntries(items) : children;
  // Focus that moves anywhere else closes a dropdown (a menubar's menus are the bar's). Left open, Base UI keeps its
  // focus guards beside the trigger, and the one before it, met by a forward Tab, sends focus back to what Tab was
  // leaving.
  // Stryker disable next-line BooleanLiteral: a menu's close() before it first opens does nothing, so the listener that starts with it changes nothing.
  const [shown, setShown] = useState(false);
  const isShown = open ?? shown;
  const actions = useRef<BaseMenu.Root.Actions | null>(null);
  // Where focus went outside the open menu, as a chosen item moving it does; Base UI then focuses the item again.
  const movedTo = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contextRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // An anchored menu has no trigger: its page is the one it runs in.
    const doc = anchor !== undefined ? document : triggerRef.current?.ownerDocument;
    // Stryker disable next-line ConditionalExpression,LogicalOperator: a closed menu's close() does nothing; this only spares a listener.
    if (!isShown || doc === undefined) return;
    movedTo.current = null;
    const away = (event: FocusEvent) => {
      const target = event.target as Element;
      if (triggerRef.current?.contains(target) || target.closest('[data-ouro="menu-positioner"], [data-base-ui-focus-guard]')) return;
      movedTo.current = target as HTMLElement;
      actions.current!.close();
    };
    doc.addEventListener("focusin", away);
    // Stryker disable next-line ArrowFunction: a listener left on a closed menu's page only calls close(), which does nothing.
    return () => doc.removeEventListener("focusin", away);
  }, [isShown, anchor]);
  const returnTo = useRef(returnFocus);
  useLayoutEffect(() => {
    returnTo.current = returnFocus;
  });
  const changed = (next: boolean) => {
    setShown(next);
    onOpenChange?.(next);
    // An anchored menu puts focus back on returnFocus, unless the chosen item (or the press that closed it) put it somewhere else.
    // Stryker disable next-line ConditionalExpression,LogicalOperator: Base UI opens through here only at a trigger, which an anchored menu has none of, and a dropdown has no returnFocus, so past this line either finds nothing of theirs to focus.
    if (anchor === undefined || next) return;
    setTimeout(() => {
      // The body when nothing has focus: null only in a document with no body, which a menu's page always has.
      const active = document.activeElement as Element;
      if (active !== document.body && active.closest('[data-ouro="menu-positioner"]') === null) return;
      (movedTo.current?.isConnected ? movedTo.current : returnTo.current)?.focus({ preventScroll: true });
    });
  };
  // Stryker disable next-line ConditionalExpression: Base UI reads an `open` of undefined as uncontrolled, as it reads none.
  const control = open !== undefined ? { open, onOpenChange: changed } : { onOpenChange: changed };

  if (anchor !== undefined) {
    const place = point === undefined ? (anchor as Exclude<MenuAnchor, { x: number }>) : { getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) };
    // Focus goes back in `changed`, once the closing event is over and any chosen item has run.
    // Stryker disable next-line ArrowFunction: with no trigger, Base UI has no focus of its own to give back, so a finalFocus that says nothing does as false does.
    const finalFocus = () => false;
    const directed = (
      <BaseMenu.Root {...control} actionsRef={actions} modal={sheet}>
        <MenuSurface
          sheet={sheet}
          context={false}
          side={side}
          align={point === undefined ? align : "start"}
          className={className}
          closeLabel={closeLabel}
          anchor={place}
          point={point !== undefined}
          label={ariaLabel}
          finalFocus={finalFocus}
        >
          {body}
        </MenuSurface>
      </BaseMenu.Root>
    );
    // An element the menu opens beside decides its direction; a point or a box measured once, the page.
    return <PageDirection of={anchor instanceof Element ? anchor : null}>{directed}</PageDirection>;
  }

  if (context) {
    const directed = (
      <ContextMenu.Root {...control}>
        <ContextMenu.Trigger
          ref={contextRef}
          render={contextTrigger}
          className={menuContextTriggerClass}
          {...holdPageAtPress.contextMenu}
          // Base UI turns the callout off for good; Ouro UI turns it off only while pressing.
          style={{ WebkitTouchCallout: undefined }}
          onTouchStart={pressing(true)}
          onTouchEnd={pressing(false)}
          onTouchCancel={pressing(false)}
        />
        <MenuSurface sheet={false} context className={className}>
          {body}
        </MenuSurface>
      </ContextMenu.Root>
    );
    return <PageDirection of={contextRef}>{directed}</PageDirection>;
  }

  // A MenuBar's menu takes no `modal` (Base UI warns): the bar decides. It takes the bar's direction too.
  const menu = (
    <BaseMenu.Root {...control} actionsRef={actions} modal={label === undefined ? sheet || modal : undefined}>
      {label !== undefined ? (
        <BaseMenu.Trigger data-ouro-control="menu" data-ouro-part="bar-trigger" className={menuBarTriggerClass} {...holdPageAtPress.listButton}>
          {label}
        </BaseMenu.Trigger>
      ) : (
        <BaseMenu.Trigger ref={triggerRef} render={trigger} {...holdPageAtPress.listButton} />
      )}
      <MenuSurface
        sheet={sheet}
        context={false}
        side={side}
        align={align}
        className={className}
        closeLabel={closeLabel}
        finalFocus={backToTrigger}
      >
        {body}
      </MenuSurface>
    </BaseMenu.Root>
  );
  return label !== undefined ? menu : <PageDirection of={triggerRef}>{menu}</PageDirection>;
}

/**
 * Where a dropdown, or a menubar's menu, gives focus as it leaves the page: back to its trigger, as Base UI does, unless
 * focus has gone on elsewhere or another menu has opened while it closed. That menu closes when
 * focus lands outside it, so a press on its trigger, which takes no focus in Safari, would open it
 * only for this one's focus return to close it again.
 *
 * @claim "That menu closes when focus lands outside it, so a press on its trigger, which takes no focus in Safari, would open it only for this one's focus return to close it again." registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu modal > leaves a menu that opened while another closed open, when the closing one would give focus back to its trigger)
 * @claim "back to its trigger, as Base UI does, unless focus has gone on elsewhere" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu modal > gives focus back to its trigger when a press on the page's blank space closes it, and leaves focus that moved on)
 */
function backToTrigger(): boolean {
  if (document.querySelector('[data-ouro="menu"][data-open]') !== null) return false;
  // The body when nothing has focus: null only in a document with no body, which a menu's page always has.
  const active = document.activeElement!;
  // Stryker disable next-line ConditionalExpression: React takes the popup out of the page before Base UI asks, so focus that was in it is on the body by then; this keeps a popup still in the page returning focus too.
  return active === document.body || active.closest('[data-ouro="menu"]') !== null;
}

/**
 * The items for `items`, as `MenuItem`s and the rest, for a menu that puts more before them.
 *
 * @internal
 */
export function MenuEntries({ entries }: { entries: readonly MenuEntry[] }): JSX.Element {
  return <>{renderEntries(entries)}</>;
}

/** Props for {@link MenuBar}. */
export interface MenuBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "children"> {
  /**
   * The menus, each `<Menu label="File">…</Menu>`.
   *
   * @claim "The menus, each `<Menu label=" registry/ouro/components/ouro/menu/menu.test-d.ts verify:fileLine(registry/ouro/components/ouro/menu/menu.test-d.ts, /\{\strigger:\sReactElement;\slabel:\s"File";\schildren:\s"Items"\s\}>\(\)\.not\.toExtend<MenuProps>/)
   * @claim "The menus, each `<Menu label=" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu dev messages > throws the exact fix for label outside a MenuBar, and for a trigger inside one)
   */
  children: ReactNode;
  /** Layout only: margins and width. Appearance classes warn in development. */
  className?: string | undefined;
}

/**
 * A row of menus, as at the top of a desktop app: File, Edit, View. The arrow keys move
 * between the menus, and once one is open, hovering another switches to it instantly.
 * Each child is a `Menu` with a `label`. Below 640px each menu opens as a bottom sheet.
 *
 * Use `Menu` with `trigger` instead for a single menu button, and `Tabs` or navigation
 * links to move between pages.
 *
 * @group Menus
 *
 * @example
 * <MenuBar aria-label="Recipe editor">
 *   <Menu label="File">
 *     <MenuItem onClick={save} shortcut={["mod", "s"]}>Save</MenuItem>
 *   </Menu>
 *   <Menu label="Edit">
 *     <MenuItem onClick={undo} shortcut={["mod", "z"]}>Undo</MenuItem>
 *   </Menu>
 * </MenuBar>
 * @claim "The arrow keys move between the menus" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::MenuBar > is a menubar of menus that the arrow keys move between)
 * @claim "hovering another switches to it instantly" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::MenuBar > switches instantly to the next menu on hover once one is open)
 * @claim "Below 640px each menu opens as a bottom sheet" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::MenuBar > opens each menu as a bottom sheet below 640px)
 * @claim "Each child is a `Menu` with" registry/ouro/components/ouro/menu/menu.test.tsx verify:testExists(registry/ouro/components/ouro/menu/menu.test.tsx::Menu dev messages > throws the exact fix for label outside a MenuBar, and for a trigger inside one)
 */
export function MenuBar({ children, className, ...rest }: MenuBarProps): JSX.Element {
  const bar = useRef<HTMLDivElement>(null);
  useAppearanceClassNameCheck(
    "MenuBar",
    className,
    process.env.NODE_ENV !== "production" ? "wrap the MenuBar in an element with that class" : /* istanbul ignore next @preserve -- production only */ "",
  );
  const directed = (
    <Menubar {...rest} ref={bar} data-ouro="menu-bar" className={cn(menuBarClass, className)}>
      <MenuBarContext.Provider value>{children}</MenuBarContext.Provider>
    </Menubar>
  );
  return <PageDirection of={bar}>{directed}</PageDirection>;
}

/** Props for {@link MenuItem}. */
export interface MenuItemProps {
  /** The item's text, or text with an icon. */
  children: ReactNode;
  /** Runs when the item is chosen, by click, tap or Enter. The menu then closes. */
  onClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /**
   * Makes the item a link: an internal path goes through `OuroProvider`'s router link, an
   * absolute URL is a plain `<a>`. The menu closes when it is followed.
   */
  href?: string | undefined;
  /**
   * Marks a link item as the page being shown (`aria-current="page"`, a medium-weight label
   * with a bar at the start edge, which the highlight does not have), for a menu of pages. It does nothing on an item without `href`.
   */
  current?: boolean | undefined;
  /**
   * The item's keyboard shortcut, as `Kbd` shows it: `["mod", "e"]` is ⌘E on Apple platforms
   * and Ctrl+E elsewhere. It only shows the keys; bind them in your app.
   */
  shortcut?: MenuShortcut | undefined;
  /** `"destructive"` for an action that deletes or cannot be undone. */
  tone?: "destructive" | (string & { 'Only "destructive": danger is "destructive"': never }) | undefined;
  /** Shown, but cannot be chosen. */
  disabled?: boolean | undefined;
  /**
   * The id of the agent action the item performs, set as `data-ax-action` on it, so the component
   * that declares the action finds its control: `<MenuItem axAction="mute">`.
   */
  axAction?: string | undefined;

  /** Not a prop. The handler is `onClick`: `<MenuItem onClick={edit}>`. (A `Command` item is the one that takes `onSelect`.) */
  onSelect?: { "Use <MenuItem onClick={edit}>": never };
  /** Not a prop. A menu item takes `tone`: `<MenuItem tone="destructive">`. */
  variant?: { 'Use <MenuItem tone="destructive">': never };
  /** Not a prop. For a link, pass `href`: `<MenuItem href="/recipes/1">`. */
  asChild?: { 'Use <MenuItem href="/recipes/1">': never };
  /** Not a prop. A checkable item is a `MenuCheckboxItem`: `<MenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>`. */
  checked?: { "Use <MenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>": never };
}

/** The shortcut's keys, and the dev message when they came as a string. */
function shortcutKeys(shortcut: MenuShortcut | undefined): readonly string[] | undefined {
  return typeof shortcut === "string" ? shortcut.split("+") : shortcut;
}

function shortcutWarning(component: string, shortcut: unknown): readonly [string, string] | false {
  return (
    typeof shortcut === "string" && [`shortcut="${shortcut}" is a string; shortcut takes an array`, `<${component} shortcut={["mod", "k"]}>`]
  );
}

/** The `aria-keyshortcuts` attribute for an item's shortcut, in the platform's form, which its `Kbd` (hidden from the accessible name) shows. */
function keyShortcutProps(shortcut: MenuShortcut | undefined, platform: Platform): { "aria-keyshortcuts"?: string } {
  const keys = shortcutKeys(shortcut);
  return keys ? { "aria-keyshortcuts": ariaKeyShortcuts(keys, platform) } : {};
}

/** The item's text, then its shortcut at the end. */
function ItemBody({ children, shortcut }: { children: ReactNode; shortcut: MenuShortcut | undefined }): JSX.Element {
  const keys = shortcutKeys(shortcut);
  return (
    <>
      <span data-ouro-menu-label="" className="flex min-w-0 flex-1 items-center gap-2">
        {children}
      </span>
      {keys && <Kbd keys={keys} aria-hidden="true" className="ms-auto" />}
    </>
  );
}

/**
 * One action in a `Menu`: `onClick` runs it, `href` makes it a link, `shortcut` shows its
 * keys and `tone="destructive"` marks an action that cannot be undone.
 *
 * Use `MenuCheckboxItem` instead for an on/off setting, and `MenuRadioItem` for one choice
 * of several.
 *
 * @group Menus
 *
 * @example
 * <MenuItem onClick={edit} shortcut={["mod", "e"]}>Edit</MenuItem>
 * <MenuItem href="/recipes/1/print">Print</MenuItem>
 * <MenuItem tone="destructive" onClick={remove}>Delete</MenuItem>
 */
export function MenuItem(props: MenuItemProps): JSX.Element {
  const { children, onClick, href, current, shortcut, tone: toneProp, disabled, axAction, onSelect, variant, asChild, checked } = props;
  const platform = usePlatform();
  useMenuPart("MenuItem", "<MenuItem>Edit</MenuItem>");
  const tone = toneProp === "destructive" ? "destructive" : undefined;
  useDevWarnings(
    "MenuItem",
    process.env.NODE_ENV !== "production"
      ? () => [
          onSelect !== undefined && ["onSelect is not a prop", "<MenuItem onClick={edit}>"],
          variant !== undefined && ["variant is not a prop; a menu item takes tone", '<MenuItem tone="destructive">'],
          asChild !== undefined && ["asChild is not a prop", '<MenuItem href="/recipes/1"> for a link'],
          checked !== undefined && [
            "checked is not a prop; a checkable item is a MenuCheckboxItem",
            "<MenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>",
          ],
          toneProp !== undefined && tone === undefined && toneWarning("MenuItem", String(toneProp), ["destructive"]),
          shortcutWarning("MenuItem", shortcut),
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const shared = { className: menuItemClass, "data-ouro-control": "menu", "data-ouro-part": "item", "data-tone": tone, "data-ax-action": axAction, ...keyShortcutProps(shortcut, platform), ...(onClick ? { onClick: (event: MouseEvent<HTMLElement>) => onClick(event) } : {}) };
  const body = <ItemBody shortcut={shortcut}>{children}</ItemBody>;
  // A disabled link is a disabled item: nothing to follow.
  if (href !== undefined && !disabled) {
    return (
      <BaseMenu.LinkItem {...shared} aria-current={current ? "page" : undefined} closeOnClick render={<RouterLink href={href} />}>
        {body}
      </BaseMenu.LinkItem>
    );
  }
  return (
    <BaseMenu.Item {...shared} disabled={disabled}>
      {body}
    </BaseMenu.Item>
  );
}

/** A check mark, for checkbox and radio items. */
function CheckIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Props for {@link MenuCheckboxItem}. */
export interface MenuCheckboxItemProps {
  /** The setting's text. */
  children: ReactNode;
  /** Whether it is on, to control it; pass `onCheckedChange` with it. */
  checked?: boolean | undefined;
  /** Whether it starts on, uncontrolled. */
  defaultChecked?: boolean | undefined;
  /** Called with the new state when it is toggled. */
  onCheckedChange?: ((checked: boolean) => void) | undefined;
  /** The keys of its shortcut, shown at its end: `["mod", "b"]`. */
  shortcut?: MenuShortcut | undefined;
  /** Shown, but cannot be toggled. */
  disabled?: boolean | undefined;
  /** The id of the agent action it performs, set as `data-ax-action` on it, as on a `MenuItem`. */
  axAction?: string | undefined;
}

/**
 * An on/off setting in a `Menu`, with a check mark when it is on. Toggling it keeps the menu
 * open, so several settings can change in one go.
 *
 * Use `MenuRadioItem` instead for one choice of several, and `Switch` for a setting on the page.
 *
 * @group Menus
 *
 * @example
 * <MenuCheckboxItem checked={showNotes} onCheckedChange={setShowNotes}>Show notes</MenuCheckboxItem>
 */
export function MenuCheckboxItem({ children, shortcut, onCheckedChange, axAction, ...rest }: MenuCheckboxItemProps): JSX.Element {
  const platform = usePlatform();
  useMenuPart("MenuCheckboxItem", "<MenuCheckboxItem>Pin</MenuCheckboxItem>");
  useDevWarnings(
    "MenuCheckboxItem",
    process.env.NODE_ENV !== "production" ? () => [shortcutWarning("MenuCheckboxItem", shortcut)] : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  return (
    <BaseMenu.CheckboxItem data-ouro-control="menu" data-ouro-part="checkbox-item" data-ax-action={axAction} {...rest} {...keyShortcutProps(shortcut, platform)} {...(onCheckedChange ? { onCheckedChange: (next: boolean) => onCheckedChange(next) } : {})} className={menuItemClass}>
      <span data-ouro-menu-indicator="" className={menuIndicatorClass}>
        <BaseMenu.CheckboxItemIndicator className="flex">
          <CheckIcon />
        </BaseMenu.CheckboxItemIndicator>
      </span>
      <ItemBody shortcut={shortcut}>{children}</ItemBody>
    </BaseMenu.CheckboxItem>
  );
}

/** Props for {@link MenuRadioGroup}. */
export interface MenuRadioGroupProps {
  /** The `MenuRadioItem`s. */
  children: ReactNode;
  /** Names the group, shown above it: "Sort by". */
  label?: string | undefined;
  /** The chosen value, to control it; pass `onValueChange` with it. */
  value?: string | undefined;
  /** The value chosen at first, uncontrolled. */
  defaultValue?: string | undefined;
  /** Called with the value of the item chosen. */
  onValueChange?: ((value: string) => void) | undefined;
}

/**
 * One choice of several in a `Menu`, such as a sort order: its `MenuRadioItem`s show a mark
 * on the chosen one, and choosing keeps the menu open.
 *
 * Use `MenuCheckboxItem` instead for settings that are each on or off, and `RadioGroup` for a
 * choice on the page.
 *
 * @group Menus
 *
 * @example
 * <MenuRadioGroup label="Sort by" value={sort} onValueChange={setSort}>
 *   <MenuRadioItem value="name">Name</MenuRadioItem>
 *   <MenuRadioItem value="date">Date added</MenuRadioItem>
 * </MenuRadioGroup>
 */
export function MenuRadioGroup({ children, label, onValueChange, ...rest }: MenuRadioGroupProps): JSX.Element {
  useMenuPart("MenuRadioGroup", '<MenuRadioGroup><MenuRadioItem value="a">A</MenuRadioItem></MenuRadioGroup>');
  return (
    <BaseMenu.RadioGroup {...rest} {...(onValueChange ? { onValueChange: (next: string) => onValueChange(next) } : {})}>
      {label !== undefined && <BaseMenu.GroupLabel className={menuGroupLabelClass}>{label}</BaseMenu.GroupLabel>}
      <RadioGroupContext.Provider value>{children}</RadioGroupContext.Provider>
    </BaseMenu.RadioGroup>
  );
}

/** Props for {@link MenuRadioItem}. */
export interface MenuRadioItemProps {
  /** The choice's text. */
  children: ReactNode;
  /** The value the group reports when this item is chosen. */
  value: string;
  /** The keys of its shortcut, shown at its end. */
  shortcut?: MenuShortcut | undefined;
  /** Shown, but cannot be chosen. */
  disabled?: boolean | undefined;
}

/**
 * One choice in a `MenuRadioGroup`, marked when it is the group's value.
 *
 * Use `MenuItem` instead for an action.
 *
 * @group Menus
 *
 * @example
 * <MenuRadioItem value="name">Name</MenuRadioItem>
 */
export function MenuRadioItem({ children, shortcut, ...rest }: MenuRadioItemProps): JSX.Element {
  const platform = usePlatform();
  if (!useContext(RadioGroupContext)) {
    devThrow(
      "MenuRadioItem",
      "must be rendered inside <MenuRadioGroup>",
      process.env.NODE_ENV !== "production"
        ? '<MenuRadioGroup value={sort} onValueChange={setSort}><MenuRadioItem value="name">Name</MenuRadioItem></MenuRadioGroup>'
        : /* istanbul ignore next @preserve -- production only */ "",
    );
  }
  useDevWarnings(
    "MenuRadioItem",
    process.env.NODE_ENV !== "production" ? () => [shortcutWarning("MenuRadioItem", shortcut)] : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  return (
    <BaseMenu.RadioItem data-ouro-control="menu" data-ouro-part="radio-item" {...rest} {...keyShortcutProps(shortcut, platform)} className={menuItemClass}>
      <span data-ouro-menu-indicator="" className={menuIndicatorClass}>
        <BaseMenu.RadioItemIndicator className="flex">
          <CheckIcon />
        </BaseMenu.RadioItemIndicator>
      </span>
      <ItemBody shortcut={shortcut}>{children}</ItemBody>
    </BaseMenu.RadioItem>
  );
}

/** Props for {@link MenuGroup}. */
export interface MenuGroupProps {
  /**
   * Names the group, shown above its items. It is always required.
   *
   * @claim "It is always required" registry/ouro/components/ouro/menu/menu.test-d.ts verify:fileLine(registry/ouro/components/ouro/menu/menu.test-d.ts, /\{\stype:\s"radio";\slabel:\s"Sort"\s\}>\(\)\.not\.toExtend<MenuEntry>/)
   */
  label: string;
  /** The group's items. */
  children: ReactNode;
}

/**
 * Items under a label in a `Menu`, such as "Recipe" and "Account" sections.
 *
 * Use `MenuSeparator` instead to divide items without a label, and `MenuRadioGroup` for
 * one choice of several.
 *
 * @group Menus
 *
 * @example
 * <MenuGroup label="Recipe">
 *   <MenuItem onClick={edit}>Edit</MenuItem>
 *   <MenuItem onClick={duplicate}>Duplicate</MenuItem>
 * </MenuGroup>
 */
export function MenuGroup({ label, children }: MenuGroupProps): JSX.Element {
  useMenuPart("MenuGroup", '<MenuGroup label="Recipe">…</MenuGroup>');
  useDevWarnings(
    "MenuGroup",
    process.env.NODE_ENV !== "production"
      ? () => [!label && ["label is required; it names the group for screen readers", '<MenuGroup label="Recipe">']]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel className={menuGroupLabelClass}>{label}</BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  );
}

/** A chevron pointing to the inline end, for a submenu's item; and back, for its Back item. */
function ChevronIcon({ back }: { back?: boolean }): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={back ? "rotate-180 rtl:rotate-0" : "ms-auto rtl:rotate-180"}>
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Props for {@link MenuSub}. */
export interface MenuSubProps {
  /** The text of the item that opens the submenu. */
  label: string;
  /** The submenu's items. */
  children: ReactNode;
  /** The item cannot open the submenu. */
  disabled?: boolean | undefined;
  /**
   * The label of the item at the top of the submenu on a phone, where the submenu is a sheet
   * over its menu, that goes back to it. @default "Back"
   */
  backLabel?: string | undefined;
}

/**
 * A nested menu in a `Menu`: an item that opens more items beside it, on hover, click or
 * the arrow key. On a phone it is a sheet over its menu, with a Back item at its top.
 *
 * Use `MenuGroup` instead when the items fit in the menu under a label: nested menus are
 * harder to reach.
 *
 * @group Menus
 *
 * @example
 * <MenuSub label="Share">
 *   <MenuItem onClick={copyLink}>Copy link</MenuItem>
 *   <MenuItem href={mailto}>Email</MenuItem>
 * </MenuSub>
 */
export function MenuSub({ label, children, disabled, backLabel = "Back" }: MenuSubProps): JSX.Element {
  const { sheet } = useMenuPart("MenuSub", '<MenuSub label="Share">…</MenuSub>');
  // Owned here, so the Back item can close only this submenu.
  const [open, setOpen] = useState(false);
  return (
    <BaseMenu.SubmenuRoot open={open} onOpenChange={setOpen} disabled={disabled}>
      <BaseMenu.SubmenuTrigger data-ouro-control="menu" data-ouro-part="submenu-trigger" className={menuItemClass} disabled={disabled} openOnHover={!sheet}>
        <span data-ouro-menu-label="" className="flex min-w-0 flex-1 items-center gap-2">
          {label}
        </span>
        <ChevronIcon />
      </BaseMenu.SubmenuTrigger>
      <MenuSurface sheet={sheet} context={false}>
        {sheet && (
          <BaseMenu.Item data-ouro-menu-back="" data-ouro-control="menu" data-ouro-part="back" className={menuItemClass} closeOnClick={false} onClick={() => setOpen(false)}>
            <ChevronIcon back />
            <span data-ouro-menu-label="">{backLabel}</span>
          </BaseMenu.Item>
        )}
        {children}
      </MenuSurface>
    </BaseMenu.SubmenuRoot>
  );
}

/**
 * A line between items in a `Menu`, to set apart a group of actions such as the
 * destructive ones at the end.
 *
 * Use `MenuGroup` instead when the items need a label.
 *
 * @group Menus
 *
 * @example
 * <MenuItem onClick={edit}>Edit</MenuItem>
 * <MenuSeparator />
 * <MenuItem tone="destructive" onClick={remove}>Delete</MenuItem>
 */
export function MenuSeparator(): JSX.Element {
  useMenuPart("MenuSeparator", "<MenuSeparator />");
  return <BaseMenu.Separator className={menuSeparatorClass} />;
}
