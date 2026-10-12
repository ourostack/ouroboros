import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CmuxClient, CmuxSocketError } from "./client"
import type { HostSession, HostWatchHandlers, ShepherdHost, ShepherdKey } from "./host"

/**
 * The cmux host (0.64.22 or later). A return is cmux's own "agent stopped" signal: an
 * `agent.hook.Stop` event, which cmux publishes for every agent its hooks cover (Claude Code,
 * Codex, Copilot and more). After a short grace period, a stop is dropped if the agent resumed. A
 * stop that cmux's session store says left background work running waits longer, and is then
 * passed on marked as such: the agent is still working, not handing back control. Every terminal
 * whose agent is not idle is also polled: output that stops changing for a quiet window counts
 * as a return. That covers an agent cmux does not hook, and a hooked agent sitting mid-turn at a
 * prompt that fires no stop (a permission or trust question); a hooked agent gets a longer window,
 * because its stop normally speaks first. cmux has no bell or output event, so polling is the fallback.
 */
export const CMUX_STATUS_KEY = "ouro"
export const GRACE_MS = 3_000
/** A stop with background work still running waits this much longer before it is judged (as working, unless the work finished). */
export const BACKGROUND_GRACE_MS = 30_000
export const POLL_MS = 4_000
export const QUIET_MS = 8_000
/** A hooked agent mid-turn: long enough that a stop hook or a spinner normally speaks before the quiet screen does. */
export const HOOKED_QUIET_MS = 20_000
/** A quiet terminal judged as still working or not an agent is checked less often, doubling up to this. */
export const QUIET_MAX_MS = 300_000
const POLL_LINES = 40
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const STOP_HOOKS = new Set(["Stop", "StopFailure"])
/** Hooks after which the agent waits for the human: a stop, or a session that has not been given work yet. */
const IDLE_HOOKS = new Set([...STOP_HOOKS, "SessionStart"])
/** Hooks that say nothing about whether the main agent is working. */
const NEUTRAL_HOOKS = new Set(["SubagentStop", "Notification"])
const NAMED_KEYS = new Set<ShepherdKey>(["enter", "escape", "up", "down", "tab"])
const SUBMIT_DELAY_MS = 300

/** A timer that can be cancelled; the sense and the host take it as an option so tests can drive time. */
export function realSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

