import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as path from "path"
import * as os from "os"

// Mock fs before importing config
vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

// Mock identity module -- config.ts will import from ./identity
vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    version: 1,
    enabled: true,
    provider: "minimax",
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
  })),
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => path.join(os.homedir(), "AgentBundles", "testagent.ouro")),
  DEFAULT_AGENT_CONTEXT: {
    maxTokens: 80000,
    contextMargin: 20,
  },
}))

import * as fs from "fs"
import * as identity from "../../heart/identity"

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.mkdirSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    version: 2,
    enabled: true,
    provider: "minimax",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
  })
  vi.mocked(identity.getAgentName).mockReturnValue("testagent")
  vi.mocked((identity as any).getAgentRoot).mockReturnValue(
    path.join(os.homedir(), "AgentBundles", "testagent.ouro"),
  )
})

afterEach(() => {
})

async function importConfigModule(runtimeConfig?: Record<string, unknown>, agentName = "testagent") {
  const config = await import("../../heart/config")
  config.resetConfigCache()
  if (runtimeConfig) {
    config.cacheRuntimeConfigForTests(agentName, runtimeConfig)
  }
  return config
}

describe("loadConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("reads config from the agent vault runtime/config cache and ignores provider blocks", async () => {
    const runtimeConfig = {
      providers: {
        azure: {
          apiKey: "az-key",
          endpoint: "https://example.openai.azure.com",
          deployment: "gpt-4",
          modelName: "gpt-4",
        },
      },
      teamsChannel: {
        port: 5001,
      },
    }

    const { loadConfig } = await importConfigModule(runtimeConfig)
    const config = loadConfig()

    expect(config).not.toHaveProperty("providers")
    expect(config.teamsChannel.port).toBe(5001)
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  it("does not create local credential directories when loading", async () => {
    const { loadConfig } = await importConfigModule({})
    loadConfig()

    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it("returns defaults when vault runtime/config is missing from the local cache", async () => {
    const { loadConfig } = await importConfigModule()
    const config = loadConfig()

    expect(config.context.maxTokens).toBe(80000)
    expect(config.context.contextMargin).toBe(20)
    expect(config.teams.clientId).toBe("")
    expect(config.integrations.perplexityApiKey).toBe("")
    expect(config).not.toHaveProperty("providers")
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("continues with defaults when local fs reads would fail", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("disk full")
    })

    const { loadConfig } = await importConfigModule()
    const config = loadConfig()

    expect(config.context.maxTokens).toBe(80000)
    expect(config).not.toHaveProperty("providers")
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  it("continues with defaults when local fs reads would throw non-Error values", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw "read-failure"
    })

    const { loadConfig } = await importConfigModule()
    const config = loadConfig()

    expect(config.context.maxTokens).toBe(80000)
    expect(config).not.toHaveProperty("providers")
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  it("ignores context and provider blocks from runtime/config", async () => {
    const runtimeConfig = {
      context: { maxTokens: 1, contextMargin: 1 },
      providers: {
        minimax: { apiKey: "minimax-key", model: "MiniMax-M2.5" },
      },
    }

    const { loadConfig } = await importConfigModule(runtimeConfig)
    const config = loadConfig()

    // context must come from agent.json defaults, not runtime credentials.
    expect(config.context.maxTokens).toBe(80000)
    expect(config.context.contextMargin).toBe(20)
    expect(config).not.toHaveProperty("providers")
  })

  it("ignores provider credentials while merging non-provider config with defaults", async () => {
    const partial = {
      providers: {
        azure: {
          apiKey: "my-key",
        },
      },
      teamsChannel: {
        port: 5001,
      },
    }

    const { loadConfig } = await importConfigModule(partial)
    const config = loadConfig()

    expect(config).not.toHaveProperty("providers")
    expect(config.teamsChannel.port).toBe(5001)
    expect(config.context.maxTokens).toBe(80000)
    expect(config.context.contextMargin).toBe(20)
  })

  it("defaults vault secrets to empty masterPassword", async () => {
    const { loadConfig } = await importConfigModule({})
    const config = loadConfig()

    expect(config.vault.masterPassword).toBe("")
    expect(config.vault.adminToken).toBeUndefined()
    expect(config.vault.clientId).toBeUndefined()
    expect(config.vault.clientSecret).toBeUndefined()
  })

  it("merges partial vault config from runtime/config", async () => {
    const { loadConfig } = await importConfigModule({
      vault: {
        masterPassword: "test-master-pw",
        adminToken: "admin-tok",
      },
    })
    const config = loadConfig()

    expect(config.vault.masterPassword).toBe("test-master-pw")
    expect(config.vault.adminToken).toBe("admin-tok")
  })

  it("does not use OUROBOROS_CONFIG_PATH env var", async () => {
    process.env.OUROBOROS_CONFIG_PATH = "/tmp/should-not-be-used.json"

    const { loadConfig } = await importConfigModule({ providers: { azure: { apiKey: "x" } } })
    loadConfig()

    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.readFileSync).not.toHaveBeenCalledWith("/tmp/should-not-be-used.json", "utf-8")

    delete process.env.OUROBOROS_CONFIG_PATH
  })

  it("uses the current agent name when reading cached runtime/config", async () => {
    vi.mocked(identity.getAgentName).mockReturnValue("myagent")

    const { loadConfig } = await importConfigModule({ teamsChannel: { port: 5002 } }, "myagent")
    const config = loadConfig()

    expect(config.teamsChannel.port).toBe(5002)
  })

  it("re-reads cached non-provider runtime config on each load", async () => {
    const { cacheRuntimeConfigForTests, loadConfig } = await importConfigModule({ integrations: { perplexityApiKey: "k1" } })
    const config1 = loadConfig()
    cacheRuntimeConfigForTests("testagent", { integrations: { perplexityApiKey: "k2" } })
    const config2 = loadConfig()

    expect(config1).not.toBe(config2)
    expect(config1.integrations.perplexityApiKey).toBe("k1")
    expect(config2.integrations.perplexityApiKey).toBe("k2")
    expect(config1).not.toHaveProperty("providers")
    expect(config2).not.toHaveProperty("providers")
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  it("re-reads updated integrations config without resetConfigCache()", async () => {
    const { cacheRuntimeConfigForTests, getIntegrationsConfig } = await importConfigModule({
      integrations: { perplexityApiKey: "" },
    })

    expect(getIntegrationsConfig().perplexityApiKey).toBe("")
    cacheRuntimeConfigForTests("testagent", { integrations: { perplexityApiKey: "fresh-key" } })
    expect(getIntegrationsConfig().perplexityApiKey).toBe("fresh-key")
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  it("emits config.load observability event when loading config", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    const { loadConfig } = await importConfigModule({})
    loadConfig()

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "config.load",
      component: "config/identity",
    }))
  })
})

