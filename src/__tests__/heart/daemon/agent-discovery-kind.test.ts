import { describe, expect, it, vi, afterEach } from "vitest"

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

/**
 * Layer 3 — `kind: library` exclusion.
 *
 * Bundles with `"kind": "library"` are content-only resources (e.g.
 * SerpentGuide.ouro, RepairGuide.ouro). They are not real agents:
 * they should not appear in `listEnabledBundleAgents` or
 * `listBundleSyncRows`. `listAllBundleAgents` returns ALL bundles
 * (with their `kind`), so callers that need to enumerate everything
 * (status surfaces, etc.) can filter explicitly.
 */
describe("kind:library exclusion", () => {
  afterEach(() => {
    getAgentBundlesRootMock.mockReset()
    getAgentBundlesRootMock.mockReturnValue("/mock/AgentBundles")
    emitNervesEventMock.mockReset()
    readdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    existsSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => {
      throw new Error("fatal: not a git repository")
    })
  })

  describe("listEnabledBundleAgents", () => {
    it("excludes bundles with kind:library even when enabled is true", async () => {
      readdirSyncMock.mockReturnValue([
        { name: "real.ouro", isDirectory: () => true },
        { name: "RepairGuide.ouro", isDirectory: () => true },
      ])
      readFileSyncMock.mockImplementation((target: string) => {
        if (target.endsWith("/real.ouro/agent.json")) {
          return JSON.stringify({ enabled: true })
        }
        if (target.endsWith("/RepairGuide.ouro/agent.json")) {
          return JSON.stringify({ enabled: true, kind: "library" })
        }
        throw new Error(`unexpected read: ${target}`)
      })

      const { listEnabledBundleAgents } = await import("../../../heart/daemon/agent-discovery")

      expect(listEnabledBundleAgents()).toEqual(["real"])
    })

    it("includes bundles with no kind field (back-compat default)", async () => {
      readdirSyncMock.mockReturnValue([
        { name: "alpha.ouro", isDirectory: () => true },
      ])
      readFileSyncMock.mockImplementation((target: string) => {
        if (target.endsWith("/alpha.ouro/agent.json")) {
          return JSON.stringify({ enabled: true })
        }
        throw new Error(`unexpected: ${target}`)
      })

      const { listEnabledBundleAgents } = await import("../../../heart/daemon/agent-discovery")

      expect(listEnabledBundleAgents()).toEqual(["alpha"])
    })

    it("includes bundles with explicit kind:agent", async () => {
      readdirSyncMock.mockReturnValue([
        { name: "explicit.ouro", isDirectory: () => true },
      ])
      readFileSyncMock.mockImplementation((target: string) => {
        if (target.endsWith("/explicit.ouro/agent.json")) {
          return JSON.stringify({ enabled: true, kind: "agent" })
        }
        throw new Error(`unexpected: ${target}`)
      })

      const { listEnabledBundleAgents } = await import("../../../heart/daemon/agent-discovery")

      expect(listEnabledBundleAgents()).toEqual(["explicit"])
    })

    it("filters mixed inventory: only non-library agents returned", async () => {
      readdirSyncMock.mockReturnValue([
        { name: "real-a.ouro", isDirectory: () => true },
        { name: "SerpentGuide.ouro", isDirectory: () => true },
        { name: "real-b.ouro", isDirectory: () => true },
        { name: "RepairGuide.ouro", isDirectory: () => true },
      ])
      readFileSyncMock.mockImplementation((target: string) => {
        if (target.endsWith("/real-a.ouro/agent.json")) {
          return JSON.stringify({ enabled: true, kind: "agent" })
        }
        if (target.endsWith("/SerpentGuide.ouro/agent.json")) {
          return JSON.stringify({ enabled: false, kind: "library" })
        }
        if (target.endsWith("/real-b.ouro/agent.json")) {
          return JSON.stringify({ enabled: true })
        }
        if (target.endsWith("/RepairGuide.ouro/agent.json")) {
          return JSON.stringify({ enabled: false, kind: "library" })
        }
        throw new Error(`unexpected: ${target}`)
      })

      const { listEnabledBundleAgents } = await import("../../../heart/daemon/agent-discovery")

      expect(listEnabledBundleAgents()).toEqual(["real-a", "real-b"])
    })

    it("ignores non-string kind field (defensive)", async () => {
      readdirSyncMock.mockReturnValue([
        { name: "weird.ouro", isDirectory: () => true },
      ])
      readFileSyncMock.mockImplementation((target: string) => {
        if (target.endsWith("/weird.ouro/agent.json")) {
          return JSON.stringify({ enabled: true, kind: 42 })
        }
        throw new Error(`unexpected: ${target}`)
      })

      const { listEnabledBundleAgents } = await import("../../../heart/daemon/agent-discovery")

      expect(listEnabledBundleAgents()).toEqual(["weird"])
    })
  })

  describe("listAllBundleAgents", () => {
    it("returns library bundles tagged with their kind (does NOT exclude)", async () => {
      readdirSyncMock.mockReturnValue([
        { name: "real.ouro", isDirectory: () => true },
        { name: "RepairGuide.ouro", isDirectory: () => true },
      ])
      readFileSyncMock.mockImplementation((target: string) => {
        if (target.endsWith("/real.ouro/agent.json")) {
          return JSON.stringify({ enabled: true })
        }
        if (target.endsWith("/RepairGuide.ouro/agent.json")) {
          return JSON.stringify({ enabled: false, kind: "library" })
        }
        throw new Error(`unexpected: ${target}`)
      })

      const { listAllBundleAgents } = await import("../../../heart/daemon/agent-discovery")

      expect(listAllBundleAgents()).toEqual([
        { name: "real", enabled: true },
        { name: "RepairGuide", enabled: false, kind: "library" },
      ])
    })

    it("does not set kind when agent.json has no kind field", async () => {
      readdirSyncMock.mockReturnValue([
        { name: "agent-a.ouro", isDirectory: () => true },
      ])
      readFileSyncMock.mockImplementation((target: string) => {
        if (target.endsWith("/agent-a.ouro/agent.json")) {
          return JSON.stringify({ enabled: true })
        }
        throw new Error(`unexpected: ${target}`)
      })

      const { listAllBundleAgents } = await import("../../../heart/daemon/agent-discovery")

      const rows = listAllBundleAgents()
      expect(rows).toEqual([{ name: "agent-a", enabled: true }])
      expect(rows[0]).not.toHaveProperty("kind")
    })
  })

  describe("listBundleSyncRows", () => {
    it("excludes library bundles unconditionally", async () => {
      readdirSyncMock.mockReturnValue([
        { name: "real.ouro", isDirectory: () => true },
        { name: "RepairGuide.ouro", isDirectory: () => true },
      ])
      readFileSyncMock.mockImplementation((target: string) => {
        if (target.endsWith("/real.ouro/agent.json")) {
          return JSON.stringify({
            enabled: true,
            sync: { enabled: true, remote: "origin" },
          })
        }
        if (target.endsWith("/RepairGuide.ouro/agent.json")) {
          return JSON.stringify({
            enabled: true,
            kind: "library",
            sync: { enabled: true, remote: "origin" },
          })
        }
        throw new Error(`unexpected: ${target}`)
      })

      const { listBundleSyncRows } = await import("../../../heart/daemon/agent-discovery")

      const rows = listBundleSyncRows()
      const names = rows.map((r) => r.agent)
      expect(names).toEqual(["real"])
    })
  })

  describe("isLibraryKind predicate", () => {
    it("returns true for the literal string library", async () => {
      const { isLibraryKind } = await import("../../../heart/daemon/agent-discovery")
      expect(isLibraryKind("library")).toBe(true)
    })

    it("returns false for any non-library value", async () => {
      const { isLibraryKind } = await import("../../../heart/daemon/agent-discovery")
      expect(isLibraryKind("agent")).toBe(false)
      expect(isLibraryKind(undefined)).toBe(false)
      expect(isLibraryKind(null)).toBe(false)
      expect(isLibraryKind(42)).toBe(false)
      expect(isLibraryKind("")).toBe(false)
      expect(isLibraryKind({})).toBe(false)
    })
  })
})
