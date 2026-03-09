import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { registerOuroBundleUti } from "../../../heart/daemon/ouro-uti"

describe(".ouro UTI registration", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.unmock("child_process")
  })

  it("skips registration outside macOS", () => {
    const execFileSync = vi.fn()

    const result = registerOuroBundleUti({
      platform: "linux",
      execFileSync,
    })

    expect(result.attempted).toBe(false)
    expect(result.registered).toBe(false)
    expect(result.skippedReason).toBe("non-macos")
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it("registers UTI on macOS and skips icon conversion when source image is missing", () => {
    const execFileSync = vi.fn()
    const existsSync = vi.fn((target: string) => !target.endsWith("ouroboros.png"))
    const mkdirSync = vi.fn()
    const writeFileSync = vi.fn()
    const rmSync = vi.fn()

    const result = registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync,
      mkdirSync,
      writeFileSync,
      rmSync,
      execFileSync,
    })

    expect(result.attempted).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.iconInstalled).toBe(false)
    expect(execFileSync).toHaveBeenCalledWith(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", "/tmp/home/Library/Application Support/ouro/uti/OuroBundleRegistry.app"],
    )

    const invokedCommands = execFileSync.mock.calls.map((call) => call[0] as string)
    expect(invokedCommands).not.toContain("sips")
    expect(invokedCommands).not.toContain("iconutil")
  })

  it("builds icns icon and registers UTI on macOS when source image exists", () => {
    const execFileSync = vi.fn()
    const existsSync = vi.fn(() => true)
    const mkdirSync = vi.fn()
    const writeFileSync = vi.fn()
    const rmSync = vi.fn()

    const result = registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync,
      mkdirSync,
      writeFileSync,
      rmSync,
      execFileSync,
    })

    expect(result.attempted).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.iconInstalled).toBe(true)

    const invokedCommands = execFileSync.mock.calls.map((call) => call[0] as string)
    expect(invokedCommands).toContain("sips")
    expect(invokedCommands).toContain("iconutil")
    expect(invokedCommands).toContain(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    )
  })

  it("returns non-blocking failure result when registration command errors", () => {
    const execFileSync = vi.fn((file: string) => {
      if (file.endsWith("lsregister")) {
        throw new Error("lsregister failed")
      }
    })

    const result = registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync: vi.fn((target: string) => !target.endsWith("ouroboros.png")),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      rmSync: vi.fn(),
      execFileSync,
    })

    expect(result.attempted).toBe(true)
    expect(result.registered).toBe(false)
    expect(result.skippedReason).toContain("lsregister failed")
  })

  it("continues registration when icon conversion fails", () => {
    const execFileSync = vi.fn((file: string) => {
      if (file === "sips") {
        throw "sips failed"
      }
    })
    const rmSync = vi.fn()

    const result = registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      rmSync,
      execFileSync,
    })

    expect(result.attempted).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.iconInstalled).toBe(false)
    expect(execFileSync).toHaveBeenCalledWith(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", "/tmp/home/Library/Application Support/ouro/uti/OuroBundleRegistry.app"],
    )
    expect(rmSync).toHaveBeenCalledWith("/tmp/home/Library/Application Support/ouro/uti/ouro.iconset", {
      recursive: true,
      force: true,
    })
  })

  it("continues registration when icon conversion throws an Error instance", () => {
    const execFileSync = vi.fn((file: string) => {
      if (file === "sips") {
        throw new Error("sips error instance")
      }
    })

    const result = registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      rmSync: vi.fn(),
      execFileSync,
    })

    expect(result.attempted).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.iconInstalled).toBe(false)
  })

  it("uses default fs/exec dependencies and returns non-blocking failure on non-Error setup failure", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-uti-defaults-home-"))
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-uti-defaults-repo-"))

    const result = registerOuroBundleUti({
      platform: "darwin",
      homeDir: tempHome,
      repoRoot: tempRepo,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(() => {
        throw "mkdir failed"
      }),
    })

    expect(result.attempted).toBe(true)
    expect(result.registered).toBe(false)
    expect(result.skippedReason).toContain("mkdir failed")
  })

  it("uses default home/repo/fs dependencies when omitted", async () => {
    vi.resetModules()
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-uti-default-home-"))
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-uti-default-repo-"))
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => tempHome }
    })
    vi.doMock("../../../heart/identity", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
      return { ...actual, getRepoRoot: () => tempRepo }
    })
    const { registerOuroBundleUti: registerWithDefaultDeps } = await import("../../../heart/daemon/ouro-uti")
    const execFileSync = vi.fn()

    const result = registerWithDefaultDeps({
      platform: "darwin",
      execFileSync,
    })

    expect(result.registered).toBe(true)
    expect(result.registrationBundlePath).toBe(
      path.join(tempHome, "Library", "Application Support", "ouro", "uti", "OuroBundleRegistry.app"),
    )
    expect(execFileSync).toHaveBeenCalledWith(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", path.join(tempHome, "Library", "Application Support", "ouro", "uti", "OuroBundleRegistry.app")],
    )

    fs.rmSync(tempHome, { recursive: true, force: true })
    fs.rmSync(tempRepo, { recursive: true, force: true })
  })

  it("plist conforms to com.apple.package for directory-as-package semantics", () => {
    const writeFileSync = vi.fn()

    registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync: vi.fn((target: string) => !target.endsWith("ouroboros.png")),
      mkdirSync: vi.fn(),
      writeFileSync,
      rmSync: vi.fn(),
      execFileSync: vi.fn(),
    })

    const plistContent = writeFileSync.mock.calls[0][1] as string
    expect(plistContent).toContain("com.apple.package")
    expect(plistContent).toContain("public.folder")
  })

  it("plist includes LSTypeIsPackage for Finder package display", () => {
    const writeFileSync = vi.fn()

    registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync: vi.fn((target: string) => !target.endsWith("ouroboros.png")),
      mkdirSync: vi.fn(),
      writeFileSync,
      rmSync: vi.fn(),
      execFileSync: vi.fn(),
    })

    const plistContent = writeFileSync.mock.calls[0][1] as string
    expect(plistContent).toContain("LSTypeIsPackage")
    expect(plistContent).toContain("<true/>")
  })

  it("prefers bundled assets/ouroboros.png over adjacent repo path", () => {
    const existsSync = vi.fn((target: string) => {
      // Bundled asset exists
      if (target.includes("assets/ouroboros.png")) return true
      return false
    })
    const execFileSync = vi.fn()
    const mkdirSync = vi.fn()
    const writeFileSync = vi.fn()
    const rmSync = vi.fn()

    const result = registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync,
      mkdirSync,
      writeFileSync,
      rmSync,
      execFileSync,
    })

    expect(result.attempted).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.iconInstalled).toBe(true)

    // sips args: ["-z", size, size, sourcePath, "--out", outPath]
    const sipsCalls = execFileSync.mock.calls.filter((c) => c[0] === "sips")
    expect(sipsCalls.length).toBeGreaterThan(0)
    // The source image path (index 3 of args) should be the bundled asset
    const sourceImagePath = sipsCalls[0][1][3] as string
    expect(sourceImagePath).toContain("assets/ouroboros.png")
    expect(sourceImagePath).not.toContain("ouroboros-website")
  })

  it("falls back to adjacent repo icon path when bundled asset is missing", () => {
    const existsSync = vi.fn((target: string) => {
      // Only the adjacent repo path exists
      if (target.includes("ouroboros-website")) return true
      return false
    })
    const execFileSync = vi.fn()

    const result = registerOuroBundleUti({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      rmSync: vi.fn(),
      execFileSync,
    })

    expect(result.attempted).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.iconInstalled).toBe(true)

    // sips args: ["-z", size, size, sourcePath, "--out", outPath]
    const sipsCalls = execFileSync.mock.calls.filter((c) => c[0] === "sips")
    const sourceImagePath = sipsCalls[0][1][3] as string
    expect(sourceImagePath).toContain("ouroboros-website")
  })

  it("uses default exec callback when execFileSync dep is omitted", async () => {
    vi.resetModules()
    const execFileSync = vi.fn()
    vi.doMock("child_process", () => ({ execFileSync }))

    const { registerOuroBundleUti: registerWithDefaultExec } = await import("../../../heart/daemon/ouro-uti")
    const result = registerWithDefaultExec({
      platform: "darwin",
      homeDir: "/tmp/home",
      repoRoot: "/tmp/repo",
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      rmSync: vi.fn(),
    })

    expect(result.registered).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", "/tmp/home/Library/Application Support/ouro/uti/OuroBundleRegistry.app"],
    )
  })
})
