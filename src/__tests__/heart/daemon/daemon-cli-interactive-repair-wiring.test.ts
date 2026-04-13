/**
 * Tests for the interactive repair wiring in the daemon.up handler (cli-exec.ts).
 *
 * Verifies that runInteractiveRepair is called when degraded agents are
 * present and that the wired runAuthFlow closure correctly reads agent
 * config and delegates to deps.runAuthFlow.
 */
import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
  pruneStaleEphemeralBundles: vi.fn(() => [] as string[]),
  pollDaemonStartup: vi.fn(async () => ({ stable: [] as string[], degraded: [] as any[] })),
  runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
  checkAgentConfigWithProviderHealth: vi.fn(async () => ({ ok: true }) as const),
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

vi.mock("../../../heart/daemon/agent-config-check", () => ({
  checkAgentConfigWithProviderHealth: (...a: any[]) => mocks.checkAgentConfigWithProviderHealth(...a),
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
import { mergeStartupStability } from "../../../heart/daemon/cli-exec"
import { getRuntimeMetadata } from "../../../heart/daemon/runtime-metadata"

function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(async () => ({ pid: 123 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    secretsRoot: "/tmp/ouro-test-empty-provider-secrets",
    ...overrides,
  }
}

function currentRuntimeOverview(): Record<string, string> {
  const runtime = getRuntimeMetadata()
  return {
    version: runtime.version,
    lastUpdated: runtime.lastUpdated,
    repoRoot: runtime.repoRoot,
    configFingerprint: runtime.configFingerprint,
  }
}

describe("ouro up: interactive repair wiring", () => {
  it("removes newly degraded agents from the stable startup list", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.merge_startup_stability_test",
      message: "test",
    })

    const result = mergeStartupStability(
      {
        stable: ["healthy-agent", "test-agent"],
        degraded: [{
          agent: "old-agent",
          errorReason: "already degraded",
          fixHint: "Check old-agent logs.",
        }],
      },
      [{
        agent: "test-agent",
        errorReason: "provider failed",
        fixHint: "Run 'ouro auth --agent test-agent --provider anthropic'.",
      }],
    )

    expect(result).toEqual({
      stable: ["healthy-agent"],
      degraded: [{
        agent: "old-agent",
        errorReason: "already degraded",
        fixHint: "Check old-agent logs.",
      }, {
        agent: "test-agent",
        errorReason: "provider failed",
        fixHint: "Run 'ouro auth --agent test-agent --provider anthropic'.",
      }],
    })
  })

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

  it("wires runAuthFlow closure that can repair the provider named by a degraded facing", async () => {
    const degraded = [
      {
        agent: "test-agent",
        errorReason: "selected provider github-copilot for agentFacing failed health check: token expired",
        fixHint: "Run 'ouro auth --agent test-agent --provider github-copilot' to refresh credentials.",
      },
    ]
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: [], degraded })
    mocks.readAgentConfigForAgent.mockReturnValue({
      config: {
        humanFacing: { provider: "anthropic" },
        agentFacing: { provider: "github-copilot" },
      },
    })

    // Capture the runAuthFlow closure so we can invoke it
    let capturedRunAuthFlow: ((agent: string, provider?: string) => Promise<void>) | undefined
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
    await capturedRunAuthFlow!("test-agent", "github-copilot")
    await capturedRunAuthFlow!("test-agent")

    expect(mocks.readAgentConfigForAgent).toHaveBeenCalledWith("test-agent", "/tmp/bundles")
    expect(injectedRunAuthFlow).toHaveBeenCalledWith({
      agentName: "test-agent",
      provider: "github-copilot",
      promptInput: deps.promptInput,
    })
    expect(injectedRunAuthFlow).toHaveBeenCalledWith({
      agentName: "test-agent",
      provider: "anthropic",
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

  it("checks selected providers even when ouro up finds the daemon already running", async () => {
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["test-agent", "healthy-agent"], degraded: [] })
    mocks.checkAgentConfigWithProviderHealth.mockResolvedValueOnce({
      ok: false,
      error: "selected provider github-copilot for agentFacing failed health check: token expired",
      fix: "Run 'ouro auth --agent test-agent --provider github-copilot' to refresh credentials.",
    })
    mocks.runInteractiveRepair.mockClear()

    const deps = makeDeps({
      checkSocketAlive: vi.fn(async () => true),
      sendCommand: vi.fn(async () => ({
        ok: true,
        data: {
          overview: currentRuntimeOverview(),
        },
      })),
      listDiscoveredAgents: vi.fn(() => ["test-agent"]),
      promptInput: vi.fn(async () => "n"),
      bundlesRoot: "/tmp/bundles",
      secretsRoot: "/tmp/secrets",
    })

    await runOuroCli(["up"], deps)

    expect(mocks.checkAgentConfigWithProviderHealth).toHaveBeenCalledWith("test-agent", "/tmp/bundles", "/tmp/secrets")
    expect(mocks.runInteractiveRepair).toHaveBeenCalledWith(
      [{
        agent: "test-agent",
        errorReason: "selected provider github-copilot for agentFacing failed health check: token expired",
        fixHint: "Run 'ouro auth --agent test-agent --provider github-copilot' to refresh credentials.",
      }],
      expect.anything(),
    )
  })

  it("keeps already-running daemons healthy when selected provider checks pass", async () => {
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["healthy-agent"], degraded: [] })
    mocks.checkAgentConfigWithProviderHealth.mockResolvedValueOnce({ ok: true })
    mocks.runInteractiveRepair.mockClear()

    const deps = makeDeps({
      checkSocketAlive: vi.fn(async () => true),
      sendCommand: vi.fn(async () => ({
        ok: true,
        data: {
          overview: currentRuntimeOverview(),
        },
      })),
      listDiscoveredAgents: vi.fn(() => ["healthy-agent"]),
      promptInput: vi.fn(async () => "n"),
      bundlesRoot: "/tmp/bundles",
      secretsRoot: "/tmp/secrets",
    })

    await runOuroCli(["up"], deps)

    expect(mocks.checkAgentConfigWithProviderHealth).toHaveBeenCalledWith("healthy-agent", "/tmp/bundles", "/tmp/secrets")
    expect(mocks.runInteractiveRepair).not.toHaveBeenCalled()
  })

  it("reports provider-check exceptions for already-running daemons", async () => {
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["test-agent"], degraded: [] })
    mocks.checkAgentConfigWithProviderHealth.mockRejectedValueOnce(new Error("config check exploded"))
    mocks.runInteractiveRepair.mockClear()

    const writeStdout = vi.fn()
    const deps = makeDeps({
      checkSocketAlive: vi.fn(async () => true),
      sendCommand: vi.fn(async () => ({
        ok: true,
        data: {
          overview: currentRuntimeOverview(),
        },
      })),
      listDiscoveredAgents: vi.fn(() => ["test-agent"]),
      writeStdout,
      promptInput: vi.fn(async () => "n"),
    })

    await runOuroCli(["up", "--no-repair"], deps)

    const output = writeStdout.mock.calls.map((call: any[]) => call[0]).join("\n")
    expect(output).toContain("test-agent: config check exploded")
    expect(output).toContain("fix: Run 'ouro doctor' for diagnostics, then retry 'ouro up'.")
    expect(mocks.runInteractiveRepair).not.toHaveBeenCalled()
  })

  it("uses generic degraded details when provider checks fail without an error or fix", async () => {
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["test-agent"], degraded: [] })
    mocks.checkAgentConfigWithProviderHealth.mockResolvedValueOnce({ ok: false })
    mocks.runInteractiveRepair.mockClear()

    const writeStdout = vi.fn()
    const deps = makeDeps({
      checkSocketAlive: vi.fn(async () => true),
      sendCommand: vi.fn(async () => ({
        ok: true,
        data: {
          overview: currentRuntimeOverview(),
        },
      })),
      listDiscoveredAgents: vi.fn(() => ["test-agent"]),
      writeStdout,
      promptInput: vi.fn(async () => "n"),
    })

    await runOuroCli(["up", "--no-repair"], deps)

    const output = writeStdout.mock.calls.map((call: any[]) => call[0]).join("\n")
    expect(output).toContain("test-agent: agent provider health check failed")
    expect(mocks.runInteractiveRepair).not.toHaveBeenCalled()
  })

  it("stringifies non-Error provider-check exceptions for already-running daemons", async () => {
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["test-agent"], degraded: [] })
    mocks.checkAgentConfigWithProviderHealth.mockRejectedValueOnce("string failure")
    mocks.runInteractiveRepair.mockClear()

    const writeStdout = vi.fn()
    const deps = makeDeps({
      checkSocketAlive: vi.fn(async () => true),
      sendCommand: vi.fn(async () => ({
        ok: true,
        data: {
          overview: currentRuntimeOverview(),
        },
      })),
      listDiscoveredAgents: vi.fn(() => ["test-agent"]),
      writeStdout,
      promptInput: vi.fn(async () => "n"),
    })

    await runOuroCli(["up", "--no-repair"], deps)

    const output = writeStdout.mock.calls.map((call: any[]) => call[0]).join("\n")
    expect(output).toContain("test-agent: string failure")
    expect(output).toContain("fix: Run 'ouro doctor' for diagnostics, then retry 'ouro up'.")
    expect(mocks.runInteractiveRepair).not.toHaveBeenCalled()
  })
})
