/**
 * The turn summary: one counts-only nerves event, `engine.turn_summary`, emitted when `runAgent` ends.
 *
 * It lets an operator measure an agent's real turns (steps, how the turn ended, tool use, tool discovery and tokens)
 * without reading a session. It never carries content: every field is a number, a value from a fixed list, or a tool
 * name the turn itself offered (an MCP tool is named only by its server, `mcp:<server>`). A name the model made up is
 * counted as `unknown`, never repeated, because a made-up name can carry the conversation's words.
 *
 * Building and emitting the summary must never break a turn, so `emitTurnSummary` swallows every error.
 *
 * Scope of the counts: `steps` and the token totals cover the main loop's provider calls that returned (on any
 * provider the turn fell back to), not side calls such as the kept-notes judge or attempts that failed and were
 * retried. `provider` and `model` name the last provider the turn used; `providerSwitches` counts fallbacks.
 * `eagerDoors` is the tools offered up front on a step (engine tools such as settle included, find_tools and doors
 * find_tools loaded left out); `deferredDoors` is the tools held back behind find_tools. Both are the largest seen.
 */
import type { Channel } from "@ouro.bot/friends"
import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { UsageData } from "./streaming"
import { FIND_TOOLS_NAME } from "../repertoire/tool-catalog"
import type { ProviderErrorClassification, RunAgentOutcome } from "./core"

/** Every value `runAgent` can end with; `RunAgentOutcome` in core.ts must stay a subset (a test pins it). */
export const TURN_SUMMARY_OUTCOMES = ["settled", "suspended", "blocked", "superseded", "aborted", "errored", "observed", "rested"] as const
export type TurnSummaryOutcome = typeof TURN_SUMMARY_OUTCOMES[number]
/** Fails to compile when `RunAgentOutcome` gains a value this list doesn't have. */
export const RUN_AGENT_OUTCOMES_COVERED: [RunAgentOutcome] extends [TurnSummaryOutcome] ? true : never = true

/** Why an errored turn failed: the provider error classes, or `none` when the turn didn't fail on an error. */
export const TURN_SUMMARY_ERROR_CLASSES = ["auth-failure", "usage-limit", "rate-limit", "server-error", "network-error", "unknown", "none"] as const
export type TurnSummaryErrorClass = typeof TURN_SUMMARY_ERROR_CLASSES[number]
/** Fails to compile when `ProviderErrorClassification` gains a value this list doesn't have. */
export const ERROR_CLASSES_COVERED: [ProviderErrorClassification] extends [TurnSummaryErrorClass] ? true : never = true

const CHANNEL_SET: Record<Channel, true> = {
  cli: true, teams: true, bluebubbles: true, mail: true, voice: true, a2a: true, inner: true, mcp: true, telegram: true,
}
/** The channels a summary may name; anything else (or no channel) is `none`. */
export const TURN_SUMMARY_CHANNELS: readonly (Channel | "none")[] = [...(Object.keys(CHANNEL_SET) as Channel[]), "none"]

/** The bucket for a tool name the turn never offered. */
export const UNKNOWN_TOOL = "unknown"

export interface TurnSummaryMeta {
  channel: Channel | "none"
  outcome: TurnSummaryOutcome
  errorClass: TurnSummaryErrorClass
  provider: string
  model: string
  providerSwitches: number
  steps: number
  stepBudgetExhausted: number
  toolCalls: Record<string, number>
  toolErrors: number
  unknownToolCalls: number
  findToolsCalls: number
  findToolsLoaded: number
  loadedThenCalled: number
  eagerDoors: number
  deferredDoors: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
}

interface OfferedDefinition { mcpServer?: string }

/** The counters one `runAgent` call keeps. Every method is cheap and never throws on ordinary input. */
export class TurnTally {
  private readonly offered = new Map<string, string>()
  private readonly loaded = new Set<string>()
  private readonly calls = new Map<string, number>()
  private provider = "unknown"
  private model = "unknown"
  private routed = false
  private switches = 0
  private emitted = false
  private steps = 0
  private budgetStops = 0
  private errors = 0
  private unknown = 0
  private findCalls = 0
  private findLoaded = 0
  private loadedCalled = 0
  private eager = 0
  private deferred = 0
  private input = 0
  private output = 0
  private reasoning = 0

  /** Records the doors a step offered (and those held back behind find_tools), so later calls can be named safely. */
  offer(
    active: readonly OpenAI.ChatCompletionFunctionTool[],
    deferredPool: readonly OpenAI.ChatCompletionFunctionTool[],
    definitions: ReadonlyMap<string, OfferedDefinition>,
  ): void {
    for (const tool of [...active, ...deferredPool]) {
      const name = tool.function.name
      const server = definitions.get(name)?.mcpServer
      this.offered.set(name, server ? `mcp:${server}` : name)
    }
    const upFront = active.filter((tool) => tool.function.name !== FIND_TOOLS_NAME && !this.loaded.has(tool.function.name))
    this.eager = Math.max(this.eager, upFront.length)
    this.deferred = Math.max(this.deferred, deferredPool.length)
  }

