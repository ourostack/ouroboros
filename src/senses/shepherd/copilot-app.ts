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
 * Every connection receives every running session's events. A return is `session.idle` (not a
 * human stop), a permission or question the human must answer, or a terminal `session.error`, still
 * standing after the grace period. `assistant.turn_end` is not a return: the app sends one after
 * every model step. Sub-agent events (top-level `agentId`) are work, never a return. The "screen" is
 * the session's recent conversation, rendered from `session-state/<id>/events.jsonl`. A reply is a
 * queued `send_message`, so it never touches the human's draft.
 *
 * The app does not say which session is on screen, so a session counts as the human's when the
 * human messaged it in the last five minutes, or in the last half hour while they are at the Mac with
 * the app in front. Only a message with no `source` and no `agentId` is the human's: agents,
 * schedules and autopilot tag theirs, and Shepherd's carry its `[agent for human]` label.
 */
export const COPILOT_APP_HOST = "copilot-app"
const GRACE_MS = 3_000
const TIMEOUT_MS = 10_000
const HUMAN_HOLD_MS = 5 * 60_000
const PRESENT_HOLD_MS = 30 * 60_000
const PRESENT_IDLE_S = 120
const INVENTORY_MS = 10_000
const CHUNK_BYTES = 256 * 1024
const SCAN_BYTES = 8 * 1024 * 1024
const TAIL_EVENTS = 400
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** Bookkeeping events that neither start nor end work. */
const QUIET_EVENTS = new Set(["model.messages_snapshot", "session.usage_checkpoint", "session.usage_record", "session.background_tasks_changed", "session.title_changed"])
const BLOCKED_FRAMES = new Set(["user_input_request", "exit_plan_mode_request", "elicitation_request", "auto_mode_switch_request"])
const RESOLVED_FRAMES = new Set(["user_input_resolved", "exit_plan_mode_resolved", "elicitation_resolved", "auto_mode_switch_resolved"])
/** Every Shepherd message starts with its `[agent for human]` label, whichever process sent it. */
const SHEPHERD_LABEL = /^\[[^\]\n]{1,80} for [^\]\n]{1,80}\] /
const PERMISSION_KEYS: Partial<Record<ShepherdKey, string>> = { y: "approve-once", 1: "approve-once", 2: "approve-for-session", n: "reject", 3: "reject" }
/** Asset lines can be megabytes and carry no conversation. */
const BINARY_LINE = Buffer.from("\"session.binary_asset\"")

export interface CopilotAppConnection {
  stateDir: string
}

export interface CopilotAppHostOptions {
  schedule?: (fn: () => void, ms: number) => () => void
  now?: () => number
  /** Whether the human is at the Mac with the Copilot app in front. */
  humanPresent?: () => Promise<boolean>
  openSocket?: (url: string) => WebSocket
}

type Frame = Record<string, unknown>
type Run = (file: string, args: string[], done: (error: Error | null, stdout: string) => void) => void

function isRecord(value: unknown): value is Frame {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The app's current server address. Every app build (release, dev, PR) writes `ws.port` and
 * `ws.token`; the release app also writes `ws.release.*`, so those win. The port file holds
 * `<port>\n<pid>`, and a file whose app has exited is skipped.
 */
export function copilotAppUrl(stateDir: string, alive: (pid: number) => boolean = processAlive): string {
  const run = path.join(stateDir, "run")
  for (const prefix of ["ws.release", "ws"]) {
    let port: string, pid: string | undefined, token: string
    try {
      ;[port, pid] = fs.readFileSync(path.join(run, `${prefix}.port`), "utf-8").split(/\r?\n/).map(line => line.trim()) as [string, string | undefined]
      token = fs.readFileSync(path.join(run, `${prefix}.token`), "utf-8").split(/\r?\n/)[0]!.trim()
    } catch {
      continue
    }
    if (!/^\d+$/.test(port) || !token) continue
    if (pid && /^\d+$/.test(pid) && !alive(Number(pid))) continue
    return `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}&observer=1`
  }
  throw new Error(`the GitHub Copilot app is not running (no live server files in ${run})`)
}

const runFile: Run = (file, args, done) => { execFile(file, args, { timeout: 2_000 }, (error, stdout) => done(error, String(stdout))) }

/** macOS: the Copilot app is frontmost and the keyboard or mouse moved recently. Anything unreadable counts as present, so Shepherd holds back. */
export function copilotAppHumanPresent(run: Run = runFile): Promise<boolean> {
  const output = (file: string, args: string[]) => new Promise<string | null>(resolve => run(file, args, (error, stdout) => resolve(error ? null : stdout)))
  return (async () => {
    const asn = (await output("/usr/bin/lsappinfo", ["front"]))?.trim()
    if (!asn) return true
    const info = await output("/usr/bin/lsappinfo", ["info", "-only", "name", asn])
    if (info === null) return true
    if (!/"GitHub Copilot"/.test(info)) return false
    const hid = await output("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"])
    const idle = hid?.match(/"HIDIdleTime" = (\d+)/)
    return !idle || Number(idle[1]) / 1e9 < PRESENT_IDLE_S
  })()
}

