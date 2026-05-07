import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as os from "os"
import * as path from "path"

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock("../../heart/migrate-config", () => ({
  migrateAgentConfigV1ToV2: vi.fn(),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import * as fs from "fs"
import { migrateAgentConfigV1ToV2 } from "../../heart/migrate-config"
import { emitNervesEvent } from "../../nerves/runtime"

let savedArgv: string[]
let savedWebsiteSiteName: string | undefined

beforeEach(() => {
  savedArgv = [...process.argv]
  savedWebsiteSiteName = process.env.WEBSITE_SITE_NAME
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
  vi.mocked(emitNervesEvent).mockReset()
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

  it("logs argv resolution once and leaves cache hits quiet", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    const { getAgentName, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    expect(getAgentName()).toBe("ouroboros")
    expect(getAgentName()).toBe("ouroboros")

    const identityResolveEvents = vi
      .mocked(emitNervesEvent)
      .mock.calls.filter(([event]) => event.event === "identity.resolve")
    expect(identityResolveEvents).toHaveLength(1)
    expect(identityResolveEvents[0]?.[0]).toMatchObject({
      component: "config/identity",
      event: "identity.resolve",
      message: "resolved agent name from argv",
      meta: { source: "argv" },
    })
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

  it("derives bundle-local daemon, tool, and workspace roots", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "slugger"]
    const {
      getAgentDaemonLoggingConfigPath,
      getAgentDaemonLogsDir,
      getAgentMailroomRoot,
      getAgentMessagesRoot,
      getAgentRepoWorkspacesRoot,
      getAgentToolsRoot,
      HARNESS_CANONICAL_REPO_URL,
      resetIdentity,
    } = await import("../../heart/identity")
    resetIdentity()

    expect(HARNESS_CANONICAL_REPO_URL).toBe("https://github.com/ouroborosbot/ouroboros.git")
    expect(getAgentDaemonLoggingConfigPath()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json"))
    expect(getAgentDaemonLogsDir()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro", "state", "daemon", "logs"))
    expect(getAgentMailroomRoot()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro", "state", "mailroom"))
    expect(getAgentMessagesRoot()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro", "state", "messages"))
    expect(getAgentRepoWorkspacesRoot()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro", "state", "workspaces"))
    expect(getAgentToolsRoot()).toBe(path.join(os.homedir(), "AgentBundles", "slugger.ouro", "state", "tools"))
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
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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
        mail: { enabled: false },
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
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
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
    expect(config.humanFacing).toEqual({ provider: "minimax", model: "minimax-text-01" })
    expect(config.phrases.thinking).toEqual(["think"])
    expect((config as any).name).toBeUndefined()
    expect((config as any).configPath).toBeUndefined()
  })

  it("parses logging config when present", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        logging: { level: "debug", sinks: ["terminal"] },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.logging).toEqual({ level: "debug", sinks: ["terminal"] })
  })

  it("preserves the sync block from agent.json", async () => {
    // Regression: prior to this test, loadAgentConfig built its return object
    // by hand-copying a fixed list of fields and silently dropped the `sync`
    // block. The TypeScript type allowed it but the constructor didn't
    // preserve it from disk, so getSyncConfig() always saw `enabled: false`
    // and the entire sync code path (preTurnPull / postTurnPush) was dead.
    // The bug hid for weeks because `ouro status` reads agent.json directly
    // via listBundleSyncRows, not through loadAgentConfig — so the status
    // display correctly showed "enabled" while sync did nothing.
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
        sync: { enabled: true, remote: "upstream" },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.sync).toEqual({ enabled: true, remote: "upstream" })
  })

  it("preserves a partial sync block (enabled only, default remote)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
        sync: { enabled: true },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.sync).toEqual({ enabled: true })
  })

  it("leaves config.sync undefined when agent.json has no sync block", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.sync).toBeUndefined()
  })

  it("parses senses config when present", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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
      mail: { enabled: false },
    })
  })

  it("defaults missing senses config to cli enabled and other senses disabled", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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
      mail: { enabled: false },
    })
  })

  it("fills missing individual senses from defaults when only some senses are configured", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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
      mail: { enabled: false },
    })
  })

  it("rejects non-object senses blocks", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.logging).toBeUndefined()
  })

  it("defaults enabled when omitted", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
        agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
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

    expect(config.version).toBe(2)
    expect(config.enabled).toBe(true)
    expect(config.humanFacing.provider).toBe("openai-codex")
  })

  it("fills phrases when missing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
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

  it("throws for missing humanFacing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow("humanFacing")
  })

  it("throws for missing agentFacing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow("agentFacing")
  })

  it("throws for invalid version", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 0,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow("version")
  })

  it("throws for non-boolean enabled", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: "yes",
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
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

  it("re-reads agent.json on each load", async () => {
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(
        JSON.stringify({
          version: 2,
          enabled: true,
          humanFacing: { provider: "minimax", model: "minimax-text-01" },
          agentFacing: { provider: "minimax", model: "minimax-text-01" },
          phrases: {
            thinking: ["first"],
            tool: ["tool"],
            followup: ["followup"],
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          version: 2,
          enabled: true,
          humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
          agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
          phrases: {
            thinking: ["second"],
            tool: ["tool"],
            followup: ["followup"],
          },
        }),
      )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const first = loadAgentConfig()
    const second = loadAgentConfig()

    expect(first).not.toBe(second)
    expect(first.humanFacing.provider).toBe("minimax")
    expect(second.humanFacing.provider).toBe("anthropic")
    expect(fs.readFileSync).toHaveBeenCalledTimes(2)
  })

  it("picks up updated agent.json without resetting agent identity", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(
        JSON.stringify({
          version: 2,
          enabled: true,
          humanFacing: { provider: "minimax", model: "minimax-text-01" },
          agentFacing: { provider: "minimax", model: "minimax-text-01" },
          phrases: {
            thinking: ["first"],
            tool: ["tool"],
            followup: ["followup"],
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          version: 2,
          enabled: true,
          humanFacing: { provider: "minimax", model: "minimax-text-01" },
          agentFacing: { provider: "minimax", model: "minimax-text-01" },
          phrases: {
            thinking: ["second"],
            tool: ["tool"],
            followup: ["followup"],
          },
        }),
      )

    const { getAgentName, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(getAgentName()).toBe("ouroboros")
    expect(loadAgentConfig().phrases.thinking).toEqual(["first"])

    expect(getAgentName()).toBe("ouroboros")
    expect(loadAgentConfig().phrases.thinking).toEqual(["second"])
    expect(fs.readFileSync).toHaveBeenCalledTimes(2)
  })

  it("keeps refreshed agent.json behavior when resetAgentConfigCache is called", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(
        JSON.stringify({
          version: 2,
          enabled: true,
          humanFacing: { provider: "minimax", model: "minimax-text-01" },
          agentFacing: { provider: "minimax", model: "minimax-text-01" },
          phrases: {
            thinking: ["first"],
            tool: ["tool"],
            followup: ["followup"],
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          version: 2,
          enabled: true,
          humanFacing: { provider: "minimax", model: "minimax-text-01" },
          agentFacing: { provider: "minimax", model: "minimax-text-01" },
          phrases: {
            thinking: ["second"],
            tool: ["tool"],
            followup: ["followup"],
          },
        }),
      )

    const { loadAgentConfig, resetAgentConfigCache, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    expect(loadAgentConfig().phrases.thinking).toEqual(["first"])
    resetAgentConfigCache()
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
        version: 2,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
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
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: {
          thinking: ["thinking"],
          tool: ["tool"],
          followup: ["followup"],
        },
      }),
    )

    resetIdentity()
    expect(getAgentName()).toBe("slugger")
    expect(loadAgentConfig().humanFacing.provider).toBe("anthropic")
  })
})