describe("getAzureConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns azure config from the provider credential cache (credentials only, no modelName)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getAzureConfig, patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "az-key",
          endpoint: "https://example.openai.azure.com",
          deployment: "gpt-4",
          apiVersion: "2025-01-01",
        },
      },
    })
    const azure = getAzureConfig()

    expect(azure.apiKey).toBe("az-key")
    expect(azure.endpoint).toBe("https://example.openai.azure.com")
    expect(azure.deployment).toBe("gpt-4")
    expect(azure).not.toHaveProperty("modelName")
    expect(azure.apiVersion).toBe("2025-01-01")
  })

  it("uses default apiVersion when not specified", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getAzureConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const azure = getAzureConfig()

    expect(azure.apiVersion).toBe("2025-04-01-preview")
  })

  it("returns apiKey as empty string when no provider credential is cached", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      providers: { azure: { apiKey: "" } },
    }))

    const { getAzureConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const azure = getAzureConfig()

    expect(azure.apiKey).toBe("")
  })

  it("returns apiKey as populated when provider credentials have a real key", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getAzureConfig, patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { azure: { apiKey: "real-key-123" } } })
    const azure = getAzureConfig()

    expect(azure.apiKey).toBe("real-key-123")
  })

  it("returns apiKey as empty string from default when cached provider credentials omit apiKey", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      providers: { azure: { endpoint: "https://example.openai.azure.com" } },
    }))

    const { getAzureConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const azure = getAzureConfig()

    expect(azure.apiKey).toBe("")
  })

  it("returns managedIdentityClientId when present in provider credentials", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getAzureConfig, patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { azure: { managedIdentityClientId: "c404d5a9-1234-5678-abcd-ef0123456789" } } })
    const azure = getAzureConfig()

    expect(azure.managedIdentityClientId).toBe("c404d5a9-1234-5678-abcd-ef0123456789")
  })

  it("returns managedIdentityClientId as empty string from default when omitted", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      providers: { azure: { apiKey: "some-key" } },
    }))

    const { getAzureConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const azure = getAzureConfig()

    expect(azure.managedIdentityClientId).toBe("")
  })

})

