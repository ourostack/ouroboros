import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names and resolves Tailwind conflicts, so the last class wins. Components
 * pass their own classes first and the app's `className` last, so an app's layout
 * classes (`mt-4`, `w-full`) override Ouro UI's.
 *
 * @example
 * cn("m-0 rounded-lg", className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
