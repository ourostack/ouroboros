/**
 * Tests for the interactive repair wiring in the daemon.up handler (cli-exec.ts).
 *
 * Verifies that runInteractiveRepair is called when degraded agents are
 * present and that the wired runAuthFlow closure correctly reads agent
 * config and delegates to deps.runAuthFlow.
 */
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
  pruneStaleEphemeralBundles: vi.fn(() => [] as string[]),
  pollDaemonStartup: vi.fn(async () => ({ stable: [] as string[], degraded: [] as any[] })),
  runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
  readAgentConfigForAgent: vi.fn(() => ({
    config: { humanFacing: { provider: "anthropic" as const } },
  })),
}))

vi.mock("../../../heart/versioning/update-hooks", () => ({
  applyPendingUpdates: (...a: any[]) => mocks.applyPendingUpdates(...a),
  registerUpdateHook: (...a: any[]) => mocks.registerUpdateHook(...a),
  getRegisteredHooks: vi.fn(() => []),
  clearRegisteredHooks: vi.fn(),
}))

vi.mock("../../../heart/daemon/hooks/bundle-meta", () => ({
  bundleMetaHook: vi.fn(),
}))

vi.mock("../../../heart/daemon/stale-bundle-prune", () => ({
  pruneStaleEphemeralBundles: (...a: any[]) => mocks.pruneStaleEphemeralBundles(...a),
}))

vi.mock("../../../heart/daemon/startup-tui", () => ({
  pollDaemonStartup: (...a: any[]) => mocks.pollDaemonStartup(...a),
}))

vi.mock("../../../heart/daemon/interactive-repair", () => ({
  runInteractiveRepair: (...a: any[]) => mocks.runInteractiveRepair(...a),
}))

vi.mock("stripe", () => ({
  default: vi.fn(),
}))

vi.mock("../../../heart/auth/auth-flow", () => ({
  readAgentConfigForAgent: (...a: any[]) => mocks.readAgentConfigForAgent(...a),
  loadAgentSecrets: vi.fn(() => ({})),
  resolveHatchCredentials: vi.fn(),
  writeAgentProviderSelection: vi.fn(),
  writeAgentModel: vi.fn(),
}))

import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(async () => ({ pid: 123 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    ...overrides,
  }
}

describe("ouro up: interactive repair wiring", () => {
  it("calls runInteractiveRepair when degraded agents are present", async () => {
    const degraded = [
      { agent: "test-agent", errorReason: "missing credentials", fixHint: "run ouro auth test-agent" },
    ]
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["healthy-agent"], degraded })
    mocks.runInteractiveRepair.mockClear()

    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
      bundlesRoot: "/tmp/bundles",
    })

    await runOuroCli(["up"], deps)

    expect(mocks.runInteractiveRepair).toHaveBeenCalledTimes(1)
    expect(mocks.runInteractiveRepair).toHaveBeenCalledWith(
      degraded,
      expect.objectContaining({
        writeStdout: deps.writeStdout,
      }),
    )
  })

  it("wires runAuthFlow closure that reads agent config and delegates to deps.runAuthFlow", async () => {
    const degraded = [
      { agent: "test-agent", errorReason: "missing credentials", fixHint: "run ouro auth test-agent" },
    ]
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: [], degraded })
    mocks.readAgentConfigForAgent.mockReturnValueOnce({
      config: { humanFacing: { provider: "azure" } },
    })

    // Capture the runAuthFlow closure so we can invoke it
    let capturedRunAuthFlow: ((agent: string) => Promise<void>) | undefined
    mocks.runInteractiveRepair.mockImplementationOnce(async (_degraded: any, repairDeps: any) => {
      capturedRunAuthFlow = repairDeps.runAuthFlow
      return { repairsAttempted: false }
    })

    const injectedRunAuthFlow = vi.fn(async () => {})
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      bundlesRoot: "/tmp/bundles",
      runAuthFlow: injectedRunAuthFlow,
    })

    await runOuroCli(["up"], deps)

    // Invoke the captured closure to cover the runAuthFlow wiring (cli-exec.ts lines 991-996)
    expect(capturedRunAuthFlow).toBeDefined()
    await capturedRunAuthFlow!("test-agent")

    expect(mocks.readAgentConfigForAgent).toHaveBeenCalledWith("test-agent", "/tmp/bundles")
    expect(injectedRunAuthFlow).toHaveBeenCalledWith({
      agentName: "test-agent",
      provider: "azure",
      promptInput: deps.promptInput,
    })
  })

  it("uses default promptInput when deps.promptInput is undefined", async () => {
    const degraded = [
      { agent: "test-agent", errorReason: "missing credentials", fixHint: "run ouro auth test-agent" },
    ]
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: [], degraded })
    mocks.runInteractiveRepair.mockClear()

    let capturedPromptInput: ((prompt: string) => Promise<string>) | undefined
    mocks.runInteractiveRepair.mockImplementationOnce(async (_degraded: any, repairDeps: any) => {
      capturedPromptInput = repairDeps.promptInput
      return { repairsAttempted: false }
    })

    const deps = makeDeps()
    // promptInput is not set — should default to async () => "n"
    delete (deps as any).promptInput

    await runOuroCli(["up"], deps)

    expect(capturedPromptInput).toBeDefined()
    const result = await capturedPromptInput!("test?")
    expect(result).toBe("n")
  })

  it("skips interactive repair when no degraded agents", async () => {
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["agent-a"], degraded: [] })
    mocks.runInteractiveRepair.mockClear()

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    expect(mocks.runInteractiveRepair).not.toHaveBeenCalled()
  })
})
