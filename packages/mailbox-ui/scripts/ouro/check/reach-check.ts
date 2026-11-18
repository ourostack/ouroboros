export { findDeadZones, markReveals, revealLayout, movedSince };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in a function may close over anything outside it. Whether a person who
// points at a linked card reaches what it links to, and whether what a card reveals on hover or focus pushes the page:
//
//   linked-card-dead-zone  a card or row that is one link (Ouro's data-linked, or a box around a link whose ::after is
//                          stretched over it) where a click at some spot on it, which no control of its own takes,
//                          opens nothing: an app that positions one of its parts (a body laid over the media, a sticky
//                          cell) keeps the link's layer to that part. Each spot is hit-tested, as a click would be, and
//                          nothing is clicked, so no app code runs. A card whose root opens its link from any click on it
//                          says so with data-follows-link (Ouro's Card, Item and Table do), and passes.
//   reveal-reflow          a card whose hover or keyboard focus reveals a part (Ouro's data-card-reveal, an Item's
//                          revealed actions, or data-ouro-reveal) and moves the card's own box or anything outside it.
//                          The runner hovers and focuses each and compares revealLayout before and after.
//
// An element opts out with data-ouro-allow="<rule id>" and a reason in data-ouro-allow-why, as the other rules do.

/** A linked card's dead spots, as a grid of points over it: those a click there opens nothing from. */
function findDeadZones(): PageIssue[] {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `r${counter.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${id}`.trim());
    return id;
  };
  const optedOut = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = (n.getAttribute("data-ouro-allow") ?? "").split(/\s+/);
      if ((rules.includes("linked-card-dead-zone") || rules.includes("all")) && (n.getAttribute("data-ouro-allow-why") ?? "").trim()) return true;
    }
    return false;
  };
  const describe = (el: Element, link: Element) => {
    // An element's text is never null.
    const words = link.textContent!.trim().replace(/\s+/g, " ");
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""} "${words.slice(0, 40)}${words.length > 40 ? "…" : ""}"`;
  };
  // What takes its own click inside a card: its link, and any control or nested linked row.
  const own = "a, button, input, select, textarea, label, summary, [tabindex]:not([tabindex='-1']), [role=button], [role=link], [contenteditable=true], [data-linked]";
  const stretched = (link: Element) => {
    const after = getComputedStyle(link, "::after");
    return after.content !== "none" && after.content !== "normal" && after.position === "absolute";
  };
  // Each linked card once: Ouro's data-linked root, or the box a stretched link is meant to cover.
  const cards = new Map<Element, HTMLElement>();
  for (const root of document.body.querySelectorAll<HTMLElement>("[data-linked]")) {
    const link = [...root.querySelectorAll<HTMLElement>("[data-stretched-link]")].find((candidate) => candidate.parentElement?.closest("[data-linked]") === root);
    if (link) cards.set(root, link);
  }
  for (const link of document.body.querySelectorAll<HTMLElement>("a[href]")) {
    if (link.closest("[data-linked]") || !stretched(link)) continue;
    const root = link.parentElement?.closest<HTMLElement>("article, li, tr, [role=article], [role=listitem], [role=row]");
    if (root && !cards.has(root)) cards.set(root, link);
  }
  const startX = scrollX;
  const startY = scrollY;
  try {
    for (const [card, link] of cards) {
      if (optedOut(card) || card.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
      const box = card.getBoundingClientRect();
      if (box.width < 24 || box.height < 24) continue;
      // A card that opens its link from a click on its root, as Ouro's Card, Item and Table do, reaches it everywhere.
      if (card.closest("[data-follows-link]") === card) continue;
      // The window alone scrolls, so a carousel or other box the card is in keeps its place.
      // At once, whatever the page's scroll-behavior: a smooth scroll would leave the card off the screen to hit-test.
      if (box.top < 0 || box.bottom > innerHeight) scrollTo({ left: scrollX, top: scrollY + box.top - Math.max(0, (innerHeight - box.height) / 2), behavior: "instant" });
      const r = card.getBoundingClientRect();
      let points = 0;
      let dead = 0;
      for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 5; column++) {
          const x = r.left + 4 + ((r.width - 8) * (column + 0.5)) / 5;
          const y = r.top + 4 + ((r.height - 8) * (row + 0.5)) / 4;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          const hit = document.elementFromPoint(x, y);
          // Covered by something else on the page (a sticky header), or a spot a control of the card's own takes.
          if (!hit || !card.contains(hit)) continue;
          const control = hit.closest(own);
          if (control && control !== card && card.contains(control) && control !== link && !link.contains(control)) continue;
          points++;
          if (!link.contains(hit)) dead++;
        }
      }
      if (!dead) continue;
      issues.push({
        ref: ref(card),
        rule: "linked-card-dead-zone",
        element: describe(card, link),
        detail: `a click on ${dead} of ${points} spots on it opens nothing: its link's layer stops at a part the page positions`,
      });
    }
  } finally {
    scrollTo({ left: startX, top: startY, behavior: "instant" });
  }
  return issues;
}

