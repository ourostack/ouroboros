export { findDesignIssues, listCornerMedia, mediaDrawn, readCorners, shownCorners };
export type { CornerMedia, CornerReading, DesignOptions };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside its function. Design rules that
// measurement decides, after Refactoring UI (Wathan and Schoger) and the craft findings they came from:
//
//   giant-picture      a banner-shaped picture (scenery, 1.8 times as wide as tall or wider), in the flow, leads a
//                      content item (a card or entry with its own heading, not a figure, whose picture is its subject)
//                      and outweighs the words it introduces: it fills the item's width, is over `pictureShare` of the
//                      item's height, and over `pictureRatio` times the height of everything else in it
//   cramped-heading    a heading sits closer to a picture or a filled or framed box above it than half its own font
//                      size (a quarter, for its own item's picture, as a card's title under the card's picture): no room
//                      to breathe between a title and the art before it. What follows a heading belongs to it, so the
//                      space below isn't judged
//   nested-frame       a frame drawn inside a frame: a framed box hugging another within a few pixels on every side (a
//                      double border), or a rounded, filled or framed box whose child, with an edge of its own (a fill,
//                      a frame, or a picture that runs to its corner, not an icon or a clear logo), sits in its corner
//                      (under half the radius in) with a radius that isn't the outer radius less the inset, so the
//                      corners don't nest
//   baked-corner       (readCorners) a picture or video whose own pixels draw a corner of another colour, such as a
//                      screen recording of a window with its dark corner, inside the page's frame
//   type-scale         more text sizes, or more font weights in running text or in headings, than a type scale holds
//   giant-text         the size most of the page's running text is drawn at (by characters, outside headings) is over
//                      `readingPx`, as when an app grows its root type with the screen: on a 4K display at 1x the words
//                      read larger than they would at arm's length on a laptop. Emoji are pictures, not words: an
//                      emoji picker's grid, drawn large on purpose, is no running text
//   shadow-scale       more distinct shadows than an elevation scale holds
//   grey-on-colour     grey text on a coloured background, which reads washed out: use a shade of the background's hue
//   heading-hierarchy  a heading drawn larger than the heading it sits under, each at the largest size its text is drawn
//                      at (a title's span may set it)
//
// An element opts out of a rule with data-ouro-allow="<rule ids>" and a reason in data-ouro-allow-why, as the other rules
// do. `element` names the element the same way at every size; `detail` has this size's numbers.

interface DesignOptions {
  /** A content item's picture is giant over this share of the item's height… */
  pictureShare?: number;
  /** …and this many times the height of the rest of the item… */
  pictureRatio?: number;
  /** …and at least this tall, in CSS pixels. */
  pictureMin?: number;
  /** A heading needs this share of its font size clear above and below it. */
  headingRoom?: number;
  /** The gap, in pixels, under which a frame inside a frame reads as a double border. */
  hugPx?: number;
  /** The limit on a page's text sizes and font weights. */
  maxSizes?: number;
  maxWeights?: number;
  /** The limit on a page's distinct shadows. */
  maxShadows?: number;
  /** The cap, in CSS pixels, on the page's reading size: the size that carries its running text. */
  readingPx?: number;
}

interface CornerMedia {
  ref: string;
  element: string;
  box: { x: number; y: number; width: number; height: number };
  radius: number;
  /** The colour behind the media's frame, which shows outside its rounded corners. */
  behind: number[];
  /** The colours the frame and the media draw at their edges themselves: borders and outlines, which a corner may show. */
  own: number[][];
}

interface CornerReading {
  ref: string;
  element: string;
  /** The picture of the media as drawn, a data: URL of a PNG at CSS pixels. */
  shot: string;
  radius: number;
  behind: number[];
  own: number[][];
  /** The corners the screen shows: on the screen, and not under another element (a fixed bar, say). */
  corners: string[];
}

