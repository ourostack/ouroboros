/**
 * CLI command execution — the core runOuroCli function and its helpers.
 *
 * This is the junction box: it routes parsed commands to the appropriate
 * handler (local execution, daemon socket, or interactive flow).
 */

import { execFileSync, execSync, spawn } from "child_process"
import { randomUUID } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as semver from "semver"
import { getAgentBundlesRoot, getAgentName, getAgentRoot, getRepoRoot, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { FileFriendStore } from "../../mind/friends/store-file"
import type { FriendStore } from "../../mind/friends/store"
import type { TrustLevel } from "../../mind/friends/types"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import { getRuntimeMetadata } from "./runtime-metadata"
import { detectRuntimeMode } from "./runtime-mode"
import { detectPlatform } from "../platform"
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
} from "../auth/auth-flow"
import {
  providerCredentialHomeDirFromSecretsRoot,
  readProviderCredentialPool,
  readLegacyAgentProviderCredentials,
  splitProviderCredentialFields,
  upsertProviderCredential,
  type ProviderCredentialRecord,
} from "../provider-credential-pool"
import { resolveEffectiveProviderBinding, type EffectiveProviderCredentialStatus } from "../provider-binding-resolver"
import { bootstrapProviderStateFromAgentConfig, readProviderState, writeProviderState, type ProviderLane, type ProviderState } from "../provider-state"
import { loadOrCreateMachineIdentity } from "../machine-identity"
import { getDefaultModelForProvider } from "../provider-models"
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
  ProviderCliCommand,
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
  CloneCliCommand,
  DoctorCliCommand,
  HelpCliCommand,
} from "./cli-types"
import { parseOuroCommand, inferAgentNameFromRemote } from "./cli-parse"
import { isAgentProvider, usage } from "./cli-parse"
import { getGroupedHelp, getCommandHelp } from "./cli-help"
import {
  parseStatusPayload,
  formatDaemonStatusOutput,
  formatVersionOutput,
  daemonUnavailableStatusOutput,
  isDaemonUnavailableError,
  formatMcpResponse,
} from "./cli-render"
import { readFirstBundleMetaVersion, createDefaultOuroCliDeps, defaultListDiscoveredAgents } from "./cli-defaults"
import { checkAgentConfigWithProviderHealth } from "./agent-config-check"
import { runDoctorChecks } from "./doctor"
import { formatDoctorOutput } from "./cli-render-doctor"
import { runInteractiveRepair } from "./interactive-repair"
import { createAgenticDiagnosisProviderRuntime, runAgenticRepair } from "./agentic-repair"
import { pollDaemonStartup } from "./startup-tui"
import { pruneStaleEphemeralBundles } from "./stale-bundle-prune"
import { UpProgress } from "./up-progress"
import { pingGithubCopilotModel, pingProvider, type PingResult } from "../provider-ping"

// ── ensureDaemonRunning ──

const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_DAEMON_STARTUP_POLL_INTERVAL_MS = 500
const DEFAULT_DAEMON_STARTUP_STABILITY_WINDOW_MS = 1_500
const DEFAULT_DAEMON_STARTUP_RETRY_LIMIT = 1
const DEFAULT_DAEMON_STARTUP_LOG_LINES = 10

async function checkAlreadyRunningAgentProviders(deps: OuroCliDeps): Promise<Array<{ agent: string; errorReason: string; fixHint: string }>> {
  const agents = await Promise.resolve(
    deps.listDiscoveredAgents ? deps.listDiscoveredAgents() : defaultListDiscoveredAgents(),
  )
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  const secretsRoot = deps.secretsRoot ?? path.join(os.homedir(), ".agentsecrets")
  const degraded: Array<{ agent: string; errorReason: string; fixHint: string }> = []

  for (const agent of agents) {
    try {
      const result = await checkAgentConfigWithProviderHealth(agent, bundlesRoot, secretsRoot)
      if (result.ok) continue
      const errorReason = result.error ?? "agent provider health check failed"
      const fixHint = result.fix ?? ""
      degraded.push({ agent, errorReason, fixHint })
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_config_invalid",
        message: errorReason,
        meta: { agent, fix: fixHint, source: "already-running-provider-check" },
      })
    } catch (error) {
      const errorReason = error instanceof Error ? error.message : String(error)
      degraded.push({
        agent,
        errorReason,
        fixHint: "Run 'ouro doctor' for diagnostics, then retry 'ouro up'.",
      })
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_config_invalid",
        message: errorReason,
        meta: { agent, fix: "ouro doctor", source: "already-running-provider-check" },
      })
    }
  }

  return degraded
}

async function checkProviderHealthBeforeChat(
  agentName: string,
  deps: OuroCliDeps,
): Promise<{ ok: true } | { ok: false; output: string }> {
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  const secretsRoot = deps.secretsRoot ?? path.join(os.homedir(), ".agentsecrets")
  const result = await checkAgentConfigWithProviderHealth(agentName, bundlesRoot, secretsRoot)
  if (!result.ok) {
    const output = `${result.error}\n${result.fix ? `      fix:   ${result.fix}` : ""}`
    deps.writeStdout(output)
    return { ok: false, output }
  }
  return { ok: true }
}

export function mergeStartupStability(
  stability: EnsureDaemonResult["stability"],
  extraDegraded: Array<{ agent: string; errorReason: string; fixHint: string }>,
): EnsureDaemonResult["stability"] {
  if (extraDegraded.length === 0) return stability
  const degradedByAgent = new Map<string, { agent: string; errorReason: string; fixHint: string }>()
  for (const entry of stability?.degraded ?? []) degradedByAgent.set(entry.agent, entry)
  for (const entry of extraDegraded) degradedByAgent.set(entry.agent, entry)
  const degraded = [...degradedByAgent.values()]
  const stable: string[] = []
  for (const agent of stability?.stable ?? []) {
    if (!degradedByAgent.has(agent)) stable.push(agent)
  }
  return { stable, degraded }
}

