"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a CSS media query. Returns `serverDefault` during server
 * rendering and hydration, then the live value, so there is no hydration
 * mismatch. Where `matchMedia` does not exist (for example jsdom), it always
 * returns `serverDefault`.
 *
 * @example
 * const isWide = useMediaQuery("(min-width: 640px)", true);
 * @claim "Returns `serverDefault` during server rendering and" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > returns serverDefault from renderToString, whatever the viewport)
 * @claim "Returns `serverDefault` during server rendering and" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > returns the live value on the client and follows viewport changes)
 * @claim "Where `matchMedia` does not exist (for" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > falls back to serverDefault where matchMedia is missing)
 */
export function useMediaQuery(query: string, serverDefault: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof matchMedia !== "function") return () => {};
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => (typeof matchMedia === "function" ? matchMedia(query).matches : serverDefault),
    [query, serverDefault],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => serverDefault);
}
