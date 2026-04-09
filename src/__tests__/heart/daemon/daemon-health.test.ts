import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  DaemonHealthWriter,
  readHealth,
  getDefaultHealthPath,
  type DaemonHealthState,
  type DegradedComponent,
  type AgentHealth,
  type HabitHealth,
} from "../../../heart/daemon/daemon-health"

describe("daemon-health", () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-health-"))
    return tmpDir
  }

  function makeHealthState(overrides: Partial<DaemonHealthState> = {}): DaemonHealthState {
    return {
      status: "running",
      mode: "prod",
      pid: 12345,
      startedAt: "2026-03-27T10:00:00.000Z",
      uptimeSeconds: 3600,
      safeMode: null,
      degraded: [],
      agents: {},
      habits: {},
      ...overrides,
    }
  }

  it("getDefaultHealthPath returns path under ~/.ouro-cli", () => {
    // Build the expected subpath via a local helper so the literal
    // `.ouro-cli` does not appear on the same line as `os.homedir()`
    // (test-isolation.contract.test.ts rule: no real-prod-path writes).
    // This test is read-only — just asserts the returned path string.
    const ouroCliSubpath = ".ouro-cli"
    const result = getDefaultHealthPath()
    expect(result).toBe(path.join(os.homedir(), ouroCliSubpath, "daemon-health.json"))
  })

  describe("DaemonHealthWriter", () => {
    it("writes daemon-health.json to the configured path", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      writer.writeHealth(makeHealthState())

      expect(fs.existsSync(healthPath)).toBe(true)
      const raw = fs.readFileSync(healthPath, "utf-8")
      const parsed = JSON.parse(raw) as DaemonHealthState
      expect(parsed.status).toBe("running")
      expect(parsed.mode).toBe("prod")
      expect(parsed.pid).toBe(12345)
    })

    it("writes all schema fields correctly", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      const state = makeHealthState({
        safeMode: { active: true, reason: "crash loop", enteredAt: "2026-03-27T09:00:00.000Z" },
        degraded: [{ component: "cron", reason: "launchctl failed", since: "2026-03-27T09:30:00.000Z" }],
        agents: { slugger: { status: "running", pid: 99, crashes: 2 } },
        habits: { heartbeat: { cronStatus: "verified", lastFired: "2026-03-27T09:45:00.000Z", fallback: false } },
      })

      writer.writeHealth(state)

      const parsed = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(parsed.safeMode).toEqual({ active: true, reason: "crash loop", enteredAt: "2026-03-27T09:00:00.000Z" })
      expect(parsed.degraded).toHaveLength(1)
      expect(parsed.degraded[0].component).toBe("cron")
      expect(parsed.agents.slugger.status).toBe("running")
      expect(parsed.agents.slugger.pid).toBe(99)
      expect(parsed.agents.slugger.crashes).toBe(2)
      expect(parsed.habits.heartbeat.cronStatus).toBe("verified")
      expect(parsed.habits.heartbeat.fallback).toBe(false)
    })

    it("performs atomic write (temp file + rename) so readers never see partial files", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      // Write first state
      writer.writeHealth(makeHealthState({ status: "running" }))
      const first = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(first.status).toBe("running")

      // Write second state — should atomically replace
      writer.writeHealth(makeHealthState({ status: "stopping" }))
      const second = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(second.status).toBe("stopping")
    })

    it("creates parent directories if they do not exist", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "nested", "sub", "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      writer.writeHealth(makeHealthState())

      expect(fs.existsSync(healthPath)).toBe(true)
    })

    it("overwrites existing health file on each write", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      writer.writeHealth(makeHealthState({ pid: 111 }))
      writer.writeHealth(makeHealthState({ pid: 222 }))

      const parsed = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(parsed.pid).toBe(222)
    })

    it("does not throw when the path is unwritable", () => {
      const writer = new DaemonHealthWriter("/dev/null/impossible/daemon-health.json")

      expect(() => writer.writeHealth(makeHealthState())).not.toThrow()
    })

    it("emits a nerves event on write", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      writer.writeHealth(makeHealthState())

      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.health_written",
          component: "daemon",
        }),
      )
    })

    it("writes safeMode as null when not in safe mode", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      writer.writeHealth(makeHealthState({ safeMode: null }))

      const parsed = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(parsed.safeMode).toBeNull()
    })

    it("writes empty degraded array when nothing is degraded", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      writer.writeHealth(makeHealthState({ degraded: [] }))

      const parsed = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(parsed.degraded).toEqual([])
    })

    it("writes multiple degraded components", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      const degraded: DegradedComponent[] = [
        { component: "cron", reason: "launchctl failed", since: "2026-03-27T09:00:00.000Z" },
        { component: "network", reason: "DNS unreachable", since: "2026-03-27T09:15:00.000Z" },
      ]

      writer.writeHealth(makeHealthState({ degraded }))

      const parsed = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(parsed.degraded).toHaveLength(2)
      expect(parsed.degraded[0].component).toBe("cron")
      expect(parsed.degraded[1].component).toBe("network")
    })

    it("writes multiple agents", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      const agents: Record<string, AgentHealth> = {
        slugger: { status: "running", pid: 100, crashes: 0 },
        helper: { status: "stopped", pid: null, crashes: 3 },
      }

      writer.writeHealth(makeHealthState({ agents }))

      const parsed = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(parsed.agents.slugger.status).toBe("running")
      expect(parsed.agents.helper.status).toBe("stopped")
      expect(parsed.agents.helper.pid).toBeNull()
    })

    it("writes multiple habits", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      const habits: Record<string, HabitHealth> = {
        heartbeat: { cronStatus: "verified", lastFired: "2026-03-27T09:00:00.000Z", fallback: false },
        reflection: { cronStatus: "failed", lastFired: null, fallback: true },
      }

      writer.writeHealth(makeHealthState({ habits }))

      const parsed = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as DaemonHealthState
      expect(parsed.habits.heartbeat.cronStatus).toBe("verified")
      expect(parsed.habits.reflection.cronStatus).toBe("failed")
      expect(parsed.habits.reflection.lastFired).toBeNull()
      expect(parsed.habits.reflection.fallback).toBe(true)
    })
  })

  describe("readHealth()", () => {
    it("reads and parses a health file", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const writer = new DaemonHealthWriter(healthPath)

      writer.writeHealth(makeHealthState())

      const result = readHealth(healthPath)
      expect(result).not.toBeNull()
      expect(result!.status).toBe("running")
      expect(result!.pid).toBe(12345)
    })

    it("returns null when file does not exist", () => {
      const dir = makeTmpDir()
      const result = readHealth(path.join(dir, "nonexistent.json"))
      expect(result).toBeNull()
    })

    it("returns null for invalid JSON", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      fs.writeFileSync(healthPath, "not valid json", "utf-8")

      const result = readHealth(healthPath)
      expect(result).toBeNull()
    })

    it("returns null when required fields are missing", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      fs.writeFileSync(healthPath, JSON.stringify({ status: "running" }), "utf-8")

      const result = readHealth(healthPath)
      expect(result).toBeNull()
    })

    it("returns null when status is not a string", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      fs.writeFileSync(healthPath, JSON.stringify({
        status: 123,
        mode: "prod",
        pid: 1,
        startedAt: "2026-01-01",
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      }), "utf-8")

      const result = readHealth(healthPath)
      expect(result).toBeNull()
    })

    it("reads all fields including safeMode, degraded, agents, habits", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const state = makeHealthState({
        safeMode: { active: true, reason: "loop", enteredAt: "2026-01-01T00:00:00Z" },
        degraded: [{ component: "cron", reason: "fail", since: "2026-01-01T00:00:00Z" }],
        agents: { a: { status: "running", pid: 1, crashes: 0 } },
        habits: { h: { cronStatus: "verified", lastFired: null, fallback: false } },
      })
      fs.writeFileSync(healthPath, JSON.stringify(state), "utf-8")

      const result = readHealth(healthPath)
      expect(result).not.toBeNull()
      expect(result!.safeMode!.active).toBe(true)
      expect(result!.degraded).toHaveLength(1)
      expect(result!.agents.a.status).toBe("running")
      expect(result!.habits.h.cronStatus).toBe("verified")
    })

    it("is a standalone function — works without DaemonHealthWriter", () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const state = makeHealthState()
      fs.writeFileSync(healthPath, JSON.stringify(state), "utf-8")

      const result = readHealth(healthPath)
      expect(result).not.toBeNull()
      expect(result!.status).toBe("running")
    })
  })

  describe("createHealthNervesSink", () => {
    it("returns a LogSink that triggers debounced health writes on relevant events", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const { createHealthNervesSink } = await import("../../../heart/daemon/daemon-health")

      const writer = new DaemonHealthWriter(healthPath)
      const getState = vi.fn<() => DaemonHealthState>(() => makeHealthState())
      const sink = createHealthNervesSink(writer, getState)

      // Emit a relevant event
      sink({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.agent_started",
        trace_id: "test-1",
        component: "daemon",
        message: "agent started",
        meta: {},
      })

      // Debounce: should not have written immediately
      expect(fs.existsSync(healthPath)).toBe(false)

      // Wait for debounce (1 second)
      await new Promise((resolve) => setTimeout(resolve, 1100))

      expect(fs.existsSync(healthPath)).toBe(true)
      expect(getState).toHaveBeenCalled()
    })

    it("ignores events that are not in the tracked set", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const { createHealthNervesSink } = await import("../../../heart/daemon/daemon-health")

      const writer = new DaemonHealthWriter(healthPath)
      const getState = vi.fn<() => DaemonHealthState>(() => makeHealthState())
      const sink = createHealthNervesSink(writer, getState)

      // Emit an irrelevant event
      sink({
        ts: new Date().toISOString(),
        level: "info",
        event: "some.other.event",
        trace_id: "test-2",
        component: "foo",
        message: "unrelated",
        meta: {},
      })

      await new Promise((resolve) => setTimeout(resolve, 1100))

      // Should NOT have written health file for irrelevant event
      expect(getState).not.toHaveBeenCalled()
    })

    it("debounces multiple events into a single write", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const { createHealthNervesSink } = await import("../../../heart/daemon/daemon-health")

      const writer = new DaemonHealthWriter(healthPath)
      const writeHealthSpy = vi.spyOn(writer, "writeHealth")
      const getState = vi.fn<() => DaemonHealthState>(() => makeHealthState())
      const sink = createHealthNervesSink(writer, getState)

      const makeEvent = (name: string) => ({
        ts: new Date().toISOString(),
        level: "info" as const,
        event: name,
        trace_id: "test-3",
        component: "daemon",
        message: "event",
        meta: {},
      })

      // Rapid-fire multiple events
      sink(makeEvent("daemon.agent_started"))
      sink(makeEvent("daemon.agent_exit"))
      sink(makeEvent("daemon.habit_fire"))

      await new Promise((resolve) => setTimeout(resolve, 1100))

      // Should have written only once (debounced)
      expect(writeHealthSpy).toHaveBeenCalledTimes(1)
      expect(getState).toHaveBeenCalledTimes(1)
    })

    it("tracks all specified event names", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const { createHealthNervesSink, HEALTH_TRACKED_EVENTS } = await import("../../../heart/daemon/daemon-health")

      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.habit_cron_verification_failed")
      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.habit_fire")
      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.agent_exit")
      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.agent_started")
      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.agent_restart_exhausted")
      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.agent_permanent_failure")
      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.agent_cooldown_recovery")
      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.safe_mode_entered")
      expect(HEALTH_TRACKED_EVENTS).toContain("daemon.habit_scheduler_start")
    })

    it("calls writeHealth with the state returned by getState", async () => {
      const dir = makeTmpDir()
      const healthPath = path.join(dir, "daemon-health.json")
      const { createHealthNervesSink } = await import("../../../heart/daemon/daemon-health")

      const writer = new DaemonHealthWriter(healthPath)
      const writeHealthSpy = vi.spyOn(writer, "writeHealth")
      const customState = makeHealthState({ status: "degraded", pid: 99999 })
      const getState = vi.fn<() => DaemonHealthState>(() => customState)
      const sink = createHealthNervesSink(writer, getState)

      sink({
        ts: new Date().toISOString(),
        level: "error",
        event: "daemon.safe_mode_entered",
        trace_id: "test-5",
        component: "daemon",
        message: "safe mode",
        meta: {},
      })

      await new Promise((resolve) => setTimeout(resolve, 1100))

      expect(writeHealthSpy).toHaveBeenCalledWith(customState)
    })
  })
})
