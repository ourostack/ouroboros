const PER_TEST_KEY = Symbol.for("ouroboros.nerves.per-test-events")

interface CapturedNervesEvent {
  component: string
  event: string
}

interface PerTestNervesState {
  currentTest: string | null
  events: Map<string, CapturedNervesEvent[]>
}

export function currentTestObservedNervesEvent(component: string, event: string): boolean {
  const scope = globalThis as Record<PropertyKey, unknown>
  const state = scope[PER_TEST_KEY] as PerTestNervesState | undefined
  if (!state?.currentTest) return false
  return (state.events.get(state.currentTest) ?? []).some((entry) => (
    entry.component === component && entry.event === event
  ))
}
