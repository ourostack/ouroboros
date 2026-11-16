export { findOverlaps };
export type { OverlapOptions };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside the function. It scrolls through
// the page and reports any line of text that collides with another line of text, or with a picture, inside the same
// section. Sticky headings are checked where they sit at each scroll position. Text that belongs to one block (its own
// lines, or a block and the blocks inside it) never counts against itself; text a line clamp or overflow cuts away
// doesn't count, nor does the part of a picture a clipping box cuts away; an opaque sticky or fixed bar, and an opaque
// overlay (an open dialog, menu, listbox, popover or tooltip, or a panel of 120×48 or more floating fixed or absolute,
// not a badge), covers what is under it rather than colliding with it; and a label on an opaque backing of its own (a
// chip on a picture) reads.
// An element opts out with data-ouro-allow="overlap" and data-ouro-allow-why="<reason>", or, in an app whose own rules
// keep data-ouro-* for Ouro's components, data-overlap-ignore="<reason>", which stays; art drawn as a backdrop behind
// words needs it.

interface OverlapOptions {
  slack?: number;
  maxSteps?: number;
}

interface Item {
  kind: "text" | "image";
  el: Element;
  block: Element;
  section: Element;
  rect: { left: number; right: number; top: number; bottom: number };
  cover: Element | null;
}

