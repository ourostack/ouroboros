// The hidden test's and the axe scan's verdicts (pre-registration section 4), computed in the runner's realm, never in
// the page's. The page's driver only renders and presses; at each step it asks the runner (page-runner.mjs) for a
// verdict, and the runner copies the live DOM from jsdom's own node tree (not through the page's objects, which the
// component can change) into a fresh, script-free jsdom document and judges the copy there. The copy keeps every
// element's attributes (so `hidden`, `aria-hidden` and `inert`), the text, and each element's computed display and
// visibility as its only style; nothing the component's code does to the page's objects reaches the copy.
//
// The rule, as the driver applies it:
//   1. the first press of the remove control doesn't call onRemove;
//   2. confirming calls onRemove(187) exactly once;
//   3. a role="status" region then says it's removed or done.
// The remove control is a button-like control whose accessible name says remove or delete: the one naming 187, or
// else the only one, or else the first that sits with 187 and not 189. The confirm control is then a remove, delete,
// confirm, yes, OK, continue or proceed control that the first press brought (one in a dialog first), never one that
// declines (its name starts with cancel, keep, no, back, close or don't) or names 189; or else the first control
// itself, when the press changed its name and it now asks to confirm. Pressing the same unchanged control again is no
// confirmation. "Then says removed or done" is a status region, not hidden from assistive technology, whose text the
// confirm changed so that one of its sentences says removed or done without saying it wasn't.
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { JSDOM, VirtualConsole } from "jsdom"

const require = createRequire(import.meta.url)
const { queryAllByRole } = require("@testing-library/dom")
const { computeAccessibleName } = require("dom-accessibility-api")
const { implForWrapper, wrapperForImpl } = require("jsdom/lib/jsdom/living/generated/utils.js")
const { domSymbolTree } = require("jsdom/lib/jsdom/living/helpers/internal-constants.js")
const MODULES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules")

const ROLES = ["button", "menuitem", "link"]
const REMOVE = /remove|delete/i
const CONFIRM = /remove|delete|confirm|yes|\bok\b|\bokay\b|continue|proceed/i
const DECLINE = /^\W*(cancel|keep|no|back|close|don't|do not|not now)\b/i
const DONE = /\b(removed|done)\b/i
const NOT_DONE = /\b(not|nothing|never|yet)\b|n't\b/i
/** One sentence (or clause) says removed or done without negating it: "Removed. This can't be undone." says done. */
export const saysDone = (text) => text.split(/[.!?;\n]+/).some((part) => DONE.test(part) && !NOT_DONE.test(part))

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])
const SKIP = new Set(["script", "style", "link", "template", "noscript", "iframe", "frame", "object", "embed"])
const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;")
const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;")
const ID = "data-u-id"

/**
 * The live page as HTML, read from jsdom's node tree. Each element gets a data-u-id the runner keeps across copies
 * (the component's own data-u-* attributes are dropped), and its computed display and visibility as its only style.
 */
