// Page script for the axe scan: renders the component with a test onRemove and hands the first render to the runner,
// which runs axe's WCAG 2.x A and AA rules on a script-free copy of it outside the page (runtime/judge.mjs), so the
// component can't reach axe. Bundled with the component (lib.mjs bundle) and run only inside the jsdom page. Colour
// contrast is off: jsdom loads no stylesheet and paints nothing, so axe can't measure it in any arm.
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
  later(() => { step("axe"); report() }, 50)
}).catch(() => report())
