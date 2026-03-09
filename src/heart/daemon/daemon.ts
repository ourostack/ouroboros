import * as fs from "fs"
import * as net from "net"
import * as path from "path"
import { getAgentBundlesRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonSenseManagerLike, DaemonSenseRow } from "./sense-manager"
import { getRuntimeMetadata } from "./runtime-metadata"
import { applyPendingUpdates, registerUpdateHook } from "./update-hooks"
import { bundleMetaHook } from "./hooks/bundle-meta"
import { getPackageVersion } from "../../mind/bundle-manifest"
import { startUpdateChecker, stopUpdateChecker } from "./update-checker"
import { performStagedRestart } from "./staged-restart"
import { execSync, spawnSync } from "child_process"

export interface DaemonCronJobSummary {
  id: string
  schedule: string
  lastRun: string | null
}

export interface DaemonHealthResult {
  name: string
  status: "ok" | "warn" | "critical"
  message: string
}

export interface DaemonMessageReceipt {
  id: string
  queuedAt: string
}

export interface DaemonProcessManagerLike {
  startAutoStartAgents(): Promise<void>
  stopAll(): Promise<void>
  startAgent(agent: string): Promise<void>
  stopAgent?(agent: string): Promise<void>
  restartAgent?(agent: string): Promise<void>
  sendToAgent?(agent: string, message: Record<string, unknown>): void
  listAgentSnapshots(): Array<{
    name: string
    channel: string
    status: string
    pid: number | null
    restartCount: number
    startedAt: string | null
    lastCrashAt: string | null
    backoffMs: number
  }>
}

export interface DaemonSchedulerLike {
  listJobs(): DaemonCronJobSummary[]
  triggerJob(jobId: string): Promise<{ ok: boolean; message: string }>
  start?: () => void
  stop?: () => void
  reconcile?: () => Promise<void> | void
  recordTaskRun?: (agent: string, taskId: string) => Promise<void> | void
}

export interface DaemonHealthMonitorLike {
  runChecks(): Promise<DaemonHealthResult[]>
}

export interface DaemonRouterLike {
  send(message: {
    from: string
    to: string
    content: string
    priority?: string
    sessionId?: string
    taskRef?: string
  }): Promise<DaemonMessageReceipt>
  pollInbox(agent: string): Array<{ id: string; from: string; content: string; queuedAt: string; priority: string }>
}

export type DaemonCommand =
  | { kind: "daemon.start" }
  | { kind: "daemon.stop" }
  | { kind: "daemon.status" }
  | { kind: "daemon.health" }
  | { kind: "daemon.logs" }
  | { kind: "agent.start"; agent: string }
  | { kind: "agent.stop"; agent: string }
  | { kind: "agent.restart"; agent: string }
  | { kind: "cron.list" }
  | { kind: "cron.trigger"; jobId: string }
  | { kind: "chat.connect"; agent: string }
  | { kind: "task.poke"; agent: string; taskId: string }
  | { kind: "message.send"; from: string; to: string; content: string; priority?: string; sessionId?: string; taskRef?: string }
  | { kind: "message.poll"; agent: string }
  | { kind: "hatch.start" }

export interface DaemonResponse {
  ok: boolean
  summary?: string
  message?: string
  error?: string
  data?: unknown
}

export interface OuroDaemonOptions {
  socketPath: string
  processManager: DaemonProcessManagerLike
  scheduler: DaemonSchedulerLike
  healthMonitor: DaemonHealthMonitorLike
  router: DaemonRouterLike
  senseManager?: DaemonSenseManagerLike
  bundlesRoot?: string
}

interface DaemonWorkerRow {
  agent: string
  worker: string
  status: string
  pid: number | null
  restartCount: number
  startedAt: string | null
}

interface DaemonStatusOverview {
  daemon: "running" | "stopped"
  health: "ok" | "warn"
  socketPath: string
  version: string
  lastUpdated: string
  workerCount: number
  senseCount: number
}

interface DaemonStatusPayload {
  overview: DaemonStatusOverview
  workers: DaemonWorkerRow[]
  senses: DaemonSenseRow[]
}

function buildWorkerRows(
  snapshots: ReturnType<DaemonProcessManagerLike["listAgentSnapshots"]>,
): DaemonWorkerRow[] {
  return snapshots.map((snapshot) => ({
    agent: snapshot.name,
    worker: snapshot.channel,
    status: snapshot.status,
    pid: snapshot.pid,
    restartCount: snapshot.restartCount,
    startedAt: snapshot.startedAt,
  }))
}

function formatStatusSummary(payload: DaemonStatusPayload): string {
  if (payload.overview.workerCount === 0 && payload.overview.senseCount === 0) {
    return "no managed agents"
  }
  const rows = [
    ...payload.workers.map((row) => `${row.agent}/${row.worker}:${row.status}`),
    ...payload.senses
      .filter((row) => row.enabled)
      .map((row) => `${row.agent}/${row.sense}:${row.status}`),
  ]
  const detail = rows.length > 0 ? `\titems=${rows.join(",")}` : ""
  return `daemon=${payload.overview.daemon}\tworkers=${payload.overview.workerCount}\tsenses=${payload.overview.senseCount}\thealth=${payload.overview.health}${detail}`
}

