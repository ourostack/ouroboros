import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseAwaitFile, type AwaitFile } from "./await-parser"
import { applyAwaitRuntimeState, type AwaitRuntimeState } from "./await-runtime-state"
import { parseCadenceToCron, parseCadenceToMs } from "../daemon/cadence"
import type { OsCronManager } from "../daemon/os-cron"
import type { ScheduledTaskJob } from "../daemon/task-scheduler"

export interface FsWatcher {
  close: () => void
}

export interface AwaitSchedulerDeps {
  readdir: (dir: string) => string[]
  readFile: (filePath: string, encoding: string) => string
  existsSync: (target: string) => boolean
  /** Ensure a directory exists (recursive). Called at scheduler start so the file watcher can attach. */
  mkdir: (dir: string) => void
  now: () => number
  ouroPath: string
  watch?: (dir: string, callback: (event: string, filename: string | null) => void) => FsWatcher
}

export interface AwaitSchedulerOptions {
  agent: string
  awaitsDir: string
  osCronManager: OsCronManager
  onAwaitFire: (awaitName: string) => void
  onAwaitExpire: (awaitName: string) => void
  deps: AwaitSchedulerDeps
  execForVerify?: (cmd: string) => string
  platform?: string
}

export interface AwaitParseError {
  file: string
  error: string
}

export interface DegradedAwait {
  name: string
  reason: string
}

const WATCH_DEBOUNCE_MS = 200

/** Cron-label namespace prefix to avoid collision with habits. */
export const AWAIT_CRON_LABEL_PREFIX_MARKER = "await"

type AwaitWithRuntime = AwaitFile & Partial<AwaitRuntimeState>

