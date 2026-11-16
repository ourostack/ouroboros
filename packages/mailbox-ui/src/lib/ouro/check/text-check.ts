export { findTextIssues };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside its function. Text that is a bug
// once a person reads it, found by pattern in what the page shows or says: each drawn text node, and an element's title
// and aria-label. Code (code, pre, kbd, samp, var), scripts, editable text and anything not drawn are left out.
//
//   leaked-value   a value the program meant for itself: [object Object], an unfilled template ({{name}}, ${name}), a
//                  GUID or a hex id of 24 characters or more (one in a monospace font, or a GUID or a hash of 40 or 64
//                  after its label, "Tenant", "ID", "commit", "SHA-256", "digest", "@", or in a link's text, is shown on
//                  purpose), a translation key
//                  (settings.profile.saveButton), lorem ipsum, a developer's note (TODO:, TODO(, FIXME, XXX:; a bare
//                  TODO is a board's column), console.log, NaN, and undefined or null where a value goes: alone, after a
//                  label ("Owner: null"), twice ("undefined undefined"), after a greeting's comma ("Hello, undefined"),
//                  or beside a number or a currency ("$null", "undefined%"); in a sentence ("returns null") it is a word
//   odd-timestamp  a time no person should read: Invalid Date, the Unix epoch (1 January 1970, or 31 December 1969 west
//                  of Greenwich), year 0000, 0001 or 9999, a raw epoch number (10 or 13 digits, 2017 to 2033) as the
//                  whole text or after a time's label ("Updated", "at", "Last seen"; elsewhere it is an order or a
//                  message number), a machine timestamp (2026-11-09T13:17), Date's own string (GMT+0000 (…)), or a negative age ("-3
//                  minutes ago", "in -2 days"). No date is judged against the clock, so a run gives the same answer on
//                  any day.
//
// An element opts out of a rule with data-ouro-allow="<rule ids>" and a reason in data-ouro-allow-why, as the other rules
// do: a page about the Unix epoch may show 1 January 1970, and a message list shows people's own words. `element` names
// the element by its words, the same at every size; `detail` says what it shows and where.

