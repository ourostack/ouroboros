import type { EmojiCatalogue, EmojiItem, EmojiItemTone } from "@/components/ouro/emoji/emoji";
import { devWarn } from "@/lib/ouro/dev";

export {
  catalogueIndex,
  emojiClass,
  emojiPictureClass,
  emojiPictureFadeClass,
  emojiPlaceholderClass,
  emojiPlaceholderFadeClass,
  emojiSkinTones,
  emojiToken,
  emojiTextToTokens,
  fold,
  matchWords,
  searchCatalogue,
  splitEmojiText,
  toneOf,
};
export type { CatalogueIndex, EmojiSkinTone, EmojiTextPart, FoundEmoji };

// Value lists and helpers for Emoji and the components that draw a catalogue's emoji, apart from
// the component so its file exports only components (React Fast Refresh). Class strings are
// literal so the app's Tailwind finds them.

/**
 * A skin tone: the default (no tone) or one of Unicode's five, light to dark.
 *
 * @claim "one of Unicode's five" https://www.unicode.org/reports/tr51/#Diversity verify:urlOk(https://www.unicode.org/reports/tr51/#Diversity)
 * @claim "one of Unicode's five" registry/ouro/components/ouro/emoji/emoji-styles.ts verify:fileLine(registry/ouro/components/ouro/emoji/emoji-styles.ts, /\["default", "light", "medium-light", "medium", "medium-dark", "dark"\]/)
 */
type EmojiSkinTone = "default" | "light" | "medium-light" | "medium" | "medium-dark" | "dark";

/** The skin tones, in the order a picker offers them. @internal */
const emojiSkinTones: readonly EmojiSkinTone[] = ["default", "light", "medium-light", "medium", "medium-dark", "dark"];

/**
 * An emoji's image: 1.25em square, so it takes the size of the text around it as a font's
 * emoji does, sitting on the line. It clips what it holds, so a picture that fails to load, which
 * the browser draws as its name in the box, sits on the line where the picture would and moves no
 * line. @internal
 *
 * @claim "image: 1.25em square, so" registry/ouro/components/ouro/emoji/emoji-styles.ts verify:fileLine(registry/ouro/components/ouro/emoji/emoji-styles.ts, /"inline-block size-\[1\.25em\]/)
 * @claim "sits on the line where the picture would and moves no line" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::EmojiText > keeps every line and every emoji where a loaded picture would, when its picture fails to load)
 */
const emojiClass = "inline-block size-[1.25em] shrink-0 overflow-hidden align-[-0.3em] object-contain select-none";

/**
 * An emoji's picture over its placeholder: the box of the emoji around it, hidden until the
 * root is marked `data-loaded`. @internal
 */
const emojiPictureClass = "absolute inset-0 size-full object-contain opacity-0 group-data-loaded/emoji:opacity-100";

/** The picture's fade in over the short duration, once loaded only, left off when motion is reduced (`useReducedMotion`). @internal */
const emojiPictureFadeClass =
  "group-data-loaded/emoji:transition-opacity group-data-loaded/emoji:duration-(--ouro-duration-fast) group-data-loaded/emoji:ease-(--ouro-ease-out)";

/** What stands in for the picture: the emoji's box, with an element centred and clipped to it, hidden once the picture is loaded. @internal */
const emojiPlaceholderClass =
  "pointer-events-none absolute inset-0 grid size-full place-items-center overflow-hidden group-data-loaded/emoji:invisible group-data-loaded/emoji:opacity-0";

/** The placeholder's fade out with the picture's fade in, left off when motion is reduced. @internal */
const emojiPlaceholderFadeClass =
  "group-data-loaded/emoji:transition-[opacity,visibility] group-data-loaded/emoji:duration-(--ouro-duration-fast) group-data-loaded/emoji:ease-(--ouro-ease-out)";

/** The emoji's form in a skin tone: its toned image, or the emoji itself in the default tone or without tones. @internal */
function toneOf(item: EmojiItem, tone: EmojiSkinTone | undefined): EmojiItem | EmojiItemTone {
  // The default tone, or one that is no tone, is the emoji itself.
  return item.skinTones?.[emojiSkinTones.indexOf(tone!) - 1] ?? item;
}

