#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import { DaemonProcessManager } from "./process-manager"
import { OuroDaemon } from "./daemon"
import { emitNervesEvent } from "../../nerves/runtime"
import { FileMessageRouter } from "./message-router"
import { HealthMonitor } from "./health-monitor"
import { TaskDrivenScheduler } from "./task-scheduler"
import { configureDaemonRuntimeLogger } from "./runtime-logging"
import { DaemonSenseManager } from "./sense-manager"
import { listEnabledBundleAgents } from "./agent-discovery"
import { getRepoRoot, getAgentBundlesRoot } from "../identity"
import { detectRuntimeMode } from "./runtime-mode"
import { HeartbeatTimer } from "./heartbeat-timer"

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

const heartbeatTimers: HeartbeatTimer[] = []

/* v8 ignore start -- heartbeat wiring: lambdas delegate to processManager/fs; tested via HeartbeatTimer unit tests @preserve */
void daemon.start().then(() => {
  const bundlesRoot = getAgentBundlesRoot()
  for (const agent of managedAgents) {
    const bundleRoot = path.join(bundlesRoot, `${agent}.ouro`)
    const timer = new HeartbeatTimer({
      agent,
      sendToAgent: (a, msg) => processManager.sendToAgent(a, msg),
      deps: {
        readFileSync: (p, enc) => fs.readFileSync(p, enc as BufferEncoding),
        readdirSync: (p) => fs.readdirSync(p).map((e) => (typeof e === "string" ? e : e)),
        heartbeatTaskDir: path.join(bundleRoot, "tasks", "habits"),
        runtimeStatePath: path.join(bundleRoot, "state", "sessions", "self", "inner", "runtime.json"),
      },
    })
    timer.start()
    heartbeatTimers.push(timer)
  }
}).catch(async () => {
/* v8 ignore stop */
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.entry_error",
    message: "daemon entrypoint failed",
    meta: {},
  })
  await daemon.stop()
  process.exit(1)
})

process.on("SIGINT", () => {
  for (const timer of heartbeatTimers) timer.stop()
  void daemon.stop().then(() => process.exit(0))
})

process.on("SIGTERM", () => {
  for (const timer of heartbeatTimers) timer.stop()
  void daemon.stop().then(() => process.exit(0))
})
