// The hidden test's and the axe scan's verdicts (pre-registration section 4), computed in the grader's process, where
// no page code ever runs. The page runner (page-runner.mjs) sends a plain-data snapshot of the live DOM at each of
// the driver's steps; this judge rebuilds it as a fresh, script-free jsdom document with DOM calls (so nothing is
// parsed again and every element stays where it was), judges the copy, and answers with the control the driver
// should press. The copy keeps every element and attribute as the page had them (so `hidden`, `aria-hidden` and
// `inert`), the text, the head, and each element's computed display and visibility, fixed with !important over its
// own inline style.
//
// The rule, as the driver applies it:
//   1. the first press of the remove control doesn't call onRemove: no call by the moment the confirm control is
//      pressed, which is a random 0.5 to 1.5 s after it appears, and, once the rest has passed, none within 5 s of
//      pressing it in a fresh render that is never confirmed (the holding check);
//   2. confirming calls onRemove(187) exactly once: calls made after the confirm press;
//   3. a role="status" region then says it's removed or done.
// The remove control is a button-like control whose accessible name says remove or delete: the one naming 187, or
// else the only one, or else the first that sits with 187 and not 189. The confirm control is a control the first
// press brought (or one in a dialog), whose name starts with remove or delete, or else says confirm, yes, OK,
// continue or proceed without declining; never one that names 189 and not 187. Remove and delete names go first, then
// controls in a dialog. Or else it is the first control itself, when the press changed its name and it now asks to
// confirm. Pressing the same unchanged control again is no confirmation.
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { JSDOM, VirtualConsole } from "jsdom"

const require = createRequire(import.meta.url)
const { queryAllByRole, isInaccessible } = require("@testing-library/dom")
const { computeAccessibleName } = require("dom-accessibility-api")
const { setAttributeValue } = require("jsdom/lib/jsdom/living/attributes.js")
const { createElement: createElementImpl } = require("jsdom/lib/jsdom/living/helpers/create-element.js")
const { implForWrapper, wrapperForImpl } = require("jsdom/lib/jsdom/living/generated/utils.js")
const MODULES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules")

const ROLES = ["button", "menuitem", "link"]
const HTML = "http://www.w3.org/1999/xhtml"
const AXE = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] }

// Control names.
const STARTS_REMOVE = /^\W*(remove|delete)\b/i
const REMOVE = /\b(remove|delete)/i
const CONFIRM = /\b(remove|delete|discard|confirm|yes|ok|okay|continue|proceed|sure|go ahead|do it)\b/i
// A decline: these words anywhere ("Continue without removing", "Keep it"), or no, back or close first.
const DECLINE = /\b(cancel|keep|without|don't|do not|not now|not sure|never ?mind)\b|^\W*(no|back|close|go back)\b/i
const names189 = (name) => name.includes("189") && !name.includes("187")
// Typographic apostrophes ("Don’t remove", "wasn’t removed") read as the plain one.
const plainQuotes = (text) => text.replace(/[‘’ʼ′]/g, "'")
/** A name that confirms removing: it starts with remove or delete, or it confirms and doesn't decline. */
export const confirms = (raw) => { const name = plainQuotes(raw); return !names189(name) && (STARTS_REMOVE.test(name) || (CONFIRM.test(name) && !DECLINE.test(name))) }
/** A name for the remove control: it says remove or delete and doesn't decline, or it starts with remove or delete. */
const removes = (raw) => { const name = plainQuotes(raw); return STARTS_REMOVE.test(name) || (REMOVE.test(name) && !DECLINE.test(name)) }

// Status text. A sentence claims the removal when it says removed or done. The claim is taken back by a negation or
// a future before it in its own clause ("Copy 187 was not removed", "will be removed", "Nothing was removed"), or by
// the sentence being a question; and the whole status by the removal failing anywhere ("Removal failed. Done.").
// Words after the claim don't take it back: "Copy 187 was removed and won't come back" says it's removed.
const CLAIM = /\b(removed|done)\b/i
const TAKES_BACK = /\b(not|no|nothing|none|never|cannot|unable|will|would|could|should|shall|going to|about to|if|once|when|being|to be)\b|n't\b/i
// Those words count only in the claim's own clause: "You won't see it again — it has been removed" says removed.
// An aside in brackets or between paired dashes is its own clause ("Copy 187 — the one you couldn't read — has been
// removed"), as is what comes after because, since, and, but or so; "no longer" takes nothing back.
const clauseStart = (raw) => {
  const before = raw.replace(/\([^()]*\)|\[[^\]]*\]|[–—][^–—]*[–—]|\s-\s.*?\s-\s/g, " ").replace(/\bno longer\b/gi, " ")
  let at = 0
  for (const m of before.matchAll(/[,:–—]|\s-\s|\b(because|since|and|but|so)\b/gi)) at = m.index + m[0].length
  return before.slice(at)
}
// A failure of the removal itself, anywhere in the status: "Removal failed. Done."
const FAILURE = /\bremov\w*\s+(has\s+|was\s+|is\s+)?fail|\bfail(s|ed)?\s+to\s+remov|\b(could\s?n(o|')t|unable\s+to|can\s?n(o|')t)\s+(be\s+)?remov|\berror\s+remov/i
/** Says it's removed or done: at least one sentence claims it, and nothing takes a claim back. */
export function saysDone(raw) {
  const text = plainQuotes(raw)
  if (FAILURE.test(text)) return false
  const sentences = text.match(/[^.!?;\n]+[.!?;\n]*/g) ?? []
  let claimed = false
  for (const sentence of sentences) {
    const found = CLAIM.exec(sentence)
    if (!found) continue
    if (sentence.trim().endsWith("?") || TAKES_BACK.test(clauseStart(sentence.slice(0, found.index)))) return false
    claimed = true
  }
  return claimed
}

