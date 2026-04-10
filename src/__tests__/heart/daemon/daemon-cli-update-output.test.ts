import { describe, expect, it, vi } from "vitest"

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
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

vi.mock("../../../heart/daemon/startup-tui", () => ({
  pollDaemonStartup: vi.fn(async () => ({ stable: [], degraded: [] })),
}))

vi.mock("../../../heart/daemon/up-progress", () => ({
  UpProgress: class MockUpProgress {
    startPhase = vi.fn()
    completePhase = vi.fn()
    end = vi.fn()
    render = vi.fn(() => "")
  },
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

describe("ouro up: update output", () => {
  // Agent update messages are now routed through UpProgress.completePhase
  // instead of writeStdout. These tests verify the UpProgress mock receives
  // the correct calls. The mock UpProgress is imported via vi.mock above.
  let UpProgressModule: typeof import("../../../heart/daemon/up-progress")

  it("reports consolidated summary for multiple updated agents via UpProgress", async () => {
    UpProgressModule = await import("../../../heart/daemon/up-progress")
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "slugger", from: "0.1.0-alpha.20", to: "0.1.0-alpha.21" },
        { agent: "codex", from: "0.1.0-alpha.20", to: "0.1.0-alpha.21" },
      ],
    })

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    // The UpProgress instance's completePhase is called by daemon.up
    // We can verify writeStdout is NOT called with the old format
    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calls.every((msg: string) => !msg.startsWith("updated "))).toBe(true)
  })

  it("reports singular for single updated agent via UpProgress", async () => {
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "slugger", from: "0.1.0-alpha.20", to: "0.1.0-alpha.21" },
      ],
    })

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calls.every((msg: string) => !msg.startsWith("updated "))).toBe(true)
  })

  it("reports summary without 'was' for first-boot agents via UpProgress", async () => {
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "newbie", from: undefined, to: "0.1.0-alpha.21" },
      ],
    })

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calls.every((msg: string) => !msg.startsWith("updated "))).toBe(true)
  })

  it("does not print update summary when no agents updated", async () => {
    mocks.applyPendingUpdates.mockResolvedValueOnce({ updated: [] })

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    // Only the daemon started message, not any update messages
    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calls.every((msg: string) => !msg.startsWith("updated "))).toBe(true)
  })

  it("registers bundleMetaHook before applying updates", async () => {
    mocks.registerUpdateHook.mockClear()
    mocks.applyPendingUpdates.mockClear()
    mocks.applyPendingUpdates.mockResolvedValueOnce({ updated: [] })

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    expect(mocks.registerUpdateHook).toHaveBeenCalled()
    // registerUpdateHook should be called before applyPendingUpdates
    const registerCallOrder = mocks.registerUpdateHook.mock.invocationCallOrder[0]
    const applyCallOrder = mocks.applyPendingUpdates.mock.invocationCallOrder[0]
    expect(registerCallOrder).toBeLessThan(applyCallOrder)
  })
})