describe("mcpServers config", () => {
  beforeEach(() => {
    vi.resetModules()
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
  })

  it("leaves mcpServers undefined when absent from agent.json (backward compat)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.mcpServers).toBeUndefined()
  })

  it("parses mcpServers with valid entries", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
        mcpServers: {
          ado: {
            command: "npx",
            args: ["-y", "@anthropic/mcp-server-ado"],
            env: { ADO_TOKEN: "tok123" },
          },
          mail: {
            command: "/usr/local/bin/mail-server",
          },
        },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.mcpServers).toEqual({
      ado: {
        command: "npx",
        args: ["-y", "@anthropic/mcp-server-ado"],
        env: { ADO_TOKEN: "tok123" },
      },
      mail: {
        command: "/usr/local/bin/mail-server",
      },
    })
  })

  it("parses mcpServers when empty object", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
        mcpServers: {},
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.mcpServers).toEqual({})
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
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic" as const, model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic" as const, model: "claude-opus-4-6" },
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
        version: 2,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
        phrases: { thinking: ["disk"], tool: ["disk"], followup: ["disk"] },
      }),
    )

    const { setAgentConfigOverride, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    const override = {
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic" as const, model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic" as const, model: "claude-opus-4-6" },
      phrases: { thinking: ["override"], tool: ["override"], followup: ["override"] },
    }
    setAgentConfigOverride(override)
    expect(loadAgentConfig().humanFacing.provider).toBe("anthropic")

    setAgentConfigOverride(null)
    expect(loadAgentConfig().humanFacing.provider).toBe("minimax")
  })

  it("resetIdentity clears the override", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
        phrases: { thinking: ["disk"], tool: ["disk"], followup: ["disk"] },
      }),
    )

    const { setAgentConfigOverride, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    const override = {
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic" as const, model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic" as const, model: "claude-opus-4-6" },
      phrases: { thinking: ["override"], tool: ["override"], followup: ["override"] },
    }
    setAgentConfigOverride(override)
    expect(loadAgentConfig().humanFacing.provider).toBe("anthropic")

    resetIdentity()
    expect(loadAgentConfig().humanFacing.provider).toBe("minimax")
  })

  it("override takes precedence over cached disk config", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
        phrases: { thinking: ["disk"], tool: ["disk"], followup: ["disk"] },
      }),
    )

    const { setAgentConfigOverride, loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    // First load from disk to populate cache
    expect(loadAgentConfig().humanFacing.provider).toBe("minimax")

    // Override should take precedence over cached disk value
    const override = {
      version: 2,
      enabled: false,
      humanFacing: { provider: "azure" as const, model: "gpt-4o" },
      agentFacing: { provider: "azure" as const, model: "gpt-4o" },
      phrases: { thinking: ["override"], tool: ["override"], followup: ["override"] },
    }
    setAgentConfigOverride(override)
    expect(loadAgentConfig().humanFacing.provider).toBe("azure")
    expect(loadAgentConfig().version).toBe(2)
  })
})