/**
 * The text that stands for an emoji in a message, `:shortcode:`: its first shortcode, or else
 * its id, and in a skin tone its tone's id. `EmojiText` draws it as the image. @internal
 *
 * @claim "its first shortcode, or else its id" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::EmojiText > draws shortcode, id and tone id tokens as their images, and leaves unknown ones as text)
 */
function emojiToken(item: EmojiItem, tone?: EmojiSkinTone): string {
  const form = toneOf(item, tone);
  return `:${form === item ? (item.shortcodes?.[0] ?? item.id) : form.id}:`;
}

/** An emoji found in a catalogue, and the skin tone its id or text named. */
interface FoundEmoji {
  item: EmojiItem;
  tone: EmojiSkinTone;
}

/** Finds an emoji by a key: an id, a token's name or an emoji's text. */
interface EmojiLookup {
  get(key: string): FoundEmoji | undefined;
  has(key: string): boolean;
}

/** A catalogue's emoji by id, by token and by text, built once per catalogue. */
interface CatalogueIndex {
  /**
   * The catalogue's emoji in order, each id once.
   *
  
 * @claim "each id once" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > indexes a catalogue once, each emoji once, by id, tone id, token and text)
   */
  items: readonly EmojiItem[];
  /** An emoji by its id or a tone's id. */
  byId: EmojiLookup;
  /** An emoji by what goes between the colons of a token: a shortcode (in lower case), an id or a tone's id. */
  byToken: EmojiLookup;
  /** An emoji by its text, without variation selectors. */
  byText: EmojiLookup;
  /**
   * The first character of each emoji text the catalogue lists: text with none of them (and no colon) holds no emoji.
   * Each leads to the texts that start with it, longest first, each as its characters.
   *
  
 * @claim "Each leads to the texts that start with it" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > splits text as one pattern of every token and emoji text did, for any text)
 * @claim "The first character of each emoji text the catalogue lists: text with none of them (and no colon) holds no emoji." registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > passes text with no colon and no emoji text's first character straight through, and still finds a plain-text emoji)
   */
  textStarts: TextStarts;
}

/**
 * Each first character of the catalogue's emoji texts, with the texts it starts, longest first, each as its characters.
 * @claim "Each first character of the catalogue's emoji texts" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > splits text as one pattern of every token and emoji text did, for any text)
 */
type TextStarts = ReadonlyMap<string, readonly (readonly string[])[]>;

const indexes = new WeakMap<EmojiCatalogue, CatalogueIndex>();
const VARIATION = /\uFE0F/g;

/** A list of objects, kept with the index it leads to. */
interface IndexPath {
  steps: readonly object[];
  index?: CatalogueIndex;
}

/**
 * The lists indexed lately, by their first object, held weakly: at most `PATHS` for each first
 * object, the one indexed longest ago let go first.
 *
 * @claim "the one indexed longest ago let go first" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > keeps the lists of the 8 catalogues indexed most recently that start with the same emoji)
 */
const paths = new WeakMap<object, IndexPath[]>();
const PATHS = 8;
// Stryker disable next-line ObjectLiteral,ArrayDeclaration: the empty list's path is returned for having no first object; nothing reads its steps
const noSteps: IndexPath = { steps: [] };

/**
 * Where a sequence of objects leads: the same objects in the same order lead to the same place.
 * One weak lookup, by the first object, then a comparison of the rest: a weak lookup per object
 * would chain one WeakMap per emoji, which a garbage collector that marks WeakMaps a level at a
 * time (WebKit's) walks once per level, in every collection, for as long as the emoji live (a
 * collection held the main thread for hundreds of milliseconds with a few thousand emoji).
 *
 * @claim "the same objects in the same order lead to the same place" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > shares one index between fresh catalogue objects holding the same emoji)
 * @claim "One weak lookup, by the first object" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > makes no WeakMap per emoji, however many the catalogue holds)
 */
