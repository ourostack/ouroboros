import { describe, expect, it, vi, afterEach } from "vitest"

const readdirSyncMock = vi.hoisted(() => vi.fn())
const readFileSyncMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn())

vi.mock("fs", () => ({
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
  existsSync: existsSyncMock,
}))

/**
 * Layer 3 — RepairGuide loader.
 *
 * Reads `RepairGuide.ouro/{psyche,skills}/*.md` from the repo root and returns
 * a structured shape the agentic-repair pipeline can prepend to the system
 * prompt. Missing/malformed bundle is non-fatal — caller falls back to today's
 * pre-RepairGuide pipeline.
 */
describe("loadRepairGuideContent", () => {
  afterEach(() => {
    readdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    existsSyncMock.mockReset()
  })

  it("returns null when RepairGuide.ouro directory does not exist", async () => {
    existsSyncMock.mockReturnValue(false)

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result).toBeNull()
  })

  it("returns concatenated content when all expected files are present", async () => {
    existsSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("RepairGuide.ouro")) return true
      if (target.endsWith("psyche")) return true
      if (target.endsWith("skills")) return true
      return true
    })
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("psyche")) {
        return [
          { name: "SOUL.md", isFile: () => true, isDirectory: () => false },
          { name: "IDENTITY.md", isFile: () => true, isDirectory: () => false },
        ]
      }
      if (target.endsWith("skills")) {
        return [
          { name: "diagnose-bootstrap-drift.md", isFile: () => true, isDirectory: () => false },
          { name: "diagnose-broken-remote.md", isFile: () => true, isDirectory: () => false },
        ]
      }
      return []
    })
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("SOUL.md")) return "# SOUL\nsoul content"
      if (target.endsWith("IDENTITY.md")) return "# IDENTITY\nidentity content"
      if (target.endsWith("diagnose-bootstrap-drift.md")) return "# bootstrap drift\nbody"
      if (target.endsWith("diagnose-broken-remote.md")) return "# broken remote\nbody"
      throw new Error(`unexpected read: ${target}`)
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result).not.toBeNull()
    expect(result!.psyche.soul).toBe("# SOUL\nsoul content")
    expect(result!.psyche.identity).toBe("# IDENTITY\nidentity content")
    expect(result!.skills["diagnose-bootstrap-drift.md"]).toBe("# bootstrap drift\nbody")
    expect(result!.skills["diagnose-broken-remote.md"]).toBe("# broken remote\nbody")
  })

  it("returns partial content when only psyche/SOUL.md is present", async () => {
    existsSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("RepairGuide.ouro")) return true
      if (target.endsWith("psyche")) return true
      if (target.endsWith("skills")) return false
      return true
    })
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("psyche")) {
        return [
          { name: "SOUL.md", isFile: () => true, isDirectory: () => false },
        ]
      }
      return []
    })
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("SOUL.md")) return "# SOUL\nsoul content"
      throw new Error(`unexpected read: ${target}`)
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result).not.toBeNull()
    expect(result!.psyche.soul).toBe("# SOUL\nsoul content")
    expect(result!.psyche.identity).toBeUndefined()
    expect(result!.skills).toEqual({})
  })

  it("skips empty skill files silently", async () => {
    existsSyncMock.mockReturnValue(true)
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("psyche")) return []
      if (target.endsWith("skills")) {
        return [
          { name: "non-empty.md", isFile: () => true, isDirectory: () => false },
          { name: "empty.md", isFile: () => true, isDirectory: () => false },
        ]
      }
      return []
    })
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("non-empty.md")) return "# title\nbody"
      if (target.endsWith("empty.md")) return ""
      throw new Error(`unexpected read: ${target}`)
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result).not.toBeNull()
    expect(Object.keys(result!.skills)).toEqual(["non-empty.md"])
  })

  it("includes skill files that contain only frontmatter (caller decides)", async () => {
    existsSyncMock.mockReturnValue(true)
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("psyche")) return []
      if (target.endsWith("skills")) {
        return [
          { name: "frontmatter-only.md", isFile: () => true, isDirectory: () => false },
        ]
      }
      return []
    })
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("frontmatter-only.md")) return "---\nname: test\n---\n"
      throw new Error(`unexpected read: ${target}`)
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result).not.toBeNull()
    expect(result!.skills["frontmatter-only.md"]).toBe("---\nname: test\n---\n")
  })

  it("returns skills in alphabetical order regardless of fs order", async () => {
    existsSyncMock.mockReturnValue(true)
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("psyche")) return []
      if (target.endsWith("skills")) {
        return [
          { name: "zeta.md", isFile: () => true, isDirectory: () => false },
          { name: "alpha.md", isFile: () => true, isDirectory: () => false },
          { name: "mu.md", isFile: () => true, isDirectory: () => false },
        ]
      }
      return []
    })
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("zeta.md")) return "z"
      if (target.endsWith("alpha.md")) return "a"
      if (target.endsWith("mu.md")) return "m"
      throw new Error(`unexpected read: ${target}`)
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(Object.keys(result!.skills)).toEqual(["alpha.md", "mu.md", "zeta.md"])
  })

  it("ignores non-.md files in psyche and skills directories", async () => {
    existsSyncMock.mockReturnValue(true)
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("psyche")) {
        return [
          { name: "SOUL.md", isFile: () => true, isDirectory: () => false },
          { name: "notes.txt", isFile: () => true, isDirectory: () => false },
        ]
      }
      if (target.endsWith("skills")) {
        return [
          { name: "skill.md", isFile: () => true, isDirectory: () => false },
          { name: "binary.bin", isFile: () => true, isDirectory: () => false },
          { name: "subdir", isFile: () => false, isDirectory: () => true },
        ]
      }
      return []
    })
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("SOUL.md")) return "soul"
      if (target.endsWith("skill.md")) return "skill body"
      throw new Error(`unexpected read: ${target}`)
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result!.psyche.soul).toBe("soul")
    expect(result!.psyche.identity).toBeUndefined()
    expect(Object.keys(result!.skills)).toEqual(["skill.md"])
  })

  it("returns empty content (not null) when bundle exists but psyche and skills are both empty", async () => {
    existsSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("RepairGuide.ouro")) return true
      return true
    })
    readdirSyncMock.mockReturnValue([])

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result).not.toBeNull()
    expect(result!.psyche).toEqual({})
    expect(result!.skills).toEqual({})
  })

  it("returns null on filesystem read errors (graceful degradation)", async () => {
    existsSyncMock.mockReturnValue(true)
    readdirSyncMock.mockImplementation(() => {
      throw new Error("EACCES")
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result).toBeNull()
  })

  it("returns content with empty psyche when psyche directory does not exist", async () => {
    existsSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("RepairGuide.ouro")) return true
      if (target.endsWith("psyche")) return false
      if (target.endsWith("skills")) return true
      return false
    })
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("skills")) {
        return [{ name: "skill.md", isFile: () => true, isDirectory: () => false }]
      }
      return []
    })
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("skill.md")) return "skill body"
      throw new Error(`unexpected read: ${target}`)
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result!.psyche).toEqual({})
    expect(result!.skills).toEqual({ "skill.md": "skill body" })
  })

  it("ignores psyche .md files that are neither SOUL nor IDENTITY", async () => {
    existsSyncMock.mockReturnValue(true)
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("psyche")) {
        return [
          { name: "SOUL.md", isFile: () => true, isDirectory: () => false },
          { name: "EXTRA.md", isFile: () => true, isDirectory: () => false },
        ]
      }
      return []
    })
    readFileSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("SOUL.md")) return "soul"
      if (target.endsWith("EXTRA.md")) return "extra"
      throw new Error(`unexpected read: ${target}`)
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result!.psyche.soul).toBe("soul")
    expect(result!.psyche.identity).toBeUndefined()
  })

  it("returns null when readFileSync throws on a psyche file (corrupt content)", async () => {
    existsSyncMock.mockReturnValue(true)
    readdirSyncMock.mockImplementation((target: string) => {
      if (target.endsWith("psyche")) {
        return [{ name: "SOUL.md", isFile: () => true, isDirectory: () => false }]
      }
      return []
    })
    readFileSyncMock.mockImplementation(() => {
      throw new Error("EIO")
    })

    const { loadRepairGuideContent } = await import("../../../heart/daemon/agentic-repair")

    const result = loadRepairGuideContent("/repo")
    expect(result).toBeNull()
  })
})