function copyOf(window, idFor, computed) {
  const doc = implForWrapper(window.document)
  const byId = new Map()
  const walk = (node) => {
    if (node.nodeType === 3) return escapeText(node._data)
    if (node.nodeType !== 1) return ""
    const name = node._localName
    if (SKIP.has(name)) return ""
    const id = idFor(node)
    byId.set(id, node)
    const attrs = []
    for (const attr of node._attributeList) {
      const key = attr._qualifiedName
      if (key === "style" || key.startsWith("data-u-") || /^on/i.test(key)) continue
      if (name === "input" && key === "value") continue
      attrs.push(` ${key}="${escapeAttr(attr._value)}"`)
    }
    if (name === "input") attrs.push(` value="${escapeAttr(String(node.value ?? ""))}"`)
    const style = computed(wrapperForImpl(node))
    if (style) attrs.push(` style="${style}"`)
    attrs.push(` ${ID}="${id}"`)
    const inner = VOID.has(name) ? "" : domSymbolTree.childrenToArray(node).map(walk).join("")
    return `<${name}${attrs.join("")}>${VOID.has(name) ? "" : `${inner}</${name}>`}`
  }
  const title = escapeText(String(doc.title ?? ""))
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>${walk(doc.body)}</html>`
  return { html, byId }
}

function judgeable(html) {
  const dom = new JSDOM(html, { runScripts: "outside-only", virtualConsole: new VirtualConsole() })
  const { document } = dom.window
  const idOf = (el) => Number(el.getAttribute(ID))
  const exposed = (el) => el.closest("[inert]") === null
  const controls = () => ROLES.flatMap((role) => queryAllByRole(document.body, role)).filter(exposed).map((el) => ({ el, id: idOf(el), name: computeAccessibleName(el) }))
  const statuses = () => queryAllByRole(document.body, "status").filter(exposed).map((el) => ({ id: idOf(el), text: (el.textContent || "").trim() }))
  const byId = (id) => document.querySelector(`[${ID}="${id}"]`)
  return { dom, document, controls, statuses, byId }
}

const inDialog = (el) => el.closest('[role="dialog"],[role="alertdialog"],dialog') !== null
const within187 = (el, body) => {
  for (let at = el; at && at !== body; at = at.parentElement) {
    const text = at.textContent || ""
    if (text.includes("187")) return !text.includes("189")
  }
  return false
}

/**
 * The runner's judge for one page. `computed(el)` gives an element's style for the copy, read with the page's
 * getComputedStyle as the runner captured it before any page code ran.
 */
export function createJudge(window, computed) {
  // Ids follow jsdom's nodes, so a control keeps its id from one copy to the next.
  const ids = new WeakMap()
  let next = 0
  const idFor = (node) => { if (!ids.has(node)) ids.set(node, (next += 1)); return ids.get(node) }
  let live = new Map()
  const take = () => {
    const { html, byId } = copyOf(window, idFor, computed)
    live = byId
    return judgeable(html)
  }
  const result = { firstPressHeld: false, confirmedOnce187: false, statusSaysDone: false }
  const notes = []
  const state = { first: null, before: null, said: null, axeHtml: null, step: "render" }
  const wrapper = (id) => { const node = live.get(id); return node ? wrapperForImpl(node) : null }

  const steps = {
    // The rendered page: picks the remove control, and remembers which controls were there before the first press.
    render() {
      if (state.step !== "render") return null
      state.step = "pressed"
      const copy = take()
      const all = copy.controls()
      const removes = all.filter((c) => REMOVE.test(c.name) && !DECLINE.test(c.name))
      const first = removes.find((c) => c.name.includes("187")) ?? (removes.length === 1 ? removes[0] : removes.find((c) => within187(c.el, copy.document.body)))
      copy.dom.window.close()
      if (!first) { notes.push(`no remove control for 187 (remove controls: ${removes.map((c) => JSON.stringify(c.name)).join(", ") || "none"})`); state.step = "over"; return null }
      notes.push(`remove control ${JSON.stringify(first.name)}`)
      state.first = { id: first.id, name: first.name }
      state.before = new Set(all.map((c) => c.id))
      return wrapper(first.id)
    },
    // After the first press: `calls` is how many times onRemove ran. Picks the confirm control, if one has come.
    confirm(calls) {
      if (state.step === "pressed") {
        state.step = "confirming"
        result.firstPressHeld = calls === 0
        if (!result.firstPressHeld) { notes.push(`the first press called onRemove ${calls} time(s)`); state.step = "over"; return null }
      }
      if (state.step !== "confirming") return null
      const copy = take()
      const all = copy.controls()
      const candidates = all.filter((c) => c.id !== state.first.id && (!state.before.has(c.id) || inDialog(c.el)) && CONFIRM.test(c.name) && !DECLINE.test(c.name) && !c.name.includes("189"))
      const firstNow = copy.byId(state.first.id)
      const now = firstNow ? computeAccessibleName(firstNow) : ""
      const again = firstNow && now !== state.first.name && CONFIRM.test(now) && !DECLINE.test(now) ? { id: state.first.id, name: now } : undefined
      const confirm = candidates.find((c) => inDialog(c.el)) ?? candidates[0] ?? again
      if (confirm) {
        state.said = new Map(copy.statuses().map(({ id, text }) => [id, text]))
        state.step = "confirmed"
        notes.push(`confirm control ${JSON.stringify(confirm.name)}`)
      } else {
        state.last = `controls: ${all.map((c) => JSON.stringify(c.name)).join(", ") || "none"}; dialogs in the page: ${copy.document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog').length}`
      }
      copy.dom.window.close()
      return confirm ? wrapper(confirm.id) : null
    },
    // The driver gave up looking for a confirm control.
    noConfirm() {
      if (state.step !== "confirming") return null
      notes.push(`no confirm control after the first press (${state.last ?? "none"})`)
      state.step = "over"
      return null
    },
    // After the confirm press: onRemove's calls, as the driver recorded them.
    confirmed(calls, first, shown) {
      if (state.step !== "confirmed") return false
      result.confirmedOnce187 = calls === 1 && first === 187
      notes.push(`onRemove calls: ${String(shown).slice(0, 200)}`)
      state.step = result.confirmedOnce187 ? "status" : "over"
      return result.confirmedOnce187
    },
    // Looks once for a status region the confirm changed to say removed or done.
    status() {
      if (state.step !== "status") return false
      const copy = take()
      const now = copy.statuses()
      copy.dom.window.close()
      const done = now.find(({ id, text }) => state.said.get(id) !== text && saysDone(text))
      if (done) { result.statusSaysDone = true; notes.push(`status ${JSON.stringify(done.text)}`); state.step = "over"; return true }
      state.lastStatus = now.map(({ text }) => JSON.stringify(text)).join(", ") || "none"
      return false
    },
    // The driver's own steps failed (the component threw, say); the message is only a note.
    failed(_a, _b, message) {
      notes.push(`the test failed: ${message.slice(0, 300)}`)
      state.step = "over"
      return null
    },
    // The rendered page, for the axe scan once the page has closed.
    axe() {
      if (state.axeHtml !== null) return null
      state.axeHtml = copyOf(window, idFor, computed).html
      return null
    },
  }

  return {
    step(name, a, b, c) {
      if (typeof name !== "string" || !Object.hasOwn(steps, name)) return null
      return steps[name](typeof a === "number" ? a : -1, typeof b === "number" ? b : -1, typeof c === "string" ? c : "")
    },
    hidden() {
      if (state.step === "status") notes.push(`no status region says removed or done (status regions: ${state.lastStatus ?? "none"})`)
      if (state.step === "confirming") notes.push(`no confirm control after the first press (${state.last ?? "none"})`)
      return { ...result, detail: notes.join("; ") }
    },
    async axe(options, pageError) {
      if (state.axeHtml === null) return { error: `the page never rendered for the scan${pageError ? `: ${pageError}` : ""}` }
      const dom = new JSDOM(state.axeHtml, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/", virtualConsole: new VirtualConsole() })
      try {
        new vm.Script(fs.readFileSync(path.join(MODULES, "axe-core", "axe.min.js"), "utf8"), { filename: "axe.min.js" }).runInContext(dom.getInternalVMContext())
        const results = await dom.window.axe.run(dom.window.document, options)
        return { violations: results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")) })) }
      } catch (error) {
        return { error: `axe failed: ${String(error?.message ?? error)}` }
      } finally {
        dom.window.close()
      }
    },
  }
}
