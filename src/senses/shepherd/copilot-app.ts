import * as fs from "node:fs"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import WebSocket from "ws"
import { emitNervesEvent } from "../../nerves/runtime"
import { realSchedule } from "./cmux"
import type { HostSession, HostWatchHandlers, ShepherdHost, ShepherdHostObservation, ShepherdKey } from "./host"

/**
 * The GitHub Copilot app host. The app runs a local WebSocket server whose port and token it
 * rewrites under `<stateDir>/run/` on every launch, so each connection reads them fresh. Shepherd
 * connects as an observer (`observer=1`), so the app never binds a session's tool callbacks to it.
 *
 * Every connection receives every running session's events. A return is `session.idle` (not aborted), a
 * permission request no hook resolved, or a terminal `session.error`, still standing after the grace
 * period. `assistant.turn_end` is not a return: the app emits one after every model step. The
 * "screen" is the session's recent conversation, rendered from `session-state/<id>/events.jsonl`.
 * A reply is a queued `send_message`, so it never touches the human's draft.
 *
 * The app does not say which session is on screen. A session counts as the human's while the app
 * is frontmost and someone other than Shepherd (whose messages carry its label) sent it a message
 * in the last few minutes.
 */
export const COPILOT_APP_HOST = "copilot-app"
const GRACE_MS = 3_000
const TIMEOUT_MS = 10_000
const HUMAN_HOLD_MS = 5 * 60_000
const INVENTORY_MS = 10_000
const TAIL_BYTES = 512 * 1024
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** Bookkeeping events that neither start nor end work. */
const QUIET_EVENTS = new Set(["model.messages_snapshot", "session.usage_checkpoint", "session.usage_record", "session.background_tasks_changed", "session.title_changed"])
const BLOCKED_FRAMES = new Set(["user_input_request", "exit_plan_mode_request", "elicitation_request", "auto_mode_switch_request"])
const RESOLVED_FRAMES = new Set(["user_input_resolved", "exit_plan_mode_resolved", "elicitation_resolved", "auto_mode_switch_resolved"])
/** Every Shepherd message starts with its `[agent for human]` label, whichever process sent it. */
const SHEPHERD_LABEL = /^\[[^\]\n]{1,80} for [^\]\n]{1,80}\] /
const PERMISSION_KEYS: Partial<Record<ShepherdKey, string>> = { y: "approve-once", 1: "approve-once", 2: "approve-for-session", n: "reject", 3: "reject" }

export interface CopilotAppConnection {
  stateDir: string
}

export interface CopilotAppHostOptions {
  schedule?: (fn: () => void, ms: number) => () => void
  now?: () => number
  /** Whether the Copilot app is the frontmost application. */
  appFrontmost?: () => Promise<boolean>
  openSocket?: (url: string) => WebSocket
}

type Frame = Record<string, unknown>

