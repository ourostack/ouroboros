import type { ToneName } from "@/lib/ouro/tones";

// Builders for the `Fix:` code in className warnings. Each takes the offending
// token without variants (`bg-red-500`, `text-lg`) and returns exact code that
// does the same job with a prop. Components pass them only in development, so
// none of this ships in production bundles.

// Palette colors, and shadcn's token names (`bg-destructive`), mapped to the tone.
const PALETTE: Array<[RegExp, ToneName]> = [
  [/-(red|rose|pink|destructive)(-|\/|$)/, "destructive"],
  [/-(green|emerald|lime|teal|success)(-|\/|$)/, "success"],
  [/-(amber|yellow|orange|warning)(-|\/|$)/, "warning"],
  [/-(gray|grey|zinc|slate|neutral|stone|black|white|secondary|muted)(-|\/|$)/, "secondary"],
];

/** The tone closest to a palette color or theme token in the token, or `primary`. */
export function toneFor(token: string): ToneName {
  for (const [pattern, tone] of PALETTE) if (pattern.test(token)) return tone;
  return "primary";
}

const TEXT_SIZE = /^text-(xs|sm|base|lg|xl|\dxl)$/;

/**
 * Maps a Tailwind font-size token to a component size from `scale`, which lists
 * the component's sizes for `xs`, `sm`, `base`, `lg`, `xl`, `2xl` and `3xl` and up.
 * Returns undefined for any other token.
 */
export function sizeFor(token: string, scale: readonly [string, string, string, string, string, string, string]) {
  const match = TEXT_SIZE.exec(token);
  if (!match) return undefined;
  const step = ["xs", "sm", "base", "lg", "xl", "2xl"].indexOf(match[1]!);
  return scale[step === -1 ? 6 : step];
}

/** The theme CSS that sets the radius a `rounded-*` token asks for. Ouro UI reads shadcn's `--radius`. */
export function radiusFor(token: string): string {
  const value = token === "rounded-none" ? "0px" : token === "rounded-full" ? "999px" : "0.75rem";
  return `:root { --radius: ${value} }`;
}

const WEIGHT = /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/;

/** True for a font-weight token such as `font-bold`. */
export function isWeight(token: string): boolean {
  return WEIGHT.test(token);
}

/**
 * The fix for a `font-*` token: components set their own weight, and inherit the font
 * family, so a family class belongs on a parent.
 */
export function fontFor(component: string, token: string): string {
  if (isWeight(token)) return `remove "${token}"; ${component} sets its own weight`;
  return `<div className="${token}"><${component} /></div>`;
}
