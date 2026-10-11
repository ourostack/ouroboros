import * as net from "node:net"
import { emitNervesEvent } from "../../nerves/runtime"
import { realSchedule } from "./cmux"
import type { HostSession, HostWatchHandlers, ShepherdHost, ShepherdKey } from "./host"

/**
 * The Herdr host. Herdr detects every agent in its panes itself and publishes each change of its
 * semantic state as `pane.agent_status_changed` (idle, working, blocked, done, unknown). A return is
 * a pane leaving `working` for `idle`, `done` or `blocked` and still there after the grace period,
 * keyed by Herdr's own `state_change_seq`. Herdr types a prompt with `agent.prompt` (bracketed paste
 * then Enter) and shows Shepherd's status as the pane's state label.
 */
export const HERDR_METADATA_SOURCE = "ouro.shepherd"
const GRACE_MS = 3_000
const TIMEOUT_MS = 10_000
const RETURN_STATES = new Set(["idle", "done", "blocked"])
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const HERDR_KEYS: Record<ShepherdKey, string> = { enter: "enter", escape: "esc", up: "up", down: "down", tab: "tab", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", y: "y", n: "n" }

export interface HerdrConnection {
  socketPath: string
}

export interface HerdrHostOptions {
  schedule?: (fn: () => void, ms: number) => () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

interface Line { send: (line: Record<string, unknown>) => void; close: () => void }

/** One NDJSON connection: each line Herdr sends goes to `onLine` until the socket closes. */
function connectLines(socketPath: string, onLine: (line: Record<string, unknown>) => void, onClose: (error?: Error) => void): Line {
  const socket = net.createConnection(socketPath)
  let buffer = ""
  let failure: Error | undefined
  socket.setEncoding("utf-8")
  socket.on("data", (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const raw = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isRecord(parsed)) onLine(parsed)
      } catch {
        // A line that is not JSON is ignored.
      }
    }
  })
  socket.on("error", (error) => { failure = error })
  socket.on("close", () => onClose(failure))
  return { send: (line) => socket.write(`${JSON.stringify(line)}\n`), close: () => socket.destroy() }
}

let requestCount = 0

/** One request on its own connection. */
export function herdrRequest(socketPath: string, method: string, params: Record<string, unknown>, timeoutMs: number = TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `ouro_${++requestCount}`
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connection.close()
      fn()
    }
    const timer = setTimeout(() => settle(() => reject(new Error(`herdr ${method} timed out`))), timeoutMs)
    const connection = connectLines(socketPath, (line) => {
      if (line.id !== id) return
      const error = isRecord(line.error) ? line.error : null
      settle(() => error ? reject(new Error(`herdr ${method}: ${str(error.message) ?? str(error.code) ?? "error"}`)) : resolve(isRecord(line.result) ? line.result : {}))
    }, (error) => settle(() => reject(new Error(`herdr ${method}: ${error?.message ?? "connection closed"}`))))
    connection.send({ id, method, params })
  })
}