function findTextIssues(): PageIssue[] {
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
  const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}`;
  const files = "pdf|docx?|xlsx?|pptx?|key|pages|numbers|png|jpe?g|gif|webp|avif|heic|svg|txt|md|csv|json|zip|mp[34]|mov|wav|html?";
  const units = "s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?";
  // undefined or null where a value goes, not as a word in a sentence.
  const slot = (word: string) =>
    new RegExp(
      [
        `(?<=^\\W*)${word}(?=\\W*$)`,
        `[:=] ?${word}\\b`,
        `\\b${word} ${word}\\b`,
        `, ${word}[!.]?$`,
        `[$€£¥#]${word}\\b|\\b${word} ?%|\\d ?${word}\\b|\\b${word} ?\\d`,
      ].join("|"),
    );
  // Each rule's kinds, the first that matches naming the finding. A pattern's leading guard (a start or a character
  // that is no part of a word) is trimmed from what the detail quotes.
  const kinds: Record<string, [string, RegExp][]> = {
    "leaked-value": [
      ["an object's default string", /\[object [A-Z]\w*\]/],
      ["an unfilled template", /\{\{[^{}]*\}\}|\$\{[^{}]*\}/],
      ["a GUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
      ["an id", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{24,}\b/i],
      // The whole text is the key: dotted names, with a capital or an underscore that a domain or a file name lacks.
      ["a translation key", new RegExp(`^(?!.*\\.(?:${files})$)(?=[\\w:.]*[A-Z_])(?:[a-z]\\w*:)?[a-z]\\w*(?:\\.\\w+){2,}$`)],
      ["lorem ipsum", /\blorem ipsum\b/i],
      ["a developer's note", /\b(?:TODO|XXX)[:(]|\bFIXME\b/],
      ["debug output", /\bconsole\.(?:log|debug)\b/],
      ["NaN", /\bNaN\b/],
      ["undefined", slot("undefined")],
      ["null", slot("null")],
    ],
    "odd-timestamp": [
      ["an invalid date", /\binvalid date\b/i],
      ["the Unix epoch", /\b(?:0?1 Jan(?:uary)? 1970|Jan(?:uary)? 0?1,? 1970|31 Dec(?:ember)? 1969|Dec(?:ember)? 31,? 1969|1970-01-01|1969-12-31|0?1\/0?1\/1970|12\/31\/1969|31\/12\/1969)\b/],
      ["a year no one lives in", /\b(?:0000|0001|9999)-\d\d-\d\d\b|\b\d{1,2}\/\d{1,2}\/(?:0000|0001|9999)\b|\b[A-Z][a-z]{2,8}\.? \d{1,2},? (?:0000|0001|9999)\b/],
      ["a raw epoch number", /^1[5-9]\d{8}(?:\d{3})?$|\b(?:updated|edited|created|modified|changed|sent|seen|posted|joined|started|ended|due|since|at|on)\b:? 1[5-9]\d{8}(?:\d{3})?(?![\w.,])/i],
      ["a machine timestamp", /\b\d{4}-\d\d-\d\dT\d\d:\d\d/],
      ["Date's own string", /GMT[+-]\d{4} \([^)]*\)/],
      ["a negative age", new RegExp(`(?:^|[^\\w])[-−]\\d+(?:\\.\\d+)? ?(?:${units}) ago\\b|\\bin [-−]\\d`)],
    ],
  };
  const sources: { el: Element; text: string; where: string }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) sources.push({ el: node.parentElement!, text: node.textContent!, where: "" });
  for (const el of document.body.querySelectorAll("[title], [aria-label]")) {
    for (const name of ["title", "aria-label"]) sources.push({ el, text: el.getAttribute(name) ?? "", where: ` in its ${name}` });
  }
  const skip = 'code, pre, kbd, samp, var, script, style, noscript, template, textarea, [contenteditable]:not([contenteditable="false"])';
  // An id shown on purpose: in a monospace font, as data is; or a GUID or a hash of 40 or 64 characters in a link's text,
  // or after its label ("Tenant", "SHA-256") in the same text or the text just before it.
  const label = /(?:\b(?:commit|sha(?:-?(?:1|256|512))?|hash|digest|checksum|build|revision|rev|tenant|id|guid|uuid)\b:?|@) ?$/i;
  const onPurpose = (index: number, words: string, el: Element) => {
    if (/mono|courier|consolas|menlo/i.test(getComputedStyle(el).fontFamily)) return true;
    const hash = /\b(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(words);
    if (!hash || words.match(/\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})\b/gi)!.length > 1) return false;
    const before = words.slice(0, hash.index);
    const previous = sources.slice(0, index).reduce((last, source) => (source.where || !source.text.trim() ? last : source.text.trim()), "");
    return Boolean(el.closest("a")) || label.test(before) || (!before && label.test(previous));
  };
  const found = new Map<Element, Set<string>>();
  const drawn = new Map<Element, boolean>();
  for (const [index, { el, text, where }] of sources.entries()) {
    const words = text.trim().replace(/\s+/g, " ");
    if (!words || el.closest(skip)) continue;
    if (!drawn.has(el)) drawn.set(el, el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
    if (!drawn.get(el)) continue;
    const done = found.get(el) ?? new Set<string>();
    for (const [rule, list] of Object.entries(kinds)) {
      if (done.has(rule) || optedOut(el, rule)) continue;
      const hit = list.find(([kind, pattern]) => pattern.test(words) && !((kind === "an id" || kind === "a GUID") && onPurpose(index, words, el)));
      if (!hit) continue;
      done.add(rule);
      found.set(el, done);
      const shown = hit[1].exec(words)![0].replace(/^[^\w[{$€£¥#−-]/, "").trim().replace(/[.,!?;:]$/, "");
      // Named by the words a person sees, so a finding in its title or aria-label names it as one in its text does.
      const name = (el.textContent!.trim() || el.getAttribute("aria-label") || el.getAttribute("title")!).replace(/\s+/g, " ");
      issues.push({ ref: ref(el), rule, element: `${describe(el)} "${name.slice(0, 40)}${name.length > 40 ? "…" : ""}"`, detail: `shows ${hit[0]}${where}: "${shown}"` });
    }
  }
  return issues;
}
