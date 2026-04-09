import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../../nerves/runtime"
import { runInteractiveRepair } from "../../../heart/daemon/interactive-repair"
import type { InteractiveRepairDeps, DegradedAgent } from "../../../heart/daemon/interactive-repair"

// Silence nerves events during tests
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeDeps(overrides: Partial<InteractiveRepairDeps> = {}): InteractiveRepairDeps {
  return {
    promptInput: vi.fn(async () => "n"),
    writeStdout: vi.fn(),
    runAuthFlow: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe("runInteractiveRepair", () => {
  it("returns immediately with repairsAttempted false when no degraded agents", async () => {
    const deps = makeDeps()
    const result = await runInteractiveRepair([], deps)
    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.promptInput).not.toHaveBeenCalled()
    expect(deps.writeStdout).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("prompts for auth and runs auth flow when user says y for missing credentials (errorReason)", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials for provider", fixHint: "run ouro auth slugger" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.promptInput).toHaveBeenCalledWith(
      expect.stringContaining("ouro auth slugger"),
    )
    expect(deps.runAuthFlow).toHaveBeenCalledWith("slugger")
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("prompts for auth and runs auth flow when user says y for missing credentials (fixHint contains ouro auth)", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "mybot", errorReason: "startup failed", fixHint: "try running ouro auth mybot" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.runAuthFlow).toHaveBeenCalledWith("mybot")
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("skips auth flow when user says n for missing credentials", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "run ouro auth slugger" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("shows fix hint and offers retry for config errors with actionable fixHint", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "config parse error", fixHint: "check ~/.agentsecrets/slugger/secrets.json for syntax errors" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false })
    // Should display the fix hint
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("check ~/.agentsecrets/slugger/secrets.json"),
    )
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("handles unknown error type by displaying fix hint without auto-fix prompt", async () => {
    const deps = makeDeps()
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "unknown internal error", fixHint: "" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false })
    // Should display the error but not prompt for auto-fix since fixHint is empty
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("unknown internal error"),
    )
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("handles multiple degraded agents, prompting for each", async () => {
    let callCount = 0
    const deps = makeDeps({
      promptInput: vi.fn(async () => {
        callCount++
        return callCount === 1 ? "y" : "n"
      }),
    })
    const degraded: DegradedAgent[] = [
      { agent: "agent1", errorReason: "missing credentials", fixHint: "ouro auth agent1" },
      { agent: "agent2", errorReason: "missing credentials", fixHint: "ouro auth agent2" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.runAuthFlow).toHaveBeenCalledWith("agent1")
    expect(deps.runAuthFlow).not.toHaveBeenCalledWith("agent2")
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("catches auth flow errors and continues to next agent", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runAuthFlow: vi.fn(async (agent: string) => {
        if (agent === "agent1") throw new Error("auth failed")
      }),
    })
    const degraded: DegradedAgent[] = [
      { agent: "agent1", errorReason: "missing credentials", fixHint: "ouro auth agent1" },
      { agent: "agent2", errorReason: "missing credentials", fixHint: "ouro auth agent2" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    // Both auth flows attempted despite first one throwing
    expect(deps.runAuthFlow).toHaveBeenCalledWith("agent1")
    expect(deps.runAuthFlow).toHaveBeenCalledWith("agent2")
    // Error logged
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("auth failed"),
    )
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("treats Y (uppercase) as yes", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "Y"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "credentials not found", fixHint: "ouro auth slugger" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.runAuthFlow).toHaveBeenCalledWith("slugger")
    expect(emitNervesEvent).toHaveBeenCalled()
  })
})
