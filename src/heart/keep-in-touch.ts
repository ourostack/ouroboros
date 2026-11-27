import type { ChannelCapabilities } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Nobody is left on read. On a chat where the agent can speak mid-turn, a turn that is still working once the
 * person has waited `ackAfterMs` with nothing from it may not start more work until it has said something; after
 * that, it says something again at least every `updateEveryMs` while it keeps working. The words are always the
 * agent's own: the engine only holds the batch and says why, and the agent writes the ack.
 */
export interface KeepInTouchTiming {
  readonly ackAfterMs: number
  readonly updateEveryMs: number
}

/**
 * Chats that get the guarantee. The CLI is left out because its terminal shows each tool as it runs; mail, A2A and
 * MCP can't speak mid-turn, so their guidance is in the prompt only.
 */
export const KEEP_IN_TOUCH_TIMING: Readonly<Record<string, KeepInTouchTiming>> = Object.freeze({
  bluebubbles: Object.freeze({ ackAfterMs: 15_000, updateEveryMs: 5 * 60_000 }),
  teams: Object.freeze({ ackAfterMs: 15_000, updateEveryMs: 5 * 60_000 }),
  telegram: Object.freeze({ ackAfterMs: 15_000, updateEveryMs: 5 * 60_000 }),
  voice: Object.freeze({ ackAfterMs: 5_000, updateEveryMs: 45_000 }),
})

/** After this many holds in a row the engine lets the work through, so a model that won't speak can't stall a turn. */
export const KEEP_IN_TOUCH_MAX_HOLDS = 2

/** Turn tools the person isn't waiting on: they end the turn, speak, think privately or load a door. */
const NOT_WORK = new Set(["settle", "observe", "rest", "speak", "ponder", "surface", "find_tools"])

/**
 * Whether the channel's sense delivers `speak` mid-turn. The Friends package still marks iMessage `chatStyle: false`
 * from when its adapter took one reply per turn; since the adapter records each mid-turn send durably, it speaks too.
 */
export function offersMidTurnSpeech(capabilities?: Pick<ChannelCapabilities, "channel" | "chatStyle">): boolean {
  return capabilities?.chatStyle === true || capabilities?.channel === "bluebubbles"
}

export interface KeepInTouchHold {
  readonly kind: "ack" | "update"
  /** How long the person has gone without hearing from the agent. */
  readonly quietMs: number
}

export interface KeepInTouch {
  /** Checks one batch, its calls' names in order, before any of it runs. A hold means none of it may run. */
  hold(callNames: readonly string[]): KeepInTouchHold | null
  /** A speak reached the person. */
  spoke(): void
  /** A speak failed to deliver, so holding work for one would only stall the turn. */
  undeliverable(): void
}

export interface KeepInTouchInput {
  readonly channel?: string
  /** `speak` is on this turn's menu. */
  readonly speakOffered: boolean
  /** The turn answers one person directly and may send to them (not a group, a reaction, a habit or a no-send turn). */
  readonly answersAPerson: boolean
  readonly startedAt: number
  readonly now?: () => number
}

export function createKeepInTouch(input: KeepInTouchInput): KeepInTouch | null {
  const timing = input.channel ? KEEP_IN_TOUCH_TIMING[input.channel] : undefined
  if (!timing || !input.speakOffered || !input.answersAPerson) return null
  const now = input.now ?? Date.now
  let lastSpokeAt: number | null = null
  let holdsInARow = 0
  let off = false
  return {
    hold(callNames) {
      if (off) return null
      const firstWork = callNames.findIndex((name) => !NOT_WORK.has(name))
      if (firstWork === -1) return null
      const firstSpeak = callNames.indexOf("speak")
      if (firstSpeak !== -1 && firstSpeak < firstWork) return null
      const quietMs = now() - (lastSpokeAt ?? input.startedAt)
      const kind = lastSpokeAt === null ? "ack" : "update"
      if (quietMs < (kind === "ack" ? timing.ackAfterMs : timing.updateEveryMs)) return null
      if (holdsInARow >= KEEP_IN_TOUCH_MAX_HOLDS) {
        off = true
        emitNervesEvent({
          level: "warn", component: "engine", event: "engine.keep_in_touch_released",
          message: "work let through after repeated holds without a speak",
          meta: { channel: input.channel, kind, quietMs, holds: holdsInARow },
        })
        return null
      }
      holdsInARow += 1
      emitNervesEvent({
        component: "engine", event: "engine.keep_in_touch_held",
        message: "work held until the agent tells the person something",
        meta: { channel: input.channel, kind, quietMs },
      })
      return { kind, quietMs }
    },
    spoke() {
      lastSpokeAt = now()
      holdsInARow = 0
    },
    undeliverable() {
      off = true
    },
  }
}
