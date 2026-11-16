import type { ProviderRuntime } from "./core"
import { emitNervesEvent } from "../nerves/runtime"

const learned = new Map<string, number>()
const attempted = new Set<string>()

/** The context window a provider reported for this model, once learned. */
export function getLearnedContextWindow(model: string): number | undefined {
  return learned.get(model)
}

/**
 * Ask the provider once per model for its real context window and remember it. A provider that cannot say, or a failed
 * read, leaves the static table in model-capabilities.ts as the fallback, and says so in the log.
 */
export async function learnContextWindow(runtime: Pick<ProviderRuntime, "id" | "model" | "fetchContextWindow">): Promise<void> {
  const key = runtime.model
  if (learned.has(key) || attempted.has(key)) return
  attempted.add(key)
  if (!runtime.fetchContextWindow) return
  try {
    const tokens = await runtime.fetchContextWindow(AbortSignal.timeout(5000))
    if (tokens === undefined) throw new Error("the provider's model list has no context window for this model")
    learned.set(key, tokens)
    emitNervesEvent({
      component: "engine",
      event: "engine.context_window_learned",
      message: "context window read from the provider",
      meta: { provider: runtime.id, model: key, tokens },
    })
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "engine",
      event: "engine.context_window_fallback",
      message: "context window read failed; using the built-in estimate for this model",
      meta: { provider: runtime.id, model: key, reason: error instanceof Error ? error.message : String(error) },
    })
  }
}

export function resetLearnedContextWindowsForTests(): void {
  learned.clear()
  attempted.clear()
}
