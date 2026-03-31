import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseHabitFile, type HabitFile } from "./habit-parser"
import { parseCadenceToCron, parseCadenceToMs } from "./cadence"
import type { OsCronManager } from "./os-cron"
import type { ScheduledTaskJob } from "./task-scheduler"

export interface FsWatcher {
  close: () => void
}

export interface HabitSchedulerDeps {
  readdir: (dir: string) => string[]
  readFile: (filePath: string, encoding: string) => string
  writeFile: (filePath: string, content: string, encoding: string) => void
  existsSync: (target: string) => boolean
  now: () => number
  ouroPath: string
  watch?: (dir: string, callback: (event: string, filename: string | null) => void) => FsWatcher
}

export interface HabitSchedulerOptions {
  agent: string
  habitsDir: string
  osCronManager: OsCronManager
  onHabitFire: (habitName: string) => void
  deps: HabitSchedulerDeps
  execForVerify?: (cmd: string) => string
  platform?: string
}

export interface OverdueHabit {
  name: string
  elapsedMs: number
}

export interface DegradedHabit {
  name: string
  reason: string
}

export interface HabitParseError {
  file: string
  error: string
}

const WATCH_DEBOUNCE_MS = 200

export class HabitScheduler {
  private readonly agent: string
  private readonly habitsDir: string
  private readonly osCronManager: OsCronManager
  private readonly onHabitFire: (habitName: string) => void
  private readonly deps: HabitSchedulerDeps
  private readonly execForVerify?: (cmd: string) => string
  private readonly platform: string
  private watcher: FsWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private parseErrors: HabitParseError[] = []
  private timerFallbacks: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private degradedHabitNames: Map<string, string> = new Map()
  private periodicTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: HabitSchedulerOptions) {
    this.agent = options.agent
    this.habitsDir = options.habitsDir
    this.osCronManager = options.osCronManager
    this.onHabitFire = options.onHabitFire
    this.deps = options.deps
    this.execForVerify = options.execForVerify
    this.platform = options.platform ?? process.platform
  }

  start(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_scheduler_start",
      message: "habit scheduler starting",
      meta: { agent: this.agent, habitsDir: this.habitsDir },
    })

    const habits = this.scanHabits()
    const jobs = this.buildJobs(habits)
    this.osCronManager.sync(jobs)
    this.verifyCronAndCreateFallbacks(jobs)
    this.fireOverdueHabits(habits)
  }

  reconcile(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_scheduler_reconcile",
      message: "habit scheduler reconciling",
      meta: { agent: this.agent },
    })

    // Clear ALL existing timers FIRST to prevent overlap window
    this.clearAllTimerFallbacks()

    const habits = this.scanHabits()
    const jobs = this.buildJobs(habits)
    this.osCronManager.sync(jobs)
    this.verifyCronAndCreateFallbacks(jobs)
    this.fireOverdueHabits(habits)
  }

  private fireOverdueHabits(habits: HabitFile[]): void {
    for (const habit of habits) {
      if (habit.status !== "active") continue
      if (!habit.cadence) continue

      const cadenceMs = parseCadenceToMs(habit.cadence)
      if (cadenceMs === null) continue

      const nowMs = this.deps.now()

      if (habit.lastRun === null) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.habit_fire",
          message: "firing overdue habit (never run)",
          meta: { habitName: habit.name, agent: this.agent },
        })
        this.onHabitFire(habit.name)
        continue
      }

      const lastRunMs = new Date(habit.lastRun).getTime()
      const elapsed = nowMs - lastRunMs
      if (elapsed >= cadenceMs) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.habit_fire",
          message: "firing overdue habit",
          meta: { habitName: habit.name, agent: this.agent, elapsedMs: elapsed },
        })
        this.onHabitFire(habit.name)
      }
    }
  }

  stop(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_scheduler_stop",
      message: "habit scheduler stopping",
      meta: { agent: this.agent },
    })

    this.stopPeriodicReconciliation()
    this.clearAllTimerFallbacks()
    this.osCronManager.removeAll()
  }

  listOverdueHabits(): OverdueHabit[] {
    const habits = this.scanHabits()
    const nowMs = this.deps.now()
    const overdue: OverdueHabit[] = []

    for (const habit of habits) {
      if (habit.status !== "active") continue
      if (!habit.cadence) continue

      const cadenceMs = parseCadenceToMs(habit.cadence)
      if (cadenceMs === null) continue

      if (habit.lastRun === null) {
        overdue.push({ name: habit.name, elapsedMs: Infinity })
        continue
      }

      const lastRunMs = new Date(habit.lastRun).getTime()
      const elapsed = nowMs - lastRunMs
      if (elapsed >= cadenceMs) {
        overdue.push({ name: habit.name, elapsedMs: elapsed })
      }
    }

    return overdue
  }

  getParseErrors(): HabitParseError[] {
    return [...this.parseErrors]
  }

  getHabitFile(name: string): HabitFile | null {
    const filePath = path.join(this.habitsDir, `${name}.md`)
    try {
      const content = this.deps.readFile(filePath, "utf-8")
      return parseHabitFile(content, filePath)
    } catch {
      return null
    }
  }

  watchForChanges(): void {
    const watchFn = this.deps.watch
    if (!watchFn) return

    // Ensure habits directory exists before watching — agents may not have one yet
    try {
      this.watcher = watchFn(this.habitsDir, (_event: string, _filename: string | null) => {
        if (this.debounceTimer !== null) {
          clearTimeout(this.debounceTimer)
        }
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null
          this.reconcile()
        }, WATCH_DEBOUNCE_MS)
      })
    /* v8 ignore start — ENOENT catch requires real missing directory @preserve */
    } catch {
      // habits directory may not exist for all agents — skip watching silently
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

  getDegradedHabits(): DegradedHabit[] {
    const result: DegradedHabit[] = []
    for (const [name, reason] of this.degradedHabitNames) {
      result.push({ name, reason })
    }
    return result
  }

  private static readonly DEFAULT_PERIODIC_INTERVAL_MS = 300_000 // 5 minutes
  private static readonly INITIAL_RECONCILIATION_DELAY_MS = 30_000 // 30 seconds

  startPeriodicReconciliation(intervalMs?: number): void {
    const interval = intervalMs ?? HabitScheduler.DEFAULT_PERIODIC_INTERVAL_MS

    // First reconciliation after a short delay (30s)
    this.periodicTimer = setTimeout(() => {
      this.reconcile()
      this.scheduleNextReconciliation(interval)
    }, HabitScheduler.INITIAL_RECONCILIATION_DELAY_MS)
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

  private verifyCronAndCreateFallbacks(jobs: ScheduledTaskJob[]): void {
    if (!this.execForVerify) return

    const verifiedLabels = this.verifyCronEntries()

    for (const job of jobs) {
      const label = `bot.ouro.${job.agent}.${job.taskId}`
      const isVerified = this.platform === "darwin"
        ? verifiedLabels.has(label)
        : verifiedLabels.has(job.taskId)

      if (!isVerified) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.habit_cron_verification_failed",
          message: `cron verification failed for habit: ${job.taskId}`,
          meta: { habitName: job.taskId, agent: job.agent, label },
        })

        // Parse cadence from the original habit file for timer interval
        const habitFile = this.getHabitFile(job.taskId)
        const ms = habitFile?.cadence ? parseCadenceToMs(habitFile.cadence) : null
        if (ms !== null) {
          this.createTimerFallback(job.taskId, ms)
        }

        this.degradedHabitNames.set(job.taskId, "cron registration failed — using timer fallback")
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
          const match = line.match(/bot\.ouro\.\S+\.\S+/)
          if (match) {
            verified.add(match[0])
          }
        }
      } else {
        const output = this.execForVerify!("crontab -l")
        const lines = output.split("\n")
        for (const line of lines) {
          const match = line.match(/ouro poke \S+ --habit (\S+)/)
          if (match) {
            verified.add(match[1])
          }
        }
      }
    } catch {
      // Verification command failed — return empty set (all habits unverified)
    }

    return verified
  }

  private createTimerFallback(habitName: string, cadenceMs: number): void {
    const schedule = (): void => {
      const timer = setTimeout(() => {
        this.onHabitFire(habitName)
        schedule()
      }, cadenceMs)
      this.timerFallbacks.set(habitName, timer)
    }
    schedule()
  }

  private clearAllTimerFallbacks(): void {
    for (const timer of this.timerFallbacks.values()) {
      clearTimeout(timer)
    }
    this.timerFallbacks.clear()
    this.degradedHabitNames.clear()
  }

  private scanHabits(): HabitFile[] {
    let files: string[]
    try {
      files = this.deps.readdir(this.habitsDir)
    } catch {
      this.parseErrors = []
      return []
    }

    const habits: HabitFile[] = []
    const errors: HabitParseError[] = []
    for (const file of files) {
      if (!file.endsWith(".md")) continue

      const filePath = path.join(this.habitsDir, file)
      try {
        const content = this.deps.readFile(filePath, "utf-8")
        const habit = parseHabitFile(content, filePath)
        habits.push(habit)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        errors.push({ file, error: errorMessage })
        emitNervesEvent({
          level: "error",
          component: "daemon",
          event: "daemon.habit_parse_error",
          message: "failed to parse habit file",
          meta: {
            file,
            error: errorMessage,
            agent: this.agent,
          },
        })
      }
    }
    this.parseErrors = errors

    return habits
  }

  private buildJobs(habits: HabitFile[]): ScheduledTaskJob[] {
    const jobs: ScheduledTaskJob[] = []

    for (const habit of habits) {
      if (habit.status !== "active") continue
      if (!habit.cadence) continue

      const cronSchedule = parseCadenceToCron(habit.cadence)
      if (cronSchedule === null) continue

      jobs.push({
        id: `${this.agent}:${habit.name}:cadence`,
        agent: this.agent,
        taskId: habit.name,
        schedule: cronSchedule,
        lastRun: habit.lastRun,
        command: `${this.deps.ouroPath} poke ${this.agent} --habit ${habit.name}`,
        taskPath: path.join(this.habitsDir, `${habit.name}.md`),
      })
    }

    return jobs
  }
}
