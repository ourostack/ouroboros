import { describe, expect, it, vi } from "vitest"

const startupMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  writeTombstone: vi.fn(),
}))

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: startupMocks.emit }))
vi.mock("../../../heart/daemon/daemon-tombstone", () => ({
  writeDaemonTombstone: startupMocks.writeTombstone,
}))

import {
  createProviderReadinessPreparationFailure,
  createSanctuaryBundlePreparationFailure,
  failFastContainerCredentialBootstrapStartup,
  failFastSanctuaryBundlePreparationStartup,
  startDaemonAfterContainerCredentialBootstrap,
} from "../../../heart/daemon/daemon-bootstrap-startup"

describe("daemon container credential bootstrap startup boundary", () => {
  it("runs package preflight, credential migration, bundle ensure, and provider preparation in order before starting", async () => {
    const preflight = vi.fn(async () => undefined)
    let releaseBootstrap!: () => void
    let releaseBundle!: () => void
    let releasePreparation!: () => void
    const loadBootstrap = vi.fn(() => new Promise<void>((resolve) => { releaseBootstrap = resolve }))
    const prepareManagedBundle = vi.fn(() => new Promise<void>((resolve) => { releaseBundle = resolve }))
    const prepareDaemon = vi.fn(() => new Promise<void>((resolve) => { releasePreparation = resolve }))
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    const startup = startDaemonAfterContainerCredentialBootstrap({
      preflight,
      loadBootstrap,
      prepareManagedBundle,
      prepareDaemon,
      startDaemon,
      markStartupFailure,
      exit,
    })
    await Promise.resolve()
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(loadBootstrap).toHaveBeenCalledTimes(1)
    expect(startDaemon).not.toHaveBeenCalled()

    releaseBootstrap()
    await Promise.resolve()
    expect(prepareManagedBundle).toHaveBeenCalledTimes(1)
    expect(prepareDaemon).not.toHaveBeenCalled()
    expect(startDaemon).not.toHaveBeenCalled()

    releaseBundle()
    await Promise.resolve()
    expect(prepareDaemon).toHaveBeenCalledTimes(1)
    expect(startDaemon).not.toHaveBeenCalled()

    releasePreparation()
    await expect(startup).resolves.toBe(true)
    expect(startDaemon).toHaveBeenCalledTimes(1)
    expect(markStartupFailure).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(preflight.mock.invocationCallOrder[0]).toBeLessThan(loadBootstrap.mock.invocationCallOrder[0]!)
    expect(loadBootstrap.mock.invocationCallOrder[0]).toBeLessThan(prepareDaemon.mock.invocationCallOrder[0]!)
    expect(loadBootstrap.mock.invocationCallOrder[0]).toBeLessThan(prepareManagedBundle.mock.invocationCallOrder[0]!)
    expect(prepareManagedBundle.mock.invocationCallOrder[0]).toBeLessThan(prepareDaemon.mock.invocationCallOrder[0]!)
    expect(prepareDaemon.mock.invocationCallOrder[0]).toBeLessThan(startDaemon.mock.invocationCallOrder[0]!)
  })

  it("fails before credential bootstrap when package preflight is invalid", async () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const loadBootstrap = vi.fn(async () => undefined)
    const prepareManagedBundle = vi.fn(async () => undefined)
    const prepareDaemon = vi.fn(async () => undefined)
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      preflight: vi.fn(() => { throw createSanctuaryBundlePreparationFailure("roll_back_or_install_verified_release") }),
      loadBootstrap,
      prepareManagedBundle,
      prepareDaemon,
      startDaemon,
      markStartupFailure,
      exit,
    })).resolves.toBe(false)

    expect(markStartupFailure).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
    expect(loadBootstrap).not.toHaveBeenCalled()
    expect(prepareManagedBundle).not.toHaveBeenCalled()
    expect(prepareDaemon).not.toHaveBeenCalled()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(startupMocks.writeTombstone).toHaveBeenCalledWith("startupFailurePublic", expect.objectContaining({ message: "Sanctuary installation needs attention\n  human-required: roll_back_or_install_verified_release" }))
  })

  it("classifies bundle ensure failure separately and stops before provider preparation", async () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const prepareDaemon = vi.fn(async () => undefined)
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      preflight: vi.fn(),
      loadBootstrap: vi.fn(async () => undefined),
      prepareManagedBundle: vi.fn(async () => { throw createSanctuaryBundlePreparationFailure("run_verified_update_recovery") }),
      prepareDaemon,
      startDaemon,
      markStartupFailure,
      exit,
    })).resolves.toBe(false)

    expect(markStartupFailure).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(prepareDaemon).not.toHaveBeenCalled()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(startupMocks.emit).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.entry_error",
      message: "Sanctuary installation needs attention\n  human-required: run_verified_update_recovery",
    }))
  })

  it("terminates the startup branch without starting or forwarding a raw bootstrap rejection", async () => {
    const loadBootstrap = vi.fn(async () => { throw new Error("secret-bearing rejection") })
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap,
      startDaemon,
      markStartupFailure,
      exit,
    })).resolves.toBe(false)
    expect(markStartupFailure).toHaveBeenCalledWith()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("secret-bearing rejection")
    expect(JSON.stringify(startupMocks.emit.mock.calls)).not.toContain("secret-bearing rejection")
  })

  it("fails closed and redacts daemon preparation failures before startup", async () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap: vi.fn(async () => undefined),
      prepareDaemon: vi.fn(async () => { throw new Error("raw provider token and vault failure") }),
      startDaemon,
      markStartupFailure,
      exit,
    })).resolves.toBe(false)

    expect(markStartupFailure).toHaveBeenCalledTimes(1)
    expect(startDaemon).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
    expect(startupMocks.writeTombstone).toHaveBeenCalledWith(
      "startupFailurePublic",
      expect.objectContaining({
        message: "provider runtime preparation failed before startup; run `ouro doctor` for diagnosis",
      }),
    )
    expect(startupMocks.emit).toHaveBeenCalledWith(expect.objectContaining({
      message: "provider runtime preparation failed before startup; run `ouro doctor` for diagnosis",
    }))
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("raw provider token")
    expect(JSON.stringify(startupMocks.emit.mock.calls)).not.toContain("raw provider token")
  })

  it("surfaces only controlled daemon preparation guidance before startup", async () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const publicMessage = "Provider checks need attention\nslugger: outward provider minimax / MiniMax-M2.5 failed live check\n  human-choice: ouro auth --agent slugger --provider minimax"
    const exit = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap: vi.fn(async () => undefined),
      prepareDaemon: vi.fn(async () => {
        throw createProviderReadinessPreparationFailure([{
          summary: "slugger: outward provider minimax / MiniMax-M2.5 failed live check",
          actions: [{ actor: "human-choice", command: "ouro auth --agent slugger --provider minimax" }],
        }])
      }),
      startDaemon: vi.fn(async () => undefined),
      markStartupFailure: vi.fn(),
      exit,
    })).resolves.toBe(false)

    expect(startupMocks.writeTombstone).toHaveBeenCalledWith(
      "startupFailurePublic",
      expect.objectContaining({ message: publicMessage }),
    )
    expect(startupMocks.emit).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.entry_error",
      message: publicMessage,
      meta: { error: publicMessage },
    }))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("writes only a fixed redacted startup failure and exits PID 1 nonzero immediately", () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const exit = vi.fn()

    failFastContainerCredentialBootstrapStartup({ exit })

    expect(startupMocks.writeTombstone).toHaveBeenCalledWith(
      "startupFailurePublic",
      expect.objectContaining({
        message: "container credential bootstrap rejected; recoverable claim retained for reconciliation",
      }),
    )
    expect(startupMocks.emit).toHaveBeenCalledWith({
      level: "error",
      component: "daemon",
      event: "daemon.entry_error",
      message: "daemon entrypoint failed before server startup",
      meta: {
        error: "container credential bootstrap rejected; recoverable claim retained for reconciliation",
      },
    })
    expect(exit).toHaveBeenCalledWith(1)
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("secret-bearing rejection")
    expect(JSON.stringify(startupMocks.emit.mock.calls)).not.toContain("secret-bearing rejection")
  })

  it("reports only controlled or fixed Sanctuary preparation guidance", () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const controlledExit = vi.fn()
    failFastSanctuaryBundlePreparationStartup({ failure: createSanctuaryBundlePreparationFailure("roll_back_or_install_verified_release"), exit: controlledExit })
    expect(startupMocks.writeTombstone).toHaveBeenLastCalledWith("startupFailurePublic", expect.objectContaining({ message: "Sanctuary installation needs attention\n  human-required: roll_back_or_install_verified_release" }))
    expect(controlledExit).toHaveBeenCalledWith(1)

    const redactedExit = vi.fn()
    failFastSanctuaryBundlePreparationStartup({ failure: new Error("secret raw path"), exit: redactedExit })
    expect(startupMocks.writeTombstone).toHaveBeenLastCalledWith("startupFailurePublic", expect.objectContaining({ message: "Sanctuary installation needs attention\n  human-required: run_verified_update_recovery" }))
    expect(JSON.stringify(startupMocks.writeTombstone.mock.calls)).not.toContain("secret raw path")
    expect(redactedExit).toHaveBeenCalledWith(1)
  })

  it("still exits nonzero when tombstone or event reporting fails", () => {
    const exitAfterTombstoneFailure = vi.fn()
    startupMocks.writeTombstone.mockImplementationOnce(() => { throw new Error("disk unavailable") })
    failFastContainerCredentialBootstrapStartup({
      exit: exitAfterTombstoneFailure,
    })
    expect(exitAfterTombstoneFailure).toHaveBeenCalledWith(1)

    const exitAfterEventFailure = vi.fn()
    startupMocks.emit.mockImplementationOnce(() => { throw new Error("logger unavailable") })
    failFastContainerCredentialBootstrapStartup({
      exit: exitAfterEventFailure,
    })
    expect(exitAfterEventFailure).toHaveBeenCalledWith(1)
  })
})