export interface CmuxHostOptions {
  homeDir?: string
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** A v1 socket argument: quoted, with the characters cmux's tokenizer treats as special escaped. */
function socketQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`
}

interface Surface extends HostSession { workspaceId: string; type: string }

/** cmux keeps each hooked agent's session in `~/.cmuxterm/<agent>-hook-sessions.json`, keyed by the agent's own session id. */
export function readCmuxHookSession(homeDir: string, agent: string, sessionId: string): Record<string, unknown> | null {
  try {
    const store: unknown = JSON.parse(fs.readFileSync(path.join(homeDir, ".cmuxterm", `${path.basename(agent)}-hook-sessions.json`), "utf-8"))
    const sessions = isRecord(store) && isRecord(store.sessions) ? store.sessions : {}
    // Hook events name the session `<agent>-<id>`; the store keys it by the bare id.
    const key = [sessionId, sessionId.replace(`${agent}-`, "")].find((candidate) => isRecord(sessions[candidate]))
    return key ? sessions[key] as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function createCmuxHost(client: CmuxClient, options: CmuxHostOptions = {}): ShepherdHost {
  const homeDir = options.homeDir ?? os.homedir()
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? realSchedule
  /** What hook events taught: which surface a session runs in, and which agent and folder it has. */
  const hooked = new Map<string, { agent: string; cwd: string | null; sessionId: string | null; idle: boolean }>()
  const sessionSurface = new Map<string, string>()
  /** Terminals showing a Shepherd status, so it can be cleared when the agent resumes. */
  const statused = new Map<string, { key: string; workspaceId: string }>()
  /** Quiet windows stretched by `pace`. */
  const quietMs = new Map<string, number>()

  /** One status entry per terminal: cmux keys status pills per workspace, and a workspace can hold several agents. */
  const statusKey = (surface: Surface): string => `${CMUX_STATUS_KEY}_${surface.ref.replace(/\W/g, "_")}`

  const clearStatus = (surfaceId: string): void => {
    const entry = statused.get(surfaceId)
    if (!entry) return
    statused.delete(surfaceId)
    client.command(`clear_status ${entry.key} --tab=${entry.workspaceId}`).catch((error: Error) => {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_cmux_status_error", message: "could not clear a Shepherd status", meta: { error: error.message } })
    })
  }

  async function surfaces(): Promise<Surface[]> {
    const tree = await client.call("system.tree", { all_windows: true })
    return list(tree.windows).flatMap((window) => list(window.workspaces).map((workspace) => ({ window, workspace }))).flatMap(({ window, workspace }) =>
      list(workspace.panes).flatMap((pane) => list(pane.surfaces)).map((surface) => ({
        id: str(surface.id) ?? "",
        ref: str(surface.ref) ?? "",
        workspace: str(workspace.ref),
        workspaceId: str(workspace.id) ?? "",
        title: str(surface.title) ?? "",
        type: str(surface.type) ?? "",
        agent: hooked.get(str(surface.id) ?? "")?.agent ?? null,
        // The human's terminal: the focused surface of the selected workspace in a visible window.
        focused: surface.focused === true && workspace.selected === true && window.visible !== false,
      })))
  }

  async function locate(sessionId: string): Promise<Surface> {
    const surface = (await surfaces()).find((entry) => entry.id === sessionId || entry.ref === sessionId)
    if (!surface) throw new Error(`no cmux terminal ${sessionId}`)
    return surface
  }

  async function read(sessionId: string, lines: number): Promise<string> {
    const result = await client.call("surface.read_text", { surface_id: sessionId, lines, scrollback: true })
    return typeof result.text === "string" ? result.text : ""
  }

  return {
    name: "cmux",
    async list() {
      return (await surfaces()).filter((surface) => surface.type === "terminal").map(({ id, ref, workspace, title, agent, focused }) => ({ id, ref, workspace, title, agent, focused }))
    },
    read,
    async prompt(sessionId, line) {
      const surface = await locate(sessionId)
      const target = { workspace_id: surface.workspaceId, surface_id: surface.id }
      // A paste lands as one block, so no character of it is read as a keystroke; Enter follows on its own.
      await client.call("terminal.paste", { ...target, text: line, submit_key: "none" })
      await new Promise((resolve) => schedule(() => resolve(undefined), SUBMIT_DELAY_MS))
      await client.call("surface.send_key", { ...target, key: "enter" })
      emitNervesEvent({ component: "senses", event: "senses.shepherd_cmux_prompted", message: "typed a line into a cmux terminal", meta: { chars: line.length } })
    },
    async key(sessionId, key) {
      const surface = await locate(sessionId)
      const target = { workspace_id: surface.workspaceId, surface_id: surface.id }
      if (NAMED_KEYS.has(key)) await client.call("surface.send_key", { ...target, key })
      else await client.call("surface.send_text", { ...target, text: key })
    },
    async signal(sessionId, status, notification) {
      const surface = await locate(sessionId)
      const key = statusKey(surface)
      await client.command(status
        ? `set_status ${key} ${socketQuote(status)} --tab=${surface.workspaceId} --panel=${surface.id}`
        : `clear_status ${key} --tab=${surface.workspaceId}`)
      if (status) statused.set(surface.id, { key, workspaceId: surface.workspaceId })
      else statused.delete(surface.id)
      if (notification) await client.call("notification.create", { title: notification.title, subtitle: "", body: notification.body, workspace_id: surface.workspaceId })
    },
    pace(sessionId, slower) {
      if (slower) quietMs.set(sessionId, Math.min((quietMs.get(sessionId) ?? QUIET_MS) * 2, QUIET_MAX_MS))
      else quietMs.delete(sessionId)
    },
    watch(handlers: HostWatchHandlers) {
      let closed = false
      let cursor: number | null = null
      let attempt = 0
      let stream: { close: () => void } | null = null
      let cancelReconnect: (() => void) | null = null
      let cancelPoll: (() => void) | null = null
      const pending = new Map<string, () => void>()
      const screens = new Map<string, { hash: string; changedAt: number; active: boolean }>()

      const forget = (surfaceId: string): void => {
        hooked.delete(surfaceId)
        for (const [session, surface] of sessionSurface) if (surface === surfaceId) sessionSurface.delete(session)
      }

      const cancelPending = (surfaceId: string): void => {
        pending.get(surfaceId)?.()
        pending.delete(surfaceId)
      }

      /** A stop becomes a return only if nothing resumed it within the grace period; background work earns it a longer wait. */
      const stopped = (surfaceId: string, transitionId: string, agent: string, sessionId: string | null, cwd: string | null, waited = false): void => {
        cancelPending(surfaceId)
        pending.set(surfaceId, schedule(() => {
          pending.delete(surfaceId)
          const session = sessionId ? readCmuxHookSession(homeDir, agent, sessionId) : null
          const backgroundWork = session?.hadPendingBackgroundWorkAtStop === true || session?.agentLifecycle === "backgroundWorkPending" || session?.agentLifecycle === "running"
          if (backgroundWork && !waited) {
            emitNervesEvent({ component: "senses", event: "senses.shepherd_stop_deferred", message: "a cmux stop left background work running; waiting longer", meta: { agent } })
            return stopped(surfaceId, transitionId, agent, sessionId, cwd, true)
          }
          handlers.returned({ sessionId: surfaceId, transitionId, agent, cwd: str(session?.cwd) ?? cwd, lastBody: str(session?.lastBody), backgroundWork })
        }, waited ? BACKGROUND_GRACE_MS : GRACE_MS))
      }

      const onEvent = (frame: Record<string, unknown>): void => {
        const name = str(frame.name) ?? ""
        const payload = isRecord(frame.payload) ? frame.payload : {}
        const surfaceId = str(payload.surface_id) ?? str(frame.surface_id)
        if (name === "surface.focused" && surfaceId) {
          quietMs.delete(surfaceId)
          return handlers.focused(surfaceId)
        }
        if (name === "surface.closed" && surfaceId) {
          cancelPending(surfaceId)
          forget(surfaceId)
          screens.delete(surfaceId)
          statused.delete(surfaceId)
          return
        }
        if (!name.startsWith("agent.hook.") || (payload.phase !== undefined && payload.phase !== "received")) return
        const hook = name.slice("agent.hook.".length)
        const sessionId = str(payload.session_id)
        if (sessionId && surfaceId) sessionSurface.set(sessionId, surfaceId)
        const surface = surfaceId ?? (sessionId ? sessionSurface.get(sessionId) : undefined)
        if (!surface) return
        const agent = str(payload._source) ?? str(frame.source) ?? "unknown"
        const cwd = str(payload.cwd)
        const neutral = NEUTRAL_HOOKS.has(hook)
        // An idle agent's return came from its stop; the quiet-screen poll leaves it alone until it works again.
        hooked.set(surface, { agent, cwd, sessionId, idle: IDLE_HOOKS.has(hook) || (neutral && hooked.get(surface)?.idle === true) })
        if (STOP_HOOKS.has(hook)) return stopped(surface, `cmux:${String(frame.boot_id)}:${String(frame.seq)}`, agent, sessionId, cwd)
        if (neutral || hook === "SessionStart") return
        // The agent is working again: no pending stop, no stale status, and its quiet screen is checked at the normal pace.
        cancelPending(surface)
        clearStatus(surface)
        quietMs.delete(surface)
        // An agent that exited leaves a plain terminal, which the quiet-screen fallback watches again.
        if (hook === "SessionEnd") forget(surface)
      }

      const connect = (): void => {
        cancelReconnect = null
        stream = client.stream({ ...(cursor !== null ? { after_seq: cursor } : {}), categories: ["agent", "surface"], include_heartbeats: false }, {
          onFrame: (frame) => {
            if (frame.type === "ack") {
              attempt = 0
              const resume = isRecord(frame.resume) ? frame.resume : {}
              // A first connection, a restart or a gap starts from cmux's latest event: old stops are not replayed as new returns.
              if (cursor === null || resume.gap === true) cursor = typeof resume.latest_seq === "number" ? resume.latest_seq : cursor
              emitNervesEvent({ component: "senses", event: "senses.shepherd_cmux_connected", message: "cmux event stream connected", meta: { gap: resume.gap === true } })
              return
            }
            if (frame.type !== "event" || typeof frame.seq !== "number" || (cursor !== null && frame.seq <= cursor)) return
            cursor = frame.seq
            onEvent(frame)
          },
          onClose: (error?: CmuxSocketError) => {
            stream = null
            if (closed) return
            const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!
            attempt += 1
            emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_cmux_closed", message: "cmux event stream closed; reconnecting", meta: { delay, error: error?.message ?? null } })
            cancelReconnect = schedule(connect, delay)
          },
        })
      }

      /** Terminals whose agent is not idle: output that changed and then held still for the quiet window is a return. */
      const poll = async (): Promise<void> => {
        try {
          const terminals = (await surfaces()).filter((surface) => surface.type === "terminal" && hooked.get(surface.id)?.idle !== true)
          const seen = new Set(terminals.map((surface) => surface.id))
          for (const id of screens.keys()) if (!seen.has(id)) screens.delete(id)
          for (const surface of terminals) {
            const hash = createHash("sha256").update(await read(surface.id, POLL_LINES)).digest("hex")
            const last = screens.get(surface.id)
            const at = now()
            if (!last) screens.set(surface.id, { hash, changedAt: at, active: false })
            else if (last.hash !== hash) {
              screens.set(surface.id, { hash, changedAt: at, active: true })
              clearStatus(surface.id)
            } else if (last.active && at - last.changedAt >= Math.max(quietMs.get(surface.id) ?? QUIET_MS, hooked.has(surface.id) ? HOOKED_QUIET_MS : 0)) {
              last.active = false
              const hook = hooked.get(surface.id)
              handlers.returned({ sessionId: surface.id, transitionId: `cmux:quiet:${surface.id}:${last.changedAt}`, agent: hook?.agent ?? null, cwd: hook?.cwd ?? null, lastBody: null, backgroundWork: null })
            }
          }
        } catch (error) {
          emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_cmux_poll_error", message: "could not poll cmux terminals; the next poll retries", meta: { error: (error as Error).message } })
        }
        if (!closed) cancelPoll = schedule(() => void poll(), POLL_MS)
      }

      connect()
      void poll()
      return {
        close() {
          closed = true
          cancelReconnect?.()
          cancelPoll?.()
          for (const cancel of pending.values()) cancel()
          stream?.close()
        },
      }
    },
  }
}
