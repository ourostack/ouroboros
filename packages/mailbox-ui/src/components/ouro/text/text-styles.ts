export { alignClasses, checkAlign };
export type { TextAlign };

// Alignment shared by Text and Heading, apart from the components so each component
// file exports only components (React Fast Refresh). The export list comes first because
// the shadcn CLI drops comments before a file's first statement.

/** Text alignment, in writing direction: `start` is left in English and right in Arabic. */
type TextAlign = "start" | "center" | "end";

/**
 * Alignment classes, shared with `Heading`.
 *
 * @internal
 */
const alignClasses = { start: "text-start", center: "text-center", end: "text-end" } as const;

/**
 * The value an `align` prop is, or `undefined` (inherited) with the dev message for one
 * that is not: `left` and `right` point to `start` and `end`. Shared with `Heading`.
 *
 * @internal
 */
function checkAlign(component: string, align: string | undefined): [TextAlign | undefined, readonly [string, string] | false] {
  if (align === undefined || Object.hasOwn(alignClasses, align)) return [align as TextAlign | undefined, false];
  const fix = align === "right" ? "end" : "start";
  return [
    undefined,
    process.env.NODE_ENV !== "production"
      ? [`align="${align}" is not an alignment; use "start", "center", "end"`, `<${component} align="${fix}">`]
      : /* istanbul ignore next @preserve -- production only */ false,
  ];
}