function pathOf(steps: readonly object[]): IndexPath {
  const [first] = steps;
  if (first === undefined) return noSteps;
  let known = paths.get(first);
  if (!known) paths.set(first, (known = []));
  const found = known.find((path) => path.steps.length === steps.length && path.steps.every((step, at) => step === steps[at]));
  if (found) return found;
  const path: IndexPath = { steps: [...steps] };
  known.push(path);
  if (known.length > PATHS) known.shift();
  return path;
}

/**
 * The indexes of catalogues an app named with an `id`, at most `NAMED` of them, the one used
 * longest ago let go first.
 *
 * @claim "the one used longest ago let go first" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > keeps the ids used most recently, letting go of the one used longest ago)
 */
const named = new Map<string, CatalogueIndex>();
const NAMED = 16;

/** The builds of the last `REBUILD_SPAN` milliseconds, oldest first: when, and a hash of their emoji's ids. In development only. */
const builds: { at: number; emoji: number }[] = [];
const REBUILD_SPAN = 1000;
const REBUILD_LIMIT = 3;

/** A short hash of text, so a build's record holds a number rather than its emoji's ids. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193);
  return hash;
}

/**
 * Warns once, in development, when the index of the same emoji is built more than
 * `REBUILD_LIMIT` times within a second, as when an app makes its catalogue's emoji afresh for
 * each message. Catalogues of different emoji, such as a page of examples, never count together.
 *
 * @claim "the same emoji is built more than `REBUILD_LIMIT` times within a second" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > warns once in development when the same emoji are indexed more than three times within a second)
 * @claim "Catalogues of different emoji, such as a page of examples, never count together" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > stays quiet for many different catalogues, and for equivalent fresh ones however often an app makes them)
 */
function noteBuild(items: readonly EmojiItem[]): void {
  const now = Date.now();
  const emoji = hashOf(items.map((item) => item.id).join());
  builds.push({ at: now, emoji });
  // Only the last second's builds are kept, so the record stays as small as the builds in it.
  while (builds[0]!.at <= now - REBUILD_SPAN) builds.shift();
  /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
  if (process.env.NODE_ENV !== "production") {
    if (builds.filter((build) => build.emoji === emoji).length > REBUILD_LIMIT) {
      devWarn(
        "EmojiCatalogue",
        `the index of the same emoji was built more than ${REBUILD_LIMIT} times within a second, each time for a catalogue of new emoji objects. Each build maps every emoji and lists their texts when they changed, so drawing a conversation this way can take seconds`,
        "build the catalogue once and pass that object every time (useMemo(() => toCatalogue(emoji), [emoji])), or give every copy the same id that changes only when the emoji do: { id: \"contoso-2026-11\", categories }",
      );
    }
  }
}

/**
 * The catalogue's index, built on first use and kept while the catalogue's emoji live. A fresh
 * catalogue object with the same emoji shares it: one with the same `id`, or else one holding
 * the same emoji objects in the same order, found with a lookup per emoji, so an array the app
 * changed in place counts as new. An emoji object edited in place (its shortcodes or text)
 * keeps the index it had, so an app that edits emoji that way passes a new `id` or new emoji
 * objects. A catalogue whose emoji differ only in their pictures (new `src` addresses) shares the
 * lookups of their ids, tokens and text, building nothing again, and finds its own pictures. @internal
 *
 * @claim "A catalogue whose emoji differ only" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > compiles nothing again for a catalogue whose emoji differ only in their pictures' addresses, and finds the new pictures)
 *
 * @claim "A fresh catalogue object with the same emoji shares it" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > shares one index between fresh catalogue objects holding the same emoji)
 * @claim "an array the app changed in place counts as new" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > finds an emoji the app pushed into the same array, in a fresh catalogue)
 */
function catalogueIndex(catalogue: EmojiCatalogue): CatalogueIndex {
  const known = indexes.get(catalogue);
  if (known) return known;
  const { id } = catalogue;
  const index = named.get(id!) ?? (pathOf(catalogue.categories.flatMap((category) => category.items)).index ??= buildCatalogueIndex(catalogue));
  if (id !== undefined) {
    // Most recently used last, so the first is the one to let go.
    named.delete(id);
    named.set(id, index);
    if (named.size > NAMED) named.delete(named.keys().next().value!);
  }
  indexes.set(catalogue, index);
  return index;
}

