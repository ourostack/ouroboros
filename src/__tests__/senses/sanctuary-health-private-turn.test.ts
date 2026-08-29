import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getAgentRoot: vi.fn(),
  recordExternalEvent: vi.fn(),
  createSanctuaryHealthSweep: vi.fn(),
  createSanctuaryToolContext: vi.fn(),
  loadOrCreateMachineIdentity: vi.fn(),
  readMachineRuntimeCredentialConfig: vi.fn(),
  refreshMachineRuntimeCredentialConfig: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({ getAgentRoot: mocks.getAgentRoot }))
vi.mock("../../heart/external-events/router", () => ({ recordExternalEvent: mocks.recordExternalEvent }))
vi.mock("../../senses/sanctuary-health", () => ({ createSanctuaryHealthSweep: mocks.createSanctuaryHealthSweep }))
vi.mock("../../senses/sanctuary-runtime", () => ({ createSanctuaryToolContext: mocks.createSanctuaryToolContext }))
vi.mock("../../heart/machine-identity", () => ({ loadOrCreateMachineIdentity: mocks.loadOrCreateMachineIdentity }))
vi.mock("../../heart/runtime-credentials", () => ({
  readMachineRuntimeCredentialConfig: mocks.readMachineRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig: mocks.refreshMachineRuntimeCredentialConfig,
}))

import { runSanctuaryHealthHabit } from "../../senses/sanctuary-health-runner"

describe("Sanctuary health evidence runner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAgentRoot.mockReturnValue("/agents/sanctuary")
    mocks.loadOrCreateMachineIdentity.mockReturnValue({ machineId: "machine-1" })
    mocks.readMachineRuntimeCredentialConfig.mockReturnValue({ ok: false, error: "missing" })
    mocks.refreshMachineRuntimeCredentialConfig.mockResolvedValue({ ok: true, credentials: {} })
    mocks.createSanctuaryToolContext.mockReturnValue({ sanctuary: {} })
    mocks.createSanctuaryHealthSweep.mockReturnValue(vi.fn(async () => ({
      message: null,
      transition: "opened",
      incidents: [{ id: "container:jellyfin:availability", summary: "Jellyfin is stopped", observationRevision: "incident-rev" }],
      recovered: [],
    })))
    mocks.recordExternalEvent.mockReturnValue({ shouldWake: true })
  })

  it("refreshes machine reads, samples evidence, and records an event without delivery dependencies", async () => {
    await expect(runSanctuaryHealthHabit("sanctuary")).resolves.toEqual({
      ok: true,
      message: "health evidence submitted",
      data: { incidentCount: 1, submitted: 2, wakesRequested: 1 },
    })
    expect(mocks.refreshMachineRuntimeCredentialConfig).toHaveBeenCalledWith("sanctuary", "machine-1", { preserveCachedOnFailure: true })
    expect(mocks.refreshMachineRuntimeCredentialConfig).toHaveBeenCalledBefore(mocks.createSanctuaryToolContext)
    expect(mocks.recordExternalEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "sanctuary-health", eventId: "container:jellyfin:availability", observationRevision: "incident-rev",
    }), { dispatchEnabled: false })
  })

  it("reuses a healthy credential cache without refreshing it", async () => {
    mocks.readMachineRuntimeCredentialConfig.mockReturnValue({ ok: true, credentials: {} })
    await runSanctuaryHealthHabit("sanctuary")
    expect(mocks.refreshMachineRuntimeCredentialConfig).not.toHaveBeenCalled()
  })
})