interface DaemonStartupFailure {
  reason: string
  retryable: boolean
}

export async function ensureDaemonRunning(deps: OuroCliDeps): Promise<EnsureDaemonResult> {
  const readLatestDaemonStartupEvent = () => {
    try {
      // The daemon writes structured events to daemon.ndjson in the first
      // agent bundle's state/daemon/logs/ directory. Read the last line to
      // surface what it's currently doing (e.g., "starting auto-start agents").
      const bundlesRoot = getAgentBundlesRoot()
      if (!fs.existsSync(bundlesRoot)) return null
      const agents = fs.readdirSync(bundlesRoot).filter((d) => d.endsWith(".ouro"))
      for (const agent of agents) {
        const logPath = path.join(bundlesRoot, agent, "state", "daemon", "logs", "daemon.ndjson")
        if (!fs.existsSync(logPath)) continue
        const stat = fs.statSync(logPath)
        if (stat.size === 0) continue
        // Only read logs from the last 30 seconds (daemon just started)
        const mtime = stat.mtimeMs
        if (Date.now() - mtime > 30_000) continue
        const buf = Buffer.alloc(4096)
        const fd = fs.openSync(logPath, "r")
        let bytesRead = 0
        try {
          const readFrom = Math.max(0, stat.size - 4096)
          bytesRead = fs.readSync(fd, buf, 0, 4096, readFrom)
        } finally {
          fs.closeSync(fd)
        }
        const lines = buf.subarray(0, bytesRead).toString("utf-8").trim().split("\n").filter(Boolean)
        const last = lines[lines.length - 1]
        if (!last) continue
        const parsed = JSON.parse(last)
        return parsed.message ?? null
      }
    } catch {
      // Best effort only.
    }
    return null
  }

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

    const runtimeResult = await ensureCurrentDaemonRuntime({
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
    if (!runtimeResult.verifyStartupStatus) {
      return runtimeResult
    }

    const stability = await pollDaemonStartup({
      sendCommand: deps.sendCommand,
      socketPath: deps.socketPath,
      daemonPid: runtimeResult.startedPid ?? null,
      /* v8 ignore next -- thin wrapper: raw process.stdout.write for ANSI cursor control @preserve */
      writeRaw: (text) => process.stdout.write(text),
      /* v8 ignore next -- thin wrapper: real stdout TTY detection injected for captured-output safety @preserve */
      isTTY: process.stdout.isTTY === true,
      /* v8 ignore next -- thin wrapper: real Date.now() injected for testability @preserve */
      now: () => Date.now(),
      /* v8 ignore next -- thin wrapper: real setTimeout injected for testability @preserve */
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      /* v8 ignore start -- daemon log tail + pid check: reads real filesystem, tested via deployment @preserve */
      readLatestDaemonEvent: readLatestDaemonStartupEvent,
      /* v8 ignore stop */
    })

    return {
      alreadyRunning: runtimeResult.alreadyRunning,
      message: runtimeResult.message,
      stability,
    }
  }

  const retryLimit = deps.startupRetryLimit ?? DEFAULT_DAEMON_STARTUP_RETRY_LIMIT
  let lastFailure: DaemonStartupFailure = {
    reason: "daemon failed before the startup monitor recorded a failure",
    retryable: false,
  }
  let lastPid: number | null = null

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    deps.reportDaemonStartupPhase?.("starting daemon...")
    deps.reportDaemonStartupPhase?.("waiting for daemon socket...")
    deps.cleanupStaleSocket(deps.socketPath)

    const bootStartedAtMs = (deps.now ?? Date.now)()
    const started = await deps.startDaemonProcess(deps.socketPath)
    lastPid = started.pid ?? null

    const startupFailure = await waitForDaemonStartup(deps, {
      bootStartedAtMs,
      pid: lastPid,
    })
    if (!startupFailure) {
      const stability = await pollDaemonStartup({
        sendCommand: deps.sendCommand,
        socketPath: deps.socketPath,
        daemonPid: lastPid,
        /* v8 ignore next -- thin wrapper: raw process.stdout.write for ANSI cursor control @preserve */
        writeRaw: (text) => process.stdout.write(text),
        /* v8 ignore next -- thin wrapper: real stdout TTY detection injected for captured-output safety @preserve */
        isTTY: process.stdout.isTTY === true,
        /* v8 ignore next -- thin wrapper: real Date.now() injected for testability @preserve */
        now: () => Date.now(),
        /* v8 ignore next -- thin wrapper: real setTimeout injected for testability @preserve */
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        /* v8 ignore start -- daemon log tail + pid check: reads real filesystem, tested via deployment @preserve */
        readLatestDaemonEvent: readLatestDaemonStartupEvent,
        /* v8 ignore stop */
      })

      return {
        alreadyRunning: false,
        message: `daemon started (pid ${lastPid ?? "unknown"})`,
        stability,
      }
    }

    lastFailure = startupFailure
    if (!startupFailure.retryable || attempt >= retryLimit) {
      break
    }

    deps.reportDaemonStartupPhase?.("daemon startup lost stability; cleaning up and retrying once...")
  }

  return {
    alreadyRunning: false,
    message: formatDaemonStartupFailureMessage(lastPid, lastFailure, deps),
  }
}

function hasStartupHealthMonitor(deps: OuroCliDeps): boolean {
  return !!deps.healthFilePath && !!deps.readHealthState && !!deps.readHealthUpdatedAt
}

function hasFreshCurrentBootHealthSignal(
  deps: OuroCliDeps,
  bootStartedAtMs: number,
  pid: number | null,
): boolean {
  const healthState = deps.readHealthState!(deps.healthFilePath!)
  if (!healthState) return false

  const healthUpdatedAt = deps.readHealthUpdatedAt!(deps.healthFilePath!)
  if (healthUpdatedAt === null || healthUpdatedAt < bootStartedAtMs) {
    return false
  }

  const healthStartedAtMs = Date.parse(healthState.startedAt)
  if (!Number.isFinite(healthStartedAtMs) || healthStartedAtMs < bootStartedAtMs) {
    return false
  }

  if (pid !== null && healthState.pid !== pid) {
    return false
  }

  return true
}