/**
 * What a catalogue's index holds that depends only on its emoji's ids, texts and shortcodes, not on their pictures: where
 * each id, token and text leads (an emoji's place in the catalogue, times 8, plus its tone's), and the texts each first
 * character starts. Shared by every catalogue whose emoji say the same, so a catalogue that changes only its pictures'
 * addresses (a new `src` for each, as a CDN's signed addresses do) builds nothing again.
 * @claim "What a catalogue's index holds that" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > compiles nothing again for a catalogue whose emoji differ only in their pictures' addresses, and finds the new pictures)
 * @claim "Shared by every catalogue whose emoji" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > compiles nothing again for a catalogue whose emoji differ only in their pictures' addresses, and finds the new pictures)
 */
interface IndexShape {
  byId: ReadonlyMap<string, number>;
  byToken: ReadonlyMap<string, number>;
  byText: ReadonlyMap<string, number>;
  textStarts: TextStarts;
}

/**
 * The shapes of the catalogues indexed most recently, by what their emoji say, at most `SHAPES` of them.
 * @claim "The shapes of the catalogues indexed" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > keeps the shapes of the 8 catalogues indexed most recently, and compiles again for one indexed before them)
 */
const shapes = new Map<string, IndexShape>();
const SHAPES = 8;

/**
 * What a catalogue's emoji say, each id, text and shortcode in order: the same for catalogues whose emoji differ only in their pictures.
 * @claim "What a catalogue's emoji say, each" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > compiles nothing again for a catalogue whose emoji differ only in their pictures' addresses, and finds the new pictures)
 */
function signatureOf(items: readonly EmojiItem[]): string {
  // Stryker disable next-line StringLiteral: the signature only has to be the same for the same emoji, whatever it starts with.
  let signature = "";
  for (const item of items) {
    signature += `\u0001${item.id}\u0002${item.text ?? ""}\u0002${item.shortcodes?.join("\u0003") ?? ""}`;
    for (const form of item.skinTones ?? []) signature += `\u0002${form.id}\u0003${form.text ?? ""}`;
  }
  return signature;
}

/**
 * Compiles the shape of a catalogue's emoji: where each id, token and text leads, and the texts each first character starts.
 * @claim "Compiles the shape of a catalogue's" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > compiles nothing again for a catalogue whose emoji differ only in their pictures' addresses, and finds the new pictures)
 * @claim "Compiles the shape of a catalogue's" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > indexes a catalogue once, each emoji once, by id, tone id, token and text)
 */
function buildShape(items: readonly EmojiItem[]): IndexShape {
  const byId = new Map<string, number>();
  const byToken = new Map<string, number>();
  const byText = new Map<string, number>();
  items.forEach((item, at) => {
    const forms: [{ id: string; text?: string | undefined }, number][] = [[item, 0], ...(item.skinTones ?? []).map((form, tone): [EmojiItemTone, number] => [form, tone + 1])];
    for (const [form, tone] of forms) {
      byId.set(form.id, at * 8 + tone);
      byToken.set(form.id.toLowerCase(), at * 8 + tone);
      if (form.text) byText.set(form.text.replace(VARIATION, ""), at * 8 + tone);
    }
  });
  // Shortcodes win over ids that look the same, so they go in last.
  items.forEach((item, at) => item.shortcodes?.forEach((shortcode) => byToken.set(shortcode.toLowerCase(), at * 8)));
  // Longest first, so a sequence wins over the emoji it starts with.
  const textStarts = new Map<string, string[][]>();
  for (const text of [...byText.keys()].sort((a, b) => b.length - a.length)) {
    const chars = Array.from(text);
    const texts = textStarts.get(chars[0]!);
    if (texts) texts.push(chars);
    else textStarts.set(chars[0]!, [chars]);
  }
  return { byId, byToken, byText, textStarts };
}

/** A shape's places, as the emoji of the catalogue in hand. */
function lookup(places: ReadonlyMap<string, number>, items: readonly EmojiItem[]): EmojiLookup {
  return {
    get: (key) => {
      const at = places.get(key);
      return at === undefined ? undefined : { item: items[at >> 3]!, tone: emojiSkinTones[at & 7]! };
    },
    has: (key) => places.has(key),
  };
}

