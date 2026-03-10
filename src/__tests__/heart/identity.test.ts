import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as os from "os"
import * as path from "path"

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

import * as fs from "fs"

let savedArgv: string[]
let savedWebsiteSiteName: string | undefined

beforeEach(() => {
  savedArgv = [...process.argv]
  savedWebsiteSiteName = process.env.WEBSITE_SITE_NAME
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
})

afterEach(() => {
  process.argv = savedArgv
  if (savedWebsiteSiteName === undefined) {
    delete process.env.WEBSITE_SITE_NAME
  } else {
    process.env.WEBSITE_SITE_NAME = savedWebsiteSiteName
  }
})

describe("getAgentName", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("parses --agent <name> from process.argv", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    const { getAgentName, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(getAgentName()).toBe("ouroboros")
  })

  it("throws when --agent is missing", async () => {
    process.argv = ["node", "cli-entry.js"]
    const { getAgentName, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => getAgentName()).toThrow("--agent")
  })

  it("caches parsed agent name", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    const { getAgentName, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(getAgentName()).toBe("ouroboros")

    process.argv = ["node", "cli-entry.js", "--agent", "other"]
    expect(getAgentName()).toBe("ouroboros")
  })
})

describe("setAgentName", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("primes cache so getAgentName returns it without --agent in argv", async () => {
    process.argv = ["node", "cli-entry.js"]
    const { setAgentName, getAgentName, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    setAgentName("slugger")
    expect(getAgentName()).toBe("slugger")
  })

  it("overrides argv-parsed name when called after getAgentName", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    const { setAgentName, getAgentName, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(getAgentName()).toBe("ouroboros")
    setAgentName("slugger")
    expect(getAgentName()).toBe("slugger")
  })

  it("is cleared by resetIdentity", async () => {
    process.argv = ["node", "cli-entry.js"]
    const { setAgentName, getAgentName, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    setAgentName("slugger")
    expect(getAgentName()).toBe("slugger")
    resetIdentity()
    expect(() => getAgentName()).toThrow("--agent")
  })

  it("makes downstream paths resolve correctly", async () => {
    process.argv = ["node", "cli-entry.js"]
    const { setAgentName, getAgentRoot, getAgentStateRoot, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    setAgentName("slugger")
    expect(getAgentRoot()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro"))
    expect(getAgentStateRoot()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro", "state"))
  })
})

describe("agent paths", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("resolves repo root from the current module location", async () => {
    const { getRepoRoot } = await import("../../heart/identity")
    expect(getRepoRoot()).toBe(process.cwd())
  })

  it("resolves agent bundle root", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "slugger"]
    const { getAgentRoot, getAgentStateRoot, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(getAgentRoot()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro"))
    expect(getAgentStateRoot()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro", "state"))
  })

  it("uses persistent /home bundle paths on Azure App Service", async () => {
    process.env.WEBSITE_SITE_NAME = "slugger-app"
    process.argv = ["node", "cli-entry.js", "--agent", "slugger"]
    const { getAgentBundlesRoot, getAgentRoot, getAgentStateRoot, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    expect(getAgentBundlesRoot()).toBe(path.join("/home", "AgentBundles"))
    expect(getAgentRoot()).toBe(path.join("/home", "AgentBundles", "slugger.ouro"))
    expect(getAgentStateRoot()).toBe(path.join("/home", "AgentBundles", "slugger.ouro", "state"))
  })

  it("resolves conventional secrets path", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "slugger"]
    const { getAgentSecretsPath, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(getAgentSecretsPath()).toBe(path.join(os.homedir(), ".agentsecrets", "slugger", "secrets.json"))
  })

  it("accepts explicit agent name for secrets path", async () => {
    const { getAgentSecretsPath } = await import("../../heart/identity")
    expect(getAgentSecretsPath("ouroboros")).toBe(path.join(os.homedir(), ".agentsecrets", "ouroboros", "secrets.json"))
  })
})

describe("buildDefaultAgentTemplate", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("builds default schema without name/configPath", async () => {
    const { buildDefaultAgentTemplate } = await import("../../heart/identity")
    const template = buildDefaultAgentTemplate("ouroboros")

    expect(template).toEqual({
      version: 1,
      enabled: true,
      provider: "anthropic",
      context: {
        maxTokens: 80000,
        contextMargin: 20,
      },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: false },
      },
    })
    expect((template as any).name).toBeUndefined()
    expect((template as any).configPath).toBeUndefined()
  })
})

describe("loadAgentConfig", () => {
  beforeEach(() => {
    vi.resetModules()
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
  })

  it("reads and parses agent.json schema", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: false,
        provider: "minimax",
        phrases: {
          thinking: ["think"],
          tool: ["tool"],
          followup: ["followup"],
        },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.version).toBe(2)
    expect(config.enabled).toBe(false)
    expect(config.provider).toBe("minimax")
    expect(config.phrases.thinking).toEqual(["think"])
    expect((config as any).name).toBeUndefined()
    expect((config as any).configPath).toBeUndefined()
  })

  it("parses logging config when present", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        logging: { level: "debug", sinks: ["terminal"] },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.logging).toEqual({ level: "debug", sinks: ["terminal"] })
  })

  it("parses senses config when present", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        senses: {
          cli: { enabled: true },
          teams: { enabled: true },
          bluebubbles: { enabled: false },
        },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect((config as any).senses).toEqual({
      cli: { enabled: true },
      teams: { enabled: true },
      bluebubbles: { enabled: false },
    })
  })

  it("defaults missing senses config to cli enabled and other senses disabled", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect((config as any).senses).toEqual({
      cli: { enabled: true },
      teams: { enabled: false },
      bluebubbles: { enabled: false },
    })
  })

  it("fills missing individual senses from defaults when only some senses are configured", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        senses: {
          teams: { enabled: true },
        },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect((config as any).senses).toEqual({
      cli: { enabled: true },
      teams: { enabled: true },
      bluebubbles: { enabled: false },
    })
  })

  it("rejects non-object senses blocks", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        senses: [],
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/senses as an object/i)
  })

  it("rejects invalid nested sense config objects", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        senses: {
          teams: [],
        },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/invalid senses\.teams config/i)
  })

  it("rejects non-boolean sense enablement flags", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        senses: {
          cli: { enabled: "yes" },
        },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/senses/i)
  })

  it("rejects missing sense enabled flags", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        senses: {
          cli: {},
        },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/senses\.cli\.enabled/i)
  })

  it("leaves logging undefined when omitted from agent.json", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.logging).toBeUndefined()
  })

  it("defaults version/enabled when omitted", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        provider: "openai-codex",
        phrases: {
          thinking: ["thinking"],
          tool: ["tool"],
          followup: ["followup"],
        },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.version).toBe(1)
    expect(config.enabled).toBe(true)
    expect(config.provider).toBe("openai-codex")
  })

  it("fills phrases when missing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.phrases).toEqual({
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    })
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("throws for missing provider", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: 1, enabled: true }))

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow("must include provider")
  })

  it("throws for invalid provider", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, enabled: true, provider: "unknown" }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow("must include provider")
  })

  it("throws for invalid version", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 0, enabled: true, provider: "minimax" }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow("version")
  })

  it("throws for non-boolean enabled", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, enabled: "yes", provider: "minimax" }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow("enabled")
  })

  it("throws descriptive error when file is missing", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("ENOENT")
      err.code = "ENOENT"
      throw err
    })

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/agent\.json/)
  })

  it("throws descriptive error when file read throws non-Error", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw "read-failure"
    })

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/agent\.json/)
  })

  it("throws descriptive error when JSON is invalid", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("not json {{{")

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/agent\.json/)
  })

  it("throws descriptive error when JSON parse throws non-Error", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("{\"provider\":\"anthropic\"}")
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "parse-failure"
    })

    try {
      const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
      resetIdentity()
      expect(() => loadAgentConfig()).toThrow(/agent\.json/)
    } finally {
      parseSpy.mockRestore()
    }
  })

  it("caches loaded config", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "minimax",
        phrases: {
          thinking: ["thinking"],
          tool: ["tool"],
          followup: ["followup"],
        },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const first = loadAgentConfig()
    const second = loadAgentConfig()

    expect(first).toBe(second)
    expect(fs.readFileSync).toHaveBeenCalledTimes(1)
  })

  it("re-reads config after resetAgentConfigCache without resetting agent identity", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(
        JSON.stringify({
          version: 1,
          enabled: true,
          provider: "minimax",
          phrases: {
            thinking: ["first"],
            tool: ["tool"],
            followup: ["followup"],
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          version: 1,
          enabled: true,
          provider: "minimax",
          phrases: {
            thinking: ["second"],
            tool: ["tool"],
            followup: ["followup"],
          },
        }),
      )

    const { getAgentName, loadAgentConfig, resetAgentConfigCache, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(getAgentName()).toBe("ouroboros")
    expect(loadAgentConfig().phrases.thinking).toEqual(["first"])

    resetAgentConfigCache()

    expect(getAgentName()).toBe("ouroboros")
    expect(loadAgentConfig().phrases.thinking).toEqual(["second"])
    expect(fs.readFileSync).toHaveBeenCalledTimes(2)
  })
})

