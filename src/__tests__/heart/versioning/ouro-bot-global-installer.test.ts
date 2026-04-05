import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  syncGlobalOuroBotWrapper,
  type GlobalOuroBotInstallerDeps,
} from "../../../heart/versioning/ouro-bot-global-installer"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("syncGlobalOuroBotWrapper", () => {
  let files: Record<string, string>
  let installedCommands: string[][]

  function makeDeps(overrides: Partial<GlobalOuroBotInstallerDeps> = {}): GlobalOuroBotInstallerDeps {
    return {
      runtimeVersion: "0.1.0-alpha.29",
      platform: "darwin",
      execFileSync: (file, args) => {
        if (file === "npm" && args[0] === "prefix") return "/opt/homebrew"
        if (file === "npm" && args[0] === "root") return "/opt/homebrew/lib/node_modules"
        if (file === "npm" && args[0] === "install") {
          installedCommands.push(args)
          return ""
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`)
      },
      existsSync: (target) => Object.prototype.hasOwnProperty.call(files, target),
      readFileSync: (target) => {
        const value = files[target]
        if (value === undefined) throw new Error("ENOENT")
        return value
      },
      realpathSync: (target) => {
        const value = files[target]
        if (value === undefined) throw new Error("ENOENT")
        return value
      },
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    files = {}
    installedCommands = []
  })

  it("skips when the current wrapper version already owns the global ouro.bot binary", () => {
    files["/opt/homebrew/lib/node_modules/ouro.bot/package.json"] = JSON.stringify({ version: "0.1.0-alpha.21" })
    files["/opt/homebrew/bin/ouro.bot"] = "/opt/homebrew/lib/node_modules/ouro.bot/index.js"

    const result = syncGlobalOuroBotWrapper(makeDeps())

    expect(result.installed).toBe(false)
    expect(result.installedVersion).toBe("0.1.0-alpha.21")
    expect(result.executableOwner).toBe("wrapper")
    expect(installedCommands).toHaveLength(0)
  })

  it("force-installs the wrapper when a stale CLI package owns the ouro.bot binary", () => {
    files["/opt/homebrew/lib/node_modules/@ouro.bot/cli/package.json"] = JSON.stringify({ version: "0.1.0-alpha.26" })
    files["/opt/homebrew/bin/ouro.bot"] = "/opt/homebrew/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-bot-entry.js"

    const result = syncGlobalOuroBotWrapper(makeDeps())

    expect(result.installed).toBe(true)
    expect(result.executableOwner).toBe("cli")
    expect(installedCommands).toEqual([["install", "-g", "--force", "ouro.bot@latest"]])
  })

  it("installs the wrapper when it is missing entirely", () => {
    const result = syncGlobalOuroBotWrapper(makeDeps())

    expect(result.installed).toBe(true)
    expect(result.installedVersion).toBeNull()
    expect(result.executableOwner).toBeNull()
    expect(installedCommands).toEqual([["install", "-g", "--force", "ouro.bot@latest"]])
  })

  it("normalizes buffer output from npm commands", () => {
    const result = syncGlobalOuroBotWrapper(makeDeps({
      execFileSync: (file, args) => {
        if (file === "npm" && args[0] === "prefix") return Buffer.from("/opt/homebrew\n")
        if (file === "npm" && args[0] === "root") return Buffer.from("/opt/homebrew/lib/node_modules\n")
        if (file === "npm" && args[0] === "install") {
          installedCommands.push(args)
          return Buffer.from("")
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`)
      },
    }))

    expect(result.installed).toBe(true)
    expect(installedCommands).toEqual([["install", "-g", "--force", "ouro.bot@latest"]])
  })

  it("treats unreadable wrapper package metadata as missing and repairs forward", () => {
    files["/opt/homebrew/lib/node_modules/ouro.bot/package.json"] = "{not-json"
    files["/opt/homebrew/bin/ouro.bot"] = "/opt/homebrew/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-bot-entry.js"

    const result = syncGlobalOuroBotWrapper(makeDeps())

    expect(result.installed).toBe(true)
    expect(result.installedVersion).toBeNull()
    expect(result.executableOwner).toBe("cli")
    expect(installedCommands).toEqual([["install", "-g", "--force", "ouro.bot@latest"]])
  })

  it("repairs when the ouro.bot binary exists but its target cannot be resolved", () => {
    files["/opt/homebrew/lib/node_modules/ouro.bot/package.json"] = JSON.stringify({ version: "0.1.0-alpha.29" })
    files["/opt/homebrew/bin/ouro.bot"] = "broken-link"

    const result = syncGlobalOuroBotWrapper(makeDeps({
      realpathSync: () => { throw new Error("ENOENT") },
    }))

    expect(result.installed).toBe(true)
    expect(result.installedVersion).toBe("0.1.0-alpha.29")
    expect(result.executableOwner).toBe("unknown")
    expect(installedCommands).toEqual([["install", "-g", "--force", "ouro.bot@latest"]])
  })

  it("repairs when another package owns the ouro.bot binary", () => {
    files["/opt/homebrew/lib/node_modules/ouro.bot/package.json"] = JSON.stringify({ version: "0.1.0-alpha.29" })
    files["/opt/homebrew/bin/ouro.bot"] = "/opt/homebrew/lib/node_modules/some-other-package/bin.js"

    const result = syncGlobalOuroBotWrapper(makeDeps())

    expect(result.installed).toBe(true)
    expect(result.installedVersion).toBe("0.1.0-alpha.29")
    expect(result.executableOwner).toBe("other")
    expect(installedCommands).toEqual([["install", "-g", "--force", "ouro.bot@latest"]])
  })

  it("repairs when wrapper metadata lacks a usable version string", () => {
    files["/opt/homebrew/lib/node_modules/ouro.bot/package.json"] = JSON.stringify({ version: "   " })
    files["/opt/homebrew/bin/ouro.bot"] = "/opt/homebrew/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-bot-entry.js"

    const result = syncGlobalOuroBotWrapper(makeDeps())

    expect(result.installed).toBe(true)
    expect(result.installedVersion).toBeNull()
    expect(result.executableOwner).toBe("cli")
    expect(installedCommands).toEqual([["install", "-g", "--force", "ouro.bot@latest"]])
  })

  it("uses the windows global bin path when evaluating ownership", () => {
    files["/opt/homebrew/lib/node_modules/ouro.bot/package.json"] = JSON.stringify({ version: "0.1.0-alpha.29" })
    files["/opt/homebrew/ouro.bot.cmd"] = "/opt/homebrew/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-bot-entry.js"

    const result = syncGlobalOuroBotWrapper(makeDeps({ platform: "win32" }))

    expect(result.installed).toBe(true)
    expect(result.executableOwner).toBe("cli")
    expect(installedCommands).toEqual([["install", "-g", "--force", "ouro.bot@latest"]])
  })
})
