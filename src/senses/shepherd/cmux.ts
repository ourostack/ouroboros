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
 * Codex, Copilot and more). After a short grace period, a stop is dropped if the agent resumed or
 * cmux's session store says background work was still pending. Terminals no hook has spoken for
 * (an agent cmux does not hook, such as Agency today) are polled: output that stops changing for a
 * quiet window counts as a return. cmux has no bell or output event, so polling is the fallback.
 */
export const CMUX_STATUS_KEY = "ouro"
export const GRACE_MS = 3_000
export const POLL_MS = 4_000
export const QUIET_MS = 8_000
const POLL_LINES = 40
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const STOP_HOOKS = new Set(["Stop", "StopFailure"])
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
  const hooked = new Map<string, { agent: string; cwd: string | null; sessionId: string | null }>()
  const sessionSurface = new Map<string, string>()

  async function surfaces(): Promise<Surface[]> {
    const tree = await client.call("system.tree", { all_windows: true })
    return list(tree.windows).flatMap((window) => list(window.workspaces)).flatMap((workspace) =>
      list(workspace.panes).flatMap((pane) => list(pane.surfaces)).map((surface) => ({
        id: str(surface.id) ?? "",
        ref: str(surface.ref) ?? "",
        workspace: str(workspace.ref),
        workspaceId: str(workspace.id) ?? "",
        title: str(surface.title) ?? "",
        type: str(surface.type) ?? "",
        agent: hooked.get(str(surface.id) ?? "")?.agent ?? null,
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
      return (await surfaces()).filter((surface) => surface.type === "terminal").map(({ id, ref, workspace, title, agent }) => ({ id, ref, workspace, title, agent }))
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
      await client.command(status
        ? `set_status ${CMUX_STATUS_KEY} ${socketQuote(status)} --tab=${surface.workspaceId}`
        : `clear_status ${CMUX_STATUS_KEY} --tab=${surface.workspaceId}`)
      if (notification) await client.call("notification.create", { title: notification.title, subtitle: "", body: notification.body, workspace_id: surface.workspaceId })
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

      const cancelPending = (surfaceId: string): void => {
        pending.get(surfaceId)?.()
        pending.delete(surfaceId)
      }

      /** A stop becomes a return only if nothing resumed it within the grace period and cmux says no background work is pending. */
      const stopped = (surfaceId: string, transitionId: string, agent: string, sessionId: string | null, cwd: string | null): void => {
        cancelPending(surfaceId)
        pending.set(surfaceId, schedule(() => {
          pending.delete(surfaceId)
          const session = sessionId ? readCmuxHookSession(homeDir, agent, sessionId) : null
          if (session?.hadPendingBackgroundWorkAtStop === true || session?.agentLifecycle === "backgroundWorkPending" || session?.agentLifecycle === "running") {
            emitNervesEvent({ component: "senses", event: "senses.shepherd_stop_skipped", message: "a cmux stop left background work running; not a return", meta: { agent } })
            return
          }
          handlers.returned({ sessionId: surfaceId, transitionId, agent, cwd: str(session?.cwd) ?? cwd, lastBody: str(session?.lastBody) })
        }, GRACE_MS))
      }

      const onEvent = (frame: Record<string, unknown>): void => {
        const name = str(frame.name) ?? ""
        const payload = isRecord(frame.payload) ? frame.payload : {}
        const surfaceId = str(payload.surface_id) ?? str(frame.surface_id)
        if (name === "surface.focused" && surfaceId) return handlers.focused(surfaceId)
        if (name === "surface.closed" && surfaceId) {
          cancelPending(surfaceId)
          hooked.delete(surfaceId)
          screens.delete(surfaceId)
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
        hooked.set(surface, { agent, cwd, sessionId })
        if (STOP_HOOKS.has(hook)) stopped(surface, `cmux:${String(frame.boot_id)}:${String(frame.seq)}`, agent, sessionId, cwd)
        else if (!NEUTRAL_HOOKS.has(hook)) cancelPending(surface)
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

      /** Terminals with no hook: output that changed and then held still for the quiet window is a return. */
      const poll = async (): Promise<void> => {
        try {
          const terminals = (await surfaces()).filter((surface) => surface.type === "terminal" && !hooked.has(surface.id))
          const seen = new Set(terminals.map((surface) => surface.id))
          for (const id of screens.keys()) if (!seen.has(id)) screens.delete(id)
          for (const surface of terminals) {
            const hash = createHash("sha256").update(await read(surface.id, POLL_LINES)).digest("hex")
            const last = screens.get(surface.id)
            const at = now()
            if (!last) screens.set(surface.id, { hash, changedAt: at, active: false })
            else if (last.hash !== hash) screens.set(surface.id, { hash, changedAt: at, active: true })
            else if (last.active && at - last.changedAt >= QUIET_MS) {
              last.active = false
              handlers.returned({ sessionId: surface.id, transitionId: `cmux:quiet:${surface.id}:${last.changedAt}`, agent: null, cwd: null, lastBody: null })
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
