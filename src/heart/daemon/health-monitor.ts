import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonHealthResult } from "./daemon"

export interface HealthMonitorOptions {
  processManager: {
    listAgentSnapshots: () => Array<{ name: string; status: string }>
  }
  scheduler: {
    listJobs: () => Array<{ id: string; lastRun: string | null }>
  }
  alertSink?: (message: string) => Promise<void> | void
  diskUsagePercent?: () => number
  onCriticalAgent?: (agentName: string) => void
}

export class HealthMonitor {
  private readonly processManager: HealthMonitorOptions["processManager"]
  private readonly scheduler: HealthMonitorOptions["scheduler"]
  private readonly alertSink: (message: string) => Promise<void> | void
  private readonly diskUsagePercent: () => number
  private readonly onCriticalAgent: (agentName: string) => void
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(options: HealthMonitorOptions) {
    this.processManager = options.processManager
    this.scheduler = options.scheduler
    this.alertSink = options.alertSink ?? (() => undefined)
    this.diskUsagePercent = options.diskUsagePercent ?? (() => 0)
    this.onCriticalAgent = options.onCriticalAgent ?? (() => undefined)
  }

  startPeriodicChecks(intervalMs: number): void {
    if (this.intervalHandle !== null) return
    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.health_check_scheduled",
      message: "periodic health checks started",
      meta: { intervalMs },
    })
    this.intervalHandle = setInterval(() => {
      void this.runChecks()
    }, intervalMs)
  }

  stopPeriodicChecks(): void {
    if (this.intervalHandle === null) return
    clearInterval(this.intervalHandle)
    this.intervalHandle = null
  }

  async runChecks(): Promise<DaemonHealthResult[]> {
    const results: DaemonHealthResult[] = []

    const snapshots = this.processManager.listAgentSnapshots()
    const unhealthy = snapshots.filter((snapshot) => snapshot.status !== "running")
    if (unhealthy.length > 0) {
      results.push({
        name: "agent-processes",
        status: "critical",
        message: `non-running agents: ${unhealthy.map((item) => item.name).join(", ")}`,
      })
      for (const agent of unhealthy) {
        try {
          emitNervesEvent({
            level: "warn",
            component: "daemon",
            event: "daemon.health_check_recovery_attempted",
            message: "triggering recovery restart for non-running agent",
            meta: { agentName: agent.name, agentStatus: agent.status },
          })
          this.onCriticalAgent(agent.name)
        } catch {
          // Recovery is best-effort -- callback errors must not crash runChecks
        }
      }
    } else {
      results.push({ name: "agent-processes", status: "ok", message: "all managed agents running" })
    }

    const jobs = this.scheduler.listJobs()
    const neverRan = jobs.filter((job) => !job.lastRun)
    if (neverRan.length > 0) {
      results.push({
        name: "cron-health",
        status: "warn",
        message: `jobs never run: ${neverRan.map((job) => job.id).join(", ")}`,
      })
    } else {
      results.push({ name: "cron-health", status: "ok", message: "cron jobs are healthy" })
    }

    const diskPercent = this.diskUsagePercent()
    if (diskPercent >= 90) {
      results.push({
        name: "disk-space",
        status: "critical",
        message: `disk usage critical (${diskPercent}%)`,
      })
    } else if (diskPercent >= 80) {
      results.push({
        name: "disk-space",
        status: "warn",
        message: `disk usage high (${diskPercent}%)`,
      })
    } else {
      results.push({
        name: "disk-space",
        status: "ok",
        message: `disk usage healthy (${diskPercent}%)`,
      })
    }

    for (const result of results) {
      emitNervesEvent({
        level: result.status === "critical" ? "error" : result.status === "warn" ? "warn" : "info",
        component: "daemon",
        event: "daemon.health_result",
        message: "daemon health check result",
        meta: { name: result.name, status: result.status },
      })
      if (result.status === "critical") {
        await this.alertSink(`[critical] ${result.name}: ${result.message}`)
      }
    }

    return results
  }
}
