import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { getAgentBundlesRoot, getRepoRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonSenseManagerLike, DaemonSenseRow } from "./sense-manager"
import { getRuntimeMetadata } from "./runtime-metadata"
import { detectRuntimeMode } from "./runtime-mode"
import { applyPendingUpdates, registerUpdateHook } from "./update-hooks"
import { bundleMetaHook } from "./hooks/bundle-meta"
import { agentConfigV2Hook } from "./hooks/agent-config-v2"
import { getPackageVersion } from "../../mind/bundle-manifest"
import { startUpdateChecker, stopUpdateChecker } from "./update-checker"
import { performStagedRestart } from "./staged-restart"
import { execSync, spawn, spawnSync } from "child_process"
import { drainPending } from "../../mind/pending"
import {
  handleAgentAsk, handleAgentCatchup, handleAgentCheckGuidance,
  handleAgentCheckScope, handleAgentDelegate, handleAgentGetContext,
  handleAgentGetTask, handleAgentReportBlocker, handleAgentReportComplete,
  handleAgentReportProgress, handleAgentRequestDecision, handleAgentSearchMemory,
  handleAgentStatus,
} from "./agent-service"
import { getAlwaysOnSenseNames } from "../../mind/friends/channel"
import { getSharedMcpManager, shutdownSharedMcpManager } from "../../repertoire/mcp-manager"
import { startOutlookHttpServer, type OutlookHttpServerHandle } from "./outlook-http"
import { OUTLOOK_DEFAULT_PORT } from "./outlook-types"
import { readOutlookAgentState, readOutlookMachineState } from "./outlook-read"
import { buildOutlookAgentView, buildOutlookMachineView } from "./outlook-view"

const PIDFILE_PATH = path.join(os.homedir(), ".ouro-cli", "daemon.pids")

/**
 * Kill all ouro processes from the previous daemon instance using the pidfile.
 * On startup, reads PIDs from ~/.ouro-cli/daemon.pids, kills them all, then
 * deletes the file. The new daemon writes its own PIDs after spawning.
 *
 * Falls back to ps-based scanning if the pidfile doesn't exist (first run
 * or manual cleanup).
 */
/* v8 ignore start -- process lifecycle: uses kill/ps, tested via deployment @preserve */
export function killOrphanProcesses(): void {
  try {
    let pidsToKill: number[] = []

    // Primary: read pidfile from previous daemon
    try {
      const raw = fs.readFileSync(PIDFILE_PATH, "utf-8")
      pidsToKill = raw.split("\n").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n !== process.pid)
      fs.unlinkSync(PIDFILE_PATH)
    } catch {
      // No pidfile — fall back to ps scan
    }

    // Fallback: scan ps for daemon-owned processes only (not MCP servers or external tools)
    if (pidsToKill.length === 0) {
      try {
        const result = execSync("ps -eo pid,command", { encoding: "utf-8", timeout: 5000 })
        for (const line of result.split("\n")) {
          // Only match daemon-owned entry points, NOT mcp-serve or other external processes
          if (line.includes("mcp-serve") || line.includes("mcp serve")) continue
          if (!line.includes("agent-entry.js") && !line.includes("daemon-entry.js") && !line.includes("bluebubbles-entry.js") && !line.includes("teams-entry.js")) continue
          const pid = parseInt(line.trim(), 10)
          if (!isNaN(pid) && pid !== process.pid) pidsToKill.push(pid)
        }
      } catch { /* ps failed — best effort */ }
    }

    if (pidsToKill.length > 0) {
      for (const pid of pidsToKill) {
        try { process.kill(pid, "SIGTERM") } catch { /* already exited */ }
      }
      emitNervesEvent({
        component: "daemon",
        event: "daemon.orphan_cleanup",
        message: `killed ${pidsToKill.length} orphaned ouro processes`,
        meta: { pids: pidsToKill },
      })
    }
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.orphan_cleanup_error",
      message: "failed to clean up orphaned ouro processes",
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }
}

/**
 * Write all managed PIDs (daemon + children) to the pidfile.
 * Called after all agents and senses are spawned.
 */
