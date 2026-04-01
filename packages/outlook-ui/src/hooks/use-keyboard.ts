import { useEffect } from "react"
import type { NavigateFn } from "../navigation"

export function useKeyboardShortcuts(nav: NavigateFn | null) {
  useEffect(() => {
    if (!nav) return

    function handler(e: KeyboardEvent) {
      // Don't handle shortcuts when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key) {
        case "1": nav({ tab: "overview" }); break
        case "2": nav({ tab: "sessions" }); break
        case "3": nav({ tab: "work" }); break
        case "4": nav({ tab: "connections" }); break
        case "5": nav({ tab: "inner" }); break
        case "6": nav({ tab: "memory" }); break
        case "7": nav({ tab: "runtime" }); break
        case "Escape": {
          // Collapse any expanded panels (blur active element)
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          break
        }
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [nav])
}
