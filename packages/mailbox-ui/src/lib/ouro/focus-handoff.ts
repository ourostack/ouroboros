"use client";

import { useCallback, type RefCallback } from "react";

/**
 * What can take focus: links, enabled form controls and anything in the tab order. A control
 * that only says it is disabled (`aria-disabled`) still can.
 */
const tabbable = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Whether an element can take focus now: laid out, and not inert or hidden from assistive tech. */
function reachable(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 && element.closest('[inert], [aria-hidden="true"]') === null;
}

/** Whether `candidate` comes after `marker` in the page, and is not inside it. */
function follows(marker: Element, candidate: Element): boolean {
  return (marker.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && !marker.contains(candidate);
}

/**
 * Where a handoff may look: no higher than `within`, and, when nothing there can take focus, `fallback`.
 *
 * @claim "Where a handoff may look" registry/ouro/lib/ouro/focus-handoff.test.tsx verify:testExists(registry/ouro/lib/ouro/focus-handoff.test.tsx::handOffFocus > climbs no higher than `within`, then focuses `fallback`, or leaves focus on the page)
 */
export interface FocusHandoffOptions {
  /**
   * The highest element the search climbs to (a toast region): focus never leaves it for a
   * control elsewhere in the page.
   *
   * @claim "The highest element the search climbs to" registry/ouro/lib/ouro/focus-handoff.test.tsx verify:testExists(registry/ouro/lib/ouro/focus-handoff.test.tsx::handOffFocus > climbs no higher than `within`, then focuses `fallback`, or leaves focus on the page)
   */
  within?: Element | null;
  /** Where focus goes when nothing within can take it (where it came from), if still in the page and reachable. */
  fallback?: HTMLElement | null;
}

/**
 * Keeps focus in the page when `root`, which holds it, is about to leave it: call it just before
 * the element goes (`useFocusHandoff` does). Once the page has updated, if focus fell to `<body>`,
 * it moves to what now stands where the element stood: the first control after it in the same
 * parent (the next attachment's remove button, the button that replaced an alert), else the last
 * one before it, else the same one level up, and so on, no higher than `within`, then to
 * `fallback`. It does nothing when focus is elsewhere, when something else has already taken it,
 * or when the element's parent left too: when a whole region goes (a route change), the app
 * decides where focus lands. A list item that held only the element (a list's row in its `<li>`)
 * may go with it: the search then starts where the item stood.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @claim "it moves to what now stands where the element stood" registry/ouro/lib/ouro/focus-handoff.test.tsx verify:testExists(registry/ouro/lib/ouro/focus-handoff.test.tsx::handOffFocus > moves focus to the next control where the element stood) verify:testExists(registry/ouro/lib/ouro/focus-handoff.test.tsx::handOffFocus > moves focus to the last control before it when nothing follows) verify:testExists(registry/ouro/lib/ouro/focus-handoff.test.tsx::handOffFocus > looks one level up when the parent holds no other control, after the part that held the element)
 * @claim "it moves to what now stands where the element stood" registry/ouro/lib/ouro/focus-handoff.test.tsx verify:testExists(registry/ouro/lib/ouro/focus-handoff.test.tsx::handOffFocus > climbs no higher than `within`, then focuses `fallback`, or leaves focus on the page)
 */
export function handOffFocus(root: Element, { within, fallback }: FocusHandoffOptions = {}): void {
  const document = root.ownerDocument;
  if (!root.contains(document.activeElement)) return;
  const own = root.parentElement;
  // The page's own root element has nothing around it to look in.
  if (own === null) return;
  // Where the element stood, and where the list item that held only it stood (a list's row goes with its <li>): the
  // search starts at the innermost of them still in the page.
  const places = [{ parent: own, previous: root.previousElementSibling }];
  if (own.matches('li, [role="listitem"]') && own.childElementCount === 1) places.push({ parent: own.parentElement!, previous: own.previousElementSibling });
  const top = within?.parentElement ?? null;
  queueMicrotask(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const place = places.find((candidate) => candidate.parent.isConnected);
    if (place === undefined) return;
    const { parent, previous } = place;
    let child: Element | null = null;
    for (let scope: Element | null = parent; scope !== null && scope !== top; child = scope, scope = scope.parentElement) {
      const candidates = [...scope.querySelectorAll<HTMLElement>(tabbable)].filter(reachable);
      if (candidates.length === 0) continue;
      // In the parent, after the element's previous sibling (from the start when it had none);
      // higher up, after the child that held it.
      const marker = child ?? (previous?.isConnected ? previous : null);
      const target = candidates.find((candidate) => marker === null || follows(marker, candidate)) ?? candidates.at(-1)!;
      target.focus();
      return;
    }
    if (fallback?.isConnected && reachable(fallback)) fallback.focus();
  });
}

/**
 * A ref that hands focus on (`handOffFocus`) when its element leaves the page while it holds
 * focus: for a component a press removes, as an alert's dismiss button or an attachment's remove
 * button does.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * `options`, read as the element goes, bounds the search (`within`) and names where focus goes when
 * nothing there can take it (`fallback`); define it outside the component, so the ref stays the same.
 *
 * @example
 * const handoff = useFocusHandoff<HTMLDivElement>();
 * const ref = useMergedRef(props.ref, handoff);
 */
export function useFocusHandoff<T extends Element>(options?: (element: T) => FocusHandoffOptions): RefCallback<T> {
  return useCallback((element: T | null) => (element === null ? undefined : () => handOffFocus(element, options?.(element))), [options]);
}
