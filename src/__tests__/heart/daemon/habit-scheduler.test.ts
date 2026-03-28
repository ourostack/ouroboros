import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OsCronManager } from "../../../heart/daemon/os-cron"
import type { ScheduledTaskJob } from "../../../heart/daemon/task-scheduler"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

// We need to mock the parseHabitFile since it calls emitNervesEvent
const mockParseHabitFile = vi.fn()
vi.mock("../../../heart/daemon/habit-parser", () => ({
  parseHabitFile: (...args: any[]) => mockParseHabitFile(...args),
}))

const mockParseCadenceToCron = vi.fn()
const mockParseCadenceToMs = vi.fn()
vi.mock("../../../heart/daemon/cadence", () => ({
  parseCadenceToCron: (...args: any[]) => mockParseCadenceToCron(...args),
  parseCadenceToMs: (...args: any[]) => mockParseCadenceToMs(...args),
}))

import { HabitScheduler, type HabitSchedulerOptions, type HabitSchedulerDeps } from "../../../heart/daemon/habit-scheduler"

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

describe("HabitScheduler", () => {
  let cronManager: OsCronManager
  let deps: HabitSchedulerDeps
  let onHabitFire: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    cronManager = makeMockCronManager()
    deps = makeDeps()
    onHabitFire = vi.fn()

    mockParseCadenceToCron.mockImplementation((raw: string) => {
      if (raw === "30m") return "*/30 * * * *"
      if (raw === "1d") return "0 0 */1 * *"
      if (raw === "7d") return "0 0 */7 * *"
      if (raw === "2h") return "0 */2 * * *"
      return null
    })
    mockParseCadenceToMs.mockImplementation((raw: string) => {
      if (raw === "30m") return 30 * 60 * 1000
      if (raw === "1d") return 24 * 60 * 60 * 1000
      if (raw === "7d") return 7 * 24 * 60 * 60 * 1000
      if (raw === "2h") return 2 * 60 * 60 * 1000
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

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat")
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

      expect(onHabitFire).toHaveBeenCalledWith("heartbeat")
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

      const scheduler = new HabitScheduler({
        agent: "slugger",
        habitsDir: "/bundles/slugger.ouro/habits",
        osCronManager: cronManager,
        onHabitFire,
        deps,
      })

      const habit = scheduler.getHabitFile("heartbeat")

      expect(readFile).toHaveBeenCalledWith("/bundles/slugger.ouro/habits/heartbeat.md", "utf-8")
      expect(habit).toEqual(makeHeartbeatHabit())
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
          event: "daemon.habit_scheduler_stop",
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
})
