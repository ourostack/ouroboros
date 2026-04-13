import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonAgentSnapshot } from "./process-manager"
import {
  buildAgentProviderVisibility,
  isAgentProviderVisibility,
  type AgentProviderVisibility,
} from "../provider-visibility"

/**
 * The pulse: machine-wide situational awareness shared across all agents
 * on this machine. The daemon writes it; every agent's prompt assembly
 * reads it and renders a `## the pulse` section in the system prompt.
 *
 * Why "pulse": the harness uses a body metaphor (heart, mind, senses,
 * nerves, repertoire). The heart beats — the pulse is what its beating
 * produces. Adding `pulse` to the body extends the metaphor naturally.
 * Continuous, not discrete; you don't *check* a pulse, you *have* one.
 * Captures both healthy state ("strong pulse") and breakage ("missed beat").
 *
 * The pulse exists because this harness scales horizontally: multiple
 * peer agents on the same machine, each with their own identity and
 * bundle. They are NOT subagents — they are full agents who happen to
 * share a machine. Without the pulse they would be isolated workers
 * who don't even know each other exist. With it, they form a team.
 *
 * Lifecycle:
 *   1. Daemon's process manager flips an agent's snapshot (status,
 *      errorReason, etc.) due to lifecycle events (spawn, exit, config
 *      check failure, recovery).
 *   2. The pulse writer is notified via an onSnapshotChange callback,
 *      rebuilds the full pulse state, diffs against the previous, and
 *      writes ~/.ouro-cli/pulse.json.
 *   3. For "novel broken" transitions (an agent goes from healthy/unknown
 *      to crashed for the first time, OR with a different error than
 *      before), the writer fires inner.wake on the most-recently-active
 *      running agent so the user finds out within seconds rather than
 *      next-time-they-talk-to-someone.
 *   4. Persistent at-most-once delivery: the writer tracks delivered
 *      alert IDs in ~/.ouro-cli/pulse-delivered.json so daemon restarts
 *      don't re-page on the same broken state.
 *   5. The passive prompt section reads pulse.json on every prompt
 *      assembly, so even after the wake is suppressed, every agent still
 *      sees the broken state in their next turn.
 */

export interface PulseAgentEntry {
  /** Agent name (matches the bundle directory name minus `.ouro`). */
  name: string
  /** Absolute path to the agent's bundle. Lets sibling agents navigate
   *  there with read_file/glob/grep when conversation isn't an option. */
  bundlePath: string
  /** Current process status. */
  status: "running" | "starting" | "stopped" | "crashed"
  /** ISO timestamp of when this agent was most recently observed alive,
   *  or null if it has never been alive in this daemon process. */
  lastSeenAt: string | null
  /** Human-readable description of why this agent is broken, if it is.
   *  Mirrors checkAgentConfig's error field. Null when healthy. */
  errorReason: string | null
  /** Actionable command/instruction to fix the error. Null when healthy. */
  fixHint: string | null
  /** Stable identifier for the current broken state, used for at-most-once
   *  delivery tracking. Null when healthy. Format:
   *  `<agent>:<sha-of-errorReason>` so the same error generates the same
   *  ID across daemon restarts but a different error generates a new ID. */
  alertId: string | null
  /** What this sibling is currently doing, derived from their inner-dialog
   *  runtime.json. Examples: "running (instinct since 22:00)",
   *  "idle since 21:30", "currently in a turn". Null when the sibling has
   *  no readable runtime state (just started, or its runtime.json is
   *  missing/malformed). */
  currentActivity: string | null
  /** Safe provider/model/readiness view for this machine. Null when unavailable. */
  providerVisibility?: AgentProviderVisibility | null
}

export interface PulseState {
  /** ISO timestamp when this snapshot was generated. */
  generatedAt: string
  /** Daemon version that wrote this snapshot. Helps debugging when
   *  multiple daemon versions have touched the file. */
  daemonVersion: string
  /** Every agent the daemon manages on this machine, including those
   *  not currently running. */
  agents: PulseAgentEntry[]
}

