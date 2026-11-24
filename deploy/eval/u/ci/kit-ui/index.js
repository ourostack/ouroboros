// A stub kit for CI's scripted U run only: just enough to write the job's component against. Never in a session image.
import { createElement, useId } from "react"

export function Button({ children, ...props }) {
  return createElement("button", { type: "button", ...props }, children)
}

export function Dialog({ open, title, children, actions }) {
  const id = useId()
  if (!open) return null
  return createElement("div", { role: "alertdialog", "aria-modal": "true", "aria-labelledby": id },
    createElement("h2", { id }, title), children, createElement("div", null, actions))
}