describe("getMinimaxConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns minimax config from the provider credential cache (credentials only, no model)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getMinimaxConfig, patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "mm-key" } } })
    const mm = getMinimaxConfig()

    expect(mm.apiKey).toBe("mm-key")
    expect(mm).not.toHaveProperty("model")
  })

})

describe("getOpenAICodexConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("exports openai-codex config getter and returns oauth config from provider credentials (credentials only, no model)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { "openai-codex": { oauthAccessToken: "oauth-token-123" } } })
    expect(typeof (config as any).getOpenAICodexConfig).toBe("function")
    const codex = (config as any).getOpenAICodexConfig()

    expect(codex).not.toHaveProperty("model")
    expect(codex.oauthAccessToken).toBe("oauth-token-123")
  })
})

describe("getTeamsConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns teams config from runtime/config", async () => {
    const configData = {
      teams: {
        clientId: "cid",
        clientSecret: "csecret",
        tenantId: "tid",
      },
    }

    const { getTeamsConfig } = await importConfigModule(configData)
    const teams = getTeamsConfig()

    expect(teams.clientId).toBe("cid")
    expect(teams.clientSecret).toBe("csecret")
    expect(teams.tenantId).toBe("tid")
  })

})

describe("getContextConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns context config from agent.json", async () => {
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      version: 2,
      enabled: true,
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: {
        maxTokens: 100000,
        contextMargin: 25,
      },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    } as any)

    const configData = {
      context: {
        maxTokens: 1,
        contextMargin: 2,
      },
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configData))

    const { getContextConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const ctx = getContextConfig()

    expect(ctx.maxTokens).toBe(100000)
    expect(ctx.contextMargin).toBe(25)
  })

  it("returns defaults when not configured", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getContextConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const ctx = getContextConfig()

    expect(ctx.maxTokens).toBe(80000)
    expect(ctx.contextMargin).toBe(20)
  })

  it("falls back per-field defaults when agent.json context has invalid types", async () => {
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      version: 2,
      enabled: true,
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: {
        maxTokens: "bad",
        contextMargin: 12,
      },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    } as any)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getContextConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const ctx = getContextConfig()

    expect(ctx.maxTokens).toBe(80000)
    expect(ctx.contextMargin).toBe(12)
  })

  it("falls back contextMargin to default when agent.json contextMargin is not numeric", async () => {
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      version: 2,
      enabled: true,
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: {
        maxTokens: 91000,
        contextMargin: "bad",
      },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    } as any)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getContextConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const ctx = getContextConfig()

    expect(ctx.maxTokens).toBe(91000)
    expect(ctx.contextMargin).toBe(20)
  })

})