function isRecord(value: unknown): value is Frame {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function firstLine(file: string): string {
  return fs.readFileSync(file, "utf-8").split(/\r?\n/)[0]!.trim()
}

/** The app's current server address; the port file holds `<port>\n<pid>`. */
export function copilotAppUrl(stateDir: string): string {
  const run = path.join(stateDir, "run")
  let port: string, token: string
  try {
    port = firstLine(path.join(run, "ws.port"))
    token = firstLine(path.join(run, "ws.token"))
  } catch {
    throw new Error(`the GitHub Copilot app is not running (no server files in ${run})`)
  }
  if (!/^\d+$/.test(port) || !token) throw new Error(`the GitHub Copilot app's server files in ${run} are unreadable`)
  return `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}&observer=1`
}

/** macOS: whether the frontmost app is the Copilot app. Anything unreadable counts as frontmost, so Shepherd holds back. */
type Run = (file: string, args: string[], done: (error: Error | null, stdout: string) => void) => void
const runFile: Run = (file, args, done) => { execFile(file, args, { timeout: 2_000 }, (error, stdout) => done(error, String(stdout))) }

export function copilotAppFrontmost(run: Run = runFile): Promise<boolean> {
  return new Promise((resolve) => {
    run("/usr/bin/lsappinfo", ["front"], (error, asn) => {
      if (error || !asn.trim()) return resolve(true)
      run("/usr/bin/lsappinfo", ["info", "-only", "name", asn.trim()], (infoError, info) => {
        resolve(infoError ? true : /"GitHub Copilot"/.test(info))
      })
    })
  })
}

interface Conversation {
  lines: string[]
  pendingPermission: string | null
}

/** Reads the end of a session's events log into conversation lines, oldest first. */
export function readConversation(stateDir: string, sessionId: string): Conversation {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new Error("invalid Copilot app session id")
  const file = path.join(stateDir, "session-state", sessionId, "events.jsonl")
  const fd = fs.openSync(file, "r")
  let text: string
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    text = buffer.toString("utf-8")
    // A tail that starts mid-line drops the partial first line.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1)
  } finally {
    fs.closeSync(fd)
  }
  const lines: string[] = []
  const permissions = new Map<string, string>()
  const push = (block: string): void => {
    for (const line of block.split(/\r?\n/)) lines.push(line)
  }
  for (const raw of text.split("\n")) {
    let event: unknown
    try {
      event = JSON.parse(raw)
    } catch {
      continue
    }
    if (!isRecord(event)) continue
    const data = isRecord(event.data) ? event.data : {}
    switch (event.type) {
      case "user.message":
        if (str(data.content)) push(`› ${data.content as string}`)
        break
      case "assistant.message":
        if (str(data.content)) push(data.content as string)
        break
      case "tool.execution_start": {
        const args = isRecord(data.arguments) ? data.arguments : {}
        const what = str(args.description) ?? str(args.command) ?? str(args.question) ?? str(args.path) ?? ""
        push(`• ${str(data.toolName) ?? "tool"}${what ? `: ${what.replace(/\s+/g, " ").slice(0, 160)}` : ""}`)
        break
      }
      case "session.task_complete":
        if (str(data.summary)) push(`Task complete: ${data.summary as string}`)
        break
      case "session.error":
        push(`Error: ${str(data.message) ?? str(data.errorType) ?? "unknown"}`)
        break
      case "permission.requested": {
        const id = str(data.requestId)
        if (!id || data.resolvedByHook === true) break
        const request = isRecord(data.permissionRequest) ? data.permissionRequest : {}
        permissions.set(id, str(request.intention) ?? str(request.fullCommandText) ?? str(request.kind) ?? "a tool call")
        break
      }
      case "permission.completed":
        if (str(data.requestId)) permissions.delete(data.requestId as string)
        break
    }
  }
  const pending = [...permissions.entries()].at(-1)
  if (pending) lines.push(`Waiting for permission: ${pending[1].replace(/\s+/g, " ").slice(0, 300)}`)
  return { lines, pendingPermission: pending?.[0] ?? null }
}

/** One connection: frames go to `onFrame` until the socket closes. */
function openStream(url: string, openSocket: (url: string) => WebSocket, onFrame: (frame: Frame) => void, onClose: (error?: Error) => void): { send(frame: Frame): void; close(): void } {
  const socket = openSocket(url)
  const queue: string[] = []
  let failure: Error | undefined
  socket.on("open", () => { for (const line of queue.splice(0)) socket.send(line) })
  socket.on("message", (data) => {
    try {
      const frame: unknown = JSON.parse(data.toString())
      if (isRecord(frame)) onFrame(frame)
    } catch {
      // A frame that is not JSON is ignored.
    }
  })
  socket.on("error", (error) => { failure = error })
  socket.on("close", () => onClose(failure))
  return {
    send(frame) {
      const line = JSON.stringify(frame)
      if (socket.readyState === WebSocket.OPEN) socket.send(line)
      else queue.push(line)
    },
    close: () => socket.close(),
  }
}

/** One request on its own connection, settled by the first frame `match` accepts (or throws on). */
export function copilotAppRequest<T>(
  stateDir: string,
  frame: Frame,
  match: (frame: Frame) => T | undefined,
  options: { timeoutMs?: number; openSocket?: (url: string) => WebSocket } = {},
): Promise<T> {
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url))
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.close()
      fn()
    }
    const timer = setTimeout(() => settle(() => reject(new Error(`Copilot app ${String(frame.type)} timed out`))), options.timeoutMs ?? TIMEOUT_MS)
    let url: string
    try {
      url = copilotAppUrl(stateDir)
    } catch (error) {
      clearTimeout(timer)
      settled = true
      return reject(error)
    }
    const stream = openStream(url, openSocket, (reply) => {
      try {
        const value = match(reply)
        if (value !== undefined) settle(() => resolve(value))
      } catch (error) {
        settle(() => reject(error))
      }
    }, (error) => settle(() => reject(new Error(`Copilot app ${String(frame.type)}: ${error?.message ?? "connection closed"}`))))
    stream.send(frame)
  })
}