function formatDaemonStartupFailureMessage(
  pid: number | null,
  failure: DaemonStartupFailure,
  deps: OuroCliDeps,
): string {
  const lines = [
    `daemon spawned (pid ${pid ?? "unknown"}) but failed to stabilize: ${failure.reason}`,
  ]
  const recentLogLines = deps.readRecentDaemonLogLines?.(DEFAULT_DAEMON_STARTUP_LOG_LINES) ?? []
  if (recentLogLines.length > 0) {
    lines.push("recent daemon logs:")
    lines.push(...recentLogLines.map((line) => `  ${line}`))
  }
  lines.push("fix hint for daemon: check daemon logs or run `ouro doctor`")
  return lines.join("\n")
}

async function waitForDaemonStartup(
  deps: OuroCliDeps,
  options: {
    bootStartedAtMs: number
    pid: number | null
  },
): Promise<DaemonStartupFailure | null> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const timeoutMs = deps.startupTimeoutMs ?? DEFAULT_DAEMON_STARTUP_TIMEOUT_MS
  const pollIntervalMs = deps.startupPollIntervalMs ?? DEFAULT_DAEMON_STARTUP_POLL_INTERVAL_MS
  const stabilityWindowMs = deps.startupStabilityWindowMs ?? DEFAULT_DAEMON_STARTUP_STABILITY_WINDOW_MS
  const deadline = options.bootStartedAtMs + timeoutMs
  const useHealthMonitor = hasStartupHealthMonitor(deps)
  let stableSinceMs: number | null = null
  let sawSocket = false

  if (!useHealthMonitor) {
    const verified = await verifyDaemonAlive(
      deps.checkSocketAlive,
      deps.socketPath,
      timeoutMs,
      pollIntervalMs,
      sleep,
      now,
    )
    return verified
      ? null
      : {
          reason: `daemon failed to respond within ${Math.ceil(timeoutMs / 1000)}s`,
          retryable: false,
        }
  }

  while (now() < deadline) {
    await sleep(pollIntervalMs)
    const aliveNow = await deps.checkSocketAlive(deps.socketPath)
    if (!aliveNow) {
      if (sawSocket) {
        return {
          reason: "daemon socket disappeared during startup",
          retryable: true,
        }
      }
      continue
    }

    if (!sawSocket) {
      sawSocket = true
      stableSinceMs = now()
      deps.reportDaemonStartupPhase?.("verifying daemon health...")
    }

    if (!hasFreshCurrentBootHealthSignal(deps, options.bootStartedAtMs, options.pid)) {
      continue
    }

    if (stableSinceMs !== null && now() - stableSinceMs >= stabilityWindowMs) {
      return null
    }
  }

  return {
    reason: sawSocket
      ? "daemon did not publish fresh health for the current boot attempt"
      : `daemon failed to respond within ${Math.ceil(timeoutMs / 1000)}s`,
    retryable: sawSocket,
  }
}

async function verifyDaemonAlive(
  checkSocketAlive: (socketPath: string) => Promise<boolean>,
  socketPath: string,
  maxWaitMs = 10_000,
  pollIntervalMs = 500,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + maxWaitMs
  while (now() < deadline) {
    await sleep(pollIntervalMs)
    if (await checkSocketAlive(socketPath)) return true
  }
  return false
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
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

// ── Provider credential verification ──

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

function toDaemonCommand(command: Exclude<OuroCliCommand, { kind: "daemon.up" } | { kind: "daemon.dev" } | { kind: "daemon.logs.prune" } | { kind: "outlook" } | { kind: "hatch.start" } | AuthCliCommand | AuthVerifyCliCommand | AuthSwitchCliCommand | ProviderCliCommand | TaskCliCommand | ReminderCliCommand | FriendCliCommand | WhoamiCliCommand | SessionCliCommand | ThoughtsCliCommand | ChangelogCliCommand | ConfigModelCliCommand | ConfigModelsCliCommand | RollbackCliCommand | VersionsCliCommand | AttentionCliCommand | InnerStatusCliCommand | McpServeCliCommand | SetupCliCommand | CloneCliCommand | HookCliCommand | HabitLocalCliCommand | DoctorCliCommand | HelpCliCommand | { kind: "bluebubbles.replay" }>): DaemonCommand {
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

// ── Provider state CLI helpers ──

function providerCliHomeDir(deps: OuroCliDeps): string {
  return providerCredentialHomeDirFromSecretsRoot(deps.secretsRoot)
}

function providerCliAgentRoot(command: { agent: string }, deps: OuroCliDeps): string {
  return path.join(deps.bundlesRoot ?? getAgentBundlesRoot(), `${command.agent}.ouro`)
}

function providerCliNow(deps: OuroCliDeps): Date {
  return new Date((deps.now ?? Date.now)())
}

function readOrBootstrapProviderState(agentName: string, deps: OuroCliDeps): { agentRoot: string; state: ProviderState } {
  const agentRoot = providerCliAgentRoot({ agent: agentName }, deps)
  const readResult = readProviderState(agentRoot)
  if (readResult.ok) return { agentRoot, state: readResult.state }
  if (readResult.reason === "invalid") {
    throw new Error(`provider state for ${agentName} is invalid at ${readResult.statePath}: ${readResult.error}`)
  }

  const { config } = readAgentConfigForAgent(agentName, deps.bundlesRoot)
  const homeDir = providerCliHomeDir(deps)
  const machine = loadOrCreateMachineIdentity({
    homeDir,
    now: () => providerCliNow(deps),
  })
  const state = bootstrapProviderStateFromAgentConfig({
    machineId: machine.machineId,
    now: providerCliNow(deps),
    agentConfig: {
      humanFacing: {
        provider: config.humanFacing.provider,
        model: config.humanFacing.model || getDefaultModelForProvider(config.humanFacing.provider),
      },
      agentFacing: {
        provider: config.agentFacing.provider,
        model: config.agentFacing.model || getDefaultModelForProvider(config.agentFacing.provider),
      },
    },
  })
  writeProviderState(agentRoot, state)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.provider_state_bootstrapped",
    message: "bootstrapped local provider state from agent config",
    meta: { agent: agentName, agentRoot },
  })
  return { agentRoot, state }
}

