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

  // Track in-flight hidden tools so onToolEnd can SYMMETRICALLY suppress
  // emission for the same tools that onToolStart already suppresses.
  // Without this, a rejected hidden tool (e.g. settle blocked by the
  // mustResolveBeforeHandoff gate or the inner-dialog attention-queue gate)
  // would emit "✗ <previous visible tool's description> — <hidden tool's args summary>"
  // because lastDescription persists across calls and the hidden tool's summary
  // (built via summarizeArgs) leaks args like settle's `answer`/`intent` into
  // the visible chat. Counter map (not bool) so concurrent hidden starts don't
  // underflow if ends arrive in any order.
  const hiddenInFlight = new Map<string, number>()

  return {
    onToolStart(name: string, args: Record<string, string>): void {
      const description = humanReadableToolDescription(name, args)
      if (description === null) {
        // hidden tool (settle, rest, descend, observe, speak) — track so the
        // matching onToolEnd is also suppressed symmetrically.
        hiddenInFlight.set(name, (hiddenInFlight.get(name) ?? 0) + 1)
        return
      }
      lastDescription = description
      options.onDescription(description)
    },

    onToolEnd(name: string, summary: string, success: boolean): void {
      const hiddenCount = hiddenInFlight.get(name) ?? 0
      if (hiddenCount > 0) {
        // Hidden tool's start was suppressed; suppress its end too.
        if (hiddenCount === 1) hiddenInFlight.delete(name)
        else hiddenInFlight.set(name, hiddenCount - 1)
        return
      }
      const desc = lastDescription ?? name
      // Strip trailing "..." from description for the result line
      const cleanDesc = desc.endsWith("...") ? desc.slice(0, -3) : desc
      if (!success) {
        options.onFailure(`✗ ${cleanDesc} — ${summary}`)
        return
      }
      if (options.isDebug()) {
        options.onResult(`✓ ${cleanDesc}`)
      }
    },
  }
}