describe("AgentFacingConfig and AgentConfig v2 type", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("AgentConfig requires humanFacing and agentFacing fields", async () => {
    const mod = await import("../../heart/identity")

    // Type-level test: construct v2 config and verify shape
    const facingConfig: import("../../heart/identity").AgentFacingConfig = { provider: "anthropic", model: "claude-opus-4-6" }
    expect(facingConfig.provider).toBe("anthropic")
    expect(facingConfig.model).toBe("claude-opus-4-6")

    const config: import("../../heart/identity").AgentConfig = {
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    }
    expect(config.humanFacing.provider).toBe("anthropic")
    expect(config.humanFacing.model).toBe("claude-opus-4-6")
    expect(config.agentFacing.provider).toBe("anthropic")
    expect(config.agentFacing.model).toBe("claude-opus-4-6")
    // Suppress unused import warning
    expect(mod).toBeDefined()
  })

  it("AgentConfig provider field is optional (deprecated)", async () => {
    const mod = await import("../../heart/identity")

    // v2 config without provider field should still be valid
    const config: import("../../heart/identity").AgentConfig = {
      version: 2,
      enabled: true,
      humanFacing: { provider: "azure", model: "gpt-4o" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    }
    expect(config.provider).toBeUndefined()
    expect(config.humanFacing.provider).toBe("azure")
    expect(config.agentFacing.provider).toBe("anthropic")
    // Suppress unused import warning
    expect(mod).toBeDefined()
  })
})

