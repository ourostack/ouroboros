export { AUTO_PRESS, findLoadingIssues, interactionSince, listenForMeasures, markPressables, NEVER_PRESS, pressPoint };
export type { LoadingBudgets, Measures, Painted, Pressable };

import type { PageIssue } from "./size-check.ts";

// The measured rules' in-page side. Playwright runs these functions in the page (page.evaluate and
// context.addInitScript), so none of them may close over anything outside itself.
//
//   layout-shift   how far the page moved under the reader while it loaded: its cumulative layout shift, the
//                  largest burst of shifts no input caused, as browsers score it
//   first-content  how long the page took to draw its largest text or picture, its first useful content; a skeleton
//                  draws neither, so a page that shows one first is timed to what replaces it
//   inp            how long a press took to paint: for each control the app lists for pressing, the longest event of
//                  its press, from the press to the next frame drawn after its handlers ran
//   first-paint-swap  a control the first frames drew that is gone at rest, with another drawn over its place in a later
//                  frame, and no input between: the first frame's content swapped for what came after it
//
// An element opts out with data-ouro-allow="<rule>" and a reason in data-ouro-allow-why, as the other rules do.

// A control the first frames drew: the first frame that showed it, its box then, and whether it is a skeleton or opted out
// of first-paint-swap. Read when it is drawn, since a removed element has lost the ancestors that mark it.
interface Painted {
  frame: number;
  box: { left: number; top: number; right: number; bottom: number };
  skipped: boolean;
  /** Its HTML as that frame drew it, trimmed: a swap's finding shows it beside the HTML at rest. */
  html: string;
}

interface Measures {
  shift: number;
  shiftNode: Node | null;
  paint: number;
  paintNode: Element | null;
  events: { start: number; duration: number }[];
  painted: Map<Element, Painted>;
  /** Adds a layout-shift entry to the score: kept apart so a test can feed it shifts. */
  add: (entry: { value: number; startTime: number; hadRecentInput: boolean; sources: { node: Node | null }[] }) => void;
}

interface LoadingBudgets {
  "layout-shift": number;
  "first-content": number;
}

interface Pressable {
  ref: string;
  element: string;
}

// An init script: records layout shifts, the largest content drawn, and the events of each press, from the page's start.
function listenForMeasures(): void {
  // The burst under way: its score, when it began and its last shift, and the node of its largest shift.
  let burst = 0;
  let first = -Infinity;
  let last = -Infinity;
  let worst = 0;
  let worstNode: Node | null = null;
  const m: Measures = {
    shift: 0,
    shiftNode: null,
    paint: 0,
    paintNode: null,
    events: [],
    painted: new Map(),
    add(entry) {
      if (entry.hadRecentInput) return;
      // A burst ends after a second without a shift, or five seconds after it began.
      if (entry.startTime - last > 1000 || entry.startTime - first > 5000) {
        burst = 0;
        first = entry.startTime;
        worst = 0;
        worstNode = null;
      }
      burst += entry.value;
      last = entry.startTime;
      const node = entry.sources.map((source) => source.node).find(Boolean);
      if (node && entry.value > worst) {
        worst = entry.value;
        worstNode = node;
      }
      // The score is the largest burst's, and the node the one that moved most in that burst.
      if (burst > m.shift) {
        m.shift = burst;
        m.shiftNode = worstNode;
      }
    },
  };
  (window as unknown as { __ouroCheckMeasures: Measures }).__ouroCheckMeasures = m;
  new PerformanceObserver((list) => list.getEntries().forEach((entry) => m.add(entry as unknown as Parameters<Measures["add"]>[0]))).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { element: Element | null })[]) {
      m.paint = entry.startTime;
      m.paintNode = entry.element;
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
  // A press's events have an interactionId; a pointer passing over does not.
  new PerformanceObserver((list) => {
    const presses = (list.getEntries() as (PerformanceEntry & { interactionId: number })[]).filter((entry) => entry.interactionId);
    m.events.push(...presses.map((entry) => ({ start: entry.startTime, duration: entry.duration })));
  }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  // What the first frames draw, before any input: each visible control, once, in the first frame that shows it. A frame is
  // read from the message its requestAnimationFrame posts, which runs once the frame is painted, so the DOM read is the
  // one the frame drew. Input (a press, a key, a wheel) ends the reading.
  const FIRST_FRAMES = 10;
  let frames = 0;
  let input = false;
  for (const type of ["pointerdown", "keydown", "wheel"]) window.addEventListener(type, () => (input = true), { capture: true, passive: true });
  // A skeleton, or an element allowed first-paint-swap with a reason, around a control: no swap is judged for it.
  const skipped = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if (n.matches('[aria-busy="true"], [data-ouro="skeleton"], [data-ouro-skeleton]')) return true;
      const rules = (n.getAttribute("data-ouro-allow") ?? "").split(/\s+/);
      if ((rules.includes("first-paint-swap") || rules.includes("all")) && (n.getAttribute("data-ouro-allow-why") ?? "").trim()) return true;
    }
    return false;
  };
  // An element's HTML, whitespace collapsed and cut at 500 characters, so a large one costs the report little.
  const htmlOf = (el: Element) => {
    const html = el.outerHTML.replace(/\s+/g, " ");
    return html.length > 500 ? `${html.slice(0, 500)}…` : html;
  };
  const readFrame = () => {
    frames++;
    for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [data-ouro-control]")) {
      if (m.painted.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      m.painted.set(el, { frame: frames, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, skipped: skipped(el), html: htmlOf(el) });
    }
  };
  const paintFrame = (): void =>
    void requestAnimationFrame(() => {
      if (input || frames >= FIRST_FRAMES) return;
      // Before the body parses there is nothing to read, so the frame does not count.
      if (!document.body) return paintFrame();
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        // Input that came in while the frame was on its way to this read ends the reading as well.
        if (input) return;
        readFrame();
        paintFrame();
      };
      channel.port2.postMessage(null);
    });
  paintFrame();
}