function findDesignIssues({ pictureShare = 0.55, pictureRatio = 1.25, pictureMin = 240, headingRoom = 0.5, hugPx = 6, maxSizes = 10, maxWeights = 3, maxShadows = 5, readingPx = 24 }: DesignOptions = {}): PageIssue[] {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `d${counter.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${id}`.trim());
    return id;
  };
  const optedOut = (el: Element, rule: string) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = (n.getAttribute("data-ouro-allow") ?? "").split(/\s+/);
      if ((rules.includes(rule) || rules.includes("all")) && (n.getAttribute("data-ouro-allow-why") ?? "").trim()) return true;
    }
    return false;
  };
  const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}`;
  const words = (el: Element) => (el.getAttribute("aria-label") || el.getAttribute("alt") || el.textContent || "").trim().replace(/\s+/g, " ");
  const quoted = (el: Element) => {
    const w = words(el);
    return w ? ` "${w.slice(0, 40)}${w.length > 40 ? "…" : ""}"` : "";
  };
  // The part of a box that is drawn: its rect cut by each ancestor that clips it (overflow other than visible, or paint
  // containment) to that ancestor's padding box, following containing blocks, so an absolutely positioned box escapes
  // ancestors below its positioned one and a fixed box escapes them all. null when nothing of it is drawn.
  const drawnRect = (el: Element): DOMRect | null => {
    const box = el.getBoundingClientRect();
    let [left, top, right, bottom] = [box.left, box.top, box.right, box.bottom];
    const own = getComputedStyle(el).position;
    let escaping = own === "absolute";
    if (own !== "fixed") {
      for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n);
        const positioned = s.position !== "static";
        // Overflow doesn't apply to inline boxes or display: contents, and body's goes to the viewport when html's is visible.
        const clips = !/^(inline|contents)$/.test(s.display) && !(n === document.body && getComputedStyle(document.documentElement).overflow === "visible");
        if (clips && (!escaping || positioned)) {
          const c = n.getBoundingClientRect();
          const [x, y] = [c.left + n.clientLeft, c.top + n.clientTop];
          const paint = /paint|strict|content/.test(s.contain);
          if (paint || s.overflowX !== "visible") [left, right] = [Math.max(left, x), Math.min(right, x + n.clientWidth)];
          if (paint || s.overflowY !== "visible") [top, bottom] = [Math.max(top, y), Math.min(bottom, y + n.clientHeight)];
        }
        if (positioned) escaping = s.position === "absolute";
        if (s.position === "fixed") break;
      }
    }
    return new DOMRect(left, top, right - left, bottom - top);
  };
  const shown = (el: Element) => {
    if (el.closest("[hidden], template, .visually-hidden, .sr-only")) return false;
    // A closed details draws only its summary, though its other children keep the boxes they would have.
    if (el.closest("details:not([open]) > :not(summary)")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) <= 0.05) return false;
    }
    return drawnRect(el) !== null;
  };
  const px = (value: string) => parseFloat(value) || 0;
  const all = [...document.body.querySelectorAll("*")].filter((el) => !el.closest("svg, script, style, template, head") || el.tagName === "svg");
  const visible = all.filter(shown);
  const hasText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());

  // Colours as the browser resolves them, through a canvas, so every syntax (color-mix, oklch, a keyword) reads alike.
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const colours = new Map<string, [number, number, number, number]>();
  const rgba = (colour: string): [number, number, number, number] => {
    const known = colours.get(colour);
    if (known) return known;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    const read: [number, number, number, number] = [r!, g!, b!, a! / 255];
    colours.set(colour, read);
    return read;
  };
  // Hue-free saturation and lightness (HSL's), from 0 to 1.
  const hsl = ([r, g, b]: number[]) => {
    const [max, min] = [Math.max(r!, g!, b!) / 255, Math.min(r!, g!, b!) / 255];
    const l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    return { s, l };
  };
  // The colour behind an element: the first ancestor's own fill, or null over a picture or a gradient, which no one
  // colour stands for.
  const backgroundOf = (el: Element): [number, number, number, number] | null => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== "none") return null;
      const fill = rgba(s.backgroundColor);
      if (fill[3] >= 0.5) return fill;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches && /dark/.test(getComputedStyle(document.documentElement).colorScheme) ? [18, 18, 18, 1] : [255, 255, 255, 1];
  };
  const pictureLike = (el: Element) => el.matches("img, video, canvas, picture, svg, [role=img]") || (getComputedStyle(el).backgroundImage.includes("url(") && !el.textContent!.trim());
  // A page behind a gradient or a picture has no one colour to differ from, so no fill is judged against it.
  const fillDiffers = (el: Element) => {
    const page = backgroundOf(document.body);
    if (!page) return false;
    const fill = rgba(getComputedStyle(el).backgroundColor);
    return fill[3] >= 0.5 && Math.abs(fill[0] - page[0]) + Math.abs(fill[1] - page[1]) + Math.abs(fill[2] - page[2]) > 12;
  };
  const filled = (el: Element) => pictureLike(el) || fillDiffers(el) || frameOf(el) !== null;
  // Whether a picture's top-left pixel is opaque. A picture from another site can't be read, so only a JPEG, which
  // has no clear pixels, counts.
  const opaqueCorner = (img: HTMLImageElement) => {
    if (!img.complete || !img.naturalWidth) return false;
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [1, 1];
    const pen = canvas.getContext("2d")!;
    pen.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
    try {
      return pen.getImageData(0, 0, 1, 1).data[3]! >= 128;
    } catch {
      return /\.jpe?g(?:[?#]|$)/i.test(img.currentSrc);
    }
  };
  // A box with an edge of its own: a fill or a frame, or a picture that runs to its corner (a video, a canvas, a
  // background photo, or a picture with an opaque corner that fills its box). A drawing (an svg, an icon) or a logo
  // with clear corners has no corner to nest.
  const edged = (el: Element) => {
    if (fillDiffers(el) || frameOf(el) !== null) return true;
    const media = el.matches("picture") ? el.querySelector("img") : el;
    if (media instanceof HTMLVideoElement || media instanceof HTMLCanvasElement) return true;
    if (media instanceof HTMLImageElement) return !/contain|scale-down|none/.test(getComputedStyle(media).objectFit) && opaqueCorner(media);
    const art = /url\(\s*["']?([^"')]*)/.exec(getComputedStyle(el).backgroundImage);
    return art !== null && !el.textContent!.trim() && !/\.svg(?:[?#]|$)|^data:image\/svg/i.test(art[1]!);
  };
  // A box's frame: a border on every side, an outline, or a ring (a shadow with a spread and no blur). The width it draws.
  const frameOf = (el: Element): number | null => {
    const s = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"] as const;
    const border = sides.every((side) => s[`border${side}Style`] !== "none" && px(s[`border${side}Width`]) >= 1 && rgba(s[`border${side}Color`])[3] >= 0.2);
    if (border) return px(s.borderTopWidth);
    if (s.outlineStyle !== "none" && px(s.outlineWidth) >= 1 && rgba(s.outlineColor)[3] >= 0.2) return px(s.outlineWidth);
    const ring = /(?:^|,)\s*(?:[a-z]+\([^)]*\)\s+)?0px 0px 0px ([1-9][\d.]*)px/.exec(s.boxShadow);
    return ring ? px(ring[1]!) : null;
  };
  const headingLevel = (el: Element) => (/^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : el.getAttribute("role") === "heading" ? Number(el.getAttribute("aria-level") ?? 2) : 0);
  const headings = visible.filter((el) => headingLevel(el) > 0);

  // giant-picture: a picture that leads a content item and outweighs its words. A page's own banner (in a header, or
  // above an h1) is a hero, not an item, and is left alone.
  for (const pic of visible.filter((el) => el.matches("img, video, canvas, svg, [role=img]") || (getComputedStyle(el).backgroundImage.includes("url(") && !el.textContent!.trim()))) {
    // A picture out of the flow is a layer drawn under or over its item (a backdrop, a map's lines), not one leading it.
    if (pic.closest("header, [role=banner], button, a[href] > *:only-child") || pic.parentElement?.closest("svg") || /absolute|fixed/.test(getComputedStyle(pic).position) || optedOut(pic, "giant-picture")) continue;
    const p = pic.getBoundingClientRect();
    if (p.height < pictureMin) continue;
    let item: Element | null = pic.parentElement;
    while (item && item !== document.body && !item.matches("main") && !headings.some((h) => item!.contains(h) && !h.contains(pic))) item = item.parentElement;
    // A figure's picture is its subject (a comic panel, a chart), however large; its caption describes it.
    if (!item || item === document.body || item.matches("main, figure")) continue;
    const titles = headings.filter((h) => item!.contains(h));
    const title = titles.find((h) => pic.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!title || titles.some((h) => headingLevel(h) === 1)) continue;
    const box = item.getBoundingClientRect();
    const rest = box.height - p.height;
    // A banner (near twice as wide as tall or wider) is scenery; a picture of the work itself, a screenshot say, is
    // squarer, and the work may be as big as it likes.
    if (p.width / p.height >= 1.8 && p.height / box.height > pictureShare && p.height > rest * pictureRatio && p.width >= box.width * 0.75) {
      issues.push({
        ref: ref(pic),
        rule: "giant-picture",
        element: `${describe(pic)}${quoted(pic)} in ${describe(item)}${quoted(title)}`,
        detail: `the picture is ${Math.round(p.width)}×${Math.round(p.height)}, ${Math.round((p.height / box.height) * 100)}% of its item's height and ${(p.height / Math.max(1, rest)).toFixed(1)} times its words'`,
      });
    }
  }

  // cramped-heading: a heading (with the icon on its row) too close to a picture or a filled or framed box beside it,
  // each measured by the part of it that is drawn.
  // A fixed layer that covers the window (a sheet's scrim, a backdrop) is drawn behind its overlay, not laid out above it.
  const windowLayer = (el: Element) => {
    if (getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
  };
  // A row measured by what its children draw: the union of its shown children's drawn rects and of its text, not the row's
  // own box. So the row's padding, border and fill are room above its heading, as a padded box's padding is for a heading
  // in it, and a child pulled up over the padding is drawn there. Hidden children draw nothing, so they count for nothing.
  // The heading is one of the row's shown children, so the union always holds it.
  const drawnContent = (row: Element): DOMRect => {
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const node of row.childNodes) {
      let box: DOMRect | null = null;
      if (node instanceof Element) box = shown(node) ? drawnRect(node) : null;
      else if (node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) {
        const text = document.createRange();
        text.selectNodeContents(node);
        box = text.getBoundingClientRect();
      }
      if (!box) continue;
      [left, top] = [Math.min(left, box.left), Math.min(top, box.top)];
      [right, bottom] = [Math.max(right, box.right), Math.max(bottom, box.bottom)];
    }
    return new DOMRect(left, top, right - left, bottom - top);
  };
  const blocks = visible.filter((el) => {
    const r = drawnRect(el)!;
    return r.width >= 48 && r.height >= 48 && filled(el) && !windowLayer(el);
  });
  for (const heading of headings) {
    if (optedOut(heading, "cramped-heading")) continue;
    const parent = heading.parentElement!;
    const ps = getComputedStyle(parent);
    const size = px(getComputedStyle(heading).fontSize);
    const onRow = /flex/.test(ps.display) && !ps.flexDirection.startsWith("column") && [...parent.children].every((c) => c === heading || c.getBoundingClientRect().height <= size * 2.5);
    const row = onRow ? parent : heading;
    const r = onRow ? drawnContent(parent) : drawnRect(heading)!;
    let worst: { block: Element; gap: number; need: number } | null = null;
    for (const block of blocks) {
      if (block.contains(row) || row.contains(block)) continue;
      const b = drawnRect(block)!;
      const across = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      if (across < Math.min(r.width, b.width) * 0.3 || b.bottom > r.top + 2) continue;
      // The same item: the smallest box holding both holds no other heading, and is no page-wide container.
      let common: Element = block.parentElement!;
      while (!common.contains(row)) common = common.parentElement!;
      const sameItem = !common.matches("body, main") && headings.every((h) => h === heading || !common.contains(h));
      const need = Math.max(8, size * (sameItem ? headingRoom / 2 : headingRoom));
      const gap = r.top - b.bottom;
      if (gap < need && (!worst || gap < worst.gap)) worst = { block, gap, need };
    }
    if (worst) {
      issues.push({
        ref: ref(row),
        rule: "cramped-heading",
        element: `${describe(heading)}${quoted(heading)}`,
        detail: `${Math.max(0, Math.round(worst.gap))}px below ${describe(worst.block)}; a ${Math.round(size)}px heading needs ${Math.round(worst.need)}px`,
      });
    }
  }

  // nested-frame: a frame hugging a frame, or corners that don't nest. An Ouro surface layer is its parent's own paint
  // (where the engine has no corner-shape it draws the parent's fill and border), never a frame inside it.
  const isLayer = (el: Element) => el.hasAttribute("data-ouro-surface") || el.hasAttribute("data-ouro-avatar-surface");
  const framed = visible.filter((el) => frameOf(el) !== null);
  const reported = new Set<Element>();
  for (const outer of framed) {
    if (optedOut(outer, "nested-frame")) continue;
    const o = outer.getBoundingClientRect();
    for (const inner of framed) {
      if (inner === outer || !outer.contains(inner) || reported.has(inner) || isLayer(inner)) continue;
      const i = inner.getBoundingClientRect();
      const insets = [i.top - o.top, o.right - i.right, o.bottom - i.bottom, i.left - o.left];
      if (i.width >= 48 && i.height >= 32 && insets.every((d) => d >= -1 && d <= hugPx)) {
        reported.add(inner);
        issues.push({ ref: ref(inner), rule: "nested-frame", element: `${describe(inner)} in ${describe(outer)}`, detail: `a frame drawn ${Math.round(Math.max(...insets))}px inside another: a double border` });
      }
    }
  }
  // A radius as drawn: CSS shrinks one larger than half the box (a pill's 9999px) to that half.
  const radiusOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return Math.min(px(getComputedStyle(el).borderTopLeftRadius), r.width / 2, r.height / 2);
  };
  for (const outer of visible) {
    const os = getComputedStyle(outer);
    const radius = radiusOf(outer);
    // Only a corner people see: a visible frame or fill, which doesn't clip what is in it, around a child near enough
    // its corner (under half the radius in) for the two curves to read as one shape.
    if (radius < 6 || /hidden|clip/.test(os.overflow) || !filled(outer) || optedOut(outer, "nested-frame")) continue;
    const o = outer.getBoundingClientRect();
    for (const inner of outer.children) {
      if (reported.has(inner) || isLayer(inner) || !shown(inner) || !edged(inner)) continue;
      const i = inner.getBoundingClientRect();
      const inset = Math.max(0, Math.min(i.top - o.top, i.left - o.left));
      if (inset >= radius / 2) continue;
      const own = radiusOf(inner);
      const want = Math.max(0, radius - inset);
      if (Math.abs(own - want) > Math.max(2, radius * 0.25)) {
        reported.add(inner);
        issues.push({
          ref: ref(inner),
          rule: "nested-frame",
          element: `${describe(inner)} in ${describe(outer)}`,
          detail: `corner radius ${Math.round(own)}px, ${Math.round(inset)}px inside a ${Math.round(radius)}px corner: the corners nest at ${Math.round(want)}px`,
        });
      }
    }
  }

  // type-scale and shadow-scale: what the page draws, counted once. Text an element opts out of with a reason (hand
  // lettering, say) is art, so it is left out of the size and weight counts; the rest of the page is still counted.
  const texts = visible.filter((el) => hasText(el) && !optedOut(el, "type-scale"));
  const count = <T,>(values: T[]) => {
    const seen = new Map<T, number>();
    for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
    return seen;
  };
  const sizes = count(texts.map((el) => Math.round(px(getComputedStyle(el).fontSize) * 2) / 2));
  // Weights are counted within a text role: headings keep their own weight, so a semibold heading leaves the running
  // text its regular, medium and bold, as Refactoring UI's two or three weights for UI text intend.
  const isHeading = (el: Element) => el.closest("h1, h2, h3, h4, h5, h6, [role='heading']") !== null;
  const weightsOf = (heading: boolean) => count(texts.filter((el) => isHeading(el) === heading).map((el) => Number(getComputedStyle(el).fontWeight)));
  const rarest = <T,>(seen: Map<T, number>, of: (el: Element) => T) => texts.find((el) => of(el) === [...seen].sort((a, b) => a[1] - b[1])[0]![0])!;
  if (sizes.size > maxSizes) {
    const list = [...sizes.keys()].sort((a, b) => a - b);
    issues.push({ ref: ref(rarest(sizes, (el) => Math.round(px(getComputedStyle(el).fontSize) * 2) / 2)), rule: "type-scale", element: "the page's text sizes", detail: `${list.length} sizes (${list.join(", ")} px); a type scale holds ${maxSizes} or fewer` });
  }
  for (const heading of [false, true]) {
    const weights = weightsOf(heading);
    if (weights.size <= maxWeights) continue;
    const list = [...weights.keys()].sort((a, b) => a - b);
    const role = (el: Element) => isHeading(el) === heading;
    const rarestWeight = [...weights].sort((a, b) => a[1] - b[1])[0]![0];
    issues.push({ ref: ref(texts.find((el) => role(el) && Number(getComputedStyle(el).fontWeight) === rarestWeight)!), rule: "type-scale", element: heading ? "the page's heading weights" : "the page's font weights", detail: `${list.length} weights (${list.join(", ")}); keep to ${maxWeights}` });
  }
  // giant-text: the size that carries most of the page's running text, counted by its own characters, outside headings.
  // A page with little running text (a splash, a sign-in) has no reading size to judge. Emoji count for nothing: they are
  // pictures set in a font, and a picker draws its grid of them large on purpose.
  const emoji = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3/gu;
  const reading = new Map<number, { chars: number; first: Element }>();
  for (const el of texts) {
    if (isHeading(el) || optedOut(el, "giant-text")) continue;
    const chars = [...el.childNodes].reduce((n, node) => n + (node.nodeType === 3 ? node.textContent!.replace(emoji, "").trim().length : 0), 0);
    const size = Math.round(px(getComputedStyle(el).fontSize) * 2) / 2;
    const seen = reading.get(size);
    if (seen) seen.chars += chars;
    else reading.set(size, { chars, first: el });
  }
  const [main] = [...reading].sort((a, b) => b[1].chars - a[1].chars);
  if (main && main[1].chars >= 120 && main[0] > readingPx) {
    issues.push({ ref: ref(main[1].first), rule: "giant-text", element: "the page's running text", detail: `most of it is drawn at ${main[0]}px (${main[1].chars} characters); keep reading text to ${readingPx}px or under at every screen size` });
  }

  const shadowed = visible.filter((el) => getComputedStyle(el).boxShadow !== "none" && frameOf(el) === null);
  const shadows = count(shadowed.map((el) => getComputedStyle(el).boxShadow));
  if (shadows.size > maxShadows && !optedOut(document.body, "shadow-scale")) {
    const rare = [...shadows].sort((a, b) => a[1] - b[1])[0]![0];
    issues.push({ ref: ref(shadowed.find((el) => getComputedStyle(el).boxShadow === rare)!), rule: "shadow-scale", element: "the page's shadows", detail: `${shadows.size} different shadows; an elevation scale holds ${maxShadows} or fewer` });
  }

  // grey-on-colour: a neutral grey on a saturated fill.
  for (const el of texts) {
    if (optedOut(el, "grey-on-colour")) continue;
    const fg = rgba(getComputedStyle(el).color);
    const bg = backgroundOf(el);
    if (!bg) continue;
    const [f, b] = [hsl(fg), hsl(bg)];
    if (f.s < 0.12 && f.l > 0.3 && f.l < 0.75 && b.s >= 0.35 && b.l > 0.15 && b.l < 0.85) {
      issues.push({ ref: ref(el), rule: "grey-on-colour", element: `${describe(el)}${quoted(el)}`, detail: `grey text (rgb ${fg.slice(0, 3).join(" ")}) on a coloured background (rgb ${bg.slice(0, 3).join(" ")}): use a shade of the background's hue` });
    }
  }

  // heading-hierarchy: each heading against the nearest heading above it of a higher rank.
  const drawnSize = (heading: Element) => Math.max(...[heading, ...heading.querySelectorAll("*")].filter((el) => el === heading || (hasText(el) && shown(el))).map((el) => px(getComputedStyle(el).fontSize)));
  for (const [at, heading] of headings.entries()) {
    const level = headingLevel(heading);
    const above = headings.slice(0, at).reverse().find((h) => headingLevel(h) < level);
    if (!above || optedOut(heading, "heading-hierarchy")) continue;
    const [mine, theirs] = [drawnSize(heading), drawnSize(above)];
    if (mine > theirs + 1) {
      issues.push({
        ref: ref(heading),
        rule: "heading-hierarchy",
        element: `${describe(heading)}${quoted(heading)}`,
        detail: `${Math.round(mine)}px, larger than the ${describe(above)}${quoted(above)} it sits under at ${Math.round(theirs)}px`,
      });
    }
  }
  return issues;
}

