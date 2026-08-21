import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseHabitFile, type HabitFile } from "./habit-parser"
import { applyHabitRuntimeState } from "./habit-runtime-state"
import { cadenceFallbackDelayMs, evaluateCadenceDue, nextCadenceRunAt, parseCadenceToCron, parseCadenceToMs } from "../daemon/cadence"
import { isRsvpHabitName } from "../../rsvp/habit-policy"
import type { OsCronManager } from "../daemon/os-cron"
import type { ScheduledTaskJob } from "../daemon/task-scheduler"
import type { HabitRunTrigger } from "../../arc/flight-recorder"

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
  onHabitFire: (habitName: string, trigger: HabitRunTrigger, context?: HabitFireContext) => void
  deps: HabitSchedulerDeps
  execForVerify?: (cmd: string) => string
  verifyJobs?: (jobs: ScheduledTaskJob[]) => boolean
  platform?: string
}

export interface HabitFireContext {
  occurrenceId: string
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

interface HabitSnapshot {
  content: string
  definition: HabitFile
}

interface SchedulerState {
  habits: HabitFile[]
  jobs: ScheduledTaskJob[]
}

interface TimerFallback {
  handle: ReturnType<typeof setTimeout>
  cadence: string
  generation: number
}

const WATCH_DEBOUNCE_MS = 200
const MAX_CRON_VERIFICATION_ATTEMPTS = 3

export class HabitScheduler {
  private readonly agent: string
  private readonly habitsDir: string
  private readonly osCronManager: OsCronManager
  private readonly onHabitFire: (habitName: string, trigger: HabitRunTrigger, context?: HabitFireContext) => void
  private readonly deps: HabitSchedulerDeps
  private readonly execForVerify?: (cmd: string) => string
  private readonly verifyJobs?: (jobs: ScheduledTaskJob[]) => boolean
  private readonly platform: string
  private watcher: FsWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private parseErrors: HabitParseError[] = []
  private timerFallbacks: Map<string, TimerFallback> = new Map()
  private timerFallbackGenerations: Map<string, number> = new Map()
  private degradedHabitNames: Map<string, string> = new Map()
  private periodicTimer: ReturnType<typeof setTimeout> | null = null
  private habitSnapshots: Map<string, HabitSnapshot> = new Map()

  constructor(options: HabitSchedulerOptions) {
    this.agent = options.agent
    this.habitsDir = options.habitsDir
    this.osCronManager = options.osCronManager
    this.onHabitFire = options.onHabitFire
    this.deps = options.deps
    this.execForVerify = options.execForVerify
    this.verifyJobs = options.verifyJobs
    this.platform = options.platform ?? process.platform
  }

