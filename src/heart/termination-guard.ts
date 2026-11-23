/**
 * Termination guards are signal listeners that clean up synchronously and then step aside, re-raising the signal
 * only when nothing else handles it (sync's git children and locks, pending claims). Each must not count another
 * guard as a handler of the signal, or two guards would each wait on the other and the process would never stop.
 */
const TERMINATION_GUARD = Symbol.for("ouro.terminationGuard")

/** Mark a listener as a termination guard. */
export function markTerminationGuard<T extends (...args: never[]) => unknown>(listener: T): T {
  Object.defineProperty(listener, TERMINATION_GUARD, { value: true })
  return listener
}

/** The listeners for a signal that are not termination guards: the process's own handlers. */
export function signalHandlersBesidesGuards(signal: NodeJS.Signals): Function[] {
  return process.rawListeners(signal).filter((listener) => (listener as unknown as Record<symbol, unknown>)[TERMINATION_GUARD] !== true)
}
