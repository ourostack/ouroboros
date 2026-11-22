"use client";

import { useEffect, type RefObject } from "react";

/**
 * The mask a box that scrolls sideways takes with {@link useScrollFade}: its content fades out
 * at each side that hides more, over as much as that side hides, up to 2rem. A gradient mask
 * is read for its alpha (`mask-mode: match-source`), so `#000` only means opaque and no color
 * of it reaches the page, in light, dark or forced colors. With nothing to the side, the box
 * has no mask at all.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 * @claim "its content fades out at each side that hides more" registry/ouro/lib/ouro/scroll-fade.test.tsx verify:testExists(registry/ouro/lib/ouro/scroll-fade.test.tsx::useScrollFade > fades the side that hides more, as far as it hides, and follows the scroll)
 * @claim "With nothing to the side, the box has no mask at all" registry/ouro/lib/ouro/scroll-fade.test.tsx verify:testExists(registry/ouro/lib/ouro/scroll-fade.test.tsx::useScrollFade > adds nothing while the content fits, or when the box clips instead of scrolling)
 * @claim "no color of it reaches the page, in light, dark or forced colors" registry/ouro/lib/ouro/scroll-fade.test.tsx verify:testExists(registry/ouro/lib/ouro/scroll-fade.test.tsx::useScrollFade > keeps the same mask in dark and forced colors, since the mask carries no color)
 * @claim "A gradient mask is read for its alpha" https://developer.mozilla.org/en-US/docs/Web/CSS/mask-mode verify:urlOk(https://developer.mozilla.org/en-US/docs/Web/CSS/mask-mode)
 */
export const scrollFadeClass =
  "data-ouro-scroll-fade:[mask-image:linear-gradient(to_right,transparent,#000_min(var(--ouro-scroll-fade-left),2rem),#000_calc(100%-min(var(--ouro-scroll-fade-right),2rem)),transparent)]"; // fade-ok: fades a scrolling row of text or controls, not a picture

/**
 * The same hint with no script, for a box drawn on the server that may never hydrate, as a static page's: added to
 * {@link scrollFadeClass}, it fades each side that hides more from the first paint, in a browser with scroll-driven
 * animations (`animation-timeline: scroll()`). The mask is two ramps, one at each side, kept where they show nothing
 * until the box scrolls: the box's own scroll timeline slides the left ramp in over the first 2rem it scrolls, and the
 * right one out over the last 2rem, in reverse in a right-to-left box. A box that fits from the start has no scroll
 * timeline, so nothing fades. Chromium holds the last fade of a box that scrolled and then widened to fit, so where that
 * matters keep the box's content at least a pixel wider than the box. Once {@link useScrollFade} runs on the box, its mask takes over and this one stands down, so a hydrated page has no
 * scroll-driven animation that a wait for every animation to finish would wait on forever. It stands down under reduced
 * motion too, where the script's fade still shows once the page hydrates. Its keyframes are in ouro-base.css, named in
 * an `animation` shorthand so that an app's Tailwind keeps them: it drops theme keyframes that only a longhand names.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 * @claim "so a hydrated page has no scroll-driven animation" registry/ouro/lib/ouro/scroll-fade.test.tsx verify:testExists(registry/ouro/lib/ouro/scroll-fade.test.tsx::useScrollFade > stands the no-script fade down once it runs, so a hydrated box has no scroll-driven animation to wait on)
 * @claim "The mask is two ramps, one at each side" registry/ouro/components/ouro/family-bar/family-bar.test.tsx verify:testExists(registry/ouro/components/ouro/family-bar/family-bar.test.tsx::FamilyBar > fades the side of the row that hides more in the server HTML alone, with no script, and nothing in a row that fits)
 * @claim "A box that fits from the start has no scroll timeline, so nothing fades" registry/ouro/components/ouro/family-bar/family-bar.test.tsx verify:testExists(registry/ouro/components/ouro/family-bar/family-bar.test.tsx::FamilyBar > fades the side of the row that hides more in the server HTML alone, with no script, and nothing in a row that fits)
 * @claim "it fades each side that hides more from the first paint" registry/ouro/components/ouro/family-bar/family-bar.test.tsx verify:testExists(registry/ouro/components/ouro/family-bar/family-bar.test.tsx::FamilyBar > fades the side of the row that hides more in the server HTML alone, with no script, and nothing in a row that fits)
 */
