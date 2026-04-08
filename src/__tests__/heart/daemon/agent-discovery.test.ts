import { beforeEach, describe, expect, it, vi, afterEach } from "vitest"

const getAgentBundlesRootMock = vi.hoisted(() => vi.fn(() => "/mock/AgentBundles"))
const emitNervesEventMock = vi.hoisted(() => vi.fn())
const readdirSyncMock = vi.hoisted(() => vi.fn())
const readFileSyncMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn())
const execFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock("fs", () => ({
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
  existsSync: existsSyncMock,
}))

vi.mock("child_process", () => ({
  execFileSync: execFileSyncMock,
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

describe("listAllBundleAgents", () => {
  afterEach(() => {
    getAgentBundlesRootMock.mockReset()
    getAgentBundlesRootMock.mockReturnValue("/mock/AgentBundles")
    emitNervesEventMock.mockReset()
    readdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
  })

  it("returns rows for both enabled and disabled bundles, sorted by name", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "zeta.ouro", isDirectory: () => true },
      { name: "alpha.ouro", isDirectory: () => true },
      { name: "off.ouro", isDirectory: () => true },
      { name: "notes", isDirectory: () => true }, // not .ouro, skipped
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/zeta.ouro/agent.json")) {
        return JSON.stringify({ enabled: true })
      }
      if (target.endsWith("/alpha.ouro/agent.json")) {
        return JSON.stringify({}) // missing enabled defaults to true
      }
      if (target.endsWith("/off.ouro/agent.json")) {
        return JSON.stringify({ enabled: false })
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listAllBundleAgents } = await import("../../../heart/daemon/agent-discovery")

    expect(listAllBundleAgents()).toEqual([
      { name: "alpha", enabled: true },
      { name: "off", enabled: false },
      { name: "zeta", enabled: true },
    ])
  })

  it("skips bundles whose agent.json is unreadable or malformed", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "valid.ouro", isDirectory: () => true },
      { name: "broken.ouro", isDirectory: () => true },
      { name: "notjson.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/valid.ouro/agent.json")) {
        return JSON.stringify({ enabled: true })
      }
      if (target.endsWith("/broken.ouro/agent.json")) {
        throw new Error("ENOENT")
      }
      if (target.endsWith("/notjson.ouro/agent.json")) {
        return "not valid json {{"
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listAllBundleAgents } = await import("../../../heart/daemon/agent-discovery")

    expect(listAllBundleAgents()).toEqual([
      { name: "valid", enabled: true },
    ])
  })

  it("emits warning and returns empty list when fs discovery fails", async () => {
    readdirSyncMock.mockImplementation(() => {
      throw new Error("permission denied")
    })

    const { listAllBundleAgents } = await import("../../../heart/daemon/agent-discovery")

    expect(listAllBundleAgents()).toEqual([])
    expect(emitNervesEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "daemon.agent_discovery_failed",
      }),
    )
  })

  it("listEnabledBundleAgents stays in sync with listAllBundleAgents", async () => {
    // Regression: ensure the refactored listEnabledBundleAgents (which now
    // wraps listAllBundleAgents) keeps producing the same names as before.
    readdirSyncMock.mockReturnValue([
      { name: "a.ouro", isDirectory: () => true },
      { name: "b.ouro", isDirectory: () => true },
      { name: "c.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/a.ouro/agent.json")) return JSON.stringify({ enabled: true })
      if (target.endsWith("/b.ouro/agent.json")) return JSON.stringify({ enabled: false })
      if (target.endsWith("/c.ouro/agent.json")) return JSON.stringify({ enabled: true })
      throw new Error(`unexpected: ${target}`)
    })

    const { listEnabledBundleAgents, listAllBundleAgents } = await import("../../../heart/daemon/agent-discovery")

    expect(listEnabledBundleAgents()).toEqual(["a", "c"])
    expect(listAllBundleAgents()).toEqual([
      { name: "a", enabled: true },
      { name: "b", enabled: false },
      { name: "c", enabled: true },
    ])
  })
})