export class AwaitScheduler {
  private readonly agent: string
  private readonly awaitsDir: string
  private readonly osCronManager: OsCronManager
  private readonly onAwaitFire: (awaitName: string) => void
  private readonly onAwaitExpire: (awaitName: string) => void
  private readonly deps: AwaitSchedulerDeps
  private readonly execForVerify?: (cmd: string) => string
  private readonly platform: string
  private watcher: FsWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private parseErrors: AwaitParseError[] = []
  private timerFallbacks: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private degradedAwaitNames: Map<string, string> = new Map()
  private periodicTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: AwaitSchedulerOptions) {
    this.agent = options.agent
    this.awaitsDir = options.awaitsDir
    this.osCronManager = options.osCronManager
    this.onAwaitFire = options.onAwaitFire
    this.onAwaitExpire = options.onAwaitExpire
    this.deps = options.deps
    this.execForVerify = options.execForVerify
    this.platform = options.platform ?? process.platform
  }

  start(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.await_scheduler_start",
      message: "await scheduler starting",
      meta: { agent: this.agent, awaitsDir: this.awaitsDir },
    })

    // Ensure the awaits dir exists before scanning + attaching the file watcher.
    // Without this, fs.watch ENOENTs on cold start and the watcher is never installed,
    // so a freshly-filed first-ever await has to wait for the next periodic reconcile.
    this.deps.mkdir(this.awaitsDir)

    const awaits = this.scanAwaits()
    this.expireOverdueByMaxAge(awaits)
    const remaining = awaits.filter((a) => a.status === "pending" && !this.isExpiredByMaxAge(a))
    const jobs = this.buildJobs(remaining)
    this.osCronManager.sync(jobs)
    this.verifyCronAndCreateFallbacks(jobs)
    this.fireOverdueAwaits(remaining)
  }

  reconcile(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.await_scheduler_reconcile",
      message: "await scheduler reconciling",
      meta: { agent: this.agent },
    })

    this.clearAllTimerFallbacks()
    const awaits = this.scanAwaits()
    this.expireOverdueByMaxAge(awaits)
    const remaining = awaits.filter((a) => a.status === "pending" && !this.isExpiredByMaxAge(a))
    const jobs = this.buildJobs(remaining)
    this.osCronManager.sync(jobs)
    this.verifyCronAndCreateFallbacks(jobs)
    this.fireOverdueAwaits(remaining)
  }

  stop(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.await_scheduler_end",
      message: "await scheduler stopping",
      meta: { agent: this.agent },
    })

    this.stopPeriodicReconciliation()
    this.clearAllTimerFallbacks()
    this.osCronManager.removeAll()
  }

  getParseErrors(): AwaitParseError[] {
    return [...this.parseErrors]
  }

  getDegradedAwaits(): DegradedAwait[] {
    const out: DegradedAwait[] = []
    for (const [name, reason] of this.degradedAwaitNames) out.push({ name, reason })
    return out
  }

  getAwaitFile(name: string): AwaitFile | null {
    const filePath = path.join(this.awaitsDir, `${name}.md`)
    try {
      const content = this.deps.readFile(filePath, "utf-8")
      return applyAwaitRuntimeState(path.dirname(this.awaitsDir), parseAwaitFile(content, filePath))
    } catch {
      return null
    }
  }

  watchForChanges(): void {
    const watchFn = this.deps.watch
    if (!watchFn) return

    try {
      this.watcher = watchFn(this.awaitsDir, (_event: string, _filename: string | null) => {
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null
          this.reconcile()
        }, WATCH_DEBOUNCE_MS)
      })
    /* v8 ignore start — ENOENT catch requires real missing directory @preserve */
    } catch {
      // awaits dir may not exist yet — skip watching silently
    }
    /* v8 ignore stop */
  }

  stopWatching(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher !== null) {
      this.watcher.close()
      this.watcher = null
    }
  }

  private static readonly DEFAULT_PERIODIC_INTERVAL_MS = 300_000
  private static readonly INITIAL_RECONCILIATION_DELAY_MS = 30_000

  startPeriodicReconciliation(intervalMs?: number): void {
    const interval = intervalMs ?? AwaitScheduler.DEFAULT_PERIODIC_INTERVAL_MS
    this.periodicTimer = setTimeout(() => {
      this.reconcile()
      this.scheduleNextReconciliation(interval)
    }, AwaitScheduler.INITIAL_RECONCILIATION_DELAY_MS)
  }

  stopPeriodicReconciliation(): void {
    if (this.periodicTimer !== null) {
      clearTimeout(this.periodicTimer)
      this.periodicTimer = null
    }
  }

  private scheduleNextReconciliation(intervalMs: number): void {
    this.periodicTimer = setTimeout(() => {
      this.reconcile()
      this.scheduleNextReconciliation(intervalMs)
    }, intervalMs)
  }

  private fireOverdueAwaits(awaits: AwaitWithRuntime[]): void {
    for (const a of awaits) {
      if (!a.cadence) continue
      const cadenceMs = parseCadenceToMs(a.cadence)
      if (cadenceMs === null) continue

      const nowMs = this.deps.now()
      const lastChecked = a.last_checked ?? null

      if (lastChecked === null) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.await_fire",
          message: "firing overdue await (never checked)",
          meta: { awaitName: a.name, agent: this.agent },
        })
        this.onAwaitFire(a.name)
        continue
      }

      const lastCheckedMs = new Date(lastChecked).getTime()
      const elapsed = nowMs - lastCheckedMs
      if (elapsed >= cadenceMs) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.await_fire",
          message: "firing overdue await",
          meta: { awaitName: a.name, agent: this.agent, elapsedMs: elapsed },
        })
        this.onAwaitFire(a.name)
      }
    }
  }

  private isExpiredByMaxAge(a: AwaitFile): boolean {
    if (a.status !== "pending") return false
    if (!a.max_age || !a.created_at) return false
    const ageMs = parseCadenceToMs(a.max_age)
    if (ageMs === null) return false
    const createdMs = new Date(a.created_at).getTime()
    if (!Number.isFinite(createdMs)) return false
    return this.deps.now() - createdMs >= ageMs
  }

  private expireOverdueByMaxAge(awaits: AwaitWithRuntime[]): void {
    for (const a of awaits) {
      if (this.isExpiredByMaxAge(a)) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.await_expire",
          message: "await max_age elapsed; expiring",
          meta: { awaitName: a.name, agent: this.agent, max_age: a.max_age, created_at: a.created_at },
        })
        this.onAwaitExpire(a.name)
      }
    }
  }

  private verifyCronAndCreateFallbacks(jobs: ScheduledTaskJob[]): void {
    if (!this.execForVerify) return

    const verifiedLabels = this.verifyCronEntries()

    for (const job of jobs) {
      // job.taskId is already namespaced as "await.<name>". The bare name is
      // what we pass to `--await` and what shows up in the crontab regex
      // capture, so we strip the prefix for linux verification.
      const bareName = job.taskId.startsWith(`${AWAIT_CRON_LABEL_PREFIX_MARKER}.`)
        ? job.taskId.slice(AWAIT_CRON_LABEL_PREFIX_MARKER.length + 1)
        : /* v8 ignore next -- defensive: buildJobs always namespaces taskId @preserve */
          job.taskId
      const label = `bot.ouro.${job.agent}.${job.taskId}`
      const isVerified = this.platform === "darwin"
        ? verifiedLabels.has(label)
        : verifiedLabels.has(bareName)

      if (!isVerified) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.await_cron_verification_failed",
          message: `cron verification failed for await: ${bareName}`,
          meta: { awaitName: bareName, agent: job.agent, label },
        })

        const awaitFile = this.getAwaitFile(bareName)
        const ms = awaitFile?.cadence ? parseCadenceToMs(awaitFile.cadence) : null
        if (ms !== null) this.createTimerFallback(bareName, ms)
        this.degradedAwaitNames.set(bareName, "cron registration failed — using timer fallback")
      }
    }
  }

  private verifyCronEntries(): Set<string> {
    const verified = new Set<string>()
    try {
      if (this.platform === "darwin") {
        const output = this.execForVerify!("launchctl list")
        const lines = output.split("\n")
        for (const line of lines) {
          const match = line.match(/bot\.ouro\.\S+\.await\.\S+/)
          if (match) verified.add(match[0])
        }
      } else {
        const output = this.execForVerify!("crontab -l")
        const lines = output.split("\n")
        for (const line of lines) {
          const match = line.match(/ouro poke \S+ --await (\S+)/)
          if (match) verified.add(match[1])
        }
      }
    } catch {
      // best-effort
    }
    return verified
  }

  private createTimerFallback(awaitName: string, cadenceMs: number): void {
    const schedule = (): void => {
      const timer = setTimeout(() => {
        this.onAwaitFire(awaitName)
        schedule()
      }, cadenceMs)
      this.timerFallbacks.set(awaitName, timer)
    }
    schedule()
  }

  private clearAllTimerFallbacks(): void {
    for (const timer of this.timerFallbacks.values()) clearTimeout(timer)
    this.timerFallbacks.clear()
    this.degradedAwaitNames.clear()
  }

  private scanAwaits(): AwaitWithRuntime[] {
    let files: string[]
    try {
      files = this.deps.readdir(this.awaitsDir)
    } catch {
      this.parseErrors = []
      return []
    }

    const awaits: AwaitWithRuntime[] = []
    const errors: AwaitParseError[] = []
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const filePath = path.join(this.awaitsDir, file)
      try {
        const content = this.deps.readFile(filePath, "utf-8")
        const a = applyAwaitRuntimeState(path.dirname(this.awaitsDir), parseAwaitFile(content, filePath)) as AwaitWithRuntime
        awaits.push(a)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        errors.push({ file, error: errorMessage })
        emitNervesEvent({
          level: "error",
          component: "daemon",
          event: "daemon.await_parse_error",
          message: "failed to parse await file",
          meta: { file, error: errorMessage, agent: this.agent },
        })
      }
    }
    this.parseErrors = errors
    return awaits
  }

  private buildJobs(awaits: AwaitWithRuntime[]): ScheduledTaskJob[] {
    const jobs: ScheduledTaskJob[] = []
    for (const a of awaits) {
      /* v8 ignore next -- defensive: callers (start/reconcile) pre-filter to pending awaits @preserve */
      if (a.status !== "pending") continue
      if (!a.cadence) continue
      const cronSchedule = parseCadenceToCron(a.cadence)
      if (cronSchedule === null) continue

      jobs.push({
        id: `${this.agent}:${AWAIT_CRON_LABEL_PREFIX_MARKER}.${a.name}:cadence`,
        agent: this.agent,
        taskId: `${AWAIT_CRON_LABEL_PREFIX_MARKER}.${a.name}`,
        schedule: cronSchedule,
        lastRun: a.last_checked ?? null,
        command: `${this.deps.ouroPath} poke ${this.agent} --await ${a.name}`,
        taskPath: path.join(this.awaitsDir, `${a.name}.md`),
      })
    }
    return jobs
  }
}
