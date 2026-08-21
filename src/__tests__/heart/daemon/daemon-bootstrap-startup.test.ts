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
  failFastContainerCredentialBootstrapStartup,
  startDaemonAfterContainerCredentialBootstrap,
} from "../../../heart/daemon/daemon-bootstrap-startup"

describe("daemon container credential bootstrap startup boundary", () => {
  it("awaits successful credential migration before starting the daemon", async () => {
    let releaseBootstrap!: () => void
    const loadBootstrap = vi.fn(() => new Promise<void>((resolve) => { releaseBootstrap = resolve }))
    const startDaemon = vi.fn(async () => undefined)
    const markStartupFailure = vi.fn()
    const exit = vi.fn()

    const startup = startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap,
      startDaemon,
      markStartupFailure,
      exit,
    })
    await Promise.resolve()
    expect(startDaemon).not.toHaveBeenCalled()

    releaseBootstrap()
    await expect(startup).resolves.toBe(true)
    expect(startDaemon).toHaveBeenCalledTimes(1)
    expect(markStartupFailure).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
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

  it("writes only a fixed redacted startup failure and exits PID 1 nonzero immediately", () => {
    startupMocks.writeTombstone.mockClear()
    startupMocks.emit.mockClear()
    const exit = vi.fn()

    failFastContainerCredentialBootstrapStartup({ exit })

    expect(startupMocks.writeTombstone).toHaveBeenCalledWith(
      "startupFailure",
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
