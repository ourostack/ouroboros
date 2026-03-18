import { describe, expect, it, vi } from "vitest"

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
}))

vi.mock("../../../heart/daemon/update-hooks", () => ({
  applyPendingUpdates: (...a: any[]) => mocks.applyPendingUpdates(...a),
  registerUpdateHook: (...a: any[]) => mocks.registerUpdateHook(...a),
  getRegisteredHooks: vi.fn(() => []),
  clearRegisteredHooks: vi.fn(),
}))

vi.mock("../../../heart/daemon/hooks/bundle-meta", () => ({
  bundleMetaHook: vi.fn(),
}))

import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(async () => ({ pid: 123 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn(async () => false),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    ...overrides,
  }
}

describe("ouro up: update output", () => {
  it("prints consolidated summary for multiple updated agents", async () => {
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "slugger", from: "0.1.0-alpha.20", to: "0.1.0-alpha.21" },
        { agent: "codex", from: "0.1.0-alpha.20", to: "0.1.0-alpha.21" },
      ],
    })

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    expect(deps.writeStdout).toHaveBeenCalledWith("updated 2 agents to runtime 0.1.0-alpha.21 (was 0.1.0-alpha.20)")
  })

  it("prints singular for single updated agent", async () => {
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "slugger", from: "0.1.0-alpha.20", to: "0.1.0-alpha.21" },
      ],
    })

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    expect(deps.writeStdout).toHaveBeenCalledWith("updated 1 agent to runtime 0.1.0-alpha.21 (was 0.1.0-alpha.20)")
  })

  it("prints summary without 'was' for first-boot agents", async () => {
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "newbie", from: undefined, to: "0.1.0-alpha.21" },
      ],
    })

    const deps = makeDeps()
    await runOuroCli(["up"], deps)

    expect(deps.writeStdout).toHaveBeenCalledWith("updated 1 agent to runtime 0.1.0-alpha.21")
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
