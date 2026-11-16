export { findWrapIssues, readHeroArt };
export type { HeroArt, WrapOptions };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside its function. Text that wraps by
// accident rather than on purpose, read from the lines the browser drew, after Butterick's Practical Typography (no
// widows, line length) and Refactoring UI (Wathan and Schoger) on headings: a heading spans its column and wraps where
// the browser balances it, never where a hand-placed break put it.
//
//   lone-word       a block of text (a heading, paragraph, list item, quote, caption or description) of more than three
//                   words whose last line holds one word alone. A word broken at its hyphen counts on both its lines.
//                   A word that can't break (an address, a path, an identifier, over 20 characters) isn't one, nor is
//                   a word in code (code, kbd, samp), which wraps where its characters allow, not where its writer chose.
//                   A flex or grid row of items wraps as boxes, not lines, and passes. Text cut short, by a line clamp
//                   or a box that hides its overflow, ends where a person stops seeing it, not on its last word, and
//                   passes; every rule reads only the lines a person sees
//   tall-heading    an h1 drawn at `displayPx` or larger that runs `tallLines` lines or more
//   one-word-line   text drawn at `bigPx` or larger, in three lines or more, with a line before its last that holds one
//                   word alone when the next line's first word would have fit beside it: a break by choice. Words too
//                   long to share a line at that size are the heading's size, not its wrapping, and pass
//   hard-break      a heading broken by hand: a <br> in it, or its words split into two or more block-level line spans
//                   (an icon's box, or a picture, isn't a line)
//   narrow-heading  a heading drawn at `bigPx` or larger, wrapped onto more lines than one, whose max-width holds it
//                   under `narrowShare` of the width its parent gives it
//
// An element opts out of a rule with data-ouro-allow="<rule ids>" and a reason in data-ouro-allow-why, as the other rules
// do. `element` names the element by its words, the same at every size; `detail` has this size's lines.

interface WrapOptions {
  displayPx?: number;
  tallLines?: number;
  bigPx?: number;
  narrowShare?: number;
}

function findWrapIssues({ displayPx = 36, tallLines = 5, bigPx = 28, narrowShare = 0.8 }: WrapOptions = {}): PageIssue[] {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `w${counter.__ouroCheckRef}`;
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
  // Drawn: not hidden, inert or closed, shown by its styles, and bigger than the 1px of visually hidden text.
  const drawn = (el: Element) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"], details:not([open]) > :not(summary)')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  // The lines the browser drew, top to bottom, each the words on it, inline code and footnote marks included. A word split
  // across lines (at its hyphen) puts a piece on each. A code block and visually hidden text are left out.
  type Word = { text: string; whole: string; code: boolean; width: number };
  const linesOf = (el: Element) => {
    const rows: { top: number; height: number; words: Word[] }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement!;
      if (parent.closest("pre") || !drawn(parent)) continue;
      const code = !!parent.closest("code, kbd, samp");
      for (const match of (node as Text).data.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const boxes = [...range.getClientRects()].filter((b) => b.width > 0);
        // A word split across lines is named by the piece each line drew ("agent-" / "native?"), not the whole word twice.
        const pieces = boxes.length < 2 ? [match[0]] : boxes.map(() => "");
        if (boxes.length > 1) {
          for (let i = 0; i < match[0].length; i++) {
            range.setStart(node, match.index + i);
            range.setEnd(node, match.index + i + 1);
            const top = range.getBoundingClientRect().top;
            const at = boxes.findIndex((b) => Math.abs(b.top - top) < b.height / 2);
            pieces[Math.max(at, 0)] += match[0].charAt(i);
          }
        }
        for (const [index, box] of boxes.entries()) {
          const row = rows.find((r) => Math.abs(r.top - box.top) < Math.max(r.height, box.height) / 2);
          const word = { text: pieces[index]!, whole: match[0], code, width: box.width };
          if (row) row.words.push(word);
          else rows.push({ top: box.top, height: box.height, words: [word] });
        }
      }
    }
    rows.sort((a, b) => a.top - b.top);
    // Only the lines a person sees: none past a line clamp, and none a box that hides its overflow (this one, or one
    // around it, such as a clamp's or a max-height's) cuts off. A scroller's lines can be scrolled to, so they count.
    let top = -Infinity;
    let bottom = Infinity;
    for (let box: Element | null = el; box && box !== document.body; box = box.parentElement) {
      const style = getComputedStyle(box);
      if (style.overflowY !== "hidden" && style.overflowY !== "clip") continue;
      const rect = box.getBoundingClientRect();
      top = Math.max(top, rect.top + box.clientTop);
      bottom = Math.min(bottom, rect.top + box.clientTop + box.clientHeight);
    }
    const clamp = parseInt(String((getComputedStyle(el) as CSSStyleDeclaration & { webkitLineClamp: string }).webkitLineClamp), 10);
    const shown = rows.filter((row) => row.top + row.height / 2 >= top && row.top + row.height / 2 <= bottom).slice(0, clamp > 0 ? clamp : undefined);
    return { lines: shown.map((row) => row.words), cut: shown.length < rows.length };
  };
  // Judged by the whole word, so a long token split at its hyphens stays unbreakable however short its last piece.
  const breakable = ({ whole, code }: Word) => {
    const bare = whole.replace(/^\W+|\W+$/g, "");
    return !code && bare.length > 1 && bare.length <= 20 && !/[/:@=_<>{}()[\]]|\.\w/.test(bare);
  };
  const nameOf = (el: Element) => el.textContent!.trim().replace(/\s+/g, " ");
  const describe = (el: Element) => {
    const words = nameOf(el);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${words.slice(0, 40)}${words.length > 40 ? "…" : ""}"`;
  };
  const show = (lines: Word[][]) => lines.map((line) => line.map((word) => word.text).join(" ")).join(" / ");
  const add = (el: Element, rule: string, detail: string) => {
    if (optedOut(el, rule)) return;
    issues.push({ ref: ref(el), rule, element: describe(el), detail });
  };
  const blocks = "h1, h2, h3, h4, h5, h6, p, li, dd, dt, blockquote, figcaption, [data-slot=description]";
  for (const el of document.querySelectorAll(blocks)) {
    // A block that holds blocks of its own (a list item with paragraphs) is judged through them.
    if (el.querySelector(blocks) || !drawn(el)) continue;
    const { lines, cut } = linesOf(el);
    if (!lines.length) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    const words = lines.flat().length;
    const last = lines.at(-1)!;
    // A flex or grid row's items wrap as boxes, such as a row of tags, not as lines of text.
    const flow = el.children.length < 2 || !/flex|grid/.test(getComputedStyle(el).display);
    if (flow && !cut && lines.length > 1 && last.length === 1 && words > 3 && breakable(last[0]!)) add(el, "lone-word", `ends on "${last[0]!.text}" alone: ${show(lines)}`);
    if (el.tagName === "H1" && size >= displayPx && lines.length >= tallLines) add(el, "tall-heading", `${lines.length} lines at ${Math.round(size)}px: ${show(lines)}`);
    if (flow && size >= bigPx && lines.length > 2) {
      // Alone by choice, not by force: the next line's first word would have fit beside it.
      const column = el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight);
      const alone = lines.slice(0, -1).find((line, index) => line.length === 1 && breakable(line[0]!) && line[0]!.width + size / 4 + lines[index + 1]![0]!.width <= column);
      if (alone) add(el, "one-word-line", `"${alone[0]!.text}" alone on a line at ${Math.round(size)}px: ${show(lines)}`);
    }
    if (!/^H[1-6]$/.test(el.tagName)) continue;
    const spans = [...el.querySelectorAll("*")].filter((child) => {
      const display = getComputedStyle(child).display;
      return /^(block|flex|grid|list-item|table)$/.test(display) && nameOf(child) && !child.querySelector("img, svg, picture, video, canvas") && drawn(child);
    });
    if (el.querySelector("br")) add(el, "hard-break", "a <br> breaks it by hand");
    else if (spans.length > 1) add(el, "hard-break", `its words are split into ${spans.length} block-level line spans`);
    const max = getComputedStyle(el).maxWidth;
    const room = el.parentElement!.clientWidth - parseFloat(getComputedStyle(el.parentElement!).paddingLeft) - parseFloat(getComputedStyle(el.parentElement!).paddingRight);
    const width = el.getBoundingClientRect().width;
    if (size >= bigPx && lines.length > 1 && max !== "none" && width < room * narrowShare)
      add(el, "narrow-heading", `max-width ${max} holds it to ${Math.round(width)}px of the ${Math.round(room)}px its parent gives it: ${show(lines)}`);
  }
  return issues;
}

