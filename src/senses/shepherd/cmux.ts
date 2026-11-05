import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CmuxClient, CmuxSocketError } from "./client"
import type { HostSession, HostWatchHandlers, ShepherdHost, ShepherdHostObservation, ShepherdInspection, ShepherdKey } from "./host"
import { identifyTerminalProcesses } from "./terminal-process"
import { inspectCodingPrompt } from "./prompt-state"
import { redactSecrets } from "./redact"

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
export const QUIET_MAX_MS = 60_000
const POLL_LINES = 40
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const STOP_HOOKS = new Set(["Stop", "StopFailure"])
/** Hooks after which the agent waits for the human: a stop, or a session that has not been given work yet. */
const IDLE_HOOKS = new Set([...STOP_HOOKS, "SessionStart"])
/** Hooks that say nothing about whether the main agent is working. */
const NEUTRAL_HOOKS = new Set(["SubagentStop", "Notification"])
/** Keys cmux presses with `surface.send_key`, by its own names; every other key is typed as its character. */
const NAMED_KEYS: Partial<Record<ShepherdKey, string>> = { enter: "enter", escape: "escape", up: "up", down: "down", tab: "tab", "ctrl-c": "ctrl+c" }
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
  identifyTerminals?: typeof identifyTerminalProcesses
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
  // Keep only an opaque digest, never a second private screen store. A copied/forged
  // inspection has no original-screen authority and is conservatively refused.
  const inspectedScreens = new WeakMap<ShepherdInspection, { hash: string; target: Surface }>()

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

  async function surfaceEntries(strict = false): Promise<Surface[]> {
    const tree = await client.call("system.tree", { all_windows: true })
    const records = (value: unknown): Record<string, unknown>[] => {
      if (strict && (!Array.isArray(value) || !value.every(isRecord))) throw new Error("invalid cmux terminal inventory")
      return list(value)
    }
    const seen = new Set<string>()
    return records(tree.windows).flatMap((window) => records(window.workspaces).map((workspace) => ({ window, workspace }))).flatMap(({ window, workspace }) =>
      records(workspace.panes).flatMap((pane) => records(pane.surfaces)).map((surface) => {
        if (strict && (typeof surface.id !== "string" || !surface.id.trim() || typeof surface.type !== "string"
          || !["terminal", "browser"].includes(surface.type) || seen.has(surface.id))) throw new Error("invalid cmux terminal inventory identity")
        seen.add(str(surface.id) ?? "")
        return {
        id: str(surface.id) ?? "",
        ref: str(surface.ref) ?? "",
        workspace: str(workspace.ref),
        workspaceTitle: str(workspace.title),
        workspaceId: str(workspace.id) ?? "",
        title: str(surface.title) ?? "",
        tty: str(surface.tty),
        type: str(surface.type) ?? "",
        agent: hooked.get(str(surface.id) ?? "")?.agent ?? null,
        cwd: hooked.get(str(surface.id) ?? "")?.cwd ?? null,
        // The human's terminal: the focused surface of the selected workspace in a visible window.
        focused: surface.focused === true && workspace.selected === true && window.visible !== false,
        ...(surface.focused === true && workspace.selected === true && window.visible !== false && window.key === true
          ? { selected: true } : {}),
        }
      }))
  }

  async function retirementInventory(): Promise<string[]> {
    return (await surfaceEntries(true)).filter(surface => surface.type === "terminal").map(surface => surface.id)
  }

  async function surfaces(freshFocus = false, strictInventory = false): Promise<Surface[]> {
    const entries = await surfaceEntries(strictInventory)
    const identities = await (options.identifyTerminals ?? identifyTerminalProcesses)(entries.filter((entry) => entry.type === "terminal" && entry.tty).map((entry) => entry.tty!))
    // Process lookup is awaited. On inspection paths, do not return focus from
    // the tree sampled before that await. A moved/rebound TTY loses authority.
    const current = freshFocus ? await surfaceEntries(strictInventory) : entries
    return current.map((entry) => {
      const bound = entries.some(before => before.id === entry.id && before.tty === entry.tty && before.workspaceId === entry.workspaceId && before.type === entry.type)
      const identity = entry.tty && bound ? identities.get(entry.tty.replace(/^\/dev\//, "")) : undefined
      return { ...entry, agent: identity?.agent ?? entry.agent, cwd: identity?.cwd ?? entry.cwd, ...(identity?.instance ? { instance: identity.instance } : {}) }
    })
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

  const sameBinding = (a: Surface, b: Surface): boolean =>
    a.id.toLowerCase() === b.id.toLowerCase() && a.workspaceId.toLowerCase() === b.workspaceId.toLowerCase() &&
    a.type === b.type && a.tty === b.tty && a.instance === b.instance && a.cwd === b.cwd &&
    a.agent === b.agent && a.focused === b.focused && a.title === b.title &&
    a.ref === b.ref && a.workspace === b.workspace && a.workspaceTitle === b.workspaceTitle && a.selected === b.selected

  async function explicitTarget(sessionId: string): Promise<Surface> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error("cmux inspection requires a surface UUID")
    const target = (await surfaces(true)).find(entry => entry.id.toLowerCase() === sessionId.toLowerCase() && entry.type === "terminal")
    if (!target) throw new Error("cmux inspection target disappeared")
    return target
  }

  async function boundRead(target: Surface): Promise<string> {
    const result = await client.call("surface.read_text", { surface_id: target.id, workspace_id: target.workspaceId, lines: 80, scrollback: false })
    if (str(result.surface_id)?.toLowerCase() !== target.id.toLowerCase() ||
      str(result.workspace_id)?.toLowerCase() !== target.workspaceId.toLowerCase() ||
      typeof result.text !== "string") throw new Error("cmux inspection target echo or text unavailable")
    return result.text
  }

  async function inspect(sessionId: string): Promise<ShepherdInspection> {
    const before = await explicitTarget(sessionId)
    const first = await boundRead(before)
    const current = await explicitTarget(sessionId)
    const screen = await boundRead(current)
    const after = await explicitTarget(sessionId)
    const stable = sameBinding(before, current) && sameBinding(current, after) && first === screen
    const state = stable ? inspectCodingPrompt(after.agent ?? "unknown", screen) : { activity: "unknown", composer: "unknown" } as const
    const { workspaceId: _workspaceId, type: _type, ...session } = after
    const screenFingerprint = createHash("sha256").update(screen).digest("hex")
    const inspection = {
      session, instance: after.instance ?? null, screen: redactSecrets(screen), ...state,
      screenFingerprint,
      backgroundWork: state.activity === "unknown" ? null : state.activity === "working",
    }
    inspectedScreens.set(inspection, { hash: screenFingerprint, target: after })
    return inspection
  }

  return {
    name: "cmux",
    async list() {
      return (await surfaces()).filter((surface) => surface.type === "terminal").map(({ workspaceId: _workspaceId, type: _type, ...session }) => session)
    },
    retirementInventory,
    read,
    inspect,
    async promptIfUnchanged(sessionId, line, expected, canSend?: () => boolean) {
      // Resolve first, then re-inspect. No server-side atomic CAS exists in cmux
      // 0.64: these are fresh client-side observations, not a lock on a human's UI.
      const target = await explicitTarget(sessionId)
      const current = await inspect(sessionId)
      const original = inspectedScreens.get(expected)
      const fresh = inspectedScreens.get(current)!
      if (!expected.instance || expected.activity !== "idle" || expected.composer !== "empty" ||
        expected.backgroundWork !== false || expected.session.focused ||
        current.instance !== expected.instance || current.activity !== "idle" ||
        current.composer !== "empty" || current.backgroundWork !== false || current.session.focused ||
        !current.session.tty || !current.session.cwd ||
        current.session.id !== expected.session.id || current.session.tty !== expected.session.tty ||
        current.session.cwd !== expected.session.cwd || current.session.agent !== expected.session.agent ||
        current.session.workspace !== expected.session.workspace || current.screen !== expected.screen ||
        !sameBinding(target, fresh.target) || !original || !sameBinding(original.target, fresh.target) ||
        fresh.hash !== original.hash) {
        return { state: "not_sent", reason: "inspection changed or lacks idle empty unfocused instance authority" }
      }
      const inputTarget = { workspace_id: target.workspaceId, surface_id: target.id }
      // The sense owns generation, shutdown, recent focus and guidance. Its
      // synchronous last check closes invalidation during the awaited host reads.
      if (canSend && !canSend()) return { state: "not_sent", reason: "parent dispatch guard invalidated" }
      // From this point every exception is uncertain, including a rejected or
      // partially accepted paste. Never turn it into a definite not_sent.
      await client.call("terminal.paste", { ...inputTarget, text: line, submit_key: "none" })
      await new Promise(resolve => schedule(() => resolve(undefined), SUBMIT_DELAY_MS))
      await client.call("surface.send_key", { ...inputTarget, key: "enter" })
      emitNervesEvent({ component: "senses", event: "senses.shepherd_cmux_prompted", message: "typed a guarded line into a cmux terminal", meta: { chars: line.length } })
      return { state: "sent" }
    },
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
      const named = NAMED_KEYS[key]
      if (named) await client.call("surface.send_key", { ...target, key: named })
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

      let lastObserved: ShepherdHostObservation["sessions"] = []
      /** Inventory reads stay outside the judge queue; idle-hook terminals are observed but never rejudged here. */
      const poll = async (): Promise<void> => {
        try {
          const terminals = (await surfaces(false, !!handlers.observed)).filter((surface) => surface.type === "terminal")
          if (closed) return
          const seen = new Set(terminals.map((surface) => surface.id))
          for (const id of screens.keys()) if (!seen.has(id)) screens.delete(id)
          const rows: ShepherdHostObservation["sessions"] = []
          for (const surface of terminals) {
            const idle = hooked.get(surface.id)?.idle === true
            if (idle) screens.delete(surface.id)
            if (idle && !handlers.observed) continue
            let text: string
            try { text = await read(surface.id, POLL_LINES) } catch (error) {
              rows.push({ session: surface, activity: "unknown", observedAt: null, error: "read_failed" })
              emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_cmux_poll_error",
                message: "could not read one cmux terminal; other terminals remain observable", meta: { error: redactSecrets(String(error)) } })
              continue
            }
            if (closed) return
            rows.push({ session: surface, activity: surface.agent ? inspectCodingPrompt(surface.agent, text).activity : "unknown", observedAt: now() })
            if (idle) continue
            const hash = createHash("sha256").update(text).digest("hex")
            const last = screens.get(surface.id)
            const at = now()
            if (!last) screens.set(surface.id, { hash, changedAt: at, active: false })
            else if (last.hash !== hash) {
              screens.set(surface.id, { hash, changedAt: at, active: true })
              clearStatus(surface.id)
            } else if (last.active && at - last.changedAt >= Math.max(quietMs.get(surface.id) ?? QUIET_MS, hooked.has(surface.id) ? HOOKED_QUIET_MS : 0)) {
              last.active = false
              handlers.returned({ sessionId: surface.id, transitionId: `cmux:quiet:${surface.id}:${last.changedAt}`, agent: surface.agent, cwd: surface.cwd ?? null, title: surface.title, workspaceTitle: surface.workspaceTitle, lastBody: null, backgroundWork: null })
            }
          }
          if (closed) return
          lastObserved = rows
          handlers.observed?.({ at: now(), sessions: rows })
        } catch (error) {
          emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_cmux_poll_error", message: "could not poll cmux terminals; the next poll retries", meta: { error: (error as Error).message } })
          if (!closed) handlers.observed?.({ at: now(), sessions: lastObserved, error: "host_unavailable" })
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
