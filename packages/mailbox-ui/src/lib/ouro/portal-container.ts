"use client";

export { PortalScope, TooltipsGrouped, TooltipsHidden, usePortalContainer };
export type { PortalContainerProps };

import { createContext, createElement, useContext, useRef, useState, useSyncExternalStore, type JSX, type ReactNode, type RefObject } from "react";
import { devWarn } from "@/lib/ouro/dev";
import { holdPageScroll } from "@/lib/ouro/page-scroll-hold";
import { useOuro } from "@/lib/ouro/use-ouro";

// Where a floating layer (Select, Menu, Combobox, Popover, Tooltip, HoverCard,
// NavigationMenu) portals to: OuroProvider's portalContainer, so it can sit inside a
// landmark, unless it opens from inside another Ouro UI portal. A Base UI `container`
// overrides its own nesting, which keeps a popup opened in a dialog inside that dialog.

/** True inside an Ouro UI portal. */
const InsidePortal = createContext(false);

/**
 * Internal: whether a container hides the controls inside it, as an auto-hiding `Toolbar` does
 * once it fades. A `Tooltip` inside closes as it turns true, so it goes with the controls it
 * names, and opens again as usual after.
 */
const TooltipsHidden = createContext(false);

/** True inside OuroProvider, which groups tooltips: once one shows, a neighbour opens at once. @internal */
const TooltipsGrouped = createContext(false);

/**
 * Wraps what renders inside an Ouro UI portal, so a popup opened from it portals into it
 * rather than into the app's portalContainer.
 *
 * @internal
 */
function PortalScope({ children }: { children: ReactNode }): JSX.Element {
  return createElement(InsidePortal.Provider, { value: true }, children);
}

/** The props {@link usePortalContainer} gives a Base UI `Portal`. */
interface PortalContainerProps {
  container?: HTMLElement;
  ref?: (node: HTMLDivElement | null) => void;
}

// Nothing announces a ref's element, so the subscription does nothing; its cleanup does nothing either.
// Stryker disable next-line ArrowFunction: React only calls the cleanup, so one that returns undefined behaves the same.
const subscribeNever = () => () => {};

const resolve = (container: HTMLElement | RefObject<HTMLElement | null> | undefined) => (container && "current" in container ? (container.current ?? undefined) : container);

/**
 * What landmarks are made of: an element in one of them is reached by moving by landmark. A
 * header or footer inside an article, aside, main, nav or section is not one. A dialog is exempt,
 * as it is announced when it opens.
 */
const landmark =
  'main, nav, aside, header:not(:is(article, aside, main, nav, section) header), footer:not(:is(article, aside, main, nav, section) footer), form[aria-label], form[aria-labelledby], section[aria-label], section[aria-labelledby], [role="main"], [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="region"], [role="search"], [role="form"], [role="dialog"], [role="alertdialog"]';

/**
 * The props for a floating layer's Base UI `Portal`: OuroProvider's `portalContainer`, and
 * in development a ref that warns when the open popup lands outside every landmark of a
 * page that has a `<main>`. Inside another Ouro UI portal it gives neither. With
 * `holdPage`, for a layer that takes focus (Menu, Popover, Select, Combobox), the ref also
 * keeps the page where it is while the layer is open (`holdPageScroll`), inside another
 * portal too; such a layer spreads `holdPageAtPress` on its trigger, so the hold starts at the
 * press that opens it.
 *
 * @internal
 * @claim "The props for a floating layer's" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > renders a popup into OuroProvider's portalContainer, given as an element)
 * @claim "The props for a floating layer's" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > warns once, in development, when a popup opens outside every landmark of a page that has a main)
 * @claim "Inside another Ouro UI portal it" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > renders a popup opened from inside another popup into that popup's portal, not the portalContainer)
 * @claim "the ref also keeps the page where it is while the layer is open" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > holdPage > with holdPage, keeps the page where it is while the layer is open, and lets it go once it closes)
 * @claim "so the hold starts at the press that opens it" registry/ouro/components/ouro/menu/menu.test.tsx verify:fileLine(registry/ouro/components/ouro/menu/menu.test.tsx, /stays open and stops the page where it is, pressed mid-scroll/)
 */
function usePortalContainer(component: string, holdPage = false): PortalContainerProps {
  const { portalContainer } = useOuro();
  const nested = useContext(InsidePortal);
  // Base UI reads its container once, as the portal mounts. A ref's element can commit after this
  // popup's portal (a popup open at once, ahead of <div ref={popups} /> in the page), so the element
  // is passed, and passed again once the ref holds it: React reads the snapshot again after commit
  // and renders again when it changed.
  const container = useSyncExternalStore(
    subscribeNever,
    () => resolve(portalContainer),
    () => undefined,
  );
  const letGo = useRef<(() => void) | undefined>(undefined);
  // One pair of ref callbacks for the layer's life: its component and holdPage are fixed where it calls this.
  const [refs] = useState(() => {
    const hold = (node: HTMLDivElement | null) => {
      letGo.current?.();
      letGo.current = node ? holdPageScroll(node) : undefined;
    };
    const check = (node: HTMLDivElement | null) => {
      if (holdPage) hold(node);
      /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
      if (process.env.NODE_ENV !== "production") {
        if (!node || !document.querySelector('main, [role="main"]') || node.parentElement!.closest(landmark)) return;
        devWarn(
          component,
          "the open popup renders outside every landmark, so screen reader users who move by landmark miss it",
          "<OuroProvider portalContainer={popups}> around the app, with <div ref={popups} /> inside <main>",
        );
      }
    };
    return { hold, check };
  });
  // A layer inside another portal (a dialog's, say) holds the page itself.
  if (nested) return holdPage ? { ref: refs.hold } : {};
  return { ...(container ? { container } : {}), ref: refs.check };
}
