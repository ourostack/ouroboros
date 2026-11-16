"use client";

import { CSPProvider } from "@base-ui/react/csp-provider";
import { Tooltip } from "@base-ui/react/tooltip";
import { useEffect, useLayoutEffect, useMemo, type JSX, type ReactNode, type RefObject } from "react";
import { TooltipsGrouped } from "@/lib/ouro/portal-container";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { DefaultLink, OuroContext, useOuro, type OuroContextValue, type OuroLinkComponent, type OuroMotion } from "@/lib/ouro/use-ouro";

export type { OuroContextValue, OuroLinkComponent, OuroMotion } from "@/lib/ouro/use-ouro";

/** Props for {@link OuroProvider}. */
export interface OuroProviderProps {
  /** Your app, or the part of it that uses Ouro UI. */
  children: ReactNode;
  /** Renders internal `href`s, for example an adapter around a router's `Link`. */
  linkComponent?: OuroLinkComponent;
  /**
   * The element floating popups render into: the lists of `Select` and `Combobox`, and
   * `Menu`, `Popover`, `DatePicker`, `Tooltip`, `HoverCard` and `NavigationMenu`. Unset,
   * they render at the end of `<body>`, outside every landmark, where screen reader users
   * who move by landmark miss them. Pass an element, or a ref to one, inside `<main>` that
   * does not clip what it holds (no `overflow` other than `visible`) and is not inside an
   * element with a `transform`, `filter` or `contain`, which would hold the phone sheets'
   * `position: fixed`. Render it last in `<main>`, after the content, so popups stack over the
   * page; a ref works even when the element comes after a popup that is open at once. A
   * provider inside another keeps the outer one's container when it sets none, and `null`
   * gives popups Base UI's place again: wrap the content of a dialog that is not Ouro UI's in
   * `<OuroProvider portalContainer={null}>` so its popups open inside it. Dialogs, sheets and
   * toasts stay at the end of `<body>`: a dialog is announced when it opens, and the toasts
   * are a landmark of their own.
   * @claim "Unset, they render at the end of" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > leaves a popup at the end of <body>, Base UI's default, without a portalContainer)
   * @claim "Pass an element, or a ref to" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > renders a popup into OuroProvider's portalContainer, given as an element)
   * @claim "Pass an element, or a ref to" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > renders a popup into OuroProvider's portalContainer, given as a ref)
   * @claim "a ref works even when the" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > renders a popup open on the first render into a portalContainer ref whose element comes later in the page)
   * @claim "A provider inside another keeps the" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > keeps the portalContainer of an outer OuroProvider inside one that does not set it)
   * @claim "A provider inside another keeps the" registry/ouro/lib/ouro/portal-container.test.tsx verify:testExists(registry/ouro/lib/ouro/portal-container.test.tsx::usePortalContainer > gives popups Base UI's own place again inside an OuroProvider whose portalContainer is null, as an app's own dialog needs)
   */
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | null | undefined;
  /**
   * How much Ouro UI moves, for an app with a motion setting of its own. `system` follows the
   * device's reduced-motion setting, as Ouro UI does without a provider. `reduced` moves as if
   * that setting were on, whatever the device says: springs settle at once, scrolls jump, and
   * a moment or an emoji holds still. `full` keeps that motion running even where the device
   * asks for less.
   * Ouro UI's motion in script reads it, as does `useReducedMotion` for your own: it is in
   * `lib/ouro/use-reduced-motion`, which you can add by name, `lib-use-reduced-motion`. A provider
   * that sets it wraps its children in an element with `data-motion` set to it (and
   * `display: contents`, so it adds no box), so your CSS can follow the setting too, beside
   * the `prefers-reduced-motion` media query: `[data-motion="reduced"] .wave { animation: none }`.
   * While a provider with `reduced` is on the page, Ouro UI's CSS animations and transitions,
   * and your own, end at once everywhere but inside a provider set to `full`. It does this with a
   * `<style>` of its own (a constructed stylesheet under `strictCsp`), the one stylesheet an Ouro UI component brings: an app's own setting must
   * still the dialogs, sheets and toasts that render outside the provider's element too, and Ouro
   * UI's classes follow only the device's media query. With `full`, a transition Ouro UI keeps
   * for `prefers-reduced-motion: no-preference` still follows the device.
   * A provider inside another keeps the outer one's setting when it sets none.
   * @claim "`reduced` moves as if that setting" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider motion > answers useReducedMotion by its motion, and by the device under system or no provider)
   * @claim "`full` keeps that motion running" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider motion > answers useReducedMotion by its motion, and by the device under system or no provider)
   * @claim "A provider that sets it wraps" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider motion > marks its children's element with data-motion, adding no box, and adds no element without motion)
   * @claim "While a provider with `reduced` is" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider motion > ends CSS transitions at once under reduced, in a portal too, but not inside a provider set to full)
   * @claim "A provider inside another keeps the outer one's setting" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider motion > keeps an outer provider's motion inside one that sets none)
   * @default "system"
   */
  motion?: OuroMotion | (string & { 'Use "system", "reduced" or "full"': never }) | undefined;
  /**
   * For people who want less: `Moment` shows its words without art or a celebration, and
   * `Celebrate` its message without confetti. While it is on, `<html>` carries
   * `data-ouro-quiet`, so an app hides its own decoration with one rule:
   * `[data-ouro-quiet] [data-ouro-quiet-hide] { display: none; }`. A provider inside another
   * keeps the outer one's setting when it sets none. Store the person's choice as you store
   * their other settings, and pass it here.
   * @default false
   * @claim "For people who want less: `Moment`" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider quiet > tells components the person asked for less, and marks the page while it is on)
   * @claim "A provider inside another keeps the" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider quiet > keeps an outer provider's quiet inside one that sets none, and lets an inner one turn it off)
   */
  quiet?: boolean | undefined;
  /**
   * For a page whose Content Security Policy refuses inline styles: `style-src 'self'`, without
   * `'unsafe-inline'` or a nonce. Ouro UI then adds no `<style>` element: the Base UI parts it is
   * built on render none (Base UI's `CSPProvider` with `disableStyleElements`, which this sets for
   * you), and `motion="reduced"` stills the page with a constructed stylesheet
   * (`document.adoptedStyleSheets`), which the policy allows, from the first render in the
   * browser. Styles that components set from script still apply. Wrap the app in it
   * once, at the root; a provider inside another keeps the outer one's setting when it sets none.
   * @claim "For a page whose Content Security" test/strict-csp.test.tsx verify:testExists(test/strict-csp.test.tsx::under style-src 'self' > OuroProvider strictCsp adds no <style> element, and the page breaks no rule of its policy, in every part that would add one)
   * @claim "Ouro UI then adds no `<style>`" test/strict-csp.test.tsx verify:testExists(test/strict-csp.test.tsx::under style-src 'self' > OuroProvider strictCsp adds no <style> element, and the page breaks no rule of its policy, in every part that would add one)
   * @claim "a provider inside another keeps the" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider strictCsp > keeps an outer provider's strictCsp inside one that sets none, and lets an inner one turn it off)
   * @default false
   */
  strictCsp?: boolean | undefined;

