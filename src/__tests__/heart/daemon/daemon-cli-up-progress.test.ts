import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
  pruneStaleEphemeralBundles: vi.fn(() => [] as string[]),
  upProgressStartPhase: vi.fn(),
  upProgressCompletePhase: vi.fn(),
  upProgressEnd: vi.fn(),
  upProgressRender: vi.fn(() => ""),
  UpProgressConstructor: vi.fn(),
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
  pollDaemonStartup: vi.fn(async () => ({ stable: [], degraded: [] })),
}))

vi.mock("../../../heart/daemon/up-progress", () => ({
  UpProgress: class MockUpProgress {
    constructor(...args: any[]) {
      mocks.UpProgressConstructor(...args)
    }
    startPhase = mocks.upProgressStartPhase
    completePhase = mocks.upProgressCompletePhase
    end = mocks.upProgressEnd
    render = mocks.upProgressRender
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

describe("ouro up: UpProgress integration", () => {
  it("emits at least one nerves event", () => {
    emitNervesEvent({ component: "daemon", event: "daemon.cli_up_progress_test", message: "testing up progress" })
  })

  it("creates an UpProgress instance during daemon.up", async () => {
    mocks.UpProgressConstructor.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.UpProgressConstructor).toHaveBeenCalled()
  })

  it("calls startPhase('update check') before update check", async () => {
    mocks.upProgressStartPhase.mockClear()
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressStartPhase).toHaveBeenCalledWith("update check")
  })

  it("calls completePhase('update check', 'up to date') when no update available", async () => {
    mocks.upProgressCompletePhase.mockClear()
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith("update check", "up to date")
  })

  it("calls completePhase with version when update is installed", async () => {
    mocks.upProgressCompletePhase.mockClear()
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    // end() must be called before re-exec
    mocks.upProgressEnd.mockClear()
    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "update check",
      expect.stringContaining("0.1.0-alpha.90"),
    )
    expect(mocks.upProgressEnd).toHaveBeenCalled()
  })

  it("calls startPhase('system setup') for system setup phase", async () => {
    mocks.upProgressStartPhase.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressStartPhase).toHaveBeenCalledWith("system setup")
  })

  it("calls completePhase('system setup') after system setup", async () => {
    mocks.upProgressCompletePhase.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith("system setup")
  })

  it("calls startPhase('starting daemon') for daemon start", async () => {
    mocks.upProgressStartPhase.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressStartPhase).toHaveBeenCalledWith("starting daemon")
  })

  it("calls end() before pollDaemonStartup takes over", async () => {
    mocks.upProgressEnd.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressEnd).toHaveBeenCalled()
  })

  it("calls end() before re-exec", async () => {
    mocks.upProgressEnd.mockClear()
    const endCallOrder: string[] = []
    mocks.upProgressEnd.mockImplementation(() => endCallOrder.push("end"))
    const reExec = vi.fn(() => {
      endCallOrder.push("reexec")
      throw new Error("__REEXEC__")
    }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(endCallOrder.indexOf("end")).toBeLessThan(endCallOrder.indexOf("reexec"))
  })

  it("calls end() before repair prompts (--no-repair path)", async () => {
    mocks.upProgressEnd.mockClear()
    const deps = makeDeps({
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      startDaemonProcess: vi.fn(async () => ({ pid: 123 })),
    })

    // Make pollDaemonStartup return degraded agents
    const { pollDaemonStartup } = await import("../../../heart/daemon/startup-tui")
    vi.mocked(pollDaemonStartup).mockResolvedValueOnce({
      stable: [],
      degraded: [{ agent: "test", errorReason: "bad", fixHint: "fix it" }],
    })

    await runOuroCli(["up", "--no-repair"], deps)

    expect(mocks.upProgressEnd).toHaveBeenCalled()
  })

  it("reports pruned bundles via completePhase", async () => {
    mocks.upProgressCompletePhase.mockClear()
    mocks.pruneStaleEphemeralBundles.mockReturnValueOnce(["stale.ouro", "dead.ouro"])
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "bundle cleanup",
      expect.stringContaining("2"),
    )
  })

  it("reports agent updates via completePhase", async () => {
    mocks.upProgressCompletePhase.mockClear()
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "alpha", from: "0.1.0-alpha.80", to: "0.1.0-alpha.90" },
        { agent: "beta", from: "0.1.0-alpha.80", to: "0.1.0-alpha.90" },
      ],
    })
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "agent updates",
      expect.stringContaining("2"),
    )
  })

  it("progress phases appear in correct order", async () => {
    const phaseOrder: string[] = []
    mocks.upProgressStartPhase.mockImplementation((label: string) => phaseOrder.push(`start:${label}`))
    mocks.upProgressCompletePhase.mockImplementation((label: string) => phaseOrder.push(`complete:${label}`))
    mocks.upProgressEnd.mockImplementation(() => phaseOrder.push("end"))

    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    const updateCheckStart = phaseOrder.indexOf("start:update check")
    const updateCheckComplete = phaseOrder.indexOf("complete:update check")
    const systemSetupStart = phaseOrder.indexOf("start:system setup")
    const daemonStart = phaseOrder.indexOf("start:starting daemon")
    const end = phaseOrder.indexOf("end")

    expect(updateCheckStart).toBeGreaterThanOrEqual(0)
    expect(updateCheckComplete).toBeGreaterThan(updateCheckStart)
    expect(systemSetupStart).toBeGreaterThan(updateCheckComplete)
    expect(daemonStart).toBeGreaterThan(systemSetupStart)
    expect(end).toBeGreaterThan(daemonStart)
  })

  it("does not call writeStdout for progress messages (checking/starting/up to date)", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
    expect(calls).not.toContain("checking for updates...")
    expect(calls).not.toContain("up to date.")
    expect(calls).not.toContain("starting daemon...")
  })
})