export interface PulseDeliveredState {
  /** Set of alert IDs that have been delivered via inner.wake. */
  delivered: string[]
}

/* v8 ignore next 3 -- path defaults: tests always inject @preserve */
function defaultPulsePath(): string {
  return path.join(os.homedir(), ".ouro-cli", "pulse.json")
}

/* v8 ignore next 3 -- path defaults: tests always inject @preserve */
function defaultDeliveredPath(): string {
  return path.join(os.homedir(), ".ouro-cli", "pulse-delivered.json")
}

export function getPulsePath(): string {
  return defaultPulsePath()
}

export function getPulseDeliveredPath(): string {
  return defaultDeliveredPath()
}

/**
 * Hash an error reason into a short stable identifier. We use a simple
 * non-cryptographic hash because we only need stability across daemon
 * restarts on the same machine, not collision resistance against
 * adversaries. djb2 is fine.
 */
function hashErrorReason(reason: string): string {
  let h = 5381
  for (let i = 0; i < reason.length; i++) {
    h = ((h << 5) + h + reason.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

/**
 * Build a stable alert ID for a (agent, error) pair. Same agent + same
 * error → same ID, even across daemon restarts. Different error → new ID.
 */
export function buildAlertId(agent: string, errorReason: string): string {
  return `${agent}:${hashErrorReason(errorReason)}`
}

/**
 * Read an agent's inner-dialog runtime state and format it as a short
 * activity hint string suitable for display in another agent's pulse
 * section. Returns null when the file is missing or malformed — both
 * cases are silent (the pulse just doesn't include activity for that
 * agent).
 *
 * Pure: takes a file reader so tests can inject content without touching
 * fs. Defaults to fs.readFileSync for the production daemon caller.
 */
export function readAgentActivity(
  bundlePath: string,
  readFile: (filePath: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): string | null {
  const runtimePath = path.join(bundlePath, "state", "sessions", "self", "inner", "runtime.json")
  let raw: string
  try {
    raw = readFile(runtimePath)
  } catch {
    return null
  }
  let parsed: { status?: unknown; reason?: unknown; startedAt?: unknown }
  try {
    parsed = JSON.parse(raw) as { status?: unknown; reason?: unknown; startedAt?: unknown }
  } catch {
    return null
  }

  const status = typeof parsed.status === "string" ? parsed.status : null
  const reason = typeof parsed.reason === "string" ? parsed.reason : null
  const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : null

  if (!status) return null

  // Format compactly. Examples:
  //   "running (instinct since 23:44)"
  //   "idle since 21:30"
  //   "running"
  const sinceStr = startedAt ? ` since ${startedAt.slice(11, 16)}` : ""
  if (status === "running" && reason) {
    return `running (${reason}${sinceStr})`
  }
  return `${status}${sinceStr}`
}

/**
 * Convert daemon process-manager snapshots into the pulse state shape.
 * Pure: no fs side effects (activity reading goes through the injected
 * `readActivity` callback so tests can pin everything).
 *
 * The bundlePath comes from the bundlesRoot — we don't read the bundle
 * directly, we just compute where it lives so sibling agents have a
 * starting point if they want to navigate there manually.
 */
export function buildPulseState(
  snapshots: DaemonAgentSnapshot[],
  bundlesRoot: string,
  daemonVersion: string,
  now: Date,
  readActivity: (bundlePath: string) => string | null = readAgentActivity,
  readProviderVisibility: (agentName: string, bundlePath: string) => AgentProviderVisibility | null = () => null,
): PulseState {
  const agents: PulseAgentEntry[] = snapshots.map((snap) => {
    const errorReason = snap.errorReason
    const bundlePath = path.join(bundlesRoot, `${snap.name}.ouro`)
    return {
      name: snap.name,
      bundlePath,
      status: snap.status,
      lastSeenAt: snap.startedAt,
      errorReason,
      fixHint: snap.fixHint,
      alertId: errorReason ? buildAlertId(snap.name, errorReason) : null,
      // Only read activity for agents that are actually running. For
      // crashed/stopped agents, the runtime.json is stale at best.
      currentActivity: snap.status === "running" ? readActivity(bundlePath) : null,
      providerVisibility: readProviderVisibility(snap.name, bundlePath),
    }
  })

  return {
    generatedAt: now.toISOString(),
    daemonVersion,
    agents,
  }
}

/**
 * A "novel broken transition" is an agent that is currently broken AND
 * either (a) wasn't broken in the previous pulse state, OR (b) was broken
 * but with a different alertId. Used to decide when to fire an inner.wake
 * for proactive notification.
 *
 * Pure: takes prev and next states, returns the list of newly-broken
 * agents that warrant a wake.
 */
export function findNovelBrokenAgents(
  prev: PulseState | null,
  next: PulseState,
): PulseAgentEntry[] {
  const novel: PulseAgentEntry[] = []
  for (const agent of next.agents) {
    if (!agent.alertId) continue
    const prevAgent = prev?.agents.find((a) => a.name === agent.name)
    const wasBrokenWithSameAlert = prevAgent?.alertId === agent.alertId
    if (wasBrokenWithSameAlert) continue
    novel.push(agent)
  }
  return novel
}

/**
 * A "recovery transition" is an agent that was broken in the previous
 * pulse state but is healthy now. The pulse fires a wake on these too,
 * so the user gets a positive notification when their fix takes effect.
 *
 * Pure: takes prev and next states, returns the list of newly-recovered
 * agents that warrant a wake.
 */
export function findRecoveredAgents(
  prev: PulseState | null,
  next: PulseState,
): PulseAgentEntry[] {
  if (!prev) return []
  const recovered: PulseAgentEntry[] = []
  for (const agent of next.agents) {
    // Healthy in next.
    if (agent.alertId !== null) continue
    if (agent.status !== "running") continue
    // Was broken in prev.
    const prevAgent = prev.agents.find((a) => a.name === agent.name)
    if (!prevAgent || prevAgent.alertId === null) continue
    recovered.push(agent)
  }
  return recovered
}

/**
 * Build a stable alert ID for a recovery event. Used so the recovery
 * wake is also at-most-once (no re-paging on every snapshot change after
 * recovery). Includes the recovery timestamp so a later break+heal cycle
 * generates a fresh ID.
 */
export function buildRecoveryAlertId(agent: string, recoveredAt: string): string {
  return `recovery:${agent}:${recoveredAt}`
}

/**
 * Pick which agent should receive an inner.wake for a fleet alert. Heuristic:
 * the most-recently-active running agent (by `lastSeenAt`), excluding the
 * broken agent itself and any agents that aren't currently running. Returns
 * null if there's no eligible recipient (e.g., the only other agent on the
 * machine is also broken).
 *
 * Pure: takes the pulse state and the alert target, returns the chosen
 * recipient name or null.
 */
export function pickWakeRecipient(
  state: PulseState,
  brokenAgent: string,
): string | null {
  const candidates = state.agents
    .filter((a) => a.name !== brokenAgent)
    .filter((a) => a.status === "running")
    .filter((a) => a.lastSeenAt !== null)
    .sort((a, b) => {
      // Most-recent first. lastSeenAt is non-null per the filter above.
      const aMs = Date.parse(a.lastSeenAt!)
      const bMs = Date.parse(b.lastSeenAt!)
      return bMs - aMs
    })
  return candidates[0]?.name ?? null
}

export interface WritePulseDeps {
  writeFile?: (filePath: string, content: string) => void
  mkdirp?: (dir: string) => void
  pulsePath?: string
}

/**
 * Write the pulse state to disk. Best-effort: if the write fails, emit a
 * nerves event but do not throw. The pulse is a notification mechanism;
 * the daemon's primary work should not be blocked by it.
 */
export function writePulse(state: PulseState, deps: WritePulseDeps = {}): void {
  /* v8 ignore start -- dep defaults: production-only paths; tests inject all four explicitly @preserve */
  const filePath = deps.pulsePath ?? defaultPulsePath()
  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c, "utf-8"))
  const mkdirp = deps.mkdirp ?? ((d) => fs.mkdirSync(d, { recursive: true }))
  /* v8 ignore stop */

  try {
    mkdirp(path.dirname(filePath))
    writeFile(filePath, JSON.stringify(state, null, 2) + "\n")
    emitNervesEvent({
      component: "daemon",
      event: "daemon.pulse_written",
      message: "wrote machine pulse state",
      meta: { filePath, agentCount: state.agents.length },
    })
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.pulse_write_error",
      message: "failed to write pulse state",
      meta: {
        filePath,
        error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error),
      },
    })
  }
}

