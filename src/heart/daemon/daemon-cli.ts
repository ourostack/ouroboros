import { execSync, spawn } from "child_process"
import { randomUUID } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as semver from "semver"
import { getAgentBundlesRoot, getAgentDaemonLogsDir, getAgentName, getAgentRoot, getRepoRoot, HARNESS_CANONICAL_REPO_URL, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { FileFriendStore } from "../../mind/friends/store-file"
import type { FriendStore } from "../../mind/friends/store"
import { isIdentityProvider, type IdentityProvider, type TrustLevel } from "../../mind/friends/types"
import type { Facing } from "../../mind/friends/channel"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import { registerOuroBundleUti as defaultRegisterOuroBundleUti } from "./ouro-uti"
import { installOuroCommand as defaultInstallOuroCommand, type OuroPathInstallResult } from "./ouro-path-installer"
import { getCurrentVersion, getPreviousVersion, listInstalledVersions, installVersion, activateVersion, ensureLayout, getOuroCliHome, buildChangelogCommand } from "./ouro-version-manager"
import { ensureSkillManagement as defaultEnsureSkillManagement } from "./skill-management-installer"
import {
  runHatchFlow as defaultRunHatchFlow,
  type HatchCredentialsInput,
  type HatchFlowInput,
  type HatchFlowResult,
} from "./hatch-flow"
import {
  listExistingBundles,
  loadSoulText,
  pickRandomIdentity,
} from "./specialist-orchestrator"
import { buildSpecialistSystemPrompt } from "./specialist-prompt"
import { getSpecialistTools, createSpecialistExecTool } from "./specialist-tools"
import { getRuntimeMetadata } from "./runtime-metadata"
import { detectRuntimeMode } from "./runtime-mode"
import { ensureCurrentDaemonRuntime } from "./daemon-runtime-sync"
import { listEnabledBundleAgents } from "./agent-discovery"
import { applyPendingUpdates, registerUpdateHook } from "./update-hooks"
import { bundleMetaHook } from "./hooks/bundle-meta"
import { agentConfigV2Hook } from "./hooks/agent-config-v2"
import { getChangelogPath, getPackageVersion } from "../../mind/bundle-manifest"
import { getTaskModule } from "../../repertoire/tasks"
import { parseInnerDialogSession, formatThoughtTurns, getInnerDialogSessionPath, followThoughts } from "./thoughts"
import type { TaskModule } from "../../repertoire/tasks/types"
import { syncGlobalOuroBotWrapper as defaultSyncGlobalOuroBotWrapper } from "./ouro-bot-global-installer"
import { installLaunchAgent, uninstallLaunchAgent, isDaemonInstalled, type LaunchdDeps } from "./launchd"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand, checkDaemonSocketAlive } from "./socket-client"
import { readDaemonTombstone } from "./daemon-tombstone"
import { readHealth, getDefaultHealthPath } from "./daemon-health"
import type { CheckForUpdateResult } from "./update-checker"
import { listSessionActivity } from "../session-activity"
import {
  loadAgentSecrets,
  resolveHatchCredentials,
  readAgentConfigForAgent,
  runRuntimeAuthFlow as defaultRunRuntimeAuthFlow,
  writeAgentProviderSelection,
  writeAgentModel,
  type RuntimeAuthInput,
  type RuntimeAuthResult,
} from "./auth-flow"

export type OuroCliCommand =
  | { kind: "daemon.up" }
  | { kind: "daemon.stop" }
  | { kind: "daemon.status" }
  | { kind: "daemon.logs" }
  | { kind: "outlook"; json?: boolean }
  | { kind: "auth.run"; agent: string; provider?: AgentProvider }
  | { kind: "auth.verify"; agent: string; provider?: AgentProvider }
  | { kind: "auth.switch"; agent: string; provider: AgentProvider; facing?: Facing }
  | { kind: "chat.connect"; agent: string }
  | { kind: "message.send"; from: string; to: string; content: string; sessionId?: string; taskRef?: string }
  | { kind: "task.poke"; agent: string; taskId: string }
  | { kind: "task.board"; status?: string; agent?: string }
  | { kind: "task.create"; title: string; type?: string; agent?: string }
  | { kind: "task.update"; id: string; status: string; agent?: string }
  | { kind: "task.show"; id: string; agent?: string }
  | { kind: "task.actionable"; agent?: string }
  | { kind: "task.deps"; agent?: string }
  | { kind: "task.sessions"; agent?: string }
  | { kind: "task.fix"; mode: "dry-run" | "safe" | "single"; issueId?: string; option?: number; agent?: string }
  | { kind: "whoami"; agent?: string }
  | { kind: "session.list"; agent?: string }
  | { kind: "thoughts"; agent?: string; last?: number; json?: boolean; follow?: boolean }
  | { kind: "reminder.create"; title: string; body: string; scheduledAt?: string; cadence?: string; category?: string; requester?: string; agent?: string }
  | { kind: "friend.list"; agent?: string }
  | { kind: "friend.show"; friendId: string; agent?: string }
  | { kind: "friend.create"; name: string; trustLevel?: string; agent?: string }
  | { kind: "friend.update"; friendId: string; trustLevel: TrustLevel; agent?: string }
  | { kind: "friend.link"; agent: string; friendId: string; provider: IdentityProvider; externalId: string }
  | { kind: "friend.unlink"; agent: string; friendId: string; provider: IdentityProvider; externalId: string }
  | { kind: "changelog"; from?: string; agent?: string }
  | { kind: "mcp.list" }
  | { kind: "mcp.call"; server: string; tool: string; args?: string }
  | { kind: "config.model"; agent: string; modelName: string; facing?: Facing }
  | { kind: "config.models"; agent: string }
  | { kind: "hatch.start"; agentName?: string; humanName?: string; provider?: AgentProvider; credentials?: HatchCredentialsInput; migrationPath?: string }
  | { kind: "rollback"; version?: string }
  | { kind: "versions" }
  | { kind: "daemon.dev"; repoPath?: string; clone?: boolean; clonePath?: string }
  | { kind: "attention.list"; agent?: string }
  | { kind: "attention.show"; id: string; agent?: string }
  | { kind: "attention.history"; agent?: string }
  | { kind: "inner.status"; agent?: string }
  | { kind: "mcp-serve"; agent: string; friendId?: string }
  | { kind: "setup"; tool: "claude-code" | "codex"; agent: string }
  | { kind: "hook"; event: string; agent: string }
  | { kind: "habit.list"; agent?: string }
  | { kind: "habit.create"; agent?: string; name: string; cadence?: string }
  | { kind: "habit.poke"; agent: string; habitName: string }

export interface OuroCliDeps {
  socketPath: string
  sendCommand: (socketPath: string, command: DaemonCommand) => Promise<DaemonResponse>
  startDaemonProcess: (socketPath: string) => Promise<{ pid: number | null }>
  writeStdout: (text: string) => void
  checkSocketAlive: (socketPath: string) => Promise<boolean>
  cleanupStaleSocket: (socketPath: string) => void
  fallbackPendingMessage: (command: Extract<DaemonCommand, { kind: "message.send" }>) => string
  listDiscoveredAgents?: () => Promise<string[]> | string[]
  runHatchFlow?: (input: HatchFlowInput) => Promise<HatchFlowResult>
  runAdoptionSpecialist?: () => Promise<string | null>
  runAuthFlow?: (input: RuntimeAuthInput) => Promise<RuntimeAuthResult>
  promptInput?: (question: string) => Promise<string>
  registerOuroBundleType?: () => Promise<unknown> | unknown
  installOuroCommand?: () => OuroPathInstallResult
  ensureCurrentVersionInstalled?: () => void
  syncGlobalOuroBotWrapper?: () => Promise<unknown> | unknown
  ensureSkillManagement?: () => Promise<void>
  ensureDaemonBootPersistence?: (socketPath: string) => Promise<void> | void
  startChat?: (agentName: string) => Promise<void>
  tailLogs?: (options?: { follow?: boolean; lines?: number; agentFilter?: string }) => () => void
  taskModule?: TaskModule
  friendStore?: FriendStore
  whoamiInfo?: () => { agentName: string; homePath: string; bonesVersion: string }
  scanSessions?: () => Promise<SessionEntry[]>
  getChangelogPath?: () => string
  fetchImpl?: typeof fetch
  checkForCliUpdate?: () => Promise<CheckForUpdateResult>
  installCliVersion?: (version: string) => Promise<void>
  activateCliVersion?: (version: string) => void
  getCurrentCliVersion?: () => string | null
  reExecFromNewVersion?: (args: string[]) => never
  getPreviousCliVersion?: () => string | null
  listCliVersions?: () => string[]
  existsSync?: (p: string) => boolean
  getRepoCwd?: () => string
  detectMode?: () => "dev" | "production"
  getInstalledBinaryPath?: () => string | null
  execInstalledBinary?: (binaryPath: string, args: string[]) => never
  agentBundleRoot?: string
  healthFilePath?: string
}

export interface SessionEntry {
  friendId: string
  friendName: string
  channel: string
  lastActivity: string
}

export interface EnsureDaemonResult {
  alreadyRunning: boolean
  message: string
}

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
}

interface StatusPayload {
  overview: StatusOverviewRow
  senses: StatusSenseRow[]
  workers: StatusWorkerRow[]
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function parseStatusPayload(data: unknown): StatusPayload | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const raw = data as Record<string, unknown>
  const overview = raw.overview
  const senses = raw.senses
  const workers = raw.workers
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) return null
  if (!Array.isArray(senses) || !Array.isArray(workers)) return null

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
    } satisfies StatusWorkerRow
  })

  if (parsedSenses.some((row) => row === null) || parsedWorkers.some((row) => row === null)) return null

  return {
    overview: parsedOverview,
    senses: parsedSenses as StatusSenseRow[],
    workers: parsedWorkers as StatusWorkerRow[],
  }
}

function humanizeSenseName(sense: string, label?: string): string {
  if (label) return label
  if (sense === "cli") return "CLI"
  if (sense === "bluebubbles") return "BlueBubbles"
  if (sense === "teams") return "Teams"
  return sense
}

function formatTable(headers: string[], rows: string[][]): string {
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

function formatDaemonStatusOutput(response: DaemonResponse, fallback: string): string {
  const payload = parseStatusPayload(response.data)
  if (!payload) return fallback

  const overviewRows = [
    ["Daemon", payload.overview.daemon],
    ["Socket", payload.overview.socketPath],
    ["Version", payload.overview.version],
    ["Last Updated", payload.overview.lastUpdated],
    ["Outlook", payload.overview.outlookUrl],
    ["Entry Path", payload.overview.entryPath],
    ["Mode", payload.overview.mode],
    ["Workers", String(payload.overview.workerCount)],
    ["Senses", String(payload.overview.senseCount)],
    ["Health", payload.overview.health],
  ]
  const senseRows = payload.senses.map((row) => [
    row.agent,
    humanizeSenseName(row.sense, row.label),
    row.enabled ? "ON" : "OFF",
    row.status,
    row.detail,
  ])
  const workerRows = payload.workers.map((row) => {
    /* v8 ignore start — exit info branches tested via daemon-crash-context; v8 misreports conditional chains @preserve */
    let exitInfo = "n/a"
    if (row.lastExitCode !== null) exitInfo = `code=${row.lastExitCode}`
    if (row.lastSignal !== null) exitInfo = row.lastExitCode !== null ? `code=${row.lastExitCode} sig=${row.lastSignal}` : `sig=${row.lastSignal}`
    /* v8 ignore stop */
    return [
      row.agent,
      row.worker,
      row.status,
      row.pid === null ? "n/a" : String(row.pid),
      String(row.restartCount),
      exitInfo,
    ]
  })

  return [
    "Overview",
    formatTable(["Item", "Value"], overviewRows),
    "",
    "Senses",
    formatTable(["Agent", "Sense", "Enabled", "State", "Detail"], senseRows),
    "",
    "Workers",
    formatTable(["Agent", "Worker", "State", "PID", "Restarts", "Last Exit"], workerRows),
  ].join("\n")
}

export async function ensureDaemonRunning(deps: OuroCliDeps): Promise<EnsureDaemonResult> {
  const alive = await deps.checkSocketAlive(deps.socketPath)
  if (alive) {
    const localRuntime = getRuntimeMetadata()
    let runningRuntimePromise: Promise<{
      version: string
      lastUpdated: string
      repoRoot: string
      configFingerprint: string
    }> | null = null
    const fetchRunningRuntimeMetadata = async () => {
      runningRuntimePromise ??= (async () => {
        const status = await deps.sendCommand(deps.socketPath, { kind: "daemon.status" })
        const payload = parseStatusPayload(status.data)
        return {
          version: payload?.overview.version ?? "unknown",
          lastUpdated: payload?.overview.lastUpdated ?? "unknown",
          repoRoot: payload?.overview.repoRoot ?? "unknown",
          configFingerprint: payload?.overview.configFingerprint ?? "unknown",
        }
      })()
      return runningRuntimePromise
    }

    return ensureCurrentDaemonRuntime({
      socketPath: deps.socketPath,
      localVersion: localRuntime.version,
      localLastUpdated: localRuntime.lastUpdated,
      localRepoRoot: localRuntime.repoRoot,
      localConfigFingerprint: localRuntime.configFingerprint,
      fetchRunningVersion: async () => (await fetchRunningRuntimeMetadata()).version,
      fetchRunningRuntimeMetadata,
      stopDaemon: async () => {
        await deps.sendCommand(deps.socketPath, { kind: "daemon.stop" })
      },
      cleanupStaleSocket: deps.cleanupStaleSocket,
      startDaemonProcess: deps.startDaemonProcess,
    })
  }

  deps.cleanupStaleSocket(deps.socketPath)
  const started = await deps.startDaemonProcess(deps.socketPath)
  return {
    alreadyRunning: false,
    message: `daemon started (pid ${started.pid ?? "unknown"})`,
  }
}

/**
 * Extract `--agent <name>` from an args array, returning the agent name and
 * the remaining args with the flag pair removed.
 */
function extractAgentFlag(args: string[]): { agent?: string; rest: string[] } {
  const idx = args.indexOf("--agent")
  if (idx === -1 || idx + 1 >= args.length) return { rest: args }
  const agent = args[idx + 1]
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)]
  return { agent, rest }
}

function usage(): string {
  return [
    "Usage:",
    "  ouro [up]",
    "  ouro dev [--repo-path <path>] [--clone [--clone-path <path>]]",
    "  ouro stop|down|status|logs|hatch",
    "  ouro outlook [--json]",
    "  ouro -v|--version",
    "  ouro config model --agent <name> <model-name>",
    "  ouro config models --agent <name>",
    "  ouro auth --agent <name> [--provider <provider>]",
    "  ouro auth verify --agent <name> [--provider <provider>]",
    "  ouro auth switch --agent <name> --provider <provider>",
    "  ouro chat <agent>",
    "  ouro msg --to <agent> [--session <id>] [--task <ref>] <message>",
    "  ouro poke <agent> --task <task-id>",
    "  ouro poke <agent> --habit <name>",
    "  ouro habit list [--agent <name>]",
    "  ouro habit create [--agent <name>] <name> [--cadence <interval>]",
    "  ouro link <agent> --friend <id> --provider <provider> --external-id <external-id>",
    "  ouro task board [<status>] [--agent <name>]",
    "  ouro task create <title> [--type <type>] [--agent <name>]",
    "  ouro task update <id> <status> [--agent <name>]",
    "  ouro task show <id> [--agent <name>]",
    "  ouro task fix [--safe|--all] [<id> [--option <N>]] [--agent <name>]",
    "  ouro task actionable|deps|sessions [--agent <name>]",
    "  ouro reminder create <title> --body <body> [--at <iso>] [--cadence <interval>] [--category <category>] [--agent <name>]",
    "  ouro friend list [--agent <name>]",
    "  ouro friend show <id> [--agent <name>]",
    "  ouro friend create --name <name> [--trust <level>] [--agent <name>]",
    "  ouro friend update <id> --trust <level> [--agent <name>]",
    "  ouro thoughts [--last <n>] [--json] [--follow] [--agent <name>]",
    "  ouro inner [--agent <name>]",
    "  ouro friend link <agent> --friend <id> --provider <p> --external-id <eid>",
    "  ouro friend unlink <agent> --friend <id> --provider <p> --external-id <eid>",
    "  ouro whoami [--agent <name>]",
    "  ouro session list [--agent <name>]",
    "  ouro mcp list",
    "  ouro mcp call <server> <tool> [--args '{...}']",
    "  ouro rollback [<version>]",
    "  ouro versions",
  ].join("\n")
}