export const scrollFadeStaticClass =
  "[--ouro-scroll-fade-ramps:linear-gradient(to_right,transparent,#000_2rem),linear-gradient(to_left,transparent,#000_2rem)] " + // fade-ok: fades a scrolling row of text or controls, not a picture
  "supports-[animation-timeline:scroll()]:motion-safe:not-data-ouro-scroll-fade-js:[animation:ouro-scroll-fade-left_both,ouro-scroll-fade-right_both_reverse] " +
  "supports-[animation-timeline:scroll()]:motion-safe:not-data-ouro-scroll-fade-js:[animation-timeline:scroll(self_inline)] supports-[animation-timeline:scroll()]:motion-safe:not-data-ouro-scroll-fade-js:[animation-range:0_2rem,calc(100%-2rem)_100%] " +
  "supports-[animation-timeline:scroll()]:motion-safe:not-data-ouro-scroll-fade-js:rtl:[animation-name:ouro-scroll-fade-right,ouro-scroll-fade-left]";

/**
 * Shows that a box scrolls sideways: while its content is wider than it, the box gets
 * `data-ouro-scroll-fade` and how far its content runs past each side, as
 * `--ouro-scroll-fade-left` and `--ouro-scroll-fade-right`, for {@link scrollFadeClass}. At rest a
 * cut-off table or line of code fades out where it continues, rather than looking cut off.
 * Physical sides, so a right-to-left box fades on its left. It follows the scroll, the box's
 * size and its first child's size (the content), and leaves keyboard scrolling to the box.
 * Masking hides an outline on the box itself, so draw the box's focus ring on an element
 * the mask doesn't cover.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @example
 * const codeRef = useRef<HTMLPreElement>(null);
 * useScrollFade(codeRef);
 * <pre ref={codeRef} className={cn("overflow-auto", scrollFadeClass)}>…</pre>
 * @claim "Shows that a box scrolls sideways" registry/ouro/lib/ouro/scroll-fade.test.tsx verify:testExists(registry/ouro/lib/ouro/scroll-fade.test.tsx::useScrollFade > fades the side that hides more, as far as it hides, and follows the scroll)
 * @claim "Physical sides, so a right-to-left box fades on its left" registry/ouro/lib/ouro/scroll-fade.test.tsx verify:testExists(registry/ouro/lib/ouro/scroll-fade.test.tsx::useScrollFade > fades the left in a right-to-left box)
 * @claim "It follows the scroll, the box's size and its first child's size" registry/ouro/lib/ouro/scroll-fade.test.tsx verify:testExists(registry/ouro/lib/ouro/scroll-fade.test.tsx::useScrollFade > follows the box's size and its content's, and stops when it unmounts)
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>): void {
  useEffect(
    () => {
      const element = ref.current!;
      // The script fades this box from here on: scrollFadeStaticClass stands down.
      // Stryker disable next-line StringLiteral: the attribute's presence is what the class reads, not its value.
      element.setAttribute("data-ouro-scroll-fade-js", "");
      const update = () => {
        const style = getComputedStyle(element);
        const overflow = element.scrollWidth - element.clientWidth;
        // More than a pixel, so a width that rounds up never fades.
        if (overflow > 1 && /auto|scroll/.test(style.overflowX)) {
          // In a right-to-left box, scrollLeft runs from 0 down to a negative number.
          const scrolled = Math.abs(element.scrollLeft);
          const [left, right] = style.direction === "rtl" ? [overflow - scrolled, scrolled] : [scrolled, overflow - scrolled];
          element.setAttribute("data-ouro-scroll-fade", "");
          element.style.setProperty("--ouro-scroll-fade-left", `${left}px`);
          element.style.setProperty("--ouro-scroll-fade-right", `${right}px`);
        } else {
          element.removeAttribute("data-ouro-scroll-fade");
          element.style.removeProperty("--ouro-scroll-fade-left");
          element.style.removeProperty("--ouro-scroll-fade-right");
        }
      };
      const observer = new ResizeObserver(update);
      observer.observe(element);
      observer.observe(element.firstElementChild!);
      element.addEventListener("scroll", update);
      return () => {
        observer.disconnect();
        element.removeEventListener("scroll", update);
      };
    },
    // Stryker disable next-line ArrayDeclaration: a component's ref object is the same on each render, so it runs once either way.
    [ref],
  );
}
