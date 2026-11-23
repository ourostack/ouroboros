export { findPopupJumps, watchPopups };

import type { PageIssue } from "./size-check.ts";

// The popup-first-frame rule's two halves. Playwright runs both in the page (page.evaluate), so nothing in either may
// close over anything outside itself. The runner calls watchPopups before it presses a control that opens something,
// and findPopupJumps once what it opened has settled.
//
// A popup is a menu, a listbox, a dialog that isn't modal, a tooltip, a [popover], or what Base UI marks as placed
// against an anchor (data-side with data-open). Each animation frame, every popup that is drawn, meaning displayed, not
// hidden and not fully transparent, has its box recorded. The box is its layout box: the one it has before its own
// transform, so a popup that scales or slides in as it opens, as a declared opening motion does, counts as where it
// settles. A visible popup in any frame that is somewhere other than where it settles is a jump: its first frames
// were drawn in one place and it then moved to another, as a popup does when it is measured against the viewport and
// drawn inside a layer further down the page.
//
// A listbox with no opener (no aria-controls or aria-owns naming it, no popover or placement markers) is page content
// inside its container, not a popup, so it rides the container's opening motion unjudged.
//
// A page opts a popup out with data-ouro-allow="popup-first-frame" and data-ouro-allow-why="<reason>" on it or a box
// around it; an allow without a reason does not count.

// A drawn frame may be up to 2px from where the popup settles: a pixel or two of rounding.
interface Seen {
  left: number;
  top: number;
  opacity: number;
}

interface Watching {
  frames: Map<Element, Seen[]>;
  handle: number;
}

// Starts recording each drawn popup's layout box, frame by frame, until findPopupJumps reads it.
function watchPopups(): void {
  const state = window as unknown as { __ouroPopups?: Watching };
  const POPUPS = "[role=menu], [role=listbox], [role=dialog]:not([aria-modal=true]), [role=tooltip], [popover], [data-side][data-open]";
  if (state.__ouroPopups) cancelAnimationFrame(state.__ouroPopups.handle);
  const watching: Watching = { frames: new Map(), handle: 0 };
  state.__ouroPopups = watching;
  // A listbox is a popup only when something opens it: a control that names it with aria-controls or aria-owns, a
  // popover of its own, or Base UI's placement markers. One with no opener is page content, judged with its container.
  const isOpened = (el: Element) => {
    if (el.getAttribute("role") !== "listbox" || el.matches("[popover], [data-side]")) return true;
    return !!el.id && !!document.querySelector(`[aria-controls~="${CSS.escape(el.id)}"], [aria-owns~="${CSS.escape(el.id)}"]`);
  };
  const layout = (el: Element): Seen | null => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    let opacity = 1;
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden") return null;
      opacity *= Number(s.opacity);
    }
    if (opacity <= 0.02) return null;
    // Undo the element's own transform: the individual translate and scale properties, then transform, around its
    // origin, as the browser composes them. A rotation is left in, as no popup opens by turning.
    // A positioner's own transform is its placement, not an opening motion, so it is measured as drawn.
    const s = getComputedStyle(el);
    if ((el as HTMLElement).style.getPropertyValue("--anchor-width")) return { left: r.left, top: r.top, opacity };
    const [ox, oy] = s.transformOrigin.split(" ").map(parseFloat) as [number, number];
    const [tx = 0, ty = 0] = s.translate === "none" ? [] : s.translate.split(" ").map(parseFloat);
    const [sx = 1, sy = sx] = s.scale === "none" ? [] : s.scale.split(" ").map(parseFloat);
    const m = s.transform === "none" ? null : new DOMMatrixReadOnly(s.transform);
    const [a, d, e, f] = m ? [m.a, m.d, m.e, m.f] : [1, 1, 0, 0];
    return {
      left: Math.round((r.left - ox - tx - sx * (e - a * ox)) * 100) / 100,
      top: Math.round((r.top - oy - ty - sy * (f - d * oy)) * 100) / 100,
      opacity,
    };
  };
  const sample = () => {
    for (const el of document.querySelectorAll(POPUPS)) {
      if (!isOpened(el)) continue;
      const seen = layout(el);
      if (!seen) continue;
      const frames = watching.frames.get(el) ?? [];
      frames.push(seen);
      watching.frames.set(el, frames);
      (el as unknown as { __ouroPopupLayout?: typeof layout }).__ouroPopupLayout = layout;
    }
    watching.handle = requestAnimationFrame(sample);
  };
  watching.handle = requestAnimationFrame(sample);
}

// Stops watching, and names the popups that were drawn somewhere other than where they settle: at most one for the
// step, the first, with the frame, the place it was drawn and the place it settled. A popup that is gone or hidden by now
// has no place it settles, so it is not judged.
function findPopupJumps(): PageIssue[] {
  const state = window as unknown as { __ouroPopups?: Watching; __ouroCheckRef?: number };
  const watching = state.__ouroPopups;
  if (!watching) return [];
  cancelAnimationFrame(watching.handle);
  delete state.__ouroPopups;
  const reasonOf = (el: Element, name: string) => (el.getAttribute(name) ?? "").trim();
  const optedOut = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = reasonOf(n, "data-ouro-allow").split(/\s+/);
      if ((rules.includes("popup-first-frame") || rules.includes("all")) && reasonOf(n, "data-ouro-allow-why")) return true;
    }
    return false;
  };
  const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}`;
  for (const [el, frames] of watching.frames) {
    const layout = (el as unknown as { __ouroPopupLayout: (el: Element) => Seen | null }).__ouroPopupLayout;
    delete (el as unknown as { __ouroPopupLayout?: unknown }).__ouroPopupLayout;
    if (!el.isConnected || optedOut(el)) continue;
    const settled = layout(el);
    if (!settled) continue;
    const at = frames.findIndex((frame) => Math.abs(frame.left - settled.left) > 2 || Math.abs(frame.top - settled.top) > 2);
    if (at < 0) continue;
    const frame = frames[at]!;
    const away = Math.round(Math.hypot(frame.left - settled.left, frame.top - settled.top));
    state.__ouroCheckRef = (state.__ouroCheckRef ?? 0) + 1;
    const ref = `p${state.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${ref}`.trim());
    const where = (box: Seen) => `${Math.round(box.left)}, ${Math.round(box.top)}`;
    return [
      {
        ref,
        rule: "popup-first-frame",
        element: describe(el),
        detail: `a popup was drawn at ${where(frame)} on its ${at === 0 ? "first" : `frame ${at + 1} of ${frames.length}`} visible frame and settled at ${where(settled)}, ${away}px away: it was placed against one box and drawn in another; place it where it settles from its first frame (position: fixed for a popup measured against the viewport)`,
        value: away,
        budget: 2,
        unit: "px",
      },
    ];
  }
  return [];
}
