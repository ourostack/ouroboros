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
import { defaultStableVaultEmail, getAgentBundlesRoot, getAgentName, getAgentRoot, getRepoRoot, resolveVaultConfig, type AgentConfig, type AgentProvider } from "../identity"
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
import { getCredentialStore, resetCredentialStore } from "../../repertoire/credential-access"
import { createVaultAccount } from "../../repertoire/vault-setup"
import { getVaultUnlockStatus, promptConfirmedVaultUnlockSecret, storeVaultUnlockSecret, vaultUnlockReplaceRecoverFix, type VaultUnlockStoreKind } from "../../repertoire/vault-unlock"
import { parseInnerDialogSession, formatThoughtTurns, getInnerDialogSessionPath, followThoughts } from "./thoughts"
import type { TaskModule } from "../../repertoire/tasks/types"
import { uninstallLaunchAgent, isDaemonInstalled, type LaunchdDeps } from "./launchd"
import {
  resolveHatchCredentials,
  readAgentConfigForAgent,
  runRuntimeAuthFlow,
} from "../auth/auth-flow"
import {
  providerCredentialMachineHomeDir,
  refreshProviderCredentialPool,
  splitProviderCredentialFields,
  summarizeProviderCredentialPool,
  upsertProviderCredential,
  type ProviderCredentialRecord,
} from "../provider-credentials"
import {
  refreshMachineRuntimeCredentialConfig,
  refreshRuntimeCredentialConfig,
  upsertMachineRuntimeCredentialConfig,
  upsertRuntimeCredentialConfig,
  type RuntimeCredentialConfig,
} from "../runtime-credentials"
import { resolveEffectiveProviderBinding, type EffectiveProviderCredentialStatus } from "../provider-binding-resolver"
import { bootstrapProviderStateFromAgentConfig, readProviderState, writeProviderState, type ProviderLane, type ProviderState } from "../provider-state"
import { loadOrCreateMachineIdentity } from "../machine-identity"
import { getDefaultModelForProvider } from "../provider-models"
import { getOuroCliHome, buildChangelogCommand } from "../versioning/ouro-version-manager"
import { postTurnPush } from "../sync"

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
  RepairCliCommand,
  VaultCliCommand,
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
  RuntimeConfigScope,
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
import { hasRunnableInteractiveRepair, runInteractiveRepair } from "./interactive-repair"
import type { DegradedAgent } from "./interactive-repair"
import { createAgenticDiagnosisProviderRuntime, runAgenticRepair } from "./agentic-repair"
import {
  genericReadinessIssue,
  renderReadinessIssueNextSteps,
  runGuidedReadinessRepair,
  type AgentReadinessIssue,
  type AgentReadinessReport,
  type RepairAction,
} from "./readiness-repair"
import { pollDaemonStartup } from "./startup-tui"
import { pruneStaleEphemeralBundles } from "./stale-bundle-prune"
import { UpProgress } from "./up-progress"
import { pingGithubCopilotModel, pingProvider, type PingResult } from "../provider-ping"
import { listEnabledBundleAgents } from "./agent-discovery"

// ── ensureDaemonRunning ──

const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_DAEMON_STARTUP_POLL_INTERVAL_MS = 500
const DEFAULT_DAEMON_STARTUP_STABILITY_WINDOW_MS = 1_500
const DEFAULT_DAEMON_STARTUP_RETRY_LIMIT = 1
const DEFAULT_DAEMON_STARTUP_LOG_LINES = 10

async function checkAgentProviders(
  deps: OuroCliDeps,
  agentsOverride?: string[],
): Promise<DegradedAgent[]> {
  const agents = agentsOverride ?? await listCliAgents(deps)
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  const degraded: DegradedAgent[] = []

  for (const agent of [...new Set(agents)]) {
    try {
      const result = await checkAgentProviderHealth(agent, bundlesRoot, deps)
      if (result.ok) continue
      const errorReason = result.error ?? "agent provider health check failed"
      const fixHint = result.fix ?? ""
      degraded.push({ agent, errorReason, fixHint, ...(result.issue ? { issue: result.issue } : {}) })
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_config_invalid",
        message: errorReason,
        meta: { agent, fixProvided: fixHint.length > 0, source: "already-running-provider-check" },
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
        meta: { agent, fixProvided: true, source: "already-running-provider-check" },
      })
    }
  }

  return degraded
}

async function checkAgentProviderHealth(
  agentName: string,
  bundlesRoot: string,
  deps: OuroCliDeps,
): ReturnType<typeof checkAgentConfigWithProviderHealth> {
  if (deps.homeDir) {
    return checkAgentConfigWithProviderHealth(agentName, bundlesRoot, { homeDir: deps.homeDir })
  }
  return checkAgentConfigWithProviderHealth(agentName, bundlesRoot)
}

async function listCliAgents(deps: OuroCliDeps): Promise<string[]> {
  if (deps.listDiscoveredAgents) {
    return Promise.resolve(deps.listDiscoveredAgents())
  }
  if (deps.bundlesRoot) {
    return listEnabledBundleAgents({ bundlesRoot: deps.bundlesRoot })
  }
  return []
}

async function checkAlreadyRunningAgentProviders(deps: OuroCliDeps): Promise<DegradedAgent[]> {
  return checkAgentProviders(deps)
}

function readinessIssueFromDegraded(entry: DegradedAgent): AgentReadinessIssue {
  return entry.issue ?? genericReadinessIssue({
    summary: `${entry.agent}: ${entry.errorReason}`,
    ...(entry.fixHint ? { fix: entry.fixHint } : {}),
  })
}

function writeProviderRepairSummary(
  deps: Pick<OuroCliDeps, "writeStdout">,
  title: string,
  degraded: DegradedAgent[],
): void {
  const blocks = degraded.map((entry) => renderReadinessIssueNextSteps(readinessIssueFromDegraded(entry)).join("\n"))
  deps.writeStdout([title, ...blocks].join("\n\n"))
}

function providerRepairCountSummary(count: number): string {
  if (count === 0) return "ok"
  return `${count} ${count === 1 ? "needs" : "need"} attention`
}

async function reportPostRepairProviderHealth(
  deps: OuroCliDeps,
  repairedAgents: string[],
): Promise<DegradedAgent[]> {
  const remainingDegraded = await checkAgentProviders(deps, repairedAgents)

  emitNervesEvent({
    level: remainingDegraded.length > 0 ? "warn" : "info",
    component: "daemon",
    event: "daemon.post_repair_provider_check",
    message: remainingDegraded.length > 0
      ? "post-repair provider health check still degraded"
      : "post-repair provider health check recovered",
    meta: { degradedCount: remainingDegraded.length, repairedAgents },
  })

  if (remainingDegraded.length === 0) {
    deps.writeStdout("All set. Provider checks recovered after repair.")
    return remainingDegraded
  }

  writeProviderRepairSummary(deps, "Still needs attention", remainingDegraded)
  deps.writeStdout("Run `ouro up` again after these are fixed.")
  return remainingDegraded
}

async function checkProviderHealthBeforeChat(
  agentName: string,
  deps: OuroCliDeps,
): Promise<{ ok: true } | { ok: false; output: string }> {
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  const result = await checkAgentProviderHealth(agentName, bundlesRoot, deps)
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

export async function ensureDaemonRunning(
  deps: OuroCliDeps,
  options: { initialAlive?: boolean } = {},
): Promise<EnsureDaemonResult> {
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

  const alive = options.initialAlive ?? await deps.checkSocketAlive(deps.socketPath)
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

// ── Manual-clone detection ──

export interface ManualCloneCheckDeps {
  bundlesRoot: string
  promptInput?: (question: string) => Promise<string>
}

export async function checkManualCloneBundles(deps: ManualCloneCheckDeps): Promise<void> {
  if (!deps.promptInput) return

  let entries: string[]
  try {
    entries = fs.readdirSync(deps.bundlesRoot).filter((e) => e.endsWith(".ouro"))
  } catch {
    return
  }

  for (const agentDir of entries) {
    const bundlePath = path.join(deps.bundlesRoot, agentDir)
    const gitDir = path.join(bundlePath, ".git")

    if (!fs.existsSync(gitDir)) continue

    // Check for remotes
    let remoteOutput: string
    try {
      remoteOutput = execFileSync("git", ["remote", "-v"], { cwd: bundlePath, stdio: "pipe" }).toString().trim()
    } catch {
      continue
    }

    if (!remoteOutput) continue

    // Check if sync is already enabled
    const agentJsonPath = path.join(bundlePath, "agent.json")
    if (fs.existsSync(agentJsonPath)) {
      try {
        const raw = fs.readFileSync(agentJsonPath, "utf-8")
        const config = JSON.parse(raw) as { sync?: { enabled?: boolean } }
        if (config.sync?.enabled) continue
      } catch {
        // Can't read agent.json — skip
        continue
      }
    }

    // Parse first remote name
    const firstLine = remoteOutput.split("\n")[0]
    /* v8 ignore next -- defensive fallback: .trim() above strips leading tabs so empty-field path is unreachable @preserve */
    const remoteName = firstLine.split("\t")[0] || "origin"

    emitNervesEvent({
      component: "daemon",
      event: "daemon.manual_clone_detected",
      message: "bundle appears to be a manually cloned git repo",
      meta: { agent: agentDir, remote: remoteName },
    })

    /* v8 ignore next -- ?? fallback: promptInput always returns string in practice @preserve */
    const answer = (await deps.promptInput(
      `Bundle ${agentDir} appears to be a git clone with a remote. Enable sync? (y/n): `,
    )) ?? ""

    if (answer.trim().toLowerCase() === "y" && fs.existsSync(agentJsonPath)) {
      const raw = fs.readFileSync(agentJsonPath, "utf-8")
      const config = JSON.parse(raw) as Record<string, unknown>
      config.sync = { enabled: true, remote: remoteName }
      fs.writeFileSync(agentJsonPath, JSON.stringify(config, null, 2) + "\n")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.manual_clone_sync_enabled",
        message: "sync enabled for manually cloned bundle",
        meta: { agent: agentDir, remote: remoteName },
      })
    } else {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.manual_clone_sync_skipped",
        message: "user declined sync for manually cloned bundle",
        meta: { agent: agentDir },
      })
    }
  }
}

