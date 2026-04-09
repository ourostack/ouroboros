#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import { DaemonProcessManager } from "./process-manager"
import { OuroDaemon } from "./daemon"
import { emitNervesEvent } from "../../nerves/runtime"
import { registerGlobalLogSink } from "../../nerves/index"
import { FileMessageRouter } from "./message-router"
import { HealthMonitor } from "./health-monitor"
import { DaemonHealthWriter, createHealthNervesSink, getDefaultHealthPath } from "./daemon-health"
import { TaskDrivenScheduler } from "./task-scheduler"
import { configureDaemonRuntimeLogger } from "./runtime-logging"
import { DaemonSenseManager } from "./sense-manager"
import { listEnabledBundleAgents } from "./agent-discovery"
import { getRepoRoot, getAgentBundlesRoot } from "../identity"
import { detectRuntimeMode } from "./runtime-mode"
import { HabitScheduler } from "../habits/habit-scheduler"
import { migrateHabitsFromTaskSystem } from "../habits/habit-migration"
import { createRealOsCronDeps, resolveOuroBinaryPath } from "./os-cron-deps"
import { LaunchdCronManager } from "./os-cron"
import { writeDaemonTombstone } from "./daemon-tombstone"
import * as os from "os"
import { checkAgentConfig } from "./agent-config-check"
import { flushPulse } from "./pulse"
import { sendDaemonCommand } from "./socket-client"
import { getPackageVersion } from "../../mind/bundle-manifest"
import { createHttpHealthProbe } from "./http-health-probe"
import { getBlueBubblesChannelConfig } from "../config"

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

const processManager = new DaemonProcessManager({
  agents: managedAgents.map((agent) => ({
    name: agent,
    entry: "heart/agent-entry.js",
    channel: "inner-dialog",
    autoStart: true,
  })),
  existsSync: fs.existsSync,
  /* v8 ignore next 4 -- wiring: delegates to checkAgentConfig which has full unit tests @preserve */
  configCheck: (agent) => {
    const bundlesRoot = getAgentBundlesRoot()
    const secretsRoot = path.join(os.homedir(), ".agentsecrets")
    return checkAgentConfig(agent, bundlesRoot, secretsRoot)
  },
  /* v8 ignore start -- pulse flush wiring: integration code; flushPulse itself has full unit tests @preserve */
  onSnapshotChange: () => {
    flushPulse({
      snapshots: processManager.listAgentSnapshots(),
      bundlesRoot: getAgentBundlesRoot(),
      daemonVersion: getPackageVersion(),
      now: new Date(),
      // Default I/O wired into pulse.ts (writePulse, readPulse, etc.)
      // Wake recipient: send inner.wake over the daemon's own socket so
      // the recipient agent runs an inner-dialog turn that picks up the
      // pulse alert. Catch errors silently — pulse is best-effort.
      fireInnerWake: (agent: string) => {
        sendDaemonCommand(socketPath, { kind: "inner.wake", agent }).catch(() => {})
      },
    })
  },
  /* v8 ignore stop */
})

const scheduler = new TaskDrivenScheduler({
  agents: [...managedAgents],
})

const router = new FileMessageRouter()

const senseManager = new DaemonSenseManager({
  agents: [...managedAgents],
})

/* v8 ignore next 2 -- entry-point wiring: probe factory and HealthMonitor both have full unit tests @preserve */
const bbChannelConfig = getBlueBubblesChannelConfig()
const bbProbe = createHttpHealthProbe("bluebubbles", bbChannelConfig.port)

const healthMonitor = new HealthMonitor({
  processManager,
  scheduler,
  senseProbes: [bbProbe],
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
})

const daemon = new OuroDaemon({
  socketPath,
  processManager,
  senseManager,
  scheduler,
  healthMonitor,
  router,
  mode,
})

/* v8 ignore start — daemon health writer wiring, tested via daemon-health.test.ts @preserve */
const healthWriter = new DaemonHealthWriter(getDefaultHealthPath())
const healthSink = createHealthNervesSink(healthWriter, () => ({
  status: "ok",
  mode,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  uptimeSeconds: Math.floor(process.uptime()),
  safeMode: null,
  degraded: [],
  agents: {},
  habits: {},
}))
registerGlobalLogSink(healthSink)
/* v8 ignore stop */

const habitSchedulers: HabitScheduler[] = []

/* v8 ignore start -- habit wiring: lambdas delegate to processManager/fs; tested via HabitScheduler unit tests @preserve */
void daemon.start().then(() => {
  const bundlesRoot = getAgentBundlesRoot()
  const ouroPath = resolveOuroBinaryPath()
  const osCronDeps = createRealOsCronDeps()

  for (const agent of managedAgents) {
    const bundleRoot = path.join(bundlesRoot, `${agent}.ouro`)
    const habitsDir = path.join(bundleRoot, "habits")

    // Migrate old tasks/habits/ to habits/ at bundle root
    migrateHabitsFromTaskSystem(bundleRoot)

    const osCronManager = new LaunchdCronManager(osCronDeps)
    const scheduler = new HabitScheduler({
      agent,
      habitsDir,
      osCronManager,
      onHabitFire: (habitName) => {
        processManager.sendToAgent(agent, { type: "habit", habitName })
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
    })
    scheduler.start()
    scheduler.startPeriodicReconciliation()
    scheduler.watchForChanges()
    habitSchedulers.push(scheduler)
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
  setTimeout(() => process.exit(1), 5_000).unref()
  await daemon.stop()
  process.exit(1)
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
  for (const s of habitSchedulers) { s.stopWatching(); s.stop() }
  healthMonitor.stopPeriodicChecks()
  setTimeout(() => process.exit(1), 5_000).unref()
  void daemon.stop().then(() => process.exit(0))
})

process.on("SIGTERM", () => {
  _tombstoneWritten = true
  writeDaemonTombstone("sigterm", new Error("daemon received SIGTERM"))
  for (const s of habitSchedulers) { s.stopWatching(); s.stop() }
  healthMonitor.stopPeriodicChecks()
  setTimeout(() => process.exit(1), 5_000).unref()
  void daemon.stop().then(() => process.exit(0))
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
    setTimeout(() => process.exit(1), 5_000).unref()
    void daemon.stop().then(() => process.exit(1))
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
