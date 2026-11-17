"use client";

import { DirectionProvider, useDirection } from "@base-ui/react/direction-provider";
import { useLayoutEffect, useState, type JSX, type ReactNode, type RefObject } from "react";

// One observer of the page's `dir` for every component that follows it, however many are on the page.
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (observer === undefined) {
    observer = new MutationObserver(() => listeners.forEach((notify) => notify()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["dir"] });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    observer!.disconnect();
    observer = undefined;
  };
}

/**
 * Gives the Base UI parts inside it the reading direction where the component stands: in a right-to-left page or section
 * (`dir="rtl"` on `<html>` or around the component) the arrow keys and placement go right to left (ArrowLeft moves to
 * the next tab, raises a slider, opens a submenu) with no provider of the app's own, and a left-to-right section inside
 * a right-to-left page stays left to right. `of` is the component's own element (or a ref to it), rendered inside it or beside it, whose nearest `dir` decides;
 * without one, the page's. In a left-to-right place an app's own `DirectionProvider` still decides. The server and the
 * first render use the app's direction, and the browser switches once it has laid the component out.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @example
 * <PageDirection of={rootRef}>
 *   <BaseTabs.Root ref={rootRef}>…</BaseTabs.Root>
 * </PageDirection>
 * @claim "Gives the Base UI parts inside" registry/ouro/lib/ouro/page-direction.test.tsx verify:testExists(registry/ouro/lib/ouro/page-direction.test.tsx::PageDirection > gives its parts the page's direction, and follows the page when its dir changes)
 * @claim "and a left-to-right section inside" registry/ouro/lib/ouro/page-direction.test.tsx verify:testExists(registry/ouro/lib/ouro/page-direction.test.tsx::PageDirection > follows its own element's direction: a left-to-right section in a right-to-left page, and the reverse)
 * @claim "In a left-to-right place an" registry/ouro/lib/ouro/page-direction.test.tsx verify:testExists(registry/ouro/lib/ouro/page-direction.test.tsx::PageDirection > leaves an app's own direction in a left-to-right page, and renders it on the server)
 */
export function PageDirection({ of, children }: { of?: RefObject<Element | null> | Element | null | undefined; children: ReactNode }): JSX.Element {
  const own = useDirection();
  const [rtl, setRtl] = useState(false);
  useLayoutEffect(() => {
    // The nearest `dir` attribute, read without laying the page out (a computed style would force a style pass on mount).
    const read = () => setRtl(((of instanceof Element ? of : of?.current) ?? document.documentElement).closest("[dir]")?.matches('[dir="rtl" i]') === true);
    read();
    return subscribe(read);
  }, [of]);
  return <DirectionProvider direction={rtl ? "rtl" : own}>{children}</DirectionProvider>;
}
