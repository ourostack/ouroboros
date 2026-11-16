"use client";

import { useCallback, type RefCallback } from "react";

/**
 * Makes a scroll container a tab stop while its content overflows, so a
 * keyboard user can focus it and scroll with the arrow keys. Overflow counts
 * across as well as down when the container scrolls across, as a dialog body
 * does around a table wider than a phone. A dialog body of
 * plain text has nothing else to focus, and without this its overflow is out
 * of keyboard reach (axe `scrollable-region-focusable`, WCAG 2.1.1). It adds no
 * tab stop while the content fits.
 *
 * Pass `false` when the app set its own `tabIndex`, so the app's choice stands.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @example
 * const scrollRef = useKeyboardScrollable<HTMLDivElement>(props.tabIndex === undefined);
 * @claim "It adds no tab stop while" registry/ouro/lib/ouro/use-keyboard-scrollable.test.tsx verify:testExists(registry/ouro/lib/ouro/use-keyboard-scrollable.test.tsx::keeps the tab stop while the body has focus, and drops it on blur once the content fits)
 * @claim "Overflow counts across as well" registry/ouro/lib/ouro/use-keyboard-scrollable.test.tsx verify:testExists(registry/ouro/lib/ouro/use-keyboard-scrollable.test.tsx::makes a container a tab stop when its content overflows across, unless it clips across)
 * @claim "A dialog body of plain text" registry/ouro/lib/ouro/use-keyboard-scrollable.test.tsx verify:testExists(registry/ouro/lib/ouro/use-keyboard-scrollable.test.tsx::makes an overflowing scroll container a tab stop, so a keyboard can scroll it)
 * @claim "It adds no tab stop while" registry/ouro/lib/ouro/use-keyboard-scrollable.test.tsx verify:testExists(registry/ouro/lib/ouro/use-keyboard-scrollable.test.tsx::makes an overflowing scroll container a tab stop, so a keyboard can scroll it)
 * @claim "A dialog body of plain text" https://dequeuniversity.com/rules/axe/4.10/scrollable-region-focusable verify:urlOk(https://dequeuniversity.com/rules/axe/4.10/scrollable-region-focusable)
 * @claim "A dialog body of plain text" https://www.w3.org/TR/WCAG22/#keyboard verify:urlOk(https://www.w3.org/TR/WCAG22/#keyboard)
 */
export function useKeyboardScrollable<T extends HTMLElement>(enabled: boolean): RefCallback<T> {
  return useCallback(
    (element: T | null) => {
      if (!element || !enabled) return;
      const update = () => {
        const across = element.scrollWidth > element.clientWidth && /auto|scroll/.test(getComputedStyle(element).overflowX);
        if (element.scrollHeight > element.clientHeight || across) element.setAttribute("tabindex", "0");
        // Removing the tab stop from the focused element would drop focus to
        // <body>, out of the dialog; keep it until focus leaves (see blur below).
        else if (element !== element.ownerDocument.activeElement) element.removeAttribute("tabindex");
      };
      // The container resizes with the viewport; its content changes size as
      // children come and go and as text changes (React updates a lone text
      // child through nodeValue, which no box resize reports), so watch the
      // container, each child, and every mutation below it.
      //
      // A mutation only observes afresh: the ResizeObserver reports each newly
      // observed box after the next layout, and `update` reads the sizes then.
      // Reading them in the mutation callback would force a layout of its own
      // right after every React commit, before the browser's own one, and for
      // a container in a closed `hidden="until-found"` panel a layout of the
      // skipped content (a ship's log the voyage's every press writes to).
      const resize = new ResizeObserver(update);
      const observe = () => {
        resize.disconnect();
        resize.observe(element);
        for (const child of element.children) resize.observe(child);
      };
      const children = new MutationObserver(observe);
      observe();
      children.observe(element, { childList: true, subtree: true, characterData: true });
      element.addEventListener("blur", update);
      return () => {
        resize.disconnect();
        children.disconnect();
        element.removeEventListener("blur", update);
      };
    },
    [enabled],
  );
}