export function createHerdrHost(connection: HerdrConnection, options: HerdrHostOptions = {}): ShepherdHost {
  const schedule = options.schedule ?? realSchedule
  const call = (method: string, params: Record<string, unknown>) => herdrRequest(connection.socketPath, method, params)

  async function panes(): Promise<Record<string, unknown>[]> {
    const result = await call("pane.list", {})
    return Array.isArray(result.panes) ? result.panes.filter(isRecord) : []
  }

  return {
    name: "herdr",
    async list(): Promise<HostSession[]> {
      return (await panes()).map((pane) => ({
        id: str(pane.pane_id) ?? "",
        ref: str(pane.pane_id) ?? "",
        workspace: str(pane.workspace_id),
        title: str(pane.title) ?? str(pane.terminal_title_stripped) ?? str(pane.label) ?? "",
        agent: str(pane.agent),
      }))
    },
    async read(sessionId, lines) {
      const result = await call("pane.read", { pane_id: sessionId, source: "recent", lines, strip_ansi: true })
      const read = isRecord(result.read) ? result.read : {}
      return typeof read.text === "string" ? read.text : ""
    },
    async prompt(sessionId, line) {
      // Herdr pastes the text as one block and then presses Enter; a blocked agent is refused without input.
      await call("agent.prompt", { target: sessionId, text: line })
      emitNervesEvent({ component: "senses", event: "senses.shepherd_herdr_prompted", message: "typed a line into a Herdr pane", meta: { chars: line.length } })
    },
    async key(sessionId, key) {
      await call("pane.send_keys", { pane_id: sessionId, keys: [HERDR_KEYS[key]] })
    },
    async signal(sessionId, status, notification) {
      await call("pane.report_metadata", status
        ? { pane_id: sessionId, source: HERDR_METADATA_SOURCE, state_labels: { idle: status, done: status, blocked: status }, tokens: { ouro: status } }
        : { pane_id: sessionId, source: HERDR_METADATA_SOURCE, clear_state_labels: true, tokens: { ouro: null } })
      if (notification) await call("notification.show", { title: notification.title, body: notification.body })
    },
    watch(handlers: HostWatchHandlers) {
      let closed = false
      let attempt = 0
      let stream: Line | null = null
      let cancelReconnect: (() => void) | null = null
      let refresh = false
      const status = new Map<string, string>()
      const pending = new Map<string, () => void>()

      const cancelPending = (paneId: string): void => {
        pending.get(paneId)?.()
        pending.delete(paneId)
      }

      /** A return only if the pane is still out of `working` after the grace period, keyed by Herdr's own sequence. */
      const settled = (paneId: string): void => {
        cancelPending(paneId)
        pending.set(paneId, schedule(() => {
          pending.delete(paneId)
          void call("agent.get", { target: paneId }).then((result) => {
            const agent = isRecord(result.agent) ? result.agent : {}
            if (!RETURN_STATES.has(str(agent.agent_status) ?? "")) return
            const seq = typeof agent.state_change_seq === "number" ? agent.state_change_seq : null
            handlers.returned({
              sessionId: paneId,
              transitionId: `herdr:${paneId}:${seq ?? `t${Date.now()}`}`,
              agent: str(agent.agent),
              cwd: str(agent.foreground_cwd) ?? str(agent.cwd),
              lastBody: null,
            })
          }, (error: Error) => {
            emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_herdr_read_error", message: "could not read a Herdr agent after it stopped", meta: { error: error.message } })
          })
        }, GRACE_MS))
      }

      const onEvent = (line: Record<string, unknown>): void => {
        // Herdr names events `pane.focused` in subscriptions and `pane_focused` on the wire; both are accepted.
        const name = (str(line.event) ?? "").replace(".", "_")
        const data = isRecord(line.data) ? line.data : {}
        const paneId = str(data.pane_id)
        if (!paneId) return
        if (name === "pane_focused") return handlers.focused(paneId)
        if (name === "pane_created" || name === "pane_closed") {
          if (name === "pane_closed") {
            cancelPending(paneId)
            status.delete(paneId)
          }
          // Agent-status subscriptions name each pane, so a new or closed pane needs a new subscription.
          refresh = true
          stream?.close()
          return
        }
        if (name !== "pane_agent_status_changed") return
        const next = str(data.agent_status) ?? "unknown"
        const previous = status.get(paneId)
        status.set(paneId, next)
        if (next === "working") cancelPending(paneId)
        else if (previous === "working" && RETURN_STATES.has(next)) settled(paneId)
      }

      const reconnect = (error?: Error): void => {
        stream = null
        if (closed) return
        if (refresh) {
          refresh = false
          return void subscribe()
        }
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!
        attempt += 1
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_herdr_closed", message: "Herdr event subscription closed; resubscribing", meta: { delay, error: error?.message ?? null } })
        cancelReconnect = schedule(() => void subscribe(), delay)
      }

      const subscribe = async (): Promise<void> => {
        cancelReconnect = null
        let current: Record<string, unknown>[]
        try {
          current = await panes()
        } catch (error) {
          return reconnect(error as Error)
        }
        if (closed) return
        for (const pane of current) {
          const id = str(pane.pane_id)
          if (id && !status.has(id)) status.set(id, str(pane.agent_status) ?? "unknown")
        }
        const subscriptions = [
          { type: "pane.created" }, { type: "pane.closed" }, { type: "pane.focused" },
          ...current.flatMap((pane) => str(pane.pane_id) ? [{ type: "pane.agent_status_changed", pane_id: pane.pane_id }] : []),
        ]
        stream = connectLines(connection.socketPath, (line) => {
          if (isRecord(line.result) && line.result.type === "subscription_started") {
            attempt = 0
            emitNervesEvent({ component: "senses", event: "senses.shepherd_herdr_connected", message: "Herdr event subscription started", meta: { panes: subscriptions.length - 3 } })
            return
          }
          // `events_lost` or a rejected subscription closes the connection; the reconnect reads panes again.
          if (line.event !== undefined) onEvent(line)
        }, reconnect)
        stream.send({ id: "ouro_events", method: "events.subscribe", params: { subscriptions } })
      }

      void subscribe()
      return {
        close() {
          closed = true
          cancelReconnect?.()
          for (const cancel of pending.values()) cancel()
          stream?.close()
        },
      }
    },
  }
}