export interface ReadPulseDeps {
  readFile?: (filePath: string) => string
  pulsePath?: string
}

/**
 * Read the pulse state from disk. Returns null if the file doesn't exist
 * or is malformed — pulse readers (like the prompt assembler) should
 * gracefully degrade to "no pulse, render nothing" rather than crash.
 */
export function readPulse(deps: ReadPulseDeps = {}): PulseState | null {
  const filePath = deps.pulsePath ?? defaultPulsePath()
  /* v8 ignore next -- dep default: tests always inject @preserve */
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf-8"))

  try {
    const raw = readFile(filePath)
    const parsed = JSON.parse(raw) as Partial<PulseState>
    if (typeof parsed.generatedAt !== "string") return null
    if (typeof parsed.daemonVersion !== "string") return null
    if (!Array.isArray(parsed.agents)) return null
    return {
      generatedAt: parsed.generatedAt,
      daemonVersion: parsed.daemonVersion,
      agents: parsed.agents.filter(isValidPulseAgentEntry).map((agent) => {
        const rawAgent = agent as unknown as Record<string, unknown>
        if (!Object.prototype.hasOwnProperty.call(rawAgent, "providerVisibility")) return agent
        return {
          ...agent,
          providerVisibility: isAgentProviderVisibility(rawAgent.providerVisibility)
            ? rawAgent.providerVisibility
            : null,
        }
      }),
    }
  } catch {
    return null
  }
}

