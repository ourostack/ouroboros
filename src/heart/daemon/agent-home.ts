/**
 * Home-machine leases: each agent runs on exactly one machine.
 *
 * The lease lives in the bundle's synced agent.json as `home`, naming the
 * machine (by its stable `~/.ouro-cli/machine.json` id) that runs the agent.
 * Agent discovery reads it (see `AgentHomeState` in agent-discovery.ts); this
 * module writes it (`ouro move <agent> here`) and checks a running daemon
 * against it.
 *
 * A move is a compare-and-swap on the bundle's remote. It starts only from a
 * bundle that is exactly at its upstream (nothing unpushed, agent.json clean),
 * commits only agent.json and pushes. A fast-forward push succeeds only if
 * nobody pushed in between. When the push is rejected, the move is undone; if
 * the upstream lease changed meanwhile, another machine won and the move
 * stops, otherwise it is retried once on the new upstream.
 */

import * as fs from "fs"
import * as path from "path"
import { execFile as nodeExecFile, execFileSync as nodeExecFileSync } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"
import { agentHomeLabel, listAllBundleAgents, parseAgentHome, type AgentHome } from "./agent-discovery"
import type { DaemonHealthResult } from "./daemon"

type GitExec = (command: string, args: string[], options: { cwd: string; stdio: "pipe"; timeout: number }) => Buffer | string

export interface MoveAgentHomeOptions {
  agent: string
  machineId: string
  machineName: string
  bundlesRoot: string
  now?: () => Date
  execFileSync?: GitExec
}

export interface MoveAgentHomeResult {
  ok: boolean
  message: string
  /** True when the bundle actually changed. */
  changed: boolean
}

const MOVE_ATTEMPTS = 2

