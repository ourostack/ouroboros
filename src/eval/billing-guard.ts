/**
 * The billing guard. Shadow, the blind interviews and live Slugger all bill and rate-limit on one Copilot login, so
 * before each eval run (`npm run eval`; the interviews keep their own pre-registered caps and don't consult it) the
 * eval reads that account's quota and refuses unless at least `MIN_LEFT_PCT` of it is left. A
 * token-billed account with unlimited premium interactions reads as 100% left. A missing reading refuses, since an
 * account the eval can't read could be one Slugger is about to run dry (design finding 9).
 */
import { emitNervesEvent } from "../nerves/runtime"
import type { QuotaSnapshot } from "./targets"

export const MIN_LEFT_PCT = 20

/** Why the account must not take another run, or undefined when it may. */
export function billingRefusal(account: string, snapshot: QuotaSnapshot): string | undefined {
  const left = snapshot.reading?.leftPct ?? undefined
  const why = left === undefined
    ? `no quota reading for ${account}`
    : left < MIN_LEFT_PCT ? `${account} has ${left}% of its quota left, under ${MIN_LEFT_PCT}%` : undefined
  if (why !== undefined) emitNervesEvent({ component: "eval", level: "warn", event: "eval.billing_guard_refused", message: "the billing guard refused a run", meta: { leftPct: left ?? null, tokenBased: snapshot.tokenBased } })
  return why
}
