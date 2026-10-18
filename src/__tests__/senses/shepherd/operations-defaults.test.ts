import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDefaultShepherdOperationDeps } from "../../../senses/shepherd/operations-defaults"
import { createShepherdHost } from "../../../senses/shepherd/host"
import { resolveExistingLocalOwner } from "../../../senses/shepherd/surface"
import { readMachineRuntimeCredentialConfig } from "../../../heart/runtime-credentials"

vi.mock("../../../senses/shepherd/host", () => ({ createShepherdHost: vi.fn(() => ({ name: "herdr" })) }))
vi.mock("../../../senses/shepherd/surface", () => ({
  localShepherdFriendStore: vi.fn(agent => ({ agent })),
  resolveExistingLocalOwner: vi.fn(async () => "existing-owner"),
}))
vi.mock("../../../heart/runtime-credentials", () => ({ readMachineRuntimeCredentialConfig: vi.fn() }))

beforeEach(() => { vi.clearAllMocks() })

describe("production owner-administration composition", () => {
  it("uses existing owner resolution and allows the configured Herdr host without enabling Shepherd", async () => {
    vi.mocked(readMachineRuntimeCredentialConfig).mockReturnValue({ ok: true, config: { herdr: { socketPath: "/synthetic/herdr.sock" } } })
    const deps = createDefaultShepherdOperationDeps(vi.fn())
    expect(await deps.resolveOwner("ouro")).toEqual({ actorId: "existing-owner" })
    expect(resolveExistingLocalOwner).toHaveBeenCalledWith({ agent: "ouro" })
    expect(await deps.host("ouro")).toEqual({ name: "herdr" })
    expect(createShepherdHost).toHaveBeenCalledWith({ host: "herdr", socketPath: "/synthetic/herdr.sock" }, { agentName: "ouro" })
  })

  it("propagates daemon failure and rejects incomplete, running, stale, or future lifecycle claims", async () => {
    const checkedAt = new Date().toISOString()
    const lifecycle = vi.fn()
    const deps = createDefaultShepherdOperationDeps(lifecycle)
    lifecycle.mockResolvedValue({ ok: false, error: "daemon unavailable" })
    await expect(deps.senseStopped("ouro")).rejects.toThrow("daemon unavailable")
    for (const data of [{}, { kind: "daemon_lifecycle", checkedAt, enabled: false, processState: "running" },
      { kind: "daemon_lifecycle", checkedAt, enabled: true, processState: "stopped" },
      { kind: "daemon_lifecycle", checkedAt: new Date(Date.now() - 31_000).toISOString(), enabled: false, processState: "stopped" },
      { kind: "daemon_lifecycle", checkedAt: new Date(Date.now() + 31_000).toISOString(), enabled: false, processState: "stopped" }]) {
      lifecycle.mockResolvedValue({ ok: true, data })
      await expect(deps.senseStopped("ouro")).rejects.toThrow(/proof/i)
    }
    lifecycle.mockResolvedValue({ ok: true, data: { kind: "daemon_lifecycle", checkedAt, enabled: false, processState: "stopped" } })
    expect(await deps.senseStopped("ouro")).toMatchObject({ enabled: false, processState: "stopped" })
    expect(lifecycle).toHaveBeenLastCalledWith("ouro")
  })
})
