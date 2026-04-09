/**
 * CLI command execution — the core runOuroCli function and its helpers.
 *
 * This is the junction box: it routes parsed commands to the appropriate
 * handler (local execution, daemon socket, or interactive flow).
 */

import { execSync, spawn } from "child_process"
import { randomUUID } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as semver from "semver"
import { getAgentBundlesRoot, getAgentName, getAgentRoot, getRepoRoot, PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { FileFriendStore } from "../../mind/friends/store-file"
import type { FriendStore } from "../../mind/friends/store"
import type { TrustLevel } from "../../mind/friends/types"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import { getRuntimeMetadata } from "./runtime-metadata"
import { detectRuntimeMode } from "./runtime-mode"
import { ensureCurrentDaemonRuntime } from "./daemon-runtime-sync"
import { applyPendingUpdates, registerUpdateHook } from "../versioning/update-hooks"
import { bundleMetaHook } from "./hooks/bundle-meta"
import { agentConfigV2Hook } from "./hooks/agent-config-v2"
import { getChangelogPath, getPackageVersion } from "../../mind/bundle-manifest"
import { getTaskModule } from "../../repertoire/tasks"
import { parseInnerDialogSession, formatThoughtTurns, getInnerDialogSessionPath, followThoughts } from "./thoughts"
import type { TaskModule } from "../../repertoire/tasks/types"
import { uninstallLaunchAgent, isDaemonInstalled, type LaunchdDeps } from "./launchd"
import {
  loadAgentSecrets,
  resolveHatchCredentials,
  readAgentConfigForAgent,
  writeAgentProviderSelection,
  writeAgentModel,
} from "../auth/auth-flow"
import { getOuroCliHome, buildChangelogCommand } from "../versioning/ouro-version-manager"

import type {
  OuroCliCommand,
  OuroCliDeps,
  EnsureDaemonResult,
  GithubCopilotModel,
  SessionEntry,
  TaskCliCommand,
  ReminderCliCommand,
  FriendCliCommand,
  AuthCliCommand,
  AuthVerifyCliCommand,
  AuthSwitchCliCommand,
  ChangelogCliCommand,
  ConfigModelCliCommand,
  ConfigModelsCliCommand,
  RollbackCliCommand,
  VersionsCliCommand,
  AttentionCliCommand,
  InnerStatusCliCommand,
  McpServeCliCommand,
  SetupCliCommand,
  HookCliCommand,
  HabitLocalCliCommand,
  WhoamiCliCommand,
  SessionCliCommand,
  ThoughtsCliCommand,
  DoctorCliCommand,
} from "./cli-types"
import { parseOuroCommand } from "./cli-parse"
import { isAgentProvider, usage } from "./cli-parse"
import {
  parseStatusPayload,
  formatDaemonStatusOutput,
  formatVersionOutput,
  daemonUnavailableStatusOutput,
  isDaemonUnavailableError,
  formatMcpResponse,
} from "./cli-render"
import { readFirstBundleMetaVersion, createDefaultOuroCliDeps, defaultListDiscoveredAgents } from "./cli-defaults"
import { runDoctorChecks } from "./doctor"
import { formatDoctorOutput } from "./cli-render-doctor"

// ── ensureDaemonRunning ──

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
      checkSocketAlive: deps.checkSocketAlive,
    })
  }

  deps.cleanupStaleSocket(deps.socketPath)
  const started = await deps.startDaemonProcess(deps.socketPath)
  const pid = started.pid ?? "unknown"

  // Verify the daemon actually comes up before reporting success
  const verified = await verifyDaemonAlive(deps.checkSocketAlive, deps.socketPath)

  /* v8 ignore start -- daemon liveness failure: requires real daemon crash timing @preserve */
  if (!verified) {
    return {
      alreadyRunning: false,
      message: `daemon spawned (pid ${pid}) but failed to respond within 10s — check \`ouro status\` or daemon logs`,
    }
  }
  /* v8 ignore stop */

  return {
    alreadyRunning: false,
    message: `daemon started (pid ${pid})`,
  }
}

