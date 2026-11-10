/**
 * Home-machine leases: each agent runs on exactly one machine.
 *
 * The lease lives in the bundle's synced agent.json as `home`, naming the
 * machine (by its stable `~/.ouro-cli/machine.json` id) that runs the agent.
 * Agent discovery reads it (see `AgentHomeState` in agent-discovery.ts); this
 * module writes it (`ouro move <agent> here`) and checks a running daemon
 * against it.
 *
 * A move is a compare-and-swap on the bundle's remote. It runs under the
 * bundle sync lock, honours a sync pause, and names `<remote>` and
 * `sync.branch` explicitly (never `@{u}`). It starts only from a bundle that
 * is exactly at `<remote>/<branch>` (nothing unpushed, agent.json clean),
 * commits only agent.json and pushes `HEAD:<branch>`. A fast-forward push
 * succeeds only if nobody pushed in between. When the push is refused, the
 * move is undone; if the remote's lease changed meanwhile, another machine won
 * and the move stops, otherwise it is retried once on the new remote state.
 */

import * as fs from "fs"
import * as path from "path"
import { execFile as nodeExecFile, execFileSync as nodeExecFileSync } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"
import type { SyncConfig } from "../config"
import { fetchRemote, holdSyncLock, pushHeadToBranch, syncPausedUntil, syncTrackingRef, type BranchPushResult, type SyncResult } from "../sync"
import { agentHomeLabel, listAllBundleAgents, parseAgentHome, type AgentHome } from "./agent-discovery"
import { parsePresenceBlock } from "./presence"
import type { DaemonHealthResult } from "./daemon"

type GitExec = (command: string, args: string[], options: { cwd: string; stdio: "pipe"; timeout: number }) => Buffer | string

export interface MoveAgentHomeOptions {
  agent: string
  machineId: string
  machineName: string
  bundlesRoot: string
  now?: () => Date
  /** Local git (status, merge, commit, reset). */
  execFileSync?: GitExec
  /** How long to wait for the bundle sync lock before reporting busy. Default 10 s. */
  lockWaitMs?: number
  /** Network git, under the lock. Defaults to sync's detached fetch and push. */
  network?: MoveNetwork
}

export interface MoveNetwork {
  fetch(agentRoot: string, config: SyncConfig): Promise<SyncResult>
  push(agentRoot: string, config: SyncConfig): Promise<BranchPushResult>
}

const SYNC_NETWORK: MoveNetwork = {
  fetch: (agentRoot, config) => fetchRemote(agentRoot, config),
  push: (agentRoot, config) => pushHeadToBranch(agentRoot, config),
}

export interface MoveAgentHomeResult {
  ok: boolean
  message: string
  /** True when the bundle actually changed. */
  changed: boolean
}

const MOVE_ATTEMPTS = 2
const MOVE_LOCK_WAIT_MS = 10_000

function readSyncSettings(parsed: Record<string, unknown>): SyncConfig & { branch: string } {
  const sync = parsed.sync as { enabled?: unknown; remote?: unknown; branch?: unknown } | undefined
  return {
    enabled: sync?.enabled === true,
    remote: typeof sync?.remote === "string" && sync.remote.trim() ? sync.remote : "origin",
    branch: typeof sync?.branch === "string" && sync.branch.trim() ? sync.branch : "main",
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A readable machine name for a lease: the hostname without `.local`, or the id. */
export function machineDisplayName(hostname: string, machineId: string): string {
  return hostname.trim().replace(/\.local$/, "") || machineId
}

/** The last push failure the bundle sync recorded, if any. */
function recordedPushError(agentRoot: string): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "pending-sync.json"), "utf-8")) as { error?: unknown }
    return typeof record.error === "string" && record.error.trim() ? record.error.trim() : null
  } catch {
    return null
  }
}

/** What an update to the synced agent.json decides, given the agent.json it found. */
export type AgentJsonDecision =
  | { kind: "write"; next: Record<string, unknown>; commitMessage: string; message: string }
  | { kind: "noop"; message: string }
  | { kind: "refuse"; message: string }

