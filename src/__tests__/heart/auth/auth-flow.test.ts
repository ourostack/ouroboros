import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

const providerCredentialWrites = vi.hoisted(() => [] as Array<{
  agentName: string
  provider: string
  credentials: Record<string, string | number>
  config: Record<string, string | number>
}>)
const mockRefreshProviderCredentialPool = vi.hoisted(() => vi.fn(async (agentName: string) => ({
  ok: true,
  poolPath: `vault:${agentName}:providers/*`,
  pool: {
    schemaVersion: 1,
    updatedAt: "2026-04-13T00:00:00.000Z",
    providers: {},
  },
})))
const mockUpsertProviderCredential = vi.hoisted(() => vi.fn(async (input: {
  agentName: string
  provider: string
  credentials: Record<string, string | number>
  config: Record<string, string | number>
}) => {
  providerCredentialWrites.push({
    agentName: input.agentName,
    provider: input.provider,
    credentials: input.credentials,
    config: input.config,
  })
  return {
    provider: input.provider,
    revision: `test_${input.provider}`,
    updatedAt: "2026-04-13T00:00:00.000Z",
    credentials: input.credentials,
    config: input.config,
    provenance: { source: "auth-flow", updatedAt: "2026-04-13T00:00:00.000Z" },
  }
}))
const mockRefreshAnthropicToken = vi.hoisted(() => vi.fn(async () => null))

vi.mock("../../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: mockRefreshProviderCredentialPool,
    upsertProviderCredential: mockUpsertProviderCredential,
  }
})

vi.mock("../../../heart/providers/anthropic-token", () => ({
  refreshAnthropicToken: mockRefreshAnthropicToken,
}))

import { emitNervesEvent } from "../../../nerves/runtime"
import {
  collectRuntimeAuthCredentials,
  readAgentConfigForAgent,
  resolveHatchCredentials,
  storeProviderCredentials,
  writeAgentModel,
  runRuntimeAuthFlow,
  writeAgentProviderSelection,
} from "../../../heart/auth/auth-flow"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.test_run",
    message: testName,
    meta: { test: true },
  })
}

const cleanup: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  cleanup.push(dir)
  return dir
}

function writeAgentConfig(
  bundlesRoot: string,
  agentName: string,
  provider: unknown,
  extra: Record<string, unknown> = {},
): string {
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  const config = {
    version: 2,
    enabled: true,
    provider,
    humanFacing: { provider, model: "" },
    agentFacing: { provider, model: "" },
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
    context: {
      maxTokens: 80000,
      contextMargin: 20,
    },
    ...extra,
  }
  const configPath = path.join(agentRoot, "agent.json")
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return configPath
}

function expectProviderCredentialWrite(agentName: string, provider: string) {
  const write = providerCredentialWrites.find((entry) => entry.agentName === agentName && entry.provider === provider)
  expect(write).toBeDefined()
  return write!
}

afterEach(() => {
  vi.restoreAllMocks()
  providerCredentialWrites.splice(0)
  mockRefreshProviderCredentialPool.mockClear()
  mockUpsertProviderCredential.mockClear()
  mockRefreshAnthropicToken.mockClear()
  while (cleanup.length > 0) {
    const entry = cleanup.pop()
    if (!entry) continue
    fs.rmSync(entry, { recursive: true, force: true })
  }
})

