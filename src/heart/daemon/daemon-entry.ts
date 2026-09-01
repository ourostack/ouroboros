#!/usr/bin/env node
import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { DaemonProcessManager, type RuntimeCredentialBootstrap } from "./process-manager"
import { OuroDaemon, type DaemonHealthResult } from "./daemon"
import { emitNervesEvent } from "../../nerves/runtime"
import { registerGlobalLogSink } from "../../nerves/index"
import { FileMessageRouter } from "./message-router"
import { HealthMonitor } from "./health-monitor"
import {
  DaemonHealthWriter,
  createHealthNervesSink,
  getDefaultHealthPath,
  startDaemonHealthHeartbeat,
  type DaemonHealthState,
  type DegradedComponent,
} from "./daemon-health"
import { computeDaemonRollup } from "./daemon-rollup"
import { TaskDrivenScheduler } from "./task-scheduler"
import { configureDaemonRuntimeLogger } from "./runtime-logging"
import { DaemonSenseManager } from "./sense-manager"
import { listEnabledBundleAgents, readPrivateRuntimeConfig } from "./agent-discovery"
import { getRepoRoot, getAgentBundlesRoot } from "../identity"
import { detectRuntimeMode } from "./runtime-mode"
import { HabitScheduler } from "../habits/habit-scheduler"
import { migrateHabitsFromTaskSystem } from "../habits/habit-migration"
import { AwaitScheduler } from "../awaiting/await-scheduler"
import { archiveAndAlertExpiredAwait } from "../awaiting/await-expiry"
import { createRealOsCronDeps, resolveOuroBinaryPath } from "./os-cron-deps"
import { LaunchdCronManager } from "./os-cron"
import { readContainerRuntimePolicy } from "./container-runtime"
import { SupercronicSupervisor } from "./supercronic-supervisor"
import { writeDaemonTombstone } from "./daemon-tombstone"
import { checkAgentConfig, checkAgentConfigWithProviderHealth } from "./agent-config-check"
import { flushPulse, type PulsePrivateWakeRequest } from "./pulse"
import { sendDaemonCommand } from "./socket-client"
import { buildAwaitPrivateWakeCommand, type AwaitPrivateWakeTriggerSource } from "./await-private-wake"
import { buildHabitPrivateWakeCommand, type HabitPrivateWakeTriggerSource } from "./habit-private-wake"
import { isRsvpHabitName } from "../../rsvp/habit-policy"
import { getPackageVersion } from "../../mind/bundle-manifest"
import { createMcpStatusCanaryProbe } from "./mcp-canary"
import { refreshContextLossSentinel, type ContextLossSentinelReceipt, type ContextLossSentinelTrigger } from "../context-loss-sentinel"
import {
  readProviderCredentialPool,
  type ProviderCredentialRecord,
} from "../provider-credentials"
import { readMachineRuntimeCredentialConfig, readRuntimeCredentialConfig } from "../runtime-credentials"
import { loadOrCreateMachineIdentity } from "../machine-identity"
import { loadContainerCredentialBootstrap } from "./container-credential-bootstrap"
import { createProviderReadinessPreparationFailure, startDaemonAfterContainerCredentialBootstrap } from "./daemon-bootstrap-startup"
import type { HabitRunTrigger } from "../../arc/flight-recorder"
import { runSanctuaryHealthHabit } from "../../senses/sanctuary-health-runner"
import { readSanctuaryAcceptanceMarker } from "./sanctuary-acceptance-marker"
import { consumeSanctuarySchedulerFire, readSanctuaryHealthCursor, recordSanctuarySchedulerLivenessReceipt } from "./sanctuary-scheduler-liveness"
import { verifySanctuarySchedulerFireCommand } from "./sanctuary-scheduler-origin"
import { readOrCreateTelegramIdentityKey } from "../../senses/telegram"

function parseSocketPath(argv: string[]): string {
  const socketIndex = argv.indexOf("--socket")
  if (socketIndex >= 0) {
    const value = argv[socketIndex + 1]
    if (value && value.trim().length > 0) return value
  }
  return "/tmp/ouroboros-daemon.sock"
}

const socketPath = parseSocketPath(process.argv)

configureDaemonRuntimeLogger("daemon")

const entryPath = path.resolve(__dirname, "daemon-entry.js")
const mode = detectRuntimeMode(getRepoRoot())

emitNervesEvent({
  component: "daemon",
  event: "daemon.entry_start",
  message: "starting daemon entrypoint",
  meta: { socketPath, entryPath, mode },
})

/* v8 ignore next -- dev-mode indicator: false branch (production) tested in daemon-boot-updates.test.ts @preserve */
if (mode === "dev") {
  const repoRoot = getRepoRoot()
  emitNervesEvent({
    component: "daemon",
    event: "daemon.dev_mode_indicator",
    message: `[dev] running from ${repoRoot}`,
    meta: { repoRoot },
  })
}

