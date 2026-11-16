export { findRepaints, listenForMotion, markWalkables, readMotion, resetMotion };
export type { MotionReading, Walkable };

// Ouro Feel's measures on any page, for the jank rule. Playwright runs these functions in the page (page.evaluate and
// context.addInitScript), so none of them may close over anything outside itself. The definitions are Feel's
// (feel/probe/probe.ts and core's decision record): a forced layout is a layout read made while a change to the page is
// still waiting to be laid out; the longest frame is the longest gap between animation frames.
//
// The runner walks a page's states as Reins walks an app's: it hovers each card, opens and closes each popup or
// disclosure, and scrolls or pans each scrolling region, and reads these measures after each.

interface MotionReading {
  forcedLayouts: number;
  longestFrameMs: number;
  /** The layout shift the step caused, less what the browser puts down to a press or a key (hover and scroll aren't input to it). */
  shift: number;
}

interface Walkable {
  ref: string;
  element: string;
  kind: "hover" | "open" | "scroll" | "pan";
  /** Which way a scroll region scrolls. */
  axis?: "x" | "y";
  /** The page's own scroller, scrolled from the middle of the screen. */
  page?: boolean;
}

interface Motion {
  forced: number;
  shift: number;
  frames: number[];
  armed: boolean;
}

// An init script: counts forced layouts and layout shifts, and times frames once armed, from the page's start.
function listenForMotion(): void {
  const m: Motion = { forced: 0, shift: 0, frames: [], armed: false };
  (window as unknown as { __ouroMotion: Motion }).__ouroMotion = m;
  let pending = false;
  const observer = new MutationObserver(() => {
    pending = true;
  });
  const start = () => observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  start();
  const read = () => {
    if (!m.armed) return;
    if (pending || observer.takeRecords().length > 0) {
      m.forced += 1;
      pending = false;
    }
  };
  const getters: [object, string][] = [
    [HTMLElement.prototype, "offsetTop"], [HTMLElement.prototype, "offsetLeft"], [HTMLElement.prototype, "offsetWidth"], [HTMLElement.prototype, "offsetHeight"],
    [HTMLElement.prototype, "offsetParent"], [HTMLElement.prototype, "innerText"], [Element.prototype, "clientTop"], [Element.prototype, "clientLeft"],
    [Element.prototype, "clientWidth"], [Element.prototype, "clientHeight"], [Element.prototype, "scrollTop"], [Element.prototype, "scrollLeft"],
    [Element.prototype, "scrollWidth"], [Element.prototype, "scrollHeight"],
  ];
  for (const [target, name] of getters) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)!;
    const get = descriptor.get!;
    Object.defineProperty(target, name, { ...descriptor, get(this: unknown) { read(); return get.call(this); } });
  }
  for (const [target, name] of [[Element.prototype, "getBoundingClientRect"], [Element.prototype, "getClientRects"], [Document.prototype, "elementFromPoint"], [Element.prototype, "scrollIntoView"], [HTMLElement.prototype, "focus"]] as unknown as [Record<string, unknown>, string][]) {
    const original = target[name] as (...args: unknown[]) => unknown;
    target[name] = function (this: unknown, ...args: unknown[]) {
      read();
      return original.apply(this, args);
    };
  }
  // A frame painted: whatever changed before it is laid out.
  const tick = (at: number) => {
    pending = false;
    if (m.armed) m.frames.push(at);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (m.armed && !entry.hadRecentInput) m.shift += entry.value;
  }).observe({ type: "layout-shift", buffered: false });
}

