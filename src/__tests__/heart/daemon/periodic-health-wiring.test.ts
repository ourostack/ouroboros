import { describe, expect, it, vi } from "vitest"

import { HealthMonitor } from "../../../heart/daemon/health-monitor"

describe("periodic health wiring composition", () => {
  it("onCriticalAgent wired to mock restartAgent triggers restart for non-running agents", async () => {
    const restartAgent = vi.fn()
    const monitor = new HealthMonitor({
      processManager: {
        listAgentSnapshots: () => [
          { name: "ouroboros", status: "crashed" },
          { name: "slugger", status: "running" },
        ],
      },
      scheduler: {
        listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
      },
      onCriticalAgent: (agentName) => {
        restartAgent(agentName)
      },
    })

    await monitor.runChecks()
    expect(restartAgent).toHaveBeenCalledTimes(1)
    expect(restartAgent).toHaveBeenCalledWith("ouroboros")
  })

  it("onCriticalAgent callback that throws does not crash runChecks", async () => {
    const monitor = new HealthMonitor({
      processManager: {
        listAgentSnapshots: () => [{ name: "ouroboros", status: "stopped" }],
      },
      scheduler: {
        listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
      },
      onCriticalAgent: () => {
        throw new Error("processManager.restartAgent failed")
      },
    })

    // Recovery is best-effort -- runChecks must complete even if callback throws
    const results = await monitor.runChecks()
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ name: "agent-processes", status: "critical" })
  })

  it("triggers separate onCriticalAgent calls for each non-running agent", async () => {
    const restartAgent = vi.fn()
    const monitor = new HealthMonitor({
      processManager: {
        listAgentSnapshots: () => [
          { name: "ouroboros", status: "crashed" },
          { name: "slugger", status: "stopped" },
          { name: "helper", status: "running" },
        ],
      },
      scheduler: {
        listJobs: () => [{ id: "daily", lastRun: "2026-01-01T00:00:00Z" }],
      },
      onCriticalAgent: (agentName) => {
        restartAgent(agentName)
      },
    })

    await monitor.runChecks()
    expect(restartAgent).toHaveBeenCalledTimes(2)
    expect(restartAgent).toHaveBeenCalledWith("ouroboros")
    expect(restartAgent).toHaveBeenCalledWith("slugger")
  })
})
