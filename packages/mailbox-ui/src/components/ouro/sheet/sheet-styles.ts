export { sheetSides, sideWarning, iosBackdrop, footerClass, sheetHint, registerSheetProperties };
export type { SheetSide };

// Shared class strings, value lists and dev-message helpers for Sheet, its parts and
// Dialog. They live apart from the components so each component file exports only
// components, which React Fast Refresh needs (and an app's linter checks). The export
// list comes first because the shadcn CLI drops comments before a file's first statement.

/** The edge a sheet slides in from, and is dragged back to, to dismiss. */
type SheetSide = "bottom" | "top" | "left" | "right";

/**
 * The four sides, for checking a `side` prop. Shared with `Sheet`.
 *
 * @internal
 * @claim "The four sides, for checking a" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet dev messages > warns once about guessed props and drops them)
 */
const sheetSides: readonly SheetSide[] = ["bottom", "top", "left", "right"];

/**
 * The dev message for a side that is not one of {@link sheetSides}. Development only.
 *
 * @internal
 */
function sideWarning(side: string, fix: string): readonly [string, string] {
  return [`side="${side}" is not a side; use ${sheetSides.map((name) => `"${name}"`).join(", ")}`, fix];
}

/**
 * iOS 26+ Safari draws the page under its translucent toolbars, and a fixed element
 * stops at the toolbars, leaving the page under them undimmed. Base UI's guidance is
 * position: absolute (with body { position: relative } in the app). A library cannot
 * set that on body, and Base UI's iOS scroll lock keeps the page's scroll offset, so an
 * absolute backdrop would sit at the top of the document, off screen on a scrolled
 * page. The backdrops therefore keep --ouro-backdrop-top at the offset that puts them at
 * the top of the screen (useBackdropAnchor), and the large viewport height reaches under
 * the toolbars. Shared with the dialog backdrop.
 *
 * @internal
 * @claim "iOS 26+ Safari draws the page" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet iOS backdrop rule > covers the visible screen on a page scrolled 2000px)
 * @claim "iOS 26+ Safari draws the page" registry/ouro/components/ouro/sheet/sheet-styles.ts verify:fileLine(registry/ouro/components/ouro/sheet/sheet-styles.ts, /supports-\[-webkit-touch-callout:none\]:h-lvh/)
 */
const iosBackdrop =
  "supports-[-webkit-touch-callout:none]:absolute supports-[-webkit-touch-callout:none]:inset-x-0 " +
  "supports-[-webkit-touch-callout:none]:top-[var(--ouro-backdrop-top,0px)] supports-[-webkit-touch-callout:none]:bottom-auto " +
  "supports-[-webkit-touch-callout:none]:h-lvh";

/**
 * The actions row of a Dialog, in either presentation: a row at the end from 640px up.
 * Below it the actions stack full width in DOM order, so the primary action (last)
 * sits at the bottom, nearest the thumb. Shared with `DialogFooter`.
 *
 * @internal
 * @claim "The actions row of a Dialog" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::footer > renders footer as the actions row after the body, and closes from an action wrapped in SheetClose)
 * @claim "The actions row of a Dialog" registry/ouro/components/ouro/sheet/sheet-styles.ts verify:fileLine(registry/ouro/components/ouro/sheet/sheet-styles.ts, /const\sfooterClass\s=\s"box-border\sflex\sshrink-0\sjustify-end\sgap-3\spx-5\spt-3\spb-5\smax-sm:flex-col\smax-sm:\*:w-full"/)
 * @claim "The actions row of a Dialog" registry/ouro/components/ouro/dialog/dialog.test.tsx verify:testExists(registry/ouro/components/ouro/dialog/dialog.test.tsx::footer > lays out actions in a row at the end on wide screens)
 */
const footerClass = "box-border flex shrink-0 justify-end gap-3 px-5 pt-3 pb-5 max-sm:flex-col max-sm:*:w-full";

/**
 * The Fix code for an appearance class on a sheet part: the theme's CSS variables
 * for colors and radius, or a wrapper inside `open`…`close` for text classes.
 * Development only.
 *
 * @internal
 */
function sheetHint(open: string, close: string) {
  return (token: string): string => {
    if (token.startsWith("rounded")) {
      return `:root { --radius: ${token === "rounded-none" ? "0px" : "0.75rem"} }`;
    }
    if (/^(text|font)-/.test(token)) return `${open}<div className="${token}">…</div>${close}`;
    return ":root { --popover: …; } .dark { --popover: …; }";
  };
}

/**
 * Registers the variables a drag rewrites on the sheet every frame as not inherited, so
 * the sheet's content is not restyled on each of those frames. Nothing inside a sheet
 * reads them. It does nothing where they are registered already (a second copy of this
 * module) and where there is no `CSS.registerProperty`: on the server and in a browser
 * without it, where the variables inherit as before.
 *
 * It also registers Base UI's own drawer variables, as Base UI does (DrawerPopup's layout
 * effect, through removeCSSVariableInheritance), when the module loads. Left to Base UI, they are registered as
 * its first sheet opens, restyling the whole page in the middle of that press; registered
 * here, Base UI finds them registered and does nothing.
 *
 * @internal
 * @claim "Registers the variables a drag rewrites" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::feel > keeps the variables a drag rewrites out of the sheet's content)
 * @claim "It does nothing where they are" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::feel > registers its variables once: a second copy of the module finds them registered and does nothing)
 * @claim "It also registers Base UI's own drawer variables" site/e2e/site-menu.spec.ts verify:testExists(site/e2e/site-menu.spec.ts::on a phone the menu's first open registers no CSS property, on the home page or a docs page, so it restyles no more of the page than the sheet)
 */
function registerSheetProperties(): void {
  const properties: PropertyDefinition[] = [
    ...["--ouro-sheet-x", "--ouro-sheet-y", "--ouro-sheet-grab"].map((name) => ({ name, syntax: "<length>", inherits: false, initialValue: "0px" })),
    // A transform function, which no syntax but the universal one can hold with `var()` in it.
    { name: "--ouro-sheet-transform", syntax: "*", inherits: false },
    // Base UI's, as it registers them.
    ...["--drawer-swipe-movement-x", "--drawer-swipe-movement-y", "--drawer-snap-point-offset"].map((name) => ({ name, syntax: "<length>", inherits: false, initialValue: "0px" })),
    { name: "--drawer-swipe-progress", syntax: "<number>", inherits: false, initialValue: "0" },
    { name: "--drawer-swipe-strength", syntax: "<number>", inherits: false, initialValue: "1" },
    // Base UI's too, which it sets on the popup as each sheet opens and does not register: inherited, it restyled the
    // whole sheet once more in the middle of the press. Base UI reads it on the popup only.
    { name: "--drawer-frontmost-height", syntax: "*", inherits: false },
  ];
  for (const property of properties) {
    try {
      CSS.registerProperty(property);
    } catch {
      // Registered already, or nothing to register with.
    }
  }
}
