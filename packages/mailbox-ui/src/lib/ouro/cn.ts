import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Ouro's radius steps (rounded-ouro-lg, from ouro-base) are rounded-* classes too, so they merge as one.
const merge = extendTailwindMerge({
  extend: { theme: { radius: ["ouro-sm", "ouro-md", "ouro-lg", "ouro-xl", "ouro-2xl", "ouro-3xl", "ouro-4xl"] } },
});

/**
 * Joins class names and resolves Tailwind conflicts, so the last class wins. Components
 * pass their own classes first and the app's `className` last, so an app's layout
 * classes (`mt-4`, `w-full`) override Ouro UI's.
 *
 * @example
 * cn("m-0 rounded-ouro-lg", className)
 */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