describe("listBundleSyncRows", () => {
  beforeEach(() => {
    getAgentBundlesRootMock.mockReset()
    getAgentBundlesRootMock.mockReturnValue("/mock/AgentBundles")
    emitNervesEventMock.mockReset()
    readdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    existsSyncMock.mockReset()
    // Default: all .git paths exist (bundle is a git repo).
    // Tests that verify the not-a-repo path override this.
    existsSyncMock.mockReturnValue(true)
    execFileSyncMock.mockReset()
    // Default: git remote get-url errors (no remote configured / not a repo).
    // Tests that verify URL resolution override this.
    execFileSyncMock.mockImplementation(() => {
      throw new Error("fatal: not a git repository")
    })
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
      { agent: "alpha", enabled: true, remote: "upstream", gitInitialized: true },
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
      { agent: "live", enabled: true, remote: "origin", gitInitialized: true },
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
      { agent: "ok", enabled: true, remote: "main", gitInitialized: true },
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

  it("resolves remoteUrl via git remote get-url when sync is enabled", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "synced.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/synced.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: true, remote: "origin" } })
      }
      throw new Error(`unexpected read: ${target}`)
    })
    execFileSyncMock.mockImplementation((cmd: string, args: string[], opts: { cwd: string }) => {
      expect(cmd).toBe("git")
      expect(args).toEqual(["remote", "get-url", "origin"])
      expect(opts.cwd).toBe("/mock/AgentBundles/synced.ouro")
      return Buffer.from("git@github.com:me/synced-state.git\n")
    })

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      {
        agent: "synced",
        enabled: true,
        remote: "origin",
        gitInitialized: true,
        remoteUrl: "git@github.com:me/synced-state.git",
      },
    ])
  })

  it("uses the configured remote name when resolving the URL", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "upstream.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/upstream.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: true, remote: "fork" } })
      }
      throw new Error(`unexpected read: ${target}`)
    })
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      expect(args).toEqual(["remote", "get-url", "fork"])
      return Buffer.from("https://example.com/me/upstream.git")
    })

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    const rows = listBundleSyncRows()
    expect(rows[0]?.remoteUrl).toBe("https://example.com/me/upstream.git")
  })

  it("leaves remoteUrl undefined when git remote get-url fails (local-only mode)", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "local.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/local.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: true } })
      }
      throw new Error(`unexpected read: ${target}`)
    })
    // Default mock throws, simulating no remote configured

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      { agent: "local", enabled: true, remote: "origin", gitInitialized: true },
    ])
    // Verify execFileSync was attempted
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["remote", "get-url", "origin"],
      expect.objectContaining({ cwd: "/mock/AgentBundles/local.ouro" }),
    )
  })

  it("leaves remoteUrl undefined when git returns empty output", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "empty.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/empty.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: true } })
      }
      throw new Error(`unexpected read: ${target}`)
    })
    execFileSyncMock.mockReturnValue(Buffer.from("   \n"))

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      { agent: "empty", enabled: true, remote: "origin", gitInitialized: true },
    ])
  })

  it("does not call git for bundles where sync is disabled", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "off.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/off.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: false } })
      }
      throw new Error(`unexpected read: ${target}`)
    })

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    listBundleSyncRows()
    expect(execFileSyncMock).not.toHaveBeenCalled()
    // Disabled rows should also skip the .git existsSync check
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it("flags gitInitialized=false when sync is enabled but .git is missing, and skips git invocation", async () => {
    readdirSyncMock.mockReturnValue([
      { name: "needs-init.ouro", isDirectory: () => true },
    ])
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("/needs-init.ouro/agent.json")) {
        return JSON.stringify({ enabled: true, sync: { enabled: true } })
      }
      throw new Error(`unexpected read: ${target}`)
    })
    existsSyncMock.mockReturnValue(false) // .git does not exist

    const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

    expect(listBundleSyncRows()).toEqual([
      {
        agent: "needs-init",
        enabled: true,
        remote: "origin",
        gitInitialized: false,
      },
    ])
    // No remote URL lookup should be attempted when the bundle isn't a repo
    expect(execFileSyncMock).not.toHaveBeenCalled()
    // existsSync should have been called with the .git path
    expect(existsSyncMock).toHaveBeenCalledWith("/mock/AgentBundles/needs-init.ouro/.git")
  })
})
