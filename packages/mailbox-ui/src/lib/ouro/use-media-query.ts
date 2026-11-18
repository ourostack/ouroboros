"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The list for each query, made at most once a task: every component that reads a query in one render, or in one long task of
 * renders (a scroll that draws rows), shares one. The lists go once the task's work is done, so the next task asks `matchMedia`
 * again: WebKit's list made earlier reports a change of the media (a window resized, reduced motion turned on) only once it next
 * draws, and a new one at once. A change the list reports drops it at once, in whatever task it comes. Only a browser's own
 * `MediaQueryList` is kept, by the `matchMedia` that made it: a test's stub that answers with plain objects is asked on every
 * read, and one swapped in is asked again.
 * @claim "Only a browser's own" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > asks a stub that answers with plain objects again for a render in the same task, so one whose answer changed is followed) verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > asks a matchMedia swapped in within the task another made a list in) verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > reads a mocked matchMedia where MediaQueryList is not defined, as in jsdom)
 * @claim "A change the list reports drops it at once" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > reads the answer a change reports in the task a render read the query in, as a stub that calls its listeners does)
 * @claim "The list for each query, made at most once a task" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > calls matchMedia once for a query in a render, however many components read it)
 * @claim "The lists go once the task's work is done" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > reads a change of the media in the next task, before the browser has drawn a frame, as WebKit's lists made earlier do not)
 */
let lists: Map<string, MediaQueryList> | null = null;
// The `matchMedia` that made the lists: one swapped in (a test's stub) makes its own.
let listsFrom: typeof matchMedia | null = null;

function listFor(query: string): MediaQueryList {
  if (lists === null || listsFrom !== matchMedia) {
    lists = new Map();
    listsFrom = matchMedia;
    queueMicrotask(() => (lists = null));
  }
  const kept = lists.get(query);
  if (kept !== undefined) return kept;
  const list = matchMedia(query);
  // Only a browser's own list: a stub that answers with plain objects may answer otherwise on the next read.
  if (typeof MediaQueryList === "function" && list instanceof MediaQueryList) lists.set(query, list);
  return list;
}

/**
 * Subscribes to a CSS media query. Returns `serverDefault` during server
 * rendering and hydration, then the live value, so there is no hydration
 * mismatch. Where `matchMedia` does not exist (for example jsdom), it always
 * returns `serverDefault`. The components that read a query in one render share one
 * `MediaQueryList`, so a render asks `matchMedia` once a query, however many read it.
 *
 * @example
 * const isWide = useMediaQuery("(min-width: 640px)", true);
 * @claim "Returns `serverDefault` during server rendering and" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > returns serverDefault from renderToString, whatever the viewport)
 * @claim "Returns `serverDefault` during server rendering and" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > returns the live value on the client and follows viewport changes)
 * @claim "Where `matchMedia` does not exist (for" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > falls back to serverDefault where matchMedia is missing)
 * @claim "The components that read a query in one render share one" registry/ouro/lib/ouro/use-media-query.test.tsx verify:testExists(registry/ouro/lib/ouro/use-media-query.test.tsx::useMediaQuery > calls matchMedia once for a query in a render, however many components read it)
 */
export function useMediaQuery(query: string, serverDefault: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof matchMedia !== "function") return () => {};
      const list = listFor(query);
      // A change drops the list kept for this task, so the read that follows asks `matchMedia` for the new answer.
      const changed = () => {
        lists?.delete(query);
        onChange();
      };
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    [query],
  );
  const getSnapshot = useCallback(() => (typeof matchMedia === "function" ? listFor(query).matches : serverDefault), [query, serverDefault]);
  return useSyncExternalStore(subscribe, getSnapshot, () => serverDefault);
}
