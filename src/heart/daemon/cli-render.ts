/**
 * CLI output formatting and rendering helpers.
 *
 * Pure functions that transform data into human-readable CLI output.
 * No side effects — callers handle writing to stdout.
 */

import * as path from "path"
import type { DaemonResponse } from "./daemon"
import { getRuntimeMetadata } from "./runtime-metadata"
import { detectRuntimeMode } from "./runtime-mode"
import { getRepoRoot } from "../identity"
import { readDaemonTombstone } from "./daemon-tombstone"
import { readHealth, getDefaultHealthPath, type DaemonHealthState, type DaemonStatus } from "./daemon-health"
import { listAllBundleAgents, listBundleSyncRows } from "./agent-discovery"
import type { McpListCliCommand, McpCallCliCommand } from "./cli-types"

// ── Status payload types ──

interface StatusOverviewRow {
  daemon: string
  health: string
  socketPath: string
  outlookUrl: string
  version: string
  lastUpdated: string
  repoRoot: string
  configFingerprint: string
  workerCount: number
  senseCount: number
  entryPath: string
  mode: string
}

interface StatusSenseRow {
  agent: string
  sense: string
  label?: string
  enabled: boolean
  status: string
  detail: string
}

interface StatusWorkerRow {
  agent: string
  worker: string
  status: string
  pid: number | null
  restartCount: number
  lastExitCode: number | null
  lastSignal: string | null
  startedAt: string | null
  errorReason: string | null
  fixHint: string | null
}

interface StatusSyncRow {
  agent: string
  enabled: boolean
  remote: string
  remoteUrl?: string
  gitInitialized?: boolean
}

interface StatusAgentRow {
  name: string
  enabled: boolean
}

interface StatusProviderRow {
  agent: string
  lane: string
  provider: string
  model: string
  source: string
  readiness: string
  detail?: string
  credential: string
}

export interface StatusPayload {
  overview: StatusOverviewRow
  senses: StatusSenseRow[]
  workers: StatusWorkerRow[]
  sync: StatusSyncRow[]
  agents: StatusAgentRow[]
  providers: StatusProviderRow[]
}

// ── Field extractors ──

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

// ── Parsers ──

