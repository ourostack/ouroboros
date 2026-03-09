import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  generateDaemonPlist,
  installLaunchAgent,
  uninstallLaunchAgent,
  isDaemonInstalled,
  DAEMON_PLIST_LABEL,
} from "../../../heart/daemon/launchd"
import type { LaunchdDeps, DaemonPlistOptions } from "../../../heart/daemon/launchd"

describe("launchd daemon management", () => {
  let tmpHome: string
  let launchAgentsDir: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-test-"))
    launchAgentsDir = path.join(tmpHome, "Library", "LaunchAgents")
    fs.mkdirSync(launchAgentsDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function makeDeps(overrides?: Partial<LaunchdDeps>): LaunchdDeps {
    return {
      exec: vi.fn(),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      removeFile: (p: string) => fs.rmSync(p, { force: true }),
      existsFile: (p: string) => fs.existsSync(p),
      mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
      homeDir: tmpHome,
      ...overrides,
    }
  }

  const defaultPlistOptions: DaemonPlistOptions = {
    entryPath: "/usr/local/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-bot-entry.js",
    socketPath: "/tmp/ouro-daemon.sock",
    nodePath: "/usr/local/bin/node",
  }

  describe("DAEMON_PLIST_LABEL", () => {
    it("is bot.ouro.daemon", () => {
      expect(DAEMON_PLIST_LABEL).toBe("bot.ouro.daemon")
    })
  })

  describe("generateDaemonPlist", () => {
    it("generates valid plist XML with correct ProgramArguments", () => {
      const xml = generateDaemonPlist(defaultPlistOptions)

      expect(xml).toContain("<!DOCTYPE plist")
      expect(xml).toContain("<plist version=\"1.0\">")
      expect(xml).toContain(`<string>${DAEMON_PLIST_LABEL}</string>`)
      expect(xml).toContain("<string>/usr/local/bin/node</string>")
      expect(xml).toContain("<string>/usr/local/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-bot-entry.js</string>")
      expect(xml).toContain("<string>--socket</string>")
      expect(xml).toContain("<string>/tmp/ouro-daemon.sock</string>")
    })

    it("includes KeepAlive true", () => {
      const xml = generateDaemonPlist(defaultPlistOptions)

      expect(xml).toContain("<key>KeepAlive</key>")
      expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    })

    it("includes StandardOutPath and StandardErrorPath when logDir provided", () => {
      const xml = generateDaemonPlist({
        ...defaultPlistOptions,
        logDir: "/tmp/logs",
      })

      expect(xml).toContain("<key>StandardOutPath</key>")
      expect(xml).toContain("<key>StandardErrorPath</key>")
      expect(xml).toContain("/tmp/logs")
    })

    it("includes Label key", () => {
      const xml = generateDaemonPlist(defaultPlistOptions)

      expect(xml).toContain("<key>Label</key>")
      expect(xml).toContain(`<string>${DAEMON_PLIST_LABEL}</string>`)
    })

    it("omits log paths when logDir is not provided", () => {
      const xml = generateDaemonPlist({
        entryPath: "/path/entry.js",
        socketPath: "/tmp/sock",
        nodePath: "/usr/bin/node",
      })

      // Should still be valid plist but without StandardOutPath/StandardErrorPath
      expect(xml).toContain("<plist version=\"1.0\">")
    })
  })

  describe("installLaunchAgent", () => {
    it("writes plist file and calls launchctl load", () => {
      const deps = makeDeps()

      installLaunchAgent(deps, defaultPlistOptions)

      const plistPath = path.join(launchAgentsDir, `${DAEMON_PLIST_LABEL}.plist`)
      expect(fs.existsSync(plistPath)).toBe(true)
      const content = fs.readFileSync(plistPath, "utf-8")
      expect(content).toContain("<plist version=\"1.0\">")

      expect(deps.exec).toHaveBeenCalledWith(
        expect.stringContaining("launchctl load"),
      )
    })

    it("unloads existing plist before loading new one (idempotent install)", () => {
      const deps = makeDeps()

      // Pre-install a plist
      const plistPath = path.join(launchAgentsDir, `${DAEMON_PLIST_LABEL}.plist`)
      fs.writeFileSync(plistPath, "old-plist", "utf-8")

      installLaunchAgent(deps, defaultPlistOptions)

      // Should call unload first (best effort), then load
      expect(deps.exec).toHaveBeenCalledWith(
        expect.stringContaining("launchctl unload"),
      )
      expect(deps.exec).toHaveBeenCalledWith(
        expect.stringContaining("launchctl load"),
      )
    })

    it("handles launchctl unload failure gracefully during idempotent install", () => {
      const exec = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("unload")) throw new Error("not loaded")
      })
      const deps = makeDeps({ exec })

      const plistPath = path.join(launchAgentsDir, `${DAEMON_PLIST_LABEL}.plist`)
      fs.writeFileSync(plistPath, "old-plist", "utf-8")

      expect(() => installLaunchAgent(deps, defaultPlistOptions)).not.toThrow()
    })

    it("creates LaunchAgents directory if it does not exist", () => {
      const newHome = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-newdir-"))
      const deps = makeDeps({ homeDir: newHome })

      installLaunchAgent(deps, defaultPlistOptions)

      const newLaunchAgentsDir = path.join(newHome, "Library", "LaunchAgents")
      expect(fs.existsSync(newLaunchAgentsDir)).toBe(true)

      fs.rmSync(newHome, { recursive: true, force: true })
    })
  })

  describe("uninstallLaunchAgent", () => {
    it("calls launchctl unload and removes plist file", () => {
      const deps = makeDeps()
      const plistPath = path.join(launchAgentsDir, `${DAEMON_PLIST_LABEL}.plist`)
      fs.writeFileSync(plistPath, "test-plist", "utf-8")

      uninstallLaunchAgent(deps)

      expect(deps.exec).toHaveBeenCalledWith(
        expect.stringContaining("launchctl unload"),
      )
      expect(fs.existsSync(plistPath)).toBe(false)
    })

    it("handles missing plist file gracefully", () => {
      const deps = makeDeps()

      expect(() => uninstallLaunchAgent(deps)).not.toThrow()
    })

    it("handles launchctl unload failure gracefully", () => {
      const exec = vi.fn().mockImplementation(() => {
        throw new Error("not loaded")
      })
      const deps = makeDeps({ exec })
      const plistPath = path.join(launchAgentsDir, `${DAEMON_PLIST_LABEL}.plist`)
      fs.writeFileSync(plistPath, "test-plist", "utf-8")

      expect(() => uninstallLaunchAgent(deps)).not.toThrow()
      expect(fs.existsSync(plistPath)).toBe(false)
    })
  })

  describe("isDaemonInstalled", () => {
    it("returns true when plist file exists", () => {
      const deps = makeDeps()
      const plistPath = path.join(launchAgentsDir, `${DAEMON_PLIST_LABEL}.plist`)
      fs.writeFileSync(plistPath, "plist-content", "utf-8")

      expect(isDaemonInstalled(deps)).toBe(true)
    })

    it("returns false when plist file does not exist", () => {
      const deps = makeDeps()

      expect(isDaemonInstalled(deps)).toBe(false)
    })
  })
})