function formatVersionOutput(): string {
  const version = getRuntimeMetadata().version
  const mode = detectRuntimeMode(getRepoRoot())
  /* v8 ignore start — cosmetic display toggle; dev mode always true in test env */
  return mode === "dev" ? `${version} (dev)` : version
  /* v8 ignore stop */
}

function buildStoppedStatusPayload(socketPath: string): StatusPayload {
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
  }
}

function daemonUnavailableStatusOutput(socketPath: string, healthFilePath?: string): string {
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
      data: buildStoppedStatusPayload(socketPath),
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
    lines.push(`Last known status: ${health.status} (pid ${health.pid}, uptime ${health.uptimeSeconds}s)`)

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

function isDaemonUnavailableError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
  return code === "ENOENT" || code === "ECONNREFUSED"
}

function parseMessageCommand(args: string[]): OuroCliCommand {
  let to: string | undefined
  let sessionId: string | undefined
  let taskRef: string | undefined
  const messageParts: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === "--to") {
      to = args[i + 1]
      i += 1
      continue
    }
    if (token === "--session") {
      sessionId = args[i + 1]
      i += 1
      continue
    }
    if (token === "--task") {
      taskRef = args[i + 1]
      i += 1
      continue
    }
    messageParts.push(token)
  }

  const content = messageParts.join(" ").trim()
  if (!to || !content) throw new Error(`Usage\n${usage()}`)

  return {
    kind: "message.send",
    from: "ouro-cli",
    to,
    content,
    sessionId,
    taskRef,
  }
}

function parsePokeCommand(args: string[]): OuroCliCommand {
  const agent = args[0]
  if (!agent) throw new Error(`Usage\n${usage()}`)

  let taskId: string | undefined
  let habitName: string | undefined
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--task") {
      taskId = args[i + 1]
      i += 1
    }
    if (args[i] === "--habit") {
      habitName = args[i + 1]
      i += 1
    }
  }

  // --habit takes priority over --task
  if (habitName) return { kind: "habit.poke", agent, habitName }
  if (!taskId) throw new Error(`Usage\n${usage()}`)
  return { kind: "task.poke", agent, taskId }
}

function parseHabitCommand(args: string[]): OuroCliCommand {
  const { agent, rest } = extractAgentFlag(args)

  const sub = rest[0]
  if (sub === "list") {
    return { kind: "habit.list", ...(agent ? { agent } : {}) }
  }
  if (sub === "create") {
    const nameArgs = rest.slice(1)
    let name: string | undefined
    let cadence: string | undefined
    const positional: string[] = []
    for (let i = 0; i < nameArgs.length; i++) {
      if (nameArgs[i] === "--cadence" && nameArgs[i + 1]) {
        cadence = nameArgs[++i]
        continue
      }
      /* v8 ignore start -- defensive: --agent already extracted by extractAgentFlag; guard prevents regression if parsing flow changes @preserve */
      if (nameArgs[i] === "--agent" && nameArgs[i + 1]) {
        i++ // skip --agent value (already extracted)
        continue
      }
      /* v8 ignore stop */
      positional.push(nameArgs[i])
    }
    name = positional[0]
    if (!name) throw new Error(`Usage\n${usage()}`)
    return { kind: "habit.create", name, ...(agent ? { agent } : {}), ...(cadence ? { cadence } : {}) }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseLinkCommand(args: string[], kind: "friend.link" | "friend.unlink" = "friend.link"): OuroCliCommand {
  const agent = args[0]
  if (!agent) throw new Error(`Usage\n${usage()}`)

  let friendId: string | undefined
  let providerRaw: string | undefined
  let externalId: string | undefined
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i]
    if (token === "--friend") {
      friendId = args[i + 1]
      i += 1
      continue
    }
    if (token === "--provider") {
      providerRaw = args[i + 1]
      i += 1
      continue
    }
    if (token === "--external-id") {
      externalId = args[i + 1]
      i += 1
      continue
    }
  }

  if (!friendId || !providerRaw || !externalId) {
    throw new Error(`Usage\n${usage()}`)
  }
  if (!isIdentityProvider(providerRaw)) {
    throw new Error(`Unknown identity provider '${providerRaw}'. Use aad|local|teams-conversation.`)
  }

  return {
    kind,
    agent,
    friendId,
    provider: providerRaw,
    externalId,
  } as OuroCliCommand
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "azure" || value === "anthropic" || value === "minimax" || value === "openai-codex" || value === "github-copilot"
}

/* v8 ignore start -- hasStoredCredentials: per-provider branches tested via auth switch tests @preserve */
function hasStoredCredentials(provider: AgentProvider, providerSecrets: Record<string, unknown>): boolean {
  if (provider === "anthropic") return !!(providerSecrets as { setupToken?: string }).setupToken
  if (provider === "openai-codex") return !!(providerSecrets as { oauthAccessToken?: string }).oauthAccessToken
  if (provider === "github-copilot") return !!(providerSecrets as { githubToken?: string }).githubToken
  if (provider === "minimax") return !!(providerSecrets as { apiKey?: string }).apiKey
  // azure
  return !!(providerSecrets as { endpoint?: string }).endpoint && !!(providerSecrets as { apiKey?: string }).apiKey
}
/* v8 ignore stop */

/* v8 ignore start -- verifyProviderCredentials: delegates to pingProvider @preserve */
async function verifyProviderCredentials(
  provider: string,
  providers: Record<string, Record<string, unknown>>,
): Promise<string> {
  const config = providers[provider]
  if (!config) return "not configured"
  try {
    const { pingProvider } = await import("../../heart/provider-ping")
    const result = await pingProvider(provider as AgentProvider, config as unknown as Parameters<typeof pingProvider>[1])
    return result.ok ? "ok" : `failed (${result.message})`
  } catch (error) {
    return `failed (${error instanceof Error ? error.message : String(error)})`
  }
}
/* v8 ignore stop */

export interface GithubCopilotModel {
  id: string
  name: string
  capabilities?: string[]
}

export async function listGithubCopilotModels(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubCopilotModel[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`model listing failed (HTTP ${response.status})`)
  }
  const body = await response.json() as { data?: unknown[] } | unknown[]
  /* v8 ignore start -- response shape handling: tested via config-models.test.ts @preserve */
  const items = Array.isArray(body) ? body : (body?.data ?? []) as unknown[]
  return items.map((item) => {
    const rec = item as Record<string, unknown>
    const capabilities = Array.isArray(rec.capabilities)
      ? (rec.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined
    return {
      id: String(rec.id ?? rec.name ?? ""),
      name: String(rec.name ?? rec.id ?? ""),
      ...(capabilities ? { capabilities } : {}),
    }
  })
  /* v8 ignore stop */
}

export async function pingGithubCopilotModel(
  baseUrl: string,
  token: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = baseUrl.replace(/\/+$/, "")
  const isClaude = model.startsWith("claude")
  const url = isClaude ? `${base}/chat/completions` : `${base}/responses`
  const body = isClaude
    ? JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 })
    : JSON.stringify({ model, input: "ping", max_output_tokens: 16 })
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })
    if (response.ok) return { ok: true }
    let detail = `HTTP ${response.status}`
    try {
      const json = await response.json() as Record<string, unknown>
      /* v8 ignore start -- error format parsing: all branches tested via config-models.test.ts @preserve */
      if (typeof json.error === "string") detail = json.error
      else if (typeof json.error === "object" && json.error !== null) {
        const errObj = json.error as Record<string, unknown>
        if (typeof errObj.message === "string") detail = errObj.message
      }
      else if (typeof json.message === "string") detail = json.message
      /* v8 ignore stop */
    } catch {
      // response body not JSON — keep HTTP status
    }
    return { ok: false, error: detail }
  } catch (err) {
    /* v8 ignore next -- defensive: fetch errors are always Error instances @preserve */
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function parseHatchCommand(args: string[]): OuroCliCommand {
  let agentName: string | undefined
  let humanName: string | undefined
  let providerRaw: string | undefined
  let migrationPath: string | undefined
  const credentials: HatchCredentialsInput = {}

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === "--agent") {
      agentName = args[i + 1]
      i += 1
      continue
    }
    if (token === "--human") {
      humanName = args[i + 1]
      i += 1
      continue
    }
    if (token === "--provider") {
      providerRaw = args[i + 1]
      i += 1
      continue
    }
    if (token === "--setup-token") {
      credentials.setupToken = args[i + 1]
      i += 1
      continue
    }
    if (token === "--oauth-token") {
      credentials.oauthAccessToken = args[i + 1]
      i += 1
      continue
    }
    if (token === "--api-key") {
      credentials.apiKey = args[i + 1]
      i += 1
      continue
    }
    if (token === "--endpoint") {
      credentials.endpoint = args[i + 1]
      i += 1
      continue
    }
    if (token === "--deployment") {
      credentials.deployment = args[i + 1]
      i += 1
      continue
    }
    if (token === "--migration-path") {
      migrationPath = args[i + 1]
      i += 1
      continue
    }
  }

  if (providerRaw && !isAgentProvider(providerRaw)) {
    throw new Error("Unknown provider. Use azure|anthropic|minimax|openai-codex|github-copilot.")
  }
  const provider = providerRaw && isAgentProvider(providerRaw) ? providerRaw : undefined

  return {
    kind: "hatch.start",
    agentName,
    humanName,
    provider,
    credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
    migrationPath,
  }
}

function parseTaskCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub, ...rest] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "board") {
    const status = rest[0]
    return status
      ? { kind: "task.board", status, ...(agent ? { agent } : {}) }
      : { kind: "task.board", ...(agent ? { agent } : {}) }
  }

  if (sub === "create") {
    const title = rest[0]
    if (!title) throw new Error(`Usage\n${usage()}`)
    let type: string | undefined
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--type" && rest[i + 1]) {
        type = rest[i + 1]
        i += 1
      }
    }
    return type
      ? { kind: "task.create", title, type, ...(agent ? { agent } : {}) }
      : { kind: "task.create", title, ...(agent ? { agent } : {}) }
  }

  if (sub === "update") {
    const id = rest[0]
    const status = rest[1]
    if (!id || !status) throw new Error(`Usage\n${usage()}`)
    return { kind: "task.update", id, status, ...(agent ? { agent } : {}) }
  }

  if (sub === "show") {
    const id = rest[0]
    if (!id) throw new Error(`Usage\n${usage()}`)
    return { kind: "task.show", id, ...(agent ? { agent } : {}) }
  }

  if (sub === "actionable") return { kind: "task.actionable", ...(agent ? { agent } : {}) }
  if (sub === "deps") return { kind: "task.deps", ...(agent ? { agent } : {}) }
  if (sub === "sessions") return { kind: "task.sessions", ...(agent ? { agent } : {}) }

  if (sub === "fix") {
    // fix --safe | fix --all | fix <id> [--option N] | fix (dry-run)
    if (rest.length === 0) return { kind: "task.fix", mode: "dry-run", ...(agent ? { agent } : {}) }

    const first = rest[0]
    if (first === "--safe" || first === "--all") {
      return { kind: "task.fix", mode: "safe", ...(agent ? { agent } : {}) }
    }

    // first arg is an issue ID (contains a colon, e.g. schema-missing-kind:one-shots/foo.md)
    const issueId = first
    let option: number | undefined
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--option" && rest[i + 1]) {
        option = parseInt(rest[i + 1], 10)
        i += 1
      }
    }
    return {
      kind: "task.fix",
      mode: "single",
      issueId,
      ...(option !== undefined ? { option } : {}),
      ...(agent ? { agent } : {}),
    }
  }

  throw new Error(`Usage\n${usage()}`)
}

function extractFacingFlag(args: string[]): { facing?: Facing; rest: string[] } {
  const idx = args.indexOf("--facing")
  if (idx === -1 || idx + 1 >= args.length) return { rest: args }
  const value = args[idx + 1]
  if (value !== "human" && value !== "agent") {
    throw new Error(`--facing must be 'human' or 'agent'`)
  }
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)]
  return { facing: value, rest }
}

function parseAuthCommand(args: string[]): OuroCliCommand {
  const first = args[0]
  // Support both positional (`auth switch`) and flag (`auth --switch`) forms
  if (first === "verify" || first === "switch" || first === "--verify" || first === "--switch") {
    const subcommand = first.replace(/^--/, "")
    const { agent, rest: afterAgent } = extractAgentFlag(args.slice(1))
    const { facing, rest } = extractFacingFlag(afterAgent)
    let provider: AgentProvider | undefined
    /* v8 ignore start -- provider flag parsing: branches tested via CLI parsing tests @preserve */
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--provider") {
        const value = rest[i + 1]
        if (!isAgentProvider(value)) throw new Error(`Usage\n${usage()}`)
        provider = value
        i += 1
        continue
      }
    }
    /* v8 ignore stop */
    /* v8 ignore next -- defensive: agent always provided in tests @preserve */
    if (!agent) throw new Error(`Usage\n${usage()}`)
    if (subcommand === "switch") {
      if (!provider) throw new Error(`auth switch requires --provider.\n${usage()}`)
      return facing ? { kind: "auth.switch", agent, provider, facing } : { kind: "auth.switch", agent, provider }
    }
    return provider ? { kind: "auth.verify", agent, provider } : { kind: "auth.verify", agent }
  }
  const { agent, rest } = extractAgentFlag(args)
  let provider: AgentProvider | undefined
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--provider") {
      const value = rest[i + 1]
      if (!isAgentProvider(value)) throw new Error(`Usage\n${usage()}`)
      provider = value
      i += 1
      continue
    }
  }
  if (!agent) {
    throw new Error([
      "Usage:",
      "  ouro auth --agent <name> [--provider <provider>]     Set up credentials",
      "  ouro auth verify --agent <name> [--provider <p>]     Verify credentials work",
      "  ouro auth switch --agent <name> --provider <p>       Switch active provider",
    ].join("\n"))
  }
  return provider ? { kind: "auth.run", agent, provider } : { kind: "auth.run", agent }
}

function parseReminderCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub, ...rest] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "create") {
    const title = rest[0]
    if (!title) throw new Error(`Usage\n${usage()}`)

    let body: string | undefined
    let scheduledAt: string | undefined
    let cadence: string | undefined
    let category: string | undefined
    let requester: string | undefined

    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--body" && rest[i + 1]) {
        body = rest[i + 1]
        i += 1
      } else if (rest[i] === "--at" && rest[i + 1]) {
        scheduledAt = rest[i + 1]
        i += 1
      } else if (rest[i] === "--cadence" && rest[i + 1]) {
        cadence = rest[i + 1]
        i += 1
      } else if (rest[i] === "--category" && rest[i + 1]) {
        category = rest[i + 1]
        i += 1
      } else if (rest[i] === "--requester" && rest[i + 1]) {
        requester = rest[i + 1]
        i += 1
      }
    }

    if (!body) throw new Error(`Usage\n${usage()}`)
    if (!scheduledAt && !cadence) throw new Error(`Usage\n${usage()}`)

    return {
      kind: "reminder.create" as const,
      title,
      body,
      ...(scheduledAt ? { scheduledAt } : {}),
      ...(cadence ? { cadence } : {}),
      ...(category ? { category } : {}),
      ...(requester ? { requester } : {}),
      ...(agent ? { agent } : {}),
    }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseSessionCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "list") return { kind: "session.list", ...(agent ? { agent } : {}) }

  throw new Error(`Usage\n${usage()}`)
}

function parseAttentionCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const sub = cleaned[0]
  if (sub === "show" && cleaned[1]) {
    return { kind: "attention.show", id: cleaned[1], ...(agent ? { agent } : {}) }
  }
  if (sub === "history") {
    return { kind: "attention.history", ...(agent ? { agent } : {}) }
  }
  return { kind: "attention.list", ...(agent ? { agent } : {}) }
}

function parseThoughtsCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  let last: number | undefined
  let json = false
  let follow = false
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "--last" && i + 1 < cleaned.length) {
      last = Number.parseInt(cleaned[i + 1], 10)
      i++
    }
    if (cleaned[i] === "--json") json = true
    if (cleaned[i] === "--follow" || cleaned[i] === "-f") follow = true
  }
  return { kind: "thoughts", ...(agent ? { agent } : {}), ...(last ? { last } : {}), ...(json ? { json } : {}), ...(follow ? { follow } : {}) }
}

function parseFriendCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub, ...rest] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "list") return { kind: "friend.list", ...(agent ? { agent } : {}) }

  if (sub === "show") {
    const friendId = rest[0]
    if (!friendId) throw new Error(`Usage\n${usage()}`)
    return { kind: "friend.show", friendId, ...(agent ? { agent } : {}) }
  }

  if (sub === "create") {
    let name: string | undefined
    let trustLevel: string | undefined
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--name" && rest[i + 1]) {
        name = rest[i + 1]
        i += 1
      } else if (rest[i] === "--trust" && rest[i + 1]) {
        trustLevel = rest[i + 1]
        i += 1
      }
    }
    if (!name) throw new Error(`Usage\n${usage()}`)
    return {
      kind: "friend.create",
      name,
      ...(trustLevel ? { trustLevel } : {}),
      ...(agent ? { agent } : {}),
    }
  }

  if (sub === "update") {
    const friendId = rest[0]
    if (!friendId) throw new Error(`Usage: ouro friend update <id> --trust <level>`)
    let trustLevel: string | undefined
    /* v8 ignore start -- flag parsing loop: tested via CLI parsing tests @preserve */
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--trust" && rest[i + 1]) {
        trustLevel = rest[i + 1]
        i += 1
      }
    }
    /* v8 ignore stop */
    const VALID_TRUST_LEVELS = new Set(["stranger", "acquaintance", "friend", "family"])
    if (!trustLevel || !VALID_TRUST_LEVELS.has(trustLevel)) {
      throw new Error(`Usage: ouro friend update <id> --trust <stranger|acquaintance|friend|family>`)
    }
    return {
      kind: "friend.update" as const,
      friendId,
      trustLevel: trustLevel as TrustLevel,
      ...(agent ? { agent } : {}),
    }
  }

  if (sub === "link") return parseLinkCommand(rest, "friend.link")
  if (sub === "unlink") return parseLinkCommand(rest, "friend.unlink")

  throw new Error(`Usage\n${usage()}`)
}

function parseConfigCommand(args: string[]): OuroCliCommand {
  const { agent, rest: afterAgent } = extractAgentFlag(args)
  const { facing, rest: cleaned } = extractFacingFlag(afterAgent)
  const [sub, ...rest] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "model") {
    if (!agent) throw new Error("--agent is required for config model")
    const modelName = rest[0]
    if (!modelName) throw new Error(`Usage: ouro config model --agent <name> <model-name>`)
    return facing ? { kind: "config.model", agent, modelName, facing } : { kind: "config.model", agent, modelName }
  }

  if (sub === "models") {
    if (!agent) throw new Error("--agent is required for config models")
    return { kind: "config.models", agent }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseMcpCommand(args: string[]): OuroCliCommand {
  const [sub, ...rest] = args
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "list") return { kind: "mcp.list" }

  if (sub === "call") {
    const server = rest[0]
    const tool = rest[1]
    if (!server || !tool) throw new Error(`Usage\n${usage()}`)

    const argsIdx = rest.indexOf("--args")
    const mcpArgs = argsIdx !== -1 && rest[argsIdx + 1] ? rest[argsIdx + 1] : undefined

    return { kind: "mcp.call", server, tool, ...(mcpArgs ? { args: mcpArgs } : {}) }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseMcpServeCommand(args: string[]): OuroCliCommand & { socketOverride?: string } {
  let agent: string | undefined
  let friendId: string | undefined
  let socketOverride: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) { agent = args[++i]; continue }
    if (args[i] === "--friend" && args[i + 1]) { friendId = args[++i]; continue }
    if (args[i] === "--socket" && args[i + 1]) { socketOverride = args[++i]; continue }
  }
  if (!agent) throw new Error("mcp-serve requires --agent <name>")
  return { kind: "mcp-serve", agent, ...(friendId ? { friendId } : {}), ...(socketOverride ? { socketOverride } : {}) }
}

function parseSetupCommand(args: string[]): OuroCliCommand {
  let tool: string | undefined
  let agent: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tool" && args[i + 1]) { tool = args[++i]; continue }
    if (args[i] === "--agent" && args[i + 1]) { agent = args[++i]; continue }
  }
  if (!tool) throw new Error("setup requires --tool (claude-code | codex)")
  if (tool !== "claude-code" && tool !== "codex") throw new Error(`Unknown tool: ${tool}. Supported: claude-code, codex`)
  if (!agent) throw new Error("setup requires --agent <name>")
  return { kind: "setup", tool, agent }
}

export function parseOuroCommand(args: string[]): OuroCliCommand {
  const [head, second] = args
  if (!head) return { kind: "daemon.up" }

  if (head === "--agent" && second) {
    return parseOuroCommand(args.slice(2))
  }

  if (head === "hook") {
    const hookArgs = args.slice(1)
    let event: string | undefined
    let hookAgent: string | undefined
    for (let i = 0; i < hookArgs.length; i++) {
      if (hookArgs[i] === "--agent" && hookArgs[i + 1]) { hookAgent = hookArgs[++i]; continue }
      /* v8 ignore start -- false branch: extra positional args after event are ignored */
      if (!event) { event = hookArgs[i] }
      /* v8 ignore stop */
    }
    if (!event) throw new Error("hook requires an event name (session-start, stop, post-tool-use)")
    if (!hookAgent) throw new Error("hook requires --agent <name>")
    return { kind: "hook", event, agent: hookAgent }
  }
  if (head === "up") return { kind: "daemon.up" }
  if (head === "dev") {
    const devArgs = args.slice(1)
    let repoPath: string | undefined
    let clone = false
    let clonePath: string | undefined
    for (let i = 0; i < devArgs.length; i++) {
      if (devArgs[i] === "--repo-path" && devArgs[i + 1]) { repoPath = devArgs[++i]; continue }
      if (devArgs[i] === "--clone") { clone = true; continue }
      if (devArgs[i] === "--clone-path" && devArgs[i + 1]) { clonePath = devArgs[++i]; continue }
    }
    return { kind: "daemon.dev", repoPath, clone, clonePath }
  }
  if (head === "rollback") return { kind: "rollback", ...(second ? { version: second } : {}) }
  if (head === "versions") return { kind: "versions" }
  if (head === "stop" || head === "down") return { kind: "daemon.stop" }
  if (head === "status") return { kind: "daemon.status" }
  if (head === "logs") return { kind: "daemon.logs" }
  if (head === "outlook") return { kind: "outlook", ...(args.includes("--json") ? { json: true } : {}) }
  if (head === "hatch") return parseHatchCommand(args.slice(1))
  if (head === "auth") return parseAuthCommand(args.slice(1))
  if (head === "task") return parseTaskCommand(args.slice(1))
  if (head === "reminder") return parseReminderCommand(args.slice(1))
  if (head === "habit") return parseHabitCommand(args.slice(1))
  if (head === "friend") return parseFriendCommand(args.slice(1))
  if (head === "config") return parseConfigCommand(args.slice(1))
  if (head === "mcp") return parseMcpCommand(args.slice(1))
  if (head === "whoami") {
    const { agent } = extractAgentFlag(args.slice(1))
    return { kind: "whoami", ...(agent ? { agent } : {}) }
  }
  if (head === "session") return parseSessionCommand(args.slice(1))
  if (head === "changelog") {
    const sliced = args.slice(1)
    const { agent, rest: remaining } = extractAgentFlag(sliced)
    let from: string | undefined
    const fromIdx = remaining.indexOf("--from")
    if (fromIdx !== -1 && remaining[fromIdx + 1]) {
      from = remaining[fromIdx + 1]
    }
    return { kind: "changelog", ...(from ? { from } : {}), ...(agent ? { agent } : {}) }
  }
  if (head === "thoughts") return parseThoughtsCommand(args.slice(1))
  if (head === "attention") return parseAttentionCommand(args.slice(1))
  if (head === "inner") {
    const { agent } = extractAgentFlag(args.slice(1))
    return { kind: "inner.status", ...(agent ? { agent } : {}) }
  }
  if (head === "chat") {
    if (!second) throw new Error(`Usage\n${usage()}`)
    return { kind: "chat.connect", agent: second }
  }
  if (head === "msg") return parseMessageCommand(args.slice(1))
  if (head === "poke") return parsePokeCommand(args.slice(1))
  if (head === "link") return parseLinkCommand(args.slice(1))
  if (head === "mcp-serve") return parseMcpServeCommand(args.slice(1))
  if (head === "setup") return parseSetupCommand(args.slice(1))

  throw new Error(`Unknown command '${args.join(" ")}'.\n${usage()}`)
}

function defaultStartDaemonProcess(socketPath: string): Promise<{ pid: number | null }> {
  const entry = path.join(getRepoRoot(), "dist", "heart", "daemon", "daemon-entry.js")
  // Redirect stdio to /dev/null via file descriptors — using 'ignore' causes EPIPE
  // when the daemon's logging system writes to stderr after the parent exits.
  const outFd = fs.openSync(os.devNull, "w")
  const errFd = fs.openSync(os.devNull, "w")
  const child = spawn("node", [entry, "--socket", socketPath], {
    detached: true,
    stdio: ["ignore", outFd, errFd],
  })
  child.unref()
  // Don't close fds — the child process needs them. They'll be cleaned up when the parent exits.
  return Promise.resolve({ pid: child.pid ?? null })
}

function defaultWriteStdout(text: string): void {
  // eslint-disable-next-line no-console -- terminal UX: CLI command output
  console.log(text)
}

/**
 * Read the runtimeVersion from the first .ouro bundle's bundle-meta.json.
 * Returns undefined if none found or unreadable.
 */
export function readFirstBundleMetaVersion(bundlesRoot: string): string | undefined {
  try {
    if (!fs.existsSync(bundlesRoot)) return undefined
    const entries = fs.readdirSync(bundlesRoot, { withFileTypes: true })
    for (const entry of entries) {
      /* v8 ignore next -- skip non-.ouro dirs: tested via version-detect tests @preserve */
      if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue
      const metaPath = path.join(bundlesRoot, entry.name, "bundle-meta.json")
      if (!fs.existsSync(metaPath)) continue
      const raw = fs.readFileSync(metaPath, "utf-8")
      const meta = JSON.parse(raw) as { runtimeVersion?: string }
      if (meta.runtimeVersion) return meta.runtimeVersion
    }
  } catch {
    // Best effort — return undefined on any error
  }
  return undefined
}

function defaultCleanupStaleSocket(socketPath: string): void {
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath)
  }
}

function defaultFallbackPendingMessage(command: Extract<DaemonCommand, { kind: "message.send" }>): string {
  const inboxDir = path.join(getAgentBundlesRoot(), `${command.to}.ouro`, "inbox")
  const pendingPath = path.join(inboxDir, "pending.jsonl")
  const queuedAt = new Date().toISOString()
  const payload = {
    from: command.from,
    to: command.to,
    content: command.content,
    priority: command.priority ?? "normal",
    sessionId: command.sessionId,
    taskRef: command.taskRef,
    queuedAt,
  }
  fs.mkdirSync(inboxDir, { recursive: true })
  fs.appendFileSync(pendingPath, `${JSON.stringify(payload)}\n`, "utf-8")
  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.message_fallback_queued",
    message: "queued message to pending fallback file",
    meta: {
      to: command.to,
      path: pendingPath,
      sessionId: command.sessionId ?? null,
      taskRef: command.taskRef ?? null,
    },
  })
  return pendingPath
}

function defaultEnsureDaemonBootPersistence(socketPath: string): void {
  if (process.platform !== "darwin") {
    return
  }

  const homeDir = os.homedir()
  const launchdDeps: LaunchdDeps = {
    exec: (cmd) => { execSync(cmd, { stdio: "ignore" }) },
    writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf-8"),
    removeFile: (filePath) => fs.rmSync(filePath, { force: true }),
    existsFile: (filePath) => fs.existsSync(filePath),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    homeDir,
    userUid: process.getuid?.() ?? 0,
  }

  const entryPath = path.join(getRepoRoot(), "dist", "heart", "daemon", "daemon-entry.js")

  /* v8 ignore next -- covered via mock in daemon-cli-defaults.test.ts; v8 on CI attributes the real fs.existsSync branch to the non-mock load @preserve */
  if (!fs.existsSync(entryPath)) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.entry_path_missing",
      message: "entryPath does not exist on disk — plist may point to a stale location. Run 'ouro daemon install' from the correct location.",
      meta: { entryPath },
    })
  }

  const logDir = getAgentDaemonLogsDir()
  installLaunchAgent(launchdDeps, {
    nodePath: process.execPath,
    entryPath,
    socketPath,
    logDir,
    envPath: process.env.PATH,
  })
}

async function defaultPromptInput(question: string): Promise<string> {
  const readline = await import("readline/promises")
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const response = await rl.question(question)
    return response.trim()
  } finally {
    rl.close()
  }
}

function defaultListDiscoveredAgents(): string[] {
  return listEnabledBundleAgents({
    bundlesRoot: getAgentBundlesRoot(),
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
  })
}



export interface DiscoveredCredential {
  agentName: string
  provider: AgentProvider
  credentials: HatchCredentialsInput
  /** Full provider config block (model, endpoint, etc.) for runtime patching. */
  providerConfig: Record<string, string>
}