function isValidPulseAgentEntry(value: unknown): value is PulseAgentEntry {
  if (value === null || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === "string"
    && typeof v.bundlePath === "string"
    && (v.status === "running" || v.status === "starting" || v.status === "stopped" || v.status === "crashed")
    && (v.lastSeenAt === null || typeof v.lastSeenAt === "string")
    && (v.errorReason === null || typeof v.errorReason === "string")
    && (v.fixHint === null || typeof v.fixHint === "string")
    && (v.alertId === null || typeof v.alertId === "string")
  )
}

export interface DeliveredStateDeps {
  readFile?: (filePath: string) => string
  writeFile?: (filePath: string, content: string) => void
  mkdirp?: (dir: string) => void
  deliveredPath?: string
}

/**
 * Read the persistent delivered-alerts state. Returns an empty set if the
 * file doesn't exist or is malformed.
 */
export function readDeliveredState(deps: DeliveredStateDeps = {}): Set<string> {
  /* v8 ignore start -- dep defaults: production-only paths; tests inject all explicitly @preserve */
  const filePath = deps.deliveredPath ?? defaultDeliveredPath()
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf-8"))
  /* v8 ignore stop */

  try {
    const raw = readFile(filePath)
    const parsed = JSON.parse(raw) as Partial<PulseDeliveredState>
    if (!Array.isArray(parsed.delivered)) return new Set()
    return new Set(parsed.delivered.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

/**
 * Persist the delivered-alerts state to disk. Best-effort.
 */
export function writeDeliveredState(delivered: Set<string>, deps: DeliveredStateDeps = {}): void {
  /* v8 ignore start -- dep defaults: production-only paths; tests inject all four explicitly @preserve */
  const filePath = deps.deliveredPath ?? defaultDeliveredPath()
  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c, "utf-8"))
  const mkdirp = deps.mkdirp ?? ((d) => fs.mkdirSync(d, { recursive: true }))
  /* v8 ignore stop */

  try {
    mkdirp(path.dirname(filePath))
    const state: PulseDeliveredState = { delivered: [...delivered].sort() }
    writeFile(filePath, JSON.stringify(state, null, 2) + "\n")
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.pulse_delivered_write_error",
      message: "failed to write pulse delivered state",
      meta: {
        filePath,
        error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error),
      },
    })
  }
}

