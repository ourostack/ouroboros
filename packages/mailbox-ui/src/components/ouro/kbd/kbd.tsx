"use client";

import { Fragment, useSyncExternalStore } from "react";
import type { HTMLAttributes, JSX, Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";

/** The props Kbd adds to the `<kbd>` attributes it passes through. */
export interface KbdOwnProps {
  /**
   * The keys to press together, by name: `["mod", "k"]`. `mod` is ⌘ on Apple platforms
   * and Ctrl elsewhere, the portable choice for an app shortcut. Modifier names: `mod`,
   * `cmd` (`meta`: ⌘ on Apple, Win on Windows, Ctrl on Linux and ChromeOS), `ctrl`, `alt`
   * (`option`), `shift`. Modifiers show in the platform's order (⌃⌥⇧⌘ on Apple, Win+Ctrl+Alt+Shift
   * elsewhere), then the other keys as given. Other names: `enter`, `escape`,
   * `tab`, `backspace`, `delete`, `space`, `up`, `down`, `left`, `right`. Any other
   * string shows as written, a single letter in capitals.
   */
  keys: readonly string[] | (string & { 'Use an array: keys={["mod", "k"]}': never });
  /** Layout only: margins (`ms-2`). Appearance classes warn in development; Kbd sizes itself to the surrounding text. */
  className?: string | undefined;
  ref?: Ref<HTMLElement> | undefined;

  /**
   * Not a prop. Kbd takes `keys`, so each platform gets the right glyphs: `<Kbd keys={["mod", "k"]} />`.
   *
   * @claim "Kbd takes `keys`, so each platform" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > names Apple glyphs for screen readers)
   * @claim "Kbd takes `keys`, so each platform" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd)
   * @claim "Kbd takes `keys`, so each platform" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > puts other modifiers in Win, Ctrl, Alt, Shift order, before the key)
   */
  children?: { 'Use <Kbd keys={["mod", "k"]} />': never };
  /** Not a prop. Ouro UI uses `keys`, an array: `<Kbd keys={["mod", "k"]} />`. */
  shortcut?: { 'Use <Kbd keys={["mod", "k"]} />': never };
}

/** Props for {@link Kbd}: its own props and the `<kbd>` attributes it passes through. */
export type KbdProps = Omit<HTMLAttributes<HTMLElement>, keyof KbdOwnProps> & KbdOwnProps;

type Platform = "apple" | "windows" | "other" | "unknown";

/**
 * Each named key as `[Apple glyph, Apple name, other label, other name]`. A name is
 * given where the visible label is a symbol, for screen readers.
 * @claim "Each named key as `[Apple glyph" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > names Apple glyphs for screen readers)
 * @claim "Each named key as `[Apple glyph" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > puts Apple modifiers in Apple's order, Control, Option, Shift, Command, before the key)
 * @claim "Each named key as `[Apple glyph" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > puts other modifiers in Win, Ctrl, Alt, Shift order, before the key)
 */
const named: Readonly<Record<string, readonly [string, string, string, string?]>> = {
  mod: ["⌘", "Command", "Ctrl"],
  cmd: ["⌘", "Command", "Win"],
  ctrl: ["⌃", "Control", "Ctrl"],
  alt: ["⌥", "Option", "Alt"],
  shift: ["⇧", "Shift", "Shift"],
  enter: ["↩", "Return", "Enter"],
  escape: ["Esc", "", "Esc"],
  tab: ["⇥", "Tab", "Tab"],
  backspace: ["⌫", "Delete", "Backspace"],
  delete: ["⌦", "Forward delete", "Del"],
  space: ["Space", "", "Space"],
  up: ["↑", "Up arrow", "↑", "Up arrow"],
  down: ["↓", "Down arrow", "↓", "Down arrow"],
  left: ["←", "Left arrow", "←", "Left arrow"],
  right: ["→", "Right arrow", "→", "Right arrow"],
};

const aliases: Readonly<Record<string, string>> = {
  meta: "cmd",
  command: "cmd",
  control: "ctrl",
  option: "alt",
  return: "enter",
  esc: "escape",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

/**
 * `apple` on macOS, iOS and iPadOS, `windows` on Windows (the only platform with a key
 * labeled Win), and `other` on Linux, ChromeOS and the rest, from the platform string of
 * the modern API when the browser has it.
 */
function detectPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = nav.userAgentData?.platform ?? nav.platform;
  if (/mac|iphone|ipad|ipod|ios/i.test(name)) return "apple";
  return /^win/i.test(name) ? "windows" : "other";
}

/**
 * Where each modifier goes, so a shortcut reads as the platform writes it: Apple's menus
 * use Control, Option, Shift, Command (⌃⌥⇧⌘); elsewhere it is Win, Ctrl, Alt, Shift. Other
 * keys follow the modifiers in the order given.
 * @claim "Where each modifier goes, so a" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > puts Apple modifiers in Apple's order, Control, Option, Shift, Command, before the key)
 * @claim "Where each modifier goes, so a" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > puts other modifiers in Win, Ctrl, Alt, Shift order, before the key)
 */
const appleOrder: Readonly<Record<string, number>> = { ctrl: 0, alt: 1, shift: 2, mod: 3, cmd: 3 };
const otherOrder: Readonly<Record<string, number>> = { cmd: 0, mod: 1, ctrl: 1, alt: 2, shift: 3 };

/** The canonical name of a key: an alias such as `option` becomes `alt`. */
function keyId(key: string): string {
  const lower = key.toLowerCase();
  return Object.hasOwn(aliases, lower) ? aliases[lower]! : lower;
}

const subscribe = () => () => {};
// The server can't know the platform, so it and the hydrating client render the
// "unknown" form (the key names, as elsewhere); React then re-renders with the real
// platform after hydration, without a mismatch.
const serverPlatform = (): Platform => "unknown";

/**
 * A one-character key that is also an emoji, such as ↩, followed by U+FE0E so it draws as text in
 * the key's colour, never as a colour emoji (macOS draws ↩ as one).
 * @claim "A one-character key that is also" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > draws a key that is also an emoji as text)
 */
function asText(text: string): string {
  return /^(?!\p{ASCII})\p{Emoji}$/u.test(text) ? `${text}\uFE0E` : text;
}

/** One key: its visible label, and a screen-reader name when the label is a symbol. */
function label(key: string, platform: Platform): { text: string; name: string | undefined } {
  const id = keyId(key);
  // Only Windows has a Win key; on Linux and ChromeOS the app's command key is Ctrl.
  if (id === "cmd" && platform !== "apple") return { text: platform === "windows" ? "Win" : "Ctrl", name: undefined };
  if (!Object.hasOwn(named, id)) return { text: asText(key.length === 1 ? key.toUpperCase() : key), name: undefined };
  const [glyph, glyphName, text, textName] = named[id]!;
  return platform === "apple" ? { text: asText(glyph), name: glyphName || undefined } : { text, name: textName };
}

/**
 * A keyboard shortcut, in the reader's platform's notation: `keys={["mod", "k"]}` shows
 * ⌘K on a Mac, iPhone or iPad and Ctrl+K elsewhere. Symbols carry their spoken name for
 * screen readers, and draw as text even where they are also emoji (↩). It sizes itself to the surrounding text, so it fits in a Menu item, a
 * Tooltip or a sentence.
 *
 * The server can't know the platform, so server HTML shows the key names (Ctrl+K) and
 * Apple devices switch to the glyphs after hydration.
 *
 * Use plain `Text` instead for a key named in prose that isn't a shortcut to press.
 *
 * @group Text
 * @see https://ui.ouroboros.bot/docs/kbd
 * @claim "and draw as text even where" registry/ouro/components/ouro/kbd/kbd.test.tsx verify:testExists(registry/ouro/components/ouro/kbd/kbd.test.tsx::Kbd > draws a key that is also an emoji as text)
 *
 * @example
 * <Kbd keys={["mod", "k"]} />
 * <Text>Press <Kbd keys={["shift", "enter"]} /> for a new line.</Text>
 */
export function Kbd(props: KbdProps): JSX.Element {
  const {
    keys: keysProp,
    className,
    // Guard props (hint types), dropped here so they never reach the DOM.
    children,
    shortcut,
    ...rest
  } = props;
  const platform = useSyncExternalStore(subscribe, detectPlatform, serverPlatform);
  // A string of keys (a type error) is split on "+", as the agent meant it.
  const keys: readonly string[] = typeof keysProp === "string" ? keysProp.split("+") : (keysProp ?? []);
  useAppearanceClassNameCheck(
    "Kbd",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) =>
          /^text-(xs|sm|base|lg|xl|\dxl)$/.test(token)
            ? `remove "${token}"; Kbd sizes itself to the surrounding text`
            : `remove "${token}"; Kbd matches the theme`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Kbd",
    process.env.NODE_ENV !== "production"
      ? () => [
          typeof keysProp === "string" && [`keys="${keysProp}" is a string; keys takes an array`, '<Kbd keys={["mod", "k"]} />'],
          children !== undefined && ["Kbd takes keys, not children", '<Kbd keys={["mod", "k"]} />'],
          Array.isArray(keysProp) && keysProp.length === 0 && ["keys is empty", '<Kbd keys={["mod", "k"]} />'],
          shortcut !== undefined && ["shortcut is not a prop", '<Kbd keys={["mod", "k"]} />'],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const apple = platform === "apple";
  const order = apple ? appleOrder : otherOrder;
  const rank = (key: string) => order[keyId(key)] ?? 4;
  const ordered = [...keys].sort((a, b) => rank(a) - rank(b));
  return (
    <kbd
      {...rest}
      data-ouro="kbd"
      data-platform={apple ? "apple" : platform === "unknown" ? "unknown" : "other"}
      className={cn(
        "box-border inline-flex h-[1.6em] min-w-[1.6em] items-center justify-center gap-[0.15em] align-[0.1em] " +
          "rounded-sm border border-solid border-border bg-muted px-[0.35em] [font-family:inherit] text-[0.85em]/none font-medium " +
          "text-foreground whitespace-nowrap select-none",
        className,
      )}
    >
      {ordered.map((key, index) => {
        const { text, name } = label(key, platform);
        return (
          <Fragment key={index}>
            {!apple && index > 0 && "+"}
            <kbd className="m-0 [font:inherit]">
              {name ? (
                <>
                  <span aria-hidden="true" data-glyph="">
                    {text}
                  </span>
                  <span className="sr-only">{name}</span>
                </>
              ) : (
                text
              )}
            </kbd>
          </Fragment>
        );
      })}
    </kbd>
  );
}
