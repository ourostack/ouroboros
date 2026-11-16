"use client";

import { useEffect, useRef } from "react";
import { checkTheme, devWarn } from "@/lib/ouro/dev";

/** A dev message as `[problem, fix]`, or a falsy value when that check passes. */
export type DevWarning = readonly [problem: string, fix: string] | false | undefined;

/**
 * Development-only prop checks for a component. `collect` returns the messages
 * for the current props; each one is logged once per component instance, after
 * render, so server rendering never warns.
 *
 * Pass `collect` only in development so its strings are stripped from
 * production builds:
 *
 * @example
 * useDevWarnings(
 *   "Button",
 *   process.env.NODE_ENV !== "production"
 *     ? () => [isLoading !== undefined && ["isLoading is not a prop", "<Button loading>"]]
 *     : undefined,
 * );
 * @claim "`collect` returns the messages for the" registry/ouro/lib/ouro/use-dev-messages.test.tsx verify:testExists(registry/ouro/lib/ouro/use-dev-messages.test.tsx::useDevWarnings > logs each message a component collects once per instance, after render)
 */
export function useDevWarnings(component: string, collect: (() => DevWarning[]) | undefined): void {
  const key = useRef({});
  useEffect(() => {
    /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
    if (process.env.NODE_ENV !== "production") {
      // Every component passes through here, so this is where the page's theme is checked, once.
      checkTheme();
      /* istanbul ignore if @preserve -- components pass `collect` in every development render */
      if (!collect) return;
      for (const warning of collect()) {
        if (warning) devWarn(component, warning[0], warning[1], key.current);
      }
    }
  });
}
