import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OsCronManager } from "../../../heart/daemon/os-cron"
import type { ScheduledTaskJob } from "../../../heart/daemon/task-scheduler"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

// We need to mock the parseHabitFile since it calls emitNervesEvent
const mockParseHabitFile = vi.fn()
vi.mock("../../../heart/habits/habit-parser", () => ({
  parseHabitFile: (...args: any[]) => mockParseHabitFile(...args),
}))

const mockApplyHabitRuntimeState = vi.fn((_: string, habit: unknown) => habit)
vi.mock("../../../heart/habits/habit-runtime-state", () => ({
  applyHabitRuntimeState: (...args: any[]) => mockApplyHabitRuntimeState(...args),
}))

const mockParseCadenceToCron = vi.fn()
const mockParseCadenceToMs = vi.fn()
const mockEvaluateCadenceDue = vi.fn()
const mockCadenceFallbackDelayMs = vi.fn()
const mockNextCadenceRunAt = vi.fn()
vi.mock("../../../heart/daemon/cadence", () => ({
  parseCadenceToCron: (...args: any[]) => mockParseCadenceToCron(...args),
  parseCadenceToMs: (...args: any[]) => mockParseCadenceToMs(...args),
  evaluateCadenceDue: (...args: any[]) => mockEvaluateCadenceDue(...args),
  cadenceFallbackDelayMs: (...args: any[]) => mockCadenceFallbackDelayMs(...args),
  nextCadenceRunAt: (...args: any[]) => mockNextCadenceRunAt(...args),
}))

import { HabitScheduler, type HabitSchedulerOptions, type HabitSchedulerDeps } from "../../../heart/habits/habit-scheduler"

function makeMockCronManager(overrides: Partial<OsCronManager> = {}): OsCronManager {
  return {
    sync: vi.fn(),
    removeAll: vi.fn(),
    list: vi.fn(() => []),
    ...overrides,
  }
}

function makeDeps(overrides: Partial<HabitSchedulerDeps> = {}): HabitSchedulerDeps {
  return {
    readdir: vi.fn(() => []),
    readFile: vi.fn(() => ""),
    writeFile: vi.fn(),
    existsSync: vi.fn(() => true),
    now: vi.fn(() => Date.now()),
    ouroPath: "/usr/local/bin/ouro",
    ...overrides,
  }
}

function makeHeartbeatHabit() {
  return {
    name: "heartbeat",
    title: "Heartbeat",
    cadence: "30m",
    status: "active" as const,
    lastRun: "2026-03-27T10:00:00.000Z",
    created: "2026-03-27",
    body: "Check in on responsibilities.",
  }
}

function makeDailyReflection() {
  return {
    name: "daily-reflection",
    title: "Daily Reflection",
    cadence: "1d",
    status: "active" as const,
    lastRun: "2026-03-26T22:00:00.000Z",
    created: "2026-03-25",
    body: "Reflect on the day.",
  }
}

function makePausedHabit() {
  return {
    name: "weekly-review",
    title: "Weekly Review",
    cadence: "7d",
    status: "paused" as const,
    lastRun: null,
    created: "2026-03-20",
    body: "Review the week.",
  }
}

function makeCancelledHabit(name = "ended-report") {
  return {
    ...makeHeartbeatHabit(),
    name,
    title: "Ended Report",
    status: "cancelled" as const,
  }
}

function makeDegradedHabit(name = "broken-report") {
  return {
    ...makeHeartbeatHabit(),
    name,
    title: "Broken Report",
    status: "degraded" as const,
    degradedReason: "malformed_frontmatter" as const,
    degradedDetail: null,
  }
}

const nonActiveTransitions = ["paused", "cancelled", "degraded", "missing", "read_error"] as const
type NonActiveTransition = typeof nonActiveTransitions[number]

function makeTransitionHabit(transition: NonActiveTransition) {
  if (transition === "paused") return { ...makeHeartbeatHabit(), status: "paused" as const }
  if (transition === "degraded") return makeDegradedHabit("heartbeat")
  return makeCancelledHabit("heartbeat")
}

function makeNoCadenceHabit() {
  return {
    name: "manual-check",
    title: "Manual Check",
    cadence: null,
    status: "active" as const,
    lastRun: null,
    created: "2026-03-20",
    body: "Only run when manually triggered.",
  }
}

function makeRsvpHabit() {
  return {
    name: "rsvp-wedding",
    title: "Wedding RSVPs",
    cadence: "0 10 * * *",
    status: "active" as const,
    lastRun: "2026-07-08T17:01:00.000Z",
    created: "2026-07-09",
    body: "Check AislePlanner and render an RSVP update.",
  }
}

function makeTypedRsvpHabit() {
  return {
    ...makeRsvpHabit(),
    rsvp: {
      policyVersion: "rsvp-habit/v1",
      mode: "shadow" as const,
      sense: "bluebubbles" as const,
      source: "aisleplanner" as const,
      routeRef: "rsvp/config.json#bluebubblesRoute",
      snapshotRef: "state/rsvp/snapshots/latest.json",
      outboundStateRef: "state/rsvp/outbound-state.json",
      budgetRef: "state/rsvp/spend-ledger.json",
      idempotencyRef: "state/rsvp/outbound-state.json",
      liveSendEligible: false,
    },
  }
}