/**
 * Prune delivered alert IDs that no longer correspond to an active broken
 * agent. When the user fixes ouroboros's config, the next pulse state has
 * no alertId for ouroboros, so we drop the old delivered entry — meaning
 * if ouroboros breaks AGAIN later (with the same error), we re-page.
 */
export function pruneDeliveredState(
  delivered: Set<string>,
  state: PulseState,
): Set<string> {
  const liveAlertIds = new Set<string>()
  for (const agent of state.agents) {
    if (agent.alertId) liveAlertIds.add(agent.alertId)
  }
  const pruned = new Set<string>()
  for (const id of delivered) {
    if (liveAlertIds.has(id)) pruned.add(id)
  }
  return pruned
}

export interface FlushPulseDeps {
  /** Snapshots from the daemon's process manager. */
  snapshots: DaemonAgentSnapshot[]
  /** Where bundles live (used to compute bundlePath for each agent). */
  bundlesRoot: string
  /** Currently-running daemon version, stamped into the pulse state. */
  daemonVersion: string
  /** Time source — Date for production, fixed Date for tests. */
  now: Date
  /** Reads the previous pulse state from disk. Defaults to readPulse(). */
  readPrev?: () => PulseState | null
  /** Writes the new pulse state to disk. Defaults to writePulse(). */
  writeNext?: (state: PulseState) => void
  /** Reads the persistent delivered-alerts state. Defaults to readDeliveredState(). */
  readDelivered?: () => Set<string>
  /** Writes the persistent delivered-alerts state. Defaults to writeDeliveredState(). */
  writeDelivered?: (delivered: Set<string>) => void
  /** Fires inner.wake on the named agent. Returns true on success.
   *  Defaults are wired in by the daemon-entry; tests inject a mock. */
  fireInnerWake?: (agent: string) => void
}

export interface FlushPulseResult {
  /** The new pulse state that was just written. */
  state: PulseState
  /** Recipients that received an inner.wake for newly-broken siblings. */
  wakeFiredFor: string[]
  /** Alert IDs added to the delivered set in this flush. */
  newlyDelivered: string[]
}

/**
 * Single entry point the daemon's onSnapshotChange callback uses. Builds
 * the new pulse state, diffs against the previous, writes the file, and
 * fires inner.wake on novel broken transitions to the most-recently-active
 * sibling. Persistent at-most-once delivery via the delivered state file.
 *
 * Pure-ish: all I/O goes through dep callbacks so tests can pin every
 * input and assert every effect. Defaults wire to the real fs functions
 * for production callers.
 */