function readSyncSettings(parsed: Record<string, unknown>): { enabled: boolean; remote: string } {
  const sync = parsed.sync as { enabled?: unknown; remote?: unknown } | undefined
  return {
    enabled: sync?.enabled === true,
    remote: typeof sync?.remote === "string" && sync.remote.trim() ? sync.remote : "origin",
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameHome(left: AgentHome | null, right: AgentHome | null): boolean {
  return (left?.machineId ?? null) === (right?.machineId ?? null)
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

/** Record this machine as the agent's home in its synced agent.json. */
export function moveAgentHomeHere(options: MoveAgentHomeOptions): MoveAgentHomeResult {
  const { agent, machineId, machineName } = options
  const agentRoot = path.join(options.bundlesRoot, `${agent}.ouro`)
  const configPath = path.join(agentRoot, "agent.json")
  const git = options.execFileSync ?? nodeExecFileSync
  const now = options.now ?? (() => new Date())
  const run = (args: string[]): string => git("git", args, { cwd: agentRoot, stdio: "pipe", timeout: 30_000 }).toString().trim()

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_home_move_start",
    message: "moving agent home to this machine",
    meta: { agent, machineId },
  })
  const finish = (result: MoveAgentHomeResult): MoveAgentHomeResult => {
    emitNervesEvent({
      level: result.ok ? "info" : "warn",
      component: "daemon",
      event: result.ok ? "daemon.agent_home_move_end" : "daemon.agent_home_move_error",
      message: result.message,
      meta: { agent, machineId, changed: result.changed },
    })
    return result
  }
  const refuse = (message: string): MoveAgentHomeResult => finish({ ok: false, changed: false, message })

  const readConfig = (): { text: string; parsed: Record<string, unknown> } => {
    const text = fs.readFileSync(configPath, "utf-8")
    return { text, parsed: JSON.parse(text) as Record<string, unknown> }
  }
  const writeHome = (parsed: Record<string, unknown>, current: AgentHome | null): void => {
    const home: AgentHome = { machineId, machineName, since: now().toISOString() }
    if (current) home.previous = { machineId: current.machineId, machineName: current.machineName }
    fs.writeFileSync(configPath, `${JSON.stringify({ ...parsed, home }, null, 2)}\n`, "utf-8")
  }
  const movedMessage = (current: AgentHome | null): string =>
    `${agent} now lives on ${agentHomeLabel({ machineId, machineName })}${current ? ` (moved from ${agentHomeLabel(current)})` : ""}`

  let config: { text: string; parsed: Record<string, unknown> }
  try {
    config = readConfig()
  } catch (error) {
    return refuse(`cannot read ${configPath}: ${errorText(error)}`)
  }

  const sync = readSyncSettings(config.parsed)
  const hasGit = fs.existsSync(path.join(agentRoot, ".git"))
  if (!sync.enabled || !hasGit) {
    const current = parseAgentHome(config.parsed.home)
    if (current?.machineId === machineId) {
      return finish({ ok: true, changed: false, message: `${agent} already lives on this machine (${agentHomeLabel(current)})` })
    }
    writeHome(config.parsed, current)
    const why = sync.enabled ? "the bundle is not a git repo" : "bundle sync is off"
    return finish({ ok: true, changed: true, message: `${movedMessage(current)}; ${why}, so only this machine sees the change` })
  }

  try {
    if (run(["status", "--porcelain", "--", "agent.json"]).length > 0) {
      return refuse(`${agent}'s agent.json has uncommitted changes, so nothing changed; commit or discard them first (git -C ${agentRoot} diff agent.json)`)
    }
    const hasRemote = run(["remote"]).split("\n").includes(sync.remote)

    let seen: AgentHome | null = null
    let lastPushError = ""
    for (let attempt = 1; attempt <= MOVE_ATTEMPTS; attempt++) {
      if (hasRemote) {
        try {
          run(["fetch", "-q", sync.remote])
        } catch (error) {
          return refuse(`could not reach ${agent}'s bundle remote, so nothing changed: ${errorText(error)}`)
        }
        let unpushed: number
        try {
          unpushed = Number(run(["rev-list", "--count", "@{u}..HEAD"]))
        } catch (error) {
          return refuse(`${agent}'s bundle branch has no upstream to publish the move to, so nothing changed: ${errorText(error)}`)
        }
        if (unpushed > 0) {
          const recorded = recordedPushError(agentRoot)
          const why = recorded ? `the last bundle push failed with: ${recorded}` : `run \`git -C ${agentRoot} push\` to see why they did not publish`
          return refuse(`${agent}'s bundle has ${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}, so nothing changed; fix bundle sync first, because a move must not publish them as a side effect (${why})`)
        }
        try {
          run(["merge", "--ff-only", "-q", "@{u}"])
        } catch (error) {
          return refuse(`could not bring ${agent}'s bundle up to date with its remote, so nothing changed: ${errorText(error)}`)
        }
        config = readConfig()
      }

      const current = parseAgentHome(config.parsed.home)
      if (attempt === 1) {
        seen = current
      } else if (!sameHome(current, seen)) {
        const winner = current ? agentHomeLabel(current) : "no machine"
        return refuse(`another machine changed ${agent}'s home while this move was being published (it now names ${winner}), so this move was undone; run \`ouro move ${agent} here\` again to take it over`)
      }
      if (current?.machineId === machineId) {
        return finish({ ok: true, changed: false, message: `${agent} already lives on this machine (${agentHomeLabel(current)})` })
      }

      writeHome(config.parsed, current)
      try {
        run(["commit", "-q", "-m", `home: ${agent} moves to ${machineName}`, "--", "agent.json"])
      } catch (error) {
        fs.writeFileSync(configPath, config.text, "utf-8")
        return refuse(`could not commit the move, so nothing changed: ${errorText(error)}`)
      }
      if (!hasRemote) {
        return finish({ ok: true, changed: true, message: `${movedMessage(current)}; the bundle has no remote, so only this machine sees the change` })
      }
      try {
        run(["push", "-q", sync.remote])
        return finish({ ok: true, changed: true, message: movedMessage(current) })
      } catch (error) {
        lastPushError = errorText(error)
      }
      // Undo exactly our own commit; the working tree goes back to the
      // pre-move agent.json. If even that fails, say what to run by hand.
      try {
        run(["reset", "-q", "--soft", "HEAD~1"])
        run(["reset", "-q", "HEAD", "--", "agent.json"])
        fs.writeFileSync(configPath, config.text, "utf-8")
      } catch (error) {
        return refuse(`the move could not be pushed (${lastPushError}) and its local commit could not be undone (${errorText(error)}); run \`git -C ${agentRoot} reset --soft HEAD~1\` and restore agent.json`)
      }
    }
    return refuse(`could not push the move, so nothing changed: ${lastPushError}`)
  } catch (error) {
    return refuse(`could not move ${agent}, so nothing changed: ${errorText(error)}`)
  }
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
 * Fetch the bundle's remote (without touching the working tree) and read the
 * lease in the upstream agent.json, so a machine notices a move away from it
 * even while the agent is idle and never pulls.
 */
export async function readUpstreamAgentHome(agentRoot: string, git: (cwd: string, args: string[]) => Promise<string> = execGit): Promise<AgentHome | null | undefined> {
  try {
    const sync = readSyncSettings(JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8")) as Record<string, unknown>)
    if (!sync.enabled || !fs.existsSync(path.join(agentRoot, ".git"))) return undefined
    await git(agentRoot, ["fetch", "-q", sync.remote])
    const upstream = JSON.parse(await git(agentRoot, ["show", "@{u}:agent.json"])) as { home?: unknown }
    return parseAgentHome(upstream.home)
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
}): Promise<AgentHomeCheck> {
  const rows = listAllBundleAgents({
    bundlesRoot: options.bundlesRoot,
    machineId: options.machineId,
    hostnameAliases: options.hostnameAliases ?? [],
  })
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