interface HeroArt {
  ref: string;
  element: string;
  src: string;
  /** The page's own background is dark: its dark theme, or a page that is dark in its light theme too. */
  darkPage: boolean;
}

// The page's hero art: the largest picture drawn in the first screen, at least `minArea` CSS pixels, with the file it
// shows. Ouro check reads it in light and in dark at each size, and a dark page that shows the light file has no night
// art (dark-art). A picture marked data-ouro-allow="dark-art", with its reason, is left out.
function readHeroArt({ minArea = 60000 }: { minArea?: number } = {}): HeroArt | null {
  const counter = window as unknown as { __ouroCheckRef?: number };
  // The relative luminance of an opaque colour; a see-through one (a transparent body) reads as nothing.
  const luminance = (colour: string) => {
    const [r, g, b, a = 1] = colour.match(/[\d.]+/g)!.map(Number) as [number, number, number, number?];
    const linear = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return a < 0.5 ? null : 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const background = luminance(getComputedStyle(document.body).backgroundColor) ?? luminance(getComputedStyle(document.documentElement).backgroundColor) ?? 1;
  const allowed = (img: Element) => {
    const holder = img.closest("[data-ouro-allow]");
    return !!holder && /(^|\s)(dark-art|all)(\s|$)/.test(holder.getAttribute("data-ouro-allow")!) && !!holder.getAttribute("data-ouro-allow-why")?.trim();
  };
  const area = (img: Element) => img.getBoundingClientRect().width * img.getBoundingClientRect().height;
  const hero = [...document.images]
    .filter((img) => {
      const r = img.getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0 && area(img) >= minArea && img.currentSrc && img.checkVisibility({ visibilityProperty: true }) && !allowed(img);
    })
    .sort((a, b) => area(b) - area(a))[0];
  if (!hero) return null;
  counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
  const id = `w${counter.__ouroCheckRef}`;
  hero.setAttribute("data-ouro-check-ref", `${hero.getAttribute("data-ouro-check-ref") ?? ""} ${id}`.trim());
  const alt = hero.alt.trim();
  return { ref: id, element: alt ? `img "${alt.slice(0, 40)}${alt.length > 40 ? "…" : ""}"` : "img", src: hero.currentSrc, darkPage: background < 0.2 };
}
