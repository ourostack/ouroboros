import * as path from "node:path"
import { resolveCmuxConnection, type CmuxConnection } from "../../heart/cmux-config"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand } from "../../heart/daemon/socket-client"
import type { ExternalEventInput } from "../../heart/external-events/router"
import { getAgentRoot } from "../../heart/identity"
import { readMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  applyAck,
  applyEventFrame,
  escalationInput,
  type CmuxPendingFeedItem,
  pendingFeedItems,
  readCmuxState,
  rememberEscalation,
  surfaceForSession,
  writeCmuxState,
} from "./attention"
import { answerOnce, judgeFeedItem, recordDecision, type AnswerContext, type Judgment } from "./answer"
import { createCmuxClient, type CmuxClient, type CmuxSocketError } from "./client"

/**
 * The cmux sense: follows cmux's `events.stream` with a persisted cursor, keeps a small per-terminal
 * picture of what each coding agent is doing, and records every Feed decision cmux is holding open
 * for the human. A permission request the floor, the human's precedents and a standing owner grant
 * all clear is answered `once` here, with no agent turn; everything else becomes one external event
 * (keyed by the Feed request id) for the agent to bring to the human.
 */
export interface CmuxSenseAppOptions {
  agentName: string
  now?: () => number
  createClient?: (connection: CmuxConnection) => CmuxClient
  submit?: (input: ExternalEventInput) => Promise<void>
  /** Runs `fn` once after `ms`; returns a cancel function. Tests inject a manual clock. */
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface CmuxSenseApp {
  statePath: string
  stop: () => Promise<void>
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const FEED_POLL_MS = 30_000
const SAVE_DELAY_MS = 1_000

export function cmuxStatePath(agentName: string): string {
  return path.join(getAgentRoot(agentName), "state", "senses", "cmux", "state.json")
}

async function submitToDaemon(input: ExternalEventInput): Promise<void> {
  const response = await sendDaemonCommand(DEFAULT_DAEMON_SOCKET_PATH, { kind: "external.event.submit", ...input })
  if (!response.ok) throw new Error(response.error ?? "the daemon did not accept the cmux escalation")
}

export async function startCmuxSenseApp(options: CmuxSenseAppOptions): Promise<CmuxSenseApp> {
  const agent = options.agentName
  const now = (): string => new Date((options.now ?? Date.now)()).toISOString()
  const machine = readMachineRuntimeCredentialConfig(agent)
  const resolved = resolveCmuxConnection(agent, machine.ok ? machine.config : {})
  if (!resolved.ok) throw new Error(resolved.error)
  const client = (options.createClient ?? ((connection) => createCmuxClient(connection, { agentName: agent })))(resolved.connection)
  const submit = options.submit ?? submitToDaemon
  const schedule = options.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  })
  const statePath = cmuxStatePath(agent)
  const answers: AnswerContext = { agentRoot: getAgentRoot(agent), stateDir: path.dirname(statePath), client, now: options.now ?? Date.now, cmuxVersion: () => state.cmuxVersion }
  const state = readCmuxState(statePath, now())
  state.connected = false

  let stopped = false
  let stream: { close: () => void } | null = null
  let attempt = 0
  let cancelReconnect: (() => void) | null = null
  let cancelPoll: (() => void) | null = null
  let cancelSave: (() => void) | null = null
  let feedChain: Promise<void> = Promise.resolve()
  let feedQueued = false
  let lastWritten: string | null = null

  /** Writes the state file only when something other than the timestamp changed. */
  const save = (): void => {
    cancelSave?.()
    cancelSave = null
    const body = JSON.stringify({ ...state, updatedAt: null })
    if (body === lastWritten) return
    lastWritten = body
    state.updatedAt = now()
    writeCmuxState(statePath, state)
  }
  const saveSoon = (): void => {
    cancelSave ??= schedule(save, SAVE_DELAY_MS)
  }