export function discoverExistingCredentials(secretsRoot: string): DiscoveredCredential[] {
  const found: DiscoveredCredential[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(secretsRoot, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const secretsPath = path.join(secretsRoot, entry.name, "secrets.json")
    let raw: string
    try {
      raw = fs.readFileSync(secretsPath, "utf-8")
    } catch {
      continue
    }
    let parsed: { providers?: Record<string, Record<string, string>> }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch {
      continue
    }
    if (!parsed.providers) continue

    for (const [provName, provConfig] of Object.entries(parsed.providers)) {
      if (provName === "anthropic" && provConfig.setupToken) {
        found.push({ agentName: entry.name, provider: "anthropic", credentials: { setupToken: provConfig.setupToken }, providerConfig: { ...provConfig } })
      } else if (provName === "openai-codex" && provConfig.oauthAccessToken) {
        found.push({ agentName: entry.name, provider: "openai-codex", credentials: { oauthAccessToken: provConfig.oauthAccessToken }, providerConfig: { ...provConfig } })
      } else if (provName === "minimax" && provConfig.apiKey) {
        found.push({ agentName: entry.name, provider: "minimax", credentials: { apiKey: provConfig.apiKey }, providerConfig: { ...provConfig } })
      } else if (provName === "azure" && provConfig.apiKey && provConfig.endpoint && provConfig.deployment) {
        found.push({ agentName: entry.name, provider: "azure", credentials: { apiKey: provConfig.apiKey, endpoint: provConfig.endpoint, deployment: provConfig.deployment }, providerConfig: { ...provConfig } })
      }
    }
  }

  // Deduplicate by provider+credential value (keep first seen)
  const seen = new Set<string>()
  return found.filter((cred) => {
    const key = `${cred.provider}:${JSON.stringify(cred.credentials)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/* v8 ignore start -- integration: interactive terminal specialist session @preserve */
async function defaultRunAdoptionSpecialist(): Promise<string | null> {
  const { runCliSession } = await import("../../senses/cli")
  const { patchRuntimeConfig } = await import("../config")
  const { setAgentName, setAgentConfigOverride } = await import("../identity")
  const readlinePromises = await import("readline/promises")
  const crypto = await import("crypto")

  // Phase 1: cold CLI — collect provider/credentials with a simple readline
  const coldRl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout })
  const coldPrompt = async (q: string) => {
    const answer = await coldRl.question(q)
    return answer.trim()
  }

  let providerRaw: AgentProvider
  let credentials: HatchCredentialsInput = {}
  let providerConfig: Record<string, string> = {}

  const tempDir = path.join(os.tmpdir(), `ouro-hatch-${crypto.randomUUID()}`)

  try {
    const secretsRoot = path.join(os.homedir(), ".agentsecrets")
    const discovered = discoverExistingCredentials(secretsRoot)
    const existingBundleCount = listExistingBundles(getAgentBundlesRoot()).length
    const hatchVerb = existingBundleCount > 0 ? "let's hatch a new agent." : "let's hatch your first agent."

    // Default models per provider (used when entering new credentials)
    const defaultModels: Record<AgentProvider, string> = {
      anthropic: "claude-opus-4-6",
      minimax: "MiniMax-M2.7",
      "openai-codex": "gpt-5.4",
      "github-copilot": "claude-sonnet-4.6",
      azure: "",
    }

    if (discovered.length > 0) {
      process.stdout.write(`\n\ud83d\udc0d welcome to ouroboros! ${hatchVerb}\n`)
      process.stdout.write("i found existing API credentials:\n\n")
      const unique = [...new Map(discovered.map((d) => [`${d.provider}`, d])).values()]
      for (let i = 0; i < unique.length; i++) {
        const model = unique[i].providerConfig.model || unique[i].providerConfig.deployment || ""
        const modelLabel = model ? `, ${model}` : ""
        process.stdout.write(`  ${i + 1}. ${unique[i].provider}${modelLabel} (from ${unique[i].agentName})\n`)
      }
      process.stdout.write("\n")
      const choice = await coldPrompt("use one of these? enter number, or 'new' for a different key: ")

      const idx = parseInt(choice, 10) - 1
      if (idx >= 0 && idx < unique.length) {
        providerRaw = unique[idx].provider
        credentials = unique[idx].credentials
        providerConfig = unique[idx].providerConfig
      } else {
        const pRaw = await coldPrompt("provider (anthropic/azure/minimax/openai-codex/github-copilot): ")
        if (!isAgentProvider(pRaw)) {
          process.stdout.write("unknown provider. run `ouro hatch` to try again.\n")
          coldRl.close()
          return null
        }
        providerRaw = pRaw
        providerConfig = { model: defaultModels[providerRaw] }
        if (providerRaw === "anthropic") credentials.setupToken = await coldPrompt("API key: ")
        if (providerRaw === "openai-codex") credentials.oauthAccessToken = await coldPrompt("OAuth token: ")
        if (providerRaw === "minimax") credentials.apiKey = await coldPrompt("API key: ")
        if (providerRaw === "azure") {
          credentials.apiKey = await coldPrompt("API key: ")
          credentials.endpoint = await coldPrompt("endpoint: ")
          credentials.deployment = await coldPrompt("deployment: ")
        }
      }
    } else {
      process.stdout.write(`\n\ud83d\udc0d welcome to ouroboros! ${hatchVerb}\n`)
      process.stdout.write("i need an API key to power our conversation.\n\n")
      const pRaw = await coldPrompt("provider (anthropic/azure/minimax/openai-codex/github-copilot): ")
      if (!isAgentProvider(pRaw)) {
        process.stdout.write("unknown provider. run `ouro hatch` to try again.\n")
        coldRl.close()
        return null
      }
      providerRaw = pRaw
      providerConfig = { model: defaultModels[providerRaw] }
      if (providerRaw === "anthropic") credentials.setupToken = await coldPrompt("API key: ")
      if (providerRaw === "openai-codex") credentials.oauthAccessToken = await coldPrompt("OAuth token: ")
      if (providerRaw === "minimax") credentials.apiKey = await coldPrompt("API key: ")
      if (providerRaw === "azure") {
        credentials.apiKey = await coldPrompt("API key: ")
        credentials.endpoint = await coldPrompt("endpoint: ")
        credentials.deployment = await coldPrompt("deployment: ")
      }
    }

    coldRl.close()
    process.stdout.write("\n")

    // Phase 2: configure runtime for adoption specialist
    const bundleSourceDir = path.resolve(__dirname, "..", "..", "..", "AdoptionSpecialist.ouro")
    const bundlesRoot = getAgentBundlesRoot()
    const secretsRoot2 = path.join(os.homedir(), ".agentsecrets")

    // Suppress non-critical log noise during adoption (no secrets.json, etc.)
    const { setRuntimeLogger } = await import("../../nerves/runtime")
    const { createLogger } = await import("../../nerves")
    setRuntimeLogger(createLogger({ level: "error" }))

    // Configure runtime: set agent identity + config override so runAgent
    // doesn't try to read from ~/AgentBundles/AdoptionSpecialist.ouro/
    setAgentName("AdoptionSpecialist")
    // Build specialist system prompt
    const soulText = loadSoulText(bundleSourceDir)
    const identitiesDir = path.join(bundleSourceDir, "psyche", "identities")
    const identity = pickRandomIdentity(identitiesDir)

    // Load identity-specific spinner phrases (falls back to DEFAULT_AGENT_PHRASES)
    const { loadIdentityPhrases } = await import("./specialist-orchestrator")
    const phrases = loadIdentityPhrases(bundleSourceDir, identity.fileName)

    const resolvedModel = providerConfig.model || providerConfig.deployment || ""
    setAgentConfigOverride({
      version: 2,
      enabled: true,
      provider: providerRaw,
      humanFacing: { provider: providerRaw, model: resolvedModel },
      agentFacing: { provider: providerRaw, model: resolvedModel },
      phrases,
    })
    patchRuntimeConfig({
      providers: {
        [providerRaw]: { ...providerConfig, ...credentials },
      },
    })
    const existingBundles = listExistingBundles(bundlesRoot)
    const systemPrompt = buildSpecialistSystemPrompt(soulText, identity.content, existingBundles, {
      tempDir,
      provider: providerRaw,
      model: providerConfig.model ?? "",
    })

    // Build specialist tools
    const specialistTools = getSpecialistTools()
    const specialistExecTool = createSpecialistExecTool({
      tempDir,
      credentials,
      provider: providerRaw,
      bundlesRoot,
      secretsRoot: secretsRoot2,
      animationWriter: (text: string) => process.stdout.write(text),
    })

    // Run the adoption specialist session via runCliSession
    const result = await runCliSession({
      agentName: "AdoptionSpecialist",
      tools: specialistTools,
      execTool: specialistExecTool,
      exitOnToolCall: "complete_adoption",
      autoFirstTurn: true,
      banner: false,
      disableCommands: true,
      skipSystemPromptRefresh: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "hi" },
      ],
    })

    if (result.exitReason === "tool_exit" && result.toolResult) {
      const parsed = typeof result.toolResult === "string" ? JSON.parse(result.toolResult) : result.toolResult
      if (parsed.success && parsed.agentName) {
        return parsed.agentName as string
      }
    }

    return null
  } catch (err) {
    process.stderr.write(`\nouro adoption error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    coldRl.close()
    return null
  } finally {
    // Clear specialist config/identity so the hatched agent gets its own
    setAgentConfigOverride(null)
    const { resetProviderRuntime } = await import("../core")
    resetProviderRuntime()
    const { resetConfigCache } = await import("../config")
    resetConfigCache()
    // Restore default logging
    const { setRuntimeLogger: restoreLogger } = await import("../../nerves/runtime")
    restoreLogger(null)

    // Clean up temp dir if it still exists
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch {
      // Best effort cleanup
    }
  }
}
/* v8 ignore stop */

export function createDefaultOuroCliDeps(socketPath = DEFAULT_DAEMON_SOCKET_PATH): OuroCliDeps {
  return {
    socketPath,
    sendCommand: sendDaemonCommand,
    startDaemonProcess: defaultStartDaemonProcess,
    writeStdout: defaultWriteStdout,
    checkSocketAlive: checkDaemonSocketAlive,
    cleanupStaleSocket: defaultCleanupStaleSocket,
    fallbackPendingMessage: defaultFallbackPendingMessage,
    listDiscoveredAgents: defaultListDiscoveredAgents,
    runHatchFlow: defaultRunHatchFlow,
    promptInput: defaultPromptInput,
    runAdoptionSpecialist: defaultRunAdoptionSpecialist,
    runAuthFlow: defaultRunRuntimeAuthFlow,
    registerOuroBundleType: defaultRegisterOuroBundleUti,
    installOuroCommand: defaultInstallOuroCommand,
    /* v8 ignore start -- self-healing: ensures active symlink matches running runtime version @preserve */
    ensureCurrentVersionInstalled: () => {
      const linkedVersion = getCurrentVersion({})
      const version = getPackageVersion()
      if (linkedVersion === version) return
      ensureLayout({})
      const cliHome = getOuroCliHome()
      const versionEntry = path.join(cliHome, "versions", version, "node_modules", "@ouro.bot", "cli", "dist", "heart", "daemon", "ouro-entry.js")
      if (!fs.existsSync(versionEntry)) {
        installVersion(version, {})
      }
      activateVersion(version, {})
    },
    /* v8 ignore stop */
    /* v8 ignore start -- CLI version management defaults: integration code @preserve */
    checkForCliUpdate: async () => {
      const { checkForUpdate } = await import("./update-checker")
      return checkForUpdate(getPackageVersion(), {
        fetchRegistryJson: async () => {
          const res = await fetch("https://registry.npmjs.org/@ouro.bot/cli")
          return res.json()
        },
        distTag: "alpha",
      })
    },
    installCliVersion: async (version: string) => { installVersion(version, {}) },
    activateCliVersion: (version: string) => { activateVersion(version, {}) },
    getCurrentCliVersion: () => getCurrentVersion({}),
    getPreviousCliVersion: () => getPreviousVersion({}),
    listCliVersions: () => listInstalledVersions({}),
    reExecFromNewVersion: (reArgs: string[]) => {
      const entry = path.join(getOuroCliHome(), "CurrentVersion", "node_modules", "@ouro.bot", "cli", "dist", "heart", "daemon", "ouro-entry.js")
      require("child_process").execFileSync("node", [entry, ...reArgs], { stdio: "inherit" })
      process.exit(0)
    },
    /* v8 ignore stop */
    syncGlobalOuroBotWrapper: defaultSyncGlobalOuroBotWrapper,
    ensureSkillManagement: defaultEnsureSkillManagement,
    ensureDaemonBootPersistence: defaultEnsureDaemonBootPersistence,
    /* v8 ignore start -- dev-mode defaults: tests inject mocks for mode detection and binary resolution @preserve */
    detectMode: () => detectRuntimeMode(getRepoRoot()),
    getInstalledBinaryPath: () => {
      const cliHome = getOuroCliHome()
      const binaryPath = path.join(cliHome, "bin", "ouro")
      return fs.existsSync(binaryPath) ? binaryPath : null
    },
    execInstalledBinary: (binaryPath: string, binArgs: string[]) => {
      const { execFileSync } = require("child_process") as typeof import("child_process")
      execFileSync(binaryPath, binArgs, { stdio: "inherit" })
      process.exit(0)
    },
    /* v8 ignore stop */
    /* v8 ignore next 3 -- integration: launches interactive CLI session @preserve */
    startChat: async (agentName: string) => {
      const { main } = await import("../../senses/cli")
      await main(agentName)
    },
    scanSessions: async () => {
      const agentName = getAgentName()
      const agentRoot = getAgentRoot(agentName)
      return listSessionActivity({
        sessionsDir: path.join(agentRoot, "state", "sessions"),
        friendsDir: path.join(agentRoot, "friends"),
        agentName,
      }).map((entry) => ({
        friendId: entry.friendId,
        friendName: entry.friendName,
        channel: entry.channel,
        lastActivity: entry.lastActivityAt,
      }))
    },
  }
}

type McpListCliCommand = Extract<OuroCliCommand, { kind: "mcp.list" }>
type McpCallCliCommand = Extract<OuroCliCommand, { kind: "mcp.call" }>

function formatMcpResponse(command: McpListCliCommand | McpCallCliCommand, response: DaemonResponse): string {
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

type ThoughtsCliCommand = Extract<OuroCliCommand, { kind: "thoughts" }>
type AuthCliCommand = Extract<OuroCliCommand, { kind: "auth.run" }>
type AuthVerifyCliCommand = Extract<OuroCliCommand, { kind: "auth.verify" }>
type AuthSwitchCliCommand = Extract<OuroCliCommand, { kind: "auth.switch" }>
type ChangelogCliCommand = Extract<OuroCliCommand, { kind: "changelog" }>
type ConfigModelCliCommand = Extract<OuroCliCommand, { kind: "config.model" }>
type ConfigModelsCliCommand = Extract<OuroCliCommand, { kind: "config.models" }>
type RollbackCliCommand = Extract<OuroCliCommand, { kind: "rollback" }>
type VersionsCliCommand = Extract<OuroCliCommand, { kind: "versions" }>
type AttentionCliCommand = Extract<OuroCliCommand, { kind: "attention.list" } | { kind: "attention.show" } | { kind: "attention.history" }>
type InnerStatusCliCommand = Extract<OuroCliCommand, { kind: "inner.status" }>
type McpServeCliCommand = Extract<OuroCliCommand, { kind: "mcp-serve" }>
type SetupCliCommand = Extract<OuroCliCommand, { kind: "setup" }>
type HookCliCommand = Extract<OuroCliCommand, { kind: "hook" }>
type HabitLocalCliCommand = Extract<OuroCliCommand, { kind: "habit.list" } | { kind: "habit.create" }>
function toDaemonCommand(command: Exclude<OuroCliCommand, { kind: "daemon.up" } | { kind: "daemon.dev" } | { kind: "outlook" } | { kind: "hatch.start" } | AuthCliCommand | AuthVerifyCliCommand | AuthSwitchCliCommand | TaskCliCommand | ReminderCliCommand | FriendCliCommand | WhoamiCliCommand | SessionCliCommand | ThoughtsCliCommand | ChangelogCliCommand | ConfigModelCliCommand | ConfigModelsCliCommand | RollbackCliCommand | VersionsCliCommand | AttentionCliCommand | InnerStatusCliCommand | McpServeCliCommand | SetupCliCommand | HookCliCommand | HabitLocalCliCommand>): DaemonCommand {
  return command
}

async function resolveHatchInput(command: Extract<OuroCliCommand, { kind: "hatch.start" }>, deps: OuroCliDeps): Promise<HatchFlowInput> {
  const prompt = deps.promptInput
  const agentName = command.agentName ?? (prompt ? await prompt("Hatchling name: ") : "")
  const humanName = command.humanName ?? (prompt ? await prompt("Your name: ") : os.userInfo().username)
  const providerRaw = command.provider ?? (prompt ? await prompt("Provider (azure|anthropic|minimax|openai-codex|github-copilot): ") : "")

  if (!agentName || !humanName || !isAgentProvider(providerRaw)) {
    throw new Error(`Usage\n${usage()}`)
  }

  const credentials = await resolveHatchCredentials({
    agentName,
    provider: providerRaw,
    credentials: command.credentials,
    promptInput: prompt,
    runAuthFlow: deps.runAuthFlow,
  })

  return {
    agentName,
    humanName,
    provider: providerRaw,
    credentials,
    migrationPath: command.migrationPath,
  }
}

async function registerOuroBundleTypeNonBlocking(deps: OuroCliDeps): Promise<void> {
  const registerOuroBundleType = deps.registerOuroBundleType
  if (!registerOuroBundleType) return
  try {
    await Promise.resolve(registerOuroBundleType())
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.ouro_uti_register_error",
      message: "failed .ouro UTI registration from CLI flow",
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }
}

async function performSystemSetup(deps: OuroCliDeps): Promise<void> {
  // Install ouro command to PATH (non-blocking)
  if (deps.installOuroCommand) {
    try {
      const installResult = deps.installOuroCommand()
      /* v8 ignore next -- old-launcher repair hint: fires when stale ~/.local/bin/ouro is fixed @preserve */
      if (installResult.repairedOldLauncher) {
        deps.writeStdout("repaired stale ouro launcher at ~/.local/bin/ouro")
      }
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.system_setup_ouro_cmd_error",
        message: "failed to install ouro command to PATH",
        meta: { error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error) },
      })
    }
  }

  // Self-healing: ensure current version is installed in ~/.ouro-cli/ layout.
  // Handles the case where the wrapper exists but CurrentVersion is missing
  // (e.g., first run after migration from old npx wrapper).
  if (deps.ensureCurrentVersionInstalled) {
    try {
      deps.ensureCurrentVersionInstalled()
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.system_setup_version_install_error",
        message: "failed to ensure current version installed",
        meta: { error: error instanceof Error ? error.message : /* v8 ignore next -- defensive @preserve */ String(error) },
      })
    }
  }

  if (deps.syncGlobalOuroBotWrapper) {
    try {
      await Promise.resolve(deps.syncGlobalOuroBotWrapper())
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.system_setup_ouro_bot_wrapper_error",
        message: "failed to sync global ouro.bot wrapper",
        meta: { error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error) },
      })
    }
  }

  // Ensure skill-management skill is available
  if (deps.ensureSkillManagement) {
    try {
      await deps.ensureSkillManagement()
    /* v8 ignore start -- defensive: ensureSkillManagement handles its own errors internally @preserve */
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.system_setup_skill_management_error",
        message: "failed to ensure skill-management skill",
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    }
    /* v8 ignore stop */
  }

  // Register .ouro bundle type (UTI on macOS)
  await registerOuroBundleTypeNonBlocking(deps)
}

