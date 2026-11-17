export { findThemeIssues };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside its function. Theme a person sees
// as broken, read from the styles the browser computed, after Apple's Human Interface Guidelines on dark mode (every
// surface takes the dark appearance) and on accessibility (a focus indicator a person can see), and WCAG 2.2's focus
// visible:
//
//   focus-ring  a control that, given keyboard focus, changes nothing a person can see: no outline, shadow, border,
//               background, colour or underline (its colour or thickness too) on it, any box around it, what is
//               beside it (an overlay that draws its ring) or in it, nor on their ::before or ::after. An outline or
//               shadow in a transparent colour, or 0 wide, counts as none, and so does anything on a part that isn't
//               drawn (see-through, hidden, a pseudo-element with no content). One control of each kind (its tag,
//               id, classes, type, role and inline style), up to `maxControls` kinds a page, each read unfocused first
//               (one that already has focus is blurred), then focused without scrolling; focus goes back where it was
//   dark-miss   on a page whose own background is dark (its dark theme, or a page that is always dark), a surface of
//               `minWidth` × `minHeight` or more still filled a light neutral: an opaque background as light as
//               `light` (relative luminance) or lighter, with no more than `chroma` of colour, the white, grey or cream
//               a light theme fills with. Left out: a control's fill, which is an accent (a light primary button on a
//               dark page is on purpose); a saturated fill, also an accent; a fill in the page's own text colour, an
//               inversion on purpose (a chip in the foreground colour); and a surface drawn over a picture, video or
//               canvas, such as a speech bubble on a comic's art, which is part of the picture. Pictures, video,
//               canvases and frames are their own colours. A page whose own background is light is left alone, in
//               either theme: one with no dark theme at all is a choice, not a miss
//   hero-dark-art a registry Hero whose picture has no night art: a picture in its media frame and no dark twin
//               (`picture={{ light, dark }}`) beside it, so dark mode shows the day scene. Read from the markup, so it
//               is found in either theme; live media (`media`) that is not a picture is left alone
//
// An element opts out of a rule with data-ouro-allow="<rule ids>" and a reason in data-ouro-allow-why, as the other rules
// do. `element` names the element by its words, the same at every size; `detail` says what was read.

interface ThemeOptions {
  maxControls?: number;
  minWidth?: number;
  minHeight?: number;
  light?: number;
  chroma?: number;
}