export function flushPulse(deps: FlushPulseDeps): FlushPulseResult {
  const state = buildPulseState(
    deps.snapshots,
    deps.bundlesRoot,
    deps.daemonVersion,
    deps.now,
    readAgentActivity,
    (agentName, bundlePath) => buildAgentProviderVisibility({ agentName, agentRoot: bundlePath }),
  )

  /* v8 ignore start -- dep defaults: production daemon path; the arrow functions only fire when the corresponding dep is omitted, which only happens in production code paths. Tests inject all deps explicitly. @preserve */
  const readPrev = deps.readPrev ?? (() => readPulse())
  const writeNext = deps.writeNext ?? ((s: PulseState) => writePulse(s))
  const readDelivered = deps.readDelivered ?? (() => readDeliveredState())
  const writeDelivered = deps.writeDelivered ?? ((d: Set<string>) => writeDeliveredState(d))
  const fireInnerWake = deps.fireInnerWake ?? null
  /* v8 ignore stop */

  const prev = readPrev()
  let delivered = readDelivered()

  // Write the new pulse state first so any reader (including the
  // wake-recipient agent's prompt assembly on its next turn) sees the
  // current state. Doing this before firing the wake matters: if the
  // wake races against a fast prompt build on the recipient, we want
  // the recipient to read the NEW state, not the old one.
  writeNext(state)

  // Find agents that newly transitioned to broken (or to a different
  // error than before).
  const novelBroken = findNovelBrokenAgents(prev, state)

  // Of those, the ones we haven't already delivered an alert for.
  const undeliveredBroken = novelBroken.filter((a) => a.alertId !== null && !delivered.has(a.alertId))

  // Find agents that newly recovered (were broken in prev, healthy now).
  const recovered = findRecoveredAgents(prev, state)

  // For recovery wakes, build a fresh alert ID per recovery event so
  // we don't re-page on every subsequent flush.
  const recoveryAlertIds = recovered.map((a) => buildRecoveryAlertId(a.name, state.generatedAt))
  const undeliveredRecovered = recovered.filter((_, i) => !delivered.has(recoveryAlertIds[i]!))

  // Fire wakes and update the delivered set.
  const wakeFiredFor: string[] = []
  const newlyDelivered: string[] = []
  for (const broken of undeliveredBroken) {
    /* v8 ignore next -- defensive: undeliveredBroken already filtered to non-null alertId; this is a TS narrowing helper @preserve */
    if (broken.alertId === null) continue
    const recipient = pickWakeRecipient(state, broken.name)
    if (recipient !== null && fireInnerWake !== null) {
      fireInnerWake(recipient)
      wakeFiredFor.push(recipient)
    }
    // Mark delivered even if no recipient was available — otherwise
    // the daemon will keep trying to wake every time the snapshot
    // changes, which would spam logs without producing any user value.
    // The passive prompt section still surfaces the broken state to
    // the recipient when they eventually have a turn for any reason.
    delivered.add(broken.alertId)
    newlyDelivered.push(broken.alertId)
  }

  for (let i = 0; i < undeliveredRecovered.length; i++) {
    const recoveredAgent = undeliveredRecovered[i]!
    const recoveryAlertId = buildRecoveryAlertId(recoveredAgent.name, state.generatedAt)
    const recipient = pickWakeRecipient(state, recoveredAgent.name)
    if (recipient !== null && fireInnerWake !== null) {
      fireInnerWake(recipient)
      wakeFiredFor.push(recipient)
    }
    delivered.add(recoveryAlertId)
    newlyDelivered.push(recoveryAlertId)
  }

  // Drop delivered ids for agents that have healed since (this drops
  // the original `agent_config_failure:...` IDs once the agent recovers,
  // so a future relapse re-pages). Recovery alert IDs are NOT pruned by
  // pruneDeliveredState because they're tied to a healthy state, not a
  // broken state — they live in the delivered set until the same agent
  // breaks and recovers again, at which point a new recovery ID is
  // generated and the old one becomes harmless cruft. We could clean
  // them up too, but the cost is bounded by the number of recovery
  // cycles, which is small.
  delivered = pruneDeliveredState(delivered, state)
  writeDelivered(delivered)

  return { state, wakeFiredFor, newlyDelivered }
}