type TaskCliCommand = Extract<OuroCliCommand,
  | { kind: "task.board" }
  | { kind: "task.create" }
  | { kind: "task.update" }
  | { kind: "task.show" }
  | { kind: "task.actionable" }
  | { kind: "task.deps" }
  | { kind: "task.sessions" }
  | { kind: "task.fix" }
>

type ReminderCliCommand = Extract<OuroCliCommand, { kind: "reminder.create" }>
type FriendCliCommand = Extract<OuroCliCommand, { kind: "friend.list" } | { kind: "friend.show" } | { kind: "friend.create" } | { kind: "friend.update" } | { kind: "friend.link" } | { kind: "friend.unlink" }>
type WhoamiCliCommand = Extract<OuroCliCommand, { kind: "whoami" }>
type SessionCliCommand = Extract<OuroCliCommand, { kind: "session.list" }>

function executeTaskCommand(command: TaskCliCommand, taskMod: TaskModule): string {
  if (command.kind === "task.board") {
    if (command.status) {
      const lines = taskMod.boardStatus(command.status)
      return lines.length > 0 ? lines.join("\n") : "no tasks in that status"
    }
    const board = taskMod.getBoard()
    return board.full || board.compact || "no tasks found"
  }

  if (command.kind === "task.create") {
    try {
      const created = taskMod.createTask({
        title: command.title,
        type: command.type ?? "one-shot",
        category: "general",
        body: "",
      })
      return `created: ${created}`
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error)}`
    }
  }

  if (command.kind === "task.update") {
    const result = taskMod.updateStatus(command.id, command.status)
    if (!result.ok) {
      return `error: ${result.reason ?? "status update failed"}`
    }
    const archivedSuffix = result.archived && result.archived.length > 0
      ? ` | archived: ${result.archived.join(", ")}`
      : ""
    return `updated: ${command.id} -> ${result.to}${archivedSuffix}`
  }

  if (command.kind === "task.show") {
    const task = taskMod.getTask(command.id)
    if (!task) return `task not found: ${command.id}`
    return [
      `title: ${task.title}`,
      `type: ${task.type}`,
      `status: ${task.status}`,
      `category: ${task.category}`,
      `created: ${task.created}`,
      `updated: ${task.updated}`,
      `path: ${task.path}`,
      task.body ? `\n${task.body}` : "",
    ].filter(Boolean).join("\n")
  }

  if (command.kind === "task.actionable") {
    const lines = taskMod.boardAction()
    return lines.length > 0 ? lines.join("\n") : "no action required"
  }

  if (command.kind === "task.deps") {
    const lines = taskMod.boardDeps()
    return lines.length > 0 ? lines.join("\n") : "no unresolved dependencies"
  }

  if (command.kind === "task.fix") {
    try {
      const fixOptions: import("../../repertoire/tasks/types").FixOptions = {
        mode: command.mode,
        ...(command.issueId ? { issueId: command.issueId } : {}),
        ...(command.option !== undefined ? { option: command.option } : {}),
      }
      const result = taskMod.fix(fixOptions)

      if (command.mode === "dry-run") {
        if (result.remaining.length === 0) {
          return `task health: clean`
        }
        const safeIssues = result.remaining.filter((i) => i.confidence === "safe")
        const reviewIssues = result.remaining.filter((i) => i.confidence === "needs_review")
        const lines: string[] = [`${result.remaining.length} issues found`]
        if (safeIssues.length > 0) {
          lines.push("", `safe fixes (${safeIssues.length}):`)
          for (const issue of safeIssues) {
            lines.push(`  ${issue.code}:${issue.target} -- ${issue.description}`)
          }
        }
        if (reviewIssues.length > 0) {
          lines.push("", `needs review (${reviewIssues.length}):`)
          for (const issue of reviewIssues) {
            lines.push(`  ${issue.code}:${issue.target} -- ${issue.description}`)
          }
        }
        lines.push("", `task health: ${result.health}`)
        return lines.join("\n")
      }

      // safe, single, or --all modes: show what was done
      const lines: string[] = []
      if (result.applied.length > 0) {
        lines.push(`${result.applied.length} applied:`)
        for (const issue of result.applied) {
          lines.push(`  ${issue.code}:${issue.target}`)
        }
      }
      if (result.remaining.length > 0) {
        lines.push(`${result.remaining.length} remaining:`)
        for (const issue of result.remaining) {
          lines.push(`  ${issue.code}:${issue.target} -- ${issue.description}`)
        }
      }
      if (result.applied.length === 0 && result.remaining.length === 0) {
        lines.push("no issues")
      }
      lines.push(`task health: ${result.health}`)
      return lines.join("\n")
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error)}`
    }
  }

  // command.kind === "task.sessions"
  const lines = taskMod.boardSessions()
  return lines.length > 0 ? lines.join("\n") : "no active sessions"
}

const TRUST_RANK: Record<string, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

/* v8 ignore start -- defensive: ?? fallbacks are unreachable when inputs are valid TrustLevel values @preserve */
function higherTrust(a?: TrustLevel, b?: TrustLevel): TrustLevel {
  const rankA = TRUST_RANK[a ?? "stranger"] ?? 1
  const rankB = TRUST_RANK[b ?? "stranger"] ?? 1
  return rankA >= rankB ? (a ?? "stranger") : (b ?? "stranger")
}
/* v8 ignore stop */

async function executeFriendCommand(command: FriendCliCommand, store: FriendStore): Promise<string> {
  if (command.kind === "friend.list") {
    const listAll = store.listAll
    if (!listAll) return "friend store does not support listing"
    const friends = await listAll.call(store)
    if (friends.length === 0) return "no friends found"

    const lines = friends.map((f) => {
      const trust = f.trustLevel ?? "unknown"
      return `${f.id}  ${f.name}  ${trust}`
    })
    return lines.join("\n")
  }

  if (command.kind === "friend.show") {
    const record = await store.get(command.friendId)
    if (!record) return `friend not found: ${command.friendId}`
    return JSON.stringify(record, null, 2)
  }

  if (command.kind === "friend.create") {
    const now = new Date().toISOString()
    const id = randomUUID()
    const trustLevel = (command.trustLevel ?? "acquaintance") as TrustLevel
    await store.put(id, {
      id,
      name: command.name,
      trustLevel,
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    })
    return `created: ${id} (${command.name}, ${trustLevel})`
  }

  if (command.kind === "friend.update") {
    const current = await store.get(command.friendId)
    if (!current) return `friend not found: ${command.friendId}`
    const now = new Date().toISOString()
    await store.put(command.friendId, {
      ...current,
      trustLevel: command.trustLevel,
      role: command.trustLevel,
      updatedAt: now,
    })
    return `updated: ${command.friendId} → trust=${command.trustLevel}`
  }

  if (command.kind === "friend.link") {
    const current = await store.get(command.friendId)
    if (!current) return `friend not found: ${command.friendId}`

    const alreadyLinked = current.externalIds.some(
      (ext) => ext.provider === command.provider && ext.externalId === command.externalId,
    )
    if (alreadyLinked) return `identity already linked: ${command.provider}:${command.externalId}`

    const now = new Date().toISOString()
    const newExternalIds = [
      ...current.externalIds,
      { provider: command.provider, externalId: command.externalId, linkedAt: now },
    ]

    // Orphan cleanup: check if another friend has this externalId
    const orphan = await store.findByExternalId(command.provider, command.externalId)
    let mergeMessage = ""
    let mergedNotes = { ...current.notes }
    let mergedTrust = current.trustLevel
    let orphanExternalIds: typeof current.externalIds = []

    if (orphan && orphan.id !== command.friendId) {
      // Merge orphan's notes (target's notes take priority)
      mergedNotes = { ...orphan.notes, ...current.notes }
      // Keep higher trust level
      mergedTrust = higherTrust(current.trustLevel, orphan.trustLevel)
      // Collect orphan's other externalIds (excluding the one being linked)
      orphanExternalIds = orphan.externalIds.filter(
        (ext) => !(ext.provider === command.provider && ext.externalId === command.externalId),
      )
      await store.delete(orphan.id)
      mergeMessage = ` (merged orphan ${orphan.id})`
    }

    await store.put(command.friendId, {
      ...current,
      externalIds: [...newExternalIds, ...orphanExternalIds],
      notes: mergedNotes,
      trustLevel: mergedTrust,
      updatedAt: now,
    })

    return `linked ${command.provider}:${command.externalId} to ${command.friendId}${mergeMessage}`
  }

  // command.kind === "friend.unlink"
  const current = await store.get(command.friendId)
  if (!current) return `friend not found: ${command.friendId}`

  const idx = current.externalIds.findIndex(
    (ext) => ext.provider === command.provider && ext.externalId === command.externalId,
  )
  if (idx === -1) return `identity not linked: ${command.provider}:${command.externalId}`

  const now = new Date().toISOString()
  const filtered = current.externalIds.filter((_, i) => i !== idx)
  await store.put(command.friendId, { ...current, externalIds: filtered, updatedAt: now })
  return `unlinked ${command.provider}:${command.externalId} from ${command.friendId}`
}