/* v8 ignore start -- daemon liveness poll: real socket timing untestable in vitest @preserve */
async function verifyDaemonAlive(
  checkSocketAlive: (socketPath: string) => Promise<boolean>,
  socketPath: string,
  maxWaitMs = 10_000,
  pollIntervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    if (await checkSocketAlive(socketPath)) return true
  }
  return false
}
/* v8 ignore stop */

// ── GitHub Copilot model helpers ──

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

// ── Provider credential verification ──

/* v8 ignore next 3 -- only called from auth.switch inside integration block @preserve */
function hasStoredCredentials(provider: AgentProvider, providerSecrets: Record<string, unknown>): boolean {
  return PROVIDER_CREDENTIALS[provider].required.every((key) => !!providerSecrets[key])
}

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

// ── toDaemonCommand ──

function toDaemonCommand(command: Exclude<OuroCliCommand, { kind: "daemon.up" } | { kind: "daemon.dev" } | { kind: "daemon.logs.prune" } | { kind: "outlook" } | { kind: "hatch.start" } | AuthCliCommand | AuthVerifyCliCommand | AuthSwitchCliCommand | TaskCliCommand | ReminderCliCommand | FriendCliCommand | WhoamiCliCommand | SessionCliCommand | ThoughtsCliCommand | ChangelogCliCommand | ConfigModelCliCommand | ConfigModelsCliCommand | RollbackCliCommand | VersionsCliCommand | AttentionCliCommand | InnerStatusCliCommand | McpServeCliCommand | SetupCliCommand | HookCliCommand | HabitLocalCliCommand | DoctorCliCommand | { kind: "bluebubbles.replay" }>): DaemonCommand {
  return command
}

// ── Hatch input resolution ──

async function resolveHatchInput(command: Extract<OuroCliCommand, { kind: "hatch.start" }>, deps: OuroCliDeps): Promise<import("../hatch/hatch-flow").HatchFlowInput> {
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

// ── System setup ──

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

// ── Task command execution ──

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

// ── Friend command execution ──

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

// ── Reminder command execution ──

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

// ── Dev mode helpers ──

/* v8 ignore start -- repo resolution for ouro dev: repoPath branch tested via daemon-cli-dev; clone requires real git/npm @preserve */
function getDevConfigPath(): string {
  return path.join(getOuroCliHome(), "dev-config.json")
}

function readPersistedDevPath(): string | null {
  try {
    const raw = fs.readFileSync(getDevConfigPath(), "utf-8")
    const config = JSON.parse(raw) as { repoPath?: string }
    if (typeof config.repoPath === "string") return config.repoPath
  } catch { /* no persisted path */ }
  return null
}

function persistDevPath(repoPath: string): void {
  const configPath = getDevConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ repoPath }), "utf-8")
}

function resolveDevRepoCwd(
  command: Extract<OuroCliCommand, { kind: "daemon.dev" }>,
  checkExists: (p: string) => boolean,
  deps: OuroCliDeps,
): string {
  if (command.repoPath) {
    persistDevPath(command.repoPath)
    return command.repoPath
  }
  if (deps.getRepoCwd) return deps.getRepoCwd()
  const persisted = readPersistedDevPath()
  if (persisted && checkExists(path.join(persisted, ".git"))) {
    deps.writeStdout(`using persisted dev repo: ${persisted}`)
    return persisted
  }
  return getRepoRoot()
}

function resolveClonePath(
  options: { clonePath?: string },
  checkExists: (p: string) => boolean,
  deps: OuroCliDeps,
): string {
  const cloneTarget = options.clonePath ?? path.join(os.homedir(), "Projects", "ouroboros")
  if (checkExists(path.join(cloneTarget, ".git"))) {
    // Existing repo — pull latest and rebuild
    deps.writeStdout(`pulling latest in ${cloneTarget}...`)
    execSync("git pull", { cwd: cloneTarget, stdio: "inherit" })
    deps.writeStdout(`installing dependencies in ${cloneTarget}...`)
    execSync("npm install", { cwd: cloneTarget, stdio: "inherit" })
    persistDevPath(cloneTarget)
    return cloneTarget
  }

  // Fresh clone
  deps.writeStdout(`cloning ouroboros to ${cloneTarget}...`)
  const HARNESS_CANONICAL_REPO_URL = "https://github.com/ouroborosbot/ouroboros.git"
  fs.mkdirSync(path.dirname(cloneTarget), { recursive: true })
  execSync(`git clone ${HARNESS_CANONICAL_REPO_URL} "${cloneTarget}"`, { stdio: "inherit" })
  deps.writeStdout(`installing dependencies in ${cloneTarget}...`)
  execSync("npm install", { cwd: cloneTarget, stdio: "inherit" })
  deps.writeStdout(`building in ${cloneTarget}...`)
  try {
    execSync("npm run build", { cwd: cloneTarget, stdio: "inherit" })
  } catch {
    throw new Error(`build failed in ${cloneTarget}. check the output above.`)
  }
  return cloneTarget
}
/* v8 ignore stop */

