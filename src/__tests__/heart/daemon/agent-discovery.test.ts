import { describe, expect, it, vi, afterEach } from "vitest"

const getAgentBundlesRootMock = vi.hoisted(() => vi.fn(() => "/mock/AgentBundles"))
const emitNervesEventMock = vi.hoisted(() => vi.fn())
const readdirSyncMock = vi.hoisted(() => vi.fn())
const readFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock("fs", () => ({
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
}))

vi.mock("../../../heart/identity", () => ({
  getAgentBundlesRoot: getAgentBundlesRootMock,
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: emitNervesEventMock,
}))

describe("listEnabledBundleAgents", () => {
  afterEach(() => {
    getAgentBundlesRootMock.mockReset()
    getAgentBundlesRootMock.mockReturnValue("/mock/AgentBundles")
    emitNervesEventMock.mockReset()
    readdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
  })

  it("uses default identity and fs dependencies when options are omitted", async () => {
    readdirSyncMock.mockReturnValue([
      {
        name: "zeta.ouro",
        isDirectory: () => true,
      },
      {
        name: "alpha.ouro",
        isDirectory: () => true,
      },
      {
        name: "notes",
        isDirectory: () => true,
      },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/zeta.ouro/agent.json")) {
        return JSON.stringify({ enabled: true })
      }
      if (target.endsWith("/alpha.ouro/agent.json")) {
        return JSON.stringify({})
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listEnabledBundleAgents } = await import("../../../heart/daemon/agent-discovery")

    expect(listEnabledBundleAgents()).toEqual(["alpha", "zeta"])
    expect(getAgentBundlesRootMock).toHaveBeenCalledTimes(1)
    expect(readdirSyncMock).toHaveBeenCalledWith("/mock/AgentBundles", { withFileTypes: true })
    expect(readFileSyncMock).toHaveBeenCalledTimes(2)
  })

  it("emits a warning and returns empty list when default fs discovery fails", async () => {
    readdirSyncMock.mockImplementation(() => {
      throw new Error("boom")
    })

    const { listEnabledBundleAgents } = await import("../../../heart/daemon/agent-discovery")

    expect(listEnabledBundleAgents()).toEqual([])
    expect(emitNervesEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "daemon",
        event: "daemon.agent_discovery_failed",
        meta: { bundlesRoot: "/mock/AgentBundles" },
      }),
    )
  })
})