/** The snapshot as a script-free document built with DOM calls; `ids` maps each copied element to the page's id. */
export function copyOf(snap, { visual = false } = {}) {
  const dom = new JSDOM('<!doctype html><html lang="en"><head></head><body></body></html>', { runScripts: "outside-only", pretendToBeVisual: visual, url: "http://localhost/", virtualConsole: new VirtualConsole() })
  const { document } = dom.window
  const ids = new Map()
  const byId = new Map()
  const safe = (value) => (/^[a-z-]+$/.test(value) ? value : "")
  const docImpl = implForWrapper(document)
  const text = (value) => (value === null || value === undefined ? null : String(value))
  const make = (node) => {
    if (typeof node === "string") return document.createTextNode(node)
    const [ns, prefix, local] = node.e
    // Made and given attributes through jsdom's own steps, as the page's lists held them: createElementNS and
    // setAttributeNS would refuse names a page legitimately has (React sets xmlns, xmlns:xlink and data-a:b with
    // setAttribute, in no namespace).
    const el = wrapperForImpl(createElementImpl(docImpl, String(local), text(ns), text(prefix)))
    const impl = implForWrapper(el)
    let style = ""
    for (const [attrNs, attrPrefix, attrLocal, value] of node.a) {
      if (attrNs === null && /^on/i.test(attrLocal)) continue
      if (attrNs === null && attrLocal === "style") { style = value; continue }
      setAttributeValue(impl, String(attrLocal), String(value), text(attrPrefix), text(attrNs))
    }
    const display = safe(node.d)
    const visibility = safe(node.v)
    // The page's own inline style, then its computed display and visibility set over it as declarations.
    el.setAttribute("style", style)
    if (display) el.style.setProperty("display", display, "important")
    if (visibility) el.style.setProperty("visibility", visibility, "important")
    if (typeof node.val === "string" && ns === HTML && local === "input") el.value = node.val
    // Stylesheets stay out: each element's display and visibility are already fixed from the page, and the page's
    // selectors would otherwise be compiled into code in this process by jsdom's selector engine.
    for (const child of node.k) if (typeof child === "string" || !(child.e[2] === "style" || (child.e[2] === "link" && child.e[0] === HTML))) el.appendChild(make(child))
    ids.set(el, node.i)
    byId.set(node.i, el)
    return el
  }
  // The root is filtered like any child (a <style> or <link> root becomes an empty <html>), and a copy that still
  // holds a stylesheet is refused, so no selector of the page's is ever compiled in this process.
  const sheet = (node) => typeof node !== "string" && (node.e[2] === "style" || (node.e[2] === "link" && node.e[0] === HTML))
  document.replaceChild(sheet(snap) ? document.createElementNS(HTML, "html") : make(snap), document.documentElement)
  if (document.styleSheets.length > 0) throw new Error("the copy holds a stylesheet")
  return { dom, document, ids, byId }
}

