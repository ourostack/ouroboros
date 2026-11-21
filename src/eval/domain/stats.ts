import { emitNervesEvent } from "../../nerves/runtime"

/** Wilson 95% score interval for `successes` passes out of `n` runs; null bounds when there were no runs. */
export function wilsonInterval(successes: number, n: number): { n: number; low: number | null; high: number | null } {
  if (!Number.isInteger(n) || !Number.isInteger(successes) || n < 0 || successes < 0 || successes > n) {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.wilson_interval_error",
      message: "interval counts are not a possible pass count", meta: { successes, n } })
    throw new Error("Invalid interval counts")
  }
  if (n === 0) return { n, low: null, high: null }
  const z = 1.959963984540054
  const p = successes / n, denominator = 1 + z * z / n
  const center = (p + z * z / (2 * n)) / denominator
  const radius = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
  return { n, low: Math.max(0, center - radius), high: Math.min(1, center + radius) }
}
