import { spawn } from "child_process"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { getAgentBundlesRoot, getRepoRoot, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { FileFriendStore } from "../../mind/friends/store-file"
import { isIdentityProvider, type IdentityProvider } from "../../mind/friends/types"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import { registerOuroBundleUti as defaultRegisterOuroBundleUti } from "./ouro-uti"
import { installOuroCommand as defaultInstallOuroCommand, type OuroPathInstallResult } from "./ouro-path-installer"
import { installSubagentsForAvailableCli, type SubagentInstallResult } from "./subagent-installer"
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

export type OuroCliCommand =
  | { kind: "daemon.up" }
  | { kind: "daemon.stop" }
  | { kind: "daemon.status" }
  | { kind: "daemon.logs" }
  | { kind: "chat.connect"; agent: string }
  | { kind: "message.send"; from: string; to: string; content: string; sessionId?: string; taskRef?: string }
  | { kind: "task.poke"; agent: string; taskId: string }
  | { kind: "friend.link"; agent: string; friendId: string; provider: IdentityProvider; externalId: string }
  | { kind: "hatch.start"; agentName?: string; humanName?: string; provider?: AgentProvider; credentials?: HatchCredentialsInput; migrationPath?: string }

export interface OuroCliDeps {
  socketPath: string
  sendCommand: (socketPath: string, command: DaemonCommand) => Promise<DaemonResponse>
  startDaemonProcess: (socketPath: string) => Promise<{ pid: number | null }>
  writeStdout: (text: string) => void
  checkSocketAlive: (socketPath: string) => Promise<boolean>
  cleanupStaleSocket: (socketPath: string) => void
  fallbackPendingMessage: (command: Extract<DaemonCommand, { kind: "message.send" }>) => string
  installSubagents: () => Promise<SubagentInstallResult>
  linkFriendIdentity?: (command: Extract<OuroCliCommand, { kind: "friend.link" }>) => Promise<string>
  listDiscoveredAgents?: () => Promise<string[]> | string[]
  runHatchFlow?: (input: HatchFlowInput) => Promise<HatchFlowResult>
  runAdoptionSpecialist?: () => Promise<string | null>
  promptInput?: (question: string) => Promise<string>
  registerOuroBundleType?: () => Promise<unknown> | unknown
  installOuroCommand?: () => OuroPathInstallResult
  startChat?: (agentName: string) => Promise<void>
  tailLogs?: (options?: { follow?: boolean; lines?: number; agentFilter?: string }) => () => void
}

export interface EnsureDaemonResult {
  alreadyRunning: boolean
  message: string
}

interface StatusOverviewRow {
  daemon: string
  health: string
  socketPath: string
  workerCount: number
  senseCount: number
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
    workerCount: numberField((overview as Record<string, unknown>).workerCount) ?? 0,
    senseCount: numberField((overview as Record<string, unknown>).senseCount) ?? 0,
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
    return {
      alreadyRunning: true,
      message: `daemon already running (${deps.socketPath})`,
    }
  }

  deps.cleanupStaleSocket(deps.socketPath)
  const started = await deps.startDaemonProcess(deps.socketPath)
  return {
    alreadyRunning: false,
    message: `daemon started (pid ${started.pid ?? "unknown"})`,
  }
}

function usage(): string {
  return [
    "Usage:",
    "  ouro [up]",
    "  ouro stop|status|logs|hatch",
    "  ouro chat <agent>",
    "  ouro msg --to <agent> [--session <id>] [--task <ref>] <message>",
    "  ouro poke <agent> --task <task-id>",
    "  ouro link <agent> --friend <id> --provider <provider> --external-id <external-id>",
  ].join("\n")
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

function parseLinkCommand(args: string[]): OuroCliCommand {
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
    kind: "friend.link",
    agent,
    friendId,
    provider: providerRaw,
    externalId,
  }
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

export function parseOuroCommand(args: string[]): OuroCliCommand {
  const [head, second] = args
  if (!head) return { kind: "daemon.up" }

  if (head === "up") return { kind: "daemon.up" }
  if (head === "stop") return { kind: "daemon.stop" }
  if (head === "status") return { kind: "daemon.status" }
  if (head === "logs") return { kind: "daemon.logs" }
  if (head === "hatch") return parseHatchCommand(args.slice(1))
  if (head === "chat") {
    if (!second) throw new Error(`Usage\n${usage()}`)
    return { kind: "chat.connect", agent: second }
  }
  if (head === "msg") return parseMessageCommand(args.slice(1))
  if (head === "poke") return parsePokeCommand(args.slice(1))
  if (head === "link") return parseLinkCommand(args.slice(1))

  throw new Error(`Unknown command '${args.join(" ")}'.\n${usage()}`)
}

function defaultSendCommand(socketPath: string, command: DaemonCommand): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    let raw = ""

    client.on("connect", () => {
      client.write(JSON.stringify(command))
      client.end()
    })
    client.on("data", (chunk) => {
      raw += chunk.toString("utf-8")
    })
    client.on("error", reject)
    client.on("end", () => {
      const trimmed = raw.trim()
      if (trimmed.length === 0 && command.kind === "daemon.stop") {
        resolve({ ok: true, message: "daemon stopped" })
        return
      }
      if (trimmed.length === 0) {
        reject(new Error("Daemon returned empty response."))
        return
      }
      try {
        const parsed = JSON.parse(trimmed) as DaemonResponse
        resolve(parsed)
      } catch (error) {
        reject(error)
      }
    })
  })
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

function defaultCheckSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath)
    let raw = ""
    let done = false

    const finalize = (alive: boolean) => {
      if (done) return
      done = true
      resolve(alive)
    }

    if ("setTimeout" in client && typeof client.setTimeout === "function") {
      client.setTimeout(800, () => {
        client.destroy()
        finalize(false)
      })
    }

    client.on("connect", () => {
      client.write(JSON.stringify({ kind: "daemon.status" } satisfies DaemonCommand))
      client.end()
    })
    client.on("data", (chunk) => {
      raw += chunk.toString("utf-8")
    })
    client.on("error", () => finalize(false))
    client.on("end", () => {
      if (raw.trim().length === 0) {
        finalize(false)
        return
      }
      try {
        JSON.parse(raw)
        finalize(true)
      } catch {
        finalize(false)
      }
    })
  })
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

async function defaultInstallSubagents(): Promise<SubagentInstallResult> {
  return installSubagentsForAvailableCli({
    repoRoot: getRepoRoot(),
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
  const bundlesRoot = getAgentBundlesRoot()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(bundlesRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const discovered: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue
    const agentName = entry.name.slice(0, -5)
    const configPath = path.join(bundlesRoot, entry.name, "agent.json")
    let enabled = true
    try {
      const raw = fs.readFileSync(configPath, "utf-8")
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

async function defaultLinkFriendIdentity(command: Extract<OuroCliCommand, { kind: "friend.link" }>): Promise<string> {
  const fp = path.join(getAgentBundlesRoot(), `${command.agent}.ouro`, "friends")
  const friendStore = new FileFriendStore(fp)
  const current = await friendStore.get(command.friendId)
  if (!current) {
    return `friend not found: ${command.friendId}`
  }

  const alreadyLinked = current.externalIds.some(
    (ext) => ext.provider === command.provider && ext.externalId === command.externalId,
  )
  if (alreadyLinked) {
    return `identity already linked: ${command.provider}:${command.externalId}`
  }

  const now = new Date().toISOString()
  await friendStore.put(command.friendId, {
    ...current,
    externalIds: [
      ...current.externalIds,
      {
        provider: command.provider,
        externalId: command.externalId,
        linkedAt: now,
      },
    ],
    updatedAt: now,
  })

  return `linked ${command.provider}:${command.externalId} to ${command.friendId}`
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

export function createDefaultOuroCliDeps(socketPath = "/tmp/ouroboros-daemon.sock"): OuroCliDeps {
  return {
    socketPath,
    sendCommand: defaultSendCommand,
    startDaemonProcess: defaultStartDaemonProcess,
    writeStdout: defaultWriteStdout,
    checkSocketAlive: defaultCheckSocketAlive,
    cleanupStaleSocket: defaultCleanupStaleSocket,
    fallbackPendingMessage: defaultFallbackPendingMessage,
    installSubagents: defaultInstallSubagents,
    linkFriendIdentity: defaultLinkFriendIdentity,
    listDiscoveredAgents: defaultListDiscoveredAgents,
    runHatchFlow: defaultRunHatchFlow,
    promptInput: defaultPromptInput,
    runAdoptionSpecialist: defaultRunAdoptionSpecialist,
    registerOuroBundleType: defaultRegisterOuroBundleUti,
    installOuroCommand: defaultInstallOuroCommand,
    /* v8 ignore next 3 -- integration: launches interactive CLI session @preserve */
    startChat: async (agentName: string) => {
      const { main } = await import("../../senses/cli")
      await main(agentName)
    },
  }
}

function toDaemonCommand(command: Exclude<OuroCliCommand, { kind: "daemon.up" } | { kind: "friend.link" } | { kind: "hatch.start" }>): DaemonCommand {
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

  const credentials: HatchCredentialsInput = { ...(command.credentials ?? {}) }
  if (providerRaw === "anthropic" && !credentials.setupToken && prompt) {
    credentials.setupToken = await prompt("Anthropic setup-token: ")
  }
  if (providerRaw === "openai-codex" && !credentials.oauthAccessToken && prompt) {
    credentials.oauthAccessToken = await prompt("OpenAI Codex OAuth token: ")
  }
  if (providerRaw === "minimax" && !credentials.apiKey && prompt) {
    credentials.apiKey = await prompt("MiniMax API key: ")
  }
  if (providerRaw === "azure") {
    if (!credentials.apiKey && prompt) credentials.apiKey = await prompt("Azure API key: ")
    if (!credentials.endpoint && prompt) credentials.endpoint = await prompt("Azure endpoint: ")
    if (!credentials.deployment && prompt) credentials.deployment = await prompt("Azure deployment: ")
  }

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

  // Install subagents (claude/codex skills)
  try {
    await deps.installSubagents()
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.subagent_install_error",
      message: "subagent auto-install failed",
      meta: { error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error) },
    })
  }

  // Register .ouro bundle type (UTI on macOS)
  await registerOuroBundleTypeNonBlocking(deps)
}

export async function runOuroCli(args: string[], deps: OuroCliDeps = createDefaultOuroCliDeps()): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    const text = usage()
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

    const daemonResult = await ensureDaemonRunning(deps)
    deps.writeStdout(daemonResult.message)
    return daemonResult.message
  }

  if (command.kind === "daemon.logs" && deps.tailLogs) {
    deps.tailLogs()
    return ""
  }

  if (command.kind === "friend.link") {
    const linker = deps.linkFriendIdentity ?? defaultLinkFriendIdentity
    const message = await linker(command)
    deps.writeStdout(message)
    return message
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
    throw error
  }
  const fallbackMessage = response.summary ?? response.message ?? (response.ok ? "ok" : `error: ${response.error ?? "unknown error"}`)
  const message = command.kind === "daemon.status"
    ? formatDaemonStatusOutput(response, fallbackMessage)
    : fallbackMessage
  deps.writeStdout(message)
  return message
}