export interface SyncedAgentJsonUpdate {
  agent: string
  bundlesRoot: string
  /** The command a person reruns after a refusal (e.g. `ouro move <agent> here`). */
  retryCommand: string
  /** Nerves event names: `<events>_start`, `<events>_end`, `<events>_error`. */
  events: string
  meta?: Record<string, unknown>
  /** The part of agent.json this update compares across attempts; a change by another machine stops it. */
  stamp(parsed: Record<string, unknown>): string
  /** What this change is called in messages ("move", "handoff") and the verb for an unexpected failure. */
  noun: string
  verb: string
  /** The field another machine changed, and what it says now. */
  lostRace(parsed: Record<string, unknown>): { field: string; now: string }
  /** Decide from the agent.json found (local without sync, else the remote's). */
  decide(parsed: Record<string, unknown>, where: "local" | "remote"): AgentJsonDecision
  execFileSync?: GitExec
  lockWaitMs?: number
  network?: MoveNetwork
}

/**
 * Compare-and-swap one change to a bundle's synced agent.json on its remote.
 * `ouro move` and `ouro presence` share it; see the header for the protocol.
 */
export async function updateSyncedAgentJson(options: SyncedAgentJsonUpdate): Promise<MoveAgentHomeResult> {
  const { agent, retryCommand } = options
  const agentRoot = path.join(options.bundlesRoot, `${agent}.ouro`)
  const configPath = path.join(agentRoot, "agent.json")
  const git = options.execFileSync ?? nodeExecFileSync
  const network = options.network ?? SYNC_NETWORK
  const run = (args: string[]): string => git("git", args, { cwd: agentRoot, stdio: "pipe", timeout: 30_000 }).toString().trim()

  emitNervesEvent({
    component: "daemon",
    event: `${options.events}_start`,
    message: "updating the synced agent.json",
    meta: { agent, ...options.meta },
  })
  const finish = (result: MoveAgentHomeResult): MoveAgentHomeResult => {
    emitNervesEvent({
      level: result.ok ? "info" : "warn",
      component: "daemon",
      event: result.ok ? `${options.events}_end` : `${options.events}_error`,
      message: result.message,
      meta: { agent, ...options.meta, changed: result.changed },
    })
    return result
  }
  const refuse = (message: string): MoveAgentHomeResult => finish({ ok: false, changed: false, message })

  const readConfig = (): { text: string; parsed: Record<string, unknown> } => {
    const text = fs.readFileSync(configPath, "utf-8")
    return { text, parsed: JSON.parse(text) as Record<string, unknown> }
  }
  const writeConfig = (next: Record<string, unknown>): void => {
    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8")
  }

  let config: { text: string; parsed: Record<string, unknown> }
  try {
    config = readConfig()
  } catch (error) {
    return refuse(`cannot read ${configPath}: ${errorText(error)}`)
  }

  const sync = readSyncSettings(config.parsed)
  const hasGit = fs.existsSync(path.join(agentRoot, ".git"))
  if (!sync.enabled || !hasGit) {
    const decision = options.decide(config.parsed, "local")
    if (decision.kind === "refuse") return refuse(decision.message)
    if (decision.kind === "noop") return finish({ ok: true, changed: false, message: decision.message })
    writeConfig(decision.next)
    const why = sync.enabled ? "the bundle is not a git repo" : "bundle sync is off"
    return finish({ ok: true, changed: true, message: `${decision.message}; ${why}, so only this machine sees the change` })
  }

  const pausedRefusal = (until: string): MoveAgentHomeResult =>
    refuse(`${agent}'s bundle sync is paused until ${until}, so nothing changed; run \`${retryCommand}\` again after that`)
  const pausedUntil = syncPausedUntil(agentRoot)
  if (pausedUntil !== null) return pausedRefusal(pausedUntil)
  const lock = await holdSyncLock(agentRoot, options.lockWaitMs ?? MOVE_LOCK_WAIT_MS)
  if ("busy" in lock) {
    return refuse(`another bundle sync holds ${agent}'s lock${lock.holderPid === null ? "" : ` (pid ${lock.holderPid})`}, so nothing changed; try again in a moment`)
  }
  try {
    // A pause can begin while this update waited for the lock (the replay gate
    // pauses, then takes the lock), so look again now that the lock is ours.
    const pausedNow = syncPausedUntil(agentRoot)
    if (pausedNow !== null) return pausedRefusal(pausedNow)
    if (run(["status", "--porcelain", "--", "agent.json"]).length > 0) {
      return refuse(`${agent}'s agent.json has uncommitted changes, so nothing changed; commit or discard them first (git -C ${agentRoot} diff agent.json)`)
    }
    const hasRemote = run(["remote"]).split("\n").includes(sync.remote)
    const tracking = syncTrackingRef(sync)

    let seen: string | null = null
    let lastPushError = ""
    for (let attempt = 1; attempt <= MOVE_ATTEMPTS; attempt++) {
      if (hasRemote) {
        const fetched = await network.fetch(agentRoot, sync)
        if (!fetched.ok) {
          return refuse(`could not reach ${agent}'s bundle remote, so nothing changed: ${fetched.error}`)
        }
        try {
          run(["rev-parse", "--verify", "-q", tracking])
        } catch {
          return refuse(`${agent}'s bundle remote has no ${sync.branch} branch to publish the ${options.noun} to, so nothing changed`)
        }
        const unpushed = Number(run(["rev-list", "--count", `${tracking}..HEAD`]))
        if (unpushed > 0) {
          const recorded = recordedPushError(agentRoot)
          const why = recorded ? `the last bundle push failed with: ${recorded}` : `run \`ouro sync --agent ${agent}\` to see why they did not publish`
          return refuse(`${agent}'s bundle has ${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}, so nothing changed; fix bundle sync first, because a ${options.noun} must not publish them as a side effect (${why})`)
        }
        try {
          run(["merge", "--ff-only", "-q", tracking])
        } catch (error) {
          return refuse(`could not bring ${agent}'s bundle up to date with its remote, so nothing changed: ${errorText(error)}`)
        }
        config = readConfig()
      }

      const stamp = options.stamp(config.parsed)
      if (attempt === 1) {
        seen = stamp
      } else if (stamp !== seen) {
        const lost = options.lostRace(config.parsed)
        return refuse(`another machine changed ${agent}'s ${lost.field} while this ${options.noun} was being published (${lost.now}), so this ${options.noun} was undone; run \`${retryCommand}\` again to take it over`)
      }
      const decision = options.decide(config.parsed, hasRemote ? "remote" : "local")
      if (decision.kind === "refuse") return refuse(decision.message)
      if (decision.kind === "noop") return finish({ ok: true, changed: false, message: decision.message })

      writeConfig(decision.next)
      try {
        run(["-c", `user.name=${agent}`, "-c", `user.email=${agent}@ouro.local`, "commit", "-q", "-m", decision.commitMessage, "--", "agent.json"])
      } catch (error) {
        fs.writeFileSync(configPath, config.text, "utf-8")
        return refuse(`could not commit the ${options.noun}, so nothing changed: ${errorText(error)}`)
      }
      if (!hasRemote) {
        return finish({ ok: true, changed: true, message: `${decision.message}; the bundle has no remote, so only this machine sees the change` })
      }
      const pushed = await network.push(agentRoot, sync)
      if (pushed.ok) return finish({ ok: true, changed: true, message: decision.message })
      lastPushError = pushed.error ?? "push failed"
      // Undo exactly our own commit; the working tree goes back to the
      // previous agent.json. If even that fails, say what to run by hand.
      try {
        run(["reset", "-q", "--soft", "HEAD~1"])
        run(["reset", "-q", "HEAD", "--", "agent.json"])
        fs.writeFileSync(configPath, config.text, "utf-8")
      } catch (error) {
        return refuse(`the ${options.noun} could not be pushed (${lastPushError}) and its local commit could not be undone (${errorText(error)}); run \`git -C ${agentRoot} reset --soft HEAD~1\` and restore agent.json`)
      }
    }
    return refuse(`could not push the ${options.noun}, so nothing changed: ${lastPushError}`)
  } catch (error) {
    return refuse(`could not ${options.verb} ${agent}, so nothing changed: ${errorText(error)}`)
  } finally {
    lock.release()
  }
}

