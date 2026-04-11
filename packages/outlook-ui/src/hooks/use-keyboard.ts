import { useEffect } from "react"
import type { NavigateFn } from "../navigation"

export function useKeyboardShortcuts(nav: NavigateFn | null) {
  useEffect(() => {
    if (!nav) return
    const navigate = nav

    function handler(e: KeyboardEvent) {
      // Don't handle shortcuts when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key) {
        case "1": navigate({ tab: "overview" }); break
        case "2": navigate({ tab: "sessions" }); break
        case "3": navigate({ tab: "work" }); break
        case "4": navigate({ tab: "connections" }); break
        case "5": navigate({ tab: "inner" }); break
        case "6": navigate({ tab: "memory" }); break
        case "7": navigate({ tab: "runtime" }); break
        case "Escape": {
          // Collapse expanded panels by blurring the active element.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          break
        }
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [nav])
}
