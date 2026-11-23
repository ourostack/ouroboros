import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { writeJsonAtomicSync } from "../heart/atomic-file"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Per-inbound turn state that a crash or restart must not lose: how many turns were started for the inbound, and
 * what already went out to the person while one ran. A sense counts an attempt before each turn and notes each send
 * before it reaches the transport, so the next process knows not to send it again. The record is cleared once the
 * inbound has its outcome. Only a hash and the length of what was sent are kept, never the text.
 */

/** One send that may have reached the person during a turn with no outcome yet. */
export interface TurnSpoke {
  /** `speak` for the sense's own message mid-turn, or `tool:<name>` for a tool that messages a person. */
  kind: string
  sentAt: string
  /** The sense's durable outbound record for this send, when it keeps one (iMessage's `bbout_*`). */
  outboundRecordId: string | null
  textHash: string | null
  textLength: number | null
}

export interface TurnAttemptState {
  schemaVersion: 1
  sense: string
  id: string
  /** Turns started for this inbound, across processes. */
  attempts: number
  spoke: TurnSpoke[]
  updatedAt: string
}

export interface TurnAttemptStore {
  get(id: string): TurnAttemptState | null
  /** Count a turn starting for this inbound and return the new count. */
  beginAttempt(id: string): number
  /** Give back the attempt of a turn that a clean shutdown or a deferral stopped: it did not fail. */
  refundAttempt(id: string): void
  /** Note a send before it reaches the transport, so a replay never repeats it. */
  noteSpoke(id: string, spoke: TurnSpoke): void
  /** Forget the inbound once it has its outcome. */
  clear(id: string): void
}

export function turnAttemptsDir(agentRoot: string, sense: string): string {
  return path.join(agentRoot, "state", "senses", sense, "turn-attempts")
}

function fileName(id: string): string {
  return `${createHash("sha256").update(id).digest("hex")}.json`
}

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

/** Describe one send for `noteSpoke`: what kind it was, when, its outbound record, and a hash of its text. */
export function turnSpoke(kind: string, text: string | null, outboundRecordId: string | null = null, nowMs: number = Date.now()): TurnSpoke {
  return {
    kind,
    sentAt: new Date(nowMs).toISOString(),
    outboundRecordId,
    textHash: text === null ? null : hashText(text),
    textLength: text === null ? null : text.length,
  }
}

/**
 * Name what went out for a recorded outcome, such as `1 send (tool:send_message at 2026-11-22T10:00:00.000Z)`. An
 * entry written before sends were itemized has none, and reads as "a message".
 */
export function describeTurnSpokes(spoke: readonly TurnSpoke[] = []): string {
  if (spoke.length === 0) return "a message"
  const sends = spoke.map((entry) => `${entry.kind} at ${entry.sentAt}`).join(", ")
  return `${spoke.length} ${spoke.length === 1 ? "send" : "sends"} (${sends})`
}

/** Tools that send something to a person or another agent outside the turn's own reply. Running one counts as having spoken. */
const PERSON_MESSAGING_TOOLS: ReadonlySet<string> = new Set([
  "send_message",
  "surface",
  "teams_send_message",
  "mail_send",
  "send_file",
  "send_result",
  "house_digest_send",
  "shepherd_send",
  "react",
  "coordinate",
])

/**
 * The spoke record for a tool call that may message a person, or null for any other tool. `send_message` to `self`
 * only queues work for the agent's own private runtime, so it reaches nobody.
 */
export function turnSpokeForTool(name: string, args: Record<string, string>, nowMs: number = Date.now()): TurnSpoke | null {
  if (!PERSON_MESSAGING_TOOLS.has(name)) return null
  if (name === "send_message" && args.friendId?.trim() === "self") return null
  const text = args.content ?? args.message ?? args.caption ?? null
  return turnSpoke(`tool:${name}`, text, null, nowMs)
}

/**
 * Notes each tool call that may message a person just before its handler runs: `started` remembers the call's
 * arguments, and `dispatched` fires only for a call that passed its guards. A call refused before its handler sends
 * nothing and is not noted. `onSpoke` may throw (a failed disk write), which stops the call before it runs.
 */
export function outwardSendTracker(onSpoke: (spoke: TurnSpoke) => void): {
  started(name: string, args: Record<string, string>): void
  dispatched(name: string): void
} {
  // Tool calls in a turn run one at a time, so the last started call is the one being dispatched.
  let last: { name: string; args: Record<string, string> } | null = null
  return {
    started(name, args) {
      last = { name, args }
    },
    dispatched(name) {
      const args = last?.name === name ? last.args : {}
      last = null
      const spoke = turnSpokeForTool(name, args)
      if (spoke) onSpoke(spoke)
    },
  }
}

function isState(value: unknown, id: string): value is TurnAttemptState {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<TurnAttemptState>
  return record.schemaVersion === 1 && record.id === id && typeof record.attempts === "number" && Array.isArray(record.spoke)
}

export function openTurnAttempts(agentRoot: string, sense: string, options: { now?: () => number } = {}): TurnAttemptStore {
  const now = options.now ?? Date.now
  const dir = turnAttemptsDir(agentRoot, sense)
  const filePath = (id: string): string => path.join(dir, fileName(id))

  const get = (id: string): TurnAttemptState | null => {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(filePath(id), "utf-8"))
    } catch {
      return null
    }
    return isState(parsed, id) ? parsed : null
  }
  const write = (id: string, change: (state: TurnAttemptState) => TurnAttemptState): TurnAttemptState => {
    const current = get(id) ?? { schemaVersion: 1, sense, id, attempts: 0, spoke: [], updatedAt: new Date(now()).toISOString() }
    const next = { ...change(current), updatedAt: new Date(now()).toISOString() }
    writeJsonAtomicSync(filePath(id), next)
    return next
  }

  return {
    get,
    beginAttempt(id) {
      return write(id, (state) => ({ ...state, attempts: state.attempts + 1 })).attempts
    },
    refundAttempt(id) {
      if (!get(id)) return
      write(id, (state) => ({ ...state, attempts: Math.max(0, state.attempts - 1) }))
    },
    noteSpoke(id, spoke) {
      const next = write(id, (state) => ({ ...state, spoke: [...state.spoke, spoke] }))
      emitNervesEvent({
        component: "senses",
        event: "senses.turn_spoke_recorded",
        message: "recorded a send before it reached the transport, so a replay does not repeat it",
        meta: { sense, kind: spoke.kind, attempts: next.attempts, sends: next.spoke.length, outboundRecordId: spoke.outboundRecordId },
      })
    },
    clear(id) {
      fs.rmSync(filePath(id), { force: true })
    },
  }
}