  /** The provider the turn is on; a change after the first counts as a fallback. */
  route(provider: string, model: string): void {
    if (this.routed && (provider !== this.provider || model !== this.model)) this.switches += 1
    this.routed = true
    this.provider = provider
    this.model = model
  }

  /** One provider call that returned, with the provider that served it and the usage it reported. */
  step(usage: UsageData | undefined, provider: string, model: string): void {
    this.route(provider, model)
    this.steps += 1
    if (!usage) return
    this.input += usage.input_tokens
    this.output += usage.output_tokens
    this.reasoning += usage.reasoning_tokens
  }

  stepBudgetExhausted(): void {
    this.budgetStops += 1
  }

  /** A find_tools call and the door names it loaded. */
  findTools(loadedNames: readonly string[]): void {
    this.findCalls += 1
    if (loadedNames.length > 0) this.findLoaded += 1
    for (const name of loadedNames) this.loaded.add(name)
  }

  /** A tool call ended. find_tools is counted by `findTools`, so its own end is ignored here. */
  toolEnd(name: string, success: boolean): void {
    if (name === FIND_TOOLS_NAME) return
    const label = this.offered.get(name)
    if (label === undefined) {
      this.unknown += 1
      this.calls.set(UNKNOWN_TOOL, (this.calls.get(UNKNOWN_TOOL) ?? 0) + 1)
      if (!success) this.errors += 1
      return
    }
    this.calls.set(label, (this.calls.get(label) ?? 0) + 1)
    if (!success) this.errors += 1
    if (this.loaded.has(name)) this.loadedCalled += 1
  }

  /** A call rejected before it ran (a name the turn didn't offer, or bad arguments): a failed call. */
  rejected(name: string): void {
    if (name === FIND_TOOLS_NAME) {
      this.findCalls += 1
      this.errors += 1
      return
    }
    this.toolEnd(name, false)
  }

  /** True the first time only, so a turn is summarized once. */
  claimEmit(): boolean {
    if (this.emitted) return false
    this.emitted = true
    return true
  }

  summarize(input: { channel: string | undefined; outcome: string; errorClass: string }): TurnSummaryMeta {
    const channel = input.channel !== undefined && Object.hasOwn(CHANNEL_SET, input.channel) ? input.channel as Channel : "none"
    const outcome = (TURN_SUMMARY_OUTCOMES as readonly string[]).includes(input.outcome) ? input.outcome as TurnSummaryOutcome : "errored"
    const errorClass = (TURN_SUMMARY_ERROR_CLASSES as readonly string[]).includes(input.errorClass) ? input.errorClass as TurnSummaryErrorClass : "unknown"
    return {
      channel,
      outcome,
      errorClass,
      provider: safeLabel(this.provider),
      model: safeLabel(this.model),
      providerSwitches: this.switches,
      steps: this.steps,
      stepBudgetExhausted: this.budgetStops,
      toolCalls: Object.fromEntries([...this.calls.entries()].sort(([a], [b]) => a.localeCompare(b))),
      toolErrors: this.errors,
      unknownToolCalls: this.unknown,
      findToolsCalls: this.findCalls,
      findToolsLoaded: this.findLoaded,
      loadedThenCalled: this.loadedCalled,
      eagerDoors: this.eager,
      deferredDoors: this.deferred,
      inputTokens: this.input,
      outputTokens: this.output,
      reasoningTokens: this.reasoning,
    }
  }
}

/**
 * The channel callbacks with every `onToolEnd` also counted in `tally`. Everything else passes through untouched,
 * including methods' `this`, and the tally never stops the original callback from running.
 */
export function tallyToolEnds<T extends { onToolEnd(name: string, summary: string, success: boolean): void }>(callbacks: T, tally: TurnTally): T {
  return new Proxy(callbacks, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== "onToolEnd" || typeof value !== "function") return value
      // A proxy must return a frozen property as it is; such callbacks go uncounted rather than break the turn.
      const own = Object.getOwnPropertyDescriptor(target, property)
      if (own && !own.configurable && !own.writable) return value
      return (name: string, summary: string, success: boolean): void => {
        try {
          tally.toolEnd(name, success)
        } catch {
          // Counting must never change what the turn does.
        }
        return (value as T["onToolEnd"]).call(target, name, summary, success)
      }
    },
  })
}

/** Provider and model ids come from configuration; anything that doesn't look like an id is replaced. */
function safeLabel(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(value) ? value : "other"
}

/** Emits `engine.turn_summary` for a finished turn. It never throws: a summary that fails is dropped. */
export function emitTurnSummary(
  tally: TurnTally,
  input: { channel: string | undefined; outcome: string; errorClass: string; traceId?: string },
): void {
  try {
    if (!tally.claimEmit()) return
    emitNervesEvent({
      event: "engine.turn_summary",
      trace_id: input.traceId,
      component: "engine",
      message: "turn summary (counts only)",
      meta: tally.summarize(input) as unknown as Record<string, unknown>,
    })
  } catch {
    // The turn already finished; a lost summary must not change its result.
  }
}
