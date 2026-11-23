"use client";

import { useMediaQuery } from "@/lib/ouro/use-media-query";
import { useOuro } from "@/lib/ouro/use-ouro";

/**
 * Whether to reduce motion: `true` under `<OuroProvider motion="reduced">`, `false` under
 * `motion="full"`, and otherwise what the device's `prefers-reduced-motion` says, live.
 * `serverDefault` (false unless set) is the answer while the server renders and the page
 * hydrates, as with `useMediaQuery`. Ouro UI's own motion in script (springs, smooth scrolls, a
 * moment's art) reads it; read it in your own components to follow the same setting.
 *
 * @example
 * const reduced = useReducedMotion();
 * element.scrollIntoView({ behavior: reduced ? "instant" : "smooth" });
 * @claim "`serverDefault` (false unless set) is the" registry/ouro/lib/ouro/use-reduced-motion.test.tsx verify:testExists(registry/ouro/lib/ouro/use-reduced-motion.test.tsx::useReducedMotion > answers serverDefault on the server, false unless set, and the provider's setting over it)
 * @claim "Whether to reduce motion" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider motion > answers useReducedMotion by its motion, and by the device under system or no provider)
 */
export function useReducedMotion(serverDefault?: boolean): boolean {
  const { motion } = useOuro();
  const device = useMediaQuery("(prefers-reduced-motion: reduce)", serverDefault === true);
  return motion === "reduced" || (motion !== "full" && device);
}