// ── toDaemonCommand ──

function toDaemonCommand(command: Exclude<OuroCliCommand, { kind: "daemon.up" } | { kind: "daemon.dev" } | { kind: "daemon.logs.prune" } | { kind: "outlook" } | { kind: "hatch.start" } | AuthCliCommand | AuthVerifyCliCommand | AuthSwitchCliCommand | ProviderCliCommand | RepairCliCommand | VaultCliCommand | TaskCliCommand | ReminderCliCommand | FriendCliCommand | WhoamiCliCommand | SessionCliCommand | ThoughtsCliCommand | ChangelogCliCommand | ConfigModelCliCommand | ConfigModelsCliCommand | RollbackCliCommand | VersionsCliCommand | AttentionCliCommand | InnerStatusCliCommand | McpServeCliCommand | SetupCliCommand | HookCliCommand | HabitLocalCliCommand | DoctorCliCommand | CloneCliCommand | HelpCliCommand | { kind: "bluebubbles.replay" } | { kind: "connect" }>): DaemonCommand {
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
    onProgress: deps.writeStdout,
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
  return providerCredentialMachineHomeDir(deps.homeDir)
}

function providerCliAgentRoot(command: { agent: string }, deps: OuroCliDeps): string {
  return path.join(deps.bundlesRoot ?? getAgentBundlesRoot(), `${command.agent}.ouro`)
}

function providerCliNow(deps: OuroCliDeps): Date {
  return new Date((deps.now ?? Date.now)())
}

function readAgentSyncConfigForCliMutation(agent: string, deps: OuroCliDeps): { enabled: boolean; remote: string } {
  try {
    const configPath = path.join(providerCliAgentRoot({ agent }, deps), "agent.json")
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { sync?: { enabled?: unknown; remote?: unknown } }
    return {
      enabled: parsed.sync?.enabled === true,
      remote: typeof parsed.sync?.remote === "string" && parsed.sync.remote.trim() ? parsed.sync.remote : "origin",
    }
  } catch {
    /* v8 ignore next -- defensive: post-mutation sync should not break an already-successful CLI repair if agent.json becomes unreadable @preserve */
    return { enabled: false, remote: "origin" }
  }
}

function pushAgentBundleAfterCliMutation(agent: string, deps: OuroCliDeps): string | null {
  const sync = readAgentSyncConfigForCliMutation(agent, deps)
  if (!sync.enabled) return null

  const agentRoot = providerCliAgentRoot({ agent }, deps)
  const result = postTurnPush(agentRoot, { enabled: true, remote: sync.remote })
  if (result.ok) {
    return `bundle sync: ran post-change sync (remote: ${sync.remote})`
  }
  return `bundle sync: could not push bundle changes (${result.error})`
}

function appendBundleSyncSummary(message: string, agent: string, deps: OuroCliDeps): string {
  const syncSummary = pushAgentBundleAfterCliMutation(agent, deps)
  return syncSummary ? `${message}\n${syncSummary}` : message
}

function writeAgentVaultConfig(
  agentName: string,
  configPath: string,
  config: AgentConfig,
  vault: { email: string; serverUrl: string },
): void {
  const nextConfig = {
    ...config,
    vault: {
      email: vault.email,
      serverUrl: vault.serverUrl,
    },
  }
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")
  emitNervesEvent({
    component: "daemon",
    event: "daemon.vault_config_written",
    message: "wrote credential vault locator to agent config",
    meta: { agentName, configPath, email: vault.email, serverUrl: vault.serverUrl },
  })
}

type JsonRecord = Record<string, unknown>

interface VaultRecoverSourceImport {
  sourcePath: string
  providers: Array<{
    provider: AgentProvider
    credentials: Record<string, string | number>
    config: Record<string, string | number>
  }>
  runtimeConfig: RuntimeCredentialConfig
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function cloneJsonRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord
}

function importableCredentialFields(value: unknown): Record<string, string | number> {
  if (!isJsonRecord(value)) return {}
  const result: Record<string, string | number> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue === "string" && fieldValue.trim()) {
      result[key] = fieldValue
    } else if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
      result[key] = fieldValue
    }
  }
  return result
}

function providerImportFromRaw(
  provider: AgentProvider,
  raw: unknown,
): { provider: AgentProvider; credentials: Record<string, string | number>; config: Record<string, string | number> } | null {
  if (!isJsonRecord(raw)) return null
  const hasStructuredFields = isJsonRecord(raw.credentials) || isJsonRecord(raw.config)
  const fields = hasStructuredFields
    ? {
      credentials: importableCredentialFields(raw.credentials),
      config: importableCredentialFields(raw.config),
    }
    : splitProviderCredentialFields(provider, raw)
  if (Object.keys(fields.credentials).length === 0 && Object.keys(fields.config).length === 0) return null
  return { provider, credentials: fields.credentials, config: fields.config }
}

function recoverProviderImports(raw: JsonRecord): VaultRecoverSourceImport["providers"] {
  const providers = isJsonRecord(raw.providers) ? raw.providers : raw
  const imports: VaultRecoverSourceImport["providers"] = []
  for (const [providerName, providerRaw] of Object.entries(providers)) {
    if (!isAgentProvider(providerName)) continue
    const imported = providerImportFromRaw(providerName, providerRaw)
    if (imported) imports.push(imported)
  }
  return imports
}

const RECOVER_RUNTIME_EXCLUDED_TOP_LEVEL = new Set(["providers", "vault", "context", "schemaVersion", "updatedAt"])
const MACHINE_RUNTIME_CONFIG_TOP_LEVEL = new Set(["bluebubbles", "bluebubblesChannel"])

function recoverRuntimeConfig(raw: JsonRecord): RuntimeCredentialConfig {
  const config: RuntimeCredentialConfig = {}
  for (const [key, value] of Object.entries(raw)) {
    if (RECOVER_RUNTIME_EXCLUDED_TOP_LEVEL.has(key) || isAgentProvider(key)) continue
    config[key] = isJsonRecord(value) ? cloneJsonRecord(value) : value
  }
  return config
}

function mergeRuntimeConfig(a: RuntimeCredentialConfig, b: RuntimeCredentialConfig): RuntimeCredentialConfig {
  const merged: RuntimeCredentialConfig = { ...a }
  for (const [key, value] of Object.entries(b)) {
    if (isJsonRecord(merged[key]) && isJsonRecord(value)) {
      merged[key] = mergeRuntimeConfig(merged[key] as RuntimeCredentialConfig, value as RuntimeCredentialConfig)
    } else {
      merged[key] = isJsonRecord(value) ? cloneJsonRecord(value) : value
    }
  }
  return merged
}

function splitRuntimeConfigByScope(config: RuntimeCredentialConfig): {
  agentConfig: RuntimeCredentialConfig
  machineConfig: RuntimeCredentialConfig
} {
  const agentConfig: RuntimeCredentialConfig = {}
  const machineConfig: RuntimeCredentialConfig = {}
  for (const [key, value] of Object.entries(config)) {
    const target = MACHINE_RUNTIME_CONFIG_TOP_LEVEL.has(key) ? machineConfig : agentConfig
    target[key] = isJsonRecord(value) ? cloneJsonRecord(value) : value
  }
  return { agentConfig, machineConfig }
}

