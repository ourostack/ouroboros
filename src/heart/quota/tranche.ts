import { emitNervesEvent } from "../../nerves/runtime"

/**
 * One account's quota, as the Copilot app balancer (and the agents) see it.
 * `key` is `login@host`. `leftPct` is the share of included premium requests left (0-100).
 */
export interface QuotaReading {
  key: string
  leftPct: number | null
  burnPerH: number | null
  dryAt: string | null
  overageOk: boolean
  at: string | null
  reset?: string | null
  remaining?: number | null
  entitlement?: number | null
  source?: string
}

/** Fill every account to 30% used, then 60%, then 90%, then squeeze the last 10% from each (Ari, 2026-11-09). */
export const DEFAULT_TRANCHE_CAPS: readonly number[] = [30, 60, 90, 100]

/**
 * These mirror `usedPct`, `trancheCap` and `pickByTranche` in the Copilot app balancer
 * (desk `setup/quota-balance.mjs`), so agents and the app fill accounts the same way.
 */

/** Percent of included requests used, or null with no reading. */
export function usedPct(reading: QuotaReading | undefined): number | null {
  if (!reading || reading.leftPct === null) return null
  return Math.max(0, Math.min(100, 100 - reading.leftPct))
}

function byKey(readings: readonly QuotaReading[]): Map<string, QuotaReading> {
  return new Map(readings.map((reading) => [reading.key, reading]))
}

/**
 * The current cap: the lowest cap that some eligible account with a reading is still below. It rises only once
 * every eligible account has reached it. When every one is at 100 it stays 100.
 */
export function trancheCap(
  readings: readonly QuotaReading[],
  eligible: readonly string[],
  caps: readonly number[] = DEFAULT_TRANCHE_CAPS,
): number {
  const map = byKey(readings)
  const used = eligible.map((key) => usedPct(map.get(key))).filter((value): value is number => value !== null)
  const cap = caps.find((candidate) => used.some((value) => value < candidate)) ?? caps[caps.length - 1]
  emitNervesEvent({
    component: "engine",
    event: "engine.quota_tranche_cap",
    message: "computed the quota tranche cap",
    meta: { cap, eligible: eligible.length },
  })
  return cap
}

/**
 * Stay on `current` while it is eligible and below the cap; else the first account in `order` that is eligible
 * and below it, then any eligible one; null when none is (included requests spent everywhere: overage).
 */
export function pickByTranche(
  current: string | null,
  readings: readonly QuotaReading[],
  eligible: readonly string[],
  order: readonly string[],
  cap: number,
): string | null {
  const map = byKey(readings)
  const below = (key: string | null): key is string => {
    if (key === null || !eligible.includes(key)) return false
    const used = usedPct(map.get(key))
    return used !== null && used < cap
  }
  const picked = below(current) ? current : order.find(below) ?? eligible.find(below) ?? null
  emitNervesEvent({
    component: "engine",
    event: "engine.quota_tranche_pick",
    message: "picked an account by quota tranche",
    meta: { current, picked, cap },
  })
  return picked
}
