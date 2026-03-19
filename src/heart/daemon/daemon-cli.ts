import { execSync, spawn } from "child_process"
import { randomUUID } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { getAgentBundlesRoot, getAgentDaemonLogsDir, getAgentName, getAgentRoot, getRepoRoot, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { FileFriendStore } from "../../mind/friends/store-file"
import type { FriendStore } from "../../mind/friends/store"
import { isIdentityProvider, type IdentityProvider, type TrustLevel } from "../../mind/friends/types"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import { registerOuroBundleUti as defaultRegisterOuroBundleUti } from "./ouro-uti"
import { installOuroCommand as defaultInstallOuroCommand, type OuroPathInstallResult } from "./ouro-path-installer"
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
import { getChangelogPath, getPackageVersion } from "../../mind/bundle-manifest"
import { getTaskModule } from "../../repertoire/tasks"
import { parseInnerDialogSession, formatThoughtTurns, getInnerDialogSessionPath, followThoughts } from "./thoughts"
import type { TaskModule } from "../../repertoire/tasks/types"
import { syncGlobalOuroBotWrapper as defaultSyncGlobalOuroBotWrapper } from "./ouro-bot-global-installer"
import { installLaunchAgent, type LaunchdDeps } from "./launchd"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand, checkDaemonSocketAlive } from "./socket-client"
import { listSessionActivity } from "../session-activity"
import {
  resolveHatchCredentials,
  readAgentConfigForAgent,
  runRuntimeAuthFlow as defaultRunRuntimeAuthFlow,
  writeAgentProviderSelection,
  type RuntimeAuthInput,
  type RuntimeAuthResult,
} from "./auth-flow"

export type OuroCliCommand =
  | { kind: "daemon.up" }
  | { kind: "daemon.stop" }
  | { kind: "daemon.status" }
  | { kind: "daemon.logs" }
  | { kind: "auth.run"; agent: string; provider?: AgentProvider }
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
  | { kind: "whoami"; agent?: string }
  | { kind: "session.list"; agent?: string }
  | { kind: "thoughts"; agent?: string; last?: number; json?: boolean; follow?: boolean }
  | { kind: "reminder.create"; title: string; body: string; scheduledAt?: string; cadence?: string; category?: string; requester?: string; agent?: string }
  | { kind: "friend.list"; agent?: string }
  | { kind: "friend.show"; friendId: string; agent?: string }
  | { kind: "friend.create"; name: string; trustLevel?: string; agent?: string }
  | { kind: "friend.link"; agent: string; friendId: string; provider: IdentityProvider; externalId: string }
  | { kind: "friend.unlink"; agent: string; friendId: string; provider: IdentityProvider; externalId: string }
  | { kind: "changelog"; from?: string; agent?: string }
  | { kind: "mcp.list" }
  | { kind: "mcp.call"; server: string; tool: string; args?: string }
  | { kind: "hatch.start"; agentName?: string; humanName?: string; provider?: AgentProvider; credentials?: HatchCredentialsInput; migrationPath?: string }

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
  const renderRow = (row: string[]) => `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`
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
  const workerRows = payload.workers.map((row) => [
    row.agent,
    row.worker,
    row.status,
    row.pid === null ? "n/a" : String(row.pid),
    String(row.restartCount),
  ])

  return [
    "Overview",
    formatTable(["Item", "Value"], overviewRows),
    "",
    "Senses",
    formatTable(["Agent", "Sense", "Enabled", "State", "Detail"], senseRows),
    "",
    "Workers",
    formatTable(["Agent", "Worker", "State", "PID", "Restarts"], workerRows),
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
    "  ouro stop|down|status|logs|hatch",
    "  ouro -v|--version",
    "  ouro auth --agent <name> [--provider <provider>]",
    "  ouro chat <agent>",
    "  ouro msg --to <agent> [--session <id>] [--task <ref>] <message>",
    "  ouro poke <agent> --task <task-id>",
    "  ouro link <agent> --friend <id> --provider <provider> --external-id <external-id>",
    "  ouro task board [<status>] [--agent <name>]",
    "  ouro task create <title> [--type <type>] [--agent <name>]",
    "  ouro task update <id> <status> [--agent <name>]",
    "  ouro task show <id> [--agent <name>]",
    "  ouro task actionable|deps|sessions [--agent <name>]",
    "  ouro reminder create <title> --body <body> [--at <iso>] [--cadence <interval>] [--category <category>] [--agent <name>]",
    "  ouro friend list [--agent <name>]",
    "  ouro friend show <id> [--agent <name>]",
    "  ouro friend create --name <name> [--trust <level>] [--agent <name>]",
    "  ouro thoughts [--last <n>] [--json] [--follow] [--agent <name>]",
    "  ouro friend link <agent> --friend <id> --provider <p> --external-id <eid>",
    "  ouro friend unlink <agent> --friend <id> --provider <p> --external-id <eid>",
    "  ouro whoami [--agent <name>]",
    "  ouro session list [--agent <name>]",
    "  ouro mcp list",
    "  ouro mcp call <server> <tool> [--args '{...}']",
  ].join("\n")
}