function parseIncomingCommand(raw: string): DaemonCommand {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Invalid daemon command payload: expected JSON object.")
  }

  if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
    throw new Error("Invalid daemon command payload: missing kind.")
  }

  const kind = (parsed as { kind?: unknown }).kind
  if (typeof kind !== "string") {
    throw new Error("Invalid daemon command payload: kind must be a string.")
  }

  return parsed as DaemonCommand
}

export class OuroDaemon {
  private readonly socketPath: string
  private readonly processManager: DaemonProcessManagerLike
  private readonly scheduler: DaemonSchedulerLike
  private readonly healthMonitor: DaemonHealthMonitorLike
  private readonly router: DaemonRouterLike
  private readonly senseManager: DaemonSenseManagerLike | null
  private readonly bundlesRoot: string
  private server: net.Server | null = null

  constructor(options: OuroDaemonOptions) {
    this.socketPath = options.socketPath
    this.processManager = options.processManager
    this.scheduler = options.scheduler
    this.healthMonitor = options.healthMonitor
    this.router = options.router
    this.senseManager = options.senseManager ?? null
    this.bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  }

  async start(): Promise<void> {
    if (this.server) return

    emitNervesEvent({
      component: "daemon",
      event: "daemon.server_start",
      message: "starting daemon server",
      meta: { socketPath: this.socketPath },
    })

    // Register update hooks and apply pending updates before starting agents
    registerUpdateHook(bundleMetaHook)
    const currentVersion = getPackageVersion()
    await applyPendingUpdates(this.bundlesRoot, currentVersion)

    // Start periodic update checker (polls npm registry every 30 minutes)
    const bundlesRoot = this.bundlesRoot
    const daemon = this
    startUpdateChecker({
      currentVersion,
      deps: {
        distTag: "alpha",
        fetchRegistryJson: /* v8 ignore next -- integration: real HTTP fetch @preserve */ async () => {
          const res = await fetch("https://registry.npmjs.org/@ouro.bot/cli")
          return res.json()
        },
      },
      onUpdate: /* v8 ignore start -- integration: real npm install + process spawn @preserve */ async (result) => {
        if (!result.latestVersion) return
        await performStagedRestart(result.latestVersion, {
          execSync: (cmd) => execSync(cmd, { stdio: "inherit" }),
          spawnSync,
          resolveNewCodePath: (_version) => {
            try {
              const resolved = execSync(`node -e "console.log(require.resolve('@ouro.bot/cli/package.json'))"`, { encoding: "utf-8" }).trim()
              return resolved ? path.dirname(resolved) : null
            } catch {
              return null
            }
          },
          gracefulShutdown: () => daemon.stop(),
          nodePath: process.execPath,
          bundlesRoot,
        })
      },
      /* v8 ignore stop */
    })

    await this.processManager.startAutoStartAgents()
    await this.senseManager?.startAutoStartSenses()
    this.scheduler.start?.()
    await this.scheduler.reconcile?.()
    await this.drainPendingBundleMessages()

    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath)
    }

    this.server = net.createServer((connection) => {
      let raw = ""
      let responded = false

      const flushResponse = async () => {
        if (responded) return
        responded = true
        const response = await this.handleRawPayload(raw)
        connection.end(response)
      }

      connection.on("data", (chunk) => {
        raw += chunk.toString("utf-8")
        void flushResponse()
      })
      connection.on("end", () => {
        void flushResponse()
      })
    })

    const server = this.server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.socketPath, () => resolve())
    })
  }

  private async drainPendingBundleMessages(): Promise<void> {
    if (!fs.existsSync(this.bundlesRoot)) return

    let bundleDirs: fs.Dirent[]
    try {
      bundleDirs = fs.readdirSync(this.bundlesRoot, { withFileTypes: true })
    } catch {
      return
    }

    for (const bundleDir of bundleDirs) {
      if (!bundleDir.isDirectory() || !bundleDir.name.endsWith(".ouro")) continue
      const pendingPath = path.join(this.bundlesRoot, bundleDir.name, "inbox", "pending.jsonl")
      if (!fs.existsSync(pendingPath)) continue

      const raw = fs.readFileSync(pendingPath, "utf-8")
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)

      const retained: string[] = []
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            from?: unknown
            to?: unknown
            content?: unknown
            priority?: unknown
            sessionId?: unknown
            taskRef?: unknown
          }
          if (
            typeof parsed.from !== "string" ||
            typeof parsed.to !== "string" ||
            typeof parsed.content !== "string"
          ) {
            retained.push(line)
            continue
          }
          await this.router.send({
            from: parsed.from,
            to: parsed.to,
            content: parsed.content,
            priority: typeof parsed.priority === "string" ? parsed.priority : undefined,
            sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
            taskRef: typeof parsed.taskRef === "string" ? parsed.taskRef : undefined,
          })
        } catch {
          retained.push(line)
        }
      }

      const next = retained.length > 0 ? `${retained.join("\n")}\n` : ""
      fs.writeFileSync(pendingPath, next, "utf-8")
    }
  }

  async stop(): Promise<void> {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.server_stop",
      message: "stopping daemon server",
      meta: { socketPath: this.socketPath },
    })

    stopUpdateChecker()
    this.scheduler.stop?.()
    await this.processManager.stopAll()
    await this.senseManager?.stopAll()

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve())
      })
      this.server = null
    }

    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath)
    }
  }

  async handleRawPayload(raw: string): Promise<string> {
    try {
      const command = parseIncomingCommand(raw)
      const response = await this.handleCommand(command)
      return JSON.stringify(response)
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies DaemonResponse)
    }
  }

  async handleCommand(command: DaemonCommand): Promise<DaemonResponse> {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.command_received",
      message: "handling daemon command",
      meta: { kind: command.kind },
    })

    switch (command.kind) {
      case "daemon.start":
        await this.start()
        return { ok: true, message: "daemon started" }
      case "daemon.stop":
        await this.stop()
        return { ok: true, message: "daemon stopped" }
      case "daemon.status": {
        const snapshots = this.processManager.listAgentSnapshots()
        const workers = buildWorkerRows(snapshots)
        const senses = this.senseManager?.listSenseRows() ?? []
        const data: DaemonStatusPayload = {
          overview: {
            daemon: "running",
            health: workers.every((worker) => worker.status === "running") ? "ok" : "warn",
            socketPath: this.socketPath,
            ...getRuntimeMetadata(),
            workerCount: workers.length,
            senseCount: senses.length,
          },
          workers,
          senses,
        }
        return {
          ok: true,
          summary: formatStatusSummary(data),
          data,
        }
      }
      case "daemon.health": {
        const checks = await this.healthMonitor.runChecks()
        const summary = checks.map((check) => `${check.name}:${check.status}:${check.message}`).join("\n")
        return { ok: true, summary, data: checks }
      }
      case "daemon.logs":
        return {
          ok: true,
          summary: "logs: use `ouro logs` to tail daemon and agent output",
          message: "log streaming available via ouro logs",
          data: { logDir: "~/.agentstate/daemon/logs" },
        }
      case "agent.start":
        await this.processManager.startAgent(command.agent)
        return { ok: true, message: `started ${command.agent}` }
      case "agent.stop":
        await this.processManager.stopAgent?.(command.agent)
        return { ok: true, message: `stopped ${command.agent}` }
      case "agent.restart":
        await this.processManager.restartAgent?.(command.agent)
        return { ok: true, message: `restarted ${command.agent}` }
      case "cron.list": {
        const jobs = this.scheduler.listJobs()
        const summary = jobs.length === 0
          ? "no cron jobs"
          : jobs.map((job) => `${job.id}\t${job.schedule}\tlast=${job.lastRun ?? "never"}`).join("\n")
        return { ok: true, summary, data: jobs }
      }
      case "cron.trigger": {
        const result = await this.scheduler.triggerJob(command.jobId)
        return { ok: result.ok, message: result.message }
      }
      case "message.send": {
        const receipt = await this.router.send({
          from: command.from,
          to: command.to,
          content: command.content,
          priority: command.priority,
          sessionId: command.sessionId,
          taskRef: command.taskRef,
        })
        this.processManager.sendToAgent?.(command.to, { type: "message" })
        return { ok: true, message: `queued message ${receipt.id}`, data: receipt }
      }
      case "message.poll": {
        const messages = this.router.pollInbox(command.agent)
        return {
          ok: true,
          summary: `${messages.length} messages`,
          data: messages,
        }
      }
      case "chat.connect":
        await this.processManager.startAgent(command.agent)
        return {
          ok: true,
          message: `connected to ${command.agent}`,
        }
      case "task.poke": {
        const receipt = await this.router.send({
          from: "ouro-poke",
          to: command.agent,
          content: `poke ${command.taskId}`,
          priority: "high",
          taskRef: command.taskId,
        })
        await this.scheduler.recordTaskRun?.(command.agent, command.taskId)
        this.processManager.sendToAgent?.(command.agent, { type: "poke", taskId: command.taskId })
        return {
          ok: true,
          message: `queued poke ${receipt.id}`,
          data: receipt,
        }
      }
      case "hatch.start":
        return {
          ok: true,
          message: "hatch flow is stubbed in Gate 3 and completed in Gate 6",
        }
      default:
        return {
          ok: false,
          error: `Unknown daemon command kind '${(command as { kind: string }).kind}'.`,
        }
    }
  }
}