export function parseStatusPayload(data: unknown): StatusPayload | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const raw = data as Record<string, unknown>
  const overview = raw.overview
  const senses = raw.senses
  const workers = raw.workers
  const sync = raw.sync
  const agents = raw.agents
  const providers = raw.providers
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) return null
  if (!Array.isArray(senses) || !Array.isArray(workers)) return null
  // sync, agents, and providers are optional for backward compatibility — older daemons may omit them
  if (sync !== undefined && !Array.isArray(sync)) return null
  if (agents !== undefined && !Array.isArray(agents)) return null
  if (providers !== undefined && !Array.isArray(providers)) return null

  const parsedOverview: StatusOverviewRow = {
    daemon: stringField((overview as Record<string, unknown>).daemon) ?? "unknown",
    health: stringField((overview as Record<string, unknown>).health) ?? "unknown",
    socketPath: stringField((overview as Record<string, unknown>).socketPath) ?? "unknown",
    outlookUrl: stringField((overview as Record<string, unknown>).outlookUrl) ?? "unavailable",
    version: stringField((overview as Record<string, unknown>).version) ?? "unknown",
    lastUpdated: stringField((overview as Record<string, unknown>).lastUpdated) ?? "unknown",
    repoRoot: stringField((overview as Record<string, unknown>).repoRoot) ?? "unknown",
    configFingerprint: stringField((overview as Record<string, unknown>).configFingerprint) ?? "unknown",
    workerCount: numberField((overview as Record<string, unknown>).workerCount) ?? 0,
    senseCount: numberField((overview as Record<string, unknown>).senseCount) ?? 0,
    entryPath: stringField((overview as Record<string, unknown>).entryPath) ?? "unknown",
    mode: stringField((overview as Record<string, unknown>).mode) ?? "unknown",
  }

  const parsedSenses = senses.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    const agent = stringField(row.agent)
    const sense = stringField(row.sense)
    const status = stringField(row.status)
    const detail = stringField(row.detail)
    const enabled = booleanField(row.enabled)
    if (!agent || !sense || !status || detail === null || enabled === null) return null
    return {
      agent,
      sense,
      label: stringField(row.label) ?? undefined,
      enabled,
      status,
      detail,
    } satisfies StatusSenseRow
  })

  const parsedWorkers = workers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    const agent = stringField(row.agent)
    const worker = stringField(row.worker)
    const status = stringField(row.status)
    const restartCount = numberField(row.restartCount)
    const hasPid = Object.prototype.hasOwnProperty.call(row, "pid")
    const pid = row.pid === null ? null : numberField(row.pid)
    const pidInvalid = !hasPid || (row.pid !== null && pid === null)
    if (!agent || !worker || !status || restartCount === null || pidInvalid) return null
    return {
      agent,
      worker,
      status,
      pid,
      restartCount,
      lastExitCode: numberField(row.lastExitCode) ?? null,
      lastSignal: stringField(row.lastSignal) ?? null,
      startedAt: stringField(row.startedAt) ?? null,
      errorReason: stringField(row.errorReason) ?? null,
      fixHint: stringField(row.fixHint) ?? null,
    } satisfies StatusWorkerRow
  })

  const parsedSync = (sync ?? []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    const agent = stringField(row.agent)
    const enabled = booleanField(row.enabled)
    const remote = stringField(row.remote)
    if (!agent || enabled === null || !remote) return null
    const parsed: StatusSyncRow = { agent, enabled, remote }
    const remoteUrl = stringField(row.remoteUrl)
    if (remoteUrl !== null) parsed.remoteUrl = remoteUrl
    const gitInitialized = booleanField(row.gitInitialized)
    if (gitInitialized !== null) parsed.gitInitialized = gitInitialized
    return parsed
  })

  const parsedAgents = (agents ?? []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    const name = stringField(row.name)
    const enabled = booleanField(row.enabled)
    if (!name || enabled === null) return null
    return { name, enabled } satisfies StatusAgentRow
  })

  const parsedProviders = (providers ?? []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    const agent = stringField(row.agent)
    const lane = stringField(row.lane)
    const provider = stringField(row.provider)
    const model = stringField(row.model)
    const source = stringField(row.source)
    const readiness = stringField(row.readiness)
    const credential = stringField(row.credential)
    if (!agent || !lane || !provider || !model || !source || !readiness || !credential) return null
    const parsed: StatusProviderRow = {
      agent,
      lane,
      provider,
      model,
      source,
      readiness,
      credential,
    }
    const detail = stringField(row.detail)
    if (detail !== null) parsed.detail = detail
    return parsed
  })

  if (
    parsedSenses.some((row) => row === null) ||
    parsedWorkers.some((row) => row === null) ||
    parsedSync.some((row) => row === null) ||
    parsedAgents.some((row) => row === null) ||
    parsedProviders.some((row) => row === null)
  ) return null

  return {
    overview: parsedOverview,
    senses: parsedSenses as StatusSenseRow[],
    workers: parsedWorkers as StatusWorkerRow[],
    sync: parsedSync as StatusSyncRow[],
    agents: parsedAgents as StatusAgentRow[],
    providers: parsedProviders as StatusProviderRow[],
  }
}

// ── ANSI color helpers (private) ──

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const TEAL = "\x1b[38;2;78;201;176m"
const GREEN = "\x1b[38;2;46;204;64m"
const RED = "\x1b[38;2;231;76;60m"
const YELLOW = "\x1b[38;2;230;190;50m"

/* v8 ignore start -- cosmetic ANSI wrappers @preserve */
function teal(text: string): string { return `${TEAL}${text}${RESET}` }
function green(text: string): string { return `${GREEN}${text}${RESET}` }
function red(text: string): string { return `${RED}${text}${RESET}` }
function yellow(text: string): string { return `${YELLOW}${text}${RESET}` }
function bold(text: string): string { return `${BOLD}${text}${RESET}` }
function dim(text: string): string { return `${DIM}${text}${RESET}` }
/* v8 ignore stop */