function readVaultRecoverSource(sourcePath: string): VaultRecoverSourceImport {
  const resolved = path.resolve(sourcePath)
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown
  } catch (error) {
    const reason = String(error)
    throw new Error(`cannot read vault recover source ${resolved}: ${reason}`)
  }
  if (!isJsonRecord(parsed)) {
    throw new Error(`vault recover source ${resolved} must be a JSON object`)
  }
  return {
    sourcePath: resolved,
    providers: recoverProviderImports(parsed),
    runtimeConfig: recoverRuntimeConfig(parsed),
  }
}

function isGeneratedRepairVaultEmail(email: string): boolean {
  const [local, domain] = email.trim().split("@")
  return domain?.toLowerCase() === "ouro.bot" && /\+(?:replaced|recovered)-\d{14}(?:$|\+)/i.test(local)
}

function defaultRepairVaultEmail(agentName: string, config: AgentConfig): string {
  const configuredEmail = config.vault?.email?.trim()
  if (configuredEmail && !isGeneratedRepairVaultEmail(configuredEmail)) return configuredEmail
  return defaultStableVaultEmail(agentName)
}

function ensureVaultSecretPrompt(promptSecret: OuroCliDeps["promptSecret"], action: "create" | "replace" | "recover" | "unlock"): (question: string) => Promise<string> {
  if (promptSecret) return promptSecret
  throw new Error(`vault ${action} requires an interactive secret prompt that does not echo the vault unlock secret`)
}

function rejectGeneratedVaultUnlockSecret(action: "create" | "replace" | "recover"): never {
  throw new Error(`vault ${action} no longer supports --generate-unlock-secret. Re-run without that flag and enter a human-chosen unlock secret; Ouro will not print vault unlock secrets.`)
}

async function createRepairVaultForAgent(input: {
  action: "replace" | "recover"
  agentName: string
  email: string
  serverUrl: string
  unlockSecret: string
  store?: VaultUnlockStoreKind
  deps: OuroCliDeps
  configPath: string
  config: AgentConfig
}): Promise<{ ok: true; store: ReturnType<typeof storeVaultUnlockSecret> } | { ok: false; message: string }> {
  const result = await createVaultAccount("Ouro credential vault", input.serverUrl, input.email, input.unlockSecret)
  if (!result.success) {
    const message = [
      `vault ${input.action} failed for ${input.agentName}: ${result.error}`,
      "",
      "Could not create the selected vault account.",
      "If this is the existing vault, run:",
      `  ouro vault unlock --agent ${input.agentName}`,
      "If the unlock secret is lost and you intentionally need a different vault account, rerun with --email <email>.",
      "If this looks like a server or network issue, check --server and retry.",
    ].join("\n")
    input.deps.writeStdout(message)
    return { ok: false, message }
  }

  writeAgentVaultConfig(input.agentName, input.configPath, input.config, { email: input.email, serverUrl: input.serverUrl })
  const store = storeVaultUnlockSecret({
    agentName: input.agentName,
    email: input.email,
    serverUrl: input.serverUrl,
  }, input.unlockSecret, { homeDir: input.deps.homeDir, store: input.store })
  resetCredentialStore()
  await getCredentialStore(input.agentName).get("__ouro_vault_probe__")
  return { ok: true, store }
}

async function executeVaultUnlock(
  command: Extract<OuroCliCommand, { kind: "vault.unlock" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.agent === "SerpentGuide") {
    throw new Error("SerpentGuide does not have a persistent credential vault. Hatch bootstrap uses selected provider credentials in memory only.")
  }
  const promptSecret = ensureVaultSecretPrompt(deps.promptSecret, "unlock")
  const { config } = readAgentConfigForAgent(command.agent, deps.bundlesRoot)
  const vault = resolveVaultConfig(command.agent, config.vault)
  const unlockSecret = await promptSecret(`Ouro vault unlock secret for ${vault.email}: `)
  const store = storeVaultUnlockSecret({
    agentName: command.agent,
    email: vault.email,
    serverUrl: vault.serverUrl,
  }, unlockSecret, { homeDir: deps.homeDir, store: command.store })
  resetCredentialStore()
  await getCredentialStore(command.agent).get("__ouro_vault_probe__")
  const message = [
    `vault unlocked for ${command.agent} on this machine`,
    `vault: ${vault.email} at ${vault.serverUrl}`,
    `local unlock store: ${store.kind}${store.secure ? "" : " (explicit plaintext fallback)"}`,
  ].join("\n")
  deps.writeStdout(message)
  return message
}

async function executeVaultCreate(
  command: Extract<OuroCliCommand, { kind: "vault.create" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.agent === "SerpentGuide") {
    throw new Error("SerpentGuide does not have a persistent credential vault. Create a vault for the hatchling agent, not SerpentGuide.")
  }
  if (command.generateUnlockSecret) rejectGeneratedVaultUnlockSecret("create")
  const { configPath, config } = readAgentConfigForAgent(command.agent, deps.bundlesRoot)
  const configuredVault = resolveVaultConfig(command.agent, config.vault)
  const email = command.email ?? config.vault?.email ?? configuredVault.email
  const promptSecret = ensureVaultSecretPrompt(deps.promptSecret, "create")
  const serverUrl = command.serverUrl ?? config.vault?.serverUrl ?? configuredVault.serverUrl
  const unlockSecret = await promptConfirmedVaultUnlockSecret({
    promptSecret,
    question: `Choose Ouro vault unlock secret for ${email}: `,
    confirmQuestion: `Confirm Ouro vault unlock secret for ${email}: `,
    emptyError: "vault create requires an unlock secret. Re-run in an interactive terminal and enter a human-chosen unlock secret.",
  })
  const result = await createVaultAccount("Ouro credential vault", serverUrl, email, unlockSecret)
  if (!result.success) {
    const message = [
      `vault create failed for ${command.agent}: ${result.error}`,
      "",
      "If this vault account already exists, run:",
      `  ouro vault unlock --agent ${command.agent}`,
    ].join("\n")
    deps.writeStdout(message)
    return message
  }
  writeAgentVaultConfig(command.agent, configPath, config, { email, serverUrl })
  const store = storeVaultUnlockSecret({
    agentName: command.agent,
    email,
    serverUrl,
  }, unlockSecret, { homeDir: deps.homeDir, store: command.store })
  resetCredentialStore()
  await getCredentialStore(command.agent).get("__ouro_vault_probe__")
  const message = appendBundleSyncSummary([
    `vault created for ${command.agent}`,
    `vault: ${email} at ${serverUrl}`,
    `local unlock store: ${store.kind}${store.secure ? "" : " (explicit plaintext fallback)"}`,
    "All raw credentials for this agent will be stored in this Ouro credential vault.",
    "Keep the vault unlock secret saved outside Ouro. Another machine will need it once.",
  ].join("\n"), command.agent, deps)
  deps.writeStdout(message)
  return message
}

async function executeVaultReplace(
  command: Extract<OuroCliCommand, { kind: "vault.replace" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.agent === "SerpentGuide") {
    throw new Error("SerpentGuide does not have a persistent credential vault. Replace the hatchling agent vault, not SerpentGuide.")
  }
  if (command.generateUnlockSecret) rejectGeneratedVaultUnlockSecret("replace")
  const promptSecret = ensureVaultSecretPrompt(deps.promptSecret, "replace")
  const { configPath, config } = readAgentConfigForAgent(command.agent, deps.bundlesRoot)
  const configuredVault = resolveVaultConfig(command.agent, config.vault)
  const email = command.email ?? defaultRepairVaultEmail(command.agent, config)
  const serverUrl = command.serverUrl ?? config.vault?.serverUrl ?? configuredVault.serverUrl
  const unlockSecret = await promptConfirmedVaultUnlockSecret({
    promptSecret,
    question: `Choose new Ouro vault unlock secret for ${email}: `,
    confirmQuestion: `Confirm new Ouro vault unlock secret for ${email}: `,
    emptyError: "vault replace requires an unlock secret. Re-run in an interactive terminal and enter a human-chosen unlock secret.",
  })

  const repair = await createRepairVaultForAgent({
    action: "replace",
    agentName: command.agent,
    email,
    serverUrl,
    unlockSecret,
    store: command.store,
    deps,
    configPath,
    config,
  })
  if (!repair.ok) return repair.message

  const message = appendBundleSyncSummary([
    `vault replaced for ${command.agent}`,
    `vault: ${email} at ${serverUrl}`,
    `local unlock store: ${repair.store.kind}${repair.store.secure ? "" : " (explicit plaintext fallback)"}`,
    "imported: none",
    `next: ouro repair --agent ${command.agent}`,
    "Keep the vault unlock secret saved outside Ouro. Another machine will need it once.",
  ].join("\n"), command.agent, deps)
  deps.writeStdout(message)
  return message
}

