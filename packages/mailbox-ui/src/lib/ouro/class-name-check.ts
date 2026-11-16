"use client";

import { useEffect, useRef } from "react";
import { devWarn } from "@/lib/ouro/dev";

const APPEARANCE = /^(bg|text|border|rounded|shadow|font|ring|from|via|to|fill|stroke)-/;
const BARE_APPEARANCE = /^(border|rounded|shadow|ring)$/;
const ALIGNMENT = /^text-(left|center|right|justify|start|end)$/;
/** Text wrapping, text overflow and table layout: these match APPEARANCE but are layout. */
const LAYOUT = /^(text-(wrap|nowrap|balance|pretty|ellipsis|clip)|border-(collapse|separate)|border-spacing(-[xy])?-.+)$/;

export interface ClassNameProblem {
  /** The offending class token, exactly as written. */
  token: string;
  /**
   * `align` for text alignment classes, `appearance` for everything else.
   *
   * @claim "`align` for text alignment classes, `appearance`" registry/ouro/lib/ouro/class-name-check.test.tsx verify:testExists(registry/ouro/lib/ouro/class-name-check.test.tsx::useAppearanceClassNameCheck > points alignment classes to the alignHint, or to the parent)
   * @claim "`align` for text alignment classes, `appearance`" registry/ouro/lib/ouro/class-name-check.test.tsx verify:testExists(registry/ouro/lib/ouro/class-name-check.test.tsx::useAppearanceClassNameCheck > does not warn for layout classes)
   */
  kind: "align" | "appearance";
}

/** Splits a class token on `:` outside `[...]` and `(...)` into its variants and base. */
function splitVariants(token: string): { variants: string[]; base: string } {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  return { variants, base: token.slice(start) };
}

/** The token without variants or a leading or trailing `!`, for example `text-lg` for `md:!text-lg`. */
export function baseOf(token: string): string {
  return splitVariants(token).base.replace(/^!|!$/g, "");
}

/** Returns the first class that sets appearance (or alignment), or undefined. */
export function findClassNameProblem(className: string | undefined): ClassNameProblem | undefined {
  if (!className) return undefined;
  for (const token of className.split(/\s+/)) {
    const { variants } = splitVariants(token);
    const base = baseOf(token);
    if (variants.includes("dark")) return { token, kind: "appearance" };
    if (ALIGNMENT.test(base)) return { token, kind: "align" };
    if (LAYOUT.test(base)) continue;
    if (APPEARANCE.test(base) || BARE_APPEARANCE.test(base)) return { token, kind: "appearance" };
  }
  return undefined;
}

/**
 * Development-only check that `className` is used for layout, not appearance.
 * Runs in an effect, so it never warns during server rendering, and warns at
 * most once per component instance. Removed from production builds.
 *
 * @param hint Exact code to use instead, for example `tone="destructive"`, or a
 * function that picks it from the offending token (with variants and `!`
 * removed), for example `size="lg"` for `text-lg`. Pass it only in development
 * (`process.env.NODE_ENV !== "production" ? hint : ""`) so its text is
 * stripped from production builds.
 * @param alignHint Exact code for alignment classes when the component has an
 * `align` prop, for example `align="center"`. Without it the message says
 * alignment is the parent's job.
 * @claim "Runs in an effect, so it" registry/ouro/lib/ouro/class-name-check.test.tsx verify:testExists(registry/ouro/lib/ouro/class-name-check.test.tsx::useAppearanceClassNameCheck > never warns during server rendering)
 * @claim "Runs in an effect, so it" registry/ouro/lib/ouro/class-name-check.test.tsx verify:testExists(registry/ouro/lib/ouro/class-name-check.test.tsx::useAppearanceClassNameCheck > warns once per instance, and again for another instance)
 */
export function useAppearanceClassNameCheck(
  component: string,
  className: string | undefined,
  hint: string | ((token: string) => string),
  alignHint?: string,
): void {
  const warned = useRef(false);
  useEffect(() => {
    /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
    if (process.env.NODE_ENV !== "production") {
      if (warned.current) return;
      const problem = findClassNameProblem(className);
      if (!problem) return;
      warned.current = true;
      if (problem.kind === "align") {
        devWarn(
          component,
          `"${problem.token}" aligns content, and className is for layout only`,
          alignHint ?? `<div className="${problem.token}"><${component} /></div>`,
          warned,
        );
      } else {
        devWarn(
          component,
          `"${problem.token}" sets appearance, and className is for layout only`,
          typeof hint === "function" ? hint(baseOf(problem.token)) : hint,
          warned,
        );
      }
    }
  }, [component, className, hint, alignHint]);
}