describe("HabitScheduler", () => {
  let cronManager: OsCronManager
  let deps: HabitSchedulerDeps
  let onHabitFire: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    cronManager = makeMockCronManager()
    deps = makeDeps()
    onHabitFire = vi.fn()
    mockApplyHabitRuntimeState.mockImplementation((_: string, habit: unknown) => habit)

    mockParseCadenceToCron.mockImplementation((raw: string) => {
      if (raw === "30m") return "*/30 * * * *"
      if (raw === "1d") return "0 0 */1 * *"
      if (raw === "7d") return "0 0 */7 * *"
      if (raw === "2h") return "0 */2 * * *"
      if (raw === "0 10 * * *") return "0 10 * * *"
      return null
    })
    mockParseCadenceToMs.mockImplementation((raw: string) => {
      if (raw === "30m") return 30 * 60 * 1000
      if (raw === "1d") return 24 * 60 * 60 * 1000
      if (raw === "7d") return 7 * 24 * 60 * 60 * 1000
      if (raw === "2h") return 2 * 60 * 60 * 1000
      return null
    })
    mockEvaluateCadenceDue.mockImplementation((raw: string, lastRun: string | null, nowMs: number) => {
      const intervalMs = mockParseCadenceToMs(raw)
      if (intervalMs !== null) {
        if (lastRun === null) return { due: true, elapsedMs: Infinity, occurrenceId: `overdue:first-run:${raw}` }
        const elapsedMs = nowMs - new Date(lastRun).getTime()
        return {
          due: elapsedMs >= intervalMs,
          elapsedMs,
          occurrenceId: elapsedMs >= intervalMs ? `overdue:last-run:${lastRun}:cadence:${raw}` : null,
        }
      }
      if (raw === "0 10 * * *") {
        return {
          due: true,
          elapsedMs: 5 * 60 * 1000,
          occurrenceId: "fixed-daily:2026-07-09T17:00:00.000Z:cadence:0 10 * * *",
        }
      }
      return null
    })
    mockCadenceFallbackDelayMs.mockImplementation((raw: string) => {
      if (raw === "30m") return 30 * 60 * 1000
      if (raw === "1d") return 24 * 60 * 60 * 1000
      if (raw === "7d") return 7 * 24 * 60 * 60 * 1000
      if (raw === "2h") return 2 * 60 * 60 * 1000
      if (raw === "0 10 * * *") return 60 * 1000
      return null
    })
    mockNextCadenceRunAt.mockImplementation((raw: string) => {
      if (raw === "0 10 * * *") return "2026-07-09T17:00:00.000Z"
      return null
    })
  })

  describe("start()", () => {
    it("scans habitsDir and registers cron entries for active habits with cadences", () => {
      const readdir = vi.fn(() => ["heartbeat.md", "daily-reflection.md"])
      const readFile = vi.fn((filePath: string) => {
        if (filePath.includes("heartbeat")) return "heartbeat-content"
        return "reflection-content"
      })
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile
        .mockReturnValueOnce(makeHeartbeatHabit())
        .mockReturnValueOnce(makeDailyReflection())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(readdir).toHaveBeenCalledWith("/bundles/slugger.ouro/habits")
      expect(mockParseHabitFile).toHaveBeenCalledTimes(2)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs).toHaveLength(2)
      expect(syncedJobs[0].agent).toBe("slugger")
      expect(syncedJobs[0].taskId).toBe("heartbeat")
      expect(syncedJobs[0].schedule).toBe("*/30 * * * *")
      expect(syncedJobs[1].taskId).toBe("daily-reflection")
      expect(syncedJobs[1].schedule).toBe("0 0 */1 * *")
    })

    it("uses full path to ouro binary in cron commands", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile, ouroPath: "/opt/homebrew/bin/ouro" })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs[0].command).toContain("/opt/homebrew/bin/ouro")
    })

    it("skips paused habits (no cron entry)", () => {
      const readdir = vi.fn(() => ["heartbeat.md", "weekly-review.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile
        .mockReturnValueOnce(makeHeartbeatHabit())
        .mockReturnValueOnce(makePausedHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs).toHaveLength(1)
      expect(syncedJobs[0].taskId).toBe("heartbeat")
    })

    it("keeps cancelled and degraded definitions out of cron, overdue firing, and timer verification", () => {
      const readdir = vi.fn(() => ["ended-report.md", "broken-report.md"])
      const readFile = vi.fn(() => "content")
      const execForVerify = vi.fn(() => "")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile
        .mockReturnValueOnce(makeCancelledHabit())
        .mockReturnValueOnce(makeDegradedHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenCalledWith([])
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(scheduler.getDegradedHabits()).toEqual([])
      expect(scheduler.getParseErrors()).toEqual([{
        file: "broken-report.md",
        error: "habit definition degraded: malformed_frontmatter",
      }])
    })

    it("revalidates an active scan before sync and overdue dispatch when the file becomes unreadable", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn()
        .mockReturnValueOnce("active content")
        .mockImplementation(() => { throw new Error("ENOENT") })
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenCalledWith([])
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(scheduler.getParseErrors()).toContainEqual({
        file: "heartbeat.md",
        error: "habit definition unreadable during scheduler revalidation: ENOENT",
      })
    })

    it("revalidates changed lifecycle bytes before syncing an active scan", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn()
        .mockReturnValueOnce("active content")
        .mockReturnValue("cancelled content")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenCalledWith([])
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("fails closed when changed bytes cannot be parsed during revalidation", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn()
        .mockReturnValueOnce("active content")
        .mockReturnValue("malformed content")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockImplementation((content: string) => {
        if (content === "malformed content") throw new Error("invalid changed definition")
        return makeHeartbeatHabit()
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenCalledWith([])
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(scheduler.getParseErrors()).toContainEqual({
        file: "heartbeat.md",
        error: "invalid changed definition",
      })
    })

    it("clears a stale degraded diagnostic when revalidation recovers to active", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn()
        .mockReturnValueOnce("degraded content")
        .mockReturnValue("active content")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "degraded content" ? makeDegradedHabit("heartbeat") : makeHeartbeatHabit())
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenCalledWith([expect.objectContaining({ taskId: "heartbeat" })])
      expect(scheduler.getParseErrors()).toEqual([])
    })

    it("replaces a stale degraded reason with the current finite reason", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn()
        .mockReturnValueOnce("malformed content")
        .mockReturnValue("invalid-status content")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockImplementation((content: string) => content === "malformed content"
        ? makeDegradedHabit("heartbeat")
        : {
          ...makeDegradedHabit("heartbeat"),
          degradedReason: "invalid_status" as const,
        })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(scheduler.getParseErrors()).toEqual([{
        file: "heartbeat.md",
        error: "habit definition degraded: invalid_status",
      }])
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("revalidates each overdue candidate after an earlier habit fires", () => {
      let betaStatus: "active" | "cancelled" = "active"
      deps = makeDeps({
        readdir: vi.fn(() => ["alpha.md", "beta.md"]),
        readFile: vi.fn((filePath: string) => {
          if (filePath.endsWith("alpha.md")) return "alpha active content"
          return betaStatus === "active" ? "beta active content" : "beta cancelled content"
        }),
      })
      mockParseHabitFile.mockImplementation((content: string) => {
        if (content === "alpha active content") {
          return { ...makeHeartbeatHabit(), name: "alpha", title: "Alpha" }
        }
        if (content === "beta active content") {
          return { ...makeHeartbeatHabit(), name: "beta", title: "Beta" }
        }
        return makeCancelledHabit("beta")
      })
      onHabitFire.mockImplementation((habitName: string) => {
        if (habitName === "alpha") betaStatus = "cancelled"
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(onHabitFire).toHaveBeenCalledTimes(1)
      expect(onHabitFire).toHaveBeenCalledWith("alpha", "overdue", expect.any(Object))
    })

    it("skips a habit that becomes unreadable immediately before overdue dispatch", () => {
      let phase: "active" | "missing" = "active"
      let cadenceBuilds = 0
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => {
          if (phase === "missing") throw new Error("ENOENT")
          return "active content"
        }),
      })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())
      mockParseCadenceToCron.mockImplementation(() => {
        cadenceBuilds += 1
        if (cadenceBuilds === 4) phase = "missing"
        return "*/30 * * * *"
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(onHabitFire).not.toHaveBeenCalled()
      expect(scheduler.getParseErrors()).toContainEqual({
        file: "heartbeat.md",
        error: "habit definition unreadable during scheduler revalidation: ENOENT",
      })
    })

    it("removes an active job that becomes cancelled after sync but before cron verification", () => {
      let phase: "active" | "cancelled" = "active"
      const sync = vi.fn(() => { phase = "cancelled" })
      const execForVerify = vi.fn(() => "")
      cronManager = makeMockCronManager({ sync })
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => phase === "active" ? "active content" : "cancelled content"),
      })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(sync).toHaveBeenNthCalledWith(1, [expect.objectContaining({ taskId: "heartbeat" })])
      expect(sync).toHaveBeenLastCalledWith([])
      expect(execForVerify).not.toHaveBeenCalled()
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(scheduler.getDegradedHabits()).toEqual([])
      expect(mockEmitNervesEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.habit_cron_verification_failed",
      }))
    })

    it("stops the cycle when post-sync cancellation cannot be corrected", () => {
      let phase: "active" | "cancelled" = "active"
      const sync = vi.fn()
        .mockImplementationOnce(() => { phase = "cancelled" })
        .mockImplementationOnce(() => { throw new Error("post-sync correction failed") })
      const removeAll = vi.fn()
      const execForVerify = vi.fn(() => "")
      cronManager = makeMockCronManager({ sync, removeAll })
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => phase === "active" ? "active content" : "cancelled content"),
      })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(sync).toHaveBeenCalledTimes(2)
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(execForVerify).not.toHaveBeenCalled()
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("removes an active job that becomes cancelled after verification but before overdue dispatch", () => {
      let phase: "active" | "cancelled" = "active"
      const sync = vi.fn()
      cronManager = makeMockCronManager({ sync })
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => phase === "active" ? "active content" : "cancelled content"),
      })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      const execForVerify = vi.fn(() => {
        phase = "cancelled"
        return "bot.ouro.slugger.heartbeat\n"
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(sync).toHaveBeenNthCalledWith(1, [expect.objectContaining({ taskId: "heartbeat" })])
      expect(sync).toHaveBeenLastCalledWith([])
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("stops the cycle when cancellation during verification cannot be corrected", () => {
      let phase: "active" | "cancelled" = "active"
      const sync = vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw new Error("verification correction failed") })
      const removeAll = vi.fn()
      cronManager = makeMockCronManager({ sync, removeAll })
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => phase === "active" ? "active content" : "cancelled content"),
      })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      const execForVerify = vi.fn(() => {
        phase = "cancelled"
        return "bot.ouro.slugger.heartbeat\n"
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(sync).toHaveBeenCalledTimes(2)
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(execForVerify).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("stops the cycle when the final pre-dispatch correction cannot synchronize", () => {
      let phase: "active" | "cancelled" = "active"
      let cadenceBuilds = 0
      const sync = vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw new Error("pre-dispatch correction failed") })
      const removeAll = vi.fn()
      cronManager = makeMockCronManager({ sync, removeAll })
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => phase === "active" ? "active content" : "cancelled content"),
      })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      mockParseCadenceToCron.mockImplementation(() => {
        cadenceBuilds += 1
        if (cadenceBuilds === 4) phase = "cancelled"
        return "*/30 * * * *"
      })
      const execForVerify = vi.fn(() => "bot.ouro.slugger.heartbeat\n")
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(sync).toHaveBeenCalledTimes(2)
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(execForVerify).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("fails closed and emits diagnostics when cron synchronization throws", () => {
      const sync = vi.fn(() => { throw new Error("sync failed") })
      const removeAll = vi.fn()
      cronManager = makeMockCronManager({ sync, removeAll })
      deps = makeDeps({ readdir: vi.fn(() => ["heartbeat.md"]), readFile: vi.fn(() => "content") })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      expect(() => scheduler.start()).not.toThrow()

      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "daemon.habit_scheduler_sync_error",
        meta: expect.objectContaining({ agent: "slugger", error: "sync failed", cleanupError: null }),
      }))
    })

    it("preserves both sync and cleanup errors when fail-closed cron removal also throws", () => {
      cronManager = makeMockCronManager({
        sync: vi.fn(() => { throw "sync failed" }),
        removeAll: vi.fn(() => { throw "cleanup failed" }),
      })
      deps = makeDeps({ readdir: vi.fn(() => ["heartbeat.md"]), readFile: vi.fn(() => "content") })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      expect(() => scheduler.start()).not.toThrow()
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.habit_scheduler_sync_error",
        meta: expect.objectContaining({ error: "sync failed", cleanupError: "cleanup failed" }),
      }))
    })

    it("skips habits without cadence (no cron entry)", () => {
      const readdir = vi.fn(() => ["heartbeat.md", "manual-check.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile
        .mockReturnValueOnce(makeHeartbeatHabit())
        .mockReturnValueOnce(makeNoCadenceHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs).toHaveLength(1)
      expect(syncedJobs[0].taskId).toBe("heartbeat")
    })

    it("skips non-.md files in habitsDir", () => {
      const readdir = vi.fn(() => ["heartbeat.md", "README.txt", ".DS_Store"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(mockParseHabitFile).toHaveBeenCalledTimes(1)
    })

    it("handles empty habitsDir gracefully", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs).toHaveLength(0)
    })

    it("handles non-existent habitsDir gracefully", () => {
      const readdir = vi.fn(() => { throw new Error("ENOENT") })
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs).toHaveLength(0)
    })

    it("reports parse errors via onHabitFire callback with error info", () => {
      const readdir = vi.fn(() => ["broken.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      const parseError = new Error("invalid frontmatter")
      mockParseHabitFile.mockImplementationOnce(() => { throw parseError })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      // Parse errors emitted via nerves event
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.habit_parse_error",
          level: "error",
          meta: expect.objectContaining({ file: "broken.md" }),
        }),
      )
    })

    it("fires overdue habits immediately on startup", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      // lastRun was 2 hours ago, cadence is 30m => overdue
      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T10:00:00.000Z", // 2 hours ago
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "overdue", {
        occurrenceId: "overdue:last-run:2026-03-27T10:00:00.000Z:cadence:30m",
      })
    })

    it("does not fire habits that are not overdue", () => {
      const nowMs = new Date("2026-03-27T10:10:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      // lastRun was 10 mins ago, cadence is 30m => NOT overdue
      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T10:00:00.000Z",
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("fires habits with null lastRun (never run before) as overdue", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: null,
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "overdue", {
        occurrenceId: "overdue:first-run:30m",
      })
    })

    it("fires fixed daily cron habits after their civil occurrence with a civil-date occurrence id", () => {
      const nowMs = new Date(2026, 6, 9, 10, 5, 0, 0).getTime()
      const readdir = vi.fn(() => ["rsvp-wedding.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile, now: vi.fn(() => nowMs) })
      mockParseHabitFile.mockReturnValueOnce(makeTypedRsvpHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(onHabitFire).toHaveBeenCalledWith("rsvp-wedding", "overdue", {
        occurrenceId: "fixed-daily:2026-07-09T17:00:00.000Z:cadence:0 10 * * *",
      })
    })

    it("does not register active RSVP cron jobs unless typed RSVP metadata is present", () => {
      const nowMs = new Date(2026, 6, 9, 9, 55, 0, 0).getTime()
      const readdir = vi.fn(() => ["rsvp-wedding.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile, now: vi.fn(() => nowMs) })
      mockParseHabitFile.mockReturnValueOnce(makeRsvpHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenCalledWith([])
      expect(scheduler.getParseErrors()).toEqual([{
        file: "rsvp-wedding.md",
        error: expect.stringMatching(/RSVP habit metadata/i),
      }])
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("rejects habit names in the reserved await cron namespace", () => {
      const readdir = vi.fn(() => ["await.vendor-reply.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        name: "await.vendor-reply",
        title: "Await Vendor Reply",
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenCalledWith([])
      expect(scheduler.getParseErrors()).toContainEqual({
        file: "await.vendor-reply.md",
        error: "habit names cannot start with reserved cron namespace 'await.'",
      })
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("does not fire paused habits even if overdue", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["weekly-review.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce(makePausedHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(onHabitFire).not.toHaveBeenCalled()
    })
  })

  describe("reconcile()", () => {
    it("re-scans and updates cron entries", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.reconcile()

      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs).toHaveLength(1)
    })

    it("adds new habits on reconcile", () => {
      const readdir = vi.fn()
        .mockReturnValueOnce(["heartbeat.md"])
        .mockReturnValueOnce(["heartbeat.md", "daily-reflection.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile
        .mockReturnValueOnce(makeHeartbeatHabit())
        .mockReturnValueOnce(makeHeartbeatHabit())
        .mockReturnValueOnce(makeDailyReflection())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()
      scheduler.reconcile()

      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
      const secondSyncJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[1][0] as ScheduledTaskJob[]
      expect(secondSyncJobs).toHaveLength(2)
    })

    it("removes cron entries for deleted habits on reconcile", () => {
      const readdir = vi.fn()
        .mockReturnValueOnce(["heartbeat.md", "daily-reflection.md"])
        .mockReturnValueOnce(["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile
        .mockReturnValueOnce(makeHeartbeatHabit())
        .mockReturnValueOnce(makeDailyReflection())
        .mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()
      scheduler.reconcile()

      const secondSyncJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[1][0] as ScheduledTaskJob[]
      expect(secondSyncJobs).toHaveLength(1)
      expect(secondSyncJobs[0].taskId).toBe("heartbeat")
    })

    it.each(nonActiveTransitions)("removes a previously active cron entry and trigger when its definition becomes %s", async (transition) => {
      let phase: "active" | "transitioned" = "active"
      const readdir = vi.fn(() => transition === "missing" && phase === "transitioned" ? [] : ["heartbeat.md"])
      const readFile = vi.fn(() => {
        if (transition === "read_error" && phase === "transitioned") throw new Error("EACCES")
        return "content"
      })
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockImplementation(() =>
        phase === "active" ? makeHeartbeatHabit() : makeTransitionHabit(transition))

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()
      phase = "transitioned"
      onHabitFire.mockClear()
      mockEvaluateCadenceDue.mockClear()
      scheduler.reconcile()

      expect(cronManager.sync).toHaveBeenNthCalledWith(1, [expect.objectContaining({ taskId: "heartbeat" })])
      expect(cronManager.sync).toHaveBeenNthCalledWith(2, [])
      await expect(scheduler.triggerJob("slugger:heartbeat:cadence")).resolves.toEqual({
        ok: false,
        message: "unknown habit job: slugger:heartbeat:cadence",
      })
      expect(mockEvaluateCadenceDue).not.toHaveBeenCalled()
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("fails closed when removing a cancelled cron entry cannot synchronize", () => {
      let phase: "active" | "cancelled" = "active"
      const sync = vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw new Error("sync cancelled failed") })
      const removeAll = vi.fn()
      cronManager = makeMockCronManager({ sync, removeAll })
      deps = makeDeps({ readdir: vi.fn(() => ["heartbeat.md"]), readFile: vi.fn(() => "content") })
      mockParseHabitFile.mockImplementation(() =>
        phase === "active" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()
      phase = "cancelled"
      onHabitFire.mockClear()

      expect(() => scheduler.reconcile()).not.toThrow()
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.habit_scheduler_sync_error",
        meta: expect.objectContaining({ error: "sync cancelled failed" }),
      }))
    })

    it("fires habits with lastRun: null (new habits) on reconcile", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValue({
        ...makeHeartbeatHabit(),
        lastRun: null,
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.reconcile()

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "overdue", {
        occurrenceId: "overdue:first-run:30m",
      })
    })

    it("fires overdue habits on reconcile (elapsed > cadence)", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValue({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T10:00:00.000Z", // 2 hours ago, cadence 30m
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.reconcile()

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "overdue", {
        occurrenceId: "overdue:last-run:2026-03-27T10:00:00.000Z:cadence:30m",
      })
    })

    it("does not re-fire recently-fired habits on reconcile", () => {
      const nowMs = new Date("2026-03-27T10:10:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValue({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T10:00:00.000Z", // 10 min ago, cadence 30m => NOT overdue
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.reconcile()

      expect(onHabitFire).not.toHaveBeenCalled()
    })
  })

  describe("timer fallback", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("creates timer fallbacks for fixed daily cron habits when launchd verification fails", () => {
      vi.useFakeTimers()
      const nowMs = new Date(2026, 6, 9, 9, 59, 0, 0).getTime()
      deps = makeDeps({
        readdir: vi.fn(() => ["rsvp-wedding.md"]),
        readFile: vi.fn(() => "content"),
        now: vi.fn(() => nowMs),
      })
      mockParseHabitFile.mockReturnValue(makeTypedRsvpHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify: vi.fn(() => ""),
        platform: "darwin",
      })

      scheduler.start()
      vi.advanceTimersByTime(60 * 1000)

      expect(onHabitFire).toHaveBeenCalledWith("rsvp-wedding", "overdue", {
        occurrenceId: "timer:rsvp-wedding:cadence:0 10 * * *:slot:2026-07-09T17:00:00.000Z",
      })
      expect(scheduler.getDegradedHabits()).toEqual([
        { name: "rsvp-wedding", reason: "cron registration failed — using timer fallback" },
      ])
      scheduler.stop()
    })

    it("falls back to initial timer delay and legacy occurrence ids when cadence timing is degraded", () => {
      vi.useFakeTimers()
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => "content"),
        now: vi.fn(() => nowMs),
      })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())
      mockCadenceFallbackDelayMs
        .mockReturnValueOnce(30 * 60 * 1000)
        .mockReturnValueOnce(null)
      mockEvaluateCadenceDue.mockReturnValue({
        due: true,
        elapsedMs: Infinity,
        occurrenceId: null,
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify: vi.fn(() => ""),
        platform: "darwin",
      })

      scheduler.start()
      vi.advanceTimersByTime(30 * 60 * 1000)

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "overdue", {
        occurrenceId: expect.stringMatching(/^timer:heartbeat:cadence-ms:1800000:slot:/),
      })
      scheduler.stop()
    })

    it("falls back to first-run overdue occurrence ids when due state has no occurrence id", () => {
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => "content"),
      })
      mockParseHabitFile.mockReturnValue({
        ...makeHeartbeatHabit(),
        lastRun: null,
      })
      mockEvaluateCadenceDue.mockReturnValue({
        due: true,
        elapsedMs: Infinity,
        occurrenceId: null,
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "overdue", {
        occurrenceId: "overdue:first-run:30m",
      })
    })

    it("records unknown timer slots when fixed cadence next-run computation is unavailable", () => {
      vi.useFakeTimers()
      deps = makeDeps({
        readdir: vi.fn(() => ["rsvp-wedding.md"]),
        readFile: vi.fn(() => "content"),
      })
      mockParseHabitFile.mockReturnValue(makeTypedRsvpHabit())
      mockNextCadenceRunAt.mockReturnValueOnce(null)

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify: vi.fn(() => ""),
        platform: "darwin",
      })

      scheduler.start()
      vi.advanceTimersByTime(60 * 1000)

      expect(onHabitFire).toHaveBeenCalledWith("rsvp-wedding", "overdue", {
        occurrenceId: "timer:rsvp-wedding:cadence:0 10 * * *:slot:unknown",
      })
      scheduler.stop()
    })
  })

  describe("stop()", () => {
    it("calls osCronManager.removeAll()", () => {
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.stop()

      expect((cronManager.removeAll as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })
  })

  describe("listOverdueHabits()", () => {
    it("returns overdue habits with elapsed time", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md", "daily-reflection.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile
        .mockReturnValueOnce({
          ...makeHeartbeatHabit(),
          lastRun: "2026-03-27T10:00:00.000Z", // 2 hours ago, cadence 30m => overdue
        })
        .mockReturnValueOnce({
          ...makeDailyReflection(),
          lastRun: "2026-03-26T12:00:00.000Z", // 24 hours ago, cadence 1d => overdue
        })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const overdue = scheduler.listOverdueHabits()

      expect(overdue).toHaveLength(2)
      expect(overdue[0].name).toBe("heartbeat")
      expect(overdue[0].elapsedMs).toBe(2 * 60 * 60 * 1000)
      expect(overdue[1].name).toBe("daily-reflection")
      expect(overdue[1].elapsedMs).toBe(24 * 60 * 60 * 1000)
    })

    it("does not list untyped RSVP habits as overdue", () => {
      const readdir = vi.fn(() => ["rsvp-wedding.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockReturnValueOnce(makeRsvpHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      expect(scheduler.listOverdueHabits()).toEqual([])
      expect(scheduler.getParseErrors()).toEqual([{
        file: "rsvp-wedding.md",
        error: "RSVP habit metadata is required before scheduling",
      }])
      expect(mockEvaluateCadenceDue).not.toHaveBeenCalled()
    })

    it("excludes non-overdue habits", () => {
      const nowMs = new Date("2026-03-27T10:10:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T10:00:00.000Z", // 10 mins ago, cadence 30m => not overdue
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const overdue = scheduler.listOverdueHabits()
      expect(overdue).toHaveLength(0)
    })

    it("prefers resolved runtime lastRun when calculating overdue habits", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T10:00:00.000Z",
      })
      mockApplyHabitRuntimeState.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T11:50:00.000Z",
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const overdue = scheduler.listOverdueHabits()
      expect(overdue).toHaveLength(0)
    })

    it("includes habits with null lastRun as overdue", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: null,
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const overdue = scheduler.listOverdueHabits()
      expect(overdue).toHaveLength(1)
      expect(overdue[0].name).toBe("heartbeat")
      // elapsedMs should be Infinity for null lastRun
      expect(overdue[0].elapsedMs).toBe(Infinity)
    })

    it("excludes habit names in the reserved await cron namespace from overdue checks", () => {
      const readdir = vi.fn(() => ["await.vendor-reply.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        name: "await.vendor-reply",
        title: "Await Vendor Reply",
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      expect(scheduler.listOverdueHabits()).toEqual([])
      expect(mockEvaluateCadenceDue).not.toHaveBeenCalled()
      expect(scheduler.getParseErrors()).toContainEqual({
        file: "await.vendor-reply.md",
        error: "habit names cannot start with reserved cron namespace 'await.'",
      })
    })

    it("excludes paused habits from overdue list", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["weekly-review.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce(makePausedHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const overdue = scheduler.listOverdueHabits()
      expect(overdue).toHaveLength(0)
    })

    it("excludes cancelled and degraded habits from overdue and trigger lookup", async () => {
      const readdir = vi.fn(() => ["ended-report.md", "broken-report.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockImplementation((_content: string, filePath: string) =>
        filePath.includes("ended-report") ? makeCancelledHabit() : makeDegradedHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      expect(scheduler.listOverdueHabits()).toEqual([])
      await expect(scheduler.triggerJob("slugger:ended-report:cadence")).resolves.toEqual({
        ok: false,
        message: "unknown habit job: slugger:ended-report:cadence",
      })
      await expect(scheduler.triggerJob("slugger:broken-report:cadence")).resolves.toEqual({
        ok: false,
        message: "unknown habit job: slugger:broken-report:cadence",
      })
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(mockEvaluateCadenceDue).not.toHaveBeenCalled()
    })

    it("excludes habits without cadence from overdue list", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["manual-check.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce(makeNoCadenceHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const overdue = scheduler.listOverdueHabits()
      expect(overdue).toHaveLength(0)
    })
  })

  describe("getHabitFile()", () => {
    it("reads and returns parsed habit for a given name", () => {
      const readFile = vi.fn(() => "habit-content")
      deps = makeDeps({ readFile })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())
      mockApplyHabitRuntimeState.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T12:00:00.000Z",
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const habit = scheduler.getHabitFile("heartbeat")

      expect(readFile).toHaveBeenCalledWith("/bundles/slugger.ouro/habits/heartbeat.md", "utf-8")
      expect(mockApplyHabitRuntimeState).toHaveBeenCalledWith(
        "/bundles/slugger.ouro",
        makeHeartbeatHabit(),
      )
      expect(habit).toEqual({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T12:00:00.000Z",
      })
    })

    it("returns null when habit file does not exist", () => {
      const readFile = vi.fn(() => { throw new Error("ENOENT") })
      deps = makeDeps({ readFile })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const habit = scheduler.getHabitFile("nonexistent")
      expect(habit).toBeNull()
    })
  })

  describe("cron job properties", () => {
    it("builds correct job id format: agent:habitName:cadence", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs[0].id).toBe("slugger:heartbeat:cadence")
    })

    it("includes taskPath pointing to habit file", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs[0].taskPath).toBe("/bundles/slugger.ouro/habits/heartbeat.md")
    })

    it("command includes poke --habit flag", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs[0].command).toContain("poke")
      expect(syncedJobs[0].command).toContain("--habit heartbeat")
    })

    it("generated OS habit jobs carry launchd trigger provenance", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs[0].command).toBe("/usr/local/bin/ouro poke slugger --habit heartbeat --trigger launchd")
    })

    it("lists and triggers habit jobs with canonical cron provenance", async () => {
      const readdir = vi.fn(() => ["zeta.md", "heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockImplementation((_content: string, filePath: string) =>
        filePath.includes("zeta")
          ? { ...makeHeartbeatHabit(), name: "zeta", title: "Zeta" }
          : makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      expect(scheduler.listJobs()).toEqual([
        {
          id: "slugger:heartbeat:cadence",
          schedule: "*/30 * * * *",
          lastRun: "2026-03-27T10:00:00.000Z",
        },
        {
          id: "slugger:zeta:cadence",
          schedule: "*/30 * * * *",
          lastRun: "2026-03-27T10:00:00.000Z",
        },
      ])

      await expect(scheduler.triggerJob("slugger:heartbeat:cadence")).resolves.toEqual({
        ok: true,
        message: "triggered habit slugger:heartbeat:cadence",
      })
      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "cron", {
        occurrenceId: "job:slugger:heartbeat:cadence:cron:last-run:2026-03-27T10:00:00.000Z",
      })
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.habit_job_triggered",
      }))

      await expect(scheduler.triggerJob("slugger:missing:cadence")).resolves.toEqual({
        ok: false,
        message: "unknown habit job: slugger:missing:cadence",
      })
      expect(onHabitFire).toHaveBeenCalledTimes(1)
    })

    it("revalidates lifecycle immediately before dispatching a trigger", async () => {
      let phase: "active" | "cancelled" = "active"
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => phase === "active" ? "active content" : "cancelled content"),
      })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      mockParseCadenceToCron.mockImplementationOnce(() => {
        phase = "cancelled"
        return "*/30 * * * *"
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      await expect(scheduler.triggerJob("slugger:heartbeat:cadence")).resolves.toEqual({
        ok: false,
        message: "unknown habit job: slugger:heartbeat:cadence",
      })
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(mockEmitNervesEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.habit_job_triggered",
      }))
    })

    it("rejects a trigger when its definition disappears immediately before dispatch", async () => {
      let phase: "active" | "missing" = "active"
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => {
          if (phase === "missing") throw new Error("ENOENT")
          return "active content"
        }),
      })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())
      mockParseCadenceToCron.mockImplementationOnce(() => {
        phase = "missing"
        return "*/30 * * * *"
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      await expect(scheduler.triggerJob("slugger:heartbeat:cadence")).resolves.toEqual({
        ok: false,
        message: "unknown habit job: slugger:heartbeat:cadence",
      })
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(scheduler.getParseErrors()).toContainEqual({
        file: "heartbeat.md",
        error: "habit definition unreadable during scheduler revalidation: ENOENT",
      })
    })

    it("uses a never occurrence label for cron jobs without lastRun", async () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: null,
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      await expect(scheduler.triggerJob("slugger:heartbeat:cadence")).resolves.toEqual({
        ok: true,
        message: "triggered habit slugger:heartbeat:cadence",
      })
      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "cron", {
        occurrenceId: "job:slugger:heartbeat:cadence:cron:last-run:never",
      })
    })

    it("uses cadence with unparseable cron: skips habit", () => {
      const readdir = vi.fn(() => ["broken-cadence.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        name: "broken-cadence",
        cadence: "invalid",
      })
      mockParseCadenceToCron.mockReturnValueOnce(null)

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const syncedJobs = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(syncedJobs).toHaveLength(0)
    })
  })

  describe("nerves events", () => {
    it("emits lifecycle events on start", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.habit_scheduler_start",
          component: "daemon",
        }),
      )
    })

    it("emits lifecycle events on reconcile", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.reconcile()

      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.habit_scheduler_reconcile",
          component: "daemon",
        }),
      )
    })

    it("emits lifecycle events on stop", () => {
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.stop()

      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.habit_scheduler_end",
          component: "daemon",
        }),
      )
    })

    it("emits event when overdue habit fires", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: "2026-03-27T10:00:00.000Z",
      })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.habit_fire",
          component: "daemon",
          meta: expect.objectContaining({ habitName: "heartbeat" }),
        }),
      )
    })

    it("emits parse error event on broken habit file", () => {
      const readdir = vi.fn(() => ["broken.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockImplementationOnce(() => { throw new Error("bad frontmatter") })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.habit_parse_error",
          level: "error",
          component: "daemon",
          meta: expect.objectContaining({
            file: "broken.md",
            error: "bad frontmatter",
          }),
        }),
      )
    })
  })

  describe("watchForChanges()", () => {
    let mockWatcher: { callback: ((event: string, filename: string | null) => void) | null; close: ReturnType<typeof vi.fn> }

    beforeEach(() => {
      vi.useFakeTimers()
      mockWatcher = { callback: null, close: vi.fn() }
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function makeWatchableDeps(overrides: Partial<HabitSchedulerDeps> = {}): HabitSchedulerDeps & { watch: ReturnType<typeof vi.fn> } {
      const watch = vi.fn((_dir: string, cb: (event: string, filename: string | null) => void) => {
        mockWatcher.callback = cb
        return { close: mockWatcher.close }
      })
      return {
        ...makeDeps(overrides),
        watch,
      }
    }

    it("reconcile called when file is created (debounced ~200ms)", () => {
      const readdir = vi.fn(() => [])
      const watchDeps = makeWatchableDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
      })

      scheduler.watchForChanges()

      expect(watchDeps.watch).toHaveBeenCalledWith("/bundles/slugger.ouro/habits", expect.any(Function))

      // Trigger file creation event
      mockWatcher.callback!("rename", "new-habit.md")

      // Before debounce: no reconcile
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()

      // After debounce
      vi.advanceTimersByTime(250)

      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })

    it("reconcile called when file is modified", () => {
      const readdir = vi.fn(() => [])
      const watchDeps = makeWatchableDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
      })

      scheduler.watchForChanges()
      mockWatcher.callback!("change", "heartbeat.md")

      vi.advanceTimersByTime(250)

      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })

    it.each(nonActiveTransitions)("watch reconciliation syncs an empty job set after an active definition becomes %s", (transition) => {
      let phase: "active" | "transitioned" = "active"
      const readdir = vi.fn(() => transition === "missing" && phase === "transitioned" ? [] : ["heartbeat.md"])
      const readFile = vi.fn(() => {
        if (transition === "read_error" && phase === "transitioned") throw new Error("EACCES")
        return "content"
      })
      const watchDeps = makeWatchableDeps({ readdir, readFile })
      mockParseHabitFile.mockImplementation(() =>
        phase === "active" ? makeHeartbeatHabit() : makeTransitionHabit(transition))
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
      })

      scheduler.start()
      scheduler.watchForChanges()
      phase = "transitioned"
      onHabitFire.mockClear()
      mockEvaluateCadenceDue.mockClear()
      mockWatcher.callback!("change", "heartbeat.md")
      vi.advanceTimersByTime(250)

      expect(cronManager.sync).toHaveBeenLastCalledWith([])
      expect(mockEvaluateCadenceDue).not.toHaveBeenCalled()
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("contains watcher reconciliation sync failures, cleans up, and processes the next event", () => {
      const watchDeps = makeWatchableDeps({ readdir: vi.fn(() => []), readFile: vi.fn(() => "content") })
      let failSync = true
      const sync = vi.fn(() => {
        if (failSync) throw new Error("watch sync failed")
      })
      const removeAll = vi.fn()
      cronManager = makeMockCronManager({ sync, removeAll })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
      })

      scheduler.watchForChanges()
      mockWatcher.callback!("change", "heartbeat.md")

      expect(() => vi.advanceTimersByTime(250)).not.toThrow()
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(mockEmitNervesEvent).toHaveBeenCalledTimes(2)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith({
        level: "error",
        component: "daemon",
        event: "daemon.habit_scheduler_sync_error",
        message: "habit scheduler cron synchronization failed; fail-closed cleanup attempted",
        meta: { agent: "slugger", error: "watch sync failed", cleanupError: null, jobCount: 0 },
      })

      failSync = false
      mockWatcher.callback!("change", "heartbeat.md")
      expect(() => vi.advanceTimersByTime(250)).not.toThrow()
      expect(sync).toHaveBeenCalledTimes(2)
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("bounds unstable cron verification, removes jobs fail-closed, and recovers on the next watcher event", () => {
      let cadence: "30m" | "2h" = "30m"
      let remainingOscillations = 5
      const execForVerify = vi.fn(() => {
        if (remainingOscillations > 0) {
          remainingOscillations -= 1
          cadence = cadence === "30m" ? "2h" : "30m"
        }
        return "bot.ouro.slugger.heartbeat\n"
      })
      const sync = vi.fn()
      const removeAll = vi.fn()
      cronManager = makeMockCronManager({ sync, removeAll })
      const watchDeps = makeWatchableDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => `${cadence} content`),
      })
      mockParseHabitFile.mockImplementation((content: string) => ({
        ...makeHeartbeatHabit(),
        cadence: content === "30m content" ? "30m" : "2h",
      }))
      mockEvaluateCadenceDue.mockReturnValue({ due: false, elapsedMs: 0, occurrenceId: null })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(execForVerify).toHaveBeenCalledTimes(3)
      expect(sync).toHaveBeenCalledTimes(4)
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith({
        level: "error",
        component: "daemon",
        event: "daemon.habit_cron_verification_unstable",
        message: "habit scheduler cron verification did not stabilize; fail-closed cleanup attempted",
        meta: { agent: "slugger", attempts: 3, jobCount: 1, cleanupError: null },
      })

      remainingOscillations = 0
      scheduler.watchForChanges()
      mockWatcher.callback!("change", "heartbeat.md")
      vi.advanceTimersByTime(250)

      expect(execForVerify).toHaveBeenCalledTimes(4)
      expect(sync).toHaveBeenCalledTimes(5)
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("contains fail-closed cleanup errors after unstable cron verification", () => {
      let cadence: "30m" | "2h" = "30m"
      let remainingOscillations = 5
      const execForVerify = vi.fn(() => {
        if (remainingOscillations > 0) {
          remainingOscillations -= 1
          cadence = cadence === "30m" ? "2h" : "30m"
        }
        return "bot.ouro.slugger.heartbeat\n"
      })
      const removeAll = vi.fn(() => { throw "unstable cleanup failed" })
      cronManager = makeMockCronManager({ removeAll })
      const watchDeps = makeWatchableDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => `${cadence} content`),
      })
      mockParseHabitFile.mockImplementation((content: string) => ({
        ...makeHeartbeatHabit(),
        cadence: content === "30m content" ? "30m" : "2h",
      }))
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
        execForVerify,
        platform: "darwin",
      })

      expect(() => scheduler.start()).not.toThrow()

      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(onHabitFire).not.toHaveBeenCalled()
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.habit_cron_verification_unstable",
        meta: expect.objectContaining({ cleanupError: "unstable cleanup failed" }),
      }))
    })

    it("multiple rapid events result in only one reconcile (debounce)", () => {
      const readdir = vi.fn(() => [])
      const watchDeps = makeWatchableDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
      })

      scheduler.watchForChanges()

      // Rapid events within debounce window
      mockWatcher.callback!("change", "heartbeat.md")
      vi.advanceTimersByTime(50)
      mockWatcher.callback!("rename", "new-habit.md")
      vi.advanceTimersByTime(50)
      mockWatcher.callback!("change", "daily-reflection.md")

      // Debounce not yet elapsed from last event
      vi.advanceTimersByTime(100)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()

      // Now debounce elapses
      vi.advanceTimersByTime(150)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })

    it("handles null filename via full rescan (no crash)", () => {
      const readdir = vi.fn(() => [])
      const watchDeps = makeWatchableDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
      })

      scheduler.watchForChanges()
      mockWatcher.callback!("rename", null)

      vi.advanceTimersByTime(250)

      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })

    it("stopWatching closes the watcher", () => {
      const readdir = vi.fn(() => [])
      const watchDeps = makeWatchableDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
      })

      scheduler.watchForChanges()
      scheduler.stopWatching()

      expect(mockWatcher.close).toHaveBeenCalledTimes(1)
    })

    it("stopWatching cancels pending debounce timer", () => {
      const readdir = vi.fn(() => [])
      const watchDeps = makeWatchableDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: watchDeps,
      })

      scheduler.watchForChanges()

      // Trigger an event but DON'T advance timers (debounce is pending)
      mockWatcher.callback!("change", "heartbeat.md")

      // Stop watching while debounce is pending
      scheduler.stopWatching()

      // Advance timers — reconcile should NOT fire (timer was cancelled)
      vi.advanceTimersByTime(500)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    })

    it("watchForChanges is no-op when watch dep is not provided", () => {
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps: makeDeps(), // no watch function
      })

      // Should not throw
      scheduler.watchForChanges()

      // stopWatching should also be safe
      scheduler.stopWatching()
    })
  })

  describe("edge cases", () => {
    it("listOverdueHabits skips habits with unparseable cadence", () => {
      const nowMs = new Date("2026-03-27T12:00:00.000Z").getTime()
      const readdir = vi.fn(() => ["weird.md"])
      const readFile = vi.fn(() => "content")
      const nowFn = vi.fn(() => nowMs)
      deps = makeDeps({ readdir, readFile, now: nowFn })

      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        name: "weird",
        cadence: "invalid",
      })
      mockParseCadenceToMs.mockReturnValueOnce(null)

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const overdue = scheduler.listOverdueHabits()
      expect(overdue).toHaveLength(0)
    })

    it("tracks parse errors for non-Error thrown values", () => {
      const readdir = vi.fn(() => ["broken.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockImplementationOnce(() => { throw "string error" })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const errors = scheduler.getParseErrors()
      expect(errors).toHaveLength(1)
      expect(errors[0].error).toBe("string error")
    })
  })

  describe("getParseErrors()", () => {
    it("returns parse errors from latest reconcile", () => {
      const readdir = vi.fn(() => ["good.md", "broken.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile
        .mockReturnValueOnce(makeHeartbeatHabit())
        .mockImplementationOnce(() => { throw new Error("invalid frontmatter in broken.md") })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const errors = scheduler.getParseErrors()
      expect(errors).toHaveLength(1)
      expect(errors[0].file).toBe("broken.md")
      expect(errors[0].error).toContain("invalid frontmatter")
    })

    it("returns empty array when no parse errors", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      const errors = scheduler.getParseErrors()
      expect(errors).toHaveLength(0)
    })

    it("clears previous parse errors on reconcile", () => {
      const readdir = vi.fn()
        .mockReturnValueOnce(["broken.md"])
        .mockReturnValueOnce(["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile
        .mockImplementationOnce(() => { throw new Error("bad") })
        .mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()
      expect(scheduler.getParseErrors()).toHaveLength(1)

      scheduler.reconcile()
      expect(scheduler.getParseErrors()).toHaveLength(0)
    })

    it("returns empty array before start() is called", () => {
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      expect(scheduler.getParseErrors()).toHaveLength(0)
    })
  })

  describe("cron verification and timer fallback", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function makeSchedulerWithVerify(options: {
      habits?: ReturnType<typeof makeHeartbeatHabit>[]
      execForVerify?: ReturnType<typeof vi.fn>
      platform?: string
    } = {}) {
      const habits = options.habits ?? [makeHeartbeatHabit()]
      const readdir = vi.fn(() => habits.map((h) => `${h.name}.md`))
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      for (const h of habits) {
        mockParseHabitFile.mockReturnValueOnce(h)
      }

      const execForVerify = options.execForVerify ?? vi.fn(() => "")
      const platform = options.platform ?? "darwin"

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform,
      })

      return { scheduler, execForVerify, readdir }
    }

    it("calls execForVerify after osCronManager.sync() to verify cron entries", () => {
      const execForVerify = vi.fn(() => "bot.ouro.slugger.heartbeat\n")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()

      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
      expect(execForVerify).toHaveBeenCalled()
    })

    it("on macOS, checks launchctl list output for specific habit labels", () => {
      const execForVerify = vi.fn(() => "78\t0\tbot.ouro.slugger.heartbeat\n")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify, platform: "darwin" })

      scheduler.start()

      expect(execForVerify).toHaveBeenCalledWith(expect.stringContaining("launchctl"))
    })

    it("on Linux, checks crontab -l output for specific habit command lines", () => {
      const execForVerify = vi.fn(() => "*/30 * * * * /usr/local/bin/ouro poke slugger --habit heartbeat --trigger launchd\n")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify, platform: "linux" })

      scheduler.start()

      expect(execForVerify).toHaveBeenCalledWith(expect.stringContaining("crontab"))
    })

    it("creates timer fallback when cron verification fails for a habit", () => {
      // execForVerify returns empty — no matching labels found
      const execForVerify = vi.fn(() => "")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()

      const degraded = scheduler.getDegradedHabits()
      expect(degraded).toHaveLength(1)
      expect(degraded[0].name).toBe("heartbeat")
      expect(degraded[0].reason).toContain("cron")
    })

    it("does not create timer fallback when cron verification succeeds", () => {
      const execForVerify = vi.fn(() => "bot.ouro.slugger.heartbeat\n")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()

      const degraded = scheduler.getDegradedHabits()
      expect(degraded).toHaveLength(0)
    })

    it("re-verifies a corrected job generation before creating fallbacks", () => {
      let betaStatus: "paused" | "active" = "paused"
      const execForVerify = vi.fn()
        .mockImplementationOnce(() => {
          betaStatus = "active"
          return "bot.ouro.slugger.alpha\n"
        })
        .mockReturnValue("bot.ouro.slugger.alpha\nbot.ouro.slugger.beta\n")
      deps = makeDeps({
        readdir: vi.fn(() => ["alpha.md", "beta.md"]),
        readFile: vi.fn((filePath: string) => {
          if (filePath.endsWith("alpha.md")) return "alpha active content"
          return betaStatus === "active" ? "beta active content" : "beta paused content"
        }),
      })
      mockParseHabitFile.mockImplementation((content: string) => {
        if (content === "alpha active content") {
          return { ...makeHeartbeatHabit(), name: "alpha", title: "Alpha" }
        }
        if (content === "beta active content") {
          return { ...makeHeartbeatHabit(), name: "beta", title: "Beta" }
        }
        return { ...makePausedHabit(), name: "beta", title: "Beta" }
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(execForVerify).toHaveBeenCalledTimes(2)
      expect(cronManager.sync).toHaveBeenNthCalledWith(1, [expect.objectContaining({ taskId: "alpha" })])
      expect(cronManager.sync).toHaveBeenLastCalledWith([
        expect.objectContaining({ taskId: "alpha" }),
        expect.objectContaining({ taskId: "beta" }),
      ])
      expect(scheduler.getDegradedHabits()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })

    it("timer fallback fires onHabitFire at cadence interval", () => {
      const execForVerify = vi.fn(() => "")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()
      // Clear the initial overdue fire calls
      onHabitFire.mockClear()

      // Advance by cadence (30m = 1800000ms)
      vi.advanceTimersByTime(30 * 60 * 1000)

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "overdue", expect.objectContaining({
        occurrenceId: expect.stringMatching(/^timer:heartbeat:cadence-ms:1800000:slot:/),
      }))
    })

    it("timer fires repeatedly at cadence interval", () => {
      const execForVerify = vi.fn(() => "")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()
      onHabitFire.mockClear()

      // Advance by 2 cadence intervals
      vi.advanceTimersByTime(30 * 60 * 1000)
      expect(onHabitFire).toHaveBeenCalledWith("heartbeat", "overdue", expect.objectContaining({
        occurrenceId: expect.stringMatching(/^timer:heartbeat:cadence-ms:1800000:slot:/),
      }))

      vi.advanceTimersByTime(30 * 60 * 1000)
      expect(onHabitFire).toHaveBeenCalledTimes(2)
      expect(onHabitFire).toHaveBeenLastCalledWith("heartbeat", "overdue", expect.objectContaining({
        occurrenceId: expect.stringMatching(/^timer:heartbeat:cadence-ms:1800000:slot:/),
      }))
    })

    it("keeps one timer owner when a fallback callback re-enters reconciliation", () => {
      mockEvaluateCadenceDue.mockReturnValue({ due: false, elapsedMs: 0, occurrenceId: null })
      const execForVerify = vi.fn(() => "")
      const { scheduler } = makeSchedulerWithVerify({ execForVerify })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())
      onHabitFire.mockImplementation(() => scheduler.reconcile())

      scheduler.start()
      expect(vi.getTimerCount()).toBe(1)

      vi.advanceTimersByTime(30 * 60 * 1000)

      expect(onHabitFire).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      scheduler.stop()
      expect(vi.getTimerCount()).toBe(0)
    })

    it("replaces an existing timer owner when start is invoked again", () => {
      mockEvaluateCadenceDue.mockReturnValue({ due: false, elapsedMs: 0, occurrenceId: null })
      const execForVerify = vi.fn(() => "")
      const { scheduler } = makeSchedulerWithVerify({ execForVerify })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())

      scheduler.start()
      expect(vi.getTimerCount()).toBe(1)
      scheduler.start()

      expect(vi.getTimerCount()).toBe(1)
      expect(scheduler.getDegradedHabits()).toEqual([{
        name: "heartbeat",
        reason: "cron registration failed — using timer fallback",
      }])
    })

    it("ignores a cleared fallback callback after a replacement owns the habit", () => {
      mockEvaluateCadenceDue.mockReturnValue({ due: false, elapsedMs: 0, occurrenceId: null })
      const scheduledCallbacks: Array<() => void> = []
      const fakeSetTimeout = globalThis.setTimeout
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: any[]) => {
        if (typeof callback === "function") {
          scheduledCallbacks.push(() => callback(...args))
        }
        return fakeSetTimeout(callback, delay, ...args)
      }) as typeof setTimeout)
      const { scheduler } = makeSchedulerWithVerify({ execForVerify: vi.fn(() => "") })
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())

      scheduler.start()
      const staleCallback = scheduledCallbacks[0]
      scheduler.start()
      expect(scheduledCallbacks).toHaveLength(2)
      onHabitFire.mockClear()

      staleCallback()

      expect(onHabitFire).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
      expect(scheduler.getDegradedHabits()).toEqual([{
        name: "heartbeat",
        reason: "cron registration failed — using timer fallback",
      }])
    })

    it("getDegradedHabits returns habits on timer fallback", () => {
      const execForVerify = vi.fn(() => "")

      const { scheduler } = makeSchedulerWithVerify({
        execForVerify,
        habits: [makeHeartbeatHabit(), makeDailyReflection()],
      })

      scheduler.start()

      const degraded = scheduler.getDegradedHabits()
      expect(degraded).toHaveLength(2)
      expect(degraded.map((d) => d.name)).toContain("heartbeat")
      expect(degraded.map((d) => d.name)).toContain("daily-reflection")
    })

    it("getDegradedHabits returns empty when no timer fallbacks", () => {
      const execForVerify = vi.fn(() => "bot.ouro.slugger.heartbeat\n")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()

      expect(scheduler.getDegradedHabits()).toHaveLength(0)
    })

    it("emits daemon.habit_cron_verification_failed for unverified habits", () => {
      const execForVerify = vi.fn(() => "")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()

      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.habit_cron_verification_failed",
          component: "daemon",
          meta: expect.objectContaining({ habitName: "heartbeat" }),
        }),
      )
    })

    it("on reconciliation: clears all timers FIRST, then re-syncs and re-verifies", () => {
      const execForVerify = vi.fn(() => "")

      const { scheduler, readdir } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()
      onHabitFire.mockClear()

      // Now simulate reconciliation where cron is now verified
      // Use a recent lastRun so the habit is NOT overdue during reconcile
      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        lastRun: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago, cadence 30m
      })
      readdir.mockReturnValueOnce(["heartbeat.md"])
      execForVerify.mockReturnValueOnce("bot.ouro.slugger.heartbeat\n")

      scheduler.reconcile()

      // Timer should be cleared — advancing time should NOT fire
      vi.advanceTimersByTime(30 * 60 * 1000)
      expect(onHabitFire).not.toHaveBeenCalled()

      // Degraded list should be empty now
      expect(scheduler.getDegradedHabits()).toHaveLength(0)
    })

    it.each(nonActiveTransitions)("%s clears an existing timer fallback without creating a replacement", (transition) => {
      let phase: "active" | "transitioned" = "active"
      const execForVerify = vi.fn(() => "")
      const readdir = vi.fn(() => transition === "missing" && phase === "transitioned" ? [] : ["heartbeat.md"])
      const readFile = vi.fn(() => {
        if (transition === "read_error" && phase === "transitioned") throw new Error("EACCES")
        return "content"
      })
      deps = makeDeps({ readdir, readFile })
      mockParseHabitFile.mockImplementation(() =>
        phase === "active" ? makeHeartbeatHabit() : makeTransitionHabit(transition))
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()
      expect(scheduler.getDegradedHabits()).toHaveLength(1)
      phase = "transitioned"
      onHabitFire.mockClear()
      mockEvaluateCadenceDue.mockClear()
      scheduler.reconcile()

      expect(cronManager.sync).toHaveBeenLastCalledWith([])
      expect(scheduler.getDegradedHabits()).toEqual([])
      vi.advanceTimersByTime(30 * 60 * 1000)
      expect(mockEvaluateCadenceDue).not.toHaveBeenCalled()
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it.each(nonActiveTransitions)("revalidates %s before an existing timer fallback fires or reschedules", (transition) => {
      let phase: "active" | "transitioned" = "active"
      const execForVerify = vi.fn(() => "")
      const readFile = vi.fn(() => {
        if (phase === "transitioned" && transition === "missing") throw new Error("ENOENT")
        if (phase === "transitioned" && transition === "read_error") throw new Error("EACCES")
        return phase === "active" ? "active content" : `${transition} content`
      })
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile,
      })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeTransitionHabit(transition))
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()
      expect(scheduler.getDegradedHabits()).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)
      phase = "transitioned"
      onHabitFire.mockClear()
      readFile.mockClear()

      vi.advanceTimersByTime(30 * 60 * 1000)

      expect(onHabitFire).not.toHaveBeenCalled()
      expect(scheduler.getDegradedHabits()).toEqual([])
      expect(readFile).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it("prunes a fallback when the habit is cancelled as the timer is created", () => {
      let phase: "active" | "cancelled" = "active"
      const execForVerify = vi.fn(() => "")
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => phase === "active" ? "active content" : "cancelled content"),
      })
      mockParseHabitFile.mockImplementation((content: string) =>
        content === "active content" ? makeHeartbeatHabit() : makeCancelledHabit("heartbeat"))
      mockCadenceFallbackDelayMs.mockImplementationOnce(() => {
        phase = "cancelled"
        return 30 * 60 * 1000
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenNthCalledWith(1, [expect.objectContaining({ taskId: "heartbeat" })])
      expect(cronManager.sync).toHaveBeenLastCalledWith([])
      expect(scheduler.getDegradedHabits()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("prunes a fallback whose cadence changes as the timer is created", () => {
      let cadence: "30m" | "2h" = "30m"
      const execForVerify = vi.fn(() => "")
      mockEvaluateCadenceDue.mockReturnValue({ due: false, elapsedMs: 0, occurrenceId: null })
      deps = makeDeps({
        readdir: vi.fn(() => ["heartbeat.md"]),
        readFile: vi.fn(() => cadence === "30m" ? "30m content" : "2h content"),
      })
      mockParseHabitFile.mockImplementation((content: string) => ({
        ...makeHeartbeatHabit(),
        cadence: content === "30m content" ? "30m" : "2h",
      }))
      mockCadenceFallbackDelayMs.mockImplementationOnce(() => {
        cadence = "2h"
        return 30 * 60 * 1000
      })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenNthCalledWith(1, [expect.objectContaining({ schedule: "*/30 * * * *" })])
      expect(cronManager.sync).toHaveBeenLastCalledWith([expect.objectContaining({ schedule: "0 */2 * * *" })])
      expect(scheduler.getDegradedHabits()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("when verification succeeds on later reconciliation: removes timer, cron takes over", () => {
      const execForVerify = vi.fn()
        .mockReturnValueOnce("") // first: verification fails
        .mockReturnValueOnce("bot.ouro.slugger.heartbeat\n") // second: verification succeeds

      const { scheduler, readdir } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()
      expect(scheduler.getDegradedHabits()).toHaveLength(1)

      // Reconcile — cron now verified
      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())
      readdir.mockReturnValueOnce(["heartbeat.md"])

      scheduler.reconcile()

      expect(scheduler.getDegradedHabits()).toHaveLength(0)
    })

    it("stop() clears all timer fallbacks", () => {
      const execForVerify = vi.fn(() => "")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()
      onHabitFire.mockClear()

      scheduler.stop()

      // Timers should be cleared
      vi.advanceTimersByTime(30 * 60 * 1000)
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("skips verification if execForVerify is not provided", () => {
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockReturnValueOnce(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.start()

      // Should not crash, and no degraded habits (verification skipped)
      expect(scheduler.getDegradedHabits()).toHaveLength(0)
    })

    it("handles execForVerify throwing an error gracefully", () => {
      const execForVerify = vi.fn(() => { throw new Error("launchctl not found") })

      const { scheduler } = makeSchedulerWithVerify({ execForVerify })

      scheduler.start()

      // All habits should fall back to timer
      const degraded = scheduler.getDegradedHabits()
      expect(degraded).toHaveLength(1)
      expect(degraded[0].name).toBe("heartbeat")
    })

    it("only verifies active habits with cadence (not paused/no-cadence)", () => {
      const execForVerify = vi.fn(() => "bot.ouro.slugger.heartbeat\n")

      const { scheduler } = makeSchedulerWithVerify({
        execForVerify,
        habits: [makeHeartbeatHabit(), makePausedHabit(), makeNoCadenceHabit()],
      })

      scheduler.start()

      // Only heartbeat is active with cadence and was verified
      expect(scheduler.getDegradedHabits()).toHaveLength(0)
    })

    it("marks habit as degraded even if cadence cannot be parsed for timer", () => {
      const execForVerify = vi.fn(() => "")
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      // Return a habit with cadence that parseCadenceToMs returns null for
      mockParseHabitFile.mockReturnValueOnce({
        ...makeHeartbeatHabit(),
        cadence: "*/30 * * * *", // raw cron string: parseCadenceToCron works but parseCadenceToMs returns null
      })
      // Revalidation rebuilds the job at each execution boundary.
      mockParseCadenceToCron.mockReturnValue("*/30 * * * *")

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      // Still marked degraded even without timer fallback
      const degraded = scheduler.getDegradedHabits()
      expect(degraded).toHaveLength(1)
      expect(degraded[0].name).toBe("heartbeat")
      expect(degraded[0].reason).toBe("cron registration failed — no timer fallback available")
    })

    it("removes a job whose cadence disappears during verification", () => {
      let phase: "active" | "no-cadence" = "active"
      const execForVerify = vi.fn(() => {
        phase = "no-cadence"
        return ""
      })
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => phase === "active" ? "active content" : "no-cadence content")
      deps = makeDeps({ readdir, readFile })

      mockParseHabitFile.mockImplementation((content: string) => content === "active content"
        ? makeHeartbeatHabit()
        : { ...makeHeartbeatHabit(), cadence: null })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.start()

      expect(cronManager.sync).toHaveBeenNthCalledWith(1, [expect.objectContaining({ taskId: "heartbeat" })])
      expect(cronManager.sync).toHaveBeenLastCalledWith([])
      expect(scheduler.getDegradedHabits()).toEqual([])
      expect(onHabitFire).not.toHaveBeenCalled()
    })

    it("on macOS, only matches specific habit labels not the daemon plist", () => {
      // launchctl list returns daemon plist AND habit plist
      const execForVerify = vi.fn(() => "bot.ouro.daemon\nbot.ouro.slugger.heartbeat\n")

      const { scheduler } = makeSchedulerWithVerify({ execForVerify, platform: "darwin" })

      scheduler.start()

      // heartbeat should be verified (exact label match)
      expect(scheduler.getDegradedHabits()).toHaveLength(0)
    })
  })

  describe("periodic reconciliation", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("startPeriodicReconciliation triggers first reconciliation after 30s", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.startPeriodicReconciliation()

      // Before 30s: no reconciliation
      vi.advanceTimersByTime(29_999)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()

      // After 30s: first reconciliation
      vi.advanceTimersByTime(1)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })

    it("contains periodic sync failures and continues the reconciliation chain", () => {
      const sync = vi.fn(() => { throw new Error("periodic sync failed") })
      const removeAll = vi.fn()
      cronManager = makeMockCronManager({ sync, removeAll })
      deps = makeDeps({ readdir: vi.fn(() => []) })
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.startPeriodicReconciliation(1_000)

      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow()
      expect(sync).toHaveBeenCalledTimes(1)
      expect(removeAll).toHaveBeenCalledTimes(1)
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
      expect(sync).toHaveBeenCalledTimes(2)
      expect(removeAll).toHaveBeenCalledTimes(2)
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
      expect(sync).toHaveBeenCalledTimes(3)
      expect(removeAll).toHaveBeenCalledTimes(3)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.habit_scheduler_sync_error",
        meta: expect.objectContaining({ error: "periodic sync failed" }),
      }))
    })

    it("after first reconciliation, subsequent ones fire every 5 minutes", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.startPeriodicReconciliation()

      // First at 30s
      vi.advanceTimersByTime(30_000)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)

      // Second at 30s + 5min
      vi.advanceTimersByTime(300_000)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)

      // Third at 30s + 10min
      vi.advanceTimersByTime(300_000)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3)
    })

    it("accepts custom interval", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.startPeriodicReconciliation(60_000) // 1 minute interval

      // First at 30s
      vi.advanceTimersByTime(30_000)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)

      // Second at 30s + 1min
      vi.advanceTimersByTime(60_000)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
    })

    it("stopPeriodicReconciliation clears the periodic timer", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.startPeriodicReconciliation()

      // Stop before first fires
      scheduler.stopPeriodicReconciliation()

      vi.advanceTimersByTime(600_000)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    })

    it("stop() also clears periodic reconciliation timer", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.startPeriodicReconciliation()

      scheduler.stop()

      vi.advanceTimersByTime(600_000)
      // sync should not have been called by the periodic reconciliation
      // (stop() calls removeAll, not sync)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    })

    it("uses setTimeout chain not setInterval (each completes before next)", () => {
      const readdir = vi.fn(() => [])
      deps = makeDeps({ readdir })

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      scheduler.startPeriodicReconciliation()

      // First at 30s
      vi.advanceTimersByTime(30_000)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)

      // If it was setInterval, all would fire at fixed intervals regardless
      // With setTimeout chain, each schedules the next after completion
      vi.advanceTimersByTime(300_000)
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
    })

    it("reconciliation re-verifies cron entries", () => {
      const execForVerify = vi.fn(() => "")
      const readdir = vi.fn(() => ["heartbeat.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      // Need to set up mock returns for multiple reconcile calls
      mockParseHabitFile.mockReturnValue(makeHeartbeatHabit())

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
        execForVerify,
        platform: "darwin",
      })

      scheduler.startPeriodicReconciliation()

      // First reconciliation at 30s
      vi.advanceTimersByTime(30_000)

      // execForVerify should have been called during reconciliation
      expect(execForVerify).toHaveBeenCalled()
    })

    it("stopPeriodicReconciliation is safe to call when not started", () => {
      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      // Should not throw
      scheduler.stopPeriodicReconciliation()
    })
  })
})