/**
 * Builds a catalogue's index: its emoji, each id once, with the shape of what they say, compiled only when no catalogue indexed lately said the same.
 * @claim "Builds a catalogue's index: its emoji" registry/ouro/components/ouro/emoji/emoji.index.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.index.test.tsx::catalogueIndex > keeps the shapes of the 8 catalogues indexed most recently, and compiles again for one indexed before them)
 * @claim "Builds a catalogue's index: its emoji" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > indexes a catalogue once, each emoji once, by id, tone id, token and text)
 */
function buildCatalogueIndex(catalogue: EmojiCatalogue): CatalogueIndex {
  const items: EmojiItem[] = [];
  const seen = new Set<string>();
  for (const item of catalogue.categories.flatMap((category) => category.items)) {
    // Stryker disable next-line ConditionalExpression: an emoji listed twice adds nothing the first did not.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
  if (process.env.NODE_ENV !== "production") noteBuild(items);
  const signature = signatureOf(items);
  const shape = shapes.get(signature) ?? buildShape(items);
  // Most recently used last, so the first is the one to let go.
  shapes.delete(signature);
  shapes.set(signature, shape);
  if (shapes.size > SHAPES) shapes.delete(shapes.keys().next().value!);
  return {
    items,
    byId: lookup(shape.byId, items),
    byToken: lookup(shape.byToken, items),
    byText: lookup(shape.byText, items),
    textStarts: shape.textStarts,
  };
}

/** A run of text, or an emoji found in it with the text it was found as. */
type EmojiTextPart = string | (FoundEmoji & { source: string });

/**
 * Splits text into runs of text and the emoji its tokens (`:shortcode:`, `:id:`) and emoji
 * text name in the catalogue, each with the text it was found as. A token the catalogue does not
 * know stays text, and its closing colon can still open the next one. With `tokens` false, only
 * the emoji text counts, for text such as code where `:name:` means something else. @internal
 *
 * @claim "each with the text it was found as" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > splits text into its runs and emoji with no empty runs between or around them)
 * @claim "A token the catalogue does not know stays text" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::EmojiText > draws shortcode, id and tone id tokens as their images, and leaves unknown ones as text)
 */
function splitEmojiText(text: string, catalogue: EmojiCatalogue, tokens = true): EmojiTextPart[] {
  const { byToken, byText, textStarts } = catalogueIndex(catalogue);
  // Most text holds no emoji: one pass over its characters says so.
  if (!Array.from(text).some((char) => (tokens && char === ":") || textStarts.has(char))) return text ? [text] : [];
  const parts: EmojiTextPart[] = [];
  let plainFrom = 0;
  for (let match = nextEmojiText(text, 0, textStarts, tokens); match; match = nextEmojiText(text, match.end, textStarts, tokens)) {
    // A token's closing colon, already taken, does not open another.
    if (match.index < plainFrom) continue;
    const found = match.token ? byToken.get(text.slice(match.index + 1, match.end).toLowerCase()) : byText.get(text.slice(match.index, match.end).replace(VARIATION, ""));
    if (!found) continue;
    if (match.index > plainFrom) parts.push(text.slice(plainFrom, match.index));
    const end = match.end + (match.token ? 1 : 0);
    parts.push({ ...found, source: text.slice(match.index, end) });
    plainFrom = end;
  }
  if (plainFrom < text.length) parts.push(text.slice(plainFrom));
  return parts;
}

const SPACE = /\s/u;

/**
 * The next token or emoji text in `text` from `from`: a token's colon and name up to (not taking) its closing colon, or the
 * longest emoji text the catalogue lists that starts there, with a variation selector allowed after each character. A
 * scan of the text's characters with lookups, never one pattern of every emoji text: Chromium drops a compiled pattern at
 * each full garbage collection, and compiling the thousands of alternatives again took 95-270 ms of the next press that
 * drew an emoji's text, in a consuming app with a catalogue of thousands. @internal
 *
 * @claim "The next token or emoji text in `text` from `from`" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > splits text as one pattern of every token and emoji text did, for any text)
 * @claim "never one pattern of every emoji text" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > splits text as one pattern of every token and emoji text did, for any text)
 */
function nextEmojiText(text: string, from: number, textStarts: TextStarts, tokens: boolean): { index: number; end: number; token: boolean } | null {
  for (let at = from; at < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(at)!);
    if (tokens && char === ":") {
      let end = at + 1;
      while (end < text.length) {
        const next = String.fromCodePoint(text.codePointAt(end)!);
        if (next === ":" || SPACE.test(next)) break;
        end += next.length;
      }
      if (end > at + 1 && text[end] === ":") return { index: at, end, token: true };
    }
    const texts = textStarts.get(char);
    if (texts) {
      for (const chars of texts) {
        let end = at;
        for (const c of chars) {
          if (!text.startsWith(c, end)) {
            end = -1;
            break;
          }
          end += c.length;
          if (text[end] === "\uFE0F") end += 1;
        }
        if (end !== -1) return { index: at, end, token: false };
      }
    }
    at += char.length;
  }
  return null;
}