describe("resetIdentity", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("clears cached name and config", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "minimax",
        phrases: {
          thinking: ["thinking"],
          tool: ["tool"],
          followup: ["followup"],
        },
      }),
    )

    const { getAgentName, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(getAgentName()).toBe("ouroboros")
    loadAgentConfig()

    process.argv = ["node", "cli-entry.js", "--agent", "slugger"]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        phrases: {
          thinking: ["thinking"],
          tool: ["tool"],
          followup: ["followup"],
        },
      }),
    )

    resetIdentity()
    expect(getAgentName()).toBe("slugger")
    expect(loadAgentConfig().provider).toBe("anthropic")
  })
})

describe("setAgentConfigOverride", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("causes loadAgentConfig to return the override instead of reading from disk", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    const { setAgentConfigOverride, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    const override = {
      version: 1,
      enabled: true,
      provider: "anthropic" as const,
      phrases: { thinking: ["override"], tool: ["override"], followup: ["override"] },
    }
    setAgentConfigOverride(override)

    const result = loadAgentConfig()
    expect(result).toBe(override)
    expect(result.phrases.thinking).toEqual(["override"])
    // fs.readFileSync should NOT have been called for agent.json
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  it("setAgentConfigOverride(null) restores disk-based loading", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "minimax",
        phrases: { thinking: ["disk"], tool: ["disk"], followup: ["disk"] },
      }),
    )

    const { setAgentConfigOverride, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    const override = {
      version: 1,
      enabled: true,
      provider: "anthropic" as const,
      phrases: { thinking: ["override"], tool: ["override"], followup: ["override"] },
    }
    setAgentConfigOverride(override)
    expect(loadAgentConfig().provider).toBe("anthropic")

    setAgentConfigOverride(null)
    expect(loadAgentConfig().provider).toBe("minimax")
  })

  it("resetIdentity clears the override", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "minimax",
        phrases: { thinking: ["disk"], tool: ["disk"], followup: ["disk"] },
      }),
    )

    const { setAgentConfigOverride, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    const override = {
      version: 1,
      enabled: true,
      provider: "anthropic" as const,
      phrases: { thinking: ["override"], tool: ["override"], followup: ["override"] },
    }
    setAgentConfigOverride(override)
    expect(loadAgentConfig().provider).toBe("anthropic")

    resetIdentity()
    expect(loadAgentConfig().provider).toBe("minimax")
  })

  it("override takes precedence over cached disk config", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "minimax",
        phrases: { thinking: ["disk"], tool: ["disk"], followup: ["disk"] },
      }),
    )

    const { setAgentConfigOverride, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    // First load from disk to populate cache
    expect(loadAgentConfig().provider).toBe("minimax")

    // Override should take precedence over cached disk value
    const override = {
      version: 2,
      enabled: false,
      provider: "azure" as const,
      phrases: { thinking: ["override"], tool: ["override"], followup: ["override"] },
    }
    setAgentConfigOverride(override)
    expect(loadAgentConfig().provider).toBe("azure")
    expect(loadAgentConfig().version).toBe(2)
  })
})
