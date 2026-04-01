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
import { HabitScheduler } from "./habit-scheduler"
import { migrateHabitsFromTaskSystem } from "./habit-migration"
import { createRealOsCronDeps, resolveOuroBinaryPath } from "./os-cron-deps"
import { LaunchdCronManager } from "./os-cron"
import { writeDaemonTombstone } from "./daemon-tombstone"

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
})

const scheduler = new TaskDrivenScheduler({
  agents: [...managedAgents],
})

const router = new FileMessageRouter()

const senseManager = new DaemonSenseManager({
  agents: [...managedAgents],
})

const healthMonitor = new HealthMonitor({
  processManager,
  scheduler,
  alertSink: (message) => {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.health_alert",
      message: "health monitor produced critical alert",
      meta: { message },
    })
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
    scheduler.watchForChanges()
    habitSchedulers.push(scheduler)
  }
}).catch(async (err: unknown) => {
/* v8 ignore stop */
  /* v8 ignore start — instanceof branch defensive; catch always receives Error in practice @preserve */
  const error = err instanceof Error ? err : new Error(String(err))
  /* v8 ignore stop */
  writeDaemonTombstone("startupFailure", error)
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.entry_error",
    message: "daemon entrypoint failed",
    meta: { error: error.message },
  })
  await daemon.stop()
  process.exit(1)
})

process.on("SIGINT", () => {
  for (const s of habitSchedulers) { s.stopWatching(); s.stop() }
  void daemon.stop().then(() => process.exit(0))
})

process.on("SIGTERM", () => {
  for (const s of habitSchedulers) { s.stopWatching(); s.stop() }
  void daemon.stop().then(() => process.exit(0))
})

// Suppress EPIPE on stdout/stderr — normal when detached daemon's parent exits
/* v8 ignore start -- EPIPE suppression: only fires when parent process exits @preserve */
process.stdout?.on?.("error", () => {})
process.stderr?.on?.("error", () => {})
/* v8 ignore stop */

/* v8 ignore start -- global exception handlers: genuinely untestable in vitest; exercised by real daemon crashes @preserve */
process.on("uncaughtException", (error) => {
  // EPIPE is normal for detached daemon processes — parent closed the pipe
  if ((error as NodeJS.ErrnoException).code === "EPIPE") return
  writeDaemonTombstone("uncaughtException", error)
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.uncaught_exception",
    message: "uncaught exception in daemon process",
    meta: { error: error.message, stack: error.stack ?? null },
  })
  // Graceful 5-second shutdown window
  setTimeout(() => process.exit(1), 5_000).unref()
  void daemon.stop().then(() => process.exit(1))
})

process.on("unhandledRejection", (reason) => {
  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.unhandled_rejection",
    message: "unhandled promise rejection in daemon process",
    meta: { reason: reason instanceof Error ? reason.message : String(reason) },
  })
})
/* v8 ignore stop */
// daemon stdio fix