// The loading rules, read once the page is ready and its pictures decoded, and two frames later, when the browser has
// reported what the last of them drew: a finding for a page that shifted more than its budget, marked on the element
// that moved most, and one for a page whose largest content drew later than its budget, marked on that content.
async function findLoadingIssues(budgets: LoadingBudgets): Promise<PageIssue[]> {
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50))));
  const m = (window as unknown as { __ouroCheckMeasures: Measures }).__ouroCheckMeasures;
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  // Whether an element, or one around it, opts out of `rule` with a reason. A reason of spaces is no reason; the page's
  // attributes are read, never rewritten.
  const reasonOf = (el: Element, name: string) => (el.getAttribute(name) ?? "").trim();
  const optedOut = (el: Element, rule: string) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = reasonOf(n, "data-ouro-allow").split(/\s+/);
      if ((rules.includes(rule) || rules.includes("all")) && reasonOf(n, "data-ouro-allow-why")) return true;
    }
    return false;
  };
  const words = (el: Element) => (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
  const name = (el: Element) => {
    const w = words(el);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}${w ? ` "${w.slice(0, 40)}${w.length > 40 ? "…" : ""}"` : ""}`;
  };
  const report = (rule: keyof LoadingBudgets | "first-paint-swap", node: Node | null, value: number | undefined, detail: string, swap?: PageIssue["swap"]) => {
    const found = node instanceof Element ? node : (node?.parentElement ?? null);
    // Content that has left the page since is named as the page, and pictured as the screen.
    const el = found?.isConnected ? found : document.body;
    if (optedOut(el, rule)) return;
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const ref = `m${counter.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${ref}`.trim());
    const element = el === document.body ? "the page" : name(el);
    // A swap is a count, not a budget: a finding with no number, as the size rules report, and its two controls' HTML.
    if (swap) issues.push({ ref, rule, element, detail, swap });
    else issues.push({ ref, rule, element, detail, value: value!, budget: budgets[rule as keyof LoadingBudgets], unit: rule === "layout-shift" ? "" : "ms" });
  };
  const shift = Math.round(m.shift * 1000) / 1000;
  if (shift > budgets["layout-shift"]) report("layout-shift", m.shiftNode, shift, `shifted ${shift} while loading, over the budget of ${budgets["layout-shift"]}`);
  const paint = Math.round(m.paint);
  if (paint > budgets["first-content"]) report("first-content", m.paintNode, paint, `${paint} ms to its largest content, over the budget of ${budgets["first-content"]} ms`);
  // A control the first frames drew that is gone at rest, and a control a later frame drew over its place, with no input
  // between. The one that took the place is reported once. A skeleton or an opt-out on either is no swap; the same control
  // drawn again (same tag, role and words) is a re-render, not a swap.
  const shown = (el: Element) => el.isConnected && el.getClientRects().length > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const overlaps = (box: Painted["box"], rect: DOMRect) => box.left < rect.right && rect.left < box.right && box.top < rect.bottom && rect.top < box.bottom;
  // Where each control shown at rest is drawn, read once: a control with no entry here is gone.
  const at = new Map<Element, DOMRect>();
  for (const el of m.painted.keys()) if (shown(el)) at.set(el, el.getBoundingClientRect());
  const taken = new Set<Element>();
  // As readFrame cuts it, so the first frame's HTML and the HTML at rest compare, less the marks this check has put on
  // the page since (the other loading rules' data-ouro-check-ref), which the app never wrote.
  const htmlOf = (el: Element) => {
    const html = el.outerHTML.replace(/ data-ouro-check-[\w-]+="[^"]*"/g, "").replace(/\s+/g, " ");
    return html.length > 500 ? `${html.slice(0, 500)}…` : html;
  };
  for (const [gone, was] of m.painted) {
    if (was.skipped || at.has(gone)) continue;
    for (const [taker, later] of m.painted) {
      const rect = at.get(taker);
      if (!rect || taken.has(taker) || later.skipped || later.frame <= was.frame || !overlaps(was.box, rect)) continue;
      if (taker.tagName === gone.tagName && taker.getAttribute("role") === gone.getAttribute("role") && words(taker) === words(gone)) continue;
      taken.add(taker);
      // Each as it was first drawn and as it is at rest, read before the report marks the taker; gone at rest is null
      // when it has left the page, and its HTML when it is still there but hidden.
      const swap = { gone: { first: was.html, rest: gone.isConnected ? htmlOf(gone) : null }, taker: { first: later.html, rest: htmlOf(taker) } };
      report("first-paint-swap", taker, undefined, `${name(gone)} drew in the first frame, then ${name(taker)} took its place without input`, swap);
      break;
    }
  }
  return issues;
}

// What inp never presses, even when listed, nor clicks inside: a control with a destructive tone (Ouro's and shadcn's
// destructive classes, or data-tone or data-variant "destructive"), one marked data-ouro-check-no-press, a link, whatever
// its role, which would leave the page, and a form's submit button, inside the form or tied to it by its form attribute,
// which would send it.
const NEVER_PRESS = [
  "a[href]",
  "area[href]",
  "[data-ouro-check-no-press]",
  '[data-tone="destructive"]',
  '[data-variant="destructive"]',
  '[class*="destructive"]',
  'form button:not([type="button"]):not([type="reset"])',
  'button[form]:not([type="button"]):not([type="reset"])',
  'input[type="submit"]',
  'input[type="image"]',
].join(", ");

// What pressAll presses without a list: each Ouro control (data-ouro-control) that is a button, switch, checkbox, tab or
// menu item, by role or by element. NEVER_PRESS still keeps out links, submit buttons and destructive controls.
const AUTO_PRESS = '[data-ouro-control]:is(button, input[type="checkbox"], [role="button"], [role="switch"], [role="checkbox"], [role="tab"], [role="menuitem"])';

// Marks the first `limit` controls listed for pressing, shown and enabled, and names each: the ones ouro-check.json's
// "press" selectors match, and the ones marked data-ouro-check-press. Pressing is opt-in because a press does what it
// says, on whatever server the app talks to. Never one that `never` (NEVER_PRESS) matches, or inside one.
function markPressables({ limit, press, never }: { limit: number; press: string[]; never: string }): Pressable[] {
  const counter = window as unknown as { __ouroCheckRef?: number };
  // Whether an element, or one around it, opts out of inp with a reason. A reason of spaces is no reason; the page's
  // attributes are read, never rewritten.
  const reasonOf = (el: Element, name: string) => (el.getAttribute(name) ?? "").trim();
  const optedOut = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = reasonOf(n, "data-ouro-allow").split(/\s+/);
      if ((rules.includes("inp") || rules.includes("all")) && reasonOf(n, "data-ouro-allow-why")) return true;
    }
    return false;
  };
  const words = (el: Element) => (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
  const name = (el: Element) => {
    const w = words(el);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}${w ? ` "${w.slice(0, 40)}${w.length > 40 ? "…" : ""}"` : ""}`;
  };
  const pressable = (el: Element) => {
    if (el.matches(':disabled, [aria-disabled="true"]') || el.closest(never) || optedOut(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  return [...document.querySelectorAll([...press, "[data-ouro-check-press]"].join(", "))]
    .filter(pressable)
    .slice(0, limit)
    .map((el) => {
      counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
      const ref = `p${counter.__ouroCheckRef}`;
      el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${ref}`.trim());
      return { ref, element: name(el) };
    });
}

// Where to press a marked control, in the screen's coordinates once it is scrolled into view; null when it has left
// the page, something else covers its middle, or what its middle would click is something `never` matches or is inside
// one, such as a destructive button inside a listed wrapper.
function pressPoint({ ref, never }: { ref: string; never: string }): { x: number; y: number } | null {
  const el = document.querySelector(`[data-ouro-check-ref~="${ref}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return el.contains(hit) && !hit!.closest(never) ? { x, y } : null;
}

// The longest event of the presses since `since` (performance.now()), in ms, once two frames have drawn; 0 when every
// one took less than 16 ms, the shortest the browser reports.
async function interactionSince(since: number): Promise<number> {
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50))));
  const { events } = (window as unknown as { __ouroCheckMeasures: Measures }).__ouroCheckMeasures;
  return Math.max(0, ...events.filter((e) => e.start >= since).map((e) => e.duration));
}
