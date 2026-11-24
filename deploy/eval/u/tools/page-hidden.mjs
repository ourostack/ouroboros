// The hidden remove-copy-card test's driver (pre-registration section 4). It only renders the component and presses
// what the runner's judge picks (runtime/judge.mjs, which holds the rule and computes every verdict outside the page):
// the remove control, then the confirm control, then it waits for a status. It tells the judge how many times
// onRemove ran. Bundled with the component (lib.mjs bundle) and run only inside the jsdom page.
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import userEvent from "@testing-library/user-event"
import { takeHooks } from "./page-start.mjs"

// Taken before the component's code runs: it is imported only inside main().
const { report, step } = takeHooks()
const stringify = JSON.stringify
const later = setTimeout
const wait = (ms) => new Promise((resolve) => later(resolve, ms))

async function main() {
  const user = userEvent.setup({ delay: null, document })
  const { default: RemoveCopy } = await import("@component")
  const calls = []
  const onRemove = (...args) => { calls.push(args); return Promise.resolve() }
  const root = createRoot(document.getElementById("root"))
  flushSync(() => root.render(createElement(RemoveCopy, { onRemove })))
  await wait(50)

  const first = step("render")
  if (!first) return
  await user.click(first)
  await wait(100)

  // The confirm control may come in with an opening dialog's transition, so it is looked for over up to 2s.
  let confirm = null
  for (let waited = 0; waited <= 2000; waited += 100) {
    if (waited > 0) await wait(100)
    if (calls.length > 0 && waited === 0) { step("confirm", calls.length); return }
    confirm = step("confirm", calls.length)
    if (confirm) break
  }
  if (!confirm) { step("noConfirm"); return }
  await user.click(confirm)
  for (let i = 0; i < 50 && calls.length === 0; i += 1) await wait(20)
  await wait(100)
  const firstArg = calls.length > 0 && calls[0].length > 0 && typeof calls[0][0] === "number" ? calls[0][0] : -1
  if (!step("confirmed", calls.length, firstArg, stringify(calls.map((args) => args.map((arg) => (typeof arg === "number" || typeof arg === "string" ? arg : typeof arg)))))) return

  for (let i = 0; i < 100; i += 1) {
    if (step("status")) return
    await wait(20)
  }
}

main().catch((error) => step("failed", 0, 0, String(error && error.message || error))).finally(() => report())