function credentialPingConfig(record: ProviderCredentialRecord): Parameters<typeof pingProvider>[1] {
  return {
    ...record.credentials,
    ...record.config,
  } as unknown as Parameters<typeof pingProvider>[1]
}

function pingAttemptCount(result: PingResult | { attempts?: unknown }): number | undefined {
  if (typeof result.attempts === "number") return result.attempts
  if (Array.isArray(result.attempts)) return result.attempts.length
  return undefined
}

function providerCliLegacyRecord(agent: string, provider: AgentProvider, deps: OuroCliDeps): ReturnType<typeof splitProviderCredentialFields> | null {
  try {
    const legacyCandidates = readLegacyAgentProviderCredentials({
      homeDir: providerCliHomeDir(deps),
      agentName: agent,
    })
    const candidate = legacyCandidates.find((entry) => entry.provider === provider)
    if (candidate) return { credentials: candidate.credentials, config: candidate.config }
  } catch {
    // Fall through to the injected/secretsRoot-aware legacy reader below.
  }

  try {
    const { secrets } = loadAgentSecrets(agent, { secretsRoot: deps.secretsRoot })
    const providerSecrets = secrets.providers[provider]
    const split = splitProviderCredentialFields(provider, providerSecrets)
    if (Object.keys(split.credentials).length === 0 && Object.keys(split.config).length === 0) return null
    return split
  } catch {
    return null
  }
}

function readProviderCredentialRecord(
  agent: string,
  provider: AgentProvider,
  deps: OuroCliDeps,
): { ok: true; record: ProviderCredentialRecord } | { ok: false; reason: "missing" | "invalid"; poolPath: string; error: string } {
  const homeDir = providerCliHomeDir(deps)
  const poolResult = readProviderCredentialPool(homeDir)
  if (poolResult.ok) {
    const existing = poolResult.pool.providers[provider]
    if (existing) return { ok: true, record: existing }
  } else if (poolResult.reason === "invalid") {
    return { ok: false, reason: "invalid", poolPath: poolResult.poolPath, error: poolResult.error }
  }

  const legacy = providerCliLegacyRecord(agent, provider, deps)
  if (legacy) {
    const record = upsertProviderCredential({
      homeDir,
      provider,
      credentials: legacy.credentials,
      config: legacy.config,
      provenance: {
        source: "legacy-agent-secrets",
        contributedByAgent: agent,
      },
      now: providerCliNow(deps),
    })
    return { ok: true, record }
  }

  return {
    ok: false,
    reason: "missing",
    poolPath: poolResult.poolPath,
    error: `no credentials stored for ${provider}`,
  }
}