/** Lower case, without accents, so "Café" matches "cafe". @internal */
function fold(text: string): string {
  // Stryker disable next-line MethodExpression: both sides of every comparison fold the same way, so upper case matches as lower case does.
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Whether every word typed starts one of `words`, or a part of one split at spaces, hyphens,
 * underscores and colons, ignoring case and accents. Colons around a typed shortcode are
 * dropped, so `:party` finds `party_popper`. @internal
 *
 * @claim "Whether every word typed starts" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > matches every typed word to the start of a word, a part of one, or a whole one, ignoring case, accents and colons)
 */
function matchWords(words: readonly string[], query: string): boolean {
  const whole = words.map(fold);
  // Runs of separators leave empty words and terms, which match nothing and everything, so they change no result.
  const parts = whole.flatMap((word) => word.split(/[\s_:-]/));
  return fold(query)
    .split(/\s/)
    .map((term) => term.replace(/^:+|:+$/g, ""))
    .every((term) => parts.some((word) => word.startsWith(term)) || whole.some((word) => word.startsWith(term)));
}

/**
 * The catalogue's emoji whose name, shortcodes or keywords the query starts, those with a
 * shortcode that starts with it first, at most `limit`. @internal
 */
function searchCatalogue(catalogue: EmojiCatalogue, query: string, limit: number): EmojiItem[] {
  const { items } = catalogueIndex(catalogue);
  const typed = fold(query);
  const byShortcode = items.filter((item) => item.shortcodes?.some((shortcode) => fold(shortcode).startsWith(typed)));
  const rest = items.filter((item) => !byShortcode.includes(item) && matchWords([item.name, ...(item.shortcodes ?? []), ...(item.keywords ?? [])], query));
  return [...byShortcode, ...rest].slice(0, limit);
}

/** Splits text into the characters a person sees, an emoji with its tone modifier or its joined parts whole. */
// Stryker disable next-line ObjectLiteral: grapheme is Intl.Segmenter's default granularity, named here for the reader.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The text with the emoji the catalogue lists as text turned into their tokens: `:shortcode:`,
 * or a tone's `:id:`. It reads the text a whole character at a time, so an emoji joined from
 * others (a zero width joiner sequence) or one with a skin tone modifier changes only when the
 * catalogue lists it whole. Any other character, and an emoji the catalogue does not list,
 * stays as it is. @internal
 *
 * @claim "changes only when the catalogue lists it whole" registry/ouro/components/ouro/emoji/emoji.test.tsx verify:testExists(registry/ouro/components/ouro/emoji/emoji.test.tsx::Emoji helpers > turns each emoji the catalogue lists as text into its token, a whole character at a time)
 */
function emojiTextToTokens(text: string, catalogue: EmojiCatalogue): string {
  const { byText } = catalogueIndex(catalogue);
  let tokens = "";
  for (const { segment } of graphemes.segment(text)) {
    const found = byText.get(segment.replace(VARIATION, ""));
    tokens += found ? emojiToken(found.item, found.tone) : segment;
  }
  return tokens;
}