/** A copy for judging: the controls and status regions it exposes to assistive technology. */
function judgeable(snap) {
  const copy = copyOf(snap)
  const { document, ids } = copy
  const body = document.body ?? document.documentElement
  const exposed = (el) => el.closest("[inert]") === null
  const controls = () => ROLES.flatMap((role) => queryAllByRole(body, role)).filter(exposed).map((el) => ({ el, id: ids.get(el), name: computeAccessibleName(el) }))
  // A status's text as heard: its hidden descendants left out.
  const heard = (el) => {
    let text = ""
    for (const child of el.childNodes) {
      if (child.nodeType === 3) text += child.data
      else if (child.nodeType === 1 && !isInaccessible(child)) {
        // A block (or a line break) is heard apart from its neighbours; jsdom gives an inline element's display as "".
        const display = child.ownerDocument.defaultView.getComputedStyle(child).display
        const apart = child.localName === "br" || !(display === "" || display === "inline" || display === "contents")
        text += apart ? `\n${heard(child)}\n` : heard(child)
      }
    }
    return text
  }
  const statuses = () => queryAllByRole(body, "status").filter(exposed).map((el) => ({ id: ids.get(el), text: heard(el).replace(/[^\S\n]+/g, " ").replace(/\s*\n\s*/g, "\n").trim() }))
  return { ...copy, body, controls, statuses }
}

const inDialog = (el) => el.closest('[role="dialog"],[role="alertdialog"],dialog') !== null
const within187 = (el, body) => {
  for (let at = el; at && at !== body; at = at.parentElement) {
    const text = at.textContent || ""
    if (text.includes("187")) return !text.includes("189")
  }
  return false
}
const randomDelay = () => 500 + Math.floor(Math.random() * 1001)