function sessionsFrom(frame: Frame, focused: (id: string) => boolean): HostSession[] {
  const workspaces = Array.isArray(frame.workspaces) ? frame.workspaces.filter(isRecord) : []
  const sessions: HostSession[] = []
  for (const workspace of workspaces) {
    if (workspace.archivedAt) continue
    const session = isRecord(workspace.session) ? workspace.session : null
    const id = str(session?.sessionId)
    if (!session || !id) continue
    sessions.push({
      id,
      ref: id.slice(0, 8),
      workspace: str(workspace.id),
      workspaceTitle: str(workspace.projectName) ?? str(workspace.name),
      title: str(session.title) ?? str(workspace.name) ?? "",
      cwd: str(workspace.displayPath),
      // Only a running session has an agent that can hand control back.
      agent: session.isRunning === true ? "copilot" : null,
      focused: focused(id),
    })
  }
  return sessions
}

export function createCopilotAppHost(connection: CopilotAppConnection, options: CopilotAppHostOptions = {}): ShepherdHost {
  const schedule = options.schedule ?? realSchedule
  const now = options.now ?? Date.now
  const appFrontmost = options.appFrontmost ?? copilotAppFrontmost
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url))
  const { stateDir } = connection
  /** When someone other than Shepherd last messaged each session while the app was in front. */
  const humanAt = new Map<string, number>()
  const request = <T>(frame: Frame, match: (frame: Frame) => T | undefined): Promise<T> => copilotAppRequest(stateDir, frame, match, { openSocket })

  async function workspaceList(): Promise<Frame> {
    const requestId = `ouro-${randomUUID()}`
    return request({ type: "list_workspaces", request_id: requestId }, (frame) => frame.type === "workspace_list" && frame.request_id === requestId ? frame : undefined)
  }

  async function list(): Promise<HostSession[]> {
    const frame = await workspaceList()
    const front = humanAt.size > 0 && await appFrontmost()
    return sessionsFrom(frame, (id) => front && now() - (humanAt.get(id) ?? -Infinity) < HUMAN_HOLD_MS)
  }

  return {
    name: COPILOT_APP_HOST,
    async retirementInventory() {
      const frame = await workspaceList()
      if (!Array.isArray(frame.workspaces)) throw new Error("invalid Copilot app session inventory")
      const ids = sessionsFrom(frame, () => false).map(session => session.id)
      if (new Set(ids).size !== ids.length) throw new Error("invalid Copilot app session inventory identity")
      return ids
    },
    list,
    async read(sessionId, lines) {
      return readConversation(stateDir, sessionId).lines.slice(-Math.max(1, lines)).join("\n")
    },
    async prompt(sessionId, line) {
      const requestId = `ouro-${randomUUID()}`
      await request({ type: "send_message", session_id: sessionId, prompt: line, delivery_mode: "enqueue", request_id: requestId }, (frame) => {
        if (frame.request_id !== requestId) return undefined
        if (frame.type === "session_message_sent") return true
        if (frame.type === "session_message_delivery_unknown") throw new Error(`Copilot app could not confirm delivery: ${str(frame.detail) ?? "unknown"}`)
        if (frame.type === "error" || frame.type === "session_resume_failed") {
          throw new Error(`Copilot app refused the message: ${str(frame.message) ?? str(frame.reason) ?? String(frame.type)}`)
        }
        return undefined
      })
      emitNervesEvent({ component: "senses", event: "senses.shepherd_copilot_app_prompted", message: "sent a message to a Copilot app session", meta: { chars: line.length } })
    },
    async key(sessionId, key) {
      if (key === "ctrl-c" || key === "escape") {
        const requestId = `ouro-${randomUUID()}`
        await request({ type: "abort_session", session_id: sessionId, request_id: requestId }, (frame) => {
          if (frame.type === "error" && frame.request_id === requestId) throw new Error(`Copilot app refused to stop the session: ${str(frame.message) ?? "error"}`)
          return frame.type === "session_event" && frame.session_id === sessionId && isRecord(frame.event) && frame.event.type === "abort" ? true : undefined
        })
        return
      }
      const result = PERMISSION_KEYS[key]
      if (!result) throw new Error(`the Copilot app has no '${key}' key: send a line, y/1 (approve), 2 (approve for the session), n/3 (reject) or ctrl-c (stop)`)
      const pending = readConversation(stateDir, sessionId).pendingPermission
      if (!pending) throw new Error("this Copilot app session is not waiting for a permission; nothing was sent")
      await request({ type: "respond_to_permission", session_id: sessionId, request_id: pending, result }, (frame) => {
        if (frame.type === "error" && (frame.request_id === pending || frame.session_id === sessionId)) throw new Error(`Copilot app refused the answer: ${str(frame.message) ?? "error"}`)
        const event = isRecord(frame.event) ? frame.event : null
        return frame.type === "session_event" && event?.type === "permission.completed" && isRecord(event.data) && event.data.requestId === pending ? true : undefined
      })
    },
    async signal(_sessionId, status) {
      // The app has no status line or notification an outside client can set; owner notices carry the news.
      emitNervesEvent({ component: "senses", event: "senses.shepherd_copilot_app_signal", message: "Copilot app has no status line; Shepherd status kept in its own records", meta: { status: status ?? null } })
    },
    watch(handlers: HostWatchHandlers) {
      let closed = false
      let attempt = 0
      let stream: ReturnType<typeof openStream> | null = null
      let cancelReconnect: (() => void) | null = null
      let cancelInventory: (() => void) | null = null
      const pending = new Map<string, () => void>()
      /** Requests waiting on the human, per session (permission ids and blocking frames). */
      const blocked = new Map<string, Set<string>>()
      const lastBody = new Map<string, string>()
      const activity = new Map<string, "working" | "idle">()
      let inventory: HostSession[] = []

      const publish = (error?: "host_unavailable"): void => {
        handlers.observed?.({
          at: now(),
          sessions: inventory.map((session): ShepherdHostObservation["sessions"][number] => ({ session, activity: activity.get(session.id) ?? (session.agent ? "unknown" : "idle"), observedAt: now() })),
          ...(error ? { error } : {}),
        })
      }
      const cancel = (sessionId: string): void => {
        pending.get(sessionId)?.()
        pending.delete(sessionId)
      }
      /** The stop counts only if no new work started during the grace period. */
      const settle = (sessionId: string, transitionId: string, backgroundWork: boolean | null): void => {
        cancel(sessionId)
        activity.set(sessionId, "idle")
        pending.set(sessionId, schedule(() => {
          pending.delete(sessionId)
          // Sub-agent and side-chat sessions are not in the workspace list; their parent session is what Shepherd judges.
          const session = inventory.find(candidate => candidate.id === sessionId)
          if (!session?.agent) return
          handlers.returned({
            sessionId, transitionId, agent: "copilot", cwd: session.cwd ?? null,
            workspaceTitle: session.workspaceTitle ?? null, title: session.title,
            lastBody: lastBody.get(sessionId) ?? null, backgroundWork,
          })
        }, GRACE_MS))
      }
      const working = (sessionId: string): void => {
        cancel(sessionId)
        activity.set(sessionId, "working")
      }
      const block = (sessionId: string, key: string, transition: string = key): void => {
        const set = blocked.get(sessionId) ?? new Set<string>()
        set.add(key)
        blocked.set(sessionId, set)
        settle(sessionId, `${COPILOT_APP_HOST}:${sessionId}:${transition}`, null)
      }
      const unblock = (sessionId: string, requestId: string | null): void => {
        if (requestId) blocked.get(sessionId)?.delete(requestId)
        working(sessionId)
      }

      const onEvent = async (sessionId: string, event: Frame): Promise<void> => {
        const type = str(event.type) ?? ""
        const data = isRecord(event.data) ? event.data : {}
        const eventId = str(event.id) ?? `t${now()}`
        if (QUIET_EVENTS.has(type) || type.endsWith("_delta")) return
        switch (type) {
          case "session.idle": {
            // A stop the human asked for is theirs to follow up.
            if (data.aborted === true) {
              activity.set(sessionId, "idle")
              cancel(sessionId)
              return handlers.focused(sessionId)
            }
            // The app sends idle only with no background agents or shells in flight; older builds listed them.
            const tasks = isRecord(data.backgroundTasks) ? data.backgroundTasks : null
            const running = tasks ? [tasks.agents, tasks.shells].some(list => Array.isArray(list) && list.length > 0) : false
            return settle(sessionId, `${COPILOT_APP_HOST}:${sessionId}:${eventId}`, running)
          }
          case "session.error":
            if (data.eligibleForAutoSwitch === true) return working(sessionId)
            lastBody.set(sessionId, `Error: ${str(data.message) ?? str(data.errorType) ?? "unknown"}`)
            return settle(sessionId, `${COPILOT_APP_HOST}:${sessionId}:${eventId}`, null)
          case "permission.requested":
            if (data.resolvedByHook === true || !str(data.requestId)) return working(sessionId)
            return block(sessionId, data.requestId as string)
          case "permission.completed":
            return unblock(sessionId, str(data.requestId))
          case "assistant.message":
            if (str(data.content)) lastBody.set(sessionId, data.content as string)
            break
          case "session.task_complete":
            if (str(data.summary)) lastBody.set(sessionId, data.summary as string)
            break
          case "user.message": {
            const content = str(data.content) ?? ""
            if (SHEPHERD_LABEL.test(content)) break
            if (await appFrontmost()) {
              humanAt.set(sessionId, now())
              handlers.focused(sessionId)
            }
            break
          }
        }
        // A permission still waiting keeps the session waiting on the human.
        if ((blocked.get(sessionId)?.size ?? 0) > 0) return
        // A turn end is one model step, not a stop; everything else is work.
        if (type === "assistant.turn_end") return
        working(sessionId)
      }

      const onFrame = (frame: Frame): void => {
        if (closed) return
        const type = str(frame.type) ?? ""
        if (type === "server_hello") {
          attempt = 0
          emitNervesEvent({ component: "senses", event: "senses.shepherd_copilot_app_connected", message: "Copilot app event stream connected", meta: {} })
          return
        }
        if (type === "workspace_list") {
          // Advisory only: the send path re-checks focus through list(), which asks whether the app is in front.
          inventory = sessionsFrom(frame, (id) => now() - (humanAt.get(id) ?? -Infinity) < HUMAN_HOLD_MS)
          for (const id of [...activity.keys()]) if (!inventory.some(session => session.id === id)) activity.delete(id)
          return publish()
        }
        const sessionId = str(frame.session_id)
        if (!sessionId) return
        if (type === "session_event" && isRecord(frame.event)) {
          // History replays describe the past, never a new stop.
          if (frame.history_request_id) return
          void onEvent(sessionId, frame.event).catch((error: Error) => {
            emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_copilot_app_event_error", message: "could not handle a Copilot app session event", meta: { error: error.message } })
          })
          return
        }
        // A request without an id is keyed by its kind, so its resolution can still clear it.
        if (BLOCKED_FRAMES.has(type)) {
          const id = str(frame.request_id)
          return block(sessionId, id ?? type, id ?? `${type}@${now()}`)
        }
        if (RESOLVED_FRAMES.has(type)) return unblock(sessionId, str(frame.request_id) ?? type.replace(/_resolved$/, "_request"))
      }

      // Reconnect and close cancel the next refresh, so it only ever runs on a live stream.
      const refreshInventory = (current: NonNullable<typeof stream>): void => {
        current.send({ type: "list_workspaces", request_id: `ouro-${randomUUID()}` })
        cancelInventory = schedule(() => refreshInventory(current), INVENTORY_MS)
      }

      const reconnect = (error?: Error): void => {
        stream = null
        cancelInventory?.()
        cancelInventory = null
        if (closed) return
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!
        attempt += 1
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_copilot_app_closed", message: "Copilot app event stream closed; reconnecting", meta: { delay, error: error?.message ?? null } })
        publish("host_unavailable")
        cancelReconnect = schedule(connect, delay)
      }

      const connect = (): void => {
        cancelReconnect = null
        let url: string
        try {
          url = copilotAppUrl(stateDir)
        } catch (error) {
          return reconnect(error as Error)
        }
        // Stops while disconnected are not replayed; the next idle or permission event is.
        stream = openStream(url, openSocket, onFrame, reconnect)
        refreshInventory(stream)
      }

      connect()
      return {
        close() {
          closed = true
          cancelReconnect?.()
          cancelInventory?.()
          for (const stop of pending.values()) stop()
          pending.clear()
          stream?.close()
        },
      }
    },
  }
}
