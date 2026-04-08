import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("ouro-version-manager", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("getOuroCliHome", () => {
    it("returns <homeDir>/.ouro-cli", async () => {
      const { getOuroCliHome } = await import("../../../heart/versioning/ouro-version-manager")
      const result = getOuroCliHome("/Users/test")
      expect(result).toBe("/Users/test/.ouro-cli")
    })
  })

  describe("getCurrentVersion", () => {
    it("resolves CurrentVersion symlink and extracts version directory name", async () => {
      const { getCurrentVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockReturnValue("/Users/test/.ouro-cli/versions/0.1.0-alpha.80"),
      }
      const result = getCurrentVersion(deps)
      expect(result).toBe("0.1.0-alpha.80")
      expect(deps.readlinkSync).toHaveBeenCalledWith("/Users/test/.ouro-cli/CurrentVersion")
    })

    it("returns null when symlink does not exist", async () => {
      const { getCurrentVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
      }
      const result = getCurrentVersion(deps)
      expect(result).toBeNull()
    })
  })

  describe("getPreviousVersion", () => {
    it("resolves previous symlink and extracts version directory name", async () => {
      const { getPreviousVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockReturnValue("/Users/test/.ouro-cli/versions/0.1.0-alpha.79"),
      }
      const result = getPreviousVersion(deps)
      expect(result).toBe("0.1.0-alpha.79")
      expect(deps.readlinkSync).toHaveBeenCalledWith("/Users/test/.ouro-cli/previous")
    })

    it("returns null when symlink does not exist", async () => {
      const { getPreviousVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
      }
      const result = getPreviousVersion(deps)
      expect(result).toBeNull()
    })
  })

  describe("buildChangelogCommand", () => {
    it("returns ouro changelog command when current and previous versions differ", async () => {
      const { buildChangelogCommand } = await import("../../../heart/versioning/ouro-version-manager")
      expect(buildChangelogCommand("0.1.0-alpha.79", "0.1.0-alpha.80")).toBe("ouro changelog --from 0.1.0-alpha.79")
    })

    it("returns null when previous version is missing or unchanged", async () => {
      const { buildChangelogCommand } = await import("../../../heart/versioning/ouro-version-manager")
      expect(buildChangelogCommand(null, "0.1.0-alpha.80")).toBeNull()
      expect(buildChangelogCommand("0.1.0-alpha.80", "0.1.0-alpha.80")).toBeNull()
    })
  })

  describe("listInstalledVersions", () => {
    it("reads versions/ directory and returns entries", async () => {
      const { listInstalledVersions } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readdirSync: vi.fn().mockReturnValue([
          { name: "0.1.0-alpha.79", isDirectory: () => true },
          { name: "0.1.0-alpha.80", isDirectory: () => true },
          { name: ".DS_Store", isDirectory: () => false },
        ]),
      }
      const result = listInstalledVersions(deps)
      expect(result).toEqual(["0.1.0-alpha.79", "0.1.0-alpha.80"])
      expect(deps.readdirSync).toHaveBeenCalledWith("/Users/test/.ouro-cli/versions", { withFileTypes: true })
    })

    it("returns empty array when versions directory does not exist", async () => {
      const { listInstalledVersions } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readdirSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
      }
      const result = listInstalledVersions(deps)
      expect(result).toEqual([])
    })
  })

  describe("installVersion", () => {
    it("runs npm install with correct prefix and package specifier", async () => {
      const { installVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        mkdirSync: vi.fn(),
        execSync: vi.fn(),
      }
      installVersion("0.1.0-alpha.80", deps)
      expect(deps.mkdirSync).toHaveBeenCalledWith("/Users/test/.ouro-cli/versions/0.1.0-alpha.80", { recursive: true })
      expect(deps.execSync).toHaveBeenCalledWith(
        "npm install --prefix /Users/test/.ouro-cli/versions/0.1.0-alpha.80 @ouro.bot/cli@0.1.0-alpha.80",
        expect.objectContaining({ stdio: "pipe" }),
      )
    })

    it("throws when npm install fails", async () => {
      const { installVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        mkdirSync: vi.fn(),
        execSync: vi.fn().mockImplementation(() => { throw new Error("npm install failed") }),
      }
      expect(() => installVersion("0.1.0-alpha.80", deps)).toThrow("npm install failed")
    })
  })

  describe("activateVersion", () => {
    it("updates previous symlink to old CurrentVersion target, then updates CurrentVersion", async () => {
      const { activateVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const readlinkResults: Record<string, string> = {
        "/Users/test/.ouro-cli/CurrentVersion": "/Users/test/.ouro-cli/versions/0.1.0-alpha.79",
      }
      const unlinkCalls: string[] = []
      const symlinkCalls: Array<{ target: string; path: string }> = []
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockImplementation((p: string) => {
          if (readlinkResults[p]) return readlinkResults[p]
          throw new Error("ENOENT")
        }),
        unlinkSync: vi.fn().mockImplementation((p: string) => { unlinkCalls.push(p) }),
        symlinkSync: vi.fn().mockImplementation((target: string, p: string) => { symlinkCalls.push({ target, path: p }) }),
        existsSync: vi.fn().mockReturnValue(true),
      }
      activateVersion("0.1.0-alpha.80", deps)

      // Should unlink previous, symlink previous to old current, unlink current, symlink current to new
      expect(unlinkCalls).toContain("/Users/test/.ouro-cli/previous")
      expect(unlinkCalls).toContain("/Users/test/.ouro-cli/CurrentVersion")
      expect(symlinkCalls).toContainEqual({
        target: "/Users/test/.ouro-cli/versions/0.1.0-alpha.79",
        path: "/Users/test/.ouro-cli/previous",
      })
      expect(symlinkCalls).toContainEqual({
        target: "/Users/test/.ouro-cli/versions/0.1.0-alpha.80",
        path: "/Users/test/.ouro-cli/CurrentVersion",
      })
    })

    it("handles missing CurrentVersion symlink (no previous to save)", async () => {
      const { activateVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const symlinkCalls: Array<{ target: string; path: string }> = []
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
        unlinkSync: vi.fn(),
        symlinkSync: vi.fn().mockImplementation((target: string, p: string) => { symlinkCalls.push({ target, path: p }) }),
        existsSync: vi.fn().mockReturnValue(false),
      }
      activateVersion("0.1.0-alpha.80", deps)

      // Should still create CurrentVersion symlink
      expect(symlinkCalls).toContainEqual({
        target: "/Users/test/.ouro-cli/versions/0.1.0-alpha.80",
        path: "/Users/test/.ouro-cli/CurrentVersion",
      })
    })

    it("handles version directory not found", async () => {
      const { activateVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
        unlinkSync: vi.fn(),
        symlinkSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
      }
      // Should not throw -- version directory existence is not checked by activateVersion
      // (it's the caller's responsibility to install first)
      expect(() => activateVersion("0.1.0-alpha.80", deps)).not.toThrow()
    })
  })

  describe("ensureLayout", () => {
    it("creates ~/.ouro-cli/, ~/.ouro-cli/bin/, ~/.ouro-cli/versions/", async () => {
      const { ensureLayout } = await import("../../../heart/versioning/ouro-version-manager")
      const mkdirCalls: Array<{ path: string; options: unknown }> = []
      const deps = {
        homeDir: "/Users/test",
        mkdirSync: vi.fn().mockImplementation((p: string, opts: unknown) => { mkdirCalls.push({ path: p, options: opts }) }),
      }
      ensureLayout(deps)
      expect(mkdirCalls).toContainEqual({ path: "/Users/test/.ouro-cli", options: { recursive: true } })
      expect(mkdirCalls).toContainEqual({ path: "/Users/test/.ouro-cli/bin", options: { recursive: true } })
      expect(mkdirCalls).toContainEqual({ path: "/Users/test/.ouro-cli/versions", options: { recursive: true } })
    })
  })

  describe("bootstrapCliLayout (integration)", () => {
    it("creates layout, installs version, and activates it", async () => {
      const { ensureLayout, installVersion, activateVersion } = await import("../../../heart/versioning/ouro-version-manager")
      const mkdirCalls: string[] = []
      const symlinkCalls: Array<{ target: string; path: string }> = []

      const sharedDeps = {
        homeDir: "/Users/test",
        mkdirSync: vi.fn().mockImplementation((p: string) => { mkdirCalls.push(p) }),
        execSync: vi.fn(),
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
        unlinkSync: vi.fn(),
        symlinkSync: vi.fn().mockImplementation((target: string, p: string) => { symlinkCalls.push({ target, path: p }) }),
        existsSync: vi.fn().mockReturnValue(false),
      }

      // 1. Create layout
      ensureLayout(sharedDeps)
      expect(mkdirCalls).toContain("/Users/test/.ouro-cli")
      expect(mkdirCalls).toContain("/Users/test/.ouro-cli/bin")
      expect(mkdirCalls).toContain("/Users/test/.ouro-cli/versions")

      // 2. Install version
      installVersion("0.1.0-alpha.80", sharedDeps)
      expect(sharedDeps.execSync).toHaveBeenCalledWith(
        expect.stringContaining("npm install --prefix"),
        expect.anything(),
      )

      // 3. Activate version
      activateVersion("0.1.0-alpha.80", sharedDeps)
      expect(symlinkCalls).toContainEqual({
        target: "/Users/test/.ouro-cli/versions/0.1.0-alpha.80",
        path: "/Users/test/.ouro-cli/CurrentVersion",
      })
    })
  })

  describe("compareCliVersions", () => {
    it("orders alpha-suffixed versions numerically", async () => {
      const { compareCliVersions } = await import("../../../heart/versioning/ouro-version-manager")
      expect(compareCliVersions("0.1.0-alpha.10", "0.1.0-alpha.9")).toBeGreaterThan(0)
      expect(compareCliVersions("0.1.0-alpha.9", "0.1.0-alpha.10")).toBeLessThan(0)
      expect(compareCliVersions("0.1.0-alpha.10", "0.1.0-alpha.10")).toBe(0)
    })

    it("falls back to lex compare for non-alpha versions", async () => {
      const { compareCliVersions } = await import("../../../heart/versioning/ouro-version-manager")
      // Both fall through to lex compare
      expect(compareCliVersions("0.2.0", "0.1.0")).toBeGreaterThan(0)
      expect(compareCliVersions("0.1.0", "0.2.0")).toBeLessThan(0)
      expect(compareCliVersions("0.1.0", "0.1.0")).toBe(0)
    })

    it("handles mixed alpha + non-alpha consistently via lex fallback", async () => {
      const { compareCliVersions } = await import("../../../heart/versioning/ouro-version-manager")
      // One side has alpha, one doesn't — both fall through to lex compare
      // because the regex match condition requires both to have alpha tails.
      const result = compareCliVersions("0.1.0", "0.1.0-alpha.10")
      expect(result).not.toBe(0)
    })
  })

  describe("selectVersionsToPrune", () => {
    it("returns empty when installed count is at or below retain", async () => {
      const { selectVersionsToPrune } = await import("../../../heart/versioning/ouro-version-manager")
      expect(selectVersionsToPrune(["0.1.0-alpha.1", "0.1.0-alpha.2"], { current: null, previous: null }, 5)).toEqual([])
      expect(selectVersionsToPrune(["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.3", "0.1.0-alpha.4", "0.1.0-alpha.5"], { current: null, previous: null }, 5)).toEqual([])
    })

    it("keeps the N most recent and deletes the rest", async () => {
      const { selectVersionsToPrune } = await import("../../../heart/versioning/ouro-version-manager")
      const installed = [
        "0.1.0-alpha.85",
        "0.1.0-alpha.90",
        "0.1.0-alpha.100",
        "0.1.0-alpha.95",
        "0.1.0-alpha.110",
        "0.1.0-alpha.120",
        "0.1.0-alpha.115",
      ]
      const result = selectVersionsToPrune(installed, { current: null, previous: null }, 3)
      // Sorted descending: 120, 115, 110, 100, 95, 90, 85
      // Keep top 3: 120, 115, 110
      // Delete: 100, 95, 90, 85
      expect(new Set(result)).toEqual(new Set(["0.1.0-alpha.85", "0.1.0-alpha.90", "0.1.0-alpha.95", "0.1.0-alpha.100"]))
    })

    it("always preserves the currently-active version even if older than the retention window", async () => {
      const { selectVersionsToPrune } = await import("../../../heart/versioning/ouro-version-manager")
      const installed = ["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.3", "0.1.0-alpha.4", "0.1.0-alpha.5"]
      const result = selectVersionsToPrune(installed, { current: "0.1.0-alpha.1", previous: null }, 2)
      // Top 2 are alpha.5 and alpha.4. alpha.1 is preserved because it's current.
      // Delete: alpha.2, alpha.3
      expect(new Set(result)).toEqual(new Set(["0.1.0-alpha.2", "0.1.0-alpha.3"]))
      expect(result).not.toContain("0.1.0-alpha.1")
    })

    it("always preserves the previous version so rollback stays available", async () => {
      const { selectVersionsToPrune } = await import("../../../heart/versioning/ouro-version-manager")
      const installed = ["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.3", "0.1.0-alpha.4", "0.1.0-alpha.5"]
      const result = selectVersionsToPrune(installed, { current: "0.1.0-alpha.5", previous: "0.1.0-alpha.1" }, 2)
      // Top 2: alpha.5, alpha.4. alpha.5 = current. alpha.1 = previous. All protected.
      // Delete: alpha.2, alpha.3
      expect(new Set(result)).toEqual(new Set(["0.1.0-alpha.2", "0.1.0-alpha.3"]))
      expect(result).not.toContain("0.1.0-alpha.1")
      expect(result).not.toContain("0.1.0-alpha.5")
    })
  })

  describe("pruneOldVersions", () => {
    it("deletes versions outside retention window via injected rmSync", async () => {
      const { pruneOldVersions } = await import("../../../heart/versioning/ouro-version-manager")

      const rmCalls: string[] = []
      const result = pruneOldVersions(3, {
        homeDir: "/Users/test",
        readdirSync: vi.fn().mockImplementation(() => [
          { name: "0.1.0-alpha.85", isDirectory: () => true },
          { name: "0.1.0-alpha.90", isDirectory: () => true },
          { name: "0.1.0-alpha.100", isDirectory: () => true },
          { name: "0.1.0-alpha.110", isDirectory: () => true },
          { name: "0.1.0-alpha.120", isDirectory: () => true },
        ]) as any,
        readlinkSync: vi.fn().mockImplementation((p: string) => {
          if (p.endsWith("CurrentVersion")) return "/Users/test/.ouro-cli/versions/0.1.0-alpha.120"
          if (p.endsWith("previous")) return "/Users/test/.ouro-cli/versions/0.1.0-alpha.110"
          throw new Error("ENOENT")
        }),
        rmSync: vi.fn().mockImplementation((p: string) => { rmCalls.push(p) }),
      })

      // Top 3: 120, 110, 100. current=120 (in top 3). previous=110 (in top 3).
      // Delete: alpha.85, alpha.90
      expect(new Set(result.deleted)).toEqual(new Set(["0.1.0-alpha.85", "0.1.0-alpha.90"]))
      expect(result.failed).toEqual([])
      expect(rmCalls).toContain("/Users/test/.ouro-cli/versions/0.1.0-alpha.85")
      expect(rmCalls).toContain("/Users/test/.ouro-cli/versions/0.1.0-alpha.90")
    })

    it("returns empty result when versions dir is missing or unreadable", async () => {
      const { pruneOldVersions } = await import("../../../heart/versioning/ouro-version-manager")

      const result = pruneOldVersions(3, {
        homeDir: "/Users/test",
        readdirSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }) as any,
        readlinkSync: vi.fn(),
        rmSync: vi.fn(),
      })

      expect(result).toEqual({ kept: [], deleted: [], failed: [] })
    })

    it("captures per-version delete failures without aborting the rest", async () => {
      const { pruneOldVersions } = await import("../../../heart/versioning/ouro-version-manager")

      let callCount = 0
      const result = pruneOldVersions(2, {
        homeDir: "/Users/test",
        readdirSync: vi.fn().mockImplementation(() => [
          { name: "0.1.0-alpha.1", isDirectory: () => true },
          { name: "0.1.0-alpha.2", isDirectory: () => true },
          { name: "0.1.0-alpha.3", isDirectory: () => true },
          { name: "0.1.0-alpha.4", isDirectory: () => true },
        ]) as any,
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
        rmSync: vi.fn().mockImplementation(() => {
          callCount++
          if (callCount === 1) throw new Error("permission denied")
        }),
      })

      // Top 2: alpha.4, alpha.3. Delete: alpha.1, alpha.2
      // First delete throws, second succeeds.
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]!.error).toBe("permission denied")
      expect(result.deleted).toHaveLength(1)
    })

    it("handles missing CurrentVersion / previous symlinks (no protection)", async () => {
      const { pruneOldVersions } = await import("../../../heart/versioning/ouro-version-manager")

      const rmCalls: string[] = []
      const result = pruneOldVersions(2, {
        homeDir: "/Users/test",
        readdirSync: vi.fn().mockImplementation(() => [
          { name: "0.1.0-alpha.1", isDirectory: () => true },
          { name: "0.1.0-alpha.2", isDirectory: () => true },
          { name: "0.1.0-alpha.3", isDirectory: () => true },
          { name: "0.1.0-alpha.4", isDirectory: () => true },
        ]) as any,
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
        rmSync: vi.fn().mockImplementation((p: string) => { rmCalls.push(p) }),
      })

      // Top 2: alpha.4, alpha.3. Nothing protected. Delete: alpha.1, alpha.2
      expect(new Set(result.deleted)).toEqual(new Set(["0.1.0-alpha.1", "0.1.0-alpha.2"]))
    })

    it("filters out non-directory entries from the versions directory", async () => {
      const { pruneOldVersions } = await import("../../../heart/versioning/ouro-version-manager")

      const result = pruneOldVersions(2, {
        homeDir: "/Users/test",
        readdirSync: vi.fn().mockImplementation(() => [
          { name: "0.1.0-alpha.1", isDirectory: () => true },
          { name: ".DS_Store", isDirectory: () => false },
          { name: "0.1.0-alpha.2", isDirectory: () => true },
          { name: "0.1.0-alpha.3", isDirectory: () => true },
        ]) as any,
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
        rmSync: vi.fn(),
      })

      expect(result.kept.length + result.deleted.length).toBe(3) // .DS_Store excluded
    })
  })
})