/** Record this machine as the agent's home in its synced agent.json. */
export async function moveAgentHomeHere(options: MoveAgentHomeOptions): Promise<MoveAgentHomeResult> {
  const { agent, machineId, machineName } = options
  const now = options.now ?? (() => new Date())
  const movedMessage = (current: AgentHome | null): string =>
    `${agent} now lives on ${agentHomeLabel({ machineId, machineName })}${current ? ` (moved from ${agentHomeLabel(current)})` : ""}`
  return updateSyncedAgentJson({
    agent,
    bundlesRoot: options.bundlesRoot,
    retryCommand: `ouro move ${agent} here`,
    events: "daemon.agent_home_move",
    meta: { machineId },
    execFileSync: options.execFileSync,
    lockWaitMs: options.lockWaitMs,
    network: options.network,
    stamp: (parsed) => parseAgentHome(parsed.home)?.machineId ?? "",
    noun: "move",
    verb: "move",
    lostRace: (parsed) => {
      const current = parseAgentHome(parsed.home)
      return { field: "home", now: `it now names ${current ? agentHomeLabel(current) : "no machine"}` }
    },
    decide: (parsed) => {
      const current = parseAgentHome(parsed.home)
      if (current?.machineId === machineId) {
        return { kind: "noop", message: `${agent} already lives on this machine (${agentHomeLabel(current)})` }
      }
      const home: AgentHome = { machineId, machineName, since: now().toISOString() }
      if (current) home.previous = { machineId: current.machineId, machineName: current.machineName }
      return { kind: "write", next: { ...parsed, home }, commitMessage: `home: ${agent} moves to ${machineName}`, message: movedMessage(current) }
    },
  })
}