describe("getOpenAIEmbeddingsApiKey", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns integrations.openaiEmbeddingsApiKey from runtime/config", async () => {
    const { getOpenAIEmbeddingsApiKey } = await importConfigModule({
      integrations: {
        openaiEmbeddingsApiKey: "emb-key-123",
      },
    })
    const key = getOpenAIEmbeddingsApiKey()

    expect(key).toBe("emb-key-123")
  })
})

describe("sessionPath", () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.mkdirSync).mockReset()
  })

  it("returns correct path with friendId, channel, and key (3-arg signature)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { sessionPath } = await import("../../heart/config")
    const p = sessionPath("uuid-abc-123", "cli", "session")

    expect(p).toBe(path.join(os.homedir(), "AgentBundles", "testagent.ouro", "state", "sessions", "uuid-abc-123", "cli", "session.json"))
  })

  it("returns correct path for teams channel with friendId", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { sessionPath } = await import("../../heart/config")
    const p = sessionPath("uuid-xyz-456", "teams", "conv-123")

    expect(p).toBe(path.join(os.homedir(), "AgentBundles", "testagent.ouro", "state", "sessions", "uuid-xyz-456", "teams", "conv-123.json"))
  })

  it("sanitizes key by replacing slashes and colons with underscores", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { sessionPath } = await import("../../heart/config")
    const p = sessionPath("uuid-1", "teams", "a]conv/id:123")

    expect(p).toBe(path.join(os.homedir(), "AgentBundles", "testagent.ouro", "state", "sessions", "uuid-1", "teams", "a]conv_id_123.json"))
  })

  it("auto-creates parent directories", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { sessionPath } = await import("../../heart/config")
    sessionPath("uuid-1", "cli", "session")

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.join(os.homedir(), "AgentBundles", "testagent.ouro", "state", "sessions", "uuid-1", "cli"),
      { recursive: true },
    )
  })

  it("does not create directories when resolveSessionPath is called without ensureDir", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { resolveSessionPath } = await import("../../heart/config")
    const p = resolveSessionPath("uuid-1", "cli", "session")

    expect(p).toBe(path.join(os.homedir(), "AgentBundles", "testagent.ouro", "state", "sessions", "uuid-1", "cli", "session.json"))
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })
})

describe("logPath", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns logs directory using agent name from identity module", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getLogsDir } = await import("../../heart/config")
    const dir = getLogsDir()

    expect(dir).toBe(path.join(os.homedir(), "AgentBundles", "testagent.ouro", "state", "logs"))
  })

  it("returns NDJSON log path and sanitizes key", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { logPath } = await import("../../heart/config")
    const p = logPath("teams", "a]conv/id:123")

    expect(p).toBe(path.join(os.homedir(), "AgentBundles", "testagent.ouro", "state", "logs", "teams", "a]conv_id_123.ndjson"))
  })
})

describe("slugify", () => {
  it("normalizes whitespace, casing, and punctuation into a slug", async () => {
    vi.resetModules()

    const { slugify } = await import("../../heart/config")

    expect(slugify("  Hello, BlueBubbles World!  ")).toBe("hello-bluebubbles-world")
  })
})

describe("getOAuthConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns default connection names", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getOAuthConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const oauth = getOAuthConfig()

    expect(oauth.graphConnectionName).toBe("graph")
    expect(oauth.adoConnectionName).toBe("ado")
  })

  it("respects runtime/config values", async () => {
    const configData = {
      oauth: {
        graphConnectionName: "custom-graph",
        adoConnectionName: "custom-ado",
      },
    }

    const { getOAuthConfig } = await importConfigModule(configData)
    const oauth = getOAuthConfig()

    expect(oauth.graphConnectionName).toBe("custom-graph")
    expect(oauth.adoConnectionName).toBe("custom-ado")
  })

})

describe("getAdoConfig removed", () => {
  it("getAdoConfig no longer exists (removed in Unit 1Hb)", async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    expect((config as any).getAdoConfig).toBeUndefined()
  })
})

