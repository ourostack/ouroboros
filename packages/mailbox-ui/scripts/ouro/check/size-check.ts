export { findSizeIssues };
export type { ImageMeasure, Measure, PageIssue, SizeCheckOptions };

// Runs in the page (page.evaluate), so nothing in it may close over anything outside the function. With
// overlap-check.ts (text on text or on a picture) and axe, run.ts holds pages to these at every size:
//
//   sideways-scroll  the page is wider than the screen; names the outermost elements that stick out
//   clipped-text     a block of text cut off by its own box: overflow, an ellipsis or a line clamp; or a text block or a
//                    picture with less than 90% of its box shown, cut by the nearest ancestor whose overflow is hidden or
//                    clip (not inside a scroll container or a carousel)
//   blurry-image     a raster picture, a video or a raster CSS background drawn larger than its file's own pixels allow
//                    at the screen's density, at most 2: its drawn width × density must not pass its file's width (half
//                    a pixel's slack for rounding). It cannot be waived: an attempt to is itself a finding
//   stretched-image  a raster picture or a video the page draws out of its own shape (object-fit: fill, an <img>'s
//                    default, with a width and a height that don't keep its ratio), by more than 5% and 2px
//   long-lines       only where the project declares a measure (`measures`): an element whose lines run past it
//   narrow-text      prose (p, li, dd, blockquote and [data-ouro=text]) that wraps onto two lines or more, and whose own max-width
//                    (or an ancestor's, below the nearest layout box: a flex or grid box, or main) holds it to under 75% of the
//                    width its parent offers, where that parent is 900px or wider. The max-width must be what holds the box, so
//                    a column or sidebar narrow by its layout passes; so do code, tables, cards, dialogs and text a declared
//                    measure covers. An app declares a measure in the page itself, too: data-ouro-measure on the text or an
//                    element around it, or a max-width read from a --measure-* token (max-width: var(--measure-lede)). A
//                    measure declared there passes at 40ch or wider in the text's own font, and is flagged narrower. A cap on
//                    an element that holds more than prose (headings, pictures, controls) is the page's layout, and passes
//
// An element opts out of a rule with data-ouro-allow="<rule ids>" and data-ouro-allow-why="<reason>"; an allow without
// a reason does not count. For an app whose own rules keep data-ouro-* for Ouro's components, plain aliases do the same,
// each with its reason as its value, and stay: data-scroll-x (sideways-scroll), data-clip-ok (clipped-text),
// data-long-lines-ok (long-lines) and data-size-ignore (sideways-scroll, clipped-text, long-lines and stretched-image). A
// picture too small for where it is drawn is never let through, and a broken picture is broken at any size, so neither is
// ever ignored.
// `element` names the element the same way at every size, so a sweep can say where it shows; `detail` has this size's
// numbers; `ref` marks it (data-ouro-check-ref) so the runner can photograph it.

interface PageIssue {
  ref: string;
  rule: string;
  element: string;
  detail: string;
  // A measured rule's number, its budget and their unit ("ms", or "" for a score).
  value?: number;
  budget?: number;
  unit?: string;
  samples?: number[];
  image?: ImageMeasure;
  // first-paint-swap's two controls, each as its first frame drew it and as it is at rest (null: it left the page).
  swap?: { gone: { first: string; rest: string | null }; taker: { first: string; rest: string } };
}

// A blurry picture's numbers, for a report a person or a tool can make larger art from: where it is (a CSS selector),
// the file it drew (currentSrc), the file's own pixels, the box it is drawn in (CSS pixels), the density, and the
// width the file needs to be.
interface ImageMeasure {
  selector: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  density: number;
  requiredWidth: number;
}

// A declared measure: the elements it holds (a CSS selector, or null for the page's prose: p, li, dd, blockquote,
// figcaption and [data-prose]) and how long a line may run: "800px", "75ch" (the width of 75 zeros in the element's
// font), or "100 chars" (characters a rendered line holds on average, counted from the text).
interface Measure {
  selector: string | null;
  measure: string;
}

