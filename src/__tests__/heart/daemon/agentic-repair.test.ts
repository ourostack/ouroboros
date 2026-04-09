import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../../nerves/runtime"
import { runAgenticRepair } from "../../../heart/daemon/agentic-repair"
import type { AgenticRepairDeps } from "../../../heart/daemon/agentic-repair"
import type { DegradedAgent } from "../../../heart/daemon/interactive-repair"
import type { DiscoverWorkingProviderResult } from "../../../heart/daemon/provider-discovery"

// Silence nerves events during tests
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeDiscoverResult(): DiscoverWorkingProviderResult {
  return {
    provider: "anthropic",
    credentials: { apiKey: "sk-test" },
    providerConfig: { apiKey: "sk-test" },
  }
}

function makeDeps(overrides: Partial<AgenticRepairDeps> = {}): AgenticRepairDeps {
  return {
    discoverWorkingProvider: vi.fn(async () => makeDiscoverResult()),
    runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    promptInput: vi.fn(async () => "n"),
    writeStdout: vi.fn(),
    createProviderRuntime: vi.fn(() => ({
      streamTurn: vi.fn(async () => ({
        content: "Diagnosis: check your API keys and restart.",
        toolCalls: [],
        outputItems: [],
      })),
    })),
    readDaemonLogsTail: vi.fn(() => "2026-04-09 10:00:00 daemon started\n2026-04-09 10:00:05 agent crashed"),
    ...overrides,
  }
}

describe("runAgenticRepair", () => {
  it("returns immediately with no repairs for empty degraded list", async () => {
    const deps = makeDeps()
    const result = await runAgenticRepair([], deps)
    expect(result).toEqual({ repairsAttempted: false, usedAgentic: false })
    expect(deps.discoverWorkingProvider).not.toHaveBeenCalled()
    expect(deps.runInteractiveRepair).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("falls back to deterministic repair when no working provider found", async () => {
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    const deps = makeDeps({
      discoverWorkingProvider: vi.fn(async () => null),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
    })
    const result = await runAgenticRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true, usedAgentic: false })
    expect(deps.runInteractiveRepair).toHaveBeenCalledWith(degraded, {
      promptInput: deps.promptInput,
      writeStdout: deps.writeStdout,
      runAuthFlow: expect.any(Function),
    })
    expect(deps.createProviderRuntime).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("falls back to deterministic repair when user declines agentic ('n')", async () => {
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
    })
    const result = await runAgenticRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true, usedAgentic: false })
    expect(deps.runInteractiveRepair).toHaveBeenCalledWith(degraded, {
      promptInput: deps.promptInput,
      writeStdout: deps.writeStdout,
      runAuthFlow: expect.any(Function),
    })
    expect(deps.createProviderRuntime).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("uses agentic diagnosis when user accepts ('y'), creates provider runtime and sends request", async () => {
    const mockStreamTurn = vi.fn(async () => ({
      content: "Diagnosis: your API key is expired. Run `ouro auth slugger` to refresh.",
      toolCalls: [],
      outputItems: [],
    }))
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      createProviderRuntime: vi.fn(() => ({
        streamTurn: mockStreamTurn,
      })),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
    })
    const result = await runAgenticRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true, usedAgentic: true })
    // Provider runtime was created with discovered credentials
    expect(deps.createProviderRuntime).toHaveBeenCalledWith(
      "anthropic",
      { apiKey: "sk-test" },
    )
    // streamTurn was called with system + user messages
    expect(mockStreamTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({ role: "user" }),
        ]),
      }),
    )
    // LLM response was displayed
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("Diagnosis: your API key is expired"),
    )
    // Daemon logs were read for context
    expect(deps.readDaemonLogsTail).toHaveBeenCalled()
    // Falls through to deterministic repair after agentic diagnosis
    expect(deps.runInteractiveRepair).toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("falls back to deterministic repair when discoverWorkingProvider throws", async () => {
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    const deps = makeDeps({
      discoverWorkingProvider: vi.fn(async () => { throw new Error("discovery exploded") }),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    })
    const result = await runAgenticRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false, usedAgentic: false })
    expect(deps.runInteractiveRepair).toHaveBeenCalled()
    expect(deps.createProviderRuntime).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("falls back to deterministic repair when streamTurn throws", async () => {
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      createProviderRuntime: vi.fn(() => ({
        streamTurn: vi.fn(async () => { throw new Error("LLM call failed") }),
      })),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
    })
    const result = await runAgenticRepair(degraded, deps)
    // Still reports usedAgentic false because the agentic path failed
    expect(result).toEqual({ repairsAttempted: true, usedAgentic: false })
    // Error was displayed to user
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("LLM call failed"),
    )
    // Falls back to deterministic repair
    expect(deps.runInteractiveRepair).toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("treats 'Y' (uppercase) as acceptance of agentic diagnosis", async () => {
    const mockStreamTurn = vi.fn(async () => ({
      content: "Looks like a credential issue.",
      toolCalls: [],
      outputItems: [],
    }))
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "Y"),
      createProviderRuntime: vi.fn(() => ({
        streamTurn: mockStreamTurn,
      })),
    })
    const result = await runAgenticRepair(degraded, deps)
    expect(result.usedAgentic).toBe(true)
    expect(mockStreamTurn).toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("includes degraded agent details and daemon logs in the LLM request context", async () => {
    const mockStreamTurn = vi.fn(async () => ({
      content: "Check the agent config.",
      toolCalls: [],
      outputItems: [],
    }))
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials for anthropic", fixHint: "run ouro auth slugger" },
      { agent: "mybot", errorReason: "config parse error", fixHint: "check secrets.json" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      createProviderRuntime: vi.fn(() => ({
        streamTurn: mockStreamTurn,
      })),
      readDaemonLogsTail: vi.fn(() => "daemon log line 1\ndaemon log line 2"),
    })
    await runAgenticRepair(degraded, deps)
    // Verify the user message includes agent names and error details
    const call = mockStreamTurn.mock.calls[0][0]
    const userMsg = call.messages.find((m: { role: string }) => m.role === "user")
    expect(userMsg.content).toContain("slugger")
    expect(userMsg.content).toContain("missing credentials for anthropic")
    expect(userMsg.content).toContain("mybot")
    expect(userMsg.content).toContain("config parse error")
    // Daemon logs included
    expect(userMsg.content).toContain("daemon log line 1")
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("falls back gracefully when discoverWorkingProvider throws a non-Error", async () => {
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    const deps = makeDeps({
      discoverWorkingProvider: vi.fn(async () => { throw "string-error" }), // eslint-disable-line no-throw-literal
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    })
    const result = await runAgenticRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false, usedAgentic: false })
    expect(deps.runInteractiveRepair).toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("falls back gracefully when streamTurn throws a non-Error", async () => {
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      createProviderRuntime: vi.fn(() => ({
        streamTurn: vi.fn(async () => { throw "llm-string-error" }), // eslint-disable-line no-throw-literal
      })),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    })
    const result = await runAgenticRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false, usedAgentic: false })
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("llm-string-error"),
    )
    expect(deps.runInteractiveRepair).toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })
})
