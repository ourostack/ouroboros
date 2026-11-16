export { ALIASES, behindModal, boxOf, decodeImages, isReady, listAllowances, listenForReady, outline, runAxe };
export type { Allowance, AxeIssue, Box };

import type { PageIssue } from "./size-check.ts";

// The rest of check.ts's in-page side. Playwright runs these functions in the page (page.evaluate,
// page.waitForFunction, context.addInitScript), so none of them may close over anything outside itself.

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// An element a rule leaves alone on purpose, with the reason it was given.
interface Allowance {
  rules: string;
  element: string;
  reason: string;
}

// The plain opt-outs, for an app whose own rules keep data-ouro-* for Ouro's components, and the rules each covers.
// They are API, not deprecated: each counts only with its reason as its value.
const ALIASES: Record<string, string> = {
  "data-overlap-ignore": "overlap",
  "data-long-lines-ok": "long-lines",
  "data-clip-ok": "clipped-text",
  "data-scroll-x": "sideways-scroll",
  "data-size-ignore": "sideways-scroll clipped-text long-lines stretched-image",
  "data-image-fade-ok": "image-fade",
};

interface AxeIssue extends PageIssue {
  impact: string;
}

interface AxeResult {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown[] }[];
}

// An init script: a page that fires one of `events` (ouro:ready, and any --ready-event) on window or document has drawn.
function listenForReady(events: string[]): void {
  const flag = window as unknown as { __ouroCheckReady?: boolean };
  for (const name of events) {
    for (const target of [window, document]) target.addEventListener(name, () => (flag.__ouroCheckReady = true), { capture: true });
  }
}

// Whether the page has drawn: it fired a ready event, or marked itself data-app-ready (data-app-ready="false" says it
// will, so it waits for that); without either, a page with no module script once loaded, and any other once an h1 has
// drawn. The runner gives up waiting after 15 s and checks the page as it is.
function isReady(): boolean {
  if ((window as unknown as { __ouroCheckReady?: boolean }).__ouroCheckReady) return true;
  const marked = document.querySelector("[data-app-ready]");
  if (marked) return marked.getAttribute("data-app-ready") !== "false";
  if (document.documentElement.classList.contains("app-ready") || !document.querySelector('script[type="module"]')) return true;
  return [...document.querySelectorAll("h1")].some((h) => h.getClientRects().length > 0 && h.textContent!.trim() !== "");
}

// Waits for every picture to decode, or 3 s, whichever comes first.
async function decodeImages(): Promise<void> {
  await Promise.race([Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))), new Promise((done) => setTimeout(done, 3000))]);
}

// The refs, of those given, whose every marked element sits outside an open modal ([aria-modal="true"] or a modal
// <dialog>) while one is open: the page behind a modal, which a person can't reach until it closes, and which the
// page's own run checks as it is then. None while no modal is open, or for a ref that marks nothing.
function behindModal(refs: string[]): string[] {
  const modals = [...document.querySelectorAll('[aria-modal="true"], dialog:modal')].filter((m) => m.getClientRects().length);
  if (!modals.length) return [];
  return refs.filter((ref) => {
    const els = [...document.querySelectorAll(`[data-ouro-check-ref~="${ref}"]`)];
    return els.length > 0 && els.every((el) => !modals.some((m) => m.contains(el) || el.contains(m)));
  });
}

// The box, in page coordinates and padded, around the elements a finding marked, scrolled into view; the screen when it
// marked none, or marked only the page itself.
function boxOf({ ref, width, height }: { ref: string; width: number; height: number }): Box {
  const els = [...document.querySelectorAll(`[data-ouro-check-ref~="${ref}"]`)];
  if (!els.length || els[0] === document.body) return { x: 0, y: scrollY, width, height };
  els[0]!.scrollIntoView({ block: "center", behavior: "instant" });
  const rects = els.map((el) => el.getBoundingClientRect());
  const pad = 24;
  const left = Math.max(0, Math.min(...rects.map((r) => r.left)) - pad);
  const top = Math.min(...rects.map((r) => r.top)) - pad;
  const right = Math.min(document.documentElement.scrollWidth, Math.max(...rects.map((r) => r.right)) + pad);
  const bottom = Math.max(...rects.map((r) => r.bottom)) + pad;
  return { x: left + scrollX, y: Math.max(0, top + scrollY), width: Math.max(1, right - left), height: Math.max(1, Math.min(bottom - top, 1200)) };
}