async function executeVaultRecover(
  command: Extract<OuroCliCommand, { kind: "vault.recover" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.agent === "SerpentGuide") {
    throw new Error("SerpentGuide does not have a persistent credential vault. Recover the hatchling agent vault, not SerpentGuide.")
  }
  if (command.generateUnlockSecret) rejectGeneratedVaultUnlockSecret("recover")
  const sourceImports = command.sources.map(readVaultRecoverSource)
  const promptSecret = ensureVaultSecretPrompt(deps.promptSecret, "recover")
  const now = providerCliNow(deps)
  const { configPath, config } = readAgentConfigForAgent(command.agent, deps.bundlesRoot)
  const configuredVault = resolveVaultConfig(command.agent, config.vault)
  const email = command.email ?? defaultRepairVaultEmail(command.agent, config)
  const serverUrl = command.serverUrl ?? config.vault?.serverUrl ?? configuredVault.serverUrl
  const unlockSecret = await promptConfirmedVaultUnlockSecret({
    promptSecret,
    question: `Choose new Ouro vault unlock secret for ${email}: `,
    confirmQuestion: `Confirm new Ouro vault unlock secret for ${email}: `,
    emptyError: "vault recover requires an unlock secret. Re-run in an interactive terminal and enter a human-chosen unlock secret.",
  })

  const repair = await createRepairVaultForAgent({
    action: "recover",
    agentName: command.agent,
    email,
    serverUrl,
    unlockSecret,
    store: command.store,
    deps,
    configPath,
    config,
  })
  if (!repair.ok) return repair.message

  const importedProviders = new Set<AgentProvider>()
  let mergedRecoveredRuntimeConfig: RuntimeCredentialConfig = {}
  for (const source of sourceImports) {
    for (const provider of source.providers) {
      await upsertProviderCredential({
        agentName: command.agent,
        provider: provider.provider,
        credentials: provider.credentials,
        config: provider.config,
        provenance: { source: "manual" },
        now,
      })
      importedProviders.add(provider.provider)
    }
    mergedRecoveredRuntimeConfig = mergeRuntimeConfig(mergedRecoveredRuntimeConfig, source.runtimeConfig)
  }

  const { agentConfig: mergedRuntimeConfig, machineConfig: mergedMachineRuntimeConfig } =
    splitRuntimeConfigByScope(mergedRecoveredRuntimeConfig)
  const runtimeFields = summarizeRuntimeConfigFields(mergedRuntimeConfig)
  const machineRuntimeFields = summarizeRuntimeConfigFields(mergedMachineRuntimeConfig)
  if (runtimeFields.length > 0) {
    await upsertRuntimeCredentialConfig(command.agent, mergedRuntimeConfig, now)
  }
  if (machineRuntimeFields.length > 0) {
    await upsertMachineRuntimeCredentialConfig(command.agent, currentMachineId(deps), mergedMachineRuntimeConfig, now)
  }
  const providerList = [...importedProviders].sort()
  const message = appendBundleSyncSummary([
    `vault recovered for ${command.agent}`,
    `vault: ${email} at ${serverUrl}`,
    `local unlock store: ${repair.store.kind}${repair.store.secure ? "" : " (explicit plaintext fallback)"}`,
    `sources imported: ${sourceImports.length}`,
    `provider credentials imported: ${providerList.length === 0 ? "none" : providerList.join(", ")}`,
    `runtime credentials imported: ${runtimeFields.length === 0 ? "none" : runtimeFields.join(", ")}`,
    `machine runtime credentials imported: ${machineRuntimeFields.length === 0 ? "none" : machineRuntimeFields.join(", ")}`,
    "credential values were not printed",
    "Keep the vault unlock secret saved outside Ouro. Another machine will need it once.",
  ].join("\n"), command.agent, deps)
  deps.writeStdout(message)
  return message
}

async function executeVaultStatus(
  command: Extract<OuroCliCommand, { kind: "vault.status" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.agent === "SerpentGuide") {
    const message = "SerpentGuide has no persistent credential vault. Hatch bootstrap uses selected provider credentials in memory only."
    deps.writeStdout(message)
    return message
  }
  const { config } = readAgentConfigForAgent(command.agent, deps.bundlesRoot)
  const vault = resolveVaultConfig(command.agent, config.vault)
  if (!config.vault) {
    const lines = [
      `agent: ${command.agent}`,
      `vault: ${vault.email} at ${vault.serverUrl}`,
      "vault locator: not configured in agent.json",
      "local unlock: not checked",
      "",
      `fix: Run 'ouro vault create --agent ${command.agent}' to create this agent's vault, then run 'ouro auth --agent ${command.agent} --provider <provider>' and 'ouro provider refresh --agent ${command.agent}'.`,
    ]
    const message = lines.join("\n")
    deps.writeStdout(message)
    return message
  }
  const status = getVaultUnlockStatus({
    agentName: command.agent,
    email: vault.email,
    serverUrl: vault.serverUrl,
  }, { homeDir: deps.homeDir, store: command.store })

  const lines = [
    `agent: ${command.agent}`,
    `vault: ${vault.email} at ${vault.serverUrl}`,
    "vault locator: agent.json",
    `local unlock store: ${status.store ? `${status.store.kind}${status.store.secure ? "" : " (explicit plaintext fallback)"}` : "unavailable"}`,
    `local unlock: ${status.stored ? "available" : "missing"}`,
  ]

  if (status.stored) {
    const runtime = await refreshRuntimeCredentialConfig(command.agent, { preserveCachedOnFailure: true })
    if (runtime.ok) {
      lines.push(`runtime credentials: ${summarizeRuntimeConfigFields(runtime.config).join(", ") || "none stored"} (${runtime.revision})`)
    } else {
      lines.push(`runtime credentials: ${runtime.reason} (${runtime.error})`)
      if (runtime.reason === "missing") {
        lines.push(`  fix: Run 'ouro vault config set --agent ${command.agent} --key <field>' to store sense/integration credentials.`)
      }
    }
    const pool = await refreshProviderCredentialPool(command.agent)
    if (pool.ok) {
      const summary = summarizeProviderCredentialPool(pool.pool)
      lines.push(`provider credentials: ${summary.providers.length === 0 ? "none stored" : ""}`)
      for (const provider of summary.providers) {
        lines.push(`  ${provider.provider}: credential fields ${provider.credentialFields.join(", ") || "none"}, config fields ${provider.configFields.join(", ") || "none"}`)
      }
    } else {
      lines.push(`provider credentials: unavailable (${pool.error})`)
    }
  } else {
    lines.push("")
    lines.push(status.fix)
  }

  const message = lines.join("\n")
  deps.writeStdout(message)
  return message
}

const RUNTIME_CONFIG_KEY_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/
const FORBIDDEN_RUNTIME_CONFIG_KEY_SEGMENTS = new Set(["__proto__", "prototype", "constructor"])

function parseRuntimeConfigKey(key: string): string[] {
  const segments = key.split(".").map((segment) => segment.trim()).filter(Boolean)
  if (segments.length < 2) {
    throw new Error("runtime config key must be a dotted path such as bluebubbles.password")
  }
  for (const segment of segments) {
    if (!RUNTIME_CONFIG_KEY_SEGMENT.test(segment) || FORBIDDEN_RUNTIME_CONFIG_KEY_SEGMENTS.has(segment)) {
      throw new Error(`invalid runtime config key segment '${segment}'`)
    }
  }
  return segments
}

function setRuntimeConfigValue(
  config: RuntimeCredentialConfig,
  key: string,
  value: string,
): RuntimeCredentialConfig {
  const segments = parseRuntimeConfigKey(key)
  const next: RuntimeCredentialConfig = JSON.parse(JSON.stringify(config)) as RuntimeCredentialConfig
  let cursor: Record<string, unknown> = next
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment]
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]!] = value
  return next
}

function summarizeRuntimeConfigFields(config: RuntimeCredentialConfig): string[] {
  const fields: string[] = []
  const visit = (prefix: string, value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fields.push(prefix)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      visit(prefix ? `${prefix}.${key}` : key, child)
    }
  }
  visit("", config)
  return fields.filter(Boolean).sort()
}

function isSensitiveRuntimeConfigKey(key: string): boolean {
  const lastSegment = key.split(".").pop()!
  return /(password|secret|token|api[-_]?key|key)$/i.test(lastSegment)
}

function currentMachineId(deps: OuroCliDeps): string {
  return loadOrCreateMachineIdentity({
    homeDir: providerCliHomeDir(deps),
    now: () => providerCliNow(deps),
  }).machineId
}

