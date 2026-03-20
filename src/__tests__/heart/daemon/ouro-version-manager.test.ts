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
      const { getOuroCliHome } = await import("../../../heart/daemon/ouro-version-manager")
      const result = getOuroCliHome("/Users/test")
      expect(result).toBe("/Users/test/.ouro-cli")
    })
  })

  describe("getCurrentVersion", () => {
    it("resolves CurrentVersion symlink and extracts version directory name", async () => {
      const { getCurrentVersion } = await import("../../../heart/daemon/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockReturnValue("/Users/test/.ouro-cli/versions/0.1.0-alpha.80"),
      }
      const result = getCurrentVersion(deps)
      expect(result).toBe("0.1.0-alpha.80")
      expect(deps.readlinkSync).toHaveBeenCalledWith("/Users/test/.ouro-cli/CurrentVersion")
    })

    it("returns null when symlink does not exist", async () => {
      const { getCurrentVersion } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { getPreviousVersion } = await import("../../../heart/daemon/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockReturnValue("/Users/test/.ouro-cli/versions/0.1.0-alpha.79"),
      }
      const result = getPreviousVersion(deps)
      expect(result).toBe("0.1.0-alpha.79")
      expect(deps.readlinkSync).toHaveBeenCalledWith("/Users/test/.ouro-cli/previous")
    })

    it("returns null when symlink does not exist", async () => {
      const { getPreviousVersion } = await import("../../../heart/daemon/ouro-version-manager")
      const deps = {
        homeDir: "/Users/test",
        readlinkSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT") }),
      }
      const result = getPreviousVersion(deps)
      expect(result).toBeNull()
    })
  })

  describe("listInstalledVersions", () => {
    it("reads versions/ directory and returns entries", async () => {
      const { listInstalledVersions } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { listInstalledVersions } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { installVersion } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { installVersion } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { activateVersion } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { activateVersion } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { activateVersion } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { ensureLayout } = await import("../../../heart/daemon/ouro-version-manager")
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
      const { ensureLayout, installVersion, activateVersion } = await import("../../../heart/daemon/ouro-version-manager")
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
})
