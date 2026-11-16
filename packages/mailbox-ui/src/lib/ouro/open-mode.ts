import { devThrow } from "@/lib/ouro/dev";

/**
 * Throws, with the exact fix in development, unless an overlay has exactly one
 * way to open: a `trigger`, or `open` with an `onOpenChange` function. The types
 * already forbid the other shapes; this catches untyped and `as any` callers.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @param noun How the fix names the overlay: "sheet", "dialog", "confirmation".
 * @example
 * checkOpenMode("Sheet", "sheet", trigger !== undefined, open, onOpenChange);
 */
export function checkOpenMode(
  component: string,
  noun: string,
  hasTrigger: boolean,
  open: boolean | undefined,
  onOpenChange: unknown,
): void {
  const fail = (problem: string) =>
    devThrow(
      component,
      problem,
      process.env.NODE_ENV !== "production"
        ? `Pass trigger={<Button>…</Button>} for an uncontrolled ${noun}, or open and onOpenChange to control it`
        : /* istanbul ignore next @preserve -- production only */ "",
    );
  const controlled = open !== undefined;
  if (hasTrigger && controlled) fail("takes trigger or open, not both");
  if (!hasTrigger && !controlled) fail("needs trigger or open with onOpenChange");
  if (controlled && typeof onOpenChange !== "function") fail("open needs onOpenChange");
}
