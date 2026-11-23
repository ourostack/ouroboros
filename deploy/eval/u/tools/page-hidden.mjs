// The hidden remove-copy-card test (pre-registration section 4), written to the spec before any session:
//   1. the first press of the remove control doesn't call onRemove;
//   2. confirming calls onRemove(187) exactly once;
//   3. a role="status" region then says it's removed or done.
// The remove control is a button-like control whose accessible name says remove or delete: the one naming 187, or
// else the only one, or else the first that sits with 187 and not 189. The confirm control is then a remove, delete,
// confirm or yes control that the first press brought (one in a dialog first), never one that declines (its name
// starts with cancel, keep, no, back, close or don't) or names 189; or else the first control itself, when the press
// changed its name and it now asks to confirm. Pressing the same unchanged control again is no confirmation.
// "Then says removed or done" is a status region whose text the confirm changed to say removed or done, and not
// that nothing was removed.
// Bundled with the component (lib.mjs bundle) and run only inside the jsdom page; it reports a JSON string.
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { queryAllByRole } from "@testing-library/dom"
import { computeAccessibleName } from "dom-accessibility-api"
import userEvent from "@testing-library/user-event"
import { takeReport } from "./page-start.mjs"

// Taken before the component's code runs: it is imported only inside main().
const report = takeReport()

const ROLES = ["button", "menuitem", "link"]
const REMOVE = /remove|delete/i
const CONFIRM = /remove|delete|confirm|yes/i
const DECLINE = /^\W*(cancel|keep|no|back|close|don't|do not|not now)\b/i
const DONE = /\b(removed|done)\b/i
const NOT_DONE = /\b(not|nothing|never|yet)\b|n't\b/i
const saysDone = (text) => DONE.test(text) && !NOT_DONE.test(text)

const result = { firstPressHeld: false, confirmedOnce187: false, statusSaysDone: false, detail: "" }
const notes = []
const stringify = JSON.stringify
const later = setTimeout
const finish = () => { result.detail = notes.join("; "); report(stringify(result)) }
const wait = (ms) => new Promise((resolve) => later(resolve, ms))
const controls = () => ROLES.flatMap((role) => queryAllByRole(document.body, role)).map((el) => ({ el, name: computeAccessibleName(el) }))
const inDialog = (el) => el.closest('[role="dialog"],[role="alertdialog"],dialog') !== null
const within187 = (el) => {
  for (let at = el; at && at !== document.body; at = at.parentElement) {
    const text = at.textContent || ""
    if (text.includes("187")) return !text.includes("189")
  }
  return false
}

async function main() {
  const { default: RemoveCopy } = await import("@component")
  const calls = []
  const onRemove = (...args) => { calls.push(args); return Promise.resolve() }
  const root = createRoot(document.getElementById("root"))
  flushSync(() => root.render(createElement(RemoveCopy, { onRemove })))
  await wait(50)
  const user = userEvent.setup({ delay: null, document })

  const removes = controls().filter((c) => REMOVE.test(c.name) && !DECLINE.test(c.name))
  const first = removes.find((c) => c.name.includes("187")) ?? (removes.length === 1 ? removes[0] : removes.find((c) => within187(c.el)))
  if (!first) { notes.push(`no remove control for 187 (remove controls: ${removes.map((c) => JSON.stringify(c.name)).join(", ") || "none"})`); return }
  notes.push(`remove control ${JSON.stringify(first.name)}`)
  const before = new Set(controls().map((c) => c.el))
  await user.click(first.el)
  await wait(100)
  result.firstPressHeld = calls.length === 0
  if (!result.firstPressHeld) { notes.push(`the first press called onRemove ${calls.length} time(s)`); return }

  // The confirm control may come in with an opening dialog's transition, so it is looked for over up to 2s.
  let confirm
  for (let waited = 0; !confirm && waited <= 2000; waited += 100) {
    if (waited > 0) await wait(100)
    const candidates = controls().filter((c) => c.el !== first.el && (!before.has(c.el) || inDialog(c.el)) && CONFIRM.test(c.name) && !DECLINE.test(c.name) && !c.name.includes("189"))
    // A control that asks again on itself (press once to arm, again to confirm) is its own confirm control, once the
    // press has changed what it says.
    const now = first.el.isConnected ? computeAccessibleName(first.el) : ""
    const again = now !== first.name && CONFIRM.test(now) && !DECLINE.test(now) ? { el: first.el, name: now } : undefined
    confirm = candidates.find((c) => inDialog(c.el)) ?? candidates[0] ?? again
  }
  if (!confirm) {
    const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog').length
    notes.push(`no confirm control after the first press (controls: ${controls().map((c) => JSON.stringify(c.name)).join(", ") || "none"}; dialogs in the page: ${dialogs})`)
    return
  }
  notes.push(`confirm control ${JSON.stringify(confirm.name)}`)
  const said = () => queryAllByRole(document.body, "status").map((el) => ({ el, text: (el.textContent || "").trim() }))
  const saidBefore = new Map(said().map(({ el, text }) => [el, text]))
  await user.click(confirm.el)
  for (let i = 0; i < 50 && calls.length === 0; i += 1) await wait(20)
  await wait(100)
  result.confirmedOnce187 = calls.length === 1 && calls[0].length >= 1 && calls[0][0] === 187
  notes.push(`onRemove calls: ${JSON.stringify(calls)}`)
  if (!result.confirmedOnce187) return

  for (let i = 0; i < 100; i += 1) {
    const done = said().find(({ el, text }) => saidBefore.get(el) !== text && saysDone(text))
    if (done) { result.statusSaysDone = true; notes.push(`status ${JSON.stringify(done.text)}`); return }
    await wait(20)
  }
  notes.push(`no status region says removed or done (status regions: ${queryAllByRole(document.body, "status").map((el) => JSON.stringify((el.textContent || "").trim())).join(", ") || "none"})`)
}

main().catch((error) => notes.push(`the test failed: ${String(error && error.message || error)}`)).finally(finish)
