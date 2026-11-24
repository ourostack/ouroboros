/**
 * The interviews' latch, on the eval's budget ledger (`../budget`). Before a session starts it reserves the session's
 * worst case, `reserve(units)` model calls at the target's per-call premium multiplier and per-call credit estimate;
 * when that could pass a cap the session does not start, so none is cut off partway (section 5). Inside a session each
 * conversation gets its own call limit (section 4): 12 for a job, 2 for its debrief, 1 each for the choice and the
 * blinding check. A call past a limit is refused before it is sent, and so is a call the session's hold refuses.
 *
 * Every call goes through `guardedRuntime`, the host's last step before the provider: it scans the whole request
 * (system prompt, tools, messages and tool results) for the brand pattern first and refuses a match unsent, voiding
 * the session (section 3), then takes the conversation's call, then calls the metered runtime, which settles the
 * call's measured cost on the hold. Each call's usage is kept for the report.
 */
import type { ProviderRuntime, ProviderTurnRequest } from "../../heart/core"
import type { UsageData } from "../../heart/streaming"
import { emitNervesEvent } from "../../nerves/runtime"
import { creditsOf, meteredRuntime, type BudgetLedger, type Cost, type Hold, type Pricing } from "../budget"
import { brandHits } from "./protocol"
import { rewriteRequest, type Replacement, type RewriteCounts } from "./rewrite"

/**
 * A session's most calls: three jobs at 12, three debriefs at 2, the choice and the blinding check at 1, and the one
 * nudge the choice may get (36 + 6 + 2 + 1). The pilot amendment of 2026-11-23 reserves the nudge's call too.
 */
export const SESSION_CALLS = 45

export type ConversationKind = "job" | "debrief" | "choose" | "identify"
export const CALL_LIMITS: Readonly<Record<ConversationKind, number>> = { job: 12, debrief: 2, choose: 1, identify: 1 }

export type Gate = {
  kind: ConversationKind
  /** Takes one of the conversation's calls on the session's hold; false, with `refused()` saying why, when it cannot. */
  take(): boolean
  /** Lets one more call through, once: the choice's nudge (section 4). */
  allowOneMore(): void
  refused(): string | null
  calls(): number
}

export type CallRecord = { kind: ConversationKind; usage: UsageData | null; credits: number; sent: boolean }

export type SessionLatch = {
  hold: Hold
  gate(kind: ConversationKind): Gate
  /** The brand words of the first request refused for them, or null while no request has had any. */
  voided(): string[] | null
  calls(): CallRecord[]
  release(): Cost
}

export type InterviewLatch = {
  reserve(label: string, units?: number): SessionLatch | { refused: string }
  ledger: BudgetLedger
}

export function createInterviewLatch(input: { ledger: BudgetLedger; pricing: Pricing; perCall(): Cost }): InterviewLatch {
  return {
    ledger: input.ledger,
    reserve(label, units = SESSION_CALLS) {
      const hold = input.ledger.reserve(label, { calls: units, perCall: input.perCall(), pricing: input.pricing })
      if ("refused" in hold) return hold
      let voided: string[] | null = null
      const records: CallRecord[] = []
      const latch: SessionLatch & { _void(hits: string[]): void; _record(entry: CallRecord): void } = {
        hold,
        voided: () => voided,
        calls: () => [...records],
        release: () => hold.release(),
        _void: (hits) => { voided ??= hits },
        _record: (entry) => { records.push(entry) },
        gate(kind) {
          let limit = CALL_LIMITS[kind]
          let taken = 0
          let refused: string | null = null
          return {
            kind,
            calls: () => taken,
            refused: () => refused,
            allowOneMore: () => { limit += 1 },
            take() {
              if (taken >= limit) {
                refused = `the ${kind} conversation's call limit of ${CALL_LIMITS[kind]} is used up`
              } else if (!hold.take()) {
                refused = input.ledger.stopped() ? `the budget stopped: ${input.ledger.stopped()}` : hold.cutShort() ? "the session's credit reservation is used up" : `the session's ${units} calls are used up`
              } else {
                taken += 1
                return true
              }
              emitNervesEvent({ component: "eval", level: "warn", event: "eval.interview_call_refused", message: "refused an interview model call", meta: { label, kind, reason: refused } })
              return false
            },
          }
        },
      }
      emitNervesEvent({ component: "eval", event: "eval.interview_session_reserved", message: "reserved an interview session's worst case", meta: { label, units } })
      return latch
    },
  }
}

