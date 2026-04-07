import * as fs from "fs"
import * as path from "path"
import { execFileSync as nodeExecFileSync } from "child_process"
import { getAgentBundlesRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

type Readdir = (target: string, options: { withFileTypes: true }) => fs.Dirent[]
type ReadText = (target: string, encoding: "utf-8") => string
type GitExec = (command: string, args: string[], options: { cwd: string; stdio: "pipe"; timeout: number }) => Buffer
type ExistsSync = (target: string) => boolean

export interface AgentDiscoveryOptions {
  bundlesRoot?: string
  readdirSync?: Readdir
  readFileSync?: ReadText
  execFileSync?: GitExec
  existsSync?: ExistsSync
}

export function listEnabledBundleAgents(options: AgentDiscoveryOptions = {}): string[] {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const readdirSync = options.readdirSync ?? fs.readdirSync
  const readFileSync = options.readFileSync ?? fs.readFileSync

  let entries: fs.Dirent[]
  try {
    entries = readdirSync(bundlesRoot, { withFileTypes: true })
  } catch {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.agent_discovery_failed",
      message: "failed to read bundle root for daemon agent discovery",
      meta: { bundlesRoot },
    })
    return []
  }

  const discovered: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue
    const agentName = entry.name.slice(0, -5)
    const configPath = path.join(bundlesRoot, entry.name, "agent.json")
    let enabled = true
    try {
      const raw = readFileSync(configPath, "utf-8")
      const parsed = JSON.parse(raw) as { enabled?: unknown }
      if (typeof parsed.enabled === "boolean") {
        enabled = parsed.enabled
      }
    } catch {
      continue
    }
    if (enabled) {
      discovered.push(agentName)
    }
  }

  return discovered.sort((left, right) => left.localeCompare(right))
}

export interface BundleSyncRow {
  agent: string
  enabled: boolean
  remote: string
  /** Resolved URL of the configured remote, when one exists. Undefined when sync is
   * disabled, the bundle isn't a git repo, or the bundle has no git remote
   * configured (local-only mode). */
  remoteUrl?: string
  /** True when the bundle directory contains a .git entry. Only meaningful
   * when `enabled` is true — a bundle with sync disabled doesn't need to be a
   * git repo. When sync is enabled and `gitInitialized` is false, the status
   * renderer shows an actionable "not a git repo" error and the agent sees
   * the same error surfaced as a syncFailure in its start-of-turn packet. */
  gitInitialized?: boolean
}

/**
 * Read the per-agent sync block from each enabled bundle's agent.json.
 * Used by the daemon (and stopped-state status renderer) to build per-agent
 * sync rows without depending on argv-derived global identity. Bundles that
 * cannot be read are skipped silently.
 *
 * For rows with sync enabled, also checks whether the bundle is a git repo
 * (via .git directory presence) and resolves the remote URL via
 * `git remote get-url <remote>`. On any error the URL is left undefined and
 * the status renderer falls back to "local only" or "not a git repo".
 */
export function listBundleSyncRows(options: AgentDiscoveryOptions = {}): BundleSyncRow[] {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const readFileSync = options.readFileSync ?? fs.readFileSync
  const execFileSync = options.execFileSync ?? nodeExecFileSync
  const existsSync = options.existsSync ?? fs.existsSync
  const agents = listEnabledBundleAgents(options)

  const rows: BundleSyncRow[] = []
  for (const agent of agents) {
    const bundleRoot = path.join(bundlesRoot, `${agent}.ouro`)
    const configPath = path.join(bundleRoot, "agent.json")
    let enabled = false
    let remote = "origin"
    try {
      const raw = readFileSync(configPath, "utf-8")
      const parsed = JSON.parse(raw) as { sync?: { enabled?: unknown; remote?: unknown } }
      if (parsed.sync && typeof parsed.sync === "object") {
        if (typeof parsed.sync.enabled === "boolean") enabled = parsed.sync.enabled
        if (typeof parsed.sync.remote === "string" && parsed.sync.remote.length > 0) {
          remote = parsed.sync.remote
        }
      }
    } catch {
      // Best-effort: bundle without readable config still gets a row with defaults
    }

    const row: BundleSyncRow = { agent, enabled, remote }

    if (enabled) {
      // Only meaningful when sync is enabled — we don't care about disabled bundles'
      // git state. Check .git presence before attempting any git invocation.
      const gitInitialized = existsSync(path.join(bundleRoot, ".git"))
      row.gitInitialized = gitInitialized

      if (gitInitialized) {
        try {
          const out = execFileSync("git", ["remote", "get-url", remote], {
            cwd: bundleRoot,
            stdio: "pipe",
            timeout: 5000,
          }).toString().trim()
          if (out.length > 0) row.remoteUrl = out
        } catch {
          // No remote configured or git missing — leave remoteUrl undefined.
        }
      }
    }

    rows.push(row)
  }
  return rows
}
