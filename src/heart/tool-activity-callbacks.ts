import { humanReadableToolDescription } from "./tool-description"
import { emitNervesEvent } from "../nerves/runtime"

export interface ToolActivityOptions {
  /** Called with human-readable text on tool START (except hidden tools). */
  onDescription: (text: string) => void
  /** Called with result summary on tool END (debug mode only, success=true). */
  onResult: (text: string) => void
  /** Called with failure message on tool END when success=false. */
  onFailure: (text: string) => void
  /** Controls whether onResult is called on tool END. Read per-call so /debug toggle takes effect mid-conversation. */
  isDebug: () => boolean
}

export interface ToolActivityCallbacks {
  onToolStart: (name: string, args: Record<string, string>) => void
  onToolEnd: (name: string, summary: string, success: boolean) => void
}

export function createToolActivityCallbacks(options: ToolActivityOptions): ToolActivityCallbacks {
  emitNervesEvent({
    component: "engine",
    event: "engine.tool_activity_callbacks_created",
    message: "tool activity callbacks initialized",
    meta: {},
  })

  // Track the last description so we can reference it in END messages
  let lastDescription: string | null = null

  return {
    onToolStart(name: string, args: Record<string, string>): void {
      const description = humanReadableToolDescription(name, args)
      if (description === null) return // hidden tool (settle, rest, descend)
      lastDescription = description
      options.onDescription(description)
    },

    onToolEnd(name: string, summary: string, success: boolean): void {
      const desc = lastDescription ?? name
      // Strip trailing "..." from description for the result line
      const cleanDesc = desc.endsWith("...") ? desc.slice(0, -3) : desc
      if (!success) {
        options.onFailure(`\u2717 ${cleanDesc} — ${summary}`)
        return
      }
      if (options.isDebug()) {
        options.onResult(`\u2713 ${cleanDesc}`)
      }
    },
  }
}
