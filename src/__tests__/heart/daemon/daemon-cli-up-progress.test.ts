import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
  pruneStaleEphemeralBundles: vi.fn(() => [] as string[]),
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

describe("ouro up: progress messages", () => {
  it("prints 'checking for updates...' before update check", async () => {
    emitNervesEvent({ component: "daemon", event: "daemon.cli_up_progress_test", message: "testing up progress" })
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(deps.writeStdout).toHaveBeenCalledWith("checking for updates...")
  })

  it("prints 'installing <version>...' when update is available", async () => {
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(deps.writeStdout).toHaveBeenCalledWith("installing 0.1.0-alpha.90...")
  })

  it("prints 'up to date.' when no update available", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(deps.writeStdout).toHaveBeenCalledWith("up to date.")
  })

  it("prints 'starting daemon...' before starting the daemon", async () => {
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(deps.writeStdout).toHaveBeenCalledWith("starting daemon...")
  })

  it("prints pruned stale bundle names", async () => {
    mocks.pruneStaleEphemeralBundles.mockReturnValueOnce(["stale.ouro", "dead.ouro"])
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(deps.writeStdout).toHaveBeenCalledWith("pruned stale bundle: stale.ouro")
    expect(deps.writeStdout).toHaveBeenCalledWith("pruned stale bundle: dead.ouro")
  })

  it("progress messages appear in correct order", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
    const checkingIdx = calls.indexOf("checking for updates...")
    const upToDateIdx = calls.indexOf("up to date.")
    const startingIdx = calls.indexOf("starting daemon...")

    expect(checkingIdx).toBeGreaterThanOrEqual(0)
    expect(upToDateIdx).toBeGreaterThanOrEqual(0)
    expect(startingIdx).toBeGreaterThanOrEqual(0)
    expect(checkingIdx).toBeLessThan(upToDateIdx)
    expect(upToDateIdx).toBeLessThan(startingIdx)
  })
})