  start(): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_scheduler_start",
      message: "habit scheduler starting",
      meta: { agent: this.agent, habitsDir: this.habitsDir },
    })

    this.runSchedulingCycle()
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

    this.runSchedulingCycle()
  }

  private runSchedulingCycle(): void {
    const scannedHabits = this.scanHabits()
    let state = this.revalidateState({
      habits: scannedHabits,
      jobs: this.buildJobs(scannedHabits),
    })

    if (!this.syncJobsFailClosed(state.jobs)) return

    const afterSync = this.revalidateAndCorrectJobs(state)
    if (afterSync === null) return
    state = afterSync

    const afterVerification = this.verifyCronAndCreateFallbacks(state)
    if (afterVerification === null) return
    state = afterVerification

    const beforeDispatch = this.revalidateAndCorrectJobs(state)
    if (beforeDispatch === null) return
    this.fireOverdueHabits(beforeDispatch)
  }

  private fireOverdueHabits(state: SchedulerState): void {
    for (const expectedJob of state.jobs) {
      const habit = this.revalidateHabit(expectedJob.taskId)
      if (habit === null) continue
      const currentJob = this.buildJobs([habit]).find((job) => job.id === expectedJob.id)
      if (!currentJob || !this.jobEqual(expectedJob, currentJob)) continue

      const nowMs = this.deps.now()
      const dueState = evaluateCadenceDue(habit.cadence!, habit.lastRun, nowMs)
      if (dueState === null) continue

      if (dueState.due) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.habit_fire",
          message: habit.lastRun === null ? "firing overdue habit (never run)" : "firing overdue habit",
          meta: { habitName: habit.name, agent: this.agent, elapsedMs: dueState.elapsedMs },
        })
        this.onHabitFire(habit.name, "overdue", {
          occurrenceId: dueState.occurrenceId ?? this.overdueOccurrenceId(habit),
        })
      }
    }
  }

  stop(): void {
    // `_end` (not `_stop`) to pair with `daemon.habit_scheduler_start`
    // under the nerves audit start/end pairing rule.
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_scheduler_end",
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
      if (this.rejectInvalidRsvpHabit(habit)) continue
      if (this.rejectReservedCronNamespaceHabit(habit)) continue

      const dueState = evaluateCadenceDue(habit.cadence, habit.lastRun, nowMs)
      if (dueState?.due) overdue.push({ name: habit.name, elapsedMs: dueState.elapsedMs })
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
      return applyHabitRuntimeState(path.dirname(this.habitsDir), parseHabitFile(content, filePath))
    } catch {
      return null
    }
  }

  listJobs(): Array<{ id: string; schedule: string; lastRun: string | null }> {
    return this.buildJobs(this.scanHabits())
      .map((job) => ({ id: job.id, schedule: job.schedule, lastRun: job.lastRun }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async triggerJob(jobId: string, trigger: HabitRunTrigger = "cron"): Promise<{ ok: boolean; message: string }> {
    const job = this.buildJobs(this.scanHabits()).find((candidate) => candidate.id === jobId)
    if (!job) {
      return { ok: false, message: `unknown habit job: ${jobId}` }
    }

    const currentHabit = this.revalidateHabit(job.taskId)
    const currentJob = currentHabit === null
      ? undefined
      : this.buildJobs([currentHabit]).find((candidate) => candidate.id === jobId)
    if (!currentJob) {
      return { ok: false, message: `unknown habit job: ${jobId}` }
    }

    this.onHabitFire(currentJob.taskId, trigger, {
      occurrenceId: this.jobOccurrenceId(currentJob, trigger),
    })
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_job_triggered",
      message: "habit scheduler job triggered",
      meta: { agent: currentJob.agent, habitName: currentJob.taskId, jobId, trigger },
    })
    return { ok: true, message: `triggered habit ${jobId}` }
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

  private verifyCronAndCreateFallbacks(state: SchedulerState): SchedulerState | null {
    if ((!this.execForVerify && !this.verifyJobs) || state.jobs.length === 0) return state

    let currentState = state
    for (let attempt = 1; attempt <= MAX_CRON_VERIFICATION_ATTEMPTS; attempt += 1) {
      const verifiedLabels = this.verifyJobs?.(currentState.jobs)
        ? new Set(currentState.jobs.map((job) => this.platform === "darwin" ? `bot.ouro.${job.agent}.${job.taskId}` : job.taskId))
        : this.execForVerify ? this.verifyCronEntries() : new Set<string>()
      const revalidatedState = this.revalidateAndCorrectJobs(currentState)
      if (revalidatedState === null) return null
      if (!this.jobsEqual(currentState.jobs, revalidatedState.jobs)) {
        currentState = revalidatedState
        if (currentState.jobs.length === 0) return currentState
        continue
      }
      currentState = revalidatedState

      for (const job of currentState.jobs) {
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

          const habitFile = currentState.habits.find((habit) => habit.name === job.taskId)!
          const cadence = habitFile.cadence!
          const ms = cadenceFallbackDelayMs(cadence, this.deps.now())
          if (ms !== null) {
            this.createTimerFallback(job.taskId, cadence, ms)
            this.degradedHabitNames.set(job.taskId, "cron registration failed — using timer fallback")
          } else {
            this.degradedHabitNames.set(job.taskId, "cron registration failed — no timer fallback available")
          }
        }
      }

      return currentState
    }

    this.clearAllTimerFallbacks()
    let cleanupError: string | null = null
    try {
      this.osCronManager.removeAll()
    } catch (error) {
      cleanupError = this.errorMessage(error)
    }
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.habit_cron_verification_unstable",
      message: "habit scheduler cron verification did not stabilize; fail-closed cleanup attempted",
      meta: {
        agent: this.agent,
        attempts: MAX_CRON_VERIFICATION_ATTEMPTS,
        jobCount: currentState.jobs.length,
        cleanupError,
      },
    })
    return null
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
          const match = line.match(/ouro poke \S+ --habit (\S+)(?:\s+--trigger\s+\S+)?/)
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

  private createTimerFallback(habitName: string, cadence: string, firstDelayMs: number): void {
    if (this.timerFallbacks.has(habitName)) this.clearTimerFallback(habitName)
    const generation = this.nextTimerFallbackGeneration(habitName)

    const schedule = (): void => {
      const delayMs = cadenceFallbackDelayMs(cadence, this.deps.now()) ?? firstDelayMs
      const timer = setTimeout(() => {
        const owner = this.timerFallbacks.get(habitName)
        if (!owner || owner.handle !== timer || owner.generation !== generation) return
        const currentHabit = this.revalidateHabit(habitName)
        const currentJob = currentHabit === null
          ? undefined
          : this.buildJobs([currentHabit]).find((job) => job.taskId === habitName)
        if (!currentJob || currentHabit?.cadence !== cadence) {
          this.clearTimerFallback(habitName)
          return
        }

        this.onHabitFire(habitName, "overdue", {
          occurrenceId: this.timerOccurrenceId(habitName, cadence),
        })
        const currentOwner = this.timerFallbacks.get(habitName)
        if (!currentOwner || currentOwner.handle !== timer || currentOwner.generation !== generation) return
        schedule()
      }, delayMs)
      this.timerFallbacks.set(habitName, { handle: timer, cadence, generation })
    }
    schedule()
  }

  private clearAllTimerFallbacks(): void {
    for (const name of [...this.timerFallbacks.keys()]) this.clearTimerFallback(name)
    this.degradedHabitNames.clear()
  }

  private clearTimerFallback(name: string): void {
    const owner = this.timerFallbacks.get(name)!
    clearTimeout(owner.handle)
    this.timerFallbacks.delete(name)
    this.degradedHabitNames.delete(name)
    this.nextTimerFallbackGeneration(name)
  }

  private nextTimerFallbackGeneration(name: string): number {
    const generation = (this.timerFallbackGenerations.get(name) ?? 0) + 1
    this.timerFallbackGenerations.set(name, generation)
    return generation
  }

  private revalidateState(state: SchedulerState): SchedulerState {
    const habits: HabitFile[] = []
    for (const habit of state.habits) {
      const currentHabit = this.revalidateHabit(habit.name)
      if (currentHabit !== null) habits.push(currentHabit)
    }
    return { habits, jobs: this.buildJobs(habits) }
  }

  private revalidateAndCorrectJobs(state: SchedulerState): SchedulerState | null {
    const currentState = this.revalidateState(state)
    this.pruneTimerFallbacks(state, currentState)
    if (this.jobsEqual(state.jobs, currentState.jobs)) return currentState
    return this.syncJobsFailClosed(currentState.jobs) ? currentState : null
  }

  private revalidateHabit(name: string): HabitFile | null {
    const file = `${name}.md`
    const filePath = path.join(this.habitsDir, file)
    let content: string

    try {
      content = this.deps.readFile(filePath, "utf-8")
    } catch (error) {
      this.habitSnapshots.delete(name)
      this.recordHabitParseError(
        file,
        `habit definition unreadable during scheduler revalidation: ${this.errorMessage(error)}`,
      )
      return null
    }

    try {
      const cached = this.habitSnapshots.get(name)
      const definition = cached?.content === content
        ? cached.definition
        : parseHabitFile(content, filePath)
      this.habitSnapshots.set(name, { content, definition })
      const habit = applyHabitRuntimeState(path.dirname(this.habitsDir), definition)
      this.recordDegradedHabitError(file, habit)
      return habit
    } catch (error) {
      this.habitSnapshots.delete(name)
      this.recordHabitParseError(file, this.errorMessage(error))
      return null
    }
  }

  private syncJobsFailClosed(jobs: ScheduledTaskJob[]): boolean {
    try {
      this.osCronManager.sync(jobs)
      return true
    } catch (error) {
      this.clearAllTimerFallbacks()
      let cleanupError: string | null = null
      try {
        this.osCronManager.removeAll()
      } catch (cleanupFailure) {
        cleanupError = this.errorMessage(cleanupFailure)
      }
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.habit_scheduler_sync_error",
        message: "habit scheduler cron synchronization failed; fail-closed cleanup attempted",
        meta: {
          agent: this.agent,
          error: this.errorMessage(error),
          cleanupError,
          jobCount: jobs.length,
        },
      })
      return false
    }
  }

  private pruneTimerFallbacks(previousState: SchedulerState, currentState: SchedulerState): void {
    for (const [name, owner] of this.timerFallbacks) {
      const previousJob = previousState.jobs.find((job) => job.taskId === name)
      const currentJob = currentState.jobs.find((job) => job.taskId === name)
      const currentHabit = currentState.habits.find((habit) => habit.name === name)
      if (
        previousJob
        && currentJob
        && currentHabit?.cadence === owner.cadence
        && this.jobEqual(previousJob, currentJob)
      ) continue
      this.clearTimerFallback(name)
    }
  }

  private jobsEqual(left: ScheduledTaskJob[], right: ScheduledTaskJob[]): boolean {
    if (left.length !== right.length) return false
    return left.every((job, index) => this.jobEqual(job, right[index]))
  }

  private jobEqual(left: ScheduledTaskJob, right: ScheduledTaskJob | undefined): boolean {
    return right !== undefined
      && left.id === right.id
      && left.agent === right.agent
      && left.taskId === right.taskId
      && left.schedule === right.schedule
      && left.lastRun === right.lastRun
      && left.command === right.command
      && left.taskPath === right.taskPath
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private scanHabits(): HabitFile[] {
    let files: string[]
    try {
      files = this.deps.readdir(this.habitsDir)
    } catch {
      this.parseErrors = []
      this.habitSnapshots.clear()
      return []
    }

    const habits: HabitFile[] = []
    const errors: HabitParseError[] = []
    const snapshots: Map<string, HabitSnapshot> = new Map()
    for (const file of files) {
      if (!file.endsWith(".md")) continue

      const filePath = path.join(this.habitsDir, file)
      try {
        const content = this.deps.readFile(filePath, "utf-8")
        const definition = parseHabitFile(content, filePath)
        const habit = applyHabitRuntimeState(path.dirname(this.habitsDir), definition)
        snapshots.set(habit.name, { content, definition })
        habits.push(habit)
        if (habit.status === "degraded") {
          const error = `habit definition degraded: ${habit.degradedReason}`
          errors.push({ file, error })
          emitNervesEvent({
            level: "error",
            component: "daemon",
            event: "daemon.habit_parse_error",
            message: "failed to parse habit file",
            meta: { file, error, agent: this.agent },
          })
        }
      } catch (error) {
        const errorMessage = this.errorMessage(error)
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
    this.habitSnapshots = snapshots

    return habits
  }

  private buildJobs(habits: HabitFile[]): ScheduledTaskJob[] {
    const jobs: ScheduledTaskJob[] = []

    for (const habit of habits) {
      if (habit.status !== "active") continue
      if (!habit.cadence) continue
      if (this.rejectInvalidRsvpHabit(habit)) continue
      if (this.rejectReservedCronNamespaceHabit(habit)) continue

      const cronSchedule = parseCadenceToCron(habit.cadence)
      if (cronSchedule === null) continue

      jobs.push({
        id: `${this.agent}:${habit.name}:cadence`,
        agent: this.agent,
        taskId: habit.name,
        schedule: cronSchedule,
        lastRun: habit.lastRun,
        command: `${this.deps.ouroPath} poke ${this.agent} --habit ${habit.name} --trigger ${this.platform === "darwin" ? "launchd" : "cron"}`,
        taskPath: path.join(this.habitsDir, `${habit.name}.md`),
      })
    }

    return jobs
  }

  private rejectInvalidRsvpHabit(habit: HabitFile): boolean {
    if (!isRsvpHabitName(habit.name) || habit.rsvp) return false

    this.recordHabitParseError(
      `${habit.name}.md`,
      "RSVP habit metadata is required before scheduling",
    )
    return true
  }

  private rejectReservedCronNamespaceHabit(habit: HabitFile): boolean {
    if (!habit.name.startsWith("await.")) return false

    this.recordHabitParseError(
      `${habit.name}.md`,
      "habit names cannot start with reserved cron namespace 'await.'",
    )
    return true
  }

  private recordDegradedHabitError(file: string, habit: HabitFile): void {
    const prefix = "habit definition degraded: "
    if (habit.status !== "degraded") {
      this.parseErrors = this.parseErrors.filter((entry) => entry.file !== file || !entry.error.startsWith(prefix))
      return
    }

    const error = `${prefix}${habit.degradedReason}`
    if (this.parseErrors.some((entry) => entry.file === file && entry.error === error)) return
    this.parseErrors = this.parseErrors.filter((entry) => entry.file !== file || !entry.error.startsWith(prefix))
    this.recordHabitParseError(file, error)
  }

  private recordHabitParseError(file: string, error: string): void {
    if (this.parseErrors.some((existing) => existing.file === file && existing.error === error)) return

    this.parseErrors.push({ file, error })
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.habit_parse_error",
      message: "failed to parse habit file",
      meta: { file, error, agent: this.agent },
    })
  }

  private overdueOccurrenceId(habit: HabitFile): string {
    if (habit.lastRun === null) return `overdue:first-run:${habit.cadence}`
    return `overdue:last-run:${habit.lastRun}:cadence:${habit.cadence}`
  }

  private jobOccurrenceId(job: ScheduledTaskJob, trigger: HabitRunTrigger): string {
    return `job:${job.id}:${trigger}:last-run:${job.lastRun ?? "never"}`
  }

  private timerOccurrenceId(habitName: string, cadence: string): string {
    const cadenceMs = parseCadenceToMs(cadence)
    if (cadenceMs !== null) {
      const slot = Math.floor(this.deps.now() / cadenceMs)
      return `timer:${habitName}:cadence-ms:${cadenceMs}:slot:${slot}`
    }
    const slot = nextCadenceRunAt(cadence, this.deps.now()) ?? "unknown"
    return `timer:${habitName}:cadence:${cadence}:slot:${slot}`
  }
}