/** Where the upstream (remote) copy of the bundle says the agent lives; undefined when unknown. */
export type ReadUpstreamHome = (agentRoot: string) => Promise<AgentHome | null | undefined>

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExecFile("git", args, { cwd, timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

/**
 * Fetch `<remote>/<sync.branch>` (without touching the working tree) and read
 * the lease in the remote's agent.json, so a machine notices a move away from
 * it even while the agent is idle and never pulls. Fetch only, under the sync
 * lock without waiting: a busy lock or a sync pause skips this check (unknown).
 * It never commits or pushes.
 */
export async function readUpstreamAgentHome(agentRoot: string, git: (cwd: string, args: string[]) => Promise<string> = execGit): Promise<AgentHome | null | undefined> {
  const upstream = await readUpstreamAgentConfig(agentRoot, git)
  return upstream === undefined ? undefined : parseAgentHome(upstream.home)
}

/** The remote's agent.json (fetch only, as for the lease); undefined when unknown. */
export async function readUpstreamAgentConfig(agentRoot: string, git: (cwd: string, args: string[]) => Promise<string> = execGit): Promise<Record<string, unknown> | undefined> {
  try {
    const sync = readSyncSettings(JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8")) as Record<string, unknown>)
    if (!sync.enabled || !fs.existsSync(path.join(agentRoot, ".git"))) return undefined
    if (syncPausedUntil(agentRoot) !== null) return undefined
    const lock = await holdSyncLock(agentRoot, 0)
    if ("busy" in lock) return undefined
    try {
      const fetched = await fetchRemote(agentRoot, sync)
      if (!fetched.ok) return undefined
      return JSON.parse(await git(agentRoot, ["show", `${syncTrackingRef(sync)}:agent.json`])) as Record<string, unknown>
    } finally {
      lock.release()
    }
  } catch {
    return undefined
  }
}

export interface AgentHomeCheck {
  health: DaemonHealthResult
  /** Agents this daemon runs that belong to another machine; stop them here. */
  displaced: string[]
}

/**
 * Compare the agents a running daemon manages with their leases, both on disk
 * and upstream. Running an agent homed elsewhere is a lease conflict: it is
 * reported as critical and listed in `displaced` so the daemon stops it.
 */
export async function checkAgentHomes(options: {
  managedAgents: readonly string[]
  machineId: string
  hostnameAliases?: readonly string[]
  bundlesRoot: string
  readUpstreamHome?: ReadUpstreamHome
  /** The remote's agent.json, for agents that run here by presence. */
  readUpstreamConfig?: (agentRoot: string) => Promise<Record<string, unknown> | undefined>
  presenceEnabled?: boolean
}): Promise<AgentHomeCheck> {
  const rows = listAllBundleAgents({
    bundlesRoot: options.bundlesRoot,
    machineId: options.machineId,
    hostnameAliases: options.hostnameAliases ?? [],
    ...(options.presenceEnabled === undefined ? {} : { presenceEnabled: options.presenceEnabled }),
  })
  const readUpstreamConfig = options.readUpstreamConfig ?? ((agentRoot: string) => readUpstreamAgentConfig(agentRoot))
  const managed = new Set(options.managedAgents)
  const readUpstreamHome = options.readUpstreamHome ?? readUpstreamAgentHome

  const conflicts: Array<{ name: string; where: string }> = []
  const runningUnclaimed: string[] = []
  for (const row of rows) {
    if (!managed.has(row.name)) continue
    if (row.homeState === "elsewhere") {
      conflicts.push({ name: row.name, where: `homed on ${row.homeMachine}` })
      continue
    }
    if (row.homeState === "unclaimed") {
      conflicts.push({ name: row.name, where: "not homed here, and this machine runs only its own agents" })
      continue
    }
    if (row.homeState === "fallback") runningUnclaimed.push(row.name)
  }
  for (const name of options.managedAgents) {
    if (conflicts.some((conflict) => conflict.name === name)) continue
    const row = rows.find((candidate) => candidate.name === name)
    if (!row || (row.homeState !== "here" && row.homeState !== "fallback")) continue
    if (row.presence) {
      // Present by roster: a conflict only when the remote's roster dropped this machine.
      const upstreamConfig = await readUpstreamConfig(path.join(options.bundlesRoot, `${name}.ouro`))
      if (upstreamConfig === undefined) continue
      const roster = parsePresenceBlock(upstreamConfig.presence)
      if (roster?.machines.some((machine) => machine.machineId === options.machineId)) continue
      const upstreamHome = parseAgentHome(upstreamConfig.home)
      if (upstreamHome && upstreamHome.machineId !== options.machineId) {
        conflicts.push({ name, where: `left the presence roster and moved to ${agentHomeLabel(upstreamHome)} upstream` })
      }
      continue
    }
    const upstream = await readUpstreamHome(path.join(options.bundlesRoot, `${name}.ouro`))
    if (upstream && upstream.machineId !== options.machineId) {
      conflicts.push({ name, where: `moved to ${agentHomeLabel(upstream)} upstream` })
    }
  }
  const waiting = rows.filter((row) => !managed.has(row.name) && row.homeState === "here" && !row.managementBlockedReason)
  const lookalikes = rows.filter((row) => row.homeNameMatchesThisMachine && row.homeState === "elsewhere")

  const parts: string[] = []
  if (conflicts.length > 0) {
    parts.push(`lease conflict: stopped ${conflicts.map((conflict) => `${conflict.name} (${conflict.where})`).join(", ")} on this machine`)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_home_conflict",
      message: "daemon was running an agent homed on another machine; stopping it here",
      meta: { agents: conflicts.map((conflict) => conflict.name), reasons: conflicts.map((conflict) => conflict.where) },
    })
  }
  if (waiting.length > 0) {
    parts.push(`homed here but not running: ${waiting.map((row) => row.name).join(", ")}; run \`ouro up\` to start`)
  }
  if (runningUnclaimed.length > 0) {
    parts.push(`running without a home, so another machine may run ${runningUnclaimed.length === 1 ? "it" : "them"} too: ${runningUnclaimed.join(", ")}; claim with \`ouro move <agent> here\``)
  }
  for (const row of lookalikes) {
    parts.push(`${row.name} is homed on ${row.homeMachine}, which has this machine's name but a different id; if this machine's identity was replaced, run \`ouro move ${row.name} here\``)
  }
  const displaced = conflicts.map((conflict) => conflict.name)
  if (parts.length === 0) {
    return { health: { name: "agent-home", status: "ok", message: "every running agent is homed here" }, displaced }
  }
  return { health: { name: "agent-home", status: conflicts.length > 0 ? "critical" : "warn", message: parts.join("; ") }, displaced }
}
