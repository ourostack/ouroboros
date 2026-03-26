import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

// Import after mock
import { HeartbeatTimer, parseCadenceMs, DEFAULT_CADENCE_MS } from "../../../heart/daemon/heartbeat-timer"

describe("parseCadenceMs", () => {
  it("parses minutes", () => {
    expect(parseCadenceMs("30m")).toBe(30 * 60 * 1000)
    expect(parseCadenceMs("1m")).toBe(60 * 1000)
  })

  it("parses hours", () => {
    expect(parseCadenceMs("1h")).toBe(60 * 60 * 1000)
    expect(parseCadenceMs("2h")).toBe(2 * 60 * 60 * 1000)
  })

  it("parses days", () => {
    expect(parseCadenceMs("1d")).toBe(24 * 60 * 60 * 1000)
  })

  it("returns null for invalid strings", () => {
    expect(parseCadenceMs("nonsense")).toBeNull()
    expect(parseCadenceMs("")).toBeNull()
    expect(parseCadenceMs("0m")).toBeNull()
    expect(parseCadenceMs("-5m")).toBeNull()
  })

  it("returns null for non-string input", () => {
    expect(parseCadenceMs(null as unknown as string)).toBeNull()
    expect(parseCadenceMs(undefined as unknown as string)).toBeNull()
    expect(parseCadenceMs(42 as unknown as string)).toBeNull()
  })
})

describe("DEFAULT_CADENCE_MS", () => {
  it("is 30 minutes in ms", () => {
    expect(DEFAULT_CADENCE_MS).toBe(30 * 60 * 1000)
  })
})