const managedAgents = listEnabledBundleAgents()
const managedPrivateRuntimes = managedAgents.map((agent) => ({
  agent,
  config: readPrivateRuntimeConfig(agent),
}))

function currentMachineId(): string {
  return loadOrCreateMachineIdentity().machineId
}

function privateRuntimeCredentialBootstrapFor(agent: string): RuntimeCredentialBootstrap | null {
  const machineId = currentMachineId()
  const runtime = readRuntimeCredentialConfig(agent)
  const machine = readMachineRuntimeCredentialConfig(agent)
  const providerPool = readProviderCredentialPool(agent)
  const providerCredentialRecords = providerPool.ok
    ? Object.values(providerPool.pool.providers).filter((record): record is ProviderCredentialRecord => !!record)
    : []
  const bootstrap: RuntimeCredentialBootstrap = {
    agentName: agent,
    runtimeConfig: runtime.ok ? runtime.config : undefined,
    machineRuntimeConfig: machine.ok ? machine.config : undefined,
    machineId,
    providerCredentialRecords: providerCredentialRecords.length > 0 ? providerCredentialRecords : undefined,
  }
  if (!bootstrap.runtimeConfig && !bootstrap.machineRuntimeConfig && !bootstrap.providerCredentialRecords) return null
  return bootstrap
}

function sentinelHealthStatus(receipt: Pick<ContextLossSentinelReceipt, "verdict">): DaemonHealthResult["status"] {
  if (receipt.verdict === "ready") return "ok"
  if (receipt.verdict === "watch") return "warn"
  return "critical"
}

