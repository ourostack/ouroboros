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

describe("listBundleSyncRows", () => {
  afterEach(() => {
    getAgentBundlesRootMock.mockReset()
    getAgentBundlesRootMock.mockReturnValue("/mock/AgentBundles")
    emitNervesEventMock.mockReset()
    readdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
  })

  it("returns one row per enabled bundle with its sync block", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "alpha.ouro", isDirectory: () => true },
      { name: "beta.ouro", isDirectory: () => true },
      { name: "gamma.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/alpha.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: true, remote: "upstream" } })
      }
      if (target.endsWith("/beta.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: false } })
      }
      if (target.endsWith("/gamma.ouro/agent.json")) {
        return JSON.stringify({ enabled: true })
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      { agent: "alpha", enabled: true, remote: "upstream" },
      { agent: "beta", enabled: false, remote: "origin" },
      { agent: "gamma", enabled: false, remote: "origin" },
    ])
  })

  it("skips disabled bundles entirely", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "live.ouro", isDirectory: () => true },
      { name: "off.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/live.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: true } })
      }
      if (target.endsWith("/off.ouro/agent.json")) {
        return JSON.stringify({ enabled: false, sync: { enabled: true } })
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      { agent: "live", enabled: true, remote: "origin" },
    ])
  })

  it("returns defaults for bundles whose agent.json cannot be reread", async () => {
    // First pass (listEnabledBundleAgents) succeeds; second pass (sync read) fails for one
    let callCount = 0
    readdirSyncMock.mockReturnValue([
      { name: "ok.ouro", isDirectory: () => true },
      { name: "broken.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/ok.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: true, remote: "main" } })
      }
      if (target.endsWith("/broken.ouro/agent.json")) {
        callCount++
        // First call (discovery) returns valid; second call (sync read) throws
        if (callCount === 1) return JSON.stringify({ enabled: true })
        throw new Error("read failed")
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      { agent: "broken", enabled: false, remote: "origin" },
      { agent: "ok", enabled: true, remote: "main" },
    ])
  })

  it("returns defaults when sync block is present but not an object", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "weird.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/weird.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: "not-an-object" })
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      { agent: "weird", enabled: false, remote: "origin" },
    ])
  })

  it("ignores non-boolean enabled and non-string remote inside the sync block", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "partial.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/partial.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: "yes", remote: 42 } })
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      { agent: "partial", enabled: false, remote: "origin" },
    ])
  })
})
