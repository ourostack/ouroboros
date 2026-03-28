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
}

export interface OverdueHabit {
  name: string
  elapsedMs: number
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
  private watcher: FsWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private parseErrors: HabitParseError[] = []

  constructor(options: HabitSchedulerOptions) {
    this.agent = options.agent
    this.habitsDir = options.habitsDir
    this.osCronManager = options.osCronManager
    this.onHabitFire = options.onHabitFire
    this.deps = options.deps
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

    // Fire overdue habits immediately
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

  reconcile(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_scheduler_reconcile",
      message: "habit scheduler reconciling",
      meta: { agent: this.agent },
    })

    const habits = this.scanHabits()
    const jobs = this.buildJobs(habits)
    this.osCronManager.sync(jobs)
  }

  stop(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_scheduler_stop",
      message: "habit scheduler stopping",
      meta: { agent: this.agent },
    })

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

    this.watcher = watchFn(this.habitsDir, (_event: string, _filename: string | null) => {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer)
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null
        this.reconcile()
      }, WATCH_DEBOUNCE_MS)
    })
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
