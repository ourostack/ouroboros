import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { HealthMonitor } from "../../../heart/daemon/health-monitor"

describe("HealthMonitor", () => {
  it("reports all checks as ok when snapshots, jobs, and disk usage are healthy", async () => {
    const monitor = new HealthMonitor({
      processManager: {
        listAgentSnapshots: () => [{ name: "slugger", status: "running" }],
      },
      scheduler: {
        listJobs: () => [{ id: "daily-review", lastRun: "2026-03-07T00:00:00.000Z" }],
      },
    })

    await expect(monitor.runChecks()).resolves.toEqual([
      { name: "agent-processes", status: "ok", message: "all managed agents running" },
      { name: "cron-health", status: "ok", message: "cron jobs are healthy" },
      { name: "disk-space", status: "ok", message: "disk usage healthy (0%)" },
    ])
  })

  it("reports warnings for never-run jobs and high disk without paging alerts", async () => {
    const alertSink = vi.fn(async () => undefined)
    const monitor = new HealthMonitor({
      processManager: {
        listAgentSnapshots: () => [{ name: "slugger", status: "running" }],
      },
      scheduler: {
        listJobs: () => [{ id: "habit-hourly", lastRun: null }],
      },
      diskUsagePercent: () => 85,
      alertSink,
    })

    await expect(monitor.runChecks()).resolves.toEqual([
      { name: "agent-processes", status: "ok", message: "all managed agents running" },
      { name: "cron-health", status: "warn", message: "jobs never run: habit-hourly" },
      { name: "disk-space", status: "warn", message: "disk usage high (85%)" },
    ])
    expect(alertSink).not.toHaveBeenCalled()
  })

  it("uses the default no-op alert sink when critical status is detected", async () => {
    const monitor = new HealthMonitor({
      processManager: {
        listAgentSnapshots: () => [{ name: "slugger", status: "stopped" }],
      },
      scheduler: {
        listJobs: () => [{ id: "hourly-check", lastRun: "2026-03-07T00:00:00.000Z" }],
      },
      diskUsagePercent: () => 10,
    })

    await expect(monitor.runChecks()).resolves.toEqual([
      {
        name: "agent-processes",
        status: "critical",
        message: "non-running agents: slugger",
      },
      { name: "cron-health", status: "ok", message: "cron jobs are healthy" },
      { name: "disk-space", status: "ok", message: "disk usage healthy (10%)" },
    ])
  })

  it("reports critical status for non-running agents and disk exhaustion and alerts for each", async () => {
    const alertSink = vi.fn(async () => undefined)
    const monitor = new HealthMonitor({
      processManager: {
        listAgentSnapshots: () => [
          { name: "slugger", status: "running" },
          { name: "ouroboros", status: "crashed" },
        ],
      },
      scheduler: {
        listJobs: () => [{ id: "nightly-reconcile", lastRun: "2026-03-07T00:00:00.000Z" }],
      },
      diskUsagePercent: () => 95,
      alertSink,
    })

    await expect(monitor.runChecks()).resolves.toEqual([
      {
        name: "agent-processes",
        status: "critical",
        message: "non-running agents: ouroboros",
      },
      { name: "cron-health", status: "ok", message: "cron jobs are healthy" },
      { name: "disk-space", status: "critical", message: "disk usage critical (95%)" },
    ])
    expect(alertSink).toHaveBeenCalledTimes(2)
    expect(alertSink).toHaveBeenNthCalledWith(
      1,
      "[critical] agent-processes: non-running agents: ouroboros",
    )
    expect(alertSink).toHaveBeenNthCalledWith(2, "[critical] disk-space: disk usage critical (95%)")
  })

  describe("periodic scheduling", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function createMonitor() {
      return new HealthMonitor({
        processManager: {
          listAgentSnapshots: () => [{ name: "slugger", status: "running" }],
        },
        scheduler: {
          listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
        },
      })
    }

    it("calls runChecks on the specified interval", async () => {
      const monitor = createMonitor()
      const spy = vi.spyOn(monitor, "runChecks")

      monitor.startPeriodicChecks(5000)
      expect(spy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5000)
      expect(spy).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5000)
      expect(spy).toHaveBeenCalledTimes(2)

      monitor.stopPeriodicChecks()
    })

    it("stopPeriodicChecks clears the interval", async () => {
      const monitor = createMonitor()
      const spy = vi.spyOn(monitor, "runChecks")

      monitor.startPeriodicChecks(5000)
      await vi.advanceTimersByTimeAsync(5000)
      expect(spy).toHaveBeenCalledTimes(1)

      monitor.stopPeriodicChecks()

      await vi.advanceTimersByTimeAsync(10000)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it("calling startPeriodicChecks twice does not create duplicate intervals", async () => {
      const monitor = createMonitor()
      const spy = vi.spyOn(monitor, "runChecks")

      monitor.startPeriodicChecks(5000)
      monitor.startPeriodicChecks(5000)

      await vi.advanceTimersByTimeAsync(5000)
      expect(spy).toHaveBeenCalledTimes(1)

      monitor.stopPeriodicChecks()
    })

    it("stopPeriodicChecks is safe to call when not started", () => {
      const monitor = createMonitor()
      expect(() => monitor.stopPeriodicChecks()).not.toThrow()
    })
  })
})