describe("loadAgentConfig v2 inline migration", () => {
  beforeEach(() => {
    vi.resetModules()
    process.argv = ["node", "cli-entry.js", "--agent", "ouroboros"]
    vi.mocked(migrateAgentConfigV1ToV2).mockReset()
  })

  it("auto-migrates v1 config on disk and returns v2", async () => {
    const v1Json = JSON.stringify({
      version: 1,
      enabled: true,
      provider: "anthropic",
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    const v2Json = JSON.stringify({
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    // First read returns v1, migration transforms on disk, second read returns v2
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(v1Json)
      .mockReturnValueOnce(v2Json)

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(migrateAgentConfigV1ToV2).toHaveBeenCalledTimes(1)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })

  it("returns v2 config directly without migration", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "azure", model: "gpt-4o" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(migrateAgentConfigV1ToV2).not.toHaveBeenCalled()
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "azure", model: "gpt-4o" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })

  it("treats non-numeric version as v1 and triggers migration", async () => {
    const noVersionJson = JSON.stringify({
      enabled: true,
      provider: "anthropic",
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    const v2Json = JSON.stringify({
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(noVersionJson)
      .mockReturnValueOnce(v2Json)

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(migrateAgentConfigV1ToV2).toHaveBeenCalledTimes(1)
    expect(config.version).toBe(2)
  })

  it("handles string version field and triggers migration", async () => {
    const stringVersionJson = JSON.stringify({
      version: "1",
      enabled: true,
      provider: "anthropic",
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    const v2Json = JSON.stringify({
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(stringVersionJson)
      .mockReturnValueOnce(v2Json)

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(migrateAgentConfigV1ToV2).toHaveBeenCalledTimes(1)
    expect(config.version).toBe(2)
  })

  it("treats non-numeric version in post-migration config as v1 defensively", async () => {
    // After migration, if version is somehow still a string, the defensive branch treats it as 1
    const v1Json = JSON.stringify({
      version: 1,
      enabled: true,
      provider: "anthropic",
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    // Migration "ran" but version came back as a string
    const postMigrationJson = JSON.stringify({
      version: "2",
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(v1Json)
      .mockReturnValueOnce(postMigrationJson)

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    // Version defaults to 1 when non-numeric, which still passes validation
    expect(config.version).toBe(1)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })

  it("rejects config missing humanFacing after migration", async () => {
    const v1Json = JSON.stringify({
      version: 1,
      enabled: true,
      provider: "anthropic",
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    // Migration "ran" but produced malformed output (no humanFacing)
    const badV2Json = JSON.stringify({
      version: 2,
      enabled: true,
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(v1Json)
      .mockReturnValueOnce(badV2Json)

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/humanFacing/)
  })

  it("rejects config missing agentFacing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/agentFacing/)
  })

  it("rejects invalid provider in humanFacing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "not-a-provider", model: "some-model" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/humanFacing/)
  })

  it("rejects missing provider in humanFacing (nullish provider branch)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { model: "some-model" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/humanFacing/)
  })

  it("rejects invalid provider in agentFacing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "bad-provider", model: "some-model" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/agentFacing/)
  })

  it("rejects non-string model in humanFacing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: 123 },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/humanFacing/)
  })

  it("rejects non-string model in agentFacing", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: null },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }),
    )

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    expect(() => loadAgentConfig()).toThrow(/agentFacing/)
  })
})

describe("buildDefaultAgentTemplate v2", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns v2 config with both facings defaulting to anthropic claude-opus-4-6", async () => {
    const { buildDefaultAgentTemplate } = await import("../../heart/identity")
    const template = buildDefaultAgentTemplate("testbot")

    expect(template.version).toBe(2)
    expect(template.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(template.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    // provider field should not be set on v2 templates
    expect(template.provider).toBeUndefined()
  })

  it("has version 2", async () => {
    const { buildDefaultAgentTemplate } = await import("../../heart/identity")
    const template = buildDefaultAgentTemplate("testbot")
    expect(template.version).toBe(2)
  })
})