function writeProviderBinding(input: {
  agentRoot: string
  state: ProviderState
  lane: ProviderLane
  provider: AgentProvider
  model: string
  deps: OuroCliDeps
  status: "ready" | "failed" | "unknown"
  credentialRevision?: string
  error?: string
  attempts?: number
}): void {
  const updatedAt = providerCliNow(input.deps).toISOString()
  input.state.updatedAt = updatedAt
  input.state.lanes[input.lane] = {
    provider: input.provider,
    model: input.model,
    source: "local",
    updatedAt,
  }
  input.state.readiness[input.lane] = {
    status: input.status,
    provider: input.provider,
    model: input.model,
    checkedAt: updatedAt,
    ...(input.credentialRevision ? { credentialRevision: input.credentialRevision } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
  }
  writeProviderState(input.agentRoot, input.state)
}

function writeProviderReadiness(input: {
  agentRoot: string
  state: ProviderState
  lane: ProviderLane
  provider: AgentProvider
  model: string
  deps: OuroCliDeps
  status: "ready" | "failed"
  credentialRevision: string
  error?: string
  attempts?: number
}): void {
  const checkedAt = providerCliNow(input.deps).toISOString()
  input.state.updatedAt = checkedAt
  input.state.readiness[input.lane] = {
    status: input.status,
    provider: input.provider,
    model: input.model,
    checkedAt,
    credentialRevision: input.credentialRevision,
    ...(input.error ? { error: input.error } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
  }
  writeProviderState(input.agentRoot, input.state)
}

async function executeProviderUse(
  command: Extract<OuroCliCommand, { kind: "provider.use" }>,
  deps: OuroCliDeps,
  options: { writeStdout?: boolean } = {},
): Promise<string> {
  const writeMessage = (message: string): string => {
    if (options.writeStdout !== false) deps.writeStdout(message)
    return message
  }
  const { agentRoot, state } = readOrBootstrapProviderState(command.agent, deps)
  const credential = readProviderCredentialRecord(command.agent, command.provider, deps)
  if (!credential.ok) {
    if (!command.force) {
      const message = [
        `no credentials stored for ${command.provider}.`,
        `Run \`ouro auth --agent ${command.agent} --provider ${command.provider}\` first.`,
      ].join("\n")
      return writeMessage(message)
    }
    writeProviderBinding({
      agentRoot,
      state,
      lane: command.lane,
      provider: command.provider,
      model: command.model,
      deps,
      status: "failed",
      error: credential.error,
    })
    const message = `forced ${command.agent} ${command.lane} to ${command.provider} / ${command.model}: failed (${credential.error})`
    return writeMessage(message)
  }

  const pingResult = await pingProvider(command.provider, credentialPingConfig(credential.record), {
    model: command.model,
    attemptPolicy: { baseDelayMs: 0 },
    sleep: deps.sleep,
  })
  const attempts = pingAttemptCount(pingResult)
  if (!pingResult.ok && !command.force) {
    const message = [
      `${command.agent} ${command.lane} ${command.provider} / ${command.model}: failed (${pingResult.message})`,
      `Fix credentials with \`ouro auth --agent ${command.agent} --provider ${command.provider}\` or force the local binding with \`ouro use --agent ${command.agent} --lane ${command.lane} --provider ${command.provider} --model ${command.model} --force\`.`,
    ].join("\n")
    return writeMessage(message)
  }

  writeProviderBinding({
    agentRoot,
    state,
    lane: command.lane,
    provider: command.provider,
    model: command.model,
    deps,
    status: pingResult.ok ? "ready" : "failed",
    credentialRevision: credential.record.revision,
    ...(!pingResult.ok ? { error: pingResult.message } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
  })
  const status = pingResult.ok ? "ready" : `failed (${pingResult.message})`
  const message = `${command.force ? "forced " : ""}${command.agent} ${command.lane} ${command.provider} / ${command.model}: ${status}`
  emitNervesEvent({
    component: "daemon",
    event: "daemon.provider_use_completed",
    message: "provider use command completed",
    meta: { agent: command.agent, lane: command.lane, provider: command.provider, model: command.model, status: pingResult.ok ? "ready" : "failed" },
  })
  return writeMessage(message)
}

async function executeProviderCheck(
  command: Extract<OuroCliCommand, { kind: "provider.check" }>,
  deps: OuroCliDeps,
): Promise<string> {
  const { agentRoot, state } = readOrBootstrapProviderState(command.agent, deps)
  const binding = state.lanes[command.lane]
  const credential = readProviderCredentialRecord(command.agent, binding.provider, deps)
  if (!credential.ok) {
    const message = [
      `${command.agent} ${command.lane} ${binding.provider} / ${binding.model}: unknown (${credential.error})`,
      `Run \`ouro auth --agent ${command.agent} --provider ${binding.provider}\` first.`,
    ].join("\n")
    deps.writeStdout(message)
    return message
  }

  const pingResult = await pingProvider(binding.provider, credentialPingConfig(credential.record), {
    model: binding.model,
    attemptPolicy: { baseDelayMs: 0 },
    sleep: deps.sleep,
  })
  const attempts = pingAttemptCount(pingResult)
  writeProviderReadiness({
    agentRoot,
    state,
    lane: command.lane,
    provider: binding.provider,
    model: binding.model,
    deps,
    status: pingResult.ok ? "ready" : "failed",
    credentialRevision: credential.record.revision,
    ...(!pingResult.ok ? { error: pingResult.message } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
  })
  const status = pingResult.ok ? "ready" : `failed (${pingResult.message})`
  const message = `${command.agent} ${command.lane} ${binding.provider} / ${binding.model}: ${status}`
  deps.writeStdout(message)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.provider_check_completed",
    message: "provider check command completed",
    meta: { agent: command.agent, lane: command.lane, provider: binding.provider, model: binding.model, status: pingResult.ok ? "ready" : "failed" },
  })
  return message
}

function renderProviderCredentialLine(credential: EffectiveProviderCredentialStatus): string {
  if (credential.status === "present") {
    const contributor = credential.contributedByAgent ? ` by ${credential.contributedByAgent}` : ""
    const credentialFields = credential.credentialFields.length > 0 ? ` credentials: ${credential.credentialFields.join(", ")}` : " credentials: none"
    const configFields = credential.configFields.length > 0 ? ` config: ${credential.configFields.join(", ")}` : " config: none"
    return `credentials: present (${credential.source}${contributor}; ${credential.revision};${credentialFields};${configFields})`
  }
  if (credential.status === "invalid-pool") {
    return `credentials: invalid pool (${credential.error}); repair: ${credential.repair.command}`
  }
  return `credentials: missing; repair: ${credential.repair.command}`
}

function executeProviderStatus(
  command: Extract<OuroCliCommand, { kind: "provider.status" }>,
  deps: OuroCliDeps,
): string {
  const agentRoot = providerCliAgentRoot(command, deps)
  const homeDir = providerCliHomeDir(deps)
  const lines = [`provider status: ${command.agent}`]
  for (const lane of ["outward", "inner"] as ProviderLane[]) {
    const resolved = resolveEffectiveProviderBinding({
      agentName: command.agent,
      agentRoot,
      homeDir,
      lane,
    })
    if (!resolved.ok) {
      lines.push(`  ${lane}: unavailable`)
      lines.push(`    ${resolved.reason}: ${resolved.repair.command}`)
      continue
    }
    const binding = resolved.binding
    lines.push(`  ${lane}: ${binding.provider} / ${binding.model} (${binding.source})`)
    lines.push(`    readiness: ${binding.readiness.status}${binding.readiness.error ? ` (${binding.readiness.error})` : ""}`)
    lines.push(`    ${renderProviderCredentialLine(binding.credential)}`)
    for (const warning of binding.warnings) {
      lines.push(`    warning: ${warning.message}`)
    }
  }
  const message = lines.join("\n")
  deps.writeStdout(message)
  return message
}

async function executeLegacyAuthSwitch(
  command: Extract<OuroCliCommand, { kind: "auth.switch" }>,
  deps: OuroCliDeps,
): Promise<string> {
  const { state } = readOrBootstrapProviderState(command.agent, deps)
  const lanes: ProviderLane[] = command.facing
    ? [command.facing === "human" ? "outward" : "inner"]
    : ["outward", "inner"]
  const messages: string[] = []
  for (const lane of lanes) {
    const model = state.lanes[lane].model
    messages.push(await executeProviderUse({
      kind: "provider.use",
      agent: command.agent,
      lane,
      provider: command.provider,
      model,
      legacyFacing: command.facing,
    }, deps, { writeStdout: false }))
  }
  const message = [
    `deprecated: switched this machine's local provider binding. \`ouro auth switch\` no longer edits agent.json.`,
    ...messages,
    `Use \`ouro use --agent ${command.agent} --lane <outward|inner> --provider ${command.provider} --model <model>\` for explicit provider/model selection.`,
  ].join("\n")
  deps.writeStdout(message)
  return message
}

async function executeLegacyConfigModel(
  command: Extract<OuroCliCommand, { kind: "config.model" }>,
  deps: OuroCliDeps,
): Promise<string> {
  const lane: ProviderLane = command.facing === "agent" ? "inner" : "outward"
  const { agentRoot, state } = readOrBootstrapProviderState(command.agent, deps)
  const binding = state.lanes[lane]
  if (binding.provider === "github-copilot") {
    const credential = readProviderCredentialRecord(command.agent, "github-copilot", deps)
    if (credential.ok) {
      const ghConfig: Record<string, string | number> = {
        ...credential.record.config,
        ...credential.record.credentials,
      }
      const githubToken = ghConfig.githubToken
      const baseUrl = ghConfig.baseUrl
      if (typeof githubToken === "string" && typeof baseUrl === "string") {
        const fetchFn = deps.fetchImpl ?? fetch
        try {
          const models = await listGithubCopilotModels(baseUrl, githubToken, fetchFn)
          const available = models.map((m) => m.id)
          if (available.length > 0 && !available.includes(command.modelName)) {
            const message = `model '${command.modelName}' not found. available models:\n${available.map((id) => `  ${id}`).join("\n")}`
            deps.writeStdout(message)
            return message
          }
        } catch {
          // Catalog validation failed; the live ping below gives the actionable result.
        }

        const pingResult = await pingGithubCopilotModel(baseUrl, githubToken, command.modelName, fetchFn)
        if (!pingResult.ok) {
          const message = `model '${command.modelName}' ping failed: ${pingResult.error}\nrun \`ouro config models --agent ${command.agent}\` to see available models.`
          deps.writeStdout(message)
          return message
        }
      }
    }
  }

  const updatedAt = providerCliNow(deps).toISOString()
  state.updatedAt = updatedAt
  state.lanes[lane] = {
    ...binding,
    model: command.modelName,
    source: "local",
    updatedAt,
  }
  delete state.readiness[lane]
  writeProviderState(agentRoot, state)
  const message = `deprecated: updated ${command.agent} model on ${lane}/${binding.provider}: ${binding.model} -> ${command.modelName}\nUse \`ouro use --agent ${command.agent} --lane ${lane} --provider ${binding.provider} --model ${command.modelName}\` next time.`
  deps.writeStdout(message)
  return message
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
      if (installResult.pathResolution?.status === "shadowed") {
        deps.writeStdout(
          `fix ouro PATH: ${installResult.pathResolution.detail}; ` +
          `fix: ${installResult.pathResolution.remediation}`,
        )
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
    const text = getGroupedHelp()
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
      // Hatch-or-clone choice when promptInput is available
      if (deps.promptInput) {
        const choice = await deps.promptInput("No agents found. Would you like to hatch a new agent or clone an existing one? (hatch/clone): ")
        if (choice.trim().toLowerCase() === "clone") {
          emitNervesEvent({
            component: "daemon",
            event: "daemon.first_run_choice_clone",
            message: "user chose clone in first-run flow",
            meta: {},
          })
          const remote = await deps.promptInput("Enter the git remote URL for the agent bundle: ")
          // Run clone execution path
          const cloneCommand = { kind: "clone" as const, remote: remote.trim() }
          return await runOuroCli(["clone", cloneCommand.remote], deps)
        }
        emitNervesEvent({
          component: "daemon",
          event: "daemon.first_run_choice_hatch",
          message: "user chose hatch in first-run flow",
          meta: {},
        })
      }

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
        const health = await checkProviderHealthBeforeChat(discovered[0], deps)
        if (!health.ok) return health.output
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
        const health = await checkProviderHealthBeforeChat(selected, deps)
        if (!health.ok) return health.output
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

  if (command.kind === "help") {
    const text = command.command
      ? (getCommandHelp(command.command) ?? `Unknown command: ${command.command}\n\n${getGroupedHelp()}`)
      : getGroupedHelp()
    deps.writeStdout(text)
    return text
  }

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

    const progress = new UpProgress({ write: deps.writeStdout, isTTY: false })

    // ── versioned CLI update check ──
    if (deps.checkForCliUpdate) {
      progress.startPhase("update check")
      let pendingReExec = false
      try {
        const updateResult = await deps.checkForCliUpdate()
        if (updateResult.available && updateResult.latestVersion) {
          /* v8 ignore next -- fallback: getCurrentCliVersion always injected in tests @preserve */
          const currentVersion = linkedVersionBeforeUp ?? "unknown"
          await deps.installCliVersion!(updateResult.latestVersion)
          deps.activateCliVersion!(updateResult.latestVersion)
          progress.completePhase("update check", `installed ${updateResult.latestVersion}`)
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
        progress.end()
        deps.reExecFromNewVersion!(args)
      } else {
        progress.completePhase("update check", "up to date")
      }
    }

    progress.startPhase("system setup")
    await performSystemSetup(deps)
    progress.completePhase("system setup")

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
      progress.startPhase("agent updates")
      progress.completePhase("agent updates", `${count} agent${count === 1 ? "" : "s"} to runtime ${to}${fromStr}`)
    }

    // ── stale bundle pruning ──
    const prunedBundles = pruneStaleEphemeralBundles({ bundlesRoot: deps.bundlesRoot })
    if (prunedBundles.length > 0) {
      progress.startPhase("bundle cleanup")
      progress.completePhase("bundle cleanup", `pruned ${prunedBundles.length} stale bundle${prunedBundles.length === 1 ? "" : "s"}`)
    }

    progress.startPhase("starting daemon")
    const daemonResult = await ensureDaemonRunning({
      ...deps,
      reportDaemonStartupPhase: (label) => {
        ;(progress as { announceStep?: (line: string) => void }).announceStep?.(label)
      },
    })
    if (daemonResult.alreadyRunning) {
      progress.startPhase("provider checks")
      const providerDegraded = await checkAlreadyRunningAgentProviders(deps)
      daemonResult.stability = mergeStartupStability(daemonResult.stability, providerDegraded)
      progress.completePhase("provider checks", providerDegraded.length > 0 ? `${providerDegraded.length} degraded` : "ok")
    }
    progress.end()
    deps.writeStdout(daemonResult.message)

    // Interactive repair for degraded agents (Unit 5) — skipped by --no-repair (Unit 6)
    if (daemonResult.stability?.degraded && daemonResult.stability.degraded.length > 0) {
      if (command.noRepair) {
        // --no-repair: write degraded summary and skip interactive repair
        deps.writeStdout("degraded agents:")
        for (const d of daemonResult.stability.degraded) {
          deps.writeStdout(`  ${d.agent}: ${d.errorReason}`)
          if (d.fixHint) {
            deps.writeStdout(`    fix: ${d.fixHint}`)
          }
        }
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.no_repair_degraded_summary",
          message: "degraded agents detected with --no-repair, skipping interactive repair",
          meta: { degradedCount: daemonResult.stability.degraded.length },
        })
      } else {
        await runAgenticRepair(daemonResult.stability.degraded, {
          /* v8 ignore start -- production provider discovery wiring @preserve */
          discoverWorkingProvider: async () => {
            const { discoverWorkingProvider: discover } = await import("./provider-discovery")
            const { discoverExistingCredentials } = await import("./cli-defaults")
            const { pingProvider } = await import("../provider-ping")
            return discover({
              discoverExistingCredentials,
              pingProvider: pingProvider as unknown as (provider: AgentProvider, config: Record<string, string>) => Promise<import("../provider-ping").PingResult>,
              env: process.env as Record<string, string | undefined>,
              secretsRoot: deps.secretsRoot ?? `${process.env["HOME"]}/.agentsecrets`,
            })
          },
          createProviderRuntime: createAgenticDiagnosisProviderRuntime,
          readDaemonLogsTail: () => {
            try {
              const fs = require("node:fs") as typeof import("node:fs")
              const path = require("node:path") as typeof import("node:path")
              const logsDir = path.join(process.env["HOME"] ?? "", ".agentstate", "daemon", "logs")
              const files = fs.readdirSync(logsDir).filter((f: string) => f.endsWith(".log")).sort()
              if (files.length === 0) return "(no daemon logs found)"
              const lastLog = fs.readFileSync(path.join(logsDir, files[files.length - 1]!), "utf8")
              const lines = lastLog.split("\n")
              return lines.slice(-50).join("\n")
            } catch {
              return "(unable to read daemon logs)"
            }
          },
          /* v8 ignore stop */
          runInteractiveRepair,
          promptInput: deps.promptInput ?? (async () => "n"),
          writeStdout: deps.writeStdout,
          runAuthFlow: async (agent: string, providerOverride?: AgentProvider) => {
            const { config } = readAgentConfigForAgent(agent, deps.bundlesRoot)
            const provider = providerOverride ?? config.humanFacing.provider
            /* v8 ignore next -- tests always inject runAuthFlow; default is for production @preserve */
            const authRunner = deps.runAuthFlow ?? (await import("../auth/auth-flow")).runRuntimeAuthFlow
            await authRunner({ agentName: agent, provider, promptInput: deps.promptInput })
          },
        })
      }
    }

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
    const platform = detectPlatform()

    // Windows native is not yet supported
    if (platform === "windows-native") {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.setup_windows_native_unsupported",
        message: "Windows native setup not yet supported",
        meta: { tool, agent: setupAgent },
      })
      const message = "Windows native is not yet supported. Please run from WSL2: https://learn.microsoft.com/en-us/windows/wsl/install"
      deps.writeStdout(message)
      return message
    }

    // Resolve platform-specific paths and commands
    let claudeCmd: string
    let mcpServePrefix: string
    let hookPrefix: string
    let claudeConfigDir: string

    if (platform === "wsl") {
      const winProfile = execFileSync("cmd.exe", ["/C", "echo", "%USERPROFILE%"], { stdio: "pipe" }).toString().trim()
      const windowsHome = execFileSync("wslpath", ["-u", winProfile], { stdio: "pipe" }).toString().trim()
      emitNervesEvent({
        component: "daemon",
        event: "daemon.setup_wsl_home_resolved",
        message: "resolved Windows home from WSL",
        meta: { windowsHome },
      })
      claudeCmd = "claude.exe"
      mcpServePrefix = "wsl "
      hookPrefix = "wsl "
      claudeConfigDir = path.join(windowsHome, ".claude")
    } else {
      // macos or linux
      claudeCmd = "claude"
      mcpServePrefix = ""
      hookPrefix = ""
      claudeConfigDir = path.join(os.homedir(), ".claude")
    }

    const sourceRoot = getRepoRoot()
    const runtimeMode = detectRuntimeMode(sourceRoot)
    const baseMcpServeCommand = runtimeMode === "dev"
      ? `node ${path.join(sourceRoot, "dist", "heart", "daemon", "ouro-bot-entry.js")} mcp-serve --agent ${setupAgent}`
      : `ouro mcp-serve --agent ${setupAgent}`
    const mcpServeCommand = `${mcpServePrefix}${baseMcpServeCommand}`

    if (tool === "claude-code") {
      // 1. Register MCP server with Claude Code
      const mcpAddCmd = `${claudeCmd} mcp add ouro-${setupAgent} -s user -- ${mcpServeCommand}`
      execSync(mcpAddCmd, { stdio: "pipe" })

      // 2. Write hooks config
      const settingsPath = path.join(claudeConfigDir, "settings.json")
      let settings: Record<string, unknown> = {}
      if (fs.existsSync(settingsPath)) {
        try {
          settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
        } catch { /* start fresh */ }
      }

      settings.hooks = {
        ...(settings.hooks as Record<string, unknown> ?? {}),
        SessionStart: [{ hooks: [{ type: "command", command: `${hookPrefix}ouro hook session-start --agent ${setupAgent}`, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: `${hookPrefix}ouro hook stop --agent ${setupAgent}`, timeout: 5 }] }],
        PostToolUse: [{ matcher: "Bash|Edit|Write", hooks: [{ type: "command", command: `${hookPrefix}ouro hook post-tool-use --agent ${setupAgent}`, timeout: 5 }] }],
      }

      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

      emitNervesEvent({
        component: "daemon",
        event: "daemon.setup_complete",
        message: "dev tool setup complete",
        meta: { tool, agent: setupAgent, runtimeMode, platform },
      })

      // 3. Write conversation formatting instructions
      const claudeMdPath = path.join(claudeConfigDir, "CLAUDE.md")
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
        meta: { tool, agent: setupAgent, runtimeMode, platform },
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

  // ── provider state commands (local, no daemon socket needed) ──
  if (command.kind === "provider.use") {
    return executeProviderUse(command, deps)
  }

  if (command.kind === "provider.check") {
    return executeProviderCheck(command, deps)
  }

  if (command.kind === "provider.status") {
    return executeProviderStatus(command, deps)
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
    const credentials = (result.credentials ?? {}) as Record<string, unknown>
    const split = splitProviderCredentialFields(provider, credentials)
    if (Object.keys(split.credentials).length > 0 || Object.keys(split.config).length > 0) {
      upsertProviderCredential({
        homeDir: providerCliHomeDir(deps),
        provider,
        credentials: split.credentials,
        config: split.config,
        provenance: {
          source: "auth-flow",
          contributedByAgent: command.agent,
        },
        now: providerCliNow(deps),
      })
    }
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
    return executeLegacyAuthSwitch(command, deps)
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
    return executeLegacyConfigModel(command, deps)
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
    // Check provider health before launching chat — fail fast with
    // actionable guidance instead of erroring mid-conversation.
    const health = await checkProviderHealthBeforeChat(agent, deps)
    if (!health.ok) return health.output
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
      /* v8 ignore start -- thin fs wrappers tested via doctor.test.ts with injected deps @preserve */
      existsSync: (p: string) => fs.existsSync(p),
      readFileSync: (p: string) => fs.readFileSync(p, "utf-8"),
      readdirSync: (p: string) => fs.readdirSync(p),
      statSync: (p: string) => fs.statSync(p),
      /* v8 ignore stop */
      checkSocketAlive: deps.checkSocketAlive,
      fetchImpl: deps.fetchImpl ?? fetch,
      socketPath: deps.socketPath,
      bundlesRoot: deps.bundlesRoot ?? getAgentBundlesRoot(),
      secretsRoot: deps.secretsRoot ?? path.join(os.homedir(), ".agentsecrets"),
      homedir: os.homedir(),
      envPath: process.env.PATH ?? "",
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

  // ── clone: clone an agent bundle from a git remote ──
  if (command.kind === "clone") {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.clone_start",
      message: "starting agent bundle clone",
      meta: { remote: command.remote, agent: command.agent },
    })

    // 1. Check git is installed
    emitNervesEvent({ component: "daemon", event: "daemon.clone_git_check", message: "checking git installation", meta: {} })
    try {
      execFileSync("git", ["--version"], { stdio: "pipe" })
    } catch (err) {
      const message = "git is not installed -- install it from https://git-scm.com\nOn macOS: brew install git\nOn Ubuntu/Debian: sudo apt install git\nOn Windows: download from https://git-scm.com/download/win"
      deps.writeStdout(message)
      return message
    }

    // 2. Infer agent name
    const agentName = command.agent ?? inferAgentNameFromRemote(command.remote)
    const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
    const targetPath = path.join(bundlesRoot, agentName + ".ouro")

    // 3. Check target path does not exist
    if (fs.existsSync(targetPath)) {
      const message = `${targetPath} already exists. Remove it first or use --agent to pick a different name.`
      deps.writeStdout(message)
      return message
    }

    // 4. Check remote accessible
    emitNervesEvent({ component: "daemon", event: "daemon.clone_remote_check", message: "checking remote accessibility", meta: { remote: command.remote } })
    try {
      execFileSync("git", ["ls-remote", "--exit-code", command.remote], { stdio: "pipe", timeout: 15000 })
    } catch {
      const message = `could not reach remote: ${command.remote}\nCheck the URL and your network connection.`
      deps.writeStdout(message)
      return message
    }

    // 5. Clone
    emitNervesEvent({ component: "daemon", event: "daemon.clone_git_clone", message: "cloning agent bundle", meta: { remote: command.remote, targetPath } })
    execFileSync("git", ["clone", command.remote, targetPath], { stdio: "pipe" })

    // 6. Create machine identity
    loadOrCreateMachineIdentity()
    emitNervesEvent({ component: "daemon", event: "daemon.clone_identity_created", message: "machine identity created", meta: {} })

    // 7. Enable sync in agent.json
    const agentJsonPath = path.join(targetPath, "agent.json")
    if (fs.existsSync(agentJsonPath)) {
      const raw = fs.readFileSync(agentJsonPath, "utf-8")
      const config = JSON.parse(raw) as Record<string, unknown>
      config.sync = { enabled: true, remote: "origin" }
      fs.writeFileSync(agentJsonPath, JSON.stringify(config, null, 2) + "\n")
      emitNervesEvent({ component: "daemon", event: "daemon.clone_sync_enabled", message: "sync enabled in agent.json", meta: { agentName } })
    }

    // 8. Output success message
    emitNervesEvent({ component: "daemon", event: "daemon.clone_complete", message: "clone complete", meta: { agentName, targetPath } })
    const message = `cloned ${agentName} to ${targetPath}\nsync enabled (remote: origin)\nnext steps:\n  ouro auth run --agent ${agentName}`
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