/** Why a guarded call was not sent; never retried. */
export class RefusedCall extends Error {
  readonly retryable = false
  constructor(message: string, readonly reason: "brand" | "limit") {
    super(message)
    this.name = "RefusedCall"
  }
}

/**
 * The text of everything a request sends: system prompt, tools, messages and tool results, and the trace id, which
 * some providers send as metadata. The rest (reasoning effort, tool choice) are the provider's own fixed words.
 */
export function requestText(request: ProviderTurnRequest): string {
  return JSON.stringify({
    systemPrompt: request.systemPrompt ?? null, tools: request.activeTools, deferred: request.deferredTools ?? [], messages: request.messages,
    ...(request.traceId !== undefined ? { traceId: request.traceId } : {}),
  })
}

/**
 * The runtime one conversation's calls go through: scan, then the conversation's gate (`gateFor`, which may tell a job
 * from its debrief by the request), then the target's runtime metered on the session's hold. `log` sees every
 * request body, sent or not, for the grader's leak check.
 */
export function guardedRuntime(input: {
  inner: ProviderRuntime
  latch: SessionLatch
  ledger: BudgetLedger
  pricing: Pricing
  gateFor(request: ProviderTurnRequest): Gate
  log(entry: { kind: ConversationKind; sent: boolean; body: string; rewrites?: RewriteCounts }): void
  /** The arm's replacement list, applied before the scan; the model is sent only the rewritten request. */
  replacements?: readonly Replacement[]
  /** The arm's running count of matches rewritten, by tier; each request's are also on its log line. */
  rewrites?: RewriteCounts
}): ProviderRuntime {
  const latch = input.latch as SessionLatch & { _void(hits: string[]): void; _record(entry: CallRecord): void }
  const metered = meteredRuntime(input.inner, latch.hold, input.ledger)
  const streamTurn: ProviderRuntime["streamTurn"] = async (own) => {
    const gate = input.gateFor(own)
    const rewritten = input.replacements ? rewriteRequest(own, input.replacements) : undefined
    const request = rewritten?.request ?? own
    const body = requestText(request)
    const counted = rewritten ? { rewrites: rewritten.rewrites } : {}
    if (rewritten && input.rewrites) for (const [tier, n] of Object.entries(rewritten.rewrites)) input.rewrites[tier] = (input.rewrites[tier] ?? 0) + n
    const hits = brandHits(body)
    if (hits.length > 0) {
      latch._void(hits)
      input.log({ kind: gate.kind, sent: false, body, ...counted })
      latch._record({ kind: gate.kind, usage: null, credits: 0, sent: false })
      emitNervesEvent({ component: "eval", level: "warn", event: "eval.interview_request_void", message: "refused a request with brand words; its session is void", meta: { kind: gate.kind, count: hits.length } })
      throw new RefusedCall(`not sent: the request names ${[...new Set(hits.map((hit) => hit.toLowerCase()))].join(", ")}`, "brand")
    }
    if (!gate.take()) {
      input.log({ kind: gate.kind, sent: false, body, ...counted })
      throw new RefusedCall(`not sent: ${gate.refused()}`, "limit")
    }
    input.log({ kind: gate.kind, sent: true, body, ...counted })
    // The provider builds its body from the messages just scanned, never from items it kept from an earlier call (a
    // Responses-API runtime keeps reasoning and output items otherwise), so what is sent is what was scanned.
    input.inner.resetTurnState(request.messages)
    try {
      const result = await metered.streamTurn(request)
      latch._record({ kind: gate.kind, usage: result.usage ?? null, credits: result.usage ? creditsOf(result.usage, input.pricing) : 0, sent: true })
      return rewritten ? { ...result, toolCalls: result.toolCalls.map((call) => ({ ...call, name: rewritten.toolName(call.name) })) } : result
    } catch (error) {
      latch._record({ kind: gate.kind, usage: null, credits: 0, sent: true })
      throw error
    }
  }
  return new Proxy(input.inner, {
    get(target, property) {
      if (property === "streamTurn") return streamTurn
      if (property === "classifyError") return (error: Error) => error instanceof RefusedCall ? "unknown" : target.classifyError(error)
      const value: unknown = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