// baked-corner, first half: the pictures and videos worth reading, with how round their drawn corners are (their own
// radius, or a clipping box's that they fill).
function listCornerMedia(limit = 12): CornerMedia[] {
  const counter = window as unknown as { __ouroCheckRef?: number };
  const found: CornerMedia[] = [];
  for (const el of document.querySelectorAll("img, video, canvas")) {
    if (found.length >= limit) break;
    const r = el.getBoundingClientRect();
    if (r.width < 96 || r.height < 96 || el.closest("[hidden], [aria-hidden=true]")) continue;
    let allowed = false;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = (n.getAttribute("data-ouro-allow") ?? "").split(/\s+/);
      if ((rules.includes("baked-corner") || rules.includes("all")) && (n.getAttribute("data-ouro-allow-why") ?? "").trim()) allowed = true;
    }
    const s = getComputedStyle(el);
    if (allowed || s.visibility === "hidden" || Number(s.opacity) <= 0.05) continue;
    // The roundest clipping box the media fills: its frame, however far up it is; and the first fill behind that.
    let radius = parseFloat(s.borderTopLeftRadius) || 0;
    let frame: Element = el;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const box = n.getBoundingClientRect();
      // A wrapper that draws no box of its own (display: contents, as a picture element often is) is passed over.
      if (!box.width || !box.height) continue;
      if (Math.abs(box.left - r.left) > 2 || Math.abs(box.top - r.top) > 2 || Math.abs(box.width - r.width) > 4) break;
      const ns = getComputedStyle(n);
      if (/hidden|clip/.test(ns.overflow) && (parseFloat(ns.borderTopLeftRadius) || 0) > radius) [radius, frame] = [parseFloat(ns.borderTopLeftRadius), n];
    }
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    // A CSS colour as RGB, or null when it is mostly transparent.
    const rgb = (colour: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return alpha! >= 128 ? [red!, green!, blue!] : null;
    };
    let behind = [255, 255, 255];
    for (let n = frame.parentElement; n; n = n.parentElement) {
      const fill = rgb(getComputedStyle(n).backgroundColor);
      if (fill) {
        behind = fill;
        break;
      }
    }
    // Never their fills: a dark card behind a recording would hide the recording's dark corners.
    const own = [el, frame].flatMap((n) => {
      const ns = getComputedStyle(n);
      const sides = ["top", "right", "bottom", "left"].filter((side) => parseFloat(ns.getPropertyValue(`border-${side}-width`)) > 0);
      const outline = ns.outlineStyle !== "none" && parseFloat(ns.outlineWidth) > 0 ? [ns.outlineColor] : [];
      return [...sides.map((side) => ns.getPropertyValue(`border-${side}-color`)), ...outline].map(rgb).filter((c): c is number[] => c !== null);
    });
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const ref = `c${counter.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${ref}`.trim());
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || "";
    const name = src && !/^(data|blob):/.test(src) ? new URL(src, location.href).pathname.split("/").filter(Boolean).slice(-2).join("/") : el.tagName.toLowerCase();
    // A round crop (an avatar, a pill) is round on purpose; its corners are the page's.
    if (radius >= Math.min(r.width, r.height) / 4) continue;
    found.push({ ref, element: name, box: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }, radius, behind, own });
  }
  return found;
}

