import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OsCronManager } from "../../../heart/daemon/os-cron"
import type { ScheduledTaskJob } from "../../../heart/daemon/task-scheduler"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

const mockParseAwaitFile = vi.fn()
vi.mock("../../../heart/awaiting/await-parser", () => ({
  parseAwaitFile: (...args: any[]) => mockParseAwaitFile(...args),
}))

const mockApplyAwaitRuntimeState = vi.fn((_: string, a: unknown) => a)
vi.mock("../../../heart/awaiting/await-runtime-state", () => ({
  applyAwaitRuntimeState: (...args: any[]) => mockApplyAwaitRuntimeState(...args),
}))

const mockParseCadenceToCron = vi.fn()
const mockParseCadenceToMs = vi.fn()
vi.mock("../../../heart/daemon/cadence", () => ({
  parseCadenceToCron: (...args: any[]) => mockParseCadenceToCron(...args),
  parseCadenceToMs: (...args: any[]) => mockParseCadenceToMs(...args),
}))

import {
  AwaitScheduler,
  type AwaitSchedulerDeps,
} from "../../../heart/awaiting/await-scheduler"

function makeMockCronManager(overrides: Partial<OsCronManager> = {}): OsCronManager {
  return {
    sync: vi.fn(),
    removeAll: vi.fn(),
    list: vi.fn(() => []),
    ...overrides,
  }
}

function makeDeps(overrides: Partial<AwaitSchedulerDeps> = {}): AwaitSchedulerDeps {
  return {
    readdir: vi.fn(() => []),
    readFile: vi.fn(() => ""),
    existsSync: vi.fn(() => true),
    mkdir: vi.fn(),
    now: vi.fn(() => 1_000_000),
    ouroPath: "/usr/local/bin/ouro",
    ...overrides,
  }
}

function makePending(overrides: Record<string, unknown> = {}) {
  return {
    name: "hey_export",
    condition: "x",
    cadence: "5m",
    alert: "bluebubbles",
    mode: "full" as const,
    max_age: null,
    status: "pending" as const,
    created_at: "2026-05-10T20:00:00.000Z",
    filed_from: "cli",
    filed_for_friend_id: "ari",
    body: "",
    resolved_at: null,
    resolution_observation: null,
    expired_at: null,
    last_observation_at_expiry: null,
    canceled_at: null,
    cancel_reason: null,
    last_checked: null,
    last_observation: null,
    checked_count: 0,
    ...overrides,
  }
}

function makeResolved() {
  return makePending({ name: "old_await", status: "resolved" as const })
}

