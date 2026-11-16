"use client";

import { createElement, type AnchorHTMLAttributes, type ComponentProps, type JSX, type Ref } from "react";
import { useOuro, type OuroLinkComponent } from "@/lib/ouro/use-ouro";

// The one path every Ouro link takes (Button with href, Link): internal paths render through
// OuroProvider's linkComponent, document loads and downloads as a plain <a>.

/** Absolute URLs (`https:`, `mailto:`, protocol-relative) skip the router link. */
const EXTERNAL = /^([a-z][a-z\d+.-]*:|\/\/)/i;

/**
 * Whether an `href` is an absolute URL, which renders as a plain `<a>` rather than the
 * router's link.
 *
 * @internal
 */
export function isExternalHref(href: string): boolean {
  return EXTERNAL.test(href);
}

/**
 * `rel` with `noopener` and `noreferrer` added once each, keeping the caller's tokens.
 *
 * @internal
 * @claim "`rel` with `noopener` and `noreferrer` added" registry/ouro/components/ouro/link/link.test.tsx verify:testExists(registry/ouro/components/ouro/link/link.test.tsx::Link > keeps the app's rel tokens with external)
 */
export function safeRel(rel: string | undefined): string {
  const tokens = new Set((rel ?? "").split(/\s+/).filter(Boolean));
  tokens.add("noopener");
  tokens.add("noreferrer");
  return [...tokens].join(" ");
}

/** Props for {@link RouterLink}: an anchor's attributes with a required `href`. */
export type RouterLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  /** Renders a plain `<a>` for an internal path too, so the browser loads the page itself. */
  reloadDocument?: boolean | undefined;
  ref?: Ref<HTMLAnchorElement> | undefined;
};

/**
 * Renders an internal `href` through `OuroProvider`'s `linkComponent` (your router's
 * link) and an absolute URL, or any `href` with `reloadDocument` or a download attribute, as a plain `<a>`. An absolute URL with `target="_blank"`
 * always gets `rel="noopener noreferrer"`, merged with any `rel` passed.
 *
 * @internal Shared by Button and Link; apps use those.
 * @claim "`, merged with any `rel` passed." registry/ouro/components/ouro/button/button.test.tsx verify:testExists(registry/ouro/components/ouro/button/button.test.tsx::link branch > merges an explicit rel with noopener noreferrer on an external _blank link)
 */
export function RouterLink({ href, target, rel, reloadDocument, ...props }: RouterLinkProps): JSX.Element {
  const { linkComponent } = useOuro();
  const external = isExternalHref(href);
  // `ref` may be `undefined` here, which the adapter's type rules out under
  // exactOptionalPropertyTypes; React treats an undefined ref as none.
  const linkProps = {
    ...props,
    href,
    target,
    rel: external && target === "_blank" ? safeRel(rel) : rel,
  } as ComponentProps<OuroLinkComponent>;
  const download = props.download !== undefined && props.download !== null && props.download !== false;
  return external || reloadDocument || download ? createElement("a", linkProps) : createElement(linkComponent, linkProps);
}