describe("HeartbeatTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(emitNervesEvent).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createTimer(overrides: Partial<{
    agent: string
    sendToAgent: (agent: string, message: { type: string }) => void
    readFileSync: (path: string, encoding: string) => string
    readdirSync: (dirPath: string) => string[]
    heartbeatTaskDir: string
    runtimeStatePath: string
    now: () => number
  }> = {}) {
    const sendToAgent = overrides.sendToAgent ?? vi.fn()
    const readFileSync = overrides.readFileSync ?? vi.fn(() => { throw new Error("no file") })
    const readdirSync = overrides.readdirSync ?? vi.fn(() => [])
    const now = overrides.now ?? (() => Date.now())

    const timer = new HeartbeatTimer({
      agent: overrides.agent ?? "slugger",
      sendToAgent,
      deps: {
        readFileSync,
        readdirSync,
        heartbeatTaskDir: overrides.heartbeatTaskDir ?? "/bundles/slugger.ouro/tasks/habits",
        runtimeStatePath: overrides.runtimeStatePath ?? "/bundles/slugger.ouro/state/sessions/self/inner/runtime.json",
        now,
      },
    })

    return { timer, sendToAgent, readFileSync, readdirSync }
  }

  it("fires immediately when no runtime state exists (never run before)", () => {
    const sendToAgent = vi.fn()
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return "---\ncadence: \"30m\"\n---\n"
      }
      throw new Error("ENOENT")
    })
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])

    const { timer } = createTimer({ sendToAgent, readFileSync, readdirSync })
    timer.start()

    // With no runtime state (lastCompletedAt), should fire immediately (delay = 0)
    vi.advanceTimersByTime(0)
    expect(sendToAgent).toHaveBeenCalledWith("slugger", { type: "heartbeat" })

    timer.stop()
  })

  it("fires after remaining delay when partially elapsed", () => {
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME

    const sendToAgent = vi.fn()
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return "---\ncadence: \"30m\"\n---\n"
      }
      // runtime.json: last completed 10 minutes ago
      const tenMinAgo = new Date(BASE_TIME - 10 * 60 * 1000).toISOString()
      return JSON.stringify({ lastCompletedAt: tenMinAgo })
    })
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // Should not fire immediately (20 min remain of 30 min cadence)
    vi.advanceTimersByTime(0)
    expect(sendToAgent).not.toHaveBeenCalled()

    // Advance 19 minutes -- still not time
    currentTime += 19 * 60 * 1000
    vi.advanceTimersByTime(19 * 60 * 1000)
    expect(sendToAgent).not.toHaveBeenCalled()

    // Advance 1 more minute (total 20 min = remaining delay)
    currentTime += 1 * 60 * 1000
    vi.advanceTimersByTime(1 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)
    expect(sendToAgent).toHaveBeenCalledWith("slugger", { type: "heartbeat" })

    timer.stop()
  })

  it("fires immediately when overdue (elapsed > cadence)", () => {
    const BASE_TIME = 1000000
    const sendToAgent = vi.fn()
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return "---\ncadence: \"30m\"\n---\n"
      }
      // Last completed 45 minutes ago (overdue by 15 min)
      const fortyFiveMinAgo = new Date(BASE_TIME - 45 * 60 * 1000).toISOString()
      return JSON.stringify({ lastCompletedAt: fortyFiveMinAgo })
    })
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => BASE_TIME,
    })
    timer.start()

    vi.advanceTimersByTime(0)
    expect(sendToAgent).toHaveBeenCalledWith("slugger", { type: "heartbeat" })

    timer.stop()
  })

  it("reschedules after each fire", () => {
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME
    let fireCount = 0

    const sendToAgent = vi.fn()
    // Runtime state: completed 25 minutes ago (5 min remain of 30m cadence)
    const completedAt = new Date(BASE_TIME - 25 * 60 * 1000).toISOString()
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return "---\ncadence: \"30m\"\n---\n"
      }
      // After first fire, update lastCompletedAt to "just now"
      if (fireCount > 0) {
        return JSON.stringify({ lastCompletedAt: new Date(currentTime).toISOString() })
      }
      return JSON.stringify({ lastCompletedAt: completedAt })
    })
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // Not yet fired (5 min remain)
    vi.advanceTimersByTime(0)
    expect(sendToAgent).not.toHaveBeenCalled()

    // Advance 5 minutes -> first fire
    currentTime += 5 * 60 * 1000
    sendToAgent.mockImplementation(() => { fireCount++ })
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    // After fire, reschedules with updated lastCompletedAt = now
    // Full 30m cadence remains. Advance 29 min -> still no fire
    currentTime += 29 * 60 * 1000
    vi.advanceTimersByTime(29 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    // Advance 1 more minute -> second fire
    currentTime += 1 * 60 * 1000
    vi.advanceTimersByTime(1 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(2)

    timer.stop()
  })

  it("picks up cadence changes on each reschedule cycle", () => {
    // Cadence changes are picked up because scheduleNext() re-reads the task file each cycle.
    // Cycle 1: cadence=10m, completed 8m ago, fires in 2m
    // Cycle 2: cadence=10m (scheduleNext reads at fire time), fires in 10m
    // Cycle 3: cadence=5m (changed between fires), fires in 5m
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME
    let cadence = "10m"
    let fireCount = 0

    const sendToAgent = vi.fn(() => { fireCount++ })
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return `---\ncadence: "${cadence}"\n---\n`
      }
      if (fireCount > 0) {
        return JSON.stringify({ lastCompletedAt: new Date(currentTime).toISOString() })
      }
      return JSON.stringify({ lastCompletedAt: new Date(BASE_TIME - 8 * 60 * 1000).toISOString() })
    })
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // First fire at 2 min (8 min elapsed of 10m cadence)
    currentTime += 2 * 60 * 1000
    vi.advanceTimersByTime(2 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    // Reschedule read cadence=10m at fire time. Second fire in 10m.
    // Change cadence to 5m now — will be picked up on NEXT reschedule (after second fire).
    cadence = "5m"

    // Second fire at +10m (cadence=10m was read during first fire's reschedule)
    currentTime += 10 * 60 * 1000
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(2)

    // Now the third cycle should use cadence=5m (read during second fire's reschedule)
    // Advance 4m — not yet
    currentTime += 4 * 60 * 1000
    vi.advanceTimersByTime(4 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(2)

    // Advance 1 more min — 5m total since second fire
    currentTime += 1 * 60 * 1000
    vi.advanceTimersByTime(1 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(3)

    timer.stop()
  })

  it("stop() cancels pending timer", () => {
    const sendToAgent = vi.fn()
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return "---\ncadence: \"30m\"\n---\n"
      }
      return JSON.stringify({ lastCompletedAt: new Date().toISOString() })
    })
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])

    const { timer } = createTimer({ sendToAgent, readFileSync, readdirSync })
    timer.start()
    timer.stop()

    // Even after full cadence time, should not fire
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(sendToAgent).not.toHaveBeenCalled()
  })

  it("uses default 30m cadence when heartbeat task file is missing", () => {
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME

    const sendToAgent = vi.fn()
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        throw new Error("ENOENT")
      }
      return JSON.stringify({ lastCompletedAt: new Date(BASE_TIME).toISOString() })
    })
    // No heartbeat file in dir
    const readdirSync = vi.fn(() => [])

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // Default cadence 30m, just completed -- should not fire yet
    vi.advanceTimersByTime(0)
    expect(sendToAgent).not.toHaveBeenCalled()

    // 30 minutes later
    currentTime += 30 * 60 * 1000
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })

  it("uses default 30m cadence when heartbeat task file has unparseable cadence", () => {
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME

    const sendToAgent = vi.fn()
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return "---\ncadence: \"garbage\"\n---\n"
      }
      return JSON.stringify({ lastCompletedAt: new Date(BASE_TIME).toISOString() })
    })
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // Default 30m cadence
    vi.advanceTimersByTime(0)
    expect(sendToAgent).not.toHaveBeenCalled()

    currentTime += 30 * 60 * 1000
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })

  it("emits nerves event on each heartbeat fire", () => {
    const sendToAgent = vi.fn()
    const readFileSync = vi.fn(() => { throw new Error("ENOENT") })
    const readdirSync = vi.fn(() => [])

    const { timer } = createTimer({ sendToAgent, readFileSync, readdirSync })
    timer.start()

    vi.advanceTimersByTime(0)
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "daemon",
        event: "daemon.heartbeat_fire",
        meta: expect.objectContaining({ agent: "slugger" }),
      }),
    )

    timer.stop()
  })

  it("uses setTimeout not setInterval", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
    const sendToAgent = vi.fn()
    const readFileSync = vi.fn(() => { throw new Error("ENOENT") })
    const readdirSync = vi.fn(() => [])

    const { timer } = createTimer({ sendToAgent, readFileSync, readdirSync })
    timer.start()

    vi.advanceTimersByTime(0)
    expect(setIntervalSpy).not.toHaveBeenCalled()

    timer.stop()
    setIntervalSpy.mockRestore()
  })

  it("scans habits directory for heartbeat task file matching *-heartbeat.md", () => {
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME
    let fireCount = 0

    const sendToAgent = vi.fn(() => { fireCount++ })
    // Start with runtime state: completed 10 min ago (5 min remain of 15m cadence)
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("2026-03-08-1200-heartbeat.md")) {
        return "---\ncadence: \"15m\"\n---\n"
      }
      if (fireCount > 0) {
        return JSON.stringify({ lastCompletedAt: new Date(currentTime).toISOString() })
      }
      return JSON.stringify({ lastCompletedAt: new Date(BASE_TIME - 10 * 60 * 1000).toISOString() })
    })
    const readdirSync = vi.fn(() => [
      "2026-03-08-0900-daily-review.md",
      "2026-03-08-1200-heartbeat.md",
      "2026-03-08-1500-weekly-report.md",
    ])

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // 5 min remain, not yet
    vi.advanceTimersByTime(0)
    expect(sendToAgent).not.toHaveBeenCalled()

    // Advance 5 min -> first fire
    currentTime += 5 * 60 * 1000
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    // After fire, reschedules. 15 min cadence, just completed.
    // Advance 14 min -> not yet
    currentTime += 14 * 60 * 1000
    vi.advanceTimersByTime(14 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    // Advance 1 more min -> second fire
    currentTime += 1 * 60 * 1000
    vi.advanceTimersByTime(1 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(2)

    timer.stop()
  })

  it("handles readdirSync failure gracefully", () => {
    const sendToAgent = vi.fn()
    const readFileSync = vi.fn(() => { throw new Error("ENOENT") })
    const readdirSync = vi.fn(() => { throw new Error("ENOENT") })

    const { timer } = createTimer({ sendToAgent, readFileSync, readdirSync })
    timer.start()

    // Should still fire (default cadence, no runtime state = immediate)
    vi.advanceTimersByTime(0)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })

  it("uses default cadence when heartbeat file found but readFileSync throws", () => {
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME

    const sendToAgent = vi.fn()
    // readdirSync returns a heartbeat file, but readFileSync throws when reading it
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        throw new Error("EACCES") // file found but unreadable
      }
      return JSON.stringify({ lastCompletedAt: new Date(BASE_TIME).toISOString() })
    })

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // Default 30m cadence, just completed
    vi.advanceTimersByTime(0)
    expect(sendToAgent).not.toHaveBeenCalled()

    currentTime += 30 * 60 * 1000
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })

  it("uses default cadence when task file content has no frontmatter", () => {
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME

    const sendToAgent = vi.fn()
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return "no frontmatter here, just plain text"
      }
      return JSON.stringify({ lastCompletedAt: new Date(BASE_TIME).toISOString() })
    })

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // Default 30m
    currentTime += 30 * 60 * 1000
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })

  it("uses default cadence when task file has unterminated frontmatter", () => {
    const BASE_TIME = 1000000
    let currentTime = BASE_TIME

    const sendToAgent = vi.fn()
    const readdirSync = vi.fn(() => ["2026-01-01-0000-heartbeat.md"])
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("heartbeat.md")) {
        return "---\ncadence: \"30m\"\nno closing delimiter"
      }
      return JSON.stringify({ lastCompletedAt: new Date(BASE_TIME).toISOString() })
    })

    const { timer } = createTimer({
      sendToAgent,
      readFileSync,
      readdirSync,
      now: () => currentTime,
    })
    timer.start()

    // Default 30m
    currentTime += 30 * 60 * 1000
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })

  it("fires immediately when lastCompletedAt is not a string", () => {
    const sendToAgent = vi.fn()
    const readdirSync = vi.fn(() => [])
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("runtime.json")) {
        return JSON.stringify({ lastCompletedAt: 12345 }) // number, not string
      }
      throw new Error("ENOENT")
    })

    const { timer } = createTimer({ sendToAgent, readFileSync, readdirSync })
    timer.start()

    // No valid lastCompletedAt -> fire immediately
    vi.advanceTimersByTime(0)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })

  it("fires immediately when lastCompletedAt is an invalid date", () => {
    const sendToAgent = vi.fn()
    const readdirSync = vi.fn(() => [])
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes("runtime.json")) {
        return JSON.stringify({ lastCompletedAt: "not-a-date" })
      }
      throw new Error("ENOENT")
    })

    const { timer } = createTimer({ sendToAgent, readFileSync, readdirSync })
    timer.start()

    // Invalid date -> null -> fire immediately
    vi.advanceTimersByTime(0)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })

  it("stop() is safe to call when no timer is pending", () => {
    const { timer } = createTimer()
    // stop() without start() should not throw
    expect(() => timer.stop()).not.toThrow()
  })

  it("uses Date.now() when deps.now is not provided", () => {
    const sendToAgent = vi.fn()
    const readFileSync = vi.fn(() => { throw new Error("ENOENT") })
    const readdirSync = vi.fn(() => [])

    const timer = new HeartbeatTimer({
      agent: "slugger",
      sendToAgent,
      deps: {
        readFileSync,
        readdirSync,
        heartbeatTaskDir: "/bundles/tasks/habits",
        runtimeStatePath: "/bundles/state/sessions/self/inner/runtime.json",
        // no 'now' — uses Date.now() default
      },
    })
    timer.start()

    // Should fire immediately (no runtime state)
    vi.advanceTimersByTime(0)
    expect(sendToAgent).toHaveBeenCalledTimes(1)

    timer.stop()
  })
})
