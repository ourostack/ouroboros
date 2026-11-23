export {
  foldClass,
  iconClass,
  itemClass,
  listClass,
  ownLook,
  rootClass,
  showMoreHint,
  showMoreRootClass,
  textClass,
  triggerClass,
};

// Class strings and dev-message helpers for Collapsible and ShowMore, apart from the
// components so their files export only components (React Fast Refresh). Class strings are
// literal so the app's Tailwind finds them when it compiles.

/**
 * The `Fix:` for an appearance class: the component draws its own look.
 *
 * @internal
 */
function ownLook(component: string): (token: string) => string {
  return (token) => `remove "${token}"; ${component} sets its own look`;
}

/**
 * The `Fix:` for an appearance class on ShowMore: text styles belong on a parent, so the
 * items inherit them; anything else is ShowMore's own look.
 *
 * @internal
 */
function showMoreHint(token: string): string {
  if (/^(text|font)-/.test(token)) return `<div className="${token}"><ShowMore /></div>`;
  return ownLook("ShowMore")(token);
}

/** @internal */
const rootClass = "box-border grid min-w-0 justify-items-start text-foreground";

/**
 * The title button: 44px tall on a coarse pointer, 36px from `sm` with a fine one.
 *
 * @internal
 * @claim "The title button: 44px tall on" registry/ouro/components/ouro/collapsible/collapsible.test.tsx verify:testExists(registry/ouro/components/ouro/collapsible/collapsible.test.tsx::Collapsible > gives the title a 44px row on a coarse pointer, or 36px otherwise)
 */
const triggerClass =
  "group/trigger press relative m-0 box-border inline-flex min-w-0 max-w-full cursor-pointer items-center gap-2 " +
  "min-h-ouro-11 sm:pointer-fine:min-h-9 px-0 py-2 rounded-ouro-md border-0 bg-transparent text-start forced-colors:border forced-colors:border-solid " +
  "font-[inherit] text-base font-medium text-foreground sm:pointer-fine:text-sm " +
  "select-none touch-manipulation [-webkit-tap-highlight-color:transparent] " +
  "underline-offset-4 not-data-disabled:pointer-fine:hover:underline not-data-disabled:active:opacity-70 " +
  "outline-ring outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid " +
  "data-disabled:cursor-not-allowed data-disabled:opacity-50";

/**
 * The chevron after the title: it turns over while open.
 *
 * @internal
 */
const iconClass =
  "size-ouro-4 shrink-0 text-muted-foreground transition-[rotate] duration-(--ouro-duration-base) ease-(--ouro-ease-out) " +
  "group-data-panel-open/trigger:rotate-180 motion-reduce:transition-none";

/** @internal */
const showMoreRootClass = "box-border grid min-w-0 justify-items-start gap-2";

/**
 * The list: no bullets or indent, so the items are the app's own rows.
 *
 * @internal
 * @claim "The list: no bullets or indent" registry/ouro/components/ouro/collapsible/collapsible-styles.ts verify:fileLine(registry/ouro/components/ouro/collapsible/collapsible-styles.ts, /const\slistClass\s=\s"m-0\sbox-border\sgrid\sw-full\slist-none\sgap-0\sp-0"/)
 */
const listClass = "m-0 box-border grid w-full list-none gap-0 p-0";

/**
 * A row. It takes focus from the script only, when it is the first one revealed and holds
 * nothing focusable, and shows the focus outline then.
 *
 * @internal
 */
const itemClass = "m-0 rounded-ouro-sm p-0 outline-ring outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid";

/**
 * Content folded to `--ouro-show-more-height`: once measured as too tall, its last 3rem fades
 * out (a mask, so it works on any background).
 *
 * @internal
 * @claim "its last 3rem fades out" registry/ouro/components/ouro/collapsible/collapsible-styles.ts verify:fileLine(registry/ouro/components/ouro/collapsible/collapsible-styles.ts, /mask-image:linear-gradient\(to_bottom,#000_calc\(100%-3rem\),transparent\)/)
 */
const foldClass = "relative w-full min-w-0 data-folded:[mask-image:linear-gradient(to_bottom,#000_calc(100%-3rem),transparent)]"; // fade-ok: fades folded text, not a picture

/**
 * Text clamped to `--ouro-show-more-lines` lines while collapsed.
 *
 * @internal
 */
const textClass = "m-0 w-full";
