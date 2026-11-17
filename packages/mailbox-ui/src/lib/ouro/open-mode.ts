import { devThrow } from "@/lib/ouro/dev";

/**
 * The type of `open` beside `trigger`, on an overlay that takes a trigger or `open`. A literal, so the union
 * still tells the modes apart and hover keeps the props' docs, which an object hint type would lose; and the
 * type error for both modes names the fix, where `never` reads "not assignable to type 'undefined'". Only
 * `open` takes it, because TypeScript reports `open` when both are passed; `trigger`, `onOpenChange` and
 * `anchor` stay `never`, so `DialogProps["trigger"]` keeps its value types. `DialogProps["open"]` includes
 * the literal: a wrapper reads `DialogControlledProps["open"]`. @internal
 *
 * @claim "A literal, so the union still tells" scripts/agent-types.test.mjs verify:testExists(scripts/agent-types.test.mjs::hovering any prop shows its JSDoc, including on elements with a type error)
 * @claim "A literal, so the union still tells" scripts/agent-types.test.mjs verify:testExists(scripts/agent-types.test.mjs::tsc reports exactly the expected errors, naming the fix where the case says so)
 */
export type TriggerOrOpen = "Pass trigger, or open and onOpenChange, not both";

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