export function writePidfile(extraPids: number[] = []): void {
  try {
    const pids = [process.pid, ...extraPids].filter(Boolean)
    fs.mkdirSync(path.dirname(PIDFILE_PATH), { recursive: true })
    fs.writeFileSync(PIDFILE_PATH, pids.join("\n") + "\n", "utf-8")
  } catch { /* best effort */ }
}
/* v8 ignore stop */

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
    lastExitCode?: number | null
    lastSignal?: string | null
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
  | { kind: "agent.ask"; agent: string; friendId: string; question?: string; [key: string]: unknown }
  | { kind: "agent.status"; agent: string; friendId: string; [key: string]: unknown }
  | { kind: "agent.catchup"; agent: string; friendId: string; [key: string]: unknown }
  | { kind: "agent.delegate"; agent: string; friendId: string; task?: string; context?: string; [key: string]: unknown }
  | { kind: "agent.getContext"; agent: string; friendId: string; [key: string]: unknown }
  | { kind: "agent.searchMemory"; agent: string; friendId: string; query?: string; [key: string]: unknown }
  | { kind: "agent.getTask"; agent: string; friendId: string; [key: string]: unknown }
  | { kind: "agent.checkScope"; agent: string; friendId: string; item?: string; [key: string]: unknown }
  | { kind: "agent.requestDecision"; agent: string; friendId: string; topic?: string; options?: string[]; [key: string]: unknown }
  | { kind: "agent.checkGuidance"; agent: string; friendId: string; topic?: string; [key: string]: unknown }
  | { kind: "agent.reportProgress"; agent: string; friendId: string; summary?: string; [key: string]: unknown }
  | { kind: "agent.reportBlocker"; agent: string; friendId: string; blocker?: string; [key: string]: unknown }
  | { kind: "agent.reportComplete"; agent: string; friendId: string; summary?: string; [key: string]: unknown }
  | { kind: "cron.list" }
  | { kind: "cron.trigger"; jobId: string }
  | { kind: "inner.wake"; agent: string }
  | { kind: "chat.connect"; agent: string }
  | { kind: "task.poke"; agent: string; taskId: string }
  | { kind: "habit.poke"; agent: string; habitName: string }
  | { kind: "message.send"; from: string; to: string; content: string; priority?: string; sessionId?: string; taskRef?: string }
  | { kind: "message.poll"; agent: string }
  | { kind: "mcp.list" }
  | { kind: "mcp.call"; server: string; tool: string; args?: string }
  | { kind: "hatch.start" }
  | { kind: "agent.senseTurn"; agent: string; friendId: string; channel: string; sessionKey: string; message: string }

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
  mode?: "dev" | "production"
}

interface DaemonWorkerRow {
  agent: string
  worker: string
  status: string
  pid: number | null
  restartCount: number
  startedAt: string | null
  lastExitCode: number | null
  lastSignal: string | null
}

interface DaemonStatusOverview {
  daemon: "running" | "stopped"
  health: "ok" | "warn"
  socketPath: string
  outlookUrl: string
  version: string
  lastUpdated: string
  repoRoot: string
  configFingerprint: string
  workerCount: number
  senseCount: number
  entryPath: string
  mode: "dev" | "production"
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
    lastExitCode: snapshot.lastExitCode ?? null,
    lastSignal: snapshot.lastSignal ?? null,
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

/**
 * Handle agent.senseTurn command: runs a full agent turn via the daemon process.
 * Dynamic import lazy-loads shared-turn. Hot-reload works because ouro dev
 * restarts the daemon process (fresh module cache).
 */
export async function handleAgentSenseTurn(
  command: Extract<DaemonCommand, { kind: "agent.senseTurn" }>,
): Promise<DaemonResponse> {
  try {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: command.agent,
      channel: command.channel as import("../../mind/friends/types").Channel,
      sessionKey: command.sessionKey,
      friendId: command.friendId,
      userMessage: command.message,
    })
    return {
      ok: true,
      message: result.response,
      data: { ponderDeferred: result.ponderDeferred },
    }
  } catch (error) {
    /* v8 ignore next -- branch: String(error) fallback only for non-Error throws @preserve */
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `sense turn failed: ${errorMessage}` }
  }
}