async function refreshDaemonSentinel(
  agent: string,
  trigger: Extract<ContextLossSentinelTrigger, "daemon_startup" | "daemon_health">,
  daemonHealthResults: DaemonHealthResult[] = [],
): Promise<DaemonHealthResult> {
  const bundleRoot = path.join(getAgentBundlesRoot(), `${agent}.ouro`)
  try {
    const receipt = await refreshContextLossSentinel(agent, bundleRoot, { trigger, daemonHealthResults })
    return {
      name: `context-loss-sentinel:${agent}`,
      status: sentinelHealthStatus(receipt),
      message: `Sentinel ${receipt.verdict}: ${receipt.summary}`,
    }
  } catch (error) {
    return {
      name: `context-loss-sentinel:${agent}`,
      status: "critical",
      message: `Sentinel refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function emitAwaitPrivateWakeDispatchError(options: {
  agent: string
  awaitName: string
  triggerSource: AwaitPrivateWakeTriggerSource
  socketPath: string
  error: unknown
}): void {
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.await_private_wake_dispatch_error",
    message: "failed to dispatch await private-runtime wake",
    meta: {
      agent: options.agent,
      awaitName: options.awaitName,
      triggerSource: options.triggerSource,
      socketPath: options.socketPath,
      error: options.error instanceof Error ? options.error.message : String(options.error),
    },
  })
}

function emitPulsePrivateWakeDispatchError(options: {
  request: PulsePrivateWakeRequest
  socketPath: string
  error: unknown
}): void {
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.pulse_private_wake_dispatch_error",
    message: "failed to dispatch pulse private-runtime wake",
    meta: {
      agent: options.request.agent,
      triggerSource: options.request.triggerSource,
      idempotencyKey: options.request.idempotencyKey,
      originRefs: options.request.originRefs,
      socketPath: options.socketPath,
      error: options.error instanceof Error ? options.error.message : String(options.error),
    },
  })
}

function emitHabitPrivateWakeDispatchError(options: {
  agent: string
  habitName: string
  trigger: HabitRunTrigger
  triggerSource: HabitPrivateWakeTriggerSource
  socketPath: string
  error: unknown
}): void {
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.habit_private_wake_dispatch_error",
    message: "failed to dispatch habit private-runtime wake",
    meta: {
      agent: options.agent,
      habitName: options.habitName,
      trigger: options.trigger,
      triggerSource: options.triggerSource,
      socketPath: options.socketPath,
      error: options.error instanceof Error ? options.error.message : String(options.error),
    },
  })
}

const processManager = new DaemonProcessManager({
  agents: managedPrivateRuntimes.map(({ agent, config }) => ({
    name: agent,
    entry: "heart/agent-entry.js",
    channel: "private-runtime",
    autoStart: config.autoStart,
    getRuntimeCredentialBootstrap: () => privateRuntimeCredentialBootstrapFor(agent),
  })),
  existsSync: fs.existsSync,
  /* v8 ignore next 4 -- wiring: delegates to checkAgentConfig which has full unit tests @preserve */
  configCheck: async (agent) => {
    const bundlesRoot = getAgentBundlesRoot()
    return checkAgentConfig(agent, bundlesRoot)
  },
  /* v8 ignore start -- pulse flush wiring: integration code; flushPulse itself has full unit tests @preserve */
  onSnapshotChange: () => {
    flushPulse({
      snapshots: processManager.listAgentSnapshots(),
      bundlesRoot: getAgentBundlesRoot(),
      daemonVersion: getPackageVersion(),
      now: new Date(),
      // Default I/O wired into pulse.ts (writePulse, readPulse, etc.).
      // Pulse alerts queue canonical private-runtime wakes so policy decides
      // whether a model-backed notification turn may run.
      firePrivateWake: (request) => {
        sendDaemonCommand(socketPath, {
          kind: "private.wake",
          ...request,
        }).catch((error) => {
          emitPulsePrivateWakeDispatchError({
            request,
            socketPath,
            error,
          })
        })
      },
    })
  },
  /* v8 ignore stop */
})

const taskScheduler = new TaskDrivenScheduler({
  agents: [...managedAgents],
})

const habitSchedulers: HabitScheduler[] = []
const awaitSchedulers: AwaitScheduler[] = []
const containerRuntimePolicy = readContainerRuntimePolicy()
const supercronicSupervisor = containerRuntimePolicy?.scheduler === "supercronic"
  ? new SupercronicSupervisor({
      binaryPath: "/usr/local/bin/supercronic",
      crontabPath: path.join(getAgentBundlesRoot(), "..", ".ouro-cli", "scheduler", "sanctuary.crontab"),
      onFatal: (error) => {
        emitNervesEvent({ level: "error", component: "daemon", event: "daemon.supercronic_state", message: "Supercronic restart budget exhausted", meta: { error: error.message } })
        process.exit(1)
      },
    })
  : null

function habitCronLabelOwner(agent: string): (label: string) => boolean {
  const agentPrefix = `bot.ouro.${agent}.`
  const awaitPrefix = `${agentPrefix}await.`
  return (label) => label.startsWith(agentPrefix) && !label.startsWith(awaitPrefix)
}

function awaitCronLabelOwner(agent: string): (label: string) => boolean {
  const awaitPrefix = `bot.ouro.${agent}.await.`
  return (label) => label.startsWith(awaitPrefix)
}

function verifyOsCron(command: string): string {
  return execSync(command, { encoding: "utf-8" })
}

const scheduler = {
  listJobs: () => [
    ...taskScheduler.listJobs(),
    ...habitSchedulers.flatMap((habitScheduler) => habitScheduler.listJobs()),
  ],
  listDegradedJobs: () => [
    ...habitSchedulers.flatMap((habitScheduler) =>
      habitScheduler.getDegradedHabits().map((habit) => ({
        id: `habit:${habit.name}`,
        reason: habit.reason,
      })),
    ),
    ...awaitSchedulers.flatMap((awaitScheduler) =>
      awaitScheduler.getDegradedAwaits().map((awaitItem) => ({
        id: `await:${awaitItem.name}`,
        reason: awaitItem.reason,
      })),
    ),
  ],
  triggerJob: (jobId: string) => taskScheduler.triggerJob(jobId),
  triggerHabitJob: async (jobId: string) => {
    for (const habitScheduler of habitSchedulers) {
      const result = await habitScheduler.triggerJob(jobId, "cron")
      if (result.ok) return result
    }
    return { ok: false, message: `unknown habit job: ${jobId}` }
  },
  start: () => taskScheduler.start(),
  stop: () => taskScheduler.stop(),
  reconcile: () => taskScheduler.reconcile(),
  recordTaskRun: (agent: string, taskId: string) => taskScheduler.recordTaskRun(agent, taskId),
}

const router = new FileMessageRouter()

const senseManager = new DaemonSenseManager({
  agents: [...managedAgents],
})

const healthMonitor = new HealthMonitor({
  processManager,
  scheduler,
  sentinelChecker: (resultsSoFar) => Promise.all(managedAgents.map((agent) => refreshDaemonSentinel(agent, "daemon_health", resultsSoFar))),
  senseProbeProvider: () => [
    ...senseManager.listHealthProbes(),
    ...managedAgents.map((agent) => createMcpStatusCanaryProbe({
      agent,
      socketPath,
      command: process.execPath,
      commandArgs: [
        path.join(__dirname, "ouro-bot-entry.js"),
        "mcp-serve",
        "--agent",
        agent,
        "--socket",
        socketPath,
      ],
      ignoreOverviewHealth: true,
    })),
  ],
  alertSink: (message) => {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.health_alert",
      message: "health monitor produced critical alert",
      meta: { message },
    })
  },
  /* v8 ignore next 3 -- wiring: delegates to processManager.restartAgent which has full unit tests @preserve */
  onCriticalAgent: (agentName) => {
    try { processManager.restartAgent(agentName) } catch { /* recovery is best-effort */ }
  },
  /* v8 ignore next 3 -- wiring: delegates to senseManager.restartSense which has focused tests @preserve */
  onCriticalSense: (managedName) => {
    try { void senseManager.restartSense(managedName) } catch { /* recovery is best-effort */ }
  },
})

let entryRuntimeStopPromise: Promise<void> | null = null
let stopCommandExitScheduled = false

function stopEntryRuntime(): Promise<void> {
  if (entryRuntimeStopPromise) return entryRuntimeStopPromise
  entryRuntimeStopPromise = (async () => {
    stopHealthHeartbeat()
    for (const s of habitSchedulers) { s.stopWatching(); s.stop() }
    for (const s of awaitSchedulers) { s.stopWatching(); s.stop() }
    await supercronicSupervisor?.stop()
    healthMonitor.stopPeriodicChecks()
  })()
  return entryRuntimeStopPromise
}

function scheduleCleanProcessExitAfterStopCommand(): void {
  if (stopCommandExitScheduled) return
  stopCommandExitScheduled = true
  // Account for the explicit daemon.stop path so the process exit catch-all
  // does not mislabel an operator-requested stop as an unexpected clean exit.
  _tombstoneWritten = true
  writeStopCommandHealthState()
  setTimeout(() => process.exit(0), 100)
}

const daemon = new OuroDaemon({
  socketPath,
  processManager,
  senseManager,
  scheduler,
  healthMonitor,
  router,
  schedulerFireVerifier: (command) => {
    if (!supercronicSupervisor) throw new Error("Supercronic scheduler is unavailable")
    const marker = readSanctuaryAcceptanceMarker("sanctuary")
    return verifySanctuarySchedulerFireCommand(command, {
      childPid: supercronicSupervisor.authenticatedSnapshot("habit:sanctuary").childPid,
      identityKey: readOrCreateTelegramIdentityKey(path.join(getAgentBundlesRoot(), "sanctuary.ouro")),
      scenarioHandleDigest: marker?.label === "unit-16f-cron-fingerprint" ? marker.scenarioHandleDigest : null, now: () => new Date(),
      readFile: (target) => fs.readFileSync(target, "utf8"), readLink: (target) => fs.readlinkSync(target),
    })
  },
  schedulerFireConsumer: (origin) => consumeSanctuarySchedulerFire(path.join(getAgentBundlesRoot(), "sanctuary.ouro"), origin),
  nativeHabitRunner: async ({ agent, habitName, trigger, occurrenceId, runnerId, schedulerOrigin }) => {
    if (agent !== "sanctuary" || habitName !== "sanctuary-health") return null
    const marker = readSanctuaryAcceptanceMarker(agent)
    const schedulerScenario = marker?.label === "unit-16f-cron-fingerprint" ? marker : null
    const agentRoot = path.join(getAgentBundlesRoot(), `${agent}.ouro`)
    const before = schedulerScenario ? readSanctuaryHealthCursor(agentRoot) : null
    let providerInvocationCount = 0
    let privateTurnCount = 0
    const result = await runSanctuaryHealthHabit(agent, {
      submitEvidence: async (input) => {
        const response = await daemon.handleCommand({ kind: "external.event.submit", ...input })
        if (!response.ok) throw new Error(response.error ?? "Sanctuary health evidence submission failed")
        return (response.data as { event: { shouldWake: boolean } }).event
      },
      ...(schedulerScenario ? {
        acceptanceMetrics: {
          onPrivateTurnStart: () => { privateTurnCount += 1 },
          onProviderInvocation: () => { providerInvocationCount += 1 },
        },
      } : {}),
    })
    if (schedulerScenario) {
      if (!supercronicSupervisor || !before || !occurrenceId || !schedulerOrigin) throw new Error("Sanctuary scheduler liveness supervisor provenance is unavailable")
      recordSanctuarySchedulerLivenessReceipt({
        agentRoot,
        trigger,
        occurrenceId,
        runnerId,
        scenario: schedulerScenario,
        supervisor: supercronicSupervisor.authenticatedSnapshot("habit:sanctuary"),
        before,
        providerInvocationCount,
        privateTurnCount,
        schedulerOrigin,
        identityKey: readOrCreateTelegramIdentityKey(agentRoot),
      })
    }
    return result
  },
  nativeHabitMatch: (agent, habitName) => agent === "sanctuary" && habitName === "sanctuary-health",
  mode,
  onStopCommandComplete: async () => {
    await stopEntryRuntime()
    scheduleCleanProcessExitAfterStopCommand()
  },
})

const daemonStartedAt = new Date().toISOString()
const degradedComponents: DegradedComponent[] = []

function buildDaemonHealthState(): DaemonHealthState {
  const snapshots = processManager.listAgentSnapshots()
  const agentDegradedComponents: DegradedComponent[] = snapshots
    .filter((snapshot) => snapshot.status !== "running" && snapshot.autoStart !== false)
    .map((snapshot) => {
      const reasonParts = [
        snapshot.errorReason ?? `${snapshot.channel} is ${snapshot.status}`,
        snapshot.fixHint ? `Fix: ${snapshot.fixHint}` : null,
      ].filter((part): part is string => part !== null)
      return {
        component: `agent:${snapshot.name}`,
        reason: reasonParts.join(" "),
        since: snapshot.lastCrashAt ?? daemonStartedAt,
      }
    })
  // Preserved for backwards-compatible inspection: callers (status
  // command, mailbox surface, etc.) may still read this combined list
  // for per-component reasons. The rollup status field above is what
  // changed meaning — the array is still the union of bootstrap +
  // agent-derived degradation entries.
  const degraded = [
    ...degradedComponents.map((entry) => ({ ...entry })),
    ...agentDegradedComponents,
  ]

  // Layer 1 rollup: project per-agent snapshots into the minimal
  // AgentRollupInput shape and let computeDaemonRollup decide. The
  // input is "every enabled agent" — managedAgents was filtered via
  // listEnabledBundleAgents at module init, and snapshots only covers
  // agents the process manager was told to manage, so by construction
  // these entries are all enabled. The rollup function is a pure
  // declarative function on the data we hand it.
  //
  // Note: safe-mode is wired as `false` here. Existing crash-loop
  // detection (safe-mode.ts) already runs at the daemon-up boot path
  // (cli-exec.ts), not from inside the daemon process itself. Once
  // the daemon is up and reaching this rollup, safe mode no longer
  // applies — the daemon is by definition past the crash-loop gate.
  // If a future PR moves safe-mode signal into the running daemon,
  // wire it through this third argument.
  const rollupStatus = computeDaemonRollup({
    enabledAgents: snapshots.map((snapshot) => ({
      name: snapshot.name,
      // A parked non-autostart worker is intentionally not serving; it should
      // remain visible in worker status but should not degrade daemon health.
      status: snapshot.autoStart === false ? "running" : snapshot.status,
    })),
    bootstrapDegraded: degradedComponents,
    safeMode: false,
  })

  return {
    status: rollupStatus,
    mode,
    pid: process.pid,
    startedAt: daemonStartedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    safeMode: null,
    degraded,
    agents: Object.fromEntries(snapshots.map((snapshot) => [
      snapshot.name,
      {
        status: snapshot.status,
        pid: snapshot.pid,
        crashes: snapshot.restartCount,
      },
    ])),
    habits: {},
  }
}

function recordRecoverableBootstrapFailure(options: {
  agent: string
  component: string
  habitsDir: string
  error: unknown
  guidance: string
}): void {
  const errorMessage = options.error instanceof Error ? options.error.message : String(options.error)
  const existing = degradedComponents.find((entry) => entry.component === options.component)
  const reason = `${errorMessage}. ${options.guidance}`

  if (existing) {
    existing.reason = reason
  } else {
    degradedComponents.push({
      component: options.component,
      reason,
      since: new Date().toISOString(),
    })
  }

  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.bootstrap_degraded",
    message: "recoverable daemon bootstrap failure; daemon remains available in degraded mode",
    meta: {
      agent: options.agent,
      component: options.component,
      habitsDir: options.habitsDir,
      error: errorMessage,
      guidance: options.guidance,
    },
  })
}

function emitHabitSetupError(agent: string, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.habit_setup_error",
    message: `habit setup failed for agent ${agent}`,
    meta: { agent, error: normalized.message },
  })
}

function emitAwaitSetupError(agent: string, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.await_setup_error",
    message: `await setup failed for agent ${agent}`,
    meta: { agent, error: normalized.message },
  })
}

/* v8 ignore start — daemon health writer wiring, tested via daemon-health.test.ts @preserve */
const healthWriter = new DaemonHealthWriter(getDefaultHealthPath())
const healthSink = createHealthNervesSink(healthWriter, buildDaemonHealthState)
registerGlobalLogSink(healthSink)
const stopHealthHeartbeat = startDaemonHealthHeartbeat(healthWriter, buildDaemonHealthState)
/* v8 ignore stop */

function writeStopCommandHealthState(): void {
  try {
    healthWriter.writeHealth({
      ...buildDaemonHealthState(),
      status: "down",
      uptimeSeconds: Math.floor(process.uptime()),
    })
  } catch {
    // Health writes are best-effort during shutdown.
  }
}

async function prepareProviderRuntime(): Promise<void> {
  const bundlesRoot = getAgentBundlesRoot()
  const readiness = await Promise.all(managedAgents.map(async (agent) => {
    try {
      const result = await checkAgentConfigWithProviderHealth(agent, bundlesRoot)
      if (result.ok) return null
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.provider_readiness_unavailable",
        message: "fresh provider readiness was unavailable before daemon startup",
        meta: { agent },
      })
      return result.issue ?? {
        summary: `${agent}: provider runtime unavailable`,
        actions: [{ actor: "agent-runnable", command: "ouro doctor" }],
      }
    } catch {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.provider_readiness_unavailable",
        message: "fresh provider readiness check failed before daemon startup",
        meta: { agent },
      })
      throw new Error("provider runtime preparation failed")
    }
  }))
  const failures = readiness.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  if (failures.length > 0) {
    throw createProviderReadinessPreparationFailure(failures)
  }
}

function scheduleStartupSentinelAfterProviderPreload(agent: string, preload: Promise<void>): void {
  void preload.then(async () => {
    const result = await refreshDaemonSentinel(agent, "daemon_startup")
    if (result.status === "critical") {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.startup_sentinel_error",
        message: "startup Sentinel refresh reported critical after provider preload",
        meta: {
          agent,
          error: result.message,
        },
      })
    }
  /* v8 ignore start -- refreshDaemonSentinel handles ordinary Sentinel failures; this is a promise-chain guard. @preserve */
  }).catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.startup_sentinel_error",
      message: "startup Sentinel refresh failed after provider preload",
      meta: {
        agent,
        error: error instanceof Error ? error.message : String(error),
      },
    })
  })
  /* v8 ignore stop */
}

/* v8 ignore start -- habit wiring: lambdas delegate to processManager/fs; tested via HabitScheduler unit tests @preserve */
void startDaemonAfterContainerCredentialBootstrap({
  loadBootstrap: () => loadContainerCredentialBootstrap(managedAgents),
  prepareDaemon: prepareProviderRuntime,
  startDaemon: () => daemon.start(),
  markStartupFailure: () => { _tombstoneWritten = true },
  exit: (code) => process.exit(code),
}).then(async (started) => {
  if (!started) return
  supercronicSupervisor?.start()
  const providerPreload = Promise.resolve()
  const bundlesRoot = getAgentBundlesRoot()
  const ouroPath = supercronicSupervisor
    ? "/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js"
    : resolveOuroBinaryPath()
  const osCronDeps = createRealOsCronDeps()

  for (const agent of managedAgents) {
    scheduleStartupSentinelAfterProviderPreload(agent, providerPreload)
    const bundleRoot = path.join(bundlesRoot, `${agent}.ouro`)
    const habitsDir = path.join(bundleRoot, "habits")
    const degradedComponent = `habits:${agent}`

    try {
      // Migrate old tasks/habits/ to habits/ at bundle root
      migrateHabitsFromTaskSystem(bundleRoot)

      const osCronManager = supercronicSupervisor
        ? supercronicSupervisor.namespace(`habit:${agent}`)
        : new LaunchdCronManager(osCronDeps, { ownsLabel: habitCronLabelOwner(agent) })
      const scheduler = new HabitScheduler({
        agent,
        habitsDir,
        osCronManager,
        onHabitFire: (habitName, trigger, context) => {
          if (isRsvpHabitName(habitName) || (agent === "sanctuary" && habitName === "sanctuary-health")) {
            sendDaemonCommand(socketPath, {
              kind: "habit.poke",
              agent,
              habitName,
              trigger,
              ...(context?.occurrenceId ? { occurrenceId: context.occurrenceId } : {}),
            }).catch((error) => {
              emitHabitPrivateWakeDispatchError({
                agent,
                habitName,
                trigger,
                triggerSource: `habit-${trigger}` as HabitPrivateWakeTriggerSource,
                socketPath,
                error,
              })
            })
            return
          }
          const command = buildHabitPrivateWakeCommand({
            agent,
            habitName,
            trigger,
            sourceRef: { kind: "daemon-entry", id: "habit-scheduler" },
            occurrenceId: context?.occurrenceId,
          })
          sendDaemonCommand(socketPath, command).catch((error) => {
            emitHabitPrivateWakeDispatchError({
              agent,
              habitName,
              trigger,
              triggerSource: command.triggerSource as HabitPrivateWakeTriggerSource,
              socketPath,
              error,
            })
          })
        },
        deps: {
          readdir: (dir) => fs.readdirSync(dir),
          readFile: (p, enc) => fs.readFileSync(p, enc as BufferEncoding),
          writeFile: (p, c, enc) => fs.writeFileSync(p, c, enc as BufferEncoding),
          existsSync: (p) => fs.existsSync(p),
          now: () => Date.now(),
          ouroPath,
          watch: (dir, cb) => fs.watch(dir, cb),
        },
        execForVerify: supercronicSupervisor ? () => supercronicSupervisor.verificationOutput() : verifyOsCron,
        verifyJobs: supercronicSupervisor ? (jobs) => supercronicSupervisor.verifyNamespace(`habit:${agent}`, jobs) : undefined,
        platform: supercronicSupervisor ? "linux" : undefined,
      })

      try {
        scheduler.start()
        scheduler.startPeriodicReconciliation()
        scheduler.watchForChanges()
        habitSchedulers.push(scheduler)
      } catch (error) {
        try {
          scheduler.stopWatching()
          scheduler.stop()
        } catch {
          // Cleanup is best-effort for partially initialized schedulers.
        }
        emitHabitSetupError(agent, error)
        recordRecoverableBootstrapFailure({
          agent,
          component: degradedComponent,
          habitsDir,
          error,
          guidance: `fix ${agent} habits or cron setup and rerun ouro up to restore habit automation`,
        })
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      emitHabitSetupError(agent, error)
      recordRecoverableBootstrapFailure({
        agent,
        component: degradedComponent,
        habitsDir,
        error,
        guidance: `fix ${agent} habits or cron setup and rerun ouro up to restore habit automation`,
      })
    }

    // Parallel await-condition scheduler. Uses its own OS cron manager so
    // habits and awaits don't share label namespace and stale removals can't
    // collide.
    const awaitsDir = path.join(bundleRoot, "awaiting")
    const awaitDegradedComponent = `awaits:${agent}`
    try {
      const awaitOsCronManager = supercronicSupervisor
        ? supercronicSupervisor.namespace(`await:${agent}`)
        : new LaunchdCronManager(osCronDeps, { ownsLabel: awaitCronLabelOwner(agent) })
      const awaitScheduler = new AwaitScheduler({
        agent,
        awaitsDir,
        osCronManager: awaitOsCronManager,
        onAwaitFire: (awaitName) => {
          sendDaemonCommand(socketPath, buildAwaitPrivateWakeCommand({
            agent,
            awaitName,
            triggerSource: "await-scheduler",
          })).catch((error) => {
            emitAwaitPrivateWakeDispatchError({
              agent,
              awaitName,
              triggerSource: "await-scheduler",
              socketPath,
              error,
            })
          })
        },
        onAwaitExpire: (awaitName) => {
          void archiveAndAlertExpiredAwait({
            agentRoot: bundleRoot,
            agentName: agent,
            awaitName,
            deliveryDeps: {
              agentName: agent,
              deliverers: {
                telegram: async (request) => {
                  const { sendTelegramAwaitFollowUp } = await import("../../senses/telegram")
                  return sendTelegramAwaitFollowUp(agent, request)
                },
              },
              queuePending: () => {
                // Best-effort: queue private-runtime wake so the agent processes the alert path.
                sendDaemonCommand(socketPath, buildAwaitPrivateWakeCommand({
                  agent,
                  awaitName,
                  triggerSource: "await-expiry",
                })).catch((error) => {
                  emitAwaitPrivateWakeDispatchError({
                    agent,
                    awaitName,
                    triggerSource: "await-expiry",
                    socketPath,
                    error,
                  })
                })
              },
            },
          }).catch((err) => {
            emitNervesEvent({
              level: "error",
              component: "daemon",
              event: "daemon.await_expire_error",
              message: "await expiry handler threw",
              meta: { agent, awaitName, error: err instanceof Error ? err.message : String(err) },
            })
          })
        },
        deps: {
          readdir: (dir) => fs.readdirSync(dir),
          readFile: (p, enc) => fs.readFileSync(p, enc as BufferEncoding),
          existsSync: (p) => fs.existsSync(p),
          mkdir: (dir) => { fs.mkdirSync(dir, { recursive: true }) },
          now: () => Date.now(),
          ouroPath,
          watch: (dir, cb) => fs.watch(dir, cb),
        },
        execForVerify: supercronicSupervisor ? () => supercronicSupervisor.verificationOutput() : verifyOsCron,
        verifyJobs: supercronicSupervisor ? (jobs) => supercronicSupervisor.verifyNamespace(`await:${agent}`, jobs) : undefined,
        platform: supercronicSupervisor ? "linux" : undefined,
      })
      try {
        awaitScheduler.start()
        awaitScheduler.startPeriodicReconciliation()
        awaitScheduler.watchForChanges()
        awaitSchedulers.push(awaitScheduler)
      } catch (error) {
        try {
          awaitScheduler.stopWatching()
          awaitScheduler.stop()
        } catch {
          // best-effort cleanup
        }
        emitAwaitSetupError(agent, error)
        recordRecoverableBootstrapFailure({
          agent,
          component: awaitDegradedComponent,
          habitsDir: awaitsDir,
          error,
          guidance: `fix ${agent} awaits or cron setup and rerun ouro up to restore await automation`,
        })
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      emitAwaitSetupError(agent, error)
      recordRecoverableBootstrapFailure({
        agent,
        component: awaitDegradedComponent,
        habitsDir: awaitsDir,
        error,
        guidance: `fix ${agent} awaits or cron setup and rerun ouro up to restore await automation`,
      })
    }
  }

  healthMonitor.startPeriodicChecks(60_000)
/* v8 ignore start -- startup failure + signal handlers: call process.exit, untestable in vitest @preserve */
}).catch(async (err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err))
  _tombstoneWritten = true
  writeDaemonTombstone("startupFailure", error)
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.entry_error",
    message: "daemon entrypoint failed",
    meta: { error: error.message },
  })
  const forcedExit = setTimeout(() => process.exit(1), 5_000)
  forcedExit.unref()
  try {
    await daemon.stop()
  } finally {
    clearTimeout(forcedExit)
    process.exit(1)
  }
})

process.on("SIGINT", () => {
  // ALWAYS write a tombstone, even on signal-driven shutdown. The previous
  // behavior was to set _gracefulShutdown=true and skip the tombstone, which
  // meant ANY external SIGINT/SIGTERM (launchd policy, OOM killer, manual
  // kill, killOrphanProcesses from a sibling daemon) silently disappeared
  // from the death log. The user lost weeks of visibility into why their
  // daemon kept dying. Tombstones are informational — having a "sigint"
  // tombstone is strictly better than silence.
  _tombstoneWritten = true
  writeDaemonTombstone("sigint", new Error("daemon received SIGINT"))
  const forcedExit = setTimeout(() => process.exit(1), 12_000)
  forcedExit.unref()
  void stopEntryRuntime().then(() => daemon.stop()).then(
    () => {
      clearTimeout(forcedExit)
      process.exit(0)
    },
    () => {
      clearTimeout(forcedExit)
      process.exit(1)
    },
  )
})

process.on("SIGTERM", () => {
  _tombstoneWritten = true
  writeDaemonTombstone("sigterm", new Error("daemon received SIGTERM"))
  const forcedExit = setTimeout(() => process.exit(1), 12_000)
  forcedExit.unref()
  void stopEntryRuntime().then(() => daemon.stop()).then(
    () => {
      clearTimeout(forcedExit)
      process.exit(0)
    },
    () => {
      clearTimeout(forcedExit)
      process.exit(1)
    },
  )
})
/* v8 ignore stop */

// Suppress EPIPE on stdout/stderr — normal when detached daemon's parent exits
/* v8 ignore start -- EPIPE suppression: only fires when parent process exits @preserve */
process.stdout?.on?.("error", () => {})
process.stderr?.on?.("error", () => {})
/* v8 ignore stop */

/* v8 ignore start -- global exception handlers: genuinely untestable in vitest; exercised by real daemon crashes @preserve */
let _uncaughtCount = 0
let _tombstoneWritten = false
let _lastKnownCause: Error | null = null
const CIRCUIT_BREAKER_WINDOW_MS = 60_000
const CIRCUIT_BREAKER_MAX = 10

process.on("uncaughtException", (error) => {
  // EPIPE is normal for detached daemon processes — parent closed the pipe
  if ((error as NodeJS.ErrnoException).code === "EPIPE") return

  _uncaughtCount++
  _lastKnownCause = error
  setTimeout(() => { _uncaughtCount-- }, CIRCUIT_BREAKER_WINDOW_MS).unref()

  _tombstoneWritten = true
  writeDaemonTombstone("uncaughtException", error)
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.uncaught_exception",
    message: "uncaught exception in daemon process (continuing)",
    meta: { error: error.message, stack: error.stack ?? null, uncaughtCount: _uncaughtCount },
  })

  // Circuit breaker: if too many exceptions in a short window, the process
  // is in a bad state — exit so launchd/self-spawn can restart fresh.
  if (_uncaughtCount >= CIRCUIT_BREAKER_MAX) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.circuit_breaker_exit",
      message: `daemon exiting: ${_uncaughtCount} uncaught exceptions in ${CIRCUIT_BREAKER_WINDOW_MS / 1000}s`,
      meta: { uncaughtCount: _uncaughtCount },
    })
    const forcedExit = setTimeout(() => process.exit(1), 5_000)
    forcedExit.unref()
    void daemon.stop().finally(() => {
      clearTimeout(forcedExit)
      process.exit(1)
    })
  }
})

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  _lastKnownCause = error
  _tombstoneWritten = true
  writeDaemonTombstone("unhandledRejection", error)
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.unhandled_rejection",
    message: "unhandled promise rejection in daemon process",
    meta: { reason: error.message, stack: error.stack ?? null },
  })
})

// Catch-all: write tombstone on any exit where we didn't already record the cause.
// process.on('exit') is synchronous-only — writeDaemonTombstone uses writeFileSync, so it works.
//
// Previously this skipped writing if `_gracefulShutdown` was true, which made
// SIGINT/SIGTERM-driven exits invisible in the death log. The signal handlers
// above now always write their own tombstone before exiting, so this catch-all
// only runs for exits the signal handlers didn't reach (e.g. process.exit
// called from somewhere unexpected).
process.on("exit", (code) => {
  if (_tombstoneWritten) return
  const reason = code === 0 ? "unexpectedCleanExit" : "unexpectedExit"
  const error = _lastKnownCause ?? new Error(`daemon exited with code ${code} (no specific cause captured)`)
  writeDaemonTombstone(reason, error)
})
/* v8 ignore stop */
