import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../../nerves/runtime"
import {
  readAgentConfigForAgent,
  resolveHatchCredentials,
  writeProviderCredentials,
  runRuntimeAuthFlow,
  writeAgentProviderSelection,
} from "../../../heart/daemon/auth-flow"

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
    version: 1,
    enabled: true,
    provider,
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

function readSecrets(homeDir: string, agentName: string): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(path.join(homeDir, ".agentsecrets", agentName, "secrets.json"), "utf8"),
  ) as Record<string, any>
}

afterEach(() => {
  vi.restoreAllMocks()
  while (cleanup.length > 0) {
    const entry = cleanup.pop()
    if (!entry) continue
    fs.rmSync(entry, { recursive: true, force: true })
  }
})

describe("runtime auth flow", () => {
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
        provider: "anthropic",
        customField: "keep-me",
      }),
    })

    expect(writeAgentProviderSelection(agentName, "openai-codex", bundlesRoot)).toBe(configPath)

    const updated = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>
    expect(updated.provider).toBe("openai-codex")
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

  it("reuses an existing Codex token and deep-merges secrets defaults", async () => {
    emitTestEvent("reuses existing codex token")
    const homeDir = makeTempDir("auth-flow-home-codex-existing")
    const agentName = "CodexExisting"
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(
      path.join(homeDir, ".codex", "auth.json"),
      `${JSON.stringify({ tokens: { access_token: "  oauth-token-existing  " } }, null, 2)}\n`,
      "utf8",
    )
    fs.mkdirSync(path.join(homeDir, ".agentsecrets", agentName), { recursive: true })
    fs.writeFileSync(
      path.join(homeDir, ".agentsecrets", agentName, "secrets.json"),
      `${JSON.stringify({
        oauth: { githubConnectionName: "github-oauth" },
        providers: { minimax: { model: "custom-minimax" } },
      }, null, 2)}\n`,
      "utf8",
    )

    const spawnSync = vi.fn(() => ({ status: 99 })) as any
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

    expect(result.message).toBe(`authenticated ${agentName} with openai-codex`)
    expect(spawnSync).not.toHaveBeenCalled()

    const secrets = readSecrets(homeDir, agentName)
    expect(secrets.providers["openai-codex"].oauthAccessToken).toBe("oauth-token-existing")
    expect(secrets.providers.minimax.model).toBe("custom-minimax")
    expect(secrets.oauth.graphConnectionName).toBe("graph")
    expect(secrets.oauth.githubConnectionName).toBe("github-oauth")
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
    expect(readSecrets(homeDir, agentName).providers["openai-codex"].oauthAccessToken).toBe("oauth-token-after-relogin")
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
    expect(result.secretsPath).toBe(path.join(homeDir, ".agentsecrets", agentName, "secrets.json"))
    expect(readSecrets(homeDir, agentName).providers["openai-codex"].oauthAccessToken).toBe("oauth-token-from-login")
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
    expect(readSecrets(homeDir, "AnthropicBot").providers.anthropic.setupToken).toBe(setupToken)
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
    expect(readSecrets(homeDir, "MiniBot").providers.minimax.apiKey).toBe("minimax-key")
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
    const homeDir = os.homedir()
    const agentName = `DefaultHomeBot-${Date.now()}`
    cleanup.push(path.join(homeDir, ".agentsecrets", agentName))

    const result = await runRuntimeAuthFlow({
      agentName,
      provider: "minimax",
      promptInput: async () => "minimax-default-home-key",
    })

    expect(result.secretsPath).toBe(path.join(homeDir, ".agentsecrets", agentName, "secrets.json"))
    expect(readSecrets(homeDir, agentName).providers.minimax.apiKey).toBe("minimax-default-home-key")
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
    const secrets = readSecrets(homeDir, "AzureBot")
    expect(secrets.providers.azure.apiKey).toBe("azure-api-key")
    expect(secrets.providers.azure.endpoint).toBe("https://example.openai.azure.com")
    expect(secrets.providers.azure.deployment).toBe("gpt-4o-mini")
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
    ).rejects.toThrow("Azure API key, endpoint, and deployment are required.")
  })

  it("fails fast when an existing secrets file is unreadable", async () => {
    emitTestEvent("invalid secrets file")
    const homeDir = makeTempDir("auth-flow-home-bad-secrets")
    const agentName = "BadSecrets"
    fs.mkdirSync(path.join(homeDir, ".agentsecrets", agentName), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".agentsecrets", agentName, "secrets.json"), "{not-json}\n", "utf8")

    await expect(() =>
      runRuntimeAuthFlow({
        agentName,
        provider: "minimax",
        promptInput: async () => "minimax-key",
      }, {
        homeDir,
      }),
    ).rejects.toThrow("Failed to read secrets config")
  })

  it("defaults provider secret writes to os.homedir when no deps are provided", () => {
    emitTestEvent("write provider credentials default path")
    const agentName = `DirectWriteBot-${Date.now()}`
    cleanup.push(path.join(os.homedir(), ".agentsecrets", agentName))

    const result = writeProviderCredentials(agentName, "minimax", { apiKey: "direct-minimax-key" })

    expect(result.secretsPath).toBe(path.join(os.homedir(), ".agentsecrets", agentName, "secrets.json"))
    expect(readSecrets(os.homedir(), agentName).providers.minimax.apiKey).toBe("direct-minimax-key")
  })

  it("uses shared runtime auth to resolve missing anthropic hatch credentials", async () => {
    emitTestEvent("shared anthropic hatch credentials")
    const promptInput = vi.fn(async () => "unexpected")
    const runAuthFlow = vi.fn(async () => ({
      agentName: "SharedAnthropic",
      provider: "anthropic",
      message: "authenticated SharedAnthropic with anthropic",
      secretsPath: "/tmp/shared-anthropic.json",
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