describe("getTeamsChannelConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns default teamsChannel config when not specified", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getTeamsChannelConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const tc = getTeamsChannelConfig()

    expect(tc.skipConfirmation).toBe(true)
    expect(tc.port).toBe(3978)
  })

  it("returns teamsChannel config with flushIntervalMs from runtime/config", async () => {
    const configData = {
      teamsChannel: {
        skipConfirmation: true,
        flushIntervalMs: 2000,
        port: 4000,
      },
    }

    const { getTeamsChannelConfig } = await importConfigModule(configData)
    const tc = getTeamsChannelConfig()

    expect(tc.skipConfirmation).toBe(true)
    expect(tc.flushIntervalMs).toBe(2000)
    expect(tc.port).toBe(4000)
  })

  it("returns a shallow copy (not the same reference)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getTeamsChannelConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const tc1 = getTeamsChannelConfig()
    const tc2 = getTeamsChannelConfig()

    expect(tc1).toEqual(tc2)
    expect(tc1).not.toBe(tc2)
  })

  it("merges partial teamsChannel config with defaults (no disableStreaming)", async () => {
    const configData = {
      teamsChannel: {
        port: 5000,
      },
    }

    const { getTeamsChannelConfig } = await importConfigModule(configData)
    const tc = getTeamsChannelConfig()

    expect(tc.skipConfirmation).toBe(true)
    expect(tc).not.toHaveProperty("disableStreaming")
    expect(tc.port).toBe(5000)
  })
})

describe("getBlueBubblesConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns bluebubbles config from runtime/config", async () => {
    const { getBlueBubblesConfig } = await importConfigModule({
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "secret-pass",
        accountId: "personal",
      },
    })
    const bb = getBlueBubblesConfig()

    expect(bb.serverUrl).toBe("http://localhost:1234")
    expect(bb.password).toBe("secret-pass")
    expect(bb.accountId).toBe("personal")
  })

  it("falls back to default accountId when the configured value is blank", async () => {
    const { getBlueBubblesConfig } = await importConfigModule({
      bluebubbles: {
        serverUrl: " http://localhost:1234 ",
        password: " secret-pass ",
        accountId: "   ",
      },
    })
    const bb = getBlueBubblesConfig()

    expect(bb.serverUrl).toBe("http://localhost:1234")
    expect(bb.password).toBe("secret-pass")
    expect(bb.accountId).toBe("default")
  })

  it("fails fast when bluebubbles serverUrl is missing", async () => {
    const { getBlueBubblesConfig } = await importConfigModule({
      bluebubbles: {
        serverUrl: "",
        password: "secret-pass",
      },
    })

    expect(() => getBlueBubblesConfig()).toThrow(/bluebubbles\.serverUrl/i)
  })

  it("fails fast when bluebubbles password is missing", async () => {
    const { getBlueBubblesConfig } = await importConfigModule({
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "",
      },
    })

    expect(() => getBlueBubblesConfig()).toThrow(/bluebubbles\.password/i)
  })
})

describe("getBlueBubblesChannelConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns default bluebubblesChannel config when not specified", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getBlueBubblesChannelConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const bb = getBlueBubblesChannelConfig()

    expect(bb.port).toBe(18790)
    expect(bb.webhookPath).toBe("/bluebubbles-webhook")
    expect(bb.requestTimeoutMs).toBe(30000)
  })

  it("returns bluebubblesChannel config from runtime/config", async () => {
    const { getBlueBubblesChannelConfig } = await importConfigModule({
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/hooks/imessage",
        requestTimeoutMs: 12345,
      },
    })
    const bb = getBlueBubblesChannelConfig()

    expect(bb.port).toBe(18888)
    expect(bb.webhookPath).toBe("/hooks/imessage")
    expect(bb.requestTimeoutMs).toBe(12345)
  })
})

