export { findFirstRunIssues };
export type { FirstRunOptions };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside its function. The rules a first
// run must keep on any page: from a fresh install the app goes to sign-in and then to the app, and whatever the person
// does on the way, they can't end up stuck on a blank screen, a dismissed step or a signed-out window that looks empty:
//
//   blank-pane         the pane a person looks at (the open modal dialog, else the main landmark, else the body) draws
//                      nothing to read and nothing to press, and names no progress (a progressbar, a busy region with a
//                      name, a status region with words, or words that end in "…")
//   dismissable-step   an open modal dialog that can be put away (a close control, or Escape, which every modal dialog
//                      takes) over a page that would strand the person: behind it the main landmark is blank, or, signed
//                      out, offers no way to sign in and no progress
//   signed-out-empty   a signed-out page (data-ouro-session="signed-out" on it or around it, or `signedOut`) that shows
//                      the empty state a signed-in person would see: an Ouro Empty, or words that say there is nothing
//                      ("All caught up", "No messages yet"), which tell a signed-out person nothing is wrong
//
// An element opts out of a rule with data-ouro-allow="<rule ids>" and a reason in data-ouro-allow-why, as the other rules
// do. `element` names the element the same way at every size; `detail` says what was read.

interface FirstRunOptions {
  /** The person is signed out, where the page doesn't say so with data-ouro-session. */
  signedOut?: boolean;
  /** Words on a control that signs in, as a regular expression's source, read without case. */
  signIn?: string;
  /** Words that say there is nothing here, beyond an Ouro Empty, as a regular expression's source, read without case. */
  empty?: string;
  /** Words that name progress, beyond a progressbar or a busy region, as a regular expression's source, read without case. */
  progress?: string;
}