// repaint: an endless animation that makes the browser paint every frame while nothing else moves, so a page at rest is
// never at rest. Only transform, opacity, translate, rotate and scale run on the compositor; anything else (a dash
// offset, a background position, a colour) repaints, and so does any animation inside an SVG drawing. Read from
// document.getAnimations(), so it needs no timing. Found by a consuming app's plan map smoothness work, where three such
// animations painted 180 times in 1.5 s at rest.
function findRepaints(): { ref: string; rule: string; element: string; detail: string }[] {
  const counter = window as unknown as { __ouroCheckRef?: number };
  const cheap = new Set(["transform", "opacity", "translate", "rotate", "scale", "offset", "computedOffset", "easing", "composite"]);
  const issues: { ref: string; rule: string; element: string; detail: string }[] = [];
  const seen = new Set<Element>();
  for (const animation of document.getAnimations()) {
    const effect = animation.effect as KeyframeEffect | null;
    const target = effect?.target;
    if (!effect || !target || animation.playState !== "running" || effect.getTiming().iterations !== Infinity || seen.has(target)) continue;
    const allow = target.closest("[data-ouro-allow~=repaint], [data-ouro-allow~=all]");
    if (allow && (allow.getAttribute("data-ouro-allow-why") ?? "").trim()) continue;
    const painted = [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))].filter((key) => !cheap.has(key)).sort();
    const inSvg = target instanceof SVGElement && target.ownerSVGElement !== null;
    if (!painted.length && !inSvg) continue;
    seen.add(target);
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const ref = `r${counter.__ouroCheckRef}`;
    target.setAttribute("data-ouro-check-ref", `${target.getAttribute("data-ouro-check-ref") ?? ""} ${ref}`.trim());
    const name = `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}${target.classList.length ? `.${[...target.classList].slice(0, 3).join(".")}` : ""}${effect.pseudoElement ?? ""}`;
    const css = painted.map((key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`));
    const what = painted.length ? `animates ${css.join(", ")}` : "animates inside an SVG drawing";
    issues.push({ ref, rule: "repaint", element: name, detail: `an endless animation that ${what}, so the page repaints every frame at rest: animate transform or opacity on an HTML element, or stop it once it has said what it says` });
  }
  return issues;
}

// Starts a step's measures afresh.
function resetMotion(): void {
  const m = (window as unknown as { __ouroMotion: Motion }).__ouroMotion;
  Object.assign(m, { forced: 0, shift: 0, frames: [], armed: true });
}

// Ends a step: its measures, read without counting the reading.
function readMotion(): MotionReading {
  const m = (window as unknown as { __ouroMotion: Motion }).__ouroMotion;
  m.armed = false;
  const gaps = m.frames.slice(1).map((at, i) => at - m.frames[i]!);
  return { forcedLayouts: m.forced, longestFrameMs: Math.round(Math.max(0, ...gaps)), shift: Math.round(m.shift * 1000) / 1000 };
}

// The page's states worth walking, at most `limit` of each kind: cards to hover (a link, button or pointer target the
// size of a card), popups and disclosures to open (aria-haspopup, aria-expanded, popovertarget, summary), the page and
// the regions in it that scroll, and surfaces that pan (cursor: grab). A control `never` matches (Ouro check's
// NEVER_PRESS: links away, submit buttons, destructive controls) is never opened; hovering one does nothing it says. Each is marked data-ouro-check-ref so the runner can find it and photograph it.
function markWalkables({ limit, never }: { limit: number; never: string }): Walkable[] {
  const counter = window as unknown as { __ouroCheckRef?: number };
  const walkables: Walkable[] = [];
  const counts = { "hover": 0, open: 0, scroll: 0, pan: 0 };
  const describe = (el: Element) => {
    const name = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${name ? ` "${name}"` : ""}`;
  };
  const usable = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const allow = el.closest("[data-ouro-allow~=jank], [data-ouro-allow~=all]");
    return r.width >= 8 && r.height >= 8 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden], [inert], [aria-hidden=true], [disabled]") && !(allow && (allow.getAttribute("data-ouro-allow-why") ?? "").trim());
  };
  const add = (el: Element, kind: Walkable["kind"], axis?: Walkable["axis"], page = false) => {
    if (counts[kind] >= limit || walkables.some((w) => w.kind === kind && document.querySelector(`[data-ouro-check-ref~="${w.ref}"]`) === el)) return;
    counts[kind] += 1;
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const ref = `w${counter.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${ref}`.trim());
    walkables.push({ ref, element: page ? "the page" : describe(el), kind, ...(axis ? { axis } : {}), ...(page ? { page } : {}) });
  };
  for (const el of document.querySelectorAll("[aria-haspopup]:not([aria-haspopup=false]), [aria-expanded], [popovertarget], summary")) {
    const link = el.closest("a[href]");
    if (usable(el) && !el.closest(never) && !(link && !link.getAttribute("href")!.startsWith("#"))) add(el, "open");
  }
  for (const el of document.querySelectorAll("a[href], button, [role=button], [role=link], [tabindex]")) {
    const r = el.getBoundingClientRect();
    if (r.width >= 120 && r.height >= 60 && usable(el)) add(el, "hover");
  }
  const scroller = document.scrollingElement!;
  if (scroller.scrollHeight > scroller.clientHeight + 20) add(scroller, "scroll", "y", true);
  for (const el of document.querySelectorAll("body *")) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 150 || !usable(el)) continue;
    if (s.cursor === "grab") add(el, "pan");
    else if (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 20) add(el, "scroll", "y");
    else if (/auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 20) add(el, "scroll", "x");
  }
  return walkables;
}
