import { describe, expect, it, vi } from "vitest"

import {
  failFastContainerCredentialBootstrapStartup,
  startDaemonAfterContainerCredentialBootstrap,
} from "../../../heart/daemon/daemon-bootstrap-startup"

describe("daemon container credential bootstrap startup boundary", () => {
  it("awaits successful credential migration before starting the daemon", async () => {
    let releaseBootstrap!: () => void
    const loadBootstrap = vi.fn(() => new Promise<void>((resolve) => { releaseBootstrap = resolve }))
    const startDaemon = vi.fn(async () => undefined)
    const onBootstrapRejected = vi.fn()

    const startup = startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap,
      startDaemon,
      onBootstrapRejected,
    })
    await Promise.resolve()
    expect(startDaemon).not.toHaveBeenCalled()

    releaseBootstrap()
    await expect(startup).resolves.toBe(true)
    expect(startDaemon).toHaveBeenCalledTimes(1)
    expect(onBootstrapRejected).not.toHaveBeenCalled()
  })

  it("terminates the startup branch without starting or forwarding a raw bootstrap rejection", async () => {
    const loadBootstrap = vi.fn(async () => { throw new Error("secret-bearing rejection") })
    const startDaemon = vi.fn(async () => undefined)
    const onBootstrapRejected = vi.fn()

    await expect(startDaemonAfterContainerCredentialBootstrap({
      loadBootstrap,
      startDaemon,
      onBootstrapRejected,
    })).resolves.toBe(false)
    expect(onBootstrapRejected).toHaveBeenCalledWith()
    expect(startDaemon).not.toHaveBeenCalled()
  })

  it("writes only a fixed redacted startup failure and exits PID 1 nonzero immediately", () => {
    const calls: string[] = []
    const writeTombstone = vi.fn((reason: string, error: Error) => {
      calls.push(`tombstone:${reason}:${error.message}`)
    })
    const emit = vi.fn((event: unknown) => {
      calls.push(`event:${JSON.stringify(event)}`)
    })
    const exit = vi.fn((code: number) => { calls.push(`exit:${code}`) })

    failFastContainerCredentialBootstrapStartup({ writeTombstone, emit, exit })

    expect(writeTombstone).toHaveBeenCalledWith(
      "startupFailure",
      expect.objectContaining({
        message: "container credential bootstrap rejected; recoverable claim retained for reconciliation",
      }),
    )
    expect(emit).toHaveBeenCalledWith({
      level: "error",
      component: "daemon",
      event: "daemon.entry_error",
      message: "daemon entrypoint failed before server startup",
      meta: {
        error: "container credential bootstrap rejected; recoverable claim retained for reconciliation",
      },
    })
    expect(exit).toHaveBeenCalledWith(1)
    expect(calls.map((call) => call.split(":", 1)[0])).toEqual(["tombstone", "event", "exit"])
    expect(JSON.stringify(calls)).not.toContain("secret-bearing rejection")
  })

  it("still exits nonzero when tombstone or event reporting fails", () => {
    const exitAfterTombstoneFailure = vi.fn()
    failFastContainerCredentialBootstrapStartup({
      writeTombstone: () => { throw new Error("disk unavailable") },
      emit: vi.fn(),
      exit: exitAfterTombstoneFailure,
    })
    expect(exitAfterTombstoneFailure).toHaveBeenCalledWith(1)

    const exitAfterEventFailure = vi.fn()
    failFastContainerCredentialBootstrapStartup({
      writeTombstone: vi.fn(),
      emit: () => { throw new Error("logger unavailable") },
      exit: exitAfterEventFailure,
    })
    expect(exitAfterEventFailure).toHaveBeenCalledWith(1)
  })
})