async function promptRuntimeConfigValue(
  command: Extract<OuroCliCommand, { kind: "vault.config.set" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.value !== undefined) return command.value
  if (isSensitiveRuntimeConfigKey(command.key)) {
    if (!deps.promptSecret) {
      throw new Error("secret entry requires an interactive terminal so the value can be hidden. Re-run without --value in a terminal, or pass --value only from a trusted non-logged script.")
    }
    return deps.promptSecret(`Value for ${command.key}: `)
  }
  const prompt = deps.promptInput
  return prompt ? prompt(`Value for ${command.key}: `) : ""
}

function runtimeScopeLabel(scope: RuntimeConfigScope): string {
  return scope === "machine" ? "this machine's vault runtime config item" : "the agent vault runtime/config item"
}

async function storeRuntimeConfigKey(input: {
  agent: string
  key: string
  value: string
  scope: RuntimeConfigScope
  deps: OuroCliDeps
}): Promise<{ revision: string; itemPath: string; machineId?: string }> {
  const machineId = input.scope === "machine" ? currentMachineId(input.deps) : undefined
  const current = input.scope === "machine"
    ? await refreshMachineRuntimeCredentialConfig(input.agent, machineId!, { preserveCachedOnFailure: true })
    : await refreshRuntimeCredentialConfig(input.agent, { preserveCachedOnFailure: true })
  if (!current.ok && current.reason !== "missing") {
    throw new Error(`cannot read existing runtime credentials from ${current.itemPath}: ${current.error}`)
  }
  const nextConfig = setRuntimeConfigValue(current.ok ? current.config : {}, input.key, input.value)
  const stored = input.scope === "machine"
    ? await upsertMachineRuntimeCredentialConfig(input.agent, machineId!, nextConfig, providerCliNow(input.deps))
    : await upsertRuntimeCredentialConfig(input.agent, nextConfig, providerCliNow(input.deps))
  return { revision: stored.revision, itemPath: stored.itemPath, ...(machineId ? { machineId } : {}) }
}

async function executeVaultConfigSet(
  command: Extract<OuroCliCommand, { kind: "vault.config.set" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.agent === "SerpentGuide") {
    throw new Error("SerpentGuide does not have persistent runtime credentials. Store credentials in the hatchling agent vault.")
  }
  const scope = command.scope ?? "agent"
  const value = await promptRuntimeConfigValue(command, deps)
  if (!value) {
    throw new Error("vault config set requires --value <value> or an interactive prompt")
  }
  const stored = await storeRuntimeConfigKey({
    agent: command.agent,
    key: command.key,
    value,
    scope,
    deps,
  })
  const message = [
    `stored ${command.key} for ${command.agent} in ${runtimeScopeLabel(scope)}`,
    `runtime credentials: ${stored.revision}`,
    `item: ${stored.itemPath}`,
    "value was not printed",
  ].join("\n")
  deps.writeStdout(message)
  return message
}

async function executeVaultConfigStatus(
  command: Extract<OuroCliCommand, { kind: "vault.config.status" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.agent === "SerpentGuide") {
    const message = "SerpentGuide has no persistent runtime credentials. Hatch bootstrap stores selected credentials in the hatchling vault."
    deps.writeStdout(message)
    return message
  }
  const scopes = command.scope === "all" ? ["agent", "machine"] as const : [command.scope ?? "agent"] as const
  const lines = [`agent: ${command.agent}`]
  for (const scope of scopes) {
    const machineId = scope === "machine" ? currentMachineId(deps) : undefined
    const runtime = scope === "machine"
      ? await refreshMachineRuntimeCredentialConfig(command.agent, machineId!, { preserveCachedOnFailure: true })
      : await refreshRuntimeCredentialConfig(command.agent, { preserveCachedOnFailure: true })
    if (scopes.length > 1) lines.push("")
    lines.push(`${scope} runtime config item: ${runtime.itemPath}`)
    if (runtime.ok) {
      lines.push(`status: available (${runtime.revision})`)
      const fields = summarizeRuntimeConfigFields(runtime.config)
      lines.push(`fields: ${fields.length === 0 ? "none stored" : fields.join(", ")}`)
    } else {
      lines.push(`status: ${runtime.reason}`)
      lines.push(`error: ${runtime.error}`)
      lines.push(runtime.reason === "missing"
        ? `fix: Run 'ouro vault config set --agent ${command.agent} --key <field>${scope === "machine" ? " --scope machine" : ""}' to store runtime credentials.`
        : `fix: ${vaultUnlockReplaceRecoverFix(command.agent, "Then retry 'ouro vault config status'.")}`)
    }
  }
  const message = lines.join("\n")
  deps.writeStdout(message)
  return message
}

function requirePromptSecret(deps: OuroCliDeps, purpose: string): (question: string) => Promise<string> {
  if (deps.promptSecret) return deps.promptSecret
  throw new Error(`${purpose} requires an interactive terminal so the secret can be hidden.`)
}

function requirePromptInput(deps: OuroCliDeps, purpose: string): (question: string) => Promise<string> {
  if (deps.promptInput) return deps.promptInput
  throw new Error(`${purpose} requires an interactive terminal.`)
}

function parseOptionalPort(value: string, fallback: number, label: string): number {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return parsed
}

