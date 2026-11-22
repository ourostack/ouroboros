"use client";

import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * Whether the browser reveals `hidden="until-found"` content for its page search
 * (Chromium does; WebKit does not, and would show the content). False on the server, so
 * hydration matches, and closed content stays in the server HTML either way.
 *
 * @internal
 */
export function useUntilFound(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => "onbeforematch" in document.body,
    () => false,
  );
}