export class OuroDaemon {
  private readonly socketPath: string
  private readonly processManager: DaemonProcessManagerLike
  private readonly scheduler: DaemonSchedulerLike
  private readonly healthMonitor: DaemonHealthMonitorLike
  private readonly router: DaemonRouterLike
  private readonly senseManager: DaemonSenseManagerLike | null
  private readonly bundlesRoot: string
  private readonly mode: "dev" | "production"
  private server: net.Server | null = null
  private outlookServer: OutlookHttpServerHandle | null = null

  constructor(options: OuroDaemonOptions) {
    this.socketPath = options.socketPath
    this.processManager = options.processManager
    this.scheduler = options.scheduler
    this.healthMonitor = options.healthMonitor
    this.router = options.router
    this.senseManager = options.senseManager ?? null
    this.bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
    this.mode = options.mode ?? "production"
  }

  private buildStatusPayload(): DaemonStatusPayload {
    const snapshots = this.processManager.listAgentSnapshots()
    const workers = buildWorkerRows(snapshots)
    const senses = this.senseManager?.listSenseRows() ?? []
    const repoRoot = getRepoRoot()

    return {
      overview: {
        daemon: "running",
        health: workers.every((worker) => worker.status === "running") ? "ok" : "warn",
        socketPath: this.socketPath,
        outlookUrl: this.outlookServer?.origin ?? "http://127.0.0.1:0",
        ...getRuntimeMetadata(),
        workerCount: workers.length,
        senseCount: senses.length,
        entryPath: path.join(repoRoot, "dist", "heart", "daemon", "daemon-entry.js"),
        mode: detectRuntimeMode(repoRoot),
      },
      workers,
      senses,
    }
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
    registerUpdateHook(agentConfigV2Hook)
    const currentVersion = getPackageVersion()
    await applyPendingUpdates(this.bundlesRoot, currentVersion)

    // Start periodic update checker (polls npm registry every 30 minutes)
    // Skip in dev mode — dev builds should not auto-update from npm
    const bundlesRoot = this.bundlesRoot
    const daemonSocketPath = this.socketPath
    if (this.mode === "dev") {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.update_checker_skip",
        message: "skipping update checker in dev mode",
        meta: { reason: "dev mode" },
      })
    } else {
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
            spawnNewDaemon: (entryPath, sock) => {
              const outFd = fs.openSync(os.devNull, "w")
              const errFd = fs.openSync(os.devNull, "w")
              const child = spawn(process.execPath, [entryPath, "--socket", sock], {
                detached: true,
                stdio: ["ignore", outFd, errFd],
              })
              child.unref()
              return { pid: child.pid ?? null }
            },
            nodePath: process.execPath,
            bundlesRoot,
            socketPath: daemonSocketPath,
          })
        },
        /* v8 ignore stop */
      })
    }

    // Pre-initialize MCP connections so they're ready for the first command (non-blocking)
    /* v8 ignore next -- catch callback: getSharedMcpManager logs errors internally @preserve */
    getSharedMcpManager().catch(() => {})

    /* v8 ignore start -- orphan cleanup + pidfile: calls process management functions @preserve */
    killOrphanProcesses()
    /* v8 ignore stop */
    await this.processManager.startAutoStartAgents()
    await this.senseManager?.startAutoStartSenses()

    // Write all managed PIDs to disk so the next daemon can clean up
    /* v8 ignore start -- pidfile write: collects PIDs from process managers @preserve */
    const agentPids = this.processManager.listAgentSnapshots().map((s) => s.pid).filter((p): p is number => p !== null)
    const sensePids = this.senseManager?.listManagedPids?.() ?? []
    writePidfile([...agentPids, ...sensePids])
    /* v8 ignore stop */

    this.scheduler.start?.()
    await this.scheduler.reconcile?.()
    await this.drainPendingBundleMessages()
    await this.drainPendingSenseMessages()
    /* v8 ignore start — Outlook server startup, tested via outlook-http.test.ts */
    if (!this.outlookServer) {
      try {
        this.outlookServer = await startOutlookHttpServer({
          host: "127.0.0.1",
          port: OUTLOOK_DEFAULT_PORT,
          bundlesRoot: this.bundlesRoot,
          readMachineState: () => readOutlookMachineState({ bundlesRoot: this.bundlesRoot }),
          readMachineView: ({ machine }) => {
            const overview = this.buildStatusPayload().overview
            return buildOutlookMachineView({
              machine,
              daemon: {
                status: overview.daemon,
                health: overview.health,
                mode: overview.mode,
                socketPath: overview.socketPath,
                outlookUrl: overview.outlookUrl,
                entryPath: overview.entryPath,
                workerCount: overview.workerCount,
                senseCount: overview.senseCount,
              },
            })
          },
          readAgentState: (agentName) => readOutlookAgentState(agentName, { bundlesRoot: this.bundlesRoot }),
          readAgentView: (agentName) => {
            const agent = readOutlookAgentState(agentName, { bundlesRoot: this.bundlesRoot })
            return buildOutlookAgentView({
              agent,
              viewer: { kind: "human" },
            })
          },
        })
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.outlook_start_failed",
          message: `Outlook server failed to start: ${String(error)}`,
          meta: { port: OUTLOOK_DEFAULT_PORT },
        })
      }
    }
    /* v8 ignore stop */

    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath)
    }

    this.server = net.createServer((connection) => {
      let raw = ""
      let responded = false

      /* v8 ignore start — connection error handler requires real socket error @preserve */
      connection.on("error", (err) => {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.connection_error",
          message: "socket connection error",
          meta: { error: err.message, code: (err as NodeJS.ErrnoException).code ?? null },
        })
      })
      /* v8 ignore stop */

      const flushResponse = async () => {
        if (responded) return
        responded = true
        const response = await this.handleRawPayload(raw)
        try {
          connection.end(response)
        /* v8 ignore start — EPIPE catch requires real socket disconnect @preserve */
        } catch (err) {
          emitNervesEvent({
            level: "warn",
            component: "daemon",
            event: "daemon.connection_end_error",
            message: "failed to send response to client (EPIPE)",
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
        /* v8 ignore stop */
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
      server.listen(this.socketPath, () => {
        // Replace the one-time error listener with a persistent one after successful listen
        server.removeAllListeners("error")
        /* v8 ignore start — server error after listen requires real socket race condition @preserve */
        server.on("error", (err) => {
          emitNervesEvent({
            level: "error",
            component: "daemon",
            event: "daemon.server_error",
            message: "daemon server error after listen",
            meta: { error: err.message, code: (err as NodeJS.ErrnoException).code ?? null },
          })
        })
        /* v8 ignore stop */
        resolve()
      })
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

  /** Drains per-sense pending dirs for always-on senses across all agents. */
  private static readonly ALWAYS_ON_SENSES = new Set(getAlwaysOnSenseNames())

  private async drainPendingSenseMessages(): Promise<void> {
    if (!fs.existsSync(this.bundlesRoot)) return

    let bundleDirs: fs.Dirent[]
    try {
      bundleDirs = fs.readdirSync(this.bundlesRoot, { withFileTypes: true })
    } catch {
      return
    }

    for (const bundleDir of bundleDirs) {
      if (!bundleDir.isDirectory() || !bundleDir.name.endsWith(".ouro")) continue

      const agentName = bundleDir.name.replace(/\.ouro$/, "")
      const pendingRoot = path.join(this.bundlesRoot, bundleDir.name, "state", "pending")
      if (!fs.existsSync(pendingRoot)) continue

      let friendDirs: fs.Dirent[]
      try {
        friendDirs = fs.readdirSync(pendingRoot, { withFileTypes: true })
      } catch {
        continue
      }

      for (const friendDir of friendDirs) {
        if (!friendDir.isDirectory()) continue
        const friendPath = path.join(pendingRoot, friendDir.name)

        let channelDirs: fs.Dirent[]
        try {
          channelDirs = fs.readdirSync(friendPath, { withFileTypes: true })
        } catch {
          continue
        }

        for (const channelDir of channelDirs) {
          if (!channelDir.isDirectory()) continue
          if (!OuroDaemon.ALWAYS_ON_SENSES.has(channelDir.name)) continue

          const channelPath = path.join(friendPath, channelDir.name)

          let keyDirs: fs.Dirent[]
          try {
            keyDirs = fs.readdirSync(channelPath, { withFileTypes: true })
          } catch {
            continue
          }

          for (const keyDir of keyDirs) {
            if (!keyDir.isDirectory()) continue
            const leafDir = path.join(channelPath, keyDir.name)
            const messages = drainPending(leafDir)

            for (const msg of messages) {
              try {
                await this.router.send({
                  from: msg.from,
                  to: agentName,
                  content: msg.content,
                  priority: "normal",
                })
              } catch {
                // Best-effort delivery — log and continue
              }
            }

            if (messages.length > 0) {
              emitNervesEvent({
                component: "daemon",
                event: "daemon.startup_sense_drain",
                message: "drained pending sense messages on startup",
                meta: {
                  agent: agentName,
                  channel: channelDir.name,
                  friendId: friendDir.name,
                  key: keyDir.name,
                  count: messages.length,
                },
              })
            }
          }
        }
      }
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
    shutdownSharedMcpManager()
    this.scheduler.stop?.()
    await this.processManager.stopAll()
    await this.senseManager?.stopAll()

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve())
      })
      this.server = null
    }
    if (this.outlookServer) {
      await this.outlookServer.stop()
      this.outlookServer = null
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

    try {
      return await this.handleCommandInner(command)
    /* v8 ignore start — command error catch tested in daemon-command-error.test; instanceof branches defensive @preserve */
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.command_error",
        message: "unexpected error handling daemon command",
        meta: {
          kind: command.kind,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack ?? null : null,
        },
      })
      throw error
    }
    /* v8 ignore stop */
  }

  private async handleCommandInner(command: DaemonCommand): Promise<DaemonResponse> {
    switch (command.kind) {
      case "daemon.start":
        await this.start()
        return { ok: true, message: "daemon started" }
      case "daemon.stop":
        await this.stop()
        return { ok: true, message: "daemon stopped" }
      case "daemon.status": {
        const data = this.buildStatusPayload()
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
          data: { logDir: "~/AgentBundles/<agent>.ouro/state/daemon/logs" },
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
      case "agent.ask":
        return handleAgentAsk(command)
      case "agent.status":
        return handleAgentStatus(command)
      case "agent.catchup":
        return handleAgentCatchup(command)
      case "agent.delegate":
        return handleAgentDelegate(command)
      case "agent.getContext":
        return handleAgentGetContext(command)
      case "agent.searchMemory":
        return handleAgentSearchMemory(command)
      case "agent.getTask":
        return handleAgentGetTask(command)
      case "agent.checkScope":
        return handleAgentCheckScope(command)
      case "agent.requestDecision":
        return handleAgentRequestDecision(command)
      case "agent.checkGuidance":
        return handleAgentCheckGuidance(command)
      case "agent.reportProgress":
        return handleAgentReportProgress(command)
      case "agent.reportBlocker":
        return handleAgentReportBlocker(command)
      case "agent.reportComplete":
        return handleAgentReportComplete(command)
      case "agent.senseTurn":
        return handleAgentSenseTurn(command)
      /* v8 ignore stop */
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
      case "inner.wake":
        await this.processManager.startAgent(command.agent)
        this.processManager.sendToAgent?.(command.agent, { type: "message" })
        return {
          ok: true,
          message: `woke inner dialog for ${command.agent}`,
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
      case "habit.poke": {
        this.processManager.sendToAgent?.(command.agent, { type: "habit", habitName: command.habitName })
        return {
          ok: true,
          message: `poked habit ${command.habitName} for ${command.agent}`,
        }
      }
      case "mcp.list": {
        const mcpManager = await getSharedMcpManager()
        if (!mcpManager) {
          return { ok: true, data: [], message: "no MCP servers configured" }
        }
        return { ok: true, data: mcpManager.listAllTools() }
      }
      case "mcp.call": {
        const mcpCallManager = await getSharedMcpManager()
        if (!mcpCallManager) {
          return { ok: false, error: "no MCP servers configured" }
        }
        try {
          const parsedArgs = command.args ? JSON.parse(command.args) as Record<string, unknown> : {}
          const result = await mcpCallManager.callTool(command.server, command.tool, parsedArgs)
          return { ok: true, data: result }
        } catch (error) {
          /* v8 ignore next -- defensive: callTool errors are always Error instances @preserve */
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
