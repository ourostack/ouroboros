"use client";

import { useSyncExternalStore } from "react";
import { detectPlatform, type Platform } from "@/lib/ouro/platform";

export { usePlatform };

// The platform never changes, so there is nothing to subscribe to.
// Stryker disable next-line ArrowFunction: React ignores an undefined unsubscribe, the same as a no-op one, since the platform never changes.
const subscribe = () => () => {};
// The server can't know the platform, so it and the hydrating client render the "unknown"
// form; React then re-renders with the real platform after hydration, without a mismatch.
const serverPlatform = (): Platform => "unknown";

/**
 * The reader's platform, for a component to show a shortcut in that platform's form. It is
 * `unknown` on the server and while hydrating, and the platform's own after hydration.
 * @claim "It is `unknown` on the server and while hydrating" registry/ouro/lib/ouro/use-platform.test.tsx verify:testExists(registry/ouro/lib/ouro/use-platform.test.tsx::usePlatform > renders unknown on the server, where the platform is not known)
 * @claim "the platform's own after hydration" registry/ouro/lib/ouro/use-platform.test.tsx verify:testExists(registry/ouro/lib/ouro/use-platform.test.tsx::usePlatform > hydrates the server's unknown without a mismatch, then shows the platform)
 *
 * @example
 * const platform = usePlatform();
 * <button aria-keyshortcuts={ariaKeyShortcuts(["mod", "k"], platform)} />
 */
function usePlatform(): Platform {
  return useSyncExternalStore(subscribe, detectPlatform, serverPlatform);
}