interface SizeCheckOptions {
  measures?: Measure[];
  density?: number;
  tolerance?: number;
  minImage?: number;
  stretch?: number;
}

async function findSizeIssues({ measures = [], density = Math.min(2, window.devicePixelRatio), tolerance = 1, minImage = 96, stretch = 0.05 }: SizeCheckOptions = {}): Promise<PageIssue[]> {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `s${counter.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${id}`.trim());
    return id;
  };
  // Whether an element, or one around it, opts out of `rule`: data-ouro-allow with a reason in data-ouro-allow-why, or
  // one of `aliases` with its reason as its value. A reason of spaces is no reason; the page's attributes are read, never
  // rewritten.
  const reasonOf = (el: Element, name: string) => (el.getAttribute(name) ?? "").trim();
  const optedOut = (el: Element, rule: string, aliases: string[]) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = reasonOf(n, "data-ouro-allow").split(/\s+/);
      if (aliases.some((name) => reasonOf(n!, name)) || ((rules.includes(rule) || rules.includes("all")) && reasonOf(n, "data-ouro-allow-why"))) return true;
    }
    return false;
  };
  const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}`;
  // The text as written, not as drawn (innerText): a line clamp or a narrow box would name the element differently at
  // each size.
  const words = (el: Element) => (el.getAttribute("aria-label") || el.getAttribute("alt") || el.textContent || "").trim().replace(/\s+/g, " ");
  const quoted = (el: Element) => {
    const w = words(el);
    return w ? ` "${w.slice(0, 40)}${w.length > 40 ? "…" : ""}"` : "";
  };
  const shown = (el: Element) => {
    if (el.closest("[hidden], template, .visually-hidden, .sr-only")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) <= 0.05) return false;
    }
    return true;
  };
  // A path a person can paste into the console: the nearest id, else the body, then each tag in turn.
  const selectorOf = (el: Element) => {
    const parts: string[] = [];
    for (let n = el; ; n = n.parentElement!) {
      if (n.id) return [`#${CSS.escape(n.id)}`, ...parts].join(" > ");
      if (n === document.body) return ["body", ...parts].join(" > ");
      const same = [...n.parentElement!.children].filter((c) => c.localName === n.localName);
      parts.unshift(same.length > 1 ? `${n.localName}:nth-of-type(${same.indexOf(n) + 1})` : n.localName);
    }
  };
  const inlineOnly = (el: Element) => [...el.children].every((c) => /^inline|^contents$/.test(getComputedStyle(c).display) || c.matches("br, wbr"));
  // A text block's rendered lines: the boxes at one height, unless a gap wider than three quarters of a font size parts
  // them, as columns side by side do.
  const rowsOf = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const boxes = [...range.getClientRects()].filter((b) => b.width > 1).sort((a, b) => a.top - b.top || a.left - b.left);
    const gap = parseFloat(getComputedStyle(el).fontSize) * 0.75;
    const rows: { top: number; left: number; right: number }[] = [];
    for (const b of boxes) {
      const row = rows.findLast((row) => row.top === Math.round(b.top) && b.left <= row.right + gap);
      if (row) [row.left, row.right] = [Math.min(row.left, b.left), Math.max(row.right, b.right)];
      else rows.push({ top: Math.round(b.top), left: b.left, right: b.right });
    }
    return rows;
  };

  // Sideways scrolling.
  const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const sideways = (el: Element) => optedOut(el, "sideways-scroll", ["data-scroll-x", "data-size-ignore"]);
  if (over > 1 && !sideways(document.body)) {
    const edge = document.documentElement.clientWidth + 1;
    const out = [...document.body.querySelectorAll("*")].filter((el) => !sideways(el) && shown(el) && el.getBoundingClientRect().right > edge);
    const outermost = out.filter((el) => !out.some((o) => o !== el && o.contains(el))).slice(0, 3);
    issues.push({ ref: ref(outermost[0] ?? document.body), rule: "sideways-scroll", element: outermost.map(describe).join(", ") || "the page", detail: `${over}px wider than the screen` });
  }

  // Clipped text.
  // Text hidden from assistive technology by the page: under aria-hidden that no open modal set. Text a modal hides is the
  // page behind it, whose findings run.ts leaves to the page's own run (behindModal).
  const modals = [...document.querySelectorAll('[aria-modal="true"], dialog:modal')].filter((m) => m.getClientRects().length);
  const unreachable = (el: Element) => {
    const hidden = el.closest('[aria-hidden="true"]');
    return Boolean(hidden) && !modals.some((m) => !m.contains(el) && !hidden!.contains(m));
  };
  // Text fading out to nothing is leaving the page: a running animation or transition on it, or on an element around it,
  // ends at no opacity. A page whose words change while the rules run (a line that ticks over) is caught part way through
  // such a fade, and the line on its way out is no text a person reads.
  const leaving = (el: Element) => {
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      for (const animation of n.getAnimations()) {
        if (animation.playState !== "running") continue;
        // Every animation getAnimations returns runs a keyframe effect, with its keyframes.
        const last = (animation.effect as KeyframeEffect).getKeyframes().at(-1)!;
        if (last["opacity"] !== undefined && Number(last["opacity"]) <= 0.05) return true;
      }
    }
    return false;
  };
  // What this pass reports, so the box-cut pass below does not report an element twice.
  const cutOwn = new Set<Element>();
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("svg, select, textarea, script, style") || optedOut(el, "clipped-text", ["data-clip-ok", "data-size-ignore"])) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) || !inlineOnly(el)) continue;
    const s = getComputedStyle(el);
    const clipsX = /hidden|clip/.test(s.overflowX);
    const clipsY = /hidden|clip/.test(s.overflowY);
    const clamp = s.getPropertyValue("-webkit-line-clamp");
    const clamped = clamp !== "" && clamp !== "none";
    if ((!clipsX && !clipsY && !clamped) || !shown(el) || leaving(el)) continue;
    const cutX = clipsX && el.scrollWidth > el.clientWidth + 1;
    const cutY = (clipsY || clamped) && el.scrollHeight > el.clientHeight + 2;
    // Truncation on purpose (an ellipsis or a line clamp) passes when the whole text is still there for a person who
    // asks: in a title, an aria-label, or the text itself in the accessibility tree.
    const whole = el.textContent!.trim().replace(/\s+/g, " ");
    const told = [el.getAttribute("title"), el.getAttribute("aria-label")].some((text) => text?.trim().replace(/\s+/g, " ").includes(whole));
    const intended = (s.textOverflow === "ellipsis" || clamped) && (told || !unreachable(el));
    if ((cutX || cutY) && !intended) {
      cutOwn.add(el);
      issues.push({
        ref: ref(el),
        rule: "clipped-text",
        element: `${describe(el)}${quoted(el)}`,
        detail: cutX ? `${el.scrollWidth - el.clientWidth}px cut across${s.textOverflow === "ellipsis" ? " (ellipsis)" : ""}` : `${el.scrollHeight - el.clientHeight}px cut below${clamped ? " (line clamp)" : ""}`,
      });
    }
  }

  // Cut by an ancestor's box. The pass above reads only text that overflows its own box, so a title, a paragraph or a
  // picture pushed partly out of a card that hides its overflow went unread. Each is measured against the box that cuts it.
  // A scroll container between the element and that box scrolls the content rather than cuts it, and a box that is
  // position: fixed escapes an ancestor's overflow, so neither is judged. A scroll container is one
  // whose overflow is auto or scroll and that really overflows: a box hidden on one axis computes auto on the other. The
  // box is measured, not what is drawn in it, so object-fit cropping a picture inside a box that fits it is no finding.
  const blocks = 'h1, h2, h3, h4, h5, h6, p, li, img, picture, figcaption, [data-ouro="text"]';
  const scrollers = '[data-ouro-scroll], [role=carousel], [aria-roledescription="carousel" i]';
  const scrolls = (n: Element) => {
    const s = getComputedStyle(n);
    return (/auto|scroll/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1) || (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1);
  };
  // A clipping ancestor is the nearest one whose overflow is not visible on an axis, and that does not scroll: a box
  // hidden on one axis computes auto on the other, which cuts whatever lies outside it all the same.
  const clipperOf = (el: Element) => {
    for (let n: Element | null = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.matches(scrollers) || scrolls(n)) return null;
      const s = getComputedStyle(n);
      const x = s.overflowX !== "visible";
      const y = s.overflowY !== "visible";
      if (x || y) return { box: n, x, y };
    }
    return null;
  };
  const insetHidden = (el: Element) => {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) if (/inset\(50%\)/.test(getComputedStyle(n).clipPath)) return true;
    return false;
  };
  // A picture is named by its image's alt text.
  const named = (el: Element) => {
    const text = words(el.localName === "picture" ? (el.querySelector("img") ?? el) : el);
    return text ? ` "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"` : "";
  };
  const cutOff: { el: Element; detail: string }[] = [];
  for (const el of document.body.querySelectorAll(blocks)) {
    if (el.closest("svg, select, textarea, script, style") || !shown(el) || el.matches(scrollers) || getComputedStyle(el).position === "fixed") continue;
    if (cutOwn.has(el) || insetHidden(el) || optedOut(el, "clipped-text", ["data-clip-ok", "data-size-ignore"])) continue;
    const clip = clipperOf(el);
    if (!clip) continue;
    const r = el.getBoundingClientRect();
    const c = clip.box.getBoundingClientRect();
    const width = clip.x ? Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)) : r.width;
    const height = clip.y ? Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)) : r.height;
    if ((width * height) / (r.width * r.height) >= 0.9) continue;
    const byHeight = height / r.height <= width / r.width;
    const detail = byHeight ? `shown ${Math.round(height)}px/${Math.round(r.height)}px` : `shown ${Math.round(width)}px/${Math.round(r.width)}px`;
    cutOff.push({ el, detail });
  }
  // The outermost of each nest that is cut: a list item and the paragraph in it are one finding.
  const cutElements = cutOff.map(({ el }) => el);
  for (const { el, detail } of cutOff.filter(({ el }) => !cutElements.some((other) => other !== el && other.contains(el)))) {
    issues.push({ ref: ref(el), rule: "clipped-text", element: `${describe(el)}${named(el)}`, detail });
  }

  // Blurry pictures. Missing pixels are never a design choice, so no allow lets one through: an element that tries is a
  // finding of its own, which names the fix.
  for (const el of document.querySelectorAll("[data-ouro-allow]")) {
    if (!reasonOf(el, "data-ouro-allow").split(/\s+/).includes("blurry-image")) continue;
    issues.push({
      ref: ref(el),
      rule: "blurry-image",
      element: `${describe(el)}${quoted(el)} [data-ouro-allow="${reasonOf(el, "data-ouro-allow")}"]`,
      detail: "blurry-image cannot be waived: remove it from data-ouro-allow and give the picture a larger source, or a srcset whose largest file covers its drawn width at 2x",
    });
  }
  // The finding for a picture whose file is `pw`×`ph` drawn at `scale` (CSS pixels a file pixel) in a box `r`, when the
  // file is narrower than the drawn width at the density. Half a pixel is layout's rounding.
  const blur = (el: Element, src: string, [pw, ph]: [number, number], scale: number, r: DOMRect, element: string, kind: string) => {
    const need = pw * scale * density;
    if (need <= pw * tolerance + 0.5) return;
    const requiredWidth = Math.ceil(need);
    issues.push({
      ref: ref(el),
      rule: "blurry-image",
      element,
      detail: `${kind}drawn ${Math.round(r.width)}×${Math.round(r.height)} from ${pw}×${ph}${kind === "a video " ? " frames" : ""}; at ${density}x it needs ${requiredWidth}px wide`,
      image: { selector: selectorOf(el), src, naturalWidth: pw, naturalHeight: ph, renderedWidth: Math.round(r.width), renderedHeight: Math.round(r.height), density, requiredWidth },
    });
  };
  // naturalWidth is in CSS pixels, divided by the srcset density the browser chose, so the file's own
  // pixels come from loading the chosen source into an Image of its own.
  // By its path's last two folders, never its host: a run's local server has a new port each time. A data: or blob:
  // picture has no lasting address, so it goes by its name.
  // A picture drawn out of its own shape: by its height against the height its width calls for, so a rounding of a
  // pixel or two on a small picture isn't a stretch. Measured on its content box, as laid out: padding and a border
  // aren't the picture, and a rotation turns the shape without changing it.
  const stretched = (el: HTMLElement, fit: string, [pw, ph]: [number, number], what: string) => {
    const s = getComputedStyle(el);
    const w = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    const h = el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
    const keeps = (w * ph) / pw;
    if (fit !== "fill" || optedOut(el, "stretched-image", ["data-size-ignore"]) || Math.abs(h - keeps) <= Math.max(2, keeps * stretch)) return;
    const by = Math.round((Math.max(h / keeps, keeps / h) - 1) * 100);
    issues.push({ ref: ref(el), rule: "stretched-image", element: what, detail: `${el.localName === "video" ? "a video " : ""}drawn ${Math.round(w)}×${Math.round(h)} from ${pw}×${ph}${el.localName === "video" ? " frames" : ""}, ${by}% ${h > keeps ? "taller" : "wider"} than its own shape` });
  };
  const nameOf = (img: Element, src: string) => (/^(data|blob):/.test(src) ? `img${quoted(img)}` : new URL(src).pathname.split("/").filter(Boolean).slice(-2).join("/"));
  for (const img of document.images) {
    const src = img.currentSrc || img.src;
    // Loaded and empty: the file is missing or is no picture. (An SVG without a size of its own is empty too, so it is
    // left out.)
    if (src && img.complete && !img.naturalWidth && !/\.svg(\?|#|$)|^data:image\/svg/.test(src) && !optedOut(img, "broken-image", [])) {
      issues.push({ ref: ref(img), rule: "broken-image", element: nameOf(img, src), detail: "the picture did not load" });
      continue;
    }
    if (!img.naturalWidth || /\.svg(\?|#|$)|^data:image\/svg/.test(src) || !shown(img)) continue;
    const r = img.getBoundingClientRect();
    const fit = getComputedStyle(img).objectFit;
    const file = new Image();
    file.src = src;
    await file.decode().catch(() => undefined);
    const pw = file.naturalWidth || img.naturalWidth;
    const ph = file.naturalHeight || img.naturalHeight;
    stretched(img, fit, [pw, ph], nameOf(img, src));
    if (r.width < minImage && r.height < minImage) continue;
    const sx = r.width / pw;
    const sy = r.height / ph;
    const scale = fit === "contain" || fit === "scale-down" ? Math.min(sx, sy) : fit === "none" ? 1 : Math.max(sx, sy);
    blur(img, src, [pw, ph], scale, r, nameOf(img, src), "");
  }

  // Blurry videos: a video's frames are videoWidth × videoHeight pixels, drawn by object-fit (contain unless the page says
  // otherwise). A video that has not loaded its size (preload="none", say) is asked for it on a video of its own, which
  // loads only the metadata; one that gives no size in 3 s is left out.
  for (const video of document.querySelectorAll("video")) {
    if (!shown(video)) continue;
    const r = video.getBoundingClientRect();
    const fit = getComputedStyle(video).objectFit;
    // Asking a video for its size can take seconds, so only one a rule could find something on is asked.
    const blurry = r.width >= minImage || r.height >= minImage;
    if (!blurry && (fit !== "fill" || optedOut(video, "stretched-image", ["data-size-ignore"]))) continue;
    const src = video.currentSrc || video.src || video.querySelector("source")?.src || "";
    let [pw, ph] = [video.videoWidth, video.videoHeight];
    if (!pw && src) {
      const probe = document.createElement("video");
      probe.muted = true;
      probe.preload = "metadata";
      probe.src = src;
      await Promise.race([new Promise((done) => probe.addEventListener("loadedmetadata", done, { once: true })), new Promise((done) => setTimeout(done, 3000))]);
      [pw, ph] = [probe.videoWidth, probe.videoHeight];
      probe.removeAttribute("src");
    }
    if (!pw) continue;
    const name = /^(data|blob):/.test(src) || !src ? `video${quoted(video)}` : nameOf(video, src);
    stretched(video, fit, [pw, ph], name);
    if (!blurry) continue;
    const [sx, sy] = [r.width / pw, r.height / ph];
    const scale = fit === "none" ? 1 : fit === "cover" || fit === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
    blur(video, src, [pw, ph], scale, r, name, "a video ");
  }

  // Blurry backgrounds: each raster url() layer of an element's background-image (in an image-set, its finest file), drawn
  // as its background-size says in the element's padding box. SVG and gradients have no pixels to run out of.
  const layers = (text: string) => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      else if (text[i] === "," && !depth) {
        out.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    return [...out, text.slice(start).trim()];
  };
  const length = (value: string, whole: number) => (value === "auto" ? null : value.endsWith("%") ? (parseFloat(value) / 100) * whole : parseFloat(value));
  for (const el of document.body.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    if (!s.backgroundImage.includes("url(") || !shown(el)) continue;
    const sizes = layers(s.backgroundSize);
    const r = el.getBoundingClientRect();
    const [bw, bh] = [el.clientWidth || r.width, el.clientHeight || r.height];
    const all = layers(s.backgroundImage);
    for (const [i, layer] of all.entries()) {
      // The file and the density it is drawn at: url("…") is 1x; image-set(url("…") 2x, …) is its finest.
      const files = [...layer.matchAll(/url\("((?:[^"\\]|\\.)*)"\)\s*(?:([\d.]+)(?:x|dppx))?/g)].map(([, url, res]) => ({ url: url!.replace(/\\(.)/g, "$1"), res: Number(res ?? 1) }));
      const best = files.sort((a, b) => b.res - a.res)[0];
      if (!best || /\.svg(\?|#|$)|^data:image\/svg/.test(best.url)) continue;
      const file = new Image();
      file.src = best.url;
      const loaded = await file.decode().then(() => true, () => false);
      if (!loaded) continue;
      const [pw, ph] = [file.naturalWidth, file.naturalHeight];
      const [iw, ih] = [pw / best.res, ph / best.res];
      const size = sizes[i % sizes.length]!;
      let dw: number, dh: number;
      if (size === "cover" || size === "contain") {
        const k = (size === "cover" ? Math.max : Math.min)(bw / iw, bh / ih);
        [dw, dh] = [iw * k, ih * k];
      } else {
        const [x, y = "auto"] = size.split(/\s+/);
        const [w, h] = [length(x!, bw), length(y, bh)];
        [dw, dh] = w === null && h === null ? [iw, ih] : w === null ? [(h! * iw) / ih, h!] : h === null ? [w, (w * ih) / iw] : [w, h];
      }
      if (dw < minImage && dh < minImage) continue;
      const name = /^(data|blob):/.test(best.url) ? `${describe(el)}${quoted(el)} background` : `${nameOf(el, best.url)} (background)`;
      blur(el, best.url, [pw, ph], Math.max(dw / pw, dh / ph), new DOMRect(0, 0, dw, dh), name, "a background ");
    }
  }

  // Long lines, only against a measure the project declared: none is assumed, since a fixed measure is a design choice,
  // not a default. An element two measures hold is checked against the first.
  const checked = new Set<Element>();
  for (const { selector, measure } of measures) {
    const [, amount, unit] = /^(\d+(?:\.\d+)?)\s*(px|ch|chars)$/.exec(measure.trim())!;
    const limit = Number(amount);
    for (const el of document.body.querySelectorAll(selector ?? "p, li, dd, blockquote, figcaption, [data-prose]")) {
      if (checked.has(el)) continue;
      checked.add(el);
      // The page's prose leaves out code, tables, navigation and blocks of blocks; a selector holds exactly what it names,
      // a container of paragraphs included.
      const prose = selector === null;
      if ((prose && (el.closest("pre, code, table, nav") || !inlineOnly(el))) || optedOut(el, "long-lines", ["data-long-lines-ok", "data-size-ignore"]) || !shown(el)) continue;
      const text = el.textContent!.replace(/\s+/g, " ").trim();
      // A run of short items set apart by middle dots, bullets or bars (counts, tags, a byline) is a list, not prose.
      const items = text.split(/\s[·•|]\s/);
      if (items.length >= 3 && items.every((item) => item.length <= 40)) continue;
      const rows = rowsOf(el);
      if (unit === "chars") {
        // As a reader meets it: the characters a rendered line holds on average, fixed by how the text is composed.
        const perLine = text.length / Math.max(1, rows.length);
        if (perLine > limit) issues.push({ ref: ref(el), rule: "long-lines", element: `${describe(el)}${quoted(el)}`, detail: `about ${Math.round(perLine)} characters a line (keep to ${limit})` });
        continue;
      }
      const context = document.createElement("canvas").getContext("2d")!;
      // From its parts: the font shorthand reads empty once a font feature or variant is set, and the canvas would
      // keep its own 10px font.
      const s = getComputedStyle(el);
      context.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const px = unit === "px" ? limit : limit * context.measureText("0").width;
      const widest = Math.max(0, ...rows.map((row) => row.right - row.left));
      if (widest > px + 1) issues.push({ ref: ref(el), rule: "long-lines", element: `${describe(el)}${quoted(el)}`, detail: `lines up to ${Math.round(widest)}px wide (measure ${measure.trim()})` });
    }
  }
  // Narrow text: prose that wraps, held by a max-width that binds it to under three quarters of the width its parent offers.
  // The walk stops at a layout box (a flex or grid box, or main), so a cap on the page's own column is the layout's, and a
  // cap on a block inside it is the reading measure this rule is for. A declared measure that covers the text, and an opt-out
  // with a reason, leave it alone, as do the containers the rule excludes.
  const narrowExcluded = "pre, code, table, nav, aside, dialog, [role=dialog], [data-ouro=card], [data-ouro=sheet], [data-ouro=popover], td, th";
  const layoutBox = (el: Element) => el.localName === "main" || el.getAttribute("role") === "main" || /(inline-)?(flex|grid)$/.test(getComputedStyle(el).display);
  const contentWidth = (el: Element) => {
    const s = getComputedStyle(el);
    return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  };
  // The width the parent offers an element, when its own max-width is what holds the element: the element is narrower than
  // its parent by more than a pixel, and as wide as its max-width allows. A width or a layout that sets it narrower is not a cap.
  const cappedBy = (el: Element): number | null => {
    const s = getComputedStyle(el);
    if (s.maxWidth === "none" || !el.parentElement) return null;
    const offered = contentWidth(el.parentElement);
    const width = el.getBoundingClientRect().width;
    if (offered - width <= 1) return null;
    const max = s.maxWidth;
    const px = max.endsWith("%") ? (parseFloat(max) / 100) * offered : max.endsWith("px") ? parseFloat(max) : NaN;
    const edges = s.boxSizing === "content-box" ? parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) + parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth) : 0;
    if (!Number.isNaN(px) && width < px + edges - 1) return null;
    return offered;
  };
  // The rule that set a cap, best effort: the element's own style first (it wins the cascade), else the last stylesheet rule
  // that matches it under a media query that holds. A cross-origin sheet has no rules a script may read, so it is skipped.
  const capSource = (el: Element): { text: string; value: string } => {
    const inline = (el as HTMLElement).style?.maxWidth;
    if (inline) return { text: `style="max-width: ${inline}" on ${describe(el)}`, value: inline };
    let found: { text: string; value: string } | null = null;
    const matches = (selector: string) => {
      try {
        return el.matches(selector);
      } catch /* istanbul ignore next @preserve -- no selector a stylesheet accepts is known to make matches() throw; a guard so one never stops the check */ {
        return false;
      }
    };
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          if (rule.style.maxWidth && matches(rule.selectorText)) found = { text: `${rule.selectorText} { max-width: ${rule.style.maxWidth} }`, value: rule.style.maxWidth };
        } else if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.media.mediaText).matches) visit(rule.cssRules);
        } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        // A sheet it can't read.
      }
    }
    return found ?? { text: `max-width: ${Math.round(parseFloat(getComputedStyle(el).maxWidth))}px on ${describe(el)}`, value: "" };
  };
  // A measure the page declares for the text: data-ouro-measure on it or around it, or a cap read from a --measure-* token.
  const measureToken = /var\(\s*--measure-/;
  const pageMeasure = (el: Element, source: { value: string }) => el.closest("[data-ouro-measure]") !== null || measureToken.test(source.value);
  // 40ch in the text's own font: the narrowest declared measure the rule accepts, the short end of a readable line.
  const minMeasure = 40;
  const chWidth = (el: Element) => {
    const probe = document.createElement("span");
    probe.style.cssText = `display:inline-block;width:${minMeasure}ch;padding:0;border:0;margin:0`;
    el.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  };
  // An element around the text caps it as a reading measure only when it holds nothing but prose; one that holds headings,
  // pictures, controls or other blocks is the page's layout (a centred page column), however wide the screen.
  const proseTags = new Set(["p", "li", "ul", "ol", "dl", "dt", "dd", "blockquote", "span", "a", "strong", "em", "b", "i", "code", "small", "br", "abbr", "time", "mark", "sub", "sup", "kbd", "s", "u", "q", "cite", "wbr"]);
  const holdsOnlyProse = (box: Element) => [...box.querySelectorAll("*")].every((n) => proseTags.has(n.localName));
  const declared = (el: Element) => measures.some(({ selector }) => selector === null || el.closest(selector) !== null);
  const narrowCapped = new Set<Element>();
  for (const el of document.body.querySelectorAll("p, li, dd, blockquote, [data-ouro=text]")) {
    if (el.closest(narrowExcluded) || !shown(el) || !inlineOnly(el) || declared(el) || optedOut(el, "narrow-text", [])) continue;
    if (getComputedStyle(el).textAlign === "center" || rowsOf(el).length < 2) continue;
    let cap: { el: Element; offered: number } | null = null;
    for (let n: Element | null = el; n && n !== document.body && !layoutBox(n); n = n.parentElement) {
      const offered = cappedBy(n);
      if (offered !== null) {
        if (n === el || holdsOnlyProse(n)) cap = { el: n, offered };
        break;
      }
    }
    if (!cap || cap.offered < 900 || cap.el.getBoundingClientRect().width >= 0.75 * cap.offered || narrowCapped.has(cap.el)) continue;
    const source = capSource(cap.el);
    const capWidth = cap.el.getBoundingClientRect().width;
    const declaredHere = pageMeasure(el, source);
    if (declaredHere && capWidth >= chWidth(el) - 1) continue;
    // One finding per capped element: a container that caps several paragraphs is named by the first.
    narrowCapped.add(cap.el);
    const width = Math.round(capWidth);
    const kind = el.localName === "p" ? "paragraph" : el.localName === "li" ? "list item" : "text";
    issues.push({
      ref: ref(el),
      rule: "narrow-text",
      element: `${describe(el)}${quoted(el)}`,
      detail: declaredHere
        ? `This ${kind}'s declared measure, \`${source.text}\`, holds it to ${width}px, under ${minMeasure}ch in its font, too narrow to read comfortably. Widen the measure to ${minMeasure}ch or more, or remove it so the text uses its ${Math.round(cap.offered)}px column.`
        : `This ${kind} wraps at ${width}px in a ${Math.round(cap.offered)}px column, leaving the rest empty. Let it use the width it has: remove \`${source.text}\`. If the design sets a measure on purpose, declare it at ${minMeasure}ch or wider: read the max-width from a --measure-* token, add data-ouro-measure to the text, or set "measure" in ouro-check.json.`,
    });
  }
  return issues;
}

