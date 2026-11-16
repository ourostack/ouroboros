export { findImageFades };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside the function. check.ts holds pages
// to it at every size:
//
//   image-fade  a picture that fades into the page: an <img>, an SVG <image> or an element with a url() background
//               whose own box or a box around it has a gradient mask that fades it (a linear mask is read along its line,
//               so only a picture in a band where it isn't opaque counts), or that a gradient between transparent and a
//               colour covers, a tenth of it or more: an absolutely positioned element over it, or an absolutely
//               positioned ::before or ::after of the picture or of a box around it, or a gradient layered over its own
//               url() background. A radial or conic gradient counts
//               only when it is opaque at its outer edge, as a vignette is: a glow that fades out adds light, and stays.
//               A picture ends on a hard edge, or sits on a solid band.
//
// A picture opts out with data-ouro-allow="image-fade" and data-ouro-allow-why="<reason>", or the plain alias
// data-image-fade-ok="<reason>", on itself or a box around it, and an overlay does on itself; an allow without a reason
// does not count.

function findImageFades(): PageIssue[] {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `f${counter.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${id}`.trim());
    return id;
  };
  // Read, never rewritten; a reason of spaces is no reason.
  const reasonOf = (el: Element, name: string) => (el.getAttribute(name) ?? "").trim();
  const optedOut = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = reasonOf(n, "data-ouro-allow").split(/\s+/);
      if (reasonOf(n, "data-image-fade-ok") || ((rules.includes("image-fade") || rules.includes("all")) && reasonOf(n, "data-ouro-allow-why"))) return true;
    }
    return false;
  };
  const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}`;
  const shown = (el: Element) => {
    if (el.closest("[hidden], template")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) <= 0.05) return false;
    }
    return true;
  };
  // Whether a background fades what is under it into the page: a gradient between a fully transparent stop and one
  // that is not, however the browser writes the colour (`transparent`, rgba(…, 0) or a colour function's `/ 0`). A
  // linear gradient does at whichever end is opaque; a radial or conic one only when its outer stop is opaque, as a
  // vignette is, and not when it fades out, as a glow of light does.
  const fadesOut = (image: string) => {
    for (const [, kind, inner] of image.matchAll(/(linear|radial|conic)-gradient\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)) {
      const stops = inner!.split(/,(?![^()]*\))/).filter((part) => /transparent|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|#[\da-f]/i.test(part));
      const clear = stops.map((stop) => /transparent|rgba\([^()]*,\s*0(?:\.0*)?\s*\)|\/\s*0(?:\.0*)?%?\s*\)/.test(stop));
      if (clear.includes(true) && clear.includes(false) && (kind === "linear" || !clear.at(-1))) return true;
    }
    return false;
  };
  // A list of a CSS function's arguments, split at its top-level commas.
  const argsOf = (inner: string) => {
    const parts = [""];
    let depth = 0;
    for (const c of inner) {
      depth += c === "(" ? 1 : c === ")" ? -1 : 0;
      if (c === "," && depth === 0) parts.push("");
      else parts[parts.length - 1] += c;
    }
    return parts.map((part) => part.trim());
  };
  // A gradient stop's place as px along a line `whole` px long, as the browser computes it: px, %, viewport units, and calc(),
  // min(), max() and clamp() of them (the browser has already turned rem and em into px, and simplified the arithmetic).
  // NaN for anything else.
  const lengthOf = (text: string, whole: number): number => {
    const tokens = text.match(/[a-z]+\(|[\d.]+[a-z%]*|\S/g)!;
    let at = 0;
    const sum = (): number => {
      let value = term();
      while (tokens[at] === "+" || tokens[at] === "-") value = tokens[at++] === "+" ? value + term() : value - term();
      return value;
    };
    const term = (): number => {
      const token = tokens[at++]!;
      if (token === "-") return -term();
      const call = /^(calc|min|max|clamp)\($/.exec(token);
      if (call) {
        const values = [sum()];
        while (tokens[at] === ",") {
          at++;
          values.push(sum());
        }
        at++;
        return call[1] === "min" ? Math.min(...values) : call[1] === "max" ? Math.max(...values) : call[1] === "clamp" ? Math.max(values[0]!, Math.min(values[1]!, values[2]!)) : values[0]!;
      }
      // A number and its unit; a unit it doesn't know (or no number at all) reads as NaN.
      const [, number, unit] = /^([\d.]*)(.*)$/.exec(token)!;
      const [w, h] = [innerWidth / 100, innerHeight / 100];
      const units: Record<string, number> = { px: 1, "%": whole / 100, vw: w, svw: w, lvw: w, dvw: w, vh: h, svh: h, lvh: h, dvh: h, vmin: Math.min(w, h), vmax: Math.max(w, h) };
      return Number(number) * units[unit!]!;
    };
    return sum();
  };
  // Whether a radial layer's arguments cut a shape out of the picture (a bite or a hole): it is clear first and opaque
  // for the rest, and turns from one to the other within 2px, so no edge of the picture dissolves.
  const cutsHole = (args: string[], whole: number) => {
    const stops = args.map((part) => /^rgba?\(([^)]*)\)\s+(\S.*)$/.exec(part)).filter((stop) => stop !== null);
    if (stops.length !== 2) return false;
    const alphas = stops.map((stop) => (stop[1]!.split(",").length === 4 ? Number(stop[1]!.split(",")[3]) : 1));
    return alphas[1]! - alphas[0]! >= 0.99 && lengthOf(stops[1]![2]!, whole) - lengthOf(stops[0]![2]!, whole) <= 2;
  };
  // Whether the gradient mask on `el` fades any of `picture`. Each linear layer is read along its line (to a side, or a
  // right angle) for the bands where it is not opaque, inside `el`'s box; a band of no width fades nothing. A mask it
  // can't read so (radial, diagonal, sized or placed) fades all of it.
  const maskFades = (el: Element, picture: DOMRect) => {
    const s = getComputedStyle(el);
    // Unprefixed: a browser that knows the -webkit- names reports these too.
    const read = (name: string) => s.getPropertyValue(name);
    if (!/^auto( auto)?(, auto( auto)?)*$/.test(read("mask-size")) || !/^0% 0%(, 0% 0%)*$/.test(read("mask-position"))) return true;
    const box = el.getBoundingClientRect();
    for (const layer of argsOf(read("mask-image"))) {
      const radial = /^radial-gradient\((.*)\)$/.exec(layer);
      if (radial && cutsHole(argsOf(radial[1]!), Math.max(box.width, box.height))) continue;
      const linear = /^linear-gradient\((.*)\)$/.exec(layer);
      if (!linear) return true;
      const parts = argsOf(linear[1]!);
      const way = /^(?:to ([a-z ]+)|(-?[\d.]+)deg)$/.exec(parts[0]!);
      const angle = !way ? 180 : way[2] ? ((Number(way[2]) % 360) + 360) % 360 : ({ top: 0, right: 90, bottom: 180, left: 270 } as Record<string, number>)[way[1]!] ?? 45;
      if (way) parts.shift();
      if (angle % 90) return true;
      const whole = angle % 180 ? box.width : box.height;
      // The picture's span along the line, from where the line starts.
      const span = { 0: [box.bottom - picture.bottom, box.bottom - picture.top], 90: [picture.left - box.left, picture.right - box.left], 180: [picture.top - box.top, picture.bottom - box.top], 270: [box.right - picture.right, box.right - picture.left] }[angle]!;
      // Each stop's alpha (an rgba or a colour function's "/ a"; rgb is opaque) and places: none, one or two; a stop
      // without one sits evenly between its neighbours, the first at the start and the last at the end.
      const stops: { alpha: number; at: number }[] = [];
      for (const part of parts) {
        const [, colour, places] = /^([a-z-]+\([^()]*\))\s*(.*)$/.exec(part)!;
        const alpha = /\/|^rgba/.test(colour!) ? Number(colour!.slice(0, -1).split(/[\s,/]+/).at(-1)) : 1;
        const at = argsOf(places!.replace(/\s+(?![^()]*\))/g, ",")).filter(Boolean).map((place) => lengthOf(place, whole));
        if (at.some(Number.isNaN)) return true;
        for (const place of at.length ? at : [NaN]) stops.push({ alpha, at: place });
      }
      if (Number.isNaN(stops[0]!.at)) stops[0]!.at = 0;
      if (Number.isNaN(stops.at(-1)!.at)) stops.at(-1)!.at = whole;
      for (let i = 1; i < stops.length; i++) {
        if (Number.isNaN(stops[i]!.at)) {
          const next = stops.findIndex((stop, j) => j > i && !Number.isNaN(stop.at));
          stops[i]!.at = stops[i - 1]!.at + (stops[next]!.at - stops[i - 1]!.at) / (next - i + 1);
        }
        stops[i]!.at = Math.max(stops[i]!.at, stops[i - 1]!.at);
      }
      // The bands it is not opaque in: before the first stop, between two, and after the last.
      const bands: [number, number, number][] = [[-Infinity, stops[0]!.at, stops[0]!.alpha], [stops.at(-1)!.at, Infinity, stops.at(-1)!.alpha]];
      for (let i = 1; i < stops.length; i++) bands.push([stops[i - 1]!.at, stops[i]!.at, Math.min(stops[i - 1]!.alpha, stops[i]!.alpha)]);
      for (const [from, to, alpha] of bands) {
        if (to - from >= 0.5 && alpha < 0.99 && Math.min(to, span[1]!, whole) - Math.max(from, span[0]!, 0) >= 0.5) return true;
      }
    }
    return false;
  };
  // The fraction of `picture`'s area that `box` covers.
  const covered = (picture: DOMRect, box: { left: number; top: number; width: number; height: number }) => {
    const x = Math.max(0, Math.min(picture.right, box.left + box.width) - Math.max(picture.left, box.left));
    const y = Math.max(0, Math.min(picture.bottom, box.top + box.height) - Math.max(picture.top, box.top));
    return (x * y) / (picture.width * picture.height);
  };
  const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
  // Where an absolutely positioned pseudo-element of `el` is drawn. Its offsets and size read as used values in px, from
  // the padding box it is placed in: `el`'s own when `el` is positioned, else its offsetParent's; the screen's when it
  // is fixed, or has no offsetParent.
  const pseudoBox = (el: Element, s: CSSStyleDeclaration) => {
    const host = s.position !== "fixed" && (getComputedStyle(el).position !== "static" ? el : (el as HTMLElement).offsetParent);
    const origin = host ? { left: host.getBoundingClientRect().left + host.clientLeft, top: host.getBoundingClientRect().top + host.clientTop } : { left: 0, top: 0 };
    return { left: origin.left + parseFloat(s.left), top: origin.top + parseFloat(s.top), width: parseFloat(s.width), height: parseFloat(s.height) };
  };
  // The name of a picture, the same at every size: its file's path (the last two folders, never the host, which a local
  // server changes) or the element.
  const nameOf = (el: Element) => (el instanceof HTMLImageElement && /^https?:/.test(el.src) ? new URL(el.src).pathname.split("/").filter(Boolean).slice(-2).join("/") : describe(el));

  // The overlays: absolutely positioned elements, not set behind the page, whose background is a gradient that reaches
  // transparent.
  const overlays = [...document.body.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    return /absolute|fixed/.test(s.position) && !(Number.parseInt(s.zIndex) < 0) && fadesOut(s.backgroundImage);
  });
  // Why `picture` fades into the page, or "" when it does not.
  const causeOf = (picture: Element, box: DOMRect): string => {
    // A gradient layered over the picture's own url() background: the layers before it are drawn on top.
    const own = getComputedStyle(picture);
    const first = own.backgroundImage.indexOf("url(");
    if (first > 0 && fadesOut(own.backgroundImage.slice(0, first))) return "faded by a gradient layered over its own background";
    for (let n: Element | null = picture; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/gradient\(/.test(`${s.getPropertyValue("mask-image")} ${s.getPropertyValue("-webkit-mask-image")}`) && maskFades(n, box)) return `faded by a gradient mask on ${n === picture ? "the picture itself" : describe(n)}`;
      for (const which of ["::before", "::after"]) {
        const p = getComputedStyle(n, which);
        // A pseudo-element in the flow sits beside the picture, not over it; one set behind the page, or a box's ::before
        // under a positioned picture, which is drawn after it, sits under it.
        if (p.content === "none" || !/absolute|fixed/.test(p.position) || Number.parseInt(p.zIndex) < 0 || !fadesOut(p.backgroundImage)) continue;
        if (which === "::before" && n !== picture && own.position !== "static") continue;
        const part = covered(box, pseudoBox(n, p));
        if (part >= 0.1) return `${percent(part)} covered by the gradient to transparent of ${describe(n)}${which}`;
      }
    }
    for (const overlay of overlays) {
      if (overlay.contains(picture) || optedOut(overlay)) continue;
      // An overlay is drawn over a picture that is not positioned, and over one that is when it comes later in the page.
      if (own.position !== "static" && overlay.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
      const part = covered(box, overlay.getBoundingClientRect());
      if (part >= 0.1) return `${percent(part)} covered by the gradient to transparent of ${describe(overlay)}`;
    }
    return "";
  };

  for (const picture of document.body.querySelectorAll("*")) {
    if (!(picture.matches("img, svg image") || /url\(/.test(getComputedStyle(picture).backgroundImage)) || optedOut(picture) || !shown(picture)) continue;
    const detail = causeOf(picture, picture.getBoundingClientRect());
    if (detail) issues.push({ ref: ref(picture), rule: "image-fade", element: nameOf(picture), detail });
  }
  return issues;
}