  /** Not a prop. Ouro UI sets Base UI's `disableStyleElements` for you: `<OuroProvider strictCsp>`. */
  disableStyleElements?: { "Use <OuroProvider strictCsp>": never };
}

const motions = ["system", "reduced", "full"] as const;

// Under motion="reduced", CSS animations and transitions end at once, popups and toasts
// outside the provider's element included, but not inside a provider set to "full".
const stillCss =
  '*:not([data-motion="full"], [data-motion="full"] *), *:not([data-motion="full"] *)::before, *:not([data-motion="full"] *)::after ' +
  "{ animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; transition-delay: 0s !important; scroll-behavior: auto !important; }";

// How many quiet providers are mounted, so the page stays marked until the last one goes.
let quietProviders = 0;

/**
 * Optional app-level provider that routes internal `href`s through your
 * router's link and groups tooltips: once one `Tooltip` shows, its neighbours open
 * instantly instead of each waiting its own delay. Ouro UI components work without it: they honor reduced motion
 * themselves, in CSS (`motion-reduce:` variants and `prefers-reduced-motion`
 * queries), and need no animation library. If your app animates with Motion,
 * wrap it in `<MotionConfig reducedMotion="user">` for the same behavior.
 *
 * An app with a motion setting of its own passes it as `motion`: `<OuroProvider
 * motion={still ? "reduced" : "system"}>`. Its springs, scrolls and moving pictures then
 * follow the app's setting, and your components can too, through `useReducedMotion()`.
 *
 * It installs with every component that renders links (`Button`, `Link`, `Card`, `Item`,
 * `Table` and the navigation components) and with `Tooltip`. An app with none of those adds
 * it by name, `lib-ouro-provider`, at the release tag of your other components (the
 * README's Next.js steps show the command).
 * Type a custom adapter with `ComponentProps<OuroLinkComponent>` so it always
 * compiles, including under `exactOptionalPropertyTypes`.
 *
 * Every Ouro UI link takes `href`: `Link`, `Button`, `Card`, `Item` and `Table` rows. An
 * internal `href` (a path) renders through `linkComponent`; an absolute URL (`https:`,
 * `mailto:`) always renders a plain `<a>`. Without a provider, or without `linkComponent`,
 * internal links are plain `<a>` elements too, so they work but load the page.
 *
 * Under a Content Security Policy that refuses inline styles (`style-src 'self'`), pass
 * `strictCsp`, in place of Base UI's `CSPProvider`, and no Ouro UI part adds a `<style>`.
 *
 * React Router's `Link` takes `to`, so it needs the adapter in the example, which maps
 * `href` to `to`. Wrap the app once, in the root route.
 *
 * In Next.js, `next/link`'s `Link` takes `href` and needs no adapter, but a Server
 * Component can't pass `Link`, a function, to a client component: render the provider from
 * a client file, `app/providers.tsx` in the example, and wrap the app in it from
 * `app/layout.tsx`, which stays a Server Component.
 *
 * @group App setup
 * @see https://ui.ouroboros.bot/docs/ouro-provider
 * @example
 * // React Router. app/components/ouro-router-link.tsx:
 * import type { ComponentProps } from "react";
 * import { Link } from "react-router";
 * import type { OuroLinkComponent } from "@/lib/ouro/use-ouro";
 *
 * export function OuroRouterLink({ href, ...props }: ComponentProps<OuroLinkComponent>) {
 *   return <Link to={href} {...props} />;
 * }
 *
 * // app/root.tsx:
 * import { Outlet } from "react-router";
 * import { OuroProvider } from "@/lib/ouro/ouro-provider";
 * import { OuroRouterLink } from "@/components/ouro-router-link";
 *
 * export default function App() {
 *   return (
 *     <OuroProvider linkComponent={OuroRouterLink}>
 *       <Outlet />
 *     </OuroProvider>
 *   );
 * }
 *
 * // Next.js App Router. app/providers.tsx:
 * "use client";
 *
 * import Link from "next/link";
 * import type { ReactNode } from "react";
 * import { OuroProvider } from "@/lib/ouro/ouro-provider";
 *
 * export function Providers({ children }: { children: ReactNode }) {
 *   return <OuroProvider linkComponent={Link}>{children}</OuroProvider>;
 * }
 *
 * // app/layout.tsx, a Server Component:
 * import type { ReactNode } from "react";
 * import { Providers } from "./providers";
 *
 * export default function RootLayout({ children }: { children: ReactNode }) {
 *   return (
 *     <html lang="en">
 *       <body>
 *         <Providers>{children}</Providers>
 *       </body>
 *     </html>
 *   );
 * }
 * @claim "Under a Content Security Policy that" test/strict-csp.test.tsx verify:testExists(test/strict-csp.test.tsx::under style-src 'self' > OuroProvider strictCsp adds no <style> element, and the page breaks no rule of its policy, in every part that would add one)
 * @claim "An app with none of those" scripts/registry.mts verify:fileLine(scripts/registry.mts, /entry\.name === "lib-router-link" \|\| entry\.name === "tooltip"\) registryDeps\.add\("lib-ouro-provider"\)/)
 * @claim "Optional app-level provider that routes internal" registry/ouro/components/ouro/link/link.test-d.ts verify:fileLine(registry/ouro/components/ouro/link/link.test-d.ts, /expectTypeOf<\{\shref:\s"\/recipes";\schildren:\s"Recipes"\s\}>\(\)\.toExtend<LinkProps>/)
 * @claim "Every Ouro UI link takes `href`" registry/ouro/components/ouro/link/link.test-d.ts verify:fileLine(registry/ouro/components/ouro/link/link.test-d.ts, /expectTypeOf<\{\shref:\s"\/recipes";\schildren:\s"Recipes"\s\}>\(\)\.toExtend<LinkProps>/)
 * @claim "An internal `href` (a path) renders" registry/ouro/components/ouro/link/link.test-d.ts verify:fileLine(registry/ouro/components/ouro/link/link.test-d.ts, /expectTypeOf<\{\shref:\s"\/recipes";\schildren:\s"Recipes"\s\}>\(\)\.toExtend<LinkProps>/)
 * @claim "In Next.js, `next/link`'s `Link` takes `href`" registry/ouro/components/ouro/link/link.test-d.ts verify:fileLine(registry/ouro/components/ouro/link/link.test-d.ts, /expectTypeOf<\{\shref:\s"\/recipes";\schildren:\s"Recipes"\s\}>\(\)\.toExtend<LinkProps>/)
 * @claim "Ouro UI components work without it" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider and useOuro > defaults to a plain anchor without a provider)
 * @claim "Ouro UI components work without it" scripts/registry.test.mjs verify:testExists(scripts/registry.test.mjs::npm dependencies are pinned to the ranges this repository tests)
 * @claim "It installs with every component that" scripts/registry.test.mjs verify:testExists(scripts/registry.test.mjs::registryDependencies are the same-repo items each item imports, as full unpinned addresses)
 */