function formatVersionOutput(): string {
  return getRuntimeMetadata().version
}

function buildStoppedStatusPayload(socketPath: string): StatusPayload {
  const metadata = getRuntimeMetadata()
  const repoRoot = getRepoRoot()
  return {
    overview: {
      daemon: "stopped",
      health: "warn",
      socketPath,
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

function daemonUnavailableStatusOutput(socketPath: string): string {
  return [
    formatDaemonStatusOutput({
      ok: true,
      summary: "daemon not running",
      data: buildStoppedStatusPayload(socketPath),
    }, "daemon not running"),
    "",
    "daemon not running; run `ouro up`",
  ].join("\n")
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
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--task") {
      taskId = args[i + 1]
      i += 1
    }
  }

  if (!taskId) throw new Error(`Usage\n${usage()}`)
  return { kind: "task.poke", agent, taskId }
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
  return value === "azure" || value === "anthropic" || value === "minimax" || value === "openai-codex"
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
    throw new Error("Unknown provider. Use azure|anthropic|minimax|openai-codex.")
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

  throw new Error(`Usage\n${usage()}`)
}

function parseAuthCommand(args: string[]): OuroCliCommand {
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
  if (!agent) throw new Error(`Usage\n${usage()}`)
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

  if (sub === "link") return parseLinkCommand(rest, "friend.link")
  if (sub === "unlink") return parseLinkCommand(rest, "friend.unlink")

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

export function parseOuroCommand(args: string[]): OuroCliCommand {
  const [head, second] = args
  if (!head) return { kind: "daemon.up" }

  if (head === "up") return { kind: "daemon.up" }
  if (head === "stop" || head === "down") return { kind: "daemon.stop" }
  if (head === "status") return { kind: "daemon.status" }
  if (head === "logs") return { kind: "daemon.logs" }
  if (head === "hatch") return parseHatchCommand(args.slice(1))
  if (head === "auth") return parseAuthCommand(args.slice(1))
  if (head === "task") return parseTaskCommand(args.slice(1))
  if (head === "reminder") return parseReminderCommand(args.slice(1))
  if (head === "friend") return parseFriendCommand(args.slice(1))
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
  if (head === "chat") {
    if (!second) throw new Error(`Usage\n${usage()}`)
    return { kind: "chat.connect", agent: second }
  }
  if (head === "msg") return parseMessageCommand(args.slice(1))
  if (head === "poke") return parsePokeCommand(args.slice(1))
  if (head === "link") return parseLinkCommand(args.slice(1))

  throw new Error(`Unknown command '${args.join(" ")}'.\n${usage()}`)
}

function defaultStartDaemonProcess(socketPath: string): Promise<{ pid: number | null }> {
  const entry = path.join(getRepoRoot(), "dist", "heart", "daemon", "daemon-entry.js")
  const child = spawn("node", [entry, "--socket", socketPath], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  return Promise.resolve({ pid: child.pid ?? null })
}

function defaultWriteStdout(text: string): void {
  // eslint-disable-next-line no-console -- terminal UX: CLI command output
  console.log(text)
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
      minimax: "MiniMax-Text-01",
      "openai-codex": "gpt-5.4",
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
        const pRaw = await coldPrompt("provider (anthropic/azure/minimax/openai-codex): ")
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
      const pRaw = await coldPrompt("provider (anthropic/azure/minimax/openai-codex): ")
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

    setAgentConfigOverride({
      version: 1,
      enabled: true,
      provider: providerRaw,
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
    syncGlobalOuroBotWrapper: defaultSyncGlobalOuroBotWrapper,
    ensureSkillManagement: defaultEnsureSkillManagement,
    ensureDaemonBootPersistence: defaultEnsureDaemonBootPersistence,
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
type ChangelogCliCommand = Extract<OuroCliCommand, { kind: "changelog" }>
function toDaemonCommand(command: Exclude<OuroCliCommand, { kind: "daemon.up" } | { kind: "hatch.start" } | AuthCliCommand | TaskCliCommand | ReminderCliCommand | FriendCliCommand | WhoamiCliCommand | SessionCliCommand | ThoughtsCliCommand | ChangelogCliCommand>): DaemonCommand {
  return command
}

async function resolveHatchInput(command: Extract<OuroCliCommand, { kind: "hatch.start" }>, deps: OuroCliDeps): Promise<HatchFlowInput> {
  const prompt = deps.promptInput
  const agentName = command.agentName ?? (prompt ? await prompt("Hatchling name: ") : "")
  const humanName = command.humanName ?? (prompt ? await prompt("Your name: ") : os.userInfo().username)
  const providerRaw = command.provider ?? (prompt ? await prompt("Provider (azure|anthropic|minimax|openai-codex): ") : "")

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
      deps.installOuroCommand()
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
>

type ReminderCliCommand = Extract<OuroCliCommand, { kind: "reminder.create" }>
type FriendCliCommand = Extract<OuroCliCommand, { kind: "friend.list" } | { kind: "friend.show" } | { kind: "friend.create" } | { kind: "friend.link" } | { kind: "friend.unlink" }>
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
      type: command.cadence ? "habit" : "one-shot",
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

export async function runOuroCli(args: string[], deps: OuroCliDeps = createDefaultOuroCliDeps()): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
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
    await performSystemSetup(deps)

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

    // Run update hooks before starting daemon so user sees the output
    registerUpdateHook(bundleMetaHook)
    const bundlesRoot = getAgentBundlesRoot()
    const currentVersion = getPackageVersion()
    const updateSummary = await applyPendingUpdates(bundlesRoot, currentVersion)

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
    return daemonResult.message
  }

  if (command.kind === "daemon.logs" && deps.tailLogs) {
    deps.tailLogs()
    return ""
  }

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
      command.kind === "task.sessions") {
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

  // ── friend subcommands (local, no daemon socket needed) ──
  if (command.kind === "friend.list" || command.kind === "friend.show" || command.kind === "friend.create" ||
      command.kind === "friend.link" || command.kind === "friend.unlink") {
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
    const provider = command.provider ?? readAgentConfigForAgent(command.agent).config.provider
    const authRunner = deps.runAuthFlow ?? defaultRunRuntimeAuthFlow
    const result = await authRunner({
      agentName: command.agent,
      provider,
      promptInput: deps.promptInput,
    })
    if (command.provider) {
      writeAgentProviderSelection(command.agent, command.provider)
    }
    deps.writeStdout(result.message)
    return result.message
  }

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
      const entries = JSON.parse(raw) as Array<{ version: string; date?: string; changes?: string[] }>
      let filtered = entries
      if (command.from) {
        const fromVersion = command.from
        filtered = entries.filter((e) => e.version > fromVersion)
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
      const message = daemonUnavailableStatusOutput(deps.socketPath)
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
