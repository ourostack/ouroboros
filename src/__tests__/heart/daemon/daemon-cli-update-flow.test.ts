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

describe("ouro up: CLI update flow", () => {
  it("installs and activates newer version, then re-execs", async () => {
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(deps.installCliVersion).toHaveBeenCalledWith("0.1.0-alpha.90")
    expect(deps.activateCliVersion).toHaveBeenCalledWith("0.1.0-alpha.90")
    expect(deps.writeStdout).toHaveBeenCalledWith("ouro updated to 0.1.0-alpha.90 (was 0.1.0-alpha.80)")
    expect(deps.reExecFromNewVersion).toHaveBeenCalledWith(["up"])
  })

  it("does not install when registry returns same version", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false, latestVersion: "0.1.0-alpha.80" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: vi.fn() as unknown as (args: string[]) => never,
    })

    await runOuroCli(["up"], deps)

    expect(deps.installCliVersion).not.toHaveBeenCalled()
    expect(deps.activateCliVersion).not.toHaveBeenCalled()
    expect(deps.reExecFromNewVersion).not.toHaveBeenCalled()
  })

  it("logs warning and proceeds when registry fetch fails", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false, error: "network timeout" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: vi.fn() as unknown as (args: string[]) => never,
    })

    // Should not throw — proceeds to start daemon normally
    await runOuroCli(["up"], deps)

    expect(deps.installCliVersion).not.toHaveBeenCalled()
    // Daemon should still start
    expect(deps.startDaemonProcess).toHaveBeenCalled()
  })

  it("skips update check entirely when checkForCliUpdate is not provided", async () => {
    const deps = makeDeps({
      // No checkForCliUpdate — should skip update flow
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
    })

    await runOuroCli(["up"], deps)

    expect(deps.installCliVersion).not.toHaveBeenCalled()
    expect(deps.activateCliVersion).not.toHaveBeenCalled()
    // Daemon should still start
    expect(deps.startDaemonProcess).toHaveBeenCalled()
  })

  it("re-execs with original args after update", async () => {
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    // reExec called with ["up"] — the original args
    expect(reExec).toHaveBeenCalledWith(["up"])
  })

  it("prints a changelog follow-up command when a newer version is installed", async () => {
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(deps.writeStdout).toHaveBeenCalledWith("review changes with: ouro changelog --from 0.1.0-alpha.80")
  })
})