describe("AwaitScheduler", () => {
  let cronManager: OsCronManager
  let deps: AwaitSchedulerDeps
  let onAwaitFire: ReturnType<typeof vi.fn>
  let onAwaitExpire: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    cronManager = makeMockCronManager()
    deps = makeDeps()
    onAwaitFire = vi.fn()
    onAwaitExpire = vi.fn()
    mockApplyAwaitRuntimeState.mockImplementation((_: string, a: unknown) => a)
    mockParseCadenceToCron.mockImplementation((raw: string) => {
      if (raw === "5m") return "*/5 * * * *"
      if (raw === "1h") return "0 */1 * * *"
      return null
    })
    mockParseCadenceToMs.mockImplementation((raw: string) => {
      if (raw === "5m") return 5 * 60 * 1000
      if (raw === "1h") return 60 * 60 * 1000
      if (raw === "24h") return 24 * 60 * 60 * 1000
      return null
    })
  })

  describe("start()", () => {
    it("ensures the awaits dir exists before scanning (cold-start: dir not yet created)", () => {
      const mkdir = vi.fn()
      const readdir = vi.fn(() => [])
      deps = makeDeps({ mkdir, readdir })

      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/bundles/slugger.ouro/awaiting",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })

      scheduler.start()

      expect(mkdir).toHaveBeenCalledWith("/bundles/slugger.ouro/awaiting")
      // mkdir must precede readdir so the watcher (which attaches after start()) sees a real dir.
      const mkdirOrder = mkdir.mock.invocationCallOrder[0]
      const readdirOrder = readdir.mock.invocationCallOrder[0]
      expect(mkdirOrder).toBeLessThan(readdirOrder)
    })

    it("scans awaitsDir and registers cron entries for pending awaits", () => {
      const readdir = vi.fn(() => ["hey_export.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseAwaitFile.mockReturnValueOnce(makePending())

      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/bundles/slugger.ouro/awaiting",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })

      scheduler.start()

      expect(readdir).toHaveBeenCalledWith("/bundles/slugger.ouro/awaiting")
      const synced = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(synced).toHaveLength(1)
      expect(synced[0].agent).toBe("slugger")
      expect(synced[0].taskId).toBe("await.hey_export")
      expect(synced[0].schedule).toBe("*/5 * * * *")
      expect(synced[0].command).toContain("/usr/local/bin/ouro poke slugger --await hey_export")
    })

    it("skips non-pending awaits (resolved/expired/canceled)", () => {
      const readdir = vi.fn(() => ["old.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseAwaitFile.mockReturnValueOnce(makeResolved())

      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/bundles/slugger.ouro/awaiting",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })

      scheduler.start()

      const synced = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(synced).toHaveLength(0)
      expect(onAwaitFire).not.toHaveBeenCalled()
    })

    it("skips awaits without cadence", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })

      mockParseAwaitFile.mockReturnValueOnce(makePending({ cadence: null }))

      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/bundles/slugger.ouro/awaiting",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })

      scheduler.start()
      const synced = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(synced).toHaveLength(0)
    })

    it("skips awaits with unparseable cadence (returns null from parseCadenceToCron)", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending({ cadence: "garbage" }))
      mockParseCadenceToMs.mockReturnValue(null)
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })

      scheduler.start()
      const synced = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(synced).toHaveLength(0)
    })

    it("skips non-.md files", () => {
      const readdir = vi.fn(() => ["README.txt", "ignore.json"])
      deps = makeDeps({ readdir })
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      const synced = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(synced).toHaveLength(0)
    })

    it("handles missing awaitsDir gracefully", () => {
      const readdir = vi.fn(() => { throw new Error("ENOENT") })
      deps = makeDeps({ readdir })
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/missing",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      const synced = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(synced).toHaveLength(0)
      expect(scheduler.getParseErrors()).toEqual([])
    })

    it("records parse errors when file read or parse throws", () => {
      const readdir = vi.fn(() => ["bad.md"])
      const readFile = vi.fn(() => "x")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockImplementationOnce(() => { throw new Error("bad frontmatter") })
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(scheduler.getParseErrors()).toEqual([{ file: "bad.md", error: "bad frontmatter" }])
    })

    it("records parse error from non-Error throw", () => {
      const readdir = vi.fn(() => ["bad.md"])
      const readFile = vi.fn(() => "x")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockImplementationOnce(() => { throw "string-error" })
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(scheduler.getParseErrors()).toEqual([{ file: "bad.md", error: "string-error" }])
    })

    it("fires overdue awaits on startup (never checked)", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending({ last_checked: null }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitFire).toHaveBeenCalledWith("hey_export")
    })

    it("fires overdue awaits on startup (checked but elapsed > cadence)", () => {
      const nowMs = 10_000_000
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile, now: () => nowMs })
      // last_checked far in past
      mockParseAwaitFile.mockReturnValueOnce(makePending({
        last_checked: new Date(nowMs - 10 * 60 * 1000).toISOString(),
      }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitFire).toHaveBeenCalledWith("hey_export")
    })

    it("does NOT fire if last_checked within cadence", () => {
      const nowMs = 10_000_000
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile, now: () => nowMs })
      mockParseAwaitFile.mockReturnValueOnce(makePending({
        last_checked: new Date(nowMs - 1000).toISOString(),
      }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitFire).not.toHaveBeenCalled()
    })

    it("skips fireOverdue when await has null cadence", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending({ cadence: null }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitFire).not.toHaveBeenCalled()
    })

    it("skips fireOverdue when cadence-ms is null", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending({ cadence: "weird" }))
      mockParseCadenceToCron.mockReturnValueOnce("*/5 * * * *") // jobs build
      mockParseCadenceToMs.mockReturnValueOnce(null) // overdue calc skips
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitFire).not.toHaveBeenCalled()
    })

    it("expires awaits whose max_age has elapsed since created_at", () => {
      const nowMs = 100 * 24 * 60 * 60 * 1000 // 100 days
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile, now: () => nowMs })
      mockParseAwaitFile.mockReturnValueOnce(makePending({
        max_age: "24h",
        created_at: new Date(nowMs - 48 * 60 * 60 * 1000).toISOString(),
      }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitExpire).toHaveBeenCalledWith("hey_export")
      // and should not be in cron jobs
      const synced = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as ScheduledTaskJob[]
      expect(synced).toHaveLength(0)
    })

    it("does not expire when max_age is unset", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending({ max_age: null }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitExpire).not.toHaveBeenCalled()
    })

    it("does not expire when created_at is unset", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending({ max_age: "24h", created_at: null }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitExpire).not.toHaveBeenCalled()
    })

    it("does not expire when max_age is unparseable", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending({ max_age: "weirdunit", created_at: "2026-05-10T00:00:00.000Z" }))
      mockParseCadenceToMs.mockReturnValueOnce(5 * 60 * 1000) // for cadence
      mockParseCadenceToMs.mockReturnValueOnce(null) // for max_age
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitExpire).not.toHaveBeenCalled()
    })

    it("does not expire when created_at is invalid date", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending({ max_age: "24h", created_at: "garbage" }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitExpire).not.toHaveBeenCalled()
    })

    it("does not expire non-pending awaits even if max_age elapsed", () => {
      const nowMs = 100 * 24 * 60 * 60 * 1000
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile, now: () => nowMs })
      mockParseAwaitFile.mockReturnValueOnce(makePending({
        status: "resolved",
        max_age: "24h",
        created_at: new Date(nowMs - 48 * 60 * 60 * 1000).toISOString(),
      }))
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(onAwaitExpire).not.toHaveBeenCalled()
    })
  })

  describe("reconcile()", () => {
    it("re-scans and syncs cron entries", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValue(makePending())
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      scheduler.reconcile()
      expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
    })
  })

  describe("stop()", () => {
    it("calls osCronManager.removeAll and stops periodic", () => {
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.startPeriodicReconciliation(1000)
      scheduler.stop()
      expect((cronManager.removeAll as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    })
  })

  describe("getAwaitFile()", () => {
    it("returns parsed file with runtime state applied", () => {
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readFile })
      mockParseAwaitFile.mockReturnValueOnce(makePending())
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/bundles/slugger.ouro/awaiting",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      const result = scheduler.getAwaitFile("hey_export")
      expect(result).not.toBeNull()
      expect(result?.name).toBe("hey_export")
    })

    it("returns null when read fails", () => {
      const readFile = vi.fn(() => { throw new Error("ENOENT") })
      deps = makeDeps({ readFile })
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      expect(scheduler.getAwaitFile("missing")).toBeNull()
    })
  })

  describe("watchForChanges/stopWatching", () => {
    it("does nothing when no watch dep provided", () => {
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.watchForChanges()
      scheduler.stopWatching()
      expect(true).toBe(true)
    })

    it("registers watcher with debounced reconcile", () => {
      vi.useFakeTimers()
      try {
        const callbacks: Array<(event: string, filename: string | null) => void> = []
        const closer = vi.fn()
        const watch = vi.fn((_dir: string, cb: (event: string, filename: string | null) => void) => {
          callbacks.push(cb)
          return { close: closer }
        })
        const readdir = vi.fn(() => [])
        deps = makeDeps({ readdir, watch })
        const scheduler = new AwaitScheduler({
          agent: "slugger",
          awaitsDir: "/x",
          osCronManager: cronManager,
          onAwaitFire,
          onAwaitExpire,
          deps,
        })
        scheduler.watchForChanges()
        callbacks[0]!("change", "x.md")
        // Fire a 2nd event to test debounce reset
        callbacks[0]!("change", "y.md")
        vi.advanceTimersByTime(300)
        expect((cronManager.sync as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
        scheduler.stopWatching()
        expect(closer).toHaveBeenCalled()
        // calling stopWatching again is a no-op
        scheduler.stopWatching()
      } finally {
        vi.useRealTimers()
      }
    })

    it("debounce timer cleared by stopWatching before firing", () => {
      vi.useFakeTimers()
      try {
        const callbacks: Array<(event: string, filename: string | null) => void> = []
        const closer = vi.fn()
        const watch = vi.fn((_dir: string, cb: (event: string, filename: string | null) => void) => {
          callbacks.push(cb)
          return { close: closer }
        })
        deps = makeDeps({ watch })
        const scheduler = new AwaitScheduler({
          agent: "slugger",
          awaitsDir: "/x",
          osCronManager: cronManager,
          onAwaitFire,
          onAwaitExpire,
          deps,
        })
        scheduler.watchForChanges()
        callbacks[0]!("change", "x.md")
        scheduler.stopWatching()
        vi.advanceTimersByTime(500)
        // reconcile should NOT have been called from the debounced callback
        // because stopWatching cleared the timer
        expect((cronManager.sync as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("startPeriodicReconciliation/stopPeriodicReconciliation", () => {
    it("fires reconcile after initial delay then on interval", () => {
      vi.useFakeTimers()
      try {
        const readdir = vi.fn(() => [])
        deps = makeDeps({ readdir })
        const scheduler = new AwaitScheduler({
          agent: "slugger",
          awaitsDir: "/x",
          osCronManager: cronManager,
          onAwaitFire,
          onAwaitExpire,
          deps,
        })
        scheduler.startPeriodicReconciliation(60_000)
        // initial delay 30s
        vi.advanceTimersByTime(30_000)
        const firstCount = (cronManager.sync as ReturnType<typeof vi.fn>).mock.calls.length
        expect(firstCount).toBeGreaterThanOrEqual(1)
        // next interval 60s
        vi.advanceTimersByTime(60_000)
        expect((cronManager.sync as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(firstCount)
        scheduler.stopPeriodicReconciliation()
        // double-stop is no-op
        scheduler.stopPeriodicReconciliation()
      } finally {
        vi.useRealTimers()
      }
    })

    it("uses default interval when not specified", () => {
      vi.useFakeTimers()
      try {
        deps = makeDeps()
        const scheduler = new AwaitScheduler({
          agent: "slugger",
          awaitsDir: "/x",
          osCronManager: cronManager,
          onAwaitFire,
          onAwaitExpire,
          deps,
        })
        scheduler.startPeriodicReconciliation()
        vi.advanceTimersByTime(30_000)
        vi.advanceTimersByTime(300_000)
        scheduler.stop()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("verifyCronAndCreateFallbacks", () => {
    it("creates timer fallback when launchd verification fails (darwin)", () => {
      vi.useFakeTimers()
      try {
        const readdir = vi.fn(() => ["x.md"])
        const readFile = vi.fn(() => "content")
        deps = makeDeps({ readdir, readFile })
        mockParseAwaitFile.mockReturnValue(makePending())
        const execForVerify = vi.fn(() => "no match\n")
        const scheduler = new AwaitScheduler({
          agent: "slugger",
          awaitsDir: "/x",
          osCronManager: cronManager,
          onAwaitFire,
          onAwaitExpire,
          deps,
          execForVerify,
          platform: "darwin",
        })
        scheduler.start()
        expect(scheduler.getDegradedAwaits()).toEqual([
          { name: "hey_export", reason: "cron registration failed — using timer fallback" },
        ])
        // initial overdue fire already happened
        const initialFires = onAwaitFire.mock.calls.length
        // timer fallback fires after cadenceMs
        vi.advanceTimersByTime(5 * 60 * 1000)
        expect(onAwaitFire.mock.calls.length).toBeGreaterThan(initialFires)
        scheduler.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it("considers entry verified when launchctl output matches label", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValue(makePending())
      const execForVerify = vi.fn(() => "12345\t0\tbot.ouro.slugger.await.hey_export\n")
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
        execForVerify,
        platform: "darwin",
      })
      scheduler.start()
      expect(scheduler.getDegradedAwaits()).toEqual([])
    })

    it("considers entry verified when crontab line matches (linux)", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValue(makePending())
      const execForVerify = vi.fn(() => "*/5 * * * * /usr/bin/ouro poke slugger --await hey_export\n")
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
        execForVerify,
        platform: "linux",
      })
      scheduler.start()
      expect(scheduler.getDegradedAwaits()).toEqual([])
    })

    it("creates timer fallback on linux when not verified", () => {
      vi.useFakeTimers()
      try {
        const readdir = vi.fn(() => ["x.md"])
        const readFile = vi.fn(() => "content")
        deps = makeDeps({ readdir, readFile })
        mockParseAwaitFile.mockReturnValue(makePending())
        const execForVerify = vi.fn(() => "")
        const scheduler = new AwaitScheduler({
          agent: "slugger",
          awaitsDir: "/x",
          osCronManager: cronManager,
          onAwaitFire,
          onAwaitExpire,
          deps,
          execForVerify,
          platform: "linux",
        })
        scheduler.start()
        expect(scheduler.getDegradedAwaits()).toHaveLength(1)
        scheduler.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it("no-op when execForVerify is not provided", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValue(makePending())
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
      })
      scheduler.start()
      expect(scheduler.getDegradedAwaits()).toEqual([])
    })

    it("does not create timer fallback when getAwaitFile yields null cadence-ms", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      // First call: scanAwaits parsing
      mockParseAwaitFile.mockReturnValueOnce(makePending())
      // Second call inside getAwaitFile during verifyCronAndCreateFallbacks
      mockParseAwaitFile.mockReturnValueOnce(makePending({ cadence: null }))
      const execForVerify = vi.fn(() => "")
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
        execForVerify,
        platform: "darwin",
      })
      scheduler.start()
      // degraded, but no timer scheduled
      expect(scheduler.getDegradedAwaits()).toHaveLength(1)
    })

    it("verify swallows exec errors", () => {
      const readdir = vi.fn(() => ["x.md"])
      const readFile = vi.fn(() => "content")
      deps = makeDeps({ readdir, readFile })
      mockParseAwaitFile.mockReturnValue(makePending())
      const execForVerify = vi.fn(() => { throw new Error("nope") })
      const scheduler = new AwaitScheduler({
        agent: "slugger",
        awaitsDir: "/x",
        osCronManager: cronManager,
        onAwaitFire,
        onAwaitExpire,
        deps,
        execForVerify,
        platform: "darwin",
      })
      scheduler.start()
      // all entries unverified => degraded
      expect(scheduler.getDegradedAwaits()).toHaveLength(1)
    })
  })
})