/** Whether a `user.message` is the human's own: agents, schedules and autopilot tag theirs. */
function humanMessage(event: Frame, data: Frame): boolean {
  return event.type === "user.message" && event.agentId === undefined && data.source === undefined && !SHEPHERD_LABEL.test(str(data.content) ?? "")
}

/** Up to `TAIL_EVENTS` event lines from the end of the log, oldest first, skipping asset lines. */
function tailEvents(file: string): Buffer[] {
  const fd = fs.openSync(file, "r")
  const lines: Buffer[] = []
  try {
    let position = fs.fstatSync(fd).size
    let carry = Buffer.alloc(0)
    const keep = (line: Buffer): void => {
      if (line.length > 0 && !line.subarray(0, 200).includes(BINARY_LINE)) lines.push(line)
    }
    while (position > 0 && lines.length < TAIL_EVENTS) {
      const length = Math.min(CHUNK_BYTES, position)
      position -= length
      const chunk = Buffer.alloc(length)
      fs.readSync(fd, chunk, 0, length, position)
      const text = Buffer.concat([chunk, carry])
      let end = text.length
      for (let at = text.lastIndexOf(10, end - 1); at >= 0; at = text.lastIndexOf(10, end - 1)) {
        keep(text.subarray(at + 1, end))
        end = at
        if (lines.length >= TAIL_EVENTS) break
      }
      carry = text.subarray(0, end)
      // One huge line (an asset) is dropped once it outgrows the scan budget.
      if (carry.length > SCAN_BYTES) carry = Buffer.alloc(0)
    }
    if (position === 0 && lines.length < TAIL_EVENTS) keep(carry)
  } finally {
    fs.closeSync(fd)
  }
  return lines.reverse()
}

export interface Conversation {
  lines: string[]
  pendingPermission: string | null
  /** When the human last messaged the session, in epoch ms. */
  humanAt: number | null
}

/** The session's recent top-level conversation, oldest first, and what is still waiting on the human. */
export function readConversation(stateDir: string, sessionId: string): Conversation {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new Error("invalid Copilot app session id")
  const lines: string[] = []
  const permissions = new Map<string, string>()
  let humanAt: number | null = null
  const push = (block: string): void => {
    for (const line of block.split(/\r?\n/)) lines.push(line)
  }
  for (const raw of tailEvents(path.join(stateDir, "session-state", sessionId, "events.jsonl"))) {
    let event: unknown
    try {
      event = JSON.parse(raw.toString("utf-8"))
    } catch {
      continue
    }
    if (!isRecord(event)) continue
    const data = isRecord(event.data) ? event.data : {}
    if (humanMessage(event, data)) {
      const at = Date.parse(str(event.timestamp) ?? "")
      if (!Number.isNaN(at)) humanAt = at
    }
    // Sub-agents talk among themselves; the conversation is the session's own.
    if (event.agentId !== undefined) continue
    switch (event.type) {
      case "user.message":
        if (str(data.content)) push(`› ${str(data.source) ? `(${data.source as string}) ` : ""}${data.content as string}`)
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
  return { lines, pendingPermission: pending?.[0] ?? null, humanAt }
}

/** One connection: frames go to `onFrame` until the socket closes. Throws if the socket cannot be created. */
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
    let stream: ReturnType<typeof openStream>
    try {
      stream = openStream(copilotAppUrl(stateDir), openSocket, (reply) => {
        try {
          const value = match(reply)
          if (value !== undefined) settle(() => resolve(value))
        } catch (error) {
          settle(() => reject(error))
        }
      }, (error) => settle(() => reject(new Error(`Copilot app ${String(frame.type)}: ${error?.message ?? "connection closed"}`))))
    } catch (error) {
      return reject(error)
    }
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.close()
      fn()
    }
    const timer = setTimeout(() => settle(() => reject(new Error(`Copilot app ${String(frame.type)} timed out`))), options.timeoutMs ?? TIMEOUT_MS)
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
      // `isRunning` means busy right now, not that an agent exists: every listed session has one.
      agent: "copilot",
      focused: focused(id),
    })
  }
  return sessions
}

