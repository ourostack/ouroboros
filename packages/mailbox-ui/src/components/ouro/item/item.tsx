"use client";

import { createElement, useId, type HTMLAttributes, type JSX, type MouseEvent, type ReactNode, type Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { RouterLink, safeRel } from "@/lib/ouro/router-link";
import { followStretchedLink, raiseControlsClass, stretchedLinkClass } from "@/lib/ouro/stretched-link";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";

/**
 * How big an Item's media is: an `icon` in a muted 40px tile, or an image at 40, 64 or 112px.
 *
 * @claim "How big an Item's media is" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > sizes its media: sm 40px by default, md 64px, lg 112px, and an icon in a 40px tile)
 * @claim "How big an Item's media is" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > gives an icon a muted tile and hides it from screen readers)
 */
export type ItemMediaSize = "icon" | "sm" | "md" | "lg";

/**
 * The props every Item takes, with or without `href`.
 *
 * @claim "The props every Item takes, with" registry/ouro/components/ouro/item/item.test-d.ts verify:fileLine(registry/ouro/components/ouro/item/item.test-d.ts, /expectTypeOf<\{\stitle:\s"Ribs";\shref:\s"\/recipes\/1";/)
 */
export interface ItemOwnProps {
  /**
   * A short line under the title. Pass `<Text lines={2}>` to clamp a long one. With `href`, it
   * also describes the link (`aria-describedby`), so a screen reader that lands on the row hears
   * its title and then this line: a result's byline and snippet, a recipe's time.
   * @claim "so a screen reader that lands" registry/ouro/e2e/screen-reader/item.sr.spec.ts verify:fileLine(registry/ouro/e2e/screen-reader/item.sr.spec.ts, /is heard as a link by its title, then its description/)
   * @claim "With `href`, it also describes the" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item with href > describes the row's link by its description, which keeps its place under the title)
   */
  description?: ReactNode;
  /**
   * Leading media: an `<img>` (cropped square), an `Avatar`, or an icon with
   * `mediaSize="icon"`. Give an image `alt=""` when the title already names it. Beside a
   * description, it lines up with the title and the description's first line, so it stays
   * level with the title however long the description runs; beside a title alone, it is centered.
   * @claim "Beside a description, it lines up" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > keeps the media level with the title when the description runs past one line, and centered beside shorter text)
   */
  media?: ReactNode;
  /**
   * The media's size: `icon` puts an icon in a muted 40px tile (and hides it from screen
   * readers); `sm` is 40px, `md` 64px, `lg` 112px for a recipe photo.
   * @default "sm"
   * @claim "The media's size: `icon` puts an" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > sizes its media: sm 40px by default, md 64px, lg 112px, and an icon in a 40px tile)
   * @claim "The media's size: `icon` puts an" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > gives an icon a muted tile and hides it from screen readers)
   */
  mediaSize?: ItemMediaSize | (string & { 'Use "icon", "sm" (40px), "md" (64px) or "lg" (112px)': never }) | undefined;
  /**
   * Below this breakpoint the media leaves the row and runs full width above the text, at
   * 4:3, as a recipe list shows its photos on a phone; above it, it sits beside the text at
   * `mediaSize`. `always` keeps it above at every width.
   * @claim "Below this breakpoint the media leaves" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > always puts the media above the text with mediaAbove=always, with the actions beside the title)
   * @claim "Below this breakpoint the media leaves" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > stacks the actions beside media below md and the media above below sm)
   * @claim "Below this breakpoint the media leaves" registry/ouro/components/ouro/item/item.tsx verify:fileLine(registry/ouro/components/ouro/item/item.tsx, /media:\s"col-span-full\sw-full\sh-auto\saspect-\[4\/3\]\srounded-ouro-lg"/)
   * @claim "`always` keeps it above at every" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > always puts the media above the text with mediaAbove=always, with the actions beside the title)
   */
  mediaAbove?: "always" | "sm" | "md" | (string & { 'Use "always", "sm" (640px) or "md" (768px)': never }) | undefined;
  /**
   * Trailing content at the end of the row: buttons, a switch, a badge or a timestamp. With
   * `href`, controls here stay their own tab stops, above the link.
   */
  actions?: ReactNode;
  /**
   * With `actions`: on a screen with a mouse the actions wait, transparent and keeping their
   * room, until the pointer rests on the row, focus is anywhere in it, or one of them has its
   * menu open, then fade in, as in a list whose rows show Edit and Delete on hover. On a touch
   * screen they show from the start, and screen readers reach them either way.
   * @claim "With `actions`: on a screen with" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > reveals its actions with revealActions on hover, on focus anywhere in the row and while a menu of theirs is open, keeping their room)
   * @claim "On a touch screen they show" registry/ouro/components/ouro/item/item.touch.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.touch.test.tsx::shows a revealActions row's actions on a touch screen)
   * @example
   * <Item title="Lentil soup" actions={<Button variant="plain" size="sm">Edit</Button>} revealActions />
   */
  revealActions?: boolean | undefined;
  /**
   * Below this breakpoint the actions drop under the text, lined up with the title, as in a
   * settings row on a phone. Without it they stay at the end at every width.
   * @claim "Without it they stay at the" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > keeps the actions beside the text on a phone by default)
   */
  stackBelow?: "sm" | "md" | (string & { 'Use "sm" (640px) or "md" (768px)': never }) | undefined;
  /**
   * `plain` has no frame, for rows in an `ItemGroup`; `outline` is a bordered, padded box for
   * a row on its own.
   * @default "plain"
   * @claim "`plain` has no frame, for rows" registry/ouro/components/ouro/item/item.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.test.tsx::Item > is a bordered box with padding with variant=outline, and tighter with size=sm)
   * @claim "`plain` has no frame, for rows" registry/ouro/components/ouro/item/item-group.test.tsx verify:testExists(registry/ouro/components/ouro/item/item-group.test.tsx::ItemGroup > has no lines with variant=plain)
   */
  variant?: "plain" | "outline" | (string & { 'Use "plain" or "outline"; muted is a Card': never }) | undefined;
  /**
   * Row height: `md` has 12px above and below, `sm` 8px for dense lists. @default "md"
   *
   * @claim "Row height: `md` has 12px above" registry/ouro/components/ouro/item/item.tsx verify:fileLine(registry/ouro/components/ouro/item/item.tsx, /const\ssizes\s=\s\{\smd:\s"py-3",\ssm:\s"py-2"\s\}/)
   */
  size?: "md" | "sm" | (string & { 'Use "md" or "sm"': never }) | undefined;
  /**
   * The element to render. `ItemGroup` already wraps each Item in an `<li>`.
   * @default "div"
   * @claim "`ItemGroup` already wraps each Item in" registry/ouro/components/ouro/item/item-group.test.tsx verify:testExists(registry/ouro/components/ouro/item/item-group.test.tsx::ItemGroup > is a list labelled by its label, with each Item a list item)
   * @claim "`ItemGroup` already wraps each Item in" registry/ouro/components/ouro/item/item-group.test.tsx verify:testExists(registry/ouro/components/ouro/item/item-group.test.tsx::ItemGroup development messages > warns when an Item inside renders its own <li>)
   */
  as?: "div" | "li" | "article" | (string & { 'Use "div", "li" or "article"; for a link use href': never }) | undefined;
  /** Layout only: margins, grid placement (`mt-2`). Appearance classes warn in development; use `variant`. */
  className?: string | undefined;
  ref?: Ref<HTMLElement> | undefined;

  /** Not a prop. Ouro UI uses `description`: `<Item description="Four hours">`. */
  subtitle?: { 'Use <Item description="Four hours">': never };
  /** Not a prop. Ouro UI uses `media`: `<Item media={<Icon />} mediaSize="icon">`. */
  icon?: { 'Use <Item media={<Icon />} mediaSize="icon">': never };
  /** Not a prop. Ouro UI uses `media`: `<Item media={<Avatar … />}>`. */
  avatar?: { "Use <Item media={<Avatar ... />}>": never };
  /** Not a prop. Ouro UI uses `media`: `<Item media={<img src="…" alt="" />}>`. */
  image?: { 'Use <Item media={<img src="..." alt="" />}>': never };
  /** Not a prop. Ouro UI uses `media`: `<Item media={<img src="…" alt="" />}>`. */
  thumbnail?: { 'Use <Item media={<img src="..." alt="" />}>': never };
  /** Not a prop. Ouro UI uses `actions`, for one control or several: `<Item actions={<Button>…</Button>}>`. */
  action?: { "Use <Item actions={<Button>...</Button>}>": never };
  /** Not a prop. Ouro UI uses `title`: `<Item title="Braised short ribs">`. */
  label?: { 'Use <Item title="Braised short ribs">': never };
  /** Not a prop. Ouro UI uses `href`, for router links too: `<Item href="/recipes/1" title="…">`. */
  to?: { 'Use <Item href="/recipes/1" title="...">': never };
  /** Not a prop. With `href` the whole row is a link: `<Item href="/recipes/1" title="…">`. */
  asChild?: { 'Use <Item href="/recipes/1" title="...">': never };
  /** Not a prop. The chosen row is `selected`: `<Item selected={row.id === openId} onSelect={() => open(row.id)}>`. */
  active?: { "Use selected={row.id === openId}": never };
  /** Not a prop. The chosen row is `selected`: `<Item selected={row.id === openId} onSelect={() => open(row.id)}>`. */
  isSelected?: { "Use selected={row.id === openId}": never };
  /** Not a prop. The chosen row is `selected`: `<Item selected={row.id === openId} onSelect={() => open(row.id)}>`. */
  current?: { "Use selected={row.id === openId}": never };
}

/** Props for {@link Item}. The HTML attributes sit outside the `href` union, which keeps the editor's hover docs. */
export type ItemProps = Omit<HTMLAttributes<HTMLElement>, keyof ItemOwnProps | "title" | "onSelect"> &
  ItemOwnProps & {
    /** What the row is: a name, a recipe title, a setting. It is the link's text with `href`. */
    title: ReactNode;
  } & (
    | {
        /**
         * Makes the whole row one link, with one tab stop, named by its title. Internal paths
         * go through `OuroProvider`'s `linkComponent`, as with `Link`. Controls anywhere in
         * the row (a link in the description, a button in the media or the actions) stay
         * their own tab stops and take their own clicks and taps. On a touch screen the row
         * is at least 44px tall.
         * @claim "On a touch screen the row" registry/ouro/components/ouro/item/item.touch.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.touch.test.tsx::makes a linked row at least 44px tall at every size, so it is a full touch target)
         */
        href: string;
        /** Opens the link in a new tab, safely, and tells screen readers so. */
        external?: boolean | undefined;
        /** A ref to the link's `<a>`, to move focus to it. */
        linkRef?: Ref<HTMLAnchorElement> | undefined;
        /**
         * Marks the row as the page shown, as in a list of sections beside their content: the
         * link reads as the current page (`aria-current="page"`) and the row takes the selected
         * colour. Pass it on every row, `false` on the others, so the rows line up.
         */
        selected?: boolean | undefined;
        /** Only without `href`. A linked row opens its link. */
        onSelect?: never;
        /** Only without `href`. */
        buttonRef?: never;
      }
    | {
        /**
         * Makes the whole row one button, with one tab stop, named by its title: for a list
         * beside its detail, where pressing a row shows it. Controls anywhere in the row stay
         * their own tab stops and take their own presses. On a touch screen the row is at
         * least 44px tall. Use `href` instead when the row opens a page of its own.
         * @claim "On a touch screen the row" registry/ouro/components/ouro/item/item.touch.test.tsx verify:testExists(registry/ouro/components/ouro/item/item.touch.test.tsx::makes a row with onSelect at least 44px tall too, so the whole row is a touch target)
         */
        onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
        /**
         * Marks the row as the one shown: the button reads as current (`aria-current="true"`)
         * and the row takes the selected colour. Pass it on every row, `false` on the others.
         */
        selected?: boolean | undefined;
        /** A ref to the row's `<button>`, to move focus to it. */
        buttonRef?: Ref<HTMLButtonElement> | undefined;
        /** Only with `href`. */
        href?: never;
        /** Only with `href`. */
        external?: never;
        /** Only with `href`. */
        linkRef?: never;
      }
    | {
        /** Not without `href`. Add `href` to make the whole row a link. */
        href?: never;
        /** Only with `href`. */
        external?: never;
        /** Only with `href`. */
        linkRef?: never;
        /** Only with `href` or `onSelect`: a row a person can choose. */
        selected?: never;
        /** A handler, which makes the whole row a button. */
        onSelect?: never;
        /** Only with `onSelect`. */
        buttonRef?: never;
      }
  );

const elements = ["div", "li", "article"] as const;
const variants = { plain: "", outline: "rounded-ouro-xl border border-border px-4" } as const;
const sizes = { md: "py-3", sm: "py-2" } as const;
const mediaSizes = {
  icon: "size-ouro-10 rounded-ouro-lg bg-muted text-muted-foreground flex items-center justify-center *:[svg]:size-ouro-5",
  sm: "size-ouro-10 rounded-ouro-md overflow-hidden *:size-full *:object-cover",
  md: "size-ouro-16 rounded-ouro-lg overflow-hidden *:size-full *:object-cover",
  lg: "size-ouro-28 rounded-ouro-lg overflow-hidden *:size-full *:object-cover",
} as const;
// With a description, the media lines up with the title and the description's first line (24px,
// 2px apart, 20px: 46px) instead of the whole text, so it stays level with the title when the
// description runs longer. A 40px media sits 3px down that band, where centering put it before.
const mediaWithDescription = {
  icon: "self-start mt-0.75",
  sm: "self-start mt-0.75",
  md: "self-start",
  lg: "self-start",
} as const;

// revealActions follows the row's hover with a mouse, focus anywhere in it, and a menu of its actions left
// open. It hides them only where the pointer can hover, since Tailwind also negates group-hover under
// not (hover: hover), which would hide them for good from a stylus.
const revealActionsClass =
  "transition-opacity duration-(--ouro-duration-base) ease-(--ouro-ease-out) motion-reduce:duration-(--ouro-duration-fast) " +
  "pointer-fine:[@media(hover:hover)]:not-group-hover/item:not-group-focus-within/item:not-group-has-[[aria-expanded=true]]/item:opacity-0";

// Columns for each layout, and the stacked layout below a breakpoint, where the actions
// move under the text into the title's column. Literal strings so the app's Tailwind finds them.
const columns = {
  media: { actions: "grid-cols-[auto_minmax(0,1fr)_auto]", none: "grid-cols-[auto_minmax(0,1fr)]" },
  none: { actions: "grid-cols-[minmax(0,1fr)_auto]", none: "grid-cols-[minmax(0,1fr)]" },
} as const;
const stacked = {
  media: {
    sm: { root: "max-sm:grid-cols-[auto_minmax(0,1fr)]", actions: "max-sm:col-start-2 max-sm:justify-start" },
    md: { root: "max-md:grid-cols-[auto_minmax(0,1fr)]", actions: "max-md:col-start-2 max-md:justify-start" },
  },
  none: {
    sm: { root: "max-sm:grid-cols-[minmax(0,1fr)]", actions: "max-sm:col-start-1 max-sm:justify-start" },
    md: { root: "max-md:grid-cols-[minmax(0,1fr)]", actions: "max-md:col-start-1 max-md:justify-start" },
  },
} as const;

// With href, the title's link stretches over the row (`stretchedLinkClass`) and every
// control in the row sits above it (`raiseControlsClass`), as in Card and Table.
// A linked row is a full touch target on a coarse pointer, at either size.
const linkRoot =
  "press cursor-pointer outline-ring -outline-offset-2 has-[[data-item-link]:focus-visible]:outline-2 has-[[data-item-link]:focus-visible]:outline-solid " +
  "pointer-coarse:min-h-ouro-11";
// A row a person chooses (onSelect, or href with selected): its own padding and corners, so the selected colour has room
// in a group that strips them, and the selected colour when it is the one shown. Its description mixes 20% toward the
// foreground, as muted text on a muted surface does, since the stock pair is under 4.5:1.
const choosableRoot = "rounded-ouro-lg px-3";
const selectedRoot = "bg-accent text-accent-foreground [&_[data-ouro-text]]:text-[color-mix(in_oklab,var(--muted-foreground)_80%,var(--foreground))]";
// Forced colours drop the fills, so the layer the row's button or link stretches over the row draws its edge, and the
// one shown a thicker Highlight edge, which keep.
const choosableControl =
  "forced-colors:after:border forced-colors:after:border-solid forced-colors:aria-[current]:after:border-2 forced-colors:aria-[current]:after:border-[Highlight]";
// The row's button: no box of its own, the title's type, and the stretched link's layer over the row.
const buttonReset = "m-0 cursor-pointer appearance-none border-0 bg-transparent p-0 text-start font-[inherit] [font-size:inherit] [line-height:inherit]";

// With mediaAbove, below the breakpoint the media takes its own full-width row at 4:3 and
// the columns drop the media's; `always` does so at every width.
const above = {
  always: {
    root: { actions: "grid-cols-[minmax(0,1fr)_auto]", none: "grid-cols-[minmax(0,1fr)]" },
    media: "col-span-full w-full h-auto aspect-[4/3] rounded-ouro-lg",
  },
  sm: {
    root: { actions: "max-sm:grid-cols-[minmax(0,1fr)_auto]", none: "max-sm:grid-cols-[minmax(0,1fr)]" },
    media: "max-sm:col-span-full max-sm:w-full max-sm:h-auto max-sm:aspect-[4/3] max-sm:rounded-ouro-lg",
  },
  md: {
    root: { actions: "max-md:grid-cols-[minmax(0,1fr)_auto]", none: "max-md:grid-cols-[minmax(0,1fr)]" },
    media: "max-md:col-span-full max-md:w-full max-md:h-auto max-md:aspect-[4/3] max-md:rounded-ouro-lg",
  },
} as const;

/**
 * One row of a list: leading media, a title with a description, and trailing actions.
 * With `href` the whole row is one link, named by its title, with one tab stop, and the
 * actions stay their own; with `onSelect` it is one button the same way, for a list beside
 * its detail, and `selected` marks the row shown. Put rows in an `ItemGroup`, which makes
 * them a list.
 *
 * Use `Card` instead for a larger tile with a cover image and a body, and `Row` for a
 * plain horizontal layout with no list semantics.
 *
 * @group Lists
 * @see https://ui.ouroboros.bot/docs/item
 *
 * @example
 * <Item
 *   href="/recipes/short-ribs"
 *   media={<img src={photo} alt="" />}
 *   mediaSize="md"
 *   title="Braised short ribs"
 *   description="Four hours, mostly hands-off"
 * />
 * <Item title="Passkey on iPhone" description="Added May 2" actions={<Button variant="plain">Remove</Button>} stackBelow="sm" />
 * {recipes.map((recipe) => (
 *   <Item key={recipe.id} title={recipe.title} selected={recipe.id === openId} onSelect={() => setOpenId(recipe.id)} />
 * ))}
 */
export function Item(props: ItemProps): JSX.Element {
  const {
    href,
    title,
    external,
    linkRef,
    description,
    media,
    mediaSize: mediaSizeProp = "sm",
    mediaAbove: mediaAboveProp,
    actions,
    revealActions,
    stackBelow: stackBelowProp,
    variant: variantProp = "plain",
    size: sizeProp = "md",
    as: asProp = "div",
    className,
    subtitle,
    icon,
    avatar,
    image,
    thumbnail,
    action,
    label,
    to,
    asChild,
    onSelect,
    selected,
    buttonRef,
    active,
    isSelected,
    current,
    ...rest
  } = props;
  const variant = Object.hasOwn(variants, variantProp) ? (variantProp as keyof typeof variants) : "plain";
  const size = Object.hasOwn(sizes, sizeProp) ? (sizeProp as keyof typeof sizes) : "md";
  const mediaSize = Object.hasOwn(mediaSizes, mediaSizeProp) ? (mediaSizeProp as ItemMediaSize) : "sm";
  const stackBelow: "sm" | "md" | undefined = stackBelowProp === "sm" ? "sm" : stackBelowProp === "md" ? "md" : undefined;
  const mediaAbove = mediaAboveProp !== undefined && Object.hasOwn(above, mediaAboveProp) ? (mediaAboveProp as keyof typeof above) : undefined;
  const element = (elements as readonly string[]).includes(asProp) ? (asProp as (typeof elements)[number]) : "div";
  const linked = href !== undefined;
  const pressable = !linked && onSelect !== undefined;
  // A row in a list a person chooses from: a button row, or a link row told whether it is the one shown.
  const choosable = pressable || (linked && selected !== undefined);
  const descriptionId = `${useId()}description`;
  useAppearanceClassNameCheck(
    "Item",
    className,
    process.env.NODE_ENV !== "production"
      ? '<Item variant="outline">, or <ItemGroup variant="outline"> around the rows'
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Item",
    process.env.NODE_ENV !== "production"
      ? () => [
          !title && ["title is required; it names the row", '<Item title="Braised short ribs">'],
          variant !== variantProp && [`variant="${String(variantProp)}" is not a variant; use "plain", "outline"`, '<Item variant="plain">'],
          size !== sizeProp && [`size="${String(sizeProp)}" is not a size; use "md", "sm"`, '<Item size="md">'],
          mediaSize !== mediaSizeProp && [
            `mediaSize="${String(mediaSizeProp)}" is not a media size; use "icon", "sm", "md", "lg"`,
            '<Item mediaSize="lg">',
          ],
          mediaAboveProp !== undefined &&
            mediaAbove !== mediaAboveProp && [
              `mediaAbove="${String(mediaAboveProp)}" is not a breakpoint; use "always", "sm", "md"`,
              '<Item mediaAbove="sm">',
            ],
          mediaAbove !== undefined && !media && ["mediaAbove needs media", '<Item media={<img src="…" alt="" />} mediaAbove="sm">'],
          mediaAbove !== undefined &&
            Boolean(media) &&
            mediaSize === "icon" && [
              "mediaAbove is for a photo, not an icon",
              '<Item media={<img src="…" alt="" />} mediaSize="lg" mediaAbove="sm">',
            ],
          stackBelowProp !== undefined &&
            stackBelow !== stackBelowProp && [`stackBelow="${String(stackBelowProp)}" is not a breakpoint; use "sm", "md"`, '<Item stackBelow="sm">'],
          element !== asProp && [
            `as="${String(asProp)}" is not an element Item renders; use ${elements.map((name) => `"${name}"`).join(", ")}`,
            asProp === "a" ? '<Item href="/path" title="…">' : '<Item as="div">',
          ],
          subtitle !== undefined && ["subtitle is not a prop", `<Item description="${String(subtitle)}">`],
          icon !== undefined && ["icon is not a prop", '<Item media={<Icon />} mediaSize="icon">'],
          avatar !== undefined && ["avatar is not a prop", "<Item media={<Avatar … />}>"],
          image !== undefined && ["image is not a prop", `<Item media={<img src="${String(image)}" alt="" />}>`],
          thumbnail !== undefined && ["thumbnail is not a prop", `<Item media={<img src="${String(thumbnail)}" alt="" />}>`],
          action !== undefined && ["action is not a prop", "<Item actions={<Button>…</Button>}>"],
          label !== undefined && ["label is not a prop", `<Item title="${String(label)}">`],
          to !== undefined && ["to is not a prop", `<Item href="${typeof to === "string" ? to : "/path"}" title="…">`],
          asChild !== undefined && ["asChild is not a prop", '<Item href="/path" title="…">'],
          selected !== undefined &&
            !linked &&
            !pressable && ["selected marks a row a person chooses; give it onSelect, or href", "<Item selected={row.id === openId} onSelect={() => open(row.id)} title=\"…\">"],
          active !== undefined && ["active is not a prop", "<Item selected={row.id === openId} onSelect={() => open(row.id)}>"],
          isSelected !== undefined && ["isSelected is not a prop", "<Item selected={row.id === openId} onSelect={() => open(row.id)}>"],
          current !== undefined && ["current is not a prop", "<Item selected={row.id === openId} onSelect={() => open(row.id)}>"],
          revealActions === true && !actions && ["revealActions needs actions to reveal", "<Item actions={<Button>…</Button>} revealActions>"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const reveal = revealActions === true && Boolean(actions);
  const hasMedia = media ? "media" : "none";
  // Media above the text at some width: its own row there, and the stacked layout below
  // the smaller of the two breakpoints is the one without media.
  const lifted = media && mediaAbove && mediaSize !== "icon" ? above[mediaAbove] : undefined;
  const stackLayouts: { root: string; actions: string }[] = [];
  if (stackBelow && actions) {
    if (!lifted) stackLayouts.push(stacked[hasMedia][stackBelow]);
    else if (mediaAbove === "always") stackLayouts.push(stacked.none[stackBelow]);
    else {
      stackLayouts.push(stacked.media[stackBelow]);
      stackLayouts.push(stacked.none[mediaAbove === "sm" || stackBelow === "sm" ? "sm" : "md"]);
    }
  }
  return createElement(
    element,
    {
      ...rest,
      // A click anywhere on a linked row opens its link, wherever the app's layout leaves the link's layer.
      onClick: (event: MouseEvent<HTMLElement>) => (rest.onClick?.(event), followStretchedLink(event)),
      onAuxClick: (event: MouseEvent<HTMLElement>) => (rest.onAuxClick?.(event), followStretchedLink(event)),
      "data-ouro": "item",
      "data-linked": linked || pressable ? "" : undefined,
      "data-follows-link": linked || pressable ? "" : undefined,
      "data-choosable": choosable ? "" : undefined,
      className: cn(
        "relative isolate grid min-w-0 list-none items-center gap-x-4 gap-y-2",
        columns[hasMedia][actions ? "actions" : "none"],
        lifted?.root[actions ? "actions" : "none"],
        stackLayouts.map((layout) => layout.root),
        variants[variant],
        sizes[size],
        (linked || pressable) && linkRoot,
        (linked || pressable) && raiseControlsClass,
        choosable && variant === "plain" && choosableRoot,
        choosable && selected && selectedRoot,
        reveal && "group/item",
        className,
      ),
    },
    media && (
      <div
        aria-hidden={mediaSize === "icon" ? true : undefined}
        className={cn("shrink-0", mediaSizes[mediaSize], description && !lifted && mediaWithDescription[mediaSize], lifted?.media)}
      >
        {media}
      </div>
    ),
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className={cn("text-base font-medium", choosable && selected ? "text-accent-foreground" : "text-foreground")}>
        {pressable ? (
          <button
            type="button"
            ref={buttonRef}
            onClick={onSelect}
            aria-current={selected ? "true" : undefined}
            aria-describedby={description ? descriptionId : undefined}
            data-item-link=""
            data-stretched-link=""
            data-ouro-control="item"
            data-ouro-part="select"
            className={cn(buttonReset, stretchedLinkClass, variant === "outline" ? "after:rounded-ouro-xl" : "after:rounded-ouro-lg", choosableControl)}
          >
            {title}
          </button>
        ) : linked ? (
          <RouterLink
            href={href}
            ref={linkRef}
            target={external ? "_blank" : undefined}
            rel={external ? safeRel(undefined) : undefined}
            aria-current={selected ? "page" : undefined}
            aria-describedby={description ? descriptionId : undefined}
            data-item-link=""
            data-stretched-link=""
            data-ouro-control="item"
            data-ouro-part="link"
            className={cn(stretchedLinkClass, variant === "outline" ? "after:rounded-ouro-xl" : choosable && "after:rounded-ouro-lg", choosable && choosableControl)}
          >
            {title}
            {external && <span className="sr-only"> (opens in a new tab)</span>}
          </RouterLink>
        ) : (
          title
        )}
      </div>
      {description && (
        <div id={linked || pressable ? descriptionId : undefined} data-ouro-text="" className="text-sm text-muted-foreground">
          {description}
        </div>
      )}
    </div>,
    actions && (
      <div
        data-item-actions=""
        className={cn("flex flex-wrap items-center justify-end gap-2", stackLayouts.map((layout) => layout.actions), reveal && revealActionsClass)}
      >
        {actions}
      </div>
    ),
  );
}