// Waits, up to 3 s each, for a media to draw: a picture decoded, or a video held still on its first frame (loaded first
// when the page waits for a play, as preload="none" does), so every run reads the same pixels; then two frames.
async function mediaDrawn(ref: string): Promise<void> {
  const el = document.querySelector(`[data-ouro-check-ref~="${ref}"]`)!;
  const wait = (event: string) => Promise.race([new Promise((done) => el.addEventListener(event, done, { once: true })), new Promise((done) => setTimeout(done, 3000))]);
  if (el instanceof HTMLVideoElement) {
    if (!el.paused) {
      const paused = wait("pause");
      el.pause();
      await paused;
    }
    if (el.readyState < 2) {
      el.preload = "auto";
      el.load();
      await wait("loadeddata");
    }
    // WebKit can report where playback stopped after a seek has landed, so look again and seek again until it holds.
    for (let tries = 0; el.currentTime !== 0 && tries < 3; tries++) {
      el.currentTime = 0;
      await wait("seeked");
      await new Promise((done) => requestAnimationFrame(done));
    }
  } else if (el instanceof HTMLImageElement) await el.decode().catch(() => undefined);
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
}

// Where a media is on the screen now, as a clip for a picture of it, and the corners the screen shows as the media: each
// hit-tests, a little inside, to the media or to the frame it fills. A corner off the screen, or under a fixed bar or
// another element, is not the media's to judge.
function shownCorners(ref: string): { corners: string[]; clip: { x: number; y: number; width: number; height: number } } {
  const el = document.querySelector(`[data-ouro-check-ref~="${ref}"]`)!;
  const r = el.getBoundingClientRect();
  const [x, y] = [Math.max(0, r.left), Math.max(0, r.top)];
  const clip = { x, y, width: Math.min(r.right, innerWidth) - x, height: Math.min(r.bottom, innerHeight) - y };
  const inset = Math.min(12, r.width / 4, r.height / 4);
  const points: [string, number, number][] = [["top left", r.left + inset, r.top + inset], ["top right", r.right - inset, r.top + inset], ["bottom left", r.left + inset, r.bottom - inset], ["bottom right", r.right - inset, r.bottom - inset]];
  const corners = points
    .filter(([, x, y]) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return false;
      const box = hit.getBoundingClientRect();
      return el.contains(hit) || (hit.contains(el) && Math.abs(box.left - r.left) <= 2 && Math.abs(box.top - r.top) <= 2 && Math.abs(box.width - r.width) <= 4);
    })
    .map(([name]) => name);
  return { corners, clip };
}

