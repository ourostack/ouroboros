/**
 * The model-spend ledger for eval runs, and for any other consumer that spends Ari's model access in sessions (the
 * blind interviews reuse it). It meters two things at once, whichever billing the account uses:
 * - premium requests: every model call costs the target's per-call multiplier, charged when the call is taken, so a
 *   call that fails or is aborted is still billed;
 * - credits (1 credit = $0.01, GitHub's AI credit): each call's input and output tokens at the target's prices, charged
 *   when the call ends. A call that reports no usage is charged its reserved worst case.
 *
 * Before a session starts, its consumer reserves the session's worst case (calls × per-call cost). The ledger refuses
 * the reservation when what is spent plus what other sessions hold plus this worst case would pass a cap, so no
 * session is cut off partway by another's spend. A session never takes a call that could pass its own credit
 * reservation either, so a cap can be passed only by what one call costs beyond its per-call estimate; the consumer
 * raises the estimate for later sessions from `maxCall`. Once the money really spent passes a cap, or `stop` is called (the
 * first 402 or 429), every later call and reservation is refused.
 */
import type { ProviderRuntime } from "../heart/core"
import type { UsageData } from "../heart/streaming"
import { emitNervesEvent } from "../nerves/runtime"

export type Cost = { premium: number; credits: number }
export type Caps = { premium?: number; credits?: number }
/** What one call costs: its premium-request multiplier, and credits per million input and output tokens. */
export type Pricing = { premiumPerCall: number; creditsPerMillionInput: number; creditsPerMillionOutput: number }

export type Hold = {
  /**
   * Before a model call: false past the hold's calls, once the ledger has stopped, or when one more call at the
   * per-call worst case would pass the credits this hold reserved; otherwise charges the call's premium requests.
   */
  take(): boolean
  /** Whether a call was refused because the hold's own credit reservation ran out (the estimate was too low). */
  cutShort(): boolean
  /** The most credits one call has cost on this hold. */
  maxCall(): number
  /** After the call: charges its credits from the usage it reported, or its reserved worst case when it reported none. */
  settle(usage: UsageData | undefined): void
  /** Ends the hold, giving back what it did not spend; returns what it spent. */
  release(): Cost
  spent(): Cost
}

export type Reservation = { calls: number; perCall: Cost; pricing: Pricing }

export type BudgetLedger = {
  reserve(label: string, worst: Reservation): Hold | { refused: string }
  stop(reason: string): void
  stopped(): string | undefined
  totals(): { spent: Cost; held: Cost; calls: number; caps: Caps }
}

const METERS = ["premium", "credits"] as const
const zero = (): Cost => ({ premium: 0, credits: 0 })
const round = (value: number): number => Math.round(value * 1e6) / 1e6
const finite = (value: number): boolean => Number.isFinite(value) && value >= 0

export function creditsOf(usage: UsageData, pricing: Pricing): number {
  return round((usage.input_tokens * pricing.creditsPerMillionInput + usage.output_tokens * pricing.creditsPerMillionOutput) / 1_000_000)
}