function parseOptionalPositiveInteger(value: string, fallback: number, label: string): number {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function normalizeWebhookPath(value: string, fallback: string): string {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function enableAgentSense(agent: string, sense: "bluebubbles", deps: OuroCliDeps): void {
  const { configPath } = readAgentConfigForAgent(agent, deps.bundlesRoot)
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
  const senses = raw.senses && typeof raw.senses === "object" && !Array.isArray(raw.senses)
    ? raw.senses as Record<string, unknown>
    : {}
  const existing = senses[sense] && typeof senses[sense] === "object" && !Array.isArray(senses[sense])
    ? senses[sense] as Record<string, unknown>
    : {}
  raw.senses = {
    ...senses,
    cli: senses.cli ?? { enabled: true },
    teams: senses.teams ?? { enabled: false },
    [sense]: { ...existing, enabled: true },
  }
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8")
}

function connectMenu(agent: string): string {
  return [
    `Connect ${agent}`,
    "",
    "Portable agent capabilities",
    "  1. Perplexity search",
    "     stores: agent vault runtime/config -> integrations.perplexityApiKey",
    "",
    "This machine only",
    "  2. BlueBubbles iMessage",
    "     stores: agent vault runtime/machines/<this-machine>/config",
    "",
    "Model providers",
    "  3. Provider auth",
    `     runs separately: ouro auth --agent ${agent} --provider <provider>`,
    "",
    "  4. Cancel",
    "",
    "Choose [1-4]: ",
  ].join("\n")
}

async function executeConnectPerplexity(agent: string, deps: OuroCliDeps): Promise<string> {
  if (agent === "SerpentGuide") {
    throw new Error("SerpentGuide has no persistent runtime credentials. Connect Perplexity on the hatchling agent instead.")
  }
  const promptSecret = requirePromptSecret(deps, "Perplexity API key entry")
  const key = (await promptSecret("Perplexity API key: ")).trim()
  if (!key) throw new Error("Perplexity API key cannot be blank")
  const stored = await storeRuntimeConfigKey({
    agent,
    key: "integrations.perplexityApiKey",
    value: key,
    scope: "agent",
    deps,
  })
  const message = [
    `Perplexity connected for ${agent}`,
    "capability: Perplexity search",
    `stored: ${stored.itemPath}`,
    "secret was not printed",
    "",
    "Next: ask the agent to search, or run `ouro up` again if the daemon was already running.",
  ].join("\n")
  deps.writeStdout(message)
  return message
}

async function executeConnectBlueBubbles(agent: string, deps: OuroCliDeps): Promise<string> {
  if (agent === "SerpentGuide") {
    throw new Error("SerpentGuide has no persistent runtime credentials. Attach BlueBubbles on the hatchling agent instead.")
  }
  const promptInput = requirePromptInput(deps, "BlueBubbles setup")
  const promptSecret = requirePromptSecret(deps, "BlueBubbles password entry")
  const serverUrl = (await promptInput("BlueBubbles server URL for this machine: ")).trim()
  if (!serverUrl) throw new Error("BlueBubbles server URL cannot be blank")
  const password = (await promptSecret("BlueBubbles app password: ")).trim()
  if (!password) throw new Error("BlueBubbles app password cannot be blank")
  const port = parseOptionalPort(await promptInput("Local webhook port [18790]: "), 18790, "BlueBubbles webhook port")
  const webhookPath = normalizeWebhookPath(await promptInput("Local webhook path [/bluebubbles-webhook]: "), "/bluebubbles-webhook")
  const requestTimeoutMs = parseOptionalPositiveInteger(await promptInput("Request timeout ms [30000]: "), 30000, "BlueBubbles request timeout")
  const machineId = currentMachineId(deps)

  const current = await refreshMachineRuntimeCredentialConfig(agent, machineId, { preserveCachedOnFailure: true })
  if (!current.ok && current.reason !== "missing") {
    throw new Error(`cannot read existing machine runtime credentials from ${current.itemPath}: ${current.error}`)
  }
  const nextConfig: RuntimeCredentialConfig = {
    ...(current.ok ? current.config : {}),
    bluebubbles: {
      serverUrl,
      password,
      accountId: "default",
    },
    bluebubblesChannel: {
      port,
      webhookPath,
      requestTimeoutMs,
    },
  }
  const stored = await upsertMachineRuntimeCredentialConfig(agent, machineId, nextConfig, providerCliNow(deps))
  enableAgentSense(agent, "bluebubbles", deps)

  const message = appendBundleSyncSummary([
    `BlueBubbles attached for ${agent} on this machine`,
    `machine: ${machineId}`,
    `stored: ${stored.itemPath}`,
    "agent.json: senses.bluebubbles.enabled = true",
    "secret was not printed",
    "",
    "Next: point BlueBubbles at this machine's webhook, then run `ouro up`.",
  ].join("\n"), agent, deps)
  deps.writeStdout(message)
  return message
}

async function executeConnect(
  command: Extract<OuroCliCommand, { kind: "connect" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.target === "perplexity") return executeConnectPerplexity(command.agent, deps)
  if (command.target === "bluebubbles") return executeConnectBlueBubbles(command.agent, deps)

  const promptInput = deps.promptInput
  if (!promptInput) {
    const message = [
      connectMenu(command.agent).replace(/\nChoose \[1-4\]: $/, ""),
      "",
      `Run: ouro connect perplexity --agent ${command.agent}`,
      `Or:  ouro connect bluebubbles --agent ${command.agent}`,
    ].join("\n")
    deps.writeStdout(message)
    return message
  }
  const answer = (await promptInput(connectMenu(command.agent))).trim().toLowerCase()
  if (answer === "1" || answer === "perplexity" || answer === "perplexity-search") {
    return executeConnectPerplexity(command.agent, deps)
  }
  if (answer === "2" || answer === "bluebubbles" || answer === "imessage" || answer === "messages") {
    return executeConnectBlueBubbles(command.agent, deps)
  }
  if (answer === "3" || answer === "provider" || answer === "providers" || answer === "auth") {
    const message = [
      "Provider auth is its own flow:",
      `  ouro auth --agent ${command.agent} --provider <provider>`,
      "",
      "Use `ouro connect` for integrations and local senses after provider auth is ready.",
    ].join("\n")
    deps.writeStdout(message)
    return message
  }
  const message = "connect cancelled."
  deps.writeStdout(message)
  return message
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

async function readProviderCredentialRecord(
  agent: string,
  provider: AgentProvider,
  _deps: OuroCliDeps,
): Promise<{ ok: true; record: ProviderCredentialRecord } | { ok: false; reason: "missing" | "invalid" | "unavailable"; poolPath: string; error: string }> {
  const poolResult = await refreshProviderCredentialPool(agent)
  if (poolResult.ok) {
    const existing = poolResult.pool.providers[provider]
    if (existing) return { ok: true, record: existing }
  } else if (poolResult.reason === "invalid" || poolResult.reason === "unavailable") {
    return { ok: false, reason: poolResult.reason, poolPath: poolResult.poolPath, error: poolResult.error }
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
  const credential = await readProviderCredentialRecord(command.agent, command.provider, deps)
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
  const credential = await readProviderCredentialRecord(command.agent, binding.provider, deps)
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
    const credentialFields = credential.credentialFields.length > 0 ? ` credentials: ${credential.credentialFields.join(", ")}` : " credentials: none"
    const configFields = credential.configFields.length > 0 ? ` config: ${credential.configFields.join(", ")}` : " config: none"
    return `credentials: present in vault (${credential.source}; ${credential.revision};${credentialFields};${configFields})`
  }
  if (credential.status === "invalid-pool") {
    return `credentials: vault unavailable (${credential.error}); repair: ${credential.repair.command}`
  }
  return `credentials: missing; repair: ${credential.repair.command}`
}

async function executeProviderStatus(
  command: Extract<OuroCliCommand, { kind: "provider.status" }>,
  deps: OuroCliDeps,
): Promise<string> {
  const agentRoot = providerCliAgentRoot(command, deps)
  await refreshProviderCredentialPool(command.agent)
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

async function executeProviderRefresh(
  command: Extract<OuroCliCommand, { kind: "provider.refresh" }>,
  deps: OuroCliDeps,
): Promise<string> {
  if (command.agent === "SerpentGuide") {
    const message = "SerpentGuide has no persistent provider credentials to refresh. Hatch bootstrap uses selected credentials in memory only."
    deps.writeStdout(message)
    return message
  }

  const pool = await refreshProviderCredentialPool(command.agent)
  const lines: string[] = []
  if (pool.ok) {
    const summary = summarizeProviderCredentialPool(pool.pool)
    lines.push(`refreshed provider credential snapshot for ${command.agent}`)
    lines.push(`providers: ${summary.providers.map((provider) => provider.provider).join(", ") || "none"}`)
  } else {
    lines.push(`provider credential refresh failed for ${command.agent}: ${pool.error}`)
    lines.push(vaultUnlockReplaceRecoverFix(command.agent, "Then retry 'ouro provider refresh'."))
    const message = lines.join("\n")
    deps.writeStdout(message)
    return message
  }

  try {
    const alive = await deps.checkSocketAlive(deps.socketPath)
    if (alive) {
      const response = await deps.sendCommand(deps.socketPath, { kind: "agent.restart", agent: command.agent })
      if (response.ok) {
        lines.push(`restarted ${command.agent} so the running agent reloads credentials`)
      } else {
        lines.push(`daemon restart skipped: ${response.error ?? response.message ?? "unknown daemon error"}`)
      }
    } else {
      lines.push("daemon is not running; the next start will load the refreshed snapshot")
    }
  } catch (error) {
    lines.push(`daemon restart skipped: ${error instanceof Error ? error.message : String(error)}`)
  }

  const message = lines.join("\n")
  deps.writeStdout(message)
  return message
}

async function readinessReportForAgent(agent: string, deps: OuroCliDeps): Promise<AgentReadinessReport> {
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  try {
    const result = await checkAgentProviderHealth(agent, bundlesRoot, deps)
    if (result.ok) {
      return { agent, ok: true, issues: [] }
    }
    else {
      const issue = result.issue ?? genericReadinessIssue({
        summary: result.error ?? `${agent} is not ready.`,
        ...(result.fix ? { fix: result.fix } : {}),
      })
      return { agent, ok: false, issues: [issue] }
    }
  } catch (error) {
    return {
      agent,
      ok: false,
      issues: [genericReadinessIssue({
        summary: `${agent} readiness check failed.`,
        detail: error instanceof Error ? error.message : String(error),
        fix: "Run 'ouro doctor' for diagnostics, then retry 'ouro repair'.",
      })],
    }
  }
}

async function executeReadinessRepairAction(
  agent: string,
  action: RepairAction,
  deps: OuroCliDeps,
): Promise<void> {
  if (action.kind === "vault-create") {
    await executeVaultCreate({ kind: "vault.create", agent }, deps)
    return
  }
  if (action.kind === "vault-unlock") {
    await executeVaultUnlock({ kind: "vault.unlock", agent }, deps)
    return
  }
  if (action.kind === "vault-replace") {
    await executeVaultReplace({ kind: "vault.replace", agent }, deps)
    return
  }
  if (action.kind === "provider-auth") {
    const provider = action.provider
    const authRunner = deps.runAuthFlow ?? runRuntimeAuthFlow
    const result = await authRunner({
      agentName: agent,
      provider,
      promptInput: deps.promptInput,
      onProgress: deps.writeStdout,
    })
    deps.writeStdout(result.message)
    await executeProviderRefresh({ kind: "provider.refresh", agent }, deps)
    return
  }
  deps.writeStdout(`manual step for ${agent}: ${action.command}`)
}

async function executeRepair(
  command: Extract<OuroCliCommand, { kind: "repair" }>,
  deps: OuroCliDeps,
): Promise<string> {
  const agents = command.agent
    ? [command.agent]
    : await listCliAgents(deps)
  const uniqueAgents = [...new Set(agents)]
  const lines: string[] = []
  const repairDeps: OuroCliDeps = {
    ...deps,
    writeStdout: (text: string) => {
      lines.push(text)
      deps.writeStdout(text)
    },
  }

  if (uniqueAgents.length === 0) {
    const message = "no agents found to repair."
    repairDeps.writeStdout(message)
    return message
  }

  else {
    const reports = await Promise.all(uniqueAgents.map((agent) => readinessReportForAgent(agent, repairDeps)))
    for (const report of reports) {
      if (report.ok) {
        repairDeps.writeStdout(`${report.agent}: ready`)
      }
    }
    await runGuidedReadinessRepair(reports, {
      promptInput: deps.promptInput,
      writeStdout: repairDeps.writeStdout,
      runRepairAction: async (agentName, action) => executeReadinessRepairAction(agentName, action, repairDeps),
    })
    return lines.join("\n")
  }
}

function readinessReportsFromDegraded(degraded: DegradedAgent[]): AgentReadinessReport[] {
  return degraded.map((entry) => ({
    agent: entry.agent,
    ok: false,
    issues: [readinessIssueFromDegraded(entry)],
  }))
}

function degradedEntrySignature(entry: DegradedAgent): string {
  const issue = readinessIssueFromDegraded(entry)
  return JSON.stringify({
    agent: entry.agent,
    kind: issue.kind,
    summary: issue.summary,
    detail: issue.detail ?? "",
    actions: issue.actions.map((action) => `${action.kind}:${action.command}:${action.executable === false ? "manual" : "run"}`),
  })
}

function mergeRemainingDegraded(
  untouched: DegradedAgent[],
  rechecked: DegradedAgent[],
): DegradedAgent[] {
  const byAgent = new Map<string, DegradedAgent>()
  for (const entry of untouched) byAgent.set(entry.agent, entry)
  for (const entry of rechecked) byAgent.set(entry.agent, entry)
  return [...byAgent.values()]
}

async function runReadinessRepairForDegraded(
  degraded: DegradedAgent[],
  deps: OuroCliDeps,
): Promise<{ repairsAttempted: boolean; remainingDegraded: DegradedAgent[] }> {
  let current = degraded
  let repairsAttempted = false

  for (let pass = 0; pass < 3; pass += 1) {
    const attemptedAgents = new Set<string>()
    const result = await runGuidedReadinessRepair(readinessReportsFromDegraded(current), {
      promptInput: deps.promptInput,
      writeStdout: deps.writeStdout,
      onActionAttempted: (agentName) => {
        attemptedAgents.add(agentName)
      },
      runRepairAction: async (agentName, action) => executeReadinessRepairAction(agentName, action, deps),
    })
    if (!result.repairsAttempted) {
      return { repairsAttempted, remainingDegraded: current }
    }
    repairsAttempted = true
    /* v8 ignore next -- onActionAttempted runs before any runnable repair action, so repairsAttempted implies at least one attempted agent @preserve */
    if (attemptedAgents.size === 0) {
      return { repairsAttempted, remainingDegraded: current }
    }

    const previousByAgent = new Map<string, string>()
    for (const entry of current) {
      if (attemptedAgents.has(entry.agent)) {
        previousByAgent.set(entry.agent, degradedEntrySignature(entry))
      }
    }
    const untouched = current.filter((entry) => !attemptedAgents.has(entry.agent))
    const rechecked = await checkAgentProviders(deps, [...attemptedAgents])
    const remaining = mergeRemainingDegraded(untouched, rechecked)
    if (remaining.length === 0) {
      return { repairsAttempted, remainingDegraded: remaining }
    }

    const nextPrompt = rechecked.filter((entry) => previousByAgent.get(entry.agent) !== degradedEntrySignature(entry))
    if (nextPrompt.length === 0) {
      return { repairsAttempted, remainingDegraded: remaining }
    }
    current = nextPrompt
  }

  return { repairsAttempted, remainingDegraded: current }
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
      force: true,
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
    const credential = await readProviderCredentialRecord(command.agent, "github-copilot", deps)
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
          /* v8 ignore next -- ?? fallback: promptInput always returns string in practice @preserve */
          const remote = (await deps.promptInput("Enter the git remote URL for the agent bundle: "))?.trim() ?? ""
          if (!remote) {
            deps.writeStdout("no remote URL provided — skipping clone")
            // Fall through to hatch flow
          } else {
            return await runOuroCli(["clone", remote], deps)
          }
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

  if (command.kind === "connect") {
    return executeConnect(command, deps)
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
        const message = "no installed version found. run: npx ouro.bot"
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

    // ── manual-clone detection: offer to enable sync for manually cloned bundles ──
    await checkManualCloneBundles({
      bundlesRoot: deps.bundlesRoot ?? bundlesRoot,
      promptInput: deps.promptInput,
    })

    const daemonAliveBeforeStart = await deps.checkSocketAlive(deps.socketPath)
    let providerChecksAlreadyRun = false
    if (!daemonAliveBeforeStart) {
      progress.startPhase("provider checks")
      const preflightProviderDegraded = await checkAgentProviders(deps)
      providerChecksAlreadyRun = true
      progress.completePhase("provider checks", providerRepairCountSummary(preflightProviderDegraded.length))

      if (preflightProviderDegraded.length > 0) {
        progress.end()
        if (command.noRepair) {
          writeProviderRepairSummary(deps, "Provider checks need attention", preflightProviderDegraded)
          const message = "daemon not started: provider checks need repair. Run `ouro repair` or rerun `ouro up` to choose a repair path."
          deps.writeStdout(message)
          return message
        }

        const repairResult = await runReadinessRepairForDegraded(preflightProviderDegraded, deps)
        if (!repairResult.repairsAttempted) {
          writeProviderRepairSummary(deps, "Provider checks still need attention", repairResult.remainingDegraded)
          const message = "daemon not started: provider checks need repair. Run `ouro repair` or rerun `ouro up` to choose a repair path."
          deps.writeStdout(message)
          return message
        }

        const remainingDegraded = repairResult.remainingDegraded
        if (remainingDegraded.length > 0) {
          writeProviderRepairSummary(deps, "Still needs attention", remainingDegraded)
          const message = "daemon not started: provider checks still need repair."
          deps.writeStdout(message)
          return message
        }
        deps.writeStdout("All set. Provider checks recovered after repair.")
      }
    }

    progress.startPhase("starting daemon")
    const daemonResult = await ensureDaemonRunning({
      ...deps,
      reportDaemonStartupPhase: (label) => {
        ;(progress as { announceStep?: (line: string) => void }).announceStep?.(label)
      },
    }, { initialAlive: daemonAliveBeforeStart })
    if (!providerChecksAlreadyRun || daemonResult.alreadyRunning) {
      progress.startPhase("provider checks")
      const providerDegraded = await checkAlreadyRunningAgentProviders(deps)
      daemonResult.stability = mergeStartupStability(daemonResult.stability, providerDegraded)
      progress.completePhase("provider checks", providerRepairCountSummary(providerDegraded.length))
    }
    progress.end()
    deps.writeStdout(daemonResult.message)

    // Interactive repair for degraded agents (Unit 5) — skipped by --no-repair (Unit 6)
    if (daemonResult.stability?.degraded && daemonResult.stability.degraded.length > 0) {
      if (command.noRepair) {
        // --no-repair: write degraded summary and skip interactive repair
        writeProviderRepairSummary(deps, "Provider checks need attention", daemonResult.stability.degraded)
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.no_repair_degraded_summary",
          message: "degraded agents detected with --no-repair, skipping interactive repair",
          meta: { degradedCount: daemonResult.stability.degraded.length },
        })
      } else {
        const repairResult = await runAgenticRepair(daemonResult.stability.degraded, {
          /* v8 ignore start -- production provider discovery wiring @preserve */
          discoverWorkingProvider: async (agentName: string) => {
            const { discoverWorkingProvider: discover } = await import("./provider-discovery")
            const { pingProvider } = await import("../provider-ping")
            return discover({
              agentName,
              pingProvider: pingProvider as unknown as (provider: AgentProvider, config: Record<string, string>) => Promise<import("../provider-ping").PingResult>,
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
            await authRunner({ agentName: agent, provider, promptInput: deps.promptInput, onProgress: deps.writeStdout })
          },
          runVaultUnlock: async (agent: string) => {
            await executeVaultUnlock({ kind: "vault.unlock", agent }, deps)
          },
          skipQueueSummary: true,
        })
        if (repairResult.repairsAttempted) {
          const repairedAgents = daemonResult.stability.degraded
            .filter(hasRunnableInteractiveRepair)
            .map((entry) => entry.agent)
          await reportPostRepairProviderHealth(deps, repairedAgents)
        }
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
          sections.push(`published latest: ${updateResult.latestVersion} (${updateResult.available ? "update available" : "up to date"})`)
        } else if (updateResult.error) {
          sections.push(`published latest: unavailable (${updateResult.error})`)
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        sections.push(`published latest: unavailable (${reason})`)
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

  if (command.kind === "provider.refresh") {
    return executeProviderRefresh(command, deps)
  }

  if (command.kind === "repair") {
    return executeRepair(command, deps)
  }

  if (command.kind === "vault.unlock") {
    return executeVaultUnlock(command, deps)
  }

  if (command.kind === "vault.create") {
    return executeVaultCreate(command, deps)
  }

  if (command.kind === "vault.replace") {
    return executeVaultReplace(command, deps)
  }

  if (command.kind === "vault.recover") {
    return executeVaultRecover(command, deps)
  }

  if (command.kind === "vault.status") {
    return executeVaultStatus(command, deps)
  }

  if (command.kind === "vault.config.set") {
    return executeVaultConfigSet(command, deps)
  }

  if (command.kind === "vault.config.status") {
    return executeVaultConfigStatus(command, deps)
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
      onProgress: deps.writeStdout,
    })
    // Behavior: ouro auth stores credentials only — does NOT switch provider.
    // Use `ouro auth switch` to change the active provider.
    deps.writeStdout(result.message)

    // Verify the credentials actually work by pinging the provider
    /* v8 ignore start -- integration: real API ping after auth @preserve */
    try {
      deps.writeStdout(`verifying ${provider} credentials...`)
      const credential = await readProviderCredentialRecord(command.agent, provider, deps)
      const status = credential.ok
        ? await verifyProviderCredentials(provider, {
          [provider]: { ...credential.record.config, ...credential.record.credentials },
        })
        : `stored but could not be re-read from vault (${credential.error})`
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
    const poolResult = await refreshProviderCredentialPool(command.agent)
    if (!poolResult.ok) {
      const message = `vault unavailable: ${poolResult.error}\n${vaultUnlockReplaceRecoverFix(command.agent, "Then retry 'ouro auth verify'.")}`
      deps.writeStdout(message)
      return message
    }
    if (command.provider) {
      const record = poolResult.pool.providers[command.provider]
      if (!record) {
        const message = `${command.provider}: missing. Run \`ouro auth --agent ${command.agent} --provider ${command.provider}\`.`
        deps.writeStdout(message)
        return message
      }
      const status = await verifyProviderCredentials(command.provider, {
        [command.provider]: { ...record.config, ...record.credentials },
      })
      const message = `${command.provider}: ${status}`
      deps.writeStdout(message)
      return message
    }
    const lines: string[] = []
    for (const [p, record] of Object.entries(poolResult.pool.providers) as Array<[AgentProvider, ProviderCredentialRecord]>) {
      const status = await verifyProviderCredentials(p, {
        [p]: { ...record.config, ...record.credentials },
      })
      lines.push(`${p}: ${status}`)
    }
    if (lines.length === 0) lines.push(`no provider credentials in ${command.agent}'s vault`)
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
    const credential = await readProviderCredentialRecord(command.agent, "github-copilot", deps)
    const ghConfig: Record<string, string | number> = credential.ok
      ? { ...credential.record.config, ...credential.record.credentials }
      : {}
    if (typeof ghConfig.githubToken !== "string" || typeof ghConfig.baseUrl !== "string") {
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
    } catch (lsErr) {
      const stderr = (lsErr as { stderr?: Buffer })?.stderr?.toString() ?? ""
      const isAuth = stderr.includes("Authentication failed")
        || stderr.includes("could not read Username")
        || stderr.includes("terminal prompts disabled")
        || stderr.includes("403")
        || stderr.includes("401")
      const hint = isAuth
        ? `authentication failed for: ${command.remote}\nSet up credentials first:\n  gh auth login          (GitHub repos)\n  git config credential.helper store   (other hosts)`
        : `could not reach remote: ${command.remote}\nCheck the URL and your network connection.`
      deps.writeStdout(hint)
      return hint
    }

    // 5. Clone
    emitNervesEvent({ component: "daemon", event: "daemon.clone_git_clone", message: "cloning agent bundle", meta: { remote: command.remote, targetPath } })
    execFileSync("git", ["clone", command.remote, targetPath], { stdio: "pipe" })

    // 6. Create machine identity
    loadOrCreateMachineIdentity()
    emitNervesEvent({ component: "daemon", event: "daemon.clone_identity_created", message: "machine identity created", meta: {} })

    // 7. Enable sync in agent.json
    const agentJsonPath = path.join(targetPath, "agent.json")
    let syncEnabled = false
    if (fs.existsSync(agentJsonPath)) {
      const raw = fs.readFileSync(agentJsonPath, "utf-8")
      const config = JSON.parse(raw) as Record<string, unknown>
      config.sync = { enabled: true, remote: "origin" }
      fs.writeFileSync(agentJsonPath, JSON.stringify(config, null, 2) + "\n")
      syncEnabled = true
      emitNervesEvent({ component: "daemon", event: "daemon.clone_sync_enabled", message: "sync enabled in agent.json", meta: { agentName } })
    } else {
      emitNervesEvent({ level: "warn", component: "daemon", event: "daemon.clone_no_agent_json", message: "cloned repo has no agent.json — may not be a valid bundle", meta: { agentName, targetPath } })
    }

    // 8. Output success message
    emitNervesEvent({ component: "daemon", event: "daemon.clone_complete", message: "clone complete", meta: { agentName, targetPath } })
    const syncSummary = syncEnabled ? pushAgentBundleAfterCliMutation(agentName, deps) : null
    const syncMsg = syncEnabled ? "\nsync enabled (remote: origin)" : "\nwarning: no agent.json found — this may not be a valid agent bundle"
    const syncPushMsg = syncSummary ? `\n${syncSummary}` : ""
    deps.writeStdout(`cloned ${agentName} to ${targetPath}${syncMsg}${syncPushMsg}`)

    // 9. Guided post-clone flow (when interactive)
    if (deps.promptInput) {
      // Auth
      const authAnswer = await deps.promptInput(`\nSet up provider auth now? (y/n): `) ?? ""
      if (authAnswer.trim().toLowerCase() === "y") {
        emitNervesEvent({ component: "daemon", event: "daemon.clone_chain_auth", message: "chaining auth from clone flow", meta: { agentName } })
        try {
          await runOuroCli(["auth", "--agent", agentName], deps)
        /* v8 ignore start -- chained command failures: tested via interactive clone test, catch branches are defensive @preserve */
        } catch (e) {
          deps.writeStdout(`auth setup failed: ${e instanceof Error ? e.message : String(e)}\nYou can retry later with: ouro auth --agent ${agentName}`)
        }
        /* v8 ignore stop */
      }

      // Daemon
      const upAnswer = await deps.promptInput(`\nStart the daemon now? (y/n): `) ?? ""
      if (upAnswer.trim().toLowerCase() === "y") {
        emitNervesEvent({ component: "daemon", event: "daemon.clone_chain_up", message: "chaining daemon start from clone flow", meta: { agentName } })
        try {
          await runOuroCli(["up"], deps)
        /* v8 ignore start -- chained command failures: defensive catch @preserve */
        } catch (e) {
          deps.writeStdout(`daemon start failed: ${e instanceof Error ? e.message : String(e)}\nYou can retry later with: ouro up`)
        }
        /* v8 ignore stop */
      }

      // Dev tool setup
      const setupAnswer = await deps.promptInput(`\nSet up Claude Code integration? (y/n): `) ?? ""
      if (setupAnswer.trim().toLowerCase() === "y") {
        emitNervesEvent({ component: "daemon", event: "daemon.clone_chain_setup", message: "chaining dev tool setup from clone flow", meta: { agentName } })
        try {
          await runOuroCli(["setup", "--tool", "claude-code", "--agent", agentName], deps)
        /* v8 ignore start -- chained command failures: defensive catch @preserve */
        } catch (e) {
          deps.writeStdout(`dev tool setup failed: ${e instanceof Error ? e.message : String(e)}\nYou can retry later with: ouro setup --tool claude-code --agent ${agentName}`)
        }
        /* v8 ignore stop */
      }
    } else {
      deps.writeStdout(`\nnext steps:\n  ouro vault unlock --agent ${agentName}\n  ouro provider refresh --agent ${agentName}\n  ouro auth verify --agent ${agentName}\n  ouro up\n  ouro setup --tool claude-code --agent ${agentName}`)
    }

    /* v8 ignore start -- PATH hint: only fires inside npx, not testable in vitest @preserve */
    if (process.env.npm_execpath) {
      const shell = process.env.SHELL ? path.basename(process.env.SHELL) : ""
      const bashProfile = process.platform === "darwin" ? "~/.bash_profile" : "~/.bashrc"
      const sourceCmd = shell === "zsh" ? "source ~/.zshrc"
        : shell === "bash" ? `source ${bashProfile}`
        : shell === "fish" ? "source ~/.config/fish/config.fish"
        : "restart your shell"
      deps.writeStdout(`\ntip: if 'ouro' is not found, run: ${sourceCmd}`)
    }
    /* v8 ignore stop */

    return `clone complete: ${agentName}`
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