describe("runtime auth flow", () => {
  it("rejects persistent provider auth for SerpentGuide", async () => {
    emitTestEvent("serpent guide persistent auth unsupported")

    await expect(() =>
      runRuntimeAuthFlow({
        agentName: "SerpentGuide",
        provider: "minimax",
        promptInput: async () => "minimax-key",
      }),
    ).rejects.toThrow("persistent SerpentGuide auth is not supported")
    expect(mockRefreshProviderCredentialPool).not.toHaveBeenCalled()
  })

  it("asks the operator to unlock the agent vault before auth when the vault is unavailable", async () => {
    emitTestEvent("auth flow vault unavailable")
    mockRefreshProviderCredentialPool.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:MiniBot:providers/*",
      error: "vault locked",
    })

    await expect(() =>
      runRuntimeAuthFlow({
        agentName: "MiniBot",
        provider: "minimax",
        promptInput: async () => "minimax-key",
      }),
    ).rejects.toThrow("ouro vault replace --agent MiniBot")
  })

  it("reads agent config and rewrites provider selection", () => {
    emitTestEvent("reads and rewrites agent config")
    const bundlesRoot = makeTempDir("auth-flow-bundles")
    const agentName = "RewriteBot"
    const configPath = writeAgentConfig(bundlesRoot, agentName, "anthropic", {
      customField: "keep-me",
    })

    expect(readAgentConfigForAgent(agentName, bundlesRoot)).toEqual({
      configPath,
      config: expect.objectContaining({
        humanFacing: { provider: "anthropic", model: "" },
        customField: "keep-me",
      }),
    })

    expect(writeAgentProviderSelection(agentName, "human", "openai-codex", bundlesRoot)).toBe(configPath)

    const updated = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>
    expect((updated.humanFacing as any).provider).toBe("openai-codex")
    expect(updated.customField).toBe("keep-me")
  })

  it("fails fast when agent.json is not an object", () => {
    emitTestEvent("rejects non-object agent config")
    const bundlesRoot = makeTempDir("auth-flow-bad-config")
    const agentName = "BrokenBot"
    const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "agent.json"), "[]\n", "utf8")

    expect(() => readAgentConfigForAgent(agentName, bundlesRoot)).toThrow("Failed to read agent config")
    expect(() => readAgentConfigForAgent(agentName, bundlesRoot)).toThrow("expected object")
  })

  it("rejects unsupported provider selections in agent.json", () => {
    emitTestEvent("rejects unsupported provider")
    const bundlesRoot = makeTempDir("auth-flow-unsupported-provider")
    const agentName = "UnsupportedBot"
    writeAgentConfig(bundlesRoot, agentName, "not-real")

    expect(() => readAgentConfigForAgent(agentName, bundlesRoot)).toThrow("unsupported provider 'not-real'")
  })

  it("always runs codex login and writes the OpenAI Codex credential to the provider vault", async () => {
    emitTestEvent("always refreshes codex token")
    const homeDir = makeTempDir("auth-flow-home-codex-existing")
    const agentName = "CodexExisting"
    const progress: string[] = []
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(
      path.join(homeDir, ".codex", "auth.json"),
      `${JSON.stringify({ tokens: { access_token: "  oauth-token-refreshed  " } }, null, 2)}\n`,
      "utf8",
    )

    const spawnSync = vi.fn(() => ({ status: 0 })) as any
    const result = await runRuntimeAuthFlow(
      {
        agentName,
        provider: "openai-codex",
        onProgress: (message) => progress.push(message),
      },
      {
        homeDir,
        spawnSync,
      },
    )

    expect(result.message).toBe(`authenticated ${agentName} with openai-codex`)
    expect(progress).toEqual([
      `checking ${agentName}'s vault access...`,
      "starting openai-codex browser login...",
      "openai-codex login complete; reading local Codex token...",
      `openai-codex credentials collected; storing in ${agentName}'s vault...`,
      "credentials stored at providers/openai-codex; local provider snapshot refreshed.",
    ])
    expect(spawnSync).toHaveBeenCalledWith("codex", ["login"], expect.any(Object))

    expect(result.credentialPath).toBe("providers/openai-codex")
    const write = expectProviderCredentialWrite(agentName, "openai-codex")
    expect(write.credentials.oauthAccessToken).toBe("oauth-token-refreshed")
  })

  it("treats non-string Codex auth tokens as missing and re-runs login", async () => {
    emitTestEvent("codex token must be a string")
    const homeDir = makeTempDir("auth-flow-home-codex-invalid-token")
    const agentName = "CodexInvalidToken"
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(
      path.join(homeDir, ".codex", "auth.json"),
      `${JSON.stringify({ tokens: { access_token: 123 } }, null, 2)}\n`,
      "utf8",
    )
    const spawnSync = vi.fn(() => {
      fs.writeFileSync(
        path.join(homeDir, ".codex", "auth.json"),
        `${JSON.stringify({ tokens: { access_token: "oauth-token-after-relogin" } }, null, 2)}\n`,
        "utf8",
      )
      return { status: 0 }
    }) as any

    await runRuntimeAuthFlow(
      {
        agentName,
        provider: "openai-codex",
      },
      {
        homeDir,
        spawnSync,
      },
    )

    expect(spawnSync).toHaveBeenCalledOnce()
    expect(
      expectProviderCredentialWrite(agentName, "openai-codex").credentials.oauthAccessToken,
    ).toBe("oauth-token-after-relogin")
  })

  it("runs codex login when no existing token is present", async () => {
    emitTestEvent("runs codex login")
    const homeDir = makeTempDir("auth-flow-home-codex-login")
    const agentName = "CodexLogin"
    const spawnSync = vi.fn(() => {
      fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
      fs.writeFileSync(
        path.join(homeDir, ".codex", "auth.json"),
        `${JSON.stringify({ tokens: { access_token: "oauth-token-from-login" } }, null, 2)}\n`,
        "utf8",
      )
      return { status: 0 }
    }) as any

    const result = await runRuntimeAuthFlow(
      {
        agentName,
        provider: "openai-codex",
      },
      {
        homeDir,
        spawnSync,
      },
    )

    expect(spawnSync).toHaveBeenCalledWith("codex", ["login"], { stdio: "inherit" })
    expect(result.credentialPath).toBe("providers/openai-codex")
    expect(
      expectProviderCredentialWrite(agentName, "openai-codex").credentials.oauthAccessToken,
    ).toBe("oauth-token-from-login")
  })

  it("surfaces codex login execution failures", async () => {
    emitTestEvent("codex login spawn error")
    const homeDir = makeTempDir("auth-flow-home-codex-error")

    await expect(() =>
      runRuntimeAuthFlow(
        {
          agentName: "CodexError",
          provider: "openai-codex",
        },
        {
          homeDir,
          spawnSync: vi.fn(() => ({ error: new Error("boom"), status: null })) as any,
        },
      ),
    ).rejects.toThrow("Failed to run 'codex login': boom")
  })

  it("surfaces codex login non-zero exit codes", async () => {
    emitTestEvent("codex login non-zero exit")
    const homeDir = makeTempDir("auth-flow-home-codex-status")

    await expect(() =>
      runRuntimeAuthFlow(
        {
          agentName: "CodexStatus",
          provider: "openai-codex",
        },
        {
          homeDir,
          spawnSync: vi.fn(() => ({ status: 7 })) as any,
        },
      ),
    ).rejects.toThrow("'codex login' exited with status 7.")
  })

  it("fails when codex login completes without writing a token", async () => {
    emitTestEvent("codex login missing token")
    const homeDir = makeTempDir("auth-flow-home-codex-missing")

    await expect(() =>
      runRuntimeAuthFlow(
        {
          agentName: "CodexMissing",
          provider: "openai-codex",
        },
        {
          homeDir,
          spawnSync: vi.fn(() => ({ status: 0 })) as any,
        },
      ),
    ).rejects.toThrow("Codex login completed but no token was found")
  })

  it("runs claude setup-token and writes the pasted Anthropic token", async () => {
    emitTestEvent("anthropic setup-token success")
    const homeDir = makeTempDir("auth-flow-home-anthropic")
    const setupToken = `sk-ant-oat01-${"a".repeat(90)}`
    const spawnSync = vi.fn(() => ({ status: 0 })) as any

    const result = await runRuntimeAuthFlow(
      {
        agentName: "AnthropicBot",
        provider: "anthropic",
        promptInput: async () => setupToken,
      },
      {
        homeDir,
        spawnSync,
      },
    )

    expect(spawnSync).toHaveBeenCalledWith("claude", ["setup-token"], { stdio: "inherit" })
    expect(result.message).toBe("authenticated AnthropicBot with anthropic")
    expect(expectProviderCredentialWrite("AnthropicBot", "anthropic").credentials.setupToken).toBe(
      setupToken,
    )
  })

  it("requires prompt input for Anthropics setup-token flow", async () => {
    emitTestEvent("anthropic prompt required")
    const homeDir = makeTempDir("auth-flow-home-anthropic-no-prompt")

    await expect(() =>
      runRuntimeAuthFlow(
        {
          agentName: "AnthropicNoPrompt",
          provider: "anthropic",
        },
        {
          homeDir,
          spawnSync: vi.fn(() => ({ status: 0 })) as any,
        },
      ),
    ).rejects.toThrow("No prompt input is available for anthropic authentication.")
  })

  it.each([
    ["blank token", "   ", "No Anthropic setup token was provided."],
    ["bad prefix", "not-a-setup-token", "Invalid Anthropic setup token format."],
    ["too short", `sk-ant-oat01-${"a".repeat(10)}`, "Anthropic setup token looks too short."],
  ])("rejects %s during Anthropic setup", async (_label, token, expected) => {
    emitTestEvent(`anthropic invalid token ${expected}`)
    const homeDir = makeTempDir("auth-flow-home-anthropic-invalid")

    await expect(() =>
      runRuntimeAuthFlow(
        {
          agentName: "AnthropicInvalid",
          provider: "anthropic",
          promptInput: async () => token,
        },
        {
          homeDir,
          spawnSync: vi.fn(() => ({ status: 0 })) as any,
        },
      ),
    ).rejects.toThrow(expected)
  })

  it("surfaces claude setup-token execution failures", async () => {
    emitTestEvent("anthropic setup spawn error")
    const homeDir = makeTempDir("auth-flow-home-anthropic-error")

    await expect(() =>
      runRuntimeAuthFlow(
        {
          agentName: "AnthropicError",
          provider: "anthropic",
          promptInput: async () => `sk-ant-oat01-${"a".repeat(90)}`,
        },
        {
          homeDir,
          spawnSync: vi.fn(() => ({ error: new Error("setup broke"), status: null })) as any,
        },
      ),
    ).rejects.toThrow("Failed to run 'claude setup-token': setup broke")
  })

  it("surfaces claude setup-token non-zero exit codes", async () => {
    emitTestEvent("anthropic setup non-zero exit")
    const homeDir = makeTempDir("auth-flow-home-anthropic-status")

    await expect(() =>
      runRuntimeAuthFlow(
        {
          agentName: "AnthropicStatus",
          provider: "anthropic",
          promptInput: async () => `sk-ant-oat01-${"a".repeat(90)}`,
        },
        {
          homeDir,
          spawnSync: vi.fn(() => ({ status: 11 })) as any,
        },
      ),
    ).rejects.toThrow("'claude setup-token' exited with status 11.")
  })

  it("writes MiniMax API keys", async () => {
    emitTestEvent("minimax success")
    const homeDir = makeTempDir("auth-flow-home-minimax")

    const result = await runRuntimeAuthFlow({
      agentName: "MiniBot",
      provider: "minimax",
      promptInput: async () => "  minimax-key  ",
    }, {
      homeDir,
    })

    expect(result.message).toBe("authenticated MiniBot with minimax")
    expect(expectProviderCredentialWrite("MiniBot", "minimax").credentials.apiKey).toBe("minimax-key")
  })

  it("rejects blank MiniMax API keys", async () => {
    emitTestEvent("minimax blank key")
    const homeDir = makeTempDir("auth-flow-home-minimax-blank")

    await expect(() =>
      runRuntimeAuthFlow({
        agentName: "MiniBlank",
        provider: "minimax",
        promptInput: async () => "   ",
      }, {
        homeDir,
      }),
    ).rejects.toThrow("MiniMax API key is required.")
  })

  it("defaults runtime auth writes to os.homedir when no homeDir dep is provided", async () => {
    emitTestEvent("defaults to os.homedir")
    const agentName = `DefaultHomeBot-${Date.now()}`

    const result = await runRuntimeAuthFlow({
      agentName,
      provider: "minimax",
      promptInput: async () => "minimax-default-home-key",
    })

    expect(result.credentialPath).toBe("providers/minimax")
    expect(expectProviderCredentialWrite(agentName, "minimax").credentials.apiKey).toBe("minimax-default-home-key")
  })

  it("writes Azure credentials", async () => {
    emitTestEvent("azure success")
    const homeDir = makeTempDir("auth-flow-home-azure")
    const answers = [
      "azure-api-key",
      "https://example.openai.azure.com",
      "gpt-4o-mini",
    ]

    const result = await runRuntimeAuthFlow({
      agentName: "AzureBot",
      provider: "azure",
      promptInput: async () => answers.shift() ?? "",
    }, {
      homeDir,
    })

    expect(result.message).toBe("authenticated AzureBot with azure")
    const write = expectProviderCredentialWrite("AzureBot", "azure")
    expect(write.credentials.apiKey).toBe("azure-api-key")
    expect(write.config.endpoint).toBe("https://example.openai.azure.com")
    expect(write.config.deployment).toBe("gpt-4o-mini")
  })

  it("rejects incomplete Azure credentials", async () => {
    emitTestEvent("azure incomplete")
    const homeDir = makeTempDir("auth-flow-home-azure-incomplete")
    const answers = ["azure-api-key", "", "gpt-4o-mini"]

    await expect(() =>
      runRuntimeAuthFlow({
        agentName: "AzureIncomplete",
        provider: "azure",
        promptInput: async () => answers.shift() ?? "",
      }, {
        homeDir,
      }),
    ).rejects.toThrow("Azure endpoint is required.")
  })

  it("stores provider credentials through the provider vault path", async () => {
    emitTestEvent("store provider credentials direct")
    const agentName = `DirectWriteBot-${Date.now()}`

    const result = await storeProviderCredentials(agentName, "minimax", { apiKey: "direct-minimax-key" })

    expect(result.credentialPath).toBe("providers/minimax")
    expect(expectProviderCredentialWrite(agentName, "minimax").credentials.apiKey).toBe("direct-minimax-key")
  })

  it("uses shared runtime auth to resolve missing anthropic hatch credentials", async () => {
    emitTestEvent("shared anthropic hatch credentials")
    const promptInput = vi.fn(async () => "unexpected")
    const runAuthFlow = vi.fn(async () => ({
      agentName: "SharedAnthropic",
      provider: "anthropic",
      message: "authenticated SharedAnthropic with anthropic",
      credentialPath: "providers/anthropic",
      credentials: {
        setupToken: `sk-ant-oat01-${"b".repeat(90)}`,
      },
    }))

    const credentials = await resolveHatchCredentials({
      agentName: "SharedAnthropic",
      provider: "anthropic",
      promptInput,
      runAuthFlow,
    })

    expect(runAuthFlow).toHaveBeenCalledWith({
      agentName: "SharedAnthropic",
      provider: "anthropic",
      promptInput,
      onProgress: undefined,
    })
    expect(promptInput).not.toHaveBeenCalledWith("Anthropic setup-token: ")
    expect(credentials).toEqual({
      setupToken: `sk-ant-oat01-${"b".repeat(90)}`,
    })
  })

  it("falls back to direct hatch prompts when shared auth is unavailable", async () => {
    emitTestEvent("fallback hatch prompts")
    const promptInput = vi.fn(async (question: string) => {
      if (question === "Anthropic setup-token: ") return `sk-ant-oat01-${"c".repeat(90)}`
      if (question === "OpenAI Codex OAuth token: ") return "oauth-hatch-token"
      return ""
    })

    const anthropic = await resolveHatchCredentials({
      agentName: "PromptAnthropic",
      provider: "anthropic",
      promptInput,
    })
    const codex = await resolveHatchCredentials({
      agentName: "PromptCodex",
      provider: "openai-codex",
      promptInput,
    })

    expect(anthropic).toEqual({
      setupToken: `sk-ant-oat01-${"c".repeat(90)}`,
    })
    expect(codex).toEqual({
      oauthAccessToken: "oauth-hatch-token",
    })
  })

  it("fills minimax and azure hatch prompts without overwriting provided values", async () => {
    emitTestEvent("prompt remaining hatch credentials")
    const promptInput = vi.fn(async (question: string) => {
      if (question === "MiniMax API key: ") return "minimax-from-prompt"
      if (question === "Azure endpoint: ") return "https://prompt.azure.test"
      if (question === "Azure deployment: ") return "prompt-deployment"
      return ""
    })

    const minimax = await resolveHatchCredentials({
      agentName: "PromptMini",
      provider: "minimax",
      promptInput,
    })
    const azure = await resolveHatchCredentials({
      agentName: "PromptAzure",
      provider: "azure",
      credentials: {
        apiKey: "existing-api-key",
      },
      promptInput,
    })

    expect(minimax).toEqual({
      apiKey: "minimax-from-prompt",
    })
    expect(azure).toEqual({
      apiKey: "existing-api-key",
      endpoint: "https://prompt.azure.test",
      deployment: "prompt-deployment",
    })
    expect(promptInput).not.toHaveBeenCalledWith("Azure API key: ")
  })
})

// --- Unit 3a: github-copilot auth flow tests ---

describe("github-copilot auth flow", () => {
  it("collectRuntimeAuthCredentials reads GH_TOKEN env var first", async () => {
    emitTestEvent("github-copilot GH_TOKEN env")
    const homeDir = makeTempDir("auth-flow-home-ghcopilot-env")
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ endpoints: { api: "https://api.copilot.example.com" } }),
    })
    vi.stubGlobal("fetch", mockFetch)
    vi.stubEnv("GH_TOKEN", "ghp_from_env")

    try {
      const creds = await collectRuntimeAuthCredentials(
        { agentName: "CopilotBot", provider: "github-copilot" },
        { homeDir },
      )
      expect(creds.githubToken).toBe("ghp_from_env")
      expect(creds.baseUrl).toBe("https://api.copilot.example.com")
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/copilot_internal/user",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer ghp_from_env",
          }),
        }),
      )
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it("collectRuntimeAuthCredentials falls back to gh auth token", async () => {
    emitTestEvent("github-copilot gh auth token")
    const homeDir = makeTempDir("auth-flow-home-ghcopilot-gh")
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: "ghp_from_gh_cli\n",
    })
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ endpoints: { api: "https://api.copilot.test.com" } }),
    })
    vi.stubGlobal("fetch", mockFetch)
    vi.stubEnv("GH_TOKEN", "")

    try {
      const creds = await collectRuntimeAuthCredentials(
        { agentName: "CopilotBot2", provider: "github-copilot" },
        { homeDir, spawnSync: spawnSync as any },
      )
      expect(spawnSync).toHaveBeenCalledWith("gh", ["auth", "token"], { encoding: "utf8" })
      expect(creds.githubToken).toBe("ghp_from_gh_cli")
      expect(creds.baseUrl).toBe("https://api.copilot.test.com")
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it("collectRuntimeAuthCredentials falls back to gh auth login", async () => {
    emitTestEvent("github-copilot gh auth login fallback")
    const homeDir = makeTempDir("auth-flow-home-ghcopilot-login")
    let loginCalled = false
    const spawnSync = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "auth" && args[1] === "token" && !loginCalled) {
        return { status: 1, stdout: "" }
      }
      if (args[0] === "auth" && args[1] === "login") {
        loginCalled = true
        return { status: 0 }
      }
      if (args[0] === "auth" && args[1] === "token" && loginCalled) {
        return { status: 0, stdout: "ghp_from_login\n" }
      }
      return { status: 1 }
    })
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ endpoints: { api: "https://api.copilot.login.com" } }),
    })
    vi.stubGlobal("fetch", mockFetch)
    vi.stubEnv("GH_TOKEN", "")

    try {
      const creds = await collectRuntimeAuthCredentials(
        { agentName: "CopilotBot3", provider: "github-copilot" },
        { homeDir, spawnSync: spawnSync as any },
      )
      expect(spawnSync).toHaveBeenCalledWith("gh", ["auth", "login"], { stdio: "inherit" })
      expect(creds.githubToken).toBe("ghp_from_login")
      expect(creds.baseUrl).toBe("https://api.copilot.login.com")
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it("collectRuntimeAuthCredentials throws if gh auth login fails", async () => {
    emitTestEvent("github-copilot gh auth login failure")
    const homeDir = makeTempDir("auth-flow-home-ghcopilot-fail")
    const spawnSync = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "auth" && args[1] === "token") {
        return { status: 1, stdout: "" }
      }
      if (args[0] === "auth" && args[1] === "login") {
        return { status: 1 }
      }
      return { status: 1 }
    })
    vi.stubEnv("GH_TOKEN", "")

    try {
      await expect(
        collectRuntimeAuthCredentials(
          { agentName: "CopilotFail", provider: "github-copilot" },
          { homeDir, spawnSync: spawnSync as any },
        ),
      ).rejects.toThrow(/gh auth login/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("collectRuntimeAuthCredentials throws if endpoint discovery fails", async () => {
    emitTestEvent("github-copilot endpoint discovery failure")
    const homeDir = makeTempDir("auth-flow-home-ghcopilot-disco-fail")
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    })
    vi.stubGlobal("fetch", mockFetch)
    vi.stubEnv("GH_TOKEN", "ghp_test")

    try {
      await expect(
        collectRuntimeAuthCredentials(
          { agentName: "CopilotDisco", provider: "github-copilot" },
          { homeDir },
        ),
      ).rejects.toThrow(/endpoint discovery/)
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it("storeProviderCredentials splits github-copilot credential and config fields", async () => {
    emitTestEvent("github-copilot storeProviderCredentials")
    const result = await storeProviderCredentials(
      "CopilotWrite",
      "github-copilot",
      { githubToken: "ghp_written", baseUrl: "https://api.written.com" },
    )
    expect(result.credentialPath).toBe("providers/github-copilot")
    const write = expectProviderCredentialWrite("CopilotWrite", "github-copilot")
    expect(write.credentials.githubToken).toBe("ghp_written")
    expect(write.config.baseUrl).toBe("https://api.written.com")
  })

  it("resolveHatchCredentials for github-copilot delegates to runAuthFlow", async () => {
    emitTestEvent("github-copilot resolveHatchCredentials")
    const mockRunAuthFlow = vi.fn().mockResolvedValue({
      agentName: "CopilotHatch",
      provider: "github-copilot",
      credentialPath: "providers/github-copilot",
      message: "ok",
      credentials: { githubToken: "ghp_hatched", baseUrl: "https://api.hatched.com" },
    })
    const creds = await resolveHatchCredentials({
      agentName: "CopilotHatch",
      provider: "github-copilot",
      runAuthFlow: mockRunAuthFlow as any,
    })
    expect(mockRunAuthFlow).toHaveBeenCalled()
    expect(creds.githubToken).toBe("ghp_hatched")
    expect(creds.baseUrl).toBe("https://api.hatched.com")
  })

  it("readAgentConfigForAgent accepts github-copilot", () => {
    emitTestEvent("github-copilot readAgentConfigForAgent")
    const bundlesRoot = makeTempDir("auth-flow-ghcopilot-config")
    writeAgentConfig(bundlesRoot, "CopilotConfig", "github-copilot")
    const { config } = readAgentConfigForAgent("CopilotConfig", bundlesRoot)
    expect(config.humanFacing.provider).toBe("github-copilot")
  })
})

describe("readAgentConfigForAgent v2 inline migration", () => {
  it("auto-migrates v1 config on disk and returns v2", () => {
    emitTestEvent("readAgentConfigForAgent v1 auto-migration")
    const bundlesRoot = makeTempDir("auth-flow-v1-migration")
    const agentName = "MigrateBot"

    // Write v1 config
    const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }, null, 2) + "\n",
    )

    const { config } = readAgentConfigForAgent(agentName, bundlesRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })

  it("returns v2 config directly without migration", () => {
    emitTestEvent("readAgentConfigForAgent v2 no migration")
    const bundlesRoot = makeTempDir("auth-flow-v2-direct")
    const agentName = "V2Bot"

    const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "azure", model: "gpt-4o" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }, null, 2) + "\n",
    )

    const { config } = readAgentConfigForAgent(agentName, bundlesRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "azure", model: "gpt-4o" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })
})

describe("writeAgentModel", () => {
  it("updates model for anthropic provider in agent.json", () => {
    emitTestEvent("writeAgentModel anthropic")
    const bundlesRoot = makeTempDir("auth-flow-model-anthropic")
    writeAgentConfig(bundlesRoot, "ModelTest", "anthropic", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })

    const result = writeAgentModel("ModelTest", "human", "claude-sonnet-4.6", { bundlesRoot })
    expect(result.provider).toBe("anthropic")
    expect(result.previousModel).toBe("claude-opus-4-6")

    const updated = JSON.parse(fs.readFileSync(result.configPath, "utf8")) as any
    expect(updated.humanFacing.model).toBe("claude-sonnet-4.6")
  })

  it("updates model for azure provider in agent.json", () => {
    emitTestEvent("writeAgentModel azure")
    const bundlesRoot = makeTempDir("auth-flow-model-azure")
    writeAgentConfig(bundlesRoot, "AzureModel", "azure", {
      humanFacing: { provider: "azure", model: "gpt-4o-mini" },
      agentFacing: { provider: "azure", model: "gpt-4o-mini" },
    })

    const result = writeAgentModel("AzureModel", "human", "gpt-5", { bundlesRoot })
    expect(result.provider).toBe("azure")
    expect(result.previousModel).toBe("gpt-4o-mini")

    const updated = JSON.parse(fs.readFileSync(result.configPath, "utf8")) as any
    expect(updated.humanFacing.model).toBe("gpt-5")
  })

  it("handles empty previous model", () => {
    emitTestEvent("writeAgentModel empty previous")
    const bundlesRoot = makeTempDir("auth-flow-model-empty")
    writeAgentConfig(bundlesRoot, "EmptyModel", "minimax", {
      humanFacing: { provider: "minimax", model: "" },
      agentFacing: { provider: "minimax", model: "" },
    })

    const result = writeAgentModel("EmptyModel", "human", "minimax-text-02", { bundlesRoot })
    expect(result.provider).toBe("minimax")
    expect(result.previousModel).toBe("")

    const updated = JSON.parse(fs.readFileSync(result.configPath, "utf8")) as any
    expect(updated.humanFacing.model).toBe("minimax-text-02")
  })
})

describe("writeAgentProviderSelection with facing", () => {
  it("writes to humanFacing when facing is 'human'", () => {
    emitTestEvent("writeAgentProviderSelection human facing")
    const bundlesRoot = makeTempDir("auth-flow-provider-human")
    const agentName = "FacingHumanBot"
    const configPath = writeAgentConfig(bundlesRoot, agentName, "anthropic", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })

    writeAgentProviderSelection(agentName, "human", "openai-codex", bundlesRoot)

    const updated = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>
    expect(updated.humanFacing.provider).toBe("openai-codex")
    expect(updated.humanFacing.model).toBe("gpt-5.4")
    // agentFacing should be unchanged
    expect(updated.agentFacing.provider).toBe("anthropic")
    expect(updated.agentFacing.model).toBe("claude-opus-4-6")
  })

  it("writes to agentFacing when facing is 'agent'", () => {
    emitTestEvent("writeAgentProviderSelection agent facing")
    const bundlesRoot = makeTempDir("auth-flow-provider-agent")
    const agentName = "FacingAgentBot"
    const configPath = writeAgentConfig(bundlesRoot, agentName, "anthropic", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })

    writeAgentProviderSelection(agentName, "agent", "github-copilot", bundlesRoot)

    const updated = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>
    expect(updated.agentFacing.provider).toBe("github-copilot")
    expect(updated.agentFacing.model).toBe("claude-opus-4-6")
    // humanFacing should be unchanged
    expect(updated.humanFacing.provider).toBe("anthropic")
  })

  it("does not carry a clearly incompatible model across provider switches", () => {
    emitTestEvent("writeAgentProviderSelection resets incompatible model")
    const bundlesRoot = makeTempDir("auth-flow-provider-model-reset")
    const agentName = "FacingModelResetBot"
    const configPath = writeAgentConfig(bundlesRoot, agentName, "github-copilot", {
      humanFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
      agentFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
    })

    writeAgentProviderSelection(agentName, "human", "openai-codex", bundlesRoot)

    const updated = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>
    expect(updated.humanFacing).toEqual({ provider: "openai-codex", model: "gpt-5.4" })
    expect(updated.agentFacing).toEqual({ provider: "github-copilot", model: "claude-sonnet-4.6" })
  })
})

describe("writeAgentModel with facing (agent.json)", () => {
  it("writes model to humanFacing in agent.json for 'human' facing", () => {
    emitTestEvent("writeAgentModel human facing agent.json")
    const bundlesRoot = makeTempDir("auth-flow-model-human-facing")
    const agentName = "ModelHumanBot"
    const configPath = writeAgentConfig(bundlesRoot, agentName, "anthropic", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-sonnet-4.6" },
    })

    const result = writeAgentModel(agentName, "human", "claude-haiku-35", { bundlesRoot })
    expect(result.provider).toBe("anthropic")
    expect(result.previousModel).toBe("claude-opus-4-6")

    const updated = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>
    expect(updated.humanFacing.model).toBe("claude-haiku-35")
    // agentFacing model should be unchanged
    expect(updated.agentFacing.model).toBe("claude-sonnet-4.6")
  })

  it("writes model to agentFacing in agent.json for 'agent' facing", () => {
    emitTestEvent("writeAgentModel agent facing agent.json")
    const bundlesRoot = makeTempDir("auth-flow-model-agent-facing")
    const agentName = "ModelAgentBot"
    const configPath = writeAgentConfig(bundlesRoot, agentName, "azure", {
      humanFacing: { provider: "azure", model: "gpt-4o" },
      agentFacing: { provider: "azure", model: "gpt-4o-mini" },
    })

    const result = writeAgentModel(agentName, "agent", "gpt-5", { bundlesRoot })
    expect(result.provider).toBe("azure")
    expect(result.previousModel).toBe("gpt-4o-mini")

    const updated = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>
    expect(updated.agentFacing.model).toBe("gpt-5")
    // humanFacing model should be unchanged
    expect(updated.humanFacing.model).toBe("gpt-4o")
  })

  it("writes model changes only to agent.json", () => {
    emitTestEvent("writeAgentModel agent config only")
    const bundlesRoot = makeTempDir("auth-flow-model-config-only")
    const agentName = "NoSecretsModelBot"
    writeAgentConfig(bundlesRoot, agentName, "anthropic", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })

    writeAgentModel(agentName, "human", "claude-haiku-35", { bundlesRoot })

    const updated = JSON.parse(fs.readFileSync(path.join(bundlesRoot, `${agentName}.ouro`, "agent.json"), "utf8")) as any
    expect(updated.humanFacing.model).toBe("claude-haiku-35")
    expect(updated.agentFacing.model).toBe("claude-opus-4-6")
  })

  it("returns configPath instead of secretsPath", () => {
    emitTestEvent("writeAgentModel returns configPath")
    const bundlesRoot = makeTempDir("auth-flow-model-configpath")
    const agentName = "ConfigPathBot"
    const configPath = writeAgentConfig(bundlesRoot, agentName, "minimax", {
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
    })

    const result = writeAgentModel(agentName, "human", "minimax-text-02", { bundlesRoot })
    expect(result.configPath).toBe(configPath)
  })
})

describe("readAgentConfigForAgent v2 validation edge cases", () => {
  it("throws when humanFacing is missing from v2 config", () => {
    emitTestEvent("readAgentConfigForAgent missing humanFacing")
    const bundlesRoot = makeTempDir("auth-flow-missing-hf")
    const agentName = "NoHumanFacing"
    const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({ version: 2, enabled: true, agentFacing: { provider: "anthropic", model: "" } }) + "\n",
    )
    expect(() => readAgentConfigForAgent(agentName, bundlesRoot)).toThrow("unsupported provider")
  })

  it("throws when agentFacing is missing from v2 config", () => {
    emitTestEvent("readAgentConfigForAgent missing agentFacing")
    const bundlesRoot = makeTempDir("auth-flow-missing-af")
    const agentName = "NoAgentFacing"
    const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({ version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "" } }) + "\n",
    )
    expect(() => readAgentConfigForAgent(agentName, bundlesRoot)).toThrow("unsupported provider")
  })

  it("treats missing version field as v1 and triggers migration", () => {
    emitTestEvent("readAgentConfigForAgent no version field")
    const bundlesRoot = makeTempDir("auth-flow-no-version")
    const agentName = "NoVersionBot"
    const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({ enabled: true, provider: "anthropic" }) + "\n",
    )
    // Should trigger v1->v2 migration (version missing = treated as 1)
    const { config } = readAgentConfigForAgent(agentName, bundlesRoot)
    expect(config.humanFacing.provider).toBe("anthropic")
    expect(config.agentFacing.provider).toBe("anthropic")
  })
})
