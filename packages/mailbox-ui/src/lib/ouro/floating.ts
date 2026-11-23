import { radiusFor } from "@/lib/ouro/appearance-hints";

export {
  floatingSides,
  floatingAligns,
  floatingSide,
  floatingAlign,
  floatingPlacementWarnings,
  floatingPortalClass,
  floatingPositionMethod,
  floatingMotionClass,
  floatingSurfaceClass,
  floatingHint,
};
export type { FloatingSide, FloatingAlign };

// What every floating layer shares (Popover, Tooltip, HoverCard, and the menus built on
// them): the sides and alignments, their dev messages, the portal's stacking level, the
// surface and the motion. Class strings are literals so the app's Tailwind finds them.

/**
 * The side of its trigger a floating layer sits on. It flips to the other side when there is no room.
 *
 * @claim "It flips to the other side" https://base-ui.com/react/components/popover verify:urlOk(https://base-ui.com/react/components/popover)
 */
type FloatingSide = "top" | "bottom" | "left" | "right";

/** How a floating layer lines up with its trigger along that side. */
type FloatingAlign = "start" | "center" | "end";

/**
 * The sides, for checking a `side` prop.
 *
 * @internal
 */
const floatingSides: readonly FloatingSide[] = ["top", "bottom", "left", "right"];

/**
 * The alignments, for checking an `align` prop.
 *
 * @internal
 */
const floatingAligns: readonly FloatingAlign[] = ["start", "center", "end"];

/**
 * The side to render: `side` when it is one of {@link floatingSides}, else `fallback`.
 *
 * @internal
 */
function floatingSide(side: unknown, fallback: FloatingSide): FloatingSide {
  return floatingSides.includes(side as FloatingSide) ? (side as FloatingSide) : fallback;
}

/**
 * The alignment to render: `align` when it is one of {@link floatingAligns}, else `"center"`.
 *
 * @internal
 */
function floatingAlign(align: unknown): FloatingAlign {
  return floatingAligns.includes(align as FloatingAlign) ? (align as FloatingAlign) : "center";
}

/**
 * The dev messages for a `side` or `align` that is not one of Ouro UI's, and for the
 * guessed `placement` prop. `tag` is the JSX opening the fix starts with, such as
 * `<Popover`. Development only.
 *
 * @internal
 */
function floatingPlacementWarnings(
  tag: string,
  side: unknown,
  fallbackSide: FloatingSide,
  align: unknown,
  placement: unknown,
): Array<readonly [string, string] | false> {
  const list = (values: readonly string[]) => values.map((name) => `"${name}"`).join(", ");
  return [
    side !== undefined &&
      floatingSide(side, fallbackSide) !== side && [
        `side="${String(side)}" is not a side; use ${list(floatingSides)}`,
        `${tag} side="${fallbackSide}">`,
      ],
    align !== undefined &&
      floatingAlign(align) !== align && [
        `align="${String(align)}" is not an alignment; use ${list(floatingAligns)} (left is "start", right is "end")`,
        `${tag} align="start">`,
      ],
    placement !== undefined && [
      "placement is not a prop; Ouro UI splits it into side and align",
      `${tag} side="bottom" align="start">`,
    ],
  ];
}

/**
 * The portal: its own stacking context at `--ouro-layer`, the level apps raise with the
 * token, as for Dialog and Sheet. Opened from inside another Ouro UI layer, it renders in that
 * layer's portal, where the layer's own backdrop and viewport sit at z-1000, so it stacks at
 * 1001 there; on the page it stays at `--ouro-layer`.
 *
 * @internal
 * @claim "Opened from inside another Ouro UI" registry/ouro/components/ouro/sheet/sheet-parts.tsx verify:fileLine(registry/ouro/components/ouro/sheet/sheet-parts.tsx, /"fixed inset-0 z-1000 flex overflow-clip touch-none"/)
 * @claim "Opened from inside another Ouro UI" registry/ouro/lib/ouro/floating.ts verify:fileLine(registry/ouro/lib/ouro/floating.ts, /in-\[\[data-ouro\$='-portal'\]\]:z-1001/)
 */
const floatingPortalClass = "relative isolate z-(--ouro-layer) in-[[data-ouro$='-portal']]:z-1001";

/**
 * How a floating layer's positioner places itself: `fixed`, so the first placement is measured in the space the popup
 * is drawn in. Placed `absolute`, the first frame of a popup in a portal layer far down the page drew offset by that
 * layer's place (see the first-frame tests).
 *
 * @internal
 * @claim "Placed `absolute`, the first frame of a popup in a portal layer far down the page drew offset by that layer's place" registry/ouro/components/ouro/popover/popover.test.tsx verify:testExists(registry/ouro/components/ouro/popover/popover.test.tsx::Popover first frame > is in place from its first visible frame when its trigger opens it)
 */
const floatingPositionMethod = "fixed" satisfies "fixed";

/**
 * Opens with a scale from 0.96 and a fade, from the side of the trigger it grows out of
 * (`--transform-origin`), on the ease-out token; a component sets `--ouro-floating-duration`
 * to change the length (200ms by default). Closes in the fast duration. Reduced motion
 * keeps only the fade.
 *
 * @internal
 * @claim "Opens with a scale from 0.96" registry/ouro/lib/ouro/floating.test.ts verify:testExists(registry/ouro/lib/ouro/floating.test.ts::floatingMotionClass > eases on the ease-out token, never ease-in, and grows from the trigger)
 */
const floatingMotionClass =
  "origin-(--transform-origin) " +
  "[transition:transform_var(--ouro-floating-duration,var(--ouro-duration-base))_var(--ouro-ease-out),opacity_var(--ouro-floating-duration,var(--ouro-duration-base))_var(--ouro-ease-out)] " +
  "data-starting-style:[transform:scale(0.96)] data-starting-style:opacity-0 " +
  "data-ending-style:[transform:scale(0.96)] data-ending-style:opacity-0 " +
  "data-ending-style:duration-(--ouro-duration-fast) " +
  "motion-reduce:[transition:opacity_var(--ouro-duration-base)_var(--ouro-ease-out)] " +
  "motion-reduce:data-starting-style:[transform:none] motion-reduce:data-ending-style:[transform:none]";

/**
 * The raised surface of a popover, hover card or menu: the theme's popover colors, a
 * hairline ring and a soft shadow. Forced colours draw the ring as a solid border, so the
 * surface keeps an edge of its own whether or not a plain button inside it draws one.
 *
 * @internal
 * @claim "Forced colours draw the ring as a solid border" registry/ouro/components/ouro/popover/popover.test.tsx verify:testExists(registry/ouro/components/ouro/popover/popover.test.tsx::Popover under forced colours > keeps its own edge, whether or not a plain button inside it draws one (#3103))
 */
const floatingSurfaceClass =
  "box-border rounded-ouro-lg bg-popover text-popover-foreground outline-none " +
  "ring-1 ring-border/60 shadow-(--shadow-lg) forced-colors:border forced-colors:border-solid";

/**
 * The Fix code for an appearance class on a floating surface: the theme's CSS variables
 * for colors and radius, or a wrapper inside `open`…`close` for text classes.
 * Development only.
 *
 * @internal
 */
function floatingHint(open: string, close: string) {
  return (token: string): string => {
    if (token.startsWith("rounded")) return radiusFor(token);
    if (/^(text|font)-/.test(token)) return `${open}<div className="${token}">…</div>${close}`;
    return ":root { --popover: …; } .dark { --popover: …; }";
  };
}