// baked-corner, second half: reads each corner of the media as drawn, pixel by pixel along its diagonal. A corner drawn
// right shows the colour behind the frame outside its curve, the media's edge colour inside it (where the two edges
// beside the corner agree), and a blend of the two on the curve. A corner is baked in when a band of pixels is none of
// these and the diagonal then turns back to the edges' colour further in: the shape a window's own rounded corner
// makes in a screen recording, drawn inside the page's frame. Two corners must show it in the same colour, so a
// photograph's dark corners aren't one.
async function readCorners(readings: CornerReading[]): Promise<PageIssue[]> {
  const issues: PageIssue[] = [];
  for (const { ref, element, shot, radius, behind: computed, own, corners: shown } of readings) {
    const picture = new Image();
    picture.src = shot;
    await picture.decode();
    const [w, h] = [picture.naturalWidth, picture.naturalHeight];
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [w, h];
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(picture, 0, 0);
    const at = (x: number, y: number) => [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
    const far = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    const edge = Math.min(Math.max(2 * radius + 8, 24), Math.min(w, h) / 3);
    // Each corner as an origin and the directions into the media from it.
    const corners = ([["top left", 0, 0, 1, 1], ["top right", w - 1, 0, -1, 1], ["bottom left", 0, h - 1, 1, -1], ["bottom right", w - 1, h - 1, -1, -1]] as const).filter(([name]) => shown.includes(name));
    // How far a colour is from every blend of two others.
    const offBlend = (k: number[], p: number[], q: number[]) => {
      const pq = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
      const t = Math.max(0, Math.min(1, ((k[0]! - p[0]!) * pq[0]! + (k[1]! - p[1]!) * pq[1]! + (k[2]! - p[2]!) * pq[2]!) / Math.max(1, pq[0]! ** 2 + pq[1]! ** 2 + pq[2]! ** 2)));
      return far(k, [p[0]! + t * pq[0]!, p[1]! + t * pq[1]!, p[2]! + t * pq[2]!]);
    };
    const reach = Math.min(Math.ceil(radius * 1.2) + 4, 40, Math.floor(Math.min(w, h) / 4));
    // The colour of a corner's band, or null when it has none.
    const band = ([, x, y, dx, dy]: (typeof corners)[number]): number[] | null => {
      // What shows behind the frame: the nearest fill in the styles, or the page as drawn at the corner's own tip, outside
      // a curve of 3 px or more, whatever paints it there.
      const tip = radius >= 3 ? at(x, y) : computed;
      let odd: number[] | null = null;
      let flat = 0;
      for (let c = 1; c <= reach; c++) {
        const [k, a, d] = [at(x + dx * c, y + dy * c), at(x + dx * edge, y + dy * c), at(x + dx * c, y + dy * edge)];
        if (far(a, d) >= 40) continue;
        if (odd && far(k, a) < 40 && far(k, d) < 40) {
          if (flat >= 2) return odd;
          odd = null;
        }
        // A baked corner is one flat fill: a colour that wanders along the diagonal, such as a glow in the picture, is content.
        if (odd) {
          if (far(k, odd) < 30) flat++;
          else if (flat < 2) odd = null;
        }
        // A colour the frame or the media draws itself (its border, its fill) is its own frame, not a corner baked in.
        if (!odd && offBlend(k, computed, a) > 80 && offBlend(k, tip, a) > 80 && far(k, d) > 80 && !own.some((c) => offBlend(k, computed, c) < 40)) { odd = k; flat = 0; }
      }
      return null;
    };
    const bands = corners.flatMap((corner) => {
      const colour = band(corner);
      return colour ? [{ name: corner[0], colour }] : [];
    });
    const baked = bands.filter(({ colour }) => bands.some((other) => other.colour !== colour && far(colour, other.colour) < 40));
    if (baked.length >= 2) {
      issues.push({ ref, rule: "baked-corner", element, detail: `the ${baked.map(({ name }) => name).join(", ")} corners draw a colour neither edge beside them has: the media's own corners show inside its frame` });
    }
  }
  return issues;
}
