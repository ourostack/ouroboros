import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonHealthResult } from "./daemon"

export interface SenseProbe {
  name: string
  managedName?: string
  check: () => Promise<{ ok: boolean; detail?: string }>
}

export interface HealthMonitorOptions {
  processManager: {
    listAgentSnapshots: () => Array<{
      name: string
      status: string
      errorReason?: string | null
      fixHint?: string | null
    }>
  }
  scheduler: {
    listJobs: () => Array<{ id: string; lastRun: string | null }>
  }
  alertSink?: (message: string) => Promise<void> | void
  diskUsagePercent?: () => number
  onCriticalAgent?: (agentName: string) => void
  onCriticalSense?: (managedName: string, probeName: string) => void
  senseProbes?: SenseProbe[]
  senseProbeProvider?: () => SenseProbe[]
}

export class HealthMonitor {
  private readonly processManager: HealthMonitorOptions["processManager"]
  private readonly scheduler: HealthMonitorOptions["scheduler"]
  private readonly alertSink: (message: string) => Promise<void> | void
  private readonly diskUsagePercent: () => number
  private readonly onCriticalAgent: (agentName: string) => void
  private readonly onCriticalSense: (managedName: string, probeName: string) => void
  private readonly senseProbes: SenseProbe[]
  private readonly senseProbeProvider: () => SenseProbe[]
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private lastResults: DaemonHealthResult[] = []

  constructor(options: HealthMonitorOptions) {
    this.processManager = options.processManager
    this.scheduler = options.scheduler
    this.alertSink = options.alertSink ?? (() => undefined)
    this.diskUsagePercent = options.diskUsagePercent ?? (() => 0)
    this.onCriticalAgent = options.onCriticalAgent ?? (() => undefined)
    this.onCriticalSense = options.onCriticalSense ?? (() => undefined)
    this.senseProbes = options.senseProbes ?? []
    this.senseProbeProvider = options.senseProbeProvider ?? (() => [])
  }

  private triggerSenseRecovery(probe: SenseProbe, detail: string): void {
    if (!probe.managedName) return
    try {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.health_check_sense_recovery_attempted",
        message: "triggering recovery restart for failed sense probe",
        meta: {
          probeName: probe.name,
          managedName: probe.managedName,
          detail,
        },
      })
      this.onCriticalSense(probe.managedName, probe.name)
    } catch {
      // Recovery is best-effort -- callback errors must not crash runChecks
    }
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
      const unhealthySummary = unhealthy.map((item) => {
        const detail = [
          item.errorReason ?? null,
          item.fixHint ? `fix: ${item.fixHint}` : null,
        ].filter((part): part is string => part !== null).join("; ")
        return detail.length > 0 ? `${item.name} (${detail})` : item.name
      }).join(", ")
      results.push({
        name: "agent-processes",
        status: "critical",
        message: `non-running agents: ${unhealthySummary}`,
      })
      for (const agent of unhealthy) {
        try {
          emitNervesEvent({
            level: "warn",
            component: "daemon",
            event: "daemon.health_check_recovery_attempted",
            message: "triggering recovery restart for non-running agent",
            meta: {
              agentName: agent.name,
              agentStatus: agent.status,
              errorReason: agent.errorReason ?? null,
              fixHint: agent.fixHint ?? null,
            },
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

    const senseProbes = [...this.senseProbes]
    try {
      senseProbes.push(...this.senseProbeProvider())
    } catch (error) {
      results.push({
        name: "sense-probes",
        status: "warn",
        message: `sense probe discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }

    for (const probe of senseProbes) {
      try {
        const outcome = await probe.check()
        if (outcome.ok) {
          results.push({
            name: `sense-probe:${probe.name}`,
            status: "ok",
            message: `${probe.name} healthy`,
          })
        } else {
          this.triggerSenseRecovery(probe, outcome.detail ?? "unknown")
          results.push({
            name: `sense-probe:${probe.name}`,
            status: "critical",
            message: `${probe.name} failed: ${outcome.detail ?? "unknown"}`,
          })
        }
      } catch (error) {
        this.triggerSenseRecovery(probe, error instanceof Error ? error.message : String(error))
        results.push({
          name: `sense-probe:${probe.name}`,
          status: "critical",
          message: `${probe.name} error: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    this.lastResults = results.map((result) => ({ ...result }))

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

  getLastResults(): DaemonHealthResult[] {
    return this.lastResults.map((result) => ({ ...result }))
  }
}