function findOverlaps({ slack = 2, maxSteps = 40 }: OverlapOptions = {}): PageIssue[] {
  const ignored = "[hidden], .visually-hidden, .sr-only, template, details:not([open]) > :not(summary)";
  // Whether an element, or one around it, opts out: data-ouro-allow="overlap" (or "all") with a reason, or
  // data-overlap-ignore with its reason as its value. A reason of spaces is no reason; the page is read, never rewritten.
  const reasonOf = (el: Element, name: string) => (el.getAttribute(name) ?? "").trim();
  const optedOut = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = reasonOf(n, "data-ouro-allow").split(/\s+/);
      if (reasonOf(n, "data-overlap-ignore") || ((rules.includes("overlap") || rules.includes("all")) && reasonOf(n, "data-ouro-allow-why"))) return true;
    }
    return false;
  };
  const sectionOf = (el: Element) => el.closest("main > section, section, footer, [data-ouro-section]") ?? document.body;
  const visible = (el: Element) => {
    if (el.closest(ignored) || optedOut(el)) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    // Opacity isn't inherited in computed style, so a faded-out ancestor (a hover-only toolbar) hides its text too.
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) if (Number(getComputedStyle(node).opacity) <= 0.05) return false;
    return true;
  };
  const blockOf = (el: Element) => {
    for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
      const display = getComputedStyle(node).display;
      if (display !== "inline" && display !== "contents") return node;
    }
    return document.body;
  };
  const describe = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""} "${(el.textContent || el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 50)}"`;
  const clipOf = (el: Element) => {
    const box = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const r = node.getBoundingClientRect();
        box.left = Math.max(box.left, r.left);
        box.right = Math.min(box.right, r.right);
        box.top = Math.max(box.top, r.top);
        box.bottom = Math.min(box.bottom, r.bottom);
      }
    }
    return box;
  };
  // The layer an element is drawn on, when it covers what is under it: the nearest sticky or fixed bar with a fill, or
  // the nearest overlay with an opaque fill on it or on a box between it and the element. Text on one layer and text on
  // another don't collide: the one on top hides the other.
  const overlay = "[role=dialog], [role=alertdialog], dialog, [role=menu], [role=listbox], [role=tooltip], [popover], [data-popover]";
  const coverOf = (el: Element) => {
    let opaque = false;
    for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      const filled = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
      const [, , , alpha = "1"] = style.backgroundColor.replace(/^[a-z]+\(|\)$/g, "").split(/[\s,/]+/);
      opaque ||= filled && Number(alpha) >= 0.9;
      if ((style.position === "sticky" || style.position === "fixed") && filled) return node;
      const box = node.getBoundingClientRect();
      const floating = (style.position === "absolute" || style.position === "fixed") && box.width >= 120 && box.height >= 48;
      if (opaque && (node.matches(overlay) || floating)) return node;
    }
    return null;
  };
  const collect = () => {
    const items: Item[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.textContent!.trim() && !node.parentElement!.closest("svg, script, style, noscript") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement!;
      if (!visible(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const block = blockOf(parent);
      // A glyph box is taller than its line when the line height is tight; only the line itself counts.
      const line = parseFloat(getComputedStyle(parent).lineHeight);
      const clip = clipOf(parent);
      const cover = coverOf(parent);
      for (const box of range.getClientRects()) {
        if (box.width <= 1 || box.height <= 1) continue;
        const trim = Number.isFinite(line) && box.height > line ? (box.height - line) / 2 : 0;
        const rect = { left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right), top: Math.max(box.top + trim, clip.top), bottom: Math.min(box.bottom - trim, clip.bottom) };
        if (rect.right - rect.left > 1 && rect.bottom - rect.top > 1) items.push({ kind: "text", el: parent, block, section: sectionOf(parent), rect, cover });
      }
    }
    for (const el of document.querySelectorAll("img, svg")) {
      if (el.tagName.toLowerCase() === "svg" && el.parentElement?.closest("svg")) continue;
      if (!visible(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 40 || box.height < 40) continue;
      // As drawn: what a clipping box around it (a scroller, a collapsed "see more") cuts away doesn't count.
      const clip = clipOf(el.parentElement!);
      const rect = { left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right), top: Math.max(box.top, clip.top), bottom: Math.min(box.bottom, clip.bottom) };
      if (rect.right - rect.left > 1 && rect.bottom - rect.top > 1) items.push({ kind: "image", el, block: el, section: sectionOf(el), rect, cover: coverOf(el) });
    }
    return items;
  };
  const related = (a: Element, b: Element) => a === b || a.contains(b) || b.contains(a);
  // Whether text sits on a backing of its own over a picture, as a label's chip does: a box between the text and the
  // picture with a nearly opaque fill. Such a label reads, whatever is under it.
  const backed = (text: Element, picture: Element) => {
    for (let node: Element | null = text; node && !node.contains(picture); node = node.parentElement) {
      // A colour's channels and alpha, in any syntax the browser computes: rgb(r, g, b), rgba(r, g, b, a), oklch(l c h / a).
      const [, , , alpha = "1"] = getComputedStyle(node).backgroundColor.replace(/^[a-z]+\(|\)$/g, "").split(/[\s,/]+/);
      if (Number(alpha) >= 0.9) return true;
    }
    return false;
  };
  const found = new Map<string, PageIssue>();
  const counter = window as unknown as { __ouroCheckRef?: number };
  const total = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const step = Math.max(200, Math.floor(innerHeight * 0.8));
  const positions: number[] = [];
  for (let y = 0; y < total && positions.length < maxSteps; y += step) positions.push(y);
  const original = scrollY;
  for (const y of positions) {
    window.scrollTo({ top: y, behavior: "instant" });
    const items = collect().filter((item) => item.rect.bottom > 0 && item.rect.top < innerHeight);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        if (a.kind === "image" && b.kind === "image") continue;
        if (a.section !== b.section || related(a.block, b.block) || related(a.el, b.el)) continue;
        if (a.cover !== b.cover) continue;
        // Text is collected before pictures, so a pair of the two is the text, then the picture.
        if (b.kind === "image" && backed(a.el, b.el)) continue;
        const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (x <= slack || h <= slack) continue;
        const element = `${describe(a.el)} × ${describe(b.el)}`;
        if (found.has(element)) continue;
        counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
        const ref = `o${counter.__ouroCheckRef}`;
        for (const el of [a.el, b.el]) el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${ref}`.trim());
        found.set(element, { ref, rule: "overlap", element, detail: `${Math.round(x)}×${Math.round(h)}px at scroll ${y}` });
      }
    }
  }
  window.scrollTo({ top: original, behavior: "instant" });
  return [...found.values()];
}
