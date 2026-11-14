import { emitNervesEvent } from "../nerves/runtime"

// A chat app's "still working" signal (a typing bubble, a status line) fades unless it is refreshed. Every sense
// refreshes it the same way: now, then on an interval, until the work is done. A failed refresh is ignored on
// purpose, because a missing typing bubble must never take down the reply it was decorating.

function refreshFailed(error: unknown): void {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.presence_refresh_failed", message: "a typing refresh failed", meta: { error: String(error) } })
}

/** Calls `tick` every `intervalMs` (and once now, if asked) until the returned stop runs. */
export function repeatEvery(tick: () => unknown, intervalMs: number, options: { now?: boolean } = {}): () => void {
  const safeTick = (): void => {
    try {
      void Promise.resolve(tick()).catch(refreshFailed)
    } catch (error) {
      refreshFailed(error)
    }
  }
  if (options.now) safeTick()
  const timer = setInterval(safeTick, intervalMs)
  return () => clearInterval(timer)
}

/** Runs `run` with `tick` refreshed now and every `intervalMs`, and stops refreshing when it settles. */
export async function whileRepeating<T>(tick: () => unknown, intervalMs: number, run: () => Promise<T>): Promise<T> {
  const stop = repeatEvery(tick, intervalMs, { now: true })
  try {
    return await run()
  } finally {
    stop()
  }
}