function findFirstRunIssues({
  signedOut,
  signIn = "^(sign in|log in|sign up|get started|continue with)\\b",
  empty = "^(all caught up|inbox zero|nothing (here|new|to show|unread)( yet)?|no (chats|messages|conversations|activity|meetings|results|items|notifications|files|posts)( yet)?)\\b",
  progress = "(…|\\.\\.\\.)$|^(loading|signing|starting|getting|connecting|syncing|reading|preparing|setting up)\\b",
}: FirstRunOptions = {}): PageIssue[] {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `p${counter.__ouroCheckRef}`;
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
  const tidy = (text: string | null | undefined) => (text ?? "").trim().replace(/\s+/g, " ");
  const words = (el: Element) => tidy((el as HTMLElement).innerText);
  // The words an element draws itself, not its children's: text nodes directly inside it.
  const ownWords = (el: Element) => tidy([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(" "));
  const nameOf = (el: Element) => tidy(el.getAttribute("aria-label") || words(el) || (el as HTMLInputElement).value);
  const describe = (el: Element) => {
    const w = nameOf(el);
    const classes = [...el.classList].slice(0, 3);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes.length ? `.${classes.join(".")}` : ""}${w ? ` "${w.slice(0, 40)}${w.length > 40 ? "…" : ""}"` : ""}`;
  };
  const shown = (el: Element) => {
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) <= 0.05) return false;
    }
    return true;
  };
  // Drawn: on the page with a size, not hidden by itself or an ancestor. What is hidden from assistive tech only (inert,
  // aria-hidden, as behind an open modal or a name drawn beside its label) still counts: these rules judge what a person sees.
  const drawn = (el: Element) => {
    if (el.closest("[hidden], template")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && shown(el);
  };
  const progressWords = new RegExp(progress, "i");
  const signInWords = new RegExp(signIn, "i");
  const emptyWords = new RegExp(empty, "i");
  const controls =
    "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [role=textbox]";
  const enabled = (el: Element) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";
  const isProgress = (el: Element) =>
    el.matches("[role=progressbar], progress") ||
    (el.matches("[aria-busy=true]") && Boolean(el.getAttribute("aria-label") || words(el))) ||
    (el.matches("[role=status]") && Boolean(words(el))) ||
    progressWords.test(ownWords(el));
  const isControl = (el: Element) => el.matches(controls) && enabled(el);
  // A control with a name reads as one, though it is off or draws only an icon.
  const isRead = (el: Element) => Boolean(ownWords(el)) || (el.matches(controls) && Boolean(nameOf(el))) || el.matches("img[alt]:not([alt='']), svg[aria-label]:not([aria-label='']), [role=img][aria-label]:not([aria-label='']), canvas, video, iframe");
  // The first element in the pane (the pane too) that is drawn and passes `test`, or null. What an open modal over the pane
  // holds is the modal's, not the pane's: it goes when the modal does.
  const first = (pane: Element, test: (el: Element) => boolean) =>
    [pane, ...pane.querySelectorAll("*")].find((el) => !modals.some((m) => m.contains(el) && !m.contains(pane)) && test(el) && drawn(el)) ?? null;
  const holds = (pane: Element) => first(pane, (el) => isProgress(el) || isControl(el) || isRead(el)) !== null;
  const wayIn = (pane: Element) => first(pane, (el) => isProgress(el) || (isControl(el) && signInWords.test(nameOf(el)))) !== null;
  // The session where an element is: its own or nearest marker, else `signedOut`, else a signed-out marker on the page
  // with no signed-in one.
  const signedOutAt = (el: Element) => {
    const marker = el.closest("[data-ouro-session]");
    if (marker) return marker.getAttribute("data-ouro-session") === "signed-out";
    if (signedOut !== undefined) return signedOut;
    return document.querySelector('[data-ouro-session="signed-out"]') !== null && document.querySelector('[data-ouro-session="signed-in"]') === null;
  };
  // A landmark that is there even when it holds nothing: an empty main collapses to no height, and is still the pane.
  const present = (el: Element) => !el.closest("[hidden], template") && shown(el);
  const modals = [...document.querySelectorAll("dialog:modal, [role=dialog][aria-modal=true], [role=alertdialog][aria-modal=true]")].filter(drawn);
  const top = modals.at(-1) ?? null;
  const main = [...document.querySelectorAll("main, [role=main]")].find(present) ?? document.body;
  const pane = top ?? main;

  if (!optedOut(pane, "blank-pane") && !holds(pane)) {
    const what = top ? "the open dialog" : pane === document.body ? "the page" : "the main landmark";
    issues.push({ ref: ref(pane), rule: "blank-pane", element: describe(pane), detail: `${what} draws nothing to read, nothing to press and no named progress` });
  }

  if (top && !top.contains(main) && !optedOut(top, "dismissable-step")) {
    const close = first(top, (el) => el.matches("button, [role=button]") && enabled(el) && /^(close|dismiss|cancel|×|✕)$/i.test(nameOf(el)));
    const blank = !holds(main);
    if (blank || (signedOutAt(main) && !wayIn(main))) {
      const way = close ? `its "${nameOf(close)}" button or Escape` : "Escape";
      const onto = blank ? "a blank page: nothing to read, press or wait for" : "a signed-out page with no way to sign in";
      issues.push({ ref: ref(top), rule: "dismissable-step", element: describe(top), detail: `${way} puts it away onto ${onto}` });
    }
  }

  // Only a page that is signed out somewhere reads its headings and paragraphs, so a signed-in page pays nothing here.
  if (signedOut === true || document.querySelector('[data-ouro-session="signed-out"]')) {
    // Each empty state once: a status region or an Empty is one, with the words inside it.
    const seen: Element[] = [];
    for (const el of document.querySelectorAll('[data-ouro="empty"], h1, h2, h3, h4, h5, h6, p, [role=status], [role=heading]')) {
      const box = el.closest('[data-ouro="empty"]') ?? el;
      if (seen.some((done) => done.contains(box)) || !signedOutAt(box)) continue;
      if (box === el && !el.matches('[data-ouro="empty"]') && !emptyWords.test(words(el))) continue;
      seen.push(box);
      // An Empty that holds the way in (Sign in, or progress) is the signed-out screen itself.
      if (!drawn(box) || optedOut(box, "signed-out-empty") || (box.matches('[data-ouro="empty"]') && wayIn(box))) continue;
      issues.push({ ref: ref(box), rule: "signed-out-empty", element: describe(box), detail: `signed out, it says "${words(box).slice(0, 60)}", what a signed-in person with nothing new reads` });
    }
  }
  return issues;
}
