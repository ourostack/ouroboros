"use client";

import { createContext, createElement, useContext, type AnchorHTMLAttributes, type ComponentType, type Ref, type RefObject } from "react";

// The OuroProvider context and its hook, apart from the provider so ouro-provider.tsx
// exports only components (React Fast Refresh).

/** A component that renders an internal link, such as a router's `Link`. */
export type OuroLinkComponent = ComponentType<
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; ref?: Ref<HTMLAnchorElement> }
>;

/**
 * How much Ouro UI moves: `system` follows the device's reduced-motion setting, `reduced` moves
 * as with that setting on, and `full` as with it off, whatever the device says.
 */
export type OuroMotion = "system" | "reduced" | "full";

export interface OuroContextValue {
  /** Renders internal links. Defaults to a plain `<a>`. */
  linkComponent: OuroLinkComponent;
  /** Where floating popups render. Unset, they render where Base UI puts them: the end of `<body>`, or the portal they open from. */
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | undefined;
  /** How much Ouro UI moves. Unset, it follows the device: `system`. */
  motion?: OuroMotion | undefined;
  /** Whether the person asked for less: words without art or celebrations. */
  quiet?: boolean | undefined;
  strictCsp?: boolean | undefined;
}

/**
 * The link `OuroProvider` uses without a `linkComponent`: a plain `<a>`.
 *
 * @internal
 */
export const DefaultLink: OuroLinkComponent = (props) => createElement("a", props);

/**
 * The settings `OuroProvider` provides.
 *
 * @internal
 */
export const OuroContext = createContext<OuroContextValue>({ linkComponent: DefaultLink });

/**
 * Reads the `OuroProvider` settings; returns defaults when there is no provider.
 *
 * @claim "Reads the `OuroProvider` settings; returns defaults" registry/ouro/lib/ouro/ouro-provider.test.tsx verify:testExists(registry/ouro/lib/ouro/ouro-provider.test.tsx::OuroProvider and useOuro > defaults to a plain anchor without a provider)
 */
export function useOuro(): OuroContextValue {
  return useContext(OuroContext);
}
