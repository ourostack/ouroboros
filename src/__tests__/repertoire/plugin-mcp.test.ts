import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"

// Mock fs before importing plugin-mcp
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

// Mock identity — loadAgentConfig + getAgentRoot return what we control
vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(),
  getAgentRoot: vi.fn(() => "/mock/bundles/test.ouro"),
  getAgentName: vi.fn(() => "test"),
}))

// Mock the version manager
vi.mock("../../heart/versioning/ouro-version-manager", () => ({
  getOuroCliHome: vi.fn(() => "/mock/home/.ouro-cli"),
}))

// Track nerves events for audit Rule 5
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import * as fs from "fs"
import { loadAgentConfig } from "../../heart/identity"

describe("plugin-mcp.ts — listPluginMcpServers", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.statSync).mockReset()
    vi.mocked(loadAgentConfig).mockReset()
    nervesEvents.length = 0
  })

  it("returns empty list when no plugins are enabled", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({ plugins: [] } as any)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    expect(listPluginMcpServers()).toEqual([])
  })

  it("returns one server entry for a plugin with .mcp.json present", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "desk", enabled: true }],
    } as any)
    // First call: plugins root exists; second: plugin dir exists; third: .mcp.json exists
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      // plugins root, plugin dir, .mcp.json all exist
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "desk"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["desk"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        desk: {
          type: "stdio",
          command: "node",
          args: ["./mcp/index.js", "--root", "${DESK:-./desk}"],
          env: {},
        },
      },
    }))

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const servers = listPluginMcpServers()
    expect(servers).toHaveLength(1)
    expect(servers[0].pluginId).toBe("desk")
    expect(servers[0].serverName).toBe("desk")
    expect(servers[0].command).toBe("node")
    // ${DESK:-./desk} resolved to <bundle>/desk
    expect(servers[0].args).toEqual([
      "./mcp/index.js",
      "--root",
      path.join("/mock/bundles/test.ouro", "desk"),
    ])
    expect(servers[0].cwd).toBe(
      path.join("/mock/home/.ouro-cli", "plugins", "desk"),
    )
  })

  it("skips plugins with no .mcp.json cleanly (no error)", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "deskless", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins") || s.endsWith(path.join("plugins", "deskless"))
      // NB: .mcp.json absent
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["deskless"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    expect(listPluginMcpServers()).toEqual([])
  })

  it("skips invalid JSON cleanly (no error) and emits a nerves error event", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "broken", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "broken"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["broken"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue("not json at all }}}")

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const servers = listPluginMcpServers()
    expect(servers).toEqual([])
    const errEvent = nervesEvents.find((e) => e.event === "plugin_mcp.parse_error")
    expect(errEvent).toBeTruthy()
  })

  it("resolves ${VAR:-default} using process.env when VAR is set", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "envplug", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "envplug"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["envplug"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        envplug: {
          command: "${MY_CMD:-defaultcmd}",
          args: ["--flag=${OTHER:-fallback}"],
          env: { TOKEN: "${MY_TOKEN:-blank}" },
        },
      },
    }))

    process.env.MY_CMD = "explicit-cmd"
    process.env.MY_TOKEN = "secret-token"
    delete process.env.OTHER

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const servers = listPluginMcpServers()

    delete process.env.MY_CMD
    delete process.env.MY_TOKEN

    expect(servers).toHaveLength(1)
    expect(servers[0].command).toBe("explicit-cmd")
    expect(servers[0].args).toEqual(["--flag=fallback"])
    expect(servers[0].env).toEqual({ TOKEN: "secret-token" })
  })

  it("DESK var defaults to <agent-bundle>/desk when unset", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "desk", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "desk"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["desk"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        desk: {
          command: "node",
          args: ["--root", "${DESK:-./desk}"],
          env: {},
        },
      },
    }))

    delete process.env.DESK
    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const [server] = listPluginMcpServers()
    expect(server.args).toEqual([
      "--root",
      path.join("/mock/bundles/test.ouro", "desk"),
    ])
  })

  it("returns multiple servers across multiple plugins", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [
        { id: "desk", enabled: true },
        { id: "browser", enabled: true },
      ],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "desk"))
        || s.endsWith(path.join("plugins", "browser"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue([
      "desk",
      "browser",
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const s = String(p)
      if (s.includes("desk")) {
        return JSON.stringify({
          mcpServers: {
            desk: { command: "node", args: ["./desk-mcp.js"], env: {} },
          },
        }) as any
      }
      return JSON.stringify({
        mcpServers: {
          browser: { command: "npx", args: ["playwright"], env: {} },
        },
      }) as any
    })

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const servers = listPluginMcpServers()
    expect(servers).toHaveLength(2)
    const names = servers.map((s) => `${s.pluginId}/${s.serverName}`).sort()
    expect(names).toEqual(["browser/browser", "desk/desk"])
  })

  it("ignores .mcp.json with no mcpServers map (or wrong shape)", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "shapeless", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "shapeless"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["shapeless"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      // No mcpServers
      somethingElse: { foo: 1 },
    }))

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    expect(listPluginMcpServers()).toEqual([])
  })

  it("skips server entries missing a command (defensive)", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "bad", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "bad"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["bad"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        nocmd: { args: ["x"], env: {} },
        ok: { command: "node", args: ["y"], env: {} },
      },
    }))

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const servers = listPluginMcpServers()
    expect(servers).toHaveLength(1)
    expect(servers[0].serverName).toBe("ok")
  })

  it("supports plain ${VAR} (no default) — empty string when unset", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "nodef", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "nodef"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["nodef"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        nodef: { command: "node", args: ["${SOME_UNSET_VAR}"], env: {} },
      },
    }))

    delete process.env.SOME_UNSET_VAR
    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const [server] = listPluginMcpServers()
    expect(server.args).toEqual([""])
  })

  it("emits start + end nerves events for the audit pairing rule", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({ plugins: [] } as any)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    listPluginMcpServers()
    expect(nervesEvents.find((e) => e.event === "plugin_mcp.list_start")).toBeTruthy()
    expect(nervesEvents.find((e) => e.event === "plugin_mcp.list_end")).toBeTruthy()
  })

  it("skips installed-but-disabled plugins", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [
        { id: "desk", enabled: false },
        { id: "browser", enabled: true },
      ],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "browser"))
        || (s.endsWith(".mcp.json") && s.includes("browser"))
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["desk", "browser"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: { browser: { command: "npx", args: [], env: {} } },
    }))

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const servers = listPluginMcpServers()
    expect(servers).toHaveLength(1)
    expect(servers[0].pluginId).toBe("browser")
  })

  it("breaks out of loop when plugins root doesn't exist (declared plugins but no install dir)", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "desk", enabled: true }],
    } as any)
    // plugins root absent
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    expect(listPluginMcpServers()).toEqual([])
  })

  it("skips a plugin whose install dir is missing (uninstalled but still declared)", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [
        { id: "missing-plugin", enabled: true },
        { id: "desk", enabled: true },
      ],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "desk"))
        || (s.endsWith(".mcp.json") && s.includes("desk"))
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["desk"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: { desk: { command: "node", args: [], env: {} } },
    }))

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const servers = listPluginMcpServers()
    expect(servers).toHaveLength(1)
    expect(servers[0].pluginId).toBe("desk")
  })

  it("treats mcpServers of wrong shape (string/number/null) as empty", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "wrong", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "wrong"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["wrong"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    // mcpServers: "string" — wrong shape
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: "this should be an object",
    }))

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    expect(listPluginMcpServers()).toEqual([])
  })

  it("skips entries that are null or wrong shape (e.g. boolean true) inside mcpServers", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "weird", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "weird"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["weird"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        nullEntry: null,
        emptyCmd: { command: "" },
        ok: { command: "node", args: ["x"], env: {} },
      },
    }))

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const servers = listPluginMcpServers()
    expect(servers.map((s) => s.serverName)).toEqual(["ok"])
  })

  it("uses process.env.DESK verbatim when DESK is explicitly set", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "desk", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "desk"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["desk"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        desk: { command: "node", args: ["--root", "${DESK:-./desk}"], env: {} },
      },
    }))

    process.env.DESK = "/custom/desk/path"
    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const [server] = listPluginMcpServers()
    delete process.env.DESK
    expect(server.args).toEqual(["--root", "/custom/desk/path"])
  })

  it("handles agent config with no plugins field at all", async () => {
    // `config.plugins` is undefined (not [])
    vi.mocked(loadAgentConfig).mockReturnValue({} as any)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    expect(listPluginMcpServers()).toEqual([])
  })

  it("handles server entries with no args / no env (defaults to empty)", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      plugins: [{ id: "minimal", enabled: true }],
    } as any)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith("plugins")
        || s.endsWith(path.join("plugins", "minimal"))
        || s.endsWith(".mcp.json")
    })
    vi.mocked(fs.readdirSync).mockReturnValue(["minimal"] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    // command only — no args, no env
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: { minimal: { command: "node" } },
    }))

    const { listPluginMcpServers } = await import("../../repertoire/plugin-mcp")
    const [server] = listPluginMcpServers()
    expect(server.args).toEqual([])
    expect(server.env).toEqual({})
  })

  it("pluginMcpServerToConfig adapts a PluginMcpServer to McpServerConfig shape", async () => {
    const { pluginMcpServerToConfig } = await import("../../repertoire/plugin-mcp")
    const cfg = pluginMcpServerToConfig({
      pluginId: "desk",
      serverName: "desk",
      command: "node",
      args: ["--root", "/x"],
      env: { FOO: "bar" },
      cwd: "/plugin/desk",
    })
    expect(cfg).toEqual({
      command: "node",
      args: ["--root", "/x"],
      env: { FOO: "bar" },
      cwd: "/plugin/desk",
    })
  })
})