// ── Main CLI execution ──

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
    if (discovered.length === 0 && deps.runSerpentGuide) {
      // System setup first — ouro command, subagents, UTI — before the interactive specialist
      await performSystemSetup(deps)

      const hatchlingName = await deps.runSerpentGuide()
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

  if (command.kind === "bluebubbles.replay") {
    const { replayBlueBubblesMessage, formatBlueBubblesReplayText } = await import("../../senses/bluebubbles/replay")
    const replay = await replayBlueBubblesMessage({
      agentName: command.agent,
      messageGuid: command.messageGuid,
      eventType: command.eventType,
    })
    const text = command.json
      ? JSON.stringify(replay, null, 2)
      : formatBlueBubblesReplayText(replay)
    deps.writeStdout(text)
    return text
  }

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

    // Track whether we've already printed the "ouro updated to" message
    // this turn so the bundle-meta-fallback path below doesn't double-print.
    // There are three independent paths that can detect "the binary just
    // got newer":
    //   1. checkForCliUpdate found a newer version on npm (above) — this
    //      path always re-execs, so the duplicate-detect runs in a
    //      different process and the in-process tracker doesn't apply.
    //   2. ensureCurrentVersionInstalled (called from performSystemSetup)
    //      flipped the CurrentVersion symlink because the running package
    //      version is newer than what the symlink pointed at. This is the
    //      common npx path.
    //   3. bundle-meta.json's stored runtime version differs from the
    //      running version (fallback for when path 2 couldn't activate
    //      but the binary is still newer).
    //
    // Verified live on 2026-04-08: npx download triggered both path 2 and
    // path 3 in the same process and the user saw the message printed twice.
    // Path 3's existing `linkedVersionBeforeUp !== currentVersion` guard
    // catches the cross-process re-exec case (path 1) but not the
    // in-process double-fire case (path 2 + path 3 in the same process).
    let printedUpdateMessage = false

    const linkedVersionAfterSetup = deps.getCurrentCliVersion?.() ?? null
    const runtimeVersion = getPackageVersion()
    if (linkedVersionBeforeUp && linkedVersionBeforeUp !== runtimeVersion && linkedVersionAfterSetup === runtimeVersion) {
      deps.writeStdout(`ouro updated to ${runtimeVersion} (was ${linkedVersionBeforeUp})`)
      const changelogCommand = buildChangelogCommand(linkedVersionBeforeUp, runtimeVersion)
      if (changelogCommand) {
        deps.writeStdout(`review changes with: ${changelogCommand}`)
      }
      printedUpdateMessage = true
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
    // printed the update message before re-exec. Also skip when path 2
    // (the symlink-flip detector above) already printed in this same
    // process — otherwise npx invocations print the message twice.
    /* v8 ignore start -- CLI update detection: tested via daemon-cli-version-detect.test.ts @preserve */
    if (
      !printedUpdateMessage
      && previousCliVersion
      && previousCliVersion !== currentVersion
      && linkedVersionBeforeUp !== currentVersion
    ) {
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
    const startDevDaemon = deps.startDaemonProcess === (await import("./cli-defaults")).defaultStartDaemonProcess
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

  if (command.kind === "daemon.logs.prune") {
    if (!deps.pruneDaemonLogs) {
      const message = "logs prune unavailable (dep not wired)"
      deps.writeStdout(message)
      return message
    }
    const result = deps.pruneDaemonLogs()
    const message = `compacted ${result.filesCompacted} file${result.filesCompacted === 1 ? "" : "s"}, freed ${result.bytesFreed} bytes`
    deps.writeStdout(message)
    return message
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

    // Send to the specific agent configured for this hook. Short-circuit
    // when the daemon socket file doesn't exist — otherwise every
    // Claude Code lifecycle event during a daemon-down window logs two
    // ENOENT errors in ouro.ndjson (one for message.send, one for
    // inner.wake) which makes it hard to read the log around outages.
    // The hook is best-effort: dropping notifications when the daemon
    // is down is the correct behavior; we just don't want to log spam
    // about it.
    if (require("fs").existsSync(deps.socketPath)) {
      try {
        await deps.sendCommand(deps.socketPath, { kind: "message.send", from: `claude-code:${sessionId}`, to: command.agent, content } as DaemonCommand).catch(() => {})
        await deps.sendCommand(deps.socketPath, { kind: "inner.wake", agent: command.agent } as DaemonCommand).catch(() => {})
      } catch { /* daemon not running — silent */ }
    } else {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.hook_skipped_no_socket",
        message: "claude code hook skipped — daemon socket missing",
        meta: { socketPath: deps.socketPath, eventType, agent: command.agent },
      })
    }

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
    const { createMcpServer } = await import("../mcp/mcp-server")
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
    const { parseHabitFile, renderHabitFile } = await import("../habits/habit-parser")
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
        const fileContent = fs.readFileSync(path.join(habitsDir, file), "utf-8")
        const habit = parseHabitFile(fileContent, path.join(habitsDir, file))
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
    const habitContent = renderHabitFile(
      {
        title: command.name,
        cadence: command.cadence ?? "null",
        status: "active",
        lastRun: now,
        created: now,
      },
      `Habit: ${command.name}`,
    )
    fs.writeFileSync(filePath, habitContent, "utf-8")
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
    const provider = command.provider ?? readAgentConfigForAgent(command.agent, deps.bundlesRoot).config.humanFacing.provider
    /* v8 ignore next -- tests always inject runAuthFlow; default is for production @preserve */
    const authRunner = deps.runAuthFlow ?? (await import("../auth/auth-flow")).runRuntimeAuthFlow
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
      const { secrets } = loadAgentSecrets(command.agent, { secretsRoot: deps.secretsRoot })
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
    const { secrets } = loadAgentSecrets(command.agent, { secretsRoot: deps.secretsRoot })
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
    const { secrets } = loadAgentSecrets(command.agent, { secretsRoot: deps.secretsRoot })
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
      writeAgentProviderSelection(command.agent, command.facing, command.provider, deps.bundlesRoot)
    } else {
      writeAgentProviderSelection(command.agent, "human", command.provider, deps.bundlesRoot)
      writeAgentProviderSelection(command.agent, "agent", command.provider, deps.bundlesRoot)
    }
    const message = `switched ${command.agent} to ${command.provider} (verified working)`
    deps.writeStdout(message)
    return message
  }
  /* v8 ignore stop */

  // ── config models (local, no daemon socket needed) ──
  /* v8 ignore start -- config models: tested via daemon-cli.test.ts @preserve */
  if (command.kind === "config.models") {
    const { config } = readAgentConfigForAgent(command.agent, deps.bundlesRoot)
    const provider = config.humanFacing.provider
    if (provider !== "github-copilot") {
      const message = `model listing not available for ${provider} — check provider documentation.`
      deps.writeStdout(message)
      return message
    }
    const { secrets } = loadAgentSecrets(command.agent, { secretsRoot: deps.secretsRoot })
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
    const { config } = readAgentConfigForAgent(command.agent, deps.bundlesRoot)
    const facingConfig = facing === "human" ? config.humanFacing : config.agentFacing
    if (facingConfig.provider === "github-copilot") {
      const { secrets } = loadAgentSecrets(command.agent, { secretsRoot: deps.secretsRoot })
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
    const { provider, previousModel } = writeAgentModel(command.agent, facing, command.modelName, { bundlesRoot: deps.bundlesRoot })
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
      /* v8 ignore next -- production fallback: tests always inject bundlesRoot via createTmpBundle @preserve */
      const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
      const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
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
      const { listActiveReturnObligations, readReturnObligation } = await import("../../arc/obligations")

      if (command.kind === "attention.list") {
        const obligations = listActiveReturnObligations(agentName)
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
        const obligation = readReturnObligation(agentName, (command as Extract<OuroCliCommand, { kind: "attention.show" }>).id)
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
      const { getReturnObligationsDir } = await import("../../arc/obligations")
      const obligationsDir = getReturnObligationsDir(agentName)
      let attEntries: string[] = []
      try { attEntries = fs.readdirSync(obligationsDir) } catch { /* empty */ }
      const returned = attEntries
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
      const { listActiveReturnObligations } = await import("../../arc/obligations")

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
        const journalEntries = fs.readdirSync(journalDir, { withFileTypes: true })
        journalFiles = journalEntries
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
          const heartbeatContent = fs.readFileSync(heartbeatPath, "utf-8")
          const lines = heartbeatContent.split(/\r?\n/)
          if (lines[0]?.trim() === "---") {
            const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
            if (closing !== -1) {
              const rawFrontmatter = lines.slice(1, closing).join("\n")
              const frontmatter = parseFrontmatter(rawFrontmatter)
              const parsedCadence = parseCadenceMs(frontmatter.cadence)
              if (parsedCadence !== null) cadenceMs = parsedCadence
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
      const activeObligations = listActiveReturnObligations(agentName)

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
    let agent = command.agent
    // No agent specified — show selection
    /* v8 ignore start -- interactive agent selection: requires real promptInput + discovered agents @preserve */
    if (!agent) {
      const discovered = await Promise.resolve(
        deps.listDiscoveredAgents ? deps.listDiscoveredAgents() : defaultListDiscoveredAgents(),
      )
      if (discovered.length === 0) {
        deps.writeStdout("no agents found — run `ouro` to hatch one")
        return "no agents found"
      }
      if (discovered.length === 1) {
        agent = discovered[0]
      } else if (deps.promptInput) {
        const prompt = `who do you want to talk to?\n${discovered.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n`
        const answer = await deps.promptInput(prompt)
        agent = discovered.includes(answer) ? answer : discovered[parseInt(answer, 10) - 1]
        if (!agent) {
          deps.writeStdout("invalid selection")
          return "invalid selection"
        }
      } else {
        const message = `who do you want to talk to? ${discovered.join(", ")} (use: ouro chat <agent>)`
        deps.writeStdout(message)
        return message
      }
    }
    /* v8 ignore stop */
    await ensureDaemonRunning(deps)
    await deps.startChat(agent)
    return ""
  }

  if (command.kind === "hatch.start") {
    // Route through serpent guide when no explicit hatch args were provided
    const hasExplicitHatchArgs = !!(command.agentName || command.humanName || command.provider || command.credentials)
    if (deps.runSerpentGuide && !hasExplicitHatchArgs) {
      // System setup first — ouro command, subagents, UTI — before the interactive specialist
      await performSystemSetup(deps)

      const hatchlingName = await deps.runSerpentGuide()
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

  // ── doctor (local, no daemon socket needed) ──
  if (command.kind === "doctor") {
    const doctorDeps = {
      /* v8 ignore next 4 -- thin fs wrappers tested via doctor.test.ts with injected deps @preserve */
      existsSync: (p: string) => fs.existsSync(p),
      readFileSync: (p: string) => fs.readFileSync(p, "utf-8"),
      readdirSync: (p: string) => fs.readdirSync(p),
      statSync: (p: string) => fs.statSync(p),
      checkSocketAlive: deps.checkSocketAlive,
      socketPath: deps.socketPath,
      bundlesRoot: deps.bundlesRoot ?? getAgentBundlesRoot(),
      secretsRoot: deps.secretsRoot ?? path.join(os.homedir(), ".agentsecrets"),
      homedir: os.homedir(),
    }
    const doctorResult = await runDoctorChecks(doctorDeps)
    const output = formatDoctorOutput(doctorResult)
    deps.writeStdout(output)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.doctor_run",
      message: "ouro doctor completed",
      meta: { passed: doctorResult.summary.passed, warnings: doctorResult.summary.warnings, failed: doctorResult.summary.failed },
    })
    return output
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