export function OuroProvider({
  children,
  linkComponent,
  portalContainer,
  motion: motionProp,
  quiet: quietProp,
  strictCsp: strictCspProp,
  disableStyleElements,
}: OuroProviderProps): JSX.Element {
  const outer = useOuro();
  const container = portalContainer === undefined ? outer.portalContainer : (portalContainer ?? undefined);
  // A setting that is not one (a type error) warns and follows the device.
  const own = motionProp === undefined ? undefined : (motions as readonly string[]).includes(motionProp) ? (motionProp as OuroMotion) : "system";
  const motion = own ?? outer.motion;
  const quiet = quietProp ?? outer.quiet === true;
  const strictCsp = strictCspProp ?? outer.strictCsp === true;
  useDevWarnings(
    "OuroProvider",
    process.env.NODE_ENV !== "production"
      ? () => [
          own !== motionProp && [`motion="${String(motionProp)}" is not a setting; use "system", "reduced" or "full"`, '<OuroProvider motion="reduced">'],
          disableStyleElements !== undefined && ["disableStyleElements is not a prop", "<OuroProvider strictCsp>"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const value = useMemo<OuroContextValue>(
    () => ({ linkComponent: linkComponent ?? DefaultLink, ...(container ? { portalContainer: container } : {}), ...(motion ? { motion } : {}), quiet, strictCsp }),
    [linkComponent, container, motion, quiet, strictCsp],
  );
  // Under strictCsp the still stylesheet is a constructed one, which a policy without 'unsafe-inline' allows.
  const stillSheet = own === "reduced" && strictCsp;
  useLayoutEffect(() => {
    if (!stillSheet) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(stillCss);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
    };
  }, [stillSheet]);
  useEffect(() => {
    if (!quiet) return;
    quietProviders += 1;
    document.documentElement.setAttribute("data-ouro-quiet", "");
    return () => {
      quietProviders -= 1;
      if (quietProviders === 0) document.documentElement.removeAttribute("data-ouro-quiet");
    };
  }, [quiet]);
  const tooltips = (
    <Tooltip.Provider>
      <TooltipsGrouped value>{children}</TooltipsGrouped>
    </Tooltip.Provider>
  );
  const content = strictCspProp === undefined ? tooltips : <CSPProvider disableStyleElements={strictCspProp}>{tooltips}</CSPProvider>;
  return (
    <OuroContext.Provider value={value}>
      {own === undefined ? (
        content
      ) : (
        <div data-motion={own} style={{ display: "contents" }}>
          {own === "reduced" && !strictCsp && (
            // In place, not hoisted: React keeps a hoisted style after its provider goes, and this one must go with it.
            <style>
              {stillCss}
            </style>
          )}
          {content}
        </div>
      )}
    </OuroContext.Provider>
  );
}
