import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  sendDaemonCommand: vi.fn(async () => ({ ok: true, summary: "ok" })),
}))

vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
  DEFAULT_DAEMON_COMMAND_TIMEOUT_MS: 600_000,
  DEFAULT_DAEMON_STATUS_TIMEOUT_MS: 5_000,
  sendDaemonCommand: (...args: unknown[]) => mocks.sendDaemonCommand(...args),
  checkDaemonSocketAlive: vi.fn(async () => false),
}))

describe("default daemon command timeout policy", () => {
  beforeEach(() => mocks.sendDaemonCommand.mockClear())

  it("bounds daemon.status at 5 seconds", async () => {
    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/cli-defaults")
    const deps = createDefaultOuroCliDeps("/tmp/status-policy.sock")

    await deps.sendCommand("/tmp/status-policy.sock", { kind: "daemon.status" })

    expect(mocks.sendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/status-policy.sock",
      { kind: "daemon.status" },
      { timeoutMs: 5_000 },
    )
  })

  it("retains the ten-minute timeout for long-running commands", async () => {
    const { createDefaultOuroCliDeps } = await import("../../../heart/daemon/cli-defaults")
    const deps = createDefaultOuroCliDeps("/tmp/status-policy.sock")

    await deps.sendCommand("/tmp/status-policy.sock", { kind: "agent.status", agent: "slugger" })

    expect(mocks.sendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/status-policy.sock",
      { kind: "agent.status", agent: "slugger" },
      { timeoutMs: 600_000 },
    )
  })
})