  /**
   * One pending item: answered once when the code allows it, otherwise escalated with the reason.
   * A failure while judging or answering escalates the item with the error; a failure to record the
   * escalation leaves it unremembered, so the next check retries it. One item never blocks another.
   */
  async function handleItem(item: CmuxPendingFeedItem): Promise<void> {
    let reason: string
    let judgment: Judgment | null = null
    try {
      judgment = judgeFeedItem(answers, item)
      if (judgment.reply) {
        const outcome = await answerOnce(answers, item, judgment)
        if (outcome === "replied_once" || outcome === "race") {
          rememberEscalation(state, item.requestId)
          return
        }
        reason = outcome === "unconfirmed" ? "the sense replied once but cmux did not show the request resolved by it" : "the sense's own reply did not go out"
      } else {
        reason = judgment.reason
      }
    } catch (error) {
      reason = `the sense could not judge or answer it: ${(error as Error).message}`
    }
    try {
      await submit(escalationInput(agent, item, surfaceForSession(state, item.workstreamId), reason))
      rememberEscalation(state, item.requestId)
      if (judgment) recordDecision(answers, item, judgment, "escalated", reason)
      emitNervesEvent({ component: "senses", event: "senses.cmux_escalated", message: "recorded a cmux Feed request as an external event", meta: { agent, kind: item.kind, source: item.source } })
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.cmux_escalation_error", message: "could not record a cmux Feed request; the next check retries", meta: { agent, error: (error as Error).message } })
    }
  }

  async function checkFeed(): Promise<void> {
    try {
      const items = pendingFeedItems(await client.call("feed.list", { pending_only: true }))
      for (const item of items.filter((entry) => !state.escalated.includes(entry.requestId))) await handleItem(item)
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.cmux_feed_check_error", message: "cmux Feed check failed; the next check retries", meta: { agent, error: (error as Error).message } })
    }
    save()
  }

  /** Bursts of waiting events share one queued `feed.list` read instead of stacking reads. */
  const requestFeedCheck = (): void => {
    if (feedQueued) return
    feedQueued = true
    feedChain = feedChain.then(() => {
      feedQueued = false
      return checkFeed()
    })
  }

  /** Records the cmux version once per connection; observing works on any version. */
  async function identify(): Promise<void> {
    try {
      const result = await client.call("system.identify", {})
      state.cmuxVersion = typeof result.version === "string" ? result.version : null
    } catch {
      state.cmuxVersion = null
    }
    saveSoon()
  }

  const poll = (): void => {
    cancelPoll = schedule(() => {
      requestFeedCheck()
      poll()
    }, FEED_POLL_MS)
  }

  function connect(): void {
    cancelReconnect = null
    stream = client.stream({ ...(state.seq !== null ? { after_seq: state.seq } : {}), categories: ["feed", "surface"] }, {
      onFrame: (frame) => {
        if (frame.type === "ack") {
          attempt = 0
          const { reset } = applyAck(state, frame)
          state.connected = true
          state.lastError = null
          emitNervesEvent({ component: "senses", event: "senses.cmux_stream_connected", message: "cmux event stream connected", meta: { agent, reset } })
          // The version gates answering, so the first Feed check on a connection waits for it.
          void identify().then(requestFeedCheck)
          return
        }
        if (frame.type !== "event") return
        if (applyEventFrame(state, frame, now()).feedCheck) requestFeedCheck()
        saveSoon()
      },
      onClose: (error?: CmuxSocketError) => {
        stream = null
        state.connected = false
        state.lastError = error?.message ?? null
        if (stopped) return
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!
        attempt += 1
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.cmux_stream_closed", message: "cmux event stream closed; reconnecting", meta: { agent, delay, error: error?.message ?? null } })
        save()
        cancelReconnect = schedule(connect, delay)
      },
    })
  }

  connect()
  poll()
  emitNervesEvent({ component: "senses", event: "senses.cmux_sense_started", message: "cmux sense started", meta: { agent, auth: resolved.connection.auth.kind } })

  return {
    statePath,
    async stop() {
      stopped = true
      cancelReconnect?.()
      cancelPoll?.()
      stream?.close()
      await feedChain
      state.connected = false
      save()
      emitNervesEvent({ component: "senses", event: "senses.cmux_sense_stopped", message: "cmux sense stopped", meta: { agent } })
    },
  }
}