/** The judge for one page: `step(message)` answers one of the runner's steps with {pick, value, delay}. */
export function createJudge() {
  const result = { firstPressHeld: false, confirmedOnce187: false, statusSaysDone: false }
  const notes = []
  const state = { first: null, before: null, said: null, axeSnap: null, step: "render", hold: "none", lastStatus: null, last: null }
  const answer = (pick = null, value = false, delay = 0) => ({ pick, value, delay })
  const close = (copy) => copy.dom.window.close()
  // The remove control in a rendered page: the one naming 187, or else the only one, or else the first with 187.
  const pickRemove = (snap) => {
    const copy = judgeable(snap)
    const all = copy.controls()
    const candidates = all.filter((c) => removes(c.name))
    const first = candidates.find((c) => c.name.includes("187")) ?? (candidates.length === 1 ? candidates[0] : candidates.find((c) => within187(c.el, copy.body)))
    close(copy)
    return { first, all, candidates }
  }

  const steps = {
    // The rendered page: picks the remove control, and remembers which controls were there before the first press.
    render({ snap }) {
      if (state.step !== "render") return answer()
      state.step = "pressed"
      const { first, all, candidates } = pickRemove(snap)
      if (!first) { notes.push(`no remove control for 187 (remove controls: ${candidates.map((c) => JSON.stringify(c.name)).join(", ") || "none"})`); state.step = "over"; return answer() }
      notes.push(`remove control ${JSON.stringify(first.name)}`)
      state.first = { id: first.id, name: first.name }
      state.before = new Set(all.map((c) => c.id))
      return answer(first.id)
    },
    // After the first press, while the driver looks for the confirm control. Once one is found it is handed over
    // after a random 0.5 to 1.5 s, so a first press that calls onRemove a little later is still caught.
    confirm({ snap }) {
      if (state.step === "pressed") state.step = "confirming"
      if (state.step !== "confirming") return answer()
      const copy = judgeable(snap)
      const all = copy.controls()
      const candidates = all.filter((c) => c.id !== state.first.id && (!state.before.has(c.id) || inDialog(c.el)) && confirms(c.name))
      const firstNow = copy.byId.get(state.first.id)
      const now = firstNow ? computeAccessibleName(firstNow) : ""
      const again = firstNow && now !== state.first.name && confirms(now) ? { id: state.first.id, name: now } : undefined
      const rank = (c) => (STARTS_REMOVE.test(c.name) ? 0 : 2) + (inDialog(c.el) ? 0 : 1)
      const confirm = [...candidates].sort((x, y) => rank(x) - rank(y))[0] ?? again
      if (!confirm) state.last = `controls: ${all.map((c) => JSON.stringify(c.name)).join(", ") || "none"}; dialogs in the page: ${copy.document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog').length}`
      close(copy)
      if (!confirm) return answer()
      state.step = "picked"
      notes.push(`confirm control ${JSON.stringify(confirm.name)}`)
      return answer(confirm.id, false, randomDelay())
    },
    // The driver gave up looking for a confirm control; `a` is how many times onRemove ran after the first press.
    noConfirm({ a }) {
      if (state.step !== "confirming" && state.step !== "pressed") return answer()
      notes.push(`no confirm control after the first press (${state.last ?? "none"})`)
      result.firstPressHeld = a === 0
      if (a > 0) notes.push(`the first press called onRemove ${a} time(s)`)
      state.step = "over"
      return answer()
    },
    // The moment of the confirm press: `a` is how many times onRemove has run since the first press.
    press({ a, snap }) {
      if (state.step !== "picked") return answer()
      result.firstPressHeld = a === 0
      if (!result.firstPressHeld) { notes.push(`the first press called onRemove ${a} time(s) before the confirm press`); state.step = "over"; return answer() }
      const copy = judgeable(snap)
      state.said = new Map(copy.statuses().map(({ id, text }) => [id, text]))
      close(copy)
      state.step = "pressing"
      return answer(null, true)
    },
    // After the confirm press: the calls made after it, as the driver recorded them.
    confirmed({ a, b, c }) {
      if (state.step !== "pressing") return answer()
      result.confirmedOnce187 = a === 1 && b === 187
      notes.push(`onRemove calls after the confirm press: ${c.slice(0, 200)}`)
      state.step = result.confirmedOnce187 ? "status" : "over"
      state.hold = "due"
      return answer(null, result.confirmedOnce187)
    },
    // Looks once for a status region the confirm changed to say removed or done.
    status({ snap }) {
      if (state.step !== "status") return answer()
      const copy = judgeable(snap)
      const now = copy.statuses()
      close(copy)
      const done = now.find(({ id, text }) => state.said.get(id) !== text && saysDone(text))
      if (done) { result.statusSaysDone = true; notes.push(`status ${JSON.stringify(done.text)}`); state.step = "over"; return answer(null, true) }
      state.lastStatus = now.map(({ text }) => JSON.stringify(text)).join(", ") || "none"
      return answer()
    },
    // The holding check, once the confirm has been pressed (whatever came of it): a fresh render whose remove control
    // is pressed and never confirmed, so nothing may be removed in the next 5 s.
    holdRender({ snap }) {
      if (state.hold !== "due") return answer()
      const { first } = pickRemove(snap)
      if (!first) { notes.push("holding check: no remove control in a fresh render"); state.hold = "done"; result.firstPressHeld = false; return answer() }
      state.hold = "holding"
      return answer(first.id)
    },
    held({ a, snap }) {
      if (state.hold !== "holding") return answer()
      state.hold = "done"
      if (a === 0) { notes.push("holding check: no onRemove call in 5 s without a confirm"); return answer(null, true) }
      result.firstPressHeld = false
      const copy = judgeable(snap)
      const undo = copy.controls().some((c) => /\bundo\b/i.test(c.name))
      close(copy)
      notes.push(`holding check: without a confirm, the first press called onRemove ${a} time(s) within 5 s${undo ? " (an undo control showed: an auto-commit after undo)" : ""}`)
      return answer()
    },
    // The driver's own steps failed (the component threw, say); the message is only a note.
    failed({ c }) {
      notes.push(`the test failed: ${c.slice(0, 300)}`)
      if (state.hold === "due" || state.hold === "holding") { result.firstPressHeld = false; state.hold = "done" }
      state.step = "over"
      return answer()
    },
    // The rendered page, for the axe scan once the page has closed.
    axe({ snap }) {
      if (state.axeSnap === null) state.axeSnap = snap
      return answer()
    },
  }

  return {
    step(message) {
      const name = message?.name
      if (typeof name !== "string" || !Object.hasOwn(steps, name) || typeof message.snap !== "object" || message.snap === null) return answer()
      try {
        return steps[name](message)
      } catch (error) {
        notes.push(`the copy failed: ${String(error?.message ?? error).slice(0, 200)}`)
        state.step = "over"
        return answer()
      }
    },
    hidden() {
      if (state.step === "status") notes.push(`no status region says removed or done (status regions: ${state.lastStatus ?? "none"})`)
      if (state.step === "confirming") notes.push(`no confirm control after the first press (${state.last ?? "none"})`)
      if (state.hold === "due" || state.hold === "holding") { result.firstPressHeld = false; notes.push("the holding check didn't finish") }
      return { ...result, detail: notes.join("; ") }
    },
    async axe(pageError) {
      if (state.axeSnap === null) return { error: `the page never rendered for the scan${pageError ? `: ${pageError}` : ""}` }
      let copy
      try {
        copy = copyOf(state.axeSnap, { visual: true })
        new vm.Script(fs.readFileSync(path.join(MODULES, "axe-core", "axe.min.js"), "utf8"), { filename: "axe.min.js" }).runInContext(copy.dom.getInternalVMContext())
        const results = await copy.dom.window.axe.run(copy.document, AXE)
        return { violations: results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")) })) }
      } catch (error) {
        return { error: `axe failed: ${String(error?.message ?? error)}` }
      } finally {
        copy?.dom.window.close()
      }
    },
  }
}
