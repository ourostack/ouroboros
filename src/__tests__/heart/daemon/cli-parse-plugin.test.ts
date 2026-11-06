import { describe, it, expect } from "vitest"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"

describe("parsePluginCommand — install", () => {
  it("parses 'plugin install <source>'", () => {
    const cmd = parseOuroCommand([
      "plugin",
      "install",
      "github:ourostack/ouroboros-skills:plugins/desk",
    ])
    expect(cmd.kind).toBe("plugin.install")
    if (cmd.kind === "plugin.install") {
      expect(cmd.source).toBe("github:ourostack/ouroboros-skills:plugins/desk")
      expect(cmd.agent).toBeUndefined()
      expect(cmd.version).toBeUndefined()
    }
  })

  it("parses --agent + --version flags", () => {
    const cmd = parseOuroCommand([
      "plugin",
      "install",
      "github:ourostack/ouroboros-skills:plugins/desk",
      "--agent",
      "slugger",
      "--version",
      "0.1.0",
    ])
    expect(cmd.kind).toBe("plugin.install")
    if (cmd.kind === "plugin.install") {
      expect(cmd.source).toBe("github:ourostack/ouroboros-skills:plugins/desk")
      expect(cmd.agent).toBe("slugger")
      expect(cmd.version).toBe("0.1.0")
    }
  })

  it("throws when source is missing", () => {
    expect(() => parseOuroCommand(["plugin", "install"])).toThrow(/source/)
  })
})

describe("parsePluginCommand — list", () => {
  it("parses 'plugin list'", () => {
    const cmd = parseOuroCommand(["plugin", "list"])
    expect(cmd.kind).toBe("plugin.list")
    if (cmd.kind === "plugin.list") {
      expect(cmd.agent).toBeUndefined()
    }
  })

  it("parses 'plugin list --agent <name>'", () => {
    const cmd = parseOuroCommand(["plugin", "list", "--agent", "slugger"])
    expect(cmd.kind).toBe("plugin.list")
    if (cmd.kind === "plugin.list") {
      expect(cmd.agent).toBe("slugger")
    }
  })
})

describe("parsePluginCommand — remove", () => {
  it("parses 'plugin remove <id>'", () => {
    const cmd = parseOuroCommand(["plugin", "remove", "desk"])
    expect(cmd.kind).toBe("plugin.remove")
    if (cmd.kind === "plugin.remove") {
      expect(cmd.pluginId).toBe("desk")
      expect(cmd.agent).toBeUndefined()
    }
  })

  it("parses 'plugin remove <id> --agent <name>'", () => {
    const cmd = parseOuroCommand([
      "plugin",
      "remove",
      "desk",
      "--agent",
      "slugger",
    ])
    expect(cmd.kind).toBe("plugin.remove")
    if (cmd.kind === "plugin.remove") {
      expect(cmd.pluginId).toBe("desk")
      expect(cmd.agent).toBe("slugger")
    }
  })

  it("throws when plugin id is missing", () => {
    expect(() => parseOuroCommand(["plugin", "remove"])).toThrow(/plugin id/)
  })
})

describe("parsePluginCommand — error paths", () => {
  it("throws on unknown subcommand", () => {
    expect(() => parseOuroCommand(["plugin", "foo"])).toThrow(/Unknown plugin subcommand/)
  })

  it("throws when no subcommand provided", () => {
    expect(() => parseOuroCommand(["plugin"])).toThrow(/subcommand/)
  })
})

describe("parsePluginCommand — --no-deps flag", () => {
  it("parses --no-deps on install", () => {
    const cmd = parseOuroCommand([
      "plugin",
      "install",
      "github:ourostack/ouroboros-skills:plugins/desk",
      "--no-deps",
    ])
    expect(cmd.kind).toBe("plugin.install")
    if (cmd.kind === "plugin.install") {
      expect(cmd.noDeps).toBe(true)
    }
  })

  it("omits noDeps when flag absent", () => {
    const cmd = parseOuroCommand([
      "plugin",
      "install",
      "github:ourostack/ouroboros-skills:plugins/desk",
    ])
    expect(cmd.kind).toBe("plugin.install")
    if (cmd.kind === "plugin.install") {
      expect(cmd.noDeps).toBeUndefined()
    }
  })
})
