import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Ouro's radius steps (rounded-ouro-lg, from ouro-base) are rounded-* classes too, so they merge as one.
// The fixed-size steps (size-ouro-8, h-ouro-144) are spacing utilities, so an app's w-20 or h-80 overrides them as well.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["ouro-sm", "ouro-md", "ouro-lg", "ouro-xl", "ouro-2xl", "ouro-3xl", "ouro-4xl"],
      spacing: [
        "ouro-0_5", "ouro-1", "ouro-1_5", "ouro-2", "ouro-2_5", "ouro-3", "ouro-3_5", "ouro-4", "ouro-5", "ouro-5_5", "ouro-6", "ouro-7", "ouro-8", "ouro-9",
        "ouro-10", "ouro-11", "ouro-12", "ouro-13", "ouro-14", "ouro-16", "ouro-17", "ouro-18", "ouro-20", "ouro-24", "ouro-28", "ouro-32", "ouro-40",
        "ouro-48", "ouro-56", "ouro-64", "ouro-72", "ouro-80", "ouro-96", "ouro-144",
      ],
    },
  },
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