export function createBudgetLedger(caps: Caps): BudgetLedger {
  for (const meter of METERS) {
    const cap = caps[meter]
    if (cap !== undefined && !finite(cap)) throw new Error(`the ${meter} cap must be a number of at least 0`)
  }
  const spent = zero()
  const held = zero()
  let calls = 0
  let stopReason: string | undefined

  const stop = (reason: string): void => {
    if (stopReason !== undefined) return
    stopReason = reason
    emitNervesEvent({ component: "eval", level: "warn", event: "eval.budget_stopped", message: "the eval budget stopped all further model calls", meta: { reason, spent: { ...spent } } })
  }
  const charge = (meter: keyof Cost, amount: number): void => {
    spent[meter] = round(spent[meter] + amount)
    const cap = caps[meter]
    if (cap !== undefined && spent[meter] > cap) stop(`${meter} cap ${cap} passed: ${spent[meter]} spent`)
  }

  return {
    stop,
    stopped: () => stopReason,
    totals: () => ({ spent: { ...spent }, held: { ...held }, calls, caps: { ...caps } }),
    reserve(label, worst) {
      if (!Number.isInteger(worst.calls) || worst.calls < 1) throw new Error("a reservation needs at least 1 call")
      if (!METERS.every((meter) => finite(worst.perCall[meter]))) throw new Error("a reservation's per-call cost must be numbers of at least 0")
      if (stopReason !== undefined) return { refused: `stopped: ${stopReason}` }
      const total: Cost = { premium: round(worst.calls * worst.perCall.premium), credits: round(worst.calls * worst.perCall.credits) }
      for (const meter of METERS) {
        const cap = caps[meter]
        if (cap !== undefined && spent[meter] + held[meter] + total[meter] > cap) {
          const refused = `${label} would pass the ${meter} cap ${cap}: ${spent[meter]} spent, ${held[meter]} held, ${total[meter]} more at worst`
          emitNervesEvent({ component: "eval", event: "eval.budget_refused", message: "refused a reservation that could pass a cap", meta: { label, meter } })
          return { refused }
        }
      }
      for (const meter of METERS) held[meter] = round(held[meter] + total[meter])
      const remaining = { ...total }
      const mine = zero()
      let taken = 0
      let open = true
      let cut = false
      let maxCall = 0
      const unhold = (meter: keyof Cost, amount: number): void => {
        const back = Math.min(amount, remaining[meter])
        remaining[meter] = round(remaining[meter] - back)
        held[meter] = round(held[meter] - back)
      }
      emitNervesEvent({ component: "eval", event: "eval.budget_reserved", message: "reserved a session's worst-case model spend", meta: { label, ...total } })
      return {
        take() {
          if (!open || stopReason !== undefined || taken >= worst.calls) return false
          if (worst.perCall.credits > 0 && round(mine.credits + worst.perCall.credits) > total.credits) {
            cut = true
            emitNervesEvent({ component: "eval", level: "warn", event: "eval.budget_cut_short", message: "refused a call past its session's credit reservation", meta: { label, spent: mine.credits } })
            return false
          }
          taken += 1
          calls += 1
          unhold("premium", worst.perCall.premium)
          mine.premium = round(mine.premium + worst.perCall.premium)
          charge("premium", worst.perCall.premium)
          return true
        },
        settle(usage) {
          const credits = usage ? creditsOf(usage, worst.pricing) : worst.perCall.credits
          unhold("credits", worst.perCall.credits)
          mine.credits = round(mine.credits + credits)
          maxCall = Math.max(maxCall, credits)
          charge("credits", credits)
        },
        cutShort: () => cut,
        maxCall: () => maxCall,
        release() {
          open = false
          for (const meter of METERS) unhold(meter, remaining[meter])
          emitNervesEvent({ component: "eval", event: "eval.budget_released", message: "released a session's unspent reservation", meta: { label, ...mine } })
          return { ...mine }
        },
        spent: () => ({ ...mine }),
      }
    },
  }
}

const STOPPING_STATUS = new Set([402, 429])

/** The runtime with each call's usage settled on `hold`; a failed call is billed, and a 402, 429 or usage or rate limit stops the ledger. */
export function meteredRuntime(inner: ProviderRuntime, hold: Hold, ledger: BudgetLedger): ProviderRuntime {
  const streamTurn: ProviderRuntime["streamTurn"] = async (request) => {
    try {
      const result = await inner.streamTurn(request)
      hold.settle(result.usage)
      return result
    } catch (caught) {
      hold.settle(undefined)
      const error = caught instanceof Error ? caught : new Error(String(caught))
      const status = (error as Error & { status?: unknown }).status
      const classification = inner.classifyError(error)
      if ((typeof status === "number" && STOPPING_STATUS.has(status)) || classification === "usage-limit" || classification === "rate-limit") {
        ledger.stop(`the provider answered ${typeof status === "number" ? status : classification}: ${error.message}`)
      }
      throw error
    }
  }
  return new Proxy(inner, {
    get(target, property) {
      if (property === "streamTurn") return streamTurn
      const value: unknown = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
