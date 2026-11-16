"use client";

import { useCallback, type Ref, type RefCallback } from "react";
import { attachRef } from "@/lib/ouro/refs";

/**
 * A callback ref for a backdrop. It keeps the backdrop's `--ouro-backdrop-top` at
 * the offset that puts its top at the top of the screen, whatever the page's
 * scroll position, and forwards the element to the app's own `ref`.
 *
 * On iOS the backdrops are absolutely positioned (`iosBackdrop` in sheet-styles.ts), because a fixed
 * element stops at Safari's translucent toolbars. Base UI's iOS scroll lock keeps
 * the page's scroll offset, so an absolute backdrop would otherwise sit at the
 * top of the document, off screen on a scrolled page. Elsewhere the backdrop is
 * fixed and the offset stays 0, so the hook reads no layout there: a read as the backdrop
 * mounts would lay out the whole page in the middle of the press that opens it.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @example
 * function SheetBackdrop({ ref, ...props }) {
 *   return <Drawer.Backdrop {...props} ref={useBackdropAnchor(ref)} />;
 * }
 * @claim "Elsewhere the backdrop is fixed and" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet iOS backdrop rule > covers the visible screen on a page scrolled 2000px)
 * @claim "so the hook reads no layout there" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet iOS backdrop rule > reads no layout as the backdrop mounts, where the backdrop is fixed)
 */
export function useBackdropAnchor<T extends HTMLElement>(appRef: Ref<T> | undefined): RefCallback<T> {
  return useCallback(
    (element: T) => {
      // The condition iosBackdrop's rules apply under.
      if (!CSS.supports("-webkit-touch-callout", "none")) return attachRef(appRef, element);
      const anchor = () => {
        const current = Number.parseFloat(element.style.getPropertyValue("--ouro-backdrop-top")) || 0;
        element.style.setProperty("--ouro-backdrop-top", `${current - element.getBoundingClientRect().top}px`);
      };
      anchor();
      // Base UI may lock scrolling after the backdrop mounts, so check again on the next frame.
      const frame = requestAnimationFrame(anchor);
      addEventListener("scroll", anchor, { passive: true });
      addEventListener("resize", anchor);
      const detach = attachRef(appRef, element);
      return () => {
        cancelAnimationFrame(frame);
        removeEventListener("scroll", anchor);
        removeEventListener("resize", anchor);
        detach();
      };
    },
    [appRef],
  );
}
