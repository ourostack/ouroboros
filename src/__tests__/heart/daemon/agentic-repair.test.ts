import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../../nerves/runtime"
import { createAgenticDiagnosisProviderRuntime, runAgenticRepair } from "../../../heart/daemon/agentic-repair"
import type { AgenticRepairDeps } from "../../../heart/daemon/agentic-repair"
import type { DegradedAgent } from "../../../heart/daemon/interactive-repair"
import type { DiscoverWorkingProviderResult } from "../../../heart/daemon/provider-discovery"

const mockCreateProviderRuntimeForConfig = vi.hoisted(() => vi.fn(() => ({
  streamTurn: vi.fn(async () => ({ content: "", toolCalls: [], outputItems: [] })),
})))

// Silence nerves events during tests
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../heart/provider-ping", () => ({
  createProviderRuntimeForConfig: (...args: unknown[]) => mockCreateProviderRuntimeForConfig(...args),
}))

function makeDiscoverResult(): DiscoverWorkingProviderResult {
  return {
    provider: "anthropic",
    credentials: { setupToken: "sk-test" },
    providerConfig: { model: "claude-opus-4-6" },
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
      { agent: "slugger", errorReason: "config parse error", fixHint: "check agent.json" },
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
      { agent: "slugger", errorReason: "config parse error", fixHint: "check agent.json" },
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
      { agent: "slugger", errorReason: "config parse error", fixHint: "check agent.json" },
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
    // Provider runtime was created from the complete discovered provider record.
    expect(deps.createProviderRuntime).toHaveBeenCalledWith(makeDiscoverResult())
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

  it("runs deterministic repair before AI diagnosis for runnable local repairs", async () => {
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "credential vault is locked",
        fixHint: "Run 'ouro vault unlock --agent slugger'.",
      },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
    })

    const result = await runAgenticRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: true, usedAgentic: false })
    expect(deps.runInteractiveRepair).toHaveBeenCalledTimes(1)
    expect(deps.discoverWorkingProvider).not.toHaveBeenCalled()
    expect(deps.createProviderRuntime).not.toHaveBeenCalled()
    expect(deps.promptInput).not.toHaveBeenCalledWith("would you like AI-assisted diagnosis? [y/n] ")
  })

  it("does not repeat deterministic repair after offering AI diagnosis for a declined local repair", async () => {
    const mockStreamTurn = vi.fn(async () => ({
      content: "The vault is locked. Unlock it before retrying.",
      toolCalls: [],
      outputItems: [],
    }))
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "missing credentials for provider",
        fixHint: "Run 'ouro auth --agent slugger'.",
      },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      createProviderRuntime: vi.fn(() => ({
        streamTurn: mockStreamTurn,
      })),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    })

    const result = await runAgenticRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false, usedAgentic: true })
    expect(deps.runInteractiveRepair).toHaveBeenCalledTimes(1)
    expect(mockStreamTurn).toHaveBeenCalled()
    const repairOrder = (deps.runInteractiveRepair as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const promptOrder = (deps.promptInput as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(repairOrder).toBeLessThan(promptOrder)
  })

  it("does not repeat deterministic repair when a declined local repair has no diagnosis provider", async () => {
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "credential vault is locked",
        fixHint: "Run 'ouro vault unlock --agent slugger'.",
      },
    ]
    const deps = makeDeps({
      discoverWorkingProvider: vi.fn(async () => null),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    })

    const result = await runAgenticRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false, usedAgentic: false })
    expect(deps.runInteractiveRepair).toHaveBeenCalledTimes(1)
    expect(deps.promptInput).not.toHaveBeenCalled()
  })

  it("does not repeat deterministic repair when local repair and AI diagnosis are both declined", async () => {
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "missing credentials for provider",
        fixHint: "Run 'ouro auth --agent slugger'.",
      },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    })

    const result = await runAgenticRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false, usedAgentic: false })
    expect(deps.runInteractiveRepair).toHaveBeenCalledTimes(1)
    expect(deps.createProviderRuntime).not.toHaveBeenCalled()
  })

  it("falls back to deterministic repair when discoverWorkingProvider throws", async () => {
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "config parse error", fixHint: "check agent.json" },
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
      { agent: "slugger", errorReason: "config parse error", fixHint: "check agent.json" },
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

  it("treats whitespace-padded yes as acceptance of agentic diagnosis", async () => {
    const mockStreamTurn = vi.fn(async () => ({
      content: "This looks like a config issue.",
      toolCalls: [],
      outputItems: [],
    }))
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "config parse error", fixHint: "check agent.json" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => " yes "),
      createProviderRuntime: vi.fn(() => ({
        streamTurn: mockStreamTurn,
      })),
    })

    const result = await runAgenticRepair(degraded, deps)

    expect(result.usedAgentic).toBe(true)
    expect(mockStreamTurn).toHaveBeenCalled()
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

  it("does not display diagnosis header when LLM returns empty content", async () => {
    const mockStreamTurn = vi.fn(async () => ({
      content: "",
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
    })
    const result = await runAgenticRepair(degraded, deps)
    expect(result.usedAgentic).toBe(true)
    // Should NOT display the diagnosis header/footer when content is empty
    const writeStdoutMock = deps.writeStdout as ReturnType<typeof vi.fn>
    const calls = writeStdoutMock.mock.calls.map((c: [string]) => c[0])
    expect(calls).not.toContain("--- AI Diagnosis ---")
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("uses default runAuthFlow fallback when not provided in deps", async () => {
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]
    // Explicitly set runAuthFlow to undefined to trigger the ?? fallback
    const deps: AgenticRepairDeps = {
      discoverWorkingProvider: vi.fn(async () => null),
      runInteractiveRepair: vi.fn(async (_degraded, repairDeps) => {
        // Verify that a runAuthFlow function was provided even though we didn't inject one
        expect(typeof repairDeps.runAuthFlow).toBe("function")
        return { repairsAttempted: false }
      }),
      promptInput: vi.fn(async () => "n"),
      writeStdout: vi.fn(),
      createProviderRuntime: vi.fn(() => ({
        streamTurn: vi.fn(async () => ({ content: "", toolCalls: [], outputItems: [] })),
      })),
      readDaemonLogsTail: vi.fn(() => ""),
      runAuthFlow: undefined,
    }
    const result = await runAgenticRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false, usedAgentic: false })
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("creates diagnosis runtimes from explicit discovered config and model hints", () => {
    mockCreateProviderRuntimeForConfig.mockClear()

    createAgenticDiagnosisProviderRuntime({
      provider: "minimax",
      credentials: { apiKey: "mm-key" },
      providerConfig: { model: "MiniMax-M2.5" },
    })

    expect(mockCreateProviderRuntimeForConfig).toHaveBeenCalledWith("minimax", {
      model: "MiniMax-M2.5",
      apiKey: "mm-key",
    }, {
      model: "MiniMax-M2.5",
    })
  })

  it("lets the shared provider runtime factory choose the default model when discovery has no model hint", () => {
    mockCreateProviderRuntimeForConfig.mockClear()

    createAgenticDiagnosisProviderRuntime({
      provider: "minimax",
      credentials: { apiKey: "mm-key" },
      providerConfig: {},
    })

    expect(mockCreateProviderRuntimeForConfig).toHaveBeenCalledWith("minimax", {
      apiKey: "mm-key",
    }, {
      model: undefined,
    })
  })
})
