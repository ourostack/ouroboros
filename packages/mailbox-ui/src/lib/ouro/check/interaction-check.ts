export { findInteractionIssues };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside its function. Controls a person
// can't use without knowing why, after Apple's Human Interface Guidelines on buttons (a person should be able to tell
// why a button is unavailable) and WCAG 2.2's info and relationships (what explains a control is tied to it):
//
//   disabled-no-reason  a disabled control (disabled, aria-disabled="true", or in a disabled fieldset) that the page
//                       gives no reason for: no title, no aria-description and no aria-describedby text, on it or its
//                       disabled fieldset. Two cases explain themselves and pass: a control that moves one way (Previous,
//                       Next, Back, Earlier, Later, Increase, Zoom out, Undo) at its end, and a control beside an empty
//                       field in its form or group, such as Send under an empty message, which waits for the field
//
// An element opts out of a rule with data-ouro-allow="<rule ids>" and a reason in data-ouro-allow-why, as the other rules
// do. `element` names the control by its words, the same at every size.

function findInteractionIssues(): PageIssue[] {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `i${counter.__ouroCheckRef}`;
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
  const textOf = (ids: string | null) =>
    (ids ?? "")
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id)?.textContent : "") ?? "")
      .join(" ")
      .trim();
  const nameOf = (el: Element) => (el.getAttribute("aria-label") || textOf(el.getAttribute("aria-labelledby")) || (el as HTMLElement).innerText || (el as HTMLInputElement).value || "").trim().replace(/\s+/g, " ");
  const describe = (el: Element) => {
    const words = nameOf(el);
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
  const reasoned = (el: Element | null) => Boolean(el && ((el.getAttribute("title") ?? "").trim() || (el.getAttribute("aria-description") ?? "").trim() || textOf(el.getAttribute("aria-describedby"))));
  // Moves one way, so at its end there is nowhere to go: the end is the reason.
  const oneWay = /^(no )?(previous|prev|next|back|forward|first|last|earlier|later|older|newer|before|after|up|down|left|right|increase|decrease|increment|decrement|zoom (in|out)|scroll (up|down|left|right)|undo|redo)\b/i;
  // Waits for a field: an empty field in the control's form, or in a box around it up to three out, short of the page
  // itself, where a search box in the header would excuse every control.
  const fields = "input:not([type=hidden], [type=submit], [type=button], [type=reset], [type=image], [type=checkbox], [type=radio]), textarea, [contenteditable=''], [contenteditable=true], [role=textbox]";
  const empty = (field: Element) => ("value" in field ? !(field as HTMLInputElement).value.trim() : !field.textContent!.trim());
  const waits = (el: Element) => {
    const form = (el as HTMLButtonElement).form;
    if (form && [...form.querySelectorAll(fields)].some(empty)) return true;
    for (let n = el.parentElement, i = 0; n && n !== document.body && i < 3; n = n.parentElement, i++) if ([...n.querySelectorAll(fields)].some(empty)) return true;
    return false;
  };
  const controls = "button, input[type=submit], input[type=button], input[type=reset], input[type=image], [role=button], [role=menuitem], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=option]";
  for (const el of document.body.querySelectorAll(controls)) {
    const set = el.closest("fieldset[disabled]");
    const off = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || Boolean(set);
    if (!off || optedOut(el, "disabled-no-reason") || !drawn(el)) continue;
    if (reasoned(el) || reasoned(set) || oneWay.test(nameOf(el)) || waits(el)) continue;
    issues.push({ ref: ref(el), rule: "disabled-no-reason", element: describe(el), detail: "disabled, and nothing on the page says why: give it a title, or tie the words that say why to it with aria-describedby" });
  }
  return issues;
}