export function createCopilotAppHost(connection: CopilotAppConnection, options: CopilotAppHostOptions = {}): ShepherdHost {
  const schedule = options.schedule ?? realSchedule
  const now = options.now ?? Date.now
  const humanPresent = options.humanPresent ?? copilotAppHumanPresent
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url))
  const { stateDir } = connection
  /** Human messages this host saw live, newer than the log may show yet. */
  const humanAt = new Map<string, number>()
  const request = <T>(frame: Frame, match: (frame: Frame) => T | undefined): Promise<T> => copilotAppRequest(stateDir, frame, match, { openSocket })

  async function workspaceList(): Promise<Frame> {
    const requestId = `ouro-${randomUUID()}`
    return request({ type: "list_workspaces", request_id: requestId }, (frame) => {
      if (frame.request_id !== requestId) return undefined
      if (frame.type === "error") throw new Error(`Copilot app could not list sessions: ${str(frame.message) ?? "error"}`)
      return frame.type === "workspace_list" ? frame : undefined
    })
  }

  function lastHuman(sessionId: string): number {
    let logged: number | null = null
    try {
      logged = readConversation(stateDir, sessionId).humanAt
    } catch {
      // A session with no log yet has no human message in it.
    }
    return Math.max(humanAt.get(sessionId) ?? -Infinity, logged ?? -Infinity)
  }

  async function list(): Promise<HostSession[]> {
    const frame = await workspaceList()
    let present: boolean | undefined
    const ages = new Map<string, number>()
    for (const session of sessionsFrom(frame, () => false)) ages.set(session.id, now() - lastHuman(session.id))
    if ([...ages.values()].some(age => age >= HUMAN_HOLD_MS && age < PRESENT_HOLD_MS)) present = await humanPresent()
    return sessionsFrom(frame, (id) => {
      const age = ages.get(id)!
      return age < HUMAN_HOLD_MS || (present === true && age < PRESENT_HOLD_MS)
    })
  }

  return {
    name: COPILOT_APP_HOST,
    async retirementInventory() {
      const frame = await workspaceList()
      if (!Array.isArray(frame.workspaces) || (Array.isArray(frame.deferred_workspace_ids) && frame.deferred_workspace_ids.length > 0)) {
        throw new Error("invalid Copilot app session inventory")
      }
      const ids = sessionsFrom(frame, () => false).map(session => session.id)
      if (new Set(ids).size !== ids.length) throw new Error("invalid Copilot app session inventory identity")
      return ids
    },
    list,
    async read(sessionId, lines) {
      const conversation = readConversation(stateDir, sessionId)
      // An empty screen is no basis for a judgment; the sense records the error and sends nothing.
      if (conversation.lines.length === 0) throw new Error("could not read this Copilot app session's conversation")
      return conversation.lines.slice(-Math.max(1, lines)).join("\n")
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
          const event = isRecord(frame.event) ? frame.event : null
          return frame.type === "session_event" && frame.session_id === sessionId && event?.type === "session.idle" ? true : undefined
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
      /** What each session is waiting on the human for: permission ids and blocking frames. */
      const blocked = new Map<string, Set<string>>()
      const lastBody = new Map<string, string>()
      const activity = new Map<string, "working" | "idle">()
      let inventory: HostSession[] = []

      const publish = (error?: "host_unavailable"): void => {
        handlers.observed?.({
          at: now(),
          sessions: inventory.map((session): ShepherdHostObservation["sessions"][number] => ({ session, activity: activity.get(session.id) ?? "unknown", observedAt: now() })),
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
          // Only sessions in the workspace list are judged; a side chat's parent is.
          const session = inventory.find(candidate => candidate.id === sessionId)
          if (!session) return
          handlers.returned({
            sessionId, transitionId, agent: session.agent, cwd: session.cwd ?? null,
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
      /** An answered request; the session is working again unless it still waits on another. */
      const unblock = (sessionId: string, key: string): void => {
        const set = blocked.get(sessionId)
        set?.delete(key)
        if (!set?.size) working(sessionId)
      }

      const onEvent = (sessionId: string, event: Frame): void => {
        const type = str(event.type) ?? ""
        const data = isRecord(event.data) ? event.data : {}
        if (QUIET_EVENTS.has(type) || type.endsWith("_delta")) return
        if (humanMessage(event, data)) {
          humanAt.set(sessionId, now())
          handlers.focused(sessionId)
        }
        // A sub-agent's events are its parent's work, never a stop.
        if (event.agentId !== undefined) {
          if (!blocked.get(sessionId)?.size) working(sessionId)
          return
        }
        const transitionId = `${COPILOT_APP_HOST}:${sessionId}:${str(event.id) ?? `t${now()}`}`
        switch (type) {
          case "session.idle": {
            blocked.delete(sessionId)
            // A stop the human asked for is theirs to follow up.
            if (data.aborted === true) {
              cancel(sessionId)
              activity.set(sessionId, "idle")
              return handlers.focused(sessionId)
            }
            // The app sends idle only with no background agents or shells in flight; older builds listed them.
            const tasks = isRecord(data.backgroundTasks) ? data.backgroundTasks : null
            const running = tasks ? [tasks.agents, tasks.shells].some(list => Array.isArray(list) && list.length > 0) : false
            return settle(sessionId, transitionId, running)
          }
          case "session.shutdown":
            // The runtime ended: nothing is waiting and nothing can be answered.
            blocked.delete(sessionId)
            cancel(sessionId)
            activity.set(sessionId, "idle")
            return
          case "session.error":
            if (data.eligibleForAutoSwitch === true) break
            lastBody.set(sessionId, `Error: ${str(data.message) ?? str(data.errorType) ?? "unknown"}`)
            return settle(sessionId, transitionId, null)
          case "permission.requested":
            if (data.resolvedByHook === true || !str(data.requestId)) break
            return block(sessionId, data.requestId as string)
          case "permission.completed":
            return unblock(sessionId, str(data.requestId) ?? "")
          case "assistant.message":
            if (str(data.content)) lastBody.set(sessionId, data.content as string)
            break
          case "session.task_complete":
            if (str(data.summary)) lastBody.set(sessionId, data.summary as string)
            break
        }
        // A turn end is one model step, not a stop, and a waiting request keeps the session waiting.
        if (type === "assistant.turn_end" || blocked.get(sessionId)?.size) return
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
          // Advisory only: the send path re-checks focus through list().
          inventory = sessionsFrom(frame, (id) => now() - (humanAt.get(id) ?? -Infinity) < HUMAN_HOLD_MS)
          for (const id of [...activity.keys()]) if (!inventory.some(session => session.id === id)) activity.delete(id)
          return publish()
        }
        const sessionId = str(frame.session_id)
        if (!sessionId) return
        if (type === "session_event" && isRecord(frame.event)) {
          // History replays describe the past, never a new stop.
          if (!frame.history_request_id) onEvent(sessionId, frame.event)
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
        // Answers given while disconnected are not replayed, so nothing stays waiting across a gap.
        blocked.clear()
        if (closed) return
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!
        attempt += 1
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_copilot_app_closed", message: "Copilot app event stream closed; reconnecting", meta: { delay, error: error?.message ?? null } })
        publish("host_unavailable")
        cancelReconnect = schedule(connect, delay)
      }

      const connect = (): void => {
        cancelReconnect = null
        try {
          // Stops while disconnected are not replayed; the next idle or permission event is.
          stream = openStream(copilotAppUrl(stateDir), openSocket, onFrame, reconnect)
        } catch (error) {
          return reconnect(error as Error)
        }
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
