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

  describe("onCriticalAgent callback", () => {
    it("invokes onCriticalAgent with agent names from critical agent-process results", async () => {
      const onCriticalAgent = vi.fn()
      const monitor = new HealthMonitor({
        processManager: {
          listAgentSnapshots: () => [
            { name: "slugger", status: "stopped" },
            { name: "ouroboros", status: "running" },
          ],
        },
        scheduler: {
          listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
        },
        onCriticalAgent,
      })

      await monitor.runChecks()
      expect(onCriticalAgent).toHaveBeenCalledTimes(1)
      expect(onCriticalAgent).toHaveBeenCalledWith("slugger")
    })

    it("does not call onCriticalAgent when all agents are running (ok status)", async () => {
      const onCriticalAgent = vi.fn()
      const monitor = new HealthMonitor({
        processManager: {
          listAgentSnapshots: () => [{ name: "slugger", status: "running" }],
        },
        scheduler: {
          listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
        },
        onCriticalAgent,
      })

      await monitor.runChecks()
      expect(onCriticalAgent).not.toHaveBeenCalled()
    })

    it("does not call onCriticalAgent for non-agent-process critical results like disk-space", async () => {
      const onCriticalAgent = vi.fn()
      const monitor = new HealthMonitor({
        processManager: {
          listAgentSnapshots: () => [{ name: "slugger", status: "running" }],
        },
        scheduler: {
          listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
        },
        diskUsagePercent: () => 95,
        onCriticalAgent,
      })

      const results = await monitor.runChecks()
      // disk-space is critical but should NOT trigger onCriticalAgent
      expect(results.some((r) => r.name === "disk-space" && r.status === "critical")).toBe(true)
      expect(onCriticalAgent).not.toHaveBeenCalled()
    })

    it("works without onCriticalAgent provided (default no-op)", async () => {
      const monitor = new HealthMonitor({
        processManager: {
          listAgentSnapshots: () => [{ name: "slugger", status: "stopped" }],
        },
        scheduler: {
          listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
        },
      })

      // Should not crash
      await expect(monitor.runChecks()).resolves.toBeDefined()
    })

    it("calls onCriticalAgent for each non-running agent when multiple are down", async () => {
      const onCriticalAgent = vi.fn()
      const monitor = new HealthMonitor({
        processManager: {
          listAgentSnapshots: () => [
            { name: "slugger", status: "crashed" },
            { name: "ouroboros", status: "stopped" },
            { name: "helper", status: "running" },
          ],
        },
        scheduler: {
          listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
        },
        onCriticalAgent,
      })

      await monitor.runChecks()
      expect(onCriticalAgent).toHaveBeenCalledTimes(2)
      expect(onCriticalAgent).toHaveBeenCalledWith("slugger")
      expect(onCriticalAgent).toHaveBeenCalledWith("ouroboros")
    })

    it("does not crash when onCriticalAgent callback throws", async () => {
      const onCriticalAgent = vi.fn(() => {
        throw new Error("restart failed")
      })
      const monitor = new HealthMonitor({
        processManager: {
          listAgentSnapshots: () => [{ name: "slugger", status: "stopped" }],
        },
        scheduler: {
          listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
        },
        onCriticalAgent,
      })

      // Should not throw, recovery is best-effort
      const results = await monitor.runChecks()
      expect(results[0]?.status).toBe("critical")
      expect(onCriticalAgent).toHaveBeenCalledWith("slugger")
    })
  })

  describe("sense probes", () => {
    function createBaseOptions() {
      return {
        processManager: {
          listAgentSnapshots: () => [{ name: "slugger", status: "running" }],
        },
        scheduler: {
          listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
        },
      }
    }

    it("existing behavior is unchanged when no sense probes are configured", async () => {
      const monitor = new HealthMonitor(createBaseOptions())

      const results = await monitor.runChecks()
      expect(results).toEqual([
        { name: "agent-processes", status: "ok", message: "all managed agents running" },
        { name: "cron-health", status: "ok", message: "cron jobs are healthy" },
        { name: "disk-space", status: "ok", message: "disk usage healthy (0%)" },
      ])
    })

    it("includes ok result for a probe that returns ok: true", async () => {
      const monitor = new HealthMonitor({
        ...createBaseOptions(),
        senseProbes: [
          {
            name: "bluebubbles",
            check: async () => ({ ok: true }),
          },
        ],
      })

      const results = await monitor.runChecks()
      const probeResult = results.find((r) => r.name === "sense-probe:bluebubbles")
      expect(probeResult).toEqual({
        name: "sense-probe:bluebubbles",
        status: "ok",
        message: "bluebubbles healthy",
      })
    })

    it("includes critical result and calls alertSink for a probe that returns ok: false", async () => {
      const alertSink = vi.fn(async () => undefined)
      const monitor = new HealthMonitor({
        ...createBaseOptions(),
        alertSink,
        senseProbes: [
          {
            name: "bluebubbles",
            check: async () => ({ ok: false, detail: "connection refused" }),
          },
        ],
      })

      const results = await monitor.runChecks()
      const probeResult = results.find((r) => r.name === "sense-probe:bluebubbles")
      expect(probeResult).toEqual({
        name: "sense-probe:bluebubbles",
        status: "critical",
        message: "bluebubbles failed: connection refused",
      })
      expect(alertSink).toHaveBeenCalledWith(
        "[critical] sense-probe:bluebubbles: bluebubbles failed: connection refused",
      )
    })

    it("includes results from multiple probes", async () => {
      const monitor = new HealthMonitor({
        ...createBaseOptions(),
        senseProbes: [
          {
            name: "bluebubbles",
            check: async () => ({ ok: true }),
          },
          {
            name: "teams",
            check: async () => ({ ok: false, detail: "timeout" }),
          },
        ],
      })

      const results = await monitor.runChecks()
      const bbResult = results.find((r) => r.name === "sense-probe:bluebubbles")
      const teamsResult = results.find((r) => r.name === "sense-probe:teams")
      expect(bbResult?.status).toBe("ok")
      expect(teamsResult?.status).toBe("critical")
    })

    it("treats a throwing probe as critical with error message as detail", async () => {
      const alertSink = vi.fn(async () => undefined)
      const monitor = new HealthMonitor({
        ...createBaseOptions(),
        alertSink,
        senseProbes: [
          {
            name: "bluebubbles",
            check: async () => {
              throw new Error("ECONNREFUSED")
            },
          },
        ],
      })

      const results = await monitor.runChecks()
      const probeResult = results.find((r) => r.name === "sense-probe:bluebubbles")
      expect(probeResult).toEqual({
        name: "sense-probe:bluebubbles",
        status: "critical",
        message: "bluebubbles error: ECONNREFUSED",
      })
      expect(alertSink).toHaveBeenCalledWith(
        "[critical] sense-probe:bluebubbles: bluebubbles error: ECONNREFUSED",
      )
    })

    it("probe name appears prefixed with sense-probe: in result name field", async () => {
      const monitor = new HealthMonitor({
        ...createBaseOptions(),
        senseProbes: [
          {
            name: "my-custom-sense",
            check: async () => ({ ok: true }),
          },
        ],
      })

      const results = await monitor.runChecks()
      const probeResult = results.find((r) => r.name === "sense-probe:my-custom-sense")
      expect(probeResult).toBeDefined()
      expect(probeResult!.name).toBe("sense-probe:my-custom-sense")
    })
  })
})