/* v8 ignore start -- cosmetic display: status dot color mapping tested visually @preserve */
function statusDot(status: string): string {
  switch (status) {
    case "running":
    case "ok":
    case "interactive":
    case "enabled":
    case "ready":
      return green("●")
    case "crashed":
    case "warn":
    case "error":
    case "failed":
      return red("●")
    case "needs_config":
    case "not_attached":
    case "stale":
      return yellow("●")
    case "disabled":
    case "stopped":
      return dim("○")
    default:
      return dim("●")
  }
}
/* v8 ignore stop */

// ── Formatters ──

export function humanizeSenseName(sense: string, label?: string): string {
  if (label) return label
  if (sense === "cli") return "CLI"
  if (sense === "bluebubbles") return "BlueBubbles"
  if (sense === "teams") return "Teams"
  return sense
}

/* v8 ignore start -- utility formatter; retained for non-status table output @preserve */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  )
  const renderRow = (row: string[]) => `| ${row.map((cell, index) => (
    index === row.length - 1
      ? cell
      : cell.padEnd(widths[index])
  )).join(" | ")} |`
  const divider = `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`
  return [
    renderRow(headers),
    divider,
    ...rows.map(renderRow),
  ].join("\n")
}
/* v8 ignore stop */

export function formatDaemonStatusOutput(response: DaemonResponse, fallback: string): string {
  const payload = parseStatusPayload(response.data)
  if (!payload) return fallback

  const ov = payload.overview
  const lines: string[] = []

  // ── Header banner ──
  const modeTag = ov.mode === "dev" ? "dev" : ""
  const daemonStatus = ov.daemon === "running" ? green("●") + "  " + bold("running") : red("●") + "  " + bold(ov.daemon)
  const modeStr = modeTag ? `  ${dim(`(${modeTag})`)}` : ""
  const bannerContent = `  ${bold(ov.version)}  ${daemonStatus}${modeStr}  `
  // Measure raw content width (strip ANSI for width calc)
  const rawBanner = bannerContent.replace(/\x1b\[[0-9;]*m/g, "")
  const bannerWidth = Math.max(rawBanner.length, 42)
  const titleLabel = " ouroboros daemon "
  const topRightPad = Math.max(0, bannerWidth - titleLabel.length - 2)
  lines.push(`  ${teal("╭─")}${teal(titleLabel)}${teal("─".repeat(topRightPad))}${teal("╮")}`)
  lines.push(`  ${teal("│")}${bannerContent}${" ".repeat(Math.max(0, bannerWidth - rawBanner.length))}${teal("│")}`)
  lines.push(`  ${teal("╰")}${teal("─".repeat(bannerWidth))}${teal("╯")}`)
  lines.push("")

  // ── Key-value overview ──
  const kvLine = (label: string, value: string) => `  ${teal(label.padEnd(11))} ${value}`
  lines.push(kvLine("Socket", ov.socketPath))
  lines.push(kvLine("Mailbox", ov.outlookUrl))
  lines.push(kvLine("Health", `${statusDot(ov.health)} ${ov.health}`))
  lines.push(kvLine("Updated", ov.lastUpdated))
  lines.push("")

  // ── Agents ──
  // Every discovered bundle, including disabled ones. The Senses/Workers/
  // Git Sync sections below only show enabled bundles, so without this
  // section disabled agents would be invisible in `ouro status`.
  if (payload.agents.length > 0) {
    lines.push(`  ${teal("──")} ${bold("Agents")} ${teal("─".repeat(37))}`)
    const agentNameWidth = Math.max(12, ...payload.agents.map((r) => r.name.length))
    for (const row of payload.agents) {
      const name = row.name.padEnd(agentNameWidth)
      const dot = row.enabled ? green("●") : dim("○")
      const stateText = row.enabled ? "enabled " : "disabled"
      lines.push(`    ${name} ${dot} ${stateText}`)
    }
    lines.push("")
  }

  // ── Providers ──
  if (payload.providers.length > 0) {
    lines.push(`  ${teal("──")} ${bold("Providers")} ${teal("─".repeat(34))}`)
    const agentLaneWidth = Math.max(16, ...payload.providers.map((r) => `${r.agent} ${r.lane}`.length))
    for (const row of payload.providers) {
      const agentLane = `${row.agent} ${row.lane}`.padEnd(agentLaneWidth)
      const model = `${row.provider} / ${row.model}`
      const detail = [row.readiness, row.detail, row.source, row.credential].filter(Boolean).join("; ")
      lines.push(`    ${agentLane} ${statusDot(row.readiness)} ${model}  ${dim(detail)}`)
    }
    lines.push("")
  }

  // ── Senses ──
  if (payload.senses.length > 0) {
    lines.push(`  ${teal("──")} ${bold("Senses")} ${teal("─".repeat(37))}`)
    // Group senses by agent
    const sensesByAgent = new Map<string, StatusSenseRow[]>()
    for (const row of payload.senses) {
      const list = sensesByAgent.get(row.agent) ?? []
      list.push(row)
      sensesByAgent.set(row.agent, list)
    }
    // Calculate column widths for alignment
    const allSenseNames = payload.senses.map((r) => humanizeSenseName(r.sense, r.label))
    const nameWidth = Math.max(12, ...allSenseNames.map((n) => n.length))
    const allStatuses = payload.senses.map((r) => r.status)
    const statusWidth = Math.max(10, ...allStatuses.map((s) => s.length))

    for (const [agent, rows] of sensesByAgent) {
      lines.push(`  ${bold(agent)}`)
      for (const row of rows) {
        const name = humanizeSenseName(row.sense, row.label).padEnd(nameWidth)
        const dot = row.enabled ? statusDot(row.status) : dim("○")
        const statusText = (row.enabled ? row.status : "disabled").padEnd(statusWidth)
        lines.push(`    ${name} ${dot} ${statusText}  ${dim(row.detail)}`)
      }
    }
    lines.push("")
  }

  // ── Workers ──
  if (payload.workers.length > 0) {
    lines.push(`  ${teal("──")} ${bold("Workers")} ${teal("─".repeat(36))}`)
    // Group workers by agent
    const workersByAgent = new Map<string, StatusWorkerRow[]>()
    for (const row of payload.workers) {
      const list = workersByAgent.get(row.agent) ?? []
      list.push(row)
      workersByAgent.set(row.agent, list)
    }
    const allWorkerNames = payload.workers.map((r) => r.worker)
    const workerNameWidth = Math.max(12, ...allWorkerNames.map((n) => n.length))

    for (const [agent, rows] of workersByAgent) {
      lines.push(`  ${bold(agent)}`)
      for (const row of rows) {
        const name = row.worker.padEnd(workerNameWidth)
        const dot = statusDot(row.status)
        const pidStr = row.pid !== null ? `pid ${row.pid}` : ""
        const restartStr = `restarts: ${row.restartCount}`
        /* v8 ignore start — exit info branches tested via daemon-crash-context; v8 misreports conditional chains @preserve */
        let exitStr = ""
        if (row.lastExitCode !== null) exitStr = `exit=${row.lastExitCode}`
        if (row.lastSignal !== null) exitStr = row.lastExitCode !== null ? `exit=${row.lastExitCode} sig=${row.lastSignal}` : `sig=${row.lastSignal}`
        /* v8 ignore stop */
        const details = [pidStr, restartStr, exitStr].filter(Boolean).join("  ")
        lines.push(`    ${name} ${dot} ${row.status.padEnd(10)}  ${dim(details)}`)
        if (row.errorReason) {
          lines.push(`      ${dim(`error: ${row.errorReason}`)}`)
        }
        if (row.fixHint) {
          lines.push(`      ${dim(`fix:   ${row.fixHint}`)}`)
        }
      }
    }
    lines.push("")
  }

  // ── Git Sync (per agent) ──
  if (payload.sync.length > 0) {
    lines.push(`  ${teal("──")} ${bold("Git Sync")} ${teal("─".repeat(35))}`)
    const agentNameWidth = Math.max(12, ...payload.sync.map((r) => r.agent.length))
    for (const row of payload.sync) {
      const name = row.agent.padEnd(agentNameWidth)
      // Three states for enabled rows: error (not a repo), ok (remote URL), ok (local only).
      // Disabled rows show the usual dim dot + "disabled".
      let dot: string
      let stateText: string
      let detail: string
      if (!row.enabled) {
        dot = dim("○")
        stateText = "disabled".padEnd(10)
        detail = ""
      } else if (row.gitInitialized === false) {
        dot = red("●")
        stateText = "error   ".padEnd(10)
        detail = "not a git repo — run `git init` to enable sync"
      } else if (row.remoteUrl !== undefined) {
        dot = green("●")
        stateText = "enabled ".padEnd(10)
        detail = `${row.remote} → ${row.remoteUrl}`
      } else {
        dot = green("●")
        stateText = "enabled ".padEnd(10)
        detail = "local only"
      }
      lines.push(`    ${name} ${dot} ${stateText}  ${dim(detail)}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

export function formatVersionOutput(): string {
  const version = getRuntimeMetadata().version
  const mode = detectRuntimeMode(getRepoRoot())
  /* v8 ignore start — cosmetic display toggle; dev mode always true in test env */
  return mode === "dev" ? `${version} (dev)` : version
  /* v8 ignore stop */
}

export function buildStoppedStatusPayload(
  socketPath: string,
  syncRows: StatusSyncRow[] = [],
  agentRows: StatusAgentRow[] = [],
): StatusPayload {
  const metadata = getRuntimeMetadata()
  const repoRoot = getRepoRoot()
  return {
    overview: {
      daemon: "stopped",
      health: "warn",
      socketPath,
      outlookUrl: "unavailable",
      version: metadata.version,
      lastUpdated: metadata.lastUpdated,
      repoRoot: metadata.repoRoot,
      configFingerprint: metadata.configFingerprint,
      workerCount: 0,
      senseCount: 0,
      entryPath: path.join(repoRoot, "dist", "heart", "daemon", "daemon-entry.js"),
      mode: detectRuntimeMode(repoRoot),
    },
    senses: [],
    workers: [],
    sync: syncRows,
    agents: agentRows,
    providers: [],
  }
}

/**
 * Render the cached daemon-rollup status as a one-line string for the
 * "daemon not running" view. Each `DaemonStatus` literal maps to a
 * label + a brief explanatory copy fragment. The default branch is
 * `never`-typed so future widening of `DaemonStatus` compile-errors
 * here — Layer 1's compiler-forced exhaustiveness contract.
 *
 * The `degraded` literal splits into two copy variants based on the
 * cached health file's `agents` map:
 * - empty map → "no agents configured" (fresh-install copy).
 * - non-empty map → "none ready" (all-agents-failed-live-check copy).
 *
 * The split lives at the render layer (not in the rollup status itself)
 * so the same status can carry distinct UX copy without inflating the
 * type union.
 */
export function renderRollupStatusLine(health: DaemonHealthState): string {
  const status: DaemonStatus = health.status
  const tail = `(pid ${health.pid}, uptime ${health.uptimeSeconds}s)`
  /* v8 ignore next -- v8 instruments the switch statement itself as a branch; the never-typed default below is unreachable by construction so v8 cannot observe its branch firing @preserve */
  switch (status) {
    case "healthy":
      return `Last known status: healthy ${tail}`
    case "partial":
      return `Last known status: partial — some agents unhealthy ${tail}`
    case "degraded": {
      // Three-way copy split based on the cached agents map:
      // - empty map → fresh install / no agents configured.
      // - non-empty + any agent reports "running" → legacy stale cache:
      //   pre-Layer-1, status="degraded" meant "any sick component," so a
      //   running agent could coexist with a degraded daemon. Post-Layer-1,
      //   degraded means "zero serving" — mutually exclusive with a running
      //   agent. A live disagreement therefore implies the cache pre-dates
      //   the rollup-semantics fix; prompt for `ouro up` to refresh rather
      //   than falsely claim "none ready."
      // - non-empty + zero agents reporting "running" → all-failed copy.
      const agentEntries = Object.values(health.agents)
      if (agentEntries.length === 0) {
        return `Last known status: degraded — no agents configured (run \`ouro hatch\` to add one) ${tail}`
      }
      const anyRunning = agentEntries.some((agent) => agent.status === "running")
      if (anyRunning) {
        return `Last known status: degraded — stale cache, run \`ouro up\` to refresh ${tail}`
      }
      return `Last known status: degraded — agents configured but none ready (run \`ouro doctor\`) ${tail}`
    }
    case "safe-mode":
      return `Last known status: safe-mode — crash loop tripped ${tail}`
    case "down":
      return `Last known status: down ${tail}`
    /* v8 ignore start -- compiler-forced exhaustiveness: the never-typed default branch is unreachable by construction; if DaemonStatus widens, tsc errors at the assignment before the throw can run @preserve */
    default: {
      // Compiler-forced exhaustiveness. If DaemonStatus grows a new
      // literal, this `never` cast errors at tsc, forcing every
      // consumer to handle it explicitly. NEVER replace this with a
      // permissive `default:` returning a fallback string — that's
      // exactly how the old "ok | degraded" semantics leaked through.
      const _exhaustive: never = status
      throw new Error(`unhandled daemon status: ${_exhaustive as string}`)
    }
    /* v8 ignore stop */
  }
}

export function daemonUnavailableStatusOutput(socketPath: string, healthFilePath?: string): string {
  // Read per-agent sync config and bundle list from disk so the user still
  // sees them when the daemon is down. Best-effort: any fs error returns []
  // and the corresponding section is omitted.
  let syncRows: StatusSyncRow[] = []
  let agentRows: StatusAgentRow[] = []
  try {
    syncRows = listBundleSyncRows()
  } catch {
    // listBundleSyncRows already swallows fs errors internally; this catch is a defensive
    // safety net for environments where the fs module itself is partially mocked.
  }
  try {
    agentRows = listAllBundleAgents()
  } catch {
    // Same defensive safety net for the bundle list.
  }
  /* v8 ignore start — tombstone read tested in daemon-status-tombstone.test; branch misreported @preserve */
  const tombstone = readDaemonTombstone()
  const deathLine = tombstone
    ? `Last death: ${tombstone.timestamp} -- ${tombstone.reason}: ${tombstone.message}`
    : null
  /* v8 ignore stop */

  const lines = [
    formatDaemonStatusOutput({
      ok: true,
      summary: "daemon not running",
      data: buildStoppedStatusPayload(socketPath, syncRows, agentRows),
    }, "daemon not running"),
    "",
  ]

  /* v8 ignore start — tombstone presence requires real daemon crash @preserve */
  if (deathLine) {
    lines.push(deathLine)
    lines.push("")
  /* v8 ignore stop */
  }

  // Read health file for last-known state (best-effort)
  const resolvedHealthPath = healthFilePath ?? getDefaultHealthPath()
  const health = readHealth(resolvedHealthPath)
  if (health) {
    lines.push(renderRollupStatusLine(health))

    if (health.safeMode?.active) {
      lines.push(`SAFE MODE: ${health.safeMode.reason}`)
    }

    if (health.degraded.length > 0) {
      lines.push("")
      lines.push("Degraded:")
      for (const d of health.degraded) {
        lines.push(`  ${d.component}: ${d.reason} (since ${d.since})`)
      }
    }

    lines.push("")
  }

  lines.push("daemon not running; run `ouro up`")

  return lines.join("\n")
}

export function isDaemonUnavailableError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
  return code === "ENOENT" || code === "ECONNREFUSED"
}

export function formatMcpResponse(command: McpListCliCommand | McpCallCliCommand, response: DaemonResponse): string {
  if (command.kind === "mcp.list") {
    const allTools = response.data as Array<{ server: string; tools: Array<{ name: string; description: string }> }> | undefined
    if (!allTools || allTools.length === 0) {
      return response.message ?? "no tools available from connected MCP servers"
    }
    const lines: string[] = []
    for (const entry of allTools) {
      lines.push(`[${entry.server}]`)
      for (const tool of entry.tools) {
        lines.push(`  ${tool.name}: ${tool.description}`)
      }
    }
    return lines.join("\n")
  }
  // mcp.call
  const result = response.data as { content: Array<{ type: string; text: string }> } | undefined
  if (!result) {
    return response.message ?? "no result"
  }
  return result.content.map((c) => c.text).join("\n")
}
