// Page script for the axe scan: renders the component with a test onRemove and hands the first render to the runner,
// which sends it as plain data to the grader's process, where axe's WCAG 2.x A and AA rules run on a script-free copy
// (runtime/judge.mjs), so the component can't reach axe. Bundled with the component (lib.mjs bundle) and run only
// inside the jsdom page. Colour contrast is off: jsdom paints nothing, so axe can't measure it in any arm.
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { takeHooks } from "./page-start.mjs"

// Taken before the component's code runs: it is imported only below.
const { report, step } = takeHooks()
const later = setTimeout
import("@component").then(({ default: RemoveCopy }) => {
  const root = createRoot(document.getElementById("root"))
  flushSync(() => root.render(createElement(RemoveCopy, { onRemove: () => Promise.resolve() })))
  later(() => { step("axe").finally(() => report()) }, 50)
}).catch(() => report())