function findThemeIssues({ maxControls = 60, minWidth = 48, minHeight = 24, light = 0.6, chroma = 0.15 }: ThemeOptions = {}): PageIssue[] {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `t${counter.__ouroCheckRef}`;
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
  const describe = (el: Element) => {
    const words = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}${words ? ` "${words.slice(0, 40)}${words.length > 40 ? "…" : ""}"` : ""}`;
  };
  const drawn = (el: Element) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"], template, details:not([open]) > :not(summary)')) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) <= 0.05) return false;
    }
    return true;
  };
  // Any colour the browser computes (oklch, color-mix, a system colour) as sRGB bytes and an alpha from 0 to 1.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true })!;
  const rgba = (color: string) => {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "#000";
    paint.fillStyle = color;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return { r: r!, g: g!, b: b!, a: a! / 255 };
  };
  const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const hex = ({ r, g, b }: { r: number; g: number; b: number }) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

  // Focus rings.
  const visible = (color: string) => rgba(color).a > 0.05;
  // What a person can see of an element or a pseudo-element. One that isn't drawn (display none, hidden, see-through, a
  // pseudo-element with no content) is just hidden, whatever its ring would be: a ring that only shows up on focus
  // counts, one that never shows doesn't.
  const look = (el: Element, pseudo?: string) => {
    const s = getComputedStyle(el, pseudo);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) <= 0.05 || (pseudo && s.content === "none")) return "hidden";
    const outline = s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0 || !visible(s.outlineColor) ? "none" : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`;
    const shadow = s.boxShadow === "none" || ![...s.boxShadow.matchAll(/(rgba?|oklch|oklab|lab|lch|hsla?|color)\([^)]*\)|#[0-9a-f]+/gi)].some(([color]) => visible(color)) ? "none" : s.boxShadow;
    const borders = ["Top", "Right", "Bottom", "Left"].map((side) => {
      const width = parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const color = s.getPropertyValue(`border-${side.toLowerCase()}-color`);
      return width && visible(color) ? `${width} ${color}` : "none";
    });
    const fill = visible(s.backgroundColor) ? s.backgroundColor : "none";
    return [outline, shadow, ...borders, fill, s.color, s.textDecorationLine === "none" ? "none" : `${s.textDecorationLine} ${s.textDecorationColor} ${s.textDecorationThickness}`, s.backgroundImage, s.opacity, pseudo ? s.content : ""].join("|");
  };
  // Every box around a control: a field's frame, or a card or row that holds a stretched link, often shows its focus
  // (:focus-within, :has(:focus-visible)), however far out it is.
  const around = (el: Element) => {
    const out: Element[] = [];
    for (let n = el.parentElement; n; n = n.parentElement) out.push(n);
    return out;
  };
  const looks = (el: Element) => {
    const inside = [...el.querySelectorAll("*")].slice(0, 12);
    // A ring drawn on an overlay beside the control, which paints over it.
    const beside = [...el.parentElement!.children].filter((n) => n !== el).slice(0, 12);
    return [el, ...around(el), ...beside, ...inside].flatMap((n) => [look(n), look(n, "::before"), look(n, "::after")]).join("\n");
  };
  const settle = (el: Element) => {
    for (const n of [el, ...around(el)]) {
      for (const a of n.getAnimations({ subtree: n === el })) {
        try {
          a.finish();
        } catch {
          // An endless animation has no end to finish at; it is what it is at this frame.
        }
      }
    }
  };
  const focusable = "button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable=''], [contenteditable=true]";
  const was = document.activeElement as HTMLElement | null;
  // One control of a kind: a sidebar's hundred links share one look, so judging one judges them all, and the budget
  // reaches the rest of the page.
  const kinds = new Set<string>();
  for (const el of document.body.querySelectorAll<HTMLElement>(focusable)) {
    if (kinds.size >= maxControls) break;
    if ((el as HTMLButtonElement).disabled || el.closest("fieldset[disabled]") || optedOut(el, "focus-ring") || !drawn(el)) continue;
    const kind = [el.tagName, el.id, el.className, el.getAttribute("type"), el.getAttribute("role"), el.getAttribute("style")].join("|");
    if (kinds.has(kind)) continue;
    kinds.add(kind);
    // Unfocused first, so a control that already has focus (autofocus, say) is read as it looks without it.
    (document.activeElement as HTMLElement).blur();
    settle(el);
    const before = looks(el);
    el.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
    // Focus went elsewhere (the control hands it on) or the browser doesn't show it as keyboard focus: nothing to judge.
    const judged = document.activeElement === el && el.matches(":focus-visible");
    const after = judged ? (settle(el), looks(el)) : before;
    (document.activeElement as HTMLElement).blur();
    if (!judged) continue;
    if (before === after) issues.push({ ref: ref(el), rule: "focus-ring", element: describe(el), detail: "nothing a person can see changes when it gets keyboard focus" });
  }
  // Focus goes back where it was, or nowhere.
  if (was && was !== document.body) was.focus({ preventScroll: true });

  // Heroes with no night art. No allow: every hero has night art.
  for (const hero of document.querySelectorAll('[data-ouro="hero"]')) {
    const frame = hero.querySelector(':scope > [data-ouro-part="media"]');
    const art = frame ? [...frame.children].filter((el) => el.localName === "picture") : [];
    if (!art.length || art.some((el) => el.getAttribute("data-scheme") === "dark")) continue;
    issues.push({ ref: ref(hero), rule: "hero-dark-art", element: describe(hero), detail: "shows its day picture in dark mode too; give it night art with picture={{ light, dark }}" });
  }

  // Dark-mode misses.
  const fillOf = (el: Element | null): { r: number; g: number; b: number; a: number } => {
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c.a >= 0.9) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const page = fillOf(document.body);
  if (luminance(page) >= 0.2) return issues;
  const own = "img, video, canvas, svg, iframe, picture, object, embed";
  const control = "button, a[href], summary, label, select, [role=button], [role=link], [role=tab], [role=switch], [role=option], [role=menuitem], [role=checkbox], [role=radio]";
  const text = rgba(getComputedStyle(document.body).color);
  const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) <= 8;
  // Over a picture: a box around it, up to four out, holds a picture (not inside the surface) that the surface overlaps.
  const onPicture = (el: Element, r: DOMRect) => {
    for (let n = el.parentElement, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      for (const art of n.querySelectorAll(own)) {
        if (el.contains(art)) continue;
        const a = art.getBoundingClientRect();
        if (a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top) return true;
      }
    }
    return false;
  };
  const light_: Element[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.matches(own) || el.closest(own) || light_.some((outer) => outer.contains(el))) continue;
    const s = getComputedStyle(el);
    const c = rgba(s.backgroundColor);
    if (c.a < 0.9 || luminance(c) < light || (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255 > chroma || /url\(/.test(s.backgroundImage) || el.matches(control) || near(c, text)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < minWidth || r.height < minHeight || optedOut(el, "dark-miss") || !drawn(el) || onPicture(el, r)) continue;
    light_.push(el);
    issues.push({ ref: ref(el), rule: "dark-miss", element: describe(el), detail: `filled ${hex(c)} on a dark page filled ${hex(page)}` });
  }
  return issues;
}