function executeReminderCommand(command: ReminderCliCommand, taskMod: TaskModule): string {
  try {
    const created = taskMod.createTask({
      title: command.title,
      type: command.cadence ? "ongoing" : "one-shot",
      category: command.category ?? "reminder",
      body: command.body,
      scheduledAt: command.scheduledAt,
      cadence: command.cadence,
      requester: command.requester,
    })
    return `created: ${created}`
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error)}`
  }
}

/* v8 ignore start -- repo resolution for ouro dev: repoPath branch tested via daemon-cli-dev; clone requires real git/npm @preserve */
function getDevConfigPath(): string {
  return path.join(getOuroCliHome(), "dev-config.json")
}

function readPersistedDevPath(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(getDevConfigPath(), "utf-8"))
    return typeof data.repoPath === "string" ? data.repoPath : null
  } catch {
    return null
  }
}

function persistDevPath(repoPath: string): void {
  try {
    fs.mkdirSync(path.dirname(getDevConfigPath()), { recursive: true })
    fs.writeFileSync(getDevConfigPath(), JSON.stringify({ repoPath }, null, 2))
  } catch { /* best effort */ }
}

function resolveDevRepoCwd(
  command: { repoPath?: string; clone?: boolean; clonePath?: string },
  checkExists: (p: string) => boolean,
  deps: { writeStdout: (text: string) => void; getRepoCwd?: () => string },
): string {
  // 1. Explicit --repo-path: use it and persist for next time
  if (command.repoPath) {
    const resolved = path.resolve(command.repoPath)
    persistDevPath(resolved)
    return resolved
  }
  // 2. Clone request
  if (command.clone) return resolveClonePath(command, checkExists, deps)
  // 3. If test/internal deps provide getRepoCwd, use it directly
  if (deps.getRepoCwd) {
    return deps.getRepoCwd()
  }
  // 4. Check CWD — if we're inside a harness repo, use it
  const cwd = process.cwd()
  if (checkExists(path.join(cwd, ".git")) && checkExists(path.join(cwd, "src", "heart", "daemon"))) {
    persistDevPath(cwd)
    return cwd
  }
  // 5. Read persisted path from last --repo-path
  const persisted = readPersistedDevPath()
  if (persisted && checkExists(path.join(persisted, ".git"))) {
    deps.writeStdout(`using remembered dev path: ${persisted}`)
    return persisted
  }
  // 6. Fall back to getRepoRoot (works when running from installed binary → resolves to npm package)
  return getRepoRoot()
}
/* v8 ignore stop */

/* v8 ignore start -- clone/build: requires real git clone + npm install on disk @preserve */
function resolveClonePath(
  command: { clonePath?: string },
  checkExists: (p: string) => boolean,
  deps: { writeStdout: (text: string) => void },
): string {
  const cloneTarget = command.clonePath
    ? path.resolve(command.clonePath)
    : path.join(os.homedir(), "Projects", "ouroboros")
  if (!checkExists(path.join(cloneTarget, ".git"))) {
    deps.writeStdout(`cloning ouroboros to ${cloneTarget}...`)
    try {
      execSync(`git clone ${HARNESS_CANONICAL_REPO_URL} "${cloneTarget}"`, { stdio: "inherit" })
    } catch {
      throw new Error(`clone failed. check your network and try again, or clone manually and use --repo-path.`)
    }
  } else {
    deps.writeStdout(`repo already exists at ${cloneTarget}, pulling latest...`)
    try {
      execSync("git pull --ff-only", { cwd: cloneTarget, stdio: "inherit" })
    } catch {
      deps.writeStdout("pull failed (may have local changes). continuing with existing code.")
    }
  }
  deps.writeStdout("building...")
  try {
    execSync("npm install && npm run build", { cwd: cloneTarget, stdio: "inherit" })
  } catch {
    throw new Error(`build failed in ${cloneTarget}. check the output above.`)
  }
  return cloneTarget
}
/* v8 ignore stop */

export async function runOuroCli(args: string[], deps: OuroCliDeps = createDefaultOuroCliDeps()): Promise<string> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    const text = usage()
    deps.writeStdout(text)
    return text
  }

  if (args.length === 1 && (args[0] === "-v" || args[0] === "--version")) {
    const text = formatVersionOutput()
    deps.writeStdout(text)
    return text
  }

  let command: OuroCliCommand
  try {
    command = parseOuroCommand(args)
  } catch (parseError) {
    if (deps.startChat && deps.listDiscoveredAgents && args.length === 1) {
      const discovered = await Promise.resolve(deps.listDiscoveredAgents())
      if (discovered.includes(args[0])) {
        await ensureDaemonRunning(deps)
        await deps.startChat(args[0])
        return ""
      }
    }
    throw parseError
  }

  if (args.length === 0) {
    const discovered = await Promise.resolve(
      deps.listDiscoveredAgents ? deps.listDiscoveredAgents() : defaultListDiscoveredAgents(),
    )
    if (discovered.length === 0 && deps.runAdoptionSpecialist) {
      // System setup first — ouro command, subagents, UTI — before the interactive specialist
      await performSystemSetup(deps)

      const hatchlingName = await deps.runAdoptionSpecialist()
      if (!hatchlingName) {
        return ""
      }

      await ensureDaemonRunning(deps)

      if (deps.startChat) {
        await deps.startChat(hatchlingName)
      }
      return ""
    } else if (discovered.length === 0) {
      command = { kind: "hatch.start" }
    } else if (discovered.length === 1) {
      if (deps.startChat) {
        await ensureDaemonRunning(deps)
        await deps.startChat(discovered[0])
        return ""
      }
      command = { kind: "chat.connect", agent: discovered[0] }
    } else {
      if (deps.startChat && deps.promptInput) {
        const prompt = `who do you want to talk to?\n${discovered.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n`
        const answer = await deps.promptInput(prompt)
        const selected = discovered.includes(answer) ? answer : discovered[parseInt(answer, 10) - 1]
        if (!selected) throw new Error("Invalid selection")
        await ensureDaemonRunning(deps)
        await deps.startChat(selected)
        return ""
      }
      const message = `who do you want to talk to? ${discovered.join(", ")} (use: ouro chat <agent>)`
      deps.writeStdout(message)
      return message
    }
    emitNervesEvent({
      component: "daemon",
      event: "daemon.cli_auto_route",
      message: "routed bare ouro command from discovered agents",
      meta: { target: command.kind, count: discovered.length },
    })
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.cli_command",
    message: "ouro CLI command invoked",
    meta: { kind: command.kind },
  })

  if (command.kind === "daemon.up") {
    // ── dev mode cleanup: delete dev-config.json so the wrapper stops dispatching to dev repo ──
    /* v8 ignore start -- dev-config cleanup: requires real filesystem state @preserve */
    try {
      const devConfigPath = getDevConfigPath()
      if (fs.existsSync(devConfigPath)) {
        fs.unlinkSync(devConfigPath)
      }
    } catch { /* best effort */ }
    /* v8 ignore stop */

    // ── dev mode delegation: ouro up from a dev repo delegates to installed binary ──
    // Only runs when detectMode is explicitly injected (via createDefaultOuroCliDeps or tests)
    if (deps.detectMode) {
      const runtimeMode = deps.detectMode()
      if (runtimeMode === "dev") {
        /* v8 ignore next -- defensive: getInstalledBinaryPath always injected in tests @preserve */
        const installedBinary = deps.getInstalledBinaryPath ? deps.getInstalledBinaryPath() : null
        if (installedBinary) {
          deps.writeStdout("delegating to installed ouro...")
          /* v8 ignore next 3 -- defensive: execInstalledBinary always injected; missing branch unreachable @preserve */
          if (deps.execInstalledBinary) {
            deps.execInstalledBinary(installedBinary, args)
          }
          /* v8 ignore next 2 -- unreachable after exec replaces process @preserve */
          return ""
        }
        const message = "no installed version found. run: npx @ouro.bot/cli@alpha"
        deps.writeStdout(message)
        return message
      }
    }

    const linkedVersionBeforeUp = deps.getCurrentCliVersion?.() ?? null

    // ── versioned CLI update check ──
    if (deps.checkForCliUpdate) {
      let pendingReExec = false
      try {
        const updateResult = await deps.checkForCliUpdate()
        if (updateResult.available && updateResult.latestVersion) {
          /* v8 ignore next -- fallback: getCurrentCliVersion always injected in tests @preserve */
          const currentVersion = linkedVersionBeforeUp ?? "unknown"
          await deps.installCliVersion!(updateResult.latestVersion)
          deps.activateCliVersion!(updateResult.latestVersion)
          deps.writeStdout(`ouro updated to ${updateResult.latestVersion} (was ${currentVersion})`)
          const changelogCommand = buildChangelogCommand(currentVersion, updateResult.latestVersion)
          /* v8 ignore next -- buildChangelogCommand is non-null when an actual newer version is installed @preserve */
          if (changelogCommand) {
            deps.writeStdout(`review changes with: ${changelogCommand}`)
          }
          pendingReExec = true
        }
      /* v8 ignore start -- update check error: tested via daemon-cli-update-flow.test.ts @preserve */
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.cli_update_check_error",
          message: "CLI update check failed",
          meta: { error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error) },
        })
      }
      /* v8 ignore stop */
      if (pendingReExec) {
        deps.reExecFromNewVersion!(args)
      }
    }

    await performSystemSetup(deps)

    const linkedVersionAfterSetup = deps.getCurrentCliVersion?.() ?? null
    const runtimeVersion = getPackageVersion()
    if (linkedVersionBeforeUp && linkedVersionBeforeUp !== runtimeVersion && linkedVersionAfterSetup === runtimeVersion) {
      deps.writeStdout(`ouro updated to ${runtimeVersion} (was ${linkedVersionBeforeUp})`)
      const changelogCommand = buildChangelogCommand(linkedVersionBeforeUp, runtimeVersion)
      if (changelogCommand) {
        deps.writeStdout(`review changes with: ${changelogCommand}`)
      }
    }

    // Run update hooks before starting daemon so user sees the output
    registerUpdateHook(bundleMetaHook)
    registerUpdateHook(agentConfigV2Hook)
    const bundlesRoot = getAgentBundlesRoot()
    const currentVersion = getPackageVersion()

    // Snapshot the previous CLI version from the first bundle-meta before
    // hooks overwrite it. This detects when npx downloaded a newer CLI.
    const previousCliVersion = readFirstBundleMetaVersion(bundlesRoot)

    const updateSummary = await applyPendingUpdates(bundlesRoot, currentVersion)

    // Notify about CLI binary update (npx downloaded a new version).
    // Skip when the symlink already points to the running version — that
    // means path 1 (checkForCliUpdate + reExecFromNewVersion) already
    // printed the update message before re-exec.
    /* v8 ignore start -- CLI update detection: tested via daemon-cli-version-detect.test.ts @preserve */
    if (previousCliVersion && previousCliVersion !== currentVersion && linkedVersionBeforeUp !== currentVersion) {
      deps.writeStdout(`ouro updated to ${currentVersion} (was ${previousCliVersion})`)
      const changelogCommand = buildChangelogCommand(previousCliVersion, currentVersion)
      /* v8 ignore next -- buildChangelogCommand is non-null when previous/current runtime versions differ @preserve */
      if (changelogCommand) {
        deps.writeStdout(`review changes with: ${changelogCommand}`)
      }
    }
    /* v8 ignore stop */

    if (updateSummary.updated.length > 0) {
      const agents = updateSummary.updated.map((e) => e.agent)
      const from = updateSummary.updated[0].from
      const to = updateSummary.updated[0].to
      const fromStr = from ? ` (was ${from})` : ""
      const count = agents.length
      deps.writeStdout(`updated ${count} agent${count === 1 ? "" : "s"} to runtime ${to}${fromStr}`)
    }

    const daemonResult = await ensureDaemonRunning(deps)
    deps.writeStdout(daemonResult.message)

    // Persist boot startup AFTER daemon is running — bootstrap is safe now
    // because the daemon socket exists, so launchd's KeepAlive registers
    // for crash recovery without starting a competing process.
    if (deps.ensureDaemonBootPersistence) {
      try {
        await Promise.resolve(deps.ensureDaemonBootPersistence(deps.socketPath))
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.system_setup_launchd_error",
          message: "failed to persist daemon boot startup",
          meta: { error: error instanceof Error ? error.message : String(error), socketPath: deps.socketPath },
        })
      }
    }

    return daemonResult.message
  }

  if (command.kind === "daemon.dev") {
    /* v8 ignore next -- defensive: existsSync always injected in tests @preserve */
    const checkExists = deps.existsSync ?? fs.existsSync

    /* v8 ignore next -- repo resolution dispatched to v8-ignored helper @preserve */
    let repoCwd = resolveDevRepoCwd(command, checkExists, deps)

    let entryPath = path.join(repoCwd, "dist", "heart", "daemon", "daemon-entry.js")
    if (!checkExists(entryPath) || !checkExists(path.join(repoCwd, ".git"))) {
      if (command.repoPath) {
        // Explicit --repo-path didn't have a valid repo — error
        const message = `no harness repo found at ${repoCwd}. run npm run build first.`
        deps.writeStdout(message)
        return message
      }
      /* v8 ignore start -- auto-clone: interactive prompt + existing repo discovery + real git/npm @preserve */
      const defaultClonePath = path.join(os.homedir(), "Projects", "ouroboros")
      if (checkExists(path.join(defaultClonePath, ".git"))) {
        deps.writeStdout(`found existing repo at ${defaultClonePath}`)
        try {
          repoCwd = resolveClonePath({ clonePath: defaultClonePath }, checkExists, deps)
          entryPath = path.join(repoCwd, "dist", "heart", "daemon", "daemon-entry.js")
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          deps.writeStdout(message)
          return message
        }
      } else if (deps.promptInput) {
        deps.writeStdout("no harness repo found.")
        const answer = await deps.promptInput(`already have a checkout? enter its path, or press enter to clone to ${defaultClonePath}: `)
        const cloneTarget = answer.trim() || defaultClonePath
        try {
          repoCwd = resolveClonePath({ clonePath: cloneTarget }, checkExists, deps)
          entryPath = path.join(repoCwd, "dist", "heart", "daemon", "daemon-entry.js")
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          deps.writeStdout(message)
          return message
        }
      } else {
        const message = `no harness repo found. run: ouro dev --repo-path /path/to/ouroboros`
        deps.writeStdout(message)
        return message
      }
      /* v8 ignore stop */
    }

    // Auto-build: always rebuild in dev mode so dist/ matches source
    /* v8 ignore start -- dev auto-build: execSync in repo cwd, tested manually @preserve */
    deps.writeStdout(`building from ${repoCwd}...`)
    try {
      execSync("npm run build", { cwd: repoCwd, stdio: "inherit" })
      entryPath = path.join(repoCwd, "dist", "heart", "daemon", "daemon-entry.js")
    } catch {
      const message = `build failed in ${repoCwd}. fix compilation errors and retry.`
      deps.writeStdout(message)
      return message
    }
    /* v8 ignore stop */

    /* v8 ignore start -- defensive: ensureDaemonBootPersistence always injected in tests @preserve */
    if (deps.ensureDaemonBootPersistence) {
      try {
        await Promise.resolve(deps.ensureDaemonBootPersistence(deps.socketPath))
      /* v8 ignore next -- defensive: boot persistence error should not block dev mode @preserve */
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.dev_boot_persistence_error",
          message: "failed to persist daemon boot startup in dev mode",
          meta: { error: error instanceof Error ? error.message : String(error), socketPath: deps.socketPath },
        })
      }
      /* v8 ignore stop */
    }

    // Disable launchd KeepAlive before killing — prevents the installed daemon from respawning
    /* v8 ignore start -- dev launchd disable: requires real launchctl + plist on disk @preserve */
    const launchdDevDeps: Pick<LaunchdDeps, "exec" | "existsFile" | "removeFile" | "homeDir" | "userUid"> = {
      exec: (cmd: string) => { execSync(cmd) },
      existsFile: (p: string) => fs.existsSync(p),
      removeFile: (p: string) => { try { fs.unlinkSync(p) } catch { /* best effort */ } },
      homeDir: os.homedir(),
      userUid: process.getuid?.() ?? 0,
    }
    if (isDaemonInstalled(launchdDevDeps)) {
      uninstallLaunchAgent(launchdDevDeps as LaunchdDeps)
      deps.writeStdout("disabled launchd auto-restart for dev mode")
    }
    /* v8 ignore stop */

    // Always force-restart in dev mode — you rebuilt, you want this code running
    /* v8 ignore start -- dev force-restart: socket alive/stop/spawn tested via integration; tests inject mocks @preserve */
    const alive = await deps.checkSocketAlive(deps.socketPath)
    if (alive) {
      try { await deps.sendCommand(deps.socketPath, { kind: "daemon.stop" }) } catch { /* already stopping */ }
    }
    deps.cleanupStaleSocket(deps.socketPath)
    const devEntry = path.join(repoCwd, "dist", "heart", "daemon", "daemon-entry.js")
    const startDevDaemon = deps.startDaemonProcess === defaultStartDaemonProcess
      ? async (sp: string) => {
          const child = spawn("node", [devEntry, "--socket", sp], { detached: true, stdio: "ignore" })
          child.unref()
          return { pid: child.pid ?? null }
        }
      : deps.startDaemonProcess
    /* v8 ignore stop */
    const started = await startDevDaemon(deps.socketPath)
    /* v8 ignore next -- defensive: pid is null only when spawn fails silently @preserve */
    const message = `daemon running in dev mode from ${repoCwd} (pid ${started.pid ?? "unknown"})\nrun 'ouro up' to return to production mode`
    deps.writeStdout(message)
    return message
  }

  // ── rollback command (local, no daemon socket needed for symlinks) ──
  /* v8 ignore start -- rollback/versions: tested via daemon-cli-rollback/versions tests @preserve */
  if (command.kind === "rollback") {
    const currentVersion = deps.getCurrentCliVersion?.() ?? "unknown"

    if (command.version) {
      // Rollback to a specific version
      const installed = deps.listCliVersions?.() ?? []
      if (!installed.includes(command.version)) {
        try {
          await deps.installCliVersion!(command.version)
        } catch (error) {
          const message = `failed to install version ${command.version}: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error)}`
          deps.writeStdout(message)
          return message
        }
      }
      deps.activateCliVersion!(command.version)
    } else {
      // Rollback to previous version
      const previousVersion = deps.getPreviousCliVersion?.()
      if (!previousVersion) {
        const message = "no previous version to roll back to"
        deps.writeStdout(message)
        return message
      }
      deps.activateCliVersion!(previousVersion)
      command = { ...command, version: previousVersion }
    }

    // Stop daemon (non-fatal if not running)
    try {
      await deps.sendCommand(deps.socketPath, { kind: "daemon.stop" })
    } catch {
      // Daemon may not be running — that's fine
    }

    const message = `rolled back to ${command.version} (was ${currentVersion})`
    deps.writeStdout(message)
    return message
  }

  // ── versions command (local install list + published update truth, no daemon socket needed) ──
  if (command.kind === "versions") {
    const versions = deps.listCliVersions?.() ?? []
    const current = deps.getCurrentCliVersion?.()
    const previous = deps.getPreviousCliVersion?.()
    const localSection = versions.length === 0
      ? "no versions installed"
      : versions.map((v) => {
          let line = v
          if (v === current) line += " * current"
          if (v === previous) line += " (previous)"
          return line
        }).join("\n")

    const sections = [localSection]
    if (deps.checkForCliUpdate) {
      try {
        const updateResult = await deps.checkForCliUpdate()
        if (updateResult.latestVersion) {
          sections.push(`published alpha: ${updateResult.latestVersion} (${updateResult.available ? "update available" : "up to date"})`)
        } else if (updateResult.error) {
          sections.push(`published alpha: unavailable (${updateResult.error})`)
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        sections.push(`published alpha: unavailable (${reason})`)
      }
    }

    const message = sections.join("\n\n")
    deps.writeStdout(message)
    return message
  }
  /* v8 ignore stop */

  if (command.kind === "daemon.logs" && deps.tailLogs) {
    deps.tailLogs()
    return ""
  }

  if (command.kind === "outlook") {
    let status: DaemonResponse
    try {
      status = await deps.sendCommand(deps.socketPath, { kind: "daemon.status" })
    /* v8 ignore start — error path: daemon not running */
    } catch {
      const message = "daemon unavailable — start with `ouro up` first"
      deps.writeStdout(message)
      return message
    }
    /* v8 ignore stop */

    const payload = parseStatusPayload(status.data)
    /* v8 ignore start -- ?? branch: outlookUrl always present in test fixtures */
    const outlookUrl = payload?.overview.outlookUrl ?? "unavailable"
    /* v8 ignore stop */
    if (!command.json) {
      deps.writeStdout(outlookUrl)
      return outlookUrl
    }

    /* v8 ignore start — error path: outlook URL not available */
    if (outlookUrl === "unavailable") {
      deps.writeStdout(outlookUrl)
      return outlookUrl
    }
    /* v8 ignore stop */

    /* v8 ignore start -- ?? branch: tests always inject fetchImpl */
    const fetchImpl = deps.fetchImpl ?? fetch
    /* v8 ignore stop */
    const response = await fetchImpl(`${outlookUrl}/api/machine`)
    const data = await response.json() as unknown
    const text = JSON.stringify(data, null, 2)
    deps.writeStdout(text)
    return text
  }
  // ── hook: handle Claude Code lifecycle hooks ──
  /* v8 ignore start -- hook handler: reads real stdin, sends to real daemon @preserve */
  if (command.kind === "hook") {
    let stdinData = ""
    try {
      stdinData = require("fs").readFileSync(0, "utf-8")
    } catch { /* no stdin */ }

    let event: Record<string, unknown> = {}
    try { event = JSON.parse(stdinData) } catch { /* malformed */ }

    const eventType = command.event
    const sessionId = (event.session_id as string) ?? "unknown"
    const cwd = (event.cwd as string) ?? ""

    // Build notification content based on event type
    let content: string
    if (eventType === "session-start") {
      const model = (event.model as string) ?? ""
      const source = (event.source as string) ?? ""
      content = `[Claude Code session started: ${sessionId}, cwd: ${cwd}${model ? `, model: ${model}` : ""}${source ? `, source: ${source}` : ""}]`
    } else if (eventType === "stop") {
      const lastMsg = (event.last_assistant_message as string) ?? ""
      content = `[Claude Code session ended: ${sessionId}${lastMsg ? `, last: ${lastMsg.slice(0, 200)}` : ""}]`
    } else if (eventType === "post-tool-use") {
      const toolName = (event.tool_name as string) ?? ""
      content = `[Claude Code used ${toolName} in session ${sessionId}]`
    } else {
      content = `[Claude Code hook: ${eventType} in session ${sessionId}]`
    }

    // Send to the specific agent configured for this hook
    try {
      await deps.sendCommand(deps.socketPath, { kind: "message.send", from: `claude-code:${sessionId}`, to: command.agent, content } as DaemonCommand).catch(() => {})
      await deps.sendCommand(deps.socketPath, { kind: "inner.wake", agent: command.agent } as DaemonCommand).catch(() => {})
    } catch { /* daemon not running — silent */ }

    // Output for Claude Code hook system
    deps.writeStdout(JSON.stringify({ continue: true }))
    return JSON.stringify({ continue: true })
  }
  /* v8 ignore stop */

  // ── setup: configure dev tool integration ──
  if (command.kind === "setup") {
    const { tool, agent: setupAgent } = command
    const sourceRoot = getRepoRoot()
    const runtimeMode = detectRuntimeMode(sourceRoot)
    const mcpServeCommand = runtimeMode === "dev"
      ? `node ${path.join(sourceRoot, "dist", "heart", "daemon", "ouro-bot-entry.js")} mcp-serve --agent ${setupAgent}`
      : `ouro mcp-serve --agent ${setupAgent}`

    if (tool === "claude-code") {
      // 1. Register MCP server with Claude Code
      const mcpAddCmd = `claude mcp add ouro-${setupAgent} -s user -- ${mcpServeCommand}`
      execSync(mcpAddCmd, { stdio: "pipe" })

      // 2. Write hooks config to ~/.claude/settings.json
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json")
      let settings: Record<string, unknown> = {}
      if (fs.existsSync(settingsPath)) {
        try {
          settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
        } catch { /* start fresh */ }
      }

      // Use `ouro hook <event>` — resolves the right code based on dev vs installed mode.
      // Bare `ouro` works because ouro is on PATH via ~/.ouro-cli/bin/.
      settings.hooks = {
        ...(settings.hooks as Record<string, unknown> ?? {}),
        SessionStart: [{ hooks: [{ type: "command", command: `ouro hook session-start --agent ${setupAgent}`, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: `ouro hook stop --agent ${setupAgent}`, timeout: 5 }] }],
        PostToolUse: [{ matcher: "Bash|Edit|Write", hooks: [{ type: "command", command: `ouro hook post-tool-use --agent ${setupAgent}`, timeout: 5 }] }],
      }

      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

      emitNervesEvent({
        component: "daemon",
        event: "daemon.setup_complete",
        message: "dev tool setup complete",
        meta: { tool, agent: setupAgent, runtimeMode },
      })

      // 3. Write conversation formatting instructions to ~/.claude/CLAUDE.md
      const claudeMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md")
      const agentInstructions = `\n## Agent conversations (ouro)\nWhen using MCP \`send_message\` to talk to an ouro agent, format the exchange clearly:\n- Before the tool call, briefly say what you're asking/telling the agent\n- After the response, quote the agent's reply in a blockquote, then add your reaction\n- Example: **Me → Agent:** "question" / > **Agent:** "response" / Your synthesis here\n`
      let existingClaudeMd = ""
      if (fs.existsSync(claudeMdPath)) {
        existingClaudeMd = fs.readFileSync(claudeMdPath, "utf-8")
      }
      if (!existingClaudeMd.includes("Agent conversations (ouro)")) {
        fs.writeFileSync(claudeMdPath, existingClaudeMd + agentInstructions)
      }

      const message = `setup complete: claude-code + ${setupAgent}\n  MCP server registered\n  hooks configured\n  conversation formatting instructions added`
      deps.writeStdout(message)
      return message
    } else {
      // tool === "codex" (parseSetupCommand validates tool, so this is the only remaining option)
      const mcpAddCmd = `codex mcp add ouro-${setupAgent} -- ${mcpServeCommand}`
      execSync(mcpAddCmd, { stdio: "pipe" })

      emitNervesEvent({
        component: "daemon",
        event: "daemon.setup_complete",
        message: "dev tool setup complete",
        meta: { tool, agent: setupAgent, runtimeMode },
      })

      const message = `setup complete: codex + ${setupAgent}\n  MCP server registered`
      deps.writeStdout(message)
      return message
    }
  }

  /* v8 ignore start — mcp-serve block binds to process.stdin/stdout; tested via mcp-server unit tests */
  // ── mcp-serve: start MCP server in-process on stdin/stdout ──
  if (command.kind === "mcp-serve") {
    const { createMcpServer } = await import("./mcp-server")
    const friendId = command.friendId ?? `local-${os.userInfo().username}`
    const mcpSocketPath = (command as { socketOverride?: string }).socketOverride ?? deps.socketPath
    const server = createMcpServer({
      agent: command.agent,
      friendId,
      socketPath: mcpSocketPath,
      stdin: process.stdin,
      stdout: process.stdout,
    })
    server.start()
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_serve_started",
      message: "MCP server started via CLI",
      meta: { agent: command.agent, friendId },
    })
    // Keep process alive until stdin closes
    await new Promise<void>((resolve) => {
      process.stdin.on("end", () => {
        server.stop()
        resolve()
      })
    })
    return ""
  }
  /* v8 ignore stop */
  // ── mcp subcommands (routed through daemon socket) ──
  if (command.kind === "mcp.list" || command.kind === "mcp.call") {
    const daemonCommand = toDaemonCommand(command)
    let response: DaemonResponse
    try {
      response = await deps.sendCommand(deps.socketPath, daemonCommand)
    } catch {
      const message = "daemon unavailable — start with `ouro up` first"
      deps.writeStdout(message)
      return message
    }
    if (!response.ok) {
      const message = response.error ?? "unknown error"
      deps.writeStdout(message)
      return message
    }
    const message = formatMcpResponse(command, response)
    deps.writeStdout(message)
    return message
  }

  // ── task subcommands (local, no daemon socket needed) ──
  if (command.kind === "task.board" || command.kind === "task.create" || command.kind === "task.update" ||
      command.kind === "task.show" || command.kind === "task.actionable" || command.kind === "task.deps" ||
      command.kind === "task.sessions" || command.kind === "task.fix") {
    /* v8 ignore start -- production default: requires full identity setup @preserve */
    const taskMod = deps.taskModule ?? getTaskModule()
    /* v8 ignore stop */
    const message = executeTaskCommand(command, taskMod)
    deps.writeStdout(message)
    return message
  }

  // ── reminder subcommands (local, no daemon socket needed) ──
  if (command.kind === "reminder.create") {
    /* v8 ignore start -- production default: requires full identity setup @preserve */
    const taskMod = deps.taskModule ?? getTaskModule()
    /* v8 ignore stop */
    const message = executeReminderCommand(command, taskMod)
    deps.writeStdout(message)
    return message
  }

  // ── habit subcommands (local, no daemon socket needed) ──
  if (command.kind === "habit.list" || command.kind === "habit.create") {
    const { parseHabitFile, renderHabitFile } = await import("./habit-parser")
    /* v8 ignore start -- production default: uses real bundle root @preserve */
    const agentName = command.agent ?? getAgentName()
    const bundleRoot = deps.agentBundleRoot ?? path.join(getAgentBundlesRoot(), `${agentName}.ouro`)
    /* v8 ignore stop */
    const habitsDir = path.join(bundleRoot, "habits")

    if (command.kind === "habit.list") {
      let files: string[]
      try {
        files = fs.readdirSync(habitsDir).filter((f) => f.endsWith(".md") && f !== "README.md")
      } catch {
        const message = "no habits found"
        deps.writeStdout(message)
        return message
      }
      if (files.length === 0) {
        const message = "no habits found"
        deps.writeStdout(message)
        return message
      }
      const lines: string[] = []
      for (const file of files) {
        const content = fs.readFileSync(path.join(habitsDir, file), "utf-8")
        const habit = parseHabitFile(content, path.join(habitsDir, file))
        const lastRunStr = habit.lastRun ?? "never"
        lines.push(`${habit.name}  cadence=${habit.cadence ?? "none"}  status=${habit.status}  lastRun=${lastRunStr}`)
      }
      const message = lines.join("\n")
      deps.writeStdout(message)
      return message
    }

    // habit.create
    const filePath = path.join(habitsDir, `${command.name}.md`)
    if (fs.existsSync(filePath)) {
      const message = `error: habit '${command.name}' already exists`
      deps.writeStdout(message)
      return message
    }
    fs.mkdirSync(habitsDir, { recursive: true })
    const now = new Date().toISOString()
    const content = renderHabitFile(
      {
        title: command.name,
        cadence: command.cadence ?? "null",
        status: "active",
        lastRun: now,
        created: now,
      },
      `Habit: ${command.name}`,
    )
    fs.writeFileSync(filePath, content, "utf-8")
    const message = `created: ${filePath}`
    deps.writeStdout(message)
    return message
  }

  // ── friend subcommands (local, no daemon socket needed) ──
  if (command.kind === "friend.list" || command.kind === "friend.show" || command.kind === "friend.create" ||
      command.kind === "friend.update" || command.kind === "friend.link" || command.kind === "friend.unlink") {
    /* v8 ignore start -- production default: requires full identity setup @preserve */
    let store = deps.friendStore
    if (!store) {
      // Derive agent-scoped friends dir from --agent flag or link/unlink's agent field
      const agentName = ("agent" in command && command.agent) ? command.agent : undefined
      const friendsDir = agentName
        ? path.join(getAgentBundlesRoot(), `${agentName}.ouro`, "friends")
        : path.join(getAgentBundlesRoot(), "friends")
      store = new FileFriendStore(friendsDir)
    }
    /* v8 ignore stop */
    const message = await executeFriendCommand(command, store)
    deps.writeStdout(message)
    return message
  }

  // ── auth (local, no daemon socket needed) ──
  if (command.kind === "auth.run") {
    const provider = command.provider ?? readAgentConfigForAgent(command.agent).config.humanFacing.provider
    /* v8 ignore next -- tests always inject runAuthFlow; default is for production @preserve */
    const authRunner = deps.runAuthFlow ?? defaultRunRuntimeAuthFlow
    const result = await authRunner({
      agentName: command.agent,
      provider,
      promptInput: deps.promptInput,
    })
    // Behavior: ouro auth stores credentials only — does NOT switch provider.
    // Use `ouro auth switch` to change the active provider.
    deps.writeStdout(result.message)

    // Verify the credentials actually work by pinging the provider
    /* v8 ignore start -- integration: real API ping after auth @preserve */
    try {
      const { secrets } = loadAgentSecrets(command.agent)
      const status = await verifyProviderCredentials(provider, secrets.providers)
      deps.writeStdout(`${provider}: ${status}`)
    } catch {
      // Verification failure is non-blocking — credentials were saved regardless
    }
    /* v8 ignore stop */
    return result.message
  }

  // ── auth verify (local, no daemon socket needed) ──
  /* v8 ignore start -- auth verify/switch: tested in daemon-cli.test.ts but v8 traces differ in CI @preserve */
  if (command.kind === "auth.verify") {
    const { secrets } = loadAgentSecrets(command.agent)
    const providers = secrets.providers
    if (command.provider) {
      const status = await verifyProviderCredentials(command.provider, providers)
      const message = `${command.provider}: ${status}`
      deps.writeStdout(message)
      return message
    }
    const lines: string[] = []
    for (const p of Object.keys(providers) as AgentProvider[]) {
      const status = await verifyProviderCredentials(p, providers)
      lines.push(`${p}: ${status}`)
    }
    const message = lines.join("\n")
    deps.writeStdout(message)
    return message
  }

  // ── auth switch (local, no daemon socket needed) ──
  if (command.kind === "auth.switch") {
    const { secrets } = loadAgentSecrets(command.agent)
    const providerSecrets = secrets.providers[command.provider]
    if (!providerSecrets || !hasStoredCredentials(command.provider, providerSecrets)) {
      const message = `no credentials stored for ${command.provider}. Run \`ouro auth --agent ${command.agent} --provider ${command.provider}\` first.`
      deps.writeStdout(message)
      return message
    }
    // Verify credentials actually work before switching
    const status = await verifyProviderCredentials(command.provider, secrets.providers)
    if (!status.startsWith("ok")) {
      const message = `${command.provider}: ${status}. fix credentials with \`ouro auth --agent ${command.agent} --provider ${command.provider}\` before switching.`
      deps.writeStdout(message)
      return message
    }
    if (command.facing) {
      writeAgentProviderSelection(command.agent, command.facing, command.provider)
    } else {
      writeAgentProviderSelection(command.agent, "human", command.provider)
      writeAgentProviderSelection(command.agent, "agent", command.provider)
    }
    const message = `switched ${command.agent} to ${command.provider} (verified working)`
    deps.writeStdout(message)
    return message
  }
  /* v8 ignore stop */

  // ── config models (local, no daemon socket needed) ──
  /* v8 ignore start -- config models: tested via daemon-cli.test.ts @preserve */
  if (command.kind === "config.models") {
    const { config } = readAgentConfigForAgent(command.agent)
    const provider = config.humanFacing.provider
    if (provider !== "github-copilot") {
      const message = `model listing not available for ${provider} — check provider documentation.`
      deps.writeStdout(message)
      return message
    }
    const { secrets } = loadAgentSecrets(command.agent)
    const ghConfig = secrets.providers["github-copilot"]
    if (!ghConfig.githubToken || !ghConfig.baseUrl) {
      throw new Error(`github-copilot credentials not configured. Run \`ouro auth --agent ${command.agent} --provider github-copilot\` first.`)
    }
    const fetchFn = deps.fetchImpl ?? fetch
    const models = await listGithubCopilotModels(ghConfig.baseUrl, ghConfig.githubToken, fetchFn)
    if (models.length === 0) {
      const message = "no models found"
      deps.writeStdout(message)
      return message
    }
    const lines = ["available models:"]
    for (const m of models) {
      const caps = m.capabilities?.length ? ` (${m.capabilities.join(", ")})` : ""
      lines.push(`  ${m.id}${caps}`)
    }
    const message = lines.join("\n")
    deps.writeStdout(message)
    return message
  }
  /* v8 ignore stop */

  // ── config model (local, no daemon socket needed) ──
  /* v8 ignore start -- config model: tested via daemon-cli.test.ts @preserve */
  if (command.kind === "config.model") {
    const facing = command.facing ?? "human"
    // Validate model availability for github-copilot before writing
    const { config } = readAgentConfigForAgent(command.agent)
    const facingConfig = facing === "human" ? config.humanFacing : config.agentFacing
    if (facingConfig.provider === "github-copilot") {
      const { secrets } = loadAgentSecrets(command.agent)
      const ghConfig = secrets.providers["github-copilot"]
      if (ghConfig.githubToken && ghConfig.baseUrl) {
        const fetchFn = deps.fetchImpl ?? fetch
        try {
          const models = await listGithubCopilotModels(ghConfig.baseUrl, ghConfig.githubToken, fetchFn)
          const available = models.map((m) => m.id)
          if (available.length > 0 && !available.includes(command.modelName)) {
            const message = `model '${command.modelName}' not found. available models:\n${available.map((id) => `  ${id}`).join("\n")}`
            deps.writeStdout(message)
            return message
          }
        } catch {
          // Catalog validation failed — fall through to ping test
        }

        // Ping test: verify the model actually works before switching
        const pingResult = await pingGithubCopilotModel(ghConfig.baseUrl, ghConfig.githubToken, command.modelName, fetchFn)
        if (!pingResult.ok) {
          const message = `model '${command.modelName}' ping failed: ${pingResult.error}\nrun \`ouro config models --agent ${command.agent}\` to see available models.`
          deps.writeStdout(message)
          return message
        }
      }
    }
    const { provider, previousModel } = writeAgentModel(command.agent, facing, command.modelName)
    const message = previousModel
      ? `updated ${command.agent} model on ${provider}: ${previousModel} → ${command.modelName}`
      : `set ${command.agent} model on ${provider}: ${command.modelName}`
    deps.writeStdout(message)
    return message
  }
  /* v8 ignore stop */

  // ── whoami (local, no daemon socket needed) ──
  if (command.kind === "whoami") {
    if (command.agent) {
      const agentRoot = path.join(getAgentBundlesRoot(), `${command.agent}.ouro`)
      const message = [
        `agent: ${command.agent}`,
        `home: ${agentRoot}`,
        `bones: ${getRuntimeMetadata().version}`,
      ].join("\n")
      deps.writeStdout(message)
      return message
    }
    /* v8 ignore start -- production default: requires full identity setup @preserve */
    try {
      const info = deps.whoamiInfo
        ? deps.whoamiInfo()
        : {
            agentName: getAgentName(),
            homePath: path.join(getAgentBundlesRoot(), `${getAgentName()}.ouro`),
            bonesVersion: getRuntimeMetadata().version,
          }
      const message = [
        `agent: ${info.agentName}`,
        `home: ${info.homePath}`,
        `bones: ${info.bonesVersion}`,
      ].join("\n")
      deps.writeStdout(message)
      return message
    } catch {
      const message = "error: no agent context — use --agent <name> to specify"
      deps.writeStdout(message)
      return message
    }
    /* v8 ignore stop */
  }

  // ── changelog (local, no daemon socket needed) ──
  if (command.kind === "changelog") {
    try {
      const changelogPath = deps.getChangelogPath
        ? deps.getChangelogPath()
        : getChangelogPath()
      const raw = fs.readFileSync(changelogPath, "utf-8")
      const parsed = JSON.parse(raw) as
        | Array<{ version: string; date?: string; changes?: string[] }>
        | { versions?: Array<{ version: string; date?: string; changes?: string[] }> }
      const entries = Array.isArray(parsed) ? parsed : (parsed.versions ?? [])
      let filtered = entries
      if (command.from) {
        const fromVersion = command.from
        filtered = entries.filter((e) => semver.valid(e.version) && semver.gt(e.version, fromVersion))
      }
      if (filtered.length === 0) {
        const message = "no changelog entries found."
        deps.writeStdout(message)
        return message
      }
      const lines: string[] = []
      for (const entry of filtered) {
        lines.push(`## ${entry.version}${entry.date ? ` (${entry.date})` : ""}`)
        if (entry.changes) {
          for (const change of entry.changes) {
            lines.push(`- ${change}`)
          }
        }
        lines.push("")
      }
      const message = lines.join("\n").trim()
      deps.writeStdout(message)
      return message
    } catch {
      const message = "no changelog entries found."
      deps.writeStdout(message)
      return message
    }
  }

  // ── thoughts (local, no daemon socket needed) ──
  if (command.kind === "thoughts") {
    try {
      const agentName = command.agent ?? getAgentName()
      const agentRoot = path.join(getAgentBundlesRoot(), `${agentName}.ouro`)
      const sessionFilePath = getInnerDialogSessionPath(agentRoot)
      if (command.json) {
        try {
          const raw = fs.readFileSync(sessionFilePath, "utf-8")
          deps.writeStdout(raw)
          return raw
        } catch {
          const message = "no inner dialog session found"
          deps.writeStdout(message)
          return message
        }
      }
      const turns = parseInnerDialogSession(sessionFilePath)
      const message = formatThoughtTurns(turns, command.last ?? 10)
      deps.writeStdout(message)
      if (command.follow) {
        deps.writeStdout("\n\n--- following (ctrl+c to stop) ---\n")
        /* v8 ignore start -- callback tested via followThoughts unit tests @preserve */
        const stop = followThoughts(sessionFilePath, (formatted) => {
          deps.writeStdout("\n" + formatted)
        })
        /* v8 ignore stop */
        // Block until process exit; cleanup watcher on SIGINT/SIGTERM
        return new Promise<string>((resolve) => {
          const cleanup = () => { stop(); resolve(message) }
          process.once("SIGINT", cleanup)
          process.once("SIGTERM", cleanup)
        })
      }
      return message
    } catch {
      const message = "error: no agent context — use --agent <name> to specify"
      deps.writeStdout(message)
      return message
    }
  }

  // ── attention queue (local, no daemon socket needed) ──
  /* v8 ignore start -- CLI attention handler: requires real obligation store on disk @preserve */
  if (command.kind === "attention.list" || command.kind === "attention.show" || command.kind === "attention.history") {
    try {
      const agentName = command.agent ?? getAgentName()
      const { listActiveObligations, readObligation } = await import("../../mind/obligations")

      if (command.kind === "attention.list") {
        const obligations = listActiveObligations(agentName)
        if (obligations.length === 0) {
          const message = "nothing held — attention queue is empty"
          deps.writeStdout(message)
          return message
        }
        const lines = obligations.map((o) =>
          `[${o.id}] ${o.origin.friendId} via ${o.origin.channel}/${o.origin.key} — ${o.delegatedContent.slice(0, 60)}${o.delegatedContent.length > 60 ? "..." : ""} (${o.status})`)
        const message = lines.join("\n")
        deps.writeStdout(message)
        return message
      }

      if (command.kind === "attention.show") {
        const obligation = readObligation(agentName, (command as Extract<OuroCliCommand, { kind: "attention.show" }>).id)
        if (!obligation) {
          const message = `no obligation found with id ${(command as Extract<OuroCliCommand, { kind: "attention.show" }>).id}`
          deps.writeStdout(message)
          return message
        }
        const message = JSON.stringify(obligation, null, 2)
        deps.writeStdout(message)
        return message
      }

      // attention.history: show returned obligations
      const { getObligationsDir } = await import("../../mind/obligations")
      const obligationsDir = getObligationsDir(agentName)
      let entries: string[] = []
      try { entries = fs.readdirSync(obligationsDir) } catch { /* empty */ }
      const returned = entries
        .filter((e) => e.endsWith(".json"))
        .map((e) => { try { return JSON.parse(fs.readFileSync(path.join(obligationsDir, e), "utf-8")) } catch { return null } })
        .filter((o): o is any => o?.status === "returned")
        .sort((a: any, b: any) => (b.returnedAt ?? 0) - (a.returnedAt ?? 0))
        .slice(0, 20)

      if (returned.length === 0) {
        const message = "no surfacing history yet"
        deps.writeStdout(message)
        return message
      }
      const lines = returned.map((o: any) => {
        const when = o.returnedAt ? new Date(o.returnedAt).toISOString() : "unknown"
        return `[${o.id}] → ${o.origin.friendId} via ${o.returnTarget ?? "unknown"} at ${when}`
      })
      const message = lines.join("\n")
      deps.writeStdout(message)
      return message
    } catch {
      const message = "error: no agent context — use --agent <name> to specify"
      deps.writeStdout(message)
      return message
    }
  }
  /* v8 ignore stop */

  // ── inner dialog status (local, no daemon socket needed) ──
  /* v8 ignore start -- inner status handler: requires real agent state on disk @preserve */
  if (command.kind === "inner.status") {
    try {
      const agentName = command.agent ?? getAgentName()
      const agentRoot = getAgentRoot(agentName)
      const { buildInnerStatusOutput } = await import("./inner-status")
      const { sessionPath: getSessionPath } = await import("../config")
      const { parseCadenceToMs: parseCadenceMs, DEFAULT_CADENCE_MS } = await import("./cadence")
      const { parseFrontmatter } = await import("../../repertoire/tasks/parser")
      const { listActiveObligations } = await import("../../mind/obligations")

      // Read runtime state
      const innerSessionPath = getSessionPath("inner-dialog", "inner", "session")
      const runtimeJsonPath = path.join(path.dirname(innerSessionPath), "runtime.json")
      let runtimeState: import("./inner-status").InnerRuntimeState | null = null
      try {
        const raw = fs.readFileSync(runtimeJsonPath, "utf-8")
        runtimeState = JSON.parse(raw)
      } catch { /* missing or corrupt — will show "unknown" */ }

      // Read journal files
      const journalDir = path.join(agentRoot, "journal")
      let journalFiles: import("./inner-status").JournalFileEntry[] = []
      try {
        const entries = fs.readdirSync(journalDir, { withFileTypes: true })
        journalFiles = entries
          .filter((e) => e.isFile() && !e.name.startsWith("."))
          .map((e) => {
            const stat = fs.statSync(path.join(journalDir, e.name))
            return { name: e.name, mtimeMs: stat.mtimeMs }
          })
      } catch { /* missing dir — will show (empty) */ }

      // Read heartbeat cadence
      let heartbeat: import("./inner-status").HeartbeatInfo | null = null
      try {
        const habitsDir = path.join(agentRoot, "habits")
        const heartbeatPath = path.join(habitsDir, "heartbeat.md")
        let cadenceMs = DEFAULT_CADENCE_MS
        if (fs.existsSync(heartbeatPath)) {
          const content = fs.readFileSync(heartbeatPath, "utf-8")
          const lines = content.split(/\r?\n/)
          if (lines[0]?.trim() === "---") {
            const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
            if (closing !== -1) {
              const rawFrontmatter = lines.slice(1, closing).join("\n")
              const frontmatter = parseFrontmatter(rawFrontmatter)
              const parsed = parseCadenceMs(frontmatter.cadence)
              if (parsed !== null) cadenceMs = parsed
            }
          }
        }
        let lastCompletedAt: number | null = null
        if (runtimeState?.lastCompletedAt) {
          const ms = new Date(runtimeState.lastCompletedAt).getTime()
          if (!Number.isNaN(ms)) lastCompletedAt = ms
        }
        heartbeat = { cadenceMs, lastCompletedAt }
      } catch { /* no habits — heartbeat unknown */ }

      // Attention count
      const activeObligations = listActiveObligations(agentName)

      const message = buildInnerStatusOutput({
        agentName,
        runtimeState,
        journalFiles,
        heartbeat,
        attentionCount: activeObligations.length,
        now: Date.now(),
      })
      deps.writeStdout(message)
      return message
    } catch {
      const message = "error: no agent context — use --agent <name> to specify"
      deps.writeStdout(message)
      return message
    }
  }
  /* v8 ignore stop */

  // ── session list (local, no daemon socket needed) ──
  if (command.kind === "session.list") {
    /* v8 ignore start -- production default: requires full identity setup @preserve */
    const scanner = deps.scanSessions ?? (async () => [] as SessionEntry[])
    /* v8 ignore stop */
    const sessions = await scanner()
    if (sessions.length === 0) {
      const message = "no active sessions"
      deps.writeStdout(message)
      return message
    }
    const lines = sessions.map((s) =>
      `${s.friendId}  ${s.friendName}  ${s.channel}  ${s.lastActivity}`,
    )
    const message = lines.join("\n")
    deps.writeStdout(message)
    return message
  }

  if (command.kind === "chat.connect" && deps.startChat) {
    await ensureDaemonRunning(deps)
    await deps.startChat(command.agent)
    return ""
  }

  if (command.kind === "hatch.start") {
    // Route through adoption specialist when no explicit hatch args were provided
    const hasExplicitHatchArgs = !!(command.agentName || command.humanName || command.provider || command.credentials)
    if (deps.runAdoptionSpecialist && !hasExplicitHatchArgs) {
      // System setup first — ouro command, subagents, UTI — before the interactive specialist
      await performSystemSetup(deps)

      const hatchlingName = await deps.runAdoptionSpecialist()
      if (!hatchlingName) {
        return ""
      }

      await ensureDaemonRunning(deps)

      if (deps.startChat) {
        await deps.startChat(hatchlingName)
      }
      return ""
    }

    const hatchRunner = deps.runHatchFlow
    if (!hatchRunner) {
      const response = await deps.sendCommand(deps.socketPath, { kind: "hatch.start" })
      const message = response.summary ?? response.message ?? (response.ok ? "ok" : `error: ${response.error ?? "unknown error"}`)
      deps.writeStdout(message)
      return message
    }

    const hatchInput = await resolveHatchInput(command, deps)
    const result = await hatchRunner(hatchInput)

    await performSystemSetup(deps)

    const daemonResult = await ensureDaemonRunning(deps)

    if (deps.startChat) {
      await deps.startChat(hatchInput.agentName)
      return ""
    }

    const message = `hatched ${hatchInput.agentName} at ${result.bundleRoot} using specialist identity ${result.selectedIdentity}; ${daemonResult.message}`
    deps.writeStdout(message)
    return message
  }

  const daemonCommand = toDaemonCommand(command)
  let response: DaemonResponse
  try {
    response = await deps.sendCommand(deps.socketPath, daemonCommand)
  } catch (error) {
    if (command.kind === "message.send") {
      const pendingPath = deps.fallbackPendingMessage(command)
      const message = `daemon unavailable; queued message fallback at ${pendingPath}`
      deps.writeStdout(message)
      return message
    }
    if (command.kind === "daemon.status" && isDaemonUnavailableError(error)) {
      const message = daemonUnavailableStatusOutput(deps.socketPath, deps.healthFilePath)
      deps.writeStdout(message)
      return message
    }
    if (command.kind === "daemon.stop" && isDaemonUnavailableError(error)) {
      const message = "daemon not running"
      deps.writeStdout(message)
      return message
    }
    throw error
  }
  const fallbackMessage = response.summary ?? response.message ?? (response.ok ? "ok" : `error: ${response.error ?? "unknown error"}`)
  const message = command.kind === "daemon.status"
    ? formatDaemonStatusOutput(response, fallbackMessage)
    : fallbackMessage
  deps.writeStdout(message)
  return message
}