describe("getIntegrationsConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("returns default integrations config when not specified", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getIntegrationsConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const ic = getIntegrationsConfig()

    expect(ic.perplexityApiKey).toBe("")
  })

  it("returns integrations config from runtime/config", async () => {
    const configData = {
      integrations: {
        perplexityApiKey: "pplx-key-123",
      },
    }

    const { getIntegrationsConfig } = await importConfigModule(configData)
    const ic = getIntegrationsConfig()

    expect(ic.perplexityApiKey).toBe("pplx-key-123")
  })

  it("returns a shallow copy (not the same reference)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { getIntegrationsConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const ic1 = getIntegrationsConfig()
    const ic2 = getIntegrationsConfig()

    expect(ic1).toEqual(ic2)
    expect(ic1).not.toBe(ic2)
  })
})

describe("patchRuntimeConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("deep-merges partial config into cached config", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { patchRuntimeConfig, resetConfigCache, getAzureConfig } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { azure: { apiKey: "test-key" } } })
    const azure = getAzureConfig()

    expect(azure.apiKey).toBe("test-key")
    // Other fields should remain as defaults
    expect(azure.endpoint).toBe("")
    expect(azure.apiVersion).toBe("2025-04-01-preview")
  })

  it("overrides specific fields while leaving others untouched", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { patchRuntimeConfig, resetConfigCache, getAzureConfig } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "original-key",
          endpoint: "https://original.openai.azure.com",
          deployment: "gpt-4",
          modelName: "gpt-4",
          apiVersion: "2025-01-01",
        },
      },
    })
    patchRuntimeConfig({ providers: { azure: { apiKey: "overridden-key" } } })
    const azure = getAzureConfig()

    expect(azure.apiKey).toBe("overridden-key")
    expect(azure.endpoint).toBe("https://original.openai.azure.com")
    expect(azure.deployment).toBe("gpt-4")
  })

  it("works with resetConfigCache to restore defaults", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { patchRuntimeConfig, resetConfigCache, getContextConfig } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ context: { maxTokens: 99999 } })

    expect(getContextConfig().maxTokens).toBe(99999)

    resetConfigCache()
    expect(getContextConfig().maxTokens).toBe(80000)
  })

  it("handles empty partial (no-op)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { patchRuntimeConfig, resetConfigCache, getContextConfig } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({})
    const ctx = getContextConfig()

    expect(ctx.maxTokens).toBe(80000)
    expect(ctx.contextMargin).toBe(20)
  })

  it("can set nested config sections (teamsChannel, integrations)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { patchRuntimeConfig, resetConfigCache, getTeamsChannelConfig, getIntegrationsConfig } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      teamsChannel: { skipConfirmation: true, port: 5000 },
      integrations: { perplexityApiKey: "pplx-test" },
    })

    const tc = getTeamsChannelConfig()
    expect(tc.skipConfirmation).toBe(true)
    expect(tc.port).toBe(5000)
    expect(tc).not.toHaveProperty("disableStreaming") // removed

    const ic = getIntegrationsConfig()
    expect(ic.perplexityApiKey).toBe("pplx-test")
  })

  it("can overwrite then reset then overwrite again", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))

    const { patchRuntimeConfig, resetConfigCache, getMinimaxConfig } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "first" } } })
    expect(getMinimaxConfig().apiKey).toBe("first")

    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "second" } } })
    expect(getMinimaxConfig().apiKey).toBe("second")
  })
})

describe("getTeamsSecondaryConfig", () => {
  it("returns secondary teams config from runtime/config", async () => {
    vi.resetModules()
    const { getTeamsSecondaryConfig } = await importConfigModule({
      teamsSecondary: {
        clientId: "sec-id",
        clientSecret: "sec-secret",
        tenantId: "sec-tenant",
        managedIdentityClientId: "",
      },
    })

    const cfg = getTeamsSecondaryConfig()
    expect(cfg.clientId).toBe("sec-id")
    expect(cfg.clientSecret).toBe("sec-secret")
  })
})

