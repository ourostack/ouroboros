// Page script for the axe scan: renders the component with a test onRemove, then runs axe's WCAG 2.x A and AA rules
// on the first render. Bundled with the component (lib.mjs bundle) and run only inside the jsdom page. Colour
// contrast is off: jsdom loads no stylesheet and paints nothing, so axe can't measure it in any arm.
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { takeReport } from "./page-start.mjs"

// Taken before the component's code runs: it is imported only below.
const report = takeReport()
const stringify = JSON.stringify
const axe = window.axe
const axeRun = axe.run
const later = setTimeout
const finish = (value) => report(stringify(value))
import("@component").then(({ default: RemoveCopy }) => {
  const root = createRoot(document.getElementById("root"))
  flushSync(() => root.render(createElement(RemoveCopy, { onRemove: () => Promise.resolve() })))
  later(() => {
    axeRun.call(axe,document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] })
      .then((results) => finish({ violations: results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")) })) }))
      .catch((error) => finish({ error: `axe failed: ${String(error && error.message || error)}` }))
  }, 50)
}).catch((error) => finish({ error: `rendering failed: ${String(error && error.message || error)}` }))