/** Up to `limit` cards that reveal a part on hover or focus, marked so the runner can aim at them. */
function markReveals(limit: number): { ref: string; element: string }[] {
  const counter = window as unknown as { __ouroCheckRef?: number };
  const found: { ref: string; element: string }[] = [];
  const roots = new Set<Element>();
  for (const part of document.body.querySelectorAll("[data-card-reveal], [data-ouro-reveal], [data-item-actions]")) {
    // A part in the body always has a parent.
    const root = part.closest('[data-ouro="card"], [data-ouro="item"], [data-linked]') ?? part.parentElement!;
    // An Item's actions are revealed only with revealActions, which makes the row a hover group.
    if (part.hasAttribute("data-item-actions") && !root.classList.contains("group/item")) continue;
    roots.add(root);
  }
  for (const root of roots) {
    if (found.length >= limit) break;
    const allow = root.closest("[data-ouro-allow]");
    if (allow && /\b(reveal-reflow|all)\b/.test(allow.getAttribute("data-ouro-allow")!) && (allow.getAttribute("data-ouro-allow-why") ?? "").trim()) continue;
    const r = root.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || root.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `v${counter.__ouroCheckRef}`;
    root.setAttribute("data-ouro-check-ref", `${root.getAttribute("data-ouro-check-ref") ?? ""} ${id}`.trim());
    const words = (root.querySelector("h1, h2, h3, h4, h5, h6, a, button")?.textContent ?? "").trim().replace(/\s+/g, " ");
    found.push({ ref: id, element: `${root.tagName.toLowerCase()} "${words.slice(0, 40)}"` });
  }
  return found;
}

/**
 * Where a reveal's card and what is outside it are, in page coordinates: the card's box first, then the elements
 * outside it, in document order. With `focus`, the card's link (or first control) takes keyboard focus first, and with
 * `blur` it lets it go.
 */
function revealLayout(args: { ref: string; focus?: boolean; blur?: boolean }): number[] {
  const root = document.querySelector<HTMLElement>(`[data-ouro-check-ref~="${args.ref}"]`);
  if (!root) return [];
  const target = root.querySelector<HTMLElement>("[data-card-link], [data-stretched-link], a[href], button, [tabindex]:not([tabindex='-1'])");
  if (args.focus) target?.focus({ focusVisible: true, preventScroll: true } as FocusOptions);
  if (args.blur) (document.activeElement as HTMLElement | null)?.blur();
  const at = (el: Element) => {
    const r = el.getBoundingClientRect();
    return [Math.round((r.left + scrollX) * 2) / 2, Math.round((r.top + scrollY) * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2];
  };
  const out = at(root);
  for (const el of document.body.querySelectorAll("*")) if (!root.contains(el) && !el.contains(root)) out.push(...at(el));
  return out;
}

/**
 * How many boxes moved between two layouts of the same page, or -1 when the page changed shape.
 * @claim "How many boxes moved between two" test/check-reach-in-page.test.tsx verify:testExists(test/check-reach-in-page.test.tsx::revealLayout and movedSince: reveal-reflow > tells a page that changed shape from one that moved)
 */
function movedSince(before: number[], after: number[]): number {
  if (before.length !== after.length) return -1;
  let moved = 0;
  for (let i = 0; i < before.length; i += 4) if ([0, 1, 2, 3].some((k) => Math.abs(before[i + k]! - after[i + k]!) > 0.5)) moved++;
  return moved;
}