describe("resolveOAuthForTenant", () => {
  it("returns base oauth config when no tenantId given", async () => {
    vi.resetModules()
    const { resolveOAuthForTenant } = await importConfigModule({
      oauth: {
        graphConnectionName: "graph-conn",
        adoConnectionName: "ado-conn",
        githubConnectionName: "gh-conn",
      },
    })

    const result = resolveOAuthForTenant()
    expect(result.graphConnectionName).toBe("graph-conn")
    expect(result.adoConnectionName).toBe("ado-conn")
  })

  it("applies tenant overrides when tenantId matches", async () => {
    vi.resetModules()
    const { resolveOAuthForTenant } = await importConfigModule({
      oauth: {
        graphConnectionName: "default-graph",
        adoConnectionName: "default-ado",
        githubConnectionName: "default-gh",
        tenantOverrides: {
          "tenant-x": {
            graphConnectionName: "tenant-x-graph",
          },
        },
      },
    })

    const result = resolveOAuthForTenant("tenant-x")
    expect(result.graphConnectionName).toBe("tenant-x-graph")
    expect(result.adoConnectionName).toBe("default-ado")
  })
})

describe("provider configs are credentials-only (no model fields)", () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}))
  })

  it("AnthropicProviderConfig has setupToken but no model", async () => {
    const { getAnthropicConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const cfg = getAnthropicConfig()
    expect(cfg).toHaveProperty("setupToken")
    expect(cfg).not.toHaveProperty("model")
  })

  it("AzureProviderConfig has credentials but no modelName", async () => {
    const { getAzureConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const cfg = getAzureConfig()
    expect(cfg).toHaveProperty("apiKey")
    expect(cfg).toHaveProperty("endpoint")
    expect(cfg).toHaveProperty("deployment")
    expect(cfg).not.toHaveProperty("modelName")
  })

  it("MinimaxProviderConfig has apiKey but no model", async () => {
    const { getMinimaxConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const cfg = getMinimaxConfig()
    expect(cfg).toHaveProperty("apiKey")
    expect(cfg).not.toHaveProperty("model")
  })

  it("OpenAICodexProviderConfig has oauthAccessToken but no model", async () => {
    const { getOpenAICodexConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const cfg = getOpenAICodexConfig()
    expect(cfg).toHaveProperty("oauthAccessToken")
    expect(cfg).not.toHaveProperty("model")
  })

  it("GithubCopilotProviderConfig has githubToken and baseUrl but no model", async () => {
    const { getGithubCopilotConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    const cfg = getGithubCopilotConfig()
    expect(cfg).toHaveProperty("githubToken")
    expect(cfg).toHaveProperty("baseUrl")
    expect(cfg).not.toHaveProperty("model")
  })

  it("DEFAULT_LOCAL_RUNTIME_CONFIG does not write provider credentials", async () => {
    const { loadConfig } = await importConfigModule()
    const config = loadConfig()

    expect(config).not.toHaveProperty("providers")
    expect(config.teams).toBeDefined()
    expect(config.integrations).toBeDefined()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })
})

describe("getSyncConfig", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("defaults to disabled when sync is not in agent.json", async () => {
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      version: 2,
      enabled: true,
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    })

    const { getSyncConfig } = await import("../../heart/config")
    const sync = getSyncConfig()
    expect(sync.enabled).toBe(false)
    expect(sync.remote).toBe("origin")
  })

  it("reads sync config from agent.json", async () => {
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      version: 2,
      enabled: true,
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      sync: { enabled: true, remote: "upstream" },
    })

    const { getSyncConfig } = await import("../../heart/config")
    const sync = getSyncConfig()
    expect(sync.enabled).toBe(true)
    expect(sync.remote).toBe("upstream")
  })

  it("defaults remote to origin when only enabled is specified", async () => {
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      version: 2,
      enabled: true,
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      sync: { enabled: true },
    })

    const { getSyncConfig } = await import("../../heart/config")
    const sync = getSyncConfig()
    expect(sync.enabled).toBe(true)
    expect(sync.remote).toBe("origin")
  })
})