// Outlines the elements a finding marked, or takes the outline off. Through element.style, because a page's
// Content-Security-Policy can refuse an added stylesheet.
function outline({ ref, on }: { ref: string; on: boolean }): void {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-ouro-check-ref~="${ref}"]`)) {
    el.style.setProperty("outline", on ? "3px solid #d93025" : "", on ? "important" : "");
    el.style.setProperty("outline-offset", on ? "2px" : "");
  }
}

// Runs axe-core (already on window.axe) and returns its serious and critical violations, one per rule, the first
// element it names marked for the close-up. Elements with data-ouro-allow="axe" and a reason are left out, and so are
// Base UI's focus guards, as Ouro's axe kit leaves them out (axeExclude): visually hidden spans that hand focus on the
// moment they get it, aria-hidden so a screen reader skips them, and a button for VoiceOver in WebKit.
async function runAxe(): Promise<AxeIssue[]> {
  const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: AxeResult[] }> } }).axe;
  // The elements that opt out, read with their reasons trimmed (a reason of spaces is none), never rewritten.
  const exclude = [...document.querySelectorAll("[data-ouro-allow]")].filter((el) => {
    const rules = el.getAttribute("data-ouro-allow")!.trim().split(/\s+/);
    return (rules.includes("axe") || rules.includes("all")) && (el.getAttribute("data-ouro-allow-why") ?? "").trim();
  });
  exclude.push(...document.querySelectorAll("[data-base-ui-focus-guard]"));
  const { violations } = await axe.run({ exclude }, { resultTypes: ["violations"] });
  const counter = window as unknown as { __ouroCheckRef?: number };
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => {
      counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
      const ref = `a${counter.__ouroCheckRef}`;
      const target = v.nodes[0]!.target.map(String).join(" ");
      for (const el of [...document.querySelectorAll(target)].slice(0, 1)) el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${ref}`.trim());
      return { ref, rule: "axe", impact: v.impact!, element: `${v.id}: ${target}`, detail: `${v.impact}: ${v.help}${v.nodes.length > 1 ? ` (${v.nodes.length} elements)` : ""}` };
    });
}

// Every element the page opts out of a rule, with its reason, for the report: data-ouro-allow with data-ouro-allow-why,
// and the aliases with their values. An opt-out without a reason does not count, so it is not listed.
function listAllowances(aliases: Record<string, string>): Allowance[] {
  const describe = (el: Element) => {
    const words = (el.textContent || el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ");
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}${words ? ` "${words.slice(0, 40)}${words.length > 40 ? "…" : ""}"` : ""}`;
  };
  // Reasons are read trimmed (a reason of spaces is none); the page's attributes are never rewritten.
  const found: Allowance[] = [];
  for (const el of document.querySelectorAll("[data-ouro-allow][data-ouro-allow-why]")) {
    const reason = el.getAttribute("data-ouro-allow-why")!.trim();
    // blurry-image is never allowed, so naming it allows nothing: the size check reports the attempt instead.
    const rules = el.getAttribute("data-ouro-allow")!.split(/\s+/).filter((rule) => rule && rule !== "blurry-image").join(" ");
    if (reason && rules) found.push({ rules, element: describe(el), reason });
  }
  for (const [name, rules] of Object.entries(aliases)) {
    for (const el of document.querySelectorAll(`[${name}]`)) {
      const reason = el.getAttribute(name)!.trim();
      if (reason) found.push({ rules, element: `${describe(el)} [${name}]`, reason });
    }
  }
  return found;
}
