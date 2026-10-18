import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createDefaultShepherdOperationDeps } from "../../../senses/shepherd/operations-defaults"
import { createShepherdHost } from "../../../senses/shepherd/host"
import { localShepherdFriendStore, resolveExistingLocalOwner } from "../../../senses/shepherd/surface"
import { readMachineRuntimeCredentialConfig } from "../../../heart/runtime-credentials"
import { emitNervesEvent } from "../../../nerves/runtime"
vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

vi.mock("../../../senses/shepherd/host", () => ({ createShepherdHost: vi.fn(() => ({ name: "herdr" })) }))
vi.mock("../../../senses/shepherd/surface", () => ({
  localShepherdFriendStore: vi.fn(agent => ({ agent })),
  resolveExistingLocalOwner: vi.fn(async () => "existing-owner"),
}))
vi.mock("../../../heart/runtime-credentials", () => ({ readMachineRuntimeCredentialConfig: vi.fn() }))
const fixture = vi.hoisted(() => ({ bundlesRoot: "" }))
vi.mock("../../../heart/identity", () => ({ getAgentBundlesRoot: () => fixture.bundlesRoot }))

beforeEach(() => {
  vi.clearAllMocks()
  fixture.bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-default-owner-"))
})

describe("production owner-administration composition", () => {
  it("resolves the existing bundle path and refuses unsafe names or missing host configuration", async () => {
    const deps = createDefaultShepherdOperationDeps(vi.fn())
    expect(deps.agentRoot("ouro")).toBe(path.join(fixture.bundlesRoot, "ouro.ouro"))
    await expect(deps.resolveOwner("../escape")).rejects.toThrow(/safe agent name/)
    expect(localShepherdFriendStore).not.toHaveBeenCalled()
    vi.mocked(readMachineRuntimeCredentialConfig).mockReturnValue({ ok: false, reason: "missing", itemPath: "synthetic", error: "missing" })
    await expect(deps.host("ouro")).rejects.toThrow(/configuration is unavailable/)
    vi.mocked(readMachineRuntimeCredentialConfig).mockReturnValue({ ok: true, config: {} })
    await expect(deps.host("ouro")).rejects.toThrow()
  })

  it("does not construct a creating friend store for an unknown or unlinked bundle", async () => {
    const deps = createDefaultShepherdOperationDeps(vi.fn())
    await expect(deps.resolveOwner("missing")).rejects.toThrow(/existing.*owner/i)
    expect(localShepherdFriendStore).not.toHaveBeenCalled()
    expect(fs.readdirSync(fixture.bundlesRoot)).toEqual([])
    const root = path.join(fixture.bundlesRoot, "unlinked.ouro")
    fs.mkdirSync(root)
    await expect(deps.resolveOwner("unlinked")).rejects.toThrow(/existing.*owner/i)
    expect(fs.readdirSync(root)).toEqual([])
  })

  it("uses existing owner resolution and allows the configured Herdr host without enabling Shepherd", async () => {
    fs.mkdirSync(path.join(fixture.bundlesRoot, "ouro.ouro", "friends"), { recursive: true })
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
    lifecycle.mockResolvedValue({ ok: false })
    await expect(deps.senseStopped("ouro")).rejects.toThrow("daemon lifecycle unavailable")
    for (const data of [{}, { kind: "daemon_lifecycle", checkedAt, enabled: false, processState: "running" },
      { kind: "daemon_lifecycle", checkedAt, enabled: true, processState: "stopped" },
      { kind: "daemon_lifecycle", checkedAt: new Date(Date.now() - 31_000).toISOString(), enabled: false, processState: "stopped" },
      { kind: "daemon_lifecycle", checkedAt: new Date(Date.now() + 31_000).toISOString(), enabled: false, processState: "stopped" }]) {
      lifecycle.mockResolvedValue({ ok: true, data })
      await expect(deps.senseStopped("ouro")).rejects.toThrow(/proof/i)
    }
    lifecycle.mockResolvedValue({ ok: true, data: { kind: "daemon_lifecycle", checkedAt, enabled: false, processState: "stopped" } })
    expect(await deps.senseStopped("ouro")).toMatchObject({ enabled: false, processState: "stopped" })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.shepherd_maintenance_quiescence_confirmed", meta: { agent: "ouro", processState: "stopped" },
    }))
    expect(lifecycle).toHaveBeenLastCalledWith("ouro")
  })
})
