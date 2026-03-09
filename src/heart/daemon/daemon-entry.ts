#!/usr/bin/env node
import { DaemonProcessManager } from "./process-manager"
import { OuroDaemon } from "./daemon"
import { emitNervesEvent } from "../../nerves/runtime"
import { FileMessageRouter } from "./message-router"
import { HealthMonitor } from "./health-monitor"
import { TaskDrivenScheduler } from "./task-scheduler"
import { configureDaemonRuntimeLogger } from "./runtime-logging"
import { DaemonSenseManager } from "./sense-manager"
import { listEnabledBundleAgents } from "./agent-discovery"

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

emitNervesEvent({
  component: "daemon",
  event: "daemon.entry_start",
  message: "starting daemon entrypoint",
  meta: { socketPath },
})

const managedAgents = listEnabledBundleAgents()

const processManager = new DaemonProcessManager({
  agents: managedAgents.map((agent) => ({
    name: agent,
    entry: "heart/agent-entry.js",
    channel: "inner-dialog",
    autoStart: true,
  })),
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
})

void daemon.start().catch(async () => {
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
  void daemon.stop().then(() => process.exit(0))
})

process.on("SIGTERM", () => {
  void daemon.stop().then(() => process.exit(0))
})
