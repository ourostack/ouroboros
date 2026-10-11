/**
 * Home-machine leases: each agent runs on exactly one machine.
 *
 * The lease lives in the bundle's synced agent.json as `home`, naming the
 * machine (by its stable `~/.ouro-cli/machine.json` id) that runs the agent.
 * Agent discovery reads it (see `AgentHomeState` in agent-discovery.ts); this
 * module writes it (`ouro move <agent> here`) and checks a running daemon
 * against it.
 *
 * A move is published like a compare-and-swap: pull, write, commit only
 * agent.json, push. If the push is rejected, the move is undone locally and
 * retried once from a fresh pull, so two machines cannot both believe they
 * won the same agent.
 */

import * as fs from "fs"
import * as path from "path"
import { execFileSync as nodeExecFileSync } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentBundlesRoot } from "../identity"
import { preTurnPull, type SyncResult } from "../sync"
import { listAllBundleAgents, parseAgentHome, type AgentHome } from "./agent-discovery"
import type { DaemonHealthResult } from "./daemon"

type GitExec = (command: string, args: string[], options: { cwd: string; stdio: "pipe"; timeout: number }) => Buffer | string

export interface MoveAgentHomeOptions {
  agent: string
  machineId: string
  machineName: string
  bundlesRoot?: string
  now?: () => Date
  execFileSync?: GitExec
  pull?: (agentRoot: string, config: { enabled: boolean; remote: string }) => SyncResult
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

/** A readable machine name for a lease: the hostname without `.local`, or the id. */
export function machineDisplayName(hostname: string, machineId: string): string {
  return hostname.trim().replace(/\.local$/, "") || machineId
}

/** Record this machine as the agent's home in its synced agent.json. */
export function moveAgentHomeHere(options: MoveAgentHomeOptions): MoveAgentHomeResult {
  const { agent, machineId, machineName } = options
  const agentRoot = path.join(options.bundlesRoot ?? getAgentBundlesRoot(), `${agent}.ouro`)
  const configPath = path.join(agentRoot, "agent.json")
  const git = options.execFileSync ?? nodeExecFileSync
  const pull = options.pull ?? preTurnPull
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

  let lastPushError = ""
  for (let attempt = 1; attempt <= MOVE_ATTEMPTS; attempt++) {
    let original: string
    let parsed: Record<string, unknown>
    try {
      original = fs.readFileSync(configPath, "utf-8")
      parsed = JSON.parse(original) as Record<string, unknown>
    } catch (error) {
      return finish({ ok: false, changed: false, message: `cannot read ${configPath}: ${errorText(error)}` })
    }

    const sync = readSyncSettings(parsed)
    const gitBacked = sync.enabled && fs.existsSync(path.join(agentRoot, ".git"))
    if (gitBacked) {
      const pulled = pull(agentRoot, sync)
      if (!pulled.ok) {
        return finish({ ok: false, changed: false, message: `could not sync ${agent} before moving it, so nothing changed: ${pulled.error}` })
      }
      original = fs.readFileSync(configPath, "utf-8")
      parsed = JSON.parse(original) as Record<string, unknown>
    }

    const current = parseAgentHome(parsed.home)
    if (current?.machineId === machineId) {
      return finish({ ok: true, changed: false, message: `${agent} already lives on this machine (${machineName})` })
    }
    const home: AgentHome = { machineId, machineName, since: now().toISOString() }
    if (current) home.previous = { machineId: current.machineId, machineName: current.machineName }
    fs.writeFileSync(configPath, `${JSON.stringify({ ...parsed, home }, null, 2)}\n`, "utf-8")

    const from = current ? ` (moved from ${current.machineName})` : ""
    const moved = `${agent} now lives on ${machineName}${from}`
    if (!gitBacked) {
      return finish({ ok: true, changed: true, message: `${moved}; bundle sync is off, so only this machine sees the change` })
    }

    try {
      run(["commit", "-m", `home: ${agent} moves to ${machineName}`, "--", "agent.json"])
    } catch (error) {
      fs.writeFileSync(configPath, original, "utf-8")
      return finish({ ok: false, changed: false, message: `could not commit the move, so nothing changed: ${errorText(error)}` })
    }
    try {
      if (run(["remote"]).length === 0) {
        return finish({ ok: true, changed: true, message: `${moved}; the bundle has no remote, so only this machine sees the change` })
      }
      run(["push", sync.remote])
      return finish({ ok: true, changed: true, message: moved })
    } catch (error) {
      // Undo only our own commit, then retry from a fresh pull. Another
      // machine may have pushed (perhaps its own move) in between.
      lastPushError = errorText(error)
      run(["reset", "--soft", "HEAD~1"])
      run(["reset", "-q", "HEAD", "--", "agent.json"])
      fs.writeFileSync(configPath, original, "utf-8")
    }
  }
  return finish({
    ok: false,
    changed: false,
    message: `could not publish the move, so nothing changed (another machine may have changed ${agent} at the same time): ${lastPushError}`,
  })
}

/**
 * Compare the agents a running daemon manages with the leases on disk now.
 * Leases change under a running daemon when a bundle sync pulls another
 * machine's move. Running an agent homed elsewhere is a lease conflict; it is
 * reported as critical and stops at this machine's next `ouro up`, which
 * replaces a daemon whose managed agents no longer match.
 */
export function checkAgentHomes(options: {
  managedAgents: readonly string[]
  machineId: string
  bundlesRoot?: string
}): DaemonHealthResult {
  const rows = listAllBundleAgents({ bundlesRoot: options.bundlesRoot, machineId: options.machineId })
  const managed = new Set(options.managedAgents)
  const conflicts = rows.filter((row) => managed.has(row.name) && (row.homeState === "elsewhere" || row.homeState === "unclaimed"))
  const waiting = rows.filter((row) => !managed.has(row.name) && row.homeState === "here" && !row.managementBlockedReason)
  const unclaimed = rows.filter((row) => managed.has(row.name) && row.homeState === "fallback")

  const parts: string[] = []
  if (conflicts.length > 0) {
    const named = conflicts.map((row) => row.homeMachine ? `${row.name} (now homed on ${row.homeMachine})` : `${row.name} (not homed here)`)
    parts.push(`lease conflict: running ${named.join(", ")}; run \`ouro up\` here to stop ${conflicts.length === 1 ? "it" : "them"}`)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_home_conflict",
      message: "daemon runs an agent homed on another machine",
      meta: { agents: conflicts.map((row) => row.name), homes: conflicts.map((row) => row.homeMachine ?? null) },
    })
  }
  if (waiting.length > 0) {
    parts.push(`homed here but not running: ${waiting.map((row) => row.name).join(", ")}; run \`ouro up\` to start`)
  }
  if (unclaimed.length > 0) {
    parts.push(`running without a home, so another machine may run ${unclaimed.length === 1 ? "it" : "them"} too: ${unclaimed.map((row) => row.name).join(", ")}; claim with \`ouro move <agent> here\``)
  }
  if (parts.length === 0) {
    return { name: "agent-home", status: "ok", message: "every running agent is homed here" }
  }
  return { name: "agent-home", status: conflicts.length > 0 ? "critical" : "warn", message: parts.join("; ") }
}
